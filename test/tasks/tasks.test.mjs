/**
 * E03's engine behaviour, driven through the registry (both faces run the same `action.run`).
 *
 * The suite proves the spec's own §2 acceptance criteria: creation validation (reminder vs clock,
 * reminder vs due, the OP3 link, the recurrence gate), the editor semantics (reschedule clears a
 * snooze, reopen from done only), the composite completion (done + OP5 log + spawn under ONE
 * idempotency key, replay-safe), snooze/cancel, the derived buckets, the reminder predicate, the
 * in-engine assignee allowance on completion, and §H-TENANT isolation.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { makeContext } from '../../dist/core/context.js';
import { completeTask } from '../../dist/core/tasks/tasks.js';
import { freshDeps, mintWorkspace, AT } from '../api/support.mjs';

// The fixture clock is 2026-07-16T00:00:00.000Z (AT). Every "future" below is relative to it.
function world() {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  const call = (name, input) => getAction(name).run(deps, { workspaceId, ...input });
  return { deps, workspaceId, call };
}

function mkTask(call, overrides = {}, key = 'seed') {
  const res = call('tasks_create', {
    title: 'Offerte nachfassen',
    assigneeUserId: 'agent',
    idempotencyKey: `tt-${key}`,
    ...overrides,
  });
  assert.equal(res.ok, true, `tasks_create refused: ${JSON.stringify(res)}`);
  return res;
}

test('E03: creation validates the reminder against the clock and the due date', () => {
  const { call } = world();
  const past = call('tasks_create', { title: 'x', assigneeUserId: 'a', reminderAt: '2026-07-01', idempotencyKey: 'v1' });
  assert.equal(past.error, 'reminder_in_past');
  const after = call('tasks_create', {
    title: 'x', assigneeUserId: 'a', dueAt: '2026-08-01', reminderAt: '2026-08-02', idempotencyKey: 'v2',
  });
  assert.equal(after.error, 'reminder_after_due');
  // A same-day reminder against a DATE-ONLY due is legal: the due day counts to its end.
  const sameDay = call('tasks_create', {
    title: 'x', assigneeUserId: 'a', dueAt: '2026-08-01', reminderAt: '2026-08-01T10:00:00.000Z', idempotencyKey: 'v3',
  });
  assert.equal(sameDay.ok, true);
  // A PAST due date is legal (importing an overdue duty is honest): it lands in the overdue bucket.
  const overdue = mkTask(call, { dueAt: '2026-06-30' }, 'v4');
  assert.equal(overdue.task.dueAt, '2026-06-30');
  const listed = call('tasks_list', { bucket: 'overdue' });
  assert.deepEqual(listed.tasks.map((t) => t.id), [overdue.taskId]);
});

test('E03: the OP3 link is validated against the registry and the workspace (§H-TENANT both sides)', () => {
  const { call, deps } = world();
  const unknown = call('tasks_create', {
    title: 'x', assigneeUserId: 'a', entityKind: 'unicorn', entityId: 'u-1', idempotencyKey: 'l1',
  });
  assert.equal(unknown.error, 'unknown_entity_kind');
  const missing = call('tasks_create', {
    title: 'x', assigneeUserId: 'a', entityKind: 'contact', entityId: 'nope', idempotencyKey: 'l2',
  });
  assert.equal(missing.error, 'entity_not_found');
  const half = call('tasks_create', { title: 'x', assigneeUserId: 'a', entityKind: 'contact', idempotencyKey: 'l3' });
  assert.equal(half.error, 'invalid_input');

  // A contact in ANOTHER workspace is `entity_not_found`, not a link: the same answer a nonexistent
  // id gets, so no id can be probed across tenants.
  const other = getAction('create_workspace').run(deps, { name: 'Fremd GmbH', idempotencyKey: 'ws-2' });
  const foreign = getAction('create_contact').run(deps, {
    workspaceId: other.workspaceId, partyRole: 'customer', name: 'Fremd AG', idempotencyKey: 'l4',
  });
  const cross = call('tasks_create', {
    title: 'x', assigneeUserId: 'a', entityKind: 'contact', entityId: foreign.contact.id, idempotencyKey: 'l5',
  });
  assert.equal(cross.error, 'entity_not_found');
});

test('E03: the recurrence gate refuses what it must and stores nothing invalid', () => {
  const { call } = world();
  assert.equal(call('tasks_create', { title: 'x', assigneeUserId: 'a', dueAt: '2026-08-01', recurrenceRule: 'FREQ=SOMETIMES', idempotencyKey: 'r1' }).error, 'recurrence_invalid');
  // A rule with no due date has no cadence to keep.
  assert.equal(call('tasks_create', { title: 'x', assigneeUserId: 'a', recurrenceRule: 'FREQ=MONTHLY', idempotencyKey: 'r2' }).error, 'recurrence_invalid');
  // UNTIL already behind the anchor yields no future occurrence at creation.
  assert.equal(call('tasks_create', { title: 'x', assigneeUserId: 'a', dueAt: '2026-08-01', recurrenceRule: 'FREQ=MONTHLY;UNTIL=2026-07-01', idempotencyKey: 'r3' }).error, 'recurrence_invalid');
});

test('E03: the editor reschedules (clearing a snooze), retitles, and reopens from done only', () => {
  const { call } = world();
  const t = mkTask(call, { dueAt: '2026-08-10', reminderAt: '2026-08-01' }, 'e1');
  assert.equal(call('tasks_snooze', { taskId: t.taskId, until: '2026-08-03', idempotencyKey: 'e-sn' }).ok, true);

  // A new deadline supersedes an old snooze.
  const moved = call('tasks_update', { taskId: t.taskId, patch: { dueAt: '2026-08-20', title: 'Verschoben' }, idempotencyKey: 'e-up' });
  assert.equal(moved.ok, true);
  assert.equal(moved.task.dueAt, '2026-08-20');
  assert.equal(moved.task.snoozedUntil, null);
  assert.equal(moved.task.title, 'Verschoben');

  // Moving the deadline UNDER an existing reminder is refused, not silently inconsistent.
  assert.equal(call('tasks_update', { taskId: t.taskId, patch: { dueAt: '2026-07-20' }, idempotencyKey: 'e-bad' }).error, 'reminder_after_due');

  // done -> open is the one reopen; cancelled is terminal; done -> doing skips the reopen and is refused.
  const done = call('tasks_complete', { taskId: t.taskId, idempotencyKey: 'e-done' });
  assert.equal(done.ok, true);
  assert.equal(call('tasks_update', { taskId: t.taskId, patch: { title: 'Nachtrag' }, idempotencyKey: 'e-edit-done' }).error, 'task_not_open');
  assert.equal(call('tasks_update', { taskId: t.taskId, patch: { status: 'doing' }, idempotencyKey: 'e-doing' }).error, 'invalid_status_transition');
  const reopened = call('tasks_update', { taskId: t.taskId, patch: { status: 'open' }, idempotencyKey: 'e-reopen' });
  assert.equal(reopened.ok, true);
  assert.equal(reopened.task.completedAt, null);

  const x = mkTask(call, {}, 'e2');
  assert.equal(call('tasks_cancel', { taskId: x.taskId, idempotencyKey: 'e-cx' }).ok, true);
  assert.equal(call('tasks_update', { taskId: x.taskId, patch: { status: 'open' }, idempotencyKey: 'e-cx2' }).error, 'invalid_status_transition');
});

test('E03: completion is the composite write: done + OP5 log + spawn, replay-safe under ONE key', () => {
  const { call, deps, workspaceId } = world();
  const c = call('create_contact', { partyRole: 'customer', name: 'Serie GmbH', idempotencyKey: 'c-1' });
  const t = mkTask(call, {
    dueAt: '2026-07-31T09:00:00.000Z',
    reminderAt: '2026-07-29T09:00:00.000Z',
    entityKind: 'contact',
    entityId: c.contact.id,
    recurrenceRule: 'FREQ=MONTHLY',
  }, 'cp1');

  const done = call('tasks_complete', { taskId: t.taskId, logActivity: true, idempotencyKey: 'cp-done' });
  assert.equal(done.ok, true);
  assert.equal(done.task.status, 'done');
  assert.equal(done.task.completedAt, AT);
  assert.equal(done.seriesEnded, false);
  assert.notEqual(done.spawnedTaskId, null);
  assert.notEqual(done.activityId, null);

  // The OP5 entry landed through C00's own verb, on the contact's timeline, kind `task`.
  const timeline = call('contacts_timeline', { contactId: c.contact.id });
  const entries = timeline.activities.filter((a) => a.kind === 'task');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].body, 'Offerte nachfassen');

  // The successor: same title/link/rule, chained, due anchored on the COMPLETED due (not on now),
  // reminder shifted by the same offset (two days here).
  const spawned = call('tasks_list', { bucket: 'upcoming' }).tasks.find((x) => x.id === done.spawnedTaskId);
  assert.equal(spawned.dueAt, '2026-08-31T09:00:00.000Z');
  assert.equal(spawned.reminderAt, '2026-08-29T09:00:00.000Z');
  assert.equal(spawned.recurrenceParentId, t.taskId);
  assert.equal(spawned.recurrenceRule, 'FREQ=MONTHLY');
  assert.equal(spawned.entityId, c.contact.id);

  // THE REPLAY: the same key answers the SAME result and neither double-logs nor double-spawns.
  const replay = call('tasks_complete', { taskId: t.taskId, logActivity: true, idempotencyKey: 'cp-done' });
  assert.deepEqual(replay, done);
  const rows = deps.store.db.prepare('SELECT COUNT(*) AS n FROM task WHERE workspace_id = ?').get(workspaceId);
  assert.equal(rows.n, 2, 'the replay spawned a second successor');
  assert.equal(call('contacts_timeline', { contactId: c.contact.id }).activities.filter((a) => a.kind === 'task').length, 1);

  // A FRESH completion attempt on the already-done row is task_not_open.
  assert.equal(call('tasks_complete', { taskId: t.taskId, idempotencyKey: 'cp-again' }).error, 'task_not_open');
});

test('E03: COUNT terminates by chain length and UNTIL by date, answering seriesEnded exactly once', () => {
  const { call } = world();
  // COUNT=2: the anchor plus one spawn. Completing the SECOND spawns nothing.
  const a = mkTask(call, { dueAt: '2026-08-01', recurrenceRule: 'FREQ=DAILY;COUNT=2' }, 'cnt');
  const first = call('tasks_complete', { taskId: a.taskId, idempotencyKey: 'cnt-1' });
  assert.notEqual(first.spawnedTaskId, null);
  const second = call('tasks_complete', { taskId: first.spawnedTaskId, idempotencyKey: 'cnt-2' });
  assert.equal(second.spawnedTaskId, null);
  assert.equal(second.seriesEnded, true);

  // UNTIL: the next occurrence would fall past it, so the series ends on completion.
  const b = mkTask(call, { dueAt: '2026-08-01', recurrenceRule: 'FREQ=MONTHLY;UNTIL=2026-08-15' }, 'unt');
  const ended = call('tasks_complete', { taskId: b.taskId, idempotencyKey: 'unt-1' });
  assert.equal(ended.spawnedTaskId, null);
  assert.equal(ended.seriesEnded, true);
});

test('E03: snooze hides the reminder without moving the deadline; cancel is terminal and spawns nothing', () => {
  const { call } = world();
  const u = mkTask(call, { dueAt: '2026-08-10', reminderAt: '2026-07-20' }, 'sn1');

  assert.equal(call('tasks_snooze', { taskId: u.taskId, until: '2026-07-01', idempotencyKey: 'sn-past' }).error, 'snooze_in_past');
  const snoozed = call('tasks_snooze', { taskId: u.taskId, until: '2026-07-25', idempotencyKey: 'sn-ok' });
  assert.equal(snoozed.ok, true);
  assert.equal(snoozed.task.dueAt, '2026-08-10', 'snooze moved the deadline');

  // Snoozed out of the poll set until the snooze expires.
  assert.equal(call('tasks_reminders_due', { asOf: '2026-07-21T00:00:00.000Z' }).items.length, 0);
  assert.equal(call('tasks_reminders_due', { asOf: '2026-07-25T00:00:00.000Z' }).items.length, 1);

  // Cancel: terminal, invisible to the default list, and a recurring cancel spawns NOTHING.
  const r = mkTask(call, { dueAt: '2026-08-01', recurrenceRule: 'FREQ=DAILY' }, 'sn2');
  const cancelled = call('tasks_cancel', { taskId: r.taskId, idempotencyKey: 'sn-cx' });
  assert.equal(cancelled.task.status, 'cancelled');
  assert.equal(cancelled.spawnedTaskId, undefined);
  assert.equal(call('tasks_list', {}).tasks.some((x) => x.id === r.taskId), false);
  assert.equal(call('tasks_list', { status: 'cancelled' }).tasks.some((x) => x.id === r.taskId), true);
});

test('E03: buckets derive from due_at against the clock day, at query time', () => {
  const { call } = world();
  const overdue = mkTask(call, { dueAt: '2026-07-15' }, 'b1');
  const today = mkTask(call, { dueAt: '2026-07-16T15:00:00.000Z' }, 'b2');
  const upcoming = mkTask(call, { dueAt: '2026-07-17' }, 'b3');
  const dateless = mkTask(call, {}, 'b4');
  const byBucket = (bucket) => call('tasks_list', { bucket }).tasks.map((t) => t.id);
  assert.deepEqual(byBucket('overdue'), [overdue.taskId]);
  assert.deepEqual(byBucket('today'), [today.taskId]);
  assert.deepEqual(byBucket('upcoming'), [upcoming.taskId, dateless.taskId]);
  assert.deepEqual(byBucket('done'), []);
  call('tasks_complete', { taskId: today.taskId, idempotencyKey: 'b-done' });
  assert.deepEqual(byBucket('done'), [today.taskId]);
});

test('E03: the reminder predicate: due, live, and not snoozed; done and snoozed tasks never appear', () => {
  const { call } = world();
  const due = mkTask(call, { dueAt: '2026-08-01', reminderAt: '2026-07-20' }, 'p1');
  const later = mkTask(call, { dueAt: '2026-09-01', reminderAt: '2026-08-20' }, 'p2');
  const noReminder = mkTask(call, { dueAt: '2026-07-01' }, 'p3');
  assert.equal(noReminder.ok, true);

  const at = (asOf) => call('tasks_reminders_due', { asOf }).items.map((i) => i.id);
  assert.deepEqual(at('2026-07-19T00:00:00.000Z'), []);
  assert.deepEqual(at('2026-07-20T00:00:00.000Z'), [due.taskId]);
  assert.deepEqual(at('2026-08-20T12:00:00.000Z'), [due.taskId, later.taskId]);

  call('tasks_complete', { taskId: due.taskId, idempotencyKey: 'p-done' });
  assert.deepEqual(at('2026-08-20T12:00:00.000Z'), [later.taskId], 'a done task stayed in the poll set');

  // An empty poll answers { items: [] }, no special-casing for agents.
  const empty = call('tasks_reminders_due', { asOf: '2026-07-01T00:00:00.000Z' });
  assert.deepEqual(empty.items, []);
});

test('E03: completion is allowed for the assignee WITHOUT tasks.write, and refused for anyone else (in-engine)', () => {
  const { call, deps, workspaceId } = world();
  const t = mkTask(call, { assigneeUserId: 'worker-1' }, 'perm');
  const denyAll = { assert: (capability) => ({ ok: false, error: 'permission_denied', capability }) };

  const stranger = makeContext(deps.store, { workspaceId, actor: 'stranger', clock: deps.clock, ids: deps.ids, capabilities: denyAll });
  const refused = completeTask(stranger, { taskId: t.taskId });
  assert.equal(refused.error, 'permission_denied');
  assert.equal(refused.capability, 'tasks.write');

  const assignee = makeContext(deps.store, { workspaceId, actor: 'worker-1', clock: deps.clock, ids: deps.ids, capabilities: denyAll });
  const done = completeTask(assignee, { taskId: t.taskId });
  assert.equal(done.ok, true, `the assignee was refused: ${JSON.stringify(done)}`);
});

test('E03: §H-TENANT: no read or write crosses workspaces', () => {
  const { call, deps } = world();
  const mine = mkTask(call, { dueAt: '2026-08-01', reminderAt: '2026-07-20' }, 'ten');

  const other = getAction('create_workspace').run(deps, { name: 'Fremd GmbH', idempotencyKey: 'ws-t2' });
  const theirs = (name, input) => getAction(name).run(deps, { workspaceId: other.workspaceId, ...input });

  assert.deepEqual(theirs('tasks_list', {}).tasks, []);
  assert.deepEqual(theirs('tasks_reminders_due', { asOf: '2026-07-21T00:00:00.000Z' }).items, []);
  // Every write against my task id from their workspace answers not_found, never a leak.
  assert.equal(theirs('tasks_update', { taskId: mine.taskId, patch: { title: 'x' }, idempotencyKey: 'ten-1' }).error, 'not_found');
  assert.equal(theirs('tasks_complete', { taskId: mine.taskId, idempotencyKey: 'ten-2' }).error, 'not_found');
  assert.equal(theirs('tasks_snooze', { taskId: mine.taskId, until: '2026-07-25', idempotencyKey: 'ten-3' }).error, 'not_found');
  assert.equal(theirs('tasks_cancel', { taskId: mine.taskId, idempotencyKey: 'ten-4' }).error, 'not_found');
});

test('E03: §H-ATOMIC: a failed OP5 half rolls back BOTH the completion AND its audit row (task stays open)', () => {
  const { call, deps, workspaceId } = world();
  // A task legitimately linked to a real contact at creation time.
  const c = call('create_contact', { partyRole: 'customer', name: 'Rollback GmbH', idempotencyKey: 'rb-c' });
  const t = mkTask(call, { entityKind: 'contact', entityId: c.contact.id }, 'rb');

  // Force the composite OP5 half to fail: remove the contact so `logActivity` answers `not_found`
  // when completion tries to append the timeline entry. The refusal must fail the WHOLE composite
  // (spec comment: "done and logged" was the request, and half of it did not happen), and leave the
  // task open with NO audit trace, not a done task whose verb merely reported failure.
  const saved = deps.store.db.prepare('SELECT * FROM contact WHERE workspace_id = ? AND id = ?').get(workspaceId, c.contact.id);
  deps.store.db.prepare('DELETE FROM contact WHERE workspace_id = ? AND id = ?').run(workspaceId, c.contact.id);

  const done = call('tasks_complete', { taskId: t.taskId, logActivity: true, idempotencyKey: 'rb-done' });
  assert.equal(done.ok, false, 'the whole composite fails when the OP5 half cannot be written');
  assert.equal(done.error, 'not_found', 'the failure surfaced is the OP5 half own cause');

  // The task is STILL open: the UPDATE to `done` rolled back with the failed half.
  const row = deps.store.db
    .prepare('SELECT status, completed_at FROM task WHERE workspace_id = ? AND id = ?')
    .get(workspaceId, t.taskId);
  assert.equal(row.status, 'open', 'the completion rolled back: the task is still open');
  assert.equal(row.completed_at, null, 'no completion timestamp was committed');

  // NO audit row for the completion: the `complete` audit recorded at ~line 421 rolled back too.
  const audit = deps.store.db
    .prepare("SELECT COUNT(*) AS n FROM audit_log WHERE workspace_id = ? AND entity_id = ? AND action = 'complete'")
    .get(workspaceId, t.taskId);
  assert.equal(audit.n, 0, 'the completion audit row rolled back with the completion');

  // §H-TENANT: another workspace neither sees nor is touched by this failed completion.
  const other = getAction('create_workspace').run(deps, { name: 'Neben GmbH', idempotencyKey: 'rb-ws2' });
  const theirAudit = deps.store.db
    .prepare("SELECT COUNT(*) AS n FROM audit_log WHERE workspace_id = ? AND action = 'complete'")
    .get(other.workspaceId);
  assert.equal(theirAudit.n, 0, 'the audit query is workspace-scoped; the neighbour has no completion rows');

  // NOT WEDGED BY A MEMOIZED FAILURE: restore the contact and retry under the SAME key. If the failed
  // completion had memoised its `not_found` (the partial-commit bug), this replay would answer the
  // stale failure. The rollback memoised nothing, so completion recomputes and succeeds.
  const cols = Object.keys(saved);
  deps.store.db
    .prepare(`INSERT INTO contact (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
    .run(...cols.map((k) => saved[k]));
  const retry = call('tasks_complete', { taskId: t.taskId, logActivity: true, idempotencyKey: 'rb-done' });
  assert.equal(retry.ok, true, `the retry completes once the contact is restored: ${JSON.stringify(retry)}`);
  assert.equal(retry.task.status, 'done');
});
