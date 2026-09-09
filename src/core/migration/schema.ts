/**
 * G10's tables, kept in G10's own module and concatenated onto `SCHEMA_SQL` at the store, the
 * pattern A14/A19/A24/G00/C00/E00/A26 established: a capability's DDL sits beside the code that
 * writes it, so concurrent capability branches never all edit one long string in `store/schema.ts`.
 *
 * THREE TABLES, AND ONE OF THEM IS A SEAM, NOT A CAPABILITY.
 *
 * `migration_plan` is the MINIMAL row G10's maps foreign-key against. The full plan and step
 * machine (states, discovery, commits, rollback) is G09's, built in the next wave; what G10 needs
 * today is only that a map can persist against a plan id inside a tenant, plus the three facts the
 * map layer itself consults (the source adapter for preset suggestions, the locale pack the
 * defaults resolve through, and the data class the template-kind check reads).
 * // SEAM(G09): minimal plan row, G09 owns the full plan/step machine and will extend this table.
 *
 * `migration_map` is one row per `(plan_id, kind)`, enforced by the UNIQUE constraint rather than
 * by code: `setMap` is an upsert, and the constraint is what makes "a plan has ONE account map"
 * a property of the store instead of a hope. `entries` is JSON, because an entry's shape is
 * kind-dependent and every entry is read and written whole through `maps.ts` (the single writer).
 * No CHECK on `kind` or `provenance`: the enums live at their single §H-ENUM source in `maps.ts`,
 * matching the §D0 convention (a CHECK here would be a second enumeration point).
 *
 * `migration_map_template` is DELIBERATELY NOT `workspace_id`-scoped, and the column that anchors
 * it is spelled `created_in_workspace_id` on purpose: the generic §H-TENANT probe keys on columns
 * named `workspace_id`, and this table's whole reason to exist is to cross client workspaces
 * (spec §4), so giving it that column name would claim a fence the design refuses. It is fenced
 * instead by CONTENT: a template row carries only source labels, source account numbers and target
 * ids, never a balance, a contact name or any client-identifying value, asserted by the template
 * purity test (spec §7). `operator_ref` is the scope `listMapTemplates` filters on;
 * `created_in_workspace_id` is provenance and the OP3 `tenantColumn` anchor for custom-field
 * attachment, never a read fence.
 *
 * NO CASCADE ANYWHERE, matching the house rule: a missing parent refuses rather than silently
 * taking history with it.
 */

