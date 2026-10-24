/**
 * D178 point 7, THE PER-PERSON PREFERENCE VERBS: `prefs_list`, `prefs_get`, `prefs_set`, `prefs_reset`.
 *
 * A preference belongs to ONE ACTOR, the saved-view rule (`./views.ts`): the owner is the session actor,
 * never an input field. No verb here takes an actor or a user id, and every statement is keyed by
 * `ctx.actor`, so "an actor reads and writes only its own preferences" holds by construction rather than
 * by a check somebody could forget to write. A personal saved view is the precedent; G00 spec §10.
 *
 * THE SCOPE RULE (spec §10.3). A def's `scope` decides the table:
 *  - `person` rows (`person_pref`) are keyed by (actor, key) and carry NO `workspace_id`: a theme follows
 *    the person across every mandate of the book. The tenant still gates the call (the actor must belong
 *    to the workspace it names), and the registry admits only look-and-arrangement defs at this scope.
 *  - `workspace` rows (`person_workspace_pref`) are keyed by (workspace, actor, key), §H-TENANT on every
 *    statement.
 *
 * ONE ROW PER OVERRIDE. A preference with no row reads its default; a stored value that no longer fits its
 * def (a later build narrowed it) reads as the default and is listed `stale`, so a read never throws.
 *
 * NO HISTORY, NO AUDIT ROW, NO IDEMPOTENCY KEY (spec §10.3). A preference changes nothing in the books and
 * nothing another person sees (the D160 `ui-state` exemption). Both writes are absolute setters: a set to
 * the value in force, or a reset with nothing stored, writes nothing, so a replay moves no row.
 *
 * ACCESS (spec §10.4). Ungated at the A24 boundary and asserted HERE: the caller must be a member of the
 * workspace (any role, a custom role with an empty bundle included), or the local operator on an
 * unprovisioned workspace. A plugin call runs as the member who installed it, so it may read but never
 * write that member's preferences (the `notifications_set_preference` ruling, critic N4).
 *
 * THE REGISTRY IS A PARAMETER (defaulting to the live one) so the suites can drive the `workspace` scope
 * and every schema shape through the real verbs before an area ships a def of that kind.
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { SERVED_STRANGER_ACTOR } from '../access/actors.js';
import { isProvisioned, memberFor } from '../access/capability.js';
import { isPluginCallActor } from '../plugins/callScope.js';
import {
  PREF_DEFS,
  assertPrefDefs,
  prefJsonProblem,
  prefValueFits,
  type LocalisedText,
  type PrefArea,
  type PrefDef,
  type PrefSchema,
  type PrefScope,
  type PrefValue,
} from './prefDefs/index.js';

/** What `prefs_list` and `prefs_get` say about one preference, for the calling actor. */
export type PrefView = {
  key: string;
  value: PrefValue;
  default: PrefValue;
  /** No stored value is in force: the default applies. */
  isDefault: boolean;
  /** A stored value exists but no longer fits the def, so it is ignored and the default applies. */
  stale: boolean;
  scope: PrefScope;
  schema: PrefSchema;
  area: PrefArea;
  label: LocalisedText;
  description: LocalisedText;
  /** An enum's per-value labels (en and de-CH); null for every other shape. */
  valueLabels: Readonly<Record<string, LocalisedText>> | null;
  updatedAt: string | null;
};

export type PrefsListOk = { prefs: PrefView[]; areas: PrefArea[] };
export type PrefsGetOk = { pref: PrefView };
export type PrefsSetOk = {
  key: string;
  value: PrefValue;
  previousValue: PrefValue;
  isDefault: boolean;
  changed: boolean;
};
export type PrefsResetOk = { reset: string[]; changed: boolean };

/** A registry the verbs read: the defs, by key, and the areas in order. Built and asserted once. */
export interface PrefRegistry {
  readonly defs: readonly PrefDef[];
  readonly byKey: ReadonlyMap<string, PrefDef>;
  readonly areas: readonly PrefArea[];
}

