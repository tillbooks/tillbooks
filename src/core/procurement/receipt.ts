/**
 * I02, the GOODS RECEIPT: the first-class, reversible, inspection-aware document that records what
 * physically arrived against a D02/I01 purchase order (Wave 14, cluster I).
 *
 * WHAT THIS FILE MAY AND MAY NOT DO (OP13 / §H-STOCK-AUDIT):
 *  - It NEVER writes `stock_movement` itself and NEVER writes a quantity column on `item`,
 *    `stock_location`, `lot` or `serial`. Every physical quantity change goes through J02's
 *    `inventoryMove`, which is the single write path for on-hand, and on-hand stays the pure SUM of
 *    movements.
 *  - It NEVER posts a journal entry (P3). Inventory valuation flows J03 -> J06 -> A02 and input tax
 *    arises on the A17 vendor bill, never on the physical receipt.
 *  - It DOES own `po_line.received_qty`, jointly with D02's `receipt_record`, and it maintains the
 *    shared received-quantity trail (`goods_receipt` / `goods_receipt_line`, D02's tables) so that
 *    `SUM(trail.qty for a po_line) == po_line.received_qty` stays true whichever writer produced the
 *    row. `costing.ts` (B03) re-derives a dated received quantity from exactly that trail; an I02
 *    receipt that skipped it would make B03's `asOf` figure silently wrong. See `receiptSchema.ts`.
 *
 * THE MONEY-PATH INVARIANTS THIS FILE HOLDS (asserted in `test/procurement/receipt.test.mjs`):
 *  (a) IDEMPOTENT ON ROWS. Every mutating verb rides `runTx`, so a replay under the same key returns
 *      the stored result and writes NOTHING: exactly one document, exactly one set of movements,
 *      exactly one set of trail rows. Independently of the key, the document's own status machine
 *      refuses a second post (`invalid_transition`), so a caller who forgets the key still cannot
 *      double-count stock.
 *  (b) APPEND-ONLY. A posted document is never edited. A correction is a REVERSAL: compensating J02
 *      `return` movements of equal magnitude and opposite sign, negative trail rows, and a
 *      `received_qty` rollback. The original document, its movements and its trail rows all stay
 *      permanently visible and linked (§H-AUDIT). The decision trail
 *      (`goods_receipt_doc_event`) is insert-only.
 *  (c) NO SILENT CLAMP, and NO SILENT ACCEPT (owner decision, 11.08.2026). An over-delivery is
 *      ACCEPTED at its full quantity by default and RECORDED as an exception: the excess on the
 *      line (`over_receipt_qty`), a flag on the header that `goods_receipt_list` filters on, and an
 *      append-only `over_receipt` event naming who took how many extra units against what was open.
 *      A workspace that wants a hard ceiling still gets one (`allowOverReceipt` false refuses at the
 *      open quantity with `qty_exceeds_open`; an `overReceiptPct` refuses above the tolerance with
 *      `over_receipt`), and above the ceiling the WHOLE receipt rolls back. What never happens, in
 *      either posture, is the quantity quietly becoming something other than what arrived.
 *  (d) §H-PERIOD, AGAINST THE PERIOD THE RECEIPT BELONGS TO. Every movement is stamped with the
 *      document's own stored `received_at`, and `create` / `post` / `accept_lines` / `reverse` each
 *      assert that period is open. There is deliberately NO date parameter on post, accept or
 *      reverse: a sealed year cannot be back-charged by moving the posting date into an open one,
 *      and a sealed period's stock history cannot be un-received either. Correcting a sealed period
 *      needs the A03 unlock, which is an owner-gated act.
 *  (e) §H-TENANT. Every read and every write is scoped by `workspace_id`, including the PO, the PO
 *      lines, the item, the location and the trail.
 *  (f) ATOMICITY. `runTx` has COMMIT-ON-OK semantics (D02's `poShared.ts`): a rejection anywhere,
 *      including one returned by J02 several lines in, THROWS and rolls the whole receipt back. A
 *      partially posted receipt would be corrupt stock truth, so no path here can produce one.
 *
 * PO STATUS AFTER A REVERSAL (owner decision, 11.08.2026). D02's transition table gained a
 * `received -> sent` edge, so a fully received order whose receipt is reversed walks BACK to `sent`
 * and the status tells the truth again. `syncPoStatus` below is the one place that runs, in both
 * directions, and it always asks `isPoTransitionAllowed` first, so D02's enum stays the authority.
 * `goods_receipt_create` still admits a `received` order, but for a different reason now: I01's
 * `po_amendment_apply` may RAISE an ordered quantity on a `received` PO without touching its status,
 * so `nothing_open` rather than the status is what really governs whether anything can be received.
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { runTx, readPo, readPoLines, poNotFound } from '../purchase/poShared.js';
import type { PoLineRow } from '../purchase/poShared.js';
import { isPoTransitionAllowed } from '../purchase/poEnums.js';
import { inventoryMove } from '../inventory/movement.js';
import { ensureDefaultLocation } from '../inventory/defaults.js';
import { applySavedView } from '../customization/views.js';
import {
  GOODS_RECEIPT_STATUSES,
  RECEIPT_DRAFT_INSPECTION_STATUSES,
  RECOGNISED_INSPECTION_STATUSES,
  RECEIPT_SOURCE_DOCUMENT_TYPE,
  isReceiptInspectionStatus,
  isReceiptLineOp,
} from './receiptEnums.js';
import type { GoodsReceiptStatus, ReceiptEventType, ReceiptInspectionStatus } from './receiptEnums.js';

const WRITE_CAP = 'manage_master_data';
const READ_CAP = 'read_master_data';

// --- rows and their wire shapes ----------------------------------------------------------------

interface DocRow {
  id: string;
  workspace_id: string;
  number: string;
  status: GoodsReceiptStatus;
  po_id: string;
  supplier_contact_id: string;
  received_at: string;
  expected_at: string | null;
  default_location_id: string | null;
  note: string | null;
  created_at: string;
  created_by: string | null;
  updated_at: string;
  posted_at: string | null;
  posted_by: string | null;
  reversed_at: string | null;
  reversed_by: string | null;
  idempotency_key: string | null;
  has_over_receipt: number;
  cancelled_at: string | null;
  cancel_reason: string | null;
}

interface LineRow {
  id: string;
  workspace_id: string;
  gr_id: string;
  po_id: string;
  po_line_id: string;
  item_id: string | null;
  description: string | null;
  line_no: number;
  qty: number;
  unit_cost_rappen: number;
  location_id: string | null;
  lot_id: string | null;
  serial_id: string | null;
  inspection_status: ReceiptInspectionStatus;
  movement_id: string | null;
  trail_line_id: string | null;
  reversal_movement_id: string | null;
  reversal_trail_line_id: string | null;
  billed_qty: number;
  over_receipt_qty: number;
  note: string | null;
  recognised_at: string | null;
  rejected_at: string | null;
  reject_reason: string | null;
}

function mapDoc(r: DocRow): Record<string, unknown> {
  return {
    id: r.id,
    number: r.number,
    status: r.status,
    poId: r.po_id,
    supplierContactId: r.supplier_contact_id,
    receivedAt: r.received_at,
    expectedAt: r.expected_at,
    defaultLocationId: r.default_location_id,
    note: r.note,
    createdAt: r.created_at,
    createdBy: r.created_by,
    updatedAt: r.updated_at,
    postedAt: r.posted_at,
    postedBy: r.posted_by,
    reversedAt: r.reversed_at,
    reversedBy: r.reversed_by,
    hasOverReceipt: r.has_over_receipt === 1,
    cancelledAt: r.cancelled_at,
    cancelReason: r.cancel_reason,
  };
}

function mapLine(r: LineRow): Record<string, unknown> {
  return {
    id: r.id,
    grId: r.gr_id,
    poId: r.po_id,
    poLineId: r.po_line_id,
    itemId: r.item_id,
    description: r.description,
    lineNo: r.line_no,
    qty: r.qty,
    unitCostRappen: r.unit_cost_rappen,
    locationId: r.location_id,
    lotId: r.lot_id,
    serialId: r.serial_id,
    inspectionStatus: r.inspection_status,
    movementId: r.movement_id,
    trailLineId: r.trail_line_id,
    reversalMovementId: r.reversal_movement_id,
    reversalTrailLineId: r.reversal_trail_line_id,
    billedQty: r.billed_qty,
    overReceiptQty: r.over_receipt_qty,
    note: r.note,
    recognisedAt: r.recognised_at,
    rejectedAt: r.rejected_at,
    rejectReason: r.reject_reason,
  };
}

// --- tenant-scoped reads -----------------------------------------------------------------------

function readDoc(ctx: WorkspaceContext, id: unknown): DocRow | undefined {
  if (typeof id !== 'string' || id.length === 0) return undefined;
  return ctx.store.db
    .prepare('SELECT * FROM goods_receipt_doc WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, id) as DocRow | undefined;
}

function readDocLines(ctx: WorkspaceContext, grId: string): LineRow[] {
  return ctx.store.db
    .prepare('SELECT * FROM goods_receipt_doc_line WHERE workspace_id = ? AND gr_id = ? ORDER BY line_no, id')
    .all(ctx.workspaceId, grId) as LineRow[];
}

function readEvents(ctx: WorkspaceContext, grId: string): Record<string, unknown>[] {
  const rows = ctx.store.db
    .prepare(
      `SELECT id, line_id, event_type, reason, actor, created_at
         FROM goods_receipt_doc_event WHERE workspace_id = ? AND gr_id = ? ORDER BY created_at, id`,
    )
    .all(ctx.workspaceId, grId) as {
    id: string;
    line_id: string | null;
    event_type: string;
    reason: string | null;
    actor: string | null;
    created_at: string;
  }[];
  return rows.map((e) => ({
    id: e.id,
    lineId: e.line_id,
    eventType: e.event_type,
    reason: e.reason,
    actor: e.actor,
    createdAt: e.created_at,
  }));
}

interface ItemStockRow {
  id: string;
  track_stock: number;
  tracking_mode: string;
}

function readItemStock(ctx: WorkspaceContext, itemId: string | null): ItemStockRow | undefined {
  if (itemId === null) return undefined;
  return ctx.store.db
    .prepare('SELECT id, track_stock, tracking_mode FROM item WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, itemId) as ItemStockRow | undefined;
}

/**
 * A READ-ONLY MIRROR of J02's own `validateTracking`, for the preview alone.
 *
 * J02 keeps that function private to `movement.ts`, which is not I02's module to widen, so the
 * preview cannot call it. The mirror exists because the alternative is worse: `goodsReceiptPreview`
 * promises "the exact rejection codes a post would refuse with", and a lot-tracked item with no lot
 * previewed `postable:true` and then failed at post with `lot_required`. That is the one thing a
 * preview must never do.
 *
 * THE AUTHORITY IS STILL J02, at post, inside the transaction. Nothing here decides anything: it
 * only predicts. The drift risk that comes with any mirror is answered by the test rather than by
 * hope, `test/procurement/receipt.test.mjs` drives BOTH the preview and the post for every one of
 * these codes and asserts they name the SAME one, so a change to J02's rules reddens this file.
 */
