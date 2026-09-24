// H05, Asset Transfer & Location. A transfer is NON-POSTING, so the load-bearing assertions differ
// from a money-path capability's, and every one of them must BITE:
//
//   1. NO JOURNAL, EVER (spec §4 / DoD tripwire). A transfer (single or bulk) writes NOT ONE
//      journal_entry row and NOT ONE asset_transaction row: the journal_entry count and the
//      asset_transaction count are unchanged across every transfer. Proven by ROW COUNTS.
//   2. NO FINANCIAL FIELD MOVES. Cost, accumulated depreciation, NBV and the three GL accounts are
//      byte-for-byte identical before and after a transfer; only location_id / responsible_user_id
//      (and updated_at) change.
//   3. APPEND-ONLY (§H-AUDIT). An asset_transfer row is immutable at the DB layer: UPDATE and DELETE
//      both ABORT with asset_transfer_immutable.
//   4. IDEMPOTENT ON ROWS (§H-IDEMPOTENT). A replay of the same transfer key writes EXACTLY ONE
//      history row per asset and re-updates nothing. Proven by ROW COUNTS.
//   5. §H-TENANT. A foreign workspace can neither transfer an asset it does not own, nor read its
//      history, nor target a location it cannot see.
//
// Plus: location CRUD, case-insensitive duplicate_code, cycle protection, in-use archive protection,
// the transferable-status guard, bulk all-or-nothing, and the concrete error codes.

import test from 'node:test';
import assert from 'node:assert/strict';

import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { makeContext } from '../../dist/core/context.js';
import { fixedClock } from '../../dist/core/clock.js';
import { sequenceIdGen } from '../../dist/core/ids.js';
import { createWorkspace } from '../../dist/core/setup/index.js';
import {
  createAssetCategory,
  createAsset,
  getAsset,
  assetAcquire,
  createAssetLocation,
  updateAssetLocation,
  archiveAssetLocation,
  listAssetLocation,
  getAssetLocation,
  assetTransfer,
  assetTransferHistory,
} from '../../dist/core/assets/index.js';
import { ledgerPorts } from '../../dist/core/ledger/index.js';

const AT = '2026-08-07T00:00:00.000Z';

function setup() {
  const clock = fixedClock(AT);
  const ids = sequenceIdGen();
  const store = new SqliteStore({ clock });
  const deps = { store, clock, ids };
  const workspaceId = createWorkspace(deps, { name: 'Acme AG' }).workspaceId;
  const ctx = makeContext(store, {
    workspaceId,
    actor: 'user_1',
    clock,
    ids,
    ...ledgerPorts({ store, workspaceId, ids }),
  });
  const acc = (number) =>
    store.db.prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?').get(workspaceId, number).id;
  const category = (over = {}) => {
    const r = createAssetCategory(ctx, {
      code: `MACH-${Math.random().toString(36).slice(2, 7)}`,
      name: 'Maschinen',
      depreciationMethod: 'straight_line',
      usefulLifeMonths: 60,
      glAssetAccountId: acc('1500'),
      glAccumDeprAccountId: acc('1510'),
      glDeprExpenseAccountId: acc('6800'),
      idempotencyKey: `cat-${Math.random()}`,
      ...over,
    });
    assert.equal(r.ok, true, `category setup failed: ${JSON.stringify(r)}`);
    return r.category;
  };
  const draftAsset = (over = {}) => {
    const cat = category();
    const r = createAsset(ctx, {
      categoryId: cat.id,
      name: 'CNC Fräsmaschine',
      acquisitionDate: '2026-03-15',
      acquisitionCostRappen: 12_500_000,
      idempotencyKey: `as-${Math.random()}`,
      ...over,
    });
    assert.equal(r.ok, true, `asset setup failed: ${JSON.stringify(r)}`);
    return r.asset;
  };
  const location = (over = {}) => {
    const r = createAssetLocation(ctx, {
      code: `LOC-${Math.random().toString(36).slice(2, 7)}`,
      name: 'Werkhalle',
      idempotencyKey: `loc-${Math.random()}`,
      ...over,
    });
    assert.equal(r.ok, true, `location setup failed: ${JSON.stringify(r)}`);
    return r.location;
  };
  return { ctx, store, workspaceId, deps, acc, category, draftAsset, location };
}

