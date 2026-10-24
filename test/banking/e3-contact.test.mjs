/**
 * D178 E3 (A39 §17.1): a bank line booked to a CONTACT with no document (bexio's "Kundenbuchung"), for
 * customers and suppliers, in both modes, all four directions.
 *
 * SYNTHETIC BY CONSTRUCTION: every IBAN is the published sample the A19 suite uses or invented with a
 * correct check pair, every name is invented, every statement is spelled by hand in `bank-inbox-support`.
 *
 * What is held here, on ROWS, not only on answers: the Guthaben is ONE A14 payment with the contact as
 * counterparty and no allocation (A16 lists it, `allocate_payment` applies it later); the Anzahlung is ONE
 * A02 entry on the configured account; a replay writes nothing; `reopen_bank_line` reverses what the
 * decision created; a per-call mode override needs its reason and records it; every refusal writes
 * nothing; and another workspace's contact is `not_found` (§H-TENANT).
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
  secondWorkspace,
  assertClaimInvariantHolds,
  SAVINGS_IBAN,
} from './bank-inbox-support.mjs';
import { seedRate } from '../payments/support.mjs';
import { bookBankLine, reopenBankLine, createBankAccount } from '../../dist/core/banking/index.js';
import { settingsSet } from '../../dist/core/settings/index.js';
import { createAccount } from '../../dist/core/accounts/index.js';
import { allocatePayment, PAYMENT_INTENTS } from '../../dist/core/payments/index.js';
import { customerBalance } from '../../dist/core/debtors/index.js';
import { computeFxRevaluation } from '../../dist/core/fx/index.js';
import { createContact, archiveContact, mergeContacts } from '../../dist/core/sales/index.js';

afterEach(assertClaimInvariantHolds);

const CUSTOMER_IBAN = 'CH4431999123000889012';

/** One statement with the four directions a contact booking covers. */
function fourLines(t, id = 'e3c') {
  return importLines(t, {
    statementId: id,
    entries: [
      { ref: 'IN-CUST', amountMinor: 50000, cd: 'CRDT', name: 'Muster AG', iban: CUSTOMER_IBAN, ustrd: 'Anzahlung Projekt Seeblick' },
      { ref: 'OUT-SUPP', amountMinor: 30000, cd: 'DBIT', name: 'Druckerei Tannenbach AG', ustrd: 'Vorauszahlung Broschüren' },
      { ref: 'OUT-CUST', amountMinor: 12000, cd: 'DBIT', name: 'Muster AG', ustrd: 'Rückerstattung' },
      { ref: 'IN-SUPP', amountMinor: 8000, cd: 'CRDT', name: 'Druckerei Tannenbach AG', ustrd: 'Gutschrift Rückzahlung' },
    ],
  });
}

function vendor(t, key = 'v-e3') {
  return must(createContact(t.ctx, { partyRole: 'vendor', name: 'Druckerei Tannenbach AG', idempotencyKey: key }), 'vendor').contact.id;
}

function decisionOf(t, bankTxnId) {
  return t.store.db
    .prepare('SELECT target_kind, state, payment_id, entry_id, contact_id, note, remainder_mode, remainder_minor FROM bank_line_decision WHERE workspace_id = ? AND bank_txn_id = ? AND superseded_at IS NULL')
    .get(t.workspaceId, bankTxnId);
}

