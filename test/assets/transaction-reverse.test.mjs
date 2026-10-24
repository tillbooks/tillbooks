// D170, the asset register's undo verb (`asset_transaction_reverse`): an acquisition, a capitalisation,
// an opening balance or a disposal is taken back as an owned A02 mirror plus a compensating
// asset_transaction, in one transaction, and the raw `reverse_entry` refuses those entries.
//
// Every fixture here is SYNTHETIC by construction (an invented company and invented amounts).
//
// What must BITE (each assertion below was run against a mutation, see D170):
//  - the ownership resolvers: the raw reverse_entry refuses an asset event's entry and its mirror;
//  - the pre-checks: depreciation_posted, capitalisation_stands, asset_disposed, each writes nothing;
//  - the register and the GL agree afterwards (the OP11 reconciliation stays balanced);
//  - idempotent on ROWS: one mirror and one compensating row, whatever the key;
//  - a book from before D170 (a raw Storno): odd chain adopts, even chain posts against the last link,
//    and the forward acts refuse asset_posting_reversed until it is closed;
//  - §H-PERIOD (a sealed today) and §H-TENANT.

import test from 'node:test';
import assert from 'node:assert/strict';

import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { makeContext } from '../../dist/core/context.js';
import { fixedClock } from '../../dist/core/clock.js';
import { sequenceIdGen } from '../../dist/core/ids.js';
import { createWorkspace } from '../../dist/core/setup/index.js';
import { ledgerPorts } from '../../dist/core/ledger/index.js';
import { lockPeriodSealed } from '../../dist/core/ledger/periods.js';
import { reverseEntry, reverseOwnedEntry } from '../../dist/core/ledger/reverseEntry.js';
import {
  createAssetCategory,
  createAsset,
  assetAcquire,
  assetAddCapitalisation,
  assetOpeningBalance,
  assetDepreciationRunCreate,
  assetDepreciationRunPost,
  assetDepreciationRunReverse,
  assetDispose,
  assetDisposalPreview,
  assetLedgerGet,
  assetReconciliationReport,
  assetTransactionReverse,
  assetDisposalSummary,
  assetAcquisitionSummary,
} from '../../dist/core/assets/index.js';

const AT = '2026-08-16T00:00:00.000Z';
const TODAY = '2026-08-16';
const OWNER = 'asset_transaction_reverse';

function setup(name = 'Muster Werkstatt AG') {
  const clock = fixedClock(AT);
  const ids = sequenceIdGen();
  const store = new SqliteStore({ clock });
  const workspaceId = createWorkspace({ store, clock, ids }, { name }).workspaceId;
  const ctx = makeContext(store, { workspaceId, actor: 'user_1', clock, ids, ...ledgerPorts({ store, workspaceId, ids }) });
  const acc = (number) => store.db.prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?').get(workspaceId, number).id;
  let n = 0;
  const draftAsset = (cost = 1_200_000) => {
    n += 1;
    const cat = createAssetCategory(ctx, {
      code: `MASCH-${n}`,
      name: 'Maschinen',
      depreciationMethod: 'straight_line',
      usefulLifeMonths: 12,
      glAssetAccountId: acc('1500'),
      glAccumDeprAccountId: acc('1510'),
      glDeprExpenseAccountId: acc('6800'),
      idempotencyKey: `cat-${n}`,
    });
    assert.equal(cat.ok, true, JSON.stringify(cat));
    const asset = createAsset(ctx, { categoryId: cat.category.id, name: `Drehbank ${n}`, acquisitionDate: '2026-01-10', acquisitionCostRappen: cost, idempotencyKey: `as-${n}` });
    assert.equal(asset.ok, true, JSON.stringify(asset));
    return asset.asset.id;
  };
  const activeAsset = (cost = 1_200_000) => {
    const id = draftAsset(cost);
    const acq = assetAcquire(ctx, { assetId: id, date: '2026-01-10', acquisitionCostRappen: cost, creditAccountId: acc('1020'), idempotencyKey: `acq-${id}` });
    assert.equal(acq.ok, true, JSON.stringify(acq));
    return { id, txnId: acq.transaction.id, entryId: acq.journalEntry.id };
  };
  const depreciate = (assetId, period) => {
    const draft = assetDepreciationRunCreate(ctx, { period, assetIds: [assetId], idempotencyKey: `dr-${assetId}-${period}` });
    assert.equal(draft.ok, true, JSON.stringify(draft));
    const posted = assetDepreciationRunPost(ctx, { runId: draft.run.id, idempotencyKey: `dp-${assetId}-${period}` });
    assert.equal(posted.ok, true, JSON.stringify(posted));
    return draft.run.id;
  };
  const dispose = (assetId) => {
    const r = assetDispose(ctx, { assetId, disposalDate: '2026-07-15', proceedsRappen: 1_000_000, proceedsAccountId: acc('1020'), gainLossAccountId: acc('6900'), idempotencyKey: `disp-${assetId}` });
    assert.equal(r.ok, true, JSON.stringify(r));
    return r.transaction.id;
  };
  const reverse = (assetId, transactionId, key = `rev-${transactionId}`, reason = 'Falsch erfasst') =>
    assetTransactionReverse(ctx, { assetId, transactionId, reason, idempotencyKey: key });
  const count = (sql, ...p) => store.db.prepare(sql).get(workspaceId, ...p).n;
  const journals = () => count("SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ? AND status = 'posted'");
  const txns = () => count('SELECT COUNT(*) AS n FROM asset_transaction WHERE workspace_id = ?');
  const asset = (id) => store.db.prepare('SELECT * FROM asset WHERE workspace_id = ? AND id = ?').get(workspaceId, id);
  const balanced = () => {
    const r = assetReconciliationReport(ctx, { asOf: '2026-12-31' });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.summary.status, 'balanced', JSON.stringify(r.accounts));
  };
  return { ctx, store, workspaceId, acc, draftAsset, activeAsset, depreciate, dispose, reverse, journals, txns, asset, balanced };
}

