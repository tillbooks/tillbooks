/**
 * A21, the QR incoming-matching verb surface: the queue reachable from every shipped face.
 *
 * Six verbs, four writes. The vocabulary is the product's own (the A14/A19 rule): the credit list
 * is the **Abgleich** queue, a structured reference is the **QRR** (or the ISO 11649 Creditor
 * Reference), the fee is the **Mahngebühr**, and applying a match **bucht** through A14, never
 * here. A tool description is the only thing an agent has to pick a verb with, so each one says
 * what will and will not move money.
 *
 * THE AGENT STORY IS THE SPLIT (US-A21.5): `record_incoming_credit` and `match_qr_payment` are the
 * safe half (a queue row and a score, no posting), so an agent or a G01 rule may call them freely.
 * `apply_qr_match` and `override_qr_match` are the commitment: P8-gated inside the engine
 * (`confirmed: true`, or the workspace auto-apply dial for a live `high` score), so a human, or a
 * dial a human deliberately switched on, stands behind every settlement. `set_qr_auto_apply` is
 * that dial and is NOT automatable (D65 leg (e)).
 *
 * Defined here rather than inline in `registry.ts` for the reason §H-FX established: the registry
 * is one append-only tool list several capability branches append to at once, so the smaller the
 * hunk, the cheaper the merge. The helpers arrive as a parameter to keep the module graph acyclic.
 */

import type { ActionDef, ActionInput, JsonSchema } from './registry.js';
import type { WorkspaceContext } from '../core/context.js';
import type { Result } from '../core/result.js';
import {
  recordIncomingCredit,
  matchIncomingByQrr,
  applyQrMatch,
  overrideQrMatch,
  listUnmatchedIncoming,
  setQrAutoApply,
} from '../core/banking/index.js';

export interface QrMatchActionHelpers {
  ctxAction(
    name: string,
    kind: 'read' | 'write',
    summary: string,
    inputSchema: JsonSchema,
    call: (ctx: WorkspaceContext, input: ActionInput) => Result,
  ): ActionDef;
  ctxSchema(props?: Record<string, unknown>, required?: string[]): JsonSchema;
  STR: { readonly type: 'string' };
  INT: { readonly type: 'integer' };
  BOOL: { readonly type: 'boolean' };
}

