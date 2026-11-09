/**
 * D02's single-source §H-ENUM points (spec §7): `PO_STATUS` and `MATCH_STATUS`, plus the PO
 * transition table that reuses Pattern P7's state-machine discipline on `purchase_order.status`.
 *
 * This is D02's OWN enum, deliberately NOT registered at A10's `document.type`/`document.status`: a
 * PO is its own document, so a status added to A10 could never leak the revise edge onto a quote or
 * an invoice, and vice versa. The vocabulary lives here alone (no DB CHECK constraint), validated at
 * the verb boundary.
 */

/**
 * The PO lifecycle. `draft -> sent -> received -> closed`, plus `-> cancelled` (receipt-free only)
 * and the revise edge `sent -> draft` (US-D02.6). `closed` is the single terminal for "no longer
 * open": a PO reaches it either by being fully billed through a 3-way match (the invoiced/closed
 * transition) or by having its remaining open quantity waived via close-short. Partial receipt is
 * line-level DATA (`received_qty`), never a status; a revision is DATA (`revision` + `po_revision`),
 * never a status fork.
 */
export const PO_STATUSES = ['draft', 'sent', 'received', 'closed', 'cancelled'] as const;
export type PoStatus = (typeof PO_STATUSES)[number];

export function isPoStatus(v: unknown): v is PoStatus {
  return typeof v === 'string' && (PO_STATUSES as readonly string[]).includes(v);
}

/**
 * The allowed transitions, the P7 guard table. A move not listed here is refused with
 * `invalid_transition` (spec §2), which is what keeps the machine singular and every dependent guard
 * (D01's receipt guard, the match verb) honest about the states it may see.
 *
 *  - `draft -> sent`      po_send
 *  - `draft -> cancelled` po_cancel (no receipts yet by definition)
 *  - `sent -> received`   receipt_record, ONLY when every line is fully received
 *  - `sent -> cancelled`  po_cancel, ONLY while nothing has been received (the has_receipts guard)
 *  - `sent -> draft`      po_revise (the revise edge)
 *  - `sent -> closed`     po_close_short (waive the remaining open quantity)
 *  - `received -> closed` match_bill (fully billed) OR po_close_short
 *  - `received -> sent`   goods_receipt_reverse (I02), ONLY when the reversal leaves a line short
 *
 * THE REOPEN EDGE (owner decision, 11.08.2026). `received -> sent` was absent while the only writer
 * of `received` was `receipt_record`, which never walks a quantity back. I02's `goods_receipt_reverse`
 * does: it writes compensating J02 movements, negative trail rows and a `received_qty` rollback, so a
 * fully received PO can legitimately have open quantity again. Without this edge the status said
 * `received` while the lines said otherwise, and every downstream reader of that column (the Einkauf
 * list, `po_open_lines`, the 3-way match's own `sent|received` admission) was reading a stale claim.
 * The edge is NOT a general reopen: it exists for the case where a reversal makes the old status
 * false, and the guards that hang off `sent` are unchanged, so a PO that walks back becomes
 * cancellable (`po_cancel`'s has_receipts guard reads `received_qty > 0`, which the rollback has just
 * set back to 0) and revisable again, which is the honest answer for an order nothing was net
 * received against.
 */
const ALLOWED_TRANSITIONS: ReadonlySet<string> = new Set([
  'draft>sent',
  'draft>cancelled',
  'sent>received',
  'sent>cancelled',
  'sent>draft',
  'sent>closed',
  'received>closed',
  // The I02 reopen edge, see the note above: a reversal that leaves a line short walks the order back.
  'received>sent',
]);

/** Is `from -> to` a legal PO_STATUS transition? The P7 discipline in one predicate. */
export function isPoTransitionAllowed(from: PoStatus, to: PoStatus): boolean {
  return ALLOWED_TRANSITIONS.has(`${from}>${to}`);
}

/** The 3-way-match verdict. `variance` is a persisted, visible exception; `overridden` is a human call. */
export const MATCH_STATUSES = ['matched', 'variance', 'overridden'] as const;
export type MatchStatus = (typeof MATCH_STATUSES)[number];

export function isMatchStatus(v: unknown): v is MatchStatus {
  return typeof v === 'string' && (MATCH_STATUSES as readonly string[]).includes(v);
}

/**
 * The 3-way-match tolerance, spec §6b FIXED (a customizable formula would let a workspace widen its
 * own internal control past what OR 957a's Belegnachweis chain and MWSTG Art. 28's Vorsteuer trace
 * can defend). Two thresholds, EITHER passing suffices (spec §2 boundary): a percentage of the
 * expected value and an absolute Rappen floor for tiny orders where 2% rounds to nothing.
 *
 * 2% is the industry-standard AP price tolerance (a $10.15 invoice against a $10.00 PO passes at
 * 1.5%): see the sources cited in the D02 build. The absolute floor is CHF 1.00, so a variance of a
 * Rappen or two on a small order is not manufactured into an exception. Comparison is round-once
 * integer math (P2): `round(expected * 200 / 10000)` at the single rounding point, then integer <=.
 */
export const MATCH_TOLERANCE_BP = 200; // 2.00%, in basis points
export const MATCH_TOLERANCE_RAPPEN_FLOOR = 100; // CHF 1.00

/** The per-match tolerance in Rappen: round-once(expected * bp / 10000), floored at the absolute minimum. */
export function toleranceRappenFor(expectedBaseRappen: number): number {
  const pct = Math.round((Math.abs(expectedBaseRappen) * MATCH_TOLERANCE_BP) / 10000);
  return Math.max(pct, MATCH_TOLERANCE_RAPPEN_FLOOR);
}
