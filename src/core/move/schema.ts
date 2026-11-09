/**
 * M03's one table, kept in M03's own module and concatenated onto `SCHEMA_SQL` at the store, the
 * pattern G03's `onboarding_progress` established: a capability's DDL sits beside the code that
 * writes it.
 *
 * ONE TABLE, ONE ROW PER WORKSPACE, ZERO COMPLIANCE WEIGHT. `move_record` is the resumable
 * checklist behind the Hosting panel's move journey (spec M03 §3.1): which direction the books are
 * moving, which of the five steps are done (a timestamp each, so "Backup erstellt (heute 14:02)"
 * is a fact and not a guess), when the move started and when it completed. The PRIMARY KEY on
 * `workspace_id` IS the "at most one active per workspace" invariant: a second move replaces the
 * pointer rather than accumulating rows.
 *
 * It is a pure resume pointer, the G03 precedent verbatim: an absolute upsert, never a gate on any
 * verb, and deleting the row would lose nothing but a checklist position. A COMPLETED move keeps
 * its row on purpose: the S7.5 stale-writable notice ("this ledger was moved but is still
 * writable") is derived from a completed move over an unarchived workspace, and deleting the
 * record on completion would erase the one fact that notice needs.
 *
 * The `direction` enum's single §H-ENUM source is `MOVE_DIRECTIONS` in `state.ts` (no CHECK here,
 * the §D0 convention: a CHECK would be a second enumeration point).
 */

export const MOVE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS move_record (
  workspace_id TEXT PRIMARY KEY REFERENCES workspace(id),
  direction    TEXT NOT NULL,
  step1_at     TEXT,
  step2_at     TEXT,
  step3_at     TEXT,
  step4_at     TEXT,
  step5_at     TEXT,
  started_at   TEXT NOT NULL,
  completed_at TEXT,
  updated_at   TEXT NOT NULL
);
`;
