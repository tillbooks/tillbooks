/**
 * G03's one table, kept in G03's own module and concatenated onto `SCHEMA_SQL` at the store, the
 * pattern A14/A19/A24/G00/C00/E00/G10 established: a capability's DDL sits beside the code that
 * writes it.
 *
 * ONE TABLE, ONE ROW PER WORKSPACE, ZERO COMPLIANCE WEIGHT. `onboarding_progress` is a pure GUI
 * resume pointer (spec G03 §4): where the first-run wizard was when the tab closed, so a reload
 * reopens on the saved step rather than step one. It is an absolute upsert, never a business-logic
 * gate: every underlying setup verb keeps its own validation and idempotency, and deleting this row
 * would lose nothing but a scroll position. That is why it is deliberately NOT an OP3 entity kind
 * and carries no audit rows.
 *
 * The `path` enum's single §H-ENUM source is `ONBOARDING_PATHS` in `progress.ts` (no CHECK here,
 * the §D0 convention: a CHECK would be a second enumeration point). `workspace.kind` / `is_demo`
 * are NOT here: they are G12's columns on `workspace`, single-sourced in
 * `core/migration/testmandant.ts`.
 */

export const ONBOARDING_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS onboarding_progress (
  workspace_id TEXT PRIMARY KEY REFERENCES workspace(id),
  path         TEXT NOT NULL,
  step         TEXT NOT NULL,
  completed_at TEXT,
  updated_at   TEXT NOT NULL
);
`;
