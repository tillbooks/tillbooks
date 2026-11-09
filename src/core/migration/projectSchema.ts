/**
 * G20's tables, kept in G20's own module and concatenated onto `SCHEMA_SQL` at the store, the
 * pattern A14/A19/A24/G00/C00/E00/A26/G10/G13/G19 established: a capability's DDL sits beside the code
 * that writes it, so concurrent capability branches never all edit one long string in
 * `store/schema.ts`.
 *
 * SIX TABLES, ALL §H-TENANT (every row carries workspace_id), NONE ON THE MONEY PATH. The
 * implementation project is an INTERNAL GOVERNANCE object (phases, sign-offs, statutory deadlines):
 * nothing here posts, and the parallel-run comparison reads A07/A08/A16/A17's own read models rather
 * than the journal. B00's `project` table is deliberately NOT forked (spec §3): a B00 project is a
 * client-billing object with rates and a P&L, this one carries none, so the two never share a table.
 *
 * THE APPEND-ONLY DISCIPLINE mirrors G13's trigger shape, applied on purpose:
 *   - `implementation_decision` refuses UPDATE and DELETE always (there is no update verb, §7).
 *   - `implementation_signoff` refuses DELETE always; an UPDATE is admitted ONLY to VOID a live
 *     sign-off (set `voided_at` from NULL, plus its reason), never to alter what was signed. Voiding
 *     is how G09 voids approvals: the row survives, the void is logged, nothing is deleted (US-G20.5).
 *   - `parallel_run_declaration` refuses DELETE always; an UPDATE is admitted ONLY to set
 *     `superseded_by` once (from NULL): a correction is a NEW declaration superseding the old, both
 *     retained (G11's control-total discipline, US-G20.3), never an edit in place.
 * `parallel_run_check` needs no trigger: it is insert-only by code (a re-check mints a new snapshot),
 * and it holds no figure a human signs, so there is nothing an UPDATE could quietly rewrite.
 *
 * NO CASCADE ANYWHERE, matching the house rule: a missing parent refuses rather than silently taking
 * history with it. The only cross-table references are to `workspace` and to the migration family's
 * own `migration_plan` (a project spans one or more plans, US-G20.1).
 *
 * NO CHECK on any enum column: the phase, task-status, sign-off-kind, owner-kind and figure-status
 * enums live at their single §H-ENUM source in `project.ts` / `parallelRun.ts` (the §D0 convention: a
 * CHECK here would be a second enumeration point).
 */

export const IMPLEMENTATION_PROJECT_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS implementation_project (
  id             TEXT PRIMARY KEY,
  workspace_id   TEXT NOT NULL REFERENCES workspace(id),
  source_system  TEXT NOT NULL,
  -- The fixed reconciliation anchor: every parallel-run figure is declared against this date. It may
  -- move only while no money-path step has committed (a later change is a recorded decision + a new
  -- plan, US-G20.1), enforced in project.ts, not by the schema.
  cutover_date   TEXT NOT NULL,
  freeze_start   TEXT,
  freeze_end     TEXT,
  -- effektiv | saldo (single-sourced in parallelRun.ts as MWST_METHODS). Governs window alignment.
  mwst_method    TEXT NOT NULL,
  -- 1 when the cutover is COMBINED with an MWST method change: the parallel run then refuses without
  -- a recorded 'mwst_method' sign-off (method_change_needs_signoff, US-G20.3).
  method_change  INTEGER NOT NULL DEFAULT 0,
  -- discovery|extraction|mapping|rehearsal|cutover|parallel_run|live|closed|abandoned. The enum's
  -- single source is PHASES in project.ts; the phase is DERIVED from evidence where possible and
  -- persisted here so a write can emit the phase-changed event without recomputing on every read.
  status         TEXT NOT NULL DEFAULT 'discovery',
  created_at     TEXT NOT NULL,
  closed_at      TEXT
);

CREATE INDEX IF NOT EXISTS implementation_project_by_workspace
ON implementation_project (workspace_id, status);

-- One open project per workspace: the partial unique index makes "one implementation at a time per
-- mandate" (project_already_open, US-G20.1) a property of the store, not a hope. A closed or
-- abandoned project does not occupy the slot, so a later re-implementation is free.
CREATE UNIQUE INDEX IF NOT EXISTS implementation_project_one_open
ON implementation_project (workspace_id)
WHERE status NOT IN ('closed', 'abandoned');

