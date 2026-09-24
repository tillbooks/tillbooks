// E02 money-path invariants. These are the assertions a non-author critic verifies BITE: each one
// fails if the guard it names is removed.
//
//   - approve POSTS via A02, append-only + idempotent, balanced, employee-payable (2260) == claim total
//   - the reimbursement credit lands on the DEDICATED employee-payable account, NOT 2000 Kreditoren (D95)
//   - the total booked is unchanged by D95: only the credit account moved from 2000 to 2260
//   - the P8 preview writes nothing
//   - a locked period refuses with no partial post
//   - reimburse pays via A14 exactly once and clears 2260 (vendor AP 2000 stays untouched)
//   - self-approval is refused
//   - §H-TENANT: a foreign claim is invisible
//   - tx-atomicity: every refused write posts nothing and writes zero rows
//   - the reversing discipline: a posted claim is immutable and corrected only by reverse_entry

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { lockPeriod, reverseEntry } from '../../dist/core/ledger/index.js';
import { approveClaim, reimburseClaim, rejectClaim, getClaim } from '../../dist/core/hr/index.js';
import { setup, addEmployee, submittedClaim, counts, payablesBalance, vendorApBalance, accountBalance, claimRow, secondWorkspace } from './support.mjs';

const AMOUNT = 4000; // CHF 40.00, under the receipt threshold, no VAT

test('E02: approve POSTS via A02, balanced, employee-payable 2260 == claim total, source expense_claim', () => {
  const t = setup();
  const { employeeId } = addEmployee(t.ctx);
  const { claimId } = submittedClaim(t.ctx, employeeId);
  const before = counts(t.store, t.workspaceId);

  const res = approveClaim(t.ctx, { claimId, confirm: true, idempotencyKey: 'ap-1' });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.ok(res.postedEntryId, 'no posted entry id');

  const after = counts(t.store, t.workspaceId);
  assert.equal(after.entries, before.entries + 1, 'exactly one entry posted');
  assert.equal(payablesBalance(t.store, t.workspaceId), AMOUNT, 'employee-payable 2260 credited the claim total');

  const entry = t.store.db.prepare('SELECT source, status FROM journal_entry WHERE id = ?').get(res.postedEntryId);
  assert.equal(entry.source, 'expense_claim');
  assert.equal(entry.status, 'posted');
  const bal = t.store.db.prepare('SELECT COALESCE(SUM(base_debit_minor),0) d, COALESCE(SUM(base_credit_minor),0) c FROM journal_line WHERE entry_id = ?').get(res.postedEntryId);
  assert.equal(bal.d, bal.c, 'entry is balanced');
  assert.equal(claimRow(t.store, t.workspaceId, claimId).status, 'approved');
});

test('E02 D95: the reimbursement liability credits employee-payable 2260, NOT vendor AP 2000; total unchanged', () => {
  const t = setup();
  const { employeeId } = addEmployee(t.ctx);
  // A VAT line so the entry has an expense leg, a Vorsteuer leg AND the payable credit: exactly the
  // shape D95 moves. CHF 40 gross at 8.1% input: net 3700, tax 300, gross 4000 credited to 2260.
  const { claimId } = submittedClaim(t.ctx, employeeId, { taxCode: 'VST-M', category: 'supplies' });

  const res = approveClaim(t.ctx, { claimId, confirm: true, idempotencyKey: 'ap' });
  assert.equal(res.ok, true, JSON.stringify(res));

  // The credit moved to 2260 and 2000 Kreditoren (vendor AP) is left completely untouched.
  assert.equal(payablesBalance(t.store, t.workspaceId), AMOUNT, 'the whole gross credit is on 2260');
  assert.equal(vendorApBalance(t.store, t.workspaceId), 0, '2000 Kreditoren never carries an employee obligation');

  // The TOTAL booked did not move: the credit side equals the claim gross, and the entry still
  // balances. Only the account changed (2260 instead of 2000), not the figure.
  const totalCredit = accountBalance(t.store, t.workspaceId, '2260');
  const claimGross = t.store.db.prepare('SELECT total_base_minor FROM expense_claim WHERE id = ?').get(claimId).total_base_minor;
  assert.equal(totalCredit, claimGross, 'the 2260 credit equals the claim gross total, the figure did not move');
  const bal = t.store.db.prepare('SELECT COALESCE(SUM(base_debit_minor),0) d, COALESCE(SUM(base_credit_minor),0) c FROM journal_line WHERE entry_id = ?').get(res.postedEntryId);
  assert.equal(bal.d, bal.c, 'entry still balances after the account moved');

  // The single credit leg of the approve entry sits on 2260 and no journal line of this entry touches 2000.
  const on2000 = t.store.db.prepare("SELECT COUNT(*) n FROM journal_line l JOIN account a ON a.id = l.account_id WHERE l.entry_id = ? AND a.number = '2000'").get(res.postedEntryId).n;
  assert.equal(on2000, 0, 'the approve entry has no leg on 2000 Kreditoren');
});

