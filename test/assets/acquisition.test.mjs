// H02, Asset Acquisition: the MONEY-PATH invariants a NON-AUTHOR critic mutation-tests, plus the
// full §2 validation set and the §7 tripwires. This is the dual-write (asset_transaction + A02
// journal) that capitalises a draft asset, so the five load-bearing money-path assertions must BITE:
//
//   1. BALANCED ENTRY. The posted journal debits the category-inherited asset account and credits the
//      chosen account for exactly the capitalised amount; debit total == credit total == cost.
//   2. IDEMPOTENT ON ROWS (§H-IDEMPOTENT). A replay of the same key posts EXACTLY ONE journal entry
//      and writes EXACTLY ONE asset_transaction row. Proven by ROW COUNTS, not by the return value.
//   3. APPEND-ONLY (§H-AUDIT). The asset_transaction row is immutable at the DB layer: UPDATE and
//      DELETE both ABORT with asset_transaction_immutable. The journal entry is immutable too (A02).
//   4. §H-TENANT. A foreign workspace can neither acquire an asset it does not own nor read its
//      transactions, and a foreign credit account never resolves.
//   5. PERIOD LOCK (§H-PERIOD). An acquisition dated in a hard-locked period is refused and writes
//      NOTHING: no journal entry, no transaction, and the asset stays draft.
//
// Plus: the financial-field lock side-effect on H01 (capitalising freezes the baseline), additional
// capitalisation, the concrete error codes, and the H01 follow-up owed from its critic: a
// MANUAL-number create/acquire replayed under the same key yields ONE row.

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
  getAsset,
  archiveAsset,
  assetAcquire,
  assetAddCapitalisation,
  assetTransactionList,
  assetTransactionGet,
} from '../../dist/core/assets/index.js';

const AT = '2026-08-07T00:00:00.000Z';

function setup() {
  const clock = fixedClock(AT);
  const ids = sequenceIdGen();
  const store = new SqliteStore({ clock });
  const deps = { store, clock, ids };
  const workspaceId = createWorkspace(deps, { name: 'Acme AG' }).workspaceId;
  // The REAL PeriodPort + AuditPort (the a03-support pattern), so §H-PERIOD is actually enforced and
  // a hard lock bites; the permissive default would let a locked-period acquisition post.
  const ctx = makeContext(store, { workspaceId, actor: 'user_1', clock, ids, ...ledgerPorts({ store, workspaceId, ids }) });
  const acc = (number) =>
    store.db.prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?').get(workspaceId, number).id;
  const category = (over = {}) => {
    const r = createAssetCategory(ctx, {
      code: `MACH-${Math.random().toString(36).slice(2, 7)}`,
      name: 'Maschinen & Anlagen',
      depreciationMethod: 'straight_line',
      usefulLifeMonths: 60,
      glAssetAccountId: acc('1500'),
      glAccumDeprAccountId: acc('1510'),
      glDeprExpenseAccountId: acc('6800'),
      idempotencyKey: `cat-${Math.random()}`,
      ...over,
    });
    assert.equal(r.ok, true, `category setup failed: ${JSON.stringify(r)}`);
    return r.category;
  };
  const draftAsset = (over = {}) => {
    const cat = category();
    const r = createAsset(ctx, {
      categoryId: cat.id,
      name: 'CNC Fräsmaschine',
      acquisitionDate: '2026-03-15',
      acquisitionCostRappen: 12_500_000,
      idempotencyKey: `as-${Math.random()}`,
      ...over,
    });
    assert.equal(r.ok, true, `asset setup failed: ${JSON.stringify(r)}`);
    return r.asset;
  };
  return { ctx, store, workspaceId, deps, acc, category, draftAsset };
}

const journalCount = (store, ws) =>
  store.db.prepare("SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ? AND status = 'posted'").get(ws).n;
const txnCount = (store, ws) =>
  store.db.prepare('SELECT COUNT(*) AS n FROM asset_transaction WHERE workspace_id = ?').get(ws).n;

function acquire(ctx, assetId, acc, over = {}) {
  return assetAcquire(ctx, {
    assetId,
    date: '2026-03-15',
    acquisitionCostRappen: 12_500_000,
    creditAccountId: acc('1020'),
    idempotencyKey: `acq-${Math.random()}`,
    ...over,
  });
}

// --- Happy path + balanced entry (INVARIANT 1) -------------------------------------------------

