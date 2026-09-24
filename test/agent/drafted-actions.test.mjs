/**
 * A26 the inbox, and the money-path invariants A26 must hold because approving a drafted action POSTS.
 *
 * The gate already holds every verb in `ACTIONS` to idempotent-on-rows, append-only and §H-TENANT
 * (conformance rules 8, 10-12). These assertions are the BUSINESS-RULE half A26 owns: that a drafted
 * action is inert until approved (dial-gating), that approving a drafted `post_entry` twice posts
 * exactly ONCE (idempotent on ROWS, not merely on the returned value), that the posted entry is
 * append-only, that the agent can never self-approve, and that an action never crosses a tenant.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { makeContext } from '../../dist/core/context.js';
import { approveDraftedAction } from '../../dist/core/agent/index.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';

/** The human decider (critic F1): approve/reject ride manage_agent_dial, which the agent never holds. */
function humanCall(deps, workspaceId, name, input) {
  return getAction(name).run({ ...deps, actor: 'studio' }, { workspaceId, ...input });
}

function call(deps, workspaceId, name, input) {
  return getAction(name).run(deps, { workspaceId, ...input });
}

/** Seed a PENDING agent_action row (the dial does this from the write dispatch at integration). */
function seedDraft(deps, workspaceId, { id, actor = 'till-agent', actionTool, payload }) {
  deps.store.db
    .prepare(
      `INSERT INTO agent_action
         (id, workspace_id, actor, dial_capability, action_tool, payload_json, status, idempotency_key, created_at)
       VALUES (?, ?, ?, NULL, ?, ?, 'pending', ?, ?)`,
    )
    .run(id, workspaceId, actor, actionTool, JSON.stringify(payload), payload.idempotencyKey ?? null, deps.clock.now());
  return id;
}

function draftedPost(deps, workspaceId, accId, { id, key }) {
  return seedDraft(deps, workspaceId, {
    id,
    actionTool: 'post_entry',
    payload: {
      workspaceId,
      date: '2026-05-01',
      description: 'Agent-drafted posting',
      source: 'agent',
      idempotencyKey: key,
      lines: [
        { account: accId('6500'), debit: 5000 },
        { account: accId('1000'), credit: 5000 },
      ],
    },
  });
}

test('a drafted action is inert until approved (dial-gating): nothing posts on its own', () => {
  const deps = freshDeps();
  const { workspaceId, accId } = mintWorkspace(deps);
  draftedPost(deps, workspaceId, accId, { id: 'd-inert', key: 'inert' });

  const posted = deps.store.db
    .prepare("SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ? AND status = 'posted'")
    .get(workspaceId);
  assert.equal(posted.n, 0, 'a pending drafted action must not post anything');
  deps.store.close();
});

test('approving a drafted post_entry TWICE posts exactly ONE entry and TWO lines (idempotent on rows)', () => {
  const deps = freshDeps();
  const { workspaceId, accId } = mintWorkspace(deps);
  const id = draftedPost(deps, workspaceId, accId, { id: 'd-post', key: 'agent-post-1' });

  const one = humanCall(deps, workspaceId, 'approve_drafted_action', { actionId: id });
  const two = humanCall(deps, workspaceId, 'approve_drafted_action', { actionId: id });
  assert.equal(one.ok, true, JSON.stringify(one));
  assert.equal(two.ok, true, JSON.stringify(two));

  const entries = deps.store.db
    .prepare("SELECT id FROM journal_entry WHERE workspace_id = ? AND status = 'posted'")
    .all(workspaceId);
  assert.equal(entries.length, 1, 'a double-approve must not double-post');
  const lines = deps.store.db.prepare('SELECT * FROM journal_line WHERE entry_id = ?').all(entries[0].id);
  assert.equal(lines.length, 2, 'the replay must not append lines');
  const debit = lines.reduce((s, l) => s + l.debit_minor, 0);
  const credit = lines.reduce((s, l) => s + l.credit_minor, 0);
  assert.equal(debit, 5000);
  assert.equal(credit, debit, 'the entry must balance');

  const row = deps.store.db.prepare('SELECT status FROM agent_action WHERE id = ?').get(id);
  assert.equal(row.status, 'executed');
  deps.store.close();
});

