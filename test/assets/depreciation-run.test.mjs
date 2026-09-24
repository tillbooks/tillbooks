// H04, Depreciation Run & Posting: the MONEY-PATH invariants a NON-AUTHOR critic mutation-tests, plus
// the reverse path, the stale-draft / empty-run guards, and the declining-balance column-posting that
// closes the H03 parameter gap. This is the period-end process that turns H03's calculated amounts into
// a balanced A02 journal + append-only asset_transaction rows, so the SIX load-bearing assertions BITE:
//
//   (a) IDEMPOTENT ON ROWS (§H-IDEMPOTENT). Re-running depreciation for the same asset+period posts
//       EXACTLY ONE journal entry and writes EXACTLY ONE asset_transaction, never double. Proven by ROW
//       COUNTS, both under a replayed key and under the status-idempotent re-post.
//   (b) APPEND-ONLY (§H-AUDIT). The posted journal entry is immutable (A02) and the asset_transaction
//       depreciation row is immutable (its own triggers). The run line is immutable too, and the run
//       header refuses any amount edit or illegal status change.
//   (c) BALANCED ENTRY (§H-LEDGER). Debit total == credit total == the run total, on the accounts the
//       lines named (Dr expense / Cr accumulated depreciation).
//   (d) PERIOD LOCK (§H-PERIOD). Create and post into a hard-locked period are refused and write
//       NOTHING: no run, no journal, no transaction, the asset untouched.
//   (e) NEVER BELOW RESIDUAL (§H-ASSET). Over the full life the posted amounts sum to exactly
//       (cost - residual), the final period lands NBV on residual, and no line ever undershoots it.
//   (f) §H-TENANT. A foreign workspace can neither read nor post nor reverse a run it does not own, and
//       a foreign assetId never resolves.

import test from 'node:test';
import assert from 'node:assert/strict';

import { callTool } from '../../dist/api/mcp.js';
import { handleRest } from '../../dist/api/rest.js';
import { getAction } from '../../dist/api/registry.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';
import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { makeContext } from '../../dist/core/context.js';
import { fixedClock } from '../../dist/core/clock.js';
import { sequenceIdGen } from '../../dist/core/ids.js';
import { createWorkspace } from '../../dist/core/setup/index.js';
import { createCostCenter } from '../../dist/core/accounts/index.js';
import { lockPeriod, ledgerPorts } from '../../dist/core/ledger/index.js';
import {
  createAssetCategory,
  createAsset,
  getAsset,
  assetAcquire,
  assetAddCapitalisation,
  assetDepreciationRunCreate,
  assetDepreciationRunPost,
  assetDepreciationRunReverse,
  assetDepreciationRunGet,
  assetDepreciationRunList,
} from '../../dist/core/assets/index.js';

const AT = '2026-08-07T00:00:00.000Z';

function setup() {
  const clock = fixedClock(AT);
  const ids = sequenceIdGen();
  const store = new SqliteStore({ clock });
  const deps = { store, clock, ids };
  const workspaceId = createWorkspace(deps, { name: 'Acme AG' }).workspaceId;
  // The REAL PeriodPort + AuditPort so §H-PERIOD actually bites (the permissive default would let a
  // locked-period run post).
  const ctx = makeContext(store, { workspaceId, actor: 'user_1', clock, ids, ...ledgerPorts({ store, workspaceId, ids }) });
  const acc = (number) =>
    store.db.prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?').get(workspaceId, number).id;

  const category = (over = {}) => {
    const r = createAssetCategory(ctx, {
      code: `MACH-${Math.random().toString(36).slice(2, 8)}`,
      name: 'Maschinen & Anlagen',
      depreciationMethod: 'straight_line',
      usefulLifeMonths: 12,
      glAssetAccountId: acc('1500'),
      glAccumDeprAccountId: acc('1510'),
      glDeprExpenseAccountId: acc('6800'),
      idempotencyKey: `cat-${Math.random()}`,
      ...over,
    });
    assert.equal(r.ok, true, `category setup failed: ${JSON.stringify(r)}`);
    return r.category;
  };

  // An ACTIVE asset (created + acquired), ready to depreciate. Cost CHF 12'000.00 over 12 months, 0%
  // residual => CHF 1'000.00 a month, unless overridden.
  const activeAsset = (assetOver = {}, catOver = {}) => {
    const cat = category(catOver);
    const created = createAsset(ctx, {
      categoryId: cat.id,
      name: 'CNC Fräsmaschine',
      acquisitionDate: '2026-01-10',
      acquisitionCostRappen: 1_200_000,
      idempotencyKey: `as-${Math.random()}`,
      ...assetOver,
    });
    assert.equal(created.ok, true, `asset setup failed: ${JSON.stringify(created)}`);
    const acq = assetAcquire(ctx, {
      assetId: created.asset.id,
      // The acquire date wins on the row, so it must follow the asset's own acquisition date.
      date: assetOver.acquisitionDate ?? '2026-01-10',
      acquisitionCostRappen: created.asset.acquisitionCostRappen,
      creditAccountId: acc('1020'),
      idempotencyKey: `acq-${Math.random()}`,
    });
    assert.equal(acq.ok, true, `acquire setup failed: ${JSON.stringify(acq)}`);
    return created.asset.id;
  };

  return { ctx, store, workspaceId, deps, acc, category, activeAsset };
}

const deprEntryCount = (store, ws) =>
  store.db
    .prepare("SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ? AND source = 'asset_depreciation' AND status = 'posted'")
    .get(ws).n;
const deprTxnCount = (store, ws) =>
  store.db.prepare("SELECT COUNT(*) AS n FROM asset_transaction WHERE workspace_id = ? AND type = 'depreciation'").get(ws).n;

// --- (c) BALANCED ENTRY + happy path ------------------------------------------------------------

test('create then post books a balanced Dr expense / Cr accum entry and advances the asset', () => {
  const { ctx, store, workspaceId, acc, activeAsset } = setup();
  const assetId = activeAsset();

  const draft = assetDepreciationRunCreate(ctx, { period: '2026-02', idempotencyKey: 'd1' });
  assert.equal(draft.ok, true, JSON.stringify(draft));
  assert.equal(draft.run.status, 'draft');
  assert.equal(draft.run.assetCount, 1);
  assert.equal(draft.run.totalAmountRappen, 100_000);
  assert.equal(draft.lines.length, 1);
  assert.equal(draft.lines[0].amountRappen, 100_000);
  assert.equal(draft.lines[0].accumulatedBeforeRappen, 0);
  assert.equal(draft.lines[0].accumulatedAfterRappen, 100_000);
  // A line identifies its asset the way the register does, so a review table never shows `asset_1`.
  assert.equal(draft.lines[0].assetId, assetId);
  assert.ok(
    typeof draft.lines[0].assetNumber === 'string' && /^FA-\d+$/.test(draft.lines[0].assetNumber),
    `the line carries the asset number: ${JSON.stringify(draft.lines[0])}`,
  );

  const posted = assetDepreciationRunPost(ctx, { runId: draft.run.id, idempotencyKey: 'p1' });
  assert.equal(posted.ok, true, JSON.stringify(posted));
  assert.equal(posted.run.status, 'posted');

  // (c) balanced: debit == credit == the run total, on the intended accounts.
  const lines = store.db
    .prepare('SELECT account_id, debit_minor, credit_minor FROM journal_line WHERE entry_id = ?')
    .all(posted.journalEntryId);
  const debit = lines.reduce((s, l) => s + l.debit_minor, 0);
  const credit = lines.reduce((s, l) => s + l.credit_minor, 0);
  assert.equal(debit, credit, 'debits equal credits');
  assert.equal(debit, 100_000, 'entry total is the depreciation amount');
  const dr = lines.find((l) => l.account_id === acc('6800'));
  const cr = lines.find((l) => l.account_id === acc('1510'));
  assert.equal(dr.debit_minor, 100_000, 'the expense account is debited');
  assert.equal(cr.credit_minor, 100_000, 'the accumulated-depreciation account is credited');

  // The asset advanced: accumulated up, NBV down, last period stamped.
  const asset = getAsset(ctx, { assetId }).asset;
  assert.equal(asset.accumulatedDeprRappen, 100_000);
  assert.equal(asset.netBookValueRappen, 1_100_000);
  assert.equal(asset.lastDepreciationPeriod, '2026-02');
  assert.equal(asset.status, 'active');
});

// --- (a) IDEMPOTENT ON ROWS ---------------------------------------------------------------------

test('IDEMPOTENT: create twice on one key yields ONE draft; post twice on one key posts ONE entry + ONE txn', () => {
  const { ctx, store, workspaceId, activeAsset } = setup();
  activeAsset();

  const c1 = assetDepreciationRunCreate(ctx, { period: '2026-02', idempotencyKey: 'same' });
  const c2 = assetDepreciationRunCreate(ctx, { period: '2026-02', idempotencyKey: 'same' });
  assert.equal(c1.ok, true);
  assert.equal(c2.ok, true);
  assert.equal(c2.run.id, c1.run.id, 'a replayed create returns the SAME draft');
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM asset_depreciation_run WHERE workspace_id = ?').get(workspaceId).n, 1);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM asset_depreciation_line WHERE workspace_id = ?').get(workspaceId).n, 1);

  const p1 = assetDepreciationRunPost(ctx, { runId: c1.run.id, idempotencyKey: 'pk' });
  const p2 = assetDepreciationRunPost(ctx, { runId: c1.run.id, idempotencyKey: 'pk' });
  assert.equal(p1.ok, true);
  assert.equal(p2.ok, true);
  assert.equal(JSON.stringify(p2), JSON.stringify(p1), 'a replayed post returns the identical result');
  assert.equal(deprEntryCount(store, workspaceId), 1, 'exactly ONE depreciation journal entry');
  assert.equal(deprTxnCount(store, workspaceId), 1, 'exactly ONE depreciation asset_transaction');
});

test('IDEMPOTENT ON STATUS: re-posting the same run under a NEW key posts no second entry', () => {
  const { ctx, store, workspaceId, activeAsset } = setup();
  activeAsset();
  const draft = assetDepreciationRunCreate(ctx, { period: '2026-02', idempotencyKey: 'd' });
  const first = assetDepreciationRunPost(ctx, { runId: draft.run.id, idempotencyKey: 'k1' });
  const again = assetDepreciationRunPost(ctx, { runId: draft.run.id, idempotencyKey: 'k2-different' });
  assert.equal(again.ok, true, 'an already-posted run returns its posted result, never double-counts');
  assert.equal(again.journalEntryId, first.journalEntryId, 'same journal entry, no second post');
  assert.equal(deprEntryCount(store, workspaceId), 1);
  assert.equal(deprTxnCount(store, workspaceId), 1);
});

test('the same (period, selection) cannot spawn a second live run', () => {
  const { ctx, activeAsset } = setup();
  activeAsset();
  const a = assetDepreciationRunCreate(ctx, { period: '2026-02', idempotencyKey: 'a' });
  assert.equal(a.ok, true);
  const b = assetDepreciationRunCreate(ctx, { period: '2026-02', idempotencyKey: 'b-different-key' });
  assert.equal(b.ok, false);
  assert.equal(b.error, 'run_already_exists');
});

// --- (b) APPEND-ONLY --------------------------------------------------------------------------

