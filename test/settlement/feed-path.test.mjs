// A43 section 4, the feed path: set_settlement_source gains an optional feedPath. SYNTHETIC DATA ONLY
// (see support.mjs): the platform, the processor, the address and the token are invented.

import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { makeContext } from '../../dist/core/context.js';
import { fixedClock } from '../../dist/core/clock.js';
import { setSettlementSource, getSettlementSource, pullSettlement, SETTLEMENT_FEED_PATH } from '../../dist/core/settlement/index.js';
import { getAction } from '../../dist/api/registry.js';
import { runGoverned } from '../../dist/api/agent-gate.js';
import { composeFeedUrl } from '../../dist/core/settlement/source.js';
import { secondWorkspace, assertClaimInvariantHolds } from '../banking/bank-inbox-support.mjs';
import { settlementWorld, setTemplate, must, refused, SYSTEM, PROCESSOR } from './support.mjs';

afterEach(assertClaimInvariantHolds);

const NOW = '2026-10-05T08:00:00.000Z';
const BASE = 'http://127.0.0.1:8899';
const TOKEN = 'kw_test_token_0123456789abcdef';
const EMPTY_FEED = { schema: 'till-settlement/v1', source: { system: SYSTEM, processor: PROCESSOR }, events: [] };

function feedWorld() {
  const t = settlementWorld();
  const tokens = new Map();
  const calls = [];
  const port = {
    secretStore: 'memory',
    storeToken: (ref, token) => (tokens.set(ref, token), { ok: true }),
    deleteToken: (ref) => (tokens.delete(ref), { ok: true }),
    hasToken: (ref) => tokens.has(ref),
    fetchFeed(req) {
      calls.push(req);
      return { kind: 'response', status: 200, body: JSON.stringify(EMPTY_FEED) };
    },
  };
  const fctx = makeContext(t.store, { workspaceId: t.workspaceId, actor: 'user_1', clock: fixedClock(NOW), ids: t.ids, settlementFeed: port });
  return { ...t, calls, fctx, tokens };
}

let n = 0;
const save = (t, extra = {}, ctx = t.fctx) => setSettlementSource(ctx, { system: SYSTEM, processor: PROCESSOR, baseUrl: BASE, fromDate: '2026-07-01', feedToken: TOKEN, idempotencyKey: `fp-${n++}`, ...extra });

test('the default path is unchanged when feedPath is not given', () => {
  const t = feedWorld();
  const saved = must(save(t));
  assert.equal(saved.source.feedPath, SETTLEMENT_FEED_PATH);
  assert.equal(saved.source.baseUrl, BASE);
  setTemplate(t, t.fctx);
  must(pullSettlement(t.fctx, { system: SYSTEM, processor: PROCESSOR, from: '2026-07-01', to: '2026-07-31', idempotencyKey: 'pull-default' }));
  assert.equal(t.calls[0].url, `${BASE}${SETTLEMENT_FEED_PATH}?from=2026-07-01&to=2026-07-31`);
});

test('a custom feedPath is the path the pull asks, and the answer shows it', () => {
  const t = feedWorld();
  const saved = must(save(t, { feedPath: '/my/connector/feed' }));
  assert.equal(saved.source.feedPath, '/my/connector/feed');
  assert.equal(saved.source.baseUrl, BASE, 'the base address never carries the path');
  setTemplate(t, t.fctx);
  must(pullSettlement(t.fctx, { system: SYSTEM, processor: PROCESSOR, from: '2026-07-01', to: '2026-07-31', idempotencyKey: 'pull-custom' }));
  assert.equal(t.calls[0].url, `${BASE}/my/connector/feed?from=2026-07-01&to=2026-07-31`);
  // A save without feedPath keeps the saved path (and so the token).
  const again = must(save(t, { feedToken: undefined, fromDate: '2026-08-01' }));
  assert.equal(again.source.feedPath, '/my/connector/feed');
  assert.equal(again.source.tokenStored, true);
});

test('a path with a query or a fragment, or anything that is not a path, is refused invalid_input', () => {
  const t = feedWorld();
  for (const bad of ['/feed?x=1', '/feed#frag', 'feed', '//evil.example/x', '/a/../b', '/has space', '', 42]) {
    const res = save(t, { feedPath: bad });
    const err = refused(res, 'invalid_input');
    assert.equal(err.field, 'feedPath', JSON.stringify(bad));
  }
  assert.deepEqual(must(getSettlementSource(t.fctx, {})).sources, [], 'a refused save writes nothing');
});

