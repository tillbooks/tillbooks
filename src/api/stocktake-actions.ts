/**
 * J04's nine cycle-count / stocktake verbs (6 writes + 3 reads), defined here and spread into
 * `ACTIONS` as ONE line (the `movementActions` / `trackingActions` precedent), so several agents
 * appending to the append-only registry at once collide over a line rather than a block.
 *
 * As with `movement-actions.ts`, the engine helpers arrive as an import and the registry helpers as a
 * parameter, so the module graph stays acyclic. Every field is camelCase and maps straight through to
 * the engine verb. The six writes carry `idempotencyKey` (§H-IDEMPOTENT); the three reads advertise
 * `readOnlyHint`. Commit mints every non-zero variance EXCLUSIVELY through J02 `inventory_move`.
 */

import type { ActionDef, ActionInput, JsonSchema } from './registry.js';
import type { WorkspaceContext } from '../core/context.js';
import type { Result } from '../core/result.js';
import {
  inventoryStocktakeCreate,
  inventoryStocktakeCount,
  inventoryStocktakeReport,
  inventoryStocktakeApproveLines,
  inventoryStocktakeRequestRecount,
  inventoryStocktakeCommit,
  inventoryStocktakeCancel,
  inventoryStocktakeGet,
  inventoryStocktakeList,
} from '../core/inventory/index.js';

