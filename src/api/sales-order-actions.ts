/**
 * D03's eleven verbs, defined here and spread into `ACTIONS` as one line (the `quoteActions` /
 * `stockActions` precedent), so several agents appending to the append-only registry at once collide
 * over a line rather than a block.
 *
 * Eight writes are the fulfilment lifecycle (order create / from_quote / confirm / cancel / invoice;
 * delivery note create / issue / render); three reads are the list, the detail, and the backorder
 * queue. Every verb is a thin adapter over `core/sales`'s D03 engine, which opens NO posting path
 * (invoicing delegates to A10 `createDocument`, P3) and mints stock only through D01 `stock.move`
 * (OP2). REST twins ride the shared registry automatically, as for every other verb.
 *
 * NO verb here holds an `ActionInvoker`: the engine reaches A10, D01 and E00 DIRECTLY, never back
 * through the dispatch, so there is no capability to launder. As with `quote-actions.ts`, the helpers
 * arrive as a parameter rather than an import, so the module graph stays acyclic: `registry.ts`
 * imports this file and this file must not import it back.
 */

import type { ActionDef, ActionInput, ApiDeps, JsonSchema } from './registry.js';
import type { WorkspaceContext } from '../core/context.js';
import type { Result } from '../core/result.js';
import {
  createSalesOrder,
  salesOrderFromQuote,
  confirmSalesOrder,
  cancelSalesOrder,
  salesOrderInvoice,
  listSalesOrders,
  getSalesOrder,
  listBackorders,
  createDeliveryNote,
  issueDeliveryNote,
  renderDeliveryNote,
} from '../core/sales/index.js';

