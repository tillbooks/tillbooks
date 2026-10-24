/**
 * CRITIC PROBES, D178 E3 (bank parity: contact, several documents, Spesen, the FX counter-leg, the preview,
 * the inbox paging). Non-author, round 1. SYNTHETIC BY CONSTRUCTION: invented parties, IBANs from the A19
 * samples the bank suites use, statements spelled by hand in `test/banking/bank-inbox-support.mjs`.
 *
 * Each probe attacks one money-path guarantee on ROWS. A probe written as `{ todo }` documents a finding
 * the branch does not yet hold (see docs/critique/bank-parity-e3-critic-r1.md); the rest hold.
 */

import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { world, importLines, must, refused, rowCounts, balanceOf, issueInvoice, assertClaimInvariantHolds, secondWorkspace, SAVINGS_IBAN } from '../banking/bank-inbox-support.mjs';
import { addEmployee, submittedClaim } from '../hr/support.mjs';
import { seedRate } from '../payments/support.mjs';
import { bookBankLine, reopenBankLine, createBankAccount, listBankInbox } from '../../dist/core/banking/index.js';
import { composeBankLine } from '../../dist/core/banking/bankBooking.js';
import { approveClaim, reimburseClaim } from '../../dist/core/hr/index.js';
import { reversePayment, allocatePayment, PAYMENT_INTENTS } from '../../dist/core/payments/index.js';
import { reverseEntry } from '../../dist/core/ledger/index.js';
import { computeFxRevaluation } from '../../dist/core/fx/index.js';
import { createAccount } from '../../dist/core/accounts/index.js';
import { getAction } from '../../dist/api/registry.js';
import { postedBill } from '../banking/bank-inbox-support.mjs';
import { createVendorBill, postVendorBill } from '../../dist/core/purchase/index.js';

afterEach(assertClaimInvariantHolds);

/** Every row a dry run could leave behind, the memo and the audit chain included. */
function fullCounts(t) {
  const one = (sql) => t.store.db.prepare(sql).get(t.workspaceId).n;
  return {
    ...rowCounts(t.store, t.workspaceId),
    audit: one('SELECT COUNT(*) AS n FROM audit_log WHERE workspace_id = ?'),
    memo: one('SELECT COUNT(*) AS n FROM idempotency WHERE workspace_id = ?'),
    claimsStatus: t.store.db.prepare("SELECT group_concat(status, ',') AS n FROM (SELECT status FROM expense_claim WHERE workspace_id = ? ORDER BY rowid)").get(t.workspaceId).n,
    docStatus: t.store.db.prepare("SELECT group_concat(status, ',') AS n FROM (SELECT status FROM document WHERE workspace_id = ? ORDER BY rowid)").get(t.workspaceId).n,
  };
}

function approvedClaims(t, amounts = [4000, 4550]) {
  const { employeeId } = addEmployee(t.ctx, { firstName: 'Anna', lastName: 'Beispiel' }, 'p-emp');
  const ids = amounts.map((amountMinor, i) => {
    const c = submittedClaim(t.ctx, employeeId, { amountMinor, title: `Reise ${i}` }, `p-c${i}`);
    must(approveClaim(t.ctx, { claimId: c.claimId, confirm: true, idempotencyKey: `p-ap${i}` }), 'approve');
    return c.claimId;
  });
  return ids;
}

const studio = (t) => ({ store: t.store, clock: t.clock, ids: t.ids, actor: 'studio' });

// --- Spesen paid once only ------------------------------------------------------------------------

