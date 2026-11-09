// H07, Asset Ledger & Reconciliation: the OP11 money-path invariants a NON-AUTHOR critic mutation-tests,
// plus the §2 ledger reads and the one opening-balance write. H07 is primarily a DERIVED read over the
// existing append-only asset_transaction sub-ledger (H02 acquisition, H04 depreciation, H06 disposal), so
// the load-bearing assertions must BITE:
//
//   1. THE OP11 IDENTITY. For every control account the fixed-asset sub-ledger uses, the sub-ledger total
//      EQUALS the posted GL balance of that account at every cut-off. Proven three ways at once: the
//      report's sub-ledger total, its GL balance, and an INDEPENDENT SQL sum of base_debit/base_credit are
//      all the same number, and the delta is 0. The test drives a full acquire -> depreciate -> dispose
//      chain across two assets sharing one cost and one accumulated-depreciation control account.
//   2. DRIFT DETECTION (US-H07.6). A journal posted DIRECTLY against a control account with no backing
//      asset_transaction moves the GL but not the sub-ledger, so the delta is non-zero, the account is
//      `drift`, and the hard check returns the structured reconciliation_drift error naming it. This is
//      what proves invariant 1 is not vacuous: the recon can tell balanced from broken.
//   3. DISPOSAL CUT-OFF. An asset disposed on or before the cut-off contributes 0 to both sides (its
//      disposal cleared them) and drops out of the drill-down, while a cut-off BEFORE the disposal still
//      carries its cost and stays balanced.
//   4. THE LEDGER (US-H07.1). assetLedgerGet returns every event in effective-date order with the running
//      cost / accumulated / NBV after each; the final NBV of a disposed asset is 0; every event names its
//      journal. assetLedgerList filters by type / date / journal and paginates.
//   5. THE OPENING BALANCE (US-H07.5). It posts ONE balanced journal (Dr cost, Cr accumulated, Cr offset
//      equity) + ONE append-only type=opening row, is IDEMPOTENT ON ROWS (a replay posts one journal and
//      writes one row, proven by counts), reconciles for the opening period, and is §H-TENANT / guarded.

import test from 'node:test';
import assert from 'node:assert/strict';

import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { makeContext } from '../../dist/core/context.js';
import { fixedClock } from '../../dist/core/clock.js';
import { sequenceIdGen } from '../../dist/core/ids.js';
import { createWorkspace } from '../../dist/core/setup/index.js';
import { postEntry, ledgerPorts } from '../../dist/core/ledger/index.js';
import {
  createAssetCategory,
  createAsset,
  assetAcquire,
  assetAddCapitalisation,
  assetDepreciationRunCreate,
  assetDepreciationRunPost,
  assetDispose,
  assetLedgerGet,
  assetLedgerList,
  assetOpeningBalance,
  assetReconciliationReport,
  assetReconciliationCheck,
} from '../../dist/core/assets/index.js';

const AT = '2026-08-16T00:00:00.000Z';

function setup() {
  const clock = fixedClock(AT);
  const ids = sequenceIdGen();
  const store = new SqliteStore({ clock });
  const deps = { store, clock, ids };
  const workspaceId = createWorkspace(deps, { name: 'Acme AG' }).workspaceId;
  // The REAL PeriodPort + AuditPort so §H-PERIOD actually bites.
  const ctx = makeContext(store, { workspaceId, actor: 'user_1', clock, ids, ...ledgerPorts({ store, workspaceId, ids }) });
  const acc = (number) =>
    store.db.prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?').get(workspaceId, number).id;

  const category = () => {
    const cat = createAssetCategory(ctx, {
      code: `MACH-${Math.random().toString(36).slice(2, 7)}`,
      name: 'Maschinen',
      depreciationMethod: 'straight_line',
      usefulLifeMonths: 12,
      glAssetAccountId: acc('1500'),
      glAccumDeprAccountId: acc('1510'),
      glDeprExpenseAccountId: acc('6800'),
      idempotencyKey: `cat-${Math.random()}`,
    });
    assert.equal(cat.ok, true, JSON.stringify(cat));
    return cat.category.id;
  };

  const draftAsset = (cost, categoryId = category(), over = {}) => {
    const asset = createAsset(ctx, {
      categoryId,
      name: 'CNC Fräsmaschine',
      acquisitionDate: '2026-01-10',
      acquisitionCostRappen: cost,
      idempotencyKey: `as-${Math.random()}`,
      ...over,
    });
    assert.equal(asset.ok, true, JSON.stringify(asset));
    return asset.asset.id;
  };

  const activeAsset = (cost, categoryId = category()) => {
    const id = draftAsset(cost, categoryId);
    const acq = assetAcquire(ctx, {
      assetId: id,
      date: '2026-01-10',
      acquisitionCostRappen: cost,
      creditAccountId: acc('1020'),
      idempotencyKey: `acq-${Math.random()}`,
    });
    assert.equal(acq.ok, true, JSON.stringify(acq));
    return id;
  };

  const depreciate = (assetId, period) => {
    const draft = assetDepreciationRunCreate(ctx, { period, assetIds: [assetId], idempotencyKey: `dr-${Math.random()}` });
    assert.equal(draft.ok, true, JSON.stringify(draft));
    const posted = assetDepreciationRunPost(ctx, { runId: draft.run.id, idempotencyKey: `dp-${Math.random()}` });
    assert.equal(posted.ok, true, JSON.stringify(posted));
  };

  return { ctx, store, workspaceId, deps, clock, ids, acc, category, draftAsset, activeAsset, depreciate };
}

