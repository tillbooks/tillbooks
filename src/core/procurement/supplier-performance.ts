/**
 * I05, SUPPLIER PERFORMANCE: a PURE READ MODEL over the live I01/I02/D02 procurement documents.
 *
 * THIS MODULE WRITES NOTHING. No table, no column, no INSERT, no UPDATE, no cache. Every figure is
 * recomputed from the source rows on each call, so a scorecard is referentially transparent: the same
 * live data yields the identical result, and "a receipt was reversed" changes the answer on the next
 * read with no invalidation step. The module imports neither `postEntry` nor any writer, and its only
 * SQL verbs are SELECTs. That no-write posture is asserted STRUCTURALLY (by absence) in
 * `test/procurement/supplier-performance.test.mjs`, the C03 forecast precedent, rather than merely
 * promised in prose.
 *
 * WHERE THE NUMBERS COME FROM (spec §0 reconciliation):
 *   - Delivery reliability and quantity accuracy derive from the I02 goods-receipt document
 *     (`goods_receipt_doc` + `goods_receipt_doc_line`), joined to the D02 `po_line` for the ordered
 *     quantity and to `purchase_order` for the expected date fallback. Only POSTED receipts count; a
 *     draft, reversed or cancelled receipt is excluded by construction.
 *   - Price fidelity and override behaviour derive from the SHIPPED three-way-match trail, D02's
 *     append-only `po_match` row (`price_variance_rappen`, `expected_base_rappen`, `status`,
 *     `overridden_by`), which every A17 bill match already writes. The parity-lane I04 module was
 *     being built concurrently and is not imported here; when it lands a richer per-line match, the
 *     two `loadMatches*` readers below are the ONE place that changes.
 *
 * CONFIGURATION is a default constant (`DEFAULT_PERFORMANCE_CONFIG`, the spec §4 values) plus an
 * optional per-call `configOverride` for what-if evaluation. A pure read that owns no write path
 * cannot persist workspace weights without becoming a writer; a persisted config surface, if wanted,
 * is a later additive capability and does not change these reads.
 *
 * §H-TENANT: every query filters `workspace_id = ctx.workspaceId`, and a supplier id that belongs to
 * another tenant is simply invisible (the scorecard reader returns `not_found`, which IS the tenant
 * denial: a foreign row cannot be named). Asserted in tests.
 *
 * ARITHMETIC (P2): percentages are computed as round-half-away-from-zero to one decimal over integer
 * numerator/denominator, so a scorecard's numbers are hand-calculable from the contributing rows and
 * reproduce exactly. Money (spend, price variance) stays integer Rappen and is never floated.
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';

/** The stable metric vocabulary (§H-ENUM). The Studio mirror reads this exact list. */
export const PERFORMANCE_METRICS = [
  'otif_pct',
  'on_time_pct',
  'in_full_pct',
  'avg_delay_days',
  'qty_variance_pct',
  'price_variance_pct',
  'match_override_rate',
  'rejection_rate',
  'overall_score',
] as const;
export type MetricId = (typeof PERFORMANCE_METRICS)[number];

/** The unit each metric is expressed in, for the GUI and the explain formula. */
export const METRIC_UNIT: Record<MetricId, 'pct' | 'days' | 'score'> = {
  otif_pct: 'pct',
  on_time_pct: 'pct',
  in_full_pct: 'pct',
  avg_delay_days: 'days',
  qty_variance_pct: 'pct',
  price_variance_pct: 'pct',
  match_override_rate: 'pct',
  rejection_rate: 'pct',
  overall_score: 'score',
};

/** Whether a HIGHER raw value is better (delivery %) or a LOWER one is (variance, delay, rejection). */
const HIGHER_IS_BETTER: Record<MetricId, boolean> = {
  otif_pct: true,
  on_time_pct: true,
  in_full_pct: true,
  avg_delay_days: false,
  qty_variance_pct: false,
  price_variance_pct: false,
  match_override_rate: false,
  rejection_rate: false,
  overall_score: true,
};

export function isMetricId(v: unknown): v is MetricId {
  return typeof v === 'string' && (PERFORMANCE_METRICS as readonly string[]).includes(v);
}

/** The workspace performance configuration (spec §4). Weights sum to 100 over the scored metrics. */
export interface PerformanceConfig {
  evaluationWindowDays: number;
  onTimeToleranceDays: number;
  shortShipmentTolPct: number;
  /** avg_delay_days at or above this normalises to 0; the cap that turns a day count into a 0-100 score. */
  delayCapDays: number;
  weights: Partial<Record<MetricId, number>>;
  alertThresholds: Partial<Record<MetricId, number>>;
  minActivityForRank: number;
}

