/**
 * A14, the payment verb surface: settlement reachable from every shipped face.
 *
 * Eight verbs, of which THREE are read-only planning calls. That matters more than the count: an
 * agent can establish the whole settlement (which open items, which amounts, which legs) before it
 * commits to anything, and a human sees the identical figures because both faces render the same
 * two read models. `suggest_payment_matches` and `preview_payment` are the read halves of
 * `record_payment`, and nothing about them can write.
 *
 * ONE NAMING RULE binds both faces, the way "Ausstellen" binds them for issuing. The Studio's word
 * for committing a payment is **buchen** and this file's descriptions say "posts"; the word for a
 * correction is **stornieren** and `reverse_payment` says "reverses", never "deletes". A tool
 * description is the only thing an agent has to choose a verb with, so it uses the product's own
 * vocabulary: a customer credit is a **Guthaben** and writing off a residual is an **Ausbuchung**,
 * never "on-account" and never "Abschreibung" (which is depreciation, H03/H04's word).
 *
 * EXPLICIT INTENT (owner decision P9) is on the wire, not in the GUI. Every write requires its own
 * `intent` token, so an agent states deliberately that it means to move money and cannot reach a
 * posting through a preview or by reusing another verb's token. The Studio's confirmation dialog and
 * its "nicht mehr anzeigen" checkbox are one PRESENTATION of that intent: suppressing the dialog
 * changes what a person sees and never what the contract requires.
 *
 * Defined here rather than inline in `registry.ts` for the reason §H-FX established: the registry is
 * the one append-only tool list and several agents append to it at once, so the smaller the hunk the
 * cheaper the merge. The helpers arrive as a parameter to keep the module graph acyclic.
 */

import type { ActionDef, ActionInput, JsonSchema } from './registry.js';
import type { WorkspaceContext } from '../core/context.js';
import type { Result } from '../core/result.js';
import {
  recordPayment,
  allocatePayment,
  reversePayment,
  previewPayment,
  suggestPaymentMatches,
  getPayment,
  listPayments,
  setWriteOffThreshold,
  PAYMENT_INTENTS,
} from '../core/payments/index.js';

export interface PaymentActionHelpers {
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
}

