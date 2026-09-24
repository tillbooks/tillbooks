/**
 * G01's ten verbs, defined here and spread into `ACTIONS` as one line (the `fxActions` precedent).
 *
 * Six writes and four reads. As with `fx-actions.ts`, `support-actions.ts`, `permission-actions.ts`
 * and `customization-actions.ts`, the helpers arrive as a parameter rather than an import, so the
 * module graph stays acyclic: `registry.ts` imports this file and this file must not import it back.
 *
 * TWO VERBS TAKE `deps` AS A THIRD ARGUMENT, and they are the only two in the product that do. A
 * G01 verb that FIRES an action needs the `ActionInvoker`, and an invoker can only be built from
 * `deps` (it has to hand the target verb a store, a clock, ids, and the rule author's actor). Rather
 * than thread an api concern through `WorkspaceContext`, where seventy-six unrelated verbs would then
 * carry it, `ctxAction`'s callback signature widened by one optional parameter that every existing
 * call site ignores.
 *
 * `run_due_automations` IS A WRITE AND ADVERTISES NO `readOnlyHint`, even though a tick with nothing
 * due writes nothing at all. It can invoke any action any rule names, so calling it read-only would
 * be a lie to every MCP client that decides on that flag whether to ask a human first.
 */

import type { ActionDef, ActionInput, ApiDeps, JsonSchema } from './registry.js';
import type { WorkspaceContext } from '../core/context.js';
import type { Result } from '../core/result.js';
import type { ActionInvoker } from '../core/automation/index.js';
import { assertActionInvokersAreGated } from '../core/access/index.js';
import {
  archiveAutomationRule,
  createAutomationRule,
  disableAutomationRule,
  enableAutomationRule,
  getAutomationRule,
  getAutomationRun,
  listAutomationRules,
  listAutomationRuns,
  retryAutomationRun,
  runDueAutomations,
  updateAutomationRule,
} from '../core/automation/index.js';

export interface AutomationActionHelpers {
  ctxAction(
    name: string,
    kind: 'read' | 'write',
    summary: string,
    inputSchema: JsonSchema,
    call: (ctx: WorkspaceContext, input: ActionInput, deps: ApiDeps) => Result,
  ): ActionDef;
  ctxSchema(props?: Record<string, unknown>, required?: string[]): JsonSchema;
  /** Builds the invoker that reaches the shared dispatch. Supplied by `registry.ts`, which owns it. */
  invokerFor(deps: ApiDeps): ActionInvoker;
  STR: { readonly type: 'string' };
  BOOL: { readonly type: 'boolean' };
  INT: { readonly type: 'integer' };
}

