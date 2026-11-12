// Critic round 1 probes for claude/port-aux-durability-2026-10-14 (cd85f3e8): the landscape swap.
//
// `[FINDING ...]` tests assert the behaviour a fix must produce and FAIL on the reviewed head; they are
// the evidence for the report `docs/critique/port-aux-durability-critic-r1.md`. `[HOLDS]` tests pin a
// claim the critic tried to break and could not. Synthetic ledgers in temp directories only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { envCreate, envReset, envCopy, envSwitch, swapInto } from '../../dist/core/landscape/index.js';
import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { createWorkspace } from '../../dist/core/setup/workspace.js';
import { systemIdGen } from '../../dist/core/ids.js';

const AT = '2026-09-24T00:00:00.000Z';

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

function landscapeDeps(dir) {
  return {
    supportDir: dir,
    environmentsRoot: join(dir, 'environments'),
    mainDbPath: join(dir, 'till.db'),
    actor: 'owner',
    now: () => AT,
    seeders: { minimal: (path) => ledgerWithMarker(path, 'seeded') },
    ids: systemIdGen,
    clock: { now: () => AT },
  };
}

/** Overwrite an environment's ledger with bytes that are not a SQLite database (a torn or foreign file). */
function corrupt(dbPath) {
  for (const s of ['-wal', '-shm']) rmSync(dbPath + s, { force: true });
  writeFileSync(dbPath, Buffer.alloc(8192, 0x41));
}

// --- R1-M1: the rebuild verbs can no longer rebuild a corrupt environment ---------------------------

test('[FINDING R1-M1] env_reset rebuilds an environment whose ledger file is not a database (develop did; the head throws SQLITE_NOTADB)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'till-crit-r1-'));
  try {
    const deps = landscapeDeps(dir);
    const created = envCreate(deps, { name: 'probe', policy: 'synthetic', seed: 'minimal', tierRank: 30, confirmed: true });
    assert.equal(created.ok, true, JSON.stringify(created));
    const dbPath = created.environment.dbPath;
    corrupt(dbPath);

    let reset;
    try {
      reset = envReset(deps, { name: 'probe', confirmed: true, force: true });
    } catch (e) {
      reset = { ok: false, threw: `${e.name}: ${e.code ?? ''} ${e.message}` };
    }
    assert.equal(reset.ok, true, `env_reset is the documented rebuild (ledgerGuard, target_data_missing hint), but it answered ${JSON.stringify(reset)}`);
    assert.deepEqual(markers(dbPath), ['seeded']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('[FINDING R1-M1] an instance env_copy (the rebuild target_data_missing points at) rebuilds a target whose ledger is not a database', () => {
  const dir = mkdtempSync(join(tmpdir(), 'till-crit-r1-'));
  try {
    const deps = landscapeDeps(dir);
    const mainStore = new SqliteStore({ location: deps.mainDbPath });
    createWorkspace({ store: mainStore, clock: { now: () => AT }, ids: systemIdGen, actor: 'owner' }, { name: 'Quelle AG' });
    mainStore.close();
    const src = envCreate(deps, { name: 'quelle', policy: 'live', tierRank: 250, confirmed: true });
    assert.equal(src.ok, true, JSON.stringify(src));
    const srcStore = new SqliteStore({ location: src.environment.dbPath });
    createWorkspace({ store: srcStore, clock: { now: () => AT }, ids: systemIdGen, actor: 'owner' }, { name: 'Mandant AG' });
    srcStore.close();
    const tgt = envCreate(deps, { name: 'ziel', policy: 'live', tierRank: 40, confirmed: true });
    assert.equal(tgt.ok, true, JSON.stringify(tgt));
    corrupt(tgt.environment.dbPath);

    let rebuilt;
    try {
      rebuilt = envCopy(deps, { source: 'quelle', target: 'ziel', scope: 'instance', sanitize: 'raw', confirmed: true });
    } catch (e) {
      rebuilt = { ok: false, threw: `${e.name}: ${e.code ?? ''} ${e.message}` };
    }
    assert.equal(rebuilt.ok, true, `the instance copy is the rebuild, but it answered ${JSON.stringify(rebuilt)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('[HOLDS] a corrupt target is never half-replaced: the refused swap leaves the bytes and removes the build', () => {
  const dir = mkdtempSync(join(tmpdir(), 'till-crit-r1-'));
  try {
    const target = join(dir, 'env', 'till.db');
    const building = `${target}.building`;
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, Buffer.alloc(8192, 0x41));
    ledgerWithMarker(building, 'new');
    assert.throws(() => swapInto(building, target));
    assert.equal(existsSync(target), true);
    assert.equal(existsSync(building), true, 'swapInto itself leaves the build; swapOrRefuse removes it');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- R1-L3: force on the ACTIVE environment is now a dead end, but the hints still promise it -------

test('[FINDING R1-L3] a forced env_reset of an environment the serving process holds open can never succeed, yet environment_active still says "pass force to quiesce"', () => {
  const dir = mkdtempSync(join(tmpdir(), 'till-crit-r1-'));
  try {
    const deps = landscapeDeps(dir);
    const created = envCreate(deps, { name: 'probe', policy: 'synthetic', seed: 'minimal', tierRank: 30, confirmed: true });
    assert.equal(created.ok, true, JSON.stringify(created));
    const switched = envSwitch(deps, { name: 'probe', confirmed: true });
    assert.equal(switched.ok, true, JSON.stringify(switched));
    // The serving face (`till up` / `till mcp`) keeps a SqliteStore open on the active environment.
    const serving = new SqliteStore({ location: created.environment.dbPath });
    try {
      const unforced = envReset(deps, { name: 'probe', confirmed: true });
      assert.equal(unforced.error, 'environment_active', JSON.stringify(unforced));
      const forced = envReset(deps, { name: 'probe', confirmed: true, force: true });
      assert.equal(forced.ok, false);
      assert.equal(forced.reason, 'target_in_use', 'the swap refuses the serving connection itself');
      assert.equal(
        /force/.test(String(unforced.hint)),
        false,
        `environment_active tells the user "${unforced.hint}", but force on an environment the face holds open is always target_in_use`,
      );
    } finally {
      serving.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
