/**
 * F-11 critic F1 (docs/critique/f11-served-collab-critic.md, A1): revoking a PENDING member expires
 * its live invite TOKEN, not just its row. Pre-fix the token stayed live, so a later re-invite left
 * TWO live tokens and the revoked one redeemed straight into the new membership at the OLD role. These
 * drive the SAME `action.run` the transports call, with the served identity resolved exactly as
 * `src/api/session.ts` resolves it (the `reinvite-after-expiry.test.mjs` pattern).
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

function invite(deps, workspaceId, email, role, key, extra = {}) {
  return call(deps, 'invite_member', { workspaceId, email, role, idempotencyKey: key, ...extra });
}

/** Live, un-accepted invites for an address in a workspace (what a fresh redeem could still use). */
function liveTokenCount(deps, workspaceId, email) {
  return deps.store.db
    .prepare('SELECT COUNT(*) AS n FROM invite WHERE workspace_id = ? AND email = ? AND accepted_at IS NULL AND expires_at >= ?')
    .get(workspaceId, email, deps.clock.now()).n;
}

test('A1: revoking a PENDING member kills its live token; a re-invite leaves exactly one live token and the old token cannot redeem', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);

  const first = invite(deps, workspaceId, BOB, 'owner', 'i1');
  assert.equal(first.ok, true);
  assert.equal(liveTokenCount(deps, workspaceId, BOB), 1);

  const revoked = call(deps, 'revoke_member', { workspaceId, memberId: first.memberId });
  assert.equal(revoked.ok, true, JSON.stringify(revoked));
  // The revoke expired the pending invitation: no live token survives it.
  assert.equal(liveTokenCount(deps, workspaceId, BOB), 0, 'the revoked address holds no live token');

  const again = invite(deps, workspaceId, BOB, 'viewer', 'i2');
  assert.equal(again.ok, true, JSON.stringify(again));
  assert.equal(again.replacedExpired, false, 'a revoked address is an ordinary fresh invite');
  assert.notEqual(again.token, first.token);
  // Exactly one live token after the re-invite: the fresh one, not two.
  assert.equal(liveTokenCount(deps, workspaceId, BOB), 1, 'a re-invite mints exactly one live token');

  // The revoked token is dead. Pre-fix it stayed live and, once the re-invite recreated the member
  // row, redeemed straight into the new membership at the OLD role.
  const replayOld = call(served(deps, BOB), 'accept_invite', { token: first.token });
  assert.equal(replayOld.ok, false, `the revoked token must not redeem: ${JSON.stringify(replayOld)}`);
  assert.equal(replayOld.error, 'invite_expired');

  // Only the fresh token seats, and at the NEW role.
  const redeemed = call(served(deps, BOB), 'accept_invite', { token: again.token });
  assert.equal(redeemed.ok, true, JSON.stringify(redeemed));
  const me = call(served(deps, BOB), 'whoami', { workspaceId });
  assert.equal(me.isMember, true);
  assert.equal(me.role, 'viewer');
});

test('A1: revoking an ACCEPTED member is a no-op on invites (its redeemed token is already accepted, never expired)', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  const first = invite(deps, workspaceId, BOB, 'bookkeeper', 'i1');
  const redeemed = call(served(deps, BOB), 'accept_invite', { token: first.token });
  assert.equal(redeemed.ok, true);
  const revoked = call(deps, 'revoke_member', { workspaceId, memberId: first.memberId });
  assert.equal(revoked.ok, true);
  // No un-accepted invite existed, so nothing to expire; the accepted invite row is untouched.
  const accepted = deps.store.db.prepare('SELECT accepted_at FROM invite WHERE token = ?').get(first.token);
  assert.notEqual(accepted.accepted_at, null, 'the redeemed invite stays accepted, not expired');
});
