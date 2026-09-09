/**
 * C03, sales forecasting: a PURE READ MODEL (P5) over C01 deals, C02 quotes and the A08 statements.
 *
 * THIS MODULE WRITES NOTHING. No table, no column, no INSERT, no cache: every figure is recomputed
 * from the source rows on every call, so there is no state to migrate, snapshot or invalidate, and
 * "the invoice landed" changes the answer on the next read with no invalidation step. The module
 * imports neither `postEntry` nor `recordPayment` (asserted structurally in
 * `test/forecast/forecast-c03.test.mjs`), and its only SQL verbs are SELECTs.
 *
 * THE ONE ROUNDING POINT PER DEAL IS C01's. `weightedMinor` (round-once, half away from zero, P2)
 * is imported from the deals module rather than re-implemented, so the board's weighted pill and
 * every C03 aggregate are ONE formula and can never drift apart. Sums are integer additions over
 * the stored CHF base (`value_base_minor`, §H-FX, frozen at capture); C03 never converts and never
 * re-rates history.
 *
 * THE ANTI-DOUBLE-COUNT MODEL (US-C03.3, §6b Fixed): `forecast_revenue` returns three components
 * per month and each expected Rappen appears in exactly ONE of them. A deal-linked quote is
 * represented by its deal (weighted while open, 100 % once won), so it is excluded from the
 * open-quote component; a won deal leaves the forecast the moment an invoice is reachable over the
 * A10 `source_document_id` chain. A foreign-currency quote has NO stored CHF base on the A10 row,
 * so it degrades honestly into `excluded[]` with `needs_fx_rate` (P9), never a silently wrong
 * total. Deals cannot hit that branch: C01's `value_base_minor` is NOT NULL.
 *
 * §H-TENANT: every query below filters `workspace_id = ctx.workspaceId`. Asserted in tests.
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { weightedMinor } from '../deals/deals.js';
import type { DealRow } from '../deals/deals.js';
import { computeIncomeStatement } from '../reports/statements.js';

/** The §H-ENUM base grouping set: single source, extended (never redefined) by a `deal` custom field. */
export const FORECAST_GROUP_BY = ['stage', 'month', 'quarter'] as const;
export type ForecastGroupBy = (typeof FORECAST_GROUP_BY)[number];

/** The 1-24 horizon bound (§6b Fixed): one place, shared by the verb and its tests. */
export const HORIZON_MIN = 1;
export const HORIZON_MAX = 24;

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Integer division rounded HALF AWAY FROM ZERO, the same convention C01's `weightedMinor` uses. */
function divideRoundHalfAway(numerator: number, denominator: number): number {
  const quotient = Math.trunc(numerator / denominator);
  const remainder = Math.abs(numerator % denominator);
  const bump = remainder * 2 >= Math.abs(denominator) ? Math.sign(numerator) || 1 : 0;
  return quotient + bump;
}

function baseCurrency(ctx: WorkspaceContext): string {
  const row = ctx.store.db
    .prepare('SELECT base_currency FROM workspace WHERE id = ?')
    .get(ctx.workspaceId) as { base_currency: string };
  return row.base_currency;
}

/** The bare day (YYYY-MM-DD) of the injected clock; never the wall clock. */
function today(ctx: WorkspaceContext): string {
  return ctx.clock.now().slice(0, 10);
}

/** 'YYYY-MM' of an ISO day. */
function monthOf(day: string): string {
  return day.slice(0, 7);
}

/** 'YYYY-Qn' of an ISO day. */
function quarterOf(day: string): string {
  const month = Number.parseInt(day.slice(5, 7), 10);
  return `${day.slice(0, 4)}-Q${Math.floor((month - 1) / 3) + 1}`;
}

/** The month key `offset` months after `monthKey` ('YYYY-MM'). */
function addMonths(monthKey: string, offset: number): string {
  const year = Number.parseInt(monthKey.slice(0, 4), 10);
  const month = Number.parseInt(monthKey.slice(5, 7), 10) - 1 + offset;
  const y = year + Math.floor(month / 12);
  const m = (((month % 12) + 12) % 12) + 1;
  return `${y}-${String(m).padStart(2, '0')}`;
}

