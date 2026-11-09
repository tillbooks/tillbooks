/**
 * N01 US-N01.5, the CROSS-PROCESS race (critic follow-up): two connections on ONE book file, one key,
 * different arguments. D12 puts a second writer on the file (the Studio and an agent subprocess), and
 * the registry's check runs before the act's transaction, so the other process can spend the key in
 * between. The store repeats the check INSIDE the act's transaction (under the write lock) and throws,
 * so the second act rolls back; an act that wrote nothing (its engine replayed the other's memo) is
 * caught by the re-read after the call. Either way exactly one act stands under the key.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getAction } from '../../dist/api/registry.js';
import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { fixedClock } from '../../dist/core/clock.js';
import { systemIdGen } from '../../dist/core/ids.js';
import { makeContext } from '../../dist/core/context.js';
import { postEntry, ledgerPorts } from '../../dist/core/ledger/index.js';
import { claimIdempotencyArgs, IdempotencyKeyConflictError } from '../../dist/core/store/idempotencyArgs.js';
import { verbArgsIdentity } from '../../dist/core/agent/argsIdentity.js';

const AT = '2026-07-16T00:00:00.000Z';

function twoHandles() {
  const dir = mkdtempSync(join(tmpdir(), 'till-n01-race-'));
  const location = join(dir, 'book.db');
  const clock = fixedClock(AT);
  const a = { store: new SqliteStore({ location, clock }), clock, ids: systemIdGen, actor: 'studio' };
  const created = getAction('create_workspace').run(a, { name: 'Wettlauf GmbH', idempotencyKey: 'ws' });
  assert.equal(created.ok, true, JSON.stringify(created));
  const b = { store: new SqliteStore({ location, clock }), clock, ids: systemIdGen, actor: 'studio' };
  const workspaceId = created.workspaceId;
  const acc = (n) => a.store.db.prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?').get(workspaceId, n).id;
  const post = (amount) => ({
    date: '2026-03-01',
    description: 'Büromaterial',
    source: 'manual',
    idempotencyKey: 'race-K',
    lines: [
      { account: acc('6500'), debit: amount },
      { account: acc('1000'), credit: amount },
    ],
  });
  const close = () => {
    a.store.close();
    b.store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { a, b, workspaceId, post, close };
}

const entries = (store, workspaceId) =>
  store.db.prepare("SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ? AND status = 'posted'").get(workspaceId).n;

test('the store refuses inside the act\'s own transaction when another connection spent the key meanwhile: the act rolls back', () => {
  const { a, b, workspaceId, post, close } = twoHandles();
  try {
    const inputA = { workspaceId, ...post(5000) };
    const claim = { workspaceId, verb: 'post_entry', key: 'race-K', ...verbArgsIdentity('post_entry', inputA), excluded: [], refuses: true };
    const contacts = () => a.store.db.prepare('SELECT COUNT(*) AS n FROM contact WHERE workspace_id = ?').get(workspaceId).n;
    const before = contacts();
    assert.throws(
      () =>
        a.store.withIdempotencyArgs(claim, () => {
          // A passed its boundary check; now B (the other process) spends the same key with 7000.
          const winner = getAction('post_entry').run(b, { workspaceId, ...post(7000) });
          assert.equal(winner.ok, true, JSON.stringify(winner));
          // A's act writes: its transaction finds B's record under the lock and must not commit.
          a.store.tx(() =>
            a.store.db
              .prepare("INSERT INTO contact (id, workspace_id, party_role, name, default_currency, payment_terms_days, created_at) VALUES ('ct_race', ?, 'customer', 'Wettlauf', 'CHF', 0, ?)")
              .run(workspaceId, AT),
          );
        }),
      (e) => e instanceof IdempotencyKeyConflictError && e.fields.includes('lines'),
    );
    assert.equal(contacts(), before, 'the losing act rolled back');
    assert.equal(entries(a.store, workspaceId), 1, 'one act stands under the key');
  } finally {
    close();
  }
});

test('through the registry claim: an act that replays the other connection\'s memo is refused, not handed that act', () => {
  const { a, b, workspaceId, post, close } = twoHandles();
  try {
    const inputA = { workspaceId, ...post(5000) };
    const ctxA = makeContext(a.store, { workspaceId, actor: 'studio', clock: a.clock, ids: a.ids, ...ledgerPorts({ store: a.store, workspaceId, ids: a.ids }) });
    const res = claimIdempotencyArgs(
      a.store,
      { verb: 'post_entry', workspaceId, input: inputA },
      () => verbArgsIdentity('post_entry', inputA),
      () => 'exclude',
      () => {
        const winner = getAction('post_entry').run(b, { workspaceId, ...post(7000) });
        assert.equal(winner.ok, true, JSON.stringify(winner));
        return postEntry(ctxA, inputA); // finds B's memo and replays it: writes nothing
      },
    );
    assert.equal(res.ok, false, `A was handed B's act as its own: ${JSON.stringify(res)}`);
    assert.equal(res.error, 'idempotency_key_conflict');
    assert.deepEqual(res.fields, ['lines']);
    assert.equal(entries(a.store, workspaceId), 1);
    const amount = a.store.db
      .prepare("SELECT SUM(l.debit_minor) AS d FROM journal_line l JOIN journal_entry e ON e.id = l.entry_id WHERE e.workspace_id = ?")
      .get(workspaceId).d;
    assert.equal(amount, 7000, 'the one booking is the winner\'s');
  } finally {
    close();
  }
});

test('the same arguments from two connections are the same act: both answer it', () => {
  const { a, b, workspaceId, post, close } = twoHandles();
  try {
    const one = getAction('post_entry').run(a, { workspaceId, ...post(5000) });
    const two = getAction('post_entry').run(b, { workspaceId, ...post(5000) });
    assert.equal(one.ok, true);
    assert.deepEqual(two, one);
    assert.equal(entries(a.store, workspaceId), 1);
  } finally {
    close();
  }
});
