/**
 * F01's two tables, kept in F01's own module and concatenated onto `SCHEMA_SQL` at the store, the
 * pattern A14/A19/A24/G00/C00/E00/B00/B01/B04 established: a capability's DDL sits beside the code
 * that writes it, so concurrent capability branches never all edit one long string in
 * `store/schema.ts`.
 *
 * NO CHECK CONSTRAINT on `format` or `status`, matching the §D0 convention: both enums live at the
 * single §H-ENUM source (`enums.ts`), validated at the verb boundary.
 *
 * `saved_reports` is CONFIGURATION, not a document: it has no A10 lifecycle, and its only mutable
 * state is `delivery_active` (P8) and the run-timestamp cache. `filters`/`columns`/`recipients` are
 * JSON text; `schedule` is a canonicalised cron subset string or NULL. F01 POSTS NOTHING (P3): no
 * `amount`/`rappen` column appears here, because a saved report holds a QUERY, never a figure.
 *
 * `report_runs` is APPEND-ONLY (§H-AUDIT spirit): a failed or empty run is recorded, never rewritten.
 * The one removal path is `reports_delete`, which drops a definition together with its history and is
 * itself refused while any run is retention-linked into E00. `definition_hash` records which version
 * of the definition produced each artifact, so editing a report never rewrites the trail of what a
 * past run computed. `document_id` is the E00 stored-file link (OP3), NULL until a run is retained.
 * §H-TENANT: every row of both tables carries `workspace_id`.
 */

export const REPORTBUILDER_SCHEMA_SQL = `
-- F01: a saved report definition. source is a REPORT_SOURCES id (validated in reports.ts, never a
-- CHECK). format is csv|pdf (enums.ts). schedule is a canonicalised cron subset or NULL. recipients
-- is a JSON array of e-mail strings, stored draft-gated (P8); delivery_active stays 0 in the OSS core
-- (no transport, OP4), so a saved schedule always runs LOCALLY and never mails on its own.
CREATE TABLE IF NOT EXISTS saved_reports (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspace(id),
  name            TEXT NOT NULL,
  source          TEXT NOT NULL,
  filters         TEXT NOT NULL DEFAULT '[]',
  columns         TEXT NOT NULL DEFAULT '[]',
  format          TEXT NOT NULL DEFAULT 'csv',
  schedule        TEXT,
  recipients      TEXT NOT NULL DEFAULT '[]',
  delivery_active INTEGER NOT NULL DEFAULT 0,
  last_run_at     TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

-- The saved-report list scans by workspace and source.
CREATE INDEX IF NOT EXISTS saved_reports_by_workspace
ON saved_reports (workspace_id, source);

-- F01: the append-only run log. status is ok|failed (enums.ts). row_count is the projected row count
-- (0 is a valid, auditable empty result, never an error). artifact_ref is the local artifact handle
-- (OP4); definition_hash records the definition version that produced it; document_id links a retained
-- run into E00 (OP3), NULL otherwise. actor is who ran it (a scheduled run executes as its owner).
CREATE TABLE IF NOT EXISTS report_runs (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspace(id),
  report_id       TEXT NOT NULL REFERENCES saved_reports(id),
  ran_at          TEXT NOT NULL,
  status          TEXT NOT NULL,
  row_count       INTEGER NOT NULL DEFAULT 0,
  format          TEXT NOT NULL,
  artifact_ref    TEXT,
  definition_hash TEXT NOT NULL,
  document_id     TEXT,
  actor           TEXT,
  created_at      TEXT NOT NULL
);

-- The run-history read model filters by (workspace, report) newest first.
CREATE INDEX IF NOT EXISTS report_runs_by_report
ON report_runs (workspace_id, report_id, ran_at);

-- F01: the rendered artifact BYTES, kept in-store the way E00 keeps stored_file_blob, so a run is a
-- genuine local artifact (OP4) without loose files on disk and every test stays offline. One row per
-- successful run; the handle is the run id (report_runs.artifact_ref). A failed run writes no bytes.
-- ON DELETE is manual (reports_delete removes these alongside the run rows): SQLite has no cascade here.
CREATE TABLE IF NOT EXISTS report_run_artifact (
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  run_id       TEXT NOT NULL REFERENCES report_runs(id),
  mime         TEXT NOT NULL,
  content      BLOB NOT NULL,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (workspace_id, run_id)
);
`;
