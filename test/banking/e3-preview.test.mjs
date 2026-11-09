/**
 * D178 E3 (A39 §17.5): `compose_entry` previews EVERY `book_bank_line` target, writes nothing, and its
 * `booking` block says exactly whether the booking would go through now and why not.
 *
 * SYNTHETIC BY CONSTRUCTION (bank-inbox-support): invented names, sample IBANs, statements by hand.
 *
 * Held: the preview moves no row anywhere (journal, payments, links, the memo table, the audit chain),
 * also when it runs a settlement's booking to read its verdict; `bookable` / `blockedBy` agree with what
 * `book_bank_line` then answers; the deviation and the remainder options a GUI disables Buchen with; the
 * previewed lines are the lines the booking posts.
 */

import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { world, importLines, must, rowCounts, issueInvoice, assertClaimInvariantHolds } from './bank-inbox-support.mjs';
import { addEmployee, submittedClaim } from '../hr/support.mjs';
import { bookBankLine, prevalidateBookBankLine } from '../../dist/core/banking/index.js';
import { composeBankLine } from '../../dist/core/banking/bankBooking.js';
import { approveClaim } from '../../dist/core/hr/index.js';

afterEach(assertClaimInvariantHolds);

/** Every row a preview could leave behind, the memo and the audit chain included. */
function everything(t) {
  const n = (sql) => t.store.db.prepare(sql).get().n;
  return {
    ...rowCounts(t.store, t.workspaceId),
    memo: n('SELECT COUNT(*) AS n FROM idempotency'),
    audit: n('SELECT COUNT(*) AS n FROM audit_log'),
    claims: n('SELECT COUNT(*) AS n FROM expense_claim WHERE status = \'reimbursed\''),
  };
}

/** The posted lines of an entry in the preview's shape (account, sides, CHF). */
function posted(t, entryId) {
  return t.store.db
    .prepare('SELECT account_id AS account, debit_minor AS debit, credit_minor AS credit, base_debit_minor AS baseDebit, base_credit_minor AS baseCredit, currency FROM journal_line WHERE entry_id = ? ORDER BY rowid')
    .all(entryId)
    .map((l) => ({ account: l.account, debit: l.debit, credit: l.credit, baseDebit: l.baseDebit, baseCredit: l.baseCredit, currency: l.currency }));
}

const shape = (lines) =>
  lines.map((l) => ({ account: l.account, debit: l.debit ?? 0, credit: l.credit ?? 0, baseDebit: l.baseDebit, baseCredit: l.baseCredit, currency: l.currency }));

test('several invoices: the deviation, the remainder options and the blocked Buchen, then the booking equals the preview', () => {
  const t = world();
  const a = issueInvoice(t.ctx, { contactId: t.customerId, key: 'inv-a' });
  const b = issueInvoice(t.ctx, { contactId: t.customerId, netMinor: 50000, key: 'inv-b' });
  const line = importLines(t, { statementId: 'e3p', entries: [{ ref: 'CR', amountMinor: a.totalMinor + b.totalMinor + 500, cd: 'CRDT', name: 'Muster AG' }] }).lines['CR'];
  const allocations = [{ documentId: a.id, amountMinor: a.totalMinor }, { documentId: b.id, amountMinor: b.totalMinor }];
  const before = everything(t);
  const blocked = must(composeBankLine(t.ctx, { bankTxnId: line, target: { kind: 'open_item', allocations } }), 'preview');
  assert.equal(blocked.booking.targetKind, 'open_item');
  assert.equal(blocked.booking.bookable, false);
  assert.equal(blocked.booking.blockedBy, 'deviation_needs_remainder');
  assert.equal(blocked.booking.deviationMinor, 500);
  assert.deepEqual(blocked.booking.remainderOptions, ['on_account']);
  assert.deepEqual(
    blocked.booking.documents.map((d) => [d.documentId, d.kind, d.openMinor, d.allocatedMinor, d.openAfterMinor]),
    [
      [a.id, 'invoice', a.totalMinor, a.totalMinor, 0],
      [b.id, 'invoice', b.totalMinor, b.totalMinor, 0],
    ],
  );
  assert.equal(typeof blocked.verdict.sentence['de-CH'], 'string');
  const fine = must(composeBankLine(t.ctx, { bankTxnId: line, target: { kind: 'open_item', allocations, remainder: 'on_account' } }), 'preview ok');
  assert.equal(fine.booking.bookable, true);
  assert.equal(fine.booking.blockedBy, null);
  assert.deepEqual(fine.booking.remainder, { kind: 'on_account', amountMinor: 500 });
  assert.equal(fine.booking.entries.length, 1);
  assert.deepEqual(everything(t), before, 'previews (a booking run and rolled back) moved no row');
  // The governed seat's pre-draft screen agrees with the preview.
  assert.equal(prevalidateBookBankLine(t.ctx, { bankTxnId: line, target: { kind: 'open_item', allocations }, idempotencyKey: 'pv' })?.error, 'deviation_needs_remainder');
  assert.equal(prevalidateBookBankLine(t.ctx, { bankTxnId: line, target: { kind: 'open_item', allocations, remainder: 'on_account' }, idempotencyKey: 'pv' }), undefined);
  const booked = must(bookBankLine(t.ctx, { bankTxnId: line, target: { kind: 'open_item', allocations, remainder: 'on_account' }, idempotencyKey: 'bk' }), 'book');
  assert.deepEqual(shape(fine.booking.entries[0].lines), posted(t, booked.entryId), 'the preview IS the booking');
});

