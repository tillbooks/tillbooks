// Test support for the A05 (MWST config) suites: a real workspace with the KMU chart, plus the A05
// tax codes seeded and a chosen method/timing already configured. Not production code.

import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { makeContext } from '../../dist/core/context.js';
import { fixedClock } from '../../dist/core/clock.js';
import { sequenceIdGen } from '../../dist/core/ids.js';
import { createWorkspace } from '../../dist/core/setup/index.js';
import { configureVat } from '../../dist/core/vat/index.js';

const AT = '2026-07-16T00:00:00.000Z';

/**
 * A workspace, and optionally a SECOND workspace in the SAME database.
 *
 * Pass `store` and `ids` from an earlier `setup()` to mint a real co-tenant. Without them every call
 * builds its own `new SqliteStore(...)`, which is right for a suite that is not testing isolation
 * and is a TRAP for one that is: two calls produce two independent in-memory databases, so a
 * §H-TENANT test written that way passes with the workspace filter deleted from every query. The
 * shared `ids` matter as much as the shared store, because a fresh `sequenceIdGen()` mints `ws_1`
 * again and the "other tenant" turns out to be the same tenant.
 */
export function setup({ method = 'effektiv', timing = 'soll', registered = true, seed = true, saldoRates, asOf, store: sharedStore, ids: sharedIds } = {}) {
  const store = sharedStore ?? new SqliteStore({ clock: fixedClock(AT) });
  const ids = sharedIds ?? sequenceIdGen();
  const clock = fixedClock(AT);
  const minted = createWorkspace({ store, clock, ids }, { name: 'Acme GmbH' });
  if (!minted.ok) throw new Error(`setup: createWorkspace failed: ${JSON.stringify(minted)}`);
  const workspaceId = minted.workspaceId;
  const ctx = makeContext(store, { workspaceId, actor: 'user_1', clock, ids });

  if (registered) {
    // configureVat with registered=true seeds the default codes when none exist.
    configureVat(ctx, {
      method,
      timing,
      registered: true,
      idempotencyKey: 'cfg1',
      // The era the Saldosteuersatz ladder is validated against. A pre-2024 rate (the 2018 ladder
      // differs on six of ten rungs) is only configurable with an `asOf` inside its own era.
      ...(asOf ? { asOf } : {}),
      ...(saldoRates ? { saldoRates } : method === 'saldo' ? { saldoRates: [{ rateBp: 620 }] } : {}),
    });
    if (!seed) {
      // A caller that wants an unseeded-but-registered workspace clears the codes.
      store.db.prepare('DELETE FROM tax_code WHERE workspace_id = ?').run(workspaceId);
    }
  }

  return { store, ctx, workspaceId, ids, clock, AT };
}