test('primary acquisition posts a balanced Dr asset / Cr credit entry and capitalises the asset', () => {
  const { ctx, store, workspaceId, acc, draftAsset } = setup();
  const asset = draftAsset();
  const r = acquire(ctx, asset.id, acc);
  assert.equal(r.ok, true, JSON.stringify(r));

  // The journal is balanced and references exactly the two intended accounts for the cost.
  const lines = r.journalEntry.lines;
  const debit = lines.reduce((s, l) => s + l.debit, 0);
  const credit = lines.reduce((s, l) => s + l.credit, 0);
  assert.equal(debit, credit, 'debits equal credits');
  assert.equal(debit, 12_500_000, 'entry total is the acquisition cost');
  const dr = lines.find((l) => l.account === acc('1500'));
  const cr = lines.find((l) => l.account === acc('1020'));
  assert.equal(dr.debit, 12_500_000, 'the asset GL account is debited the cost');
  assert.equal(cr.credit, 12_500_000, 'the credit account is credited the cost');
  assert.equal(r.journalEntry.source, 'asset_acquisition');

  // The asset is capitalised: draft -> active, cost base + NBV confirmed.
  assert.equal(r.asset.status, 'active');
  assert.equal(r.asset.acquisitionCostRappen, 12_500_000);
  assert.equal(r.asset.netBookValueRappen, 12_500_000);
  // Exactly one transaction, one journal entry, and the sub-ledger names the journal.
  assert.equal(txnCount(store, workspaceId), 1);
  assert.equal(journalCount(store, workspaceId), 1);
  assert.equal(r.transaction.type, 'acquisition');
  assert.equal(r.transaction.deltaCostRappen, 12_500_000);
  assert.equal(r.transaction.journalEntryId, r.journalEntry.id);
});

// --- IDEMPOTENT ON ROWS (INVARIANT 2) ----------------------------------------------------------

test('acquisition is idempotent ON ROWS: a replay posts exactly one entry and one transaction', () => {
  const { ctx, store, workspaceId, acc, draftAsset } = setup();
  const asset = draftAsset();
  const key = 'acq-replay';
  const first = acquire(ctx, asset.id, acc, { idempotencyKey: key });
  const second = acquire(ctx, asset.id, acc, { idempotencyKey: key });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(second.transaction.id, first.transaction.id, 'the replay returns the original transaction');
  assert.equal(second.journalEntry.id, first.journalEntry.id, 'the replay returns the original entry');
  // The teeth: the ledger moved exactly once, no double-count.
  assert.equal(txnCount(store, workspaceId), 1, 'exactly one asset_transaction row after the replay');
  assert.equal(journalCount(store, workspaceId), 1, 'exactly one posted journal entry after the replay');
  // The asset cost did not double.
  assert.equal(getAsset(ctx, { assetId: asset.id }).asset.acquisitionCostRappen, 12_500_000);
});

// --- APPEND-ONLY (INVARIANT 3) -----------------------------------------------------------------

test('the asset_transaction row is immutable at the DB layer: UPDATE and DELETE both abort', () => {
  const { ctx, store, acc, draftAsset } = setup();
  const asset = draftAsset();
  const r = acquire(ctx, asset.id, acc);
  const txnId = r.transaction.id;
  assert.throws(
    () => store.db.prepare('UPDATE asset_transaction SET delta_cost_rappen = 1 WHERE id = ?').run(txnId),
    /asset_transaction_immutable/,
    'an UPDATE of a recorded transaction must abort',
  );
  assert.throws(
    () => store.db.prepare('DELETE FROM asset_transaction WHERE id = ?').run(txnId),
    /asset_transaction_immutable/,
    'a DELETE of a recorded transaction must abort',
  );
  // The posted journal entry is immutable too (A02's triggers).
  assert.throws(
    () => store.db.prepare('DELETE FROM journal_entry WHERE id = ?').run(r.journalEntry.id),
    /posted_immutable/,
  );
});

// --- §H-TENANT (INVARIANT 4) -------------------------------------------------------------------

