/**
 * E03's seven verbs, defined here and spread into `ACTIONS` as one line (the `fxActions` /
 * `itemActions` / `contactActions` precedent), so several agents appending to the append-only
 * registry at once collide over a line rather than a block.
 *
 * The five writes are the whole task lifecycle (create, edit, complete, snooze, cancel); the two
 * reads are the queue and THE reminder-trigger surface every consumer polls (`tasks_reminders_due`
 * is what C01, A16 and G06 read; none of them gets a private reminder loop, spec §4). REST twins
 * ride the shared registry automatically, as for every other verb.
 *
 * As with `fx-actions.ts`, the helpers arrive as a parameter rather than an import, so the module
 * graph stays acyclic: `registry.ts` imports this file and this file must not import it back.
 */

import type { ActionDef, ActionInput, JsonSchema } from './registry.js';
import type { WorkspaceContext } from '../core/context.js';
import type { Result } from '../core/result.js';
import {
  createTask,
  updateTask,
  completeTask,
  snoozeTask,
  cancelTask,
  listTasks,
  tasksRemindersDue,
} from '../core/tasks/index.js';

export interface TaskActionHelpers {
  ctxAction(
    name: string,
    kind: 'read' | 'write',
    summary: string,
    inputSchema: JsonSchema,
    call: (ctx: WorkspaceContext, input: ActionInput) => Result,
  ): ActionDef;
  ctxSchema(props?: Record<string, unknown>, required?: string[]): JsonSchema;
  STR: { readonly type: 'string' };
  BOOL: { readonly type: 'boolean' };
}

/** Widen an `ActionInput` to the engine's own input shape (the same cast `registry.ts` uses). */
function as<T>(input: ActionInput): T {
  return input as unknown as T;
}

/** The patch `tasks_update` accepts: the editable half of a task, validated in the engine. */
const TASK_PATCH_FIELDS = {
  title: { type: 'string' },
  notes: { type: 'string' },
  assigneeUserId: { type: 'string' },
  dueAt: { type: 'string' },
  reminderAt: { type: 'string' },
  recurrenceRule: { type: 'string' },
  status: { type: 'string' },
} as const;

/** The E03 verbs, in append order. */
export function taskActions(h: TaskActionHelpers): readonly ActionDef[] {
  const { ctxAction, ctxSchema, STR, BOOL } = h;

  return [
    ctxAction(
      'tasks_create',
      'write',
      'Lege eine Aufgabe an: a cross-entity to-do with an assignee, an optional due date (dueAt, may be in the past: it lands in the Überfällig bucket), an optional reminder (reminderAt, refused when already past or after the due date), an optional link to any registered record (entityKind/entityId, validated against the OP3 entity registry), and an optional RFC-5545-subset recurrence rule (FREQ=DAILY|WEEKLY|MONTHLY|YEARLY, INTERVAL, BYDAY for weekly, UNTIL or COUNT).',
      ctxSchema(
        {
          title: STR,
          notes: STR,
          assigneeUserId: STR,
          dueAt: STR,
          reminderAt: STR,
          entityKind: STR,
          entityId: STR,
          recurrenceRule: STR,
          idempotencyKey: STR,
        },
        ['title', 'assigneeUserId'],
      ),
      (ctx, input) => createTask(ctx, as(input)),
    ),
    ctxAction(
      'tasks_update',
      'write',
      'Bearbeite eine Aufgabe from a patch: retitle, reassign, reschedule (patching dueAt clears any snooze: a new deadline supersedes an old Zurückstellen), change the reminder or the recurrence rule, move between open and doing, or reopen a done task (status open; cancelled stays terminal).',
      ctxSchema(
        { taskId: STR, patch: { type: 'object', properties: TASK_PATCH_FIELDS }, idempotencyKey: STR },
        ['taskId', 'patch'],
      ),
      (ctx, input) => updateTask(ctx, as(input)),
    ),
    ctxAction(
      'tasks_complete',
      'write',
      'Erledige eine Aufgabe: sets done and stamps completedAt; with logActivity true on a contact-linked task, appends one OP5 timeline entry through contacts_log_activity; on a recurring task, mints the next occurrence anchored on the completed due date (never on completion time) and answers spawnedTaskId, or seriesEnded when UNTIL or COUNT closes the series. One idempotency key covers complete, log and spawn together. Allowed for holders of tasks.write and for the task assignee.',
      ctxSchema({ taskId: STR, logActivity: BOOL, idempotencyKey: STR }, ['taskId']),
      (ctx, input) => completeTask(ctx, as(input)),
    ),
    ctxAction(
      'tasks_snooze',
      'write',
      'Stelle eine Erinnerung zurück: hides the task from tasks_reminders_due until the given instant. The due date is untouched (snooze hides the reminder, it does not move the deadline), and an instant already past is refused with snooze_in_past.',
      ctxSchema({ taskId: STR, until: STR, idempotencyKey: STR }, ['taskId', 'until']),
      (ctx, input) => snoozeTask(ctx, as(input)),
    ),
    ctxAction(
      'tasks_cancel',
      'write',
      'Brich eine Aufgabe ab: the terminal "wird nicht erledigt", distinct from done. No activity is logged and no recurrence occurrence is spawned; a cancelled task returns only through an explicit status filter.',
      ctxSchema({ taskId: STR, idempotencyKey: STR }, ['taskId']),
      (ctx, input) => cancelTask(ctx, as(input)),
    ),
    ctxAction(
      'tasks_list',
      'read',
      'The task queue (P5): every task with its bucket derived at query time from dueAt against today (overdue, today, upcoming, done), filterable by bucket, assignee, status, or the linked record (entityKind/entityId, which serves the per-entity drawer list). savedViewId applies a saved view (G00): its stored filters are merged underneath any filter named explicitly here.',
      ctxSchema({
        bucket: STR,
        assigneeUserId: STR,
        entityKind: STR,
        entityId: STR,
        status: STR,
        savedViewId: STR,
      }),
      (ctx, input) => listTasks(ctx, as(input)),
    ),
    ctxAction(
      'tasks_reminders_due',
      'read',
      'The single reminder-trigger surface (P5): every task whose reminder is due at asOf (default now), status open or doing, and not snoozed past asOf. C01 deal follow-ups, A16 receivables chasing and G06 notification delivery all poll THIS list rather than running reminder loops of their own, and the task.due automation trigger fires from the same predicate.',
      ctxSchema({ asOf: STR }),
      (ctx, input) => tasksRemindersDue(ctx, as(input)),
    ),
  ];
}