test('an acquisition is reversed as a pair: an owned mirror, a compensating row, the asset closed, the books reconciled', () => {
  const f = setup();
  const a = f.activeAsset(1_200_000);
  const j0 = f.journals();
  const r = f.reverse(a.id, a.txnId);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.adopted, false);
  assert.equal(r.type, 'acquisition');
  assert.equal(f.journals(), j0 + 1, 'exactly one mirror posted');
  const mirror = f.store.db.prepare('SELECT * FROM journal_entry WHERE workspace_id = ? AND id = ?').get(f.workspaceId, r.reversalEntryId);
  assert.equal(mirror.reverses_entry_id, a.entryId);
  assert.equal(mirror.date, TODAY, 'OR 957a: dated today');
  const comp = f.store.db.prepare('SELECT * FROM asset_transaction WHERE workspace_id = ? AND id = ?').get(f.workspaceId, r.reversalTransactionId);
  assert.equal(comp.type, 'acquisition_reversal');
  assert.equal(comp.delta_cost_rappen, -1_200_000);
  assert.equal(comp.journal_entry_id, r.reversalEntryId);
  assert.equal(comp.source_document_type, 'asset_transaction');
  assert.equal(comp.source_document_id, a.txnId);
  const after = f.asset(a.id);
  assert.equal(after.status, 'archived');
  assert.equal(after.net_book_value_rappen, 0);
  f.balanced();
  // The ledger read says which event was taken back.
  const ledger = assetLedgerGet(f.ctx, { assetId: a.id });
  assert.equal(ledger.events.find((e) => e.id === a.txnId).reversedByTransactionId, r.reversalTransactionId);
  assert.equal(ledger.events.at(-1).netBookValueAfterRappen, 0);
  // The asset is closed: no second acquisition on the same record.
  const again = assetAcquire(f.ctx, { assetId: a.id, date: TODAY, acquisitionCostRappen: 1_000_000, creditAccountId: f.acc('1020'), idempotencyKey: 'acq-again' });
  assert.equal(again.ok, false);
  assert.equal(again.error, 'asset_not_acquirable');
});

test('the raw reverse_entry refuses an asset event entry and its mirror (owned_by asset_transaction_reverse)', () => {
  const f = setup();
  const a = f.activeAsset();
  const raw = reverseEntry(f.ctx, { entryId: a.entryId, idempotencyKey: 'raw-1' });
  assert.equal(raw.ok, false);
  assert.equal(raw.error, 'owned_by');
  assert.equal(raw.verb, OWNER);
  const disp = f.dispose(a.id);
  const dispEntry = f.store.db.prepare('SELECT journal_entry_id AS j FROM asset_transaction WHERE workspace_id = ? AND id = ?').get(f.workspaceId, disp).j;
  const rawDisp = reverseEntry(f.ctx, { entryId: dispEntry, idempotencyKey: 'raw-2' });
  assert.equal(rawDisp.error, 'owned_by');
  assert.equal(rawDisp.verb, OWNER);
  const r = f.reverse(a.id, disp);
  assert.equal(r.ok, true, JSON.stringify(r));
  const rawMirror = reverseEntry(f.ctx, { entryId: r.reversalEntryId, idempotencyKey: 'raw-3' });
  assert.equal(rawMirror.error, 'owned_by', 'the mirror is owned through the walk');
  assert.equal(rawMirror.verb, OWNER);
});

