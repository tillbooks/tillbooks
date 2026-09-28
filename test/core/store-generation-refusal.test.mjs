/**
 * THE GENERATION GUARD (critic finding M3): an older TILL never writes a book a newer TILL wrote.
 *
 * `PRAGMA user_version` is the book's schema generation and `SCHEMA_GENERATION` is the one this build
 * knows. Before this suite the store's migration step returned silently on a book ABOVE that, so an
 * older build opened it writable, ran its own DDL over it and carried on writing rows whose meaning it
 * did not know. The rule now lives in `src/core/store/generation.ts` and is asserted here:
 *
 *   1. A writable open of a newer book throws the typed refusal (`schema_newer_than_runtime`, with
 *      `{bookGeneration, buildGeneration, path}`) and leaves the main file and any -wal byte-for-byte
 *      unchanged: at most an empty -wal and a -shm on a quiet book (they hold no data; critic R2-5),
 *      and neither the main file nor a live newer writer's WAL touched when the newer TILL still has
 *      it open. The newer book here is also a different SHAPE
 *      (an index this build would re-create), so a check placed after the schema DDL fails the hash.
 *   2. A book at the current generation, an older one and a brand-new file still open, and the older
 *      one migrates forward as before.
 *   3. `verify_backup` and `restore_backup` refuse a bundle whose SNAPSHOT file is newer, before
 *      anything is created, and the target ledger file is untouched.
 *   4. Every other writable entrypoint that can be reached from a test refuses too: `makeApiDeps`
 *      (the door `till mcp`, `till serve` and `till up` share), `startHttpServer`, `startUp` (which
 *      also releases its single-instance lock), and the `till mcp` / `till serve` / `till up` commands,
 *      which print the sentence and exit 1 instead of a stack trace.
 *   5. A book that moves on UNDER an open store (a newer TILL migrates it while this one still holds
 *      it) is caught at the next write: `SqliteStore.tx` reads the marker as its first statement,
 *      under the write lock, so the write is refused before it runs, and a verb reports
 *      `schema_newer_than_runtime`.
 *   6. The AGENT SEAT (critic R1 F1): the A35 governed dispatch (`callTool`, `handleRest`, and the real
 *      `till mcp` over stdio) writes trace rows and drafts of its own. A moved-on book is refused at
 *      the seam with no trace or draft row, including when the book moves on in the middle of a call.
 *   7. A transaction runs only on a snapshot whose generation this build knows, and a backup or
 *      export that races a newer TILL leaves neither a row nor a published bundle (critic R1 F2).
 *   8. The open's schema pass runs in ONE transaction whose first statement reads the marker: a newer
 *      TILL committing in the middle of it gets no DDL from this build and its marker is never
 *      lowered (critic R1 F3).
 *   9. A newer TILL that CRASHED with its marker bump still in the -wal: the refused open reads it
 *      through a read-only connection and leaves the main file and the -wal byte-for-byte as they
 *      were (critic R1 F4).
 *  10. The remaining windows (critic R1 F6): a backup snapshot OLDER than its manifest is refused by
 *      exact match, and the writers that bypassed `store.tx` (contact merge, anonymise and import on
 *      their key-less path, the automation run log) now meet the generation guard too.
 *  11. The money writes that were bare autocommit statements (critic R2-4) are one IMMEDIATE
 *      transaction each, so a newer TILL that starts its migration mid-verb waits for the verb and
 *      then migrates what it wrote; and a refusal raised after the call had already committed says
 *      so (`partial: true`), never that the book was not changed.
 *
 * Every book here is synthetic, created from scratch in a temp directory. No git is run.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, openSync, readFileSync, readdirSync, readSync, closeSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';

import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { SCHEMA_GENERATION } from '../../dist/core/store/schema.js';
import {
  SCHEMA_NEWER_THAN_RUNTIME,
  SchemaNewerThanRuntimeError,
  newerGenerationRefusal,
} from '../../dist/core/store/generation.js';
import { makeApiDeps, callTool } from '../../dist/api/mcp.js';
import { handleRest } from '../../dist/api/rest.js';
import { startHttpServer } from '../../dist/api/serve.js';
import { startUp } from '../../dist/api/up.js';
import { lockPath } from '../../dist/api/up-lock.js';
import { getAction } from '../../dist/api/registry.js';
import { createWorkspace } from '../../dist/core/setup/workspace.js';
import { fixedClock } from '../../dist/core/clock.js';
import { sequenceIdGen, systemIdGen } from '../../dist/core/ids.js';
import { freshDeps, mintWorkspace, manualPost } from '../api/support.mjs';
import { makeContext } from '../../dist/core/context.js';
import { mergeContacts, anonymiseContact } from '../../dist/core/sales/contactMerge.js';
import { importContacts } from '../../dist/core/sales/contactImport.js';
import { dispatchAutomationEvent } from '../../dist/core/automation/index.js';
import { lockHolder } from '../support/lock-holder.mjs';

const CLI = fileURLToPath(new URL('../../bin/till.mjs', import.meta.url));
const AT = '2026-09-25T00:00:00.000Z';
const NEWER = SCHEMA_GENERATION + 1;

/**
 * An index the current schema creates (`CREATE INDEX IF NOT EXISTS`). A newer book without it is a
 * newer SHAPE: this build's DDL would put it back, so an open that ran any DDL before refusing
 * changes the file, and the byte-for-byte assertions catch it.
 */
const INDEX_THIS_BUILD_WOULD_RECREATE = 'journal_line_entry';

