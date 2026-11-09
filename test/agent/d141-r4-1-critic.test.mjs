/**
 * Non-author critic, D141.5 / R4-1 (branch claude/d141-r4-1-rule-tier, 30.09.2026).
 *
 * Adversarial probes against `governedDialCapability` (`src/core/agent/ruleTier.ts`) and the surfaces
 * that describe what a human grants. The record is `docs/critique/d141-r4-1-critique.md`.
 *
 * The first block (F1) FAILS on the author's code: the Pendenzen hub recomputes the Vorschlag's
 * consequence from the input alone, so it tells the approver one tier while "Genehmigen und künftig
 * automatisch" grants another. Every other test here passes on the author's code and pins a door the
 * critic tried and found shut.
 *
 * Every fixture is synthetic by construction (invented names, invented amounts).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { callTool } from '../../dist/api/mcp.js';
import { getAction } from '../../dist/api/registry.js';
import { resolveServedActor } from '../../dist/api/session.js';
import { makeContext } from '../../dist/core/context.js';
import { dialCapabilityForCall, governedDialCapability } from '../../dist/core/agent/index.js';
import { effectiveDialLevel, dialCapabilityIsForceAsk } from '../../dist/core/agent/dial.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';

const mcp = (deps, name, args) => JSON.parse(callTool(deps, name, args).content[0].text);
const asHuman = (deps) => ({ ...deps, actor: 'studio' });
const human = (deps, name, input) => getAction(name).run(asHuman(deps), input);
const posted = (deps, ws) =>
  deps.store.db.prepare("SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ? AND status = 'posted'").get(ws).n;
const ruleRow = (deps, id) =>
  deps.store.db.prepare('SELECT enabled, action_tool, action_input FROM automation_rule WHERE id = ?').get(id);

let grantSeq = 0;
function setDial(deps, workspaceId, levels) {
  for (const [capability, level] of Object.entries(levels)) {
    const res = human(deps, 'set_agent_dial', { workspaceId, capability, level, idempotencyKey: `crit-dial-${++grantSeq}` });
    assert.equal(res.ok, true, JSON.stringify(res));
  }
}

function postingAction(accId, amount = 180000) {
  return {
    tool: 'post_entry',
    inputTemplate: {
      date: '2026-07-16',
      description: 'Kritikerbuchung',
      source: 'manual',
      lines: [{ account: accId('6500'), debit: amount }, { account: accId('1000'), credit: amount }],
    },
  };
}

let rawSeq = 0;
function storeRule(deps, workspaceId, { tool, template = {}, enabled = 0, event = 'contact.created', createdBy = 'studio' }) {
  const id = `arule_crit_${++rawSeq}`;
  deps.store.db
    .prepare(
      `INSERT INTO automation_rule
         (id, workspace_id, name, trigger_event, condition, action_tool, action_input, enabled, archived, created_by, last_fired_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'null', ?, ?, ?, 0, ?, NULL, ?, ?)`,
    )
    .run(id, workspaceId, `Kritikerregel ${tool}`, event, tool, JSON.stringify(template), enabled, createdBy, deps.clock.now(), deps.clock.now());
  return id;
}

let contactSeq = 0;
function fireContactCreated(deps, workspaceId) {
  const res = human(deps, 'create_contact', { workspaceId, partyRole: 'customer', name: `Kritiker ${++contactSeq} AG`, idempotencyKey: `crit-c-${contactSeq}` });
  assert.equal(res.ok, true, JSON.stringify(res));
}

function hubItem(deps, workspaceId, actionId) {
  const res = human(deps, 'attention_list', { workspaceId, queueId: 'agent_action', limit: 50 });
  assert.equal(res.ok, true, JSON.stringify(res));
  const item = res.items.find((i) => i.entityId === actionId);
  assert.ok(item !== undefined, `the Vorschlag ${actionId} is not in the hub: ${JSON.stringify(res.items.map((i) => i.entityId))}`);
  return item;
}

// --- F1: the hub describes a different grant than the one "künftig automatisch" writes -------------

test('F1a: an enable drafted under post shows the POST consequence in the hub, the tier "künftig automatisch" then grants', () => {
  const deps = freshDeps();
  const { workspaceId, accId } = mintWorkspace(deps);
  setDial(deps, workspaceId, { customize: 'auto' });
  const created = mcp(deps, 'create_automation_rule', {
    workspaceId, name: 'Buchen', trigger: { event: 'contact.created' }, action: postingAction(accId), enabled: false, idempotencyKey: 'f1a-rule',
  });
  assert.equal(created.ok, true, JSON.stringify(created));
  const enabled = mcp(deps, 'enable_automation_rule', { workspaceId, ruleId: created.rule.ruleId });
  assert.equal(enabled.drafted, true, JSON.stringify(enabled));
  assert.equal(enabled.dialCapability, 'post');

  const item = hubItem(deps, workspaceId, enabled.actionId);
  const allow = item.decisionOptions.find((o) => o.id === 'approve_allow');
  assert.ok(allow !== undefined);
  // What the approver is told in the hub must be what the grant arm writes.
  assert.equal(
    item.consequenceKey,
    'agent.consequence.post',
    `the hub tells the approver "${item.consequenceKey}" while approve_allow grants post=auto`,
  );

  const approved = human(deps, allow.verb, { workspaceId, ...allow.input });
  assert.equal(approved.ok, true, JSON.stringify(approved));
  assert.deepEqual(approved.granted, { capability: 'post', level: 'auto' });
  deps.store.close();
});

test('F1b: a template-only patch drafted under post shows the POST consequence in the hub', () => {
  const deps = freshDeps();
  const { workspaceId, accId } = mintWorkspace(deps);
  const created = human(deps, 'create_automation_rule', {
    workspaceId, name: 'Kontakt verbuchen', trigger: { event: 'contact.created' }, action: postingAction(accId), idempotencyKey: 'f1b-h',
  });
  assert.equal(created.ok, true, JSON.stringify(created));
  setDial(deps, workspaceId, { customize: 'auto' });
  const patched = mcp(deps, 'update_automation_rule', {
    workspaceId, ruleId: created.rule.ruleId, patch: { action: { inputTemplate: postingAction(accId, 9_990_000).inputTemplate } }, idempotencyKey: 'f1b-up',
  });
  assert.equal(patched.drafted, true, JSON.stringify(patched));
  assert.equal(patched.dialCapability, 'post');
  const item = hubItem(deps, workspaceId, patched.actionId);
  assert.equal(item.consequenceKey, 'agent.consequence.post', `hub says ${item.consequenceKey}, the grant is post`);
  deps.store.close();
});

test('F1c: a create drafted under the customize FLOOR (post=auto) shows the CUSTOMIZE consequence in the hub', () => {
  const deps = freshDeps();
  const { workspaceId, accId } = mintWorkspace(deps);
  setDial(deps, workspaceId, { post: 'auto' });
  const create = mcp(deps, 'create_automation_rule', {
    workspaceId, name: 'Sofort', trigger: { event: 'contact.created' }, action: postingAction(accId), idempotencyKey: 'f1c-create',
  });
  assert.equal(create.drafted, true, JSON.stringify(create));
  assert.equal(create.dialCapability, 'customize');
  const item = hubItem(deps, workspaceId, create.actionId);
  assert.equal(item.consequenceKey, 'agent.consequence.customize', `hub says ${item.consequenceKey}, the grant is customize`);
  deps.store.close();
});

// --- The "stricter only" claim, exhaustively over the dial ---------------------------------------

const drafts = (ctx, cap) => cap !== undefined && (dialCapabilityIsForceAsk(ctx, cap) || effectiveDialLevel(ctx, cap).effective !== 'auto');

test('stricter only: over every dial setting of the tiers involved, the resolver never executes a call the input-only tier would draft', () => {
  const deps = freshDeps();
  const { workspaceId, accId } = mintWorkspace(deps);
  const postRule = storeRule(deps, workspaceId, { tool: 'post_entry', template: postingAction(accId).inputTemplate, enabled: 1 });
  const templated = storeRule(deps, workspaceId, { tool: 'transition_document', template: { documentId: '{{result.document.id}}', to: '{{input.to}}' } });
  const attestRule = storeRule(deps, workspaceId, { tool: 'checklist_item_complete', template: { runId: 'r', itemKey: 'i', evidence: { kind: '{{input.kind}}' } } });
  const calls = [
    ['enable_automation_rule', { workspaceId, ruleId: postRule }],
    ['enable_automation_rule', { workspaceId, ruleId: templated }],
    ['enable_automation_rule', { workspaceId, ruleId: attestRule }],
    ['enable_automation_rule', { workspaceId, ruleId: 'arule_missing' }],
    ['update_automation_rule', { workspaceId, ruleId: postRule, patch: { condition: null } }],
    ['update_automation_rule', { workspaceId, ruleId: postRule, patch: { action: { tool: 'tasks_create' } } }],
    ['update_automation_rule', { workspaceId, ruleId: templated, patch: { action: { tool: 'post_entry' } } }],
    ['update_automation_rule', { workspaceId, ruleId: 'arule_missing', patch: { action: postingAction(accId) } }],
    ['create_automation_rule', { workspaceId, name: 'x', trigger: { event: 'contact.created' }, action: postingAction(accId) }],
    ['create_automation_rule', { workspaceId, name: 'x', trigger: { event: 'contact.created' }, action: { tool: 'tasks_create', inputTemplate: {} } }],
    ['post_entry', { workspaceId }],
  ];
  const tiers = ['customize', 'post', 'issue', 'pay'];
  for (let mask = 0; mask < 1 << tiers.length; mask += 1) {
    const levels = Object.fromEntries(tiers.map((t, i) => [t, mask & (1 << i) ? 'auto' : 'ask']));
    setDial(deps, workspaceId, levels);
    const ctx = makeContext(deps.store, { workspaceId, actor: 'agent', clock: deps.clock, ids: deps.ids });
    for (const [name, input] of calls) {
      const before = dialCapabilityForCall(name, input);
      const after = governedDialCapability(ctx, name, input);
      if (drafts(ctx, before)) {
        assert.ok(drafts(ctx, after), `${name} ${JSON.stringify(input.patch ?? input.ruleId ?? '')} at ${JSON.stringify(levels)}: input-only ${before} drafts, resolver ${after} does not`);
      }
    }
  }
  deps.store.close();
});

// --- Placeholder templates ---------------------------------------------------------------------

test('placeholders: a NESTED or whole-value template of an input-keyed field drafts at every tier it could resolve to', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  setDial(deps, workspaceId, { customize: 'auto', post: 'auto' });
  // checklist_item_complete's tier is keyed on evidence.kind: a placeholder there may become the
  // ePortal attestation (vat-file, a strong-default ask) at fire time.
  const nested = storeRule(deps, workspaceId, { tool: 'checklist_item_complete', template: { runId: 'run_x', itemKey: 'eportal_filed', evidence: { kind: '{{input.kind}}' } } });
  const one = mcp(deps, 'enable_automation_rule', { workspaceId, ruleId: nested });
  assert.equal(one.drafted, true, JSON.stringify(one));
  assert.equal(one.dialCapability, 'vat-file');
  // A whole-value placeholder for the whole object (type-preserving at fire time) is caught too.
  const whole = storeRule(deps, workspaceId, { tool: 'checklist_item_complete', template: { runId: 'run_x', itemKey: 'eportal_filed', evidence: '{{input.evidence}}' } });
  const two = mcp(deps, 'enable_automation_rule', { workspaceId, ruleId: whole });
  assert.equal(two.drafted, true, JSON.stringify(two));
  assert.equal(two.dialCapability, 'vat-file');
  // A placeholder inside an ARRAY element is walked as well.
  const arr = storeRule(deps, workspaceId, { tool: 'transition_document', template: { documentId: 'doc_x', to: 'sent', notes: ['{{input.x}}'] } });
  setDial(deps, workspaceId, { issue: 'ask' });
  const three = mcp(deps, 'enable_automation_rule', { workspaceId, ruleId: arr });
  assert.equal(three.drafted, true, JSON.stringify(three));
  deps.store.close();
});

test('placeholders: a tool-only patch onto a stored template holding a placeholder reads the STORED placeholder', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  setDial(deps, workspaceId, { customize: 'auto', post: 'auto', issue: 'auto' });
  const rule = storeRule(deps, workspaceId, { tool: 'tasks_create', template: { runId: 'run_x', itemKey: 'eportal_filed', evidence: { kind: '{{input.kind}}' } }, enabled: 1 });
  const res = mcp(deps, 'update_automation_rule', { workspaceId, ruleId: rule, patch: { action: { tool: 'checklist_item_complete' } }, idempotencyKey: 'ph-tool' });
  assert.equal(res.drafted, true, JSON.stringify(res));
  assert.equal(res.dialCapability, 'vat-file');
  assert.equal(ruleRow(deps, rule).action_tool, 'tasks_create');
  deps.store.close();
});

// --- Retry reads the RUN, not the (since repointed) rule ------------------------------------------

test('retry: a stuck post_entry run drafts at post even after its rule was repointed to a harmless tool and archived', () => {
  const deps = freshDeps();
  const { workspaceId, accId } = mintWorkspace(deps);
  const created = human(deps, 'create_automation_rule', {
    workspaceId, name: 'Kontakt verbuchen', trigger: { event: 'contact.created' }, action: postingAction(accId), idempotencyKey: 'rt-h',
  });
  const ruleId = created.rule.ruleId;
  fireContactCreated(deps, workspaceId);
  assert.equal(posted(deps, workspaceId), 1);
  const run = deps.store.db.prepare('SELECT id, action_input FROM automation_run WHERE workspace_id = ? AND rule_id = ?').get(workspaceId, ruleId);
  const input = { ...JSON.parse(run.action_input), idempotencyKey: 'crit-never-committed' };
  deps.store.db.prepare("UPDATE automation_run SET status = 'running', error_code = NULL, action_input = ? WHERE id = ?").run(JSON.stringify(input), run.id);
  assert.equal(human(deps, 'update_automation_rule', { workspaceId, ruleId, patch: { action: { tool: 'tasks_create', inputTemplate: { title: 'Nachfassen' } } }, idempotencyKey: 'rt-rp' }).ok, true);
  assert.equal(human(deps, 'archive_automation_rule', { workspaceId, ruleId }).ok, true);

  setDial(deps, workspaceId, { customize: 'auto' });
  const retried = mcp(deps, 'retry_automation_run', { workspaceId, runId: run.id });
  assert.equal(retried.drafted, true, JSON.stringify(retried));
  assert.equal(retried.dialCapability, 'post');
  assert.equal(posted(deps, workspaceId), 1);
  deps.store.close();
});

test('retry: §H-TENANT, a stuck run of ANOTHER workspace is not read, not retried and posts nothing', () => {
  const deps = freshDeps();
  const a = mintWorkspace(deps, 'Alpha Kritik GmbH', 'crit-ws-a');
  const b = mintWorkspace(deps, 'Beta Kritik GmbH', 'crit-ws-b');
  const created = human(deps, 'create_automation_rule', {
    workspaceId: b.workspaceId, name: 'Beta buchen', trigger: { event: 'contact.created' }, action: postingAction(b.accId), idempotencyKey: 'rt-b',
  });
  fireContactCreated(deps, b.workspaceId);
  const run = deps.store.db.prepare('SELECT id, action_input FROM automation_run WHERE rule_id = ?').get(created.rule.ruleId);
  const input = { ...JSON.parse(run.action_input), idempotencyKey: 'crit-foreign' };
  deps.store.db.prepare("UPDATE automation_run SET status = 'running', error_code = NULL, action_input = ? WHERE id = ?").run(JSON.stringify(input), run.id);
  setDial(deps, a.workspaceId, { customize: 'auto', post: 'auto' });
  const before = posted(deps, b.workspaceId);
  const res = mcp(deps, 'retry_automation_run', { workspaceId: a.workspaceId, runId: run.id });
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.equal(res.error, 'not_found');
  assert.equal(posted(deps, b.workspaceId), before);
  deps.store.close();
});

// --- A bound agent seat is a governed seat: the engine belt and the dial both hold ----------------

test('bound agent seat (user.kind agent, owner role): its rule lands disabled in the engine, and every create and repoint door drafts at the fired tier', () => {
  const deps = freshDeps();
  const { workspaceId, accId } = mintWorkspace(deps);
  const invite = human(deps, 'invite_member', { workspaceId, email: 'bot@kritik.example', role: 'owner', kind: 'agent', idempotencyKey: 'crit-inv-bot' });
  assert.equal(invite.ok, true, JSON.stringify(invite));
  const served = () => {
    const id = resolveServedActor(deps.store, 'bot@kritik.example');
    return { ...deps, actor: id.actor, subject: id.subject, identitySource: id.identitySource };
  };
  assert.equal(getAction('accept_invite').run(served(), { token: invite.token }).ok, true);
  const bot = served();
  setDial(deps, workspaceId, { customize: 'auto' });

  const create = mcp(bot, 'create_automation_rule', {
    workspaceId, name: 'Bot bucht', trigger: { event: 'contact.created' }, action: postingAction(accId), idempotencyKey: 'bot-create',
  });
  assert.equal(create.drafted, true, JSON.stringify(create));
  assert.equal(create.dialCapability, 'post');
  // A bot rule composed disabled and then re-pointed/enabled: every door drafts at post.
  const disabled = mcp(bot, 'create_automation_rule', {
    workspaceId, name: 'Bot Aufgabe', trigger: { event: 'contact.created' }, action: { tool: 'tasks_create', inputTemplate: { title: 'x' } }, idempotencyKey: 'bot-create-2',
  });
  assert.equal(disabled.ok, true, JSON.stringify(disabled));
  // D156 follow-up: rules.ts reads the ONE governed-seat rule now, so a bound agent seat's rule lands
  // DISABLED like the local agent's (the P8 belt). Until then this line pinned the opposite premise.
  assert.equal(disabled.rule.enabled, false, 'a bound agent seat is not humanAuthored in rules.ts: its rule lands disabled');
  const repoint = mcp(bot, 'update_automation_rule', { workspaceId, ruleId: disabled.rule.ruleId, patch: { action: postingAction(accId) }, idempotencyKey: 'bot-rp' });
  assert.equal(repoint.drafted, true, JSON.stringify(repoint));
  assert.equal(repoint.dialCapability, 'post');
  fireContactCreated(deps, workspaceId);
  assert.equal(posted(deps, workspaceId), 0, 'the bot made a rule post without a Vorschlag');
  deps.store.close();
});

// --- Drafting a rule write never leaves the rule in a half state -----------------------------------

test('create with an explicit enabled:null is governed like the default (the engine reads null as enabled)', () => {
  const deps = freshDeps();
  const { workspaceId, accId } = mintWorkspace(deps);
  setDial(deps, workspaceId, { customize: 'auto' });
  const res = mcp(deps, 'create_automation_rule', {
    workspaceId, name: 'Null', trigger: { event: 'contact.created' }, action: postingAction(accId), enabled: null, idempotencyKey: 'null-en',
  });
  // Either the boundary refuses the null, or the call drafts; it must never execute an enabled posting rule.
  if (res.ok === true) assert.equal(res.drafted, true, JSON.stringify(res));
  const live = deps.store.db.prepare("SELECT COUNT(*) AS n FROM automation_rule WHERE workspace_id = ? AND enabled = 1 AND action_tool = 'post_entry'").get(workspaceId).n;
  assert.equal(live, 0);
  deps.store.close();
});
