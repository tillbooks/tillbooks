/**
 * D172, the workspace settings verbs and the typed accessor every capability reads a setting through.
 *
 * READS ARE CHEAP: `getSetting` is one primary-key lookup, no capability check (the caller already
 * passed its own) and no audit. A missing row is the registry default; a stored value that no longer
 * fits the key's schema (a bound tightened in a later build) is the default too, so a read never throws
 * and never hands a caller a value the registry would refuse.
 *
 * EVERY CHANGE IS AUDITED AND IDEMPOTENT ON ROWS. `settings_set` and `settings_reset` require a reason,
 * write the row (or remove it, for a reset), append one `workspace_setting_change` row naming the old
 * value, the new value, the actor and the reason, and append one A03 audit-chain row, all in ONE
 * transaction under the call's idempotency key: a replay answers the stored result and writes nothing.
 * A set to the value already in force, or a reset of a setting that holds no override, changes nothing
 * and records nothing (`changed: false`), so a person pressing Save twice does not grow the history.
 *
 * §H-TENANT: every statement is scoped by `ctx.workspaceId`.
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Err, Result } from '../result.js';
import { afterBelegnummerSettingChange, refuseBelegnummerSetting } from '../ledger/entryNumber.js';
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
};

export type SettingsListOk = { settings: SettingView[] };
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

function viewOf(ctx: WorkspaceContext, def: SettingDef): SettingView {
  const row = storedRow(ctx, def.key);
  const stored = storedValue(def, row);
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
    updatedAt: row?.updated_at ?? null,
    updatedBy: row?.updated_by ?? null,
    stale: row !== undefined && stored === undefined,
    ignoredStoredValue: row !== undefined && stored === undefined ? row.value_json : null,
  };
}

export function settingsList(ctx: WorkspaceContext): Result<SettingsListOk> {
  const capable = ctx.capabilities.assert('read_master_data');
  if (!capable.ok) return capable;
  return ok<SettingsListOk>({ settings: SETTINGS.map((def) => viewOf(ctx, def)) });
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

const SETTING_RULES: Readonly<Record<string, SettingRule>> = {
  'ledger.belegnummer_mode': BELEGNUMMER_RULE,
  'ledger.belegnummer_start': BELEGNUMMER_RULE,
  'ledger.belegnummer_prefix': BELEGNUMMER_RULE,
  'ledger.belegnummer_split_voucher': BELEGNUMMER_RULE,
};

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
  // The registry's own gate, in the engine too: an embedder calling the verb directly (not through
  // the registry, whose A24 map asks the same capability) still needs the owning capability.
  const capable = ctx.capabilities.assert(def.owningCapability);
  if (!capable.ok) return { refusal: capable };
  if (typeof input.reason !== 'string' || input.reason.trim().length === 0) {
    return { refusal: err('reason_required', { field: 'reason' }) };
  }
  return { def, reason: input.reason.trim(), idempotencyKey: input.idempotencyKey };
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
        : row === undefined && next === def.default;
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
  ctx.store.db
    .prepare(
      `INSERT INTO workspace_setting_change (id, workspace_id, key, kind, old_value_json, new_value_json, reason, actor, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
 * required (`reason_required`); the owning capability is required (`permission_denied`).
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

/** Return one setting to its registry default (removes the override). Reason required. */
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
