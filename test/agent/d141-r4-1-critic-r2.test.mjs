/**
 * Non-author critic, round 2 of D141.5 / R4-1 (branch claude/d141-r4-1-rule-tier at b87d981b).
 *
 * Probes of the L2 remediation (`withinStoredRuleTx`, `src/api/agent-gate.ts`): the stored-rule tier
 * read, the draft-or-execute decision and the verb's own write now share one BEGIN IMMEDIATE
 * transaction for a governed seat. These tests drive it against a REAL second process
 * (`test/support/lock-holder.mjs`), through the awaiting door, with a verb that refuses and with one
 * that throws after writing. The record is `docs/critique/d141-r4-1-critique-r2.md`.
 *
 * Every book is synthetic and lives in a temp directory.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { fixedClock } from '../../dist/core/clock.js';
import { sequenceIdGen } from '../../dist/core/ids.js';
import { callTool } from '../../dist/api/mcp.js';
import { handleRest } from '../../dist/api/rest.js';
import { getAction } from '../../dist/api/registry.js';
import { runGovernedAsync } from '../../dist/api/agent-gate.js';
import { freshDeps, mintWorkspace, AT } from '../api/support.mjs';
import { lockHolder } from '../support/lock-holder.mjs';

const mcp = (deps, name, args) => JSON.parse(callTool(deps, name, args).content[0].text);
const human = (deps, name, input) => getAction(name).run({ ...deps, actor: 'studio' }, input);

let grantSeq = 0;
function setDial(deps, workspaceId, levels) {
  for (const [capability, level] of Object.entries(levels)) {
    const res = human(deps, 'set_agent_dial', { workspaceId, capability, level, idempotencyKey: `r2-dial-${++grantSeq}` });
    assert.equal(res.ok, true, JSON.stringify(res));
  }
}

function postingTemplate(accId, amount = 330000) {
  return {
    date: '2026-07-16',
    description: 'Zweitprozess-Buchung',
    source: 'manual',
    lines: [{ account: accId('6500'), debit: amount }, { account: accId('1000'), credit: amount }],
  };
}

function fileWorld(busyTimeoutMs = 5000) {
  const path = join(mkdtempSync(join(tmpdir(), 'till-r2-')), 'till.db');
  const store = new SqliteStore({ location: path, clock: fixedClock(AT), busyTimeoutMs });
  const deps = { store, clock: fixedClock(AT), ids: sequenceIdGen(), actor: 'agent' };
  const { workspaceId, accId } = mintWorkspace(deps, 'Zweitprozess Beispiel AG', 'r2-ws');
  return { path, store, deps, workspaceId, accId };
}

/** Wrap `prepare` so a callback fires when the resolver reads the stored rule's tier. */
function onTierRead(db, fire) {
  const original = db.prepare;
  let armed = true;
  db.prepare = function prepare(sql) {
    if (armed && /SELECT trigger_event, action_tool, action_input, archived FROM automation_rule/.test(sql)) {
      armed = false;
      fire();
    }
    return original.call(this, sql);
  };
  return () => {
    db.prepare = original;
  };
}

// --- L2 against a real second process ------------------------------------------------------------

test('L2 race: a second process repointing the rule at the moment of the tier read cannot commit before the enable writes', async () => {
  const w = fileWorld();
  try {
    setDial(w.deps, w.workspaceId, { customize: 'auto' });
    const created = human(w.deps, 'create_automation_rule', {
      workspaceId: w.workspaceId, name: 'Nachfassen', trigger: { event: 'contact.created' },
      action: { tool: 'tasks_create', inputTemplate: { title: 'Begrüssen' } }, enabled: false, idempotencyKey: 'r2-rule',
    });
    assert.equal(created.ok, true, JSON.stringify(created));
    const ruleId = created.rule.ruleId;

    // The other TILL (a human in the Studio) repoints the rule to post_entry and records, in the same
    // statement, whether the rule was already enabled when its repoint landed.
    const repoint = JSON.stringify(postingTemplate(w.accId));
    const holder = await lockHolder(w.path, {
      holdMs: 50,
      inTransaction: `db.prepare("UPDATE automation_rule SET action_tool = 'post_entry', action_input = ?, name = CASE enabled WHEN 1 THEN 'repointed-after-enable' ELSE 'repointed-before-enable' END WHERE id = ?").run(${JSON.stringify(repoint)}, ${JSON.stringify(ruleId)});`,
    });
    let took = null;
    const restore = onTierRead(w.store.db, () => {
      took = holder.take(400);
    });
    let enabled;
    try {
      enabled = mcp(w.deps, 'enable_automation_rule', { workspaceId: w.workspaceId, ruleId });
    } finally {
      restore();
    }
    await holder.done;
    assert.equal(took, false, 'the other process took the write lock between the tier read and the enable');
    assert.equal(enabled.ok, true, JSON.stringify(enabled));
    const row = w.store.db.prepare('SELECT name, enabled, action_tool FROM automation_rule WHERE id = ?').get(ruleId);
    // The enable executed on the rule it read (tasks_create, customize=auto); the human's repoint is a
    // separate, later act.
    assert.equal(row.name, 'repointed-after-enable', `the enable executed over a rule repointed after its tier read: ${JSON.stringify(row)}`);
  } finally {
    w.store.close();
  }
});

