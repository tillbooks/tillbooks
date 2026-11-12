// D192: a disposal linked to an invoice clears via the invoice's sale line, and a sale across a year end
// posts its A38 Abgrenzung in the same transaction. Every worked example of D192 point 9 and point 11,
// (a) to (h), as journals and as each year's net per account; the refusals; the money-path invariants.
//
// Every fixture is SYNTHETIC by construction: an invented company, customer, vehicle and amounts. The
// asset is the paper's Lieferwagen: cost 40'000.00 on 1530, accumulated 25'000.00 on 1539, NBV 15'000.00,
// gain to 8510, loss to 8500 (accounts the KMU Schulkontenrahmen names, added to the seed here).
import test from 'node:test';
import assert from 'node:assert/strict';

import { setup, secondWorkspace, seedRate } from '../payments/support.mjs';
import { createDocument, transitionDocument, createCreditNote, issueCreditNote } from '../../dist/core/sales/index.js';
import { recordPayment, allocatePayment, PAYMENT_INTENTS } from '../../dist/core/payments/payment.js';
import { createAccount } from '../../dist/core/accounts/index.js';
import { settingsSet } from '../../dist/core/settings/index.js';
import { lockPeriod } from '../../dist/core/ledger/index.js';
import { detectAnomalies } from '../../dist/core/agent/anomalies.js';
import {
  createAssetCategory,
  createAsset,
  assetOpeningBalance,
  assetDispose,
  assetDisposalPreview,
  assetTransactionReverse,
  assetLedgerGet,
} from '../../dist/core/assets/index.js';
import { accrualCreate, accrualReverse, accrualDiscard, vatAnnualReconciliation } from '../../dist/core/accruals/index.js';

const COST = 4_000_000;
const ACCUM = 2_500_000;

// Real ports throughout (A03's period lock AND its audit trail): `asset_ledger_get` reads the
// `proceeds_cleared` audit row, which the permissive test port would never write.
function world() {
  const base = setup({ realPeriods: true });
  const t = { ...base, ctx: base.ctx, at: (iso) => base.at(iso, { realPeriods: true }) };
  for (const [number, name, type] of [
    ['1539', 'Wertberichtigung Fahrzeuge', 'asset'],
    ['8500', 'Ausserordentlicher Aufwand', 'expense'],
    ['8510', 'Ausserordentlicher Ertrag', 'income'],
  ]) {
    const r = createAccount(t.ctx, { number, name, type, idempotencyKey: `acc-${number}` });
    assert.equal(r.ok, true, JSON.stringify(r));
  }
  let n = 0;
  /** The paper's Lieferwagen, seated by an opening balance on 01.01.2026. */
  const vehicle = (ctx = t.ctx) => {
    n += 1;
    const cat = createAssetCategory(ctx, {
      code: `FZ-${n}`, name: 'Fahrzeuge', depreciationMethod: 'straight_line', usefulLifeMonths: 60,
      glAssetAccountId: t.acc('1530'), glAccumDeprAccountId: t.acc('1539'), glDeprExpenseAccountId: t.acc('6800'),
      idempotencyKey: `cat-${n}`,
    });
    assert.equal(cat.ok, true, JSON.stringify(cat));
    const a = createAsset(ctx, { categoryId: cat.category.id, name: `Lieferwagen ${n}`, acquisitionDate: '2022-01-01', acquisitionCostRappen: COST, idempotencyKey: `as-${n}` });
    assert.equal(a.ok, true, JSON.stringify(a));
    const ob = assetOpeningBalance(ctx, { assetId: a.asset.id, date: '2026-01-01', costRappen: COST, accumulatedDeprRappen: ACCUM, offsetAccountId: t.acc('2979'), idempotencyKey: `ob-${n}` });
    assert.equal(ob.ok, true, JSON.stringify(ob));
    return a.asset.id;
  };
  /** An issued invoice, one position per `lines` entry, on the default revenue account 3200. */
  const invoice = (ctx, key, lines, currency) => {
    const created = createDocument(ctx, {
      type: 'invoice', contactId: t.customerId,
      lines: lines.map(([description, net, taxCode = 'UST81']) => ({ description, unitPriceMinor: net, taxCode })),
      ...(currency !== undefined ? { currency } : {}),
      idempotencyKey: `${key}-create`,
    });
    assert.equal(created.ok, true, JSON.stringify(created));
    const issued = transitionDocument(ctx, { documentId: created.document.id, to: 'issued', idempotencyKey: `${key}-issue` });
    assert.equal(issued.ok, true, JSON.stringify(issued));
    return issued.document;
  };
  const pay = (ctx, { invoiceId, amountMinor, date, key, currency = 'CHF' }) => {
    const p = recordPayment(ctx, {
      direction: 'incoming', date, amountMinor, currency, bankAccountId: t.acc('1020'),
      counterpartyKind: 'customer', counterpartyId: t.customerId,
      allocations: invoiceId ? [{ documentId: invoiceId, amountMinor }] : [], intent: PAYMENT_INTENTS.record, idempotencyKey: key,
    });
    assert.equal(p.ok, true, JSON.stringify(p));
    return p.paymentId;
  };
  const dispose = (ctx, assetId, date, extra = {}, key = `d-${assetId}-${date}`) =>
    assetDispose(ctx, { assetId, disposalDate: date, gainLossAccountId: extra.gainLossAccountId ?? t.acc(extra.loss ? '8500' : '8510'), ...extra, loss: undefined, idempotencyKey: key });
  const fullCredit = (ctx, invoiceId, key) => {
    const cn = createCreditNote(ctx, { fromInvoiceId: invoiceId, mode: 'full', idempotencyKey: `${key}-cn` });
    assert.equal(cn.ok, true, JSON.stringify(cn));
    const issued = issueCreditNote(ctx, { creditNoteId: cn.document.id, idempotencyKey: `${key}-cn-issue` });
    assert.equal(issued.ok, true, JSON.stringify(issued));
    return cn.document.id;
  };
  const refund = (ctx, creditNoteId, amountMinor, date, key) => {
    const p = recordPayment(ctx, {
      direction: 'outgoing', date, amountMinor, currency: 'CHF', bankAccountId: t.acc('1020'),
      counterpartyKind: 'customer', counterpartyId: t.customerId,
      allocations: [{ documentId: creditNoteId, amountMinor }], intent: PAYMENT_INTENTS.record, idempotencyKey: key,
    });
    assert.equal(p.ok, true, JSON.stringify(p));
  };
  const setSetting = (ctx, key, value, idem = `${key}-${value}`) => {
    const r = settingsSet(ctx, { key, value, reason: 'Testfall', idempotencyKey: idem });
    assert.equal(r.ok, true, JSON.stringify(r));
  };
  /** Net base movement (debit plus, credit minus) per account number over [from, to], posted entries. */
  const nets = (from = '0000-01-01', to = '9999-12-31', ws = t.workspaceId) => {
    const rows = t.store.db
      .prepare(
        `SELECT a.number AS number, SUM(l.base_debit_minor - l.base_credit_minor) AS net
           FROM journal_line l JOIN journal_entry e ON e.id = l.entry_id JOIN account a ON a.id = l.account_id
          WHERE e.workspace_id = ? AND e.status = 'posted' AND e.date >= ? AND e.date <= ?
          GROUP BY a.number`,
      )
      .all(ws, from, to);
    const out = {};
    for (const r of rows) out[r.number] = r.net;
    return (number) => out[number] ?? 0;
  };
  /** Profit over [from, to]: income and expense, credit minus debit. */
  const profit = (from, to) =>
    t.store.db
      .prepare(
        `SELECT COALESCE(SUM(l.base_credit_minor - l.base_debit_minor), 0) AS p
           FROM journal_line l JOIN journal_entry e ON e.id = l.entry_id JOIN account a ON a.id = l.account_id
          WHERE e.workspace_id = ? AND e.status = 'posted' AND e.date >= ? AND e.date <= ? AND a.type IN ('income', 'expense')`,
      )
      .get(t.workspaceId, from, to).p;
  /** The posted lines of an entry as `number:debit:credit`, sorted. */
  const legs = (entryId) =>
    t.store.db
      .prepare(
        `SELECT a.number AS number, l.debit_minor AS d, l.credit_minor AS c, l.tax_code AS tc FROM journal_line l
           JOIN account a ON a.id = l.account_id WHERE l.entry_id = ? ORDER BY a.number, l.debit_minor DESC`,
      )
      .all(entryId)
      .map((r) => `${r.number}:${r.d}:${r.c}`);
  const count = (table) => t.store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  const counts = () => Object.fromEntries(['asset_transaction', 'journal_entry', 'journal_line', 'accrual', 'audit_log', 'asset'].map((x) => [x, count(x)]));
  return { ...t, vehicle, invoice, pay, dispose, fullCredit, refund, setSetting, nets, profit, legs, counts };
}

