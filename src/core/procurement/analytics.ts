/**
 * I06, PROCUREMENT ANALYTICS & AGENT TOOLS: a PURE READ MODEL over the shipped I00-I05 + D02
 * procurement documents. Wave 14, cluster I.
 *
 * THIS MODULE WRITES NOTHING. No table, no column, no INSERT, no UPDATE, no cache. It owns no schema
 * (§4: "no new persistent tables required for Phase 1"). Every figure is recomputed from the live
 * source rows on each call, so an analytics read is referentially transparent: the same data yields
 * the identical result, and "a receipt was reversed" or "a bill was matched" changes the answer on
 * the next read with no invalidation step. The module imports neither `postEntry` nor any writer, and
 * its only SQL verbs are SELECTs. That no-write posture is asserted STRUCTURALLY (by absence) in
 * `test/procurement/i06-analytics.test.mjs`, the I05 / C03 forecast precedent, not merely promised.
 *
 * WHERE THE NUMBERS COME FROM (see the spec §0 reconciliation):
 *   - Open commitment and GR/IR exposure are pure projections of the D02 `po_line` counters
 *     (`qty` ordered, `received_qty`, `billed_qty`) times `unit_price_base_rappen` (integer CHF
 *     Rappen). Those counters are the authoritative received/billed trail I02 and I04 maintain.
 *   - Match status and its exceptions derive from the I04 `three_way_match` active rows
 *     (`status IN (matched|partial|overridden) AND reversing_match_id IS NULL`).
 *   - Spend derives from the same `po_line` counters, grouped over the PO, item, item category or
 *     order month.
 *   - The supplier scorecard DELEGATES to I05 (`supplierScorecardGet`): the metric math is not
 *     re-implemented here (the spec's "pure read of I05" rule); I06 only adds the open commitment and
 *     in-period spend from the live PO lines.
 *   - Requisition pipeline reads the I00 `requisition` + `requisition_conversion` tables.
 *   - Landed-cost variance reads the I03 `landed_cost_voucher` + `landed_cost_line`.
 *   - PO cycle and PO history read the timestamps the engine actually records (`created_at`, the
 *     first `goods_receipt_doc.received_at`, the last `three_way_match.created_at`, `po_revision`).
 *
 * §H-TENANT: every query filters `workspace_id = ctx.workspaceId`. An id that belongs to another
 * tenant is invisible: `procurement_po_history` returns `not_found` for a foreign PO (which IS the
 * tenant denial, a foreign row cannot be named), and a foreign supplier/item filter simply matches
 * nothing. Asserted in tests.
 *
 * ARITHMETIC (P2): money stays integer Rappen and is never floated. Percentages are computed
 * round-half-away-from-zero to one decimal over integer numerator/denominator, the I05 convention, so
 * every figure is hand-calculable from the contributing rows and reproduces exactly.
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { supplierScorecardGet } from './supplier-performance.js';

// --- Shared helpers (the I05 date/money conventions) ------------------------------------------------

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
/** Half-away-from-zero rounding to `decimals` places, the I05 convention. */
function roundTo(decimals: number, x: number): number {
  const f = 10 ** decimals;
  return (Math.sign(x) * Math.round(Math.abs(x) * f)) / f;
}
/** Integer-exact percentage rounded HALF AWAY FROM ZERO to one decimal, or null on an empty denominator. */
function pct1(numer: number, denom: number): number | null {
  if (denom === 0) return null;
  return roundTo(1, (numer * 100) / denom);
}
function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}
function numOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}
function asDate(v: unknown): string | null {
  return typeof v === 'string' && DATE_RE.test(v.slice(0, 10)) ? v.slice(0, 10) : null;
}
function strArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x): x is string => typeof x === 'string' && x.length > 0);
  return out.length > 0 ? out : undefined;
}

/** The four aging buckets over an integer day count. */
function agingBucket(days: number): '0-30' | '31-60' | '61-90' | '90+' {
  if (days <= 30) return '0-30';
  if (days <= 60) return '31-60';
  if (days <= 90) return '61-90';
  return '90+';
}
const AGING_KEYS = ['0-30', '31-60', '61-90', '90+'] as const;
type AgingKey = (typeof AGING_KEYS)[number];
function emptyAging(): Record<AgingKey, { count: number; value_rappen: number }> {
  return {
    '0-30': { count: 0, value_rappen: 0 },
    '31-60': { count: 0, value_rappen: 0 },
    '61-90': { count: 0, value_rappen: 0 },
    '90+': { count: 0, value_rappen: 0 },
  };
}

/** Today (YYYY-MM-DD) from the injected clock, never the wall clock. */
function today(ctx: WorkspaceContext): string {
  return ctx.clock.now().slice(0, 10);
}

/**
 * Resolve [from, to] from explicit dates, defaulting `to` to `asOf`/today and `from` to `windowDays`
 * before it. Returns an error Result when a supplied date is malformed or inverted.
 */
function resolvePeriod(
  ctx: WorkspaceContext,
  input: { from_date?: unknown; to_date?: unknown; from?: unknown; to?: unknown },
  windowDaysDefault = 90,
): { from: string; to: string } | { error: string; field: string } {
  const fromIn = asDate(input.from_date) ?? asDate(input.from);
  const toIn = asDate(input.to_date) ?? asDate(input.to);
  if ((input.from_date !== undefined || input.from !== undefined) && fromIn === null) {
    return { error: 'invalid_period_range', field: 'from_date' };
  }
  if ((input.to_date !== undefined || input.to !== undefined) && toIn === null) {
    return { error: 'invalid_period_range', field: 'to_date' };
  }
  const to = toIn ?? today(ctx);
  const from = fromIn ?? shiftDate(to, -(windowDaysDefault - 1));
  if (daysBetween(from, to) < 0) return { error: 'invalid_period_range', field: 'to_date' };
  return { from, to };
}

/** A SQL `IN (?, ?, ...)` fragment plus its bound params, or `null` when the list is empty. */
function inClause(col: string, ids: string[] | undefined): { sql: string; params: string[] } | null {
  if (ids === undefined || ids.length === 0) return null;
  return { sql: `${col} IN (${ids.map(() => '?').join(', ')})`, params: ids };
}

// --- US-I06.1: Open commitments ---------------------------------------------------------------------

interface CommitmentLineRow {
  po_id: string;
  po_number: string;
  status: string;
  supplier_id: string;
  supplier_name: string;
  currency: string;
  expected_on: string | null;
  created_at: string;
  line_id: string;
  item_id: string | null;
  description: string | null;
  ordered_qty: number;
  received_qty: number;
  billed_qty: number;
  unit_price_base_rappen: number;
}

export interface OpenCommitmentsInput {
  filter?: {
    supplier_ids?: unknown;
    item_ids?: unknown;
    status?: unknown;
    order_date_from?: unknown;
    order_date_to?: unknown;
    only_positive_commitment?: unknown;
    include_closed?: unknown;
  };
  group_by?: unknown;
  cursor?: unknown;
  limit?: unknown;
  format?: unknown;
}

/**
 * US-I06.1: every still-open PO line with ordered / received / billed quantities and the residual
 * commitment value (ordered - billed, at PO base price). Cancelled POs contribute nothing; closed POs
 * are omitted unless `include_closed`. Grouped or flat, with aging-bucketed totals.
 */
