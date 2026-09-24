/**
 * J05's ten verbs: the reason-code catalog (3 writes + 2 reads) and the reason-coded manual
 * adjustment facade (3 writes + 2 reads), defined here and spread into `ACTIONS` as ONE line (the
 * `movementActions` / `stocktakeActions` precedent), so several agents appending to the append-only
 * registry at once collide over a line rather than a block.
 *
 * The engine helpers arrive as an import and the registry helpers as a parameter, so the module graph
 * stays acyclic. Every field is camelCase and maps straight through to the engine verb. The six writes
 * carry `idempotencyKey` (§H-IDEMPOTENT); the four reads advertise `readOnlyHint`. Every adjustment is
 * minted through J02 `inventory_move` (movement_type `adjustment`) and carries a non-null active reason.
 */

import type { ActionDef, ActionInput, JsonSchema } from './registry.js';
import type { WorkspaceContext } from '../core/context.js';
import type { Result } from '../core/result.js';
import {
  inventoryReasonCreate,
  inventoryReasonUpdate,
  inventoryReasonArchive,
  inventoryReasonList,
  inventoryReasonGet,
  inventoryAdjust,
  inventoryAdjustBatch,
  inventoryAdjustReverse,
  inventoryAdjustList,
  inventoryAdjustAnalysis,
} from '../core/inventory/index.js';

