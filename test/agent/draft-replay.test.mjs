/**
 * F-08 (c): A SAME-KEY REPLAY OF A GOVERNED WRITE AT `ask` RETURNS THE EXISTING VORSCHLAG.
 *
 * The underlying verb was always idempotent on its key; the draft in front of it was not. J3.10
 * measured the consequence: `post_vendor_bill` sent twice with one `idempotencyKey` minted TWO
 * pending proposals, the approver cleared both, and only the engine's key stopped a double posting.
 * The rule now: two identical calls, one drafted row, one approval, one posting; a replay after the
 * approval answers with the verb's own stored result; a replay after a rejection answers with the
 * rejected row, never a fresh question with the same payload.
 *
 * Driven through `callTool` (the real transport dispatch), and the ROW counts are read off the
 * store, not off the answers: a test that trusted `actionId` equality alone would pass against an
 * implementation that returned the first id and still inserted a second row.
 *
 * HOW IT BITES: remove the lookup in `enqueueDraftedAction` (the `if (idempotencyKey !== null)` block)
 * and the second call mints a second pending row with a different id, failing the first assertion of
 * the first test; the two-approvals arm then shows the second approval executing the verb's
 * idempotent no-op, which is the J3.10 state exactly.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { callTool } from '../../dist/api/mcp.js';
import { getAction } from '../../dist/api/registry.js';
import { freshDeps, mintWorkspace, manualPost } from '../api/support.mjs';

function mcp(deps, name, args) {
  return JSON.parse(callTool(deps, name, args).content[0].text);
}

function human(deps, name, input) {
  return getAction(name).run({ ...deps, actor: 'studio' }, input);
}

const drafts = (deps, workspaceId) =>
  deps.store.db
    .prepare('SELECT id, status, idempotency_key FROM agent_action WHERE workspace_id = ? ORDER BY created_at, id')
    .all(workspaceId);

const entries = (deps, workspaceId) =>
  deps.store.db.prepare('SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ?').get(workspaceId).n;

const calls = (deps, workspaceId, verb) =>
  deps.store.db
    .prepare('SELECT mode, decision_reason, agent_action_id, entity_ref FROM agent_call WHERE workspace_id = ? AND verb = ? ORDER BY at, seq')
    .all(workspaceId, verb);

test('two identical governed calls at ask: ONE drafted row, one approval, one posting', () => {
  const deps = freshDeps();
  const { workspaceId, accId } = mintWorkspace(deps);
  const args = { workspaceId, ...manualPost(accId, 'agent-post-k1', 7500) };

  const first = mcp(deps, 'post_entry', args);
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.drafted, true);
  assert.equal(first.replayed, false);

  const second = mcp(deps, 'post_entry', args);
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(second.drafted, true);
  assert.equal(second.actionId, first.actionId, 'the replay names the SAME Vorschlag');
  assert.equal(second.status, 'pending');
  assert.equal(second.replayed, true, 'and says it is a replay');

  const rows = drafts(deps, workspaceId);
  assert.equal(rows.length, 1, 'exactly one agent_action row for one key (the row count, not the ids)');
  assert.equal(rows[0].idempotency_key, 'agent-post-k1');

  // The trace holds BOTH calls (a replay is a real call) against the ONE draft.
  const traced = calls(deps, workspaceId, 'post_entry');
  assert.equal(traced.length, 2);
  assert.deepEqual(traced.map((c) => c.mode), ['draft', 'draft']);
  assert.equal(traced[1].decision_reason, 'replayed');
  assert.ok(traced.every((c) => c.agent_action_id === first.actionId));

  // One approval posts ONCE.
  assert.equal(entries(deps, workspaceId), 0);
  const approved = human(deps, 'approve_drafted_action', { workspaceId, actionId: first.actionId });
  assert.equal(approved.ok, true, JSON.stringify(approved));
  assert.equal(entries(deps, workspaceId), 1, 'one posting');
  assert.equal(drafts(deps, workspaceId).length, 1);

  // A replay AFTER the approval answers with the verb's stored result: the same entry, no new row,
  // no new posting, recorded as an execute row that points at the entry and at the draft.
  const after = mcp(deps, 'post_entry', args);
  assert.equal(after.ok, true, JSON.stringify(after));
  assert.notEqual(after.drafted, true, 'nothing to draft: the key already posted');
  assert.equal(after.entryId, approved.result.entryId, 'the verb\'s own idempotent answer');
  assert.equal(entries(deps, workspaceId), 1, 'still one posting (idempotent on ROWS)');
  assert.equal(drafts(deps, workspaceId).length, 1, 'still one draft row');
  const last = calls(deps, workspaceId, 'post_entry').at(-1);
  assert.equal(last.mode, 'execute');
  assert.equal(last.decision_reason, 'idempotent_replay');
  assert.equal(last.agent_action_id, first.actionId);
  assert.equal(last.entity_ref, approved.result.entryId);
  deps.store.close();
});

test('a replay after a REJECTION answers with the rejected row, never a fresh proposal', () => {
  const deps = freshDeps();
  const { workspaceId, accId } = mintWorkspace(deps);
  const args = { workspaceId, ...manualPost(accId, 'agent-post-k2', 4200) };
  const first = mcp(deps, 'post_entry', args);
  assert.equal(first.drafted, true);
  const rejected = human(deps, 'reject_drafted_action', { workspaceId, actionId: first.actionId });
  assert.equal(rejected.ok, true, JSON.stringify(rejected));

  const again = mcp(deps, 'post_entry', args);
  assert.equal(again.ok, true, JSON.stringify(again));
  assert.equal(again.drafted, true);
  assert.equal(again.actionId, first.actionId);
  assert.equal(again.status, 'rejected', 'the agent learns the human said no');
  assert.equal(again.replayed, true);
  assert.equal(drafts(deps, workspaceId).length, 1, 'no second proposal for a payload the human already refused');
  assert.equal(entries(deps, workspaceId), 0);
  deps.store.close();
});

test('the key is scoped: a different key, a different verb, or another tenant is a different draft', () => {
  const deps = freshDeps();
  const { workspaceId, accId } = mintWorkspace(deps);
  const other = mintWorkspace(deps, 'Other AG', 'ws-other');
  const a = mcp(deps, 'post_entry', { workspaceId, ...manualPost(accId, 'k-a', 100) });
  const b = mcp(deps, 'post_entry', { workspaceId, ...manualPost(accId, 'k-b', 100) });
  assert.notEqual(a.actionId, b.actionId, 'a different key is a different proposal');
  const c = mcp(deps, 'reverse_entry', { workspaceId, entryId: 'entry_nope', idempotencyKey: 'k-a' });
  assert.equal(c.drafted, true, JSON.stringify(c));
  assert.notEqual(c.actionId, a.actionId, 'the key is per verb: the same key on another verb is another proposal');
  // §H-TENANT: the same key in ANOTHER workspace never resolves to this one's row.
  const d = mcp(deps, 'post_entry', { workspaceId: other.workspaceId, ...manualPost(other.accId, 'k-a', 100) });
  assert.equal(d.drafted, true, JSON.stringify(d));
  assert.notEqual(d.actionId, a.actionId);
  assert.equal(drafts(deps, workspaceId).length, 3);
  assert.equal(drafts(deps, other.workspaceId).length, 1);
  deps.store.close();
});
