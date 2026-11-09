// H08, Simple Maintenance Log. The log is NON-POSTING and append-oriented, so the load-bearing
// assertions differ from a money-path capability's, and every one must BITE:
//
//   1. NON-POSTING (spec §1/§4). No create/update/cancel EVER writes a journal_entry or an
//      asset_transaction row: both counts are unchanged across the whole lifecycle. Proven by ROW COUNTS.
//   2. §H-TENANT. A log created in W1 is never returned, read, updated or cancelled from W2.
//   3. IDEMPOTENT ON ROWS (§H-IDEMPOTENT). A replay of a create/cancel key writes EXACTLY ONE row and
//      re-updates nothing. Proven by ROW COUNTS.
//   4. APPEND-ORIENTED. A row is updated (descriptive) and cancelled (status) but NEVER hard-deleted:
//      a raw DELETE ABORTs with asset_maintenance_log_immutable.
//   5. THE SOFT-EDIT WINDOW BITES. An update after 90 days is refused with log_locked; cancel still works.
//   6. THE COST ROLL-UP equals the SUM of completed entries' cost_rappen (never a cancelled or null one).
//
// Plus: the validation codes, the enum, the parts+labour consistency + derivation, and the cancel
// semantics (reason required, idempotent no-op on an already-cancelled row).

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
  archiveAsset,
  assetMaintenanceLogCreate,
  assetMaintenanceLogUpdate,
  assetMaintenanceLogCancel,
  assetMaintenanceLogGet,
  assetMaintenanceLogList,
} from '../../dist/core/assets/index.js';
import { ledgerPorts } from '../../dist/core/ledger/index.js';

const AT = '2026-08-16T00:00:00.000Z';

function ctxAt(store, workspaceId, ids, instant) {
  const clock = fixedClock(instant);
  return makeContext(store, {
    workspaceId,
    actor: 'user_1',
    clock,
    ids,
    ...ledgerPorts({ store, workspaceId, ids }),
  });
}

function setup(instant = AT) {
  const clock = fixedClock(instant);
  const ids = sequenceIdGen();
  const store = new SqliteStore({ clock });
  const deps = { store, clock, ids };
  const workspaceId = createWorkspace(deps, { name: 'Acme AG' }).workspaceId;
  const ctx = ctxAt(store, workspaceId, ids, instant);
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
    const r = createAsset(ctx, {
      categoryId: category().id,
      name: 'CNC Fräsmaschine',
      acquisitionDate: '2026-03-15',
      acquisitionCostRappen: 12_500_000,
      idempotencyKey: `as-${Math.random()}`,
      ...over,
    });
    assert.equal(r.ok, true, `asset setup failed: ${JSON.stringify(r)}`);
    return r.asset;
  };
  return { ctx, store, workspaceId, ids, deps, acc, category, draftAsset };
}

const journalCount = (store, ws) =>
  store.db.prepare('SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ?').get(ws).n;
const atxnCount = (store, ws) =>
  store.db.prepare('SELECT COUNT(*) AS n FROM asset_transaction WHERE workspace_id = ?').get(ws).n;
const logCount = (store, ws) =>
  store.db.prepare('SELECT COUNT(*) AS n FROM asset_maintenance_log WHERE workspace_id = ?').get(ws).n;

function validLog(assetId, over = {}) {
  return {
    assetId,
    logDate: '2026-08-10',
    maintenanceType: 'corrective',
    title: 'Hydraulikpumpen-Dichtung ersetzt',
    idempotencyKey: `m-${Math.random()}`,
    ...over,
  };
}

// --- Happy path + roll-up ----------------------------------------------------------------------

test('create writes a completed log and returns the mapped record', () => {
  const { ctx, draftAsset } = setup();
  const asset = draftAsset();
  const r = assetMaintenanceLogCreate(ctx, validLog(asset.id, { costRappen: 45_000 }));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.log.status, 'completed');
  assert.equal(r.log.assetId, asset.id);
  assert.equal(r.log.maintenanceType, 'corrective');
  assert.equal(r.log.costRappen, 45_000);
  assert.equal(r.log.cancelReason, null);
});

