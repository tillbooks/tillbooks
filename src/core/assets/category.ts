/**
 * H00, asset categories & defaults: the root of the Wave-12 fixed-asset cluster.
 *
 * A category is the single place a workspace's depreciation defaults live: the method, the useful
 * life, the residual rule, the three GL accounts (cost, accumulated depreciation, depreciation
 * expense) and an optional cost centre. H01 (Asset Master) resolves these through
 * `resolveAssetCategoryDefaults` so an asset inherits correct accounting with no account numbers
 * typed by hand, and an agent can create assets without asking a human for them.
 *
 * PLAIN MASTER DATA, no money path: nothing here posts a journal entry (that is H02/H04). Every read
 * and write is scoped to `ctx.workspaceId` (§H-TENANT); every write takes an idempotency key
 * (§H-IDEMPOTENT). Corrections are ordinary updates (a category is reference data, not a posting),
 * and a category is NEVER deleted, only soft-archived (`active = 0`), because an asset created under
 * it must stay resolvable for its whole depreciable life (§5).
 *
 * Validation runs BEFORE any write and returns a structured `err` (P9), so a rejected create writes
 * nothing. Only the write itself is wrapped in `rememberIdempotent`, so a validation failure is
 * never cached against the key: a retry with corrected input under the same key is a real retry.
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';

/**
 * The registered depreciation methods (§H-ENUM). The single source of truth: `defineField`-style
 * consumers and the verb both read this, and H03 registers a further method by adding to this list in
 * one place rather than touching the category verb. `none` is a real choice (land, art, a
 * low-value item kept at cost): a non-depreciating category carries no useful life.
 */
export const DEPRECIATION_METHODS = [
  'straight_line',
  'declining_balance',
  'units_of_production',
  'none',
] as const;

export type DepreciationMethod = (typeof DEPRECIATION_METHODS)[number];

const METHOD_SET: ReadonlySet<string> = new Set(DEPRECIATION_METHODS);

/** Basis points are hundredths of a percent, so 100% is 10000 and the residual fraction lives in [0, 10000]. */
const MAX_RESIDUAL_PCT = 10_000;

interface CategoryRow {
  id: string;
  workspace_id: string;
  code: string;
  name: string;
  description: string | null;
  depreciation_method: string;
  useful_life_months: number | null;
  residual_value_pct: number;
  residual_value_rappen: number | null;
  gl_asset_account_id: string;
  gl_accum_depr_account_id: string;
  gl_depr_expense_account_id: string;
  default_cost_center_id: string | null;
  active: number;
  created_at: string;
  updated_at: string;
  created_by: string | null;
}

interface AccountRow {
  id: string;
  number: string;
  name: string;
  type: string;
}

function mapCategory(row: CategoryRow) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    code: row.code,
    name: row.name,
    description: row.description,
    depreciationMethod: row.depreciation_method,
    usefulLifeMonths: row.useful_life_months,
    residualValuePct: row.residual_value_pct,
    residualValueRappen: row.residual_value_rappen,
    glAssetAccountId: row.gl_asset_account_id,
    glAccumDeprAccountId: row.gl_accum_depr_account_id,
    glDeprExpenseAccountId: row.gl_depr_expense_account_id,
    defaultCostCenterId: row.default_cost_center_id,
    active: row.active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: row.created_by,
  };
}

