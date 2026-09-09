/**
 * The condition language and the action input template: the two places a rule's configuration meets
 * the event's data.
 *
 * A CONDITION IS A JSON PREDICATE AND DELIBERATELY NOT AN EXPRESSION STRING. A string needs a parser,
 * a parser on configuration an agent can write is an attack surface, and the obvious shortcut (hand it
 * to `Function` or `eval`) would put arbitrary code execution one `create_automation_rule` call away
 * from an MCP client. It is also the wrong shape for the product: a rule is edited in a form, and a
 * form over a clause list is a component, while a form over an expression grammar is an editor.
 *
 * EVERY CONDITION IS VALIDATED AT SAVE TIME, never deferred to first fire. A rule that only reveals it
 * is malformed at 03:00 when its trigger finally happens is a rule whose error message nobody reads.
 *
 * THE TEMPLATE DISTINGUISHES A WHOLE-VALUE SUBSTITUTION FROM AN INTERPOLATION, AND THAT IS ABOUT
 * MONEY. A string that is EXACTLY `{{path}}` resolves to the RAW typed value, so an integer Rappen
 * count stays an integer; a string that merely contains `{{path}}` interpolates as text. Without the
 * distinction, templating an amount would turn 500000 Rappen into the string "500000", which the
 * target verb's boundary type check rejects, and rounding-shaped bugs are exactly what P2 exists to
 * keep out of this engine.
 */

import type { WorkspaceContext } from '../context.js';
import { err } from '../result.js';
import type { Result } from '../result.js';
import { readPath } from './events.js';
import { listFieldValues } from '../customization/index.js';

/** The comparison operators (§H-ENUM). A tenth is one edit here plus one i18n key. */
export const CONDITION_OPS: readonly string[] = [
  'eq',
  'ne',
  'gt',
  'gte',
  'lt',
  'lte',
  'in',
  'contains',
  'exists',
  'empty',
];

const OP_SET: ReadonlySet<string> = new Set(CONDITION_OPS);

/** Operators that compare numerically and therefore refuse a non-numeric operand. */
const NUMERIC_OPS: ReadonlySet<string> = new Set(['gt', 'gte', 'lt', 'lte']);

/** Operators that take no `value` at all. Requiring one would be a trap in the editor. */
const UNARY_OPS: ReadonlySet<string> = new Set(['exists', 'empty']);

export const MAX_CONDITION_CLAUSES = 32;

export interface ConditionClause {
  readonly field: string;
  readonly op: string;
  readonly value?: unknown;
}

