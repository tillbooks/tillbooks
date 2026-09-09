/**
 * A33, EBICS bank channel: the channel's three tables (spec §4 data model).
 *
 * Three WHOLLY NEW tables, so `CREATE TABLE IF NOT EXISTS` both creates them on a fresh database and
 * adds them to an existing one at the next open, with no data migration (there is no stored number
 * whose meaning changes). Nothing here is an `ADDITIVE_COLUMNS` widening of an existing table, so the
 * G04 snapshot's base-CREATE stays complete (the additive-column trap does not apply), exactly the
 * A32 `ebillSchema.ts` shape.
 *
 * NO CHECK CONSTRAINT on any enum column (`state`, `direction`, `order_type`, `status`), matching the
 * §D0 convention: the enums live at the single §H-ENUM source (`enums.ts`), validated at the verb
 * boundary. Every table stamps `workspace_id` (§H-TENANT).
 *
 * `A33 posts nothing` (P3 by delegation, spec §4): none of these tables is a ledger table, and nothing
 * in `core/banking/ebics/` ever calls `postEntry`. Statements enter the books only through A20's
 * `importCamt`; settlement happens only via A20/A21/A14/A18.
 *
 * `key_ref` is a LOCATOR into the platform keystore, NEVER key material: no private key, no
 * passphrase, and no plaintext key of any kind is ever stored in SQLite (spec §4, tripwire 3). Only
 * public-key fingerprints (hashes) are kept, in `bank_key_hashes` (the bank's, HPB-verified) and in
 * the INI letter artifact (TILL's own, for the paper the customer signs).
 */

export const EBICS_SCHEMA_SQL = `
-- One connection row per bank CONTRACT, not per account (spec §4): an EBICS subscription is
-- host ID + partner ID + user ID, and the bank's customer protocol runs on the partner ID. One
-- contract means one key ceremony, however many accounts it authorizes. The partial unique index
-- below enforces one live (non-retired) connection per (host_id, partner_id, user_id) per workspace.
CREATE TABLE IF NOT EXISTS ebics_connection (
  id                    TEXT PRIMARY KEY,
  workspace_id          TEXT NOT NULL REFERENCES workspace(id),
  host_url              TEXT NOT NULL,
  host_id               TEXT NOT NULL,
  partner_id            TEXT NOT NULL,
  user_id_ebics         TEXT NOT NULL,
  protocol_version      TEXT NOT NULL DEFAULT 'H005',
  state                 TEXT NOT NULL,
  -- The institution's captured BTF offering (SMPG §5 / "BTF parameters CH"), json; never hardcoded.
  btf_params            TEXT,
  -- The signature procedures and key length agreed with the institution (SMPG §3.4), json; default
  -- A005 + 2048. Captured per connection, never a unilateral TILL constant.
  key_params            TEXT,
  -- A LOCATOR into the OS keychain / encrypted keystore. NO key material, ever, in SQLite.
  key_ref               TEXT,
  -- The HPB-verified bank public-key fingerprints, json. Hashes only, never the keys themselves.
  bank_key_hashes       TEXT,
  -- The INI letter is an E00 FILE (files table), not a document(id) row, so no FK here (the A32
  -- artifact_document_id precedent): the paper the customer signs and posts to the bank.
  ini_letter_document_id TEXT,
  activated_at          TEXT,
  last_sync_at          TEXT,
  -- A36 (live bank feed): the G01 automation rule driving this connection's scheduled sync, or NULL
  -- when no cadence is set (default OFF). Also in ADDITIVE_COLUMNS for an A33 book predating A36.
  sync_rule_id          TEXT,
  created_by            TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);

-- One LIVE connection per (host_id, partner_id, user_id) per workspace: a second ceremony on the same
-- contract is refused, the account is routed under the existing one instead (spec §4). A retired
-- connection no longer counts, so a fresh contract may reuse the same identifiers later.
CREATE UNIQUE INDEX IF NOT EXISTS ebics_connection_one_live_per_contract
ON ebics_connection (workspace_id, host_id, partner_id, user_id_ebics)
WHERE state != 'retired';

CREATE INDEX IF NOT EXISTS ebics_connection_by_workspace
ON ebics_connection (workspace_id, state);

-- The routing table: which registered A19 accounts travel over which contract (spec §4). A Swiss SME
-- with a CHF and a EUR account at the same bank registers both under the one connection: one ceremony,
-- one INI letter, statements for both in the same BTD ZIP, routed back by IBAN.
CREATE TABLE IF NOT EXISTS ebics_connection_account (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspace(id),
  connection_id   TEXT NOT NULL REFERENCES ebics_connection(id),
  bank_account_id TEXT NOT NULL REFERENCES bank_account(id),
  created_at      TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS ebics_connection_account_unique
ON ebics_connection_account (connection_id, bank_account_id);

CREATE INDEX IF NOT EXISTS ebics_connection_account_by_account
ON ebics_connection_account (workspace_id, bank_account_id);

-- APPEND-ONLY, the local twin of the bank's own customer protocol (spec §4, §H-AUDIT spirit). A
-- status progression appends a NEW row with the same order_ref, never updates history. An 'intent'
-- row with no successor is the durable trace of an upload whose outcome is unknown
-- (transmit_in_doubt, a DERIVED read-model state, never a stored status). order_ref is the grouping
-- key that makes the append-only progression real; direction/order_type/status live at enums.ts.
CREATE TABLE IF NOT EXISTS ebics_order_log (
  id               TEXT PRIMARY KEY,
  workspace_id     TEXT NOT NULL REFERENCES workspace(id),
  connection_id    TEXT NOT NULL REFERENCES ebics_connection(id),
  order_ref        TEXT NOT NULL,
  direction        TEXT NOT NULL,
  order_type       TEXT NOT NULL,
  btf_service_name TEXT,
  btf_msg_name     TEXT,
  payload_sha256   TEXT,
  -- Pattern OP3: the local record this order relates to (payment_batch | bank_statement), never a FK
  -- into the ledger. A33 never writes a ledger row; this is a back-reference for the read model.
  related_kind     TEXT,
  related_id       TEXT,
  status           TEXT NOT NULL,
  bank_reason      TEXT,
  occurred_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ebics_order_log_by_connection
ON ebics_order_log (workspace_id, connection_id, occurred_at);

CREATE INDEX IF NOT EXISTS ebics_order_log_by_ref
ON ebics_order_log (workspace_id, order_ref, occurred_at);

CREATE INDEX IF NOT EXISTS ebics_order_log_by_related
ON ebics_order_log (workspace_id, related_kind, related_id);
`;
