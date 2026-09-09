/**
 * G00 OP10, saved views: a named filter/sort/column/layout over any OP3-registered entity list.
 *
 * `resolveSavedViewFilters` IS THE WHOLE INTEGRATION SURFACE. A list read model that wants saved views
 * calls it once, at the top, and merges what comes back into the filter object it already understands.
 * `list_documents` and `list_payments` each spend one call on it; a list verb written next year spends
 * the same one. There is no registration step, no callback table, and nothing in this module that
 * knows what a document or a payment is.
 *
 * THE OWNER IS THE SESSION ACTOR, NEVER AN INPUT FIELD. The draft spec put `owner_user_id` on the wire
 * so a caller could say whose view it was. That is an impersonation seam in the one verb whose entire
 * access rule is "is this yours": anyone could write a view owned by someone else, or read a personal
 * view by claiming its owner. The wire carries a boolean `shared` instead, and ownership is resolved
 * from `ctx.actor`.
 *
 * THE `manage_saved_views` GATE LIVES IN HERE AND NOT IN `CAPABILITY_FOR_ACTION`, because it is
 * conditional on an input flag rather than on the verb: saving a personal view is a preference and
 * needs only the read access the caller already has, publishing one to the workspace is an
 * administrative act. `CapabilityRule`'s function form cannot express it (that form must return a
 * capability, and "none at all" is not one), so these three verbs are `ungated(...)` at the boundary
 * and assert here. G08's `diagnostics.read` is the same shape for the same reason.
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { entityKindDef, ENTITY_KIND_IDS } from './entities.js';

/**
 * The four layouts (§H-ENUM, fixed by §6b). Each needs a real Studio renderer to exist, so a fifth is
 * a code change and never a saved-view field.
 */
export const LAYOUTS: readonly string[] = ['table', 'board', 'calendar', 'dashboard'];

const LAYOUT_SET: ReadonlySet<string> = new Set(LAYOUTS);

export const MAX_VIEW_NAME_LENGTH = 120;
export const MAX_VIEW_JSON_BYTES = 16384;

interface SavedViewRow {
  id: string;
  workspace_id: string;
  entity_kind: string;
  name: string;
  owner_actor: string | null;
  filters: string;
  sort: string;
  columns: string;
  layout: string;
  is_default: number;
  created_at: string;
  updated_at: string;
}

export interface SavedViewView {
  viewId: string;
  entityKind: string;
  name: string;
  shared: boolean;
  ownerActor: string | null;
  filters: Record<string, unknown>;
  sort: unknown[];
  columns: string[];
  layout: string;
  isDefault: boolean;
}

function mapView(row: SavedViewRow): SavedViewView {
  return {
    viewId: row.id,
    entityKind: row.entity_kind,
    name: row.name,
    shared: row.owner_actor === null,
    ownerActor: row.owner_actor,
    filters: JSON.parse(row.filters) as Record<string, unknown>,
    sort: JSON.parse(row.sort) as unknown[],
    columns: JSON.parse(row.columns) as string[],
    layout: row.layout,
    isDefault: row.is_default === 1,
  };
}