interface StageRowLite {
  id: string;
  name: string;
  sort: number;
}

function openDeals(ctx: WorkspaceContext, pipelineId?: string): DealRow[] {
  const clauses = ['workspace_id = ?', `status = 'open'`];
  const params: string[] = [ctx.workspaceId];
  if (pipelineId !== undefined) {
    clauses.push('pipeline_id = ?');
    params.push(pipelineId);
  }
  return ctx.store.db
    .prepare(`SELECT * FROM deal WHERE ${clauses.join(' AND ')} ORDER BY created_at`)
    .all(...params) as DealRow[];
}

function pipelineExists(ctx: WorkspaceContext, pipelineId: string): boolean {
  return (
    ctx.store.db.prepare('SELECT id FROM pipeline WHERE workspace_id = ? AND id = ?').get(ctx.workspaceId, pipelineId) !==
    undefined
  );
}

interface FieldDefRow {
  id: string;
  key: string;
  type: string;
}

/** A confirmed, unarchived select/multiselect custom field on `deal`, or undefined (G00, read-only). */
function dealGroupField(ctx: WorkspaceContext, key: string): FieldDefRow | undefined {
  return ctx.store.db
    .prepare(
      `SELECT id, key, type FROM custom_field_def
        WHERE workspace_id = ? AND entity_kind = 'deal' AND key = ?
          AND archived = 0 AND draft = 0 AND type IN ('select', 'multiselect')`,
    )
    .get(ctx.workspaceId, key) as FieldDefRow | undefined;
}

/** The custom-field bucket keys of one deal: [] when unset (bucketed under 'none'). */
function fieldValuesOf(ctx: WorkspaceContext, fieldDefId: string, dealId: string): string[] {
  const row = ctx.store.db
    .prepare('SELECT value FROM custom_field_value WHERE workspace_id = ? AND field_def_id = ? AND entity_id = ?')
    .get(ctx.workspaceId, fieldDefId, dealId) as { value: string } | undefined;
  if (row === undefined) return [];
  try {
    const parsed: unknown = JSON.parse(row.value);
    if (typeof parsed === 'string') return parsed.length > 0 ? [parsed] : [];
    if (Array.isArray(parsed)) return parsed.filter((v): v is string => typeof v === 'string' && v.length > 0);
    return [];
  } catch {
    return [];
  }
}

// --- weightedPipeline ---------------------------------------------------------------------------

export interface WeightedPipelineInput {
  pipelineId?: string;
  groupBy?: string;
  horizonMonths?: number;
}

interface PipelineBucket {
  key: string;
  label: string;
  sort: number;
  dealCount: number;
  valueBaseMinor: number;
  weightedMinor: number;
}

/**
 * US-C03.1: the weighted pipeline over OPEN deals, grouped by stage, expected-close month/quarter,
 * or a registered `deal` select/multiselect custom field (§6b). Totals are computed over the DEAL
 * SET, never over the rows, so they are byte-identical for every valid `groupBy` (a multiselect
 * deal appears under each of its values, but is counted once in every total; §7 invariance).
 */
