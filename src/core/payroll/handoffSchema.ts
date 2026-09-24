/**
 * A34, payroll hand-off boundary: the two thin, append-only tables this capability owns (spec §4).
 *
 * BOTH ARE BOOKKEEPING ABOUT AN EVENT, NEVER PER-EMPLOYEE WAGE DATA (revDSG Art. 6 minimisation).
 * `payroll_handoff_exports` records that an employee-master artifact was produced (row counts, the
 * `as_of` mutation anchor, whether AHV numbers were included, the E00 artifact link and its hash);
 * `wage_journal_posts` records that an externally-computed aggregate wage journal was posted through
 * A02 (the posted entry id, the mapping used, the source file hash). No wage amount, no person's pay,
 * lives here: the amounts live where they belong, on A02's posted entry (P3).
 *
 * NEW TABLES (not `ADDITIVE_COLUMNS`): they join `SCHEMA_SQL` for the fresh-database path and are
 * copied by G04's snapshot like every other table. Both carry `workspace_id` (§H-TENANT).
 *
 * APPEND-ONLY, ENFORCED AT THE DB LAYER (§H-AUDIT, spec §7 tripwire 3). Neither record is ever
 * edited or deleted: a hand-off history a workspace could rewrite could not prove what left the
 * device, which is the record's entire job. The BEFORE triggers make that impossible for any code
 * path, raw statement, or plugin, mirroring the `expense_claim` immutability triggers. A wrong wage
 * journal is corrected in the payroll system and re-imported, or reversed via A02's reversing entry,
 * never by touching these rows.
 */

export const PAYROLL_HANDOFF_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS payroll_handoff_exports (
  id                    TEXT PRIMARY KEY,
  workspace_id          TEXT NOT NULL REFERENCES workspace(id),
  as_of                 TEXT NOT NULL,
  previous_export_id    TEXT REFERENCES payroll_handoff_exports(id),
  format                TEXT NOT NULL CHECK (format IN ('csv','json')),
  employee_count        INTEGER NOT NULL,
  mutation_count        INTEGER NOT NULL,
  ahv_included          INTEGER NOT NULL DEFAULT 0,
  ahv_excluded_reason   TEXT,
  artifact_document_id  TEXT NOT NULL REFERENCES stored_file(id),
  sha256                TEXT NOT NULL,
  actor                 TEXT NOT NULL,
  created_at            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS payroll_handoff_exports_by_workspace
  ON payroll_handoff_exports (workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS wage_journal_posts (
  id               TEXT PRIMARY KEY,
  workspace_id     TEXT NOT NULL REFERENCES workspace(id),
  posted_entry_id  TEXT NOT NULL REFERENCES journal_entry(id),
  entry_date       TEXT NOT NULL,
  mapping_id       TEXT,
  source_sha256    TEXT,
  line_count       INTEGER NOT NULL,
  actor            TEXT NOT NULL,
  created_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS wage_journal_posts_by_workspace
  ON wage_journal_posts (workspace_id, created_at DESC);

-- §H-AUDIT (spec §7 tripwire 3): the hand-off history is append-only. A recorded export or posting
-- is never updated or deleted through any path. The triggers make it impossible at the storage layer,
-- exactly like the expense_claim immutability triggers.
CREATE TRIGGER IF NOT EXISTS payroll_handoff_exports_no_update
BEFORE UPDATE ON payroll_handoff_exports
BEGIN
  SELECT RAISE(ABORT, 'payroll_handoff_immutable');
END;

CREATE TRIGGER IF NOT EXISTS payroll_handoff_exports_no_delete
BEFORE DELETE ON payroll_handoff_exports
BEGIN
  SELECT RAISE(ABORT, 'payroll_handoff_immutable');
END;

CREATE TRIGGER IF NOT EXISTS wage_journal_posts_no_update
BEFORE UPDATE ON wage_journal_posts
BEGIN
  SELECT RAISE(ABORT, 'wage_journal_post_immutable');
END;

CREATE TRIGGER IF NOT EXISTS wage_journal_posts_no_delete
BEFORE DELETE ON wage_journal_posts
BEGIN
  SELECT RAISE(ABORT, 'wage_journal_post_immutable');
END;
`;
