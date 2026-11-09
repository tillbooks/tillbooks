/**
 * M01 critic F1, the fix: a served member of ONE mandate must NOT reach an UNPROVISIONED other
 * mandate. These are the independent critic's reproduction probes (`m01-critic-probes.test.mjs`
 * P1/P1b/P1c), FLIPPED to assert the FIXED behaviour and folded into the M01 suite so the break
 * stays closed.
 *
 * The defect the critic reproduced: `capability.ts` step 0-b denied only the served STRANGER on an
 * unprovisioned workspace; a real `member:<user_id>` from a DIFFERENT mandate is not the stranger,
 * so it fell through to the step-1 `!isProvisioned -> true` blanket grant and held FULL OWNER (read
 * AND write) on any workspace that had not yet had its first invite. That grant exists for the LOCAL
 * operator who holds the SQLite file, never for a remote proxy-authenticated served subject.
 *
 * The fix keys the unprovisioned grant off the IDENTITY SOURCE: only a LOCAL actor (identitySource
 * absent or `local_client`) gets it; a served subject (`served_subject`, stamped by both transports)
 * falls through to the A24 membership resolution, which denies a non-member of THIS workspace. So the
 * raw `capabilityFor` probe below passes `'served_subject'` explicitly: that is what the transport
 * carries for Bob, and it is the fact that must deny him.
 *
 * The author's shipped §H-TENANT test (served-identity.test.mjs) side-stepped this by PROVISIONING
 * W2 first ("so it is not ungated"); the missing assertion is the UNPROVISIONED target, which is
 * exactly where the break lived. It is asserted here.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { resolveServedActor } from '../../dist/api/session.js';
import { capabilityFor } from '../../dist/core/access/capability.js';
import { SERVED_STRANGER_ACTOR } from '../../dist/core/access/index.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';

const call = (deps, name, input) => getAction(name).run(deps, input);

/** Build the per-request deps a served request runs under, resolved exactly as the transport does. */
function served(deps, subject) {
  const id = resolveServedActor(deps.store, subject);
  return { ...deps, actor: id.actor, subject: id.subject, identitySource: id.identitySource };
}

function inviteSubject(deps, workspaceId, email, role, key) {
  const res = call(deps, 'invite_member', { workspaceId, email, role, idempotencyKey: key });
  assert.equal(res.ok, true, `invite failed: ${JSON.stringify(res)}`);
  return res.token;
}

/**
 * P1 (THE CROSS-TENANT BREAK, closed): a served member of mandate W1 is DENIED on an UNPROVISIONED
 * mandate W2, at the raw decision point AND end to end. This is the assertion US-M01.2 promises
 * ("§H-TENANT keeps every query scoped and no cross-mandate read exists") and that step 0-b's
 * comment claims ("membership is granted by invite, never by showing up authenticated").
 */
