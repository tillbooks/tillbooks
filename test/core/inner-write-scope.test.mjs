/**
 * The K1 mechanism itself (04.10.2026): `SqliteStore.innerWrite` and `postEntryInternal`.
 *
 * What a composite's inner write is held under, and what it is not: an inner record lives in
 * `<composite>>verb`, which no public verb can name (the separator is refused in a verb), nesting
 * composes, the path unwinds on a throw, an async inner write is refused, the composite's OWN record
 * is untouched (so its replay is unchanged), and a posting under an internal scope neither sees nor is
 * seen by the public `post_entry` memo of the same key.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { SqliteStore, INNER_SCOPE_SEPARATOR, INNER_WRITE_COMPOSITES } from '../../dist/core/store/sqlite-store.js';
import { fixedClock } from '../../dist/core/clock.js';
import { getAction } from '../../dist/api/registry.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';
import { makeContext } from '../../dist/core/context.js';
import { ledgerPorts, postEntry } from '../../dist/core/ledger/index.js';
import { postEntryInternal, K1_INTERNAL_POST_SCOPES, YEAR_CLOSE_POST_SCOPE } from '../../dist/core/ledger/postEntry.js';
import { postEntryInternalChecked } from '../../dist/core/ledger/innerPosting.js';

const store = () => new SqliteStore({ clock: fixedClock('2026-10-04T08:00:00.000Z') });
const verbsOf = (s) => s.db.prepare("SELECT verb FROM idempotency WHERE workspace_id = 'ws' ORDER BY verb").all().map((r) => r.verb);

test('an inner record is held under <composite>>verb; outside any composite, under the verb', () => {
  const s = store();
  s.rememberIdempotent('ws', 'K', 'post_entry', () => ({ ok: true, who: 'public' }));
  const inner = s.innerWrite('capture_commit', () => s.rememberIdempotent('ws', 'K', 'post_entry', () => ({ ok: true, who: 'inner' })));
  assert.deepEqual(inner, { ok: true, who: 'inner' }, 'the inner write did not replay the public record under the same key');
  assert.deepEqual(verbsOf(s), ['capture_commit>post_entry', 'post_entry']);
  assert.equal(s.idempotencyScope('post_entry'), 'post_entry', 'the path unwound after the composite');
  // And the inner record replays inside the same composite only.
  assert.deepEqual(s.innerWrite('capture_commit', () => s.recallIdempotent('ws', 'K', 'post_entry')), { ok: true, who: 'inner' });
  assert.deepEqual(s.innerWrite('import_exchange_rates', () => s.recallIdempotent('ws', 'K', 'post_entry')), undefined);
});

test('nesting composes, and the path unwinds on a throw', () => {
  const s = store();
  s.innerWrite('migration_commit_step', () => s.innerWrite('capture_commit', () => assert.equal(s.idempotencyScope('x'), 'migration_commit_step>capture_commit>x')));
  assert.throws(() => s.innerWrite('capture_commit', () => { throw new Error('boom'); }), /boom/);
  assert.equal(s.idempotencyScope('x'), 'x');
});

test('no verb can carry the separator: only innerWrite puts it into a scope', () => {
  const s = store();
  const forged = `capture_commit${INNER_SCOPE_SEPARATOR}post_entry`;
  assert.throws(() => s.rememberIdempotent('ws', 'K', forged, () => ({ ok: true })), /separator/);
  assert.throws(() => s.recallIdempotent('ws', 'K', forged), /separator/);
  assert.deepEqual(verbsOf(s), []);
});

test('an async inner write is refused; a composite name outside the closed set is refused', () => {
  const s = store();
  assert.throws(() => s.innerWrite('capture_commit', async () => ({ ok: true })), /synchronous/);
  assert.throws(() => s.innerWrite('Capture>Commit', () => 1), /must match/);
  assert.ok(INNER_WRITE_COMPOSITES.every((c) => /^[a-z][a-z0-9_]*$/.test(c)));
});

test('postEntryInternal: the public post_entry memo and an internal one under the SAME key never meet', () => {
  const deps = freshDeps();
  const { workspaceId, accId } = mintWorkspace(deps, 'Scope GmbH', 'ws');
  const ctx = makeContext(deps.store, { workspaceId, actor: 'agent', clock: deps.clock, ids: deps.ids, ...ledgerPorts({ store: deps.store, workspaceId, ids: deps.ids }) });
  const lines = (n) => [{ account: accId('6500'), debit: n }, { account: accId('1000'), credit: n }];
  const pub = getAction('post_entry').run(deps, { workspaceId, date: '2026-03-01', source: 'manual', idempotencyKey: 'K:x', lines: lines(100) });
  assert.equal(pub.ok, true, JSON.stringify(pub));
  const internal = postEntryInternal(ctx, { date: '2026-03-01', source: 'import', idempotencyKey: 'K:x', lines: lines(9900) }, 'wage_journal_post_internal');
  assert.equal(internal.ok, true, JSON.stringify(internal));
  assert.notEqual(internal.entryId, pub.entryId);
  // Each replays only itself.
  assert.equal(postEntry(ctx, { date: '2026-03-01', source: 'manual', idempotencyKey: 'K:x', lines: lines(100) }).entryId, pub.entryId);
  assert.equal(postEntryInternal(ctx, { date: '2026-03-01', source: 'import', idempotencyKey: 'K:x', lines: lines(9900) }, 'wage_journal_post_internal').entryId, internal.entryId);
  // The checked door reads the entry back.
  const checked = postEntryInternalChecked(ctx, { date: '2026-03-01', source: 'import', idempotencyKey: 'K:x', lines: lines(9900) }, 'wage_journal_post_internal');
  assert.equal(checked.entryId, internal.entryId);
  // The scope set is closed and never a public verb name.
  for (const scope of [YEAR_CLOSE_POST_SCOPE, ...K1_INTERNAL_POST_SCOPES]) {
    assert.match(scope, /_internal$/);
    assert.equal(getAction(scope), undefined, `${scope} is a public verb name`);
  }
});

test('the composite record itself is unchanged: a composite replay replays', () => {
  const s = store();
  const run = () => s.rememberIdempotent('ws', 'C', 'capture_commit', () => s.innerWrite('capture_commit', () => s.rememberIdempotent('ws', 'C:vb', 'create_vendor_bill', () => ({ ok: true, n: Math.random() }))));
  const first = run();
  assert.deepEqual(run(), first);
  assert.deepEqual(verbsOf(s), ['capture_commit', 'capture_commit>create_vendor_bill']);
});
