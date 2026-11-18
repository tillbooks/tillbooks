/**
 * D172, the workspace settings verbs and the typed accessor every capability reads a setting through.
 *
 * READS ARE CHEAP: `getSetting` is one primary-key lookup, no capability check (the caller already
 * passed its own) and no audit. A missing row is the registry default; a stored value that no longer
 * fits the key's schema (a bound tightened in a later build) is the default too, so a read never throws
 * and never hands a caller a value the registry would refuse.
 *
 * EVERY CHANGE IS AUDITED AND IDEMPOTENT ON ROWS. `settings_set` and `settings_reset` write the row (or
 * remove it, for a reset), append one `workspace_setting_change` row naming the old value, the new value,
 * the actor, the seat, how the change came about, the approver of a Vorschlag and the capability it was
 * checked against (D202; a reason is optional and stored as written), and append one A03 audit-chain row,
 * all in ONE transaction under the call's idempotency key: a replay answers the stored result and writes
 * nothing.
 * A set to the value already in force, or a reset of a setting that holds no override, changes nothing
 * and records nothing (`changed: false`), so a person pressing Save twice does not grow the history.
 *
 * §H-TENANT: every statement is scoped by `ctx.workspaceId`.
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Err, Result } from '../result.js';
import { afterBelegnummerSettingChange, refuseBelegnummerSetting } from '../ledger/entryNumber.js';
import { capabilityFor, isGovernedSeat } from '../access/capability.js';
import { AGENT_ACTOR } from '../access/actors.js';
import { isPluginCallActor } from '../plugins/callScope.js';
import { approvingActionIds } from '../agent/approving.js';
import { briefSectionsProblem } from '../hausbuch/sections.js';
import { SETTINGS_AREA_DEFS, parseSettingsSections, settingsSectionsProblem, type SettingsArea } from './areas.js';
import { ownerWordExcludedProblem } from '../agent/ownerWordExcluded.js';
import { presentationOf, type SettingPresentation } from './presentation.js';
import {
  SETTINGS,
  settingDef,
  valueFitsSchema,
  type LocalisedText,
  type SettingDef,
  type SettingSchema,
  type SettingValue,
} from './registry.js';

/** What `settings_list` and `settings_get` say about one setting. */
export type SettingView = {
  key: string;
  value: SettingValue;
  default: SettingValue;
  overridden: boolean;
  schema: SettingSchema;
  owningCapability: string;
  dialCapability: string;
  area: { id: string; label: LocalisedText };
  label: LocalisedText;
  description: LocalisedText;
  /** N02/N04 (D183): only a person may change it; a governed seat is refused `human_only`. */
  humanOnly: boolean;
  /**
   * A41 (D184 point 6): an ASK-FIRST setting. `answered` is false until a person in this workspace set it;
   * while false, the behaviour that reads it stays conservative and `default` is only the suggestion.
   * Always present; `answered` is true for every setting that is not ask first.
   */
  askFirst: boolean;
  answered: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
  /**
   * Critic (D172 r1): a stored override that no longer fits the key's schema (a bound tightened in a later
   * build, a hand-edited row) is IGNORED and the default applies. `stale: true` says so, and
   * `ignoredStoredValue` carries the raw stored JSON, so the person sees why the history's last value is
   * not the value in force and can reset or set it. Absent `stale` (false) means no ignored row.
   */
  stale: boolean;
  ignoredStoredValue: string | null;
  /**
   * D202: how the setting is shown and found (`./presentation.ts`): its area of the ten (`section`), the
   * sub-heading, a plain label, a label per enum value and the search words.
   */
  section: SettingsArea;
  presentation: Pick<SettingPresentation, 'subgroup' | 'label' | 'valueLabels' | 'keywords' | 'widensAgent'>;
};

/** D202: one of the ten areas as `settings_list` answers it. */
export type SettingsAreaView = {
  id: SettingsArea;
  label: LocalisedText;
  icon: string;
  keywords: { en: readonly string[]; 'de-CH': readonly string[] };
  pages: { id: string; route: string; label: LocalisedText; keywords: { en: readonly string[]; 'de-CH': readonly string[] } }[];
  /** The owner lets the agent change this area's non-protected settings without a Vorschlag (live grant). */
  agentMayChange: boolean;
};

