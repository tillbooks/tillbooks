// @ts-nocheck
/**
 * D196, THE OWNER'S GRANT FOR AGENT DECISIONS, measured on rows.
 *
 * Written for a NON-AUTHOR critic to read: each test names the invariant it holds and counts the rows that
 * prove it, never a returned `ok` alone.
 *
 *  - grant OFF (the default): the agent seat cannot reject or approve, on either door; the refusal says where
 *    the owner grants it; the Vorschlag stays pending and nothing is posted.
 *  - the grant is HUMAN-ONLY: the agent can neither set nor propose `agent.decide_proposals`.
 *  - grant `reject`: the agent rejects; approving still refuses.
 *  - grant `decide`: the agent approves, the act executes ONCE (journal rows), `allowFuture` never rides it.
 *  - every decision under the grant writes one `decided_under_grant` history entry naming the grantor.
 *  - REVOKE (back to `off`): refused again.
 *  - FAIL CLOSED: a grant whose stored row names a governed seat, or a grantor who no longer holds
 *    `manage_agent_dial`, grants nothing.
 *  - the grant opens ONLY the decision verbs: `set_agent_dial` stays refused under `decide`.
 *
 * All data is synthetic (the seeded KMU chart of a fresh in-memory workspace).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { handleRest } from '../../dist/api/rest.js';
import { callTool } from '../../dist/api/mcp.js';
import { getAction } from '../../dist/api/registry.js';
import { freshDeps, mintWorkspace, manualPost } from './support.mjs';
import { postTemplate } from '../automation/support.mjs';

const rest = (deps, name, input) => handleRest(name, input, deps).body;
const mcp = (deps, name, input) => JSON.parse(callTool(deps, name, input).content[0].text);
const asStudio = (deps) => ({ ...deps, actor: 'studio' });
const asAgent = (deps) => ({ ...deps, actor: 'agent' });

const count = (db, sql, ...args) => db.prepare(sql).get(...args).n;
const posted = (w) => count(w.deps.store.db, "SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ? AND status = 'posted'", w.ws);
const rowOf = (w, id) => w.deps.store.db.prepare('SELECT status, resolved_by, history_json FROM agent_action WHERE workspace_id = ? AND id = ?').get(w.ws, id);
const historyOf = (w, id) => JSON.parse(rowOf(w, id).history_json ?? '[]');

function world(seed) {
  const deps = freshDeps();
  deps.actor = 'studio';
  const { workspaceId, accId } = mintWorkspace(deps, 'Muster GmbH', `${seed}-ws`);
  return { deps, ws: workspaceId, accId };
}

let n = 0;
function grant(w, value) {
  n += 1;
  const r = getAction('settings_set').run(asStudio(w.deps), { workspaceId: w.ws, key: 'agent.decide_proposals', value, reason: 'D196 test', idempotencyKey: `grant-${value}-${n}` });
  assert.equal(r.ok, true, JSON.stringify(r));
}

/** One agent-drafted post_entry (the dial is at ask by default, so the agent's write drafts). */
function draft(w, key) {
  const d = rest(asAgent(w.deps), 'post_entry', { workspaceId: w.ws, ...manualPost(w.accId, key) });
  assert.equal(d.drafted, true, JSON.stringify(d));
  return d.actionId;
}

