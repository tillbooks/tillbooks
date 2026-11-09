/**
 * An agent seat cannot make an automation rule fire, or change what a firing rule does, without a
 * Vorschlag (non-author critic R3-2, owner decision 28.09.2026; D141.5).
 *
 * A G01 rule fires its verb as its AUTHOR, internally, outside the transport seam. The engine's P8 belt
 * made an agent-composed rule land disabled, but `enable_automation_rule` had no seat check and no dial
 * mapping, so the agent enabled its own rule at `ask`: a `contact.created -> post_entry` rule posted, a
 * `document.created -> issue_invoice` rule issued R-2026-0001, and a `document.created ->
 * update_document` rule rewrote the recurring tick's fresh draft inside the tick's own call. And
 * `update_automation_rule` could repoint a human's ENABLED rule, which then fired the new verb as the
 * human.
 *
 * Now: `enable_automation_rule` drafts under `customize`; `create_automation_rule` that would start
 * enabled, and `update_automation_rule` touching the trigger, condition or action, draft at the tier of
 * the verb the rule fires (`post` for `post_entry`, `issue` for `issue_invoice`, `customize` otherwise).
 * The approval replays as the human, so every firing rule has a human behind it.
 *
 * Driven through the REAL transport (`callTool`). HOW IT BITES: drop `enable_automation_rule` from the
 * dial map, or the generated automation rules from `INPUT_KEYED_DIAL_RULES`, and the rule tests below
 * find the entry posted or the invoice issued.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { callTool } from '../../dist/api/mcp.js';
import { getAction } from '../../dist/api/registry.js';
import { dialCapabilityForCall } from '../../dist/core/agent/index.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';

const mcp = (deps, name, args) => JSON.parse(callTool(deps, name, args).content[0].text);
const human = (deps, name, input) => getAction(name).run({ ...deps, actor: 'studio' }, input);
const posted = (deps, ws) => deps.store.db.prepare("SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ? AND status = 'posted'").get(ws).n;
const ruleRow = (deps, id) => deps.store.db.prepare('SELECT enabled, action_tool FROM automation_rule WHERE id = ?').get(id);

function postingRule(accId) {
  return {
    name: 'Buchen',
    trigger: { event: 'contact.created' },
    action: {
      tool: 'post_entry',
      inputTemplate: { date: '2026-07-16', source: 'manual', lines: [{ account: accId('6500'), debit: 250000 }, { account: accId('1000'), credit: 250000 }] },
    },
  };
}

test('the tiers resolve from the verb the rule fires, and a disabled or name-only write stays free', () => {
  const post = { tool: 'post_entry', inputTemplate: {} };
  assert.equal(dialCapabilityForCall('enable_automation_rule', { ruleId: 'r_1' }), 'customize');
  assert.equal(dialCapabilityForCall('create_automation_rule', { name: 'x', action: post }), 'post');
  assert.equal(dialCapabilityForCall('create_automation_rule', { name: 'x', action: { tool: 'issue_invoice', inputTemplate: {} } }), 'issue');
  assert.equal(dialCapabilityForCall('create_automation_rule', { name: 'x', action: { tool: 'tasks_create', inputTemplate: {} } }), 'customize');
  assert.equal(dialCapabilityForCall('create_automation_rule', { name: 'x', action: post, enabled: false }), undefined);
  assert.equal(dialCapabilityForCall('update_automation_rule', { ruleId: 'r_1', patch: { action: post } }), 'post');
  assert.equal(dialCapabilityForCall('update_automation_rule', { ruleId: 'r_1', patch: { condition: null } }), 'customize');
  assert.equal(dialCapabilityForCall('update_automation_rule', { ruleId: 'r_1', patch: { trigger: { event: 'contact.created' } } }), 'customize');
  assert.equal(dialCapabilityForCall('update_automation_rule', { ruleId: 'r_1', patch: { name: 'Neu' } }), undefined);
  for (const name of ['enable_automation_rule', 'create_automation_rule', 'update_automation_rule']) {
    assert.equal(typeof getAction(name).consequence, 'string', name);
  }
});

test('an agent enabling its own post_entry rule DRAFTS: the rule stays disabled and the next event posts nothing', () => {
  const deps = freshDeps();
  const { workspaceId, accId } = mintWorkspace(deps);
  const rule = mcp(deps, 'create_automation_rule', { workspaceId, ...postingRule(accId), enabled: false, idempotencyKey: 'a-rule' });
  assert.equal(rule.ok, true, JSON.stringify(rule));
  assert.notEqual(rule.drafted, true, 'composing a DISABLED rule lets nothing fire: free');
  const ruleId = rule.rule.ruleId;

  const enabled = mcp(deps, 'enable_automation_rule', { workspaceId, ruleId });
  assert.equal(enabled.drafted, true, JSON.stringify(enabled));
  // D141.5 R4-1: the seam reads the STORED rule, so the enable drafts at the tier of the verb it fires.
  assert.equal(enabled.dialCapability, 'post');
  assert.equal(ruleRow(deps, ruleId).enabled, 0);

  assert.equal(mcp(deps, 'create_contact', { workspaceId, partyRole: 'customer', name: 'Auslöser AG', idempotencyKey: 'a-c' }).ok, true);
  assert.equal(posted(deps, workspaceId), 0, 'no entry through a rule the agent enabled on its own');

  // The human approves: the replay runs as the human, and the rule fires from then on.
  assert.equal(human(deps, 'approve_drafted_action', { workspaceId, actionId: enabled.actionId }).ok, true);
  assert.equal(ruleRow(deps, ruleId).enabled, 1);
  deps.store.close();
});

test('an agent creating a rule that would start enabled DRAFTS at the tier of the verb it fires', () => {
  const deps = freshDeps();
  const { workspaceId, accId } = mintWorkspace(deps);
  const rules = () => deps.store.db.prepare('SELECT COUNT(*) AS n FROM automation_rule WHERE workspace_id = ?').get(workspaceId).n;
  const before = rules();
  const res = mcp(deps, 'create_automation_rule', { workspaceId, ...postingRule(accId), idempotencyKey: 'a-rule' });
  assert.equal(res.drafted, true, JSON.stringify(res));
  assert.equal(res.dialCapability, 'post');
  assert.equal(rules(), before, 'no rule was written');
  deps.store.close();
});

test('an agent repointing a HUMAN\'s enabled rule at post_entry DRAFTS; the rule keeps its old action', () => {
  const deps = freshDeps();
  const { workspaceId, accId } = mintWorkspace(deps);
  const rule = human(deps, 'create_automation_rule', {
    workspaceId,
    name: 'Nachfassen',
    trigger: { event: 'contact.created' },
    action: { tool: 'tasks_create', inputTemplate: { title: 'Begrüssen' } },
    idempotencyKey: 'h-rule',
  });
  assert.equal(rule.ok, true, JSON.stringify(rule));
  const ruleId = rule.rule.ruleId;
  assert.equal(ruleRow(deps, ruleId).enabled, 1, 'premise: the human rule is live');

  const repoint = mcp(deps, 'update_automation_rule', { workspaceId, ruleId, patch: { action: postingRule(accId).action }, idempotencyKey: 'a-up' });
  assert.equal(repoint.drafted, true, JSON.stringify(repoint));
  assert.equal(repoint.dialCapability, 'post');
  assert.equal(ruleRow(deps, ruleId).action_tool, 'tasks_create');

  const renamed = mcp(deps, 'update_automation_rule', { workspaceId, ruleId, patch: { name: 'Begrüssung' }, idempotencyKey: 'a-name' });
  assert.equal(renamed.ok, true, JSON.stringify(renamed));
  assert.notEqual(renamed.drafted, true, 'a rename changes nothing a rule does');
  deps.store.close();
});
