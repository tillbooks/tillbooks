/**
 * J00 locations (US-J00.2/.6): the nested tree under a warehouse. A location IS a `stock_location` row
 * (spec §4 Reconciliation), so these verbs write the D01 table's J00 hierarchy columns
 * (`warehouse_id`, `code`, `parent_id`, `location_type`, `path`, `depth`, `is_default_for_warehouse`)
 * and leave the D01 columns alone. PLAIN MASTER DATA, no money path. §H-TENANT on every query;
 * §H-IDEMPOTENT on every write.
 *
 * The hierarchy integrity rules are enforced in the verb, before any write:
 *  - code unique within the warehouse, case-insensitive (duplicate_code, race-guarded by the index),
 *  - a parent must belong to the SAME warehouse (parent_warehouse_mismatch),
 *  - a re-parent may never create a cycle (location_cycle),
 *  - `path` is a materialised "/ancestor/.../self/" string kept current on create and re-parent, so a
 *    descendant sweep is one `path LIKE '/self/%'` and archiving checks every descendant's stock.
 *
 * Archive is soft (`archived = 1`) and refuses a location that (or whose descendant) still holds stock
 * (location_has_stock), is referenced by an open stocktake (location_in_use), or is a default
 * (cannot_archive_default). Deletion is never offered.
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { mapLocation, isLocationType, LOCATION_COLUMNS } from './types.js';
import type { LocationRow } from './types.js';

const CODE_MAX = 30;
const MAX_DEPTH = 8;

function readLocation(ctx: WorkspaceContext, id: string): LocationRow | undefined {
  return ctx.store.db
    .prepare(`SELECT ${LOCATION_COLUMNS} FROM stock_location WHERE workspace_id = ? AND id = ?`)
    .get(ctx.workspaceId, id) as LocationRow | undefined;
}

function readWarehouseActive(ctx: WorkspaceContext, id: unknown): { id: string; active: number } | undefined {
  if (typeof id !== 'string' || id.length === 0) return undefined;
  return ctx.store.db
    .prepare('SELECT id, active FROM warehouse WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, id) as { id: string; active: number } | undefined;
}

/** A J00 location whose lower(code) already exists in the SAME warehouse, other than `exceptId`. */
function codeTaken(ctx: WorkspaceContext, warehouseId: string, code: string, exceptId?: string): boolean {
  const row = ctx.store.db
    .prepare(
      'SELECT id FROM stock_location WHERE workspace_id = ? AND warehouse_id = ? AND code IS NOT NULL AND lower(code) = lower(?) AND id != ? LIMIT 1',
    )
    .get(ctx.workspaceId, warehouseId, code, exceptId ?? '') as { id: string } | undefined;
  return row !== undefined;
}

function clearWarehouseDefault(ctx: WorkspaceContext, warehouseId: string): void {
  ctx.store.db
    .prepare('UPDATE stock_location SET is_default_for_warehouse = 0 WHERE workspace_id = ? AND warehouse_id = ? AND is_default_for_warehouse = 1')
    .run(ctx.workspaceId, warehouseId);
}

function warehouseHasDefaultLocation(ctx: WorkspaceContext, warehouseId: string): boolean {
  const row = ctx.store.db
    .prepare('SELECT id FROM stock_location WHERE workspace_id = ? AND warehouse_id = ? AND is_default_for_warehouse = 1 LIMIT 1')
    .get(ctx.workspaceId, warehouseId) as { id: string } | undefined;
  return row !== undefined;
}

/** The on-hand SUM over a location AND all its descendants (path prefix), across every item. */
function stockUnderLocation(ctx: WorkspaceContext, loc: LocationRow): number {
  const prefix = (loc.path ?? `/${loc.id}/`) + '%';
  const row = ctx.store.db
    .prepare(
      `SELECT COALESCE(SUM(m.qty), 0) AS n
         FROM stock_movement m
         JOIN stock_location l ON l.id = m.location_id AND l.workspace_id = m.workspace_id
        WHERE m.workspace_id = ? AND (l.id = ? OR l.path LIKE ?)`,
    )
    .get(ctx.workspaceId, loc.id, prefix) as { n: number };
  return row.n;
}

