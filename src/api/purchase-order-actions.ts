/**
 * D02's twelve verbs (eight writes, four reads), defined here and spread into `ACTIONS` as one line
 * (the `salesOrderActions` / `stockActions` precedent), so several agents appending to the append-only
 * registry at once collide over a line rather than a block.
 *
 * NEW FILE, DISJOINT from A17's `purchase-actions.ts` (which owns the seven vendor-bill verbs): D02
 * adds to the purchasing area but does not touch A17's action file or its engine. Every verb is a thin
 * adapter over `core/purchase`'s D02 engine, which opens NO posting path (P3, all financial effect is
 * A17->A02 on the bill) and mints stock only through D01 `stock.move` (OP2). REST twins ride the shared
 * registry automatically, as for every other verb.
 *
 * NO verb here holds an `ActionInvoker`: the engine reaches A17 (read-only), D01 and A05 DIRECTLY,
 * never back through the dispatch, so there is no capability to launder. The helpers arrive as a
 * parameter, not an import, so the module graph stays acyclic: `registry.ts` imports this file and this
 * file must not import it back.
 */

import type { ActionDef, ActionInput, ApiDeps, JsonSchema } from './registry.js';
import type { WorkspaceContext } from '../core/context.js';
import type { Result } from '../core/result.js';
import { poUpsert, poSend, poCloseShort, poCancel, poRevise, poList, poGet, poOpenLines } from '../core/purchase/purchaseOrders.js';
import { receiptRecord } from '../core/purchase/receipts.js';
import { matchBill } from '../core/purchase/threeWayMatch.js';
import { supplierPriceUpsert, supplierPriceList } from '../core/purchase/supplierPrices.js';

