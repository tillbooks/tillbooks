/**
 * E00 US-E00.6, the folder tree: create, rename, re-parent, delete, and the one read that renders it.
 *
 * THE TREE IS MATERIALISED, NOT RECURSIVE. Every folder carries the full `path` its ancestry spells,
 * unique per workspace, which buys three things a recursive query would each need separately: the
 * Studio's rail renders from ONE read in display order, the "is this folder empty" question is a
 * bounded count rather than a subtree walk, and the cycle guard is a string prefix test instead of a
 * traversal that has to terminate. The cost is that a rename has to re-materialise every descendant,
 * which happens inside the same transaction as the rename itself, so the tree is never half-renamed.
 *
 * DELETE NEVER CASCADES, and that is a compliance property rather than a caution. A cascade would let
 * one click erase a file nested three levels down whose `retention_until` is still years out, and it
 * would do so without ever consulting the retention lock: the whole OR 958f rail would be reachable
 * around. So a folder holding anything at all refuses with `folder_not_empty` and the operator empties
 * it deliberately, one retained record at a time, each refusal naming itself.
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { IS_HEAD } from './head.js';

export interface FolderRow {
  id: string;
  workspace_id: string;
  name: string;
  parent_id: string | null;
  path: string;
  created_at: string;
}

/** The longest a folder name may be. A path is built from these, so an unbounded name is an unbounded key. */
export const MAX_FOLDER_NAME = 120;

function mapFolder(row: FolderRow) {
  return {
    id: row.id,
    name: row.name,
    parentId: row.parent_id,
    path: row.path,
    createdAt: row.created_at,
  };
}