export function weightedPipeline(ctx: WorkspaceContext, input: WeightedPipelineInput = {}): Result {
  if (input.pipelineId !== undefined && !pipelineExists(ctx, input.pipelineId)) {
    return err('not_found', { pipelineId: input.pipelineId });
  }
  if (input.horizonMonths !== undefined) {
    if (!Number.isInteger(input.horizonMonths) || input.horizonMonths < HORIZON_MIN || input.horizonMonths > HORIZON_MAX) {
      return err('invalid_horizon', { horizonMonths: input.horizonMonths, allowed: `${HORIZON_MIN}-${HORIZON_MAX}` });
    }
  }
  const groupBy = input.groupBy ?? 'stage';
  let field: FieldDefRow | undefined;
  if (!(FORECAST_GROUP_BY as readonly string[]).includes(groupBy)) {
    field = dealGroupField(ctx, groupBy);
    if (field === undefined) {
      return err('invalid_group_by', { groupBy, allowed: [...FORECAST_GROUP_BY], hint: 'or a confirmed select/multiselect custom-field key on deal' });
    }
  }

  let deals = openDeals(ctx, input.pipelineId);
  // The horizon fence keeps DATELESS deals: a deal without a close date is unscheduled, not gone
  // (US-C03.1 boundary: never silently dropped).
  if (input.horizonMonths !== undefined) {
    const horizonEndMonth = addMonths(monthOf(today(ctx)), input.horizonMonths - 1);
    deals = deals.filter((d) => d.expected_close_on === null || monthOf(d.expected_close_on) <= horizonEndMonth);
  }

  const stages = new Map<string, StageRowLite>();
  if (groupBy === 'stage') {
    const rows = ctx.store.db
      .prepare('SELECT id, name, sort FROM pipeline_stage WHERE workspace_id = ?')
      .all(ctx.workspaceId) as StageRowLite[];
    for (const s of rows) stages.set(s.id, s);
  }

  /** The bucket keys ONE deal lands in (usually one; a multiselect value set can be several). */
  const bucketsOf = (deal: DealRow): { key: string; label: string; sort: number }[] => {
    if (field !== undefined) {
      const values = fieldValuesOf(ctx, field.id, deal.id);
      if (values.length === 0) return [{ key: 'none', label: 'none', sort: Number.MAX_SAFE_INTEGER }];
      return values.map((v) => ({ key: v, label: v, sort: 0 }));
    }
    if (groupBy === 'stage') {
      const stage = stages.get(deal.stage_id);
      return [{ key: deal.stage_id, label: stage?.name ?? deal.stage_id, sort: stage?.sort ?? 0 }];
    }
    if (deal.expected_close_on === null) return [{ key: 'none', label: 'none', sort: Number.MAX_SAFE_INTEGER }];
    const key = groupBy === 'month' ? monthOf(deal.expected_close_on) : quarterOf(deal.expected_close_on);
    return [{ key, label: key, sort: 0 }];
  };

  const buckets = new Map<string, PipelineBucket>();
  let totalValueBaseMinor = 0;
  let totalWeightedMinor = 0;
  for (const deal of deals) {
    const weighted = weightedMinor(deal.value_base_minor, deal.probability);
    // Totals count the DEAL once, whatever the grouping (§7 invariance).
    totalValueBaseMinor += deal.value_base_minor;
    totalWeightedMinor += weighted;
    for (const target of bucketsOf(deal)) {
      let bucket = buckets.get(target.key);
      if (bucket === undefined) {
        bucket = { key: target.key, label: target.label, sort: target.sort, dealCount: 0, valueBaseMinor: 0, weightedMinor: 0 };
        buckets.set(target.key, bucket);
      }
      bucket.dealCount += 1;
      bucket.valueBaseMinor += deal.value_base_minor;
      bucket.weightedMinor += weighted;
    }
  }

  const rows = [...buckets.values()]
    .sort((a, b) => a.sort - b.sort || a.key.localeCompare(b.key))
    .map(({ sort: _sort, ...row }) => row);

  return ok({
    groupBy,
    rows,
    totalDealCount: deals.length,
    totalValueBaseMinor,
    totalWeightedMinor,
    baseCurrency: baseCurrency(ctx),
  });
}

// --- salesKpis ----------------------------------------------------------------------------------

export interface SalesKpisInput {
  pipelineId?: string;
  from: string;
  to: string;
}

/**
 * The close timestamp of a won/lost deal: the OP5 timeline note `markDeal` appended (matched by
 * `deal_id` + body prefix, the only durable record of WHEN), with `updated_at` as the fallback for
 * a row whose note is missing. C03 adds no column for it (US-C03.2).
 */
