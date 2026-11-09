// A39 L3, the reversal chokepoint (spec §0 L3, §7 invariant 4, §8): no decision goes stale and no payment
// is reversed by half. `reverse()` in reverseEntry.ts refuses, for EVERY caller, an entry a live bank-line
// claim holds (owned_by reopen_bank_line, naming the line); a `payment` entry belongs to reverse_payment
// when a payment row names it; a `camt` entry belongs to reopen_bank_line while a live decision names it
// or once it has a posted reversal. Every refusal is asserted on ROWS: it moved nothing.
//
// SYNTHETIC DATA ONLY (statements spelled in bank-inbox-support.mjs).

import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  createBankAccount,
  bookBankLine,
  reopenBankLine,
  listBankInbox,
  recordIncomingCredit,
  applyQrMatch,
  overrideQrMatch,
  setCreditorBankProfile,
  createPaymentBatch,
  generatePain001,
  markBatchPaid,
} from '../../dist/core/banking/index.js';
import { postEntry, reverseEntry } from '../../dist/core/ledger/index.js';
import { recordPayment, reversePayment, PAYMENT_INTENTS } from '../../dist/core/payments/payment.js';
import { listOpenItems } from '../../dist/core/debtors/index.js';
import { buildQrrReference } from '../../dist/core/payments/reference.js';
import { assertClaimInvariantHolds, world, importLines, postedBill, issueInvoice, must, refused, rowCounts, balanceOf, MAIN_IBAN, SAVINGS_IBAN } from './bank-inbox-support.mjs';

afterEach(assertClaimInvariantHolds);

const GROSS = 108100;
const status = (t, table, id) => t.store.db.prepare(`SELECT status FROM ${table} WHERE id = ?`).get(id).status;
const stornoOf = (t, entryId) => t.store.db.prepare("SELECT id FROM journal_entry WHERE reverses_entry_id = ? AND status = 'posted'").get(entryId)?.id;

/** The raw journal Storno refuses owned_by `verb` and moves no row. */
function rawRefuses(t, entryId, verb, key) {
  const before = rowCounts(t.store, t.workspaceId);
  const res = refused(reverseEntry(t.ctx, { entryId, idempotencyKey: key }), 'owned_by');
  assert.equal(res.verb, verb, JSON.stringify(res));
  assert.deepEqual(rowCounts(t.store, t.workspaceId), before, 'the refused Storno moved nothing');
  return res;
}

test('C1: the raw Storno of a hand-recorded payment and of its Storno refuses owned_by reverse_payment, which reverses it once', () => {
  const t = world();
  const inv = issueInvoice(t.ctx, { contactId: t.customerId, key: 'c1' });
  const pay = must(recordPayment(t.ctx, { direction: 'incoming', date: '2026-07-20', amountMinor: GROSS, currency: 'CHF', bankAccountId: t.acc('1020'), counterpartyKind: 'customer', counterpartyId: t.customerId, allocations: [{ documentId: inv.id, amountMinor: GROSS }], intent: PAYMENT_INTENTS.record, idempotencyKey: 'pay' }));
  assert.equal(status(t, 'document', inv.id), 'settled');
  rawRefuses(t, pay.entryId, 'reverse_payment', 'raw');
  assert.equal(status(t, 'payment', pay.paymentId), 'posted', 'the payment is untouched');
  must(reversePayment(t.ctx, { paymentId: pay.paymentId, intent: PAYMENT_INTENTS.reverse, idempotencyKey: 'rv' }));
  assert.equal(status(t, 'payment', pay.paymentId), 'reversed');
  assert.notEqual(status(t, 'document', inv.id), 'settled', 'the invoice is open again');
  // 1100 and the OP-Liste agree on what is open.
  const open = must(listOpenItems(t.ctx, {})).items.find((i) => i.documentId === inv.id);
  assert.equal(open.openMinor, GROSS);
  assert.equal(balanceOf(t.store, t.workspaceId, '1100'), GROSS);
  // The payment's Storno is owned too: nobody reverses it raw.
  rawRefuses(t, stornoOf(t, pay.entryId), 'reverse_payment', 'raw-storno');
  refused(reversePayment(t.ctx, { paymentId: pay.paymentId, intent: PAYMENT_INTENTS.reverse, idempotencyKey: 'rv-2' }), 'already_reversed');
});

