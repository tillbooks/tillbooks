/**
 * G22 (D127 addendum, non-author critic 2026-09-09): the ePortal attestation is governed under the
 * agent seat by the SAME dial as `vat_mark_filed`.
 *
 * THE DEFECT THIS BITES ON. `checklist_item_complete` is not in `DIAL_CAPABILITY_FOR_ACTION` (by
 * name it must not be: items 4 and 6 are the agent's own verb items), so before the input-keyed rule
 * the agent seat recorded "im ESTV ePortal eingereicht" with `decision_reason = 'ungoverned'` while
 * its `vat_mark_filed` for the same period drafted under the strong-default ask (D103). Delete the
 * rule from `INPUT_KEYED_DIAL_RULES` and the first test fails: `drafted` is undefined, the item flips
 * to done under the agent's name, and the trace row reads `execute / ungoverned`.
 *
 * Driven through the REAL transport dispatch (`runGoverned`, what `callTool` and `handleRest` call),
 * never `action.run`: the seam is the thing under test.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runGoverned } from '../../dist/api/agent-gate.js';
import { getAction } from '../../dist/api/registry.js';
import { DIAL_CAPABILITIES } from '../../dist/core/agent/dial.js';
import { DIAL_CAPABILITY_FOR_ACTION, INPUT_KEYED_DIAL_RULES, dialCapabilityForCall } from '../../dist/core/agent/index.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';

let seq = 0;
const key = (tag) => `g22-dial-${tag}-${(seq += 1)}`;
const must = (res, what) => {
  assert.equal(res.ok, true, `${what} failed: ${JSON.stringify(res)}`);
  return res;
};

/** The human decider (studio) acts through the registry directly: no session, no dial. */
function human(deps, name, input) {
  return getAction(name).run({ ...deps, actor: 'studio' }, input);
}

/** The agent seat at the transport seam. */
function agent(deps, name, input) {
  return runGoverned({ ...deps, actor: 'agent' }, getAction(name), input);
}

/** A configured workspace with a 2026-Q2 run walked (as a human) up to item 6, so item 7 is next. */
function runAtItem7() {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps, 'Attest GmbH', 'attest-ws');
  const call = (name, input) => human(deps, name, { workspaceId, ...input });
  must(call('vat_seed_defaults', {}), 'seed');
  must(call('set_vat_method', { vatMethod: 'effektiv', vatAccounting: 'soll' }), 'method');
  const started = must(call('checklist_start', { templateId: 'vat_period', period: '2026-Q2', idempotencyKey: key('start') }), 'start');
  const runId = started.runId;
  must(call('checklist_item_complete', { runId, itemId: 'vat_return_computed', idempotencyKey: key('4') }), 'item 4');
  must(call('checklist_item_complete', { runId, itemId: 'abstimmung_reviewed', idempotencyKey: key('5') }), 'item 5');
  must(call('update_company_profile', { name: 'Attest GmbH', uid: 'CHE-116.281.271' }), 'uid');
  must(call('checklist_item_complete', { runId, itemId: 'ech0217_exported', idempotencyKey: key('6') }), 'item 6');
  const view = must(call('checklist_get', { runId }), 'get');
  assert.equal(view.nextItemId, 'eportal_filed', 'premise: item 7 is next');
  return { deps, workspaceId, runId };
}

function itemOf(deps, workspaceId, runId, itemId) {
  const view = must(human(deps, 'checklist_get', { workspaceId, runId }), 'get');
  return view.items.find((i) => i.itemId === itemId);
}

function traceRows(deps, workspaceId, verb) {
  return deps.store.db
    .prepare('SELECT verb, mode, decision_reason, dial_capability FROM agent_call WHERE workspace_id = ? AND verb = ? ORDER BY rowid')
    .all(workspaceId, verb);
}

const ATTEST = (workspaceId, runId, tag) => ({
  workspaceId,
  runId,
  itemId: 'eportal_filed',
  evidence: { kind: 'filed_attestation', ref: '2026-07-16' },
  idempotencyKey: key(tag),
});

test('the rule is closed and sane: a real write verb, the SAME capability as vat_mark_filed, keyed on the attestation input only', () => {
  const rule = INPUT_KEYED_DIAL_RULES.find((r) => r.action === 'checklist_item_complete');
  assert.ok(rule, 'the attestation rule exists');
  assert.equal(getAction('checklist_item_complete').kind, 'write');
  assert.ok(DIAL_CAPABILITIES.includes(rule.capability), `'${rule.capability}' is a real dial capability`);
  assert.equal(rule.capability, DIAL_CAPABILITY_FOR_ACTION.vat_mark_filed, 'the attestation and vat_mark_filed share one dial');
  assert.equal(DIAL_CAPABILITY_FOR_ACTION.checklist_item_complete, undefined, 'the verb is NOT governed by name (items 4 and 6 are the agent\'s own)');
  const attestation = { evidence: { kind: 'filed_attestation', ref: '2026-07-16' } };
  assert.equal(dialCapabilityForCall('checklist_item_complete', attestation), 'vat-file');
  assert.equal(dialCapabilityForCall('checklist_item_complete', { evidence: { kind: 'signoff', ref: 'bank:1' } }), undefined);
  assert.equal(dialCapabilityForCall('checklist_item_complete', {}), undefined);
  assert.equal(dialCapabilityForCall('vat_mark_filed', {}), 'vat-file', 'the name-keyed map still answers first');
  assert.equal(dialCapabilityForCall('checklist_item_skip', attestation), undefined, 'the rule is per verb, not per payload shape');
});