test('P-S1: Spesen booked on a bank line cannot be paid again by expense_claim_reimburse (rows, 2260)', () => {
  const t = world();
  const claimIds = approvedClaims(t);
  const line = importLines(t, { statementId: 'ps1', entries: [{ ref: 'S', amountMinor: 8550, cd: 'DBIT', name: 'Anna Beispiel' }] }).lines['S'];
  must(bookBankLine(t.ctx, { bankTxnId: line, target: { kind: 'expense_claims', claimIds }, idempotencyKey: 'ps1' }), 'book');
  const before = fullCounts(t);
  for (const claimId of claimIds) {
    const again = reimburseClaim(t.ctx, { claimId, bankAccountId: t.bankId, confirm: true, idempotencyKey: `again-${claimId}` });
    assert.ok(again.ok === false || again.alreadyReimbursed === true, JSON.stringify(again));
  }
  const after = fullCounts(t);
  assert.equal(after.payments, before.payments, 'no second payment');
  assert.equal(after.entries, before.entries, 'no second entry');
  assert.equal(balanceOf(t.store, t.workspaceId, '2260'), 0, '2260 is not driven into debit');
});

test('P-S2: a claim reimbursed by the verb first is refused on the bank line, nothing written', () => {
  const t = world();
  const [claimId] = approvedClaims(t, [4000]);
  must(reimburseClaim(t.ctx, { claimId, bankAccountId: t.bankId, confirm: true, idempotencyKey: 'verb' }), 'verb pays');
  const line = importLines(t, { statementId: 'ps2', entries: [{ ref: 'S', amountMinor: 4000, cd: 'DBIT', name: 'Anna Beispiel' }] }).lines['S'];
  const before = fullCounts(t);
  refused(bookBankLine(t.ctx, { bankTxnId: line, target: { kind: 'expense_claims', claimIds: [claimId] }, idempotencyKey: 'ps2' }), 'claim_not_approved');
  assert.deepEqual(fullCounts(t), before);
});

test('P-S3: while the line holds a Spesen settlement, the raw Storno of EVERY payment (not only the first) and expense_claim_reverse refuse', () => {
  const t = world();
  const claimIds = approvedClaims(t);
  const line = importLines(t, { statementId: 'ps3', entries: [{ ref: 'S', amountMinor: 8550, cd: 'DBIT', name: 'Anna Beispiel' }] }).lines['S'];
  const res = must(bookBankLine(t.ctx, { bankTxnId: line, target: { kind: 'expense_claims', claimIds }, idempotencyKey: 'ps3' }), 'book');
  const before = fullCounts(t);
  for (const paymentId of res.paymentIds) {
    const r = reversePayment(t.ctx, { paymentId, date: '2026-07-20', intent: PAYMENT_INTENTS.reverse, idempotencyKey: `raw-${paymentId}` });
    assert.equal(r.ok, false, `raw reverse of ${paymentId}: ${JSON.stringify(r)}`);
  }
  for (const entryId of res.entryIds) assert.equal(reverseEntry(t.ctx, { entryId, idempotencyKey: `rawe-${entryId}` }).ok, false, 'raw entry Storno');
  assert.deepEqual(fullCounts(t), before, 'no raw undo moved a row');
  // The one undo: reopen reverses both payments; then the verb may pay each claim exactly once more.
  const undone = must(reopenBankLine(t.ctx, { bankTxnId: line, reason: 'falsche Zeile', idempotencyKey: 'ps3-r' }), 'reopen');
  assert.deepEqual([...undone.reversedPaymentIds].sort(), [...res.paymentIds].sort());
  assert.equal(balanceOf(t.store, t.workspaceId, '2260'), -8550, 'owed again');
  for (const claimId of claimIds) must(reimburseClaim(t.ctx, { claimId, bankAccountId: t.bankId, confirm: true, idempotencyKey: `v-${claimId}` }), 'verb');
  assert.equal(balanceOf(t.store, t.workspaceId, '2260'), 0);
  const live = t.store.db.prepare("SELECT COUNT(*) AS n FROM payment WHERE workspace_id = ? AND status = 'posted'").get(t.workspaceId);
  assert.ok(live.n >= 2);
});

// --- The FX counter-leg ----------------------------------------------------------------------------

