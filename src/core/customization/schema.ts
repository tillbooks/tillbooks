/**
 * G00's three tables (data model §DG), kept in G00's own module.
 *
 * The pattern A14 established and A24 followed: the DDL a capability writes sits beside the code that
 * writes it, and concurrent capability branches do not all edit one long string in `store/schema.ts`.
 * The store concatenates this onto `SCHEMA_SQL`.
 *
 * NO CHECK CONSTRAINT ON `type` OR `layout`, matching the §D0 convention the core schema states: the
 * enum lives at the single §H-ENUM source of truth (`fields.ts` / `views.ts`), so adding a tenth field
 * type is one edit in one file with no migration. A CHECK here would be a second enumeration point,
 * which is exactly what §6b forbids.
 *
 * WHY `custom_field_value` KEYS ON `field_def_id` AND NOT ON (`entity_kind`, `key`). A def's `key` is
 * editable prose; its id is not. Keying the value on the id means renaming a field's label, or
 * re-defining it to add an option, never orphans a single stored value, and the FK makes "a value
 * whose def vanished" unrepresentable rather than merely unlikely.
 *
 * THE VALUES OF AN ARCHIVED DEF ARE NOT DELETED AND THERE IS NO CASCADE ANYWHERE IN HERE. Archiving is
 * a flag on the def. `ON DELETE CASCADE` would turn a future, careless `DELETE FROM custom_field_def`
 * into silent data loss across every record in the workspace, and this ledger does not delete user
 * data casually (§4). A def is archived, never deleted, and the FK enforces that by refusing.
 */

export const CUSTOMIZATION_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS custom_field_def (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspace(id),
  -- An OP3 registry id (core/customization/entities.ts). Not a CHECK: the registry is the enum.
  entity_kind   TEXT NOT NULL,
  -- The stable machine name, unique per (workspace, entity_kind). Never renamed: rename the label.
  key           TEXT NOT NULL,
  -- { "de-CH": "Segment", "en": "Segment" }. JSON, because a label is per-locale and a column is not.
  label_i18n    TEXT NOT NULL,
  type          TEXT NOT NULL,
  -- JSON array for select/multiselect, NULL otherwise.
  options       TEXT,
  required      INTEGER NOT NULL DEFAULT 0,
  -- JSON-encoded, so NULL ("no default") and the literal null are distinguishable.
  default_value TEXT,
  sort          INTEGER NOT NULL DEFAULT 0,
  archived      INTEGER NOT NULL DEFAULT 0,
  -- P8: a def written by the 'agent' actor lands here as 1 and is invisible until confirm_field.
  draft         INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS custom_field_def_key
ON custom_field_def (workspace_id, entity_kind, key);

CREATE TABLE IF NOT EXISTS custom_field_value (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspace(id),
  field_def_id  TEXT NOT NULL REFERENCES custom_field_def(id),
  -- Denormalised from the def so a read for one record is one indexed query and never a join.
  entity_kind   TEXT NOT NULL,
  entity_id     TEXT NOT NULL,
  -- JSON-encoded in every case, so a typed value round-trips without a per-type column.
  value         TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS custom_field_value_one
ON custom_field_value (field_def_id, entity_id);

CREATE INDEX IF NOT EXISTS custom_field_value_by_record
ON custom_field_value (workspace_id, entity_kind, entity_id);

CREATE TABLE IF NOT EXISTS saved_view (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspace(id),
  entity_kind   TEXT NOT NULL,
  name          TEXT NOT NULL,
  -- NULL means WORKSPACE-SHARED and is the whole access rule: a shared view needs
  -- manage_saved_views to write, a personal one belongs to the actor named here.
  owner_actor   TEXT,
  filters       TEXT NOT NULL,
  sort          TEXT NOT NULL,
  columns       TEXT NOT NULL,
  layout        TEXT NOT NULL,
  is_default    INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS saved_view_by_kind
ON saved_view (workspace_id, entity_kind);
`;
