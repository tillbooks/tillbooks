/**
 * N01, THE REGISTRY INPUT BOUNDARY: what every call's input passes before its verb runs, in one place.
 *
 * Two jobs live here, both driven by the verb's own `inputSchema`, so a verb opts in by its schema and no
 * verb name is read:
 *
 *  1. ACCOUNT NUMBERS (US-N01.1). A schema field marked as an account reference (`ACCOUNT_REF`, the
 *     keyword `x-till-ref: account`) accepts an account id OR its number ("6500"). The number is resolved
 *     to the id HERE, with A04's resolver (`resolveAccountReference`, `core/ledger/openingBalances.ts`: id
 *     first, then number, inside the workspace), so every guard downstream still sees ids and a number
 *     and its id are the same arguments to the idempotency hash. A value that IS an account id resolves
 *     to that account, whatever another account's number reads. A number-shaped value that names no
 *     account refuses `invalid_account` naming it; any other unresolved value is left to the verb, whose
 *     own refusal stays exactly as it was. The D172 setting `ledger.account_numbers` (`accept` default,
 *     `ids_only`) turns it off.
 *  2. UNKNOWN FIELDS (US-N01.4). A top-level field the verb's schema does not declare (and that is no
 *     transport field) is reported with the closest declared name. Whether it warns, refuses or is
 *     ignored is the setting `mcp.unknown_fields_agent` for a governed agent seat and
 *     `mcp.unknown_fields_studio` for every other seat (both `warn` by default). Checked at the TRANSPORT
 *     seam only (`runGoverned`): an internal invoke (an approval replay, a G01 firing, the scheduler, a
 *     batch item's nested dispatch) carries input TILL composed itself and is never checked.
 *
 * A leaf of the api layer: it imports types from `registry.ts` and nothing from it at runtime, so the
 * registry and the gate can both import it without a cycle.
 */

import type { WorkspaceContext } from '../core/context.js';
import { err, type Err } from '../core/result.js';
import { resolveAccountReference } from '../core/ledger/index.js';
import { getSetting } from '../core/settings/settings.js';
import type { ActionInput, JsonSchema } from './registry.js';

/** The schema keyword that marks a field as an account reference, and its one value. */
export const REF_KEYWORD = 'x-till-ref';

/**
 * The schema fragment of an account reference: a string that is an account id or the account's number.
 * Spread into a verb's schema wherever it takes an account; the boundary does the rest.
 */
export const ACCOUNT_REF = {
  type: 'string',
  description: 'account id or number',
  [REF_KEYWORD]: 'account',
} as const;

/** The D172 setting that turns account-number resolution off (`ids_only`). */
export const ACCOUNT_NUMBERS_SETTING = 'ledger.account_numbers';
export const ACCOUNT_NUMBERS_VALUES = ['accept', 'ids_only'] as const;
export type AccountNumbersMode = (typeof ACCOUNT_NUMBERS_VALUES)[number];

/** The two D172 settings of the unknown-field check, and their three values. */
export const UNKNOWN_FIELDS_AGENT_SETTING = 'mcp.unknown_fields_agent';
export const UNKNOWN_FIELDS_STUDIO_SETTING = 'mcp.unknown_fields_studio';
export const UNKNOWN_FIELDS_VALUES = ['warn', 'refuse', 'ignore'] as const;
export type UnknownFieldsMode = (typeof UNKNOWN_FIELDS_VALUES)[number];

/** The code a warning and a refusal of an unknown field carry. */
export const UNKNOWN_FIELD = 'unknown_field';

/**
 * Fields a transport call may carry beside the verb's own schema. `agentReason` is the agent's sentence
 * on a governed write (US-N01.8); every governed write declares it in its schema, and it is listed here
 * so a write the dial does not govern is not told its reason is unknown either. `workspaceId` is the tenant
 * every call names: a pre-workspace or token verb ignores it (and a token verb's refusal must stay the one
 * every caller gets, D161), so it is never reported as unknown. `idempotencyKey` sent to a verb that takes
 * none is harmless by construction: the conformance gate lets a write go keyless only when repeating it is
 * safe (an absolute setter, or a verb that keys itself), and a read never needs one. The schema survey found
 * the Studio sending one to four such verbs.
 */