function readView(ctx: WorkspaceContext, viewId: string): SavedViewRow | undefined {
  return ctx.store.db
    .prepare('SELECT * FROM saved_view WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, viewId) as SavedViewRow | undefined;
}

/** A plain JSON object, the only shape `filters` may take. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Shared validation for the create and update paths, so the two cannot drift. */
function shapeProblem(parts: {
  name?: unknown;
  filters?: unknown;
  sort?: unknown;
  columns?: unknown;
  layout?: unknown;
}): Result | undefined {
  if (parts.name !== undefined) {
    if (typeof parts.name !== 'string' || parts.name.trim().length === 0) {
      return err('invalid_name', {});
    }
    if (parts.name.length > MAX_VIEW_NAME_LENGTH) {
      return err('name_too_long', { max: MAX_VIEW_NAME_LENGTH });
    }
  }
  if (parts.layout !== undefined && !LAYOUT_SET.has(parts.layout as string)) {
    return err('invalid_layout', { layout: parts.layout, allowed: [...LAYOUTS] });
  }
  if (parts.filters !== undefined && !isPlainObject(parts.filters)) {
    return err('invalid_filters', {});
  }
  if (parts.sort !== undefined && !Array.isArray(parts.sort)) {
    return err('invalid_sort', {});
  }
  if (parts.columns !== undefined) {
    if (!Array.isArray(parts.columns) || !parts.columns.every((c) => typeof c === 'string' && c.length > 0)) {
      return err('invalid_column', {});
    }
  }
  const json = JSON.stringify({
    filters: parts.filters ?? {},
    sort: parts.sort ?? [],
    columns: parts.columns ?? [],
  });
  if (Buffer.byteLength(json, 'utf8') > MAX_VIEW_JSON_BYTES) {
    return err('view_too_large', { max: MAX_VIEW_JSON_BYTES });
  }
  return undefined;
}

/**
 * The in-engine capability gate. See the module note for why it is here and not in the action map.
 *
 * Applies to a view that IS shared or IS BECOMING shared. Un-sharing your own view back to personal is
 * not publishing, so it is not gated.
 */
function assertMayPublish(ctx: WorkspaceContext): Result | undefined {
  const allowed = ctx.capabilities.assert('manage_saved_views');
  return allowed.ok ? undefined : allowed;
}

/**
 * At most ONE default per (actor, entityKind), enforced by clearing the others in the same
 * transaction the caller's write runs in. Two simultaneous defaults would make "which view opens" a
 * race, and a list that renders differently on two machines is a bug nobody can reproduce.
 */
function clearOtherDefaults(ctx: WorkspaceContext, entityKind: string, keepViewId: string): void {
  ctx.store.db
    .prepare(
      `UPDATE saved_view SET is_default = 0
        WHERE workspace_id = ? AND entity_kind = ? AND id != ?
          AND (owner_actor = ? OR owner_actor IS NULL)`,
    )
    .run(ctx.workspaceId, entityKind, keepViewId, ctx.actor);
}

export interface CreateSavedViewInput {
  entityKind: string;
  name: string;
  filters?: Record<string, unknown>;
  sort?: unknown[];
  columns?: string[];
  layout?: string;
  shared?: boolean;
  isDefault?: boolean;
  idempotencyKey?: string;
}

export function createSavedView(ctx: WorkspaceContext, input: CreateSavedViewInput): Result {
  const run = (): Result => {
    const entity = entityKindDef(input.entityKind);
    if (entity === undefined) {
      return err('unknown_entity_kind', { entityKind: input.entityKind, known: [...ENTITY_KIND_IDS] });
    }
    const layout = input.layout ?? 'table';
    const problem = shapeProblem({
      name: input.name,
      filters: input.filters,
      sort: input.sort,
      columns: input.columns,
      layout,
    });
    if (problem !== undefined) return problem;

    const shared = input.shared === true;
    if (shared) {
      const denied = assertMayPublish(ctx);
      if (denied !== undefined) return denied;
    }

    const now = ctx.clock.now();
    const id = ctx.ids.next('view');
    ctx.store.db
      .prepare(
        `INSERT INTO saved_view
           (id, workspace_id, entity_kind, name, owner_actor, filters, sort, columns, layout,
            is_default, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        ctx.workspaceId,
        entity.kind,
        input.name,
        shared ? null : ctx.actor,
        JSON.stringify(input.filters ?? {}),
        JSON.stringify(input.sort ?? []),
        JSON.stringify(input.columns ?? []),
        layout,
        input.isDefault === true ? 1 : 0,
        now,
        now,
      );
    if (input.isDefault === true) clearOtherDefaults(ctx, entity.kind, id);
    return ok({ savedView: mapView(readView(ctx, id) as SavedViewRow) });
  };

  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'create_saved_view', run);
  }
  return run();
}

export interface SavedViewPatch {
  name?: string;
  filters?: Record<string, unknown>;
  sort?: unknown[];
  columns?: string[];
  layout?: string;
  shared?: boolean;
  isDefault?: boolean;
}

/**
 * Patch a saved view.
 *
 * A PERSONAL VIEW BELONGS TO ITS ACTOR AND NOBODY ELSE MAY TOUCH IT, not even an owner: it is a
 * preference, not workspace data, and an admin editing someone's private filter is a surprise with no
 * upside. A SHARED view needs `manage_saved_views` to change at all, because it is on everyone's
 * screen.
 */
export function updateSavedView(
  ctx: WorkspaceContext,
  input: { viewId: string; patch: SavedViewPatch; idempotencyKey?: string },
): Result {
  const run = (): Result => {
    const row = readView(ctx, input.viewId);
    if (row === undefined) return err('not_found', { viewId: input.viewId });
    const patch = input.patch ?? {};

    if (row.owner_actor === null) {
      const denied = assertMayPublish(ctx);
      if (denied !== undefined) return denied;
    } else if (row.owner_actor !== ctx.actor) {
      return err('not_owner', { viewId: input.viewId });
    }
    // Publishing a personal view to the whole workspace is the gated act, whichever direction the row
    // started in.
    if (patch.shared === true && row.owner_actor !== null) {
      const denied = assertMayPublish(ctx);
      if (denied !== undefined) return denied;
    }

    const problem = shapeProblem({
      name: patch.name,
      filters: patch.filters,
      sort: patch.sort,
      columns: patch.columns,
      layout: patch.layout,
    });
    if (problem !== undefined) return problem;

    const now = ctx.clock.now();
    const ownerActor =
      patch.shared === undefined ? row.owner_actor : patch.shared === true ? null : (row.owner_actor ?? ctx.actor);
    ctx.store.db
      .prepare(
        `UPDATE saved_view
            SET name = ?, owner_actor = ?, filters = ?, sort = ?, columns = ?, layout = ?,
                is_default = ?, updated_at = ?
          WHERE workspace_id = ? AND id = ?`,
      )
      .run(
        patch.name ?? row.name,
        ownerActor,
        JSON.stringify(patch.filters ?? JSON.parse(row.filters)),
        JSON.stringify(patch.sort ?? JSON.parse(row.sort)),
        JSON.stringify(patch.columns ?? JSON.parse(row.columns)),
        patch.layout ?? row.layout,
        patch.isDefault === undefined ? row.is_default : patch.isDefault === true ? 1 : 0,
        now,
        ctx.workspaceId,
        row.id,
      );
    if (patch.isDefault === true) clearOtherDefaults(ctx, row.entity_kind, row.id);
    return ok({ savedView: mapView(readView(ctx, row.id) as SavedViewRow) });
  };

  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'update_saved_view', run);
  }
  return run();
}

/**
 * Delete a saved view. A TRUE DELETE, and this is the one place in G00 where that is right: a view
 * mints no state and holds no history, so there is nothing to preserve and a graveyard of archived
 * filters would be clutter. A field def, which owns data, is never deleted (see `fields.ts`).
 */
export function deleteSavedView(
  ctx: WorkspaceContext,
  input: { viewId: string; idempotencyKey?: string },
): Result {
  const run = (): Result => {
    const row = readView(ctx, input.viewId);
    if (row === undefined) return err('not_found', { viewId: input.viewId });
    if (row.owner_actor === null) {
      const denied = assertMayPublish(ctx);
      if (denied !== undefined) return denied;
    } else if (row.owner_actor !== ctx.actor) {
      return err('not_owner', { viewId: input.viewId });
    }
    ctx.store.db.prepare('DELETE FROM saved_view WHERE workspace_id = ? AND id = ?').run(ctx.workspaceId, row.id);
    return ok({ viewId: row.id, deleted: true });
  };

  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'delete_saved_view', run);
  }
  return run();
}

/**
 * The views a caller may see for a kind (P5): their own first, then the workspace-shared ones.
 *
 * ANOTHER ACTOR'S PERSONAL VIEWS ARE NOT RETURNED. §H-TENANT is the outer boundary and this is the
 * inner one: a personal view is a preference, and listing everyone's would make it neither personal
 * nor useful.
 */
export function listSavedViews(ctx: WorkspaceContext, input: { entityKind: string }): Result {
  const entity = entityKindDef(input.entityKind);
  if (entity === undefined) {
    return err('unknown_entity_kind', { entityKind: input.entityKind, known: [...ENTITY_KIND_IDS] });
  }
  const rows = ctx.store.db
    .prepare(
      `SELECT * FROM saved_view
        WHERE workspace_id = ? AND entity_kind = ? AND (owner_actor = ? OR owner_actor IS NULL)
        ORDER BY CASE WHEN owner_actor IS NULL THEN 1 ELSE 0 END, name`,
    )
    .all(ctx.workspaceId, entity.kind, ctx.actor) as SavedViewRow[];
  return ok({ entityKind: entity.kind, savedViews: rows.map(mapView) });
}

/**
 * THE SEAM. Turn a `savedViewId` into the filter object a list read model already understands.
 *
 * A list verb calls this once and merges the result over its own explicit filters. That is the entire
 * contract, and it is why adding saved views to a new list is one line rather than a change here.
 *
 * `entityKind` IS CHECKED AGAINST THE VIEW'S OWN KIND. Applying a contact view to a payment list would
 * silently produce filters the payment list does not understand, which reads as "the view did
 * nothing" rather than as an error, and a filter that silently does nothing is how you hand somebody
 * a list they believe is narrower than it is.
 */
export function resolveSavedViewFilters(
  ctx: WorkspaceContext,
  entityKind: string,
  savedViewId: string,
): Result {
  const row = readView(ctx, savedViewId);
  if (row === undefined) return err('not_found', { savedViewId });
  if (row.entity_kind !== entityKind) {
    return err('view_kind_mismatch', { savedViewId, expected: entityKind, actual: row.entity_kind });
  }
  if (row.owner_actor !== null && row.owner_actor !== ctx.actor) {
    return err('not_owner', { savedViewId });
  }
  return ok({ filters: JSON.parse(row.filters) as Record<string, unknown> });
}

/**
 * THE ONE-LINE FORM OF THE SEAM, and the call a list read model actually makes.
 *
 * Hands back the caller's filter object with the view's filters merged UNDER it, so a filter named
 * explicitly in the request always wins over the same filter in the saved view. That order is the
 * only defensible one: the caller picked the view and then narrowed it, and letting stored state
 * override a value typed in the request would make the request a suggestion.
 *
 * A filter key the caller left `undefined` is ABSENT, not a null override. Spreading a plain object
 * would let an unset optional field blank out the view's value, which is the bug this helper exists
 * to make unrepresentable at every call site rather than at none of them.
 *
 * Returns the filter unchanged when there is no `savedViewId`, so a list verb calls it
 * unconditionally and has no branch of its own.
 */
export function applySavedView<T extends { savedViewId?: string | undefined }>(
  ctx: WorkspaceContext,
  entityKind: string,
  filter: T,
): Result<{ filter: T }> {
  if (filter.savedViewId === undefined) return ok({ filter });
  const resolved = resolveSavedViewFilters(ctx, entityKind, filter.savedViewId);
  if (!resolved.ok) return resolved;
  // `resolveSavedViewFilters` returns the OPEN Result deliberately: it is an internal helper and not
  // a verb, and `test/style/result-payload-is-declared.test.mjs` counts every declared inline payload
  // as a verb owing a rename probe. `applySavedView` is the typed seam callers actually use, so the
  // one narrowing lives here rather than as an annotation the ratchet would have to account for.
  const stored = resolved.filters as Record<string, unknown>;
  const explicit: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(filter)) {
    if (value !== undefined) explicit[key] = value;
  }
  return ok({ filter: { ...stored, ...explicit } as T });
}
