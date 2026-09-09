/**
 * H01, the Asset Master engine: create / read / update / search / archive over the single controlled
 * record for every capitalised fixed asset. An asset is created FROM a category (H00), inheriting the
 * depreciation method, useful life, residual rule and three GL accounts, with overrides allowed only
 * at creation; from then on those financial fields are the depreciation base H03/H04 post against.
 *
 * MONEY-PATH ADJACENT, but it posts NOTHING itself (the acquisition journal is H02, depreciation is
 * H03/H04). What makes it money-path adjacent is the FINANCIAL-FIELD IMMUTABILITY rule: once a
 * financial event exists for an asset (a posted acquisition, which is what moves it out of `draft`),
 * `acquisition_date`, `acquisition_cost_rappen`, `residual_value_rappen`, `useful_life_months`,
 * `depreciation_method` and the three GL accounts can no longer change through `assetUpdate`. A change
 * then must be a correction flow (H05 transfer / H06 disposal / a future revaluation), never a
 * destructive edit, exactly as a posted journal entry is corrected by a reversing entry and never
 * mutated (THE money path is unforgiving). `assetUpdate` refuses such a change with
 * `financial_fields_locked` and writes nothing.
 *
 * Every read and write is scoped to `ctx.workspaceId` (§H-TENANT): a foreign id resolves to
 * undefined, never to its row, so a cross-workspace read is a `not_found` and a cross-workspace write
 * is impossible. Every write takes an idempotency key (§H-IDEMPOTENT) and validation runs BEFORE any
 * write and returns a structured `err` (P9), so a rejected create writes nothing and a retry under the
 * same key after corrected input is a real retry (only the write itself is wrapped in
 * `rememberIdempotent`).
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { DEPRECIATION_METHODS } from './category.js';

/** The asset lifecycle (§H-ENUM, §5). `draft` is the only mutable-financials state; a posted
 * acquisition (H02) moves it to `active`, which locks the baseline. `fully_depreciated` (H04),
 * `disposed` (H06) and `archived` (this verb) are the terminal / read-only-here states. */
export const ASSET_STATUSES = ['draft', 'active', 'fully_depreciated', 'disposed', 'archived'] as const;
export type AssetStatus = (typeof ASSET_STATUSES)[number];

const METHOD_SET: ReadonlySet<string> = new Set(DEPRECIATION_METHODS);
const MAX_RESIDUAL_PCT = 10_000;

/** An ISO calendar date `YYYY-MM-DD`, the shape A02 dates already use. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

interface AssetRow {
  id: string;
  workspace_id: string;
  number: string;
  name: string;
  description: string | null;
  category_id: string;
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
  manufacturer: string | null;
  model: string | null;
  warranty_until: string | null;
  notes: string | null;
  accumulated_depr_rappen: number;
  net_book_value_rappen: number;
  last_depreciation_period: string | null;
  disposed_at: string | null;
  disposal_proceeds_rappen: number | null;
  created_at: string;
  updated_at: string;
  created_by: string | null;
}

interface CategoryRow {
  id: string;
  depreciation_method: string;
  useful_life_months: number | null;
  residual_value_pct: number;
  residual_value_rappen: number | null;
  gl_asset_account_id: string;
  gl_accum_depr_account_id: string;
  gl_depr_expense_account_id: string;
  active: number;
}

interface AccountRow {
  id: string;
  type: string;
}

function mapAsset(row: AssetRow) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    number: row.number,
    name: row.name,
    description: row.description,
    categoryId: row.category_id,
    status: row.status,
    acquisitionDate: row.acquisition_date,
    acquisitionCostRappen: row.acquisition_cost_rappen,
    residualValueRappen: row.residual_value_rappen,
    usefulLifeMonths: row.useful_life_months,
    depreciationMethod: row.depreciation_method,
    decliningRateBp: row.declining_rate_bp,
    totalEstimatedUnits: row.total_estimated_units,
    glAssetAccountId: row.gl_asset_account_id,
    glAccumDeprAccountId: row.gl_accum_depr_account_id,
    glDeprExpenseAccountId: row.gl_depr_expense_account_id,
    locationId: row.location_id,
    responsibleUserId: row.responsible_user_id,
    serialNumber: row.serial_number,
    barcode: row.barcode,
    manufacturer: row.manufacturer,
    model: row.model,
    warrantyUntil: row.warranty_until,
    notes: row.notes,
    accumulatedDeprRappen: row.accumulated_depr_rappen,
    netBookValueRappen: row.net_book_value_rappen,
    lastDepreciationPeriod: row.last_depreciation_period,
    disposedAt: row.disposed_at,
    disposalProceedsRappen: row.disposal_proceeds_rappen,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: row.created_by,
  };
}

function readAsset(ctx: WorkspaceContext, id: string): AssetRow | undefined {
  return ctx.store.db
    .prepare('SELECT * FROM asset WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, id) as AssetRow | undefined;
}

function readCategory(ctx: WorkspaceContext, id: string): CategoryRow | undefined {
  return ctx.store.db
    .prepare(
      `SELECT id, depreciation_method, useful_life_months, residual_value_pct, residual_value_rappen,
              gl_asset_account_id, gl_accum_depr_account_id, gl_depr_expense_account_id, active
         FROM asset_category WHERE workspace_id = ? AND id = ?`,
    )
    .get(ctx.workspaceId, id) as CategoryRow | undefined;
}

/** An account IN THIS WORKSPACE, or undefined. Scoping by workspace is what makes §H-TENANT hold on
 * the account-type checks: a foreign account id resolves to undefined, never to its row. */
