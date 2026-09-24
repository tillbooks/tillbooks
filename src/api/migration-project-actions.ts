/**
 * G20's eleven verbs, defined here and spread into `ACTIONS` as one line (the
 * `migrationExtractionActions` precedent), so several agents appending to the append-only registry at
 * once collide over a line rather than a block.
 *
 * VERB NAMES RECONCILED (spec §5 named the bare `project_*` set): B00 already registers
 * `project_create`, `project_get` and `project_list` for its BILLING projects, and the registry
 * demands unique names (conformance rule 1). G20 is a different object (governance, not billing), so
 * its verbs carry the `implementation_` prefix. The spec's §5 REST routes move with them. This is the
 * reconciliation the loop asks a capability agent to make against the current engine.
 *
 * ALL ELEVEN ARE ctx verbs (every one takes `workspaceId`, §H-TENANT). Eight writes gate on
 * `manage_implementation`; `implementation_signoff_record` rides the existing `commit_migration`
 * (signing is the human half of committing). The two reads beyond the roster gate on
 * `manage_implementation`; `implementation_project_list` (the roster metadata read) gates on the
 * softer `read_master_data`, so a mandate member can compose the roster and a caller lacking
 * `manage_implementation` gets a metadata row rather than a blank (US-G20.4). The gate rows live in
 * `actionCapabilities.ts`.
 *
 * As with `migration-extraction-actions.ts`, the helpers arrive as a parameter rather than an import,
 * so the module graph stays acyclic: `registry.ts` imports this file and this file must not import it
 * back.
 */

import type { ActionDef, ActionInput, JsonSchema } from './registry.js';
import type { WorkspaceContext } from '../core/context.js';
import type { Result } from '../core/result.js';
import {
  projectCreate,
  projectGet,
  projectList,
  projectInstantiateRunbook,
  projectSetTask,
  projectRecordDecision,
  projectRecordSignoff,
  declareParallelFigures,
  runParallelCheckVerb,
  getParallelStatus,
  projectClose,
} from '../core/migration/index.js';