test('APPEND-ONLY: the posted journal, the asset_transaction, the run line and run header resist mutation', () => {
  const { ctx, store, workspaceId, activeAsset } = setup();
  activeAsset();
  const draft = assetDepreciationRunCreate(ctx, { period: '2026-02', idempotencyKey: 'd' });
  const posted = assetDepreciationRunPost(ctx, { runId: draft.run.id, idempotencyKey: 'p' });
  assert.equal(posted.ok, true);

  const txnId = store.db.prepare("SELECT id FROM asset_transaction WHERE workspace_id = ? AND type = 'depreciation'").get(workspaceId).id;
  assert.throws(
    () => store.db.prepare('UPDATE asset_transaction SET delta_accum_depr_rappen = 1 WHERE id = ?').run(txnId),
    /asset_transaction_immutable/,
  );
  assert.throws(() => store.db.prepare('DELETE FROM asset_transaction WHERE id = ?').run(txnId), /asset_transaction_immutable/);

  // The posted journal entry is immutable too (A02's own triggers).
  assert.throws(() => store.db.prepare('DELETE FROM journal_entry WHERE id = ?').run(posted.journalEntryId), /immutable|abort|ABORT/i);

  // The run line is append-only.
  const lineId = store.db.prepare('SELECT id FROM asset_depreciation_line WHERE workspace_id = ?').get(workspaceId).id;
  assert.throws(
    () => store.db.prepare('UPDATE asset_depreciation_line SET amount_rappen = 1 WHERE id = ?').run(lineId),
    /asset_depreciation_line_immutable/,
  );
  assert.throws(() => store.db.prepare('DELETE FROM asset_depreciation_line WHERE id = ?').run(lineId), /asset_depreciation_line_immutable/);

  // The run header refuses an amount edit and any delete; a status-only advance is the only mutation.
  assert.throws(
    () => store.db.prepare('UPDATE asset_depreciation_run SET total_amount_rappen = 1 WHERE id = ?').run(draft.run.id),
    /asset_depreciation_run_immutable/,
  );
  assert.throws(() => store.db.prepare('DELETE FROM asset_depreciation_run WHERE id = ?').run(draft.run.id), /asset_depreciation_run_immutable/);
});

// --- (d) PERIOD LOCK --------------------------------------------------------------------------

test('PERIOD LOCK: create into a hard-locked period is refused and writes no run', () => {
  const { ctx, store, workspaceId, activeAsset } = setup();
  activeAsset();
  assert.equal(lockPeriod(ctx, { period: '2026-02', kind: 'hard', reason: 'vat_filed', idempotencyKey: 'lk' }).ok, true);
  const r = assetDepreciationRunCreate(ctx, { period: '2026-02', idempotencyKey: 'd' });
  assert.equal(r.error, 'period_locked');
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM asset_depreciation_run WHERE workspace_id = ?').get(workspaceId).n, 0);
});

test('PERIOD LOCK: posting a draft into a period that locks afterwards is refused and writes nothing', () => {
  const { ctx, store, workspaceId, activeAsset } = setup();
  const assetId = activeAsset();
  const draft = assetDepreciationRunCreate(ctx, { period: '2026-02', idempotencyKey: 'd' });
  assert.equal(draft.ok, true);
  assert.equal(lockPeriod(ctx, { period: '2026-02', kind: 'hard', reason: 'vat_filed', idempotencyKey: 'lk' }).ok, true);
  const r = assetDepreciationRunPost(ctx, { runId: draft.run.id, idempotencyKey: 'p' });
  assert.equal(r.error, 'period_locked');
  // Nothing half-done: no journal, no transaction, run still draft, asset untouched.
  assert.equal(deprEntryCount(store, workspaceId), 0);
  assert.equal(deprTxnCount(store, workspaceId), 0);
  assert.equal(assetDepreciationRunGet(ctx, { runId: draft.run.id }).run.status, 'draft');
  assert.equal(getAsset(ctx, { assetId }).asset.accumulatedDeprRappen, 0);
});

test('PERIOD LOCK: a sealed year cannot be back-charged by moving the posting date into an open one', () => {
  const { ctx, store, workspaceId, activeAsset } = setup();
  const assetId = activeAsset();
  const draft = assetDepreciationRunCreate(ctx, { period: '2026-02', idempotencyKey: 'd' });
  assert.equal(draft.ok, true, JSON.stringify(draft));

  // The financial year 2026 is closed and sealed. February 2026 is now legally frozen.
  assert.equal(lockPeriod(ctx, { period: '2026', kind: 'hard', reason: 'year_close', idempotencyKey: 'lk' }).ok, true);

  // Posting the SAME run with a posting date in the still-open 2027 must NOT slip a February 2026
  // charge past the seal: the run's OWN period is what the sub-ledger and the register record.
  const r = assetDepreciationRunPost(ctx, { runId: draft.run.id, postingDate: '2027-01-31', idempotencyKey: 'p' });
  assert.equal(r.ok, false, `a sealed year must refuse the charge: ${JSON.stringify(r)}`);
  assert.equal(r.error, 'period_locked');

  // Nothing half-done, and the sub-ledger did not gain a charge for the sealed year.
  assert.equal(deprEntryCount(store, workspaceId), 0, 'no journal');
  assert.equal(deprTxnCount(store, workspaceId), 0, 'no sub-ledger movement');
  assert.equal(assetDepreciationRunGet(ctx, { runId: draft.run.id }).run.status, 'draft');
  const asset = getAsset(ctx, { assetId }).asset;
  assert.equal(asset.accumulatedDeprRappen, 0);
  assert.equal(asset.lastDepreciationPeriod, null, 'the sealed year is not stamped on the asset');
});

// --- Chronology: a run's dates cannot predate what they book --------------------------------------

test('a posting date before the run period is refused, so the register stays chronological', () => {
  const { ctx, store, workspaceId, activeAsset } = setup();
  const assetId = activeAsset();
  const draft = assetDepreciationRunCreate(ctx, { period: '2026-02', idempotencyKey: 'd' });
  assert.equal(draft.ok, true);

  const early = assetDepreciationRunPost(ctx, { runId: draft.run.id, postingDate: '2019-01-01', idempotencyKey: 'p' });
  assert.equal(early.ok, false, `a 2019 posting date for a 2026-02 run must be refused: ${JSON.stringify(early)}`);
  assert.equal(early.error, 'invalid_input');
  assert.equal(early.field, 'postingDate');
  assert.equal(deprEntryCount(store, workspaceId), 0, 'nothing posted');
  assert.equal(deprTxnCount(store, workspaceId), 0);
  assert.equal(getAsset(ctx, { assetId }).asset.accumulatedDeprRappen, 0);

  // A date AFTER the acquisition but BEFORE the period is refused too: the period floor is what bites
  // here, not the acquisition floor. February's charge cannot be booked in January.
  const priorMonth = assetDepreciationRunPost(ctx, { runId: draft.run.id, postingDate: '2026-01-15', idempotencyKey: 'p1b' });
  assert.equal(priorMonth.ok, false, `a January posting date for a February run must be refused: ${JSON.stringify(priorMonth)}`);
  assert.equal(priorMonth.error, 'invalid_input');
  assert.equal(priorMonth.field, 'postingDate');
  assert.equal(deprEntryCount(store, workspaceId), 0);

  // The first day of the run's own period is still legal (the floor, not a narrowing).
  const first = assetDepreciationRunPost(ctx, { runId: draft.run.id, postingDate: '2026-02-01', idempotencyKey: 'p2' });
  assert.equal(first.ok, true, JSON.stringify(first));
});

test('a posting date before the asset acquisition is refused', () => {
  const { ctx, store, workspaceId, activeAsset } = setup();
  // Acquired mid-period: a posting date earlier in the same month would book the charge before the
  // asset existed on the books.
  activeAsset({ acquisitionDate: '2026-02-20' });
  const draft = assetDepreciationRunCreate(ctx, { period: '2026-02', idempotencyKey: 'd' });
  assert.equal(draft.ok, true, JSON.stringify(draft));
  assert.equal(draft.lines.length, 1);

  const early = assetDepreciationRunPost(ctx, { runId: draft.run.id, postingDate: '2026-02-05', idempotencyKey: 'p' });
  assert.equal(early.ok, false, `a charge cannot predate the acquisition: ${JSON.stringify(early)}`);
  assert.equal(early.error, 'invalid_input');
  assert.equal(early.field, 'postingDate');
  assert.equal(deprEntryCount(store, workspaceId), 0);
  assert.equal(deprTxnCount(store, workspaceId), 0);

  // The default posting date (the last day of the period) is after the acquisition and posts fine.
  assert.equal(assetDepreciationRunPost(ctx, { runId: draft.run.id, idempotencyKey: 'p2' }).ok, true);
});

test('a reverse date before the run period is refused', () => {
  const { ctx, store, workspaceId, activeAsset } = setup();
  activeAsset();
  const draft = assetDepreciationRunCreate(ctx, { period: '2026-02', idempotencyKey: 'd' });
  assert.equal(assetDepreciationRunPost(ctx, { runId: draft.run.id, idempotencyKey: 'p' }).ok, true);

  const early = assetDepreciationRunReverse(ctx, { runId: draft.run.id, reverseDate: '2025-12-31', idempotencyKey: 'r' });
  assert.equal(early.ok, false, `a reversal cannot predate the run it reverses: ${JSON.stringify(early)}`);
  assert.equal(early.error, 'invalid_input');
  assert.equal(early.field, 'reverseDate');
  assert.equal(
    store.db.prepare("SELECT COUNT(*) AS n FROM asset_transaction WHERE workspace_id = ? AND type = 'depreciation_reversal'").get(workspaceId).n,
    0,
    'no compensating movement was written',
  );
  assert.equal(assetDepreciationRunGet(ctx, { runId: draft.run.id }).run.status, 'posted');
});

// --- (e) NEVER BELOW RESIDUAL, across the full life --------------------------------------------

test('NEVER BELOW RESIDUAL: over the full life the amounts sum to (cost - residual) and land exactly on residual', () => {
  const { ctx, activeAsset } = setup();
  // CHF 12'000.00 cost, CHF 2'000.00 residual, 12 months. Depreciable = CHF 10'000.00.
  const assetId = activeAsset({ residualValueRappen: 200_000 });
  const residual = 200_000;
  const cost = 1_200_000;

  let totalPosted = 0;
  let period = '2026-02';
  const nextPeriod = (p) => {
    const y = Number(p.slice(0, 4));
    const m = Number(p.slice(5, 7));
    return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  };
  for (let i = 0; i < 24; i += 1) {
    const draft = assetDepreciationRunCreate(ctx, { period, idempotencyKey: `d-${period}` });
    assert.equal(draft.ok, true, JSON.stringify(draft));
    if (draft.empty === true || draft.lines.length === 0) break; // fully depreciated, nothing left
    // No line ever drives NBV below residual.
    for (const line of draft.lines) assert.ok(line.nbvAfterRappen >= residual, `line NBV ${line.nbvAfterRappen} >= residual`);
    const posted = assetDepreciationRunPost(ctx, { runId: draft.run.id, idempotencyKey: `p-${period}` });
    assert.equal(posted.ok, true, JSON.stringify(posted));
    totalPosted += draft.run.totalAmountRappen;
    period = nextPeriod(period);
  }

  const asset = getAsset(ctx, { assetId }).asset;
  assert.equal(asset.accumulatedDeprRappen, cost - residual, 'accumulated == depreciable base');
  assert.equal(asset.netBookValueRappen, residual, 'final NBV lands exactly on residual');
  assert.equal(totalPosted, cost - residual, 'the posted amounts sum to exactly (cost - residual)');
  assert.equal(asset.status, 'fully_depreciated', 'the asset is fully depreciated');

  // A fully-depreciated asset is excluded from a subsequent run: a run for a later period is empty.
  const after = assetDepreciationRunCreate(ctx, { period: '2028-12', idempotencyKey: 'after' });
  assert.equal(after.ok, true, JSON.stringify(after));
  assert.equal(after.empty, true);
});

// --- (f) §H-TENANT ----------------------------------------------------------------------------