/** The INDEPENDENT GL balance of an account at a cut-off, over posted entries, in base currency. Debit
 * balance for a cost account, credit balance for an accumulated-depreciation account. This is the
 * reconciliation's own query re-derived in the test, so agreement is a real cross-check, not a tautology. */
function glBalance(store, ws, accountId, cutOff, side) {
  const expr = side === 'debit' ? 'l.base_debit_minor - l.base_credit_minor' : 'l.base_credit_minor - l.base_debit_minor';
  return store.db
    .prepare(
      `SELECT COALESCE(SUM(${expr}), 0) AS bal
         FROM journal_line l JOIN journal_entry e ON e.id = l.entry_id
        WHERE e.status = 'posted' AND e.workspace_id = ? AND l.account_id = ? AND e.date <= ?`,
    )
    .get(ws, accountId, cutOff).bal;
}

const journalCount = (store, ws) =>
  store.db.prepare("SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ? AND status = 'posted'").get(ws).n;
const openingRowCount = (store, ws) =>
  store.db.prepare("SELECT COUNT(*) AS n FROM asset_transaction WHERE workspace_id = ? AND type = 'opening'").get(ws).n;

// --- INVARIANT 1: the OP11 identity BITES ---------------------------------------------------------

test('OP11: after acquire -> depreciate -> dispose, every control account reconciles to the GL exactly', () => {
  const { ctx, store, workspaceId, acc, category, activeAsset, depreciate } = setup();
  const cat = category();
  const a = activeAsset(1_200_000, cat); // shares 1500 / 1510 with b
  const b = activeAsset(600_000, cat);
  depreciate(a, '2026-02'); // a: accum 100'000
  depreciate(b, '2026-02'); // b: accum 50'000
  assetAddCapitalisation(ctx, {
    assetId: a,
    date: '2026-03-01',
    amountRappen: 300_000,
    creditAccountId: acc('1020'),
    idempotencyKey: `cap-${Math.random()}`,
  });
  // Dispose b (proceeds below NBV), so its cost + accum are cleared on both sides.
  const disp = assetDispose(ctx, {
    assetId: b,
    disposalDate: '2026-06-15',
    proceedsRappen: 400_000,
    proceedsAccountId: acc('1020'),
    gainLossAccountId: acc('6900'),
    idempotencyKey: `disp-${Math.random()}`,
  });
  assert.equal(disp.ok, true, JSON.stringify(disp));

  const cutOff = '2026-12-31';
  const report = assetReconciliationReport(ctx, { asOf: cutOff });
  assert.equal(report.ok, true, JSON.stringify(report));
  assert.equal(report.summary.status, 'balanced', 'the whole workspace reconciles');
  assert.equal(report.summary.driftCount, 0);

  const cost = report.accounts.find((r) => r.accountNumber === '1500' && r.role === 'cost');
  const accum = report.accounts.find((r) => r.accountNumber === '1510' && r.role === 'accumulated_depreciation');
  assert.ok(cost && accum, 'both control accounts appear');

  // The identity, THREE ways: sub-ledger == report GL == independent SQL GL, and delta 0.
  const glCost = glBalance(store, workspaceId, acc('1500'), cutOff, 'debit');
  const glAccum = glBalance(store, workspaceId, acc('1510'), cutOff, 'credit');
  assert.equal(cost.subLedgerRappen, cost.glBalanceRappen, 'cost: sub-ledger == report GL');
  assert.equal(cost.glBalanceRappen, glCost, 'cost: report GL == independent GL');
  assert.equal(cost.deltaRappen, 0, 'cost: delta is zero');
  assert.equal(accum.subLedgerRappen, accum.glBalanceRappen, 'accum: sub-ledger == report GL');
  assert.equal(accum.glBalanceRappen, glAccum, 'accum: report GL == independent GL');
  assert.equal(accum.deltaRappen, 0, 'accum: delta is zero');

  // And the numbers are the ones we expect: cost = a(1.2m + 0.3m cap) since b was disposed to 0;
  // accum = a's 100'000 (b's accum cleared on disposal).
  assert.equal(cost.subLedgerRappen, 1_500_000, 'only the surviving asset a carries cost');
  assert.equal(accum.subLedgerRappen, 100_000, 'only a carries accumulated depreciation');

  // The hard check agrees.
  const check = assetReconciliationCheck(ctx, { period: '2026-12' });
  assert.equal(check.ok, true, JSON.stringify(check));
  assert.equal(check.status, 'balanced');
});

