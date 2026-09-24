/**
 * G03's four verbs, defined here and spread into `ACTIONS` as one line (the `fxActions` /
 * `workspaceActions` precedent), so several agents appending to the append-only registry at once
 * collide over a line rather than a block.
 *
 * Two shapes:
 *
 *  - `create_demo_workspace` is a `depsAction`, PRE-WORKSPACE by construction: it MINTS the tenant
 *    a capability would be resolved in (the `create_workspace` / `onboard_client` precedent), and
 *    seats its caller as owner the moment the tenant exists.
 *  - The other three are ordinary ctx verbs. `get_onboarding_progress` / `advance_onboarding_step`
 *    are the wizard's resume pointer, bookkeeping and never a gate; `discard_demo_workspace` is the
 *    demo's one exit, a hard delete structurally fenced to `kind='demo'`.
 *
 * G03 registers NO import verb: the whole import pipeline is the BUILT G09-G13 harness
 * (`migration_create_plan` through `go_productive`), and the Onboarding surface's import path is a
 * hand-over to `/migration`, never a second door (spec §2 US-G03.3, D86).
 *
 * As with `fx-actions.ts`, the helpers arrive as a parameter rather than an import, so the module
 * graph stays acyclic: `registry.ts` imports this file and this file must not import it back.
 */

import type { ActionDef, ActionInput, ApiDeps, JsonSchema } from './registry.js';
import type { WorkspaceContext } from '../core/context.js';
import type { Result } from '../core/result.js';
import {
  getOnboardingProgress,
  advanceOnboardingStep,
  createDemoWorkspace,
  discardDemoWorkspace,
} from '../core/onboarding/index.js';

export interface OnboardingActionHelpers {
  ctxAction(
    name: string,
    kind: 'read' | 'write',
    summary: string,
    inputSchema: JsonSchema,
    call: (ctx: WorkspaceContext, input: ActionInput) => Result,
  ): ActionDef;
  depsAction(
    name: string,
    kind: 'read' | 'write',
    summary: string,
    inputSchema: JsonSchema,
    call: (deps: ApiDeps, input: ActionInput) => Result,
  ): ActionDef;
  ctxSchema(props?: Record<string, unknown>, required?: string[]): JsonSchema;
  depsSchema(props: Record<string, unknown>, required: string[]): JsonSchema;
  STR: { readonly type: 'string' };
  BOOL: { readonly type: 'boolean' };
}

/** The registry's documented cast: the JSON input is handed to the verb as its typed input. */
function as<T>(input: ActionInput): T {
  return input as unknown as T;
}

/** The G03 verbs, in append order (the §5 table order). */
export function onboardingActions(h: OnboardingActionHelpers): readonly ActionDef[] {
  const { ctxAction, depsAction, ctxSchema, depsSchema, STR, BOOL } = h;

  return [
    ctxAction(
      'get_onboarding_progress',
      'read',
      'Read the first-run wizard resume point for this workspace ({path, step, completedAt} or null when the wizard never ran), plus the workspace kind (demo|sandbox|live) so a client can show the demo banner off the same call. Pure bookkeeping: nothing in the engine gates on this row.',
      ctxSchema(),
      (ctx) => getOnboardingProgress(ctx),
    ),
    ctxAction(
      'advance_onboarding_step',
      'write',
      'Persist the first-run wizard resume point: path (fresh|import|demo) and the current step, absolutely, so a closed tab reopens where it left off. Never a business-logic gate: every underlying setup verb keeps its own validation and idempotency, and an agent session skips this bookkeeping entirely (spec US-G03.5). completed:true stamps the wizard finished, once; a later call never un-completes it.',
      ctxSchema({ path: STR, step: STR, completed: BOOL }, ['path', 'step']),
      (ctx, input) => advanceOnboardingStep(ctx, as(input)),
    ),
    depsAction(
      'create_demo_workspace',
      'write',
      'Mint a disposable demo workspace (workspace.kind = demo) and seed it with sample Swiss books through the real verbs: chart auto-seed, MWST effektiv/Soll, three customers, three items, two issued invoices and one draft, every posting through issue_invoice, so the demo behaves identically to a real workspace. The caller is seated as owner. No MWST number or UID is fabricated; the creditor profile carries the SIX specimen QR-IBAN. A demo can never go productive: its only exit is discard_demo_workspace. Idempotent: retrying the same key returns the existing demo, never a second one.',
      depsSchema({ name: STR, idempotencyKey: STR }, ['idempotencyKey']),
      (deps, input) => createDemoWorkspace(deps, as(input)),
    ),
    // A depsAction ON PURPOSE, although it names a tenant: its success deletes that tenant, so the
    // shared boundary's workspace_not_found check would break the replay of a completed discard.
    // The verb re-states the boundary's own order in-engine (existence, the manage_settings gate
    // through the same capabilityPort, then the kind fence), see `core/onboarding/demo.ts`.
    depsAction(
      'discard_demo_workspace',
      'write',
      'Hard-delete a demo workspace and every row under it, because nothing in a demo is a real fiscal record. Refuses on any workspace whose kind is not demo (not_a_demo_workspace): a Testmandant discards through discard_testmandant, and a live workspace can only be archived (A23), never hard-deleted. Requires manage_settings on the demo and confirmed:true (needs_confirmation otherwise): the operator may have added their own experiments. A retry of the same key replays the stored result, even though the workspace itself is gone.',
      depsSchema({ workspaceId: STR, confirmed: BOOL, idempotencyKey: STR }, ['workspaceId', 'idempotencyKey']),
      (deps, input) => discardDemoWorkspace(deps, as(input)),
    ),
  ];
}
