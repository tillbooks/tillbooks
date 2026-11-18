// @ts-nocheck
/**
 * D202 points 4 to 6 (owner, 15.11.2026): THE AGENT AND A SETTING, measured on rows (G00 §11.5, §11.6).
 *
 * Written for a NON-AUTHOR critic to read: every test names the invariant it holds and proves it on the
 * tables (`workspace_setting`, `workspace_setting_change`, `agent_action`), never on a returned `ok` alone.
 *
 *  I1  No governed seat ever WRITES a human-only key: the agent's call drafts a person-only Vorschlag on every
 *      door and at every dial, and the stored setting stays as it was. The engine refuses the write itself.
 *  I2  The D196 grant never approves a settings change: under a live `decide` grant the agent's approval of a
 *      person-only Vorschlag refuses; `GRANT_APPROVABLE_TOOLS` holds no settings verb.
 *  I3  A person-only Vorschlag is never batch-approved (`not_batchable`, under every batch mode).
 *  I4  No automation rule, plugin call or scheduled job sets a human-only key.
 *  I5  The area permission never covers a human-only key and is itself human-only (also through call_tool).
 *  I6  The approver holds the key's owning capability at click time (a demoted approver is refused).
 *  I7  A Vorschlag whose setting moved since drafting is stale.
 *  I8  At most `agent.settings_proposals_open_max` person-only settings Vorschläge are open.
 *  I9  Every change carries actor, seat, how, approver and capability on an append-only row.
 *
 * SYNTHETIC BY CONSTRUCTION: a fresh in-memory workspace with invented names.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { handleRest } from '../../dist/api/rest.js';
import { callTool } from '../../dist/api/mcp.js';
import { getAction } from '../../dist/api/registry.js';
import { makeContext } from '../../dist/core/context.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';
import { GRANT_APPROVABLE_TOOLS } from '../../dist/core/agent/decisionGrant.js';
import { NOT_AUTOMATABLE } from '../../dist/core/automation/denylist.js';
import { dialCapabilitiesForCall } from '../../dist/core/agent/dialMap.js';
import { withinPluginCall } from '../../dist/core/plugins/callScope.js';
import { SETTINGS, getSetting, settingsSet, settingDef } from '../../dist/core/settings/index.js';

const rest = (deps, name, input) => handleRest(name, input, deps).body;
const mcp = (deps, name, input) => JSON.parse(callTool(deps, name, input).content[0].text);
const asStudio = (deps) => ({ ...deps, actor: 'studio' });
const asAgent = (deps) => ({ ...deps, actor: 'agent' });

const count = (w, sql, ...args) => w.deps.store.db.prepare(sql).get(...args).n;
const storedRow = (w, key) => w.deps.store.db.prepare('SELECT value_json, updated_by FROM workspace_setting WHERE workspace_id = ? AND key = ?').get(w.ws, key);
const changes = (w, key) => count(w, 'SELECT COUNT(*) AS n FROM workspace_setting_change WHERE workspace_id = ? AND key = ?', w.ws, key);
const actionRow = (w, id) => w.deps.store.db.prepare('SELECT status, actor, action_tool, dial_capability FROM agent_action WHERE workspace_id = ? AND id = ?').get(w.ws, id);
const ctxOf = (w, actor = 'studio') => makeContext(w.deps.store, { workspaceId: w.ws, actor, clock: w.deps.clock, ids: w.deps.ids });

/** Protected keys of three different areas and owners (the owner's own example first). */
const GRANT_KEY = 'agent.decide_proposals'; // manage_agent_dial, Agent und Automatik
const BANK_PROTECTED = 'bank.row_approve'; // human-only, Bank
const FILES_PROTECTED = 'files.source_roots'; // human-only, widens what TILL reads, Belege
const BANK_OPEN = 'bank.fx_mode'; // not protected, Bank
const BUCHHALTUNG_OPEN = 'checklists.attention_window_days'; // not protected, Buchhaltung

function world(seed) {
  const deps = freshDeps();
  deps.actor = 'studio';
  const { workspaceId } = mintWorkspace(deps, 'Muster GmbH', `${seed}-ws`);
  return { deps, ws: workspaceId };
}

let seq = 0;
const key = (p) => `${p}-${(seq += 1)}`;

/** A person's direct change (the Studio seat). */
function personSet(w, k, value) {
  const r = getAction('settings_set').run(asStudio(w.deps), { workspaceId: w.ws, key: k, value, idempotencyKey: key('p') });
  assert.equal(r.ok, true, JSON.stringify(r));
  return r;
}

function setDial(w, capability, level) {
  const r = rest(asStudio(w.deps), 'set_agent_dial', { workspaceId: w.ws, capability, level, idempotencyKey: key('dial') });
  assert.equal(r.ok, true, JSON.stringify(r));
}

/** The agent's change through the REST door, the way an agent's HTTP client sends it. */
function agentSet(w, k, value, extra = {}) {
  return rest(asAgent(w.deps), 'settings_set', { workspaceId: w.ws, key: k, value, idempotencyKey: key('a'), ...extra });
}

