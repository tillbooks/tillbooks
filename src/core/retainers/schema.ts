/**
 * B04's two tables, kept in B04's own module and concatenated onto `SCHEMA_SQL` at the store, the
 * pattern A14/A19/A24/G00/C00/E00/B00/B01 established: a capability's DDL sits beside the code that
 * writes it, so concurrent capability branches never all edit one long string in `store/schema.ts`.
 *
 * NO CHECK CONSTRAINT on `period`, `status` or `kind`, matching the §D0 convention: all three enums
 * live at the single §H-ENUM source (`enums.ts`), validated at the verb boundary.
 *
 * `retainer_draws` IS APPEND-ONLY (§H-AUDIT spirit): a correction is a compensating row, never an
 * UPDATE, and there is no `ON DELETE CASCADE` anywhere. The partial UNIQUE index
 * `retainer_draw_fee_once` is the §H-IDEMPOTENT correctness floor for US-B04.2: at most ONE `fee`
 * draw per (retainer, period), so a period can be invoiced exactly once. Amounts are integer Rappen;
 * `minutes` is the rollover conservation currency (US-B04.5), tracked in minutes so no rounding
 * compounds across periods. B04 POSTS NOTHING: `invoice_id`/`invoice_line_id` reference the A11 draft
 * A11 -> A02 own, read here for status display only (P3).
 */

export const RETAINER_SCHEMA_SQL = `
-- B04: the mandate agreement. status is draft|active|ended (validated in enums.ts, never a CHECK);
-- create mints 'active' directly, close moves it to 'ended'. period is monthly|quarterly. fee_rappen
-- is the stored Pauschale (never derived). included_hours/cap_rappen are the coverage/value ceilings;
-- rollover decides whether unused coverage carries into the next period. B04 owns no posting.
CREATE TABLE IF NOT EXISTS retainer (
  id             TEXT PRIMARY KEY,
  workspace_id   TEXT NOT NULL REFERENCES workspace(id),
  contact_id     TEXT NOT NULL REFERENCES contact(id),
  project_id     TEXT REFERENCES project(id),
  period         TEXT NOT NULL,
  fee_rappen     INTEGER NOT NULL,
  included_hours INTEGER NOT NULL DEFAULT 0,
  cap_rappen     INTEGER,
  rollover       INTEGER NOT NULL DEFAULT 0,
  currency       TEXT NOT NULL DEFAULT 'CHF',
  starts_on      TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'active',
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

-- retainer_list and run_due scan by workspace, status and contact.
CREATE INDEX IF NOT EXISTS retainer_by_status
ON retainer (workspace_id, status, contact_id);

-- B04: the append-only drawdown ledger. kind is fee|time|carryover_in|carryover_out (enums.ts).
-- A 'fee' row records the period's Pauschale invoice; a 'time' row records a covered or overage
-- portion of a B01 entry (invoice_line_id NULL when covered by the fee, set when it is an overage
-- line); carryover_out closes a period's unused minutes and the matching carryover_in opens the next.
-- amount_rappen is integer Rappen; the FX trio (currency/amount_base_rappen/fx_rate) is set only on a
-- foreign-currency draw (§H-FX). A correction is a compensating row, never an UPDATE.
CREATE TABLE IF NOT EXISTS retainer_draws (
  id                TEXT PRIMARY KEY,
  workspace_id      TEXT NOT NULL REFERENCES workspace(id),
  retainer_id       TEXT NOT NULL REFERENCES retainer(id),
  period_key        TEXT NOT NULL,
  kind              TEXT NOT NULL,
  time_entry_id     TEXT REFERENCES time_entry(id),
  minutes           INTEGER NOT NULL DEFAULT 0,
  amount_rappen     INTEGER NOT NULL DEFAULT 0,
  currency          TEXT,
  amount_base_rappen INTEGER,
  fx_rate           TEXT,
  invoice_id        TEXT,
  invoice_line_id   TEXT,
  created_at        TEXT NOT NULL
);

-- The burn-down read model and the carryover lookup filter by (retainer, period, kind).
CREATE INDEX IF NOT EXISTS retainer_draws_by_period
ON retainer_draws (workspace_id, retainer_id, period_key, kind);

-- US-B04.2 correctness floor: at most ONE fee draw per (retainer, period). This is the structural
-- half of no-double-invoice; the engine pre-checks it before any write and returns the existing
-- invoice, so the index is the last line of defence rather than the first.
CREATE UNIQUE INDEX IF NOT EXISTS retainer_draw_fee_once
ON retainer_draws (retainer_id, period_key)
WHERE kind = 'fee';
`;
