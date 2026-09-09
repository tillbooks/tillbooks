/**
 * E03, tasks & reminders: the cross-entity to-do spine and its two read models.
 *
 * WHAT THIS MODULE IS. Every operational flow ends in "someone must do something by a date", and
 * this is the ONE queue it lands in: assignments, due/overdue buckets, an RFC-5545-subset
 * recurrence, snooze, and `tasksRemindersDue`, the SINGLE reminder-trigger surface C01, A16 and
 * G06 poll (spec §4). None of them gets a private reminder loop, and E03 itself stops at the read
 * model: delivery (bell, e-mail, push) is G06's, and E03 imports no transport of any kind.
 *
 * WHAT THIS MODULE IS NOT. It never touches the journal: no `_rappen` column, no `postEntry`, no
 * `recordPayment` (asserted by `test/tasks/no-money-path.test.mjs`, spec §4 "Money correctness").
 * The OP3 link is validated against G00's entity registry exactly the way E00's `files_link` does
 * it, and the OP5 completion log goes through C00's `logActivity` verb, never a direct INSERT into
 * `contact_activity`.
 *
 * TENANCY (§H-TENANT): every query below filters on `ctx.workspaceId`, including the existence
 * check behind the OP3 link, so a foreign task id answers the same `not_found` a nonexistent one
 * does and no id can be probed across tenants.
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { entityKindDef, ENTITY_KIND_IDS, tenantColumnOf } from '../customization/entities.js';
import { applySavedView } from '../customization/views.js';
import { logActivity } from '../sales/contactActivity.js';
import { isTaskBucket, isTaskStatus, TASK_STATUSES } from './enums.js';
import type { TaskBucket, TaskStatus } from './enums.js';
import { nextOccurrenceDay, parseTaskRecurrence } from './recurrence.js';
import type { TaskRecurrence } from './recurrence.js';

/**
 * Abort a write transaction with a structured cause. A better-sqlite3 `db.transaction(fn)()` commits
 * unless the callback THROWS: a plain `return logged` from inside the composite would COMMIT the
 * completion and its audit row (and memoise them under the idempotency key) even though the verb is
 * about to report failure. Throwing this is the ONLY way to roll the whole composite back as an atom.
 */
class TaskAbort {
  constructor(public readonly result: Result) {}
}

/** Run `body` and translate a `TaskAbort` thrown to escape the tx back into its failure Result. */
function runGuarded(body: () => Result): Result {
  try {
    return body();
  } catch (e) {
    if (e instanceof TaskAbort) return e.result;
    throw e;
  }
}

