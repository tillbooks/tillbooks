/**
 * D01 shared reads: the on-hand read model (P5) and the tenant-scoped existence checks every stock
 * verb funnels through. On-hand is ALWAYS `Σ qty` of `stock_movement` (never a cached mutable
 * column), so it cannot drift from the OP2 ledger. §H-TENANT: every query scopes by `workspace_id`.
 */

import type { WorkspaceContext } from '../context.js';

export interface ItemRow {
  id: string;
  name: string;
  cost_price_minor: number | null;
  track_stock: number;
  reorder_point_qty: number | null;
}

export interface LocationRow {
  id: string;
  name: string;
  type: string | null;
  archived: number;
}

/** The item row, scoped to this workspace (§H-TENANT), or undefined when it is not this tenant's. */
export function findItem(ctx: WorkspaceContext, itemId: unknown): ItemRow | undefined {
  if (typeof itemId !== 'string' || itemId.length === 0) return undefined;
  return ctx.store.db
    .prepare(
      'SELECT id, name, cost_price_minor, track_stock, reorder_point_qty FROM item WHERE workspace_id = ? AND id = ?',
    )
    .get(ctx.workspaceId, itemId) as ItemRow | undefined;
}

/** The location row, scoped to this workspace (§H-TENANT). */
export function findLocation(ctx: WorkspaceContext, locationId: unknown): LocationRow | undefined {
  if (typeof locationId !== 'string' || locationId.length === 0) return undefined;
  return ctx.store.db
    .prepare('SELECT id, name, type, archived FROM stock_location WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, locationId) as LocationRow | undefined;
}

/** On-hand for one item x location as of a date (inclusive), or all-time when `asOf` is absent. */
export function onHandFor(
  ctx: WorkspaceContext,
  itemId: string,
  locationId: string,
  asOf?: string,
): number {
  const row = ctx.store.db
    .prepare(
      `SELECT COALESCE(SUM(qty), 0) AS n FROM stock_movement
        WHERE workspace_id = ? AND item_id = ? AND location_id = ?
          ${asOf !== undefined ? 'AND moved_at <= ?' : ''}`,
    )
    .get(...(asOf !== undefined ? [ctx.workspaceId, itemId, locationId, asOf] : [ctx.workspaceId, itemId, locationId])) as {
    n: number;
  };
  return row.n;
}

/** Total on-hand for one item across every location, as of a date (inclusive) or all-time. */
export function itemOnHand(ctx: WorkspaceContext, itemId: string, asOf?: string): number {
  const row = ctx.store.db
    .prepare(
      `SELECT COALESCE(SUM(qty), 0) AS n FROM stock_movement
        WHERE workspace_id = ? AND item_id = ?
          ${asOf !== undefined ? 'AND moved_at <= ?' : ''}`,
    )
    .get(...(asOf !== undefined ? [ctx.workspaceId, itemId, asOf] : [ctx.workspaceId, itemId])) as { n: number };
  return row.n;
}

/** Every distinct item x location pair that has ever had a movement in this workspace, with on-hand. */
export interface OnHandRow {
  itemId: string;
  itemName: string;
  locationId: string;
  locationName: string;
  onHand: number;
}
