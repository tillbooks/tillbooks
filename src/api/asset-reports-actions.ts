/**
 * H09, the fixed-asset REPORTS verb surface, spread into `ACTIONS` as ONE line (the `asset-actions` /
 * `maintenance-actions` precedent), so several agents appending to the append-only registry at once
 * collide over a line rather than a block. It is its OWN module rather than an extension of
 * `asset-actions.ts` so the asset-cluster branches never contend for that file.
 *
 * The six verbs are the H09 READ set: register, depreciation forecast, disposal summary, acquisition
 * summary, NBV summary and end-of-life list. Reconciliation and per-asset transaction history are NOT
 * here: they already shipped inside H07 (`asset_reconciliation_report` / `asset_ledger_get`) and are
 * re-used, not re-minted. Every verb is a PURE READ: it posts nothing, opens no write transaction and
 * carries no idempotencyKey, and all six advertise `readOnlyHint` (kind='read'). As with the sibling
 * action modules the helpers arrive as a parameter rather than an import, so the module graph stays
 * acyclic: `registry.ts` imports this file and this file must not import it back. Every field is
 * camelCase and maps straight through to the engine verb (the boundary is `additionalProperties: true`).
 */

import type { ActionDef, ActionInput, JsonSchema } from './registry.js';
import type { WorkspaceContext } from '../core/context.js';
import type { Result } from '../core/result.js';
import {
  assetRegisterReport,
  assetDepreciationForecast,
  assetDisposalSummary,
  assetAcquisitionSummary,
  assetNbvSummary,
  assetEndOfLifeList,
} from '../core/assets/index.js';