test('L2 busy: past the busy timeout the rule write answers store_busy on both faces, nothing is written, drafted or traced', async () => {
  const w = fileWorld(150);
  try {
    setDial(w.deps, w.workspaceId, { customize: 'auto' });
    const created = human(w.deps, 'create_automation_rule', {
      workspaceId: w.workspaceId, name: 'Buchen', trigger: { event: 'contact.created' },
      action: { tool: 'post_entry', inputTemplate: postingTemplate(w.accId) }, enabled: false, idempotencyKey: 'r2-busy-rule',
    });
    const ruleId = created.rule.ruleId;
    const rows = () =>
      w.store.db
        .prepare('SELECT (SELECT COUNT(*) FROM agent_action) AS drafts, (SELECT COUNT(*) FROM agent_call) AS calls, (SELECT enabled FROM automation_rule WHERE id = ?) AS enabled, (SELECT COUNT(*) FROM idempotency) AS keys')
        .get(ruleId);
    const before = rows();
    const holder = await lockHolder(w.path, { holdMs: 1500 });
    assert.equal(holder.take(), true, 'premise: the other process holds the write lock');
    let viaMcp;
    let viaRest;
    assert.doesNotThrow(() => {
      viaMcp = mcp(w.deps, 'enable_automation_rule', { workspaceId: w.workspaceId, ruleId });
    });
    assert.doesNotThrow(() => {
      viaRest = handleRest('update_automation_rule', { workspaceId: w.workspaceId, ruleId, patch: { condition: null }, idempotencyKey: 'r2-busy-up' }, w.deps);
    });
    await holder.done;
    assert.equal(viaMcp.ok, false);
    assert.equal(viaMcp.error, 'store_busy', JSON.stringify(viaMcp));
    assert.equal(viaMcp.retryable, true);
    assert.equal(viaMcp.partial, false);
    assert.equal(viaRest.status, 422, JSON.stringify(viaRest));
    assert.equal(viaRest.body.error, 'store_busy');
    assert.deepEqual(rows(), before, 'a busy rule write left a row behind');
    assert.equal(w.store.db.inTransaction, false);

    // The retry after the lock is released drafts exactly once (the enable fires post_entry).
    const retried = mcp(w.deps, 'enable_automation_rule', { workspaceId: w.workspaceId, ruleId });
    assert.equal(retried.drafted, true, JSON.stringify(retried));
    assert.equal(retried.dialCapability, 'post');
    assert.equal(rows().drafts, before.drafts + 1);
  } finally {
    w.store.close();
  }
});

// --- The awaiting door is routed through the same transaction ---------------------------------

test('L2 async door: runGovernedAsync reads the tier inside the transaction and drafts at the fired tier', async () => {
  const deps = freshDeps();
  const { workspaceId, accId } = mintWorkspace(deps);
  setDial(deps, workspaceId, { customize: 'auto' });
  const created = human(deps, 'create_automation_rule', {
    workspaceId, name: 'Buchen', trigger: { event: 'contact.created' }, action: { tool: 'post_entry', inputTemplate: postingTemplate(accId) }, enabled: false, idempotencyKey: 'r2-async',
  });
  let inTx = null;
  const restore = onTierRead(deps.store.db, () => {
    inTx = deps.store.db.inTransaction;
  });
  let res;
  try {
    res = await runGovernedAsync(deps, getAction('enable_automation_rule'), { workspaceId, ruleId: created.rule.ruleId });
  } finally {
    restore();
  }
  assert.equal(inTx, true, 'the async door read the stored rule outside the transaction');
  assert.equal(res.drafted, true, JSON.stringify(res));
  assert.equal(res.dialCapability, 'post');
  assert.equal(deps.store.db.inTransaction, false);
  deps.store.close();
});