test('§H-TENANT: a foreign workspace cannot read, post or reverse a run, and a foreign assetId never resolves', () => {
  const { ctx, deps, activeAsset } = setup();
  activeAsset();
  const mine = assetDepreciationRunCreate(ctx, { period: '2026-02', idempotencyKey: 'd' });
  assert.equal(mine.ok, true);

  const otherWs = createWorkspace(deps, { name: 'Other AG' }).workspaceId;
  const other = makeContext(deps.store, {
    workspaceId: otherWs,
    actor: 'u',
    clock: deps.clock,
    ids: deps.ids,
    ...ledgerPorts({ store: deps.store, workspaceId: otherWs, ids: deps.ids }),
  });
  assert.equal(assetDepreciationRunGet(other, { runId: mine.run.id }).error, 'not_found');
  assert.equal(assetDepreciationRunList(other).runs.length, 0);
  assert.equal(assetDepreciationRunPost(other, { runId: mine.run.id, idempotencyKey: 'x' }).error, 'not_found');
  assert.equal(assetDepreciationRunReverse(other, { runId: mine.run.id, idempotencyKey: 'x' }).error, 'not_found');
  // A foreign assetId in a create filter is not_found, never a cross-tenant calculation.
  assert.equal(assetDepreciationRunCreate(other, { period: '2026-02', assetIds: ['as_foreign'], idempotencyKey: 'y' }).error, 'not_found');
});

test('§H-TENANT: a run in workspace B can neither name nor sweep nor touch a REAL asset of workspace A', () => {
  const { ctx, store, workspaceId, deps, activeAsset } = setup();
  // Workspace A: one real, acquired, depreciable asset.
  const assetA = activeAsset();

  // Workspace B: its OWN chart, category and acquired asset, in the SAME store. Both tenants now hold
  // real rows, so the tenant filter is the ONLY thing keeping B's run off A's register.
  const wsB = createWorkspace(deps, { name: 'Beta AG' }).workspaceId;
  const ctxB = makeContext(deps.store, {
    workspaceId: wsB,
    actor: 'user_b',
    clock: deps.clock,
    ids: deps.ids,
    ...ledgerPorts({ store: deps.store, workspaceId: wsB, ids: deps.ids }),
  });
  const accB = (number) => store.db.prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?').get(wsB, number).id;
  const catB = createAssetCategory(ctxB, {
    code: 'MACH-B',
    name: 'Maschinen B',
    depreciationMethod: 'straight_line',
    usefulLifeMonths: 12,
    glAssetAccountId: accB('1500'),
    glAccumDeprAccountId: accB('1510'),
    glDeprExpenseAccountId: accB('6800'),
    idempotencyKey: 'cat-b',
  });
  assert.equal(catB.ok, true, JSON.stringify(catB));
  const createdB = createAsset(ctxB, {
    categoryId: catB.category.id,
    name: 'Presse B',
    acquisitionDate: '2026-01-10',
    acquisitionCostRappen: 600_000, // CHF 6'000.00 over 12 months => CHF 500.00 a month
    idempotencyKey: 'as-b',
  });
  assert.equal(createdB.ok, true, JSON.stringify(createdB));
  const assetB = createdB.asset.id;
  assert.equal(
    assetAcquire(ctxB, {
      assetId: assetB,
      date: '2026-01-10',
      acquisitionCostRappen: 600_000,
      creditAccountId: accB('1020'),
      idempotencyKey: 'acq-b',
    }).ok,
    true,
  );

  // (a) B naming a REAL asset of A: not_found, never a cross-tenant calculation.
  const named = assetDepreciationRunCreate(ctxB, { period: '2026-02', assetIds: [assetA], idempotencyKey: 'b-named' });
  assert.equal(named.ok, false, `B must not resolve A's asset: ${JSON.stringify(named)}`);
  assert.equal(named.error, 'not_found');

  // (b) B's UNFILTERED sweep sees exactly its own register: one line, B's asset, B's amount.
  const sweep = assetDepreciationRunCreate(ctxB, { period: '2026-02', idempotencyKey: 'b-sweep' });
  assert.equal(sweep.ok, true, JSON.stringify(sweep));
  assert.equal(sweep.lines.length, 1, 'B sweeps ONLY its own assets');
  assert.equal(sweep.lines[0].assetId, assetB, 'the only line names B, never A');
  assert.equal(sweep.run.assetCount, 1);
  assert.equal(sweep.run.totalAmountRappen, 50_000, "B's own amount, not A's");

  // (c) After B posts, A's books are byte-identical: no journal, no sub-ledger row, no mutated asset.
  const aEntriesBefore = store.db.prepare('SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ?').get(workspaceId).n;
  const aTxnBefore = store.db.prepare('SELECT COUNT(*) AS n FROM asset_transaction WHERE workspace_id = ?').get(workspaceId).n;
  const aRowBefore = JSON.stringify(store.db.prepare('SELECT * FROM asset WHERE workspace_id = ? AND id = ?').get(workspaceId, assetA));

  const postedB = assetDepreciationRunPost(ctxB, { runId: sweep.run.id, idempotencyKey: 'b-post' });
  assert.equal(postedB.ok, true, JSON.stringify(postedB));

  assert.equal(
    store.db.prepare('SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ?').get(workspaceId).n,
    aEntriesBefore,
    "B's post wrote no journal entry into A",
  );
  assert.equal(
    store.db.prepare('SELECT COUNT(*) AS n FROM asset_transaction WHERE workspace_id = ?').get(workspaceId).n,
    aTxnBefore,
    "B's post wrote no sub-ledger row into A",
  );
  assert.equal(
    JSON.stringify(store.db.prepare('SELECT * FROM asset WHERE workspace_id = ? AND id = ?').get(workspaceId, assetA)),
    aRowBefore,
    "A's asset row is byte-identical after B posted",
  );
  // Across the WHOLE store, not just A's workspace: no sub-ledger row anywhere names A's asset because
  // of B's run. This bites on a leak that wrote A's movement under B's workspace_id.
  assert.equal(
    store.db.prepare('SELECT COUNT(*) AS n FROM asset_transaction WHERE asset_id = ?').get(assetA).n,
    store.db.prepare('SELECT COUNT(*) AS n FROM asset_transaction WHERE workspace_id = ? AND asset_id = ?').get(workspaceId, assetA).n,
    "every sub-ledger row naming A's asset belongs to A",
  );
  // And B really did move its own books.
  assert.equal(getAsset(ctxB, { assetId: assetB }).asset.accumulatedDeprRappen, 50_000);
});

// --- Reverse ----------------------------------------------------------------------------------

test('reverse restores every asset to its exact pre-run values without rewriting history', () => {
  const { ctx, store, workspaceId, activeAsset } = setup();
  const assetId = activeAsset();
  const before = getAsset(ctx, { assetId }).asset;

  const draft = assetDepreciationRunCreate(ctx, { period: '2026-02', idempotencyKey: 'd' });
  const posted = assetDepreciationRunPost(ctx, { runId: draft.run.id, idempotencyKey: 'p' });
  assert.equal(posted.ok, true);

  const rev = assetDepreciationRunReverse(ctx, { runId: draft.run.id, reason: 'wrong rate', idempotencyKey: 'r' });
  assert.equal(rev.ok, true, JSON.stringify(rev));
  assert.equal(rev.run.status, 'reversed');
  assert.ok(typeof rev.reversingJournalEntryId === 'string' && rev.reversingJournalEntryId.length > 0);

  // The asset is restored to exactly its pre-run figures.
  const after = getAsset(ctx, { assetId }).asset;
  assert.equal(after.accumulatedDeprRappen, before.accumulatedDeprRappen);
  assert.equal(after.netBookValueRappen, before.netBookValueRappen);
  assert.equal(after.lastDepreciationPeriod, before.lastDepreciationPeriod);
  assert.equal(after.status, before.status);

  // History is NOT rewritten: the original posted entry survives, a reversing entry exists, and a
  // compensating depreciation_reversal transaction was written.
  assert.equal(deprEntryCount(store, workspaceId), 1, 'the original depreciation entry still stands');
  const reversing = store.db.prepare('SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ? AND reverses_entry_id = ?').get(workspaceId, posted.journalEntryId).n;
  assert.equal(reversing, 1, 'exactly one reversing entry');
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM asset_transaction WHERE workspace_id = ? AND type = 'depreciation_reversal'").get(workspaceId).n, 1);

  // A reversed run cannot be reversed again or posted.
  assert.equal(assetDepreciationRunReverse(ctx, { runId: draft.run.id, idempotencyKey: 'r2' }).error, 'already_reversed');
  assert.equal(assetDepreciationRunPost(ctx, { runId: draft.run.id, idempotencyKey: 'p2' }).error, 'run_reversed');
});

test('the reversal reason is recorded on the reversing entry and on the compensating movement', () => {
  const { ctx, store, workspaceId, activeAsset } = setup();
  activeAsset();
  const draft = assetDepreciationRunCreate(ctx, { period: '2026-02', idempotencyKey: 'd' });
  assert.equal(assetDepreciationRunPost(ctx, { runId: draft.run.id, idempotencyKey: 'p' }).ok, true);

  const reason = 'Nutzungsdauer falsch erfasst';
  const rev = assetDepreciationRunReverse(ctx, { runId: draft.run.id, reason, idempotencyKey: 'r' });
  assert.equal(rev.ok, true, JSON.stringify(rev));

  // The audit answer to "why was this reversed" survives on the reversing journal entry.
  const entry = store.db.prepare('SELECT description FROM journal_entry WHERE id = ?').get(rev.reversingJournalEntryId);
  assert.equal(entry.description, `Storno Abschreibung 2026-02: ${reason}`);

  // And on the compensating sub-ledger movement, so the register carries it too.
  const txn = store.db
    .prepare("SELECT description FROM asset_transaction WHERE workspace_id = ? AND type = 'depreciation_reversal'")
    .get(workspaceId);
  assert.equal(txn.description, `Storno Abschreibung 2026-02: ${reason}`);
});

test('a reversal without a reason keeps the plain description', () => {
  const { ctx, store, workspaceId, activeAsset } = setup();
  activeAsset();
  const draft = assetDepreciationRunCreate(ctx, { period: '2026-02', idempotencyKey: 'd' });
  assert.equal(assetDepreciationRunPost(ctx, { runId: draft.run.id, idempotencyKey: 'p' }).ok, true);
  const rev = assetDepreciationRunReverse(ctx, { runId: draft.run.id, reason: '   ', idempotencyKey: 'r' });
  assert.equal(rev.ok, true, JSON.stringify(rev));
  assert.equal(
    store.db.prepare('SELECT description FROM journal_entry WHERE id = ?').get(rev.reversingJournalEntryId).description,
    'Storno Abschreibung 2026-02',
    'a blank reason adds nothing',
  );
  assert.equal(
    store.db.prepare("SELECT description FROM asset_transaction WHERE workspace_id = ? AND type = 'depreciation_reversal'").get(workspaceId)
      .description,
    'Storno Abschreibung 2026-02',
  );
});