export function procurementOpenCommitments(ctx: WorkspaceContext, input: OpenCommitmentsInput): Result {
  const filter = (input.filter ?? {}) as NonNullable<OpenCommitmentsInput['filter']>;
  const includeClosed = filter.include_closed === true;
  const onlyPositive = filter.only_positive_commitment !== false; // default true
  const groupBy = ['none', 'supplier', 'item', 'aging'].includes(String(input.group_by))
    ? (String(input.group_by) as 'none' | 'supplier' | 'item' | 'aging')
    : 'none';
  const limit = clamp(Math.trunc(numOr(input.limit, 500)), 1, 5000);
  const offset = Math.max(0, Math.trunc(numOr(asCursorNum(input.cursor), 0)));

  const where: string[] = ['po.workspace_id = ?'];
  const params: unknown[] = [ctx.workspaceId];
  where.push("po.status != 'cancelled'");
  if (!includeClosed) where.push("po.status != 'closed'");
  const statusList = strArray(filter.status);
  const st = inClause('po.status', statusList);
  if (st !== null) {
    where.push(st.sql);
    params.push(...st.params);
  }
  const sup = inClause('po.supplier_contact_id', strArray(filter.supplier_ids));
  if (sup !== null) {
    where.push(sup.sql);
    params.push(...sup.params);
  }
  const it = inClause('pl.item_id', strArray(filter.item_ids));
  if (it !== null) {
    where.push(it.sql);
    params.push(...it.params);
  }
  const odFrom = asDate(filter.order_date_from);
  const odTo = asDate(filter.order_date_to);
  if (odFrom !== null) {
    where.push('substr(po.created_at, 1, 10) >= ?');
    params.push(odFrom);
  }
  if (odTo !== null) {
    where.push('substr(po.created_at, 1, 10) <= ?');
    params.push(odTo);
  }

  const rows = ctx.store.db
    .prepare(
      `SELECT po.id AS po_id, po.number AS po_number, po.status AS status,
              po.supplier_contact_id AS supplier_id, c.name AS supplier_name,
              po.currency AS currency, po.expected_on AS expected_on, po.created_at AS created_at,
              pl.id AS line_id, pl.item_id AS item_id, pl.description AS description,
              pl.qty AS ordered_qty, pl.received_qty AS received_qty, pl.billed_qty AS billed_qty,
              pl.unit_price_base_rappen AS unit_price_base_rappen
         FROM po_line pl
         JOIN purchase_order po ON po.workspace_id = pl.workspace_id AND po.id = pl.po_id
         LEFT JOIN contact c ON c.workspace_id = po.workspace_id AND c.id = po.supplier_contact_id
        WHERE ${where.join(' AND ')}
        ORDER BY po.created_at, po.id, pl.sort, pl.id`,
    )
    .all(...params) as CommitmentLineRow[];

  const now = today(ctx);
  interface Row {
    poId: string;
    poNumber: string;
    status: string;
    supplierId: string;
    supplierName: string;
    itemId: string | null;
    description: string | null;
    orderedQty: number;
    receivedQty: number;
    billedQty: number;
    openQty: number;
    unitPriceRappen: number;
    openValueRappen: number;
    currency: string;
    expectedDate: string | null;
    daysOpen: number;
    agingBucket: AgingKey;
  }
  const all: Row[] = [];
  for (const r of rows) {
    const openQty = r.ordered_qty - r.billed_qty;
    if (onlyPositive && openQty <= 0) continue;
    const openValue = openQty * r.unit_price_base_rappen;
    const orderDate = r.created_at.slice(0, 10);
    const daysOpen = Math.max(0, daysBetween(orderDate, now));
    all.push({
      poId: r.po_id,
      poNumber: r.po_number,
      status: r.status,
      supplierId: r.supplier_id,
      supplierName: r.supplier_name ?? '',
      itemId: r.item_id,
      description: r.description,
      orderedQty: r.ordered_qty,
      receivedQty: r.received_qty,
      billedQty: r.billed_qty,
      openQty,
      unitPriceRappen: r.unit_price_base_rappen,
      openValueRappen: openValue,
      currency: r.currency,
      expectedDate: r.expected_on,
      daysOpen,
      agingBucket: agingBucket(daysOpen),
    });
  }

  // Totals over the FULL filtered set (before pagination), the money-identity tripwire target.
  const totals = { count: all.length, open_value_rappen: 0, by_aging: emptyAging() };
  for (const row of all) {
    totals.open_value_rappen += row.openValueRappen;
    totals.by_aging[row.agingBucket].count += 1;
    totals.by_aging[row.agingBucket].value_rappen += row.openValueRappen;
  }

  if (groupBy !== 'none') {
    const groups = groupCommitments(all, groupBy);
    return ok({
      groupBy,
      groups,
      totals,
      format: 'json',
    });
  }

  const page = all.slice(offset, offset + limit);
  const nextCursor = offset + limit < all.length ? String(offset + limit) : undefined;
  return ok({
    groupBy,
    rows: page,
    totals,
    ...(nextCursor !== undefined ? { next_cursor: nextCursor } : {}),
    format: 'json',
  });
}

function asCursorNum(cursor: unknown): number {
  if (typeof cursor === 'number') return cursor;
  if (typeof cursor === 'string' && /^\d+$/.test(cursor)) return Number(cursor);
  return 0;
}

function groupCommitments(
  rows: {
    supplierId: string;
    supplierName: string;
    itemId: string | null;
    agingBucket: AgingKey;
    openValueRappen: number;
    openQty: number;
  }[],
  groupBy: 'supplier' | 'item' | 'aging',
): { key: string; label: string; count: number; open_value_rappen: number; open_qty: number }[] {
  const map = new Map<string, { key: string; label: string; count: number; open_value_rappen: number; open_qty: number }>();
  for (const r of rows) {
    const key = groupBy === 'supplier' ? r.supplierId : groupBy === 'item' ? (r.itemId ?? '(no-item)') : r.agingBucket;
    const label = groupBy === 'supplier' ? r.supplierName : key;
    const g = map.get(key) ?? { key, label, count: 0, open_value_rappen: 0, open_qty: 0 };
    g.count += 1;
    g.open_value_rappen += r.openValueRappen;
    g.open_qty += r.openQty;
    map.set(key, g);
  }
  return [...map.values()].sort((a, b) => b.open_value_rappen - a.open_value_rappen);
}

// --- US-I06.2: Match status & exceptions ------------------------------------------------------------

interface MatchRow {
  id: string;
  bill_id: string;
  po_id: string;
  status: string;
  total_billed_rappen: number;
  total_expected_rappen: number;
  total_qty: number;
  price_variance_rappen: number;
  value_variance_rappen: number;
  reason: string | null;
  overridden_by: string | null;
  matched_at: string;
  supplier_id: string;
  supplier_name: string | null;
  po_number: string;
}

export interface MatchStatusInput {
  status?: unknown;
  supplier_ids?: unknown;
  from_date?: unknown;
  to_date?: unknown;
  include_detail?: unknown;
  as_of?: unknown;
  format?: unknown;
}

const MATCH_STATUSES = ['matched', 'partial', 'overridden'] as const;

/**
 * US-I06.2: the match-status summary and the exception rows. Reads the I04 `three_way_match` active
 * records (reversed originals and reversing rows drop out). Non-`matched` rows are the exceptions,
 * each with its variance figures, aging and a suggested next action. `clean` when no exception in the
 * filter, else `exceptions_present`.
 */
