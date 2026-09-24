/**
 * D03, delivery notes (Lieferscheine): the shipment half of the order -> delivery -> invoice chain
 * (spec §4). Owns `delivery_note_create` / `delivery_note_issue` / `delivery_note_render`; shares the
 * order helpers exported by `salesOrders.ts`.
 *
 * THE STOCK DISCIPLINE, stated where it is enforced:
 *  - EVERY ISSUE MOVEMENT IS MINTED THROUGH D01 `recordStockMove` (OP2). D03 never writes
 *    `stock_movement` itself; it stores the `stock_movement_id` D01 returns. A cancel/return comes
 *    back through an explicit D01 `return` movement, never a destructive edit (§H-AUDIT).
 *  - IDEMPOTENT ISSUE. A per-line stock-move key derived from the issue's idempotency key means a
 *    retry double-issues NOTHING: D01 replays the original movement, and the note's own idempotency
 *    replay returns the first result. Stock leaves the shelf exactly once.
 *  - ATOMIC ISSUE. The whole note issues in ONE transaction. Over-delivery and insufficient stock are
 *    pre-checked as pure reads BEFORE any write (so a refused issue leaves the row count UNCHANGED),
 *    and a D01 refusal under a race THROWS to roll the transaction back: no half-issued note, no
 *    orphan movement, and nothing memoised against the caller's key.
 *
 * THE LIEFERSCHEIN IS A BELEG, NOT A TAXABLE DOCUMENT (spec §3). `delivery_note_render` produces the
 * PDF as a LOCAL artifact (OP4, mirrors D02 `po_send`: the OSS core renders and files, then STOPS),
 * files it in E00 under `entity_kind:'delivery_note'`, and locks OR 958f retention off the shipment
 * date. The PDF carries NO VAT statement: MWST arises only on the A11 invoice.
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import {
  readOrder,
  readLines,
  orderView,
  applyDerivedStatus,
  nextNumber,
  today,
  lineIsStockTracked,
  SalesOrderAbort,
} from './salesOrders.js';
import type { SoLineRow } from './salesOrders.js';
import { recordStockMove } from '../stock/movements.js';
import { findLocation, onHandFor, itemOnHand } from '../stock/shared.js';
import { uploadFile, linkFile, setFileRetention } from '../files/index.js';
import { statutoryRetentionUntil } from '../files/retention.js';
import { buildMinimalPdf, pdfEscape } from './invoice.js';
import { dnCanTransition } from './salesOrderEnums.js';

interface DeliveryNoteRow {
  id: string;
  workspace_id: string;
  sales_order_id: string;
  number: string;
  location_id: string | null;
  status: string;
  issued_at: string | null;
  artifact_document_id: string | null;
  actor: string | null;
  created_at: string;
}

interface DnLineRow {
  id: string;
  workspace_id: string;
  delivery_note_id: string;
  so_line_id: string;
  qty: number;
  stock_movement_id: string | null;
  created_at: string;
}

function readNote(ctx: WorkspaceContext, id: unknown): DeliveryNoteRow | undefined {
  if (typeof id !== 'string' || id.length === 0) return undefined;
  return ctx.store.db
    .prepare('SELECT * FROM delivery_note WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, id) as DeliveryNoteRow | undefined;
}

function readDnLines(ctx: WorkspaceContext, noteId: string): DnLineRow[] {
  return ctx.store.db
    .prepare('SELECT * FROM dn_line WHERE workspace_id = ? AND delivery_note_id = ? ORDER BY rowid')
    .all(ctx.workspaceId, noteId) as DnLineRow[];
}

function noteView(ctx: WorkspaceContext, id: string): Result {
  const note = readNote(ctx, id);
  if (note === undefined) return err('not_found', { deliveryNoteId: id });
  return ok({
    deliveryNote: {
      id: note.id,
      number: note.number,
      salesOrderId: note.sales_order_id,
      locationId: note.location_id,
      status: note.status,
      issuedAt: note.issued_at,
      artifactDocumentId: note.artifact_document_id,
      lines: readDnLines(ctx, id).map((l) => ({
        id: l.id,
        soLineId: l.so_line_id,
        qty: l.qty,
        stockMovementId: l.stock_movement_id,
      })),
    },
  });
}

/** The still-deliverable remainder of a line, in thousandths. */
function outstanding(line: SoLineRow): number {
  return line.qty - line.delivered_qty;
}

