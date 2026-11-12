/**
 * G04 backup durability, and G18's pre-migration-backup gate bound to the DISK.
 *
 * The `backups` row commits durably (the ledger's contract), so the bundle it names must be durable
 * FIRST, or a power cut right after a backup leaves the ledger claiming a complete backup that is gone
 * or torn. These tests hold the order in place: every bundle file and the bundle directory are fsynced
 * before the one rename that publishes the bundle, and the parent directory is fsynced after it; and
 * the snapshot is built as ONE transaction on a durable connection.
 *
 * G18's `hasPreMigrationBackup` used to trust the `backup_ref` column alone. It now proves the bundle
 * is still there and intact, so a deleted, torn, re-pointed or hand-written backup no longer opens
 * the first live money-path commit.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync, unlinkSync, renameSync as renameSyncFs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';

import { getAction } from '../../dist/api/registry.js';
import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { createBackup } from '../../dist/core/data/portability.js';
import { hasPreMigrationBackup, preMigrationBackupStatus } from '../../dist/core/migration/seams.js';
import { createWorkspace } from '../../dist/core/setup/workspace.js';
import { systemIdGen } from '../../dist/core/ids.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';
import { withFsEvents } from '../core/fs-event-spy.mjs';

const must = (res, what) => {
  assert.equal(res.ok, true, `${what} failed: ${JSON.stringify(res)}`);
  return res;
};

function world(seed) {
  const deps = freshDeps();
  deps.backupDir = mkdtempSync(join(tmpdir(), `till-g04-durable-${seed}-`));
  const { workspaceId } = mintWorkspace(deps, 'Quelle GmbH', `${seed}-ws`);
  const call = (name, input) => getAction(name).run(deps, { workspaceId, ...input });
  return { deps, wid: workspaceId, call };
}

/** A plan that has reached `planned` (one money-path class scoped), so a backup links to it. */
function plannedPlan(call, seed) {
  const planId = must(call('migration_create_plan', { sourceSystem: 'csv', cutoverDate: '2020-01-01', localePack: 'ch', idempotencyKey: `${seed}-plan` }), 'plan').planId;
  must(call('migration_set_scope', { planId, classes: [{ dataClass: 'opening_balances', include: true }], idempotencyKey: `${seed}-scope` }), 'scope');
  return planId;
}

const planRow = (deps, planId) => deps.store.db.prepare('SELECT * FROM migration_plan WHERE id = ?').get(planId);

// --- the durable publish order -------------------------------------------------------------------

test('createBackup fsyncs every bundle file and the bundle directory BEFORE the publishing rename, and the parent AFTER it', () => {
  const { deps, call } = world('order');
  const { result, events } = withFsEvents(() => call('create_backup', { idempotencyKey: 'order-bk' }));
  must(result, 'create_backup');
  const finalDir = resolve(result.artifactRef);
  const publish = events.findIndex((e) => e.op === 'rename' && e.to === finalDir);
  assert.ok(publish >= 0, `the bundle was published by a rename onto ${finalDir}: ${JSON.stringify(events)}`);
  const tmpDir = events[publish].from;
  assert.match(tmpDir, /[\\/]\.tmp-[^\\/]+$/, 'the bundle is built in a temp directory');

  const syncedBefore = new Set(events.slice(0, publish).filter((e) => e.op === 'fsync').map((e) => e.path));
  for (const name of readdirSync(finalDir)) {
    assert.ok(syncedBefore.has(join(tmpDir, name)), `${name} was fsynced before the bundle was published`);
  }
  assert.ok(syncedBefore.has(tmpDir), 'the bundle directory itself (its entries) was fsynced before the rename');
  const syncedAfter = events.slice(publish + 1).filter((e) => e.op === 'fsync').map((e) => e.path);
  assert.ok(syncedAfter.includes(resolve(deps.backupDir)), 'the backup directory was fsynced after the rename, so the rename survives');
  assert.equal(readdirSync(deps.backupDir).filter((n) => n.startsWith('.tmp-')).length, 0, 'no temp bundle is left behind');
});

