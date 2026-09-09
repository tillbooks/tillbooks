// E02 money-path: reversing a reimbursement PAYMENT reverts its claim (D95).
//
// A reimbursement is an on-account SUPPLIER settlement that clears 2260 Verbindlichkeiten gegenüber
// Personal through A14's payableAccountId override, with NO allocation to the claim. So reversing that
// payment reopens the 2260 obligation but, before this fix, left expense_claim.status = 'reimbursed':
// the claim read fully reimbursed while its liability was open again on 2260. These assertions each
// fail if the revert seam (hr/reimbursementReversal.ts, called inside reverse_payment's tx), the
// relaxed terminal trigger, or the tx boundary that makes them atomic is removed. A non-author critic
// verifies they BITE and that none weakens the D95 2260 routing or the append-only discipline.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { makeContext } from '../../dist/core/context.js';
import { reversePayment, PAYMENT_INTENTS } from '../../dist/core/payments/index.js';
import { approveClaim, reimburseClaim, rejectClaim, getClaim } from '../../dist/core/hr/index.js';
import {
  setup,
  addEmployee,
  submittedClaim,
  counts,
  payablesBalance,
  vendorApBalance,
  claimRow,
  secondWorkspace,
} from './support.mjs';

const AMOUNT = 4000; // CHF 40.00, under the receipt threshold, no VAT: 2260 credit == claim total

/** Approve + reimburse a fresh claim, returning the ids the reversal path keys off. */
function reimbursedClaim(t, key = 'rr') {
  const { employeeId } = addEmployee(t.ctx, {}, `${key}-emp`);
  const { claimId } = submittedClaim(t.ctx, employeeId, {}, `${key}-clm`);
  assert.equal(approveClaim(t.ctx, { claimId, confirm: true, idempotencyKey: `${key}-ap` }).ok, true);
  const paid = reimburseClaim(t.ctx, { claimId, bankAccountId: t.bankId, confirm: true, idempotencyKey: `${key}-rb` });
  assert.equal(paid.ok, true, JSON.stringify(paid));
  assert.ok(paid.paymentId, 'a reimbursement payment was recorded');
  assert.equal(claimRow(t.store, t.workspaceId, claimId).status, 'reimbursed');
  assert.equal(payablesBalance(t.store, t.workspaceId), 0, 'employee-payable 2260 cleared by reimburse');
  return { claimId, paymentId: paid.paymentId };
}

function paymentRow(t, paymentId) {
  return t.store.db.prepare('SELECT * FROM payment WHERE workspace_id = ? AND id = ?').get(t.workspaceId, paymentId);
}

test('E02 D95: reversing the reimbursement payment reopens 2260 AND reverts the claim reimbursed->approved', () => {
  const t = setup();
  const { claimId, paymentId } = reimbursedClaim(t, 'happy');
  const payBefore = paymentRow(t, paymentId);
  assert.equal(payBefore.status, 'posted');

  const reversed = reversePayment(t.ctx, {
    paymentId,
    intent: PAYMENT_INTENTS.reverse,
    idempotencyKey: 'happy-rev',
  });
  assert.equal(reversed.ok, true, JSON.stringify(reversed));

  // The obligation is reopened on the DEDICATED employee-payable account, exactly the claim total,
  // and 2000 Kreditoren never moved (D95 routing intact end to end).
  assert.equal(payablesBalance(t.store, t.workspaceId), AMOUNT, '2260 employee-payable reopened to the claim total');
  assert.equal(vendorApBalance(t.store, t.workspaceId), 0, '2000 Kreditoren never touched by the reversal');

  // THE FIX: the claim status now matches the reopened liability, and the payment link is cleared so it
  // reads like any approved-but-unpaid claim. Assert the ACTUAL status value, not just ok.
  const claim = claimRow(t.store, t.workspaceId, claimId);
  assert.equal(claim.status, 'approved', 'claim reverted reimbursed->approved to match the reopened 2260');
  assert.equal(claim.payment_id, null, 'the reimbursement payment link is cleared');
  assert.equal(claim.reimbursed_at, null, 'the reimbursed stamp is cleared');
  assert.ok(claim.posted_entry_id, 'the approve posting is untouched: still approved, not un-posted');

  // Append-only: the payment is a tombstone naming its reversal, its own entry untouched, and the
  // reversal is a NEW entry that mirrors the original leg for leg (never a destructive edit).
  const payAfter = paymentRow(t, paymentId);
  assert.equal(payAfter.status, 'reversed');
  assert.equal(payAfter.journal_entry_id, payBefore.journal_entry_id, 'the original payment entry is untouched');
  assert.ok(payAfter.reversal_entry_id, 'the payment names its reversal entry');
  const original = t.store.db
    .prepare('SELECT a.number, l.base_debit_minor d, l.base_credit_minor c FROM journal_line l JOIN account a ON a.id = l.account_id WHERE l.entry_id = ? ORDER BY a.number')
    .all(payAfter.journal_entry_id);
  const mirror = t.store.db
    .prepare('SELECT a.number, l.base_debit_minor d, l.base_credit_minor c FROM journal_line l JOIN account a ON a.id = l.account_id WHERE l.entry_id = ? ORDER BY a.number')
    .all(payAfter.reversal_entry_id);
  assert.equal(original.length, mirror.length, 'the reversal mirrors every leg');
  for (const l of original) {
    const m = mirror.find((x) => x.number === l.number);
    assert.equal(m.d, l.c, `${l.number} debit/credit mirrored`);
    assert.equal(m.c, l.d, `${l.number} debit/credit mirrored`);
  }

  // A coherent 'approved' state: the claim can be reimbursed AGAIN (a fresh payment), which is the
  // whole point of reverting rather than sealing it.
  const rePaid = reimburseClaim(t.ctx, { claimId, bankAccountId: t.bankId, confirm: true, idempotencyKey: 'happy-rb2' });
  assert.equal(rePaid.ok, true, JSON.stringify(rePaid));
  assert.notEqual(rePaid.paymentId, paymentId, 'a NEW payment settles the re-reimbursement');
  assert.equal(claimRow(t.store, t.workspaceId, claimId).status, 'reimbursed');
  assert.equal(payablesBalance(t.store, t.workspaceId), 0, '2260 cleared again by the second reimburse');
});