test('Guthaben (the default): money in from a customer is ONE A14 payment with the contact and no allocation, applied later by allocate_payment', () => {
  const t = world();
  const { lines } = fourLines(t);
  const before = rowCounts(t.store, t.workspaceId);
  const res = must(bookBankLine(t.ctx, { bankTxnId: lines['IN-CUST'], target: { kind: 'contact', contactId: t.customerId }, idempotencyKey: 'c1' }), 'book');
  assert.equal(res.targetKind, 'contact');
  assert.equal(res.state, 'booked');
  assert.deepEqual(res.contact, { contactId: t.customerId, counterpartyKind: 'customer', mode: 'guthaben', overridden: false, accountNumber: null });
  assert.deepEqual(res.remainder, { kind: 'on_account', amountMinor: 50000, documentOpenMinor: null, feeOpenMinor: null });
  const after = rowCounts(t.store, t.workspaceId);
  assert.equal(after.payments - before.payments, 1, 'one payment');
  assert.equal(after.allocations - before.allocations, 0, 'no allocation: the whole amount is the Guthaben');
  assert.equal(after.entries - before.entries, 1, 'one entry, A14 posts it');
  const payment = t.store.db.prepare('SELECT direction, counterparty_kind, counterparty_id, source, amount_minor FROM payment WHERE id = ?').get(res.paymentId);
  assert.deepEqual(payment, { direction: 'incoming', counterparty_kind: 'customer', counterparty_id: t.customerId, source: 'camt', amount_minor: 50000 });
  assert.equal(balanceOf(t.store, t.workspaceId, '1100'), -50000, 'the Guthaben sits on 1100 Debitoren as a credit');
  assert.equal(balanceOf(t.store, t.workspaceId, '1020'), 50000);
  const d = decisionOf(t, lines['IN-CUST']);
  assert.equal(d.target_kind, 'contact');
  assert.equal(d.contact_id, t.customerId);
  assert.equal(d.remainder_mode, 'on_account');
  assert.equal(d.remainder_minor, 50000);
  assert.equal(d.note, null, 'no override, no note');
  // A16 shows it as the customer's Guthaben.
  const bal = must(customerBalance(t.ctx, { customerId: t.customerId, asOf: '2026-07-31' }), 'balance');
  assert.equal(bal.onAccountMinor, 50000);
  // The existing apply path settles a later invoice with it: no ledger effect, the invoice is settled.
  const inv = issueInvoice(t.ctx, { contactId: t.customerId, netMinor: 40000, key: 'inv-e3' });
  const entriesBefore = rowCounts(t.store, t.workspaceId).entries;
  must(allocatePayment(t.ctx, { paymentId: res.paymentId, allocations: [{ documentId: inv.id, amountMinor: inv.totalMinor }], intent: PAYMENT_INTENTS.allocate, idempotencyKey: 'alloc-1' }), 'allocate');
  assert.equal(rowCounts(t.store, t.workspaceId).entries, entriesBefore, 'applying a Guthaben posts nothing');
  const status = t.store.db.prepare('SELECT status FROM document WHERE id = ?').get(inv.id).status;
  assert.equal(status, 'settled');
});

test('the four directions in Guthaben mode land on the right control account with the right sign', () => {
  const t = world();
  const vendorId = vendor(t);
  const { lines } = fourLines(t);
  must(bookBankLine(t.ctx, { bankTxnId: lines['OUT-SUPP'], target: { kind: 'contact', contactId: vendorId }, idempotencyKey: 'd1' }), 'out to supplier');
  assert.equal(balanceOf(t.store, t.workspaceId, '2000'), 30000, 'a prepayment to a supplier is a debit on 2000 Kreditoren');
  must(bookBankLine(t.ctx, { bankTxnId: lines['IN-SUPP'], target: { kind: 'contact', contactId: vendorId }, idempotencyKey: 'd2' }), 'in from supplier');
  assert.equal(balanceOf(t.store, t.workspaceId, '2000'), 22000, 'a refund from the supplier credits 2000');
  must(bookBankLine(t.ctx, { bankTxnId: lines['OUT-CUST'], target: { kind: 'contact', contactId: t.customerId, beyondGuthaben: true }, idempotencyKey: 'd3' }), 'out to customer');
  assert.equal(balanceOf(t.store, t.workspaceId, '1100'), 12000, 'a refund to a customer debits 1100');
  const pays = t.store.db.prepare('SELECT direction, counterparty_kind FROM payment WHERE workspace_id = ? ORDER BY rowid').all(t.workspaceId);
  assert.deepEqual(pays, [
    { direction: 'outgoing', counterparty_kind: 'supplier' },
    { direction: 'incoming', counterparty_kind: 'supplier' },
    { direction: 'outgoing', counterparty_kind: 'customer' },
  ]);
  // A16 nets the refund against the customer with its own sign: a positive open item, not a Guthaben.
  const bal = must(customerBalance(t.ctx, { customerId: t.customerId, asOf: '2026-07-31' }), 'balance');
  assert.equal(bal.onAccountMinor, -12000);
  assert.equal(balanceOf(t.store, t.workspaceId, '1020'), -30000 + 8000 - 12000);
});

