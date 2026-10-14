// @ts-check
/**
 * A25 Studio regression (critic/cl-review, 91e0b750): every review act carries its OWN idempotency key.
 *
 * The engine replays a stored success for a key it has seen, which is what makes a retried call safe.
 * The Review surface used to key an approve by the entry (`approve:<ws>:<entry>`) and a lock by the
 * period (`lock:<ws>:<period>`), so a SECOND act replayed the FIRST one's stale success once the state
 * had moved on: approve, flag, approve again left the entry flagged while answering ok; lock, unlock,
 * lock again wrote no lock while answering `kind: 'hard'`, and the Studio then showed a lock that did
 * not exist. The Studio now appends a per-act nonce (`approve:<ws>:<entry>:<nonce>`,
 * `lock:<ws>:<period>:<nonce>`), pinned in `app/src/surfaces/Review/Review.test.tsx`.
 *
 * The first two cases keep the critic's repro of WHY the fixed key was wrong (the engine contract
 * that a seen key replays); the last two prove the per-act key shape the Studio now sends does what
 * the user asked.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { freshDeps, mintWorkspace, manualPost } from '../api/support.mjs';

/** @param {string} seed */
function fixture(seed) {
  const deps = freshDeps();
  const { workspaceId, accId } = mintWorkspace(deps, 'Probe AG', `${seed}-ws`);
  /** @param {string} name @param {Record<string, unknown>} input @returns {any} */
  const call = (name, input) => {
    const action = getAction(name);
    assert.ok(action !== undefined, `the registry has ${name}`);
    return action.run(deps, { workspaceId, ...input });
  };
  return { workspaceId, accId, call };
}

/** @param {any[]} entries @param {string} id */
function statusOf(entries, id) {
  const found = entries.find((e) => e.entryId === id);
  assert.ok(found !== undefined, `entry ${id} is in the review list`);
  return found.status;
}

test('why: a key fixed to the entry replays the first approve, so approve, flag, approve stays flagged', () => {
  const { workspaceId, accId, call } = fixture('fixed-approve');
  const entryId = call('post_entry', manualPost(accId, 'pr-1', 5000)).entryId;
  const key = `approve:${workspaceId}:${entryId}`;
  assert.equal(call('approve_entry', { entryId, idempotencyKey: key }).ok, true);
  assert.equal(call('flag_entry', { entryId, reason: 'Beleg fehlt', idempotencyKey: 'f1' }).ok, true);
  assert.equal(call('approve_entry', { entryId, idempotencyKey: key }).ok, true, 'the replay reports success');
  assert.equal(statusOf(call('review_status', { period: '2026-03' }).entries, entryId), 'flagged', 'and changes nothing');
});

test('why: a key fixed to the period replays the first lock, so lock, unlock, lock writes no lock', () => {
  const { workspaceId, call } = fixture('fixed-lock');
  const input = { period: '2026-03', kind: 'hard', reason: 'treuhaender_review', idempotencyKey: `lock:${workspaceId}:2026-03` };
  assert.equal(call('lock_period', input).ok, true);
  assert.equal(call('unlock_period', { period: '2026-03', idempotencyKey: 'u1' }).ok, true);
  const relock = call('lock_period', input);
  assert.equal(relock.ok, true);
  assert.equal(relock.kind, 'hard', 'the replay claims a hard lock');
  assert.deepEqual(call('list_period_locks', {}).locks, [], 'but no lock exists');
});

test('the Studio key shape: approve, flag, approve again with per-act keys approves the entry', () => {
  const { workspaceId, accId, call } = fixture('act-approve');
  const entryId = call('post_entry', manualPost(accId, 'pr-1', 5000)).entryId;
  assert.equal(call('approve_entry', { entryId, idempotencyKey: `approve:${workspaceId}:${entryId}:n1` }).ok, true);
  assert.equal(call('flag_entry', { entryId, reason: 'Beleg fehlt', idempotencyKey: `flag:${workspaceId}:${entryId}:n2` }).ok, true);
  assert.equal(statusOf(call('review_status', { period: '2026-03' }).entries, entryId), 'flagged');
  assert.equal(call('approve_entry', { entryId, idempotencyKey: `approve:${workspaceId}:${entryId}:n3` }).ok, true);
  assert.equal(statusOf(call('review_status', { period: '2026-03' }).entries, entryId), 'approved');
});

test('the Studio key shape: lock, unlock, lock again with per-act keys leaves a real hard lock', () => {
  const { workspaceId, call } = fixture('act-lock');
  const lock = (/** @type {string} */ n) =>
    call('lock_period', { period: '2026-03', kind: 'hard', reason: 'treuhaender_review', idempotencyKey: `lock:${workspaceId}:2026-03:${n}` });
  assert.equal(lock('n1').ok, true);
  assert.equal(call('unlock_period', { period: '2026-03', idempotencyKey: 'u1' }).ok, true);
  assert.deepEqual(call('list_period_locks', {}).locks, []);
  const relock = lock('n2');
  assert.equal(relock.ok, true);
  const locks = call('list_period_locks', {}).locks;
  assert.equal(locks.length, 1, 'the second lock is written');
  assert.equal(locks[0].period, '2026-03');
  assert.equal(locks[0].kind, 'hard');
});
