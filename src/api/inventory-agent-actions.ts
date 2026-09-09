/**
 * J07's ten verbs: reads and not one write, the I05 / C03 pure-read posture exactly.
 *
 * Every tool here is `kind: 'read'`, so every one carries `readOnlyHint` on MCP and none carries an
 * `idempotencyKey` (a read needs none). J07 owns no table and posts nothing: the ten verbs derive
 * stock position, low stock, valuation status / drift, movement history, lot/serial trace, anomalies,
 * slow movers, cycle-count status, reorder candidates and a unified alerts feed from the live J00-J06
 * data at query time (P5, §H-STOCK-AUDIT), and `test/inventory/agent.test.mjs` asserts the module is
 * structurally INCAPABLE of writing rather than merely polite about it.
 *
 * THE DESCRIPTIONS SAY WHAT THE FIGURES ARE: derived, reproducible from the underlying movement
 * ledger and valuation, never a second source of truth and never a GL posting. An agent quotes a tool
 * description with no human filter, so each says the numbers are DERIVED and nothing is written.
 *
 * Defined here rather than inline in `registry.ts` for the reason §H-FX, A08, C03 and I05 established:
 * the registry is the one append-only tool list and several agents append to it at once, so the
 * smaller the hunk the cheaper the merge. The helpers arrive as a parameter to keep the graph acyclic.
 */

import type { ActionDef, ActionInput, JsonSchema } from './registry.js';
import type { WorkspaceContext } from '../core/context.js';
import type { Result } from '../core/result.js';
import {
  inventoryStockPosition,
  inventoryLowStock,
  inventoryValuationStatus,
  inventoryMovementHistory,
  inventoryAnomalies,
  inventoryCycleCountStatus,
  inventoryLotTrace,
  inventorySlowMovers,
  inventoryAlerts,
  inventoryReorderCandidates,
} from '../core/inventory/index.js';

