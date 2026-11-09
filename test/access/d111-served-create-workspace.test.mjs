/**
 * D111, the served-mode create gate, and the M01 re-critic's `discard_demo_workspace` residual.
 *
 * D111 (owner-decided 18.08.2026): in served (reverse-proxy) mode `create_workspace` is DENIED to a
 * served STRANGER (a subject seated in NO workspace) and ALLOWED to a served MEMBER (a subject
 * already seated in at least one workspace). After M01 F1 a stranger can no longer ACCESS what it
 * mints, so the ungated create was a spam/DoS door, not a privilege break; this closes it while
 * keeping the Treuhänder remote new-mandate flow. LOCAL mode is the SQLite-file holder and is
 * UNAFFECTED (`identitySource` is `served_subject` only when a transport attested a proxy subject).
 *
 * The suite also pins the re-critic RESIDUAL: `discardDemoWorkspace` used to build its `manage_settings`
 * gate WITHOUT `identitySource`, so a served caller was resolved as LOCAL at that fifth enforcement
 * site and `capabilityFor`'s M01 step 1 would hand a served non-member the unprovisioned-workspace
 * grant on an unclaimed demo. Latent today (a demo is always seated at creation), asserted here on a
 * deliberately-unprovisioned demo so the seam cannot silently reopen.
 *
 * Each guard is proven to BITE: the accompanying `docs`/report record the dist mutation that reddens
 * it. Runs offline against the built engine, like every other suite.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { resolveServedActor } from '../../dist/api/session.js';
import { SERVED_STRANGER_ACTOR } from '../../dist/core/access/index.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';

const call = (deps, name, input) => getAction(name).run(deps, input);

/** The per-request deps a served request runs under, resolved exactly as the transport does. */
function served(deps, subject) {
  const id = resolveServedActor(deps.store, subject);
  return { ...deps, actor: id.actor, subject: id.subject, identitySource: id.identitySource };
}

/** Seat `subject` as a real served member of `workspaceId` (invite + served accept). */
function seatServedMember(deps, workspaceId, email, role, key) {
  const invited = call(deps, 'invite_member', { workspaceId, email, role, idempotencyKey: `${key}:inv` });
  assert.equal(invited.ok, true, `invite failed: ${JSON.stringify(invited)}`);
  const accepted = call(served(deps, email), 'accept_invite', { token: invited.token });
  assert.equal(accepted.ok, true, `accept failed: ${JSON.stringify(accepted)}`);
  const actor = resolveServedActor(deps.store, email).actor;
  assert.ok(actor.startsWith('member:'), `expected a bound member actor, got ${actor}`);
  return actor;
}

const workspaceExists = (deps, name) =>
  deps.store.db.prepare('SELECT 1 AS present FROM workspace WHERE name = ? LIMIT 1').get(name) !== undefined;

/**
 * STRANGER REFUSED: a served subject that is a member of nothing is DENIED `create_workspace`, and
 * no workspace is minted. This is the abuse vector D111 closes.
 *
 * BITE: remove the `deps.identitySource === 'served_subject' && !holdsAnyMembership(...)` guard from
 * `dist/core/setup/workspace.js` (or force it false) and this reddens: the stranger's create returns
 * ok:true and the row appears.
 */
test('D111 stranger REFUSED: a served member of nothing cannot create_workspace', () => {
  const deps = freshDeps();
  const stranger = served(deps, 'nobody@evil.example');
  assert.equal(stranger.actor, SERVED_STRANGER_ACTOR, 'the unknown subject resolves to the stranger sentinel');

  const res = call(stranger, 'create_workspace', { name: 'Spam Mandate', idempotencyKey: 'spam1' });
  assert.equal(res.ok, false, 'a served stranger must be refused create_workspace');
  assert.equal(res.error, 'permission_denied', 'the refusal is permission_denied-shaped');
  assert.equal(workspaceExists(deps, 'Spam Mandate'), false, 'no workspace may be minted for a stranger');
});

/**
 * MEMBER ALLOWED: a served subject already seated in at least one workspace MAY create another. This
 * is the D107 per-seat Treuhänder new-mandate flow, and D111 keeps it open.
 */
