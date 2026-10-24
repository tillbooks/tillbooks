/**
 * D178 point 7, THE PER-PERSON PREFERENCE REGISTRY: every preference a person can set for themselves.
 *
 * The owner's rule (D178, 21.10.2026): every option presented is a setting, pure looks included.
 * Workspace behaviour lives in D172's registry (`core/settings/registry.ts`); a choice that belongs to ONE
 * PERSON lives here. The verbs (`prefs_list`, `prefs_get`, `prefs_set`, `prefs_reset`, `../prefs.ts`), the
 * Studio's `usePref` hook and the Meine Einstellungen page all derive from a def; nothing else is edited.
 *
 * ONE FILE PER AREA, ONE LINE HERE. An area (`appearance`, and later the rail and the bank columns) keeps
 * its defs in `prefDefs/<area>.ts` and joins the aggregate below with one spread line, so concurrent
 * capability branches collide over a line rather than inside each other's lists.
 *
 * PURE, AND THAT IS LOAD-BEARING. This module and everything it imports is data plus pure checks, with no
 * Node dependency: the Studio imports it AT RUNTIME for the defaults it renders before the first
 * `prefs_list` answers (the `entities.ts` precedent), so the default on screen and the default the engine
 * answers are one implementation and never a mirror. `test/style/studio-sees-payloads.test.mjs` fails the
 * build if anything the Studio pulls in reaches a Node builtin.
 *
 * Module load ASSERTS the registry, the D172 idiom: a malformed def is a crash on import, not a runtime
 * surprise on somebody's settings page.
 */

import { valueFitsSchema } from '../../settings/registry.js';
import { APPEARANCE_PREFS } from './appearance.js';
import { ATTENTION_PREFS } from './attention.js';
import { NAV_PREFS } from './nav.js';
import { BANK_PREFS } from './bank.js';
import { MOTION_PREFS, OVERVIEW_PREFS } from './overview.js';
import type { LocalisedText, PrefArea, PrefDef, PrefJsonSchema, PrefSchema, PrefScope, PrefValue } from './types.js';

export type {
  LocalisedText,
  PrefArea,
  PrefDef,
  PrefJsonSchema,
  PrefJsonValue,
  PrefSchema,
  PrefScope,
  PrefValue,
} from './types.js';

/** The largest `json` preference a def may declare, in UTF-8 bytes of its serialised value. */
export const MAX_PREF_JSON_BYTES = 16384;

/** How deep a `json` value may nest. Deeper is refused rather than walked: no def needs it. */
export const MAX_PREF_JSON_DEPTH = 16;

/** The two scopes (§H-ENUM, owned here). */
export const PREF_SCOPES: readonly PrefScope[] = ['person', 'workspace'];

/**
 * THE REGISTRY. One spread line per area file; append, never reorder (Meine Einstellungen shows the areas
 * and the defs inside each in this order).
 */
export const PREF_DEFS: readonly PrefDef[] = [
  // D178 point 7: the colour scheme and the density (E0).
  ...APPEARANCE_PREFS,
  // D178 point 11: how Pendenzen is cut, by area or by kind (N4).
  ...ATTENTION_PREFS,
  // D178 points 6, 7 and 15 to 17: the rail's looks and its per-workspace arrangement (N6).
  ...NAV_PREFS,
  // D178 point 10: where the /bank detail area sits and how big it is (N2).
  ...BANK_PREFS,
  // D178 point 14: the motion level, shown in the Darstellung area (N5).
  ...MOTION_PREFS,
  // D178 points 12 and 13: the Übersicht's bank action, content and widget arrangement (N5).
  ...OVERVIEW_PREFS,
];

const KEY_SHAPE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const AREA_SHAPE = /^[a-z][a-z0-9_]*$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/** True for a value the JSON wire can carry unchanged: no `undefined`, no NaN, no class instance. */
function isJsonSafe(value: unknown, depth = 0): boolean {
  if (depth > MAX_PREF_JSON_DEPTH) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((v) => isJsonSafe(v, depth + 1));
  if (isPlainObject(value)) return Object.values(value).every((v) => isJsonSafe(v, depth + 1));
  return false;
}

/** The serialised size of a value, in UTF-8 bytes. `TextEncoder` exists in Node and in every browser. */
export function prefJsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

/** Why a value does not fit a `json` schema, or undefined when it does. */
export function prefJsonProblem(schema: PrefJsonSchema, value: unknown): 'wrong_root' | 'not_json' | 'too_large' | undefined {
  if (schema.root === 'array' ? !Array.isArray(value) : !isPlainObject(value)) return 'wrong_root';
  if (!isJsonSafe(value)) return 'not_json';
  if (prefJsonBytes(value) > schema.maxBytes) return 'too_large';
  return undefined;
}