test('acquisition and its reads are strictly workspace-scoped', () => {
  const { ctx, store, deps, acc, draftAsset } = setup();
  const asset = draftAsset();
  const mine = acquire(ctx, asset.id, acc);
  const other = makeContext(store, {
    workspaceId: createWorkspace(deps, { name: 'Other AG' }).workspaceId,
    actor: 'u',
    clock: deps.clock,
    ids: deps.ids,
  });
  // A foreign asset id never resolves to a write.
  assert.equal(
    assetAcquire(other, { assetId: asset.id, date: '2026-03-15', acquisitionCostRappen: 1000, creditAccountId: acc('1020'), idempotencyKey: 'x' }).error,
    'not_found',
  );
  // A foreign workspace cannot read the transaction, by list or by id.
  assert.equal(assetTransactionList(other, { assetId: asset.id }).transactions.length, 0);
  assert.equal(assetTransactionGet(other, { id: mine.transaction.id }).error, 'not_found');
  // A foreign credit account never resolves (the account belongs to `other`, not to `ctx`).
  const foreignAcc = store.db
    .prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?')
    .get(other.workspaceId, '1020').id;
  const draft2 = draftAsset();
  assert.equal(
    assetAcquire(ctx, { assetId: draft2.id, date: '2026-03-15', acquisitionCostRappen: 1000, creditAccountId: foreignAcc, idempotencyKey: 'f' }).error,
    'invalid_credit_account',
  );
});

// --- PERIOD LOCK (INVARIANT 5) -----------------------------------------------------------------

test('an acquisition dated in a hard-locked period is refused and writes nothing', () => {
  const { ctx, store, workspaceId, acc, draftAsset } = setup();
  const asset = draftAsset();
  const sealed = lockPeriod(ctx, { period: '2026-03', kind: 'hard', reason: 'vat_filed', idempotencyKey: 'lk' });
  assert.equal(sealed.ok, true);
  const r = acquire(ctx, asset.id, acc, { date: '2026-03-15' });
  assert.equal(r.error, 'period_locked');
  // Nothing half-done: no transaction, no journal entry, asset still draft.
  assert.equal(txnCount(store, workspaceId), 0);
  assert.equal(journalCount(store, workspaceId), 0);
  assert.equal(getAsset(ctx, { assetId: asset.id }).asset.status, 'draft');
});

// --- Financial-field lock side-effect on H01 ---------------------------------------------------

test('capitalising trips H01 financial_fields_locked: the baseline can no longer change', () => {
  const { ctx, acc, draftAsset } = setup();
  const asset = draftAsset();
  // Before acquisition the cost is editable (still draft).
  assert.equal(updateAsset(ctx, { assetId: asset.id, patch: { acquisitionCostRappen: 9_000_000 }, idempotencyKey: 'u0' }).ok, true);
  acquire(ctx, asset.id, acc, { acquisitionCostRappen: 9_000_000 });
  // After acquisition the baseline is frozen.
  const locked = updateAsset(ctx, { assetId: asset.id, patch: { acquisitionCostRappen: 1_000_000 }, idempotencyKey: 'u1' });
  assert.equal(locked.error, 'financial_fields_locked');
  // A descriptive field still edits freely.
  assert.equal(updateAsset(ctx, { assetId: asset.id, patch: { notes: 'Serverraum' }, idempotencyKey: 'u2' }).ok, true);
});

// --- Additional capitalisation -----------------------------------------------------------------

test('additional capitalisation raises cost and NBV and posts a second balanced entry', () => {
  const { ctx, store, workspaceId, acc, draftAsset } = setup();
  const asset = draftAsset({ acquisitionCostRappen: 800_000 });
  acquire(ctx, asset.id, acc, { acquisitionCostRappen: 800_000 });
  const cap = assetAddCapitalisation(ctx, {
    assetId: asset.id,
    date: '2026-04-01',
    amountRappen: 150_000,
    creditAccountId: acc('1020'),
    idempotencyKey: 'cap-1',
  });
  assert.equal(cap.ok, true, JSON.stringify(cap));
  assert.equal(cap.transaction.type, 'additional_capitalisation');
  assert.equal(cap.asset.acquisitionCostRappen, 950_000, 'cost rose by the capitalised amount');
  assert.equal(cap.asset.netBookValueRappen, 950_000, 'NBV rose in step (accumulated depreciation is 0)');
  assert.equal(txnCount(store, workspaceId), 2);
  assert.equal(journalCount(store, workspaceId), 2);
  // The history read returns both, oldest first.
  const list = assetTransactionList(ctx, { assetId: asset.id });
  assert.equal(list.transactions.length, 2);
  assert.deepEqual(list.transactions.map((t) => t.type), ['acquisition', 'additional_capitalisation']);
});

