/**
 * J00 warehouses (US-J00.1): CRUD for the physical or logical sites stock lives at. PLAIN MASTER
 * DATA, no money path (nothing here posts a journal entry). Every read and write is scoped to
 * `ctx.workspaceId` (§H-TENANT); every write takes an idempotency key (§H-IDEMPOTENT). A warehouse is
 * NEVER deleted, only soft-archived (`active = 0`), because a location under it must stay resolvable
 * for the movements written against it (spec §6, the H00 category reasoning).
 *
 * EXACTLY ONE default warehouse per workspace, enforced by the partial-unique index and by clearing
 * the previous default in the SAME transaction before seating the new one (the index forbids two rows
 * carrying is_default = 1 even for an instant). The first warehouse a workspace ever creates becomes
 * the default automatically, so a workspace never holds warehouses with no default to resolve an
 * omitted location_id against.
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { mapWarehouse } from './types.js';
import type { WarehouseRow } from './types.js';

const CODE_MAX = 20;

function readWarehouse(ctx: WorkspaceContext, id: string): WarehouseRow | undefined {
  return ctx.store.db
    .prepare('SELECT * FROM warehouse WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, id) as WarehouseRow | undefined;
}

/** A warehouse whose lower(code) already exists in this workspace, other than `exceptId`. */
function codeTaken(ctx: WorkspaceContext, code: string, exceptId?: string): boolean {
  const row = ctx.store.db
    .prepare('SELECT id FROM warehouse WHERE workspace_id = ? AND lower(code) = lower(?) AND id != ? LIMIT 1')
    .get(ctx.workspaceId, code, exceptId ?? '') as { id: string } | undefined;
  return row !== undefined;
}

function hasAnyDefault(ctx: WorkspaceContext): boolean {
  const row = ctx.store.db
    .prepare('SELECT id FROM warehouse WHERE workspace_id = ? AND is_default = 1 LIMIT 1')
    .get(ctx.workspaceId) as { id: string } | undefined;
  return row !== undefined;
}

/** Clear whatever warehouse currently holds is_default in this workspace. Must run before seating a new one. */
function clearDefault(ctx: WorkspaceContext, now: string): void {
  ctx.store.db
    .prepare('UPDATE warehouse SET is_default = 0, updated_at = ? WHERE workspace_id = ? AND is_default = 1')
    .run(now, ctx.workspaceId);
}

export interface CreateWarehouseInput {
  code?: string;
  name?: string;
  description?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  postalCode?: string | null;
  city?: string | null;
  countryCode?: string;
  isDefault?: boolean;
  idempotencyKey?: string;
}

