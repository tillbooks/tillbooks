/**
 * J05 part 2, the reason-coded manual-adjustment facade over J02's `inventoryMove` (spec §4). This is a
 * MONEY-PATH capability: it mints `movement_type='adjustment'` movements that move on-hand and, through
 * J06, the balance-sheet inventory figure. It writes NO quantity of its own: on-hand stays
 * `SUM(stock_movement.qty)` (OP13). Every J05 write is a facade that validates the reason, asserts the
 * period, then calls `inventoryMove` and records ONE append-only `inventory_adjustment` row linking the
 * minted movement to the active reason.
 *
 * THE MONEY-PATH INVARIANTS THIS FILE HOLDS (spec §7, asserted in `test/inventory/adjust.test.mjs`):
 *  (a) APPEND-ONLY VIA J02: every quantity change is a NEW `inventoryMove` row; J05 never UPDATEs or
 *      DELETEs a movement, and its own `inventory_adjustment` table is frozen by no-UPDATE / no-DELETE
 *      triggers, so a reverse is a NEW linked row, never an edit.
 *  (b) §H-TENANT: a foreign workspace's reason code / adjustment / batch id is not_found before any
 *      read or mint. Every SELECT and the mint carry `workspace_id = ?`.
 *  (c) IDEMPOTENT ON ROWS: each minted movement carries a DETERMINISTIC key derived from the verb's
 *      idempotency_key (`adj:` / `adjb:<i>` / `adjrev:<i>`), so `inventoryMove`'s own (workspace, key)
 *      unique index posts no second row even underneath the verb-level result cache.
 *  (d) MANDATORY ACTIVE REASON: an adjustment whose reason_code_id is missing, archived or foreign is
 *      refused (`reason_inactive` / `not_found` / `no_active_reasons`) and mints nothing. Enforced HERE,
 *      at the verb, never at the J02 insert (which stays reason-agnostic for J04 stocktake's sake).
 *  (e) SIGN / DIRECTION + NEGATIVE-STOCK: the signed qty flows straight to `inventoryMove` (a positive
 *      adjustment raises on-hand, a negative one lowers it); the J02 `allow_negative_stock` guard still
 *      refuses an overdraw with `insufficient_stock`.
 *  (f) PERIOD LOCK: the effective date is asserted open BEFORE any mint; a locked or sealed period is
 *      refused with `period_locked`, zero movements minted.
 *  (g) REVERSAL: reverse mints a linked opposite-sign movement carrying its OWN reason; the original
 *      row and movement are never touched, and "already reversed" is a query for the existing reversal
 *      row, not a mutation.
 *  (h) ATOMICITY: a batch where one line is invalid throws a carrier that rolls the WHOLE transaction
 *      back (no partial mints), exactly as J04's commit loop does.
 *
 * THE PARTIAL-WRITE TRAP (money-path). `ctx.store.tx` (and `rememberIdempotent`'s tx) COMMIT a
 * `{ok:false}` returned from inside them, so the mint loop THROWS an `AdjustAbort` carrier on any
 * `inventoryMove` rejection to roll the transaction back: either every movement lands and every
 * `inventory_adjustment` row is written, or none is.
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { inventoryMove } from './movement.js';
import { readReason, hasActiveReason, isReasonCategory } from './reason.js';

// --- adjustment row shape ----------------------------------------------------------------------

export interface InventoryAdjustment {
  id: string;
  batchId: string | null;
  movementId: string;
  reasonCodeId: string;
  itemId: string;
  locationId: string;
  lotId: string | null;
  serialId: string | null;
  qtyDelta: number;
  note: string | null;
  unitCostMinor: number | null;
  effectiveDate: string;
  reversesAdjustmentId: string | null;
  createdAt: string;
  createdBy: string | null;
}

interface AdjustmentRow {
  id: string;
  batch_id: string | null;
  movement_id: string;
  reason_code_id: string;
  item_id: string;
  location_id: string;
  lot_id: string | null;
  serial_id: string | null;
  qty_delta: number;
  note: string | null;
  unit_cost_minor: number | null;
  effective_date: string;
  reverses_adjustment_id: string | null;
  created_at: string;
  created_by: string | null;
}

const ADJ_COLUMNS = `id, batch_id, movement_id, reason_code_id, item_id, location_id, lot_id, serial_id,
  qty_delta, note, unit_cost_minor, effective_date, reverses_adjustment_id, created_at, created_by`;

function mapAdjustment(r: AdjustmentRow): InventoryAdjustment {
  return {
    id: r.id,
    batchId: r.batch_id,
    movementId: r.movement_id,
    reasonCodeId: r.reason_code_id,
    itemId: r.item_id,
    locationId: r.location_id,
    lotId: r.lot_id,
    serialId: r.serial_id,
    qtyDelta: r.qty_delta,
    note: r.note,
    unitCostMinor: r.unit_cost_minor,
    effectiveDate: r.effective_date,
    reversesAdjustmentId: r.reverses_adjustment_id,
    createdAt: r.created_at,
    createdBy: r.created_by,
  };
}

function readAdjustment(ctx: WorkspaceContext, id: string): AdjustmentRow | undefined {
  return ctx.store.db
    .prepare(`SELECT ${ADJ_COLUMNS} FROM inventory_adjustment WHERE workspace_id = ? AND id = ?`)
    .get(ctx.workspaceId, id) as AdjustmentRow | undefined;
}

/** A carrier that rolls the transaction back with a structured Result (the partial-write trap). */
class AdjustAbort {
  constructor(public readonly result: Result) {}
}

