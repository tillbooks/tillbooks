/**
 * H03, the ctx-facing depreciation surface: the four MCP/REST verbs (preview, schedule, methods,
 * method_set_enabled) plus the two things they need that the pure engine does not: reading an asset
 * snapshot from the store (§H-TENANT) and the per-workspace method-enablement flag.
 *
 * THE PURE ENGINE (`engine.ts`) DOES THE MONEY MATH; this module only marshals data in and out. Every
 * read is scoped to `ctx.workspaceId`, so a foreign asset id resolves to `undefined` and is rejected
 * with `not_found` BEFORE any number is computed (§H-TENANT, US-H03.7). The three read verbs write
 * nothing; the one write verb (enablement) is idempotent and upserts a single row.
 *
 * H01 PARAMETER GAP (reported to the orchestrator): the asset master does not persist
 * `declining_rate_bp` or `total_estimated_units`. The snapshot builder therefore resolves them with
 * the precedence stored-on-asset (forward seam, currently absent) -> per-call override -> null, so a
 * declining-balance or units-of-production preview is fully exercisable through the surface today
 * without editing H01, and becomes automatic the day those columns land.
 */

import type { WorkspaceContext } from '../../context.js';
import { ok, err } from '../../result.js';
import type { Result } from '../../result.js';
import {
  calculateDepreciation,
  calculateDepreciationBatch,
  projectDepreciationSchedule,
  hasDepreciationMethod,
  isPeriod,
  daysInPeriod,
} from './engine.js';
import type { ScheduleOptions } from './engine.js';
import type { AssetSnapshot, CalcContext, MethodDescriptor, ProRataConvention } from './types.js';
import { DEPRECIATION_METHODS } from '../category.js';

/** The subset of the asset row the engine needs. `declining_rate_bp` / `total_estimated_units` are read
 * defensively: the columns do not exist on H01's table yet, so they resolve to `undefined`. */
interface AssetDeprRow {
  id: string;
  workspace_id: string;
  status: string;
  acquisition_date: string;
  acquisition_cost_rappen: number;
  residual_value_rappen: number;
  useful_life_months: number | null;
  depreciation_method: string;
  accumulated_depr_rappen: number;
  net_book_value_rappen: number;
  last_depreciation_period: string | null;
  declining_rate_bp?: number | null;
  total_estimated_units?: number | null;
}

/** Per-asset method-parameter override, the bridge until H01 persists these on the asset (see header). */
interface ParamOverride {
  decliningRateBp?: number;
  totalEstimatedUnits?: number;
}

function readAssetRow(ctx: WorkspaceContext, id: string): AssetDeprRow | undefined {
  return ctx.store.db
    .prepare('SELECT * FROM asset WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, id) as AssetDeprRow | undefined;
}

function toSnapshot(row: AssetDeprRow, override?: ParamOverride): AssetSnapshot {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    status: row.status,
    acquisitionDate: row.acquisition_date,
    acquisitionCostRappen: row.acquisition_cost_rappen,
    residualValueRappen: row.residual_value_rappen,
    usefulLifeMonths: row.useful_life_months,
    depreciationMethod: row.depreciation_method,
    decliningRateBp:
      typeof row.declining_rate_bp === 'number' ? row.declining_rate_bp : override?.decliningRateBp ?? null,
    totalEstimatedUnits:
      typeof row.total_estimated_units === 'number'
        ? row.total_estimated_units
        : override?.totalEstimatedUnits ?? null,
    accumulatedDeprRappen: row.accumulated_depr_rappen,
    netBookValueRappen: row.net_book_value_rappen,
    lastDepreciationPeriod: row.last_depreciation_period,
  };
}

// --- Method registry + workspace enablement --------------------------------------------------------

const METHOD_LABEL: Record<string, { requiresUnits: boolean; requiresRate: boolean }> = {
  straight_line: { requiresUnits: false, requiresRate: false },
  declining_balance: { requiresUnits: false, requiresRate: true },
  units_of_production: { requiresUnits: true, requiresRate: false },
  none: { requiresUnits: false, requiresRate: false },
};