test('idempotent on ROWS: the same key replays, a new key answers already_reversed, nothing is written twice', () => {
  const f = setup();
  const a = f.activeAsset();
  const first = f.reverse(a.id, a.txnId, 'k1');
  assert.equal(first.ok, true, JSON.stringify(first));
  const j = f.journals();
  const t = f.txns();
  const replay = f.reverse(a.id, a.txnId, 'k1');
  assert.deepEqual(replay, first);
  const second = f.reverse(a.id, a.txnId, 'k2');
  assert.equal(second.ok, false);
  assert.equal(second.error, 'already_reversed');
  assert.equal(second.reversalTransactionId, first.reversalTransactionId);
  assert.equal(f.journals(), j);
  assert.equal(f.txns(), t);
});

test('an acquisition is refused while a posted depreciation run covers it, and goes once the run is reversed', () => {
  const f = setup();
  const a = f.activeAsset();
  const run = f.depreciate(a.id, '2026-02');
  const j = f.journals();
  const t = f.txns();
  const refused = f.reverse(a.id, a.txnId);
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'depreciation_posted');
  assert.deepEqual(refused.runIds, [run]);
  assert.equal(f.journals(), j, 'a refusal posts nothing');
  assert.equal(f.txns(), t, 'a refusal writes no row');
  assert.equal(f.asset(a.id).status, 'active');
  const back = assetDepreciationRunReverse(f.ctx, { runId: run, reason: 'Falscher Lauf', idempotencyKey: 'rr' });
  assert.equal(back.ok, true, JSON.stringify(back));
  const ok = f.reverse(a.id, a.txnId);
  assert.equal(ok.ok, true, JSON.stringify(ok));
  f.balanced();
});

test('a baseline is refused while a capitalisation stands; the capitalisation reverses on its own and lowers cost and book value', () => {
  const f = setup();
  const a = f.activeAsset(1_200_000);
  const cap = assetAddCapitalisation(f.ctx, { assetId: a.id, date: '2026-03-05', amountRappen: 300_000, creditAccountId: f.acc('1020'), idempotencyKey: 'cap' });
  assert.equal(cap.ok, true, JSON.stringify(cap));
  const refused = f.reverse(a.id, a.txnId);
  assert.equal(refused.error, 'capitalisation_stands');
  assert.deepEqual(refused.capitalisationIds, [cap.transaction.id]);
  const r = f.reverse(a.id, cap.transaction.id);
  assert.equal(r.ok, true, JSON.stringify(r));
  const after = f.asset(a.id);
  assert.equal(after.status, 'active');
  assert.equal(after.acquisition_cost_rappen, 1_200_000);
  assert.equal(after.net_book_value_rappen, 1_200_000);
  f.balanced();
  const base = f.reverse(a.id, a.txnId);
  assert.equal(base.ok, true, JSON.stringify(base));
  f.balanced();
});

test('a capitalisation is refused while a run of its period or later stands, not for an earlier run', () => {
  const f = setup();
  const a = f.activeAsset(1_200_000);
  f.depreciate(a.id, '2026-02');
  const cap = assetAddCapitalisation(f.ctx, { assetId: a.id, date: '2026-03-05', amountRappen: 300_000, creditAccountId: f.acc('1020'), idempotencyKey: 'cap' });
  assert.equal(cap.ok, true, JSON.stringify(cap));
  const later = f.depreciate(a.id, '2026-03');
  const refused = f.reverse(a.id, cap.transaction.id);
  assert.equal(refused.error, 'depreciation_posted');
  assert.deepEqual(refused.runIds, [later], 'only the run of the capitalisation period or later blocks');
  assert.equal(assetDepreciationRunReverse(f.ctx, { runId: later, reason: 'neu', idempotencyKey: 'rl' }).ok, true);
  const r = f.reverse(a.id, cap.transaction.id);
  assert.equal(r.ok, true, JSON.stringify(r));
  const after = f.asset(a.id);
  assert.equal(after.acquisition_cost_rappen, 1_200_000);
  assert.equal(after.net_book_value_rappen, 1_200_000 - after.accumulated_depr_rappen);
  f.balanced();
});