function readCategory(ctx: WorkspaceContext, id: string): CategoryRow | undefined {
  return ctx.store.db
    .prepare('SELECT * FROM asset_category WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, id) as CategoryRow | undefined;
}

/** An account IN THIS WORKSPACE, or undefined. Scoping the read by workspace is what makes §H-TENANT
 * hold on the account-type checks: a foreign account id resolves to undefined, never to its row. */
function readAccount(ctx: WorkspaceContext, id: string): AccountRow | undefined {
  return ctx.store.db
    .prepare('SELECT id, number, name, type FROM account WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, id) as AccountRow | undefined;
}

/** A category whose lower(code) already exists in this workspace, other than `exceptId`. The
 * friendly half of the case-insensitive uniqueness the DB index enforces underneath. */
function codeTaken(ctx: WorkspaceContext, code: string, exceptId?: string): boolean {
  const row = ctx.store.db
    .prepare(
      'SELECT id FROM asset_category WHERE workspace_id = ? AND lower(code) = lower(?) AND id != ? LIMIT 1',
    )
    .get(ctx.workspaceId, code, exceptId ?? '') as { id: string } | undefined;
  return row !== undefined;
}

/** Does any asset (H01, any status incl. disposed) still reference this category? Guards archive
 * (§5). H01's table does not exist yet, so this degrades to "no reference" until H01 lands; the
 * check is written now so H00 does not have to be reopened to add it. */
function categoryReferencedByAsset(ctx: WorkspaceContext, categoryId: string): boolean {
  const hasAssetTable = ctx.store.db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'asset'")
    .get() as { name: string } | undefined;
  if (hasAssetTable === undefined) return false;
  const row = ctx.store.db
    .prepare('SELECT id FROM asset WHERE workspace_id = ? AND category_id = ? LIMIT 1')
    .get(ctx.workspaceId, categoryId) as { id: string } | undefined;
  return row !== undefined;
}

/** The GL-account and cost-centre validation shared by create and update, returning the accounts it
 * resolved so callers need not re-read them. Every id is checked to (a) exist in this workspace and
 * (b) carry the correct account type; a wrong type is refused BEFORE any write (§7 tripwire). */
function validateAccounts(
  ctx: WorkspaceContext,
  ids: { assetId: string; accumId: string; expenseId: string; costCenterId?: string | null | undefined },
): Result | { assetAcc: AccountRow; accumAcc: AccountRow; expenseAcc: AccountRow } {
  const assetAcc = readAccount(ctx, ids.assetId);
  if (assetAcc === undefined) return err('invalid_account_type', { field: 'glAssetAccountId', reason: 'not_found' });
  if (assetAcc.type !== 'asset') {
    return err('invalid_account_type', { field: 'glAssetAccountId', type: assetAcc.type, expected: 'asset' });
  }

  const accumAcc = readAccount(ctx, ids.accumId);
  if (accumAcc === undefined) return err('invalid_account_type', { field: 'glAccumDeprAccountId', reason: 'not_found' });
  // Accumulated depreciation is a CONTRA-ASSET (Wertberichtigung): held in the Swiss KMU chart as a
  // negative-balance asset account, or as a liability-side provision. Income/expense/equity are
  // refused, which is exactly US-H00.2's rule for the asset side turned onto the contra side.
  if (accumAcc.type !== 'asset' && accumAcc.type !== 'liability') {
    return err('invalid_account_type', {
      field: 'glAccumDeprAccountId',
      type: accumAcc.type,
      expected: 'asset|liability',
    });
  }

  const expenseAcc = readAccount(ctx, ids.expenseId);
  if (expenseAcc === undefined) return err('invalid_account_type', { field: 'glDeprExpenseAccountId', reason: 'not_found' });
  if (expenseAcc.type !== 'expense') {
    return err('invalid_account_type', { field: 'glDeprExpenseAccountId', type: expenseAcc.type, expected: 'expense' });
  }

  if (ids.costCenterId !== undefined && ids.costCenterId !== null && ids.costCenterId !== '') {
    const cc = ctx.store.db
      .prepare('SELECT id FROM cost_center WHERE workspace_id = ? AND id = ?')
      .get(ctx.workspaceId, ids.costCenterId) as { id: string } | undefined;
    if (cc === undefined) return err('invalid_cost_center', { defaultCostCenterId: ids.costCenterId });
  }

  return { assetAcc, accumAcc, expenseAcc };
}

function isResult(v: Result | { assetAcc: AccountRow }): v is Result {
  return (v as Result).ok !== undefined;
}

/** Validate the depreciation trio (method, useful life, residual). Shared by create and update so
 * the two cannot drift. Returns undefined when the values are admissible. */
function validateDepreciation(input: {
  method: string;
  usefulLifeMonths?: number | null | undefined;
  residualValuePct?: number | null | undefined;
  residualValueRappen?: number | null | undefined;
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
  if (input.residualValuePct !== undefined && input.residualValuePct !== null) {
    if (
      !Number.isInteger(input.residualValuePct) ||
      input.residualValuePct < 0 ||
      input.residualValuePct > MAX_RESIDUAL_PCT
    ) {
      return err('invalid_residual_pct', { residualValuePct: input.residualValuePct, max: MAX_RESIDUAL_PCT });
    }
  }
  if (input.residualValueRappen !== undefined && input.residualValueRappen !== null) {
    if (!Number.isInteger(input.residualValueRappen) || input.residualValueRappen < 0) {
      return err('invalid_residual_rappen', { residualValueRappen: input.residualValueRappen });
    }
  }
  return undefined;
}

export interface CreateAssetCategoryInput {
  code?: string;
  name?: string;
  description?: string | null;
  depreciationMethod?: string;
  usefulLifeMonths?: number | null;
  residualValuePct?: number | null;
  residualValueRappen?: number | null;
  glAssetAccountId?: string;
  glAccumDeprAccountId?: string;
  glDeprExpenseAccountId?: string;
  defaultCostCenterId?: string | null;
  idempotencyKey?: string;
}

export function createAssetCategory(ctx: WorkspaceContext, input: CreateAssetCategoryInput): Result {
  // Replay a completed create BEFORE the duplicate-code guard (§H-IDEMPOTENT), the order
  // `createCostCenter` and `postEntry` use. Without it, a plain retry under the same key would fire
  // the duplicate guard on the very row the first call wrote and come back as `duplicate_code`.
  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    const replayed = ctx.store.recallIdempotent<Result>(ctx.workspaceId, input.idempotencyKey, 'asset_category_create');
    if (replayed !== undefined) return replayed;
  }

  const code = typeof input.code === 'string' ? input.code.trim() : '';
  if (code.length === 0 || code.length > 20) return err('invalid_input', { field: 'code' });
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (name.length === 0) return err('invalid_input', { field: 'name' });

  const method = input.depreciationMethod ?? 'straight_line';
  const deprErr = validateDepreciation({
    method,
    usefulLifeMonths: input.usefulLifeMonths,
    residualValuePct: input.residualValuePct,
    residualValueRappen: input.residualValueRappen,
  });
  if (deprErr !== undefined) return deprErr;

  if (
    typeof input.glAssetAccountId !== 'string' ||
    typeof input.glAccumDeprAccountId !== 'string' ||
    typeof input.glDeprExpenseAccountId !== 'string'
  ) {
    return err('invalid_input', { field: 'glAccounts' });
  }
  const accounts = validateAccounts(ctx, {
    assetId: input.glAssetAccountId,
    accumId: input.glAccumDeprAccountId,
    expenseId: input.glDeprExpenseAccountId,
    costCenterId: input.defaultCostCenterId,
  });
  if (isResult(accounts)) return accounts;

  if (codeTaken(ctx, code)) return err('duplicate_code', { code });

  const run = (): Result => {
    // Re-check inside the transaction: two writers that both passed the read above cannot both seat
    // the code, because the DB UNIQUE index over lower(code) would throw on the second. The pre-check
    // gives the friendly error; this is the honest race window narrowed to nothing.
    if (codeTaken(ctx, code)) return err('duplicate_code', { code });
    const id = ctx.ids.next('asset_category');
    const now = ctx.clock.now();
    ctx.store.db
      .prepare(
        `INSERT INTO asset_category (
           id, workspace_id, code, name, description, depreciation_method, useful_life_months,
           residual_value_pct, residual_value_rappen, gl_asset_account_id, gl_accum_depr_account_id,
           gl_depr_expense_account_id, default_cost_center_id, active, created_at, updated_at, created_by
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      )
      .run(
        id,
        ctx.workspaceId,
        code,
        name,
        input.description ?? null,
        method,
        method === 'none' ? null : (input.usefulLifeMonths as number),
        input.residualValuePct ?? 0,
        input.residualValueRappen ?? null,
        input.glAssetAccountId,
        input.glAccumDeprAccountId,
        input.glDeprExpenseAccountId,
        input.defaultCostCenterId === '' ? null : input.defaultCostCenterId ?? null,
        now,
        now,
        ctx.actor,
      );
    return ok({ category: mapCategory(readCategory(ctx, id) as CategoryRow) });
  };

  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'asset_category_create', run);
  }
  return run();
}

export interface UpdateAssetCategoryInput {
  categoryId?: string;
  patch?: {
    name?: string;
    description?: string | null;
    depreciationMethod?: string;
    usefulLifeMonths?: number | null;
    residualValuePct?: number | null;
    residualValueRappen?: number | null;
    glAssetAccountId?: string;
    glAccumDeprAccountId?: string;
    glDeprExpenseAccountId?: string;
    defaultCostCenterId?: string | null;
  };
  idempotencyKey?: string;
}

export function updateAssetCategory(ctx: WorkspaceContext, input: UpdateAssetCategoryInput): Result {
  if (typeof input.categoryId !== 'string' || input.categoryId.length === 0) {
    return err('invalid_input', { field: 'categoryId' });
  }
  const current = readCategory(ctx, input.categoryId);
  if (current === undefined) return err('not_found', { categoryId: input.categoryId });
  const patch = input.patch ?? {};

  const name = patch.name !== undefined ? patch.name.trim() : current.name;
  if (name.length === 0) return err('invalid_input', { field: 'name' });

  const method = patch.depreciationMethod ?? current.depreciation_method;
  const usefulLifeMonths =
    patch.usefulLifeMonths !== undefined ? patch.usefulLifeMonths : current.useful_life_months;
  const residualValuePct =
    patch.residualValuePct !== undefined ? patch.residualValuePct : current.residual_value_pct;
  const residualValueRappen =
    patch.residualValueRappen !== undefined ? patch.residualValueRappen : current.residual_value_rappen;
  const deprErr = validateDepreciation({ method, usefulLifeMonths, residualValuePct, residualValueRappen });
  if (deprErr !== undefined) return deprErr;

  const assetId = patch.glAssetAccountId ?? current.gl_asset_account_id;
  const accumId = patch.glAccumDeprAccountId ?? current.gl_accum_depr_account_id;
  const expenseId = patch.glDeprExpenseAccountId ?? current.gl_depr_expense_account_id;
  const costCenterId =
    patch.defaultCostCenterId !== undefined ? patch.defaultCostCenterId : current.default_cost_center_id;
  const accounts = validateAccounts(ctx, { assetId, accumId, expenseId, costCenterId });
  if (isResult(accounts)) return accounts;

  const description = patch.description !== undefined ? patch.description : current.description;

  const run = (): Result => {
    ctx.store.db
      .prepare(
        `UPDATE asset_category SET
           name = ?, description = ?, depreciation_method = ?, useful_life_months = ?,
           residual_value_pct = ?, residual_value_rappen = ?, gl_asset_account_id = ?,
           gl_accum_depr_account_id = ?, gl_depr_expense_account_id = ?, default_cost_center_id = ?,
           updated_at = ?
         WHERE workspace_id = ? AND id = ?`,
      )
      .run(
        name,
        description,
        method,
        method === 'none' ? null : usefulLifeMonths,
        residualValuePct ?? 0,
        residualValueRappen,
        assetId,
        accumId,
        expenseId,
        costCenterId === '' ? null : costCenterId,
        ctx.clock.now(),
        ctx.workspaceId,
        input.categoryId,
      );
    return ok({ category: mapCategory(readCategory(ctx, input.categoryId as string) as CategoryRow) });
  };

  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'asset_category_update', run);
  }
  return run();
}

export function archiveAssetCategory(
  ctx: WorkspaceContext,
  input: { categoryId?: string; idempotencyKey?: string },
): Result {
  if (typeof input.categoryId !== 'string' || input.categoryId.length === 0) {
    return err('invalid_input', { field: 'categoryId' });
  }
  const run = (): Result => {
    const current = readCategory(ctx, input.categoryId as string);
    if (current === undefined) return err('not_found', { categoryId: input.categoryId });
    // §5: deletion is never offered. A category still referenced by any asset (even a disposed one)
    // cannot be archived either, because archiving it would remove it from the picker while an asset
    // depends on it. Reassign the assets first.
    if (categoryReferencedByAsset(ctx, input.categoryId as string)) {
      return err('category_in_use', { categoryId: input.categoryId });
    }
    if (current.active === 1) {
      ctx.store.db
        .prepare('UPDATE asset_category SET active = 0, updated_at = ? WHERE workspace_id = ? AND id = ?')
        .run(ctx.clock.now(), ctx.workspaceId, input.categoryId);
    }
    return ok({ category: mapCategory(readCategory(ctx, input.categoryId as string) as CategoryRow) });
  };

  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'asset_category_archive', run);
  }
  return run();
}

export interface ListAssetCategoriesInput {
  active?: boolean;
  search?: string;
  savedViewId?: string;
}

export function listAssetCategories(ctx: WorkspaceContext, input: ListAssetCategoriesInput = {}): Result {
  const clauses = ['workspace_id = ?'];
  const params: unknown[] = [ctx.workspaceId];
  if (typeof input.active === 'boolean') {
    clauses.push('active = ?');
    params.push(input.active ? 1 : 0);
  }
  if (typeof input.search === 'string' && input.search.trim().length > 0) {
    clauses.push('(lower(code) LIKE ? OR lower(name) LIKE ?)');
    const like = `%${input.search.trim().toLowerCase()}%`;
    params.push(like, like);
  }
  const rows = ctx.store.db
    .prepare(`SELECT * FROM asset_category WHERE ${clauses.join(' AND ')} ORDER BY code`)
    .all(...params) as CategoryRow[];
  return ok({ categories: rows.map(mapCategory) });
}

export function getAssetCategory(ctx: WorkspaceContext, input: { categoryId?: string }): Result {
  if (typeof input.categoryId !== 'string' || input.categoryId.length === 0) {
    return err('invalid_input', { field: 'categoryId' });
  }
  const row = readCategory(ctx, input.categoryId);
  if (row === undefined) return err('not_found', { categoryId: input.categoryId });
  return ok({ category: mapCategory(row) });
}

/**
 * US-H00.4, the agent-primary resolver H01 depends on. Returns the FULL default set an asset
 * inherits: the depreciation trio, the three GL accounts as id + number + name (so the caller need
 * not re-read A01), and the optional cost centre. An archived category is refused so an agent never
 * silently creates an asset under a retired default (a historical asset already carrying it resolves
 * fine through `getAssetCategory`; this verb is the CREATE-time resolver).
 */
export function resolveAssetCategoryDefaults(
  ctx: WorkspaceContext,
  input: { categoryId?: string },
): Result {
  if (typeof input.categoryId !== 'string' || input.categoryId.length === 0) {
    return err('invalid_input', { field: 'categoryId' });
  }
  const row = readCategory(ctx, input.categoryId);
  if (row === undefined) return err('not_found', { categoryId: input.categoryId });
  if (row.active !== 1) return err('category_archived', { categoryId: input.categoryId });

  const assetAcc = readAccount(ctx, row.gl_asset_account_id);
  const accumAcc = readAccount(ctx, row.gl_accum_depr_account_id);
  const expenseAcc = readAccount(ctx, row.gl_depr_expense_account_id);
  const cc =
    row.default_cost_center_id === null
      ? undefined
      : (ctx.store.db
          .prepare('SELECT id, code, name FROM cost_center WHERE workspace_id = ? AND id = ?')
          .get(ctx.workspaceId, row.default_cost_center_id) as
          | { id: string; code: string; name: string }
          | undefined);

  return ok({
    defaults: {
      categoryId: row.id,
      code: row.code,
      name: row.name,
      depreciationMethod: row.depreciation_method,
      usefulLifeMonths: row.useful_life_months,
      residualValuePct: row.residual_value_pct,
      residualValueRappen: row.residual_value_rappen,
      glAssetAccount: assetAcc ? { id: assetAcc.id, number: assetAcc.number, name: assetAcc.name } : null,
      glAccumDeprAccount: accumAcc ? { id: accumAcc.id, number: accumAcc.number, name: accumAcc.name } : null,
      glDeprExpenseAccount: expenseAcc
        ? { id: expenseAcc.id, number: expenseAcc.number, name: expenseAcc.name }
        : null,
      defaultCostCenter: cc ? { id: cc.id, code: cc.code, name: cc.name } : null,
    },
  });
}
