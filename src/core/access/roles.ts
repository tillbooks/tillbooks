/**
 * A24 §4, custom roles: `defineRole`, `listRoles`, `archiveRole`.
 *
 * A role is a NAMED SUBSET OF THE REGISTRY and nothing else. It cannot invent a capability, it
 * cannot remove the check on a verb, and it cannot touch the two anchors. That is the entire
 * safety argument for letting a workspace reshape its own matrix: the flexible thing is which role
 * holds which capability, and the fixed thing is that every gated verb still asks.
 *
 * THE SEED IS LAZY, AND THAT IS THE INTERESTING DECISION HERE. The spec seeds the three editable
 * built-ins at workspace creation. `create_workspace` predates this capability by fifteen others,
 * so every workspace that exists would carry an unseeded hole that only a migration could fill,
 * and a migration that writes a permissions row into fifteen shipped databases is a large,
 * irreversible act in service of a row that says exactly what the code already says. So the rows
 * are written on the first `list_roles` or `define_role` in a workspace instead, and until then
 * `resolveCapabilities` answers from `BUILTIN_ROLE_DEFAULTS`. The seed materialises a default; it
 * never changes a meaning, and `capability.ts` reads the same bundle either way.
 */

import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import type { WorkspaceContext } from '../context.js';
import { requireString, optionalId } from '../ledger/inputGuards.js';
import type { Capability } from './capabilities.js';
import {
  CAPABILITIES,
  EDITABLE_BUILTIN_ROLES,
  OWNER_ROLE,
  VIEWER_ROLE,
  defaultCapabilitiesFor,
  isCapability,
  isFixedRole,
} from './capabilities.js';
import { resolveCapabilities } from './capability.js';

export interface RoleView {
  id: string;
  name: string;
  /** True for `owner`/`viewer` (the anchors) and for the three editable built-ins. */
  isBuiltin: boolean;
  /** True only for `owner`/`viewer`: the bundle cannot be edited and the role cannot be archived. */
  isFixed: boolean;
  capabilities: readonly Capability[];
  archived: boolean;
  /** How many members currently hold this role, so the Roles tab can warn before an archive. */
  memberCount: number;
}

interface RoleDefRow {
  id: string;
  name: string;
  capabilities_json: string;
  is_builtin: number;
  archived: number;
}

/**
 * Write the three editable built-ins into `role_def` if this workspace has none yet.
 *
 * Idempotent by construction (`INSERT ... WHERE NOT EXISTS` per row), so it is safe to call on
 * every read path, and it never overwrites a bundle a workspace has already tuned.
 */
export function seedBuiltinRoles(ctx: WorkspaceContext): void {
  const now = ctx.clock.now();
  const insert = ctx.store.db.prepare(
    `INSERT INTO role_def
       (id, workspace_id, name, capabilities_json, is_builtin, archived, created_by, created_at, updated_at)
     SELECT ?, ?, ?, ?, 1, 0, ?, ?, ?
      WHERE NOT EXISTS (SELECT 1 FROM role_def WHERE workspace_id = ? AND id = ?)`,
  );
  for (const roleId of EDITABLE_BUILTIN_ROLES) {
    const defaults = defaultCapabilitiesFor(roleId) ?? [];
    insert.run(
      roleId,
      ctx.workspaceId,
      roleId,
      JSON.stringify(defaults),
      ctx.actor,
      now,
      now,
      ctx.workspaceId,
      roleId,
    );
  }
}

function memberCounts(ctx: WorkspaceContext): Map<string, number> {
  const rows = ctx.store.db
    .prepare('SELECT role, COUNT(*) AS n FROM workspace_member WHERE workspace_id = ? GROUP BY role')
    .all(ctx.workspaceId) as { role: string; n: number }[];
  return new Map(rows.map((r) => [r.role, r.n]));
}