export interface StocktakeActionHelpers {
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

/** The J04 verbs, in append order (create, count, report, approve, recount, commit, cancel, get, list). */
export function stocktakeActions(h: StocktakeActionHelpers): readonly ActionDef[] {
  const { ctxAction, ctxSchema, STR, INT, BOOL } = h;
  const STR_ARRAY = { type: 'array', items: STR } as const;
  const LINE = {
    type: 'object',
    properties: {
      itemId: STR,
      locationId: STR,
      lotId: STR,
      serialId: STR,
      countedQty: INT,
    },
    required: ['itemId', 'locationId', 'countedQty'],
  } as const;

  return [
    ctxAction(
      'inventory_stocktake_create',
      'write',
      "Open a cycle-count / stocktake session that FREEZES a book-quantity snapshot from the J02 movement ledger. type is 'full' (an OR 958c Abs. 2 Inventur frozen at a balance-sheet date) or 'cycle' (an ongoing scope count without a full freeze; default 'full'). freezeAt is the ISO date the book quantities are snapshotted as-of (default today); book_qty per line is SUM(stock_movement.qty) WHERE moved_at <= freezeAt, bit-identical to inventory_balance asOf. Scope with any of warehouseId, locationIds[], itemIds[] (a foreign id is not_found, §H-TENANT); includeZeroQty forces net-zero groups into the count. blindCount hides book_qty until review. varianceQtyThreshold / variancePctThreshold (integer, default 0) classify a counted line as material: a non-zero variance exceeding either enters review_required and blocks commit until approved. Idempotent under idempotencyKey.",
      ctxSchema(
        {
          type: STR,
          freezeAt: STR,
          warehouseId: STR,
          locationIds: STR_ARRAY,
          itemIds: STR_ARRAY,
          abcClasses: STR_ARRAY,
          includeZeroQty: BOOL,
          blindCount: BOOL,
          varianceQtyThreshold: INT,
          variancePctThreshold: INT,
          notes: STR,
          idempotencyKey: STR,
        },
        ['idempotencyKey'],
      ),
      (ctx, input) => inventoryStocktakeCreate(ctx, as(input)),
    ),
    ctxAction(
      'inventory_stocktake_count',
      'write',
      'Record counted quantities for one or more lines of an open session. Each line names itemId + locationId (+ optional lotId / serialId) and countedQty (integer thousandths, may be 0 for an explicit empty bin). Last write wins while the session is open. A line with zero variance auto-approves; a material variance (over threshold) becomes review_required; else counted. A blind session still hides book_qty in the response until review. A line not in the session is not_found; a non-open session is stocktake_not_open.',
      ctxSchema(
        {
          sessionId: STR,
          lines: { type: 'array', items: LINE },
          idempotencyKey: STR,
        },
        ['sessionId', 'lines', 'idempotencyKey'],
      ),
      (ctx, input) => inventoryStocktakeCount(ctx, as(input)),
    ),
    ctxAction(
      'inventory_stocktake_report',
      'read',
      'The variance report for a session (pure read, writes nothing). Returns per-line book_qty, counted_qty, variance_qty and variance_pct plus aggregate over / under / absolute variance and the count of lines exceeding threshold. book_qty is hidden on a blind session until it reaches review. A foreign or unknown session id is not_found.',
      ctxSchema({ sessionId: STR }, ['sessionId']),
      (ctx, input) => inventoryStocktakeReport(ctx, as(input)),
    ),
    ctxAction(
      'inventory_stocktake_approve_lines',
      'write',
      "Approve review-required (or counted) lines so they may be committed. lineIds is an explicit array of line ids or the string 'all_review_required'. An uncounted line cannot be approved (uncounted_or_unapproved_lines). A non-open session is stocktake_not_open. Idempotent under idempotencyKey.",
      ctxSchema(
        {
          sessionId: STR,
          lineIds: { anyOf: [STR_ARRAY, STR] },
          idempotencyKey: STR,
        },
        ['sessionId', 'lineIds', 'idempotencyKey'],
      ),
      (ctx, input) => inventoryStocktakeApproveLines(ctx, as(input)),
    ),
    ctxAction(
      'inventory_stocktake_request_recount',
      'write',
      'Send lines back to pending, clearing their counted quantity so they must be recounted. lineIds is the array of line ids. A non-open session is stocktake_not_open. Idempotent under idempotencyKey.',
      ctxSchema(
        {
          sessionId: STR,
          lineIds: STR_ARRAY,
          reason: STR,
          idempotencyKey: STR,
        },
        ['sessionId', 'lineIds', 'idempotencyKey'],
      ),
      (ctx, input) => inventoryStocktakeRequestRecount(ctx, as(input)),
    ),
    ctxAction(
      'inventory_stocktake_commit',
      'write',
      "Commit a reviewed session: for every line with a non-zero variance (counted - book) mint ONE J02 inventory_move (movement_type adjustment, signed qty, dated at freezeAt, ref_kind stocktake_session) and record it on the line, then mark the session committed, all atomically. No quantity is written directly; on-hand is the SUM over the minted movements. Blocked while any line is pending or review_required (uncounted_or_unapproved_lines). Refused if the freeze date falls in a locked or sealed period (period_locked). Idempotent under idempotencyKey (a replay returns the original movement ids, posting nothing); a committed session re-committed under a NEW key is already_committed. A committed session is corrected by a compensating inventory_move, never an edit.",
      ctxSchema({ sessionId: STR, idempotencyKey: STR }, ['sessionId', 'idempotencyKey']),
      (ctx, input) => inventoryStocktakeCommit(ctx, as(input)),
    ),
    ctxAction(
      'inventory_stocktake_cancel',
      'write',
      'Cancel an open or review session. No movements are written; the frozen snapshot is retained for audit but never re-used. A committed session cannot be cancelled (already_committed). Idempotent under idempotencyKey.',
      ctxSchema({ sessionId: STR, reason: STR, idempotencyKey: STR }, ['sessionId', 'idempotencyKey']),
      (ctx, input) => inventoryStocktakeCancel(ctx, as(input)),
    ),
    ctxAction(
      'inventory_stocktake_get',
      'read',
      'Read one session with its header (type, status, freeze date, progress, variance summary, Inventar link) and its lines. A blind session hides book_qty until review. A legacy D01 stocktake id resolves read-only (legacy:true). A foreign or unknown id is not_found.',
      ctxSchema({ sessionId: STR }, ['sessionId']),
      (ctx, input) => inventoryStocktakeGet(ctx, as(input)),
    ),
    ctxAction(
      'inventory_stocktake_list',
      'read',
      "List sessions (newest freeze date first), filterable by type, status (one or an array), a freeze-date from/to range and warehouseId. Set includeLegacy to also surface legacy D01 stocktakes read-only. Each row carries progress and the counted / review / total line counts.",
      ctxSchema({
        type: STR,
        status: { anyOf: [STR_ARRAY, STR] },
        from: STR,
        to: STR,
        warehouseId: STR,
        includeLegacy: BOOL,
      }),
      (ctx, input) => inventoryStocktakeList(ctx, as(input)),
    ),
  ];
}
