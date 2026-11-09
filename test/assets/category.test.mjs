// H00, fixed-asset categories & defaults: the engine invariants H01 and the wave gate depend on.
//
// Proves every §2/§7 rule: happy create with defaults, the validation set (account type, useful
// life, residual bounds, duplicate code case-insensitively), §H-TENANT on every read/write, the
// soft-archive + in-use protection, the archived-resolve refusal, and idempotency on ROWS. H00 has
// NO posting path (P3 by absence): a category is pre-financial master data, so there is no ledger
// assertion here.

import test from 'node:test';
import assert from 'node:assert/strict';

import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { makeContext } from '../../dist/core/context.js';
import { fixedClock } from '../../dist/core/clock.js';
import { sequenceIdGen } from '../../dist/core/ids.js';
import { createWorkspace } from '../../dist/core/setup/index.js';
import { createCostCenter } from '../../dist/core/accounts/index.js';
import {
  createAssetCategory,
  updateAssetCategory,
  archiveAssetCategory,
  listAssetCategories,
  getAssetCategory,
  resolveAssetCategoryDefaults,
  createAsset,
} from '../../dist/core/assets/index.js';

const AT = '2026-08-07T00:00:00.000Z';

function setup() {
  const clock = fixedClock(AT);
  const ids = sequenceIdGen();
  const store = new SqliteStore({ clock });
  const deps = { store, clock, ids };
  const workspaceId = createWorkspace(deps, { name: 'Acme AG' }).workspaceId;
  const ctx = makeContext(store, { workspaceId, actor: 'user_1', clock, ids });
  const acc = (number) =>
    store.db.prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?').get(workspaceId, number).id;
  return { ctx, store, workspaceId, deps, acc };
}

/** A valid create input, overridable per test. Uses the KMU seed: 1500 asset, 1510 asset (contra),
 * 6800 expense. */
function validInput(acc, over = {}) {
  return {
    code: 'MACH',
    name: 'Maschinen & Anlagen',
    depreciationMethod: 'straight_line',
    usefulLifeMonths: 60,
    residualValuePct: 1000,
    glAssetAccountId: acc('1500'),
    glAccumDeprAccountId: acc('1510'),
    glDeprExpenseAccountId: acc('6800'),
    idempotencyKey: 'c-seed',
    ...over,
  };
}

// --- happy path + defaults inheritance (US-H00.1 / US-H00.4) ------------------------------------

test('create writes an active category and resolve_defaults returns the full inherited set', () => {
  const { ctx, acc } = setup();
  const created = createAssetCategory(ctx, validInput(acc));
  assert.equal(created.ok, true);
  assert.equal(created.category.code, 'MACH');
  assert.equal(created.category.active, true);
  assert.equal(created.category.depreciationMethod, 'straight_line');
  assert.equal(created.category.usefulLifeMonths, 60);
  assert.equal(created.category.residualValuePct, 1000);

  const resolved = resolveAssetCategoryDefaults(ctx, { categoryId: created.category.id });
  assert.equal(resolved.ok, true);
  const d = resolved.defaults;
  assert.equal(d.depreciationMethod, 'straight_line');
  assert.equal(d.usefulLifeMonths, 60);
  assert.equal(d.residualValuePct, 1000);
  assert.equal(d.glAssetAccount.number, '1500');
  assert.equal(d.glAccumDeprAccount.number, '1510');
  assert.equal(d.glDeprExpenseAccount.number, '6800');
  assert.equal(d.defaultCostCenter, null);
});

test('a residual_value_rappen overrides the pct and round-trips', () => {
  const { ctx, acc } = setup();
  const c = createAssetCategory(ctx, validInput(acc, { residualValueRappen: 50000, idempotencyKey: 'rr' }));
  assert.equal(c.ok, true);
  assert.equal(c.category.residualValueRappen, 50000);
});

