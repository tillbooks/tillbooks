// H06, Asset Disposal: the MONEY-PATH invariants a NON-AUTHOR critic mutation-tests, plus the full
// §2 validation set and the §7 tripwires. Disposal is a DUAL-LEDGER terminal event (a balanced A02
// journal clearing cost + accumulated depreciation and recognising proceeds and the book gain/loss,
// an append-only asset_transaction of type=disposal, and the asset moved to status=disposed), so the
// load-bearing money-path assertions must BITE:
//
//   1. BALANCED ENTRY + GAIN/LOSS SIGN. The posted journal debits accumulated depreciation and the
//      proceeds account, recognises the book loss (Dr) or gain (Cr) on the gain/loss account, and
//      credits the asset cost; debit total == credit total, and the SIGN of the gain/loss follows
//      proceeds - NBV (proceeds above NBV credits a gain, below NBV debits a loss).
//   2. IDEMPOTENT ON ROWS (§H-IDEMPOTENT). A replay of the same key posts EXACTLY ONE journal entry,
//      writes EXACTLY ONE asset_transaction row, and flips the status ONCE. Proven by ROW COUNTS.
//   3. APPEND-ONLY (§H-AUDIT). The disposal asset_transaction row is immutable at the DB layer: UPDATE
//      and DELETE both ABORT with asset_transaction_immutable. The journal entry is immutable too (A02).
//   4. §H-TENANT. A foreign workspace can neither dispose an asset it does not own, nor read its
//      disposal, and a foreign gain/loss or proceeds account never resolves.
//   5. PERIOD LOCK (§H-PERIOD). A disposal dated in a hard-locked period is refused and writes
//      NOTHING: no journal entry, no transaction, and the asset stays active.
//   6. TERMINAL STATE blocks depreciation (§H-ASSET). After a disposal, a depreciation run for a later
//      period excludes the asset, and asset_update refuses it with asset_terminal.

import test from 'node:test';
import assert from 'node:assert/strict';

import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { makeContext } from '../../dist/core/context.js';
import { fixedClock } from '../../dist/core/clock.js';
import { sequenceIdGen } from '../../dist/core/ids.js';
import { createWorkspace } from '../../dist/core/setup/index.js';
import { lockPeriod, ledgerPorts } from '../../dist/core/ledger/index.js';
import {
  createAssetCategory,
  createAsset,
  updateAsset,
  assetAcquire,
  assetDepreciationRunCreate,
  assetDepreciationRunPost,
  assetDispose,
  assetDisposalPreview,
  assetDisposalGet,
} from '../../dist/core/assets/index.js';

const AT = '2026-08-16T00:00:00.000Z';

function setup() {
  const clock = fixedClock(AT);
  const ids = sequenceIdGen();
  const store = new SqliteStore({ clock });
  const deps = { store, clock, ids };
  const workspaceId = createWorkspace(deps, { name: 'Acme AG' }).workspaceId;
  // The REAL PeriodPort + AuditPort, so §H-PERIOD actually bites (the permissive default would let a
  // locked-period disposal post).
  const ctx = makeContext(store, { workspaceId, actor: 'user_1', clock, ids, ...ledgerPorts({ store, workspaceId, ids }) });
  const acc = (number) =>
    store.db.prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?').get(workspaceId, number).id;

  // A live (active) asset ready to dispose: create FROM a straight-line category over 12 months, then
  // post the primary acquisition so it is `active` with accumulated depreciation 0 and NBV == cost.
  const activeAsset = (cost = 1_200_000, over = {}) => {
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
    const asset = createAsset(ctx, {
      categoryId: cat.category.id,
      name: 'CNC Fräsmaschine',
      acquisitionDate: '2026-01-10',
      acquisitionCostRappen: cost,
      idempotencyKey: `as-${Math.random()}`,
      ...over,
    });
    assert.equal(asset.ok, true, JSON.stringify(asset));
    const acq = assetAcquire(ctx, {
      assetId: asset.asset.id,
      date: '2026-01-10',
      acquisitionCostRappen: cost,
      creditAccountId: acc('1020'),
      idempotencyKey: `acq-${Math.random()}`,
    });
    assert.equal(acq.ok, true, JSON.stringify(acq));
    return asset.asset.id;
  };

  // Depreciate an active asset for exactly one period so accumulated depreciation is non-zero,
  // exercising the accumulated-depreciation-clearing line on disposal. Straight-line 1'200'000 / 12 =
  // 100'000 a month, so one period leaves accum 100'000 and NBV 1'100'000.
  const depreciateOnePeriod = (assetId, period = '2026-02') => {
    const draft = assetDepreciationRunCreate(ctx, { period, assetIds: [assetId], idempotencyKey: `dr-${Math.random()}` });
    assert.equal(draft.ok, true, JSON.stringify(draft));
    const posted = assetDepreciationRunPost(ctx, { runId: draft.run.id, idempotencyKey: `dp-${Math.random()}` });
    assert.equal(posted.ok, true, JSON.stringify(posted));
  };

  return { ctx, store, workspaceId, deps, clock, ids, acc, activeAsset, depreciateOnePeriod };
}