export interface TaskRow {
  id: string;
  workspace_id: string;
  title: string;
  notes: string | null;
  assignee_user_id: string;
  created_by_user_id: string;
  due_at: string | null;
  reminder_at: string | null;
  snoozed_until: string | null;
  status: string;
  entity_kind: string | null;
  entity_id: string | null;
  recurrence_rule: string | null;
  recurrence_parent_id: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

/** The one wire shape every verb answers a task with, so five verbs cannot drift apart (P5). */
export interface TaskView {
  id: string;
  title: string;
  notes: string | null;
  assigneeUserId: string;
  createdByUserId: string;
  dueAt: string | null;
  reminderAt: string | null;
  snoozedUntil: string | null;
  status: string;
  entityKind: string | null;
  entityId: string | null;
  recurrenceRule: string | null;
  recurrenceParentId: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export function mapTask(row: TaskRow): TaskView {
  return {
    id: row.id,
    title: row.title,
    notes: row.notes,
    assigneeUserId: row.assignee_user_id,
    createdByUserId: row.created_by_user_id,
    dueAt: row.due_at,
    reminderAt: row.reminder_at,
    snoozedUntil: row.snoozed_until,
    status: row.status,
    entityKind: row.entity_kind,
    entityId: row.entity_id,
    recurrenceRule: row.recurrence_rule,
    recurrenceParentId: row.recurrence_parent_id,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function readTask(ctx: WorkspaceContext, taskId: string): TaskRow | undefined {
  if (typeof taskId !== 'string' || taskId.length === 0) return undefined;
  return ctx.store.db
    .prepare('SELECT * FROM task WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, taskId) as TaskRow | undefined;
}

const DAY_MS = 86_400_000;
const LIVE_STATUSES: readonly string[] = ['open', 'doing'];

/** A sortable ISO day or instant: `YYYY-MM-DD` prefix and parseable. Refused, never coerced. */
function isValidInstant(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}/.test(value)) return false;
  const parsed = value.length === 10 ? Date.parse(`${value}T00:00:00Z`) : Date.parse(value);
  return !Number.isNaN(parsed);
}

/** Epoch ms of an ISO day (midnight UTC) or instant. Callers have validated with `isValidInstant`. */
function msOf(value: string): number {
  return value.length === 10 ? Date.parse(`${value}T00:00:00Z`) : Date.parse(value);
}

/**
 * Epoch ms of a due date for the `reminder_after_due` comparison: a DATE-ONLY due counts as the
 * END of its day, so "remind me at 10:00 on the day it is due" is legal against a day-granular
 * deadline. The overdue bucket agrees: a date-only due is overdue starting the NEXT day.
 */
function dueEndMsOf(value: string): number {
  return value.length === 10 ? msOf(value) + DAY_MS - 1 : msOf(value);
}

interface DatesCheck {
  error?: Result;
}

/** The shared reminder-vs-clock and reminder-vs-due validation (create and update alike). */
function checkReminder(ctx: WorkspaceContext, reminderAt: string, dueAt: string | null): DatesCheck {
  if (!isValidInstant(reminderAt)) return { error: err('invalid_input', { field: 'reminderAt' }) };
  const now = Date.parse(ctx.clock.now());
  if (msOf(reminderAt) < now) return { error: err('reminder_in_past', { reminderAt, now: ctx.clock.now() }) };
  if (dueAt !== null && msOf(reminderAt) > dueEndMsOf(dueAt)) {
    return { error: err('reminder_after_due', { reminderAt, dueAt }) };
  }
  return {};
}

/**
 * Validate a recurrence rule against the due date it will anchor on. Returns the parsed rule, or
 * the ONE structured refusal (`recurrence_invalid`) with the reason named: nothing invalid is ever
 * stored (US-E03.3).
 */
function checkRecurrence(rule: string, dueAt: string | null): { parsed?: TaskRecurrence; error?: Result } {
  const parsed = parseTaskRecurrence(rule);
  if (parsed === undefined) return { error: err('recurrence_invalid', { rule }) };
  if (dueAt === null) {
    // The next occurrence is computed FROM the due date (spec §4), so a series with no anchor has
    // no cadence to keep: refused rather than silently a one-off.
    return { error: err('recurrence_invalid', { rule, reason: 'due_at_required' }) };
  }
  if (parsed.until !== undefined && parsed.until < dueAt.slice(0, 10)) {
    // UNTIL already behind the anchor yields no future occurrence at creation (US-E03.3 Empty).
    return { error: err('recurrence_invalid', { rule, reason: 'until_before_due' }) };
  }
  return { parsed };
}

/**
 * Prove an OP3 link target is real, workspace-scoped on both sides (the `files_link` pattern).
 * The column names are interpolated from G00's compile-time registry row, never from the caller.
 */
function checkEntityLink(ctx: WorkspaceContext, entityKind: string, entityId: unknown): Result | undefined {
  const def = entityKindDef(entityKind);
  if (def === undefined) {
    return err('unknown_entity_kind', { entityKind, known: [...ENTITY_KIND_IDS] });
  }
  if (typeof entityId !== 'string' || entityId.length === 0) {
    return err('invalid_input', { field: 'entityId' });
  }
  const target = ctx.store.db
    .prepare(`SELECT ${def.idColumn} AS id FROM ${def.table} WHERE ${tenantColumnOf(def)} = ? AND ${def.idColumn} = ?`)
    .get(ctx.workspaceId, entityId);
  if (target === undefined) return err('entity_not_found', { entityKind: def.kind, entityId });
  return undefined;
}

export interface CreateTaskInput {
  title: string;
  notes?: string;
  assigneeUserId: string;
  dueAt?: string;
  reminderAt?: string;
  entityKind?: string;
  entityId?: string;
  recurrenceRule?: string;
  idempotencyKey?: string;
}

export function createTask(ctx: WorkspaceContext, input: CreateTaskInput): Result {
  if (typeof input.title !== 'string' || input.title.trim().length === 0) {
    return err('invalid_input', { field: 'title' });
  }
  if (typeof input.assigneeUserId !== 'string' || input.assigneeUserId.length === 0) {
    return err('invalid_input', { field: 'assigneeUserId' });
  }
  const dueAt = input.dueAt ?? null;
  if (dueAt !== null && !isValidInstant(dueAt)) return err('invalid_input', { field: 'dueAt' });
  // A PAST due date is legal (importing an already-overdue duty is honest, US-E03.1 Boundary); a
  // past reminder is not: it would fire the instant it lands, which nobody asked for.
  if (input.reminderAt !== undefined) {
    const check = checkReminder(ctx, input.reminderAt, dueAt);
    if (check.error !== undefined) return check.error;
  }
  if ((input.entityKind === undefined) !== (input.entityId === undefined)) {
    return err('invalid_input', { field: input.entityKind === undefined ? 'entityKind' : 'entityId' });
  }
  if (input.entityKind !== undefined) {
    const refused = checkEntityLink(ctx, input.entityKind, input.entityId);
    if (refused !== undefined) return refused;
  }
  if (input.recurrenceRule !== undefined) {
    const check = checkRecurrence(input.recurrenceRule, dueAt);
    if (check.error !== undefined) return check.error;
  }

  const run = (): Result => {
    const id = ctx.ids.next('task');
    const now = ctx.clock.now();
    ctx.store.db
      .prepare(
        `INSERT INTO task (
           id, workspace_id, title, notes, assignee_user_id, created_by_user_id,
           due_at, reminder_at, snoozed_until, status, entity_kind, entity_id,
           recurrence_rule, recurrence_parent_id, completed_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'open', ?, ?, ?, NULL, NULL, ?, ?)`,
      )
      .run(
        id,
        ctx.workspaceId,
        input.title.trim(),
        input.notes ?? null,
        input.assigneeUserId,
        ctx.actor,
        dueAt,
        input.reminderAt ?? null,
        input.entityKind ?? null,
        input.entityId ?? null,
        input.recurrenceRule ?? null,
        now,
        now,
      );
    // The Periods audit vocabulary's own words, not verb names: `create` is what every other
    // capability stamps for a minted row.
    ctx.audit.record({ entityKind: 'task', entityId: id, action: 'create', actor: ctx.actor, at: now });
    return ok({ taskId: id, task: mapTask(readTask(ctx, id) as TaskRow) });
  };

  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'tasks_create', run);
  }
  return ctx.store.tx(run);
}

export interface UpdateTaskPatch {
  title?: string;
  notes?: string | null;
  assigneeUserId?: string;
  dueAt?: string | null;
  reminderAt?: string | null;
  recurrenceRule?: string | null;
  status?: string;
}

/**
 * The ONE editor verb behind the row's `Bearbeiten` affordance: reschedule, retitle, reassign,
 * re-rule, and the explicit `done -> open` reopen (spec §4). Patching `dueAt` clears
 * `snoozed_until`: a new deadline supersedes an old snooze (US-E03.5).
 */
export function updateTask(
  ctx: WorkspaceContext,
  input: { taskId: string; patch: UpdateTaskPatch; idempotencyKey?: string },
): Result {
  const row = readTask(ctx, input.taskId);
  if (row === undefined) return err('not_found', { taskId: input.taskId });
  const patch = input.patch;
  if (patch === null || typeof patch !== 'object') return err('invalid_input', { field: 'patch' });

  // The status leg first, because it decides whether the rest of the patch is legal at all.
  let nextStatus = row.status as TaskStatus;
  if (patch.status !== undefined) {
    if (!isTaskStatus(patch.status)) {
      return err('invalid_input', { field: 'status', allowed: [...TASK_STATUSES] });
    }
    const legal =
      (LIVE_STATUSES.includes(row.status) && (patch.status === 'open' || patch.status === 'doing')) ||
      // The explicit reopen, from done only (§4): cancel stays terminal, and done -> doing without
      // passing open would silently skip the reopen the audit trail records.
      (row.status === 'done' && patch.status === 'open');
    if (!legal) return err('invalid_status_transition', { from: row.status, to: patch.status });
    nextStatus = patch.status;
  } else if (!LIVE_STATUSES.includes(row.status)) {
    // A finished task is not edited in place: reopen it first (done), or create a new one (cancelled).
    return err('task_not_open', { taskId: row.id, status: row.status });
  }

  if (patch.title !== undefined && (typeof patch.title !== 'string' || patch.title.trim().length === 0)) {
    return err('invalid_input', { field: 'title' });
  }
  if (patch.assigneeUserId !== undefined && (typeof patch.assigneeUserId !== 'string' || patch.assigneeUserId.length === 0)) {
    return err('invalid_input', { field: 'assigneeUserId' });
  }

  const dueTouched = 'dueAt' in patch;
  const nextDue = dueTouched ? (patch.dueAt ?? null) : row.due_at;
  if (nextDue !== null && !isValidInstant(nextDue)) return err('invalid_input', { field: 'dueAt' });

  const reminderTouched = 'reminderAt' in patch;
  const nextReminder = reminderTouched ? (patch.reminderAt ?? null) : row.reminder_at;
  if (reminderTouched && nextReminder !== null) {
    const check = checkReminder(ctx, nextReminder, nextDue);
    if (check.error !== undefined) return check.error;
  } else if (dueTouched && nextReminder !== null && nextDue !== null && msOf(nextReminder) > dueEndMsOf(nextDue)) {
    // Moving the deadline under an existing reminder would leave a reminder after the due date.
    return err('reminder_after_due', { reminderAt: nextReminder, dueAt: nextDue });
  }

  const ruleTouched = 'recurrenceRule' in patch;
  const nextRule = ruleTouched ? (patch.recurrenceRule ?? null) : row.recurrence_rule;
  if (nextRule !== null && (ruleTouched || dueTouched)) {
    const check = checkRecurrence(nextRule, nextDue);
    if (check.error !== undefined) return check.error;
  }

  const run = (): Result => {
    const now = ctx.clock.now();
    const reopened = row.status === 'done' && nextStatus === 'open';
    ctx.store.db
      .prepare(
        `UPDATE task
            SET title = ?, notes = ?, assignee_user_id = ?, due_at = ?, reminder_at = ?,
                recurrence_rule = ?, status = ?, completed_at = ?, snoozed_until = ?, updated_at = ?
          WHERE workspace_id = ? AND id = ?`,
      )
      .run(
        patch.title !== undefined ? patch.title.trim() : row.title,
        'notes' in patch ? (patch.notes ?? null) : row.notes,
        patch.assigneeUserId ?? row.assignee_user_id,
        nextDue,
        nextReminder,
        nextRule,
        nextStatus,
        reopened ? null : row.completed_at,
        // A new deadline supersedes an old snooze (US-E03.5); an untouched deadline keeps it.
        dueTouched ? null : row.snoozed_until,
        now,
        ctx.workspaceId,
        row.id,
      );
    // `reopen` is its own word (spec §4: the done -> open transition is "logged in audit_log"),
    // because reading the one resurrection of a finished duty as a plain `update` years later
    // would understate exactly the act the log exists to stamp.
    ctx.audit.record({
      entityKind: 'task',
      entityId: row.id,
      action: reopened ? 'reopen' : 'update',
      actor: ctx.actor,
      at: now,
    });
    return ok({ taskId: row.id, task: mapTask(readTask(ctx, row.id) as TaskRow) });
  };

  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'tasks_update', run);
  }
  return ctx.store.tx(run);
}

