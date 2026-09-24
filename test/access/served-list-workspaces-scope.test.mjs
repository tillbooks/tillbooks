/**
 * Security review, D59 critic allowlist hardening: `list_workspaces` disclosed the NAMES of
 * UNPROVISIONED workspaces to any served subject (the "no members yet => visible to any D13 actor"
 * branch is a LOCAL fact). The fix disables that branch for a served subject, so it sees ONLY
 * workspaces it is an accepted member of; a LOCAL caller (the file holder) is unchanged.
 *
 * BITE: remove the `(? = 0 AND ...)` served guard (or force `served = 0`) in
 * `dist/core/setup/workspace.js` and the stranger test reddens (the unprovisioned name reappears).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { resolveServedActor } from '../../dist/api/session.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';

const call = (deps, name, input) => getAction(name).run(deps, input);
const served = (deps, subject) => {
  const id = resolveServedActor(deps.store, subject);
  return { ...deps, actor: id.actor, subject: id.subject, identitySource: id.identitySource };
};
const names = (res) => (res.workspaces ?? []).map((w) => w.name);

function seatServedMember(deps, workspaceId, email, role, key) {
  const invited = call(deps, 'invite_member', { workspaceId, email, role, idempotencyKey: `${key}:inv` });
  assert.equal(invited.ok, true, `invite failed: ${JSON.stringify(invited)}`);
  const accepted = call(served(deps, email), 'accept_invite', { token: invited.token });
  assert.equal(accepted.ok, true, `accept failed: ${JSON.stringify(accepted)}`);
}

test('list_workspaces: a served stranger does NOT see an unprovisioned workspace`s name', () => {
  const deps = freshDeps();
  // A local create leaves the book UNPROVISIONED (no members), the transient state the branch was for.
  const w1 = mintWorkspace(deps, 'Unprovisioned GmbH', 'ws1').workspaceId;
  assert.equal(typeof w1, 'string');

  const stranger = call(served(deps, 'nobody@evil.example'), 'list_workspaces', {});
  assert.equal(stranger.ok, true, JSON.stringify(stranger));
  assert.equal(names(stranger).includes('Unprovisioned GmbH'), false, 'a served stranger must not see unprovisioned names');
});

test('list_workspaces: a served member sees ITS OWN mandate but not an unprovisioned one', () => {
  const deps = freshDeps();
  mintWorkspace(deps, 'Unprovisioned GmbH', 'ws1');
  const w2 = mintWorkspace(deps, 'Alice Mandate', 'ws2').workspaceId;
  seatServedMember(deps, w2, 'alice@client.example', 'owner', 'alice');

  const seen = call(served(deps, 'alice@client.example'), 'list_workspaces', {});
  assert.equal(seen.ok, true, JSON.stringify(seen));
  assert.equal(names(seen).includes('Alice Mandate'), true, 'the member sees its own provisioned mandate');
  assert.equal(names(seen).includes('Unprovisioned GmbH'), false, 'the member does not see an unprovisioned mandate');
});

test('list_workspaces: a LOCAL caller still sees an unprovisioned workspace (single-machine re-find)', () => {
  const deps = freshDeps();
  mintWorkspace(deps, 'Unprovisioned GmbH', 'ws1');
  const local = call(deps, 'list_workspaces', {});
  assert.equal(local.ok, true, JSON.stringify(local));
  assert.equal(names(local).includes('Unprovisioned GmbH'), true, 'the file holder must still re-find its solo book');
});