function readAccount(ctx: WorkspaceContext, id: string): AccountRow | undefined {
  return ctx.store.db
    .prepare('SELECT id, type FROM account WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, id) as AccountRow | undefined;
}

/** An asset whose lower(number) already exists in this workspace, other than `exceptId`. The friendly
 * half of the case-insensitive uniqueness the DB index enforces underneath. */
function numberTaken(ctx: WorkspaceContext, number: string, exceptId?: string): boolean {
  const row = ctx.store.db
    .prepare(
      'SELECT id FROM asset WHERE workspace_id = ? AND lower(number) = lower(?) AND id != ? LIMIT 1',
    )
    .get(ctx.workspaceId, number, exceptId ?? '') as { id: string } | undefined;
  return row !== undefined;
}

/**
 * Does a POSTED FINANCIAL EVENT exist for this asset, so its baseline is locked?
 *
 * The authoritative signal is `status`: a posted acquisition (H02) is what moves an asset out of
 * `draft`, so any non-draft status means an event exists and the financial fields are frozen. A
 * SECOND, forward-looking signal is a probe of the H02/H04 transactions table: it does not exist yet,
 * so it degrades to "no event" today (the H00 `categoryReferencedByAsset` pattern), but the moment
 * H02 lands its posting table this guard already honours it even if a status update ever lagged. The
 * two are independent triggers, and the test exercises the status one by standing an asset into
 * `active` directly, exactly as H00's in-use test stood up the future `asset` table.
 */
function financialEventsExist(ctx: WorkspaceContext, assetId: string, status: string): boolean {
  if (status !== 'draft') return true;
  const hasTxnTable = ctx.store.db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'asset_transaction'")
    .get() as { name: string } | undefined;
  if (hasTxnTable === undefined) return false;
  const row = ctx.store.db
    .prepare('SELECT id FROM asset_transaction WHERE workspace_id = ? AND asset_id = ? LIMIT 1')
    .get(ctx.workspaceId, assetId) as { id: string } | undefined;
  return row !== undefined;
}

/** Validate the three GL accounts (cost=asset, accumulated depreciation=asset|liability contra,
 * expense=expense). Shared by create and any financial update so the two cannot drift. Returns a
 * Result on failure, undefined when admissible. The H00 `validateAccounts` rule, one entity down. */
function validateGlAccounts(
  ctx: WorkspaceContext,
  ids: { assetId: string; accumId: string; expenseId: string },
): Result | undefined {
  const assetAcc = readAccount(ctx, ids.assetId);
  if (assetAcc === undefined) return err('invalid_account_type', { field: 'glAssetAccountId', reason: 'not_found' });
  if (assetAcc.type !== 'asset') {
    return err('invalid_account_type', { field: 'glAssetAccountId', type: assetAcc.type, expected: 'asset' });
  }
  const accumAcc = readAccount(ctx, ids.accumId);
  if (accumAcc === undefined) return err('invalid_account_type', { field: 'glAccumDeprAccountId', reason: 'not_found' });
  if (accumAcc.type !== 'asset' && accumAcc.type !== 'liability') {
    return err('invalid_account_type', { field: 'glAccumDeprAccountId', type: accumAcc.type, expected: 'asset|liability' });
  }
  const expenseAcc = readAccount(ctx, ids.expenseId);
  if (expenseAcc === undefined) return err('invalid_account_type', { field: 'glDeprExpenseAccountId', reason: 'not_found' });
  if (expenseAcc.type !== 'expense') {
    return err('invalid_account_type', { field: 'glDeprExpenseAccountId', type: expenseAcc.type, expected: 'expense' });
  }
  return undefined;
}

/** Validate the depreciation trio (method, useful life). Shared by create and update. */
function validateDepreciation(input: {
  method: string;
  usefulLifeMonths?: number | null | undefined;
}): Result | undefined {
  if (!METHOD_SET.has(input.method)) {
    return err('invalid_method', { depreciationMethod: input.method, allowed: [...DEPRECIATION_METHODS] });
  }
  if (input.method !== 'none') {
    if (input.usefulLifeMonths === undefined || input.usefulLifeMonths === null) {
      return err('missing_useful_life', { depreciationMethod: input.method });
    }
    if (!Number.isInteger(input.usefulLifeMonths) || input.usefulLifeMonths <= 0) {
      return err('invalid_useful_life', { usefulLifeMonths: input.usefulLifeMonths });
    }
  }
  return undefined;
}

/**
 * Resolve the absolute residual in Rappen at creation. An explicit `residualValueRappen` override
 * wins; otherwise a category's own absolute residual wins; otherwise the residual PCT (override or
 * inherited) is resolved against the acquisition cost. The asset stores the resolved absolute figure
 * only (§4: `residual_value_rappen` is "the resolved absolute value"), so depreciation never has to
 * re-derive it and a later cost correction cannot silently move a residual that was fixed as a figure.
 */
function resolveResidualRappen(
  costRappen: number,
  cat: CategoryRow,
  override: { residualValueRappen?: number | null | undefined; residualValuePct?: number | null | undefined },
): number {
  if (override.residualValueRappen !== undefined && override.residualValueRappen !== null) {
    return override.residualValueRappen;
  }
  if (cat.residual_value_rappen !== null && override.residualValuePct === undefined) {
    return cat.residual_value_rappen;
  }
  const pct = override.residualValuePct ?? cat.residual_value_pct ?? 0;
  return Math.round((costRappen * pct) / MAX_RESIDUAL_PCT);
}

export interface CreateAssetInput {
  categoryId?: string;
  number?: string;
  name?: string;
  description?: string | null;
  acquisitionDate?: string;
  acquisitionCostRappen?: number;
  depreciationMethod?: string;
  usefulLifeMonths?: number | null;
  /** Basis points p.a. for declining_balance (2000 = 20%); the H03/H04 depreciation parameter. */
  decliningRateBp?: number | null;
  /** Estimated total lifetime units for units_of_production; the H03/H04 depreciation parameter. */
  totalEstimatedUnits?: number | null;
  residualValuePct?: number | null;
  residualValueRappen?: number | null;
  glAssetAccountId?: string;
  glAccumDeprAccountId?: string;
  glDeprExpenseAccountId?: string;
  locationId?: string | null;
  responsibleUserId?: string | null;
  serialNumber?: string | null;
  barcode?: string | null;
  manufacturer?: string | null;
  model?: string | null;
  warrantyUntil?: string | null;
  notes?: string | null;
  idempotencyKey?: string;
}

/** Generate the next `FA-####` number free in this workspace. Deterministic and collision-safe: it
 * starts from the row count + 1 and steps past any manually seated number, and the DB unique index is
 * the race guard underneath. */
function nextAssetNumber(ctx: WorkspaceContext): string {
  const { n } = ctx.store.db
    .prepare('SELECT COUNT(*) AS n FROM asset WHERE workspace_id = ?')
    .get(ctx.workspaceId) as { n: number };
  let seq = n + 1;
  let candidate = `FA-${String(seq).padStart(4, '0')}`;
  while (numberTaken(ctx, candidate)) {
    seq += 1;
    candidate = `FA-${String(seq).padStart(4, '0')}`;
  }
  return candidate;
}

export function createAsset(ctx: WorkspaceContext, input: CreateAssetInput): Result {
  // Replay a completed create BEFORE the duplicate-number guard (§H-IDEMPOTENT), the H00 order.
  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    const replayed = ctx.store.recallIdempotent<Result>(ctx.workspaceId, input.idempotencyKey, 'asset_create');
    if (replayed !== undefined) return replayed;
  }

  if (typeof input.categoryId !== 'string' || input.categoryId.length === 0) {
    return err('invalid_input', { field: 'categoryId' });
  }
  const cat = readCategory(ctx, input.categoryId);
  if (cat === undefined) return err('not_found', { categoryId: input.categoryId });
  if (cat.active !== 1) return err('category_archived', { categoryId: input.categoryId });

  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (name.length === 0) return err('invalid_input', { field: 'name' });

  const acquisitionDate = typeof input.acquisitionDate === 'string' ? input.acquisitionDate.trim() : '';
  if (acquisitionDate.length === 0) return err('missing_acquisition_date', {});
  if (!ISO_DATE.test(acquisitionDate)) return err('invalid_input', { field: 'acquisitionDate' });

  const cost = input.acquisitionCostRappen;
  if (typeof cost !== 'number' || !Number.isInteger(cost) || cost <= 0) {
    return err('invalid_cost', { acquisitionCostRappen: cost });
  }

  // Inherit the category defaults, override only what is passed (overrides are a creation-time act).
  const method = input.depreciationMethod ?? cat.depreciation_method;
  const usefulLifeMonths =
    input.usefulLifeMonths !== undefined ? input.usefulLifeMonths : cat.useful_life_months;
  const deprErr = validateDepreciation({ method, usefulLifeMonths });
  if (deprErr !== undefined) return deprErr;

  if (input.residualValuePct !== undefined && input.residualValuePct !== null) {
    if (!Number.isInteger(input.residualValuePct) || input.residualValuePct < 0 || input.residualValuePct > MAX_RESIDUAL_PCT) {
      return err('invalid_residual_pct', { residualValuePct: input.residualValuePct, max: MAX_RESIDUAL_PCT });
    }
  }
  if (input.residualValueRappen !== undefined && input.residualValueRappen !== null) {
    if (!Number.isInteger(input.residualValueRappen) || input.residualValueRappen < 0) {
      return err('invalid_residual_rappen', { residualValueRappen: input.residualValueRappen });
    }
  }

  // The two method-specific depreciation parameters (H03/H04). Validated as non-negative integers when
  // present; only meaningful for their own method, so a value for the wrong method is dropped to NULL
  // rather than stored to mislead. The category carries no default for these yet, so they arrive only
  // as an explicit creation-time input, exactly as the depreciation-method override does.
  if (input.decliningRateBp !== undefined && input.decliningRateBp !== null) {
    if (!Number.isInteger(input.decliningRateBp) || input.decliningRateBp < 0) {
      return err('invalid_declining_rate', { decliningRateBp: input.decliningRateBp });
    }
  }
  if (input.totalEstimatedUnits !== undefined && input.totalEstimatedUnits !== null) {
    if (!Number.isInteger(input.totalEstimatedUnits) || input.totalEstimatedUnits <= 0) {
      return err('invalid_total_units', { totalEstimatedUnits: input.totalEstimatedUnits });
    }
  }
  const decliningRateBp =
    method === 'declining_balance' && typeof input.decliningRateBp === 'number' ? input.decliningRateBp : null;
  const totalEstimatedUnits =
    method === 'units_of_production' && typeof input.totalEstimatedUnits === 'number' ? input.totalEstimatedUnits : null;

  const assetAccId = input.glAssetAccountId ?? cat.gl_asset_account_id;
  const accumAccId = input.glAccumDeprAccountId ?? cat.gl_accum_depr_account_id;
  const expenseAccId = input.glDeprExpenseAccountId ?? cat.gl_depr_expense_account_id;
  const accErr = validateGlAccounts(ctx, { assetId: assetAccId, accumId: accumAccId, expenseId: expenseAccId });
  if (accErr !== undefined) return accErr;

  const residualRappen = resolveResidualRappen(cost, cat, {
    residualValueRappen: input.residualValueRappen,
    residualValuePct: input.residualValuePct,
  });
  if (residualRappen > cost) return err('invalid_residual_rappen', { residualValueRappen: residualRappen, cost });

  // number: accept a manual one (length-validated here, uniqueness checked inside the write) or
  // generate FA-####. The DUPLICATE check itself is deferred into `run()` below (see the note there):
  // it is the one guard that must live inside the memoised transaction so a rejection is never stored.
  let number: string;
  if (input.number !== undefined && input.number !== null && String(input.number).trim() !== '') {
    number = String(input.number).trim();
    if (number.length > 40) return err('invalid_input', { field: 'number' });
  } else {
    number = nextAssetNumber(ctx);
  }

  const usefulLifeFinal = method === 'none' ? null : (usefulLifeMonths as number);

  const run = (): Result => {
    // The uniqueness guard lives HERE, inside the (memoised) transaction, and it THROWS rather than
    // returning `err`. Both halves matter for the money-path idempotency contract:
    //   - throwing rolls the transaction back, so a duplicate leaves no partial row; and
    //   - because it throws instead of returning `{ok:false}`, `rememberIdempotent` never stores the
    //     failure. A create that failed on a duplicate is therefore RETRYABLE under the same key with
    //     corrected input, instead of replaying a stale error forever. (Returning `err` here would be
    //     memoised, which was the latent defect the H01/H02 critics flagged.)
    // The DB UNIQUE index over lower(number) is the honest race guard underneath; this narrows the
    // window and keeps the friendly `duplicate_number` for the ordinary case.
    if (numberTaken(ctx, number)) throw new CreateAssetAbort(err('duplicate_number', { number }));
    const id = ctx.ids.next('asset');
    const now = ctx.clock.now();
    ctx.store.db
      .prepare(
        `INSERT INTO asset (
           id, workspace_id, number, name, description, category_id, status,
           acquisition_date, acquisition_cost_rappen, residual_value_rappen, useful_life_months,
           depreciation_method, declining_rate_bp, total_estimated_units,
           gl_asset_account_id, gl_accum_depr_account_id, gl_depr_expense_account_id,
           location_id, responsible_user_id, serial_number, barcode, manufacturer, model, warranty_until, notes,
           accumulated_depr_rappen, net_book_value_rappen, last_depreciation_period, disposed_at, disposal_proceeds_rappen,
           created_at, updated_at, created_by
         ) VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, NULL, NULL, NULL, ?, ?, ?)`,
      )
      .run(
        id,
        ctx.workspaceId,
        number,
        name,
        input.description ?? null,
        input.categoryId,
        acquisitionDate,
        cost,
        residualRappen,
        usefulLifeFinal,
        method,
        decliningRateBp,
        totalEstimatedUnits,
        assetAccId,
        accumAccId,
        expenseAccId,
        input.locationId === '' ? null : input.locationId ?? null,
        input.responsibleUserId === '' ? null : input.responsibleUserId ?? null,
        input.serialNumber === '' ? null : input.serialNumber ?? null,
        input.barcode === '' ? null : input.barcode ?? null,
        input.manufacturer === '' ? null : input.manufacturer ?? null,
        input.model === '' ? null : input.model ?? null,
        input.warrantyUntil === '' ? null : input.warrantyUntil ?? null,
        input.notes === '' ? null : input.notes ?? null,
        // net book value at creation = cost - accumulated(0). Accumulated depreciation, not residual,
        // is what reduces NBV; residual only bounds how far depreciation may run.
        cost,
        now,
        now,
        ctx.actor,
      );
    return ok({ asset: mapAsset(readAsset(ctx, id) as AssetRow) });
  };

  try {
    if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
      return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'asset_create', run);
    }
    return run();
  } catch (e) {
    if (e instanceof CreateAssetAbort) return e.result;
    throw e;
  }
}

