/**
 * D178 E3 (A39 §17.3): approved expense claims (Spesen) settled from ONE debit bank line through E02's own
 * reimbursement path, never a second posting path.
 *
 * SYNTHETIC BY CONSTRUCTION: invented employees and amounts, statements spelled by hand.
 *
 * Held on ROWS: one A14 payment per claim clearing 2260 (D95), dated the line's booking date, source camt;
 * each claim `reimbursed`; the line claims every payment's bank leg; a replay writes nothing; every
 * refusal writes nothing; `reopen_bank_line` reverses every payment and walks every claim back to
 * `approved`; another workspace's claim is `not_found`; booking Spesen needs `spesen.approve`.
 */

import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { world, importLines, must, refused, rowCounts, balanceOf, secondWorkspace, assertClaimInvariantHolds } from './bank-inbox-support.mjs';
import { addEmployee, submittedClaim, capCtx } from '../hr/support.mjs';
import { bookBankLine, reopenBankLine } from '../../dist/core/banking/index.js';
import { approveClaim, listClaims } from '../../dist/core/hr/index.js';
import { makeContext } from '../../dist/core/context.js';
// D178 point 19 (the E2 re-cut): each further statement of a fixture continues the balance chain, as a bank's do.
import { chained } from './e2-adapt.mjs';

afterEach(assertClaimInvariantHolds);

/** Two approved claims of one employee: 40.00 and 45.50 (each under the CHF 50 receipt threshold). */
function approvedClaims(t) {
  const { employeeId } = addEmployee(t.ctx, { firstName: 'Anna', lastName: 'Beispiel' }, 'emp-e3');
  const one = submittedClaim(t.ctx, employeeId, { amountMinor: 4000, title: 'Zugreise Bern' }, 'c1');
  const two = submittedClaim(t.ctx, employeeId, { amountMinor: 4550, title: 'Messe Basel' }, 'c2');
  for (const c of [one, two]) must(approveClaim(t.ctx, { claimId: c.claimId, confirm: true, idempotencyKey: `ap-${c.claimId}` }), 'approve');
  return { employeeId, claimIds: [one.claimId, two.claimId] };
}

function debit(t, amountMinor, ref = 'SP1', id = 'e3s') {
  return importLines(t, { statementId: id, ...chained(t), entries: [{ ref, amountMinor, cd: 'DBIT', name: 'Anna Beispiel', ustrd: 'Spesen Juli' }] }).lines[ref];
}

function claimStatus(t, id) {
  return t.store.db.prepare('SELECT status, payment_id FROM expense_claim WHERE id = ?').get(id);
}

test('two approved claims settled by one debit: one payment per claim on the line\'s date, 2260 cleared, claims reimbursed', () => {
  const t = world();
  const { claimIds } = approvedClaims(t);
  assert.equal(balanceOf(t.store, t.workspaceId, '2260'), -8550, 'approve owes the employee 85.50 on 2260');
  const line = debit(t, 8550);
  const before = rowCounts(t.store, t.workspaceId);
  const res = must(bookBankLine(t.ctx, { bankTxnId: line, target: { kind: 'expense_claims', claimIds }, idempotencyKey: 'sp1' }), 'book');
  assert.equal(res.targetKind, 'expense_claims');
  assert.equal(res.paymentIds.length, 2);
  assert.deepEqual(res.claimIds, claimIds);
  const after = rowCounts(t.store, t.workspaceId);
  assert.equal(after.payments - before.payments, 2, 'one A14 payment per claim');
  assert.equal(after.links - before.links, 1, 'one decision');
  assert.equal(after.claims - before.claims, 2, 'the line claims both bank legs');
  const pays = t.store.db.prepare('SELECT date, source, direction, counterparty_kind FROM payment WHERE workspace_id = ? ORDER BY rowid').all(t.workspaceId);
  assert.deepEqual(pays, [
    { date: '2026-07-20', source: 'camt', direction: 'outgoing', counterparty_kind: 'supplier' },
    { date: '2026-07-20', source: 'camt', direction: 'outgoing', counterparty_kind: 'supplier' },
  ]);
  assert.equal(balanceOf(t.store, t.workspaceId, '2260'), 0, 'the employee is paid: 2260 nets to zero');
  assert.equal(balanceOf(t.store, t.workspaceId, '1020'), -8550);
  for (const id of claimIds) assert.equal(claimStatus(t, id).status, 'reimbursed');
  const d = t.store.db.prepare("SELECT target_kind, payment_id FROM bank_line_decision WHERE bank_txn_id = ? AND superseded_at IS NULL").get(line);
  assert.deepEqual(d, { target_kind: 'expense_claims', payment_id: res.paymentIds[0] });

  // Replay: nothing moves. A second key: line_not_open, nothing moves.
  const counts = rowCounts(t.store, t.workspaceId);
  must(bookBankLine(t.ctx, { bankTxnId: line, target: { kind: 'expense_claims', claimIds }, idempotencyKey: 'sp1' }), 'replay');
  refused(bookBankLine(t.ctx, { bankTxnId: line, target: { kind: 'expense_claims', claimIds }, idempotencyKey: 'sp2' }), 'line_not_open');
  assert.deepEqual(rowCounts(t.store, t.workspaceId), counts);

  // The undo reverses EVERY payment and walks every claim back to approved.
  const undone = must(reopenBankLine(t.ctx, { bankTxnId: line, reason: 'falsche Spesen', idempotencyKey: 'sp3' }), 'reopen');
  assert.deepEqual([...undone.reversedPaymentIds].sort(), [...res.paymentIds].sort());
  for (const id of claimIds) assert.deepEqual(claimStatus(t, id), { status: 'approved', payment_id: null });
  assert.equal(balanceOf(t.store, t.workspaceId, '2260'), -8550, 'the liability is open again');
  assert.equal(balanceOf(t.store, t.workspaceId, '1020'), 0);
  // ... and the claims book again under a new key.
  must(bookBankLine(t.ctx, { bankTxnId: line, target: { kind: 'expense_claims', claimIds }, idempotencyKey: 'sp4' }), 'rebook');
});

