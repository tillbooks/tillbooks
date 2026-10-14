/**
 * D141.5, critic R4-1: granting `customize` must not grant rule-driven posting, issuing or paying.
 *
 * THE DEFECT. `enable_automation_rule`, and an `update_automation_rule` patch that names no `tool`
 * (a template, a trigger or a condition only), resolved their dial tier from the INPUT alone and fell
 * back to `customize`. A G01 rule fires its verb as its author, internally, outside the seam. So with
 * `customize` at `auto` and `post` at `ask`, an agent seat enabled a `post_entry` rule, or rewrote the
 * template of a human's live one, with no Vorschlag, and the next event posted.
 *
 * THE FIX, at ONE chokepoint: the transport seam picks every write's tier through
 * `governedDialCapability` (`src/core/agent/ruleTier.ts`), which for a rule-family write reads the
 * STORED rule, lays the write's own values over it the way the engine merges them, and takes the first
 * candidate that would draft among the fired verb's tier(s) and the `customize` floor.
 *
 * HOW IT BITES. Point the gate back at `dialCapabilityForCall` (or drop a kind from `RULE_FIRING_WRITES`)
 * and the enable/patch/retry tests below find the rule enabled or rewritten and the entry posted. Drop
 * the floor and the `post=auto, customize=ask` test executes. Drop the placeholder branch and the
 * templated `transition_document` rule enables at `customize=auto` with no Vorschlag.
 *
 * Every fixture is synthetic by construction (invented names, invented amounts).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { callTool } from '../../dist/api/mcp.js';
import { ACTIONS, getAction } from '../../dist/api/registry.js';
import { requiredCapabilitiesFor } from '../../dist/core/access/index.js';
import { isNotAutomatable } from '../../dist/core/automation/denylist.js';
import {
  DIAL_CAPABILITY_FOR_ACTION,
  RULE_FIRING_WRITES,
  RULE_WRITES_NOT_TIERED,
} from '../../dist/core/agent/index.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';

const mcp = (deps, name, args) => JSON.parse(callTool(deps, name, args).content[0].text);
const asHuman = (deps) => ({ ...deps, actor: 'studio' });
const human = (deps, name, input) => getAction(name).run(asHuman(deps), input);
const posted = (deps, ws) =>
  deps.store.db.prepare("SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ? AND status = 'posted'").get(ws).n;
const ruleRow = (deps, id) =>
  deps.store.db.prepare('SELECT enabled, trigger_event, condition, action_tool, action_input FROM automation_rule WHERE id = ?').get(id);

let grantSeq = 0;
/** The D103 ceremony: a HUMAN sets one dial row (the agent seat may never write its own dial). */
function setDial(deps, workspaceId, levels) {
  for (const [capability, level] of Object.entries(levels)) {
    const res = human(deps, 'set_agent_dial', { workspaceId, capability, level, idempotencyKey: `dial-${++grantSeq}` });
    assert.equal(res.ok, true, JSON.stringify(res));
  }
}

function postingAction(accId, amount = 250000) {
  return {
    tool: 'post_entry',
    inputTemplate: {
      date: '2026-07-16',
      description: 'Regelbuchung',
      source: 'manual',
      lines: [{ account: accId('6500'), debit: amount }, { account: accId('1000'), credit: amount }],
    },
  };
}

