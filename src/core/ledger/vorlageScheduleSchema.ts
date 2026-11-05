/**
 * N04 (D183), Dauerbuchungen: a Vorlage that runs on a schedule. Two tables, kept beside the code that
 * writes them (`./vorlageSchedule.ts`) and concatenated onto `SCHEMA_SQL` at the store.
 *
 * `vorlage_schedule` is one schedule on a Vorlage SERIES (`series_id`: the Vorlage's FIRST version, the
 * root of its `replaces_id` chain), so it follows the Vorlage through every edit and reads the live version
 * when it runs. At most one ACTIVE schedule per series (partial unique index): setting a new one ends the old
 * one in the same transaction. A row is never deleted and never edited except its one way out (`active` to
 * `ended`, once). `post_version_id` is the Vorlage version a PERSON confirmed for direct posting: a newer
 * live version runs as `propose` until a person sets the schedule again.
 *
 * `vorlage_schedule_run` is ONE row per (workspace, series, period) across every schedule ever set on the
 * series (UNIQUE), written in the same transaction as the posting or the Vorschlag it records, so a period
 * is booked at most once whatever the schedules did. Its only update re-points a `proposed` run at the
 * Vorschlag that replaced a stale one (`action_id`, `version_id`, `reason`); series, period, due date,
 * schedule and outcome never change (trigger).
 *
 * Both carry `workspace_id` (§H-TENANT) and are plain `CREATE ... IF NOT EXISTS` (a shape change only).
 */
export const VORLAGE_SCHEDULE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS vorlage_schedule (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspace(id),
  series_id       TEXT NOT NULL REFERENCES bank_standard(id),
  every           TEXT NOT NULL CHECK (every IN ('month', 'quarter', 'year')),
  anchor_day      INTEGER NOT NULL CHECK (anchor_day BETWEEN 1 AND 31),
  start_date      TEXT NOT NULL,
  end_date        TEXT,
  mode            TEXT NOT NULL CHECK (mode IN ('propose', 'post')),
  asks_json       TEXT NOT NULL,
  post_version_id TEXT REFERENCES bank_standard(id),
  set_by          TEXT NOT NULL,
  set_at          TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended')),
  ended_at        TEXT,
  ended_by        TEXT,
  end_reason      TEXT,
  CHECK (mode = 'propose' OR post_version_id IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS vorlage_schedule_one_live
  ON vorlage_schedule (workspace_id, series_id) WHERE status = 'active';

CREATE TRIGGER IF NOT EXISTS vorlage_schedule_no_delete
  BEFORE DELETE ON vorlage_schedule
  BEGIN SELECT RAISE(ABORT, 'vorlage_schedule rows are never deleted: end the schedule'); END;
CREATE TRIGGER IF NOT EXISTS vorlage_schedule_frozen
  BEFORE UPDATE ON vorlage_schedule
  WHEN NEW.id IS NOT OLD.id OR NEW.workspace_id IS NOT OLD.workspace_id OR NEW.series_id IS NOT OLD.series_id
    OR NEW.every IS NOT OLD.every OR NEW.anchor_day IS NOT OLD.anchor_day OR NEW.start_date IS NOT OLD.start_date
    OR NEW.end_date IS NOT OLD.end_date OR NEW.mode IS NOT OLD.mode OR NEW.asks_json IS NOT OLD.asks_json
    OR NEW.post_version_id IS NOT OLD.post_version_id OR NEW.set_by IS NOT OLD.set_by OR NEW.set_at IS NOT OLD.set_at
    OR OLD.status <> 'active' OR NEW.status <> 'ended'
  BEGIN SELECT RAISE(ABORT, 'vorlage_schedule: only ending an active schedule is allowed'); END;

CREATE TABLE IF NOT EXISTS vorlage_schedule_run (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  series_id    TEXT NOT NULL REFERENCES bank_standard(id),
  period       TEXT NOT NULL,
  due_date     TEXT NOT NULL,
  schedule_id  TEXT NOT NULL REFERENCES vorlage_schedule(id),
  outcome      TEXT NOT NULL CHECK (outcome IN ('posted', 'proposed', 'skipped')),
  entry_id     TEXT REFERENCES journal_entry(id),
  action_id    TEXT REFERENCES agent_action(id),
  version_id   TEXT REFERENCES bank_standard(id),
  reason       TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  UNIQUE (workspace_id, series_id, period),
  CHECK ((outcome = 'posted' AND entry_id IS NOT NULL) OR (outcome = 'proposed' AND action_id IS NOT NULL) OR (outcome = 'skipped' AND reason IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS vorlage_schedule_run_by_action
  ON vorlage_schedule_run (workspace_id, action_id) WHERE action_id IS NOT NULL;

CREATE TRIGGER IF NOT EXISTS vorlage_schedule_run_no_delete
  BEFORE DELETE ON vorlage_schedule_run
  BEGIN SELECT RAISE(ABORT, 'vorlage_schedule_run rows are never deleted'); END;
CREATE TRIGGER IF NOT EXISTS vorlage_schedule_run_frozen
  BEFORE UPDATE ON vorlage_schedule_run
  WHEN NEW.id IS NOT OLD.id OR NEW.workspace_id IS NOT OLD.workspace_id OR NEW.series_id IS NOT OLD.series_id
    OR NEW.period IS NOT OLD.period OR NEW.due_date IS NOT OLD.due_date OR NEW.schedule_id IS NOT OLD.schedule_id
    OR NEW.outcome IS NOT OLD.outcome OR OLD.outcome <> 'proposed' OR NEW.entry_id IS NOT OLD.entry_id
    OR NEW.created_at IS NOT OLD.created_at
  BEGIN SELECT RAISE(ABORT, 'vorlage_schedule_run: only a proposed run may be re-pointed at its re-proposal'); END;
`;
