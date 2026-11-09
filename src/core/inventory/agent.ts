/**
 * J07, inventory agent tools & alerts: the TERMINAL inventory leaf. Ten agent-facing PURE READS that
 * let an agent (or a busy bookkeeper) answer an operational inventory question in one structured call
 * and be shown the exceptions that matter, over the whole J00-J06 cluster.
 *
 * IT OWNS NO TABLE AND POSTS NOTHING (spec §3, P5, §H-STOCK-AUDIT). Every figure is DERIVED on the
 * spot from the append-only J02 movement ledger (`stock_movement`), the J00 warehouse / location
 * masters, the J01 lot / serial masters, the J03 valuation calculators and the last posted J06
 * valuation run. No verb here mints a movement, writes a quantity, or reaches the General Ledger:
 * `test/inventory/agent.test.mjs` proves the module is INCAPABLE of writing rather than merely polite
 * about it (the I05 / C03 posture). On-hand is always `SUM(stock_movement.qty)`, never a stored
 * column, so a position can never disagree with the ledger it sums.
 *
 * §H-TENANT ON EVERY QUERY. A foreign item / location / warehouse id is `not_found` BEFORE any
 * aggregation runs, and every SELECT scopes by `workspace_id`, so no cross-tenant row is ever summed
 * into a total.
 *
 * THRESHOLDS ARE BUILT-IN DEFAULTS (Phase 1), overridable per call. J07 persists no config row (that
 * would be the one writable thing and the spec forbids agents writing thresholds), so an anomaly /
 * alert computation is deterministic for a given snapshot of movements plus the passed thresholds.
 *
 * The engine reuses the cluster's own read models rather than re-deriving them: `inventoryValuation
 * Preview` (J03) for value, `inventoryMovementList` (J02) for history, `inventoryValuationReport`
 * (J06) for the live valuation, `inventoryStocktakeList` (J04) for cycle counts. Reusing them is what
 * makes "the number J07 shows equals a direct J03/J06 call" true by construction (spec §7 tripwires).
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { inventoryMovementList } from './movement.js';
import { inventoryValuationPreview, itemBookValueMinor } from './valuationPolicy.js';
import { inventoryValuationReport } from './reconciliation.js';
import { inventoryStocktakeList } from './stocktake.js';

// --- Built-in thresholds (spec §2/§4, Phase-1 defaults, overridable per call) -------------------

/** The default anomaly / alert thresholds. Every one is overridable through a verb's `thresholds`. */
export const AGENT_DEFAULT_THRESHOLDS = {
  /** Absolute quantity above which an issue / adjustment is a `large_issue` / `large_adjustment`. */
  largeQty: 1000,
  /** Absolute extended value (Rappen) above which a movement is `large_*` / high-value. */
  largeValueRappen: 1_000_000,
  /** Absolute valuation drift (Rappen) that raises `valuation_drift`. */
  driftAbsRappen: 10_000,
  /** Relative valuation drift (%) that raises `valuation_drift`. */
  driftPct: 5,
  /** Days a cycle-count / stocktake session may stay open before it is overdue. */
  stocktakeOverdueDays: 30,
  /** Days before a lot's expiry that raises `lot_near_expiry`. */
  lotExpiryWarningDays: 30,
  /** Days without an outbound movement that makes an item a slow mover. */
  slowMoverDays: 90,
  /** The default anomaly look-back window, in days. */
  anomalySinceDays: 30,
  /** The window (days) of recent issues used to derive average daily usage for days-of-cover. */
  usageWindowDays: 30,
} as const;

export type AgentThresholds = Record<keyof typeof AGENT_DEFAULT_THRESHOLDS, number>;

/** Merge a caller override onto the defaults; an absent or non-integer field keeps the default. */
function resolveThresholds(override?: Partial<Record<keyof AgentThresholds, unknown>>): AgentThresholds {
  const out: AgentThresholds = { ...AGENT_DEFAULT_THRESHOLDS };
  if (override !== undefined && typeof override === 'object' && override !== null) {
    for (const key of Object.keys(AGENT_DEFAULT_THRESHOLDS) as (keyof AgentThresholds)[]) {
      const v = override[key];
      if (typeof v === 'number' && Number.isFinite(v) && v >= 0) out[key] = v;
    }
  }
  return out;
}

/** The alert / anomaly type vocabulary (§H-ENUM). Derived types only; nothing is stored. */
export const ANOMALY_TYPES = [
  'negative_stock',
  'large_issue',
  'large_adjustment',
  'unlinked_high_value_issue',
  'valuation_drift',
  'open_stocktake_overdue',
  'lot_near_expiry',
  'low_stock',
] as const;
export type AnomalyType = (typeof ANOMALY_TYPES)[number];

const SEVERITIES = ['info', 'warning', 'critical'] as const;
type Severity = (typeof SEVERITIES)[number];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// --- small tenant-scoped reads -----------------------------------------------------------------

interface ItemRow {
  id: string;
  name: string;
  itemSku: string | null;
  unit: string | null;
  reorderPointQty: number | null;
  costPriceMinor: number | null;
  trackStock: number;
}

function readItem(ctx: WorkspaceContext, id: string): ItemRow | undefined {
  const row = ctx.store.db
    .prepare(
      `SELECT id, name, item_sku AS itemSku, unit, reorder_point_qty AS reorderPointQty,
              cost_price_minor AS costPriceMinor, track_stock AS trackStock
         FROM item WHERE workspace_id = ? AND id = ?`,
    )
    .get(ctx.workspaceId, id) as ItemRow | undefined;
  return row;
}

function locationExists(ctx: WorkspaceContext, id: string): boolean {
  return (
    ctx.store.db
      .prepare('SELECT id FROM stock_location WHERE workspace_id = ? AND id = ?')
      .get(ctx.workspaceId, id) !== undefined
  );
}

function warehouseExists(ctx: WorkspaceContext, id: string): boolean {
  return (
    ctx.store.db.prepare('SELECT id FROM warehouse WHERE workspace_id = ? AND id = ?').get(ctx.workspaceId, id) !==
    undefined
  );
}

/** Today (ISO day) off the injected clock: no verb reads the wall clock directly (P1). */
function today(ctx: WorkspaceContext): string {
  return ctx.clock.now().slice(0, 10);
}

