// H01, the Asset Master: the engine invariants the capability and the money-path gate depend on.
//
// Proves every §2/§7 rule that H01 can own end to end today: create-from-category with default
// inheritance and creation-time overrides, the validation set (missing date, non-positive cost,
// archived category, duplicate number), full-text search and structured filters, soft-archive with
// the in-use guard, and the four load-bearing invariants a NON-AUTHOR critic will mutation-test:
//
//   1. FINANCIAL-FIELD IMMUTABILITY. Once a financial event exists (status leaves draft, which is
//      exactly what a posted acquisition does), the baseline fields are frozen and asset_update
//      returns financial_fields_locked and writes NOTHING. The lock is exercised the way H00's
//      in-use guard was: the test stands the asset into `active` directly (simulating H02), because
//      H02 is not built yet. Each locked field is checked individually, and the "writes nothing"
//      half is proven by re-reading the row after the refusal.
//   2. §H-TENANT. A foreign workspace never resolves an asset: reads are not_found and a
//      cross-workspace update/archive is impossible.
//   3. POSTS NOTHING. Creating/updating an asset writes not one journal_entry row (P3 by absence):
//      H01 is master data, the acquisition journal is H02.
//   4. IDEMPOTENCY ON ROWS. The same key posts one asset and replays its result.

import test from 'node:test';
import assert from 'node:assert/strict';

import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { makeContext } from '../../dist/core/context.js';
import { fixedClock } from '../../dist/core/clock.js';
import { sequenceIdGen } from '../../dist/core/ids.js';
import { createWorkspace } from '../../dist/core/setup/index.js';
import { createAssetCategory, archiveAssetCategory } from '../../dist/core/assets/index.js';
import {
  createAsset,
  updateAsset,
  getAsset,
  listAsset,
  searchAsset,
  archiveAsset,
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
  const category = (over = {}) => {
    const r = createAssetCategory(ctx, {
      code: 'MACH',
      name: 'Maschinen & Anlagen',
      depreciationMethod: 'straight_line',
      usefulLifeMonths: 60,
      residualValuePct: 1000,
      glAssetAccountId: acc('1500'),
      glAccumDeprAccountId: acc('1510'),
      glDeprExpenseAccountId: acc('6800'),
      idempotencyKey: `cat-${Math.random()}`,
      ...over,
    });
    assert.equal(r.ok, true, `category setup failed: ${JSON.stringify(r)}`);
    return r.category;
  };
  return { ctx, store, workspaceId, deps, acc, category };
}

function validAsset(categoryId, over = {}) {
  return {
    categoryId,
    name: 'CNC Fräsmaschine XYZ-2000',
    acquisitionDate: '2026-03-15',
    acquisitionCostRappen: 12_500_000,
    idempotencyKey: `as-${Math.random()}`,
    ...over,
  };
}

/** Count posted journal entries in a workspace, for the "posts nothing" invariant. */
function journalCount(store, workspaceId) {
  return store.db.prepare('SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ?').get(workspaceId).n;
}

// --- happy path + default inheritance (US-H01.1 / US-H01.4) -------------------------------------

test('create inherits the category defaults and generates a unique number', () => {
  const { ctx, category } = setup();
  const cat = category();
  const r = createAsset(ctx, validAsset(cat.id));
  assert.equal(r.ok, true);
  assert.equal(r.asset.name, 'CNC Fräsmaschine XYZ-2000');
  assert.equal(r.asset.status, 'draft');
  assert.equal(r.asset.categoryId, cat.id);
  // inherited from the category
  assert.equal(r.asset.depreciationMethod, 'straight_line');
  assert.equal(r.asset.usefulLifeMonths, 60);
  assert.equal(r.asset.glAssetAccountId, cat.glAssetAccountId);
  assert.equal(r.asset.glAccumDeprAccountId, cat.glAccumDeprAccountId);
  assert.equal(r.asset.glDeprExpenseAccountId, cat.glDeprExpenseAccountId);
  // residual pct 10% of 12'500'000 = 1'250'000 rappen, resolved to an absolute figure
  assert.equal(r.asset.residualValueRappen, 1_250_000);
  // NBV at creation = cost - accumulated(0)
  assert.equal(r.asset.netBookValueRappen, 12_500_000);
  assert.equal(r.asset.accumulatedDeprRappen, 0);
  assert.match(r.asset.number, /^FA-\d{4}$/);
});