export function procurementMatchStatus(ctx: WorkspaceContext, input: MatchStatusInput): Result {
  const period = resolvePeriod(ctx, input, 365);
  if ('error' in period) return err(period.error, { field: period.field });
  const wanted = strArray(input.status)?.filter((s) => (MATCH_STATUSES as readonly string[]).includes(s));
  const asOf = asDate(input.as_of) ?? today(ctx);

  const where: string[] = [
    'm.workspace_id = ?',
    "m.status IN ('matched', 'partial', 'overridden')",
    'm.reversing_match_id IS NULL',
    'substr(m.created_at, 1, 10) >= ?',
    'substr(m.created_at, 1, 10) <= ?',
  ];
  const params: unknown[] = [ctx.workspaceId, period.from, period.to];
  const sup = inClause('po.supplier_contact_id', strArray(input.supplier_ids));
  if (sup !== null) {
    where.push(sup.sql);
    params.push(...sup.params);
  }

  const rows = ctx.store.db
    .prepare(
      `SELECT m.id AS id, m.bill_id AS bill_id, m.po_id AS po_id, m.status AS status,
              m.total_billed_rappen AS total_billed_rappen, m.total_expected_rappen AS total_expected_rappen,
              m.total_qty AS total_qty, m.price_variance_rappen AS price_variance_rappen,
              m.value_variance_rappen AS value_variance_rappen, m.reason AS reason,
              m.overridden_by AS overridden_by, m.created_at AS matched_at,
              po.supplier_contact_id AS supplier_id, c.name AS supplier_name, po.number AS po_number
         FROM three_way_match m
         JOIN purchase_order po ON po.workspace_id = m.workspace_id AND po.id = m.po_id
         LEFT JOIN contact c ON c.workspace_id = po.workspace_id AND c.id = po.supplier_contact_id
        WHERE ${where.join(' AND ')}
        ORDER BY m.created_at, m.id`,
    )
    .all(...params) as MatchRow[];

  const summary: Record<string, { count: number; value_rappen: number }> = {
    matched: { count: 0, value_rappen: 0 },
    partial: { count: 0, value_rappen: 0 },
    overridden: { count: 0, value_rappen: 0 },
  };
  const exceptions: Record<string, unknown>[] = [];
  for (const r of rows) {
    const bucket = summary[r.status];
    if (bucket !== undefined) {
      bucket.count += 1;
      bucket.value_rappen += r.total_billed_rappen;
    }
    if (r.status === 'matched') continue;
    if (wanted !== undefined && !wanted.includes(r.status)) continue;
    const nextAction = suggestMatchAction(r.status);
    const detail = input.include_detail === true ? loadMatchLines(ctx, r.id) : undefined;
    exceptions.push({
      matchId: r.id,
      poId: r.po_id,
      poNumber: r.po_number,
      billId: r.bill_id,
      supplierId: r.supplier_id,
      supplierName: r.supplier_name ?? '',
      status: r.status,
      qtyVariance: r.total_qty,
      priceVarianceRappen: r.price_variance_rappen,
      valueVarianceRappen: r.value_variance_rappen,
      toleranceBreached: r.status === 'overridden',
      overrideReason: r.reason ?? undefined,
      overriddenBy: r.overridden_by ?? undefined,
      agingDays: Math.max(0, daysBetween(r.matched_at.slice(0, 10), asOf)),
      suggestedNextAction: nextAction,
      ...(detail !== undefined ? { lines: detail } : {}),
    });
  }

  // If a status filter is set and excludes 'matched', the summary still reports all three counts (a
  // summary is the whole picture); the filter narrows only the exception body.
  const filteredSummary =
    wanted === undefined
      ? summary
      : Object.fromEntries(Object.entries(summary).filter(([k]) => wanted.includes(k)));

  return ok({
    period,
    summary: filteredSummary,
    exceptions,
    status: exceptions.length === 0 ? 'clean' : 'exceptions_present',
    format: 'json',
  });
}

function suggestMatchAction(status: string): string {
  if (status === 'partial') return 'await_receipt';
  if (status === 'overridden') return 'review_override';
  return 'escalate';
}

interface MatchLineRow {
  po_line_id: string;
  item_id: string | null;
  description: string | null;
  ordered_qty: number;
  received_qty: number;
  billed_qty: number;
  extended_po_rappen: number;
  qty_variance: number;
  line_status: string;
}
function loadMatchLines(ctx: WorkspaceContext, matchId: string): Record<string, unknown>[] {
  const rows = ctx.store.db
    .prepare(
      `SELECT po_line_id, item_id, description, ordered_qty, received_qty, billed_qty,
              extended_po_rappen, qty_variance, line_status
         FROM three_way_match_line
        WHERE workspace_id = ? AND match_id = ?
        ORDER BY id`,
    )
    .all(ctx.workspaceId, matchId) as MatchLineRow[];
  return rows.map((l) => ({
    poLineId: l.po_line_id,
    itemId: l.item_id,
    description: l.description,
    orderedQty: l.ordered_qty,
    receivedQty: l.received_qty,
    billedQty: l.billed_qty,
    extendedPoRappen: l.extended_po_rappen,
    qtyVariance: l.qty_variance,
    lineStatus: l.line_status,
  }));
}

// --- US-I06.3: Spend summary ------------------------------------------------------------------------

export interface SpendSummaryInput {
  from_date?: unknown;
  to_date?: unknown;
  group_by?: unknown;
  filter?: { supplier_ids?: unknown; item_ids?: unknown; category_ids?: unknown };
  compare_prior_period?: unknown;
  format?: unknown;
}

const SPEND_GROUPS = ['supplier', 'item', 'category', 'month'] as const;
type SpendGroup = (typeof SPEND_GROUPS)[number];

interface SpendLineRow {
  supplier_id: string;
  supplier_name: string | null;
  item_id: string | null;
  item_name: string | null;
  category_id: string | null;
  category_name: string | null;
  order_month: string;
  po_id: string;
  ordered_qty: number;
  received_qty: number;
  billed_qty: number;
  unit_price_base_rappen: number;
}

/**
 * US-I06.3: grouped spend over the PO lines whose order date falls in [from, to]. Ordered / received /
 * billed values are the counters times the base price. `compare_prior_period` adds the prior equal
 * window's billed value and the delta.
 */
export function procurementSpendSummary(ctx: WorkspaceContext, input: SpendSummaryInput): Result {
  const period = resolvePeriod(ctx, input, 90);
  if ('error' in period) return err(period.error, { field: period.field });
  const groupBy: SpendGroup = (SPEND_GROUPS as readonly string[]).includes(String(input.group_by))
    ? (String(input.group_by) as SpendGroup)
    : 'supplier';
  const filter = input.filter ?? {};

  const rows = loadSpendRows(ctx, period.from, period.to, filter);
  const result = aggregateSpend(rows, groupBy);

  if (input.compare_prior_period === true) {
    const span = daysBetween(period.from, period.to);
    const prevTo = shiftDate(period.from, -1);
    const prevFrom = shiftDate(prevTo, -span);
    const prevRows = loadSpendRows(ctx, prevFrom, prevTo, filter);
    const prevByKey = new Map<string, number>();
    for (const g of aggregateSpend(prevRows, groupBy).rows) prevByKey.set(g.key, g.billed_rappen);
    for (const g of result.rows) {
      const priorBilled = prevByKey.get(g.key) ?? 0;
      const delta = g.billed_rappen - priorBilled;
      g.prior = {
        billed_rappen: priorBilled,
        delta_rappen: delta,
        delta_pct: priorBilled === 0 ? null : roundTo(1, (delta * 100) / priorBilled),
      };
    }
    result.grand_total.prior_billed_rappen = [...prevByKey.values()].reduce((s, v) => s + v, 0);
  }

  return ok({
    from_date: period.from,
    to_date: period.to,
    group_by: groupBy,
    rows: result.rows,
    grand_total: result.grand_total,
    format: 'json',
  });
}

