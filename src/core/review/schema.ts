/**
 * A25's one table, kept in A25's own module (the pattern A14/A19/A15/A21/E00 established: a
 * capability's DDL sits beside the code that writes it and is concatenated onto `SCHEMA_SQL` at the
 * store, so concurrent capability branches never all edit one long string in `store/schema.ts`).
 *
 * `entry_review` is a SIDECAR to the immutable ledger, and the shape enforces the boundary rather
 * than merely documenting it: the table is APPEND-ONLY in use (no A25 verb issues an UPDATE or
 * DELETE against anything, `journal_*` least of all), each row is one review EVENT (a comment, a
 * flag, an approval), and an entry's current review status is the latest row's `status`. A wrong
 * comment is answered by a new comment, mirroring C00's OP5 activity stream and the §H-AUDIT spirit
 * without being a hash chain. No column here can hold money: review is metadata ABOUT a posting,
 * never a posting.
 *
 * `status` is the state AFTER the event (a comment carries the status it found in force, a flag
 * carries `flagged`, an approval `approved`), so the thread reads chronologically without a join.
 * `source` says who kind of author wrote the row: `manual` for a person or agent calling the verb
 * directly, `prepare` for the machine flags `preparePeriod` leaves, which is what lets a re-run
 * recognise its own earlier flags and refresh rather than duplicate them.
 *
 * Every row carries `workspace_id` (§H-TENANT). New table, `CREATE TABLE IF NOT EXISTS`, no
 * additive column and no row transform, so no data migration and no `SCHEMA_GENERATION` bump
 * accompany it: an existing file gains the empty table on open.
 */

export const REVIEW_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS entry_review (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  entry_id     TEXT NOT NULL REFERENCES journal_entry(id),
  kind         TEXT NOT NULL,
  status       TEXT NOT NULL,
  reviewer     TEXT,
  comment      TEXT,
  source       TEXT NOT NULL DEFAULT 'manual',
  created_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS entry_review_entry
  ON entry_review (workspace_id, entry_id, created_at);
`;