export type SettingsListOk = {
  settings: SettingView[];
  /** A41 (D184 point 6): the ask-first settings no person answered yet, by key: the open questions. */
  unanswered: string[];
  /** D202: the ten areas, in the order the Einstellungen home shows them. */
  areas: SettingsAreaView[];
};
export type SettingsGetOk = { setting: SettingView };
export type SettingsSetOk = {
  key: string;
  value: SettingValue;
  previousValue: SettingValue;
  overridden: boolean;
  changed: boolean;
  changeId: string | null;
};

interface StoredRow {
  value_json: string;
  updated_at: string;
  updated_by: string;
}

function storedRow(ctx: WorkspaceContext, key: string): StoredRow | undefined {
  return ctx.store.db
    .prepare('SELECT value_json, updated_at, updated_by FROM workspace_setting WHERE workspace_id = ? AND key = ?')
    .get(ctx.workspaceId, key) as StoredRow | undefined;
}

/** The stored value when it parses and fits the schema; undefined otherwise (the default applies). */
function storedValue(def: SettingDef, row: StoredRow | undefined): SettingValue | undefined {
  if (row === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.value_json);
  } catch {
    return undefined;
  }
  return valueFitsSchema(def.schema, parsed) ? parsed : undefined;
}

/**
 * THE TYPED ACCESSOR. The value in force for `key` in this workspace: the stored override, else the
 * registry default. Throws on a key the registry does not know, because that is a programming error in
 * the calling capability (a typo), never user input; user input reaches `settings_get`, which refuses.
 */
export function getSetting<T extends SettingValue = SettingValue>(ctx: WorkspaceContext, key: string): T {
  const def = settingDef(key);
  if (def === undefined) throw new Error(`getSetting: '${key}' is not in the settings registry (src/core/settings/registry.ts)`);
  return (storedValue(def, storedRow(ctx, key)) ?? def.default) as T;
}

/**
 * A41 (D184 point 6): has a person answered this ask-first setting, and with what? `answered` is true once a
 * stored value that fits the schema exists for the workspace (only a person can write one: an ask-first
 * setting is human-only); a setting that is not ask first is always answered. Never throws for a known key.
 */
export function settingAnswer<T extends SettingValue = SettingValue>(ctx: WorkspaceContext, key: string): { answered: boolean; value: T } {
  const def = settingDef(key);
  if (def === undefined) throw new Error(`settingAnswer: '${key}' is not in the settings registry (src/core/settings/registry.ts)`);
  const stored = storedValue(def, storedRow(ctx, key));
  return { answered: def.askFirst !== true || stored !== undefined, value: (stored ?? def.default) as T };
}

/** The value a behaviour may act on: null while an ask-first setting is unanswered (the conservative state). */
export function answeredSetting<T extends SettingValue = SettingValue>(ctx: WorkspaceContext, key: string): T | null {
  const a = settingAnswer<T>(ctx, key);
  return a.answered ? a.value : null;
}

function viewOf(ctx: WorkspaceContext, def: SettingDef): SettingView {
  const row = storedRow(ctx, def.key);
  const stored = storedValue(def, row);
  const shown = presentationOf(def.key, def.label);
  return {
    key: def.key,
    value: stored ?? def.default,
    default: def.default,
    overridden: stored !== undefined,
    schema: def.schema,
    owningCapability: def.owningCapability,
    dialCapability: def.dialCapability,
    area: def.area,
    label: def.label,
    description: def.description,
    humanOnly: def.humanOnly === true,
    askFirst: def.askFirst === true,
    answered: def.askFirst !== true || stored !== undefined,
    updatedAt: row?.updated_at ?? null,
    updatedBy: row?.updated_by ?? null,
    stale: row !== undefined && stored === undefined,
    ignoredStoredValue: row !== undefined && stored === undefined ? row.value_json : null,
    section: shown.area,
    presentation: {
      subgroup: shown.subgroup,
      label: shown.label,
      ...(shown.valueLabels !== undefined ? { valueLabels: shown.valueLabels } : {}),
      keywords: shown.keywords,
      ...(shown.widensAgent === true ? { widensAgent: true } : {}),
    },
  };
}

/**
 * D196: the value in force for `key` WITH its attribution: who stored it and when (null for the registry
 * default). For a behaviour whose grant must name the person who gave it (`agent.decide_proposals`).
 * Throws on a key the registry does not know, exactly as `getSetting` does.
 */