test('E02 idempotent-on-rows: a double reversal reverts once and never corrupts the claim', () => {
  const t = setup();
  const { claimId, paymentId } = reimbursedClaim(t, 'idem');
  assert.equal(reversePayment(t.ctx, { paymentId, intent: PAYMENT_INTENTS.reverse, idempotencyKey: 'idem-r1' }).ok, true);
  assert.equal(claimRow(t.store, t.workspaceId, claimId).status, 'approved');
  const afterFirst = counts(t.store, t.workspaceId);

  // A second reversal (new key) is refused already_reversed and touches nothing: the claim stays
  // 'approved', not double-reverted into some other state, and no rows move.
  const second = reversePayment(t.ctx, { paymentId, intent: PAYMENT_INTENTS.reverse, idempotencyKey: 'idem-r2' });
  assert.equal(second.ok, false);
  assert.equal(second.error, 'already_reversed');
  assert.equal(claimRow(t.store, t.workspaceId, claimId).status, 'approved', 'the claim is unchanged by the refused re-reversal');
  assert.deepEqual(counts(t.store, t.workspaceId), afterFirst, 'a refused re-reversal wrote zero rows');

  // A replay of the FIRST reversal (same key) replays its stored result and writes nothing either.
  const replay = reversePayment(t.ctx, { paymentId, intent: PAYMENT_INTENTS.reverse, idempotencyKey: 'idem-r1' });
  assert.equal(replay.ok, true, 'the original key replays its stored success');
  assert.deepEqual(counts(t.store, t.workspaceId), afterFirst, 'the replay wrote zero rows');
});