function cardLine(t, amountMinor = 9422, cd = 'DBIT', id = 'pfx') {
  return importLines(t, { statementId: id, entries: [{ ref: 'C', amountMinor, cd, name: 'Cloud Hosting Inc' }] }).lines['C'];
}

function entryLines(t, entryId) {
  return t.store.db
    .prepare('SELECT a.number AS n, l.currency AS c, l.debit_minor AS d, l.credit_minor AS k, l.base_debit_minor AS bd, l.base_credit_minor AS bk FROM journal_line l JOIN account a ON a.id = l.account_id WHERE l.entry_id = ? ORDER BY l.rowid')
    .all(entryId);
}

test('P-F1: three USD legs at one effective rate: the preview equals both booked entries line by line; 4906 nets to zero; reopen and rebook leave nothing behind', () => {
  const t = world();
  const line = cardLine(t, 10003);
  const target = {
    kind: 'accounts',
    legs: [
      { accountId: t.acc('6500'), amountMinor: 3333, fx: { currency: 'USD', amountMinor: 3600 } },
      { accountId: t.acc('6570'), amountMinor: 3333, fx: { currency: 'USD', amountMinor: 3600 } },
      { accountId: t.acc('6600'), amountMinor: 3334, fx: { currency: 'USD', amountMinor: 3601 } },
      { accountId: t.acc('6900'), amountMinor: 3 },
    ],
    acknowledgeFx: true,
  };
  const before = fullCounts(t);
  const pre = composeBankLine(t.ctx, { bankTxnId: line, target });
  assert.equal(pre.ok, true, JSON.stringify(pre).slice(0, 400));
  assert.deepEqual(fullCounts(t), before, 'the preview wrote nothing');
  const res = must(bookBankLine(t.ctx, { bankTxnId: line, target, idempotencyKey: 'pf1' }), 'book');
  assert.equal(pre.booking.bookable, true);
  const shown = pre.booking.entries.map((e) => e.lines.map((l) => [l.accountNumber, l.currency, l.debit ?? 0, l.credit ?? 0, l.baseDebit, l.baseCredit]));
  const booked = res.entryIds.map((id) => entryLines(t, id).map((l) => [l.n, l.c, l.d, l.k, l.bd, l.bk]));
  assert.deepEqual(shown.map((e) => e.sort()), booked.map((e) => e.sort()), 'the preview IS the booking');
  assert.equal(balanceOf(t.store, t.workspaceId, '4906'), 0);
  assert.equal(balanceOf(t.store, t.workspaceId, '1020'), -10003);
  assert.deepEqual(must(computeFxRevaluation(t.ctx, { periodEnd: '2026-07-31' }), 'reval').positions, []);
  must(reopenBankLine(t.ctx, { bankTxnId: line, reason: 'neu', idempotencyKey: 'pf1-r' }), 'reopen');
  must(bookBankLine(t.ctx, { bankTxnId: line, target, idempotencyKey: 'pf1-b' }), 'rebook');
  must(reopenBankLine(t.ctx, { bankTxnId: line, reason: 'nochmals', idempotencyKey: 'pf1-r2' }), 'reopen 2');
  for (const n of ['1020', '4906', '6500', '6570', '6600', '6900']) assert.equal(balanceOf(t.store, t.workspaceId, n), 0, n);
  const usdOn4906 = t.store.db
    .prepare("SELECT COALESCE(SUM(l.debit_minor - l.credit_minor), 0) AS n FROM journal_line l JOIN account a ON a.id = l.account_id JOIN journal_entry e ON e.id = l.entry_id WHERE e.workspace_id = ? AND a.number = '4906' AND l.currency = 'USD'")
    .get(t.workspaceId).n;
  assert.equal(usdOn4906, 0, 'the USD on 4906 nets out across the reversals');
});