test('P1: a served member of W1 is DENIED on an UNPROVISIONED W2 (cross-tenant break closed)', () => {
  const deps = freshDeps();
  const w1 = mintWorkspace(deps, 'Mandate One', 'ws1').workspaceId;
  const w2 = mintWorkspace(deps, 'Mandate Two', 'ws2').workspaceId; // created, never provisioned

  // Bob becomes a bound member of W1 only (a bookkeeper).
  const token = inviteSubject(deps, w1, 'bob@treuhand.ch', 'bookkeeper', 'i1');
  const accepted = call(served(deps, 'bob@treuhand.ch'), 'accept_invite', { token });
  assert.equal(accepted.ok, true);

  // The REAL resolved served actor (accept_invite does not echo userId), member:<user_id>.
  const bobActor = resolveServedActor(deps.store, 'bob@treuhand.ch').actor;
  assert.ok(bobActor.startsWith('member:'), `expected a bound member actor, got ${bobActor}`);

  // The raw decision point, with the identity source the transport carries for a served request.
  const decision = capabilityFor(deps.store, w2, bobActor, 'post', 'served_subject');
  assert.equal(
    decision,
    false,
    'a served member of another mandate must NOT hold post on an unprovisioned W2',
  );

  // And end to end through the registry: whoami renders not-a-member, and a real write is refused.
  const bob = () => served(deps, 'bob@treuhand.ch');
  const w2view = call(bob(), 'whoami', { workspaceId: w2 });
  assert.equal(w2view.isMember, false, 'Bob is not a member of W2');
  assert.deepEqual([...w2view.capabilities], [], 'whoami must not advertise a bundle on W2');
  assert.equal(w2view.role, null, 'whoami must not advertise owner on a foreign unprovisioned workspace');
  assert.equal(w2view.provisioned, false, 'whoami must report the honest (unprovisioned) status');

  const write = call(bob(), 'create_account', {
    workspaceId: w2,
    number: '9999',
    name: 'Cross-tenant hack',
    type: 'revenue',
    idempotencyKey: 'x1',
  });
  assert.equal(write.ok, false, 'a served member of W1 must be refused a write into unprovisioned W2');
  assert.equal(write.error, 'permission_denied');
  // The refused write must not have landed (a fresh workspace auto-seeds a chart, so assert the
  // SPECIFIC injected number is absent rather than a zero row count).
  const injected = deps.store.db
    .prepare('SELECT 1 AS present FROM account WHERE workspace_id = ? AND number = ?')
    .get(w2, '9999');
  assert.equal(injected, undefined, 'the cross-tenant account row must not exist in W2');
});

/**
 * P1b: the same, but Bob READS W2's books (list_accounts). D50 gates reads, so a bookkeeper of one
 * client reading another client's ledger would be a revDSG separation break.
 */
test('P1b: a served member of W1 is DENIED a READ of an unprovisioned W2 ledger', () => {
  const deps = freshDeps();
  const w1 = mintWorkspace(deps, 'Mandate One', 'ws1').workspaceId;
  const w2 = mintWorkspace(deps, 'Mandate Two', 'ws2').workspaceId;
  const token = inviteSubject(deps, w1, 'bob@treuhand.ch', 'bookkeeper', 'i1');
  call(served(deps, 'bob@treuhand.ch'), 'accept_invite', { token });

  // Raw decision point on a read capability.
  const bobActor = resolveServedActor(deps.store, 'bob@treuhand.ch').actor;
  assert.equal(
    capabilityFor(deps.store, w2, bobActor, 'read_books', 'served_subject'),
    false,
    'a served member of another mandate must NOT hold read_books on an unprovisioned W2',
  );

  const cross = call(served(deps, 'bob@treuhand.ch'), 'list_accounts', { workspaceId: w2 });
  assert.equal(cross.ok, false, 'reading an unprovisioned other mandate must be refused');
  assert.equal(cross.error, 'permission_denied');
});

/**
 * P1c: a served member can MINT a workspace over the proxy and it lands unprovisioned (the P1
 * precondition is served-reachable, not only a local operator forgetting to invite). A DIFFERENT
 * member, never invited there, must NOT reach it.
 */