/** A human's rule, created through the registry (validated exactly as the Studio creates it). */
function humanPostingRule(deps, workspaceId, accId, { enabled = true, key = 'h-rule' } = {}) {
  const res = human(deps, 'create_automation_rule', {
    workspaceId,
    name: 'Kontakt verbuchen',
    trigger: { event: 'contact.created' },
    action: postingAction(accId),
    enabled,
    idempotencyKey: key,
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  return res.rule.ruleId;
}

let rawSeq = 0;
/** A stored rule row for any tool, authored by a human, for the verbs no fixture can cheaply compose. */
function storeRule(deps, workspaceId, { tool, template = {}, enabled = 0, event = 'contact.created' }) {
  const id = `arule_raw_${++rawSeq}`;
  deps.store.db
    .prepare(
      `INSERT INTO automation_rule
         (id, workspace_id, name, trigger_event, condition, action_tool, action_input, enabled, archived, created_by, last_fired_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'null', ?, ?, ?, 0, 'studio', NULL, ?, ?)`,
    )
    .run(id, workspaceId, `Regel ${tool}`, event, tool, JSON.stringify(template), enabled, deps.clock.now(), deps.clock.now());
  return id;
}

let contactSeq = 0;
function fireContactCreated(deps, workspaceId) {
  const res = human(deps, 'create_contact', { workspaceId, partyRole: 'customer', name: `Auslöser ${++contactSeq} AG`, idempotencyKey: `c-${contactSeq}` });
  assert.equal(res.ok, true, JSON.stringify(res));
}

// --- The two R4-1 paths D141.5 names ------------------------------------------------------------

test('R4-1 path 1: customize=auto, post=ask: the agent ENABLING a post_entry rule drafts under post, and nothing posts', () => {
  const deps = freshDeps();
  const { workspaceId, accId } = mintWorkspace(deps);
  setDial(deps, workspaceId, { customize: 'auto' });

  const created = mcp(deps, 'create_automation_rule', {
    workspaceId, name: 'Buchen', trigger: { event: 'contact.created' }, action: postingAction(accId), enabled: false, idempotencyKey: 'a-rule',
  });
  assert.equal(created.ok, true, JSON.stringify(created));
  assert.notEqual(created.drafted, true, 'a rule composed DISABLED fires nothing and stays free');
  const ruleId = created.rule.ruleId;

  const enabled = mcp(deps, 'enable_automation_rule', { workspaceId, ruleId });
  assert.equal(enabled.drafted, true, `customize=auto must not enable a posting rule: ${JSON.stringify(enabled)}`);
  assert.equal(enabled.dialCapability, 'post');
  assert.equal(ruleRow(deps, ruleId).enabled, 0);

  fireContactCreated(deps, workspaceId);
  assert.equal(posted(deps, workspaceId), 0, 'an entry posted through a rule the agent enabled under customize');

  // The human approves the Vorschlag: the replay runs as the human and the rule fires from then on.
  assert.equal(human(deps, 'approve_drafted_action', { workspaceId, actionId: enabled.actionId }).ok, true);
  assert.equal(ruleRow(deps, ruleId).enabled, 1);
  fireContactCreated(deps, workspaceId);
  assert.equal(posted(deps, workspaceId), 1);
  deps.store.close();
});

test('R4-1 path 2: customize=auto, post=ask: a patch with no tool (template, trigger or condition) on a human\'s LIVE post_entry rule drafts under post', () => {
  const deps = freshDeps();
  const { workspaceId, accId } = mintWorkspace(deps);
  const ruleId = humanPostingRule(deps, workspaceId, accId);
  setDial(deps, workspaceId, { customize: 'auto' });
  const before = ruleRow(deps, ruleId);
  assert.equal(before.enabled, 1, 'premise: the human rule is live');

  const patches = {
    template: { action: { inputTemplate: postingAction(accId, 9_900_000).inputTemplate } },
    trigger: { trigger: { event: 'invoice.issued' } },
    condition: { condition: { all: [{ field: 'result.contact.partyRole', op: 'eq', value: 'customer' }] } },
    'empty action object': { action: {} },
  };
  for (const [label, patch] of Object.entries(patches)) {
    const res = mcp(deps, 'update_automation_rule', { workspaceId, ruleId, patch, idempotencyKey: `a-up-${label}` });
    assert.equal(res.drafted, true, `${label}: ${JSON.stringify(res)}`);
    assert.equal(res.dialCapability, 'post', label);
  }
  assert.deepEqual(ruleRow(deps, ruleId), before, 'the live rule was rewritten without a Vorschlag');

  // A rename still changes nothing a rule does, so it stays free.
  const renamed = mcp(deps, 'update_automation_rule', { workspaceId, ruleId, patch: { name: 'Umbenannt' }, idempotencyKey: 'a-name' });
  assert.equal(renamed.ok, true, JSON.stringify(renamed));
  assert.notEqual(renamed.drafted, true);
  deps.store.close();
});

// --- Every tier, every automatable governed verb --------------------------------------------------

test('customize=auto grants no other tier: enabling a rule that fires ANY automatable governed verb drafts at that verb\'s tier', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  setDial(deps, workspaceId, { customize: 'auto' });
  let covered = 0;
  const tiers = new Set();
  for (const [tool, tier] of Object.entries(DIAL_CAPABILITY_FOR_ACTION)) {
    if (isNotAutomatable(tool)) continue;
    const ruleId = storeRule(deps, workspaceId, { tool });
    const res = mcp(deps, 'enable_automation_rule', { workspaceId, ruleId });
    if (tier === 'customize') {
      // The fired verb's own tier IS the granted one: full auto for it, exactly as intended.
      assert.notEqual(res.drafted, true, `${tool}: ${JSON.stringify(res)}`);
      assert.equal(ruleRow(deps, ruleId).enabled, 1, tool);
      continue;
    }
    assert.equal(res.drafted, true, `${tool} (${tier}): ${JSON.stringify(res)}`);
    assert.equal(res.dialCapability, tier, tool);
    assert.equal(ruleRow(deps, ruleId).enabled, 0, tool);
    covered += 1;
    tiers.add(tier);
  }
  // The brief's tiers are all reachable by a rule today: post, issue, send, pay (and dun, close-period).
  for (const t of ['post', 'issue', 'send', 'pay']) assert.ok(tiers.has(t), `no automatable ${t} verb exercised`);
  assert.ok(covered >= 20, `only ${covered} verbs exercised`);
  deps.store.close();
});

test('customize=auto grants no other tier: a template-only patch of a live rule that fires issue, send or pay drafts at that tier', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  setDial(deps, workspaceId, { customize: 'auto' });
  for (const [tool, tier] of [['issue_invoice', 'issue'], ['send_invoice', 'send'], ['expense_claim_reimburse', 'pay'], ['issue_dunning_run', 'dun']]) {
    const ruleId = storeRule(deps, workspaceId, { tool, template: { note: 'alt' }, enabled: 1 });
    const res = mcp(deps, 'update_automation_rule', { workspaceId, ruleId, patch: { action: { inputTemplate: { note: 'neu' } } }, idempotencyKey: `tpl-${tool}` });
    assert.equal(res.drafted, true, `${tool}: ${JSON.stringify(res)}`);
    assert.equal(res.dialCapability, tier, tool);
    assert.equal(JSON.parse(ruleRow(deps, ruleId).action_input).note, 'alt', tool);
  }
  deps.store.close();
});