/** One agent-drafted bank-line booking (a bank decision, the only kind the grant approves). */
function bankDraft(w, key, amount = 2500) {
  const created = getAction('create_bank_account').run(asStudio(w.deps), {
    workspaceId: w.ws, name: `Kantonalbank ${key}`, iban: 'CH93 0076 2011 6238 5295 7', currency: 'CHF', ledgerAccountId: w.accId('1020'), idempotencyKey: `${key}-bank`,
  });
  assert.equal(created.ok, true, JSON.stringify(created));
  const imported = getAction('import_bank_statement').run(asStudio(w.deps), {
    workspaceId: w.ws, bankAccountId: created.bankAccountId, content: `Datum;Text;Betrag\n02.03.2026;Lieferant ${key};-${(amount / 100).toFixed(2)}\n`,
    mapping: { columns: { bookingDate: 'Datum', text: 'Text', amount: 'Betrag' }, dateFormat: 'dd.mm.yyyy' }, idempotencyKey: `${key}-csv`,
  });
  assert.equal(imported.ok, true, JSON.stringify(imported));
  const txn = w.deps.store.db.prepare('SELECT id FROM bank_txn WHERE workspace_id = ? AND bank_account_id = ?').get(w.ws, created.bankAccountId).id;
  const d = rest(asAgent(w.deps), 'book_bank_line', { workspaceId: w.ws, bankTxnId: txn, target: { kind: 'accounts', legs: [{ accountId: '6500', amountMinor: amount }] }, idempotencyKey: `${key}-book` });
  assert.equal(d.drafted, true, JSON.stringify(d));
  return d.actionId;
}

test('grant off (default): the agent cannot reject or approve on either door, and is told where the owner grants it', () => {
  const w = world('off');
  const id = draft(w, 'off-1');
  const before = posted(w);

  const rejRest = rest(asAgent(w.deps), 'reject_drafted_action', { workspaceId: w.ws, actionId: id, reason: 'falsch' });
  assert.equal(rejRest.error, 'permission_denied', JSON.stringify(rejRest));
  assert.equal(rejRest.capability, 'manage_agent_dial');
  assert.equal(rejRest.ownerCanGrant.setting, 'agent.decide_proposals');
  assert.equal(rejRest.ownerCanGrant.value, 'reject');
  assert.equal(rejRest.ownerCanGrant.path, '/setup');

  const rejMcp = mcp(asAgent(w.deps), 'reject_drafted_action', { workspaceId: w.ws, actionId: id });
  assert.equal(rejMcp.error, 'permission_denied');
  assert.equal(rejMcp.ownerCanGrant.value, 'reject');

  const appr = rest(asAgent(w.deps), 'approve_drafted_action', { workspaceId: w.ws, actionId: id });
  assert.equal(appr.error, 'permission_denied');
  assert.equal(appr.ownerCanGrant.value, 'decide');

  const batch = rest(asAgent(w.deps), 'approve_drafted_actions', { workspaceId: w.ws, ids: [id] });
  assert.equal(batch.ok, false);

  assert.equal(rowOf(w, id).status, 'pending', 'the Vorschlag is untouched');
  assert.deepEqual(historyOf(w, id), []);
  assert.equal(posted(w), before, 'nothing posted');
  w.deps.store.close();
});

test('the grant is human-only: the agent never sets agent.decide_proposals; it only proposes it to a person (D202)', () => {
  const w = world('ho');
  const r = rest(asAgent(w.deps), 'settings_set', { workspaceId: w.ws, key: 'agent.decide_proposals', value: 'decide', reason: 'ich will', idempotencyKey: 'ho-1' });
  // D202 point 5 reverses D183 for proposals: a person-only Vorschlag, which the grant itself can never approve.
  assert.equal(r.drafted, true, JSON.stringify(r));
  assert.equal(r.reason, 'person_only');
  assert.equal(count(w.deps.store.db, "SELECT COUNT(*) AS n FROM workspace_setting WHERE workspace_id = ? AND key = 'agent.decide_proposals'", w.ws), 0);
  w.deps.store.close();
});