export interface MigrationProjectActionHelpers {
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

/** The G20 verbs, in append order (the §5 table order). */
export function migrationProjectActions(h: MigrationProjectActionHelpers): readonly ActionDef[] {
  const { ctxAction, ctxSchema, STR } = h;
  const BOOL = { type: 'boolean' } as const;
  const INT = { type: 'integer' } as const;
  const FIGURE = {
    type: 'object',
    properties: { kind: STR, ref: STR, declaredRappen: INT },
    required: ['kind', 'ref', 'declaredRappen'],
  } as const;
  const FIGURE_LIST = { type: 'array', items: FIGURE } as const;
  const TASK_FIELDS = {
    type: 'object',
    properties: {
      phase: STR, title: STR, ownerKind: STR, ownerRef: STR, due: STR, status: STR,
      evidenceKind: STR, evidenceRef: STR, contingency: STR, reason: STR,
    },
  } as const;

  return [
    ctxAction(
      'implementation_project_create',
      'write',
      'Create the implementation project for this workspace: the cutover as a first-class object above the migration plan(s). Takes the source system, the target cutover date (the fixed anchor every reconciliation figure is declared against), an optional freeze window, the MWST method (effektiv | saldo) and methodChange:true when the cutover is combined with a method change (which then needs an mwst_method sign-off before any parallel figure). Refuses a cutover date in the past (cutover_in_past), an inverted freeze window, and a second open project on the workspace (project_already_open). Gates on manage_implementation.',
      ctxSchema(
        { sourceSystem: STR, cutoverDate: STR, freezeStart: STR, freezeEnd: STR, mwstMethod: STR, methodChange: BOOL, idempotencyKey: STR },
        ['sourceSystem', 'cutoverDate', 'mwstMethod', 'idempotencyKey'],
      ),
      (ctx, input) => projectCreate(ctx, as(input)),
    ),
    ctxAction(
      'implementation_project_get',
      'read',
      'Read the implementation project end to end: the evidence-derived phase (discovery -> extraction -> mapping -> rehearsal -> cutover -> parallel_run -> live -> closed; live is the Stabilisierung), the one next action, the blocked-first task list, the sign-off (Freigabe) rows, the decision log, the parallel-run status, and the load-bearing computed statuses tieout.passed / parallel.passed, each true ONLY when the deterministic checks are clean AND the bound human sign-off stands. Gates on manage_implementation.',
      ctxSchema({ projectId: STR, savedViewId: STR }, ['projectId']),
      (ctx, input) => projectGet(ctx, as(input)),
    ),
    ctxAction(
      'implementation_project_list',
      'read',
      'List this workspace’s implementation projects as roster metadata (phase, first blocker + owner kind, days to cutover), blocked-first then by cutover proximity. Workspace-scoped: the cross-client roster composes N of these over A23 list_workspaces client-side. §H-TENANT: never reads across workspaces. Gates on read_master_data so a mandate member can compose the roster.',
      ctxSchema({ status: STR, savedViewId: STR }, []),
      (ctx, input) => projectList(ctx, as(input)),
    ),
    ctxAction(
      'implementation_runbook_instantiate',
      'write',
      'Instantiate a shipped runbook template into owned, dated, evidenced tasks: each task carries an owner kind (human|agent|system), a due date offset from the cutover date, a prerequisite, the evidence it requires and a contingency. The go/no-go and rollback tasks are undeletable (only not_applicable with a reason). The 180-day Umsatzabstimmung, the 240-day Berichtigung (Art. 72 MWSTG) and the prior-year Umsatzabstimmung land with computed statutory dates. Gates on manage_implementation.',
      ctxSchema({ projectId: STR, templateId: STR, idempotencyKey: STR }, ['projectId', 'templateId', 'idempotencyKey']),
      (ctx, input) => projectInstantiateRunbook(ctx, as(input)),
    ),
    ctxAction(
      'implementation_task_set',
      'write',
      'Create or update one implementation task (pass taskId to update). fields carries phase, title, ownerKind, ownerRef, due, status, evidenceKind, evidenceRef, contingency and reason. Completing a task whose prerequisite is still open refuses (prerequisite_open, naming it); completing one that requires evidence without it refuses (evidence_required, naming the kind); marking a task not_applicable needs a recorded reason (not_applicable_needs_reason). Gates on manage_implementation.',
      ctxSchema({ projectId: STR, taskId: STR, fields: TASK_FIELDS, idempotencyKey: STR }, ['projectId', 'idempotencyKey']),
      (ctx, input) => projectSetTask(ctx, as(input)),
    ),
    ctxAction(
      'implementation_decision_record',
      'write',
      'Record one decision in the append-only implementation decision log (OR 957a Nachprüfbarkeit applied to the implementation itself): title, context and the decision. There is no update path. Gates on manage_implementation.',
      ctxSchema({ projectId: STR, title: STR, context: STR, decision: STR, idempotencyKey: STR }, ['projectId', 'title', 'decision', 'idempotencyKey']),
      (ctx, input) => projectRecordDecision(ctx, as(input)),
    ),
    ctxAction(
      'implementation_signoff_record',
      'write',
      'Record one human sign-off (append-only). kind is the FIXED enum: conversion_date, mwst_method, mapping_approval, tieout, contact_merge, go_nogo, rollback_trigger, parallel_run_close, source_cancellation. EVERY kind is a human act: an agent (or the system seat) is REFUSED (signoff_needs_human), never staged (P8). The tieout and parallel_run_close kinds bind the current reconciliation evidence hash, so a later check that changes the evidence voids the sign-off. Gates on commit_migration (signing is the human half of committing).',
      ctxSchema({ projectId: STR, kind: STR, evidenceRef: STR, idempotencyKey: STR }, ['projectId', 'kind', 'evidenceRef', 'idempotencyKey']),
      (ctx, input) => projectRecordSignoff(ctx, as(input)),
    ),
    ctxAction(
      'implementation_parallel_declare',
      'write',
      'Declare the prior system’s figures for one filing period (entered exactly like G11 control totals: declared, hashed, never edited in place; a correction is a new declaration superseding the old, both retained). figures is an array of { kind (trial_balance|vat_return|open_items_ar|open_items_ap), ref, declaredRappen (integer) }. The period must align to the method boundary (effektiv quarter YYYY-Qn, saldo semester YYYY-Hn) or refuses (period_outside_window). A cutover combined with a method change refuses without a recorded mwst_method sign-off (method_change_needs_signoff). Gates on manage_implementation.',
      ctxSchema({ projectId: STR, period: STR, figures: FIGURE_LIST, idempotencyKey: STR }, ['projectId', 'period', 'figures', 'idempotencyKey']),
      (ctx, input) => declareParallelFigures(ctx, as(input)),
    ),
    ctxAction(
      'implementation_parallel_check',
      'write',
      'Compute TILL’s own figures for a period from the OWNING read models (A08 trial balance, A07 return per Ziffer, A16/A17 open items) and compare, per figure, to the declared figures: { kind, ref, declaredRappen, computedRappen, differenceRappen, status }. ZERO tolerance, no dial: a 0-Rappen difference passes, ANY nonzero fails. A figure with no declaration is not_asserted, never green. Re-running with changed evidence voids any bound tieout / parallel_run_close sign-off. Gates on manage_implementation.',
      ctxSchema({ projectId: STR, period: STR, idempotencyKey: STR }, ['projectId', 'period', 'idempotencyKey']),
      (ctx, input) => runParallelCheckVerb(ctx, as(input)),
    ),
    ctxAction(
      'implementation_parallel_status',
      'read',
      'Read the parallel-run status: per declared period the latest check’s roll-up (passed | failed | not_asserted) and an overall status that is never green while a declaration or a passing check is missing (G11 three-status honesty). Gates on manage_implementation.',
      ctxSchema({ projectId: STR }, ['projectId']),
      (ctx, input) => getParallelStatus(ctx, as(input)),
    ),
    ctxAction(
      'implementation_project_close',
      'write',
      'Close the implementation project (confirm-gated). Legal only from the live (Stabilisierung) phase, with the Stabilisierung and parallel-run tasks terminal, and the parallel_run_close and source_cancellation sign-offs recorded (or their canon tasks not_applicable with a reason). Each open leg refuses in isolation, naming what is open. Denylisted from automation (a rule engine must not close). Gates on manage_implementation.',
      ctxSchema({ projectId: STR, confirmed: BOOL, idempotencyKey: STR }, ['projectId', 'confirmed', 'idempotencyKey']),
      (ctx, input) => projectClose(ctx, as(input)),
    ),
  ];
}