test('a contact: the mode, the account and the verdict; a missing Anzahlungen account blocks with its code', () => {
  const t = world();
  const line = importLines(t, { statementId: 'e3p-c', entries: [{ ref: 'IN', amountMinor: 25000, cd: 'CRDT', name: 'Muster AG' }] }).lines['IN'];
  const before = everything(t);
  const g = must(composeBankLine(t.ctx, { bankTxnId: line, target: { kind: 'contact', contactId: t.customerId } }), 'guthaben');
  assert.equal(g.booking.bookable, true);
  assert.deepEqual(g.booking.contact, { contactId: t.customerId, name: 'Muster AG', counterpartyKind: 'customer', mode: 'guthaben', settingMode: 'guthaben', overridden: false, accountNumber: null });
  assert.deepEqual(g.booking.remainder, { kind: 'on_account', amountMinor: 25000 });
  const anz = must(composeBankLine(t.ctx, { bankTxnId: line, target: { kind: 'contact', contactId: t.customerId, mode: 'anzahlung', overrideReason: 'Vorschuss' } }), 'anzahlung');
  assert.equal(anz.booking.bookable, false);
  assert.equal(anz.booking.blockedBy, 'needs_anzahlung_account');
  const noReason = must(composeBankLine(t.ctx, { bankTxnId: line, target: { kind: 'contact', contactId: t.customerId, mode: 'anzahlung' } }), 'no reason');
  assert.equal(noReason.booking.blockedBy, 'reason_required');
  assert.deepEqual(everything(t), before);
  const booked = must(bookBankLine(t.ctx, { bankTxnId: line, target: { kind: 'contact', contactId: t.customerId }, idempotencyKey: 'c' }), 'book');
  assert.deepEqual(shape(g.booking.entries[0].lines), posted(t, booked.entryId));
});

test('Spesen: the claims and one entry per claim; another total blocks with amount_mismatch', () => {
  const t = world();
  const { employeeId } = addEmployee(t.ctx, { firstName: 'Anna', lastName: 'Beispiel' }, 'emp-p');
  const ids = [4000, 3500].map((amountMinor, i) => {
    const c = submittedClaim(t.ctx, employeeId, { amountMinor, title: `Spesen ${i}` }, `pc${i}`);
    must(approveClaim(t.ctx, { claimId: c.claimId, confirm: true, idempotencyKey: `pa${i}` }), 'approve');
    return c.claimId;
  });
  const lines = importLines(t, { statementId: 'e3p-s', entries: [{ ref: 'OK', amountMinor: 7500, cd: 'DBIT', name: 'Anna Beispiel' }, { ref: 'NO', amountMinor: 7000, cd: 'DBIT', name: 'Anna Beispiel' }] }).lines;
  const before = everything(t);
  const ok = must(composeBankLine(t.ctx, { bankTxnId: lines['OK'], target: { kind: 'expense_claims', claimIds: ids } }), 'ok');
  assert.equal(ok.booking.bookable, true);
  assert.deepEqual(ok.booking.claims.map((c) => [c.claimId, c.totalMinor, c.status]), [[ids[0], 4000, 'approved'], [ids[1], 3500, 'approved']]);
  assert.equal(ok.booking.deviationMinor, 0);
  assert.equal(ok.booking.entries.length, 2, 'one reimbursement entry per claim');
  const off = must(composeBankLine(t.ctx, { bankTxnId: lines['NO'], target: { kind: 'expense_claims', claimIds: ids } }), 'off');
  assert.equal(off.booking.blockedBy, 'amount_mismatch');
  assert.equal(off.booking.deviationMinor, -500);
  assert.deepEqual(everything(t), before, 'the Spesen preview reimbursed nothing');
});