// --- shared reason + note resolution -----------------------------------------------------------

interface ResolvedReason {
  id: string;
  requiresNote: boolean;
}

/**
 * Resolve and validate the reason for an adjustment (invariant d). Missing / archived / foreign is
 * refused and NOTHING is minted. The empty-catalog case is distinguished as `no_active_reasons` so an
 * agent knows to create a reason code first rather than chasing a bad id (spec §2 US-J05.8).
 */
function resolveReason(ctx: WorkspaceContext, reasonCodeId: unknown): { ok: true; reason: ResolvedReason } | { ok: false; err: Result } {
  if (typeof reasonCodeId !== 'string' || reasonCodeId.length === 0) {
    if (!hasActiveReason(ctx)) return { ok: false, err: err('no_active_reasons', {}) };
    return { ok: false, err: err('invalid_input', { field: 'reasonCodeId' }) };
  }
  const reason = readReason(ctx, reasonCodeId);
  if (reason === undefined) {
    if (!hasActiveReason(ctx)) return { ok: false, err: err('no_active_reasons', {}) };
    return { ok: false, err: err('not_found', { reasonCodeId }) };
  }
  if (!reason.isActive) return { ok: false, err: err('reason_inactive', { reasonCodeId }) };
  return { ok: true, reason: { id: reason.id, requiresNote: reason.requiresNote } };
}

/** A `requires_note` reason demands a non-empty, non-whitespace note (spec §2 US-J05.2). */
function noteError(reason: ResolvedReason, note: string | undefined): Result | undefined {
  if (reason.requiresNote && (typeof note !== 'string' || note.trim().length === 0)) {
    return err('note_required', { reasonCodeId: reason.id });
  }
  return undefined;
}

function today(ctx: WorkspaceContext): string {
  return ctx.clock.now().slice(0, 10);
}

/**
 * Presence / type validation of the movement-shaped fields, so the mint receives defined values and
 * the movement layer is left to judge qty=0 / sign / tracking / stock. A missing item, location or qty
 * is `invalid_input` here rather than a cast smuggling `undefined` into `inventoryMove`.
 */
function validateLine(line: {
  itemId?: string;
  locationId?: string;
  qtyDelta?: number;
}): { ok: true; itemId: string; locationId: string; qty: number } | { ok: false; err: Result } {
  if (typeof line.itemId !== 'string' || line.itemId.length === 0) {
    return { ok: false, err: err('invalid_input', { field: 'itemId' }) };
  }
  if (typeof line.locationId !== 'string' || line.locationId.length === 0) {
    return { ok: false, err: err('invalid_input', { field: 'locationId' }) };
  }
  if (typeof line.qtyDelta !== 'number') {
    return { ok: false, err: err('invalid_input', { field: 'qtyDelta' }) };
  }
  return { ok: true, itemId: line.itemId, locationId: line.locationId, qty: line.qtyDelta };
}

// --- single adjust -----------------------------------------------------------------------------

export interface AdjustInput {
  itemId?: string;
  locationId?: string;
  lotId?: string | null;
  serialId?: string | null;
  qtyDelta?: number;
  reasonCodeId?: string;
  note?: string;
  unitCostMinor?: number | null;
  effectiveDate?: string;
  idempotencyKey?: string;
}

