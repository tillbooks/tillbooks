/**
 * I00, the REQUISITION tables: the controlled internal-demand document that opens the procure-to-pay
 * chain (requisition -> D02 purchase order -> goods receipt -> vendor bill). Wave 14, cluster I root.
 *
 * The DDL sits in its own module and is joined into the applied schema by `core/store/schema.ts`
 * (the A14/A19/B00/H00 module-owned pattern), so concurrent capability branches never edit one giant
 * string. Columns are snake_case; the engine and MCP/REST interfaces are camelCase and map at the
 * `requisition.ts` boundary only. Money is stored as INTEGER Rappen and quantity as INTEGER milli-units
 * (1000 = one whole unit), never a float (P2). Every row carries `workspace_id` (§H-TENANT).
 *
 * PLAIN OPERATIONAL DOCUMENT, no money path: nothing here posts a journal entry and nothing emits an
 * outward artifact. A requisition's estimated costs are operational estimates only; VAT and the ledger
 * arise later on the vendor bill (A17 -> A02). The approval trail and the conversion links are
 * INSERT-ONLY (§H-AUDIT): a decision or a conversion is a new row, never a rewrite of an old one.
 *
 * The three GL-free references (item, cost centre, project, preferred supplier) point into the tables
 * D00/A01/B00/C00 own, so a requisition can never name a row that does not exist, and those modules'
 * archive/delete guards see the requisition line as a live reference.
 */

export const PROCUREMENT_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS requisition (
  id                     TEXT PRIMARY KEY,
  workspace_id           TEXT NOT NULL REFERENCES workspace(id),
  number                 TEXT NOT NULL,
  -- The controlled lifecycle state (§H-ENUM: draft | pending_approval | approved | rejected |
  -- partially_converted | converted | cancelled | closed). Enforced by the engine against
  -- REQUISITION_STATUSES, not a CHECK, so a later status can be added in one place (the §D0 convention).
  status                 TEXT NOT NULL,
  requester_id           TEXT NOT NULL,
  needed_by              TEXT NOT NULL,
  -- §H-ENUM: normal | high | critical. Affects policy routing and visual priority only.
  urgency                TEXT NOT NULL,
  cost_center_id         TEXT REFERENCES cost_center(id),
  project_id             TEXT REFERENCES project(id),
  description            TEXT,
  currency               TEXT NOT NULL,
  -- The pure sum of the line estimated totals, in base-currency Rappen; recomputed on every line
  -- upsert and NEVER edited by hand (§4 money correctness).
  total_estimated_rappen INTEGER NOT NULL DEFAULT 0,
  created_at             TEXT NOT NULL,
  created_by             TEXT,
  updated_at             TEXT NOT NULL,
  submitted_at           TEXT,
  approved_at            TEXT,
  closed_at              TEXT
);

CREATE TABLE IF NOT EXISTS requisition_line (
  id                          TEXT PRIMARY KEY,
  workspace_id                TEXT NOT NULL REFERENCES workspace(id),
  requisition_id              TEXT NOT NULL REFERENCES requisition(id),
  line_no                     INTEGER NOT NULL,
  item_id                     TEXT REFERENCES item(id),
  description                 TEXT NOT NULL,
  -- INTEGER milli-units, strictly > 0 (enforced in the verb). One whole unit is 1000.
  qty_milli                   INTEGER NOT NULL,
  uom                         TEXT,
  estimated_unit_cost_rappen  INTEGER NOT NULL,
  -- trunc(qty_milli * estimated_unit_cost_rappen / 1000), exact integer arithmetic (§4).
  estimated_total_rappen      INTEGER NOT NULL,
  preferred_supplier_id       TEXT REFERENCES contact(id),
  -- 0..qty_milli, maintained ONLY by requisition_convert_to_po. open = qty_milli - converted_qty_milli.
  converted_qty_milli         INTEGER NOT NULL DEFAULT 0
);

-- The append-only approval trail (§H-AUDIT). A submit, an auto-approve, an approve, a reject and a
-- return are each a new row; nothing here is ever updated or deleted, so the full decision history of
-- a requisition (across re-submission cycles) is always reconstructable.
CREATE TABLE IF NOT EXISTS requisition_approval_event (
  id             TEXT PRIMARY KEY,
  workspace_id   TEXT NOT NULL REFERENCES workspace(id),
  requisition_id TEXT NOT NULL REFERENCES requisition(id),
  task_id        TEXT,
  actor_id       TEXT,
  -- §H-ENUM: submitted | auto_approved | approved | rejected | returned.
  decision       TEXT NOT NULL,
  comment        TEXT,
  created_at     TEXT NOT NULL
);

-- The open approval tasks a pending requisition materialises at submit. A task is COMPLETED, CANCELLED
-- or stays OPEN; the requisition becomes approved when no open task remains. Not append-only (its
-- status changes), but every decision that changes it also writes an approval_event, which is.
CREATE TABLE IF NOT EXISTS requisition_approval_task (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspace(id),
  requisition_id      TEXT NOT NULL REFERENCES requisition(id),
  -- The A24 capability whose holder may decide this task (the role/user routing OP17 would resolve).
  required_capability TEXT NOT NULL,
  -- §H-ENUM: open | completed | cancelled.
  status              TEXT NOT NULL,
  step_no             INTEGER NOT NULL,
  created_at          TEXT NOT NULL,
  decided_at          TEXT,
  decided_by          TEXT
);

-- The immutable conversion link (§H-AUDIT): one row per requisition_convert_to_po call, recording the
-- D02 purchase order the selected quantities flowed into. Its line detail lives in the child table
-- below, so an auditor can retrace exactly which requisition units became which PO.
CREATE TABLE IF NOT EXISTS requisition_conversion (
  id               TEXT PRIMARY KEY,
  workspace_id     TEXT NOT NULL REFERENCES workspace(id),
  requisition_id   TEXT NOT NULL REFERENCES requisition(id),
  purchase_order_id TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  created_by       TEXT
);

CREATE TABLE IF NOT EXISTS requisition_conversion_line (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspace(id),
  conversion_id       TEXT NOT NULL REFERENCES requisition_conversion(id),
  requisition_line_id TEXT NOT NULL REFERENCES requisition_line(id),
  qty_milli           INTEGER NOT NULL
);

-- §H-TENANT + the status filter the Einkauf list and the approval inbox both read.
CREATE INDEX IF NOT EXISTS requisition_workspace_status
ON requisition (workspace_id, status);

-- The reverse lookup "the lines of requisition X", read on every get/convert.
CREATE INDEX IF NOT EXISTS requisition_line_by_requisition
ON requisition_line (workspace_id, requisition_id);

-- The approval inbox read: the open tasks a workspace still owes a decision on.
CREATE INDEX IF NOT EXISTS requisition_task_open
ON requisition_approval_task (workspace_id, status);
`;
