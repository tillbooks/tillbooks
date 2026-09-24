/**
 * B00's projects verbs, defined here and spread into `ACTIONS` as one line (the `fxActions` /
 * `contactActions` precedent), so several agents appending to the append-only registry at once
 * collide over a line rather than a block.
 *
 * Seven writes (create, update, set_status, delete, phase_add, phase_update, phase_done) and three
 * reads (list, get, budget_actual). Every write carries `workspaceId` + an idempotency key and gates
 * on A24 `manage_master_data` (a project is master data; the spec's `project.manage` has no A24
 * name, see the spec's §0); reads gate on `read_master_data`. B00 POSTS NOTHING: the one money-ish
 * read (`project_budget_actual`) is a pure P5 query whose actual side is drawn from the registered
 * cost sources, all of which are read-only by contract.
 *
 * As with `fx-actions.ts` and `contact-actions.ts`, the helpers arrive as a parameter rather than an
 * import, so the module graph stays acyclic: `registry.ts` imports this file and this file must not
 * import it back.
 */

import type { ActionDef, ActionInput, JsonSchema } from './registry.js';
import type { WorkspaceContext } from '../core/context.js';
import type { Result } from '../core/result.js';
import {
  createProject,
  updateProject,
  setProjectStatus,
  deleteProject,
  listProjects,
  getProject,
  addPhase,
  updatePhase,
  phaseDone,
  projectBudgetActual,
} from '../core/projects/index.js';

export interface ProjectActionHelpers {
  ctxAction(
    name: string,
    kind: 'read' | 'write',
    summary: string,
    inputSchema: JsonSchema,
    call: (ctx: WorkspaceContext, input: ActionInput) => Result,
  ): ActionDef;
  ctxSchema(props?: Record<string, unknown>, required?: string[]): JsonSchema;
  STR: { readonly type: 'string' };
  INT: { readonly type: 'integer' };
  BOOL: { readonly type: 'boolean' };
}

/** Widen an `ActionInput` to the engine's own input shape (the same cast `registry.ts` uses). */
function as<T>(input: ActionInput): T {
  return input as unknown as T;
}

/** The B00 verbs, in append order. */
export function projectActions(h: ProjectActionHelpers): readonly ActionDef[] {
  const { ctxAction, ctxSchema, STR, INT, BOOL } = h;
  const OBJ = { type: 'object' } as const;

  return [
    ctxAction(
      'project_create',
      'write',
      'Lege ein Projekt an (create a project master): name, client contact (C00), an editable auto-suggested code (P-0001 upward, unique per workspace), an integer-Rappen budget with budget hours, dates and an optional parent for a sub-project tree. A non-base currency snapshots the base-Rappen budget at the H-FX rate of the creation day (pass fxRate to assert one). Starts in status draft.',
      ctxSchema(
        {
          name: STR,
          contactId: STR,
          code: STR,
          currency: STR,
          budgetMinor: INT,
          budgetHours: INT,
          startsOn: STR,
          endsOn: STR,
          parentId: STR,
          fxRate: STR,
          idempotencyKey: STR,
        },
        ['name', 'contactId'],
      ),
      (ctx, input) => createProject(ctx, as(input)),
    ),
    ctxAction(
      'project_update',
      'write',
      'Patch a project master (name, contact, code, dates, parent, budget). Editable while draft, active or on_hold; a closed project refuses with project_closed. The H-FX base snapshot is re-taken only when currency or budgetMinor change, never silently re-rated.',
      ctxSchema({ projectId: STR, patch: OBJ, idempotencyKey: STR }, ['projectId', 'patch']),
      (ctx, input) => updateProject(ctx, as(input)),
    ),
    ctxAction(
      'project_set_status',
      'write',
      'Move a project through its lifecycle: draft to active, active to on_hold and back (Pausieren), active or on_hold to closed (Abschliessen), and the audit-logged reopen closed to active (Wieder öffnen). An illegal pair refuses with invalid_transition; closing runs the registered close guards (B01 adds the open-time guard when it lands).',
      ctxSchema({ projectId: STR, status: STR, idempotencyKey: STR }, ['projectId', 'status']),
      (ctx, input) => setProjectStatus(ctx, as(input)),
    ),
    ctxAction(
      'project_delete',
      'write',
      'Hard-delete a DRAFT project that nothing references (no sub-project, no custom-field value, no linked file); its own draft phases go with it. Anything past draft has history and refuses with not_draft: real projects are closed, never erased (OR 957a spirit).',
      ctxSchema({ projectId: STR, idempotencyKey: STR }, ['projectId']),
      (ctx, input) => deleteProject(ctx, as(input)),
    ),
    ctxAction(
      'project_phase_add',
      'write',
      'Add a phase to a project (name, sort, integer-Rappen budget, budget hours, optional milestoneOn date). Refused on a closed project. A phase-budget sum exceeding the project budget answers ok with a phase_budgets_exceed_project warning, never a block: phase budgets are the plan, the project budget is the envelope.',
      ctxSchema(
        { projectId: STR, name: STR, sort: INT, budgetMinor: INT, budgetHours: INT, milestoneOn: STR, idempotencyKey: STR },
        ['projectId', 'name'],
      ),
      (ctx, input) => addPhase(ctx, as(input)),
    ),
    ctxAction(
      'project_phase_update',
      'write',
      'Patch a phase (name, sort, budget, budget hours, milestoneOn). Refused on a closed project; carries the same phase-budget warning as project_phase_add.',
      ctxSchema({ phaseId: STR, patch: OBJ, idempotencyKey: STR }, ['phaseId', 'patch']),
      (ctx, input) => updatePhase(ctx, as(input)),
    ),
    ctxAction(
      'project_phase_done',
      'write',
      'Mark a phase milestone reached (Erledigt): stamps doneAt (default today). A state assertion, so an already-done phase answers ok with alreadyDone true and the recorded date untouched, never a second stamp.',
      ctxSchema({ phaseId: STR, doneAt: STR, idempotencyKey: STR }, ['phaseId']),
      (ctx, input) => phaseDone(ctx, as(input)),
    ),
    ctxAction(
      'project_list',
      'read',
      'List the projects with code, status, budget and parent, filtered by status, contact, parent or a text query over code and name. savedViewId applies a saved view (G00): its stored filters are merged underneath any filter named explicitly here.',
      ctxSchema({ status: STR, contactId: STR, parentId: STR, query: STR, savedViewId: STR }),
      (ctx, input) => listProjects(ctx, as(input)),
    ),
    ctxAction(
      'project_get',
      'read',
      'Read one project in full, its phases embedded in sort order. phaseDone filters the phases to done (true) or open (false); savedViewId applies a saved view over the phase list (G00): its stored filters are merged underneath any filter named explicitly here.',
      ctxSchema({ projectId: STR, phaseDone: BOOL, savedViewId: STR }, ['projectId']),
      (ctx, input) => getProject(ctx, as(input)),
    ),
    ctxAction(
      'project_budget_actual',
      'read',
      'Budget vs. Ist for one project, per project and per phase: budget, actual cost and hours, remaining, and the over-budget flag. COST ONLY, a pure read (P5) over the registered cost sources (B01 time, A17 bills, D02 purchases as they land; all zero until then): no revenue, no margin (that is B03), and nothing is ever written. includeSubprojects adds the base-currency rollup over the parent tree.',
      ctxSchema({ projectId: STR, includeSubprojects: BOOL, asOf: STR }, ['projectId']),
      (ctx, input) => projectBudgetActual(ctx, as(input)),
    ),
  ];
}
