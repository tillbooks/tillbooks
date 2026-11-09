/**
 * D02 US-D02.3: the 3-way match. Compares, in CHF base Rappen, the value of goods RECEIVED-but-not-yet-
 * billed at the PO's own line prices against the A17 vendor bill's base net, within a FIXED tolerance
 * (spec §6b). D02 posts NOTHING: the bill's expense/inventory + Vorsteuer posting is A17->A02, and this
 * verb stores only the A17 `bill_id` link. Traceability to the ledger runs through the journal entry
 * A17's post produced (OR 957a Belegnachweis).
 *
 * WHY THE BILL SIDE IS AN AMOUNT, NOT LINES (reconciled 2026-08-04): an A17 `vendor_bill` is a
 * header-amount document with no line table, so the bill contributes one net figure. The qty leg of the
 * three-way (ordered vs received) lives on `po_line.received_qty`; the price leg is this tolerance check.
 *
 * MONEY-PATH INVARIANTS THIS VERB ENFORCES:
 *  - NO OVER-MATCH: a match consumes exactly the received-not-billed qty (`billed_qty += received_qty -
 *    billed_qty`), so `billed_qty` can never exceed `received_qty` by construction.
 *  - NO DOUBLE-CONSUME: the SAME bill cannot be matched to the SAME PO twice (`already_matched`), and a
 *    retry under one `idempotency_key` replays (the matched path rides `runTx`; the variance path is
 *    idempotent on the existing `(po_id, bill_id)` variance row).
 *  - §H-TENANT: PO, bill and every write are workspace-scoped; a cross-tenant bill/PO is refused.
 *  - TX-ATOMICITY: every genuine refusal (bad supplier, nothing received, already matched, wrong state)
 *    is pre-checked and writes ZERO rows. The variance branch is the ONE documented persist-then-err
 *    (spec §2 boundary demands the exception be visible): it writes exactly ONE `po_match` row, mints no
 *    stock and increments no `billed_qty`, so it is a complete atomic effect, not a partial write.
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { toleranceRappenFor } from './poEnums.js';
import type { MatchStatus } from './poEnums.js';
import { runTx, readPo, readPoLines, readBillRow, billBaseNetRappen, poNotFound } from './poShared.js';

export interface MatchBillInput {
  poId?: string;
  billId?: string;
  override?: boolean;
  idempotencyKey?: string;
}

function existingVariance(ctx: WorkspaceContext, poId: string, billId: string): { id: string } | undefined {
  return ctx.store.db
    .prepare("SELECT id FROM po_match WHERE workspace_id = ? AND po_id = ? AND bill_id = ? AND status = 'variance' ORDER BY created_at DESC LIMIT 1")
    .get(ctx.workspaceId, poId, billId) as { id: string } | undefined;
}

function alreadyMatched(ctx: WorkspaceContext, poId: string, billId: string): boolean {
  return (
    ctx.store.db
      .prepare("SELECT 1 FROM po_match WHERE workspace_id = ? AND po_id = ? AND bill_id = ? AND status IN ('matched','overridden') LIMIT 1")
      .get(ctx.workspaceId, poId, billId) !== undefined
  );
}

export function matchBill(ctx: WorkspaceContext, input: MatchBillInput): Result {
  // Base gate: recording a match is a master-data control activity.
  const capable = ctx.capabilities.assert('manage_master_data');
  if (!capable.ok) return capable;

  // §H-IDEMPOTENT: a stored SUCCESS (a matched/overridden result) replays BEFORE any guard re-runs,
  // so a retry after the PO has already closed does not reject with `already_matched`/`invalid_transition`.
  // The variance branch below is deliberately NOT memoised (it returns an err), so it never lands here;
  // its own replay-safety is the `existingVariance` check.
  const key = input.idempotencyKey;
  if (typeof key === 'string' && key.length > 0) {
    const prior = ctx.store.recallIdempotent<Result>(ctx.workspaceId, key, 'match_bill');
    if (prior !== undefined) return prior;
  }

  const override = input.override === true;
  // The override is a stronger, money-authority judgment (approving a variance on Vorsteuer-bearing
  // goods): it additionally requires `post`, the same capability A17 gates its bill posting on, so a
  // routine matcher cannot force a variance through. `match_bill` is also denylisted from automation
  // (tripwire #3), so no rule or plugin action can ever reach this branch.
  if (override) {
    const canOverride = ctx.capabilities.assert('post');
    if (!canOverride.ok) return canOverride;
  }

  const po = readPo(ctx, input.poId);
  if (po === undefined) return poNotFound(input.poId);
  const bill = readBillRow(ctx, input.billId);
  if (bill === undefined) return err('invalid_reference', { billId: input.billId });
  // The bill's supplier must be the PO's supplier (spec §2 error).
  if (bill.contact_id !== po.supplier_contact_id) return err('invalid_reference', { billId: bill.id, reason: 'supplier_mismatch' });
  // Matching needs receipts: a 2-way PO<->bill match is explicitly not silently substituted.
  if (po.status !== 'sent' && po.status !== 'received') return err('invalid_transition', { poId: po.id, status: po.status });
  // The same bill cannot be matched to the same PO twice (no double-consume across bills).
  if (alreadyMatched(ctx, po.id, bill.id)) return err('already_matched', { poId: po.id, billId: bill.id });

  const lines = readPoLines(ctx, po.id);
  const openBillable = lines.map((l) => ({ line: l, qty: Math.max(0, l.received_qty - l.billed_qty) }));
  const expectedBase = openBillable.reduce((sum, o) => sum + o.qty * o.line.unit_price_base_rappen, 0);
  const consumedQty = openBillable.reduce((sum, o) => sum + o.qty, 0);
  if (consumedQty === 0) return err('nothing_received', { poId: po.id });

  const billBase = billBaseNetRappen(bill);
  if (billBase === null) return err('bill_not_convertible', { billId: bill.id, reason: 'foreign_currency_unposted' });

  // The qty leg (delivered vs ordered), stored for the audit record; <= 0 for a normal (non-over) delivery.
  const qtyVariance = lines.reduce((sum, l) => sum + (l.received_qty - l.qty), 0);
  const priceVariance = billBase - expectedBase;
  const tolerance = toleranceRappenFor(expectedBase);
  const within = Math.abs(priceVariance) <= tolerance;

  // --- The variance branch: persist the exception and return err (spec §2 boundary) ------------
  if (!within && !override) {
    const existing = existingVariance(ctx, po.id, bill.id);
    if (existing !== undefined) {
      // Idempotent: a re-attempt does not stack a second variance row; the exception is already visible.
      return err('variance_exceeded', {
        poId: po.id,
        billId: bill.id,
        matchId: existing.id,
        expectedBaseRappen: expectedBase,
        billBaseRappen: billBase,
        priceVarianceRappen: priceVariance,
        toleranceRappen: tolerance,
      });
    }
    const matchId = ctx.ids.next('pomatch');
    ctx.store.tx(() => {
      insertMatch(ctx, matchId, po.id, bill.id, 'variance', qtyVariance, priceVariance, expectedBase, billBase, null);
    });
    return err('variance_exceeded', {
      poId: po.id,
      billId: bill.id,
      matchId,
      expectedBaseRappen: expectedBase,
      billBaseRappen: billBase,
      priceVarianceRappen: priceVariance,
      toleranceRappen: tolerance,
    });
  }

  // --- The match branch: consume received-not-billed qty, link the bill, maybe close the PO --------
  const status: MatchStatus = within ? 'matched' : 'overridden';
  const run = (): Result => {
    const matchId = ctx.ids.next('pomatch');
    insertMatch(ctx, matchId, po.id, bill.id, status, qtyVariance, priceVariance, expectedBase, billBase, status === 'overridden' ? ctx.actor : null);
    for (const o of openBillable) {
      if (o.qty > 0) {
        ctx.store.db.prepare('UPDATE po_line SET billed_qty = billed_qty + ? WHERE workspace_id = ? AND id = ?').run(o.qty, ctx.workspaceId, o.line.id);
      }
    }
    // Fully billed => received -> closed (the invoiced/closed transition). Every line billed to its
    // ordered qty means fully received AND fully billed. Note received_qty can EXCEED qty since I02
    // accepts and flags an over-delivery rather than refusing it, so the old `billed_qty <=
    // received_qty <= qty` chain no longer holds; `billed_qty >= qty` is the test, and it is the one
    // used below.
    const after = readPoLines(ctx, po.id);
    const fullyBilled = after.every((l) => l.billed_qty >= l.qty);
    let closed = false;
    if (fullyBilled && po.status === 'received') {
      ctx.store.db.prepare("UPDATE purchase_order SET status = 'closed', updated_at = ? WHERE workspace_id = ? AND id = ?").run(ctx.clock.now(), ctx.workspaceId, po.id);
      closed = true;
    }
    return ok({
      match: {
        id: matchId,
        poId: po.id,
        billId: bill.id,
        status,
        qtyVariance,
        priceVarianceRappen: priceVariance,
        expectedBaseRappen: expectedBase,
        billBaseRappen: billBase,
      },
      matched: true,
      poStatus: closed ? 'closed' : po.status,
      ...(closed ? { closedPoId: po.id } : {}),
    });
  };

  return runTx(ctx, 'match_bill', input.idempotencyKey, run);
}

function insertMatch(
  ctx: WorkspaceContext,
  id: string,
  poId: string,
  billId: string,
  status: MatchStatus,
  qtyVariance: number,
  priceVariance: number,
  expectedBase: number,
  billBase: number,
  overriddenBy: string | null,
): void {
  const now = ctx.clock.now();
  ctx.store.db
    .prepare(
      `INSERT INTO po_match (id, workspace_id, po_id, bill_id, status, qty_variance, price_variance_rappen, expected_base_rappen, bill_base_rappen, overridden_by, matched_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, ctx.workspaceId, poId, billId, status, qtyVariance, priceVariance, expectedBase, billBase, overriddenBy, now, now);
}
