/**
 * J00 default provisioning (US-J00.3): the workspace default warehouse + location every legacy D01
 * caller and single-location user resolves to when they omit `location_id`.
 *
 * THIS MODULE IMPORTS NOTHING FROM `../stock/`. `stock/movements.ts` calls `resolveOrCreateDefaultLocationId`
 * to default an omitted `location_id`, so a dependency the other way would be a cycle. Everything here
 * reads and writes the `warehouse` and `stock_location` tables directly.
 *
 * `ensureDefaultLocation` is idempotent and RACE-SAFE: the MAIN/DEFAULT pair is seated inside one
 * transaction guarded by the two partial-unique indexes (one default warehouse per workspace, one
 * default location per warehouse), so two concurrent callers cannot mint two pairs. The loser's
 * transaction throws on the unique violation, rolls back, and re-reads the winner's rows.
 */

import type { WorkspaceContext } from '../context.js';

export interface DefaultPair {
  warehouseId: string;
  locationId: string;
}

/**
 * The workspace default location id: the default location of the default warehouse, when both exist
 * and are active. Undefined when the workspace has never provisioned a default (a pure D01 workspace
 * that has not yet called any J00 verb). A pure READ, never a write.
 */
export function resolveDefaultPair(ctx: WorkspaceContext): DefaultPair | undefined {
  const row = ctx.store.db
    .prepare(
      `SELECT w.id AS warehouseId, l.id AS locationId
         FROM warehouse w
         JOIN stock_location l ON l.warehouse_id = w.id AND l.workspace_id = w.workspace_id
        WHERE w.workspace_id = ? AND w.is_default = 1 AND w.active = 1
          AND l.is_default_for_warehouse = 1 AND l.archived = 0
        LIMIT 1`,
    )
    .get(ctx.workspaceId) as { warehouseId: string; locationId: string } | undefined;
  return row === undefined ? undefined : { warehouseId: row.warehouseId, locationId: row.locationId };
}

/** The default location id alone, or undefined. */
export function resolveDefaultLocationId(ctx: WorkspaceContext): string | undefined {
  return resolveDefaultPair(ctx)?.locationId;
}

/**
 * Ensure the workspace has a default warehouse + location, creating the MAIN / DEFAULT pair if absent,
 * and return them. Idempotent and race-safe (see the module header).
 */
export function ensureDefaultLocation(ctx: WorkspaceContext): DefaultPair {
  const existing = resolveDefaultPair(ctx);
  if (existing !== undefined) return existing;

  try {
    return ctx.store.tx(() => {
      // Re-check inside the transaction: a writer that lost the read race above must not seat a second
      // pair. Returning here COMMITS an empty transaction, which is correct (nothing was written).
      const again = resolveDefaultPair(ctx);
      if (again !== undefined) return again;

      const now = ctx.clock.now();
      const warehouseId = ctx.ids.next('warehouse');
      ctx.store.db
        .prepare(
          `INSERT INTO warehouse
             (id, workspace_id, code, name, description, country_code, is_default, active, created_at, updated_at, created_by)
           VALUES (?, ?, 'MAIN', 'Main Warehouse', NULL, 'CH', 1, 1, ?, ?, ?)`,
        )
        .run(warehouseId, ctx.workspaceId, now, now, ctx.actor);

      const locationId = ctx.ids.next('stockloc');
      const path = `/${locationId}/`;
      ctx.store.db
        .prepare(
          `INSERT INTO stock_location
             (id, workspace_id, name, type, archived, created_at, warehouse_id, code, parent_id, location_type, path, depth, is_default_for_warehouse)
           VALUES (?, ?, 'Default Location', NULL, 0, ?, ?, 'DEFAULT', NULL, NULL, ?, 0, 1)`,
        )
        .run(locationId, ctx.workspaceId, now, warehouseId, path);

      return { warehouseId, locationId };
    });
  } catch (e) {
    // A concurrent caller seated the pair between our read and our transaction, and the partial-unique
    // index threw. That is success by another route: re-read the winner's rows.
    const raced = resolveDefaultPair(ctx);
    if (raced !== undefined) return raced;
    throw e;
  }
}

/**
 * Resolve an explicit `location_id`, or fall back to the workspace default (creating MAIN/DEFAULT if
 * needed). The seam `stock/movements.ts` uses to make `location_id` optional (spec §4 D01
 * compatibility). Returns undefined ONLY when an explicit id was given as a non-string: the caller
 * then reports its own `not_found`, so this never masks a bad id.
 */
export function resolveOrCreateDefaultLocationId(ctx: WorkspaceContext, explicit: unknown): string | undefined {
  if (typeof explicit === 'string' && explicit.length > 0) return explicit;
  if (explicit !== undefined && explicit !== null && explicit !== '') return undefined;
  return ensureDefaultLocation(ctx).locationId;
}
