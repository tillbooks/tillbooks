/**
 * A31, the document-capture tables. Additive, tenant-scoped, append-only field history.
 *
 * TWO TABLES. `captures` is the queue row (one per ingested document); `capture_fields` is the
 * append-only field history (one LIVE row per key, superseded rows kept). Both carry `workspace_id`
 * (§H-TENANT) and are new tables, so they join `SCHEMA_SQL` for the fresh-database path and are
 * copied by G04's snapshot like every other table; there is nothing for `ADDITIVE_COLUMNS` to do.
 *
 * THE DEDUPE KEY IS A PARTIAL UNIQUE INDEX on `(workspace_id, sha256)` WHERE `status != 'discarded'`
 * (spec §4): a live or committed capture blocks a second intake of identical bytes, while discarded
 * history never blocks a re-intake, so a mistaken discard is recoverable by re-uploading. The live
 * field is likewise a partial unique on `(capture_id, key)` WHERE `superseded = 0`: one current value
 * per key, the disagreements kept beside it.
 */

export const CAPTURE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS captures (
  id                       TEXT PRIMARY KEY,
  workspace_id             TEXT NOT NULL,
  document_id              TEXT NOT NULL,
  sha256                   TEXT NOT NULL,
  status                   TEXT NOT NULL DEFAULT 'needs_review'
                             CHECK (status IN ('needs_review','committed','discarded')),
  rescued_from_capture_id  TEXT,
  qr_present               INTEGER NOT NULL DEFAULT 0,
  swico_present            INTEGER NOT NULL DEFAULT 0,
  parse_notes              TEXT NOT NULL DEFAULT '[]',
  target_kind              TEXT CHECK (target_kind IN ('vendor_bill','expense_line')),
  target_id                TEXT,
  committed_by             TEXT,
  committed_at             TEXT,
  discard_reason           TEXT,
  created_by               TEXT NOT NULL,
  idempotency_key          TEXT,
  created_at               TEXT NOT NULL,
  updated_at               TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS captures_dedupe_live
  ON captures (workspace_id, sha256) WHERE status != 'discarded';

CREATE INDEX IF NOT EXISTS captures_by_status
  ON captures (workspace_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS capture_fields (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL,
  capture_id    TEXT NOT NULL,
  key           TEXT NOT NULL,
  value         TEXT NOT NULL,
  confidence    TEXT NOT NULL CHECK (confidence IN ('high','medium','low')),
  provenance    TEXT NOT NULL CHECK (provenance IN ('qr','swico','local_model','agent','operator')),
  superseded    INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS capture_fields_live
  ON capture_fields (capture_id, key) WHERE superseded = 0;

CREATE INDEX IF NOT EXISTS capture_fields_by_capture
  ON capture_fields (workspace_id, capture_id);
`;