export interface AdjustActionHelpers {
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

/** The J05 verbs, in append order (reason create/update/archive/list/get, then adjust/batch/reverse/list/analysis). */
export function inventoryAdjustActions(h: AdjustActionHelpers): readonly ActionDef[] {
  const { ctxAction, ctxSchema, STR, INT, BOOL } = h;
  const STR_ARRAY = { type: 'array', items: STR } as const;
  const BATCH_LINE = {
    type: 'object',
    properties: {
      itemId: STR,
      locationId: STR,
      lotId: STR,
      serialId: STR,
      qtyDelta: INT,
      reasonCodeId: STR,
      note: STR,
      unitCostMinor: INT,
    },
    required: ['itemId', 'locationId', 'qtyDelta', 'reasonCodeId'],
  } as const;

  return [
    ctxAction(
      'inventory_reason_create',
      'write',
      "Create a workspace-scoped adjustment reason code. code is upper-normalised and unique per workspace, case-insensitively (duplicate_code on collision). category is one of shrinkage, damage, found, count_variance, obsolescence, theft, quality, correction, reversal, system, other. requiresNote forces a non-empty note on any adjustment citing this code; defaultForStocktake marks it selectable by a stocktake commit. Idempotent under idempotencyKey.",
      ctxSchema(
        {
          code: STR,
          name: STR,
          category: STR,
          requiresNote: BOOL,
          defaultForStocktake: BOOL,
          description: STR,
          idempotencyKey: STR,
        },
        ['code', 'name', 'category', 'idempotencyKey'],
      ),
      (ctx, input) => inventoryReasonCreate(ctx, as(input)),
    ),
    ctxAction(
      'inventory_reason_update',
      'write',
      'Update a reason code. The code itself is immutable (it is the classifier historical rows join on); name, description, requiresNote, defaultForStocktake and isActive may change. Setting isActive false is the same soft-archive inventory_reason_archive performs. A foreign or unknown id is not_found. Idempotent under idempotencyKey.',
      ctxSchema(
        {
          id: STR,
          name: STR,
          description: STR,
          requiresNote: BOOL,
          defaultForStocktake: BOOL,
          isActive: BOOL,
          idempotencyKey: STR,
        },
        ['id', 'idempotencyKey'],
      ),
      (ctx, input) => inventoryReasonUpdate(ctx, as(input)),
    ),
    ctxAction(
      'inventory_reason_archive',
      'write',
      'Soft-archive a reason code (isActive = 0): it disappears from pickers but stays queryable for historical joins, and new adjustments can no longer cite it. Never a destructive delete. A foreign or unknown id is not_found. Idempotent under idempotencyKey.',
      ctxSchema({ id: STR, idempotencyKey: STR }, ['id', 'idempotencyKey']),
      (ctx, input) => inventoryReasonArchive(ctx, as(input)),
    ),
    ctxAction(
      'inventory_reason_list',
      'read',
      'List reason codes ordered by code, filterable by activeOnly and category. Returns each code with its category, requiresNote / defaultForStocktake flags and active lifecycle.',
      ctxSchema({ activeOnly: BOOL, category: STR }),
      (ctx, input) => inventoryReasonList(ctx, as(input)),
    ),
    ctxAction(
      'inventory_reason_get',
      'read',
      'Read one reason code by id. A foreign or unknown id is not_found.',
      ctxSchema({ id: STR }, ['id']),
      (ctx, input) => inventoryReasonGet(ctx, as(input)),
    ),
    ctxAction(
      'inventory_adjust',
      'write',
      "Post a single reason-coded quantity adjustment. Supply itemId, locationId, qtyDelta (signed integer thousandths; positive raises on-hand, negative lowers it), reasonCodeId (mandatory, must be active), optional note (required when the reason has requiresNote), optional lotId / serialId, optional unitCostMinor (a Rappen snapshot for the J03 valuation layer), optional effectiveDate (ISO date, default today). It validates the reason and note, asserts the period is open, then mints ONE J02 inventory_move (movement_type adjustment) and records an inventory_adjustment row linking the movement to the reason. Rejections mint nothing: reason_inactive / not_found / no_active_reasons (bad or missing reason), note_required, invalid_qty (qtyDelta 0), insufficient_stock (would overdraw with allow_negative_stock off), period_locked. Idempotent under idempotencyKey (a replay returns the original, posting no second movement).",
      ctxSchema(
        {
          itemId: STR,
          locationId: STR,
          lotId: STR,
          serialId: STR,
          qtyDelta: INT,
          reasonCodeId: STR,
          note: STR,
          unitCostMinor: INT,
          effectiveDate: STR,
          idempotencyKey: STR,
        },
        ['itemId', 'locationId', 'qtyDelta', 'reasonCodeId', 'idempotencyKey'],
      ),
      (ctx, input) => inventoryAdjust(ctx, as(input)),
    ),
    ctxAction(
      'inventory_adjust_batch',
      'write',
      'Post a multi-line adjustment atomically under one generated batchId. lines[] each carry itemId, locationId, qtyDelta, reasonCodeId (may differ per line) and optional lotId / serialId / note / unitCostMinor. Every line is validated (reason active, note policy) BEFORE any mint and the period is asserted once; all lines mint in ONE transaction. If any line fails (inactive reason, missing required note, insufficient stock, invalid qty), the WHOLE batch rolls back and nothing is written. effectiveDate defaults to today. Idempotent under idempotencyKey.',
      ctxSchema(
        {
          description: STR,
          effectiveDate: STR,
          lines: { type: 'array', items: BATCH_LINE },
          idempotencyKey: STR,
        },
        ['lines', 'idempotencyKey'],
      ),
      (ctx, input) => inventoryAdjustBatch(ctx, as(input)),
    ),
    ctxAction(
      'inventory_adjust_reverse',
      'write',
      "Reverse a single adjustment (adjustmentId) or a whole batch (batchId). Each reversal mints an opposite-sign J02 movement carrying its OWN reasonCodeId (mandatory, active) and records a new inventory_adjustment row with reverses_adjustment_id set; the original row and movement are never touched. Reversing a single adjustmentId that belongs to a batch reverses just that line; reversing by batchId reverses every not-yet-reversed line. Already reversed is already_reversed. Batch reversal is atomic. effectiveDate defaults to today (a reversal posts a correction in the current open period). Idempotent under idempotencyKey.",
      ctxSchema(
        {
          adjustmentId: STR,
          batchId: STR,
          reasonCodeId: STR,
          note: STR,
          effectiveDate: STR,
          idempotencyKey: STR,
        },
        ['reasonCodeId', 'idempotencyKey'],
      ),
      (ctx, input) => inventoryAdjustReverse(ctx, as(input)),
    ),
    ctxAction(
      'inventory_adjust_list',
      'read',
      'List manual adjustments (newest first) with reason code + name + category, item and location names, the minted movement id, note, signed qtyDelta and any reversal back-link. Filterable by fromDate / toDate (effective date), itemId, locationId, reasonCodeId, category and batchId. Reversal rows are excluded unless includeReversals. Paginated by limit (default 100, max 500) and offset.',
      ctxSchema({
        fromDate: STR,
        toDate: STR,
        itemId: STR,
        locationId: STR,
        reasonCodeId: STR,
        category: STR,
        batchId: STR,
        includeReversals: BOOL,
        limit: INT,
        offset: INT,
      }),
      (ctx, input) => inventoryAdjustList(ctx, as(input)),
    ),
    ctxAction(
      'inventory_adjust_analysis',
      'read',
      "Aggregate adjustment quantity and value impact over a date window, grouped by any of reason, category, item, location (default reason). Returns per-group adjustmentCount, net qtyDelta and valueImpactMinor (SUM(qtyDelta * unitCostMinor) in Rappen). Reversal rows are included so a reversed adjustment nets to zero, giving an honest shrinkage / write-down figure for Swiss Inventar review.",
      ctxSchema(
        {
          fromDate: STR,
          toDate: STR,
          groupBy: STR_ARRAY,
        },
      ),
      (ctx, input) => inventoryAdjustAnalysis(ctx, as(input)),
    ),
  ];
}