/** §H-TENANT: a folder is only ever read inside the caller's workspace. */
function readFolder(ctx: WorkspaceContext, id: string): FolderRow | undefined {
  return ctx.store.db
    .prepare('SELECT * FROM file_folder WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, id) as FolderRow | undefined;
}

function pathFor(parent: FolderRow | undefined, name: string): string {
  return parent === undefined ? `/${name}` : `${parent.path}/${name}`;
}

/**
 * The name guard. A slash is refused rather than escaped, because `path` uses it as the separator: a
 * folder called `a/b` would be indistinguishable from a child `b` of a folder `a`, and the uniqueness
 * index would then be enforcing something other than sibling uniqueness.
 */
function validateName(name: unknown): Result | null {
  if (typeof name !== 'string') return err('invalid_input', { field: 'name' });
  const trimmed = name.trim();
  if (trimmed.length === 0) return err('invalid_input', { field: 'name', reason: 'empty' });
  if (trimmed.length > MAX_FOLDER_NAME) {
    return err('invalid_input', { field: 'name', reason: 'too_long', max: MAX_FOLDER_NAME });
  }
  if (trimmed.includes('/')) return err('invalid_input', { field: 'name', reason: 'slash_is_the_path_separator' });
  return null;
}

export interface UpsertFolderInput {
  folderId?: string;
  name?: string;
  parentId?: string | null;
  idempotencyKey?: string;
}

/**
 * Create a folder, or rename / re-parent an existing one.
 *
 * One verb rather than two, the `price_lists_upsert` and `item_categories_upsert` shape: the caller
 * that has an id is editing and the caller that does not is creating, and a tree maintained by an
 * agent needs both under one tool rather than a create it has to guess it should not call.
 */
export function upsertFolder(ctx: WorkspaceContext, input: UpsertFolderInput): Result {
  // REPLAY BEFORE ANY STATE-DEPENDENT GUARD, the `transitionDocument` pattern, and the conformance
  // gate is what proved this was needed rather than optional: with the guards first, a retried create
  // answered `folder_name_taken` naming the folder the FIRST call had just created, so a duplicate
  // delivery of a perfectly correct request looked like an operator error. The same shape bit
  // `newFileVersion` (`not_head_version` against the version it had itself added) and `deleteFolder`
  // (`folder_not_found` against the row it had itself removed). §H-IDEMPOTENT is about what the
  // CALLER sees, not only about how many rows land.
  const key =
    typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0 ? input.idempotencyKey : undefined;
  if (key !== undefined) {
    const replayed = ctx.store.recallIdempotent<Result>(ctx.workspaceId, key, 'folders_upsert');
    if (replayed !== undefined) return replayed;
  }

  const editing = typeof input.folderId === 'string' && input.folderId.length > 0;

  // A create must name the folder; an edit may leave the name alone and only move the folder.
  if (!editing || input.name !== undefined) {
    const nameErr = validateName(input.name);
    if (nameErr !== null) return nameErr;
  }

  const existing = editing ? readFolder(ctx, input.folderId as string) : undefined;
  if (editing && existing === undefined) return err('folder_not_found', { folderId: input.folderId });

  // `parentId: null` is an explicit "move to the root" and is different from an absent parentId, which
  // on an edit means "leave the parent where it is". `exactOptionalPropertyTypes` makes that
  // distinction representable, so it is honoured rather than collapsed.
  const reparenting = input.parentId !== undefined;
  const parentId = reparenting ? input.parentId : (existing?.parent_id ?? null);
  let parent: FolderRow | undefined;
  if (typeof parentId === 'string' && parentId.length > 0) {
    parent = readFolder(ctx, parentId);
    if (parent === undefined) return err('folder_not_found', { folderId: parentId, field: 'parentId' });
  }

  const name = input.name === undefined ? (existing as FolderRow).name.trim() : (input.name as string).trim();

  if (existing !== undefined && parent !== undefined) {
    // The cycle guard, as a prefix test on the materialised path: a folder may not become a
    // descendant of itself, and `path` already spells every ancestry there is. The equality case is
    // the self-parent one; the prefix case is the "move a parent under its own child" one.
    if (parent.id === existing.id || parent.path === existing.path || parent.path.startsWith(`${existing.path}/`)) {
      return err('folder_cycle', { folderId: existing.id, parentId: parent.id });
    }
  }

  const path = pathFor(parent, name);

  // Sibling uniqueness, checked here so the caller gets a named refusal instead of a driver
  // constraint error. The index still exists underneath: this is the message, that is the guarantee.
  const clash = ctx.store.db
    .prepare('SELECT id FROM file_folder WHERE workspace_id = ? AND path = ? AND id IS NOT ?')
    .get(ctx.workspaceId, path, existing?.id ?? null) as { id: string } | undefined;
  if (clash !== undefined) return err('folder_name_taken', { path, folderId: clash.id });

  const run = (): Result => {
    if (existing === undefined) {
      const id = ctx.ids.next('fold');
      ctx.store.db
        .prepare(
          'INSERT INTO file_folder (id, workspace_id, name, parent_id, path, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(id, ctx.workspaceId, name, parent?.id ?? null, path, ctx.clock.now());
      return ok({ folder: mapFolder(readFolder(ctx, id) as FolderRow) });
    }

    // The descendant sweep. Every path under the old one is rewritten with the new prefix, in the
    // same transaction as the row itself, so no reader can ever see a tree whose children still spell
    // the old ancestry. `SUBSTR` is 1-indexed in SQLite, hence the +1.
    if (path !== existing.path) {
      ctx.store.db
        .prepare(
          `UPDATE file_folder SET path = ? || SUBSTR(path, ?)
            WHERE workspace_id = ? AND path LIKE ? ESCAPE '\\'`,
        )
        .run(path, existing.path.length + 1, ctx.workspaceId, `${escapeLike(existing.path)}/%`);
    }
    ctx.store.db
      .prepare('UPDATE file_folder SET name = ?, parent_id = ?, path = ? WHERE workspace_id = ? AND id = ?')
      .run(name, parent?.id ?? null, path, ctx.workspaceId, existing.id);
    return ok({ folder: mapFolder(readFolder(ctx, existing.id) as FolderRow) });
  };

  if (key !== undefined) {
    return ctx.store.rememberIdempotent(ctx.workspaceId, key, 'folders_upsert', run);
  }
  // The unkeyed path is a transaction too: a rename touches the row AND every descendant, so a
  // failure between the two must roll back rather than leave the tree spelling two ancestries.
  return ctx.store.tx(run);
}

/**
 * Escape the LIKE wildcards in a path before using it as a prefix pattern.
 *
 * A folder legitimately named `100%` or `report_final` would otherwise turn its own sweep into a
 * pattern that matches SIBLINGS: `%` matches anything and `_` matches any single character, so
 * renaming `100%` would rewrite the path of every folder in the workspace. `ESCAPE '\'` is declared at
 * every call site that uses this.
 */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * Delete a folder, only when nothing at all is inside it.
 *
 * Both counts are taken, and both are named separately in the refusal, because "empty it first" is
 * useless advice when the operator is looking at an apparently empty folder that still holds a child.
 */
export function deleteFolder(ctx: WorkspaceContext, input: { folderId: string; idempotencyKey?: string }): Result {
  // Scoped to (this folder, this key) and replayed FIRST: without it a retried delete answers
  // `folder_not_found` against the row the first call removed, and folding the folder into the key
  // keeps a key reused on a DIFFERENT folder from replaying the first folder's answer.
  const scopedKey =
    typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0
      ? JSON.stringify([input.folderId, input.idempotencyKey])
      : undefined;
  if (scopedKey !== undefined) {
    const replayed = ctx.store.recallIdempotent<Result>(ctx.workspaceId, scopedKey, 'folders_delete');
    if (replayed !== undefined) return replayed;
  }

  const existing = typeof input.folderId === 'string' ? readFolder(ctx, input.folderId) : undefined;
  if (existing === undefined) return err('folder_not_found', { folderId: input.folderId });

  const children = (
    ctx.store.db
      .prepare('SELECT COUNT(*) AS n FROM file_folder WHERE workspace_id = ? AND parent_id = ?')
      .get(ctx.workspaceId, existing.id) as { n: number }
  ).n;
  const files = (
    ctx.store.db
      .prepare('SELECT COUNT(*) AS n FROM stored_file WHERE workspace_id = ? AND folder_id = ?')
      .get(ctx.workspaceId, existing.id) as { n: number }
  ).n;
  if (children > 0 || files > 0) {
    return err('folder_not_empty', { folderId: existing.id, childFolders: children, files });
  }

  const run = (): Result => {
    ctx.store.db.prepare('DELETE FROM file_folder WHERE workspace_id = ? AND id = ?').run(ctx.workspaceId, existing.id);
    return ok({ deleted: true, folderId: existing.id });
  };

  if (scopedKey !== undefined) {
    return ctx.store.rememberIdempotent(ctx.workspaceId, scopedKey, 'folders_delete', run);
  }
  return ctx.store.tx(run);
}

/**
 * The tree, as a flat list in path order (P5).
 *
 * Path order IS tree order for a rail that indents by depth, so the Studio needs no client-side sort
 * and no recursive assembly: `/Belege` precedes `/Belege/2026` precedes `/Vertraege` lexicographically,
 * which is exactly the sequence a reader expects to see. `fileCount` is the DIRECT count and not the
 * subtree one, because it is what the delete affordance is judged on.
 */
export function listFolders(ctx: WorkspaceContext): Result {
  const rows = ctx.store.db
    .prepare(
      `SELECT f.*, (
         SELECT COUNT(*) FROM stored_file s
          WHERE s.workspace_id = f.workspace_id AND s.folder_id = f.id AND ${IS_HEAD('s')}
       ) AS file_count, (
         SELECT COUNT(*) FROM file_folder c WHERE c.workspace_id = f.workspace_id AND c.parent_id = f.id
       ) AS child_count
       FROM file_folder f WHERE f.workspace_id = ? ORDER BY f.path`,
    )
    .all(ctx.workspaceId) as (FolderRow & { file_count: number; child_count: number })[];
  return ok({
    folders: rows.map((r) => ({
      ...mapFolder(r),
      // The depth the rail indents by, derived from the path rather than counted by walking parents.
      depth: r.path.split('/').length - 2,
      fileCount: r.file_count,
      childCount: r.child_count,
      // The affordance the toolbar disables, computed once here so the Studio never re-derives the
      // rule and gets it subtly different from the engine's own refusal.
      deletable: r.file_count === 0 && r.child_count === 0,
    })),
  });
}
