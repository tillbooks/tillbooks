/**
 * G22 leg 2 (D129, spec §10.8), the auto-start as WIRED: `create_workspace` seeds the two default
 * rules (per-workspace ids, enabled, the creating actor as author), two tenants on one store both
 * come to life (the id carries the workspace because `automation_rule.id` is a global primary key),
 * the daily tick starts the last ended month exactly once and the run records the RULE as its creator
 * (read off the fire path's derived idempotency key), a disabled rule starts nothing, a hand start
 * records the actor, and the key reader itself round-trips a rule id that contains colons.
 *
 * Also recorded here, on purpose: without an A05 configuration the `vat_period` rule fires
 * `checklist_start` every day and the verb refuses `needs_vat_config`, which the Verlauf keeps as a
 * failed run row per day. That is the design's own truth (option B, §10.8) and the N4 report raises
 * it for the owner; the test pins it so a change is a decision, not a drift.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';

const { getAction } = await import('../../dist/api/registry.js');
const { automationRuleIdOfKey } = await import('../../dist/core/automation/fire.js');
const chk = await import('../../dist/core/checklists/index.js');
const { freshDeps, mintWorkspace } = await import('../api/support.mjs');

const { CHECKLIST_AUTOSTART_RULE_IDS, checklistAutostartRuleId, checklistAutostartTemplateOf, CHECKLIST_AUTOSTART_TRIGGER } = chk;

const must = (res, what) => {
  assert.equal(res.ok, true, `${what} failed: ${JSON.stringify(res)}`);
  return res;
};

const RULES = 'SELECT id, name, enabled, archived, trigger_event, action_tool, action_input, created_by FROM automation_rule WHERE workspace_id = ? ORDER BY id';
const RUNS = 'SELECT rule_id, status, error_code FROM automation_run WHERE workspace_id = ? ORDER BY started_at, id';

function world(seed, actor = 'studio') {
  const deps = freshDeps();
  deps.actor = actor;
  const { workspaceId } = mintWorkspace(deps, 'Automatik GmbH', `${seed}-ws`);
  const call = (name, input) => getAction(name).run(deps, { workspaceId, ...input });
  return { deps, wid: workspaceId, call };
}

test('create_workspace seeds the two default rules once, per workspace, enabled, authored by the creating actor; two tenants on one store both come to life', () => {
  const w = world('seed', 'agent');
  const rows = w.deps.store.db.prepare(RULES).all(w.wid);
  assert.deepEqual(rows.map((r) => r.id), [checklistAutostartRuleId(w.wid, 'month_close'), checklistAutostartRuleId(w.wid, 'vat_period')]);
  for (const r of rows) {
    assert.equal(r.enabled, 1);
    assert.equal(r.archived, 0);
    assert.equal(r.trigger_event, CHECKLIST_AUTOSTART_TRIGGER);
    assert.equal(r.action_tool, 'checklist_start');
    assert.equal(r.created_by, 'agent', 'the creating actor is the author the A24 gate runs the firing under');
  }
  assert.deepEqual(JSON.parse(rows[0].action_input), { templateId: 'month_close' });
  assert.equal(rows[0].name, 'Monatsabschluss automatisch starten');
  assert.equal(checklistAutostartTemplateOf(rows[0].id), 'month_close');
  assert.equal(checklistAutostartTemplateOf(rows[1].id), 'vat_period');
  assert.equal(checklistAutostartTemplateOf('studio'), undefined);
  assert.equal(checklistAutostartTemplateOf(CHECKLIST_AUTOSTART_RULE_IDS.month_close), undefined, 'the bare prefix is not a stored id');
  // A second tenant on the SAME store: the ids carry the workspace, so the primary key does not collide.
  const second = must(getAction('create_workspace').run(w.deps, { name: 'Zweite GmbH', idempotencyKey: 'seed-ws-2' }), 'second tenant');
  assert.deepEqual(
    w.deps.store.db.prepare(RULES).all(second.workspaceId).map((r) => r.id),
    [checklistAutostartRuleId(second.workspaceId, 'month_close'), checklistAutostartRuleId(second.workspaceId, 'vat_period')],
  );
  assert.equal(w.deps.store.db.prepare('SELECT COUNT(*) AS n FROM automation_rule').get().n, 4);
  // The listing verb shows them like any rule, so the owner can disable either on /automations.
  const listed = must(w.call('list_automation_rules', {}), 'list');
  assert.deepEqual(listed.rules.map((r) => r.ruleId).sort(), rows.map((r) => r.id).sort());
});

test('the daily tick starts the last ended month once, the run names the rule as its creator, a disabled rule starts nothing, a hand start names the actor', () => {
  const w = world('tick');
  must(w.call('vat_seed_defaults', {}), 'seed vat');
  must(w.call('set_vat_method', { vatMethod: 'effektiv', vatAccounting: 'soll' }), 'method');
  const monthRuleId = checklistAutostartRuleId(w.wid, 'month_close');
  const vatRuleId = checklistAutostartRuleId(w.wid, 'vat_period');
  let today = '2026-07-16T03:00:00.000Z';
  w.deps.clock = { now: () => today };

  must(w.call('run_due_automations', { asOf: today }), 'tick 1');
  const months = must(w.call('checklist_list', { templateId: 'month_close' }), 'months').runs;
  assert.equal(months.length, 1);
  assert.equal(months[0].periodLabel, '2026-06', 'the last ended month at 16.07.');
  const monthRun = must(w.call('checklist_get', { runId: months[0].runId }), 'get month run');
  assert.equal(monthRun.createdBy, monthRuleId, 'the run records the RULE, not the author, as its creator');
  assert.equal(checklistAutostartTemplateOf(monthRun.createdBy), 'month_close');
  const vat = must(w.call('checklist_list', { templateId: 'vat_period' }), 'vat').runs;
  assert.equal(vat.length, 1);
  assert.equal(vat[0].periodLabel, '2026-Q2');
  assert.equal(must(w.call('checklist_get', { runId: vat[0].runId }), 'get vat run').createdBy, vatRuleId);
  assert.deepEqual(
    w.deps.store.db.prepare(RUNS).all(w.wid).map((r) => [r.rule_id, r.status]),
    [[monthRuleId, 'ok'], [vatRuleId, 'ok']],
  );

  // Two more days: the rule fires each day, the verb answers created:false, no second run appears.
  for (const day of ['2026-07-17T03:00:00.000Z', '2026-07-18T03:00:00.000Z']) {
    today = day;
    must(w.call('run_due_automations', { asOf: today }), `tick ${day}`);
  }
  assert.equal(must(w.call('checklist_list', { templateId: 'month_close' }), 'months again').runs.length, 1);
  assert.equal(w.deps.store.db.prepare('SELECT COUNT(*) AS n FROM automation_run WHERE workspace_id = ? AND rule_id = ?').get(w.wid, monthRuleId).n, 3);

  // A month later the next month is due and starts, once; the owner disables the month rule and the
  // month after that starts nothing, while the seed never re-enables it.
  today = '2026-08-02T03:00:00.000Z';
  must(w.call('run_due_automations', { asOf: today }), 'tick August');
  assert.deepEqual(must(w.call('checklist_list', { templateId: 'month_close' }), 'months').runs.map((r) => r.periodLabel).sort(), ['2026-06', '2026-07']);
  must(w.call('disable_automation_rule', { ruleId: monthRuleId }), 'disable');
  today = '2026-09-02T03:00:00.000Z';
  must(w.call('run_due_automations', { asOf: today }), 'tick September');
  assert.deepEqual(must(w.call('checklist_list', { templateId: 'month_close' }), 'months').runs.map((r) => r.periodLabel).sort(), ['2026-06', '2026-07'], 'the disabled rule started nothing');

  // A hand start records the actor, and a forged auto: key naming a rule this workspace does not carry
  // is not provenance.
  const byHand = must(w.call('checklist_start', { templateId: 'month_close', period: '2026-08', idempotencyKey: 'by-hand' }), 'hand start');
  assert.equal(byHand.createdBy, 'studio');
  const forged = must(w.call('checklist_start', { templateId: 'month_close', period: '2026-05', idempotencyKey: 'auto:builtin:checklist_autostart:month_close:ws_other:0123456789abcdef' }), 'forged key');
  assert.equal(forged.createdBy, 'studio', 'a rule id the workspace does not carry falls back to the actor');
});

test('without an A05 configuration the vat_period rule fires daily and the verb refuses needs_vat_config: a failed run row per day, pinned as the design\'s own truth', () => {
  const w = world('noconfig');
  let today = '2026-07-16T03:00:00.000Z';
  w.deps.clock = { now: () => today };
  must(w.call('run_due_automations', { asOf: today }), 'tick');
  const runs = w.deps.store.db.prepare(RUNS).all(w.wid);
  assert.deepEqual(runs.map((r) => [checklistAutostartTemplateOf(r.rule_id), r.status, r.error_code]), [
    ['month_close', 'ok', null],
    ['vat_period', 'failed', 'needs_vat_config'],
  ]);
  assert.equal(must(w.call('checklist_list', {}), 'list').runs.length, 1, 'the month started, the MWST-Periode could not');
});

test('automationRuleIdOfKey reads the rule id back off the fire path\'s derived key, colons in the id included, and nothing else', () => {
  assert.equal(automationRuleIdOfKey('auto:builtin:checklist_autostart:month_close:ws_1:0123456789abcdef'), 'builtin:checklist_autostart:month_close:ws_1');
  assert.equal(automationRuleIdOfKey('auto:arule_7:00ff00ff00ff00ff'), 'arule_7');
  assert.equal(automationRuleIdOfKey('by-hand'), undefined);
  assert.equal(automationRuleIdOfKey('auto:arule_7'), undefined, 'no digest');
  assert.equal(automationRuleIdOfKey('auto:arule_7:not-a-digest-here'), undefined, 'the digest is hex');
  assert.equal(automationRuleIdOfKey('auto::0123456789abcdef'), undefined, 'an empty rule id');
});