test('P-F2: a rule target cannot smuggle an fx leg past the acknowledgement; a replay under the key with another target writes nothing', () => {
  const t = world();
  const line = cardLine(t, 9422, 'DBIT', 'pf2');
  const target = { kind: 'accounts', legs: [{ accountId: t.acc('6500'), amountMinor: 9237, fx: { currency: 'USD', amountMinor: 10000 } }, { accountId: t.acc('6900'), amountMinor: 185 }], acknowledgeFx: true };
  must(bookBankLine(t.ctx, { bankTxnId: line, target, idempotencyKey: 'pf2' }), 'book');
  const before = fullCounts(t);
  must(bookBankLine(t.ctx, { bankTxnId: line, target: { kind: 'accounts', legs: [{ accountId: t.acc('6500'), amountMinor: 9422 }] }, idempotencyKey: 'pf2' }), 'replay');
  assert.deepEqual(fullCounts(t), before);
});

// --- The preview: the registry route, an exception inside the dry run --------------------------------

test('P-P1: compose_entry THROUGH THE REGISTRY previews every new target on real lines and writes no row, memo or audit entry', () => {
  const t = world();
  const claimIds = approvedClaims(t);
  const inv = issueInvoice(t.ctx, { contactId: t.customerId, key: 'pp1-inv' });
  must(createAccount(t.ctx, { number: '2030', name: 'Erhaltene Anzahlungen', type: 'liability', idempotencyKey: 'pp1-2030' }), '2030');
  const { lines } = importLines(t, {
    statementId: 'pp1',
    entries: [
      { ref: 'SP', amountMinor: 8550, cd: 'DBIT', name: 'Anna Beispiel' },
      { ref: 'INV', amountMinor: inv.totalMinor + 500, cd: 'CRDT', name: 'Muster AG' },
      { ref: 'CT', amountMinor: 7000, cd: 'CRDT', name: 'Muster AG' },
      { ref: 'FX', amountMinor: 9422, cd: 'DBIT', name: 'Cloud Hosting Inc' },
    ],
  });
  const targets = {
    SP: { kind: 'expense_claims', claimIds },
    INV: { kind: 'open_item', allocations: [{ documentId: inv.id, amountMinor: inv.totalMinor }], remainder: 'on_account' },
    CT: { kind: 'contact', contactId: t.customerId, mode: 'anzahlung', overrideReason: 'Vorschuss' },
    FX: { kind: 'accounts', legs: [{ accountId: t.acc('6500'), amountMinor: 9237, fx: { currency: 'USD', amountMinor: 10000 } }, { accountId: t.acc('6900'), amountMinor: 185 }], acknowledgeFx: true },
  };
  const before = fullCounts(t);
  for (const [ref, target] of Object.entries(targets)) {
    const r = getAction('compose_entry').run(studio(t), { workspaceId: t.workspaceId, mode: 'expand', bankTxnId: lines[ref], target });
    assert.equal(r.ok, true, `${ref}: ${JSON.stringify(r).slice(0, 400)}`);
    assert.equal(r.booking.bookable, true, `${ref}: ${JSON.stringify(r.booking.verdict)}`);
  }
  assert.deepEqual(fullCounts(t), before, 'no preview wrote a row, a memo or an audit entry');
  // And the bookings the previews promised go through on the same lines afterwards.
  for (const [ref, target] of Object.entries(targets)) {
    const b = getAction('book_bank_line').run(studio(t), { workspaceId: t.workspaceId, bankTxnId: lines[ref], target, idempotencyKey: `pp1-${ref}` });
    assert.equal(b.ok, true, `${ref}: ${JSON.stringify(b).slice(0, 400)}`);
  }
});