function closedAtOf(ctx: WorkspaceContext, dealId: string, status: 'won' | 'lost', updatedAt: string): string {
  const prefix = status === 'won' ? 'Deal gewonnen:%' : 'Deal verloren:%';
  const row = ctx.store.db
    .prepare(
      'SELECT MAX(occurred_at) AS at FROM contact_activity WHERE workspace_id = ? AND deal_id = ? AND body LIKE ?',
    )
    .get(ctx.workspaceId, dealId, prefix) as { at: string | null };
  return row.at ?? updatedAt;
}

const DAY_MS = 86_400_000;

/**
 * US-C03.2: conversion rate (integer basis points), average WON deal size (round-once at the
 * division, P2) and average sales-cycle length in whole days, over deals CLOSED in the window.
 * `sample: 0` answers null KPIs, never a fake 0 % (P9).
 */
export function salesKpis(ctx: WorkspaceContext, input: SalesKpisInput): Result {
  if (typeof input.from !== 'string' || !ISO_DAY.test(input.from) || typeof input.to !== 'string' || !ISO_DAY.test(input.to)) {
    return err('invalid_range', { from: input.from, to: input.to, reason: 'from/to must be YYYY-MM-DD' });
  }
  if (input.from > input.to) return err('invalid_range', { from: input.from, to: input.to });
  if (input.pipelineId !== undefined && !pipelineExists(ctx, input.pipelineId)) {
    return err('not_found', { pipelineId: input.pipelineId });
  }

  const clauses = ['workspace_id = ?', `status IN ('won', 'lost')`];
  const params: string[] = [ctx.workspaceId];
  if (input.pipelineId !== undefined) {
    clauses.push('pipeline_id = ?');
    params.push(input.pipelineId);
  }
  const closed = ctx.store.db
    .prepare(`SELECT * FROM deal WHERE ${clauses.join(' AND ')}`)
    .all(...params) as DealRow[];

  let wonCount = 0;
  let lostCount = 0;
  let wonValueMinor = 0;
  let cycleMsTotal = 0;
  for (const deal of closed) {
    const status = deal.status as 'won' | 'lost';
    const closedAt = closedAtOf(ctx, deal.id, status, deal.updated_at);
    const closedDay = closedAt.slice(0, 10);
    if (closedDay < input.from || closedDay > input.to) continue;
    if (status === 'won') {
      wonCount += 1;
      wonValueMinor += deal.value_base_minor;
      cycleMsTotal += Math.max(0, Date.parse(closedAt) - Date.parse(deal.created_at));
    } else {
      lostCount += 1;
    }
  }

  const sample = wonCount + lostCount;
  return ok({
    conversionRateBp: sample === 0 ? null : divideRoundHalfAway(wonCount * 10_000, sample),
    avgDealSizeMinor: wonCount === 0 ? null : divideRoundHalfAway(wonValueMinor, wonCount),
    avgCycleDays: wonCount === 0 ? null : divideRoundHalfAway(cycleMsTotal, wonCount * DAY_MS),
    wonCount,
    lostCount,
    sample,
    baseCurrency: baseCurrency(ctx),
  });
}

// --- revenue ------------------------------------------------------------------------------------

export interface RevenueInput {
  horizonMonths: number;
}

interface RevenuePeriod {
  periodKey: string;
  weightedOpenMinor: number;
  wonUninvoicedMinor: number;
  openQuotesMinor: number;
  totalMinor: number;
}

/** The C02-linked quote ids of one deal: `deal.quote_id` plus every quote carrying its `deal_id`. */
function linkedQuoteIds(ctx: WorkspaceContext, deal: DealRow): string[] {
  const ids = new Set<string>();
  if (deal.quote_id !== null) ids.add(deal.quote_id);
  const rows = ctx.store.db
    .prepare(`SELECT id FROM document WHERE workspace_id = ? AND type = 'quote' AND deal_id = ?`)
    .all(ctx.workspaceId, deal.id) as { id: string }[];
  for (const row of rows) ids.add(row.id);
  return [...ids];
}

