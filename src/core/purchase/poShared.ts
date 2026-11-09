/**
 * D02 shared helpers: the commit-on-ok transaction wrapper, the row readers, and the reference
 * validators every purchasing verb reuses. Kept in one place so `purchaseOrders.ts`, `receipts.ts`,
 * `threeWayMatch.ts` and `supplierPrices.ts` share ONE definition of "read a PO", "read its lines"
 * and "is this a real supplier / item", rather than four that could drift.
 *
 * DISJOINT from A17: nothing here touches `vendor_bill` except to READ one row for the 3-way match
 * (`readBillRow`), which is a read of A17's own table through A17's own tenant scoping, never a write.
 */

import type { WorkspaceContext } from '../context.js';
import { err } from '../result.js';
import type { Result } from '../result.js';
import type { PoStatus } from './poEnums.js';

/**
 * Carries a structured `err` out of a transaction by THROWING it, so better-sqlite3 rolls the write
 * back instead of committing it. The exact C02 `quotes.ts` pattern, applied to D02 for the same
 * reason: `db.transaction(fn)` only rolls back when `fn` THROWS, so a `run` that writes and then
 * RETURNS `{ok:false}` would COMMIT the partial write while reporting failure (the C02/D03 bug class).
 */
export class TxAbort extends Error {
  constructor(readonly result: Result) {
    super('tx_abort');
  }
}

/**
 * Run a verb body inside a transaction (idempotent when a key is given) with COMMIT-ON-OK semantics.
 * When `run` returns an err, the throw rolls back BEFORE the idempotency row is written, so no rows
 * were written and a retry after the state is fixed can still succeed. This is the money-path guard
 * every D02 write rides: a REFUSED receipt or match writes ZERO rows and moves ZERO stock.
 *
 * ONE DELIBERATE EXCEPTION, and it is documented at its single call site (`matchBill`): a 3-way match
 * that lands OUTSIDE tolerance PERSISTS a `po_match` row with `status:'variance'` and returns an err
 * (spec §2 boundary: the exception must be visible, not lost). That is a COMPLETE, atomic, single-row
 * effect (it increments no `billed_qty` and moves no stock), so it is not the partial-write footgun
 * this wrapper defends against. The variance branch therefore runs its own tx directly rather than
 * through `runTx`, precisely so the "err => zero rows" invariant this wrapper enforces stays literally
 * true for every OTHER refusal.
 */
export function runTx(ctx: WorkspaceContext, verb: string, idempotencyKey: string | undefined, run: () => Result): Result {
  const guarded = (): Result => {
    const r = run();
    if (!r.ok) throw new TxAbort(r);
    return r;
  };
  try {
    return typeof idempotencyKey === 'string' && idempotencyKey.length > 0
      ? ctx.store.rememberIdempotent(ctx.workspaceId, idempotencyKey, verb, guarded)
      : ctx.store.tx(guarded);
  } catch (e) {
    if (e instanceof TxAbort) return e.result;
    throw e;
  }
}

export interface PoRow {
  id: string;
  workspace_id: string;
  number: string;
  supplier_contact_id: string;
  status: PoStatus;
  revision: number;
  currency: string;
  total_rappen: number;
  total_base_rappen: number;
  fx_rate: string | null;
  expected_on: string | null;
  sent_artifact_ref: string | null;
  note: string | null;
  // I01 provenance: the source document this PO was minted from (e.g. an I00 requisition), or NULL.
  source_document_type: string | null;
  source_document_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface PoLineRow {
  id: string;
  workspace_id: string;
  po_id: string;
  item_id: string | null;
  description: string | null;
  qty: number;
  unit_price_rappen: number;
  unit_price_base_rappen: number;
  tax_code: string | null;
  received_qty: number;
  billed_qty: number;
  project_id: string | null;
  sort: number;
}

/** One PO, §H-TENANT on the lookup. The ONE row reader every D02 verb shares. */
export function readPo(ctx: WorkspaceContext, id: unknown): PoRow | undefined {
  if (typeof id !== 'string' || id.length === 0) return undefined;
  return ctx.store.db
    .prepare('SELECT * FROM purchase_order WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, id) as PoRow | undefined;
}

/** A PO's lines in sort order, §H-TENANT. */
export function readPoLines(ctx: WorkspaceContext, poId: string): PoLineRow[] {
  return ctx.store.db
    .prepare('SELECT * FROM po_line WHERE workspace_id = ? AND po_id = ? ORDER BY sort, id')
    .all(ctx.workspaceId, poId) as PoLineRow[];
}

export interface ItemRow {
  id: string;
  name: string;
  default_tax_code: string | null;
  cost_price_minor: number | null;
  track_stock: number;
}

/** A tenant-scoped item read (the columns D02 consumes: name, default tax, cost fallback, stock flag). */
export function readItemRow(ctx: WorkspaceContext, itemId: unknown): ItemRow | undefined {
  if (typeof itemId !== 'string' || itemId.length === 0) return undefined;
  return ctx.store.db
    .prepare('SELECT id, name, default_tax_code, cost_price_minor, track_stock FROM item WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, itemId) as ItemRow | undefined;
}

/** Does a contact exist in THIS workspace (§H-TENANT)? The supplier-reference check for a PO. */
export function contactExists(ctx: WorkspaceContext, contactId: unknown): boolean {
  if (typeof contactId !== 'string' || contactId.length === 0) return false;
  const row = ctx.store.db
    .prepare('SELECT 1 FROM contact WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, contactId);
  return row !== undefined;
}

export interface BillRow {
  id: string;
  workspace_id: string;
  contact_id: string;
  currency: string;
  net_minor: number;
  base_net_minor: number | null;
  status: string;
}

/**
 * A17's `vendor_bill`, READ ONLY, §H-TENANT (spec: the bill side of the 3-way match). D02 reads the
 * bill's supplier, net and base-net; it never writes this table. `base_net_minor` is present once the
 * bill is posted (A17 reads it back off the posted entry); on a CHF draft it is NULL and the CHF
 * `net_minor` is the base amount.
 */
export function readBillRow(ctx: WorkspaceContext, billId: unknown): BillRow | undefined {
  if (typeof billId !== 'string' || billId.length === 0) return undefined;
  return ctx.store.db
    .prepare('SELECT id, workspace_id, contact_id, currency, net_minor, base_net_minor, status FROM vendor_bill WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, billId) as BillRow | undefined;
}

/** The bill's net in CHF base Rappen: the posted base net, or the CHF net for a base-currency bill. */
export function billBaseNetRappen(bill: BillRow): number | null {
  if (bill.base_net_minor !== null) return bill.base_net_minor;
  if (bill.currency === 'CHF') return bill.net_minor;
  // A foreign-currency bill not yet posted has no CHF base figure to match against.
  return null;
}

/** Shared refusal shape for a PO not found. */
export function poNotFound(poId: unknown): Result {
  return err('not_found', { poId });
}