export const TRANSPORT_FIELDS: readonly string[] = ['agentReason', 'workspaceId', 'idempotencyKey'];

/** A value that reads as an account NUMBER: digits, optionally grouped by `.` or `-` (1020, 1020.01). */
const NUMBER_SHAPE = /^\d+(?:[.-]\d+)*$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Object.prototype.toString.call(value) === '[object Object]';
}

function isAccountRef(spec: unknown): boolean {
  return isPlainObject(spec) && spec[REF_KEYWORD] === 'account';
}

/** Does `schema` mark any field, at any depth, as an account reference? (Computed once per verb.) */
export function schemaHasAccountRefs(schema: unknown): boolean {
  if (!isPlainObject(schema)) return false;
  if (isAccountRef(schema)) return true;
  if (isPlainObject(schema.properties) && Object.values(schema.properties).some(schemaHasAccountRefs)) return true;
  if (schema.items !== undefined && schemaHasAccountRefs(schema.items)) return true;
  return false;
}

/** The workspace's `ledger.account_numbers`, or the default when it cannot be read. */
export function accountNumbersMode(ctx: WorkspaceContext): AccountNumbersMode {
  try {
    const value = getSetting<string>(ctx, ACCOUNT_NUMBERS_SETTING);
    return value === 'ids_only' ? 'ids_only' : 'accept';
  } catch {
    return 'accept';
  }
}

type Walked = { ok: true; value: unknown } | { ok: false; error: Err };

/**
 * Resolve every account reference `schema` marks inside `value`. Copy on write: an input whose references
 * are all ids comes back as the SAME object, and the caller's input is never mutated (the trace records
 * what the caller sent).
 */
function walk(ctx: WorkspaceContext, spec: unknown, value: unknown, path: string): Walked {
  if (value === undefined || value === null || !isPlainObject(spec)) return { ok: true, value };
  if (isAccountRef(spec)) {
    if (typeof value !== 'string' || value.length === 0) return { ok: true, value };
    const resolved = resolveAccountReference(ctx, value);
    if (resolved !== undefined) return { ok: true, value: resolved.id };
    if (NUMBER_SHAPE.test(value)) {
      return {
        ok: false,
        error: err('invalid_account', {
          field: path,
          account: value,
          reason: 'no_such_account',
          sentence: {
            en: `There is no account ${value} in this workspace's chart.`,
            'de-CH': `Im Kontenplan dieses Arbeitsbereichs gibt es kein Konto ${value}.`,
          },
        }),
      };
    }
    return { ok: true, value };
  }
  if (spec.type === 'array' && spec.items !== undefined && Array.isArray(value)) {
    let out: unknown[] | undefined;
    for (let i = 0; i < value.length; i += 1) {
      const r = walk(ctx, spec.items, value[i], `${path}[${i}]`);
      if (!r.ok) return r;
      if (r.value !== value[i]) {
        out ??= [...value];
        out[i] = r.value;
      }
    }
    return { ok: true, value: out ?? value };
  }
  if (isPlainObject(spec.properties) && isPlainObject(value)) {
    let out: Record<string, unknown> | undefined;
    for (const [field, fieldSpec] of Object.entries(spec.properties)) {
      if (!(field in value)) continue;
      const r = walk(ctx, fieldSpec, value[field], path === '' ? field : `${path}.${field}`);
      if (!r.ok) return r;
      if (r.value !== value[field]) {
        out ??= { ...value };
        out[field] = r.value;
      }
    }
    return { ok: true, value: out ?? value };
  }
  return { ok: true, value };
}

/**
 * US-N01.1: `input` with every account number its schema marks resolved to the account id, or the
 * `invalid_account` refusal. A verb whose schema marks no account comes back untouched, and so does every
 * input under `ledger.account_numbers = ids_only`.
 */