test('additional capitalisation before a primary acquisition is refused', () => {
  const { ctx, acc, draftAsset } = setup();
  const asset = draftAsset();
  const r = assetAddCapitalisation(ctx, {
    assetId: asset.id,
    date: '2026-04-01',
    amountRappen: 150_000,
    creditAccountId: acc('1020'),
    idempotencyKey: 'cap-early',
  });
  assert.equal(r.error, 'not_acquired');
});

// --- The concrete error codes (§2) -------------------------------------------------------------

test('validation refuses each nonsense case with its own code and writes nothing', () => {
  const { ctx, store, workspaceId, acc, draftAsset } = setup();
  const asset = draftAsset();
  // cost <= 0
  assert.equal(acquire(ctx, asset.id, acc, { acquisitionCostRappen: 0 }).error, 'invalid_cost');
  // credit account of the wrong type (income)
  assert.equal(acquire(ctx, asset.id, acc, { creditAccountId: acc('3000') }).error, 'credit_account_wrong_type');
  // missing / unknown credit account
  assert.equal(acquire(ctx, asset.id, acc, { creditAccountId: 'nope' }).error, 'invalid_credit_account');
  // residual above cost
  assert.equal(acquire(ctx, asset.id, acc, { residualValueRappen: 99_000_000 }).error, 'invalid_residual');
  // a supplied source document that does not resolve
  assert.equal(acquire(ctx, asset.id, acc, { source: 'vendor_bill', sourceDocumentId: 'ghost' }).error, 'source_document_not_found');
  // none of the above wrote anything
  assert.equal(txnCount(store, workspaceId), 0);
  assert.equal(journalCount(store, workspaceId), 0);
});

test('a second primary acquisition is refused with already_acquired and posts no second entry', () => {
  const { ctx, store, workspaceId, acc, draftAsset } = setup();
  const asset = draftAsset();
  acquire(ctx, asset.id, acc);
  const again = acquire(ctx, asset.id, acc);
  assert.equal(again.error, 'already_acquired');
  assert.equal(txnCount(store, workspaceId), 1);
  assert.equal(journalCount(store, workspaceId), 1);
});

test('a disposed or archived asset cannot be acquired', () => {
  const { ctx, acc, draftAsset } = setup();
  const asset = draftAsset();
  archiveAsset(ctx, { assetId: asset.id, idempotencyKey: 'arch' });
  assert.equal(acquire(ctx, asset.id, acc).error, 'asset_not_acquirable');
});

test('a liability credit account (creditor) is admissible', () => {
  const { ctx, acc, draftAsset } = setup();
  const asset = draftAsset();
  const r = acquire(ctx, asset.id, acc, { creditAccountId: acc('2000') });
  assert.equal(r.ok, true, JSON.stringify(r));
});

// --- H01 follow-up owed from its critic: MANUAL-number replay idempotency ----------------------

test('a MANUAL-number asset create replayed under the same key yields exactly one row', () => {
  const { ctx, store, workspaceId, category } = setup();
  const cat = category();
  const input = {
    categoryId: cat.id,
    number: 'FA-MANUAL-01',
    name: 'Handnummeriert',
    acquisitionDate: '2026-03-15',
    acquisitionCostRappen: 500_000,
    idempotencyKey: 'manual-key',
  };
  const first = createAsset(ctx, input);
  const second = createAsset(ctx, input);
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(second.asset.id, first.asset.id, 'the replay returns the original asset');
  const n = store.db
    .prepare('SELECT COUNT(*) AS n FROM asset WHERE workspace_id = ? AND lower(number) = lower(?)')
    .get(workspaceId, 'FA-MANUAL-01').n;
  assert.equal(n, 1, 'exactly one asset row carries the manual number after the replay');
});

test('acquiring a MANUAL-number asset and replaying the key yields exactly one transaction', () => {
  const { ctx, store, workspaceId, acc, category } = setup();
  const cat = category();
  const created = createAsset(ctx, {
    categoryId: cat.id,
    number: 'FA-MANUAL-02',
    name: 'Handnummeriert 2',
    acquisitionDate: '2026-03-15',
    acquisitionCostRappen: 600_000,
    idempotencyKey: 'manual-key-2',
  });
  const key = 'acq-manual';
  const a = acquire(ctx, created.asset.id, acc, { acquisitionCostRappen: 600_000, idempotencyKey: key });
  const b = acquire(ctx, created.asset.id, acc, { acquisitionCostRappen: 600_000, idempotencyKey: key });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(b.transaction.id, a.transaction.id);
  assert.equal(txnCount(store, workspaceId), 1);
  assert.equal(journalCount(store, workspaceId), 1);
});
