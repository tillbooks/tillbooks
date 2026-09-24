/**
 * A15's three tables, kept in A15's own module (the pattern A14/A17/E00 established: a capability's
 * DDL sits beside the code that writes it and is concatenated onto `SCHEMA_SQL` at the store, so
 * concurrent capability branches never all edit one long string in `store/schema.ts`).
 *
 * WHAT IS STORED AND WHAT IS DERIVED, because dunning sits on top of three other capabilities'
 * truth and must not copy any of it:
 *
 *  - **Overdue-ness is never stored.** A run's items are a FROZEN SNAPSHOT of what A16's open-item
 *    derivation said on `run_date`, kept so the letter a person issued remains the letter that was
 *    issued (a reminder is evidence of what was demanded, §H-AUDIT-adjacent). Whether an invoice is
 *    STILL open is always A16's live answer, which is why `propose` reads A16 fresh every time and
 *    a paid invoice simply never appears again.
 *  - **The fee's money effect lives in the LEDGER**, as one posted `journal_entry`
 *    (`source='dunning'`) whose id is `fee_entry_id`. The `fee_minor` per item is the letter's
 *    figure and A16's per-document attribution key; the Rappen that move are the entry's, and a
 *    mistaken run's fee is corrected by `reverse_entry`, never by editing a row here.
 *  - **The Verzugszins note is display-only** (`interest_minor`, frozen at issue): Art. 104 OR
 *    default interest is computed for the debtor's information and never posted. The "never booked"
 *    rule is §6b-fixed; there is deliberately no column that could carry an interest entry id.
 *  - **The letter's DEMAND freezes at issue (D73, owner-decided 31.07.2026).** `principal_minor`
 *    (the invoice's own open amount, net of earlier fees) and `demanded_fee_minor` (the fee the
 *    letter actually asks for: the fee IF it booked at issue, 0 when a period lock deferred it)
 *    are the issue-time snapshot `renderDunningPdf` renders every FIGURE from, always.
 *    `fee_booked` remains the LEDGER's attribution flag and may flip later (the C8 recovery); the
 *    demand columns never move, so a reprint states exactly the amounts the debtor's letter
 *    states (the party blocks render current master data, critic S4), and a fee recovered after
 *    sending joins the NEXT escalation letter (through A16's open item) rather than rewriting a
 *    mailed one. On a row ISSUED before these columns existed both read the ALTER default 0:
 *    `demanded_fee_minor = 0` honestly under-demands, `principal_minor = 0` means NOT SNAPSHOTTED
 *    and the renderer falls back to `overdue_minor` (critic S2).
 *
 * `dunning_config` is one row per level (1..3), replaced in place like `aging_bucket_config`: a
 * dunning policy is current, not historical. The levels an item has actually been through ARE
 * historical and live in `dunning_item` rows of issued runs. `min_interval_days` (K-60) is the
 * per-level SPACING gate the absolute `days_overdue` threshold alone never gave: without it an
 * invoice already past all three thresholds escalated 1->2->3 in three daily runs. It is
 * constant-defaulted 10 so a pre-K-60 file widens on open with the safe cadence, never 0.
 *
 * `send_error` and `sent_at` on the item carry the per-debtor outbound outcome (P9: a run whose
 * relay failed for one debtor stays `issued`, and a retry sends only what has not gone out).
 */

export const DUNNING_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS dunning_config (
  workspace_id           TEXT NOT NULL REFERENCES workspace(id),
  level                  INTEGER NOT NULL CHECK (level IN (1, 2, 3)),
  days_overdue           INTEGER NOT NULL,
  min_interval_days      INTEGER NOT NULL DEFAULT 10,
  fee_minor              INTEGER NOT NULL DEFAULT 0,
  book_fee               INTEGER NOT NULL DEFAULT 0,
  fee_income_account_id  TEXT,
  tax_code               TEXT,
  show_interest          INTEGER NOT NULL DEFAULT 0,
  interest_bp            INTEGER NOT NULL DEFAULT 500,
  template_key           TEXT NOT NULL DEFAULT 'standard',
  updated_at             TEXT NOT NULL,
  PRIMARY KEY (workspace_id, level)
);

CREATE TABLE IF NOT EXISTS dunning_run (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspace(id),
  run_date            TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'issued', 'sent')),
  fee_entry_id        TEXT,
  fee_skipped_reason  TEXT,
  created_by          TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  issued_at           TEXT,
  sent_at             TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS dunning_run_per_day
  ON dunning_run (workspace_id, run_date);

CREATE TABLE IF NOT EXISTS dunning_item (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspace(id),
  run_id          TEXT NOT NULL REFERENCES dunning_run(id),
  document_id     TEXT NOT NULL,
  debtor_id       TEXT NOT NULL,
  level           INTEGER NOT NULL CHECK (level IN (1, 2, 3)),
  currency        TEXT NOT NULL,
  overdue_minor   INTEGER NOT NULL,
  fee_minor       INTEGER NOT NULL DEFAULT 0,
  fee_booked      INTEGER NOT NULL DEFAULT 0,
  principal_minor INTEGER NOT NULL DEFAULT 0,
  demanded_fee_minor INTEGER NOT NULL DEFAULT 0,
  days_overdue    INTEGER NOT NULL,
  due_date        TEXT,
  number          TEXT,
  interest_minor  INTEGER,
  sent_at         TEXT,
  send_error      TEXT
);

CREATE INDEX IF NOT EXISTS dunning_item_run ON dunning_item (workspace_id, run_id);
CREATE INDEX IF NOT EXISTS dunning_item_document ON dunning_item (workspace_id, document_id);
`;
