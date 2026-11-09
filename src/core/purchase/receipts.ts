/**
 * D02 US-D02.2: record a goods receipt (full or partial) against a sent PO. The ONE place D02 touches
 * inventory, and it does so THROUGH D01 `stock.move` (OP2, `reason:'receipt'`): D02 never writes
 * `stock_movement` itself, so there is exactly one stock path (spec §6b Fixed).
 *
 * MONEY-PATH DISCIPLINE:
 *  - Over-receipt is PRE-CHECKED before any write (`open_qty = qty - received_qty`); a refusal writes
 *    ZERO rows and moves ZERO stock (the C02/D03 tx-atomicity bug class, avoided by `runTx` + pre-check).
 *  - A D01 refusal (e.g. an invalid location) THROWS inside the tx, rolling the whole receipt back.
 *  - §H-IDEMPOTENT: a retry under the same `idempotency_key` replays the original receipt and mints NO
 *    second movement (both the `runTx` memo and each `stock.move`'s own key defend this).
 *  - The unit cost handed to D01 is the PO line's CHF BASE cost (§H-FX), so valuation stays single-currency.
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { recordStockMove } from '../stock/movements.js';
import { isPoTransitionAllowed } from './poEnums.js';
import { runTx, readPo, readPoLines, poNotFound } from './poShared.js';

export interface ReceiptLineInput {
  poLineId?: string;
  qty?: number;
}

export interface ReceiptRecordInput {
  poId?: string;
  locationId?: string;
  lines?: ReceiptLineInput[];
  note?: string | null;
  idempotencyKey?: string;
}

function locationExists(ctx: WorkspaceContext, locationId: unknown): boolean {
  if (typeof locationId !== 'string' || locationId.length === 0) return false;
  return ctx.store.db.prepare('SELECT 1 FROM stock_location WHERE workspace_id = ? AND id = ?').get(ctx.workspaceId, locationId) !== undefined;
}

export function receiptRecord(ctx: WorkspaceContext, input: ReceiptRecordInput): Result {
  const capable = ctx.capabilities.assert('manage_master_data');
  if (!capable.ok) return capable;

  // Every guard lives INSIDE `run`: a REFUSED receipt THROWS through `runTx` and rolls back to ZERO
  // rows and ZERO stock movements (the tx-atomicity law), and a retry under the same key replays the
  // original receipt rather than re-checking against the now-changed state (§H-IDEMPOTENT).
  const run = (): Result => {
    const po = readPo(ctx, input.poId);
    if (po === undefined) return poNotFound(input.poId);
    // Receiving against a draft/received/closed/cancelled PO is refused (spec §2 error): only `sent`
    // can receive. `sent -> received` is the only transition this verb may cause.
    if (po.status !== 'sent') return err('invalid_transition', { poId: po.id, status: po.status });
    if (!locationExists(ctx, input.locationId)) return err('invalid_reference', { locationId: input.locationId });

    const byId = new Map(readPoLines(ctx, po.id).map((l) => [l.id, l]));
    const requested = input.lines ?? [];
    if (requested.length === 0) return err('invalid_input', { field: 'lines' });

    // PRE-CHECK EVERY LINE before any write (over-receipt, unknown line, bad qty): a refusal throws
    // (via runTx) so NO row is written and NO stock moves.
    for (const rl of requested) {
      const line = typeof rl.poLineId === 'string' ? byId.get(rl.poLineId) : undefined;
      if (line === undefined) return err('invalid_reference', { poLineId: rl.poLineId });
      if (typeof rl.qty !== 'number' || !Number.isInteger(rl.qty) || rl.qty <= 0) return err('invalid_qty', { qty: rl.qty });
      const openQty = line.qty - line.received_qty;
      if (rl.qty > openQty) return err('over_receipt', { poLineId: line.id, openQty });
    }

    const locationId = input.locationId as string;
    const receiptId = ctx.ids.next('rcpt');
    const now = ctx.clock.now();
    ctx.store.db
      .prepare('INSERT INTO goods_receipt (id, workspace_id, po_id, location_id, received_at, note, idempotency_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(receiptId, ctx.workspaceId, po.id, locationId, now.slice(0, 10), input.note ?? null, input.idempotencyKey ?? null, now);

    const movements: string[] = [];
    const receiptLines: { poLineId: string; qty: number; stockMovementId: string | null }[] = [];
    for (const rl of requested) {
      const line = byId.get(rl.poLineId as string)!;
      const qty = rl.qty as number;
      let stockMovementId: string | null = null;
      const item = line.item_id;
      // Mint a D01 movement ONLY for a stock-tracked item line; a free-text or non-tracked line is
      // recorded for the trail but has nothing to move (spec §2: "for every stock-tracked item").
      let tracked = false;
      if (item !== null) {
        const row = ctx.store.db.prepare('SELECT track_stock FROM item WHERE workspace_id = ? AND id = ?').get(ctx.workspaceId, item) as { track_stock: number } | undefined;
        tracked = row !== undefined && row.track_stock === 1;
      }
      if (tracked && item !== null) {
        const moveKey = typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0 ? `${input.idempotencyKey}#${line.id}` : ctx.ids.next('mvkey');
        const moved = recordStockMove(ctx, {
          itemId: item,
          locationId,
          qty,
          reason: 'receipt',
          unitCostMinor: line.unit_price_base_rappen,
          refKind: 'po',
          refId: po.id,
          idempotencyKey: moveKey,
        });
        // A D01 refusal rolls the WHOLE receipt back (throw => tx rollback), never a partial receipt.
        if (!moved.ok) return moved;
        const mv = (moved as unknown as { movements: { id: string }[] }).movements;
        stockMovementId = mv[0]?.id ?? null;
        if (stockMovementId !== null) movements.push(stockMovementId);
      }
      ctx.store.db
        .prepare('INSERT INTO goods_receipt_line (id, workspace_id, receipt_id, po_line_id, qty, stock_movement_id) VALUES (?, ?, ?, ?, ?, ?)')
        .run(ctx.ids.next('rcptl'), ctx.workspaceId, receiptId, line.id, qty, stockMovementId);
      ctx.store.db
        .prepare('UPDATE po_line SET received_qty = received_qty + ? WHERE workspace_id = ? AND id = ?')
        .run(qty, ctx.workspaceId, line.id);
      receiptLines.push({ poLineId: line.id, qty, stockMovementId });
    }

    // Transition sent -> received when EVERY line is now fully received (spec §2).
    const after = readPoLines(ctx, po.id);
    const fullyReceived = after.every((l) => l.received_qty >= l.qty);
    if (fullyReceived && isPoTransitionAllowed('sent', 'received')) {
      ctx.store.db.prepare("UPDATE purchase_order SET status = 'received', updated_at = ? WHERE workspace_id = ? AND id = ?").run(now, ctx.workspaceId, po.id);
    }

    return ok({
      receipt: { id: receiptId, poId: po.id, locationId, lines: receiptLines },
      movements,
      poStatus: fullyReceived ? 'received' : 'sent',
      ...(fullyReceived ? { receivedPoId: po.id } : {}),
    });
  };

  return runTx(ctx, 'receipt_record', input.idempotencyKey, run);
}