/** Chain length up to the series anchor: how many occurrences exist up to and including `row`. */
function occurrenceIndexOf(ctx: WorkspaceContext, row: TaskRow): number {
  let index = 1;
  let parentId = row.recurrence_parent_id;
  // Bounded: a chain is finite by construction (each hop was minted by a completion), but a data
  // defect must degrade to "series over" rather than an infinite loop.
  while (parentId !== null && index < 10_000) {
    const parent = ctx.store.db
      .prepare('SELECT recurrence_parent_id FROM task WHERE workspace_id = ? AND id = ?')
      .get(ctx.workspaceId, parentId) as { recurrence_parent_id: string | null } | undefined;
    if (parent === undefined) break;
    index += 1;
    parentId = parent.recurrence_parent_id;
  }
  return index;
}

/**
 * The composite write (US-E03.2/3): complete + optional OP5 log + recurrence spawn, under ONE
 * idempotency key, so a replay never double-logs the activity or double-spawns the successor.
 *
 * PERMISSION (asserted IN-ENGINE, the `unlock_period` shape): completion takes `tasks.write` OR
 * being the assignee. The A24 boundary cannot express OR-assignee (it sees the input, never the
 * row), so `tasks_complete` is declared `ungated('asserted_in_engine')` and THIS is the assert.
 */
