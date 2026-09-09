/**
 * H09, Fixed-Asset REPORTS & agent tools: the READ-ONLY report surface over the H00-H08 fixed-asset
 * cluster. It POSTS NOTHING, mints no journal, opens no write transaction and creates no table: every
 * verb here is a pure, deterministic function of the current workspace snapshot (P5 read-model purity).
 * A report answered twice on an unchanged database answers identically and moves not one row, which is
 * exactly what the conformance `read means read` rule proves.
 *
 * SIX genuinely-new verbs live here. Reconciliation (US-H09.3) and the per-asset transaction history
 * with running balances (US-H09.6) were already delivered by H07 (`reconciliation.ts` / `ledger.ts`)
 * and are re-used, not re-minted; see the spec's RECONCILED banner.
 *
 *  - `assetRegisterReport`        US-H09.1  the filterable, paginated register + totals
 *  - `assetDepreciationForecast`  US-H09.2  a multi-period projection re-using the H03 calculators
 *  - `assetDisposalSummary`       US-H09.4  disposal gain/loss pack for a date range
 *  - `assetAcquisitionSummary`    US-H09.5  what was capitalised in a period
 *  - `assetNbvSummary`            US-H09.7  dimensional NBV / cost roll-up
 *  - `assetEndOfLifeList`         US-H09.8  assets fully depreciated or approaching end of life
 *
 * §H-TENANT ON EVERY QUERY. Every SELECT is scoped to `ctx.workspaceId`, and a supplied foreign id is
 * rejected as `not_found` before any aggregation, so a number can never cross a tenant boundary even
 * if an id is guessed. Money is integer Rappen throughout (P2); formatting to CHF happens only at the
 * Studio/artefact render edge, never here.
 *
 * The forecast re-uses `projectDepreciationSchedule` (the same pure H03 engine the preview/schedule
 * verbs use), so a forecast line can never disagree with a live `asset_depreciation_schedule` call:
 * OP12's calculators are the single source of the numbers (§7 tripwire).
 *
 * Cost-centre is NOT an asset-master dimension in Phase 1 (the master carries no cost_center_id; the
 * category holds only a posting default), so `group_by: 'cost_center'` is refused with `invalid_input`
 * rather than answered against a column that does not exist. Category, location, status and method are
 * real asset columns and are the supported grouping dimensions.
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { projectDepreciationSchedule, isPeriod, nextPeriod } from './depreciation/index.js';
import type { AssetSnapshot, ScheduleLine } from './depreciation/index.js';

/** An ISO calendar date `YYYY-MM-DD`. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
/** A four-digit year `YYYY`. */
const YEAR = /^\d{4}$/;

/** The forecast horizon: at most 60 months forward of `fromPeriod` (§4). */
const MAX_FORECAST_MONTHS = 60;

/** The asset row shape the reports read. A superset of what any single report needs; every column is a
 * real `asset` column (`masterSchema.ts`). */
interface AssetRow {
  id: string;
  number: string;
  name: string;
  category_id: string;
  category_code: string | null;
  category_name: string | null;
  status: string;
  acquisition_date: string;
  acquisition_cost_rappen: number;
  residual_value_rappen: number;
  useful_life_months: number | null;
  depreciation_method: string;
  declining_rate_bp: number | null;
  total_estimated_units: number | null;
  gl_asset_account_id: string;
  gl_accum_depr_account_id: string;
  gl_depr_expense_account_id: string;
  location_id: string | null;
  responsible_user_id: string | null;
  serial_number: string | null;
  barcode: string | null;
  accumulated_depr_rappen: number;
  net_book_value_rappen: number;
  last_depreciation_period: string | null;
  disposed_at: string | null;
  disposal_proceeds_rappen: number | null;
}

/** The register/forecast/nbv column projection, joined to the category for its code and name. */
const ASSET_SELECT = `
  SELECT a.id, a.number, a.name, a.category_id, c.code AS category_code, c.name AS category_name,
         a.status, a.acquisition_date, a.acquisition_cost_rappen, a.residual_value_rappen,
         a.useful_life_months, a.depreciation_method, a.declining_rate_bp, a.total_estimated_units,
         a.gl_asset_account_id, a.gl_accum_depr_account_id, a.gl_depr_expense_account_id,
         a.location_id, a.responsible_user_id, a.serial_number, a.barcode,
         a.accumulated_depr_rappen, a.net_book_value_rappen, a.last_depreciation_period,
         a.disposed_at, a.disposal_proceeds_rappen
    FROM asset a
    LEFT JOIN asset_category c ON c.workspace_id = a.workspace_id AND c.id = a.category_id`;

const num = (v: unknown): number => (typeof v === 'number' ? v : 0);

/** A workspace `YYYY-MM` from the injected clock (never the wall clock directly, §context). */
function currentPeriod(ctx: WorkspaceContext): string {
  return ctx.clock.now().slice(0, 7);
}

/** Read a plain string-keyed record from an untrusted input, or undefined. */
function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

/** Validate an optional array-of-non-empty-strings input; returns the array, `null` (absent) or an
 * `invalid_input` Result. */
function optStringArray(v: unknown, field: string): string[] | null | Result {
  if (v === undefined) return null;
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || x.length === 0)) {
    return err('invalid_input', { field });
  }
  return v as string[];
}