test('reversing an EARLIER run once a later one posted is refused: reverse forward, never out of order', () => {
  const { ctx, store, workspaceId, activeAsset } = setup();
  const assetId = activeAsset();

  const feb = assetDepreciationRunCreate(ctx, { period: '2026-02', idempotencyKey: 'd-feb' });
  assert.equal(assetDepreciationRunPost(ctx, { runId: feb.run.id, idempotencyKey: 'p-feb' }).ok, true);
  const mar = assetDepreciationRunCreate(ctx, { period: '2026-03', idempotencyKey: 'd-mar' });
  assert.equal(assetDepreciationRunPost(ctx, { runId: mar.run.id, idempotencyKey: 'p-mar' }).ok, true);

  // February out of order would look correct arithmetically and then be unrecoverable: the asset's
  // last_depreciation_period rightly stays 2026-03, so a re-created February run is empty forever and
  // the month is silently lost. Refuse it instead, and name the run that blocks.
  const rev = assetDepreciationRunReverse(ctx, { runId: feb.run.id, idempotencyKey: 'r' });
  assert.equal(rev.ok, false, `February cannot be reversed under March: ${JSON.stringify(rev)}`);
  assert.equal(rev.error, 'later_run_exists');
  assert.equal(rev.blockingPeriod, '2026-03', 'the blocking period is named so the operator knows what to reverse first');
  assert.equal(rev.assetId, assetId);

  // Nothing was written: no reversing entry, no compensating movement, both runs still posted.
  assert.equal(
    store.db.prepare("SELECT COUNT(*) AS n FROM asset_transaction WHERE workspace_id = ? AND type = 'depreciation_reversal'").get(workspaceId).n,
    0,
  );
  assert.equal(assetDepreciationRunGet(ctx, { runId: feb.run.id }).run.status, 'posted');
  assert.equal(getAsset(ctx, { assetId }).asset.accumulatedDeprRappen, 200_000);

  // Reversing FORWARD works, and then February is reversible and re-creatable, exactly as US-H04.5 says.
  assert.equal(assetDepreciationRunReverse(ctx, { runId: mar.run.id, idempotencyKey: 'r-mar' }).ok, true);
  assert.equal(assetDepreciationRunReverse(ctx, { runId: feb.run.id, idempotencyKey: 'r-feb' }).ok, true);
  assert.equal(getAsset(ctx, { assetId }).asset.accumulatedDeprRappen, 0);
  assert.equal(getAsset(ctx, { assetId }).asset.lastDepreciationPeriod, null);
  const again = assetDepreciationRunCreate(ctx, { period: '2026-02', idempotencyKey: 'd-feb2' });
  assert.equal(again.ok, true, JSON.stringify(again));
  assert.equal(again.empty, false, 'February is recoverable after reversing forward');
  assert.equal(again.lines.length, 1);
  assert.equal(again.lines[0].amountRappen, 100_000);
});

// --- Guards: stale_draft, empty_run, and reads ------------------------------------------------

test('a draft whose asset moved since calculation is refused with stale_draft and writes nothing', () => {
  const { ctx, store, workspaceId, activeAsset } = setup();
  const assetId = activeAsset();
  const draft = assetDepreciationRunCreate(ctx, { period: '2026-02', idempotencyKey: 'd' });
  assert.equal(draft.ok, true);
  // Simulate the asset's accumulated depreciation moving after the draft was calculated (a concurrent
  // run, a correction): the draft no longer describes reality.
  store.db.prepare('UPDATE asset SET accumulated_depr_rappen = 50000 WHERE workspace_id = ? AND id = ?').run(workspaceId, assetId);
  const r = assetDepreciationRunPost(ctx, { runId: draft.run.id, idempotencyKey: 'p' });
  assert.equal(r.error, 'stale_draft');
  assert.equal(deprEntryCount(store, workspaceId), 0, 'nothing posted');
  assert.equal(deprTxnCount(store, workspaceId), 0);
});

test('BATCH ATOMICITY: one stale asset in a multi-asset run posts NOTHING for any of them', () => {
  const { ctx, store, workspaceId, activeAsset } = setup();
  const a1 = activeAsset();
  const a2 = activeAsset();
  const a3 = activeAsset();

  const draft = assetDepreciationRunCreate(ctx, { period: '2026-02', idempotencyKey: 'd' });
  assert.equal(draft.ok, true, JSON.stringify(draft));
  assert.equal(draft.lines.length, 3, 'all three assets are in the run');
  assert.equal(draft.run.totalAmountRappen, 300_000);

  // ONE asset moves after the draft was calculated. The run is a single atomic step, so the other two
  // must not post either: a partially posted period would leave the sub-ledger out of step with the GL.
  store.db.prepare('UPDATE asset SET accumulated_depr_rappen = 50000 WHERE workspace_id = ? AND id = ?').run(workspaceId, a2);

  const r = assetDepreciationRunPost(ctx, { runId: draft.run.id, idempotencyKey: 'p' });
  assert.equal(r.ok, false, `a stale line must stop the whole batch: ${JSON.stringify(r)}`);
  assert.equal(r.error, 'stale_draft');
  assert.equal(r.assetId, a2, 'the offending asset is named');

  assert.equal(deprEntryCount(store, workspaceId), 0, 'ZERO journal entries');
  assert.equal(deprTxnCount(store, workspaceId), 0, 'ZERO sub-ledger movements');
  assert.equal(assetDepreciationRunGet(ctx, { runId: draft.run.id }).run.status, 'draft', 'the run did not flip');
  for (const id of [a1, a3]) {
    const asset = getAsset(ctx, { assetId: id }).asset;
    assert.equal(asset.accumulatedDeprRappen, 0, 'an untouched asset stays untouched');
    assert.equal(asset.netBookValueRappen, 1_200_000);
    assert.equal(asset.lastDepreciationPeriod, null);
  }
});

test('a CAPITALISATION between draft and post is refused: the register can never disagree with the GL', () => {
  const { ctx, store, workspaceId, acc, activeAsset } = setup();
  const assetId = activeAsset();

  const draft = assetDepreciationRunCreate(ctx, { period: '2026-02', idempotencyKey: 'd' });
  assert.equal(draft.ok, true, JSON.stringify(draft));
  assert.equal(draft.lines[0].amountRappen, 100_000);
  assert.equal(draft.lines[0].nbvAfterRappen, 1_100_000);

  // An ordinary H02 event, in the ordinary order: CHF 3'000.00 capitalised onto the asset while the
  // draft is under review. It raises cost and NBV and leaves accumulated depreciation alone, so a
  // stale check that watches only `accumulated_depr_rappen` waves it through. The post would then
  // write net_book_value_rappen from a figure computed against the PRE-capitalisation cost: the
  // register would carry NBV 1'100'000 while the GL carries 1'500'000 - 100'000 = 1'400'000, a
  // 300'000 hole in the OP11 reconciliation, permanent and compounding into every later period.
  const cap = assetAddCapitalisation(ctx, {
    assetId,
    date: '2026-02-10',
    amountRappen: 300_000,
    creditAccountId: acc('1020'),
    idempotencyKey: 'cap',
  });
  assert.equal(cap.ok, true, JSON.stringify(cap));

  const posted = assetDepreciationRunPost(ctx, { runId: draft.run.id, idempotencyKey: 'p' });
  assert.equal(posted.ok, false, `a draft whose valuation moved must not post: ${JSON.stringify(posted)}`);
  assert.equal(posted.error, 'stale_draft');
  assert.equal(posted.reason, 'valuation_moved');
  assert.equal(posted.assetId, assetId);

  // Nothing half-done, and the asset still satisfies its own §4 identity.
  assert.equal(deprEntryCount(store, workspaceId), 0, 'no depreciation journal');
  assert.equal(deprTxnCount(store, workspaceId), 0, 'no sub-ledger movement');
  assert.equal(assetDepreciationRunGet(ctx, { runId: draft.run.id }).run.status, 'draft');
  const after = getAsset(ctx, { assetId }).asset;
  assert.equal(after.acquisitionCostRappen, 1_500_000);
  assert.equal(after.accumulatedDeprRappen, 0);
  assert.equal(after.netBookValueRappen, 1_500_000);
  assert.equal(
    after.netBookValueRappen,
    after.acquisitionCostRappen - after.accumulatedDeprRappen,
    'cost - accumulated == NBV, the identity the whole sub-ledger rests on',
  );

  // The documented recovery (US-H04.6): recreate the run. It calculates from the NEW cost, posts, and
  // leaves the register reconciled to the GL.
  const redone = assetDepreciationRunCreate(ctx, { period: '2026-02', idempotencyKey: 'd2' });
  assert.equal(redone.ok, true, JSON.stringify(redone));
  assert.equal(redone.lines[0].amountRappen, 125_000, 'CHF 15000.00 over 12 months, from the new cost');
  assert.equal(assetDepreciationRunPost(ctx, { runId: redone.run.id, idempotencyKey: 'p2' }).ok, true);
  const settled = getAsset(ctx, { assetId }).asset;
  assert.equal(settled.accumulatedDeprRappen, 125_000);
  assert.equal(settled.netBookValueRappen, 1_375_000);
  assert.equal(settled.netBookValueRappen, settled.acquisitionCostRappen - settled.accumulatedDeprRappen);
  // The GL agrees: the accumulated-depreciation account carries exactly what the register says.
  const accum = store.db
    .prepare(
      "SELECT COALESCE(SUM(credit_minor), 0) - COALESCE(SUM(debit_minor), 0) AS n FROM journal_line WHERE account_id = ? AND entry_id IN (SELECT id FROM journal_entry WHERE workspace_id = ? AND status = 'posted')",
    )
    .get(acc('1510'), workspaceId).n;
  assert.equal(accum, settled.accumulatedDeprRappen, 'OP11: the GL control account equals the register');
});

test('an empty create writes NO run at all: nothing to review, nothing to post, nothing left behind', () => {
  const { ctx, store, workspaceId, activeAsset } = setup();
  // A method-none asset is never eligible, so a run over it is empty.
  activeAsset({ depreciationMethod: 'none', usefulLifeMonths: null });
  const draft = assetDepreciationRunCreate(ctx, { period: '2026-02', idempotencyKey: 'd' });
  assert.equal(draft.ok, true, JSON.stringify(draft));
  assert.equal(draft.empty, true);
  assert.equal(draft.lines.length, 0);
  assert.equal(draft.run, null, 'an empty run is not a run: no header is persisted');
  assert.equal(
    store.db.prepare('SELECT COUNT(*) AS n FROM asset_depreciation_run WHERE workspace_id = ?').get(workspaceId).n,
    0,
    'no phantom draft is left in the register',
  );
  assert.equal(assetDepreciationRunList(ctx).total, 0, 'and none in the list a period-close checklist reads');
});

test('REPEATED creates on a posted period answer IDENTICALLY, for ever', () => {
  const { ctx, store, workspaceId, activeAsset } = setup();
  activeAsset();
  const draft = assetDepreciationRunCreate(ctx, { period: '2026-02', idempotencyKey: 'd' });
  const posted = assetDepreciationRunPost(ctx, { runId: draft.run.id, idempotencyKey: 'p' });
  assert.equal(posted.ok, true, JSON.stringify(posted));

  // The promise is that a create for an already-posted period is an EMPTY answer naming the run that
  // did the work, and it has to hold on every call, not only the first. A persisted empty header made
  // call two collide with call one, so a retrying agent was pointed at a phantom draft it could
  // neither review nor post, the Studio replaced the explanation with a wrong error banner, and the
  // period-close checklist saw an outstanding draft on a period that was finished.
  const answers = ['a', 'b', 'c'].map((k) => assetDepreciationRunCreate(ctx, { period: '2026-02', idempotencyKey: k }));
  for (const [i, answer] of answers.entries()) {
    assert.equal(answer.ok, true, `call ${i + 1}: ${JSON.stringify(answer)}`);
    assert.equal(answer.empty, true, `call ${i + 1} is empty`);
    assert.equal(answer.run, null, `call ${i + 1} persists nothing`);
    assert.equal(answer.alreadyPostedRunId, draft.run.id, `call ${i + 1} names the run that did the work`);
  }
  assert.deepEqual(answers[1], answers[0], 'call 2 answers exactly as call 1');
  assert.deepEqual(answers[2], answers[0], 'and so does call 3');

  // The register is unchanged by any of it: one posted run for the period, no drafts, ever.
  const rows = store.db
    .prepare('SELECT status FROM asset_depreciation_run WHERE workspace_id = ? AND period = ?')
    .all(workspaceId, '2026-02');
  assert.deepEqual(rows, [{ status: 'posted' }], 'one posted run, no phantom draft beside it');
  assert.equal(assetDepreciationRunList(ctx, { status: 'draft' }).total, 0, 'a finished period reports no outstanding draft');
});

