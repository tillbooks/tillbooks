// D192, code critic r2 S1: the WHOLE reverse-and-redo matrix of a sale across a year end, proven per
// financial year from the journal rows. Each row asserts every year's profit, 1530, the Abgrenzung
// account (1300 for (g), 2300 for (h)) and the sale account 3200, and that A38's Umsatzabstimmung
// matches (adjusted revenue = declared Ziffer 200) in every year.
//
// The rule under test: the plan sums what the invoice's sale already put on 3200 per financial year and
// posts only the Abgrenzung that brings every year to zero ("each year right by construction").
//
// Every fixture is SYNTHETIC by construction: an invented company, customer, vehicle and amounts. The
// vehicle: cost 40'000.00 on 1530 (opened 01.01.2026), accumulated 25'000.00, NBV 15'000.00; sold for
// 18'000.00 net at 8.1%, so every disposal books a gain of 3'000.00 on 8510.
import test from 'node:test';
import assert from 'node:assert/strict';

import { setup } from '../payments/support.mjs';
import { createDocument, transitionDocument, createCreditNote, issueCreditNote } from '../../dist/core/sales/index.js';
import { createAccount } from '../../dist/core/accounts/index.js';
import { createAssetCategory, createAsset, assetOpeningBalance, assetDispose, assetTransactionReverse } from '../../dist/core/assets/index.js';
import { vatAnnualReconciliation } from '../../dist/core/accruals/index.js';

const COST = 4_000_000;
const P = 1_800_000;
const GAIN = 300_000;

function world() {
  const base = setup({ realPeriods: true });
  const at = (iso) => base.at(`${iso}T00:00:00.000Z`, { realPeriods: true });
  for (const [number, name, type] of [['1539', 'WB Fahrzeuge', 'asset'], ['8510', 'Ausserordentlicher Ertrag', 'income']]) {
    assert.equal(createAccount(base.ctx, { number, name, type, idempotencyKey: `acc-${number}` }).ok, true);
  }
  const cat = createAssetCategory(base.ctx, {
    code: 'FZ', name: 'Fahrzeuge', depreciationMethod: 'straight_line', usefulLifeMonths: 60,
    glAssetAccountId: base.acc('1530'), glAccumDeprAccountId: base.acc('1539'), glDeprExpenseAccountId: base.acc('6800'), idempotencyKey: 'cat',
  });
  const a = createAsset(base.ctx, { categoryId: cat.category.id, name: 'Lieferwagen', acquisitionDate: '2022-01-01', acquisitionCostRappen: COST, idempotencyKey: 'as' });
  assert.equal(assetOpeningBalance(base.ctx, { assetId: a.asset.id, date: '2026-01-01', costRappen: COST, accumulatedDeprRappen: 2_500_000, offsetAccountId: base.acc('2979'), idempotencyKey: 'ob' }).ok, true);
  const assetId = a.asset.id;
  let n = 0;
  const w = {
    ...base,
    assetId,
    invoice(date) {
      const ctx = at(date);
      const c = createDocument(ctx, { type: 'invoice', contactId: base.customerId, lines: [{ description: 'Lieferwagen', unitPriceMinor: P, taxCode: 'UST81' }], idempotencyKey: 'inv-c' });
      assert.equal(c.ok, true, JSON.stringify(c));
      const i = transitionDocument(ctx, { documentId: c.document.id, to: 'issued', idempotencyKey: 'inv-i' });
      assert.equal(i.ok, true, JSON.stringify(i));
      return i.document.id;
    },
    dispose(today, date, invoiceId) {
      n += 1;
      return assetDispose(at(today), { assetId, disposalDate: date, gainLossAccountId: base.acc('8510'), proceedsInvoiceId: invoiceId, idempotencyKey: `d-${n}` });
    },
    reverse(today, transactionId) {
      n += 1;
      const r = assetTransactionReverse(at(today), { assetId, transactionId, reason: 'Verkauf verschoben', overrideProceedsCheck: true, overrideReason: 'Rechnung bleibt, Übergabe folgt', idempotencyKey: `r-${n}` });
      assert.equal(r.ok, true, JSON.stringify(r));
      return r;
    },
    credit(today, invoiceId, amountMinor) {
      const cn = createCreditNote(at(today), { fromInvoiceId: invoiceId, mode: 'partial', amountMinor, idempotencyKey: `cn-${amountMinor}` });
      assert.equal(cn.ok, true, JSON.stringify(cn));
      assert.equal(issueCreditNote(at(today), { creditNoteId: cn.document.id, idempotencyKey: `cni-${amountMinor}` }).ok, true);
    },
    /** One year's facts: profit, 1530, 1300, 2300, 3200, and whether A38 matches. */
    year(y) {
      const net = (number) =>
        base.store.db
          .prepare(
            `SELECT COALESCE(SUM(l.base_debit_minor - l.base_credit_minor), 0) AS n FROM journal_line l
               JOIN journal_entry e ON e.id = l.entry_id JOIN account a ON a.id = l.account_id
              WHERE e.workspace_id = ? AND e.status = 'posted' AND e.date >= ? AND e.date <= ? AND a.number = ?`,
          )
          .get(base.workspaceId, `${y}-01-01`, `${y}-12-31`, number).n;
      const profit = base.store.db
        .prepare(
          `SELECT COALESCE(SUM(l.base_credit_minor - l.base_debit_minor), 0) AS p FROM journal_line l
             JOIN journal_entry e ON e.id = l.entry_id JOIN account a ON a.id = l.account_id
            WHERE e.workspace_id = ? AND e.status = 'posted' AND e.date >= ? AND e.date <= ? AND a.type IN ('income', 'expense')`,
        )
        .get(base.workspaceId, `${y}-01-01`, `${y}-12-31`).p;
      const rec = vatAnnualReconciliation(at(`${y}-12-31`), { year: String(y) });
      assert.equal(rec.ok, true, JSON.stringify(rec));
      return {
        profit,
        a1530: net('1530'),
        a1300: net('1300'),
        a2300: net('2300'),
        a3200: net('3200'),
        a38: rec.umsatz.adjustedRevenueMinor === rec.umsatz.declaredZiffer200Minor ? 'match' : `${rec.umsatz.adjustedRevenueMinor} vs ${rec.umsatz.declaredZiffer200Minor}`,
      };
    },
  };
  return w;
}

