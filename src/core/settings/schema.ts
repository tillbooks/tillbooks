/**
 * D172, the workspace settings registry: the two tables behind it.
 *
 * `workspace_setting` holds ONE row per overridden setting. A setting with no row reads its registry
 * default (`./registry.ts`), so a book that never touched a setting holds nothing here, and a new default
 * in a later build reaches every workspace that kept the default without a migration. The value is
 * stored as JSON text (`value_json`) because a setting may be a number, a boolean or a string; the
 * registry entry's schema is checked on every write, and a stored value that no longer fits (a bound
 * tightened in a later build) reads as the default, so a read never throws.
 *
 * `workspace_setting_change` is the history: one append-only row per accepted set or reset, carrying the
 * old value, the new value, the actor, the required reason and when. The tamper-evident audit chain
 * (A03) records THAT a setting changed (`entity_kind = 'workspace_setting'`); this table records WHAT it
 * changed from and to, and why, because the chain row has no payload. A set's way back is the previous
 * value this table names. Immutable by trigger, like every other history table here.
 *
 * Both are plain `CREATE ... IF NOT EXISTS`, so the schema pass creates them on every open, and the
 * generation-13 data migration (`d172-workspace-settings` in `../store/migrations.ts`) creates them too,
 * the belt to that brace.
 */
export const SETTINGS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS workspace_setting (
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  key          TEXT NOT NULL,
  value_json   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  updated_by   TEXT NOT NULL,
  PRIMARY KEY (workspace_id, key)
);

CREATE TABLE IF NOT EXISTS workspace_setting_change (
  id             TEXT PRIMARY KEY,
  workspace_id   TEXT NOT NULL REFERENCES workspace(id),
  key            TEXT NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN ('set', 'reset')),
  old_value_json TEXT,
  new_value_json TEXT,
  reason         TEXT NOT NULL,
  actor          TEXT NOT NULL,
  at             TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS workspace_setting_change_by_key
  ON workspace_setting_change (workspace_id, key, at);

CREATE TRIGGER IF NOT EXISTS workspace_setting_change_no_update
  BEFORE UPDATE ON workspace_setting_change
  BEGIN SELECT RAISE(ABORT, 'workspace_setting_change is append-only'); END;
CREATE TRIGGER IF NOT EXISTS workspace_setting_change_no_delete
  BEFORE DELETE ON workspace_setting_change
  BEGIN SELECT RAISE(ABORT, 'workspace_setting_change is append-only'); END;
`;