/** The workspace's disabled-method set, read WITHOUT writing (absence means enabled). */
function disabledMethods(ctx: WorkspaceContext): Set<string> {
  const rows = ctx.store.db
    .prepare('SELECT method_key FROM asset_depreciation_method_setting WHERE workspace_id = ? AND enabled = 0')
    .all(ctx.workspaceId) as { method_key: string }[];
  return new Set(rows.map((r) => r.method_key));
}

/** List the registered methods with this workspace's enablement flags. Read-only (§6 secondary surface). */
export function listDepreciationMethods(ctx: WorkspaceContext): Result {
  const disabled = disabledMethods(ctx);
  const methods: MethodDescriptor[] = DEPRECIATION_METHODS.map((key) => {
    const meta = METHOD_LABEL[key] ?? { requiresUnits: false, requiresRate: false };
    return {
      key,
      labelKey: `assets.depreciation.method.${key}`,
      descriptionKey: `assets.depreciation.methodDesc.${key}`,
      requiresUnits: meta.requiresUnits,
      requiresRate: meta.requiresRate,
      enabled: !disabled.has(key),
    };
  });
  return ok({ methods });
}

export interface SetMethodEnabledInput {
  methodKey?: string;
  enabled?: boolean;
  idempotencyKey?: string;
}

/** Enable or disable a method for this workspace. The `none` method can never be disabled (a
 * non-depreciating asset must always be expressible). Idempotent on the (workspace, method) row. */