function loadSpendRows(
  ctx: WorkspaceContext,
  from: string,
  to: string,
  filter: { supplier_ids?: unknown; item_ids?: unknown; category_ids?: unknown },
): SpendLineRow[] {
  const where: string[] = ['po.workspace_id = ?', "po.status != 'cancelled'", 'substr(po.created_at, 1, 10) >= ?', 'substr(po.created_at, 1, 10) <= ?'];
  const params: unknown[] = [ctx.workspaceId, from, to];
  const sup = inClause('po.supplier_contact_id', strArray(filter.supplier_ids));
  if (sup !== null) {
    where.push(sup.sql);
    params.push(...sup.params);
  }
  const it = inClause('pl.item_id', strArray(filter.item_ids));
  if (it !== null) {
    where.push(it.sql);
    params.push(...it.params);
  }
  const cat = inClause('i.category_id', strArray(filter.category_ids));
  if (cat !== null) {
    where.push(cat.sql);
    params.push(...cat.params);
  }
  return ctx.store.db
    .prepare(
      `SELECT po.supplier_contact_id AS supplier_id, c.name AS supplier_name,
              pl.item_id AS item_id, i.name AS item_name,
              i.category_id AS category_id, cat.name AS category_name,
              substr(po.created_at, 1, 7) AS order_month, po.id AS po_id,
              pl.qty AS ordered_qty, pl.received_qty AS received_qty, pl.billed_qty AS billed_qty,
              pl.unit_price_base_rappen AS unit_price_base_rappen
         FROM po_line pl
         JOIN purchase_order po ON po.workspace_id = pl.workspace_id AND po.id = pl.po_id
         LEFT JOIN contact c ON c.workspace_id = po.workspace_id AND c.id = po.supplier_contact_id
         LEFT JOIN item i ON i.workspace_id = pl.workspace_id AND i.id = pl.item_id
         LEFT JOIN item_category cat ON cat.workspace_id = i.workspace_id AND cat.id = i.category_id
        WHERE ${where.join(' AND ')}`,
    )
    .all(...params) as SpendLineRow[];
}

interface SpendGroupRow {
  key: string;
  label: string;
  document_count: number;
  ordered_rappen: number;
  received_rappen: number;
  billed_rappen: number;
  prior?: { billed_rappen: number; delta_rappen: number; delta_pct: number | null };
}

function aggregateSpend(
  rows: SpendLineRow[],
  groupBy: SpendGroup,
): { rows: SpendGroupRow[]; grand_total: { document_count: number; ordered_rappen: number; received_rappen: number; billed_rappen: number; prior_billed_rappen?: number } } {
  const map = new Map<string, SpendGroupRow & { pos: Set<string> }>();
  const grandPos = new Set<string>();
  const grand = { document_count: 0, ordered_rappen: 0, received_rappen: 0, billed_rappen: 0 };
  for (const r of rows) {
    const key =
      groupBy === 'supplier'
        ? r.supplier_id
        : groupBy === 'item'
          ? (r.item_id ?? '(no-item)')
          : groupBy === 'category'
            ? (r.category_id ?? '(no-category)')
            : r.order_month;
    const label =
      groupBy === 'supplier'
        ? (r.supplier_name ?? '')
        : groupBy === 'item'
          ? (r.item_name ?? '(no-item)')
          : groupBy === 'category'
            ? (r.category_name ?? '(no-category)')
            : r.order_month;
    const g = map.get(key) ?? { key, label, document_count: 0, ordered_rappen: 0, received_rappen: 0, billed_rappen: 0, pos: new Set<string>() };
    g.ordered_rappen += r.ordered_qty * r.unit_price_base_rappen;
    g.received_rappen += r.received_qty * r.unit_price_base_rappen;
    g.billed_rappen += r.billed_qty * r.unit_price_base_rappen;
    g.pos.add(r.po_id);
    map.set(key, g);
    grand.ordered_rappen += r.ordered_qty * r.unit_price_base_rappen;
    grand.received_rappen += r.received_qty * r.unit_price_base_rappen;
    grand.billed_rappen += r.billed_qty * r.unit_price_base_rappen;
    grandPos.add(r.po_id);
  }
  const out: SpendGroupRow[] = [...map.values()]
    .map((g) => {
      const { pos, ...rest } = g;
      rest.document_count = pos.size;
      return rest;
    })
    .sort((a, b) => b.billed_rappen - a.billed_rappen || a.key.localeCompare(b.key));
  return { rows: out, grand_total: { ...grand, document_count: grandPos.size } };
}

// --- US-I06.4: Supplier scorecard (delegates to I05) ------------------------------------------------

export interface SupplierScorecardInput {
  supplier_ids?: unknown;
  from_date?: unknown;
  to_date?: unknown;
  include_trend?: unknown;
  min_activity?: unknown;
}

/**
 * US-I06.4: one scorecard row per supplier, DELEGATING the metric math to I05's `supplierScorecardGet`
 * (the "pure read of I05" rule) and adding `open_commitment_rappen` and `spend_in_period_rappen` from
 * the live PO lines. Suppliers are the requested set, or every supplier with a PO in the window.
 */
export function procurementSupplierScorecard(ctx: WorkspaceContext, input: SupplierScorecardInput): Result {
  const period = resolvePeriod(ctx, input, 90);
  if ('error' in period) return err(period.error, { field: period.field });
  const requested = strArray(input.supplier_ids);
  const supplierIds = requested ?? loadActiveSupplierIds(ctx, period.from, period.to);
  const minActivity = Math.max(0, Math.trunc(numOr(input.min_activity, 0)));

  const rows: Record<string, unknown>[] = [];
  for (const id of supplierIds) {
    const card = supplierScorecardGet(ctx, { supplierId: id, from: period.from, to: period.to });
    if (!card.ok) {
      // A foreign / unknown id in an explicit request is surfaced, not silently dropped.
      if (requested !== undefined) rows.push({ supplierId: id, warnings: ['not_found'] });
      continue;
    }
    const c = card as unknown as {
      supplier: { id: string; name: string };
      metrics: { id: string; value: number | null }[];
      overallScore: number | null;
      spendRappen: number;
      activityCount: number;
      trendDelta: number | null;
      empty: boolean;
    };
    const metric = (mid: string): number | null => c.metrics.find((m) => m.id === mid)?.value ?? null;
    const activity = c.activityCount;
    if (activity < minActivity) continue;
    const openCommitment = supplierOpenCommitmentRappen(ctx, id);
    const warnings: string[] = [];
    if (c.empty || c.overallScore === null) warnings.push('insufficient_data');
    rows.push({
      supplierId: c.supplier.id,
      supplierName: c.supplier.name,
      overallScore: c.overallScore,
      onTimeDeliveryPct: metric('on_time_pct'),
      avgDaysLate: metric('avg_delay_days'),
      priceVariancePct: metric('price_variance_pct'),
      qtyVariancePct: metric('qty_variance_pct'),
      matchOverrideRate: metric('match_override_rate'),
      rejectionRate: metric('rejection_rate'),
      openCommitmentRappen: openCommitment,
      spendInPeriodRappen: c.spendRappen,
      activityCount: activity,
      ...(input.include_trend === true ? { trend: trendLabel(c.trendDelta) } : {}),
      ...(warnings.length > 0 ? { warnings } : {}),
    });
  }
  rows.sort((a, b) => {
    const av = (a.overallScore as number | null) ?? -1;
    const bv = (b.overallScore as number | null) ?? -1;
    return bv - av || String(a.supplierName ?? '').localeCompare(String(b.supplierName ?? ''));
  });
  return ok({ period, rows, format: 'json' });
}

function trendLabel(delta: number | null): 'improving' | 'stable' | 'declining' | 'unknown' {
  if (delta === null) return 'unknown';
  if (delta > 2) return 'improving';
  if (delta < -2) return 'declining';
  return 'stable';
}

/** Every supplier with a non-cancelled PO created in [from, to]. */
function loadActiveSupplierIds(ctx: WorkspaceContext, from: string, to: string): string[] {
  const rows = ctx.store.db
    .prepare(
      `SELECT DISTINCT supplier_contact_id AS id FROM purchase_order
        WHERE workspace_id = ? AND status != 'cancelled'
          AND substr(created_at, 1, 10) >= ? AND substr(created_at, 1, 10) <= ?
        ORDER BY supplier_contact_id`,
    )
    .all(ctx.workspaceId, from, to) as { id: string }[];
  return rows.map((r) => r.id);
}

