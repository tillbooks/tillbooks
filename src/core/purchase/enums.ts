/**
 * A17 §H-ENUM: the single source for the vendor bill's closed enumerations.
 *
 * THE SPLIT IS THE WHOLE POINT. The spec described one five-word status
 * (`draft|posted|partly_paid|paid|void`) written partly by A17 and partly by A14. Two capabilities
 * writing one column is how a stored status drifts from the ledger it claims to describe, and A16 §4
 * already says so about the receivable side. So the five words are two enumerations:
 *
 *  - `VENDOR_BILL_STATUSES` is the LIFECYCLE, stored, and written only by A17's own verbs.
 *  - `VENDOR_BILL_SETTLEMENT_STATUSES` is DERIVED per read from A14's allocations and stored nowhere.
 *
 * `displayStatus` folds the two back into the one word a screen shows, in the ENGINE, so the Studio
 * and an agent read the same word and neither derives it. That is the same reasoning A16's `direction`
 * field carries: a fact the engine holds should not be re-inferred by a consumer from a number.
 */

/** `vendor_bill.status`: the lifecycle A17 owns and is the sole writer of. Append-only. */
export const VENDOR_BILL_STATUSES = ['draft', 'posted', 'void'] as const;
export type VendorBillStatus = (typeof VENDOR_BILL_STATUSES)[number];

/** The settlement half, DERIVED from `payment_allocation` on every read. No column holds it. */
export const VENDOR_BILL_SETTLEMENT_STATUSES = ['unpaid', 'partly_paid', 'paid'] as const;
export type VendorBillSettlementStatus = (typeof VENDOR_BILL_SETTLEMENT_STATUSES)[number];

/** The word a surface shows: the lifecycle, refined by the settlement once the bill is posted. */
export const VENDOR_BILL_DISPLAY_STATUSES = ['draft', 'posted', 'partly_paid', 'paid', 'void'] as const;
export type VendorBillDisplayStatus = (typeof VENDOR_BILL_DISPLAY_STATUSES)[number];

/**
 * The tax KINDS a purchase may carry (A05's `tax_code.kind` values, filtered to the input side).
 *
 * `output`, `zero` (Art. 23 echt befreit) and `exempt` (Art. 21 ausgenommen) are all statements about
 * TURNOVER, and A06's input branch would book them as a non-deductible gross expense while stamping a
 * trace that reports on Ziffer 302/220/230. That is a purchase appearing on the ESTV form as sales, so
 * the code is refused (`needs_input_tax_code`) rather than booked. A vendor who charges no VAT (not
 * registered, or a private seller) is `none`, which is the absence of a code and not one of these.
 */
export const VENDOR_BILL_TAX_KINDS = ['none', 'input', 'import', 'reverse_charge'] as const;

export function isVendorBillTaxKind(kind: string): boolean {
  return (VENDOR_BILL_TAX_KINDS as readonly string[]).includes(kind);
}

/**
 * Fold the lifecycle and the derived settlement into one word.
 *
 * A `draft` or `void` bill has no settlement to report, and saying "unpaid" about a voided bill would
 * be true and useless. Only a POSTED bill's word moves with the money.
 */
export function displayStatus(
  status: VendorBillStatus,
  settlement: VendorBillSettlementStatus,
): VendorBillDisplayStatus {
  if (status !== 'posted') return status;
  if (settlement === 'paid') return 'paid';
  if (settlement === 'partly_paid') return 'partly_paid';
  return 'posted';
}

/** The settlement word for an open amount against a payable. Pure, so both reads share one rule. */
export function settlementStatusFor(payableMinor: number, settledMinor: number): VendorBillSettlementStatus {
  if (settledMinor <= 0) return 'unpaid';
  if (settledMinor >= payableMinor) return 'paid';
  return 'partly_paid';
}
