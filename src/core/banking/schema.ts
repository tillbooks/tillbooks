/**
 * A19's table (data model §D0).
 *
 * Kept in A19's own module and concatenated onto `SCHEMA_SQL` at the store, the pattern A14
 * established for `core/payments/schema.ts`: the DDL a capability writes sits beside the code that
 * writes it, and concurrent capability branches do not all edit one long string.
 *
 * ONE COLUMN IS NOT IN THE SPEC'S §4 LIST, and it is load-bearing: `opening_entry_id`.
 *
 * §4 names `opening_balance_minor` and `opening_balance_date` only. Storing the amount without the
 * ENTRY it posted would make the row the second source of truth for money the ledger already holds,
 * which is the exact shape §H-LEDGER exists to forbid: the two could disagree and nothing would
 * say which was right. With the entry id stored, the amount columns are a cached read of a posted
 * journal entry that can always be re-derived, "has this account an opening balance yet?" is a
 * fact about the LEDGER rather than about a flag, and `account_in_use` has something real to test
 * before A20's `bank_txn` table exists.
 *
 * IBAN uniqueness is scoped to the workspace, never global (§H-TENANT). Two tenants registering the
 * same IBAN is not a collision: it is two businesses, and a global unique index would leak the
 * existence of one tenant's account to another.
 */

export const BANKING_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS bank_account (
  id                    TEXT PRIMARY KEY,
  workspace_id          TEXT NOT NULL REFERENCES workspace(id),
  name                  TEXT NOT NULL,
  iban                  TEXT NOT NULL,
  is_qr_iban            INTEGER NOT NULL DEFAULT 0,
  currency              TEXT NOT NULL DEFAULT 'CHF',
  ledger_account_id     TEXT NOT NULL REFERENCES account(id),
  opening_balance_minor INTEGER,
  opening_balance_date  TEXT,
  opening_entry_id      TEXT REFERENCES journal_entry(id),
  archived              INTEGER NOT NULL DEFAULT 0,
  created_at            TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS bank_account_iban_per_workspace
  ON bank_account (workspace_id, iban);

CREATE INDEX IF NOT EXISTS bank_account_by_workspace
  ON bank_account (workspace_id, archived, name);
`;