// --- Input-keyed verbs: the merged and the templated input ---------------------------------------

test('a template-only patch that turns a live transition_document rule\'s edge to `issued` drafts under issue (the merge is the engine\'s)', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  setDial(deps, workspaceId, { customize: 'auto' });
  const ruleId = storeRule(deps, workspaceId, { tool: 'transition_document', template: { documentId: 'doc_fix', to: 'sent' }, enabled: 1 });
  const res = mcp(deps, 'update_automation_rule', {
    workspaceId, ruleId, patch: { action: { inputTemplate: { documentId: 'doc_fix', to: 'issued' } } }, idempotencyKey: 'td-issued',
  });
  assert.equal(res.drafted, true, JSON.stringify(res));
  assert.equal(res.dialCapability, 'issue');
  assert.equal(JSON.parse(ruleRow(deps, ruleId).action_input).to, 'sent');

  // The other half of the engine's merge: a patch naming only the TOOL keeps the stored template, so
  // repointing a rule whose stored template already says `to: 'issued'` at transition_document issues.
  const tplRule = storeRule(deps, workspaceId, { tool: 'tasks_create', template: { documentId: 'doc_fix', to: 'issued' }, enabled: 1 });
  const toolOnly = mcp(deps, 'update_automation_rule', {
    workspaceId, ruleId: tplRule, patch: { action: { tool: 'transition_document' } }, idempotencyKey: 'td-tool-only',
  });
  assert.equal(toolOnly.drafted, true, JSON.stringify(toolOnly));
  assert.equal(toolOnly.dialCapability, 'issue');
  assert.equal(ruleRow(deps, tplRule).action_tool, 'tasks_create');

  // The stored non-posting edge itself is not a money verb: enabling a `sent` rule at customize=auto runs.
  const sentRule = storeRule(deps, workspaceId, { tool: 'transition_document', template: { documentId: 'doc_fix', to: 'sent' } });
  const enabled = mcp(deps, 'enable_automation_rule', { workspaceId, ruleId: sentRule });
  assert.notEqual(enabled.drafted, true, JSON.stringify(enabled));
  deps.store.close();
});

