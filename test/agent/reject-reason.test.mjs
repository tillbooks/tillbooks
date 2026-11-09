/**
 * F-08 / J5.6 "No, and tell it why": `reject_drafted_action` carries an optional `reason`, and the
 * reason reaches every place the next session or the human looks: the rejected row in the queue read,
 * the replay answer for the same key, and the trace beside the drafting call (with the resolver and
 * the moment, the backlink the approve path already wrote).
 *
 * Driven through the real transport dispatch for the agent's calls and through the registry for the
 * human's decision, exactly the split the Studio makes. HOW IT BITES: drop the `reject_reason = ?`
 * from the UPDATE and every reason assertion fails; drop the LEFT JOIN in `getAgentSession` and the
 * trace assertion fails; drop `backfillDraftingCall` from the reject path and the resolver assertion
 * fails.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { callTool } from '../../dist/api/mcp.js';
import { getAction } from '../../dist/api/registry.js';
import { REJECT_REASON_MAX_LENGTH } from '../../dist/core/agent/index.js';
import { freshDeps, mintWorkspace, manualPost } from '../api/support.mjs';

const mcp = (deps, name, args) => JSON.parse(callTool(deps, name, args).content[0].text);
const human = (deps, name, input) => getAction(name).run({ ...deps, actor: 'studio' }, input);

test('reject with a reason: stored, listed, replayed with the same words, and visible in the trace', () => {
  const deps = freshDeps();
  const { workspaceId, accId } = mintWorkspace(deps);
  const drafted = mcp(deps, 'post_entry', { workspaceId, ...manualPost(accId, 'wrong-vendor', 3300) });
  assert.equal(drafted.drafted, true, JSON.stringify(drafted));

  const rejected = human(deps, 'reject_drafted_action', { workspaceId, actionId: drafted.actionId, reason: '  Falscher Lieferant  ' });
  assert.equal(rejected.ok, true, JSON.stringify(rejected));
  assert.equal(rejected.status, 'rejected');
  assert.equal(rejected.reason, 'Falscher Lieferant', 'trimmed, and echoed back');

  // The row.
  const row = deps.store.db.prepare('SELECT status, reject_reason, resolved_by FROM agent_action WHERE id = ?').get(drafted.actionId);
  assert.equal(row.status, 'rejected');
  assert.equal(row.reject_reason, 'Falscher Lieferant');
  assert.equal(row.resolved_by, 'studio');

  // The queue read: the rejected list carries the reason.
  const listed = human(deps, 'list_drafted_actions', { workspaceId, status: 'rejected' });
  assert.equal(listed.ok, true);
  assert.equal(listed.actions.length, 1);
  assert.equal(listed.actions[0].rejectReason, 'Falscher Lieferant');
  const pending = human(deps, 'list_drafted_actions', { workspaceId });
  assert.equal(pending.actions.length, 0, 'nothing pending: the reject settled the queue');

  // A second reject (idempotent) keeps the FIRST reason: a replay never rewrites why.
  const again = human(deps, 'reject_drafted_action', { workspaceId, actionId: drafted.actionId, reason: 'anders' });
  assert.equal(again.ok, true);
  assert.equal(again.reason, 'Falscher Lieferant');

  // The agent's same-key replay learns the rejection AND the reason (F-08 c meets J5.6).
  const replay = mcp(deps, 'post_entry', { workspaceId, ...manualPost(accId, 'wrong-vendor', 3300) });
  assert.equal(replay.drafted, true);
  assert.equal(replay.status, 'rejected');
  assert.equal(replay.actionId, drafted.actionId);

  // The trace: the drafting call shows where the draft went, the reason, and who resolved it.
  const sessions = mcp(deps, 'list_agent_sessions', { workspaceId });
  const detail = mcp(deps, 'get_agent_session', { workspaceId, sessionId: sessions.sessions[0].sessionId });
  assert.equal(detail.ok, true, JSON.stringify(detail));
  const calls = detail.turns.flatMap((t) => t.calls);
  const drafting = calls.find((c) => c.verb === 'post_entry' && c.mode === 'draft' && c.decisionReason !== 'replayed');
  assert.ok(drafting, 'the drafting call is in the trace');
  assert.equal(drafting.draftStatus, 'rejected');
  assert.equal(drafting.rejectReason, 'Falscher Lieferant', 'the reason is IN the trace, beside the proposal');
  assert.equal(drafting.resolvedBy, 'studio', 'the reject path writes the backlink the approve path writes');
  assert.equal(typeof drafting.resolvedAt, 'string');
  assert.equal(drafting.entityRef, null, 'nothing was created');
  // A read row carries neither: the join is per drafting call, never a blanket.
  const read = calls.find((c) => c.verb === 'list_agent_sessions');
  assert.equal(read.draftStatus, null);
  assert.equal(read.rejectReason, null);

  // Nothing posted, ever.
  assert.equal(deps.store.db.prepare('SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ?').get(workspaceId).n, 0);
  const approve = human(deps, 'approve_drafted_action', { workspaceId, actionId: drafted.actionId });
  assert.equal(approve.error, 'already_rejected');
  deps.store.close();
});

test('reject without a reason stays honest: no invented sentence, null everywhere; a non-string reason is refused', () => {
  const deps = freshDeps();
  const { workspaceId, accId } = mintWorkspace(deps);
  const drafted = mcp(deps, 'post_entry', { workspaceId, ...manualPost(accId, 'no-reason', 100) });
  const bad = human(deps, 'reject_drafted_action', { workspaceId, actionId: drafted.actionId, reason: 42 });
  assert.equal(bad.ok, false);
  assert.equal(bad.error, 'invalid_input');
  assert.equal(bad.field, 'reason');
  const blank = human(deps, 'reject_drafted_action', { workspaceId, actionId: drafted.actionId, reason: '   ' });
  assert.equal(blank.ok, true, JSON.stringify(blank));
  assert.equal('reason' in blank, false, 'a blank reason is no reason');
  const listed = human(deps, 'list_drafted_actions', { workspaceId, status: 'rejected' });
  assert.equal(listed.actions[0].rejectReason, null);
  deps.store.close();
});

test('F4 (governance critic, 2026-09-05): the reason is capped at 500 characters, and a refused reason rejects nothing', () => {
  const deps = freshDeps();
  const { workspaceId, accId } = mintWorkspace(deps);
  const drafted = mcp(deps, 'post_entry', { workspaceId, ...manualPost(accId, 'long-reason', 100) });
  assert.equal(drafted.drafted, true);
  assert.equal(REJECT_REASON_MAX_LENGTH, 500, 'the figure the Studio textarea and the refusal quote');

  // HOW IT BITES: drop the length check in `rejectDraftedAction` and the 2 MB reason is stored in full.
  const tooLong = human(deps, 'reject_drafted_action', { workspaceId, actionId: drafted.actionId, reason: 'x'.repeat(2_000_000) });
  assert.equal(tooLong.ok, false);
  assert.equal(tooLong.error, 'invalid_input');
  assert.equal(tooLong.field, 'reason');
  assert.equal(tooLong.maxLength, 500);
  const row = deps.store.db.prepare('SELECT status, reject_reason FROM agent_action WHERE id = ?').get(drafted.actionId);
  assert.equal(row.status, 'pending', 'a refused reason settles nothing: the Vorschlag is still open');
  assert.equal(row.reject_reason, null);

  // One over the cap refuses; exactly the cap (after trimming) is accepted and stored whole.
  const overByOne = human(deps, 'reject_drafted_action', { workspaceId, actionId: drafted.actionId, reason: 'y'.repeat(501) });
  assert.equal(overByOne.error, 'invalid_input');
  const atCap = human(deps, 'reject_drafted_action', { workspaceId, actionId: drafted.actionId, reason: `  ${'z'.repeat(500)}  ` });
  assert.equal(atCap.ok, true, JSON.stringify(atCap));
  assert.equal(atCap.reason.length, 500);
  deps.store.close();
});

test('§H-TENANT: a reason never reads across workspaces', () => {
  const deps = freshDeps();
  const a = mintWorkspace(deps, 'A GmbH', 'wa');
  const b = mintWorkspace(deps, 'B GmbH', 'wb');
  const drafted = mcp(deps, 'post_entry', { workspaceId: a.workspaceId, ...manualPost(a.accId, 'ka', 100) });
  const foreign = human(deps, 'reject_drafted_action', { workspaceId: b.workspaceId, actionId: drafted.actionId, reason: 'nope' });
  assert.equal(foreign.ok, false);
  assert.equal(foreign.error, 'not_found');
  assert.equal(deps.store.db.prepare('SELECT status FROM agent_action WHERE id = ?').get(drafted.actionId).status, 'pending');
  deps.store.close();
});

test('F1 (governance critic, 2026-09-05): contacts_anonymise reaches the reject reason and the drafted payload', () => {
  const deps = freshDeps();
  const { workspaceId, accId } = mintWorkspace(deps);
  const NAME = 'Muellerprobe AG';
  const EMAIL = 'kontakt@muellerprobe.example';
  const vendor = human(deps, 'create_contact', { workspaceId, partyRole: 'vendor', name: NAME, email: EMAIL, idempotencyKey: 'c-mp' });
  assert.equal(vendor.ok, true, JSON.stringify(vendor));

  // The agent's draft names the vendor in its payload; the human's refusal names it AND its email.
  const drafted = mcp(deps, 'post_entry', {
    workspaceId,
    ...manualPost(accId, 'wrong-vendor-anon', 3300),
    description: `Rechnung ${NAME} September`,
  });
  assert.equal(drafted.drafted, true, JSON.stringify(drafted));
  const reason = `Falscher Lieferant: ${NAME} (${EMAIL}) hat gekündigt`;
  const rejected = human(deps, 'reject_drafted_action', { workspaceId, actionId: drafted.actionId, reason });
  assert.equal(rejected.ok, true, JSON.stringify(rejected));
  assert.equal(rejected.reason, reason, 'premise: the reason is stored verbatim before the erasure');

  // revDSG erasure of the vendor. HOW IT BITES: drop the two `agent_action` columns from the sweep in
  // `purgeAgentTraceForStrings` and the row still reads the name and the email verbatim below.
  const erased = human(deps, 'contacts_anonymise', { workspaceId, contactId: vendor.contact.id, idempotencyKey: 'anon-mp' });
  assert.equal(erased.ok, true, JSON.stringify(erased));
  assert.ok(erased.tracePurged.redacted >= 3, `args_json, payload_json and reject_reason each swept: ${JSON.stringify(erased.tracePurged)}`);

  const noIdentity = (label, text) => {
    assert.equal(text.includes(NAME), false, `${label}: the name is gone`);
    assert.equal(text.includes(EMAIL), false, `${label}: the email is gone`);
  };
  // The row itself.
  const row = deps.store.db.prepare('SELECT reject_reason, payload_json FROM agent_action WHERE id = ?').get(drafted.actionId);
  noIdentity('agent_action.reject_reason', row.reject_reason);
  noIdentity('agent_action.payload_json', row.payload_json);
  assert.ok(row.reject_reason.includes('[anonymisiert]'), 'the reason keeps its shape, with the identity redacted');
  assert.ok(row.reject_reason.startsWith('Falscher Lieferant: '), 'the human\'s own words around the identity survive');
  // Every read model that renders it: the queue, the replay answer, and the trace.
  const listed = human(deps, 'list_drafted_actions', { workspaceId, status: 'rejected' });
  noIdentity('list_drafted_actions', JSON.stringify(listed));
  // The replay carries the SAME key and a neutral description: the key answers the first draft either
  // way, and a probe that re-typed the name would plant it in a fresh args_json row after the sweep.
  const replay = mcp(deps, 'post_entry', { workspaceId, ...manualPost(accId, 'wrong-vendor-anon', 3300), description: 'Replay nach der Löschung' });
  assert.equal(replay.actionId, drafted.actionId);
  noIdentity('the same-key replay answer', JSON.stringify(replay));
  const sessions = mcp(deps, 'list_agent_sessions', { workspaceId });
  const detail = mcp(deps, 'get_agent_session', { workspaceId, sessionId: sessions.sessions[0].sessionId });
  assert.equal(detail.ok, true, JSON.stringify(detail));
  const drafting = detail.turns.flatMap((t) => t.calls).find((c) => c.verb === 'post_entry' && c.mode === 'draft' && c.decisionReason !== 'replayed');
  assert.ok(drafting, 'the drafting call is in the trace');
  assert.ok(drafting.rejectReason.includes('[anonymisiert]'));
  noIdentity('get_agent_session', JSON.stringify(detail));
  deps.store.close();
});