test('a second asset gets a distinct generated number', () => {
  const { ctx, category } = setup();
  const cat = category();
  const a = createAsset(ctx, validAsset(cat.id));
  const b = createAsset(ctx, validAsset(cat.id, { name: 'Second' }));
  assert.notEqual(a.asset.number, b.asset.number);
});

test('creation-time overrides win over the inherited defaults', () => {
  const { ctx, acc, category } = setup();
  const cat = category();
  const r = createAsset(
    ctx,
    validAsset(cat.id, {
      depreciationMethod: 'declining_balance',
      usefulLifeMonths: 36,
      residualValueRappen: 500_000,
      glDeprExpenseAccountId: acc('6800'),
    }),
  );
  assert.equal(r.ok, true);
  assert.equal(r.asset.depreciationMethod, 'declining_balance');
  assert.equal(r.asset.usefulLifeMonths, 36);
  assert.equal(r.asset.residualValueRappen, 500_000);
});

test('a manual number is accepted and must be unique case-insensitively', () => {
  const { ctx, category } = setup();
  const cat = category();
  const a = createAsset(ctx, validAsset(cat.id, { number: 'INV-1' }));
  assert.equal(a.asset.number, 'INV-1');
  const dup = createAsset(ctx, validAsset(cat.id, { number: 'inv-1', name: 'Other' }));
  assert.equal(dup.ok, false);
  assert.equal(dup.error, 'duplicate_number');
});

// --- validation (US-H01.2) ----------------------------------------------------------------------

test('a missing acquisition date is missing_acquisition_date', () => {
  const { ctx, category } = setup();
  const cat = category();
  assert.equal(createAsset(ctx, validAsset(cat.id, { acquisitionDate: '' })).error, 'missing_acquisition_date');
});

test('a non-positive cost is invalid_cost and nothing is written', () => {
  const { ctx, category } = setup();
  const cat = category();
  assert.equal(createAsset(ctx, validAsset(cat.id, { acquisitionCostRappen: 0 })).error, 'invalid_cost');
  assert.equal(createAsset(ctx, validAsset(cat.id, { acquisitionCostRappen: -5 })).error, 'invalid_cost');
  assert.equal(listAsset(ctx).assets.length, 0);
});

test('an archived category is refused with category_archived', () => {
  const { ctx, category } = setup();
  const cat = category();
  archiveAssetCategory(ctx, { categoryId: cat.id, idempotencyKey: 'arch' });
  assert.equal(createAsset(ctx, validAsset(cat.id)).error, 'category_archived');
});

test('a residual above cost is refused', () => {
  const { ctx, category } = setup();
  const cat = category();
  const r = createAsset(ctx, validAsset(cat.id, { residualValueRappen: 99_000_000 }));
  assert.equal(r.ok, false);
  assert.equal(r.error, 'invalid_residual_rappen');
});

// --- INVARIANT 1: financial-field immutability (US-H01.2, §7) -----------------------------------

test('descriptive fields update freely while the asset is draft', () => {
  const { ctx, category } = setup();
  const cat = category();
  const a = createAsset(ctx, validAsset(cat.id));
  const u = updateAsset(ctx, {
    assetId: a.asset.id,
    patch: { name: 'Renamed', notes: 'in Halle 3', serialNumber: 'SN-42' },
    idempotencyKey: 'u1',
  });
  assert.equal(u.ok, true);
  assert.equal(u.asset.name, 'Renamed');
  assert.equal(u.asset.notes, 'in Halle 3');
  assert.equal(u.asset.serialNumber, 'SN-42');
});

test('financial fields may be corrected while still draft (no event yet)', () => {
  const { ctx, category } = setup();
  const cat = category();
  const a = createAsset(ctx, validAsset(cat.id));
  const u = updateAsset(ctx, {
    assetId: a.asset.id,
    patch: { acquisitionCostRappen: 9_000_000, usefulLifeMonths: 48 },
    idempotencyKey: 'u2',
  });
  assert.equal(u.ok, true);
  assert.equal(u.asset.acquisitionCostRappen, 9_000_000);
  assert.equal(u.asset.usefulLifeMonths, 48);
});

