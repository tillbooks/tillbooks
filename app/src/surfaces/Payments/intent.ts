/**
 * The A14 explicit-intent tokens, and the request builders that are the ONLY way to reach a write.
 *
 * P9 (D38) is the decision this file exists to make structurally true rather than merely true today:
 *
 *   "Suppressing the dialog changes what a person sees and NEVER what the wire requires."
 *
 * The cheap way to honour that is to remember to pass the token at both call sites. That is a
 * convention, and a convention is one refactor away from a dialog-suppressed post going out without
 * an intent. So the token is not a parameter here at all. `recordPaymentRequest` and its siblings
 * take the payment's own data and NOTHING about the dialog, and they attach the intent themselves.
 * There is no argument a caller could pass, and no branch a caller could take, that produces a
 * request body without one. The preference module (`confirm-preference.ts`) cannot reach these
 * builders and is never imported by them: the two concerns are in separate modules on purpose, and
 * `intent-is-not-presentational.test.ts` asserts the payloads are byte-identical either way.
 *
 * The tokens MIRROR `PAYMENT_INTENTS` in `src/core/payments/payment.ts`. The browser cannot import
 * engine code (better-sqlite3 is native and Node-only), so they are re-declared, and
 * `test/payments/studio-payments-fixture.test.mjs` pins these three strings to the engine's own
 * constant. A rename there goes red on the engine side rather than silently rejecting every post
 * here with `intent_required`.
 *
 * Note the asymmetry that a reader will otherwise assume is a typo: the verb is `record_payment` but
 * its token is `post_payment`. That is the engine's spelling, verified against the constant.
 */

/** Mirrors `PAYMENT_INTENTS` in the engine. Pinned by the fixture drift guard. */
export const PAYMENT_INTENT = {
  record: 'post_payment',
  allocate: 'allocate_payment',
  reverse: 'reverse_payment',
} as const;

/** One allocation as the wire takes it. */
export interface AllocationRequest {
  documentId: string;
  targetKind?: string;
  amountMinor: number;
  skontoMinor?: number;
  writeOffMinor?: number;
}

export interface RecordPaymentFields {
  workspaceId: string;
  direction: string;
  date: string;
  amountMinor: number;
  currency?: string;
  bankAccountId: string;
  counterpartyKind?: string | null;
  counterpartyId?: string | null;
  reference?: string | null;
  allocations: AllocationRequest[];
  onAccountMinor?: number;
  /** Minted once per allocator session, so a double submit converges on one payment (§4 rule 6). */
  idempotencyKey: string;
}

/** Drop the keys the engine treats as absent, so an empty field is never sent as `null`. */
function compact(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined && value !== null && value !== '') out[key] = value;
  }
  return out;
}

/**
 * Build the `record_payment` body. The intent is attached here and cannot be supplied, suppressed,
 * or overridden by the caller.
 */
export function recordPaymentRequest(fields: RecordPaymentFields): Record<string, unknown> {
  return {
    ...compact({
      workspaceId: fields.workspaceId,
      direction: fields.direction,
      date: fields.date,
      currency: fields.currency,
      bankAccountId: fields.bankAccountId,
      counterpartyKind: fields.counterpartyKind,
      counterpartyId: fields.counterpartyId,
      reference: fields.reference,
      idempotencyKey: fields.idempotencyKey,
    }),
    // Deliberately outside `compact`: 0 is a legitimate amount to send and must not be dropped.
    amountMinor: fields.amountMinor,
    allocations: fields.allocations,
    ...(fields.onAccountMinor === undefined ? {} : { onAccountMinor: fields.onAccountMinor }),
    intent: PAYMENT_INTENT.record,
  };
}

/** Build the `allocate_payment` body. Same rule: the intent is not the caller's to decide. */
export function allocatePaymentRequest(fields: {
  workspaceId: string;
  paymentId: string;
  allocations: AllocationRequest[];
  idempotencyKey: string;
}): Record<string, unknown> {
  return {
    workspaceId: fields.workspaceId,
    paymentId: fields.paymentId,
    allocations: fields.allocations,
    idempotencyKey: fields.idempotencyKey,
    intent: PAYMENT_INTENT.allocate,
  };
}

/** Build the `reverse_payment` body. A payment is always reversed as a whole (§4 rule 2). */
export function reversePaymentRequest(fields: {
  workspaceId: string;
  paymentId: string;
  date?: string;
  idempotencyKey: string;
}): Record<string, unknown> {
  return {
    ...compact({
      workspaceId: fields.workspaceId,
      paymentId: fields.paymentId,
      date: fields.date,
      idempotencyKey: fields.idempotencyKey,
    }),
    intent: PAYMENT_INTENT.reverse,
  };
}

/**
 * Build the read-only `preview_payment` body.
 *
 * It takes no intent and can never post, which is why the preview is safe to fire on every
 * keystroke. Kept beside the writers deliberately: seeing the absence of an intent next to three
 * builders that attach one is the clearest statement of which calls move money.
 */
export function previewPaymentRequest(
  fields: Omit<RecordPaymentFields, 'idempotencyKey'>,
): Record<string, unknown> {
  return {
    ...compact({
      workspaceId: fields.workspaceId,
      direction: fields.direction,
      date: fields.date,
      currency: fields.currency,
      bankAccountId: fields.bankAccountId,
      counterpartyKind: fields.counterpartyKind,
      counterpartyId: fields.counterpartyId,
      reference: fields.reference,
    }),
    amountMinor: fields.amountMinor,
    allocations: fields.allocations,
    ...(fields.onAccountMinor === undefined ? {} : { onAccountMinor: fields.onAccountMinor }),
  };
}
