/**
 * J05 part 1, the inventory reason-code catalog: the workspace-scoped master of structured reason
 * codes every manual adjustment must cite (spec §2 US-J05.1). A reason code carries a category
 * (§H-ENUM), a requires_note flag, a default_for_stocktake flag, and an active lifecycle. The catalog
 * is MUTABLE (update flips flags, archive soft-deletes); historical `inventory_adjustment` rows keep
 * the foreign key forever, so an archived code stays queryable for reporting.
 *
 * This module owns NO quantity: it is pure master data. The adjust facade (`adjust.ts`) resolves and
 * asserts a reason active here before minting a movement through J02 `inventoryMove`. §H-TENANT on
 * every read and write.
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';

/**
 * §H-ENUM, the reason categories (spec §4). Validated at the verb boundary, never a CHECK constraint
 * (the D01 / J02 / J04 convention). Single-sourced here and re-exported through the barrel.
 */
export const REASON_CATEGORIES = [
  'shrinkage',
  'damage',
  'found',
  'count_variance',
  'obsolescence',
  'theft',
  'quality',
  'correction',
  'reversal',
  'system',
  'other',
] as const;
export type ReasonCategory = (typeof REASON_CATEGORIES)[number];
const CATEGORY_SET: ReadonlySet<string> = new Set(REASON_CATEGORIES);
export function isReasonCategory(x: unknown): x is ReasonCategory {
  return typeof x === 'string' && CATEGORY_SET.has(x);
}

export interface InventoryReasonCode {
  id: string;
  code: string;
  name: string;
  description: string | null;
  category: ReasonCategory;
  requiresNote: boolean;
  defaultForStocktake: boolean;
  isActive: boolean;
  createdAt: string;
  createdBy: string | null;
  updatedAt: string | null;
  archivedAt: string | null;
}

interface ReasonRow {
  id: string;
  code: string;
  name: string;
  description: string | null;
  category: string;
  requires_note: number;
  default_for_stocktake: number;
  is_active: number;
  created_at: string;
  created_by: string | null;
  updated_at: string | null;
  archived_at: string | null;
}

const REASON_COLUMNS = `id, code, name, description, category, requires_note, default_for_stocktake,
  is_active, created_at, created_by, updated_at, archived_at`;

function mapReason(r: ReasonRow): InventoryReasonCode {
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    description: r.description,
    category: (isReasonCategory(r.category) ? r.category : 'other') as ReasonCategory,
    requiresNote: r.requires_note === 1,
    defaultForStocktake: r.default_for_stocktake === 1,
    isActive: r.is_active === 1,
    createdAt: r.created_at,
    createdBy: r.created_by,
    updatedAt: r.updated_at,
    archivedAt: r.archived_at,
  };
}

/** Read one reason row, tenant-scoped. Used by the catalog reads and by the adjust facade. */
export function readReason(ctx: WorkspaceContext, id: string): InventoryReasonCode | undefined {
  const row = ctx.store.db
    .prepare(`SELECT ${REASON_COLUMNS} FROM inventory_reason_code WHERE workspace_id = ? AND id = ?`)
    .get(ctx.workspaceId, id) as ReasonRow | undefined;
  return row === undefined ? undefined : mapReason(row);
}

/** True when the workspace holds at least one active reason code (for the `no_active_reasons` signal). */
export function hasActiveReason(ctx: WorkspaceContext): boolean {
  const row = ctx.store.db
    .prepare('SELECT 1 AS x FROM inventory_reason_code WHERE workspace_id = ? AND is_active = 1 LIMIT 1')
    .get(ctx.workspaceId);
  return row !== undefined;
}

function reasonByKey(ctx: WorkspaceContext, key: string): InventoryReasonCode | undefined {
  const row = ctx.store.db
    .prepare(`SELECT ${REASON_COLUMNS} FROM inventory_reason_code WHERE workspace_id = ? AND idempotency_key = ?`)
    .get(ctx.workspaceId, key) as ReasonRow | undefined;
  return row === undefined ? undefined : mapReason(row);
}

// --- create ------------------------------------------------------------------------------------

export interface ReasonCreateInput {
  code?: string;
  name?: string;
  category?: string;
  requiresNote?: boolean;
  defaultForStocktake?: boolean;
  description?: string;
  idempotencyKey?: string;
}

/** Normalise a code the way the unique index expects: trimmed, upper-cased. */
function normaliseCode(code: string): string {
  return code.trim().toUpperCase();
}

