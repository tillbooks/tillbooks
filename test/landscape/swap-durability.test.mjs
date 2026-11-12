// N00 build-then-swap, made atomic and durable, and the refusal to invent an empty environment ledger.
//
// The old swap deleted the target and then renamed the build over it, with no directory sync: a
// crash between the two left no ledger, the next open silently created an empty one, and the next
// build deleted the surviving `.building` file. These tests hold the new contract: one atomic rename
// over the target (it is never absent), the old target's WAL folded before its sidecars go, a
// directory fsync after, and a loud refusal wherever a missing environment ledger would otherwise be
// re-created empty.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import {
  swapInto,
  LandscapeSwapError,
  envCreate,
  envReset,
  envCopy,
  missingEnvironmentLedger,
  MissingEnvironmentLedgerError,
} from '../../dist/core/landscape/index.js';
import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { ensureDbChoice, ensureDbPath } from '../../dist/api/db-path.js';
import { createWorkspace } from '../../dist/core/setup/workspace.js';
import { systemIdGen } from '../../dist/core/ids.js';
import { withFsEvents } from '../core/fs-event-spy.mjs';

const AT = '2026-09-24T00:00:00.000Z';

function tmp() {
  return mkdtempSync(join(tmpdir(), 'till-swap-'));
}

/** A ledger file holding one marker row in the FK-free idempotency table, closed cleanly (empty WAL). */
function ledgerWithMarker(path, marker) {
  mkdirSync(dirname(path), { recursive: true });
  const s = new SqliteStore({ location: path });
  s.db.prepare('INSERT INTO idempotency (workspace_id, key, verb, result_json, created_at) VALUES (?, ?, ?, ?, ?)').run('marker', marker, 'seed', '{}', AT);
  s.close();
}

function markers(path) {
  const db = new Database(path, { readonly: true });
  try {
    return db.prepare("SELECT key FROM idempotency WHERE workspace_id = 'marker' ORDER BY key").all().map((r) => r.key);
  } finally {
    db.close();
  }
}

/**
 * A ledger whose LAST commit lives only in its WAL (as after a crash of the process that wrote it):
 * the pair is copied aside while the writer still holds it open, so the copy's WAL keeps its frames.
 */
function ledgerWithWalOnlyCommit(path, walMarker) {
  const scratch = `${path}.writer`;
  ledgerWithMarker(scratch, 'base');
  const db = new Database(scratch);
  db.pragma('wal_autocheckpoint = 0');
  db.prepare('INSERT INTO idempotency (workspace_id, key, verb, result_json, created_at) VALUES (?, ?, ?, ?, ?)').run('marker', walMarker, 'seed', '{}', AT);
  copyFileSync(scratch, path);
  copyFileSync(`${scratch}-wal`, `${path}-wal`);
  db.close();
  for (const s of ['', '-wal', '-shm']) rmSync(scratch + s, { force: true });
  assert.ok(statSync(`${path}-wal`).size > 0, 'the fixture really has WAL frames');
}