function assertPersonOnlyDraft(w, res, k, before) {
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.drafted, true, JSON.stringify(res));
  assert.equal(res.reason, 'person_only', JSON.stringify(res));
  assert.equal(actionRow(w, res.actionId).status, 'pending');
  assert.deepEqual(storedRow(w, k), before, `${k}: the stored setting is unchanged`);
}

// --- I1 -------------------------------------------------------------------------------------------------

test('I1: the agent proposing a protected setting drafts a person-only Vorschlag on REST and MCP, at every dial, and writes no setting', () => {
  const w = world('i1');
  for (const k of [GRANT_KEY, BANK_PROTECTED]) {
    const before = storedRow(w, k);
    const value = k === GRANT_KEY ? 'reject' : 'review';
    assertPersonOnlyDraft(w, agentSet(w, k, value), k, before);
    assert.equal(changes(w, k), 0, `${k}: no history row, nothing changed`);
  }
  // Even with the key's dial family at auto, a protected key never executes for the agent.
  setDial(w, 'customize', 'auto');
  const viaMcp = mcp(asAgent(w.deps), 'settings_set', { workspaceId: w.ws, key: FILES_PROTECTED, value: '~', idempotencyKey: key('mcp') });
  assertPersonOnlyDraft(w, viaMcp, FILES_PROTECTED, undefined);
  assert.equal(getSetting(ctxOf(w), FILES_PROTECTED), settingDef(FILES_PROTECTED).default);
  w.deps.store.close();
});

test('I1: the engine itself refuses a governed seat writing a protected setting (an embedder that bypasses the seam)', () => {
  const w = world('i1e');
  assert.equal(settingsSet(ctxOf(w, 'agent'), { key: GRANT_KEY, value: 'decide', idempotencyKey: key('e') }).error, 'human_only');
  // Through the registry boundary A24 step 0 answers first for a manage_agent_dial key; a manage_settings key
  // reaches the engine, which refuses human_only. Either way nothing is written.
  assert.equal(getAction('settings_set').run(asAgent(w.deps), { workspaceId: w.ws, key: GRANT_KEY, value: 'decide', idempotencyKey: key('e') }).error, 'permission_denied');
  assert.equal(getAction('settings_set').run(asAgent(w.deps), { workspaceId: w.ws, key: FILES_PROTECTED, value: '~', idempotencyKey: key('e') }).error, 'human_only');
  assert.equal(getAction('settings_reset').run(asAgent(w.deps), { workspaceId: w.ws, key: FILES_PROTECTED, idempotencyKey: key('e') }).error, 'human_only');
  assert.equal(storedRow(w, GRANT_KEY), undefined);
  assert.equal(storedRow(w, FILES_PROTECTED), undefined);
  w.deps.store.close();
});

test('I1: an ask-first question is never proposed by the agent: refused human_only (ask_first), nothing drafted', () => {
  const w = world('ask');
  const askFirst = SETTINGS.find((s) => s.askFirst === true);
  assert.ok(askFirst, 'the registry carries an ask-first setting');
  const before = count(w, 'SELECT COUNT(*) AS n FROM agent_action WHERE workspace_id = ?', w.ws);
  const r = agentSet(w, askFirst.key, askFirst.default);
  assert.equal(r.error, 'human_only', JSON.stringify(r));
  assert.equal(r.reason, 'ask_first');
  assert.equal(count(w, 'SELECT COUNT(*) AS n FROM agent_action WHERE workspace_id = ?', w.ws), before);
  w.deps.store.close();
});

// --- I2 -------------------------------------------------------------------------------------------------

test('I2: under a live decide grant the agent cannot approve a person-only Vorschlag; no settings verb is grant-approvable', () => {
  assert.equal(GRANT_APPROVABLE_TOOLS.has('settings_set'), false);
  assert.equal(GRANT_APPROVABLE_TOOLS.has('settings_reset'), false);
  const w = world('i2');
  personSet(w, GRANT_KEY, 'decide');
  const drafted = agentSet(w, BANK_PROTECTED, 'review');
  assertPersonOnlyDraft(w, drafted, BANK_PROTECTED, undefined);
  for (const door of [rest, mcp]) {
    const r = door(asAgent(w.deps), 'approve_drafted_action', { workspaceId: w.ws, actionId: drafted.actionId });
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.equal(r.error, 'cannot_self_approve', JSON.stringify(r));
    assert.equal(r.reason, 'person_only');
  }
  assert.equal(actionRow(w, drafted.actionId).status, 'pending');
  assert.equal(storedRow(w, BANK_PROTECTED), undefined);
  // A Vorschlag of the agent.decide_proposals grant itself is equally out of the grant's reach.
  const self = agentSet(w, GRANT_KEY, 'off');
  assertPersonOnlyDraft(w, self, GRANT_KEY, storedRow(w, GRANT_KEY));
  assert.equal(rest(asAgent(w.deps), 'approve_drafted_action', { workspaceId: w.ws, actionId: self.actionId }).error, 'cannot_self_approve');
  assert.equal(JSON.parse(storedRow(w, GRANT_KEY).value_json), 'decide');
  w.deps.store.close();
});

// --- I3 -------------------------------------------------------------------------------------------------

