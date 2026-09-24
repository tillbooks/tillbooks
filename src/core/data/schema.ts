/**
 * G04 data freedom: the one new table, `backups`, kept in G04's own module and concatenated onto
 * `SCHEMA_SQL` at the store (the A14/E00/G00 pattern: a capability's DDL sits beside the code that
 * writes it, so concurrent capability branches never all edit one long string in `store/schema.ts`).
 *
 * `backups` is a REGISTRY, not a ledger: one row per produced artifact (an export or a backup), each
 * in a terminal `status` (`complete` / `failed`), never mutated after it is written (spec §4). Every
 * row carries `workspace_id` (§H-TENANT), so `list_backups` is fenced to the one workspace the same
 * way every other read model is. The artifact bytes live on disk as a `.tillbackup` / `.tillexport`
 * bundle directory; `storage_ref` is that directory's path. The row records only the metadata a
 * history list and a verify need: the format, the top-level artifact hash, the byte size, the schema
 * and till versions the artifact was written under, and the per-table manifest as JSON.
 *
 * The primary key is `id` and the table is workspace_id-scoped, which is what OP3 registers `backup`
 * as an entity_kind against (`core/customization/entities.ts`): a custom field (a "Reason" select, a
 * "Keep until" date, spec §6b) hangs off a backup row exactly like any other entity kind's fields.
 */

export const DATA_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS backups (
  id             TEXT PRIMARY KEY,
  workspace_id   TEXT NOT NULL REFERENCES workspace(id),
  -- 'export' (a .tillexport jsonl_bundle) or 'backup' (a .tillbackup sqlite_snapshot). The enum's
  -- home is BACKUP_KINDS in core/data/portability.ts (the D0 convention: no CHECK here).
  kind           TEXT NOT NULL,
  -- 'jsonl_bundle' or 'sqlite_snapshot'. Single-sourced as BACKUP_FORMATS in the same module.
  format         TEXT NOT NULL,
  -- The artifact bundle DIRECTORY path (a .tillbackup/ or .tillexport/). Node ships no archiver, so
  -- an artifact is a hashable directory, not a single archive file (spec §0a.5).
  storage_ref    TEXT NOT NULL,
  -- The top-level artifact hash: sha256 of data.sqlite for a backup, of the concatenated manifest for
  -- an export. Re-hashed on write (create) and re-checked on read (verify), the E00 discipline.
  sha256         TEXT NOT NULL,
  byte_size      INTEGER NOT NULL,
  -- The SCHEMA_GENERATION the artifact was written under. Restore requires an EXACT match (spec
  -- §0a.6): loading unmigrated money rows into the live store would be a filing-grade defect.
  schema_version INTEGER NOT NULL,
  till_version   TEXT NOT NULL,
  -- JSON: { <table>: { rowCount, sha256 } }. The per-table manifest verify sanity-checks against.
  table_manifest TEXT NOT NULL,
  -- 'complete' or 'failed'. A failed run persists the reason inline rather than being recorded as a
  -- silent complete (spec US-G04.2 error path). Single-sourced as BACKUP_STATUSES.
  status         TEXT NOT NULL,
  created_by     TEXT,
  created_at     TEXT NOT NULL
);

-- The history list read model (list_backups) is "this workspace's artifacts, newest first".
CREATE INDEX IF NOT EXISTS backups_workspace
ON backups (workspace_id, created_at);
`;