test('a replay writes nothing; a second key on the decided line refuses line_not_open and writes nothing', () => {
  const t = world();
  const { lines } = fourLines(t);
  const input = { bankTxnId: lines['IN-CUST'], target: { kind: 'contact', contactId: t.customerId }, idempotencyKey: 'r1' };
  const first = must(bookBankLine(t.ctx, input), 'first');
  const counts = rowCounts(t.store, t.workspaceId);
  const again = must(bookBankLine(t.ctx, input), 'replay');
  assert.equal(again.paymentId, first.paymentId);
  assert.deepEqual(rowCounts(t.store, t.workspaceId), counts, 'the replay moved no row');
  refused(bookBankLine(t.ctx, { ...input, idempotencyKey: 'r2' }), 'line_not_open');
  assert.deepEqual(rowCounts(t.store, t.workspaceId), counts, 'the refusal moved no row');
});

test('reopen_bank_line reverses the Guthaben payment and the line is open again', () => {
  const t = world();
  const { lines } = fourLines(t);
  const booked = must(bookBankLine(t.ctx, { bankTxnId: lines['IN-CUST'], target: { kind: 'contact', contactId: t.customerId }, idempotencyKey: 'o1' }), 'book');
  const undone = must(reopenBankLine(t.ctx, { bankTxnId: lines['IN-CUST'], reason: 'falscher Kontakt', idempotencyKey: 'o2' }), 'reopen');
  assert.deepEqual(undone.reversedPaymentIds, [booked.paymentId]);
  assert.equal(balanceOf(t.store, t.workspaceId, '1100'), 0);
  assert.equal(balanceOf(t.store, t.workspaceId, '1020'), 0);
  assert.equal(decisionOf(t, lines['IN-CUST']), undefined, 'no live decision');
  // and it books again, to another contact, under a new key
  const other = must(createContact(t.ctx, { partyRole: 'customer', name: 'Seeblick GmbH', idempotencyKey: 'c-other' }), 'other').contact.id;
  must(bookBankLine(t.ctx, { bankTxnId: lines['IN-CUST'], target: { kind: 'contact', contactId: other }, idempotencyKey: 'o3' }), 'rebook');
  assert.equal(decisionOf(t, lines['IN-CUST']).contact_id, other);
});

