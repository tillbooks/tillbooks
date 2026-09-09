/**
 * E03 §H-ENUM: the single source for the task spine's closed enumerations.
 *
 * `status` is a lightweight operational enum, deliberately NOT the A10 document machine (spec §4:
 * a task is not a document, P7 does not apply). It stays FIXED (§6b): every consumer hard-codes its
 * values (`tasks_reminders_due` filters `IN (open, doing)`, C01/A16/G06 read the same model), so a
 * workspace-defined status would fork every read model at once. A workspace that wants its own task
 * classification uses a G00 custom select field, never this enum.
 */

/** `task.status` (fixed §H-ENUM): `open -> doing -> done`, `open|doing -> cancelled`. */
export const TASK_STATUSES = ['open', 'doing', 'done', 'cancelled'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === 'string' && (TASK_STATUSES as readonly string[]).includes(value);
}

/**
 * The queue buckets `tasks_list` derives AT QUERY TIME from `due_at` vs the injected clock (P5,
 * never cached, spec §4). `overdue|today|upcoming` implicitly filter to live tasks (open|doing);
 * `done` is the finished section. A task with no due date is never late, so it sits in `upcoming`.
 */
export const TASK_BUCKETS = ['overdue', 'today', 'upcoming', 'done'] as const;
export type TaskBucket = (typeof TASK_BUCKETS)[number];

export function isTaskBucket(value: unknown): value is TaskBucket {
  return typeof value === 'string' && (TASK_BUCKETS as readonly string[]).includes(value);
}