const journalCount = (store, ws) =>
  store.db.prepare("SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ? AND status = 'posted'").get(ws).n;
const disposalTxnCount = (store, ws) =>
  store.db.prepare("SELECT COUNT(*) AS n FROM asset_transaction WHERE workspace_id = ? AND type = 'disposal'").get(ws).n;
const assetStatus = (store, ws, id) =>
  store.db.prepare('SELECT status FROM asset WHERE workspace_id = ? AND id = ?').get(ws, id).status;

function dispose(ctx, assetId, acc, over = {}) {
  return assetDispose(ctx, {
    assetId,
    disposalDate: '2026-07-15',
    proceedsRappen: 1_000_000,
    proceedsAccountId: acc('1020'),
    gainLossAccountId: acc('6900'),
    idempotencyKey: `disp-${Math.random()}`,
    ...over,
  });
}

// --- INVARIANT 1: balanced entry + gain/loss sign --------------------------------------------------

test('a LOSS disposal debits the loss to the gain/loss account and balances (proceeds below NBV)', () => {
  const { ctx, store, workspaceId, acc, activeAsset, depreciateOnePeriod } = setup();
  const id = activeAsset(1_200_000);
  depreciateOnePeriod(id); // accum 100'000, NBV 1'100'000
  const r = dispose(ctx, id, acc, { proceedsRappen: 1_000_000 }); // loss = 100'000
  assert.equal(r.ok, true, JSON.stringify(r));

  assert.equal(r.gainLossRappen, -100_000, 'a loss is a negative signed gain/loss');
  const lines = r.journalEntry.lines;
  const debit = lines.reduce((s, l) => s + l.debit, 0);
  const credit = lines.reduce((s, l) => s + l.credit, 0);
  assert.equal(debit, credit, 'debits equal credits');
  assert.equal(r.journalEntry.source, 'asset_disposal');
  // Dr accumulated depreciation (the contra) for the accumulated amount.
  assert.equal(lines.find((l) => l.account === acc('1510')).debit, 100_000, 'accumulated depreciation cleared (Dr)');
  // Dr the bank proceeds.
  assert.equal(lines.find((l) => l.account === acc('1020')).debit, 1_000_000, 'proceeds debited to the bank');
  // Cr the asset cost account for the FULL cost.
  assert.equal(lines.find((l) => l.account === acc('1500')).credit, 1_200_000, 'asset cost cleared (Cr)');
  // The loss lands on the DEBIT side of the gain/loss account.
  const gl = lines.find((l) => l.account === acc('6900'));
  assert.equal(gl.debit, 100_000, 'the book loss is debited to the gain/loss account');
  assert.equal(gl.credit, 0);
});

test('a GAIN disposal credits the gain to the gain/loss account (proceeds above NBV)', () => {
  const { ctx, acc, activeAsset } = setup();
  const id = activeAsset(1_200_000); // accum 0, NBV 1'200'000
  const r = dispose(ctx, id, acc, { proceedsRappen: 1_500_000 }); // gain = 300'000
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.gainLossRappen, 300_000, 'a gain is a positive signed gain/loss');
  const lines = r.journalEntry.lines;
  assert.equal(lines.reduce((s, l) => s + l.debit, 0), lines.reduce((s, l) => s + l.credit, 0), 'balanced');
  const gl = lines.find((l) => l.account === acc('6900'));
  assert.equal(gl.credit, 300_000, 'the book gain is credited to the gain/loss account');
  assert.equal(gl.debit, 0);
  // No accumulated line (accum was 0); the asset cost is cleared in full.
  assert.equal(lines.some((l) => l.account === acc('1510')), false, 'no accumulated-depreciation line when accum is 0');
  assert.equal(lines.find((l) => l.account === acc('1500')).credit, 1_200_000);
});

