/**
 * I04, the THREE-WAY MATCH tables (Wave 14, cluster I). The DDL lives in its own module and is
 * joined into the applied schema by `core/store/schema.ts` (the A14/A19/B00/H00/I00/I02 module-owned
 * pattern), so concurrent capability branches never edit one giant string.
 *
 * These tables REFERENCE `vendor_bill` (A17), `purchase_order` + `po_line` (D02/I01) and
 * `goods_receipt_doc_line` (I02), all created earlier, so this fragment is concatenated LAST.
 *
 * Columns are snake_case; the engine and the MCP/REST faces are camelCase and map at the
 * `threeWayMatch.ts` boundary only. Money is INTEGER Rappen (P2). Quantities are whole-unit INTEGERs,
 * the D02 `po_line` convention (see the spec §0 reconciliation: NOT thousandths). Every row carries
 * `workspace_id` (§H-TENANT).
 *
 * A MATCH LINE IS ONE ROW PER PO LINE, not per bill line: an A17 bill is a header-amount document
 * with no line table (see `poShared.ts`), so the bill contributes ONE base-net figure at the header
 * (`total_billed_rappen`) and the per-line breakdown is the PO/receipt side.
 *
 * §H-AUDIT / append-only. The evaluation snapshot is stored verbatim and never rewritten. The header
 * is immutable EXCEPT the three reverse-link columns (`reversing_match_id`, `reversed_by`,
 * `reversed_at`), which may transition ONCE from NULL to a value when the match is reversed; the
 * `three_way_match_no_mutate` trigger aborts every other UPDATE. The lines are fully immutable
 * (`three_way_match_line_no_update` / `_no_delete`). A correction is a NEW `reversed` record, never a
 * destructive edit. NOTHING HERE POSTS TO THE GENERAL LEDGER (spec §3): I04 only increments
 * `po_line.billed_qty` and marks I02 receipt lines; posting stays A17 -> A02.
 */