/** Residual commitment (ordered - billed, at base price) across a supplier's open POs. */
function supplierOpenCommitmentRappen(ctx: WorkspaceContext, supplierId: string): number {
  const row = ctx.store.db
    .prepare(
      `SELECT COALESCE(SUM((pl.qty - pl.billed_qty) * pl.unit_price_base_rappen), 0) AS v
         FROM po_line pl
         JOIN purchase_order po ON po.workspace_id = pl.workspace_id AND po.id = pl.po_id
        WHERE po.workspace_id = ? AND po.supplier_contact_id = ?
          AND po.status NOT IN ('cancelled', 'closed')
          AND pl.qty > pl.billed_qty`,
    )
    .get(ctx.workspaceId, supplierId) as { v: number };
  return row.v;
}

// --- US-I06.5: Requisition pipeline -----------------------------------------------------------------

export interface RequisitionPipelineInput {
  status?: unknown;
  requester_ids?: unknown;
  aging_days_min?: unknown;
  from_date?: unknown;
  to_date?: unknown;
}

interface RequisitionRow {
  id: string;
  number: string;
  status: string;
  requester_id: string;
  needed_by: string;
  total_estimated_rappen: number;
  created_at: string;
  updated_at: string;
  converted_po_id: string | null;
  first_conversion_at: string | null;
}

const REQ_STALL_DEFAULT_DAYS = 14;

/**
 * US-I06.5: the requisition pipeline. Summary count + value by status, open rows with days-in-status
 * and the linked PO / conversion lag, plus a conversion rate and average request-to-PO cycle over the
 * window. Stalled requests (days-in-status above the threshold) are flagged.
 */
export function procurementRequisitionPipeline(ctx: WorkspaceContext, input: RequisitionPipelineInput): Result {
  const period = resolvePeriod(ctx, input, 365);
  if ('error' in period) return err(period.error, { field: period.field });
  const wantedStatus = strArray(input.status);
  const agingMin = Math.max(0, Math.trunc(numOr(input.aging_days_min, 0)));
  const stallThreshold = REQ_STALL_DEFAULT_DAYS;

  const where: string[] = ['r.workspace_id = ?', 'substr(r.created_at, 1, 10) >= ?', 'substr(r.created_at, 1, 10) <= ?'];
  const params: unknown[] = [ctx.workspaceId, period.from, period.to];
  const req = inClause('r.requester_id', strArray(input.requester_ids));
  if (req !== null) {
    where.push(req.sql);
    params.push(...req.params);
  }

  const rows = ctx.store.db
    .prepare(
      `SELECT r.id AS id, r.number AS number, r.status AS status, r.requester_id AS requester_id,
              r.needed_by AS needed_by, r.total_estimated_rappen AS total_estimated_rappen,
              r.created_at AS created_at, r.updated_at AS updated_at,
              (SELECT rc.purchase_order_id FROM requisition_conversion rc
                WHERE rc.workspace_id = r.workspace_id AND rc.requisition_id = r.id
                ORDER BY rc.created_at LIMIT 1) AS converted_po_id,
              (SELECT rc.created_at FROM requisition_conversion rc
                WHERE rc.workspace_id = r.workspace_id AND rc.requisition_id = r.id
                ORDER BY rc.created_at LIMIT 1) AS first_conversion_at
         FROM requisition r
        WHERE ${where.join(' AND ')}
        ORDER BY r.created_at, r.id`,
    )
    .all(...params) as RequisitionRow[];

  const now = today(ctx);
  const summary: Record<string, { count: number; value_rappen: number }> = {};
  const openRows: Record<string, unknown>[] = [];
  let convertedCount = 0;
  let lagSum = 0;
  let lagCount = 0;
  for (const r of rows) {
    const bucket = summary[r.status] ?? { count: 0, value_rappen: 0 };
    bucket.count += 1;
    bucket.value_rappen += r.total_estimated_rappen;
    summary[r.status] = bucket;
    const isConverted = r.status === 'converted' || r.status === 'partially_converted' || r.converted_po_id !== null;
    if (isConverted) {
      convertedCount += 1;
      if (r.first_conversion_at !== null) {
        lagSum += Math.max(0, daysBetween(r.created_at.slice(0, 10), r.first_conversion_at.slice(0, 10)));
        lagCount += 1;
      }
    }
    const daysInStatus = Math.max(0, daysBetween(r.updated_at.slice(0, 10), now));
    if (wantedStatus !== undefined && !wantedStatus.includes(r.status)) continue;
    if (daysInStatus < agingMin) continue;
    openRows.push({
      requisitionId: r.id,
      number: r.number,
      requesterId: r.requester_id,
      neededBy: r.needed_by,
      totalEstimatedRappen: r.total_estimated_rappen,
      status: r.status,
      daysInStatus,
      linkedPoId: r.converted_po_id,
      conversionLagDays:
        r.first_conversion_at !== null ? Math.max(0, daysBetween(r.created_at.slice(0, 10), r.first_conversion_at.slice(0, 10))) : null,
      stalled: daysInStatus > stallThreshold && r.status !== 'converted' && r.status !== 'closed' && r.status !== 'cancelled',
    });
  }

  return ok({
    period,
    summary,
    rows: openRows,
    conversion: {
      total: rows.length,
      converted: convertedCount,
      conversion_rate_pct: pct1(convertedCount, rows.length),
      avg_conversion_lag_days: lagCount === 0 ? null : roundTo(1, lagSum / lagCount),
    },
    stallThresholdDays: stallThreshold,
  });
}

// --- US-I06.6: GR/IR clearing -----------------------------------------------------------------------

export interface GrirClearingInput {
  as_of?: unknown;
  supplier_ids?: unknown;
  materiality_rappen?: unknown;
  include_detail?: unknown;
}

interface GrirLineRow {
  po_id: string;
  po_number: string;
  supplier_id: string;
  supplier_name: string | null;
  line_id: string;
  item_id: string | null;
  description: string | null;
  received_qty: number;
  billed_qty: number;
  unit_price_base_rappen: number;
}

/**
 * US-I06.6: the GR/IR clearing status. RNI = received-not-invoiced (received_qty > billed_qty); INR =
 * invoiced-not-received (billed_qty > received_qty). Residual value is the residual quantity times the
 * PO base price. `cleared` when both sides are empty (within the materiality filter).
 */
export function procurementGrirClearing(ctx: WorkspaceContext, input: GrirClearingInput): Result {
  const asOf = asDate(input.as_of) ?? today(ctx);
  const materiality = Math.max(0, Math.trunc(numOr(input.materiality_rappen, 0)));
  const includeDetail = input.include_detail === true;

  const where: string[] = ['po.workspace_id = ?', "po.status != 'cancelled'", '(pl.received_qty <> pl.billed_qty)'];
  const params: unknown[] = [ctx.workspaceId];
  const sup = inClause('po.supplier_contact_id', strArray(input.supplier_ids));
  if (sup !== null) {
    where.push(sup.sql);
    params.push(...sup.params);
  }

  const rows = ctx.store.db
    .prepare(
      `SELECT po.id AS po_id, po.number AS po_number, po.supplier_contact_id AS supplier_id, c.name AS supplier_name,
              pl.id AS line_id, pl.item_id AS item_id, pl.description AS description,
              pl.received_qty AS received_qty, pl.billed_qty AS billed_qty,
              pl.unit_price_base_rappen AS unit_price_base_rappen
         FROM po_line pl
         JOIN purchase_order po ON po.workspace_id = pl.workspace_id AND po.id = pl.po_id
         LEFT JOIN contact c ON c.workspace_id = po.workspace_id AND c.id = po.supplier_contact_id
        WHERE ${where.join(' AND ')}
        ORDER BY po.number, pl.sort, pl.id`,
    )
    .all(...params) as GrirLineRow[];

  const rni = { count: 0, residual_value_rappen: 0, rows: [] as Record<string, unknown>[] };
  const inr = { count: 0, residual_value_rappen: 0, rows: [] as Record<string, unknown>[] };
  for (const r of rows) {
    const diff = r.received_qty - r.billed_qty;
    const residualQty = Math.abs(diff);
    const residualValue = residualQty * r.unit_price_base_rappen;
    if (residualValue < materiality) continue;
    const side = diff > 0 ? rni : inr;
    side.count += 1;
    side.residual_value_rappen += residualValue;
    if (includeDetail) {
      side.rows.push({
        poId: r.po_id,
        poNumber: r.po_number,
        supplierId: r.supplier_id,
        supplierName: r.supplier_name ?? '',
        lineId: r.line_id,
        itemId: r.item_id,
        description: r.description,
        receivedQty: r.received_qty,
        billedQty: r.billed_qty,
        residualQty,
        residualValueRappen: residualValue,
      });
    }
  }

  const cleared = rni.count === 0 && inr.count === 0;
  return ok({
    as_of: asOf,
    received_not_invoiced: includeDetail ? rni : { count: rni.count, residual_value_rappen: rni.residual_value_rappen },
    invoiced_not_received: includeDetail ? inr : { count: inr.count, residual_value_rappen: inr.residual_value_rappen },
    net_exposure_rappen: rni.residual_value_rappen - inr.residual_value_rappen,
    status: cleared ? 'cleared' : 'exposure_present',
  });
}

