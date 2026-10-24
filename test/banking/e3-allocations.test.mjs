/**
 * D178 E3 (A39 §17.2): one bank line settling SEVERAL invoices or vendor bills of one contact, with the
 * cash applied to each, the deviation ("Abweichung") and the remainder outcomes.
 *
 * SYNTHETIC BY CONSTRUCTION (bank-inbox-support): invented names, sample IBANs, statements spelled by hand.
 *
 * Held on ROWS: one A14 payment carries every allocation; cash left over books only as a chosen Guthaben;
 * a partly allocated invoice stays open or is written off within A14's one-click threshold; the sides never
 * mix; every refusal writes nothing; a replay writes nothing; the undo reopens every document; another
 * workspace's document is `not_found`.
 */

import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  world,
  importLines,
  must,
  refused,
  rowCounts,
  balanceOf,
  issueInvoice,
  postedBill,
  secondWorkspace,
  assertClaimInvariantHolds,
} from './bank-inbox-support.mjs';
import { bookBankLine, reopenBankLine } from '../../dist/core/banking/index.js';
import { createContact } from '../../dist/core/sales/index.js';
import { createVendorBill, postVendorBill } from '../../dist/core/purchase/index.js';
import { customerBalance } from '../../dist/core/debtors/index.js';
// D178 point 19 (the E2 re-cut): each further statement of a fixture continues the balance chain, as a bank's do.
import { chained } from './e2-adapt.mjs';

afterEach(assertClaimInvariantHolds);

function statusOf(t, documentId) {
  return t.store.db.prepare('SELECT status FROM document WHERE id = ?').get(documentId).status;
}

/** Two issued invoices of the world's customer: 1'081.00 and 540.50. */
function twoInvoices(t) {
  const a = issueInvoice(t.ctx, { contactId: t.customerId, key: 'inv-a' });
  const b = issueInvoice(t.ctx, { contactId: t.customerId, netMinor: 50000, key: 'inv-b' });
  return { a, b, total: a.totalMinor + b.totalMinor };
}

function credit(t, amountMinor, ref = 'CR1', id = 'e3a') {
  return importLines(t, { statementId: id, ...chained(t), entries: [{ ref, amountMinor, cd: 'CRDT', name: 'Muster AG', ustrd: 'Rechnungen Juli' }] }).lines[ref];
}

test('two invoices, fully allocated: ONE payment with both allocations, both settled, deviation 0', () => {
  const t = world();
  const { a, b, total } = twoInvoices(t);
  const line = credit(t, total);
  const before = rowCounts(t.store, t.workspaceId);
  const res = must(
    bookBankLine(t.ctx, {
      bankTxnId: line,
      target: { kind: 'open_item', allocations: [{ documentId: a.id, amountMinor: a.totalMinor }, { documentId: b.id, amountMinor: b.totalMinor }] },
      idempotencyKey: 'm1',
    }),
    'book',
  );
  assert.equal(res.targetKind, 'open_item');
  assert.equal(res.deviationMinor, 0);
  assert.deepEqual(res.remainder, { kind: 'none', amountMinor: 0, documentOpenMinor: 0, feeOpenMinor: null });
  const after = rowCounts(t.store, t.workspaceId);
  assert.equal(after.payments - before.payments, 1, 'one payment');
  assert.equal(after.allocations - before.allocations, 2, 'one allocation per invoice');
  assert.equal(statusOf(t, a.id), 'settled');
  assert.equal(statusOf(t, b.id), 'settled');
  assert.equal(balanceOf(t.store, t.workspaceId, '1100'), 0, 'both receivables cleared');
  // A replay moves no row.
  const counts = rowCounts(t.store, t.workspaceId);
  must(bookBankLine(t.ctx, { bankTxnId: line, target: { kind: 'open_item', allocations: [{ documentId: a.id, amountMinor: a.totalMinor }, { documentId: b.id, amountMinor: b.totalMinor }] }, idempotencyKey: 'm1' }), 'replay');
  assert.deepEqual(rowCounts(t.store, t.workspaceId), counts);
  // The undo reverses the one payment and both invoices are open again.
  const undone = must(reopenBankLine(t.ctx, { bankTxnId: line, reason: 'falsch zugeordnet', idempotencyKey: 'm2' }), 'reopen');
  assert.deepEqual(undone.reversedPaymentIds, [res.paymentId]);
  assert.equal(statusOf(t, a.id), 'issued');
  assert.equal(statusOf(t, b.id), 'issued');
  assert.equal(balanceOf(t.store, t.workspaceId, '1100'), total);
});

