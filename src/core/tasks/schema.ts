/**
 * E03's one table, kept in E03's own module and concatenated onto `SCHEMA_SQL` at the store, the
 * pattern A14/A19/A24/G00/C00/E00 established: a capability's DDL sits beside the code that writes
 * it, so concurrent capability branches never all edit one long string in `store/schema.ts`.
 *
 * NO `_rappen` COLUMN ANYWHERE, and that is asserted by test rather than merely stated (spec §4:
 * a task never touches the journal, so P3 is satisfied by having nothing to delegate). Every row
 * carries `workspace_id` (§H-TENANT). `status` is the §H-ENUM `TASK_STATUSES` enforced by the
 * engine, not a CHECK constraint (the single source of truth is `enums.ts`, the C00 pattern).
 *
 * `recurrence_parent_id` chains an occurrence to the one whose completion spawned it, which is how
 * `COUNT=n` termination is computed (chain length, a database fact) without mutating the stored
 * rule text: every occurrence of a series carries the SAME rule, per US-E03.3.
 */

export const TASKS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS task (
  id                   TEXT PRIMARY KEY,
  workspace_id         TEXT NOT NULL REFERENCES workspace(id),
  title                TEXT NOT NULL,
  notes                TEXT,
  assignee_user_id     TEXT NOT NULL,
  created_by_user_id   TEXT NOT NULL,
  due_at               TEXT,
  reminder_at          TEXT,
  snoozed_until        TEXT,
  status               TEXT NOT NULL DEFAULT 'open',
  entity_kind          TEXT,
  entity_id            TEXT,
  recurrence_rule      TEXT,
  recurrence_parent_id TEXT REFERENCES task(id),
  completed_at         TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);

-- The queue read model (tasks_list, P5) filters on status and orders by due date, per workspace.
CREATE INDEX IF NOT EXISTS task_queue
ON task (workspace_id, status, due_at);

-- The reminder trigger surface (tasks_reminders_due, P5) and the task.due tick source both scan
-- live reminders; the partial index keeps the scan to rows that can ever fire.
CREATE INDEX IF NOT EXISTS task_reminder
ON task (workspace_id, reminder_at)
WHERE reminder_at IS NOT NULL;

-- The per-entity drawer list (tasks_list with the OP3 filter).
CREATE INDEX IF NOT EXISTS task_entity
ON task (workspace_id, entity_kind, entity_id);
`;
