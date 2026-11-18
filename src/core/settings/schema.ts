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

-- D202: seat, via, approved_by, drafted_action_id and capability ride SETTINGS_ADDITIVE_COLUMNS below, so a
-- fresh book and an older one get them the same way (ADD COLUMN on open).

CREATE TRIGGER IF NOT EXISTS workspace_setting_change_no_update
  BEFORE UPDATE ON workspace_setting_change
  BEGIN SELECT RAISE(ABORT, 'workspace_setting_change is append-only'); END;
CREATE TRIGGER IF NOT EXISTS workspace_setting_change_no_delete
  BEFORE DELETE ON workspace_setting_change
  BEGIN SELECT RAISE(ABORT, 'workspace_setting_change is append-only'); END;
`;

/**
 * D202 (I9): how a change came about, on its history row. Nullable with a NULL default, which is all
 * `ALTER TABLE ... ADD COLUMN` supports: a row written before D202 reads NULL in each (unknown, never
 * claimed), and no schema generation moves (the N03 provenance precedent). The append-only triggers above
 * cover the new columns as they cover the old ones. `store/schema.ts` spreads this into `ADDITIVE_COLUMNS`.
 *  - `seat`: person | agent | plugin | system.
 *  - `via`: direct | vorschlag (a person approved the agent's Vorschlag) | standing (the agent, under the
 *    owner's area permission `agent.settings_sections`) | dial (the agent, under the dial of the key's family).
 *  - `approved_by`, `drafted_action_id`: the approver and the Vorschlag of a `vorschlag` change.
 *  - `capability`: what the change was checked against (the owning capability, `agent.settings_sections:<area>`
 *    or `dial:<family>`).
 */
export const SETTINGS_ADDITIVE_COLUMNS: readonly { table: string; column: string; ddl: string }[] = [
  { table: 'workspace_setting_change', column: 'seat', ddl: "seat TEXT CHECK (seat IS NULL OR seat IN ('person', 'agent', 'plugin', 'system'))" },
  { table: 'workspace_setting_change', column: 'via', ddl: "via TEXT CHECK (via IS NULL OR via IN ('direct', 'vorschlag', 'standing', 'dial'))" },
  { table: 'workspace_setting_change', column: 'approved_by', ddl: 'approved_by TEXT' },
  { table: 'workspace_setting_change', column: 'drafted_action_id', ddl: 'drafted_action_id TEXT' },
  { table: 'workspace_setting_change', column: 'capability', ddl: 'capability TEXT' },
];
