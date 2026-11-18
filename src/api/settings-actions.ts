/**
 * D172, the workspace settings registry's verbs (three reads, two writes), defined here and spread into
 * `ACTIONS` as ONE line (the `fxActions` / `liquidityActions` precedent), so several agents appending to the
 * append-only registry at once collide over a line rather than a block.
 *
 * Every setting is a row of `src/core/settings/registry.ts`; these verbs are generic over it. A change
 * requires the owning capability of the KEY (the A24 map reads it from the input) and an idempotency key; a
 * reason is optional (D202 point 6). The agent seat's change takes the D202 route
 * (`src/core/settings/agentAccess.ts`, run by the transport seam): a protected key becomes a person-only
 * Vorschlag, a key in an area the owner granted applies at once, any other key drafts under the dial family
 * the key declares.
 */

import type { ActionDef, ActionInput, JsonSchema } from './registry.js';
import type { WorkspaceContext } from '../core/context.js';
import type { Result } from '../core/result.js';
import { isSettingsAgentSeat, refuseHumanOnly, screenSettingsChange, settingsGet, settingsHistory, settingsList, settingsReset, settingsSet } from '../core/settings/index.js';
import type { ActionKind } from './actionKind.js';

export interface SettingsActionHelpers {
  ctxAction(
    name: string,
    kind: ActionKind,
    summary: string,
    inputSchema: JsonSchema,
    call: (ctx: WorkspaceContext, input: ActionInput) => Result,
  ): ActionDef;
  ctxSchema(props?: Record<string, unknown>, required?: string[]): JsonSchema;
  /** N02/N04 (D183): attach a verb's pure pre-draft validation (`ActionDef.prevalidate`). */
  withPrevalidate(def: ActionDef, check: (ctx: WorkspaceContext, input: ActionInput) => Result | undefined): ActionDef;
  STR: { readonly type: 'string' };
}

/**
 * The pre-draft screen of a governed seat's change (D158): the verb's own pure validation, so a Vorschlag
 * that could only fail is never queued. A protected key still refuses every governed seat that is NOT the
 * agent (a plugin call, D183); the agent seat's protected key never reaches here, because the transport
 * seam turns it into a person-only Vorschlag first (D202 point 5).
 */
function screen(verb: 'settings_set' | 'settings_reset') {
  return (ctx: WorkspaceContext, input: ActionInput): Result | undefined => {
    if (!isSettingsAgentSeat(ctx, ctx.actor)) {
      const humanOnly = refuseHumanOnly(ctx, input.key);
      if (humanOnly !== null) return humanOnly;
    }
    const screened = screenSettingsChange(ctx, verb, input);
    return 'refusal' in screened ? screened.refusal : undefined;
  };
}

/** A setting's value: the key's own schema (integer, number, boolean, string or enum) decides. */
const VALUE = { type: ['integer', 'number', 'boolean', 'string'] } as const;

/** What the agent seat meets on a settings write (D202), said once for both writes. */
const AGENT_ROUTE =
  'For an agent seat: a human-only setting (humanOnly: true in settings_list) is never applied; the call becomes a Vorschlag a person approves with one click (never in a batch, never under the agent.decide_proposals grant), at most agent.settings_proposals_open_max are waiting (too_many_open_proposals), and it goes stale once the setting moves. An ask-first setting is refused human_only (a person answers it). A setting in an area the owner opened to the agent (agent.settings_sections, areas[].agentMayChange in settings_list) applies at once; any other follows the agent dial of the key\'s family. A plugin call is refused human_only on a human-only setting.';