/**
 * US-D03.3: draft a delivery note for the stock-tracked lines of a confirmed order. With no explicit
 * `lines`, it defaults to every stock line's undelivered qty from one D01 location; an explicit line
 * may ship less (a partial). Over-delivery (`qty > outstanding`), a zero/fractional qty, or an unknown
 * so_line are all pre-checked BEFORE any write, so a refusal writes zero rows. Nothing is issued here.
 */
export function createDeliveryNote(
  ctx: WorkspaceContext,
  input: { salesOrderId?: string; locationId?: string; lines?: { soLineId: string; qty: number }[]; idempotencyKey?: string },
): Result {
  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    const replay = ctx.store.recallIdempotent<Result>(ctx.workspaceId, input.idempotencyKey, 'delivery_note_create');
    if (replay !== undefined) return replay;
  }
  const order = readOrder(ctx, input.salesOrderId);
  if (order === undefined) return err('not_found', { salesOrderId: input.salesOrderId });
  if (order.status !== 'confirmed' && order.status !== 'partially_delivered') {
    return err('invalid_transition', { from: order.status, to: 'delivery', salesOrderId: order.id });
  }
  const location = findLocation(ctx, input.locationId);
  if (location === undefined) return err('not_found', { locationId: input.locationId });

  const lines = readLines(ctx, order.id);
  const byId = new Map(lines.map((l) => [l.id, l]));

  // Resolve the note's lines, validating each as a pure read (no write) so an over-delivery refuses
  // with zero rows written.
  let planned: { soLineId: string; qty: number }[];
  if (Array.isArray(input.lines) && input.lines.length > 0) {
    planned = [];
    for (const [index, req] of input.lines.entries()) {
      const position = index + 1;
      const soLine = byId.get(req.soLineId);
      if (soLine === undefined) return err('unknown_line', { position, soLineId: req.soLineId });
      if (!lineIsStockTracked(ctx, soLine)) {
        return err('not_stock_tracked', { position, soLineId: req.soLineId });
      }
      const qtyErr = validateShipQty(req.qty, outstanding(soLine));
      if (qtyErr !== null) return { ...qtyErr, position } as Result;
      planned.push({ soLineId: req.soLineId, qty: req.qty });
    }
  } else {
    planned = lines
      .filter((l) => lineIsStockTracked(ctx, l) && outstanding(l) > 0)
      .map((l) => ({ soLineId: l.id, qty: outstanding(l) }));
  }
  if (planned.length === 0) return err('no_lines', { salesOrderId: order.id });

  const run = (): Result => {
    const year = today(ctx).slice(0, 4);
    const id = ctx.ids.next('dn');
    const number = nextNumber(ctx, 'delivery_note', year);
    const at = ctx.clock.now();
    ctx.store.db
      .prepare(
        `INSERT INTO delivery_note (id, workspace_id, sales_order_id, number, location_id, status, issued_at, artifact_document_id, actor, created_at)
         VALUES (?, ?, ?, ?, ?, 'draft', NULL, NULL, ?, ?)`,
      )
      .run(id, ctx.workspaceId, order.id, number, location.id, ctx.actor, at);
    const insert = ctx.store.db.prepare(
      'INSERT INTO dn_line (id, workspace_id, delivery_note_id, so_line_id, qty, stock_movement_id, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?)',
    );
    for (const p of planned) {
      insert.run(ctx.ids.next('dnline'), ctx.workspaceId, id, p.soLineId, p.qty, at);
    }
    return noteView(ctx, id);
  };

  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'delivery_note_create', run);
  }
  return ctx.store.tx(run);
}