test('list filters by status and period; get returns header + lines', () => {
  const { ctx, activeAsset } = setup();
  activeAsset();
  const draft = assetDepreciationRunCreate(ctx, { period: '2026-02', idempotencyKey: 'd' });
  assetDepreciationRunPost(ctx, { runId: draft.run.id, idempotencyKey: 'p' });
  assert.equal(assetDepreciationRunList(ctx, { status: 'posted' }).runs.length, 1);
  assert.equal(assetDepreciationRunList(ctx, { status: 'draft' }).runs.length, 0);
  assert.equal(assetDepreciationRunList(ctx, { period: '2026-02' }).runs.length, 1);
  assert.equal(assetDepreciationRunList(ctx, { period: '2026-03' }).runs.length, 0);
  const got = assetDepreciationRunGet(ctx, { runId: draft.run.id });
  assert.equal(got.ok, true);
  assert.equal(got.run.status, 'posted');
  assert.equal(got.lines.length, 1);
});

// --- The H03 parameter-gap closure: declining_balance posts from the STORED column ---------------

test('declining_balance posts from the stored declining_rate_bp column (H03 gap closed)', () => {
  const { ctx, activeAsset } = setup();
  // 20% p.a. declining on NBV 1'200'000 => 1'200'000 * 2000 / (10000*12) = 20'000 for the first month.
  const assetId = activeAsset(
    { depreciationMethod: 'declining_balance', usefulLifeMonths: 60, decliningRateBp: 2000 },
    { depreciationMethod: 'declining_balance', usefulLifeMonths: 60 },
  );
  // The stored column is what the engine reads: no per-call override is supplied here.
  assert.equal(getAsset(ctx, { assetId }).asset.decliningRateBp, 2000);
  const draft = assetDepreciationRunCreate(ctx, { period: '2026-02', idempotencyKey: 'd' });
  assert.equal(draft.ok, true, JSON.stringify(draft));
  assert.equal(draft.lines.length, 1);
  assert.equal(draft.lines[0].amountRappen, 20_000, 'declining-balance amount from the stored rate');
  const posted = assetDepreciationRunPost(ctx, { runId: draft.run.id, idempotencyKey: 'p' });
  assert.equal(posted.ok, true);
  assert.equal(getAsset(ctx, { assetId }).asset.accumulatedDeprRappen, 20_000);
});

test('NEVER BELOW RESIDUAL: a declining-balance charge that would overshoot clamps onto the residual', () => {
  const { ctx, store, workspaceId, activeAsset } = setup();
  // CHF 12'000.00 cost, CHF 11'900.00 residual, 20% p.a. declining. The raw first month is
  // 1'200'000 * 2000 / (10000*12) = CHF 200.00, which is DOUBLE the CHF 100.00 depreciable base left.
  // The posted amount must be the base, and NBV must land exactly on residual, never through it.
  const assetId = activeAsset(
    { depreciationMethod: 'declining_balance', usefulLifeMonths: 60, decliningRateBp: 2000, residualValueRappen: 1_190_000 },
    { depreciationMethod: 'declining_balance', usefulLifeMonths: 60 },
  );

  const draft = assetDepreciationRunCreate(ctx, { period: '2026-02', idempotencyKey: 'd' });
  assert.equal(draft.ok, true, JSON.stringify(draft));
  assert.equal(draft.lines.length, 1);
  assert.equal(draft.lines[0].amountRappen, 10_000, 'the raw 200.00 charge clamps to the 100.00 base');
  assert.equal(draft.lines[0].nbvAfterRappen, 1_190_000, 'NBV lands exactly on residual');
  assert.equal(draft.lines[0].isFinal, true);

  const posted = assetDepreciationRunPost(ctx, { runId: draft.run.id, idempotencyKey: 'p' });
  assert.equal(posted.ok, true, JSON.stringify(posted));
  // The GL carries the clamped figure, not the raw one.
  const debit = store.db
    .prepare('SELECT SUM(debit_minor) AS d FROM journal_line WHERE entry_id = ?')
    .get(posted.journalEntryId).d;
  assert.equal(debit, 10_000, 'the journal booked the clamped amount');

  const asset = getAsset(ctx, { assetId }).asset;
  assert.equal(asset.accumulatedDeprRappen, 10_000);
  assert.equal(asset.netBookValueRappen, 1_190_000, 'never below residual');
  assert.equal(asset.status, 'fully_depreciated');

  // And it stays there: a later run finds nothing left to charge.
  const next = assetDepreciationRunCreate(ctx, { period: '2026-03', idempotencyKey: 'd2' });
  assert.equal(next.ok, true, JSON.stringify(next));
  assert.equal(next.empty, true);
  assert.equal(deprEntryCount(store, workspaceId), 1, 'one entry, one clamped charge, nothing after');
});

// --- units_of_production: the period's production figures travel ON the run ----------------------
//
// TILL has no production-data capture capability to source the figure from, so the run itself carries
// it (`unitsByAsset`, the same shape asset_depreciation_preview already takes). Without it a
// units-tracked asset could never depreciate at all, and the engine's `missing_production_data` was
// being swallowed by a bare `continue` that dropped the asset with no trace.

test('a units_of_production asset depreciates from the units supplied on the run and posts balanced', () => {
  const { ctx, store, workspaceId, acc, activeAsset } = setup();
  // CHF 12'000.00 over 10'000 estimated units, no residual: CHF 1.20 of depreciation per unit.
  const assetId = activeAsset(
    { depreciationMethod: 'units_of_production', usefulLifeMonths: 60, totalEstimatedUnits: 10_000 },
    { depreciationMethod: 'units_of_production', usefulLifeMonths: 60 },
  );

  const draft = assetDepreciationRunCreate(ctx, {
    period: '2026-02',
    unitsByAsset: { [assetId]: 500 },
    idempotencyKey: 'd',
  });
  assert.equal(draft.ok, true, JSON.stringify(draft));
  assert.equal(draft.lines.length, 1, 'the units asset is IN the run, not silently dropped');
  // 1'200'000 * 500 / 10'000 = 60'000 Rappen. The amount depends on total_estimated_units, which is
  // what makes that column load-bearing rather than decorative.
  assert.equal(draft.lines[0].amountRappen, 60_000);
  assert.equal(draft.lines[0].unitsProduced, 500, 'the run records the input that produced the figure');
  assert.deepEqual(draft.skipped, [], 'nothing was skipped');

  const posted = assetDepreciationRunPost(ctx, { runId: draft.run.id, idempotencyKey: 'p' });
  assert.equal(posted.ok, true, JSON.stringify(posted));
  const lines = store.db
    .prepare('SELECT account_id, debit_minor, credit_minor FROM journal_line WHERE entry_id = ?')
    .all(posted.journalEntryId);
  assert.equal(lines.reduce((s, l) => s + l.debit_minor, 0), 60_000);
  assert.equal(lines.reduce((s, l) => s + l.credit_minor, 0), 60_000);
  assert.equal(lines.find((l) => l.account_id === acc('6800')).debit_minor, 60_000);
  assert.equal(lines.find((l) => l.account_id === acc('1510')).credit_minor, 60_000);

  const asset = getAsset(ctx, { assetId }).asset;
  assert.equal(asset.accumulatedDeprRappen, 60_000);
  assert.equal(asset.netBookValueRappen, 1_140_000);
  assert.equal(asset.lastDepreciationPeriod, '2026-02');
  // The audit row is written exactly once for the units charge.
  assert.equal(deprTxnCount(store, workspaceId), 1);
});

test('NEVER BELOW RESIDUAL: a units charge that would overshoot clamps onto the residual', () => {
  const { ctx, store, activeAsset } = setup();
  // CHF 12'000.00 cost, CHF 11'900.00 residual (CHF 100.00 depreciable), 7 estimated units.
  const assetId = activeAsset(
    {
      depreciationMethod: 'units_of_production',
      usefulLifeMonths: 60,
      totalEstimatedUnits: 7,
      residualValueRappen: 1_190_000,
    },
    { depreciationMethod: 'units_of_production', usefulLifeMonths: 60 },
  );
  // A prior movement left accumulated depreciation at CHF 15.00, which is NOT on a whole-unit
  // boundary (an impairment or a correction can do that). The consumed-units estimate rounds DOWN to
  // one unit, so six units still look available while only CHF 85.00 of base is actually left.
  // Six units also EXHAUST that capacity, so this is the final period and the residual-adjust is the
  // line that carries the figure; `Math.min(raw, remaining)` sits behind it as a second-line guard
  // that the public path can no longer reach (see the report for why).
  store.db
    .prepare('UPDATE asset SET accumulated_depr_rappen = 1500, net_book_value_rappen = 1198500 WHERE id = ?')
    .run(assetId);

  const draft = assetDepreciationRunCreate(ctx, {
    period: '2026-02',
    unitsByAsset: { [assetId]: 6 },
    idempotencyKey: 'd',
  });
  assert.equal(draft.ok, true, JSON.stringify(draft));
  // Raw would be round(10'000 * 6 / 7) = 8'571 Rappen, which overshoots the 8'500 that is left.
  assert.equal(draft.lines[0].amountRappen, 8_500, 'the charge clamps onto the residual, never through it');
  assert.equal(draft.lines[0].nbvAfterRappen, 1_190_000, 'NBV lands exactly on residual');
  assert.equal(draft.lines[0].isFinal, true);

  const posted = assetDepreciationRunPost(ctx, { runId: draft.run.id, idempotencyKey: 'p' });
  assert.equal(posted.ok, true, JSON.stringify(posted));
  assert.equal(
    store.db.prepare('SELECT SUM(debit_minor) AS d FROM journal_line WHERE entry_id = ?').get(posted.journalEntryId).d,
    8_500,
    'the journal booked the clamped amount',
  );
  const asset = getAsset(ctx, { assetId }).asset;
  assert.equal(asset.netBookValueRappen, 1_190_000, 'never below residual');
  assert.equal(asset.status, 'fully_depreciated');
});

test('NEVER BELOW RESIDUAL, units over the FULL LIFE: the posted amounts sum to exactly (cost - residual)', () => {
  const { ctx, activeAsset } = setup();
  // A CHF 250'000.00 machine, CHF 10'000.00 residual, 175'000 estimated units, 12'000 units a month.
  // Depreciable base CHF 240'000.00. Per-period rounding leaves a tail (14 periods at 1'645'714 plus a
  // 7'000-unit period at 960'000 sums to 23'999'996), so unless the LAST period absorbs it the asset
  // strands 4 Rappen above residual, stays `active` for ever, and can never be charged again because
  // its capacity is exhausted. Straight line already residual-adjusts its final period; so must this.
  const cost = 25_000_000;
  const residual = 1_000_000;
  const assetId = activeAsset(
    {
      depreciationMethod: 'units_of_production',
      usefulLifeMonths: 120,
      totalEstimatedUnits: 175_000,
      residualValueRappen: residual,
      acquisitionCostRappen: cost,
    },
    { depreciationMethod: 'units_of_production', usefulLifeMonths: 120 },
  );

  const nextPeriod = (p) => {
    const y = Number(p.slice(0, 4));
    const m = Number(p.slice(5, 7));
    return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  };
  let period = '2026-02';
  let totalPosted = 0;
  let periods = 0;
  for (let i = 0; i < 40; i += 1) {
    const draft = assetDepreciationRunCreate(ctx, {
      period,
      unitsByAsset: { [assetId]: 12_000 },
      idempotencyKey: `d-${period}`,
    });
    assert.equal(draft.ok, true, JSON.stringify(draft));
    if (draft.lines.length === 0) break;
    // No period ever drives NBV below residual.
    assert.ok(draft.lines[0].nbvAfterRappen >= residual, `NBV ${draft.lines[0].nbvAfterRappen} >= residual`);
    const posted = assetDepreciationRunPost(ctx, { runId: draft.run.id, idempotencyKey: `p-${period}` });
    assert.equal(posted.ok, true, JSON.stringify(posted));
    totalPosted += draft.run.totalAmountRappen;
    periods += 1;
    period = nextPeriod(period);
  }

  assert.equal(totalPosted, cost - residual, 'the posted amounts sum to exactly (cost - residual), no stranded Rappen');
  const asset = getAsset(ctx, { assetId }).asset;
  assert.equal(asset.accumulatedDeprRappen, cost - residual, 'accumulated == depreciable base');
  assert.equal(asset.netBookValueRappen, residual, 'final NBV lands exactly on residual');
  assert.equal(asset.status, 'fully_depreciated', 'the asset is retired from the register, not left active for ever');
  assert.ok(periods >= 14 && periods <= 16, `a 175'000-unit life at 12'000 a month is ~15 periods, got ${periods}`);

  // And it is excluded from every later run, as §7 promises.
  const after = assetDepreciationRunCreate(ctx, { period: '2029-01', unitsByAsset: { [assetId]: 12_000 }, idempotencyKey: 'after' });
  assert.equal(after.ok, true, JSON.stringify(after));
  assert.equal(after.empty, true);
});

