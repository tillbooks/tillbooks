/**
 * D01 stock movements: the OP2 non-posting quantity ledger, plus the on-hand and low-stock read
 * models (P5). A movement records QUANTITY only, never money on the account ledger. Since K68
 * `stock_run_valuation` is REPORT-ONLY (it computes and returns the valuation but mints no journal
 * entry); the sole path inventory value reaches the books is J06 `inventory_valuation_post` (P3).
 * §H-TENANT on every query; §H-IDEMPOTENT on every write (the unique (workspace, key) index plus an
 * explicit replay).
 *
 * Quantities are integer units. `qty` is stored SIGNED: `receipt`/`return` add, `issue` subtracts,
 * `adjust` keeps the caller's sign (a stocktake shrink is negative), `transfer` writes a paired
 * issue+receipt across two locations in one transaction. On-hand may only go negative when the caller
 * passes `allowNegative` (the workspace `allow_negative_stock` posture, spec §2 D01.1 boundary);
 * otherwise a move that would drive it negative is refused with `insufficient_stock` and the
 * available quantity (P9).
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { isStockReason } from './enums.js';
import type { StockReason } from './enums.js';
import { findItem, findLocation, onHandFor, itemOnHand } from './shared.js';
// J00: when a movement omits location_id, resolve the workspace default (creating the MAIN/DEFAULT
// pair on first use). Imported from the J00 module, which imports NOTHING from `../stock/`, so there
// is no cycle (spec §4 D01 compatibility).
import { resolveOrCreateDefaultLocationId } from '../inventory/defaults.js';

export interface StockMoveInput {
  itemId?: string;
  locationId?: string;
  toLocationId?: string;
  qty?: number;
  reason?: string;
  unitCostMinor?: number;
  movedAt?: string;
  refKind?: string;
  refId?: string;
  allowNegative?: boolean;
  idempotencyKey?: string;
}

export interface MovementRow {
  id: string;
  itemId: string;
  locationId: string;
  qty: number;
  reason: StockReason;
  unitCostMinor: number | null;
  movedAt: string;
}

function mapMovement(r: {
  id: string;
  item_id: string;
  location_id: string;
  qty: number;
  reason: string;
  unit_cost_minor: number | null;
  moved_at: string;
}): MovementRow {
  return {
    id: r.id,
    itemId: r.item_id,
    locationId: r.location_id,
    qty: r.qty,
    reason: r.reason as StockReason,
    unitCostMinor: r.unit_cost_minor,
    movedAt: r.moved_at,
  };
}

function movementByKey(ctx: WorkspaceContext, key: string): MovementRow | undefined {
  const row = ctx.store.db
    .prepare(
      'SELECT id, item_id, location_id, qty, reason, unit_cost_minor, moved_at FROM stock_movement WHERE workspace_id = ? AND idempotency_key = ?',
    )
    .get(ctx.workspaceId, key) as
    | { id: string; item_id: string; location_id: string; qty: number; reason: string; unit_cost_minor: number | null; moved_at: string }
    | undefined;
  return row === undefined ? undefined : mapMovement(row);
}

/**
 * The ONE row insert for a movement (spec §7: stocktake mints movements through here too, no direct
 * insert). Callers validate and guard first; this only writes.
 */