const Y26 = ['2026-01-01', '2026-12-31'];
const Y27 = ['2027-01-01', '2027-12-31'];

// --- (a) to (f): one financial year -----------------------------------------------------------------

test('(a) a sale at a gain, invoice at 8.1%: the disposal clears 3200 from the invoice, and 1100, the bank, 2200 and 3200 carry the sale once', () => {
  const w = world();
  const assetId = w.vehicle();
  const inv = w.invoice(w.ctx, 'a', [['Lieferwagen', 1_800_000]]);
  assert.deepEqual(w.legs(inv.postedEntryId), ['1100:1945800:0', '2200:0:145800', '3200:0:1800000']);
  w.pay(w.ctx, { invoiceId: inv.id, amountMinor: 1_945_800, date: '2026-07-19', key: 'a-pay' });
  const d = w.dispose(w.ctx, assetId, '2026-07-19', { proceedsInvoiceId: inv.id });
  assert.equal(d.ok, true, JSON.stringify(d));
  assert.equal(d.proceedsFromDocument, true);
  assert.equal(d.proceedsBooking, 'clear_via_document');
  assert.equal(d.transaction.proceedsRappen, 1_800_000);
  assert.equal(d.gainLossRappen, 300_000);
  assert.equal(d.abgrenzung, null);
  assert.deepEqual(w.legs(d.journalEntry.id), ['1530:0:4000000', '1539:2500000:0', '3200:1800000:0', '8510:0:300000']);
  const clearing = w.store.db.prepare(`SELECT tax_code FROM journal_line l JOIN account a ON a.id = l.account_id WHERE l.entry_id = ? AND a.number = '3200'`).get(d.journalEntry.id);
  assert.equal(clearing.tax_code, null, 'the clearing line carries no tax code: Ziffer 200 keeps the invoice\'s figure');
  const net = w.nets();
  assert.equal(net('1100'), 0);
  assert.equal(net('1020'), 1_945_800);
  assert.equal(net('2200'), -145_800);
  assert.equal(net('3200'), 0);
  assert.equal(net('8510'), -300_000);
  const ledger = assetLedgerGet(w.ctx, { assetId });
  const ev = ledger.events.find((e) => e.type === 'disposal');
  assert.equal(ev.proceedsBooking, 'clear_via_document');
  assert.equal(ev.migrationHint, null);
  assert.equal(ledger.proceedsBookingSetting, 'clear_via_document');
  // A38: the disposal is excluded from the statements' revenue; no Sonderposten; no difference.
  const rec = vatAnnualReconciliation(w.ctx, { year: '2026' });
  assert.equal(rec.ok, true, JSON.stringify(rec));
  assert.equal(rec.umsatz.revenuePerStatementsMinor, 1_800_000);
  assert.deepEqual(rec.umsatz.adjustments.filter((x) => x.kind === 'asset_disposal'), []);
  assert.equal(rec.umsatz.differenceMinor, 0);
});

test('(b) a sale at a loss: Dr 3200 12000.00 and Dr 8500 3000.00 against Cr 1530; 3200 nets to zero', () => {
  const w = world();
  const assetId = w.vehicle();
  const inv = w.invoice(w.ctx, 'b', [['Lieferwagen', 1_200_000]]);
  const d = w.dispose(w.ctx, assetId, '2026-07-19', { proceedsInvoiceId: inv.id, loss: true });
  assert.equal(d.ok, true, JSON.stringify(d));
  assert.equal(d.gainLossRappen, -300_000);
  assert.deepEqual(w.legs(d.journalEntry.id), ['1530:0:4000000', '1539:2500000:0', '3200:1200000:0', '8500:300000:0']);
  const net = w.nets();
  assert.equal(net('1100'), 1_297_200);
  assert.equal(net('2200'), -97_200);
  assert.equal(net('3200'), 0);
  assert.equal(net('8500'), 300_000);
});