/** Build the AssetSnapshot the pure H03 engine reads from a report row (the `service.ts` toSnapshot
 * shape, kept local so this module never imports the engine's private marshaller). */
function toSnapshot(row: AssetRow): AssetSnapshot {
  return {
    id: row.id,
    workspaceId: '', // unused by the pure calculators; the row is already tenant-scoped.
    status: row.status,
    acquisitionDate: row.acquisition_date,
    acquisitionCostRappen: row.acquisition_cost_rappen,
    residualValueRappen: row.residual_value_rappen,
    usefulLifeMonths: row.useful_life_months,
    depreciationMethod: row.depreciation_method,
    decliningRateBp: row.declining_rate_bp,
    totalEstimatedUnits: row.total_estimated_units,
    accumulatedDeprRappen: row.accumulated_depr_rappen,
    netBookValueRappen: row.net_book_value_rappen,
    lastDepreciationPeriod: row.last_depreciation_period,
  };
}

/** The published register row (camelCase, the Studio/MCP boundary). */
function mapRegisterRow(row: AssetRow) {
  return {
    id: row.id,
    number: row.number,
    name: row.name,
    categoryId: row.category_id,
    categoryCode: row.category_code,
    categoryName: row.category_name,
    status: row.status,
    acquisitionDate: row.acquisition_date,
    acquisitionCostRappen: row.acquisition_cost_rappen,
    accumulatedDeprRappen: row.accumulated_depr_rappen,
    netBookValueRappen: row.net_book_value_rappen,
    residualValueRappen: row.residual_value_rappen,
    method: row.depreciation_method,
    usefulLifeMonths: row.useful_life_months,
    locationId: row.location_id,
    responsibleUserId: row.responsible_user_id,
    serialNumber: row.serial_number,
    barcode: row.barcode,
    lastDepreciationPeriod: row.last_depreciation_period,
    disposedAt: row.disposed_at,
  };
}

// --- US-H09.1: the Asset Register report ------------------------------------------------------------

/** The register columns a caller may sort on, mapped to their real asset column. A field outside this
 * set is `invalid_input` rather than a silent default, so a typo is a defect the caller sees. */
const SORTABLE: Record<string, string> = {
  number: 'a.number',
  name: 'a.name',
  status: 'a.status',
  acquisitionDate: 'a.acquisition_date',
  acquisitionCostRappen: 'a.acquisition_cost_rappen',
  accumulatedDeprRappen: 'a.accumulated_depr_rappen',
  netBookValueRappen: 'a.net_book_value_rappen',
};

const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 5000;

/** Decode a `{ o: offset }` cursor. A malformed cursor is `invalid_input`, never a silent reset. */
function decodeCursor(cursor: unknown): number | Result {
  if (cursor === undefined) return 0;
  if (typeof cursor !== 'string' || cursor.length === 0) return err('invalid_input', { field: 'cursor' });
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64').toString('utf8')) as { o?: unknown };
    if (!Number.isInteger(parsed.o) || (parsed.o as number) < 0) return err('invalid_input', { field: 'cursor' });
    return parsed.o as number;
  } catch {
    return err('invalid_input', { field: 'cursor' });
  }
}

function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ o: offset }), 'utf8').toString('base64');
}

export interface AssetRegisterFilter {
  status?: string[];
  categoryIds?: string[];
  locationIds?: string[];
  acquisitionYearFrom?: string;
  acquisitionYearTo?: string;
  costMinRappen?: number;
  costMaxRappen?: number;
  responsibleUserId?: string;
  q?: string;
}

export interface AssetRegisterReportInput {
  filter?: AssetRegisterFilter;
  columns?: string[];
  sort?: { field?: string; dir?: string };
  cursor?: string;
  limit?: number;
}

/** Build the shared WHERE for the register and its totals from a filter. Returns the clause string and
 * the bound params, or an `invalid_input` Result. `includeArchivedDefault` = false hides archived
 * assets unless the status filter names them (the H01 register posture). */
