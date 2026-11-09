/**
 * G15 F-01 meets F-08 / J5.6 (critic F2): the reason typed into the hub's in-place reject is a
 * RECORD, not a field that goes nowhere.
 *
 * The hub renders "Ablehnen" with a reason field and sends `reason` beside the option's declared
 * input. Before the governance branch, `reject_drafted_action` dropped it on the floor (the critic
 * scanned every text column and found nothing). Now the engine stores it on the `agent_action` row
 * (`reject_reason`), echoes it in the queue read, and joins it into the A35 trace beside the drafting
 * call. This suite drives that path EXACTLY as the hub does: the draft is minted by the agent over
 * the MCP transport (so a session and a trace exist), the reject option is read off `attention_list`
 * and fired with the option's own input plus the typed reason, and the reason is read back from the
 * row, the read model and `get_agent_session`.
 *
 * HOW IT BITES: drop the `reason` spread from the hub call shape (the `extra` argument of
 * `runOption`) and every reason assertion fails; drop `reject_reason = ?` from the engine UPDATE and
 * the row and trace assertions fail.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { callTool } from '../../dist/api/mcp.js';
import { getAction } from '../../dist/api/registry.js';
import { freshDeps, mintWorkspace, manualPost } from '../api/support.mjs';

const mcp = (deps, name, args) => JSON.parse(callTool(deps, name, args).content[0].text);
const human = (deps) => ({ ...deps, actor: 'studio' });

const ok = (res, label = 'result') => {
  assert.equal(res.ok, true, `expected ${label} ok, got ${JSON.stringify(res)}`);
  return res;
};

/** The hub's own call shape (`Attention.tsx` `act()`): the option's fixed input, the workspace, the reason. */
function runOption(deps, workspaceId, option, extra = {}) {
  return getAction(option.verb).run(deps, {
    workspaceId,
    ...option.input,
    ...(option.humanConfirm ? { confirmed: true } : {}),
    ...extra,
  });
}

const REASON = 'Falsches Konto: Aufwand statt Ertrag';

test('the hub reject option with a typed reason: stored on the row, listed, in the A35 trace, kept on replay, and nothing posted', () => {
  const deps = freshDeps();
  const { workspaceId, accId } = mintWorkspace(deps, 'Grund GmbH', 'att-hub-reason-ws');

  // The agent drafts at the default dial (ask), over the transport, so the trace has a drafting call.
  const drafted = mcp(deps, 'post_entry', { workspaceId, ...manualPost(accId, 'hub-reason-key', 4200) });
  assert.equal(drafted.drafted, true, JSON.stringify(drafted));

  // The hub reads the row and takes its reject option, declared with the reason field.
  const [item] = ok(getAction('attention_list').run(deps, { workspaceId, queueId: 'agent_action' }), 'attention_list').items;
  assert.equal(item.entityId, drafted.actionId);
  const reject = item.decisionOptions.find((o) => o.id === 'reject');
  assert.equal(reject.verb, 'reject_drafted_action');
  assert.equal(reject.reasonField, true, 'the option asks for a reason because the engine keeps one');

  const rejected = ok(runOption(human(deps), workspaceId, reject, { reason: `  ${REASON}  ` }), 'reject #1');
  assert.equal(rejected.status, 'rejected');
  assert.equal(rejected.reason, REASON, 'trimmed and echoed back');

  // 1. The drafted-action row.
  const row = deps.store.db
    .prepare('SELECT status, reject_reason, resolved_by FROM agent_action WHERE workspace_id = ? AND id = ?')
    .get(workspaceId, drafted.actionId);
  assert.equal(row.status, 'rejected');
  assert.equal(row.reject_reason, REASON, 'the typed reason is ON the row');
  assert.equal(row.resolved_by, 'studio');

  // 2. The queue read the /agent card renders.
  const listed = ok(getAction('list_drafted_actions').run(human(deps), { workspaceId, status: 'rejected' }), 'list_drafted_actions');
  assert.equal(listed.actions.length, 1);
  assert.equal(listed.actions[0].rejectReason, REASON);

  // 3. The A35 trace, beside the drafting call.
  const sessions = mcp(deps, 'list_agent_sessions', { workspaceId });
  assert.ok(sessions.sessions.length >= 1, 'the agent session exists');
  const detail = mcp(deps, 'get_agent_session', { workspaceId, sessionId: sessions.sessions[0].sessionId });
  assert.equal(detail.ok, true, JSON.stringify(detail));
  const drafting = detail.turns.flatMap((t) => t.calls).find((c) => c.verb === 'post_entry' && c.mode === 'draft');
  assert.ok(drafting, 'the drafting call is in the trace');
  assert.equal(drafting.draftStatus, 'rejected');
  assert.equal(drafting.rejectReason, REASON, 'the hub reason reaches the trace');
  assert.equal(drafting.resolvedBy, 'studio');

  // A double click replays: the FIRST reason stands, a second reason never rewrites why.
  const again = ok(runOption(human(deps), workspaceId, reject, { reason: 'ein anderer Grund' }), 'reject #2 (double click)');
  assert.equal(again.reason, REASON);
  assert.equal(deps.store.db.prepare('SELECT reject_reason FROM agent_action WHERE id = ?').get(drafted.actionId).reject_reason, REASON);

  // The hub row is gone, and nothing was ever posted.
  assert.equal(ok(getAction('attention_list').run(deps, { workspaceId, queueId: 'agent_action' })).items.length, 0);
  assert.equal(deps.store.db.prepare(`SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ?`).get(workspaceId).n, 0);
  deps.store.close();
});