test('Anzahlung mode (the setting): ONE entry on the configured account; refused until the account exists', () => {
  const t = world();
  const vendorId = vendor(t);
  const { lines } = fourLines(t);
  must(settingsSet(t.ctx, { key: 'bank.contact_booking_mode', value: 'anzahlung', reason: 'Vorauszahlungen getrennt führen', idempotencyKey: 's1' }), 'setting');
  const counts = rowCounts(t.store, t.workspaceId);
  const missing = refused(bookBankLine(t.ctx, { bankTxnId: lines['IN-CUST'], target: { kind: 'contact', contactId: t.customerId }, idempotencyKey: 'a1' }), 'needs_anzahlung_account');
  assert.equal(missing.accountNumber, '2030');
  assert.equal(missing.settingKey, 'bank.anzahlung_customer_account');
  assert.equal(typeof missing.sentence['de-CH'], 'string');
  assert.deepEqual(rowCounts(t.store, t.workspaceId), counts, 'the refusal wrote nothing');

  must(createAccount(t.ctx, { number: '2030', name: 'Erhaltene Anzahlungen', type: 'liability', idempotencyKey: 'acc-2030' }), '2030');
  must(createAccount(t.ctx, { number: '1190', name: 'Sonstige kurzfristige Forderungen', type: 'asset', idempotencyKey: 'acc-1190' }), '1190');
  const cust = must(bookBankLine(t.ctx, { bankTxnId: lines['IN-CUST'], target: { kind: 'contact', contactId: t.customerId }, idempotencyKey: 'a2' }), 'customer prepayment');
  assert.equal(cust.paymentId, null, 'no A14 payment: an Anzahlung is not a receivable');
  assert.deepEqual(cust.contact, { contactId: t.customerId, counterpartyKind: 'customer', mode: 'anzahlung', overridden: false, accountNumber: '2030' });
  assert.equal(balanceOf(t.store, t.workspaceId, '2030'), -50000, 'credited to 2030 Erhaltene Anzahlungen');
  assert.equal(balanceOf(t.store, t.workspaceId, '1100'), 0, 'never through 1100');
  const d = decisionOf(t, lines['IN-CUST']);
  assert.equal(d.entry_id, cust.entryId);
  assert.equal(d.contact_id, t.customerId);
  assert.equal(d.payment_id, null);

  must(bookBankLine(t.ctx, { bankTxnId: lines['OUT-SUPP'], target: { kind: 'contact', contactId: vendorId }, idempotencyKey: 'a3' }), 'supplier prepayment');
  assert.equal(balanceOf(t.store, t.workspaceId, '1190'), 30000, 'debited to 1190');
  must(bookBankLine(t.ctx, { bankTxnId: lines['OUT-CUST'], target: { kind: 'contact', contactId: t.customerId }, idempotencyKey: 'a4' }), 'customer refund');
  assert.equal(balanceOf(t.store, t.workspaceId, '2030'), -38000, 'a refund to the customer debits 2030');
  must(bookBankLine(t.ctx, { bankTxnId: lines['IN-SUPP'], target: { kind: 'contact', contactId: vendorId }, idempotencyKey: 'a5' }), 'supplier refund');
  assert.equal(balanceOf(t.store, t.workspaceId, '1190'), 22000, 'a refund from the supplier credits 1190');

  // The undo reverses the entry.
  const undone = must(reopenBankLine(t.ctx, { bankTxnId: lines['IN-CUST'], reason: 'war ein Guthaben', idempotencyKey: 'a6' }), 'reopen');
  assert.deepEqual(undone.reversedEntryIds, [cust.entryId]);
  assert.equal(balanceOf(t.store, t.workspaceId, '2030'), 12000);
});

test('a per-call mode override needs its reason, records it on the decision and answers overridden', () => {
  const t = world();
  const { lines } = fourLines(t);
  must(createAccount(t.ctx, { number: '2030', name: 'Erhaltene Anzahlungen', type: 'liability', idempotencyKey: 'acc-2030' }), '2030');
  const counts = rowCounts(t.store, t.workspaceId);
  refused(bookBankLine(t.ctx, { bankTxnId: lines['IN-CUST'], target: { kind: 'contact', contactId: t.customerId, mode: 'anzahlung' }, idempotencyKey: 'ov1' }), 'reason_required');
  refused(bookBankLine(t.ctx, { bankTxnId: lines['IN-CUST'], target: { kind: 'contact', contactId: t.customerId, mode: 'anzahlung', overrideReason: '   ' }, idempotencyKey: 'ov2' }), 'reason_required');
  assert.deepEqual(rowCounts(t.store, t.workspaceId), counts);
  const res = must(
    bookBankLine(t.ctx, { bankTxnId: lines['IN-CUST'], target: { kind: 'contact', contactId: t.customerId, mode: 'anzahlung', overrideReason: 'Projektvorschuss laut Vertrag' }, idempotencyKey: 'ov3' }),
    'override',
  );
  assert.equal(res.contact.overridden, true);
  assert.equal(res.contact.mode, 'anzahlung');
  assert.equal(decisionOf(t, lines['IN-CUST']).note, 'abweichend: anzahlung; Grund: Projektvorschuss laut Vertrag');
  // The setting's own mode needs no reason (the refund has no Guthaben to net against, so it states that).
  must(bookBankLine(t.ctx, { bankTxnId: lines['OUT-CUST'], target: { kind: 'contact', contactId: t.customerId, mode: 'guthaben', beyondGuthaben: true }, idempotencyKey: 'ov4' }), 'same as setting');
  assert.equal(decisionOf(t, lines['OUT-CUST']).note, 'Rückzahlung über das Guthaben hinaus');
});

