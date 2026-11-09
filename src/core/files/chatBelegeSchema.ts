/**
 * N02 (D183), Chat Belege: the four tables beside E00's, kept in E00's own module and concatenated onto
 * `SCHEMA_SQL` at the store (the `FILES_SCHEMA_SQL` / `FILE_UPLOAD_SCHEMA_SQL` pattern), so a concurrent
 * capability branch never edits one long string in `store/schema.ts`. Every row carries `workspace_id`
 * (§H-TENANT) and an `id` primary key, so G04's backup, restore and erase handle them like any other row.
 */

export const CHAT_BELEGE_SCHEMA_SQL = `
-- A file stored for a Vorschlag that is still waiting (N02 §4): its bytes are in stored_file_blob, its
-- metadata HERE and nowhere else. It is deliberately NOT a stored_file row until the approval of its own
-- Vorschlag releases it (critic F2), so no reader, verb or foreign key anywhere can name it: inert by
-- construction. The id is minted as a file id and becomes the stored_file id at release, so the
-- Vorschlag payload that names it stays true. The sweep deletes the row (and an unreferenced blob) once
-- its Vorschlag is no longer pending.
CREATE TABLE IF NOT EXISTS stored_file_pending (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  -- The agent_action (Vorschlag) the file waits on. NULL only inside the draft's own transaction.
  action_id    TEXT,
  -- How it arrived: 'draft' (an act's attach) or 'drop' (a drop link onto a pending Vorschlag).
  source       TEXT NOT NULL CHECK (source IN ('draft', 'drop')),
  title        TEXT NOT NULL,
  filename     TEXT NOT NULL,
  mime         TEXT NOT NULL,
  bytes        INTEGER NOT NULL,
  sha256       TEXT NOT NULL,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS stored_file_pending_action ON stored_file_pending (workspace_id, action_id);
CREATE INDEX IF NOT EXISTS stored_file_pending_blob ON stored_file_pending (workspace_id, sha256);

-- A one-time drop link (files_drop_link): the token is stored hashed (sha256), never in clear, bound to
-- one target, single-use, with an expiry from files.drop_link_hours.
CREATE TABLE IF NOT EXISTS file_drop_link (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspace(id),
  token_hash      TEXT NOT NULL,
  target_kind     TEXT NOT NULL CHECK (target_kind IN ('journal_entry', 'vendor_bill', 'bank_txn', 'drafted_action')),
  target_id       TEXT NOT NULL,
  created_by      TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  expires_at      TEXT NOT NULL,
  used_at         TEXT,
  used_by         TEXT,
  file_id         TEXT,
  idempotency_key TEXT,
  -- Critic F7: 1 once the minting call's memo no longer holds the clear token (used, expired, restored).
  memo_scrubbed   INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS file_drop_link_token ON file_drop_link (token_hash);
CREATE INDEX IF NOT EXISTS file_drop_link_target ON file_drop_link (workspace_id, target_kind, target_id);

-- The Belegeingang memory: every file the tick captured (or found already captured), by name, size and
-- modification time, so a kept file is never captured twice and a move that failed is retried.
CREATE TABLE IF NOT EXISTS belegeingang_seen (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  folder       TEXT NOT NULL,
  name         TEXT NOT NULL,
  size         INTEGER NOT NULL,
  mtime_ms     INTEGER NOT NULL,
  sha256       TEXT NOT NULL,
  capture_id   TEXT,
  duplicate    INTEGER NOT NULL DEFAULT 0,
  moved        INTEGER NOT NULL DEFAULT 0,
  seen_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS belegeingang_seen_file ON belegeingang_seen (workspace_id, folder, name, size, mtime_ms);

-- Critic F1: a capture under review whose receipt a BOOKING took through attach (or a drop) is closed as
-- booked; this row names the record that booked it and the filing row it got (captureHold.ts).
CREATE TABLE IF NOT EXISTS capture_settlement (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  capture_id   TEXT NOT NULL,
  entity_kind  TEXT NOT NULL,
  entity_id    TEXT NOT NULL,
  file_id      TEXT NOT NULL,
  actor        TEXT NOT NULL,
  at           TEXT NOT NULL,
  -- 'closed': a booking took the receipt and closed the capture; 'override': a person committed the
  -- capture although its receipt was already booked (critic round 2), with the required reason.
  kind         TEXT NOT NULL DEFAULT 'closed' CHECK (kind IN ('closed', 'override')),
  reason       TEXT
);
CREATE INDEX IF NOT EXISTS capture_settlement_capture ON capture_settlement (workspace_id, capture_id);

-- The last Belegeingang scan per workspace: what belegeingang_status and the Studio's status line read.
CREATE TABLE IF NOT EXISTS belegeingang_scan (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspace(id),
  folder        TEXT,
  state         TEXT NOT NULL,
  scanned_at    TEXT NOT NULL,
  captured      INTEGER NOT NULL DEFAULT 0,
  duplicates    INTEGER NOT NULL DEFAULT 0,
  errors_json   TEXT NOT NULL DEFAULT '[]'
);
CREATE UNIQUE INDEX IF NOT EXISTS belegeingang_scan_workspace ON belegeingang_scan (workspace_id);

-- R1 (receipt uniqueness, receiptGuard.ts): a person confirmed a second booking of a receipt that
-- already evidenced a live record. The holders it met, the reason, who and when, beside an audit row.
CREATE TABLE IF NOT EXISTS receipt_override (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  sha256       TEXT NOT NULL,
  target_kind  TEXT NOT NULL,
  target_id    TEXT,
  holders_json TEXT NOT NULL,
  reason       TEXT NOT NULL,
  action_id    TEXT,
  actor        TEXT NOT NULL,
  at           TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS receipt_override_sha ON receipt_override (workspace_id, sha256);

-- R1: the receipt holders a Vorschlag's card shows (stored at draft time, replaced when an approval
-- meets a holder the card did not show). The approval is judged against this list.
CREATE TABLE IF NOT EXISTS vorschlag_receipt_holders (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  action_id    TEXT NOT NULL,
  holders_json TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS vorschlag_receipt_holders_action ON vorschlag_receipt_holders (workspace_id, action_id);
`;
