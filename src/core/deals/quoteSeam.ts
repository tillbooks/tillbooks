/**
 * The C02 hand-off seam: how a deal becomes a quote WITHOUT C01 growing document logic.
 *
 * C02 (quotes & proposals) is not built. The document machine it will extend IS (A10), and its
 * quote type is a live, registered verb. So the seam is the SHARED DISPATCH itself: `dealToQuote`
 * holds an `ActionInvoker` (the G01/A12 handshake) and invokes the ONE verb named here, as the
 * CALLING actor, so the quote verb's own A24 gate (`issue` on A10 today, C02's gate when it lands)
 * is re-checked live and C01 can never launder a capability (spec §2 US-C01.5).
 *
 * WHEN C02 LANDS it rebinds `QUOTE_CREATE_TOOL` (and, if its input differs, `buildQuoteInput`) and
 * touches nothing else: the deal side stores whatever id the seam answers with. That is the G09
 * `seams.ts` idea one size smaller: a narrow, named constant with a safe default, so C01's gate is
 * green standalone and the later wave binds the richer module against the same signature.
 *
 * DEGRADATION IS EXPLICIT, NEVER SILENT. An embedder driving the engine without the api layer has
 * no dispatch, so `dealToQuote` receives no invoker and answers `needs_quotes_module` (P9), the
 * `automation_unavailable` shape: the truth about missing host wiring, not a claim about the deal.
 */

/** The registered write verb the hand-off invokes. C02 has landed and rebound it (2026-08-04):
 *  the seam now invokes the real `quotes_create` instead of the generic `create_document` stand-in,
 *  so `deals_to_quote` produces a genuine C02 quote (priced/tax-snapshotted, its own lifecycle) and
 *  no longer answers `needs_quotes_module`. Its gate is `issue`, re-checked live through the invoker. */
export const QUOTE_CREATE_TOOL = 'quotes_create';

/** The facts of a deal the seam turns into the quote verb's input. */
export interface QuoteSeed {
  readonly workspaceId: string;
  readonly contactId: string;
  readonly title: string;
  readonly valueMinor: number;
  readonly currency: string;
  readonly idempotencyKey: string;
}

/**
 * The quote verb's input for one deal: the deal's contact and its value as the single seed line
 * (quantity defaults to one unit). A10 owns everything after this moment (P7): numbering, status,
 * VAT, conversion. C01 contributes facts, never document behaviour.
 */
export function buildQuoteInput(seed: QuoteSeed): Record<string, unknown> {
  // C02's `quotes_create` input shape: no `type` field (the verb IS quote-typed), the deal's value as
  // the single seed line. A10 owns everything after this moment (P7): numbering, status, VAT trace,
  // conversion. C01 contributes facts, never document behaviour.
  return {
    workspaceId: seed.workspaceId,
    contactId: seed.contactId,
    lines: [{ description: seed.title, unitPriceMinor: seed.valueMinor }],
    currency: seed.currency,
    idempotencyKey: seed.idempotencyKey,
  };
}

/** Where the created quote's id sits in the seam verb's success payload. */
export function quoteIdOf(result: Record<string, unknown>): string | undefined {
  const document = result['document'];
  if (document !== null && typeof document === 'object') {
    const id = (document as Record<string, unknown>)['id'];
    if (typeof id === 'string') return id;
  }
  return undefined;
}
