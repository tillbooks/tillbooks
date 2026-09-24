/**
 * B00's two tables, kept in B00's own module and concatenated onto `SCHEMA_SQL` at the store, the
 * pattern A14/A19/A24/G00/C00/E00 established: a capability's DDL sits beside the code that writes
 * it, so concurrent capability branches never all edit one long string in `store/schema.ts`.
 *
 * NO CHECK CONSTRAINT on `status`, matching the §D0 convention: the enum lives at the single §H-ENUM
 * source (`enums.ts`), validated at the verb boundary, so the transition table stays in exactly one
 * place. A CHECK here would be a second enumeration point, which §6b forbids.
 *
 * Money columns are integer Rappen (P2): `budget_minor` is the budget in the project's own currency,
 * and for a non-base currency `budget_base_minor` + `fx_rate` snapshot the §H-FX conversion made at
 * creation (or at the budget/currency edit that re-snapshotted it). Base-currency projects leave
 * both NULL: a stored base figure equal to the transaction figure would be a second copy that could
 * drift.
 *
 * `parent_id` is a self-FK with NO cascade: the engine refuses deleting a parent that has children
 * (`has_children`), and the cycle guard lives in the verb, where it can name the offending id.
 */

export const PROJECTS_SCHEMA_SQL = `
-- B00: the project master. status is draft|active|on_hold|closed (validated in enums.ts, never a
-- CHECK). code is the human handle, unique per workspace (enforced by index, raced by the engine's
-- own read so the rejection is a stable code_taken rather than a driver throw).
CREATE TABLE IF NOT EXISTS project (
  id                TEXT PRIMARY KEY,
  workspace_id      TEXT NOT NULL REFERENCES workspace(id),
  code              TEXT NOT NULL,
  name              TEXT NOT NULL,
  contact_id        TEXT NOT NULL REFERENCES contact(id),
  status            TEXT NOT NULL DEFAULT 'draft',
  currency          TEXT NOT NULL,
  budget_minor      INTEGER NOT NULL DEFAULT 0,
  budget_hours      INTEGER NOT NULL DEFAULT 0,
  budget_base_minor INTEGER,
  fx_rate           TEXT,
  starts_on         TEXT,
  ends_on           TEXT,
  parent_id         TEXT REFERENCES project(id),
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS project_code_per_workspace
ON project (workspace_id, code);

-- B00: phases and their milestones. A milestone is a phase with milestone_on set; done_at records
-- when it was marked reached. Budgets are planning aids (a phase sum exceeding the project budget
-- warns, never blocks).
CREATE TABLE IF NOT EXISTS project_phase (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspace(id),
  project_id    TEXT NOT NULL REFERENCES project(id),
  name          TEXT NOT NULL,
  sort          INTEGER NOT NULL DEFAULT 0,
  budget_minor  INTEGER NOT NULL DEFAULT 0,
  budget_hours  INTEGER NOT NULL DEFAULT 0,
  milestone_on  TEXT,
  done_at       TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS project_phase_by_project
ON project_phase (workspace_id, project_id, sort);
`;