export const THREE_WAY_MATCH_SCHEMA_SQL = `
-- I04: the three-way match header. One active (non-reversed) row per (workspace, bill), enforced by
-- the partial unique index below. status is I04's own §H-ENUM validated at the verb boundary:
--   matched    - every open line fully received and the bill value inside tolerance
--   partial    - some lines only partially received, bill value inside tolerance (allow_partial)
--   overridden - an out-of-tolerance match forced with a mandatory reason and an actor
--   reversed   - a compensating record that restores billed_qty; points at the original it reverses
CREATE TABLE IF NOT EXISTS three_way_match (
  id                     TEXT PRIMARY KEY,
  workspace_id           TEXT NOT NULL REFERENCES workspace(id),
  bill_id                TEXT NOT NULL REFERENCES vendor_bill(id),
  po_id                  TEXT NOT NULL REFERENCES purchase_order(id),
  status                 TEXT NOT NULL,
  -- The exact MatchEvaluation that was accepted, serialised verbatim (immutable): what the GUI showed
  -- and what an auditor reconstructs, so a later tolerance change never rewrites a filed decision.
  evaluation_snapshot    TEXT NOT NULL,
  -- The bill's base-net Rappen that was matched, and the summed expected value of the open quantity at
  -- PO prices. value_variance = total_billed - total_expected (the aggregate price/value leg).
  total_billed_rappen    INTEGER NOT NULL DEFAULT 0,
  total_expected_rappen  INTEGER NOT NULL DEFAULT 0,
  total_qty              INTEGER NOT NULL DEFAULT 0,
  price_variance_rappen  INTEGER NOT NULL DEFAULT 0,
  value_variance_rappen  INTEGER NOT NULL DEFAULT 0,
  reason                 TEXT,
  overridden_by          TEXT,
  overridden_at          TEXT,
  reversed_by            TEXT,
  reversed_at            TEXT,
  reversing_match_id     TEXT REFERENCES three_way_match(id),
  original_match_id      TEXT REFERENCES three_way_match(id),
  idempotency_key        TEXT,
  created_by             TEXT,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL
);

-- At most one ACTIVE match per bill: a reversed original (reversing_match_id set) and the reversing
-- record itself (status 'reversed') both drop out, so a bill can be re-matched after a reverse.
CREATE UNIQUE INDEX IF NOT EXISTS ux_three_way_match_active
  ON three_way_match (workspace_id, bill_id)
  WHERE status IN ('matched', 'partial', 'overridden') AND reversing_match_id IS NULL;

CREATE INDEX IF NOT EXISTS ix_three_way_match_bill ON three_way_match (workspace_id, bill_id);
CREATE INDEX IF NOT EXISTS ix_three_way_match_po ON three_way_match (workspace_id, po_id);

-- One row per matched PO line. The bill has no lines, so there is no bill_line_id: billed_qty is the
-- quantity this match consumed (the open received-not-billed qty), extended_po_rappen its value at the
-- PO price. qty_variance is received minus ordered (the delivery variance).
CREATE TABLE IF NOT EXISTS three_way_match_line (
  id                     TEXT PRIMARY KEY,
  workspace_id           TEXT NOT NULL REFERENCES workspace(id),
  match_id               TEXT NOT NULL REFERENCES three_way_match(id),
  po_line_id             TEXT NOT NULL REFERENCES po_line(id),
  item_id                TEXT,
  description            TEXT,
  ordered_qty            INTEGER NOT NULL,
  received_qty           INTEGER NOT NULL,
  already_billed_qty     INTEGER NOT NULL,
  billed_qty             INTEGER NOT NULL,
  unit_price_po_rappen   INTEGER NOT NULL,
  extended_po_rappen     INTEGER NOT NULL,
  qty_variance           INTEGER NOT NULL,
  -- The I02 goods_receipt_doc_line ids this match marked billed, JSON array. Best-effort provenance
  -- over the authoritative po_line.billed_qty counter (empty when receipts arrived via the D02 path).
  receipt_line_ids       TEXT NOT NULL DEFAULT '[]',
  line_status            TEXT NOT NULL,
  created_at             TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_three_way_match_line_match ON three_way_match_line (workspace_id, match_id);

-- §H-AUDIT. The header is append-only except the ONE-WAY NULL -> value transition of the three
-- reverse-link columns (and updated_at). Every other field change aborts.
CREATE TRIGGER IF NOT EXISTS three_way_match_no_mutate
BEFORE UPDATE ON three_way_match
FOR EACH ROW WHEN (
     OLD.id <> NEW.id
  OR OLD.workspace_id <> NEW.workspace_id
  OR OLD.bill_id <> NEW.bill_id
  OR OLD.po_id <> NEW.po_id
  OR OLD.status <> NEW.status
  OR OLD.evaluation_snapshot <> NEW.evaluation_snapshot
  OR OLD.total_billed_rappen <> NEW.total_billed_rappen
  OR OLD.total_expected_rappen <> NEW.total_expected_rappen
  OR OLD.total_qty <> NEW.total_qty
  OR OLD.price_variance_rappen <> NEW.price_variance_rappen
  OR OLD.value_variance_rappen <> NEW.value_variance_rappen
  OR IFNULL(OLD.reason, '') <> IFNULL(NEW.reason, '')
  OR IFNULL(OLD.overridden_by, '') <> IFNULL(NEW.overridden_by, '')
  OR IFNULL(OLD.overridden_at, '') <> IFNULL(NEW.overridden_at, '')
  OR IFNULL(OLD.original_match_id, '') <> IFNULL(NEW.original_match_id, '')
  OR IFNULL(OLD.idempotency_key, '') <> IFNULL(NEW.idempotency_key, '')
  OR IFNULL(OLD.created_by, '') <> IFNULL(NEW.created_by, '')
  OR OLD.created_at <> NEW.created_at
  OR (OLD.reversing_match_id IS NOT NULL AND OLD.reversing_match_id <> NEW.reversing_match_id)
  OR (OLD.reversed_by IS NOT NULL AND OLD.reversed_by <> NEW.reversed_by)
  OR (OLD.reversed_at IS NOT NULL AND OLD.reversed_at <> NEW.reversed_at)
)
BEGIN
  SELECT RAISE(ABORT, 'three_way_match is append-only');
END;

-- The lines are fully immutable: no UPDATE, no DELETE, ever.
CREATE TRIGGER IF NOT EXISTS three_way_match_line_no_update
BEFORE UPDATE ON three_way_match_line
BEGIN
  SELECT RAISE(ABORT, 'three_way_match_line is append-only');
END;

CREATE TRIGGER IF NOT EXISTS three_way_match_line_no_delete
BEFORE DELETE ON three_way_match_line
BEGIN
  SELECT RAISE(ABORT, 'three_way_match_line is append-only');
END;
`;
