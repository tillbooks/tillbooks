/**
 * C00's `contact_activity` table (the OP5 activity-log seam), kept in the sales module beside the
 * code that writes it, the pattern A14/A19 established: a capability's DDL lives with its engine and
 * is concatenated onto `SCHEMA_SQL` at the store, so concurrent capability branches never all edit
 * one long string.
 *
 * The stream is APPEND-ONLY at the engine layer: there is no activity update or delete verb, and a
 * wrong note is corrected by a new note (US-C00.3, mirroring the §H-AUDIT spirit). It is NOT frozen
 * by a DB trigger, because `contacts_anonymise` must redact the bodies of a person's activities in
 * place (revDSG erasure keeps the row id so posted-document FKs stay intact); a blanket immutability
 * trigger would forbid the one lawful mutation the compliance path depends on.
 *
 * `kind` is the §H-ENUM `ACTIVITY_KIND` (note|call|email|meeting|task), enforced by the engine and
 * not a CHECK constraint (the single source of truth is `contactActivity.ts`). Every row carries
 * `workspace_id` (§H-TENANT) and a ULID id. `deal_id` is nullable and forward-looking: C01 deal
 * events drop timeline entries through the same verb once C01 ships, so the column exists now rather
 * than forcing a later migration on the hottest CRM read.
 */

export const CONTACT_ACTIVITY_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS contact_activity (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  contact_id   TEXT NOT NULL REFERENCES contact(id),
  deal_id      TEXT,
  kind         TEXT NOT NULL,
  body         TEXT NOT NULL,
  occurred_at  TEXT NOT NULL,
  user_id      TEXT,
  created_at   TEXT NOT NULL
);

-- The timeline read model (contacts_timeline, P5) is "this contact's activities, newest first", so
-- the index that answers it carries (workspace_id, contact_id) and orders by occurred_at DESC. The
-- merge re-point (contacts_merge) walks contact_id too, so this same index serves both readers.
CREATE INDEX IF NOT EXISTS contact_activity_contact
ON contact_activity (workspace_id, contact_id, occurred_at DESC);
`;