test('the list cost roll-up is the SUM of COMPLETED entries only (§7 tripwire)', () => {
  const { ctx, draftAsset } = setup();
  const asset = draftAsset();
  assetMaintenanceLogCreate(ctx, validLog(asset.id, { costRappen: 10_000 }));
  assetMaintenanceLogCreate(ctx, validLog(asset.id, { costRappen: 25_000 }));
  const doomed = assetMaintenanceLogCreate(ctx, validLog(asset.id, { costRappen: 99_000 }));
  assetMaintenanceLogCreate(ctx, validLog(asset.id)); // no cost -> counts as 0
  assetMaintenanceLogCancel(ctx, { id: doomed.log.id, reason: 'Doppelerfassung', idempotencyKey: 'c-1' });

  const listed = assetMaintenanceLogList(ctx, { assetId: asset.id });
  assert.equal(listed.ok, true);
  // 3 completed (10k + 25k + 0) visible; the cancelled 99k is excluded from both the default list and total.
  assert.equal(listed.total, 3);
  assert.equal(listed.totalCostRappen, 35_000);

  const withCancelled = assetMaintenanceLogList(ctx, { assetId: asset.id, status: 'any' });
  assert.equal(withCancelled.total, 4);
  // Even with the cancelled row VISIBLE, the roll-up still counts only completed costs.
  assert.equal(withCancelled.totalCostRappen, 35_000);
});

// --- Validation --------------------------------------------------------------------------------

test('validation codes bite: missing_log_date, log_date_too_far, invalid_maintenance_type, invalid_cost', () => {
  const { ctx, draftAsset } = setup();
  const asset = draftAsset();

  assert.equal(assetMaintenanceLogCreate(ctx, validLog(asset.id, { logDate: '' })).error, 'missing_log_date');
  // AT is 2026-08-16; +30d is 2026-09-15. 2026-10-01 is beyond the window.
  assert.equal(assetMaintenanceLogCreate(ctx, validLog(asset.id, { logDate: '2026-10-01' })).error, 'log_date_too_far');
  assert.equal(assetMaintenanceLogCreate(ctx, validLog(asset.id, { maintenanceType: 'servicing' })).error, 'invalid_maintenance_type');
  assert.equal(assetMaintenanceLogCreate(ctx, validLog(asset.id, { costRappen: -1 })).error, 'invalid_cost');
  assert.equal(assetMaintenanceLogCreate(ctx, validLog(asset.id, { costRappen: 12.5 })).error, 'invalid_cost');
  assert.equal(assetMaintenanceLogCreate(ctx, validLog(asset.id, { title: '' })).error, 'invalid_input');
});

test('a date exactly 30 days ahead is accepted; the guard is inclusive at the boundary', () => {
  const { ctx, draftAsset } = setup();
  const asset = draftAsset();
  const r = assetMaintenanceLogCreate(ctx, validLog(asset.id, { logDate: '2026-09-15' }));
  assert.equal(r.ok, true, JSON.stringify(r));
});

test('parts + labour derive the total when no total is given, and must agree when it is', () => {
  const { ctx, draftAsset } = setup();
  const asset = draftAsset();
  const derived = assetMaintenanceLogCreate(ctx, validLog(asset.id, { partsCostRappen: 3_000, labourCostRappen: 7_000 }));
  assert.equal(derived.ok, true);
  assert.equal(derived.log.costRappen, 10_000);

  const agree = assetMaintenanceLogCreate(ctx, validLog(asset.id, { partsCostRappen: 3_000, labourCostRappen: 7_000, costRappen: 10_000 }));
  assert.equal(agree.ok, true);

  const mismatch = assetMaintenanceLogCreate(ctx, validLog(asset.id, { partsCostRappen: 3_000, labourCostRappen: 7_000, costRappen: 9_999 }));
  assert.equal(mismatch.error, 'invalid_cost');
});

test('a foreign asset is not_found and an archived asset is asset_archived', () => {
  const { ctx, draftAsset } = setup();
  assert.equal(assetMaintenanceLogCreate(ctx, validLog('asset_nope')).error, 'not_found');
  const asset = draftAsset();
  const arch = archiveAsset(ctx, { assetId: asset.id, idempotencyKey: 'arch-1' });
  assert.equal(arch.ok, true, JSON.stringify(arch));
  assert.equal(assetMaintenanceLogCreate(ctx, validLog(asset.id)).error, 'asset_archived');
});

