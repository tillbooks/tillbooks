/**
 * G22's three tables, kept in G22's own module and concatenated onto `SCHEMA_SQL` at the store, the
 * pattern E03/G20 established: a capability's DDL sits beside the code that writes it.
 *
 * THREE TABLES, ALL §H-TENANT (every row carries workspace_id), NONE ON THE MONEY PATH, and NO
 * `_rappen` COLUMN ANYWHERE (asserted by test, spec §4: a checklist never touches the journal, so
 * P3 is satisfied by having nothing to delegate).
 *
 *   - `checklist_run`: one instantiated template per workspace, template and period start (the
 *     partial unique index makes `checklist_start` idempotent on the natural key, independent of the
 *     idempotency key). `status` is `open` or `abandoned`; `done` is DERIVED on every read because a
 *     system check may flip back.
 *   - `checklist_run_item`: one row per template item. A system check item's `status` stays `open`
 *     forever (its state is live); a verb item stores the hash the engine bound; a sign-off item
 *     stores the completion and points at its live `checklist_signoff` row.
 *   - `checklist_signoff`: APPEND-ONLY in G20's `implementation_signoff` shape: never DELETE, and
 *     UPDATE admitted ONLY to void a live row (`voided_at` NULL -> non-NULL with its reason), never
 *     to alter what was signed. Item 5 binds the computed return's hash; item 7 is the
 *     `filed_attestation` whose `evidence_ref` is the date the human stands behind.
 *
 * NO CHECK on any enum column: the status, owner-kind, evidence-kind and sign-off-kind enums live at
 * their single §H-ENUM source in `types.ts` / `runs.ts`. NO CASCADE: a missing parent refuses.
 */

export const CHECKLISTS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS checklist_run (
  id               TEXT PRIMARY KEY,
  workspace_id     TEXT NOT NULL REFERENCES workspace(id),
  template_id      TEXT NOT NULL,
  -- The A07 period label (2026-Q2 / 2026-H1) and its ISO bounds, copied at start so a later method
  -- change never re-dates a run that was started under the old cadence.
  period_label     TEXT NOT NULL,
  period_start     TEXT NOT NULL,
  period_end       TEXT NOT NULL,
  -- open | abandoned. Done is derived (every item done or skipped), never stored.
  status           TEXT NOT NULL DEFAULT 'open',
  created_by       TEXT NOT NULL,
  created_key      TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  abandoned_at     TEXT,
  abandoned_by     TEXT,
  abandon_reason   TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS checklist_run_one_per_period
ON checklist_run (workspace_id, template_id, period_start);

CREATE INDEX IF NOT EXISTS checklist_run_by_workspace
ON checklist_run (workspace_id, status, period_start);

CREATE TABLE IF NOT EXISTS checklist_run_item (
  id               TEXT PRIMARY KEY,
  workspace_id     TEXT NOT NULL REFERENCES workspace(id),
  run_id           TEXT NOT NULL REFERENCES checklist_run(id),
  item_id          TEXT NOT NULL,
  position         INTEGER NOT NULL,
  -- human | agent | system, copied from the template item.
  owner_kind       TEXT NOT NULL,
  -- ISO day, resolved at start from the template's offset, deadline rule or sibling item.
  due_at           TEXT,
  -- open | done | skipped (the STORED status; the read derives the live one).
  status           TEXT NOT NULL DEFAULT 'open',
  completed_by     TEXT,
  completed_at     TEXT,
  completed_key    TEXT,
  -- check | verb_result | signoff | filed_attestation, and the reference the evidence names.
  evidence_kind    TEXT,
  evidence_ref     TEXT,
  -- The computed-return hash a verb item was bound to; a differing live hash reads as stale.
  evidence_hash    TEXT,
  skip_reason      TEXT,
  skipped_by       TEXT,
  skipped_at       TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS checklist_run_item_one_per_item
ON checklist_run_item (run_id, item_id);

-- The G15 provider's due scan: open items on open runs, by due date, per workspace.
CREATE INDEX IF NOT EXISTS checklist_run_item_due
ON checklist_run_item (workspace_id, status, due_at);

-- APPEND-ONLY (§H-AUDIT): a sign-off is the human half of an item. Voiding sets voided_at, never
-- deletes; what was signed is never altered.
CREATE TABLE IF NOT EXISTS checklist_signoff (
  id               TEXT PRIMARY KEY,
  workspace_id     TEXT NOT NULL REFERENCES workspace(id),
  run_id           TEXT NOT NULL REFERENCES checklist_run(id),
  run_item_id      TEXT NOT NULL REFERENCES checklist_run_item(id),
  -- abstimmung_reviewed | filed_attestation | settlement_booked (CHECKLIST_SIGNOFF_KINDS).
  kind             TEXT NOT NULL,
  actor            TEXT NOT NULL,
  evidence_ref     TEXT NOT NULL,
  -- The bound computed-return hash where the kind demands it (abstimmung_reviewed): a recomputed
  -- return with a new hash makes this sign-off stale, and the next sign-off voids it.
  hash             TEXT,
  voided_at        TEXT,
  void_reason      TEXT,
  created_at       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS checklist_signoff_by_item
ON checklist_signoff (workspace_id, run_item_id, kind, created_at);

-- --- Append-only triggers (G20's implementation_signoff shape) ----------------------------------

CREATE TRIGGER IF NOT EXISTS checklist_signoff_no_delete
BEFORE DELETE ON checklist_signoff
BEGIN
  SELECT RAISE(ABORT, 'signoff_append_only');
END;

CREATE TRIGGER IF NOT EXISTS checklist_signoff_void_only
BEFORE UPDATE ON checklist_signoff
WHEN OLD.voided_at IS NOT NULL
  OR NEW.voided_at IS NULL
  OR NEW.id <> OLD.id
  OR NEW.workspace_id <> OLD.workspace_id
  OR NEW.run_id <> OLD.run_id
  OR NEW.run_item_id <> OLD.run_item_id
  OR NEW.kind <> OLD.kind
  OR NEW.actor <> OLD.actor
  OR NEW.evidence_ref <> OLD.evidence_ref
  OR NEW.hash IS NOT OLD.hash
  OR NEW.created_at <> OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'signoff_append_only');
END;
`;