export function warehouseCreate(ctx: WorkspaceContext, input: CreateWarehouseInput): Result {
  const capable = ctx.capabilities.assert('manage_master_data');
  if (!capable.ok) return capable;

  // Replay a completed create BEFORE the duplicate-code guard (§H-IDEMPOTENT, the H00 order): a plain
  // retry under the same key must return the row the first call wrote, not fire duplicate_code on it.
  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    const replayed = ctx.store.recallIdempotent<Result>(ctx.workspaceId, input.idempotencyKey, 'warehouse_create');
    if (replayed !== undefined) return replayed;
  }

  const code = typeof input.code === 'string' ? input.code.trim() : '';
  if (code.length === 0 || code.length > CODE_MAX) return err('invalid_code', { code });
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (name.length === 0) return err('invalid_input', { field: 'name' });
  if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length === 0) {
    return err('invalid_input', { field: 'idempotencyKey' });
  }
  if (codeTaken(ctx, code)) return err('duplicate_code', { code });

  const run = (): Result => {
    // Re-check inside the transaction: the friendly error is above, this is the honest race window.
    if (codeTaken(ctx, code)) return err('duplicate_code', { code });
    const now = ctx.clock.now();
    // The first warehouse a workspace creates becomes the default; otherwise honour the caller's flag.
    const makeDefault = input.isDefault === true || !hasAnyDefault(ctx);
    if (makeDefault) clearDefault(ctx, now);
    const id = ctx.ids.next('warehouse');
    ctx.store.db
      .prepare(
        `INSERT INTO warehouse
           (id, workspace_id, code, name, description, address_line1, address_line2, postal_code, city,
            country_code, is_default, active, created_at, updated_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      )
      .run(
        id,
        ctx.workspaceId,
        code,
        name,
        input.description ?? null,
        input.addressLine1 ?? null,
        input.addressLine2 ?? null,
        input.postalCode ?? null,
        input.city ?? null,
        (typeof input.countryCode === 'string' && input.countryCode.trim() !== ''
          ? input.countryCode.trim().toUpperCase()
          : 'CH'),
        makeDefault ? 1 : 0,
        now,
        now,
        ctx.actor,
      );
    return ok({ warehouse: mapWarehouse(readWarehouse(ctx, id) as WarehouseRow) });
  };

  return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'warehouse_create', run);
}

export interface UpdateWarehouseInput {
  warehouseId?: string;
  patch?: {
    name?: string;
    description?: string | null;
    addressLine1?: string | null;
    addressLine2?: string | null;
    postalCode?: string | null;
    city?: string | null;
    countryCode?: string;
  };
  idempotencyKey?: string;
}

export function warehouseUpdate(ctx: WorkspaceContext, input: UpdateWarehouseInput): Result {
  const capable = ctx.capabilities.assert('manage_master_data');
  if (!capable.ok) return capable;
  if (typeof input.warehouseId !== 'string' || input.warehouseId.length === 0) {
    return err('invalid_input', { field: 'warehouseId' });
  }
  const current = readWarehouse(ctx, input.warehouseId);
  if (current === undefined) return err('not_found', { warehouseId: input.warehouseId });
  const patch = input.patch ?? {};
  const name = patch.name !== undefined ? patch.name.trim() : current.name;
  if (name.length === 0) return err('invalid_input', { field: 'name' });

  const run = (): Result => {
    ctx.store.db
      .prepare(
        `UPDATE warehouse SET name = ?, description = ?, address_line1 = ?, address_line2 = ?,
           postal_code = ?, city = ?, country_code = ?, updated_at = ?
         WHERE workspace_id = ? AND id = ?`,
      )
      .run(
        name,
        patch.description !== undefined ? patch.description : current.description,
        patch.addressLine1 !== undefined ? patch.addressLine1 : current.address_line1,
        patch.addressLine2 !== undefined ? patch.addressLine2 : current.address_line2,
        patch.postalCode !== undefined ? patch.postalCode : current.postal_code,
        patch.city !== undefined ? patch.city : current.city,
        patch.countryCode !== undefined && patch.countryCode.trim() !== ''
          ? patch.countryCode.trim().toUpperCase()
          : current.country_code,
        ctx.clock.now(),
        ctx.workspaceId,
        input.warehouseId,
      );
    return ok({ warehouse: mapWarehouse(readWarehouse(ctx, input.warehouseId as string) as WarehouseRow) });
  };
  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'warehouse_update', run);
  }
  return run();
}

export function warehouseSetDefault(
  ctx: WorkspaceContext,
  input: { warehouseId?: string; idempotencyKey?: string },
): Result {
  const capable = ctx.capabilities.assert('manage_master_data');
  if (!capable.ok) return capable;
  if (typeof input.warehouseId !== 'string' || input.warehouseId.length === 0) {
    return err('invalid_input', { field: 'warehouseId' });
  }
  const run = (): Result => {
    const current = readWarehouse(ctx, input.warehouseId as string);
    if (current === undefined) return err('not_found', { warehouseId: input.warehouseId });
    if (current.active !== 1) return err('warehouse_archived', { warehouseId: input.warehouseId });
    const now = ctx.clock.now();
    if (current.is_default !== 1) {
      // Clear the previous default FIRST: the partial-unique index forbids two rows at is_default = 1.
      clearDefault(ctx, now);
      ctx.store.db
        .prepare('UPDATE warehouse SET is_default = 1, updated_at = ? WHERE workspace_id = ? AND id = ?')
        .run(now, ctx.workspaceId, input.warehouseId);
    }
    return ok({ warehouse: mapWarehouse(readWarehouse(ctx, input.warehouseId as string) as WarehouseRow) });
  };
  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'warehouse_set_default', run);
  }
  return run();
}

export function warehouseArchive(
  ctx: WorkspaceContext,
  input: { warehouseId?: string; idempotencyKey?: string },
): Result {
  const capable = ctx.capabilities.assert('manage_master_data');
  if (!capable.ok) return capable;
  if (typeof input.warehouseId !== 'string' || input.warehouseId.length === 0) {
    return err('invalid_input', { field: 'warehouseId' });
  }
  const run = (): Result => {
    const current = readWarehouse(ctx, input.warehouseId as string);
    if (current === undefined) return err('not_found', { warehouseId: input.warehouseId });
    // The workspace default cannot be retired: an omitted location_id would have nothing to resolve to.
    if (current.is_default === 1) return err('cannot_archive_default', { warehouseId: input.warehouseId });

    // A warehouse archives only when every active location under it is EMPTY and not in use. Any
    // active location still holding stock refuses the whole archive (location_has_stock); an open
    // stocktake refuses it (location_in_use). The check reuses the per-location guards' SQL.
    const activeLocations = ctx.store.db
      .prepare('SELECT id FROM stock_location WHERE workspace_id = ? AND warehouse_id = ? AND archived = 0')
      .all(ctx.workspaceId, current.id) as { id: string }[];
    for (const loc of activeLocations) {
      const stock = ctx.store.db
        .prepare('SELECT COALESCE(SUM(qty), 0) AS n FROM stock_movement WHERE workspace_id = ? AND location_id = ?')
        .get(ctx.workspaceId, loc.id) as { n: number };
      if (stock.n !== 0) return err('location_has_stock', { locationId: loc.id });
      const inUse = ctx.store.db
        .prepare(
          `SELECT 1 AS x FROM stocktake_session WHERE workspace_id = ? AND status = 'open' AND location_id = ?
           UNION
           SELECT 1 AS x FROM stocktake_line l JOIN stocktake_session s ON s.id = l.session_id
             WHERE l.workspace_id = ? AND s.status = 'open' AND l.location_id = ? LIMIT 1`,
        )
        .get(ctx.workspaceId, loc.id, ctx.workspaceId, loc.id) as { x: number } | undefined;
      if (inUse !== undefined) return err('location_in_use', { locationId: loc.id });
    }

    if (current.active === 1) {
      const now = ctx.clock.now();
      // Cascade-archive the (now provably empty) active locations, so the warehouse is not left
      // holding live locations that point at an archived site (spec §6: archived or empty).
      ctx.store.db
        .prepare('UPDATE stock_location SET archived = 1, is_default_for_warehouse = 0 WHERE workspace_id = ? AND warehouse_id = ? AND archived = 0')
        .run(ctx.workspaceId, current.id);
      ctx.store.db
        .prepare('UPDATE warehouse SET active = 0, updated_at = ? WHERE workspace_id = ? AND id = ?')
        .run(now, ctx.workspaceId, current.id);
    }
    return ok({ warehouse: mapWarehouse(readWarehouse(ctx, input.warehouseId as string) as WarehouseRow) });
  };
  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'warehouse_archive', run);
  }
  return run();
}

export interface ListWarehousesInput {
  active?: boolean;
  search?: string;
  savedViewId?: string;
}

export function warehouseList(ctx: WorkspaceContext, input: ListWarehousesInput = {}): Result {
  const clauses = ['workspace_id = ?'];
  const params: unknown[] = [ctx.workspaceId];
  if (typeof input.active === 'boolean') {
    clauses.push('active = ?');
    params.push(input.active ? 1 : 0);
  }
  if (typeof input.search === 'string' && input.search.trim().length > 0) {
    clauses.push('(lower(code) LIKE ? OR lower(name) LIKE ?)');
    const like = `%${input.search.trim().toLowerCase()}%`;
    params.push(like, like);
  }
  const rows = ctx.store.db
    .prepare(`SELECT * FROM warehouse WHERE ${clauses.join(' AND ')} ORDER BY is_default DESC, code`)
    .all(...params) as WarehouseRow[];
  return ok({ warehouses: rows.map(mapWarehouse) });
}

export function warehouseGet(ctx: WorkspaceContext, input: { warehouseId?: string }): Result {
  if (typeof input.warehouseId !== 'string' || input.warehouseId.length === 0) {
    return err('invalid_input', { field: 'warehouseId' });
  }
  const row = readWarehouse(ctx, input.warehouseId);
  if (row === undefined) return err('not_found', { warehouseId: input.warehouseId });
  return ok({ warehouse: mapWarehouse(row) });
}
