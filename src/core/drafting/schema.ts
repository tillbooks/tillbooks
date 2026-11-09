/**
 * E06's one table, kept in E06's own module and concatenated onto `SCHEMA_SQL` at the store, the
 * pattern the whole E04/E05 cluster established: a capability's DDL sits beside the code that
 * writes it.
 *
 * THE PROMPT IS NOT HERE, AND THAT ABSENCE IS THE MECHANISM (Art. 321 StGB, spec §3): the prompt
 * E06 composes is the most concentrated collection of secrecy-bearing material in the product
 * (client mail + voice exemplars + the client's financial position, one string), so `draft_run`
 * stores `prompt_sha256` and NEVER the prompt, no body column, no facts column, and the §8
 * sentinel fixture greps the raw database file to prove not a byte of it reached the disk. The
 * ledger facts a draft used travel in the generate RESPONSE only (reconciled spec §4).
 *
 * NO `_rappen`/`_minor` COLUMN ANYWHERE (P3 by absence): a draft run posts nothing and settles
 * nothing, asserted by `test/drafting/no-financial-write-and-guards.test.mjs`. Every row carries
 * `workspace_id` (§H-TENANT). `draft_run` rows referencing an erased person's threads are purged
 * inside C00's `contacts_anonymise` (`purgeDraftRunsForContact`, before E04's mail purge). The
 * table is NOT OP3-registered, so custom fields, automation rules and plugins cannot attach
 * (spec §6b: the zero-egress inversion, fixed unless provably leak-safe).
 */

export const DRAFTING_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS draft_run (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspace(id),
  thread_id     TEXT NOT NULL,
  profile_id    TEXT,
  grounded      INTEGER NOT NULL DEFAULT 0,
  runtime_id    TEXT,
  model_ref     TEXT,
  prompt_sha256 TEXT,
  status        TEXT NOT NULL,
  actor         TEXT NOT NULL,
  started_at    TEXT NOT NULL,
  ended_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS draft_run_thread
ON draft_run (workspace_id, thread_id);
`;

/** The E06 tables as data, so the guard suites hold the schema assertions to this list. */
export const DRAFTING_TABLES = ['draft_run'] as const;
