/**
 * The fixed-asset verb surface, spread into `ACTIONS` as ONE line (the `fxActions` / `itemActions`
 * precedent), so several agents appending to the append-only registry at once collide over a line
 * rather than a block. H00's six `asset_category_*` verbs come first; H01's six `asset_*` master
 * verbs (create/update/get/list/search/archive) come after them, in that append order.
 *
 * As with `item-actions.ts`, the helpers arrive as a parameter rather than an import, so the module
 * graph stays acyclic: `registry.ts` imports this file and this file must not import it back. Every
 * field is camelCase and maps straight through to the engine verb (the boundary is
 * `additionalProperties: true`, validated in the engine). Three writes (create/update/archive) carry
 * `idempotencyKey` (§H-IDEMPOTENT); the three reads advertise `readOnlyHint`.
 */

import type { ActionDef, ActionInput, JsonSchema } from './registry.js';
import type { WorkspaceContext } from '../core/context.js';
import type { Result } from '../core/result.js';
import {
  createAssetCategory,
  updateAssetCategory,
  archiveAssetCategory,
  listAssetCategories,
  getAssetCategory,
  resolveAssetCategoryDefaults,
  createAsset,
  updateAsset,
  getAsset,
  listAsset,
  searchAsset,
  archiveAsset,
  previewDepreciation,
  scheduleDepreciation,
  listDepreciationMethods,
  setMethodEnabled,
  assetAcquire,
  assetAddCapitalisation,
  assetTransactionList,
  assetTransactionGet,
  createAssetLocation,
  updateAssetLocation,
  archiveAssetLocation,
  listAssetLocation,
  getAssetLocation,
  assetTransfer,
  assetTransferHistory,
  assetDepreciationRunCreate,
  assetDepreciationRunPost,
  assetDepreciationRunReverse,
  assetDepreciationRunGet,
  assetDepreciationRunList,
  assetDispose,
  assetDisposalPreview,
  assetDisposalGet,
  assetLedgerGet,
  assetLedgerList,
  assetOpeningBalance,
  assetReconciliationReport,
  assetReconciliationCheck,
} from '../core/assets/index.js';