function buildRegisterWhere(
  ctx: WorkspaceContext,
  filter: AssetRegisterFilter,
): { where: string; params: unknown[] } | Result {
  const clauses = ['a.workspace_id = ?'];
  const params: unknown[] = [ctx.workspaceId];

  const status = optStringArray(filter.status, 'filter.status');
  if (status !== null && 'ok' in (status as object)) return status as Result;
  if (Array.isArray(status) && status.length > 0) {
    clauses.push(`a.status IN (${status.map(() => '?').join(', ')})`);
    params.push(...status);
  } else {
    // Default: the register shows everything the auditor's binder needs (active, fully_depreciated,
    // disposed) but hides soft-archived rows, exactly as `asset_list` does.
    clauses.push("a.status != 'archived'");
  }

  const categoryIds = optStringArray(filter.categoryIds, 'filter.categoryIds');
  if (categoryIds !== null && 'ok' in (categoryIds as object)) return categoryIds as Result;
  if (Array.isArray(categoryIds) && categoryIds.length > 0) {
    clauses.push(`a.category_id IN (${categoryIds.map(() => '?').join(', ')})`);
    params.push(...categoryIds);
  }

  const locationIds = optStringArray(filter.locationIds, 'filter.locationIds');
  if (locationIds !== null && 'ok' in (locationIds as object)) return locationIds as Result;
  if (Array.isArray(locationIds) && locationIds.length > 0) {
    clauses.push(`a.location_id IN (${locationIds.map(() => '?').join(', ')})`);
    params.push(...locationIds);
  }

  if (filter.acquisitionYearFrom !== undefined) {
    if (typeof filter.acquisitionYearFrom !== 'string' || !YEAR.test(filter.acquisitionYearFrom)) {
      return err('invalid_input', { field: 'filter.acquisitionYearFrom' });
    }
    clauses.push('substr(a.acquisition_date, 1, 4) >= ?');
    params.push(filter.acquisitionYearFrom);
  }
  if (filter.acquisitionYearTo !== undefined) {
    if (typeof filter.acquisitionYearTo !== 'string' || !YEAR.test(filter.acquisitionYearTo)) {
      return err('invalid_input', { field: 'filter.acquisitionYearTo' });
    }
    clauses.push('substr(a.acquisition_date, 1, 4) <= ?');
    params.push(filter.acquisitionYearTo);
  }

  if (filter.costMinRappen !== undefined) {
    if (!Number.isInteger(filter.costMinRappen)) return err('invalid_input', { field: 'filter.costMinRappen' });
    clauses.push('a.acquisition_cost_rappen >= ?');
    params.push(filter.costMinRappen);
  }
  if (filter.costMaxRappen !== undefined) {
    if (!Number.isInteger(filter.costMaxRappen)) return err('invalid_input', { field: 'filter.costMaxRappen' });
    clauses.push('a.acquisition_cost_rappen <= ?');
    params.push(filter.costMaxRappen);
  }

  if (filter.responsibleUserId !== undefined) {
    if (typeof filter.responsibleUserId !== 'string' || filter.responsibleUserId.length === 0) {
      return err('invalid_input', { field: 'filter.responsibleUserId' });
    }
    clauses.push('a.responsible_user_id = ?');
    params.push(filter.responsibleUserId);
  }

  if (filter.q !== undefined) {
    if (typeof filter.q !== 'string') return err('invalid_input', { field: 'filter.q' });
    const like = `%${filter.q.toLowerCase()}%`;
    clauses.push(
      '(lower(a.number) LIKE ? OR lower(a.name) LIKE ? OR lower(coalesce(a.serial_number, \'\')) LIKE ? OR lower(coalesce(a.barcode, \'\')) LIKE ? OR lower(coalesce(a.notes, \'\')) LIKE ?)',
    );
    params.push(like, like, like, like, like);
  }

  return { where: clauses.join(' AND '), params };
}

/**
 * US-H09.1: the complete, filterable, paginated asset register with a totals footer. The totals are
 * computed over the WHOLE filtered set (not just the returned page), so `sum(nbv)` equals the sum of
 * every matching asset's `net_book_value_rappen` regardless of pagination (§7 money-identity tripwire).
 * An empty match is a success (`rows: []`, zero totals), never an error.
 */
export function assetRegisterReport(ctx: WorkspaceContext, input: AssetRegisterReportInput = {}): Result {
  const filter = asRecord(input.filter) ? (input.filter as AssetRegisterFilter) : {};
  const built = buildRegisterWhere(ctx, filter);
  if ('ok' in built) return built as Result;
  const { where, params } = built;

  // Sort: a whitelisted column + direction, defaulting to number ascending (the register's natural
  // order). A tie-break on id keeps pagination stable across pages.
  let orderCol = 'a.number';
  let dir = 'ASC';
  if (input.sort !== undefined) {
    const s = asRecord(input.sort);
    if (s === undefined) return err('invalid_input', { field: 'sort' });
    if (s.field !== undefined) {
      if (typeof s.field !== 'string' || !(s.field in SORTABLE)) {
        return err('invalid_input', { field: 'sort.field', allowed: Object.keys(SORTABLE) });
      }
      orderCol = SORTABLE[s.field] as string;
    }
    if (s.dir !== undefined) {
      if (s.dir !== 'asc' && s.dir !== 'desc') return err('invalid_input', { field: 'sort.dir' });
      dir = s.dir === 'desc' ? 'DESC' : 'ASC';
    }
  }

  let limit = DEFAULT_LIMIT;
  if (input.limit !== undefined) {
    if (!Number.isInteger(input.limit) || input.limit <= 0) return err('invalid_input', { field: 'limit' });
    limit = Math.min(input.limit, MAX_LIMIT);
  }
  const offset = decodeCursor(input.cursor);
  if (typeof offset !== 'number') return offset;

  // Totals over the full filtered set: one aggregate query, independent of the page.
  const totalsRow = ctx.store.db
    .prepare(
      `SELECT COUNT(*) AS count,
              COALESCE(SUM(a.acquisition_cost_rappen), 0) AS cost,
              COALESCE(SUM(a.accumulated_depr_rappen), 0) AS accum,
              COALESCE(SUM(a.net_book_value_rappen), 0) AS nbv
         FROM asset a WHERE ${where}`,
    )
    .get(...params) as { count: number; cost: number; accum: number; nbv: number };

  // The page. `orderCol` and `dir` are from a closed whitelist, never the caller's raw string, so the
  // interpolation carries no injection surface.
  const rows = ctx.store.db
    .prepare(`${ASSET_SELECT} WHERE ${where} ORDER BY ${orderCol} ${dir}, a.id ${dir} LIMIT ? OFFSET ?`)
    .all(...params, limit, offset) as AssetRow[];

  let mapped = rows.map(mapRegisterRow);
  // Optional column projection: a subset of the published columns, always keeping id/number as the
  // stable identity. An unknown column name is ignored (forward-compatible), never an error.
  if (Array.isArray(input.columns) && input.columns.length > 0) {
    const keep = new Set<string>(['id', 'number', ...input.columns.filter((c) => typeof c === 'string')]);
    mapped = mapped.map((r) => {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(r)) if (keep.has(k)) out[k] = v;
      return out as typeof r;
    });
  }

  const nextOffset = offset + rows.length;
  const result: Record<string, unknown> = {
    rows: mapped,
    totals: {
      count: num(totalsRow.count),
      costRappen: num(totalsRow.cost),
      accumRappen: num(totalsRow.accum),
      nbvRappen: num(totalsRow.nbv),
    },
  };
  if (nextOffset < num(totalsRow.count)) result.nextCursor = encodeCursor(nextOffset);
  if (mapped.length === 0 && offset === 0) result.message = 'no_assets_matching';
  return ok(result);
}