/** Build (and assert) a registry over `defs`. The live one is built once at module load. */
export function prefRegistry(defs: readonly PrefDef[]): PrefRegistry {
  assertPrefDefs(defs);
  const areas: PrefArea[] = [];
  for (const d of defs) if (!areas.some((a) => a.id === d.area.id)) areas.push(d.area);
  return { defs, byKey: new Map(defs.map((d) => [d.key, d])), areas };
}

const LIVE: PrefRegistry = prefRegistry(PREF_DEFS);

// --- the seat ---------------------------------------------------------------------------------------

/**
 * Membership, asserted in the engine (the verbs are `ungated(...)` at the boundary, spec §10.4). A
 * capability would be the wrong gate: a custom role with an empty bundle must still pick its own theme.
 * The order mirrors `capabilityFor`: the served stranger holds nothing; an unprovisioned workspace admits
 * the local operator who holds the file and nobody who came through the served door; otherwise the actor
 * must be an accepted member.
 */
function notOwnSeat(ctx: WorkspaceContext): Result<never> | undefined {
  const refused = err('permission_denied', { capability: null, role: null, reason: 'not_a_member' }) as Result<never>;
  if (ctx.actor === SERVED_STRANGER_ACTOR) return refused;
  if (!isProvisioned(ctx.store, ctx.workspaceId)) return ctx.identitySource === 'served_subject' ? refused : undefined;
  const member = memberFor(ctx.store, ctx.workspaceId, ctx.actor);
  return member !== undefined && member.accepted ? undefined : refused;
}

/** A plugin call carries its installer's actor: it has no preferences of its own to change. */
function pluginWrite(ctx: WorkspaceContext): Result<never> | undefined {
  return isPluginCallActor(ctx.actor) ? (err('capability_forbidden', { reason: 'needs_a_person' }) as Result<never>) : undefined;
}

// --- the stored rows --------------------------------------------------------------------------------

interface StoredRow {
  key: string;
  value_json: string;
  updated_at: string;
}

function storedRow(ctx: WorkspaceContext, def: PrefDef): StoredRow | undefined {
  return def.scope === 'person'
    ? (ctx.store.db
        .prepare('SELECT key, value_json, updated_at FROM person_pref WHERE actor = ? AND key = ?')
        .get(ctx.actor, def.key) as StoredRow | undefined)
    : (ctx.store.db
        .prepare('SELECT key, value_json, updated_at FROM person_workspace_pref WHERE workspace_id = ? AND actor = ? AND key = ?')
        .get(ctx.workspaceId, ctx.actor, def.key) as StoredRow | undefined);
}

/** Every stored row of this actor that a list may read, by scope: two indexed reads, never one per def. */
function storedRows(ctx: WorkspaceContext): { person: Map<string, StoredRow>; workspace: Map<string, StoredRow> } {
  const person = ctx.store.db.prepare('SELECT key, value_json, updated_at FROM person_pref WHERE actor = ?').all(ctx.actor) as StoredRow[];
  const workspace = ctx.store.db
    .prepare('SELECT key, value_json, updated_at FROM person_workspace_pref WHERE workspace_id = ? AND actor = ?')
    .all(ctx.workspaceId, ctx.actor) as StoredRow[];
  return { person: new Map(person.map((r) => [r.key, r])), workspace: new Map(workspace.map((r) => [r.key, r])) };
}

/** The stored value when it parses and fits the def; undefined otherwise (the default applies). */
function storedValue(def: PrefDef, row: StoredRow | undefined): PrefValue | undefined {
  if (row === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.value_json);
  } catch {
    return undefined;
  }
  return prefValueFits(def.schema, parsed) ? parsed : undefined;
}

