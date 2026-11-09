/**
 * D01 stock locations: create or edit a place inventory sits, and list them. A location `type` is an
 * organisational tag only (§6b), never an enum that feeds valuation. §H-TENANT on every query.
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { findLocation } from './shared.js';
import type { LocationRow } from './shared.js';

export interface UpsertLocationInput {
  locationId?: string;
  name?: string;
  type?: string;
  archived?: boolean;
  idempotencyKey?: string;
}

export interface StockLocation {
  id: string;
  name: string;
  type: string | null;
  archived: boolean;
}

function mapLocation(row: LocationRow): StockLocation {
  return { id: row.id, name: row.name, type: row.type, archived: row.archived === 1 };
}

/** Create a location (no `locationId`) or edit one by id. `name` is required on create. */
export function upsertStockLocation(ctx: WorkspaceContext, input: UpsertLocationInput): Result {
  const capable = ctx.capabilities.assert('manage_master_data');
  if (!capable.ok) return capable;

  if (input.locationId !== undefined) {
    const existing = findLocation(ctx, input.locationId);
    if (existing === undefined) return err('not_found', { locationId: input.locationId });
    const name = input.name !== undefined ? input.name.trim() : existing.name;
    if (name.length === 0) return err('invalid_input', { field: 'name' });
    const type = input.type !== undefined ? (input.type.trim() || null) : existing.type;
    const archived = input.archived !== undefined ? (input.archived ? 1 : 0) : existing.archived;
    ctx.store.db
      .prepare('UPDATE stock_location SET name = ?, type = ?, archived = ? WHERE workspace_id = ? AND id = ?')
      .run(name, type, archived, ctx.workspaceId, input.locationId);
    const row = findLocation(ctx, input.locationId) as LocationRow;
    return ok({ location: mapLocation(row) });
  }

  const name = (input.name ?? '').trim();
  if (name.length === 0) return err('invalid_input', { field: 'name' });
  if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length === 0) {
    return err('invalid_input', { field: 'idempotencyKey' });
  }
  // §H-IDEMPOTENT: a create MINTS an id, so a replay of the same key must return the first location
  // rather than a second one.
  return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'stock_location_upsert', () => {
    const id = ctx.ids.next('stockloc');
    ctx.store.db
      .prepare('INSERT INTO stock_location (id, workspace_id, name, type, archived, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, ctx.workspaceId, name, (input.type ?? '').trim() || null, input.archived ? 1 : 0, ctx.clock.now());
    const row = findLocation(ctx, id) as LocationRow;
    return ok({ location: mapLocation(row) });
  });
}

/** Every location in this workspace, active first, by name. */
export function listStockLocations(ctx: WorkspaceContext): Result {
  const rows = ctx.store.db
    .prepare('SELECT id, name, type, archived FROM stock_location WHERE workspace_id = ? ORDER BY archived, name')
    .all(ctx.workspaceId) as LocationRow[];
  return ok({ locations: rows.map(mapLocation) });
}
