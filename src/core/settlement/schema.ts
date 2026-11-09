/**
 * The settlement socket's tables (D185): the owner's booking TEMPLATE per settlement source, its
 * append-only change history, and the append-only record of every event a settlement import booked.
 *
 * `settlement_template` holds ONE live row per (workspace, source system, source processor): the clearing
 * account and, per event kind, what the import does with it (`template_json`, the shape `template.ts`
 * reads). It is booking configuration that names accounts and tax codes, the `bank_csv_mapping` precedent
 * (D178 point 4: one structured row per thing it configures), not a D172 registry entry: the registry holds
 * scalar behaviour choices, and a template is a map of kinds to accounts. A later save replaces the row;
 * `settlement_template_change` keeps old and new, the actor and when (the `workspace_setting_change` shape,
 * because the A03 audit chain row carries no payload). Immutable by trigger.
 *
 * `settlement_event` is the idempotency on the EXTERNAL id: one row per booked event, unique per
 * (workspace, system, processor, event id), with the money the entry was booked from, so a re-import of
 * the same event is `already_imported` and the same id with different money is `event_amended`, never a
 * second entry and never an edit. Append-only by trigger, like the entries it points at.
 *
 * Every table carries `workspace_id` (§H-TENANT). Plain `CREATE ... IF NOT EXISTS`: new tables change the
 * book's shape and leave its generation where it was (`store/schemaShape.ts`).
 */
export const SETTLEMENT_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS settlement_template (
  id               TEXT PRIMARY KEY,
  workspace_id     TEXT NOT NULL REFERENCES workspace(id),
  source_system    TEXT NOT NULL,
  source_processor TEXT NOT NULL,
  template_json    TEXT NOT NULL,
  updated_by       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS settlement_template_one_per_source
  ON settlement_template (workspace_id, source_system, source_processor);

CREATE TABLE IF NOT EXISTS settlement_template_change (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspace(id),
  template_id   TEXT NOT NULL REFERENCES settlement_template(id),
  old_json      TEXT,
  new_json      TEXT NOT NULL,
  actor         TEXT NOT NULL,
  at            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS settlement_template_change_by_template
  ON settlement_template_change (workspace_id, template_id, at);
CREATE TRIGGER IF NOT EXISTS settlement_template_change_no_update
  BEFORE UPDATE ON settlement_template_change
  BEGIN SELECT RAISE(ABORT, 'settlement_template_change is append-only'); END;
CREATE TRIGGER IF NOT EXISTS settlement_template_change_no_delete
  BEFORE DELETE ON settlement_template_change
  BEGIN SELECT RAISE(ABORT, 'settlement_template_change is append-only'); END;

CREATE TABLE IF NOT EXISTS settlement_event (
  id               TEXT PRIMARY KEY,
  workspace_id     TEXT NOT NULL REFERENCES workspace(id),
  source_system    TEXT NOT NULL,
  source_processor TEXT NOT NULL,
  event_id         TEXT NOT NULL,
  kind             TEXT NOT NULL,
  day              TEXT NOT NULL,
  currency         TEXT NOT NULL,
  amount_minor     INTEGER NOT NULL,
  net_minor        INTEGER NOT NULL,
  vat_minor        INTEGER,
  entry_id         TEXT NOT NULL REFERENCES journal_entry(id),
  document_number  TEXT,
  counterparty     TEXT,
  refs_json        TEXT,
  created_by       TEXT NOT NULL,
  created_at       TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS settlement_event_one_per_external_id
  ON settlement_event (workspace_id, source_system, source_processor, event_id);
CREATE INDEX IF NOT EXISTS settlement_event_by_entry
  ON settlement_event (workspace_id, entry_id);
CREATE TRIGGER IF NOT EXISTS settlement_event_no_update
  BEFORE UPDATE ON settlement_event
  BEGIN SELECT RAISE(ABORT, 'settlement_event is append-only'); END;
CREATE TRIGGER IF NOT EXISTS settlement_event_no_delete
  BEFORE DELETE ON settlement_event
  BEGIN SELECT RAISE(ABORT, 'settlement_event is append-only'); END;
`;