test('a TEMPLATED edge cannot be resolved before the event, so it drafts at every tier it could reach', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  const templated = { documentId: '{{result.document.id}}', to: '{{payload.to}}' };

  setDial(deps, workspaceId, { customize: 'auto' });
  const a = storeRule(deps, workspaceId, { tool: 'transition_document', template: templated });
  const one = mcp(deps, 'enable_automation_rule', { workspaceId, ruleId: a });
  assert.equal(one.drafted, true, JSON.stringify(one));
  assert.equal(one.dialCapability, 'issue');

  // With issue granted too, the cancel edge (a reversing posting) still holds it at post.
  setDial(deps, workspaceId, { issue: 'auto' });
  const two = mcp(deps, 'enable_automation_rule', { workspaceId, ruleId: a });
  assert.equal(two.drafted, true, JSON.stringify(two));
  assert.equal(two.dialCapability, 'post');

  setDial(deps, workspaceId, { post: 'auto' });
  const three = mcp(deps, 'enable_automation_rule', { workspaceId, ruleId: a });
  assert.notEqual(three.drafted, true, `every tier granted: the enable runs. ${JSON.stringify(three)}`);
  assert.equal(ruleRow(deps, a).enabled, 1);
  deps.store.close();
});

// --- Sibling paths ----------------------------------------------------------------------------

test('sibling: pausing is free, and RE-ENABLING a paused human post_entry rule drafts under post', () => {
  const deps = freshDeps();
  const { workspaceId, accId } = mintWorkspace(deps);
  const ruleId = humanPostingRule(deps, workspaceId, accId);
  setDial(deps, workspaceId, { customize: 'auto' });

  const paused = mcp(deps, 'disable_automation_rule', { workspaceId, ruleId });
  assert.equal(paused.ok, true, JSON.stringify(paused));
  assert.notEqual(paused.drafted, true, 'the stop button never drafts');
  assert.equal(ruleRow(deps, ruleId).enabled, 0);

  const resumed = mcp(deps, 'enable_automation_rule', { workspaceId, ruleId });
  assert.equal(resumed.drafted, true, JSON.stringify(resumed));
  assert.equal(resumed.dialCapability, 'post');
  assert.equal(ruleRow(deps, ruleId).enabled, 0);
  fireContactCreated(deps, workspaceId);
  assert.equal(posted(deps, workspaceId), 0);

  const archived = mcp(deps, 'archive_automation_rule', { workspaceId, ruleId });
  assert.notEqual(archived.drafted, true, 'archiving is a stop direction too');
  deps.store.close();
});

test('sibling: retry_automation_run re-drives a stuck post_entry firing only at post; customize=auto does not carry it', () => {
  const deps = freshDeps();
  const { workspaceId, accId } = mintWorkspace(deps);
  const ruleId = humanPostingRule(deps, workspaceId, accId);
  fireContactCreated(deps, workspaceId);
  assert.equal(posted(deps, workspaceId), 1, 'premise: the human rule fired once');

  // The state a process death between the claim and the invocation leaves: a `running` row whose
  // input never committed (a fresh key, so a re-drive really would post).
  const run = deps.store.db.prepare('SELECT id, action_input FROM automation_run WHERE workspace_id = ? AND rule_id = ?').get(workspaceId, ruleId);
  const input = { ...JSON.parse(run.action_input), idempotencyKey: 'never-committed' };
  deps.store.db.prepare("UPDATE automation_run SET status = 'running', error_code = NULL, action_input = ? WHERE id = ?").run(JSON.stringify(input), run.id);

  setDial(deps, workspaceId, { customize: 'auto' });
  const retried = mcp(deps, 'retry_automation_run', { workspaceId, runId: run.id });
  assert.equal(retried.drafted, true, JSON.stringify(retried));
  assert.equal(retried.dialCapability, 'post');
  assert.equal(posted(deps, workspaceId), 1, 'the retry posted with no Vorschlag');

  setDial(deps, workspaceId, { post: 'auto' });
  const granted = mcp(deps, 'retry_automation_run', { workspaceId, runId: run.id, idempotencyKey: 'retry-granted' });
  assert.equal(granted.ok, true, JSON.stringify(granted));
  assert.notEqual(granted.drafted, true);
  assert.equal(posted(deps, workspaceId), 2, 'post granted: the retry finishes the firing');
  deps.store.close();
});

// --- customize is a FLOOR ------------------------------------------------------------------------