/** Abort the (memoised) create transaction with a structured cause, so a rejection discovered inside
 * the write is neither committed nor stored by `rememberIdempotent`. Returning `{ok:false}` from inside
 * `rememberIdempotent` would COMMIT the bookkeeping row and REPLAY the error on the next retry; throwing
 * rolls the transaction back and leaves the key free for a genuine retry (the acquisition.ts abort
 * shape, applied to the one guard that must not be memoised). */
class CreateAssetAbort {
  constructor(public readonly result: Result) {}
}

/** The financial-baseline fields that lock once a financial event exists. Descriptive fields (name,
 * description, location, responsible, serial, barcode, manufacturer, model, warranty, notes) are not
 * listed here precisely because they never lock: they stay editable on any non-terminal asset. */
const FINANCIAL_FIELDS = [
  'acquisitionDate',
  'acquisitionCostRappen',
  'depreciationMethod',
  'usefulLifeMonths',
  'residualValuePct',
  'residualValueRappen',
  'glAssetAccountId',
  'glAccumDeprAccountId',
  'glDeprExpenseAccountId',
] as const;

export interface UpdateAssetInput {
  assetId?: string;
  patch?: Record<string, unknown>;
  idempotencyKey?: string;
}

export function updateAsset(ctx: WorkspaceContext, input: UpdateAssetInput): Result {
  if (typeof input.assetId !== 'string' || input.assetId.length === 0) {
    return err('invalid_input', { field: 'assetId' });
  }
  const current = readAsset(ctx, input.assetId);
  if (current === undefined) return err('not_found', { assetId: input.assetId });
  if (current.status === 'archived' || current.status === 'disposed') {
    return err('asset_terminal', { assetId: input.assetId, status: current.status });
  }
  const patch = input.patch ?? {};

  // THE LOAD-BEARING GUARD: any financial field present in the patch is refused the moment a
  // financial event exists (status left draft). This is the append-only baseline made runtime.
  const touchesFinancial = FINANCIAL_FIELDS.some((f) => patch[f] !== undefined);
  if (touchesFinancial && financialEventsExist(ctx, current.id, current.status)) {
    return err('financial_fields_locked', {
      assetId: input.assetId,
      fields: FINANCIAL_FIELDS.filter((f) => patch[f] !== undefined),
    });
  }

  // Resolve the next values (patch over current), then validate whatever the patch touched.
  const name = patch.name !== undefined ? String(patch.name).trim() : current.name;
  if (name.length === 0) return err('invalid_input', { field: 'name' });

  const method =
    patch.depreciationMethod !== undefined ? String(patch.depreciationMethod) : current.depreciation_method;
  const usefulLifeMonths =
    patch.usefulLifeMonths !== undefined
      ? (patch.usefulLifeMonths as number | null)
      : current.useful_life_months;
  if (touchesFinancial) {
    const deprErr = validateDepreciation({ method, usefulLifeMonths });
    if (deprErr !== undefined) return deprErr;
  }

  if (patch.residualValuePct !== undefined && patch.residualValuePct !== null) {
    const p = patch.residualValuePct as number;
    if (!Number.isInteger(p) || p < 0 || p > MAX_RESIDUAL_PCT) {
      return err('invalid_residual_pct', { residualValuePct: p, max: MAX_RESIDUAL_PCT });
    }
  }
  if (patch.residualValueRappen !== undefined && patch.residualValueRappen !== null) {
    const r = patch.residualValueRappen as number;
    if (!Number.isInteger(r) || r < 0) return err('invalid_residual_rappen', { residualValueRappen: r });
  }

  const assetAccId =
    patch.glAssetAccountId !== undefined ? String(patch.glAssetAccountId) : current.gl_asset_account_id;
  const accumAccId =
    patch.glAccumDeprAccountId !== undefined ? String(patch.glAccumDeprAccountId) : current.gl_accum_depr_account_id;
  const expenseAccId =
    patch.glDeprExpenseAccountId !== undefined ? String(patch.glDeprExpenseAccountId) : current.gl_depr_expense_account_id;
  if (touchesFinancial) {
    const accErr = validateGlAccounts(ctx, { assetId: assetAccId, accumId: accumAccId, expenseId: expenseAccId });
    if (accErr !== undefined) return accErr;
  }

  // Recompute the financial baseline only when the patch touches it (draft assets only, per the guard).
  const cost =
    patch.acquisitionCostRappen !== undefined ? (patch.acquisitionCostRappen as number) : current.acquisition_cost_rappen;
  if (patch.acquisitionCostRappen !== undefined && (!Number.isInteger(cost) || cost <= 0)) {
    return err('invalid_cost', { acquisitionCostRappen: cost });
  }
  const acquisitionDate =
    patch.acquisitionDate !== undefined ? String(patch.acquisitionDate).trim() : current.acquisition_date;
  if (patch.acquisitionDate !== undefined && !ISO_DATE.test(acquisitionDate)) {
    return err('invalid_input', { field: 'acquisitionDate' });
  }

  let residualRappen = current.residual_value_rappen;
  if (patch.residualValueRappen !== undefined && patch.residualValueRappen !== null) {
    residualRappen = patch.residualValueRappen as number;
  } else if (patch.residualValuePct !== undefined && patch.residualValuePct !== null) {
    residualRappen = Math.round((cost * (patch.residualValuePct as number)) / MAX_RESIDUAL_PCT);
  } else if (patch.acquisitionCostRappen !== undefined) {
    // cost changed with no explicit residual: keep the stored absolute residual, but never above cost.
    residualRappen = Math.min(current.residual_value_rappen, cost);
  }
  if (residualRappen > cost) return err('invalid_residual_rappen', { residualValueRappen: residualRappen, cost });

  const usefulLifeFinal = method === 'none' ? null : usefulLifeMonths;

  // A descriptive helper: undefined leaves the column, '' clears it to NULL.
  const desc = (key: string, col: string | null): string | null => {
    if (patch[key] === undefined) return col;
    const v = patch[key];
    return v === '' || v === null ? null : String(v);
  };

  const run = (): Result => {
    ctx.store.db
      .prepare(
        `UPDATE asset SET
           name = ?, description = ?, acquisition_date = ?, acquisition_cost_rappen = ?,
           residual_value_rappen = ?, useful_life_months = ?, depreciation_method = ?,
           gl_asset_account_id = ?, gl_accum_depr_account_id = ?, gl_depr_expense_account_id = ?,
           location_id = ?, responsible_user_id = ?, serial_number = ?, barcode = ?, manufacturer = ?,
           model = ?, warranty_until = ?, notes = ?,
           net_book_value_rappen = ?, updated_at = ?
         WHERE workspace_id = ? AND id = ?`,
      )
      .run(
        name,
        patch.description !== undefined ? desc('description', current.description) : current.description,
        acquisitionDate,
        cost,
        residualRappen,
        usefulLifeFinal,
        method,
        assetAccId,
        accumAccId,
        expenseAccId,
        desc('locationId', current.location_id),
        desc('responsibleUserId', current.responsible_user_id),
        desc('serialNumber', current.serial_number),
        desc('barcode', current.barcode),
        desc('manufacturer', current.manufacturer),
        desc('model', current.model),
        desc('warrantyUntil', current.warranty_until),
        desc('notes', current.notes),
        // NBV = cost - accumulated. Only cost can move here (draft only), accumulated is 0 pre-H04.
        cost - current.accumulated_depr_rappen,
        ctx.clock.now(),
        ctx.workspaceId,
        input.assetId,
      );
    return ok({ asset: mapAsset(readAsset(ctx, input.assetId as string) as AssetRow) });
  };

  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'asset_update', run);
  }
  return run();
}

