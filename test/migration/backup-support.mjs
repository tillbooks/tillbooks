// Satisfy G18's pre-migration-backup leg the only way the gate now accepts: a REAL `create_backup`
// linked to the plan, whose bundle is on disk and re-hashes to its manifest. A hand-written
// `backup_ref` names no bundle and no longer opens the gate (seams.ts `preMigrationBackupStatus`).

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getAction } from '../../dist/api/registry.js';

/**
 * Take a real backup of the plan's workspace linked to `planId` (the plan must have reached `planned`).
 * Gives `deps` its own temp backup directory when it has none, so nothing lands in `~/.till`.
 * Returns the `create_backup` result.
 */
export function grantRealBackup(deps, planId, key = `grant-backup-${planId}`) {
  const workspaceId = deps.store.db.prepare('SELECT workspace_id FROM migration_plan WHERE id = ?').get(planId)?.workspace_id;
  assert.ok(typeof workspaceId === 'string', `no plan ${planId}`);
  if (deps.backupDir === undefined) deps.backupDir = mkdtempSync(join(tmpdir(), 'till-migration-backup-'));
  const res = getAction('create_backup').run(deps, { workspaceId, planId, idempotencyKey: key });
  assert.equal(res.ok, true, `create_backup failed: ${JSON.stringify(res)}`);
  assert.equal(res.planLink?.linked, true, `the backup did not link to the plan: ${JSON.stringify(res.planLink)}`);
  return res;
}
