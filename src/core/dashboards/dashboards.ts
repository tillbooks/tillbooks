/**
 * F00, Dashboards & KPIs: a PURE READ MODEL (Pattern P5) composing the read verbs the product
 * already computes. It owns NO tables, posts NOTHING, and issues no INSERT/UPDATE/DELETE anywhere:
 * every tile is the composing source verb's answer for the same filter, recomputed on every call,
 * so a tile and its source screen can never disagree (`test/dashboards/read-only.test.mjs` asserts
 * the means statically; `test/dashboards/dashboards.test.mjs` asserts the effect by row census and
 * the anti-drift equality tile == source).
 *
 * WHERE EVERY FIGURE COMES FROM (spec §4, the anti-drift contract):
 *
 *  - **revenue**: A08 `computeIncomeStatement`, the `netto_erloese` section's subtotal, with the
 *    trend from the statement's own `compareTo` over the previous equal-length window.
 *  - **cash**: the A19 bank accounts' ledger accounts, each valued by A08's Kontoblatt
 *    (`computeGeneralLedger`) closing balance at the range end, summed.
 *  - **ar_aging**: A16 `agingReport` (`baseTotalOpenMinor`, `baseByBucket`).
 *  - **ap_aging**: A17 `listVendorBills` (`baseTotalOpenMinor`, `bucketTotals`; A17 reads as of
 *    the injected clock's today, its own contract, and the tile carries that `asOf` through).
 *  - **utilisation**: B01 `timeList` sums for the range, billable share in basis points. B01 has
 *    no capacity model, so this is billable ÷ total logged, stated as such, never a fake capacity.
 *  - **project_margin**: B03 `costingPlList` at the range end, summed across projects; B03's own
 *    per-row fx degradation is carried through, never silently mixed.
 *  - **mwst_due**: A07 `listVatPeriods` to find the settlement period containing the range end,
 *    then `computeVatReturn` for exactly that period; `payableMinor` verbatim (MWSTG authority is
 *    A07, F00 recomputes nothing).
 *  - **stock_value**: D01 `valuationReport` at the range end, following the last posted run's
 *    method (the books' method) and defaulting to `weighted_avg`.
 *  - **bank_inbox** (D142, the Übersicht's Bankeingang band): A39 `bankInboxAttention`, the SAME
 *    per-line definitions `list_bank_inbox` carries (`attention`, `needsReceipt`) counted over every
 *    open line, per Bankkonto; the fetch line from A36 `getBankChannelStatus` (the last fetch, a
 *    fetch running now, the daily automatic fetch). Current, not ranged: a work queue has no window.
 *
 * §H-TENANT: every fanned-out source verb already filters on `workspace_id`, and the optional G00
 * saved-view lookup resolves through `listSavedViews`, which is itself workspace- and actor-fenced.
 * F00 adds no query of its own beyond three one-row probes (base currency, a project exists, a
 * `track_stock` item exists), each `workspace_id = ?`-scoped.
 *
 * RBAC (US-F00.6) is enforced HERE, per tile, via `ctx.capabilities`: a tile whose registry
 * capability set the caller lacks is OMITTED server-side (`omitted:[{tile, error:
 * 'permission_denied'}]`), never filtered client-side. The verbs are therefore
 * `ungated('asserted_in_engine', ...)` at the registry boundary: the rule is per tile, not per verb.
 *
 * P9, clean degradation: an EMPTY workspace answers `ok:true` with zero-state tiles; an
 * unconfigured or unavailable module degrades its ONE tile to `{tile, ok:false, error}` with the
 * source's own code (`needs_vat_config`, `needs_chart`, `needs_projects`, `needs_stock_items`);
 * the grid never all-or-nothing fails on one source.
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { computeGeneralLedger } from '../reports/index.js';
import { agingReport } from '../debtors/index.js';
import { listVendorBills } from '../purchase/index.js';
import { computeVatReturn, listVatPeriods } from '../vat/index.js';
import { timeList } from '../time/index.js';
import { costingPlList } from '../costing/index.js';
import { valuationReport } from '../stock/index.js';
import { listBankAccounts, bankInboxAttention } from '../banking/index.js';
import { seesVorschlaege, waitingOf } from '../banking/attentionProviders.js';
import { getBankChannelStatus, readStatementGaps } from '../banking/ebics/index.js';
import { listSavedViews } from '../customization/index.js';
import { DASHBOARD_TILES, TILE_REGISTRY, tileDef } from './tiles.js';
import type { DashboardTileDef } from './tiles.js';
import { RUNWAY_MONTHS, booksFreeCash, autoRateFigure, bankFigures, comparisonsOf, dsoFigure, estimateOf, lastWholeMonths, ltmWindow, newKpiEnv, receiptRateFigure, statementFigures, topCustomerFigure } from './kpis.js';
import { liquidityForecast } from '../liquidity/index.js';
import type { KpiEnv, StatementFigures } from './kpis.js';
import { COMPARE_CUTS } from './compare.js';
import type { CompareCut } from './compare.js';
import { REVENUE_ESTIMATE_BASES, revenueEstimate } from '../banking/revenueEstimate.js';
import type { RevenueEstimateBasis } from '../banking/revenueEstimate.js';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** D186: the person's choices a few tiles compute with (`overview.runway_months`, `overview.estimate_basis`). */
export interface DashboardKpiOptions {
  runwayMonths?: number | undefined;
  estimateBasis?: string | undefined;
  compareCut?: string | undefined;
}