// --- A verb that refuses, and a verb that throws after writing, inside the widened transaction ----

test('L2 refusal: an archived rule refuses inside the transaction, the refusal is traced, nothing else is written', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  setDial(deps, workspaceId, { customize: 'auto' });
  const created = human(deps, 'create_automation_rule', {
    workspaceId, name: 'Alt', trigger: { event: 'contact.created' }, action: { tool: 'tasks_create', inputTemplate: { title: 'x' } }, enabled: false, idempotencyKey: 'r2-arch',
  });
  assert.equal(human(deps, 'archive_automation_rule', { workspaceId, ruleId: created.rule.ruleId }).ok, true);
  const calls = () => deps.store.db.prepare("SELECT mode, ok, error_code FROM agent_call WHERE workspace_id = ? AND verb = 'enable_automation_rule'").all(workspaceId);
  const res = mcp(deps, 'enable_automation_rule', { workspaceId, ruleId: created.rule.ruleId });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'rule_archived');
  assert.deepEqual(calls(), [{ mode: 'execute', ok: 0, error_code: 'rule_archived' }]);
  assert.equal(deps.store.db.prepare('SELECT enabled FROM automation_rule WHERE id = ?').get(created.rule.ruleId).enabled, 0);
  assert.equal(deps.store.db.inTransaction, false);
  deps.store.close();
});

test('L2 throw after a write: the agent seat answers exactly as the human registry call does (same code, same partial flag, same row state)', () => {
  const outcome = (asAgent) => {
    const deps = freshDeps();
    const { workspaceId } = mintWorkspace(deps);
    setDial(deps, workspaceId, { customize: 'auto' });
    const created = human(deps, 'create_automation_rule', {
      workspaceId, name: 'Kaputt', trigger: { event: 'contact.created' }, action: { tool: 'tasks_create', inputTemplate: { title: 'x' } }, enabled: false, idempotencyKey: 'r2-throw',
    });
    const ruleId = created.rule.ruleId;
    // A stored condition that no longer parses: the enable's UPDATE runs, then mapRule throws on read.
    deps.store.db.prepare("UPDATE automation_rule SET condition = '{not json' WHERE id = ?").run(ruleId);
    const res = asAgent
      ? mcp(deps, 'enable_automation_rule', { workspaceId, ruleId })
      : human(deps, 'enable_automation_rule', { workspaceId, ruleId });
    const enabled = deps.store.db.prepare('SELECT enabled FROM automation_rule WHERE id = ?').get(ruleId).enabled;
    const inTx = deps.store.db.inTransaction;
    deps.store.close();
    return { ok: res.ok, error: res.error, partial: res.partial, enabled, inTx };
  };
  const agent = outcome(true);
  const person = outcome(false);
  assert.deepEqual(agent, person, `agent ${JSON.stringify(agent)} vs human ${JSON.stringify(person)}`);
  assert.equal(agent.inTx, false, 'the widened transaction was left open');
});

// --- The widened transaction's stated premise, pinned -----------------------------------------------

test('L2 premise: no verb that runs inside the widened transaction emits an automation event (a firing would run before the commit)', async () => {
  const { eventsEmittedBy } = await import('../../dist/core/automation/events.js');
  const { readsStoredRule, RULE_FIRING_WRITES } = await import('../../dist/core/agent/index.js');
  const widened = Object.keys(RULE_FIRING_WRITES).filter((name) => readsStoredRule(name));
  assert.deepEqual(widened.sort(), ['enable_automation_rule', 'update_automation_rule']);
  for (const name of widened) {
    assert.deepEqual(eventsEmittedBy(name).map((d) => d.event), [], `${name} emits an event: its rules would fire inside the gate's open transaction, not after the commit`);
  }
});

test('F1 closed at the source: a drafted action\'s stored tier is written once and never updated', async () => {
  const { readFileSync, readdirSync, statSync } = await import('node:fs');
  const { join: j } = await import('node:path');
  const root = new URL('../../src/', import.meta.url).pathname;
  const offenders = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const p = j(dir, entry);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('.ts') && /UPDATE\s+agent_action\s+SET[^`]*dial_capability/s.test(readFileSync(p, 'utf8'))) offenders.push(p);
    }
  };
  walk(root);
  assert.deepEqual(offenders, [], 'the hub sentence and the grant both read agent_action.dial_capability; rewriting it would split them again');
});