/** The spec §4 defaults. Weights over otif / price / override / rejection / delay sum to 100. */
export const DEFAULT_PERFORMANCE_CONFIG: PerformanceConfig = {
  evaluationWindowDays: 90,
  onTimeToleranceDays: 2,
  shortShipmentTolPct: 2,
  delayCapDays: 10,
  weights: {
    otif_pct: 40,
    price_variance_pct: 25,
    match_override_rate: 15,
    rejection_rate: 10,
    avg_delay_days: 10,
  },
  alertThresholds: {
    overall_score: 70,
    otif_pct: 85,
  },
  minActivityForRank: 3,
};

/** A shallow-but-nested merge of a caller override onto the workspace default. */
export type PerformanceConfigOverride = {
  [K in keyof PerformanceConfig]?: PerformanceConfig[K] extends Record<string, unknown>
    ? Partial<PerformanceConfig[K]>
    : PerformanceConfig[K];
};

function resolveConfig(override: PerformanceConfigOverride | undefined): PerformanceConfig {
  const base = DEFAULT_PERFORMANCE_CONFIG;
  if (override === undefined || override === null || typeof override !== 'object') return base;
  return {
    evaluationWindowDays: numOr(override.evaluationWindowDays, base.evaluationWindowDays),
    onTimeToleranceDays: numOr(override.onTimeToleranceDays, base.onTimeToleranceDays),
    shortShipmentTolPct: numOr(override.shortShipmentTolPct, base.shortShipmentTolPct),
    delayCapDays: Math.max(1, numOr(override.delayCapDays, base.delayCapDays)),
    weights: { ...base.weights, ...(isObj(override.weights) ? override.weights : {}) },
    alertThresholds: { ...base.alertThresholds, ...(isObj(override.alertThresholds) ? override.alertThresholds : {}) },
    minActivityForRank: numOr(override.minActivityForRank, base.minActivityForRank),
  };
}

function isObj(v: unknown): v is Record<string, number> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function numOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

const DAY_MS = 86_400_000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Whole calendar days from `a` to `b` (UTC midnight parse). Negative when b precedes a. */
function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);
}