export interface AssetActionHelpers {
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

/** The H00 verbs, in append order. */
export function assetActions(h: AssetActionHelpers): readonly ActionDef[] {
  const { ctxAction, ctxSchema, STR, INT, BOOL } = h;

  /** One value or several, for a list filter whose verb accepts both. Declared with `anyOf` rather
   * than a bare `STR`, because the dispatcher's declared-type gate rejects an array against a string
   * before the verb runs: the engine has always taken an array, and only the schema said otherwise. */
  const STR_OR_LIST = { anyOf: [{ type: 'string' }, { type: 'array', items: STR }] } as const;

  const CATEGORY_PATCH = {
    type: 'object',
    properties: {
      name: STR,
      description: STR,
      depreciationMethod: STR,
      usefulLifeMonths: INT,
      residualValuePct: INT,
      residualValueRappen: INT,
      glAssetAccountId: STR,
      glAccumDeprAccountId: STR,
      glDeprExpenseAccountId: STR,
      defaultCostCenterId: STR,
    },
  } as const;

  // The H01 update patch. Descriptive fields plus the financial baseline: the engine allows the
  // baseline only while the asset is draft (financial_fields_locked otherwise), the schema stays open
  // so a draft edit and a locked-field-rejection are both expressible on one verb.
  const ASSET_PATCH = {
    type: 'object',
    properties: {
      name: STR,
      description: STR,
      acquisitionDate: STR,
      acquisitionCostRappen: INT,
      depreciationMethod: STR,
      usefulLifeMonths: INT,
      residualValuePct: INT,
      residualValueRappen: INT,
      glAssetAccountId: STR,
      glAccumDeprAccountId: STR,
      glDeprExpenseAccountId: STR,
      locationId: STR,
      responsibleUserId: STR,
      serialNumber: STR,
      barcode: STR,
      manufacturer: STR,
      model: STR,
      warrantyUntil: STR,
      notes: STR,
    },
  } as const;

  return [
    ctxAction(
      'asset_category_create',
      'write',
      'Create a fixed-asset category carrying the defaults every asset created under it inherits (H01): a depreciation method (straight_line | declining_balance | units_of_production | none), a useful life in months, a residual value (basis points or absolute Rappen), the three GL accounts (cost=asset, accumulated depreciation=asset/liability contra, depreciation expense=expense), and an optional default cost centre. code is 1-20 chars, unique per workspace case-insensitively (duplicate_code). Wrong account types are refused with invalid_account_type before any write.',
      ctxSchema(
        {
          code: STR,
          name: STR,
          description: STR,
          depreciationMethod: STR,
          usefulLifeMonths: INT,
          residualValuePct: INT,
          residualValueRappen: INT,
          glAssetAccountId: STR,
          glAccumDeprAccountId: STR,
          glDeprExpenseAccountId: STR,
          defaultCostCenterId: STR,
          idempotencyKey: STR,
        },
        ['code', 'name', 'glAssetAccountId', 'glAccumDeprAccountId', 'glDeprExpenseAccountId', 'idempotencyKey'],
      ),
      (ctx, input) => createAssetCategory(ctx, as(input)),
    ),
    ctxAction(
      'asset_category_update',
      'write',
      'Edit a fixed-asset category through a patch object. The same validation as create applies (account types, useful life, residual bounds); code is immutable through this verb. Only the fields present in patch change.',
      ctxSchema({ categoryId: STR, patch: CATEGORY_PATCH, idempotencyKey: STR }, ['categoryId', 'idempotencyKey']),
      (ctx, input) => updateAssetCategory(ctx, as(input)),
    ),
    ctxAction(
      'asset_category_archive',
      'write',
      'Soft-archive a category (active=false): it leaves the default picker but stays resolvable for historical assets. Refused with category_in_use while any asset (even disposed) still references it. Deletion is never offered (a category must stay resolvable for its assets whole depreciable life).',
      ctxSchema({ categoryId: STR, idempotencyKey: STR }, ['categoryId', 'idempotencyKey']),
      (ctx, input) => archiveAssetCategory(ctx, as(input)),
    ),
    ctxAction(
      'asset_category_list',
      'read',
      'List the workspace fixed-asset categories, ordered by code. Optional active filter (true = only live, false = only archived) and a case-insensitive search over code and name. Accepts a savedViewId (G00 saved-view seam).',
      ctxSchema({ active: BOOL, search: STR, savedViewId: STR }),
      (ctx, input) => listAssetCategories(ctx, as(input)),
    ),
    ctxAction(
      'asset_category_get',
      'read',
      'Read one fixed-asset category by id, archived or not.',
      ctxSchema({ categoryId: STR }, ['categoryId']),
      (ctx, input) => getAssetCategory(ctx, as(input)),
    ),
    ctxAction(
      'asset_category_resolve_defaults',
      'read',
      'Resolve the FULL default set for a category so an agent can create an asset (H01) with no further questions: the depreciation trio, the three GL accounts as id+number+name, and the optional cost centre. An archived category is refused with category_archived (choose another or un-archive first).',
      ctxSchema({ categoryId: STR }, ['categoryId']),
      (ctx, input) => resolveAssetCategoryDefaults(ctx, as(input)),
    ),

    // --- H01, the Asset Master ------------------------------------------------------------------
    ctxAction(
      'asset_create',
      'write',
      'Create a capitalised fixed asset FROM a category (H00), inheriting its depreciation method, useful life, residual rule and three GL accounts; only name, acquisitionDate and acquisitionCostRappen (Rappen, >0) are required. Any of depreciationMethod/usefulLifeMonths/residualValuePct/residualValueRappen/the three GL account ids may OVERRIDE the inherited default at creation. number is optional (a unique FA-#### is generated if omitted; a manual one is unique per workspace case-insensitively, else duplicate_number). An archived category is refused with category_archived. The asset is created in status=draft; its financial baseline is immutable once a posted acquisition (H02) moves it out of draft.',
      ctxSchema(
        {
          categoryId: STR,
          number: STR,
          name: STR,
          description: STR,
          acquisitionDate: STR,
          acquisitionCostRappen: INT,
          depreciationMethod: STR,
          usefulLifeMonths: INT,
          decliningRateBp: INT,
          totalEstimatedUnits: INT,
          residualValuePct: INT,
          residualValueRappen: INT,
          glAssetAccountId: STR,
          glAccumDeprAccountId: STR,
          glDeprExpenseAccountId: STR,
          locationId: STR,
          responsibleUserId: STR,
          serialNumber: STR,
          barcode: STR,
          manufacturer: STR,
          model: STR,
          warrantyUntil: STR,
          notes: STR,
          idempotencyKey: STR,
        },
        ['categoryId', 'name', 'acquisitionDate', 'acquisitionCostRappen', 'idempotencyKey'],
      ),
      (ctx, input) => createAsset(ctx, as(input)),
    ),
    ctxAction(
      'asset_update',
      'write',
      'Edit an asset through a patch object. Descriptive fields (name, description, location, responsible, serial, barcode, manufacturer, model, warranty, notes) change freely while the asset is non-terminal. The financial baseline (acquisitionDate, acquisitionCostRappen, the depreciation trio, the three GL accounts) may change ONLY while the asset is still draft: once a posted acquisition or depreciation exists, any such field in the patch is refused with financial_fields_locked and nothing is written (use a correction flow instead). A disposed or archived asset is refused with asset_terminal.',
      ctxSchema({ assetId: STR, patch: ASSET_PATCH, idempotencyKey: STR }, ['assetId', 'idempotencyKey']),
      (ctx, input) => updateAsset(ctx, as(input)),
    ),
    ctxAction(
      'asset_get',
      'read',
      'Read one fixed asset by id, including its resolved financial baseline, the three GL accounts it will post against, status and the convenience columns (accumulated depreciation, net book value) later specs maintain.',
      ctxSchema({ assetId: STR }, ['assetId']),
      (ctx, input) => getAsset(ctx, as(input)),
    ),
    ctxAction(
      'asset_list',
      'read',
      'List the workspace fixed-asset register, ordered by number. Structured filters: categoryId, status, locationId, responsibleUserId, acquisitionYear (YYYY). Archived assets are hidden unless includeArchived=true or status is given explicitly. Accepts a savedViewId (G00 saved-view seam).',
      ctxSchema({
        categoryId: STR,
        status: STR,
        locationId: STR,
        responsibleUserId: STR,
        acquisitionYear: STR,
        includeArchived: BOOL,
        savedViewId: STR,
      }),
      (ctx, input) => listAsset(ctx, as(input)),
    ),
    ctxAction(
      'asset_search',
      'read',
      'Full-text search the register over number, name, serial number, barcode and notes (case-insensitive substring). An empty query returns no rows.',
      ctxSchema({ query: STR }, ['query']),
      (ctx, input) => searchAsset(ctx, as(input)),
    ),
    ctxAction(
      'asset_archive',
      'write',
      'Soft-archive an asset (status=archived): it leaves the active register but stays readable. Refused with asset_in_use while the asset is active or fully_depreciated (an asset the ledger still depends on cannot be hidden; dispose it via H06 instead). Only a draft or already-terminal asset may be archived.',
      ctxSchema({ assetId: STR, idempotencyKey: STR }, ['assetId', 'idempotencyKey']),
      (ctx, input) => archiveAsset(ctx, as(input)),
    ),

    // --- H03, depreciation methods & engine -----------------------------------------------------
    // Pure, side-effect-free calculators (OP12): amounts are computed FROM the H01 asset master and
    // posted by NOBODY here (H04 posts). The three reads advertise readOnlyHint; the one write is the
    // per-workspace method-enablement flag.
    ctxAction(
      'asset_depreciation_preview',
      'read',
      'Preview the depreciation amount for period (YYYY-MM) for a list of assetIds, or for every active asset in the workspace when assetIds is omitted. Returns one DepreciationResult per asset: amountRappen (integer Rappen, half-away-from-zero), isFinal (this period lands NBV exactly on residual), projectedNbvAfterRappen (never below residual), and a reason when zero (already_at_residual | period_already_processed | non_depreciable | missing_production_data | unknown_method). Writes NOTHING and creates no journal (H04 posts). proRata is full_period (default) or actual_days; unitsByAsset maps assetId to the units produced this period (units_of_production); paramsByAsset carries per-asset decliningRateBp / totalEstimatedUnits overrides. A foreign or unknown assetId is rejected with not_found before any calculation (§H-TENANT).',
      ctxSchema(
        {
          period: STR,
          assetIds: { type: 'array', items: STR },
          proRata: STR,
          unitsByAsset: { type: 'object' },
          paramsByAsset: { type: 'object' },
          daysByAsset: { type: 'object' },
        },
        ['period'],
      ),
      (ctx, input) => previewDepreciation(ctx, as(input)),
    ),
    ctxAction(
      'asset_depreciation_schedule',
      'read',
      'Project the full remaining depreciation schedule for ONE asset from fromPeriod (YYYY-MM, inclusive) to an optional toPeriod, using the same pure engine as the preview so a line never disagrees with a live preview. Returns ordered ScheduleLine rows (period, amountRappen, projectedAccumRappen, projectedNbvRappen, isFinal); the final line residual-adjusts so the lines sum to exactly cost minus residual. A units_of_production asset needs a unitsForecast map (period to units) or the projection returns incomplete with a units_forecast_required warning rather than inventing usage. Writes nothing; a foreign assetId is not_found (§H-TENANT).',
      ctxSchema(
        {
          assetId: STR,
          fromPeriod: STR,
          toPeriod: STR,
          proRata: STR,
          unitsForecast: { type: 'object' },
          params: { type: 'object' },
        },
        ['assetId', 'fromPeriod'],
      ),
      (ctx, input) => scheduleDepreciation(ctx, as(input)),
    ),
    ctxAction(
      'asset_depreciation_methods',
      'read',
      'List the registered depreciation methods (straight_line | declining_balance | units_of_production | none) with this workspace enablement flags. Each descriptor carries labelKey, descriptionKey, requiresUnits, requiresRate and enabled. A disabled method is hidden from the H00 category / H01 asset method pickers. Read-only.',
      ctxSchema({}),
      (ctx) => listDepreciationMethods(ctx),
    ),
    ctxAction(
      'asset_depreciation_method_set_enabled',
      'write',
      'Enable or disable a depreciation method for this workspace (a setup action). Absence means enabled, so this only records a method switched off. The none method can never be disabled (a non-depreciating asset must always be expressible), refused with method_locked. An unknown methodKey is unknown_method. Idempotent on the (workspace, method) row.',
      ctxSchema({ methodKey: STR, enabled: BOOL, idempotencyKey: STR }, ['methodKey', 'enabled', 'idempotencyKey']),
      (ctx, input) => setMethodEnabled(ctx, as(input)),
    ),
    // --- H02, Asset Acquisition (MONEY PATH: posts the capitalisation journal) -------------------
    ctxAction(
      'asset_acquire',
      'write',
      'Record the PRIMARY acquisition of a draft fixed asset (H02): the first financial event, which capitalises the asset. In ONE atomic transaction it writes a sub-ledger asset_transaction (type=acquisition) AND posts the balanced GL journal via A02 (Dr the asset GL account inherited from the category, Cr the chosen creditAccountId, for acquisitionCostRappen), then moves the asset draft -> active and confirms its cost base. creditAccountId must be a real asset/liability/equity account (credit_account_wrong_type otherwise; invalid_credit_account when missing or foreign). An optional residualValueRappen (0..cost) overrides the residual; optional costCenterId stamps both legs; optional source (manual|vendor_bill|project|opening) + sourceDocumentId link the event (source_document_not_found if the id does not resolve). Refused with invalid_cost (cost <= 0), asset_not_acquirable (disposed/archived), already_acquired (a primary acquisition already exists), invalid_residual, or period_locked (date in a hard-locked A03 period). After success the H01 financial-field lock is active. Idempotent on idempotencyKey: a replay returns the original {asset, transaction, journalEntry} and posts no second entry.',
      ctxSchema(
        {
          assetId: STR,
          date: STR,
          acquisitionCostRappen: INT,
          creditAccountId: STR,
          residualValueRappen: INT,
          costCenterId: STR,
          source: STR,
          sourceDocumentId: STR,
          description: STR,
          idempotencyKey: STR,
        },
        ['assetId', 'date', 'acquisitionCostRappen', 'creditAccountId', 'idempotencyKey'],
      ),
      (ctx, input) => assetAcquire(ctx, as(input)),
    ),
    ctxAction(
      'asset_add_capitalisation',
      'write',
      'Capitalise ADDITIONAL cost onto an already-acquired asset (H02): an improvement or major overhaul. In ONE atomic transaction it writes a sub-ledger asset_transaction (type=additional_capitalisation) AND posts the same balanced Dr asset / Cr creditAccountId pattern via A02 for amountRappen, then raises the asset acquisition_cost_rappen and net_book_value_rappen by that amount (accumulated depreciation is left unchanged; residual and useful life are untouched). Requires a live asset carrying a primary acquisition (not_acquired otherwise; asset_not_acquirable when disposed/archived). Same credit-account, source-document and period rules as asset_acquire. Idempotent on idempotencyKey.',
      ctxSchema(
        {
          assetId: STR,
          date: STR,
          amountRappen: INT,
          creditAccountId: STR,
          costCenterId: STR,
          source: STR,
          sourceDocumentId: STR,
          description: STR,
          idempotencyKey: STR,
        },
        ['assetId', 'date', 'amountRappen', 'creditAccountId', 'idempotencyKey'],
      ),
      (ctx, input) => assetAddCapitalisation(ctx, as(input)),
    ),
    ctxAction(
      'asset_transaction_list',
      'read',
      'List the financial-event history of one asset (H02), ordered oldest first: every asset_transaction row with its type, date, capitalised amount (deltaCostRappen), the GL journal entry it posted (journalEntryId) and any source-document link. Optional type filter (acquisition | additional_capitalisation).',
      ctxSchema({ assetId: STR, type: STR }, ['assetId']),
      (ctx, input) => assetTransactionList(ctx, as(input)),
    ),
    ctxAction(
      'asset_transaction_get',
      'read',
      'Read one fixed-asset sub-ledger transaction by id (H02), including the GL journal entry it posted and its source-document link.',
      ctxSchema({ id: STR }, ['id']),
      (ctx, input) => assetTransactionGet(ctx, as(input)),
    ),

    // --- H05, Asset Transfer & Location (NON-POSTING: no journal entry is ever created) ----------
    ctxAction(
      'asset_location_create',
      'write',
      'Create a workspace fixed-asset location (a physical place assets live: a hall, a floor, a branch). code is 1-30 chars, unique per workspace case-insensitively (duplicate_code); an optional parentId nests it under another location for a light hierarchy (a foreign or missing parent is not_found). Locations are the primary filter dimension of the register and the target of asset_transfer.',
      ctxSchema(
        { code: STR, name: STR, description: STR, parentId: STR, idempotencyKey: STR },
        ['code', 'name', 'idempotencyKey'],
      ),
      (ctx, input) => createAssetLocation(ctx, as(input)),
    ),
    ctxAction(
      'asset_location_update',
      'write',
      'Edit a fixed-asset location through a patch object (name, description, parentId). code is immutable through this verb. Setting a parentId that would close a hierarchy loop is refused with location_cycle; parentId null or "" clears it back to a root location. Only the fields present in patch change.',
      ctxSchema(
        { locationId: STR, patch: { type: 'object', properties: { name: STR, description: STR, parentId: STR } }, idempotencyKey: STR },
        ['locationId', 'idempotencyKey'],
      ),
      (ctx, input) => updateAssetLocation(ctx, as(input)),
    ),
    ctxAction(
      'asset_location_archive',
      'write',
      'Soft-archive a location (active=false): it leaves the transfer/asset pickers but stays resolvable for historical assets. Refused with location_in_use while any non-disposed asset still references it (move those assets away first). Deletion is never offered (a location must stay resolvable for the transfer history that names it). Idempotent: archiving an already-archived location succeeds and writes nothing.',
      ctxSchema({ locationId: STR, idempotencyKey: STR }, ['locationId', 'idempotencyKey']),
      (ctx, input) => archiveAssetLocation(ctx, as(input)),
    ),
    ctxAction(
      'asset_location_list',
      'read',
      'List the workspace fixed-asset locations, ordered by code. Optional filters: active (true = only live, false = only archived), parentId (a location id, or null for the roots), and a case-insensitive search over code and name. Accepts a savedViewId (G00 saved-view seam).',
      ctxSchema({ active: BOOL, parentId: STR, search: STR, savedViewId: STR }),
      (ctx, input) => listAssetLocation(ctx, as(input)),
    ),
    ctxAction(
      'asset_location_get',
      'read',
      'Read one fixed-asset location by id, archived or not.',
      ctxSchema({ locationId: STR }, ['locationId']),
      (ctx, input) => getAssetLocation(ctx, as(input)),
    ),
    ctxAction(
      'asset_transfer',
      'write',
      'Transfer one or many active fixed assets to a new location and/or a new responsible person (custodian). NON-POSTING by design: it writes one immutable asset_transfer history row per asset (capturing the old and new location/responsible, the effective date and an optional reason) and updates each asset location_id / responsible_user_id, but changes NO financial field and creates NO journal entry. assetIds is 1..N (bulk supported, all-or-nothing); at least one of toLocationId / toResponsibleUserId must be supplied (nothing_to_transfer otherwise). Refused with location_inactive (target location archived), asset_not_transferable (any selected asset is disposed or archived, listing the offenders), or not_found (a foreign asset or location, §H-TENANT). Idempotent on idempotencyKey: a replay returns the original {transactions, assets, summary} and writes no second history row.',
      ctxSchema(
        {
          assetIds: { type: 'array', items: STR },
          toLocationId: STR,
          toResponsibleUserId: STR,
          effectiveDate: STR,
          reason: STR,
          idempotencyKey: STR,
        },
        ['assetIds', 'effectiveDate', 'idempotencyKey'],
      ),
      (ctx, input) => assetTransfer(ctx, as(input)),
    ),
    ctxAction(
      'asset_transfer_history',
      'read',
      'List the complete transfer history of one asset (H05), ordered oldest first: every asset_transfer row with its effective date, from/to location, from/to responsible person and reason. Read-only; no financial figure is ever part of a transfer.',
      ctxSchema({ assetId: STR }, ['assetId']),
      (ctx, input) => assetTransferHistory(ctx, as(input)),
    ),

    // --- H04, Depreciation Run & Posting (MONEY PATH: posts the period-end depreciation journal) ----
    ctxAction(
      'asset_depreciation_run_create',
      'write',
      'Create a DRAFT depreciation run for a period (H04): calculate the depreciation for every eligible asset via the H03 engine and persist a run header (status=draft) plus one line per asset that returned amount > 0, so a bookkeeper can review the proposed expense before anything hits the books. Eligible = status active/fully_depreciated, method != none, accumulated depreciation below cost minus residual, last_depreciation_period null or before the target period, not disposed. Optional filters narrow the set: assetIds (an explicit subset), categoryId, costCenterId. unitsByAsset maps assetId to the WHOLE units produced this period and is what makes a units_of_production asset depreciable at all (TILL captures no production data of its own, so the run carries it; same shape as asset_depreciation_preview, and values must be non-negative safe integers up to 1e12 or the create is invalid_input). skipped[] reports assets that produced NO line, as {assetId, assetNumber, reason}: on an EXPLICIT assetIds list every named asset that produced no line is reported (non_depreciable | asset_terminal | already_at_residual | period_already_processed | filtered_out | missing_production_data | missing_units_estimate | zero_amount), because naming an asset is an instruction about that asset; on a SWEEP the eligible register IS the selection, so only assets that reached the calculation are reported (missing_production_data | missing_units_estimate | zero_amount). A units_of_production asset named EXPLICITLY in assetIds is refused, not merely reported, when the input can be corrected: missing_production_data (no figure supplied) or missing_units_estimate (the asset carries no totalEstimatedUnits, so there is no denominator to allocate over). Nothing is written in either case. postingGranularity is detailed (one expense + one accum line per asset, the default) or summarised (grouped by account + cost centre); the per-asset lines exist either way for the sub-ledger audit. period is YYYY-MM. Refused with invalid_period, period_locked (the period is hard-locked in A03) or run_already_exists (a draft for the same period and selection already exists, and the response names it). Writes NO journal (the post verb does). Idempotent on idempotencyKey and on the (period, selection) signature, where the signature is built from the LINES the run would write (asset, amount and production figure), so two creates over the same eligible set yield ONE draft however the filters or the units map were spelled. When there is nothing to charge, NO run is persisted at all: the answer is {ok:true, run:null, lines:[], empty:true, skipped:[...]}, computed fresh, so it is identical on every call however many times it is repeated and whatever key each call carries. A run header exists only where at least one asset is charged, which is why a finished period never leaves an outstanding draft in run_list for a period-close checklist to trip over. Once a period is POSTED its assets carry it as their last depreciation period, so nothing is eligible and a later create for that period returns exactly that empty answer, carrying alreadyPostedRunId: the id of the most recently posted run for the period (two disjoint selections can both post for one period). A foreign assetId is not_found (§H-TENANT).',
      ctxSchema(
        {
          period: STR,
          assetIds: { type: 'array', items: STR },
          costCenterId: STR,
          categoryId: STR,
          postingGranularity: STR,
          unitsByAsset: { type: 'object' },
          idempotencyKey: STR,
        },
        ['period', 'idempotencyKey'],
      ),
      (ctx, input) => assetDepreciationRunCreate(ctx, as(input)),
    ),
    ctxAction(
      'asset_depreciation_run_post',
      'write',
      'Post a reviewed DRAFT depreciation run (H04): in ONE atomic transaction it re-validates eligibility and the period-open state, posts one balanced GL journal via A02 (Dr the depreciation-expense account / Cr the accumulated-depreciation account for each line, source=asset_depreciation), writes one append-only asset_transaction (type=depreciation) per asset, advances every asset accumulated_depr_rappen / net_book_value_rappen / last_depreciation_period, sets a final asset to status=fully_depreciated, and marks the run posted with its journal_entry_id. postingDate defaults to the last day of the period; it may land later than the period (a late close) but never earlier than the first day of the run period, and an explicitly supplied date may not predate the acquisition date of any asset in the run (invalid_input names the field and a reason of before_period or before_acquisition). Refused with period_locked (the RUN period or the posting date is hard-locked: a posting date in an open year can never slip a charge past a sealed one), stale_draft with the reason that applies (accumulated_moved: its accumulated depreciation moved since the draft was calculated; valuation_moved: its net book value moved, for instance an asset_add_capitalisation landed while the draft was under review; asset_terminal: it was disposed or archived; asset_missing), run_reversed. A stale draft is never recomputed, because that would silently change a figure the reviewer already approved: recreate the run. Idempotent on idempotencyKey AND on run status: a re-post of an already-posted run posts NO second journal and writes NO second asset_transaction, returning the original result (a double-post never double-counts). §H-TENANT: a foreign runId is not_found.',
      ctxSchema({ runId: STR, postingDate: STR, idempotencyKey: STR }, ['runId', 'idempotencyKey']),
      (ctx, input) => assetDepreciationRunPost(ctx, as(input)),
    ),
    ctxAction(
      'asset_depreciation_run_reverse',
      'write',
      'Reverse a POSTED depreciation run (H04) when a material error is found, without rewriting history: it calls A02 reverseEntry on the original journal (producing a new reversing entry), writes a compensating asset_transaction (type=depreciation_reversal) per line, restores every asset accumulated_depr_rappen / net_book_value_rappen / status / last_depreciation_period to its pre-run value (by delta), and marks the original run reversed with the reversing journal link. The original journal and the original run amounts are never mutated (§H-AUDIT). reverseDate defaults to the last day of the period and may not predate the first day of the run period (a reversal is booked forward, never before the charge it reverses: invalid_input names the field). The optional reason is recorded on the reversing entry description and on the compensating asset_transaction. Refused with run_not_posted (a draft), already_reversed, period_locked, and later_run_exists when a LATER run has already posted for one of the assets (the response names the blocking period): runs are reversed newest first, because the asset last_depreciation_period stays on the later run and the earlier period would otherwise be silently unrecoverable. A reversed run cannot be re-posted; a new run for the same period may be created afterwards. Idempotent on idempotencyKey. §H-TENANT: a foreign runId is not_found.',
      ctxSchema({ runId: STR, reason: STR, reverseDate: STR, idempotencyKey: STR }, ['runId', 'idempotencyKey']),
      (ctx, input) => assetDepreciationRunReverse(ctx, as(input)),
    ),
    ctxAction(
      'asset_depreciation_run_get',
      'read',
      'Read one depreciation run by id (H04): the run header (period, status, granularity, total, asset count, the journal_entry_id it posted and the reversing link if reversed) plus every line, in register order (asset id, assetNumber, amount, accumulated-before/after, nbv-after, is_final, costCenterId, the two GL account ids the line posts against, and unitsProduced: the production figure a units_of_production amount was computed from, null for every other method). §H-TENANT: a foreign runId is not_found.',
      ctxSchema({ runId: STR }, ['runId']),
      (ctx, input) => assetDepreciationRunGet(ctx, as(input)),
    ),
    ctxAction(
      'asset_depreciation_run_list',
      'read',
      'List the workspace depreciation runs (H04), newest period first. Optional filters: period (exact YYYY-MM), status (draft | posted | reversed, one or an array), and a from/to period window. Read-only.',
      ctxSchema({
        period: STR,
        status: STR_OR_LIST,
        from: STR,
        to: STR,
      }),
      (ctx, input) => assetDepreciationRunList(ctx, as(input)),
    ),

    // --- H06, Asset Disposal (MONEY PATH: posts the terminal disposal journal) --------------------
    ctxAction(
      'asset_disposal_preview',
      'read',
      'Preview the exact disposal journal for an active or fully_depreciated fixed asset (H06) WITHOUT posting anything. Given the asset, a disposalDate, proceedsRappen (>= 0), a gainLossAccountId (an income or expense account) and, when proceeds > 0, a proceedsAccountId (a bank/receivable asset or a liability account), it returns the current cost / accumulated depreciation / net book value, the signed gainLossRappen (proceeds minus NBV: positive is a gain, negative a loss), and the full balanced journal_lines it WOULD post: Dr accumulated depreciation, Dr proceeds account, the book loss (Dr) or gain (Cr) on the gainLossAccountId, and Cr the asset cost account. The lines are the SAME lines asset_dispose posts, so the preview never disagrees with the posting. Pure read: it writes nothing, creates no journal and does NOT check the period lock, so it is exactly the tool for seeing what a disposal would book before finding out the period is sealed. Refused before any calculation with not_found (foreign asset, §H-TENANT), asset_already_disposed / asset_archived / asset_not_acquired (a draft has no cost basis), invalid_proceeds (negative or non-integer), invalid_gain_loss_account or invalid_proceeds_account (missing, foreign, or wrong type).',
      ctxSchema(
        {
          assetId: STR,
          disposalDate: STR,
          proceedsRappen: INT,
          proceedsAccountId: STR,
          gainLossAccountId: STR,
          reason: STR,
          counterpartyName: STR,
          notes: STR,
        },
        ['assetId', 'disposalDate', 'proceedsRappen', 'gainLossAccountId'],
      ),
      (ctx, input) => assetDisposalPreview(ctx, as(input)),
    ),
    ctxAction(
      'asset_dispose',
      'write',
      'Dispose an active or fully_depreciated fixed asset (H06): the TERMINAL financial event (sale, scrap, donation, write-off, retirement). In ONE atomic transaction it (a) posts ONE balanced GL journal via A02 (source=asset_disposal) clearing the asset cost (Cr) and its accumulated depreciation (Dr), recognising the proceeds (Dr the proceedsAccountId) and the resulting book gain (Cr) or loss (Dr) on the gainLossAccountId; (b) writes ONE append-only asset_transaction (type=disposal, deltaCostRappen = -cost, deltaAccumDeprRappen = -accumulated, proceedsRappen, gainLossRappen) naming that journal; and (c) moves the asset to status=disposed, forces net_book_value_rappen to 0 and stamps disposed_at / disposal_proceeds_rappen (cost and accumulated stay for historical reporting). The gain/loss SIGN is proceedsRappen minus net book value: proceeds above NBV credit the gain account, below NBV debit the loss account, exactly equal writes no gain/loss line. A scrap (proceedsRappen = 0) writes no proceeds line and needs no proceedsAccountId. After success the asset is permanently excluded from every future depreciation run (H03/H04 status filter) and asset_update refuses it with asset_terminal. Refused with not_found (foreign asset, §H-TENANT), asset_already_disposed (a second dispose: first wins, second is refused), asset_archived, asset_not_acquired (a draft has no cost basis), invalid_proceeds, invalid_gain_loss_account, invalid_proceeds_account, or period_locked (disposalDate in a hard-locked A03 period). A wrong disposal is corrected by reversing the journal (A02) plus a compensating asset_transaction, never an un-dispose. Idempotent on idempotencyKey: a replay returns the original {asset, transaction, journalEntry, gainLossRappen} and posts no second journal, appends no second transaction and re-flips no status.',
      ctxSchema(
        {
          assetId: STR,
          disposalDate: STR,
          proceedsRappen: INT,
          proceedsAccountId: STR,
          gainLossAccountId: STR,
          reason: STR,
          counterpartyName: STR,
          notes: STR,
          idempotencyKey: STR,
        },
        ['assetId', 'disposalDate', 'proceedsRappen', 'gainLossAccountId', 'idempotencyKey'],
      ),
      (ctx, input) => assetDispose(ctx, as(input)),
    ),
    ctxAction(
      'asset_disposal_get',
      'read',
      'Read one fixed-asset DISPOSAL sub-ledger transaction by id (H06), with the balanced GL journal entry it posted. transactionId must name a disposal-type asset_transaction in this workspace: a foreign id, or an id naming an acquisition / depreciation event, is not_found rather than a leak of the wrong event through the disposal verb (§H-TENANT).',
      ctxSchema({ transactionId: STR }, ['transactionId']),
      (ctx, input) => assetDisposalGet(ctx, as(input)),
    ),

    // --- H07, Asset Ledger & Reconciliation ------------------------------------------------------
    // The READ half derives everything from the append-only asset_transaction sub-ledger; the one write
    // (asset_opening_balance) posts a balanced opening journal through A02, exactly as H02 acquisition does.
    ctxAction(
      'asset_ledger_get',
      'read',
      'The complete chronological ledger for ONE fixed asset (H07, US-H07.1): every asset_transaction event (acquisition, additional_capitalisation, opening, depreciation, disposal) in effective-date order, each with its type, delta cost, delta accumulated depreciation, proceeds/gain-loss (disposal), the GL journal_entry_id it posted, and the RUNNING cost / accumulated depreciation / net book value AFTER that event. A disposed asset keeps its full history (its disposal row returns the running totals to zero; nothing is purged). Read-only. §H-TENANT: a foreign assetId is not_found.',
      ctxSchema({ assetId: STR }, ['assetId']),
      (ctx, input) => assetLedgerGet(ctx, as(input)),
    ),
    ctxAction(
      'asset_ledger_list',
      'read',
      'List fixed-asset sub-ledger events ACROSS assets (H07, US-H07.4), newest first, with journal links. Optional filters: assetId, type (one or an array of acquisition | additional_capitalisation | opening | depreciation | disposal | revaluation | adjustment), a fromDate/toDate window (YYYY-MM-DD, inclusive), and journalEntryId. Simple limit (default 100, max 500) / offset pagination; returns { items, total }. This is a flat list, so no running balance is attached (the running NBV is only meaningful within one asset: use asset_ledger_get for that). Read-only, §H-TENANT.',
      ctxSchema({
        assetId: STR,
        type: STR_OR_LIST,
        fromDate: STR,
        toDate: STR,
        journalEntryId: STR,
        limit: INT,
        offset: INT,
      }),
      (ctx, input) => assetLedgerList(ctx, as(input)),
    ),
    ctxAction(
      'asset_reconciliation_report',
      'read',
      'The OP11 reconciliation report for fixed assets (H07, US-H07.2): one row per control account (cost and accumulated depreciation), each with the sub-ledger total (summed from asset_transaction), the posted GL balance of the same account, the delta (0 when balanced), a balanced | drift status, and the contributing-asset drill-down. Cut-off: as_of (an ISO date) takes precedence over period (YYYY-MM, whose month-end is the cut-off); with neither it is as-of today. Optional accountIds filter. A disposed asset drops out of the open totals because its disposal cleared both sides; a journal posted directly against a control account with no asset_transaction shows as drift (the detection mechanism, never auto-corrected). Read-only, §H-TENANT.',
      ctxSchema({ period: STR, asOf: STR, accountIds: { type: 'array', items: STR } }),
      (ctx, input) => assetReconciliationReport(ctx, as(input)),
    ),
    ctxAction(
      'asset_reconciliation_check',
      'read',
      'The HARD fixed-asset reconciliation check for a period (H07, US-H07.3), the one period-close and agents invoke. It reconciles the whole workspace at the period end (YYYY-MM) and returns { status: "balanced", accounts } when every control account nets to 0 difference, or the structured reconciliation_drift error naming the offending accounts and their sub-ledger / GL / delta amounts when any does not. Period close may hard-lock only on the balanced answer; a drift blocks it until the difference is explained or corrected through the ordinary reversing + correcting flow (the reconciliation itself posts nothing). Read-only, §H-TENANT.',
      ctxSchema({ period: STR }, ['period']),
      (ctx, input) => assetReconciliationCheck(ctx, as(input)),
    ),
    ctxAction(
      'asset_opening_balance',
      'write',
      'Seed the opening cost and accumulated depreciation of a fixed asset (H07, US-H07.5): for an asset that already exists in the real world at migration, it records the historical figures so the identity invariants and the recon report hold from the opening period. In ONE atomic transaction it posts ONE balanced GL journal via A02 (Dr the asset cost account for costRappen, Cr the accumulated-depreciation account for accumulatedDeprRappen when > 0, and Cr the offsetAccountId equity/opening account for the net book value cost minus accumulated) and writes ONE append-only asset_transaction of type=opening naming that journal, then moves the asset from draft to active with that baseline (which trips the H01 financial-field lock). offsetAccountId is required only when costRappen > accumulatedDeprRappen. Refused with not_found (foreign asset, §H-TENANT), already_acquired / already_opened (the asset already carries a financial event), invalid_input (bad date, non-positive cost, accumulated outside 0..cost), invalid_offset_account, and period_locked. Idempotent on idempotencyKey: a replay returns the original objects (asset, transaction, journalEntry) and posts no second journal and appends no second row.',
      ctxSchema(
        {
          assetId: STR,
          date: STR,
          costRappen: INT,
          accumulatedDeprRappen: INT,
          offsetAccountId: STR,
          description: STR,
          idempotencyKey: STR,
        },
        ['assetId', 'date', 'costRappen', 'idempotencyKey'],
      ),
      (ctx, input) => assetOpeningBalance(ctx, as(input)),
    ),
  ];
}