export function completeTask(
  ctx: WorkspaceContext,
  input: { taskId: string; logActivity?: boolean; idempotencyKey?: string },
): Result {
  // Replay FIRST (the `recallIdempotent` pattern): a retried completion must answer the original
  // result rather than `task_not_open` on the row it itself completed.
  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    const prior = ctx.store.recallIdempotent<Result>(ctx.workspaceId, input.idempotencyKey, 'tasks_complete');
    if (prior !== undefined) return prior;
  }

  const row = readTask(ctx, input.taskId);
  if (row === undefined) return err('not_found', { taskId: input.taskId });

  const allowed = ctx.capabilities.assert('tasks.write');
  if (!allowed.ok && ctx.actor !== row.assignee_user_id) return allowed;

  if (!LIVE_STATUSES.includes(row.status)) return err('task_not_open', { taskId: row.id, status: row.status });

  const run = (): Result => {
    const now = ctx.clock.now();
    ctx.store.db
      .prepare(
        `UPDATE task SET status = 'done', completed_at = ?, updated_at = ?
          WHERE workspace_id = ? AND id = ?`,
      )
      .run(now, now, ctx.workspaceId, row.id);
    ctx.audit.record({ entityKind: 'task', entityId: row.id, action: 'complete', actor: ctx.actor, at: now });

    // OP5: iff linked to a contact and asked for. E03 never writes `contact_activity` itself; the
    // C00 verb owns the append (and the merge-chain re-point that comes with it). `deal` joins when
    // C01 registers its kind. A refusal here fails the whole composite, which is the honest answer:
    // "done and logged" was the request, and half of it did not happen.
    let activityId: string | null = null;
    if (input.logActivity === true && row.entity_kind === 'contact' && row.entity_id !== null) {
      const logged = logActivity(ctx, { contactId: row.entity_id, kind: 'task', body: row.title });
      // The throw is the ONLY abort that rolls the tx back: a plain `return logged` would COMMIT the
      // completion and its audit row while the verb reports failure. A refused OP5 half fails the
      // whole composite, so "done and logged" is all-or-nothing (the completion + audit roll back too).
      if (!logged.ok) throw new TaskAbort(logged);
      activityId = (logged as { activity?: { id?: string } }).activity?.id ?? null;
    }

    // The recurrence spawn, anchored on the completed task's OWN due date so cadence never drifts
    // (US-E03.3). The stored rule is always parseable (nothing invalid is ever stored), but a
    // defensive parse failure degrades to "series over" rather than a throw.
    let spawnedTaskId: string | null = null;
    let seriesEnded = false;
    if (row.recurrence_rule !== null) {
      const rule = parseTaskRecurrence(row.recurrence_rule);
      const nextDay =
        rule === undefined || row.due_at === null ? undefined : nextOccurrenceDay(rule, row.due_at);
      const countExhausted =
        rule?.count !== undefined && occurrenceIndexOf(ctx, row) >= rule.count;
      if (nextDay === undefined || countExhausted) {
        seriesEnded = true;
      } else {
        // Re-attach the anchor's time-of-day, and shift the reminder by the same due-to-reminder
        // offset the completed occurrence carried.
        const timePart = (row.due_at as string).length > 10 ? (row.due_at as string).slice(10) : '';
        const nextDue = `${nextDay}${timePart}`;
        let nextReminder: string | null = null;
        if (row.reminder_at !== null) {
          const offset = msOf(row.due_at as string) - msOf(row.reminder_at);
          nextReminder = new Date(msOf(nextDue) - offset).toISOString();
        }
        spawnedTaskId = ctx.ids.next('task');
        ctx.store.db
          .prepare(
            `INSERT INTO task (
               id, workspace_id, title, notes, assignee_user_id, created_by_user_id,
               due_at, reminder_at, snoozed_until, status, entity_kind, entity_id,
               recurrence_rule, recurrence_parent_id, completed_at, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'open', ?, ?, ?, ?, NULL, ?, ?)`,
          )
          .run(
            spawnedTaskId,
            ctx.workspaceId,
            row.title,
            row.notes,
            row.assignee_user_id,
            ctx.actor,
            nextDue,
            nextReminder,
            row.entity_kind,
            row.entity_id,
            row.recurrence_rule,
            row.id,
            now,
            now,
          );
        ctx.audit.record({ entityKind: 'task', entityId: spawnedTaskId, action: 'create', actor: ctx.actor, at: now });
      }
    }

    return ok({
      taskId: row.id,
      task: mapTask(readTask(ctx, row.id) as TaskRow),
      activityId,
      spawnedTaskId,
      seriesEnded,
    });
  };

  // `runGuarded` sits OUTSIDE the tx so a `TaskAbort` thrown from `run` unwinds the whole composite
  // (completion + audit + any spawn) and, on the memoised path, memoises nothing under the key.
  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    return runGuarded(() => ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey as string, 'tasks_complete', run));
  }
  return runGuarded(() => ctx.store.tx(run));
}