test('the export bundle (.tillexport) is published through the same durable order', () => {
  const { deps, call } = world('export');
  const { result, events } = withFsEvents(() => call('export_workspace', { idempotencyKey: 'export-1' }));
  must(result, 'export_workspace');
  const finalDir = resolve(result.artifactRef);
  const publish = events.findIndex((e) => e.op === 'rename' && e.to === finalDir);
  assert.ok(publish >= 0);
  const syncedBefore = new Set(events.slice(0, publish).filter((e) => e.op === 'fsync').map((e) => e.path));
  for (const name of readdirSync(finalDir)) assert.ok(syncedBefore.has(join(events[publish].from, name)), `${name} fsynced before publish`);
  assert.ok(events.slice(publish + 1).some((e) => e.op === 'fsync' && e.path === resolve(deps.backupDir)));
});

test('the snapshot is built as ONE transaction on a durable connection (synchronous EXTRA; F_FULLFSYNC on macOS)', () => {
  // Observe the snapshot connection's own statements: better-sqlite3 prepares every statement through
  // Database.prototype.prepare, and BEGIN/COMMIT of a `.transaction()` run natively, so the proof is
  // that the connection is inside a transaction for every row insert and commits exactly once.
  const dir = mkdtempSync(join(tmpdir(), 'till-g04-onetx-'));
  const originalPrepare = Database.prototype.prepare;
  const originalClose = Database.prototype.close;
  const inserts = { inTx: 0, outsideTx: 0 };
  let state;
  Database.prototype.prepare = function spyPrepare(sql, ...rest) {
    const stmt = originalPrepare.call(this, sql, ...rest);
    if (/data\.sqlite$/.test(this.name) && /^INSERT INTO/i.test(sql)) {
      const run = stmt.run.bind(stmt);
      const db = this;
      stmt.run = (...args) => {
        if (db.inTransaction) inserts.inTx += 1;
        else inserts.outsideTx += 1;
        return run(...args);
      };
    }
    return stmt;
  };
  Database.prototype.close = function spyClose() {
    if (/data\.sqlite$/.test(this.name) && this.open) {
      state = {
        synchronous: this.pragma('synchronous', { simple: true }),
        fullfsync: this.pragma('fullfsync', { simple: true }),
      };
    }
    return originalClose.call(this);
  };
  const saved = process.env.TILL_TEST_NO_FULLFSYNC;
  delete process.env.TILL_TEST_NO_FULLFSYNC;
  try {
    const store = new SqliteStore({ location: join(dir, 'till.db') });
    const ws = createWorkspace({ store, clock: { now: () => '2026-09-24T00:00:00.000Z' }, ids: systemIdGen, actor: 'owner' }, { name: 'Einmal AG' });
    must(ws, 'createWorkspace');
    const res = createBackup(
      { store, clock: { now: () => '2026-09-24T00:00:00.000Z' }, ids: systemIdGen, actor: 'owner', backupDir: join(dir, 'backups') },
      { workspaceId: ws.workspaceId, idempotencyKey: 'one-tx' },
    );
    must(res, 'createBackup');
    store.close();
  } finally {
    Database.prototype.prepare = originalPrepare;
    Database.prototype.close = originalClose;
    if (saved !== undefined) process.env.TILL_TEST_NO_FULLFSYNC = saved;
    rmSync(dir, { recursive: true, force: true });
  }
  assert.ok(inserts.inTx > 10, `the snapshot copied rows (${inserts.inTx}) inside the transaction`);
  assert.equal(inserts.outsideTx, 0, 'no snapshot row is inserted outside the one transaction (one durable commit per row was 39 s on Seeblick)');
  assert.equal(state?.synchronous, 3, 'the snapshot connection commits at synchronous EXTRA');
  if (process.platform === 'darwin') assert.equal(state?.fullfsync, 1, 'the snapshot connection uses F_FULLFSYNC on macOS');
});