/** Whether `value` satisfies `schema` exactly (no coercion: `'1'` is not the integer 1). */
export function prefValueFits(schema: PrefSchema, value: unknown): value is PrefValue {
  if (schema.type === 'json') return prefJsonProblem(schema, value) === undefined;
  return valueFitsSchema(schema, value);
}

function hasBothTexts(text: LocalisedText | undefined): boolean {
  return text !== undefined && typeof text.en === 'string' && typeof text['de-CH'] === 'string' && text.en.trim() !== '' && text['de-CH'].trim() !== '';
}

function sameText(a: LocalisedText, b: LocalisedText): boolean {
  return a.en === b.en && a['de-CH'] === b['de-CH'];
}

/** Throws on a malformed registry; runs at module load and is exported for the guard suite. */
export function assertPrefDefs(rows: readonly PrefDef[]): void {
  const seen = new Set<string>();
  const areaLabels = new Map<string, LocalisedText>();
  for (const d of rows) {
    const where = `preference registry: '${d.key}'`;
    if (!KEY_SHAPE.test(d.key)) throw new Error(`${where} is not <area>.<name> in lower case`);
    if (seen.has(d.key)) throw new Error(`${where} is registered twice`);
    seen.add(d.key);
    if (!AREA_SHAPE.test(d.area.id)) throw new Error(`${where} names the malformed area id '${d.area.id}'`);
    if (!d.key.startsWith(`${d.area.id}.`)) throw new Error(`${where} does not start with its area id '${d.area.id}.'`);
    if (!(PREF_SCOPES as readonly string[]).includes(d.scope)) throw new Error(`${where} names the unknown scope '${String(d.scope)}'`);
    const schema = d.schema;
    if (schema.type === 'json') {
      if (schema.root !== 'array' && schema.root !== 'object') throw new Error(`${where}: a json root is 'array' or 'object'`);
      if (!Number.isInteger(schema.maxBytes) || schema.maxBytes < 2 || schema.maxBytes > MAX_PREF_JSON_BYTES) {
        throw new Error(`${where}: maxBytes must be an integer from 2 to ${MAX_PREF_JSON_BYTES}`);
      }
    }
    if ((schema.type === 'integer' || schema.type === 'number') && !(schema.min <= schema.max)) {
      throw new Error(`${where}: min is above max`);
    }
    if (schema.type === 'string' && (!Number.isInteger(schema.maxLength) || schema.maxLength < 1)) {
      throw new Error(`${where}: maxLength must be a positive integer`);
    }
    if (schema.type === 'enum') {
      if (schema.values.length < 2) throw new Error(`${where}: an enum needs at least two values (one value is not a choice)`);
      if (new Set(schema.values).size !== schema.values.length) throw new Error(`${where}: an enum value is listed twice`);
      const labels = d.valueLabels;
      if (labels === undefined) throw new Error(`${where}: an enum needs a valueLabels entry for every value`);
      for (const v of schema.values) {
        if (!hasBothTexts(labels[v])) throw new Error(`${where}: the enum value '${v}' lacks an en or de-CH label`);
      }
      for (const k of Object.keys(labels)) {
        if (!schema.values.includes(k)) throw new Error(`${where}: valueLabels names '${k}', which is not one of its values`);
      }
    } else if (d.valueLabels !== undefined) {
      throw new Error(`${where}: valueLabels is for an enum only`);
    }
    if (!prefValueFits(schema, d.default)) {
      throw new Error(`${where}: the default ${JSON.stringify(d.default)} does not fit its schema`);
    }
    for (const text of [d.label, d.description, d.area.label]) {
      if (!hasBothTexts(text)) throw new Error(`${where} lacks an en or de-CH text`);
    }
    const known = areaLabels.get(d.area.id);
    if (known === undefined) areaLabels.set(d.area.id, d.area.label);
    else if (!sameText(known, d.area.label)) throw new Error(`${where}: the area '${d.area.id}' carries two different labels`);
  }
}

assertPrefDefs(PREF_DEFS);

const BY_KEY: ReadonlyMap<string, PrefDef> = new Map(PREF_DEFS.map((d) => [d.key, d]));

/** The def for `key`, or undefined for a key this build does not know. */
export function prefDef(key: unknown): PrefDef | undefined {
  return typeof key === 'string' ? BY_KEY.get(key) : undefined;
}

/** The areas, each once, in registry order. */
export const PREF_AREAS: readonly PrefArea[] = (() => {
  const out: PrefArea[] = [];
  for (const d of PREF_DEFS) if (!out.some((a) => a.id === d.area.id)) out.push(d.area);
  return out;
})();

/** The default of `key` in this build, or undefined for an unknown key. */
export function prefDefault(key: string): PrefValue | undefined {
  return BY_KEY.get(key)?.default;
}