/**
 * Snooze hides the reminder, it never moves the deadline (US-E03.5): `snoozed_until` leaves the
 * task out of `tasksRemindersDue` until that instant, `due_at` is untouched. Snoozing PAST the due
 * date is legal (the task simply shows overdue with a muted reminder; the Studio warns inline).
 */
export function snoozeTask(
  ctx: WorkspaceContext,
  input: { taskId: string; until: string; idempotencyKey?: string },
): Result {
  const row = readTask(ctx, input.taskId);
  if (row === undefined) return err('not_found', { taskId: input.taskId });
  if (!LIVE_STATUSES.includes(row.status)) return err('task_not_open', { taskId: row.id, status: row.status });
  if (typeof input.until !== 'string' || !isValidInstant(input.until)) {
    return err('invalid_input', { field: 'until' });
  }
  if (msOf(input.until) <= Date.parse(ctx.clock.now())) {
    return err('snooze_in_past', { until: input.until, now: ctx.clock.now() });
  }

  const run = (): Result => {
    const now = ctx.clock.now();
    ctx.store.db
      .prepare('UPDATE task SET snoozed_until = ?, updated_at = ? WHERE workspace_id = ? AND id = ?')
      .run(input.until, now, ctx.workspaceId, row.id);
    return ok({ taskId: row.id, task: mapTask(readTask(ctx, row.id) as TaskRow) });
  };

  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'tasks_snooze', run);
  }
  return ctx.store.tx(run);
}