/** Is the location, or any descendant, referenced by an OPEN stocktake (session or line)? */
function locationInUse(ctx: WorkspaceContext, loc: LocationRow): boolean {
  const prefix = (loc.path ?? `/${loc.id}/`) + '%';
  const row = ctx.store.db
    .prepare(
      `SELECT 1 AS x FROM stocktake_session s
         WHERE s.workspace_id = ? AND s.status = 'open' AND s.location_id IS NOT NULL
           AND (s.location_id = ? OR EXISTS (
             SELECT 1 FROM stock_location l WHERE l.id = s.location_id AND (l.id = ? OR l.path LIKE ?)))
       UNION
       SELECT 1 AS x FROM stocktake_line ln JOIN stocktake_session ss ON ss.id = ln.session_id
         JOIN stock_location ll ON ll.id = ln.location_id AND ll.workspace_id = ln.workspace_id
         WHERE ln.workspace_id = ? AND ss.status = 'open' AND (ll.id = ? OR ll.path LIKE ?)
       LIMIT 1`,
    )
    .get(ctx.workspaceId, loc.id, loc.id, prefix, ctx.workspaceId, loc.id, prefix) as { x: number } | undefined;
  return row !== undefined;
}

export interface CreateLocationInput {
  warehouseId?: string;
  code?: string;
  name?: string;
  description?: string | null;
  parentId?: string | null;
  locationType?: string;
  isDefaultForWarehouse?: boolean;
  idempotencyKey?: string;
}

