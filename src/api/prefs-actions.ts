/**
 * D178 point 7, the per-person preference registry's four verbs (two reads, two writes), defined here and
 * spread into `ACTIONS` as ONE line (the `settingsActions` precedent), so several agents appending to the
 * append-only registry at once collide over a line rather than a block.
 *
 * Every preference is a def of `src/core/customization/prefDefs/`; these verbs are generic over it. A
 * preference belongs to the CALLING SEAT: no verb takes an actor, so a person (or the agent seat) reads and
 * writes only its own. Membership is asserted in the engine (`ungated(...)` at the A24 boundary, the
 * `notifications_set_preference` shape): every member, viewer included, sets their own look.
 *
 * The writes are `reversible:ui-state` (D160.2, the person's own UI state) and take no idempotency key:
 * both are absolute setters, and a set to the value in force or a reset with nothing stored writes nothing.
 */

import type { ActionDef, ActionInput, JsonSchema } from './registry.js';
import type { WorkspaceContext } from '../core/context.js';
import type { Result } from '../core/result.js';
import { prefsGet, prefsList, prefsReset, prefsSet } from '../core/customization/index.js';
import type { ActionKind } from './actionKind.js';

export interface PrefsActionHelpers {
  ctxAction(
    name: string,
    kind: ActionKind,
    summary: string,
    inputSchema: JsonSchema,
    call: (ctx: WorkspaceContext, input: ActionInput) => Result,
  ): ActionDef;
  ctxSchema(props?: Record<string, unknown>, required?: string[]): JsonSchema;
  STR: { readonly type: 'string' };
}

/**
 * A preference's value: the def's own schema (integer, number, boolean, string, enum, or a JSON array or
 * object) decides. `anyOf` declares the union for the conformance gate and leaves the boundary type check
 * nothing to reject, so `prefs.ts` stays the single validator (the `set_field_value` precedent).
 */
const VALUE = {
  anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }, { type: 'array' }, { type: 'object' }],
} as const;

export function prefsActions(h: PrefsActionHelpers): ActionDef[] {
  const { ctxAction, ctxSchema, STR } = h;
  return [
    ctxAction(
      'prefs_list',
      'read',
      "List the calling person's own preferences (Meine Einstellungen), optionally one area: per preference the key, the value in force, the default, isDefault, the value schema, the scope (person: the same in every workspace; workspace: this workspace only), the area, en and de-CH label, description and per-value labels. A preference with no stored value reads its default. Never returns another person's preferences. An unknown area is unknown_pref_area.",
      ctxSchema({ area: STR }),
      (ctx, input) => prefsList(ctx, input),
    ),
    ctxAction(
      'prefs_get',
      'read',
      "Read one of the calling person's own preferences by key (for example appearance.theme): the value in force, the default and whether it is the default. An unknown key is unknown_pref, with the key it most likely meant as suggestion and the known keys.",
      ctxSchema({ key: STR }, ['key']),
      (ctx, input) => prefsGet(ctx, input),
    ),
    ctxAction(
      'prefs_set',
      'write:reversible:ui-state',
      "Set one of the calling person's own preferences (a look or arrangement, never anything the books do; workspace behaviour is settings_set). value must fit the key's schema exactly (invalid_pref_value otherwise; an unknown key is unknown_pref with a suggestion). Setting the value already in force changes nothing. Changes only the caller's own value. The way back is prefs_set to previousValue, which the answer names, or prefs_reset.",
      ctxSchema({ key: STR, value: VALUE }, ['key', 'value']),
      (ctx, input) => prefsSet(ctx, input),
    ),
    ctxAction(
      'prefs_reset',
      'write:reversible:ui-state',
      "Return the calling person's own preference to its default, either one key or every preference of one area (exactly one of key or area). Removes only the caller's own stored values; nothing stored means nothing changes. Answers the keys it reset. The way back is prefs_set.",
      ctxSchema({ key: STR, area: STR }),
      (ctx, input) => prefsReset(ctx, input),
    ),
  ];
}
