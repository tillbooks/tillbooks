// Critic R2-L2 and R3-L1: every landscape decision about whether a ledger is THERE asks one helper,
// `ledgerFilePresent` (`src/core/landscape/ledgerGuard.ts`): a path that is absent OR a 0-byte file holds
// no ledger, because SQLite opens a 0-byte file as a new, empty database. The mandate copy's own
// `target_data_missing` is pinned by `critic-aux-durability-r3.test.mjs`; this file pins the other sites
// the sweep routed through the helper. Synthetic ledgers in temp directories only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { envCopy, envCreate, envList, ledgerFilePresent } from '../../dist/core/landscape/index.js';
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

function truncateLedger(path) {
  for (const s of ['-wal', '-shm']) rmSync(path + s, { force: true });
  truncateSync(path, 0);
}

test('ledgerFilePresent: absent and 0 bytes are no ledger; a real ledger is one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'till-ledger-present-'));
  try {
    const path = join(dir, 'till.db');
    assert.equal(ledgerFilePresent(path), false, 'absent');
    writeFileSync(path, '');
    assert.equal(ledgerFilePresent(path), false, '0 bytes');
    rmSync(path);
    new SqliteStore({ location: path }).close();
    assert.equal(ledgerFilePresent(path), true, 'a ledger the store wrote');
    mkdirSync(join(dir, 'a-directory'));
    assert.equal(ledgerFilePresent(join(dir, 'a-directory')), true, 'a non-file is not judged missing here (the open refuses it)');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('env_list agrees with the guard: a 0-byte environment ledger reports exists: false', () => {
  const dir = mkdtempSync(join(tmpdir(), 'till-envlist-0b-'));
  try {
    const deps = landscapeDeps(dir);
    new SqliteStore({ location: deps.mainDbPath }).close();
    const created = envCreate(deps, { name: 'probe', policy: 'live', tierRank: 40, confirmed: true });
    assert.equal(created.ok, true, JSON.stringify(created));
    const view = () => envList(deps).environments.find((e) => e.name === 'probe');
    assert.equal(view().exists, true, 'non-vacuity: a real ledger exists');
    truncateLedger(created.environment.dbPath);
    assert.equal(view().exists, false);
    assert.equal(view().sizeBytes, 0, 'the size is still reported as it is');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a copy FROM a 0-byte source ledger is refused source_data_missing, and the target keeps its ledger', () => {
  const dir = mkdtempSync(join(tmpdir(), 'till-src-0b-'));
  try {
    const deps = landscapeDeps(dir);
    new SqliteStore({ location: deps.mainDbPath }).close();
    const src = envCreate(deps, { name: 'quelle', policy: 'live', tierRank: 250, confirmed: true });
    assert.equal(src.ok, true, JSON.stringify(src));
    const srcStore = new SqliteStore({ location: src.environment.dbPath });
    createWorkspace({ store: srcStore, clock: { now: () => AT }, ids: systemIdGen, actor: 'owner' }, { name: 'Mandant A AG' });
    srcStore.close();
    const tgt = envCreate(deps, { name: 'ziel', policy: 'live', tierRank: 40, confirmed: true });
    assert.equal(tgt.ok, true, JSON.stringify(tgt));
    assert.equal(envCopy(deps, { source: 'quelle', target: 'ziel', scope: 'instance', sanitize: 'raw', confirmed: true }).ok, true);
    const sizeBefore = statSync(tgt.environment.dbPath).size;

    truncateLedger(src.environment.dbPath);
    const copied = envCopy(deps, { source: 'quelle', target: 'ziel', scope: 'instance', sanitize: 'raw', confirmed: true });
    assert.equal(copied.error, 'source_data_missing', JSON.stringify(copied));
    assert.equal(statSync(tgt.environment.dbPath).size, sizeBefore, 'the target ledger was not replaced by an empty one');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