function previewTrackingIssue(
  ctx: WorkspaceContext,
  item: ItemStockRow,
  lotId: string | null,
  serialId: string | null,
  qty: number,
): string | undefined {
  // ORDER IS LOAD-BEARING. `inventoryMove` runs `validateMoveInput` BEFORE `validateTracking`, so
  // when a line trips both (a serial line of quantity 2 on a lot-tracked item with no lot) the post
  // names `invalid_qty`, not `lot_required`. Predicting them the other way round would make this
  // mirror name a code the post does not, which is the same broken promise in the other direction.
  //
  // This rule was the gap that mattered: `goods_receipt_upsert_lines` accepts any integer above
  // zero, so a serial line of 2 sat on the draft, previewed clean, and failed at post. The new
  // serial field in the drawer made it MORE reachable, because the operator mints a serial and
  // leaves the quantity at the open quantity.
  if (serialId !== null && Math.abs(qty) !== 1) return 'invalid_qty';
  const mode = item.tracking_mode;
  if ((mode === 'lot' || mode === 'lot_and_serial') && lotId === null) return 'lot_required';
  if ((mode === 'serial' || mode === 'lot_and_serial') && serialId === null) return 'serial_required';
  if (lotId !== null) {
    const lot = ctx.store.db
      .prepare('SELECT item_id FROM lot WHERE workspace_id = ? AND id = ?')
      .get(ctx.workspaceId, lotId) as { item_id: string } | undefined;
    // UNREACHABLE in practice, and deliberately left in rather than dropped: `trackingRefExists` in
    // `goods_receipt_upsert_lines` already refuses an unknown or foreign id with `invalid_reference`
    // at line entry, so no draft can carry one. It mirrors J02 rule for rule anyway, because a
    // mirror with a hole in it is worth less than the line it saves. Not tested, because a test
    // would have to fabricate a row the write path cannot produce.
    if (lot === undefined) return 'not_found';
    if (lot.item_id !== item.id) return 'lot_item_mismatch';
  }
  if (serialId !== null) {
    const serial = ctx.store.db
      .prepare('SELECT item_id, lot_id FROM serial WHERE workspace_id = ? AND id = ?')
      .get(ctx.workspaceId, serialId) as { item_id: string; lot_id: string | null } | undefined;
    if (serial === undefined) return 'not_found'; // unreachable, see above
    if (serial.item_id !== item.id) return 'serial_item_mismatch';
    // A serial that carries a lot must move with THAT lot, so the two projections cannot disagree.
    if (lotId !== null && serial.lot_id !== null && serial.lot_id !== lotId) return 'lot_item_mismatch';
  }
  return undefined;
}

function locationExists(ctx: WorkspaceContext, locationId: string): boolean {
  return (
    ctx.store.db
      .prepare('SELECT 1 FROM stock_location WHERE workspace_id = ? AND id = ? AND archived = 0')
      .get(ctx.workspaceId, locationId) !== undefined
  );
}

/**
 * A tenant-scoped existence check for a J01 lot or serial named on a draft line.
 *
 * WHY THE DRAFT CHECKS THESE AT ALL, when J02 validates them again at post. Two reasons, and the
 * second is the one that matters. An unchecked id reached the INSERT and tripped the table's foreign
 * key, so an agent naming a typo'd lot got `unexpected_error` with "FOREIGN KEY constraint failed"
 * out of the generic throw guard instead of a structured rejection it could act on. And a lot
 * belonging to ANOTHER workspace satisfies that foreign key perfectly well, so it was accepted onto
 * the draft and only refused later, at post, by J02's own tenant scoping (§H-TENANT held, but the
 * foreign row sat on the document until then). The `mode` mismatch, the item ownership and the
 * required-when-tracked rules stay J02's, checked at the moment stock actually moves.
 */
function trackingRefExists(ctx: WorkspaceContext, table: 'lot' | 'serial', id: string): boolean {
  // `table` is a closed union, never caller input, so this interpolation cannot carry SQL.
  return ctx.store.db.prepare(`SELECT 1 FROM ${table} WHERE workspace_id = ? AND id = ?`).get(ctx.workspaceId, id) !== undefined;
}

// --- the over-receipt policy -------------------------------------------------------------------

export interface ReceiptConfig {
  allowOverReceipt: boolean;
  /** NULL means NO CAP. A number is an integer percentage of the ORDERED quantity. */
  overReceiptPct: number | null;
}

/**
 * The workspace over-receipt posture (owner decision, 11.08.2026). An absent row means the default:
 * ACCEPT an over-delivery and flag it, with no percentage cap. That default is deliberate. Blocking a
 * receipt at the loading dock does not un-deliver the goods, it only stops the ledger from saying
 * they arrived, and a discrepancy that is recorded is one a buyer can act on while a refusal is one
 * somebody works around. A workspace that genuinely wants a hard ceiling sets `allowOverReceipt`
 * false (block at the ordered quantity) or names an `overReceiptPct` (block above the tolerance).
 */
export function readReceiptConfig(ctx: WorkspaceContext): ReceiptConfig {
  const row = ctx.store.db
    .prepare('SELECT allow_over_receipt, over_receipt_pct FROM goods_receipt_config WHERE workspace_id = ?')
    .get(ctx.workspaceId) as { allow_over_receipt: number; over_receipt_pct: number | null } | undefined;
  if (row === undefined) return { allowOverReceipt: true, overReceiptPct: null };
  return { allowOverReceipt: row.allow_over_receipt === 1, overReceiptPct: row.over_receipt_pct };
}

/**
 * The open quantity, and the ceiling above which a receipt is REFUSED rather than flagged.
 *
 * `ceiling === null` means uncapped: anything above `open` is accepted and recorded as an exception.
 * `Math.floor` on the tolerance so a percentage can never round UP into a quantity the policy did not
 * grant, and integer arithmetic throughout (P2's discipline applied to quantity).
 */