/** The ISO day `days` before `from` (default today); a NEGATIVE `days` is that many days AFTER. */
function daysBefore(ctx: WorkspaceContext, days: number, from?: string): string {
  const base = from !== undefined && DATE_RE.test(from) ? from : today(ctx);
  const d = new Date(`${base}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - Math.trunc(days));
  return d.toISOString().slice(0, 10);
}

/** Whole days between two ISO days (a - b), floored at 0 when b is in the future of a. */
function daysBetween(a: string, b: string): number {
  const da = new Date(`${a}T00:00:00Z`).getTime();
  const db = new Date(`${b}T00:00:00Z`).getTime();
  return Math.max(0, Math.round((da - db) / 86_400_000));
}

/** Validate an optional ISO-day input; returns the trimmed day or `undefined`, or an error Result. */
function optDay(value: unknown, field: string): { ok: true; day: string | undefined } | { ok: false; err: Result } {
  if (value === undefined || value === null || value === '') return { ok: true, day: undefined };
  if (typeof value !== 'string') return { ok: false, err: err('invalid_input', { field }) };
  const day = value.slice(0, 10);
  if (!DATE_RE.test(day)) return { ok: false, err: err('invalid_input', { field }) };
  return { ok: true, day };
}

/** Reject each id in `ids` that is not a real row of `kind` in this workspace (§H-TENANT). */
function assertIds(
  ctx: WorkspaceContext,
  ids: unknown,
  kind: 'item' | 'location' | 'warehouse',
): { ok: true; ids: string[] } | { ok: false; err: Result } {
  if (ids === undefined || ids === null) return { ok: true, ids: [] };
  if (!Array.isArray(ids)) return { ok: false, err: err('invalid_input', { field: `${kind}_ids` }) };
  const out: string[] = [];
  for (const raw of ids) {
    if (typeof raw !== 'string' || raw.length === 0) return { ok: false, err: err('invalid_input', { field: `${kind}_ids` }) };
    const exists =
      kind === 'item' ? readItem(ctx, raw) !== undefined : kind === 'location' ? locationExists(ctx, raw) : warehouseExists(ctx, raw);
    if (!exists) return { ok: false, err: err('not_found', { [`${kind}Id`]: raw }) };
    out.push(raw);
  }
  return { ok: true, ids: out };
}

/** Carry a caller's `thresholds` into a reused verb input without an explicit-undefined key. */
function passThresholds(
  t: Partial<Record<keyof AgentThresholds, unknown>> | undefined,
): { thresholds?: Partial<Record<keyof AgentThresholds, unknown>> } {
  return t === undefined ? {} : { thresholds: t };
}

/** A stable alert key for de-dupe / future acknowledgement: deterministic for a given entity. */
function alertKey(type: string, parts: (string | number | null | undefined)[]): string {
  return [type, ...parts.map((p) => (p === null || p === undefined ? '' : String(p)))].join(':');
}

// --- US-J07.1: stock position ------------------------------------------------------------------

type GroupBy = 'none' | 'item' | 'location' | 'warehouse';

export interface StockPositionInput {
  filter?: {
    item_ids?: string[];
    location_ids?: string[];
    warehouse_ids?: string[];
    lot_codes?: string[];
    serial_numbers?: string[];
    only_positive?: boolean;
  };
  include_valuation?: boolean;
  group_by?: GroupBy;
  limit?: number;
  offset?: number;
}

interface PositionBase {
  itemId: string;
  itemName: string;
  itemSku: string | null;
  uom: string | null;
  locationId: string;
  locationCode: string | null;
  locationName: string;
  warehouseId: string | null;
  warehouseCode: string | null;
  warehouseName: string | null;
  qty: number;
}

/**
 * Sum the J02 ledger into (item, location) positions under the filter (spec §2 US-J07.1). On-hand is
 * the live `SUM(stock_movement.qty)`, so the property test `sum(position.qty) == on_hand` holds by
 * construction. Lot / serial filters narrow the summed movement set; the row grain stays
 * (item, location), and lot / serial detail is served by `inventory_lot_trace`.
 */
function positionBase(ctx: WorkspaceContext, filter: NonNullable<StockPositionInput['filter']>): PositionBase[] {
  const clauses = ['m.workspace_id = ?'];
  const params: unknown[] = [ctx.workspaceId];
  const inClause = (col: string, vals: string[] | undefined): void => {
    if (Array.isArray(vals) && vals.length > 0) {
      clauses.push(`${col} IN (${vals.map(() => '?').join(', ')})`);
      params.push(...vals);
    }
  };
  inClause('m.item_id', filter.item_ids);
  inClause('m.location_id', filter.location_ids);
  inClause('l.warehouse_id', filter.warehouse_ids);
  if (Array.isArray(filter.lot_codes) && filter.lot_codes.length > 0) {
    clauses.push(
      `m.lot_id IN (SELECT id FROM lot WHERE workspace_id = ? AND lower(number) IN (${filter.lot_codes
        .map(() => '?')
        .join(', ')}))`,
    );
    params.push(ctx.workspaceId, ...filter.lot_codes.map((c) => String(c).toLowerCase()));
  }
  if (Array.isArray(filter.serial_numbers) && filter.serial_numbers.length > 0) {
    clauses.push(
      `m.serial_id IN (SELECT id FROM serial WHERE workspace_id = ? AND lower(number) IN (${filter.serial_numbers
        .map(() => '?')
        .join(', ')}))`,
    );
    params.push(ctx.workspaceId, ...filter.serial_numbers.map((s) => String(s).toLowerCase()));
  }
  const having = filter.only_positive === true ? 'HAVING COALESCE(SUM(m.qty), 0) > 0' : 'HAVING COALESCE(SUM(m.qty), 0) != 0';

  return ctx.store.db
    .prepare(
      `SELECT m.item_id AS itemId, i.name AS itemName, i.item_sku AS itemSku, i.unit AS uom,
              m.location_id AS locationId, l.code AS locationCode, l.name AS locationName,
              l.warehouse_id AS warehouseId, w.code AS warehouseCode, w.name AS warehouseName,
              COALESCE(SUM(m.qty), 0) AS qty
         FROM stock_movement m
         JOIN item i ON i.id = m.item_id
         JOIN stock_location l ON l.id = m.location_id
         LEFT JOIN warehouse w ON w.id = l.warehouse_id
        WHERE ${clauses.join(' AND ')}
        GROUP BY m.item_id, m.location_id
        ${having}
        ORDER BY i.name, w.code, l.code`,
    )
    .all(...params) as PositionBase[];
}

export function inventoryStockPosition(ctx: WorkspaceContext, input: StockPositionInput = {}): Result {
  const capable = ctx.capabilities.assert('read_master_data');
  if (!capable.ok) return capable;

  const filter = input.filter ?? {};
  const items = assertIds(ctx, filter.item_ids, 'item');
  if (!items.ok) return items.err;
  const locs = assertIds(ctx, filter.location_ids, 'location');
  if (!locs.ok) return locs.err;
  const whs = assertIds(ctx, filter.warehouse_ids, 'warehouse');
  if (!whs.ok) return whs.err;

  const groupBy: GroupBy = (['none', 'item', 'location', 'warehouse'] as const).includes(input.group_by as GroupBy)
    ? (input.group_by as GroupBy)
    : 'none';

  const base = positionBase(ctx, filter);

  // Optional valuation via the J03 preview (US-J07.1), keyed (item|location) so a position's value is
  // exactly what a direct `inventory_valuation_preview` returns for the same (item, location).
  const valueByPair = new Map<string, { unitCostRappen: number | null; extendedValueRappen: number }>();
  if (input.include_valuation === true) {
    const previewInput: { valueByLocation: true; itemIds?: string[] } = { valueByLocation: true };
    if (Array.isArray(filter.item_ids) && filter.item_ids.length > 0) previewInput.itemIds = filter.item_ids;
    const preview = inventoryValuationPreview(ctx, previewInput);
    if (!preview.ok) return preview;
    for (const r of (preview as unknown as { items: Record<string, unknown>[] }).items) {
      const key = `${String(r.itemId)}|${String(r.locationId ?? '')}`;
      valueByPair.set(key, {
        unitCostRappen: typeof r.unitCostMinor === 'number' ? (r.unitCostMinor as number) : null,
        extendedValueRappen: typeof r.totalValueMinor === 'number' ? (r.totalValueMinor as number) : 0,
      });
    }
  }

  interface Row {
    item_id: string | null;
    item_number: string | null;
    item_name: string | null;
    location_id: string | null;
    location_code: string | null;
    location_name: string | null;
    warehouse_id: string | null;
    warehouse_code: string | null;
    warehouse_name: string | null;
    uom: string | null;
    qty: number;
    unit_cost_rappen?: number | null;
    extended_value_rappen?: number;
  }

  const groups = new Map<string, Row>();
  const keyFor = (b: PositionBase): string => {
    if (groupBy === 'item') return `i:${b.itemId}`;
    if (groupBy === 'location') return `l:${b.locationId}`;
    if (groupBy === 'warehouse') return `w:${b.warehouseId ?? ''}`;
    return `p:${b.itemId}|${b.locationId}`;
  };

  for (const b of base) {
    const key = keyFor(b);
    const value = valueByPair.get(`${b.itemId}|${b.locationId}`);
    const existing = groups.get(key);
    if (existing === undefined) {
      const row: Row = {
        item_id: groupBy === 'location' || groupBy === 'warehouse' ? null : b.itemId,
        item_number: groupBy === 'location' || groupBy === 'warehouse' ? null : b.itemSku,
        item_name: groupBy === 'location' || groupBy === 'warehouse' ? null : b.itemName,
        location_id: groupBy === 'item' || groupBy === 'warehouse' ? null : b.locationId,
        location_code: groupBy === 'item' || groupBy === 'warehouse' ? null : b.locationCode,
        location_name: groupBy === 'item' || groupBy === 'warehouse' ? null : b.locationName,
        warehouse_id: groupBy === 'item' || groupBy === 'location' ? null : b.warehouseId,
        warehouse_code: groupBy === 'item' || groupBy === 'location' ? null : b.warehouseCode,
        warehouse_name: groupBy === 'item' || groupBy === 'location' ? null : b.warehouseName,
        uom: b.uom,
        qty: b.qty,
      };
      if (input.include_valuation === true) {
        row.extended_value_rappen = value?.extendedValueRappen ?? 0;
        row.unit_cost_rappen = groupBy === 'none' ? value?.unitCostRappen ?? null : null;
      }
      groups.set(key, row);
    } else {
      existing.qty += b.qty;
      if (input.include_valuation === true) existing.extended_value_rappen = (existing.extended_value_rappen ?? 0) + (value?.extendedValueRappen ?? 0);
    }
  }

  const allRows = [...groups.values()];
  const totals = {
    count: allRows.length,
    qty: allRows.reduce((s, r) => s + r.qty, 0),
    value_rappen: input.include_valuation === true ? allRows.reduce((s, r) => s + (r.extended_value_rappen ?? 0), 0) : 0,
  };

  const limit = Number.isInteger(input.limit) && (input.limit as number) > 0 ? Math.min(input.limit as number, 5000) : 500;
  const offset = Number.isInteger(input.offset) && (input.offset as number) > 0 ? (input.offset as number) : 0;
  const page = allRows.slice(offset, offset + limit);

  if (allRows.length === 0) {
    return ok({ rows: [], totals, groupBy, limit, offset, message: 'no_positions_matching' });
  }
  return ok({ rows: page, totals, groupBy, limit, offset });
}

// --- US-J07.2 / US-J07.10: low stock & reorder candidates --------------------------------------

export interface LowStockInput {
  location_ids?: string[];
  warehouse_ids?: string[];
  include_zero?: boolean;
  min_shortfall?: number;
  thresholds?: Partial<Record<keyof AgentThresholds, unknown>>;
}

interface LowStockRow {
  item_id: string;
  item_number: string | null;
  item_name: string;
  uom: string | null;
  current_qty: number;
  reorder_point: number;
  safety_stock: number | null;
  shortfall_qty: number;
  suggested_reorder_qty: number | null;
  preferred_supplier_id: string | null;
  last_movement_at: string | null;
  simple_avg_daily_usage: number | null;
  estimated_days_of_cover: number | null;
  warning: string | null;
}

/** The shared low-stock core, used by low_stock, reorder_candidates and the alerts feed. */
function lowStockRows(ctx: WorkspaceContext, input: LowStockInput): { ok: true; rows: LowStockRow[] } | { ok: false; err: Result } {
  const locs = assertIds(ctx, input.location_ids, 'location');
  if (!locs.ok) return { ok: false, err: locs.err };
  const whs = assertIds(ctx, input.warehouse_ids, 'warehouse');
  if (!whs.ok) return { ok: false, err: whs.err };
  const th = resolveThresholds(input.thresholds);

  // The on-hand subquery, optionally narrowed to the requested locations / warehouses.
  const onhandClauses = ['m.workspace_id = i.workspace_id', 'm.item_id = i.id'];
  const onhandParams: unknown[] = [];
  if (locs.ids.length > 0) {
    onhandClauses.push(`m.location_id IN (${locs.ids.map(() => '?').join(', ')})`);
    onhandParams.push(...locs.ids);
  }
  if (whs.ids.length > 0) {
    onhandClauses.push(
      `m.location_id IN (SELECT id FROM stock_location WHERE workspace_id = i.workspace_id AND warehouse_id IN (${whs.ids
        .map(() => '?')
        .join(', ')}))`,
    );
    onhandParams.push(...whs.ids);
  }

  const rows = ctx.store.db
    .prepare(
      `SELECT i.id AS itemId, i.name AS itemName, i.item_sku AS itemSku, i.unit AS uom,
              i.reorder_point_qty AS reorderPoint,
              COALESCE((SELECT SUM(m.qty) FROM stock_movement m WHERE ${onhandClauses.join(' AND ')}), 0) AS onHand,
              (SELECT MAX(m2.moved_at) FROM stock_movement m2 WHERE m2.workspace_id = i.workspace_id AND m2.item_id = i.id) AS lastMovementAt
         FROM item i
        WHERE i.workspace_id = ? AND i.track_stock = 1 AND i.reorder_point_qty IS NOT NULL
        ORDER BY i.name`,
    )
    .all(...onhandParams, ctx.workspaceId) as {
    itemId: string;
    itemName: string;
    itemSku: string | null;
    uom: string | null;
    reorderPoint: number;
    onHand: number;
    lastMovementAt: string | null;
  }[];

  const minShortfall = Number.isInteger(input.min_shortfall) ? (input.min_shortfall as number) : undefined;
  const usageFrom = daysBefore(ctx, th.usageWindowDays);
  const out: LowStockRow[] = [];
  for (const r of rows) {
    if (r.onHand > r.reorderPoint) continue;
    if (input.include_zero !== true && r.reorderPoint <= 0 && r.onHand <= 0) continue;
    const shortfall = r.reorderPoint - r.onHand;
    if (minShortfall !== undefined && shortfall < minShortfall) continue;

    // Average daily usage from recent OUTBOUND movements (negative qty) inside the usage window.
    const used = ctx.store.db
      .prepare(
        `SELECT COALESCE(SUM(-m.qty), 0) AS issued
           FROM stock_movement m
          WHERE m.workspace_id = ? AND m.item_id = ? AND m.qty < 0 AND m.moved_at >= ?`,
      )
      .get(ctx.workspaceId, r.itemId, usageFrom) as { issued: number };
    const avgDaily = used.issued > 0 ? used.issued / th.usageWindowDays : null;
    const daysOfCover = avgDaily !== null && avgDaily > 0 ? Math.floor(r.onHand / avgDaily) : null;

    out.push({
      item_id: r.itemId,
      item_number: r.itemSku,
      item_name: r.itemName,
      uom: r.uom,
      current_qty: r.onHand,
      reorder_point: r.reorderPoint,
      safety_stock: null,
      shortfall_qty: shortfall,
      suggested_reorder_qty: null,
      preferred_supplier_id: null,
      last_movement_at: r.lastMovementAt,
      simple_avg_daily_usage: avgDaily,
      estimated_days_of_cover: daysOfCover,
      warning: avgDaily === null ? 'usage_history_insufficient' : null,
    });
  }
  // Severity order: the deepest shortfall (or the lowest days-of-cover) first.
  out.sort((a, b) => {
    if (b.shortfall_qty !== a.shortfall_qty) return b.shortfall_qty - a.shortfall_qty;
    const ca = a.estimated_days_of_cover ?? Number.POSITIVE_INFINITY;
    const cb = b.estimated_days_of_cover ?? Number.POSITIVE_INFINITY;
    return ca - cb;
  });
  return { ok: true, rows: out };
}

export function inventoryLowStock(ctx: WorkspaceContext, input: LowStockInput = {}): Result {
  const capable = ctx.capabilities.assert('read_master_data');
  if (!capable.ok) return capable;
  const res = lowStockRows(ctx, input);
  if (!res.ok) return res.err;
  return ok({ items: res.rows, count: res.rows.length });
}

export interface ReorderCandidatesInput {
  warehouse_ids?: string[];
  location_ids?: string[];
  thresholds?: Partial<Record<keyof AgentThresholds, unknown>>;
}

export function inventoryReorderCandidates(ctx: WorkspaceContext, input: ReorderCandidatesInput = {}): Result {
  const capable = ctx.capabilities.assert('read_master_data');
  if (!capable.ok) return capable;
  const res = lowStockRows(ctx, input);
  if (!res.ok) return res.err;
  // Only rows with a POSITIVE shortfall are candidates; the payload is ready to hand to a requisition
  // / PO tool (advisory only, no document is created here, spec US-J07.10).
  const candidates = res.rows
    .filter((r) => r.shortfall_qty > 0)
    .map((r) => ({
      item_id: r.item_id,
      item_number: r.item_number,
      item_name: r.item_name,
      uom: r.uom,
      current_qty: r.current_qty,
      reorder_point: r.reorder_point,
      shortfall_qty: r.shortfall_qty,
      suggested_qty: r.shortfall_qty,
      preferred_supplier_id: null,
      estimated_days_of_cover: r.estimated_days_of_cover,
    }));
  return ok({ candidates, count: candidates.length });
}

// --- US-J07.3: valuation status / drift (OP11 surface) -----------------------------------------

export interface ValuationStatusInput {
  as_of?: string;
  method?: string;
  include_detail?: boolean;
  thresholds?: Partial<Record<keyof AgentThresholds, unknown>>;
}

interface ValuationStatusOut {
  as_of: string;
  method: string | null;
  current_value_rappen: number;
  last_posted_value_rappen: number | null;
  drift_rappen: number;
  drift_pct: number | null;
  last_posted_at: string | null;
  last_run_id: string | null;
  status: 'aligned' | 'drift_present' | 'never_posted';
  detail?: { item_id: string; current_rappen: number }[];
}

/** Compute the valuation status (shared by the verb and the alerts feed). */
function valuationStatus(ctx: WorkspaceContext, input: ValuationStatusInput): { ok: true; value: ValuationStatusOut } | { ok: false; err: Result } {
  const asOfIn = optDay(input.as_of, 'as_of');
  if (!asOfIn.ok) return { ok: false, err: asOfIn.err };
  const asOf = asOfIn.day ?? today(ctx);

  const reportInput: { asOf: string; method?: string } = { asOf };
  if (typeof input.method === 'string' && input.method.length > 0) reportInput.method = input.method;
  const report = inventoryValuationReport(ctx, reportInput);
  if (!report.ok) return { ok: false, err: report };
  const rep = report as unknown as { totalValueRappen?: number; method?: string; lines?: { itemId?: string; valueRappen?: number }[] };
  const current = typeof rep.totalValueRappen === 'number' ? rep.totalValueRappen : 0;
  const method = rep.method ?? null;

  const run = ctx.store.db
    .prepare(
      `SELECT id, total_value_rappen AS totalValueRappen, posted_at AS postedAt
         FROM inventory_valuation_run
        WHERE workspace_id = ? AND status = 'posted' AND as_of <= ?
        ORDER BY as_of DESC, posted_at DESC LIMIT 1`,
    )
    .get(ctx.workspaceId, asOf) as { id: string; totalValueRappen: number; postedAt: string | null } | undefined;

  const lastPosted = run === undefined ? null : run.totalValueRappen;
  const drift = lastPosted === null ? 0 : current - lastPosted;
  const driftPct = lastPosted === null || lastPosted === 0 ? null : Math.round((drift / lastPosted) * 10000) / 100;
  const status: ValuationStatusOut['status'] = lastPosted === null ? 'never_posted' : drift === 0 ? 'aligned' : 'drift_present';

  const value: ValuationStatusOut = {
    as_of: asOf,
    method,
    current_value_rappen: current,
    last_posted_value_rappen: lastPosted,
    drift_rappen: drift,
    drift_pct: driftPct,
    last_posted_at: run?.postedAt ?? null,
    last_run_id: run?.id ?? null,
    status,
  };

  if (input.include_detail === true) {
    const lines = rep.lines ?? [];
    value.detail = lines
      .filter((l) => typeof l.itemId === 'string')
      .map((l) => ({ item_id: l.itemId as string, current_rappen: typeof l.valueRappen === 'number' ? l.valueRappen : 0 }));
  }
  return { ok: true, value };
}

export function inventoryValuationStatus(ctx: WorkspaceContext, input: ValuationStatusInput = {}): Result {
  const capable = ctx.capabilities.assert('read_master_data');
  if (!capable.ok) return capable;
  const res = valuationStatus(ctx, input);
  if (!res.ok) return res.err;
  return ok(res.value as unknown as Record<string, unknown>);
}

// --- US-J07.4: movement history ----------------------------------------------------------------

export interface MovementHistoryInput {
  item_id?: string;
  location_id?: string;
  lot_code?: string;
  serial_number?: string;
  from_date?: string;
  to_date?: string;
  limit?: number;
  offset?: number;
}

/** Resolve a lot code to its lot id for one item (or any item when item_id is absent). */
function resolveLotId(ctx: WorkspaceContext, code: string, itemId?: string): string | undefined {
  const row = itemId !== undefined
    ? (ctx.store.db.prepare('SELECT id FROM lot WHERE workspace_id = ? AND item_id = ? AND lower(number) = ?').get(ctx.workspaceId, itemId, code.toLowerCase()) as { id: string } | undefined)
    : (ctx.store.db.prepare('SELECT id FROM lot WHERE workspace_id = ? AND lower(number) = ? ORDER BY created_at LIMIT 1').get(ctx.workspaceId, code.toLowerCase()) as { id: string } | undefined);
  return row?.id;
}

function resolveSerialId(ctx: WorkspaceContext, number: string, itemId?: string): string | undefined {
  const row = itemId !== undefined
    ? (ctx.store.db.prepare('SELECT id FROM serial WHERE workspace_id = ? AND item_id = ? AND lower(number) = ?').get(ctx.workspaceId, itemId, number.toLowerCase()) as { id: string } | undefined)
    : (ctx.store.db.prepare('SELECT id FROM serial WHERE workspace_id = ? AND lower(number) = ? ORDER BY created_at LIMIT 1').get(ctx.workspaceId, number.toLowerCase()) as { id: string } | undefined);
  return row?.id;
}

export function inventoryMovementHistory(ctx: WorkspaceContext, input: MovementHistoryInput = {}): Result {
  const capable = ctx.capabilities.assert('read_master_data');
  if (!capable.ok) return capable;

  if (typeof input.item_id !== 'string' || input.item_id.length === 0) return err('invalid_input', { field: 'item_id' });
  if (readItem(ctx, input.item_id) === undefined) return err('not_found', { itemId: input.item_id });
  if (typeof input.location_id === 'string' && input.location_id.length > 0 && !locationExists(ctx, input.location_id)) {
    return err('not_found', { locationId: input.location_id });
  }

  const from = optDay(input.from_date, 'from_date');
  if (!from.ok) return from.err;
  const to = optDay(input.to_date, 'to_date');
  if (!to.ok) return to.err;
  if (from.day !== undefined && to.day !== undefined && from.day > to.day) return err('invalid_date_range', { from: from.day, to: to.day });

  const lotId = typeof input.lot_code === 'string' && input.lot_code.length > 0 ? resolveLotId(ctx, input.lot_code, input.item_id) : undefined;
  if (typeof input.lot_code === 'string' && input.lot_code.length > 0 && lotId === undefined) return err('not_found', { lotCode: input.lot_code });
  const serialId = typeof input.serial_number === 'string' && input.serial_number.length > 0 ? resolveSerialId(ctx, input.serial_number, input.item_id) : undefined;
  if (typeof input.serial_number === 'string' && input.serial_number.length > 0 && serialId === undefined) return err('not_found', { serialNumber: input.serial_number });

  // Reuse the J02 list, which already carries a server-computed running balance for a single item and
  // closes to the live position (spec §7 tripwire). J07 adds no second projection.
  const listInput: {
    itemId: string;
    locationId?: string;
    lotId?: string;
    serialId?: string;
    fromDate?: string;
    toDate?: string;
    limit?: number;
    offset?: number;
  } = { itemId: input.item_id };
  if (typeof input.location_id === 'string' && input.location_id.length > 0) listInput.locationId = input.location_id;
  if (lotId !== undefined) listInput.lotId = lotId;
  if (serialId !== undefined) listInput.serialId = serialId;
  if (from.day !== undefined) listInput.fromDate = from.day;
  if (to.day !== undefined) listInput.toDate = to.day;
  if (Number.isInteger(input.limit)) listInput.limit = input.limit as number;
  if (Number.isInteger(input.offset)) listInput.offset = input.offset as number;
  return inventoryMovementList(ctx, listInput);
}

// --- US-J07.7: lot / serial trace --------------------------------------------------------------

export interface LotTraceInput {
  lot_code?: string;
  serial_number?: string;
  item_id?: string;
}

export function inventoryLotTrace(ctx: WorkspaceContext, input: LotTraceInput = {}): Result {
  const capable = ctx.capabilities.assert('read_master_data');
  if (!capable.ok) return capable;

  const hasLot = typeof input.lot_code === 'string' && input.lot_code.length > 0;
  const hasSerial = typeof input.serial_number === 'string' && input.serial_number.length > 0;
  if (!hasLot && !hasSerial) return err('invalid_input', { field: 'lot_code|serial_number' });
  if (typeof input.item_id === 'string' && input.item_id.length > 0 && readItem(ctx, input.item_id) === undefined) {
    return err('not_found', { itemId: input.item_id });
  }

  if (hasSerial) {
    const serial = (input.item_id !== undefined
      ? ctx.store.db.prepare('SELECT id, item_id AS itemId, lot_id AS lotId, number, status, current_location_id AS currentLocationId FROM serial WHERE workspace_id = ? AND item_id = ? AND lower(number) = ?').get(ctx.workspaceId, input.item_id, (input.serial_number as string).toLowerCase())
      : ctx.store.db.prepare('SELECT id, item_id AS itemId, lot_id AS lotId, number, status, current_location_id AS currentLocationId FROM serial WHERE workspace_id = ? AND lower(number) = ? ORDER BY created_at LIMIT 1').get(ctx.workspaceId, (input.serial_number as string).toLowerCase())) as
      | { id: string; itemId: string; lotId: string | null; number: string; status: string; currentLocationId: string | null }
      | undefined;
    // §H-TENANT: a foreign / absent serial is invisible; a soft not-found (not a hard error, US-J07.7).
    if (serial === undefined) return ok({ found: false, kind: 'serial', serialNumber: input.serial_number });
    const history = inventoryMovementList(ctx, { itemId: serial.itemId, serialId: serial.id, limit: 500 });
    const movements = history.ok ? (history as unknown as { items: unknown[] }).items : [];
    return ok({
      found: true,
      kind: 'serial',
      serial: { id: serial.id, itemId: serial.itemId, lotId: serial.lotId, number: serial.number, status: serial.status, currentLocationId: serial.currentLocationId },
      current_positions: serial.currentLocationId === null ? [] : [{ locationId: serial.currentLocationId, qty: serial.status === 'issued' || serial.status === 'scrapped' ? 0 : 1 }],
      movements,
    });
  }

  const lot = (input.item_id !== undefined
    ? ctx.store.db.prepare('SELECT id, item_id AS itemId, number, status, expiry_date AS expiryDate FROM lot WHERE workspace_id = ? AND item_id = ? AND lower(number) = ?').get(ctx.workspaceId, input.item_id, (input.lot_code as string).toLowerCase())
    : ctx.store.db.prepare('SELECT id, item_id AS itemId, number, status, expiry_date AS expiryDate FROM lot WHERE workspace_id = ? AND lower(number) = ? ORDER BY created_at LIMIT 1').get(ctx.workspaceId, (input.lot_code as string).toLowerCase())) as
    | { id: string; itemId: string; number: string; status: string; expiryDate: string | null }
    | undefined;
  if (lot === undefined) return ok({ found: false, kind: 'lot', lotCode: input.lot_code });

  const positions = ctx.store.db
    .prepare(
      `SELECT m.location_id AS locationId, l.name AS locationName, COALESCE(SUM(m.qty), 0) AS qty
         FROM stock_movement m JOIN stock_location l ON l.id = m.location_id
        WHERE m.workspace_id = ? AND m.lot_id = ?
        GROUP BY m.location_id HAVING COALESCE(SUM(m.qty), 0) != 0 ORDER BY l.name`,
    )
    .all(ctx.workspaceId, lot.id) as { locationId: string; locationName: string; qty: number }[];
  const history = inventoryMovementList(ctx, { itemId: lot.itemId, lotId: lot.id, limit: 500 });
  const movements = history.ok ? (history as unknown as { items: unknown[] }).items : [];
  return ok({
    found: true,
    kind: 'lot',
    lot: { id: lot.id, itemId: lot.itemId, number: lot.number, status: lot.status, expiryDate: lot.expiryDate },
    current_positions: positions,
    movements,
  });
}

// --- US-J07.8: slow movers ---------------------------------------------------------------------

export interface SlowMoversInput {
  min_days_no_movement?: number;
  min_value_rappen?: number;
  location_ids?: string[];
  thresholds?: Partial<Record<keyof AgentThresholds, unknown>>;
}

export function inventorySlowMovers(ctx: WorkspaceContext, input: SlowMoversInput = {}): Result {
  const capable = ctx.capabilities.assert('read_master_data');
  if (!capable.ok) return capable;
  const locs = assertIds(ctx, input.location_ids, 'location');
  if (!locs.ok) return locs.err;
  const th = resolveThresholds(input.thresholds);
  const minDays = Number.isInteger(input.min_days_no_movement) && (input.min_days_no_movement as number) >= 0 ? (input.min_days_no_movement as number) : th.slowMoverDays;
  const cutoff = daysBefore(ctx, minDays);
  const now = today(ctx);

  const locFilter = locs.ids.length > 0 ? `AND m.location_id IN (${locs.ids.map(() => '?').join(', ')})` : '';
  const locParams = locs.ids;

  // Items with positive on-hand whose LAST outbound movement (qty < 0) is older than the cutoff, or
  // which have never had one. Slow-moving high-value stock is the candidate for a write-down review
  // (OR 960c); J07 surfaces it and performs no write-down (US-J07.8).
  const rows = ctx.store.db
    .prepare(
      `SELECT i.id AS itemId, i.name AS itemName, i.item_sku AS itemSku, i.unit AS uom,
              COALESCE((SELECT SUM(m.qty) FROM stock_movement m WHERE m.workspace_id = i.workspace_id AND m.item_id = i.id ${locFilter}), 0) AS onHand,
              (SELECT MAX(m2.moved_at) FROM stock_movement m2 WHERE m2.workspace_id = i.workspace_id AND m2.item_id = i.id ${locFilter.replace(/m\./g, 'm2.')}) AS lastMovementAt,
              (SELECT MAX(m3.moved_at) FROM stock_movement m3 WHERE m3.workspace_id = i.workspace_id AND m3.item_id = i.id AND m3.qty < 0 ${locFilter.replace(/m\./g, 'm3.')}) AS lastOutboundAt
         FROM item i
        WHERE i.workspace_id = ? AND i.track_stock = 1
        ORDER BY i.name`,
    )
    .all(...locParams, ...locParams, ...locParams, ctx.workspaceId) as {
    itemId: string;
    itemName: string;
    itemSku: string | null;
    uom: string | null;
    onHand: number;
    lastMovementAt: string | null;
    lastOutboundAt: string | null;
  }[];

  const minValue = Number.isInteger(input.min_value_rappen) ? (input.min_value_rappen as number) : th.largeValueRappen > 0 ? undefined : undefined;
  const out: Record<string, unknown>[] = [];
  for (const r of rows) {
    if (r.onHand <= 0) continue;
    if (r.lastOutboundAt !== null && r.lastOutboundAt > cutoff) continue; // moved recently
    const extended = itemBookValueMinor(ctx, r.itemId);
    if (minValue !== undefined && extended < minValue) continue;
    const idleFrom = r.lastOutboundAt ?? r.lastMovementAt;
    out.push({
      item_id: r.itemId,
      item_number: r.itemSku,
      item_name: r.itemName,
      uom: r.uom,
      current_qty: r.onHand,
      last_movement_at: r.lastMovementAt,
      last_outbound_at: r.lastOutboundAt,
      days_idle: idleFrom === null ? null : daysBetween(now, idleFrom.slice(0, 10)),
      unit_cost_rappen: r.onHand > 0 ? Math.round(extended / r.onHand) : null,
      extended_value_rappen: extended,
    });
  }
  out.sort((a, b) => (b.extended_value_rappen as number) - (a.extended_value_rappen as number));
  return ok({ items: out, count: out.length, min_days_no_movement: minDays });
}

// --- US-J07.5 / US-J07.9: anomalies & unified alerts -------------------------------------------

interface Alert {
  alert_key: string;
  type: AnomalyType;
  severity: Severity;
  title: string;
  summary: string;
  entity: { item_id?: string; location_id?: string; lot_code?: string; session_id?: string; movement_id?: string };
  detected_at: string;
  suggested_action?: string;
  payload?: Record<string, unknown>;
}

export interface AnomaliesInput {
  since?: string;
  types?: string[];
  severity?: string[];
  limit?: number;
  thresholds?: Partial<Record<keyof AgentThresholds, unknown>>;
}

/** The shared anomaly core (spec §2 US-J07.5): derived exception events, deterministic per snapshot. */
function anomalyList(ctx: WorkspaceContext, input: AnomaliesInput): { ok: true; alerts: Alert[] } | { ok: false; err: Result } {
  const sinceIn = optDay(input.since, 'since');
  if (!sinceIn.ok) return { ok: false, err: sinceIn.err };
  const th = resolveThresholds(input.thresholds);
  const since = sinceIn.day ?? daysBefore(ctx, th.anomalySinceDays);
  const now = ctx.clock.now();
  const alerts: Alert[] = [];

  // negative_stock: a current (item, location) on-hand below zero. On-hand is SUM over the ledger, so
  // this is a live read, never a stored flag.
  const negatives = ctx.store.db
    .prepare(
      `SELECT m.item_id AS itemId, i.name AS itemName, m.location_id AS locationId, COALESCE(SUM(m.qty), 0) AS qty
         FROM stock_movement m JOIN item i ON i.id = m.item_id
        WHERE m.workspace_id = ?
        GROUP BY m.item_id, m.location_id HAVING COALESCE(SUM(m.qty), 0) < 0`,
    )
    .all(ctx.workspaceId) as { itemId: string; itemName: string; locationId: string; qty: number }[];
  for (const n of negatives) {
    alerts.push({
      alert_key: alertKey('negative_stock', [n.itemId, n.locationId]),
      type: 'negative_stock',
      severity: 'critical',
      title: 'Negative stock',
      summary: `${n.itemName}: ${n.qty}`,
      entity: { item_id: n.itemId, location_id: n.locationId },
      detected_at: now,
      suggested_action: 'investigate_movements',
      payload: { qty: n.qty },
    });
  }

  // large_issue / large_adjustment / unlinked_high_value_issue: over movements since the window.
  const movements = ctx.store.db
    .prepare(
      `SELECT m.id AS id, m.item_id AS itemId, i.name AS itemName, m.location_id AS locationId,
              m.qty AS qty, m.unit_cost_minor AS unitCostMinor, m.cost_amount_minor AS costAmountMinor,
              COALESCE(m.movement_type, m.reason) AS type, m.ref_id AS refId, m.moved_at AS movedAt
         FROM stock_movement m JOIN item i ON i.id = m.item_id
        WHERE m.workspace_id = ? AND m.moved_at >= ?
        ORDER BY m.moved_at DESC, m.id DESC`,
    )
    .all(ctx.workspaceId, since) as {
    id: string;
    itemId: string;
    itemName: string;
    locationId: string;
    qty: number;
    unitCostMinor: number | null;
    costAmountMinor: number | null;
    type: string;
    refId: string | null;
    movedAt: string;
  }[];
  for (const m of movements) {
    const absQty = Math.abs(m.qty);
    const extended = Math.abs((m.unitCostMinor ?? 0) * m.qty) + Math.abs(m.costAmountMinor ?? 0);
    const isIssue = m.qty < 0 && (m.type === 'issue' || m.type === 'scrap' || m.type === 'transfer_out');
    const isAdjustment = m.type === 'adjustment' || m.type === 'adjust';
    if (isAdjustment && (absQty >= th.largeQty || extended >= th.largeValueRappen)) {
      alerts.push({
        alert_key: alertKey('large_adjustment', [m.id]),
        type: 'large_adjustment',
        severity: extended >= th.largeValueRappen ? 'critical' : 'warning',
        title: 'Large adjustment',
        summary: `${m.itemName}: ${m.qty}`,
        entity: { item_id: m.itemId, location_id: m.locationId, movement_id: m.id },
        detected_at: now,
        suggested_action: 'review_adjustment',
        payload: { qty: m.qty, extendedValueRappen: extended, movedAt: m.movedAt },
      });
    } else if (isIssue && (absQty >= th.largeQty || extended >= th.largeValueRappen)) {
      alerts.push({
        alert_key: alertKey('large_issue', [m.id]),
        type: 'large_issue',
        severity: extended >= th.largeValueRappen ? 'critical' : 'warning',
        title: 'Large issue',
        summary: `${m.itemName}: ${m.qty}`,
        entity: { item_id: m.itemId, location_id: m.locationId, movement_id: m.id },
        detected_at: now,
        suggested_action: 'review_issue',
        payload: { qty: m.qty, extendedValueRappen: extended, movedAt: m.movedAt },
      });
    }
    if (isIssue && m.refId === null && extended >= th.largeValueRappen) {
      alerts.push({
        alert_key: alertKey('unlinked_high_value_issue', [m.id]),
        type: 'unlinked_high_value_issue',
        severity: 'warning',
        title: 'Unlinked high-value issue',
        summary: `${m.itemName}: ${m.qty}`,
        entity: { item_id: m.itemId, location_id: m.locationId, movement_id: m.id },
        detected_at: now,
        suggested_action: 'link_source_document',
        payload: { qty: m.qty, extendedValueRappen: extended },
      });
    }
  }

  // valuation_drift: the OP11 surface, reused so a drift alert cannot disagree with the status verb.
  const vs = valuationStatus(ctx, passThresholds(input.thresholds));
  if (vs.ok && vs.value.status === 'drift_present') {
    const abs = Math.abs(vs.value.drift_rappen);
    const pct = vs.value.drift_pct === null ? 0 : Math.abs(vs.value.drift_pct);
    if (abs >= th.driftAbsRappen || pct >= th.driftPct) {
      alerts.push({
        alert_key: alertKey('valuation_drift', [vs.value.last_run_id]),
        type: 'valuation_drift',
        severity: 'warning',
        title: 'Valuation drift',
        summary: `${vs.value.drift_rappen} Rappen`,
        entity: {},
        detected_at: now,
        suggested_action: 'run_valuation',
        payload: { driftRappen: vs.value.drift_rappen, driftPct: vs.value.drift_pct, lastRunId: vs.value.last_run_id },
      });
    }
  }

  // open_stocktake_overdue: a J04 session open past the overdue window (reuses the J04 list).
  const sessions = inventoryStocktakeList(ctx, { status: ['open'] });
  if (sessions.ok) {
    for (const s of (sessions as unknown as { sessions: Record<string, unknown>[] }).sessions) {
      const freezeAt = typeof s.freezeAt === 'string' ? (s.freezeAt as string).slice(0, 10) : null;
      if (freezeAt !== null && daysBetween(today(ctx), freezeAt) > th.stocktakeOverdueDays) {
        alerts.push({
          alert_key: alertKey('open_stocktake_overdue', [String(s.id)]),
          type: 'open_stocktake_overdue',
          severity: 'warning',
          title: 'Overdue stocktake',
          summary: String(s.id),
          entity: { session_id: String(s.id) },
          detected_at: now,
          suggested_action: 'complete_stocktake',
          payload: { freezeAt, daysOpen: daysBetween(today(ctx), freezeAt) },
        });
      }
    }
  }

  // lot_near_expiry: an open lot with expiry inside the warning window and positive on-hand.
  const warnUntil = daysBefore(ctx, -th.lotExpiryWarningDays); // today + window
  const lots = ctx.store.db
    .prepare(
      `SELECT lo.id AS id, lo.item_id AS itemId, lo.number AS number, lo.expiry_date AS expiryDate,
              COALESCE((SELECT SUM(m.qty) FROM stock_movement m WHERE m.workspace_id = lo.workspace_id AND m.lot_id = lo.id), 0) AS onHand
         FROM lot lo
        WHERE lo.workspace_id = ? AND lo.status = 'open' AND lo.expiry_date IS NOT NULL AND lo.expiry_date <= ?
        ORDER BY lo.expiry_date`,
    )
    .all(ctx.workspaceId, warnUntil) as { id: string; itemId: string; number: string; expiryDate: string; onHand: number }[];
  for (const lo of lots) {
    if (lo.onHand <= 0) continue;
    const expired = lo.expiryDate < today(ctx);
    alerts.push({
      alert_key: alertKey('lot_near_expiry', [lo.id]),
      type: 'lot_near_expiry',
      severity: expired ? 'critical' : 'warning',
      title: expired ? 'Lot expired' : 'Lot near expiry',
      summary: `${lo.number}: ${lo.expiryDate}`,
      entity: { item_id: lo.itemId, lot_code: lo.number },
      detected_at: now,
      suggested_action: 'review_lot',
      payload: { expiryDate: lo.expiryDate, onHand: lo.onHand, expired },
    });
  }

  return { ok: true, alerts: filterAlerts(alerts, input.types, input.severity, input.limit) };
}

/** Apply the type / severity / limit filters shared by anomalies and the unified feed. */
function filterAlerts(alerts: Alert[], types: unknown, severity: unknown, limit: unknown): Alert[] {
  let out = alerts;
  if (Array.isArray(types) && types.length > 0) {
    const wanted = new Set(types.filter((t): t is string => typeof t === 'string'));
    out = out.filter((a) => wanted.has(a.type));
  }
  if (Array.isArray(severity) && severity.length > 0) {
    const wanted = new Set(severity.filter((s): s is string => typeof s === 'string'));
    out = out.filter((a) => wanted.has(a.severity));
  }
  const rank: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };
  out = [...out].sort((a, b) => rank[a.severity] - rank[b.severity]);
  const lim = Number.isInteger(limit) && (limit as number) > 0 ? (limit as number) : undefined;
  return lim === undefined ? out : out.slice(0, lim);
}

export function inventoryAnomalies(ctx: WorkspaceContext, input: AnomaliesInput = {}): Result {
  const capable = ctx.capabilities.assert('read_master_data');
  if (!capable.ok) return capable;
  const res = anomalyList(ctx, input);
  if (!res.ok) return res.err;
  return ok({ anomalies: res.alerts, counts_by_severity: countBySeverity(res.alerts) });
}

function countBySeverity(alerts: Alert[]): Record<string, number> {
  const out: Record<string, number> = { info: 0, warning: 0, critical: 0 };
  for (const a of alerts) out[a.severity] = (out[a.severity] ?? 0) + 1;
  return out;
}

export interface AlertsInput {
  severity?: string[];
  types?: string[];
  limit?: number;
  thresholds?: Partial<Record<keyof AgentThresholds, unknown>>;
}

/**
 * The unified alerts feed (US-J07.9): low-stock, anomalies, overdue stocktakes, valuation drift and
 * near-expiry lots merged, de-duplicated by `alert_key` and prioritised by severity. Pure computation;
 * no persistent alert store in Phase 1.
 */
export function inventoryAlerts(ctx: WorkspaceContext, input: AlertsInput = {}): Result {
  const capable = ctx.capabilities.assert('read_master_data');
  if (!capable.ok) return capable;

  const anomalies = anomalyList(ctx, passThresholds(input.thresholds));
  if (!anomalies.ok) return anomalies.err;
  const low = lowStockRows(ctx, passThresholds(input.thresholds));
  if (!low.ok) return low.err;

  const now = ctx.clock.now();
  const merged: Alert[] = [...anomalies.alerts];
  for (const r of low.rows) {
    merged.push({
      alert_key: alertKey('low_stock', [r.item_id]),
      type: 'low_stock',
      severity: r.current_qty <= 0 ? 'critical' : 'warning',
      title: 'Low stock',
      summary: `${r.item_name}: ${r.current_qty}/${r.reorder_point}`,
      entity: { item_id: r.item_id },
      detected_at: now,
      suggested_action: 'create_requisition',
      payload: { currentQty: r.current_qty, reorderPoint: r.reorder_point, shortfall: r.shortfall_qty },
    });
  }

  // De-dupe by alert_key (a low-stock item that is also negative would collide only across types, so
  // the key already carries the type; this guards a doubled source).
  const seen = new Set<string>();
  const deduped: Alert[] = [];
  for (const a of merged) {
    if (seen.has(a.alert_key)) continue;
    seen.add(a.alert_key);
    deduped.push(a);
  }

  const final = filterAlerts(deduped, input.types, input.severity, input.limit);
  return ok({ alerts: final, counts_by_severity: countBySeverity(final) });
}

// --- US-J07.6: cycle-count / stocktake status --------------------------------------------------

export interface CycleCountStatusInput {
  status?: string[];
  warehouse_ids?: string[];
  overdue_only?: boolean;
  thresholds?: Partial<Record<keyof AgentThresholds, unknown>>;
}

export function inventoryCycleCountStatus(ctx: WorkspaceContext, input: CycleCountStatusInput = {}): Result {
  const capable = ctx.capabilities.assert('read_master_data');
  if (!capable.ok) return capable;
  const whs = assertIds(ctx, input.warehouse_ids, 'warehouse');
  if (!whs.ok) return whs.err;
  const th = resolveThresholds(input.thresholds);

  // One list call per requested warehouse (the J04 list takes a single warehouseId), merged. With no
  // warehouse filter, one unscoped call. Reuses the J04 read model rather than re-querying the tables.
  const statuses = Array.isArray(input.status) ? input.status.filter((s): s is string => typeof s === 'string') : undefined;
  const scopes = whs.ids.length > 0 ? whs.ids.map((id) => ({ warehouseId: id })) : [{}];
  const rawSessions: Record<string, unknown>[] = [];
  for (const scope of scopes) {
    const listInput: { status?: string[]; warehouseId?: string } = { ...scope };
    if (statuses !== undefined && statuses.length > 0) listInput.status = statuses;
    const res = inventoryStocktakeList(ctx, listInput);
    if (!res.ok) return res;
    rawSessions.push(...(res as unknown as { sessions: Record<string, unknown>[] }).sessions);
  }

  const now = today(ctx);
  const sessions = rawSessions
    .map((s) => {
      const freezeAt = typeof s.freezeAt === 'string' ? (s.freezeAt as string).slice(0, 10) : null;
      const isOpen = s.status === 'open';
      const daysOpen = freezeAt === null ? null : daysBetween(now, freezeAt);
      const overdue = isOpen && daysOpen !== null && daysOpen > th.stocktakeOverdueDays;
      const total = typeof s.totalLines === 'number' ? (s.totalLines as number) : 0;
      const counted = typeof s.countedLines === 'number' ? (s.countedLines as number) : 0;
      return {
        session_id: s.id,
        status: s.status,
        type: s.type,
        freeze_at: freezeAt,
        warehouse_id: s.warehouseId ?? null,
        line_count: total,
        counted_count: counted,
        uncounted_count: Math.max(0, total - counted),
        review_required_count: typeof s.reviewRequiredLines === 'number' ? s.reviewRequiredLines : 0,
        committed_at: s.committedAt ?? null,
        inventar_document_id: s.inventarDocumentId ?? null,
        days_open: daysOpen,
        overdue,
        // Variance quantity / value need the per-session report; deliberately left null in Phase 1
        // rather than fanning a report call per session (spec reconcile note).
        variance_qty: null,
        variance_value_rappen: null,
      };
    })
    .filter((s) => input.overdue_only !== true || s.overdue);

  return ok({ sessions, count: sessions.length });
}