test('I3: a person-only Vorschlag is never batch-approved, under every batch mode', () => {
  const w = world('i3');
  const drafted = agentSet(w, BANK_PROTECTED, 'review');
  assertPersonOnlyDraft(w, drafted, BANK_PROTECTED, undefined);
  for (const mode of ['tick', 'all_with_confirm', 'single']) {
    personSet(w, 'attention.approval_batch_mode', mode);
    const r = rest(asStudio(w.deps), 'approve_drafted_actions', { workspaceId: w.ws, ids: [drafted.actionId] });
    assert.equal(r.ok === true ? r.items[0].ok : r.ok, false, `${mode}: ${JSON.stringify(r)}`);
    const code = r.ok === true ? r.items[0].refusal.error : r.error;
    assert.equal(code, 'not_batchable', `${mode}: ${JSON.stringify(r)}`);
  }
  assert.equal(actionRow(w, drafted.actionId).status, 'pending');
  assert.equal(storedRow(w, BANK_PROTECTED), undefined);
  w.deps.store.close();
});

// --- I4 -------------------------------------------------------------------------------------------------

test('I4: no automation rule fires a settings change, and a plugin call is refused a protected setting without a draft', () => {
  assert.ok(NOT_AUTOMATABLE.has('settings_set'));
  assert.ok(NOT_AUTOMATABLE.has('settings_reset'));
  const w = world('i4');
  const drafts = () => count(w, 'SELECT COUNT(*) AS n FROM agent_action WHERE workspace_id = ?', w.ws);
  const before = drafts();
  const plugin = withinPluginCall('member:plug', () =>
    rest({ ...w.deps, actor: 'member:plug' }, 'settings_set', { workspaceId: w.ws, key: GRANT_KEY, value: 'decide', idempotencyKey: key('plug') }),
  );
  assert.equal(plugin.ok, false, JSON.stringify(plugin));
  assert.equal(drafts(), before, 'a plugin call queues no Vorschlag');
  assert.equal(storedRow(w, GRANT_KEY), undefined);
  w.deps.store.close();
});

// --- I5 -------------------------------------------------------------------------------------------------

test('I5: with Bank opened to the agent, a bank setting applies at once and says so, a protected bank setting still drafts', () => {
  const w = world('i5');
  personSet(w, 'agent.settings_sections', 'bank');
  const applied = agentSet(w, BANK_OPEN, 'facts_only');
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.notEqual(applied.drafted, true, 'applied, not drafted');
  assert.equal(JSON.parse(storedRow(w, BANK_OPEN).value_json), 'facts_only');
  const row = w.deps.store.db.prepare('SELECT actor, seat, via, capability FROM workspace_setting_change WHERE workspace_id = ? AND key = ?').get(w.ws, BANK_OPEN);
  assert.deepEqual(row, { actor: 'agent', seat: 'agent', via: 'standing', capability: 'agent.settings_sections:bank' });
  // A protected key of the same area: never covered.
  assertPersonOnlyDraft(w, agentSet(w, BANK_PROTECTED, 'review'), BANK_PROTECTED, undefined);
  // An area the owner did not open keeps the dial (ask: a Vorschlag, not person-only).
  const elsewhere = agentSet(w, BUCHHALTUNG_OPEN, 30);
  assert.equal(elsewhere.drafted, true, JSON.stringify(elsewhere));
  assert.equal(elsewhere.reason, 'dial_ask');
  assert.equal(storedRow(w, BUCHHALTUNG_OPEN), undefined);
  w.deps.store.close();
});

test('I5: the agent can never widen its own permission: agent.settings_sections drafts on every door, also through call_tool', () => {
  const w = world('i5self');
  personSet(w, 'agent.settings_sections', 'bank');
  const before = storedRow(w, 'agent.settings_sections');
  assertPersonOnlyDraft(w, agentSet(w, 'agent.settings_sections', 'bank,agent,belege'), 'agent.settings_sections', before);
  const viaCallTool = mcp(asAgent(w.deps), 'call_tool', {
    workspaceId: w.ws,
    name: 'settings_set',
    args: { workspaceId: w.ws, key: 'agent.settings_sections', value: 'bank,agent', idempotencyKey: key('ct') },
  });
  assert.equal(viaCallTool.drafted, true, JSON.stringify(viaCallTool));
  const viaReset = rest(asAgent(w.deps), 'settings_reset', { workspaceId: w.ws, key: 'agent.settings_sections', idempotencyKey: key('rs') });
  assert.equal(viaReset.drafted, true, JSON.stringify(viaReset));
  assert.deepEqual(storedRow(w, 'agent.settings_sections'), before);
  w.deps.store.close();
});

