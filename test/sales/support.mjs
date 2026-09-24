// Test support for A09 (customers & items, invoicing-lite master data).
//
// A workspace born with the KMU chart (createWorkspace seeds A01, so income account 3200 exists),
// plus a single VAT code 'UST81' seeded directly into tax_code. The A05 configureVat verb is being
// built in a sibling worktree; A09 only READS the tax_code table, so a direct seed keeps this suite
// self-contained and fully offline without reaching for a module that is not present here.

import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { makeContext } from '../../dist/core/context.js';
import { fixedClock } from '../../dist/core/clock.js';
import { sequenceIdGen } from '../../dist/core/ids.js';
import { createWorkspace } from '../../dist/core/setup/index.js';
import { makeAuditPort } from '../../dist/core/ledger/auditLog.js';

const AT = '2026-07-16T00:00:00.000Z';

export function setup() {
  const clock = fixedClock(AT);
  const ids = sequenceIdGen();
  const store = new SqliteStore({ clock });
  const deps = { store, clock, ids };
  const workspaceId = createWorkspace(deps, { name: 'Acme AG' }).workspaceId;
  // THE REAL AUDIT PORT, and it was missing. Without an `audit` override `makeContext` falls back to
  // `noAudit`, so every `ctx.audit.record` call this whole suite makes went to a stub: `contact_merge`
  // and `contact_anonymise` both "recorded" an entry and nothing was ever proved to reach the hash
  // chain. A verb whose audit trail is only exercised against a no-op is a verb with no audit trail.
  const ctx = makeContext(store, {
    workspaceId,
    actor: 'user_1',
    clock,
    ids,
    audit: makeAuditPort({ store, workspaceId, ids }),
  });
  seedTaxCode(store, workspaceId, 'UST81');
  const byNumber = (number) =>
    store.db.prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?').get(workspaceId, number)?.id;
  return { ctx, store, workspaceId, deps, byNumber, AT };
}

/** A second workspace in the SAME store, for the §H-TENANT isolation check. */
export function newWorkspace(deps, name) {
  const workspaceId = createWorkspace(deps, { name }).workspaceId;
  return makeContext(deps.store, {
    workspaceId,
    actor: 'user_1',
    clock: deps.clock,
    ids: deps.ids,
    audit: makeAuditPort({ store: deps.store, workspaceId, ids: deps.ids }),
  });
}

function seedTaxCode(store, workspaceId, code) {
  store.db
    .prepare(
      `INSERT INTO tax_code (id, workspace_id, code, kind, rate_bp, method, label, active)
       VALUES (?, ?, ?, 'sales', 810, 'effektiv', 'Normalsatz 8.1%', 1)`,
    )
    .run(`tc_${workspaceId}_${code}`, workspaceId, code);
}
