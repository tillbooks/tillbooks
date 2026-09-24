/**
 * A32, eBill issuing: the delivery record's tables (spec §4 data model).
 *
 * Three WHOLLY NEW tables, so `CREATE TABLE IF NOT EXISTS` both creates them on a fresh database and
 * adds them to an existing one at the next open, with no data migration (there is no stored number
 * whose meaning changes). Nothing here is an `ADDITIVE_COLUMNS` widening of an existing table, so the
 * G04 snapshot's base-CREATE stays complete (the additive-column trap does not apply).
 *
 * NO CHECK CONSTRAINT on `status`, `format`, `bc_function` or `partner_status`, matching the §D0
 * convention: the enums live at the single §H-ENUM source (`ebillEnums.ts`), validated at the verb
 * boundary. `partner_status` is deliberately unconstrained because TILL does not own that enum and an
 * unknown reported value must survive (spec §7). Every table stamps `workspace_id` (§H-TENANT).
 *
 * `A32 posts nothing` (P3 by absence): none of these tables is a ledger table, and `core/sales/ebill.ts`
 * never calls `postEntry`. This moves a document; the financial event happened at A11's issue.
 */

export const EBILL_SCHEMA_SQL = `
-- One eBill config row per workspace (spec §4). Absent row = not configured. The biller_pid is the
-- SWP billerPid the owner received from a certified network partner at enrollment (a commercial step,
-- never a verb). Keyed by workspace so setEbillConfig is a natural upsert (§H-IDEMPOTENT).
CREATE TABLE IF NOT EXISTS ebill_config (
  workspace_id TEXT PRIMARY KEY REFERENCES workspace(id),
  biller_pid   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  updated_by   TEXT
);

-- One delivery record per (invoice, active attempt). status is the LOCAL machine
-- (prepared|submitting|transmitted|failed, ebillEnums.ts); partner_status is the SWP enum mirrored
-- verbatim as a DENORMALIZED latest (the auditable trail lives in ebill_delivery_events). The
-- conformance facts (pdfa_profile, ebill_addressed, payload_byte_length) are RECORDED at prepare and
-- ENFORCED at transmit: prepareEbill never claims conformance it did not verify, and transmitEbill
-- refuses payload_not_conformant before any payload reaches a connector (spec §4, the reconciled OI1
-- boundary). correlation_id is minted at first transmit and reused verbatim on every retry (the SWP
-- X-CORRELATION-ID tracing id; the contract documents no partner-side dedupe, so transmission is
-- at-least-once, §4).
CREATE TABLE IF NOT EXISTS ebill_deliveries (
  id                   TEXT PRIMARY KEY,
  workspace_id         TEXT NOT NULL REFERENCES workspace(id),
  document_id          TEXT NOT NULL REFERENCES document(id),
  -- Nullable ONLY across the prepare transaction: the row is inserted first so the OP3 entity exists
  -- for the E00 link (entityExists), then the uploaded artifact id is written back in the SAME tx, so
  -- a committed prepared row always carries one. A read outside prepare never sees a null here.
  artifact_document_id TEXT,
  format               TEXT NOT NULL DEFAULT 'qrbill',
  bc_function          TEXT NOT NULL DEFAULT 'bill',
  status               TEXT NOT NULL,
  pdfa_profile         TEXT,
  ebill_addressed      INTEGER NOT NULL DEFAULT 0,
  payload_byte_length  INTEGER NOT NULL DEFAULT 0,
  partner_status       TEXT,
  partner_reason       TEXT,
  business_case_id     TEXT,
  correlation_id       TEXT,
  transmitted_at       TEXT,
  idempotency_key      TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);

-- AT MOST ONE non-failed delivery per invoice (spec §2/§4): a retrying agent that lost its key store
-- still cannot mint a duplicate. A failed delivery is terminal, and only after one may a fresh prepare
-- mint a successor, so the index counts only non-failed rows.
CREATE UNIQUE INDEX IF NOT EXISTS ebill_active_delivery
ON ebill_deliveries (workspace_id, document_id)
WHERE status != 'failed';

CREATE INDEX IF NOT EXISTS ebill_deliveries_by_document
ON ebill_deliveries (workspace_id, document_id);

-- APPEND-ONLY, one row per mirrored SWP status event (spec §4). unique(delivery_id, event_id) so a
-- re-polled event never duplicates. This is where the mirrored approvedAmount has its defined columns
-- (display only, never reconciled against the ledger: settlement truth stays A14/A20/A21). Nothing
-- collapses history into the delivery row's denormalized latest pair.
CREATE TABLE IF NOT EXISTS ebill_delivery_events (
  id                       TEXT PRIMARY KEY,
  workspace_id             TEXT NOT NULL REFERENCES workspace(id),
  delivery_id              TEXT NOT NULL REFERENCES ebill_deliveries(id),
  event_id                 TEXT NOT NULL,
  partner_status           TEXT NOT NULL,
  partner_reason           TEXT,
  approved_amount_minor    INTEGER,
  approved_amount_currency TEXT,
  occurred_at              TEXT NOT NULL,
  recorded_at              TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS ebill_delivery_event_unique
ON ebill_delivery_events (delivery_id, event_id);
`;