const Y = (profit, a1530, a1300, a2300, a3200, a38 = 'match') => ({ profit, a1530, a1300, a2300, a3200, a38 });

// --- (h): invoiced 15.12.2026, handed over 10.01.2027 (A1 deferred_income into 2026) ------------------

test('(h) reverse in the SAME year as the disposal, redo that year (S1): no second deferral; 2026 profit 0, 2027 +gain', () => {
  const w = world();
  const inv = w.invoice('2026-12-15');
  const d1 = w.dispose('2027-01-10', '2027-01-10', inv);
  assert.equal(d1.abgrenzung.kind, 'deferred_income');
  w.reverse('2027-03-01', d1.transaction.id);
  const redo = w.dispose('2027-03-01', '2027-03-01', inv);
  assert.equal(redo.ok, true, JSON.stringify(redo));
  assert.equal(redo.abgrenzung, null);
  assert.deepEqual(w.year(2026), Y(0, COST, 0, -P, 0));
  assert.deepEqual(w.year(2027), Y(GAIN, -COST, 0, P, 0));
});

test('(h) reverse in a LATER year than the disposal (2028), redo in 2028: none posted; 2026 0, 2027 +gain as booked, 2028 nets', () => {
  const w = world();
  const inv = w.invoice('2026-12-15');
  const d1 = w.dispose('2027-01-10', '2027-01-10', inv);
  w.reverse('2028-02-01', d1.transaction.id);
  const redo = w.dispose('2028-02-01', '2028-02-01', inv);
  assert.equal(redo.ok, true, JSON.stringify(redo));
  assert.equal(redo.abgrenzung, null);
  assert.deepEqual(w.year(2026), Y(0, COST, 0, -P, 0));
  assert.deepEqual(w.year(2027), Y(GAIN, -COST, 0, P, 0));
  assert.deepEqual(w.year(2028), Y(0, 0, 0, 0, 0));
});

