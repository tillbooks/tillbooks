// D192 code critic r3 (non-author): the S1 rule (the sale account summed per year for this invoice) from the
// journal rows, and the attempts to fool the sum: a manual journal and another invoice on the same account
// in the same year, a foreign workspace, a redo in a later year than the reverse, and the redo's ROW counts.
//
// Every fixture is SYNTHETIC by construction: an invented company, customer, vehicle and amounts.
import test from 'node:test';
import assert from 'node:assert/strict';

import { setup, secondWorkspace } from '../payments/support.mjs';
import { createDocument, transitionDocument, createCreditNote, issueCreditNote } from '../../dist/core/sales/index.js';
import { createAccount } from '../../dist/core/accounts/index.js';
import { postEntry } from '../../dist/core/ledger/postEntry.js';
import { createAssetCategory, createAsset, assetOpeningBalance, assetDispose, assetTransactionReverse } from '../../dist/core/assets/index.js';
import { vatAnnualReconciliation } from '../../dist/core/accruals/index.js';
import { lockPeriod } from '../../dist/core/ledger/index.js';

const COST = 4_000_000;
const ACCUM = 2_500_000;
const P = 1_800_000;
const Y = (y) => [`${y}-01-01`, `${y}-12-31`];

function world() {
  const t = setup({ realPeriods: true });
  t.at2 = (iso) => t.at(`${iso}T00:00:00.000Z`, { realPeriods: true });
  for (const [number, name, type] of [['1539', 'WB Fahrzeuge', 'asset'], ['8510', 'Ausserordentlicher Ertrag', 'income']]) {
    assert.equal(createAccount(t.ctx, { number, name, type, idempotencyKey: `acc-${number}` }).ok, true);
  }
  let n = 0;
  t.vehicle = () => {
    n += 1;
    const cat = createAssetCategory(t.ctx, {
      code: `FZ-${n}`, name: 'Fahrzeuge', depreciationMethod: 'straight_line', usefulLifeMonths: 60,
      glAssetAccountId: t.acc('1530'), glAccumDeprAccountId: t.acc('1539'), glDeprExpenseAccountId: t.acc('6800'), idempotencyKey: `cat-${n}`,
    });
    const a = createAsset(t.ctx, { categoryId: cat.category.id, name: `Lieferwagen ${n}`, acquisitionDate: '2022-01-01', acquisitionCostRappen: COST, idempotencyKey: `as-${n}` });
    assert.equal(assetOpeningBalance(t.ctx, { assetId: a.asset.id, date: '2026-01-01', costRappen: COST, accumulatedDeprRappen: ACCUM, offsetAccountId: t.acc('2979'), idempotencyKey: `ob-${n}` }).ok, true);
    return a.asset.id;
  };
  t.invoice = (ctx, key, net = P) => {
    const c = createDocument(ctx, { type: 'invoice', contactId: t.customerId, lines: [{ description: 'Lieferwagen', unitPriceMinor: net, taxCode: 'UST81' }], idempotencyKey: `${key}-c` });
    const i = transitionDocument(ctx, { documentId: c.document.id, to: 'issued', idempotencyKey: `${key}-i` });
    assert.equal(i.ok, true, JSON.stringify(i));
    return i.document;
  };
  t.dispose = (ctx, assetId, date, invoiceId, key) =>
    assetDispose(ctx, { assetId, disposalDate: date, gainLossAccountId: t.acc('8510'), proceedsInvoiceId: invoiceId, idempotencyKey: key });
  t.reverse = (ctx, assetId, transactionId, key) =>
    assetTransactionReverse(ctx, { assetId, transactionId, reason: 'Korrektur', overrideProceedsCheck: true, overrideReason: 'Neu datieren', idempotencyKey: key });
  t.net = ([from, to]) => {
    const rows = t.store.db.prepare(
      `SELECT a.number AS number, SUM(l.base_debit_minor - l.base_credit_minor) AS net FROM journal_line l
         JOIN journal_entry e ON e.id = l.entry_id JOIN account a ON a.id = l.account_id
        WHERE e.workspace_id = ? AND e.status = 'posted' AND e.date >= ? AND e.date <= ? GROUP BY a.number`,
    ).all(t.workspaceId, from, to);
    const o = Object.fromEntries(rows.map((r) => [r.number, r.net]));
    return (k) => o[k] ?? 0;
  };
  t.profit = ([from, to]) => t.store.db.prepare(
    `SELECT COALESCE(SUM(l.base_credit_minor - l.base_debit_minor), 0) AS p FROM journal_line l
       JOIN journal_entry e ON e.id = l.entry_id JOIN account a ON a.id = l.account_id
      WHERE e.workspace_id = ? AND e.status = 'posted' AND e.date >= ? AND e.date <= ? AND a.type IN ('income','expense')`,
  ).get(t.workspaceId, from, to).p;
  t.umsatzDiff = (ctx, year) => vatAnnualReconciliation(ctx, { year }).umsatz.differenceMinor;
  t.count = (table) => t.store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  t.counts = () => Object.fromEntries(['asset_transaction', 'journal_entry', 'journal_line', 'accrual', 'audit_log'].map((x) => [x, t.count(x)]));
  return t;
}