/**
 * The two anchors as views, RESOLVED rather than restated.
 *
 * Both bundles come from `resolveCapabilities`, which is the same function `whoami` answers from and
 * which short-circuits `owner` and `viewer` on the same two constants `capabilityFor` does, before
 * any `role_def` query. So the anchor rows are as unshadowable here as they are there, and the
 * advertisement cannot drift from the grant without the constant itself moving.
 *
 * IT USED TO BE A HAND-WRITTEN PAIR OF LITERALS, and that is the defect this shape exists to make
 * unrepresentable. `owner` was spelled `CAPABILITY_IDS` and `viewer` was spelled `[]`, which was
 * true only while a viewer held nothing. D50 gated reads and moved `viewer` to the five read domains
 * in `capabilities.ts`; the literal here did not move with it, because nothing made it. The Roles tab
 * then rendered "Keine Rechte" for a role that could read the whole ledger, all master data, all
 * sales and all VAT. That direction is the dangerous one: D50 accepts seating the MCP agent as an
 * owner precisely because an operator can SEE the grant on this screen and narrow it, so a screen
 * that under-reports access removes the mitigation the decision was bought with.
 */
function anchorViews(ctx: WorkspaceContext, counts: Map<string, number>): RoleView[] {
  return [OWNER_ROLE, VIEWER_ROLE].map((roleId) => ({
    id: roleId,
    name: roleId,
    isBuiltin: true,
    isFixed: true,
    capabilities: resolveCapabilities(ctx.store, ctx.workspaceId, roleId),
    archived: false,
    memberCount: counts.get(roleId) ?? 0,
  }));
}

/**
 * Every role this workspace can assign: the two anchors, the three editable built-ins, and every
 * custom role, each with its RESOLVED bundle and its member count.
 *
 * The capability registry rides along in the same answer, because the Roles tab cannot render a
 * checkbox grid without it and a second endpoint for a constant would be a second thing to keep in
 * step with `capabilities.ts`.
 *
 * IT DOES NOT SEED, and that was a defect the conformance gate caught rather than a design choice
 * defended after the fact. The first draft called `seedBuiltinRoles` here, on the reasoning that a
 * read is a good moment to materialise a default. It is not: `list_roles` advertises
 * `readOnlyHint`, the standing read rule snapshots the whole database around every read verb, and
 * it went red naming this one. A read that writes is a lie to every caller that trusted the hint,
 * and the hint is the load-bearing half of the MCP contract. Only `defineRole` seeds now, because
 * only `defineRole` needs a row to UPDATE; an unseeded built-in resolves through
 * `BUILTIN_ROLE_DEFAULTS` and reads identically either way.
 */
export function listRoles(ctx: WorkspaceContext): Result {
  const counts = memberCounts(ctx);
  const rows = ctx.store.db
    .prepare(
      'SELECT id, name, capabilities_json, is_builtin, archived FROM role_def WHERE workspace_id = ? ORDER BY is_builtin DESC, name',
    )
    .all(ctx.workspaceId) as RoleDefRow[];

  // RESOLVED, not read straight off the row. For an ordinary role the two are the same string, but
  // `resolveCapabilities` is the function that decides what the role actually GRANTS, so routing the
  // advertisement through it means the screen keeps following enforcement even where the row and the
  // resolver would disagree: an anchor id that reached `role_def` past `defineRole`'s `builtin_fixed`
  // (a migration, a hand-edited SQLite file) is still short-circuited to its constant here, exactly
  // as `capabilityFor` short-circuits it, instead of advertising a bundle nothing will honour.
  const stored: RoleView[] = rows.map((row) => ({
    id: row.id,
    name: row.name,
    isBuiltin: row.is_builtin === 1,
    isFixed: false,
    capabilities: resolveCapabilities(ctx.store, ctx.workspaceId, row.id),
    archived: row.archived === 1,
    memberCount: counts.get(row.id) ?? 0,
  }));

  // The editable built-ins this workspace has never tuned: present in the answer at their shipped
  // defaults, so the Roles tab shows five roles in a fresh workspace exactly as it does in a
  // reshaped one, with no row having had to exist for it.
  const storedIds = new Set(stored.map((r) => r.id));
  const unseeded: RoleView[] = EDITABLE_BUILTIN_ROLES.filter((id) => !storedIds.has(id)).map((id) => ({
    id,
    name: id,
    isBuiltin: true,
    isFixed: false,
    capabilities: resolveCapabilities(ctx.store, ctx.workspaceId, id),
    archived: false,
    memberCount: counts.get(id) ?? 0,
  }));

  return ok({
    roles: [...anchorViews(ctx, counts), ...unseeded, ...stored],
    registry: CAPABILITIES.map((c) => ({ id: c.id, group: c.group })),
  });
}