test('an exact disposal (proceeds == NBV) writes NO gain/loss line', () => {
  const { ctx, acc, activeAsset } = setup();
  const id = activeAsset(1_200_000);
  const r = dispose(ctx, id, acc, { proceedsRappen: 1_200_000 });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.gainLossRappen, 0);
  const lines = r.journalEntry.lines;
  assert.equal(lines.some((l) => l.account === acc('6900')), false, 'no gain/loss line when proceeds equal NBV');
  assert.equal(lines.reduce((s, l) => s + l.debit, 0), lines.reduce((s, l) => s + l.credit, 0), 'balanced');
});

test('a SCRAP disposal (zero proceeds) writes no proceeds line and books the whole NBV as a loss', () => {
  const { ctx, acc, activeAsset } = setup();
  const id = activeAsset(1_200_000);
  const r = dispose(ctx, id, acc, { proceedsRappen: 0, proceedsAccountId: undefined });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.gainLossRappen, -1_200_000, 'the whole NBV is a loss on a scrap');
  const lines = r.journalEntry.lines;
  assert.equal(lines.some((l) => l.account === acc('1020')), false, 'no proceeds line on a scrap');
  assert.equal(lines.find((l) => l.account === acc('6900')).debit, 1_200_000, 'the loss is the full NBV');
  assert.equal(lines.find((l) => l.account === acc('1500')).credit, 1_200_000);
  assert.equal(lines.reduce((s, l) => s + l.debit, 0), lines.reduce((s, l) => s + l.credit, 0), 'balanced');
});

test('a successful disposal moves the asset to disposed, forces NBV to 0 and stamps the proceeds', () => {
  const { ctx, store, workspaceId, acc, activeAsset } = setup();
  const id = activeAsset(1_200_000);
  const r = dispose(ctx, id, acc, { proceedsRappen: 900_000 });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.asset.status, 'disposed');
  assert.equal(r.asset.netBookValueRappen, 0, 'NBV is forced to 0 on disposal');
  assert.equal(r.asset.disposalProceedsRappen, 900_000);
  assert.equal(r.asset.disposedAt, '2026-07-15');
  // Historical cost and accumulated depreciation stay for reporting.
  assert.equal(r.asset.acquisitionCostRappen, 1_200_000);
  // The disposal sub-ledger row clears both convenience totals (deltas negative).
  assert.equal(r.transaction.type, 'disposal');
  assert.equal(r.transaction.deltaCostRappen, -1_200_000);
  assert.equal(r.transaction.deltaAccumDeprRappen, 0);
  assert.equal(r.transaction.proceedsRappen, 900_000);
  assert.equal(r.transaction.gainLossRappen, -300_000);
  assert.equal(assetStatus(store, workspaceId, id), 'disposed');
});

// --- INVARIANT 2: idempotent on ROWS ---------------------------------------------------------------

test('replaying a disposal under the same key posts no second journal, writes no second row, flips once', () => {
  const { ctx, store, workspaceId, acc, activeAsset } = setup();
  const id = activeAsset(1_200_000);
  const before = journalCount(store, workspaceId);
  const key = 'disp-replay';
  const r1 = dispose(ctx, id, acc, { proceedsRappen: 900_000, idempotencyKey: key });
  assert.equal(r1.ok, true, JSON.stringify(r1));
  const r2 = dispose(ctx, id, acc, { proceedsRappen: 900_000, idempotencyKey: key });
  assert.equal(r2.ok, true, JSON.stringify(r2));

  assert.equal(journalCount(store, workspaceId) - before, 1, 'exactly one posted journal across the replay');
  assert.equal(disposalTxnCount(store, workspaceId), 1, 'exactly one disposal transaction row');
  assert.deepEqual(r2, r1, 'the replay returns the original objects');
});