test('grant reject: the agent rejects (history names the grant); approving still refuses', () => {
  const w = world('rej');
  const a = draft(w, 'rej-1');
  const b = draft(w, 'rej-2');
  grant(w, 'reject');
  const before = posted(w);

  const r = mcp(asAgent(w.deps), 'reject_drafted_action', { workspaceId: w.ws, actionId: a, reason: 'falscher Faktor' });
  assert.equal(r.ok, true, JSON.stringify(r));
  const row = rowOf(w, a);
  assert.equal(row.status, 'rejected');
  assert.equal(row.resolved_by, 'agent');
  const h = historyOf(w, a);
  assert.equal(h.length, 1);
  assert.equal(h[0].event, 'decided_under_grant');
  assert.equal(h[0].decision, 'rejected');
  assert.equal(h[0].by, 'agent');
  assert.equal(h[0].scope, 'reject');
  assert.equal(h[0].grantedBy, 'studio');
  assert.equal(typeof h[0].grantedAt, 'string');

  const appr = rest(asAgent(w.deps), 'approve_drafted_action', { workspaceId: w.ws, actionId: b });
  assert.equal(appr.error, 'permission_denied', JSON.stringify(appr));
  assert.equal(appr.ownerCanGrant.value, 'decide');
  assert.equal(rowOf(w, b).status, 'pending');
  assert.equal(posted(w), before);
  w.deps.store.close();
});

test('grant decide: the agent approves a bank decision, the act executes once, and allowFuture never rides the grant', () => {
  const w = world('dec');
  const a = bankDraft(w, 'dec-1');
  const b = draft(w, 'dec-2');
  grant(w, 'decide');
  const before = posted(w);

  const withFuture = rest(asAgent(w.deps), 'approve_drafted_action', { workspaceId: w.ws, actionId: a, allowFuture: true });
  assert.equal(withFuture.error, 'cannot_self_grant', JSON.stringify(withFuture));
  assert.equal(count(w.deps.store.db, 'SELECT COUNT(*) AS n FROM agent_dial WHERE workspace_id = ?', w.ws), 0, 'no dial row');
  assert.equal(rowOf(w, a).status, 'pending');
  assert.equal(posted(w), before);

  const r = rest(asAgent(w.deps), 'approve_drafted_action', { workspaceId: w.ws, actionId: a });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.status, 'executed');
  assert.equal(posted(w), before + 1, 'exactly one entry posted');
  const row = rowOf(w, a);
  assert.equal(row.status, 'executed');
  assert.equal(row.resolved_by, 'agent');
  const h = historyOf(w, a);
  assert.equal(h.length, 1);
  assert.deepEqual([h[0].event, h[0].decision, h[0].scope, h[0].grantedBy], ['decided_under_grant', 'approved', 'decide', 'studio']);

  // The trace shows the drafting call decided by the agent under the grant (the Studio renders it apart).
  const session = w.deps.store.db.prepare('SELECT session_id FROM agent_turn t JOIN agent_call c ON c.turn_id = t.id WHERE c.agent_action_id = ?').get(a).session_id;
  const detail = rest(asStudio(w.deps), 'get_agent_session', { workspaceId: w.ws, sessionId: session });
  assert.equal(detail.ok, true, JSON.stringify(detail));
  const drafting = detail.turns.flatMap((t) => t.calls).find((c) => c.agentActionId === a);
  assert.equal(drafting.draftStatus, 'executed');
  assert.deepEqual(drafting.decidedUnderGrant, { decision: 'approved', by: 'agent', grantedBy: 'studio', grantedAt: h[0].grantedAt });

  // Approve-twice settles: no second entry, no second history entry.
  const again = rest(asAgent(w.deps), 'approve_drafted_action', { workspaceId: w.ws, actionId: a });
  assert.equal(again.ok, true);
  assert.equal(posted(w), before + 1);
  assert.equal(historyOf(w, a).length, 1);

  // `decide` covers reject too.
  assert.equal(rest(asAgent(w.deps), 'reject_drafted_action', { workspaceId: w.ws, actionId: b, reason: 'D196 test: falscher Vorschlag' }).ok, true);
  assert.equal(rowOf(w, b).status, 'rejected');
  w.deps.store.close();
});