test('the hub reject option without a reason stays honest: no invented sentence, null on the row and in the read', () => {
  const deps = freshDeps();
  const { workspaceId, accId } = mintWorkspace(deps, 'Ohne Grund GmbH', 'att-hub-noreason-ws');
  const drafted = mcp(deps, 'post_entry', { workspaceId, ...manualPost(accId, 'hub-noreason-key', 100) });
  const reject = ok(getAction('attention_list').run(deps, { workspaceId, queueId: 'agent_action' })).items[0].decisionOptions.find((o) => o.id === 'reject');
  // The hub omits `reason` entirely when the field is blank (`Attention.tsx` `act()` spreads it only when non-empty).
  const rejected = ok(runOption(human(deps), workspaceId, reject), 'reject without a reason');
  assert.equal('reason' in rejected, false, 'no reason typed, none echoed');
  assert.equal(deps.store.db.prepare('SELECT reject_reason FROM agent_action WHERE id = ?').get(drafted.actionId).reject_reason, null);
  const listed = ok(getAction('list_drafted_actions').run(human(deps), { workspaceId, status: 'rejected' }));
  assert.equal(listed.actions[0].rejectReason, null);
  deps.store.close();
});

test('a reason above the 500-character cap is refused as invalid_input on the field, and the draft stays pending', () => {
  const deps = freshDeps();
  const { workspaceId, accId } = mintWorkspace(deps, 'Lang GmbH', 'att-hub-long-ws');
  const drafted = mcp(deps, 'post_entry', { workspaceId, ...manualPost(accId, 'hub-long-key', 100) });
  const reject = ok(getAction('attention_list').run(deps, { workspaceId, queueId: 'agent_action' })).items[0].decisionOptions.find((o) => o.id === 'reject');
  const tooLong = runOption(human(deps), workspaceId, reject, { reason: 'x'.repeat(501) });
  assert.equal(tooLong.ok, false);
  assert.equal(tooLong.error, 'invalid_input');
  assert.equal(tooLong.field, 'reason');
  assert.equal(tooLong.maxLength, 500);
  assert.equal(deps.store.db.prepare('SELECT status FROM agent_action WHERE id = ?').get(drafted.actionId).status, 'pending');
  const atCap = ok(runOption(human(deps), workspaceId, reject, { reason: 'y'.repeat(500) }), 'exactly 500 characters');
  assert.equal(atCap.reason.length, 500);
  deps.store.close();
});

test('§H-TENANT: the hub reject option fired against another workspace is not_found and keeps the draft pending', () => {
  const deps = freshDeps();
  const a = mintWorkspace(deps, 'A GmbH', 'att-hub-reason-a');
  const b = mintWorkspace(deps, 'B GmbH', 'att-hub-reason-b');
  const drafted = mcp(deps, 'post_entry', { workspaceId: a.workspaceId, ...manualPost(a.accId, 'hub-tenant-key', 100) });
  const reject = ok(getAction('attention_list').run(deps, { workspaceId: a.workspaceId, queueId: 'agent_action' })).items[0].decisionOptions.find((o) => o.id === 'reject');
  const foreign = runOption(human(deps), b.workspaceId, reject, { reason: 'nope' });
  assert.equal(foreign.ok, false);
  assert.equal(foreign.error, 'not_found');
  const row = deps.store.db.prepare('SELECT status, reject_reason FROM agent_action WHERE id = ?').get(drafted.actionId);
  assert.equal(row.status, 'pending');
  assert.equal(row.reject_reason, null);
  deps.store.close();
});
