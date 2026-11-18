/**
 * A42 (code critic r1 M2, r2 H1, r3 H1; re-cut after three FAILs): THE TRACE KEEPS NO PAYER, at the SINK.
 *
 * The trace keeps an agent's input (`agent_call.args_json`), never the payers of a settlement document. Three
 * rounds failed the same way: the guard ran where a caller remembered to run it (a verb name, then a literal
 * substring, then every position but two). The re-cut moves it to the one place every call row is written,
 * `insertCall` (`trace.ts`, the only INSERT into `agent_call`), and runs ONE scrubber that applies the same
 * checks at EVERY node of the stored value, whatever verb, branch or position it came from:
 *
 *  - a string that parses the way the settlement readers parse (a leading BOM stripped, `JSON.parse`) to anything
 *    holding a `till-settlement/v1` document or a payer ref, at any depth, is kept only as its size;
 *  - an object drops `counterpartyEmail` / `counterpartyName`; a `till-settlement/v1` document's events drop their
 *    `counterparty` (an event that is a text is judged as a string, like any other node);
 *  - past the depth bound a value is replaced, never kept; an `argsJson` that does not parse is kept as its size.
 *
 * Judging the PARSED VALUE (never a spelling) closes escapes (`\/`, `/`, an escaped key), double encoding,
 * wrappers and arrays alike. Only the trace loses detail: nothing booked, replayed or approved reads it.
 */

import { stripSecretsDeep } from './secretArgs.js';

const SETTLEMENT_SCHEMA_MARK = 'till-settlement/v1';
const PAYER_REF_KEYS: ReadonlySet<string> = new Set(['counterpartyEmail', 'counterpartyName']);
const MAX_DEPTH = 32;

function omitted(text: string): { omitted: true; bytes: number } {
  return { omitted: true, bytes: Buffer.byteLength(text, 'utf8') };
}

/** A string read the way the settlement readers read `content`: a leading BOM stripped, then `JSON.parse`. */
function parsedText(text: string): { value: unknown } | null {
  const body = text.replace(/^﻿/, '');
  if (!/^\s*[[{"]/.test(body)) return null;
  try {
    return { value: JSON.parse(body) as unknown };
  } catch {
    return null;
  }
}

/** Whether a value holds a settlement document or a payer ref anywhere, texts parsed (true past the bound). */
export function holdsPayers(value: unknown, depth = 0): boolean {
  if (depth > MAX_DEPTH) return true;
  if (typeof value === 'string') {
    const parsed = parsedText(value);
    return parsed !== null && holdsPayers(parsed.value, depth + 1);
  }
  if (Array.isArray(value)) return value.some((v) => holdsPayers(v, depth + 1));
  if (value === null || typeof value !== 'object') return false;
  const source = value as Record<string, unknown>;
  if (source['schema'] === SETTLEMENT_SCHEMA_MARK) return true;
  return Object.entries(source).some(([k, v]) => PAYER_REF_KEYS.has(k) || holdsPayers(v, depth + 1));
}

/** The one scrubber: the same checks at every node (module header). */
export function scrubPayers(value: unknown, depth = 0, inSettlementEvent = false): unknown {
  if (depth > MAX_DEPTH) return { omitted: true, reason: 'nested too deep' };
  if (typeof value === 'string') return holdsPayers(value, depth) ? omitted(value) : value;
  if (Array.isArray(value)) return value.map((v) => scrubPayers(v, depth + 1, inSettlementEvent));
  if (value === null || typeof value !== 'object') return value;
  const source = value as Record<string, unknown>;
  const isDocument = source['schema'] === SETTLEMENT_SCHEMA_MARK;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(source)) {
    if (PAYER_REF_KEYS.has(k)) continue;
    if (inSettlementEvent && k === 'counterparty') continue;
    // defineProperty: a parsed `__proto__` key stays an ordinary own key, never the object's prototype.
    Object.defineProperty(out, k, {
      value: isDocument && k === 'events' && Array.isArray(v) ? v.map((e) => scrubPayers(e, depth + 2, true)) : scrubPayers(v, depth + 1, false),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}

/** The stored form of a call's arguments: parsed, scrubbed, written again; a text that does not parse, its size. */
export function traceSafeArgsJson(argsJson: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(argsJson) as unknown;
  } catch {
    return JSON.stringify(omitted(argsJson));
  }
  // The secret-argument registry is applied at the same sink (paper attack r3: a guard that depends on which code
  // path wrote the row is the class this module ends), then the payers.
  return JSON.stringify(scrubPayers(stripSecretsDeep(parsed))) ?? 'null';
}