test('(c) an EUR invoice: the disposal clears the sale line\'s BOOKED CHF (18800.00 at 0.9400), never a re-conversion; the payment\'s FX stays on 3806', () => {
  const w = world();
  const assetId = w.vehicle();
  seedRate(w.ctx, { currency: 'EUR', rate: '0.94', asOf: '2026-07-19', key: 'c-rate' });
  const inv = w.invoice(w.ctx, 'c', [['Lieferwagen', 2_000_000]], 'EUR');
  const later = w.at('2026-07-25T00:00:00.000Z');
  seedRate(later, { currency: 'EUR', rate: '0.93', asOf: '2026-07-25', key: 'c-rate-2' });
  w.pay(later, { invoiceId: inv.id, amountMinor: 2_162_000, date: '2026-07-25', key: 'c-pay', currency: 'EUR' });
  const d = w.dispose(later, assetId, '2026-07-25', { proceedsInvoiceId: inv.id });
  assert.equal(d.ok, true, JSON.stringify(d));
  assert.equal(d.transaction.proceedsRappen, 1_880_000);
  assert.equal(d.gainLossRappen, 380_000);
  assert.deepEqual(w.legs(d.journalEntry.id), ['1530:0:4000000', '1539:2500000:0', '3200:1880000:0', '8510:0:380000']);
  const net = w.nets();
  assert.equal(net('1100'), 0);
  assert.equal(net('1020'), 2_010_660);
  assert.equal(net('3806'), 21_620, 'the realised FX loss is A14\'s, apart from the gain');
  assert.equal(net('2200'), -152_280);
  assert.equal(net('3200'), 0);
  assert.equal(net('8510'), -380_000);
});

test('(d) payment only: a Guthaben is refused proceeds_needs_invoice; issue the invoice, allocate_payment, link it, and it clears once', () => {
  const w = world();
  const assetId = w.vehicle();
  const cash = w.pay(w.ctx, { amountMinor: 1_945_800, date: '2026-07-19', key: 'd-cash' });
  const before = w.counts();
  const refused = w.dispose(w.ctx, assetId, '2026-07-19', { proceedsPaymentId: cash });
  assert.equal(refused.error, 'invalid_proceeds_document');
  assert.equal(refused.reason, 'proceeds_needs_invoice');
  assert.deepEqual(w.counts(), before, 'a refusal writes nothing');
  const inv = w.invoice(w.ctx, 'd', [['Lieferwagen', 1_800_000]]);
  const applied = allocatePayment(w.ctx, { paymentId: cash, allocations: [{ documentId: inv.id, amountMinor: 1_945_800 }], intent: PAYMENT_INTENTS.allocate, idempotencyKey: 'd-alloc' });
  assert.equal(applied.ok, true, JSON.stringify(applied));
  const d = w.dispose(w.ctx, assetId, '2026-07-19', { proceedsPaymentId: cash }, 'd-2');
  assert.equal(d.ok, true, JSON.stringify(d));
  assert.equal(d.proceedsDocument.invoiceFromPayment, true);
  assert.deepEqual(w.legs(d.journalEntry.id), ['1530:0:4000000', '1539:2500000:0', '3200:1800000:0', '8510:0:300000']);
  const net = w.nets();
  assert.equal(net('1100'), 0);
  assert.equal(net('1020'), 1_945_800);
  assert.equal(net('2200'), -145_800);
  assert.equal(net('3200'), 0);
});

test('(e) a mixed invoice is refused sale_not_single_line; the per-call book_proceeds with a reason clears the vehicle by hand, and 3200 keeps the service once', () => {
  const w = world();
  const assetId = w.vehicle();
  const inv = w.invoice(w.ctx, 'e', [['Lieferwagen', 1_800_000], ['Überführung', 50_000]]);
  const refused = w.dispose(w.ctx, assetId, '2026-07-19', { proceedsInvoiceId: inv.id });
  assert.equal(refused.reason, 'sale_not_single_line', JSON.stringify(refused));
  const manual = { proceedsInvoiceId: inv.id, proceedsBooking: 'book_proceeds', proceedsRappen: 1_800_000, proceedsAccountId: w.acc('3200') };
  const noReason = w.dispose(w.ctx, assetId, '2026-07-19', manual, 'e-1');
  assert.equal(noReason.error, 'reason_required');
  const tooMuch = assetDisposalPreview(w.ctx, { assetId, disposalDate: '2026-07-19', gainLossAccountId: w.acc('8510'), ...manual, proceedsRappen: 1_850_000, proceedsBookingReason: 'Rechnung mit Dienstleistung' });
  assert.equal(tooMuch.ok, true, JSON.stringify(tooMuch));
  assert.ok(tooMuch.preview.warnings.some((x) => x.code === 'proceeds_exceed_sale_line'), 'above the largest sale line warns');
  const d = w.dispose(w.ctx, assetId, '2026-07-19', { ...manual, proceedsBookingReason: 'Rechnung mit Dienstleistung' }, 'e-2');
  assert.equal(d.ok, true, JSON.stringify(d));
  assert.deepEqual(d.warnings.filter((x) => x.code === 'proceeds_double_counted' || x.code === 'proceeds_exceed_sale_line'), []);
  assert.match(d.transaction.description, /Erlösbuchung übersteuert: Rechnung mit Dienstleistung/);
  const audits = w.store.db.prepare("SELECT action FROM audit_log WHERE entity_id = ? ORDER BY rowid").all(d.transaction.id).map((r) => r.action);
  assert.ok(audits.includes('override_proceeds_booking'));
  assert.equal(audits.includes('proceeds_cleared'), false);
  const net = w.nets();
  assert.equal(net('1100'), 1_999_850);
  assert.equal(net('2200'), -149_850);
  assert.equal(net('3200'), -50_000, 'the service turnover, once');
  const ev = assetLedgerGet(w.ctx, { assetId }).events.find((e) => e.type === 'disposal');
  assert.equal(ev.proceedsBooking, 'book_proceeds', 'read from the audit, not the lines (critic r1 F6)');
});