export interface SalesOrderActionHelpers {
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

/** The sales-order and delivery-note verbs, in append order. */
export function salesOrderActions(h: SalesOrderActionHelpers): readonly ActionDef[] {
  const { ctxAction, ctxSchema, STR, INT } = h;

  // An order line: an item line is priced once through D00 and tax-resolved once through the item
  // A05 default (both snapshotted); a free-text line needs `unitPriceMinor`. Quantities are thousandths.
  const SO_LINES = {
    type: 'array',
    items: {
      type: 'object',
      properties: {
        itemId: STR,
        description: STR,
        quantityMilli: INT,
        unitPriceMinor: INT,
        taxCode: STR,
      },
    },
  } as const;

  // A delivery-note line: which so_line ships, and how much (thousandths, a whole multiple of 1000
  // for a stock item). Absent, the note defaults to every stock line's undelivered qty.
  const DN_LINES = {
    type: 'array',
    items: {
      type: 'object',
      properties: { soLineId: STR, qty: INT },
      required: ['soLineId', 'qty'],
    },
  } as const;

  return [
    ctxAction(
      'sales_order_create',
      'write',
      'Lege einen Auftrag an: a sales order on a C00 contact with D00 item lines. Each item line is priced once through D00 (contact list, segment list, item base) and its tax code resolved once through the item A05 default, then both are snapshotted as literals on the so_line (the freeze, H-VAT-TRACE). POSTS NOTHING and touches no stock: a sales order is a confirmed demand, not a document. A EUR order snapshots the CHF/txn fx_rate for the H-FX trace. An order with zero lines is a legal draft (confirm refuses an empty order); a foreign contact/item id is refused (invalid_reference / unknown_item).',
      ctxSchema(
        {
          contactId: STR,
          lines: SO_LINES,
          currency: STR,
          quoteId: STR,
          expectedOn: STR,
          notes: STR,
          actor: STR,
          idempotencyKey: STR,
        },
        [],
      ),
      (ctx, input) => createSalesOrder(ctx, as(input)),
    ),
    ctxAction(
      'sales_order_from_quote',
      'write',
      'Wandle eine angenommene Offerte in einen Auftrag um: reads the accepted C02 quote and copies its FROZEN lines (item, qty, price, tax_code travel unchanged, the VAT trace) into a new draft order linked by quote_id. Idempotent and single-order: converting the same quote twice returns the FIRST order, never a second. A non-accepted quote is refused (quote_not_accepted).',
      ctxSchema({ quoteId: STR, idempotencyKey: STR }, ['quoteId']),
      (ctx, input) => salesOrderFromQuote(ctx, as(input)),
    ),
    ctxAction(
      'sales_order_confirm',
      'write',
      'Bestätige einen Auftrag (draft -> confirmed): snapshots stock allocation. Every non-stock (service, free-text) line is auto-delivered on confirmation with NO stock movement, which is what makes it invoiceable without a delivery note; a stock line gets backorder_qty = max(0, ordered - D01 on-hand). A pure-service order advances straight to delivered, a mixed order to partially_delivered, an all-stock order stays confirmed. An empty order is refused (no_lines); a non-draft order is refused (invalid_transition).',
      ctxSchema({ salesOrderId: STR, idempotencyKey: STR }, ['salesOrderId']),
      (ctx, input) => confirmSalesOrder(ctx, as(input)),
    ),
    ctxAction(
      'sales_order_cancel',
      'write',
      'Storniere einen Auftrag (draft|confirmed -> cancelled): keeps open-order lists honest. An order with any ISSUED delivery note is refused with has_deliveries, because shipped goods come back only through an explicit D01 return movement, never by erasing the order (H-AUDIT).',
      ctxSchema({ salesOrderId: STR, idempotencyKey: STR }, ['salesOrderId']),
      (ctx, input) => cancelSalesOrder(ctx, as(input)),
    ),
    ctxAction(
      'sales_order_invoice',
      'write',
      'Erstelle eine Rechnung aus einem Auftrag (P8, lands as an A11 DRAFT): collects the delivered-but-uninvoiced qty (including confirm-time auto-delivered service lines) and delegates to A10 createDocument (type invoice). D03 mints NO journal entry and stores no totals: A11 -> A02 own the posting at issue (P3). Each invoiced portion is one so_line_invoice link row, so a line invoiced across two partial invoices carries two rows; the invoiceable remainder is pre-checked, so a fully-invoiced line writes ZERO rows and returns nothing_to_invoice. NO DOUBLE-BILLING.',
      ctxSchema({ salesOrderId: STR, actor: STR, idempotencyKey: STR }, ['salesOrderId']),
      (ctx, input) => salesOrderInvoice(ctx, as(input)),
    ),
    ctxAction(
      'delivery_note_create',
      'write',
      'Erstelle einen Lieferschein: drafts a delivery note for a confirmed order`s stock-tracked lines from one D01 location. With no explicit lines it defaults to each line`s undelivered qty; an explicit line may ship less (a partial). Issues nothing and moves no stock. Over-delivery (qty over the outstanding remainder) is refused with over_delivery naming the outstanding qty; a zero/fractional qty is refused (invalid_qty).',
      ctxSchema(
        { salesOrderId: STR, locationId: STR, lines: DN_LINES, idempotencyKey: STR },
        ['salesOrderId', 'locationId'],
      ),
      (ctx, input) => createDeliveryNote(ctx, as(input)),
    ),
    ctxAction(
      'delivery_note_issue',
      'write',
      'Liefere aus (P8, stock leaves the shelf): issues a drafted delivery note. Mints ONE D01 issue movement per line through stock.move (OP2, D03 never writes stock_movement itself), stores each stock_movement_id, raises delivered_qty and advances the order (partially_delivered / delivered). Atomic and idempotent: over-delivery and insufficient stock are pre-checked (a refusal writes zero rows), a D01 refusal rolls the whole note back, and a retry re-issues nothing. carries actor for the audit trail.',
      ctxSchema({ deliveryNoteId: STR, actor: STR, idempotencyKey: STR }, ['deliveryNoteId']),
      (ctx, input) => issueDeliveryNote(ctx, as(input)),
    ),
    ctxAction(
      'delivery_note_render',
      'write',
      'Drucke / lade den Lieferschein (local artifact, OP4): renders the Lieferschein PDF for an ISSUED note, files it in E00 (entity_kind delivery_note) and locks OR 958f retention off the shipment date. The PDF carries NO VAT statement (a delivery note is a Beleg, not a taxable document; MWST arises on the A11 invoice). Idempotent: a re-render returns the existing E00 document, one Beleg per note. A draft note is refused (not_issued). The OSS core renders and files, then STOPS; emailing it is cloud-tier.',
      ctxSchema({ deliveryNoteId: STR, idempotencyKey: STR }, ['deliveryNoteId']),
      (ctx, input) => renderDeliveryNote(ctx, as(input)),
    ),
    ctxAction(
      'sales_order_list',
      'read',
      'Liste die Aufträge (P5): filter by status or contact. Each row carries the number, status, currency and order date. savedViewId support rides G00`s saved-view seam on the customization surface.',
      ctxSchema({ status: STR, contactId: STR, savedViewId: STR }, []),
      (ctx, input) => listSalesOrders(ctx, as(input)),
    ),
    ctxAction(
      'sales_order_get',
      'read',
      'Lies einen Auftrag mit Positionen (ordered / delivered / invoiced / backorder qty), seinen Lieferscheinen und den verknüpften Rechnungen. The one read that shows the whole order -> delivery -> invoice chain for a single order. savedViewId is the G00 coverage seam over the delivery_note kind (its custom-field columns surface in the order detail).',
      ctxSchema({ salesOrderId: STR, savedViewId: STR }, ['salesOrderId']),
      (ctx, input) => getSalesOrder(ctx, as(input)),
    ),
    ctxAction(
      'sales_order_backorders',
      'read',
      'Liste die Lieferrückstände (P5): every order line with backorder_qty > 0, joined against current D01 on-hand so you see which backorders are coverable now. An agent can poll this after a D02 receipt to trigger a second delivery. An empty list is not an error.',
      ctxSchema({}, []),
      (ctx, input) => listBackorders(ctx, as(input)),
    ),
  ];
}