test('a default cost centre resolves with its code and name', () => {
  const { ctx, acc, workspaceId } = setup();
  const cc = createCostCenter(ctx, { workspaceId, code: 'CC1', name: 'Produktion' });
  assert.equal(cc.ok, true);
  const c = createAssetCategory(ctx, validInput(acc, { defaultCostCenterId: cc.costCenterId, idempotencyKey: 'cc' }));
  assert.equal(c.ok, true);
  const d = resolveAssetCategoryDefaults(ctx, { categoryId: c.category.id });
  assert.equal(d.defaults.defaultCostCenter.code, 'CC1');
  assert.equal(d.defaults.defaultCostCenter.name, 'Produktion');
});

// --- validation (US-H00.2) ---------------------------------------------------------------------

test('an asset account of the wrong type is refused with invalid_account_type before any write', () => {
  const { ctx, acc } = setup();
  const r = createAssetCategory(ctx, validInput(acc, { glAssetAccountId: acc('6800') }));
  assert.equal(r.ok, false);
  assert.equal(r.error, 'invalid_account_type');
  assert.equal(r.field, 'glAssetAccountId');
  // nothing written
  assert.equal(listAssetCategories(ctx).categories.length, 0);
});

test('an expense account of the wrong type is refused with invalid_account_type', () => {
  const { ctx, acc } = setup();
  const r = createAssetCategory(ctx, validInput(acc, { glDeprExpenseAccountId: acc('1500') }));
  assert.equal(r.ok, false);
  assert.equal(r.error, 'invalid_account_type');
  assert.equal(r.field, 'glDeprExpenseAccountId');
});

test('the accum-depr account admits an asset or a liability contra, and refuses income/expense', () => {
  const { ctx, acc } = setup();
  // liability accepted (2000 Verbindlichkeiten)
  const ok = createAssetCategory(ctx, validInput(acc, { glAccumDeprAccountId: acc('2000'), idempotencyKey: 'ok' }));
  assert.equal(ok.ok, true);
  // expense refused
  const bad = createAssetCategory(ctx, validInput(acc, { code: 'X', glAccumDeprAccountId: acc('6800'), idempotencyKey: 'bad' }));
  assert.equal(bad.ok, false);
  assert.equal(bad.error, 'invalid_account_type');
  assert.equal(bad.field, 'glAccumDeprAccountId');
});

test('a depreciating method with no useful life is missing_useful_life; a non-positive one is invalid', () => {
  const { ctx, acc } = setup();
  const missing = createAssetCategory(ctx, validInput(acc, { usefulLifeMonths: undefined, idempotencyKey: 'm' }));
  assert.equal(missing.error, 'missing_useful_life');
  const zero = createAssetCategory(ctx, validInput(acc, { usefulLifeMonths: 0, idempotencyKey: 'z' }));
  assert.equal(zero.error, 'invalid_useful_life');
});

test("method 'none' needs no useful life", () => {
  const { ctx, acc } = setup();
  const r = createAssetCategory(ctx, validInput(acc, { depreciationMethod: 'none', usefulLifeMonths: undefined, idempotencyKey: 'n' }));
  assert.equal(r.ok, true);
  assert.equal(r.category.usefulLifeMonths, null);
});

test('a residual pct out of [0,10000] is invalid_residual_pct', () => {
  const { ctx, acc } = setup();
  assert.equal(createAssetCategory(ctx, validInput(acc, { residualValuePct: 10001, idempotencyKey: 'a' })).error, 'invalid_residual_pct');
  assert.equal(createAssetCategory(ctx, validInput(acc, { residualValuePct: -1, idempotencyKey: 'b' })).error, 'invalid_residual_pct');
});

test('an unregistered method is invalid_method', () => {
  const { ctx, acc } = setup();
  assert.equal(createAssetCategory(ctx, validInput(acc, { depreciationMethod: 'sum_of_years' })).error, 'invalid_method');
});

test('a duplicate code is refused case-insensitively', () => {
  const { ctx, acc } = setup();
  assert.equal(createAssetCategory(ctx, validInput(acc, { idempotencyKey: '1' })).ok, true);
  const dup = createAssetCategory(ctx, validInput(acc, { code: 'mach', idempotencyKey: '2' }));
  assert.equal(dup.ok, false);
  assert.equal(dup.error, 'duplicate_code');
});