test('refusals: an account of the wrong kind, an archived or merged contact, a malformed target; each writes nothing', () => {
  const t = world();
  const vendorId = vendor(t);
  const { lines } = fourLines(t);
  must(createAccount(t.ctx, { number: '2030', name: 'Erhaltene Anzahlungen', type: 'liability', idempotencyKey: 'acc-2030' }), '2030');
  must(settingsSet(t.ctx, { key: 'bank.contact_booking_mode', value: 'anzahlung', reason: 'Test', idempotencyKey: 's1' }), 'mode');
  must(settingsSet(t.ctx, { key: 'bank.anzahlung_supplier_account', value: '2030', reason: 'Test', idempotencyKey: 's2' }), 'supplier account');
  const counts = rowCounts(t.store, t.workspaceId);
  const wrong = refused(bookBankLine(t.ctx, { bankTxnId: lines['OUT-SUPP'], target: { kind: 'contact', contactId: vendorId }, idempotencyKey: 'x1' }), 'invalid_anzahlung_account');
  assert.equal(wrong.expectedType, 'asset');
  must(settingsSet(t.ctx, { key: 'bank.anzahlung_supplier_account', value: '1100', reason: 'Test', idempotencyKey: 's3' }), 'control account');
  refused(bookBankLine(t.ctx, { bankTxnId: lines['OUT-SUPP'], target: { kind: 'contact', contactId: vendorId }, idempotencyKey: 'x2' }), 'invalid_anzahlung_account');

  const archived = must(createContact(t.ctx, { partyRole: 'customer', name: 'Alt AG', idempotencyKey: 'c-alt' }), 'alt').contact.id;
  must(archiveContact(t.ctx, { contactId: archived }), 'archive');
  refused(bookBankLine(t.ctx, { bankTxnId: lines['IN-CUST'], target: { kind: 'contact', contactId: archived }, idempotencyKey: 'x3' }), 'contact_archived');

  const dup = must(createContact(t.ctx, { partyRole: 'customer', name: 'Muster AG Doppel', idempotencyKey: 'c-dup' }), 'dup').contact.id;
  must(mergeContacts(t.ctx, { sourceId: dup, targetId: t.customerId, idempotencyKey: 'merge-1' }), 'merge');
  const merged = refused(bookBankLine(t.ctx, { bankTxnId: lines['IN-CUST'], target: { kind: 'contact', contactId: dup }, idempotencyKey: 'x4' }), 'counterparty_merged');
  assert.equal(merged.survivorId, t.customerId);

  refused(bookBankLine(t.ctx, { bankTxnId: lines['IN-CUST'], target: { kind: 'contact' }, idempotencyKey: 'x5' }), 'invalid_input');
  refused(bookBankLine(t.ctx, { bankTxnId: lines['IN-CUST'], target: { kind: 'contact', contactId: t.customerId, mode: 'vorschuss' }, idempotencyKey: 'x6' }), 'invalid_input');
  refused(bookBankLine(t.ctx, { bankTxnId: lines['IN-CUST'], target: { kind: 'contact', contactId: t.customerId, counterpartyKind: 'employee' }, idempotencyKey: 'x7' }), 'invalid_input');
  assert.deepEqual(rowCounts(t.store, t.workspaceId), { ...counts, }, 'no refusal wrote a row');
});