test('the FX counter-leg: the effective rate, both entries, the consequence and the acknowledgement it needs', () => {
  const t = world();
  const line = importLines(t, { statementId: 'e3p-f', entries: [{ ref: 'CARD', amountMinor: 9422, cd: 'DBIT', name: 'Cloud Hosting Inc' }] }).lines['CARD'];
  const target = {
    kind: 'accounts',
    legs: [
      { accountId: t.acc('6500'), amountMinor: 9237, fx: { currency: 'USD', amountMinor: 10000 } },
      { accountId: t.acc('6900'), amountMinor: 185 },
    ],
  };
  const before = everything(t);
  const pending = must(composeBankLine(t.ctx, { bankTxnId: line, target }), 'preview');
  assert.equal(pending.booking.bookable, false);
  assert.equal(pending.booking.blockedBy, 'fx_ack_required');
  assert.deepEqual(pending.booking.acknowledgementsRequired, ['fx_counter_leg']);
  assert.equal(pending.booking.consequences[0].code, 'fx_counter_leg');
  assert.equal(pending.booking.fx.rate, '0.9237');
  assert.deepEqual(
    pending.booking.fx.conversionLines.map((l) => [l.accountNumber, l.currency, l.debit ?? 0, l.credit ?? 0, l.baseDebit, l.baseCredit]),
    [
      ['6500', 'USD', 10000, 0, 9237, 0],
      ['4906', 'USD', 0, 10000, 0, 9237],
    ],
  );
  const ready = must(composeBankLine(t.ctx, { bankTxnId: line, target: { ...target, acknowledgeFx: true } }), 'acknowledged');
  assert.equal(ready.booking.bookable, true);
  assert.deepEqual(everything(t), before);
  const booked = must(bookBankLine(t.ctx, { bankTxnId: line, target: { ...target, acknowledgeFx: true }, idempotencyKey: 'fx' }), 'book');
  assert.deepEqual(shape(ready.booking.entries[0].lines), posted(t, booked.entryIds[0]), 'the conversion entry is the preview');
  assert.deepEqual(
    shape(ready.booking.entries[1].lines).map((l) => [l.account, l.debit, l.credit]).sort(),
    posted(t, booked.entryIds[1]).map((l) => [l.account, l.debit, l.credit]).sort(),
    'the bank entry is the preview',
  );
});

test('an accounts split answers its deviation, and a malformed or unknown target is the read\'s own refusal', () => {
  const t = world();
  const line = importLines(t, { statementId: 'e3p-a', entries: [{ ref: 'FEE', amountMinor: 3000, cd: 'DBIT', name: 'Bank' }] }).lines['FEE'];
  const split = must(composeBankLine(t.ctx, { bankTxnId: line, target: { kind: 'accounts', legs: [{ accountId: t.acc('6900'), amountMinor: 1000 }] } }), 'split');
  assert.equal(split.booking.deviationMinor, 2000);
  assert.equal(split.booking.blockedBy, 'legs_do_not_sum');
  assert.equal(composeBankLine(t.ctx, { bankTxnId: line, target: { kind: 'nonsense' } }).error, 'invalid_input');
  assert.equal(composeBankLine(t.ctx, { bankTxnId: 'bt_nope', target: { kind: 'contact', contactId: t.customerId } }).error, 'not_found');
});