/** (h): invoice 15.12.2026, disposal 10.01.2027, reverse 01.03.2027. */
function hReversed(w) {
  const assetId = w.vehicle();
  const inv = w.invoice(w.at2('2026-12-15'), 'h');
  const d1 = w.dispose(w.at2('2027-01-10'), assetId, '2027-01-10', inv.id, 'h-1');
  assert.equal(d1.ok, true, JSON.stringify(d1));
  assert.equal(w.reverse(w.at2('2027-03-01'), assetId, d1.transaction.id, 'h-r1').ok, true);
  return { assetId, inv, d1 };
}

test('(h) redo 2027 from the rows: no second deferral; 2026 3200 0, 2300 -P, profit 0; 2027 3200 0, 2300 0, profit +300000; A38 matches; replay writes nothing', () => {
  const w = world();
  const { assetId, inv } = hReversed(w);
  const mar = w.at2('2027-03-01');
  const c0 = w.counts();
  const redo = w.dispose(mar, assetId, '2027-03-01', inv.id, 'h-2');
  assert.equal(redo.ok, true, JSON.stringify(redo));
  assert.equal(redo.abgrenzung, null);
  const c1 = w.counts();
  assert.deepEqual([c1.asset_transaction - c0.asset_transaction, c1.journal_entry - c0.journal_entry, c1.accrual - c0.accrual], [1, 1, 0]);
  assert.deepEqual(w.dispose(mar, assetId, '2027-03-01', inv.id, 'h-2'), redo);
  assert.deepEqual(w.counts(), c1, 'the replay writes no row');
  const y26 = w.net(Y(2026));
  const y27 = w.net(Y(2027));
  assert.deepEqual([y26('3200'), y26('2300'), w.profit(Y(2026))], [0, -P, 0]);
  assert.deepEqual([y27('3200'), y27('2300'), y27('1530'), w.profit(Y(2027))], [0, P, -COST, 300_000]);
  assert.equal(w.umsatzDiff(mar, '2026'), 0);
  assert.equal(w.umsatzDiff(mar, '2027'), 0);
});

test('(h) a second cycle (reverse 01.04., redo 01.04.2027): still one deferral; 2026 profit 0, 2027 +300000', () => {
  const w = world();
  const { assetId, inv } = hReversed(w);
  const d2 = w.dispose(w.at2('2027-03-01'), assetId, '2027-03-01', inv.id, 'h-2');
  assert.equal(d2.ok, true, JSON.stringify(d2));
  const apr = w.at2('2027-04-01');
  assert.equal(w.reverse(apr, assetId, d2.transaction.id, 'h-r2').ok, true);
  const d3 = w.dispose(apr, assetId, '2027-04-01', inv.id, 'h-3');
  assert.equal(d3.ok, true, JSON.stringify(d3));
  assert.equal(d3.abgrenzung, null);
  assert.equal(w.count("accrual WHERE source_ref LIKE 'asset_transaction:%'"), 1);
  const y26 = w.net(Y(2026));
  const y27 = w.net(Y(2027));
  assert.deepEqual([y26('3200'), y26('2300'), w.profit(Y(2026))], [0, -P, 0]);
  assert.deepEqual([y27('3200'), y27('2300'), y27('8510'), w.profit(Y(2027))], [0, P, -300_000, 300_000]);
});