test('I5: the permission fails closed: signed by a governed seat, or by a grantor who lost manage_agent_dial, it opens nothing', () => {
  const w = world('i5fc');
  personSet(w, 'agent.settings_sections', 'bank');
  w.deps.store.db.prepare("UPDATE workspace_setting SET updated_by = 'agent' WHERE workspace_id = ? AND key = 'agent.settings_sections'").run(w.ws);
  const signedByAgent = agentSet(w, BANK_OPEN, 'facts_only');
  assert.equal(signedByAgent.drafted, true, JSON.stringify(signedByAgent));
  assert.equal(getAction('invite_member').run(asStudio(w.deps), { workspaceId: w.ws, email: 'fc@muster.example', role: 'viewer', idempotencyKey: key('inv') }).ok, true);
  w.deps.store.db.prepare("UPDATE workspace_setting SET updated_by = 'member:gone' WHERE workspace_id = ? AND key = 'agent.settings_sections'").run(w.ws);
  assert.equal(agentSet(w, BANK_OPEN, 'prefill_split').drafted, true);
  assert.equal(storedRow(w, BANK_OPEN), undefined);
  // An unknown area is refused before anything is written.
  const bad = getAction('settings_set').run(asStudio(w.deps), { workspaceId: w.ws, key: 'agent.settings_sections', value: 'bank,mond', idempotencyKey: key('bad') });
  assert.equal(bad.error, 'invalid_setting_value', JSON.stringify(bad));
  assert.equal(bad.reason, 'unknown_area');
  w.deps.store.close();
});

test('critic L1: an opened area still sends a strong-default family and the Agent area to a person, unless the owner switches that off', () => {
  const w = world('strong');
  personSet(w, 'agent.settings_sections', 'mwst,agent');
  // Default true: a vat-file setting (D103 strong default) and an Agent-area setting stay one-click Vorschläge.
  for (const [k, v] of [['bank.anzahlung_vat', true], ['agent.batch_max_items', 7], ['mcp.unknown_fields_agent', 'ignore']]) {
    const r = agentSet(w, k, v);
    assert.equal(r.drafted, true, `${k}: ${JSON.stringify(r)}`);
    assert.equal(r.reason, 'area_strong_default', k);
    assert.equal(storedRow(w, k), undefined, `${k} not applied`);
  }
  // The agent cannot lift it itself: the switch is human-only.
  assert.equal(agentSet(w, 'agent.settings_area_respects_strong_default', false).reason, 'person_only');
  // Off (the owner's choice): the opened area applies them at once, recorded as the standing permission.
  personSet(w, 'agent.settings_area_respects_strong_default', false);
  const vat = agentSet(w, 'bank.anzahlung_vat', true);
  assert.notEqual(vat.drafted, true, JSON.stringify(vat));
  assert.equal(JSON.parse(storedRow(w, 'bank.anzahlung_vat').value_json), true);
  const items = agentSet(w, 'agent.batch_max_items', 7);
  assert.notEqual(items.drafted, true, JSON.stringify(items));
  const via = w.deps.store.db.prepare("SELECT via, capability FROM workspace_setting_change WHERE workspace_id = ? AND key = 'bank.anzahlung_vat'").get(w.ws);
  assert.deepEqual(via, { via: 'standing', capability: 'agent.settings_sections:mwst' });
  w.deps.store.close();
});

test('re-check L2: switching the strong-default rule off counts only while its grantor still holds manage_agent_dial', () => {
  const w = world('strongfc');
  personSet(w, 'agent.settings_sections', 'mwst');
  personSet(w, 'agent.settings_area_respects_strong_default', false);
  // A grantor who left (or a row a governed seat signed) leaves the default in force: the setting is proposed.
  assert.equal(getAction('invite_member').run(asStudio(w.deps), { workspaceId: w.ws, email: 'sfc@muster.example', role: 'viewer', idempotencyKey: key('inv') }).ok, true);
  for (const signer of ['member:gone', 'agent']) {
    w.deps.store.db.prepare("UPDATE workspace_setting SET updated_by = ? WHERE workspace_id = ? AND key = 'agent.settings_area_respects_strong_default'").run(signer, w.ws);
    const r = agentSet(w, 'bank.anzahlung_vat', true);
    assert.equal(r.reason, 'area_strong_default', `${signer}: ${JSON.stringify(r)}`);
  }
  assert.equal(storedRow(w, 'bank.anzahlung_vat'), undefined);
  // Signed by the owner who still holds the right: the opened area applies it.
  w.deps.store.db.prepare("UPDATE workspace_setting SET updated_by = 'studio' WHERE workspace_id = ? AND key IN ('agent.settings_area_respects_strong_default', 'agent.settings_sections')").run(w.ws);
  const applied = agentSet(w, 'bank.anzahlung_vat', true);
  assert.notEqual(applied.drafted, true, JSON.stringify(applied));
  assert.equal(JSON.parse(storedRow(w, 'bank.anzahlung_vat').value_json), true);
  w.deps.store.close();
});

// --- I6, I7 ---------------------------------------------------------------------------------------------

function addOwner(w, id) {
  // Provision the book (the first invite seats the local actors as owners), then a second human owner.
  assert.equal(getAction('invite_member').run(asStudio(w.deps), { workspaceId: w.ws, email: `${id}@muster.example`, role: 'viewer', idempotencyKey: key('inv') }).ok, true);
  w.deps.store.db.prepare("INSERT INTO user (id, actor_id, email, display_name, created_at, kind) VALUES (?, ?, ?, ?, '2026-01-01', 'human')").run(id, `member:${id}`, `${id}-o@muster.example`, id);
  w.deps.store.db.prepare("INSERT INTO workspace_member (id, workspace_id, user_id, role, invited_at, accepted_at, created_by) VALUES (?, ?, ?, 'owner', '2026-01-01', '2026-01-01', 'studio')").run(`mem_${id}`, w.ws, id);
  return `member:${id}`;
}

