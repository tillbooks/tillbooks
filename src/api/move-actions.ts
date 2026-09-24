/**
 * M03's two verbs, defined here and spread into `ACTIONS` as one line (the `onboardingActions` /
 * `fxActions` precedent), so several agents appending to the append-only registry at once collide
 * over a line rather than a block.
 *
 * `get_move_state` / `advance_move_step` are the Hosting panel's move-checklist resume pointer,
 * the G03 `get_onboarding_progress`/`advance_onboarding_step` shape verbatim: bookkeeping and never
 * a gate. G03's own pair carries `{path, step}` for ONBOARDING only and may not be stretched to
 * carry a move (spec M03, Stack-landing), which is why this pair exists at all. Every other action
 * on the M03 surfaces calls a verb that already exists (`create_backup`, `archive_workspace`, ...).
 *
 * As with `fx-actions.ts`, the helpers arrive as a parameter rather than an import, so the module
 * graph stays acyclic: `registry.ts` imports this file and this file must not import it back.
 */

import type { ActionDef, ActionInput, JsonSchema } from './registry.js';
import type { WorkspaceContext } from '../core/context.js';
import type { Result } from '../core/result.js';
import { getMoveState, advanceMoveStep } from '../core/move/index.js';

export interface MoveActionHelpers {
  ctxAction(
    name: string,
    kind: 'read' | 'write',
    summary: string,
    inputSchema: JsonSchema,
    call: (ctx: WorkspaceContext, input: ActionInput) => Result,
  ): ActionDef;
  ctxSchema(props?: Record<string, unknown>, required?: string[]): JsonSchema;
  STR: { readonly type: 'string' };
  BOOL: { readonly type: 'boolean' };
  INT: { readonly type: 'integer' };
}

/** The registry's documented cast: the JSON input is handed to the verb as its typed input. */
function as<T>(input: ActionInput): T {
  return input as unknown as T;
}

/** The M03 verbs, in append order (read then write, the G03 table order). */
export function moveActions(h: MoveActionHelpers): readonly ActionDef[] {
  const { ctxAction, ctxSchema, STR, BOOL, INT } = h;

  return [
    ctxAction(
      'get_move_state',
      'read',
      'Read the move-checklist resume point for this workspace: the direction the books are moving (local_to_selfhost | local_to_managed | selfhost_to_managed | selfhost_to_local | managed_to_local | managed_to_selfhost), the five checklist steps each with the instant it was checked off (or null), startedAt and completedAt; or move:null when no move was started. Pure bookkeeping: nothing in the engine gates on this row. A COMPLETED move keeps its record, which is what the stale-writable notice (a moved but unarchived ledger) is derived from.',
      ctxSchema(),
      (ctx) => getMoveState(ctx),
    ),
    ctxAction(
      'advance_move_step',
      'write',
      'Persist the move-checklist resume point, absolutely (the advance_onboarding_step shape): direction alone starts or re-asserts the move; direction plus step (1-5, done defaulting true) checks a step off or, with done:false, un-checks it (the trial-balance-mismatch recovery); abandon:true deletes the pointer (Umzug abbrechen). Never a gate: the real actions of the journey (create_backup, archive_workspace, the manual legs on the other machine) keep their own validation, and the step timestamps record a claim, not a proof. A different direction than the stored one resets the checklist. completedAt is derived: stamped when all five steps are done, cleared when one is un-done.',
      ctxSchema({ direction: STR, step: INT, done: BOOL, abandon: BOOL }, ['direction']),
      (ctx, input) => advanceMoveStep(ctx, as(input)),
    ),
  ];
}
