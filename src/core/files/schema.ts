/**
 * E00's three tables, kept in E00's own module and concatenated onto `SCHEMA_SQL` at the store, the
 * pattern A14/A19/A24/G00/C00 established: a capability's DDL sits beside the code that writes it, so
 * concurrent capability branches never all edit one long string in `store/schema.ts`.
 *
 * WHY THE BYTES LIVE IN A ROW. An engine verb is handed a `WorkspaceContext` carrying the store, the
 * clock and the ids, and NO filesystem seam (`src/core/context.ts`); the one persistence adapter is
 * deliberately the sole writer of local state. A path-based blob store would have to invent a second
 * one, and the OR 958f trail would then rest on two artifacts that can disagree: a row saying a file
 * exists and a directory that may not hold it. Content-addressing inside the store makes three things
 * structural instead of hoped for: the integrity re-check in `getFileContent` re-hashes the bytes that
 * were really stored, "the blob is erased on delete" is a row deletion inside the metadata's own
 * transaction and so cannot half-happen, and a test needs no temporary directory to prove any of it.
 *
 * THE BLOB IS SCOPED TO THE WORKSPACE AS WELL AS TO THE HASH, and that costs a duplicated blob when
 * two tenants store identical bytes. It is the right trade: a shared row would mean one tenant's
 * `DELETE` could remove another tenant's only copy of a business record, and a row whose existence is
 * evidence about tenant B would be readable through tenant A (§H-TENANT). Deduplication WITHIN a
 * workspace is what actually pays here anyway, because that is where the same voucher gets uploaded
 * twice.
 *
 * `stored_file` IS APPEND-ONLY IN THE VERSION DIMENSION and mutable in the metadata dimension, which
 * is not a compromise but the shape OR 958f asks for: a new version is a new ROW pointing at its
 * predecessor (`supersedes_id`), and no verb ever rewrites a prior version's `sha256`, `bytes`,
 * `storage_ref` or `version`. Title, tags, folder, link and retention are metadata ABOUT the filing
 * and are edited in place, exactly as a paper folder's label is.
 */

export const FILES_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS file_folder (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  name         TEXT NOT NULL,
  parent_id    TEXT,
  -- Materialised so the tree renders from one read and a descendant sweep is a prefix match rather
  -- than a recursive query. Re-materialised for every descendant inside the rename transaction.
  path         TEXT NOT NULL,
  created_at   TEXT NOT NULL
);

-- The uniqueness the tree depends on: two siblings cannot share a name, because the path column
-- encodes the
-- whole ancestry. Enforced by the database rather than only by the verb, so a future second writer
-- cannot produce a tree with two identical branches.
CREATE UNIQUE INDEX IF NOT EXISTS file_folder_path
ON file_folder (workspace_id, path);

CREATE TABLE IF NOT EXISTS stored_file (
  id             TEXT PRIMARY KEY,
  workspace_id   TEXT NOT NULL REFERENCES workspace(id),
  folder_id      TEXT REFERENCES file_folder(id),
  title          TEXT NOT NULL,
  filename       TEXT NOT NULL,
  mime           TEXT NOT NULL,
  bytes          INTEGER NOT NULL,
  sha256         TEXT NOT NULL,
  -- The blob key, and it IS the sha256 (see the module docblock). Kept as its own column because the
  -- spec's read model names it and because a future carrier could key differently without a
  -- migration of every consumer.
  storage_ref    TEXT NOT NULL,
  -- A JSON array of freeform strings, never a fixed enum, with updateFile as the single writer.
  tags           TEXT NOT NULL DEFAULT '[]',
  -- OP3: what this file is attached TO. Validated against G00's ENTITY_KINDS on write; nullable
  -- because a file may be filed in a folder before anyone knows which record it evidences.
  entity_kind    TEXT,
  entity_id      TEXT,
  retention_until  TEXT,
  -- §H-ENUM RETENTION_SOURCES (manual|statutory_auto), NULL while no retention is set at all.
  retention_source TEXT,
  -- THE DURABLE MEMORY OF THE STATUTE, and the column that makes the floor recomputable.
  --
  -- retention_until is what the file is kept TO and an operator may raise it by hand, which flips
  -- retention_source to manual. That flip used to be the whole record of the statutory date, so a
  -- legitimate EXTENSION erased the derivation and a later re-link to a non-accounting record left no
  -- floor on either side of the rail: measured on 30.07.2026, five ok answers in a row ending in an
  -- erased Buchungsbeleg. This column is written by linkFile (for a target that is already posted
  -- evidence) and by the D63 posting-time hook (for a target that posts after the link), and it is
  -- never lowered and never cleared by anything, so OR 958f survives every provenance change, every
  -- re-link and every hand-set date. A link to a still-DRAFT record writes nothing here (D63): the
  -- floor derives from posted evidence, and a never-posted draft that is deleted leaves no lock.
  --
  -- THE INVARIANT: retention_until >= retention_statutory_until, always. linkFile raises the former
  -- to the latter, setFileRetention refuses anything below the recomputed floor, and a new version
  -- inherits both. Nothing in E00 can produce a row where a statutory date is stored under a shorter
  -- one, which is why the read model may derive its lock from the two columns without a query.
  retention_statutory_until TEXT,
  version        INTEGER NOT NULL DEFAULT 1,
  supersedes_id  TEXT REFERENCES stored_file(id),
  -- P8: an agent staged this delete and a human has not confirmed it. 0/1, never a third state.
  pending_delete INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

-- The list read model is "this workspace's heads, newest first", optionally within one folder, so the
-- index carries the tenant and the folder and orders by creation.
CREATE INDEX IF NOT EXISTS stored_file_folder
ON stored_file (workspace_id, folder_id, created_at DESC);

-- The OP3 read model (listLinkedFiles) is "everything attached to this record".
CREATE INDEX IF NOT EXISTS stored_file_entity
ON stored_file (workspace_id, entity_kind, entity_id);

-- The version chain is walked in both directions: forward to find the head, backward to build the
-- history. One index over the predecessor pointer answers both.
CREATE INDEX IF NOT EXISTS stored_file_chain
ON stored_file (workspace_id, supersedes_id);

CREATE TABLE IF NOT EXISTS stored_file_blob (
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  sha256       TEXT NOT NULL,
  bytes        INTEGER NOT NULL,
  content      BLOB NOT NULL,
  PRIMARY KEY (workspace_id, sha256)
);
`;
