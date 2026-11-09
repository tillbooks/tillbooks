/**
 * THE ONE PLACE THE DIAL TIER OF A GOVERNED CALL IS PICKED, reading the book where the input alone
 * cannot tell (D141.5, critic R4-1, 30.09.2026).
 *
 * `dialCapabilityForCall` answers from the input alone, and for most verbs the input is enough. For the
 * writes that make a G01 rule fire, or change what a firing rule does, it is not: `enable_automation_rule`
 * carries only a rule id, and an `update_automation_rule` patch that names no `tool` (a template, a
 * trigger or a condition) leaves the verb the rule fires in the STORED row. Both fell back to
 * `customize`, so while `customize` stood at `auto` an agent seat made a `post_entry` rule fire, or
 * changed what a live one posts, with no Vorschlag. Granting `customize` silently granted rule-driven
 * posting, issuing and paying.
 *
 * THE RULE, one sentence: a write that lets a rule fire is governed at the tier of the verb the rule
 * will fire, resolved from the STORED rule with the write's own values laid over it exactly as the
 * engine lays them, and `customize` is a FLOOR: of all the candidate tiers, the first one that would
 * draft wins, so the stricter of "the verb it fires" and `customize` always decides.
 *
 * A template with a `{{placeholder}}` cannot be resolved before the event, and a whole-value
 * placeholder keeps the payload's type (`to: '{{payload.to}}'` may become `'issued'`), so a templated
 * input adds EVERY tier an input-keyed rule of that verb can resolve to. Over-governing a templated
 * rule costs one Vorschlag; under-governing it was the defect.
 *
 * WHY A CLOSED MAP OF RULE WRITES AND NOT A GUESS FROM THE VERB NAME: `disable_automation_rule` and
 * `archive_automation_rule` also take a rule id and must NEVER draft (a stop button that asks is not a
 * stop button). So every write on the rule family is classified here, and
 * `test/agent/rule-tier-chokepoint.test.mjs` derives the family from the registry (every write gated on
 * `manage_automations`, every write named `*automation*`) and fails on one this module does not classify.
 *
 * READS ARE TENANT-SCOPED (§H-TENANT): a rule id or run id from another workspace reads as absent, and
 * an absent, archived or denylisted row is left to the verb, which refuses it without writing anything.
 */

import type { WorkspaceContext } from '../context.js';
import { isNotAutomatable } from '../automation/denylist.js';
import { dialCapabilitiesForCall, INPUT_KEYED_DIAL_RULES, stateKeyedDialCapabilities } from './dialMap.js';
import { dialCapabilityIsForceAsk, effectiveDialLevel } from './dial.js';

/**
 * Every write that can make a stored rule's verb run, and how its effective rule is read. `retry`
 * re-drives a stuck firing (the rule's verb, as the rule's author) and carries no `customize` floor:
 * it changes no rule, it finishes one firing.
 */
export const RULE_FIRING_WRITES: Readonly<Record<string, 'create' | 'update' | 'enable' | 'retry'>> = {
  create_automation_rule: 'create',
  update_automation_rule: 'update',
  enable_automation_rule: 'enable',
  retry_automation_run: 'retry',
};

/**
 * The rule-family writes that deliberately stay OFF the rule tier, each with the reason in words. The
 * structural test fails on a family write that is in neither map.
 */
export const RULE_WRITES_NOT_TIERED: Readonly<Record<string, string>> = {
  disable_automation_rule: 'The stop direction: it only ever prevents a firing, and a stop button that drafts is not a stop button.',
  archive_automation_rule: 'The stop direction: archiving also disables, so it only ever prevents a firing.',
  run_due_automations:
    'The schedule tick fires only rules that are already enabled, and enabling is governed here. The agent seat\'s own call to the tick is dial-governed by an input-keyed rule under customize (D161); it reads no stored rule, so it carries no rule tier.',
  notifications_deliver:
    'Gated on manage_automations only because it is the action a G01 rule names (G06 §5): it inserts one inbox item, touches no rule and fires no verb. The agent seat\'s own call is dial-governed by name under send (D161).',
};

/**
 * Whether the tier of this write is read from a STORED rule the verb then rewrites (critic L2, D141.5
 * R4-1). The transport seam runs such a write for a governed seat inside ONE write transaction, from the
 * tier read to the verb's own write, so a second process (D12: the Studio and an agent subprocess share
 * the file) cannot repoint the rule between the two. `create` reads no row; `retry` reads a run row
 * whose tool and input are never rewritten.
 */
export function readsStoredRule(name: string): boolean {
  const kind = RULE_FIRING_WRITES[name];
  return kind === 'update' || kind === 'enable';
}

const FLOOR = 'customize';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasPlaceholder(value: unknown): boolean {
  if (typeof value === 'string') return value.includes('{{');
  if (Array.isArray(value)) return value.some(hasPlaceholder);
  if (isPlainObject(value)) return Object.values(value).some(hasPlaceholder);
  return false;
}

/**
 * The tiers the verb a rule fires can draft at: the exact tier of its literal input, plus, when the
 * template still holds a placeholder, every tier an input-keyed rule of that verb can resolve to.
 */