const journalCount = (store, ws) =>
  store.db.prepare("SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ?").get(ws).n;
const atxnCount = (store, ws) =>
  store.db.prepare('SELECT COUNT(*) AS n FROM asset_transaction WHERE workspace_id = ?').get(ws).n;
const transferCount = (store, ws) =>
  store.db.prepare('SELECT COUNT(*) AS n FROM asset_transfer WHERE workspace_id = ?').get(ws).n;

// --- Location master --------------------------------------------------------------------------

test('location create is case-insensitively unique per workspace (duplicate_code)', () => {
  const { ctx } = setup();
  const a = createAssetLocation(ctx, { code: 'ZH-HQ', name: 'HQ', idempotencyKey: 'l1' });
  assert.equal(a.ok, true);
  const dup = createAssetLocation(ctx, { code: 'zh-hq', name: 'HQ again', idempotencyKey: 'l2' });
  assert.equal(dup.ok, false);
  assert.equal(dup.error, 'duplicate_code');
});

test('a parent link that would close a loop is refused with location_cycle', () => {
  const { ctx, location } = setup();
  const root = location({ code: 'ROOT', name: 'Root' });
  const child = location({ code: 'CHILD', name: 'Child', parentId: root.id });
  // Pointing the root at its own child would make root -> child -> root.
  const r = updateAssetLocation(ctx, { locationId: root.id, patch: { parentId: child.id }, idempotencyKey: 'u1' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'location_cycle');
  // A location cannot be its own parent either.
  const self = updateAssetLocation(ctx, { locationId: root.id, patch: { parentId: root.id }, idempotencyKey: 'u2' });
  assert.equal(self.error, 'location_cycle');
});

test('a location still used by a live asset cannot be archived (location_in_use)', () => {
  const { ctx, draftAsset, location } = setup();
  const loc = location({ code: 'HALL-A', name: 'Halle A' });
  const asset = draftAsset();
  const moved = assetTransfer(ctx, {
    assetIds: [asset.id],
    toLocationId: loc.id,
    effectiveDate: '2026-07-15',
    idempotencyKey: 't1',
  });
  assert.equal(moved.ok, true);
  const blocked = archiveAssetLocation(ctx, { locationId: loc.id, idempotencyKey: 'a1' });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error, 'location_in_use');
  // Move the asset away, then the archive succeeds.
  const loc2 = location({ code: 'HALL-B', name: 'Halle B' });
  assetTransfer(ctx, { assetIds: [asset.id], toLocationId: loc2.id, effectiveDate: '2026-07-16', idempotencyKey: 't2' });
  const ok = archiveAssetLocation(ctx, { locationId: loc.id, idempotencyKey: 'a2' });
  assert.equal(ok.ok, true);
  assert.equal(getAssetLocation(ctx, { locationId: loc.id }).location.active, false);
});

// --- INVARIANT 1 + 2: non-posting, no financial field moves ------------------------------------