test('cash left over books only when the person chooses the Guthaben (deviation_needs_remainder otherwise)', () => {
  const t = world();
  const { a, b, total } = twoInvoices(t);
  const line = credit(t, total + 7850);
  const target = { kind: 'open_item', allocations: [{ documentId: a.id, amountMinor: a.totalMinor }, { documentId: b.id, amountMinor: b.totalMinor }] };
  const counts = rowCounts(t.store, t.workspaceId);
  const r = refused(bookBankLine(t.ctx, { bankTxnId: line, target, idempotencyKey: 'g1' }), 'deviation_needs_remainder');
  assert.equal(r.deviationMinor, 7850);
  assert.deepEqual(r.remainderOptions, ['on_account']);
  assert.equal(typeof r.sentence.en, 'string');
  assert.deepEqual(rowCounts(t.store, t.workspaceId), counts, 'the refusal wrote nothing');
  const res = must(bookBankLine(t.ctx, { bankTxnId: line, target: { ...target, remainder: 'on_account' }, idempotencyKey: 'g2' }), 'with Guthaben');
  assert.equal(res.deviationMinor, 7850);
  assert.equal(res.remainder.kind, 'on_account');
  assert.equal(res.remainder.amountMinor, 7850);
  const bal = must(customerBalance(t.ctx, { customerId: t.customerId, asOf: '2026-07-31' }), 'balance');
  assert.equal(bal.onAccountMinor, 7850, 'the rest is the customer\'s Guthaben');
  assert.equal(balanceOf(t.store, t.workspaceId, '1100'), -7850);
});

test('over-allocation never books; on_account without cash left over refuses; a partly allocated invoice stays open', () => {
  const t = world();
  const { a, b } = twoInvoices(t);
  const line = credit(t, 150000);
  const counts = rowCounts(t.store, t.workspaceId);
  const over = refused(
    bookBankLine(t.ctx, { bankTxnId: line, target: { kind: 'open_item', allocations: [{ documentId: a.id, amountMinor: a.totalMinor }, { documentId: b.id, amountMinor: b.totalMinor }] }, idempotencyKey: 'o1' }),
    'allocations_exceed_line',
  );
  assert.equal(over.deviationMinor, 150000 - a.totalMinor - b.totalMinor);
  const partial = { kind: 'open_item', allocations: [{ documentId: a.id, amountMinor: a.totalMinor }, { documentId: b.id, amountMinor: 150000 - a.totalMinor }] };
  refused(bookBankLine(t.ctx, { bankTxnId: line, target: { ...partial, remainder: 'on_account' }, idempotencyKey: 'o2' }), 'invalid_input');
  const above = refused(bookBankLine(t.ctx, { bankTxnId: line, target: { ...partial, remainder: 'write_off' }, idempotencyKey: 'o3' }), 'write_off_above_threshold');
  assert.equal(above.writeOffMinor, a.totalMinor + b.totalMinor - 150000);
  assert.deepEqual(rowCounts(t.store, t.workspaceId), counts, 'no refusal wrote a row');
  const res = must(bookBankLine(t.ctx, { bankTxnId: line, target: partial, idempotencyKey: 'o4' }), 'leave open');
  assert.equal(res.remainder.kind, 'open');
  assert.equal(res.remainder.amountMinor, a.totalMinor + b.totalMinor - 150000);
  assert.equal(statusOf(t, a.id), 'settled');
  assert.equal(statusOf(t, b.id), 'partially_paid');
});

test('a small shortfall is written off within the one-click threshold (3805), and the invoice is settled', () => {
  const t = world();
  const { a, b, total } = twoInvoices(t);
  const line = credit(t, total - 60);
  const res = must(
    bookBankLine(t.ctx, {
      bankTxnId: line,
      target: { kind: 'open_item', allocations: [{ documentId: a.id, amountMinor: a.totalMinor }, { documentId: b.id, amountMinor: b.totalMinor - 60 }], remainder: 'write_off' },
      idempotencyKey: 'w1',
    }),
    'write off',
  );
  assert.deepEqual(res.remainder, { kind: 'written_off', amountMinor: 60, documentOpenMinor: 0, feeOpenMinor: null });
  assert.equal(statusOf(t, b.id), 'settled');
  assert.equal(balanceOf(t.store, t.workspaceId, '3805'), 60);
  assert.equal(balanceOf(t.store, t.workspaceId, '1100'), 0);
});