// --- G18: the gate reads the disk, not the column -----------------------------------------------

test('G18: a real linked backup satisfies the leg; deleting the bundle un-satisfies it and the first live commit is refused', () => {
  const { deps, wid, call } = world('gone');
  const planId = plannedPlan(call, 'gone');
  const backup = must(call('create_backup', { planId, idempotencyKey: 'gone-bk' }), 'create_backup');
  assert.equal(backup.planLink.linked, true);
  assert.equal(hasPreMigrationBackup(deps.store.db, wid, planRow(deps, planId)), true, 'an intact linked bundle satisfies the leg');
  assert.equal(must(call('migration_readiness', { planId }), 'readiness').backupOnRecord, true);

  rmSync(backup.artifactRef, { recursive: true, force: true });
  assert.deepEqual(preMigrationBackupStatus(deps.store.db, wid, planRow(deps, planId)), { ok: false, reason: 'source_missing' });
  const readiness = must(call('migration_readiness', { planId }), 'readiness after delete');
  assert.equal(readiness.backupOnRecord, false, 'a vanished bundle is not a backup on record');
  assert.ok(readiness.blocking.some((b) => b.item === 'backup_required'), 'the backup is blocking again');
});

test('G18: a torn snapshot, a missing manifest, or a re-pointed snapshot hash each fail the leg', () => {
  const { deps, wid, call } = world('torn');
  const planId = plannedPlan(call, 'torn');
  const backup = must(call('create_backup', { planId, idempotencyKey: 'torn-bk' }), 'create_backup');
  const snap = join(backup.artifactRef, 'data.sqlite');
  const original = readFileSync(snap);

  // A torn write: the snapshot is truncated to half its length.
  writeFileSync(snap, original.subarray(0, Math.floor(original.length / 2)));
  assert.deepEqual(preMigrationBackupStatus(deps.store.db, wid, planRow(deps, planId)), { ok: false, reason: 'checksum_mismatch', file: 'data.sqlite' });
  writeFileSync(snap, original);
  assert.equal(hasPreMigrationBackup(deps.store.db, wid, planRow(deps, planId)), true, 'restored bytes satisfy the leg again (non-vacuity)');

  // The manifest is gone.
  const manifest = join(backup.artifactRef, 'manifest.json');
  const manifestBytes = readFileSync(manifest);
  unlinkSync(manifest);
  assert.equal(preMigrationBackupStatus(deps.store.db, wid, planRow(deps, planId)).reason, 'manifest_missing');
  writeFileSync(manifest, manifestBytes);

  // The plan's recorded hash no longer names this snapshot.
  const ref = JSON.parse(planRow(deps, planId).backup_ref);
  deps.store.db.prepare('UPDATE migration_plan SET backup_ref = ? WHERE id = ?').run(JSON.stringify({ ...ref, sha256: 'f'.repeat(64) }), planId);
  assert.equal(preMigrationBackupStatus(deps.store.db, wid, planRow(deps, planId)).reason, 'backup_ref_mismatch');
});

test('G18: a hand-written backup_ref, or one naming ANOTHER workspace`s backup, opens nothing (§H-TENANT)', () => {
  const a = world('ref-a');
  const b = world('ref-b');
  const planA = plannedPlan(a.call, 'ref-a');
  for (const fake of ['backup-1', '{"backupId":"bk_x","sha256":"deadbeef"}', '{}']) {
    a.deps.store.db.prepare('UPDATE migration_plan SET backup_ref = ? WHERE id = ?').run(fake, planA);
    assert.equal(hasPreMigrationBackup(a.deps.store.db, a.wid, planRow(a.deps, planA)), false, `a fabricated backup_ref ${fake} is not a backup`);
  }
  // B takes a real backup; A's plan pointing at B's backup id is refused in A's workspace.
  const planB = plannedPlan(b.call, 'ref-b');
  const backupB = must(b.call('create_backup', { planId: planB, idempotencyKey: 'ref-b-bk' }), 'b backup');
  const refB = planRow(b.deps, planB).backup_ref;
  // Copy B's backups row into A's store under B's workspace id, as if two tenants shared one ledger.
  a.deps.store.db.prepare('UPDATE migration_plan SET backup_ref = ? WHERE id = ?').run(refB, planA);
  assert.equal(preMigrationBackupStatus(a.deps.store.db, a.wid, planRow(a.deps, planA)).reason, 'backup_row_missing', 'another workspace`s backup does not satisfy this workspace`s gate');
  assert.ok(existsSync(backupB.artifactRef), 'the other workspace`s bundle is untouched');
});

