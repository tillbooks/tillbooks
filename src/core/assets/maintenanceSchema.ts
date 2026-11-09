/**
 * H08, the SIMPLE MAINTENANCE LOG table.
 *
 * A deliberately minimal, append-oriented log of completed (or cancelled) maintenance events attached
 * to a fixed asset (H01): what was done, when, by whom, and at what cost. It is NOT a CMMS: no work
 * orders, no preventive schedules, no dispatch, no parts inventory, no triggers (spec §1/§3).
 *
 * NON-POSTING BY DESIGN (spec §1/§4). The captured cost is DESCRIPTIVE metadata for later TCO
 * reporting (H09), never a journal: this table has no `journal_entry_id` column, and the engine
 * (`maintenance.ts`) imports neither `postEntry` nor any A02 verb, so no call path can post one. The
 * money numbers here are integer Rappen exactly like every financial figure, but they move zero Rappen
 * through the ledger.
 *
 * APPEND-ORIENTED, NOT IMMUTABLE. Unlike H05's `asset_transfer` (a frozen history row), a maintenance
 * log has a low-ceremony lifecycle (spec §2/US-H08.5): a `completed` row may be descriptively updated
 * while it is recent, and soft-cancelled to `cancelled` with a reason if entered in error. So UPDATE is
 * allowed (the soft-edit window is enforced in the verb, not the DB), but a row is NEVER hard-deleted:
 * a BEFORE DELETE trigger aborts, so the audit trail (OR 957/958) can never lose an entry. Cancellation
 * is a status change, not a deletion, and a cancelled row stays visible under an "include cancelled"
 * filter.
 *
 * The DDL sits in its own module and is joined into the applied schema by `core/store/schema.ts` (the
 * H00/H01/H05 module-owned pattern), so a concurrent asset-cluster branch never edits one shared
 * string. Columns are snake_case; the engine and MCP/REST interfaces are camelCase and map at the
 * `maintenance.ts` boundary only. Every row carries `workspace_id` (§H-TENANT).
 */

export const MAINTENANCE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS asset_maintenance_log (
  id                    TEXT PRIMARY KEY,
  workspace_id          TEXT NOT NULL REFERENCES workspace(id),
  asset_id              TEXT NOT NULL REFERENCES asset(id),
  -- The effective date the maintenance happened (ISO YYYY-MM-DD), which may differ from created_at.
  log_date              TEXT NOT NULL,
  -- §H-ENUM: corrective | preventive | inspection | calibration | upgrade | other (checked in the verb).
  maintenance_type      TEXT NOT NULL,
  title                 TEXT NOT NULL,
  description           TEXT,
  -- The performer: an internal user id OR a free-text external party name (either, both or neither).
  performed_by_user_id  TEXT,
  external_party        TEXT,
  -- Cost capture is DESCRIPTIVE ONLY (no GL posting). Integer Rappen or NULL (no cost recorded).
  cost_rappen           INTEGER,
  parts_cost_rappen     INTEGER,
  labour_cost_rappen    INTEGER,
  external_reference    TEXT,
  linked_document_id    TEXT,
  -- Lifecycle: completed (default) | cancelled. Cancel stores a reason; the row is never deleted.
  status                TEXT NOT NULL DEFAULT 'completed',
  cancel_reason         TEXT,
  notes                 TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  created_by            TEXT,
  idempotency_key       TEXT
);

-- §H-TENANT + the per-asset chronological read, the one query the timeline and the TCO roll-up run.
CREATE INDEX IF NOT EXISTS asset_maintenance_log_workspace_asset
ON asset_maintenance_log (workspace_id, asset_id);

-- §H-TENANT + the type / date filters the list surface offers.
CREATE INDEX IF NOT EXISTS asset_maintenance_log_workspace_date
ON asset_maintenance_log (workspace_id, log_date);

-- §H-AUDIT: a maintenance entry is APPEND-ORIENTED. It may be updated (descriptive edit) or cancelled
-- (status change) through the verb, but it is NEVER hard-deleted: the database refuses, so a recorded
-- service event can never vanish from the OR 957/958 history. Correction is a cancel, not a delete.
CREATE TRIGGER IF NOT EXISTS asset_maintenance_log_no_delete
BEFORE DELETE ON asset_maintenance_log
BEGIN
  SELECT RAISE(ABORT, 'asset_maintenance_log_immutable');
END;
`;
