// Critic D186 round 2 (non-author): free_cash and the estimate basis. Synthetic by construction.
// Re-cut after round 3 (owner's pick, 09.11.2026): free_cash is on the BOOKS, so the round-2 scenes now assert
// the books identity and that an UNBOOKED bank line moves free_cash not at all (the add-back is gone).
import test from 'node:test';
import assert from 'node:assert/strict';

const { listBankInbox, bookBankLine, importCamt } = await import('../../dist/core/banking/index.js');
const { importBankStatement } = await import('../../dist/core/banking/statementImport.js');
const { dashboardOverview, dashboardRevenueEstimate } = await import('../../dist/core/dashboards/index.js');
const { postEntry } = await import('../../dist/core/ledger/index.js');
const { createContact } = await import('../../dist/core/sales/index.js');
const { createVendorBill, postVendorBill } = await import('../../dist/core/purchase/index.js');
const { world, importLines, must, camt, postedBill } = await import('../banking/bank-inbox-support.mjs');

const RANGE = { from: '2026-07-01', to: '2026-07-31' };
const csvMapping = { columns: { bookingDate: 'Datum', text: 'Text', amount: 'Betrag' }, dateFormat: 'dd.mm.yyyy', decimalSeparator: '.' };
const freeOf = (t) => must(dashboardOverview(t.ctx, RANGE)).tiles.find((x) => x.tile === 'free_cash');
const identity = (free) => assert.equal(free.valueRappen, free.detail.bankMinor - free.detail.payablesMinor - free.detail.vatDueMinor, 'free = bank (books) - 2000 - MWST');
const inbox = (t) => must(listBankInbox(t.ctx, { status: 'open', limit: 200 })).lines;
let n = 0;
const csv = (t, content) => must(importBankStatement(t.ctx, { bankAccountId: t.bankAccountId, content, mapping: csvMapping, idempotencyKey: `csv-${++n}` }), 'csv');

test('critic D186-R2-1 (re-cut): a CSV-only account: free_cash is the books, the unbooked payment moves nothing', () => {
  const t = world();
  postedBill(t, { grossMinor: 50000, seed: 'r1', vendorName: 'Druckerei Lindenhof AG' });
  const before = freeOf(t);
  csv(t, 'Datum;Text;Betrag\n15.07.2026;Druckerei Lindenhof AG;-500.00\n');
  const free = freeOf(t);
  identity(free);
  // Books: 1020 holds 0.00 (the payment is not booked) and the bill is owed: free = 0 - 500 = -500.00.
  // Booking the line would make it 1020 -500, bill paid: also -500.00. The tile must not say 0.00.
  assert.equal(free.valueRappen, -50000 - free.detail.vatDueMinor);
  assert.equal(free.valueRappen, before.valueRappen, 'an unbooked line moves nothing');
});

test('critic D186-R2-2 (re-cut): a statement and a later CSV payment: free_cash is the books, unbooked lines move nothing', () => {
  const t = world();
  postedBill(t, { grossMinor: 50000, seed: 'r2', vendorName: 'Druckerei Lindenhof AG' });
  const before = freeOf(t);
  importLines(t, { statementId: 'R2', from: '2026-07-01', to: '2026-07-10', openingMinor: 500000, entries: [{ ref: 'X', amountMinor: 1000, cd: 'CRDT', date: '2026-07-05', name: 'Muster AG', ustrd: 'X' }] });
  csv(t, 'Datum;Text;Betrag\n15.07.2026;Druckerei Lindenhof AG;-500.00\n');
  const free = freeOf(t);
  identity(free);
  // On the books neither the statement nor the later CSV payment counts until booked.
  assert.equal(free.valueRappen, before.valueRappen, 'unbooked lines move nothing');
});

test('critic D186-R2-3 (re-cut): duplicate payment lines: free_cash owes both bills until a payment is booked', () => {
  const t = world();
  const vendor = must(createContact(t.ctx, { partyRole: 'vendor', name: 'Druckerei Lindenhof AG', idempotencyKey: 'v3' })).contact.id;
  for (const [k, amt] of [['a', 50000], ['b', 70000]]) {
    const bill = must(createVendorBill(t.ctx, { vendorId: vendor, billDate: '2026-07-01', dueDate: '2026-07-20', amountMinor: amt, expenseAccountId: t.acc('6500'), idempotencyKey: `b3${k}` }));
    must(postVendorBill(t.ctx, { vendorBillId: bill.vendorBillId, idempotencyKey: `p3${k}` }));
  }
  const entries = (ref) => [{ ref, amountMinor: 50000, cd: 'DBIT', date: '2026-07-05', name: 'Druckerei Lindenhof AG' }];
  importLines(t, { statementId: 'D-A', from: '2026-07-01', to: '2026-07-10', openingMinor: 500000, entries: entries('A') });
  must(importCamt(t.ctx, { bankAccountId: t.bankAccountId, xml: camt({ statementId: 'D-B', from: '2026-07-01', to: '2026-07-10', openingMinor: 500000, entries: entries('B') }), idempotencyKey: 'imp-db' }));
  const free = freeOf(t);
  identity(free);
  // Both bills (1'200.00) are owed on the books; the duplicate payment lines move nothing until booked.
  assert.equal(free.detail.payablesMinor, 120000);
  assert.equal(free.valueRappen, free.detail.bankMinor - 120000 - free.detail.vatDueMinor);
});

