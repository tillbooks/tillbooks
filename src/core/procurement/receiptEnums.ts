/**
 * I02's single-source §H-ENUM points: the goods-receipt document status vocabulary, the per-line
 * inspection vocabulary, the append-only event vocabulary, and the line-operation vocabulary. Kept
 * out of the DB (no CHECK constraint) and validated at the verb boundary, exactly as D02 keeps
 * `PO_STATUS` in `poEnums.ts` and J02 keeps `MOVEMENT_TYPES` in `movement.ts`.
 */

/** The document lifecycle. `posted` is the immutable state; `reversed` and `cancelled` are terminal. */
export const GOODS_RECEIPT_STATUSES = ['draft', 'posted', 'reversed', 'cancelled'] as const;
export type GoodsReceiptStatus = (typeof GOODS_RECEIPT_STATUSES)[number];

export function isGoodsReceiptStatus(v: unknown): v is GoodsReceiptStatus {
  return typeof v === 'string' && (GOODS_RECEIPT_STATUSES as readonly string[]).includes(v);
}

/**
 * The per-line inspection state. `none` (no inspection required) and `accepted` are RECOGNISED: they
 * carry stock and PO quantity. `pending` is held: no movement, no quantity, until an explicit accept
 * or reject decides it. `rejected` never carries stock and leaves the ordered quantity open.
 */
export const RECEIPT_INSPECTION_STATUSES = ['none', 'pending', 'accepted', 'rejected'] as const;
export type ReceiptInspectionStatus = (typeof RECEIPT_INSPECTION_STATUSES)[number];

export function isReceiptInspectionStatus(v: unknown): v is ReceiptInspectionStatus {
  return typeof v === 'string' && (RECEIPT_INSPECTION_STATUSES as readonly string[]).includes(v);
}

/**
 * The inspection states a caller may ASK for while the document is a draft. `accepted` and
 * `rejected` are DECISIONS and are reachable only through `goods_receipt_accept_lines` /
 * `goods_receipt_reject_lines`, which write an append-only event with the actor: letting a line
 * arrive pre-accepted would put a quality decision into a data field with no decider attached.
 */
export const RECEIPT_DRAFT_INSPECTION_STATUSES: readonly ReceiptInspectionStatus[] = ['none', 'pending'];

/** The states in which a line's quantity counts as received (a movement and a PO increment exist). */
export const RECOGNISED_INSPECTION_STATUSES: readonly ReceiptInspectionStatus[] = ['none', 'accepted'];

/** The line operations `goods_receipt_upsert_lines` accepts (§H-ENUM), validated at the boundary. */
export const RECEIPT_LINE_OPS = ['add', 'change', 'remove'] as const;
export type ReceiptLineOp = (typeof RECEIPT_LINE_OPS)[number];

export function isReceiptLineOp(v: unknown): v is ReceiptLineOp {
  return typeof v === 'string' && (RECEIPT_LINE_OPS as readonly string[]).includes(v);
}

/** The append-only `goods_receipt_doc_event.event_type` vocabulary (§H-AUDIT). */
export const RECEIPT_EVENT_TYPES = [
  'created',
  'line_changed',
  'posted',
  'accepted',
  'rejected',
  'reversed',
  'cancelled',
  // The over-delivery exception (owner decision, 11.08.2026). An over-receipt is accepted and
  // RECORDED, so the moment it was accepted, by whom and by how much is an append-only row rather
  // than a boolean somebody has to notice.
  'over_receipt',
] as const;
export type ReceiptEventType = (typeof RECEIPT_EVENT_TYPES)[number];

/**
 * The `stock_movement.ref_kind` (J02 `sourceDocumentType`) every I02 movement carries, so
 * `inventory_movement_list({ sourceDocumentType })` filters the physical receipts of the warehouse
 * and I03 / I06 can find them without joining. Single-sourced here because the engine, the tests and
 * the Studio all name it.
 */
export const RECEIPT_SOURCE_DOCUMENT_TYPE = 'goods_receipt';