test('C1: a run\'s item payment marked paid in /creditor-payments is reversed by reverse_payment only; a forged payment entry stays reversible', () => {
  const t = world();
  const bills = [60000, 40000].map((a, i) => postedBill(t, { grossMinor: a, seed: `r-${i}`, vendorName: `Lieferant ${i}` }));
  for (const [i, b] of bills.entries()) must(setCreditorBankProfile(t.ctx, { vendorId: b.vendorId, iban: SAVINGS_IBAN, idempotencyKey: `cbp-${i}` }));
  const batch = must(createPaymentBatch(t.ctx, { bankAccountId: t.bankAccountId, itemIds: bills.map((b) => b.vendorBillId), executionDate: '2026-07-22', idempotencyKey: 'batch' }));
  must(generatePain001(t.ctx, { batchId: batch.batchId, idempotencyKey: 'gen' }));
  const paid = must(markBatchPaid(t.ctx, { batchId: batch.batchId, confirmation: true, valueDate: '2026-07-22', idempotencyKey: 'hand' }));
  const item = t.store.db.prepare('SELECT id, journal_entry_id AS e FROM payment WHERE id = ?').get(paid.paymentIds[0]);
  rawRefuses(t, item.e, 'reverse_payment', 'raw-item');
  must(reversePayment(t.ctx, { paymentId: item.id, intent: PAYMENT_INTENTS.reverse, idempotencyKey: 'rv-item' }));
  rawRefuses(t, stornoOf(t, item.e), 'reverse_payment', 'raw-item-storno');
  // A post_entry that merely calls itself a payment has no payment row behind it: nothing owns it.
  const forged = must(postEntry(t.ctx, { date: '2026-07-20', source: 'payment', description: 'von Hand', idempotencyKey: 'forged', lines: [{ account: t.acc('6500'), debit: 100 }, { account: t.acc('1020'), credit: 100 }] }));
  must(reverseEntry(t.ctx, { entryId: forged.entryId, idempotencyKey: 'raw-forged' }));
});

test('C1: A21\'s override and reopen_bank_line of an open_item still reverse their payment', () => {
  const t = world();
  const inv = issueInvoice(t.ctx, { contactId: t.customerId, key: 'ov' });
  const typed = must(recordIncomingCredit(t.ctx, { bankAccountId: t.bankAccountId, amountMinor: GROSS, valueDate: '2026-07-20', reference: buildQrrReference(inv.number), idempotencyKey: 'typed' }));
  const applied = must(applyQrMatch(t.ctx, { creditId: typed.credit.creditId, invoiceId: inv.id, mode: 'full', confirmed: true, idempotencyKey: 'ap' }));
  must(overrideQrMatch(t.ctx, { creditId: typed.credit.creditId, action: 'unmatch', confirmed: true, idempotencyKey: 'un' }));
  assert.equal(status(t, 'payment', applied.paymentId), 'reversed', 'the queue undoes its own payment through reverse_payment');

  const inv2 = issueInvoice(t.ctx, { contactId: t.customerId, key: 'ro' });
  const { lines } = importLines(t, { statementId: 'RO', entries: [{ ref: 'P', amountMinor: GROSS, cd: 'CRDT' }] });
  const booked = must(bookBankLine(t.ctx, { bankTxnId: lines.P, target: { kind: 'open_item', documentId: inv2.id }, idempotencyKey: 'b' }));
  // While the line holds it, the payment is the line's: reverse_payment refuses, naming the line.
  const held = refused(reversePayment(t.ctx, { paymentId: booked.paymentId, intent: PAYMENT_INTENTS.reverse, idempotencyKey: 'rv' }), 'owned_by');
  assert.deepEqual([held.verb, held.bankTxnId], ['reopen_bank_line', lines.P]);
  rawRefuses(t, booked.entryId, 'reopen_bank_line', 'raw');
  const reopened = must(reopenBankLine(t.ctx, { bankTxnId: lines.P, reason: 'falsche Rechnung', idempotencyKey: 'ro' }));
  assert.deepEqual(reopened.reversedPaymentIds, [booked.paymentId]);
  assert.equal(status(t, 'payment', booked.paymentId), 'reversed');
  assert.notEqual(status(t, 'document', inv2.id), 'settled');
});