export interface InventoryAgentActionHelpers {
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

/** A free-form object schema (a filter bag or the threshold override the engine validates). */
const OBJECT = { type: 'object' } as const;
/** An array-of-strings schema (id lists, type / severity filters). */
const STR_ARRAY = { type: 'array', items: { type: 'string' } } as const;

/** The J07 verbs, in append order. */
export function inventoryAgentActions(h: InventoryAgentActionHelpers): readonly ActionDef[] {
  const { ctxAction, ctxSchema, STR, INT, BOOL } = h;

  return [
    ctxAction(
      'inventory_stock_position',
      'read',
      `Die Bestandsposition (stock position, US-J07.1): what is on hand, where, and (optionally) what it is worth, in one structured call. Sum the append-only J02 movement ledger into (item, location) positions under an optional filter (item_ids, location_ids, warehouse_ids, lot_codes, serial_numbers, only_positive), optionally rolled up by group_by (none | item | location | warehouse). On-hand is always SUM(stock_movement.qty), never a stored column, so a position can never disagree with the ledger it sums. With include_valuation the extended value comes from the pure J03 valuation preview, integer Rappen, so it equals a direct valuation call for the same (item, location). Returns rows plus a totals footer (count, qty, value_rappen) and stable limit / offset pagination; an empty match answers ok with message no_positions_matching. A foreign item / location / warehouse id is not_found (tenant isolation). Posts nothing.`,
      ctxSchema({ filter: OBJECT, include_valuation: BOOL, group_by: STR, limit: INT, offset: INT }),
      (ctx, input) => inventoryStockPosition(ctx, as(input)),
    ),
    ctxAction(
      'inventory_low_stock',
      'read',
      `Die Liste tiefer Bestaende (low stock, US-J07.2): every stock-tracked item whose on-hand has fallen to or below its D00 reorder point, ordered by severity (deepest shortfall, then lowest days-of-cover, first). Each row carries current_qty, reorder_point, shortfall_qty, last_movement_at, a simple average daily usage derived from recent outbound movements and an estimated days-of-cover; when there is not enough usage history the cover is null with warning usage_history_insufficient. Optional location_ids / warehouse_ids narrow the on-hand, min_shortfall filters, include_zero keeps zero-reorder items. safety_stock / suggested_reorder_qty are null until a later item-master extension adds the columns. Empty is an ok empty list. Pure derivation over the ledger; posts nothing.`,
      ctxSchema({ location_ids: STR_ARRAY, warehouse_ids: STR_ARRAY, include_zero: BOOL, min_shortfall: INT, thresholds: OBJECT }),
      (ctx, input) => inventoryLowStock(ctx, as(input)),
    ),
    ctxAction(
      'inventory_valuation_status',
      'read',
      `Der Bewertungsstatus (valuation status / drift, US-J07.3, the OP11 surface): recompute the current inventory value LIVE from the J02 ledger through the J03 method at as_of (default today, optional method override), read the most recent POSTED J06 valuation run at or before that cut-off, and report current_value_rappen, last_posted_value_rappen, drift_rappen, drift_pct, last_posted_at, last_run_id and a status of aligned | drift_present | never_posted. Drift is REPORTED, never auto-corrected: J07 posts nothing and reaches no GL. With include_detail the per-item current values are returned. This is the hard check the period-close checklist reads. Zero inventory answers zeros, aligned.`,
      ctxSchema({ as_of: STR, method: STR, include_detail: BOOL, thresholds: OBJECT }),
      (ctx, input) => inventoryValuationStatus(ctx, as(input)),
    ),
    ctxAction(
      'inventory_movement_history',
      'read',
      `Die Bewegungshistorie (movement history, US-J07.4): the ordered, filterable J02 movement rows for one item (required), optionally narrowed by location, lot_code, serial_number and a from_date / to_date range, with a server-computed running on-hand balance that closes to the live inventory_stock_position qty for the same filter (spec tripwire). Reuses the J02 inventory_movement_list read model, so history never becomes a second projection. Supports limit / offset pagination; an item / location / lot / serial that does not exist is not_found; from_date after to_date is invalid_date_range. Empty history is an ok empty list. Reads only, posts nothing.`,
      ctxSchema({ item_id: STR, location_id: STR, lot_code: STR, serial_number: STR, from_date: STR, to_date: STR, limit: INT, offset: INT }, ['item_id']),
      (ctx, input) => inventoryMovementHistory(ctx, as(input)),
    ),
    ctxAction(
      'inventory_anomalies',
      'read',
      `Die Anomalieliste (anomalies, US-J07.5): a prioritised list of DERIVED inventory exception events since a look-back date (default 30 days), each with type, severity (info | warning | critical), title, summary, entity refs, detected_at and a structured payload. Detected types (Phase 1, all derived, no extra table): negative_stock (a live on-hand below zero), large_issue / large_adjustment (absolute qty or value above threshold), unlinked_high_value_issue (a high-value issue with no source document), valuation_drift (cross-ref valuation status), open_stocktake_overdue (a J04 session open past its window) and lot_near_expiry (an open lot inside the J01 expiry window). Thresholds are built-in defaults, overridable per call, never persisted. Empty is an ok empty list. Deterministic for a given snapshot; posts nothing.`,
      ctxSchema({ since: STR, types: STR_ARRAY, severity: STR_ARRAY, limit: INT, thresholds: OBJECT }),
      (ctx, input) => inventoryAnomalies(ctx, as(input)),
    ),
    ctxAction(
      'inventory_cycle_count_status',
      'read',
      `Der Status der Inventuren (cycle-count / stocktake status, US-J07.6): the open and recently committed J04 sessions with session_id, status, freeze_at, warehouse scope, line_count / counted_count / uncounted_count / review_required_count, committed_at, inventar_document_id, days_open and an overdue flag (open past the configured window). Optional status / warehouse_ids / overdue_only filters. Reuses the J04 inventory_stocktake_list read model. Variance qty / value are left null in Phase 1 (they need the per-session report). Useful for operational follow-up and the close-pack checklist. Reads only.`,
      ctxSchema({ status: STR_ARRAY, warehouse_ids: STR_ARRAY, overdue_only: BOOL, thresholds: OBJECT }),
      (ctx, input) => inventoryCycleCountStatus(ctx, as(input)),
    ),
    ctxAction(
      'inventory_lot_trace',
      'read',
      `Die Chargen- / Seriennummern-Verfolgung (lot / serial trace, US-J07.7): given a lot_code or a serial_number (optionally disambiguated by item_id), return the current position(s) (location and remaining qty for a lot, current location and status for a serial) and the full chronological J02 movement history for that lot / serial. Supports the OR 957a duty to keep orderly, verifiable inventory records. A lot / serial that does not exist in this workspace answers a soft found:false (not a hard error, and never a cross-tenant leak). Reads only, posts nothing.`,
      ctxSchema({ lot_code: STR, serial_number: STR, item_id: STR }),
      (ctx, input) => inventoryLotTrace(ctx, as(input)),
    ),
    ctxAction(
      'inventory_slow_movers',
      'read',
      `Die Ladenhueter-Ansicht (slow movers / aging, US-J07.8): stock-tracked items with a positive on-hand and no OUTBOUND movement inside a window (min_days_no_movement, default 90), ordered by extended value descending, each with current_qty, last_movement_at, last_outbound_at, days_idle, unit cost and extended_value_rappen (from the pure J03 book value). Optional min_value_rappen and location_ids narrow the list. This surfaces the high-value stagnant stock that lower-of-cost-or-market thinking (OR 960c) reviews; it performs NO write-down itself. Empty is an ok empty list. Reads only.`,
      ctxSchema({ min_days_no_movement: INT, min_value_rappen: INT, location_ids: STR_ARRAY, thresholds: OBJECT }),
      (ctx, input) => inventorySlowMovers(ctx, as(input)),
    ),
    ctxAction(
      'inventory_alerts',
      'read',
      `Der einheitliche Alarm-Feed (unified alerts, US-J07.9): one tool an agent can poll for everything that currently needs attention. It merges low-stock, anomalies, overdue stocktakes, valuation drift and near-expiry lots into a single de-duplicated, severity-prioritised list, each alert carrying a stable alert_key (for optional future acknowledgement), type, severity, title, summary, entity refs, detected_at and a suggested_action hint (create_requisition, run_valuation, complete_stocktake, ...). Optional severity / types / limit filters. Pure computation; no persistent alert store in Phase 1. Empty is an ok empty list. Posts nothing.`,
      ctxSchema({ severity: STR_ARRAY, types: STR_ARRAY, limit: INT, thresholds: OBJECT }),
      (ctx, input) => inventoryAlerts(ctx, as(input)),
    ),
    ctxAction(
      'inventory_reorder_candidates',
      'read',
      `Die Nachbestell-Kandidaten (reorder candidates, US-J07.10): the subset of the low-stock list with a POSITIVE shortfall, each with a suggested_qty (the shortfall in Phase 1), current_qty, reorder_point, estimated days-of-cover and a ready-to-use payload an agent can hand to an I00 requisition or a purchase-order tool. preferred_supplier_id is null until a supplier-preference extension lands. Advisory ONLY: no document is created and nothing is posted. Optional warehouse_ids / location_ids scope. Empty is an ok empty list.`,
      ctxSchema({ warehouse_ids: STR_ARRAY, location_ids: STR_ARRAY, thresholds: OBJECT }),
      (ctx, input) => inventoryReorderCandidates(ctx, as(input)),
    ),
  ];
}