test('I6: the approver needs the right at click time: a demoted approver is refused, the owner approves, the history says so', () => {
  const w = world('i6');
  const bob = addOwner(w, 'usr_bob');
  const drafted = agentSet(w, BANK_PROTECTED, 'review');
  assertPersonOnlyDraft(w, drafted, BANK_PROTECTED, undefined);
  w.deps.store.db.prepare("UPDATE workspace_member SET role = 'viewer' WHERE workspace_id = ? AND user_id = 'usr_bob'").run(w.ws);
  const refused = rest({ ...w.deps, actor: bob }, 'approve_drafted_action', { workspaceId: w.ws, actionId: drafted.actionId });
  assert.equal(refused.error, 'permission_denied', JSON.stringify(refused));
  assert.equal(storedRow(w, BANK_PROTECTED), undefined);
  // allowFuture never rides a protected setting.
  const future = rest(asStudio(w.deps), 'approve_drafted_action', { workspaceId: w.ws, actionId: drafted.actionId, allowFuture: true });
  assert.equal(future.error, 'invalid_input', JSON.stringify(future));
  assert.equal(count(w, 'SELECT COUNT(*) AS n FROM agent_dial WHERE workspace_id = ?', w.ws), 0);
  const approved = rest(asStudio(w.deps), 'approve_drafted_action', { workspaceId: w.ws, actionId: drafted.actionId });
  assert.equal(approved.ok, true, JSON.stringify(approved));
  assert.equal(JSON.parse(storedRow(w, BANK_PROTECTED).value_json), 'review');
  const h = rest(asStudio(w.deps), 'settings_history', { workspaceId: w.ws, key: BANK_PROTECTED }).changes;
  assert.equal(h.length, 1);
  assert.deepEqual(
    { actor: h[0].actor, seat: h[0].seat, via: h[0].via, approvedBy: h[0].approvedBy, proposedBy: h[0].proposedBy, draftedActionId: h[0].draftedActionId, capability: h[0].capability },
    { actor: 'studio', seat: 'person', via: 'vorschlag', approvedBy: 'studio', proposedBy: 'agent', draftedActionId: drafted.actionId, capability: settingDef(BANK_PROTECTED).owningCapability },
  );
  w.deps.store.close();
});

test('I7: a person changing the setting after the proposal makes the approval refuse vorschlag_stale', () => {
  const w = world('i7');
  const drafted = agentSet(w, GRANT_KEY, 'reject');
  assertPersonOnlyDraft(w, drafted, GRANT_KEY, undefined);
  personSet(w, GRANT_KEY, 'decide');
  const r = rest(asStudio(w.deps), 'approve_drafted_action', { workspaceId: w.ws, actionId: drafted.actionId });
  assert.equal(r.error, 'vorschlag_stale', JSON.stringify(r));
  assert.equal(JSON.parse(storedRow(w, GRANT_KEY).value_json), 'decide', "the person's value stands");
  assert.equal(actionRow(w, drafted.actionId).status, 'stale');
  w.deps.store.close();
});

// --- I8 -------------------------------------------------------------------------------------------------

test('I8: at most three person-only Vorschläge wait; a retry answers its own row; a decided one frees a place', () => {
  const w = world('i8');
  const ids = [];
  for (const [k, v] of [[BANK_PROTECTED, 'review'], [GRANT_KEY, 'reject'], [FILES_PROTECTED, '~/TILL']]) {
    const r = agentSet(w, k, v, { idempotencyKey: `i8-${k}` });
    assertPersonOnlyDraft(w, r, k, storedRow(w, k));
    ids.push(r.actionId);
  }
  const fourth = agentSet(w, 'mail.mbox_client_guard', 'off');
  assert.equal(fourth.error, 'too_many_open_proposals', JSON.stringify(fourth));
  assert.equal(fourth.max, 3);
  const retry = agentSet(w, BANK_PROTECTED, 'review', { idempotencyKey: `i8-${BANK_PROTECTED}` });
  assert.equal(retry.actionId, ids[0], 'the same key answers the pending row');
  assert.equal(count(w, "SELECT COUNT(*) AS n FROM agent_action WHERE workspace_id = ? AND status = 'pending'", w.ws), 3);
  assert.equal(rest(asStudio(w.deps), 'reject_drafted_action', { workspaceId: w.ws, actionId: ids[1] }).ok, true, 'one click, no reason');
  assertPersonOnlyDraft(w, agentSet(w, 'mail.mbox_client_guard', 'off'), 'mail.mbox_client_guard', undefined);
  // The cap is a setting of its own (human-only).
  personSet(w, 'agent.settings_proposals_open_max', 10);
  assertPersonOnlyDraft(w, agentSet(w, 'belege.match_mode', 'off'), 'belege.match_mode', undefined);
  w.deps.store.close();
});

