/**
 * M01, served identity end to end at the engine boundary: the reverse-proxy subject maps onto A24's
 * dormant invite/member machinery, and every security-critic question is answered by an assertion.
 *
 * These drive the SAME `action.run` the transport calls, with the served identity resolved exactly the
 * way `src/api/served-mode.ts` + `session.ts` resolve it for a real request (`served()` below). What is
 * NOT exercised here is the HTTP trust boundary itself (missing_subject, header-ignored-in-local,
 * subject_changed): that is `test/api/served-transport.test.mjs`, over a real listener.
 *
 * The questions, each with its test:
 *  - an unknown subject is DENIED, never auto-provisioned, even on an unprovisioned workspace;
 *  - the subject maps to an EXISTING seated member; §H-TENANT holds (no cross-workspace reach);
 *  - a bearer-token invite is not redeemable by a signed-in stranger (`invite_subject_mismatch`);
 *  - revocation is effective on the NEXT request (no session state to invalidate);
 *  - no secret column exists to log or persist.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { resolveServedActor } from '../../dist/api/session.js';
import { SERVED_STRANGER_ACTOR, servedMemberActor } from '../../dist/core/access/index.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';

const call = (deps, name, input) => getAction(name).run(deps, input);

/** Build the per-request deps a served request runs under, resolved exactly as the transport does. */
function served(deps, subject) {
  const id = resolveServedActor(deps.store, subject);
  return { ...deps, actor: id.actor, subject: id.subject, identitySource: id.identitySource };
}

/** Provision a workspace (seats studio+agent as owners) and invite a subject as a role. */
function inviteSubject(deps, workspaceId, email, role, key) {
  const res = call(deps, 'invite_member', { workspaceId, email, role, idempotencyKey: key });
  assert.equal(res.ok, true, `invite failed: ${JSON.stringify(res)}`);
  return res.token;
}

test('the served subject resolves to member:<user_id> once bound, and to the stranger before', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  const token = inviteSubject(deps, workspaceId, 'bob@treuhand.ch', 'bookkeeper', 'i1');

  // Before accepting, no user row carries the subject: it resolves to the stranger.
  const before = resolveServedActor(deps.store, 'bob@treuhand.ch');
  assert.equal(before.known, false);
  assert.equal(before.actor, SERVED_STRANGER_ACTOR);

  // Bob accepts through the proxy (served deps carry his subject).
  const accepted = call(served(deps, 'bob@treuhand.ch'), 'accept_invite', { token });
  assert.equal(accepted.ok, true, `accept failed: ${JSON.stringify(accepted)}`);

  // Now the subject is a known member, and the actor equals user.actor_id (member:<user_id>).
  const after = resolveServedActor(deps.store, 'bob@treuhand.ch');
  assert.equal(after.known, true);
  assert.equal(after.actor, servedMemberActor(accepted.userId ?? readUserIdBySubject(deps, 'bob@treuhand.ch')));
  const row = deps.store.db.prepare('SELECT actor_id, subject FROM user WHERE subject = ?').get('bob@treuhand.ch');
  assert.equal(row.actor_id, after.actor, 'accept must bind actor_id = member:<user_id> so memberFor resolves it');
  assert.equal(row.subject, 'bob@treuhand.ch');
});

test('whoami carries identitySource + subject, and a served member sees its role', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);

  // A LOCAL whoami: identitySource local_client, subject null, byte-compatible plus the two fields.
  const local = call(deps, 'whoami', { workspaceId });
  assert.equal(local.identitySource, 'local_client');
  assert.equal(local.subject, null);

  const token = inviteSubject(deps, workspaceId, 'bob@treuhand.ch', 'bookkeeper', 'i1');
  call(served(deps, 'bob@treuhand.ch'), 'accept_invite', { token });

  const me = call(served(deps, 'bob@treuhand.ch'), 'whoami', { workspaceId });
  assert.equal(me.identitySource, 'served_subject');
  assert.equal(me.subject, 'bob@treuhand.ch');
  assert.equal(me.isMember, true);
  assert.equal(me.role, 'bookkeeper');
  assert.ok(me.capabilities.length > 0, 'a bookkeeper holds a non-empty bundle');
});