function receiveCeiling(
  ordered: number,
  received: number,
  cfg: ReceiptConfig,
): { open: number; ceiling: number | null } {
  const open = ordered - received;
  if (!cfg.allowOverReceipt) return { open, ceiling: open };
  if (cfg.overReceiptPct === null || cfg.overReceiptPct <= 0) return { open, ceiling: null };
  return { open, ceiling: open + Math.floor((ordered * cfg.overReceiptPct) / 100) };
}

/**
 * The rejection an over-quantity earns, or undefined when it is accepted (and therefore FLAGGED).
 * Kept in one place so the preview reports exactly what the post would refuse with.
 */
function overQuantityRefusal(qty: number, ceiling: number | null, cfg: ReceiptConfig): string | undefined {
  if (ceiling === null || qty <= ceiling) return undefined;
  return cfg.allowOverReceipt ? 'over_receipt' : 'qty_exceeds_open';
}

// --- numbering and the append-only event trail -------------------------------------------------

/** A gap-free per-year series, the I00 / A10 numbering shape: GR-YYYY-NNNN. */
function nextNumber(ctx: WorkspaceContext): string {
  const year = ctx.clock.now().slice(0, 4);
  const prefix = `GR-${year}-`;
  const row = ctx.store.db
    .prepare('SELECT number FROM goods_receipt_doc WHERE workspace_id = ? AND number LIKE ? ORDER BY number DESC LIMIT 1')
    .get(ctx.workspaceId, `${prefix}%`) as { number: string } | undefined;
  const last = row === undefined ? 0 : Number.parseInt(row.number.slice(prefix.length), 10);
  return `${prefix}${String(last + 1).padStart(4, '0')}`;
}

/**
 * The A03 audit ACTION each I02 event maps to. The document's own `event_type` vocabulary is I02's
 * (it names line-level decisions the audit chain has no word for), but the hash-chained log speaks
 * the shared vocabulary in `app/src/surfaces/Periods/audit-vocabulary.ts`, and every word below
 * already means there exactly what it means here. Minting `received` / `accepted` synonyms would
 * split that vocabulary for no gain.
 */
const AUDIT_ACTION_FOR_EVENT: Record<ReceiptEventType, string> = {
  created: 'create',
  line_changed: 'update',
  posted: 'post',
  accepted: 'approve',
  rejected: 'reject',
  reversed: 'reverse',
  cancelled: 'cancel',
  // A25's word, and it is the right one: nothing is undone and nothing is refused, the receipt is
  // merely marked as carrying a discrepancy until somebody deals with the supplier.
  over_receipt: 'flag',
};