export const MIGRATION_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS migration_plan (
  id             TEXT PRIMARY KEY,
  workspace_id   TEXT NOT NULL REFERENCES workspace(id),
  -- G09 owns the full status machine (draft|planned|trial|live|closed|abandoned); the enum's single
  -- source is PLAN_STATES in plan.ts, so there is no CHECK here (a CHECK would be a second point).
  status         TEXT NOT NULL DEFAULT 'draft',
  -- The source adapter id (adapters/registry.ts) suggestions consult. NULL until chosen.
  source_adapter TEXT,
  -- The locale pack id (locale/registry.ts) defaults resolve through. NULL means the shipped default.
  locale_pack    TEXT,
  -- The G09 data class this plan imports. NULL until G09's scope step sets it.
  data_class     TEXT,
  created_at     TEXT NOT NULL,
  -- G09 columns (// SEAM(G09) filled in): the vendor system label, the übernahmestichtag, the G12
  -- Testmandant this plan trial-loads into, the actor who created it, and the close timestamp.
  source_system  TEXT,
  cutover_date   TEXT,
  testmandant_workspace_id TEXT,
  created_by     TEXT,
  closed_at      TEXT,
  -- // INTEGRATION-SEAM(G04): the create_backup that covers this plan. NULL until G04 records one;
  -- the commit gate's condition 6 refuses a money-path first commit while it is null.
  backup_ref     TEXT
);

CREATE INDEX IF NOT EXISTS migration_plan_by_workspace
ON migration_plan (workspace_id, status);

CREATE TABLE IF NOT EXISTS migration_map (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  plan_id      TEXT NOT NULL REFERENCES migration_plan(id),
  -- column | account | tax | currency (MAP_KINDS in maps.ts is the enum's single source).
  kind         TEXT NOT NULL,
  -- JSON array; the entry shape is kind-dependent and maps.ts is the single reader and writer.
  entries      TEXT NOT NULL,
  rule_default TEXT,
  -- adapter_preset | locale_pack | saved_template | fuzzy | manual | agent (maps.ts owns the enum).
  provenance   TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  UNIQUE (plan_id, kind)
);

CREATE TABLE IF NOT EXISTS migration_map_template (
  id                      TEXT PRIMARY KEY,
  -- The operator the template belongs to. The ONLY read fence this table has, by design.
  operator_ref            TEXT NOT NULL,
  name                    TEXT NOT NULL,
  source_system           TEXT NOT NULL,
  -- JSON array of map kinds this template carries.
  kinds                   TEXT NOT NULL,
  -- JSON object keyed by kind; every entry is stripped of client figures at save (spec §7).
  entries                 TEXT NOT NULL,
  -- Provenance and the OP3 tenantColumn anchor. NOT named workspace_id: see the module note.
  created_in_workspace_id TEXT NOT NULL REFERENCES workspace(id),
  created_at              TEXT NOT NULL,
  last_used_at            TEXT
);

CREATE INDEX IF NOT EXISTS migration_map_template_by_operator
ON migration_map_template (operator_ref, source_system);

-- ================================================================================================
-- G09 migration harness: the plan/step machine G10's seam anticipated. Five tables (one, the plan,
-- is EXTENDED above rather than added), every row carrying workspace_id (§H-TENANT). NO CASCADE
-- anywhere, matching the house rule: a missing parent refuses rather than taking history with it.
-- ================================================================================================

-- One step per included data class. Two levels mirror A10's document-and-lines shape (P7): the step
-- is the class, migration_step_row below is the per-source-row audit trail. The status enum's single
-- source is STEP_STATES in steps.ts (no CHECK here, the §D0 convention).
CREATE TABLE IF NOT EXISTS migration_step (
  id                   TEXT PRIMARY KEY,
  workspace_id         TEXT NOT NULL REFERENCES workspace(id),
  plan_id              TEXT NOT NULL REFERENCES migration_plan(id),
  data_class           TEXT NOT NULL,
  depth                TEXT,
  status               TEXT NOT NULL DEFAULT 'pending',
  -- The counts of the last preview/trial/commit, JSON: {willCreate, willSkip, willConflict, ...}.
  counts               TEXT,
  -- The per-row willConflict resolutions the operator chose, JSON keyed by source_row_ref.
  conflict_resolutions TEXT,
  -- The G11 check whose hash a commit approval binds to (// INTEGRATION-SEAM(G11)). NULL until checked.
  last_check_id        TEXT,
  committed_at         TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  UNIQUE (plan_id, data_class)
);

CREATE INDEX IF NOT EXISTS migration_step_by_plan
ON migration_step (workspace_id, plan_id, status);

-- The row-level audit trail that makes a step's row_count checkable: one row per source row acted on.
CREATE TABLE IF NOT EXISTS migration_step_row (
  id             TEXT PRIMARY KEY,
  workspace_id   TEXT NOT NULL REFERENCES workspace(id),
  step_id        TEXT NOT NULL REFERENCES migration_step(id),
  source_row_ref TEXT NOT NULL,
  -- created | skipped | failed | conflict (the conflict_outcome enum, single-sourced in steps.ts).
  outcome        TEXT NOT NULL,
  target_kind    TEXT,
  target_id      TEXT,
  reason         TEXT,
  created_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS migration_step_row_by_step
ON migration_step_row (workspace_id, step_id);

-- The human approval bound to a check result (US-G09.4). A row exists for exactly (step_id, check_hash);
-- every return to the mapped state DELETES it, which makes the agent-autonomy boundary enforceable.
CREATE TABLE IF NOT EXISTS migration_approval (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  plan_id      TEXT NOT NULL REFERENCES migration_plan(id),
  step_id      TEXT NOT NULL REFERENCES migration_step(id),
  check_hash   TEXT NOT NULL,
  actor        TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  UNIQUE (step_id, check_hash)
);

CREATE INDEX IF NOT EXISTS migration_approval_by_step
ON migration_approval (workspace_id, step_id);

-- The E00 link that makes the uploaded export the Beleg (US-G09.8): the file, its adapter, its
-- sha256, its own as-at date, and the superseding chain when a correction mints a new fileId.
CREATE TABLE IF NOT EXISTS migration_source_file (
  id                    TEXT PRIMARY KEY,
  workspace_id          TEXT NOT NULL REFERENCES workspace(id),
  plan_id               TEXT NOT NULL REFERENCES migration_plan(id),
  file_id               TEXT NOT NULL,
  adapter               TEXT,
  sha256                TEXT,
  as_at                 TEXT,
  superseded_by_file_id TEXT,
  data_classes          TEXT,
  created_at            TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS migration_source_file_by_plan
ON migration_source_file (workspace_id, plan_id);

-- ================================================================================================
-- G11 Eröffnungsprüfung: the control totals and the persisted check (spec §4). Both §H-TENANT.
-- ================================================================================================

-- One row per (plan, step?, kind, scope): the operator's declared expectation AND the last computed
-- result for it live on ONE row (a declaration reopens the control; a check fills the computed
-- side). The status enum's single source is CONTROL_STATUSES in controls/registry.ts (no CHECK here,
-- the §D0 convention); it has exactly five values and amber is not one of them.
CREATE TABLE IF NOT EXISTS migration_control_total (
  id               TEXT PRIMARY KEY,
  workspace_id     TEXT NOT NULL REFERENCES workspace(id),
  plan_id          TEXT NOT NULL REFERENCES migration_plan(id),
  -- NULL means a plan-level expectation; a check materialises it onto the step it checked.
  step_id          TEXT REFERENCES migration_step(id),
  kind             TEXT NOT NULL,
  -- What the figure is ABOUT: an account number, a file id, an IBAN, or 'workspace'.
  scope            TEXT NOT NULL,
  declared_minor   INTEGER,
  computed_minor   INTEGER,
  difference_minor INTEGER,
  status           TEXT NOT NULL DEFAULT 'not_asserted',
  -- A waiver records WHO and WHY (US-G11.5): a silent waiver is a deleted control.
  waiver_reason    TEXT,
  waived_by        TEXT,
  waived_at        TEXT,
  source_map_id    TEXT,
  computed_at      TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

-- One control per (plan, step, kind, scope); NULL step_id rows are plan-level declarations and the
-- COALESCE keeps them unique too (SQLite treats bare NULLs as distinct, which would allow doubles).
CREATE UNIQUE INDEX IF NOT EXISTS migration_control_total_identity
ON migration_control_total (workspace_id, plan_id, COALESCE(step_id, ''), kind, scope);

CREATE INDEX IF NOT EXISTS migration_control_total_by_step
ON migration_control_total (workspace_id, plan_id, step_id);

-- The persisted check: APPEND-ONLY (§H-AUDIT). A re-check under changed inputs mints a NEW row, so
-- the record of what an approver saw survives; controls carries the FULL control snapshot (kind,
-- scope, declared, computed, status, waiver reason), not only ids, for the same reason. The hash is
-- computed over locale-neutral values and is what a G09 migration_approval binds to.
CREATE TABLE IF NOT EXISTS migration_check (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  plan_id      TEXT NOT NULL REFERENCES migration_plan(id),
  step_id      TEXT NOT NULL REFERENCES migration_step(id),
  -- testmandant | live (CHECK_RUNS in controls/registry.ts is the enum's single source).
  against      TEXT NOT NULL,
  check_hash   TEXT NOT NULL,
  clean        INTEGER NOT NULL DEFAULT 0,
  controls     TEXT NOT NULL,
  created_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS migration_check_by_step
ON migration_check (workspace_id, step_id, against, created_at);
`;