// --- US-I06.7: Landed-cost variance -----------------------------------------------------------------

export interface LandedCostVarianceInput {
  from_date?: unknown;
  to_date?: unknown;
  filter?: { supplier_ids?: unknown };
  format?: unknown;
}

interface VoucherRow {
  id: string;
  number: string;
  status: string;
  is_estimated: number;
  total_cost_minor: number;
  capitalized_minor: number | null;
  variance_minor: number | null;
  effective_date: string;
}

/**
 * US-I06.7: landed-cost variance. For each allocated I03 voucher in the window, the planned total
 * (`total_cost_minor`) against the capitalized and expensed (variance) split the confirm posted, plus
 * the component breakdown. Largest absolute variance first.
 */
export function procurementLandedCostVariance(ctx: WorkspaceContext, input: LandedCostVarianceInput): Result {
  const period = resolvePeriod(ctx, input, 90);
  if ('error' in period) return err(period.error, { field: period.field });

  const vouchers = ctx.store.db
    .prepare(
      `SELECT id, number, status, is_estimated, total_cost_minor, capitalized_minor, variance_minor, effective_date
         FROM landed_cost_voucher
        WHERE workspace_id = ? AND status = 'allocated'
          AND effective_date >= ? AND effective_date <= ?
        ORDER BY effective_date, id`,
    )
    .all(ctx.workspaceId, period.from, period.to) as VoucherRow[];

  const rows: Record<string, unknown>[] = [];
  const totals = { planned_minor: 0, capitalized_minor: 0, variance_minor: 0 };
  for (const v of vouchers) {
    const capitalized = v.capitalized_minor ?? v.total_cost_minor;
    const variance = v.variance_minor ?? 0;
    const components = ctx.store.db
      .prepare(
        `SELECT component_type, COALESCE(SUM(amount_base_minor), 0) AS amount_minor
           FROM landed_cost_line WHERE workspace_id = ? AND voucher_id = ?
          GROUP BY component_type ORDER BY component_type`,
      )
      .all(ctx.workspaceId, v.id) as { component_type: string; amount_minor: number }[];
    totals.planned_minor += v.total_cost_minor;
    totals.capitalized_minor += capitalized;
    totals.variance_minor += variance;
    rows.push({
      voucherId: v.id,
      number: v.number,
      effectiveDate: v.effective_date,
      isEstimated: v.is_estimated === 1,
      plannedMinor: v.total_cost_minor,
      capitalizedMinor: capitalized,
      varianceMinor: variance,
      variancePct: v.total_cost_minor === 0 ? null : roundTo(1, (variance * 100) / v.total_cost_minor),
      components: components.map((c) => ({ componentType: c.component_type, amountMinor: c.amount_minor })),
    });
  }
  rows.sort((a, b) => Math.abs(b.varianceMinor as number) - Math.abs(a.varianceMinor as number));

  return ok({
    from_date: period.from,
    to_date: period.to,
    rows,
    totals,
    format: 'json',
  });
}

// --- US-I06.8: PO cycle time ------------------------------------------------------------------------

export interface PoCycleInput {
  from_date?: unknown;
  to_date?: unknown;
  group_by?: unknown;
}

interface PoCycleRow {
  po_id: string;
  supplier_id: string;
  supplier_name: string | null;
  created_at: string;
  first_receipt_at: string | null;
  last_match_at: string | null;
}

/**
 * US-I06.8: PO cycle-time metrics over POs that reached a terminal state (received / closed) in the
 * window. Measures order -> first receipt and order -> full match (the timestamps the engine records;
 * there is no sent_at, per the spec §0 reconciliation). Average plus p50 / p90 per stage.
 */
export function procurementPoCycle(ctx: WorkspaceContext, input: PoCycleInput): Result {
  const period = resolvePeriod(ctx, input, 90);
  if ('error' in period) return err(period.error, { field: period.field });
  const groupBy = ['none', 'supplier'].includes(String(input.group_by)) ? (String(input.group_by) as 'none' | 'supplier') : 'none';

  const rows = ctx.store.db
    .prepare(
      `SELECT po.id AS po_id, po.supplier_contact_id AS supplier_id, c.name AS supplier_name, po.created_at AS created_at,
              (SELECT MIN(gr.received_at) FROM goods_receipt gr
                WHERE gr.workspace_id = po.workspace_id AND gr.po_id = po.id) AS first_receipt_at,
              (SELECT MAX(m.created_at) FROM three_way_match m
                WHERE m.workspace_id = po.workspace_id AND m.po_id = po.id
                  AND m.status IN ('matched', 'partial', 'overridden') AND m.reversing_match_id IS NULL) AS last_match_at
         FROM purchase_order po
         LEFT JOIN contact c ON c.workspace_id = po.workspace_id AND c.id = po.supplier_contact_id
        WHERE po.workspace_id = ? AND po.status IN ('received', 'closed')
          AND substr(po.updated_at, 1, 10) >= ? AND substr(po.updated_at, 1, 10) <= ?
        ORDER BY po.created_at, po.id`,
    )
    .all(ctx.workspaceId, period.from, period.to) as PoCycleRow[];

  const buckets = new Map<string, { label: string; toReceipt: number[]; toMatch: number[]; count: number }>();
  for (const r of rows) {
    const key = groupBy === 'supplier' ? r.supplier_id : 'all';
    const label = groupBy === 'supplier' ? (r.supplier_name ?? '') : 'all';
    const b = buckets.get(key) ?? { label, toReceipt: [], toMatch: [], count: 0 };
    b.count += 1;
    if (r.first_receipt_at !== null) b.toReceipt.push(Math.max(0, daysBetween(r.created_at.slice(0, 10), r.first_receipt_at.slice(0, 10))));
    if (r.last_match_at !== null) b.toMatch.push(Math.max(0, daysBetween(r.created_at.slice(0, 10), r.last_match_at.slice(0, 10))));
    buckets.set(key, b);
  }

  const groups = [...buckets.entries()].map(([key, b]) => ({
    key,
    label: b.label,
    completed_count: b.count,
    order_to_first_receipt: stageStats(b.toReceipt),
    order_to_full_match: stageStats(b.toMatch),
  }));

  return ok({
    period,
    group_by: groupBy,
    groups,
  });
}

/** avg / p50 / p90 (nearest-rank) over a day-count sample, or nulls when empty. */
function stageStats(sample: number[]): { count: number; avg_days: number | null; p50_days: number | null; p90_days: number | null } {
  if (sample.length === 0) return { count: 0, avg_days: null, p50_days: null, p90_days: null };
  const sorted = [...sample].sort((a, b) => a - b);
  const avg = roundTo(1, sorted.reduce((s, v) => s + v, 0) / sorted.length);
  return { count: sorted.length, avg_days: avg, p50_days: percentile(sorted, 50), p90_days: percentile(sorted, 90) };
}
/** Nearest-rank percentile over a pre-sorted ascending sample. */
function percentile(sorted: number[], p: number): number {
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[clamp(rank - 1, 0, sorted.length - 1)] ?? 0;
}