test('the LAST units period absorbs the rounding tail, to the Rappen', () => {
  const { ctx, store, activeAsset } = setup();
  // CHF 12'000.00 cost against a CHF 11'999.00 residual: 100 Rappen of depreciable base over 3 units.
  // 100/3 rounds to 33, so three equal periods post 99 and strand 1 Rappen. The final period must
  // charge 34.
  const assetId = activeAsset(
    {
      depreciationMethod: 'units_of_production',
      usefulLifeMonths: 60,
      totalEstimatedUnits: 3,
      residualValueRappen: 1_199_900,
    },
    { depreciationMethod: 'units_of_production', usefulLifeMonths: 60 },
  );

  const amounts = [];
  let period = '2026-02';
  for (const p of ['2026-02', '2026-03', '2026-04']) {
    period = p;
    const draft = assetDepreciationRunCreate(ctx, { period, unitsByAsset: { [assetId]: 1 }, idempotencyKey: `d-${period}` });
    assert.equal(draft.ok, true, JSON.stringify(draft));
    assert.equal(draft.lines.length, 1, `period ${period} must charge something`);
    amounts.push(draft.lines[0].amountRappen);
    assert.equal(assetDepreciationRunPost(ctx, { runId: draft.run.id, idempotencyKey: `p-${period}` }).ok, true);
  }
  assert.deepEqual(amounts, [33, 33, 34], 'the tail lands on the final period, never in the void');
  assert.equal(amounts.reduce((s, a) => s + a, 0), 100, 'the three periods sum to the whole depreciable base');

  const asset = getAsset(ctx, { assetId }).asset;
  assert.equal(asset.netBookValueRappen, 1_199_900, 'NBV lands exactly on residual');
  assert.equal(asset.accumulatedDeprRappen, 100);
  assert.equal(asset.status, 'fully_depreciated');
  // The GL carries the same total as the sub-ledger (OP11).
  assert.equal(
    store.db
      .prepare(
        "SELECT SUM(debit_minor) AS d FROM journal_line WHERE entry_id IN (SELECT id FROM journal_entry WHERE source = 'asset_depreciation')",
      )
      .get().d,
    100,
  );
});

test('an EXPLICITLY named asset that is ineligible is reported, never dropped by the pre-filter', () => {
  const { ctx, activeAsset } = setup();
  const good = activeAsset();
  const noMethod = activeAsset({ depreciationMethod: 'none', usefulLifeMonths: null });
  const already = activeAsset();
  const wrongCategory = activeAsset();

  // `already` has been depreciated for the period by an earlier run.
  const first = assetDepreciationRunCreate(ctx, { period: '2026-02', assetIds: [already], idempotencyKey: 'pre' });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(assetDepreciationRunPost(ctx, { runId: first.run.id, idempotencyKey: 'pre-p' }).ok, true);

  // Naming all four: only `good` can be charged, and the caller is told WHY for each of the others.
  // The pre-filter used to drop them before the engine ever ran, so the very reasons the tool text
  // advertises (non_depreciable, period_already_processed) were structurally unreachable.
  const run = assetDepreciationRunCreate(ctx, {
    period: '2026-02',
    assetIds: [good, noMethod, already, wrongCategory],
    categoryId: 'cat_absent',
    idempotencyKey: 'd',
  });
  assert.equal(run.ok, true, JSON.stringify(run));
  const reasons = Object.fromEntries(run.skipped.map((s) => [s.assetId, s.reason]));
  assert.equal(run.skipped.length, 4, `every named asset that produced no line is reported: ${JSON.stringify(run.skipped)}`);
  assert.equal(reasons[noMethod], 'non_depreciable');
  assert.equal(reasons[already], 'period_already_processed');
  assert.equal(reasons[wrongCategory], 'filtered_out');
  assert.equal(reasons[good], 'filtered_out', 'even the depreciable one, once a filter excludes it');
  assert.ok(
    run.skipped.every((s) => typeof s.assetNumber === 'string' && s.assetNumber.length > 0),
    'each is named by its asset number, not only its id',
  );

  // Without the category filter, `good` runs and the other three are still reported.
  const run2 = assetDepreciationRunCreate(ctx, {
    period: '2026-02',
    assetIds: [good, noMethod, already, wrongCategory],
    idempotencyKey: 'd2',
  });
  assert.equal(run2.ok, true, JSON.stringify(run2));
  assert.equal(run2.lines.length, 2, 'good and wrongCategory are both depreciable without the filter');
  assert.equal(run2.skipped.length, 2);
  assert.deepEqual(
    run2.skipped.map((s) => s.reason).sort(),
    ['non_depreciable', 'period_already_processed'],
  );
});

test('an EXPLICITLY named asset that is terminal or fully depreciated is reported with its own reason', () => {
  const { ctx, store, activeAsset } = setup();
  const disposed = activeAsset();
  const atResidual = activeAsset();
  // Drive one asset to its residual and retire the other, the two states a period-end selection meets
  // most often.
  store.db
    .prepare('UPDATE asset SET accumulated_depr_rappen = 1200000, net_book_value_rappen = 0 WHERE id = ?')
    .run(atResidual);
  store.db.prepare("UPDATE asset SET status = 'disposed' WHERE id = ?").run(disposed);

  const run = assetDepreciationRunCreate(ctx, {
    period: '2026-02',
    assetIds: [disposed, atResidual],
    idempotencyKey: 'd',
  });
  assert.equal(run.ok, true, JSON.stringify(run));
  assert.equal(run.empty, true);
  const reasons = Object.fromEntries(run.skipped.map((s) => [s.assetId, s.reason]));
  assert.equal(reasons[disposed], 'asset_terminal');
  assert.equal(reasons[atResidual], 'already_at_residual');
});

test('a units asset with NO units supplied is REPORTED, never silently dropped', () => {
  const { ctx, store, workspaceId, activeAsset } = setup();
  const plain = activeAsset(); // straight line, CHF 1'000.00 a month
  const units = activeAsset(
    { depreciationMethod: 'units_of_production', usefulLifeMonths: 60, totalEstimatedUnits: 10_000 },
    { depreciationMethod: 'units_of_production', usefulLifeMonths: 60 },
  );

  // A sweep still runs for everything else, but the units asset comes back NAMED, with the reason.
  const draft = assetDepreciationRunCreate(ctx, { period: '2026-02', idempotencyKey: 'd' });
  assert.equal(draft.ok, true, JSON.stringify(draft));
  assert.equal(draft.lines.length, 1, 'the straight-line asset still runs');
  assert.equal(draft.lines[0].assetId, plain);
  assert.equal(draft.skipped.length, 1, 'the units asset is reported, not dropped');
  assert.equal(draft.skipped[0].assetId, units);
  assert.equal(draft.skipped[0].reason, 'missing_production_data');
  assert.ok(typeof draft.skipped[0].assetNumber === 'string' && draft.skipped[0].assetNumber.length > 0);

  // Naming it EXPLICITLY is an unambiguous instruction to depreciate it, so silence would be wrong:
  // the create is refused and nothing is written.
  const before = store.db.prepare('SELECT COUNT(*) AS n FROM asset_depreciation_run WHERE workspace_id = ?').get(workspaceId).n;
  const named = assetDepreciationRunCreate(ctx, { period: '2026-02', assetIds: [units], idempotencyKey: 'd2' });
  assert.equal(named.ok, false, `an explicitly named units asset without units must be refused: ${JSON.stringify(named)}`);
  assert.equal(named.error, 'missing_production_data');
  assert.equal(named.assetId, units);
  assert.equal(
    store.db.prepare('SELECT COUNT(*) AS n FROM asset_depreciation_run WHERE workspace_id = ?').get(workspaceId).n,
    before,
    'no run was written',
  );
});

test('a units asset with no total_estimated_units names THAT, not the figure the caller already gave', () => {
  const { ctx, store, workspaceId, activeAsset } = setup();
  // The master allows a units_of_production asset without an estimate: the method is on the category,
  // the estimate is an optional per-asset figure. Such an asset cannot be charged, but the caller who
  // DID supply the production figure must not be told their figure is missing.
  const assetId = activeAsset(
    { depreciationMethod: 'units_of_production', usefulLifeMonths: 60 },
    { depreciationMethod: 'units_of_production', usefulLifeMonths: 60 },
  );
  assert.equal(getAsset(ctx, { assetId }).asset.totalEstimatedUnits, null, 'no estimate on the master');

  const sweep = assetDepreciationRunCreate(ctx, { period: '2026-02', unitsByAsset: { [assetId]: 500 }, idempotencyKey: 'd' });
  assert.equal(sweep.ok, true, JSON.stringify(sweep));
  assert.equal(sweep.skipped.length, 1);
  assert.equal(sweep.skipped[0].reason, 'missing_units_estimate', 'the master is what is missing, not the input');

  // Named explicitly it refuses, like any other input error the caller can fix, and points at the
  // field they have to fix.
  const named = assetDepreciationRunCreate(ctx, {
    period: '2026-02',
    assetIds: [assetId],
    unitsByAsset: { [assetId]: 500 },
    idempotencyKey: 'd2',
  });
  assert.equal(named.ok, false, JSON.stringify(named));
  assert.equal(named.error, 'missing_units_estimate');
  assert.equal(named.field, 'totalEstimatedUnits', 'the answer names the field to correct');
  assert.equal(named.assetId, assetId);
  assert.equal(
    store.db.prepare('SELECT COUNT(*) AS n FROM asset_depreciation_run WHERE workspace_id = ?').get(workspaceId).n,
    0,
    'the refusal wrote nothing, and the empty sweep before it wrote nothing either',
  );

  // And with NO figure supplied either, the missing ESTIMATE is still the answer: typing a production
  // figure would not help this asset, so the surface must not invite one.
  const noUnits = assetDepreciationRunCreate(ctx, { period: '2026-03', idempotencyKey: 'd3' });
  assert.equal(noUnits.ok, true, JSON.stringify(noUnits));
  assert.equal(noUnits.skipped[0].reason, 'missing_units_estimate');

  // The other way round is the plain case: an asset that HAS an estimate and no figure is told the
  // figure is what is missing.
  const withEstimate = activeAsset(
    { depreciationMethod: 'units_of_production', usefulLifeMonths: 60, totalEstimatedUnits: 10_000 },
    { depreciationMethod: 'units_of_production', usefulLifeMonths: 60 },
  );
  const mixed = assetDepreciationRunCreate(ctx, { period: '2026-04', idempotencyKey: 'd4' });
  assert.equal(mixed.ok, true, JSON.stringify(mixed));
  assert.equal(
    Object.fromEntries(mixed.skipped.map((s) => [s.assetId, s.reason]))[withEstimate],
    'missing_production_data',
  );
});