export interface DefineRoleInput {
  roleId?: string;
  name?: string;
  capabilities?: unknown;
  idempotencyKey?: string;
}

/**
 * Create a custom role, or overwrite an editable built-in's bundle.
 *
 * REJECTIONS, and what each one protects:
 *   `permission_denied`    the caller lacks `manage_members`.
 *   `builtin_fixed`        the target is `owner` or `viewer`. The two anchors, by name as well as
 *                          by the short-circuit in `capability.ts`, so the operator is told rather
 *                          than silently ignored.
 *   `unknown_capability`   a name outside the registry. This is what makes "a role can only ever
 *                          recombine capabilities that already gate a real write verb" structural:
 *                          there is no input that mints a new one, so there is no input that mints
 *                          a bypass. The offending name rides in the rejection.
 *   `invalid_input`        a missing name on a create, or a capabilities value that is not an array.
 */
export function defineRole(ctx: WorkspaceContext, input: DefineRoleInput): Result {
  const allowed = ctx.capabilities.assert('manage_members');
  if (!allowed.ok) return allowed;

  const guard =
    optionalId(input.roleId, 'roleId') ?? optionalId(input.idempotencyKey, 'idempotencyKey');
  if (guard) return guard;

  const roleId = input.roleId;
  if (isFixedRole(roleId)) return err('builtin_fixed', { roleId });

  if (!Array.isArray(input.capabilities)) return err('invalid_input', { field: 'capabilities' });
  const unknown = input.capabilities.find((c) => !isCapability(c));
  if (unknown !== undefined) return err('unknown_capability', { capability: unknown });
  // De-duplicated so a bundle is a SET, which is what "recombine the registry" means, and so two
  // spellings of the same grant cannot make a stored bundle disagree with itself.
  const capabilities = [...new Set(input.capabilities as Capability[])];

  const isUpdate = roleId !== undefined;
  const nameGuard = isUpdate ? optionalId(input.name, 'name') : requireString(input.name, 'name');
  if (nameGuard) return nameGuard;

  const key = input.idempotencyKey;
  const hasKey = typeof key === 'string' && key.length > 0;
  if (hasKey) {
    const replayed = ctx.store.recallIdempotent<Result>(ctx.workspaceId, key, 'define_role');
    if (replayed !== undefined) return replayed;
  }

  seedBuiltinRoles(ctx);

  const run = (): Result => {
    const now = ctx.clock.now();
    if (isUpdate) {
      const existing = ctx.store.db
        .prepare('SELECT name FROM role_def WHERE workspace_id = ? AND id = ?')
        .get(ctx.workspaceId, roleId) as { name: string } | undefined;
      if (existing === undefined) return err('role_not_found', { roleId });
      ctx.store.db
        .prepare(
          'UPDATE role_def SET name = ?, capabilities_json = ?, updated_at = ? WHERE workspace_id = ? AND id = ?',
        )
        .run(input.name ?? existing.name, JSON.stringify(capabilities), now, ctx.workspaceId, roleId);
      ctx.audit.record({
        entityKind: 'role_def',
        entityId: roleId as string,
        action: 'update',
        actor: ctx.actor,
        at: now,
      });
      return ok({ roleId, capabilities });
    }

    const id = ctx.ids.next('role');
    ctx.store.db
      .prepare(
        `INSERT INTO role_def
           (id, workspace_id, name, capabilities_json, is_builtin, archived, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, 0, 0, ?, ?, ?)`,
      )
      .run(id, ctx.workspaceId, input.name, JSON.stringify(capabilities), ctx.actor, now, now);
    ctx.audit.record({
      entityKind: 'role_def',
      entityId: id,
      action: 'create',
      actor: ctx.actor,
      at: now,
    });
    return ok({ roleId: id, capabilities });
  };

  return hasKey
    ? ctx.store.rememberIdempotent(ctx.workspaceId, key as string, 'define_role', run)
    : run();
}