test('THE LOCK: once a financial event exists, every baseline field is frozen and the row is untouched', () => {
  const { ctx, store, workspaceId, acc, category } = setup();
  const cat = category();
  const a = createAsset(ctx, validAsset(cat.id));
  // Simulate H02: a posted acquisition moves the asset out of draft. H02 is not built, so we set the
  // status directly, exactly as H00's in-use test stood up the future asset table.
  store.db.prepare('UPDATE asset SET status = ? WHERE workspace_id = ? AND id = ?').run('active', workspaceId, a.asset.id);

  const before = getAsset(ctx, { assetId: a.asset.id }).asset;

  const lockedPatches = [
    { acquisitionCostRappen: 1 },
    { acquisitionDate: '2020-01-01' },
    { depreciationMethod: 'declining_balance' },
    { usefulLifeMonths: 12 },
    { residualValuePct: 5000 },
    { residualValueRappen: 1 },
    { glAssetAccountId: acc('1500') },
    { glAccumDeprAccountId: acc('1510') },
    { glDeprExpenseAccountId: acc('6800') },
  ];
  for (const patch of lockedPatches) {
    const r = updateAsset(ctx, { assetId: a.asset.id, patch, idempotencyKey: `lock-${Math.random()}` });
    assert.equal(r.ok, false, `patch ${JSON.stringify(patch)} should be refused`);
    assert.equal(r.error, 'financial_fields_locked', `patch ${JSON.stringify(patch)} error`);
  }
  // writes NOTHING: the row is byte-identical to before the refusals
  const after = getAsset(ctx, { assetId: a.asset.id }).asset;
  assert.deepEqual(after, before);
});

test('a descriptive update still succeeds after the asset leaves draft', () => {
  const { ctx, store, workspaceId, category } = setup();
  const cat = category();
  const a = createAsset(ctx, validAsset(cat.id));
  store.db.prepare('UPDATE asset SET status = ? WHERE workspace_id = ? AND id = ?').run('active', workspaceId, a.asset.id);
  const u = updateAsset(ctx, { assetId: a.asset.id, patch: { notes: 'moved to storage' }, idempotencyKey: 'd1' });
  assert.equal(u.ok, true);
  assert.equal(u.asset.notes, 'moved to storage');
});

// --- INVARIANT 2: §H-TENANT (US-H01.3 / §7) ----------------------------------------------------

test('assets are strictly workspace-scoped: a foreign id never resolves and cannot be mutated', () => {
  const { ctx, deps, category } = setup();
  const cat = category();
  const mine = createAsset(ctx, validAsset(cat.id));
  const other = makeContext(deps.store, {
    workspaceId: createWorkspace(deps, { name: 'Other AG' }).workspaceId,
    actor: 'u',
    clock: deps.clock,
    ids: deps.ids,
  });
  assert.equal(listAsset(other).assets.length, 0);
  assert.equal(getAsset(other, { assetId: mine.asset.id }).error, 'not_found');
  assert.equal(updateAsset(other, { assetId: mine.asset.id, patch: { name: 'hijack' }, idempotencyKey: 'x' }).error, 'not_found');
  assert.equal(archiveAsset(other, { assetId: mine.asset.id, idempotencyKey: 'x' }).error, 'not_found');
  // the real owner still sees the untouched name
  assert.equal(getAsset(ctx, { assetId: mine.asset.id }).asset.name, 'CNC Fräsmaschine XYZ-2000');
});

// --- INVARIANT 3: posts nothing (P3 by absence) ------------------------------------------------

test('creating and updating an asset posts not one journal entry', () => {
  const { ctx, store, workspaceId, category } = setup();
  const cat = category();
  assert.equal(journalCount(store, workspaceId), 0);
  const a = createAsset(ctx, validAsset(cat.id));
  updateAsset(ctx, { assetId: a.asset.id, patch: { name: 'x', acquisitionCostRappen: 7_000_000 }, idempotencyKey: 'p1' });
  archiveAsset(ctx, { assetId: a.asset.id, idempotencyKey: 'p2' });
  assert.equal(journalCount(store, workspaceId), 0);
});

// --- INVARIANT 4: idempotency on ROWS ----------------------------------------------------------

test('create is idempotent: the same key posts one asset and replays its result', () => {
  const { ctx, category } = setup();
  const cat = category();
  const input = validAsset(cat.id, { idempotencyKey: 'same' });
  const first = createAsset(ctx, input);
  const second = createAsset(ctx, input);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(second.asset.id, first.asset.id);
  assert.equal(listAsset(ctx).assets.length, 1);
});

