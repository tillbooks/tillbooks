/**
 * E03's `task.due` trigger through G01's tick (the TICK_SOURCES row reserved for E03 by name).
 *
 * What is held: a rule on `task.due` fires when a reminder becomes due, exactly ONCE per
 * due-moment however many ticks see it (the occurrence key), a snooze keeps it from firing until
 * the snooze expires and then fires as a genuinely NEW occurrence, and a completed task fires
 * nothing. The predicate is `tasks_reminders_due`'s own, so "in the poll set" and "fires" agree.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { checklistAutostartRuleId } from '../../dist/core/checklists/index.js';
import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { sequenceIdGen } from '../../dist/core/ids.js';

/**
 * A SETTABLE clock, because this suite is about time passing: the tick clamps `asOf` to the
 * injected clock, so firing a reminder seeded in the future NEEDS the clock to move, not a
 * caller's claim about the time. Actor `studio`: an agent-authored rule lands disabled (P8), and
 * enabling is a human act this suite does not test.
 */
function world() {
  let instant = '2026-07-16T00:00:00.000Z';
  const clock = { now: () => instant };
  const store = new SqliteStore({ clock });
  const deps = { store, clock, ids: sequenceIdGen(), actor: 'studio' };
  const ws = getAction('create_workspace').run(deps, { name: 'Tick GmbH', idempotencyKey: 'ws' });
  const workspaceId = ws.workspaceId;
  const call = (name, input) => getAction(name).run(deps, { workspaceId, ...input });
  // G22 (D129) seeds two daily checklist rules into every workspace; they would co-fire on every tick
  // below and blur the fired counts, so the fixture retires them through the product's own door.
  for (const templateId of ['month_close', 'vat_period']) {
    const off = call('disable_automation_rule', { ruleId: checklistAutostartRuleId(workspaceId, templateId) });
    assert.equal(off.ok, true, JSON.stringify(off));
  }
  return { deps, workspaceId, call, setNow: (t) => { instant = t; } };
}

test('E03: task.due fires once per due-moment, resurfaces after a snooze, and never for a done task', () => {
  const { call, setNow } = world();

  // The rule: when a task's reminder comes due, create a follow-up task (all five E03 writes are
  // legal automation actions per spec 6b, and this one proves the fire path end to end).
  const rule = call('create_automation_rule', {
    name: 'Nachfassen anlegen',
    trigger: { event: 'task.due' },
    action: {
      tool: 'tasks_create',
      inputTemplate: { title: 'Nachfassen', assigneeUserId: 'studio', idempotencyKey: 'fired-{{task.id}}' },
    },
    idempotencyKey: 'rule-1',
  });
  assert.equal(rule.ok, true, `create_automation_rule refused: ${JSON.stringify(rule)}`);

  const t = call('tasks_create', {
    title: 'Offerte nachfassen',
    assigneeUserId: 'studio',
    dueAt: '2026-07-25',
    reminderAt: '2026-07-20T08:00:00.000Z',
    idempotencyKey: 'task-1',
  });
  assert.equal(t.ok, true);

  // Before the reminder instant: nothing is due, nothing fires.
  let tick = call('run_due_automations', {});
  assert.equal(tick.ok, true);
  assert.equal(tick.fired, 0);

  // The reminder comes due: exactly one occurrence fires, and the action really ran.
  setNow('2026-07-20T09:00:00.000Z');
  tick = call('run_due_automations', {});
  assert.equal(tick.fired, 1, `expected one firing: ${JSON.stringify(tick)}`);
  const afterFire = call('tasks_list', {}).tasks.filter((x) => x.title === 'Nachfassen');
  assert.equal(afterFire.length, 1, 'the fired tasks_create did not run');

  // A second tick sees the SAME due-moment: the occurrence key refuses a second run.
  tick = call('run_due_automations', {});
  assert.equal(tick.fired, 0);
  assert.equal(tick.alreadyAccounted, 1, `the same due-moment fired twice: ${JSON.stringify(tick)}`);

  // Snoozed: out of the poll set, so no NEW occurrence while the snooze holds.
  const sn = call('tasks_snooze', { taskId: t.taskId, until: '2026-07-22T08:00:00.000Z', idempotencyKey: 'sn-1' });
  assert.equal(sn.ok, true);
  setNow('2026-07-21T09:00:00.000Z');
  tick = call('run_due_automations', {});
  assert.equal(tick.fired, 0);
  assert.equal(tick.alreadyAccounted, 0, 'a snoozed reminder still produced its old occurrence');

  // The snooze expires: the resurfaced reminder is a genuinely NEW occurrence and fires once more.
  setNow('2026-07-22T09:00:00.000Z');
  tick = call('run_due_automations', {});
  assert.equal(tick.fired, 1, `the resurfaced reminder did not fire: ${JSON.stringify(tick)}`);

  // Done: out of the poll set for good; later ticks fire nothing at all.
  call('tasks_complete', { taskId: t.taskId, idempotencyKey: 'done-1' });
  setNow('2026-07-23T09:00:00.000Z');
  tick = call('run_due_automations', {});
  assert.equal(tick.fired, 0);
});

test('E03: task.completed emits through the shared dispatch, so a rule can react to a completion', () => {
  const { call } = world();
  const rule = call('create_automation_rule', {
    name: 'Folgeaufgabe nach Erledigung',
    trigger: { event: 'task.completed' },
    action: {
      tool: 'tasks_create',
      inputTemplate: { title: 'Folge', assigneeUserId: 'studio', idempotencyKey: 'after-{{input.taskId}}' },
    },
    idempotencyKey: 'rule-2',
  });
  assert.equal(rule.ok, true, `create_automation_rule refused: ${JSON.stringify(rule)}`);

  const t = call('tasks_create', { title: 'Beleg ablegen', assigneeUserId: 'studio', idempotencyKey: 'task-2' });
  const done = call('tasks_complete', { taskId: t.taskId, idempotencyKey: 'done-2' });
  assert.equal(done.ok, true);

  const spawned = call('tasks_list', {}).tasks.filter((x) => x.title === 'Folge');
  assert.equal(spawned.length, 1, 'the task.completed rule did not fire');
});