// --- Non-posting -------------------------------------------------------------------------------

test('NON-POSTING: no journal_entry and no asset_transaction row across the whole lifecycle', () => {
  const { ctx, store, workspaceId, draftAsset } = setup();
  const asset = draftAsset();
  const j0 = journalCount(store, workspaceId);
  const a0 = atxnCount(store, workspaceId);
  const created = assetMaintenanceLogCreate(ctx, validLog(asset.id, { costRappen: 50_000 }));
  assetMaintenanceLogUpdate(ctx, { id: created.log.id, patch: { costRappen: 60_000 }, idempotencyKey: 'u-1' });
  assetMaintenanceLogCancel(ctx, { id: created.log.id, reason: 'Storno', idempotencyKey: 'x-1' });
  assert.equal(journalCount(store, workspaceId), j0, 'a maintenance log posted a journal entry');
  assert.equal(atxnCount(store, workspaceId), a0, 'a maintenance log wrote an asset_transaction row');
});

// --- Idempotency -------------------------------------------------------------------------------

test('create is idempotent on ROWS: a replay returns the original and writes no second row', () => {
  const { ctx, store, workspaceId, draftAsset } = setup();
  const asset = draftAsset();
  const key = 'idem-create-1';
  const first = assetMaintenanceLogCreate(ctx, validLog(asset.id, { idempotencyKey: key, costRappen: 5_000 }));
  const n = logCount(store, workspaceId);
  const second = assetMaintenanceLogCreate(ctx, validLog(asset.id, { idempotencyKey: key, costRappen: 5_000 }));
  assert.equal(second.ok, true);
  assert.equal(second.log.id, first.log.id);
  assert.equal(logCount(store, workspaceId), n, 'a replayed create wrote a second row');
});

test('cancel is idempotent: a second cancel is a no-op that keeps the first reason', () => {
  const { ctx, draftAsset } = setup();
  const asset = draftAsset();
  const log = assetMaintenanceLogCreate(ctx, validLog(asset.id)).log;
  const first = assetMaintenanceLogCancel(ctx, { id: log.id, reason: 'Falsch erfasst', idempotencyKey: 'k1' });
  assert.equal(first.ok, true);
  assert.equal(first.log.status, 'cancelled');
  assert.equal(first.log.cancelReason, 'Falsch erfasst');
  // A different key + a different reason on an already-cancelled row must not overwrite the first reason.
  const second = assetMaintenanceLogCancel(ctx, { id: log.id, reason: 'Anderer Grund', idempotencyKey: 'k2' });
  assert.equal(second.ok, true);
  assert.equal(second.log.cancelReason, 'Falsch erfasst');
});

test('cancel requires a non-empty reason', () => {
  const { ctx, draftAsset } = setup();
  const asset = draftAsset();
  const log = assetMaintenanceLogCreate(ctx, validLog(asset.id)).log;
  assert.equal(assetMaintenanceLogCancel(ctx, { id: log.id, reason: '  ', idempotencyKey: 'k1' }).error, 'invalid_input');
});

// --- Update + soft-edit window -----------------------------------------------------------------

