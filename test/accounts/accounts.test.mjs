import test from 'node:test';
import assert from 'node:assert/strict';

import {
  seedChartOfAccounts,
  createAccount,
  updateAccount,
  archiveAccount,
  unarchiveAccount,
  deleteAccount,
  listAccounts,
  createCostCenter,
  archiveCostCenter,
  unarchiveCostCenter,
  deleteCostCenter,
  listCostCenters,
} from '../../dist/core/accounts/index.js';
import { createWorkspace } from '../../dist/core/setup/index.js';
import { postEntry } from '../../dist/core/ledger/index.js';
import { setup } from '../setup/support.mjs';

function seededWorkspace() {
  const { store, deps, ctxFor } = setup();
  const ws = createWorkspace(deps, { name: 'Acme' }).workspaceId;
  const ctx = ctxFor(ws);
  seedChartOfAccounts(ctx);
  return { store, ctx, ws };
}

const listCostCentersHas = (ctx, costCenterId) =>
  listCostCenters(ctx, {}).costCenters.some((c) => c.id === costCenterId);

const typeOf = (ctx, ws, number) =>
  ctx.store.db.prepare('SELECT type FROM account WHERE workspace_id = ? AND number = ?').get(ws, number)?.type;

test('seedChartOfAccounts seeds the KMU core with correct types, idempotently', () => {
  const { store, deps, ctxFor } = setup();
  const ws = createWorkspace(deps, { name: 'Acme' }).workspaceId;
  const ctx = ctxFor(ws);

  const first = seedChartOfAccounts(ctx);
  assert.equal(first.ok, true);
  assert.ok(first.count >= 30, `expected a substantial core, got ${first.count}`);

  const second = seedChartOfAccounts(ctx);
  assert.equal(second.count, first.count); // idempotent, no duplicates
  assert.equal(store.db.prepare('SELECT COUNT(*) AS c FROM account WHERE workspace_id = ?').get(ws).c, first.count);

  // the type mapping the specs pin (2xxx is liability except the equity block)
  assert.equal(typeOf(ctx, ws, '1000'), 'asset');
  assert.equal(typeOf(ctx, ws, '1100'), 'asset');
  assert.equal(typeOf(ctx, ws, '2200'), 'liability');
  assert.equal(typeOf(ctx, ws, '2800'), 'equity');
  assert.equal(typeOf(ctx, ws, '2970'), 'equity');
  assert.equal(typeOf(ctx, ws, '2979'), 'equity');
  assert.equal(typeOf(ctx, ws, '3000'), 'income');
  assert.equal(typeOf(ctx, ws, '6500'), 'expense');
});

test('createAccount rejects duplicate numbers and invalid types', () => {
  const { ctx } = seededWorkspace();
  assert.equal(createAccount(ctx, { number: '1000', name: 'Kasse 2', type: 'asset' }).error, 'duplicate_number');
  assert.equal(createAccount(ctx, { number: '9999', name: 'Weird', type: 'nonsense' }).error, 'invalid_type');
  const made = createAccount(ctx, { number: '6510', name: 'Porto', type: 'expense' });
  assert.equal(made.ok, true);
  assert.ok(made.accountId);
});

test('an account carrying postings can be archived but never deleted', () => {
  const { ctx, ws, store } = seededWorkspace();
  const acc = (number) => store.db.prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?').get(ws, number).id;
  postEntry(ctx, {
    date: '2026-03-01',
    description: 'x',
    source: 'manual',
    idempotencyKey: 'p',
    lines: [
      { account: acc('6500'), debit: 100 },
      { account: acc('1000'), credit: 100 },
    ],
  });

  assert.equal(deleteAccount(ctx, { accountId: acc('6500'), idempotencyKey: 'd1' }).error, 'account_in_use');
  assert.equal(archiveAccount(ctx, { accountId: acc('6500') }).ok, true);
  // an untouched account still deletes
  assert.equal(deleteAccount(ctx, { accountId: acc('3000'), idempotencyKey: 'd2' }).ok, true);
});

test('updateAccount patches name / vat default / cost-center flag but never number or type', () => {
  const { ctx, ws, store } = seededWorkspace();
  const id = store.db.prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?').get(ws, '6500').id;
  assert.equal(updateAccount(ctx, { accountId: id, name: 'Büromaterial und Porto', costCenterAllowed: true }).ok, true);
  const row = store.db.prepare('SELECT number, type, name, cost_center_allowed FROM account WHERE id = ?').get(id);
  assert.equal(row.name, 'Büromaterial und Porto');
  assert.equal(row.number, '6500'); // unchanged
  assert.equal(row.type, 'expense'); // unchanged
  assert.equal(row.cost_center_allowed, 1);
});

test('listAccounts filters by search and hides archived by default', () => {
  const { ctx, ws, store } = seededWorkspace();
  const id = store.db.prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?').get(ws, '1000').id;
  archiveAccount(ctx, { accountId: id });

  const active = listAccounts(ctx, {});
  assert.equal(active.ok, true);
  assert.equal(active.accounts.some((a) => a.number === '1000'), false);
  assert.equal(listAccounts(ctx, { includeArchived: true }).accounts.some((a) => a.number === '1000'), true);

  const search = listAccounts(ctx, { search: '2979' });
  assert.equal(search.accounts.length, 1);
  assert.equal(search.accounts[0].type, 'equity');
});

