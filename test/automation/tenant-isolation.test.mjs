/**
 * §H-TENANT for G01: rules, runs, the tick, and the firing itself.
 *
 * THE TRAP THIS SUITE IS BUILT AROUND. Two workspaces in TWO databases prove nothing at all: every
 * assertion below passes with the `workspace_id` predicate deleted from every query in the engine,
 * because the other tenant's rows are in a file the query could never have reached. So both
 * workspaces here are minted on ONE `ApiDeps`, sharing one store AND one id sequence, and the second
 * workspace is a real co-tenant rather than a second universe. `test/access/tenant-isolation.test.mjs`
 * and `test/vat/support.mjs` carry the same warning for the same reason.
 *
 * AND THE SECOND HALF, which a leak test usually forgets: it is not enough that a cross-tenant call
 * ANSWERS wrong-tenant-shaped, it must also not WRITE. Every refusal below is followed by a count or a
 * column read on the OTHER tenant's row.
 *
 * G01's SHARP CASE IS NOT A VERB AT ALL, IT IS THE FIRE PATH. A rule is looked up by
 * `(workspace_id, trigger_event)` and a firing has its `workspaceId` OVERWRITTEN with the emitting
 * context's, so the leak that would matter is Alpha's write making Beta's rule fire, or Beta's rule
 * posting into Alpha. Neither is reachable through a verb, so both are driven by really emitting the
 * event and then counting the other tenant's journal.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';
import { call, count, defineRule, postTemplate, runRows, retireSeededChecklistRules, OWN_RULES } from './support.mjs';

const ENTRIES = 'SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ?';
const RULES = `SELECT COUNT(*) AS n FROM automation_rule WHERE workspace_id = ? AND ${OWN_RULES}`;
const RUNS = 'SELECT COUNT(*) AS n FROM automation_run WHERE workspace_id = ?';

/**
 * Two workspaces in ONE store, each with its own posting rule on the same trigger event.
 *
 * The SAME event in both is deliberate: if `enabledRulesFor` lost its tenant predicate, Alpha's
 * contact would fire Beta's rule too, and the only thing that would show it is Beta's journal.
 */
function twoTenants() {
  const deps = freshDeps();
  deps.actor = 'studio';

  const alpha = mintWorkspace(deps, 'Alpha GmbH', 'ta-alpha-ws');
  const beta = mintWorkspace(deps, 'Beta GmbH', 'ta-beta-ws');
  retireSeededChecklistRules(deps, alpha.workspaceId);
  retireSeededChecklistRules(deps, beta.workspaceId);

  const alphaRule = defineRule(
    deps,
    alpha.workspaceId,
    { name: 'Alpha buchen', event: 'contact.created', tool: 'post_entry', template: postTemplate(alpha.accId, 1100) },
    'ta-alpha-rule',
  );
  const betaRule = defineRule(
    deps,
    beta.workspaceId,
    { name: 'Beta buchen', event: 'contact.created', tool: 'post_entry', template: postTemplate(beta.accId, 2200) },
    'ta-beta-rule',
  );

  // The fixture is only worth anything if the two really share a database.
  assert.equal(
    deps.store.db.prepare('SELECT COUNT(DISTINCT workspace_id) AS n FROM automation_rule').get().n,
    2,
    'the two workspaces must be co-tenants of ONE store, or nothing below is a leak test',
  );

  return { deps, alpha, beta, alphaRule, betaRule };
}

test('H-TENANT: an event in one workspace fires only that workspace rules', () => {
  const { deps, alpha, beta } = twoTenants();

  const created = call(deps, 'create_contact', {
    workspaceId: alpha.workspaceId,
    partyRole: 'customer',
    name: 'Nur Alpha AG',
    idempotencyKey: 'ta-fire',
  });
  assert.equal(created.ok, true, JSON.stringify(created));

  assert.equal(count(deps, ENTRIES, alpha.workspaceId), 1);
  assert.equal(count(deps, ENTRIES, beta.workspaceId), 0, "Alpha's contact fired Beta's rule");
  assert.equal(count(deps, RUNS, alpha.workspaceId), 1);
  assert.equal(count(deps, RUNS, beta.workspaceId), 0, "Alpha's firing wrote a run row into Beta");

  // And the amount is Alpha's own template, not Beta's: a leak that picked the wrong rule would still
  // land one entry in one workspace and pass every count above.
  const line = deps.store.db
    .prepare(
      `SELECT debit_minor AS d FROM journal_line
        WHERE entry_id IN (SELECT id FROM journal_entry WHERE workspace_id = ?) AND debit_minor > 0`,
    )
    .get(alpha.workspaceId);
  assert.equal(line.d, 1100, "Alpha's entry was posted from Beta's template");
});