export function settingInForce<T extends SettingValue = SettingValue>(
  ctx: WorkspaceContext,
  key: string,
): { value: T; overridden: boolean; stale: boolean; updatedBy: string | null; updatedAt: string | null } {
  const def = settingDef(key);
  if (def === undefined) throw new Error(`settingInForce: '${key}' is not in the settings registry (src/core/settings/registry.ts)`);
  const row = storedRow(ctx, key);
  const stored = storedValue(def, row);
  return {
    value: (stored ?? def.default) as T,
    overridden: stored !== undefined,
    // A stored row that no longer fits the schema (ignored; the default applies). A caller that must fail
    // closed reads this rather than the default (critic D196 round 2 L1).
    stale: row !== undefined && stored === undefined,
    updatedBy: stored !== undefined ? (row?.updated_by ?? null) : null,
    updatedAt: stored !== undefined ? (row?.updated_at ?? null) : null,
  };
}

export function settingsList(ctx: WorkspaceContext): Result<SettingsListOk> {
  const capable = ctx.capabilities.assert('read_master_data');
  if (!capable.ok) return capable;
  const settings = SETTINGS.map((def) => viewOf(ctx, def));
  const granted = new Set<string>(liveSettingsAreaGrant(ctx)?.areas ?? []);
  const areas: SettingsAreaView[] = SETTINGS_AREA_DEFS.map((a) => ({
    id: a.id,
    label: a.label,
    icon: a.icon,
    keywords: a.keywords,
    pages: a.pages.map((p) => ({ id: p.id, route: p.route, label: p.label, keywords: p.keywords })),
    agentMayChange: granted.has(a.id),
  }));
  return ok<SettingsListOk>({ settings, unanswered: settings.filter((v) => !v.answered).map((v) => v.key), areas });
}

// --- D202: the agent's standing permission per area ---------------------------------------------------

/** The setting that carries it, and the cap on person-only Vorschläge. */
export const SETTINGS_SECTIONS_KEY = 'agent.settings_sections';
export const SETTINGS_PROPOSALS_OPEN_MAX_KEY = 'agent.settings_proposals_open_max';

/**
 * D202 point 4: the areas the owner lets the agent change without a Vorschlag, or null when none is in
 * force. FAIL CLOSED like the D196 grant (`agent/decisionGrant.ts`): only a stored value that parses, set
 * by a seat that is not governed and that still holds `manage_agent_dial` in this workspace. A demoted or
 * removed grantor takes the permission with them; a value that does not parse is no area.
 */
export function liveSettingsAreaGrant(ctx: WorkspaceContext): { areas: SettingsArea[]; grantedBy: string; grantedAt: string } | null {
  const inForce = settingInForce<string>(ctx, SETTINGS_SECTIONS_KEY);
  if (!inForce.overridden || inForce.stale || inForce.updatedBy === null || inForce.updatedAt === null) return null;
  const areas = parseSettingsSections(inForce.value);
  if (areas.length === 0) return null;
  if (isGovernedSeat(ctx.store, inForce.updatedBy)) return null;
  if (!capabilityFor(ctx.store, ctx.workspaceId, inForce.updatedBy, 'manage_agent_dial')) return null;
  return { areas, grantedBy: inForce.updatedBy, grantedAt: inForce.updatedAt };
}

/**
 * Whether an actor is THE AGENT for the settings routes: the local `agent` or a served member of kind
 * `agent`. A running plugin call is a governed seat too, but never the agent here (the D196 rule): it keeps
 * D183's refusal of a human-only key and never rides the owner's area permission.
 */
export function isSettingsAgentSeat(ctx: WorkspaceContext, actor: string): boolean {
  if (isPluginCallActor(actor)) return false;
  if (actor === AGENT_ACTOR) return true;
  const row = ctx.store.db.prepare('SELECT kind FROM user WHERE actor_id = ?').get(actor) as { kind: string } | undefined;
  return row?.kind === 'agent';
}

export function settingsGet(ctx: WorkspaceContext, input: { key?: unknown }): Result<SettingsGetOk> {
  const capable = ctx.capabilities.assert('read_master_data');
  if (!capable.ok) return capable;
  if (typeof input.key !== 'string' || input.key.length === 0) return err('invalid_input', { field: 'key' });
  const def = settingDef(input.key);
  if (def === undefined) return err('unknown_setting', { key: input.key });
  return ok<SettingsGetOk>({ setting: viewOf(ctx, def) });
}

export interface SettingsSetInput {
  key?: unknown;
  value?: unknown;
  reason?: unknown;
  idempotencyKey?: unknown;
}

export interface SettingsResetInput {
  key?: unknown;
  reason?: unknown;
  idempotencyKey?: unknown;
}