export function insertMovement(
  ctx: WorkspaceContext,
  m: {
    itemId: string;
    locationId: string;
    qty: number;
    reason: StockReason;
    unitCostMinor: number | null;
    movedAt: string;
    refKind: string | null;
    refId: string | null;
    idempotencyKey: string;
  },
): MovementRow {
  const id = ctx.ids.next('stockmv');
  ctx.store.db
    .prepare(
      `INSERT INTO stock_movement
         (id, workspace_id, item_id, location_id, qty, reason, unit_cost_minor, moved_at, ref_kind, ref_id, idempotency_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      ctx.workspaceId,
      m.itemId,
      m.locationId,
      m.qty,
      m.reason,
      m.unitCostMinor,
      m.movedAt,
      m.refKind,
      m.refId,
      m.idempotencyKey,
      ctx.clock.now(),
    );
  return mapMovement({
    id,
    item_id: m.itemId,
    location_id: m.locationId,
    qty: m.qty,
    reason: m.reason,
    unit_cost_minor: m.unitCostMinor,
    moved_at: m.movedAt,
  });
}

/** Did this net change to an item's total on-hand cross the reorder point from above to at/below it? */
function crossedReorder(reorder: number | null, before: number, after: number): boolean {
  return reorder !== null && before > reorder && after <= reorder;
}

export function recordStockMove(ctx: WorkspaceContext, input: StockMoveInput): Result {
  const capable = ctx.capabilities.assert('manage_master_data');
  if (!capable.ok) return capable;

  if (!isStockReason(input.reason)) return err('invalid_reason', { reason: input.reason });
  const reason = input.reason;
  if (typeof input.qty !== 'number' || !Number.isInteger(input.qty) || input.qty === 0) {
    return err('invalid_qty', { qty: input.qty });
  }
  if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length === 0) {
    return err('invalid_input', { field: 'idempotencyKey' });
  }
  if (input.unitCostMinor !== undefined && (!Number.isInteger(input.unitCostMinor) || input.unitCostMinor < 0)) {
    return err('invalid_input', { field: 'unitCostMinor' });
  }

  const item = findItem(ctx, input.itemId);
  if (item === undefined) return err('not_found', { itemId: input.itemId });
  // J00 (spec §4): location_id is now OPTIONAL. An omitted id resolves to the workspace default
  // location (provisioning MAIN/DEFAULT on first use), so a single-location caller never supplies one;
  // an explicit id passes straight through and is validated exactly as before.
  const resolvedLocationId = resolveOrCreateDefaultLocationId(ctx, input.locationId);
  const location = findLocation(ctx, resolvedLocationId);
  if (location === undefined) return err('not_found', { locationId: input.locationId });

  const movedAt = (input.movedAt ?? ctx.clock.now().slice(0, 10)).slice(0, 10);
  const unitCostMinor = input.unitCostMinor ?? null;
  const refKind = input.refKind ?? null;
  const refId = input.refId ?? null;
  const allowNegative = input.allowNegative === true;

  // §H-IDEMPOTENT: a replay of the same key returns the original movement(s), never a second row.
  const replay = movementByKey(ctx, input.idempotencyKey);
  if (replay !== undefined) {
    // Same field ORDER and values as the fresh success below, so a replay is byte-identical (the
    // conformance double-call diffs the serialised result). A replay never re-emits a low-stock
    // crossing: the occurrence fired on the first call only.
    return ok({
      movements: [replay],
      onHand: onHandFor(ctx, item.id, replay.locationId),
      itemOnHand: itemOnHand(ctx, item.id),
      lowStockReachedItemId: null,
    });
  }

  // §H-PERIOD, before any mint: the movement is dated `movedAt`, and on-hand as-of a sealed date is a
  // statutory Bestandesnachweis (OR 958c), so a `stock_movement` may not be written into a locked or
  // sealed period. This sits AFTER the idempotency replay (a replay of an action taken while the period
  // was open must still return its original rows) and BEFORE any insert, so a refusal mints ZERO rows.
  // Same guard, same structured `period_locked` refusal, as the inventory path (spec §7). Covers every
  // caller of this verb: a direct stock.move, D02 goods-receipt and D03 delivery all route through here.
  const periodOpen = ctx.periods.assertOpen(movedAt);
  if (!periodOpen.ok) return periodOpen;

  const beforeItemTotal = itemOnHand(ctx, item.id);

  if (reason === 'transfer') {
    const dest = findLocation(ctx, input.toLocationId);
    if (dest === undefined) return err('not_found', { toLocationId: input.toLocationId });
    if (dest.id === location.id) return err('invalid_input', { field: 'toLocationId', reason: 'same location' });
    const magnitude = Math.abs(input.qty);
    const sourceOnHand = onHandFor(ctx, item.id, location.id);
    if (!allowNegative && sourceOnHand - magnitude < 0) {
      return err('insufficient_stock', { itemId: item.id, locationId: location.id, available: sourceOnHand });
    }
    const out = insertMovement(ctx, {
      itemId: item.id,
      locationId: location.id,
      qty: -magnitude,
      reason,
      unitCostMinor,
      movedAt,
      refKind,
      refId,
      idempotencyKey: input.idempotencyKey,
    });
    const into = insertMovement(ctx, {
      itemId: item.id,
      locationId: dest.id,
      qty: magnitude,
      reason,
      unitCostMinor,
      movedAt,
      refKind,
      refId,
      idempotencyKey: `${input.idempotencyKey}#in`,
    });
    // A transfer nets zero on the item's TOTAL on-hand, so it never crosses the reorder point.
    return ok({ movements: [out, into], onHand: onHandFor(ctx, item.id, location.id), itemOnHand: beforeItemTotal, lowStockReachedItemId: null });
  }

  // A single-leg move. The stored sign is derived from the reason so the caller's magnitude means
  // what they said; `adjust` alone keeps the sign it was given (a stocktake shrink is negative).
  let signed: number;
  if (reason === 'issue') signed = -Math.abs(input.qty);
  else if (reason === 'receipt' || reason === 'return') signed = Math.abs(input.qty);
  else signed = input.qty; // adjust

  if (!allowNegative && signed < 0) {
    const onHand = onHandFor(ctx, item.id, location.id);
    if (onHand + signed < 0) {
      return err('insufficient_stock', { itemId: item.id, locationId: location.id, available: onHand });
    }
  }

  const movement = insertMovement(ctx, {
    itemId: item.id,
    locationId: location.id,
    qty: signed,
    reason,
    unitCostMinor,
    movedAt,
    refKind,
    refId,
    idempotencyKey: input.idempotencyKey,
  });

  const afterItemTotal = beforeItemTotal + signed;
  const crossing = crossedReorder(item.reorder_point_qty, beforeItemTotal, afterItemTotal);
  return ok({
    movements: [movement],
    onHand: onHandFor(ctx, item.id, location.id),
    itemOnHand: afterItemTotal,
    // The null-collapse the automation registry relies on (events.ts): the low-stock event's
    // occurrence id is present ONLY on a downward crossing, so a move that does not cross emits nothing.
    lowStockReachedItemId: crossing ? item.id : null,
  });
}

