/**
 * F-11 / J8.8 (friction ledger, Phase 2c): re-inviting an address whose invite EXPIRED replaces the
 * expired pending row instead of refusing `already_member`, and nothing else about the membership
 * boundary moves: an accepted member stays `already_member`, a pending member with a LIVE invite stays
 * `already_member` (no second token beside a live one), the old expired token still refuses, a served
 * stranger holds nothing until the fresh token is redeemed, and a revoked member fails on the very
 * next request. These drive the SAME `action.run` the transports call, with the served identity
 * resolved exactly as `src/api/session.ts` resolves it (the `served-identity.test.mjs` pattern).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { resolveServedActor } from '../../dist/api/session.js';
import { SERVED_STRANGER_ACTOR } from '../../dist/core/access/index.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';

const call = (deps, name, input) => getAction(name).run(deps, input);

function served(deps, subject) {
  const id = resolveServedActor(deps.store, subject);
  return { ...deps, actor: id.actor, subject: id.subject, identitySource: id.identitySource };
}

const BOB = 'bob@treuhand.ch';

function invite(deps, workspaceId, email, role, key, extra = {}) {
  return call(deps, 'invite_member', { workspaceId, email, role, idempotencyKey: key, ...extra });
}

/** Push every un-accepted invite for the address into the past, the way a month does. */
function expireInvites(deps, workspaceId, email) {
  deps.store.db
    .prepare("UPDATE invite SET expires_at = '2020-01-01T00:00:00.000Z' WHERE workspace_id = ? AND email = ? AND accepted_at IS NULL")
    .run(workspaceId, email);
}

test('a pending member with a LIVE invite is still already_member: no second token beside a live one', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  const first = invite(deps, workspaceId, BOB, 'viewer', 'i1');
  assert.equal(first.ok, true);
  assert.equal(first.replacedExpired, false);
  const again = invite(deps, workspaceId, BOB, 'viewer', 'i2');
  assert.equal(again.ok, false);
  assert.equal(again.error, 'already_member');
  assert.equal(again.memberId, first.memberId);
  const tokens = deps.store.db.prepare('SELECT COUNT(*) AS n FROM invite WHERE workspace_id = ? AND email = ?').get(workspaceId, BOB);
  assert.equal(tokens.n, 1, 'no second token was minted');
});

test('an EXPIRED pending invite is replaced in place: same member id, fresh token, the new role, and the old token still refuses', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  const first = invite(deps, workspaceId, BOB, 'viewer', 'i1');
  assert.equal(first.ok, true);
  expireInvites(deps, workspaceId, BOB);

  // The invitee's side is a dead end without the rule: the old token is expired.
  const stale = call(served(deps, BOB), 'accept_invite', { token: first.token });
  assert.equal(stale.ok, false);
  assert.equal(stale.error, 'invite_expired');

  // The owner's side: the re-invite replaces the expired row rather than refusing already_member.
  const again = invite(deps, workspaceId, BOB, 'bookkeeper', 'i2');
  assert.equal(again.ok, true, `re-invite refused: ${JSON.stringify(again)}`);
  assert.equal(again.replacedExpired, true);
  assert.equal(again.memberId, first.memberId, 'the same pending row is re-armed, no duplicate member');
  assert.notEqual(again.token, first.token, 'a fresh token');
  assert.equal(again.role, 'bookkeeper');

  const row = deps.store.db.prepare('SELECT role, accepted_at FROM workspace_member WHERE id = ?').get(again.memberId);
  assert.equal(row.role, 'bookkeeper');
  assert.equal(row.accepted_at, null);
  const rows = deps.store.db.prepare('SELECT COUNT(*) AS n FROM workspace_member WHERE workspace_id = ? AND user_id = ?').get(workspaceId, again.userId);
  assert.equal(rows.n, 1, 'exactly one membership row for the address');

  // The old token stays dead; only the fresh one redeems.
  const staleAgain = call(served(deps, BOB), 'accept_invite', { token: first.token });
  assert.equal(staleAgain.ok, false);
  assert.equal(staleAgain.error, 'invite_expired');
  const redeemed = call(served(deps, BOB), 'accept_invite', { token: again.token });
  assert.equal(redeemed.ok, true, `redeem failed: ${JSON.stringify(redeemed)}`);
  const me = call(served(deps, BOB), 'whoami', { workspaceId });
  assert.equal(me.isMember, true);
  assert.equal(me.role, 'bookkeeper');
  assert.equal(me.identitySource, 'served_subject');
});