export interface DashboardOverviewInput extends DashboardKpiOptions {
  from: string;
  to: string;
  savedViewId?: string | undefined;
}

export interface DashboardTileInput extends DashboardKpiOptions {
  tile: string;
  from: string;
  to: string;
}

/** One rendered tile: success, zero state, or the honest per-tile degradation (P9). */
type Tile = Record<string, unknown>;

// ------------------------------------------------------------------------------------------------
// Small shared helpers
// ------------------------------------------------------------------------------------------------

function baseCurrencyOf(ctx: WorkspaceContext): string {
  const row = ctx.store.db
    .prepare('SELECT base_currency FROM workspace WHERE id = ?')
    .get(ctx.workspaceId) as { base_currency: string } | undefined;
  return row?.base_currency ?? 'CHF';
}

/** Validate the shared range: two real ISO dates, in order. `invalid_range` is the spec's code. */
function rangeProblem(from: unknown, to: unknown): Result | undefined {
  if (typeof from !== 'string' || !ISO_DATE.test(from)) return err('invalid_input', { field: 'from' });
  if (typeof to !== 'string' || !ISO_DATE.test(to)) return err('invalid_input', { field: 'to' });
  if (from > to) return err('invalid_range', { from, to });
  return undefined;
}

/** `date` shifted by `days` whole days, in UTC, as an ISO day. */
function addDays(date: string, days: number): string {
  const ms = Date.parse(`${date}T00:00:00.000Z`) + days * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

/** D186: the options validated, or the refusal naming the field. */
function kpiOptions(input: DashboardKpiOptions): Result | { runwayMonths: number; estimateBasis: RevenueEstimateBasis; compareCut: CompareCut } {
  const runwayMonths = input.runwayMonths ?? 6;
  if (!(RUNWAY_MONTHS as readonly number[]).includes(runwayMonths)) return err('invalid_input', { field: 'runwayMonths', allowed: [...RUNWAY_MONTHS] });
  const basis = input.estimateBasis ?? 'rules';
  if (!(REVENUE_ESTIMATE_BASES as readonly string[]).includes(basis)) return err('invalid_input', { field: 'estimateBasis', allowed: [...REVENUE_ESTIMATE_BASES] });
  const cut = input.compareCut ?? 'same_day';
  if (!(COMPARE_CUTS as readonly string[]).includes(cut)) return err('invalid_input', { field: 'compareCut', allowed: [...COMPARE_CUTS] });
  return { runwayMonths, estimateBasis: basis as RevenueEstimateBasis, compareCut: cut as CompareCut };
}

/** A numeric field off an open source payload, or 0: a source never sends a non-number here. */
function num(payload: Record<string, unknown>, key: string): number {
  const v = payload[key];
  return typeof v === 'number' ? v : 0;
}

/** The honest per-tile degradation (P9): the SOURCE's own code, never a fabricated zero. */
function degraded(def: DashboardTileDef, error: string): Tile {
  return { tile: def.tile, ok: false, error, glyph: def.glyph };
}

function drillOf(ctx: WorkspaceContext, def: DashboardTileDef, params: Record<string, unknown>): Record<string, unknown> {
  return { studioRoute: def.studioRoute, mcpTool: def.mcpTool, params: { workspaceId: ctx.workspaceId, ...params } };
}

// ------------------------------------------------------------------------------------------------
// The eight tile computations (spec §4: each one names its source and adds nothing to it)
// ------------------------------------------------------------------------------------------------

function revenueTile(ctx: WorkspaceContext, def: DashboardTileDef, from: string, to: string, env: KpiEnv): Tile {
  const range = { from, to };
  const current = statementFigures(ctx, env, range);
  if ('error' in current) return degraded(def, current.error);
  const valueRappen = current.revenueMinor;
  // D186: like for like, both modes (compare.ts). `trendBp` stays the previous period's change, for readers
  // that predate the comparisons.
  const compared = comparisonsOf(range, env, valueRappen, (w) => figureOr(statementFigures(ctx, env, w), 'revenueMinor'));
  const prev = compared.comparisons.previous_period;
  return {
    tile: def.tile,
    ok: true,
    valueRappen,
    currency: baseCurrencyOf(ctx),
    range,
    trendBp: prev?.changeBp ?? null,
    ...compared,
    // D186 point 2: what the open bank lines of the range would add, when the caller may read bank lines.
    ...(ctx.capabilities.assert('read_sales').ok ? { estimate: estimateOf(ctx, env, range) } : {}),
    glyph: def.glyph,
    drill: drillOf(ctx, def, { periodStart: from, periodEnd: to }),
    detail: {
      reingewinnMinor: current.resultMinor,
      previousRevenueMinor: prev?.value ?? 0,
      previousRange: prev === null ? null : { from: prev.from, to: prev.to },
    },
  };
}

/** A statement figure, or null when A08 refused the window. */
function figureOr(f: StatementFigures | { error: string }, key: keyof StatementFigures): number | null {
  return 'error' in f ? null : f[key];
}

/** D186: a figure of the Erfolgsrechnung with both comparisons (expense, result). */
function statementTile(key: 'expenseMinor' | 'resultMinor') {
  return (ctx: WorkspaceContext, def: DashboardTileDef, from: string, to: string, env: KpiEnv): Tile => {
    const range = { from, to };
    const current = statementFigures(ctx, env, range);
    if ('error' in current) return degraded(def, current.error);
    const valueRappen = current[key];
    return {
      tile: def.tile,
      ok: true,
      valueRappen,
      currency: baseCurrencyOf(ctx),
      range,
      ...comparisonsOf(range, env, valueRappen, (w) => figureOr(statementFigures(ctx, env, w), key)),
      glyph: def.glyph,
      drill: drillOf(ctx, def, { periodStart: from, periodEnd: to }),
      detail: { revenueMinor: current.revenueMinor, expenseMinor: current.expenseMinor, resultMinor: current.resultMinor },
    };
  };
}

/** Reingewinn over Nettoerlöse in basis points, once (P2); null without revenue. */
function marginBpOf(f: StatementFigures): number | null {
  return f.revenueMinor === 0 ? null : Math.round((f.resultMinor * 10000) / f.revenueMinor);
}

function marginTile(ctx: WorkspaceContext, def: DashboardTileDef, from: string, to: string, env: KpiEnv): Tile {
  const range = { from, to };
  const current = statementFigures(ctx, env, range);
  if ('error' in current) return degraded(def, current.error);
  const valueBp = marginBpOf(current);
  // A margin's change is said in percentage POINTS (basis points apart), never a percent of a percent.
  const compared = comparisonsOf(range, env, valueBp ?? 0, (w) => {
    const f = statementFigures(ctx, env, w);
    return 'error' in f ? null : marginBpOf(f);
  });
  for (const c of Object.values(compared.comparisons)) if (c !== null) c.changeBp = valueBp === null || !compared.comparedKnown ? null : compared.comparedValue - c.value;
  return {
    tile: def.tile,
    ok: true,
    valueBp,
    currency: baseCurrencyOf(ctx),
    range,
    ...compared,
    changeUnit: 'points',
    glyph: def.glyph,
    drill: drillOf(ctx, def, { periodStart: from, periodEnd: to }),
    detail: { revenueMinor: current.revenueMinor, resultMinor: current.resultMinor },
  };
}

function revenueLtmTile(ctx: WorkspaceContext, def: DashboardTileDef, _from: string, to: string, env: KpiEnv): Tile {
  const through = to > env.today ? env.today : to;
  const range = ltmWindow(through);
  const current = statementFigures(ctx, env, range);
  if ('error' in current) return degraded(def, current.error);
  const year = ltmWindow(`${Number(through.slice(0, 4)) - 1}${through.slice(4)}`.replace(/-02-29$/, '-02-28'));
  const before = statementFigures(ctx, env, year);
  const base = 'error' in before ? null : before.revenueMinor;
  const changeBp = base === null || base === 0 ? null : Math.round(((current.revenueMinor - base) * 10000) / Math.abs(base));
  const comparison = base === null ? null : { from: year.from, to: year.to, value: base, changeBp };
  return {
    tile: def.tile,
    ok: true,
    valueRappen: current.revenueMinor,
    currency: baseCurrencyOf(ctx),
    range,
    // Twelve months against the twelve before: the same comparison for both modes.
    comparedThrough: through,
    comparisons: { previous_period: comparison, previous_year: comparison },
    glyph: def.glyph,
    drill: drillOf(ctx, def, { periodStart: range.from, periodEnd: range.to }),
  };
}

/** D186 point 1: the money on the bank, per Bankkonto. Current, not ranged (like the Bankeingang). */
function bankBalanceTile(ctx: WorkspaceContext, def: DashboardTileDef, _from: string, _to: string, env: KpiEnv): Tile {
  const base = baseCurrencyOf(ctx);
  const b = bankFigures(ctx, env, base);
  return {
    tile: def.tile,
    ok: true,
    valueRappen: b.totalMinor,
    currency: base,
    asOf: b.asOf ?? env.today,
    complete: b.bankShareComplete,
    accounts: b.accounts,
    glyph: def.glyph,
    drill: drillOf(ctx, def, { status: 'open' }),
  };
}

/**
 * D186 (re-cut after three critic FAILs, the owner's pick): free cash from the BOOKS alone, the bank ledger
 * accounts less 2000 Kreditoren less the MWST owed (`booksFreeCash`). The bank tile beside it is the
 * statement's truth; an open line explains the gap there, never here.
 */
function freeCashTile(ctx: WorkspaceContext, def: DashboardTileDef, from: string, to: string, env: KpiEnv): Tile {
  const f = booksFreeCash(ctx, env.today);
  return {
    tile: def.tile,
    ok: true,
    valueRappen: f.valueMinor,
    currency: baseCurrencyOf(ctx),
    asOf: env.today,
    basis: 'books',
    glyph: def.glyph,
    drill: drillOf(ctx, def, { tile: 'free_cash', from, to }),
    detail: { bankMinor: f.bankMinor, bankAccounts: f.bankAccounts, payablesMinor: f.payablesMinor, vatDueMinor: f.vatDueMinor },
  };
}

/** D186: how many months the bank figure covers the average monthly expense of the last N whole months. */
function runwayTile(ctx: WorkspaceContext, def: DashboardTileDef, _from: string, _to: string, env: KpiEnv): Tile {
  const base = baseCurrencyOf(ctx);
  const b = bankFigures(ctx, env, base);
  const window = lastWholeMonths(env.today, env.runwayMonths);
  const f = statementFigures(ctx, env, window);
  if ('error' in f) return degraded(def, f.error);
  const monthlyExpenseMinor = Math.round(f.expenseMinor / env.runwayMonths);
  // Tenths of a month, one rounding (P2). Null when nothing is spent: an endless runway is not a figure.
  const valueTenths = monthlyExpenseMinor <= 0 ? null : Math.round((b.totalMinor * 10) / monthlyExpenseMinor);
  return {
    tile: def.tile,
    ok: true,
    valueQuantity: valueTenths === null ? null : { value: valueTenths, decimals: 1, unit: 'months' },
    currency: base,
    asOf: env.today,
    glyph: def.glyph,
    drill: drillOf(ctx, def, { periodStart: window.from, periodEnd: window.to }),
    detail: { bankMinor: b.totalMinor, monthlyExpenseMinor, months: env.runwayMonths, window },
  };
}

function cashTile(ctx: WorkspaceContext, def: DashboardTileDef, from: string, to: string): Tile {
  const accounts = listBankAccounts(ctx, {});
  if (!accounts.ok) return degraded(def, accounts.error);
  const rows = accounts.bankAccounts as { id: string; name: string; ledgerAccountId: string; currency: string }[];
  let valueRappen = 0;
  const perAccount: Record<string, unknown>[] = [];
  for (const row of rows) {
    const konto = computeGeneralLedger(ctx, { accountId: row.ledgerAccountId, periodStart: from, periodEnd: to });
    if (!konto.ok) return degraded(def, konto.error);
    const closingMinor = num(konto, 'closingMinor');
    valueRappen += closingMinor;
    perAccount.push({ bankAccountId: row.id, name: row.name, currency: row.currency, closingMinor });
  }
  return {
    tile: def.tile,
    ok: true,
    valueRappen,
    currency: baseCurrencyOf(ctx),
    asOf: to,
    glyph: def.glyph,
    drill: drillOf(ctx, def, {}),
    detail: { accounts: perAccount },
  };
}

function arAgingTile(ctx: WorkspaceContext, def: DashboardTileDef, _from: string, to: string): Tile {
  const report = agingReport(ctx, { asOf: to });
  if (!report.ok) return degraded(def, report.error);
  return {
    tile: def.tile,
    ok: true,
    valueRappen: num(report, 'baseTotalOpenMinor'),
    currency: baseCurrencyOf(ctx),
    asOf: to,
    glyph: def.glyph,
    drill: drillOf(ctx, def, { asOf: to }),
    detail: {
      baseByBucket: report.baseByBucket,
      boundariesDays: report.boundariesDays,
      reconciled: report.reconciled,
      receivablesBalanceMinor: num(report, 'receivablesBalanceMinor'),
    },
  };
}

function apAgingTile(ctx: WorkspaceContext, def: DashboardTileDef, _from: string, _to: string): Tile {
  // A17's list reads as of the injected clock's today (its own contract); the tile carries that
  // `asOf` through rather than pretending the source accepted a Stichtag it does not take.
  const list = listVendorBills(ctx, {});
  if (!list.ok) return degraded(def, list.error);
  return {
    tile: def.tile,
    ok: true,
    valueRappen: num(list, 'baseTotalOpenMinor'),
    currency: baseCurrencyOf(ctx),
    asOf: list.asOf,
    glyph: def.glyph,
    drill: drillOf(ctx, def, {}),
    detail: { bucketTotals: list.bucketTotals, boundariesDays: list.boundariesDays },
  };
}

function utilisationTile(ctx: WorkspaceContext, def: DashboardTileDef, from: string, to: string): Tile {
  // B01's `to` bound is EXCLUSIVE over instants, so the day after the range end includes the whole
  // `to` day. Both calls are the SAME source verb with the same window; the tile only divides.
  const toExclusive = addDays(to, 1);
  const all = timeList(ctx, { from, to: toExclusive });
  if (!all.ok) return degraded(def, all.error);
  const billable = timeList(ctx, { from, to: toExclusive, billable: true });
  if (!billable.ok) return degraded(def, billable.error);
  const totalMinutes = num(all, 'totalMinutes');
  const billableMinutes = num(billable, 'totalMinutes');
  // ONE division, ONE rounding point (P2). Null when nothing was logged: 0 % would claim a
  // measured idle range, and no minutes is not a measurement of idleness.
  const valueBp = totalMinutes === 0 ? null : Math.round((billableMinutes * 10000) / totalMinutes);
  return {
    tile: def.tile,
    ok: true,
    valueBp,
    currency: baseCurrencyOf(ctx),
    range: { from, to },
    glyph: def.glyph,
    drill: drillOf(ctx, def, { from, to: toExclusive }),
    detail: { totalMinutes, billableMinutes, billableMinor: num(billable, 'billableMinor') },
  };
}

function projectMarginTile(ctx: WorkspaceContext, def: DashboardTileDef, _from: string, to: string): Tile {
  // The availability probe (P9): no project row means the module is unused, and the honest answer
  // is "not applicable", never a fabricated zero-margin business.
  const anyProject = ctx.store.db
    .prepare('SELECT 1 AS present FROM project WHERE workspace_id = ? LIMIT 1')
    .get(ctx.workspaceId) as { present: number } | undefined;
  if (anyProject === undefined) return degraded(def, 'needs_projects');

  const list = costingPlList(ctx, { asOf: to });
  if (!list.ok) return degraded(def, list.error);
  const rows = list.projects as Record<string, unknown>[];
  let revenueMinor = 0;
  let costMinor = 0;
  let marginMinor = 0;
  let fxDegradedCount = 0;
  const measured: { projectId: unknown; code: unknown; name: unknown; marginMinor: number }[] = [];
  for (const row of rows) {
    if (row.fxBaseMissing === true) {
      // B03's own per-row honesty flag, carried through, never silently mixed (§H-FX).
      fxDegradedCount += 1;
      continue;
    }
    revenueMinor += num(row, 'revenueMinor');
    costMinor += num(row, 'costMinor');
    marginMinor += num(row, 'marginMinor');
    measured.push({ projectId: row.projectId, code: row.code, name: row.name, marginMinor: num(row, 'marginMinor') });
  }
  // B03's own `marginBp` formula, applied ONCE to the aggregate (P2): null when there is no
  // revenue, never 0-as-break-even.
  const marginBp = revenueMinor === 0 ? null : Math.round((marginMinor * 10000) / revenueMinor);
  return {
    tile: def.tile,
    ok: true,
    valueRappen: marginMinor,
    currency: baseCurrencyOf(ctx),
    asOf: to,
    glyph: def.glyph,
    drill: drillOf(ctx, def, { asOf: to }),
    detail: {
      revenueMinor,
      costMinor,
      marginBp,
      projectCount: measured.length,
      fxDegradedCount,
      top: measured[0] ?? null,
      bottom: measured.length > 1 ? measured[measured.length - 1] : null,
    },
  };
}

function mwstDueTile(ctx: WorkspaceContext, def: DashboardTileDef, _from: string, to: string): Tile {
  const periods = listVatPeriods(ctx, { year: to.slice(0, 4) });
  if (!periods.ok) return degraded(def, periods.error);
  const rows = periods.periods as { label: string; periodStart: string; periodEnd: string; filed: boolean }[];
  const current = rows.find((p) => p.periodStart <= to && to <= p.periodEnd);
  if (current === undefined) return degraded(def, 'needs_vat_config');
  const vatReturn = computeVatReturn(ctx, { periodStart: current.periodStart, periodEnd: current.periodEnd });
  // A07's refusals (Ist timing, a method change inside the period) degrade the tile with A07's own
  // code: a signable figure A07 refuses to compute is not a figure F00 may invent.
  if (!vatReturn.ok) return degraded(def, vatReturn.error);
  return {
    tile: def.tile,
    ok: true,
    valueRappen: num(vatReturn, 'payableMinor'),
    currency: baseCurrencyOf(ctx),
    asOf: current.periodEnd,
    glyph: def.glyph,
    drill: drillOf(ctx, def, { periodStart: current.periodStart, periodEnd: current.periodEnd }),
    detail: {
      creditMinor: num(vatReturn, 'creditMinor'),
      period: current.label,
      periodStart: current.periodStart,
      periodEnd: current.periodEnd,
      filed: current.filed,
      method: vatReturn.method,
    },
  };
}

function stockValueTile(ctx: WorkspaceContext, def: DashboardTileDef, _from: string, to: string): Tile {
  // The availability probe (P9): no `track_stock` item means inventory is unused.
  const anyTracked = ctx.store.db
    .prepare('SELECT 1 AS present FROM item WHERE workspace_id = ? AND track_stock = 1 LIMIT 1')
    .get(ctx.workspaceId) as { present: number } | undefined;
  if (anyTracked === undefined) return degraded(def, 'needs_stock_items');

  // Follow the books' method: the report itself says when the last posted run used another method
  // (`methodChanged` / `priorMethod`), and the tile re-asks D01 under that one rather than showing
  // a figure the ledger was never valued at. `weighted_avg` is only the first ask, not a policy.
  let report = valuationReport(ctx, { method: 'weighted_avg', asOf: to });
  if (report.ok && report.methodChanged === true && typeof report.priorMethod === 'string') {
    const rerun = valuationReport(ctx, { method: report.priorMethod, asOf: to });
    if (rerun.ok) report = rerun;
  }
  if (!report.ok) return degraded(def, report.error);
  return {
    tile: def.tile,
    ok: true,
    valueRappen: num(report, 'totalValueMinor'),
    currency: baseCurrencyOf(ctx),
    asOf: to,
    glyph: def.glyph,
    drill: drillOf(ctx, def, { method: report.method, asOf: to }),
    detail: {
      method: report.method,
      postedValueMinor: num(report, 'postedValueMinor'),
      unpostedDeltaMinor: num(report, 'unpostedDeltaMinor'),
    },
  };
}

/** D186: the lowest projected bank balance of the next 30 days, A40's forecast verbatim (`lowest`). */
function lowPointTile(ctx: WorkspaceContext, def: DashboardTileDef, _from: string, _to: string, env: KpiEnv): Tile {
  const forecast = liquidityForecast(ctx, { horizonDays: 30 });
  if (!forecast.ok) return degraded(def, forecast.error);
  const lowest = forecast.lowest as { date: string; balanceMinor: number };
  const assumptions = (forecast.assumptions ?? {}) as Record<string, unknown>;
  return {
    tile: def.tile,
    ok: true,
    valueRappen: lowest.balanceMinor,
    currency: typeof forecast.currency === 'string' ? forecast.currency : baseCurrencyOf(ctx),
    asOf: env.today,
    glyph: def.glyph,
    drill: drillOf(ctx, def, { horizonDays: 30 }),
    detail: {
      lowestDate: lowest.date,
      horizonEnd: forecast.horizonEnd,
      openingBalanceMinor: num(forecast, 'openingBalanceMinor'),
      // A40 starts from the books (`openingSource: 'ledger'`), not the statement: said, never hidden.
      openingSource: assumptions.openingSource ?? null,
    },
  };
}

/** Comparisons of a basis-point ratio, said in percentage points (the difference, never a percent of it). */
function inPoints(compared: ReturnType<typeof comparisonsOf>, value: number | null): ReturnType<typeof comparisonsOf> {
  for (const c of Object.values(compared.comparisons)) if (c !== null) c.changeBp = value === null || !compared.comparedKnown ? null : compared.comparedValue - c.value;
  return compared;
}

/** D186: a window-free ratio of the last twelve months up to the range end, compared with the twelve before. */
function twelveMonths(env: KpiEnv, to: string): { range: { from: string; to: string }; before: { from: string; to: string }; through: string } {
  const through = to > env.today ? env.today : to;
  const year = `${Number(through.slice(0, 4)) - 1}${through.slice(4)}`.replace(/-02-29$/, '-02-28');
  return { range: ltmWindow(through), before: ltmWindow(year), through };
}

function dsoTile(ctx: WorkspaceContext, def: DashboardTileDef, _from: string, to: string, env: KpiEnv): Tile {
  const t = twelveMonths(env, to);
  const now = dsoFigure(ctx, t.range);
  const before = dsoFigure(ctx, t.before);
  const comparison =
    before.days === null ? null : { from: t.before.from, to: t.before.to, value: before.days, changeBp: now.days === null || before.days === 0 ? null : Math.round(((now.days - before.days) * 10000) / before.days) };
  return {
    tile: def.tile,
    ok: true,
    valueQuantity: now.days === null ? null : { value: now.days, decimals: 0, unit: 'days' },
    currency: baseCurrencyOf(ctx),
    range: t.range,
    comparedThrough: t.through,
    comparisons: { previous_period: comparison, previous_year: comparison },
    // A shorter payment duration is better: the Studio reads the direction from here, never guesses it.
    lowerIsBetter: true,
    glyph: def.glyph,
    drill: drillOf(ctx, def, { asOf: t.through }),
    detail: { invoices: now.invoices },
  };
}

function topCustomerTile(ctx: WorkspaceContext, def: DashboardTileDef, _from: string, to: string, env: KpiEnv): Tile {
  const t = twelveMonths(env, to);
  const base = baseCurrencyOf(ctx);
  const f = topCustomerFigure(ctx, t.range, base);
  return {
    tile: def.tile,
    ok: true,
    valueBp: f.shareBp,
    currency: base,
    range: t.range,
    glyph: def.glyph,
    drill: drillOf(ctx, def, f.contactId === null ? {} : { contactId: f.contactId }),
    detail: { contactId: f.contactId, name: f.name, netMinor: f.netMinor, totalMinor: f.totalMinor, customers: f.customers, foreignDocuments: f.foreignDocuments },
  };
}

/** D186: a share of the window's bank lines (auto_rate, receipt_rate), compared in points. */
function lineShareTile(figure: (ctx: WorkspaceContext, w: { from: string; to: string }) => { shareBp: number | null } & Record<string, number | null>) {
  return (ctx: WorkspaceContext, def: DashboardTileDef, from: string, to: string, env: KpiEnv): Tile => {
    const range = { from, to };
    const f = figure(ctx, range);
    const compared = inPoints(
      comparisonsOf(range, env, f.shareBp ?? 0, (w) => figure(ctx, w).shareBp),
      f.shareBp,
    );
    const { shareBp, ...counts } = f;
    return {
      tile: def.tile,
      ok: true,
      valueBp: shareBp,
      currency: baseCurrencyOf(ctx),
      range,
      ...compared,
      changeUnit: 'points',
      glyph: def.glyph,
      drill: drillOf(ctx, def, { from, to }),
      detail: counts,
    };
  };
}

/** One EBICS channel as the band reads it off `bank_channel_status` (the fields it words). */
interface FeedChannel {
  connectionId: string;
  channelKind?: string;
  state: string;
  lastSyncAt: string | null;
  syncInProgress?: boolean;
  syncStartedAt?: string | null;
  keystore?: { state?: string; persistent?: boolean };
  accounts?: { bankAccountId: string; lastNumberJump?: unknown; statementGaps?: unknown[] }[];
  pendingStatements?: unknown[];
  autoSync?: {
    mode: string;
    atTime: string;
    nextAt: string | null;
    lastAuto: { finishedAt: string; ok: boolean; code: string; retryable: boolean; attempt: number; detail: unknown } | null;
    /** D142 critic R3-2: false when nobody set the schedule, so only the owner seat is tried. */
    setterKnown?: boolean;
    /** D143 critic LB-1: who set the schedule (none, owner, agent, person); it words `auto_sync_no_actor`. */
    scheduleSetter?: 'none' | 'owner' | 'agent' | 'person';
  };
  /** D143: the bank's short name for the band's mark, and the daily activation check. */
  bankName?: string;
  activation?: { checking: boolean; lastCheckAt: string | null; lastAttemptAt?: string | null; nextCheckAt: string | null; bankReady: boolean; lastOutcome: string | null };
}

/**
 * D142: the Bankeingang band. The figures are the inbox's own (`bankInboxAttention`), the fetch line the
 * channel status's own; nothing is recounted here. Zero accounts is the zero state, never an error.
 */
function bankInboxTile(ctx: WorkspaceContext, def: DashboardTileDef, _from: string, _to: string): Tile {
  const listed = listBankAccounts(ctx, {});
  if (!listed.ok) return degraded(def, listed.error);
  const rows = listed.bankAccounts as { id: string; name: string; currency: string }[];
  const counts = bankInboxAttention(ctx);
  const accounts = rows.map((row) => {
    const c = counts.byAccount.get(row.id);
    return {
      bankAccountId: row.id,
      name: row.name,
      currency: row.currency,
      open: c?.open ?? 0,
      needs: c?.needs ?? 0,
      sure: c?.sure ?? 0,
      noReceipt: c?.noReceipt ?? 0,
      inMinor: c?.inMinor ?? 0,
      outMinor: c?.outMinor ?? 0,
    };
  });
  const status = getBankChannelStatus(ctx, {});
  const channels = (status.ok ? (status.channels as FeedChannel[]) : []).filter(
    (c) => (c.channelKind ?? 'ebics') === 'ebics' && c.state !== 'retired',
  );
  const lastSyncAt = channels.map((c) => c.lastSyncAt).filter((v): v is string => typeof v === 'string').sort().pop() ?? null;
  const daily = channels.filter((c) => c.state === 'active' && c.autoSync?.mode === 'daily');
  const nextAutoSyncAt = daily.map((c) => c.autoSync?.nextAt).filter((v): v is string => typeof v === 'string').sort()[0] ?? null;
  const lastAutoOutcome =
    channels
      .map((c) => (c.autoSync?.lastAuto ? { connectionId: c.connectionId, ...c.autoSync.lastAuto } : null))
      .filter((v): v is NonNullable<typeof v> => v !== null)
      .sort((a, b) => a.finishedAt.localeCompare(b.finishedAt))
      .pop() ?? null;
  return {
    tile: def.tile,
    ok: true,
    glyph: def.glyph,
    currency: baseCurrencyOf(ctx),
    open: counts.total.open,
    needs: counts.total.needs,
    // Critic LOW 5: the band's headline is the hub's `bank_lines_waiting` number, by the same rule, and
    // the lines a pending Vorschlag names are their own figure (counted by `agent_action`).
    waiting: waitingOf(counts.total, seesVorschlaege(ctx)),
    vorschlag: seesVorschlaege(ctx) ? counts.total.vorschlag : 0,
    sure: counts.total.sure,
    learned: counts.total.learned,
    noReceipt: counts.total.noReceipt,
    accounts,
    lastSyncAt,
    syncInProgress: channels.some((c) => c.syncInProgress === true),
    autoMode: daily.length > 0 ? 'daily' : channels.some((c) => c.state === 'active') ? 'off' : null,
    autoAt: daily[0]?.autoSync?.atTime ?? null,
    nextAutoSyncAt,
    lastAutoOutcome,
    // A36 §4.7 (D150): every open statement gap of every Bankkonto, fed or imported by hand.
    statementGaps: readStatementGaps(ctx),
    channels: channels.map((c) => ({
      connectionId: c.connectionId,
      state: c.state,
      lastSyncAt: c.lastSyncAt,
      syncInProgress: c.syncInProgress === true,
      keystoreState: c.keystore?.state ?? 'ready',
      keystorePersistent: c.keystore?.persistent === true,
      pendingStatements: Array.isArray(c.pendingStatements) ? c.pendingStatements.length : 0,
      numberJumps: (c.accounts ?? []).filter((a) => a.lastNumberJump !== null && a.lastNumberJump !== undefined).map((a) => ({ bankAccountId: a.bankAccountId, jump: a.lastNumberJump })),
      // A36 §4.7 (D150): the durable gaps of the channel's accounts (the jump notice above stays for older readers).
      statementGaps: (c.accounts ?? []).flatMap((a) => (Array.isArray(a.statementGaps) ? a.statementGaps : [])),
      autoSync: c.autoSync ?? null,
      bankName: c.bankName ?? null,
      activation: c.activation ?? null,
    })),
    drill: drillOf(ctx, def, { status: 'open' }),
  };
}

type Compute = (ctx: WorkspaceContext, def: DashboardTileDef, from: string, to: string, env: KpiEnv) => Tile;

const COMPUTE: Record<string, Compute> = {
  bank_balance: bankBalanceTile,
  revenue: revenueTile,
  cash: cashTile,
  ar_aging: arAgingTile,
  ap_aging: apAgingTile,
  utilisation: utilisationTile,
  project_margin: projectMarginTile,
  mwst_due: mwstDueTile,
  stock_value: stockValueTile,
  bank_inbox: bankInboxTile,
  free_cash: freeCashTile,
  runway: runwayTile,
  low_point: lowPointTile,
  expense: statementTile('expenseMinor'),
  result: statementTile('resultMinor'),
  margin: marginTile,
  revenue_ltm: revenueLtmTile,
  dso: dsoTile,
  top_customer: topCustomerTile,
  auto_rate: lineShareTile(autoRateFigure),
  receipt_rate: lineShareTile(receiptRateFigure),
};

// ------------------------------------------------------------------------------------------------
// Saved-view resolution (US-F00.7): G00 owns the row, F00 only reads which tiles to render
// ------------------------------------------------------------------------------------------------

/**
 * Resolve which registry entries render, in what order. An unresolvable `savedViewId` (deleted,
 * wrong entity kind or layout, another actor's personal view, another workspace's row) falls back
 * to the FULL default registry with `viewFallback: true` rather than failing the call (P9): the
 * dashboard's job is to show the business, not to defend a stale preference.
 *
 * Visibility rides `listSavedViews`, G00's own read (workspace-fenced, personal views of other
 * actors never returned), so F00 states no access rule of its own. Unknown column ids are simply
 * not rendered; RBAC is re-evaluated per tile AFTER this, so a view can hide or order tiles and can
 * never widen access.
 */
function resolveTiles(
  ctx: WorkspaceContext,
  savedViewId: string | undefined,
): { defs: readonly DashboardTileDef[]; viewFallback: boolean } {
  if (savedViewId === undefined) return { defs: TILE_REGISTRY, viewFallback: false };
  const listed = listSavedViews(ctx, { entityKind: 'workspace' });
  if (!listed.ok) return { defs: TILE_REGISTRY, viewFallback: true };
  const views = listed.savedViews as { viewId: string; layout: string; columns: string[] }[];
  const view = views.find((v) => v.viewId === savedViewId && v.layout === 'dashboard');
  if (view === undefined) return { defs: TILE_REGISTRY, viewFallback: true };
  const defs: DashboardTileDef[] = [];
  for (const column of view.columns) {
    const def = tileDef(column);
    if (def !== undefined && !defs.some((d) => d.tile === def.tile)) defs.push(def);
  }
  return { defs, viewFallback: false };
}

// ------------------------------------------------------------------------------------------------
// The two read verbs
// ------------------------------------------------------------------------------------------------

/** The tile wall (US-F00.1/3/4/5/6/7): every enabled, permitted tile for one range, one call. */
export function dashboardOverview(ctx: WorkspaceContext, input: DashboardOverviewInput): Result {
  const bad = rangeProblem(input.from, input.to);
  if (bad !== undefined) return bad;
  const opts = kpiOptions(input);
  if ('ok' in opts) return opts;
  const env = newKpiEnv(ctx, opts);

  const resolved = resolveTiles(ctx, input.savedViewId);
  const tiles: Tile[] = [];
  const omitted: Record<string, unknown>[] = [];
  for (const def of resolved.defs) {
    // US-F00.6: the omission happens HERE, inside the verb, before any response leaves the engine.
    const deniedCap = def.requires.find((cap) => !ctx.capabilities.assert(cap).ok);
    if (deniedCap !== undefined) {
      omitted.push({ tile: def.tile, error: 'permission_denied', capability: deniedCap });
      continue;
    }
    const compute = COMPUTE[def.tile];
    if (compute === undefined) continue; // structurally unreachable: COMPUTE covers the registry.
    tiles.push(compute(ctx, def, input.from, input.to, env));
  }

  return ok({
    workspaceId: ctx.workspaceId,
    from: input.from,
    to: input.to,
    currency: baseCurrencyOf(ctx),
    tiles,
    omitted,
    ...(resolved.viewFallback ? { viewFallback: true } : {}),
    ...(input.savedViewId !== undefined && !resolved.viewFallback ? { savedViewId: input.savedViewId } : {}),
  });
}

/** One tile with its detail and drill descriptor (US-F00.2/5). */
export function dashboardTile(ctx: WorkspaceContext, input: DashboardTileInput): Result {
  const def = tileDef(input.tile);
  if (def === undefined) return err('unknown_tile', { tile: input.tile, known: [...DASHBOARD_TILES] });
  const bad = rangeProblem(input.from, input.to);
  if (bad !== undefined) return bad;
  // A single-tile ask for a tile the caller may not see is an outright denial, the same fact the
  // overview states as an omission (US-F00.6).
  for (const cap of def.requires) {
    const allowed = ctx.capabilities.assert(cap);
    if (!allowed.ok) return allowed;
  }
  const opts = kpiOptions(input);
  if ('ok' in opts) return opts;
  const compute = COMPUTE[def.tile];
  if (compute === undefined) return err('unknown_tile', { tile: input.tile, known: [...DASHBOARD_TILES] });
  return ok({ workspaceId: ctx.workspaceId, from: input.from, to: input.to, tile: compute(ctx, def, input.from, input.to, newKpiEnv(ctx, opts)) });
}

/** D186 point 2: the estimated turnover of the open bank lines in a range, line by line. */
export interface DashboardRevenueEstimateInput {
  from: string;
  to: string;
  basis?: string | undefined;
}

export function dashboardRevenueEstimate(ctx: WorkspaceContext, input: DashboardRevenueEstimateInput): Result {
  const bad = rangeProblem(input.from, input.to);
  if (bad !== undefined) return bad;
  const basis = input.basis ?? 'rules';
  if (!(REVENUE_ESTIMATE_BASES as readonly string[]).includes(basis)) return err('invalid_input', { field: 'basis', allowed: [...REVENUE_ESTIMATE_BASES] });
  return ok({ workspaceId: ctx.workspaceId, ...revenueEstimate(ctx, { from: input.from, to: input.to, basis: basis as RevenueEstimateBasis }) });
}