test('the entry an approved action posts is append-only (the immutability trigger aborts an update)', () => {
  const deps = freshDeps();
  const { workspaceId, accId } = mintWorkspace(deps);
  const id = draftedPost(deps, workspaceId, accId, { id: 'd-immut', key: 'immut-1' });
  assert.equal(humanCall(deps, workspaceId, 'approve_drafted_action', { actionId: id }).ok, true);

  const entry = deps.store.db
    .prepare("SELECT id FROM journal_entry WHERE workspace_id = ? AND status = 'posted'")
    .get(workspaceId);
  assert.throws(
    () => deps.store.db.prepare("UPDATE journal_entry SET description = 'tampered' WHERE id = ?").run(entry.id),
    /posted_immutable/,
  );
  deps.store.close();
});

test('the agent can never self-approve: drafting actor == approving actor is refused', () => {
  const deps = freshDeps(); // deps.actor is 'agent'
  const { workspaceId, accId } = mintWorkspace(deps);
  // Seed with the SAME actor as the approver.
  seedDraft(deps, workspaceId, {
    id: 'd-self',
    actor: 'agent',
    actionTool: 'post_entry',
    payload: {
      workspaceId,
      date: '2026-05-01',
      source: 'agent',
      idempotencyKey: 'self-1',
      lines: [
        { account: accId('6500'), debit: 5000 },
        { account: accId('1000'), credit: 5000 },
      ],
    },
  });
  // Post-F1 the ban is LAYERED: the A24 boundary denies the agent seat `manage_agent_dial` before
  // the verb's own actor rule can even run, so the boundary answer is `permission_denied`; the
  // engine-level `cannot_self_approve` still stands behind it for a context that bypasses A24.
  const res = call(deps, workspaceId, 'approve_drafted_action', { actionId: 'd-self' });
  assert.equal(res.ok, false);
  assert.ok(res.error === 'permission_denied' || res.error === 'cannot_self_approve', res.error);

  // The engine half, bitten directly (the A24 port is not in this context), so BOTH layers are real.
  const engineRes = approveDraftedAction(
    makeContext(deps.store, { workspaceId, actor: 'agent', clock: deps.clock, ids: deps.ids }),
    () => { throw new Error('the invoker must not be reached on a refused self-approve'); },
    { actionId: 'd-self' },
  );
  assert.equal(engineRes.ok, false);
  assert.equal(engineRes.error, 'cannot_self_approve');

  const posted = deps.store.db
    .prepare("SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ? AND status = 'posted'")
    .get(workspaceId);
  assert.equal(posted.n, 0, 'a refused self-approve must not post');
  deps.store.close();
});

test('reject drops a drafted action, is idempotent, and refuses an executed one', () => {
  const deps = freshDeps();
  const { workspaceId, accId } = mintWorkspace(deps);
  const id = draftedPost(deps, workspaceId, accId, { id: 'd-reject', key: 'rej-1' });

  const one = humanCall(deps, workspaceId, 'reject_drafted_action', { actionId: id });
  const two = humanCall(deps, workspaceId, 'reject_drafted_action', { actionId: id });
  assert.equal(one.ok, true);
  assert.equal(two.ok, true, 'a second reject settles to the same answer');
  assert.equal(deps.store.db.prepare('SELECT status FROM agent_action WHERE id = ?').get(id).status, 'rejected');

  // A rejected action can never be approved.
  const approve = humanCall(deps, workspaceId, 'approve_drafted_action', { actionId: id });
  assert.equal(approve.ok, false);
  assert.equal(approve.error, 'already_rejected');
  deps.store.close();
});

test('§H-TENANT: a drafted action never crosses a workspace boundary', () => {
  const deps = freshDeps();
  const a = getAction('create_workspace').run(deps, { name: 'A GmbH', idempotencyKey: 'wa' }).workspaceId;
  const b = getAction('create_workspace').run(deps, { name: 'B GmbH', idempotencyKey: 'wb' }).workspaceId;
  const accId = (n) =>
    deps.store.db.prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?').get(a, n).id;
  draftedPost(deps, a, accId, { id: 'd-tenant', key: 'ten-1' });

  // Approving from workspace B must not find A's action (the decider is human, per F1).
  const res = getAction('approve_drafted_action').run({ ...deps, actor: 'studio' }, { workspaceId: b, actionId: 'd-tenant' });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'not_found');
  deps.store.close();
});