test('unarchiveAccount returns an archived account to the active list (round-trip)', () => {
  const { ctx, ws, store } = seededWorkspace();
  const id = store.db.prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?').get(ws, '1000').id;

  assert.equal(archiveAccount(ctx, { accountId: id }).ok, true);
  assert.equal(listAccounts(ctx, {}).accounts.some((a) => a.number === '1000'), false, 'archived: hidden');

  assert.equal(unarchiveAccount(ctx, { accountId: id }).ok, true);
  assert.equal(listAccounts(ctx, {}).accounts.some((a) => a.number === '1000'), true, 'reactivated: back on the active list');
});

test('unarchiveAccount is idempotent and a never-archived account is a no-op ok', () => {
  const { ctx, ws, store } = seededWorkspace();
  const id = store.db.prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?').get(ws, '1000').id;

  // Never archived: un-archiving is a harmless no-op ok.
  assert.equal(unarchiveAccount(ctx, { accountId: id }).ok, true);
  // Archive, then unarchive twice: the second call is idempotent.
  archiveAccount(ctx, { accountId: id });
  assert.equal(unarchiveAccount(ctx, { accountId: id }).ok, true);
  assert.equal(unarchiveAccount(ctx, { accountId: id }).ok, true);
  assert.equal(listAccounts(ctx, {}).accounts.some((a) => a.number === '1000'), true);
});

test('unarchiveAccount on an unknown id is a structured error, not a throw', () => {
  const { ctx } = seededWorkspace();
  const res = unarchiveAccount(ctx, { accountId: 'acc_nope' });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'not_found');
});

test('unarchiveCostCenter round-trips a soft-archived cost centre', () => {
  const { ctx } = seededWorkspace();
  const made = createCostCenter(ctx, { code: 'CC1', name: 'Projekt A' });
  assert.equal(archiveCostCenter(ctx, { costCenterId: made.costCenterId }).ok, true);
  assert.equal(listCostCentersHas(ctx, made.costCenterId), false, 'archived: hidden');
  assert.equal(unarchiveCostCenter(ctx, { costCenterId: made.costCenterId }).ok, true);
  assert.equal(listCostCentersHas(ctx, made.costCenterId), true, 'reactivated');
  // Idempotent, and an unknown id is a structured error.
  assert.equal(unarchiveCostCenter(ctx, { costCenterId: made.costCenterId }).ok, true);
  assert.equal(unarchiveCostCenter(ctx, { costCenterId: 'cc_nope' }).error, 'not_found');
});

test('a cost center in use cannot be deleted, an unused one can', () => {
  const { ctx, ws, store } = seededWorkspace();
  const made = createCostCenter(ctx, { code: 'CC1', name: 'Projekt A' });
  assert.equal(made.ok, true);
  const unused = createCostCenter(ctx, { code: 'CC2', name: 'Projekt B' });

  const acc = (number) => store.db.prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?').get(ws, number).id;
  updateAccount(ctx, { accountId: acc('6500'), costCenterAllowed: true });
  postEntry(ctx, {
    date: '2026-03-01',
    description: 'x',
    source: 'manual',
    idempotencyKey: 'p',
    lines: [
      { account: acc('6500'), debit: 100, costCenter: made.costCenterId },
      { account: acc('1000'), credit: 100 },
    ],
  });

  assert.equal(deleteCostCenter(ctx, { costCenterId: made.costCenterId }).error, 'cost_center_in_use');
  assert.equal(deleteCostCenter(ctx, { costCenterId: unused.costCenterId }).ok, true);
});

// ── The inUse read-model gap the browser flows caught (UX gate, 2026-07-20) ──
// The GUI decides Archive-XOR-Delete per row from `inUse`, but the list reads never sent it, so
// every row fell back to false and the destructive Delete was always offered while
// `archive_account` was unreachable. jsdom missed it because fixtures hand-set `inUse`; these
// tests pin the LIVE shape.

test('listAccounts reports inUse per row, true exactly for accounts the journal touches', () => {
  const { store, ctx, ws } = seededWorkspace();
  const acc = (number) => store.db.prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?').get(ws, number).id;

  const before = listAccounts(ctx);
  assert.equal(before.ok, true);
  for (const row of before.accounts) {
    assert.equal(row.inUse, false, `fresh account ${row.number} must report inUse false, not ${row.inUse}`);
  }

  postEntry(ctx, {
    date: '2026-03-01',
    description: 'x',
    source: 'manual',
    idempotencyKey: 'inuse-1',
    lines: [
      { account: acc('6500'), debit: 100 },
      { account: acc('1000'), credit: 100 },
    ],
  });

  const after = listAccounts(ctx);
  const byNumber = new Map(after.accounts.map((a) => [a.number, a]));
  assert.equal(byNumber.get('6500').inUse, true);
  assert.equal(byNumber.get('1000').inUse, true);
  assert.equal(byNumber.get('3000').inUse, false);
});

test('listCostCenters reports inUse per row, true exactly for cost centres the journal touches', () => {
  const { store, ctx, ws } = seededWorkspace();
  const acc = (number) => store.db.prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?').get(ws, number).id;
  const used = createCostCenter(ctx, { code: 'CC1', name: 'Projekt A' });
  const unused = createCostCenter(ctx, { code: 'CC2', name: 'Projekt B' });
  updateAccount(ctx, { accountId: acc('6500'), costCenterAllowed: true });

  postEntry(ctx, {
    date: '2026-03-02',
    description: 'x',
    source: 'manual',
    idempotencyKey: 'inuse-2',
    lines: [
      { account: acc('6500'), debit: 100, costCenter: used.costCenterId },
      { account: acc('1000'), credit: 100 },
    ],
  });

  const list = listCostCenters(ctx);
  assert.equal(list.ok, true);
  const byCode = new Map(list.costCenters.map((c) => [c.code, c]));
  assert.equal(byCode.get('CC1').inUse, true);
  assert.equal(byCode.get('CC2').inUse, false);
});
