import test from 'node:test';
import assert from 'node:assert/strict';

import { SqliteStore } from '../../dist/core/store/sqlite-store.js';

const WAVE0_TABLES = [
  'workspace',
  'account',
  'cost_center',
  'journal_entry',
  'journal_line',
  'tax_code',
  'period_lock',
  'audit_log',
  'contact',
  'item',
  'idempotency',
];

const INSERT_WS =
  'INSERT INTO workspace (id, name, base_currency, fiscal_year_start, created_at) VALUES (?, ?, ?, ?, ?)';

test('a fresh store has every Wave-0 table from the D0 data model', () => {
  const store = new SqliteStore();
  const names = store.db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((r) => r.name);
  for (const t of WAVE0_TABLES) {
    assert.ok(names.includes(t), `missing table: ${t}`);
  }
  store.close();
});

test('foreign keys are enforced (tenant integrity depends on it)', () => {
  const store = new SqliteStore();
  assert.equal(store.db.pragma('foreign_keys', { simple: true }), 1);
  store.close();
});

test('tx commits its writes when the body succeeds', () => {
  const store = new SqliteStore();
  store.tx(() => {
    store.db.prepare(INSERT_WS).run('ws_1', 'Acme', 'CHF', '01-01', '2026-07-16T00:00:00.000Z');
  });
  assert.equal(store.db.prepare('SELECT COUNT(*) AS c FROM workspace').get().c, 1);
  store.close();
});

test('tx rolls back every write when the body throws (atomic posting depends on it)', () => {
  const store = new SqliteStore();
  assert.throws(
    () =>
      store.tx(() => {
        store.db.prepare(INSERT_WS).run('ws_1', 'Acme', 'CHF', '01-01', '2026-07-16T00:00:00.000Z');
        throw new Error('boom');
      }),
    /boom/,
  );
  assert.equal(store.db.prepare('SELECT COUNT(*) AS c FROM workspace').get().c, 0);
  store.close();
});

test('rememberIdempotent runs compute once and replays the stored result on retry', () => {
  const store = new SqliteStore();
  let calls = 0;
  const compute = () => {
    calls++;
    return { ok: true, entryId: 'entry_1' };
  };
  const first = store.rememberIdempotent('ws_1', 'key-abc', 'post_entry', compute);
  const second = store.rememberIdempotent('ws_1', 'key-abc', 'post_entry', compute);
  assert.deepEqual(first, { ok: true, entryId: 'entry_1' });
  assert.deepEqual(second, first);
  assert.equal(calls, 1, 'compute must not run a second time for the same key');
  store.close();
});

test('rememberIdempotent scopes the key to the workspace', () => {
  const store = new SqliteStore();
  let calls = 0;
  const compute = (id) => () => {
    calls++;
    return { ok: true, id };
  };
  const a = store.rememberIdempotent('ws_1', 'same-key', 'v', compute('a'));
  const b = store.rememberIdempotent('ws_2', 'same-key', 'v', compute('b'));
  assert.equal(a.id, 'a');
  assert.equal(b.id, 'b');
  assert.equal(calls, 2, 'the same key in a different workspace is a different request');
  store.close();
});