/** The on-hand read model (P5): one row per item x location that has ever moved, plus the pickers. */
export function stockOnHand(ctx: WorkspaceContext, input: { itemId?: string; locationId?: string; asOf?: string }): Result {
  const asOf = typeof input.asOf === 'string' ? input.asOf.slice(0, 10) : undefined;
  const clauses: string[] = ['m.workspace_id = ?'];
  const params: unknown[] = [ctx.workspaceId];
  if (typeof input.itemId === 'string' && input.itemId.length > 0) {
    clauses.push('m.item_id = ?');
    params.push(input.itemId);
  }
  if (typeof input.locationId === 'string' && input.locationId.length > 0) {
    clauses.push('m.location_id = ?');
    params.push(input.locationId);
  }
  if (asOf !== undefined) {
    clauses.push('m.moved_at <= ?');
    params.push(asOf);
  }
  const rows = ctx.store.db
    .prepare(
      `SELECT m.item_id AS itemId, i.name AS itemName, m.location_id AS locationId, l.name AS locationName,
              COALESCE(SUM(m.qty), 0) AS onHand
         FROM stock_movement m
         JOIN item i ON i.id = m.item_id
         JOIN stock_location l ON l.id = m.location_id
        WHERE ${clauses.join(' AND ')}
        GROUP BY m.item_id, m.location_id
        ORDER BY i.name, l.name`,
    )
    .all(...params) as { itemId: string; itemName: string; locationId: string; locationName: string; onHand: number }[];

  const locations = ctx.store.db
    .prepare('SELECT id, name, type, archived FROM stock_location WHERE workspace_id = ? AND archived = 0 ORDER BY name')
    .all(ctx.workspaceId) as { id: string; name: string; type: string | null; archived: number }[];

  const trackedItems = ctx.store.db
    .prepare('SELECT id, name FROM item WHERE workspace_id = ? AND track_stock = 1 ORDER BY name')
    .all(ctx.workspaceId) as { id: string; name: string }[];

  return ok({
    rows,
    locations: locations.map((l) => ({ id: l.id, name: l.name, type: l.type, archived: l.archived === 1 })),
    items: trackedItems,
  });
}

/** Items at or below their D00 reorder point (spec §2 D01.3). Empty is not an error. */
export function lowStockList(ctx: WorkspaceContext): Result {
  const rows = ctx.store.db
    .prepare(
      `SELECT i.id AS itemId, i.name AS itemName, i.reorder_point_qty AS reorderPoint,
              COALESCE((SELECT SUM(qty) FROM stock_movement m WHERE m.workspace_id = i.workspace_id AND m.item_id = i.id), 0) AS onHand
         FROM item i
        WHERE i.workspace_id = ? AND i.track_stock = 1 AND i.reorder_point_qty IS NOT NULL
        ORDER BY i.name`,
    )
    .all(ctx.workspaceId) as { itemId: string; itemName: string; reorderPoint: number; onHand: number }[];
  const low = rows.filter((r) => r.onHand <= r.reorderPoint);
  return ok({ items: low });
}