/** The G01 verbs, in append order. */
export function automationActions(h: AutomationActionHelpers): readonly ActionDef[] {
  const { ctxAction, ctxSchema, invokerFor, STR, BOOL, INT } = h;

  /**
   * THE ONLY WAY A VERB IN THIS FILE OBTAINS AN `ActionInvoker`, and the reason it is a helper rather
   * than an inline `invokerFor(deps)` at each site.
   *
   * A verb holding an invoker can cause any other verb to run as the rule's author, so its own gate
   * is the only thing between a caller and every capability every rule author holds. A24 refuses to
   * let such a verb be `ungated` (`assertActionInvokersAreGated`), but that rule is only as good as
   * the list of verbs it is told about, and a hand-kept list is a list that drifts the first time
   * somebody adds a third firing verb. Routing every one of them through here makes the list a
   * BYPRODUCT of construction: a verb cannot fire anything without appearing in `firingVerbs`.
   */
  const firingVerbs: string[] = [];
  const firingAction = (
    name: string,
    summary: string,
    inputSchema: JsonSchema,
    call: (ctx: WorkspaceContext, invoke: ActionInvoker, input: ActionInput) => Result,
  ): ActionDef => {
    firingVerbs.push(name);
    return ctxAction(name, 'write', summary, inputSchema, (ctx, input, deps) =>
      call(ctx, invokerFor(deps), input),
    );
  };
  const OBJ = { type: 'object' } as const;
  // A condition is `null` (meaning "always") or an object, and a schema that declared `object` would
  // make the boundary type check in `registry.ts` reject the null before the engine could read it as
  // the deliberate value it is. `validateCondition` is the single validator, exactly as `fields.ts`
  // is for a custom value: the schema catches shape, the engine catches meaning.
  const CONDITION = { anyOf: [{ type: 'object' }, { type: 'null' }] } as const;

  const actions: readonly ActionDef[] = [
    ctxAction(
      'create_automation_rule',
      'write',
      'Define an automation: when this event happens, and this condition holds, call this write verb with this input. The action must name a registered write verb, the trigger must name a registered event, and a rule whose action is the very verb that emits its own trigger is refused outright. A rule created by the agent actor lands DISABLED and a human must enable it.',
      ctxSchema(
        {
          name: STR,
          trigger: OBJ,
          condition: CONDITION,
          action: OBJ,
          enabled: BOOL,
          idempotencyKey: STR,
        },
        ['name', 'trigger', 'action'],
      ),
      (ctx, input) => createAutomationRule(ctx, input as unknown as Parameters<typeof createAutomationRule>[1]),
    ),
    ctxAction(
      'update_automation_rule',
      'write',
      'Patch a rule: its name, trigger, condition or action. The patched shape is validated exactly as a new rule is, so an edit can never leave a rule the engine would have refused to create. The change takes effect on the next event; an archived rule refuses.',
      ctxSchema({ ruleId: STR, patch: OBJ, idempotencyKey: STR }, ['ruleId', 'patch']),
      (ctx, input) => updateAutomationRule(ctx, input as unknown as Parameters<typeof updateAutomationRule>[1]),
    ),
    ctxAction(
      'enable_automation_rule',
      'write',
      'Let a rule fire again. Requires manage_automations, which is the asymmetry that makes disabling safe to leave open: anyone may stop a rule, only an administrator may start one. An archived rule refuses.',
      ctxSchema({ ruleId: STR }, ['ruleId']),
      (ctx, input) => enableAutomationRule(ctx, input as unknown as { ruleId: string }),
    ),
    ctxAction(
      'disable_automation_rule',
      'write',
      'Stop a rule firing, immediately. Deliberately requires NO capability at all: a stop button that needs a permission is not a stop button, and disabling only ever prevents a write, never causes one.',
      ctxSchema({ ruleId: STR }, ['ruleId']),
      (ctx, input) => disableAutomationRule(ctx, input as unknown as { ruleId: string }),
    ),
    ctxAction(
      'archive_automation_rule',
      'write',
      'Retire a rule: it stops matching, disappears from the default list, and stops being enable-able. Never a delete, and its run history is untouched, because a firing that happened stays true after the rule that caused it is gone.',
      ctxSchema({ ruleId: STR }, ['ruleId']),
      (ctx, input) => archiveAutomationRule(ctx, input as unknown as { ruleId: string }),
    ),
    firingAction(
      'run_due_automations',
      'The tick for schedule triggers: fire every enabled rule whose cadence has come due at asOf, at most ONCE each however far behind it had fallen. Requires manage_automations, because the tick is what makes a schedule rule write unattended. asOf may name a past instant but never a future one: the injected clock decides what is due, not the caller. Safe to call as often as you like: a repeated tick for the same asOf computes the same occurrence key and does nothing.',
      ctxSchema({ asOf: STR }),
      (ctx, invoke, input) => runDueAutomations(ctx, invoke, input as unknown as { asOf?: string }),
    ),
    firingAction(
      'retry_automation_run',
      'Finish a run that is stuck in `running`, which is what a process death between the claim and the settle leaves behind. Re-sends the SAME stored input, including the derived idempotency key, so a lost invocation that had in fact committed cannot happen twice. Runs as the actor the firing ran as, so a since-demoted author is refused now exactly as it would be on a fresh firing. Requires manage_automations. A settled run refuses with run_not_stuck.',
      ctxSchema({ runId: STR, idempotencyKey: STR }, ['runId']),
      (ctx, invoke, input) =>
        retryAutomationRun(ctx, invoke, input as unknown as { runId: string; idempotencyKey?: string }),
    ),
    ctxAction(
      'list_automation_rules',
      'read',
      'List this workspace automation rules, newest first, archived ones excluded unless asked for. Also returns the CATALOGUE a rule can be built from: every registered trigger event, every write verb that is a legal action, and every condition operator, all read off the live registries so a picker cannot offer something the engine would refuse. savedViewId applies a saved view (G00): its stored filters are merged underneath any filter named explicitly here.',
      ctxSchema({ event: STR, enabled: BOOL, includeArchived: BOOL, savedViewId: STR }),
      (ctx, input) =>
        listAutomationRules(
          ctx,
          input as unknown as {
            event?: string;
            enabled?: boolean;
            includeArchived?: boolean;
            savedViewId?: string;
          },
        ),
    ),
    ctxAction(
      'get_automation_rule',
      'read',
      'Read one automation rule: its trigger, its condition, the verb it calls and the input template it calls it with, who authored it (and therefore whose capabilities its firings carry), and when it last fired.',
      ctxSchema({ ruleId: STR }, ['ruleId']),
      (ctx, input) => getAutomationRule(ctx, input as unknown as { ruleId: string }),
    ),
    ctxAction(
      'list_automation_runs',
      'read',
      "The run log, newest first: what fired, when, why, what it actually sent, and what came back. A failed run carries the target verb's own rejection code verbatim, so the reason reads the same way it would on that verb's own screen.",
      ctxSchema({ ruleId: STR, status: STR, limit: INT }),
      (ctx, input) =>
        listAutomationRuns(ctx, input as unknown as { ruleId?: string; status?: string; limit?: number }),
    ),
    ctxAction(
      'get_automation_run',
      'read',
      'Read one firing in full, including the resolved action input that was really sent rather than the template it came from.',
      ctxSchema({ runId: STR }, ['runId']),
      (ctx, input) => getAutomationRun(ctx, input as unknown as { runId: string }),
    ),
  ];

  // The load-time handshake: A24 owns the RULE that an invoking verb may never be exempt, this file
  // supplies the FACT of which verbs invoke. Runs before the actions escape, so a firing verb left
  // ungated is a crash on import rather than an open door nobody audits.
  assertActionInvokersAreGated(firingVerbs);
  return actions;
}
