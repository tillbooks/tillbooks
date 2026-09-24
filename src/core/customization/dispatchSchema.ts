/**
 * G05 §10's two tables (data model §10.4), kept in G05's own module (the `documentTemplateSchema.ts`
 * pattern: the DDL a capability writes sits beside the code that writes it, and concurrent branches
 * do not all edit one long string in `store/schema.ts`). The store concatenates this onto
 * `SCHEMA_SQL`, so a fresh CREATE and the G04 backup snapshot both carry the tables with no
 * `ADDITIVE_COLUMNS` entry (new tables, never widened columns).
 *
 * NO CHECK CONSTRAINT ON `document_kind`, `channel` OR `outcome`, the §D0 convention: each enum
 * lives at its single §H-ENUM source in `dispatch.ts`, so adding a member is one edit in one file
 * with no migration. A CHECK here would be a second enumeration point.
 *
 * `dispatches` IS APPEND-ONLY THROUGH THE VERB SURFACE (spec §10.4): no update or delete verb
 * exists over it, and the sole write outside the append is C00 `contacts_anonymise`'s statutory
 * field redaction (blank the personal columns, keep the structural fact), which is C00-owned and
 * recorded against C00 by name in the spec's §0 item 8. The dual nullable FK (`document_id` /
 * `dunning_run_id`) mirrors §4's own `rendered_template_id` placement: a Mahnlauf is not an A10
 * document. There is no CASCADE anywhere here, deliberately: a send log a DELETE could take with it
 * answers nothing (the G00 schema's own argument).
 */

export const DISPATCH_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS dispatch_texts (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspace(id),
  -- Subset of the templatable kinds (invoice|quote|dunning_run; credit_note excluded per spec
  -- section 10.3: A13 has no send step). Not a CHECK: the registry in dispatch.ts is the enum.
  document_kind TEXT NOT NULL,
  -- One of the four P11 locales.
  locale        TEXT NOT NULL,
  subject       TEXT NOT NULL,
  body          TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  updated_by    TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS dispatch_texts_slot
ON dispatch_texts (workspace_id, document_kind, locale);

CREATE TABLE IF NOT EXISTS dispatches (
  id                       TEXT PRIMARY KEY,
  workspace_id             TEXT NOT NULL REFERENCES workspace(id),
  document_kind            TEXT NOT NULL,
  document_id              TEXT REFERENCES document(id),
  dunning_run_id           TEXT REFERENCES dunning_run(id),
  contact_id               TEXT REFERENCES contact(id),
  recipient_email          TEXT,
  -- smtp | cloud_relay | artifact_only (section H-ENUM source: dispatch.ts).
  channel                  TEXT NOT NULL,
  locale                   TEXT NOT NULL,
  subject_resolved         TEXT NOT NULL,
  body_resolved            TEXT NOT NULL,
  dispatch_text_defaulted  INTEGER NOT NULL DEFAULT 1,
  -- sent | degraded | failed | artifact_created (section H-ENUM source: dispatch.ts).
  outcome                  TEXT NOT NULL,
  degrade_reason           TEXT,
  actor                    TEXT NOT NULL,
  sent_at                  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS dispatches_by_time
ON dispatches (workspace_id, sent_at);

CREATE INDEX IF NOT EXISTS dispatches_by_contact
ON dispatches (workspace_id, contact_id);
`;
