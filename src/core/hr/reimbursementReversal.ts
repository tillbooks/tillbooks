/**
 * The E02 side of an A14 payment reversal (D95 employee-payable path).
 *
 * A reimbursement payment carries NO allocation to its claim: it is an on-account SUPPLIER settlement
 * that clears 2260 Verbindlichkeiten gegenüber Personal through A14's `payableAccountId` override, and
 * the only link back to the claim is `expense_claim.payment_id`. So when `reverse_payment` reopens the
 * 2260 obligation, A14's own allocation-unwind (which walks `payment_allocation` rows) touches nothing:
 * a reimbursement has no allocation rows. Without this seam the claim would stay `reimbursed` while its
 * liability is open again on 2260, a status desync between the E02 sub-ledger and the GL.
 *
 * `reversePayment` (A14) calls this INSIDE its own transaction, importing this file DIRECTLY as a LEAF
 * (never through the `hr` barrel), which is what keeps the two modules acyclic: `hr/claims.ts` imports
 * `payments/payment.ts`, so `payments` must not import `hr`; this file imports nothing from payments
 * (only the context type), so the edge `payment.ts -> reimbursementReversal.ts` closes no cycle. It is
 * the same "import the leaf, never the barrel" discipline the dunning-fee edge in `payment.ts` uses.
 *
 * It reverts every claim this payment reimbursed from `reimbursed` back to `approved`, the state the
 * REOPENED 2260 liability matches exactly (posted on approve, not yet paid), and clears the payment
 * link and the reimbursed stamp so the claim reads like any other approved-but-unpaid claim and a fresh
 * `expense_claim_reimburse` can pay it again cleanly. The status write is permitted by the relaxed
 * `expense_claim_terminal_is_one_way` trigger (schema.ts), which now allows the single system walk-back
 * `reimbursed -> approved` while keeping `rejected`/`cancelled` fully one-way.
 *
 * ATOMICITY: any throw here (a DB trigger RAISE, an audit-port failure) propagates out of
 * `reversePayment`'s transaction and rolls the WHOLE reversal back, the payment status flip and the
 * reversing entry included (§H-AUDIT: no partial write). §H-TENANT scopes both the read and the write.
 * IDEMPOTENT ON ROWS: the `status = 'reimbursed'` predicate on both the SELECT and the UPDATE means a
 * second reversal (or a replay) reverts nothing a first reversal already reverted.
 */

import type { WorkspaceContext } from '../context.js';

export function revertReimbursedClaimsForPayment(ctx: WorkspaceContext, paymentId: string): void {
  const claims = ctx.store.db
    .prepare(
      "SELECT id FROM expense_claim WHERE workspace_id = ? AND payment_id = ? AND status = 'reimbursed'",
    )
    .all(ctx.workspaceId, paymentId) as { id: string }[];
  for (const claim of claims) {
    ctx.store.db
      .prepare(
        "UPDATE expense_claim SET status = 'approved', payment_id = NULL, reimbursed_at = NULL " +
          "WHERE workspace_id = ? AND id = ? AND status = 'reimbursed'",
      )
      .run(ctx.workspaceId, claim.id);
    ctx.audit.record({
      entityKind: 'expense_claim',
      entityId: claim.id,
      action: 'reverse_reimbursement',
      actor: ctx.actor,
      at: ctx.clock.now(),
    });
  }
}