test('P1c: a served-minted UNPROVISIONED workspace is closed to a member never invited to it', () => {
  const deps = freshDeps();
  const w1 = mintWorkspace(deps, 'Mandate One', 'ws1').workspaceId;
  const token = inviteSubject(deps, w1, 'bob@treuhand.ch', 'bookkeeper', 'i1');
  call(served(deps, 'bob@treuhand.ch'), 'accept_invite', { token });

  // Bob (served) mints a new workspace: create_workspace is pre-workspace ungated, so it lands
  // unprovisioned. (S1: this remains ungated; F1 closes ACCESS to what it creates.)
  const minted = call(served(deps, 'bob@treuhand.ch'), 'create_workspace', { name: 'Bob Mandate', idempotencyKey: 'wsb' });
  assert.equal(minted.ok, true, 'create_workspace is ungated, a served member can mint one');

  // A DIFFERENT member (Carol, member of W1 too) must NOT reach Bob's fresh unprovisioned workspace.
  const t2 = inviteSubject(deps, w1, 'carol@treuhand.ch', 'bookkeeper', 'i2');
  call(served(deps, 'carol@treuhand.ch'), 'accept_invite', { token: t2 });
  const carolActor = resolveServedActor(deps.store, 'carol@treuhand.ch').actor;
  assert.ok(carolActor.startsWith('member:'));
  assert.equal(
    capabilityFor(deps.store, minted.workspaceId, carolActor, 'post', 'served_subject'),
    false,
    'Carol (never invited to Bob\'s workspace) must not hold post there',
  );
  const write = call(served(deps, 'carol@treuhand.ch'), 'create_account', {
    workspaceId: minted.workspaceId, number: '9998', name: 'x', type: 'revenue', idempotencyKey: 'cx',
  });
  assert.equal(write.ok, false, 'Carol must not write into a workspace she was never invited to');
  assert.equal(write.error, 'permission_denied');
});

/**
 * P2 (control / the guard that F1 showed was one case too narrow): the STRANGER is denied on an
 * unprovisioned workspace, and so now is a known served member. Both served identities are denied;
 * the only actor that keeps the unprovisioned grant is a LOCAL one.
 */
test('P2: the stranger stays denied on an unprovisioned workspace (step 0-b holds)', () => {
  const deps = freshDeps();
  const w = mintWorkspace(deps, 'Fresh', 'wsf').workspaceId;
  const stranger = served(deps, 'nobody@evil.example');
  assert.equal(stranger.actor, SERVED_STRANGER_ACTOR);
  assert.equal(capabilityFor(deps.store, w, SERVED_STRANGER_ACTOR, 'post', 'served_subject'), false);
  const write = call(stranger, 'create_account', { workspaceId: w, number: '9999', name: 'x', type: 'revenue', idempotencyKey: 's1' });
  assert.equal(write.ok, false);
  assert.equal(write.error, 'permission_denied');
});

/**
 * LOCAL PRESERVED (the fix bites in the OTHER direction too): a LOCAL actor on an unprovisioned
 * workspace STILL gets the pre-workspace blanket grant, so first-run create/restore/adopt is
 * unchanged. This is the persona-F solo owner who physically holds the SQLite file. Asserted both
 * with the identity source absent (the pre-M01 local call shape) and explicit `local_client`.
 */
test('LOCAL preserved: a local actor still gets the unprovisioned grant (first-run unchanged)', () => {
  const deps = freshDeps();
  const w = mintWorkspace(deps, 'Solo', 'wss').workspaceId; // unprovisioned

  // Absent identity source == a local call (the transports only ever stamp served_subject).
  assert.equal(capabilityFor(deps.store, w, 'studio', 'post'), true, 'local studio keeps the grant');
  assert.equal(capabilityFor(deps.store, w, 'agent', 'read_books'), true, 'local agent keeps the grant');
  // Explicit local_client is the same.
  assert.equal(capabilityFor(deps.store, w, 'studio', 'post', 'local_client'), true);

  // End to end: a local caller creates an account on the unprovisioned workspace (first-run).
  const created = call(deps, 'create_account', { workspaceId: w, number: '9990', name: 'Sales', type: 'income', idempotencyKey: 'l1' });
  assert.equal(created.ok, true, `local first-run create must still work: ${JSON.stringify(created)}`);

  // And local whoami on the unprovisioned workspace still advertises owner + the full bundle.
  const me = call(deps, 'whoami', { workspaceId: w });
  assert.equal(me.identitySource, 'local_client');
  assert.equal(me.provisioned, false);
  assert.equal(me.role, 'owner');
  assert.ok(me.capabilities.length > 0, 'local whoami keeps the open bundle on an unprovisioned workspace');
});