/** True when an A11 invoice is reachable from `quoteId` over `source_document_id` (quote or quote→order). */
function invoiceReachableFromQuote(ctx: WorkspaceContext, quoteId: string): boolean {
  const row = ctx.store.db
    .prepare(
      `SELECT COUNT(*) AS n FROM document inv
        WHERE inv.workspace_id = ? AND inv.type = 'invoice'
          AND (inv.source_document_id = ?
               OR inv.source_document_id IN (
                    SELECT o.id FROM document o
                     WHERE o.workspace_id = ? AND o.type = 'order' AND o.source_document_id = ?))`,
    )
    .get(ctx.workspaceId, quoteId, ctx.workspaceId, quoteId) as { n: number };
  return row.n > 0;
}

/** US-C03.3 (b): a won deal is "invoiced" once ANY linked quote reaches an invoice. */
function dealInvoiced(ctx: WorkspaceContext, deal: DealRow): boolean {
  return linkedQuoteIds(ctx, deal).some((quoteId) => invoiceReachableFromQuote(ctx, quoteId));
}

interface QuoteRowLite {
  id: string;
  currency: string;
  total_minor: number;
  valid_until: string | null;
}

/**
 * US-C03.3: the per-month revenue forecast over the horizon. Three components, each Rappen in
 * exactly one (see the module docblock): (a) weighted open deals by expected-close month (overdue
 * or dateless closes land in the FIRST period, the "could close now" bucket), (b) won deals with
 * no reachable invoice at 100 %, (c) sent, unexpired, DEAL-LESS quotes at 100 % of their
 * base-currency total. Foreign-currency quotes degrade into `excluded[]` (P9, §H-FX).
 */
export function revenue(ctx: WorkspaceContext, input: RevenueInput): Result {
  if (!Number.isInteger(input.horizonMonths) || input.horizonMonths < HORIZON_MIN || input.horizonMonths > HORIZON_MAX) {
    return err('invalid_horizon', { horizonMonths: input.horizonMonths, allowed: `${HORIZON_MIN}-${HORIZON_MAX}` });
  }

  const day = today(ctx);
  const firstMonth = monthOf(day);
  const periodKeys: string[] = [];
  for (let i = 0; i < input.horizonMonths; i += 1) periodKeys.push(addMonths(firstMonth, i));
  const lastMonth = periodKeys[periodKeys.length - 1] as string;
  const periods = new Map<string, RevenuePeriod>(
    periodKeys.map((periodKey) => [
      periodKey,
      { periodKey, weightedOpenMinor: 0, wonUninvoicedMinor: 0, openQuotesMinor: 0, totalMinor: 0 },
    ]),
  );
  const bucketFor = (isoDay: string | null): RevenuePeriod | undefined => {
    const month = isoDay === null ? firstMonth : monthOf(isoDay) < firstMonth ? firstMonth : monthOf(isoDay);
    if (month > lastMonth) return undefined;
    return periods.get(month);
  };

  const excluded: { quoteId: string; reason: string }[] = [];
  const base = baseCurrency(ctx);

  // (a) weighted open deals.
  for (const deal of openDeals(ctx)) {
    const bucket = bucketFor(deal.expected_close_on);
    if (bucket === undefined) continue; // expected close beyond the horizon: outside this window.
    bucket.weightedOpenMinor += weightedMinor(deal.value_base_minor, deal.probability);
  }

  // (b) won, not yet invoiced, at 100 %.
  const wonDeals = ctx.store.db
    .prepare(`SELECT * FROM deal WHERE workspace_id = ? AND status = 'won'`)
    .all(ctx.workspaceId) as DealRow[];
  for (const deal of wonDeals) {
    if (dealInvoiced(ctx, deal)) continue;
    const bucket = bucketFor(deal.expected_close_on);
    if (bucket === undefined) continue;
    bucket.wonUninvoicedMinor += deal.value_base_minor;
  }

  // (c) sent, unexpired quotes with NO deal on either side of the link (dedup, deal preferred).
  const quotes = ctx.store.db
    .prepare(
      `SELECT q.id, q.currency, q.total_minor, q.valid_until FROM document q
        WHERE q.workspace_id = ? AND q.type = 'quote' AND q.status = 'sent'
          AND q.deal_id IS NULL
          AND (q.valid_until IS NULL OR q.valid_until >= ?)
          AND NOT EXISTS (SELECT 1 FROM deal d WHERE d.workspace_id = q.workspace_id AND d.quote_id = q.id)`,
    )
    .all(ctx.workspaceId, day) as QuoteRowLite[];
  for (const quote of quotes) {
    if (quote.currency !== base) {
      // The A10 document row stores no CHF base total (§H-FX): degrade honestly, never convert here.
      excluded.push({ quoteId: quote.id, reason: 'needs_fx_rate' });
      continue;
    }
    const bucket = bucketFor(quote.valid_until);
    if (bucket === undefined) continue;
    bucket.openQuotesMinor += quote.total_minor;
  }

  const rows = periodKeys.map((key) => {
    const p = periods.get(key) as RevenuePeriod;
    p.totalMinor = p.weightedOpenMinor + p.wonUninvoicedMinor + p.openQuotesMinor;
    return p;
  });
  return ok({
    horizonMonths: input.horizonMonths,
    rows,
    totalWeightedOpenMinor: rows.reduce((sum, r) => sum + r.weightedOpenMinor, 0),
    totalWonUninvoicedMinor: rows.reduce((sum, r) => sum + r.wonUninvoicedMinor, 0),
    totalOpenQuotesMinor: rows.reduce((sum, r) => sum + r.openQuotesMinor, 0),
    totalMinor: rows.reduce((sum, r) => sum + r.totalMinor, 0),
    excluded,
    baseCurrency: base,
  });
}