/** Cancel is the terminal "won't do" (US-E03.2), distinct from done: no spawn, no OP5 log, ever. */
export function cancelTask(
  ctx: WorkspaceContext,
  input: { taskId: string; idempotencyKey?: string },
): Result {
  // Replay first, for the same reason `completeTask` does: a retried cancel must answer the
  // original result rather than `task_not_open` on the row it itself cancelled.
  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    const prior = ctx.store.recallIdempotent<Result>(ctx.workspaceId, input.idempotencyKey, 'tasks_cancel');
    if (prior !== undefined) return prior;
  }
  const row = readTask(ctx, input.taskId);
  if (row === undefined) return err('not_found', { taskId: input.taskId });
  if (!LIVE_STATUSES.includes(row.status)) return err('task_not_open', { taskId: row.id, status: row.status });

  const run = (): Result => {
    const now = ctx.clock.now();
    ctx.store.db
      .prepare(`UPDATE task SET status = 'cancelled', updated_at = ? WHERE workspace_id = ? AND id = ?`)
      .run(now, ctx.workspaceId, row.id);
    ctx.audit.record({ entityKind: 'task', entityId: row.id, action: 'cancel', actor: ctx.actor, at: now });
    return ok({ taskId: row.id, task: mapTask(readTask(ctx, row.id) as TaskRow) });
  };

  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'tasks_cancel', run);
  }
  return ctx.store.tx(run);
}

/** The bucket of one row against one clock day, the SINGLE derivation `tasksList` labels rows with. */
export function bucketOf(row: TaskRow, today: string): TaskBucket {
  if (row.status === 'done') return 'done';
  if (row.due_at === null) return 'upcoming';
  const dueDay = row.due_at.slice(0, 10);
  if (dueDay < today) return 'overdue';
  if (dueDay === today) return 'today';
  return 'upcoming';
}