/** `d` shifted by `n` days, as YYYY-MM-DD. */
function shiftDate(d: string, n: number): string {
  return new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

/** Integer-exact percentage rounded HALF AWAY FROM ZERO to one decimal, or null on an empty denominator. */
function pct1(numer: number, denom: number): number | null {
  if (denom === 0) return null;
  return roundTo(1, (numer * 100) / denom);
}
/** Half-away-from-zero rounding to `decimals` places, the C03 convention. */
function roundTo(decimals: number, x: number): number {
  const f = 10 ** decimals;
  return Math.sign(x) * Math.round(Math.abs(x) * f) / f;
}
function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

/** A resolved evaluation window. `windowDays` is informational (from/to are authoritative). */
export interface Window {
  from: string;
  to: string;
  windowDays: number;
}

/**
 * Resolve from/to/window_days into a concrete [from, to] window. Explicit from/to win; otherwise a
 * rolling `window_days` (or the config default) ends at `asOf` (or the clock's today).
 */
export function resolveWindow(
  ctx: WorkspaceContext,
  input: { from?: unknown; to?: unknown; windowDays?: unknown; asOf?: unknown },
  cfg: PerformanceConfig,
): Result<{ window: Window }> {
  const today = ctx.clock.now().slice(0, 10);
  const asOf = typeof input.asOf === 'string' && DATE_RE.test(input.asOf) ? input.asOf : today;
  const fromIn = typeof input.from === 'string' && input.from.length > 0 ? input.from.slice(0, 10) : null;
  const toIn = typeof input.to === 'string' && input.to.length > 0 ? input.to.slice(0, 10) : null;
  if (fromIn !== null && !DATE_RE.test(fromIn)) return err('invalid_input', { field: 'from' });
  if (toIn !== null && !DATE_RE.test(toIn)) return err('invalid_input', { field: 'to' });
  const windowDays = Math.max(1, Math.trunc(numOr(input.windowDays, cfg.evaluationWindowDays)));
  if (fromIn !== null && toIn !== null) {
    if (daysBetween(fromIn, toIn) < 0) return err('invalid_input', { field: 'to', reason: 'to_before_from' });
    return ok({ window: { from: fromIn, to: toIn, windowDays: daysBetween(fromIn, toIn) + 1 } });
  }
  const to = toIn ?? asOf;
  const from = fromIn ?? shiftDate(to, -(windowDays - 1));
  return ok({ window: { from, to, windowDays } });
}

// --- Row loaders (pure, tenant-scoped SELECTs) ------------------------------------------------------

interface SupplierRow {
  id: string;
  name: string;
}
function loadSupplier(ctx: WorkspaceContext, supplierId: string): SupplierRow | undefined {
  return ctx.store.db
    .prepare('SELECT id, name FROM contact WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, supplierId) as SupplierRow | undefined;
}

interface ReceiptLineRow {
  gr_id: string;
  gr_number: string;
  po_id: string;
  po_line_id: string;
  received_at: string;
  /** COALESCE(receipt expected, PO expected): the date the delivery was due, or null when neither exists. */
  expected_at: string | null;
  qty: number;
  ordered_qty: number;
  unit_cost_rappen: number;
  inspection_status: string;
}

/**
 * Every POSTED receipt line for a supplier inside the window, with its due date and ordered quantity.
 * A draft / reversed / cancelled receipt is excluded (only `status = 'posted'`), which is what makes
 * "a reversed GR leaves the calculation" true by construction (spec §7).
 */
function loadReceiptLines(ctx: WorkspaceContext, supplierId: string, w: Window): ReceiptLineRow[] {
  return ctx.store.db
    .prepare(
      `SELECT d.id AS gr_id, d.number AS gr_number, d.po_id AS po_id, l.po_line_id AS po_line_id,
              d.received_at AS received_at,
              COALESCE(d.expected_at, po.expected_on) AS expected_at,
              l.qty AS qty, pl.qty AS ordered_qty, l.unit_cost_rappen AS unit_cost_rappen,
              l.inspection_status AS inspection_status
         FROM goods_receipt_doc d
         JOIN goods_receipt_doc_line l ON l.workspace_id = d.workspace_id AND l.gr_id = d.id
         JOIN po_line pl ON pl.workspace_id = d.workspace_id AND pl.id = l.po_line_id
         JOIN purchase_order po ON po.workspace_id = d.workspace_id AND po.id = d.po_id
        WHERE d.workspace_id = ?
          AND d.supplier_contact_id = ?
          AND d.status = 'posted'
          AND d.received_at >= ? AND d.received_at <= ?
        ORDER BY d.received_at, d.id, l.line_no`,
    )
    .all(ctx.workspaceId, supplierId, w.from, w.to) as ReceiptLineRow[];
}

interface MatchRow {
  id: string;
  po_id: string;
  bill_id: string;
  status: string;
  price_variance_rappen: number;
  expected_base_rappen: number;
  overridden_by: string | null;
  matched_at: string;
}

/**
 * Every D02 three-way-match row for a supplier inside the window. Matched at `matched_at`; joined
 * through the PO to the supplier. All three statuses (matched | variance | overridden) count: a
 * variance that persisted is exactly the exception this metric is meant to surface.
 */
function loadMatches(ctx: WorkspaceContext, supplierId: string, w: Window): MatchRow[] {
  return ctx.store.db
    .prepare(
      `SELECT m.id AS id, m.po_id AS po_id, m.bill_id AS bill_id, m.status AS status,
              m.price_variance_rappen AS price_variance_rappen, m.expected_base_rappen AS expected_base_rappen,
              m.overridden_by AS overridden_by, m.matched_at AS matched_at
         FROM po_match m
         JOIN purchase_order po ON po.workspace_id = m.workspace_id AND po.id = m.po_id
        WHERE m.workspace_id = ?
          AND po.supplier_contact_id = ?
          AND m.matched_at >= ? AND m.matched_at <= ?
        ORDER BY m.matched_at, m.id`,
    )
    .all(ctx.workspaceId, supplierId, w.from, `${w.to}T23:59:59Z`) as MatchRow[];
}

/** The distinct suppliers with any posted receipt OR any match inside the window (for rank / alerts). */
function loadActiveSupplierIds(ctx: WorkspaceContext, w: Window): string[] {
  const rows = ctx.store.db
    .prepare(
      `SELECT DISTINCT supplier_contact_id AS id FROM goods_receipt_doc
        WHERE workspace_id = ? AND status = 'posted' AND received_at >= ? AND received_at <= ?
        UNION
       SELECT DISTINCT po.supplier_contact_id AS id FROM po_match m
         JOIN purchase_order po ON po.workspace_id = m.workspace_id AND po.id = m.po_id
        WHERE m.workspace_id = ? AND m.matched_at >= ? AND m.matched_at <= ?`,
    )
    .all(ctx.workspaceId, w.from, w.to, ctx.workspaceId, w.from, `${w.to}T23:59:59Z`) as { id: string }[];
  return rows.map((r) => r.id);
}

// --- Metric computation (pure over the loaded rows) -------------------------------------------------

/** A line that counts toward delivery / quantity metrics: posted and inspection none/accepted. */
function isEvaluated(line: ReceiptLineRow): boolean {
  return line.inspection_status === 'none' || line.inspection_status === 'accepted';
}
/** A line that reached an inspection decision (excludes still-pending), the rejection-rate denominator. */
function isDecided(line: ReceiptLineRow): boolean {
  return (
    line.inspection_status === 'none' ||
    line.inspection_status === 'accepted' ||
    line.inspection_status === 'rejected'
  );
}

export interface RawMetrics {
  values: Record<MetricId, number | null>;
  receipts: number;
  lines: number;
  matches: number;
  activityCount: number;
  spendRappen: number;
}

/** Compute every metric (null where there is no data for it) plus the counts, purely over the rows. */
export function computeMetrics(lines: ReceiptLineRow[], matches: MatchRow[], cfg: PerformanceConfig): RawMetrics {
  const evaluated = lines.filter(isEvaluated);
  const decided = lines.filter(isDecided);
  const withDue = evaluated.filter((l) => l.expected_at !== null && DATE_RE.test(String(l.expected_at)));

  // Delivery timing.
  let onTime = 0;
  let delaySum = 0;
  for (const l of withDue) {
    const delay = daysBetween(String(l.expected_at), l.received_at);
    if (delay <= cfg.onTimeToleranceDays) onTime += 1;
    if (delay > 0) delaySum += delay;
  }

  // Quantity fill.
  const shortTol = cfg.shortShipmentTolPct / 100;
  let inFull = 0;
  let qtyVarSumTenths = 0; // sum of abs((recv-ord)/ord) in per-mille to keep it integer-ish, then /10 later
  let qtyVarCount = 0;
  const inFullByLine = new Map<ReceiptLineRow, boolean>();
  for (const l of evaluated) {
    const full = l.ordered_qty > 0 ? l.qty >= l.ordered_qty * (1 - shortTol) : true;
    inFullByLine.set(l, full);
    if (full) inFull += 1;
    if (l.ordered_qty > 0) {
      qtyVarSumTenths += Math.abs((l.qty - l.ordered_qty) / l.ordered_qty) * 1000;
      qtyVarCount += 1;
    }
  }

  // OTIF: both on-time and in-full, over the lines that HAVE a due date.
  let otif = 0;
  for (const l of withDue) {
    const delay = daysBetween(String(l.expected_at), l.received_at);
    const onTimeLine = delay <= cfg.onTimeToleranceDays;
    if (onTimeLine && (inFullByLine.get(l) ?? false)) otif += 1;
  }

  // Rejection.
  const rejected = decided.filter((l) => l.inspection_status === 'rejected').length;

  // Matches.
  const priced = matches.filter((m) => m.expected_base_rappen !== 0);
  const priceVarSum = priced.reduce(
    (s, m) => s + Math.abs(m.price_variance_rappen) / Math.abs(m.expected_base_rappen),
    0,
  );
  const overridden = matches.filter((m) => m.status === 'overridden' || m.overridden_by !== null).length;

  const spendRappen = evaluated.reduce((s, l) => s + l.qty * l.unit_cost_rappen, 0);

  const values: Record<MetricId, number | null> = {
    otif_pct: pct1(otif, withDue.length),
    on_time_pct: pct1(onTime, withDue.length),
    in_full_pct: pct1(inFull, evaluated.length),
    avg_delay_days: withDue.length === 0 ? null : roundTo(1, delaySum / withDue.length),
    qty_variance_pct: qtyVarCount === 0 ? null : roundTo(1, qtyVarSumTenths / 1000 / qtyVarCount * 100),
    price_variance_pct: priced.length === 0 ? null : roundTo(1, (priceVarSum / priced.length) * 100),
    match_override_rate: pct1(overridden, matches.length),
    rejection_rate: pct1(rejected, decided.length),
    overall_score: null, // filled below
  };

  values.overall_score = overallScore(values, cfg);

  // Distinct posted receipts is the activity count the min-activity filter reads.
  const receipts = new Set(lines.map((l) => l.gr_id)).size;

  return {
    values,
    receipts,
    lines: evaluated.length,
    matches: matches.length,
    activityCount: receipts,
    spendRappen,
  };
}

/** Normalise one metric's raw value to a 0-100 goodness score (higher is always better). */
export function normalise(metric: MetricId, value: number, cfg: PerformanceConfig): number {
  if (metric === 'avg_delay_days') return clamp(100 * (1 - value / cfg.delayCapDays), 0, 100);
  if (HIGHER_IS_BETTER[metric]) return clamp(value, 0, 100);
  // Lower-is-better percentages: 0 % variance -> 100, 100 %+ -> 0.
  return clamp(100 - value, 0, 100);
}

/**
 * The weighted 0-100 score. Only metrics that are present (non-null) AND carry a weight contribute,
 * and the weights are renormalised over the present set, so a supplier with no matches is scored on
 * the metrics it does have rather than penalised for a gap in the data.
 */
export function overallScore(values: Record<MetricId, number | null>, cfg: PerformanceConfig): number | null {
  let weightSum = 0;
  let acc = 0;
  for (const metric of PERFORMANCE_METRICS) {
    if (metric === 'overall_score') continue;
    const weight = cfg.weights[metric];
    const value = values[metric];
    if (weight === undefined || weight <= 0 || value === null) continue;
    acc += normalise(metric, value, cfg) * weight;
    weightSum += weight;
  }
  if (weightSum === 0) return null;
  return roundTo(1, acc / weightSum);
}

/** Green / amber / red from the normalised goodness of a metric value (uniform, threshold-free band). */
export function trafficLight(metric: MetricId, value: number | null, cfg: PerformanceConfig): 'green' | 'amber' | 'red' | 'none' {
  if (value === null) return 'none';
  const norm = metric === 'overall_score' ? value : normalise(metric, value, cfg);
  if (norm >= 85) return 'green';
  if (norm >= 70) return 'amber';
  return 'red';
}

// --- Exceptions (top contributors, for the scorecard drill-down) ------------------------------------

export interface ScorecardException {
  kind: 'late_delivery' | 'short_shipment' | 'price_override' | 'rejection';
  receiptId?: string;
  receiptNumber?: string;
  poId?: string;
  matchId?: string;
  billId?: string;
  detail: Record<string, number | string>;
}

function collectExceptions(lines: ReceiptLineRow[], matches: MatchRow[], cfg: PerformanceConfig): ScorecardException[] {
  const out: ScorecardException[] = [];
  const shortTol = cfg.shortShipmentTolPct / 100;
  for (const l of lines) {
    if (l.inspection_status === 'rejected') {
      out.push({ kind: 'rejection', receiptId: l.gr_id, receiptNumber: l.gr_number, poId: l.po_id, detail: { qty: l.qty } });
      continue;
    }
    if (!isEvaluated(l)) continue;
    if (l.expected_at !== null && DATE_RE.test(String(l.expected_at))) {
      const delay = daysBetween(String(l.expected_at), l.received_at);
      if (delay > cfg.onTimeToleranceDays) {
        out.push({
          kind: 'late_delivery',
          receiptId: l.gr_id,
          receiptNumber: l.gr_number,
          poId: l.po_id,
          detail: { delayDays: delay, expectedAt: String(l.expected_at), receivedAt: l.received_at },
        });
      }
    }
    if (l.ordered_qty > 0 && l.qty < l.ordered_qty * (1 - shortTol)) {
      out.push({
        kind: 'short_shipment',
        receiptId: l.gr_id,
        receiptNumber: l.gr_number,
        poId: l.po_id,
        detail: { received: l.qty, ordered: l.ordered_qty, short: l.ordered_qty - l.qty },
      });
    }
  }
  for (const m of matches) {
    if (m.status === 'overridden' || m.overridden_by !== null) {
      out.push({
        kind: 'price_override',
        matchId: m.id,
        poId: m.po_id,
        billId: m.bill_id,
        detail: { priceVarianceRappen: m.price_variance_rappen, expectedBaseRappen: m.expected_base_rappen },
      });
    }
  }
  // Late deliveries first (largest delay), then short shipments, then overrides, then rejections.
  const order: Record<ScorecardException['kind'], number> = {
    late_delivery: 0,
    short_shipment: 1,
    price_override: 2,
    rejection: 3,
  };
  out.sort((a, b) => {
    if (order[a.kind] !== order[b.kind]) return order[a.kind] - order[b.kind];
    const da = typeof a.detail.delayDays === 'number' ? a.detail.delayDays : 0;
    const db = typeof b.detail.delayDays === 'number' ? b.detail.delayDays : 0;
    return db - da;
  });
  return out.slice(0, 20);
}

// --- Metric view assembly ---------------------------------------------------------------------------

export interface MetricView {
  id: MetricId;
  value: number | null;
  unit: 'pct' | 'days' | 'score';
  normalised: number | null;
  status: 'green' | 'amber' | 'red' | 'none';
  weight: number | null;
}

function metricViews(values: Record<MetricId, number | null>, cfg: PerformanceConfig): MetricView[] {
  return PERFORMANCE_METRICS.map((id) => {
    const value = values[id];
    return {
      id,
      value,
      unit: METRIC_UNIT[id],
      normalised: value === null ? null : id === 'overall_score' ? value : roundTo(1, normalise(id, value, cfg)),
      status: trafficLight(id, value, cfg),
      weight: cfg.weights[id] ?? null,
    };
  });
}

// --- Verbs ------------------------------------------------------------------------------------------

export interface ScorecardInput {
  supplierId?: unknown;
  from?: unknown;
  to?: unknown;
  windowDays?: unknown;
  configOverride?: PerformanceConfigOverride;
}

/**
 * US-I05.1 / US-I05.3: a point-in-time scorecard for one supplier and window, with every core metric,
 * its traffic light, the weighted overall score, a previous-window comparison, and the top exceptions
 * with deep-link ids. Empty period answers ok with an empty-state (no rows) rather than an error.
 */
export function supplierScorecardGet(ctx: WorkspaceContext, input: ScorecardInput): Result {
  const supplierId = typeof input.supplierId === 'string' ? input.supplierId : '';
  if (supplierId.length === 0) return err('invalid_input', { field: 'supplierId' });
  const cfg = resolveConfig(input.configOverride);
  const supplier = loadSupplier(ctx, supplierId);
  if (supplier === undefined) return err('not_found', { supplierId }); // §H-TENANT: a foreign id is invisible.
  const w = resolveWindow(ctx, input, cfg);
  if (!w.ok) return w;
  const { window } = w;

  const lines = loadReceiptLines(ctx, supplierId, window);
  const matches = loadMatches(ctx, supplierId, window);
  const metrics = computeMetrics(lines, matches, cfg);

  // Previous, equal-length window immediately before this one, for the trend delta.
  const prevTo = shiftDate(window.from, -1);
  const prevFrom = shiftDate(prevTo, -(daysBetween(window.from, window.to)));
  const prevWindow: Window = { from: prevFrom, to: prevTo, windowDays: window.windowDays };
  const prevMetrics = computeMetrics(
    loadReceiptLines(ctx, supplierId, prevWindow),
    loadMatches(ctx, supplierId, prevWindow),
    cfg,
  );
  const current = metrics.values.overall_score;
  const previous = prevMetrics.values.overall_score;
  const trendDelta = current !== null && previous !== null ? roundTo(1, current - previous) : null;

  const hasActivity = metrics.receipts > 0 || metrics.matches > 0;

  return ok({
    supplier: { id: supplier.id, name: supplier.name },
    period: window,
    counts: { receipts: metrics.receipts, lines: metrics.lines, matches: metrics.matches },
    empty: !hasActivity,
    metrics: metricViews(metrics.values, cfg),
    overallScore: current,
    spendRappen: metrics.spendRappen,
    activityCount: metrics.activityCount,
    previous: { from: prevFrom, to: prevTo, overallScore: previous },
    trendDelta,
    exceptions: collectExceptions(lines, matches, cfg),
    config: cfg,
  });
}

export interface RankInput {
  metric?: unknown;
  from?: unknown;
  to?: unknown;
  windowDays?: unknown;
  minActivity?: unknown;
  limit?: unknown;
  order?: unknown;
  configOverride?: PerformanceConfigOverride;
}

/**
 * US-I05.2: a ranked page of suppliers by the chosen metric (default overall_score). Suppliers below
 * `min_activity` receipts are flagged insufficient and excluded from the ranked body. Ordering is
 * stable: equal values break by supplier name then id.
 */
export function supplierPerformanceRank(ctx: WorkspaceContext, input: RankInput): Result {
  const metric: MetricId = isMetricId(input.metric) ? input.metric : 'overall_score';
  const cfg = resolveConfig(input.configOverride);
  const w = resolveWindow(ctx, input, cfg);
  if (!w.ok) return w;
  const { window } = w;
  const minActivity = Math.max(0, Math.trunc(numOr(input.minActivity, cfg.minActivityForRank)));
  const limit = clamp(Math.trunc(numOr(input.limit, 50)), 1, 500);
  const order: 'asc' | 'desc' = input.order === 'asc' ? 'asc' : HIGHER_IS_BETTER[metric] ? 'desc' : 'asc';

  const supplierIds = loadActiveSupplierIds(ctx, window);
  interface Row {
    supplierId: string;
    name: string;
    score: number | null;
    metricValue: number | null;
    activityCount: number;
    previousDelta: number | null;
    insufficientData: boolean;
  }
  const rows: Row[] = [];
  const prevTo = shiftDate(window.from, -1);
  const prevWindow: Window = { from: shiftDate(prevTo, -(daysBetween(window.from, window.to))), to: prevTo, windowDays: window.windowDays };
  for (const id of supplierIds) {
    const supplier = loadSupplier(ctx, id);
    if (supplier === undefined) continue;
    const m = computeMetrics(loadReceiptLines(ctx, id, window), loadMatches(ctx, id, window), cfg);
    const prev = computeMetrics(loadReceiptLines(ctx, id, prevWindow), loadMatches(ctx, id, prevWindow), cfg);
    const cur = m.values.overall_score;
    const prevScore = prev.values.overall_score;
    rows.push({
      supplierId: id,
      name: supplier.name,
      score: cur,
      metricValue: m.values[metric],
      activityCount: m.activityCount,
      previousDelta: cur !== null && prevScore !== null ? roundTo(1, cur - prevScore) : null,
      insufficientData: m.activityCount < minActivity,
    });
  }
  const ranked = rows.filter((r) => !r.insufficientData && r.metricValue !== null);
  const insufficient = rows.filter((r) => r.insufficientData || r.metricValue === null);
  ranked.sort((a, b) => {
    const av = a.metricValue as number;
    const bv = b.metricValue as number;
    if (av !== bv) return order === 'asc' ? av - bv : bv - av;
    return a.name.localeCompare(b.name) || a.supplierId.localeCompare(b.supplierId);
  });

  return ok({
    metric,
    period: window,
    order,
    minActivity,
    rows: ranked.slice(0, limit),
    insufficient: insufficient.map((r) => ({ supplierId: r.supplierId, name: r.name, activityCount: r.activityCount })),
    total: ranked.length,
  });
}

export interface TrendInput {
  supplierId?: unknown;
  metric?: unknown;
  periods?: unknown;
  windowDays?: unknown;
  to?: unknown;
  configOverride?: PerformanceConfigOverride;
}

/**
 * US-I05.1 trend: the chosen metric over the last `periods` consecutive windows of `window_days`,
 * oldest first, each a pure re-evaluation. A window with no data reports value null (a gap), never a
 * fabricated zero.
 */
export function supplierPerformanceTrend(ctx: WorkspaceContext, input: TrendInput): Result {
  const supplierId = typeof input.supplierId === 'string' ? input.supplierId : '';
  if (supplierId.length === 0) return err('invalid_input', { field: 'supplierId' });
  const metric: MetricId = isMetricId(input.metric) ? input.metric : 'overall_score';
  const cfg = resolveConfig(input.configOverride);
  const supplier = loadSupplier(ctx, supplierId);
  if (supplier === undefined) return err('not_found', { supplierId });
  const periods = clamp(Math.trunc(numOr(input.periods, 6)), 1, 36);
  const windowDays = Math.max(1, Math.trunc(numOr(input.windowDays, cfg.evaluationWindowDays)));
  const anchor = typeof input.to === 'string' && DATE_RE.test(input.to) ? input.to : ctx.clock.now().slice(0, 10);

  const points: { from: string; to: string; value: number | null }[] = [];
  let to = anchor;
  for (let i = 0; i < periods; i += 1) {
    const from = shiftDate(to, -(windowDays - 1));
    const window: Window = { from, to, windowDays };
    const m = computeMetrics(loadReceiptLines(ctx, supplierId, window), loadMatches(ctx, supplierId, window), cfg);
    points.push({ from, to, value: m.values[metric] });
    to = shiftDate(from, -1);
  }
  points.reverse(); // oldest first.
  return ok({ supplier: { id: supplier.id, name: supplier.name }, metric, windowDays, points });
}

export interface ExplainInput {
  supplierId?: unknown;
  metric?: unknown;
  from?: unknown;
  to?: unknown;
  windowDays?: unknown;
  configOverride?: PerformanceConfigOverride;
}

const FORMULA: Record<MetricId, string> = {
  otif_pct: '100 * (receipt lines on-time AND in-full) / (receipt lines with a due date)',
  on_time_pct: '100 * (receipt lines with received_at <= expected_at + tolerance_days) / (receipt lines with a due date)',
  in_full_pct: '100 * (receipt lines with qty >= ordered * (1 - short_tol)) / (evaluated receipt lines)',
  avg_delay_days: 'mean over due lines of max(0, received_at - expected_at), in whole days',
  qty_variance_pct: 'mean over ordered lines of abs(received - ordered) / ordered, as a percentage',
  price_variance_pct: 'mean over priced matches of abs(price_variance_rappen) / expected_base_rappen, as a percentage',
  match_override_rate: '100 * (matches overridden) / (matches)',
  rejection_rate: '100 * (lines inspection_status = rejected) / (decided lines)',
  overall_score: 'weight-normalised sum of each present metric normalised to 0-100 (lower-is-better metrics inverted)',
};

/**
 * US-I05.3: the exact definition and source documents behind one metric, so the number is auditable
 * and reproducible: the formula applied, the config values used, and the contributing document ids
 * with their per-line values.
 */
export function supplierPerformanceExplain(ctx: WorkspaceContext, input: ExplainInput): Result {
  const supplierId = typeof input.supplierId === 'string' ? input.supplierId : '';
  if (supplierId.length === 0) return err('invalid_input', { field: 'supplierId' });
  if (!isMetricId(input.metric)) return err('invalid_input', { field: 'metric' });
  const metric = input.metric;
  const cfg = resolveConfig(input.configOverride);
  const supplier = loadSupplier(ctx, supplierId);
  if (supplier === undefined) return err('not_found', { supplierId });
  const w = resolveWindow(ctx, input, cfg);
  if (!w.ok) return w;
  const { window } = w;

  const lines = loadReceiptLines(ctx, supplierId, window);
  const matches = loadMatches(ctx, supplierId, window);
  const metrics = computeMetrics(lines, matches, cfg);

  // The contributing rows depend on the metric family.
  const sources: Record<string, string | number>[] = [];
  if (metric === 'price_variance_pct' || metric === 'match_override_rate') {
    for (const m of matches) {
      sources.push({
        matchId: m.id,
        poId: m.po_id,
        billId: m.bill_id,
        status: m.status,
        priceVarianceRappen: m.price_variance_rappen,
        expectedBaseRappen: m.expected_base_rappen,
      });
    }
  } else {
    for (const l of lines) {
      const due = l.expected_at !== null && DATE_RE.test(String(l.expected_at));
      sources.push({
        receiptId: l.gr_id,
        receiptNumber: l.gr_number,
        poLineId: l.po_line_id,
        receivedAt: l.received_at,
        expectedAt: l.expected_at ?? '',
        qty: l.qty,
        orderedQty: l.ordered_qty,
        inspectionStatus: l.inspection_status,
        delayDays: due ? daysBetween(String(l.expected_at), l.received_at) : 0,
      });
    }
  }

  return ok({
    supplier: { id: supplier.id, name: supplier.name },
    metric,
    period: window,
    formula: FORMULA[metric],
    value: metrics.values[metric],
    unit: METRIC_UNIT[metric],
    config: {
      onTimeToleranceDays: cfg.onTimeToleranceDays,
      shortShipmentTolPct: cfg.shortShipmentTolPct,
      delayCapDays: cfg.delayCapDays,
      weight: cfg.weights[metric] ?? null,
    },
    sources,
  });
}

export interface AlertsInput {
  asOf?: unknown;
  windowDays?: unknown;
  onlyOpen?: unknown;
  configOverride?: PerformanceConfigOverride;
}

/**
 * US-I05.5: derived alerts. For every supplier active in the window, any configured alert threshold
 * a metric currently breaches becomes an open alert (supplier, metric, value, threshold, period,
 * deep-link supplier id). Alerts are DERIVED, not stored: the next read recomputes them.
 */
export function supplierPerformanceAlerts(ctx: WorkspaceContext, input: AlertsInput): Result {
  const cfg = resolveConfig(input.configOverride);
  const w = resolveWindow(ctx, { windowDays: input.windowDays, asOf: input.asOf }, cfg);
  if (!w.ok) return w;
  const { window } = w;
  const onlyOpen = input.onlyOpen !== false; // default true.

  const supplierIds = loadActiveSupplierIds(ctx, window);
  interface Alert {
    supplierId: string;
    name: string;
    metric: MetricId;
    value: number;
    threshold: number;
    breached: boolean;
  }
  const alerts: Alert[] = [];
  for (const id of supplierIds) {
    const supplier = loadSupplier(ctx, id);
    if (supplier === undefined) continue;
    const m = computeMetrics(loadReceiptLines(ctx, id, window), loadMatches(ctx, id, window), cfg);
    for (const metric of PERFORMANCE_METRICS) {
      const threshold = cfg.alertThresholds[metric];
      const value = m.values[metric];
      if (threshold === undefined || value === null) continue;
      // Higher-is-better metrics breach BELOW the threshold; lower-is-better breach ABOVE it.
      const breached = HIGHER_IS_BETTER[metric] ? value < threshold : value > threshold;
      if (breached || !onlyOpen) {
        alerts.push({ supplierId: id, name: supplier.name, metric, value, threshold, breached });
      }
    }
  }
  alerts.sort((a, b) => a.name.localeCompare(b.name) || a.metric.localeCompare(b.metric));
  return ok({ period: window, onlyOpen, alerts });
}