/** Key order is not meaning: two JSON objects with the same members are the same preference. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sameValue(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}

function viewOf(def: PrefDef, row: StoredRow | undefined): PrefView {
  const stored = storedValue(def, row);
  return {
    key: def.key,
    value: stored ?? def.default,
    default: def.default,
    isDefault: stored === undefined,
    stale: row !== undefined && stored === undefined,
    scope: def.scope,
    schema: def.schema,
    area: def.area,
    label: def.label,
    description: def.description,
    valueLabels: def.valueLabels ?? null,
    updatedAt: stored === undefined ? null : (row?.updated_at ?? null),
  };
}

// --- the humanised refusals -------------------------------------------------------------------------

/** Edit distance, for the "did you mean" an agent gets with an unknown key. Keys are short. */
function distance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let diag = prev[0] ?? 0;
    prev[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const up = prev[j] ?? 0;
      prev[j] = Math.min(up + 1, (prev[j - 1] ?? 0) + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = up;
    }
  }
  return prev[b.length] ?? 0;
}

/** The known key a caller most likely meant: the bare name of a key, else the nearest by edit distance. */
export function suggestPrefKey(input: string, registry: PrefRegistry = LIVE): string | null {
  const keys = registry.defs.map((d) => d.key);
  const byName = keys.find((k) => k.endsWith(`.${input}`));
  if (byName !== undefined) return byName;
  let best: string | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const k of keys) {
    const score = distance(input, k);
    if (score < bestScore) {
      best = k;
      bestScore = score;
    }
  }
  return best !== null && bestScore <= Math.max(2, Math.floor(best.length / 3)) ? best : null;
}

function unknownPref(key: string, registry: PrefRegistry): Result<never> {
  return err('unknown_pref', {
    key,
    suggestion: suggestPrefKey(key, registry),
    known: registry.defs.map((d) => d.key),
  }) as Result<never>;
}

function resolveDef(input: { key?: unknown }, registry: PrefRegistry): { def: PrefDef } | { refusal: Result<never> } {
  if (typeof input.key !== 'string' || input.key.length === 0) return { refusal: err('invalid_input', { field: 'key' }) as Result<never> };
  const def = registry.byKey.get(input.key);
  return def === undefined ? { refusal: unknownPref(input.key, registry) } : { def };
}

// --- the verbs --------------------------------------------------------------------------------------

/** Every preference of the calling actor (optionally one area), with its value, default and texts. */
export function prefsList(ctx: WorkspaceContext, input: { area?: unknown } = {}, registry: PrefRegistry = LIVE): Result<PrefsListOk> {
  const seat = notOwnSeat(ctx);
  if (seat !== undefined) return seat;
  let defs = registry.defs;
  if (input.area !== undefined) {
    if (typeof input.area !== 'string' || input.area.length === 0) return err('invalid_input', { field: 'area' });
    const area = input.area;
    if (!registry.areas.some((a) => a.id === area)) {
      return err('unknown_pref_area', { area, known: registry.areas.map((a) => a.id) });
    }
    defs = defs.filter((d) => d.area.id === area);
  }
  const rows = storedRows(ctx);
  const prefs = defs.map((d) => viewOf(d, (d.scope === 'person' ? rows.person : rows.workspace).get(d.key)));
  const areas = registry.areas.filter((a) => defs.some((d) => d.area.id === a.id));
  return ok<PrefsListOk>({ prefs, areas });
}

/** One preference of the calling actor. An unknown key is refused with the key it most likely meant. */
export function prefsGet(ctx: WorkspaceContext, input: { key?: unknown }, registry: PrefRegistry = LIVE): Result<PrefsGetOk> {
  const seat = notOwnSeat(ctx);
  if (seat !== undefined) return seat;
  const resolved = resolveDef(input, registry);
  if ('refusal' in resolved) return resolved.refusal;
  return ok<PrefsGetOk>({ pref: viewOf(resolved.def, storedRow(ctx, resolved.def)) });
}

export interface PrefsSetInput {
  key?: unknown;
  value?: unknown;
}

/**
 * Set one preference of the calling actor. The value must fit the def's schema exactly
 * (`invalid_pref_value`, naming the schema and, for `json`, why). A set to the value in force writes
 * nothing; while no value is stored, a set to the default is that case.
 */
