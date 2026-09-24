/**
 * F-11 critic F3 (docs/critique/f11-served-collab-critic.md, A3): a redeemed token replayed by a
 * revoked (or revoked-then-re-invited) subject settles to `ok` ONLY while the membership is currently
 * ACCEPTED. Pre-fix the replay answered `ok` while seating nobody, and the Studio, reading any `ok` as
 * success, silently re-rendered the not-a-member page with no message.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { resolveServedActor } from '../../dist/api/session.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';

const call = (deps, name, input) => getAction(name).run(deps, input);

function served(deps, subject) {
  const id = resolveServedActor(deps.store, subject);
  return { ...deps, actor: id.actor, subject: id.subject, identitySource: id.identitySource };
}

const BOB = 'bob@treuhand.ch';

function invite(deps, workspaceId, role, key) {
  return call(deps, 'invite_member', { workspaceId, email: BOB, role, idempotencyKey: key });
}

test('A3: a redeemed token replayed after revoke is refused, not a silent ok that seats nobody', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  const first = invite(deps, workspaceId, 'bookkeeper', 'i1');
  const redeemed = call(served(deps, BOB), 'accept_invite', { token: first.token });
  assert.equal(redeemed.ok, true);

  call(deps, 'revoke_member', { workspaceId, memberId: first.memberId });

  // Pre-fix: ok with memberId:null (a seat that no longer exists). Post-fix: the invalid-code refusal.
  const replay = call(served(deps, BOB), 'accept_invite', { token: first.token });
  assert.equal(replay.ok, false, `a spent token for a revoked seat must refuse: ${JSON.stringify(replay)}`);
  assert.equal(replay.error, 'invite_not_found');
  const me = call(served(deps, BOB), 'whoami', { workspaceId });
  assert.equal(me.isMember, false, 'the replay seated nobody');
});

test('A3: a redeemed token replayed after revoke-then-re-invite is refused while the new invite stays PENDING', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  const first = invite(deps, workspaceId, 'bookkeeper', 'i1');
  call(served(deps, BOB), 'accept_invite', { token: first.token });
  call(deps, 'revoke_member', { workspaceId, memberId: first.memberId });

  // A fresh pending invite exists for the address again (a new row).
  const again = invite(deps, workspaceId, 'viewer', 'i2');
  assert.equal(again.ok, true);

  // Pre-fix: the old token's replay found the new PENDING row and answered ok, role 'bookkeeper',
  // memberId = the pending row, seating nobody. Post-fix: refused, and the pending invite is untouched.
  const replay = call(served(deps, BOB), 'accept_invite', { token: first.token });
  assert.equal(replay.ok, false, `a spent token must not answer ok for a pending row: ${JSON.stringify(replay)}`);
  assert.equal(replay.error, 'invite_not_found');
  const pending = deps.store.db.prepare('SELECT accepted_at FROM workspace_member WHERE id = ?').get(again.memberId);
  assert.equal(pending.accepted_at, null, 'the pending re-invite is not activated by the stale replay');
  const me = call(served(deps, BOB), 'whoami', { workspaceId });
  assert.equal(me.isMember, false);
});

test('A3: a legitimate replay of an ACCEPTED token still settles to ok (idempotency preserved)', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  const first = invite(deps, workspaceId, 'viewer', 'i1');
  const redeemed = call(served(deps, BOB), 'accept_invite', { token: first.token });
  assert.equal(redeemed.ok, true);
  // The membership is currently accepted, so a replay is the first call's answer, not a refusal.
  const replay = call(served(deps, BOB), 'accept_invite', { token: first.token });
  assert.equal(replay.ok, true, `an accepted replay must stay ok: ${JSON.stringify(replay)}`);
  assert.equal(replay.memberId, redeemed.memberId);
  assert.equal(replay.role, 'viewer');
});