test('(g) a partial credit note of 100000 between reverse and redo: 2026 +300000 with 1300 +P; 2027 3200 +100000 (the reduction where it booked), profit -100000; A38 matches', () => {
  const w = world();
  const assetId = w.vehicle();
  const inv = w.invoice(w.at2('2027-01-03'), 'g');
  const d1 = w.dispose(w.at2('2027-01-05'), assetId, '2026-12-28', inv.id, 'g-1');
  assert.equal(d1.ok, true, JSON.stringify(d1));
  const feb = w.at2('2027-02-20');
  assert.equal(w.reverse(feb, assetId, d1.transaction.id, 'g-r').ok, true);
  const cn = createCreditNote(feb, { fromInvoiceId: inv.id, mode: 'partial', amountMinor: 100_000, idempotencyKey: 'g-cn' });
  assert.equal(cn.ok, true, JSON.stringify(cn));
  assert.equal(issueCreditNote(feb, { creditNoteId: cn.document.id, idempotencyKey: 'g-cni' }).ok, true);
  const redo = w.dispose(feb, assetId, '2027-02-20', inv.id, 'g-2');
  assert.equal(redo.ok, true, JSON.stringify(redo));
  assert.equal(redo.abgrenzung, null);
  const y26 = w.net(Y(2026));
  const y27 = w.net(Y(2027));
  assert.deepEqual([y26('3200'), y26('1300'), w.profit(Y(2026))], [0, P, 300_000]);
  assert.deepEqual([y27('3200'), y27('1300'), y27('8510'), w.profit(Y(2027))], [100_000, -P, 0, -100_000]);
  assert.equal(w.umsatzDiff(feb, '2026'), 0);
  assert.equal(w.umsatzDiff(feb, '2027'), 0);
});

test('the sum is not fooled: a manual journal and another invoice on 3200 in both years leave the (h) redo with no Abgrenzung and the first (h) with exactly P', () => {
  const w = world();
  // Noise on the same sale account, both years, BEFORE the first disposal.
  for (const [date, key] of [['2026-12-20', 'm26'], ['2027-02-01', 'm27']]) {
    const m = postEntry(w.ctx, { date, source: 'manual', idempotencyKey: key, lines: [{ account: w.acc('1020'), debit: 55_500 }, { account: w.acc('3200'), credit: 55_500 }] });
    assert.equal(m.ok, true, JSON.stringify(m));
  }
  w.invoice(w.at2('2026-12-16'), 'other', 777_700);
  const { assetId, inv, d1 } = hReversed(w);
  const a = w.store.db.prepare('SELECT amount_minor FROM accrual WHERE id = ?').get(d1.abgrenzung.accrualId);
  assert.equal(a.amount_minor, P, 'the first deferral is exactly the sale');
  const redo = w.dispose(w.at2('2027-03-01'), assetId, '2027-03-01', inv.id, 'h-2');
  assert.equal(redo.ok, true, JSON.stringify(redo));
  assert.equal(redo.abgrenzung, null);
});

test('§H-TENANT on the sums: a foreign workspace\'s planted disposal row and accrual on this invoice id change nothing in the year rule', () => {
  const w = world();
  const other = secondWorkspace(w);
  const assetId = w.vehicle();
  const inv = w.invoice(w.at2('2026-12-15'), 'h');
  // Foreign: an entry on ITS 3200 in 2026, a disposal row storing THIS invoice id, an accrual on that row.
  const fe = postEntry(other.ctx, { date: '2026-12-20', source: 'manual', idempotencyKey: 'fe', lines: [{ account: other.acc('3200'), debit: 999_900 }, { account: other.acc('1020'), credit: 999_900 }] });
  assert.equal(fe.ok, true, JSON.stringify(fe));
  const cat = createAssetCategory(other.ctx, { code: 'FZ-O', name: 'Fahrzeuge', depreciationMethod: 'straight_line', usefulLifeMonths: 60, glAssetAccountId: other.acc('1530'), glAccumDeprAccountId: other.acc('1510'), glDeprExpenseAccountId: other.acc('6800'), idempotencyKey: 'o-cat' });
  const fa = createAsset(other.ctx, { categoryId: cat.category.id, name: 'Fremd', acquisitionDate: '2026-01-01', acquisitionCostRappen: 100, idempotencyKey: 'o-as' });
  w.store.db.prepare(
    `INSERT INTO asset_transaction (id, workspace_id, asset_id, type, date, delta_cost_rappen, delta_accum_depr_rappen, proceeds_rappen, gain_loss_rappen, journal_entry_id, source_document_type, source_document_id, description, created_at, created_by, idempotency_key)
     VALUES ('atxn_foreign', ?, ?, 'disposal', '2026-12-20', 0, 0, 0, 0, ?, 'invoice', ?, 'fremd', '2026-12-20', 'x', 'foreign')`,
  ).run(other.workspaceId, fa.asset.id, fe.entryId, inv.id);
  w.store.db.prepare(
    `INSERT INTO accrual (id, workspace_id, kind, period_end, reversal_date, amount_minor, balance_account_id, contra_account_id, description, source_ref, status, entry_id, idempotency_key, created_by, created_at, updated_at)
     VALUES ('accrual_foreign', ?, 'accrued_income', '2026-12-31', '2027-01-01', 999900, ?, ?, 'fremd', 'asset_transaction:atxn_foreign', 'posted', ?, 'f-acc', 'x', '2026-12-31', '2026-12-31')`,
  ).run(other.workspaceId, other.acc('1300'), other.acc('3200'), fe.entryId);
  const d = w.dispose(w.at2('2027-01-10'), assetId, '2027-01-10', inv.id, 'ten');
  assert.equal(d.ok, true, JSON.stringify(d));
  assert.equal(d.abgrenzung.kind, 'deferred_income');
  const a = w.store.db.prepare('SELECT amount_minor FROM accrual WHERE id = ?').get(d.abgrenzung.accrualId);
  assert.equal(a.amount_minor, P);
});