test('H-TENANT: list_automation_rules and list_automation_runs answer one workspace, never the store', () => {
  const { deps, alpha, beta, alphaRule, betaRule } = twoTenants();
  assert.equal(
    call(deps, 'create_contact', {
      workspaceId: alpha.workspaceId,
      partyRole: 'customer',
      name: 'Alpha AG',
      idempotencyKey: 'ta-list',
    }).ok,
    true,
  );

  const alphaRules = call(deps, 'list_automation_rules', { workspaceId: alpha.workspaceId });
  assert.equal(alphaRules.ok, true);
  // Each list carries its OWN two retired G22 defaults beside its rule, and never the other tenant's.
  const own = (rules) => rules.map((r) => r.ruleId).filter((id) => !id.startsWith('builtin:checklist_autostart:'));
  assert.deepEqual(own(alphaRules.rules), [alphaRule]);
  assert.deepEqual(alphaRules.rules.map((r) => r.ruleId).filter((id) => id.startsWith('builtin:')).map((id) => id.endsWith(':' + alpha.workspaceId)), [true, true], "Alpha's defaults are Alpha's");

  const betaRules = call(deps, 'list_automation_rules', { workspaceId: beta.workspaceId });
  assert.deepEqual(own(betaRules.rules), [betaRule], "Beta's rule list carried Alpha's rule");

  const betaRuns = call(deps, 'list_automation_runs', { workspaceId: beta.workspaceId });
  assert.equal(betaRuns.ok, true);
  assert.deepEqual(betaRuns.runs, [], "Beta's run log carried Alpha's firing");

  // The `ruleId` filter is the one that could route around the tenant clause, so it is driven across.
  const crossFiltered = call(deps, 'list_automation_runs', { workspaceId: beta.workspaceId, ruleId: alphaRule });
  assert.deepEqual(crossFiltered.runs, [], "Beta read Alpha's run log by naming Alpha's rule id");
});

test("H-TENANT: get_automation_rule and get_automation_run cannot read across the boundary", () => {
  const { deps, alpha, beta, alphaRule } = twoTenants();
  assert.equal(
    call(deps, 'create_contact', {
      workspaceId: alpha.workspaceId,
      partyRole: 'customer',
      name: 'Alpha AG',
      idempotencyKey: 'ta-get',
    }).ok,
    true,
  );
  const alphaRun = runRows(deps, alpha.workspaceId)[0];
  const runId = deps.store.db
    .prepare('SELECT id FROM automation_run WHERE workspace_id = ? AND rule_id = ?')
    .get(alpha.workspaceId, alphaRun.rule_id).id;

  const rule = call(deps, 'get_automation_rule', { workspaceId: beta.workspaceId, ruleId: alphaRule });
  assert.equal(rule.ok, false);
  assert.equal(rule.error, 'not_found');

  const run = call(deps, 'get_automation_run', { workspaceId: beta.workspaceId, runId });
  assert.equal(run.ok, false);
  assert.equal(run.error, 'not_found');
});

