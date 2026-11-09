/**
 * D01 valuation: REPORT-ONLY (K68). It computes the full inventory value from the OP2 movement ledger
 * (FIFO layers or moving weighted-average) and records a `stock_valuation_run` row, but it NEVER mints
 * a journal entry. J06 (`inventory_valuation_post`, src/core/inventory/reconciliation.ts) is the SOLE
 * authoritative path inventory value reaches the General Ledger; running D01 as well would post the
 * value a second time and roughly double the Vorräte asset (the K68 double-count). The returned Result
 * still carries the computed total and the delta against D01's own last run, so the report and its
 * history are intact, but `postedEntryId` / `reversedEntryId` are always null.
 *
 * THE MONEY-PATH LAWS, enforced here and asserted in `test/stock/invariants.test.mjs`, hold over what
 * D01 STILL does (compute a figure, write a run row): D01 posts to no ledger account.
 *   - APPEND-ONLY / §H-AUDIT: a re-run at the same `as_of` supersedes the prior run row (active = 0)
 *     and writes a fresh one; the prior row is never edited or deleted. No journal entry, no reversal.
 *   - §H-IDEMPOTENT: a replay of the same `idempotencyKey` returns the cached run and writes nothing.
 *   - §H-PERIOD: an `as_of` in a soft/hard-closed period is refused with `period_locked` BEFORE the
 *     run row is written, so nothing is left half-written.
 *   - §H-TENANT: every read and write scopes by `workspace_id`.
 *
 * Money is integer Rappen (P2); the weighted-average per-unit cost is rounded ONCE, at the single
 * division below, so there is no float drift (property-tested). A capitalised `landed_cost` movement
 * (qty 0, a signed `cost_amount_minor`) folds its lump into the item value, mirroring J03's `tally`.
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { isValuationMethod } from './enums.js';
import type { ValuationMethod } from './enums.js';

interface RunRow {
  id: string;
  method: string;
  as_of: string;
  total_value_minor: number;
  baseline_value_minor: number;
  delta_minor: number;
  posted_entry_id: string | null;
  reversed_entry_id: string | null;
  active: number;
  idempotency_key: string;
}

interface MovementRow {
  qty: number;
  unit_cost_minor: number | null;
  moved_at: string;
  created_at: string;
  id: string;
  movement_type: string | null;
  cost_amount_minor: number | null;
}

export interface ItemValue {
  itemId: string;
  itemName: string;
  qty: number;
  unitCostMinor: number;
  valueMinor: number;
  lowerOfCostOrMarket: boolean;
}

/**
 * The full inventory value at `asOf` per method, in integer Rappen. Each item's cost basis is its
 * receipt `unit_cost_minor`, falling back to the item's D00 `cost_price_minor` when a receipt carried
 * none. Negative on-hand (allowed only under `allowNegative`) floors the item value at zero: a
 * short position has no positive book value under OR 960c prudence.
 */
