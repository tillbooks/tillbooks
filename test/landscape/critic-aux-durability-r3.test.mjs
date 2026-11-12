// Critic round 3 probe for claude/aux-durability-beta5 (5ac88bf92): the 0-byte rule beside the mandate copy.
//
// R2-L2's fix made a 0-byte environment ledger count as MISSING in `ledgerGuard.ts`. The mandate copy's
// own missing-target guard (`copy.ts`, `target_data_missing`) is the sibling check for the same failure.
// This probe records what it does with a 0-byte target. Synthetic ledgers in temp directories only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, statSync, truncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { envCreate, envCopy } from '../../dist/core/landscape/index.js';
import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { createWorkspace } from '../../dist/core/setup/workspace.js';
import { systemIdGen } from '../../dist/core/ids.js';

const AT = '2026-09-24T00:00:00.000Z';

function landscapeDeps(dir) {
  return {
    supportDir: dir,
    environmentsRoot: join(dir, 'environments'),
    mainDbPath: join(dir, 'till.db'),
    actor: 'owner',
    now: () => AT,
    seeders: {},
    ids: systemIdGen,
    clock: { now: () => AT },
  };
}

test('[R3-PROBE] a mandate copy into a populated target whose ledger is 0 bytes is refused like a missing one (target_data_missing)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'till-crit-r3-'));
  try {
    const deps = landscapeDeps(dir);
    new SqliteStore({ location: deps.mainDbPath }).close();
    const src = envCreate(deps, { name: 'quelle', policy: 'live', tierRank: 250, confirmed: true });
    assert.equal(src.ok, true, JSON.stringify(src));
    const srcStore = new SqliteStore({ location: src.environment.dbPath });
    const a = createWorkspace({ store: srcStore, clock: { now: () => AT }, ids: systemIdGen, actor: 'owner' }, { name: 'Mandant A AG' });
    createWorkspace({ store: srcStore, clock: { now: () => AT }, ids: systemIdGen, actor: 'owner' }, { name: 'Mandant B AG' });
    srcStore.close();
    const tgt = envCreate(deps, { name: 'ziel', policy: 'live', tierRank: 40, confirmed: true });
    assert.equal(tgt.ok, true, JSON.stringify(tgt));
    const filled = envCopy(deps, { source: 'quelle', target: 'ziel', scope: 'instance', sanitize: 'raw', confirmed: true });
    assert.equal(filled.ok, true, JSON.stringify(filled));
    const tgtDb = tgt.environment.dbPath;
    for (const s of ['-wal', '-shm']) rmSync(tgtDb + s, { force: true });
    truncateSync(tgtDb, 0);

    const copied = envCopy(deps, { source: 'quelle', target: 'ziel', scope: `mandate:${a.workspaceId}`, sanitize: 'raw', confirmed: true });
    let names = [];
    if (statSync(tgtDb).size > 0) {
      const db = new Database(tgtDb, { readonly: true });
      names = db.prepare('SELECT name FROM workspace ORDER BY name').all().map((r) => r.name);
      db.close();
    }
    assert.equal(
      copied.error,
      'target_data_missing',
      `a 0-byte populated target was not treated as missing: the mandate copy answered ${JSON.stringify({ ok: copied.ok, error: copied.error })} and the target now holds ${JSON.stringify(names)}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