test('D111 member ALLOWED: a served member of one mandate may create another', () => {
  const deps = freshDeps();
  const w1 = mintWorkspace(deps, 'Mandate One', 'ws1').workspaceId;
  seatServedMember(deps, w1, 'bob@treuhand.ch', 'bookkeeper', 'bob');

  const res = call(served(deps, 'bob@treuhand.ch'), 'create_workspace', { name: 'Bob New Mandate', idempotencyKey: 'bobnew' });
  assert.equal(res.ok, true, `a served member must be allowed create_workspace: ${JSON.stringify(res)}`);
  assert.equal(typeof res.workspaceId, 'string', 'the new workspace id is returned');
  assert.equal(workspaceExists(deps, 'Bob New Mandate'), true, 'the member-created workspace exists');
});

/**
 * LOCAL UNCHANGED: the SQLite-file holder (identitySource absent, and explicit `local_client`) creates
 * exactly as before. The guard keys off `served_subject`, so first-run create is untouched.
 */
test('D111 local UNCHANGED: a local actor still creates on the first run', () => {
  const deps = freshDeps();

  // Absent identity source == a local call (transports only ever stamp served_subject).
  const first = call(deps, 'create_workspace', { name: 'Solo Books', idempotencyKey: 'solo1' });
  assert.equal(first.ok, true, `local first-run create must still work: ${JSON.stringify(first)}`);
  assert.equal(typeof first.workspaceId, 'string');

  // Explicit local_client is the same, and it is NOT gated by membership (a local operator holds no
  // membership on a brand-new install and must still create).
  const localExplicit = { ...deps, identitySource: 'local_client' };
  const second = call(localExplicit, 'create_workspace', { name: 'Solo Books Two', idempotencyKey: 'solo2' });
  assert.equal(second.ok, true, `explicit local_client create must work: ${JSON.stringify(second)}`);
  assert.equal(workspaceExists(deps, 'Solo Books Two'), true);
});

/**
 * THE RE-CRITIC RESIDUAL BITES: `discard_demo_workspace` threads `identitySource`, so a served member
 * of ANOTHER mandate is DENIED the `manage_settings` gate on an UNPROVISIONED demo it does not own,
 * and the demo survives.
 *
 * The scenario is the latent one the residual describes: a demo workspace with no members. A served
 * member (not the stranger, whose step-0-b denial does not depend on identitySource) is the only actor
 * that exercises `capabilityFor`'s M01 step 1, which is exactly the branch the omitted argument
 * bypassed.
 *
 * BITE: drop the `deps.identitySource` argument from the `capabilityPort(...)` call in
 * `dist/core/onboarding/demo.js` and this reddens: the served member's gate passes (unprovisioned +
 * treated-as-local grant), the discard runs, ok flips true and the demo is deleted.
 */
test('residual BITES: a served non-owner cannot discard an unprovisioned demo (identitySource threaded)', () => {
  const deps = freshDeps();
  const w1 = mintWorkspace(deps, 'Mandate One', 'ws1').workspaceId;
  const bobActor = seatServedMember(deps, w1, 'bob@treuhand.ch', 'bookkeeper', 'bob');

  // A DELIBERATELY UNPROVISIONED demo: minted locally, stamped demo, never seated. This is the latent
  // state the residual is about (the normal create_demo_workspace path seats its caller).
  const demo = mintWorkspace(deps, 'Latent Demo', 'wd').workspaceId;
  deps.store.db.prepare("UPDATE workspace SET kind = 'demo', is_demo = 1 WHERE id = ?").run(demo);

  const res = call(served(deps, 'bob@treuhand.ch'), 'discard_demo_workspace', {
    workspaceId: demo,
    confirmed: true,
    idempotencyKey: 'disc1',
  });
  assert.equal(res.ok, false, `a served non-member must be refused the discard gate: ${JSON.stringify(res)}`);
  assert.equal(res.error, 'permission_denied', 'the refusal is the A24 gate, permission_denied');
  assert.ok(bobActor.startsWith('member:'), 'sanity: Bob is a bound served member, not the stranger');

  const stillThere = deps.store.db.prepare('SELECT 1 AS present FROM workspace WHERE id = ?').get(demo);
  assert.notEqual(stillThere, undefined, 'the demo must NOT have been deleted by a served non-owner');
});
