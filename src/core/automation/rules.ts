/**
 * G01 rule management: define, edit, enable, disable, archive, read.
 *
 * EVERYTHING IS VALIDATED AT SAVE TIME. The event against the registry, the action against the
 * registry's write set, the condition's shape, and the self-triggering loop. A rule that only reveals
 * it is malformed at 03:00, when its trigger finally happens, is a rule whose error message nobody
 * reads, and on this engine the alternative to an error message is a `failed` row somebody finds a
 * week later.
 *
 * A RULE WRITTEN BY THE `agent` ACTOR LANDS DISABLED, and that is G01's whole P8 answer. The authored
 * spec had a fired action forced to land as a "draft", coupled to an approval dial that does not exist
 * in this tree. Forcing seventy-six verbs to half-execute would BE the second business-logic path
 * Pattern P3 forbids: there is no generic way to make `post_entry` into a draft that is not simply
 * calling `save_draft` instead, which is a different verb with different meaning. So the DRAFT IS THE
 * RULE. An agent may compose an automation from an instruction and a human must enable it, which is
 * exactly G00's `confirm_field` shape, using a mechanism that already exists, and it puts the human
 * gate before ANY firing rather than trying to soften each one.
 *
 * DISABLE IS THE ONE CONTROL THAT IS NOT GATED, and the reasoning lives in `actionCapabilities.ts`
 * where the exemption is declared. In short: a stop button that requires a permission is not a stop
 * button, disabling only ever prevents writes, and the asymmetry (anyone may stop, only
 * `manage_automations` may start) means the low-privilege direction is always the safe one.
 */

import type { Capability } from '../access/capabilities.js';
import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import {
  AUTOMATION_EVENTS,
  AUTOMATION_EVENT_IDS,
  automationActionsConfigured,
  automationEventDef,
  isRegisteredWriteAction,
  isScheduleEvent,
  registeredWriteActions,
} from './events.js';
import { CONDITION_OPS, validateCondition } from './condition.js';
import { isSelfTriggering } from './fire.js';
import { withheldCapability } from './disclosure.js';
import { applySavedView } from '../customization/views.js';

export const MAX_RULE_NAME_LENGTH = 120;
export const MAX_RULE_JSON_BYTES = 16384;

/**
 * The denylist lives in ./denylist.ts since the F5 remediation (F5-C1): this module imports it for
 * the SAVE-time check and the catalogue filter, fire.ts imports it for the FIRE-time and retry
 * checks, and store/migrations.ts imports it to disable stored rules that predate an entry. It is
 * re-exported here so existing consumers keep their import path.
 */
import { isNotAutomatable, notAutomatableInput } from './denylist.js';

export { NOT_AUTOMATABLE, isNotAutomatable } from './denylist.js';