export function normalizeAccountRefs(
  ctx: WorkspaceContext,
  schema: JsonSchema,
  input: ActionInput,
): { ok: true; input: ActionInput } | { ok: false; error: Err } {
  if (!schemaHasAccountRefs(schema)) return { ok: true, input };
  if (accountNumbersMode(ctx) === 'ids_only') return { ok: true, input };
  const r = walk(ctx, schema, input, '');
  if (!r.ok) return r;
  return { ok: true, input: r.value as ActionInput };
}

// --- unknown fields ------------------------------------------------------------------------------------

/** One unknown field, with the declared name it most likely meant (or null when none is close). */
export interface UnknownFieldWarning {
  code: typeof UNKNOWN_FIELD;
  field: string;
  didYouMean: string | null;
}

/** Levenshtein distance, case-insensitive (a camelCase slip like `accountid` is one letter away). */
function distance(a: string, b: string): number {
  const s = a.toLowerCase();
  const t = b.toLowerCase();
  if (s === t) return 0;
  let prev = Array.from({ length: t.length + 1 }, (_, j) => j);
  for (let i = 1; i <= s.length; i += 1) {
    const cur = [i];
    for (let j = 1; j <= t.length; j += 1) {
      cur[j] = Math.min((prev[j] as number) + 1, (cur[j - 1] as number) + 1, (prev[j - 1] as number) + (s[i - 1] === t[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[t.length] as number;
}

/**
 * The declared field `field` most likely meant: the nearest by edit distance, within a third of its
 * length (at least 2 edits), ties broken by declaration order; or one the unknown name contains or is
 * contained in (`lineItems` for `lines`). Null when nothing is close: a guess is worse than none.
 */
export function didYouMean(field: string, declared: readonly string[]): string | null {
  let best: string | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  const limit = Math.max(2, Math.floor(field.length / 3));
  for (const name of declared) {
    const d = distance(field, name);
    if (d < bestDistance) {
      best = name;
      bestDistance = d;
    }
  }
  if (best !== null && bestDistance <= limit) return best;
  const lower = field.toLowerCase();
  const contained = declared.find((name) => name.length >= 4 && (lower.includes(name.toLowerCase()) || name.toLowerCase().includes(lower)));
  return contained ?? null;
}

/**
 * US-N01.4: the top-level fields of `input` that `schema` does not declare and that are no transport
 * field, in the order the caller sent them, each with its closest declared name.
 */
export function unknownFields(schema: JsonSchema, input: ActionInput): UnknownFieldWarning[] {
  const declared = Object.keys(schema.properties);
  const known = new Set([...declared, ...TRANSPORT_FIELDS]);
  const out: UnknownFieldWarning[] = [];
  for (const field of Object.keys(input)) {
    if (known.has(field) || input[field] === undefined) continue;
    out.push({ code: UNKNOWN_FIELD, field, didYouMean: didYouMean(field, declared) });
  }
  return out;
}

/** The workspace's unknown-field mode for this seat, or `warn` (the default of both) when unreadable. */
export function unknownFieldsMode(ctx: WorkspaceContext | undefined, governedSeat: boolean): UnknownFieldsMode {
  const key = governedSeat ? UNKNOWN_FIELDS_AGENT_SETTING : UNKNOWN_FIELDS_STUDIO_SETTING;
  if (ctx === undefined) return 'warn';
  try {
    const value = getSetting<string>(ctx, key);
    return (UNKNOWN_FIELDS_VALUES as readonly string[]).includes(value) ? (value as UnknownFieldsMode) : 'warn';
  } catch {
    return 'warn';
  }
}

/** The refusal an unknown field gets under `refuse`: the same payload a warning carries. */
export function unknownFieldRefusal(action: string, warnings: readonly UnknownFieldWarning[]): Err {
  const first = warnings[0] as UnknownFieldWarning;
  return err(UNKNOWN_FIELD, {
    action,
    field: first.field,
    didYouMean: first.didYouMean,
    warnings: [...warnings],
    reason:
      first.didYouMean === null
        ? `${action} has no field ${first.field}. Nothing was done.`
        : `${action} has no field ${first.field}; did you mean ${first.didYouMean}? Nothing was done.`,
  });
}
