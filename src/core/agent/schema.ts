/**
 * A26's two tables, kept in A26's own module and concatenated onto `SCHEMA_SQL` at the store, the
 * pattern A14/A19/A24/G00/C00/E00 established: a capability's DDL sits beside the code that writes
 * it, so concurrent capability branches never all edit one long string in `store/schema.ts`.
 *
 * `agent_action` is the inbox queue of DRAFTED agent actions (US-A26.8): a write the dial resolved
 * to `draft` rather than `execute` is inert here until a human approves it. Approving REPLAYS the
 * stored `action_tool` with the stored `idempotency_key`, so an approve-twice is a no-op (§H-IDEMPOTENT
 * served by the store's own idempotency side-table, exactly as every key-carrying write does it). The
 * row is APPEND-then-transition: `status` walks pending -> executed (on a successful approve) or
 * pending -> rejected, and never back, so the inbox has a single source of truth for its state machine
 * (§6b Fixed).
 *
 * `agent_dial` is the per-capability approval dial (US-A26.8). ONE ROW PER (workspace, capability),
 * and an ABSENT row means the safe default `ask`, the `aging_bucket_config` precedent: a default
 * written on first read would make "never configured" and "deliberately chose ask" indistinguishable
 * and would turn every dial read into a write. So the absence carries the meaning, which is also why
 * A26 needs NO seeding migration at workspace creation (A23 owns that path and A26 does not touch it):
 * a fresh workspace resolves every dial capability to `ask` from the missing row alone.
 *
 * `idempotency_key` on `agent_dial` records WHICH key last changed the row and nothing more: the
 * PRIMARY KEY is (workspace, capability) and the row is replaced in place, so it can only remember the
 * MOST RECENT key. §H-IDEMPOTENT is served by the store's `idempotency` side-table (the
 * `aging_bucket_config` reasoning), never by reading this column back.
 *
 * `agent_action.reject_reason` (F-08, J5.6 "No, and tell it why", 2026-09-05) is the human's optional
 * sentence on a rejection. It is additive (`ADDITIVE_COLUMNS`), nullable, and read back by the queue,
 * by the replay answer, and by the trace (`get_agent_session` joins it onto the drafting call), so the
 * next session can read why the last proposal was refused instead of proposing it again blind.
 *
 * `agent_action_by_key` (F-08 c, 2026-09-05) is the replay lookup: a governed write at `ask` that
 * arrives AGAIN with the same `idempotency_key` for the same `action_tool` answers with the row it
 * already minted instead of a second Vorschlag (measured in J3.10: two proposals for one booking, and
 * the approver had to clear both). It is a plain index, NOT a unique one, on purpose: files written
 * before this commit can already hold such duplicates, and a unique additive index would refuse to
 * open them. The lookup in `enqueueDraftedAction` is what enforces the rule; the index only makes it
 * cheap. Partial, because a draft with no key (an embedder's) is outside the rule.
 *
 * A35 adds the TRACE beneath: `agent_session` / `agent_turn` / `agent_call`. One `agent_call` row per
 * verb call an agent seat makes at the transports (reads and refusals included), written by the
 * recorder at the dispatch seam, never by any caller-invokable verb. Every row carries `workspace_id`
 * DIRECTLY so §H-TENANT holds without a join. `agent_turn.text` is nullable because most turns carry
 * no prose (an external MCP client sends calls, not sentences); prose exists only on the composer
 * path (D90 D-5) and is deletable per session and pruned with the trace at 24 months. The trace is
 * OPERATIONAL and prunable; the statutory record stays A03's permanent audit chain.
 */

export const AGENT_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS agent_dial (
  workspace_id    TEXT NOT NULL REFERENCES workspace(id),
  capability      TEXT NOT NULL,
  level           TEXT NOT NULL,
  idempotency_key TEXT,
  updated_by      TEXT,
  updated_at      TEXT NOT NULL,
  PRIMARY KEY (workspace_id, capability)
);

CREATE TABLE IF NOT EXISTS agent_action (
  id               TEXT PRIMARY KEY,
  workspace_id     TEXT NOT NULL REFERENCES workspace(id),
  actor            TEXT NOT NULL,
  dial_capability  TEXT,
  action_tool      TEXT NOT NULL,
  payload_json     TEXT NOT NULL,
  status           TEXT NOT NULL,
  idempotency_key  TEXT,
  result_json      TEXT,
  created_at       TEXT NOT NULL,
  resolved_at      TEXT,
  resolved_by      TEXT,
  reject_reason    TEXT
);

CREATE INDEX IF NOT EXISTS agent_action_queue
ON agent_action (workspace_id, status, created_at);

CREATE INDEX IF NOT EXISTS agent_action_by_key
ON agent_action (workspace_id, action_tool, idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS agent_session (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspace(id),
  actor         TEXT NOT NULL,
  client_label  TEXT,
  transport_key TEXT,
  started_at    TEXT NOT NULL,
  last_at       TEXT NOT NULL,
  closed_at     TEXT
);

CREATE INDEX IF NOT EXISTS agent_session_recency
ON agent_session (workspace_id, last_at);

CREATE TABLE IF NOT EXISTS agent_turn (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  session_id   TEXT NOT NULL,
  seq          INTEGER NOT NULL,
  role         TEXT NOT NULL,
  text         TEXT,
  at           TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS agent_turn_session
ON agent_turn (workspace_id, session_id, seq);

CREATE TABLE IF NOT EXISTS agent_call (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspace(id),
  turn_id         TEXT NOT NULL,
  seq             INTEGER NOT NULL,
  verb            TEXT NOT NULL,
  kind            TEXT NOT NULL,
  args_json       TEXT NOT NULL,
  mode            TEXT NOT NULL,
  decision_reason TEXT NOT NULL,
  dial_capability TEXT,
  ok              INTEGER NOT NULL,
  error_code      TEXT,
  entity_ref      TEXT,
  duration_ms     INTEGER NOT NULL,
  at              TEXT NOT NULL,
  agent_action_id TEXT,
  resolved_by     TEXT,
  resolved_at     TEXT
);

CREATE INDEX IF NOT EXISTS agent_call_turn
ON agent_call (workspace_id, turn_id, seq);

CREATE INDEX IF NOT EXISTS agent_call_backlink
ON agent_call (workspace_id, agent_action_id);

CREATE INDEX IF NOT EXISTS agent_call_entity
ON agent_call (workspace_id, entity_ref);
`;
