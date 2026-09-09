/**
 * G03, the first-run wizard's resume pointer (US-G03.1).
 *
 * TWO VERBS OVER ONE ROW, AND THE ROW IS BOOKKEEPING, NEVER A GATE. `advanceOnboardingStep` is an
 * absolute upsert of `{path, step}` per workspace so a closed tab resumes where it left off, and
 * `getOnboardingProgress` reads it back. Nothing consults this row to decide whether a setup verb
 * may run: A00/A05's own validation is the single source of truth, which is why a replayed or
 * skipped step costs nothing (spec §4). It is also why the write sits on the conformance
 * idempotency-key exemption list: re-asserting the same pointer is the idempotency.
 *
 * `workspaceKind` RIDES ALONG ON THE READ so the Studio shell can key its demo banner
 * (`kind='demo'`, G12's enum) off the one call the Onboarding surface already makes, rather than
 * growing a second workspace-kind read verb.
 */

import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import type { WorkspaceContext } from '../context.js';

// --- §H-ENUM: the onboarding paths, single-sourced here ----------------------------------------

/** The three first-run paths. `import` covers both bexio and generic CSV: the G09 harness owns the split. */
export const ONBOARDING_PATHS = ['fresh', 'import', 'demo'] as const;

export type OnboardingPath = (typeof ONBOARDING_PATHS)[number];

export function isOnboardingPath(value: unknown): value is OnboardingPath {
  return typeof value === 'string' && (ONBOARDING_PATHS as readonly string[]).includes(value);
}

interface ProgressRow {
  path: string;
  step: string;
  completed_at: string | null;
}

export type OnboardingProgressOk = {
  progress: { path: string; step: string; completedAt: string | null } | null;
  /** The G12 `workspace.kind` (`demo | sandbox | live`), so the shell banner needs no second verb. */
  workspaceKind: string;
};

/** The wizard resume point plus the workspace kind, in one read (spec §5). */
export function getOnboardingProgress(ctx: WorkspaceContext): Result<OnboardingProgressOk> {
  const ws = ctx.store.db
    .prepare('SELECT kind FROM workspace WHERE id = ?')
    .get(ctx.workspaceId) as { kind: string } | undefined;
  if (ws === undefined) return err('not_found', { workspaceId: ctx.workspaceId });
  const row = ctx.store.db
    .prepare('SELECT path, step, completed_at FROM onboarding_progress WHERE workspace_id = ?')
    .get(ctx.workspaceId) as ProgressRow | undefined;
  return ok<OnboardingProgressOk>({
    progress:
      row === undefined ? null : { path: row.path, step: row.step, completedAt: row.completed_at },
    workspaceKind: ws.kind,
  });
}

export interface AdvanceOnboardingStepInput {
  path: unknown;
  step: unknown;
  completed?: unknown;
}

export type AdvanceOnboardingStepOk = {
  path: string;
  step: string;
  completedAt: string | null;
};

/**
 * Persist the resume pointer, absolutely (US-G03.1). Replaying the same call re-asserts the same
 * state (the `set_fiscal_config` exemption shape); `completed:true` stamps `completed_at` once, and
 * a later advance never un-completes it (a finished wizard stays finished even if a surface writes
 * a stray pointer afterwards).
 */
export function advanceOnboardingStep(
  ctx: WorkspaceContext,
  input: AdvanceOnboardingStepInput,
): Result<AdvanceOnboardingStepOk> {
  if (!isOnboardingPath(input.path)) return err('invalid_path', { path: input.path });
  if (typeof input.step !== 'string' || input.step.trim().length === 0) {
    return err('invalid_step', { step: input.step });
  }
  if (input.completed !== undefined && typeof input.completed !== 'boolean') {
    return err('invalid_input', { field: 'completed' });
  }
  const now = ctx.clock.now();
  const completedAt = input.completed === true ? now : null;
  ctx.store.db
    .prepare(
      `INSERT INTO onboarding_progress (workspace_id, path, step, completed_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(workspace_id) DO UPDATE SET
         path = excluded.path,
         step = excluded.step,
         completed_at = COALESCE(onboarding_progress.completed_at, excluded.completed_at),
         updated_at = excluded.updated_at`,
    )
    .run(ctx.workspaceId, input.path, input.step, completedAt, now);
  const row = ctx.store.db
    .prepare('SELECT path, step, completed_at FROM onboarding_progress WHERE workspace_id = ?')
    .get(ctx.workspaceId) as ProgressRow;
  return ok<AdvanceOnboardingStepOk>({ path: row.path, step: row.step, completedAt: row.completed_at });
}
