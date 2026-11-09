/**
 * D00 US-D00.3: the item category tree (a flexible, user/agent-maintained grouping that feeds
 * navigation and reporting only, never VAT resolution or the ledger). Exactly TWO levels: a child's
 * parent must itself be a root, the same one-level discipline variants keep, so category rollups stay
 * simple and total (spec §6b, a fixed structural invariant).
 *
 * `upsert` creates when no `categoryId` is given and edits in place when one is; `delete` refuses
 * while any item or any child category still points at the category (`category_in_use`), so nothing is
 * ever orphaned. Every row and every query carries workspace_id (§H-TENANT); writes take an
 * idempotencyKey (§H-IDEMPOTENT).
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';

interface CategoryRow {
  id: string;
  workspace_id: string;
  name: string;
  parent_id: string | null;
  sort: number;
  created_at: string;
}

function mapCategory(row: CategoryRow) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    parentId: row.parent_id,
    sort: row.sort,
    createdAt: row.created_at,
  };
}

function readCategory(ctx: WorkspaceContext, categoryId: string): CategoryRow | undefined {
  return ctx.store.db
    .prepare('SELECT * FROM item_category WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, categoryId) as CategoryRow | undefined;
}

function hasChildren(ctx: WorkspaceContext, categoryId: string): boolean {
  const row = ctx.store.db
    .prepare('SELECT id FROM item_category WHERE workspace_id = ? AND parent_id = ? LIMIT 1')
    .get(ctx.workspaceId, categoryId) as { id: string } | undefined;
  return row !== undefined;
}

export interface UpsertCategoryInput {
  categoryId?: string | null;
  name?: string;
  parentId?: string | null;
  sort?: number;
  idempotencyKey?: string;
}

export function upsertItemCategory(ctx: WorkspaceContext, input: UpsertCategoryInput): Result {
  const editing = typeof input.categoryId === 'string' && input.categoryId.length > 0;
  const current = editing ? readCategory(ctx, input.categoryId as string) : undefined;
  if (editing && current === undefined) return err('not_found', { categoryId: input.categoryId });

  const name = input.name !== undefined ? input.name.trim() : current?.name;
  if (name === undefined || name.length === 0) return err('invalid_input', { field: 'name' });

  const parentId = input.parentId !== undefined ? input.parentId : current?.parent_id ?? null;
  if (parentId !== null) {
    if (editing && parentId === input.categoryId) return err('category_cycle', { categoryId: input.categoryId });
    const parent = readCategory(ctx, parentId);
    if (parent === undefined) return err('parent_not_found', { parentId });
    // Two-level fence: the parent must be a root, and a category that already has children cannot be
    // demoted under another (that would be a third level).
    if (parent.parent_id !== null) return err('category_nesting_too_deep', { parentId });
    if (editing && hasChildren(ctx, input.categoryId as string)) {
      return err('category_nesting_too_deep', { categoryId: input.categoryId });
    }
  }

  const sort = input.sort !== undefined ? input.sort : current?.sort ?? 0;
  if (!Number.isInteger(sort)) return err('invalid_input', { field: 'sort' });

  const run = (): Result => {
    if (editing) {
      ctx.store.db
        .prepare('UPDATE item_category SET name = ?, parent_id = ?, sort = ? WHERE workspace_id = ? AND id = ?')
        .run(name, parentId, sort, ctx.workspaceId, input.categoryId);
      return ok({ category: mapCategory(readCategory(ctx, input.categoryId as string) as CategoryRow) });
    }
    const id = ctx.ids.next('item_category');
    ctx.store.db
      .prepare('INSERT INTO item_category (id, workspace_id, name, parent_id, sort, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, ctx.workspaceId, name, parentId, sort, ctx.clock.now());
    return ok({ category: mapCategory(readCategory(ctx, id) as CategoryRow) });
  };

  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'item_categories_upsert', run);
  }
  return run();
}

export function deleteItemCategory(
  ctx: WorkspaceContext,
  input: { categoryId: string; idempotencyKey?: string },
): Result {
  const run = (): Result => {
    const existing = readCategory(ctx, input.categoryId);
    if (existing === undefined) return err('not_found', { categoryId: input.categoryId });

    const itemRef = ctx.store.db
      .prepare('SELECT id FROM item WHERE workspace_id = ? AND category_id = ? LIMIT 1')
      .get(ctx.workspaceId, input.categoryId) as { id: string } | undefined;
    if (itemRef !== undefined || hasChildren(ctx, input.categoryId)) {
      return err('category_in_use', { categoryId: input.categoryId });
    }

    ctx.store.db
      .prepare('DELETE FROM item_category WHERE workspace_id = ? AND id = ?')
      .run(ctx.workspaceId, input.categoryId);
    return ok({ categoryId: input.categoryId, deleted: true });
  };

  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'item_categories_delete', run);
  }
  return run();
}

export function listItemCategories(ctx: WorkspaceContext): Result {
  const rows = ctx.store.db
    .prepare('SELECT * FROM item_category WHERE workspace_id = ? ORDER BY sort, name')
    .all(ctx.workspaceId) as CategoryRow[];
  return ok({ categories: rows.map(mapCategory) });
}
