/**
 * N00, the Hausbuch: the two tables behind the workspace's house notes.
 *
 * `hausbuch_note` holds one row per note: its scope (the whole workspace, an account, a bank counterparty
 * keyed as `bank_standard.counterparty_key` is, or a topic), the scope's label as it read when written, its
 * text and whether it is active. A note is guidance: nothing reads it to post, book or file.
 * An archived note keeps its row (archive is a status, never a delete), so the history below always has
 * the note it describes and `hausbuch_note_set` on its id brings it back.
 *
 * `hausbuch_note_change` is the history: one append-only row per accepted create, update, archive or
 * restore, carrying the old and new text and scope, the actor and when. The A03 audit
 * chain records THAT a note changed (`entity_kind = 'hausbuch_note'`); this table records WHAT changed,
 * because the chain row has no payload (the `workspace_setting_change` shape, D172). Immutable by trigger.
 *
 * Both carry `workspace_id` (§H-TENANT) and are plain `CREATE ... IF NOT EXISTS`, so the schema pass
 * creates them on every open of an existing book: two new tables change the book's shape and leave its
 * generation where it was (`store/schemaShape.ts`).
 */
export const HAUSBUCH_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS hausbuch_note (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  scope_kind   TEXT NOT NULL CHECK (scope_kind IN ('workspace', 'account', 'counterparty', 'topic')),
  scope_ref    TEXT,
  scope_label  TEXT,
  text         TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at   TEXT NOT NULL,
  created_by   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  updated_by   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS hausbuch_note_by_scope
  ON hausbuch_note (workspace_id, status, scope_kind, scope_ref);

CREATE TABLE IF NOT EXISTS hausbuch_note_change (
  id             TEXT PRIMARY KEY,
  workspace_id   TEXT NOT NULL REFERENCES workspace(id),
  note_id        TEXT NOT NULL REFERENCES hausbuch_note(id),
  kind           TEXT NOT NULL CHECK (kind IN ('create', 'update', 'archive', 'restore')),
  old_text       TEXT,
  new_text       TEXT,
  old_scope_json TEXT,
  new_scope_json TEXT,
  actor          TEXT NOT NULL,
  at             TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS hausbuch_note_change_by_note
  ON hausbuch_note_change (workspace_id, note_id, at);

CREATE TRIGGER IF NOT EXISTS hausbuch_note_change_no_update
  BEFORE UPDATE ON hausbuch_note_change
  BEGIN SELECT RAISE(ABORT, 'hausbuch_note_change is append-only'); END;
CREATE TRIGGER IF NOT EXISTS hausbuch_note_change_no_delete
  BEFORE DELETE ON hausbuch_note_change
  BEGIN SELECT RAISE(ABORT, 'hausbuch_note_change is append-only'); END;
`;
