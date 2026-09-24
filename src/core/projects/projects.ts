/**
 * B00, the projects master: the cluster-B spine every later B-capability (B01 time, B02 billing,
 * B03 job costing, B04 retainers) hangs its "which project is this for?" answer on.
 *
 * NO POSTING PATH EXISTS HERE, structurally (P3 trivially satisfied): budgets are plans, actuals are
 * a pure read of rows A02/A17 already own, and nothing in this directory imports `postEntry` or
 * `recordPayment`. `test/core/projects.test.mjs` greps that this sentence stays true.
 *
 * Columns are snake_case, the verb surface is camelCase, and the two meet only in `mapProject`.
 * Every query stamps `workspace_id` (§H-TENANT); every write takes an idempotencyKey
 * (§H-IDEMPOTENT). Money is integer Rappen (P2), and a non-base-currency budget snapshots
 * `budget_base_minor` + `fx_rate` through §H-FX's `resolveFxRate` at creation, re-snapshotted only
 * when `currency` or `budgetMinor` change (never silently re-rated).
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result, Err } from '../result.js';
import { baseCurrencyOf, resolveFxRate } from '../fx/rates.js';
import { convertMinor, isCurrencyCode, parseRate } from '../fx/rateMath.js';
import { applySavedView } from '../customization/views.js';
import { isProjectStatus, isLegalTransition } from './enums.js';
import type { ProjectStatus } from './enums.js';
import { mapPhase } from './shared.js';
import type { PhaseRow } from './shared.js';

export interface ProjectRow {
  id: string;
  workspace_id: string;
  code: string;
  name: string;
  contact_id: string;
  status: string;
  currency: string;
  budget_minor: number;
  budget_hours: number;
  budget_base_minor: number | null;
  fx_rate: string | null;
  starts_on: string | null;
  ends_on: string | null;
  parent_id: string | null;
  created_at: string;
  updated_at: string;
}

export function mapProject(row: ProjectRow) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    code: row.code,
    name: row.name,
    contactId: row.contact_id,
    status: row.status,
    currency: row.currency,
    budgetMinor: row.budget_minor,
    budgetHours: row.budget_hours,
    budgetBaseMinor: row.budget_base_minor,
    fxRate: row.fx_rate,
    startsOn: row.starts_on,
    endsOn: row.ends_on,
    parentId: row.parent_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function readProject(ctx: WorkspaceContext, projectId: string): ProjectRow | undefined {
  return ctx.store.db
    .prepare('SELECT * FROM project WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, projectId) as ProjectRow | undefined;
}

/** An ISO calendar day, the only date shape B00 stores (a full instant would defeat date ordering). */
const ISO_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function isIsoDay(value: unknown): value is string {
  return typeof value === 'string' && ISO_DAY_RE.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

/**
 * The close-guard registry, the extension point spec §4 names. B01 registers `open_time` here when
 * its `time_entries` table exists; D03 registers its open-orders guard the same way. Empty today, so
 * `active→closed` succeeds pre-B01, exactly as US-B00.4's scope fence describes. A guard answers an
 * `Err` to block the close and `undefined` to let it pass.
 */
export type CloseGuard = (ctx: WorkspaceContext, project: ProjectRow) => Err | undefined;

const CLOSE_GUARDS: CloseGuard[] = [];

export function registerCloseGuard(guard: CloseGuard): void {
  CLOSE_GUARDS.push(guard);
}

/** The next free auto-suggested code (`P-0001` upward), per workspace. */
function suggestCode(ctx: WorkspaceContext): string {
  const rows = ctx.store.db
    .prepare("SELECT code FROM project WHERE workspace_id = ? AND code LIKE 'P-%'")
    .all(ctx.workspaceId) as { code: string }[];
  let max = 0;
  for (const row of rows) {
    const m = /^P-(\d+)$/.exec(row.code);
    if (m !== null) max = Math.max(max, Number(m[1]));
  }
  return `P-${String(max + 1).padStart(4, '0')}`;
}

/** A live (non-tombstoned) contact in this tenant, or undefined. */
function contactExists(ctx: WorkspaceContext, contactId: string): boolean {
  const row = ctx.store.db
    .prepare('SELECT id FROM contact WHERE workspace_id = ? AND id = ? AND merged_into_id IS NULL')
    .get(ctx.workspaceId, contactId) as { id: string } | undefined;
  return row !== undefined;
}

/**
 * Would parenting `projectId` under `parentId` create a cycle? Walks the ancestor chain of the
 * proposed parent; a chain that reaches `projectId` (or the parent IS the project) is a cycle. The
 * walk is bounded by the visited set, so even a hand-edited database cannot loop it.
 */
function createsCycle(ctx: WorkspaceContext, projectId: string, parentId: string): boolean {
  if (projectId === parentId) return true;
  const seen = new Set<string>([projectId]);
  let cursor: string | null = parentId;
  while (cursor !== null) {
    if (seen.has(cursor)) return true;
    seen.add(cursor);
    const row = readProject(ctx, cursor);
    if (row === undefined) return false;
    cursor = row.parent_id;
  }
  return false;
}

/**
 * The §H-FX snapshot for a non-base-currency budget: `budgetBaseMinor` + the rate that produced it.
 * A base-currency budget answers nulls (a stored copy of the same figure would be a drift risk).
 */
function snapshotBudgetBase(
  ctx: WorkspaceContext,
  currency: string,
  budgetMinor: number,
  explicitRate: string | undefined,
): Result<{ budgetBaseMinor: number | null; fxRate: string | null }> {
  const base = baseCurrencyOf(ctx);
  if (currency === base) return ok({ budgetBaseMinor: null, fxRate: null });
  const today = ctx.clock.now().slice(0, 10);
  const resolution = resolveFxRate(ctx, { currency, date: today, explicitRate });
  if (!resolution.ok) return resolution;
  return ok({
    budgetBaseMinor: convertMinor(budgetMinor, resolution.resolved.rateScaled),
    fxRate: resolution.resolved.rate,
  });
}

export interface CreateProjectInput {
  name?: string;
  contactId?: string;
  code?: string;
  currency?: string;
  budgetMinor?: number;
  budgetHours?: number;
  startsOn?: string;
  endsOn?: string;
  parentId?: string;
  fxRate?: string;
  idempotencyKey?: string;
}

export function createProject(ctx: WorkspaceContext, input: CreateProjectInput): Result {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (name.length === 0) return err('invalid_input', { field: 'name' });

  if (typeof input.contactId !== 'string' || input.contactId.length === 0) {
    return err('invalid_input', { field: 'contactId' });
  }

  const budgetMinor = input.budgetMinor ?? 0;
  if (!Number.isInteger(budgetMinor) || budgetMinor < 0) return err('invalid_input', { field: 'budgetMinor' });
  const budgetHours = input.budgetHours ?? 0;
  if (!Number.isInteger(budgetHours) || budgetHours < 0) return err('invalid_input', { field: 'budgetHours' });

  const currency = input.currency ?? baseCurrencyOf(ctx);
  if (!isCurrencyCode(currency)) return err('invalid_input', { field: 'currency' });
  if (input.fxRate !== undefined && parseRate(input.fxRate) === null) {
    return err('invalid_input', { field: 'fxRate' });
  }

  if (input.startsOn !== undefined && !isIsoDay(input.startsOn)) return err('invalid_input', { field: 'startsOn' });
  if (input.endsOn !== undefined && !isIsoDay(input.endsOn)) return err('invalid_input', { field: 'endsOn' });
  if (input.startsOn !== undefined && input.endsOn !== undefined && input.endsOn < input.startsOn) {
    return err('invalid_dates', { startsOn: input.startsOn, endsOn: input.endsOn });
  }

  // The STATE-dependent checks (contact, parent, code uniqueness, the FX snapshot) live inside
  // `run` so a replayed key answers the stored result even when the state has since moved (the
  // setProjectStatus reasoning, applied family-wide).
  const run = (): Result => {
    if (!contactExists(ctx, input.contactId as string)) {
      return err('contact_not_found', { contactId: input.contactId });
    }
    if (input.parentId !== undefined) {
      const parent = readProject(ctx, input.parentId);
      // Same workspace by construction: readProject is tenant-scoped, so a cross-tenant parent id is
      // simply not found (§H-TENANT, US-B00.3).
      if (parent === undefined) return err('parent_not_found', { parentId: input.parentId });
    }

    const code = typeof input.code === 'string' && input.code.trim().length > 0 ? input.code.trim() : suggestCode(ctx);
    const taken = ctx.store.db
      .prepare('SELECT id FROM project WHERE workspace_id = ? AND code = ?')
      .get(ctx.workspaceId, code) as { id: string } | undefined;
    if (taken !== undefined) return err('code_taken', { code });

    const snapshot = snapshotBudgetBase(ctx, currency, budgetMinor, input.fxRate);
    if (!snapshot.ok) return snapshot;

    const id = ctx.ids.next('project');
    const now = ctx.clock.now();
    ctx.store.db
      .prepare(
        `INSERT INTO project (
           id, workspace_id, code, name, contact_id, status, currency,
           budget_minor, budget_hours, budget_base_minor, fx_rate,
           starts_on, ends_on, parent_id, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        ctx.workspaceId,
        code,
        name,
        input.contactId,
        currency,
        budgetMinor,
        budgetHours,
        snapshot.budgetBaseMinor,
        snapshot.fxRate,
        input.startsOn ?? null,
        input.endsOn ?? null,
        input.parentId ?? null,
        now,
        now,
      );
    return ok({ project: mapProject(readProject(ctx, id) as ProjectRow) });
  };

  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'project_create', run);
  }
  return run();
}

export interface ProjectPatch {
  name?: string;
  contactId?: string;
  code?: string;
  currency?: string;
  budgetMinor?: number;
  budgetHours?: number;
  startsOn?: string | null;
  endsOn?: string | null;
  parentId?: string | null;
  fxRate?: string;
}

export function updateProject(
  ctx: WorkspaceContext,
  input: { projectId: string; patch?: ProjectPatch; idempotencyKey?: string },
): Result {
  // Everything state-dependent lives inside `run` (the setProjectStatus reasoning): a replayed key
  // answers the stored result, never a re-judgment against state the first call already moved.
  const run = (): Result => {
    const current = readProject(ctx, input.projectId);
    if (current === undefined) return err('project_not_found', { projectId: input.projectId });
    if (current.status === 'closed') return err('project_closed', { projectId: input.projectId });

    const patch = input.patch ?? {};

    const name = patch.name !== undefined ? patch.name.trim() : current.name;
    if (name.length === 0) return err('invalid_input', { field: 'name' });

    const contactId = patch.contactId ?? current.contact_id;
    if (patch.contactId !== undefined && !contactExists(ctx, patch.contactId)) {
      return err('contact_not_found', { contactId: patch.contactId });
    }

    const budgetMinor = patch.budgetMinor ?? current.budget_minor;
    if (!Number.isInteger(budgetMinor) || budgetMinor < 0) return err('invalid_input', { field: 'budgetMinor' });
    const budgetHours = patch.budgetHours ?? current.budget_hours;
    if (!Number.isInteger(budgetHours) || budgetHours < 0) return err('invalid_input', { field: 'budgetHours' });

    const currency = patch.currency ?? current.currency;
    if (!isCurrencyCode(currency)) return err('invalid_input', { field: 'currency' });

    const startsOn = patch.startsOn !== undefined ? patch.startsOn : current.starts_on;
    if (startsOn !== null && !isIsoDay(startsOn)) return err('invalid_input', { field: 'startsOn' });
    const endsOn = patch.endsOn !== undefined ? patch.endsOn : current.ends_on;
    if (endsOn !== null && !isIsoDay(endsOn)) return err('invalid_input', { field: 'endsOn' });
    if (startsOn !== null && endsOn !== null && endsOn < startsOn) {
      return err('invalid_dates', { startsOn, endsOn });
    }

    const parentId = patch.parentId !== undefined ? patch.parentId : current.parent_id;
    if (parentId !== null && parentId !== current.parent_id) {
      const parent = readProject(ctx, parentId);
      if (parent === undefined) return err('parent_not_found', { parentId });
      if (createsCycle(ctx, current.id, parentId)) return err('parent_cycle', { projectId: current.id, parentId });
    }

    const code = patch.code !== undefined ? patch.code.trim() : current.code;
    if (code.length === 0) return err('invalid_input', { field: 'code' });
    if (code !== current.code) {
      const taken = ctx.store.db
        .prepare('SELECT id FROM project WHERE workspace_id = ? AND code = ? AND id != ?')
        .get(ctx.workspaceId, code, current.id) as { id: string } | undefined;
      if (taken !== undefined) return err('code_taken', { code });
    }

    // Re-snapshot FX only when currency or the budget itself moved (spec §4: never silently re-rate).
    const budgetTouched = patch.currency !== undefined || patch.budgetMinor !== undefined;
    let budgetBaseMinor = current.budget_base_minor;
    let fxRate = current.fx_rate;
    if (budgetTouched) {
      if (patch.fxRate !== undefined && parseRate(patch.fxRate) === null) {
        return err('invalid_input', { field: 'fxRate' });
      }
      const snapshot = snapshotBudgetBase(ctx, currency, budgetMinor, patch.fxRate);
      if (!snapshot.ok) return snapshot;
      budgetBaseMinor = snapshot.budgetBaseMinor;
      fxRate = snapshot.fxRate;
    }

    ctx.store.db
      .prepare(
        `UPDATE project SET
           code = ?, name = ?, contact_id = ?, currency = ?,
           budget_minor = ?, budget_hours = ?, budget_base_minor = ?, fx_rate = ?,
           starts_on = ?, ends_on = ?, parent_id = ?, updated_at = ?
         WHERE workspace_id = ? AND id = ?`,
      )
      .run(
        code,
        name,
        contactId,
        currency,
        budgetMinor,
        budgetHours,
        budgetBaseMinor,
        fxRate,
        startsOn,
        endsOn,
        parentId,
        ctx.clock.now(),
        ctx.workspaceId,
        current.id,
      );
    return ok({ project: mapProject(readProject(ctx, current.id) as ProjectRow) });
  };

  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'project_update', run);
  }
  return run();
}

export function setProjectStatus(
  ctx: WorkspaceContext,
  input: { projectId: string; status?: string; idempotencyKey?: string },
): Result {
  // EVERYTHING lives inside `run`, deliberately: the transition guard reads the CURRENT status, so
  // a validation outside the idempotency wrapper would judge the replay against the state the first
  // call already moved (active→active on a replayed activate) instead of returning the stored
  // result. The conformance double-call is what caught this shape.
  const run = (): Result => {
    const current = readProject(ctx, input.projectId);
    if (current === undefined) return err('project_not_found', { projectId: input.projectId });

    if (!isProjectStatus(input.status)) {
      return err('invalid_status', { status: input.status, known: ['draft', 'active', 'on_hold', 'closed'] });
    }
    const from = current.status as ProjectStatus;
    const to = input.status;
    if (!isLegalTransition(from, to)) return err('invalid_transition', { from, to });

    if (to === 'closed') {
      for (const guard of CLOSE_GUARDS) {
        const blocked = guard(ctx, current);
        if (blocked !== undefined) return blocked;
      }
    }

    ctx.store.db
      .prepare('UPDATE project SET status = ?, updated_at = ? WHERE workspace_id = ? AND id = ?')
      .run(to, ctx.clock.now(), ctx.workspaceId, current.id);
    // The reopen trail (spec §0/US-B00.5): who reopened a closed project, and when, through the A03
    // audit port. Only the reopen: the ordinary transitions are visible on the row itself.
    if (from === 'closed' && to === 'active') {
      ctx.audit.record({
        entityKind: 'project',
        entityId: current.id,
        action: 'reopen',
        actor: ctx.actor,
        at: ctx.clock.now(),
      });
    }
    return ok({ project: mapProject(readProject(ctx, current.id) as ProjectRow) });
  };

  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'project_set_status', run);
  }
  return run();
}

export function deleteProject(
  ctx: WorkspaceContext,
  input: { projectId: string; idempotencyKey?: string },
): Result {
  const run = (): Result => {
    const current = readProject(ctx, input.projectId);
    if (current === undefined) return err('project_not_found', { projectId: input.projectId });
    // Draft-only (§H-AUDIT spirit): anything that ever went active has history and is CLOSED, never
    // erased. The delete exists so a mis-created draft does not haunt the list forever.
    if (current.status !== 'draft') return err('not_draft', { projectId: current.id, status: current.status });

    const child = ctx.store.db
      .prepare('SELECT id FROM project WHERE workspace_id = ? AND parent_id = ? LIMIT 1')
      .get(ctx.workspaceId, current.id) as { id: string } | undefined;
    if (child !== undefined) return err('has_children', { projectId: current.id });

    // The OP3 census: a draft carrying custom-field values or linked files is referenced, and a
    // referenced record is not erased out from under what points at it (the delete_item precedent).
    const phaseIds = (
      ctx.store.db
        .prepare('SELECT id FROM project_phase WHERE workspace_id = ? AND project_id = ?')
        .all(ctx.workspaceId, current.id) as { id: string }[]
    ).map((r) => r.id);
    const refs: string[] = [];
    const valueRef = ctx.store.db
      .prepare(
        "SELECT entity_id FROM custom_field_value WHERE workspace_id = ? AND entity_kind IN ('project', 'project_phase') AND entity_id IN (" +
          ['?', ...phaseIds.map(() => '?')].join(', ') +
          ') LIMIT 1',
      )
      .get(ctx.workspaceId, current.id, ...phaseIds) as { entity_id: string } | undefined;
    if (valueRef !== undefined) refs.push('custom_field_value');
    const fileRef = ctx.store.db
      .prepare(
        "SELECT id FROM stored_file WHERE workspace_id = ? AND entity_kind IN ('project', 'project_phase') AND entity_id IN (" +
          ['?', ...phaseIds.map(() => '?')].join(', ') +
          ') LIMIT 1',
      )
      .get(ctx.workspaceId, current.id, ...phaseIds) as { id: string } | undefined;
    if (fileRef !== undefined) refs.push('stored_file');
    if (refs.length > 0) return err('project_referenced', { projectId: current.id, refs });

    return ctx.store.tx(() => {
      // Phases are owned planning rows of a draft: they go with it, inside the one transaction.
      ctx.store.db
        .prepare('DELETE FROM project_phase WHERE workspace_id = ? AND project_id = ?')
        .run(ctx.workspaceId, current.id);
      ctx.store.db.prepare('DELETE FROM project WHERE workspace_id = ? AND id = ?').run(ctx.workspaceId, current.id);
      return ok({ projectId: current.id, deleted: true });
    });
  };

  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'project_delete', run);
  }
  return run();
}

export function listProjects(
  ctx: WorkspaceContext,
  filter: {
    status?: string;
    contactId?: string;
    parentId?: string;
    query?: string;
    savedViewId?: string;
  } = {},
): Result {
  // The G00 seam, one unconditional call, exactly as `listContacts` makes it: the view's stored
  // filters merge UNDER the caller's explicit ones, so an explicit filter always wins.
  const viewed = applySavedView(ctx, 'project', filter);
  if (!viewed.ok) return viewed;
  filter = viewed.filter;

  const clauses = ['workspace_id = ?'];
  const params: string[] = [ctx.workspaceId];
  if (filter.status !== undefined) {
    clauses.push('status = ?');
    params.push(filter.status);
  }
  if (filter.contactId !== undefined) {
    clauses.push('contact_id = ?');
    params.push(filter.contactId);
  }
  if (filter.parentId !== undefined) {
    clauses.push('parent_id = ?');
    params.push(filter.parentId);
  }
  if (filter.query !== undefined && filter.query.length > 0) {
    clauses.push('(name LIKE ? OR code LIKE ?)');
    const like = `%${filter.query}%`;
    params.push(like, like);
  }
  const rows = ctx.store.db
    .prepare(`SELECT * FROM project WHERE ${clauses.join(' AND ')} ORDER BY code`)
    .all(...params) as ProjectRow[];
  return ok({ projects: rows.map(mapProject) });
}

export function getProject(
  ctx: WorkspaceContext,
  input: { projectId: string; phaseDone?: boolean; savedViewId?: string },
): Result {
  const row = readProject(ctx, input.projectId);
  if (row === undefined) return err('project_not_found', { projectId: input.projectId });
  // The G00 seam over the PHASE list (`project_phase` views), the `migration_get_plan` precedent:
  // a stored `phaseDone` filter merges UNDER an explicit one, so an explicit filter always wins.
  const viewed = applySavedView(ctx, 'project_phase', {
    ...(input.phaseDone !== undefined ? { phaseDone: input.phaseDone } : {}),
    ...(input.savedViewId !== undefined ? { savedViewId: input.savedViewId } : {}),
  } as { phaseDone?: boolean; savedViewId?: string });
  if (!viewed.ok) return viewed;
  const filter = viewed.filter;
  let phases = ctx.store.db
    .prepare('SELECT * FROM project_phase WHERE workspace_id = ? AND project_id = ? ORDER BY sort, name')
    .all(ctx.workspaceId, input.projectId) as PhaseRow[];
  if (filter.phaseDone !== undefined) {
    phases = phases.filter((p) => (p.done_at !== null) === filter.phaseDone);
  }
  return ok({ project: { ...mapProject(row), phases: phases.map(mapPhase) } });
}