// --- US-H09.2: the multi-period Depreciation Forecast ----------------------------------------------

/** The inclusive month distance from `a` to `b` (both `YYYY-MM`), or a negative number if b precedes a. */
function monthDistance(a: string, b: string): number {
  const ap = a.split('-').map(Number);
  const bp = b.split('-').map(Number);
  const ay = ap[0] ?? 0;
  const am = ap[1] ?? 0;
  const by = bp[0] ?? 0;
  const bm = bp[1] ?? 0;
  return (by - ay) * 12 + (bm - am);
}

/** The ordered inclusive list of periods from `from` to `to`. */
function periodRange(from: string, to: string): string[] {
  const out: string[] = [];
  let p = from;
  while (p <= to) {
    out.push(p);
    p = nextPeriod(p);
  }
  return out;
}

export interface AssetDepreciationForecastInput {
  fromPeriod?: string;
  toPeriod?: string;
  groupBy?: string;
  filter?: { categoryIds?: string[]; locationIds?: string[]; assetIds?: string[] };
  includeDetail?: boolean;
  unitsForecast?: Record<string, number[]>;
}

const FORECAST_GROUP_BY = new Set(['none', 'category', 'location']);

/**
 * US-H09.2: project depreciation forward over a bounded window, re-using the SAME pure H03 calculators
 * the preview/schedule verbs use, so a forecast line can never disagree with a live schedule. Writes
 * nothing and is deterministic for a given asset snapshot. A units-of-production asset with no supplied
 * `unitsForecast` contributes zero and raises a `production_data_required` warning rather than inventing
 * usage. The window is clamped to `MAX_FORECAST_MONTHS`; a reversed or over-long window is
 * `invalid_period_range`.
 */
