/**
 * D03, sales orders: the order -> delivery -> invoice fulfilment bridge (spec §4). This file owns the
 * order lifecycle (create, from_quote, confirm, cancel), the invoice hand-off, and the read models;
 * `deliveryNotes.ts` owns the delivery-note verbs and shares the helpers exported here.
 *
 * THE MONEY-PATH DISCIPLINE, stated where it is enforced:
 *  - D03 OPENS NO POSTING PATH (§H-LEDGER, P3). `salesOrderInvoice` delegates to A10 `createDocument`
 *    (type `invoice`, a DRAFT that posts nothing); A11 -> A02 own the only journal entry, at issue.
 *    D03 mints no `postEntry`, stores no total, and computes no VAT.
 *  - NO DOUBLE-BILLING. Each invoiced portion is one `so_line_invoice` row; the engine pre-checks
 *    `Σ qty` per line against `delivered_qty` BEFORE any write, so an over-invoice writes ZERO rows,
 *    and the write's idempotency key plus the `UNIQUE(so_line_id, invoice_line_id)` index make a
 *    replay a no-op. `invoiced_qty` can never exceed `delivered_qty`, which can never exceed `qty`.
 *  - §H-TENANT. Every read scopes to `ctx.workspaceId`; a foreign order/contact/item id resolves to
 *    nothing, so a cross-tenant caller can neither read, mutate, nor invoice another book's order.
 *  - §H-VAT-TRACE. Each line's `tax_code` is resolved ONCE at create (D00 default, P6) and frozen;
 *    it travels unchanged into the A11 invoice line, where A05 resolves the amount at issue.
 *
 * THE TX-ATOMICITY DISCIPLINE (the C02 bug this must not reintroduce): `ctx.store.tx` and
 * `rememberIdempotent` roll back ONLY on a throw. A `run` callback that writes and then RETURNS a P9
 * err commits the partial write while reporting failure. So every refusable condition (wrong state,
 * over-invoice, over-delivery, insufficient stock, no lines) is pre-checked as a pure READ before any
 * write and returns its err directly; the only in-transaction failure (a D01 stock refusal under a
 * race) THROWS to force the rollback and is translated to an err outside the transaction.
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { createDocument, getDocument } from './document.js';
import type { DocumentLineInput } from './document.js';
import { resolvePrice } from './priceLists.js';
import { baseCurrencyOf, resolveFxRate } from '../fx/rates.js';
import { findItem, itemOnHand } from '../stock/shared.js';
import { applySavedView } from '../customization/views.js';
import { SO_STATUSES, soCanTransition } from './salesOrderEnums.js';
import type { SoStatus } from './salesOrderEnums.js';

// --- Row types ---------------------------------------------------------------------------------

export interface SalesOrderRow {
  id: string;
  workspace_id: string;
  number: string;
  contact_id: string | null;
  quote_id: string | null;
  status: SoStatus;
  currency: string;
  fx_rate: string | null;
  order_date: string;
  expected_on: string | null;
  notes: string | null;
  actor: string | null;
  created_at: string;
}

export interface SoLineRow {
  id: string;
  workspace_id: string;
  sales_order_id: string;
  item_id: string | null;
  description: string | null;
  qty: number;
  unit_price_rappen: number;
  unit_price_base_rappen: number | null;
  fx_rate: string | null;
  tax_code: string | null;
  delivered_qty: number;
  backorder_qty: number;
  invoiced_qty: number;
  sort: number;
  created_at: string;
}

export interface SoLineInput {
  itemId?: string | null;
  description?: string | null;
  quantityMilli?: number;
  unitPriceMinor?: number;
  taxCode?: string | null;
}

export interface CreateSalesOrderInput {
  contactId?: string | null;
  lines?: SoLineInput[];
  currency?: string;
  quoteId?: string | null;
  expectedOn?: string | null;
  notes?: string | null;
  actor?: string | null;
  idempotencyKey?: string;
}

// --- Shared helpers (also consumed by deliveryNotes.ts) ----------------------------------------

const NUMBER_PREFIX: Readonly<Record<'sales_order' | 'delivery_note', string>> = {
  sales_order: 'AU',
  delivery_note: 'LS',
};

/** The bare day, from the injected clock (never the wall clock). */
export function today(ctx: WorkspaceContext): string {
  return ctx.clock.now().slice(0, 10);
}