test('grant decide: the batch approval runs, each id as its own approval under the grant', () => {
  const w = world('bat');
  const created = getAction('create_bank_account').run(asStudio(w.deps), {
    workspaceId: w.ws, name: 'Kantonalbank Kontokorrent', iban: 'CH93 0076 2011 6238 5295 7', currency: 'CHF', ledgerAccountId: w.accId('1020'), idempotencyKey: 'bat-bank',
  });
  assert.equal(created.ok, true, JSON.stringify(created));
  const imported = getAction('import_bank_statement').run(asStudio(w.deps), {
    workspaceId: w.ws, bankAccountId: created.bankAccountId, content: 'Datum;Text;Betrag\n02.03.2026;Lieferant 1;-25.00\n',
    mapping: { columns: { bookingDate: 'Datum', text: 'Text', amount: 'Betrag' }, dateFormat: 'dd.mm.yyyy' }, idempotencyKey: 'bat-csv',
  });
  assert.equal(imported.ok, true, JSON.stringify(imported));
  const txn = w.deps.store.db.prepare('SELECT id FROM bank_txn WHERE workspace_id = ?').get(w.ws).id;
  const d = rest(asAgent(w.deps), 'book_bank_line', { workspaceId: w.ws, bankTxnId: txn, target: { kind: 'accounts', legs: [{ accountId: '6500', amountMinor: 2500 }] }, idempotencyKey: 'bat-1' });
  assert.equal(d.drafted, true, JSON.stringify(d));

  const refused = rest(asAgent(w.deps), 'approve_drafted_actions', { workspaceId: w.ws, ids: [d.actionId] });
  assert.equal(refused.ok, false);
  grant(w, 'decide');
  const before = posted(w);
  const res = rest(asAgent(w.deps), 'approve_drafted_actions', { workspaceId: w.ws, ids: [d.actionId] });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(res.items.map((i) => i.ok), [true]);
  assert.equal(posted(w), before + 1);
  assert.equal(historyOf(w, d.actionId)[0].event, 'decided_under_grant');
  w.deps.store.close();
});

test('revoke: back to off, the agent is refused again and the Vorschlag stays pending', () => {
  const w = world('rev');
  const a = draft(w, 'rev-1');
  grant(w, 'decide');
  grant(w, 'off');
  const before = posted(w);
  assert.equal(rest(asAgent(w.deps), 'approve_drafted_action', { workspaceId: w.ws, actionId: a }).error, 'permission_denied');
  assert.equal(rest(asAgent(w.deps), 'reject_drafted_action', { workspaceId: w.ws, actionId: a }).error, 'permission_denied');
  assert.equal(rowOf(w, a).status, 'pending');
  assert.equal(posted(w), before);
  // The change history keeps both acts, attributed to the person.
  const changes = w.deps.store.db
    .prepare("SELECT new_value_json, actor FROM workspace_setting_change WHERE workspace_id = ? AND key = 'agent.decide_proposals' ORDER BY rowid")
    .all(w.ws);
  assert.deepEqual(changes.map((c) => [JSON.parse(c.new_value_json), c.actor]), [['decide', 'studio'], ['off', 'studio']]);
  w.deps.store.close();
});

test('fail closed: a stored grant signed by a governed seat, or by someone who no longer holds the right, grants nothing', () => {
  const w = world('fc');
  const a = draft(w, 'fc-1');
  grant(w, 'decide');
  // A grant row the agent seat signed (no path writes one; a restored or edited file might hold it).
  w.deps.store.db.prepare("UPDATE workspace_setting SET updated_by = 'agent' WHERE workspace_id = ? AND key = 'agent.decide_proposals'").run(w.ws);
  assert.equal(rest(asAgent(w.deps), 'approve_drafted_action', { workspaceId: w.ws, actionId: a }).error, 'permission_denied');

  // Provision the book (the first invite seats the local actors as owners), then name a grantor who is no member.
  assert.equal(getAction('invite_member').run(asStudio(w.deps), { workspaceId: w.ws, email: 'fc@muster.ch', role: 'viewer', idempotencyKey: 'fc-inv' }).ok, true);
  w.deps.store.db.prepare("UPDATE workspace_setting SET updated_by = 'member:gone' WHERE workspace_id = ? AND key = 'agent.decide_proposals'").run(w.ws);
  assert.equal(rest(asAgent(w.deps), 'approve_drafted_action', { workspaceId: w.ws, actionId: a }).error, 'permission_denied');
  assert.equal(rest(asAgent(w.deps), 'reject_drafted_action', { workspaceId: w.ws, actionId: a }).error, 'permission_denied');

  // The same grant signed by the owner who still holds the right is in force.
  w.deps.store.db.prepare("UPDATE workspace_setting SET updated_by = 'studio' WHERE workspace_id = ? AND key = 'agent.decide_proposals'").run(w.ws);
  assert.equal(rest(asAgent(w.deps), 'reject_drafted_action', { workspaceId: w.ws, actionId: a, reason: 'D196 test: falscher Vorschlag' }).ok, true);
  assert.equal(rowOf(w, a).status, 'rejected');
  w.deps.store.close();
});