test('(f) a sale, then the reverse: credit note, refund and the mirror take every account back to zero', () => {
  const w = world();
  const assetId = w.vehicle();
  const inv = w.invoice(w.ctx, 'f', [['Lieferwagen', 1_800_000]]);
  w.pay(w.ctx, { invoiceId: inv.id, amountMinor: 1_945_800, date: '2026-07-19', key: 'f-pay' });
  const d = w.dispose(w.ctx, assetId, '2026-07-19', { proceedsInvoiceId: inv.id });
  assert.equal(d.ok, true, JSON.stringify(d));
  const early = assetTransactionReverse(w.ctx, { assetId, transactionId: d.transaction.id, reason: 'Kauf rückgängig', idempotencyKey: 'f-r0' });
  assert.equal(early.error, 'proceeds_settled');
  const cn = w.fullCredit(w.ctx, inv.id, 'f');
  w.refund(w.ctx, cn, 1_945_800, '2026-07-19', 'f-refund');
  const r = assetTransactionReverse(w.ctx, { assetId, transactionId: d.transaction.id, reason: 'Kauf rückgängig', idempotencyKey: 'f-r1' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.abgrenzungReversed, null);
  const net = w.nets('2026-07-02');
  for (const number of ['1100', '1020', '2200', '3200', '1530', '1539', '8510']) assert.equal(net(number), 0, number);
  const rec = vatAnnualReconciliation(w.ctx, { year: '2026' });
  assert.equal(rec.umsatz.differenceMinor, 0, 'the mirror is excluded with its disposal');
});

// --- (g), (h): across a year end, one call --------------------------------------------------------

test('(g) handed over 28.12.2026, invoiced 03.01.2027: ONE dispose call posts the disposal, A (accrued_income) and B; both years right; the reverse takes A back dated today', () => {
  const w = world();
  const assetId = w.vehicle();
  const jan3 = w.at('2027-01-03T00:00:00.000Z');
  const inv = w.invoice(jan3, 'g', [['Lieferwagen', 1_800_000]]);
  const jan5 = w.at('2027-01-05T00:00:00.000Z');
  const before = w.counts();
  const d = w.dispose(jan5, assetId, '2026-12-28', { proceedsInvoiceId: inv.id });
  assert.equal(d.ok, true, JSON.stringify(d));
  assert.equal(d.abgrenzung.kind, 'accrued_income');
  assert.equal(d.abgrenzung.periodEnd, '2026-12-31');
  assert.equal(d.abgrenzung.reversalDate, '2027-01-01');
  assert.deepEqual(w.legs(d.abgrenzung.entryId), ['1300:1800000:0', '3200:0:1800000']);
  assert.deepEqual(w.legs(d.abgrenzung.reversalEntryId), ['1300:0:1800000', '3200:1800000:0']);
  const after = w.counts();
  assert.equal(after.journal_entry - before.journal_entry, 3, 'the disposal, A and B');
  assert.equal(after.accrual - before.accrual, 1);
  // A replay posts nothing more (ROWS).
  const replay = w.dispose(jan5, assetId, '2026-12-28', { proceedsInvoiceId: inv.id });
  assert.deepEqual(replay, d);
  assert.deepEqual(w.counts(), after);
  const y26 = w.nets(...Y26);
  assert.equal(y26('3200'), 0);
  assert.equal(y26('1300'), 1_800_000);
  assert.equal(w.profit(...Y26), 300_000);
  const y27 = w.nets(...Y27);
  assert.equal(y27('3200'), 0);
  assert.equal(y27('1300'), -1_800_000);
  assert.equal(y27('1100'), 1_945_800);
  assert.equal(w.profit(...Y27), 0);
  // The Abgrenzung belongs to the disposal: A38's own Storno and the reserved namespace refuse.
  assert.equal(accrualReverse(jan5, { accrualId: d.abgrenzung.accrualId, idempotencyKey: 'g-ar' }).error, 'accrual_backs_disposal');
  assert.equal(accrualDiscard(jan5, { accrualId: d.abgrenzung.accrualId, idempotencyKey: 'g-ad' }).error, 'accrual_backs_disposal', 'the one free writer of accrual refuses the namespace too');
  assert.equal(accrualCreate(jan5, { kind: 'accrued_income', periodEnd: '2026-12-31', amountMinor: 1, contraAccount: '3200', description: 'Fremd', sourceRef: `asset_transaction:${d.transaction.id}`, idempotencyKey: 'g-ac' }).error, 'reserved_source_ref');
  // Reverse on 20.02.2027 after a full credit note: C and D dated that day, 2026 unchanged.
  const feb = w.at('2027-02-20T00:00:00.000Z');
  w.fullCredit(feb, inv.id, 'g');
  const r = assetTransactionReverse(feb, { assetId, transactionId: d.transaction.id, reason: 'Verkauf geplatzt', idempotencyKey: 'g-rev' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.abgrenzungReversed.stornoDate, '2027-02-20');
  for (const id of [r.abgrenzungReversed.stornoEntryId, r.abgrenzungReversed.stornoReversalEntryId]) {
    assert.equal(w.store.db.prepare('SELECT date FROM journal_entry WHERE id = ?').get(id).date, '2027-02-20');
  }
  assert.equal(w.profit(...Y26), 300_000, '2026 stays as booked (OR 957a)');
  assert.equal(w.profit(...Y27), -300_000, 'the gain taken back in 2027');
  const y27r = w.nets(...Y27);
  assert.equal(y27r('3200'), 0);
  assert.equal(y27r('1300'), -1_800_000, '1300 opened 2027 at +1800000.00 and closes at 0');
  const ab = assetLedgerGet(feb, { assetId }).events.find((e) => e.type === 'disposal').abgrenzung;
  assert.equal(ab.status, 'reversed');
  assert.equal(ab.stornoDate, '2027-02-20');
});

test('(h) invoiced 15.12.2026, handed over 10.01.2027: ONE dispose call posts A (deferred_income) into 2026 and B; both years right', () => {
  const w = world();
  const assetId = w.vehicle();
  const dec = w.at('2026-12-15T00:00:00.000Z');
  const inv = w.invoice(dec, 'h', [['Lieferwagen', 1_800_000]]);
  const jan = w.at('2027-01-10T00:00:00.000Z');
  const d = w.dispose(jan, assetId, '2027-01-10', { proceedsInvoiceId: inv.id });
  assert.equal(d.ok, true, JSON.stringify(d));
  assert.equal(d.abgrenzung.kind, 'deferred_income');
  assert.equal(d.abgrenzung.periodEnd, '2026-12-31');
  assert.deepEqual(w.legs(d.abgrenzung.entryId), ['2300:0:1800000', '3200:1800000:0']);
  const y26 = w.nets(...Y26);
  assert.equal(y26('3200'), 0);
  assert.equal(y26('2300'), -1_800_000);
  assert.equal(w.profit(...Y26), 0);
  const y27 = w.nets(...Y27);
  assert.equal(y27('3200'), 0);
  assert.equal(y27('2300'), 1_800_000);
  assert.equal(w.profit(...Y27), 300_000);
  // A38 in both years: the Abgrenzung adjustment already covers A and B.
  const r26 = vatAnnualReconciliation(jan, { year: '2026' });
  assert.equal(r26.umsatz.adjustedRevenueMinor, r26.umsatz.declaredZiffer200Minor, JSON.stringify(r26.umsatz));
  const r27 = vatAnnualReconciliation(jan, { year: '2027' });
  assert.equal(r27.umsatz.adjustedRevenueMinor, r27.umsatz.declaredZiffer200Minor, JSON.stringify(r27.umsatz));
});

test('the year rule reads the workspace\'s fiscal year (04-01): 15.03.2027 and 10.04.2027 are two years, the Abgrenzung lands on 31.03.2027', () => {
  const w = world();
  w.store.db.prepare("UPDATE workspace SET fiscal_year_start = '04-01' WHERE id = ?").run(w.workspaceId);
  const assetId = w.vehicle();
  const apr = w.at('2027-04-10T00:00:00.000Z');
  const inv = w.invoice(apr, 'fy', [['Lieferwagen', 1_800_000]]);
  const d = w.dispose(w.at('2027-04-12T00:00:00.000Z'), assetId, '2027-03-15', { proceedsInvoiceId: inv.id });
  assert.equal(d.ok, true, JSON.stringify(d));
  assert.equal(d.abgrenzung?.periodEnd, '2027-03-31');
  assert.equal(d.abgrenzung?.kind, 'accrued_income');
});

test('assets.cross_year_sale refuse: sale_in_other_financial_year with suggestedDisposalDate; a per-call post_abgrenzung needs its reason and is audited', () => {
  const w = world();
  w.setSetting(w.ctx, 'assets.cross_year_sale', 'refuse');
  const assetId = w.vehicle();
  const inv = w.invoice(w.at('2027-01-03T00:00:00.000Z'), 'cy', [['Lieferwagen', 1_800_000]]);
  const jan5 = w.at('2027-01-05T00:00:00.000Z');
  const refused = w.dispose(jan5, assetId, '2026-12-28', { proceedsInvoiceId: inv.id });
  assert.equal(refused.error, 'sale_in_other_financial_year');
  assert.equal(refused.suggestedDisposalDate, '2027-01-03');
  assert.equal(w.dispose(jan5, assetId, '2026-12-28', { proceedsInvoiceId: inv.id, crossYearSale: 'post_abgrenzung' }, 'cy-2').error, 'reason_required');
  const d = w.dispose(jan5, assetId, '2026-12-28', { proceedsInvoiceId: inv.id, crossYearSale: 'post_abgrenzung', crossYearSaleReason: 'Übergabe vor Jahresende' }, 'cy-3');
  assert.equal(d.ok, true, JSON.stringify(d));
  assert.equal(d.abgrenzung.kind, 'accrued_income');
  const audits = w.store.db.prepare('SELECT action FROM audit_log WHERE entity_id = ?').all(d.transaction.id).map((r) => r.action);
  assert.ok(audits.includes('override_cross_year_sale'));
  assert.match(d.transaction.description, /Jahresabgrenzung übersteuert: Übergabe vor Jahresende/);
});

test('years more than one apart are refused years_not_adjacent; a disposal dated after today is refused disposal_date_in_future (critic r3 C1)', () => {
  const w = world();
  const assetId = w.vehicle();
  const inv = w.invoice(w.at('2028-01-03T00:00:00.000Z'), 'na', [['Lieferwagen', 1_800_000]]);
  assert.equal(w.dispose(w.at('2028-01-05T00:00:00.000Z'), assetId, '2026-12-28', { proceedsInvoiceId: inv.id }).error, 'years_not_adjacent');
  const future = w.dispose(w.ctx, assetId, '2026-07-20', { proceedsRappen: 0 });
  assert.equal(future.error, 'disposal_date_in_future');
  assert.equal(future.today, '2026-07-19');
});

test('a locked earlier year refuses the whole call period_locked (leg abgrenzung) with the manual route, writing nothing; the preview warns first (critic r3 C2)', () => {
  const w = world();
  const assetId = w.vehicle();
  const dec = w.at('2026-12-15T00:00:00.000Z');
  const inv = w.invoice(dec, 'lk', [['Lieferwagen', 1_800_000]]);
  const jan = w.at('2027-01-10T00:00:00.000Z');
  const locked = lockPeriod(jan, { period: '2026-12', kind: 'hard', idempotencyKey: 'lk-lock' });
  assert.equal(locked.ok, true, JSON.stringify(locked));
  const p = assetDisposalPreview(jan, { assetId, disposalDate: '2027-01-10', gainLossAccountId: w.acc('8510'), proceedsInvoiceId: inv.id });
  assert.equal(p.ok, true, JSON.stringify(p));
  assert.ok(p.preview.warnings.some((x) => x.code === 'abgrenzung_period_locked'));
  assert.equal(p.preview.abgrenzung.kind, 'deferred_income');
  const before = w.counts();
  const r = w.dispose(jan, assetId, '2027-01-10', { proceedsInvoiceId: inv.id });
  assert.equal(r.error, 'period_locked');
  assert.equal(r.leg, 'abgrenzung');
  assert.match(r.hint, /transit account/);
  assert.match(r.hint, /hard_lock_sealed/);
  assert.deepEqual(w.counts(), before, 'nothing written: no disposal without its Abgrenzung');
});

// --- refusals, warnings, G1 ---------------------------------------------------------------------------

test('the caller may echo the derived proceeds; a different amount or account is refused proceeds_from_document', () => {
  const w = world();
  const assetId = w.vehicle();
  const inv = w.invoice(w.ctx, 'echo', [['Lieferwagen', 1_800_000]]);
  const wrong = w.dispose(w.ctx, assetId, '2026-07-19', { proceedsInvoiceId: inv.id, proceedsRappen: 1_945_800, proceedsAccountId: w.acc('1100') });
  assert.equal(wrong.error, 'invalid_input');
  assert.equal(wrong.reason, 'proceeds_from_document');
  assert.equal(wrong.derivedProceedsRappen, 1_800_000);
  const wrongAccount = w.dispose(w.ctx, assetId, '2026-07-19', { proceedsInvoiceId: inv.id, proceedsAccountId: w.acc('1100') }, 'echo-2');
  assert.equal(wrongAccount.reason, 'proceeds_from_document');
  const echoed = w.dispose(w.ctx, assetId, '2026-07-19', { proceedsInvoiceId: inv.id, proceedsRappen: 1_800_000, proceedsAccountId: w.acc('3200') }, 'echo-3');
  assert.equal(echoed.ok, true, JSON.stringify(echoed));
});

test('reductions are warned, never refused or adjusted: a partial credit note before the disposal, and a Skonto', () => {
  const w = world();
  const a1 = w.vehicle();
  const inv = w.invoice(w.ctx, 'red', [['Lieferwagen', 1_800_000]]);
  const cn = createCreditNote(w.ctx, { fromInvoiceId: inv.id, mode: 'partial', amountMinor: 100_000, idempotencyKey: 'red-cn' });
  assert.equal(cn.ok, true, JSON.stringify(cn));
  assert.equal(issueCreditNote(w.ctx, { creditNoteId: cn.document.id, idempotencyKey: 'red-cn-issue' }).ok, true);
  const d = w.dispose(w.ctx, a1, '2026-07-19', { proceedsInvoiceId: inv.id });
  assert.equal(d.ok, true, JSON.stringify(d));
  assert.equal(d.transaction.proceedsRappen, 1_800_000, 'the full sale line');
  const reduced = d.warnings.find((x) => x.code === 'sale_reduced');
  assert.equal(reduced.creditNotes.length, 1);
  assert.equal(w.nets()('3200'), 100_000, 'the reduction stays on 3200; the P&L total is exact');
  const a2 = w.vehicle();
  const inv2 = w.invoice(w.ctx, 'sk', [['Lieferwagen', 1_800_000]]);
  const sk = recordPayment(w.ctx, {
    direction: 'incoming', date: '2026-07-19', amountMinor: 1_906_884, currency: 'CHF', bankAccountId: w.acc('1020'),
    counterpartyKind: 'customer', counterpartyId: w.customerId,
    allocations: [{ documentId: inv2.id, amountMinor: 1_906_884, skontoMinor: 36_000 }], intent: PAYMENT_INTENTS.record, idempotencyKey: 'sk-pay',
  });
  assert.equal(sk.ok, true, JSON.stringify(sk));
  const d2 = w.dispose(w.ctx, a2, '2026-07-19', { proceedsInvoiceId: inv2.id });
  assert.equal(d2.ok, true, JSON.stringify(d2));
  assert.ok(d2.warnings.find((x) => x.code === 'sale_reduced')?.skontoMinor > 0, JSON.stringify(d2.warnings));
});

test('a disposal and its invoice in different months of one year are warned sale_in_other_month, not refused', () => {
  const w = world();
  const assetId = w.vehicle();
  const inv = w.invoice(w.at('2026-06-10T00:00:00.000Z'), 'mo', [['Lieferwagen', 1_800_000]]);
  const d = w.dispose(w.ctx, assetId, '2026-07-19', { proceedsInvoiceId: inv.id });
  assert.equal(d.ok, true, JSON.stringify(d));
  assert.ok(d.warnings.some((x) => x.code === 'sale_in_other_month'));
  assert.equal(d.abgrenzung, null);
});

test('G1: one standing disposal per invoice in both modes and through a resolving payment; the redo after a reverse passes; the trigger guards a direct insert', () => {
  const w = world();
  const a1 = w.vehicle();
  const a2 = w.vehicle();
  const inv = w.invoice(w.ctx, 'g1', [['Lieferwagen', 1_800_000]]);
  const first = w.dispose(w.ctx, a1, '2026-07-19', { proceedsInvoiceId: inv.id });
  assert.equal(first.ok, true, JSON.stringify(first));
  const second = w.dispose(w.ctx, a2, '2026-07-19', { proceedsInvoiceId: inv.id });
  assert.equal(second.reason, 'invoice_already_cleared');
  assert.equal(second.standingTransactionId, first.transaction.id);
  const book = w.dispose(w.ctx, a2, '2026-07-19', { proceedsInvoiceId: inv.id, proceedsBooking: 'book_proceeds', proceedsBookingReason: 'Test', proceedsRappen: 1_000, proceedsAccountId: w.acc('1020') }, 'g1-b');
  assert.equal(book.reason, 'invoice_already_cleared', 'book_proceeds too');
  const paid = w.pay(w.ctx, { invoiceId: inv.id, amountMinor: 1_945_800, date: '2026-07-19', key: 'g1-pay' });
  assert.equal(w.dispose(w.ctx, a2, '2026-07-19', { proceedsPaymentId: paid }, 'g1-p').reason, 'invoice_already_cleared', 'a payment resolving to the invoice');
  // Direct INSERT: the trigger raises (the chokepoint under every writer).
  assert.throws(
    () => w.store.db.prepare(
      `INSERT INTO asset_transaction (id, workspace_id, asset_id, type, date, delta_cost_rappen, delta_accum_depr_rappen, proceeds_rappen, gain_loss_rappen, journal_entry_id, source_document_type, source_document_id, description, created_at, created_by, idempotency_key)
       VALUES ('atxn_raw', ?, ?, 'disposal', '2026-07-19', 0, 0, 0, 0, ?, 'invoice', ?, 'raw', '2026-07-19', 'x', 'raw')`,
    ).run(w.workspaceId, a2, first.journalEntry.id, inv.id),
    /asset_transaction_invoice_already_cleared/,
  );
  // Undo the first (the sale really is undone), then the redo on the same invoice inserts.
  const r = assetTransactionReverse(w.ctx, { assetId: a1, transactionId: first.transaction.id, reason: 'falsche Anlage', overrideProceedsCheck: true, overrideReason: 'Umbuchung auf die richtige Anlage', idempotencyKey: 'g1-rev' });
  assert.equal(r.ok, true, JSON.stringify(r));
  const redo = w.dispose(w.ctx, a2, '2026-07-19', { proceedsInvoiceId: inv.id }, 'g1-redo');
  assert.equal(redo.ok, true, JSON.stringify(redo));
});

test('no_sale_line: an invoice whose posted entry carries no sale line (a migrated open item without an entry) is refused with the manual route', () => {
  const w = world();
  const assetId = w.vehicle();
  const inv = w.invoice(w.ctx, 'nsl', [['Lieferwagen', 1_800_000]]);
  // A G21 migrated open item has posted_entry_id NULL; model that on a synthetic copy row.
  const cols = w.store.db.prepare('PRAGMA table_info(document)').all().map((c) => c.name);
  const copy = cols.map((c) => (c === 'id' ? "'doc_migrated'" : c === 'posted_entry_id' ? 'NULL' : c === 'number' ? "'MIG-1'" : c === 'idempotency_key' ? "'mig-1'" : c)).join(', ');
  w.store.db.prepare(`INSERT INTO document (${cols.join(', ')}) SELECT ${copy} FROM document WHERE id = ?`).run(inv.id);
  const r = w.dispose(w.ctx, assetId, '2026-07-19', { proceedsInvoiceId: 'doc_migrated' });
  assert.equal(r.reason, 'no_sale_line', JSON.stringify(r));
  assert.match(r.hint, /book_proceeds/);
});

// --- A38 and the anomaly scan (existing defects fixed) -----------------------------------------------

test('A38 point 12: an unlinked sale with proceeds is a Sonderposten; a Guthaben applied to an invoice later leaves it (critic G3); the gain is never turnover', () => {
  const w = world();
  w.setSetting(w.ctx, 'assets.proceeds_booking', 'book_proceeds');
  const a1 = w.vehicle();
  const unlinked = w.dispose(w.ctx, a1, '2026-07-19', { proceedsRappen: 1_800_000, proceedsAccountId: w.acc('1020') });
  assert.equal(unlinked.ok, true, JSON.stringify(unlinked));
  let rec = vatAnnualReconciliation(w.ctx, { year: '2026' });
  assert.deepEqual(rec.umsatz.adjustments.filter((x) => x.kind === 'asset_disposal').map((x) => x.amountMinor), [1_800_000], 'the sale price, not the gain');
  assert.equal(rec.umsatz.revenuePerStatementsMinor, 0, 'the gain on 8510 is no turnover');
  // A Guthaben linked by payment, then applied to an invoice: the invoice declares it.
  const a2 = w.vehicle();
  const cash = w.pay(w.ctx, { amountMinor: 1_945_800, date: '2026-07-19', key: 'g3-cash' });
  const d2 = w.dispose(w.ctx, a2, '2026-07-19', { proceedsPaymentId: cash, proceedsRappen: 1_800_000, proceedsAccountId: w.acc('1020') }, 'g3-d');
  assert.equal(d2.ok, true, JSON.stringify(d2));
  rec = vatAnnualReconciliation(w.ctx, { year: '2026' });
  assert.equal(rec.umsatz.adjustments.filter((x) => x.kind === 'asset_disposal').length, 2);
  const inv = w.invoice(w.ctx, 'g3', [['Lieferwagen', 1_800_000]]);
  assert.equal(allocatePayment(w.ctx, { paymentId: cash, allocations: [{ documentId: inv.id, amountMinor: 1_945_800 }], intent: PAYMENT_INTENTS.allocate, idempotencyKey: 'g3-alloc' }).ok, true);
  rec = vatAnnualReconciliation(w.ctx, { year: '2026' });
  assert.deepEqual(rec.umsatz.adjustments.filter((x) => x.kind === 'asset_disposal').map((x) => x.amountMinor), [1_800_000], 'the payment now lies wholly on the invoice');
});

test('existing defect fixed: a disposal with a gain no longer trips missing_tax_code (VAT_FREE_ENTRY_SOURCES)', () => {
  const w = world();
  const assetId = w.vehicle();
  const inv = w.invoice(w.ctx, 'mtc', [['Lieferwagen', 1_800_000]]);
  const d = w.dispose(w.ctx, assetId, '2026-07-19', { proceedsInvoiceId: inv.id });
  assert.equal(d.ok, true, JSON.stringify(d));
  const a = detectAnomalies(w.ctx, { period: '2026-07' });
  assert.equal(a.ok, true, JSON.stringify(a));
  const flagged = a.anomalies.filter((x) => x.kind === 'missing_tax_code').flatMap((x) => x.entryIds);
  assert.equal(flagged.includes(d.journalEntry.id), false);
});

// --- money-path invariants ---------------------------------------------------------------------------

test('APPEND-ONLY: the invoice entry, its lines and the document row are byte-identical across dispose and reverse; the clearing is the disposal\'s own line', () => {
  const w = world();
  const assetId = w.vehicle();
  const inv = w.invoice(w.at('2027-01-03T00:00:00.000Z'), 'ao', [['Lieferwagen', 1_800_000]]);
  const snap = () => JSON.stringify({
    entry: w.store.db.prepare('SELECT * FROM journal_entry WHERE id = ?').get(inv.postedEntryId),
    lines: w.store.db.prepare('SELECT * FROM journal_line WHERE entry_id = ? ORDER BY rowid').all(inv.postedEntryId),
    doc: w.store.db.prepare('SELECT id, type, status, total_minor, posted_entry_id FROM document WHERE id = ?').get(inv.id),
  });
  const before = snap();
  const ctx = w.at('2027-01-05T00:00:00.000Z');
  const d = w.dispose(ctx, assetId, '2026-12-28', { proceedsInvoiceId: inv.id });
  assert.equal(d.ok, true, JSON.stringify(d));
  assert.equal(snap(), before);
  const disposalRow = JSON.stringify(w.store.db.prepare('SELECT * FROM asset_transaction WHERE id = ?').get(d.transaction.id));
  const r = assetTransactionReverse(ctx, { assetId, transactionId: d.transaction.id, reason: 'Test', overrideProceedsCheck: true, overrideReason: 'Test', idempotencyKey: 'ao-rev' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(snap(), before, 'the reverse touches no invoice row either');
  assert.equal(JSON.stringify(w.store.db.prepare('SELECT * FROM asset_transaction WHERE id = ?').get(d.transaction.id)), disposalRow);
  assert.throws(() => w.store.db.prepare("UPDATE asset_transaction SET proceeds_rappen = 1 WHERE id = ?").run(d.transaction.id), /asset_transaction_immutable/);
});

test('IDEMPOTENT ON ROWS: a cross-year dispose and its reverse, each called twice under one key, write every row once, the accrual included', () => {
  const w = world();
  const assetId = w.vehicle();
  const inv = w.invoice(w.at('2026-12-15T00:00:00.000Z'), 'idem', [['Lieferwagen', 1_800_000]]);
  const jan = w.at('2027-01-10T00:00:00.000Z');
  const c0 = w.counts();
  const d1 = w.dispose(jan, assetId, '2027-01-10', { proceedsInvoiceId: inv.id }, 'idem-d');
  const c1 = w.counts();
  const d2 = w.dispose(jan, assetId, '2027-01-10', { proceedsInvoiceId: inv.id }, 'idem-d');
  assert.deepEqual(d2, d1);
  assert.deepEqual(w.counts(), c1);
  assert.equal(c1.accrual - c0.accrual, 1);
  assert.equal(c1.journal_entry - c0.journal_entry, 3);
  assert.equal(c1.asset_transaction - c0.asset_transaction, 1);
  assert.equal(c1.audit_log - c0.audit_log > 0, true);
  const rev = { assetId, transactionId: d1.transaction.id, reason: 'Test', overrideProceedsCheck: true, overrideReason: 'Test', idempotencyKey: 'idem-r' };
  const r1 = assetTransactionReverse(jan, rev);
  assert.equal(r1.ok, true, JSON.stringify(r1));
  const c2 = w.counts();
  assert.equal(c2.journal_entry - c1.journal_entry, 3, 'the mirror, C and D');
  assert.deepEqual(assetTransactionReverse(jan, rev), r1);
  assert.deepEqual(w.counts(), c2);
});

test('§H-TENANT: another workspace\'s settings, a foreign disposal row naming the same invoice id, and a foreign accrual change nothing here', () => {
  const w = world();
  const other = secondWorkspace(w);
  const r = settingsSet(other.ctx, { key: 'assets.proceeds_booking', value: 'book_proceeds', reason: 'Nachbar', idempotencyKey: 'o-pb' });
  assert.equal(r.ok, true, JSON.stringify(r));
  const assetId = w.vehicle();
  const inv = w.invoice(w.ctx, 'ten', [['Lieferwagen', 1_800_000]]);
  // A planted foreign disposal row on the same invoice id (raw), on a real asset of the other workspace.
  const cat = createAssetCategory(other.ctx, { code: 'FZ-O', name: 'Fahrzeuge', depreciationMethod: 'straight_line', usefulLifeMonths: 60, glAssetAccountId: other.acc('1530'), glAccumDeprAccountId: other.acc('1510'), glDeprExpenseAccountId: other.acc('6800'), idempotencyKey: 'o-cat' });
  assert.equal(cat.ok, true, JSON.stringify(cat));
  const foreignAsset = createAsset(other.ctx, { categoryId: cat.category.id, name: 'Fremdwagen', acquisitionDate: '2026-01-01', acquisitionCostRappen: 100, idempotencyKey: 'o-as' });
  assert.equal(foreignAsset.ok, true, JSON.stringify(foreignAsset));
  w.store.db.prepare(
    `INSERT INTO asset_transaction (id, workspace_id, asset_id, type, date, delta_cost_rappen, delta_accum_depr_rappen, proceeds_rappen, gain_loss_rappen, journal_entry_id, source_document_type, source_document_id, description, created_at, created_by, idempotency_key)
     VALUES ('atxn_foreign', ?, ?, 'disposal', '2026-07-19', 0, 0, 0, 0, ?, 'invoice', ?, 'fremd', '2026-07-19', 'x', 'foreign')`,
  ).run(other.workspaceId, foreignAsset.asset.id, inv.postedEntryId, inv.id);
  const d = w.dispose(w.ctx, assetId, '2026-07-19', { proceedsInvoiceId: inv.id });
  assert.equal(d.ok, true, JSON.stringify(d));
  assert.equal(d.proceedsBooking, 'clear_via_document', 'the other workspace\'s book_proceeds does not reach here');
});

test('D12: the plan is rebuilt inside the write transaction; assets.cross_year_sale moving to refuse after the friendly check refuses, writing nothing', () => {
  const w = world();
  const assetId = w.vehicle();
  const inv = w.invoice(w.at('2027-01-03T00:00:00.000Z'), 'race', [['Lieferwagen', 1_800_000]]);
  const jan5 = w.at('2027-01-05T00:00:00.000Z');
  // The friendly pre-check reads post_abgrenzung (the default); the setting moves to refuse before the
  // write lock is taken; the plan rebuilt inside the transaction must see it.
  const store = w.store;
  const realTx = store.tx;
  store.tx = function (fn) {
    store.tx = realTx;
    store.db
      .prepare("INSERT INTO workspace_setting (workspace_id, key, value_json, updated_at, updated_by) VALUES (?, 'assets.cross_year_sale', '\"refuse\"', '2027-01-05', 'race') ON CONFLICT(workspace_id, key) DO UPDATE SET value_json = excluded.value_json")
      .run(w.workspaceId);
    return realTx.call(store, fn);
  };
  const before = w.counts();
  let raced;
  try {
    raced = w.dispose(jan5, assetId, '2026-12-28', { proceedsInvoiceId: inv.id }, 'race-d');
  } finally {
    store.tx = realTx;
  }
  assert.equal(raced.error, 'sale_in_other_financial_year', JSON.stringify(raced));
  assert.deepEqual(w.counts(), before, 'nothing written');
});