test('one contact per booking, the open amount per document, never the other side', () => {
  const t = world();
  const { a } = twoInvoices(t);
  const otherCustomer = must(createContact(t.ctx, { partyRole: 'customer', name: 'Seeblick GmbH', idempotencyKey: 'c-see' }), 'c').contact.id;
  const foreign = issueInvoice(t.ctx, { contactId: otherCustomer, netMinor: 10000, key: 'inv-see' });
  const line = credit(t, a.totalMinor + foreign.totalMinor);
  const bill = postedBill(t, { grossMinor: 20000, seed: 'b1' });
  const debit = importLines(t, { statementId: 'e3a-d', ...chained(t), entries: [{ ref: 'DB1', amountMinor: 20000, cd: 'DBIT', name: 'Druckerei Tannenbach AG' }] }).lines['DB1'];
  const counts = rowCounts(t.store, t.workspaceId);
  const mix = refused(
    bookBankLine(t.ctx, { bankTxnId: line, target: { kind: 'open_item', allocations: [{ documentId: a.id, amountMinor: a.totalMinor }, { documentId: foreign.id, amountMinor: foreign.totalMinor }] }, idempotencyKey: 'x1' }),
    'allocation_contact_mismatch',
  );
  assert.equal(mix.documentId, foreign.id);
  const tooMuch = refused(
    bookBankLine(t.ctx, { bankTxnId: line, target: { kind: 'open_item', allocations: [{ documentId: a.id, amountMinor: a.totalMinor + 1 }] }, idempotencyKey: 'x2' }),
    'allocation_exceeds_open',
  );
  assert.equal(tooMuch.openMinor, a.totalMinor);
  // A bill on a credit line, an invoice on a debit line: the sides never mix.
  refused(bookBankLine(t.ctx, { bankTxnId: line, target: { kind: 'open_item', allocations: [{ documentId: bill.vendorBillId, amountMinor: 20000 }] }, idempotencyKey: 'x3' }), 'wrong_direction');
  refused(bookBankLine(t.ctx, { bankTxnId: debit, target: { kind: 'open_item', allocations: [{ documentId: a.id, amountMinor: 20000 }] }, idempotencyKey: 'x4' }), 'wrong_direction');
  // Shape: one of documentId and allocations, a positive amount, no repeat.
  refused(bookBankLine(t.ctx, { bankTxnId: line, target: { kind: 'open_item', documentId: a.id, allocations: [{ documentId: a.id, amountMinor: 100 }] }, idempotencyKey: 'x5' }), 'invalid_input');
  refused(bookBankLine(t.ctx, { bankTxnId: line, target: { kind: 'open_item', allocations: [{ documentId: a.id, amountMinor: 0 }] }, idempotencyKey: 'x6' }), 'invalid_input');
  refused(bookBankLine(t.ctx, { bankTxnId: line, target: { kind: 'open_item', allocations: [{ documentId: a.id, amountMinor: 100 }, { documentId: a.id, amountMinor: 100 }] }, idempotencyKey: 'x7' }), 'invalid_input');
  refused(bookBankLine(t.ctx, { bankTxnId: line, target: { kind: 'open_item', allocations: [] }, idempotencyKey: 'x8' }), 'invalid_input');
  assert.deepEqual(rowCounts(t.store, t.workspaceId), counts, 'no refusal wrote a row');
});

test('a debit settles several bills of one vendor in one payment; write_off is for invoices only', () => {
  const t = world();
  const vendorId = must(createContact(t.ctx, { partyRole: 'vendor', name: 'Druckerei Tannenbach AG', idempotencyKey: 'v1' }), 'v').contact.id;
  const bills = [12000, 8000].map((gross, i) => {
    const bill = must(createVendorBill(t.ctx, { vendorId, billDate: '2026-07-01', dueDate: '2026-07-20', amountMinor: gross, expenseAccountId: t.acc('6500'), idempotencyKey: `bill-${i}` }), 'bill');
    must(postVendorBill(t.ctx, { vendorBillId: bill.vendorBillId, idempotencyKey: `post-${i}` }), 'post');
    return bill.vendorBillId;
  });
  const debit = importLines(t, { statementId: 'e3a-v', ...chained(t), entries: [{ ref: 'DB2', amountMinor: 20000, cd: 'DBIT', name: 'Druckerei Tannenbach AG' }] }).lines['DB2'];
  const target = { kind: 'open_item', allocations: [{ documentId: bills[0], amountMinor: 12000 }, { documentId: bills[1], amountMinor: 8000 }] };
  refused(bookBankLine(t.ctx, { bankTxnId: debit, target: { ...target, remainder: 'write_off' }, idempotencyKey: 'v0' }), 'unsupported');
  const res = must(bookBankLine(t.ctx, { bankTxnId: debit, target, idempotencyKey: 'v1' }), 'bills');
  assert.equal(res.paymentIds.length, 1);
  const settled = t.store.db
    .prepare('SELECT target_id AS bill, amount_minor AS amount FROM payment_allocation WHERE payment_id = ? ORDER BY rowid')
    .all(res.paymentId);
  assert.deepEqual(settled, [{ bill: bills[0], amount: 12000 }, { bill: bills[1], amount: 8000 }], 'one allocation per bill in the one payment');
  assert.equal(balanceOf(t.store, t.workspaceId, '2000'), 0);
});

test('§H-TENANT: another workspace\'s invoice is not_found and nothing moves', () => {
  const t = world();
  const b = secondWorkspace(t);
  const theirs = issueInvoice(b.ctx, { contactId: b.customerId, key: 'inv-b-ws' });
  const line = credit(t, theirs.totalMinor);
  const countsA = rowCounts(t.store, t.workspaceId);
  const countsB = rowCounts(t.store, b.workspaceId);
  refused(bookBankLine(t.ctx, { bankTxnId: line, target: { kind: 'open_item', allocations: [{ documentId: theirs.id, amountMinor: theirs.totalMinor }] }, idempotencyKey: 'tn1' }), 'not_found');
  assert.deepEqual(rowCounts(t.store, t.workspaceId), countsA);
  assert.deepEqual(rowCounts(t.store, b.workspaceId), countsB);
  assert.equal(statusOf(t, theirs.id), 'issued');
});