test('the grant opens only the decision verbs: set_agent_dial and get_agent_dial stay refused under decide', () => {
  const w = world('only');
  grant(w, 'decide');
  const set = rest(asAgent(w.deps), 'set_agent_dial', { workspaceId: w.ws, capability: 'post', level: 'auto', idempotencyKey: 'only-1' });
  assert.equal(set.ok, false, JSON.stringify(set));
  assert.equal(set.ownerCanGrant, undefined, 'no grant hint on a verb no grant opens');
  assert.equal(rest(asAgent(w.deps), 'get_agent_dial', { workspaceId: w.ws }).ok, false);
  assert.equal(count(w.deps.store.db, 'SELECT COUNT(*) AS n FROM agent_dial WHERE workspace_id = ?', w.ws), 0);
  w.deps.store.close();
});

test('a person decides exactly as before under any grant value', () => {
  const w = world('human');
  const a = draft(w, 'human-1');
  grant(w, 'decide');
  const before = posted(w);
  const r = rest(asStudio(w.deps), 'approve_drafted_action', { workspaceId: w.ws, actionId: a });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(posted(w), before + 1);
  assert.deepEqual(historyOf(w, a), [], 'a person\'s decision carries no grant entry');
  const session = w.deps.store.db.prepare('SELECT session_id FROM agent_turn t JOIN agent_call c ON c.turn_id = t.id WHERE c.agent_action_id = ?').get(a).session_id;
  const drafting = rest(asStudio(w.deps), 'get_agent_session', { workspaceId: w.ws, sessionId: session }).turns.flatMap((t) => t.calls).find((c) => c.agentActionId === a);
  assert.equal(drafting.decidedUnderGrant, null);
  assert.equal(rowOf(w, a).resolved_by, 'studio');
  w.deps.store.close();
});