test('customize is a floor: post=auto, customize=ask drafts the enable, the tool patch and the enabled create under customize', () => {
  const deps = freshDeps();
  const { workspaceId, accId } = mintWorkspace(deps);
  setDial(deps, workspaceId, { post: 'auto' });

  const disabledRule = mcp(deps, 'create_automation_rule', {
    workspaceId, name: 'Buchen', trigger: { event: 'contact.created' }, action: postingAction(accId), enabled: false, idempotencyKey: 'f-rule',
  });
  const ruleId = disabledRule.rule.ruleId;
  const enabled = mcp(deps, 'enable_automation_rule', { workspaceId, ruleId });
  assert.equal(enabled.drafted, true, JSON.stringify(enabled));
  assert.equal(enabled.dialCapability, 'customize');

  const humanRule = human(deps, 'create_automation_rule', {
    workspaceId, name: 'Nachfassen', trigger: { event: 'contact.created' }, action: { tool: 'tasks_create', inputTemplate: { title: 'Begrüssen' } }, idempotencyKey: 'f-h',
  });
  const repoint = mcp(deps, 'update_automation_rule', { workspaceId, ruleId: humanRule.rule.ruleId, patch: { action: postingAction(accId) }, idempotencyKey: 'f-up' });
  assert.equal(repoint.drafted, true, JSON.stringify(repoint));
  assert.equal(repoint.dialCapability, 'customize');

  const create = mcp(deps, 'create_automation_rule', {
    workspaceId, name: 'Sofort', trigger: { event: 'contact.created' }, action: postingAction(accId), idempotencyKey: 'f-create',
  });
  assert.equal(create.drafted, true, JSON.stringify(create));
  assert.equal(create.dialCapability, 'customize');
  deps.store.close();
});

test('full auto (customize and post granted): the agent enables its posting rule and the rule fires', () => {
  const deps = freshDeps();
  const { workspaceId, accId } = mintWorkspace(deps);
  setDial(deps, workspaceId, { customize: 'auto', post: 'auto' });
  const created = mcp(deps, 'create_automation_rule', {
    workspaceId, name: 'Buchen', trigger: { event: 'contact.created' }, action: postingAction(accId), enabled: false, idempotencyKey: 'fa-rule',
  });
  const enabled = mcp(deps, 'enable_automation_rule', { workspaceId, ruleId: created.rule.ruleId });
  assert.equal(enabled.ok, true, JSON.stringify(enabled));
  assert.notEqual(enabled.drafted, true);
  assert.equal(ruleRow(deps, created.rule.ruleId).enabled, 1);
  fireContactCreated(deps, workspaceId);
  assert.equal(posted(deps, workspaceId), 1);
  deps.store.close();
});

test('the default ask is unchanged: every rule write that lets a posting rule fire drafts, and the free ones stay free', () => {
  const deps = freshDeps();
  const { workspaceId, accId } = mintWorkspace(deps);
  const created = mcp(deps, 'create_automation_rule', {
    workspaceId, name: 'Buchen', trigger: { event: 'contact.created' }, action: postingAction(accId), enabled: false, idempotencyKey: 'd-rule',
  });
  assert.notEqual(created.drafted, true);
  const ruleId = created.rule.ruleId;
  assert.equal(mcp(deps, 'enable_automation_rule', { workspaceId, ruleId }).drafted, true);
  assert.equal(mcp(deps, 'update_automation_rule', { workspaceId, ruleId, patch: { condition: null }, idempotencyKey: 'd-c' }).drafted, true);
  assert.equal(mcp(deps, 'update_automation_rule', { workspaceId, ruleId, patch: { name: 'x' }, idempotencyKey: 'd-n' }).drafted, undefined);
  assert.equal(mcp(deps, 'disable_automation_rule', { workspaceId, ruleId }).drafted, undefined);
  deps.store.close();
});

test('a human seat is unchanged: the Studio enables and repoints a posting rule directly over the same transport', () => {
  const deps = freshDeps();
  const { workspaceId, accId } = mintWorkspace(deps);
  const studio = asHuman(deps);
  const ruleId = humanPostingRule(deps, workspaceId, accId, { enabled: false, key: 'hs-rule' });
  const enabled = mcp(studio, 'enable_automation_rule', { workspaceId, ruleId });
  assert.equal(enabled.ok, true, JSON.stringify(enabled));
  assert.notEqual(enabled.drafted, true);
  const patched = mcp(studio, 'update_automation_rule', { workspaceId, ruleId, patch: { action: { inputTemplate: postingAction(accId, 1200).inputTemplate } }, idempotencyKey: 'hs-up' });
  assert.equal(patched.ok, true, JSON.stringify(patched));
  assert.notEqual(patched.drafted, true);
  fireContactCreated(deps, workspaceId);
  assert.equal(posted(deps, workspaceId), 1);
  deps.store.close();
});

