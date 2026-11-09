/**
 * G19's one table, kept in its own module and concatenated onto `SCHEMA_SQL` at the store (the
 * G13 `archiveSchema.ts` precedent: a capability's DDL sits beside the code that writes it, so
 * concurrent capability branches never all edit one long string).
 *
 * ONE ROW PER PLAN (spec §4): the export-completeness manifest. `items` is JSON, one entry per guide
 * item, each carrying its status, the E00 fileId(s), a row count, a date range and a note, plus the
 * §H-AUDIT stamp (updatedBy/updatedAt). Every row carries `workspace_id` (§H-TENANT), and file
 * references validate against E00 rows in the same workspace in the engine.
 *
 * NO CREDENTIAL, COOKIE OR SESSION STATE HAS A COLUMN HERE, EVER (spec §3, DoD): the core stores
 * nothing about the browser companion except that files arrive in E00. The purity of the schema is
 * part of the safety case, so there is deliberately no column a vendor secret could land in.
 *
 * NO CASCADE, matching the house rule: a missing plan refuses rather than silently taking the
 * manifest with it. `source_access_until` is the deletion-clock deadline, a contract fact the
 * operator enters from their own terms (US-G19.3), nullable until they do.
 */

export const EXTRACTION_MANIFEST_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS migration_extraction_manifest (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspace(id),
  plan_id             TEXT NOT NULL REFERENCES migration_plan(id),
  source_system       TEXT NOT NULL,
  -- The deletion-clock deadline (US-G19.3): a contract fact the operator enters, verified against
  -- their own terms, never asserted as law. NULL until set.
  source_access_until TEXT,
  -- JSON array; each entry is {itemId, status, fileIds[], rowCount?, dateFrom?, dateTo?, note?,
  -- updatedAt, updatedBy}. manifest.ts is the single reader and writer.
  items               TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  UNIQUE (plan_id)
);

CREATE INDEX IF NOT EXISTS migration_extraction_manifest_by_workspace
ON migration_extraction_manifest (workspace_id, plan_id);
`;