test('the full flow: invite -> accept -> bounded by role -> revoke -> not a member on the NEXT call', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  const token = inviteSubject(deps, workspaceId, 'bob@treuhand.ch', 'bookkeeper', 'i1');
  const accepted = call(served(deps, 'bob@treuhand.ch'), 'accept_invite', { token });

  const bob = () => served(deps, 'bob@treuhand.ch');

  // A24 keeps owning authorization: a bookkeeper holds read_books (can list the accounts)...
  const allowed = call(bob(), 'list_accounts', { workspaceId });
  assert.equal(allowed.ok, true, `bookkeeper should hold read_books: ${JSON.stringify(allowed)}`);
  // ...but NOT manage_members (owner only): M01 adds authentication, A24 keeps owning authorization.
  const denied = call(bob(), 'invite_member', { workspaceId, email: 'x@y.ch', role: 'viewer', idempotencyKey: 'i2' });
  assert.equal(denied.ok, false);
  assert.equal(denied.error, 'permission_denied');
  assert.equal(denied.role, 'bookkeeper');

  // The owner revokes Bob. There is no TILL-side session to invalidate.
  const revoke = call(deps, 'revoke_member', { workspaceId, memberId: accepted.memberId });
  assert.equal(revoke.ok, true);

  // Bob's NEXT request resolves to no active membership: revocation latency is one request.
  const after = call(bob(), 'whoami', { workspaceId });
  assert.equal(after.isMember, false);
  assert.deepEqual([...after.capabilities], []);
  const nowDenied = call(bob(), 'list_accounts', { workspaceId });
  assert.equal(nowDenied.ok, false);
  assert.equal(nowDenied.error, 'permission_denied');
  assert.equal(nowDenied.role, null, 'a revoked member holds no role at all');
});

test('invite_subject_mismatch: a signed-in stranger cannot redeem a token meant for someone else', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  const token = inviteSubject(deps, workspaceId, 'bob@treuhand.ch', 'bookkeeper', 'i1');

  // Alice holds Bob's token but the proxy attests her as alice@treuhand.ch.
  const refused = call(served(deps, 'alice@treuhand.ch'), 'accept_invite', { token });
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'invite_subject_mismatch');
  // The invite stays pending and redeemable by the person it was meant for.
  const ok = call(served(deps, 'bob@treuhand.ch'), 'accept_invite', { token });
  assert.equal(ok.ok, true);
});

test('the served stranger holds NOTHING, even on an UNPROVISIONED workspace (no auto-provisioning)', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps); // unprovisioned: no member rows yet

  // A local caller on an unprovisioned workspace is granted everything (the persona-F solo case)...
  const localOwner = call(deps, 'whoami', { workspaceId });
  assert.equal(localOwner.provisioned, false);
  assert.ok(localOwner.capabilities.length > 0);

  // ...but a served STRANGER walking up through the proxy is not: it is denied even here, so no
  // unknown subject is ever auto-provisioned into a privileged seat.
  const stranger = served(deps, 'nobody@evil.example');
  assert.equal(stranger.actor, SERVED_STRANGER_ACTOR);
  const me = call(stranger, 'whoami', { workspaceId });
  assert.equal(me.isMember, false);
  assert.equal(me.identitySource, 'served_subject');
  assert.equal(me.subject, 'nobody@evil.example');
  assert.deepEqual([...me.capabilities], [], 'whoami must not advertise a bundle the engine will refuse');
  const write = call(stranger, 'create_account', { workspaceId, number: '9999', name: 'Hack', type: 'revenue', idempotencyKey: 'a1' });
  assert.equal(write.ok, false);
  assert.equal(write.error, 'permission_denied');
});

test('§H-TENANT: a subject bound to one mandate cannot reach another mandate’s books', () => {
  const deps = freshDeps();
  const w1 = mintWorkspace(deps, 'Mandate One', 'ws1').workspaceId;
  const w2 = mintWorkspace(deps, 'Mandate Two', 'ws2').workspaceId;

  const token = inviteSubject(deps, w1, 'bob@treuhand.ch', 'bookkeeper', 'i1');
  call(served(deps, 'bob@treuhand.ch'), 'accept_invite', { token });
  // Provision W2 with a different owner so it is not ungated (agent seated on invite).
  inviteSubject(deps, w2, 'carol@treuhand.ch', 'bookkeeper', 'i2');

  // Bob is a member of W1...
  assert.equal(call(served(deps, 'bob@treuhand.ch'), 'whoami', { workspaceId: w1 }).isMember, true);
  // ...and a total non-member of W2: one subject is one user, per-workspace membership diverges.
  const w2view = call(served(deps, 'bob@treuhand.ch'), 'whoami', { workspaceId: w2 });
  assert.equal(w2view.isMember, false);
  const cross = call(served(deps, 'bob@treuhand.ch'), 'list_accounts', { workspaceId: w2 });
  assert.equal(cross.ok, false);
  assert.equal(cross.error, 'permission_denied');
});

test('no secret is stored: the user table has no password, token, or session column', () => {
  const deps = freshDeps();
  mintWorkspace(deps);
  const cols = deps.store.db.prepare('PRAGMA table_info(user)').all().map((c) => c.name);
  for (const forbidden of ['password', 'password_hash', 'token', 'secret', 'session', 'credential']) {
    assert.ok(!cols.includes(forbidden), `user.${forbidden} must never exist (M01 §3 non-goal)`);
  }
  // The only identity columns are the D13 actor and the M01 subject.
  assert.ok(cols.includes('actor_id'));
  assert.ok(cols.includes('subject'));
});

/** The user id a subject is bound to, for the actor-string assertion above. */
function readUserIdBySubject(deps, subject) {
  return deps.store.db.prepare('SELECT id FROM user WHERE subject = ?').get(subject).id;
}