test('(h) a redo dated in the EARLIER year after the reverse is refused disposal_date_before_reversal, writing nothing', () => {
  const w = world();
  const inv = w.invoice('2026-12-15');
  const d1 = w.dispose('2027-01-10', '2027-01-10', inv);
  w.reverse('2027-03-01', d1.transaction.id);
  const before = [w.year(2026), w.year(2027)];
  const early = w.dispose('2027-03-01', '2026-12-20', inv);
  assert.equal(early.error, 'disposal_date_before_reversal', JSON.stringify(early));
  assert.deepEqual([w.year(2026), w.year(2027)], before);
});

test('(h) a SECOND reverse-and-redo cycle in 2027: still one deferral; 2026 0, 2027 +gain', () => {
  const w = world();
  const inv = w.invoice('2026-12-15');
  const d1 = w.dispose('2027-01-10', '2027-01-10', inv);
  w.reverse('2027-03-01', d1.transaction.id);
  const d2 = w.dispose('2027-03-01', '2027-03-01', inv);
  w.reverse('2027-04-01', d2.transaction.id);
  const d3 = w.dispose('2027-04-01', '2027-04-01', inv);
  assert.equal(d3.ok, true, JSON.stringify(d3));
  assert.equal(d3.abgrenzung, null);
  assert.deepEqual(w.year(2026), Y(0, COST, 0, -P, 0));
  assert.deepEqual(w.year(2027), Y(GAIN, -COST, 0, P, 0));
});

test('(h) a partial credit note BETWEEN reverse and redo: the redo clears the full line, the reduction stays on 3200; a full credit refuses the redo', () => {
  const w = world();
  const inv = w.invoice('2026-12-15');
  const d1 = w.dispose('2027-01-10', '2027-01-10', inv);
  w.reverse('2027-03-01', d1.transaction.id);
  w.credit('2027-03-01', inv, 100_000);
  const redo = w.dispose('2027-03-01', '2027-03-01', inv);
  assert.equal(redo.ok, true, JSON.stringify(redo));
  assert.equal(redo.abgrenzung, null);
  assert.ok(redo.warnings.some((x) => x.code === 'sale_reduced'));
  assert.deepEqual(w.year(2026), Y(0, COST, 0, -P, 0));
  assert.deepEqual(w.year(2027), Y(GAIN - 100_000, -COST, 0, P, 100_000));
});

test('(h) a FULL credit note between reverse and redo: the invoice no longer stands, the redo is refused not_standing', () => {
  const w = world();
  const inv = w.invoice('2026-12-15');
  const d1 = w.dispose('2027-01-10', '2027-01-10', inv);
  w.reverse('2027-03-01', d1.transaction.id);
  const cn = createCreditNote(w.at('2027-03-01T00:00:00.000Z', { realPeriods: true }), { fromInvoiceId: inv, mode: 'full', idempotencyKey: 'cn-full' });
  assert.equal(issueCreditNote(w.at('2027-03-01T00:00:00.000Z', { realPeriods: true }), { creditNoteId: cn.document.id, idempotencyKey: 'cn-full-i' }).ok, true);
  assert.equal(w.dispose('2027-03-01', '2027-03-01', inv).reason, 'not_standing');
  // The sale undone: 2027 holds the deferral's release and the credit note, which net on 3200.
  assert.deepEqual(w.year(2026), Y(0, COST, 0, -P, 0));
  assert.deepEqual(w.year(2027), Y(0, 0, 0, P, 0));
});

// --- (g): handed over 28.12.2026, invoiced 03.01.2027 (A1 accrued_income into 2026) ------------------
// The reverse of a (g) disposal always falls in the later year: the invoice it needs is dated there.