export function settingsActions(h: SettingsActionHelpers): ActionDef[] {
  const { ctxAction, ctxSchema, STR, withPrevalidate } = h;
  return [
    ctxAction(
      'settings_list',
      'read',
      'List every workspace setting (Einstellungen) from the registry: its key, the value in force, the default, whether this workspace overrides it (stale: true with ignoredStoredValue when a stored override no longer fits and the default applies), the value schema (type and bounds), the capability needed to change it, the dial family a change drafts under, an en and de-CH label and description, and D202 presentation: section (one of the ten areas firma, buchhaltung, bank, mwst, belege, verkauf, agent, darstellung, zugriff, daten) and presentation { subgroup, label, valueLabels (every enum value in en and de-CH words), keywords, widensAgent }. Find a setting by the person\'s words through label, valueLabels, keywords and the area keywords. The answer also carries areas [{ id, label, icon, keywords, pages [{ id, route, label }], agentMayChange (the owner lets the agent change this area\'s non-protected settings without a Vorschlag) }]. A setting with no override reads its default. A41: askFirst marks a setting TILL asks a person before its default takes effect; answered is false until a person set it (the behaviour stays conservative meanwhile, value is only the suggestion), and unanswered lists those open questions by key so an agent can tell the person what to decide; an agent can never answer one (human_only).',
      ctxSchema(),
      (ctx) => settingsList(ctx),
    ),
    ctxAction(
      'settings_get',
      'read',
      'Read one workspace setting by key: the value in force, the default, whether it is overridden, who changed it and when, and its D202 presentation (section, label, valueLabels). An unknown key is refused unknown_setting.',
      ctxSchema({ key: STR }, ['key']),
      (ctx, input) => settingsGet(ctx, input),
    ),
    ctxAction(
      'settings_history',
      'read',
      'Read who changed which workspace setting, from what to what, when, and how (D202): the append-only history, newest first, optionally for one key or one area (firma, buchhaltung, bank, mwst, belege, verkauf, agent, darstellung, zugriff, daten). Each change carries id, key, kind (set | reset), oldValue and newValue (null: the default), actor, seat (person | agent | plugin | system), via (direct | vorschlag: a person approved the agent\'s Vorschlag | standing: the agent under the owner\'s area permission | dial: the agent under its dial), approvedBy, proposedBy, draftedActionId, capability (what the change was checked against) and reason (null when none was given). A row from before D202 carries null for seat, via and capability. limit 1 to 200 (default 50); pass nextBefore as before for the next page. An unknown key is unknown_setting, an unknown area invalid_input.',
      ctxSchema({ key: STR, area: STR, limit: { type: 'integer' }, before: STR }),
      (ctx, input) => settingsHistory(ctx, input),
    ),
    withPrevalidate(ctxAction(
      'settings_set',
      'write:reversible:internal',
      `Change one workspace setting. value must fit the key's schema exactly (invalid_setting_value otherwise; an unknown key is unknown_setting). reason is optional (D202: no reason is ever required); when given it is kept with the change. Every change is recorded with the old and new value, who, when, the seat and the permission it used (settings_history) and on the audit trail. Needs the capability that owns the key. ${AGENT_ROUTE} A Belegnummer setting is also refused when ledger.belegnummer_prefix is not empty or 1 to 12 characters from A-Z a-z 0-9 . _ / - starting with a letter or digit and not ending in a digit (belegnummer_prefix_invalid), and when the change could hand out a voucher number that already exists (belegnummer_display_clash, naming it). agent.settings_sections is a comma-separated list of area ids (an unknown or repeated one is invalid_setting_value). Setting the value already in force changes nothing. The way back is settings_set to the previous value or settings_reset.`,
      ctxSchema({ key: STR, value: VALUE, reason: STR, idempotencyKey: STR }, ['key', 'value', 'idempotencyKey']),
      (ctx, input) => settingsSet(ctx, input),
    ), screen('settings_set')),
    withPrevalidate(ctxAction(
      'settings_reset',
      'write:reversible:internal',
      `Return one workspace setting to its default by removing this workspace's override. reason is optional (D202). The change is recorded with the old value, who, when, the seat and the permission it used (settings_history) and on the audit trail. ${AGENT_ROUTE} A setting without an override is left as it is. A Belegnummer setting whose default could hand out a voucher number that already exists is refused (belegnummer_display_clash). The way back is settings_set to the previous value.`,
      ctxSchema({ key: STR, reason: STR, idempotencyKey: STR }, ['key', 'idempotencyKey']),
      (ctx, input) => settingsReset(ctx, input),
    ), screen('settings_reset')),
  ];
}