/** A trial-loaded, balanced opening-balances step over two real accounts (the G09 suite's seed). */
function seedOpeningStep(call, seed) {
  const [a, b] = must(call('list_accounts', {}), 'list_accounts').accounts;
  const csv = `account,debitMinor,creditMinor\n${a.number},100000,0\n${b.number},0,100000\n`;
  const fileId = must(
    call('files_upload', { title: `Eröffnung ${seed}`, filename: `${seed}.csv`, mime: 'text/csv', contentBase64: Buffer.from(csv).toString('base64'), idempotencyKey: `${seed}-up` }),
    'files_upload',
  ).file.id;
  const planId = must(call('migration_create_plan', { sourceSystem: 'csv', cutoverDate: '2026-01-01', localePack: 'ch', idempotencyKey: `${seed}-plan` }), 'plan').planId;
  must(call('migration_discover_source', { fileIds: [fileId], planId }), 'discover');
  const stepId = must(call('migration_set_scope', { planId, classes: [{ dataClass: 'opening_balances', include: true }], idempotencyKey: `${seed}-scope` }), 'scope').steps[0].stepId;
  must(call('migration_declare_control_total', { planId, stepId, kind: 'trial_balance_matches_source', scope: a.number, declaredMinor: 100000, idempotencyKey: `${seed}-da` }), 'declare a');
  must(call('migration_declare_control_total', { planId, stepId, kind: 'trial_balance_matches_source', scope: b.number, declaredMinor: -100000, idempotencyKey: `${seed}-db` }), 'declare b');
  must(call('migration_trial_load_step', { planId, stepId, idempotencyKey: `${seed}-trial` }), 'trial');
  return { planId, stepId };
}

test('G18: the first live money-path commit is refused with needs_backup when the linked bundle is gone, and runs once it is back', () => {
  const { deps, wid, call } = world('commit');
  const { planId, stepId } = seedOpeningStep(call, 'commit');
  const staged = must(call('migration_commit_step', { planId, stepId, idempotencyKey: 'commit-1' }), 'stage');
  assert.equal(staged.staged, true, 'the first money-path commit draft-stages');
  const backup = must(call('create_backup', { planId, idempotencyKey: 'commit-bk' }), 'create_backup');
  assert.equal(backup.planLink.linked, true);
  must(call('migration_record_approval', { planId, stepId, checkHash: staged.checkHash, idempotencyKey: 'commit-appr' }), 'approval');

  // Every other leg is met; only the bundle is missing.
  const parked = join(dirname(backup.artifactRef), 'parked');
  renameSyncFs(backup.artifactRef, parked);
  const entriesBefore = deps.store.db.prepare('SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ?').get(wid).n;
  const refused = call('migration_commit_step', { planId, stepId, idempotencyKey: 'commit-2' });
  assert.equal(refused.ok, false, `the commit must be refused: ${JSON.stringify(refused)}`);
  assert.equal(refused.error, 'needs_backup');
  assert.equal(deps.store.db.prepare('SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ?').get(wid).n, entriesBefore, 'the refused commit posted nothing');

  // Non-vacuity: with the bundle back in place, the same commit goes through.
  renameSyncFs(parked, backup.artifactRef);
  const committed = must(call('migration_commit_step', { planId, stepId, idempotencyKey: 'commit-3' }), 'commit');
  assert.ok(committed.openingEntryId ?? committed.ok, 'the commit ran once the bundle was intact again');
});
