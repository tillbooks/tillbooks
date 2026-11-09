/**
 * G22 leg 2 (D129, spec §10.8), the auto-start as WIRED: `create_workspace` seeds the two default
 * rules (per-workspace ids, enabled, the creating actor as author), two tenants on one store both
 * come to life (the id carries the workspace because `automation_rule.id` is a global primary key),
 * the daily tick starts the last ended month exactly once and the run records the RULE as its creator
 * (read off the fire path's derived idempotency key), a disabled rule starts nothing, a hand start
 * records the actor, and the key reader itself round-trips a rule id that contains colons.
 *
 * The worlds are created on 16.07.2026 (the pinned clock), so since the beta-launch P0.4a bound the
 * first period the rule may start is the one ENDING AFTER that day (July, Q3): June and Q2 ended
 * before these books began and are skipped, `ok` with `started:false`. The bound itself, and the
 * Stichtag that moves it, are pinned in the last tests of this file.
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
  let today = '2026-08-03T03:00:00.000Z';
  w.deps.clock = { now: () => today };

  must(w.call('run_due_automations', { asOf: today }), 'tick 1');
  const months = must(w.call('checklist_list', { templateId: 'month_close' }), 'months').runs;
  assert.equal(months.length, 1);
  assert.equal(months[0].periodLabel, '2026-07', 'the last ended month at 03.08.');
  const monthRun = must(w.call('checklist_get', { runId: months[0].runId }), 'get month run');
  assert.equal(monthRun.createdBy, monthRuleId, 'the run records the RULE, not the author, as its creator');
  assert.equal(checklistAutostartTemplateOf(monthRun.createdBy), 'month_close');
  // Q2 ended on 30.06, before these books began (16.07): nothing to start yet, and the row is ok.
  assert.equal(must(w.call('checklist_list', { templateId: 'vat_period' }), 'vat').runs.length, 0);
  assert.deepEqual(
    w.deps.store.db.prepare(RUNS).all(w.wid).map((r) => [r.rule_id, r.status]),
    [[monthRuleId, 'ok'], [vatRuleId, 'ok']],
  );

  // Two more days: the rule fires each day, the verb answers created:false, no second run appears.
  for (const day of ['2026-08-04T03:00:00.000Z', '2026-08-05T03:00:00.000Z']) {
    today = day;
    must(w.call('run_due_automations', { asOf: today }), `tick ${day}`);
  }
  assert.equal(must(w.call('checklist_list', { templateId: 'month_close' }), 'months again').runs.length, 1);
  assert.equal(w.deps.store.db.prepare('SELECT COUNT(*) AS n FROM automation_run WHERE workspace_id = ? AND rule_id = ?').get(w.wid, monthRuleId).n, 3);

  // A month later the next month is due and starts, once; the owner disables the month rule and the
  // month after that starts nothing, while the seed never re-enables it. Q3 ends 30.09, after the books
  // began, so the MWST-Periode starts on the first tick in October.
  today = '2026-09-02T03:00:00.000Z';
  must(w.call('run_due_automations', { asOf: today }), 'tick September');
  assert.deepEqual(must(w.call('checklist_list', { templateId: 'month_close' }), 'months').runs.map((r) => r.periodLabel).sort(), ['2026-07', '2026-08']);
  must(w.call('disable_automation_rule', { ruleId: monthRuleId }), 'disable');
  today = '2026-10-02T03:00:00.000Z';
  must(w.call('run_due_automations', { asOf: today }), 'tick October');
  assert.deepEqual(must(w.call('checklist_list', { templateId: 'month_close' }), 'months').runs.map((r) => r.periodLabel).sort(), ['2026-07', '2026-08'], 'the disabled rule started nothing');
  const vat = must(w.call('checklist_list', { templateId: 'vat_period' }), 'vat').runs;
  assert.deepEqual(vat.map((r) => r.periodLabel), ['2026-Q3']);
  assert.equal(must(w.call('checklist_get', { runId: vat[0].runId }), 'get vat run').createdBy, vatRuleId);

  // A hand start records the actor, and a forged auto: key naming a rule this workspace does not carry
  // is not provenance.
  const byHand = must(w.call('checklist_start', { templateId: 'month_close', period: '2026-09', idempotencyKey: 'by-hand' }), 'hand start');
  assert.equal(byHand.createdBy, 'studio');
  const forged = must(w.call('checklist_start', { templateId: 'month_close', period: '2026-05', idempotencyKey: 'auto:builtin:checklist_autostart:month_close:ws_other:0123456789abcdef' }), 'forged key');
  assert.equal(forged.createdBy, 'studio', 'a rule id the workspace does not carry falls back to the actor');
});

test('without an A05 configuration the vat_period rule fires daily and the verb refuses needs_vat_config: a failed run row per day, pinned as the design\'s own truth', () => {
  const w = world('noconfig');
  let today = '2026-08-03T03:00:00.000Z';
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

// --- Beta launch P0.4a: the auto-start never opens a period these books did not keep -------------

/** A world whose workspace is created on `createdAt` (the pinned clock of `freshDeps` is 16.07.). */
function worldCreatedOn(seed, createdAt) {
  const deps = freshDeps();
  deps.actor = 'studio';
  let today = createdAt;
  deps.clock = { now: () => today };
  const { workspaceId } = mintWorkspace(deps, 'Neu GmbH', `${seed}-ws`);
  const call = (name, input) => getAction(name).run(deps, { workspaceId, ...input });
  must(call('vat_seed_defaults', {}), 'seed vat');
  must(call('set_vat_method', { vatMethod: 'effektiv', vatAccounting: 'soll' }), 'method');
  return { deps, wid: workspaceId, call, at: (iso) => (today = iso) };
}