/**
 * Create a reason code (spec §2 US-J05.1). code is upper-normalised and unique per workspace,
 * case-insensitively (`duplicate_code` on collision). §H-IDEMPOTENT: a replayed key returns the
 * original row and mints nothing.
 */
export function inventoryReasonCreate(ctx: WorkspaceContext, input: ReasonCreateInput): Result {
  const capable = ctx.capabilities.assert('manage_master_data');
  if (!capable.ok) return capable;

  if (typeof input.code !== 'string' || input.code.trim().length === 0) {
    return err('invalid_input', { field: 'code' });
  }
  if (typeof input.name !== 'string' || input.name.trim().length === 0) {
    return err('invalid_input', { field: 'name' });
  }
  if (!isReasonCategory(input.category)) {
    return err('invalid_input', { field: 'category', allowed: [...REASON_CATEGORIES] });
  }
  if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length === 0) {
    return err('invalid_input', { field: 'idempotencyKey' });
  }
  const code = normaliseCode(input.code);
  const category = input.category;
  const name = input.name.trim();
  const description = input.description ?? null;
  const requiresNote = input.requiresNote === true ? 1 : 0;
  const defaultForStocktake = input.defaultForStocktake === true ? 1 : 0;
  const idempotencyKey = input.idempotencyKey;

  // §H-IDEMPOTENT fast path.
  const replay = reasonByKey(ctx, idempotencyKey);
  if (replay !== undefined) return ok({ reason: replay });

  // Case-insensitive duplicate check before the write (the unique index is the race guard beneath it).
  const clash = ctx.store.db
    .prepare('SELECT id FROM inventory_reason_code WHERE workspace_id = ? AND lower(code) = lower(?)')
    .get(ctx.workspaceId, code) as { id: string } | undefined;
  if (clash !== undefined) return err('duplicate_code', { code });

  const id = ctx.ids.next('invrsn');
  const now = ctx.clock.now();
  try {
    return ctx.store.tx(() => {
      const raced = reasonByKey(ctx, idempotencyKey);
      if (raced !== undefined) return ok({ reason: raced });
      ctx.store.db
        .prepare(
          `INSERT INTO inventory_reason_code
             (id, workspace_id, code, name, description, category, requires_note, default_for_stocktake,
              is_active, idempotency_key, created_at, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
        )
        .run(
          id,
          ctx.workspaceId,
          code,
          name,
          description,
          category,
          requiresNote,
          defaultForStocktake,
          idempotencyKey,
          now,
          ctx.actor,
        );
      ctx.audit.record({ entityKind: 'inventory_reason_code', entityId: id, action: 'create', actor: ctx.actor, at: now });
      return ok({ reason: readReason(ctx, id) as InventoryReasonCode });
    });
  } catch (e) {
    // A lost idempotency race trips the (workspace, key) index; replay the winner. A lost code race
    // trips the (workspace, lower(code)) index; report the duplicate honestly.
    const winner = reasonByKey(ctx, idempotencyKey);
    if (winner !== undefined) return ok({ reason: winner });
    const clashRow = ctx.store.db
      .prepare('SELECT id FROM inventory_reason_code WHERE workspace_id = ? AND lower(code) = lower(?)')
      .get(ctx.workspaceId, code) as { id: string } | undefined;
    if (clashRow !== undefined) return err('duplicate_code', { code });
    throw e;
  }
}

// --- update ------------------------------------------------------------------------------------

export interface ReasonUpdateInput {
  id?: string;
  name?: string;
  description?: string | null;
  requiresNote?: boolean;
  defaultForStocktake?: boolean;
  isActive?: boolean;
  idempotencyKey?: string;
}

/**
 * Update a reason code (spec §2 US-J05.1). The `code` is NOT changeable (it is the stable classifier
 * historical rows joined on); name, description, requires_note, default_for_stocktake and is_active may
 * change. Flipping is_active to false is the same soft-archive `inventoryReasonArchive` performs.
 */
export function inventoryReasonUpdate(ctx: WorkspaceContext, input: ReasonUpdateInput): Result {
  const capable = ctx.capabilities.assert('manage_master_data');
  if (!capable.ok) return capable;
  if (typeof input.id !== 'string' || input.id.length === 0) return err('invalid_input', { field: 'id' });
  if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length === 0) {
    return err('invalid_input', { field: 'idempotencyKey' });
  }
  const existing = readReason(ctx, input.id);
  if (existing === undefined) return err('not_found', { id: input.id });

  return ctx.store.rememberIdempotent<Result>(ctx.workspaceId, input.idempotencyKey, 'inventory_reason_update', () => {
    const now = ctx.clock.now();
    const sets: string[] = [];
    const params: unknown[] = [];
    if (typeof input.name === 'string' && input.name.trim().length > 0) {
      sets.push('name = ?');
      params.push(input.name.trim());
    }
    if (input.description !== undefined) {
      sets.push('description = ?');
      params.push(input.description);
    }
    if (typeof input.requiresNote === 'boolean') {
      sets.push('requires_note = ?');
      params.push(input.requiresNote ? 1 : 0);
    }
    if (typeof input.defaultForStocktake === 'boolean') {
      sets.push('default_for_stocktake = ?');
      params.push(input.defaultForStocktake ? 1 : 0);
    }
    if (typeof input.isActive === 'boolean') {
      sets.push('is_active = ?');
      params.push(input.isActive ? 1 : 0);
      sets.push('archived_at = ?');
      params.push(input.isActive ? null : now);
    }
    sets.push('updated_at = ?');
    params.push(now);
    params.push(ctx.workspaceId, input.id);
    ctx.store.db
      .prepare(`UPDATE inventory_reason_code SET ${sets.join(', ')} WHERE workspace_id = ? AND id = ?`)
      .run(...params);
    ctx.audit.record({ entityKind: 'inventory_reason_code', entityId: input.id as string, action: 'update', actor: ctx.actor, at: now });
    return ok({ reason: readReason(ctx, input.id as string) as InventoryReasonCode });
  });
}

// --- archive -----------------------------------------------------------------------------------

export interface ReasonArchiveInput {
  id?: string;
  idempotencyKey?: string;
}

/**
 * Soft-archive a reason code (spec §2 US-J05.1): is_active = 0. It disappears from pickers but stays
 * queryable for historical joins; new adjustments can no longer cite it. Never a destructive delete.
 */
export function inventoryReasonArchive(ctx: WorkspaceContext, input: ReasonArchiveInput): Result {
  const capable = ctx.capabilities.assert('manage_master_data');
  if (!capable.ok) return capable;
  if (typeof input.id !== 'string' || input.id.length === 0) return err('invalid_input', { field: 'id' });
  if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length === 0) {
    return err('invalid_input', { field: 'idempotencyKey' });
  }
  const existing = readReason(ctx, input.id);
  if (existing === undefined) return err('not_found', { id: input.id });

  return ctx.store.rememberIdempotent<Result>(ctx.workspaceId, input.idempotencyKey, 'inventory_reason_archive', () => {
    const now = ctx.clock.now();
    ctx.store.db
      .prepare('UPDATE inventory_reason_code SET is_active = 0, archived_at = ?, updated_at = ? WHERE workspace_id = ? AND id = ?')
      .run(now, now, ctx.workspaceId, input.id);
    ctx.audit.record({ entityKind: 'inventory_reason_code', entityId: input.id as string, action: 'archive', actor: ctx.actor, at: now });
    return ok({ reason: readReason(ctx, input.id as string) as InventoryReasonCode });
  });
}

// --- list / get ---------------------------------------------------------------------------------

export interface ReasonListInput {
  activeOnly?: boolean;
  category?: string;
}

/** List reason codes, ordered by code, filterable by active-only and category (spec §2 US-J05.1). */
export function inventoryReasonList(ctx: WorkspaceContext, input: ReasonListInput = {}): Result {
  const capable = ctx.capabilities.assert('read_master_data');
  if (!capable.ok) return capable;

  const clauses = ['workspace_id = ?'];
  const params: unknown[] = [ctx.workspaceId];
  if (input.activeOnly === true) {
    clauses.push('is_active = 1');
  }
  if (isReasonCategory(input.category)) {
    clauses.push('category = ?');
    params.push(input.category);
  }
  const rows = ctx.store.db
    .prepare(`SELECT ${REASON_COLUMNS} FROM inventory_reason_code WHERE ${clauses.join(' AND ')} ORDER BY code`)
    .all(...params) as ReasonRow[];
  return ok({ reasons: rows.map(mapReason) });
}

export function inventoryReasonGet(ctx: WorkspaceContext, input: { id?: string }): Result {
  const capable = ctx.capabilities.assert('read_master_data');
  if (!capable.ok) return capable;
  if (typeof input.id !== 'string' || input.id.length === 0) return err('invalid_input', { field: 'id' });
  const reason = readReason(ctx, input.id);
  if (reason === undefined) return err('not_found', { id: input.id });
  return ok({ reason });
}
