/**
 * A37, managed bank connectivity: the managed channel's three tables (spec §4 data model), mirroring
 * A33's `ebics/schema.ts` shapes so the status panel and read models stay one code path.
 *
 * Three WHOLLY NEW tables, so `CREATE TABLE IF NOT EXISTS` both creates them on a fresh database and
 * adds them to an existing one at the next open, with no data migration. Nothing here is an
 * `ADDITIVE_COLUMNS` widening of an existing table, so the G04 snapshot's base-CREATE stays complete.
 *
 * NO CHECK CONSTRAINT on any enum column (`provider`, `state`, `direction`, `kind`, `status`): the
 * enums live at the single §H-ENUM source (`enums.ts`), validated at the verb boundary (the §D0
 * convention A33 set). Every table stamps `workspace_id` (§H-TENANT).
 *
 * A37 POSTS NOTHING (P3 by delegation, spec §4): none of these tables is a ledger table, and nothing
 * in `core/banking/managed/` ever calls `postEntry`. Statements enter the books only through A20's
 * `importCamt`; settlement happens only via A20/A21/A14/A18.
 *
 * THE CREDENTIAL-FREE INVARIANT (spec §3 clause 1, tripwire 2): there is NO column here that can hold
 * a password, token, or certificate. `consent_ref` is an opaque relay-side handle, never a secret;
 * the platform's mTLS identity and any Provider Tokens live relay-side, and the two custody worlds
 * never touch. A schema scan asserts this holds.
 */

export const MANAGED_SCHEMA_SQL = `
-- One managed connection row per relay consent (spec §4), the A33 ebics_connection shape without any
-- key/certificate columns: the managed rail holds no local key material. state machine at enums.ts.
-- consent_ref is an OPAQUE relay handle (a routing reference), never a token or a secret.
CREATE TABLE IF NOT EXISTS managed_connection (
  id                      TEXT PRIMARY KEY,
  workspace_id            TEXT NOT NULL REFERENCES workspace(id),
  provider                TEXT NOT NULL,
  bank_ref                TEXT NOT NULL,
  state                   TEXT NOT NULL,
  -- The consented scopes (json array of 'ais'|'pss'). Data-access scope, never a credential.
  scopes                  TEXT,
  -- An OPAQUE relay-side consent handle. NOT a token, NOT a secret: the relay resolves it to the
  -- customer's Provider Token, which never reaches this device (spec §3, §4).
  consent_ref             TEXT,
  -- The bank-reported consent expiry, when the bank reports one (spec §4). A date, never a secret.
  bank_consent_expires_at TEXT,
  last_sync_at            TEXT,
  created_by              TEXT,
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL
);

-- One LIVE connection per (provider, bank_ref) per workspace: a second connect on the same relay
-- routes the account under the existing one instead (spec §4, the A33 one-ceremony rule). A retired
-- connection no longer counts, so a fresh consent may reuse the same reference later.
CREATE UNIQUE INDEX IF NOT EXISTS managed_connection_one_live_per_ref
ON managed_connection (workspace_id, provider, bank_ref)
WHERE state != 'retired';

CREATE INDEX IF NOT EXISTS managed_connection_by_workspace
ON managed_connection (workspace_id, state);

-- The routing table: which registered A19 accounts travel over which managed connection (spec §4),
-- the same shape as A33's ebics_connection_account.
CREATE TABLE IF NOT EXISTS managed_connection_account (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspace(id),
  connection_id   TEXT NOT NULL REFERENCES managed_connection(id),
  bank_account_id TEXT NOT NULL REFERENCES bank_account(id),
  created_at      TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS managed_connection_account_unique
ON managed_connection_account (connection_id, bank_account_id);

CREATE INDEX IF NOT EXISTS managed_connection_account_by_account
ON managed_connection_account (workspace_id, bank_account_id);

-- APPEND-ONLY, the local twin of the relay's delivery log (spec §4, §H-AUDIT spirit). A status
-- progression appends a NEW row with the same order_ref, never updates history. An 'intent' row with
-- no successor is the durable trace of a payment submission whose outcome is unknown
-- (transmit_in_doubt, a DERIVED read-model state, never a stored status). order_ref is the grouping
-- key that makes the append-only progression real; direction/kind/status live at enums.ts.
CREATE TABLE IF NOT EXISTS managed_order_log (
  id             TEXT PRIMARY KEY,
  workspace_id   TEXT NOT NULL REFERENCES workspace(id),
  connection_id  TEXT NOT NULL REFERENCES managed_connection(id),
  order_ref      TEXT NOT NULL,
  direction      TEXT NOT NULL,
  kind           TEXT NOT NULL,
  msg_name       TEXT,
  payload_sha256 TEXT,
  -- Pattern OP3: the local record this order relates to (payment_batch | bank_statement), never a FK
  -- into the ledger. A37 never writes a ledger row; this is a back-reference for the read model.
  related_kind   TEXT,
  related_id     TEXT,
  status         TEXT NOT NULL,
  bank_reason    TEXT,
  occurred_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS managed_order_log_by_connection
ON managed_order_log (workspace_id, connection_id, occurred_at);

CREATE INDEX IF NOT EXISTS managed_order_log_by_ref
ON managed_order_log (workspace_id, order_ref, occurred_at);

CREATE INDEX IF NOT EXISTS managed_order_log_by_related
ON managed_order_log (workspace_id, related_kind, related_id);
`;
