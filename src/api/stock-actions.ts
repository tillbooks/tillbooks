/**
 * D01's inventory / stock verbs, defined here and spread into `ACTIONS` as one line (the `fxActions` /
 * `itemActions` / `projectActions` precedent), so several agents appending to the append-only registry
 * at once collide over a line rather than a block.
 *
 * Ten D01-owned tools: six writes and four reads. The three customization verbs the spec's §5 lists
 * (`define_field`, `set_field_value`, `create_saved_view`/`list_saved_views`) are G00-owned and consumed
 * here through the OP3 kinds D01 registers (`stock_location`, `stocktake`), never re-declared.
 *
 * As with `item-actions.ts`, the helpers arrive as a parameter rather than an import, so the module
 * graph stays acyclic: `registry.ts` imports this file and this file must not import it back.
 */

import type { ActionDef, ActionInput, JsonSchema } from './registry.js';
import type { WorkspaceContext } from '../core/context.js';
import type { Result } from '../core/result.js';
import {
  upsertStockLocation,
  recordStockMove,
  stockOnHand,
  lowStockList,
  runValuation,
  valuationReport,
  stocktakeOpen,
  stocktakeCount,
  stocktakeReport,
  stocktakeCommit,
} from '../core/stock/index.js';

export interface StockActionHelpers {
  ctxAction(
    name: string,
    kind: 'read' | 'write',
    summary: string,
    inputSchema: JsonSchema,
    call: (ctx: WorkspaceContext, input: ActionInput) => Result,
  ): ActionDef;
  ctxSchema(props?: Record<string, unknown>, required?: string[]): JsonSchema;
  STR: { readonly type: 'string' };
  INT: { readonly type: 'integer' };
  BOOL: { readonly type: 'boolean' };
}

/** Widen an `ActionInput` to the engine's own input shape (the same cast `registry.ts` uses). */
function as<T>(input: ActionInput): T {
  return input as unknown as T;
}

/** The D01 verbs, in append order. */
export function stockActions(h: StockActionHelpers): readonly ActionDef[] {
  const { ctxAction, ctxSchema, STR, INT, BOOL } = h;

  return [
    ctxAction(
      'stock_location_upsert',
      'write',
      'Create or edit a stock location (Lagerort). Pass locationId to edit, omit it to create. `type` is an organisational tag only (warehouse/store/...), never a valuation input.',
      ctxSchema({ locationId: STR, name: STR, type: STR, archived: BOOL, idempotencyKey: STR }, ['idempotencyKey']),
      (ctx, input) => upsertStockLocation(ctx, as(input)),
    ),
    ctxAction(
      'stock_on_hand',
      'read',
      'On-hand per item x location (a P5 read model = the signed sum of stock movements), plus the location and stock-tracked-item pickers. Filter by itemId, locationId, or asOf (inclusive).',
      ctxSchema({ itemId: STR, locationId: STR, asOf: STR, savedViewId: STR }),
      (ctx, input) => stockOnHand(ctx, as(input)),
    ),
    ctxAction(
      'stock_move',
      'write',
      'Record a stock movement (Bewegung). reason is one of receipt|issue|adjust|transfer|return: receipt/return add, issue subtracts, adjust keeps the signed qty (a stocktake shrink is negative), transfer writes a paired issue+receipt across two locations (pass toLocationId). qty is a non-zero integer. A move that would drive on-hand negative is refused with insufficient_stock unless allowNegative is set. Never posts to the ledger (OP2).',
      ctxSchema(
        {
          itemId: STR,
          locationId: STR,
          toLocationId: STR,
          qty: INT,
          reason: STR,
          unitCostMinor: INT,
          movedAt: STR,
          refKind: STR,
          refId: STR,
          allowNegative: BOOL,
          idempotencyKey: STR,
        },
        ['itemId', 'locationId', 'qty', 'reason', 'idempotencyKey'],
      ),
      (ctx, input) => recordStockMove(ctx, as(input)),
    ),
    ctxAction(
      'stock_low_stock',
      'read',
      'The stock-tracked items whose total on-hand is at or below their D00 reorder point. Empty is not an error.',
      ctxSchema(),
      (ctx) => lowStockList(ctx),
    ),
    ctxAction(
      'stock_run_valuation',
      'write',
      'Run the period-end inventory valuation (Bestandesbewertung): computes the full inventory value at asOf by method (fifo|weighted_avg) and records a valuation run row with the figure and the delta against D01 own last run. REPORT-ONLY (K68): it posts NO journal entry. J06 inventory_valuation_post is the sole path inventory value reaches the books (Dr 1200 / Cr 4200); running this verb never touches the ledger, so it cannot double the Vorräte asset. A locked period is refused with period_locked before the run row is written; a re-run at the same asOf supersedes the prior run row (never edits it). Idempotent on idempotencyKey.',
      ctxSchema({ method: STR, asOf: STR, idempotencyKey: STR }, ['method', 'asOf', 'idempotencyKey']),
      (ctx, input) => runValuation(ctx, as(input)),
    ),
    ctxAction(
      'stock_valuation_report',
      'read',
      'The valuation read model (P5): per-item quantity, unit cost and value at asOf by method, the value already posted to the ledger and the unposted delta, the OR 960c lower-of-cost-or-market flag, a Stetigkeit warning when the method differs from the last run, and the linked committed Inventur (OR 958c Abs. 2 Bestandesnachweis) when one exists at asOf.',
      ctxSchema({ method: STR, asOf: STR }, ['method', 'asOf']),
      (ctx, input) => valuationReport(ctx, as(input)),
    ),
    ctxAction(
      'stock_stocktake_open',
      'write',
      'Open an Inventur (physical stocktake): snapshots book qty per item x location as of frozenAt (the balance-sheet date) into a session, optionally scoped to one location. The frozen book qty is the on-hand read model captured at that instant.',
      ctxSchema({ frozenAt: STR, locationId: STR, idempotencyKey: STR }, ['frozenAt', 'idempotencyKey']),
      (ctx, input) => stocktakeOpen(ctx, as(input)),
    ),
    ctxAction(
      'stock_stocktake_count',
      'write',
      'Record the counted qty on one stocktake line (item x location). Only while the session is open. Setting counted to the book qty is how a line is confirmed unchanged.',
      ctxSchema({ sessionId: STR, itemId: STR, locationId: STR, countedQty: INT }, [
        'sessionId',
        'itemId',
        'locationId',
        'countedQty',
      ]),
      (ctx, input) => stocktakeCount(ctx, as(input)),
    ),
    ctxAction(
      'stock_stocktake_report',
      'read',
      'The stocktake diff read model (P5): book vs counted per line with the computed difference, and the uncounted/over/under tallies.',
      ctxSchema({ sessionId: STR, savedViewId: STR }, ['sessionId']),
      (ctx, input) => stocktakeReport(ctx, as(input)),
    ),
    ctxAction(
      'stock_stocktake_commit',
      'write',
      'Commit an Inventur: posts every difference in one batch, each minting a stock movement through the same movement path (reason:adjust, moved_at=frozenAt, ref_kind:stocktake), and seals the session as the committed Bestandesnachweis (OR 958c Abs. 2). No ledger reach: any financial effect arrives later through stock_run_valuation. Refused with uncounted_lines if any line is not counted; idempotent, differences never post twice.',
      ctxSchema({ sessionId: STR, idempotencyKey: STR }, ['sessionId', 'idempotencyKey']),
      (ctx, input) => stocktakeCommit(ctx, as(input)),
    ),
  ];
}