// --- INVARIANT 3: append-only at the DB layer ------------------------------------------------------

test('the disposal transaction row is immutable: UPDATE and DELETE both abort', () => {
  const { ctx, store, workspaceId, acc, activeAsset } = setup();
  const id = activeAsset(1_200_000);
  const r = dispose(ctx, id, acc);
  const txnId = r.transaction.id;
  assert.throws(
    () => store.db.prepare('UPDATE asset_transaction SET description = ? WHERE id = ?').run('tampered', txnId),
    /asset_transaction_immutable/,
    'UPDATE of a posted disposal row must abort',
  );
  assert.throws(
    () => store.db.prepare('DELETE FROM asset_transaction WHERE id = ?').run(txnId),
    /asset_transaction_immutable/,
    'DELETE of a posted disposal row must abort',
  );
  // The journal entry is immutable too (A02's own triggers).
  assert.throws(
    () => store.db.prepare('UPDATE journal_entry SET description = ? WHERE id = ?').run('tampered', r.transaction.journalEntryId),
    /immutable|posted/i,
  );
});

// --- INVARIANT 4: §H-TENANT ------------------------------------------------------------------------

test('a foreign workspace can neither dispose the asset nor read its disposal, and foreign accounts never resolve', () => {
  // TWO workspaces in ONE store, so the account and asset ids are genuinely DISTINCT (two fresh stores
  // would replay the same deterministic id sequence and defeat the point). Workspace scoping is what
  // makes §H-TENANT bite: B's ctx never resolves A's asset or A's accounts.
  const clock = fixedClock(AT);
  const ids = sequenceIdGen();
  const store = new SqliteStore({ clock });
  const deps = { store, clock, ids };
  const mk = (name) => {
    const workspaceId = createWorkspace(deps, { name }).workspaceId;
    const ctx = makeContext(store, { workspaceId, actor: 'u', clock, ids, ...ledgerPorts({ store, workspaceId, ids }) });
    const acc = (n) => store.db.prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?').get(workspaceId, n).id;
    return { ctx, workspaceId, acc };
  };
  const A = mk('Acme AG');
  const B = mk('Beta AG');
  assert.notEqual(A.acc('6900'), B.acc('6900'), 'the two workspaces have distinct account ids');

  const seed = (ws) => {
    const cat = createAssetCategory(ws.ctx, {
      code: 'MACH', name: 'M', depreciationMethod: 'straight_line', usefulLifeMonths: 12,
      glAssetAccountId: ws.acc('1500'), glAccumDeprAccountId: ws.acc('1510'), glDeprExpenseAccountId: ws.acc('6800'),
      idempotencyKey: 'cat',
    });
    const asset = createAsset(ws.ctx, {
      categoryId: cat.category.id, name: 'A', acquisitionDate: '2026-01-10', acquisitionCostRappen: 1_200_000, idempotencyKey: 'as',
    });
    assetAcquire(ws.ctx, { assetId: asset.asset.id, date: '2026-01-10', acquisitionCostRappen: 1_200_000, creditAccountId: ws.acc('1020'), idempotencyKey: 'acq' });
    return asset.asset.id;
  };
  const idA = seed(A);
  const r = assetDispose(A.ctx, { assetId: idA, disposalDate: '2026-07-15', proceedsRappen: 1_000_000, proceedsAccountId: A.acc('1020'), gainLossAccountId: A.acc('6900'), idempotencyKey: 'a-disp' });
  assert.equal(r.ok, true, JSON.stringify(r));

  const idB = seed(B);
  // B's ctx cannot dispose A's asset: a foreign asset id is not_found (never a leak of A's row).
  const cross = assetDispose(B.ctx, { assetId: idA, disposalDate: '2026-07-15', proceedsRappen: 100_000, proceedsAccountId: B.acc('1020'), gainLossAccountId: B.acc('6900'), idempotencyKey: 'cross' });
  assert.equal(cross.ok, false);
  assert.equal(cross.error, 'not_found');
  // A's disposal transaction is not readable from B.
  const getCross = assetDisposalGet(B.ctx, { transactionId: r.transaction.id });
  assert.equal(getCross.ok, false);
  assert.equal(getCross.error, 'not_found');

  // A foreign gain/loss account (A's account id used in B's ctx) never resolves.
  const foreignAcc = assetDispose(B.ctx, { assetId: idB, disposalDate: '2026-07-15', proceedsRappen: 100_000, proceedsAccountId: B.acc('1020'), gainLossAccountId: A.acc('6900'), idempotencyKey: 'foreign-acc' });
  assert.equal(foreignAcc.ok, false);
  assert.equal(foreignAcc.error, 'invalid_gain_loss_account');
  // A foreign proceeds account (A's bank id in B's ctx) never resolves either.
  const foreignProceeds = assetDispose(B.ctx, { assetId: idB, disposalDate: '2026-07-15', proceedsRappen: 100_000, proceedsAccountId: A.acc('1020'), gainLossAccountId: B.acc('6900'), idempotencyKey: 'foreign-proc' });
  assert.equal(foreignProceeds.ok, false);
  assert.equal(foreignProceeds.error, 'invalid_proceeds_account');
});