export function assetDepreciationForecast(ctx: WorkspaceContext, input: AssetDepreciationForecastInput = {}): Result {
  if (!isPeriod(input.fromPeriod)) return err('invalid_period_range', { field: 'fromPeriod', value: input.fromPeriod });
  if (!isPeriod(input.toPeriod)) return err('invalid_period_range', { field: 'toPeriod', value: input.toPeriod });
  const fromPeriod = input.fromPeriod as string;
  const toPeriod = input.toPeriod as string;
  const span = monthDistance(fromPeriod, toPeriod);
  if (span < 0) return err('invalid_period_range', { reason: 'to_before_from', fromPeriod, toPeriod });
  if (span + 1 > MAX_FORECAST_MONTHS) {
    return err('invalid_period_range', { reason: 'window_exceeds_horizon', maxMonths: MAX_FORECAST_MONTHS });
  }

  const groupBy = input.groupBy ?? 'none';
  if (typeof groupBy !== 'string' || !FORECAST_GROUP_BY.has(groupBy)) {
    return err('invalid_input', { field: 'groupBy', allowed: [...FORECAST_GROUP_BY] });
  }

  const filter = asRecord(input.filter) ?? {};
  const categoryIds = optStringArray(filter.categoryIds, 'filter.categoryIds');
  if (categoryIds !== null && 'ok' in (categoryIds as object)) return categoryIds as Result;
  const locationIds = optStringArray(filter.locationIds, 'filter.locationIds');
  if (locationIds !== null && 'ok' in (locationIds as object)) return locationIds as Result;
  const assetIds = optStringArray(filter.assetIds, 'filter.assetIds');
  if (assetIds !== null && 'ok' in (assetIds as object)) return assetIds as Result;

  // Qualifying assets: depreciable (method not 'none'), still on the books (active / fully_depreciated),
  // never draft / disposed / archived. A fully_depreciated asset is already at residual and contributes
  // zero, which the engine reports as an empty projection.
  const clauses = ["a.workspace_id = ?", "a.status IN ('active', 'fully_depreciated')", "a.depreciation_method != 'none'"];
  const params: unknown[] = [ctx.workspaceId];
  if (Array.isArray(categoryIds) && categoryIds.length > 0) {
    clauses.push(`a.category_id IN (${categoryIds.map(() => '?').join(', ')})`);
    params.push(...categoryIds);
  }
  if (Array.isArray(locationIds) && locationIds.length > 0) {
    clauses.push(`a.location_id IN (${locationIds.map(() => '?').join(', ')})`);
    params.push(...locationIds);
  }
  if (Array.isArray(assetIds) && assetIds.length > 0) {
    // §H-TENANT: an explicit id list must resolve entirely within the workspace; a foreign id is
    // not_found before any projection, never a silently-dropped row.
    for (const id of assetIds) {
      const hit = ctx.store.db
        .prepare('SELECT 1 FROM asset WHERE workspace_id = ? AND id = ?')
        .get(ctx.workspaceId, id);
      if (hit === undefined) return err('not_found', { assetId: id });
    }
    clauses.push(`a.id IN (${assetIds.map(() => '?').join(', ')})`);
    params.push(...assetIds);
  }

  const rows = ctx.store.db
    .prepare(`${ASSET_SELECT} WHERE ${clauses.join(' AND ')} ORDER BY a.number`)
    .all(...params) as AssetRow[];

  const periods = periodRange(fromPeriod, toPeriod);
  const periodTotals = new Map<string, number>(periods.map((p) => [p, 0]));
  const periodGroups = new Map<string, Map<string, number>>(periods.map((p) => [p, new Map()]));
  const detail: Array<{ assetId: string; number: string; name: string; lines: ScheduleLine[] }> = [];
  const warnings = new Set<string>();
  let assetsReachingResidual = 0;

  for (const row of rows) {
    const groupKey =
      groupBy === 'category'
        ? row.category_code ?? row.category_id
        : groupBy === 'location'
          ? row.location_id ?? 'unassigned'
          : 'all';

    const options: { unitsForecast?: Record<string, number> } = {};
    if (row.depreciation_method === 'units_of_production') {
      const perAsset = input.unitsForecast?.[row.id];
      if (Array.isArray(perAsset)) {
        // Map the caller's per-period units array onto the forecast periods in order.
        const map: Record<string, number> = {};
        periods.forEach((p, i) => {
          if (typeof perAsset[i] === 'number') map[p] = perAsset[i];
        });
        options.unitsForecast = map;
      } else {
        warnings.add('production_data_required');
        continue; // contributes zero; no invented usage.
      }
    }

    const projection = projectDepreciationSchedule(toSnapshot(row), fromPeriod, toPeriod, options);
    if (projection.warning === 'units_forecast_required') {
      warnings.add('production_data_required');
      continue;
    }
    let reachedResidual = false;
    for (const line of projection.lines) {
      if (line.period < fromPeriod || line.period > toPeriod) continue;
      periodTotals.set(line.period, (periodTotals.get(line.period) ?? 0) + line.amountRappen);
      const g = periodGroups.get(line.period);
      if (g !== undefined) g.set(groupKey, (g.get(groupKey) ?? 0) + line.amountRappen);
      if (line.isFinal) reachedResidual = true;
    }
    if (reachedResidual) assetsReachingResidual += 1;
    if (input.includeDetail === true && projection.lines.length > 0) {
      detail.push({ assetId: row.id, number: row.number, name: row.name, lines: projection.lines });
    }
  }

  const periodsOut = periods.map((p) => {
    const entry: { period: string; totalAmountRappen: number; byGroup?: Record<string, number> } = {
      period: p,
      totalAmountRappen: periodTotals.get(p) ?? 0,
    };
    if (groupBy !== 'none') entry.byGroup = Object.fromEntries(periodGroups.get(p) ?? new Map());
    return entry;
  });

  const result: Record<string, unknown> = {
    fromPeriod,
    toPeriod,
    groupBy,
    periods: periodsOut,
    totalProjectedRappen: periodsOut.reduce((s, p) => s + p.totalAmountRappen, 0),
    assetsReachingResidual,
    warnings: [...warnings],
  };
  if (input.includeDetail === true) result.detail = detail;
  return ok(result);
}

// --- US-H09.4: the Disposal Gain/Loss summary ------------------------------------------------------

/** Validate a `fromDate` / `toDate` pair. Returns `null` (both valid) or an `invalid_input` Result. */
function checkDateRange(from: unknown, to: unknown): Result | null {
  if (typeof from !== 'string' || !ISO_DATE.test(from)) return err('invalid_input', { field: 'fromDate' });
  if (typeof to !== 'string' || !ISO_DATE.test(to)) return err('invalid_input', { field: 'toDate' });
  if (to < from) return err('invalid_input', { field: 'toDate', reason: 'to_before_from' });
  return null;
}

export interface AssetDisposalSummaryInput {
  fromDate?: string;
  toDate?: string;
  filter?: { categoryIds?: string[]; locationIds?: string[]; reason?: string };
}

/**
 * US-H09.4: every disposal (H06) posted in the date range with its gain/loss breakdown, plus footer
 * totals (count, sum proceeds, sum gain, sum loss, net). Read-only: derived from the append-only
 * `asset_transaction` disposal rows. No disposals in range is an empty success, not an error.
 */