test('P0.4a: a company created on 30.09 meets no overdue August close on day 0, and the first auto-start is the first period its books kept', () => {
  const w = worldCreatedOn('day0', '2026-09-30T08:00:00.000Z');
  assert.equal(chk.booksStartOf({ store: w.deps.store, workspaceId: w.wid, clock: w.deps.clock }).date, '2026-09-30');

  for (const day of ['2026-09-30T09:00:00.000Z', '2026-10-01T03:00:00.000Z', '2026-10-02T03:00:00.000Z']) {
    w.at(day);
    must(w.call('run_due_automations', { asOf: day }), `tick ${day}`);
  }
  // Not August, not September (it ends ON the day the books began), not Q3: nothing was started.
  assert.equal(must(w.call('checklist_list', {}), 'list').runs.length, 0);
  // And so Pendenzen carries no checklist item at all, overdue or otherwise.
  const summary = must(w.call('attention_summary', {}), 'attention');
  const queue = (summary.queues ?? []).find((q) => q.queueId === 'checklist_items_due');
  assert.ok(queue === undefined || queue.count === 0, JSON.stringify(summary.queues));
  // Every firing is an ok row, never a daily failure: the rule did its job, there was nothing to start.
  const statuses = w.deps.store.db.prepare(RUNS).all(w.wid).map((r) => r.status);
  assert.ok(statuses.length >= 6 && statuses.every((s) => s === 'ok'), JSON.stringify(statuses));

  // What the verb answers the rule, read directly under the fire path's derived key.
  const monthRuleId = checklistAutostartRuleId(w.wid, 'month_close');
  const skipped = must(w.call('checklist_start', { templateId: 'month_close', idempotencyKey: `auto:${monthRuleId}:0123456789abcdef` }), 'auto start');
  assert.equal(skipped.created, false);
  assert.equal(skipped.started, false);
  assert.equal(skipped.skipped, 'before_books_start');
  assert.equal(skipped.period, '2026-09');
  assert.equal(skipped.booksStart, '2026-09-30');
  assert.equal(skipped.booksStartSource, 'workspace_created');

  // The first period that ENDS after the books began starts on its first tick.
  w.at('2026-11-02T03:00:00.000Z');
  must(w.call('run_due_automations', { asOf: '2026-11-02T03:00:00.000Z' }), 'tick November');
  assert.deepEqual(must(w.call('checklist_list', { templateId: 'month_close' }), 'months').runs.map((r) => r.periodLabel), ['2026-10']);

  // A HAND start is never bounded: a person naming August asks for it deliberately.
  const byHand = must(w.call('checklist_start', { templateId: 'month_close', period: '2026-08', idempotencyKey: 'hand-aug' }), 'hand August');
  assert.equal(byHand.created, true);
  assert.equal(byHand.createdBy, 'studio');
});