test('§H-TENANT: another workspace\'s contact is not_found and nothing moves in either workspace', () => {
  const t = world();
  const b = secondWorkspace(t);
  const { lines } = fourLines(t);
  const countsA = rowCounts(t.store, t.workspaceId);
  const countsB = rowCounts(t.store, b.workspaceId);
  refused(bookBankLine(t.ctx, { bankTxnId: lines['IN-CUST'], target: { kind: 'contact', contactId: b.customerId }, idempotencyKey: 'tn1' }), 'not_found');
  // and the other workspace cannot book this workspace's line at all
  refused(bookBankLine(b.ctx, { bankTxnId: lines['IN-CUST'], target: { kind: 'contact', contactId: b.customerId }, idempotencyKey: 'tn2' }), 'not_found');
  assert.deepEqual(rowCounts(t.store, t.workspaceId), countsA);
  assert.deepEqual(rowCounts(t.store, b.workspaceId), countsB);
});

test('the contact on a decision is frozen like the rest of the row', () => {
  const t = world();
  const { lines } = fourLines(t);
  must(bookBankLine(t.ctx, { bankTxnId: lines['IN-CUST'], target: { kind: 'contact', contactId: t.customerId }, idempotencyKey: 'f1' }), 'book');
  const other = must(createContact(t.ctx, { partyRole: 'customer', name: 'Andere AG', idempotencyKey: 'c-andere' }), 'other').contact.id;
  assert.throws(
    () => t.store.db.prepare('UPDATE bank_line_decision SET contact_id = ? WHERE workspace_id = ? AND bank_txn_id = ?').run(other, t.workspaceId, lines['IN-CUST']),
    /only the supersession stamp/,
  );
});

/** A EUR Bankkonto (an invented second account on 1060) with two EUR credits from the customer. */
function eurWorld() {
  const t = world();
  seedRate(t.ctx, { currency: 'EUR', rate: '0.95', asOf: '2026-07-20' });
  seedRate(t.ctx, { currency: 'EUR', rate: '0.90', asOf: '2026-07-31' });
  must(createAccount(t.ctx, { number: '2030', name: 'Erhaltene Anzahlungen', type: 'liability', idempotencyKey: 'acc-2030' }), '2030');
  const eur = must(createBankAccount(t.ctx, { name: 'EUR-Konto', iban: SAVINGS_IBAN, currency: 'EUR', ledgerAccountId: t.acc('1060'), idempotencyKey: 'eur-acc' }), 'eur');
  const { lines } = importLines(
    t,
    { statementId: 'e3c-eur', currency: 'EUR', iban: SAVINGS_IBAN, entries: [{ ref: 'EU1', amountMinor: 20000, cd: 'CRDT', name: 'Muster AG' }, { ref: 'EU2', amountMinor: 10000, cd: 'CRDT', name: 'Muster AG' }] },
    { bankAccountId: eur.bankAccountId },
  );
  return { t, lines };
}

function entryRows(t, entryId) {
  return t.store.db
    .prepare('SELECT a.number AS number, l.currency AS currency, l.debit_minor AS debit, l.credit_minor AS credit, l.base_debit_minor AS baseDebit, l.base_credit_minor AS baseCredit FROM journal_line l JOIN account a ON a.id = l.account_id WHERE l.entry_id = ? ORDER BY l.rowid')
    .all(entryId);
}

