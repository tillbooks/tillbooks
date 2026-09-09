/**
 * I02's thirteen goods-receipt verbs (eight writes + five reads), defined here and spread into
 * `ACTIONS` as ONE line (the `requisitionActions` / `poAmendmentActions` / `movementActions`
 * precedent), so several agents appending to the append-only registry at once collide over a line
 * rather than a block.
 *
 * As with `requisition-actions.ts`, the registry helpers arrive as a parameter rather than an import,
 * so the module graph stays acyclic: `registry.ts` imports this file and this file must not import it
 * back. Every field is camelCase and maps straight through to the engine verb. The eight writes carry
 * `idempotencyKey` (§H-IDEMPOTENT); the five reads advertise `readOnlyHint`.
 */

import type { ActionDef, ActionInput, JsonSchema } from './registry.js';
import type { WorkspaceContext } from '../core/context.js';
import type { Result } from '../core/result.js';
import {
  goodsReceiptCreate,
  goodsReceiptUpsertLines,
  goodsReceiptPreview,
  goodsReceiptPost,
  goodsReceiptAcceptLines,
  goodsReceiptRejectLines,
  goodsReceiptReverse,
  goodsReceiptCancel,
  goodsReceiptGet,
  goodsReceiptList,
  goodsReceiptLinesForMatch,
  goodsReceiptGetConfig,
  goodsReceiptSetConfig,
} from '../core/procurement/index.js';