test('agent seat: the attestation DRAFTS under vat-file, the same mode as vat_mark_filed; the item stays open; the trace says draft', () => {
  const { deps, workspaceId, runId } = runAtItem7();

  const attested = agent(deps, 'checklist_item_complete', ATTEST(workspaceId, runId, 'agent'));
  assert.equal(attested.ok, true, JSON.stringify(attested));
  assert.equal(attested.drafted, true, 'the attestation is drafted, never recorded by the agent alone');
  assert.equal(attested.dialCapability, 'vat-file');
  assert.equal(typeof attested.actionId, 'string');

  const marked = agent(deps, 'vat_mark_filed', { workspaceId, period: '2026-Q2', idempotencyKey: key('mark') });
  assert.equal(marked.ok, true, JSON.stringify(marked));
  assert.equal(marked.drafted, true);
  assert.equal(marked.dialCapability, attested.dialCapability, 'one dial for the filing claim, whichever verb carries it');
  assert.equal(marked.reason, attested.reason, 'the same decision reason (the strong-default ask)');

  assert.equal(itemOf(deps, workspaceId, runId, 'eportal_filed').status, 'open', 'nothing was recorded');
  assert.deepEqual(traceRows(deps, workspaceId, 'checklist_item_complete'), [
    { verb: 'checklist_item_complete', mode: 'draft', decision_reason: attested.reason, dial_capability: 'vat-file' },
  ]);

  // The Vorschlag carries the capability, so the hub card renders the vat-file sentence.
  const pending = must(human(deps, 'list_drafted_actions', { workspaceId, status: 'pending' }), 'list');
  const draft = pending.actions.find((a) => a.actionId === attested.actionId);
  assert.ok(draft, 'the draft is listed');
  assert.equal(draft.dialCapability, 'vat-file');
  assert.equal(draft.actionTool, 'checklist_item_complete');

  // A human approves: the replay runs as the approver and the attestation is recorded ONCE, under the approver.
  const approved = human(deps, 'approve_drafted_action', { workspaceId, actionId: attested.actionId });
  assert.equal(approved.ok, true, JSON.stringify(approved));
  const item = itemOf(deps, workspaceId, runId, 'eportal_filed');
  assert.equal(item.status, 'done');
  assert.equal(item.signoff.kind, 'filed_attestation');
  assert.equal(item.signoff.evidenceRef, '2026-07-16');
  assert.equal(item.signoff.actorKind, 'studio', 'the attestation stands under the approver, not the agent');
  const rows = deps.store.db.prepare('SELECT COUNT(*) AS n FROM checklist_signoff WHERE run_id = ? AND voided_at IS NULL').get(runId);
  assert.equal(rows.n, 2, 'item 5 and item 7: one live attestation, not two');
  deps.store.close();
});

test('agent seat: the rest of the verb stays ungoverned (an agent item completion executes, traced execute/ungoverned)', () => {
  const { deps, workspaceId, runId } = runAtItem7();
  // Item 4 is the agent's own verb item; re-completing it is idempotent on the row and must EXECUTE.
  const recomputed = agent(deps, 'checklist_item_complete', { workspaceId, runId, itemId: 'vat_return_computed', idempotencyKey: key('4-agent') });
  assert.equal(recomputed.ok, true, JSON.stringify(recomputed));
  assert.notEqual(recomputed.drafted, true, 'a verb item is not drafted: the agent lane of the template survives');
  assert.equal(recomputed.alreadyDone, true);
  assert.deepEqual(traceRows(deps, workspaceId, 'checklist_item_complete'), [
    { verb: 'checklist_item_complete', mode: 'execute', decision_reason: 'ungoverned', dial_capability: null },
  ]);
  deps.store.close();
});

test('human path untouched: a studio attestation executes at once, opens no session, lands no trace row', () => {
  const { deps, workspaceId, runId } = runAtItem7();
  const attested = runGoverned({ ...deps, actor: 'studio' }, getAction('checklist_item_complete'), ATTEST(workspaceId, runId, 'human'));
  assert.equal(attested.ok, true, JSON.stringify(attested));
  assert.notEqual(attested.drafted, true);
  assert.equal(attested.item.status, 'done');
  assert.equal(attested.item.signoff.actorKind, 'studio');
  const rows = deps.store.db.prepare('SELECT COUNT(*) AS n FROM agent_call WHERE workspace_id = ?').get(workspaceId).n;
  assert.equal(rows, 0, 'a human at the Studio opens no session');
  deps.store.close();
});

test('the WHOLE input-keyed rule table is closed and sane: every rule names a real write verb, a real dial capability, and a verb the name-keyed map does not already govern', () => {
  // The name-keyed map has this loop in trust.test.mjs; without one here a future rule naming a
  // non-existent verb, a read verb, an unknown capability, or a verb already governed by name (which
  // dialCapabilityForCall answers first, so the rule would be dead) would ship unnoticed.
  assert.ok(INPUT_KEYED_DIAL_RULES.length > 0, 'the table is not empty');
  for (const rule of INPUT_KEYED_DIAL_RULES) {
    const action = getAction(rule.action);
    assert.ok(action !== undefined, `${rule.action}: the rule names a verb that exists`);
    assert.equal(action.kind, 'write', `${rule.action}: only writes are dial-governed`);
    assert.ok(DIAL_CAPABILITIES.includes(rule.capability), `${rule.action}: '${rule.capability}' is a real dial capability`);
    assert.equal(DIAL_CAPABILITY_FOR_ACTION[rule.action], undefined, `${rule.action}: a verb governed by name makes its input rule dead`);
    assert.equal(typeof rule.when, 'function', `${rule.action}: the predicate is a function`);
    assert.equal(rule.when({}), false, `${rule.action}: an empty input is never the governed one`);
    assert.ok(typeof rule.why === 'string' && rule.why.length > 20, `${rule.action}: the rule states why, in a sentence`);
  }
});