test('P-P2: an unexpected throw inside the dry run leaves no half state (no open transaction, no row) and the booking still works afterwards', () => {
  const t = world();
  const line = importLines(t, { statementId: 'pp2', entries: [{ ref: 'CT', amountMinor: 7000, cd: 'CRDT', name: 'Muster AG' }] }).lines['CT'];
  const before = fullCounts(t);
  // A trigger fails the decision insert AFTER A14 has written the payment and its entry: a raw SQLite error,
  // not a BankAbort, so it escapes runGuarded inside the dry run.
  t.store.db.exec("CREATE TEMP TRIGGER pp2_boom BEFORE INSERT ON bank_line_decision BEGIN SELECT RAISE(ABORT, 'pp2 boom'); END;");
  let threw = null;
  try {
    composeBankLine(t.ctx, { bankTxnId: line, target: { kind: 'contact', contactId: t.customerId } });
  } catch (e) {
    threw = e;
  }
  t.store.db.exec('DROP TRIGGER pp2_boom');
  assert.ok(threw !== null, 'the throw propagates rather than being reported as a verdict');
  assert.equal(t.store.db.inTransaction, false, 'no transaction left open');
  assert.deepEqual(fullCounts(t), before, 'nothing the dry run wrote survived');
  must(bookBankLine(t.ctx, { bankTxnId: line, target: { kind: 'contact', contactId: t.customerId }, idempotencyKey: 'pp2' }), 'book after');
});

test('P-P3: §H-TENANT in the preview: another workspace\'s claim, contact and invoice are not bookable and reveal nothing', () => {
  const t = world();
  const b = secondWorkspace(t);
  const { employeeId } = addEmployee(b.ctx, { firstName: 'Fremd', lastName: 'Person' }, 'pp3-emp');
  const c = submittedClaim(b.ctx, employeeId, { amountMinor: 4000, title: 'GEHEIM' }, 'pp3-c');
  must(approveClaim(b.ctx, { claimId: c.claimId, confirm: true, idempotencyKey: 'pp3-ap' }), 'approve');
  const inv = issueInvoice(b.ctx, { contactId: b.customerId, key: 'pp3-inv' });
  const { lines } = importLines(t, { statementId: 'pp3', entries: [{ ref: 'D', amountMinor: 4000, cd: 'DBIT' }, { ref: 'C', amountMinor: inv.totalMinor, cd: 'CRDT' }] });
  for (const [ref, target] of [
    ['D', { kind: 'expense_claims', claimIds: [c.claimId] }],
    ['C', { kind: 'contact', contactId: b.customerId }],
    ['C', { kind: 'open_item', allocations: [{ documentId: inv.id, amountMinor: inv.totalMinor }] }],
  ]) {
    const r = must(composeBankLine(t.ctx, { bankTxnId: lines[ref], target }), `preview ${target.kind}`);
    assert.equal(r.booking.bookable, false);
    assert.equal(r.booking.blockedBy, 'not_found');
    assert.doesNotMatch(JSON.stringify(r), /GEHEIM|Fremd/);
  }
});

// --- Allocations ------------------------------------------------------------------------------------

test('P-A1: a write-off is bounded by the TOTAL over all documents, not per document', () => {
  const t = world();
  const a = issueInvoice(t.ctx, { contactId: t.customerId, key: 'pa1-a' });
  const b = issueInvoice(t.ctx, { contactId: t.customerId, key: 'pa1-b' });
  // Find the threshold through the preview: each shortfall alone below it, together above it.
  const probe = (short) => {
    const amount = a.totalMinor + b.totalMinor - 2 * short;
    const id = `pa1-${short}`;
    const line = importLines(t, { statementId: id, entries: [{ ref: 'C', amountMinor: amount, cd: 'CRDT', name: 'Muster AG' }] }).lines['C'];
    return composeBankLine(t.ctx, { bankTxnId: line, target: { kind: 'open_item', allocations: [{ documentId: a.id, amountMinor: a.totalMinor - short }, { documentId: b.id, amountMinor: b.totalMinor - short }], remainder: 'write_off' } });
  };
  let crossed = null;
  for (const short of [100, 200, 300, 500, 800, 1000, 1500, 2000, 2500]) {
    const r = must(probe(short), `preview ${short}`);
    const total = r.booking.documents.reduce((s, d) => s + (d.writeOffMinor ?? 0), 0);
    if (!r.booking.bookable) {
      crossed = { short, total, blockedBy: r.booking.blockedBy };
      break;
    }
    assert.equal(total, 2 * short);
  }
  assert.ok(crossed !== null, 'some total crosses the threshold');
  assert.equal(crossed.blockedBy, 'write_off_above_threshold');
});