test('swapInto replaces the target in ONE rename (the target is never absent) and fsyncs the directory after', () => {
  const dir = tmp();
  try {
    const target = join(dir, 'env', 'till.db');
    const building = `${target}.building`;
    ledgerWithMarker(target, 'old');
    ledgerWithMarker(building, 'new');
    let presentAtRename;
    const { events } = withFsEvents(() => swapInto(building, target), {
      beforeRename: (from, to) => {
        if (to === resolve(target)) presentAtRename = existsSync(to);
      },
    });
    assert.equal(presentAtRename, true, 'the old target still existed at the moment of the rename: nothing deleted it first');
    const rename = events.findIndex((e) => e.op === 'rename' && e.to === resolve(target));
    assert.equal(events[rename].from, resolve(building));
    assert.ok(events.slice(0, rename).some((e) => e.op === 'fsync' && e.path === resolve(building)), 'the build was fsynced before it was published');
    assert.ok(events.slice(rename + 1).some((e) => e.op === 'fsync' && e.path === resolve(dirname(target))), 'the directory was fsynced after the rename');
    assert.deepEqual(markers(target), ['new']);
    assert.equal(existsSync(building), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a crash at the rename leaves the OLD ledger intact, including a commit that lived only in its WAL', () => {
  const dir = tmp();
  try {
    const target = join(dir, 'till.db');
    const building = `${target}.building`;
    ledgerWithWalOnlyCommit(target, 'wal-only');
    ledgerWithMarker(building, 'new');
    assert.throws(
      () =>
        withFsEvents(() => swapInto(building, target), {
          beforeRename: () => {
            throw new Error('simulated power cut at the rename');
          },
        }),
      /simulated power cut/,
    );
    assert.equal(existsSync(target), true, 'the target still names a ledger after the crash');
    assert.deepEqual(markers(target), ['base', 'wal-only'], 'the old WAL was folded into the old file, not dropped');
    assert.equal(existsSync(`${target}-wal`) && statSync(`${target}-wal`).size > 0, false, 'no WAL with frames is left to replay into anything');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a stale WAL of the old target is never replayed into the new ledger', () => {
  const dir = tmp();
  try {
    const target = join(dir, 'till.db');
    const building = `${target}.building`;
    ledgerWithWalOnlyCommit(target, 'old-wal');
    ledgerWithMarker(building, 'new');
    swapInto(building, target);
    assert.deepEqual(markers(target), ['new'], 'the new ledger holds exactly the build');
    const db = new Database(target, { readonly: true });
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a build whose WAL still holds frames is refused, and the target is untouched', () => {
  const dir = tmp();
  try {
    const target = join(dir, 'till.db');
    const building = `${target}.building`;
    ledgerWithMarker(target, 'old');
    ledgerWithWalOnlyCommit(building, 'unfolded');
    assert.throws(() => swapInto(building, target), (e) => e instanceof LandscapeSwapError && e.reason === 'building_wal_not_folded');
    assert.deepEqual(markers(target), ['old']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a target another connection is reading mid-transaction is refused (target_in_use), not replaced under it', () => {
  const dir = tmp();
  try {
    const target = join(dir, 'till.db');
    const building = `${target}.building`;
    ledgerWithWalOnlyCommit(target, 'busy');
    ledgerWithMarker(building, 'new');
    const reader = new Database(target, { readonly: true });
    const it = reader.prepare("SELECT key FROM idempotency WHERE workspace_id = 'marker'").iterate();
    it.next(); // holds an open read transaction on the WAL snapshot
    try {
      assert.throws(() => swapInto(building, target), (e) => e instanceof LandscapeSwapError && e.reason === 'target_in_use');
    } finally {
      it.return();
      reader.close();
    }
    assert.deepEqual(markers(target), ['base', 'busy']);
    assert.equal(existsSync(building), true, 'the caller still owns the build (and drops it)');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an IDLE open connection on the target (not in any transaction) is detected: target_in_use, and its later writes are not lost', () => {
  // The critic's repro: a plain TRUNCATE checkpoint only noticed a connection that was mid-read, so an
  // idle `till up` on the target let the swap through and its next write went into the unlinked file.
  const dir = tmp();
  try {
    const target = join(dir, 'till.db');
    const building = `${target}.building`;
    ledgerWithMarker(target, 'old');
    ledgerWithMarker(building, 'new');
    const idle = new Database(target);
    idle.prepare("INSERT INTO idempotency (workspace_id, key, verb, result_json, created_at) VALUES ('marker', 'wal-idle', 'seed', '{}', ?)").run(AT);
    assert.ok(statSync(`${target}-wal`).size > 0, 'the idle connection left a non-empty WAL');
    try {
      assert.throws(() => swapInto(building, target), (e) => e instanceof LandscapeSwapError && e.reason === 'target_in_use');
      idle.prepare("INSERT INTO idempotency (workspace_id, key, verb, result_json, created_at) VALUES ('marker', 'after-refusal', 'seed', '{}', ?)").run(AT);
    } finally {
      idle.close();
    }
    assert.deepEqual(markers(target), ['after-refusal', 'old', 'wal-idle'], 'the live target kept every write, including the one after the refusal');
    // Non-vacuity: once the connection is gone the same swap goes through.
    swapInto(building, target);
    assert.deepEqual(markers(target), ['new']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('env_reset refused by a busy target names the environment (swap_refused carries name and target)', () => {
  const dir = tmp();
  try {
    const deps = landscapeDeps(dir);
    const created = envCreate(deps, { name: 'probe', policy: 'synthetic', seed: 'minimal', tierRank: 30, confirmed: true });
    assert.equal(created.ok, true, JSON.stringify(created));
    const idle = new Database(created.environment.dbPath);
    try {
      idle.prepare('SELECT 1').get();
      const refused = envReset(deps, { name: 'probe', confirmed: true, force: true });
      assert.equal(refused.ok, false);
      assert.equal(refused.error, 'swap_refused');
      assert.equal(refused.reason, 'target_in_use');
      assert.equal(refused.name, 'probe');
      assert.equal(refused.target, 'probe');
    } finally {
      idle.close();
    }
    assert.deepEqual(markers(created.environment.dbPath), ['seeded'], 'the refused reset left the environment as it was');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- a target that is not a ledger (critic R1-M1) ---------------------------------------------------

/** Bytes that are not a SQLite database at `path` (a torn or foreign file): opening it is SQLITE_NOTADB. */
function notADatabase(path) {
  mkdirSync(dirname(path), { recursive: true });
  for (const s of ['-wal', '-shm']) rmSync(path + s, { force: true });
  writeFileSync(path, Buffer.alloc(8192, 0x41));
}

test('a target that is not a database is refused by default (target_not_a_ledger) and replaced only when the caller rebuilds', () => {
  const dir = tmp();
  try {
    const target = join(dir, 'till.db');
    const building = `${target}.building`;
    notADatabase(target);
    ledgerWithMarker(building, 'new');
    assert.throws(() => swapInto(building, target), (e) => e instanceof LandscapeSwapError && e.reason === 'target_not_a_ledger');
    assert.equal(readFileSync(target).subarray(0, 4).toString(), 'AAAA', 'the refused swap left the bytes');
    swapInto(building, target, { replaceUnreadable: true });
    assert.deepEqual(markers(target), ['new']);
    assert.equal(existsSync(building), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('replaceUnreadable never replaces a real ledger another connection holds: still target_in_use', () => {
  const dir = tmp();
  try {
    const target = join(dir, 'till.db');
    const building = `${target}.building`;
    ledgerWithMarker(target, 'old');
    ledgerWithMarker(building, 'new');
    const idle = new Database(target);
    try {
      idle.prepare('SELECT 1').get();
      assert.throws(() => swapInto(building, target, { replaceUnreadable: true }), (e) => e instanceof LandscapeSwapError && e.reason === 'target_in_use');
    } finally {
      idle.close();
    }
    assert.deepEqual(markers(target), ['old']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('any other quiesce failure is a named refusal (target_quiesce_failed), never a raw error: env_reset answers swap_refused', () => {
  const dir = tmp();
  try {
    const deps = landscapeDeps(dir);
    const created = envCreate(deps, { name: 'probe', policy: 'synthetic', seed: 'minimal', tierRank: 30, confirmed: true });
    assert.equal(created.ok, true, JSON.stringify(created));
    const dbPath = created.environment.dbPath;
    // A directory where the ledger file should be: SQLite cannot open it (SQLITE_CANTOPEN), which is
    // neither busy nor "not a database".
    for (const s of ['', '-wal', '-shm']) rmSync(dbPath + s, { force: true });
    mkdirSync(dbPath);
    const refused = envReset(deps, { name: 'probe', confirmed: true, force: true });
    assert.equal(refused.ok, false, JSON.stringify(refused));
    assert.equal(refused.error, 'swap_refused');
    assert.equal(refused.reason, 'target_quiesce_failed');
    assert.equal(statSync(dbPath).isDirectory(), true, 'the target was left as it was');
    assert.equal(existsSync(`${dbPath}.building`), false, 'the build was dropped');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('env_reset rebuilds an environment whose ledger is not a database (the documented rebuild)', () => {
  const dir = tmp();
  try {
    const deps = landscapeDeps(dir);
    const created = envCreate(deps, { name: 'probe', policy: 'synthetic', seed: 'minimal', tierRank: 30, confirmed: true });
    assert.equal(created.ok, true, JSON.stringify(created));
    notADatabase(created.environment.dbPath);
    const reset = envReset(deps, { name: 'probe', confirmed: true });
    assert.equal(reset.ok, true, JSON.stringify(reset));
    assert.deepEqual(markers(created.environment.dbPath), ['seeded']);

  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- no silent empty ledger ---------------------------------------------------------------------

function landscapeDeps(dir) {
  const seeders = { minimal: (path) => ledgerWithMarker(path, 'seeded') };
  return {
    supportDir: dir,
    environmentsRoot: join(dir, 'environments'),
    mainDbPath: join(dir, 'till.db'),
    actor: 'owner',
    now: () => AT,
    seeders,
    ids: systemIdGen,
    clock: { now: () => AT },
  };
}

test('ensureDbPath and ensureDbChoice (what till up, mcp and serve open through) refuse to create an empty ledger where a registered environment expects one, and create nothing', () => {
  const dir = tmp();
  try {
    const deps = landscapeDeps(dir);
    const created = envCreate(deps, { name: 'probe', policy: 'synthetic', seed: 'minimal', tierRank: 30, confirmed: true });
    assert.equal(created.ok, true, JSON.stringify(created));
    const envDb = created.environment.dbPath;
    assert.equal(ensureDbPath({ TILL_DB_PATH: envDb, TILL_SUPPORT_DIR: dir }), envDb, 'a present environment ledger opens as before');

    for (const s of ['', '-wal', '-shm']) rmSync(envDb + s, { force: true });
    assert.throws(
      () => ensureDbPath({ TILL_DB_PATH: envDb, TILL_SUPPORT_DIR: dir }),
      (e) => e instanceof MissingEnvironmentLedgerError && e.missing.environment === 'probe' && /env_reset/.test(e.message),
    );
    // The faces resolve through ensureDbChoice (D166 point 8), so the guard must hold there too.
    assert.throws(
      () => ensureDbChoice({ TILL_DB_PATH: envDb, TILL_SUPPORT_DIR: dir }),
      (e) => e instanceof MissingEnvironmentLedgerError && e.missing.environment === 'probe',
    );
    // Found from the data root alone too (the env's own support dir differs from the host's).
    assert.equal(missingEnvironmentLedger(envDb, [])?.environment, 'probe');
    // The standard, never-built tiers are data roots too.
    const develop = join(dir, 'environments', 'develop', 'till.db');
    assert.equal(missingEnvironmentLedger(develop, [dir])?.environment, 'develop');
    assert.equal(existsSync(envDb), false, 'nothing was created');

    // main's first run still creates its ledger, and a path no landscape claims is untouched by the guard.
    assert.equal(missingEnvironmentLedger(join(dir, 'till.db'), [dir]), undefined, 'main may be created on a first run');
    assert.equal(missingEnvironmentLedger(join(tmpdir(), 'till-unclaimed-nowhere.db'), [dir]), undefined);

    // env_reset rebuilds it, after which it opens again.
    const reset = envReset(deps, { name: 'probe', confirmed: true, force: true });
    assert.equal(reset.ok, true, JSON.stringify(reset));
    assert.deepEqual(markers(envDb), ['seeded']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a mandate copy into a populated target whose ledger vanished fails loud instead of building a one-mandate target', () => {
  const dir = tmp();
  try {
    const deps = landscapeDeps(dir);
    const mainStore = new SqliteStore({ location: deps.mainDbPath });
    const ws = createWorkspace({ store: mainStore, clock: { now: () => AT }, ids: systemIdGen, actor: 'owner' }, { name: 'Quelle AG' });
    mainStore.close();
    const src = envCreate(deps, { name: 'quelle', policy: 'live', tierRank: 250, confirmed: true });
    assert.equal(src.ok, true, JSON.stringify(src));
    // Put a workspace into the source env so a mandate exists there.
    const srcStore = new SqliteStore({ location: src.environment.dbPath });
    const srcWs = createWorkspace({ store: srcStore, clock: { now: () => AT }, ids: systemIdGen, actor: 'owner' }, { name: 'Mandant AG' });
    srcStore.close();
    void ws;
    const tgt = envCreate(deps, { name: 'ziel', policy: 'live', tierRank: 40, confirmed: true });
    assert.equal(tgt.ok, true, JSON.stringify(tgt));
    for (const s of ['', '-wal', '-shm']) rmSync(tgt.environment.dbPath + s, { force: true });

    const refused = envCopy(deps, { source: 'quelle', target: 'ziel', scope: `mandate:${srcWs.workspaceId}`, sanitize: 'raw', confirmed: true });
    assert.equal(refused.ok, false, JSON.stringify(refused));
    assert.equal(refused.error, 'target_data_missing');
    assert.equal(existsSync(tgt.environment.dbPath), false, 'nothing was built in its place');

    // An instance copy IS the rebuild, and is allowed.
    const rebuilt = envCopy(deps, { source: 'quelle', target: 'ziel', scope: 'instance', sanitize: 'raw', confirmed: true });
    assert.equal(rebuilt.ok, true, JSON.stringify(rebuilt));
    assert.equal(existsSync(tgt.environment.dbPath), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