test('critic L2: the cap is counted again inside the draft transaction, so a second process drafting meanwhile cannot exceed it', () => {
  const w = world('i8tx');
  personSet(w, 'agent.settings_proposals_open_max', 1);
  // Another process commits a person-only Vorschlag after the early check and before this call's draft: the
  // first write transaction this call opens (after the early check) commits that row first, as the second
  // process would.
  const store = w.deps.store;
  const tx = store.tx.bind(store);
  let raced = false;
  store.tx = (fn) => {
    if (!raced) {
      raced = true;
      store.db.prepare(`INSERT INTO agent_action (id, workspace_id, actor, dial_capability, action_tool, payload_json, status, idempotency_key, created_at)
        VALUES ('other_process', ?, 'agent', 'customize', 'settings_set', '{"key":"files.source_roots","value":"~"}', 'pending', 'other-key', '2026-01-01')`).run(w.ws);
    }
    return tx(fn);
  };
  const r = agentSet(w, BANK_PROTECTED, 'review');
  assert.equal(r.error, 'too_many_open_proposals', JSON.stringify(r));
  assert.equal(count(w, "SELECT COUNT(*) AS n FROM agent_action WHERE workspace_id = ? AND status = 'pending'", w.ws), 1, 'only the other process\'s row');
  w.deps.store.close();
});

test('critic L3: a proposal that changes nothing is answered unchanged, never drafted, and takes no cap slot', () => {
  const w = world('noop');
  personSet(w, 'agent.settings_proposals_open_max', 1);
  const drafts = () => count(w, "SELECT COUNT(*) AS n FROM agent_action WHERE workspace_id = ? AND status = 'pending'", w.ws);
  // A reset of a protected setting with no override, a set to its default, a set to the value in force.
  const reset = rest(asAgent(w.deps), 'settings_reset', { workspaceId: w.ws, key: BANK_PROTECTED, idempotencyKey: key('n1') });
  assert.deepEqual([reset.ok, reset.unchanged, reset.changed, reset.drafted], [true, true, false, undefined], JSON.stringify(reset));
  const same = agentSet(w, BANK_PROTECTED, 'direct');
  assert.deepEqual([same.unchanged, same.drafted], [true, undefined], JSON.stringify(same));
  personSet(w, GRANT_KEY, 'reject');
  assert.equal(agentSet(w, GRANT_KEY, 'reject').unchanged, true);
  // The dial route too: a non-protected no-op is not queued for approval either.
  assert.equal(agentSet(w, BUCHHALTUNG_OPEN, 14).unchanged, true);
  assert.equal(drafts(), 0);
  // So the one slot is still free for a real proposal.
  assertPersonOnlyDraft(w, agentSet(w, BANK_PROTECTED, 'review'), BANK_PROTECTED, undefined);
  assert.equal(changes(w, BANK_PROTECTED), 0);
  w.deps.store.close();
});

test('security review: no value oracle, an agent seat without the right is refused permission_denied whether its value matches or not', () => {
  const w = world('oracle');
  // Provision the book, then a served agent seat with a viewer role (no right to change settings).
  assert.equal(getAction('invite_member').run(asStudio(w.deps), { workspaceId: w.ws, email: 'o@muster.example', role: 'viewer', idempotencyKey: key('inv') }).ok, true);
  w.deps.store.db.prepare("INSERT INTO user (id, actor_id, email, display_name, created_at, kind) VALUES ('usr_bot', 'member:usr_bot', 'bot@muster.example', 'Bot', '2026-01-01', 'agent')").run();
  w.deps.store.db.prepare("INSERT INTO workspace_member (id, workspace_id, user_id, role, invited_at, accepted_at, created_by) VALUES ('mem_bot', ?, 'usr_bot', 'viewer', '2026-01-01', '2026-01-01', 'studio')").run(w.ws);
  const bot = { ...w.deps, actor: 'member:usr_bot' };
  personSet(w, BANK_PROTECTED, 'review');
  const answer = (r) => JSON.stringify({ ok: r.ok, error: r.error, capability: r.capability, drafted: r.drafted, unchanged: r.unchanged });
  for (const [k, matching, other] of [[BUCHHALTUNG_OPEN, 14, 30], [BANK_PROTECTED, 'review', 'direct']]) {
    const same = rest(bot, 'settings_set', { workspaceId: w.ws, key: k, value: matching, idempotencyKey: key('o') });
    const differ = rest(bot, 'settings_set', { workspaceId: w.ws, key: k, value: other, idempotencyKey: key('o') });
    assert.equal(same.error, 'permission_denied', JSON.stringify(same));
    assert.equal(answer(same), answer(differ), `${k}: the answer must not depend on the value`);
  }
  const resetNoop = rest(bot, 'settings_reset', { workspaceId: w.ws, key: BUCHHALTUNG_OPEN, idempotencyKey: key('o') });
  const resetReal = rest(bot, 'settings_reset', { workspaceId: w.ws, key: BANK_PROTECTED, idempotencyKey: key('o') });
  assert.equal(resetNoop.error, 'permission_denied', JSON.stringify(resetNoop));
  assert.equal(resetReal.error, 'permission_denied', JSON.stringify(resetReal));
  assert.equal(count(w, "SELECT COUNT(*) AS n FROM agent_action WHERE workspace_id = ? AND actor = 'member:usr_bot'", w.ws), 0);
  w.deps.store.close();
});

