/**
 * A40's four tables, kept in A40's own module and concatenated onto `SCHEMA_SQL` at the store (the
 * A14 / A38 pattern: a capability's DDL sits beside the code that writes it).
 *
 * ALL §H-TENANT (every row carries `workspace_id`). NONE holds a posting: A40 posts nothing and pays
 * nothing, so no row here references `journal_entry`. Every money column ends `_minor` (integer minor
 * units in the row's own currency, Pattern P2).
 *
 *   - `skonto_term`: a supplier's Skonto condition, either a vendor default ("r % within n days of
 *     the bill date") or a per-bill override ("r % until a date"). `rate_bp = 0` is an explicit "no
 *     Skonto" that overrides a vendor default for one bill. Master data: updated in place, audited.
 *   - `planned_flow`: a known fixed cost or income (rent, salaries) the books do not schedule
 *     themselves. Retired with `active = 0`, never deleted.
 *   - `payment_plan` + `payment_plan_line`: one proposal and its per-bill decisions. APPEND-ONLY in
 *     their economics: the inputs, the parameters, the objective and each line's date, cash and reason
 *     are frozen by trigger at insert; only the draft columns (`status`, `drafted_*`,
 *     `draft_result_json`, a line's `batch_id`) may fill in, once. DELETE is refused on both.
 *
 * IDEMPOTENT ON ROWS: `payment_plan` is UNIQUE on `(workspace_id, inputs_hash)` among PROPOSED plans,
 * so proposing again on unchanged books can never insert a second open plan, whatever idempotency key
 * the caller sends; a drafted plan no longer answers a new proposal (critic M5).
 *
 * NO CHECK on any enum column: the enums live at their single §H-ENUM source in `plan.ts`,
 * `plannedFlows.ts` and `terms.ts`.
 */

export const LIQUIDITY_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS skonto_term (
  id               TEXT PRIMARY KEY,
  workspace_id     TEXT NOT NULL REFERENCES workspace(id),
  -- vendor | bill (terms.ts, SKONTO_SCOPES)
  scope_kind       TEXT NOT NULL,
  -- contact.id for a vendor default, vendor_bill.id for a bill override. Polymorphic, so no single
  -- REFERENCES can be declared; the G04 restore chokepoint (claude/g04-restore-chokepoint) remaps it.
  scope_id         TEXT NOT NULL,
  rate_bp          INTEGER NOT NULL,
  -- vendor default only: the Skonto window in calendar days from the bill date
  days             INTEGER,
  -- bill override only: the last day the payment may arrive and still earn the Skonto
  until_date       TEXT,
  idempotency_key  TEXT NOT NULL,
  created_by       TEXT,
  created_at       TEXT NOT NULL,
  updated_by       TEXT,
  updated_at       TEXT NOT NULL,
  UNIQUE (workspace_id, scope_kind, scope_id)
);