export function getAsset(ctx: WorkspaceContext, input: { assetId?: string }): Result {
  if (typeof input.assetId !== 'string' || input.assetId.length === 0) {
    return err('invalid_input', { field: 'assetId' });
  }
  const row = readAsset(ctx, input.assetId);
  if (row === undefined) return err('not_found', { assetId: input.assetId });
  return ok({ asset: mapAsset(row) });
}

export interface ListAssetInput {
  categoryId?: string;
  status?: string;
  locationId?: string;
  responsibleUserId?: string;
  acquisitionYear?: string;
  includeArchived?: boolean;
  /** G00 saved-view seam: accepted so a saved view can carry the register's filters. */
  savedViewId?: string;
}

export function listAsset(ctx: WorkspaceContext, input: ListAssetInput = {}): Result {
  const clauses = ['workspace_id = ?'];
  const params: unknown[] = [ctx.workspaceId];
  if (typeof input.categoryId === 'string' && input.categoryId.length > 0) {
    clauses.push('category_id = ?');
    params.push(input.categoryId);
  }
  if (typeof input.status === 'string' && input.status.length > 0) {
    clauses.push('status = ?');
    params.push(input.status);
  } else if (input.includeArchived !== true) {
    // The register hides archived assets by default, the H00 active-filter posture.
    clauses.push("status != 'archived'");
  }
  if (typeof input.locationId === 'string' && input.locationId.length > 0) {
    clauses.push('location_id = ?');
    params.push(input.locationId);
  }
  if (typeof input.responsibleUserId === 'string' && input.responsibleUserId.length > 0) {
    clauses.push('responsible_user_id = ?');
    params.push(input.responsibleUserId);
  }
  if (typeof input.acquisitionYear === 'string' && /^\d{4}$/.test(input.acquisitionYear)) {
    clauses.push('substr(acquisition_date, 1, 4) = ?');
    params.push(input.acquisitionYear);
  }
  const rows = ctx.store.db
    .prepare(`SELECT * FROM asset WHERE ${clauses.join(' AND ')} ORDER BY number`)
    .all(...params) as AssetRow[];
  return ok({ assets: rows.map(mapAsset), total: rows.length });
}

