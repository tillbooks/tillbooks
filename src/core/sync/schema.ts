/**
 * M02's DDL: the append-only publish outbox and the per-workspace publish dial, kept in the sync
 * module and concatenated onto `SCHEMA_SQL` at the store (the A14/E00/G04 pattern: a capability's
 * DDL sits beside the code that writes it, so concurrent capability branches never all edit one long
 * string in `store/schema.ts`).
 *
 * TWO TABLES AND ONE TRIGGER, no more:
 *
 *  - `sync_publish_state`: one row per workspace, the publish DIAL. `publishing` (0/1, default OFF:
 *    a local install publishes nothing), the stream `epoch` (re-minted on a G04 restore), and the
 *    consent stamp. This is the ONLY switch; there is no per-consumer configuration in the core.
 *
 *  - `sync_outbox`: the append-only, versioned publish stream. One row per published FACT, carrying
 *    the envelope metadata (`seq`, `epoch`, `occurred_at`, `actor`, `kind`, `payload_schema`) and a
 *    STABLE REFERENCE to the fact (`source_ref`, the ledger id) rather than a rendered body. The
 *    payload is projected from the IMMUTABLE ledger at read time (`stream.ts`), so it can never drift
 *    from what the books hold: a `journal.posted` row points at a posted `journal_entry` that, by the
 *    §H-AUDIT immutability triggers, can never be edited or deleted. `seq` is monotonic and gapless
 *    per workspace; `UNIQUE(workspace_id, kind, source_ref)` makes a re-publish of the same fact a
 *    no-op (idempotent on ROWS), and the rows are NEVER updated or deleted (append-only, for audit),
 *    which is why `sync_outbox` needs no immutability trigger of its own: nothing in the core issues
 *    an UPDATE or DELETE against it.
 *
 * THE TRANSACTIONAL OUTBOX, WITHOUT TOUCHING THE POSTING PATH. `sync_outbox_on_post` is an AFTER
 * UPDATE trigger on `journal_entry`: `postEntry` writes an entry's lines while it is still `draft`
 * and flips it to `posted` as the LAST step (see `ledger/postEntry.ts`), so this trigger fires at
 * that flip, in the SAME transaction as the fact, appending the envelope with the next per-workspace
 * `seq`. The append rides the fact's own transaction with no dual-write race and no CDC, and NOT ONE
 * LINE of the money path changed to get it: the seam is entirely inside this module's schema. When
 * publishing is OFF the trigger's `WHEN` clause is false and it writes nothing, so a workspace that
 * never enabled publishing has an empty `sync_outbox` and every posting result is byte-for-byte what
 * it was before this table existed. The `epoch` and `seq` come from the database at write time (no
 * wall clock in a trigger), so the append is deterministic.
 */

export const SYNC_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS sync_publish_state (
  workspace_id     TEXT PRIMARY KEY REFERENCES workspace(id),
  -- 0 = OFF (the default; egress is consent), 1 = ON. The owner-gated dial. No CHECK: the value is
  -- only ever set by enableSyncPublish/disableSyncPublish to a literal 0 or 1.
  publishing       INTEGER NOT NULL DEFAULT 0,
  -- The stream epoch. Minted when publishing is first enabled and carried across enable/disable
  -- toggles unchanged; RE-MINTED only by a G04 restore (remintEpoch), so a consumer whose cursor
  -- carries an older epoch learns the history forked instead of silently replaying a fork.
  epoch            TEXT,
  -- The contract major this workspace publishes under, frozen at enable time.
  contract_version TEXT,
  enabled_at       TEXT,
  enabled_by       TEXT
);

CREATE TABLE IF NOT EXISTS sync_outbox (
  workspace_id   TEXT NOT NULL REFERENCES workspace(id),
  -- Strictly monotonic and GAPLESS per workspace. Assigned MAX(seq)+1 at append, inside the fact's
  -- own transaction, so two interleaved writers cannot open a gap (better-sqlite3 is synchronous).
  seq            INTEGER NOT NULL,
  epoch          TEXT NOT NULL,
  -- When the fact HAPPENED (the entry's post time), not when it was published or read.
  occurred_at    TEXT NOT NULL,
  actor          TEXT NOT NULL,
  -- A CLOSED §H-ENUM namespace (contract.ts STREAM_KINDS). Every value is a past-tense FACT; there
  -- is no command kind, which is the schema property behind "the stream cannot instruct the ledger".
  kind           TEXT NOT NULL,
  -- The STABLE ledger reference this envelope points at (e.g. a journal_entry id). The payload body
  -- is projected from the immutable source at read time, so it can never drift from the books.
  source_ref     TEXT NOT NULL,
  payload_schema TEXT NOT NULL,
  -- Present only on artifact.* handles: the content hash whose bytes readSyncArtifact returns.
  artifact_sha256 TEXT,
  produced_at    TEXT NOT NULL,
  PRIMARY KEY (workspace_id, seq)
);

-- Idempotent on ROWS: the same fact (same kind + ledger ref) publishes exactly once. A re-run of the
-- backfill, or any re-publish attempt, is a no-op rather than a duplicate event.
CREATE UNIQUE INDEX IF NOT EXISTS sync_outbox_fact
ON sync_outbox (workspace_id, kind, source_ref);

-- The head/paging read (readSyncStream orders by seq; syncStreamStatus reads MAX(seq)).
CREATE INDEX IF NOT EXISTS sync_outbox_seq
ON sync_outbox (workspace_id, seq);

-- THE TRANSACTIONAL OUTBOX. Fires at the draft -> posted flip (postEntry's last step), in the same
-- transaction as the fact, only when this workspace has publishing ON. Appends the envelope with the
-- next gapless per-workspace seq and the current epoch, both read from the database (a trigger has no
-- wall clock). source_ref is the entry id; the payload is projected from the immutable entry at read.
-- No dual-write, no CDC, and the money path is untouched: the whole seam is this trigger.
CREATE TRIGGER IF NOT EXISTS sync_outbox_on_post
AFTER UPDATE OF status ON journal_entry
WHEN NEW.status = 'posted' AND OLD.status <> 'posted'
  AND (SELECT publishing FROM sync_publish_state WHERE workspace_id = NEW.workspace_id) = 1
BEGIN
  INSERT INTO sync_outbox
    (workspace_id, seq, epoch, occurred_at, actor, kind, source_ref, payload_schema, artifact_sha256, produced_at)
  VALUES (
    NEW.workspace_id,
    (SELECT COALESCE(MAX(seq), 0) + 1 FROM sync_outbox WHERE workspace_id = NEW.workspace_id),
    (SELECT epoch FROM sync_publish_state WHERE workspace_id = NEW.workspace_id),
    NEW.created_at,
    NEW.created_by,
    'journal.posted',
    NEW.id,
    'journal.posted/1',
    NULL,
    NEW.created_at
  );
END;
`;