export function assetDisposalSummary(ctx: WorkspaceContext, input: AssetDisposalSummaryInput = {}): Result {
  const bad = checkDateRange(input.fromDate, input.toDate);
  if (bad !== null) return bad;
  const filter = asRecord(input.filter) ?? {};
  const categoryIds = optStringArray(filter.categoryIds, 'filter.categoryIds');
  if (categoryIds !== null && 'ok' in (categoryIds as object)) return categoryIds as Result;
  const locationIds = optStringArray(filter.locationIds, 'filter.locationIds');
  if (locationIds !== null && 'ok' in (locationIds as object)) return locationIds as Result;

  const clauses = ["t.workspace_id = ?", "t.type = 'disposal'", 't.date >= ?', 't.date <= ?'];
  const params: unknown[] = [ctx.workspaceId, input.fromDate, input.toDate];
  if (Array.isArray(categoryIds) && categoryIds.length > 0) {
    clauses.push(`a.category_id IN (${categoryIds.map(() => '?').join(', ')})`);
    params.push(...categoryIds);
  }
  if (Array.isArray(locationIds) && locationIds.length > 0) {
    clauses.push(`a.location_id IN (${locationIds.map(() => '?').join(', ')})`);
    params.push(...locationIds);
  }
  if (filter.reason !== undefined) {
    if (typeof filter.reason !== 'string') return err('invalid_input', { field: 'filter.reason' });
    clauses.push('lower(coalesce(t.description, \'\')) LIKE ?');
    params.push(`%${filter.reason.toLowerCase()}%`);
  }

  const rows = ctx.store.db
    .prepare(
      `SELECT t.id AS txn_id, t.date, t.delta_cost_rappen, t.delta_accum_depr_rappen, t.proceeds_rappen,
              t.gain_loss_rappen, t.journal_entry_id, t.description,
              a.id AS asset_id, a.number, a.name, a.category_id, c.code AS category_code, c.name AS category_name,
              a.location_id
         FROM asset_transaction t
         JOIN asset a ON a.workspace_id = t.workspace_id AND a.id = t.asset_id
         LEFT JOIN asset_category c ON c.workspace_id = a.workspace_id AND c.id = a.category_id
        WHERE ${clauses.join(' AND ')}
        ORDER BY t.date, t.created_at, t.id`,
    )
    .all(...params) as Array<{
    txn_id: string;
    date: string;
    delta_cost_rappen: number;
    delta_accum_depr_rappen: number;
    proceeds_rappen: number | null;
    gain_loss_rappen: number | null;
    journal_entry_id: string;
    description: string | null;
    asset_id: string;
    number: string;
    name: string;
    category_id: string;
    category_code: string | null;
    category_name: string | null;
    location_id: string | null;
  }>;

  const disposals = rows.map((r) => {
    // At disposal the deltas clear the asset: delta_cost = -cost, delta_accum = -accumulated. So the
    // original cost and the accumulated-at-disposal are the negations, and NBV-at-disposal is their
    // difference.
    const originalCostRappen = -r.delta_cost_rappen;
    const accumDeprAtDisposalRappen = -r.delta_accum_depr_rappen;
    const nbvAtDisposalRappen = originalCostRappen - accumDeprAtDisposalRappen;
    return {
      transactionId: r.txn_id,
      assetId: r.asset_id,
      assetNumber: r.number,
      name: r.name,
      categoryCode: r.category_code,
      categoryName: r.category_name,
      locationId: r.location_id,
      disposalDate: r.date,
      originalCostRappen,
      accumDeprAtDisposalRappen,
      nbvAtDisposalRappen,
      proceedsRappen: num(r.proceeds_rappen),
      gainLossRappen: num(r.gain_loss_rappen),
      journalEntryId: r.journal_entry_id,
      reason: r.description,
    };
  });

  const totals = disposals.reduce(
    (acc, d) => {
      acc.count += 1;
      acc.proceedsRappen += d.proceedsRappen;
      if (d.gainLossRappen > 0) acc.gainRappen += d.gainLossRappen;
      else if (d.gainLossRappen < 0) acc.lossRappen += -d.gainLossRappen;
      acc.netGainLossRappen += d.gainLossRappen;
      return acc;
    },
    { count: 0, proceedsRappen: 0, gainRappen: 0, lossRappen: 0, netGainLossRappen: 0 },
  );

  return ok({ disposals, totals });
}

// --- US-H09.5: the Acquisition / Capex summary -----------------------------------------------------

export interface AssetAcquisitionSummaryInput {
  fromDate?: string;
  toDate?: string;
  filter?: { categoryIds?: string[]; locationIds?: string[] };
}

/**
 * US-H09.5: every capitalisation event (primary acquisition + additional capitalisation, H02) in the
 * date range, so "what did we capitalise this period?" is one call. Footer totals: count + sum cost.
 * Read-only over the append-only sub-ledger.
 */