export interface PurchaseOrderActionHelpers {
  ctxAction(
    name: string,
    kind: 'read' | 'write',
    summary: string,
    inputSchema: JsonSchema,
    call: (ctx: WorkspaceContext, input: ActionInput, deps: ApiDeps) => Result,
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

/** The purchase-order, receipt, match and supplier-price verbs, in append order. */
export function purchaseOrderActions(h: PurchaseOrderActionHelpers): readonly ActionDef[] {
  const { ctxAction, ctxSchema, STR, INT, BOOL } = h;

  // A PO line: an item line prices once through the supplier resolver (D02.7) unless an explicit
  // unitPriceRappen is given, and its tax code resolves once through A05 (both snapshotted). A
  // free-text line needs unitPriceRappen. qty is a positive integer in the item's own unit.
  const PO_LINES = {
    type: 'array',
    items: {
      type: 'object',
      properties: { itemId: STR, description: STR, qty: INT, unitPriceRappen: INT, taxCode: STR, projectId: STR },
    },
  } as const;

  // A receipt line: which po_line arrived, and how much (a whole positive integer, never over the open qty).
  const RECEIPT_LINES = {
    type: 'array',
    items: { type: 'object', properties: { poLineId: STR, qty: INT }, required: ['poLineId', 'qty'] },
  } as const;

  return [
    ctxAction(
      'po_upsert',
      'write',
      'Lege eine Bestellung an oder bearbeite sie: a purchase order (its OWN D02 document, reusing Pattern P7 on purchase_order.status, NOT an A10 document kind) on a C00 supplier contact with D00 item lines. Each item line is priced once via resolveSupplierPrice (latest supplier valid_from, else the item cost price) unless an explicit unitPriceRappen is given, and its expected tax code resolved once through A05 (H-VAT-TRACE), then snapshotted on the po_line. POSTS NOTHING and touches no stock: the financial effect stays on the A17 vendor bill (P3). A EUR order snapshots the CHF/txn fx_rate (H-FX). Passing poId edits an existing DRAFT (a sent PO is refused with invalid_transition; changes go through po_revise). A line may carry projectId, a B00 project tag for the B03 Projekterfolg (reporting only: it prices nothing; B03 reads it for accrued/committed purchase cost). A supplier that is not a C00 contact, or a line with an unknown itemId or projectId, is refused (invalid_reference); qty <= 0 is invalid_qty.',
      ctxSchema({ poId: STR, supplierContactId: STR, currency: STR, lines: PO_LINES, note: STR, actor: STR, idempotencyKey: STR }, []),
      (ctx, input) => poUpsert(ctx, as(input)),
    ),
    ctxAction(
      'po_send',
      'write',
      'Sende die Bestellung an den Lieferanten (draft -> sent, P8 draft-gated): renders the outbound PO PDF ARTIFACT and STOPS. It returns { artifactRef, transmitted:false } and NEVER emails the supplier on its own: transmission needs the approval dial (Pattern P8/OP4). A zero-line PO cannot leave draft (no_lines); a non-draft PO is refused (invalid_transition).',
      ctxSchema({ poId: STR, actor: STR, idempotencyKey: STR }, ['poId']),
      (ctx, input) => poSend(ctx, as(input)),
    ),
    ctxAction(
      'po_list',
      'read',
      'Liste die Bestellungen (P5): filter by status or supplier. Each row carries the number, status, currency, totals and expected date. savedViewId support rides G00`s saved-view seam on the po customization surface.',
      ctxSchema({ status: STR, supplierContactId: STR, savedViewId: STR }, []),
      (ctx, input) => poList(ctx, as(input)),
    ),
    ctxAction(
      'po_get',
      'read',
      'Lies eine Bestellung mit Positionen (bestellt / erhalten / verrechnet / offene Menge), ihren Wareneingängen und den 3-Way-Match-Sätzen. The one read that shows the whole PO -> receipt -> match chain for a single order.',
      ctxSchema({ poId: STR, savedViewId: STR }, ['poId']),
      (ctx, input) => poGet(ctx, as(input)),
    ),
    ctxAction(
      'receipt_record',
      'write',
      'AGENT-FIRST. Erfasse einen Wareneingang (voll oder teilweise) gegen eine gesendete Bestellung: writes a goods_receipt + lines and, for every stock-tracked line, mints ONE D01 receipt movement through stock.move (OP2, D02 never writes stock_movement itself), storing each stock_movement_id for 1:1 traceability. Each po_line.received_qty rises; when every line is fully received the PO advances sent -> received. The unit cost handed to D01 is the line`s CHF BASE cost (H-FX). Atomic and idempotent: over-receipt (qty over the open order qty) is PRE-CHECKED and refused with over_receipt (a refusal writes zero rows and moves zero stock), a D01 refusal rolls the whole receipt back, and a retry under the same idempotencyKey mints NOTHING a second time. Receiving against a draft/received/closed/cancelled PO is refused (invalid_transition). The intended agent loop is D01 low-stock -> supplier_price_list -> pre-filled po_upsert -> receipt.',
      ctxSchema({ poId: STR, locationId: STR, lines: RECEIPT_LINES, note: STR, actor: STR, idempotencyKey: STR }, ['poId', 'locationId']),
      (ctx, input) => receiptRecord(ctx, as(input)),
    ),
    ctxAction(
      'match_bill',
      'write',
      'Gleiche eine A17-Kreditorenrechnung 3-fach gegen die Bestellung und ihre Wareneingänge ab: compares, in CHF base Rappen, the value of goods RECEIVED-but-not-yet-billed at the PO`s own line prices against the bill`s base net, within a FIXED tolerance (2% or a CHF 1.00 floor, either passing). Within tolerance writes a matched po_match row, links the A17 bill_id, raises billed_qty (never above received_qty: no over-match) and, when the PO is fully billed, advances received -> closed. POSTS NOTHING: the bill`s expense/inventory + Vorsteuer posting is A17->A02 (P3), match_bill stores only the link. OVER tolerance BLOCKS auto-match: it PERSISTS a po_match row with status variance (the exception stays visible) and returns variance_exceeded. A user holding the `post` capability may pass override:true to force an overridden match (records overridden_by). Refusals: zero receipts -> nothing_received; a bill from a different supplier -> invalid_reference; the same bill matched twice -> already_matched. match_bill is EXCLUDED from automation (a variance override is a human judgment).',
      ctxSchema({ poId: STR, billId: STR, override: BOOL, actor: STR, idempotencyKey: STR }, ['poId', 'billId']),
      (ctx, input) => matchBill(ctx, as(input)),
    ),
    ctxAction(
      'po_open_lines',
      'read',
      'Liste die offenen Mengen / Lieferrückstände (P5): every PO line with received_qty < qty on a SENT PO, with open_qty = qty - received_qty. An agent polls this to chase a supplier after a partial delivery. An empty list is not an error.',
      ctxSchema({ supplierContactId: STR, savedViewId: STR }, []),
      (ctx, input) => poOpenLines(ctx, as(input)),
    ),
    ctxAction(
      'po_close_short',
      'write',
      'Schliesse die Restmenge einer Bestellung (sent -> closed): waives the remaining open quantity of a partially received PO. The backorder is explicitly waived, never silently dropped; the PO keeps all its rows (H-AUDIT). A non-sent PO is refused (invalid_transition).',
      ctxSchema({ poId: STR, actor: STR, idempotencyKey: STR }, ['poId']),
      (ctx, input) => poCloseShort(ctx, as(input)),
    ),
    ctxAction(
      'po_cancel',
      'write',
      'Storniere eine Bestellung (draft|sent -> cancelled): ONLY while nothing has been received. A cancelled PO keeps its rows (H-AUDIT, documents are trail, not trash). Cancelling a PO with any receipt is refused with has_receipts (use po_close_short instead); a non-draft/sent PO is refused (invalid_transition).',
      ctxSchema({ poId: STR, actor: STR, idempotencyKey: STR }, ['poId']),
      (ctx, input) => poCancel(ctx, as(input)),
    ),
    ctxAction(
      'po_revise',
      'write',
      'Revidiere eine gesendete Bestellung (sent -> draft, die Revise-Kante): snapshots the current header + lines into po_revision (append-only, H-AUDIT), increments revision, and re-opens the PO as a draft for editing via po_upsert. received_qty and billed_qty survive untouched (they belong to receipts/matches). The re-send rides the P8-gated po_send, so a revision can never leak to the supplier without the dial. Only a SENT PO is revisable (draft/received/closed/cancelled -> invalid_transition). Idempotent: a replay yields one snapshot + one increment.',
      ctxSchema({ poId: STR, reason: STR, actor: STR, idempotencyKey: STR }, ['poId']),
      (ctx, input) => poRevise(ctx, as(input)),
    ),
    ctxAction(
      'supplier_price_upsert',
      'write',
      'Erfasse einen Lieferantenpreis (append-only Historie nach valid_from): persists a supplier_item_price row (supplierContactId -> C00, itemId -> D00, supplierSku?, priceRappen, currency, validFrom, leadTimeDays?), mirroring D00`s price-list discipline. po_upsert pre-fills each line`s price (and derives expected_on from the longest lead time) from resolveSupplierPrice. A supplier that is not a C00 contact or an unknown itemId is refused (invalid_reference); priceRappen < 0 is refused.',
      ctxSchema({ supplierContactId: STR, itemId: STR, supplierSku: STR, priceRappen: INT, currency: STR, validFrom: STR, leadTimeDays: INT, actor: STR, idempotencyKey: STR }, ['supplierContactId', 'itemId', 'priceRappen', 'validFrom']),
      (ctx, input) => supplierPriceUpsert(ctx, as(input)),
    ),
    ctxAction(
      'supplier_price_list',
      'read',
      'Liste die Lieferantenpreise (P5): the append-only price history for a supplier/item filter. When BOTH a supplier and an item are named, the ONE effective resolved price at `at` (including the item-cost fallback with source:item_cost) rides the read, so an agent can price a reorder in one call.',
      ctxSchema({ supplierContactId: STR, itemId: STR, at: STR }, []),
      (ctx, input) => supplierPriceList(ctx, as(input)),
    ),
  ];
}