test('P-A2: a Guthaben booked on a contact, applied to an invoice, then the line reopened: the invoice is open again and 1100 is whole', () => {
  const t = world();
  const line = importLines(t, { statementId: 'pa2', entries: [{ ref: 'C', amountMinor: 200000, cd: 'CRDT', name: 'Muster AG' }] }).lines['C'];
  const res = must(bookBankLine(t.ctx, { bankTxnId: line, target: { kind: 'contact', contactId: t.customerId }, idempotencyKey: 'pa2' }), 'book');
  const inv = issueInvoice(t.ctx, { contactId: t.customerId, key: 'pa2-inv' });
  must(allocatePayment(t.ctx, { paymentId: res.paymentId, allocations: [{ documentId: inv.id, amountMinor: inv.totalMinor }], intent: PAYMENT_INTENTS.allocate, idempotencyKey: 'pa2-al' }), 'allocate');
  assert.equal(t.store.db.prepare('SELECT status FROM document WHERE id = ?').get(inv.id).status, 'settled');
  must(reopenBankLine(t.ctx, { bankTxnId: line, reason: 'falsch', idempotencyKey: 'pa2-r' }), 'reopen');
  assert.notEqual(t.store.db.prepare('SELECT status FROM document WHERE id = ?').get(inv.id).status, 'settled', 'the invoice is open again');
  assert.equal(balanceOf(t.store, t.workspaceId, '1100'), inv.totalMinor, '1100 carries the invoice again, no Guthaben');
  assert.equal(balanceOf(t.store, t.workspaceId, '1020'), 0);
});

// --- The contact Anzahlung on a foreign Bankkonto (product question) ---------------------------------

test('P-C1: an Anzahlung received in EUR is fixed in CHF at the receipt rate (owner, 21.10.2026), so A22 never revalues 2030', () => {
  const t = world();
  seedRate(t.ctx, { currency: 'EUR', rate: '0.95', asOf: '2026-07-20' });
  seedRate(t.ctx, { currency: 'EUR', rate: '0.90', asOf: '2026-07-31' });
  must(createAccount(t.ctx, { number: '2030', name: 'Erhaltene Anzahlungen', type: 'liability', idempotencyKey: 'pc1-2030' }), '2030');
  const eur = must(createBankAccount(t.ctx, { name: 'EUR-Konto', iban: SAVINGS_IBAN, currency: 'EUR', ledgerAccountId: t.acc('1060'), idempotencyKey: 'pc1-eur' }), 'eur');
  const { lines } = importLines(t, { statementId: 'pc1', currency: 'EUR', iban: SAVINGS_IBAN, entries: [{ ref: 'E', amountMinor: 20000, cd: 'CRDT', name: 'Muster AG' }] }, { bankAccountId: eur.bankAccountId });
  must(bookBankLine(t.ctx, { bankTxnId: lines['E'], target: { kind: 'contact', contactId: t.customerId, mode: 'anzahlung', overrideReason: 'Vorschuss' }, idempotencyKey: 'pc1' }), 'book');
  const reval = must(computeFxRevaluation(t.ctx, { periodEnd: '2026-07-31' }), 'reval');
  const numbers = reval.positions.map((p) => p.number ?? p.accountNumber);
  // Decided by the owner (Q1 of the critique): the default fixes the Anzahlung in CHF; only the EUR bank is revalued.
  assert.ok(!numbers.includes('2030'), `positions: ${JSON.stringify(reval.positions)}`);
  assert.ok(numbers.includes('1060'));
  assert.equal(balanceOf(t.store, t.workspaceId, '2030'), -19000);
});

