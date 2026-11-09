/**
 * G06's three tables, kept in G06's own module and concatenated onto `SCHEMA_SQL` at the store,
 * the pattern A14/A19/A24/G00/C00/E00/E03 established: a capability's DDL sits beside the code
 * that writes it, so concurrent capability branches never all edit one long string in
 * `store/schema.ts`.
 *
 * NO `_rappen` (or `_minor`) COLUMN ANYWHERE, asserted by `test/notifications/no-money-path.test.mjs`
 * rather than merely stated (spec §4: a notification never touches the journal, so P3 is satisfied
 * by having nothing to delegate). Every row carries `workspace_id` (§H-TENANT). The enum columns
 * (`status`, `delivered_via`, `channel`, `digest`) are §H-ENUM sets enforced by the engine, not by
 * CHECK constraints: the single source of truth is `enums.ts` (the E03/C00 pattern).
 *
 * `digest_run` is created FIRST because `inbox_item.digest_run_id` references it; SQLite would
 * tolerate a forward reference, but the schema should not lean on that.
 */

export const NOTIFICATIONS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS digest_run (
  id                 TEXT PRIMARY KEY,
  workspace_id       TEXT NOT NULL REFERENCES workspace(id),
  user_id            TEXT NOT NULL,
  channel            TEXT NOT NULL,
  period_start       TEXT NOT NULL,
  period_end         TEXT NOT NULL,
  item_count         INTEGER NOT NULL DEFAULT 0,
  status             TEXT NOT NULL,
  local_artifact_ref TEXT,
  artifact_json      TEXT,
  transmitted        INTEGER NOT NULL DEFAULT 0,
  rendered_at        TEXT NOT NULL,
  transmitted_at     TEXT
);

-- The per-recipient run history the honesty record is read by (newest first).
CREATE INDEX IF NOT EXISTS digest_run_recipient
ON digest_run (workspace_id, user_id, rendered_at);

CREATE TABLE IF NOT EXISTS inbox_item (
  id               TEXT PRIMARY KEY,
  workspace_id     TEXT NOT NULL REFERENCES workspace(id),
  user_id          TEXT NOT NULL,
  event            TEXT NOT NULL,
  entity_kind      TEXT,
  entity_id        TEXT,
  summary_i18n_key TEXT NOT NULL,
  summary_params   TEXT NOT NULL DEFAULT '{}',
  status           TEXT NOT NULL DEFAULT 'unread',
  delivered_via    TEXT NOT NULL DEFAULT 'inbox',
  digest_run_id    TEXT REFERENCES digest_run(id),
  created_at       TEXT NOT NULL,
  read_at          TEXT,
  archived_at      TEXT
);

-- The queue read model (notifications_list, P5): one user's items by status, newest first.
CREATE INDEX IF NOT EXISTS inbox_item_queue
ON inbox_item (workspace_id, user_id, status, created_at);

-- The digest gather (notifications_run_digest): one user's items inside a created_at window.
CREATE INDEX IF NOT EXISTS inbox_item_window
ON inbox_item (workspace_id, user_id, created_at);

CREATE TABLE IF NOT EXISTS notification_pref (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  user_id      TEXT NOT NULL,
  event        TEXT NOT NULL,
  channel      TEXT NOT NULL,
  enabled      INTEGER NOT NULL DEFAULT 1,
  digest       TEXT NOT NULL DEFAULT 'instant',
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

-- One row per (recipient, event, channel): the upsert key setPreference resolves against.
CREATE UNIQUE INDEX IF NOT EXISTS notification_pref_once
ON notification_pref (workspace_id, user_id, event, channel);
`;
