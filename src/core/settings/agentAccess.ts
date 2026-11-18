/**
 * D202 points 4 and 5 (owner, 15.11.2026): THE AGENT AND A SETTING. The one decision the transport seam
 * (`src/api/agent-gate.ts`) asks before it touches the dial for `settings_set` / `settings_reset` from the
 * agent seat, and the facts the approval path reads about a settings Vorschlag.
 *
 * THE ROUTE, in this order (G00 §11.5):
 *  1. The pure screen (`screenSettingsChange`): a known key, an idempotency key, a value that fits, the key's
 *     own rule. A refusal drafts nothing.
 *  2. An ASK-FIRST key (A41) is refused `human_only`: an open question is a person's to answer.
 *  3. A HUMAN-ONLY key is a PERSON-ONLY Vorschlag under every dial and every permission (reverses D183 for
 *     proposals). It is never applied by the agent: the engine refuses a governed seat's write of it at
 *     execution (`refuseHumanOnly`), so the only way it changes is a person's approval, which replays as that
 *     person.
 *  4. A non-protected key whose area the owner granted (`agent.settings_sections`, live) applies at once.
 *  5. Otherwise the dial of the key's family decides.
 * A running plugin call is never "the agent" here (`isSettingsAgentSeat`): it keeps D183 for a protected key.
 *
 * THE PERSON-ONLY VORSCHLAG. Approved by a person with one click: never by a governed seat (also not under the
 * D196 grant), never in a batch, never with `allowFuture`. At most `agent.settings_proposals_open_max` are
 * pending at once (`too_many_open_proposals`). Stale once the setting moves (the record pin).
 */

import type { WorkspaceContext } from '../context.js';
import { err, type Err } from '../result.js';
import { settingInForce, unchangedAnswer, type SettingsSetOk } from './settings.js';
import { capabilityFor, isGovernedSeat } from '../access/capability.js';
import { getSetting, isSettingsAgentSeat, liveSettingsAreaGrant, screenSettingsChange, SETTINGS_PROPOSALS_OPEN_MAX_KEY } from './settings.js';
import { SETTINGS, settingDef, type SettingDef } from './registry.js';
import { presentationOf } from './presentation.js';
import type { SettingsArea } from './areas.js';
// D103's strong-default families (`vat-file`, `plugin-install`); a leaf of the dial module, no cycle.
import { STRONG_DEFAULT_ASK_CAPABILITIES } from '../agent/dial.js';

/** D202 critic L1: the setting that keeps sensitive settings a Vorschlag in an opened area. */
export const AREA_RESPECTS_STRONG_DEFAULT_KEY = 'agent.settings_area_respects_strong_default';

/** The two settings writes. */
export const SETTINGS_WRITE_VERBS: ReadonlySet<string> = new Set(['settings_set', 'settings_reset']);

/** What the transport seam does with an agent seat's settings write. */
export type AgentSettingsPlan =
  // `delegated`: the A24 check the call's own route would run lifts step 0 (a proposal). The seam runs THAT
  // check before it answers a refusal or `unchanged`, so neither answer tells a seat without the right anything
  // about the setting (security review: no value oracle).
  | { route: 'refuse'; result: Err; delegated: boolean }
  | { route: 'unchanged'; result: SettingsSetOk & { unchanged: true }; delegated: boolean }
  | { route: 'propose'; key: string; dialCapability: string; reason: 'person_only' | 'area_strong_default' }
  | { route: 'standing'; key: string; area: SettingsArea }
  | { route: 'dial'; key: string; dialCapability: string };

/**
 * The route of one settings write from the agent seat, or null when this is not one (another verb, another
 * seat). Pure apart from reads; it writes nothing.
 */
export function planAgentSettingsCall(ctx: WorkspaceContext, verb: string, input: Readonly<Record<string, unknown>>): AgentSettingsPlan | null {
  if (!SETTINGS_WRITE_VERBS.has(verb)) return null;
  if (!isSettingsAgentSeat(ctx, ctx.actor)) return null;
  // The route first, from the key alone (never from the value), so the capability check the seam runs before
  // any answer is the one the call's own route runs.
  const known = settingDef(input.key);
  const route = known === undefined ? null : routeOf(ctx, known);
  const delegated = route?.route === 'propose';
  const screened = screenSettingsChange(ctx, verb as 'settings_set' | 'settings_reset', input);
  if ('refusal' in screened) return { route: 'refuse', result: screened.refusal, delegated };
  const def = screened.def;
  if (def.askFirst === true) {
    return {
      route: 'refuse',
      delegated,
      result: err('human_only', {
        key: def.key,
        reason: 'ask_first',
        message: 'this is an open question TILL asks a person (Einstellungen > Offene Fragen); ask your person to answer it there',
      }) as Err,
    };
  }
  // Critic L3: a call that would change nothing is answered as such, never drafted (it takes no cap slot).
  // Only for a fresh idempotency key: a key a Vorschlag or an act already holds takes the normal route, whose
  // draft answers the replay or `idempotency_key_conflict` (re-check L1).
  const same = keyHeld(ctx, verb, input.idempotencyKey) ? null : unchangedAnswer(ctx, def, verb as 'settings_set' | 'settings_reset', input.value);
  if (same !== null) return { route: 'unchanged', result: { ...same, unchanged: true }, delegated };
  return route ?? routeOf(ctx, def);
}