test('a served stranger stays a stranger until the fresh token is redeemed: whoami holds nothing, a read is refused', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  const first = invite(deps, workspaceId, BOB, 'viewer', 'i1');
  expireInvites(deps, workspaceId, BOB);
  invite(deps, workspaceId, BOB, 'viewer', 'i2');

  // The re-invite bound nothing: the subject still resolves to the stranger seat.
  const id = resolveServedActor(deps.store, BOB);
  assert.equal(id.known, false);
  assert.equal(id.actor, SERVED_STRANGER_ACTOR);
  const me = call(served(deps, BOB), 'whoami', { workspaceId });
  assert.equal(me.ok, true);
  assert.equal(me.isMember, false);
  assert.equal(me.role, null);
  assert.deepEqual(me.capabilities, []);
  const read = call(served(deps, BOB), 'list_members', { workspaceId });
  assert.equal(read.ok, false);
  assert.equal(read.error, 'permission_denied');
  assert.equal(first.ok, true);
});

test('an ACCEPTED member re-invited is still already_member, expired invites or not', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  const first = invite(deps, workspaceId, BOB, 'viewer', 'i1');
  const redeemed = call(served(deps, BOB), 'accept_invite', { token: first.token });
  assert.equal(redeemed.ok, true);
  expireInvites(deps, workspaceId, BOB); // no-op on an accepted row, and the guard must not care
  const again = invite(deps, workspaceId, BOB, 'owner', 'i2');
  assert.equal(again.ok, false);
  assert.equal(again.error, 'already_member');
  const me = call(served(deps, BOB), 'whoami', { workspaceId });
  assert.equal(me.role, 'viewer', 'a refused re-invite changes nothing about the seated role');
});

test('the re-invite is idempotent on its key: a replay returns the same token and writes no second row', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  const first = invite(deps, workspaceId, BOB, 'viewer', 'i1');
  expireInvites(deps, workspaceId, BOB);
  const again = invite(deps, workspaceId, BOB, 'viewer', 'i2');
  const replay = invite(deps, workspaceId, BOB, 'viewer', 'i2');
  assert.deepEqual(replay, again);
  const tokens = deps.store.db.prepare('SELECT COUNT(*) AS n FROM invite WHERE workspace_id = ? AND email = ?').get(workspaceId, BOB);
  assert.equal(tokens.n, 2, 'the expired token and the fresh one, nothing from the replay');
  assert.equal(first.ok, true);
});

test('a revoked member fails on the very next request, and re-inviting them afterwards mints a new pending row', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  const first = invite(deps, workspaceId, BOB, 'bookkeeper', 'i1');
  call(served(deps, BOB), 'accept_invite', { token: first.token });
  const before = call(served(deps, BOB), 'list_accounts', { workspaceId });
  assert.equal(before.ok, true, 'a seated bookkeeper reads the roster');

  const revoked = call(deps, 'revoke_member', { workspaceId, memberId: first.memberId });
  assert.equal(revoked.ok, true, JSON.stringify(revoked));
  // The NEXT request resolves per request from the current membership: nothing to wait out.
  const after = call(served(deps, BOB), 'whoami', { workspaceId });
  assert.equal(after.isMember, false);
  assert.equal(after.role, null);
  const denied = call(served(deps, BOB), 'list_accounts', { workspaceId });
  assert.equal(denied.ok, false);
  assert.equal(denied.error, 'permission_denied');
  const write = call(served(deps, BOB), 'set_role', { workspaceId, memberId: first.memberId, role: 'owner' });
  assert.equal(write.ok, false);
  assert.equal(write.error, 'permission_denied');

  // A later re-invite of the revoked address is an ordinary fresh invite (a new pending row).
  const again = invite(deps, workspaceId, BOB, 'viewer', 'i2');
  assert.equal(again.ok, true, JSON.stringify(again));
  assert.equal(again.replacedExpired, false);
  assert.notEqual(again.memberId, first.memberId);
});

test('the kind travels with the identity across the re-invite: an agent address re-invited without a kind stays an agent', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  const first = invite(deps, workspaceId, 'bot@seeblick.example', 'agent', 'i1', { kind: 'agent' });
  assert.equal(first.kind, 'agent');
  expireInvites(deps, workspaceId, 'bot@seeblick.example');
  const again = invite(deps, workspaceId, 'bot@seeblick.example', 'agent', 'i2');
  assert.equal(again.ok, true);
  assert.equal(again.kind, 'agent');
  const asPerson = invite(deps, workspaceId, 'bot@seeblick.example', 'agent', 'i3', { kind: 'human' });
  assert.equal(asPerson.ok, false);
  assert.equal(asPerson.error, 'already_member', 'a live fresh invite exists, so the identity question is never reached');
});