/**
 * Post a single reason-coded adjustment (spec §2 US-J05.2). Validates the reason (active), the note
 * policy and the period BEFORE minting, then mints ONE J02 movement (`movement_type='adjustment'`,
 * signed qty) and records one `inventory_adjustment` row. §H-IDEMPOTENT: a replay returns the original
 * and posts no second movement (the deterministic movement key `adj:<key>` is the row-level guard).
 */
export function inventoryAdjust(ctx: WorkspaceContext, input: AdjustInput): Result {
  const capable = ctx.capabilities.assert('manage_master_data');
  if (!capable.ok) return capable;
  if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length === 0) {
    return err('invalid_input', { field: 'idempotencyKey' });
  }
  const key = input.idempotencyKey;

  // §H-IDEMPOTENT: a replay short-circuits BEFORE the state-dependent guards (so a period that locked
  // after the original does not turn a completed adjust into a rejection on retry).
  const cached = ctx.store.recallIdempotent<Result>(ctx.workspaceId, key, 'inventory_adjust');
  if (cached !== undefined) return cached;

  const lineRes = validateLine(input);
  if (!lineRes.ok) return lineRes.err;
  const reasonRes = resolveReason(ctx, input.reasonCodeId);
  if (!reasonRes.ok) return reasonRes.err;
  const noteErr = noteError(reasonRes.reason, input.note);
  if (noteErr !== undefined) return noteErr;

  const effectiveDate = (input.effectiveDate ?? today(ctx)).slice(0, 10);
  const periodOpen = ctx.periods.assertOpen(effectiveDate);
  if (!periodOpen.ok) return periodOpen;

  try {
    return ctx.store.rememberIdempotent<Result>(ctx.workspaceId, key, 'inventory_adjust', () => {
      const adjId = ctx.ids.next('invadj');
      const minted = mintAdjustment(ctx, {
        adjId,
        batchId: null,
        reversesAdjustmentId: null,
        reasonCodeId: reasonRes.reason.id,
        itemId: lineRes.itemId,
        locationId: lineRes.locationId,
        lotId: input.lotId ?? null,
        serialId: input.serialId ?? null,
        qty: lineRes.qty,
        note: input.note ?? null,
        unitCostMinor: input.unitCostMinor ?? null,
        effectiveDate,
        sourceDocumentType: 'inventory_adjustment',
        movementKey: `adj:${key}`,
        verbKey: key,
      });
      if (!minted.ok) throw new AdjustAbort(minted);
      return ok({
        adjustment: mapAdjustment(readAdjustment(ctx, adjId) as AdjustmentRow),
        movement: minted.movement,
        onHandAfter: minted.onHand,
      });
    });
  } catch (e) {
    if (e instanceof AdjustAbort) return e.result;
    throw e;
  }
}

// --- the one mint: inventoryMove + the inventory_adjustment row ---------------------------------

interface MintArgs {
  adjId: string;
  batchId: string | null;
  reversesAdjustmentId: string | null;
  reasonCodeId: string;
  itemId: string;
  locationId: string;
  lotId: string | null;
  serialId: string | null;
  qty: number;
  note: string | null;
  unitCostMinor: number | null;
  effectiveDate: string;
  sourceDocumentType: string;
  movementKey: string;
  verbKey: string;
}

type MintOutcome = { ok: true; movement: Record<string, unknown>; onHand: number } | Result;

/**
 * Mint ONE movement through J02 and write its `inventory_adjustment` row. The movement is the ONLY
 * quantity path (OP13); the row is the reason linkage. On any `inventoryMove` rejection this returns
 * the rejection unchanged, and the caller throws it as an `AdjustAbort` so the whole transaction rolls
 * back (the partial-write trap). The movement carries `sourceDocumentType` + the adjustment id, so a
 * movement traces back to its reason even though `stock_movement` has no reason column.
 */