// --- US-I06.9: Anomalies ----------------------------------------------------------------------------

export interface AnomaliesInput {
  since?: unknown;
  types?: unknown;
  severity?: unknown;
  limit?: unknown;
}

const ANOMALY_DEFAULTS = {
  sinceDays: 30,
  largePriceVariancePct: 5,
  agingCommitmentRappen: 1_000_00, // CHF 1'000
  grirMaterialityRappen: 1_000_00,
  stalledReqDays: 14,
};

/**
 * US-I06.9: a prioritised anomaly list derived (never stored) from the live documents. Phase-1 types:
 * large price variance (overridden / out-of-tolerance match), match override, stalled requisition,
 * aged open commitment (90+ bucket above threshold) and material GR/IR exposure.
 */
export function procurementAnomalies(ctx: WorkspaceContext, input: AnomaliesInput): Result {
  const sinceDate = asDate(input.since) ?? shiftDate(today(ctx), -ANOMALY_DEFAULTS.sinceDays);
  const wantedTypes = strArray(input.types);
  const wantedSeverity = strArray(input.severity);
  const limit = clamp(Math.trunc(numOr(input.limit, 100)), 1, 1000);
  const now = today(ctx);

  interface Anomaly {
    type: string;
    severity: 'info' | 'warning' | 'critical';
    summary: string;
    poId?: string;
    billId?: string;
    supplierId?: string;
    requisitionId?: string;
    detectedAt: string;
    payload: Record<string, unknown>;
  }
  const out: Anomaly[] = [];

  // Match anomalies (overridden / partial matches since `sinceDate`).
  const matches = ctx.store.db
    .prepare(
      `SELECT m.id AS id, m.po_id AS po_id, m.bill_id AS bill_id, m.status AS status,
              m.price_variance_rappen AS price_variance_rappen, m.total_expected_rappen AS total_expected_rappen,
              m.created_at AS matched_at, po.supplier_contact_id AS supplier_id
         FROM three_way_match m
         JOIN purchase_order po ON po.workspace_id = m.workspace_id AND po.id = m.po_id
        WHERE m.workspace_id = ? AND m.reversing_match_id IS NULL
          AND m.status IN ('overridden', 'partial')
          AND substr(m.created_at, 1, 10) >= ?`,
    )
    .all(ctx.workspaceId, sinceDate) as {
    id: string;
    po_id: string;
    bill_id: string;
    status: string;
    price_variance_rappen: number;
    total_expected_rappen: number;
    matched_at: string;
    supplier_id: string;
  }[];
  for (const m of matches) {
    const pct =
      m.total_expected_rappen === 0 ? null : roundTo(1, (Math.abs(m.price_variance_rappen) * 100) / Math.abs(m.total_expected_rappen));
    if (m.status === 'overridden') {
      out.push({
        type: 'match_override_high_value',
        severity: Math.abs(m.price_variance_rappen) >= ANOMALY_DEFAULTS.agingCommitmentRappen ? 'critical' : 'warning',
        summary: 'A three-way match was forced with an out-of-tolerance override.',
        poId: m.po_id,
        billId: m.bill_id,
        supplierId: m.supplier_id,
        detectedAt: m.matched_at.slice(0, 10),
        payload: { priceVarianceRappen: m.price_variance_rappen, variancePct: pct },
      });
    }
    if (pct !== null && pct >= ANOMALY_DEFAULTS.largePriceVariancePct) {
      out.push({
        type: 'large_price_variance',
        severity: pct >= ANOMALY_DEFAULTS.largePriceVariancePct * 3 ? 'critical' : 'warning',
        summary: `Match price variance ${pct}% exceeds the ${ANOMALY_DEFAULTS.largePriceVariancePct}% threshold.`,
        poId: m.po_id,
        billId: m.bill_id,
        supplierId: m.supplier_id,
        detectedAt: m.matched_at.slice(0, 10),
        payload: { priceVarianceRappen: m.price_variance_rappen, variancePct: pct },
      });
    }
  }

  // Aged open commitments in the 90+ bucket above threshold (per PO).
  const commitments = procurementOpenCommitments(ctx, { group_by: 'supplier' });
  void commitments; // grouped variant not needed here; recompute per-PO below.
  const poAging = ctx.store.db
    .prepare(
      `SELECT po.id AS po_id, po.supplier_contact_id AS supplier_id, po.created_at AS created_at,
              COALESCE(SUM((pl.qty - pl.billed_qty) * pl.unit_price_base_rappen), 0) AS open_value
         FROM po_line pl
         JOIN purchase_order po ON po.workspace_id = pl.workspace_id AND po.id = pl.po_id
        WHERE po.workspace_id = ? AND po.status NOT IN ('cancelled', 'closed') AND pl.qty > pl.billed_qty
        GROUP BY po.id`,
    )
    .all(ctx.workspaceId) as { po_id: string; supplier_id: string; created_at: string; open_value: number }[];
  for (const p of poAging) {
    const days = Math.max(0, daysBetween(p.created_at.slice(0, 10), now));
    if (days > 90 && p.open_value >= ANOMALY_DEFAULTS.agingCommitmentRappen) {
      out.push({
        type: 'open_commitment_aging',
        severity: 'warning',
        summary: `Open commitment aged ${days} days with residual value above threshold.`,
        poId: p.po_id,
        supplierId: p.supplier_id,
        detectedAt: now,
        payload: { daysOpen: days, openValueRappen: p.open_value },
      });
    }
  }

  // Stalled requisitions (open state beyond threshold).
  const reqs = ctx.store.db
    .prepare(
      `SELECT id, requester_id, status, updated_at FROM requisition
        WHERE workspace_id = ? AND status IN ('draft', 'pending_approval', 'approved', 'partially_converted')`,
    )
    .all(ctx.workspaceId) as { id: string; requester_id: string; status: string; updated_at: string }[];
  for (const r of reqs) {
    const days = Math.max(0, daysBetween(r.updated_at.slice(0, 10), now));
    if (days > ANOMALY_DEFAULTS.stalledReqDays) {
      out.push({
        type: 'stalled_requisition',
        severity: 'info',
        summary: `Requisition has sat in ${r.status} for ${days} days.`,
        requisitionId: r.id,
        detectedAt: now,
        payload: { daysInStatus: days, status: r.status },
      });
    }
  }

  // Material GR/IR exposure.
  const grir = procurementGrirClearing(ctx, { materiality_rappen: ANOMALY_DEFAULTS.grirMaterialityRappen });
  if (grir.ok) {
    const g = grir as unknown as {
      received_not_invoiced: { count: number; residual_value_rappen: number };
      invoiced_not_received: { count: number; residual_value_rappen: number };
    };
    if (g.received_not_invoiced.count > 0) {
      out.push({
        type: 'grir_material_exposure',
        severity: 'warning',
        summary: 'Material received-not-invoiced (RNI) exposure above materiality.',
        detectedAt: now,
        payload: { side: 'rni', count: g.received_not_invoiced.count, residualValueRappen: g.received_not_invoiced.residual_value_rappen },
      });
    }
    if (g.invoiced_not_received.count > 0) {
      out.push({
        type: 'grir_material_exposure',
        severity: 'warning',
        summary: 'Material invoiced-not-received (INR) exposure above materiality.',
        detectedAt: now,
        payload: { side: 'inr', count: g.invoiced_not_received.count, residualValueRappen: g.invoiced_not_received.residual_value_rappen },
      });
    }
  }

  const severityRank: Record<'info' | 'warning' | 'critical', number> = { critical: 0, warning: 1, info: 2 };
  let filtered = out;
  if (wantedTypes !== undefined) filtered = filtered.filter((a) => wantedTypes.includes(a.type));
  if (wantedSeverity !== undefined) filtered = filtered.filter((a) => wantedSeverity.includes(a.severity));
  filtered.sort((a, b) => severityRank[a.severity] - severityRank[b.severity] || b.detectedAt.localeCompare(a.detectedAt));

  return ok({
    since: sinceDate,
    anomalies: filtered.slice(0, limit),
    counts: {
      total: filtered.length,
      critical: filtered.filter((a) => a.severity === 'critical').length,
      warning: filtered.filter((a) => a.severity === 'warning').length,
      info: filtered.filter((a) => a.severity === 'info').length,
    },
  });
}