test('critic D186-R2-4 (re-cut): a payment larger than its bill: free_cash owes the bills until booked', () => {
  const t = world();
  postedBill(t, { grossMinor: 50000, seed: 'r4', vendorName: 'Druckerei Lindenhof AG' });
  const bill2 = postedBill(t, { grossMinor: 90000, seed: 'r4b', vendorName: 'Papeterie Zweig AG' });
  void bill2;
  importLines(t, { statementId: 'R4', openingMinor: 500000, entries: [{ ref: 'Y', amountMinor: 80000, cd: 'DBIT', date: '2026-07-15', name: 'Druckerei Lindenhof AG' }] });
  const free = freeOf(t);
  identity(free);
  assert.equal(free.detail.payablesMinor, 140000, 'both bills owed until a payment is booked');
});

test('critic D186-R2-5: basis rules vs all on a check-certainty journal proposal to revenue', () => {
  const t = world();
  must(postEntry(t.ctx, { date: '2026-06-15', source: 'manual', idempotencyKey: 'j1', description: 'Zahlung Kundin Seeblick Beratung', lines: [{ account: t.acc('1020'), debit: 100000 }, { account: t.acc('3400'), credit: 100000 }] }));
  const { lines } = importLines(t, { statementId: 'J', openingMinor: 0, entries: [{ ref: 'K', amountMinor: 20000, cd: 'CRDT', date: '2026-07-12', name: 'Kundin Seeblick', ustrd: 'Rechnung' }] });
  const p = inbox(t).find((l) => l.bankTxnId === lines.K).proposal;
  console.log('R2-5 proposal', p.target?.kind, p.certainty, p.reasonCode);
  const rules = must(dashboardRevenueEstimate(t.ctx, RANGE));
  const all = must(dashboardRevenueEstimate(t.ctx, { ...RANGE, basis: 'all' }));
  console.log('R2-5', rules.revenueMinor, JSON.stringify(rules.excluded), all.revenueMinor);
  assert.equal(p.certainty, 'check');
  assert.equal(rules.revenueMinor, 0);
  assert.equal(rules.excluded.below_basis, 1);
  const rev = (x) => must(dashboardOverview(t.ctx, RANGE)).tiles.find((y) => y.tile === 'revenue').valueRappen;
  const before = rev();
  must(bookBankLine(t.ctx, { bankTxnId: lines.K, target: p.target, idempotencyKey: 'k' }));
  assert.equal(rev() - before, all.revenueMinor, 'basis all equals what booking adds');
  assert.ok(all.revenueMinor > 0);
});

test('critic D186-R2-6: the margin change when the cut window has no revenue but the whole range has', () => {
  const t = world();
  // Revenue only AFTER today (19.07.): the cut window 01.07.-19.07. has an expense and no revenue.
  must(postEntry(t.ctx, { date: '2026-07-05', source: 'manual', idempotencyKey: 'e', lines: [{ account: t.acc('6500'), debit: 10000 }, { account: t.acc('1000'), credit: 10000 }] }));
  must(postEntry(t.ctx, { date: '2026-07-28', source: 'manual', idempotencyKey: 'r', lines: [{ account: t.acc('1000'), debit: 100000 }, { account: t.acc('3400'), credit: 100000 }] }));
  must(postEntry(t.ctx, { date: '2026-06-05', source: 'manual', idempotencyKey: 'rp', lines: [{ account: t.acc('1000'), debit: 100000 }, { account: t.acc('3400'), credit: 100000 }] }));
  const m = must(dashboardOverview(t.ctx, RANGE)).tiles.find((x) => x.tile === 'margin');
  console.log('R2-6', m.valueBp, m.comparedValue, JSON.stringify(m.comparisons.previous_period));
  // Up to the same day there is no margin on the current side (no revenue): no change can be said.
  assert.equal(m.comparisons.previous_period.changeBp, null, 'no like-for-like change without a current margin');
});
