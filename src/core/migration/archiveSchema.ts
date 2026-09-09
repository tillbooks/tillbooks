/**
 * G13's tables, kept in G13's own module and concatenated onto `SCHEMA_SQL` at the store, the
 * pattern A14/A19/A24/G00/C00/E00/A26/G10 established: a capability's DDL sits beside the code that
 * writes it, so concurrent capability branches never all edit one long string in `store/schema.ts`.
 *
 * FOUR TABLES AND A GATE, ALL OUTSIDE THE LIVE LEDGER. The archive is the prior system's journal,
 * held beside `journal_entry` and STRUCTURALLY incapable of entering it (spec §4, the two walls):
 * nothing here references a `journal_*` table, and no live read model references these. The tenant
 * fence is §H-TENANT on every table; the only cross-table references are to the migration family
 * (`migration_plan`, `migration_step`) and to `workspace`.
 *
 * `gl_archive_entry.reposted_entry_id` is G14's NAMED SEAM: it stays NULL until a G14 exists to
 * write it, and nothing else in G13 anticipates re-posting (spec §3 OUT of scope).
 *
 * THE TRIGGER DISCIPLINE mirrors D85 §1's posted-entry protection, applied on purpose rather than
 * discovered later: UPDATE is refused always, DELETE is refused unless the engine's own purge path
 * has opened the `gl_archive_purge_gate` for the workspace inside its transaction. GeBüV Art. 9
 * asks that alterations be detectable; the strongest form of detectable is impossible.
 *
 * NO CASCADE ANYWHERE, matching the house rule: the purge deletes lines before entries explicitly,
 * inside one transaction, with the gate open.
 */

export const GL_ARCHIVE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS gl_archive_entry (
  id                 TEXT PRIMARY KEY,
  workspace_id       TEXT NOT NULL REFERENCES workspace(id),
  plan_id            TEXT NOT NULL REFERENCES migration_plan(id),
  step_id            TEXT NOT NULL REFERENCES migration_step(id),
  source_entry_id    TEXT,
  entry_date         TEXT NOT NULL,
  description        TEXT,
  -- The E00 file id of the source export this entry arrived from (the Beleg link, US-G09.8).
  source_ref         TEXT,
  -- 1 when the source entry balanced internally; 0 imports FLAGGED, never corrected (US-G13.5).
  balanced           INTEGER NOT NULL DEFAULT 1,
  -- // INTEGRATION-SEAM(G14): stays NULL until a G14 exists to write it.
  reposted_entry_id  TEXT,
  created_at         TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS gl_archive_entry_by_date
ON gl_archive_entry (workspace_id, entry_date);

CREATE INDEX IF NOT EXISTS gl_archive_entry_by_step
ON gl_archive_entry (workspace_id, step_id);

CREATE TABLE IF NOT EXISTS gl_archive_line (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspace(id),
  entry_id            TEXT NOT NULL REFERENCES gl_archive_entry(id),
  -- The SOURCE system's account number and label: evidence, kept verbatim.
  source_account      TEXT NOT NULL,
  source_account_name TEXT,
  -- The G10-mapped A01 account id. NULL = unmapped, imported anyway (US-G13.1 error case).
  target_account_id   TEXT,
  -- Integer Rappen, copied verbatim from the source, never recomputed (P2 by omission).
  debit_minor         INTEGER NOT NULL DEFAULT 0,
  credit_minor        INTEGER NOT NULL DEFAULT 0,
  currency            TEXT,
  description         TEXT
);

CREATE INDEX IF NOT EXISTS gl_archive_line_by_entry
ON gl_archive_line (workspace_id, entry_id);

CREATE INDEX IF NOT EXISTS gl_archive_line_by_target
ON gl_archive_line (workspace_id, target_account_id);

-- One row per archived month (YYYY-MM): the retention ledger the purge consults, and the purge
-- marker the Archiv tab renders where the periods were (US-G13.4).
CREATE TABLE IF NOT EXISTS gl_archive_period (
  workspace_id    TEXT NOT NULL REFERENCES workspace(id),
  period          TEXT NOT NULL,
  entry_count     INTEGER NOT NULL DEFAULT 0,
  -- OR Art. 958f: ten years, beginning with the end of the fiscal year the period belongs to.
  retention_until TEXT NOT NULL,
  purged_at       TEXT,
  purge_actor     TEXT,
  purge_reason    TEXT,
  purge_row_count INTEGER,
  PRIMARY KEY (workspace_id, period)
);

-- The durable record of BOTH purge outcomes (spec §0 correction 3): a completed purge AND a
-- refusal on retention grounds, each with its statutory reference. The refusal record IS the
-- answer a data subject receives (US-G13.4; D86 attorney question 2 stays a lawyer's).
CREATE TABLE IF NOT EXISTS gl_archive_purge_record (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspace(id),
  period_from   TEXT NOT NULL,
  period_to     TEXT NOT NULL,
  -- purged | refused (single-sourced in archive.ts, the §D0 convention: no CHECK here).
  outcome       TEXT NOT NULL,
  reason        TEXT NOT NULL,
  statutory_ref TEXT,
  actor         TEXT NOT NULL,
  row_count     INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS gl_archive_purge_record_by_workspace
ON gl_archive_purge_record (workspace_id, created_at);

-- The transient purge gate: a row exists ONLY inside archivePurge's (or a wholesale supersede's)
-- transaction. Every bare DELETE aborts; only the engine's own write paths open the gate.
CREATE TABLE IF NOT EXISTS gl_archive_purge_gate (
  workspace_id TEXT PRIMARY KEY
);

-- GeBüV Art. 9: alterations detectable, here impossible. UPDATE refused always (there is no update
-- verb, US-G13.3); DELETE refused unless the purge gate is open for the workspace.
CREATE TRIGGER IF NOT EXISTS gl_archive_entry_no_update
BEFORE UPDATE ON gl_archive_entry
BEGIN
  SELECT RAISE(ABORT, 'archive_immutable');
END;

CREATE TRIGGER IF NOT EXISTS gl_archive_entry_no_delete
BEFORE DELETE ON gl_archive_entry
WHEN NOT EXISTS (SELECT 1 FROM gl_archive_purge_gate WHERE workspace_id = OLD.workspace_id)
BEGIN
  SELECT RAISE(ABORT, 'archive_immutable');
END;

CREATE TRIGGER IF NOT EXISTS gl_archive_line_no_update
BEFORE UPDATE ON gl_archive_line
BEGIN
  SELECT RAISE(ABORT, 'archive_immutable');
END;

CREATE TRIGGER IF NOT EXISTS gl_archive_line_no_delete
BEFORE DELETE ON gl_archive_line
WHEN NOT EXISTS (SELECT 1 FROM gl_archive_purge_gate WHERE workspace_id = OLD.workspace_id)
BEGIN
  SELECT RAISE(ABORT, 'archive_immutable');
END;
`;