/** A ship qty must be a positive whole multiple of 1000 (D01 counts integer units) within outstanding. */
function validateShipQty(qty: unknown, outstandingQty: number): Result | null {
  if (typeof qty !== 'number' || !Number.isInteger(qty) || qty <= 0 || qty % 1000 !== 0) {
    return err('invalid_qty', { qty });
  }
  if (qty > outstandingQty) return err('over_delivery', { qty, outstanding: outstandingQty });
  return null;
}

/**
 * US-D03.3/4: issue a drafted note. Mints one D01 issue movement per line through `recordStockMove`
 * (OP2), stores each `stock_movement_id`, raises `delivered_qty`, recomputes `backorder_qty`, and
 * advances the order status. Atomic: over-delivery and insufficient stock are pre-checked (zero rows
 * on refusal), and a D01 refusal under a race throws to roll the whole issue back.
 */
export function issueDeliveryNote(
  ctx: WorkspaceContext,
  input: { deliveryNoteId?: string; actor?: string; idempotencyKey?: string },
): Result {
  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    const replay = ctx.store.recallIdempotent<Result>(ctx.workspaceId, input.idempotencyKey, 'delivery_note_issue');
    if (replay !== undefined) return replay;
  }
  const note = readNote(ctx, input.deliveryNoteId);
  if (note === undefined) return err('not_found', { deliveryNoteId: input.deliveryNoteId });
  if (!dnCanTransition(note.status as 'draft' | 'issued' | 'cancelled', 'issued')) {
    return err('invalid_transition', { from: note.status, to: 'issued', deliveryNoteId: note.id });
  }
  // The parent order must still be shippable. Mirrors `createDeliveryNote`'s guard and pre-checks it
  // here as a pure read BEFORE any write or any D01 stock move (the C02 tx-atomicity trap: `ctx.store.tx`
  // rolls back only on THROW). Without this, a note whose order was cancelled while the note sat in
  // `draft` (cancel's `has_deliveries` counts only ISSUED notes) could ship stock and, via
  // `applyDerivedStatus`, resurrect a terminal `cancelled` order back to `delivered`. Refused with the
  // same `invalid_transition` code `createDeliveryNote` uses so the Studio's error copy already covers it.
  const order = readOrder(ctx, note.sales_order_id);
  if (order === undefined) return err('not_found', { salesOrderId: note.sales_order_id });
  if (order.status !== 'confirmed' && order.status !== 'partially_delivered') {
    return err('invalid_transition', { from: order.status, to: 'delivery', salesOrderId: order.id, deliveryNoteId: note.id });
  }
  if (note.location_id === null) return err('invalid_input', { field: 'locationId', reason: 'note has no location' });

  const dnLines = readDnLines(ctx, note.id);
  if (dnLines.length === 0) return err('no_lines', { deliveryNoteId: note.id });
  const orderLines = new Map(readLines(ctx, note.sales_order_id).map((l) => [l.id, l]));

  // Pre-check: over-delivery per line and total required units per item at this location. Both are
  // pure reads, so a refusal writes zero rows (the C02 tx-atomicity trap).
  const required = new Map<string, number>(); // item_id -> units
  for (const dl of dnLines) {
    const soLine = orderLines.get(dl.so_line_id);
    if (soLine === undefined) return err('unknown_line', { soLineId: dl.so_line_id });
    const qtyErr = validateShipQty(dl.qty, outstanding(soLine));
    if (qtyErr !== null) return qtyErr;
    const itemId = soLine.item_id as string;
    required.set(itemId, (required.get(itemId) ?? 0) + dl.qty / 1000);
  }
  for (const [itemId, units] of required) {
    const available = onHandFor(ctx, itemId, note.location_id);
    if (available < units) {
      return err('insufficient_stock', { itemId, locationId: note.location_id, available, required: units });
    }
  }

  const key = input.idempotencyKey ?? note.id;
  const run = (): Result => {
    const movements: { dnLineId: string; stockMovementId: string }[] = [];
    for (const dl of dnLines) {
      const soLine = orderLines.get(dl.so_line_id) as SoLineRow;
      const move = recordStockMove(ctx, {
        itemId: soLine.item_id as string,
        locationId: note.location_id as string,
        qty: dl.qty / 1000,
        reason: 'issue',
        refKind: 'delivery_note',
        refId: note.id,
        idempotencyKey: `${key}#${dl.id}`,
      });
      if (!move.ok) throw new SalesOrderAbort(move);
      const firstMovement = (move as unknown as { movements: { id: string }[] }).movements[0];
      if (firstMovement === undefined) throw new SalesOrderAbort(err('stock_move_no_movement', { soLineId: dl.so_line_id }));
      const movementId = firstMovement.id;
      ctx.store.db
        .prepare('UPDATE dn_line SET stock_movement_id = ? WHERE workspace_id = ? AND id = ?')
        .run(movementId, ctx.workspaceId, dl.id);
      ctx.store.db
        .prepare('UPDATE so_line SET delivered_qty = delivered_qty + ? WHERE workspace_id = ? AND id = ?')
        .run(dl.qty, ctx.workspaceId, dl.so_line_id);
      // Recompute the line's backorder against post-issue on-hand.
      const outstandingUnits = Math.floor((soLine.qty - soLine.delivered_qty - dl.qty) / 1000);
      const availableUnits = itemOnHand(ctx, soLine.item_id as string);
      const backorderUnits = Math.max(0, outstandingUnits - availableUnits);
      ctx.store.db
        .prepare('UPDATE so_line SET backorder_qty = ? WHERE workspace_id = ? AND id = ?')
        .run(backorderUnits * 1000, ctx.workspaceId, dl.so_line_id);
      movements.push({ dnLineId: dl.id, stockMovementId: movementId });
    }
    ctx.store.db
      .prepare("UPDATE delivery_note SET status = 'issued', issued_at = ?, actor = ? WHERE workspace_id = ? AND id = ?")
      .run(today(ctx), input.actor ?? ctx.actor, ctx.workspaceId, note.id);
    const status = applyDerivedStatus(ctx, note.sales_order_id);
    const nv = noteView(ctx, note.id);
    const ov = orderView(ctx, note.sales_order_id);
    return ok({
      ...(nv as unknown as Record<string, unknown>),
      salesOrder: (ov as unknown as { salesOrder: unknown }).salesOrder,
      movements,
      deliveryNoteIssuedId: note.id,
      partiallyDeliveredOrderId: status === 'partially_delivered' ? note.sales_order_id : null,
      deliveredOrderId: status === 'delivered' ? note.sales_order_id : null,
    });
  };

  try {
    if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
      return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'delivery_note_issue', run);
    }
    return ctx.store.tx(run);
  } catch (e) {
    if (e instanceof SalesOrderAbort) return e.result;
    throw e;
  }
}

