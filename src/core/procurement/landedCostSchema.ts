/**
 * I03, the LANDED-COST VOUCHER tables (Wave 14, cluster I, MONEY PATH by way of J02 + A02).
 *
 * The DDL sits in its own module and is joined into the applied schema by `core/store/schema.ts`
 * (the I02 `receiptSchema` / J02 `movementSchema` module-owned pattern), so concurrent capability
 * branches never edit one giant string. Columns are snake_case; the engine and MCP/REST interfaces
 * are camelCase and map at the `landed_cost.ts` boundary only. Money is INTEGER Rappen and quantity
 * is a whole-unit INTEGER (the D02 / J02 convention). Every row carries `workspace_id` (§H-TENANT).
 *
 * WHERE THE MONEY ACTUALLY LIVES. These three tables are the DOCUMENT: what costs were collected,
 * against which receipt lines, and how the total split. The authoritative money effects are NOT here.
 * The inventory value change is a J02 `landed_cost` movement per target (append-only, immutable by the
 * movement triggers), and the GL reclassification is ONE A02 `postEntry` (append-only, immutable by
 * the journal triggers). The voucher stores the ids of both so the trail is reconstructable, but the
 * source of truth for "what did this do to the books" is always the movement and the journal, never a
 * figure copied onto the header. That is why the header carries no inventory-value column: it would be
 * a second copy of a number J03 already derives from the movements.
 *
 * The status machine (P7): `draft -> allocated -> reversed`. A draft has no movements and no journal;
 * `allocate_confirm` writes both and moves it to `allocated`; `reverse` writes the compensating
 * movements and journal and moves it to `reversed`. The transitions are validated at the verb
 * boundary (the D02/I02/J02 convention), never by a CHECK constraint.
 */

export const LANDED_COST_SCHEMA_SQL = `
-- I03: the landed-cost voucher header. status is I03's own §H-ENUM, validated at the verb boundary.
-- total_cost_minor is the workspace-currency total (sum of the cost lines' base amounts), the figure
-- the pure allocator distributes. inventory_account_id / clearing_account_id are the two GL accounts
-- the confirm posts between (Dr inventory control, Cr landed-cost clearing / accrued costs), stored on
-- the voucher so the reversal posts the exact mirror. journal_entry_id / reverse_journal_entry_id link
-- the A02 entries; neither is ever the source of a figure, only a pointer into the immutable ledger.
CREATE TABLE IF NOT EXISTS landed_cost_voucher (
  id                      TEXT PRIMARY KEY,
  workspace_id            TEXT NOT NULL REFERENCES workspace(id),
  number                  TEXT NOT NULL,
  -- draft | allocated | reversed
  status                  TEXT NOT NULL,
  is_estimated            INTEGER NOT NULL DEFAULT 0,
  currency                TEXT NOT NULL,
  fx_rate                 TEXT,
  total_cost_minor        INTEGER NOT NULL,
  allocation_method       TEXT NOT NULL,
  source_bill_ids         TEXT,
  inventory_account_id    TEXT NOT NULL REFERENCES account(id),
  clearing_account_id     TEXT NOT NULL REFERENCES account(id),
  -- I03 variance seam: the account the NON-capitalizable share is expensed to (issued units' landed
  -- cost, and a standard-cost item's whole landed cost, which J03 never carries onto inventory), and
  -- the workspace policy that governs it. variance_policy is 'expense_excess' (default) or 'strict'.
  -- capitalized_minor / variance_minor record the split the confirm actually posted, so the reverse
  -- posts the EXACT mirror rather than recomputing a figure that intervening issues would have moved.
  variance_account_id     TEXT REFERENCES account(id),
  variance_policy         TEXT,
  capitalized_minor       INTEGER,
  variance_minor          INTEGER,
  effective_date          TEXT NOT NULL,
  journal_entry_id        TEXT REFERENCES journal_entry(id),
  reverse_journal_entry_id TEXT REFERENCES journal_entry(id),
  notes                   TEXT,
  created_at              TEXT NOT NULL,
  created_by              TEXT,
  allocated_at            TEXT,
  allocated_by            TEXT,
  reversed_at             TEXT,
  reversed_by             TEXT,
  reverse_reason          TEXT,
  idempotency_key         TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS landed_cost_voucher_number ON landed_cost_voucher (workspace_id, number);
CREATE INDEX IF NOT EXISTS landed_cost_voucher_by_status ON landed_cost_voucher (workspace_id, status, effective_date);

-- I03: one cost component of a voucher (freight, duty, insurance, ...). amount_minor is the original
-- currency amount; amount_base_minor is the workspace-currency amount after the voucher FX rate (equal
-- to amount_minor for a base-currency voucher). The allocator distributes the sum of amount_base_minor.
CREATE TABLE IF NOT EXISTS landed_cost_line (
  id               TEXT PRIMARY KEY,
  workspace_id     TEXT NOT NULL REFERENCES workspace(id),
  voucher_id       TEXT NOT NULL REFERENCES landed_cost_voucher(id),
  component_type   TEXT NOT NULL,
  description      TEXT,
  amount_minor     INTEGER NOT NULL,
  amount_base_minor INTEGER NOT NULL,
  vendor_id        TEXT REFERENCES contact(id),
  tax_code_id      TEXT,
  created_at       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS landed_cost_line_by_voucher ON landed_cost_line (workspace_id, voucher_id);

-- I03: one allocation target (a goods-receipt line and the J02 receipt movement it minted).
-- base_value_minor = base_qty x the receipt unit cost, the by_value weight. allocated_minor and
-- unit_impact_minor are set at confirm; movement_id names the J02 landed_cost movement written for this
-- target, and reversal_movement_id the one written when the voucher is reversed. The movements are the
-- source of truth for what reached inventory; these columns are the fast lookup back to them.
CREATE TABLE IF NOT EXISTS landed_cost_target (
  id                    TEXT PRIMARY KEY,
  workspace_id          TEXT NOT NULL REFERENCES workspace(id),
  voucher_id            TEXT NOT NULL REFERENCES landed_cost_voucher(id),
  goods_receipt_line_id TEXT NOT NULL REFERENCES goods_receipt_doc_line(id),
  item_id               TEXT NOT NULL REFERENCES item(id),
  original_movement_id  TEXT NOT NULL REFERENCES stock_movement(id),
  location_id           TEXT NOT NULL REFERENCES stock_location(id),
  base_qty              INTEGER NOT NULL,
  base_value_minor      INTEGER NOT NULL,
  weight_milli          INTEGER,
  volume_milli          INTEGER,
  allocated_minor       INTEGER NOT NULL DEFAULT 0,
  unit_impact_minor     INTEGER NOT NULL DEFAULT 0,
  movement_id           TEXT REFERENCES stock_movement(id),
  reversal_movement_id  TEXT REFERENCES stock_movement(id),
  created_at            TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS landed_cost_target_by_voucher ON landed_cost_target (workspace_id, voucher_id);
CREATE INDEX IF NOT EXISTS landed_cost_target_by_gr_line ON landed_cost_target (workspace_id, goods_receipt_line_id);
`;
