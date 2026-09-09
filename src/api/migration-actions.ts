/**
 * G09's twelve verbs, defined here and spread into `ACTIONS` as one line (the `fxActions` /
 * `migrationMapActions` precedent), so several agents appending to the append-only registry at once
 * collide over a line rather than a block.
 *
 * All twelve are `ctxAction` registrations (every verb takes `workspaceId`, §H-TENANT): a plan lives
 * in a workspace's books, unlike G10's two catalog reads which describe the software. Seven are
 * writes (create/scope/trial/commit/approval/rollback/abandon), five are reads (discover/get/list/
 * preview/readiness). Every read except `discover` carries `readOnlyHint`; `discover` reads blobs
 * back through E00 and writes only the plan's own Beleg link, so it is a WRITE-shaped read and stays
 * a read verb without the hint. Preview carries `readOnlyHint` and genuinely writes nothing (spec §7).
 *
 * As with `fx-actions.ts`, the helpers arrive as a parameter rather than an import, so the module
 * graph stays acyclic: `registry.ts` imports this file and this file must not import it back.
 */

import type { ActionDef, ActionInput, JsonSchema } from './registry.js';
import type { WorkspaceContext } from '../core/context.js';
import type { Result } from '../core/result.js';
import {
  discoverSource,
  createPlan,
  setScope,
  getPlan,
  listPlans,
  previewStep,
  trialLoadStep,
  commitStep,
  recordApproval,
  rollbackStep,
  readiness,
  abandonPlan,
  closePlan,
} from '../core/migration/index.js';

export interface MigrationActionHelpers {
  ctxAction(
    name: string,
    kind: 'read' | 'write',
    summary: string,
    inputSchema: JsonSchema,
    call: (ctx: WorkspaceContext, input: ActionInput) => Result,
  ): ActionDef;
  ctxSchema(props?: Record<string, unknown>, required?: string[]): JsonSchema;
  STR: { readonly type: 'string' };
}

/** The registry's documented cast: the JSON input is handed to the verb as its typed input. */
function as<T>(input: ActionInput): T {
  return input as unknown as T;
}