function recordEvent(
  ctx: WorkspaceContext,
  grId: string,
  lineId: string | null,
  eventType: ReceiptEventType,
  reason: string | null,
): void {
  ctx.store.db
    .prepare(
      `INSERT INTO goods_receipt_doc_event (id, workspace_id, gr_id, line_id, event_type, reason, actor, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(ctx.ids.next('grev'), ctx.workspaceId, grId, lineId, eventType, reason, ctx.actor, ctx.clock.now());
  // §H-AUDIT also reaches A03's hash-chained log, so a receipt shows up in the audit trail beside the
  // documents it will later be matched against.
  ctx.audit.record({
    entityKind: 'goods_receipt',
    entityId: grId,
    action: AUDIT_ACTION_FOR_EVENT[eventType],
    actor: ctx.actor,
    at: ctx.clock.now(),
  });
}

function touchDoc(ctx: WorkspaceContext, grId: string): void {
  ctx.store.db
    .prepare('UPDATE goods_receipt_doc SET updated_at = ? WHERE workspace_id = ? AND id = ?')
    .run(ctx.clock.now(), ctx.workspaceId, grId);
}

// --- the shared received-quantity trail (D02's goods_receipt / goods_receipt_line) --------------

/**
 * Open one trail HEADER for a recognition (or reversal) batch. D02's `goods_receipt` is the table
 * `costing.ts` dates a project's received quantity from and `purchaseOrders.ts` lists a PO's receipts
 * off, so an I02 recognition appends to it rather than living beside it. `received_at` is the
 * document's own date, never "now", so the dated derivation and the movement agree.
 */
function openTrailHeader(ctx: WorkspaceContext, doc: DocRow, locationId: string, label: string): string {
  const trailId = ctx.ids.next('rcpt');
  ctx.store.db
    .prepare(
      `INSERT INTO goods_receipt (id, workspace_id, po_id, location_id, received_at, note, idempotency_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(trailId, ctx.workspaceId, doc.po_id, locationId, doc.received_at, `${label} ${doc.number}`, null, ctx.clock.now());
  return trailId;
}

/** One trail LINE. `qty` is signed: positive on recognition, negative on the compensating reversal. */
function appendTrailLine(
  ctx: WorkspaceContext,
  trailId: string,
  poLineId: string,
  qty: number,
  movementId: string | null,
): string {
  const id = ctx.ids.next('rcptl');
  ctx.store.db
    .prepare(
      `INSERT INTO goods_receipt_line (id, workspace_id, receipt_id, po_line_id, qty, stock_movement_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(id, ctx.workspaceId, trailId, poLineId, qty, movementId);
  return id;
}

// --- input validation --------------------------------------------------------------------------

function requireKey(idempotencyKey: unknown): Result | undefined {
  if (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0) {
    return err('invalid_input', { field: 'idempotencyKey' });
  }
  return undefined;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// --- goods_receipt_create ----------------------------------------------------------------------

export interface GoodsReceiptCreateInput {
  poId?: string;
  receivedAt?: string;
  expectedAt?: string | null;
  defaultLocationId?: string | null;
  note?: string | null;
  idempotencyKey?: string;
}

/**
 * Open a DRAFT goods receipt against an open purchase order (US-I02.1). Nothing physical happens
 * here: no movement, no PO quantity change. The `received_at` given here is THE date the whole
 * document will later post at, so the period guard runs now as well as at post: a draft that could
 * never be posted is a trap, not a convenience.
 */
export function goodsReceiptCreate(ctx: WorkspaceContext, input: GoodsReceiptCreateInput): Result {
  const capable = ctx.capabilities.assert(WRITE_CAP);
  if (!capable.ok) return capable;
  const keyErr = requireKey(input.idempotencyKey);
  if (keyErr !== undefined) return keyErr;

  const run = (): Result => {
    const po = readPo(ctx, input.poId);
    if (po === undefined) return poNotFound(input.poId);
    // `sent` is the normal state. `received` is STILL admissible, and the reason changed on
    // 11.08.2026: a reversal now walks the order back to `sent` itself (the widened D02 edge), so
    // that is no longer why. What remains is I01: `po_amendment_apply` may RAISE an ordered quantity
    // on a PO whose status is already `received` and does not touch the status, so a `received` order
    // can legitimately carry open quantity. `nothing_open` below is what actually governs; the status
    // check only keeps a draft, closed or cancelled order out.
    if (po.status !== 'sent' && po.status !== 'received') {
      return err('invalid_transition', { poId: po.id, status: po.status });
    }

    const receivedAt = typeof input.receivedAt === 'string' ? input.receivedAt.slice(0, 10) : '';
    if (!DATE_RE.test(receivedAt)) return err('invalid_input', { field: 'receivedAt' });
    const expectedAt =
      typeof input.expectedAt === 'string' && input.expectedAt.length > 0 ? input.expectedAt.slice(0, 10) : null;
    if (expectedAt !== null && !DATE_RE.test(expectedAt)) return err('invalid_input', { field: 'expectedAt' });

    // §H-PERIOD (d): the period the receipt BELONGS to, checked from the document's own date.
    const periodOpen = ctx.periods.assertOpen(receivedAt);
    if (!periodOpen.ok) return periodOpen;

    const lines = readPoLines(ctx, po.id);
    if (!lines.some((l) => l.qty - l.received_qty > 0)) return err('nothing_open', { poId: po.id });

    let locationId: string;
    if (typeof input.defaultLocationId === 'string' && input.defaultLocationId.length > 0) {
      if (!locationExists(ctx, input.defaultLocationId)) {
        return err('invalid_reference', { locationId: input.defaultLocationId });
      }
      locationId = input.defaultLocationId;
    } else {
      // A single-location workspace never has to name one: J00's race-safe MAIN / DEFAULT pair is
      // seated on demand, exactly as D01's `stock_move` defaults an omitted location.
      locationId = ensureDefaultLocation(ctx).locationId;
    }

    const id = ctx.ids.next('grdoc');
    const now = ctx.clock.now();
    ctx.store.db
      .prepare(
        `INSERT INTO goods_receipt_doc
           (id, workspace_id, number, status, po_id, supplier_contact_id, received_at, expected_at,
            default_location_id, note, created_at, created_by, updated_at, idempotency_key)
         VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        ctx.workspaceId,
        nextNumber(ctx),
        po.id,
        po.supplier_contact_id,
        receivedAt,
        expectedAt,
        locationId,
        input.note ?? null,
        now,
        ctx.actor,
        now,
        input.idempotencyKey ?? null,
      );
    recordEvent(ctx, id, null, 'created', null);
    return ok(detailOf(ctx, id));
  };

  return runTx(ctx, 'goods_receipt_create', input.idempotencyKey, run);
}

/** The document + its lines + its append-only decision trail: the one shape every write returns. */
function detailOf(ctx: WorkspaceContext, grId: string): Record<string, unknown> {
  const doc = readDoc(ctx, grId) as DocRow;
  return {
    goodsReceipt: {
      ...mapDoc(doc),
      lines: readDocLines(ctx, grId).map(mapLine),
      events: readEvents(ctx, grId),
    },
  };
}

// --- goods_receipt_upsert_lines ----------------------------------------------------------------

export interface ReceiptLineOpInput {
  op?: string;
  lineId?: string;
  poLineId?: string;
  qty?: number;
  locationId?: string | null;
  lotId?: string | null;
  serialId?: string | null;
  unitCostRappen?: number;
  inspectionStatus?: string;
  note?: string | null;
}

export interface GoodsReceiptUpsertLinesInput {
  grId?: string;
  ops?: ReceiptLineOpInput[];
  idempotencyKey?: string;
}

/**
 * Add, change or remove draft lines (US-I02.2). DRAFT ONLY: a posted document is immutable, and the
 * correction for a posted mistake is a reversal, never an edit (invariant b). Line-level validation
 * that depends on the LIVE purchase order (open quantity, over-receipt) is deliberately NOT binding
 * here: it is what `goods_receipt_preview` reports and what `goods_receipt_post` enforces against the
 * order as it stands at the moment stock actually moves.
 */
export function goodsReceiptUpsertLines(ctx: WorkspaceContext, input: GoodsReceiptUpsertLinesInput): Result {
  const capable = ctx.capabilities.assert(WRITE_CAP);
  if (!capable.ok) return capable;
  const keyErr = requireKey(input.idempotencyKey);
  if (keyErr !== undefined) return keyErr;

  const run = (): Result => {
    const doc = readDoc(ctx, input.grId);
    if (doc === undefined) return err('not_found', { grId: input.grId });
    if (doc.status !== 'draft') return err('invalid_transition', { grId: doc.id, status: doc.status });

    const ops = Array.isArray(input.ops) ? input.ops : [];
    if (ops.length === 0) return err('invalid_input', { field: 'ops' });

    const poLines = new Map(readPoLines(ctx, doc.po_id).map((l) => [l.id, l]));
    const existing = new Map(readDocLines(ctx, doc.id).map((l) => [l.id, l]));
    let nextLineNo = readDocLines(ctx, doc.id).reduce((m, l) => Math.max(m, l.line_no), 0) + 1;

    for (const op of ops) {
      if (!isReceiptLineOp(op.op)) return err('invalid_input', { field: 'op', op: op.op });

      if (op.op === 'remove') {
        const line = typeof op.lineId === 'string' ? existing.get(op.lineId) : undefined;
        if (line === undefined) return err('not_found', { lineId: op.lineId });
        ctx.store.db
          .prepare('DELETE FROM goods_receipt_doc_line WHERE workspace_id = ? AND id = ?')
          .run(ctx.workspaceId, line.id);
        existing.delete(line.id);
        recordEvent(ctx, doc.id, line.id, 'line_changed', 'remove');
        continue;
      }

      const inspection = op.inspectionStatus ?? 'none';
      if (!isReceiptInspectionStatus(inspection) || !RECEIPT_DRAFT_INSPECTION_STATUSES.includes(inspection)) {
        // `accepted` / `rejected` are DECISIONS with an actor attached, reachable only through the
        // accept / reject verbs. Letting one arrive as a data field would put a quality decision in
        // the document with nobody's name on it.
        return err('invalid_input', { field: 'inspectionStatus', inspectionStatus: op.inspectionStatus });
      }

      if (typeof op.qty !== 'number' || !Number.isInteger(op.qty) || op.qty <= 0) {
        return err('invalid_qty', { qty: op.qty });
      }
      if (op.unitCostRappen !== undefined && (!Number.isInteger(op.unitCostRappen) || op.unitCostRappen < 0)) {
        return err('invalid_input', { field: 'unitCostRappen' });
      }

      let locationId: string | null;
      if (typeof op.locationId === 'string' && op.locationId.length > 0) {
        if (!locationExists(ctx, op.locationId)) return err('invalid_reference', { locationId: op.locationId });
        locationId = op.locationId;
      } else {
        locationId = doc.default_location_id;
      }

      // The J01 references get the same treatment as the location, and for the same two reasons: an
      // unknown id is ordinary bad input and deserves a structured refusal rather than a foreign-key
      // throw, and a lot or serial from ANOTHER workspace satisfies the foreign key and must not be
      // storable on this document (§H-TENANT at the point of entry, not only at post).
      const lotId = op.lotId ?? null;
      if (lotId !== null && !trackingRefExists(ctx, 'lot', lotId)) return err('invalid_reference', { lotId });
      const serialId = op.serialId ?? null;
      if (serialId !== null && !trackingRefExists(ctx, 'serial', serialId)) return err('invalid_reference', { serialId });

      if (op.op === 'change') {
        const line = typeof op.lineId === 'string' ? existing.get(op.lineId) : undefined;
        if (line === undefined) return err('not_found', { lineId: op.lineId });
        ctx.store.db
          .prepare(
            `UPDATE goods_receipt_doc_line
                SET qty = ?, location_id = ?, lot_id = ?, serial_id = ?, unit_cost_rappen = ?,
                    inspection_status = ?, note = ?
              WHERE workspace_id = ? AND id = ?`,
          )
          .run(
            op.qty,
            locationId,
            lotId,
            serialId,
            op.unitCostRappen ?? line.unit_cost_rappen,
            inspection,
            op.note ?? line.note,
            ctx.workspaceId,
            line.id,
          );
        recordEvent(ctx, doc.id, line.id, 'line_changed', 'change');
        continue;
      }

      // add
      const poLine = typeof op.poLineId === 'string' ? poLines.get(op.poLineId) : undefined;
      if (poLine === undefined) return err('invalid_reference', { poLineId: op.poLineId });
      const id = ctx.ids.next('grln');
      ctx.store.db
        .prepare(
          `INSERT INTO goods_receipt_doc_line
             (id, workspace_id, gr_id, po_id, po_line_id, item_id, description, line_no, qty,
              unit_cost_rappen, location_id, lot_id, serial_id, inspection_status, billed_qty, note)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
        )
        .run(
          id,
          ctx.workspaceId,
          doc.id,
          doc.po_id,
          poLine.id,
          poLine.item_id,
          poLine.description,
          nextLineNo,
          op.qty,
          // The CHF BASE unit price (§H-FX), so a foreign-currency PO values stock in one currency.
          op.unitCostRappen ?? poLine.unit_price_base_rappen,
          locationId,
          lotId,
          serialId,
          inspection,
          op.note ?? null,
        );
      nextLineNo += 1;
      recordEvent(ctx, doc.id, id, 'line_changed', 'add');
    }

    touchDoc(ctx, doc.id);
    return ok(detailOf(ctx, doc.id));
  };

  return runTx(ctx, 'goods_receipt_upsert_lines', input.idempotencyKey, run);
}

// --- goods_receipt_preview (PURE) --------------------------------------------------------------

/**
 * The impact preview (US-I02.2): what posting this draft WOULD do, evaluated against the live
 * purchase order. Writes nothing and is safe to call repeatedly. The `issues` arrays carry exactly
 * the codes `goods_receipt_post` would refuse with, so the Studio can disable Post for a stated
 * reason rather than letting a click fail: per line the quantity, location and J01 tracking
 * refusals, and on the document itself the §H-PERIOD one, which is not a property of any single
 * line. Both feed `postable`.
 *
 * THAT LAST SENTENCE USED TO BE FALSE, and the case is routine rather than exotic. Two doc lines
 * against ONE `po_line` (two lots, two locations, two serials from one delivery) were each evaluated
 * against the same stored `received_qty`, while `recogniseLines` re-reads `po_line` per line INSIDE
 * the transaction and therefore sees line one's increment before it judges line two. So a draft of
 * 5 + 5 against an open 8 previewed clean and posted `qty_exceeds_open`, and under the accept-and-flag
 * posture the same draft previewed no exception while the post recorded one. The post is right; the
 * preview was wrong. `consumed` below is the fix: a running per-`po_line_id` tally, applied in the
 * same line order the post uses, so the two agree line for line.
 */
export function goodsReceiptPreview(ctx: WorkspaceContext, input: { grId?: string }): Result {
  const capable = ctx.capabilities.assert(READ_CAP);
  if (!capable.ok) return capable;

  const doc = readDoc(ctx, input.grId);
  if (doc === undefined) return err('not_found', { grId: input.grId });

  const cfg = readReceiptConfig(ctx);
  const poLines = new Map(readPoLines(ctx, doc.po_id).map((l) => [l.id, l]));
  // §H-PERIOD is a DOCUMENT-level refusal, so it is reported on the document rather than per line:
  // a period sealed after the draft was opened makes the whole receipt unpostable, and a preview
  // that stayed `postable:true` through it was lying about exactly the guard invariant (d) exists
  // to hold.
  const periodOpen = ctx.periods.assertOpen(doc.received_at);
  const documentIssues: string[] = periodOpen.ok ? [] : ['period_locked'];
  // Same order as `readDocLines` gives `recogniseLines` (line_no, id), which is what makes the
  // cumulative tally below mirror the transaction rather than merely approximate it.
  const lines = readDocLines(ctx, doc.id);

  let valueRappen = 0;
  const consumed = new Map<string, number>();
  const rows = lines.map((line) => {
    const poLine = poLines.get(line.po_line_id);
    const ordered = poLine?.qty ?? 0;
    // What the order will have received by the time the post reaches THIS line: what is stored, plus
    // what the earlier lines of this same receipt have already taken off the same order line.
    const alreadyReceived = (poLine?.received_qty ?? 0) + (consumed.get(line.po_line_id) ?? 0);
    const { open, ceiling } = receiveCeiling(ordered, alreadyReceived, cfg);
    const recognises = RECOGNISED_INSPECTION_STATUSES.includes(line.inspection_status);
    const issues: string[] = [];
    const refusal = poLine === undefined || !recognises ? undefined : overQuantityRefusal(line.qty, ceiling, cfg);
    if (poLine === undefined) issues.push('invalid_reference');
    else if (refusal !== undefined) issues.push(refusal);
    const item = readItemStock(ctx, line.item_id);
    const stocked = item !== undefined && item.track_stock === 1;
    if (recognises && stocked && line.location_id === null) issues.push('location_required');
    // What J02 would refuse this movement with: a lot- or serial-tracked item missing its
    // identifier, or one naming a lot/serial that belongs to a different item. Predicted here so
    // Studio can say WHY Post is unavailable; decided for real by J02 at post.
    if (recognises && stocked && item !== undefined) {
      const trackingIssue = previewTrackingIssue(ctx, item, line.lot_id, line.serial_id, line.qty);
      if (trackingIssue !== undefined) issues.push(trackingIssue);
    }
    if (recognises) valueRappen += line.qty * line.unit_cost_rappen;
    // An over-delivery WITHIN the policy is not an issue: it posts, and it is recorded. `issues` is
    // reserved for what the post would actually refuse, so a Studio that greys out Post on a
    // non-empty `issues` stays correct without knowing the policy.
    const overQty = recognises && poLine !== undefined && refusal === undefined ? Math.max(line.qty - open, 0) : 0;
    // A line the post would REFUSE consumes nothing, because the post never gets past it: the whole
    // receipt rolls back. Anything it would recognise raises the tally for the lines behind it.
    if (recognises && poLine !== undefined && refusal === undefined) {
      consumed.set(line.po_line_id, (consumed.get(line.po_line_id) ?? 0) + line.qty);
    }
    return {
      lineId: line.id,
      poLineId: line.po_line_id,
      itemId: line.item_id,
      description: line.description,
      ordered,
      alreadyReceived,
      open,
      ceiling,
      proposed: line.qty,
      resultingReceived: recognises ? alreadyReceived + line.qty : alreadyReceived,
      unitCostRappen: line.unit_cost_rappen,
      inspectionStatus: line.inspection_status,
      // A non-stock or free-text line advances the ordered quantity and mints NO movement: there is
      // nothing physical to move (spec §2 US-I02.7).
      movesStock: recognises && stocked,
      overReceipt: overQty > 0,
      overReceiptQty: overQty,
      issues,
    };
  });

  return ok({
    grId: doc.id,
    number: doc.number,
    status: doc.status,
    receivedAt: doc.received_at,
    allowOverReceipt: cfg.allowOverReceipt,
    overReceiptPct: cfg.overReceiptPct,
    hasOverReceipt: doc.has_over_receipt === 1,
    valueRappen,
    lines: rows,
    issues: documentIssues,
    postable:
      doc.status === 'draft' && documentIssues.length === 0 && rows.length > 0 && rows.every((r) => r.issues.length === 0),
  });
}

// --- the shared recognition path (post + accept) ------------------------------------------------

/**
 * Recognise a set of lines: for each, write the J02 movement (when the item is stock-tracked), append
 * the shared trail row, and raise `po_line.received_qty`. The caller has already opened the
 * transaction, so a rejection returned from here rolls the whole thing back (invariant f).
 *
 * The idempotency key handed to J02 is derived from the LINE id, not from the caller's key, so even a
 * caller that reuses one key across two different receipts cannot make two lines collide, and a
 * replayed movement resolves to the same row (§H-IDEMPOTENT at the ledger layer as well as here).
 */
function recogniseLines(
  ctx: WorkspaceContext,
  doc: DocRow,
  lines: LineRow[],
  label: string,
): Result | undefined {
  if (lines.length === 0) return undefined;
  const cfg = readReceiptConfig(ctx);
  const trailLocation = doc.default_location_id ?? lines[0]?.location_id ?? null;
  if (trailLocation === null) return err('location_required', { grId: doc.id });
  const trailId = openTrailHeader(ctx, doc, trailLocation, label);
  const now = ctx.clock.now();

  for (const line of lines) {
    // The LIVE open quantity, re-read inside the transaction: a concurrent receipt against the same
    // PO line is serialised here, and the second caller is refused rather than silently clamped (c).
    const poLine = ctx.store.db
      .prepare('SELECT * FROM po_line WHERE workspace_id = ? AND id = ?')
      .get(ctx.workspaceId, line.po_line_id) as PoLineRow | undefined;
    if (poLine === undefined) return err('invalid_reference', { poLineId: line.po_line_id });
    const { open, ceiling } = receiveCeiling(poLine.qty, poLine.received_qty, cfg);
    // NO SILENT CLAMP, in either direction. Above the configured ceiling the whole receipt is
    // REFUSED and rolls back; below it an over-delivery is accepted at its FULL quantity and the
    // excess is recorded as an exception. What never happens is the quantity quietly becoming
    // something other than what arrived.
    const refusal = overQuantityRefusal(line.qty, ceiling, cfg);
    if (refusal !== undefined) {
      return err(refusal, {
        grId: doc.id,
        lineId: line.id,
        poLineId: poLine.id,
        open,
        ceiling,
        requested: line.qty,
      });
    }
    const overQty = Math.max(line.qty - open, 0);

    const item = readItemStock(ctx, line.item_id);
    let movementId: string | null = null;
    if (item !== undefined && item.track_stock === 1) {
      if (line.location_id === null) return err('location_required', { lineId: line.id });
      const moved = inventoryMove(ctx, {
        itemId: item.id,
        locationId: line.location_id,
        qty: line.qty,
        movementType: 'receipt',
        unitCostMinor: line.unit_cost_rappen,
        // (d): the document's own date, never "now" and never a caller-supplied one.
        effectiveDate: doc.received_at,
        lotId: line.lot_id,
        serialId: line.serial_id,
        sourceDocumentType: RECEIPT_SOURCE_DOCUMENT_TYPE,
        sourceDocumentId: doc.id,
        description: `${doc.number} ${line.description ?? ''}`.trim(),
        idempotencyKey: `gr:${line.id}:receipt`,
      });
      if (!moved.ok) return moved;
      movementId = ((moved as unknown as { movement: { id: string } }).movement.id ?? null) as string | null;
    }

    const trailLineId = appendTrailLine(ctx, trailId, poLine.id, line.qty, movementId);
    ctx.store.db
      .prepare('UPDATE po_line SET received_qty = received_qty + ? WHERE workspace_id = ? AND id = ?')
      .run(line.qty, ctx.workspaceId, poLine.id);
    ctx.store.db
      .prepare(
        `UPDATE goods_receipt_doc_line
            SET movement_id = ?, trail_line_id = ?, recognised_at = ?, over_receipt_qty = ?,
                inspection_status = CASE WHEN inspection_status = 'pending' THEN 'accepted' ELSE inspection_status END
          WHERE workspace_id = ? AND id = ?`,
      )
      .run(movementId, trailLineId, now, overQty, ctx.workspaceId, line.id);

    // The exception is a STORED, QUERYABLE fact, not a warning that scrolls past: the quantity on
    // the line, the flag on the header (which `goods_receipt_list` filters on and the Studio badges),
    // and an append-only event naming who accepted how many extra units against what was open.
    if (overQty > 0) {
      ctx.store.db
        .prepare('UPDATE goods_receipt_doc SET has_over_receipt = 1 WHERE workspace_id = ? AND id = ?')
        .run(ctx.workspaceId, doc.id);
      recordEvent(ctx, doc.id, line.id, 'over_receipt', `+${overQty} über offene Menge ${open} (bestellt ${poLine.qty})`);
    }
  }

  syncPoStatus(ctx, doc.po_id);
  return undefined;
}

/**
 * Keep `purchase_order.status` in step with what the LINES actually say, in both directions.
 *
 *  - `sent -> received` once every line is fully received: the D02 `receipt_record` rule, unchanged.
 *  - `received -> sent` when a reversal has left a line short again (owner decision, 11.08.2026,
 *    the D02 transition table widened for exactly this). Without it the column claimed `received`
 *    while the lines said otherwise, and every reader of that column, including the 3-way match's
 *    own `sent|received` admission, was reading a stale claim.
 *
 * Both directions consult `isPoTransitionAllowed`, so D02's table stays the single §H-ENUM authority
 * and this function can never invent an edge the enum does not admit.
 */
function syncPoStatus(ctx: WorkspaceContext, poId: string): void {
  const po = readPo(ctx, poId);
  if (po === undefined) return;
  const lines = readPoLines(ctx, poId);
  if (lines.length === 0) return;
  const fullyReceived = lines.every((l) => l.received_qty >= l.qty);
  const target = po.status === 'sent' && fullyReceived ? 'received' : po.status === 'received' && !fullyReceived ? 'sent' : undefined;
  if (target === undefined) return;
  if (!isPoTransitionAllowed(po.status, target)) return;
  ctx.store.db
    .prepare('UPDATE purchase_order SET status = ?, updated_at = ? WHERE workspace_id = ? AND id = ?')
    .run(target, ctx.clock.now(), ctx.workspaceId, poId);
}

// --- goods_receipt_post ------------------------------------------------------------------------

export interface GoodsReceiptSimpleInput {
  grId?: string;
  idempotencyKey?: string;
}

/**
 * Post the receipt (US-I02.3). ONE transaction: re-validate every line against the LIVE purchase
 * order, write the J02 movements, append the trail, raise `received_qty`, freeze the document.
 *
 * There is NO date parameter, deliberately (invariant d). The movements are stamped with the
 * document's stored `received_at` and the period guard is asserted against that same date, so a
 * sealed year cannot be back-charged by moving the posting date into an open one.
 */
export function goodsReceiptPost(ctx: WorkspaceContext, input: GoodsReceiptSimpleInput): Result {
  const capable = ctx.capabilities.assert(WRITE_CAP);
  if (!capable.ok) return capable;
  const keyErr = requireKey(input.idempotencyKey);
  if (keyErr !== undefined) return keyErr;

  const run = (): Result => {
    const doc = readDoc(ctx, input.grId);
    if (doc === undefined) return err('not_found', { grId: input.grId });
    // Row-level double-post guard, independent of the idempotency key (invariant a).
    if (doc.status !== 'draft') return err('invalid_transition', { grId: doc.id, status: doc.status });

    const periodOpen = ctx.periods.assertOpen(doc.received_at);
    if (!periodOpen.ok) return periodOpen;

    const lines = readDocLines(ctx, doc.id);
    if (lines.length === 0) return err('invalid_input', { field: 'lines', grId: doc.id });

    const recognise = lines.filter((l) => RECOGNISED_INSPECTION_STATUSES.includes(l.inspection_status));
    const failure = recogniseLines(ctx, doc, recognise, 'Wareneingang');
    if (failure !== undefined) return failure;

    const now = ctx.clock.now();
    ctx.store.db
      .prepare(
        "UPDATE goods_receipt_doc SET status = 'posted', posted_at = ?, posted_by = ?, updated_at = ? WHERE workspace_id = ? AND id = ?",
      )
      .run(now, ctx.actor, now, ctx.workspaceId, doc.id);
    recordEvent(ctx, doc.id, null, 'posted', null);
    return ok(detailOf(ctx, doc.id));
  };

  return runTx(ctx, 'goods_receipt_post', input.idempotencyKey, run);
}

// --- goods_receipt_accept_lines / reject_lines -------------------------------------------------

export interface GoodsReceiptLineDecisionInput {
  grId?: string;
  lineIds?: string[];
  reason?: string;
  idempotencyKey?: string;
}

type Selection = { ok: true; lines: LineRow[] } | { ok: false; rejection: Result };

/** Resolve the named lines, refusing any that is not currently HELD (`pending`). */
function decisionLines(ctx: WorkspaceContext, doc: DocRow, lineIds: unknown): Selection {
  if (!Array.isArray(lineIds) || lineIds.length === 0) {
    return { ok: false, rejection: err('invalid_input', { field: 'lineIds' }) };
  }
  const byId = new Map(readDocLines(ctx, doc.id).map((l) => [l.id, l]));
  const out: LineRow[] = [];
  for (const id of lineIds) {
    const line = typeof id === 'string' ? byId.get(id) : undefined;
    if (line === undefined) return { ok: false, rejection: err('not_found', { lineId: id }) };
    if (line.inspection_status !== 'pending') {
      return {
        ok: false,
        rejection: err('invalid_transition', { lineId: line.id, inspectionStatus: line.inspection_status }),
      };
    }
    out.push(line);
  }
  return { ok: true, lines: out };
}

/**
 * Release held lines into stock (US-I02.5): exactly what post would have done for them, at the
 * document's own date and under the same live open-quantity and period guards.
 */
export function goodsReceiptAcceptLines(ctx: WorkspaceContext, input: GoodsReceiptLineDecisionInput): Result {
  const capable = ctx.capabilities.assert(WRITE_CAP);
  if (!capable.ok) return capable;
  const keyErr = requireKey(input.idempotencyKey);
  if (keyErr !== undefined) return keyErr;

  const run = (): Result => {
    const doc = readDoc(ctx, input.grId);
    if (doc === undefined) return err('not_found', { grId: input.grId });
    if (doc.status !== 'posted') return err('invalid_transition', { grId: doc.id, status: doc.status });

    const periodOpen = ctx.periods.assertOpen(doc.received_at);
    if (!periodOpen.ok) return periodOpen;

    const selected = decisionLines(ctx, doc, input.lineIds);
    if (!selected.ok) return selected.rejection;

    const failure = recogniseLines(ctx, doc, selected.lines, 'Wareneingang Freigabe');
    if (failure !== undefined) return failure;
    for (const line of selected.lines) recordEvent(ctx, doc.id, line.id, 'accepted', input.reason ?? null);
    touchDoc(ctx, doc.id);
    return ok(detailOf(ctx, doc.id));
  };

  return runTx(ctx, 'goods_receipt_accept_lines', input.idempotencyKey, run);
}

/**
 * Refuse held lines (US-I02.5). No movement and no PO quantity: a rejected quantity never entered
 * stock, so the ordered quantity simply stays open and can be received again on a later delivery.
 * The decision is an append-only event with the actor and the reason on it.
 */
export function goodsReceiptRejectLines(ctx: WorkspaceContext, input: GoodsReceiptLineDecisionInput): Result {
  const capable = ctx.capabilities.assert(WRITE_CAP);
  if (!capable.ok) return capable;
  const keyErr = requireKey(input.idempotencyKey);
  if (keyErr !== undefined) return keyErr;
  if (typeof input.reason !== 'string' || input.reason.trim().length === 0) {
    return err('invalid_input', { field: 'reason' });
  }

  const run = (): Result => {
    const doc = readDoc(ctx, input.grId);
    if (doc === undefined) return err('not_found', { grId: input.grId });
    if (doc.status !== 'posted') return err('invalid_transition', { grId: doc.id, status: doc.status });

    const selected = decisionLines(ctx, doc, input.lineIds);
    if (!selected.ok) return selected.rejection;

    const now = ctx.clock.now();
    for (const line of selected.lines) {
      ctx.store.db
        .prepare(
          "UPDATE goods_receipt_doc_line SET inspection_status = 'rejected', rejected_at = ?, reject_reason = ? WHERE workspace_id = ? AND id = ?",
        )
        .run(now, input.reason ?? null, ctx.workspaceId, line.id);
      recordEvent(ctx, doc.id, line.id, 'rejected', input.reason ?? null);
    }
    touchDoc(ctx, doc.id);
    return ok(detailOf(ctx, doc.id));
  };

  return runTx(ctx, 'goods_receipt_reject_lines', input.idempotencyKey, run);
}

// --- goods_receipt_reverse ---------------------------------------------------------------------

export interface GoodsReceiptReverseInput {
  grId?: string;
  reason?: string;
  idempotencyKey?: string;
}

/**
 * Reverse a posted receipt (US-I02.4). The correction for a posted mistake, and the ONLY one:
 * nothing about the original document, its movements or its trail rows is edited or deleted
 * (invariant b). What is written is the compensation:
 *
 *  - a J02 `return` movement of equal magnitude and OPPOSITE sign per recognised line, at the
 *    document's own date, carrying the same source-document link so the pair is findable together,
 *  - a NEGATIVE trail row per line, so `SUM(trail.qty) == po_line.received_qty` still holds,
 *  - the `received_qty` rollback, which can never drive the counter below zero because it subtracts
 *    exactly what this document added,
 *  - the original marked `reversed`, with who and when.
 *
 * A line I04 has already billed refuses with `line_already_billed`: unwinding received quantity that
 * a vendor bill has already been matched against would break the three-way match rather than correct
 * it. If stock has since left the warehouse, J02's own `insufficient_stock` guard refuses the
 * reversal and the whole transaction rolls back, which is the honest answer: the goods are gone, so
 * the correction is a stocktake adjustment (J05), not an un-receipt.
 */
export function goodsReceiptReverse(ctx: WorkspaceContext, input: GoodsReceiptReverseInput): Result {
  const capable = ctx.capabilities.assert(WRITE_CAP);
  if (!capable.ok) return capable;
  const keyErr = requireKey(input.idempotencyKey);
  if (keyErr !== undefined) return keyErr;
  if (typeof input.reason !== 'string' || input.reason.trim().length === 0) {
    return err('invalid_input', { field: 'reason' });
  }

  const run = (): Result => {
    const doc = readDoc(ctx, input.grId);
    if (doc === undefined) return err('not_found', { grId: input.grId });
    if (doc.status !== 'posted') return err('invalid_transition', { grId: doc.id, status: doc.status });

    // (d) against the period the receipt BELONGS to: a sealed period's stock history is not
    // un-receivable, and there is no reversal date to move it into an open one.
    const periodOpen = ctx.periods.assertOpen(doc.received_at);
    if (!periodOpen.ok) return periodOpen;

    const lines = readDocLines(ctx, doc.id);
    const recognised = lines.filter((l) => l.recognised_at !== null && l.reversal_trail_line_id === null);
    for (const line of recognised) {
      if (line.billed_qty > 0) return err('line_already_billed', { grId: doc.id, lineId: line.id, billedQty: line.billed_qty });
    }

    const trailLocation = doc.default_location_id ?? recognised[0]?.location_id ?? null;
    const trailId =
      recognised.length === 0 || trailLocation === null
        ? null
        : openTrailHeader(ctx, doc, trailLocation, 'Wareneingang Storno');
    const now = ctx.clock.now();

    for (const line of recognised) {
      let reversalMovementId: string | null = null;
      if (line.movement_id !== null && line.location_id !== null && line.item_id !== null) {
        const moved = inventoryMove(ctx, {
          itemId: line.item_id,
          locationId: line.location_id,
          qty: -line.qty,
          // J02 has no `receipt_reversal` type; `return` is the type that carries the caller's sign
          // and whose documented negative case is exactly this (a return to the vendor).
          movementType: 'return',
          unitCostMinor: line.unit_cost_rappen,
          effectiveDate: doc.received_at,
          lotId: line.lot_id,
          serialId: line.serial_id,
          sourceDocumentType: RECEIPT_SOURCE_DOCUMENT_TYPE,
          sourceDocumentId: doc.id,
          description: `Storno ${doc.number}`,
          idempotencyKey: `gr:${line.id}:reversal`,
        });
        if (!moved.ok) return moved;
        reversalMovementId = ((moved as unknown as { movement: { id: string } }).movement.id ?? null) as string | null;
      }

      const reversalTrailLineId =
        trailId === null ? null : appendTrailLine(ctx, trailId, line.po_line_id, -line.qty, reversalMovementId);
      ctx.store.db
        .prepare(
          'UPDATE po_line SET received_qty = MAX(received_qty - ?, 0) WHERE workspace_id = ? AND id = ?',
        )
        .run(line.qty, ctx.workspaceId, line.po_line_id);
      ctx.store.db
        .prepare(
          'UPDATE goods_receipt_doc_line SET reversal_movement_id = ?, reversal_trail_line_id = ? WHERE workspace_id = ? AND id = ?',
        )
        .run(reversalMovementId, reversalTrailLineId, ctx.workspaceId, line.id);
    }

    // The rollback may have left a fully received order short again, so the ORDER's status has to
    // walk back with it (the `received -> sent` edge, owner decision 11.08.2026). Nothing else in
    // the product may be left claiming a quantity the lines no longer carry.
    syncPoStatus(ctx, doc.po_id);

    ctx.store.db
      .prepare(
        "UPDATE goods_receipt_doc SET status = 'reversed', reversed_at = ?, reversed_by = ?, updated_at = ? WHERE workspace_id = ? AND id = ?",
      )
      .run(now, ctx.actor, now, ctx.workspaceId, doc.id);
    recordEvent(ctx, doc.id, null, 'reversed', input.reason ?? null);
    return ok(detailOf(ctx, doc.id));
  };

  return runTx(ctx, 'goods_receipt_reverse', input.idempotencyKey, run);
}

// --- goods_receipt_cancel ----------------------------------------------------------------------

export interface GoodsReceiptCancelInput {
  grId?: string;
  reason?: string | null;
  idempotencyKey?: string;
}

/** Abandon a DRAFT (nothing physical has happened yet). A posted receipt is reversed, never cancelled. */
export function goodsReceiptCancel(ctx: WorkspaceContext, input: GoodsReceiptCancelInput): Result {
  const capable = ctx.capabilities.assert(WRITE_CAP);
  if (!capable.ok) return capable;
  const keyErr = requireKey(input.idempotencyKey);
  if (keyErr !== undefined) return keyErr;

  const run = (): Result => {
    const doc = readDoc(ctx, input.grId);
    if (doc === undefined) return err('not_found', { grId: input.grId });
    if (doc.status !== 'draft') return err('invalid_transition', { grId: doc.id, status: doc.status });
    const now = ctx.clock.now();
    ctx.store.db
      .prepare(
        "UPDATE goods_receipt_doc SET status = 'cancelled', cancelled_at = ?, cancel_reason = ?, updated_at = ? WHERE workspace_id = ? AND id = ?",
      )
      .run(now, input.reason ?? null, now, ctx.workspaceId, doc.id);
    recordEvent(ctx, doc.id, null, 'cancelled', input.reason ?? null);
    return ok(detailOf(ctx, doc.id));
  };

  return runTx(ctx, 'goods_receipt_cancel', input.idempotencyKey, run);
}

// --- reads --------------------------------------------------------------------------------------

export function goodsReceiptGet(ctx: WorkspaceContext, input: { grId?: string }): Result {
  const capable = ctx.capabilities.assert(READ_CAP);
  if (!capable.ok) return capable;
  const doc = readDoc(ctx, input.grId);
  if (doc === undefined) return err('not_found', { grId: input.grId });
  return ok(detailOf(ctx, doc.id));
}

export interface GoodsReceiptListInput {
  status?: string | string[];
  poId?: string;
  supplierContactId?: string;
  fromDate?: string;
  toDate?: string;
  q?: string;
  /** The exception cut: only receipts that took more than the order had open. */
  hasOverReceipt?: boolean;
  savedViewId?: string;
}

export function goodsReceiptList(ctx: WorkspaceContext, input: GoodsReceiptListInput = {}): Result {
  const capable = ctx.capabilities.assert(READ_CAP);
  if (!capable.ok) return capable;

  // A `goods_receipt` saved view (G00) merges its stored filters UNDERNEATH any filter named
  // explicitly here (the requisition / poList precedent).
  const viewed = applySavedView(ctx, 'goods_receipt', {
    ...(input.status !== undefined ? { status: input.status } : {}),
    ...(input.poId !== undefined ? { poId: input.poId } : {}),
    ...(input.supplierContactId !== undefined ? { supplierContactId: input.supplierContactId } : {}),
    ...(input.fromDate !== undefined ? { fromDate: input.fromDate } : {}),
    ...(input.toDate !== undefined ? { toDate: input.toDate } : {}),
    ...(input.q !== undefined ? { q: input.q } : {}),
    ...(input.hasOverReceipt !== undefined ? { hasOverReceipt: input.hasOverReceipt } : {}),
    ...(input.savedViewId !== undefined ? { savedViewId: input.savedViewId } : {}),
  });
  if (!viewed.ok) return viewed;
  const f = viewed.filter as GoodsReceiptListInput;

  const clauses = ['d.workspace_id = ?'];
  const params: unknown[] = [ctx.workspaceId];
  const statuses = Array.isArray(f.status)
    ? f.status
    : typeof f.status === 'string' && f.status.length > 0
      ? [f.status]
      : [];
  const valid = statuses.filter((s) => (GOODS_RECEIPT_STATUSES as readonly string[]).includes(s));
  if (valid.length > 0) {
    clauses.push(`d.status IN (${valid.map(() => '?').join(', ')})`);
    params.push(...valid);
  }
  if (typeof f.poId === 'string' && f.poId.length > 0) {
    clauses.push('d.po_id = ?');
    params.push(f.poId);
  }
  if (typeof f.supplierContactId === 'string' && f.supplierContactId.length > 0) {
    clauses.push('d.supplier_contact_id = ?');
    params.push(f.supplierContactId);
  }
  if (typeof f.fromDate === 'string' && f.fromDate.length > 0) {
    clauses.push('d.received_at >= ?');
    params.push(f.fromDate.slice(0, 10));
  }
  if (typeof f.toDate === 'string' && f.toDate.length > 0) {
    clauses.push('d.received_at <= ?');
    params.push(f.toDate.slice(0, 10));
  }
  // The exception cut a buyer actually asks for: "which deliveries came in over what we ordered?"
  if (f.hasOverReceipt === true) clauses.push('d.has_over_receipt = 1');
  else if (f.hasOverReceipt === false) clauses.push('d.has_over_receipt = 0');
  if (typeof f.q === 'string' && f.q.trim().length > 0) {
    clauses.push(`(lower(d.number) LIKE ? OR lower(COALESCE(d.note, '')) LIKE ?)`);
    const like = `%${f.q.trim().toLowerCase()}%`;
    params.push(like, like);
  }

  const rows = ctx.store.db
    .prepare(
      `SELECT d.*, po.number AS po_number, c.name AS supplier_name,
              (SELECT COUNT(*) FROM goods_receipt_doc_line gl
                WHERE gl.workspace_id = d.workspace_id AND gl.gr_id = d.id) AS line_count,
              (SELECT COALESCE(SUM(gl.qty * gl.unit_cost_rappen), 0) FROM goods_receipt_doc_line gl
                WHERE gl.workspace_id = d.workspace_id AND gl.gr_id = d.id) AS value_rappen,
              (SELECT COALESCE(SUM(gl.over_receipt_qty), 0) FROM goods_receipt_doc_line gl
                WHERE gl.workspace_id = d.workspace_id AND gl.gr_id = d.id) AS over_receipt_qty
         FROM goods_receipt_doc d
         JOIN purchase_order po ON po.id = d.po_id AND po.workspace_id = d.workspace_id
         JOIN contact c ON c.id = d.supplier_contact_id AND c.workspace_id = d.workspace_id
        WHERE ${clauses.join(' AND ')}
        ORDER BY d.received_at DESC, d.number DESC`,
    )
    .all(...params) as (DocRow & {
    po_number: string;
    supplier_name: string;
    line_count: number;
    value_rappen: number;
    over_receipt_qty: number;
  })[];

  return ok({
    goodsReceipts: rows.map((r) => ({
      ...mapDoc(r),
      poNumber: r.po_number,
      supplierName: r.supplier_name,
      lineCount: r.line_count,
      valueRappen: r.value_rappen,
      overReceiptQty: r.over_receipt_qty,
    })),
  });
}

/**
 * I04's consumer read: the receipt lines a three-way match may bill. Only RECOGNISED lines (a
 * movement exists, or a non-stock line whose quantity was advanced), never a reversed one, and never
 * a line already fully billed. Returns the stable `goods_receipt_doc_line.id` I03 targets for landed
 * cost and I04 marks billed.
 */
export function goodsReceiptLinesForMatch(ctx: WorkspaceContext, input: { poLineIds?: string[] }): Result {
  const capable = ctx.capabilities.assert(READ_CAP);
  if (!capable.ok) return capable;
  const ids = Array.isArray(input.poLineIds) ? input.poLineIds.filter((i) => typeof i === 'string' && i.length > 0) : [];
  if (ids.length === 0) return err('invalid_input', { field: 'poLineIds' });

  const rows = ctx.store.db
    .prepare(
      `SELECT l.*, d.number AS gr_number, d.received_at AS received_at, d.status AS doc_status
         FROM goods_receipt_doc_line l
         JOIN goods_receipt_doc d ON d.id = l.gr_id AND d.workspace_id = l.workspace_id
        WHERE l.workspace_id = ? AND d.status = 'posted'
          AND l.recognised_at IS NOT NULL AND l.reversal_trail_line_id IS NULL
          AND l.billed_qty < l.qty
          AND l.po_line_id IN (${ids.map(() => '?').join(', ')})
        ORDER BY d.received_at, d.number, l.line_no`,
    )
    .all(ctx.workspaceId, ...ids) as (LineRow & { gr_number: string; received_at: string; doc_status: string })[];

  return ok({
    lines: rows.map((r) => ({
      ...mapLine(r),
      grNumber: r.gr_number,
      receivedAt: r.received_at,
      openQty: r.qty - r.billed_qty,
    })),
  });
}

export function goodsReceiptGetConfig(ctx: WorkspaceContext): Result {
  const capable = ctx.capabilities.assert(READ_CAP);
  if (!capable.ok) return capable;
  const cfg = readReceiptConfig(ctx);
  return ok({ allowOverReceipt: cfg.allowOverReceipt, overReceiptPct: cfg.overReceiptPct });
}

export interface GoodsReceiptSetConfigInput {
  allowOverReceipt?: boolean;
  overReceiptPct?: number;
  idempotencyKey?: string;
}

/**
 * Set the workspace over-receipt posture. Plain policy: posts no journal entry, moves no stock, and
 * never rewrites history, so flipping it changes only what a FUTURE post will accept. A receipt
 * already taken stays exactly as it was recorded.
 */
export function goodsReceiptSetConfig(ctx: WorkspaceContext, input: GoodsReceiptSetConfigInput): Result {
  const capable = ctx.capabilities.assert(WRITE_CAP);
  if (!capable.ok) return capable;
  const keyErr = requireKey(input.idempotencyKey);
  if (keyErr !== undefined) return keyErr;
  if (typeof input.allowOverReceipt !== 'boolean') return err('invalid_input', { field: 'allowOverReceipt' });
  // OMITTING the percentage means NO CAP, which is how a cap is cleared as well as how it is never
  // set. There is deliberately no null on the wire: an absent field is unambiguous on both faces.
  const pct = input.overReceiptPct === undefined ? null : input.overReceiptPct;
  if (pct !== null && (!Number.isInteger(pct) || pct <= 0 || pct > 100)) {
    return err('invalid_input', { field: 'overReceiptPct' });
  }

  const now = ctx.clock.now();
  return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey as string, 'goods_receipt_set_config', () => {
    ctx.store.db
      .prepare(
        `INSERT INTO goods_receipt_config (workspace_id, allow_over_receipt, over_receipt_pct, updated_at, updated_by)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(workspace_id) DO UPDATE SET allow_over_receipt = excluded.allow_over_receipt,
           over_receipt_pct = excluded.over_receipt_pct, updated_at = excluded.updated_at,
           updated_by = excluded.updated_by`,
      )
      .run(ctx.workspaceId, input.allowOverReceipt === true ? 1 : 0, pct, now, ctx.actor);
    return ok({ allowOverReceipt: input.allowOverReceipt === true, overReceiptPct: pct });
  });
}
