/**
 * I01's single-source §H-ENUM points: the `po_version.status` and `po_amendment.status` vocabularies,
 * plus the amendment transition table. Kept out of the DB (no CHECK constraint) and validated at the
 * verb boundary, exactly as D02 keeps `PO_STATUS` in `poEnums.ts`.
 */

/** A version is the live commitment (`active`) or a frozen prior image (`superseded`). */
export const PO_VERSION_STATUSES = ['active', 'superseded'] as const;
export type PoVersionStatus = (typeof PO_VERSION_STATUSES)[number];

/**
 * The amendment lifecycle. `draft -> applied` directly when no approval is required, or
 * `draft -> pending_approval -> applied` when a workspace gates it; `rejected` / `cancelled` are the
 * terminal abandons. `applied`, `rejected` and `cancelled` are terminal.
 */
export const PO_AMENDMENT_STATUSES = ['draft', 'pending_approval', 'applied', 'rejected', 'cancelled'] as const;
export type PoAmendmentStatus = (typeof PO_AMENDMENT_STATUSES)[number];

export function isPoAmendmentStatus(v: unknown): v is PoAmendmentStatus {
  return typeof v === 'string' && (PO_AMENDMENT_STATUSES as readonly string[]).includes(v);
}

/** The non-terminal amendment states: only these block a second amendment on the same PO. */
export const PO_AMENDMENT_OPEN_STATUSES: readonly PoAmendmentStatus[] = ['draft', 'pending_approval'];

/** The amendment change operations (§H-ENUM), validated at the verb boundary. */
export const PO_AMENDMENT_OPS = ['change', 'add', 'remove'] as const;
export type PoAmendmentOp = (typeof PO_AMENDMENT_OPS)[number];

export function isPoAmendmentOp(v: unknown): v is PoAmendmentOp {
  return typeof v === 'string' && (PO_AMENDMENT_OPS as readonly string[]).includes(v);
}