export interface ArchiveRoleInput {
  roleId?: string;
  idempotencyKey?: string;
}

/**
 * Soft-flag a custom role. Never a delete, and never a built-in.
 *
 * `role_in_use` fires while any member still holds the role, because archiving out from under a
 * live grant would leave that member resolving against a row `listRoles` no longer offers, and the
 * historical `created_by` stamps made under the role would stop resolving to a name.
 */
export function archiveRole(ctx: WorkspaceContext, input: ArchiveRoleInput): Result {
  const allowed = ctx.capabilities.assert('manage_members');
  if (!allowed.ok) return allowed;

  const guard = requireString(input.roleId, 'roleId') ?? optionalId(input.idempotencyKey, 'idempotencyKey');
  if (guard) return guard;
  const roleId = input.roleId as string;

  // Both the anchors and the three editable built-ins: a built-in is part of the shipped vocabulary
  // every spec's back-reference table names, so archiving one would silently retire a role other
  // capabilities still describe.
  if (isFixedRole(roleId) || EDITABLE_BUILTIN_ROLES.includes(roleId)) {
    return err('builtin_fixed', { roleId });
  }

  const key = input.idempotencyKey;
  const hasKey = typeof key === 'string' && key.length > 0;
  if (hasKey) {
    const replayed = ctx.store.recallIdempotent<Result>(ctx.workspaceId, key, 'archive_role');
    if (replayed !== undefined) return replayed;
  }

  const row = ctx.store.db
    .prepare('SELECT archived FROM role_def WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, roleId) as { archived: number } | undefined;
  if (row === undefined) return err('role_not_found', { roleId });

  const held = ctx.store.db
    .prepare('SELECT COUNT(*) AS n FROM workspace_member WHERE workspace_id = ? AND role = ?')
    .get(ctx.workspaceId, roleId) as { n: number };
  if (held.n > 0) return err('role_in_use', { roleId, memberCount: held.n });

  const run = (): Result => {
    const now = ctx.clock.now();
    ctx.store.db
      .prepare('UPDATE role_def SET archived = 1, updated_at = ? WHERE workspace_id = ? AND id = ?')
      .run(now, ctx.workspaceId, roleId);
    ctx.audit.record({
      entityKind: 'role_def',
      entityId: roleId,
      action: 'archive',
      actor: ctx.actor,
      at: now,
    });
    return ok({ roleId });
  };

  return hasKey
    ? ctx.store.rememberIdempotent(ctx.workspaceId, key as string, 'archive_role', run)
    : run();
}

/** Is `roleId` assignable in this workspace? Used by `inviteMember` and `setRole`. */
export function isAssignableRole(ctx: WorkspaceContext, roleId: string): boolean {
  if (isFixedRole(roleId) || EDITABLE_BUILTIN_ROLES.includes(roleId)) return true;
  const row = ctx.store.db
    .prepare('SELECT archived FROM role_def WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, roleId) as { archived: number } | undefined;
  return row !== undefined && row.archived === 0;
}

/** The resolved bundle for a role, re-exported so `members.ts` has one import for the answer. */
export function capabilitiesOfRole(ctx: WorkspaceContext, roleId: string): readonly Capability[] {
  return resolveCapabilities(ctx.store, ctx.workspaceId, roleId);
}