// --- INVARIANT 2: drift detection (proves invariant 1 is not vacuous) -----------------------------

test('OP11: a direct GL post to a control account with no asset_transaction shows as drift and fails the check', () => {
  const { ctx, store, workspaceId, acc, activeAsset } = setup();
  activeAsset(1_200_000);

  // A rogue balanced entry that debits the asset COST control account 1500 with NO backing asset event.
  const rogue = postEntry(ctx, {
    date: '2026-05-01',
    source: 'manual',
    description: 'rogue cost posting',
    idempotencyKey: `rogue-${Math.random()}`,
    lines: [
      { account: acc('1500'), debit: 250_000 },
      { account: acc('1020'), credit: 250_000 },
    ],
  });
  assert.equal(rogue.ok, true, JSON.stringify(rogue));

  const report = assetReconciliationReport(ctx, { asOf: '2026-12-31' });
  assert.equal(report.ok, true, JSON.stringify(report));
  const cost = report.accounts.find((r) => r.accountNumber === '1500' && r.role === 'cost');
  assert.equal(cost.status, 'drift', 'the rogue post drifts the cost account');
  assert.equal(cost.subLedgerRappen, 1_200_000, 'the sub-ledger is unchanged by the rogue post');
  assert.equal(cost.glBalanceRappen, 1_450_000, 'the GL carries the extra rogue debit');
  assert.equal(cost.deltaRappen, -250_000, 'the delta is exactly the un-backed posting');
  assert.equal(report.summary.status, 'drift');

  const check = assetReconciliationCheck(ctx, { period: '2026-12' });
  assert.equal(check.ok, false, 'the hard check fails on drift');
  assert.equal(check.error, 'reconciliation_drift');
  assert.ok(check.accounts.some((a) => a.accountNumber === '1500'), 'the drift names the offending account');
});

// --- INVARIANT 3: disposal cut-off -----------------------------------------------------------------

test('a disposed asset drops out of open totals after the cut-off but is present before it', () => {
  const { ctx, acc, activeAsset } = setup();
  const id = activeAsset(1_200_000);
  const disp = assetDispose(ctx, {
    assetId: id,
    disposalDate: '2026-06-15',
    proceedsRappen: 1_300_000,
    proceedsAccountId: acc('1020'),
    gainLossAccountId: acc('6900'),
    idempotencyKey: `disp-${Math.random()}`,
  });
  assert.equal(disp.ok, true, JSON.stringify(disp));

  // BEFORE the disposal: the asset's cost is still on the books, and it reconciles.
  const before = assetReconciliationReport(ctx, { asOf: '2026-05-31' });
  const costBefore = before.accounts.find((r) => r.accountNumber === '1500' && r.role === 'cost');
  assert.equal(costBefore.subLedgerRappen, 1_200_000, 'cost present before disposal');
  assert.equal(costBefore.deltaRappen, 0, 'balanced before disposal');
  assert.ok(costBefore.assets.some((a) => a.assetId === id), 'the asset is in the drill-down before disposal');

  // AFTER the disposal: it contributes 0 to both sides and leaves the drill-down.
  const after = assetReconciliationReport(ctx, { asOf: '2026-07-31' });
  const costAfter = after.accounts.find((r) => r.accountNumber === '1500' && r.role === 'cost');
  assert.equal(costAfter.subLedgerRappen, 0, 'cost cleared after disposal');
  assert.equal(costAfter.deltaRappen, 0, 'still balanced after disposal');
  assert.equal(costAfter.assets.some((a) => a.assetId === id), false, 'the disposed asset leaves the drill-down');
});

// --- INVARIANT 4: the ledger ----------------------------------------------------------------------