test('IDEMPOTENT ON ROWS holds for a run carrying units: one draft, one entry, one movement', () => {
  const { ctx, store, workspaceId, activeAsset } = setup();
  const assetId = activeAsset(
    { depreciationMethod: 'units_of_production', usefulLifeMonths: 60, totalEstimatedUnits: 10_000 },
    { depreciationMethod: 'units_of_production', usefulLifeMonths: 60 },
  );
  const input = { period: '2026-02', unitsByAsset: { [assetId]: 500 }, idempotencyKey: 'same' };
  const c1 = assetDepreciationRunCreate(ctx, input);
  const c2 = assetDepreciationRunCreate(ctx, input);
  assert.equal(c1.ok, true, JSON.stringify(c1));
  assert.equal(c2.run.id, c1.run.id, 'a replayed create returns the SAME draft');
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM asset_depreciation_run WHERE workspace_id = ?').get(workspaceId).n, 1);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM asset_depreciation_line WHERE workspace_id = ?').get(workspaceId).n, 1);

  const p1 = assetDepreciationRunPost(ctx, { runId: c1.run.id, idempotencyKey: 'pk' });
  const p2 = assetDepreciationRunPost(ctx, { runId: c1.run.id, idempotencyKey: 'pk' });
  assert.equal(p1.ok, true);
  assert.equal(JSON.stringify(p2), JSON.stringify(p1));
  assert.equal(deprEntryCount(store, workspaceId), 1, 'exactly ONE journal entry');
  assert.equal(deprTxnCount(store, workspaceId), 1, 'exactly ONE asset_transaction');
  assert.equal(getAsset(ctx, { assetId }).asset.accumulatedDeprRappen, 60_000, 'charged once, not twice');
});

test('a different units figure is a different selection, not a duplicate of the same run', () => {
  const { ctx, activeAsset } = setup();
  const assetId = activeAsset(
    { depreciationMethod: 'units_of_production', usefulLifeMonths: 60, totalEstimatedUnits: 10_000 },
    { depreciationMethod: 'units_of_production', usefulLifeMonths: 60 },
  );
  const a = assetDepreciationRunCreate(ctx, { period: '2026-02', unitsByAsset: { [assetId]: 500 }, idempotencyKey: 'a' });
  assert.equal(a.ok, true, JSON.stringify(a));
  // The SAME units figure under a new key collides on the selection, as any repeat run does.
  const same = assetDepreciationRunCreate(ctx, { period: '2026-02', unitsByAsset: { [assetId]: 500 }, idempotencyKey: 'a2' });
  assert.equal(same.error, 'run_already_exists');
  // A DIFFERENT figure is a different run: a corrected production figure must not be mistaken for a
  // replay of the first one.
  const other = assetDepreciationRunCreate(ctx, { period: '2026-02', unitsByAsset: { [assetId]: 600 }, idempotencyKey: 'b' });
  assert.equal(other.ok, true, JSON.stringify(other));
  assert.equal(other.lines[0].amountRappen, 72_000);
});

test('the selection signature is the figures USED, not the raw input map', () => {
  const { ctx, store, workspaceId, activeAsset } = setup();
  const units = activeAsset(
    { depreciationMethod: 'units_of_production', usefulLifeMonths: 60, totalEstimatedUnits: 10_000 },
    { depreciationMethod: 'units_of_production', usefulLifeMonths: 60 },
  );
  const plain = activeAsset(); // straight line: any figure sent for it is discarded

  // Noise in the map that changes nothing about the run: an id belonging to nobody, and a figure for
  // a straight-line asset that the engine never reads. Two creates over the same eligible set must
  // still be ONE draft, which is what the tool text promises.
  const a = assetDepreciationRunCreate(ctx, {
    period: '2026-02',
    unitsByAsset: { [units]: 500, as_nobody: 7, [plain]: 500 },
    idempotencyKey: 'a',
  });
  assert.equal(a.ok, true, JSON.stringify(a));
  const b = assetDepreciationRunCreate(ctx, {
    period: '2026-02',
    unitsByAsset: { [units]: 500, as_someone_else: 9, [plain]: 900 },
    idempotencyKey: 'b',
  });
  assert.equal(b.ok, false, `the same eligible set with different noise must not spawn a second run: ${JSON.stringify(b)}`);
  assert.equal(b.error, 'run_already_exists');
  assert.equal(b.runId, a.run.id, 'the caller is pointed at the run that already exists');

  // The harm this closes: there is no SECOND live draft to post. Only one run exists for the period,
  // so nobody can post a stale twin and meet stale_draft where the honest answer was "already done".
  assert.equal(
    store.db.prepare("SELECT COUNT(*) AS n FROM asset_depreciation_run WHERE workspace_id = ? AND status != 'reversed'").get(workspaceId).n,
    1,
    'one period, one live run',
  );
  assert.equal(assetDepreciationRunPost(ctx, { runId: a.run.id, idempotencyKey: 'p' }).ok, true);

  // Re-creating after the post comes back EMPTY: both assets carry 2026-02 as their last period, so
  // nothing is eligible any more. That, not run_already_posted, is what the caller sees, because the
  // signature is made of the lines and there are none left to make it from.
  const c = assetDepreciationRunCreate(ctx, {
    period: '2026-02',
    unitsByAsset: { [units]: 500, yet_another: 3 },
    idempotencyKey: 'c',
  });
  assert.equal(c.ok, true, JSON.stringify(c));
  assert.equal(c.empty, true, 'nothing left to charge for the period');
  assert.equal(c.lines.length, 0);
  assert.equal(deprEntryCount(store, workspaceId), 1, 'and no second journal was ever posted');
  // An empty result with no explanation is the silent skip wearing a different hat: say WHY it is
  // empty, and name the run that already did the work.
  assert.equal(c.alreadyPostedRunId, a.run.id, 'the empty run points at the posted run for the period');
});

test('two units figures that produce the SAME amount are still two different runs', () => {
  const { ctx, store, activeAsset } = setup();
  // The clamping asset from the residual case: anything from 6 units upwards charges the same
  // CHF 85.00, because the charge clamps onto the residual. The AMOUNT alone therefore cannot tell
  // the two runs apart, and the amounts are what the rest of the selection signature is made of. The
  // figures still differ, and the line records the figure, so an audit that says 6 when the operator
  // said 7 would be a small lie: the production figures belong in the signature.
  const assetId = activeAsset(
    {
      depreciationMethod: 'units_of_production',
      usefulLifeMonths: 60,
      totalEstimatedUnits: 7,
      residualValueRappen: 1_190_000,
    },
    { depreciationMethod: 'units_of_production', usefulLifeMonths: 60 },
  );
  store.db
    .prepare('UPDATE asset SET accumulated_depr_rappen = 1500, net_book_value_rappen = 1198500 WHERE id = ?')
    .run(assetId);

  const six = assetDepreciationRunCreate(ctx, { period: '2026-02', unitsByAsset: { [assetId]: 6 }, idempotencyKey: 'six' });
  const seven = assetDepreciationRunCreate(ctx, { period: '2026-02', unitsByAsset: { [assetId]: 7 }, idempotencyKey: 'seven' });
  assert.equal(six.ok, true, JSON.stringify(six));
  assert.equal(seven.ok, true, `a different figure is not a replay of the first run: ${JSON.stringify(seven)}`);
  assert.equal(six.lines[0].amountRappen, 8_500);
  assert.equal(seven.lines[0].amountRappen, 8_500, 'the same amount');
  assert.notEqual(seven.run.id, six.run.id, 'but a different run');
  assert.equal(six.lines[0].unitsProduced, 6);
  assert.equal(seven.lines[0].unitsProduced, 7, 'each line records the figure its own caller stated');
});

test('validation: unitsByAsset must be a map of non-negative whole units', () => {
  const { ctx, activeAsset } = setup();
  const assetId = activeAsset(
    { depreciationMethod: 'units_of_production', usefulLifeMonths: 60, totalEstimatedUnits: 10_000 },
    { depreciationMethod: 'units_of_production', usefulLifeMonths: 60 },
  );
  const bad = (units) => assetDepreciationRunCreate(ctx, { period: '2026-02', unitsByAsset: units, idempotencyKey: `k-${Math.random()}` });
  assert.equal(bad([['a', 1]]).error, 'invalid_input', 'an array is not a map');
  assert.equal(bad({ [assetId]: -1 }).error, 'invalid_input', 'negative production is not a figure');
  assert.equal(bad({ [assetId]: 1.5 }).error, 'invalid_input', 'a fractional unit would crash the exact-integer engine');
  assert.equal(bad({ [assetId]: 'lots' }).error, 'invalid_input');
  assert.equal(bad({ [assetId]: Number.NaN }).error, 'invalid_input');
  // Number.isInteger(1e300) is TRUE, so an absurd figure used to pass validation and land in the
  // INTEGER units_produced audit column as a float. The money was safe (the charge clamps), but a
  // money-path audit column the tool text calls "whole units" is no place for 1e300.
  assert.equal(bad({ [assetId]: 1e300 }).error, 'invalid_input', '1e300 is not a whole number of units');
  assert.equal(bad({ [assetId]: Number.MAX_VALUE }).error, 'invalid_input');
  assert.equal(bad({ [assetId]: 1e21 }).error, 'invalid_input');
  assert.equal(bad({ [assetId]: Number.MAX_SAFE_INTEGER }).error, 'invalid_input', 'beyond any real production run');
  assert.equal(bad({ [assetId]: Number.POSITIVE_INFINITY }).error, 'invalid_input');

  const good = bad({ [assetId]: 0 });
  // Zero production is a legitimate statement, not an error: nothing was produced, so nothing is
  // charged, and the asset is REPORTED as skipped rather than dropped.
  assert.equal(good.ok, true, JSON.stringify(good));
  assert.equal(good.lines.length, 0);
  assert.equal(good.skipped[0].assetId, assetId);
});

// --- The two wire faces carry the production figures identically ---------------------------------

test('unitsByAsset survives BOTH wire faces: MCP and REST agree line for line', () => {
  // Two independent, identically seeded stores: one driven through the MCP tool call, one through the
  // REST twin. A verb that only works when called in-process is not shipped.
  const fixture = (deps) => {
    const { workspaceId, accId } = mintWorkspace(deps);
    const cat = getAction('asset_category_create').run(deps, {
      workspaceId,
      code: 'PROD',
      name: 'Produktionsanlagen',
      depreciationMethod: 'units_of_production',
      usefulLifeMonths: 60,
      glAssetAccountId: accId('1500'),
      glAccumDeprAccountId: accId('1510'),
      glDeprExpenseAccountId: accId('6800'),
      idempotencyKey: 'cat',
    });
    assert.equal(cat.ok, true, JSON.stringify(cat));
    const asset = getAction('asset_create').run(deps, {
      workspaceId,
      categoryId: cat.category.id,
      name: 'Stanzautomat',
      acquisitionDate: '2026-01-10',
      acquisitionCostRappen: 1_200_000,
      totalEstimatedUnits: 10_000,
      idempotencyKey: 'as',
    });
    assert.equal(asset.ok, true, JSON.stringify(asset));
    const acq = getAction('asset_acquire').run(deps, {
      workspaceId,
      assetId: asset.asset.id,
      date: '2026-01-10',
      acquisitionCostRappen: 1_200_000,
      creditAccountId: accId('1020'),
      idempotencyKey: 'acq',
    });
    assert.equal(acq.ok, true, JSON.stringify(acq));
    return { workspaceId, assetId: asset.asset.id };
  };

  // The parameter is ADVERTISED, not merely tolerated: an agent cannot send a field the tool schema
  // never mentions, and a strict MCP client strips it.
  const declared = getAction('asset_depreciation_run_create').inputSchema.properties.unitsByAsset;
  assert.ok(declared !== undefined, 'unitsByAsset is declared on the tool schema');
  assert.equal(declared.type, 'object');

  const mcpDeps = freshDeps();
  const restDeps = freshDeps();
  const m = fixture(mcpDeps);
  const r = fixture(restDeps);
  assert.equal(m.assetId, r.assetId, 'the two stores are seeded identically');

  const input = {
    workspaceId: m.workspaceId,
    period: '2026-02',
    unitsByAsset: { [m.assetId]: 500 },
    idempotencyKey: 'run-1',
  };
  const viaMcp = JSON.parse(callTool(mcpDeps, 'asset_depreciation_run_create', input).content[0].text);
  const viaRest = handleRest('asset_depreciation_run_create', input, restDeps).body;
  assert.equal(viaMcp.ok, true, JSON.stringify(viaMcp));
  assert.deepEqual(viaMcp, viaRest, 'the two faces answer identically');
  assert.equal(viaMcp.lines.length, 1, 'the units asset depreciated across the wire');
  assert.equal(viaMcp.lines[0].amountRappen, 60_000);
  assert.equal(viaMcp.lines[0].unitsProduced, 500);

  // The declared object type is enforced at the dispatcher, on both faces, before the verb runs.
  const bad = { ...input, unitsByAsset: [500], idempotencyKey: 'run-2' };
  assert.equal(JSON.parse(callTool(mcpDeps, 'asset_depreciation_run_create', bad).content[0].text).error, 'invalid_input');
  assert.equal(handleRest('asset_depreciation_run_create', bad, restDeps).body.error, 'invalid_input');
});