test('L3: a camt entry and its Storno refuse the raw tool; a legacy camt entry no live decision names reverses once, its Storno does not', () => {
  const t = world();
  const { lines } = importLines(t, { statementId: 'CA', entries: [{ ref: 'F', amountMinor: 700, cd: 'DBIT' }] });
  const booked = must(bookBankLine(t.ctx, { bankTxnId: lines.F, target: { kind: 'accounts', legs: [{ accountId: t.acc('6900'), amountMinor: 700 }] }, idempotencyKey: 'f' }));
  const held = rawRefuses(t, booked.entryId, 'reopen_bank_line', 'raw');
  assert.equal(held.bankTxnId, lines.F);
  must(reopenBankLine(t.ctx, { bankTxnId: lines.F, reason: 'falsch', idempotencyKey: 'ro' }));
  rawRefuses(t, booked.entryId, 'reopen_bank_line', 'raw-2');
  rawRefuses(t, stornoOf(t, booked.entryId), 'reopen_bank_line', 'raw-storno');

  // A camt entry A20 created before A39, whose decision was adopted superseded (no live decision names it).
  const legacy = must(postEntry(t.ctx, { date: '2026-07-20', source: 'camt', description: 'Bankbuchung vor A39', idempotencyKey: 'legacy', lines: [{ account: t.acc('6900'), debit: 300 }, { account: t.acc('1020'), credit: 300 }] }));
  must(reverseEntry(t.ctx, { entryId: legacy.entryId, idempotencyKey: 'legacy-rv' }));
  rawRefuses(t, stornoOf(t, legacy.entryId), 'reopen_bank_line', 'legacy-storno');
});

test('C5: side one of a transfer matched on side two refuses naming side two and moves nothing; side two, then side one, succeeds', () => {
  const t = world();
  const sav = must(createBankAccount(t.ctx, { name: 'Sparkonto', iban: SAVINGS_IBAN, currency: 'CHF', ledgerAccountId: t.acc('1000'), idempotencyKey: 'sav' })).bankAccountId;
  const main = importLines(t, { statementId: 'M', entries: [{ ref: 'OUT', amountMinor: 50000, cd: 'DBIT', iban: SAVINGS_IBAN, date: '2026-07-25' }] });
  const savings = importLines(t, { statementId: 'S', iban: SAVINGS_IBAN, entries: [{ ref: 'IN', amountMinor: 50000, cd: 'CRDT', iban: MAIN_IBAN, date: '2026-07-25' }] }, { bankAccountId: sav });
  const out = main.lines.OUT;
  const inn = savings.lines.IN;
  const booked = must(bookBankLine(t.ctx, { bankTxnId: out, target: { kind: 'accounts', legs: [{ accountId: t.acc('1000'), amountMinor: 50000 }] }, idempotencyKey: 'one' }));
  must(bookBankLine(t.ctx, { bankTxnId: inn, target: { kind: 'existing_entry', entryId: booked.entryId }, idempotencyKey: 'two' }));

  const before = rowCounts(t.store, t.workspaceId);
  const res = refused(reopenBankLine(t.ctx, { bankTxnId: out, reason: 'falsch', idempotencyKey: 'ro-one' }), 'owned_by');
  assert.deepEqual([res.verb, res.bankTxnId], ['reopen_bank_line', inn], 'the refusal names side two');
  assert.deepEqual(rowCounts(t.store, t.workspaceId), before, 'side one moved nothing, its decision stays live');
  const stateOf = (id) => must(listBankInbox(t.ctx, { status: 'all' })).lines.find((l) => l.bankTxnId === id).state;
  assert.equal(stateOf(out), 'booked');

  must(reopenBankLine(t.ctx, { bankTxnId: inn, reason: 'zuerst Seite zwei', idempotencyKey: 'ro-two' }));
  assert.equal(stateOf(inn), 'open');
  const r1 = must(reopenBankLine(t.ctx, { bankTxnId: out, reason: 'dann Seite eins', idempotencyKey: 'ro-one-b' }));
  assert.deepEqual(r1.reversedEntryIds, [booked.entryId]);
  assert.equal(balanceOf(t.store, t.workspaceId, '1000'), 0, 'the transfer is reversed once');
  assert.equal(balanceOf(t.store, t.workspaceId, '1020'), 0);
});
