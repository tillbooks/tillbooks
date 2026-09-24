/**
 * G18 US-G18.4, the E00 CHUNK-UPLOAD LANE tables, kept in E00's own module beside the code that
 * writes them (the FILES_SCHEMA_SQL pattern), so a concurrent capability branch never edits one long
 * string in `store/schema.ts`.
 *
 * WHY A SEPARATE LANE INSTEAD OF RAISING `MAX_FILE_BYTES`. The single-call bound (25 MiB) protects
 * every surface that has no migration excuse, and it must stay. A multi-hundred-megabyte GL export
 * enters through THIS lane instead: `files_upload_begin` opens a session, `files_upload_chunk`
 * appends bounded pieces, `files_upload_commit` verifies the accumulated sha256 and mints the blob.
 * The migration-class ceiling is 500 MB, declared per session in `size_bytes`.
 *
 * WHY THE COMMITTED LARGE BLOB IS STORED IN SEGMENTS. better-sqlite3 hands a BLOB back as one Buffer,
 * so a single-row store cannot be read without materialising the whole file. A migration-class blob
 * (over the single-call bound) is therefore kept as ordered SEGMENT rows keyed by (workspace, sha256,
 * seq); the streaming byte-range reader yields one segment at a time, so peak memory on the read path
 * is one segment, independent of the source size. A blob at or under the bound keeps the ordinary
 * single-row `stored_file_blob` path, so nothing about the small-file read model changes.
 *
 * §H-TENANT: every row here carries `workspace_id` and every read is scoped to it. Incomplete upload
 * sessions expire (the `expires_at` column) and their chunk rows are swept before they can leave a
 * phantom blob, because a chunk table row is NOT a `stored_file_blob` row: nothing is content-addressed
 * until commit verifies the hash.
 */

export const FILE_UPLOAD_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS file_upload_session (
  id             TEXT PRIMARY KEY,
  workspace_id   TEXT NOT NULL REFERENCES workspace(id),
  filename       TEXT NOT NULL,
  title          TEXT NOT NULL,
  mime           TEXT NOT NULL,
  -- The size the caller DECLARED at begin. Commit verifies the accumulated bytes against it.
  size_bytes     INTEGER NOT NULL,
  -- What this upload is for. 'migration_source' is the only value today; a bounded free-text column
  -- rather than an enum, because the intent is a hint for the retention/classification path, not a gate.
  intent         TEXT NOT NULL,
  -- The running total of bytes received across committed chunks, so a resume knows where it is.
  received_bytes INTEGER NOT NULL DEFAULT 0,
  -- open | committed | aborted. Never a third live state.
  status         TEXT NOT NULL DEFAULT 'open',
  -- Set on commit: the stored_file id the session minted, so a replayed commit returns it.
  committed_file_id TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  -- 24 h after the last activity. A session past this is swept and never mints a blob.
  expires_at     TEXT NOT NULL
);

-- The chunk staging area. NOT content-addressed: these bytes are provisional until commit verifies
-- the accumulated hash, so they live under the session, ordered by seq, and are deleted at commit.
CREATE TABLE IF NOT EXISTS file_upload_chunk (
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  upload_id    TEXT NOT NULL,
  seq          INTEGER NOT NULL,
  content      BLOB NOT NULL,
  bytes        INTEGER NOT NULL,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (workspace_id, upload_id, seq)
);

-- The committed large-blob content, segmented so the streaming reader can yield one piece at a time.
-- Keyed by the content hash exactly as stored_file_blob is, so a re-upload of identical bytes is a
-- no-op (INSERT OR IGNORE), and scoped to the workspace so one tenant's delete cannot take another's.
CREATE TABLE IF NOT EXISTS stored_file_segment (
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  sha256       TEXT NOT NULL,
  seq          INTEGER NOT NULL,
  content      BLOB NOT NULL,
  bytes        INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, sha256, seq)
);
`;