export function setMethodEnabled(ctx: WorkspaceContext, input: SetMethodEnabledInput): Result {
  const key = typeof input.methodKey === 'string' ? input.methodKey : '';
  if (!hasDepreciationMethod(key)) {
    return err('unknown_method', { methodKey: input.methodKey, allowed: [...DEPRECIATION_METHODS] });
  }
  if (typeof input.enabled !== 'boolean') return err('invalid_input', { field: 'enabled' });
  if (key === 'none' && input.enabled === false) {
    return err('method_locked', { methodKey: key, reason: 'none_is_always_available' });
  }

  const run = (): Result => {
    ctx.store.db
      .prepare(
        `INSERT INTO asset_depreciation_method_setting (workspace_id, method_key, enabled, updated_at, updated_by)
           VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (workspace_id, method_key)
           DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      )
      .run(ctx.workspaceId, key, input.enabled ? 1 : 0, ctx.clock.now(), ctx.actor);
    const disabled = disabledMethods(ctx);
    return ok({
      method: {
        key,
        labelKey: `assets.depreciation.method.${key}`,
        descriptionKey: `assets.depreciation.methodDesc.${key}`,
        requiresUnits: METHOD_LABEL[key]?.requiresUnits ?? false,
        requiresRate: METHOD_LABEL[key]?.requiresRate ?? false,
        enabled: !disabled.has(key),
      },
    });
  };

  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'asset_depr_method_set_enabled', run);
  }
  return run();
}

// --- Preview + schedule (pure reads over the engine) -----------------------------------------------

function normaliseProRata(v: unknown): ProRataConvention | undefined {
  return v === 'actual_days' || v === 'full_period' ? v : undefined;
}

/** Read a plain string-keyed record from an untrusted input value, or undefined. */
function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

export interface PreviewInput {
  period?: string;
  assetIds?: unknown;
  proRata?: string;
  unitsByAsset?: unknown;
  /** assetId -> { decliningRateBp?, totalEstimatedUnits? }; the H01-gap override (see header). */
  paramsByAsset?: unknown;
  daysByAsset?: unknown;
}

/**
 * US-H03.5, the side-effect-free preview. Computes the period result for a list of asset ids (or every
 * active asset in the workspace when none are given). A foreign or unknown asset id is rejected with
 * `not_found` before any calculation, so numbers never leak across a tenant boundary (US-H03.7).
 */
export function previewDepreciation(ctx: WorkspaceContext, input: PreviewInput): Result {
  if (!isPeriod(input.period)) return err('invalid_period', { period: input.period });
  const period = input.period as string;
  const proRata = normaliseProRata(input.proRata);

  const units = asRecord(input.unitsByAsset) ?? {};
  const params = asRecord(input.paramsByAsset) ?? {};
  const days = asRecord(input.daysByAsset) ?? {};

  let rows: AssetDeprRow[];
  if (input.assetIds !== undefined) {
    if (!Array.isArray(input.assetIds)) return err('invalid_input', { field: 'assetIds' });
    rows = [];
    for (const raw of input.assetIds) {
      if (typeof raw !== 'string' || raw.length === 0) return err('invalid_input', { field: 'assetIds' });
      const row = readAssetRow(ctx, raw);
      if (row === undefined) return err('not_found', { assetId: raw }); // §H-TENANT: foreign id, no leak.
      rows.push(row);
    }
  } else {
    // The whole workspace's non-terminal register (draft/active/fully_depreciated), never archived/disposed.
    rows = ctx.store.db
      .prepare(
        `SELECT * FROM asset WHERE workspace_id = ? AND status NOT IN ('archived', 'disposed') ORDER BY number`,
      )
      .all(ctx.workspaceId) as AssetDeprRow[];
  }

  const results = rows.map((row) => {
    const override = readOverride(params[row.id]);
    const snap = toSnapshot(row, override);
    const ctxCalc: CalcContext = { period };
    if (proRata !== undefined) ctxCalc.proRata = proRata;
    const u = units[row.id];
    if (typeof u === 'number') ctxCalc.unitsProduced = u;
    const d = days[row.id];
    if (typeof d === 'number') ctxCalc.daysInService = d;
    return calculateDepreciation(snap, ctxCalc);
  });
  // calculateDepreciationBatch is the same map; used directly by H04. Referenced here so the batch
  // entry point stays part of the exercised surface.
  void calculateDepreciationBatch;
  return ok({ period, results });
}

function readOverride(v: unknown): ParamOverride | undefined {
  const rec = asRecord(v);
  if (rec === undefined) return undefined;
  const out: ParamOverride = {};
  if (typeof rec.decliningRateBp === 'number') out.decliningRateBp = rec.decliningRateBp;
  if (typeof rec.totalEstimatedUnits === 'number') out.totalEstimatedUnits = rec.totalEstimatedUnits;
  return out;
}

export interface ScheduleInput {
  assetId?: string;
  fromPeriod?: string;
  toPeriod?: string;
  proRata?: string;
  unitsForecast?: unknown;
  params?: unknown;
}

/**
 * US-H03.6, the forward schedule for one asset. Pure and tenant-scoped: a foreign id is `not_found`.
 * A units-of-production asset needs a `unitsForecast` map or the projection comes back incomplete with
 * a `units_forecast_required` warning rather than inventing usage.
 */
export function scheduleDepreciation(ctx: WorkspaceContext, input: ScheduleInput): Result {
  if (typeof input.assetId !== 'string' || input.assetId.length === 0) {
    return err('invalid_input', { field: 'assetId' });
  }
  if (!isPeriod(input.fromPeriod)) return err('invalid_period', { period: input.fromPeriod, field: 'fromPeriod' });
  if (input.toPeriod !== undefined && !isPeriod(input.toPeriod)) {
    return err('invalid_period', { period: input.toPeriod, field: 'toPeriod' });
  }
  const row = readAssetRow(ctx, input.assetId);
  if (row === undefined) return err('not_found', { assetId: input.assetId });

  const forecastRec = asRecord(input.unitsForecast);
  const unitsForecast = forecastRec
    ? Object.fromEntries(
        Object.entries(forecastRec).filter(([, v]) => typeof v === 'number') as [string, number][],
      )
    : undefined;

  const snap = toSnapshot(row, readOverride(input.params));
  const options: ScheduleOptions = {};
  if (unitsForecast !== undefined) options.unitsForecast = unitsForecast;
  const pr = normaliseProRata(input.proRata);
  if (pr !== undefined) options.proRata = pr;
  const projection = projectDepreciationSchedule(snap, input.fromPeriod as string, input.toPeriod, options);
  return ok({
    assetId: row.id,
    method: row.depreciation_method,
    complete: projection.complete,
    warning: projection.warning,
    lines: projection.lines,
  });
}

// Re-export the pure helpers a caller (H04, tests) reaches for through this module.
export { daysInPeriod };