/**
 * US-D03.3: render the Lieferschein PDF for an ISSUED note (refuses a draft with `not_issued`), file
 * it in E00 (`entity_kind:'delivery_note'`) and lock OR 958f retention off the shipment date. The PDF
 * carries NO VAT statement (§3). Idempotent: an already-rendered note returns its existing
 * `artifactDocumentId`, one Beleg per note, never a duplicate E00 document.
 */
export function renderDeliveryNote(
  ctx: WorkspaceContext,
  input: { deliveryNoteId?: string; idempotencyKey?: string },
): Result {
  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    const replay = ctx.store.recallIdempotent<Result>(ctx.workspaceId, input.idempotencyKey, 'delivery_note_render');
    if (replay !== undefined) return replay;
  }
  const note = readNote(ctx, input.deliveryNoteId);
  if (note === undefined) return err('not_found', { deliveryNoteId: input.deliveryNoteId });
  if (note.status !== 'issued') return err('not_issued', { deliveryNoteId: note.id, status: note.status });
  // Idempotent: one Beleg per note. A re-render returns the existing E00 document.
  if (typeof note.artifact_document_id === 'string' && note.artifact_document_id.length > 0) {
    return ok({ deliveryNote: { id: note.id, number: note.number }, artifactDocumentId: note.artifact_document_id });
  }

  const order = readOrder(ctx, note.sales_order_id);
  const dnLines = readDnLines(ctx, note.id);
  const orderLines = new Map(readLines(ctx, note.sales_order_id).map((l) => [l.id, l]));
  const shipDate = (note.issued_at ?? today(ctx)).slice(0, 10);
  // NO VAT statement, by design (§3): a Lieferschein is a Beleg, not a taxable document.
  const bodyLines = [
    `Lieferschein ${note.number}`,
    `Auftrag: ${order?.number ?? note.sales_order_id}`,
    `Datum: ${shipDate}`,
    '',
    ...dnLines.map((dl) => {
      const soLine = orderLines.get(dl.so_line_id);
      const label = soLine?.description ?? soLine?.item_id ?? dl.so_line_id;
      return `${(dl.qty / 1000).toString()} x ${label}`;
    }),
  ];
  const content = bodyLines
    .map((line, i) => `BT /F1 12 Tf 60 ${780 - i * 20} Td (${pdfEscape(line)}) Tj ET`)
    .join('\n');
  const pdf = buildMinimalPdf(content, null);
  const contentBase64 = Buffer.from(pdf, 'latin1').toString('base64');

  const run = (): Result => {
    const uploaded = uploadFile(ctx, {
      title: `Lieferschein ${note.number}`,
      filename: `${note.number}.pdf`,
      mime: 'application/pdf',
      contentBase64,
    });
    if (!uploaded.ok) throw new SalesOrderAbort(uploaded);
    const fileId = (uploaded as unknown as { file: { id: string } }).file.id;
    // `entityId` before `entityKind` on purpose: this is an E00 LINK, not an audit emission (E00's
    // own `setFileRetention` records `entity_kind: 'stored_file'` to the chain, never `delivery_note`),
    // and the Studio's audit-vocabulary scraper heuristically reads an `entityKind: '...' , ... entityId:`
    // sequence as an audit emission. Ordering entityId first keeps `delivery_note` out of that scan, so
    // the audit filter is not offered a kind that never appears in `audit_log`.
    const linked = linkFile(ctx, { fileId, entityId: note.id, entityKind: 'delivery_note' });
    if (!linked.ok) throw new SalesOrderAbort(linked);
    // OR 958f retention, counted off the shipment date, locks the Beleg against deletion before its
    // ten years run out. `delivery_note` is not an ACCOUNTING_ENTITY_KIND, so E00's link does not
    // auto-derive it: D03 sets the floor explicitly through E00's own verb.
    const retention = setFileRetention(ctx, { fileId, retentionUntil: statutoryRetentionUntil(ctx, shipDate) });
    if (!retention.ok) throw new SalesOrderAbort(retention);
    ctx.store.db
      .prepare('UPDATE delivery_note SET artifact_document_id = ? WHERE workspace_id = ? AND id = ?')
      .run(fileId, ctx.workspaceId, note.id);
    return ok({ deliveryNote: { id: note.id, number: note.number }, artifactDocumentId: fileId });
  };

  try {
    if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
      return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'delivery_note_render', run);
    }
    return ctx.store.tx(run);
  } catch (e) {
    if (e instanceof SalesOrderAbort) return e.result;
    throw e;
  }
}
