/**
 * N04 (D183), Autopilot: the tables behind a Buchungsregel that books its own lines.
 *
 * `rule_autobook_grant` is a PERSON's grant on ONE rule version: who granted it, when, the amount ceiling
 * and its currency (fixed at grant time from the human-confirmed clean uses, so automatic bookings never
 * ratchet it), and how it ended (suspended with a reason, or revoked). A grant is never deleted and its
 * identity and money columns never change (triggers below); `suspended_at` and `revoked_at` are each
 * written once. At most one LIVE grant per rule version (partial unique index). A grant whose version was
 * edited or cleared since reads as ended (the superseded rule row says so; nothing is stamped).
 *
 * `autobook_run` is the record of the step: ONE row per (grant, bank line) the step looked at, booked or
 * not booked with its reason. Append-only. A line is autobooked at most once EVER (the partial unique index
 * on the booked rows), so a reopen followed by a re-grant never books it again, whatever key a new grant
 * would derive. `day` is the Swiss calendar day of the run, the digest's day.
 *
 * `autopilot_seen` closes a digest day or a schedule note in Pendenzen ("Gesehen"): one row per thing, for
 * everyone in the workspace.
 *
 * Every table carries `workspace_id` (§H-TENANT) and is a plain `CREATE ... IF NOT EXISTS`, so an existing
 * book gains them on open (a shape change; the generation stays). The decision row's `channel` column is
 * additive (`AUTOBOOK_ADDITIVE_COLUMNS`), and its freeze trigger names it, so it runs after the column is
 * added (`AUTOBOOK_ADDITIVE_DDL`, spread into `ADDITIVE_INDEXES`).
 */
export const AUTOBOOK_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS rule_autobook_grant (
  id                   TEXT PRIMARY KEY,
  workspace_id         TEXT NOT NULL REFERENCES workspace(id),
  standard_id          TEXT NOT NULL REFERENCES bank_standard(id),
  granted_by           TEXT NOT NULL,
  granted_at           TEXT NOT NULL,
  amount_ceiling_minor INTEGER NOT NULL CHECK (amount_ceiling_minor > 0),
  ceiling_currency     TEXT NOT NULL,
  clean_uses           INTEGER NOT NULL,
  suspended_at         TEXT,
  suspended_reason     TEXT,
  revoked_at           TEXT,
  revoked_by           TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS rule_autobook_grant_one_live
  ON rule_autobook_grant (workspace_id, standard_id) WHERE suspended_at IS NULL AND revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS rule_autobook_grant_by_rule
  ON rule_autobook_grant (workspace_id, standard_id, granted_at);

CREATE TRIGGER IF NOT EXISTS rule_autobook_grant_no_delete
  BEFORE DELETE ON rule_autobook_grant
  BEGIN SELECT RAISE(ABORT, 'rule_autobook_grant rows are never deleted: suspend or revoke the grant'); END;
CREATE TRIGGER IF NOT EXISTS rule_autobook_grant_frozen
  BEFORE UPDATE ON rule_autobook_grant
  WHEN NEW.id IS NOT OLD.id OR NEW.workspace_id IS NOT OLD.workspace_id OR NEW.standard_id IS NOT OLD.standard_id
    OR NEW.granted_by IS NOT OLD.granted_by OR NEW.granted_at IS NOT OLD.granted_at
    OR NEW.amount_ceiling_minor IS NOT OLD.amount_ceiling_minor OR NEW.ceiling_currency IS NOT OLD.ceiling_currency
    OR NEW.clean_uses IS NOT OLD.clean_uses
    OR (OLD.suspended_at IS NOT NULL AND (NEW.suspended_at IS NOT OLD.suspended_at OR NEW.suspended_reason IS NOT OLD.suspended_reason))
    OR (OLD.revoked_at IS NOT NULL AND (NEW.revoked_at IS NOT OLD.revoked_at OR NEW.revoked_by IS NOT OLD.revoked_by))
  BEGIN SELECT RAISE(ABORT, 'rule_autobook_grant: only the suspension and the revocation may be written, each once'); END;

CREATE TABLE IF NOT EXISTS autobook_run (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  run_at       TEXT NOT NULL,
  day          TEXT NOT NULL,
  bank_txn_id  TEXT NOT NULL REFERENCES bank_txn(id),
  grant_id     TEXT NOT NULL REFERENCES rule_autobook_grant(id),
  outcome      TEXT NOT NULL CHECK (outcome IN ('booked', 'not_booked')),
  entry_id     TEXT REFERENCES journal_entry(id),
  reason       TEXT,
  detail       TEXT,
  CHECK ((outcome = 'booked' AND reason IS NULL) OR (outcome = 'not_booked' AND reason IS NOT NULL AND entry_id IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS autobook_run_once_per_grant_line
  ON autobook_run (workspace_id, grant_id, bank_txn_id);
CREATE UNIQUE INDEX IF NOT EXISTS autobook_run_line_booked_once
  ON autobook_run (workspace_id, bank_txn_id) WHERE outcome = 'booked';
CREATE INDEX IF NOT EXISTS autobook_run_by_day
  ON autobook_run (workspace_id, day);

CREATE TRIGGER IF NOT EXISTS autobook_run_no_update
  BEFORE UPDATE ON autobook_run
  BEGIN SELECT RAISE(ABORT, 'autobook_run is append-only'); END;
CREATE TRIGGER IF NOT EXISTS autobook_run_no_delete
  BEFORE DELETE ON autobook_run
  BEGIN SELECT RAISE(ABORT, 'autobook_run is append-only'); END;

CREATE TABLE IF NOT EXISTS autopilot_seen (
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  kind         TEXT NOT NULL CHECK (kind IN ('digest', 'schedule_run')),
  ref          TEXT NOT NULL,
  seen_by      TEXT NOT NULL,
  seen_at      TEXT NOT NULL,
  PRIMARY KEY (workspace_id, kind, ref)
);
`;

/** N04: the decision row's channel (`autobook:<ruleId>`, NULL for every other booking). */
export const AUTOBOOK_ADDITIVE_COLUMNS: readonly { table: string; column: string; ddl: string }[] = [
  { table: 'bank_line_decision', column: 'channel', ddl: 'channel TEXT' },
];

/**
 * N04: the channel is as immutable as the rest of the decision row (the N03 provenance precedent, its own
 * trigger). It names the additive column, so it runs after the column exists.
 */
export const AUTOBOOK_ADDITIVE_DDL: readonly { name: string; ddl: string }[] = [
  {
    name: 'bank_line_decision_channel_frozen',
    ddl: `CREATE TRIGGER IF NOT EXISTS bank_line_decision_channel_frozen
          BEFORE UPDATE ON bank_line_decision
          WHEN NEW.channel IS NOT OLD.channel
          BEGIN SELECT RAISE(ABORT, 'bank_line_decision: only the supersession stamp may be written, and only once'); END`,
  },
];