function mintAdjustment(ctx: WorkspaceContext, a: MintArgs): MintOutcome {
  const res = inventoryMove(ctx, {
    itemId: a.itemId,
    locationId: a.locationId,
    lotId: a.lotId,
    serialId: a.serialId,
    qty: a.qty,
    movementType: 'adjustment',
    unitCostMinor: a.unitCostMinor,
    effectiveDate: a.effectiveDate,
    description: a.note,
    sourceDocumentType: a.sourceDocumentType,
    sourceDocumentId: a.adjId,
    idempotencyKey: a.movementKey,
  });
  if (!res.ok) return res;
  const movement = (res as unknown as { movement: { id: string; qty: number } }).movement;
  const onHand = (res as unknown as { onHand?: number }).onHand ?? 0;
  const now = ctx.clock.now();
  ctx.store.db
    .prepare(
      `INSERT INTO inventory_adjustment
         (id, workspace_id, batch_id, movement_id, reason_code_id, item_id, location_id, lot_id,
          serial_id, qty_delta, note, unit_cost_minor, effective_date, reverses_adjustment_id,
          idempotency_key, created_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      a.adjId,
      ctx.workspaceId,
      a.batchId,
      movement.id,
      a.reasonCodeId,
      a.itemId,
      a.locationId,
      a.lotId,
      a.serialId,
      movement.qty,
      a.note,
      a.unitCostMinor,
      a.effectiveDate,
      a.reversesAdjustmentId,
      a.verbKey,
      now,
      ctx.actor,
    );
  ctx.audit.record({
    entityKind: 'inventory_adjustment',
    entityId: a.adjId,
    action: a.reversesAdjustmentId === null ? 'create' : 'reverse',
    actor: ctx.actor,
    at: now,
  });
  return { ok: true, movement: movement as unknown as Record<string, unknown>, onHand };
}

// --- batch adjust ------------------------------------------------------------------------------

export interface AdjustBatchLine {
  itemId?: string;
  locationId?: string;
  lotId?: string | null;
  serialId?: string | null;
  qtyDelta?: number;
  reasonCodeId?: string;
  note?: string;
  unitCostMinor?: number | null;
}

export interface AdjustBatchInput {
  description?: string;
  effectiveDate?: string;
  lines?: AdjustBatchLine[];
  idempotencyKey?: string;
}

/**
 * Post a multi-line batch atomically (spec §2 US-J05.3). Every line is validated (reason active, note
 * policy) BEFORE any mint; the period is asserted once. All lines mint under ONE transaction sharing a
 * generated `batch_id`; if any line's `inventoryMove` rejects, an `AdjustAbort` rolls the WHOLE batch
 * back (invariant h). §H-IDEMPOTENT: a replay returns the original batch; each line's movement key
 * `adjb:<key>:<i>` is the row-level guard beneath the cache.
 */
export function inventoryAdjustBatch(ctx: WorkspaceContext, input: AdjustBatchInput): Result {
  const capable = ctx.capabilities.assert('manage_master_data');
  if (!capable.ok) return capable;
  if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length === 0) {
    return err('invalid_input', { field: 'idempotencyKey' });
  }
  if (!Array.isArray(input.lines) || input.lines.length === 0) {
    return err('invalid_input', { field: 'lines' });
  }
  const key = input.idempotencyKey;

  const cached = ctx.store.recallIdempotent<Result>(ctx.workspaceId, key, 'inventory_adjust_batch');
  if (cached !== undefined) return cached;

  // Validate every line's shape, reason + note BEFORE the write, so a bad line is a clean rejection
  // that mints nothing rather than a partial batch or a cached error.
  const resolved: { line: AdjustBatchLine; itemId: string; locationId: string; qty: number; reasonId: string }[] = [];
  for (const line of input.lines) {
    const lineRes = validateLine(line);
    if (!lineRes.ok) return lineRes.err;
    const reasonRes = resolveReason(ctx, line.reasonCodeId);
    if (!reasonRes.ok) return reasonRes.err;
    const noteErr = noteError(reasonRes.reason, line.note);
    if (noteErr !== undefined) return noteErr;
    resolved.push({ line, itemId: lineRes.itemId, locationId: lineRes.locationId, qty: lineRes.qty, reasonId: reasonRes.reason.id });
  }

  const effectiveDate = (input.effectiveDate ?? today(ctx)).slice(0, 10);
  const periodOpen = ctx.periods.assertOpen(effectiveDate);
  if (!periodOpen.ok) return periodOpen;

  try {
    return ctx.store.rememberIdempotent<Result>(ctx.workspaceId, key, 'inventory_adjust_batch', () => {
      const batchId = ctx.ids.next('invadjb');
      const adjustmentIds: string[] = [];
      resolved.forEach(({ line, itemId, locationId, qty, reasonId }, i) => {
        const adjId = ctx.ids.next('invadj');
        const minted = mintAdjustment(ctx, {
          adjId,
          batchId,
          reversesAdjustmentId: null,
          reasonCodeId: reasonId,
          itemId,
          locationId,
          lotId: line.lotId ?? null,
          serialId: line.serialId ?? null,
          qty,
          note: line.note ?? null,
          unitCostMinor: line.unitCostMinor ?? null,
          effectiveDate,
          sourceDocumentType: 'inventory_adjustment',
          movementKey: `adjb:${key}:${i}`,
          verbKey: `${key}:${i}`,
        });
        if (!minted.ok) throw new AdjustAbort(minted);
        adjustmentIds.push(adjId);
      });
      const adjustments = adjustmentIds.map((id) => mapAdjustment(readAdjustment(ctx, id) as AdjustmentRow));
      return ok({ batchId, adjustments, count: adjustments.length });
    });
  } catch (e) {
    if (e instanceof AdjustAbort) return e.result;
    throw e;
  }
}

// --- reverse -----------------------------------------------------------------------------------

export interface AdjustReverseInput {
  adjustmentId?: string;
  batchId?: string;
  reasonCodeId?: string;
  note?: string;
  effectiveDate?: string;
  idempotencyKey?: string;
}

/** Adjustment rows this original has already been reversed by (invariant g: derived, never mutated). */
function reversalOf(ctx: WorkspaceContext, adjustmentId: string): AdjustmentRow | undefined {
  return ctx.store.db
    .prepare(`SELECT ${ADJ_COLUMNS} FROM inventory_adjustment WHERE workspace_id = ? AND reverses_adjustment_id = ?`)
    .get(ctx.workspaceId, adjustmentId) as AdjustmentRow | undefined;
}

/**
 * Reverse a single adjustment (`adjustmentId`) or a whole batch (`batchId`) (spec §2 US-J05.4). Each
 * reversal mints an opposite-sign movement carrying its OWN reason and records a new
 * `inventory_adjustment` row with `reverses_adjustment_id` set; the original is never touched. Already
 * reversed is `already_reversed`. Atomic across a batch. §H-IDEMPOTENT under the verb key.
 */
export function inventoryAdjustReverse(ctx: WorkspaceContext, input: AdjustReverseInput): Result {
  const capable = ctx.capabilities.assert('manage_master_data');
  if (!capable.ok) return capable;
  if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length === 0) {
    return err('invalid_input', { field: 'idempotencyKey' });
  }
  const key = input.idempotencyKey;

  const cached = ctx.store.recallIdempotent<Result>(ctx.workspaceId, key, 'inventory_adjust_reverse');
  if (cached !== undefined) return cached;

  const reasonRes = resolveReason(ctx, input.reasonCodeId);
  if (!reasonRes.ok) return reasonRes.err;
  const noteErr = noteError(reasonRes.reason, input.note);
  if (noteErr !== undefined) return noteErr;

  // Resolve the targets, tenant-scoped. A single adjustment id, or every not-yet-reversed originating
  // line of a batch (a reversal row is itself never a reverse target).
  let targets: AdjustmentRow[];
  if (typeof input.adjustmentId === 'string' && input.adjustmentId.length > 0) {
    const original = readAdjustment(ctx, input.adjustmentId);
    if (original === undefined) return err('not_found', { adjustmentId: input.adjustmentId });
    if (original.reverses_adjustment_id !== null) return err('invalid_input', { field: 'adjustmentId', reason: 'is_a_reversal' });
    if (reversalOf(ctx, original.id) !== undefined) return err('already_reversed', { adjustmentId: original.id });
    targets = [original];
  } else if (typeof input.batchId === 'string' && input.batchId.length > 0) {
    const rows = ctx.store.db
      .prepare(
        `SELECT ${ADJ_COLUMNS} FROM inventory_adjustment
          WHERE workspace_id = ? AND batch_id = ? AND reverses_adjustment_id IS NULL
          ORDER BY created_at, id`,
      )
      .all(ctx.workspaceId, input.batchId) as AdjustmentRow[];
    if (rows.length === 0) return err('not_found', { batchId: input.batchId });
    const open = rows.filter((r) => reversalOf(ctx, r.id) === undefined);
    if (open.length === 0) return err('already_reversed', { batchId: input.batchId });
    targets = open;
  } else {
    return err('invalid_input', { field: 'adjustmentId', reason: 'adjustmentId_or_batchId_required' });
  }

  const effectiveDate = (input.effectiveDate ?? today(ctx)).slice(0, 10);
  const periodOpen = ctx.periods.assertOpen(effectiveDate);
  if (!periodOpen.ok) return periodOpen;

  try {
    return ctx.store.rememberIdempotent<Result>(ctx.workspaceId, key, 'inventory_adjust_reverse', () => {
      const reversalIds: string[] = [];
      targets.forEach((original, i) => {
        const adjId = ctx.ids.next('invadj');
        const minted = mintAdjustment(ctx, {
          adjId,
          batchId: null,
          reversesAdjustmentId: original.id,
          reasonCodeId: reasonRes.reason.id,
          itemId: original.item_id,
          locationId: original.location_id,
          lotId: original.lot_id,
          serialId: original.serial_id,
          qty: -original.qty_delta,
          note: input.note ?? null,
          unitCostMinor: original.unit_cost_minor,
          effectiveDate,
          sourceDocumentType: 'inventory_adjustment_reversal',
          movementKey: `adjrev:${key}:${i}`,
          verbKey: `${key}:rev:${i}`,
        });
        if (!minted.ok) throw new AdjustAbort(minted);
        reversalIds.push(adjId);
      });
      const reversals = reversalIds.map((id) => mapAdjustment(readAdjustment(ctx, id) as AdjustmentRow));
      return ok({ reversals, count: reversals.length });
    });
  } catch (e) {
    if (e instanceof AdjustAbort) return e.result;
    throw e;
  }
}

// --- inquiry: list -----------------------------------------------------------------------------

export interface AdjustListInput {
  fromDate?: string;
  toDate?: string;
  itemId?: string;
  locationId?: string;
  reasonCodeId?: string;
  category?: string;
  batchId?: string;
  includeReversals?: boolean;
  limit?: number;
  offset?: number;
}

/**
 * List manual adjustments (spec §2 US-J05.6), newest first, joined to the reason code + item + location
 * names and the minted movement. Filterable by date range, item, location, reason, category and batch.
 * Reversal rows are excluded unless `includeReversals`. Pure read (§H-TENANT on the workspace filter).
 */
export function inventoryAdjustList(ctx: WorkspaceContext, input: AdjustListInput = {}): Result {
  const capable = ctx.capabilities.assert('read_master_data');
  if (!capable.ok) return capable;

  const clauses = ['a.workspace_id = ?'];
  const params: unknown[] = [ctx.workspaceId];
  if (typeof input.fromDate === 'string' && input.fromDate.length > 0) {
    clauses.push('a.effective_date >= ?');
    params.push(input.fromDate.slice(0, 10));
  }
  if (typeof input.toDate === 'string' && input.toDate.length > 0) {
    clauses.push('a.effective_date <= ?');
    params.push(input.toDate.slice(0, 10));
  }
  const eq = (col: string, v: unknown): void => {
    if (typeof v === 'string' && v.length > 0) {
      clauses.push(`${col} = ?`);
      params.push(v);
    }
  };
  eq('a.item_id', input.itemId);
  eq('a.location_id', input.locationId);
  eq('a.reason_code_id', input.reasonCodeId);
  eq('a.batch_id', input.batchId);
  if (isReasonCategory(input.category)) {
    clauses.push('r.category = ?');
    params.push(input.category);
  }
  if (input.includeReversals !== true) {
    clauses.push('a.reverses_adjustment_id IS NULL');
  }
  const where = clauses.join(' AND ');

  const total = (
    ctx.store.db
      .prepare(`SELECT COUNT(*) AS n FROM inventory_adjustment a JOIN inventory_reason_code r ON r.id = a.reason_code_id WHERE ${where}`)
      .get(...params) as { n: number }
  ).n;

  const limit = Number.isInteger(input.limit) && (input.limit as number) > 0 ? Math.min(input.limit as number, 500) : 100;
  const offset = Number.isInteger(input.offset) && (input.offset as number) > 0 ? (input.offset as number) : 0;

  const rows = ctx.store.db
    .prepare(
      `SELECT a.id, a.batch_id AS batchId, a.movement_id AS movementId, a.reason_code_id AS reasonCodeId,
              r.code AS reasonCode, r.name AS reasonName, r.category AS reasonCategory,
              a.item_id AS itemId, i.name AS itemName, a.location_id AS locationId, l.name AS locationName,
              a.lot_id AS lotId, a.serial_id AS serialId, a.qty_delta AS qtyDelta, a.note AS note,
              a.unit_cost_minor AS unitCostMinor, a.effective_date AS effectiveDate,
              a.reverses_adjustment_id AS reversesAdjustmentId, a.created_at AS createdAt, a.created_by AS createdBy
         FROM inventory_adjustment a
         JOIN inventory_reason_code r ON r.id = a.reason_code_id
         JOIN item i ON i.id = a.item_id
         JOIN stock_location l ON l.id = a.location_id
        WHERE ${where}
        ORDER BY a.created_at DESC, a.id DESC
        LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset) as Record<string, unknown>[];

  // The reversal back-link, so a list row can show "reversed by" without a second round trip.
  const items = rows.map((row) => {
    const reversal = reversalOf(ctx, row.id as string);
    return { ...row, reversedByAdjustmentId: reversal?.id ?? null };
  });

  return ok({ items, total, limit, offset });
}