test('a redo in a LATER year than the reverse (reverse 01.03.2027, redo 15.01.2028): the deferral of 2027 is posted, every year right', () => {
  const w = world();
  const { assetId, inv } = hReversed(w);
  const jan28 = w.at2('2028-01-15');
  const redo = w.dispose(jan28, assetId, '2028-01-15', inv.id, 'h-28');
  assert.equal(redo.ok, true, JSON.stringify(redo));
  assert.equal(redo.abgrenzung?.kind, 'deferred_income');
  assert.equal(redo.abgrenzung?.periodEnd, '2027-12-31');
  assert.equal(w.profit(Y(2026)), 0);
  assert.equal(w.profit(Y(2027)), 0, 'disposed and reversed in 2027, the invoice deferred again');
  assert.equal(w.profit(Y(2028)), 300_000);
  for (const y of ['2026', '2027', '2028']) assert.equal(w.net(Y(y))('3200'), 0, y);
});

test('a period sealed between cycles: (h) with December 2026 hard-locked after the first disposal; the 2027 redo needs no Abgrenzung and posts, nothing lands in 2026', () => {
  const w = world();
  const { assetId, inv } = hReversed(w);
  const mar = w.at2('2027-03-01');
  assert.equal(lockPeriod(mar, { period: '2026-12', kind: 'hard', idempotencyKey: 'seal' }).ok, true);
  const before = w.net(Y(2026));
  const redo = w.dispose(mar, assetId, '2027-03-01', inv.id, 'h-sealed');
  assert.equal(redo.ok, true, JSON.stringify(redo));
  assert.equal(redo.abgrenzung, null);
  const after = w.net(Y(2026));
  for (const k of ['3200', '2300', '1530']) assert.equal(after(k), before(k), k);
});

test('the Abgrenzung amount is what is OPEN, not P: a manual clearing of 1000000 in 2026, reversed in 2027, then the 2027 redo defers 800000 and every year nets on 3200', () => {
  const w = world();
  const assetId = w.vehicle();
  const inv = w.invoice(w.at2('2026-12-15'), 'open');
  const dec = w.at2('2026-12-20');
  const d1 = assetDispose(dec, { assetId, disposalDate: '2026-12-20', gainLossAccountId: w.acc('8510'), proceedsInvoiceId: inv.id, proceedsBooking: 'book_proceeds', proceedsBookingReason: 'Teil von Hand', proceedsRappen: 1_000_000, proceedsAccountId: w.acc('3200'), idempotencyKey: 'open-1' });
  assert.equal(d1.ok, true, JSON.stringify(d1));
  const mar = w.at2('2027-03-01');
  assert.equal(w.reverse(mar, assetId, d1.transaction.id, 'open-r').ok, true);
  const redo = w.dispose(mar, assetId, '2027-03-01', inv.id, 'open-2');
  assert.equal(redo.ok, true, JSON.stringify(redo));
  assert.equal(redo.abgrenzung?.kind, 'deferred_income');
  assert.equal(w.store.db.prepare('SELECT amount_minor FROM accrual WHERE id = ?').get(redo.abgrenzung.accrualId).amount_minor, 800_000);
  assert.equal(w.net(Y(2026))('3200'), 0);
  assert.equal(w.net(Y(2027))('3200'), 0);
  assert.equal(w.profit(Y(2026)) + w.profit(Y(2027)), 300_000, 'the gain once over both years');
});
