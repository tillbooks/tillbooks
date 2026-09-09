/**
 * The computed-return hash a checklist binds evidence to (spec G22 §4): sha256 over A07's own
 * `vat_return` payload, minus the `ok` flag. Lines, totals, the bridge and the contributing entry
 * ids all ride in, so a re-posted entry, a reversed line or a changed rate configuration moves the
 * hash and every item bound to the old one reads stale. The G11 `checkHash` discipline reused.
 */

import { createHash } from 'node:crypto';

export function returnHashOf(payload: Record<string, unknown>): string {
  const { ok: _ok, ...rest } = payload;
  return createHash('sha256').update(JSON.stringify(rest)).digest('hex');
}
