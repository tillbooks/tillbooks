/**
 * THE INPUT DENYLIST HOLDS AT FIRE TIME, ON THE RESOLVED INPUT (critic R3 on cl-periods).
 *
 * `create_automation_rule` checks `notAutomatableInput` on the TEMPLATE. A template whose value only
 * RESOLVES to the denied one (`templateId: "year_close{{nothing}}"`) passed that check and then fired
 * `checklist_start` on the year close unattended; a STORED row that predates a denylist entry (a
 * restored backup, a hand-edited file) never met the save-time check at all. `evaluateAndFire` and
 * the retry now check the resolved input: the rule fires nothing, and its run is recorded FAILED with
 * `template_not_automatable`, the save-time code, so the Verlauf says why.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { call, count, defineRule, workspace } from './support.mjs';

const YEAR_RUNS = "SELECT COUNT(*) AS n FROM checklist_run WHERE workspace_id = ? AND template_id = 'year_close'";
const runsOf = (deps, workspaceId, ruleId) =>
  deps.store.db.prepare('SELECT status, error_code, action_input FROM automation_run WHERE workspace_id = ? AND rule_id = ?').all(workspaceId, ruleId);

function trigger(deps, workspaceId, tag) {
  const res = call(deps, 'create_contact', { workspaceId, partyRole: 'customer', name: `Kunde ${tag}`, idempotencyKey: `ftd-${tag}` });
  assert.equal(res.ok, true, JSON.stringify(res));
}

test('a template that only RESOLVES to year_close is saved, but never starts the year close when it fires', () => {
  const { deps, workspaceId } = workspace('ftd-interp');
  const ruleId = defineRule(deps, workspaceId, {
    name: 'Jahresabschluss geschmuggelt',
    event: 'contact.created',
    tool: 'checklist_start',
    template: { templateId: 'year_close{{nothing}}' },
  }, 'ftd-interp-rule');
  trigger(deps, workspaceId, 'interp');
  assert.equal(count(deps, YEAR_RUNS, workspaceId), 0, 'the year close was started by an automation');
  const runs = runsOf(deps, workspaceId, ruleId);
  assert.equal(runs.length, 1, JSON.stringify(runs));
  assert.equal(runs[0].status, 'failed');
  assert.equal(runs[0].error_code, 'template_not_automatable');
  // The run records what WOULD have been sent: the resolved, denied value.
  assert.equal(JSON.parse(runs[0].action_input).templateId, 'year_close');
});

test('a STORED rule carrying the literal denied input (it never met the save-time check) fires nothing', () => {
  const { deps, workspaceId } = workspace('ftd-stored');
  const ruleId = defineRule(deps, workspaceId, {
    name: 'Monatsabschluss',
    event: 'contact.created',
    tool: 'checklist_start',
    template: { templateId: 'month_close' },
  }, 'ftd-stored-rule');
  // A restored backup or a hand edit: the row now names the year close literally.
  deps.store.db.prepare('UPDATE automation_rule SET action_input = ? WHERE id = ?').run(JSON.stringify({ templateId: 'year_close' }), ruleId);
  trigger(deps, workspaceId, 'stored');
  assert.equal(count(deps, YEAR_RUNS, workspaceId), 0, 'the year close was started by a stored rule');
  const runs = runsOf(deps, workspaceId, ruleId);
  assert.equal(runs.length, 1, JSON.stringify(runs));
  assert.equal(runs[0].status, 'failed');
  assert.equal(runs[0].error_code, 'template_not_automatable');
});

test('the retry door checks the resolved input too: a stuck run carrying the denied input is settled failed, not re-driven', () => {
  const { deps, workspaceId } = workspace('ftd-retry');
  const ruleId = defineRule(deps, workspaceId, {
    name: 'Monatsabschluss',
    event: 'contact.created',
    tool: 'checklist_start',
    template: { templateId: 'month_close' },
  }, 'ftd-retry-rule');
  deps.store.db
    .prepare("INSERT INTO automation_run (id, workspace_id, rule_id, trigger_event, event_ref, status, action_tool, action_input, error_code, actor, started_at) VALUES ('arun_stuck', ?, ?, 'contact.created', 'ref-stuck', 'running', 'checklist_start', ?, NULL, 'studio', '2026-07-16T00:00:00.000Z')")
    .run(workspaceId, ruleId, JSON.stringify({ templateId: 'year_close', workspaceId, idempotencyKey: 'auto:stuck' }));
  const res = call(deps, 'retry_automation_run', { workspaceId, runId: 'arun_stuck', idempotencyKey: 'ftd-retry-1' });
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.equal(res.error, 'template_not_automatable');
  assert.equal(count(deps, YEAR_RUNS, workspaceId), 0);
  const row = deps.store.db.prepare("SELECT status, error_code FROM automation_run WHERE id = 'arun_stuck'").get();
  assert.deepEqual({ ...row }, { status: 'failed', error_code: 'template_not_automatable' });
});

test('an admissible resolved input still fires (the check is not a blanket stop)', () => {
  const { deps, workspaceId } = workspace('ftd-ok');
  const ruleId = defineRule(deps, workspaceId, {
    name: 'Kontakt-Aufgabe',
    event: 'contact.created',
    tool: 'checklist_start',
    template: { templateId: 'month_close{{nothing}}' },
  }, 'ftd-ok-rule');
  trigger(deps, workspaceId, 'ok');
  const runs = runsOf(deps, workspaceId, ruleId);
  assert.equal(runs.length, 1);
  assert.notEqual(runs[0].error_code, 'template_not_automatable');
});
