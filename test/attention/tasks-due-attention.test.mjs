// D210: the E03 tasks due soon arrive in Pendenzen (`tasks_due`), so Aufgaben needs no menu row.
//
// What the provider promises: a live task (open or doing) due within `attention.tasks_due_days` lists as
// `due`, a late one as `overdue`; a done or cancelled task, one without a due date, one beyond the window
// and one snoozed past now do not list; 0 turns the queue off; and another workspace's task never shows
// (§H-TENANT). It only reads: listing writes nothing.
//
// SYNTHETIC BY CONSTRUCTION: the fixture workspaces and every task here are invented.

import test from 'node:test';
import assert from 'node:assert/strict';

import { makeContext } from '../../dist/core/context.js';
import { fixture } from '../api/conformance-contract.mjs';
import { mintWorkspace } from '../api/support.mjs';
import { attentionList } from '../../dist/core/attention/index.js';
import { ATTENTION_PROVIDERS } from '../../dist/core/attention/providers.js';
import { settingDef } from '../../dist/core/settings/index.js';

const ctxOf = (fx, workspaceId = fx.workspaceId) =>
  makeContext(fx.deps.store, { workspaceId, actor: fx.deps.actor ?? 'studio', clock: fx.deps.clock, ids: fx.deps.ids });

const dayFrom = (iso, days) => {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

const listed = (fx, workspaceId) => {
  const out = attentionList(ctxOf(fx, workspaceId), { queueId: 'tasks_due', limit: 50 });
  assert.equal(out.ok, true);
  return out.items;
};

const task = (fx, title, dueAt, extra = {}) => {
  const res = fx.call('tasks_create', { title, assigneeUserId: 'person-1', ...(dueAt === null ? {} : { dueAt }), idempotencyKey: `t:${title}`, ...extra });
  assert.ok(res.task?.id ?? res.taskId, `created ${title}`);
  return res.task?.id ?? res.taskId;
};

test('the setting: 14 days by default, 0 to 90, a D172 entry of the Pendenzen area', () => {
  const s = settingDef('attention.tasks_due_days');
  assert.equal(s.default, 14);
  assert.deepEqual(s.schema, { type: 'integer', min: 0, max: 90, unit: 'days' });
  assert.equal(s.area.id, 'G15');
});

test('the provider is registered as a `do` queue linking to /tasks', () => {
  const p = ATTENTION_PROVIDERS.find((x) => x.queueId === 'tasks_due');
  assert.ok(p, 'tasks_due is in the live registry');
  assert.equal(p.deepLinkRoute, '/tasks');
  assert.equal(p.kind, 'do');
});

test('due and overdue tasks list; done, undated, far and snoozed ones do not; listing writes nothing', () => {
  const fx = fixture();
  const today = fx.deps.clock.now();
  task(fx, 'Quittung ablegen', dayFrom(today, 3));
  task(fx, 'Offerte nachfassen', dayFrom(today, -2));
  task(fx, 'Irgendwann', null);
  task(fx, 'Weit weg', dayFrom(today, 40));
  const snoozed = task(fx, 'Später', dayFrom(today, 1));
  fx.call('tasks_snooze', { taskId: snoozed, until: `${dayFrom(today, 5)}T08:00:00.000Z`, idempotencyKey: 'snz' });
  const done = task(fx, 'Erledigt', dayFrom(today, 1));
  fx.call('tasks_complete', { taskId: done, idempotencyKey: 'cmp' });

  const before = fx.deps.store.db.prepare('SELECT COUNT(*) AS n FROM task').get().n;
  const items = listed(fx);
  assert.deepEqual(
    items.map((i) => [i.titleParams.title, i.urgency]),
    [
      ['Offerte nachfassen', 'overdue'],
      ['Quittung ablegen', 'due'],
    ],
  );
  assert.equal(items[0].deepLink.route, '/tasks');
  assert.equal(fx.deps.store.db.prepare('SELECT COUNT(*) AS n FROM task').get().n, before, 'reading wrote no task');
});

test('0 days turns the queue off; a wider window lists the far task', () => {
  const fx = fixture();
  const today = fx.deps.clock.now();
  task(fx, 'Bald', dayFrom(today, 2));
  task(fx, 'Weit weg', dayFrom(today, 40));
  fx.call('settings_set', { key: 'attention.tasks_due_days', value: 0, idempotencyKey: 'off' });
  assert.deepEqual(listed(fx), []);
  fx.call('settings_set', { key: 'attention.tasks_due_days', value: 60, idempotencyKey: 'wide' });
  assert.deepEqual(
    listed(fx).map((i) => i.titleParams.title),
    ['Bald', 'Weit weg'],
  );
});

test('§H-TENANT: another workspace never sees the tasks of this one', () => {
  const fx = fixture();
  const today = fx.deps.clock.now();
  task(fx, 'Nur hier', dayFrom(today, 1));
  const { workspaceId: other } = mintWorkspace(fx.deps, 'Zweite GmbH', 'ws-tasks-2');
  assert.deepEqual(listed(fx, other), []);
  assert.equal(listed(fx).length, 1);
});