function tempDir(prefix = 'till-gen-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

function sha(path) {
  return existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : null;
}

/** The book's file and its two WAL sidecars, as hashes (null = the file does not exist). */
function fileState(path) {
  return { main: sha(path), wal: sha(`${path}-wal`), shm: sha(`${path}-shm`) };
}

const EMPTY_FILE = createHash('sha256').update('').digest('hex');

/**
 * What a refused open promises (critic R2-5): the main file and any -wal that existed are
 * byte-for-byte as they were. On a QUIET book the read-only look may leave an empty -wal and a -shm;
 * they hold no data (the -shm is the WAL's index), and removing them takes a writable connection whose
 * close can fold a newer writer's crashed WAL into the book, so the store leaves them.
 */
function assertUntouched(path, before, what) {
  const after = fileState(path);
  assert.equal(after.main, before.main, `${what}: the main file is byte-for-byte unchanged`);
  if (before.wal === null) {
    assert.ok(after.wal === null || after.wal === EMPTY_FILE, `${what}: no -wal content appeared`);
  } else {
    assert.equal(after.wal, before.wal, `${what}: the -wal is byte-for-byte unchanged`);
  }
}

/** user_version straight from the header bytes (offset 60), without opening a connection. */
function headerGeneration(path) {
  const fd = openSync(path, 'r');
  try {
    const header = Buffer.alloc(64);
    readSync(fd, header, 0, 64, 0);
    return header.readUInt32BE(60);
  } finally {
    closeSync(fd);
  }
}

/** A real, synthetic book at the current generation: one workspace, written by this build. */
function makeBook(dir, name = 'book.db') {
  const path = join(dir, name);
  const store = new SqliteStore({ location: path, clock: fixedClock(AT) });
  const created = createWorkspace(
    { store, clock: fixedClock(AT), ids: systemIdGen, actor: 'owner' },
    { name: 'Beispiel Treuhand AG' },
  );
  assert.equal(created.ok, true, JSON.stringify(created));
  store.close();
  return path;
}

/**
 * Turn a current book into one a NEWER build wrote: bump the marker and drop an index this build
 * would re-create. Checkpointed and closed, so the book is quiet (no -wal/-shm on disk).
 */
function makeNewer(path, generation = NEWER) {
  const raw = new Database(path);
  raw.pragma(`user_version = ${generation}`);
  raw.exec(`DROP INDEX IF EXISTS ${INDEX_THIS_BUILD_WOULD_RECREATE}`);
  raw.pragma('wal_checkpoint(TRUNCATE)');
  raw.close();
}

function assertRefusal(e, path, generation = NEWER) {
  assert.ok(e instanceof SchemaNewerThanRuntimeError, `expected the typed refusal, got ${e}`);
  assert.equal(e.code, SCHEMA_NEWER_THAN_RUNTIME);
  assert.equal(e.code, 'schema_newer_than_runtime', 'the stable code M00/M02/M03 and the Studio name');
  assert.equal(e.bookGeneration, generation);
  assert.equal(e.buildGeneration, SCHEMA_GENERATION);
  assert.equal(e.path, path);
  assert.match(e.message, new RegExp(`newer TILL \\(generation ${generation}\\)`));
  assert.match(e.message, new RegExp(`This TILL knows generation ${SCHEMA_GENERATION}`));
  assert.match(e.message, /Update TILL before opening it/);
  return true;
}

// --- 0. the one comparison ----------------------------------------------------------------------

test('the one comparison: only a generation ABOVE the build is refused', () => {
  assert.equal(newerGenerationRefusal(0, '/x'), null, 'a pre-generation book migrates forward');
  assert.equal(newerGenerationRefusal(SCHEMA_GENERATION - 1, '/x'), null);
  assert.equal(newerGenerationRefusal(SCHEMA_GENERATION, '/x'), null);
  assert.deepEqual(newerGenerationRefusal(NEWER, '/x'), {
    bookGeneration: NEWER,
    buildGeneration: SCHEMA_GENERATION,
    path: '/x',
  });
});

// --- 1. the store open ---------------------------------------------------------------------------

test('a writable open of a newer book is refused with the typed code, and the file is left byte-for-byte unchanged', () => {
  const dir = tempDir();
  try {
    const path = makeBook(dir);
    makeNewer(path);
    const before = fileState(path);
    assert.equal(before.wal, null, 'premise: the newer book is quiet, no WAL on disk');
    assert.equal(before.shm, null, 'premise: no shared-memory file on disk');
    assert.equal(headerGeneration(path), NEWER, 'premise: the header says the newer generation');

    assert.throws(() => new SqliteStore({ location: path }), (e) => assertRefusal(e, path));

    assertUntouched(path, before, 'the refused open');
    assert.equal(headerGeneration(path), NEWER, 'the marker was not rewritten downward');

    // A second attempt is refused the same way (nothing about the first one changed the book).
    assert.throws(() => new SqliteStore({ location: path }), (e) => assertRefusal(e, path));
    assertUntouched(path, before, 'the second refused open');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a newer TILL still holding the book open: the refusal reads the WAL, and neither the main file nor that WAL is touched', () => {
  // The realistic skew: a newer `till up` is running while an older `till mcp` is spawned. The newer
  // writer's last commit (the marker bump) sits in its WAL, NOT yet in the main file's header, so the
  // check must read through SQLite rather than the raw header bytes.
  const dir = tempDir();
  const path = makeBook(dir);
  const holder = new Database(path);
  try {
    holder.pragma('wal_autocheckpoint = 0');
    holder.pragma(`user_version = ${NEWER}`);
    holder.exec(`DROP INDEX IF EXISTS ${INDEX_THIS_BUILD_WOULD_RECREATE}`);
    assert.equal(headerGeneration(path), SCHEMA_GENERATION, 'premise: the main file header is still the old generation');
    const before = fileState(path);
    assert.notEqual(before.wal, null, 'premise: the newer generation lives in the live WAL');

    assert.throws(() => new SqliteStore({ location: path }), (e) => assertRefusal(e, path));

    const after = fileState(path);
    assert.equal(after.main, before.main, 'the main file is byte-for-byte unchanged');
    assert.equal(after.wal, before.wal, 'the newer writer\'s WAL is byte-for-byte unchanged');
    assert.equal(holder.pragma('user_version', { simple: true }), NEWER, 'the newer writer carries on unaffected');
  } finally {
    holder.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- 2. what must still open ---------------------------------------------------------------------

test('a book at the current generation, an older one and a brand-new file still open; the older one migrates forward', () => {
  const dir = tempDir();
  try {
    const current = makeBook(dir, 'current.db');
    const reopened = new SqliteStore({ location: current });
    assert.equal(reopened.db.pragma('user_version', { simple: true }), SCHEMA_GENERATION);
    assert.equal(reopened.db.prepare('SELECT COUNT(*) AS n FROM workspace').get().n, 1, 'the book reads as it was');
    reopened.close();

    for (const generation of [0, SCHEMA_GENERATION - 1]) {
      const older = makeBook(dir, `older-${generation}.db`);
      const raw = new Database(older);
      raw.pragma(`user_version = ${generation}`);
      raw.close();
      const store = new SqliteStore({ location: older });
      assert.equal(
        store.db.pragma('user_version', { simple: true }),
        SCHEMA_GENERATION,
        `a generation-${generation} book migrates forward to ${SCHEMA_GENERATION} on open, as before`,
      );
      store.close();
    }

    const fresh = join(dir, 'fresh.db');
    const created = new SqliteStore({ location: fresh });
    assert.equal(created.db.pragma('user_version', { simple: true }), SCHEMA_GENERATION, 'a brand-new book is stamped current');
    created.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- 3. restore ------------------------------------------------------------------------------------

/**
 * A synthetic `.tillbackup` whose SNAPSHOT file a newer TILL wrote, while its manifest still claims
 * the current generation (and every checksum is consistent). G04's manifest exact-match alone would
 * wave it through; the snapshot's own marker must not.
 */
function newerSnapshotBundle(backupDir) {
  const deps = freshDeps();
  deps.backupDir = backupDir;
  const { workspaceId, accId } = mintWorkspace(deps, 'Quelle Beispiel GmbH');
  const posted = getAction('post_entry').run(deps, { workspaceId, ...manualPost(accId, 'p-1', 4200) });
  assert.equal(posted.ok, true, JSON.stringify(posted));
  const backup = getAction('create_backup').run(deps, { workspaceId, idempotencyKey: 'bkp' });
  assert.equal(backup.ok, true, JSON.stringify(backup));
  deps.store.close();

  const source = backup.artifactRef;
  const snapshot = join(source, 'data.sqlite');
  const raw = new Database(snapshot);
  raw.pragma(`user_version = ${NEWER}`);
  raw.close();
  const manifestPath = join(source, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  assert.equal(manifest.schemaVersion, SCHEMA_GENERATION, 'premise: the manifest still claims the current generation');
  manifest.files['data.sqlite'].sha256 = sha(snapshot);
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return { source, snapshot };
}

test('verify_backup and restore_backup refuse a bundle whose snapshot is newer, before anything is created, and the target is untouched', () => {
  const dir = tempDir();
  try {
    const { source, snapshot } = newerSnapshotBundle(join(dir, 'backups'));
    const snapshotBefore = sha(snapshot);

    // The restore TARGET is a real ledger file, so "untouched" is a byte statement, not a row count.
    const targetPath = join(dir, 'target.db');
    const store = new SqliteStore({ location: targetPath, clock: fixedClock(AT) });
    const deps = { store, clock: fixedClock(AT), ids: sequenceIdGen(), actor: 'agent', backupDir: join(dir, 'backups') };
    mintWorkspace(deps, 'Ziel Beispiel AG');
    store.checkpoint();
    const targetBefore = fileState(targetPath);
    const workspacesBefore = store.db.prepare('SELECT COUNT(*) AS n FROM workspace').get().n;

    const verify = getAction('verify_backup').run(deps, { source });
    assert.equal(verify.ok, false, 'verify must refuse a newer snapshot');
    assert.equal(verify.error, SCHEMA_NEWER_THAN_RUNTIME);
    assert.equal(verify.bookGeneration, NEWER);
    assert.equal(verify.buildGeneration, SCHEMA_GENERATION);
    assert.equal(verify.path, snapshot);

    for (const confirmed of [false, true]) {
      const restore = getAction('restore_backup').run(deps, {
        source,
        newWorkspaceName: 'Wiederhergestellt',
        confirmed,
        idempotencyKey: `rb-${confirmed}`,
      });
      assert.equal(restore.ok, false, `restore (confirmed=${confirmed}) must refuse, not stage a plan`);
      assert.equal(restore.error, SCHEMA_NEWER_THAN_RUNTIME);
      assert.equal(restore.bookGeneration, NEWER);
      assert.equal(restore.buildGeneration, SCHEMA_GENERATION);
    }

    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM workspace').get().n, workspacesBefore, 'no workspace was minted');
    assert.equal(
      store.db.prepare("SELECT COUNT(*) AS n FROM idempotency WHERE verb = 'restore_backup'").get().n,
      0,
      'a refused restore records no idempotency row',
    );
    assert.deepEqual(fileState(targetPath), targetBefore, 'the target ledger file is byte-for-byte unchanged');
    assert.equal(sha(snapshot), snapshotBefore, 'the bundle itself is left as it was');
    store.close();

    // G04's own rule still runs first and still owns the manifest's claim (spec §0a.6).
    const manifestPath = join(source, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.schemaVersion = NEWER;
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    const byManifest = getAction('verify_backup').run(deps, { source });
    assert.equal(byManifest.error, 'incompatible_schema_version');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- 4. every other writable entrypoint reachable from a test --------------------------------------

test('makeApiDeps, the door till mcp, till serve and till up share, refuses a newer book', () => {
  const dir = tempDir();
  try {
    const path = makeBook(dir);
    makeNewer(path);
    const before = fileState(path);
    assert.throws(() => makeApiDeps(path), (e) => assertRefusal(e, path));
    assertUntouched(path, before, 'the refused entrypoint');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A promise's outcome as a value, so a start that wrongly SUCCEEDS can still be closed. */
async function settle(promise) {
  try {
    return { value: await promise };
  } catch (error) {
    return { error };
  }
}

test('startHttpServer (till serve) refuses before it binds, and startUp (till up) refuses and releases its lock', async () => {
  const dir = tempDir();
  // A server that started when it should have refused is closed here, so a failing run reports its
  // assertion instead of hanging the runner on a listening socket.
  const started = [];
  try {
    const path = makeBook(dir);
    makeNewer(path);
    const before = fileState(path);

    const serve = await settle(startHttpServer({ dbPath: path, host: '127.0.0.1', port: 0, log: () => {} }));
    if (serve.value !== undefined) started.push(serve.value);
    assert.ok(serve.error !== undefined, 'startHttpServer must refuse, not start');
    assertRefusal(serve.error, path);

    const supportDir = join(dir, 'support');
    const up = await settle(
      startUp({ dbPath: path, host: '127.0.0.1', port: 0, supportDir, studioDir: null, open: false, log: () => {} }),
    );
    if (up.value?.started) started.push(up.value);
    assert.ok(up.error !== undefined, 'startUp must refuse, not start');
    assertRefusal(up.error, path);
    assert.equal(existsSync(lockPath(supportDir)), false, 'a refused till up does not keep the single-instance lock');
    assertUntouched(path, before, 'the refused entrypoint');
  } finally {
    for (const handle of started) await handle.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Run the real `till` command against a book, with its own support dir, and always reap it. A
 * command that was NOT refused would serve until killed, so the timeout is the failure path, not a
 * flake guard.
 */
function runTill(args, env, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += String(c)));
    child.stderr.on('data', (c) => (stderr += String(c)));
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.once('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

test('the till commands print the sentence and exit 1, never a stack trace, and leave the book as it was', async () => {
  const dir = tempDir();
  try {
    const path = makeBook(dir);
    makeNewer(path);
    const before = fileState(path);
    const env = {
      TILL_DB_PATH: path,
      TILL_SUPPORT_DIR: join(dir, 'support'),
      TILL_BACKUP_DIR: join(dir, 'backups'),
      TILL_NO_OPEN: '1',
      TILL_PORT: String(20_000 + Math.floor(Math.random() * 20_000)),
    };

    for (const command of ['mcp', 'serve', 'up']) {
      const run = await runTill([command], env);
      assert.equal(run.signal, null, `till ${command} must refuse on its own, not run until killed: ${run.stderr}`);
      assert.equal(run.code, 1, `till ${command} exits non-zero: ${run.stderr}`);
      assert.match(run.stderr, new RegExp(`This book was written by a newer TILL \\(generation ${NEWER}\\)`));
      assert.match(run.stderr, new RegExp(`This TILL knows generation ${SCHEMA_GENERATION}\\. Update TILL before opening it\\.`));
      assert.ok(run.stderr.includes(path), `till ${command} names the book`);
      assert.doesNotMatch(run.stderr, /\n\s+at |node:internal|SchemaNewerThanRuntimeError:/, 'a sentence, not a stack trace');
      assert.equal(run.stdout, '', `till ${command} keeps stdout clean (the MCP channel for till mcp)`);
      assertUntouched(path, before, `till ${command}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- 5. the book moves on under an open store ------------------------------------------------------

test('a newer TILL migrates the book while this store has it open: the next write is refused and rolled back', () => {
  const dir = tempDir();
  const path = makeBook(dir);
  // Connection A is THIS build, long-lived (a `till mcp` that was already running). Connection B is
  // the newer TILL that opens the same file and migrates it to a generation A does not know.
  const a = new SqliteStore({ location: path, clock: fixedClock(AT) });
  const b = new Database(path);
  try {
    const deps = { store: a, clock: fixedClock(AT), ids: sequenceIdGen(), actor: 'agent' };
    const { workspaceId, accId } = mintWorkspace(deps, 'Laufend Beispiel GmbH');
    const post = (key) => getAction('post_entry').run(deps, { workspaceId, ...manualPost(accId, key, 1200) });
    assert.equal(post('before').ok, true, 'premise: A writes normally while the book is its own generation');

    b.pragma(`user_version = ${NEWER}`);
    assert.equal(b.pragma('user_version', { simple: true }), NEWER, 'premise: B committed the newer generation');

    const count = (sql) => b.prepare(sql).get().n;
    const entriesBefore = count('SELECT COUNT(*) AS n FROM journal_entry');
    const idempotencyBefore = count('SELECT COUNT(*) AS n FROM idempotency');
    const nameBefore = b.prepare('SELECT name FROM workspace WHERE id = ?').get(workspaceId).name;
    const before = fileState(path);

    // The money path, through the registry both faces share: a typed refusal, not unexpected_error.
    const refused = post('after');
    assert.equal(refused.ok, false, 'post_entry must not commit into a book a newer TILL migrated');
    assert.equal(refused.error, SCHEMA_NEWER_THAN_RUNTIME);
    assert.equal(refused.bookGeneration, NEWER);
    assert.equal(refused.buildGeneration, SCHEMA_GENERATION);
    assert.equal(refused.path, path);

    // The store primitives themselves: tx and rememberIdempotent throw the typed refusal.
    assert.throws(
      () => a.tx(() => a.db.prepare('UPDATE workspace SET name = ? WHERE id = ?').run('Umbenannt', workspaceId)),
      (e) => assertRefusal(e, path),
    );
    assert.throws(
      () =>
        a.rememberIdempotent(workspaceId, 'k-after', 'synthetic_verb', () => {
          a.db.prepare('UPDATE workspace SET name = ? WHERE id = ?').run('Umbenannt', workspaceId);
          return { ok: true };
        }),
      (e) => assertRefusal(e, path),
    );

    // A verb that writes one statement at a time, outside any transaction of its own: the registry's
    // pre-check refuses it here, and the connection's write chokepoint would refuse each statement
    // under the lock if the book moved on after that check (store-write-chokepoint.test.mjs).
    const vatBefore = b.prepare('SELECT vat_method, vat_accounting FROM workspace WHERE id = ?').get(workspaceId);
    const vat = getAction('set_vat_method').run(deps, { workspaceId, vatMethod: 'effektiv', vatAccounting: 'soll' });
    assert.equal(vat.ok, false, 'an autocommit write verb must not land either');
    assert.equal(vat.error, SCHEMA_NEWER_THAN_RUNTIME);
    assert.deepEqual(b.prepare('SELECT vat_method, vat_accounting FROM workspace WHERE id = ?').get(workspaceId), vatBefore);

    // A pre-workspace write: `create_workspace` without a key mints through autocommit statements.
    const workspacesBefore = count('SELECT COUNT(*) AS n FROM workspace');
    const minted = getAction('create_workspace').run(deps, { name: 'Zweite Beispiel AG' });
    assert.equal(minted.ok, false, 'a pre-workspace write must not land either');
    assert.equal(minted.error, SCHEMA_NEWER_THAN_RUNTIME);
    assert.equal(count('SELECT COUNT(*) AS n FROM workspace'), workspacesBefore, 'no workspace was minted');

    // A read is refused too: a newer generation may have changed what the numbers it returns mean.
    const read = getAction('list_accounts').run(deps, { workspaceId });
    assert.equal(read.ok, false, 'a workspace read of a book that moved on is refused, not misread');
    assert.equal(read.error, SCHEMA_NEWER_THAN_RUNTIME);

    // Everything A attempted was rolled back: the rows, the idempotency records and the bytes.
    assert.equal(count('SELECT COUNT(*) AS n FROM journal_entry'), entriesBefore, 'no entry was posted');
    assert.equal(count('SELECT COUNT(*) AS n FROM idempotency'), idempotencyBefore, 'no idempotency row was recorded');
    assert.equal(b.prepare('SELECT name FROM workspace WHERE id = ?').get(workspaceId).name, nameBefore);
    const after = fileState(path);
    assert.equal(after.main, before.main, 'the main file is byte-for-byte unchanged');
    assert.equal(after.wal, before.wal, 'the WAL is byte-for-byte unchanged: nothing was committed');
  } finally {
    a.close();
    b.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- 6. the agent seat (critic R1 F1) ---------------------------------------------------------------

/** The A35 rows the governed dispatch writes on its own: trace and drafts. */
function agentRows(db) {
  return db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM agent_session) AS sessions, (SELECT COUNT(*) FROM agent_turn) AS turns,
              (SELECT COUNT(*) FROM agent_call) AS calls, (SELECT COUNT(*) FROM agent_action) AS drafts`,
    )
    .get();
}

/** An agent-seat world over a real book: `makeApiDeps` is the `till mcp` door, actor `agent`. */
function agentWorld(dir) {
  const path = join(dir, 'book.db');
  const { deps, store } = makeApiDeps(path);
  assert.equal(deps.actor, 'agent', 'premise: the till mcp door seats the agent');
  const tool = (name, args) => JSON.parse(callTool(deps, name, args).content[0].text);
  const ws = tool('create_workspace', { name: 'Agent Beispiel AG', idempotencyKey: 'ws' });
  assert.equal(ws.ok, true, JSON.stringify(ws));
  const accId = (n) => store.db.prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?').get(ws.workspaceId, n).id;
  const post = (key) => ({ workspaceId: ws.workspaceId, ...manualPost(accId, key, 700) });
  return { path, deps, store, tool, workspaceId: ws.workspaceId, post };
}

test('F1: the agent seat over callTool and handleRest refuses a moved-on book and writes no trace or draft row', () => {
  const dir = tempDir();
  const w = agentWorld(dir);
  const b = new Database(w.path);
  try {
    assert.equal(w.tool('list_accounts', { workspaceId: w.workspaceId }).ok, true, 'premise: the agent reads normally');
    b.pragma(`user_version = ${NEWER}`);
    const rowsBefore = agentRows(b);
    const before = fileState(w.path);
    // The seam refuses BEFORE it records: a refusal is an answer, not a recorder failure, so nothing
    // lands in diagnostics either.
    const diagnostics = [];
    w.deps.diagnostics = { record: (entry) => diagnostics.push(entry) };

    const read = w.tool('list_accounts', { workspaceId: w.workspaceId });
    assert.equal(read.error, SCHEMA_NEWER_THAN_RUNTIME, 'a read over MCP is refused');
    const write = w.tool('post_entry', w.post('after-mcp'));
    assert.equal(write.ok, false, 'post_entry over MCP must not report a draft or a post');
    assert.equal(write.error, SCHEMA_NEWER_THAN_RUNTIME);
    assert.equal(write.bookGeneration, NEWER);
    const rest = handleRest('post_entry', w.post('after-rest'), w.deps);
    assert.equal(rest.status, 422);
    assert.equal(rest.body.error, SCHEMA_NEWER_THAN_RUNTIME, 'the REST face on the agent seat refuses the same way');
    const minted = w.tool('create_workspace', { name: 'Neu Beispiel AG', idempotencyKey: 'ws-after' });
    assert.equal(minted.error, SCHEMA_NEWER_THAN_RUNTIME, 'a pre-workspace write over the agent seat is refused');

    assert.deepEqual(agentRows(b), rowsBefore, 'no trace row and no draft was written into the newer book');
    assert.deepEqual(
      diagnostics.map((d) => d.code),
      [],
      'the seam answered before any recorder ran: no agent_trace_failed or verb_error entries',
    );
    const after = fileState(w.path);
    assert.equal(after.main, before.main);
    assert.equal(after.wal, before.wal, 'nothing was committed');
  } finally {
    b.close();
    w.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * The book moves on in the MIDDLE of an agent call: right after the seam's own check passed. The
 * store's check is wrapped so its first call (the seam) passes and then the newer TILL commits, which
 * is the window the trace and draft transactions exist to close.
 */
function moveOnAfterFirstCheck(store, b) {
  const original = store.assertGenerationKnown.bind(store);
  let armed = true;
  store.assertGenerationKnown = () => {
    original();
    if (armed) {
      armed = false;
      b.pragma(`user_version = ${NEWER}`);
    }
  };
  return () => delete store.assertGenerationKnown;
}

test('F1: a book that moves on during an agent call gets neither the draft nor the trace row', () => {
  const dir = tempDir();
  const w = agentWorld(dir);
  const b = new Database(w.path);
  try {
    // The draft path: post_entry at the default `ask` dial queues a Vorschlag instead of posting.
    let restore = moveOnAfterFirstCheck(w.store, b);
    let rowsBefore = agentRows(b);
    const drafted = w.tool('post_entry', w.post('mid-draft'));
    restore();
    assert.equal(drafted.ok, false, `the draft must not be queued into the newer book: ${JSON.stringify(drafted)}`);
    assert.equal(drafted.error, SCHEMA_NEWER_THAN_RUNTIME);
    assert.deepEqual(agentRows(b), rowsBefore, 'no draft and no trace row');

    // The trace path: a read whose verb is refused still gets recorded by the seam, unless the trace
    // write is itself guarded.
    b.pragma(`user_version = ${SCHEMA_GENERATION}`);
    restore = moveOnAfterFirstCheck(w.store, b);
    rowsBefore = agentRows(b);
    const read = w.tool('list_accounts', { workspaceId: w.workspaceId });
    restore();
    assert.equal(read.error, SCHEMA_NEWER_THAN_RUNTIME);
    assert.deepEqual(agentRows(b), rowsBefore, 'no trace row for a call into the newer book');
  } finally {
    b.close();
    w.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('F1: the real till mcp over stdio refuses a book moved on under it, with no trace or draft row', async () => {
  const dir = tempDir();
  const path = join(dir, 'book.db');
  const child = spawn(process.execPath, [CLI, 'mcp'], {
    env: { ...process.env, TILL_DB_PATH: path, TILL_SUPPORT_DIR: join(dir, 'support'), TILL_BACKUP_DIR: join(dir, 'bk') },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buf = '';
  let stderr = '';
  const waiters = new Map();
  child.stderr.on('data', (c) => (stderr += String(c)));
  child.stdout.on('data', (c) => {
    buf += String(c);
    for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.trim() === '') continue;
      const msg = JSON.parse(line);
      waiters.get(msg.id)?.(msg);
    }
  });
  let id = 0;
  const rpc = (method, params) =>
    new Promise((resolve, reject) => {
      const n = ++id;
      const timer = setTimeout(() => reject(new Error(`till mcp went quiet on ${method}: ${stderr}`)), 20_000);
      waiters.set(n, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n');
    });
  const tool = async (name, args) => JSON.parse((await rpc('tools/call', { name, arguments: args })).result.content[0].text);
  let b;
  try {
    await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'generation-suite', version: '0' } });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const ws = await tool('create_workspace', { name: 'Stdio Beispiel AG', idempotencyKey: 'ws' });
    const accounts = await tool('list_accounts', { workspaceId: ws.workspaceId });
    const idOf = (n) => accounts.accounts.find((a) => a.number === n).id;
    b = new Database(path);
    b.pragma(`user_version = ${NEWER}`);
    const rowsBefore = agentRows(b);

    const read = await tool('list_accounts', { workspaceId: ws.workspaceId });
    const write = await tool('post_entry', {
      workspaceId: ws.workspaceId, date: '2026-03-01', description: 'Nach dem Update', source: 'manual', idempotencyKey: 'p2',
      lines: [{ account: idOf('6500'), debit: 700 }, { account: idOf('1000'), credit: 700 }],
    });
    assert.equal(read.error, SCHEMA_NEWER_THAN_RUNTIME, `till mcp read: ${JSON.stringify(read)}`);
    assert.equal(write.ok, false, `till mcp must not answer drafted/posted: ${JSON.stringify(write)}`);
    assert.equal(write.error, SCHEMA_NEWER_THAN_RUNTIME);
    assert.deepEqual(agentRows(b), rowsBefore, 'the running till mcp wrote no trace or draft row into the newer book');
  } finally {
    b?.close();
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill('SIGTERM');
      await exited;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- 7. the snapshot a transaction runs on, and bundles without rows (critic R1 F2) -----------------

test('F2: tx reads the marker FIRST, so fn never runs on a snapshot a newer TILL wrote', () => {
  const dir = tempDir();
  const path = makeBook(dir);
  const a = new SqliteStore({ location: path });
  const b = new Database(path);
  try {
    b.pragma(`user_version = ${NEWER}`);
    let ran = false;
    assert.throws(
      () =>
        a.tx(() => {
          // Anything here may act outside the database (write a file, call a port) on what it read.
          ran = true;
        }),
      (e) => assertRefusal(e, path),
    );
    assert.equal(ran, false, 'the transaction body must not run once the book is newer');
  } finally {
    a.close();
    b.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * A world whose id generator lets a newer TILL commit at the first thing `produceArtifact` does inside
 * its lock-free, DEFERRED transaction (`snapshotTx`): minting the artifact id. A real second process
 * can commit at exactly that point (critic probe p3). This also pins that backup and export do NOT
 * take the write lock for their read: under an IMMEDIATE begin the newer TILL could not commit here
 * at all (critic R2-1), and the retry below would not be refused.
 */
function racingArtifactWorld(dir) {
  const path = join(dir, 'book.db');
  const backupDir = join(dir, 'backups');
  const store = new SqliteStore({ location: path, clock: fixedClock(AT) });
  let hook = null;
  const ids = {
    next: (prefix) => {
      if ((prefix === 'backup' || prefix === 'export') && hook !== null) {
        const h = hook;
        hook = null;
        h();
      }
      return systemIdGen.next(prefix);
    },
  };
  const deps = { store, clock: fixedClock(AT), ids, actor: 'studio', backupDir };
  const { workspaceId, accId } = mintWorkspace(deps, 'Rennen Beispiel AG');
  assert.equal(getAction('post_entry').run(deps, { workspaceId, ...manualPost(accId, 'p-1', 900) }).ok, true);
  const arm = () => {
    hook = () => {
      const b = new Database(path);
      b.pragma(`user_version = ${NEWER}`);
      b.close();
    };
  };
  const bundles = () => (existsSync(backupDir) ? readdirSync(backupDir) : []);
  return { path, store, deps, workspaceId, arm, bundles };
}

test('F2: create_backup and export_workspace racing a newer TILL leave neither a row nor a bundle on disk', () => {
  for (const verb of ['create_backup', 'export_workspace']) {
    const dir = tempDir();
    const w = racingArtifactWorld(dir);
    try {
      w.arm();
      const res = getAction(verb).run(w.deps, { workspaceId: w.workspaceId, idempotencyKey: `${verb}-race` });
      assert.equal(res.ok, false, `${verb} must not report success into a book a newer TILL migrated: ${JSON.stringify(res)}`);
      assert.ok(
        res.error === 'store_busy' || res.error === SCHEMA_NEWER_THAN_RUNTIME,
        `${verb}: the race is a retryable store_busy or the named refusal, got ${res.error}`,
      );
      const ro = new Database(w.path, { readonly: true });
      try {
        assert.equal(ro.prepare('SELECT COUNT(*) AS n FROM backups').get().n, 0, `${verb}: no backups row committed`);
      } finally {
        ro.close();
      }
      assert.deepEqual(w.bundles(), [], `${verb}: no published bundle and no temp directory left behind`);
      // The retry meets the start check and is refused by name.
      const retry = getAction(verb).run(w.deps, { workspaceId: w.workspaceId, idempotencyKey: `${verb}-retry` });
      assert.equal(retry.error, SCHEMA_NEWER_THAN_RUNTIME);
      assert.deepEqual(w.bundles(), []);
    } finally {
      w.store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('F2: a backup whose transaction does not commit after the bundle was published leaves no bundle', () => {
  for (const verb of ['create_backup', 'export_workspace']) {
    const dir = tempDir();
    const w = racingArtifactWorld(dir);
    try {
      // The compute succeeds (bundle renamed into place, row inserted), then the transaction throws
      // before COMMIT, the shape of a pre-commit refusal or a failed COMMIT.
      const original = w.store.rememberIdempotent.bind(w.store);
      w.store.rememberIdempotent = (workspaceId, key, name, compute) =>
        original(workspaceId, key, name, () => {
          compute();
          throw new Error('the transaction did not commit');
        });
      const res = getAction(verb).run(w.deps, { workspaceId: w.workspaceId, idempotencyKey: `${verb}-nocommit` });
      delete w.store.rememberIdempotent;
      assert.equal(res.ok, false);
      assert.deepEqual(w.bundles(), [], `${verb}: a bundle whose row never committed is removed`);
      assert.equal(w.store.db.prepare('SELECT COUNT(*) AS n FROM backups').get().n, 0);
    } finally {
      w.store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

// --- 8. the open's schema pass is one transaction (critic R1 F3) ------------------------------------

/**
 * Let a newer TILL commit at a chosen point INSIDE this build's open, by wrapping one method of the
 * driver's prototype for the duration of the open (the same module instance the store loads). The
 * newer TILL drops an index this build would re-create and bumps the marker, in one transaction.
 */
function newerCommitsDuringOpen(path, method, when) {
  const original = Database.prototype[method];
  let calls = 0;
  let fired = false;
  Database.prototype[method] = function (...args) {
    if (!fired && this.name === path && when(++calls, args)) {
      fired = true;
      const b = new Database(path);
      b.transaction(() => {
        b.exec(`DROP INDEX IF EXISTS ${INDEX_THIS_BUILD_WOULD_RECREATE}`);
        b.exec('CREATE TABLE IF NOT EXISTS newer_only (x INTEGER)');
        b.pragma(`user_version = ${NEWER}`);
      })();
      b.close();
    }
    return original.apply(this, args);
  };
  return {
    restore: () => {
      Database.prototype[method] = original;
    },
    fired: () => fired,
  };
}

function bookFacts(path) {
  const ro = new Database(path, { readonly: true });
  try {
    return {
      generation: ro.pragma('user_version', { simple: true }),
      index: ro.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?").get(INDEX_THIS_BUILD_WOULD_RECREATE) !== undefined,
      newerOnly: ro.prepare("SELECT 1 FROM sqlite_master WHERE name = 'newer_only'").get() !== undefined,
    };
  } finally {
    ro.close();
  }
}

test('F3: a newer TILL committing during the open schema pass gets no DDL from this build, and the open is refused', () => {
  const dir = tempDir();
  try {
    const path = makeBook(dir);
    // Critic probe p5: the commit lands while this build runs SCHEMA_SQL, the start of the pass.
    const hook = newerCommitsDuringOpen(path, 'exec', (_n, [sql]) => typeof sql === 'string' && sql.length > 100_000);
    try {
      assert.throws(() => new SqliteStore({ location: path }), (e) => assertRefusal(e, path));
    } finally {
      hook.restore();
    }
    assert.equal(hook.fired(), true, 'premise: the newer commit landed inside the schema pass');
    const facts = bookFacts(path);
    assert.equal(facts.generation, NEWER, 'the newer marker stands');
    assert.equal(facts.index, false, 'this build did not re-create the index the newer schema dropped');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('F3: an older book migrated by a newer TILL during this build\'s migration is never lowered', () => {
  // Critic probe p4, at both points: before the open transaction begins, and after its marker read
  // but before the migration writes (the migration then meets SQLITE_BUSY_SNAPSHOT and the retry
  // reads the newer marker).
  for (const nthTransaction of [1, 2]) {
    const dir = tempDir();
    try {
      const path = makeBook(dir);
      const raw = new Database(path);
      raw.pragma(`user_version = ${SCHEMA_GENERATION - 1}`);
      raw.pragma('wal_checkpoint(TRUNCATE)');
      raw.close();
      const hook = newerCommitsDuringOpen(path, 'transaction', (n) => n === nthTransaction);
      try {
        assert.throws(() => new SqliteStore({ location: path }), (e) => assertRefusal(e, path));
      } finally {
        hook.restore();
      }
      assert.equal(hook.fired(), true, `premise: the newer commit landed at transaction #${nthTransaction}`);
      const facts = bookFacts(path);
      assert.equal(facts.generation, NEWER, `the marker was not lowered to ${SCHEMA_GENERATION} (commit at transaction #${nthTransaction})`);
      assert.equal(facts.newerOnly, true);
      assert.equal(facts.index, false, 'no DDL from this build either');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

// --- 9. a crashed newer writer's WAL (critic R1 F4) -------------------------------------------------

test('F4: a refused open over a crashed newer writer\'s WAL leaves the main file and the -wal byte-for-byte unchanged', () => {
  const dir = tempDir();
  try {
    const path = makeBook(dir);
    // The newer TILL bumps the marker and is SIGKILLed before any checkpoint (a crash, kill -9): its
    // commit lives only in the -wal. Critic probe p2.
    const driver = createRequire(import.meta.url).resolve('better-sqlite3');
    const crash = spawnSync(process.execPath, [
      '-e',
      `const Database = require(${JSON.stringify(driver)});
       const db = new Database(${JSON.stringify(path)});
       db.pragma('wal_autocheckpoint = 0');
       db.pragma('user_version = ${NEWER}');
       db.exec('CREATE TABLE newer_only (x INTEGER)');
       process.kill(process.pid, 'SIGKILL');`,
    ]);
    assert.equal(crash.signal, 'SIGKILL', `premise: the newer writer died mid-flight: ${crash.stderr}`);
    const before = fileState(path);
    assert.notEqual(before.wal, null, 'premise: the crash left a -wal behind');
    assert.equal(headerGeneration(path), SCHEMA_GENERATION, 'premise: the bump is only in the -wal');

    assert.throws(() => new SqliteStore({ location: path }), (e) => assertRefusal(e, path));

    const after = fileState(path);
    assert.equal(after.main, before.main, 'the main file is byte-for-byte unchanged (no checkpoint)');
    assert.equal(after.wal, before.wal, 'the crashed writer\'s -wal is byte-for-byte unchanged, not deleted');
    assert.equal(headerGeneration(path), SCHEMA_GENERATION, 'the header was not rewritten');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('R2-5: a newer TILL that creates the -wal, commits and crashes between any check and the look is never folded into the book', () => {
  // Critic probe q6 (d). Round 1 sampled "is there a -wal?" before the read-only look and, when there
  // was none, tidied the look's sidecars with a writable connection whose close checkpointed whatever
  // the -wal held by then: the crashed writer's commit went into the main file and its -wal was
  // deleted. The newer TILL here acts at the look's marker read, after any such check.
  const dir = tempDir();
  try {
    const path = makeBook(dir);
    const quiet = fileState(path);
    assert.equal(quiet.wal, null, 'premise: the book is quiet when the open begins');
    const driver = createRequire(import.meta.url).resolve('better-sqlite3');
    const original = Database.prototype.pragma;
    let crashed = null;
    Database.prototype.pragma = function (source, options) {
      if (crashed === null && this.readonly && this.name === path && source === 'user_version') {
        crashed = spawnSync(process.execPath, [
          '-e',
          `const Database = require(${JSON.stringify(driver)});
           const db = new Database(${JSON.stringify(path)});
           db.pragma('wal_autocheckpoint = 0');
           db.pragma('user_version = ${NEWER}');
           db.exec('CREATE TABLE newer_only (x INTEGER)');
           process.kill(process.pid, 'SIGKILL');`,
        ]);
      }
      return original.call(this, source, options);
    };
    try {
      assert.throws(() => new SqliteStore({ location: path }), (e) => assertRefusal(e, path));
    } finally {
      Database.prototype.pragma = original;
    }
    assert.equal(crashed?.signal, 'SIGKILL', `premise: the newer writer died mid-flight: ${crashed?.stderr}`);
    const after = fileState(path);
    assert.equal(after.main, quiet.main, 'the main file is byte-for-byte the quiet book: no checkpoint');
    assert.equal(headerGeneration(path), SCHEMA_GENERATION, 'the header was not rewritten to the newer generation');
    assert.notEqual(after.wal, null, 'the crashed writer\'s -wal is still on disk, not deleted');
    assert.notEqual(after.wal, EMPTY_FILE, 'and it still holds the newer commit');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- 10. the remaining windows (critic R1 F6) ---------------------------------------------------

test('F6: a backup whose snapshot is OLDER than its manifest is refused by exact match, and nothing is restored', () => {
  const dir = tempDir();
  try {
    const backupDir = join(dir, 'backups');
    const source = freshDeps();
    source.backupDir = backupDir;
    const { workspaceId } = mintWorkspace(source, 'Alt Beispiel AG');
    const backup = getAction('create_backup').run(source, { workspaceId, idempotencyKey: 'b' });
    assert.equal(backup.ok, true, JSON.stringify(backup));
    source.store.close();
    // Critic probe p7: the manifest claims the current generation, the snapshot file is one older,
    // and the checksums agree with the file.
    const snapshot = join(backup.artifactRef, 'data.sqlite');
    const raw = new Database(snapshot);
    raw.pragma(`user_version = ${SCHEMA_GENERATION - 1}`);
    raw.close();
    const manifestPath = join(backup.artifactRef, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.files['data.sqlite'].sha256 = sha(snapshot);
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    const target = freshDeps();
    target.backupDir = backupDir;
    const before = target.store.db.prepare('SELECT COUNT(*) AS n FROM workspace').get().n;
    const verify = getAction('verify_backup').run(target, { source: backup.artifactRef });
    assert.equal(verify.error, 'incompatible_schema_version', 'verify holds the snapshot file to the exact generation');
    assert.equal(verify.artifactSchemaVersion, SCHEMA_GENERATION - 1);
    assert.equal(verify.currentSchemaVersion, SCHEMA_GENERATION);
    const restore = getAction('restore_backup').run(target, {
      source: backup.artifactRef,
      newWorkspaceName: 'Wiederhergestellt',
      confirmed: true,
      idempotencyKey: 'r',
    });
    assert.equal(restore.error, 'incompatible_schema_version', 'unmigrated rows are never restored');
    assert.equal(target.store.db.prepare('SELECT COUNT(*) AS n FROM workspace').get().n, before, 'no workspace was minted');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('F6: the writers that bypassed store.tx refuse a moved-on book and write nothing', () => {
  const dir = tempDir();
  const path = join(dir, 'book.db');
  const store = new SqliteStore({ location: path, clock: fixedClock(AT) });
  const b = new Database(path);
  try {
    // Real ids on both sides: the engine calls below mint rows next to the ones the registry made.
    const deps = { store, clock: fixedClock(AT), ids: systemIdGen, actor: 'studio' };
    const { workspaceId } = mintWorkspace(deps, 'Umgehung Beispiel AG');
    const contact = (name, key) =>
      getAction('create_contact').run(deps, { workspaceId, partyRole: 'customer', name, idempotencyKey: key }).contact.id;
    const sourceId = contact('Doppelt AG', 'c1');
    const targetId = contact('Original AG', 'c2');
    const rule = getAction('create_automation_rule').run(deps, {
      workspaceId,
      name: 'Neuer Kunde: Artikel anlegen',
      trigger: { event: 'contact.created' },
      action: { tool: 'create_item', inputTemplate: { name: 'Onboarding {{result.contact.id}}', defaultUnitPriceMinor: 0 } },
      idempotencyKey: 'rule-1',
    });
    assert.equal(rule.ok, true, JSON.stringify(rule));

    b.pragma(`user_version = ${NEWER}`);
    const count = (sql) => b.prepare(sql).get().n;
    const contactsBefore = count('SELECT COUNT(*) AS n FROM contact');
    const runsBefore = count('SELECT COUNT(*) AS n FROM automation_run');
    const ctx = makeContext(store, { workspaceId, clock: fixedClock(AT), ids: systemIdGen });

    // The key-less paths ran a raw `db.transaction`, which no generation check saw.
    assert.throws(() => mergeContacts(ctx, { sourceId, targetId }), (e) => assertRefusal(e, path));
    assert.equal(b.prepare('SELECT merged_into_id FROM contact WHERE id = ?').get(sourceId).merged_into_id, null, 'no merge landed');
    assert.throws(() => anonymiseContact(ctx, { contactId: targetId }), (e) => assertRefusal(e, path));
    assert.equal(b.prepare('SELECT name FROM contact WHERE id = ?').get(targetId).name, 'Original AG', 'no anonymisation landed');
    assert.throws(() => importContacts(ctx, { rows: [{ partyRole: 'customer', name: 'Import Beispiel GmbH' }] }), (e) => assertRefusal(e, path));
    assert.equal(count('SELECT COUNT(*) AS n FROM contact'), contactsBefore, 'no contact was imported');

    // The automation run log claimed and settled its rows with bare autocommit writes.
    let invoked = 0;
    const invoker = () => {
      invoked += 1;
      return { ok: true };
    };
    assert.throws(
      () =>
        dispatchAutomationEvent(ctx, invoker, 'create_contact', { partyRole: 'customer' }, { contact: { id: sourceId, partyRole: 'customer' } }),
      (e) => assertRefusal(e, path),
    );
    assert.equal(invoked, 0, 'the rule never fired');
    assert.equal(count('SELECT COUNT(*) AS n FROM automation_run'), runsBefore, 'no run row was claimed');
  } finally {
    store.close();
    b.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- 11. the money writes that were bare autocommits, and partial refusals (critic R2-4) -----------

/** A Studio world over a real file, real ids (a second process writes to the same book). */
function moneyWorld(dir, name) {
  const path = join(dir, 'book.db');
  const store = new SqliteStore({ location: path, clock: fixedClock(AT) });
  const deps = { store, clock: fixedClock(AT), ids: systemIdGen, actor: 'studio' };
  const { workspaceId } = mintWorkspace(deps, name);
  const call = (verb, input) => getAction(verb).run(deps, { workspaceId, ...input });
  return { path, store, deps, workspaceId, call };
}

/**
 * A NEWER TILL (another process) starts its migration exactly when this build prepares the statement
 * matching `pattern`: it asks for the write lock, then runs `migration` (which changes what a stored
 * number MEANS, x100 or x10) and bumps the marker, in one transaction. Critic probe q5 `newer`.
 *
 * When the verb already holds the write lock at that statement (one IMMEDIATE transaction), the newer
 * TILL cannot start until the verb has committed, so `took()` is false and the migration converts
 * what the verb wrote. As a bare autocommit statement the newer TILL got the lock first, the statement
 * waited it out in the busy handler, and then wrote an old-meaning number into the migrated book.
 */
async function newerTillMigratesAt(w, pattern, migration) {
  const holder = await lockHolder(w.path, {
    holdMs: 200,
    inTransaction: `${migration}; db.pragma('user_version = ${NEWER}');`,
  });
  const prepare = w.store.db.prepare;
  let took = null;
  w.store.db.prepare = function (sql) {
    if (took === null && pattern.test(sql)) took = holder.take(800);
    return prepare.call(this, sql);
  };
  return {
    took: () => took,
    finish: async () => {
      delete w.store.db.prepare;
      await holder.done;
    },
  };
}

function readBook(path, sql, ...params) {
  const ro = new Database(path, { readonly: true });
  try {
    return { generation: ro.pragma('user_version', { simple: true }), row: ro.prepare(sql).get(...params) };
  } finally {
    ro.close();
  }
}

/** D01's seed, as the conformance suite builds it: a stock-tracked item, a location and one receipt. */
function stockWorld(w, seed) {
  const item = w.call('create_item', { name: 'Widget', defaultUnitPriceMinor: 5000, idempotencyKey: `${seed}-item` });
  w.store.db
    .prepare('UPDATE item SET track_stock = 1, cost_price_minor = ?, reorder_point_qty = ? WHERE workspace_id = ? AND id = ?')
    .run(2000, 5, w.workspaceId, item.item.id);
  const loc = w.call('stock_location_upsert', { name: 'Lager', idempotencyKey: `${seed}-loc` });
  const recv = w.call('stock_move', {
    itemId: item.item.id, locationId: loc.location.id, qty: 10, reason: 'receipt', unitCostMinor: 2000, movedAt: '2026-03-01',
    idempotencyKey: `${seed}-recv`,
  });
  assert.equal(recv.ok, true, JSON.stringify(recv));
  return { itemId: item.item.id, locationId: loc.location.id };
}

test('R2-4: set_bank_opening_balance is ONE transaction: a newer TILL migrating mid-verb waits, then converts the opening balance (critic q5)', async () => {
  const dir = tempDir();
  const w = moneyWorld(dir, 'Eröffnung Beispiel AG');
  try {
    const equity = w.call('create_account', { number: '9100', name: 'Eröffnungsbilanz', type: 'equity', idempotencyKey: 'a9100' });
    assert.equal(equity.ok, true, JSON.stringify(equity));
    const ledger = w.store.db.prepare("SELECT id FROM account WHERE workspace_id = ? AND number = '1020'").get(w.workspaceId).id;
    const bank = w.call('create_bank_account', {
      name: 'Kantonalbank Kontokorrent', iban: 'CH93 0076 2011 6238 5295 7', currency: 'CHF', ledgerAccountId: ledger, idempotencyKey: 'ba',
    });
    assert.equal(bank.ok, true, JSON.stringify(bank));
    const newer = await newerTillMigratesAt(
      w,
      /UPDATE bank_account\s+SET opening_balance_minor = \?/,
      "db.prepare('UPDATE bank_account SET opening_balance_minor = opening_balance_minor * 100 WHERE opening_balance_minor IS NOT NULL').run()",
    );
    const res = w.call('set_bank_opening_balance', {
      bankAccountId: bank.bankAccountId, amountMinor: 1250000, currency: 'CHF', date: '2026-01-01', idempotencyKey: 'sbob-1',
    });
    await newer.finish();
    assert.equal(newer.took(), false, 'the newer TILL could not start its migration inside the verb');
    assert.equal(res.ok, true, `the verb committed whole before the migration: ${JSON.stringify(res)}`);
    const book = readBook(
      w.path,
      `SELECT b.opening_balance_minor AS v, (SELECT COUNT(*) FROM journal_entry WHERE id = b.opening_entry_id) AS entries,
              (SELECT COUNT(*) FROM idempotency WHERE verb = 'set_bank_opening_balance') AS keys
         FROM bank_account b WHERE b.id = ?`,
      bank.bankAccountId,
    );
    assert.equal(book.generation, NEWER, 'premise: the newer TILL migrated the book afterwards');
    assert.deepEqual(
      { ...book.row },
      { v: 125000000, entries: 1, keys: 1 },
      'written at this generation, then converted by the migration: never an old-meaning number in the newer book',
    );
  } finally {
    w.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

const MONEY_VERBS = [
  {
    verb: 'update_item',
    setup: (w) => {
      const item = w.call('create_item', { name: 'Beratung', defaultUnitPriceMinor: 100, idempotencyKey: 'ci' });
      return { input: { itemId: item.item.id, patch: { defaultUnitPriceMinor: 2500 } }, id: item.item.id };
    },
    pattern: /UPDATE item SET /,
    migration: "db.prepare('UPDATE item SET default_unit_price_minor = default_unit_price_minor * 100').run()",
    read: (ctx) => ['SELECT default_unit_price_minor AS v FROM item WHERE id = ?', ctx.id],
    expected: 250000,
  },
  {
    verb: 'stock_move',
    setup: (w) => {
      const s = stockWorld(w, 'smv');
      return {
        input: { itemId: s.itemId, locationId: s.locationId, qty: 7, reason: 'receipt', unitCostMinor: 2000, movedAt: '2026-03-02', idempotencyKey: 'smv-1' },
      };
    },
    pattern: /INSERT INTO stock_movement/,
    // A movement row is immutable (a trigger refuses UPDATE), so this migration cannot rescale it; it
    // records instead whether the movement was already in the book when it ran. 1 means the verb
    // committed first, at this generation; 0 means the INSERT landed in the migrated book.
    migration: `db.exec("CREATE TABLE newer_saw AS SELECT COUNT(*) AS v FROM stock_movement WHERE idempotency_key = 'smv-1'")`,
    read: () => ['SELECT v FROM newer_saw'],
    expected: 1,
  },
  {
    verb: 'stock_stocktake_count',
    setup: (w) => {
      stockWorld(w, 'stc');
      const st = w.call('stock_stocktake_open', { frozenAt: '2026-03-31', idempotencyKey: 'stc-open' });
      const ln = st.lines[0];
      return { input: { sessionId: st.session.id, itemId: ln.item_id, locationId: ln.location_id, countedQty: 8 }, id: ln.id };
    },
    pattern: /UPDATE stocktake_line SET counted_qty/,
    migration: "db.prepare('UPDATE stocktake_line SET counted_qty = counted_qty * 10 WHERE counted_qty IS NOT NULL').run()",
    read: (ctx) => ['SELECT counted_qty AS v FROM stocktake_line WHERE id = ?', ctx.id],
    expected: 80,
  },
];

for (const c of MONEY_VERBS) {
  test(`R2-4: ${c.verb} writes its money column inside the guarded transaction, so a newer TILL migrating mid-verb converts it`, async () => {
    const dir = tempDir();
    const w = moneyWorld(dir, `Geld Beispiel AG ${c.verb}`);
    try {
      const ctx = c.setup(w);
      const newer = await newerTillMigratesAt(w, c.pattern, c.migration);
      const res = w.call(c.verb, ctx.input);
      await newer.finish();
      assert.equal(res.ok, true, JSON.stringify(res));
      assert.equal(newer.took(), false, 'the newer TILL could not start its migration inside the verb');
      const book = readBook(w.path, ...c.read(ctx));
      assert.equal(book.generation, NEWER, 'premise: the newer TILL migrated afterwards');
      assert.equal(book.row.v, c.expected, 'written at this generation and converted by the migration, never an old-meaning number in the newer book');
    } finally {
      w.store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('R2-4: a refusal raised after the call had already committed says so, and never that the book was not changed', () => {
  const payload = readFileSync(new URL('../fx/fixtures/bazg-xmldaily-20260724.xml', import.meta.url), 'utf8');
  // import_exchange_rates commits once per rate. The newer TILL commits before its FIRST transaction
  // (nothing of this call is in the book) and before its SECOND (one rate already is).
  for (const nth of [1, 2]) {
    const dir = tempDir();
    const w = moneyWorld(dir, `Kurse Beispiel AG ${nth}`);
    const b = new Database(w.path);
    try {
      const original = w.store.tx.bind(w.store);
      let outer = 0;
      w.store.tx = (fn) => {
        if (!w.store.db.inTransaction && ++outer === nth) b.pragma(`user_version = ${NEWER}`);
        return original(fn);
      };
      const res = w.call('import_exchange_rates', { payload, series: 'daily', currencies: ['EUR', 'USD'], idempotencyKey: `imp-${nth}` });
      delete w.store.tx;
      const rates = b.prepare('SELECT COUNT(*) AS n FROM exchange_rate WHERE workspace_id = ?').get(w.workspaceId).n;
      assert.equal(res.ok, false);
      assert.equal(res.error, SCHEMA_NEWER_THAN_RUNTIME);
      if (nth === 1) {
        assert.equal(rates, 0, 'premise: nothing of this call reached the book');
        assert.equal(res.partial, false);
        assert.match(res.message, /The book was not changed/);
      } else {
        assert.ok(rates > 0, 'premise: a rate committed before the book moved on');
        assert.equal(res.partial, true, 'the refusal says part of the call is already in the book');
        assert.doesNotMatch(res.message, /not changed/, 'and never claims the book was not changed');
        assert.match(res.message, /Part of this call was already saved/);
        assert.match(res.message, new RegExp(`newer TILL \\(generation ${NEWER}\\)`));
      }
    } finally {
      b.close();
      w.store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }
});
