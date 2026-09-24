/**
 * J00 balance-by-location (US-J00.4): the PURE READ MODEL over the OP2 movement ledger. On-hand for an
 * (item, location) pair is always the live `SUM(stock_movement.qty)` for that exact location, never a
 * cached mutable column (OP13 / §H-STOCK-AUDIT), so it cannot drift from the ledger. Quantities are
 * integer units, the unit D01's own `stock_movement.qty` uses. §H-TENANT on every query.
 *
 * `ensureDefaultLocation` and `inventoryBalanceByLocation` are the two agent-facing seam verbs J01
 * (lot/serial) and J02 (movement ledger) build on: a balance row already carries the warehouse
 * roll-up they need, and the default resolver removes every "which location?" ambiguity.
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { ensureDefaultLocation as ensure } from './defaults.js';

export interface BalanceFilter {
  itemId?: string;
  warehouseId?: string;
  locationId?: string;
  includeZero?: boolean;
}

export function inventoryBalanceByLocation(ctx: WorkspaceContext, input: BalanceFilter = {}): Result {
  const clauses = ['m.workspace_id = ?'];
  const params: unknown[] = [ctx.workspaceId];
  if (typeof input.itemId === 'string' && input.itemId.length > 0) {
    clauses.push('m.item_id = ?');
    params.push(input.itemId);
  }
  if (typeof input.locationId === 'string' && input.locationId.length > 0) {
    clauses.push('m.location_id = ?');
    params.push(input.locationId);
  }
  if (typeof input.warehouseId === 'string' && input.warehouseId.length > 0) {
    clauses.push('l.warehouse_id = ?');
    params.push(input.warehouseId);
  }
  const having = input.includeZero === true ? '' : 'HAVING COALESCE(SUM(m.qty), 0) != 0';

  const rows = ctx.store.db
    .prepare(
      `SELECT m.item_id AS itemId, i.name AS itemName,
              m.location_id AS locationId, l.code AS locationCode, l.name AS locationName,
              l.warehouse_id AS warehouseId, w.code AS warehouseCode, w.name AS warehouseName,
              COALESCE(SUM(m.qty), 0) AS qty
         FROM stock_movement m
         JOIN item i ON i.id = m.item_id
         JOIN stock_location l ON l.id = m.location_id
         LEFT JOIN warehouse w ON w.id = l.warehouse_id
        WHERE ${clauses.join(' AND ')}
        GROUP BY m.item_id, m.location_id
        ${having}
        ORDER BY i.name, w.code, l.code`,
    )
    .all(...params) as {
    itemId: string;
    itemName: string;
    locationId: string;
    locationCode: string | null;
    locationName: string;
    warehouseId: string | null;
    warehouseCode: string | null;
    warehouseName: string | null;
    qty: number;
  }[];

  // The warehouse roll-up (spec §2 US-J00.4): the same numbers aggregated by item x warehouse.
  const rollup = new Map<string, { itemId: string; itemName: string; warehouseId: string | null; warehouseCode: string | null; warehouseName: string | null; qty: number }>();
  for (const r of rows) {
    const key = `${r.itemId}|${r.warehouseId ?? ''}`;
    const acc = rollup.get(key);
    if (acc === undefined) {
      rollup.set(key, {
        itemId: r.itemId,
        itemName: r.itemName,
        warehouseId: r.warehouseId,
        warehouseCode: r.warehouseCode,
        warehouseName: r.warehouseName,
        qty: r.qty,
      });
    } else {
      acc.qty += r.qty;
    }
  }

  return ok({ rows, warehouseTotals: [...rollup.values()] });
}

export function inventoryEnsureDefaultLocation(ctx: WorkspaceContext): Result {
  const capable = ctx.capabilities.assert('manage_master_data');
  if (!capable.ok) return capable;
  const pair = ensure(ctx);
  const warehouse = ctx.store.db
    .prepare('SELECT id, code, name, is_default AS isDefault FROM warehouse WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, pair.warehouseId) as { id: string; code: string; name: string; isDefault: number } | undefined;
  const location = ctx.store.db
    .prepare('SELECT id, code, name FROM stock_location WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, pair.locationId) as { id: string; code: string | null; name: string } | undefined;
  if (warehouse === undefined || location === undefined) return err('not_found', {});
  return ok({
    warehouse: { id: warehouse.id, code: warehouse.code, name: warehouse.name, isDefault: warehouse.isDefault === 1 },
    location: { id: location.id, code: location.code, name: location.name },
  });
}