test('an opening balance is reversed with its accumulated depreciation, and the asset is closed', () => {
  const f = setup();
  const id = f.draftAsset(4_000_000);
  const open = assetOpeningBalance(f.ctx, { assetId: id, date: '2026-01-01', costRappen: 4_000_000, accumulatedDeprRappen: 1_500_000, offsetAccountId: f.acc('2979'), idempotencyKey: 'open' });
  assert.equal(open.ok, true, JSON.stringify(open));
  const raw = reverseEntry(f.ctx, { entryId: open.journalEntry.id, idempotencyKey: 'raw-open' });
  assert.equal(raw.error, 'owned_by');
  const r = f.reverse(id, open.transaction.id);
  assert.equal(r.ok, true, JSON.stringify(r));
  const comp = f.store.db.prepare('SELECT * FROM asset_transaction WHERE workspace_id = ? AND id = ?').get(f.workspaceId, r.reversalTransactionId);
  assert.equal(comp.type, 'opening_reversal');
  assert.equal(comp.delta_cost_rappen, -4_000_000);
  assert.equal(comp.delta_accum_depr_rappen, -1_500_000);
  assert.equal(f.asset(id).status, 'archived');
  f.balanced();
});

test('a disposal is reversed: the asset is back, the books reconcile, depreciation runs again, the reports drop it', () => {
  const f = setup();
  const a = f.activeAsset(1_200_000);
  f.depreciate(a.id, '2026-02');
  const disp = f.dispose(a.id);
  const blocked = f.reverse(a.id, a.txnId);
  assert.equal(blocked.error, 'asset_disposed');
  assert.equal(blocked.disposalTransactionId, disp);
  const r = f.reverse(a.id, disp);
  assert.equal(r.ok, true, JSON.stringify(r));
  const after = f.asset(a.id);
  assert.equal(after.status, 'active');
  assert.equal(after.disposed_at, null);
  assert.equal(after.disposal_proceeds_rappen, null);
  assert.equal(after.net_book_value_rappen, 1_100_000);
  f.balanced();
  const comp = f.store.db.prepare('SELECT * FROM asset_transaction WHERE workspace_id = ? AND id = ?').get(f.workspaceId, r.reversalTransactionId);
  assert.equal(comp.type, 'disposal_reversal');
  assert.equal(comp.delta_cost_rappen, 1_200_000);
  assert.equal(comp.delta_accum_depr_rappen, 100_000);
  // The asset is depreciable again.
  f.depreciate(a.id, '2026-08');
  f.balanced();
  // Reports do not count an event that was taken back.
  const ds = assetDisposalSummary(f.ctx, { fromDate: '2026-01-01', toDate: '2026-12-31' });
  assert.equal(ds.ok, true, JSON.stringify(ds));
  assert.equal(JSON.stringify(ds).includes(disp), false, 'the reversed disposal is not reported');
  // Back in the register means disposable again: the one-disposal guard counts live disposals only.
  const again = assetDispose(f.ctx, { assetId: a.id, disposalDate: TODAY, proceedsRappen: 0, gainLossAccountId: f.acc('6900'), idempotencyKey: 'disp-again' });
  assert.equal(again.ok, true, JSON.stringify(again));
  assert.equal(f.asset(a.id).status, 'disposed');
  f.balanced();
  // ...and still exactly one LIVE disposal: a third is refused.
  const third = assetDispose(f.ctx, { assetId: a.id, disposalDate: TODAY, proceedsRappen: 0, gainLossAccountId: f.acc('6900'), idempotencyKey: 'disp-third' });
  assert.equal(third.error, 'asset_already_disposed');
});

test('acquisition summary drops a reversed acquisition', () => {
  const f = setup();
  const a = f.activeAsset(1_200_000);
  assert.equal(f.reverse(a.id, a.txnId).ok, true);
  const s = assetAcquisitionSummary(f.ctx, { fromDate: '2026-01-01', toDate: '2026-12-31' });
  assert.equal(s.ok, true, JSON.stringify(s));
  assert.equal(JSON.stringify(s).includes(a.txnId), false);
});

