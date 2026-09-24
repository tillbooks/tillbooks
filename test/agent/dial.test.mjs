/**
 * A26 the dial: `decideAction`'s truth table (§8), and the `set_agent_dial` / `get_agent_dial` pair.
 *
 * The dial is the safety valve the whole capability rests on, so its policy is proven as a pure
 * function AND its persistence is proven over the real store: an unknown capability is refused, a
 * write is idempotent per key, and the boundary gate is the owner-only `manage_agent_dial`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { requiredCapabilitiesFor } from '../../dist/core/access/index.js';
import { makeContext } from '../../dist/core/context.js';
import {
  decideAction,
  dialCapabilityIsForceAsk,
  effectiveDialLevel,
  DIAL_CAPABILITIES,
  STRONG_DEFAULT_ASK_CAPABILITIES,
} from '../../dist/core/agent/index.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';

function call(deps, workspaceId, name, input) {
  return getAction(name).run(deps, { workspaceId, ...input });
}

/**
 * A dial write is a HUMAN act (critic F1): the fixture actor is the agent seat, which may never
 * write its own dial, so every grant in this suite runs as the studio seat, the D103 ceremony.
 */
function humanCall(deps, workspaceId, name, input) {
  return getAction(name).run({ ...deps, actor: 'studio' }, { workspaceId, ...input });
}

function ctxOf(deps, workspaceId) {
  return makeContext(deps.store, { workspaceId, actor: deps.actor, clock: deps.clock, ids: deps.ids });
}

test('decideAction: the execute-vs-draft truth table', () => {
  // A read is always allowed and never drafts.
  assert.equal(decideAction({ isRead: true, permitted: false, level: 'ask', forceAsk: true }).mode, 'execute');
  // A write the actor may not perform is denied before any write.
  assert.equal(decideAction({ isRead: false, permitted: false, level: 'auto', forceAsk: false }).mode, 'deny');
  // A force-ask write drafts even at auto.
  assert.equal(decideAction({ isRead: false, permitted: true, level: 'auto', forceAsk: true }).mode, 'draft');
  // A permitted write at auto executes.
  assert.equal(decideAction({ isRead: false, permitted: true, level: 'auto', forceAsk: false }).mode, 'execute');
  // A permitted write at ask drafts.
  assert.equal(decideAction({ isRead: false, permitted: true, level: 'ask', forceAsk: false }).mode, 'draft');
});

test('D103: the strong-default pair forces ask UNTIL an attributed grant, and the grant flips it', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  const ctx = ctxOf(deps, workspaceId);

  // The strong-default set is exactly the old force-ask pair.
  assert.deepEqual([...STRONG_DEFAULT_ASK_CAPABILITIES].sort(), ['plugin-install', 'vat-file']);

  // Ungranted: both force ask; an ordinary capability never does.
  assert.equal(dialCapabilityIsForceAsk(ctx, 'plugin-install'), true);
  assert.equal(dialCapabilityIsForceAsk(ctx, 'vat-file'), true);
  assert.equal(dialCapabilityIsForceAsk(ctx, 'post'), false);
  assert.equal(dialCapabilityIsForceAsk(ctx, 'send'), false);

  // The explicit, attributed, per-capability grant (D103): a HUMAN sets vat-file to auto and it
  // stops forcing ask. (The agent seat itself is refused: see the F1 regression suite.)
  const grant = humanCall(deps, workspaceId, 'set_agent_dial', { capability: 'vat-file', level: 'auto', idempotencyKey: 'g1' });
  assert.equal(grant.ok, true);
  assert.equal(dialCapabilityIsForceAsk(ctx, 'vat-file'), false);
  assert.equal(effectiveDialLevel(ctx, 'vat-file').effective, 'auto');
  // The grant is per-capability: plugin-install is untouched (no bulk act exists).
  assert.equal(dialCapabilityIsForceAsk(ctx, 'plugin-install'), true);

  // REVOCABLE: back to ask, and the force returns.
  const revoke = humanCall(deps, workspaceId, 'set_agent_dial', { capability: 'vat-file', level: 'ask', idempotencyKey: 'g2' });
  assert.equal(revoke.ok, true);
  assert.equal(dialCapabilityIsForceAsk(ctx, 'vat-file'), true);
  deps.store.close();
});