test('assetLedgerGet returns every event in order with running cost / accumulated / NBV and journal links', () => {
  const { ctx, acc, activeAsset, depreciate } = setup();
  const id = activeAsset(1_200_000);
  depreciate(id, '2026-02'); // accum 100'000
  const disp = assetDispose(ctx, {
    assetId: id,
    disposalDate: '2026-06-15',
    proceedsRappen: 900_000,
    proceedsAccountId: acc('1020'),
    gainLossAccountId: acc('6900'),
    idempotencyKey: `disp-${Math.random()}`,
  });
  assert.equal(disp.ok, true, JSON.stringify(disp));

  const led = assetLedgerGet(ctx, { assetId: id });
  assert.equal(led.ok, true, JSON.stringify(led));
  assert.equal(led.events.length, 3, 'acquisition, depreciation, disposal');
  const [acq, dep, dis] = led.events;

  assert.equal(acq.type, 'acquisition');
  assert.equal(acq.costAfterRappen, 1_200_000);
  assert.equal(acq.accumulatedDeprAfterRappen, 0);
  assert.equal(acq.netBookValueAfterRappen, 1_200_000);

  assert.equal(dep.type, 'depreciation');
  assert.equal(dep.deltaAccumDeprRappen, 100_000, 'depreciation moves accumulated, not cost');
  assert.equal(dep.deltaCostRappen, 0);
  assert.equal(dep.accumulatedDeprAfterRappen, 100_000);
  assert.equal(dep.netBookValueAfterRappen, 1_100_000);

  assert.equal(dis.type, 'disposal');
  assert.equal(dis.costAfterRappen, 0, 'cost returns to zero on disposal');
  assert.equal(dis.accumulatedDeprAfterRappen, 0, 'accumulated returns to zero on disposal');
  assert.equal(dis.netBookValueAfterRappen, 0, 'a disposed asset ends at NBV 0');

  // Every event names the journal it posted.
  assert.ok(led.events.every((e) => typeof e.journalEntryId === 'string' && e.journalEntryId.length > 0));
});

test('assetLedgerList filters by type, date window and journal, and paginates', () => {
  const { ctx, acc, activeAsset, depreciate } = setup();
  const id = activeAsset(1_200_000);
  depreciate(id, '2026-02');
  depreciate(id, '2026-03');

  const all = assetLedgerList(ctx, { assetId: id });
  assert.equal(all.ok, true, JSON.stringify(all));
  assert.equal(all.total, 3, 'acquisition + two depreciation rows');

  const depOnly = assetLedgerList(ctx, { assetId: id, type: 'depreciation' });
  assert.equal(depOnly.total, 2, 'two depreciation events');
  assert.ok(depOnly.items.every((e) => e.type === 'depreciation'));

  const windowed = assetLedgerList(ctx, { assetId: id, type: ['depreciation'], fromDate: '2026-03-01', toDate: '2026-03-31' });
  assert.equal(windowed.total, 1, 'one depreciation row in March');

  const byJournal = assetLedgerList(ctx, { journalEntryId: depOnly.items[0].journalEntryId });
  assert.equal(byJournal.total, 1, 'the journal filter isolates one event');

  const page = assetLedgerList(ctx, { assetId: id, limit: 1 });
  assert.equal(page.items.length, 1, 'a limit caps the page');
  assert.equal(page.total, 3, 'but the total still counts every matching row');

  const bad = assetLedgerList(ctx, { assetId: id, type: 'nonsense' });
  assert.equal(bad.ok, false, 'an unknown type is invalid_input, never a silent empty result');
  assert.equal(bad.error, 'invalid_input');
});

// --- INVARIANT 5: the opening balance -------------------------------------------------------------