export interface AssetReportsActionHelpers {
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

/** The H09 report verbs, in append order (register, forecast, disposals, acquisitions, nbv, eol). */
export function assetReportsActions(h: AssetReportsActionHelpers): readonly ActionDef[] {
  const { ctxAction, ctxSchema, STR, INT, BOOL } = h;
  const STR_LIST = { type: 'array', items: STR } as const;

  const REGISTER_FILTER = {
    type: 'object',
    properties: {
      status: STR_LIST,
      categoryIds: STR_LIST,
      locationIds: STR_LIST,
      acquisitionYearFrom: STR,
      acquisitionYearTo: STR,
      costMinRappen: INT,
      costMaxRappen: INT,
      responsibleUserId: STR,
      q: STR,
    },
  } as const;

  return [
    ctxAction(
      'asset_register_report',
      'read',
      'The complete, filterable fixed-asset register (H09, US-H09.1): one row per asset (number, name, category code/name, status, acquisitionDate, acquisitionCostRappen, accumulatedDeprRappen, netBookValueRappen, residualValueRappen, method, usefulLifeMonths, location, responsible, serial/barcode, lastDepreciationPeriod, disposedAt) with a totals footer (count, sum cost, sum accum, sum NBV) computed over the WHOLE filtered set, not just the returned page. filter carries status[] (default hides archived), categoryIds[], locationIds[], acquisitionYearFrom/To (YYYY), costMinRappen/costMaxRappen, responsibleUserId and a case-insensitive q over number/name/serial/barcode/notes. Optional columns subset (id/number always kept), sort ({ field, dir }) over a whitelisted column, and cursor/limit pagination (default 500, max 5000; follow nextCursor until absent). An empty match is a success ({ rows: [], zero totals, message: "no_assets_matching" }), never an error. Pure read, §H-TENANT.',
      ctxSchema({
        filter: REGISTER_FILTER,
        columns: STR_LIST,
        sort: { type: 'object', properties: { field: STR, dir: STR } },
        cursor: STR,
        limit: INT,
      }),
      (ctx, input) => assetRegisterReport(ctx, as(input)),
    ),
    ctxAction(
      'asset_depreciation_forecast',
      'read',
      'A multi-period depreciation forecast (H09, US-H09.2) re-using the SAME pure H03 calculators the preview/schedule verbs use, so a forecast line never disagrees with a live asset_depreciation_schedule. fromPeriod/toPeriod are YYYY-MM inclusive; the window is at most 60 months and a reversed or over-long window is invalid_period_range. groupBy is none (default) | category | location (cost_center is not an asset-master dimension in Phase 1: invalid_input). filter narrows by categoryIds/locationIds/assetIds (a foreign assetId is not_found before any projection). Returns an ordered periods list, each with totalAmountRappen and an optional byGroup breakdown, a totalProjectedRappen, assetsReachingResidual, and (with includeDetail:true) per-asset ScheduleLine detail. A units_of_production asset with no unitsForecast contributes zero and raises a production_data_required warning rather than inventing usage. Writes nothing; deterministic for a given snapshot.',
      ctxSchema(
        {
          fromPeriod: STR,
          toPeriod: STR,
          groupBy: STR,
          filter: { type: 'object', properties: { categoryIds: STR_LIST, locationIds: STR_LIST, assetIds: STR_LIST } },
          includeDetail: BOOL,
          unitsForecast: { type: 'object' },
        },
        ['fromPeriod', 'toPeriod'],
      ),
      (ctx, input) => assetDepreciationForecast(ctx, as(input)),
    ),
    ctxAction(
      'asset_disposal_summary',
      'read',
      'The disposal gain/loss pack for a date range (H09, US-H09.4): every H06 disposal posted between fromDate and toDate (ISO YYYY-MM-DD, inclusive) with its asset number/name, disposalDate, originalCostRappen, accumDeprAtDisposalRappen, nbvAtDisposalRappen, proceedsRappen, gainLossRappen (signed: proceeds minus book value, so positive is a gain), journalEntryId and reason (the disposal description). Footer totals: count, sum proceeds, sum gain, sum loss, net gain/loss. Optional filter by categoryIds, locationIds and a case-insensitive reason substring. No disposals in range is an empty success, not an error. Pure read over the append-only sub-ledger, §H-TENANT.',
      ctxSchema(
        {
          fromDate: STR,
          toDate: STR,
          filter: { type: 'object', properties: { categoryIds: STR_LIST, locationIds: STR_LIST, reason: STR } },
        },
        ['fromDate', 'toDate'],
      ),
      (ctx, input) => assetDisposalSummary(ctx, as(input)),
    ),
    ctxAction(
      'asset_acquisition_summary',
      'read',
      'What was capitalised in a period (H09, US-H09.5): every acquisition and additional-capitalisation event (H02) posted between fromDate and toDate (ISO, inclusive) with its asset number/name, acquisitionDate, costRappen (the capitalised delta), category code/name, the GL asset account (id/number/name), the source (source_document_type or "manual"), sourceDocumentId and journalEntryId. Footer totals: count and sum cost. Optional filter by categoryIds and locationIds. Empty range is an empty success. Pure read, §H-TENANT.',
      ctxSchema(
        {
          fromDate: STR,
          toDate: STR,
          filter: { type: 'object', properties: { categoryIds: STR_LIST, locationIds: STR_LIST } },
        },
        ['fromDate', 'toDate'],
      ),
      (ctx, input) => assetAcquisitionSummary(ctx, as(input)),
    ),
    ctxAction(
      'asset_nbv_summary',
      'read',
      'A dimensional NBV / cost roll-up (H09, US-H09.7): grouped rows (key, count, sumCostRappen, sumAccumRappen, sumNbvRappen) plus a grandTotal. groupBy is category | location | status | method (cost_center is not an asset-master dimension in Phase 1: invalid_input). Non-disposed assets only by default; includeDisposed:true folds disposed assets in. Optional register filter (the asset_register_report filter shape) narrows the base set. Pure read over the asset master, §H-TENANT.',
      ctxSchema(
        { groupBy: STR, filter: REGISTER_FILTER, includeDisposed: BOOL },
        ['groupBy'],
      ),
      (ctx, input) => assetNbvSummary(ctx, as(input)),
    ),
    ctxAction(
      'asset_end_of_life_list',
      'read',
      'Assets at or approaching end of life (H09, US-H09.8): with status="approaching" (default) it projects each active, depreciable asset forward from the current period and returns those whose remaining life falls inside withinMonths (default 12, capped 60), each with current NBV, residual, remainingMonths and the next forecasted depreciation amount, ordered soonest first. With status="fully_depreciated" it lists the already-fully-depreciated assets. Re-uses the pure H03 projector; writes nothing. §H-TENANT.',
      ctxSchema({ withinMonths: INT, status: STR }),
      (ctx, input) => assetEndOfLifeList(ctx, as(input)),
    ),
  ];
}