test('(g) reverse in the LATER year, redo in it: none posted; 2026 +gain as booked with 1300 open, 2027 nets', () => {
  const w = world();
  const inv = w.invoice('2027-01-03');
  const d1 = w.dispose('2027-01-05', '2026-12-28', inv);
  assert.equal(d1.abgrenzung.kind, 'accrued_income');
  w.reverse('2027-02-20', d1.transaction.id);
  const redo = w.dispose('2027-02-20', '2027-02-20', inv);
  assert.equal(redo.ok, true, JSON.stringify(redo));
  assert.equal(redo.abgrenzung, null);
  assert.deepEqual(w.year(2026), Y(GAIN, 0, P, 0, 0));
  assert.deepEqual(w.year(2027), Y(0, 0, -P, 0, 0));
});

test('(g) a redo dated in the EARLIER year after the reverse is refused disposal_date_before_reversal', () => {
  const w = world();
  const inv = w.invoice('2027-01-03');
  const d1 = w.dispose('2027-01-05', '2026-12-28', inv);
  w.reverse('2027-02-20', d1.transaction.id);
  assert.equal(w.dispose('2027-02-20', '2026-12-29', inv).error, 'disposal_date_before_reversal');
});

test('(g) a SECOND reverse-and-redo cycle: still right in both years', () => {
  const w = world();
  const inv = w.invoice('2027-01-03');
  const d1 = w.dispose('2027-01-05', '2026-12-28', inv);
  w.reverse('2027-02-20', d1.transaction.id);
  const d2 = w.dispose('2027-02-20', '2027-02-20', inv);
  w.reverse('2027-03-01', d2.transaction.id);
  const d3 = w.dispose('2027-03-01', '2027-03-01', inv);
  assert.equal(d3.ok, true, JSON.stringify(d3));
  assert.equal(d3.abgrenzung, null);
  assert.deepEqual(w.year(2026), Y(GAIN, 0, P, 0, 0));
  assert.deepEqual(w.year(2027), Y(0, 0, -P, 0, 0));
});

test('(g) a partial credit note between reverse and redo: the reduction stays on 3200 in 2027', () => {
  const w = world();
  const inv = w.invoice('2027-01-03');
  const d1 = w.dispose('2027-01-05', '2026-12-28', inv);
  w.reverse('2027-02-20', d1.transaction.id);
  w.credit('2027-02-20', inv, 100_000);
  const redo = w.dispose('2027-02-20', '2027-02-20', inv);
  assert.equal(redo.ok, true, JSON.stringify(redo));
  assert.deepEqual(w.year(2026), Y(GAIN, 0, P, 0, 0));
  assert.deepEqual(w.year(2027), Y(-100_000, 0, -P, 0, 100_000));
});

// --- the first disposal and the reverse alone, the matrix's base cases ---------------------------------

test('the base cases: a first (h) and a first (g) post exactly one Abgrenzung; a reverse alone leaves "invoiced, not disposed" in the year of the reverse', () => {
  const h = world();
  const invH = h.invoice('2026-12-15');
  const dh = h.dispose('2027-01-10', '2027-01-10', invH);
  assert.equal(dh.abgrenzung.kind, 'deferred_income');
  assert.equal(dh.abgrenzung.periodEnd, '2026-12-31');
  assert.deepEqual(h.year(2026), Y(0, COST, 0, -P, 0));
  assert.deepEqual(h.year(2027), Y(GAIN, -COST, 0, P, 0));
  h.reverse('2027-03-01', dh.transaction.id);
  assert.deepEqual(h.year(2027), Y(P, 0, 0, P, -P), 'the sale is turnover of 2027 until it is disposed again');
  const g = world();
  const invG = g.invoice('2027-01-03');
  const dg = g.dispose('2027-01-05', '2026-12-28', invG);
  assert.equal(dg.abgrenzung.kind, 'accrued_income');
  assert.deepEqual(g.year(2026), Y(GAIN, 0, P, 0, 0));
  assert.deepEqual(g.year(2027), Y(0, 0, -P, 0, 0));
});