test('assetOpeningBalance posts one balanced opening journal, seeds the baseline, and reconciles', () => {
  const { ctx, store, workspaceId, acc, draftAsset } = setup();
  const id = draftAsset(4_000_000);

  const before = journalCount(store, workspaceId);
  const r = assetOpeningBalance(ctx, {
    assetId: id,
    date: '2026-01-01',
    costRappen: 4_000_000,
    accumulatedDeprRappen: 1_500_000,
    offsetAccountId: acc('2979'),
    idempotencyKey: 'open-1',
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.transaction.type, 'opening');
  assert.equal(r.asset.status, 'active', 'the asset leaves draft');
  assert.equal(r.asset.acquisitionCostRappen, 4_000_000);
  assert.equal(r.asset.accumulatedDeprRappen, 1_500_000);
  assert.equal(r.asset.netBookValueRappen, 2_500_000);

  // The journal is balanced: Dr 1500 cost, Cr 1510 accum, Cr 2979 the net book value.
  const lines = r.journalEntry.lines;
  assert.equal(lines.reduce((s, l) => s + l.debit, 0), lines.reduce((s, l) => s + l.credit, 0), 'balanced');
  assert.equal(lines.find((l) => l.account === acc('1500')).debit, 4_000_000, 'Dr the cost account');
  assert.equal(lines.find((l) => l.account === acc('1510')).credit, 1_500_000, 'Cr the accumulated account');
  assert.equal(lines.find((l) => l.account === acc('2979')).credit, 2_500_000, 'Cr the offset for the NBV');
  assert.equal(journalCount(store, workspaceId), before + 1, 'exactly one journal posted');

  // It reconciles for the opening period, on BOTH control accounts.
  const report = assetReconciliationReport(ctx, { period: '2026-01' });
  assert.equal(report.summary.status, 'balanced', 'the opening reconciles');
  const cost = report.accounts.find((r) => r.accountNumber === '1500' && r.role === 'cost');
  const accum = report.accounts.find((r) => r.accountNumber === '1510' && r.role === 'accumulated_depreciation');
  assert.equal(cost.subLedgerRappen, 4_000_000);
  assert.equal(cost.deltaRappen, 0);
  assert.equal(accum.subLedgerRappen, 1_500_000);
  assert.equal(accum.deltaRappen, 0);
});

test('assetOpeningBalance is idempotent on ROWS: a replay posts one journal and writes one opening row', () => {
  const { ctx, store, workspaceId, acc, draftAsset } = setup();
  const id = draftAsset(4_000_000);
  const input = {
    assetId: id,
    date: '2026-01-01',
    costRappen: 4_000_000,
    accumulatedDeprRappen: 1_500_000,
    offsetAccountId: acc('2979'),
    idempotencyKey: 'open-replay',
  };
  const first = assetOpeningBalance(ctx, input);
  assert.equal(first.ok, true, JSON.stringify(first));
  const journalsAfterFirst = journalCount(store, workspaceId);
  const second = assetOpeningBalance(ctx, input);
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(second.transaction.id, first.transaction.id, 'the replay returns the original row');
  assert.equal(journalCount(store, workspaceId), journalsAfterFirst, 'no second journal is posted');
  assert.equal(openingRowCount(store, workspaceId), 1, 'exactly one opening row exists');
});

test('a fully-depreciated opening (cost == accumulated) writes no offset line and needs no offset account', () => {
  const { ctx, acc, draftAsset } = setup();
  const id = draftAsset(1_000_000);
  const r = assetOpeningBalance(ctx, {
    assetId: id,
    date: '2026-01-01',
    costRappen: 1_000_000,
    accumulatedDeprRappen: 1_000_000,
    idempotencyKey: 'open-full',
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.asset.netBookValueRappen, 0);
  const lines = r.journalEntry.lines;
  assert.equal(lines.length, 2, 'only Dr cost and Cr accumulated');
  assert.equal(lines.some((l) => l.account === acc('2979')), false, 'no offset line when NBV is zero');
});

test('assetOpeningBalance guards: already opened, already acquired, missing offset, foreign asset', () => {
  const { ctx, acc, draftAsset, activeAsset } = setup();
  const id = draftAsset(4_000_000);
  const first = assetOpeningBalance(ctx, {
    assetId: id,
    date: '2026-01-01',
    costRappen: 4_000_000,
    accumulatedDeprRappen: 1_000_000,
    offsetAccountId: acc('2979'),
    idempotencyKey: 'open-a',
  });
  assert.equal(first.ok, true, JSON.stringify(first));
  // A second opening on the same asset (a different key) is refused.
  const again = assetOpeningBalance(ctx, {
    assetId: id,
    date: '2026-01-01',
    costRappen: 4_000_000,
    accumulatedDeprRappen: 1_000_000,
    offsetAccountId: acc('2979'),
    idempotencyKey: 'open-b',
  });
  assert.equal(again.ok, false);
  assert.equal(again.error, 'already_opened');

  // An already-acquired asset cannot be opened.
  const acquired = activeAsset(500_000);
  const onAcquired = assetOpeningBalance(ctx, {
    assetId: acquired,
    date: '2026-01-01',
    costRappen: 500_000,
    accumulatedDeprRappen: 0,
    offsetAccountId: acc('2979'),
    idempotencyKey: 'open-c',
  });
  assert.equal(onAcquired.ok, false);
  assert.equal(onAcquired.error, 'already_acquired');

  // Missing offset when NBV > 0.
  const noOffset = assetOpeningBalance(ctx, {
    assetId: draftAsset(2_000_000),
    date: '2026-01-01',
    costRappen: 2_000_000,
    accumulatedDeprRappen: 0,
    idempotencyKey: 'open-d',
  });
  assert.equal(noOffset.ok, false);
  assert.equal(noOffset.error, 'invalid_offset_account');

  // A foreign asset id is not_found.
  const foreign = assetOpeningBalance(ctx, {
    assetId: 'asset_does_not_exist',
    date: '2026-01-01',
    costRappen: 1_000_000,
    accumulatedDeprRappen: 0,
    offsetAccountId: acc('2979'),
    idempotencyKey: 'open-e',
  });
  assert.equal(foreign.ok, false);
  assert.equal(foreign.error, 'not_found');
});

// --- EXACTLY-ONE-OPENING: the structural race guard (mirrors H06 disposal, H02 acquisition) ---------
// An opening balance seeds a pre-existing asset's carrying cost. The "exactly one baseline per asset"
// promise must NOT rest on financialEventExists' out-of-tx read: under D12's supported concurrent-writer
// topology (Studio + a till mcp subprocess on one SQLite file) two writers can both read a null baseline
// before either commits, both seat an opening row and post a journal, and cost is DOUBLE-CAPITALISED
// silently, because OP11 reconciliation still reports balanced when both the sub-ledger and the GL move.
// The guard is now structural, mirroring the acquisition / disposal precedents: a partial unique index
// that rejects a second opening row at the DB layer, and an in-transaction guarded UPDATE that aborts a
// stale writer with already_opened before the index would even fire. A true two-process race is not
// reproducible in synchronous better-sqlite3, so these assert the structural guarantees directly.

const assetStatusOf = (store, ws, id) =>
  store.db.prepare('SELECT status FROM asset WHERE workspace_id = ? AND id = ?').get(ws, id).status;

test('the partial unique index exists and REJECTS a second opening row for an already-opened asset', () => {
  const { ctx, store, workspaceId, acc, draftAsset } = setup();
  const id = draftAsset(4_000_000);
  const r = assetOpeningBalance(ctx, {
    assetId: id,
    date: '2026-01-01',
    costRappen: 4_000_000,
    accumulatedDeprRappen: 1_500_000,
    offsetAccountId: acc('2979'),
    idempotencyKey: 'open-idx',
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(openingRowCount(store, workspaceId), 1, 'the first opening seated exactly one row');

  // The guard is a real, PARTIAL unique index scoped to opening rows (not the whole table).
  const idx = store.db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'asset_transaction_one_opening'")
    .get();
  assert.ok(idx, 'asset_transaction_one_opening index is present');
  assert.match(idx.sql, /UNIQUE/i, 'the one-opening index is UNIQUE');
  assert.match(idx.sql, /WHERE\s+type\s*=\s*'opening'/i, 'it is a PARTIAL index over opening rows only');

  // A second opening row for the SAME (workspace, asset), inserted straight against the store (the shape
  // a racing second writer would attempt), is refused by the unique index. Reusing the first opening's
  // journal_entry_id keeps the NOT NULL foreign key satisfiable, so the ONLY thing that can reject the
  // row is the one-opening guard.
  assert.throws(
    () =>
      store.db
        .prepare(
          `INSERT INTO asset_transaction (
             id, workspace_id, asset_id, type, date, delta_cost_rappen, delta_accum_depr_rappen,
             proceeds_rappen, gain_loss_rappen, journal_entry_id, created_at
           ) VALUES (?, ?, ?, 'opening', ?, ?, ?, NULL, NULL, ?, ?)`,
        )
        .run('atxn_dup_opening', workspaceId, id, '2026-01-01', 4_000_000, 1_500_000, r.transaction.journalEntryId, AT),
    /UNIQUE constraint failed|asset_transaction_one_opening/i,
    'a second opening row for the same asset must be rejected by the unique index',
  );
  assert.equal(openingRowCount(store, workspaceId), 1, 'still exactly one opening row after the rejected insert');
});

test('the guarded UPDATE bites: a stale writer touches 0 rows and the second opening aborts cleanly', () => {
  const { ctx, store, workspaceId, acc, draftAsset } = setup();
  const id = draftAsset(4_000_000);
  const before = journalCount(store, workspaceId);
  const first = assetOpeningBalance(ctx, {
    assetId: id,
    date: '2026-01-01',
    costRappen: 4_000_000,
    accumulatedDeprRappen: 1_500_000,
    offsetAccountId: acc('2979'),
    idempotencyKey: 'open-guard',
  });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(assetStatusOf(store, workspaceId, id), 'active', 'the opening moved the asset out of draft');

  // The in-transaction guard is the baseline UPDATE's `WHERE ... AND status = 'draft'`: once the asset is
  // baselined (by an opening OR a concurrent acquisition) it is no longer draft, so that exact UPDATE
  // touches 0 rows, which is the condition the engine turns into an OpeningAbort(already_opened). Run the
  // guarded statement directly to prove the WHERE clause bites (the mechanism a racing second writer hits
  // inside its own transaction, before the one-opening index would even fire).
  const moved = store.db
    .prepare(
      `UPDATE asset SET status = 'active', acquisition_date = ?, acquisition_cost_rappen = ?,
              accumulated_depr_rappen = ?, net_book_value_rappen = ?, updated_at = ?
         WHERE workspace_id = ? AND id = ? AND status = 'draft'`,
    )
    .run('2026-01-01', 4_000_000, 1_500_000, 2_500_000, AT, workspaceId, id);
  assert.equal(moved.changes, 0, 'the guarded baseline UPDATE touches 0 rows once the asset is no longer draft');

  // End to end: a second engine opening with a different key is refused with already_opened and writes
  // NOTHING more (no second journal, no second opening row, the asset stays baselined exactly once).
  const again = assetOpeningBalance(ctx, {
    assetId: id,
    date: '2026-01-01',
    costRappen: 4_000_000,
    accumulatedDeprRappen: 1_500_000,
    offsetAccountId: acc('2979'),
    idempotencyKey: 'open-guard-2',
  });
  assert.equal(again.ok, false);
  assert.equal(again.error, 'already_opened');
  assert.equal(journalCount(store, workspaceId) - before, 1, 'only the first opening posted a journal');
  assert.equal(openingRowCount(store, workspaceId), 1, 'exactly one opening row survives the second attempt');
});

test('the guard catches the concurrent-ACQUISITION window the one-opening index alone would miss', () => {
  // The window the guarded UPDATE closes over the unique index: a concurrent writer that ACQUIRED the
  // asset (moving it to active, writing an acquisition row but NO opening row) between this opener's
  // out-of-tx financialEventExists read and its in-tx write. financialEventExists ran BEFORE that commit
  // and saw null; the one-opening index does not fire because there is no opening row; only the in-tx
  // `WHERE status = 'draft'` re-read catches it. Reproduced deterministically by flipping the asset to
  // active with no sub-ledger row, which is exactly the state that opener would observe on entry.
  const { ctx, store, workspaceId, acc, draftAsset } = setup();
  const id = draftAsset(4_000_000);
  const before = journalCount(store, workspaceId);
  // Simulate the raced-in acquisition's committed effect on the asset row (no asset_transaction row yet,
  // so financialEventExists still returns null on entry, and the asset.status guards at the top pass).
  store.db
    .prepare("UPDATE asset SET status = 'active', updated_at = ? WHERE workspace_id = ? AND id = ?")
    .run(AT, workspaceId, id);

  const r = assetOpeningBalance(ctx, {
    assetId: id,
    date: '2026-01-01',
    costRappen: 4_000_000,
    accumulatedDeprRappen: 1_500_000,
    offsetAccountId: acc('2979'),
    idempotencyKey: 'open-race',
  });
  // Without the in-tx guard this opener would seat a second baseline (INSERT opening row + post a journal)
  // on an already-active asset: a silent double-capitalisation. The guarded UPDATE's 0-change abort is the
  // ONLY thing that stops it here, so this assertion bites the `if (moved.changes === 0) throw`.
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.error, 'already_opened');
  assert.equal(journalCount(store, workspaceId) - before, 0, 'no opening journal is posted into the race');
  assert.equal(openingRowCount(store, workspaceId), 0, 'no opening row is seated into the race');
});

// --- CRITIC FINDING 1 (BLOCKER): an opened asset is a baseline, so it can neither be re-acquired ----
//     (which would double-book cost with a still-green recon) nor be refused a later capitalisation.

test('an opened asset cannot be re-acquired: the second primary acquisition is refused, no double-book', () => {
  const { ctx, store, workspaceId, acc, draftAsset } = setup();
  const id = draftAsset(1_000_000);
  const open = assetOpeningBalance(ctx, {
    assetId: id,
    date: '2026-01-01',
    costRappen: 1_000_000,
    accumulatedDeprRappen: 300_000,
    offsetAccountId: acc('2979'),
    idempotencyKey: 'open-x',
  });
  assert.equal(open.ok, true, JSON.stringify(open));

  const journalsBefore = journalCount(store, workspaceId);
  // The defect the critic found: acquire on top of an opening must be REFUSED (it was not, before the fix).
  const reAcquire = assetAcquire(ctx, {
    assetId: id,
    date: '2026-01-01',
    acquisitionCostRappen: 500_000,
    creditAccountId: acc('1020'),
    idempotencyKey: 'reacq-x',
  });
  assert.equal(reAcquire.ok, false, 'a primary acquisition on an opened asset is refused');
  assert.equal(reAcquire.error, 'already_acquired');
  assert.equal(journalCount(store, workspaceId), journalsBefore, 'nothing is posted by the refused re-acquire');

  // The sub-ledger still folds to the single opening baseline (no double-book), and it reconciles.
  const led = assetLedgerGet(ctx, { assetId: id });
  assert.equal(led.events.length, 1, 'only the opening event exists');
  assert.equal(led.events[0].costAfterRappen, 1_000_000, 'cost was not doubled');
  const report = assetReconciliationReport(ctx, { asOf: '2026-12-31' });
  assert.equal(report.summary.status, 'balanced');
});

test('an opened asset accepts a later additional capitalisation (a migrated asset is not frozen)', () => {
  const { ctx, acc, draftAsset } = setup();
  const id = draftAsset(1_000_000);
  const open = assetOpeningBalance(ctx, {
    assetId: id,
    date: '2026-01-01',
    costRappen: 1_000_000,
    accumulatedDeprRappen: 300_000,
    offsetAccountId: acc('2979'),
    idempotencyKey: 'open-y',
  });
  assert.equal(open.ok, true, JSON.stringify(open));
  const cap = assetAddCapitalisation(ctx, {
    assetId: id,
    date: '2026-03-01',
    amountRappen: 200_000,
    creditAccountId: acc('1020'),
    idempotencyKey: 'cap-y',
  });
  assert.equal(cap.ok, true, JSON.stringify(cap));
  const led = assetLedgerGet(ctx, { assetId: id });
  assert.equal(led.events.length, 2, 'opening + capitalisation');
  assert.equal(led.events[1].costAfterRappen, 1_200_000, 'cost rises by the capitalisation');
  assert.equal(assetReconciliationReport(ctx, { asOf: '2026-12-31' }).summary.status, 'balanced');
});

test('the opening offset account may not be a control account or a P&L account', () => {
  const { ctx, acc, draftAsset } = setup();
  // The asset uses 1500 cost / 1510 accum. Offsetting the NBV to either control account would author drift.
  const onCost = assetOpeningBalance(ctx, {
    assetId: draftAsset(1_000_000),
    date: '2026-01-01',
    costRappen: 1_000_000,
    accumulatedDeprRappen: 0,
    offsetAccountId: acc('1500'),
    idempotencyKey: 'off-cost',
  });
  assert.equal(onCost.ok, false);
  assert.equal(onCost.error, 'invalid_offset_account');

  const onAccum = assetOpeningBalance(ctx, {
    assetId: draftAsset(1_000_000),
    date: '2026-01-01',
    costRappen: 1_000_000,
    accumulatedDeprRappen: 0,
    offsetAccountId: acc('1510'),
    idempotencyKey: 'off-accum',
  });
  assert.equal(onAccum.ok, false);
  assert.equal(onAccum.error, 'invalid_offset_account');

  // A P&L (expense) account is not an opening position.
  const onExpense = assetOpeningBalance(ctx, {
    assetId: draftAsset(1_000_000),
    date: '2026-01-01',
    costRappen: 1_000_000,
    accumulatedDeprRappen: 0,
    offsetAccountId: acc('6800'),
    idempotencyKey: 'off-exp',
  });
  assert.equal(onExpense.ok, false);
  assert.equal(onExpense.error, 'invalid_offset_account');
});

// --- §H-TENANT ------------------------------------------------------------------------------------

test('the ledger and reconciliation never cross the workspace boundary', () => {
  const A = setup();
  const idA = A.activeAsset(1_200_000);

  // A second, independent workspace on the SAME store.
  const workspaceB = createWorkspace(A.deps, { name: 'Other AG', idempotencyKey: 'ws-b' }).workspaceId;
  const ctxB = makeContext(A.store, {
    workspaceId: workspaceB,
    actor: 'user_2',
    clock: A.clock,
    ids: A.ids,
    ...ledgerPorts({ store: A.store, workspaceId: workspaceB, ids: A.ids }),
  });

  // B cannot read A's ledger.
  const led = assetLedgerGet(ctxB, { assetId: idA });
  assert.equal(led.ok, false);
  assert.equal(led.error, 'not_found');

  // B's cross-asset list never returns A's rows.
  const list = assetLedgerList(ctxB, {});
  assert.equal(list.ok, true, JSON.stringify(list));
  assert.equal(list.total, 0, 'B sees none of A rows');

  // B's reconciliation is empty (B has no assets), and A's still holds A's asset only.
  const reconB = assetReconciliationReport(ctxB, { asOf: '2026-12-31' });
  assert.equal(reconB.ok, true, JSON.stringify(reconB));
  assert.equal(reconB.accounts.length, 0, 'B has no control accounts');

  const reconA = assetReconciliationReport(A.ctx, { asOf: '2026-12-31' });
  const costA = reconA.accounts.find((r) => r.accountNumber === '1500' && r.role === 'cost');
  assert.equal(costA.subLedgerRappen, 1_200_000, 'A still sees only its own asset');
});