test('a FAILED create is retryable under the same key (a rejection is never memoised)', () => {
  // The H01/H02 critic follow-up: `createAsset` runs its write inside `rememberIdempotent`. A rejection
  // discovered inside that write (a duplicate number) must NOT be stored, or a retry under the same key
  // would forever replay the stale error instead of accepting corrected input. The duplicate guard now
  // THROWS out of the transaction (rolled back, not memoised), so this retry is a real retry.
  const { ctx, category } = setup();
  const cat = category();
  createAsset(ctx, validAsset(cat.id, { number: 'INV-1', idempotencyKey: 'seed' }));
  const failed = createAsset(ctx, validAsset(cat.id, { number: 'INV-1', name: 'Dup', idempotencyKey: 'retryable' }));
  assert.equal(failed.ok, false);
  assert.equal(failed.error, 'duplicate_number');
  // Retry under the SAME key with a corrected number: it must succeed, not replay the stored failure.
  const retry = createAsset(ctx, validAsset(cat.id, { number: 'INV-2', name: 'Fixed', idempotencyKey: 'retryable' }));
  assert.equal(retry.ok, true, `the retry replayed a stale error: ${JSON.stringify(retry)}`);
  assert.equal(retry.asset.number, 'INV-2');
  // Exactly the two successful assets exist (INV-1 seed + INV-2 retry); the failed attempt wrote nothing.
  assert.equal(listAsset(ctx).assets.length, 2);
});

// --- search + filter (US-H01.3) ----------------------------------------------------------------

test('search matches number, name, serial and notes; filters scope the register', () => {
  const { ctx, category } = setup();
  const cat = category();
  const a = createAsset(ctx, validAsset(cat.id, { name: 'Lathe', serialNumber: 'ABC-999' }));
  createAsset(ctx, validAsset(cat.id, { name: 'Forklift', notes: 'yellow' }));
  assert.equal(searchAsset(ctx, { query: 'ABC-999' }).assets.length, 1);
  assert.equal(searchAsset(ctx, { query: 'forklift' }).assets.length, 1);
  assert.equal(searchAsset(ctx, { query: 'yellow' }).assets.length, 1);
  assert.equal(searchAsset(ctx, { query: '' }).assets.length, 0);
  // category filter returns both, acquisitionYear filter returns both (same date)
  assert.equal(listAsset(ctx, { categoryId: cat.id }).assets.length, 2);
  assert.equal(listAsset(ctx, { acquisitionYear: '2026' }).assets.length, 2);
  assert.equal(listAsset(ctx, { acquisitionYear: '2019' }).assets.length, 0);
  assert.equal(a.ok, true);
});

// --- archive rules (US-H01.5 / US-H01.6) -------------------------------------------------------

test('a draft asset archives; an active/fully_depreciated one is refused with asset_in_use', () => {
  const { ctx, store, workspaceId, category } = setup();
  const cat = category();
  const draft = createAsset(ctx, validAsset(cat.id));
  const ar = archiveAsset(ctx, { assetId: draft.asset.id, idempotencyKey: 'a1' });
  assert.equal(ar.ok, true);
  assert.equal(ar.asset.status, 'archived');
  // archived assets drop out of the default register
  assert.equal(listAsset(ctx).assets.length, 0);
  assert.equal(listAsset(ctx, { includeArchived: true }).assets.length, 1);

  const live = createAsset(ctx, validAsset(cat.id, { name: 'Live' }));
  store.db.prepare('UPDATE asset SET status = ? WHERE workspace_id = ? AND id = ?').run('active', workspaceId, live.asset.id);
  const refused = archiveAsset(ctx, { assetId: live.asset.id, idempotencyKey: 'a2' });
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'asset_in_use');
});

test('a disposed or archived asset refuses any update with asset_terminal', () => {
  const { ctx, store, workspaceId, category } = setup();
  const cat = category();
  const a = createAsset(ctx, validAsset(cat.id));
  store.db.prepare('UPDATE asset SET status = ? WHERE workspace_id = ? AND id = ?').run('disposed', workspaceId, a.asset.id);
  assert.equal(updateAsset(ctx, { assetId: a.asset.id, patch: { notes: 'x' }, idempotencyKey: 't1' }).error, 'asset_terminal');
});
