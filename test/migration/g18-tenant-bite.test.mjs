/**
 * §H-TENANT BITE PROBE for create_backup (R1). The author's r1c test builds two SEPARATE freshDeps()
 * worlds, i.e. two DISTINCT in-memory databases, so workspace B's plan never exists in workspace A's
 * database and the `WHERE workspace_id = ?` filter is never actually exercised: dropping the filter
 * does not flip that test. A real deployment holds MANY workspaces in ONE data.sqlite, so the tenant
 * fence must be proven with two workspaces in the SAME store. This probe does that: from workspace A
 * it targets workspace B's planId and asserts the call refuses and mints NO backup. Under a
 * dropped-filter regression the plan is "found" cross-tenant and a backup is minted, so this FAILS.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getAction } from '../../dist/api/registry.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';

test('§H-TENANT BITE: create_backup from workspace A cannot link (or read) workspace B plan in the SAME store', () => {
  const deps = freshDeps();
  deps.actor = 'studio';
  deps.backupDir = mkdtempSync(join(tmpdir(), 'till-tenantbite-'));

  // TWO workspaces in ONE database (the real multi-tenant shape).
  const { workspaceId: wsA } = mintWorkspace(deps, 'Alpha GmbH', 'ws-a');
  const { workspaceId: wsB } = mintWorkspace(deps, 'Beta GmbH', 'ws-b');
  assert.notEqual(wsA, wsB);

  // A planned plan lives in B.
  const planB = getAction('migration_create_plan').run(deps, { workspaceId: wsB, sourceSystem: 'csv', cutoverDate: '2020-01-01', localePack: 'ch', idempotencyKey: 'tb-plan' }).planId;
  getAction('migration_set_scope').run(deps, { workspaceId: wsB, planId: planB, classes: [{ dataClass: 'opening_balances', include: true }], idempotencyKey: 'tb-scope' });
  const statusB = deps.store.db.prepare('SELECT status FROM migration_plan WHERE id = ?').get(planB).status;
  assert.equal(statusB, 'planned', 'B plan is planned (would satisfy the link if the fence leaked)');

  const backupsBefore = deps.store.db.prepare('SELECT COUNT(*) AS n FROM backups').get().n;

  // A reaches for B's plan. §H-TENANT must refuse not_found and mint nothing.
  const res = getAction('create_backup').run(deps, { workspaceId: wsA, planId: planB, idempotencyKey: 'tb-x' });
  assert.equal(res.ok, false, `cross-tenant create_backup must refuse: ${JSON.stringify(res)}`);
  assert.equal(res.error, 'not_found', `wrong error: ${JSON.stringify(res)}`);

  const backupsAfter = deps.store.db.prepare('SELECT COUNT(*) AS n FROM backups').get().n;
  assert.equal(backupsAfter, backupsBefore, 'the refused cross-tenant call minted NO backup row');
  // B's plan is untouched.
  assert.equal(deps.store.db.prepare('SELECT backup_ref FROM migration_plan WHERE id = ?').get(planB).backup_ref, null, "B's plan backup_ref stays null");
});