// --- §H-TENANT (US-H00.3) ----------------------------------------------------------------------

test('categories are strictly workspace-scoped: a foreign id never resolves', () => {
  const { ctx, acc, deps } = setup();
  const mine = createAssetCategory(ctx, validInput(acc));
  const other = makeContext(deps.store, { workspaceId: createWorkspace(deps, { name: 'Other AG' }).workspaceId, actor: 'u', clock: deps.clock, ids: deps.ids });
  assert.equal(listAssetCategories(other).categories.length, 0);
  assert.equal(getAssetCategory(other, { categoryId: mine.category.id }).error, 'not_found');
  assert.equal(resolveAssetCategoryDefaults(other, { categoryId: mine.category.id }).error, 'not_found');
});

// --- archive + in-use protection (US-H00.5 / §7) -----------------------------------------------

test('archive flips active to false and removes the category from the active picker', () => {
  const { ctx, acc } = setup();
  const c = createAssetCategory(ctx, validInput(acc));
  const a = archiveAssetCategory(ctx, { categoryId: c.category.id, idempotencyKey: 'ar' });
  assert.equal(a.ok, true);
  assert.equal(a.category.active, false);
  assert.equal(listAssetCategories(ctx, { active: true }).categories.length, 0);
  assert.equal(listAssetCategories(ctx, { active: false }).categories.length, 1);
});

test('resolve_defaults refuses an archived category with category_archived; get still reads it', () => {
  const { ctx, acc } = setup();
  const c = createAssetCategory(ctx, validInput(acc));
  archiveAssetCategory(ctx, { categoryId: c.category.id, idempotencyKey: 'ar' });
  assert.equal(resolveAssetCategoryDefaults(ctx, { categoryId: c.category.id }).error, 'category_archived');
  assert.equal(getAssetCategory(ctx, { categoryId: c.category.id }).ok, true);
});

test('a category referenced by an asset cannot be archived (category_in_use)', () => {
  const { ctx, acc } = setup();
  const c = createAssetCategory(ctx, validInput(acc));
  // H01 is built now: create a REAL asset under the category so the §7 tripwire bites on real data.
  const asset = createAsset(ctx, {
    categoryId: c.category.id,
    name: 'CNC',
    acquisitionDate: '2026-03-15',
    acquisitionCostRappen: 500000,
    idempotencyKey: 'as-seed',
  });
  assert.equal(asset.ok, true);
  const a = archiveAssetCategory(ctx, { categoryId: c.category.id, idempotencyKey: 'ar' });
  assert.equal(a.ok, false);
  assert.equal(a.error, 'category_in_use');
  // still active
  assert.equal(getAssetCategory(ctx, { categoryId: c.category.id }).category.active, true);
});

// --- update (US-H00.1 edit) --------------------------------------------------------------------

test('update applies a patch and re-runs the same validation', () => {
  const { ctx, acc } = setup();
  const c = createAssetCategory(ctx, validInput(acc));
  const u = updateAssetCategory(ctx, { categoryId: c.category.id, patch: { residualValuePct: 500, name: 'Maschinen' }, idempotencyKey: 'u1' });
  assert.equal(u.ok, true);
  assert.equal(u.category.residualValuePct, 500);
  assert.equal(u.category.name, 'Maschinen');
  // a bad account type on update is refused too
  const bad = updateAssetCategory(ctx, { categoryId: c.category.id, patch: { glAssetAccountId: acc('6800') }, idempotencyKey: 'u2' });
  assert.equal(bad.error, 'invalid_account_type');
});

// --- idempotency on ROWS -----------------------------------------------------------------------

test('create is idempotent: the same key posts one row and replays its result', () => {
  const { ctx, acc } = setup();
  const first = createAssetCategory(ctx, validInput(acc, { idempotencyKey: 'same' }));
  const second = createAssetCategory(ctx, validInput(acc, { idempotencyKey: 'same' }));
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(second.category.id, first.category.id);
  assert.equal(listAssetCategories(ctx).categories.length, 1);
});