export function locationCreate(ctx: WorkspaceContext, input: CreateLocationInput): Result {
  const capable = ctx.capabilities.assert('manage_master_data');
  if (!capable.ok) return capable;

  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    const replayed = ctx.store.recallIdempotent<Result>(ctx.workspaceId, input.idempotencyKey, 'location_create');
    if (replayed !== undefined) return replayed;
  }

  const warehouse = readWarehouseActive(ctx, input.warehouseId);
  if (warehouse === undefined) return err('not_found', { warehouseId: input.warehouseId });
  if (warehouse.active !== 1) return err('warehouse_archived', { warehouseId: input.warehouseId });

  const code = typeof input.code === 'string' ? input.code.trim() : '';
  if (code.length === 0 || code.length > CODE_MAX) return err('invalid_code', { code });
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (name.length === 0) return err('invalid_input', { field: 'name' });
  if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length === 0) {
    return err('invalid_input', { field: 'idempotencyKey' });
  }
  if (input.locationType !== undefined && input.locationType !== null && !isLocationType(input.locationType)) {
    return err('invalid_location_type', { locationType: input.locationType });
  }

  // The parent must exist, be active, and belong to the SAME warehouse.
  let parent: LocationRow | undefined;
  if (input.parentId !== undefined && input.parentId !== null && input.parentId !== '') {
    parent = readLocation(ctx, input.parentId);
    if (parent === undefined) return err('not_found', { parentId: input.parentId });
    if (parent.warehouse_id !== warehouse.id) return err('parent_warehouse_mismatch', { parentId: input.parentId });
    if (parent.depth + 1 > MAX_DEPTH) return err('max_depth_exceeded', { max: MAX_DEPTH });
  }
  if (codeTaken(ctx, warehouse.id, code)) return err('duplicate_code', { code });

  const run = (): Result => {
    if (codeTaken(ctx, warehouse.id, code)) return err('duplicate_code', { code });
    const now = ctx.clock.now();
    const id = ctx.ids.next('stockloc');
    const depth = parent === undefined ? 0 : parent.depth + 1;
    const path = (parent === undefined ? '/' : parent.path ?? `/${parent.id}/`) + `${id}/`;
    // The first location in a warehouse becomes its default; otherwise honour the caller's flag.
    const makeDefault = input.isDefaultForWarehouse === true || !warehouseHasDefaultLocation(ctx, warehouse.id);
    if (makeDefault) clearWarehouseDefault(ctx, warehouse.id);
    ctx.store.db
      .prepare(
        `INSERT INTO stock_location
           (id, workspace_id, name, type, archived, created_at, warehouse_id, code, parent_id, location_type, path, depth, is_default_for_warehouse)
         VALUES (?, ?, ?, NULL, 0, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        ctx.workspaceId,
        name,
        now,
        warehouse.id,
        code,
        parent?.id ?? null,
        typeof input.locationType === 'string' && input.locationType !== '' ? input.locationType : null,
        path,
        depth,
        makeDefault ? 1 : 0,
      );
    return ok({ location: mapLocation(readLocation(ctx, id) as LocationRow) });
  };

  return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'location_create', run);
}

export interface UpdateLocationInput {
  locationId?: string;
  patch?: {
    name?: string;
    description?: string | null;
    locationType?: string | null;
    parentId?: string | null;
  };
  idempotencyKey?: string;
}

export function locationUpdate(ctx: WorkspaceContext, input: UpdateLocationInput): Result {
  const capable = ctx.capabilities.assert('manage_master_data');
  if (!capable.ok) return capable;
  if (typeof input.locationId !== 'string' || input.locationId.length === 0) {
    return err('invalid_input', { field: 'locationId' });
  }
  const current = readLocation(ctx, input.locationId);
  if (current === undefined) return err('not_found', { locationId: input.locationId });
  const patch = input.patch ?? {};
  const name = patch.name !== undefined ? patch.name.trim() : current.name;
  if (name.length === 0) return err('invalid_input', { field: 'name' });
  if (patch.locationType !== undefined && patch.locationType !== null && !isLocationType(patch.locationType)) {
    return err('invalid_location_type', { locationType: patch.locationType });
  }

  // A re-parent is allowed only within the same warehouse and only when it creates no cycle. The new
  // parent may not be the location itself nor any of its own descendants (that is the cycle).
  let reparent: { newParent: LocationRow | undefined } | undefined;
  if (patch.parentId !== undefined) {
    const target = patch.parentId === null || patch.parentId === '' ? undefined : patch.parentId;
    if (target === undefined) {
      reparent = { newParent: undefined };
    } else {
      const np = readLocation(ctx, target);
      if (np === undefined) return err('not_found', { parentId: target });
      if (np.warehouse_id !== current.warehouse_id) return err('parent_warehouse_mismatch', { parentId: target });
      const currentPrefix = current.path ?? `/${current.id}/`;
      if (np.id === current.id || (np.path ?? '').startsWith(currentPrefix)) {
        return err('location_cycle', { locationId: current.id, parentId: target });
      }
      if (np.depth + 1 > MAX_DEPTH) return err('max_depth_exceeded', { max: MAX_DEPTH });
      reparent = { newParent: np };
    }
  }

  const run = (): Result => {
    const now = ctx.clock.now();
    ctx.store.db
      .prepare('UPDATE stock_location SET name = ?, description = ?, location_type = ? WHERE workspace_id = ? AND id = ?')
      .run(
        name,
        patch.description !== undefined ? patch.description : current.description,
        patch.locationType !== undefined
          ? patch.locationType === null || patch.locationType === ''
            ? null
            : patch.locationType
          : current.location_type,
        ctx.workspaceId,
        input.locationId,
      );

    if (reparent !== undefined) {
      const oldPath = current.path ?? `/${current.id}/`;
      const newParentPath = reparent.newParent === undefined ? '/' : reparent.newParent.path ?? `/${reparent.newParent.id}/`;
      const newDepthBase = reparent.newParent === undefined ? 0 : reparent.newParent.depth + 1;
      const newPath = `${newParentPath}${current.id}/`;
      // Move the subtree: rewrite every descendant's path prefix and shift its depth by the delta.
      const subtree = ctx.store.db
        .prepare(`SELECT ${LOCATION_COLUMNS} FROM stock_location WHERE workspace_id = ? AND (id = ? OR path LIKE ?)`)
        .all(ctx.workspaceId, current.id, `${oldPath}%`) as LocationRow[];
      const depthDelta = newDepthBase - current.depth;
      const update = ctx.store.db.prepare(
        'UPDATE stock_location SET path = ?, depth = ?, parent_id = ? WHERE workspace_id = ? AND id = ?',
      );
      for (const node of subtree) {
        const nodePath = node.path ?? `/${node.id}/`;
        const rewritten = newPath + nodePath.slice(oldPath.length);
        const parentId = node.id === current.id ? reparent.newParent?.id ?? null : node.parent_id;
        update.run(rewritten, node.depth + depthDelta, parentId, ctx.workspaceId, node.id);
      }
      void now;
    }
    return ok({ location: mapLocation(readLocation(ctx, input.locationId as string) as LocationRow) });
  };
  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'location_update', run);
  }
  return run();
}

export function locationSetDefault(
  ctx: WorkspaceContext,
  input: { locationId?: string; idempotencyKey?: string },
): Result {
  const capable = ctx.capabilities.assert('manage_master_data');
  if (!capable.ok) return capable;
  if (typeof input.locationId !== 'string' || input.locationId.length === 0) {
    return err('invalid_input', { field: 'locationId' });
  }
  const run = (): Result => {
    const current = readLocation(ctx, input.locationId as string);
    if (current === undefined) return err('not_found', { locationId: input.locationId });
    if (current.archived !== 0) return err('location_archived', { locationId: input.locationId });
    if (current.warehouse_id === null) return err('not_found', { locationId: input.locationId });
    if (current.is_default_for_warehouse !== 1) {
      clearWarehouseDefault(ctx, current.warehouse_id);
      ctx.store.db
        .prepare('UPDATE stock_location SET is_default_for_warehouse = 1 WHERE workspace_id = ? AND id = ?')
        .run(ctx.workspaceId, input.locationId);
    }
    return ok({ location: mapLocation(readLocation(ctx, input.locationId as string) as LocationRow) });
  };
  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'location_set_default', run);
  }
  return run();
}

export function locationArchive(
  ctx: WorkspaceContext,
  input: { locationId?: string; idempotencyKey?: string },
): Result {
  const capable = ctx.capabilities.assert('manage_master_data');
  if (!capable.ok) return capable;
  if (typeof input.locationId !== 'string' || input.locationId.length === 0) {
    return err('invalid_input', { field: 'locationId' });
  }
  const run = (): Result => {
    const current = readLocation(ctx, input.locationId as string);
    if (current === undefined) return err('not_found', { locationId: input.locationId });
    if (current.is_default_for_warehouse === 1) return err('cannot_archive_default', { locationId: input.locationId });
    if (stockUnderLocation(ctx, current) !== 0) return err('location_has_stock', { locationId: input.locationId });
    if (locationInUse(ctx, current)) return err('location_in_use', { locationId: input.locationId });
    if (current.archived === 0) {
      // Archive the location and every (provably empty) descendant, so no live child is left pointing
      // at an archived ancestor.
      const prefix = (current.path ?? `/${current.id}/`) + '%';
      ctx.store.db
        .prepare('UPDATE stock_location SET archived = 1, is_default_for_warehouse = 0 WHERE workspace_id = ? AND (id = ? OR path LIKE ?)')
        .run(ctx.workspaceId, current.id, prefix);
    }
    return ok({ location: mapLocation(readLocation(ctx, input.locationId as string) as LocationRow) });
  };
  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'location_archive', run);
  }
  return run();
}

export interface ListLocationsInput {
  warehouseId?: string;
  parentId?: string | null;
  active?: boolean;
  search?: string;
  includeDescendants?: boolean;
  savedViewId?: string;
}

export function locationList(ctx: WorkspaceContext, input: ListLocationsInput = {}): Result {
  const clauses = ['workspace_id = ?', 'warehouse_id IS NOT NULL'];
  const params: unknown[] = [ctx.workspaceId];
  if (typeof input.warehouseId === 'string' && input.warehouseId.length > 0) {
    clauses.push('warehouse_id = ?');
    params.push(input.warehouseId);
  }
  if (typeof input.active === 'boolean') {
    clauses.push('archived = ?');
    params.push(input.active ? 0 : 1);
  }
  if (input.parentId === null) {
    clauses.push('parent_id IS NULL');
  } else if (typeof input.parentId === 'string' && input.parentId.length > 0) {
    if (input.includeDescendants === true) {
      const parent = readLocation(ctx, input.parentId);
      const prefix = (parent?.path ?? `/${input.parentId}/`) + '%';
      clauses.push('(parent_id = ? OR path LIKE ?)');
      params.push(input.parentId, prefix);
    } else {
      clauses.push('parent_id = ?');
      params.push(input.parentId);
    }
  }
  if (typeof input.search === 'string' && input.search.trim().length > 0) {
    clauses.push('(lower(code) LIKE ? OR lower(name) LIKE ?)');
    const like = `%${input.search.trim().toLowerCase()}%`;
    params.push(like, like);
  }
  const rows = ctx.store.db
    .prepare(`SELECT ${LOCATION_COLUMNS} FROM stock_location WHERE ${clauses.join(' AND ')} ORDER BY depth, code`)
    .all(...params) as LocationRow[];
  return ok({ locations: rows.map(mapLocation) });
}

export function locationGet(ctx: WorkspaceContext, input: { locationId?: string }): Result {
  if (typeof input.locationId !== 'string' || input.locationId.length === 0) {
    return err('invalid_input', { field: 'locationId' });
  }
  const row = readLocation(ctx, input.locationId);
  if (row === undefined) return err('not_found', { locationId: input.locationId });
  return ok({ location: mapLocation(row) });
}

interface LocationNode {
  id: string;
  code: string | null;
  name: string;
  locationType: string | null;
  depth: number;
  isDefaultForWarehouse: boolean;
  active: boolean;
  children: LocationNode[];
}

export function locationTree(ctx: WorkspaceContext, input: { warehouseId?: string }): Result {
  if (typeof input.warehouseId !== 'string' || input.warehouseId.length === 0) {
    return err('invalid_input', { field: 'warehouseId' });
  }
  const warehouse = readWarehouseActive(ctx, input.warehouseId);
  if (warehouse === undefined) return err('not_found', { warehouseId: input.warehouseId });
  const rows = ctx.store.db
    .prepare(
      `SELECT ${LOCATION_COLUMNS} FROM stock_location WHERE workspace_id = ? AND warehouse_id = ? ORDER BY depth, code`,
    )
    .all(ctx.workspaceId, input.warehouseId) as LocationRow[];

  const nodes = new Map<string, LocationNode>();
  for (const r of rows) {
    nodes.set(r.id, {
      id: r.id,
      code: r.code,
      name: r.name,
      locationType: r.location_type,
      depth: r.depth,
      isDefaultForWarehouse: r.is_default_for_warehouse === 1,
      active: r.archived === 0,
      children: [],
    });
  }
  const roots: LocationNode[] = [];
  for (const r of rows) {
    const node = nodes.get(r.id) as LocationNode;
    const parent = r.parent_id === null ? undefined : nodes.get(r.parent_id);
    if (parent === undefined) roots.push(node);
    else parent.children.push(node);
  }
  return ok({ warehouseId: input.warehouseId, tree: roots });
}
