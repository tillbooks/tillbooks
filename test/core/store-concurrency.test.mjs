// D12 put a second writer on the file: the Studio holds the database open while `till mcp` runs in
// an agent subprocess. These pin the three things that changes: a lock is WAITED for rather than
// failing instantly, a lock that does time out is a NAMED error rather than a shrug, and the WAL is
// checkpointed on a clean close instead of growing without bound.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SqliteStore, DEFAULT_BUSY_TIMEOUT_MS, isBusyError } from '../../dist/core/store/sqlite-store.js';
import { getAction } from '../../dist/api/registry.js';

function tempDb(name = 'till.db') {
  return join(mkdtempSync(join(tmpdir(), 'till-store-')), name);
}

test('a store waits for a held lock instead of failing instantly', () => {
  const store = new SqliteStore({ location: ':memory:' });
  const [{ timeout }] = store.db.pragma('busy_timeout');
  assert.equal(timeout, DEFAULT_BUSY_TIMEOUT_MS);
  assert.ok(DEFAULT_BUSY_TIMEOUT_MS > 0, 'a zero timeout is the no-waiting default this replaces');
  store.close();
});

test('the busy timeout is configurable, for a caller that wants to fail faster', () => {
  const store = new SqliteStore({ location: ':memory:', busyTimeoutMs: 250 });
  const [{ timeout }] = store.db.pragma('busy_timeout');
  assert.equal(timeout, 250);
  store.close();
});

test('isBusyError recognises a lock contention error and nothing else', () => {
  assert.equal(isBusyError(Object.assign(new Error('db locked'), { code: 'SQLITE_BUSY' })), true);
  assert.equal(isBusyError(Object.assign(new Error('locked'), { code: 'SQLITE_BUSY_SNAPSHOT' })), true);
  assert.equal(isBusyError(Object.assign(new Error('nope'), { code: 'SQLITE_CONSTRAINT' })), false);
  assert.equal(isBusyError(new Error('plain')), false);
  assert.equal(isBusyError('not an error'), false);
});

test('a SQLITE_BUSY escaping a verb is a NAMED, retryable rejection, not unexpected_error', () => {
  // A store stub whose very first query throws the way a locked database does. It goes through the
  // real ctxAction guard, which is the code path that used to flatten this to `unexpected_error`:
  // a caller could not tell "try again in a moment" from "something is broken".
  const busy = Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
  const deps = {
    store: {
      db: {
        prepare() {
          throw busy;
        },
      },
    },
    clock: { now: () => '2026-07-20T00:00:00.000Z' },
    ids: { next: () => 'x' },
    actor: 'studio',
  };

  const res = getAction('list_accounts').run(deps, { workspaceId: 'ws_1' });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'store_busy', 'lock contention must be its own error code');
  assert.equal(res.retryable, true, 'the caller needs to know this one is worth retrying');
  assert.equal(res.action, 'list_accounts');
});

test('a non-busy throw is still unexpected_error, so the new code stays meaningful', () => {
  const deps = {
    store: {
      db: {
        prepare() {
          throw new TypeError('something genuinely broken');
        },
      },
    },
    clock: { now: () => '2026-07-20T00:00:00.000Z' },
    ids: { next: () => 'x' },
    actor: 'studio',
  };

  const res = getAction('list_accounts').run(deps, { workspaceId: 'ws_1' });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'unexpected_error');
});

test('a clean close checkpoints the WAL, so till.db-wal does not grow without bound', () => {
  const path = tempDb();
  const store = new SqliteStore({ location: path });
  const res = getAction('create_workspace').run(
    { store, clock: { now: () => '2026-07-20T00:00:00.000Z' }, ids: { next: (p) => `${p}_1` }, actor: 'agent' },
    { name: 'WAL GmbH', idempotencyKey: 'w' },
  );
  assert.equal(res.ok, true);

  const wal = `${path}-wal`;
  assert.ok(existsSync(wal) && statSync(wal).size > 0, 'the write should have gone through the WAL first');

  store.close();

  // TRUNCATE leaves the file at zero bytes (or removes it): either way, no unbounded growth.
  assert.ok(!existsSync(wal) || statSync(wal).size === 0, 'the WAL must be checkpointed on a clean close');
  assert.ok(statSync(path).size > 0, 'and the pages must have landed in the main database');
});

test('checkpoint is safe to call explicitly, and on an in-memory database', () => {
  const store = new SqliteStore({ location: ':memory:' });
  assert.doesNotThrow(() => store.checkpoint());
  store.close();
  // Closing twice must not throw either: shutdown paths run more than once.
  assert.doesNotThrow(() => store.close());
});
