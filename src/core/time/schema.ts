/**
 * B01's two tables, kept in B01's own module and concatenated onto `SCHEMA_SQL` at the store, the
 * pattern A14/A19/A24/G00/C00/E00/B00 established: a capability's DDL sits beside the code that
 * writes it, so concurrent capability branches never all edit one long string in `store/schema.ts`.
 *
 * NO CHECK CONSTRAINT on `status` or `scope`, matching the §D0 convention: both enums live at the
 * single §H-ENUM source (`enums.ts`), validated at the verb boundary, so the transition table and
 * the precedence order stay in exactly one place each.
 *
 * `rate_minor` ON THE ENTRY IS A SNAPSHOT (OP1): frozen at capture from the card `resolveRate`
 * picked, together with the card's currency, scope and id, so a later card edit can never reprice
 * captured time and an auditor can see WHICH rate priced an entry. The entry's value in Rappen is
 * NOT stored (P2 round-once): B02 computes it at billing, and `timeList` derives its aggregate at
 * read time.
 *
 * `minutes` is NULL exactly while a timer runs (`time_start` without `time_stop`); a manual
 * `time_log` entry always carries it. The ArG record columns (`user_id`, `project_id`,
 * `started_at`, `ended_at`, `minutes`) are fixed base columns, never custom fields (spec §6b).
 */

export const TIME_SCHEMA_SQL = `
-- B01: the working-time record and billing source. status is open|submitted|approved|locked|billed
-- (validated in enums.ts, never a CHECK; billed is written by B02, not by any B01 verb).
CREATE TABLE IF NOT EXISTS time_entry (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspace(id),
  user_id       TEXT NOT NULL,
  project_id    TEXT NOT NULL REFERENCES project(id),
  phase_id      TEXT REFERENCES project_phase(id),
  started_at    TEXT NOT NULL,
  ended_at      TEXT,
  minutes       INTEGER,
  billable      INTEGER NOT NULL DEFAULT 1,
  notes         TEXT,
  status        TEXT NOT NULL DEFAULT 'open',
  -- B02 (reserved additive column): the A11 invoice line this entry was billed onto, NULL until
  -- B02 flips status to 'billed'. The pair (status='billed', invoice_line_id NOT NULL) is B02's
  -- no-double-billing lock; the store also lists it in ADDITIVE_COLUMNS for pre-B02 databases.
  invoice_line_id TEXT,
  rate_minor    INTEGER NOT NULL,
  rate_currency TEXT NOT NULL,
  rate_scope    TEXT NOT NULL,
  rate_card_id  TEXT NOT NULL REFERENCES rate_card(id),
  -- B03 (the cost basis, OP1): the COST-rate snapshot from the same winning card, frozen at capture
  -- exactly like rate_minor. NULL when the card carried no cost rate, which is what B03's
  -- basisDegraded reports honestly instead of valuing the entry at an invented rate. Same currency
  -- as rate_currency (one card, one currency). Also in ADDITIVE_COLUMNS for pre-existing files.
  cost_rate_minor INTEGER,
  submitted_at  TEXT,
  approved_at   TEXT,
  approved_by   TEXT,
  locked_at     TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

-- The timesheet read model (time_list, P5) and the period writes (submit/lock) filter by project,
-- user and status and cut by started_at.
CREATE INDEX IF NOT EXISTS time_entry_queue
ON time_entry (workspace_id, status, started_at);

CREATE INDEX IF NOT EXISTS time_entry_by_project
ON time_entry (workspace_id, project_id, started_at);

-- The single-running-timer guard (US-B01.1) scans one user's open, still-running rows.
CREATE INDEX IF NOT EXISTS time_entry_running
ON time_entry (workspace_id, user_id)
WHERE ended_at IS NULL;

-- B01: rate cards, versioned by validity. scope is client|project|employee|default (enums.ts);
-- scope_ref names the contact/project/user for a scoped card and is NULL exactly for default.
-- valid_to is NULL while a card is the open (current) version; rate_card_upsert closes the
-- predecessor by writing valid_to, never by mutating rate_minor (OP1).
CREATE TABLE IF NOT EXISTS rate_card (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspace(id),
  scope         TEXT NOT NULL,
  scope_ref     TEXT,
  rate_minor    INTEGER NOT NULL,
  -- B03 (spec §4): the internal cost rate the 'cost' basis values time at, in the card's own
  -- currency. NULLABLE: a card without one degrades the cost basis loudly (basisDegraded), never
  -- silently. Versioned exactly like rate_minor: immutable on an existing row, a new version
  -- carries the new value. Also in ADDITIVE_COLUMNS for pre-existing files.
  cost_rate_minor INTEGER,
  currency      TEXT NOT NULL,
  valid_from    TEXT NOT NULL,
  valid_to      TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

-- resolveRate (OP1) looks up by (scope, scope_ref) and validity date.
CREATE INDEX IF NOT EXISTS rate_card_lookup
ON rate_card (workspace_id, scope, scope_ref, valid_from);
`;