// --- inquiry: analysis -------------------------------------------------------------------------

const GROUP_DIMENSIONS = ['reason', 'category', 'item', 'location'] as const;
type GroupDimension = (typeof GROUP_DIMENSIONS)[number];

const GROUP_SQL: Record<GroupDimension, { select: string; key: string }> = {
  reason: { select: 'a.reason_code_id AS reasonCodeId, r.code AS reasonCode, r.name AS reasonName', key: 'a.reason_code_id' },
  category: { select: 'r.category AS category', key: 'r.category' },
  item: { select: 'a.item_id AS itemId, i.name AS itemName', key: 'a.item_id' },
  location: { select: 'a.location_id AS locationId, l.name AS locationName', key: 'a.location_id' },
};

export interface AdjustAnalysisInput {
  fromDate?: string;
  toDate?: string;
  groupBy?: string[];
}

/**
 * Aggregate quantity and value impact by reason / category / item / location over a date window (spec
 * §2 US-J05.6), for management review and Swiss Inventar documentation. Value impact is
 * `SUM(qty_delta * unit_cost_minor)` in Rappen (integer, no float accumulation). Reversal rows are
 * included so the net figure is honest (a reversed adjustment nets to zero). Pure read.
 */
export function inventoryAdjustAnalysis(ctx: WorkspaceContext, input: AdjustAnalysisInput): Result {
  const capable = ctx.capabilities.assert('read_master_data');
  if (!capable.ok) return capable;

  const requested = Array.isArray(input.groupBy) ? input.groupBy : [];
  const dims = requested.filter((d): d is GroupDimension => (GROUP_DIMENSIONS as readonly string[]).includes(d));
  const groupBy: GroupDimension[] = dims.length > 0 ? [...new Set(dims)] : ['reason'];

  const clauses = ['a.workspace_id = ?'];
  const params: unknown[] = [ctx.workspaceId];
  if (typeof input.fromDate === 'string' && input.fromDate.length > 0) {
    clauses.push('a.effective_date >= ?');
    params.push(input.fromDate.slice(0, 10));
  }
  if (typeof input.toDate === 'string' && input.toDate.length > 0) {
    clauses.push('a.effective_date <= ?');
    params.push(input.toDate.slice(0, 10));
  }

  const selects = groupBy.map((d) => GROUP_SQL[d].select).join(', ');
  const keys = groupBy.map((d) => GROUP_SQL[d].key).join(', ');
  const rows = ctx.store.db
    .prepare(
      `SELECT ${selects},
              COUNT(*) AS adjustmentCount,
              COALESCE(SUM(a.qty_delta), 0) AS qtyDelta,
              COALESCE(SUM(CASE WHEN a.unit_cost_minor IS NULL THEN 0 ELSE a.qty_delta * a.unit_cost_minor END), 0) AS valueImpactMinor
         FROM inventory_adjustment a
         JOIN inventory_reason_code r ON r.id = a.reason_code_id
         JOIN item i ON i.id = a.item_id
         JOIN stock_location l ON l.id = a.location_id
        WHERE ${clauses.join(' AND ')}
        GROUP BY ${keys}
        ORDER BY ${keys}`,
    )
    .all(...params) as Record<string, unknown>[];

  return ok({ groupBy, rows });
}