export function assetAcquisitionSummary(ctx: WorkspaceContext, input: AssetAcquisitionSummaryInput = {}): Result {
  const bad = checkDateRange(input.fromDate, input.toDate);
  if (bad !== null) return bad;
  const filter = asRecord(input.filter) ?? {};
  const categoryIds = optStringArray(filter.categoryIds, 'filter.categoryIds');
  if (categoryIds !== null && 'ok' in (categoryIds as object)) return categoryIds as Result;
  const locationIds = optStringArray(filter.locationIds, 'filter.locationIds');
  if (locationIds !== null && 'ok' in (locationIds as object)) return locationIds as Result;

  const clauses = [
    't.workspace_id = ?',
    "t.type IN ('acquisition', 'additional_capitalisation')",
    't.date >= ?',
    't.date <= ?',
  ];
  const params: unknown[] = [ctx.workspaceId, input.fromDate, input.toDate];
  if (Array.isArray(categoryIds) && categoryIds.length > 0) {
    clauses.push(`a.category_id IN (${categoryIds.map(() => '?').join(', ')})`);
    params.push(...categoryIds);
  }
  if (Array.isArray(locationIds) && locationIds.length > 0) {
    clauses.push(`a.location_id IN (${locationIds.map(() => '?').join(', ')})`);
    params.push(...locationIds);
  }

  const rows = ctx.store.db
    .prepare(
      `SELECT t.id AS txn_id, t.type, t.date, t.delta_cost_rappen, t.journal_entry_id,
              t.source_document_type, t.source_document_id,
              a.id AS asset_id, a.number, a.name, a.category_id, c.code AS category_code, c.name AS category_name,
              a.location_id, a.gl_asset_account_id,
              acc.number AS gl_asset_account_number, acc.name AS gl_asset_account_name
         FROM asset_transaction t
         JOIN asset a ON a.workspace_id = t.workspace_id AND a.id = t.asset_id
         LEFT JOIN asset_category c ON c.workspace_id = a.workspace_id AND c.id = a.category_id
         LEFT JOIN account acc ON acc.workspace_id = a.workspace_id AND acc.id = a.gl_asset_account_id
        WHERE ${clauses.join(' AND ')}
        ORDER BY t.date, t.created_at, t.id`,
    )
    .all(...params) as Array<{
    txn_id: string;
    type: string;
    date: string;
    delta_cost_rappen: number;
    journal_entry_id: string;
    source_document_type: string | null;
    source_document_id: string | null;
    asset_id: string;
    number: string;
    name: string;
    category_id: string;
    category_code: string | null;
    category_name: string | null;
    location_id: string | null;
    gl_asset_account_id: string;
    gl_asset_account_number: string | null;
    gl_asset_account_name: string | null;
  }>;

  const acquisitions = rows.map((r) => ({
    transactionId: r.txn_id,
    type: r.type,
    assetId: r.asset_id,
    assetNumber: r.number,
    name: r.name,
    acquisitionDate: r.date,
    costRappen: r.delta_cost_rappen,
    categoryCode: r.category_code,
    categoryName: r.category_name,
    locationId: r.location_id,
    glAssetAccountId: r.gl_asset_account_id,
    glAssetAccountNumber: r.gl_asset_account_number,
    glAssetAccountName: r.gl_asset_account_name,
    source: r.source_document_type ?? 'manual',
    sourceDocumentId: r.source_document_id,
    journalEntryId: r.journal_entry_id,
  }));

  const totals = acquisitions.reduce(
    (acc, a) => {
      acc.count += 1;
      acc.costRappen += a.costRappen;
      return acc;
    },
    { count: 0, costRappen: 0 },
  );

  return ok({ acquisitions, totals });
}

// --- US-H09.7: the dimensional NBV / Cost summary --------------------------------------------------

const NBV_GROUP_BY: Record<string, string> = {
  category: 'a.category_id',
  location: 'a.location_id',
  status: 'a.status',
  method: 'a.depreciation_method',
};

export interface AssetNbvSummaryInput {
  groupBy?: string;
  filter?: AssetRegisterFilter;
  includeDisposed?: boolean;
}

/**
 * US-H09.7: NBV / cost roll-up grouped by a dimension (category | location | status | method), with a
 * grand total. Non-disposed assets only by default; `includeDisposed: true` folds disposed assets in.
 * Read-only over the asset master convenience columns. Cost-centre is not an asset dimension in Phase 1
 * (see the module header), so it is `invalid_input`, not a silent empty grouping.
 */