CREATE TABLE IF NOT EXISTS planned_flow (
  id               TEXT PRIMARY KEY,
  workspace_id     TEXT NOT NULL REFERENCES workspace(id),
  label            TEXT NOT NULL,
  -- in | out (plannedFlows.ts, PLANNED_FLOW_DIRECTIONS)
  direction        TEXT NOT NULL,
  amount_minor     INTEGER NOT NULL,
  currency         TEXT NOT NULL,
  first_date       TEXT NOT NULL,
  -- once | monthly | quarterly | yearly (plannedFlows.ts, PLANNED_FLOW_RECURRENCES)
  recurrence       TEXT NOT NULL,
  end_date         TEXT,
  active           INTEGER NOT NULL DEFAULT 1,
  -- The bank account the flow moves (critic R2-M2). NULL: no known account, so a forecast solved on
  -- chosen accounts counts it there and says so ("account_unknown").
  bank_account_id  TEXT REFERENCES bank_account(id),
  idempotency_key  TEXT NOT NULL,
  created_by       TEXT,
  created_at       TEXT NOT NULL,
  updated_by       TEXT,
  updated_at       TEXT NOT NULL,
  UNIQUE (workspace_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS planned_flow_ws ON planned_flow(workspace_id, active);

CREATE TABLE IF NOT EXISTS payment_plan (
  id                     TEXT PRIMARY KEY,
  workspace_id           TEXT NOT NULL REFERENCES workspace(id),
  -- proposed | drafted (plan.ts, PAYMENT_PLAN_STATUSES)
  status                 TEXT NOT NULL,
  as_of                  TEXT NOT NULL,
  horizon_end            TEXT NOT NULL,
  currency               TEXT NOT NULL,
  floor_minor            INTEGER NOT NULL,
  params_json            TEXT NOT NULL,
  inputs_hash            TEXT NOT NULL,
  inputs_json            TEXT NOT NULL,
  objective_minor        INTEGER NOT NULL,
  skonto_captured_minor  INTEGER NOT NULL,
  late_interest_minor    INTEGER NOT NULL,
  -- proven | heuristic (optimise.ts, OPTIMALITIES)
  optimality             TEXT NOT NULL,
  upper_bound_minor      INTEGER NOT NULL,
  -- No schedule has fewer days late (critic R2-L4): the proposal's own total when proven, a floor when heuristic.
  -- DEFAULT 0 is the trivial floor (always true); the engine writes the measured one.
  late_days_lower_bound  INTEGER NOT NULL DEFAULT 0,
  nodes_explored         INTEGER NOT NULL,
  min_balance_minor      INTEGER NOT NULL,
  min_balance_date       TEXT NOT NULL,
  base_breach_json       TEXT,
  idempotency_key        TEXT NOT NULL,
  created_by             TEXT,
  created_at             TEXT NOT NULL,
  drafted_at             TEXT,
  drafted_by             TEXT,
  draft_key              TEXT,
  draft_result_json      TEXT,
  UNIQUE (workspace_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS payment_plan_ws ON payment_plan(workspace_id, created_at);

-- Idempotent on rows among OPEN proposals only (critic M5): a drafted plan whose runs were discarded
-- hashes back to the same books, and it must not stand in for a new proposal it can no longer draft.
CREATE UNIQUE INDEX IF NOT EXISTS payment_plan_open_hash ON payment_plan(workspace_id, inputs_hash)
  WHERE status = 'proposed';

CREATE TABLE IF NOT EXISTS payment_plan_line (
  id               TEXT PRIMARY KEY,
  plan_id          TEXT NOT NULL REFERENCES payment_plan(id),
  workspace_id     TEXT NOT NULL REFERENCES workspace(id),
  vendor_bill_id   TEXT NOT NULL REFERENCES vendor_bill(id),
  vendor_id        TEXT REFERENCES contact(id),
  -- pay | defer
  action           TEXT NOT NULL,
  -- skonto | on_time | late | defer (optimise.ts, OPTION_KINDS)
  option_kind      TEXT NOT NULL,
  pay_date         TEXT,
  arrival_date     TEXT,
  open_minor       INTEGER NOT NULL,
  cash_minor       INTEGER NOT NULL,
  skonto_minor     INTEGER NOT NULL,
  interest_minor   INTEGER NOT NULL,
  days_late        INTEGER NOT NULL,
  reason           TEXT NOT NULL,
  reason_json      TEXT NOT NULL,
  batch_id         TEXT REFERENCES payment_batch(id),
  UNIQUE (workspace_id, plan_id, vendor_bill_id)
);

CREATE INDEX IF NOT EXISTS payment_plan_line_plan ON payment_plan_line(workspace_id, plan_id);

-- A proposal is a dated record of what was computed and why: its economics never change after insert.
CREATE TRIGGER IF NOT EXISTS payment_plan_frozen
BEFORE UPDATE ON payment_plan
WHEN NEW.as_of IS NOT OLD.as_of OR NEW.horizon_end IS NOT OLD.horizon_end OR NEW.currency IS NOT OLD.currency
  OR NEW.floor_minor IS NOT OLD.floor_minor OR NEW.params_json IS NOT OLD.params_json
  OR NEW.inputs_hash IS NOT OLD.inputs_hash OR NEW.inputs_json IS NOT OLD.inputs_json
  OR NEW.objective_minor IS NOT OLD.objective_minor OR NEW.skonto_captured_minor IS NOT OLD.skonto_captured_minor
  OR NEW.late_interest_minor IS NOT OLD.late_interest_minor OR NEW.optimality IS NOT OLD.optimality
  OR NEW.upper_bound_minor IS NOT OLD.upper_bound_minor OR NEW.min_balance_minor IS NOT OLD.min_balance_minor
  OR NEW.min_balance_date IS NOT OLD.min_balance_date OR NEW.workspace_id IS NOT OLD.workspace_id
  OR NEW.idempotency_key IS NOT OLD.idempotency_key OR NEW.created_at IS NOT OLD.created_at
  OR NEW.id IS NOT OLD.id OR NEW.created_by IS NOT OLD.created_by OR NEW.base_breach_json IS NOT OLD.base_breach_json
  OR NEW.nodes_explored IS NOT OLD.nodes_explored OR NEW.late_days_lower_bound IS NOT OLD.late_days_lower_bound
  OR (OLD.status = 'drafted')
BEGIN
  SELECT RAISE(ABORT, 'payment_plan is append-only: a proposal is re-proposed, never edited');
END;

CREATE TRIGGER IF NOT EXISTS payment_plan_no_delete
BEFORE DELETE ON payment_plan
BEGIN
  SELECT RAISE(ABORT, 'payment_plan is append-only');
END;

CREATE TRIGGER IF NOT EXISTS payment_plan_line_frozen
BEFORE UPDATE ON payment_plan_line
WHEN NEW.plan_id IS NOT OLD.plan_id OR NEW.workspace_id IS NOT OLD.workspace_id
  OR NEW.vendor_bill_id IS NOT OLD.vendor_bill_id OR NEW.action IS NOT OLD.action
  OR NEW.option_kind IS NOT OLD.option_kind OR NEW.pay_date IS NOT OLD.pay_date
  OR NEW.arrival_date IS NOT OLD.arrival_date OR NEW.open_minor IS NOT OLD.open_minor
  OR NEW.cash_minor IS NOT OLD.cash_minor OR NEW.skonto_minor IS NOT OLD.skonto_minor
  OR NEW.interest_minor IS NOT OLD.interest_minor OR NEW.days_late IS NOT OLD.days_late
  OR NEW.reason IS NOT OLD.reason OR NEW.reason_json IS NOT OLD.reason_json
  OR NEW.id IS NOT OLD.id OR NEW.vendor_id IS NOT OLD.vendor_id
  OR OLD.batch_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'payment_plan_line is append-only: only its batch link fills in, once');
END;

CREATE TRIGGER IF NOT EXISTS payment_plan_line_no_delete
BEFORE DELETE ON payment_plan_line
BEGIN
  SELECT RAISE(ABORT, 'payment_plan_line is append-only');
END;
`;