test('D103/F1 fail-closed: an UNATTRIBUTED or AGENT-ATTRIBUTED auto row resolves effective ask, on every capability', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  const ctx = ctxOf(deps, workspaceId);

  // A row no attributed act wrote (updated_by NULL): fails closed, strong-default pair.
  deps.store.db
    .prepare(
      `INSERT INTO agent_dial (workspace_id, capability, level, updated_at) VALUES (?, 'vat-file', 'auto', ?)`,
    )
    .run(workspaceId, deps.clock.now());
  const r = effectiveDialLevel(ctx, 'vat-file');
  assert.equal(r.stored, 'auto', 'the stored level is what the row says');
  assert.equal(r.effective, 'ask', 'an unsigned grant is not a grant: effective fails closed');
  assert.equal(dialCapabilityIsForceAsk(ctx, 'vat-file'), true);

  // Critic F1, resolver half: the attribution requirement holds on EVERY capability now, not only
  // the strong pair. An unattributed auto on an ORDINARY capability fails closed too...
  deps.store.db
    .prepare(`INSERT INTO agent_dial (workspace_id, capability, level, updated_at) VALUES (?, 'post', 'auto', ?)`)
    .run(workspaceId, deps.clock.now());
  const unattributed = effectiveDialLevel(ctx, 'post');
  assert.equal(unattributed.stored, 'auto');
  assert.equal(unattributed.effective, 'ask', 'a row nobody signed is not a grant, on any capability');

  // ... and a row the AGENT SEAT signed (pre-hardening data, or any path that slips) is not a
  // grant either: attributed means attributed to a non-agent actor.
  deps.store.db
    .prepare(`INSERT INTO agent_dial (workspace_id, capability, level, updated_by, updated_at) VALUES (?, 'issue', 'auto', 'agent', ?)`)
    .run(workspaceId, deps.clock.now());
  const agentSigned = effectiveDialLevel(ctx, 'issue');
  assert.equal(agentSigned.stored, 'auto');
  assert.equal(agentSigned.effective, 'ask', 'the governed seat cannot be its own grantor, even on disk');

  // A HUMAN-attributed grant is the one shape that resolves auto.
  humanCall(deps, workspaceId, 'set_agent_dial', { capability: 'send', level: 'auto', idempotencyKey: 'fc-h' });
  assert.equal(effectiveDialLevel(ctx, 'send').effective, 'auto');
  deps.store.close();
});

test('D103 structural: no verb can write more than one dial row in one call (no bulk act)', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  // The only dial writers are set_agent_dial (one capability, structurally) and the allowFuture arm
  // of approve_drafted_action (the drafted row's ONE capability). Prove the former on rows.
  humanCall(deps, workspaceId, 'set_agent_dial', { capability: 'post', level: 'auto', idempotencyKey: 'b1' });
  const rows = deps.store.db.prepare('SELECT COUNT(*) AS n FROM agent_dial WHERE workspace_id = ?').get(workspaceId);
  assert.equal(rows.n, 1, 'one grant writes one row');
  deps.store.close();
});

test('the dial verbs are gated on manage_agent_dial (owner-only)', () => {
  assert.deepEqual(requiredCapabilitiesFor('set_agent_dial', {}), ['manage_agent_dial']);
  assert.deepEqual(requiredCapabilitiesFor('approve_drafted_action', {}), ['manage_agent_dial']);
  assert.deepEqual(requiredCapabilitiesFor('reject_drafted_action', {}), ['manage_agent_dial']);
  assert.deepEqual(requiredCapabilitiesFor('get_agent_dial', {}), ['manage_agent_dial']);
});

test('set/get dial: an absent row reads as ask, a set reads back, every capability is reported', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);

  // get_agent_dial rides manage_agent_dial, which the agent seat never holds (F1 step-0): the
  // owner-facing dial read is a HUMAN read; the agent's own view of the levels is agent_trust_summary.
  const fresh = humanCall(deps, workspaceId, 'get_agent_dial', {});
  assert.equal(fresh.ok, true);
  for (const cap of DIAL_CAPABILITIES) assert.equal(fresh.levels[cap], 'ask', `${cap} defaults to ask`);

  const set = humanCall(deps, workspaceId, 'set_agent_dial', { capability: 'post', level: 'auto', idempotencyKey: 'd1' });
  assert.equal(set.ok, true);

  const after = humanCall(deps, workspaceId, 'get_agent_dial', {});
  assert.equal(after.levels.post, 'auto');
  assert.equal(after.levels.send, 'ask');
  deps.store.close();
});

test('set_agent_dial rejects an unknown capability and an invalid level, structurally', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);

  const unknown = humanCall(deps, workspaceId, 'set_agent_dial', { capability: 'nonsense', level: 'auto', idempotencyKey: 'u1' });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error, 'unknown_capability');

  const badLevel = humanCall(deps, workspaceId, 'set_agent_dial', { capability: 'post', level: 'sometimes', idempotencyKey: 'u2' });
  assert.equal(badLevel.ok, false);
  assert.equal(badLevel.error, 'invalid_input');
  deps.store.close();
});

test('set_agent_dial is idempotent per key: a replay writes exactly one row', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);

  const one = humanCall(deps, workspaceId, 'set_agent_dial', { capability: 'issue', level: 'auto', idempotencyKey: 'same' });
  const two = humanCall(deps, workspaceId, 'set_agent_dial', { capability: 'issue', level: 'auto', idempotencyKey: 'same' });
  assert.equal(one.ok, true);
  assert.deepEqual(two, one);

  const rows = deps.store.db
    .prepare("SELECT COUNT(*) AS n FROM agent_dial WHERE workspace_id = ? AND capability = 'issue'")
    .get(workspaceId);
  assert.equal(rows.n, 1);
  deps.store.close();
});