/**
 * Consume the next gap-free number for a kind/year, the A10 `document_number_seq` shape. Runs inside
 * the caller's transaction, so a rolled-back create leaves the counter untouched: the number is spent
 * only on a committed create.
 */
export function nextNumber(ctx: WorkspaceContext, kind: 'sales_order' | 'delivery_note', year: string): string {
  const row = ctx.store.db
    .prepare('SELECT next_value FROM d03_number_seq WHERE workspace_id = ? AND kind = ? AND year = ?')
    .get(ctx.workspaceId, kind, year) as { next_value: number } | undefined;
  const value = row?.next_value ?? 1;
  if (row === undefined) {
    ctx.store.db
      .prepare('INSERT INTO d03_number_seq (workspace_id, kind, year, next_value) VALUES (?, ?, ?, ?)')
      .run(ctx.workspaceId, kind, year, value + 1);
  } else {
    ctx.store.db
      .prepare('UPDATE d03_number_seq SET next_value = ? WHERE workspace_id = ? AND kind = ? AND year = ?')
      .run(value + 1, ctx.workspaceId, kind, year);
  }
  return `${NUMBER_PREFIX[kind]}-${year}-${String(value).padStart(4, '0')}`;
}

/** The order row, scoped to this workspace (§H-TENANT), or undefined when it is not this tenant's. */
export function readOrder(ctx: WorkspaceContext, id: unknown): SalesOrderRow | undefined {
  if (typeof id !== 'string' || id.length === 0) return undefined;
  return ctx.store.db
    .prepare('SELECT * FROM sales_order WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, id) as SalesOrderRow | undefined;
}

/** The order's lines in display order. */
export function readLines(ctx: WorkspaceContext, orderId: string): SoLineRow[] {
  return ctx.store.db
    .prepare('SELECT * FROM so_line WHERE workspace_id = ? AND sales_order_id = ? ORDER BY sort, rowid')
    .all(ctx.workspaceId, orderId) as SoLineRow[];
}

/** Is this line stock-tracked? A free-text line (no item) or a non-stock item is a service line. */
export function lineIsStockTracked(ctx: WorkspaceContext, line: SoLineRow): boolean {
  if (typeof line.item_id !== 'string' || line.item_id.length === 0) return false;
  const item = findItem(ctx, line.item_id);
  return item !== undefined && item.track_stock === 1;
}

/**
 * The single status derivation (Pattern P7): a pure function of the lines, so `confirm`,
 * `delivery_issue` and `invoice` all agree on what a set of quantities means. `invoiced` wins when
 * every line is fully invoiced; `delivered` when every line is fully delivered; `partially_delivered`
 * when some has shipped; `confirmed` when nothing has. Never returns `draft` or `cancelled` (those are
 * commanded, not derived).
 */
export function deriveStatus(lines: readonly SoLineRow[]): SoStatus {
  if (lines.length === 0) return 'confirmed';
  const fullyInvoiced = lines.every((l) => l.invoiced_qty >= l.qty);
  if (fullyInvoiced) return 'invoiced';
  const fullyDelivered = lines.every((l) => l.delivered_qty >= l.qty);
  if (fullyDelivered) return 'delivered';
  const anyDelivered = lines.some((l) => l.delivered_qty > 0);
  return anyDelivered ? 'partially_delivered' : 'confirmed';
}

/** Terminal states are COMMANDED (`cancelled`) or the end of the fulfilment chain (`invoiced`); the
 * quantity-derived status must never move them. `deriveStatus` cannot emit `cancelled`, so a cancelled
 * order that still carried a draft note would otherwise be silently resurrected to `delivered` the moment
 * that note issued. This is the belt to the braces of the pre-checks in the issue/cancel verbs. */
const TERMINAL_SO_STATUSES: ReadonlySet<SoStatus> = new Set(['cancelled', 'invoiced']);

/**
 * Write the derived status onto the order row (within the caller's transaction) and return it. A NO-OP on
 * a terminal order (`cancelled`/`invoiced`): a derived status never overrides a commanded terminal state,
 * so a stray issue can neither ship against nor un-cancel a cancelled order. Returns the unchanged status.
 */
export function applyDerivedStatus(ctx: WorkspaceContext, orderId: string): SoStatus {
  const order = readOrder(ctx, orderId);
  if (order !== undefined && TERMINAL_SO_STATUSES.has(order.status)) return order.status;
  const status = deriveStatus(readLines(ctx, orderId));
  ctx.store.db
    .prepare('UPDATE sales_order SET status = ? WHERE workspace_id = ? AND id = ?')
    .run(status, ctx.workspaceId, orderId);
  return status;
}

function mapLine(l: SoLineRow) {
  return {
    id: l.id,
    itemId: l.item_id,
    description: l.description,
    qty: l.qty,
    unitPriceMinor: l.unit_price_rappen,
    unitPriceBaseMinor: l.unit_price_base_rappen,
    fxRate: l.fx_rate,
    taxCode: l.tax_code,
    deliveredQty: l.delivered_qty,
    backorderQty: l.backorder_qty,
    invoicedQty: l.invoiced_qty,
    outstandingQty: l.qty - l.delivered_qty,
    sort: l.sort,
  };
}

function mapOrder(o: SalesOrderRow) {
  return {
    id: o.id,
    number: o.number,
    contactId: o.contact_id,
    quoteId: o.quote_id,
    status: o.status,
    currency: o.currency,
    fxRate: o.fx_rate,
    orderDate: o.order_date,
    expectedOn: o.expected_on,
    notes: o.notes,
  };
}

/** The full order read model: the order, its lines, its delivery notes, and its invoice links. */
export function orderView(ctx: WorkspaceContext, id: string): Result {
  const order = readOrder(ctx, id);
  if (order === undefined) return err('not_found', { salesOrderId: id });
  const notes = ctx.store.db
    .prepare('SELECT id, number, location_id, status, issued_at, artifact_document_id FROM delivery_note WHERE workspace_id = ? AND sales_order_id = ? ORDER BY created_at, rowid')
    .all(ctx.workspaceId, id) as {
    id: string;
    number: string;
    location_id: string | null;
    status: string;
    issued_at: string | null;
    artifact_document_id: string | null;
  }[];
  const invoiceLinks = ctx.store.db
    .prepare('SELECT DISTINCT invoice_id FROM so_line_invoice WHERE workspace_id = ? AND so_line_id IN (SELECT id FROM so_line WHERE workspace_id = ? AND sales_order_id = ?)')
    .all(ctx.workspaceId, ctx.workspaceId, id) as { invoice_id: string }[];
  return ok({
    salesOrder: mapOrder(order),
    lines: readLines(ctx, id).map(mapLine),
    deliveryNotes: notes.map((n) => ({
      id: n.id,
      number: n.number,
      locationId: n.location_id,
      status: n.status,
      issuedAt: n.issued_at,
      artifactDocumentId: n.artifact_document_id,
    })),
    invoiceIds: invoiceLinks.map((r) => r.invoice_id),
  });
}

// --- Line resolution (create) ------------------------------------------------------------------

/**
 * Resolve each line's price and tax code EXACTLY ONCE and snapshot them as literals (P6/P2), the C02
 * `resolveLines` shape. An explicit `unitPriceMinor` wins; else an item line is priced through D00's
 * resolver and a free-text line without a price is refused. The tax code is the explicit one, else the
 * item's A05 default, else null (A11 resolves the amount at issue). A named item that does not exist
 * is refused with `unknown_item` (US-D03.1 error case).
 */
function resolveLines(ctx: WorkspaceContext, lines: SoLineInput[], contactId: string | null): Result {
  const at = today(ctx);
  const resolved: {
    itemId: string | null;
    description: string | null;
    quantityMilli: number;
    unitPriceMinor: number;
    taxCode: string | null;
  }[] = [];
  for (const [index, line] of lines.entries()) {
    const position = index + 1;
    const quantityMilli = line.quantityMilli ?? 1000;
    if (!Number.isInteger(quantityMilli) || quantityMilli <= 0) {
      return err('invalid_qty', { position, qty: line.quantityMilli });
    }
    let unitPriceMinor = line.unitPriceMinor;
    let taxCode: string | null | undefined = line.taxCode;

    if (typeof line.itemId === 'string' && line.itemId.length > 0) {
      const item = ctx.store.db
        .prepare('SELECT id, default_tax_code, track_stock FROM item WHERE workspace_id = ? AND id = ?')
        .get(ctx.workspaceId, line.itemId) as { id: string; default_tax_code: string | null; track_stock: number } | undefined;
      if (item === undefined) return err('unknown_item', { position, itemId: line.itemId });
      // A stock-tracked line ships in WHOLE units through D01 (`validateShipQty` requires a multiple of
      // 1000, and confirm floors `qty/1000`). Ordering a sub-unit remainder (e.g. 2500) would strand the
      // 500 milli undeliverable forever. Refuse it at create, where the item's tracking is known. A
      // service/free-text line keeps fractional qty (2.5 hours is legal).
      if (item.track_stock === 1 && quantityMilli % 1000 !== 0) {
        return err('invalid_qty', { position, qty: quantityMilli, reason: 'a stock-tracked line ships in whole units (a multiple of 1000)' });
      }
      if (unitPriceMinor === undefined) {
        const priced = resolvePrice(ctx, { itemId: line.itemId, contactId, at });
        if (!priced.ok) return priced;
        unitPriceMinor = (priced as unknown as { priceMinor: number }).priceMinor;
      }
      if (taxCode === undefined) taxCode = item.default_tax_code;
    }

    if (typeof unitPriceMinor !== 'number' || !Number.isInteger(unitPriceMinor) || unitPriceMinor < 0) {
      return err('invalid_line', {
        position,
        field: 'unitPriceMinor',
        reason: 'a free-text line needs a non-negative integer unit price; an item line is priced from D00',
      });
    }
    resolved.push({
      itemId: line.itemId ?? null,
      description: line.description ?? null,
      quantityMilli,
      unitPriceMinor,
      taxCode: taxCode ?? null,
    });
  }
  return ok({ lines: resolved });
}

// --- Verbs -------------------------------------------------------------------------------------

/**
 * US-D03.1: draft a sales order with resolved, frozen lines. Posts nothing. A EUR order snapshots the
 * CHF/txn `fx_rate` for the §H-FX trace when a rate is on record (never a refusal at order time: A11
 * resolves the authoritative conversion at issue). An order with zero lines is a legal draft; `confirm`
 * is what refuses an empty order.
 */
export function createSalesOrder(ctx: WorkspaceContext, input: CreateSalesOrderInput): Result {
  const contactId = input.contactId ?? null;
  if (contactId !== null) {
    const c = ctx.store.db
      .prepare('SELECT id FROM contact WHERE workspace_id = ? AND id = ?')
      .get(ctx.workspaceId, contactId) as { id: string } | undefined;
    if (c === undefined) return err('invalid_reference', { field: 'contactId', contactId });
  }
  const currency = input.currency ?? baseCurrencyOf(ctx);
  const resolvedLines = resolveLines(ctx, input.lines ?? [], contactId);
  if (!resolvedLines.ok) return resolvedLines;
  const lines = (resolvedLines as unknown as {
    lines: { itemId: string | null; description: string | null; quantityMilli: number; unitPriceMinor: number; taxCode: string | null }[];
  }).lines;

  // §H-FX trace: snapshot the CHF/txn rate ONCE when foreign and a rate is on record. A missing rate
  // is not a refusal here (unlike a posting), because D03 posts nothing: it stores what it knows.
  let fxRate: string | null = null;
  if (currency !== baseCurrencyOf(ctx)) {
    const r = resolveFxRate(ctx, { currency, date: today(ctx) });
    if (r.ok) fxRate = (r as unknown as { resolved: { rate: string } }).resolved.rate;
  }

  const run = (): Result => {
    const year = today(ctx).slice(0, 4);
    const id = ctx.ids.next('so');
    const number = nextNumber(ctx, 'sales_order', year);
    const at = ctx.clock.now();
    ctx.store.db
      .prepare(
        `INSERT INTO sales_order
           (id, workspace_id, number, contact_id, quote_id, status, currency, fx_rate, order_date, expected_on, notes, actor, created_at)
         VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        ctx.workspaceId,
        number,
        contactId,
        input.quoteId ?? null,
        currency,
        fxRate,
        today(ctx),
        input.expectedOn ?? null,
        input.notes ?? null,
        input.actor ?? ctx.actor,
        at,
      );
    const insert = ctx.store.db.prepare(
      `INSERT INTO so_line
         (id, workspace_id, sales_order_id, item_id, description, qty, unit_price_rappen, unit_price_base_rappen, fx_rate, tax_code, delivered_qty, backorder_qty, invoiced_qty, sort, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, 0, 0, 0, ?, ?)`,
    );
    lines.forEach((line, index) => {
      insert.run(
        ctx.ids.next('soline'),
        ctx.workspaceId,
        id,
        line.itemId,
        line.description,
        line.quantityMilli,
        line.unitPriceMinor,
        fxRate,
        line.taxCode,
        index + 1,
        at,
      );
    });
    return orderView(ctx, id);
  };

  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'sales_order_create', run);
  }
  return ctx.store.tx(run);
}

/**
 * US-D03.1: raise an order from an accepted C02 quote. Reads the quote's frozen `document_line` rows
 * (item, qty, price, tax_code travel unchanged, the VAT trace) and delegates to `createSalesOrder`.
 * Idempotent and single-order: a second conversion of the same quote returns the FIRST order (the
 * `sales_order_by_quote` unique index plus this pre-check), never a second.
 */
export function salesOrderFromQuote(
  ctx: WorkspaceContext,
  input: { quoteId?: string; idempotencyKey?: string },
): Result {
  if (typeof input.quoteId !== 'string' || input.quoteId.length === 0) {
    return err('invalid_input', { field: 'quoteId' });
  }
  // A completed conversion replays before any state guard (§H-IDEMPOTENT), so a retry returns the
  // first order rather than an `already_converted` on a state it already produced.
  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    const replay = ctx.store.recallIdempotent<Result>(ctx.workspaceId, input.idempotencyKey, 'sales_order_from_quote');
    if (replay !== undefined) return replay;
  }
  const existing = ctx.store.db
    .prepare('SELECT id FROM sales_order WHERE workspace_id = ? AND quote_id = ?')
    .get(ctx.workspaceId, input.quoteId) as { id: string } | undefined;
  if (existing !== undefined) return orderView(ctx, existing.id);

  const quote = getDocument(ctx, { documentId: input.quoteId });
  if (!quote.ok) return quote;
  const q = quote as unknown as {
    document: { type: string; status: string; contact_id?: string | null; contactId?: string | null; currency: string };
    lines: { item_id?: string | null; itemId?: string | null; description: string | null; quantity_milli?: number; quantityMilli?: number; unit_price_minor?: number; unitPriceMinor?: number; tax_code?: string | null; taxCode?: string | null }[];
  };
  if (q.document.type !== 'quote') return err('not_a_quote', { quoteId: input.quoteId, type: q.document.type });
  if (q.document.status !== 'accepted') {
    return err('quote_not_accepted', { quoteId: input.quoteId, status: q.document.status });
  }
  const contactId = q.document.contactId ?? q.document.contact_id ?? null;
  const lines: SoLineInput[] = q.lines.map((l) => ({
    itemId: l.itemId ?? l.item_id ?? null,
    description: l.description ?? null,
    quantityMilli: l.quantityMilli ?? l.quantity_milli ?? 1000,
    unitPriceMinor: l.unitPriceMinor ?? l.unit_price_minor ?? 0,
    taxCode: l.taxCode ?? l.tax_code ?? null,
  }));
  const createInput: CreateSalesOrderInput = { contactId, lines, currency: q.document.currency, quoteId: input.quoteId };
  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    createInput.idempotencyKey = input.idempotencyKey;
  }
  return createSalesOrder(ctx, createInput);
}

/**
 * US-D03.2: confirm a draft order and snapshot stock allocation. Non-stock (service, free-text) lines
 * are auto-delivered at confirm (`delivered_qty = qty`, NO stock movement, OP2 untouched), which is
 * what makes them invoiceable without a delivery note. A stock-tracked line's `backorder_qty` is
 * `max(0, ordered - D01 on-hand)` at confirm (a snapshot, P5). The order then lands in `delivered`
 * (pure-service), `partially_delivered` (mixed) or `confirmed` (all stock, nothing shipped).
 */
export function confirmSalesOrder(
  ctx: WorkspaceContext,
  input: { salesOrderId?: string; idempotencyKey?: string },
): Result {
  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    const replay = ctx.store.recallIdempotent<Result>(ctx.workspaceId, input.idempotencyKey, 'sales_order_confirm');
    if (replay !== undefined) return replay;
  }
  const order = readOrder(ctx, input.salesOrderId);
  if (order === undefined) return err('not_found', { salesOrderId: input.salesOrderId });
  if (order.status !== 'draft') {
    return err('invalid_transition', { from: order.status, to: 'confirmed', salesOrderId: order.id });
  }
  const lines = readLines(ctx, order.id);
  if (lines.length === 0) return err('no_lines', { salesOrderId: order.id });

  const run = (): Result => {
    for (const line of lines) {
      if (lineIsStockTracked(ctx, line)) {
        const availableUnits = itemOnHand(ctx, line.item_id as string);
        const orderedUnits = Math.floor(line.qty / 1000);
        const backorderUnits = Math.max(0, orderedUnits - availableUnits);
        ctx.store.db
          .prepare('UPDATE so_line SET backorder_qty = ? WHERE workspace_id = ? AND id = ?')
          .run(backorderUnits * 1000, ctx.workspaceId, line.id);
      } else {
        // A service line is delivered on confirmation: no shelf, no movement (OP2 untouched).
        ctx.store.db
          .prepare('UPDATE so_line SET delivered_qty = qty, backorder_qty = 0 WHERE workspace_id = ? AND id = ?')
          .run(ctx.workspaceId, line.id);
      }
    }
    applyDerivedStatus(ctx, order.id);
    const view = orderView(ctx, order.id);
    const status = (view as unknown as { salesOrder: { status: SoStatus } }).salesOrder.status;
    // Null-collapse event ids (the D01 low-stock precedent): the automation event fires ONLY on the
    // transition that actually happened, so a rule triggers once per real move, never per verb call.
    return ok({
      ...(view as unknown as Record<string, unknown>),
      confirmedOrderId: order.id,
      partiallyDeliveredOrderId: status === 'partially_delivered' ? order.id : null,
      deliveredOrderId: status === 'delivered' ? order.id : null,
    });
  };

  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'sales_order_confirm', run);
  }
  return ctx.store.tx(run);
}

/**
 * US-D03.6: cancel an order that will not ship. `draft` or `confirmed` only (P7); an order with any
 * ISSUED delivery note is refused with `has_deliveries`, because shipped goods come back through an
 * explicit D01 `return` movement, never by erasing the order (§H-AUDIT spirit). Guarded BEFORE the
 * transaction, so a refusal writes zero rows.
 */
export function cancelSalesOrder(
  ctx: WorkspaceContext,
  input: { salesOrderId?: string; idempotencyKey?: string },
): Result {
  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    const replay = ctx.store.recallIdempotent<Result>(ctx.workspaceId, input.idempotencyKey, 'sales_order_cancel');
    if (replay !== undefined) return replay;
  }
  const order = readOrder(ctx, input.salesOrderId);
  if (order === undefined) return err('not_found', { salesOrderId: input.salesOrderId });
  // The more specific refusal wins: an order with any ISSUED delivery note names `has_deliveries`
  // (shipped goods come back through a D01 return move, §H-AUDIT) rather than the generic
  // `invalid_transition`. Checked BEFORE the transition guard so the operator gets the actionable
  // message. A delivered/partially_delivered order always trips this; the transition guard below then
  // covers the note-less terminal states (a pure-service invoiced order).
  const issued = ctx.store.db
    .prepare("SELECT COUNT(*) AS n FROM delivery_note WHERE workspace_id = ? AND sales_order_id = ? AND status = 'issued'")
    .get(ctx.workspaceId, order.id) as { n: number };
  if (issued.n > 0) return err('has_deliveries', { salesOrderId: order.id, issued: issued.n });
  if (!soCanTransition(order.status, 'cancelled')) {
    return err('invalid_transition', { from: order.status, to: 'cancelled', salesOrderId: order.id });
  }

  const run = (): Result => {
    ctx.store.db
      .prepare("UPDATE sales_order SET status = 'cancelled' WHERE workspace_id = ? AND id = ?")
      .run(ctx.workspaceId, order.id);
    // Void every un-issued (draft) delivery note with the order. Spec §7's DN_STATUS is
    // `draft -> issued | cancelled(draft-only)`: a draft note is a plan that has moved no stock, so it
    // dies with the order rather than lingering as an orphan a caller could still try to issue. An ISSUED
    // note is never here (the `has_deliveries` guard above already refused the cancel). This is the
    // primary defence; `issueDeliveryNote`'s order-status pre-check and `applyDerivedStatus`'s terminal
    // guard are the belt and braces if a note ever reaches issue by another path.
    const voided = ctx.store.db
      .prepare("UPDATE delivery_note SET status = 'cancelled' WHERE workspace_id = ? AND sales_order_id = ? AND status = 'draft'")
      .run(ctx.workspaceId, order.id).changes;
    const view = orderView(ctx, order.id);
    return ok({ ...(view as unknown as Record<string, unknown>), cancelledOrderId: order.id, voidedDraftNotes: voided });
  };
  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'sales_order_cancel', run);
  }
  return ctx.store.tx(run);
}

/**
 * US-D03.5: convert delivered-but-uninvoiced qty into an A11 DRAFT invoice. Delegates to A10
 * `createDocument` (type `invoice`); D03 mints no journal entry and stores no totals (P3). Each
 * invoiced portion is one `so_line_invoice` link row (`Σ qty` per line can never exceed
 * `delivered_qty`), so a line invoiced across two partial invoices carries two rows, never an
 * overwritten FK. NO DOUBLE-BILLING: the invoiceable remainder is pre-checked BEFORE any write, so
 * invoicing a fully-invoiced line writes zero rows and returns `nothing_to_invoice`.
 */
export function salesOrderInvoice(
  ctx: WorkspaceContext,
  input: { salesOrderId?: string; actor?: string; idempotencyKey?: string },
): Result {
  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    const replay = ctx.store.recallIdempotent<Result>(ctx.workspaceId, input.idempotencyKey, 'sales_order_invoice');
    if (replay !== undefined) return replay;
  }
  const order = readOrder(ctx, input.salesOrderId);
  if (order === undefined) return err('not_found', { salesOrderId: input.salesOrderId });
  if (order.status === 'draft' || order.status === 'cancelled') {
    return err('invalid_transition', { from: order.status, to: 'invoiced', salesOrderId: order.id });
  }
  const lines = readLines(ctx, order.id);
  // The invoiceable remainder per line, computed as a pure read BEFORE any write (the no-double-bill
  // pre-check): delivered minus already-invoiced. Zero across all lines is a structured refusal.
  const billable = lines
    .map((l) => ({ line: l, qty: l.delivered_qty - l.invoiced_qty }))
    .filter((b) => b.qty > 0);
  if (billable.length === 0) return err('nothing_to_invoice', { salesOrderId: order.id });

  const run = (): Result => {
    const invoiceLines: DocumentLineInput[] = billable.map((b) => ({
      itemId: b.line.item_id,
      description: b.line.description,
      quantityMilli: b.qty,
      unitPriceMinor: b.line.unit_price_rappen,
      taxCode: b.line.tax_code,
    }));
    const created = createDocument(ctx, {
      type: 'invoice',
      contactId: order.contact_id,
      currency: order.currency,
      lines: invoiceLines,
      notes: `Auftrag ${order.number}`,
    });
    if (!created.ok) throw new SalesOrderAbort(created);
    const invoice = created as unknown as { document: { id: string }; lines: { id: string }[] };
    const invoiceId = invoice.document.id;
    // The created invoice lines are in the SAME order as `billable`, so pairing by index maps each
    // so_line to its freshly minted invoice line. One link row per invoiced portion.
    const insertLink = ctx.store.db.prepare(
      `INSERT INTO so_line_invoice (id, workspace_id, so_line_id, invoice_id, invoice_line_id, qty, idempotency_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    billable.forEach((b, index) => {
      const invoiceLineId = invoice.lines[index]?.id;
      if (invoiceLineId === undefined) throw new SalesOrderAbort(err('invoice_line_missing', { position: index + 1 }));
      insertLink.run(
        ctx.ids.next('soli'),
        ctx.workspaceId,
        b.line.id,
        invoiceId,
        invoiceLineId,
        b.qty,
        input.idempotencyKey ?? null,
        ctx.clock.now(),
      );
      ctx.store.db
        .prepare('UPDATE so_line SET invoiced_qty = invoiced_qty + ? WHERE workspace_id = ? AND id = ?')
        .run(b.qty, ctx.workspaceId, b.line.id);
    });
    const status = applyDerivedStatus(ctx, order.id);
    const view = orderView(ctx, order.id);
    return ok({
      ...(view as unknown as Record<string, unknown>),
      invoiceId,
      invoicedOrderId: status === 'invoiced' ? order.id : null,
    });
  };

  try {
    if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
      return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'sales_order_invoice', run);
    }
    return ctx.store.tx(run);
  } catch (e) {
    if (e instanceof SalesOrderAbort) return e.result;
    throw e;
  }
}

/** Abort the transaction so a partial write rolls back and nothing is memoised (the A10 pattern). */
export class SalesOrderAbort {
  constructor(public readonly result: Result) {}
}

// --- Read models -------------------------------------------------------------------------------

/** US-D03 reads: list orders, filtered by status or contact (P5). A `sales_order` saved view (G00)
 * merges its stored filters UNDERNEATH any filter named explicitly here. */
export function listSalesOrders(
  ctx: WorkspaceContext,
  input: { status?: string; contactId?: string; savedViewId?: string },
): Result {
  const viewed = applySavedView(ctx, 'sales_order', {
    ...(input.status !== undefined ? { status: input.status } : {}),
    ...(input.contactId !== undefined ? { contactId: input.contactId } : {}),
    ...(input.savedViewId !== undefined ? { savedViewId: input.savedViewId } : {}),
  });
  if (!viewed.ok) return viewed;
  const f = viewed.filter as { status?: string; contactId?: string };
  const clauses = ['workspace_id = ?'];
  const params: unknown[] = [ctx.workspaceId];
  if (typeof f.status === 'string' && f.status.length > 0) {
    clauses.push('status = ?');
    params.push(f.status);
  }
  if (typeof f.contactId === 'string' && f.contactId.length > 0) {
    clauses.push('contact_id = ?');
    params.push(f.contactId);
  }
  const rows = ctx.store.db
    .prepare(`SELECT * FROM sales_order WHERE ${clauses.join(' AND ')} ORDER BY order_date DESC, created_at DESC, rowid DESC`)
    .all(...params) as SalesOrderRow[];
  return ok({ salesOrders: rows.map(mapOrder) });
}

/** US-D03 read: one order with its lines, delivery notes and invoice links. `savedViewId` is accepted
 * for the G00 coverage-read seam over the `delivery_note` kind (the `project_get` precedent): the
 * order detail is where a delivery note's custom-field columns surface. */
export function getSalesOrder(ctx: WorkspaceContext, input: { salesOrderId?: string; savedViewId?: string }): Result {
  if (typeof input.salesOrderId !== 'string' || input.salesOrderId.length === 0) {
    return err('invalid_input', { field: 'salesOrderId' });
  }
  return orderView(ctx, input.salesOrderId);
}

/**
 * US-D03.2/4: the backorder list. Every line with `backorder_qty > 0`, joined against current D01
 * on-hand so an operator (or an agent polling after a D02 receipt) sees which backorders are coverable
 * now. An empty list is not an error.
 */
export function listBackorders(ctx: WorkspaceContext, _input: Record<string, unknown>): Result {
  const rows = ctx.store.db
    .prepare(
      `SELECT sl.id AS so_line_id, sl.item_id, sl.description, sl.qty, sl.delivered_qty, sl.backorder_qty,
              so.id AS sales_order_id, so.number
         FROM so_line sl JOIN sales_order so ON so.id = sl.sales_order_id AND so.workspace_id = sl.workspace_id
        WHERE sl.workspace_id = ? AND sl.backorder_qty > 0 AND so.status NOT IN ('cancelled', 'invoiced')
        ORDER BY so.order_date, so.number`,
    )
    .all(ctx.workspaceId) as {
    so_line_id: string;
    item_id: string | null;
    description: string | null;
    qty: number;
    delivered_qty: number;
    backorder_qty: number;
    sales_order_id: string;
    number: string;
  }[];
  const backorders = rows.map((r) => {
    const availableUnits = typeof r.item_id === 'string' ? itemOnHand(ctx, r.item_id) : 0;
    const backorderUnits = Math.floor(r.backorder_qty / 1000);
    return {
      salesOrderId: r.sales_order_id,
      number: r.number,
      soLineId: r.so_line_id,
      itemId: r.item_id,
      description: r.description,
      backorderQty: r.backorder_qty,
      availableNow: availableUnits * 1000,
      coverableNow: availableUnits >= backorderUnits,
    };
  });
  return ok({ backorders });
}

/** The set of legal SO statuses, exported for the Studio's §H-ENUM mirror. */
export const SALES_ORDER_STATUSES = SO_STATUSES;