/**
 * The rules a key's SCHEMA cannot state, kept beside the generic verbs and keyed by the registry key. A rule's
 * `refuse` judges the value a change would leave in force, after the schema accepted it and before anything
 * is written (its refusal is not memoised, exactly like `invalid_setting_value`). The first are the three
 * Belegnummer settings (D178 point 2, A02 §4b.5, critic r1 L1): the prefix's closed shape, and no change that
 * could hand out an existing Beleg-Nr. again. The calls go through arrow functions so the ledger module is
 * only reached when a rule runs (the ledger reads its settings through `getSetting` in this file).
 */
interface SettingRule {
  refuse(ctx: WorkspaceContext, key: string, value: SettingValue): Err | null;
  /** Runs after an accepted change (`changed: true`), inside the change's own transaction and memo. */
  afterChange(ctx: WorkspaceContext): void;
}

const BELEGNUMMER_RULE: SettingRule = {
  refuse: (ctx, key, value) => refuseBelegnummerSetting(ctx, key, value),
  // Critic r1 L2: switching numbering back on numbers the owed backlog in the same transaction.
  afterChange: (ctx) => afterBelegnummerSettingChange(ctx),
};

/**
 * N00: the brief's sections are a comma-separated list of closed names (`core/hausbuch/sections.ts`); an
 * empty list, an unknown name or a name given twice is refused like any value its schema does not fit.
 */
const BRIEF_SECTIONS_RULE: SettingRule = {
  refuse: (_ctx, key, value) => {
    const problem = briefSectionsProblem(value);
    return problem === null ? null : err('invalid_setting_value', { key, value, ...problem });
  },
  afterChange: () => undefined,
};

/** D202: the agent's areas are a comma-separated list of closed area names; empty is allowed (none). */
const SETTINGS_SECTIONS_RULE: SettingRule = {
  refuse: (_ctx, key, value) => {
    const problem = settingsSectionsProblem(value);
    return problem === null ? null : err('invalid_setting_value', { key, value, ...problem });
  },
  afterChange: () => undefined,
};

/** D209 amendment: the owner's-word exclusions are a comma-separated list of dial families; empty is allowed. */
const OWNER_WORD_EXCLUDED_RULE: SettingRule = {
  refuse: (_ctx, key, value) => {
    const problem = ownerWordExcludedProblem(value);
    return problem === null ? null : err('invalid_setting_value', { key, value, ...problem });
  },
  afterChange: () => undefined,
};

const SETTING_RULES: Readonly<Record<string, SettingRule>> = {
  'agent.settings_sections': SETTINGS_SECTIONS_RULE,
  'agent.owner_word_excluded': OWNER_WORD_EXCLUDED_RULE,
  'ledger.belegnummer_mode': BELEGNUMMER_RULE,
  'ledger.belegnummer_start': BELEGNUMMER_RULE,
  'ledger.belegnummer_prefix': BELEGNUMMER_RULE,
  'ledger.belegnummer_split_voucher': BELEGNUMMER_RULE,
  'hausbuch.brief_sections': BRIEF_SECTIONS_RULE,
};

/**
 * N02/N04 (D183): a `humanOnly` setting refuses a governed seat (`isGovernedSeat`: the local agent, a
 * served agent member, a plugin call) with `human_only`, whatever the dial says, at EXECUTION: no governed
 * seat ever writes a protected setting (D202 I1). D202 point 5 changed only what comes before it: the agent
 * seat's call becomes a person-only Vorschlag at the transport seam (`./agentAccess.ts`), whose approval
 * replays as the person, who passes here. A plugin call is still refused before any draft. Null when the
 * key is not human-only or the actor is a person.
 */
export function refuseHumanOnly(ctx: WorkspaceContext, key: unknown): Err | null {
  const def = settingDef(key);
  if (def === undefined || def.humanOnly !== true) return null;
  if (!isGovernedSeat(ctx.store, ctx.actor)) return null;
  return err('human_only', {
    key: def.key,
    reason: 'only a person may change this setting; the agent proposes it and a person approves',
  }) as Err;
}