// --- vsActual -----------------------------------------------------------------------------------

export interface VsActualInput {
  period: string;
}

const LAST_DAY_OF_MONTH = (year: number, month: number): string => {
  // Day 0 of the NEXT month is the last day of this one; UTC-safe because only Y/M/D are read.
  const d = new Date(Date.UTC(year, month, 0));
  return d.toISOString().slice(0, 10);
};

/** Parse a period token: 'YYYY' | 'YYYY-MM' | 'YYYY-Qn' → [start, end], or undefined. */
export function parsePeriod(period: string): { start: string; end: string } | undefined {
  if (/^\d{4}$/.test(period)) {
    const year = Number.parseInt(period, 10);
    if (year < 1900 || year > 2999) return undefined;
    return { start: `${period}-01-01`, end: `${period}-12-31` };
  }
  const monthMatch = /^(\d{4})-(\d{2})$/.exec(period);
  if (monthMatch !== null) {
    const year = Number.parseInt(monthMatch[1] as string, 10);
    const month = Number.parseInt(monthMatch[2] as string, 10);
    if (year < 1900 || year > 2999 || month < 1 || month > 12) return undefined;
    return { start: `${period}-01`, end: LAST_DAY_OF_MONTH(year, month) };
  }
  const quarterMatch = /^(\d{4})-Q([1-4])$/.exec(period);
  if (quarterMatch !== null) {
    const year = Number.parseInt(quarterMatch[1] as string, 10);
    const q = Number.parseInt(quarterMatch[2] as string, 10);
    if (year < 1900 || year > 2999) return undefined;
    const startMonth = (q - 1) * 3 + 1;
    return {
      start: `${year}-${String(startMonth).padStart(2, '0')}-01`,
      end: LAST_DAY_OF_MONTH(year, startMonth + 2),
    };
  }
  return undefined;
}

interface InvoiceRowLite {
  id: string;
  subtotal_minor: number;
  source_document_id: string | null;
}