test('re-check L1: a key already held by a Vorschlag is never answered unchanged; another value under it is a conflict', () => {
  const w = world('noopkey');
  const first = agentSet(w, BUCHHALTUNG_OPEN, 30, { idempotencyKey: 'held-k' });
  assert.equal(first.drafted, true, JSON.stringify(first));
  // The same key with the value in force (14, the default) would be a no-op; it is the key's other call.
  const reused = agentSet(w, BUCHHALTUNG_OPEN, 14, { idempotencyKey: 'held-k' });
  assert.equal(reused.error, 'idempotency_key_conflict', JSON.stringify(reused));
  assert.notEqual(reused.unchanged, true);
  w.deps.store.close();
});

// --- I9 -------------------------------------------------------------------------------------------------

test('I9: every change names actor, seat, how and capability; the rows stay append-only, new columns included', () => {
  const w = world('i9');
  personSet(w, BUCHHALTUNG_OPEN, 21);
  setDial(w, 'customize', 'auto');
  const byDial = agentSet(w, BUCHHALTUNG_OPEN, 28);
  assert.equal(byDial.ok, true, JSON.stringify(byDial));
  const h = rest(asStudio(w.deps), 'settings_history', { workspaceId: w.ws, key: BUCHHALTUNG_OPEN }).changes;
  assert.deepEqual(
    h.map((c) => ({ actor: c.actor, seat: c.seat, via: c.via, capability: c.capability, oldValue: c.oldValue, newValue: c.newValue, reason: c.reason })),
    [
      { actor: 'agent', seat: 'agent', via: 'dial', capability: 'dial:customize', oldValue: 21, newValue: 28, reason: null },
      { actor: 'studio', seat: 'person', via: 'direct', capability: 'manage_checklists', oldValue: null, newValue: 21, reason: null },
    ],
  );
  for (const sql of [
    "UPDATE workspace_setting_change SET via = 'direct' WHERE workspace_id = ?",
    "UPDATE workspace_setting_change SET capability = 'x' WHERE workspace_id = ?",
    'DELETE FROM workspace_setting_change WHERE workspace_id = ?',
  ]) {
    assert.throws(() => w.deps.store.db.prepare(sql).run(w.ws), /append-only/, sql);
  }
  w.deps.store.close();
});

// --- the reasonless write (D202 security review on 4ff582781) -------------------------------------------

test('fail-closed: a reasonless settings write of a governed seat is drafted, never applied (a plugin call, and the agent outside a granted area)', () => {
  assert.deepEqual(dialCapabilitiesForCall('settings_set', { key: BUCHHALTUNG_OPEN, value: 30 }), ['customize']);
  assert.deepEqual(dialCapabilitiesForCall('settings_reset', { key: BANK_OPEN }), [settingDef(BANK_OPEN).dialCapability]);
  const w = world('noreason');
  const bob = addOwner(w, 'usr_plug');
  personSet(w, 'agent.settings_sections', 'bank');
  const drafts = () => count(w, "SELECT COUNT(*) AS n FROM agent_action WHERE workspace_id = ? AND status = 'pending'", w.ws);
  // A plugin call runs as the member who installed it and is a governed seat that is not the agent.
  const before = drafts();
  const plugin = withinPluginCall(bob, () =>
    rest({ ...w.deps, actor: bob }, 'settings_set', { workspaceId: w.ws, key: BUCHHALTUNG_OPEN, value: 30, idempotencyKey: key('plug') }),
  );
  assert.equal(plugin.drafted, true, JSON.stringify(plugin));
  assert.equal(drafts(), before + 1);
  const pluginReset = withinPluginCall(bob, () =>
    rest({ ...w.deps, actor: bob }, 'settings_reset', { workspaceId: w.ws, key: BANK_OPEN, idempotencyKey: key('plugr') }),
  );
  // Critic L5: drafted, nothing weaker (a `changed: false` would also pass on a fail-open run).
  assert.equal(pluginReset.drafted, true, JSON.stringify(pluginReset));
  // The plugin never rides the owner's area permission: Bank is open to the agent, not to a plugin.
  const pluginBank = withinPluginCall(bob, () =>
    rest({ ...w.deps, actor: bob }, 'settings_set', { workspaceId: w.ws, key: BANK_OPEN, value: 'facts_only', idempotencyKey: key('plugb') }),
  );
  assert.equal(pluginBank.drafted, true, JSON.stringify(pluginBank));
  // The agent outside the granted area, without a reason.
  const agent = agentSet(w, BUCHHALTUNG_OPEN, 31);
  assert.equal(agent.drafted, true, JSON.stringify(agent));
  assert.equal(storedRow(w, BUCHHALTUNG_OPEN), undefined, 'nothing applied');
  assert.equal(storedRow(w, BANK_OPEN), undefined, 'nothing applied');
  assert.equal(changes(w, BUCHHALTUNG_OPEN) + changes(w, BANK_OPEN), 0);
  w.deps.store.close();
});

// --- the Pendenzen row ------------------------------------------------------------------------------------

