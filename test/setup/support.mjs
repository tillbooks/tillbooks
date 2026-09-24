// Test support for A00 (company & fiscal setup).

import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { makeContext } from '../../dist/core/context.js';
import { fixedClock } from '../../dist/core/clock.js';
import { sequenceIdGen } from '../../dist/core/ids.js';

const AT = '2026-07-16T00:00:00.000Z';

export function setup() {
  const clock = fixedClock(AT);
  const ids = sequenceIdGen();
  const store = new SqliteStore({ clock });
  const deps = { store, clock, ids };
  const ctxFor = (workspaceId) => makeContext(store, { workspaceId, actor: 'user_1', clock, ids });
  return { store, deps, ctxFor, AT };
}

/** Compute a valid IBAN's check digits, for provably-correct QR-IBAN fixtures. */
export function computeIban(country, bban) {
  const rearranged = `${bban}${country}00`;
  let rem = 0;
  for (const ch of rearranged) {
    const code = /[A-Z]/.test(ch) ? String(ch.charCodeAt(0) - 55) : ch;
    for (const d of code) rem = (rem * 10 + Number(d)) % 97;
  }
  return `${country}${String(98 - rem).padStart(2, '0')}${bban}`;
}