export interface ReceiptActionHelpers {
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

/** Widen an `ActionInput` to the engine's own input shape (the same cast `registry.ts` uses). */
function as<T>(input: ActionInput): T {
  return input as unknown as T;
}

const ARR = { type: 'array' } as const;

/** The I02 verbs, in append order (the eight writes, then the five reads). */
export function receiptActions(h: ReceiptActionHelpers): readonly ActionDef[] {
  const { ctxAction, ctxSchema, STR, INT, BOOL } = h;
  const STR_ARRAY = { type: 'array', items: STR } as const;
  // A status filter takes ONE value or a list of them, and the engine has always handled both. A bare
  // `STR` here made the summary a lie: `status:['posted','draft']` was rejected `invalid_input` at the
  // boundary, on MCP and REST alike, before the engine ever saw it. `anyOf` declares the real union
  // while leaving `registry.ts`'s boundary type check with nothing to reject (it reads `.type`, which
  // is absent on an `anyOf` node), so the engine stays the single validator. The
  // `customization-actions.ts` ANY_VALUE precedent.
  const STR_OR_LIST = { anyOf: [{ type: 'string' }, { type: 'array', items: STR }] } as const;

  return [
    ctxAction(
      'goods_receipt_create',
      'write',
      'AGENT-FIRST. Open a DRAFT Wareneingang against an open purchase order, the first-class document that records what physically arrived. receivedAt (ISO date) is THE date: every stock movement this receipt ever writes is stamped with it and the period lock is checked against it here and again at post, so there is no way to back-charge a sealed year by moving a posting date. defaultLocationId is optional (a single-location workspace resolves the default warehouse location automatically). Nothing physical happens yet: no stock movement, no purchase-order quantity change. Refused when the order is not sent or received (invalid_transition), when no line has open quantity (nothing_open), or when receivedAt falls in a locked period (period_locked). Idempotent under idempotencyKey.',
      ctxSchema(
        {
          poId: STR,
          receivedAt: STR,
          expectedAt: STR,
          defaultLocationId: STR,
          note: STR,
          idempotencyKey: STR,
        },
        ['poId', 'receivedAt', 'idempotencyKey'],
      ),
      (ctx, input) => goodsReceiptCreate(ctx, as(input)),
    ),
    ctxAction(
      'goods_receipt_upsert_lines',
      'write',
      'Add, change or remove lines on a DRAFT goods receipt. Each op is { op: add | change | remove, poLineId (add), lineId (change/remove), qty (> 0, whole units), locationId?, lotId?, serialId?, unitCostRappen? (defaults to the order line CHF base price), inspectionStatus? (none | pending), note? }. A line marked pending is HELD at post: no stock movement and no order quantity until goods_receipt_accept_lines releases it. accepted and rejected are decisions with an actor attached and are reachable only through the accept / reject verbs, never as a data field. Editing a posted receipt is refused (invalid_transition): the correction for a posted mistake is goods_receipt_reverse, never an edit.',
      ctxSchema({ grId: STR, ops: ARR, idempotencyKey: STR }, ['grId', 'ops', 'idempotencyKey']),
      (ctx, input) => goodsReceiptUpsertLines(ctx, as(input)),
    ),
    ctxAction(
      'goods_receipt_post',
      'write',
      'Post the goods receipt: in ONE transaction re-validate every line against the LIVE purchase order, write the J02 stock movements (movementType receipt, the order line CHF base cost as the snapshot, sourceDocumentType goods_receipt), append the shared received-quantity trail, raise po_line.received_qty, and freeze the document. There is deliberately NO date parameter: the movements carry the receipt own receivedAt and the period lock is asserted against that same date. An over-delivery is ACCEPTED at its full quantity by default and RECORDED as an exception (the excess lands on the line as overReceiptQty, the header carries hasOverReceipt, and an append-only over_receipt event names who took how many extra units); it is never silently clamped. A workspace that wants a hard ceiling gets one: with allowOverReceipt false anything above the open quantity is refused with qty_exceeds_open, and with an overReceiptPct set anything above the tolerance is refused with over_receipt, and above the ceiling the WHOLE receipt rolls back. A line whose item is not stock-tracked advances the ordered quantity and mints no movement. Any guard trip rolls the WHOLE receipt back: no movement, no trail row, no quantity change. A replay under the same idempotencyKey returns the posted document and writes nothing; a second post under a different key is invalid_transition.',
      ctxSchema({ grId: STR, idempotencyKey: STR }, ['grId', 'idempotencyKey']),
      (ctx, input) => goodsReceiptPost(ctx, as(input)),
    ),
    ctxAction(
      'goods_receipt_accept_lines',
      'write',
      'Release HELD lines (inspectionStatus pending) into stock after a quality check: exactly what the post would have done for them, at the receipt own receivedAt and under the same live open-quantity and period-lock guards. Writes the J02 movement, the trail row and the po_line.received_qty increment per accepted line, and records an append-only acceptance event with the actor. A line that is not pending is invalid_transition.',
      ctxSchema({ grId: STR, lineIds: STR_ARRAY, reason: STR, idempotencyKey: STR }, ['grId', 'lineIds', 'idempotencyKey']),
      (ctx, input) => goodsReceiptAcceptLines(ctx, as(input)),
    ),
    ctxAction(
      'goods_receipt_reject_lines',
      'write',
      'Refuse HELD lines after a quality check. No stock movement and no order quantity: a rejected quantity never entered the warehouse, so the ordered quantity simply stays open and can be received again on a later delivery. reason is required and is recorded with the actor on an append-only rejection event. A line that is not pending is invalid_transition.',
      ctxSchema({ grId: STR, lineIds: STR_ARRAY, reason: STR, idempotencyKey: STR }, [
        'grId',
        'lineIds',
        'reason',
        'idempotencyKey',
      ]),
      (ctx, input) => goodsReceiptRejectLines(ctx, as(input)),
    ),
    ctxAction(
      'goods_receipt_reverse',
      'write',
      'Storniere einen gebuchten Wareneingang: the ONE correction for a posted receipt. Nothing about the original document, its movements or its trail rows is edited or deleted. What is written is the compensation: a J02 return movement of equal magnitude and opposite sign per recognised line (same date, same source-document link, so the pair is findable together), a negative trail row so the received-quantity trail still sums to po_line.received_qty, the received_qty rollback, and the original marked reversed with who and when. Refused with line_already_billed when a three-way match has already billed a line, with period_locked when the receipt own period is sealed, and with insufficient_stock when the goods have since left the warehouse (in which case the honest correction is an inventory adjustment, not an un-receipt). reason is required. Idempotent under idempotencyKey.',
      ctxSchema({ grId: STR, reason: STR, idempotencyKey: STR }, ['grId', 'reason', 'idempotencyKey']),
      (ctx, input) => goodsReceiptReverse(ctx, as(input)),
    ),
    ctxAction(
      'goods_receipt_cancel',
      'write',
      'Abandon a DRAFT goods receipt (nothing physical has happened yet, so nothing has to be unwound). A posted receipt cannot be cancelled: use goods_receipt_reverse, which leaves the audit trail intact. Cancelling anything other than a draft is invalid_transition.',
      ctxSchema({ grId: STR, reason: STR, idempotencyKey: STR }, ['grId', 'idempotencyKey']),
      (ctx, input) => goodsReceiptCancel(ctx, as(input)),
    ),
    ctxAction(
      'goods_receipt_set_config',
      'write',
      'Set the workspace over-receipt posture. The DEFAULT (allowOverReceipt true, no overReceiptPct) accepts an over-delivery at its full quantity and flags it on the receipt, because blocking it at the loading dock does not un-deliver the goods, it only stops the ledger from saying they arrived. allowOverReceipt false is the hard ceiling: anything above the open order quantity is refused with qty_exceeds_open. OMIT overReceiptPct for no cap; set it (1..100, an integer percentage of the ORDERED quantity, rounded DOWN so a tolerance is never wider than granted) to refuse above that tolerance with over_receipt instead of flagging. Plain policy: posts no journal entry, moves no stock and never rewrites history, so changing it affects only what a future post will accept.',
      ctxSchema({ allowOverReceipt: BOOL, overReceiptPct: INT, idempotencyKey: STR }, [
        'allowOverReceipt',
        'idempotencyKey',
      ]),
      (ctx, input) => goodsReceiptSetConfig(ctx, as(input)),
    ),
    ctxAction(
      'goods_receipt_preview',
      'read',
      'PURE impact preview of a draft goods receipt: per line the ordered, already-received, open and ceiling quantities (ceiling null means over-delivery is uncapped), the proposed and resulting received quantity, the unit-cost snapshot, whether the line moves stock, the over-delivered quantity it would record (overReceipt / overReceiptQty), and the exact rejection codes a post would refuse with: per line the quantity, reference, location and J01 lot/serial refusals (qty_exceeds_open, over_receipt, invalid_qty for a serial line of more than one unit, invalid_reference, location_required, lot_required, serial_required, lot_item_mismatch, serial_item_mismatch), and on the top-level document issues array the period_locked one, which is not a property of any single line. An over-delivery WITHIN the policy is reported but is NOT an issue, because it posts. Plus the total value in Rappen and a postable flag that is false when either array is non-empty. Writes nothing and is safe to call repeatedly.',
      ctxSchema({ grId: STR }, ['grId']),
      (ctx, input) => goodsReceiptPreview(ctx, as(input)),
    ),
    ctxAction(
      'goods_receipt_get',
      'read',
      'One goods receipt with its header (including hasOverReceipt), its lines (quantity, unit-cost snapshot, location, lot/serial, inspection status, the over-delivered quantity, the stock movement each recognised line minted, and the reversal movement when it has been reversed) and its append-only decision trail. A foreign or unknown id is not_found, never cross-tenant data.',
      ctxSchema({ grId: STR }, ['grId']),
      (ctx, input) => goodsReceiptGet(ctx, as(input)),
    ),
    ctxAction(
      'goods_receipt_list',
      'read',
      'List goods receipts with filters: status (one value or an array of draft | posted | reversed | cancelled), poId, supplierContactId, a receivedAt date range (fromDate / toDate), hasOverReceipt (the exception cut: only the deliveries that came in over what was ordered) and a free-text search q over the number and the note. Each row carries the order number, the supplier name, the line count, the receipt value in Rappen and the over-delivered quantity. Accepts a savedViewId (G00 saved-view seam). Newest received date first.',
      ctxSchema({
        status: STR_OR_LIST,
        poId: STR,
        supplierContactId: STR,
        fromDate: STR,
        toDate: STR,
        q: STR,
        hasOverReceipt: BOOL,
        savedViewId: STR,
      }),
      (ctx, input) => goodsReceiptList(ctx, as(input)),
    ),
    ctxAction(
      'goods_receipt_lines_for_match',
      'read',
      'The receipt lines a three-way match may still bill for the given purchase-order lines: only recognised lines on a posted, non-reversed receipt whose billed quantity is below the received quantity. Each row carries the stable receipt-line id (the target I03 allocates landed cost to and I04 marks billed), the receipt number and date, the unit-cost snapshot and the open (unbilled) quantity.',
      ctxSchema({ poLineIds: STR_ARRAY }, ['poLineIds']),
      (ctx, input) => goodsReceiptLinesForMatch(ctx, as(input)),
    ),
    ctxAction(
      'goods_receipt_get_config',
      'read',
      'Read the workspace over-receipt posture: allowOverReceipt (default true, meaning an over-delivery is accepted and flagged rather than refused) and overReceiptPct (null means no cap; a number is an integer percentage of the ordered quantity above which a receipt is refused instead of flagged).',
      ctxSchema(),
      (ctx) => goodsReceiptGetConfig(ctx),
    ),
  ];
}
