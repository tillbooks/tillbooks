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
 * D198, the settlement FEED: `settlement_source` holds ONE live row per (workspace, system, processor) with
 * the producer's base URL, the first day TILL pulls, and `token_ref`, a LOCATOR into the host's secret store
 * (the macOS Keychain), never the token. `settlement_source_change` keeps every save (old and new, actor,
 * when; no token in either). `settlement_pull` is the append-only log of every pull (the range, outcome,
 * counts): the watermark and the last result are read from it, never stored twice. `settlement_feed_event`
 * keeps every event a pull SAW, the kinds the template skips included (`bank_payout`, `reserve`), unique per
 * external id: `settlement_event` records only events with an entry, and the payout link (`payoutLink.ts`)
 * and the pre-filing check (`vatFindings.ts`) need the payouts too. All three history tables are immutable
 * by trigger. `settlement_feed_payout_ref` keeps every `refs.payoutId` an event was seen with, on ANY
 * sighting (critic r1 F5: a producer may add the payout to an event on a later, overlapping pull, and the
 * first-sighting row is immutable), so the exact composition reads every stated link.
 *
 * D198 RE-CUT (12.11.2026, after three critic FAILs and eight paper critics). `pull_id` on the observed record
 * and the payout links is NULL for a file import: `import_settlement` is the ONE writer of both, on both
 * doors (paper critic r8 L5), so a pack's events are observed too. Three more append-only tables:
 *  - `settlement_feed_flag`: one row per (event, transaction key) plus one keyless row per event, each with
 *    the event's `refs.test` of that sighting, read from the RAW event before refs truncation. Unique over
 *    every column (NULLs folded by `ifnull`), so a repeated sighting adds nothing and a later `test: true`
 *    is kept beside an earlier `false`: the test status is sticky (R1).
 *  - `settlement_feed_outcome`: the import's LOG, one row per event of every imported document (pull id, or
 *    NULL for a file), plus one `restated` row (code `event_amended`) per arrival whose figures differ from
 *    the producer's latest stated ones (the owner's answer of 12.11.2026: one comparison on arrival). The
 *    pre-filing check reads the facts of a reader refusal and the `restated` rows, in arrival order.
 *  - `settlement_test_resolution`: a person's test track (S5: `not_test`, `reopen_test`).
 *  - `settlement_event_override`: a person's OVERRIDE of one event (the owner's answer of 12.11.2026,
 *    `handled_outside` / `withdraw_handled`, latest row per event wins): handled outside the import, so the
 *    import books nothing for it and the check does not list it missing. It books nothing and links to no
 *    entry. `amendments_seen` is how many `restated` rows the event had when the row was written, so a
 *    restatement arriving later lists the event `override_check`.
 *  - `settlement_event_inclusion`: A42, the Umsatz review's answer per event (`ignored` | `included`, latest
 *    row per event wins, a reason optional and never asked, D203). `ignored` acts like the
 *    override above (the import skips the event, reason `ignored`, and the check does not list it missing);
 *    `included` only withdraws an ignore: it never lifts the test default (a test payment is included with
 *    `resolve_settlement_event not_test`, which reaches its whole transaction), the from-date or a template skip.
 *    `amendments_seen` as above.
 *
 * A43 §2, the TABLE DOOR: `settlement_table_mapping` holds ONE live row per (workspace, system, processor), the
 * column mapping a CSV or XLSX export of that source is read by (`tableMapping.ts`) and the headers it was made
 * for (a file with other headers refuses `table_mapping_mismatch`). `settlement_table_mapping_change` keeps every
 * save, old and new, actor and time, the `settlement_template_change` shape. Immutable by trigger.
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

