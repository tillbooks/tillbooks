/**
 * A12's two tables, kept in A12's own module (the A14/A17/E00 pattern: a capability's DDL sits
 * beside the code that writes it and is concatenated onto `SCHEMA_SQL` at the store).
 *
 * `recurring_schedule` IS CONFIG, NOT A LEDGER OBJECT: mutable, freely editable, holding no
 * financial truth. The money moves only when the tick invokes `create_document` / `issue_invoice`
 * through the shared dispatch (spec §4).
 *
 * `recurring_run_log` is the append-only record of every occurrence, and its PARTIAL UNIQUE INDEX is
 * the row-level half of §H-IDEMPOTENT: a period can carry many OPEN observations
 * (`skipped_locked`, `failed`) but exactly one SETTLE (`drafted`, `issued`, `discarded`). The index
 * ignores `document_id` entirely, so releasing a pointer never weakens it (critic probe R6).
 *
 * `document_id ... ON DELETE SET NULL` is BELT AND BRACES, not the mechanism (spec §4b, the F6
 * lesson). The first build relied on the FK alone and the retry path inserted a pointer to a
 * document a human had cancelled: the constraint rejected the insert and one operator click killed
 * the whole workspace's tick, forever. The rebuild's tick VERIFIES every memoised document id
 * against the store before it writes a row (invariant I2), so the poisoned insert is
 * unrepresentable; the SET NULL remains for the OTHER direction (a human cancels a draft whose
 * settled row already points at it: the period, outcome and timestamp survive, only the pointer is
 * released, critic probe C3).
 *
 * `due_stamped` records the due date the tick wrote onto the draft at creation (clock day +
 * due_days). It is what lets the issue-time re-assert tell a machine stamp from a due date a human
 * negotiated on the waiting draft: equal means machine (re-assert from today), different means human
 * (keep it). The F4 repair, spec §4b.
 *
 * No CHECK constraints on the enum columns, per the §D0 convention: the enums live at their single
 * §H-ENUM source (`enums.ts`), so adding a value is one edit with no migration.
 *
 * The settled index deliberately does NOT lead with `workspace_id`: `recurring_schedule.id` is a
 * global primary key, so `(schedule_id, period_key)` already identifies the tenant and adding the
 * column would WIDEN the constraint (round-2 critic, N1).
 */

export const RECURRING_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS recurring_schedule (
  id               TEXT PRIMARY KEY,
  workspace_id     TEXT NOT NULL REFERENCES workspace(id),
  name             TEXT,
  contact_id       TEXT NOT NULL,
  -- The SNAPSHOTTED template positions, stored through the whitelist in recurring.ts: never a live
  -- link to an A10 document, and never carrying a supplyDate (the tick is the single writer of the
  -- Leistungsdatum, critic probes C9/R2).
  lines_json       TEXT NOT NULL,
  currency         TEXT,
  notes            TEXT,
  due_days         INTEGER,
  -- monthly | quarterly | yearly | custom (enums.ts is the enum).
  interval         TEXT NOT NULL,
  custom_days      INTEGER,
  anchor_date      TEXT NOT NULL,
  -- The cursor: the next period this schedule owes. Only ever an occurrence of (anchor, interval).
  next_run_date    TEXT NOT NULL,
  end_date         TEXT,
  max_occurrences  INTEGER,
  occurrences_done INTEGER NOT NULL DEFAULT 0,
  auto_issue       INTEGER NOT NULL DEFAULT 0,
  -- active | paused | ended (enums.ts is the enum). ended is terminal.
  status           TEXT NOT NULL DEFAULT 'active',
  -- THE ACTOR EVERY GENERATION RUNS AS (the G01 fire-path model): resolved live on every tick, so a
  -- demoted or revoked author stops generating with nothing to invalidate.
  created_by       TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS recurring_schedule_due
ON recurring_schedule (workspace_id, status, next_run_date);

CREATE TABLE IF NOT EXISTS recurring_run_log (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspace(id),
  schedule_id   TEXT NOT NULL REFERENCES recurring_schedule(id),
  -- The period being billed (an occurrence date), which is also the Leistungsdatum the tick stamps.
  period_key    TEXT NOT NULL,
  document_id   TEXT REFERENCES document(id) ON DELETE SET NULL,
  -- drafted | issued | discarded | skipped_locked | failed (enums.ts is the enum).
  outcome       TEXT NOT NULL,
  -- The invoked verb's own rejection code, verbatim, or NULL. Never a stack trace.
  error         TEXT,
  -- The due date the tick stamped on the draft (clock day + due_days), or NULL. See module note.
  due_stamped   TEXT,
  ran_at        TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS recurring_run_log_settled
ON recurring_run_log (schedule_id, period_key)
WHERE outcome IN ('drafted', 'issued', 'discarded');

CREATE INDEX IF NOT EXISTS recurring_run_log_by_schedule
ON recurring_run_log (workspace_id, schedule_id, ran_at);
`;