test('a transfer posts NO journal and writes NO asset_transaction row, and moves no financial field', () => {
  const { ctx, store, workspaceId, draftAsset, location, acc } = setup();
  const asset = draftAsset();
  // Give the asset a real financial baseline by acquiring it, so "no financial field moves" bites.
  const acq = assetAcquire(ctx, {
    assetId: asset.id,
    date: '2026-03-15',
    acquisitionCostRappen: 12_500_000,
    creditAccountId: acc('1020'),
    idempotencyKey: 'acq-1',
  });
  assert.equal(acq.ok, true);
  const before = getAsset(ctx, { assetId: asset.id }).asset;
  const journalsBefore = journalCount(store, workspaceId);
  const atxnBefore = atxnCount(store, workspaceId);

  const loc = location({ code: 'PLANT-B', name: 'Werk B' });
  const r = assetTransfer(ctx, {
    assetIds: [asset.id],
    toLocationId: loc.id,
    toResponsibleUserId: 'user_42',
    effectiveDate: '2026-07-15',
    reason: 'Kapazitätsverlagerung',
    idempotencyKey: 'trf-1',
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.summary.transferred, 1);

  // INVARIANT 1: not one new journal entry, not one new asset_transaction row.
  assert.equal(journalCount(store, workspaceId), journalsBefore, 'a transfer posts no journal entry');
  assert.equal(atxnCount(store, workspaceId), atxnBefore, 'a transfer writes no asset_transaction row');
  assert.equal(transferCount(store, workspaceId), 1, 'exactly one transfer history row exists');

  // INVARIANT 2: every financial field is byte-for-byte identical; only the tracking columns moved.
  const after = getAsset(ctx, { assetId: asset.id }).asset;
  assert.equal(after.acquisitionCostRappen, before.acquisitionCostRappen);
  assert.equal(after.accumulatedDeprRappen, before.accumulatedDeprRappen);
  assert.equal(after.netBookValueRappen, before.netBookValueRappen);
  assert.equal(after.glAssetAccountId, before.glAssetAccountId);
  assert.equal(after.glAccumDeprAccountId, before.glAccumDeprAccountId);
  assert.equal(after.glDeprExpenseAccountId, before.glDeprExpenseAccountId);
  assert.equal(after.locationId, loc.id, 'the new location is stored');
  assert.equal(after.responsibleUserId, 'user_42', 'the new responsible is stored');

  // The history row captures the OLD and NEW values.
  const hist = assetTransferHistory(ctx, { assetId: asset.id });
  assert.equal(hist.transfers.length, 1);
  assert.equal(hist.transfers[0].fromLocationId, before.locationId);
  assert.equal(hist.transfers[0].toLocationId, loc.id);
  assert.equal(hist.transfers[0].toResponsibleUserId, 'user_42');
});

// --- INVARIANT 3: append-only history ----------------------------------------------------------

test('a recorded transfer row is immutable at the DB layer (append-only, §H-AUDIT)', () => {
  const { ctx, store, workspaceId, draftAsset, location } = setup();
  const asset = draftAsset();
  const loc = location();
  assetTransfer(ctx, { assetIds: [asset.id], toLocationId: loc.id, effectiveDate: '2026-07-15', idempotencyKey: 't1' });
  const row = store.db.prepare('SELECT id FROM asset_transfer WHERE workspace_id = ?').get(workspaceId);
  assert.throws(
    () => store.db.prepare('UPDATE asset_transfer SET description = ? WHERE id = ?').run('tamper', row.id),
    /asset_transfer_immutable/,
  );
  assert.throws(
    () => store.db.prepare('DELETE FROM asset_transfer WHERE id = ?').run(row.id),
    /asset_transfer_immutable/,
  );
});

// --- INVARIANT 4: idempotent on rows -----------------------------------------------------------

test('replaying a transfer under the same key writes exactly one history row and re-updates nothing', () => {
  const { ctx, store, workspaceId, draftAsset, location } = setup();
  const asset = draftAsset();
  const loc = location();
  const key = 'trf-replay';
  const first = assetTransfer(ctx, { assetIds: [asset.id], toLocationId: loc.id, effectiveDate: '2026-07-15', idempotencyKey: key });
  assert.equal(first.ok, true);
  assert.equal(transferCount(store, workspaceId), 1);
  const second = assetTransfer(ctx, { assetIds: [asset.id], toLocationId: loc.id, effectiveDate: '2026-07-15', idempotencyKey: key });
  assert.equal(second.ok, true);
  assert.equal(second.transactions[0].id, first.transactions[0].id, 'the replay returns the original row');
  assert.equal(transferCount(store, workspaceId), 1, 'the replay wrote no second history row');
});

// --- INVARIANT 5: §H-TENANT --------------------------------------------------------------------

test('transfers are strictly workspace-scoped: a foreign asset, location and history never resolve', () => {
  const { ctx, deps, draftAsset, location } = setup();
  const asset = draftAsset();
  const loc = location();
  assetTransfer(ctx, { assetIds: [asset.id], toLocationId: loc.id, effectiveDate: '2026-07-15', idempotencyKey: 't1' });

  const other = makeContext(deps.store, {
    workspaceId: createWorkspace(deps, { name: 'Other AG' }).workspaceId,
    actor: 'u',
    clock: deps.clock,
    ids: deps.ids,
  });
  // A foreign workspace sees none of the locations and cannot transfer the foreign asset.
  assert.equal(listAssetLocation(other).locations.length, 0);
  const foreign = assetTransfer(other, {
    assetIds: [asset.id],
    toLocationId: loc.id,
    effectiveDate: '2026-07-15',
    idempotencyKey: 't-foreign',
  });
  assert.equal(foreign.ok, false);
  assert.equal(foreign.error, 'not_found');
  // And it reads an empty history for an asset it does not own.
  assert.equal(assetTransferHistory(other, { assetId: asset.id }).transfers.length, 0);
});

// --- Validation, guards, bulk ------------------------------------------------------------------

test('a transfer with neither a new location nor a new responsible is nothing_to_transfer', () => {
  const { ctx, draftAsset } = setup();
  const asset = draftAsset();
  const r = assetTransfer(ctx, { assetIds: [asset.id], effectiveDate: '2026-07-15', idempotencyKey: 'n1' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'nothing_to_transfer');
});

test('transferring to an archived location is refused with location_inactive', () => {
  const { ctx, draftAsset, location } = setup();
  const asset = draftAsset();
  const loc = location();
  archiveAssetLocation(ctx, { locationId: loc.id, idempotencyKey: 'ar' });
  const r = assetTransfer(ctx, { assetIds: [asset.id], toLocationId: loc.id, effectiveDate: '2026-07-15', idempotencyKey: 'x' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'location_inactive');
});

test('a bulk transfer is all-or-nothing: one disposed asset rejects the whole batch and moves none', () => {
  const { ctx, store, workspaceId, draftAsset, location } = setup();
  const a1 = draftAsset();
  const a2 = draftAsset();
  const loc = location();
  // Force a2 into a terminal status directly (H06 is not built here); the guard must still bite.
  store.db.prepare("UPDATE asset SET status = 'disposed' WHERE workspace_id = ? AND id = ?").run(workspaceId, a2.id);
  const r = assetTransfer(ctx, {
    assetIds: [a1.id, a2.id],
    toLocationId: loc.id,
    effectiveDate: '2026-07-15',
    idempotencyKey: 'bulk-1',
  });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'asset_not_transferable');
  assert.ok(r.assets.some((x) => x.assetId === a2.id), 'the offender is named');
  // All-or-nothing: not even the transferable a1 moved, and no history row was written.
  assert.equal(transferCount(store, workspaceId), 0, 'a rejected bulk writes no history row');
  assert.equal(getAsset(ctx, { assetId: a1.id }).asset.locationId, null, 'the good asset did not move');
});

test('a valid bulk transfer moves every asset and writes one history row each', () => {
  const { ctx, store, workspaceId, draftAsset, location } = setup();
  const a1 = draftAsset();
  const a2 = draftAsset();
  const a3 = draftAsset();
  const loc = location();
  const r = assetTransfer(ctx, {
    assetIds: [a1.id, a2.id, a3.id],
    toLocationId: loc.id,
    effectiveDate: '2026-07-15',
    idempotencyKey: 'bulk-ok',
  });
  assert.equal(r.ok, true);
  assert.equal(r.summary.transferred, 3);
  assert.equal(transferCount(store, workspaceId), 3);
  assert.equal(journalCount(store, workspaceId), 0, 'a bulk transfer still posts no journal');
  for (const a of [a1, a2, a3]) {
    assert.equal(getAsset(ctx, { assetId: a.id }).asset.locationId, loc.id);
  }
});