test('refusals write nothing: another total, a claim not approved, money in, a repeat, an empty list', () => {
  const t = world();
  const { employeeId, claimIds } = approvedClaims(t);
  const pending = submittedClaim(t.ctx, employeeId, { amountMinor: 2500, title: 'Taxi' }, 'c3');
  const line = debit(t, 9000);
  const credit = importLines(t, { statementId: 'e3s-c', ...chained(t), entries: [{ ref: 'CR', amountMinor: 8550, cd: 'CRDT', name: 'Anna Beispiel' }] }).lines['CR'];
  const counts = rowCounts(t.store, t.workspaceId);
  const off = refused(bookBankLine(t.ctx, { bankTxnId: line, target: { kind: 'expense_claims', claimIds }, idempotencyKey: 'r1' }), 'amount_mismatch');
  assert.equal(off.deviationMinor, 9000 - 8550);
  assert.equal(off.claimsTotalMinor, 8550);
  assert.equal(typeof off.sentence['de-CH'], 'string');
  const notYet = refused(bookBankLine(t.ctx, { bankTxnId: line, target: { kind: 'expense_claims', claimIds: [pending.claimId] }, idempotencyKey: 'r2' }), 'claim_not_approved');
  assert.equal(notYet.status, 'submitted');
  refused(bookBankLine(t.ctx, { bankTxnId: credit, target: { kind: 'expense_claims', claimIds }, idempotencyKey: 'r3' }), 'wrong_direction');
  refused(bookBankLine(t.ctx, { bankTxnId: line, target: { kind: 'expense_claims', claimIds: [claimIds[0], claimIds[0]] }, idempotencyKey: 'r4' }), 'invalid_input');
  refused(bookBankLine(t.ctx, { bankTxnId: line, target: { kind: 'expense_claims', claimIds: [] }, idempotencyKey: 'r5' }), 'invalid_input');
  assert.deepEqual(rowCounts(t.store, t.workspaceId), counts);
  for (const id of claimIds) assert.equal(claimStatus(t, id).status, 'approved');
});

test('booking Spesen needs spesen.approve; without it nothing moves', () => {
  const t = world();
  const { claimIds } = approvedClaims(t);
  const line = debit(t, 8550);
  const counts = rowCounts(t.store, t.workspaceId);
  const clerk = capCtx(t, 'clerk', ['post', 'pay', 'read_sales']);
  refused(bookBankLine(clerk, { bankTxnId: line, target: { kind: 'expense_claims', claimIds }, idempotencyKey: 'cap1' }), 'permission_denied');
  assert.deepEqual(rowCounts(t.store, t.workspaceId), counts);
});

test('§H-TENANT: another workspace\'s claim is not_found and nothing moves in either workspace', () => {
  const t = world();
  const b = secondWorkspace(t);
  const theirs = approvedClaims({ ...t, ctx: b.ctx, workspaceId: b.workspaceId });
  const line = debit(t, 8550);
  const countsA = rowCounts(t.store, t.workspaceId);
  const countsB = rowCounts(t.store, b.workspaceId);
  refused(bookBankLine(t.ctx, { bankTxnId: line, target: { kind: 'expense_claims', claimIds: theirs.claimIds }, idempotencyKey: 'tn1' }), 'not_found');
  assert.deepEqual(rowCounts(t.store, t.workspaceId), countsA);
  assert.deepEqual(rowCounts(t.store, b.workspaceId), countsB);
  for (const id of theirs.claimIds) assert.equal(claimStatus(t, id).status, 'approved');
});

test('the picker data: expense_claim_list names the claimant on every claim', () => {
  const t = world();
  approvedClaims(t);
  const approver = makeContext(t.store, { workspaceId: t.workspaceId, actor: 'user_1', clock: t.clock, ids: t.ids });
  const listed = must(listClaims(approver, { status: 'approved' }), 'list');
  assert.equal(listed.claims.length, 2);
  for (const c of listed.claims) assert.equal(c.employeeName, 'Anna Beispiel');
});
