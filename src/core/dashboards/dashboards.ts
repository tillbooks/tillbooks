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
import { computeIncomeStatement, computeGeneralLedger } from '../reports/index.js';
import { agingReport } from '../debtors/index.js';
import { listVendorBills } from '../purchase/index.js';
import { computeVatReturn, listVatPeriods } from '../vat/index.js';
import { timeList } from '../time/index.js';
import { costingPlList } from '../costing/index.js';
import { valuationReport } from '../stock/index.js';
import { listBankAccounts } from '../banking/index.js';
import { listSavedViews } from '../customization/index.js';
import { DASHBOARD_TILES, TILE_REGISTRY, tileDef } from './tiles.js';
import type { DashboardTileDef } from './tiles.js';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface DashboardOverviewInput {
  from: string;
  to: string;
  savedViewId?: string | undefined;
}

export interface DashboardTileInput {
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

/** The previous window of identical length, ending the day before `from` (the revenue trend base). */
function previousWindow(from: string, to: string): { from: string; to: string } {
  const lengthDays = Math.round((Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / 86_400_000);
  const prevTo = addDays(from, -1);
  return { from: addDays(prevTo, -lengthDays), to: prevTo };
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

function revenueTile(ctx: WorkspaceContext, def: DashboardTileDef, from: string, to: string): Tile {
  const prev = previousWindow(from, to);
  const statement = computeIncomeStatement(ctx, {
    periodStart: from,
    periodEnd: to,
    compareTo: { periodStart: prev.from, periodEnd: prev.to },
  });
  if (!statement.ok) return degraded(def, statement.error);
  const sections = statement.sections as { key: string; subtotalMinor: number; compareSubtotalMinor?: number }[];
  const erloese = sections.find((s) => s.key === 'netto_erloese');
  const valueRappen = erloese?.subtotalMinor ?? 0;
  const previousRevenueMinor = erloese?.compareSubtotalMinor ?? 0;
  // ONE division, ONE rounding point (P2). Null when the base window is zero: a trend against
  // nothing is not a percentage, and rendering one would be a fake figure.
  const trendBp =
    previousRevenueMinor === 0 ? null : Math.round(((valueRappen - previousRevenueMinor) * 10000) / Math.abs(previousRevenueMinor));
  return {
    tile: def.tile,
    ok: true,
    valueRappen,
    currency: baseCurrencyOf(ctx),
    range: { from, to },
    trendBp,
    glyph: def.glyph,
    drill: drillOf(ctx, def, { periodStart: from, periodEnd: to }),
    detail: {
      reingewinnMinor: num(statement, 'reingewinnMinor'),
      previousRevenueMinor,
      previousRange: prev,
    },
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

const COMPUTE: Record<string, (ctx: WorkspaceContext, def: DashboardTileDef, from: string, to: string) => Tile> = {
  revenue: revenueTile,
  cash: cashTile,
  ar_aging: arAgingTile,
  ap_aging: apAgingTile,
  utilisation: utilisationTile,
  project_margin: projectMarginTile,
  mwst_due: mwstDueTile,
  stock_value: stockValueTile,
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
    tiles.push(compute(ctx, def, input.from, input.to));
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
  const compute = COMPUTE[def.tile];
  if (compute === undefined) return err('unknown_tile', { tile: input.tile, known: [...DASHBOARD_TILES] });
  return ok({ workspaceId: ctx.workspaceId, from: input.from, to: input.to, tile: compute(ctx, def, input.from, input.to) });
}
