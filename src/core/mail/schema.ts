/**
 * E04's four tables, kept in E04's own module and concatenated onto `SCHEMA_SQL` at the store, the
 * pattern A14/A19/A24/G00/C00/E00/E03 established: a capability's DDL sits beside the code that
 * writes it, so concurrent capability branches never all edit one long string in `store/schema.ts`.
 *
 * INDEX, NEVER COPY (OP6, spec §4/§6b Fixed). No table below carries a `body`, `excerpt`, `text`
 * or `raw` column: `mail_message` and `mail_draft` hold a LOCATOR (`store_ref`) and a HASH
 * (`body_sha256`), and the correspondence itself stays in the mail client's own store, which was
 * already on this disk. `mail_account` has NO credential column of any kind (no password, no
 * token, no oauth anything): E04 reads a file another application already wrote, so there is no
 * secret to hold, and the ABSENCE of the column is the schema-level assertion of that claim
 * (`test/mail/no-egress-and-money-path.test.mjs` reads it off the live PRAGMA).
 *
 * NO `_rappen` COLUMN ANYWHERE (P3 by absence): mail posts nothing, settles nothing, and the same
 * suite asserts it. Every row carries `workspace_id` (§H-TENANT). The index is DERIVED state: the
 * mail store is the authority, `mailstore.reindex` self-heals rows whose locator no longer
 * resolves, and C00's `contacts_anonymise` purges the rows that reference an erased person
 * (US-E04.5), so nothing here outlives either its source or its subject.
 */

export const MAIL_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS mail_account (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspace(id),
  adapter         TEXT NOT NULL,
  address         TEXT NOT NULL,
  store_path      TEXT NOT NULL,
  enabled         INTEGER NOT NULL DEFAULT 1,
  last_indexed_at TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS mail_account_ws
ON mail_account (workspace_id);

CREATE TABLE IF NOT EXISTS mail_thread (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  account_id   TEXT NOT NULL REFERENCES mail_account(id),
  thread_key   TEXT NOT NULL,
  subject      TEXT,
  contact_id   TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  UNIQUE (account_id, thread_key)
);

CREATE INDEX IF NOT EXISTS mail_thread_ws
ON mail_thread (workspace_id, account_id);

CREATE INDEX IF NOT EXISTS mail_thread_contact
ON mail_thread (workspace_id, contact_id);

CREATE TABLE IF NOT EXISTS mail_message (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  account_id   TEXT NOT NULL REFERENCES mail_account(id),
  thread_id    TEXT NOT NULL REFERENCES mail_thread(id),
  message_id   TEXT NOT NULL,
  subject      TEXT,
  from_address TEXT,
  to_address   TEXT,
  direction    TEXT NOT NULL,
  sent_at      TEXT,
  store_ref    TEXT NOT NULL,
  body_sha256  TEXT NOT NULL,
  contact_id   TEXT,
  indexed_at   TEXT NOT NULL,
  UNIQUE (account_id, message_id)
);

CREATE INDEX IF NOT EXISTS mail_message_thread
ON mail_message (workspace_id, thread_id);

-- The C00 timeline union (US-E04.6) and the anonymise purge (US-E04.5) both scan by person.
CREATE INDEX IF NOT EXISTS mail_message_contact
ON mail_message (workspace_id, contact_id);

CREATE TABLE IF NOT EXISTS mail_draft (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  account_id   TEXT NOT NULL REFERENCES mail_account(id),
  thread_id    TEXT NOT NULL REFERENCES mail_thread(id),
  draft_run_id TEXT,
  in_reply_to  TEXT,
  store_ref    TEXT NOT NULL,
  body_sha256  TEXT NOT NULL,
  created_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS mail_draft_thread
ON mail_draft (workspace_id, thread_id);
`;

/**
 * The E04 tables, exported as data so the erasure-coverage test can hold C00's purge to this list
 * rather than to a hand-copied one (spec §2 US-E04.5 Boundary: adding a table to this cluster
 * without adding it to erasure fails the build).
 */
export const MAIL_TABLES = ['mail_account', 'mail_thread', 'mail_message', 'mail_draft'] as const;