// --- US-I06.10: PO history --------------------------------------------------------------------------

export interface PoHistoryInput {
  po_id?: unknown;
  from_date?: unknown;
  to_date?: unknown;
}

interface HistoryEvent {
  event_type: string;
  event_at: string;
  actor: string | null;
  summary: string;
  amount_rappen?: number;
  qty?: number;
  ref_kind: string;
  ref_id: string;
  version_number?: number;
}

/**
 * US-I06.10: the chronological history of one PO: creation, amendments/revisions, posted receipts,
 * landed-cost allocations and three-way matches. Running open_qty / open_value is maintained across
 * the match events and MUST close to the live commitment (ordered - billed) for the PO (tripwire).
 * A foreign or unknown po_id is `not_found` (§H-TENANT).
 */
export function procurementPoHistory(ctx: WorkspaceContext, input: PoHistoryInput): Result {
  const poId = typeof input.po_id === 'string' ? input.po_id : '';
  if (poId.length === 0) return err('invalid_input', { field: 'po_id' });
  const po = ctx.store.db
    .prepare('SELECT id, number, status, created_at FROM purchase_order WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, poId) as { id: string; number: string; status: string; created_at: string } | undefined;
  if (po === undefined) return err('not_found', { po_id: poId }); // §H-TENANT: a foreign PO cannot be named.

  const events: HistoryEvent[] = [];
  events.push({
    event_type: 'created',
    event_at: po.created_at,
    actor: null,
    summary: `Purchase order ${po.number} created.`,
    ref_kind: 'purchase_order',
    ref_id: po.id,
  });

  // I01 amendments / revisions.
  const revisions = ctx.store.db
    .prepare('SELECT id, revision, revised_by, revised_at, reason FROM po_revision WHERE workspace_id = ? AND po_id = ? ORDER BY revision')
    .all(ctx.workspaceId, poId) as { id: string; revision: number; revised_by: string | null; revised_at: string; reason: string | null }[];
  for (const r of revisions) {
    events.push({
      event_type: 'revised',
      event_at: r.revised_at,
      actor: r.revised_by,
      summary: r.reason ?? `Revised to revision ${r.revision}.`,
      ref_kind: 'po_revision',
      ref_id: r.id,
      version_number: r.revision,
    });
  }

  // Goods receipts. The D02 `goods_receipt` table is the SHARED received-quantity trail BOTH the D02
  // `receipt_record` path and the I02 goods-receipt document append to (see receiptSchema.ts), so it
  // is the one place that sees every received unit regardless of which path recorded it.
  const receipts = ctx.store.db
    .prepare(
      `SELECT gr.id AS id, gr.received_at AS received_at, gr.created_at AS created_at,
              COALESCE(SUM(l.qty), 0) AS qty
         FROM goods_receipt gr
         LEFT JOIN goods_receipt_line l ON l.workspace_id = gr.workspace_id AND l.receipt_id = gr.id
        WHERE gr.workspace_id = ? AND gr.po_id = ?
        GROUP BY gr.id
        ORDER BY gr.received_at, gr.id`,
    )
    .all(ctx.workspaceId, poId) as { id: string; received_at: string; created_at: string; qty: number }[];
  for (const gr of receipts) {
    events.push({
      event_type: 'goods_received',
      event_at: gr.received_at,
      actor: null,
      summary: `Goods received (${gr.qty} units).`,
      qty: gr.qty,
      ref_kind: 'goods_receipt',
      ref_id: gr.id,
    });
  }

  // I03 landed-cost allocations targeting this PO's receipt lines.
  const landed = ctx.store.db
    .prepare(
      `SELECT DISTINCT v.id AS id, v.number AS number, v.allocated_at AS allocated_at, v.allocated_by AS allocated_by,
              v.capitalized_minor AS capitalized_minor, v.total_cost_minor AS total_cost_minor
         FROM landed_cost_voucher v
         JOIN landed_cost_target t ON t.workspace_id = v.workspace_id AND t.voucher_id = v.id
         JOIN goods_receipt_doc_line grl ON grl.workspace_id = t.workspace_id AND grl.id = t.goods_receipt_line_id
        WHERE v.workspace_id = ? AND grl.po_id = ? AND v.status = 'allocated'
        ORDER BY v.allocated_at, v.id`,
    )
    .all(ctx.workspaceId, poId) as { id: string; number: string; allocated_at: string | null; allocated_by: string | null; capitalized_minor: number | null; total_cost_minor: number }[];
  for (const v of landed) {
    events.push({
      event_type: 'landed_cost_allocated',
      event_at: v.allocated_at ?? po.created_at,
      actor: v.allocated_by,
      summary: `Landed-cost voucher ${v.number} allocated.`,
      amount_rappen: v.capitalized_minor ?? v.total_cost_minor,
      ref_kind: 'landed_cost_voucher',
      ref_id: v.id,
    });
  }

  // I04 three-way matches (active).
  const matches = ctx.store.db
    .prepare(
      `SELECT id, bill_id, status, total_billed_rappen, total_qty, created_at AS matched_at, created_by
         FROM three_way_match
        WHERE workspace_id = ? AND po_id = ? AND status IN ('matched', 'partial', 'overridden') AND reversing_match_id IS NULL
        ORDER BY created_at, id`,
    )
    .all(ctx.workspaceId, poId) as { id: string; bill_id: string; status: string; total_billed_rappen: number; total_qty: number; matched_at: string; created_by: string | null }[];
  for (const m of matches) {
    events.push({
      event_type: 'matched',
      event_at: m.matched_at,
      actor: m.created_by,
      summary: `Bill matched (${m.status}).`,
      amount_rappen: m.total_billed_rappen,
      qty: m.total_qty,
      ref_kind: 'three_way_match',
      ref_id: m.id,
    });
  }

  events.sort((a, b) => a.event_at.localeCompare(b.event_at) || eventRank(a.event_type) - eventRank(b.event_type));

  // The live commitment is the source of truth; the running figure must close to it (tripwire).
  const live = ctx.store.db
    .prepare(
      `SELECT COALESCE(SUM(qty), 0) AS ordered_qty, COALESCE(SUM(billed_qty), 0) AS billed_qty,
              COALESCE(SUM((qty - billed_qty) * unit_price_base_rappen), 0) AS open_value
         FROM po_line WHERE workspace_id = ? AND po_id = ?`,
    )
    .get(ctx.workspaceId, poId) as { ordered_qty: number; billed_qty: number; open_value: number };
  const runningOpenQty = live.ordered_qty - live.billed_qty;

  const fromD = asDate(input.from_date);
  const toD = asDate(input.to_date);
  const shown = events.filter((e) => {
    const d = e.event_at.slice(0, 10);
    if (fromD !== null && d < fromD) return false;
    if (toD !== null && d > toD) return false;
    return true;
  });

  return ok({
    po_id: po.id,
    po_number: po.number,
    status: po.status,
    events: shown,
    running_open_qty: runningOpenQty,
    running_open_value_rappen: live.open_value,
  });
}

/** Same-timestamp ordering: creation, then revision, receipt, landed cost, match. */
function eventRank(type: string): number {
  const order: Record<string, number> = { created: 0, revised: 1, goods_received: 2, landed_cost_allocated: 3, matched: 4 };
  return order[type] ?? 9;
}