function firedTiers(tool: unknown, template: unknown): string[] {
  if (typeof tool !== 'string' || tool.length === 0) return [];
  // A rule naming a rule write is self-administration of the unattended subsystem; the denylist refuses
  // it at save time, and its own tier is the structural one.
  if (tool in RULE_FIRING_WRITES) return [FLOOR];
  const input = isPlainObject(template) ? template : {};
  const tiers: string[] = [];
  tiers.push(...dialCapabilitiesForCall(tool, input));
  if (hasPlaceholder(input)) {
    for (const rule of INPUT_KEYED_DIAL_RULES) {
      if (rule.action === tool) tiers.push(rule.capability);
    }
  }
  return tiers;
}

interface RuleRow {
  trigger_event: string;
  action_tool: string;
  action_input: string;
  archived: number;
}

function readRuleRow(ctx: WorkspaceContext, ruleId: unknown): RuleRow | undefined {
  if (typeof ruleId !== 'string' || ruleId.length === 0) return undefined;
  return ctx.store.db
    .prepare('SELECT trigger_event, action_tool, action_input, archived FROM automation_rule WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, ruleId) as RuleRow | undefined;
}

function parseObject(json: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(json) as unknown;
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Would this tier draft for an agent seat in this workspace right now (the dial's own rule)? */
function drafts(ctx: WorkspaceContext, capability: string): boolean {
  return dialCapabilityIsForceAsk(ctx, capability) || effectiveDialLevel(ctx, capability).effective !== 'auto';
}

/**
 * The candidate that governs a call matching several tiers: the first one (in the order given, most
 * severe first where the caller sorted) that would DRAFT against this book, else the first candidate
 * (it executes, and the trace names it). Any drafting candidate wins, so a looser match can never
 * carry the call past a stricter one.
 */
export function strictestDialCapability(ctx: WorkspaceContext, candidates: readonly string[]): string | undefined {
  return strictest(ctx, candidates);
}

function strictest(ctx: WorkspaceContext, candidates: readonly string[]): string | undefined {
  const unique = [...new Set(candidates)];
  if (unique.length === 0) return undefined;
  return unique.find((c) => drafts(ctx, c)) ?? unique[0];
}

/**
 * The candidate tiers of a rule-family write, or `null` when the write lets nothing new fire (or the
 * verb will refuse it without writing, so there is nothing to draft).
 */
function ruleWriteCandidates(ctx: WorkspaceContext, kind: 'create' | 'update' | 'enable' | 'retry', input: Readonly<Record<string, unknown>>): string[] | null {
  if (kind === 'create') {
    // A rule composed DISABLED fires nothing; its enable is governed below, against what is then stored.
    if (typeof input.name !== 'string' || input.enabled === false) return null;
    const action = isPlainObject(input.action) ? input.action : {};
    return [...firedTiers(action.tool, action.inputTemplate ?? {}), FLOOR];
  }
  if (kind === 'update') {
    const patch = input.patch;
    if (!isPlainObject(patch)) return null;
    // A rename changes nothing a rule does. Every trigger, condition or action change is governed, on a
    // disabled rule too: a pending enable Vorschlag would otherwise be approved over a rule the agent
    // repointed after proposing it.
    if (!('trigger' in patch) && !('condition' in patch) && !('action' in patch)) return null;
    const row = readRuleRow(ctx, input.ruleId);
    if (row === undefined || row.archived === 1) return null;
    // The engine's own merge (`updateAutomationRule`): the patched tool over the stored one, the patched
    // template over the stored one, each independently.
    const action = isPlainObject(patch.action) ? patch.action : undefined;
    const tool = action?.tool ?? row.action_tool;
    const template = action?.inputTemplate !== undefined ? action.inputTemplate : parseObject(row.action_input);
    return [...firedTiers(tool, template), FLOOR];
  }
  if (kind === 'enable') {
    const row = readRuleRow(ctx, input.ruleId);
    if (row === undefined || row.archived === 1 || isNotAutomatable(row.action_tool)) return null;
    return [...firedTiers(row.action_tool, parseObject(row.action_input)), FLOOR];
  }
  // retry: the stuck run's RESOLVED input is what is re-sent, so its tier is exact.
  if (typeof input.runId !== 'string' || input.runId.length === 0) return null;
  const run = ctx.store.db
    .prepare('SELECT status, action_tool, action_input FROM automation_run WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, input.runId) as { status: string; action_tool: string; action_input: string } | undefined;
  if (run === undefined || run.status !== 'running' || isNotAutomatable(run.action_tool)) return null;
  const tiers = firedTiers(run.action_tool, parseObject(run.action_input));
  return tiers.length === 0 ? null : tiers;
}

/**
 * The dial capability governing ONE agent-seat call, read against the book. The transport seam
 * (`src/api/agent-gate.ts`) calls this and nothing else. For every verb outside the rule family it is
 * `dialCapabilityForCall`; for a rule-family write the input-only answer stays a candidate, so reading
 * the book can only make the call stricter, never looser.
 */
export function governedDialCapability(ctx: WorkspaceContext, name: string, input: Readonly<Record<string, unknown>>): string | undefined {
  // EVERY matching tier, most severe first (critic R3 on cl-periods: the first input-keyed match used
  // to win), and the strictest against the book governs.
  // Critic round 3 (N2): the state-keyed rules read the book too (a reset of a saved text).
  const byInput = [...dialCapabilitiesForCall(name, input), ...stateKeyedDialCapabilities(ctx, name, input)];
  const kind = RULE_FIRING_WRITES[name];
  const candidates = kind === undefined ? null : ruleWriteCandidates(ctx, kind, input);
  if (candidates === null) return strictest(ctx, byInput);
  return strictest(ctx, [...candidates, ...byInput]);
}