interface StoredRule {
  id: string;
  workspace_id: string;
  name: string;
  trigger_event: string;
  condition: string;
  action_tool: string;
  action_input: string;
  enabled: number;
  archived: number;
  created_by: string;
  last_fired_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface AutomationRuleView {
  ruleId: string;
  name: string;
  trigger: { event: string; entityKind: string | null; schedule: boolean };
  condition: unknown;
  /** Null when the caller could not have made this call itself. See `withheld` and `disclosure.ts`. */
  action: { tool: string; inputTemplate: Record<string, unknown> | null };
  /** The capability that would have been needed to see the template, or null when nothing was held back. */
  withheld: Capability | null;
  enabled: boolean;
  archived: boolean;
  createdBy: string;
  lastFiredAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * THE SAME PER-ROW DISCLOSURE GATE THE RUN LOG APPLIES, and the reason it must be here too.
 *
 * The critic measured the leak on `get_automation_run`, but the run carries the RESOLVED template and
 * the rule carries the CONFIGURED one, and for the rule that produced the measurement they held the
 * identical string: a viewer denied `read_members` read `geheim.treuhaender@kanzlei.ch` out of
 * `get_automation_rule` just as readily. Closing only the run log would have closed a door and left
 * the window open one verb over, which is the shape of remediation this repo has been bitten by.
 */
function mapRule(ctx: WorkspaceContext, row: StoredRule): AutomationRuleView {
  const def = automationEventDef(row.trigger_event);
  let template: Record<string, unknown> = {};
  let parsed = true;
  try {
    template = JSON.parse(row.action_input) as Record<string, unknown>;
  } catch {
    parsed = false;
  }
  const withheld = withheldCapability(ctx, row.action_tool, template);
  return {
    ruleId: row.id,
    name: row.name,
    trigger: {
      event: row.trigger_event,
      entityKind: def?.entityKind ?? null,
      schedule: isScheduleEvent(row.trigger_event),
    },
    condition: JSON.parse(row.condition) as unknown,
    action: {
      tool: row.action_tool,
      inputTemplate: withheld === undefined && parsed ? template : null,
    },
    withheld: withheld ?? null,
    enabled: row.enabled === 1,
    archived: row.archived === 1,
    createdBy: row.created_by,
    lastFiredAt: row.last_fired_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function readRule(ctx: WorkspaceContext, ruleId: string): StoredRule | undefined {
  return ctx.store.db
    .prepare('SELECT * FROM automation_rule WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, ruleId) as StoredRule | undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Everything a rule's shape has to satisfy, in one place so create and update cannot drift apart.
 *
 * The order matters: the "is there an action registry at all" question comes first, because every
 * answer below it would otherwise be a confident statement made with no information.
 */
function shapeProblem(parts: {
  name?: unknown;
  event?: unknown;
  condition?: unknown;
  tool?: unknown;
  inputTemplate?: unknown;
}): Result | undefined {
  if (!automationActionsConfigured()) {
    return err('automation_unavailable', {
      reason: 'No action registry is wired into this process, so no action tool can be validated.',
    });
  }
  // THE PRESENCE TEST IS `in`, NOT `!== undefined`, and the difference is a defect the conformance
  // gate found rather than a style choice. A create passes every key with whatever the caller sent, a
  // patch passes only the keys it is changing, and `!== undefined` collapsed those two into one: a
  // create with no `name` at all was read as "not patching the name", passed validation untouched,
  // and threw on `.trim()` deep inside the INSERT. `in` makes an absent key mean absent and a present
  // undefined mean invalid, which is what each caller actually means.
  if ('name' in parts) {
    if (typeof parts.name !== 'string' || parts.name.trim().length === 0) {
      return err('invalid_name', {});
    }
    if (parts.name.length > MAX_RULE_NAME_LENGTH) {
      return err('name_too_long', { max: MAX_RULE_NAME_LENGTH });
    }
  }
  if ('event' in parts && automationEventDef(parts.event) === undefined) {
    return err('unknown_event', { event: parts.event ?? null, known: [...AUTOMATION_EVENT_IDS] });
  }
  if ('tool' in parts) {
    if (typeof parts.tool !== 'string' || parts.tool.length === 0) {
      return err('unknown_action_tool', { tool: parts.tool });
    }
    // A read verb named as an action is its own rejection code, because it is a different mistake
    // from naming a verb that does not exist and the editor says the two differently.
    if (!isRegisteredWriteAction(parts.tool)) {
      return err('action_not_writable', { tool: parts.tool });
    }
    // Its own code, because it is a different mistake again: the verb exists, it is a write, and it is
    // still not something a rule may fire. Rejected at DEFINITION time (C00 §7), so the rule never
    // reaches the run log and there is nothing to disable after the fact.
    if (isNotAutomatable(parts.tool)) {
      return err('action_not_automatable', {
        tool: parts.tool,
        reason: 'irreversible_or_compliance_sensitive',
      });
    }
    // G22 leg 2 (spec §10.8): the denylist keyed on the INPUT, refused at definition time like the
    // verb-level one. Both callers hand in the MERGED template, so a patch cannot smuggle it in.
    if ('inputTemplate' in parts) {
      const denied = notAutomatableInput(parts.tool, parts.inputTemplate);
      if (denied !== undefined) {
        return err('template_not_automatable', { tool: parts.tool, field: denied.field, value: denied.value, reason: 'started_deliberately' });
      }
    }
  }
  if ('inputTemplate' in parts && !isPlainObject(parts.inputTemplate)) {
    return err('invalid_action_input', {});
  }
  const badCondition = validateCondition(parts.condition);
  if (badCondition !== undefined) return badCondition;
  if (parts.inputTemplate !== undefined) {
    const json = JSON.stringify(parts.inputTemplate);
    if (json.length > MAX_RULE_JSON_BYTES) {
      return err('action_input_too_large', { max: MAX_RULE_JSON_BYTES });
    }
  }
  return undefined;
}

export interface CreateRuleInput {
  name: string;
  trigger: { event: string };
  condition?: unknown;
  action: { tool: string; inputTemplate?: Record<string, unknown> };
  enabled?: boolean;
  idempotencyKey?: string;
}

export function createAutomationRule(ctx: WorkspaceContext, input: CreateRuleInput): Result {
  const run = (): Result => {
    const trigger: Record<string, unknown> = isPlainObject(input.trigger) ? input.trigger : {};
    const action: Record<string, unknown> = isPlainObject(input.action) ? input.action : {};
    const template = (action.inputTemplate as Record<string, unknown> | undefined) ?? {};
    const problem = shapeProblem({
      name: input.name,
      event: trigger.event,
      condition: input.condition ?? null,
      tool: action.tool,
      inputTemplate: template,
    });
    if (problem !== undefined) return problem;

    const event = trigger.event as string;
    const tool = action.tool as string;
    if (isSelfTriggering(event, tool)) {
      return err('self_triggering', { event, tool });
    }

    // P8: an agent may compose the rule, a human decides it may run. Passing `enabled: true` from the
    // agent actor does NOT override this, which is the point: a safety default a caller can turn off
    // by asking is not a safety default.
    const humanAuthored = ctx.actor !== 'agent';
    const enabled = humanAuthored && input.enabled !== false;

    const now = ctx.clock.now();
    const ruleId = ctx.ids.next('arule');
    ctx.store.db
      .prepare(
        `INSERT INTO automation_rule
           (id, workspace_id, name, trigger_event, condition, action_tool, action_input,
            enabled, archived, created_by, last_fired_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, NULL, ?, ?)`,
      )
      .run(
        ruleId,
        ctx.workspaceId,
        input.name.trim(),
        event,
        JSON.stringify(input.condition ?? null),
        tool,
        JSON.stringify(template),
        enabled ? 1 : 0,
        ctx.actor,
        now,
        now,
      );
    return ok({ rule: mapRule(ctx, readRule(ctx, ruleId) as StoredRule) });
  };

  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'create_automation_rule', run);
  }
  return run();
}

export interface UpdateRuleInput {
  ruleId: string;
  patch: Record<string, unknown>;
  idempotencyKey?: string;
}

export function updateAutomationRule(ctx: WorkspaceContext, input: UpdateRuleInput): Result {
  const run = (): Result => {
    const row = readRule(ctx, input.ruleId);
    if (row === undefined) return err('not_found', { ruleId: input.ruleId });
    if (row.archived === 1) return err('rule_archived', { ruleId: input.ruleId });
    if (!isPlainObject(input.patch)) return err('invalid_input', { field: 'patch' });

    const patch = input.patch;
    const trigger = isPlainObject(patch.trigger) ? patch.trigger : undefined;
    const action = isPlainObject(patch.action) ? patch.action : undefined;

    const nextEvent = (trigger?.event as string | undefined) ?? row.trigger_event;
    const nextTool = (action?.tool as string | undefined) ?? row.action_tool;
    const nextTemplate =
      action?.inputTemplate !== undefined
        ? (action.inputTemplate as Record<string, unknown>)
        : (JSON.parse(row.action_input) as Record<string, unknown>);
    const nextCondition =
      'condition' in patch ? patch.condition : (JSON.parse(row.condition) as unknown);

    const problem = shapeProblem({
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      event: nextEvent,
      condition: nextCondition,
      tool: nextTool,
      inputTemplate: nextTemplate,
    });
    if (problem !== undefined) return problem;
    if (isSelfTriggering(nextEvent, nextTool)) {
      return err('self_triggering', { event: nextEvent, tool: nextTool });
    }

    ctx.store.db
      .prepare(
        `UPDATE automation_rule
            SET name = ?, trigger_event = ?, condition = ?, action_tool = ?, action_input = ?, updated_at = ?
          WHERE workspace_id = ? AND id = ?`,
      )
      .run(
        typeof patch.name === 'string' ? patch.name.trim() : row.name,
        nextEvent,
        JSON.stringify(nextCondition ?? null),
        nextTool,
        JSON.stringify(nextTemplate),
        ctx.clock.now(),
        ctx.workspaceId,
        input.ruleId,
      );
    return ok({ rule: mapRule(ctx, readRule(ctx, input.ruleId) as StoredRule) });
  };

  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'update_automation_rule', run);
  }
  return run();
}

/** Enable, disable and archive all assert an ABSOLUTE state, so a replay re-asserts and settles. */
function setFlag(ctx: WorkspaceContext, ruleId: string, column: 'enabled' | 'archived', value: 0 | 1): Result {
  const row = readRule(ctx, ruleId);
  if (row === undefined) return err('not_found', { ruleId });
  ctx.store.db
    .prepare(`UPDATE automation_rule SET ${column} = ?, updated_at = ? WHERE workspace_id = ? AND id = ?`)
    .run(value, ctx.clock.now(), ctx.workspaceId, ruleId);
  return ok({ rule: mapRule(ctx, readRule(ctx, ruleId) as StoredRule) });
}

export function enableAutomationRule(ctx: WorkspaceContext, input: { ruleId: string }): Result {
  const row = readRule(ctx, input.ruleId);
  if (row === undefined) return err('not_found', { ruleId: input.ruleId });
  // An archived rule cannot be quietly brought back to life by the enable toggle: that would make
  // "archived" mean nothing, and the run history it is preserving would start growing again.
  if (row.archived === 1) return err('rule_archived', { ruleId: input.ruleId });
  // Neither can a rule whose stored action the denylist has since denied (F5-R4). The
  // generation-6 migration disables exactly such rules, and this is the door the re-critic found
  // still open: create and patch were checked, the toggle was not, so the migration's work could
  // be undone with one ok:true. The fire path would still refuse every firing, but a rule that is
  // enabled and can never run is a lie on the Automations surface, and the migration would re-run
  // nothing (generation 6 is past). Refused with the same stable code the save path uses.
  if (isNotAutomatable(row.action_tool)) {
    return err('action_not_automatable', { ruleId: input.ruleId, tool: row.action_tool });
  }
  return setFlag(ctx, input.ruleId, 'enabled', 1);
}

export function disableAutomationRule(ctx: WorkspaceContext, input: { ruleId: string }): Result {
  return setFlag(ctx, input.ruleId, 'enabled', 0);
}

export function archiveAutomationRule(ctx: WorkspaceContext, input: { ruleId: string }): Result {
  const row = readRule(ctx, input.ruleId);
  if (row === undefined) return err('not_found', { ruleId: input.ruleId });
  // Archiving also disables, because a rule that is hidden from the list and still firing is the
  // exact surprise this capability must never produce.
  ctx.store.db
    .prepare('UPDATE automation_rule SET archived = 1, enabled = 0, updated_at = ? WHERE workspace_id = ? AND id = ?')
    .run(ctx.clock.now(), ctx.workspaceId, input.ruleId);
  return ok({ rule: mapRule(ctx, readRule(ctx, input.ruleId) as StoredRule) });
}

export function getAutomationRule(ctx: WorkspaceContext, input: { ruleId: string }): Result {
  const row = readRule(ctx, input.ruleId);
  if (row === undefined) return err('not_found', { ruleId: input.ruleId });
  return ok({ rule: mapRule(ctx, row) });
}

export function listAutomationRules(
  ctx: WorkspaceContext,
  input: { event?: string; enabled?: boolean; includeArchived?: boolean; savedViewId?: string } = {},
): Result {
  // G00's seam, and it is here because G01 now registers `automation_rule` as an OP3 entity kind.
  // Registering the kind is what makes `create_saved_view` accept it, so a list verb that ignored
  // `savedViewId` would let a person save a view of their rules that nothing could ever apply. ONE
  // unconditional call, exactly as `listDocuments` and `listPayments` make it: `applySavedView`
  // returns the filter untouched when no view is named and merges the stored filters underneath the
  // caller's explicit ones when one is, so this function keeps no branch of its own.
  const viewed = applySavedView(ctx, 'automation_rule', input);
  if (!viewed.ok) return viewed;
  input = viewed.filter;
  const where: string[] = ['workspace_id = ?'];
  const args: unknown[] = [ctx.workspaceId];
  if (input.includeArchived !== true) where.push('archived = 0');
  if (typeof input.event === 'string' && input.event.length > 0) {
    where.push('trigger_event = ?');
    args.push(input.event);
  }
  if (typeof input.enabled === 'boolean') {
    where.push('enabled = ?');
    args.push(input.enabled ? 1 : 0);
  }
  const rows = ctx.store.db
    .prepare(`SELECT * FROM automation_rule WHERE ${where.join(' AND ')} ORDER BY created_at DESC`)
    .all(...args) as StoredRule[];
  // THE CATALOGUE RIDES WITH THE LIST rather than living in an eleventh verb, and it is derived from
  // the registries rather than restated: a Studio picker offering an event or an action the engine
  // would refuse is the drift this whole capability is built to avoid, and one read cannot drift from
  // itself. It is also what an agent needs to compose a rule without guessing at a name.
  return ok({
    rules: rows.map((row) => mapRule(ctx, row)),
    catalogue: {
      events: AUTOMATION_EVENTS.map((e) => ({
        event: e.event,
        entityKind: e.entityKind ?? null,
        emittedBy: e.emittedBy.length > 0 ? e.emittedBy : null,
        schedule: isScheduleEvent(e.event),
      })),
      // The denylist is applied to the CATALOGUE too, not only to the save. A picker that offers an
      // action the engine refuses at save time is the drift this whole read exists to avoid.
      actions: registeredWriteActions().filter((tool) => !isNotAutomatable(tool)),
      ops: [...CONDITION_OPS],
    },
  });
}