test('E02: re-approving NEVER double-posts (same key replays; any key refused by the status gate)', () => {
  const t = setup();
  const { employeeId } = addEmployee(t.ctx);
  const { claimId } = submittedClaim(t.ctx, employeeId);

  const first = approveClaim(t.ctx, { claimId, confirm: true, idempotencyKey: 'ap-1' });
  assert.equal(first.ok, true);
  const afterFirst = counts(t.store, t.workspaceId);

  // Same key: memo replay, same entry, no new rows.
  const replay = approveClaim(t.ctx, { claimId, confirm: true, idempotencyKey: 'ap-1' });
  assert.equal(replay.ok, true);
  assert.equal(replay.postedEntryId, first.postedEntryId);
  assert.deepEqual(counts(t.store, t.workspaceId), afterFirst, 'a replay wrote nothing');

  // Different key after approval: the status gate refuses, nothing posts.
  const again = approveClaim(t.ctx, { claimId, confirm: true, idempotencyKey: 'ap-2' });
  assert.equal(again.ok, false);
  assert.equal(again.error, 'invalid_transition');
  assert.deepEqual(counts(t.store, t.workspaceId), afterFirst, 'a refused re-approve wrote nothing');
});

test('E02: the P8 preview writes NOTHING (approve without confirm)', () => {
  const t = setup();
  const { employeeId } = addEmployee(t.ctx);
  const { claimId } = submittedClaim(t.ctx, employeeId);
  const before = counts(t.store, t.workspaceId);

  const preview = approveClaim(t.ctx, { claimId, idempotencyKey: 'ap-prev' });
  assert.equal(preview.ok, true);
  assert.equal(preview.confirmed, false);
  assert.ok(preview.preview, 'a preview was returned');
  assert.deepEqual(counts(t.store, t.workspaceId), before, 'the preview posted nothing');
  assert.equal(claimRow(t.store, t.workspaceId, claimId).status, 'submitted', 'the claim is still submitted');
});

test('E02: a LOCKED period refuses approve with no partial post (§H-PERIOD, pre-checked)', () => {
  const t = setup();
  const { employeeId } = addEmployee(t.ctx);
  const { claimId } = submittedClaim(t.ctx, employeeId);
  const period = t.ctx.clock.now().slice(0, 7);
  assert.equal(lockPeriod(t.ctx, { period, kind: 'hard', idempotencyKey: 'lock' }).ok, true);
  const before = counts(t.store, t.workspaceId);

  const res = approveClaim(t.ctx, { claimId, confirm: true, idempotencyKey: 'ap-locked' });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'period_locked');
  assert.deepEqual(counts(t.store, t.workspaceId), before, 'a period-locked approve posted nothing');
  assert.equal(claimRow(t.store, t.workspaceId, claimId).status, 'submitted');
});

test('E02: reimburse pays via A14 exactly ONCE and clears employee-payable 2260 (vendor AP 2000 untouched)', () => {
  const t = setup();
  const { employeeId } = addEmployee(t.ctx);
  const { claimId } = submittedClaim(t.ctx, employeeId);
  assert.equal(approveClaim(t.ctx, { claimId, confirm: true, idempotencyKey: 'ap' }).ok, true);
  assert.equal(payablesBalance(t.store, t.workspaceId), AMOUNT, 'liability booked on 2260');
  assert.equal(vendorApBalance(t.store, t.workspaceId), 0, '2000 Kreditoren untouched after approve');
  const beforePay = counts(t.store, t.workspaceId);

  const res = reimburseClaim(t.ctx, { claimId, bankAccountId: t.bankId, confirm: true, idempotencyKey: 'rb-1' });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.transmitted, false);
  assert.equal(res.reason, 'cloud_tier');
  assert.ok(res.paymentId, 'a payment was recorded');
  assert.equal(counts(t.store, t.workspaceId).payments, beforePay.payments + 1, 'one payment');
  assert.equal(payablesBalance(t.store, t.workspaceId), 0, 'employee-payable 2260 cleared to zero');
  assert.equal(vendorApBalance(t.store, t.workspaceId), 0, '2000 Kreditoren never moved: reimburse debits 2260, not 2000');
  assert.equal(claimRow(t.store, t.workspaceId, claimId).status, 'reimbursed');

  // Idempotent: a reimbursed claim is never paid twice.
  const again = reimburseClaim(t.ctx, { claimId, bankAccountId: t.bankId, confirm: true, idempotencyKey: 'rb-2' });
  assert.equal(again.ok, true);
  assert.equal(again.alreadyReimbursed, true);
  assert.equal(counts(t.store, t.workspaceId).payments, beforePay.payments + 1, 'no second payment');
});