export function computeInventoryValue(
  ctx: WorkspaceContext,
  method: ValuationMethod,
  asOf: string,
): { totalMinor: number; perItem: ItemValue[] } {
  const items = ctx.store.db
    .prepare(
      `SELECT DISTINCT i.id AS id, i.name AS name, i.cost_price_minor AS cost
         FROM item i
         JOIN stock_movement m ON m.item_id = i.id
        WHERE i.workspace_id = ? AND m.moved_at <= ?
        ORDER BY i.name`,
    )
    .all(ctx.workspaceId, asOf) as { id: string; name: string; cost: number | null }[];

  const perItem: ItemValue[] = [];
  let totalMinor = 0;

  for (const item of items) {
    const movements = ctx.store.db
      .prepare(
        `SELECT qty, unit_cost_minor, moved_at, created_at, id, movement_type, cost_amount_minor
           FROM stock_movement
          WHERE workspace_id = ? AND item_id = ? AND moved_at <= ?
          ORDER BY moved_at, created_at, id`,
      )
      .all(ctx.workspaceId, item.id, asOf) as MovementRow[];
    const fallbackCost = item.cost ?? 0;

    // I03 landed cost: a `landed_cost` movement (qty 0) carries a signed `cost_amount_minor` that
    // capitalises onto the goods WITHOUT moving quantity. Mirroring J03's `tally`, the signed lump is
    // folded into the item value; a reverse (negative amount) nets straight back out. The quantity
    // engines below skip it (its qty is 0 anyway), so it never disturbs a layer or the moving average.
    let landedMinor = 0;
    for (const m of movements) {
      if (m.movement_type === 'landed_cost') landedMinor += m.cost_amount_minor ?? 0;
    }

    let qty: number;
    let valueMinor: number;
    if (method === 'fifo') {
      const layers: { qty: number; cost: number }[] = [];
      for (const m of movements) {
        if (m.movement_type === 'landed_cost') continue;
        if (m.qty > 0) {
          layers.push({ qty: m.qty, cost: m.unit_cost_minor ?? fallbackCost });
        } else {
          let toConsume = -m.qty;
          while (toConsume > 0 && layers.length > 0) {
            const layer = layers[0] as { qty: number; cost: number };
            const take = Math.min(layer.qty, toConsume);
            layer.qty -= take;
            toConsume -= take;
            if (layer.qty === 0) layers.shift();
          }
        }
      }
      qty = layers.reduce((s, l) => s + l.qty, 0);
      valueMinor = layers.reduce((s, l) => s + l.qty * l.cost, 0);
    } else {
      let runQty = 0;
      let runValue = 0;
      for (const m of movements) {
        if (m.movement_type === 'landed_cost') continue;
        if (m.qty > 0) {
          runQty += m.qty;
          runValue += m.qty * (m.unit_cost_minor ?? fallbackCost);
        } else {
          // The SINGLE rounding point (P2): the moving average is rounded once here and nowhere else.
          const avg = runQty > 0 ? Math.round(runValue / runQty) : 0;
          const consume = Math.min(-m.qty, runQty);
          runValue -= consume * avg;
          runQty -= consume;
          if (runQty <= 0) {
            runQty = 0;
            runValue = 0;
          }
        }
      }
      qty = Math.max(runQty, 0);
      valueMinor = Math.max(runValue, 0);
    }

    // Fold the capitalised landed cost onto the goods-derived value, then floor at zero (OR 960c
    // prudence): a net position with no positive book value carries none even after a landed reverse.
    valueMinor = Math.max(valueMinor + landedMinor, 0);

    const unitCostMinor = qty > 0 ? Math.round(valueMinor / qty) : 0;
    perItem.push({
      itemId: item.id,
      itemName: item.name,
      qty,
      unitCostMinor,
      valueMinor,
      // OR 960c lower-of-cost-or-market: TILL has no market feed, so the clamp is at cost and a
      // write-down below it is a manual A02 adjustment (spec §3). The flag is always false today and
      // is the seam a market source hangs off; the report surfaces it.
      lowerOfCostOrMarket: false,
    });
    totalMinor += valueMinor;
  }

  return { totalMinor, perItem };
}

/** The active run the ledger currently reflects, or undefined before the first run. */
function activeRun(ctx: WorkspaceContext): RunRow | undefined {
  return ctx.store.db
    .prepare(
      `SELECT id, method, as_of, total_value_minor, baseline_value_minor, delta_minor,
              posted_entry_id, reversed_entry_id, active, idempotency_key
         FROM stock_valuation_run
        WHERE workspace_id = ? AND active = 1
        ORDER BY as_of DESC, created_at DESC
        LIMIT 1`,
    )
    .get(ctx.workspaceId) as RunRow | undefined;
}

function runResult(row: RunRow, methodChanged: boolean): Result {
  return ok({
    runId: row.id,
    method: row.method,
    asOf: row.as_of,
    totalValueMinor: row.total_value_minor,
    baselineValueMinor: row.baseline_value_minor,
    deltaMinor: row.delta_minor,
    postedEntryId: row.posted_entry_id,
    reversedEntryId: row.reversed_entry_id,
    methodChanged,
  });
}

export interface RunValuationInput {
  method?: string;
  asOf?: string;
  idempotencyKey?: string;
}