test('critic M1: a plugin call never decides a Vorschlag, even under the agent grant (D161.2 holds)', async () => {
  const { runPluginToolCall } = await import('../../dist/core/plugins/sandbox.js');
  const w = world('plug');
  // Provision the book (the first invite seats the local actors as owners), then a second human owner who
  // installed a plugin (synthetic seat).
  assert.equal(getAction('invite_member').run(asStudio(w.deps), { workspaceId: w.ws, email: 'x@example.invalid', role: 'viewer', idempotencyKey: 'plug-inv' }).ok, true);
  const cols = w.deps.store.db.prepare('PRAGMA table_info(user)').all().map((c) => c.name);
  const userRow = { id: 'usr_bob', actor_id: 'member:usr_bob', email: 'bob@example.invalid', display_name: 'Bob', created_at: '2026-01-01' };
  if (cols.includes('kind')) userRow.kind = 'human';
  const keys = Object.keys(userRow);
  w.deps.store.db.prepare(`INSERT INTO user (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...keys.map((x) => userRow[x]));
  w.deps.store.db.prepare("INSERT INTO workspace_member (id, workspace_id, user_id, role, invited_at, accepted_at, created_by) VALUES ('mem_bob', ?, 'usr_bob', 'owner', '2026-01-01', '2026-01-01', 'studio')").run(w.ws);

  const id = draft(w, 'plug-1');
  grant(w, 'decide');
  const before = posted(w);
  const invoke = (tool, input, asActor) => getAction(tool).run({ ...w.deps, actor: asActor }, input);
  const call = (tool, input) => runPluginToolCall(invoke, { grantedScopes: [`mcp_tool:${tool}`], pluginActor: 'member:usr_bob', tool, input });
  assert.equal(call('approve_drafted_action', { workspaceId: w.ws, actionId: id }).ok, false);
  assert.equal(call('reject_drafted_action', { workspaceId: w.ws, actionId: id }).ok, false);
  assert.equal(rowOf(w, id).status, 'pending');
  assert.deepEqual(historyOf(w, id), []);
  assert.equal(posted(w), before);
  w.deps.store.close();
});

// --- owner answers after the critic (H1, P1, P2): what the grant covers -------------------------------------

test('critic H1: under decide the agent cannot approve its own automation rule, so nothing keeps posting after a revoke', () => {
  const w = world('h1');
  grant(w, 'decide');
  const create = rest(asAgent(w.deps), 'create_automation_rule', {
    workspaceId: w.ws, name: 'Agent bucht', trigger: { event: 'contact.created' },
    action: { tool: 'post_entry', inputTemplate: postTemplate(w.accId, 1234, '2026-03-15') }, idempotencyKey: 'h1-rule',
  });
  assert.equal(create.drafted, true, JSON.stringify(create));
  const refused = rest(asAgent(w.deps), 'approve_drafted_action', { workspaceId: w.ws, actionId: create.actionId });
  assert.equal(refused.error, 'permission_denied', JSON.stringify(refused));
  assert.equal(refused.reason, 'outside_grant');
  assert.equal(refused.grantExclusion, 'not_a_bank_decision');
  assert.ok(refused.approveAt, 'the agent is pointed to where a person decides');
  assert.equal(rowOf(w, create.actionId).status, 'pending');
  assert.equal(count(w.deps.store.db, "SELECT COUNT(*) AS n FROM automation_rule WHERE workspace_id = ? AND name = 'Agent bucht'", w.ws), 0, 'the agent\'s rule does not exist');
  // A person still can, and the agent may still reject its own rule proposal.
  assert.equal(rest(asAgent(w.deps), 'reject_drafted_action', { workspaceId: w.ws, actionId: create.actionId, reason: 'D196 test: falscher Vorschlag' }).ok, true);
  w.deps.store.close();
});

test('critic P1: under decide the strong default vat-file waits for a person', () => {
  const w = world('p1');
  assert.equal(getAction('set_vat_method').run(asStudio(w.deps), { workspaceId: w.ws, vatMethod: 'effektiv', vatAccounting: 'soll' }).ok, true);
  const d = rest(asAgent(w.deps), 'vat_mark_filed', { workspaceId: w.ws, period: '2026-Q1', idempotencyKey: 'p1-vf' });
  assert.equal(d.drafted, true, JSON.stringify(d));
  grant(w, 'decide');
  const locks = () => count(w.deps.store.db, 'SELECT COUNT(*) AS n FROM period_lock WHERE workspace_id = ?', w.ws);
  const before = locks();
  const r = rest(asAgent(w.deps), 'approve_drafted_action', { workspaceId: w.ws, actionId: d.actionId });
  assert.equal(r.grantExclusion, 'not_a_bank_decision', JSON.stringify(r));
  assert.equal(locks(), before, 'no filing lock written');
  assert.equal(rowOf(w, d.actionId).status, 'pending');
  w.deps.store.close();
});

test('critic P2: TILL\'s own offers stay the person\'s: the agent can neither reject nor approve a system-drafted Vorschlag', () => {
  const w = world('p2');
  grant(w, 'decide');
  // A synthetic system-drafted Vorschlag (the actor TILL drafts its offers under).
  w.deps.store.db
    .prepare("INSERT INTO agent_action (id, workspace_id, actor, dial_capability, action_tool, payload_json, status, created_at) VALUES ('agent_action_sys', ?, 'system', 'post', 'post_entry', ?, 'pending', '2026-03-01T00:00:00Z')")
    .run(w.ws, JSON.stringify({ workspaceId: w.ws, ...manualPost(w.accId, 'p2-1') }));
  const rej = rest(asAgent(w.deps), 'reject_drafted_action', { workspaceId: w.ws, actionId: 'agent_action_sys' });
  assert.equal(rej.grantExclusion, 'system_offer', JSON.stringify(rej));
  const appr = rest(asAgent(w.deps), 'approve_drafted_action', { workspaceId: w.ws, actionId: 'agent_action_sys' });
  assert.equal(appr.grantExclusion, 'system_offer', JSON.stringify(appr));
  assert.equal(rowOf(w, 'agent_action_sys').status, 'pending');
  w.deps.store.close();
});

test('re-cut (owner, after three FAILs): decide approves bank decisions only; a post_entry and a settlement template wait', () => {
  const w = world('recut');
  const entry = draft(w, 'recut-1');
  const tpl = rest(asAgent(w.deps), 'set_settlement_template', { workspaceId: w.ws, system: 'stripe', processor: 'stripe', clearingAccountId: '1020', idempotencyKey: 'recut-tpl' });
  grant(w, 'decide');
  const before = posted(w);
  assert.equal(rest(asAgent(w.deps), 'approve_drafted_action', { workspaceId: w.ws, actionId: entry }).grantExclusion, 'not_a_bank_decision');
  assert.equal(tpl.drafted, true, JSON.stringify(tpl));
  assert.equal(rest(asAgent(w.deps), 'approve_drafted_action', { workspaceId: w.ws, actionId: tpl.actionId }).grantExclusion, 'not_a_bank_decision');
  assert.equal(posted(w), before);
  // The agent may still reject them (only TILL's own offers are spared).
  assert.equal(rest(asAgent(w.deps), 'reject_drafted_action', { workspaceId: w.ws, actionId: entry, reason: 'D196 test: falscher Vorschlag' }).ok, true);
  w.deps.store.close();
});

test('paper critic H2: the grant tests every dial family the stored call can draft under, so attach cannot hide a VAT refund', async () => {
  const { grantExclusionFor } = await import('../../dist/core/agent/decisionGrant.js');
  const payload = { workspaceId: 'w', bankTxnId: 't', target: { kind: 'contact', contactId: 'c', refundVat: 'keep', overrideReason: 'Kunde bleibt' }, attach: [{ fileId: 'f' }], idempotencyKey: 'k' };
  // Stored under close-period (the attach tier sorts above vat-file), yet vat-file is among its families.
  assert.equal(grantExclusionFor('approve', { actor: 'agent', action_tool: 'book_bank_line', dial_capability: 'close-period', payload_json: JSON.stringify(payload) }), 'excluded_family');
  const plain = { workspaceId: 'w', bankTxnId: 't', target: { kind: 'accounts', legs: [{ accountId: '6500', amountMinor: 100 }] }, idempotencyKey: 'k' };
  assert.equal(grantExclusionFor('approve', { actor: 'agent', action_tool: 'book_bank_line', dial_capability: 'post', payload_json: JSON.stringify(plain) }), null);
  assert.equal(grantExclusionFor('approve', { actor: 'agent', action_tool: 'book_bank_line', dial_capability: 'post', payload_json: '{not json' }), 'unreadable');
  assert.equal(grantExclusionFor('approve', { actor: 'agent', action_tool: 'book_bank_line', dial_capability: null, payload_json: JSON.stringify(plain) }), 'no_dial_family');
  assert.equal(grantExclusionFor('reject', { actor: 'agent', action_tool: 'post_entry', dial_capability: 'post', payload_json: '{}' }), null);
  assert.equal(grantExclusionFor('reject', { actor: 'system', action_tool: 'set_bank_standard', dial_capability: 'post', payload_json: '{}' }), 'system_offer');
});
