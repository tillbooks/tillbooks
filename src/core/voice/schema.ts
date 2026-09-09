/**
 * E05's three tables, kept in E05's own module and concatenated onto `SCHEMA_SQL` at the store,
 * the pattern A14/A19/A24/G00/C00/E00/E03/E04 established: a capability's DDL sits beside the code
 * that writes it, so concurrent capability branches never all edit one long string in
 * `store/schema.ts`.
 *
 * INDEX, NEVER COPY (OP6, spec §4/§6b Fixed). `voice_exemplar` holds a LOCATOR (`source_ref`), a
 * LOSSY VECTOR (`embedding`), and a HASH (`sha256`), and NEVER an excerpt: no `body`, `excerpt`
 * or `text` column exists anywhere in this cluster, which is the schema-level assertion of the
 * Art. 321 claim (`test/voice/no-copy-and-guards.test.mjs` reads it off the live PRAGMA and greps
 * the raw database file for a planted sentinel). `voice_profile.style_card` is the DISTILLED card
 * (conventions and statistics, spec §2 US-E05.1), not source material.
 *
 * NO `_rappen` COLUMN ANYWHERE (P3 by absence): a voice posts nothing and settles nothing, and the
 * same suite asserts it. Every row carries `workspace_id` (§H-TENANT). NONE of these tables is
 * OP3-registered, so custom fields, automation rules and plugins cannot attach (spec §6b: the
 * zero-egress inversion, fixed unless provably leak-safe).
 *
 * The exemplars are DERIVED state: E04's `mail_reindex` self-healing block purges `sent_mail`
 * exemplars whose source message left the index, and C00's `contacts_anonymise` purges the rows
 * referencing an erased person (`purgeVoiceForContact`), so nothing here outlives either its
 * source or its subject.
 */

export const VOICE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS voice_profile (
  id             TEXT PRIMARY KEY,
  workspace_id   TEXT NOT NULL REFERENCES workspace(id),
  account_id     TEXT NOT NULL REFERENCES mail_account(id),
  name           TEXT,
  style_card     TEXT NOT NULL,
  source_sha256  TEXT NOT NULL,
  exemplar_count INTEGER NOT NULL,
  model_ref      TEXT NOT NULL,
  built_at       TEXT NOT NULL,
  created_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS voice_profile_ws
ON voice_profile (workspace_id, account_id);

CREATE TABLE IF NOT EXISTS voice_exemplar (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  profile_id   TEXT NOT NULL REFERENCES voice_profile(id),
  source_kind  TEXT NOT NULL,
  source_ref   TEXT NOT NULL,
  embedding    BLOB NOT NULL,
  sha256       TEXT NOT NULL,
  created_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS voice_exemplar_profile
ON voice_exemplar (workspace_id, profile_id);

-- The reindex self-heal and the C00 purge both scan by source.
CREATE INDEX IF NOT EXISTS voice_exemplar_source
ON voice_exemplar (workspace_id, source_kind, source_ref);

CREATE TABLE IF NOT EXISTS runtime_selection (
  workspace_id TEXT PRIMARY KEY REFERENCES workspace(id),
  model_ref    TEXT NOT NULL,
  source       TEXT NOT NULL,
  gguf_path    TEXT,
  selected_at  TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
`;

/**
 * The E05 tables, exported as data so the guard suites can hold the schema assertions (no excerpt
 * column, no money column, no OP3 registration) to this list rather than to a hand-copied one.
 */
export const VOICE_TABLES = ['voice_profile', 'voice_exemplar', 'runtime_selection'] as const;