/** The shared validation of a change; answers the def and the trimmed reason, or the refusal. */
function validateChange(
  ctx: WorkspaceContext,
  input: { key?: unknown; reason?: unknown; idempotencyKey?: unknown },
): { def: SettingDef; reason: string; idempotencyKey: string } | { refusal: Result<never> } {
  if (typeof input.key !== 'string' || input.key.length === 0) return { refusal: err('invalid_input', { field: 'key' }) };
  if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length === 0) {
    return { refusal: err('invalid_input', { field: 'idempotencyKey' }) };
  }
  const def = settingDef(input.key);
  if (def === undefined) return { refusal: err('unknown_setting', { key: input.key }) };
  const humanOnly = refuseHumanOnly(ctx, def.key);
  if (humanOnly !== null) return { refusal: humanOnly };
  // The registry's own gate, in the engine too: an embedder calling the verb directly (not through
  // the registry, whose A24 map asks the same capability) still needs the owning capability.
  const capable = ctx.capabilities.assert(def.owningCapability);
  if (!capable.ok) return { refusal: capable };
  // D202 point 6 (owner, 15.11.2026): no mandatory reason. A reason given is kept as written (trimmed); none
  // is stored as ''. Only a reason that is not text is refused.
  if (input.reason !== undefined && input.reason !== null && typeof input.reason !== 'string') {
    return { refusal: err('invalid_input', { field: 'reason', reason: 'a reason is optional text' }) };
  }
  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  return { def, reason, idempotencyKey: input.idempotencyKey };
}

/**
 * D202: the PURE screen of a change, with no capability and no seat check: a key the registry knows, an
 * idempotency key, a reason that is text when given, and for a set a value that fits the schema and the
 * key's own rule (a reset is judged on the default it leaves in force). The transport seam runs it before it
 * routes or drafts an agent's call (`./agentAccess.ts`), so a Vorschlag that could only fail is never queued.
 */
export function screenSettingsChange(
  ctx: WorkspaceContext,
  verb: 'settings_set' | 'settings_reset',
  input: { key?: unknown; value?: unknown; reason?: unknown; idempotencyKey?: unknown },
): { def: SettingDef } | { refusal: Err } {
  if (typeof input.key !== 'string' || input.key.length === 0) return { refusal: err('invalid_input', { field: 'key' }) as Err };
  if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length === 0) {
    return { refusal: err('invalid_input', { field: 'idempotencyKey' }) as Err };
  }
  const def = settingDef(input.key);
  if (def === undefined) return { refusal: err('unknown_setting', { key: input.key }) as Err };
  if (input.reason !== undefined && input.reason !== null && typeof input.reason !== 'string') {
    return { refusal: err('invalid_input', { field: 'reason', reason: 'a reason is optional text' }) as Err };
  }
  if (verb === 'settings_set' && !valueFitsSchema(def.schema, input.value)) {
    return { refusal: err('invalid_setting_value', { key: def.key, value: input.value === undefined ? null : input.value, schema: def.schema }) as Err };
  }
  const judged = verb === 'settings_set' ? (input.value as SettingValue) : def.default;
  const refused = SETTING_RULES[def.key]?.refuse(ctx, def.key, judged) ?? null;
  if (refused !== null) return { refusal: refused };
  return { def };
}

/** D202 (I9): what a history row says about how a change came about. */
export interface ChangeProvenance {
  seat: 'person' | 'agent' | 'plugin' | 'system';
  via: 'direct' | 'vorschlag' | 'standing' | 'dial';
  approvedBy: string | null;
  draftedActionId: string | null;
  capability: string;
}

/**
 * D202 (I9): how THIS change came about, read at the moment it is written. A person's change is `direct`,
 * or `vorschlag` while the approval replay of a Vorschlag naming this key runs (`approvingActionIds`, the
 * D177 marker), with the approver and the Vorschlag named. The agent's change is `standing` when its area is
 * in the owner's live permission and the key is not protected (the route the transport seam took), else
 * `dial` (the dial of the key's family let it run). `capability` is what the change was checked against.
 */
function provenanceOf(ctx: WorkspaceContext, def: SettingDef): ChangeProvenance {
  const actor = ctx.actor;
  // Critic L6: a plugin call is a governed seat; what let its change run is the dial of the key's family.
  if (isPluginCallActor(actor)) return { seat: 'plugin', via: 'dial', approvedBy: null, draftedActionId: null, capability: `dial:${def.dialCapability}` };
  if (isSettingsAgentSeat(ctx, actor)) {
    const area = presentationOf(def.key, def.label).area;
    const standing = def.humanOnly !== true && (liveSettingsAreaGrant(ctx)?.areas.includes(area) ?? false);
    return standing
      ? { seat: 'agent', via: 'standing', approvedBy: null, draftedActionId: null, capability: `${SETTINGS_SECTIONS_KEY}:${area}` }
      : { seat: 'agent', via: 'dial', approvedBy: null, draftedActionId: null, capability: `dial:${def.dialCapability}` };
  }
  const seat = actor === 'system' ? 'system' : 'person';
  const drafted = approvedDraftFor(ctx, def.key);
  return drafted === null
    ? { seat, via: 'direct', approvedBy: null, draftedActionId: null, capability: def.owningCapability }
    : { seat, via: 'vorschlag', approvedBy: actor, draftedActionId: drafted, capability: def.owningCapability };
}