export function searchAsset(ctx: WorkspaceContext, input: { query?: string }): Result {
  const q = typeof input.query === 'string' ? input.query.trim().toLowerCase() : '';
  if (q.length === 0) return ok({ assets: [], total: 0 });
  const like = `%${q}%`;
  const rows = ctx.store.db
    .prepare(
      `SELECT * FROM asset
         WHERE workspace_id = ?
           AND (lower(number) LIKE ? OR lower(name) LIKE ? OR lower(coalesce(serial_number, '')) LIKE ?
                OR lower(coalesce(barcode, '')) LIKE ? OR lower(coalesce(notes, '')) LIKE ?)
         ORDER BY number`,
    )
    .all(ctx.workspaceId, like, like, like, like, like) as AssetRow[];
  return ok({ assets: rows.map(mapAsset), total: rows.length });
}

export function archiveAsset(ctx: WorkspaceContext, input: { assetId?: string; idempotencyKey?: string }): Result {
  if (typeof input.assetId !== 'string' || input.assetId.length === 0) {
    return err('invalid_input', { field: 'assetId' });
  }
  const run = (): Result => {
    const current = readAsset(ctx, input.assetId as string);
    if (current === undefined) return err('not_found', { assetId: input.assetId });
    // §2/US-H01.6: an asset carrying live financial events cannot be soft-archived out of the
    // register (that would hide an asset the ledger still depends on). Only a draft (no posted
    // acquisition) or an already-terminal record may be archived. Disposal is H06's own flow.
    if (current.status === 'active' || current.status === 'fully_depreciated') {
      return err('asset_in_use', { assetId: input.assetId, status: current.status });
    }
    if (current.status !== 'archived') {
      ctx.store.db
        .prepare("UPDATE asset SET status = 'archived', updated_at = ? WHERE workspace_id = ? AND id = ?")
        .run(ctx.clock.now(), ctx.workspaceId, input.assetId);
    }
    return ok({ asset: mapAsset(readAsset(ctx, input.assetId as string) as AssetRow) });
  };

  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'asset_archive', run);
  }
  return run();
}
