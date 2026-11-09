/**
 * The INTEGRATION SEAMS G09 leaves for its later siblings, each a narrow interface with a SAFE
 * default so G09's gate passes standalone; the later waves bind the real modules against these
 * signatures without touching `steps.ts` or `plan.ts`.
 *
 * The point of a seam is that the default is honest, never a lie that flips a gate green. A seam that
 * cannot answer returns the conservative answer: an unbound archive is `unavailable` (never a silent
 * success), an unbuilt backup precondition is UNMET (never waved through), and the neutral G11 check
 * asserts NO control rather than a passing one, so the commit gate's "no failed and no not_asserted"
 * leg is satisfied by there being nothing to assert, not by a fabricated pass.
 */

import type { WorkspaceContext } from '../context.js';
import type { Result } from '../result.js';
import { seamCheckStep } from './check.js';
import { archiveImport } from './archive.js';
import { testmandantWorkspaceId } from './testmandant.js';

export type ControlStatus = 'passed' | 'failed' | 'not_asserted' | 'not_computable' | 'waived';

export interface CheckControl {
  readonly id: string;
  readonly status: ControlStatus;
  readonly detail?: string;
}

export interface CheckResult {
  readonly controls: readonly CheckControl[];
  /** The hash a `migration_approval` binds to. Recomputed on every check; stable for stable input. */
  readonly checkHash: string;
}

export interface StepForCheck {
  readonly id: string;
  readonly dataClass: string;
  readonly counts: Readonly<Record<string, unknown>> | null;
}

/**
 * // INTEGRATION-SEAM(G11): the Eröffnungsprüfung, G11's `checkStep` (the commit gate's readiness
 * check). BOUND to the real check engine (`check.ts` `seamCheckStep`): the trial-run controls
 * (`trial_balance_balanced`, `trial_balance_matches_source` over the staged position, `row_count`,
 * `document_integrity`, `source_as_at`, and the ledger-membership controls reporting
 * `not_computable` until G12 provisions a Testmandant), each
 * `passed | failed | not_asserted | not_computable | waived`, and the commit gate reads exactly
 * this shape unchanged: a mis-tied or undeclared control REFUSES the commit (G09 §4 condition 2).
 */
export function checkStep(ctx: WorkspaceContext, step: StepForCheck): CheckResult {
  return seamCheckStep(ctx, step);
}

/**
 * // INTEGRATION-SEAM(G12), BOUND (03.08.2026): the Testmandant, G12's disposable trial workspace.
 * The binding delegates to `testmandant.ts`'s `testmandantWorkspaceId`, the real engine's resolver:
 * the plan's Testmandant workspace id when `createTestmandant` has provisioned one, else `null`. When
 * it is null, `trialLoadStep` runs its classifier and records the step's row-level outcomes WITHOUT
 * writing to the live books, which stays the safe behaviour until an operator provisions a Testmandant.
 */
export function testmandantFor(plan: { testmandant_workspace_id?: string | null }): string | null {
  return testmandantWorkspaceId(plan);
}

/**
 * // INTEGRATION-SEAM(G13), BOUND (03.08.2026): the historical GL archive. The `gl_history` class
 * routes here from `commitRoute`, and the binding delegates to the real `archiveImport` in
 * `./archive.ts`. The seam passes NO idempotency key (the caller, `commitStep`, already wraps the
 * whole commit in its own `rememberIdempotent`), which `archiveImport` accepts: the import is
 * idempotent by construction, replacing the step's rows wholesale (G13 spec §0 correction 4).
 */
export function glArchiveImport(ctx: WorkspaceContext, input: unknown): Result {
  const shaped = input as { planId?: unknown; stepId?: unknown };
  return archiveImport(ctx, { planId: shaped.planId, stepId: shaped.stepId });
}

/**
 * // INTEGRATION-SEAM(G04), BOUND (G18 R1): the `create_backup` precondition of the first live
 * commit (commit gate condition 6, a canon blocker). The plan's `backup_ref` is non-null exactly
 * when `create_backup` was called with this plan's id AFTER the plan reached `planned`, in this
 * workspace (portability.ts writes it only under those conditions, §H-TENANT). A backup taken while
 * the plan was still `draft` leaves `backup_ref` null, so the leg stays unsatisfied: the since-
 * `planned` condition is enforced by the writer, and this reader is the honest non-null check over
 * it. Before G18 the column had no writer and a money-path first commit was refused forever with
 * `needs_backup`; the leg is now a real, satisfiable conjunction.
 */
export function hasPreMigrationBackup(plan: { backup_ref?: string | null }): boolean {
  return plan.backup_ref !== null && plan.backup_ref !== undefined;
}

