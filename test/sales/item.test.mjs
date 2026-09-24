import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createItem,
  updateItem,
  archiveItem,
  unarchiveItem,
  getItem,
  listItems,
} from '../../dist/core/sales/index.js';
import { setup, newWorkspace } from './support.mjs';

test('createItem stores the price as integer Rappen and round-trips through getItem', () => {
  const { ctx, workspaceId, byNumber } = setup();
  const made = createItem(ctx, {
    name: 'Beratung',
    defaultUnitPriceMinor: 15000,
    currency: 'CHF',
    defaultTaxCode: 'UST81',
    revenueAccountId: byNumber('3200'),
    unit: 'hour',
  });
  assert.equal(made.ok, true);
  assert.equal(made.item.workspaceId, workspaceId);
  assert.equal(made.item.defaultUnitPriceMinor, 15000);
  assert.equal(made.item.currency, 'CHF');
  assert.equal(made.item.defaultTaxCode, 'UST81');
  assert.equal(made.item.unit, 'hour');
  assert.equal(made.item.archived, false);

  const got = getItem(ctx, { itemId: made.item.id });
  assert.equal(got.ok, true);
  assert.equal(got.item.name, 'Beratung');
  // stored value is an integer, not a float
  const raw = ctx.store.db
    .prepare('SELECT default_unit_price_minor AS p FROM item WHERE id = ?')
    .get(made.item.id).p;
  assert.equal(Number.isInteger(raw), true);
  assert.equal(raw, 15000);
});

test('createItem accepts a bare name with no price/tax/account', () => {
  const { ctx } = setup();
  const made = createItem(ctx, { name: 'Platzhalter', defaultUnitPriceMinor: 0 });
  assert.equal(made.ok, true);
  assert.equal(made.item.defaultUnitPriceMinor, 0);
  assert.equal(made.item.defaultTaxCode, null);
  assert.equal(made.item.revenueAccountId, null);
});

test('createItem rejects an empty name', () => {
  const { ctx } = setup();
  const bad = createItem(ctx, { name: '', defaultUnitPriceMinor: 100 });
  assert.equal(bad.error, 'invalid_input');
  assert.equal(bad.field, 'name');
});

test('createItem rejects a negative or non-integer (float) price', () => {
  const { ctx } = setup();
  assert.equal(createItem(ctx, { name: 'A', defaultUnitPriceMinor: -1 }).error, 'invalid_price');
  assert.equal(createItem(ctx, { name: 'A', defaultUnitPriceMinor: 12.5 }).error, 'invalid_price');
  assert.equal(createItem(ctx, { name: 'A', defaultUnitPriceMinor: '100' }).error, 'invalid_price');
});

test('createItem rejects a non-income revenue account', () => {
  const { ctx, byNumber } = setup();
  // 1000 Kasse is an asset account, not income
  const bad = createItem(ctx, { name: 'A', defaultUnitPriceMinor: 100, revenueAccountId: byNumber('1000') });
  assert.equal(bad.error, 'invalid_revenue_account');
  // a stale/unknown id is likewise rejected
  assert.equal(createItem(ctx, { name: 'A', defaultUnitPriceMinor: 100, revenueAccountId: 'ghost' }).error, 'invalid_revenue_account');
});

test('createItem rejects an unknown tax code', () => {
  const { ctx } = setup();
  assert.equal(createItem(ctx, { name: 'A', defaultUnitPriceMinor: 100, defaultTaxCode: 'UST99' }).error, 'unknown_tax_code');
});

test('createItem rejects an unknown currency', () => {
  const { ctx } = setup();
  assert.equal(createItem(ctx, { name: 'A', defaultUnitPriceMinor: 100, currency: 'GBP' }).error, 'invalid_currency');
});