/** `null` means "always". Otherwise every clause of `all`, or any clause of `any`, must hold. */
export interface ConditionGroup {
  readonly all?: readonly ConditionClause[];
  readonly any?: readonly ConditionClause[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validate a condition's SHAPE. Returns a rejection, or undefined when it is well formed.
 *
 * Everything it can check without the data it will one day run against is checked here, which is
 * every structural mistake a form can make: an unknown operator, a missing field path, a numeric
 * comparison against text, an `all` and an `any` in the same group (which reads as "and or", and
 * refusing it is kinder than picking one).
 */
export function validateCondition(condition: unknown): Result | undefined {
  if (condition === null || condition === undefined) return undefined;
  if (!isPlainObject(condition)) return err('invalid_condition', { reason: 'not_an_object' });

  const hasAll = condition.all !== undefined;
  const hasAny = condition.any !== undefined;
  if (!hasAll && !hasAny) return err('invalid_condition', { reason: 'no_all_or_any' });
  if (hasAll && hasAny) return err('invalid_condition', { reason: 'both_all_and_any' });

  const clauses = (hasAll ? condition.all : condition.any) as unknown;
  if (!Array.isArray(clauses)) return err('invalid_condition', { reason: 'clauses_not_an_array' });
  if (clauses.length === 0) return err('invalid_condition', { reason: 'no_clauses' });
  if (clauses.length > MAX_CONDITION_CLAUSES) {
    return err('invalid_condition', { reason: 'too_many_clauses', max: MAX_CONDITION_CLAUSES });
  }

  for (const raw of clauses) {
    if (!isPlainObject(raw)) return err('invalid_condition', { reason: 'clause_not_an_object' });
    const field = raw.field;
    if (typeof field !== 'string' || field.length === 0) {
      return err('invalid_condition', { reason: 'clause_field_missing' });
    }
    const op = raw.op;
    if (typeof op !== 'string' || !OP_SET.has(op)) {
      return err('invalid_condition', { reason: 'unknown_op', op, allowed: [...CONDITION_OPS] });
    }
    if (!UNARY_OPS.has(op) && raw.value === undefined) {
      return err('invalid_condition', { reason: 'clause_value_missing', field, op });
    }
    if (NUMERIC_OPS.has(op) && typeof raw.value !== 'number') {
      return err('invalid_condition', { reason: 'value_not_numeric', field, op });
    }
    if (op === 'in' && !Array.isArray(raw.value)) {
      return err('invalid_condition', { reason: 'value_not_an_array', field, op });
    }
  }
  return undefined;
}

/**
 * The data a condition sees: the event payload, plus that entity's G00 custom field values under
 * `custom.<key>` (OP7).
 *
 * The custom values are read LAZILY, only when some clause actually names `custom.`, so a rule that
 * does not use them costs no query. That matters because this runs on the hot path of every write
 * verb that emits an event.
 */
function resolveField(
  ctx: WorkspaceContext,
  payload: Record<string, unknown>,
  entity: { kind?: string | undefined; id: string },
  field: string,
  customCache: { values?: Record<string, unknown> },
): unknown {
  if (!field.startsWith('custom.')) return readPath(payload, field);

  if (customCache.values === undefined) {
    customCache.values = {};
    if (entity.kind !== undefined && entity.id.length > 0) {
      const read = listFieldValues(ctx, { entityKind: entity.kind, entityId: entity.id });
      const rows = read.ok ? (read as { values?: unknown }).values : undefined;
      if (Array.isArray(rows)) {
        for (const row of rows) {
          if (!isPlainObject(row)) continue;
          const key = row.fieldKey ?? row.key;
          if (typeof key === 'string') customCache.values[key] = row.value;
        }
      }
    }
  }
  return customCache.values[field.slice('custom.'.length)];
}

function clauseHolds(actual: unknown, op: string, expected: unknown): boolean {
  switch (op) {
    case 'exists':
      return actual !== undefined && actual !== null;
    case 'empty':
      return actual === undefined || actual === null || actual === '';
    case 'eq':
      return actual === expected;
    case 'ne':
      return actual !== expected;
    case 'gt':
      return typeof actual === 'number' && typeof expected === 'number' && actual > expected;
    case 'gte':
      return typeof actual === 'number' && typeof expected === 'number' && actual >= expected;
    case 'lt':
      return typeof actual === 'number' && typeof expected === 'number' && actual < expected;
    case 'lte':
      return typeof actual === 'number' && typeof expected === 'number' && actual <= expected;
    case 'in':
      return Array.isArray(expected) && expected.includes(actual);
    case 'contains':
      return (
        (typeof actual === 'string' && typeof expected === 'string' && actual.includes(expected)) ||
        (Array.isArray(actual) && actual.includes(expected))
      );
    default:
      // Unreachable: `validateCondition` refused any other operator at save time. Written as `false`
      // rather than a throw because this runs unattended: failing a condition CLOSED skips a firing,
      // which is the safe direction, while a throw would take the emitting verb's dispatch with it.
      return false;
  }
}

/**
 * Does this condition hold for this occurrence?
 *
 * FAILS CLOSED on anything it cannot evaluate: an absent field, a type mismatch, a custom field that
 * does not exist. A rule whose condition cannot be answered does not fire. On an engine that writes to
 * a ledger unattended, "I could not tell" and "no" must have the same consequence.
 */
export function conditionHolds(
  ctx: WorkspaceContext,
  condition: unknown,
  payload: Record<string, unknown>,
  entity: { kind?: string | undefined; id: string },
): boolean {
  if (condition === null || condition === undefined) return true;
  if (!isPlainObject(condition)) return false;

  const clauses = (condition.all ?? condition.any) as ConditionClause[] | undefined;
  if (!Array.isArray(clauses) || clauses.length === 0) return false;
  const needsAll = condition.all !== undefined;
  const customCache: { values?: Record<string, unknown> } = {};

  for (const clause of clauses) {
    const actual = resolveField(ctx, payload, entity, clause.field, customCache);
    const holds = clauseHolds(actual, clause.op, clause.value);
    if (needsAll && !holds) return false;
    if (!needsAll && holds) return true;
  }
  return needsAll;
}

const WHOLE_VALUE = /^\{\{\s*([A-Za-z0-9_.]+)\s*\}\}$/;
const INTERPOLATION = /\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g;

/**
 * Resolve an action input template against the event payload.
 *
 * Only STRING leaves are templated, and only one level of nesting is walked, which is the whole shape
 * an action input has (the registry's schemas are flat objects of scalars, arrays and one-level
 * objects). A value the template does not name passes through untouched, so a literal is a literal.
 */
export function resolveTemplate(
  template: Record<string, unknown>,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(template)) {
    out[key] = resolveValue(value, payload);
  }
  return out;
}

function resolveValue(value: unknown, payload: Record<string, unknown>): unknown {
  if (typeof value === 'string') {
    const whole = WHOLE_VALUE.exec(value);
    // A WHOLE-VALUE substitution keeps the source type. This is the money case: 500000 stays the
    // number 500000 and never becomes the string "500000".
    if (whole !== null) return readPath(payload, whole[1] ?? '');
    return value.replace(INTERPOLATION, (_match, path: string) => {
      const resolved = readPath(payload, path);
      return resolved === undefined || resolved === null ? '' : String(resolved);
    });
  }
  if (Array.isArray(value)) return value.map((v) => resolveValue(v, payload));
  if (isPlainObject(value)) return resolveTemplate(value, payload);
  return value;
}