export function paymentActions(h: PaymentActionHelpers): ActionDef[] {
  const { ctxAction, ctxSchema, STR, INT } = h;

  /**
   * One allocation: what it settles on the document, what cash it consumes, and the two reductions.
   *
   * `dunningItemId` names a BOOKED A15 Mahngebühr (a `dunning_item` row) rather than the invoice it
   * rides, and implies `targetKind: 'dunning_fee'` exactly the way `vendorBillId` implies
   * `'vendor_bill'`. It settles alongside a `documentId` allocation in the SAME call, one payment
   * closing invoice-then-fee.
   */
  const ALLOCATIONS = {
    type: 'array',
    items: {
      type: 'object',
      properties: {
        documentId: STR,
        dunningItemId: STR,
        targetKind: STR,
        targetId: STR,
        amountMinor: INT,
        paymentAmountMinor: INT,
        skontoMinor: INT,
        writeOffMinor: INT,
      },
      required: ['amountMinor'],
    },
  } as const;

  const MONEY_SIDE = {
    direction: STR,
    date: STR,
    amountMinor: INT,
    currency: STR,
    fxRate: STR,
    bankAccountId: STR,
    counterpartyKind: STR,
    counterpartyId: STR,
    reference: STR,
    allocations: ALLOCATIONS,
    onAccountMinor: INT,
    source: STR,
  } as const;

  return [
    ctxAction(
      'preview_payment',
      'read',
      `Preview exactly what a payment would post, without writing anything: the remainder still to allocate, each document's resulting open amount and status, the Skonto VAT split, the Ist-timing paid-portion VAT, the currency conversion with its realised difference, and the journal legs with account numbers and labels. Call this before record_payment so the figures a human sees and the figures the ledger books are the same figures. It takes no intent and can never post.`,
      ctxSchema(MONEY_SIDE, ['direction', 'date', 'amountMinor', 'bankAccountId']),
      (ctx, input) => previewPayment(ctx, input as never),
    ),
    ctxAction(
      'suggest_payment_matches',
      'read',
      `Rank the open items a payment might settle, with the reason in words: reference matches, amount and customer match, or amount close. A QR or Creditor Reference whose check digit fails is reported as a typo and never ranked as a match, and a candidate that fits no tier carries no reason at all. This is the same read model the Studio's candidate list renders.`,
      ctxSchema({ amountMinor: INT, reference: STR, counterpartyId: STR, direction: STR, currency: STR }),
      (ctx, input) => suggestPaymentMatches(ctx, input as never),
    ),
    ctxAction(
      'record_payment',
      'write',
      `Record an incoming or outgoing payment and post its balanced entry (bucht eine Zahlung). Allocates across one or several open items with partial amounts, Skonto, and an Ausbuchung of a small residual; any remainder is parked as a Guthaben for its counterparty. Requires intent='${PAYMENT_INTENTS.record}', because money never moves as a side effect.`,
      ctxSchema({ ...MONEY_SIDE, intent: STR, idempotencyKey: STR }, [
        'direction',
        'date',
        'amountMinor',
        'bankAccountId',
        'intent',
        'idempotencyKey',
      ]),
      (ctx, input) => recordPayment(ctx, input as never),
    ),
    ctxAction(
      'allocate_payment',
      'write',
      `Allocate a parked Guthaben to open items. The money was already booked when the payment arrived, so this posts no entry: it records which open items that money settles. Requires intent='${PAYMENT_INTENTS.allocate}'. A wrong allocation is corrected by reversing the whole payment and recording it again.`,
      ctxSchema({ paymentId: STR, allocations: ALLOCATIONS, intent: STR, idempotencyKey: STR }, [
        'paymentId',
        'allocations',
        'intent',
        'idempotencyKey',
      ]),
      (ctx, input) => allocatePayment(ctx, input as never),
    ),
    ctxAction(
      'reverse_payment',
      'write',
      `Reverse a payment (storniert eine Zahlung): posts a reversing entry and re-opens every document it settled. It never deletes, the original entry stays untouched, and a payment is always reversed as a whole. Requires intent='${PAYMENT_INTENTS.reverse}'.`,
      ctxSchema({ paymentId: STR, date: STR, intent: STR, idempotencyKey: STR }, [
        'paymentId',
        'intent',
        'idempotencyKey',
      ]),
      (ctx, input) => reversePayment(ctx, input as never),
    ),
    ctxAction(
      'get_payment',
      'read',
      'Read one payment: its allocations by document number, its Guthaben, its journal entry, and its reversal when it has one.',
      ctxSchema({ paymentId: STR }, ['paymentId']),
      (ctx, input) => getPayment(ctx, input as never),
    ),
    ctxAction(
      'list_payments',
      'read',
      'List payments, filtered by direction, status, date range, or the document they settled. savedViewId applies a saved view (G00): its stored filters are merged underneath any filter named explicitly here, so an explicit one always wins.',
      ctxSchema({ direction: STR, status: STR, from: STR, to: STR, documentId: STR, savedViewId: STR }),
      (ctx, input) => listPayments(ctx, input as never),
    ),
    ctxAction(
      'set_write_off_threshold',
      'write',
      'Set the residual below which the Studio may offer a one-click Ausbuchung, in Rappen (default CHF 1.00). It governs the offer only: a larger write-off stays recordable when it is stated deliberately. This is a product setting and not a rounding rule.',
      ctxSchema({ thresholdMinor: INT, idempotencyKey: STR }, ['thresholdMinor', 'idempotencyKey']),
      (ctx, input) => setWriteOffThreshold(ctx, input as never),
    ),
  ];
}