test('Pendenzen: a person-only Vorschlag says what it changes in words, has no künftig automatisch, a one-click reject and no batch', async () => {
  const { attentionList } = await import('../../dist/core/attention/index.js');
  const w = world('att');
  const drafted = agentSet(w, GRANT_KEY, 'reject');
  assertPersonOnlyDraft(w, drafted, GRANT_KEY, undefined);
  const r = attentionList(ctxOf(w), { queueId: 'agent_action', limit: 50 });
  assert.equal(r.ok, true, JSON.stringify(r).slice(0, 300));
  const item = r.items.find((i) => i.entityId === drafted.actionId);
  assert.ok(item, JSON.stringify(r.items.map((i) => i.entityId)));
  assert.deepEqual(item.settingChange, {
    key: GRANT_KEY,
    label: { 'de-CH': 'Agent entscheidet Vorschläge', en: 'Agent decides proposals' },
    area: 'agent',
    from: { en: 'Off', 'de-CH': 'Aus' },
    to: { en: 'Reject', 'de-CH': 'Verwerfen' },
    personOnly: true,
    widensAgent: true,
  });
  assert.deepEqual(item.decisionOptions.map((o) => o.id), ['approve', 'reject']);
  assert.equal(item.decisionOptions.find((o) => o.id === 'reject').reasonField, false);
  assert.equal(item.batchable, false);
  w.deps.store.close();
});

test('critic L6: a plugin change applied at an auto dial is recorded as the dial, never as a direct change', () => {
  const w = world('plugdial');
  const bob = addOwner(w, 'usr_plugd');
  setDial(w, 'customize', 'auto');
  const r = withinPluginCall(bob, () =>
    rest({ ...w.deps, actor: bob }, 'settings_set', { workspaceId: w.ws, key: BUCHHALTUNG_OPEN, value: 30, idempotencyKey: key('pd') }),
  );
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.notEqual(r.drafted, true);
  const row = w.deps.store.db.prepare('SELECT actor, seat, via, capability FROM workspace_setting_change WHERE workspace_id = ? AND key = ?').get(w.ws, BUCHHALTUNG_OPEN);
  assert.deepEqual(row, { actor: bob, seat: 'plugin', via: 'dial', capability: 'dial:customize' });
  w.deps.store.close();
});

// --- settings_history -----------------------------------------------------------------------------------

test('settings_history: newest first, by key or area, paged, tenant-bound, refusing what it does not know', () => {
  const w = world('hist');
  personSet(w, BUCHHALTUNG_OPEN, 21);
  personSet(w, BUCHHALTUNG_OPEN, 22);
  personSet(w, BANK_OPEN, 'facts_only');
  const all = rest(asStudio(w.deps), 'settings_history', { workspaceId: w.ws });
  assert.equal(all.changes.length, 3);
  const bank = rest(asStudio(w.deps), 'settings_history', { workspaceId: w.ws, area: 'bank' });
  assert.deepEqual(bank.changes.map((c) => c.key), [BANK_OPEN]);
  const first = rest(asStudio(w.deps), 'settings_history', { workspaceId: w.ws, limit: 2 });
  assert.equal(first.changes.length, 2);
  assert.notEqual(first.nextBefore, null);
  const second = rest(asStudio(w.deps), 'settings_history', { workspaceId: w.ws, limit: 2, before: first.nextBefore });
  assert.equal(second.changes.length, 1);
  assert.equal(second.nextBefore, null);
  assert.deepEqual(new Set([...first.changes, ...second.changes].map((c) => c.id)).size, 3);
  assert.equal(rest(asStudio(w.deps), 'settings_history', { workspaceId: w.ws, key: 'nope.key' }).error, 'unknown_setting');
  assert.equal(rest(asStudio(w.deps), 'settings_history', { workspaceId: w.ws, area: 'mond' }).error, 'invalid_input');
  assert.equal(rest(asStudio(w.deps), 'settings_history', { workspaceId: w.ws, limit: 0 }).error, 'invalid_input');
  // §H-TENANT: another workspace sees none of it.
  const other = mintWorkspace(w.deps, 'Andere AG', 'hist-other').workspaceId;
  assert.equal(rest(asStudio(w.deps), 'settings_history', { workspaceId: other }).changes.length, 0);
  assert.equal(rest(asStudio(w.deps), 'settings_history', { workspaceId: other, before: first.nextBefore }).error, 'invalid_input');
  w.deps.store.close();
});

test('settings_list carries the ten areas, the presentation per setting and which areas the agent may change', () => {
  const w = world('list');
  personSet(w, 'agent.settings_sections', 'bank,darstellung');
  const r = rest(asStudio(w.deps), 'settings_list', { workspaceId: w.ws });
  assert.deepEqual(r.areas.map((a) => a.id), ['firma', 'buchhaltung', 'bank', 'mwst', 'belege', 'verkauf', 'agent', 'darstellung', 'zugriff', 'daten']);
  assert.deepEqual(r.areas.filter((a) => a.agentMayChange).map((a) => a.id), ['bank', 'darstellung']);
  const fx = r.settings.find((s) => s.key === BANK_OPEN);
  assert.equal(fx.section, 'bank');
  assert.equal(fx.presentation.valueLabels.facts_only['de-CH'], 'Nur Fakten');
  w.deps.store.close();
});