test('a descriptive update within the window edits the fields and posts nothing', () => {
  const { ctx, draftAsset } = setup();
  const asset = draftAsset();
  const log = assetMaintenanceLogCreate(ctx, validLog(asset.id, { costRappen: 1_000 })).log;
  const r = assetMaintenanceLogUpdate(ctx, {
    id: log.id,
    patch: { title: 'Korrigierter Titel', costRappen: 2_000, notes: 'Nachtrag' },
    idempotencyKey: 'u1',
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.log.title, 'Korrigierter Titel');
  assert.equal(r.log.costRappen, 2_000);
  assert.equal(r.log.notes, 'Nachtrag');
});

test('an update AFTER the 90-day soft-edit window is refused with log_locked; cancel still works', () => {
  const { store, workspaceId, ids, draftAsset, ctx } = setup();
  const asset = draftAsset();
  const log = assetMaintenanceLogCreate(ctx, validLog(asset.id)).log;
  // A context 91 days later: the historical record is now protected.
  const later = ctxAt(store, workspaceId, ids, '2026-11-15T00:00:00.000Z');
  const upd = assetMaintenanceLogUpdate(later, { id: log.id, patch: { title: 'zu spät' }, idempotencyKey: 'u-late' });
  assert.equal(upd.error, 'log_locked');
  // Cancel is still allowed after the window (spec §4).
  const cancel = assetMaintenanceLogCancel(later, { id: log.id, reason: 'Storno nach Frist', idempotencyKey: 'x-late' });
  assert.equal(cancel.ok, true);
  assert.equal(cancel.log.status, 'cancelled');
});

test('a cancelled entry cannot be descriptively updated', () => {
  const { ctx, draftAsset } = setup();
  const asset = draftAsset();
  const log = assetMaintenanceLogCreate(ctx, validLog(asset.id)).log;
  assetMaintenanceLogCancel(ctx, { id: log.id, reason: 'weg', idempotencyKey: 'x1' });
  const upd = assetMaintenanceLogUpdate(ctx, { id: log.id, patch: { title: 'neu' }, idempotencyKey: 'u1' });
  assert.equal(upd.error, 'log_cancelled');
});

// --- Filters -----------------------------------------------------------------------------------

test('list filters by type, hasCost, date range and search; default hides cancelled', () => {
  const { ctx, draftAsset } = setup();
  const asset = draftAsset();
  assetMaintenanceLogCreate(ctx, validLog(asset.id, { maintenanceType: 'inspection', title: 'Jahresinspektion', costRappen: 4_000, logDate: '2026-08-01' }));
  assetMaintenanceLogCreate(ctx, validLog(asset.id, { maintenanceType: 'corrective', title: 'Reparatur Motor', logDate: '2026-08-12' }));

  assert.equal(assetMaintenanceLogList(ctx, { assetId: asset.id, maintenanceType: 'inspection' }).total, 1);
  assert.equal(assetMaintenanceLogList(ctx, { assetId: asset.id, hasCost: true }).total, 1);
  assert.equal(assetMaintenanceLogList(ctx, { assetId: asset.id, hasCost: false }).total, 1);
  assert.equal(assetMaintenanceLogList(ctx, { assetId: asset.id, fromDate: '2026-08-10' }).total, 1);
  assert.equal(assetMaintenanceLogList(ctx, { assetId: asset.id, search: 'motor' }).total, 1);
});

// --- §H-TENANT ---------------------------------------------------------------------------------

test('§H-TENANT: a W1 log is invisible and unreachable from W2', () => {
  const { ctx, store, ids, draftAsset } = setup();
  const asset = draftAsset();
  const log = assetMaintenanceLogCreate(ctx, validLog(asset.id, { costRappen: 7_000 })).log;

  // A second workspace in the same store.
  const w2 = createWorkspace({ store, clock: fixedClock(AT), ids }, { name: 'Beta GmbH' }).workspaceId;
  const ctx2 = ctxAt(store, w2, ids, AT);

  assert.equal(assetMaintenanceLogList(ctx2, { assetId: asset.id }).total, 0, 'W2 saw a W1 log');
  assert.equal(assetMaintenanceLogGet(ctx2, { id: log.id }).error, 'not_found');
  assert.equal(assetMaintenanceLogUpdate(ctx2, { id: log.id, patch: { title: 'x' }, idempotencyKey: 'u' }).error, 'not_found');
  assert.equal(assetMaintenanceLogCancel(ctx2, { id: log.id, reason: 'x', idempotencyKey: 'c' }).error, 'not_found');
});

// --- Append-oriented (no hard delete) ----------------------------------------------------------

test('APPEND-ORIENTED: a raw DELETE is refused by the DB trigger', () => {
  const { ctx, store, workspaceId, draftAsset } = setup();
  const asset = draftAsset();
  const log = assetMaintenanceLogCreate(ctx, validLog(asset.id)).log;
  assert.throws(
    () => store.db.prepare('DELETE FROM asset_maintenance_log WHERE id = ?').run(log.id),
    /asset_maintenance_log_immutable/,
  );
  assert.equal(logCount(store, workspaceId), 1);
});