test('E02: reimburse preview writes nothing (no confirm)', () => {
  const t = setup();
  const { employeeId } = addEmployee(t.ctx);
  const { claimId } = submittedClaim(t.ctx, employeeId);
  assert.equal(approveClaim(t.ctx, { claimId, confirm: true, idempotencyKey: 'ap' }).ok, true);
  const before = counts(t.store, t.workspaceId);

  const res = reimburseClaim(t.ctx, { claimId, bankAccountId: t.bankId, idempotencyKey: 'rb-prev' });
  assert.equal(res.ok, true);
  assert.equal(res.confirmed, false);
  assert.equal(res.transmitted, false);
  assert.deepEqual(counts(t.store, t.workspaceId), before, 'the reimburse preview paid nothing');
  assert.equal(claimRow(t.store, t.workspaceId, claimId).status, 'approved');
});

test('E02: self-approval is REFUSED, nothing posts (four-eyes)', () => {
  const t = setup(); // ctx actor is user_1
  const { employeeId } = addEmployee(t.ctx, { actorRef: 'user_1' });
  const { claimId } = submittedClaim(t.ctx, employeeId);
  const before = counts(t.store, t.workspaceId);

  const res = approveClaim(t.ctx, { claimId, confirm: true, idempotencyKey: 'self' });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'self_approval');
  assert.deepEqual(counts(t.store, t.workspaceId), before, 'a self-approval posted nothing');
});

test('E02 §H-TENANT: a claim in another workspace is invisible and unapprovable', () => {
  const t = setup();
  const { employeeId } = addEmployee(t.ctx);
  const { claimId } = submittedClaim(t.ctx, employeeId);
  const other = secondWorkspace(t);
  const before = counts(t.store, t.workspaceId);

  const approve = approveClaim(other.ctx, { claimId, confirm: true, idempotencyKey: 'x' });
  assert.equal(approve.ok, false);
  assert.equal(approve.error, 'not_found');
  const read = getClaim(other.ctx, { claimId });
  assert.equal(read.ok, false);
  assert.equal(read.error, 'not_found');
  assert.deepEqual(counts(t.store, t.workspaceId), before, 'a cross-tenant approve posted nothing');
});

test('E02 tx-atomicity: a refused approve (no employee contact) writes ZERO rows', () => {
  const t = setup();
  const { employeeId } = addEmployee(t.ctx, { contactId: null }); // no contact
  const { claimId } = submittedClaim(t.ctx, employeeId);
  const before = counts(t.store, t.workspaceId);

  const res = approveClaim(t.ctx, { claimId, confirm: true, idempotencyKey: 'nc' });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'needs_employee_contact');
  assert.deepEqual(counts(t.store, t.workspaceId), before, 'a refused approve wrote nothing');
  assert.equal(claimRow(t.store, t.workspaceId, claimId).status, 'submitted');
});

test('E02 reversing discipline: an approved claim is immutable and corrected only by reverse_entry', () => {
  const t = setup();
  const { employeeId } = addEmployee(t.ctx);
  const { claimId } = submittedClaim(t.ctx, employeeId);
  const approved = approveClaim(t.ctx, { claimId, confirm: true, idempotencyKey: 'ap' });
  assert.equal(approved.ok, true);

  // A reject on an APPROVED claim is refused: no destructive walk-back of a posting.
  const reject = rejectClaim(t.ctx, { claimId, reason: 'oops', idempotencyKey: 'rj' });
  assert.equal(reject.ok, false);
  assert.equal(reject.error, 'invalid_transition');

  // The DB trigger freezes the posted_entry_id: an attempt to change it raises.
  assert.throws(() => {
    t.store.db.prepare('UPDATE expense_claim SET posted_entry_id = ? WHERE id = ?').run('someone-else', claimId);
  }, /expense_claim_posted_entry_immutable/);
  // And the claim cannot be deleted.
  assert.throws(() => {
    t.store.db.prepare('DELETE FROM expense_claim WHERE id = ?').run(claimId);
  }, /expense_claim_immutable/);

  // The lawful correction is an A02 reversing entry, which nets the employee-payable account back to
  // zero without touching the claim row.
  const reversed = reverseEntry(t.ctx, { entryId: approved.postedEntryId, idempotencyKey: 'rev' });
  assert.equal(reversed.ok, true);
  assert.equal(payablesBalance(t.store, t.workspaceId), 0, 'the reversal cleared employee-payable 2260');
});