// --- The inbox: the filtered total equals the rows paged through -------------------------------------

test('P-L1: with direction, status all and a date window, total equals the lines paged through by cursor and by offset, and directionCounts add up', () => {
  const t = world();
  const entries = [];
  for (let i = 0; i < 37; i += 1) {
    entries.push({ ref: `L${i}`, amountMinor: 1000 + i, cd: i % 3 === 0 ? 'DBIT' : 'CRDT', date: `2026-07-${String(10 + (i % 5)).padStart(2, '0')}`, name: 'Muster AG' });
  }
  const { lines } = importLines(t, { statementId: 'pl1', entries });
  must(bookBankLine(t.ctx, { bankTxnId: lines['L1'], target: { kind: 'contact', contactId: t.customerId }, idempotencyKey: 'pl1-b' }), 'decide one');
  const base = { status: 'all', from: '2026-07-11', to: '2026-07-14' };
  const all = must(listBankInbox(t.ctx, { ...base, limit: 200 }), 'all');
  for (const direction of ['in', 'out']) {
    const first = must(listBankInbox(t.ctx, { ...base, direction, limit: 4 }), direction);
    const seen = [...first.lines.map((l) => l.bankTxnId)];
    let cursor = first.nextCursor;
    while (cursor !== null) {
      const page = must(listBankInbox(t.ctx, { ...base, direction, limit: 4, cursor }), 'page');
      seen.push(...page.lines.map((l) => l.bankTxnId));
      cursor = page.nextCursor;
    }
    assert.equal(new Set(seen).size, seen.length, 'no line twice');
    assert.equal(seen.length, first.total, `${direction}: cursor pages see exactly total`);
    const byOffset = [];
    for (let offset = 0; offset < first.total + 4; offset += 4) byOffset.push(...must(listBankInbox(t.ctx, { ...base, direction, limit: 4, offset }), 'off').lines.map((l) => l.bankTxnId));
    assert.deepEqual(byOffset, seen, `${direction}: offset pages see the same sequence`);
    assert.equal(first.directionCounts[direction], first.total);
  }
  assert.equal(all.directionCounts.in + all.directionCounts.out, all.total);
});

// --- Idempotent on ROWS, every new target (the memo and the audit chain counted too) ---------------------

test('P-I1: a same-key replay of every new target writes no row, memo or audit entry; a fresh key refuses line_not_open writing nothing', () => {
  const t = world();
  const claimIds = approvedClaims(t);
  const a = issueInvoice(t.ctx, { contactId: t.customerId, key: 'pi1-a' });
  const b = issueInvoice(t.ctx, { contactId: t.customerId, netMinor: 50000, key: 'pi1-b' });
  must(createAccount(t.ctx, { number: '2030', name: 'Erhaltene Anzahlungen', type: 'liability', idempotencyKey: 'pi1-2030' }), '2030');
  const { lines } = importLines(t, {
    statementId: 'pi1',
    entries: [
      { ref: 'SP', amountMinor: 8550, cd: 'DBIT', name: 'Anna Beispiel' },
      { ref: 'AL', amountMinor: a.totalMinor + b.totalMinor - 50, cd: 'CRDT', name: 'Muster AG' },
      { ref: 'AN', amountMinor: 7000, cd: 'CRDT', name: 'Muster AG' },
    ],
  });
  const cases = {
    SP: { kind: 'expense_claims', claimIds },
    AL: { kind: 'open_item', allocations: [{ documentId: a.id, amountMinor: a.totalMinor }, { documentId: b.id, amountMinor: b.totalMinor - 50 }], remainder: 'write_off' },
    AN: { kind: 'contact', contactId: t.customerId, mode: 'anzahlung', overrideReason: 'Vorschuss' },
  };
  for (const [ref, target] of Object.entries(cases)) {
    const first = must(bookBankLine(t.ctx, { bankTxnId: lines[ref], target, idempotencyKey: `pi1-${ref}` }), `book ${ref}`);
    const counts = fullCounts(t);
    const again = must(bookBankLine(t.ctx, { bankTxnId: lines[ref], target, idempotencyKey: `pi1-${ref}` }), `replay ${ref}`);
    assert.deepEqual(again, first, `${ref}: the replay answers the first result`);
    assert.deepEqual(fullCounts(t), counts, `${ref}: the replay wrote nothing`);
    refused(bookBankLine(t.ctx, { bankTxnId: lines[ref], target, idempotencyKey: `pi1-${ref}-2` }), 'line_not_open');
    assert.deepEqual(fullCounts(t), counts, `${ref}: the second key wrote nothing`);
  }
  assert.equal(balanceOf(t.store, t.workspaceId, '2260'), 0);
});