export interface ListTasksFilter {
  bucket?: string;
  assigneeUserId?: string;
  entityKind?: string;
  entityId?: string;
  status?: string;
  savedViewId?: string;
}

/**
 * The queue read model (P5): buckets derived AT QUERY TIME from `due_at` vs the injected clock,
 * never cached. Serves the `Aufgaben` route and the per-entity drawer list (the OP3 filter). The
 * G00 seam is one unconditional `applySavedView` call, exactly as `listContacts` makes it: the
 * view's stored filters merge UNDER the caller's explicit ones.
 */
export function listTasks(ctx: WorkspaceContext, filter: ListTasksFilter = {}): Result {
  const viewed = applySavedView(ctx, 'task', filter);
  if (!viewed.ok) return viewed;
  filter = viewed.filter;

  if (filter.bucket !== undefined && !isTaskBucket(filter.bucket)) {
    return err('invalid_input', { field: 'bucket' });
  }
  if (filter.status !== undefined && !isTaskStatus(filter.status)) {
    return err('invalid_input', { field: 'status', allowed: [...TASK_STATUSES] });
  }

  const clauses = ['workspace_id = ?'];
  const params: string[] = [ctx.workspaceId];
  if (filter.status !== undefined) {
    clauses.push('status = ?');
    params.push(filter.status);
  } else if (filter.bucket === 'done') {
    clauses.push(`status = 'done'`);
  } else if (filter.bucket !== undefined) {
    clauses.push(`status IN ('open', 'doing')`);
  } else {
    // The default queue hides only what was consciously discarded: cancelled rows return solely
    // through an explicit status filter.
    clauses.push(`status != 'cancelled'`);
  }
  if (filter.assigneeUserId !== undefined) {
    clauses.push('assignee_user_id = ?');
    params.push(filter.assigneeUserId);
  }
  if (filter.entityKind !== undefined) {
    clauses.push('entity_kind = ?');
    params.push(filter.entityKind);
  }
  if (filter.entityId !== undefined) {
    clauses.push('entity_id = ?');
    params.push(filter.entityId);
  }

  const rows = ctx.store.db
    .prepare(
      `SELECT * FROM task WHERE ${clauses.join(' AND ')}
        ORDER BY CASE WHEN due_at IS NULL THEN 1 ELSE 0 END, due_at, created_at`,
    )
    .all(...params) as TaskRow[];

  const today = ctx.clock.now().slice(0, 10);
  const items = rows
    .map((row) => ({ ...mapTask(row), bucket: bucketOf(row, today) }))
    .filter((item) => filter.bucket === undefined || item.bucket === filter.bucket);
  return ok({ tasks: items, total: items.length });
}

/**
 * THE SINGLE REMINDER-TRIGGER SURFACE (US-E03.4/6): `reminder_at <= asOf`, status live, and not
 * snoozed. C01, A16, G06 and the Studio `Aufgaben` route all poll THIS model; none runs a private
 * reminder loop, and the `task.due` automation trigger (the G01 tick source) reads the same
 * predicate, so "in the set" and "fires" cannot drift apart.
 */
export function tasksRemindersDue(ctx: WorkspaceContext, input: { asOf?: string } = {}): Result {
  const asOf = input.asOf ?? ctx.clock.now();
  if (typeof asOf !== 'string' || !isValidInstant(asOf)) return err('invalid_input', { field: 'asOf' });
  const rows = dueReminderRows(ctx, asOf);
  const today = asOf.slice(0, 10);
  return ok({
    asOf,
    items: rows.map((row) => ({ ...mapTask(row), bucket: bucketOf(row, today) })),
  });
}

/** The shared predicate behind `tasksRemindersDue` AND the `task.due` tick source. */
export function dueReminderRows(ctx: WorkspaceContext, asOf: string): TaskRow[] {
  // ISO strings compare lexicographically, and a bare `YYYY-MM-DD` sorts before any instant of the
  // same day, so a date-only reminder is due from that day's first tick on.
  return ctx.store.db
    .prepare(
      `SELECT * FROM task
        WHERE workspace_id = ?
          AND reminder_at IS NOT NULL AND reminder_at <= ?
          AND status IN ('open', 'doing')
          AND (snoozed_until IS NULL OR snoozed_until <= ?)
        ORDER BY reminder_at, created_at`,
    )
    .all(ctx.workspaceId, asOf, asOf) as TaskRow[];
}
