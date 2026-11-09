/**
 * F-11 critic F2 (docs/critique/f11-served-collab-critic.md, A2): the served subject is matched
 * case-insensitively at RESOLVE (`resolveServedActor`), agreeing with the case-insensitive ACCEPT.
 * Pre-fix a member attested `Bob@Treuhand.ch` became a stranger the moment the IdP sent
 * `bob@treuhand.ch`, locking whichever casing was stored last out of every mandate at once.
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

test('A2: a subject attested mixed-case at accept resolves when the IdP later sends it lowercase', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  const first = call(deps, 'invite_member', { workspaceId, email: BOB, role: 'viewer', idempotencyKey: 'i1' });
  assert.equal(first.ok, true);

  // Accept attested with the IdP's original casing; the row stores that casing verbatim (for display).
  const accept = call(served(deps, 'Bob@Treuhand.ch'), 'accept_invite', { token: first.token });
  assert.equal(accept.ok, true, JSON.stringify(accept));
  const stored = deps.store.db.prepare('SELECT subject FROM user WHERE email = ?').get(BOB);
  assert.equal(stored.subject, 'Bob@Treuhand.ch', 'the attested casing is stored for display');

  // The next request arrives lowercased: pre-fix it resolved to a stranger, locking the member out.
  const lower = resolveServedActor(deps.store, 'bob@treuhand.ch');
  assert.equal(lower.known, true, 'the lowercase subject resolves to the member');
  assert.match(lower.actor, /^member:/, 'a known subject resolves to its member actor, not the stranger seat');
  const meLower = call(served(deps, 'bob@treuhand.ch'), 'whoami', { workspaceId });
  assert.equal(meLower.isMember, true);
  assert.equal(meLower.role, 'viewer');

  // And the exact stored casing still resolves too: both are the one identity.
  const mixed = resolveServedActor(deps.store, 'Bob@Treuhand.ch');
  assert.equal(mixed.known, true);
  assert.equal(mixed.actor, lower.actor, 'both casings resolve to the same member actor');
});