test('[INVARIANT token-address] a changed feedPath without a new token drops the stored token', () => {
  const t = feedWorld();
  must(save(t, { feedPath: '/one' }));
  const same = must(save(t, { feedPath: '/one', feedToken: undefined }));
  assert.equal(same.tokenDroppedUrlMoved, false);
  assert.equal(same.source.tokenStored, true);
  const moved = must(save(t, { feedPath: '/two', feedToken: undefined }));
  assert.equal(moved.tokenDroppedUrlMoved, true);
  assert.equal(moved.source.tokenStored, false);
  assert.equal(t.tokens.size, 0, 'the secret store item is gone');
  // Back to the default path is a move too.
  must(save(t, { feedPath: '/two' }));
  const home = must(save(t, { feedPath: SETTLEMENT_FEED_PATH, feedToken: undefined }));
  assert.equal(home.tokenDroppedUrlMoved, true);
  assert.equal(home.source.feedPath, SETTLEMENT_FEED_PATH);
});

test('[INVARIANT tenant] another workspace sees neither the source nor its path', () => {
  const t = feedWorld();
  must(save(t, { feedPath: '/mine' }));
  const b = secondWorkspace(t);
  const bctx = makeContext(t.store, { workspaceId: b.workspaceId, actor: 'user_1', clock: fixedClock(NOW), ids: t.ids, settlementFeed: t.fctx.settlementFeed });
  assert.deepEqual(must(getSettlementSource(bctx, {})).sources, []);
  // The other workspace saves the same source: its own default, never this one's path.
  const theirs = must(save(t, {}, bctx));
  assert.equal(theirs.source.feedPath, SETTLEMENT_FEED_PATH);
  assert.equal(must(getSettlementSource(t.fctx, {})).sources[0].feedPath, '/mine');
});

test('a legacy row (feed_path NULL, as before the column existed) reads and pulls as the default path', () => {
  const t = feedWorld();
  must(save(t, { feedPath: '/custom' }));
  t.store.db.prepare('UPDATE settlement_source SET feed_path = NULL WHERE workspace_id = ?').run(t.workspaceId);
  assert.equal(must(getSettlementSource(t.fctx, {})).sources[0].feedPath, SETTLEMENT_FEED_PATH);
  setTemplate(t, t.fctx);
  must(pullSettlement(t.fctx, { system: SYSTEM, processor: PROCESSOR, from: '2026-07-01', to: '2026-07-31', idempotencyKey: 'pull-legacy' }));
  assert.equal(t.calls[0].url, `${BASE}${SETTLEMENT_FEED_PATH}?from=2026-07-01&to=2026-07-31`);
});

test('saving the default path keeps the column NULL, and base_url never carries the path', () => {
  const t = feedWorld();
  must(save(t, { feedPath: '/custom' }));
  const row = t.store.db.prepare('SELECT base_url, feed_path FROM settlement_source WHERE workspace_id = ?').get(t.workspaceId);
  assert.deepEqual({ ...row }, { base_url: BASE, feed_path: '/custom' });
  must(save(t, { feedPath: SETTLEMENT_FEED_PATH, feedToken: undefined }));
  assert.equal(t.store.db.prepare('SELECT feed_path FROM settlement_source WHERE workspace_id = ?').get(t.workspaceId).feed_path, null);
});

test('[INVARIANT path-containment] encoded dot and separator segments are refused, and the composed URL stays under the base', () => {
  // Guards source.ts readFeedPath and composeFeedUrl (critic M2): a URL parser collapses %2e%2e.
  const t = feedWorld();
  for (const bad of ['/%2e%2e/admin', '/.%2e/z', '/x/%2E%2e/y', '/x/%2e/y', '/a%2Fb', '/a%2fb', '/a%5Cb', '/a%5cb']) {
    refused(save(t, { feedPath: bad }), 'invalid_input');
  }
  assert.equal(composeFeedUrl('https://host.example/base', '/feed', { from: '2026-07-01', to: '2026-07-31' }), 'https://host.example/base/feed?from=2026-07-01&to=2026-07-31');
  assert.equal(composeFeedUrl('https://host.example/base', '/%2e%2e/admin'), null, 'the parser collapses it out of the base: refused');
  assert.equal(composeFeedUrl('https://host.example/base', '/.%2e/z'), null);
  assert.deepEqual(must(getSettlementSource(t.fctx, {})).sources, [], 'nothing was saved');
  // A row that already holds such a path (written by another build) is never fetched.
  must(save(t, { feedPath: '/ok' }));
  t.store.db.prepare('UPDATE settlement_source SET feed_path = ? WHERE workspace_id = ?').run('/%2e%2e/admin', t.workspaceId);
  setTemplate(t, t.fctx);
  refused(pullSettlement(t.fctx, { system: SYSTEM, processor: PROCESSOR, from: '2026-07-01', to: '2026-07-31', idempotencyKey: 'pull-bad-path' }), 'feed_path_invalid');
  assert.equal(t.calls.length, 0, 'nothing was fetched');
});