test('§H-TENANT: the re-invite is scoped to ONE mandate: a LIVE W2 seat, a revoked address and a stranger in W2 are all untouched', () => {
  const deps = freshDeps();
  const w1 = mintWorkspace(deps, 'Mandate One', 'ws1').workspaceId;
  const w2 = mintWorkspace(deps, 'Mandate Two', 'ws2').workspaceId;

  // Bob is ONE identity across both mandates. In W2 he holds a LIVE, ACCEPTED bookkeeper seat.
  // This is the hard bite: if the re-invite's `already`/UPDATE lookup were not scoped to the
  // context workspace, re-inviting Bob in W1 would either mutate this W2 seat's role or read it as
  // `already_member` and refuse the W1 re-invite. It must do neither.
  const w2Bob = invite(deps, w2, BOB, 'bookkeeper', 'w2-i1');
  assert.equal(w2Bob.ok, true);
  assert.equal(call(served(deps, BOB), 'accept_invite', { token: w2Bob.token }).ok, true);

  // Carol is invited, accepted, then REVOKED in W2 (revoke deletes the seat): a former member.
  const w2Carol = invite(deps, w2, 'carol@treuhand.ch', 'viewer', 'w2-c1');
  assert.equal(call(served(deps, 'carol@treuhand.ch'), 'accept_invite', { token: w2Carol.token }).ok, true);
  assert.equal(call(deps, 'revoke_member', { workspaceId: w2, memberId: w2Carol.memberId }).ok, true);

  // In W1 Bob's invite goes stale, the dead end the rule exists for.
  const w1First = invite(deps, w1, BOB, 'viewer', 'w1-i1');
  assert.equal(w1First.ok, true);
  expireInvites(deps, w1, BOB);

  // Snapshots of everything in W2 the W1 re-invite must not reach.
  const w2SeatBefore = deps.store.db
    .prepare('SELECT id, role, accepted_at FROM workspace_member WHERE id = ?')
    .get(w2Bob.memberId);
  assert.notEqual(w2SeatBefore, undefined);
  assert.equal(w2SeatBefore.accepted_at !== null, true, 'the W2 seat is genuinely accepted, so the bite is real');
  const w2InvitesBefore = deps.store.db
    .prepare('SELECT COUNT(*) AS n FROM invite WHERE workspace_id = ?')
    .get(w2).n;

  // The re-invite re-arms the EXPIRED W1 row only, with the new role.
  const w1Again = invite(deps, w1, BOB, 'bookkeeper', 'w1-i2');
  assert.equal(w1Again.ok, true, `re-invite in W1 refused, tenant scope leaked: ${JSON.stringify(w1Again)}`);
  assert.equal(w1Again.replacedExpired, true);
  assert.equal(w1Again.memberId, w1First.memberId, 'same W1 pending row re-armed');
  assert.notEqual(w1Again.memberId, w2Bob.memberId, 'never the W2 seat');
  assert.notEqual(w1Again.token, w1First.token, 'a fresh token');

  // W2 did not move: the live seat is byte-for-byte the same, no invite minted there.
  const w2SeatAfter = deps.store.db
    .prepare('SELECT id, role, accepted_at FROM workspace_member WHERE id = ?')
    .get(w2Bob.memberId);
  assert.deepEqual(w2SeatAfter, w2SeatBefore, 'the LIVE W2 seat is untouched by the W1 re-invite');
  const w2InvitesAfter = deps.store.db
    .prepare('SELECT COUNT(*) AS n FROM invite WHERE workspace_id = ?')
    .get(w2).n;
  assert.equal(w2InvitesAfter, w2InvitesBefore, 'the W1 re-invite minted no invite in W2');

  // The fresh W1 token is scoped to W1: redeeming it seats Bob in W1 and changes nothing in W2.
  assert.equal(call(served(deps, BOB), 'accept_invite', { token: w1Again.token }).ok, true);
  const w1Me = call(served(deps, BOB), 'whoami', { workspaceId: w1 });
  assert.equal(w1Me.isMember, true);
  assert.equal(w1Me.role, 'bookkeeper');
  const w2Me = call(served(deps, BOB), 'whoami', { workspaceId: w2 });
  assert.equal(w2Me.isMember, true);
  assert.equal(w2Me.role, 'bookkeeper', 'the W1 re-invite/redeem did not touch the W2 role');

  // The revoked address in W2 stayed revoked; a pure stranger holds nothing.
  const carolW2 = call(served(deps, 'carol@treuhand.ch'), 'whoami', { workspaceId: w2 });
  assert.equal(carolW2.isMember, false, 'a revoked W2 member was not resurrected by a W1 re-invite');
  assert.equal(call(served(deps, 'carol@treuhand.ch'), 'list_accounts', { workspaceId: w2 }).error, 'permission_denied');
  const stranger = call(served(deps, 'dave@fremd.ch'), 'whoami', { workspaceId: w2 });
  assert.equal(stranger.isMember, false);
  assert.deepEqual(stranger.capabilities, []);
});