export function runValuation(ctx: WorkspaceContext, input: RunValuationInput): Result {
  // REPORT-ONLY (K68): this computes the figure and records a run row, but posts NO journal entry.
  // J06 (`inventory_valuation_post`) is the sole path inventory value reaches the ledger.
  if (!isValuationMethod(input.method)) return err('invalid_input', { field: 'method' });
  const method = input.method;
  if (typeof input.asOf !== 'string' || input.asOf.length < 10) return err('invalid_input', { field: 'asOf' });
  const asOf = input.asOf.slice(0, 10);
  if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length === 0) {
    return err('invalid_input', { field: 'idempotencyKey' });
  }

  // §H-IDEMPOTENT: a replay returns the cached run and writes nothing.
  const cached = ctx.store.db
    .prepare(
      `SELECT id, method, as_of, total_value_minor, baseline_value_minor, delta_minor,
              posted_entry_id, reversed_entry_id, active, idempotency_key
         FROM stock_valuation_run WHERE workspace_id = ? AND idempotency_key = ?`,
    )
    .get(ctx.workspaceId, input.idempotencyKey) as RunRow | undefined;
  if (cached !== undefined) return runResult(cached, false);

  // §H-PERIOD, checked BEFORE the run row is written so a locked target leaves nothing half-written.
  const periodOpen = ctx.periods.assertOpen(asOf);
  if (!periodOpen.ok) return periodOpen;

  const current = computeInventoryValue(ctx, method, asOf);
  const latest = activeRun(ctx);
  const methodChanged = latest !== undefined && latest.method !== method;

  let baseline: number;
  let supersedeRunId: string | null = null;
  if (latest !== undefined && latest.as_of === asOf) {
    // Reverse-and-replace of the RUN ROW: this run supersedes the prior run for the SAME balance-sheet
    // date. No journal reversal, because D01 posted nothing to reverse (J06 owns the ledger).
    baseline = latest.baseline_value_minor;
    supersedeRunId = latest.id;
  } else if (latest !== undefined && asOf < latest.as_of) {
    return err('valuation_out_of_order', { asOf, latestAsOf: latest.as_of });
  } else {
    baseline = latest?.total_value_minor ?? 0;
  }

  const delta = current.totalMinor - baseline;

  // The supersede and the fresh run row commit together or not at all. `posted_entry_id` and
  // `reversed_entry_id` are always null: D01 is report-only and mints no journal.
  return ctx.store.tx(() => {
    if (supersedeRunId !== null) {
      ctx.store.db
        .prepare('UPDATE stock_valuation_run SET active = 0 WHERE workspace_id = ? AND id = ?')
        .run(ctx.workspaceId, supersedeRunId);
    }

    const runId = ctx.ids.next('stockval');
    ctx.store.db
      .prepare(
        `INSERT INTO stock_valuation_run
           (id, workspace_id, method, as_of, total_value_minor, baseline_value_minor, delta_minor,
            posted_entry_id, reversed_entry_id, active, idempotency_key, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, 1, ?, ?)`,
      )
      .run(
        runId,
        ctx.workspaceId,
        method,
        asOf,
        current.totalMinor,
        baseline,
        delta,
        input.idempotencyKey,
        ctx.clock.now(),
      );

    return ok({
      runId,
      method,
      asOf,
      totalValueMinor: current.totalMinor,
      baselineValueMinor: baseline,
      deltaMinor: delta,
      postedEntryId: null,
      reversedEntryId: null,
      methodChanged,
    });
  });
}

export interface ValuationReportInput {
  method?: string;
  asOf?: string;
}

/** The valuation read model (P5): per-item values, the OR 960c flag, and the Stetigkeit warning. */
export function valuationReport(ctx: WorkspaceContext, input: ValuationReportInput): Result {
  if (!isValuationMethod(input.method)) return err('invalid_input', { field: 'method' });
  const method = input.method;
  if (typeof input.asOf !== 'string' || input.asOf.length < 10) return err('invalid_input', { field: 'asOf' });
  const asOf = input.asOf.slice(0, 10);

  const value = computeInventoryValue(ctx, method, asOf);
  const latest = activeRun(ctx);
  const methodChanged = latest !== undefined && latest.method !== method;

  // The Bestandesnachweis (OR 958c Abs. 2): the committed Inventur at this balance-sheet date, when one
  // exists, is what backs these quantities before they are valued.
  const stocktake = ctx.store.db
    .prepare(
      `SELECT id, inventar_document_id FROM stocktake_session
        WHERE workspace_id = ? AND status = 'committed' AND frozen_at = ?
        ORDER BY committed_at DESC LIMIT 1`,
    )
    .get(ctx.workspaceId, asOf) as { id: string; inventar_document_id: string | null } | undefined;

  return ok({
    method,
    asOf,
    totalValueMinor: value.totalMinor,
    perItem: value.perItem,
    postedValueMinor: latest?.total_value_minor ?? 0,
    unpostedDeltaMinor: value.totalMinor - (latest?.total_value_minor ?? 0),
    methodChanged,
    priorMethod: latest?.method ?? null,
    bestandesnachweis: stocktake === undefined ? null : { sessionId: stocktake.id, inventarDocumentId: stocktake.inventar_document_id },
  });
}