CREATE TABLE IF NOT EXISTS implementation_task (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspace(id),
  project_id          TEXT NOT NULL REFERENCES implementation_project(id),
  -- The phase this task belongs to (a PHASES value); the task list groups by it.
  phase               TEXT NOT NULL,
  title               TEXT NOT NULL,
  -- human | agent | system (OWNER_KINDS in project.ts).
  owner_kind          TEXT NOT NULL,
  owner_ref           TEXT,
  -- ISO day; instantiated from a template offset against the project cutover_date.
  due_date            TEXT,
  prerequisite_task_id TEXT REFERENCES implementation_task(id),
  -- fileId | check_id | signoff kind | archive_query (a hint for what evidence resolves the task).
  evidence_kind       TEXT,
  evidence_ref        TEXT,
  contingency         TEXT,
  -- open | done | blocked | not_applicable (TASK_STATUSES in project.ts).
  status              TEXT NOT NULL DEFAULT 'open',
  -- The recorded reason a canon task was marked not_applicable (US-G20.2: waived consciously).
  reason              TEXT,
  -- The runbook template item this task was instantiated from, NULL for an operator-added task.
  template_item_id    TEXT,
  -- 1 for the go/no-go and rollback tasks: UNDELETABLE, only not_applicable-with-reason (US-G20.2).
  undeletable         INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS implementation_task_by_project
ON implementation_task (workspace_id, project_id, phase, status);

-- APPEND-ONLY (§H-AUDIT): the decision log is Nachprüfbarkeit applied to the implementation itself
-- (OR 957a). There is no update verb (spec §4), and the triggers below make that structural.
CREATE TABLE IF NOT EXISTS implementation_decision (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  project_id   TEXT NOT NULL REFERENCES implementation_project(id),
  title        TEXT NOT NULL,
  context      TEXT,
  decision     TEXT NOT NULL,
  actor        TEXT NOT NULL,
  created_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS implementation_decision_by_project
ON implementation_decision (workspace_id, project_id, created_at);

-- APPEND-ONLY (§H-AUDIT): a sign-off is the human half of an act (US-G20.5). Voiding sets voided_at,
-- never deletes; what was signed is never altered.
CREATE TABLE IF NOT EXISTS implementation_signoff (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  project_id   TEXT NOT NULL REFERENCES implementation_project(id),
  -- A SIGNOFF_KINDS value (project.ts). Human-only kinds refuse a non-human actor at the verb.
  kind         TEXT NOT NULL,
  actor        TEXT NOT NULL,
  evidence_ref TEXT NOT NULL,
  -- The bound checkHash where the kind demands it (tieout / parallel_run_close): the G11 binding
  -- discipline reused, so a re-run check with a NEW hash voids this sign-off.
  hash         TEXT,
  voided_at    TEXT,
  void_reason  TEXT,
  created_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS implementation_signoff_by_project
ON implementation_signoff (workspace_id, project_id, kind, created_at);

-- APPEND-ONLY, hashed, superseded by reference (US-G20.3, the G11 control-total discipline): a
-- declared figure is never edited in place; a correction is a NEW row superseding the old, both
-- retained. figures is a JSON array of { kind, ref, declaredRappen } (integer Rappen only).
CREATE TABLE IF NOT EXISTS parallel_run_declaration (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspace(id),
  project_id    TEXT NOT NULL REFERENCES implementation_project(id),
  period        TEXT NOT NULL,
  figures       TEXT NOT NULL,
  hash          TEXT NOT NULL,
  superseded_by TEXT REFERENCES parallel_run_declaration(id),
  actor         TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS parallel_run_declaration_by_project
ON parallel_run_declaration (workspace_id, project_id, period, created_at);

-- The computed comparison snapshot: insert-only by code (a re-check mints a new row). results is a
-- JSON array of { kind, ref, declaredRappen, computedRappen, differenceRappen, status }.
CREATE TABLE IF NOT EXISTS parallel_run_check (
  id             TEXT PRIMARY KEY,
  workspace_id   TEXT NOT NULL REFERENCES workspace(id),
  project_id     TEXT NOT NULL REFERENCES implementation_project(id),
  period         TEXT NOT NULL,
  declaration_id TEXT,
  results        TEXT NOT NULL,
  computed_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS parallel_run_check_by_project
ON parallel_run_check (workspace_id, project_id, period, computed_at);

-- --- Append-only triggers (G13's shape) --------------------------------------------------------

-- implementation_decision: no UPDATE, no DELETE. A governance log that can be edited is not evidence.
CREATE TRIGGER IF NOT EXISTS implementation_decision_no_update
BEFORE UPDATE ON implementation_decision
BEGIN
  SELECT RAISE(ABORT, 'decision_append_only');
END;

CREATE TRIGGER IF NOT EXISTS implementation_decision_no_delete
BEFORE DELETE ON implementation_decision
BEGIN
  SELECT RAISE(ABORT, 'decision_append_only');
END;

-- implementation_signoff: never DELETE; UPDATE admitted ONLY to void a live sign-off (voided_at
-- NULL -> non-NULL, with its reason), never to alter what was signed.
CREATE TRIGGER IF NOT EXISTS implementation_signoff_no_delete
BEFORE DELETE ON implementation_signoff
BEGIN
  SELECT RAISE(ABORT, 'signoff_append_only');
END;

CREATE TRIGGER IF NOT EXISTS implementation_signoff_void_only
BEFORE UPDATE ON implementation_signoff
WHEN OLD.voided_at IS NOT NULL
  OR NEW.voided_at IS NULL
  OR NEW.id <> OLD.id
  OR NEW.workspace_id <> OLD.workspace_id
  OR NEW.project_id <> OLD.project_id
  OR NEW.kind <> OLD.kind
  OR NEW.actor <> OLD.actor
  OR NEW.evidence_ref <> OLD.evidence_ref
  OR NEW.hash IS NOT OLD.hash
  OR NEW.created_at <> OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'signoff_append_only');
END;

-- parallel_run_declaration: never DELETE; UPDATE admitted ONLY to set superseded_by once (NULL ->
-- value), never to alter the declared figures or their hash.
CREATE TRIGGER IF NOT EXISTS parallel_run_declaration_no_delete
BEFORE DELETE ON parallel_run_declaration
BEGIN
  SELECT RAISE(ABORT, 'declaration_append_only');
END;

CREATE TRIGGER IF NOT EXISTS parallel_run_declaration_supersede_only
BEFORE UPDATE ON parallel_run_declaration
WHEN OLD.superseded_by IS NOT NULL
  OR NEW.superseded_by IS NULL
  OR NEW.id <> OLD.id
  OR NEW.workspace_id <> OLD.workspace_id
  OR NEW.project_id <> OLD.project_id
  OR NEW.period <> OLD.period
  OR NEW.figures <> OLD.figures
  OR NEW.hash <> OLD.hash
  OR NEW.actor <> OLD.actor
  OR NEW.created_at <> OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'declaration_append_only');
END;
`;
