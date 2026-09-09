/**
 * A18's three tables, kept in A18's own module (the pattern A14/A17/A19/A21 established: a
 * capability's DDL sits beside the code that writes it and is concatenated onto `SCHEMA_SQL` at the
 * store, so concurrent capability branches never all edit one long string in `store/schema.ts`).
 *
 * `creditor_bank_profile` EXISTS BECAUSE OF A RECONCILIATION FINDING, not because the spec asked for
 * it by name. A18's spec assumed "each creditor's IBAN/QR-IBAN + QRR reference (captured on the
 * vendor bill in A17)". A17's `vendor_bill` table carries neither an IBAN nor a QR-IBAN column (see
 * `core/purchase/schema.ts`), and neither does `contact`. A pain.001 file cannot be generated without
 * a creditor IBAN, so A18 stores the one fact A17 was assumed to hold: one row per vendor, upserted
 * through `set_creditor_bank_profile`, which is the D65 leg-(f) verb the automation denylist's own
 * note anticipated ("no vendor payment-target verb exists yet... when one ships, this leg is what
 * catches it in review").
 *
 * `payment_batch_item` SNAPSHOTS the creditor's IBAN and reference AT BATCH-CREATION TIME rather
 * than joining `creditor_bank_profile` live at generation time. This is what makes "regenerating a
 * `generated` batch reproduces byte-identical output" (spec §4) true even if the operator corrects a
 * vendor's IBAN in between: the batch is a snapshot of what was true when it was drafted, exactly as
 * A17's own bill freezes its figures at posting.
 */

export const PAIN001_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS creditor_bank_profile (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspace(id),
  contact_id          TEXT NOT NULL REFERENCES contact(id),
  iban                TEXT NOT NULL,
  is_qr_iban          INTEGER NOT NULL,
  updated_by          TEXT,
  updated_at          TEXT NOT NULL
);

-- One profile per (workspace, vendor). \`set_creditor_bank_profile\` upserts on this key.
CREATE UNIQUE INDEX IF NOT EXISTS creditor_bank_profile_by_vendor
ON creditor_bank_profile (workspace_id, contact_id);

CREATE TABLE IF NOT EXISTS payment_batch (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspace(id),
  bank_account_id     TEXT NOT NULL REFERENCES bank_account(id),
  execution_date      TEXT NOT NULL,
  status              TEXT NOT NULL,
  ctrl_sum_minor      INTEGER,
  nb_of_txs           INTEGER,
  msg_id              TEXT,
  -- The pain.001 GrpHdr/CreDtTm, stamped ONCE at batch creation (F6). Taking it from the wall clock
  -- at generation time made "regenerating a generated batch is byte-identical" false under a moving
  -- clock while MsgId (the bank's 90-day dedup key) stayed fixed: two textually different files
  -- sharing one MsgId. Freezing it here makes the byte-identity claim true.
  cre_dt_tm           TEXT NOT NULL,
  idempotency_key     TEXT NOT NULL,
  created_by          TEXT,
  created_at          TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS payment_batch_by_workspace ON payment_batch (workspace_id, created_at);

-- §H-IDEMPOTENT at the DB layer, the A17/A14 pattern: one batch per (workspace, key).
CREATE UNIQUE INDEX IF NOT EXISTS payment_batch_idempotency
ON payment_batch (workspace_id, idempotency_key);

-- The lifecycle is one-way. The forward path is draft -> generated -> paid; draft and generated may
-- also move to the terminal 'discarded' state (F4: discard_payment_batch). What is forbidden:
-- reopening a paid batch, returning a generated batch to draft (the XML it produced would then
-- describe a batch that no longer exists in that shape), discarding a PAID batch (the money moved),
-- and moving OUT of 'discarded' (it is terminal, like paid).
CREATE TRIGGER IF NOT EXISTS payment_batch_status_is_one_way
BEFORE UPDATE OF status ON payment_batch
WHEN (OLD.status = 'paid' AND NEW.status <> 'paid')
  OR (OLD.status = 'discarded' AND NEW.status <> 'discarded')
  OR (OLD.status = 'generated' AND NEW.status = 'draft')
BEGIN
  SELECT RAISE(ABORT, 'payment_batch_status_is_one_way');
END;

-- No code path DELETES a batch (append-only, §H-AUDIT). Abandoning a draft or generated batch is a
-- forward move to the terminal 'discarded' status (discard_payment_batch), never a row removal,
-- mirroring A17's "no delete on anything that could already be true" posture.
CREATE TRIGGER IF NOT EXISTS payment_batch_no_delete
BEFORE DELETE ON payment_batch
BEGIN
  SELECT RAISE(ABORT, 'payment_batch_immutable');
END;

CREATE TABLE IF NOT EXISTS payment_batch_item (
  id                  TEXT PRIMARY KEY,
  batch_id            TEXT NOT NULL REFERENCES payment_batch(id),
  workspace_id        TEXT NOT NULL REFERENCES workspace(id),
  vendor_bill_id       TEXT NOT NULL REFERENCES vendor_bill(id),
  vendor_id           TEXT NOT NULL REFERENCES contact(id),
  amount_minor        INTEGER NOT NULL,
  currency            TEXT NOT NULL,
  -- Snapshotted from creditor_bank_profile at batch-creation time (see module note).
  creditor_iban       TEXT NOT NULL,
  is_qr_iban          INTEGER NOT NULL,
  -- 'qrr' | 'scor' | 'none'. 'none' means the CdtTrfTxInf carries unstructured remittance instead.
  reference_kind      TEXT NOT NULL,
  reference_value     TEXT,
  posted_payment_id   TEXT REFERENCES payment(id),
  created_at          TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS payment_batch_item_by_batch ON payment_batch_item (workspace_id, batch_id);
CREATE INDEX IF NOT EXISTS payment_batch_item_by_bill ON payment_batch_item (workspace_id, vendor_bill_id);

-- F1 floor: a bill may appear at most ONCE in a batch. The engine refuses a duplicated selection in
-- createPaymentBatch input validation; this UNIQUE index is the constraint that catches the same
-- class of defect if a later refactor ever loses that guard, so a batch can never carry two
-- instructions for one vendor bill (which the bank would execute as two transfers).
CREATE UNIQUE INDEX IF NOT EXISTS payment_batch_item_unique_bill
ON payment_batch_item (workspace_id, batch_id, vendor_bill_id);

-- Once a batch has a posted payment against an item, that item's money-adjacent columns are frozen
-- (§H-AUDIT): the same discipline A17's own trigger applies to a posted bill.
CREATE TRIGGER IF NOT EXISTS payment_batch_item_no_accounting_update
BEFORE UPDATE ON payment_batch_item
WHEN OLD.posted_payment_id IS NOT NULL
 AND (OLD.amount_minor       <> NEW.amount_minor
   OR OLD.currency           <> NEW.currency
   OR OLD.creditor_iban      <> NEW.creditor_iban
   OR OLD.reference_kind     <> NEW.reference_kind
   OR IFNULL(OLD.reference_value, '') <> IFNULL(NEW.reference_value, ''))
BEGIN
  SELECT RAISE(ABORT, 'payment_batch_item_immutable');
END;

CREATE TRIGGER IF NOT EXISTS payment_batch_item_no_delete
BEFORE DELETE ON payment_batch_item
BEGIN
  SELECT RAISE(ABORT, 'payment_batch_item_immutable');
END;
`;