/** The Vorschlag of this workspace being approved right now whose payload names `key`, or null. */
function approvedDraftFor(ctx: WorkspaceContext, key: string): string | null {
  for (const id of approvingActionIds()) {
    const row = ctx.store.db
      .prepare("SELECT payload_json FROM agent_action WHERE workspace_id = ? AND id = ? AND action_tool IN ('settings_set', 'settings_reset')")
      .get(ctx.workspaceId, id) as { payload_json: string } | undefined;
    if (row === undefined) continue;
    try {
      const payload = JSON.parse(row.payload_json) as { key?: unknown };
      if (payload.key === key) return id;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * D202 critic L3: the answer a change would give when it changes NOTHING (a reset of a setting that holds no
 * override, a set to the value already in force), or null when it would change something. The same rule
 * `applyChange` applies, read without writing, so the agent's no-op is answered `unchanged` and never queued as
 * a Vorschlag (nor counted against the open cap).
 */
export function unchangedAnswer(ctx: WorkspaceContext, def: SettingDef, verb: 'settings_set' | 'settings_reset', value: unknown): SettingsSetOk | null {
  const row = storedRow(ctx, def.key);
  const before = storedValue(def, row);
  const previousValue = before ?? def.default;
  const unchanged =
    verb === 'settings_reset'
      ? row === undefined
      : before !== undefined
        ? before === value
        : row === undefined && value === def.default && def.askFirst !== true;
  return unchanged ? { key: def.key, value: previousValue, previousValue, overridden: before !== undefined, changed: false, changeId: null } : null;
}

/** Writes the row change, the history row and the audit-chain row; runs inside the memo transaction. */
function applyChange(
  ctx: WorkspaceContext,
  def: SettingDef,
  kind: 'set' | 'reset',
  next: SettingValue | undefined,
  reason: string,
): SettingsSetOk {
  const row = storedRow(ctx, def.key);
  const before = storedValue(def, row);
  const previousValue = before ?? def.default;
  // A reset of a setting that holds no override, or a set to the override already in force, is a no-op.
  // A set to the DEFAULT value while no override exists is a no-op too; while an override exists, a set
  // to the default value stores it explicitly (a person pinned the value, a later default change in a
  // new build will not move it), which is the difference between set and reset.
  const unchanged =
    kind === 'reset'
      ? row === undefined
      : before !== undefined
        ? before === next
        : // A41: answering an ask-first setting with its suggestion IS an answer, so it is stored.
          row === undefined && next === def.default && def.askFirst !== true;
  if (unchanged) {
    return { key: def.key, value: previousValue, previousValue, overridden: before !== undefined, changed: false, changeId: null };
  }
  const now = ctx.clock.now();
  if (kind === 'set') {
    ctx.store.db
      .prepare(
        `INSERT INTO workspace_setting (workspace_id, key, value_json, updated_at, updated_by) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(workspace_id, key) DO UPDATE SET value_json = excluded.value_json,
           updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      )
      .run(ctx.workspaceId, def.key, JSON.stringify(next), now, ctx.actor);
  } else {
    ctx.store.db.prepare('DELETE FROM workspace_setting WHERE workspace_id = ? AND key = ?').run(ctx.workspaceId, def.key);
  }
  const changeId = ctx.ids.next('wsc');
  const how = provenanceOf(ctx, def);
  ctx.store.db
    .prepare(
      `INSERT INTO workspace_setting_change
         (id, workspace_id, key, kind, old_value_json, new_value_json, reason, actor, at, seat, via, approved_by, drafted_action_id, capability)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      changeId,
      ctx.workspaceId,
      def.key,
      kind,
      row === undefined ? null : row.value_json,
      kind === 'set' ? JSON.stringify(next) : null,
      reason,
      ctx.actor,
      now,
      how.seat,
      how.via,
      how.approvedBy,
      how.draftedActionId,
      how.capability,
    );
  // The chain row says THAT the setting changed (`update`, the generic change word the audit vocabulary
  // already carries); the history row above says set or reset, from what to what, and why.
  ctx.audit.record({ entityKind: 'workspace_setting', entityId: def.key, action: 'update', actor: ctx.actor, at: now });
  // The key's own consequence, in this same transaction (a replay never reaches here, and an unchanged
  // value returned above): for the Belegnummer, the owed catch-up when numbering is on again.
  SETTING_RULES[def.key]?.afterChange(ctx);
  const value = kind === 'set' ? (next as SettingValue) : def.default;
  return { key: def.key, value, previousValue, overridden: kind === 'set', changed: true, changeId };
}

/**
 * Change one setting. `value` must fit the key's schema exactly (`invalid_setting_value`); `reason` is
 * optional (D202); the owning capability is required (`permission_denied`).
 */
export function settingsSet(ctx: WorkspaceContext, input: SettingsSetInput): Result<SettingsSetOk> {
  const v = validateChange(ctx, input);
  if ('refusal' in v) return v.refusal;
  const { def, reason, idempotencyKey } = v;
  const replayed = ctx.store.recallIdempotent<Result<SettingsSetOk>>(ctx.workspaceId, idempotencyKey, 'settings_set');
  if (replayed !== undefined) return replayed;
  if (!valueFitsSchema(def.schema, input.value)) {
    return err('invalid_setting_value', { key: def.key, value: input.value === undefined ? null : input.value, schema: def.schema });
  }
  const next = input.value;
  const refused = SETTING_RULES[def.key]?.refuse(ctx, def.key, next) ?? null;
  if (refused !== null) return refused;
  return ctx.store.rememberIdempotent(ctx.workspaceId, idempotencyKey, 'settings_set', () =>
    ok<SettingsSetOk>(applyChange(ctx, def, 'set', next, reason)),
  );
}

/** Return one setting to its registry default (removes the override). Reason optional (D202). */
export function settingsReset(ctx: WorkspaceContext, input: SettingsResetInput): Result<SettingsSetOk> {
  const v = validateChange(ctx, input);
  if ('refusal' in v) return v.refusal;
  const { def, reason, idempotencyKey } = v;
  // A replay answers the stored result before any rule re-judges a state that has moved since (the order
  // `settingsSet` keeps); a reset leaves the default in force, so that is the value a rule judges.
  const replayed = ctx.store.recallIdempotent<Result<SettingsSetOk>>(ctx.workspaceId, idempotencyKey, 'settings_reset');
  if (replayed !== undefined) return replayed;
  const refused = SETTING_RULES[def.key]?.refuse(ctx, def.key, def.default) ?? null;
  if (refused !== null) return refused;
  return ctx.store.rememberIdempotent(ctx.workspaceId, idempotencyKey, 'settings_reset', () =>
    ok<SettingsSetOk>(applyChange(ctx, def, 'reset', undefined, reason)),
  );
}

// --- D202 point 6: the history reader --------------------------------------------------------------------

export interface SettingsHistoryInput {
  key?: unknown;
  area?: unknown;
  limit?: unknown;
  /** The `nextBefore` of the previous page: the id of the last row it answered. */
  before?: unknown;
}

/** One change as `settings_history` answers it. */
export interface SettingChangeView {
  id: string;
  key: string;
  kind: 'set' | 'reset';
  /** The value before and after (null: the default was in force, or the reset removed the override). */
  oldValue: SettingValue | null;
  newValue: SettingValue | null;
  actor: string;
  /** Null on a row written before D202 (unknown, never claimed). */
  seat: ChangeProvenance['seat'] | null;
  via: ChangeProvenance['via'] | null;
  approvedBy: string | null;
  /** Who drafted the Vorschlag a person approved (`via: vorschlag`). */
  proposedBy: string | null;
  draftedActionId: string | null;
  capability: string | null;
  /** The reason as written; null when none was given. */
  reason: string | null;
  at: string;
}

export type SettingsHistoryOk = { changes: SettingChangeView[]; nextBefore: string | null };

export const SETTINGS_HISTORY_DEFAULT_LIMIT = 50;
export const SETTINGS_HISTORY_MAX_LIMIT = 200;

function parsedValue(json: string | null): SettingValue | null {
  if (json === null) return null;
  try {
    const v = JSON.parse(json) as unknown;
    return typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string' ? v : null;
  } catch {
    return null;
  }
}

interface ChangeRow {
  id: string;
  key: string;
  kind: 'set' | 'reset';
  old_value_json: string | null;
  new_value_json: string | null;
  reason: string;
  actor: string;
  at: string;
  seat: ChangeProvenance['seat'] | null;
  via: ChangeProvenance['via'] | null;
  approved_by: string | null;
  drafted_action_id: string | null;
  capability: string | null;
  proposed_by: string | null;
}

/**
 * Who changed which setting, from what to what, when, how and under which permission: the append-only
 * `workspace_setting_change` rows, newest first, for one key, one area or the whole workspace. Paged by the
 * row before which to continue (`before`, the previous page's `nextBefore`). A pure read, tenant-scoped
 * (§H-TENANT): every statement names `ctx.workspaceId`, the Vorschlag join included.
 */
export function settingsHistory(ctx: WorkspaceContext, input: SettingsHistoryInput): Result<SettingsHistoryOk> {
  const capable = ctx.capabilities.assert('read_master_data');
  if (!capable.ok) return capable;
  let keys: string[] | null = null;
  if (input.key !== undefined && input.key !== null) {
    if (typeof input.key !== 'string' || input.key.length === 0) return err('invalid_input', { field: 'key' });
    if (settingDef(input.key) === undefined) return err('unknown_setting', { key: input.key });
    keys = [input.key];
  }
  if (input.area !== undefined && input.area !== null) {
    if (typeof input.area !== 'string' || !SETTINGS_AREA_DEFS.some((a) => a.id === input.area)) {
      return err('invalid_input', { field: 'area', allowed: SETTINGS_AREA_DEFS.map((a) => a.id) });
    }
    const inArea = SETTINGS.filter((d) => presentationOf(d.key, d.label).area === input.area).map((d) => d.key);
    keys = keys === null ? inArea : keys.filter((k) => inArea.includes(k));
  }
  let limit = SETTINGS_HISTORY_DEFAULT_LIMIT;
  if (input.limit !== undefined && input.limit !== null) {
    if (typeof input.limit !== 'number' || !Number.isInteger(input.limit) || input.limit < 1 || input.limit > SETTINGS_HISTORY_MAX_LIMIT) {
      return err('invalid_input', { field: 'limit', min: 1, max: SETTINGS_HISTORY_MAX_LIMIT });
    }
    limit = input.limit;
  }
  const where: string[] = ['c.workspace_id = ?'];
  const params: unknown[] = [ctx.workspaceId];
  if (input.before !== undefined && input.before !== null) {
    if (typeof input.before !== 'string' || input.before.length === 0) return err('invalid_input', { field: 'before' });
    const anchor = ctx.store.db
      .prepare('SELECT at, id FROM workspace_setting_change WHERE workspace_id = ? AND id = ?')
      .get(ctx.workspaceId, input.before) as { at: string; id: string } | undefined;
    if (anchor === undefined) return err('invalid_input', { field: 'before', reason: 'not a change of this workspace' });
    where.push('(c.at < ? OR (c.at = ? AND c.id < ?))');
    params.push(anchor.at, anchor.at, anchor.id);
  }
  if (keys !== null && keys.length === 0) return ok<SettingsHistoryOk>({ changes: [], nextBefore: null });
  if (keys !== null) {
    where.push(`c.key IN (${keys.map(() => '?').join(', ')})`);
    params.push(...keys);
  }
  const rows = ctx.store.db
    .prepare(
      `SELECT c.id, c.key, c.kind, c.old_value_json, c.new_value_json, c.reason, c.actor, c.at,
              c.seat, c.via, c.approved_by, c.drafted_action_id, c.capability, a.actor AS proposed_by
         FROM workspace_setting_change c
         LEFT JOIN agent_action a ON a.workspace_id = c.workspace_id AND a.id = c.drafted_action_id
        WHERE ${where.join(' AND ')}
        ORDER BY c.at DESC, c.id DESC
        LIMIT ?`,
    )
    .all(...params, limit + 1) as ChangeRow[];
  const page = rows.slice(0, limit);
  const changes: SettingChangeView[] = page.map((r) => ({
    id: r.id,
    key: r.key,
    kind: r.kind,
    oldValue: parsedValue(r.old_value_json),
    newValue: parsedValue(r.new_value_json),
    actor: r.actor,
    seat: r.seat,
    via: r.via,
    approvedBy: r.approved_by,
    proposedBy: r.proposed_by,
    draftedActionId: r.drafted_action_id,
    capability: r.capability,
    reason: r.reason.length > 0 ? r.reason : null,
    at: r.at,
  }));
  return ok<SettingsHistoryOk>({ changes, nextBefore: rows.length > limit ? (page[page.length - 1]?.id ?? null) : null });
}