test('P0.4a: a Stichtag moves the bound: a migrated company still auto-starts the periods after its Übernahmestichtag, never the one ending on it', () => {
  const w = worldCreatedOn('stichtag', '2026-09-30T08:00:00.000Z');
  must(w.call('migration_create_plan', { sourceSystem: 'bexio', cutoverDate: '2026-06-30', idempotencyKey: 'plan-1' }), 'plan');
  const ctx = { store: w.deps.store, workspaceId: w.wid, clock: w.deps.clock };
  assert.deepEqual(chk.booksStartOf(ctx), { date: '2026-06-30', source: 'migration_cutover', inclusive: false });

  w.at('2026-10-01T03:00:00.000Z');
  must(w.call('run_due_automations', { asOf: '2026-10-01T03:00:00.000Z' }), 'tick');
  assert.deepEqual(must(w.call('checklist_list', { templateId: 'month_close' }), 'months').runs.map((r) => r.periodLabel), ['2026-09']);
  assert.deepEqual(must(w.call('checklist_list', { templateId: 'vat_period' }), 'vat').runs.map((r) => r.periodLabel), ['2026-Q3']);

  // Q2 ENDS on the Stichtag: the old system kept it, so an auto-start under a derived key skips it.
  const vatRuleId = checklistAutostartRuleId(w.wid, 'vat_period');
  w.at('2026-07-15T03:00:00.000Z');
  const q2 = must(w.call('checklist_start', { templateId: 'vat_period', idempotencyKey: `auto:${vatRuleId}:00000000000000aa` }), 'Q2 auto');
  assert.equal(q2.skipped, 'before_books_start');
  assert.equal(q2.period, '2026-Q2');
  assert.equal(q2.booksStartSource, 'migration_cutover');
});

test('P0.4a: booksStartOf reads an opening-balance Stichtag, prefers the earlier of two, and ignores an abandoned plan', () => {
  const w = worldCreatedOn('opening', '2026-09-30T08:00:00.000Z');
  const ctx = { store: w.deps.store, workspaceId: w.wid, clock: w.deps.clock };
  must(
    w.call('set_opening_balances', {
      asOf: '2026-01-01',
      lines: [{ account: '1020', debitMinor: 500000 }, { account: '2800', creditMinor: 500000 }],
      idempotencyKey: 'opening-1',
    }),
    'opening',
  );
  assert.deepEqual(chk.booksStartOf(ctx), { date: '2026-01-01', source: 'opening_balance', inclusive: false });
  // A later plan Stichtag does not move the bound past the earlier opening one.
  must(w.call('migration_create_plan', { sourceSystem: 'bexio', cutoverDate: '2026-03-31', idempotencyKey: 'plan-late' }), 'late plan');
  assert.deepEqual(chk.booksStartOf(ctx), { date: '2026-01-01', source: 'opening_balance', inclusive: false });
  // An earlier plan wins, unless it was abandoned.
  must(w.call('migration_create_plan', { sourceSystem: 'bexio', cutoverDate: '2025-12-31', idempotencyKey: 'plan-early' }), 'early plan');
  assert.deepEqual(chk.booksStartOf(ctx), { date: '2025-12-31', source: 'migration_cutover', inclusive: false });
  w.deps.store.db.prepare("UPDATE migration_plan SET status = 'abandoned' WHERE workspace_id = ? AND cutover_date = '2025-12-31'").run(w.wid);
  assert.deepEqual(chk.booksStartOf(ctx), { date: '2026-01-01', source: 'opening_balance', inclusive: false });
});