/** True when an invoice's `source_document_id` chain reaches a quote a deal owns (either link side). */
function invoiceDealLinked(ctx: WorkspaceContext, invoice: InvoiceRowLite): boolean {
  let sourceId = invoice.source_document_id;
  for (let hops = 0; sourceId !== null && hops < 5; hops += 1) {
    const doc = ctx.store.db
      .prepare('SELECT id, type, deal_id, source_document_id FROM document WHERE workspace_id = ? AND id = ?')
      .get(ctx.workspaceId, sourceId) as
      | { id: string; type: string; deal_id: string | null; source_document_id: string | null }
      | undefined;
    if (doc === undefined) return false;
    if (doc.type === 'quote') {
      if (doc.deal_id !== null) return true;
      const owner = ctx.store.db
        .prepare('SELECT COUNT(*) AS n FROM deal WHERE workspace_id = ? AND quote_id = ?')
        .get(ctx.workspaceId, doc.id) as { n: number };
      return owner.n > 0;
    }
    sourceId = doc.source_document_id;
  }
  return false;
}

/**
 * US-C03.4: forecast vs actual for a closed period. `actual` is the A08 income statement's
 * `netto_erloese` subtotal (posted revenue net of VAT, §H-VAT-TRACE); the pipeline view is won-deal
 * base value with the OP5 close date in the period; the two gap buckets name where they diverge.
 * Stores NOTHING (P5): "what did the forecast say last March" belongs to F01's scheduled exports.
 */
export function vsActual(ctx: WorkspaceContext, input: VsActualInput): Result {
  if (typeof input.period !== 'string') return err('invalid_period', { period: input.period });
  const window = parsePeriod(input.period);
  if (window === undefined) {
    return err('invalid_period', { period: input.period, allowed: 'YYYY | YYYY-MM | YYYY-Qn' });
  }

  const statement = computeIncomeStatement(ctx, { periodStart: window.start, periodEnd: window.end });
  if (!statement.ok) return statement;
  const sections = (statement as unknown as { sections: { key: string; subtotalMinor: number }[] }).sections;
  const actualRevenueMinor = sections.find((s) => s.key === 'netto_erloese')?.subtotalMinor ?? 0;

  const wonDeals = ctx.store.db
    .prepare(`SELECT * FROM deal WHERE workspace_id = ? AND status = 'won'`)
    .all(ctx.workspaceId) as DealRow[];
  let wonInPeriodMinor = 0;
  let wonNotInvoicedMinor = 0;
  let wonInPeriodCount = 0;
  for (const deal of wonDeals) {
    const closedDay = closedAtOf(ctx, deal.id, 'won', deal.updated_at).slice(0, 10);
    if (closedDay < window.start || closedDay > window.end) continue;
    wonInPeriodCount += 1;
    wonInPeriodMinor += deal.value_base_minor;
    if (!dealInvoiced(ctx, deal)) wonNotInvoicedMinor += deal.value_base_minor;
  }

  // POSTED invoices issued in the period whose source chain reaches no deal: the revenue that never
  // went through the pipeline, at `subtotal_minor` (net, matching the actual side).
  const invoices = ctx.store.db
    .prepare(
      `SELECT id, subtotal_minor, source_document_id FROM document
        WHERE workspace_id = ? AND type = 'invoice' AND posted_entry_id IS NOT NULL
          AND issue_date >= ? AND issue_date <= ?`,
    )
    .all(ctx.workspaceId, window.start, window.end) as InvoiceRowLite[];
  let invoicedWithoutDealMinor = 0;
  let invoicedWithoutDealCount = 0;
  for (const invoice of invoices) {
    if (invoiceDealLinked(ctx, invoice)) continue;
    invoicedWithoutDealCount += 1;
    invoicedWithoutDealMinor += invoice.subtotal_minor;
  }

  return ok({
    period: input.period,
    periodStart: window.start,
    periodEnd: window.end,
    actualRevenueMinor,
    wonInPeriodMinor,
    deltaMinor: actualRevenueMinor - wonInPeriodMinor,
    wonNotInvoicedMinor,
    invoicedWithoutDealMinor,
    sample: wonInPeriodCount + invoicedWithoutDealCount,
    baseCurrency: baseCurrency(ctx),
  });
}
