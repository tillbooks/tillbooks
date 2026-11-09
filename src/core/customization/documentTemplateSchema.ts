/**
 * G05's table (data model §DG, cluster G, additive), kept in G05's own module.
 *
 * The pattern A14 established and G00 followed: the DDL a capability writes sits beside the code
 * that writes it, and concurrent capability branches do not all edit one long string in
 * `store/schema.ts`. The store concatenates this onto `SCHEMA_SQL`.
 *
 * NO CHECK CONSTRAINT ON `document_kind` OR `language_mode`, matching the §D0 convention: each enum
 * lives at its single §H-ENUM source of truth (`documentTemplates.ts`), so widening one is one edit
 * in one file with no migration. A CHECK here would be a second enumeration point.
 *
 * THE ONE-DEFAULT RULE IS A PARTIAL UNIQUE INDEX, not application discipline alone.
 * `setDefaultDocumentTemplate` clears the prior default in the same transaction it sets the new
 * one, and this index makes the invariant unrepresentable rather than merely maintained: two
 * concurrent writers cannot leave a kind with two defaults, whatever order their statements land in.
 *
 * NO `logo_file_id` COLUMN, deliberately (spec §4): the logo is an ordinary E00 `stored_file` row
 * linked via OP3 `file_link(entity_kind='document_template')`, read back via `files_list_linked`,
 * so logo storage has exactly one owner (E00) and G05 never duplicates the FK.
 *
 * The two freeze columns G05 owns on OTHER capabilities' tables (`document.rendered_template_id`,
 * `dunning_run.rendered_template_id`) ride `ADDITIVE_COLUMNS` in `store/schema.ts`, the C02/A13
 * shape, because ALTER TABLE is how an existing book gains a column.
 */

export const DOCUMENT_TEMPLATE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS document_template (
  id               TEXT PRIMARY KEY,
  workspace_id     TEXT NOT NULL REFERENCES workspace(id),
  -- One of DOCUMENT_TEMPLATE_KINDS (documentTemplates.ts). Not a CHECK: the registry is the enum.
  document_kind    TEXT NOT NULL,
  name             TEXT NOT NULL,
  -- JSON array of ordered OPTIONAL (non-legal) column keys. The legally required columns are never
  -- listed here because they are never optional (spec §6b).
  line_item_columns TEXT NOT NULL DEFAULT '[]',
  -- { "de-CH": "...", "en": "..." }: footer text per P11 locale. JSON, because a footer is
  -- per-locale and a column is not.
  footer_i18n      TEXT NOT NULL DEFAULT '{}',
  -- 'fixed' | 'per_contact_lang' (documentTemplates.ts is the enum source).
  language_mode    TEXT NOT NULL DEFAULT 'fixed',
  -- One of the four P11 locales; also the fallback under per_contact_lang when a contact has no lang.
  fixed_locale     TEXT NOT NULL DEFAULT 'de-CH',
  is_default       INTEGER NOT NULL DEFAULT 0,
  archived         INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS document_template_by_kind
ON document_template (workspace_id, document_kind, archived);

CREATE UNIQUE INDEX IF NOT EXISTS document_template_one_default
ON document_template (workspace_id, document_kind) WHERE is_default = 1;
`;