CREATE TABLE IF NOT EXISTS settlement_source (
  id               TEXT PRIMARY KEY,
  workspace_id     TEXT NOT NULL REFERENCES workspace(id),
  source_system    TEXT NOT NULL,
  source_processor TEXT NOT NULL,
  base_url         TEXT NOT NULL,
  feed_path        TEXT,
  from_date        TEXT NOT NULL,
  token_ref        TEXT,
  updated_by       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS settlement_source_one_per_source
  ON settlement_source (workspace_id, source_system, source_processor);

CREATE TABLE IF NOT EXISTS settlement_source_change (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspace(id),
  source_id     TEXT NOT NULL REFERENCES settlement_source(id),
  old_json      TEXT,
  new_json      TEXT NOT NULL,
  actor         TEXT NOT NULL,
  at            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS settlement_source_change_by_source
  ON settlement_source_change (workspace_id, source_id, at);
CREATE TRIGGER IF NOT EXISTS settlement_source_change_no_update
  BEFORE UPDATE ON settlement_source_change
  BEGIN SELECT RAISE(ABORT, 'settlement_source_change is append-only'); END;
CREATE TRIGGER IF NOT EXISTS settlement_source_change_no_delete
  BEFORE DELETE ON settlement_source_change
  BEGIN SELECT RAISE(ABORT, 'settlement_source_change is append-only'); END;

CREATE TABLE IF NOT EXISTS settlement_pull (
  id               TEXT PRIMARY KEY,
  workspace_id     TEXT NOT NULL REFERENCES workspace(id),
  source_id        TEXT NOT NULL REFERENCES settlement_source(id),
  range_from       TEXT NOT NULL,
  range_to         TEXT NOT NULL,
  outcome          TEXT NOT NULL,
  error_code       TEXT,
  trigger_kind     TEXT NOT NULL,
  events_seen      INTEGER NOT NULL DEFAULT 0,
  events_new       INTEGER NOT NULL DEFAULT 0,
  amended_seen     INTEGER NOT NULL DEFAULT 0,
  booked           INTEGER NOT NULL DEFAULT 0,
  already_imported INTEGER NOT NULL DEFAULT 0,
  skipped          INTEGER NOT NULL DEFAULT 0,
  refused          INTEGER NOT NULL DEFAULT 0,
  actor            TEXT NOT NULL,
  at               TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS settlement_pull_by_source
  ON settlement_pull (workspace_id, source_id, at);
CREATE TRIGGER IF NOT EXISTS settlement_pull_no_update
  BEFORE UPDATE ON settlement_pull
  BEGIN SELECT RAISE(ABORT, 'settlement_pull is append-only'); END;
CREATE TRIGGER IF NOT EXISTS settlement_pull_no_delete
  BEFORE DELETE ON settlement_pull
  BEGIN SELECT RAISE(ABORT, 'settlement_pull is append-only'); END;

CREATE TABLE IF NOT EXISTS settlement_feed_event (
  id               TEXT PRIMARY KEY,
  workspace_id     TEXT NOT NULL REFERENCES workspace(id),
  source_system    TEXT NOT NULL,
  source_processor TEXT NOT NULL,
  event_id         TEXT NOT NULL,
  kind             TEXT NOT NULL,
  day              TEXT NOT NULL,
  amount_minor     INTEGER NOT NULL,
  net_minor        INTEGER NOT NULL,
  vat_minor        INTEGER,
  payout_ref       TEXT,
  test             INTEGER NOT NULL DEFAULT 0,
  refs_json        TEXT,
  pull_id          TEXT,
  created_at       TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS settlement_feed_event_one_per_external_id
  ON settlement_feed_event (workspace_id, source_system, source_processor, event_id);
CREATE INDEX IF NOT EXISTS settlement_feed_event_by_kind_day
  ON settlement_feed_event (workspace_id, kind, day);
CREATE TRIGGER IF NOT EXISTS settlement_feed_event_no_update
  BEFORE UPDATE ON settlement_feed_event
  BEGIN SELECT RAISE(ABORT, 'settlement_feed_event is append-only'); END;
CREATE TRIGGER IF NOT EXISTS settlement_feed_event_no_delete
  BEFORE DELETE ON settlement_feed_event
  BEGIN SELECT RAISE(ABORT, 'settlement_feed_event is append-only'); END;

CREATE TABLE IF NOT EXISTS settlement_feed_payout_ref (
  id               TEXT PRIMARY KEY,
  workspace_id     TEXT NOT NULL REFERENCES workspace(id),
  source_system    TEXT NOT NULL,
  source_processor TEXT NOT NULL,
  event_id         TEXT NOT NULL,
  payout_ref       TEXT NOT NULL,
  pull_id          TEXT,
  created_at       TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS settlement_feed_payout_ref_once
  ON settlement_feed_payout_ref (workspace_id, source_system, source_processor, event_id, payout_ref);
CREATE INDEX IF NOT EXISTS settlement_feed_payout_ref_by_ref
  ON settlement_feed_payout_ref (workspace_id, source_system, source_processor, payout_ref);
CREATE TRIGGER IF NOT EXISTS settlement_feed_payout_ref_no_update
  BEFORE UPDATE ON settlement_feed_payout_ref
  BEGIN SELECT RAISE(ABORT, 'settlement_feed_payout_ref is append-only'); END;
CREATE TRIGGER IF NOT EXISTS settlement_feed_payout_ref_no_delete
  BEFORE DELETE ON settlement_feed_payout_ref
  BEGIN SELECT RAISE(ABORT, 'settlement_feed_payout_ref is append-only'); END;

CREATE TABLE IF NOT EXISTS settlement_feed_flag (
  id               TEXT PRIMARY KEY,
  workspace_id     TEXT NOT NULL REFERENCES workspace(id),
  source_system    TEXT NOT NULL,
  source_processor TEXT NOT NULL,
  event_id         TEXT NOT NULL,
  key_kind         TEXT,
  key_value        TEXT,
  test             INTEGER NOT NULL,
  created_at       TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS settlement_feed_flag_once
  ON settlement_feed_flag (workspace_id, source_system, source_processor, event_id, ifnull(key_kind, ''), ifnull(key_value, ''), test);
CREATE INDEX IF NOT EXISTS settlement_feed_flag_by_value
  ON settlement_feed_flag (workspace_id, source_system, source_processor, key_value);
CREATE TRIGGER IF NOT EXISTS settlement_feed_flag_no_update
  BEFORE UPDATE ON settlement_feed_flag
  BEGIN SELECT RAISE(ABORT, 'settlement_feed_flag is append-only'); END;
CREATE TRIGGER IF NOT EXISTS settlement_feed_flag_no_delete
  BEFORE DELETE ON settlement_feed_flag
  BEGIN SELECT RAISE(ABORT, 'settlement_feed_flag is append-only'); END;

CREATE TABLE IF NOT EXISTS settlement_feed_outcome (
  id               TEXT PRIMARY KEY,
  workspace_id     TEXT NOT NULL REFERENCES workspace(id),
  source_system    TEXT NOT NULL,
  source_processor TEXT NOT NULL,
  event_id         TEXT,
  pull_id          TEXT,
  outcome          TEXT NOT NULL,
  code             TEXT,
  changed_json     TEXT,
  kind             TEXT,
  day              TEXT,
  amount_minor     INTEGER,
  created_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS settlement_feed_outcome_by_event
  ON settlement_feed_outcome (workspace_id, source_system, source_processor, event_id);
CREATE INDEX IF NOT EXISTS settlement_feed_outcome_by_pull
  ON settlement_feed_outcome (workspace_id, pull_id);
CREATE TRIGGER IF NOT EXISTS settlement_feed_outcome_no_update
  BEFORE UPDATE ON settlement_feed_outcome
  BEGIN SELECT RAISE(ABORT, 'settlement_feed_outcome is append-only'); END;
CREATE TRIGGER IF NOT EXISTS settlement_feed_outcome_no_delete
  BEFORE DELETE ON settlement_feed_outcome
  BEGIN SELECT RAISE(ABORT, 'settlement_feed_outcome is append-only'); END;

CREATE TABLE IF NOT EXISTS settlement_test_resolution (
  id               TEXT PRIMARY KEY,
  workspace_id     TEXT NOT NULL REFERENCES workspace(id),
  source_system    TEXT NOT NULL,
  source_processor TEXT NOT NULL,
  event_id         TEXT NOT NULL,
  resolution       TEXT NOT NULL,
  key_values_json  TEXT NOT NULL,
  reason           TEXT NOT NULL,
  actor            TEXT NOT NULL,
  at               TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS settlement_test_resolution_by_source
  ON settlement_test_resolution (workspace_id, source_system, source_processor);
CREATE TRIGGER IF NOT EXISTS settlement_test_resolution_no_update
  BEFORE UPDATE ON settlement_test_resolution
  BEGIN SELECT RAISE(ABORT, 'settlement_test_resolution is append-only'); END;
CREATE TRIGGER IF NOT EXISTS settlement_test_resolution_no_delete
  BEFORE DELETE ON settlement_test_resolution
  BEGIN SELECT RAISE(ABORT, 'settlement_test_resolution is append-only'); END;

CREATE TABLE IF NOT EXISTS settlement_event_override (
  id               TEXT PRIMARY KEY,
  workspace_id     TEXT NOT NULL REFERENCES workspace(id),
  source_system    TEXT NOT NULL,
  source_processor TEXT NOT NULL,
  event_id         TEXT NOT NULL,
  resolution       TEXT NOT NULL CHECK (resolution IN ('handled_outside', 'withdraw_handled')),
  amendments_seen  INTEGER NOT NULL,
  reason           TEXT NOT NULL,
  actor            TEXT NOT NULL,
  at               TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS settlement_event_override_by_event
  ON settlement_event_override (workspace_id, source_system, source_processor, event_id);
CREATE TRIGGER IF NOT EXISTS settlement_event_override_no_update
  BEFORE UPDATE ON settlement_event_override
  BEGIN SELECT RAISE(ABORT, 'settlement_event_override is append-only'); END;
CREATE TRIGGER IF NOT EXISTS settlement_event_override_no_delete
  BEFORE DELETE ON settlement_event_override
  BEGIN SELECT RAISE(ABORT, 'settlement_event_override is append-only'); END;
CREATE TABLE IF NOT EXISTS settlement_event_inclusion (
  id               TEXT PRIMARY KEY,
  workspace_id     TEXT NOT NULL REFERENCES workspace(id),
  source_system    TEXT NOT NULL,
  source_processor TEXT NOT NULL,
  event_id         TEXT NOT NULL,
  state            TEXT NOT NULL CHECK (state IN ('ignored', 'included')),
  reason           TEXT,
  amendments_seen  INTEGER NOT NULL,
  actor            TEXT NOT NULL,
  at               TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS settlement_event_inclusion_by_event
  ON settlement_event_inclusion (workspace_id, source_system, source_processor, event_id);
CREATE TRIGGER IF NOT EXISTS settlement_event_inclusion_no_update
  BEFORE UPDATE ON settlement_event_inclusion
  BEGIN SELECT RAISE(ABORT, 'settlement_event_inclusion is append-only'); END;
CREATE TRIGGER IF NOT EXISTS settlement_event_inclusion_no_delete
  BEFORE DELETE ON settlement_event_inclusion
  BEGIN SELECT RAISE(ABORT, 'settlement_event_inclusion is append-only'); END;
CREATE TABLE IF NOT EXISTS settlement_table_mapping (
  id               TEXT PRIMARY KEY,
  workspace_id     TEXT NOT NULL REFERENCES workspace(id),
  source_system    TEXT NOT NULL,
  source_processor TEXT NOT NULL,
  mapping_json     TEXT NOT NULL,
  headers_json     TEXT NOT NULL,
  updated_by       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS settlement_table_mapping_one_per_source
  ON settlement_table_mapping (workspace_id, source_system, source_processor);

CREATE TABLE IF NOT EXISTS settlement_table_mapping_change (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspace(id),
  mapping_id    TEXT NOT NULL REFERENCES settlement_table_mapping(id),
  old_json      TEXT,
  new_json      TEXT NOT NULL,
  actor         TEXT NOT NULL,
  at            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS settlement_table_mapping_change_by_mapping
  ON settlement_table_mapping_change (workspace_id, mapping_id, at);
CREATE TRIGGER IF NOT EXISTS settlement_table_mapping_change_no_update
  BEFORE UPDATE ON settlement_table_mapping_change
  BEGIN SELECT RAISE(ABORT, 'settlement_table_mapping_change is append-only'); END;
CREATE TRIGGER IF NOT EXISTS settlement_table_mapping_change_no_delete
  BEFORE DELETE ON settlement_table_mapping_change
  BEGIN SELECT RAISE(ABORT, 'settlement_table_mapping_change is append-only'); END;
`;