export function qrMatchActions(h: QrMatchActionHelpers): ActionDef[] {
  const { ctxAction, ctxSchema, STR, INT, BOOL } = h;

  return [
    ctxAction(
      'record_incoming_credit',
      'write',
      `Register an incoming bank credit in the Abgleich queue and score it against the open invoices: manual entry today, and the seam A20's camt import will feed later. bankAccountId is the A19 Bankkonto the money landed on (needs_bank_account if unregistered), amountMinor is integer Rappen, valueDate the credit's value date, reference whatever the advice carries (a QRR or Creditor Reference is validated; free text falls to the heuristic lane). Writes the queue row and NOTHING else: no posting, no ledger effect. A bankTxnId already registered returns the existing row (a re-imported statement duplicates nothing), and a repeat call under the same idempotencyKey replays byte-identically.`,
      ctxSchema(
        {
          bankAccountId: STR,
          amountMinor: INT,
          valueDate: STR,
          reference: STR,
          currency: STR,
          payerName: STR,
          bankTxnId: STR,
          idempotencyKey: STR,
        },
        ['bankAccountId', 'amountMinor', 'valueDate', 'idempotencyKey'],
      ),
      (ctx, input) => recordIncomingCredit(ctx, input as never),
    ),
    ctxAction(
      'match_qr_payment',
      'read',
      `Score a credit's facts against the open invoices, writing nothing: revalidates the reference (QRR mod-10 recursive / ISO 11649 mod-97, the same derivation A11 issues with), finds the invoice the reference names, and answers a confidence with the reason in words. 'high' is reserved for an exact reference AND an exact amount, where exact means the invoice's open amount or open + unpaid Mahngebühr (a Mahnung's QR part carries the invoice's own reference). Everything else is 'medium' (amount_short, amount_over, currency_differs) or 'none' (no_invoice, already_paid, ambiguous_reference, reference_invalid, no_reference). A mistyped check digit is reported as a typo and never ranks. Reads only.`,
      ctxSchema({ reference: STR, amountMinor: INT, currency: STR, valueDate: STR }, ['amountMinor']),
      (ctx, input) => matchIncomingByQrr(ctx, input as never),
    ),
    ctxAction(
      'apply_qr_match',
      'write',
      `Settle an invoice from a queued credit, delegating the posting to A14 record_payment (source 'qr'): debit Bank, credit Debitoren, document status and Ist-VAT stamp included, A21 posts nothing itself. Every figure is NET of linked credit notes: a payer holding a Gutschrift owes the principal, and paying it exactly settles in full. mode defaults to 'partial' (allocates up to the open amount, parks any surplus as Guthaben, never writes off); mode 'full' additionally writes off a SHORT credit's residual, and only within the A14 one-click write-off threshold (default CHF 1.00): a larger residual refuses with write_off_above_threshold naming the amount (type a deliberate larger Ausbuchung through record_payment). A foreign-currency credit refuses with currency_mismatch. P8: pass confirmed=true, or the auto-apply dial must be ON with a LIVE 'high' score for exactly this invoice. NOT automatable (D77): a stored rule may never make this judgment. Idempotent per credit AND per decision: the same invoice+mode replays, a different mode refuses honestly as already_applied.`,
      ctxSchema(
        { creditId: STR, invoiceId: STR, mode: STR, confirmed: BOOL, idempotencyKey: STR },
        ['creditId', 'invoiceId', 'idempotencyKey'],
      ),
      (ctx, input) => applyQrMatch(ctx, input as never),
    ),
    ctxAction(
      'override_qr_match',
      'write',
      `The manual decision on any queue row, applied included (US-A21.4). Name the correct invoiceId to re-point (an applied row is first corrected by an A14 reversing payment, §H-AUDIT, then re-applied to the named invoice), or an action: 'unmatch' returns the row to open (reversing first when applied), 'dismiss' marks it as not a customer payment (book it via journal entry instead). Overriding an APPLIED row always requires confirmed=true: it moves money, and the auto-apply dial never covers an override. NOT automatable (D77): reversing a settlement and re-pointing money between debtors is a judgment no stored rule may make. The row keeps the reversal chain and the audit stamp: who overrode what, and when.`,
      ctxSchema(
        { creditId: STR, invoiceId: STR, action: STR, confirmed: BOOL, idempotencyKey: STR },
        ['creditId', 'idempotencyKey'],
      ),
      (ctx, input) => overrideQrMatch(ctx, input as never),
    ),
    ctxAction(
      'list_unmatched_incoming',
      'read',
      `The Abgleich queue: every registered incoming credit with its LIVE score (an open row re-scores on read, so a later-issued invoice is found), the proposed invoice with the exact Rappen figures (open amount, unpaid Mahngebühr, delta), the applied rows with their payment link and correction chain, the counts per lane, and the auto-apply dial state. Filter by Bankkonto, status (open/applied/dismissed) or value-date range. savedViewId applies a saved view (G00): its stored filters are merged underneath any filter named explicitly here. Reads only.`,
      ctxSchema({ bankAccountId: STR, status: STR, from: STR, to: STR, savedViewId: STR }),
      (ctx, input) => listUnmatchedIncoming(ctx, input as never),
    ),
    ctxAction(
      'set_qr_auto_apply',
      'write',
      `Switch the workspace's auto-apply dial for QR matching (P8, default OFF). ON means apply_qr_match may settle WITHOUT a per-call confirmation when, and only when, the live score is 'high' (exact reference, exact amount) for exactly the invoice being applied; every 'medium' and every override still waits for confirmed=true. This verb is deliberately not automatable (D65): a rule that could switch the unattended-money dial on would bypass the human approval the dial exists to record. A repeat call under the same idempotencyKey writes nothing.`,
      ctxSchema({ autoApply: BOOL, idempotencyKey: STR }, ['autoApply', 'idempotencyKey']),
      (ctx, input) => setQrAutoApply(ctx, input as never),
    ),
  ];
}
