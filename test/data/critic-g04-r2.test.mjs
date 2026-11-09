/**
 * Critic probes, G04 restore, round 2 of the joint G04/A31 review (non-author critic, 30.09.2026),
 * against `claude/g04-restore-chokepoint` 2cbbcec3. A test that FAILS there is a finding; the report is
 * `docs/critique/g04-a31-restore-qr-critic-r2.md`. Synthetic data only.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';

import { captureIntake, captureExtract } from '../../dist/core/purchase/index.js';
import { createBackup, restoreBackup } from '../../dist/core/data/portability.js';
import { makeContext } from '../../dist/core/context.js';
import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { fixedClock } from '../../dist/core/clock.js';
import { systemIdGen } from '../../dist/core/ids.js';
import { createWorkspace } from '../../dist/core/setup/index.js';

function must(res, what) {
  assert.equal(res.ok, true, `${what} failed: ${JSON.stringify(res)}`);
  return res;
}

const RASTER = (n) => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, n, n, n, n]).toString('base64');

/** Recompute the manifest checksum after an edit: it is a checksum, not a signature. */
function reseal(artifactRef) {
  const file = join(artifactRef, 'data.sqlite');
  const manifestPath = join(artifactRef, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const bytes = readFileSync(file);
  manifest.files['data.sqlite'] = { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
}

test('R2-M2 probe: the foreign-reference fence also holds a reference that is not a DECLARED foreign key (capture_fields.capture_id)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'g04-critic-r2-'));
  try {
    const clock = fixedClock('2026-07-19T00:00:00.000Z');
    const store = new SqliteStore({ clock });
    const ids = systemIdGen;
    const ctxOf = (name) => {
      const ws = createWorkspace({ store, clock, ids }, { name }).workspaceId;
      return { ws, ctx: makeContext(store, { workspaceId: ws, actor: 'user_1', clock, ids }) };
    };
    const victim = ctxOf('Opfer GmbH');
    const other = ctxOf('Andere GmbH');

    // The victim has a raster capture waiting for its first value.
    const victimCapture = must(captureIntake(victim.ctx, { contentBase64: RASTER(1), mime: 'image/png', filename: 'a.png', idempotencyKey: 'a' }), 'intake').captureId;
    // The other tenant has one with a typed amount.
    const otherCapture = must(captureIntake(other.ctx, { contentBase64: RASTER(2), mime: 'image/png', filename: 'b.png', idempotencyKey: 'b' }), 'intake').captureId;
    must(captureExtract(other.ctx, { captureId: otherCapture, source: 'operator', fields: [{ key: 'amount', value: { minor: 100, currency: 'CHF' } }], idempotencyKey: 'x' }), 'extract');

    const deps = { store, clock, ids, actor: 'user_1', backupDir: join(dir, 'b') };
    const bkp = must(createBackup(deps, { workspaceId: other.ws, idempotencyKey: 'bk' }), 'create_backup');
    // The file's holder re-points the typed field at the VICTIM's capture. `capture_id` declares no
    // foreign key, so `assertReferencesStayInside` (declared keys only) never looks at it.
    const snap = new Database(join(bkp.artifactRef, 'data.sqlite'));
    snap.prepare('UPDATE capture_fields SET capture_id = ? WHERE capture_id = ?').run(victimCapture, otherCapture);
    snap.close();
    reseal(bkp.artifactRef);

    const restored = restoreBackup(deps, { source: bkp.artifactRef, newWorkspaceName: 'Kopie AG', confirmed: true });
    if (!restored.ok) return; // a clean refusal is the fix
    // What the crossing costs the victim: `capture_fields_live (capture_id, key) WHERE superseded = 0` is a
    // GLOBAL unique index, so the victim can no longer record an amount on its own capture.
    let victimExtract;
    try {
      victimExtract = captureExtract(victim.ctx, { captureId: victimCapture, source: 'operator', fields: [{ key: 'amount', value: { minor: 5000, currency: 'CHF' } }], idempotencyKey: 'v' });
    } catch (e) {
      victimExtract = { ok: false, thrown: String(e) };
    }
    const planted = store.db
      .prepare('SELECT COUNT(*) AS n FROM capture_fields WHERE workspace_id = ? AND capture_id = ?')
      .get(restored.workspaceId, victimCapture).n;
    assert.equal(planted, 0, `the restored copy holds ${planted} field row(s) on ANOTHER tenant's capture; the victim's own extract then returns ${JSON.stringify(victimExtract)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('R2 check (R1-M2 held): the dial reset touches only the copy, beside the original and into an empty book', async () => {
  const { enableSyncPublish } = await import('../../dist/core/sync/index.js');
  const dir = mkdtempSync(join(tmpdir(), 'g04-critic-r2-'));
  try {
    const clock = fixedClock('2026-07-19T00:00:00.000Z');
    const store = new SqliteStore({ clock });
    const ws = createWorkspace({ store, clock, ids: systemIdGen }, { name: 'Quelle AG' }).workspaceId;
    const ctx = makeContext(store, { workspaceId: ws, actor: 'user_1', clock, ids: systemIdGen });
    must(enableSyncPublish(ctx, { idempotencyKey: 'pub' }), 'enable');
    const state = (s, id) => s.db.prepare('SELECT publishing, epoch FROM sync_publish_state WHERE workspace_id = ?').get(id);
    const src = state(store, ws);
    const deps = { store, clock, ids: systemIdGen, actor: 'user_1', backupDir: join(dir, 'b') };
    const bkp = must(createBackup(deps, { workspaceId: ws, idempotencyKey: 'bk' }), 'create_backup');
    const beside = must(restoreBackup(deps, { source: bkp.artifactRef, newWorkspaceName: 'Kopie AG', confirmed: true }), 'restore beside');
    assert.deepEqual(state(store, ws), src, 'the original keeps its dial and epoch');
    assert.equal(state(store, beside.workspaceId).publishing, 0);
    assert.notEqual(state(store, beside.workspaceId).epoch, src.epoch);
    const empty = new SqliteStore({ clock });
    const into = must(restoreBackup({ ...deps, store: empty, backupDir: join(dir, 'c') }, { source: bkp.artifactRef, newWorkspaceName: 'Neu AG', confirmed: true }), 'restore into empty');
    assert.equal(state(empty, into.workspaceId).publishing, 0);
    assert.notEqual(state(empty, into.workspaceId).epoch, src.epoch);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