export function prefsSet(ctx: WorkspaceContext, input: PrefsSetInput, registry: PrefRegistry = LIVE): Result<PrefsSetOk> {
  const seat = notOwnSeat(ctx);
  if (seat !== undefined) return seat;
  const resolved = resolveDef(input, registry);
  if ('refusal' in resolved) return resolved.refusal;
  const def = resolved.def;
  const plugin = pluginWrite(ctx);
  if (plugin !== undefined) return plugin;
  if (!('value' in input) || input.value === undefined) return err('invalid_input', { field: 'value' });
  const next = input.value;
  if (!prefValueFits(def.schema, next)) {
    const reason = def.schema.type === 'json' ? prefJsonProblem(def.schema, next) : 'does_not_fit';
    return err('invalid_pref_value', { key: def.key, value: next, schema: def.schema, reason: reason ?? 'does_not_fit' });
  }
  return ctx.store.tx(() => {
    const row = storedRow(ctx, def);
    const before = storedValue(def, row);
    const previousValue = before ?? def.default;
    const unchanged = before !== undefined ? sameValue(before, next) : row === undefined && sameValue(next, def.default);
    if (unchanged) {
      return ok<PrefsSetOk>({ key: def.key, value: previousValue, previousValue, isDefault: before === undefined, changed: false });
    }
    const now = ctx.clock.now();
    const json = JSON.stringify(next);
    if (def.scope === 'person') {
      ctx.store.db
        .prepare(
          `INSERT INTO person_pref (actor, key, value_json, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(actor, key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
        )
        .run(ctx.actor, def.key, json, now);
    } else {
      ctx.store.db
        .prepare(
          `INSERT INTO person_workspace_pref (workspace_id, actor, key, value_json, updated_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(workspace_id, actor, key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
        )
        .run(ctx.workspaceId, ctx.actor, def.key, json, now);
    }
    return ok<PrefsSetOk>({ key: def.key, value: next as PrefValue, previousValue, isDefault: false, changed: true });
  });
}

export interface PrefsResetInput {
  key?: unknown;
  area?: unknown;
}

/**
 * Return one preference, or every preference of one area, to its default by removing the calling actor's
 * stored values. Exactly one of `key` and `area`. A reset with nothing stored writes nothing.
 */
export function prefsReset(ctx: WorkspaceContext, input: PrefsResetInput, registry: PrefRegistry = LIVE): Result<PrefsResetOk> {
  const seat = notOwnSeat(ctx);
  if (seat !== undefined) return seat;
  const hasKey = input.key !== undefined;
  const hasArea = input.area !== undefined;
  if (hasKey === hasArea) return err('invalid_input', { field: hasKey ? 'area' : 'key', reason: 'exactly_one_of_key_or_area' });
  let defs: readonly PrefDef[];
  if (hasKey) {
    const resolved = resolveDef(input, registry);
    if ('refusal' in resolved) return resolved.refusal;
    defs = [resolved.def];
  } else {
    if (typeof input.area !== 'string' || input.area.length === 0) return err('invalid_input', { field: 'area' });
    const area = input.area;
    if (!registry.areas.some((a) => a.id === area)) {
      return err('unknown_pref_area', { area, known: registry.areas.map((a) => a.id) });
    }
    defs = registry.defs.filter((d) => d.area.id === area);
  }
  const plugin = pluginWrite(ctx);
  if (plugin !== undefined) return plugin;
  return ctx.store.tx(() => {
    const reset: string[] = [];
    for (const def of defs) {
      const removed =
        def.scope === 'person'
          ? ctx.store.db.prepare('DELETE FROM person_pref WHERE actor = ? AND key = ?').run(ctx.actor, def.key).changes
          : ctx.store.db
              .prepare('DELETE FROM person_workspace_pref WHERE workspace_id = ? AND actor = ? AND key = ?')
              .run(ctx.workspaceId, ctx.actor, def.key).changes;
      if (removed > 0) reset.push(def.key);
    }
    return ok<PrefsResetOk>({ reset, changed: reset.length > 0 });
  });
}
