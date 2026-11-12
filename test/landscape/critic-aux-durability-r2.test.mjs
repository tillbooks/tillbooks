// Critic round 2 probes for claude/aux-durability-beta5 (e3b7f3782): the missing-environment-ledger guard.
//
// `[FINDING R2-...]` tests assert the behaviour a fix must produce and FAIL on the reviewed head
// (evidence for `docs/critique/port-aux-durability-critic-r2.md`). Synthetic ledgers in temp dirs only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, rmSync, statSync, truncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { envCreate, envList } from '../../dist/core/landscape/index.js';
import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { ensureDbChoice } from '../../dist/api/db-path.js';
import { systemIdGen } from '../../dist/core/ids.js';

const AT = '2026-09-24T00:00:00.000Z';

function ledgerWithMarker(path, marker) {
  mkdirSync(dirname(path), { recursive: true });
  const s = new SqliteStore({ location: path });
  s.db.prepare('INSERT INTO idempotency (workspace_id, key, verb, result_json, created_at) VALUES (?, ?, ?, ?, ?)').run('marker', marker, 'seed', '{}', AT);
  s.close();
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

test('[FINDING R2-L2] a registered environment ledger truncated to 0 bytes passes the guard and opens as a brand-new empty ledger', () => {
  const dir = mkdtempSync(join(tmpdir(), 'till-crit-r2-'));
  try {
    const deps = landscapeDeps(dir);
    const created = envCreate(deps, { name: 'probe', policy: 'synthetic', seed: 'minimal', tierRank: 30, confirmed: true });
    assert.equal(created.ok, true, JSON.stringify(created));
    const envDb = created.environment.dbPath;
    // A half-restored disk, an interrupted copy, a sync client's placeholder: the name is there, the bytes are not.
    for (const s of ['-wal', '-shm']) rmSync(envDb + s, { force: true });
    truncateSync(envDb, 0);

    let refused;
    try {
      ensureDbChoice({ TILL_DB_PATH: envDb, TILL_SUPPORT_DIR: dir });
    } catch (e) {
      refused = e;
    }
    if (refused === undefined) {
      // What a face does next: open it. SQLite treats a 0-byte file as an empty database.
      const s = new SqliteStore({ location: envDb });
      s.close();
    }
    // Adjusted by the implementation (R2-L2): with the fix the guard refuses and the 0-byte file stays
    // untouched, so it has no `idempotency` table; that read is diagnostic text only and must not throw.
    const db = new Database(envDb, { readonly: true });
    let rows;
    try {
      rows = db.prepare("SELECT COUNT(*) AS n FROM idempotency WHERE workspace_id = 'marker'").get().n;
    } catch (e) {
      rows = `none (${e.message})`;
    }
    db.close();
    assert.equal(
      refused?.name,
      'MissingEnvironmentLedgerError',
      `the guard let a 0-byte ledger through; the face opened it as a fresh schema-only ledger (${statSync(envDb).size} bytes, ${rows} seeded rows), and env_list says exists: ${JSON.stringify(envList(deps).environments?.find?.((e) => e.name === 'probe')?.exists)}`,
    );
    assert.equal(statSync(envDb).size, 0, 'the refused 0-byte ledger is left as it was: nothing was created in it');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
