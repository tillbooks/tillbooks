/**
 * The hashes a checklist binds evidence to (spec G22 §4 and §10.2).
 *
 * `returnHashOf` is the computed-return hash: sha256 over A07's own `vat_return` payload, minus the
 * `ok` flag, in the key order the payload carries. Lines, totals, the bridge and the contributing entry
 * ids all ride in, so a re-posted entry, a reversed line or a changed rate configuration moves the
 * hash and every item bound to the old one reads stale. The G11 `checkHash` discipline reused. It
 * STAYS key-order-sensitive on purpose: bound hashes on filed runs must not move on upgrade.
 *
 * `canonicalHashOf` is the leg 2 hash for every new kind (previews, the statements anchor, the
 * validation figures): keys sorted recursively, `ok` dropped at the top, so two payloads that carry the
 * same facts in a different spelling bind the same hash.
 */

import { createHash } from 'node:crypto';

export function returnHashOf(payload: Record<string, unknown>): string {
  const { ok: _ok, ...rest } = payload;
  return createHash('sha256').update(JSON.stringify(rest)).digest('hex');
}

/** The value with every object's keys sorted, recursively; arrays keep their order (it is data). */
export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = canonicalize(v);
    }
    return out;
  }
  return value;
}

export function canonicalHashOf(payload: Record<string, unknown>): string {
  const { ok: _ok, ...rest } = payload;
  return createHash('sha256').update(JSON.stringify(canonicalize(rest))).digest('hex');
}