test('[INVARIANT governance-pin-path] a pending agent pull goes vorschlag_stale when a person changes feedPath and supplies a new token (critic L3)', () => {
  // Guards vorschlagPin.ts settlement_sources_all, which now pins feed_path.
  const t = feedWorld();
  must(save(t, { feedPath: '/one' }));
  setTemplate(t, t.fctx);
  const agent = { store: t.store, clock: t.fctx.clock, ids: t.ids, actor: 'agent', settlementFeed: t.fctx.settlementFeed };
  const drafted = runGoverned(agent, getAction('pull_settlement'), { workspaceId: t.workspaceId, system: SYSTEM, processor: PROCESSOR, from: '2026-07-01', to: '2026-07-31', idempotencyKey: 'draft-pull-path' });
  assert.equal(typeof drafted.actionId, 'string', JSON.stringify(drafted));
  must(save(t, { feedPath: '/two', feedToken: 'kw_other_token_0123456789abcd' }));
  const decided = getAction('approve_drafted_action').run({ store: t.store, clock: t.fctx.clock, ids: t.ids, actor: 'studio', settlementFeed: t.fctx.settlementFeed }, { workspaceId: t.workspaceId, actionId: drafted.actionId });
  assert.equal(decided.error, 'vorschlag_stale', JSON.stringify(decided));
  assert.equal(t.calls.length, 0, 'nothing was fetched');
});

test('a source whose address moved between the first read and the write still drops the token (critic L5)', () => {
  const t = feedWorld();
  must(save(t, { feedPath: '/one' }));
  // The same save twice with the new path: the second sees a row already moved, no token supplied, token already dropped.
  const first = must(save(t, { feedPath: '/two', feedToken: undefined }));
  assert.equal(first.tokenDroppedUrlMoved, true);
  assert.equal(first.source.tokenStored, false);
  const second = must(save(t, { feedPath: '/two', feedToken: undefined }));
  assert.equal(second.tokenDroppedUrlMoved, false);
  assert.equal(second.changed, false);
});

test('[INVARIANT token-address-race] a row moved between the first read and the write still drops the token and nulls token_ref (critic L5)', () => {
  // Guards source.ts movedNow/dropNow: the drop is decided against the row the write replaces. The clock's
  // first call inside the write moves the row, as another connection's save would have.
  const t = feedWorld();
  must(save(t, { feedPath: '/one' }));
  const events = [];
  const port = t.fctx.settlementFeed;
  const watched = { ...port, deleteToken: (ref) => (events.push('delete'), port.deleteToken(ref)) };
  const base = fixedClock(NOW);
  let armed = true;
  const clock = {
    ...base,
    now() {
      if (armed) {
        armed = false;
        events.push('moved');
        t.store.db.prepare('UPDATE settlement_source SET feed_path = ? WHERE workspace_id = ?').run('/elsewhere', t.workspaceId);
      }
      return base.now();
    },
  };
  const ctx = makeContext(t.store, { workspaceId: t.workspaceId, actor: 'user_1', clock, ids: t.ids, settlementFeed: watched });
  // Same address as the row WAS (so the outside check sees no move), no token supplied.
  const res = must(save(t, { feedPath: '/one', feedToken: undefined }, ctx));
  assert.deepEqual(events, ['moved', 'delete'], 'the delete came from inside the write, after the row moved');
  assert.equal(res.tokenDroppedUrlMoved, true, 'the row this save replaced had moved');
  const row = t.store.db.prepare('SELECT token_ref, feed_path FROM settlement_source WHERE workspace_id = ?').get(t.workspaceId);
  assert.equal(row.token_ref, null, 'token_ref is nulled');
  assert.equal(res.source.tokenStored, false);
  assert.equal(t.tokens.size, 0, 'the secret store item is gone');
});