test('updateItem patches fields and re-validates the money-path references', () => {
  const { ctx, byNumber } = setup();
  const id = createItem(ctx, { name: 'Alt', defaultUnitPriceMinor: 100 }).item.id;
  const upd = updateItem(ctx, { itemId: id, patch: { name: 'Neu', defaultUnitPriceMinor: 250, revenueAccountId: byNumber('3400') } });
  assert.equal(upd.ok, true);
  assert.equal(upd.item.name, 'Neu');
  assert.equal(upd.item.defaultUnitPriceMinor, 250);
  assert.equal(upd.item.revenueAccountId, byNumber('3400'));
  assert.equal(updateItem(ctx, { itemId: id, patch: { defaultUnitPriceMinor: 1.2 } }).error, 'invalid_price');
  assert.equal(updateItem(ctx, { itemId: id, patch: { revenueAccountId: byNumber('1000') } }).error, 'invalid_revenue_account');
  assert.equal(updateItem(ctx, { itemId: 'ghost', patch: { name: 'x' } }).error, 'not_found');
});

test('archiveItem hides from list by default, includeArchived reveals it, the row survives', () => {
  const { ctx, store, workspaceId } = setup();
  const id = createItem(ctx, { name: 'Archivartikel', defaultUnitPriceMinor: 100 }).item.id;
  assert.equal(archiveItem(ctx, { itemId: id }).ok, true);
  assert.equal(listItems(ctx, {}).items.some((i) => i.id === id), false);
  assert.equal(listItems(ctx, { includeArchived: true }).items.some((i) => i.id === id), true);
  const row = store.db.prepare('SELECT archived FROM item WHERE workspace_id = ? AND id = ?').get(workspaceId, id);
  assert.equal(row.archived, 1);
});

test('unarchiveItem reactivates a soft-archived item (round-trip + idempotent + unknown id)', () => {
  const { ctx } = setup();
  const id = createItem(ctx, { name: 'Archivartikel', defaultUnitPriceMinor: 100 }).item.id;
  assert.equal(archiveItem(ctx, { itemId: id }).ok, true);
  assert.equal(listItems(ctx, {}).items.some((i) => i.id === id), false, 'archived: hidden');

  const back = unarchiveItem(ctx, { itemId: id });
  assert.equal(back.ok, true);
  assert.equal(back.item.archived, false, 'the returned record is active again');
  assert.equal(listItems(ctx, {}).items.some((i) => i.id === id), true, 'reactivated: back on the active list');

  // Idempotent, and an unknown id is a structured error, not a throw.
  assert.equal(unarchiveItem(ctx, { itemId: id }).ok, true);
  const miss = unarchiveItem(ctx, { itemId: 'item_nope' });
  assert.equal(miss.ok, false);
  assert.equal(miss.error, 'not_found');
});

test('listItems searches by name', () => {
  const { ctx } = setup();
  createItem(ctx, { name: 'Beratung', defaultUnitPriceMinor: 100 });
  createItem(ctx, { name: 'Schulung', defaultUnitPriceMinor: 200 });
  assert.equal(listItems(ctx, { query: 'berat' }).items.length, 1);
  assert.equal(listItems(ctx, {}).items.length, 2);
});

test('createItem is idempotent under a repeated idempotencyKey', () => {
  const { ctx } = setup();
  const first = createItem(ctx, { name: 'Once', defaultUnitPriceMinor: 100, idempotencyKey: 'i1' });
  const second = createItem(ctx, { name: 'Once', defaultUnitPriceMinor: 100, idempotencyKey: 'i1' });
  assert.equal(first.item.id, second.item.id);
  assert.equal(listItems(ctx, { query: 'Once' }).items.length, 1);
});

test('§H-TENANT: a second workspace sees none of the first workspace items', () => {
  const { ctx, deps } = setup();
  createItem(ctx, { name: 'Erster Artikel', defaultUnitPriceMinor: 100 });
  const other = newWorkspace(deps, 'Zweite AG');
  assert.equal(listItems(other, {}).items.length, 0);
});