test('a run reads back in REGISTER order, not in insertion order', () => {
  const { ctx, store, workspaceId, deps, activeAsset } = setup();
  void ctx;
  // Register numbers deliberately out of creation order. Every line of a run is inserted with the
  // same `now`, and a production id is `prefix_${randomUUID()}`, so ordering by (created_at, id)
  // orders a run's lines RANDOMLY in production and only looks stable here because the test id
  // generator happens to be monotonic. Meanwhile the selection is built ORDER BY number and skipped[]
  // preserves that, so the review table would show register numbers in random order directly above a
  // skipped table in register order.
  const third = activeAsset({ number: 'FA-0300' });
  const first = activeAsset({ number: 'FA-0100' });
  const second = activeAsset({ number: 'FA-0200' });

  // The run is created through a context whose ids do NOT ascend with insertion, which is what
  // `${prefix}_${randomUUID()}` behaves like in production. A monotonic test generator hides this
  // defect completely: that is why it shipped.
  const scrambled = () => {
    let n = 0;
    return { next: (prefix) => `${prefix}_${9_000_000 - (n += 1)}` };
  };
  const ctxScrambled = makeContext(store, {
    workspaceId,
    actor: 'user_1',
    clock: deps.clock,
    ids: scrambled(),
    ...ledgerPorts({ store: deps.store, workspaceId, ids: scrambled() }),
  });

  const draft = assetDepreciationRunCreate(ctxScrambled, { period: '2026-02', idempotencyKey: 'd' });
  assert.equal(draft.ok, true, JSON.stringify(draft));
  assert.deepEqual(
    draft.lines.map((l) => l.assetNumber),
    ['FA-0100', 'FA-0200', 'FA-0300'],
    'the create answers in register order, whatever the line ids happen to be',
  );
  assert.deepEqual(draft.lines.map((l) => l.assetId), [first, second, third]);

  // And the same on the read path, which is what the detail drawer and OP11 reconciliation walk.
  assert.equal(assetDepreciationRunPost(ctxScrambled, { runId: draft.run.id, idempotencyKey: 'p' }).ok, true);
  const got = assetDepreciationRunGet(ctxScrambled, { runId: draft.run.id });
  assert.deepEqual(
    got.lines.map((l) => l.assetNumber),
    ['FA-0100', 'FA-0200', 'FA-0300'],
    'and get answers in register order too',
  );
});

// --- Posting granularity: what the GL carries ---------------------------------------------------

test('SUMMARISED granularity collapses the GL to one pair per account and cost centre, sub-ledger intact', () => {
  const { ctx, store, workspaceId, acc, category, activeAsset } = setup();
  const cc = createCostCenter(ctx, { workspaceId, code: 'CC1', name: 'Produktion' });
  assert.equal(cc.ok, true);
  // Three assets: two under a category that books to CC1, one under a category with no cost centre.
  const shared = { defaultCostCenterId: cc.costCenterId };
  const catCc = category(shared);
  const a1 = activeAsset({ categoryId: catCc.id });
  const a2 = activeAsset({ categoryId: catCc.id });
  const a3 = activeAsset();

  const draft = assetDepreciationRunCreate(ctx, { period: '2026-02', postingGranularity: 'summarised', idempotencyKey: 'd' });
  assert.equal(draft.ok, true, JSON.stringify(draft));
  assert.equal(draft.run.postingGranularity, 'summarised');
  assert.equal(draft.lines.length, 3, 'the sub-ledger keeps one line per asset whatever the GL does');
  assert.equal(draft.run.totalAmountRappen, 300_000);

  const posted = assetDepreciationRunPost(ctx, { runId: draft.run.id, idempotencyKey: 'p' });
  assert.equal(posted.ok, true, JSON.stringify(posted));

  const glLines = store.db
    .prepare('SELECT account_id, debit_minor, credit_minor, cost_center_id FROM journal_line WHERE entry_id = ? ORDER BY id')
    .all(posted.journalEntryId);
  // Detailed would be six lines (a pair per asset). Summarised is four: one pair for the CC1 group,
  // one pair for the group with no cost centre.
  assert.equal(glLines.length, 4, `one pair per (account, cost centre): ${JSON.stringify(glLines)}`);
  const debit = glLines.reduce((s, l) => s + l.debit_minor, 0);
  const credit = glLines.reduce((s, l) => s + l.credit_minor, 0);
  assert.equal(debit, credit, 'still balanced');
  assert.equal(debit, 300_000, 'and still the run total');
  const inCc = glLines.filter((l) => l.cost_center_id === cc.costCenterId);
  assert.equal(inCc.length, 2, 'the two CC1 assets collapsed into one Dr/Cr pair');
  assert.equal(inCc.find((l) => l.account_id === acc('6800')).debit_minor, 200_000, 'their amounts are summed, not lost');
  assert.equal(inCc.find((l) => l.account_id === acc('1510')).credit_minor, 200_000);
  const noCc = glLines.filter((l) => l.cost_center_id === null);
  assert.equal(noCc.length, 2);
  assert.equal(noCc.find((l) => l.account_id === acc('6800')).debit_minor, 100_000);

  // The per-asset audit trail is untouched: one sub-ledger movement each, and every asset advanced.
  assert.equal(deprTxnCount(store, workspaceId), 3, 'one asset_transaction per asset, as in detailed');
  for (const id of [a1, a2, a3]) {
    const asset = getAsset(ctx, { assetId: id }).asset;
    assert.equal(asset.accumulatedDeprRappen, 100_000);
    assert.equal(asset.netBookValueRappen, asset.acquisitionCostRappen - asset.accumulatedDeprRappen);
    assert.equal(asset.lastDepreciationPeriod, '2026-02');
  }
});

// --- Selection filters ------------------------------------------------------------------------

test('a cost-centre filter narrows the run to assets whose category books there', () => {
  const { ctx, workspaceId, acc, category, activeAsset } = setup();
  const cc = createCostCenter(ctx, { workspaceId, code: 'CC1', name: 'Produktion' });
  assert.equal(cc.ok, true);
  // One asset under a category that books to CC1, one under a category with no cost centre.
  const inCc = activeAsset({}, { defaultCostCenterId: cc.costCenterId });
  activeAsset(); // no cost centre on its category
  void inCc;

  // Filtered to CC1: only the one asset whose category defaults to CC1 is in the run.
  const filtered = assetDepreciationRunCreate(ctx, { period: '2026-02', costCenterId: cc.costCenterId, idempotencyKey: 'cc' });
  assert.equal(filtered.ok, true, JSON.stringify(filtered));
  assert.equal(filtered.run.assetCount, 1, 'only the CC1 asset is in the filtered run');

  // A cost centre no category uses yields an empty run (the filter really excludes).
  const none = assetDepreciationRunCreate(ctx, { period: '2026-02', costCenterId: 'cc_absent', idempotencyKey: 'ccnone' });
  assert.equal(none.ok, true);
  assert.equal(none.empty, true);
});

// --- Input validation -------------------------------------------------------------------------

test('run_list takes a status ARRAY on both wire faces, as its own description promises', () => {
  const deps = freshDeps();
  const { workspaceId, accId } = mintWorkspace(deps);
  const cat = getAction('asset_category_create').run(deps, {
    workspaceId,
    code: 'MACH',
    name: 'Maschinen',
    depreciationMethod: 'straight_line',
    usefulLifeMonths: 12,
    glAssetAccountId: accId('1500'),
    glAccumDeprAccountId: accId('1510'),
    glDeprExpenseAccountId: accId('6800'),
    idempotencyKey: 'cat',
  });
  const asset = getAction('asset_create').run(deps, {
    workspaceId,
    categoryId: cat.category.id,
    name: 'Fräse',
    acquisitionDate: '2026-01-10',
    acquisitionCostRappen: 1_200_000,
    idempotencyKey: 'as',
  });
  getAction('asset_acquire').run(deps, {
    workspaceId,
    assetId: asset.asset.id,
    date: '2026-01-10',
    acquisitionCostRappen: 1_200_000,
    creditAccountId: accId('1020'),
    idempotencyKey: 'acq',
  });
  const draft = getAction('asset_depreciation_run_create').run(deps, { workspaceId, period: '2026-02', idempotencyKey: 'd' });
  assert.equal(draft.ok, true, JSON.stringify(draft));

  // The engine has always handled an array; the tool schema declared a bare string, so the dispatcher
  // rejected one before the verb ever ran, on both faces, while the description promised it worked.
  const input = { workspaceId, status: ['draft', 'posted'] };
  const viaMcp = JSON.parse(callTool(deps, 'asset_depreciation_run_list', input).content[0].text);
  assert.equal(viaMcp.ok, true, `a status array must reach the verb: ${JSON.stringify(viaMcp)}`);
  assert.equal(viaMcp.runs.length, 1);
  const viaRest = handleRest('asset_depreciation_run_list', input, deps).body;
  assert.deepEqual(viaMcp, viaRest, 'both faces answer identically');

  // A single string still works, and a filter that matches nothing still returns nothing.
  assert.equal(JSON.parse(callTool(deps, 'asset_depreciation_run_list', { workspaceId, status: 'draft' }).content[0].text).runs.length, 1);
  assert.equal(
    JSON.parse(callTool(deps, 'asset_depreciation_run_list', { workspaceId, status: ['reversed'] }).content[0].text).runs.length,
    0,
  );
  // And the promise is on the schema, not only in prose.
  const declared = getAction('asset_depreciation_run_list').inputSchema.properties.status;
  assert.ok(declared !== undefined && declared.anyOf !== undefined, 'status declares both shapes');
});

test('validation: an invalid period, a missing key and a bad granularity are structured rejections', () => {
  const { ctx, activeAsset } = setup();
  activeAsset();
  assert.equal(assetDepreciationRunCreate(ctx, { period: 'nope', idempotencyKey: 'k' }).error, 'invalid_period');
  assert.equal(assetDepreciationRunCreate(ctx, { period: '2026-02' }).error, 'invalid_input');
  assert.equal(
    assetDepreciationRunCreate(ctx, { period: '2026-02', postingGranularity: 'weird', idempotencyKey: 'k' }).error,
    'invalid_input',
  );
  assert.equal(assetDepreciationRunPost(ctx, { idempotencyKey: 'k' }).error, 'invalid_input');
  assert.equal(assetDepreciationRunPost(ctx, { runId: 'nope', idempotencyKey: 'k' }).error, 'not_found');
});
