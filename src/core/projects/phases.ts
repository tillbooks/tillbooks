/**
 * B00 US-B00.2: phases and milestones. A phase is a planning row under one project; a milestone is a
 * phase carrying `milestone_on`, and `done_at` records the moment it was marked reached.
 *
 * Every phase write resolves the phase THROUGH its project row (never trusting a project id from
 * input) and rejects on a `closed` project with `project_closed`: closed masters are frozen except
 * for the gated reopen (US-B00.5). Budgets are planning aids: a phase sum exceeding the project
 * budget answers `ok` with a `phase_budgets_exceed_project` warning, never a block (spec §2
 * boundary; the project budget is the envelope, the phases are the plan).
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { readProject } from './projects.js';
import type { ProjectRow } from './projects.js';
import { mapPhase } from './shared.js';
import type { PhaseRow } from './shared.js';

export type { PhaseRow } from './shared.js';

function readPhase(ctx: WorkspaceContext, phaseId: string): PhaseRow | undefined {
  return ctx.store.db
    .prepare('SELECT * FROM project_phase WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, phaseId) as PhaseRow | undefined;
}

const ISO_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function isIsoDay(value: unknown): value is string {
  return typeof value === 'string' && ISO_DAY_RE.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

/** The Σ-phase-budgets warning (spec §2, US-B00.2 boundary): advisory, never a block. */
function budgetWarnings(ctx: WorkspaceContext, project: ProjectRow): string[] {
  if (project.budget_minor <= 0) return [];
  const sum = ctx.store.db
    .prepare('SELECT COALESCE(SUM(budget_minor), 0) AS total FROM project_phase WHERE workspace_id = ? AND project_id = ?')
    .get(ctx.workspaceId, project.id) as { total: number };
  return sum.total > project.budget_minor ? ['phase_budgets_exceed_project'] : [];
}

export interface AddPhaseInput {
  projectId?: string;
  name?: string;
  sort?: number;
  budgetMinor?: number;
  budgetHours?: number;
  milestoneOn?: string;
  idempotencyKey?: string;
}

export function addPhase(ctx: WorkspaceContext, input: AddPhaseInput): Result {
  if (typeof input.projectId !== 'string' || input.projectId.length === 0) {
    return err('invalid_input', { field: 'projectId' });
  }
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (name.length === 0) return err('invalid_input', { field: 'name' });

  const sort = input.sort ?? 0;
  if (!Number.isInteger(sort)) return err('invalid_input', { field: 'sort' });
  const budgetMinor = input.budgetMinor ?? 0;
  if (!Number.isInteger(budgetMinor) || budgetMinor < 0) return err('invalid_input', { field: 'budgetMinor' });
  const budgetHours = input.budgetHours ?? 0;
  if (!Number.isInteger(budgetHours) || budgetHours < 0) return err('invalid_input', { field: 'budgetHours' });
  if (input.milestoneOn !== undefined && !isIsoDay(input.milestoneOn)) {
    return err('invalid_input', { field: 'milestoneOn' });
  }

  // The STATE-dependent checks live inside `run` so a replayed key answers the stored result even
  // when the project has since moved (the setProjectStatus reasoning, applied family-wide).
  const run = (): Result => {
    const project = readProject(ctx, input.projectId as string);
    if (project === undefined) return err('project_not_found', { projectId: input.projectId });
    if (project.status === 'closed') return err('project_closed', { projectId: project.id });

    const id = ctx.ids.next('project_phase');
    const now = ctx.clock.now();
    ctx.store.db
      .prepare(
        `INSERT INTO project_phase (
           id, workspace_id, project_id, name, sort, budget_minor, budget_hours,
           milestone_on, done_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      )
      .run(id, ctx.workspaceId, project.id, name, sort, budgetMinor, budgetHours, input.milestoneOn ?? null, now, now);
    return ok({ phase: mapPhase(readPhase(ctx, id) as PhaseRow), warnings: budgetWarnings(ctx, project) });
  };

  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'project_phase_add', run);
  }
  return run();
}

export interface PhasePatch {
  name?: string;
  sort?: number;
  budgetMinor?: number;
  budgetHours?: number;
  milestoneOn?: string | null;
}

export function updatePhase(
  ctx: WorkspaceContext,
  input: { phaseId: string; patch?: PhasePatch; idempotencyKey?: string },
): Result {
  const run = (): Result => {
    const current = readPhase(ctx, input.phaseId);
    if (current === undefined) return err('phase_not_found', { phaseId: input.phaseId });
    const project = readProject(ctx, current.project_id) as ProjectRow;
    if (project.status === 'closed') return err('project_closed', { projectId: project.id });

    const patch = input.patch ?? {};
    const name = patch.name !== undefined ? patch.name.trim() : current.name;
    if (name.length === 0) return err('invalid_input', { field: 'name' });
    const sort = patch.sort ?? current.sort;
    if (!Number.isInteger(sort)) return err('invalid_input', { field: 'sort' });
    const budgetMinor = patch.budgetMinor ?? current.budget_minor;
    if (!Number.isInteger(budgetMinor) || budgetMinor < 0) return err('invalid_input', { field: 'budgetMinor' });
    const budgetHours = patch.budgetHours ?? current.budget_hours;
    if (!Number.isInteger(budgetHours) || budgetHours < 0) return err('invalid_input', { field: 'budgetHours' });
    const milestoneOn = patch.milestoneOn !== undefined ? patch.milestoneOn : current.milestone_on;
    if (milestoneOn !== null && !isIsoDay(milestoneOn)) return err('invalid_input', { field: 'milestoneOn' });

    ctx.store.db
      .prepare(
        `UPDATE project_phase SET name = ?, sort = ?, budget_minor = ?, budget_hours = ?,
           milestone_on = ?, updated_at = ?
         WHERE workspace_id = ? AND id = ?`,
      )
      .run(name, sort, budgetMinor, budgetHours, milestoneOn, ctx.clock.now(), ctx.workspaceId, current.id);
    return ok({ phase: mapPhase(readPhase(ctx, current.id) as PhaseRow), warnings: budgetWarnings(ctx, project) });
  };

  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'project_phase_update', run);
  }
  return run();
}

export function phaseDone(
  ctx: WorkspaceContext,
  input: { phaseId: string; doneAt?: string; idempotencyKey?: string },
): Result {
  if (input.doneAt !== undefined && !isIsoDay(input.doneAt)) return err('invalid_input', { field: 'doneAt' });

  const run = (): Result => {
    const current = readPhase(ctx, input.phaseId);
    if (current === undefined) return err('phase_not_found', { phaseId: input.phaseId });
    const project = readProject(ctx, current.project_id) as ProjectRow;
    if (project.status === 'closed') return err('project_closed', { projectId: project.id });

    // "Mark this reached" is a state assertion: an already-done phase answers ok with the recorded
    // date untouched (`alreadyDone: true`), never a second stamp that would rewrite when it happened.
    if (current.done_at !== null) {
      return ok({ phase: mapPhase(current), alreadyDone: true });
    }
    const doneAt = input.doneAt ?? ctx.clock.now().slice(0, 10);
    ctx.store.db
      .prepare('UPDATE project_phase SET done_at = ?, updated_at = ? WHERE workspace_id = ? AND id = ?')
      .run(doneAt, ctx.clock.now(), ctx.workspaceId, current.id);
    return ok({ phase: mapPhase(readPhase(ctx, current.id) as PhaseRow), alreadyDone: false });
  };

  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'project_phase_done', run);
  }
  return run();
}