/** The G09 verbs, in append order (the §5 table order). */
export function migrationActions(h: MigrationActionHelpers): readonly ActionDef[] {
  const { ctxAction, ctxSchema, STR } = h;
  const STR_LIST = { type: 'array', items: STR } as const;
  const CLASSES = { type: 'array' } as const;
  const BOOL = { type: 'boolean' } as const;
  // K-15: the discover override. Every field is optional; the engine validates each against its own
  // single-source vocab (the adapter registry, the encoding set, the delimiter names) and refuses a
  // garbage value with invalid_input naming the field. The enums here mirror that vocab for agents.
  const DISCOVER_OVERRIDE = {
    type: 'object',
    properties: {
      adapter: STR,
      encoding: { type: 'string', enum: ['utf-8', 'latin1', 'windows-1252'] },
      delimiter: { type: 'string', enum: ['comma', 'semicolon', 'tab'] },
    },
  } as const;

  return [
    ctxAction(
      'migration_discover_source',
      'read',
      'Classify uploaded source files for a Datenübernahme: per file the detected adapter, the data classes it can produce, a row count, a header sample, a confidence and the file\'s own as-of date (asAt) where the format carries one. Pass override to FORCE a format when auto-detection got it wrong: override.adapter pins a registered adapter id, override.encoding re-decodes (utf-8, latin1, windows-1252) and override.delimiter re-splits (comma, semicolon, tab). Reads blobs back through E00 and writes zero rows to any ledger.',
      ctxSchema({ fileIds: STR_LIST, planId: STR, override: DISCOVER_OVERRIDE }, ['fileIds']),
      (ctx, input) => discoverSource(ctx, as(input)),
    ),
    ctxAction(
      'migration_create_plan',
      'write',
      'Create a Datenübernahme plan for a source system as at an Übernahmestichtag. A FUTURE Stichtag is accepted: the plan is prepared ahead of its date (scope, map, trial load, check), the plan view carries cutoverPending, and only migration_commit_step and go_productive refuse cutover_in_future until the date arrives. The plan is a scoped, resumable, auditable object, not an import.',
      ctxSchema({ sourceSystem: STR, cutoverDate: STR, localePack: STR, idempotencyKey: STR }, ['sourceSystem', 'cutoverDate', 'idempotencyKey']),
      (ctx, input) => createPlan(ctx, as(input)),
    ),
    ctxAction(
      'migration_set_scope',
      'write',
      'Scope a plan per data class, one step per included class. Defaults come from discovery; a class outside first scope is returned in unavailable[] with its owning spec named, never silently absent. Excluding a class removes its step, so it can never import by accident.',
      ctxSchema({ planId: STR, classes: CLASSES, idempotencyKey: STR }, ['planId', 'classes', 'idempotencyKey']),
      (ctx, input) => setScope(ctx, as(input)),
    ),
    ctxAction(
      'migration_get_plan',
      'read',
      "Read a plan, every step with its state, the six-phase journey and nextAction, the resume answer and the plan surface's single primary action. Accepts a saved view (savedViewId) over the step list; an explicit dataClass/state filter wins over the stored one. Resume is a read and never a re-run of prior steps.",
      ctxSchema({ planId: STR, savedViewId: STR, dataClass: STR, state: STR }, ['planId']),
      (ctx, input) => getPlan(ctx, as(input)),
    ),
    ctxAction(
      'migration_list_plans',
      'read',
      'List this workspace\'s Datenübernahme plans, optionally by status. Accepts a saved view (savedViewId) over the roster; an explicit status wins over the stored one. Workspace-scoped like every other read: the cross-client Treuhänder roster composes N of these over A23\'s memberships and is NOT a read that reaches across the tenant fence.',
      ctxSchema({ status: STR, savedViewId: STR }),
      (ctx, input) => listPlans(ctx, as(input)),
    ),
    ctxAction(
      'migration_preview_step',
      'read',
      'Dry-run a step: classify every source row willCreate, willSkip (an exact match on the class match key) or willConflict (a match with differing fields), with a sample and any row errors. Writes NOTHING anywhere; an unresolved conflict blocks the commit.',
      ctxSchema({ planId: STR, stepId: STR }, ['planId', 'stepId']),
      (ctx, input) => previewStep(ctx, as(input)),
    ),
    ctxAction(
      'migration_trial_load_step',
      'write',
      'Trial-load a step into the plan\'s Testmandant (G12), through the same code path the live commit uses, differing only in target workspace. Records the row-level outcomes and writes nothing to the live books. Idempotent on its key.',
      ctxSchema({ planId: STR, stepId: STR, idempotencyKey: STR }, ['planId', 'stepId', 'idempotencyKey']),
      (ctx, input) => trialLoadStep(ctx, as(input)),
    ),
    ctxAction(
      'migration_commit_step',
      'write',
      'Commit a step into the live books, behind the six-condition gate (checked, no failed/not_asserted control, no unresolved conflict, an approval bound to the check hash for a money-path class, commit_migration held, and a G04 backup on record). A migrated document posts nothing: a money-path class establishes opening balances through A04\'s single entry. Idempotent: a double-commit posts once.',
      ctxSchema({ planId: STR, stepId: STR, idempotencyKey: STR }, ['planId', 'stepId', 'idempotencyKey']),
      (ctx, input) => commitStep(ctx, as(input)),
    ),
    ctxAction(
      'migration_record_approval',
      'write',
      'Bind a human approval to a check result: a row for exactly (stepId, checkHash). Every return of the step to the mapped state voids it, so an agent cannot commit the import after a human approved a different result.',
      ctxSchema({ planId: STR, stepId: STR, checkHash: STR, idempotencyKey: STR }, ['planId', 'stepId', 'checkHash', 'idempotencyKey']),
      (ctx, input) => recordApproval(ctx, as(input)),
    ),
    ctxAction(
      'migration_rollback_step',
      'write',
      'Reverse a committed step through A02 reversing entries and archive master rows through their owning verbs. Never a delete: posted entries are append-only. The step returns to the mapped state and the approval is voided. After any commit this verb requires commit_migration.',
      ctxSchema({ planId: STR, stepId: STR, confirmed: BOOL, idempotencyKey: STR }, ['planId', 'stepId', 'idempotencyKey']),
      (ctx, input) => rollbackStep(ctx, as(input)),
    ),
    ctxAction(
      'migration_readiness',
      'read',
      'Read the go-live checklist: every step with its state, the backup precondition, and for each open item the actor who must move it (du, ein Agent, das System). Ready means every included step is verified and no control is failed or not_asserted.',
      ctxSchema({ planId: STR }, ['planId']),
      (ctx, input) => readiness(ctx, as(input)),
    ),
    ctxAction(
      'migration_abandon_plan',
      'write',
      'Close a plan and discard its Testmandant. Belege for any step that reached live are retained (OR 958f), so abandoning never deletes the evidence of what was committed. After any commit this verb requires commit_migration.',
      ctxSchema({ planId: STR, confirmed: BOOL, idempotencyKey: STR }, ['planId', 'idempotencyKey']),
      (ctx, input) => abandonPlan(ctx, as(input)),
    ),
    ctxAction(
      'migration_close_plan',
      'write',
      'Close a finished Datenübernahme, moving it from live to closed (the state the machine declared but nothing could reach). Legal only from live; refuses, naming the first blocker, while any step is non-terminal or any G11 control is failed. A close is the human judgment that the übernahme is finished, so it needs a confirmation and is denylisted from automation. Idempotent; writes no domain row and posts nothing (it stamps the plan only).',
      ctxSchema({ planId: STR, confirmed: BOOL, idempotencyKey: STR }, ['planId', 'idempotencyKey']),
      (ctx, input) => closePlan(ctx, as(input)),
    ),
  ];
}
