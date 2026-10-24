/**
 * D178 point 7, THE PER-PERSON PREFERENCE DEF: the shape every area file under `prefDefs/` declares.
 *
 * Types only, in a file of their own, so an area file (`appearance.ts`, and the ones later nodes add)
 * imports the shape without importing the aggregate, and the aggregate imports the area files without a
 * cycle. Nothing here runs.
 *
 * THE SCHEMA SHAPES ARE D172's, REUSED VERBATIM (`SettingSchema` from the workspace settings registry):
 * integer and number with inclusive bounds, boolean, string with a maximum length, enum of at least two
 * values. A preference adds ONE shape the workspace registry has no use for: `json`, structured state such
 * as an ordered list of rail rows or a set of column widths, bounded by size and by its root type.
 */

import type { LocalisedText, SettingSchema } from '../../settings/registry.js';

export type { LocalisedText } from '../../settings/registry.js';

/** Structured state: an ordered list, a map of widths. Bounded by its serialised size and its root. */
export interface PrefJsonSchema {
  readonly type: 'json';
  /** The JSON root a value must have. */
  readonly root: 'array' | 'object';
  /** The largest serialised value, in UTF-8 bytes of `JSON.stringify(value)`. At most `MAX_PREF_JSON_BYTES`. */
  readonly maxBytes: number;
}

/** Every value shape a preference may declare: D172's five, plus `json`. */
export type PrefSchema = SettingSchema | PrefJsonSchema;

/** A JSON value, as the wire carries it. */
export type PrefJsonValue = null | boolean | number | string | readonly PrefJsonValue[] | { readonly [key: string]: PrefJsonValue };

/** A preference's value: a scalar for the D172 shapes, a JSON array or object for `json`. */
export type PrefValue = number | boolean | string | readonly PrefJsonValue[] | { readonly [key: string]: PrefJsonValue };

/**
 * WHERE A VALUE LIVES.
 *  - `person`: one value for this actor in every workspace of the book (a theme, a density). A
 *    Treuhänder switching mandates keeps their look.
 *  - `workspace`: one value per actor per workspace (the rail arrangement of one mandate, D178 point 6).
 */
export type PrefScope = 'person' | 'workspace';

export interface PrefArea {
  /** Lower case, the first segment of every key in the area. */
  readonly id: string;
  readonly label: LocalisedText;
}

export interface PrefDef {
  /** `<area>.<name>`, lower case, dotted. Never renamed once shipped: a stored row is addressed by it. */
  readonly key: string;
  readonly schema: PrefSchema;
  /** The decided rule (D172/D178). Must fit `schema` (asserted at load). */
  readonly default: PrefValue;
  readonly scope: PrefScope;
  readonly area: PrefArea;
  readonly label: LocalisedText;
  readonly description: LocalisedText;
  /** An `enum` only, and then required for EVERY value: a person picks "Dunkel", not `dark`. */
  readonly valueLabels?: Readonly<Record<string, LocalisedText>>;
}