test('a BOOK FROM BEFORE D170: an odd chain is adopted (nothing posted), the forward acts refuse until then', () => {
  const f = setup();
  const a = f.activeAsset(1_200_000);
  // The raw Storno a pre-D170 book could carry: the same mirror shape the raw tool posted then.
  const legacy = reverseOwnedEntry(f.ctx, { entryId: a.entryId, date: '2026-05-31', idempotencyKey: 'legacy' }, OWNER);
  assert.equal(legacy.ok, true, JSON.stringify(legacy));
  // The forward acts that rely on the baseline refuse.
  const cap = assetAddCapitalisation(f.ctx, { assetId: a.id, date: '2026-06-01', amountRappen: 1, creditAccountId: f.acc('1020'), idempotencyKey: 'cap-x' });
  assert.equal(cap.error, 'asset_posting_reversed');
  const pv = assetDisposalPreview(f.ctx, { assetId: a.id, disposalDate: '2026-07-15', proceedsRappen: 0, gainLossAccountId: f.acc('6900') });
  assert.equal(pv.error, 'asset_posting_reversed');
  const run = assetDepreciationRunCreate(f.ctx, { period: '2026-06', assetIds: [a.id], idempotencyKey: 'run-x' });
  assert.equal(JSON.stringify(run).includes('asset_posting_reversed'), true, JSON.stringify(run));
  // The undo adopts the standing mirror.
  const j = f.journals();
  const r = f.reverse(a.id, a.txnId);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.adopted, true);
  assert.equal(r.reversalEntryId, legacy.reversalId);
  assert.equal(f.journals(), j, 'nothing posted on adoption');
  const comp = f.store.db.prepare('SELECT date FROM asset_transaction WHERE workspace_id = ? AND id = ?').get(f.workspaceId, r.reversalTransactionId);
  assert.equal(comp.date, '2026-05-31', 'dated with the GL correction, so every cut-off agrees');
  f.balanced();
});

test('a BOOK FROM BEFORE D170: an even chain posts the mirror against the last link', () => {
  const f = setup();
  const a = f.activeAsset(1_200_000);
  const r1 = reverseOwnedEntry(f.ctx, { entryId: a.entryId, idempotencyKey: 'l1' }, OWNER);
  const r2 = reverseOwnedEntry(f.ctx, { entryId: r1.reversalId, idempotencyKey: 'l2' }, OWNER);
  assert.equal(r2.ok, true, JSON.stringify(r2));
  const j = f.journals();
  const r = f.reverse(a.id, a.txnId);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.adopted, false);
  assert.equal(f.journals(), j + 1);
  const mirror = f.store.db.prepare('SELECT reverses_entry_id AS p FROM journal_entry WHERE workspace_id = ? AND id = ?').get(f.workspaceId, r.reversalEntryId);
  assert.equal(mirror.p, r2.reversalId, 'aimed at the last link');
  f.balanced();
});

test('§H-PERIOD: a sealed today refuses and writes nothing', () => {
  const f = setup();
  const a = f.activeAsset();
  assert.equal(lockPeriodSealed(f.ctx, { period: '2026-08', reason: 'vat_filed', idempotencyKey: 'lk' }).ok, true);
  const j = f.journals();
  const t = f.txns();
  const r = f.reverse(a.id, a.txnId);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'period_locked');
  assert.equal(f.journals(), j);
  assert.equal(f.txns(), t);
  assert.equal(f.asset(a.id).status, 'active');
});

test('§H-PERIOD on the adoption path: a sealed today refuses even when nothing would be posted', () => {
  // The A02 guard cannot catch this one (adoption posts nothing), so the pre-check is what bites.
  const f = setup();
  const a = f.activeAsset();
  assert.equal(reverseOwnedEntry(f.ctx, { entryId: a.entryId, date: '2026-05-31', idempotencyKey: 'legacy' }, OWNER).ok, true);
  assert.equal(lockPeriodSealed(f.ctx, { period: '2026-08', reason: 'vat_filed', idempotencyKey: 'lk' }).ok, true);
  const t = f.txns();
  const r = f.reverse(a.id, a.txnId);
  assert.equal(r.error, 'period_locked');
  assert.equal(f.txns(), t, 'no compensating row');
  assert.equal(f.asset(a.id).status, 'active');
});

test('§H-TENANT and the input guards: a foreign or mismatched id is not_found, depreciation is not_reversible, a blank reason is refused', () => {
  const A = setup('Alpha AG');
  const B = setup('Beta GmbH');
  const a = A.activeAsset();
  const foreign = B.reverse(a.id, a.txnId);
  assert.equal(foreign.error, 'not_found');
  const other = A.activeAsset();
  const mismatch = A.reverse(other.id, a.txnId);
  assert.equal(mismatch.error, 'not_found');
  const run = A.depreciate(a.id, '2026-02');
  const deprRow = A.store.db.prepare("SELECT id FROM asset_transaction WHERE workspace_id = ? AND type = 'depreciation' AND asset_id = ?").get(A.workspaceId, a.id).id;
  const notRev = A.reverse(a.id, deprRow);
  assert.equal(notRev.error, 'not_reversible');
  assert.ok(run);
  const blank = assetTransactionReverse(A.ctx, { assetId: a.id, transactionId: a.txnId, reason: '  ', idempotencyKey: 'b' });
  assert.equal(blank.error, 'reason_required');
});
