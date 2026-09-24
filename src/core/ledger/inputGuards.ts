/**
 * Boundary shape guards (Pattern P9, scope degradation).
 *
 * At the MCP/REST edge, ids, keys, dates, and filters arrive as untyped JSON, and an agent may pass a
 * malformed or missing value. Each must become a structured `{ok:false, error:'invalid_input'}` here,
 * never a thrown 500 at the SQL bind. Line shapes are validated inside the ledger verbs; these guard
 * the scalar fields.
 *
 * Compose with `??`: `requireString(a) ?? optionalId(b) ?? ...` returns the first rejection or null.
 */

import { err } from '../result.js';
import type { Err } from '../result.js';

/** Required scalar (id, key, date): must be a non-empty string. */
export function requireString(value: unknown, field: string): Err | null {
  return typeof value === 'string' && value.length > 0 ? null : err('invalid_input', { field });
}

/** Optional id: absent, or a non-empty string. */
export function optionalId(value: unknown, field: string): Err | null {
  if (value === undefined) return null;
  return typeof value === 'string' && value.length > 0 ? null : err('invalid_input', { field });
}

/** Optional free text or filter: absent, or a string (may be empty). */
export function optionalText(value: unknown, field: string): Err | null {
  if (value === undefined) return null;
  return typeof value === 'string' ? null : err('invalid_input', { field });
}

/** A real ISO-8601 calendar date `YYYY-MM-DD`. Rejects `2026-02-30` and `2026-13-45` via round-trip. */
function isCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** Required date: `YYYY-MM-DD` and a valid calendar date. §D0 stores dates ISO-8601. */
export function requireDate(value: unknown, field: string): Err | null {
  return isCalendarDate(value) ? null : err('invalid_input', { field });
}

/** Optional date: absent, or a valid `YYYY-MM-DD`. */
export function optionalDate(value: unknown, field: string): Err | null {
  if (value === undefined) return null;
  return isCalendarDate(value) ? null : err('invalid_input', { field });
}