export function assetNbvSummary(ctx: WorkspaceContext, input: AssetNbvSummaryInput = {}): Result {
  if (typeof input.groupBy !== 'string' || !(input.groupBy in NBV_GROUP_BY)) {
    return err('invalid_input', { field: 'groupBy', allowed: Object.keys(NBV_GROUP_BY) });
  }
  const col = NBV_GROUP_BY[input.groupBy];

  const filter = asRecord(input.filter) ? (input.filter as AssetRegisterFilter) : {};
  const built = buildRegisterWhere(ctx, filter);
  if ('ok' in built) return built as Result;
  const clauses = [built.where];
  const params = [...built.params];
  // The register WHERE already hides archived by default. Disposed rows are shown unless the caller
  // opts out, so exclude them here unless includeDisposed is set OR the filter names a status.
  if (input.includeDisposed !== true && filter.status === undefined) {
    clauses.push("a.status != 'disposed'");
  }

  const rows = ctx.store.db
    .prepare(
      `SELECT ${col} AS grp,
              COUNT(*) AS count,
              COALESCE(SUM(a.acquisition_cost_rappen), 0) AS cost,
              COALESCE(SUM(a.accumulated_depr_rappen), 0) AS accum,
              COALESCE(SUM(a.net_book_value_rappen), 0) AS nbv
         FROM asset a
         LEFT JOIN asset_category c ON c.workspace_id = a.workspace_id AND c.id = a.category_id
        WHERE ${clauses.join(' AND ')}
        GROUP BY ${col}
        ORDER BY ${col}`,
    )
    .all(...params) as Array<{ grp: string | null; count: number; cost: number; accum: number; nbv: number }>;

  const groups = rows.map((r) => ({
    key: r.grp ?? 'unassigned',
    count: num(r.count),
    sumCostRappen: num(r.cost),
    sumAccumRappen: num(r.accum),
    sumNbvRappen: num(r.nbv),
  }));

  const grandTotal = groups.reduce(
    (acc, g) => {
      acc.count += g.count;
      acc.sumCostRappen += g.sumCostRappen;
      acc.sumAccumRappen += g.sumAccumRappen;
      acc.sumNbvRappen += g.sumNbvRappen;
      return acc;
    },
    { count: 0, sumCostRappen: 0, sumAccumRappen: 0, sumNbvRappen: 0 },
  );

  return ok({ groupBy: input.groupBy, groups, grandTotal });
}

// --- US-H09.8: the End-of-Life list ----------------------------------------------------------------

export interface AssetEndOfLifeInput {
  withinMonths?: number;
  status?: string;
}

/**
 * US-H09.8: assets already fully depreciated or approaching end of life, ordered soonest first, each
 * with current NBV and the next forecasted depreciation amount. `status: 'fully_depreciated'` lists the
 * already-done set; the default `'approaching'` projects each active asset forward and keeps those whose
 * remaining life falls inside `withinMonths` (default 12). Pure read; re-uses the H03 projector.
 */
export function assetEndOfLifeList(ctx: WorkspaceContext, input: AssetEndOfLifeInput = {}): Result {
  const mode = input.status ?? 'approaching';
  if (mode !== 'approaching' && mode !== 'fully_depreciated') {
    return err('invalid_input', { field: 'status', allowed: ['approaching', 'fully_depreciated'] });
  }
  let withinMonths = 12;
  if (input.withinMonths !== undefined) {
    if (!Number.isInteger(input.withinMonths) || input.withinMonths <= 0) {
      return err('invalid_input', { field: 'withinMonths' });
    }
    withinMonths = Math.min(input.withinMonths, MAX_FORECAST_MONTHS);
  }

  if (mode === 'fully_depreciated') {
    const rows = ctx.store.db
      .prepare(`${ASSET_SELECT} WHERE a.workspace_id = ? AND a.status = 'fully_depreciated' ORDER BY a.number`)
      .all(ctx.workspaceId) as AssetRow[];
    const assets = rows.map((r) => ({
      assetId: r.id,
      number: r.number,
      name: r.name,
      categoryCode: r.category_code,
      status: r.status,
      netBookValueRappen: r.net_book_value_rappen,
      residualValueRappen: r.residual_value_rappen,
      remainingMonths: 0,
      nextDepreciationRappen: 0,
    }));
    return ok({ mode, withinMonths, assets });
  }

  // 'approaching': project each depreciable active asset forward from the current period and count the
  // periods until it reaches residual. Keep those inside the window.
  const from = currentPeriod(ctx);
  const rows = ctx.store.db
    .prepare(
      `${ASSET_SELECT} WHERE a.workspace_id = ? AND a.status = 'active' AND a.depreciation_method != 'none' ORDER BY a.number`,
    )
    .all(ctx.workspaceId) as AssetRow[];

  const out: Array<{
    assetId: string;
    number: string;
    name: string;
    categoryCode: string | null;
    status: string;
    netBookValueRappen: number;
    residualValueRappen: number;
    remainingMonths: number;
    nextDepreciationRappen: number;
  }> = [];

  for (const r of rows) {
    // Units-of-production has no calendar life, so "months to end" is not projectable without a units
    // forecast; it is out of the approaching-by-months window by construction.
    if (r.depreciation_method === 'units_of_production') continue;
    const projection = projectDepreciationSchedule(toSnapshot(r), from);
    if (projection.lines.length === 0) continue; // already at residual: not "approaching".
    const firstLine = projection.lines[0];
    if (firstLine === undefined) continue;
    const finalIdx = projection.lines.findIndex((l) => l.isFinal);
    const remainingMonths = finalIdx >= 0 ? finalIdx + 1 : projection.lines.length;
    if (finalIdx < 0 || remainingMonths > withinMonths) continue;
    out.push({
      assetId: r.id,
      number: r.number,
      name: r.name,
      categoryCode: r.category_code,
      status: r.status,
      netBookValueRappen: r.net_book_value_rappen,
      residualValueRappen: r.residual_value_rappen,
      remainingMonths,
      nextDepreciationRappen: firstLine.amountRappen,
    });
  }

  out.sort((a, b) => a.remainingMonths - b.remainingMonths || a.number.localeCompare(b.number));
  return ok({ mode, withinMonths, assets: out });
}
