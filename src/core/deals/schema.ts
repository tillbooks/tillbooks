/**
 * C01's three tables, kept in C01's own module and concatenated onto `SCHEMA_SQL` at the store, the
 * pattern A14/A19/A24/G00/C00/E00/B00/E03 established: a capability's DDL sits beside the code that
 * writes it, so concurrent capability branches never all edit one long string in `store/schema.ts`.
 *
 * Every row carries `workspace_id` (§H-TENANT). `deal.status` is the §H-ENUM `DEAL_STATUSES`
 * enforced by the engine, not a CHECK constraint (the single source of truth is `enums.ts`, the C00
 * pattern). The §H-FX trio (`value_minor`, `value_base_minor`, `fx_rate`) is frozen at capture:
 * only a `deals_update` patch naming `valueMinor` or `currency` may re-derive it, and read-time
 * math only ever touches the integer base (spec §4).
 *
 * `pipeline_stage.outcome` is NULL for an open stage or 'won'/'lost' for a terminal one: the flag
 * that lets a WORKSPACE decide which of its configurable stages closes a deal, while the derivation
 * itself (entering one forces `status`) stays fixed mechanism behind `markDeal` (spec §6b Fixed).
 *
 * NO `ON DELETE CASCADE`, deliberately, matching G00's schema rule: a careless DELETE must refuse
 * rather than silently take dependent rows with it. There is no hard-delete verb in C01 at all.
 */

export const DEALS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS pipeline (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspace(id),
  name          TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pipeline_stage (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspace(id),
  pipeline_id   TEXT NOT NULL REFERENCES pipeline(id),
  name          TEXT NOT NULL,
  sort          INTEGER NOT NULL DEFAULT 0,
  probability   INTEGER NOT NULL DEFAULT 0,
  outcome       TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

-- The board renders one pipeline's stages in sort order.
CREATE INDEX IF NOT EXISTS pipeline_stage_board
ON pipeline_stage (workspace_id, pipeline_id, sort);

CREATE TABLE IF NOT EXISTS deal (
  id                     TEXT PRIMARY KEY,
  workspace_id           TEXT NOT NULL REFERENCES workspace(id),
  contact_id             TEXT NOT NULL REFERENCES contact(id),
  pipeline_id            TEXT NOT NULL REFERENCES pipeline(id),
  stage_id               TEXT NOT NULL REFERENCES pipeline_stage(id),
  title                  TEXT NOT NULL,
  status                 TEXT NOT NULL DEFAULT 'open',
  probability            INTEGER NOT NULL,
  probability_overridden INTEGER NOT NULL DEFAULT 0,
  value_minor            INTEGER NOT NULL,
  currency               TEXT NOT NULL,
  value_base_minor       INTEGER NOT NULL,
  fx_rate                TEXT NOT NULL,
  expected_close_on      TEXT,
  lost_reason            TEXT,
  quote_id               TEXT REFERENCES document(id),
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL
);

-- The board read (deals_list, P5) filters one pipeline by status.
CREATE INDEX IF NOT EXISTS deal_board
ON deal (workspace_id, pipeline_id, status);

-- The per-contact drawer list, and the C00 merge re-point scan.
CREATE INDEX IF NOT EXISTS deal_contact
ON deal (workspace_id, contact_id);
`;