test("H-TENANT: no rule verb can edit, stop, start or retire another workspace's rule", () => {
  // The write half. Each call is a cross-tenant id, and each is followed by a read of the row it
  // aimed at: `not_found` in the answer and an unchanged column are two different claims.
  const { deps, alpha, beta, betaRule } = twoTenants();
  const betaRow = () =>
    deps.store.db
      .prepare('SELECT name, enabled, archived, action_tool FROM automation_rule WHERE id = ?')
      .get(betaRule);
  const before = betaRow();
  assert.deepEqual(before, { name: 'Beta buchen', enabled: 1, archived: 0, action_tool: 'post_entry' });

  const attempts = [
    ['update_automation_rule', { workspaceId: alpha.workspaceId, ruleId: betaRule, patch: { name: 'Übernommen' }, idempotencyKey: 'ta-w-1' }],
    ['disable_automation_rule', { workspaceId: alpha.workspaceId, ruleId: betaRule }],
    ['enable_automation_rule', { workspaceId: alpha.workspaceId, ruleId: betaRule }],
    ['archive_automation_rule', { workspaceId: alpha.workspaceId, ruleId: betaRule }],
  ];
  for (const [name, input] of attempts) {
    const res = getAction(name).run(deps, input);
    assert.equal(res.ok, false, `${name} accepted a cross-tenant ruleId`);
    assert.equal(res.error, 'not_found', `${name} answered ${res.error}`);
  }

  assert.deepEqual(betaRow(), before, "a verb issued in Alpha changed Beta's rule");
  assert.equal(count(deps, RULES, alpha.workspaceId), 1, 'a cross-tenant write minted a rule in Alpha');
  assert.equal(count(deps, RULES, beta.workspaceId), 1);
});

test('H-TENANT: the tick fires one workspace at a time', () => {
  // The tenant clause in the tick's own query is the only thing between a caller and every schedule
  // rule in the store. It now sits behind `manage_automations` as well (the old exemption argued the
  // firings were "separately gated", which gates the rule's AUTHOR and says nothing about the
  // caller), but a capability is a per-workspace grant and is therefore not a tenant boundary: an
  // administrator of Alpha holds `manage_automations` and must still not sweep Beta.
  const deps = freshDeps();
  deps.actor = 'studio';
  const alpha = mintWorkspace(deps, 'Alpha GmbH', 'tt-alpha');
  const beta = mintWorkspace(deps, 'Beta GmbH', 'tt-beta');
  retireSeededChecklistRules(deps, alpha.workspaceId);
  retireSeededChecklistRules(deps, beta.workspaceId);

  defineRule(
    deps,
    alpha.workspaceId,
    { name: 'Alpha täglich', event: 'schedule.daily', tool: 'post_entry', template: postTemplate(alpha.accId, 1100) },
    'tt-alpha-rule',
  );
  defineRule(
    deps,
    beta.workspaceId,
    { name: 'Beta täglich', event: 'schedule.daily', tool: 'post_entry', template: postTemplate(beta.accId, 2200) },
    'tt-beta-rule',
  );

  const ticked = call(deps, 'run_due_automations', { workspaceId: alpha.workspaceId, asOf: '2026-03-10T09:00:00.000Z' });
  assert.equal(ticked.ok, true, JSON.stringify(ticked));
  assert.equal(ticked.occurrences, 1, "the tick swept more than Alpha's rules");

  assert.equal(count(deps, ENTRIES, alpha.workspaceId), 1);
  assert.equal(count(deps, ENTRIES, beta.workspaceId), 0, "a tick in Alpha fired Beta's schedule");
  assert.equal(count(deps, RUNS, beta.workspaceId), 0);
  // And Beta's bookmark is untouched, so Beta's own next tick still has something to do.
  assert.equal(
    deps.store.db.prepare('SELECT last_fired_at FROM automation_rule WHERE workspace_id = ?').get(beta.workspaceId).last_fired_at,
    null,
    "a tick in Alpha advanced Beta's cadence bookmark",
  );
});

test('H-TENANT: a rule may not name another workspace saved view to widen its own list', () => {
  // G01 consumes G00's `savedViewId` seam, which means G00's ownership rules now guard a G01 read.
  const { deps, alpha, beta } = twoTenants();
  const view = call(deps, 'create_saved_view', {
    workspaceId: beta.workspaceId,
    entityKind: 'automation_rule',
    name: 'Beta Ansicht',
    filters: { enabled: true },
    idempotencyKey: 'ta-view',
  });
  assert.equal(view.ok, true, JSON.stringify(view));

  const listed = call(deps, 'list_automation_rules', {
    workspaceId: alpha.workspaceId,
    savedViewId: view.savedView.viewId,
  });
  assert.equal(listed.ok, false, "Alpha applied Beta's saved view");
  assert.equal(listed.error, 'not_found');
});
