// A01/A38: a workspace born before a seed account existed receives it on the next open, by number,
// and nothing the book already tuned is touched. `seedChartOfAccounts` runs once at
// `create_workspace`, so until generation 7 a pre-A38 file never gained 2330, 3809 or 8900 and
// `tax_provision_preview` read `missingAccounts` on it forever. This suite builds a REAL file whose
// workspace lacks the three (hard-deleted the A01 way, unposted) with a renamed neighbour, rewinds
// the generation marker the way an upgraded file carries it, and reopens.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { SCHEMA_GENERATION } from '../../dist/core/store/schema.js';
import { fixedClock } from '../../dist/core/clock.js';
import { sequenceIdGen } from '../../dist/core/ids.js';
import { getAction } from '../../dist/api/registry.js';

const AT = '2026-09-09T00:00:00.000Z';
const A38 = ['2330', '3809', '8900'];
const call = (deps, name, input) => getAction(name).run(deps, input);

function chart(store, workspaceId) {
  return store.db.prepare('SELECT number, name, type FROM account WHERE workspace_id = ? ORDER BY number').all(workspaceId);
}

test('generation 7: a pre-A38 workspace gains exactly 2330, 3809 and 8900 on reopen; a renamed account keeps its name; a second open adds nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'till-a38-topup-'));
  const location = join(dir, 'till.db');
  const clock = fixedClock(AT);
  let store = new SqliteStore({ clock, location });
  try {
    const deps = { store, clock, ids: sequenceIdGen(), actor: 'studio' };
    const ws = call(deps, 'create_workspace', { name: 'Alt GmbH', idempotencyKey: 'ws' });
    assert.equal(ws.ok, true, JSON.stringify(ws));
    const workspaceId = ws.workspaceId;
    const accId = (n) => store.db.prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?').get(workspaceId, n)?.id;

    // The book as A38 found it: born without the three, and 6800 tuned by hand.
    for (const n of A38) {
      const gone = call(deps, 'delete_account', { workspaceId, accountId: accId(n), idempotencyKey: `del-${n}` });
      assert.equal(gone.ok, true, JSON.stringify(gone));
    }
    const renamed = call(deps, 'update_account', { workspaceId, accountId: accId('6800'), name: 'Garantie- und Kulanzkosten' });
    assert.equal(renamed.ok, true, JSON.stringify(renamed));
    const before = chart(store, workspaceId);
    assert.deepEqual(before.filter((a) => A38.includes(a.number)), []);
    const preview = call(deps, 'tax_provision_preview', { workspaceId, periodEnd: '2026-12-31' });
    assert.deepEqual(preview.missingAccounts.sort(), ['2330', '8900'], 'the helper names what the old book lacks');

    // Rewind the marker to the pre-A38 generation, exactly what an upgraded file carries.
    store.db.pragma(`user_version = ${SCHEMA_GENERATION - 1}`);
    store.close();

    // The upgrade: reopening applies generation 7.
    store = new SqliteStore({ clock, location });
    const reopened = { store, clock, ids: sequenceIdGen(), actor: 'studio' };
    assert.equal(store.db.pragma('user_version', { simple: true }), SCHEMA_GENERATION);
    const after = chart(store, workspaceId);
    assert.deepEqual(
      after.filter((a) => A38.includes(a.number)).map((a) => [a.number, a.type]),
      [['2330', 'liability'], ['3809', 'income'], ['8900', 'expense']],
      'the three seed accounts are back with their seed types',
    );
    assert.equal(after.length, before.length + 3, 'exactly the three, nothing else');
    assert.equal(after.find((a) => a.number === '6800').name, 'Garantie- und Kulanzkosten', 'a tuned label is never overwritten');
    assert.deepEqual(
      after.filter((a) => !A38.includes(a.number)),
      before,
      'every other row reads as it did',
    );
    const filled = call(reopened, 'tax_provision_preview', { workspaceId, periodEnd: '2026-12-31' });
    assert.deepEqual(filled.missingAccounts, [], 'the helper reads empty on the upgraded book');

    // Idempotent: a second open changes nothing.
    store.close();
    store = new SqliteStore({ clock, location });
    assert.deepEqual(chart(store, workspaceId), after);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a colliding id supply cannot half-seed a workspace: create_workspace fails, the transaction rolls back, no row and no open transaction remain', () => {
  // The pre-A38 birth seed was `INSERT OR IGNORE ... VALUES`, and OR IGNORE swallows a PRIMARY KEY
  // collision as readily as a duplicate number: an id generator that answered the same id twice
  // left the workspace with ONE account of the whole chart and `create_workspace` said ok. The
  // shared top-up inserts `WHERE NOT EXISTS (number)` and lets the id collision throw, so a broken
  // id supply is a loud failure at birth, and `store.tx` rolls the whole birth back.
  const dir = mkdtempSync(join(tmpdir(), 'till-a38-collide-'));
  const location = join(dir, 'till.db');
  const clock = fixedClock(AT);
  const store = new SqliteStore({ clock, location });
  try {
    const deps = { store, clock, ids: { next: (prefix) => `${prefix}_1` }, actor: 'studio' };
    const ws = call(deps, 'create_workspace', { name: 'Kollision GmbH', idempotencyKey: 'ws' });
    assert.equal(ws.ok, false, JSON.stringify(ws));
    assert.equal(ws.error, 'unexpected_error');
    assert.match(ws.message, /UNIQUE constraint failed: account\.id/);
    assert.equal(store.db.inTransaction, false, 'the failed birth leaves no transaction open');
    const { accounts, workspaces } = store.db
      .prepare('SELECT (SELECT COUNT(*) FROM account) AS accounts, (SELECT COUNT(*) FROM workspace) AS workspaces')
      .get();
    assert.deepEqual({ accounts, workspaces }, { accounts: 0, workspaces: 0 }, 'nothing of the half-born workspace survives');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