test('§H-TENANT: the stored rule is read inside the caller\'s workspace; a foreign rule id is not found and stays disabled', () => {
  const deps = freshDeps();
  const a = mintWorkspace(deps, 'Alpha GmbH', 'ws-a');
  const b = mintWorkspace(deps, 'Beta GmbH', 'ws-b');
  const foreign = humanPostingRule(deps, b.workspaceId, b.accId, { enabled: false, key: 'b-rule' });
  setDial(deps, a.workspaceId, { customize: 'auto' });
  const res = mcp(deps, 'enable_automation_rule', { workspaceId: a.workspaceId, ruleId: foreign });
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.equal(res.error, 'not_found');
  assert.equal(ruleRow(deps, foreign).enabled, 0);
  deps.store.close();
});

// --- The chokepoint is structural -----------------------------------------------------------------

test('every write of the rule family is classified, and the seam picks its tier through the one resolver', () => {
  const family = ACTIONS.filter(
    (a) => a.kind === 'write' && (a.name.includes('automation') || requiredCapabilitiesFor(a.name, {}).includes('manage_automations')),
  ).map((a) => a.name);
  assert.ok(family.includes('enable_automation_rule') && family.includes('retry_automation_run'), 'the family derivation found nothing');
  for (const name of family) {
    const tiered = Object.hasOwn(RULE_FIRING_WRITES, name);
    const exempt = Object.hasOwn(RULE_WRITES_NOT_TIERED, name);
    assert.ok(tiered !== exempt, `${name}: a rule-family write must be tiered by ruleTier.ts or exempted there in words, exactly once`);
  }
  const writes = new Set(ACTIONS.filter((a) => a.kind === 'write').map((a) => a.name));
  for (const name of [...Object.keys(RULE_FIRING_WRITES), ...Object.keys(RULE_WRITES_NOT_TIERED)]) {
    assert.ok(writes.has(name), `${name} is classified but is not a registered write`);
  }
  // The gate must not pick a tier from the input alone: that is the R4-1 defect.
  const gate = readFileSync(new URL('../../src/api/agent-gate.ts', import.meta.url), 'utf8');
  assert.match(gate, /governedDialCapability\(/);
  assert.doesNotMatch(gate, /dialCapabilityForCall\(/);
});

// --- Critic L2: the tier read and the verb's write share one transaction --------------------------

test('L2: for an agent seat, the stored-rule read and the enable/patch write run inside ONE open transaction', () => {
  const deps = freshDeps();
  const { workspaceId, accId } = mintWorkspace(deps);
  setDial(deps, workspaceId, { customize: 'auto', post: 'auto' });
  const ruleId = humanPostingRule(deps, workspaceId, accId, { enabled: false, key: 'l2-rule' });

  // Observe the connection's transaction state at the resolver's read of the rule and at the verb's
  // write of it. A second process can only slip a repoint in between if a commit separates the two.
  const db = deps.store.db;
  const seen = [];
  const original = db.prepare;
  db.prepare = function prepare(sql) {
    const statement = original.call(this, sql);
    const tag = /SELECT trigger_event, action_tool, action_input, archived FROM automation_rule/.test(sql)
      ? 'tier-read'
      : /^\s*UPDATE automation_rule/.test(sql)
        ? 'rule-write'
        : undefined;
    if (tag === undefined) return statement;
    for (const method of ['get', 'run']) {
      const inner = statement[method];
      statement[method] = (...params) => {
        seen.push([tag, db.inTransaction]);
        return inner.apply(statement, params);
      };
    }
    return statement;
  };
  try {
    const enabled = mcp(deps, 'enable_automation_rule', { workspaceId, ruleId });
    assert.equal(enabled.ok, true, JSON.stringify(enabled));
    assert.notEqual(enabled.drafted, true, 'premise: full auto executes');
    const patched = mcp(deps, 'update_automation_rule', { workspaceId, ruleId, patch: { condition: null }, idempotencyKey: 'l2-up' });
    assert.equal(patched.ok, true, JSON.stringify(patched));
    assert.notEqual(patched.drafted, true);
  } finally {
    db.prepare = original;
  }
  assert.deepEqual(
    seen,
    [['tier-read', true], ['rule-write', true], ['tier-read', true], ['rule-write', true]],
    'the tier was read, or the rule written, outside a transaction the gate holds across both',
  );
  assert.equal(db.inTransaction, false, 'the transaction closed with the call');
  deps.store.close();
});