/** Whether this verb's idempotency key is already held: by a Vorschlag (not voided) or by an act it ran. */
function keyHeld(ctx: WorkspaceContext, verb: string, idempotencyKey: unknown): boolean {
  if (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0) return false;
  const drafted = ctx.store.db
    .prepare("SELECT 1 AS p FROM agent_action WHERE workspace_id = ? AND action_tool = ? AND idempotency_key = ? AND status <> 'stale'")
    .get(ctx.workspaceId, verb, idempotencyKey);
  if (drafted !== undefined) return true;
  return ctx.store.recordedIdempotencyArgs(ctx.workspaceId, verb, idempotencyKey) !== undefined
    || ctx.store.recallIdempotent(ctx.workspaceId, idempotencyKey, verb) !== undefined;
}

/**
 * Re-check L2: whether an opened area still sends sensitive settings to a person. The stored `false` counts
 * only while the person who set it is not a governed seat and still holds `manage_agent_dial` (the
 * `liveSettingsAreaGrant` rule); otherwise the default `true` holds (fail closed).
 */
function respectsStrongDefault(ctx: WorkspaceContext): boolean {
  const inForce = settingInForce<boolean>(ctx, AREA_RESPECTS_STRONG_DEFAULT_KEY);
  if (inForce.value !== false) return true;
  if (!inForce.overridden || inForce.stale || inForce.updatedBy === null) return true;
  if (isGovernedSeat(ctx.store, inForce.updatedBy)) return true;
  return !capabilityFor(ctx.store, ctx.workspaceId, inForce.updatedBy, 'manage_agent_dial');
}

/** The route a known key takes for the agent seat: person-only, the opened area, or the dial. */
function routeOf(ctx: WorkspaceContext, def: SettingDef): Extract<AgentSettingsPlan, { route: 'propose' | 'standing' | 'dial' }> {
  if (def.humanOnly === true) return { route: 'propose', key: def.key, dialCapability: def.dialCapability, reason: 'person_only' };
  const area = presentationOf(def.key, def.label).area;
  if (liveSettingsAreaGrant(ctx)?.areas.includes(area) === true) {
    // D202 critic L1 (D172 setting, default true): an opened area never applies a strong-default family's
    // setting or one of the Agent area at once; it stays a one-click Vorschlag a person decides.
    const sensitive = STRONG_DEFAULT_ASK_CAPABILITIES.has(def.dialCapability) || area === 'agent';
    if (sensitive && respectsStrongDefault(ctx)) {
      return { route: 'propose', key: def.key, dialCapability: def.dialCapability, reason: 'area_strong_default' };
    }
    return { route: 'standing', key: def.key, area };
  }
  return { route: 'dial', key: def.key, dialCapability: def.dialCapability };
}

/** The human-only keys: what a pending settings Vorschlag must name to be person-only. */
function humanOnlyKeys(): string[] {
  return SETTINGS.filter((d) => d.humanOnly === true).map((d) => d.key);
}

/** Whether a stored Vorschlag is a person-only settings Vorschlag (a protected key the agent proposed). */
export function isPersonOnlySettingsRow(row: { action_tool: string; payload_json: string }): boolean {
  if (!SETTINGS_WRITE_VERBS.has(row.action_tool)) return false;
  try {
    const payload = JSON.parse(row.payload_json) as { key?: unknown };
    return settingDef(payload.key)?.humanOnly === true;
  } catch {
    // A payload that cannot be read fails closed: treat it as protected, so no governed seat approves it.
    return true;
  }
}

/** How many person-only settings Vorschläge are pending in this workspace (§H-TENANT). */
export function openPersonOnlyProposals(ctx: WorkspaceContext): number {
  const keys = humanOnlyKeys();
  if (keys.length === 0) return 0;
  const row = ctx.store.db
    .prepare(
      `SELECT COUNT(*) AS n FROM agent_action
        WHERE workspace_id = ? AND status = 'pending' AND action_tool IN ('settings_set', 'settings_reset')
          AND json_extract(payload_json, '$.key') IN (${keys.map(() => '?').join(', ')})`,
    )
    .get(ctx.workspaceId, ...keys) as { n: number };
  return row.n;
}

/**
 * D202 (I8): the refusal of one more person-only Vorschlag when `agent.settings_proposals_open_max` are
 * already pending, or null. A retry under the key of a row that is still pending is the same proposal (the
 * draft answers that row), so it is never counted twice.
 */
export function refuseTooManyProposals(ctx: WorkspaceContext, verb: string, input: Readonly<Record<string, unknown>>): Err | null {
  const key = typeof input.idempotencyKey === 'string' ? input.idempotencyKey : null;
  if (key !== null) {
    const same = ctx.store.db
      .prepare("SELECT 1 AS p FROM agent_action WHERE workspace_id = ? AND action_tool = ? AND idempotency_key = ? AND status = 'pending'")
      .get(ctx.workspaceId, verb, key);
    if (same !== undefined) return null;
  }
  const max = getSetting<number>(ctx, SETTINGS_PROPOSALS_OPEN_MAX_KEY);
  const open = openPersonOnlyProposals(ctx);
  if (open < max) return null;
  return err('too_many_open_proposals', {
    open,
    max,
    setting: SETTINGS_PROPOSALS_OPEN_MAX_KEY,
    reason: 'the agent already has the most proposals to change a protected setting waiting; ask your person to decide those first',
  }) as Err;
}
