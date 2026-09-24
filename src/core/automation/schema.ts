/**
 * G01's two tables, kept in G01's own module.
 *
 * The pattern A14 established and A24 and G00 followed: the DDL a capability writes sits beside the
 * code that writes it, and concurrent capability branches do not all edit one long string in
 * `store/schema.ts`. The store concatenates this onto `SCHEMA_SQL`.
 *
 * `automation_run_once` IS THE IDEMPOTENCY GUARANTEE, AND IT IS A ROW CONSTRAINT RATHER THAN A CODE
 * PATH. §H-IDEMPOTENT on an engine that fires unattended cannot be a check somebody remembers to
 * write: a redelivered event has to be unable to produce a second firing even if every line of
 * `fire.ts` were wrong. `event_ref` identifies the OCCURRENCE (`invoice.issued:<invoiceId>`, not the
 * delivery), so a replayed write computes the same value and the second INSERT is refused by SQLite
 * before any action is invoked.
 *
 * WHY `status` IS WRITTEN TWICE ON ONE ROW AND WHY THAT IS STILL §H-AUDIT. The row is INSERTed as
 * `running` BEFORE the action is invoked and UPDATEd exactly once to its terminal status, under
 * `WHERE status = 'running'`. That is a claim-then-settle: no run row is ever deleted and no terminal
 * status is ever rewritten. It makes the engine deliberately AT-MOST-ONCE. If the process dies between
 * the claim and the settle the row stays `running` for ever, the rule never re-fires for that
 * occurrence, and a human sees a stuck row in the Verlauf tab. On an append-only ledger a missed
 * follow-up is visible and repairable by hand, while a double post is a correction entry in the books.
 *
 * NO CHECK CONSTRAINT ON `status` OR ON `trigger_event`, matching the §D0 convention the core schema
 * states: the enums live at their single §H-ENUM sources (`fire.ts` and `events.ts`), so adding a
 * status or an event is one edit in one file with no migration. A CHECK here would be a second
 * enumeration point.
 *
 * NO CASCADE ANYWHERE. A rule is archived, never deleted, so a run row can never be orphaned; the FK
 * refuses rather than silently taking the history with it.
 */

export const AUTOMATION_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS automation_rule (
  id             TEXT PRIMARY KEY,
  workspace_id   TEXT NOT NULL REFERENCES workspace(id),
  name           TEXT NOT NULL,
  -- An AUTOMATION_EVENTS registry id (core/automation/events.ts). Not a CHECK: the registry is the enum.
  trigger_event  TEXT NOT NULL,
  -- JSON predicate, or the literal 'null' meaning "always". Validated at save, never at first fire.
  condition      TEXT NOT NULL,
  -- The registered WRITE verb this rule invokes, and the JSON input template it invokes it with.
  action_tool    TEXT NOT NULL,
  action_input   TEXT NOT NULL,
  -- P8: a rule written by the 'agent' actor lands 0 here and cannot fire until a human enables it.
  enabled        INTEGER NOT NULL DEFAULT 1,
  archived       INTEGER NOT NULL DEFAULT 0,
  -- THE ACTOR EVERY FIRING RUNS AS. Never a system identity: see fire.ts.
  created_by     TEXT NOT NULL,
  -- The cadence bookmark for a schedule trigger. NULL until the rule has fired once.
  last_fired_at  TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS automation_rule_by_event
ON automation_rule (workspace_id, trigger_event, enabled, archived);

CREATE TABLE IF NOT EXISTS automation_run (
  id             TEXT PRIMARY KEY,
  workspace_id   TEXT NOT NULL REFERENCES workspace(id),
  rule_id        TEXT NOT NULL REFERENCES automation_rule(id),
  trigger_event  TEXT NOT NULL,
  -- The OCCURRENCE key. Two deliveries of one occurrence share it; two occurrences never do.
  event_ref      TEXT NOT NULL,
  -- running | ok | failed | skipped_condition | suppressed_loop | suppressed_depth (fire.ts owns the enum).
  status         TEXT NOT NULL,
  action_tool    TEXT NOT NULL,
  -- The template AFTER resolution: what was really sent, not what was configured.
  action_input   TEXT NOT NULL,
  -- The target verb's own rejection code, verbatim, or NULL. Never a stack trace.
  error_code     TEXT,
  -- Who the action ran as. Always the rule's created_by, restated here so the log stands alone.
  actor          TEXT NOT NULL,
  -- HOW MANY TIMES THIS OCCURRENCE WAS DELIVERED AGAIN AFTER IT WAS ACCOUNTED FOR.
  -- The claim INSERT is refused by automation_run_once on a redelivery, which is the guarantee and
  -- stays the guarantee. What was missing is that the refusal left NO trace: the fire path returned
  -- silently, so "this rule fired nothing and said nothing" and "nothing was due" were the same
  -- observation. That is the property that made the event_ref collapse invisible for as long as it
  -- was. A monotonic counter is not a status rewrite and does not weaken H-AUDIT: the terminal status
  -- and every other fact on the row are still written exactly once and never revised.
  redeliveries   INTEGER NOT NULL DEFAULT 0,
  started_at     TEXT NOT NULL,
  finished_at    TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS automation_run_once
ON automation_run (workspace_id, rule_id, event_ref);

CREATE INDEX IF NOT EXISTS automation_run_by_rule
ON automation_run (workspace_id, rule_id, started_at);
`;