// --- INVARIANT 5: period lock ----------------------------------------------------------------------

test('a disposal dated in a hard-locked period is refused and writes NOTHING', () => {
  const { ctx, store, workspaceId, acc, activeAsset } = setup();
  const id = activeAsset(1_200_000);
  const sealed = lockPeriod(ctx, { period: '2026-07', kind: 'hard', reason: 'vat_filed', idempotencyKey: 'lk' });
  assert.equal(sealed.ok, true, JSON.stringify(sealed));
  const before = journalCount(store, workspaceId);
  const r = dispose(ctx, id, acc, { disposalDate: '2026-07-15' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'period_locked');
  assert.equal(journalCount(store, workspaceId), before, 'no journal posted');
  assert.equal(disposalTxnCount(store, workspaceId), 0, 'no disposal transaction written');
  assert.equal(assetStatus(store, workspaceId, id), 'active', 'the asset stays active');
});

// --- INVARIANT 6: terminal state blocks depreciation + mutation ------------------------------------

test('a disposed asset is excluded from a later depreciation run and refused by asset_update', () => {
  const { ctx, acc, activeAsset } = setup();
  const id = activeAsset(1_200_000);
  const r = dispose(ctx, id, acc);
  assert.equal(r.ok, true, JSON.stringify(r));

  // A sweep run for a LATER period finds nothing eligible (the disposed asset is the only one).
  const run = assetDepreciationRunCreate(ctx, { period: '2026-08', idempotencyKey: 'after-disp' });
  assert.equal(run.ok, true, JSON.stringify(run));
  assert.equal(run.empty, true, 'no eligible asset after disposal');
  assert.equal(run.run, null);

  // asset_update refuses a terminal asset.
  const upd = updateAsset(ctx, { assetId: id, patch: { name: 'renamed' }, idempotencyKey: 'u1' });
  assert.equal(upd.ok, false);
  assert.equal(upd.error, 'asset_terminal');
});

// --- Preview purity + round-trip -------------------------------------------------------------------

test('the preview writes nothing and its lines are exactly the lines the disposal then posts', () => {
  const { ctx, store, workspaceId, acc, activeAsset, depreciateOnePeriod } = setup();
  const id = activeAsset(1_200_000);
  depreciateOnePeriod(id); // accum 100'000, NBV 1'100'000
  const jBefore = journalCount(store, workspaceId);

  const pv = assetDisposalPreview(ctx, {
    assetId: id,
    disposalDate: '2026-07-15',
    proceedsRappen: 1_000_000,
    proceedsAccountId: acc('1020'),
    gainLossAccountId: acc('6900'),
  });
  assert.equal(pv.ok, true, JSON.stringify(pv));
  assert.equal(journalCount(store, workspaceId), jBefore, 'preview posts no journal');
  assert.equal(disposalTxnCount(store, workspaceId), 0, 'preview writes no transaction');
  assert.equal(pv.preview.net_book_value_rappen, 1_100_000);
  assert.equal(pv.preview.gain_loss_rappen, -100_000);
  assert.equal(pv.preview.resulting_status, 'disposed');

  const r = dispose(ctx, id, acc, { proceedsRappen: 1_000_000 });
  assert.equal(r.ok, true, JSON.stringify(r));
  // The preview's (account, debit, credit) multiset equals the posted entry's.
  const key = (a, d, c) => `${a}:${d}:${c}`;
  const previewSet = pv.preview.journal_lines.map((l) => key(l.account_id, l.debit_rappen, l.credit_rappen)).sort();
  const postedSet = r.journalEntry.lines.map((l) => key(l.account, l.debit, l.credit)).sort();
  assert.deepEqual(postedSet, previewSet, 'the previewed lines are the posted lines');
});

// --- §2 validation + §6 guard rails ---------------------------------------------------------------

test('validation and guard-rail rejections (§2, §6)', () => {
  const { ctx, acc, activeAsset } = setup();

  // Negative proceeds.
  const neg = dispose(ctx, activeAsset(1_200_000), acc, { proceedsRappen: -1 });
  assert.equal(neg.error, 'invalid_proceeds');

  // A draft (never acquired) asset has no cost basis.
  const draft = createAsset(ctx, {
    categoryId: createAssetCategory(ctx, {
      code: `D-${Math.random().toString(36).slice(2, 6)}`,
      name: 'x',
      depreciationMethod: 'straight_line',
      usefulLifeMonths: 12,
      glAssetAccountId: acc('1500'),
      glAccumDeprAccountId: acc('1510'),
      glDeprExpenseAccountId: acc('6800'),
      idempotencyKey: `dc-${Math.random()}`,
    }).category.id,
    name: 'Draft',
    acquisitionDate: '2026-01-10',
    acquisitionCostRappen: 500_000,
    idempotencyKey: `da-${Math.random()}`,
  }).asset;
  const notAcq = dispose(ctx, draft.id, acc);
  assert.equal(notAcq.error, 'asset_not_acquired');

  // A wrong-type gain/loss account (an asset account, not income/expense).
  const wrongGl = dispose(ctx, activeAsset(1_200_000), acc, { gainLossAccountId: acc('1500') });
  assert.equal(wrongGl.error, 'invalid_gain_loss_account');

  // Proceeds > 0 with a missing proceeds account.
  const missProceeds = dispose(ctx, activeAsset(1_200_000), acc, { proceedsRappen: 100_000, proceedsAccountId: undefined });
  assert.equal(missProceeds.error, 'invalid_proceeds_account');

  // A wrong-type proceeds account (an income account, not a money-side account).
  const wrongProceeds = dispose(ctx, activeAsset(1_200_000), acc, { proceedsAccountId: acc('3200') });
  assert.equal(wrongProceeds.error, 'invalid_proceeds_account');

  // A second dispose on an already-disposed asset (first wins).
  const id = activeAsset(1_200_000);
  assert.equal(dispose(ctx, id, acc).ok, true);
  const again = dispose(ctx, id, acc);
  assert.equal(again.error, 'asset_already_disposed');
});

// --- EXACTLY-ONE-DISPOSAL: the structural race guard (spec 119, US-H06.7) --------------------------
// The "first wins, the second gets asset_already_disposed" promise must NOT rest on planDisposal's
// out-of-tx status read: under D12's supported concurrent-writer topology (Studio + a till mcp
// subprocess on one SQLite file) two writers can both read `active` before either commits. The guard
// is now structural, mirroring the acquisition precedent: a partial unique index that rejects a second
// disposal row at the DB layer, and an in-transaction guarded terminal UPDATE that aborts a stale
// writer with asset_already_disposed before the index would even fire. A true two-process race is not
// reproducible in synchronous better-sqlite3, so these assert the structural guarantees directly.

test('the partial unique index exists and REJECTS a second disposal row for an already-disposed asset', () => {
  const { ctx, store, workspaceId, acc, activeAsset } = setup();
  const id = activeAsset(1_200_000);
  const r = dispose(ctx, id, acc, { proceedsRappen: 900_000 });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(disposalTxnCount(store, workspaceId), 1, 'the first disposal seated exactly one row');

  // The guard is a real, PARTIAL unique index scoped to disposal rows (not the whole table).
  const idx = store.db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'asset_transaction_one_disposal'")
    .get();
  assert.ok(idx, 'asset_transaction_one_disposal index is present');
  assert.match(idx.sql, /UNIQUE/i, 'the one-disposal index is UNIQUE');
  assert.match(idx.sql, /WHERE\s+type\s*=\s*'disposal'/i, 'it is a PARTIAL index over disposal rows only');

  // A second disposal row for the SAME (workspace, asset), inserted straight against the store (the
  // shape a racing second writer would attempt), is refused by the unique index. Reusing the first
  // disposal's journal_entry_id keeps the NOT NULL foreign key satisfiable, so the ONLY thing that can
  // reject the row is the one-disposal guard.
  assert.throws(
    () =>
      store.db
        .prepare(
          `INSERT INTO asset_transaction (
             id, workspace_id, asset_id, type, date, delta_cost_rappen, delta_accum_depr_rappen,
             proceeds_rappen, gain_loss_rappen, journal_entry_id, created_at
           ) VALUES (?, ?, ?, 'disposal', ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run('atxn_dup_disposal', workspaceId, id, '2026-07-15', -1_200_000, 0, 0, 0, r.transaction.journalEntryId, AT),
    /UNIQUE constraint failed|asset_transaction_one_disposal/i,
    'a second disposal row for the same asset must be rejected by the unique index',
  );
  assert.equal(disposalTxnCount(store, workspaceId), 1, 'still exactly one disposal row after the rejected insert');
});

test('the guarded terminal UPDATE bites: a stale writer touches 0 rows and the second dispose aborts cleanly', () => {
  const { ctx, store, workspaceId, acc, activeAsset } = setup();
  const id = activeAsset(1_200_000);
  const before = journalCount(store, workspaceId);
  const first = dispose(ctx, id, acc, { proceedsRappen: 900_000 });
  assert.equal(first.ok, true, JSON.stringify(first));

  // The in-transaction guard is the terminal UPDATE's `WHERE status IN ('active','fully_depreciated')`:
  // once the asset is disposed, that exact UPDATE touches 0 rows, which is the condition the engine
  // turns into a DisposalAbort(asset_already_disposed). Run the guarded statement directly to prove the
  // WHERE clause bites (this is the mechanism a racing second writer hits inside its own transaction).
  const moved = store.db
    .prepare(
      `UPDATE asset SET status = 'disposed', disposed_at = ?, disposal_proceeds_rappen = ?,
              net_book_value_rappen = 0, updated_at = ?
         WHERE workspace_id = ? AND id = ? AND status IN ('active', 'fully_depreciated')`,
    )
    .run('2026-07-15', 0, AT, workspaceId, id);
  assert.equal(moved.changes, 0, 'the guarded terminal UPDATE touches 0 rows once the asset is disposed');

  // End to end: a second engine dispose is refused with asset_already_disposed and writes NOTHING more
  // (no second journal, no second disposal row, the asset stays disposed exactly once).
  const again = dispose(ctx, id, acc, { proceedsRappen: 900_000 });
  assert.equal(again.ok, false);
  assert.equal(again.error, 'asset_already_disposed');
  assert.equal(journalCount(store, workspaceId) - before, 1, 'only the first disposal posted a journal');
  assert.equal(disposalTxnCount(store, workspaceId), 1, 'exactly one disposal row survives the second attempt');
  assert.equal(assetStatus(store, workspaceId, id), 'disposed');
});

// --- Disposal-scoped read -------------------------------------------------------------------------

test('asset_disposal_get returns the disposal + its journal, and is scoped to disposal rows in-tenant', () => {
  const { ctx, acc, activeAsset } = setup();
  const id = activeAsset(1_200_000);
  const r = dispose(ctx, id, acc, { proceedsRappen: 900_000 });
  const got = assetDisposalGet(ctx, { transactionId: r.transaction.id });
  assert.equal(got.ok, true, JSON.stringify(got));
  assert.equal(got.transaction.type, 'disposal');
  assert.equal(got.transaction.gainLossRappen, -300_000);
  assert.ok(got.journalEntry, 'the journal entry travels with the disposal');
  assert.equal(got.journalEntry.source, 'asset_disposal');

  // A foreign / unknown id is not_found.
  const missing = assetDisposalGet(ctx, { transactionId: 'atxn_nope' });
  assert.equal(missing.error, 'not_found');
});