// --- Round 1 additions: the supplier side of the deviation, the FX preview warnings -----------------------

test('P-A3: a debit over two bills of one vendor with cash left over parks a supplier Guthaben on 2000 only with on_account; the bills are paid in full', () => {
  const t = world();
  const first = postedBill(t, { grossMinor: 30000, seed: 'pa3-1' });
  const second = must(createVendorBill(t.ctx, { vendorId: first.vendorId, billDate: '2026-07-02', dueDate: '2026-07-22', amountMinor: 20000, expenseAccountId: t.acc('6500'), idempotencyKey: 'pa3-b2' }), 'bill 2');
  must(postVendorBill(t.ctx, { vendorBillId: second.vendorBillId, idempotencyKey: 'pa3-p2' }), 'post 2');
  const line = importLines(t, { statementId: 'pa3', entries: [{ ref: 'D', amountMinor: 51000, cd: 'DBIT', name: 'Druckerei Tannenbach AG' }] }).lines['D'];
  const allocations = [{ documentId: first.vendorBillId, amountMinor: 30000 }, { documentId: second.vendorBillId, amountMinor: 20000 }];
  const counts = fullCounts(t);
  refused(bookBankLine(t.ctx, { bankTxnId: line, target: { kind: 'open_item', allocations }, idempotencyKey: 'pa3-x' }), 'deviation_needs_remainder');
  assert.deepEqual(fullCounts(t), counts);
  const res = must(bookBankLine(t.ctx, { bankTxnId: line, target: { kind: 'open_item', allocations, remainder: 'on_account' }, idempotencyKey: 'pa3' }), 'book');
  assert.deepEqual([res.remainder.kind, res.remainder.amountMinor], ['on_account', 1000]);
  assert.equal(balanceOf(t.store, t.workspaceId, '2000'), 1000, 'the 10.00 surplus is a debit (Guthaben) on 2000');
  assert.equal(balanceOf(t.store, t.workspaceId, '1020'), -51000);
});

test('P-F3: the FX preview names every warning the booking gives (control_account_leg on a 1100 leg)', () => {
  const t = world();
  const line = cardLine(t, 9422, 'DBIT', 'pf3');
  const target = { kind: 'accounts', legs: [{ accountId: t.acc('6500'), amountMinor: 9237, fx: { currency: 'USD', amountMinor: 10000 } }, { accountId: t.acc('1100'), amountMinor: 185 }], acknowledgeFx: true };
  const pre = must(composeBankLine(t.ctx, { bankTxnId: line, target }), 'preview');
  const res = must(bookBankLine(t.ctx, { bankTxnId: line, target, idempotencyKey: 'pf3' }), 'book');
  assert.deepEqual([...pre.booking.warnings].sort(), [...res.warnings].sort());
  assert.ok(res.warnings.includes('control_account_leg'), 'FIXED E3-L1: the 1100 leg is named on both');
});