test('E02 tx-atomicity: a failure DURING the claim revert leaves BOTH the payment and the claim unchanged', () => {
  const t = setup();
  const { claimId, paymentId } = reimbursedClaim(t, 'atom');
  const before = counts(t.store, t.workspaceId);

  // Inject a fault into the claim-revert step: the audit stamp for the revert throws. It fires AFTER
  // reverse_payment has already posted the reversing entry and flipped the payment to 'reversed' in
  // the SAME transaction, so if the operation is not atomic those partial writes would survive. Every
  // other audit event delegates to the fixture's real chain.
  const failing = makeContext(t.store, {
    workspaceId: t.workspaceId,
    actor: t.ctx.actor,
    clock: t.ctx.clock,
    ids: t.ids,
    capabilities: t.ctx.capabilities,
    periods: t.ctx.periods,
    audit: {
      record: (e) => {
        if (e.entityKind === 'expense_claim' && e.action === 'reverse_reimbursement') {
          throw new Error('injected audit failure mid-reversal');
        }
        t.ctx.audit.record(e);
      },
    },
  });

  assert.throws(
    () => reversePayment(failing, { paymentId, intent: PAYMENT_INTENTS.reverse, idempotencyKey: 'atom-rev' }),
    /injected audit failure mid-reversal/,
    'the throw propagates out of the transaction rather than committing a partial reversal',
  );

  // ZERO partial writes: the payment is still posted (never reversed), the claim still reimbursed, the
  // 2260 liability still cleared (the reversing entry rolled back), and no row of any kind survived.
  const pay = paymentRow(t, paymentId);
  assert.equal(pay.status, 'posted', 'the payment status flip rolled back');
  assert.equal(pay.reversal_entry_id, null, 'no reversal entry survives');
  assert.equal(pay.reversed_at, null);
  const claim = claimRow(t.store, t.workspaceId, claimId);
  assert.equal(claim.status, 'reimbursed', 'the claim revert rolled back');
  assert.equal(claim.payment_id, paymentId, 'the payment link is intact');
  assert.ok(claim.reimbursed_at, 'the reimbursed stamp is intact');
  assert.equal(payablesBalance(t.store, t.workspaceId), 0, '2260 stays cleared: the reversing entry did not survive');
  assert.deepEqual(counts(t.store, t.workspaceId), before, 'the failed reversal wrote zero rows');

  // And the slot is not burned: a real reversal with the SAME key now succeeds cleanly, proving the
  // failed attempt left no idempotency tombstone behind.
  const ok = reversePayment(t.ctx, { paymentId, intent: PAYMENT_INTENTS.reverse, idempotencyKey: 'atom-rev' });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal(claimRow(t.store, t.workspaceId, claimId).status, 'approved');
  assert.equal(payablesBalance(t.store, t.workspaceId), AMOUNT, '2260 reopened by the real reversal');
});

test('E02 §H-TENANT: a foreign workspace can neither reverse the payment nor observe the claim', () => {
  const t = setup();
  const { claimId, paymentId } = reimbursedClaim(t, 'ten');
  const other = secondWorkspace(t);
  const before = counts(t.store, t.workspaceId);

  const rev = reversePayment(other.ctx, { paymentId, intent: PAYMENT_INTENTS.reverse, idempotencyKey: 'ten-x' });
  assert.equal(rev.ok, false);
  assert.equal(rev.error, 'not_found', 'a foreign payment id is a not_found, never a reversal');

  const read = getClaim(other.ctx, { claimId });
  assert.equal(read.ok, false);
  assert.equal(read.error, 'not_found', 'the claim is invisible cross-tenant');

  assert.equal(claimRow(t.store, t.workspaceId, claimId).status, 'reimbursed', 'the claim is untouched by the cross-tenant attempt');
  assert.deepEqual(counts(t.store, t.workspaceId), before, 'a cross-tenant reversal wrote zero rows');
});

test('E02 trigger: the terminal relaxation admits ONLY reimbursed->approved, nothing else', () => {
  const t = setup();
  // A reimbursed claim and a rejected claim, both built through the real flow.
  const { claimId: reimbursedId } = reimbursedClaim(t, 'trg');
  const { employeeId } = addEmployee(t.ctx, {}, 'trg2-emp');
  const { claimId: submittedId } = submittedClaim(t.ctx, employeeId, {}, 'trg2-clm');
  assert.equal(rejectClaim(t.ctx, { claimId: submittedId, reason: 'nope', idempotencyKey: 'trg-rj' }).ok, true);
  assert.equal(claimRow(t.store, t.workspaceId, submittedId).status, 'rejected');

  const raises = (from, to, id) =>
    assert.throws(
      () => t.store.db.prepare('UPDATE expense_claim SET status = ? WHERE workspace_id = ? AND id = ?').run(to, t.workspaceId, id),
      /expense_claim_terminal_is_one_way/,
      `${from}->${to} must stay refused`,
    );

  // Every OTHER move off a terminal state is still refused.
  raises('reimbursed', 'rejected', reimbursedId);
  raises('reimbursed', 'cancelled', reimbursedId);
  raises('reimbursed', 'draft', reimbursedId);
  raises('rejected', 'approved', submittedId);
  raises('rejected', 'submitted', submittedId);

  // The one admitted walk-back does NOT raise (the engine writes exactly this on a payment reversal).
  assert.doesNotThrow(() => {
    t.store.db.prepare("UPDATE expense_claim SET status = 'approved' WHERE workspace_id = ? AND id = ?").run(t.workspaceId, reimbursedId);
  }, 'reimbursed->approved is the one permitted system walk-back');
  assert.equal(claimRow(t.store, t.workspaceId, reimbursedId).status, 'approved');
});