test('an Anzahlung on a EUR Bankkonto is FIXED in CHF at the receipt rate (the default): never revalued, the bank leg stays EUR', () => {
  const { t, lines } = eurWorld();
  const anz = must(
    bookBankLine(t.ctx, { bankTxnId: lines['EU1'], target: { kind: 'contact', contactId: t.customerId, mode: 'anzahlung', overrideReason: 'Vorschuss in EUR' }, idempotencyKey: 'eu1' }),
    'anzahlung in EUR',
  );
  assert.deepEqual(anz.fx, { currency: 'EUR', foreignMinor: 20000, baseMinor: 19000, rate: '0.95' });
  assert.equal(anz.entryIds.length, 2);
  const [conversion, fixed] = anz.entryIds;
  assert.equal(anz.entryId, fixed, 'the decision names the CHF entry');
  assert.deepEqual(entryRows(t, conversion), [
    { number: '1060', currency: 'EUR', debit: 20000, credit: 0, baseDebit: 19000, baseCredit: 0 },
    { number: '3806', currency: 'EUR', debit: 0, credit: 20000, baseDebit: 0, baseCredit: 19000 },
  ]);
  assert.deepEqual(entryRows(t, fixed), [
    { number: '3806', currency: 'CHF', debit: 19000, credit: 0, baseDebit: 19000, baseCredit: 0 },
    { number: '2030', currency: 'CHF', debit: 0, credit: 19000, baseDebit: 0, baseCredit: 19000 },
  ]);
  assert.equal(balanceOf(t.store, t.workspaceId, '3806'), 0, 'the conversion account nets to zero');
  assert.equal(balanceOf(t.store, t.workspaceId, '2030'), -19000);
  // At the period end the EUR money on the bank is revalued, the Anzahlung is not.
  const numbers = must(computeFxRevaluation(t.ctx, { periodEnd: '2026-07-31' }), 'reval').positions.map((p) => p.accountNumber);
  assert.ok(numbers.includes('1060'), 'the EUR bank balance is a monetary position');
  assert.ok(!numbers.includes('2030'), 'the fixed Anzahlung is never revalued');
  // A Guthaben from a EUR account is refused by name (A14 books payments in the base currency).
  const counts = rowCounts(t.store, t.workspaceId);
  const g = refused(bookBankLine(t.ctx, { bankTxnId: lines['EU2'], target: { kind: 'contact', contactId: t.customerId }, idempotencyKey: 'eu2' }), 'unsupported');
  assert.equal(g.reason, 'foreign_currency_settlement');
  assert.match(g.sentence['de-CH'], /Anzahlung/);
  assert.deepEqual(rowCounts(t.store, t.workspaceId), counts);
  // The undo reverses both entries.
  const undone = must(reopenBankLine(t.ctx, { bankTxnId: lines['EU1'], reason: 'falsch', idempotencyKey: 'eu1-r' }), 'reopen');
  assert.deepEqual([...undone.reversedEntryIds].sort(), [...anz.entryIds].sort());
  for (const n of ['1060', '2030', '3806']) assert.equal(balanceOf(t.store, t.workspaceId, n), 0, n);
});

test('the setting bank.anzahlung_fx_mode foreign keeps the Anzahlung in EUR, revalued at the period end', () => {
  const { t, lines } = eurWorld();
  must(settingsSet(t.ctx, { key: 'bank.anzahlung_fx_mode', value: 'foreign', reason: 'Fremdwährung halten', idempotencyKey: 'fxm' }), 'setting');
  const anz = must(
    bookBankLine(t.ctx, { bankTxnId: lines['EU1'], target: { kind: 'contact', contactId: t.customerId, mode: 'anzahlung', overrideReason: 'Vorschuss in EUR' }, idempotencyKey: 'eu1' }),
    'anzahlung in EUR',
  );
  assert.deepEqual(anz.entryIds, [anz.entryId], 'one entry');
  assert.equal(anz.fx, undefined);
  assert.deepEqual(
    entryRows(t, anz.entryId).map((r) => [r.number, r.currency, r.debit + r.credit, r.baseDebit + r.baseCredit]),
    [
      ['1060', 'EUR', 20000, 19000],
      ['2030', 'EUR', 20000, 19000],
    ],
  );
  const numbers = must(computeFxRevaluation(t.ctx, { periodEnd: '2026-07-31' }), 'reval').positions.map((p) => p.accountNumber);
  assert.ok(numbers.includes('2030'), 'held in EUR, the Anzahlung is revalued');
});
