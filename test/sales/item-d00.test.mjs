import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { fixedClock } from '../../dist/core/clock.js';

import {
  createItem,
  updateItem,
  archiveItem,
  deleteItem,
  listItems,
  upsertItemCategory,
  deleteItemCategory,
  listItemCategories,
  upsertPriceList,
  setPriceListPrice,
  unsetPriceListPrice,
  deletePriceList,
  listPriceLists,
  getPriceList,
  resolvePrice,
  getItem,
  createContact,
} from '../../dist/core/sales/index.js';
import { defineField, confirmField, setFieldValue } from '../../dist/core/customization/index.js';
import { setup, newWorkspace } from './support.mjs';

/**
 * Write a value into `item.unit` the way A09 could, bypassing the engine.
 *
 * D00 narrowed `unit` to the ITEM_UNITS enum, so there is no longer a verb that can produce the row
 * a pre-D00 database already holds. The tests below are about exactly those rows, so the only honest
 * fixture is the one that puts the free text there directly.
 */
function forceLegacyUnit(store, itemId, unit) {
  store.db.prepare('UPDATE item SET unit = ? WHERE id = ?').run(unit, itemId);
}

/** How many rows the table holds for this workspace: the "on ROWS" half of an idempotency claim. */
function rowCount(store, table, workspaceId) {
  return store.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE workspace_id = ?`).get(workspaceId).n;
}

// ---------------------------------------------------------------------------------------------
// D00 item field extensions: enums, cost price, sku uniqueness
// ---------------------------------------------------------------------------------------------

test('createItem accepts the D00 fields and round-trips them', () => {
  const { ctx } = setup();
  const made = createItem(ctx, {
    name: 'Laptop',
    defaultUnitPriceMinor: 120000,
    sku: 'SKU-1',
    kind: 'product',
    unit: 'piece',
    costPriceMinor: 90000,
    trackStock: true,
    reorderPointQty: 5000,
  });
  assert.equal(made.ok, true);
  assert.equal(made.item.sku, 'SKU-1');
  assert.equal(made.item.kind, 'product');
  assert.equal(made.item.unit, 'piece');
  assert.equal(made.item.costPriceMinor, 90000);
  assert.equal(made.item.trackStock, true);
  assert.equal(made.item.reorderPointQty, 5000);
});

test('createItem rejects a non-enum unit and a non-enum kind', () => {
  const { ctx } = setup();
  assert.equal(createItem(ctx, { name: 'A', defaultUnitPriceMinor: 100, unit: 'Stunde' }).error, 'invalid_unit');
  assert.equal(createItem(ctx, { name: 'A', defaultUnitPriceMinor: 100, kind: 'widget' }).error, 'invalid_kind');
});

test('createItem rejects a negative or non-integer cost price', () => {
  const { ctx } = setup();
  assert.equal(createItem(ctx, { name: 'A', defaultUnitPriceMinor: 100, costPriceMinor: -1 }).error, 'invalid_cost_price');
  assert.equal(createItem(ctx, { name: 'A', defaultUnitPriceMinor: 100, costPriceMinor: 1.5 }).error, 'invalid_cost_price');
});

test('sku is unique per workspace (sku_taken), and blank sku never collides', () => {
  const { ctx } = setup();
  assert.equal(createItem(ctx, { name: 'A', defaultUnitPriceMinor: 100, sku: 'DUP' }).ok, true);
  assert.equal(createItem(ctx, { name: 'B', defaultUnitPriceMinor: 100, sku: 'DUP' }).error, 'sku_taken');
  // A second item with no sku is fine (null never collides with null).
  assert.equal(createItem(ctx, { name: 'C', defaultUnitPriceMinor: 100 }).ok, true);
  assert.equal(createItem(ctx, { name: 'D', defaultUnitPriceMinor: 100 }).ok, true);
});

test('a service is never stockable (create and update)', () => {
  const { ctx } = setup();
  assert.equal(
    createItem(ctx, { name: 'Beratung', defaultUnitPriceMinor: 100, kind: 'service', trackStock: true }).error,
    'services_not_stockable',
  );
  const id = createItem(ctx, { name: 'Ding', defaultUnitPriceMinor: 100, kind: 'product', trackStock: true }).item.id;
  assert.equal(updateItem(ctx, { itemId: id, patch: { kind: 'service' } }).error, 'services_not_stockable');
});

// ---------------------------------------------------------------------------------------------
// Variants: one level, snapshot inheritance
// ---------------------------------------------------------------------------------------------

test('a variant inherits the parent defaults as a snapshot, and overrides win', () => {
  const { ctx } = setup();
  const parent = createItem(ctx, {
    name: 'T-Shirt',
    defaultUnitPriceMinor: 2500,
    kind: 'product',
    unit: 'piece',
    costPriceMinor: 1000,
    defaultTaxCode: 'UST81',
  }).item;
  const variant = createItem(ctx, { name: 'T-Shirt L', defaultUnitPriceMinor: 2500, variantOfId: parent.id }).item;
  assert.equal(variant.variantOfId, parent.id);
  assert.equal(variant.kind, 'product', 'kind inherited');
  assert.equal(variant.unit, 'piece', 'unit inherited');
  assert.equal(variant.costPriceMinor, 1000, 'cost price inherited');
  assert.equal(variant.defaultTaxCode, 'UST81', 'tax code inherited');

  // A later edit to the parent does NOT mutate the variant (snapshot, not a live link).
  updateItem(ctx, { itemId: parent.id, patch: { costPriceMinor: 9999 } });
  const after = listItems(ctx, {}).items.find((i) => i.id === variant.id);
  assert.equal(after.costPriceMinor, 1000, 'variant keeps its snapshot');

  // An explicit override on the variant wins over the inherited value.
  const overridden = createItem(ctx, {
    name: 'T-Shirt S',
    defaultUnitPriceMinor: 2000,
    variantOfId: parent.id,
    unit: 'flat',
  }).item;
  assert.equal(overridden.unit, 'flat');
});

test('variant depth is exactly one level and a bad parent is refused', () => {
  const { ctx } = setup();
  const parent = createItem(ctx, { name: 'Parent', defaultUnitPriceMinor: 100 }).item;
  const variant = createItem(ctx, { name: 'Var', defaultUnitPriceMinor: 100, variantOfId: parent.id }).item;
  assert.equal(
    createItem(ctx, { name: 'VarVar', defaultUnitPriceMinor: 100, variantOfId: variant.id }).error,
    'variant_chain_not_allowed',
  );
  assert.equal(createItem(ctx, { name: 'X', defaultUnitPriceMinor: 100, variantOfId: 'ghost' }).error, 'parent_not_found');
});

// ---------------------------------------------------------------------------------------------
// Categories: two-level tree, category_in_use
// ---------------------------------------------------------------------------------------------

test('categories nest exactly two levels and refuse a third', () => {
  const { ctx } = setup();
  const root = upsertItemCategory(ctx, { name: 'Hardware' }).category;
  const child = upsertItemCategory(ctx, { name: 'Laptops', parentId: root.id }).category;
  assert.equal(child.parentId, root.id);
  assert.equal(
    upsertItemCategory(ctx, { name: 'Ultrabooks', parentId: child.id }).error,
    'category_nesting_too_deep',
  );
  assert.equal(upsertItemCategory(ctx, { name: 'Orphan', parentId: 'ghost' }).error, 'parent_not_found');
});

test('a category referenced by an item cannot be deleted (category_in_use)', () => {
  const { ctx } = setup();
  const cat = upsertItemCategory(ctx, { name: 'Beratung' }).category;
  const item = createItem(ctx, { name: 'Coaching', defaultUnitPriceMinor: 100, categoryId: cat.id }).item;
  assert.equal(deleteItemCategory(ctx, { categoryId: cat.id }).error, 'category_in_use');
  // Reassign, then the delete succeeds.
  updateItem(ctx, { itemId: item.id, patch: { categoryId: null } });
  assert.equal(deleteItemCategory(ctx, { categoryId: cat.id }).ok, true);
  assert.equal(listItemCategories(ctx).categories.length, 0);
});

test('createItem refuses an unknown category (category_not_found)', () => {
  const { ctx } = setup();
  assert.equal(createItem(ctx, { name: 'A', defaultUnitPriceMinor: 100, categoryId: 'ghost' }).error, 'category_not_found');
});

// ---------------------------------------------------------------------------------------------
// Price lists: scope XOR, append-only history, resolvePrice precedence
// ---------------------------------------------------------------------------------------------

test('a price list is scoped to contact XOR segment', () => {
  const { ctx } = setup();
  const contact = createContact(ctx, { partyRole: 'customer', name: 'Muster AG' }).contact;
  assert.equal(upsertPriceList(ctx, { name: 'Neither' }).error, 'scope_ambiguous');
  assert.equal(
    upsertPriceList(ctx, { name: 'Both', contactId: contact.id, segment: 'key_account' }).error,
    'scope_ambiguous',
  );
  assert.equal(upsertPriceList(ctx, { name: 'Seg', segment: 'key_account' }).ok, true);
  assert.equal(upsertPriceList(ctx, { name: 'Con', contactId: contact.id }).ok, true);
  assert.equal(upsertPriceList(ctx, { name: 'Ghost', contactId: 'nope' }).error, 'contact_not_found');
  assert.equal(listPriceLists(ctx).priceLists.length, 2);
});

test('resolvePrice: contact beats base, and the latest valid_from in force wins', () => {
  const { ctx } = setup();
  const contact = createContact(ctx, { partyRole: 'customer', name: 'Muster AG' }).contact;
  const item = createItem(ctx, { name: 'Widget', defaultUnitPriceMinor: 5000, currency: 'CHF' }).item;

  // Base price with no list.
  const base = resolvePrice(ctx, { itemId: item.id, at: '2026-06-01' });
  assert.equal(base.ok, true);
  assert.equal(base.source, 'base');
  assert.equal(base.priceMinor, 5000);

  const clean = upsertPriceList(ctx, { name: 'MusterListe', contactId: contact.id }).priceList;
  setPriceListPrice(ctx, { priceListId: clean.id, itemId: item.id, priceMinor: 4500, validFrom: '2026-01-01' });
  setPriceListPrice(ctx, { priceListId: clean.id, itemId: item.id, priceMinor: 4000, validFrom: '2026-05-01' });

  // Before the second row is in force, the first applies.
  const early = resolvePrice(ctx, { itemId: item.id, contactId: contact.id, at: '2026-03-01' });
  assert.equal(early.source, 'contact');
  assert.equal(early.priceMinor, 4500);

  // After it, the later valid_from wins.
  const late = resolvePrice(ctx, { itemId: item.id, contactId: contact.id, at: '2026-06-01' });
  assert.equal(late.source, 'contact');
  assert.equal(late.priceMinor, 4000);

  // A future validFrom is stored but inert until its date.
  setPriceListPrice(ctx, { priceListId: clean.id, itemId: item.id, priceMinor: 3000, validFrom: '2027-01-01' });
  const stillLate = resolvePrice(ctx, { itemId: item.id, contactId: contact.id, at: '2026-06-01' });
  assert.equal(stillLate.priceMinor, 4000, 'a future price does not apply yet');

  // resolvePrice does no arithmetic: it returns a STORED integer.
  assert.equal(Number.isInteger(late.priceMinor), true);
});

test('resolvePrice refuses an archived item and reports not_found for a ghost', () => {
  const { ctx } = setup();
  const item = createItem(ctx, { name: 'Alt', defaultUnitPriceMinor: 100 }).item;
  archiveItem(ctx, { itemId: item.id });
  assert.equal(resolvePrice(ctx, { itemId: item.id }).error, 'item_archived');
  assert.equal(resolvePrice(ctx, { itemId: 'ghost' }).error, 'not_found');
});

test('setPriceListPrice validates the amount, currency and validFrom', () => {
  const { ctx } = setup();
  const list = upsertPriceList(ctx, { name: 'L', segment: 'key_account' }).priceList;
  const item = createItem(ctx, { name: 'W', defaultUnitPriceMinor: 100 }).item;
  assert.equal(setPriceListPrice(ctx, { priceListId: list.id, itemId: item.id, priceMinor: -1, validFrom: '2026-01-01' }).error, 'invalid_price');
  assert.equal(setPriceListPrice(ctx, { priceListId: list.id, itemId: item.id, priceMinor: 100, currency: 'GBP', validFrom: '2026-01-01' }).error, 'invalid_currency');
  assert.equal(setPriceListPrice(ctx, { priceListId: list.id, itemId: item.id, priceMinor: 100, validFrom: 'nope' }).error, 'invalid_input');
  assert.equal(setPriceListPrice(ctx, { priceListId: 'ghost', itemId: item.id, priceMinor: 100, validFrom: '2026-01-01' }).error, 'not_found');
});

test('getPriceList returns the list and its price rows', () => {
  const { ctx } = setup();
  const list = upsertPriceList(ctx, { name: 'L', segment: 'key_account' }).priceList;
  const item = createItem(ctx, { name: 'W', defaultUnitPriceMinor: 100 }).item;
  setPriceListPrice(ctx, { priceListId: list.id, itemId: item.id, priceMinor: 4200, validFrom: '2026-01-01' });
  const got = getPriceList(ctx, { priceListId: list.id });
  assert.equal(got.ok, true);
  assert.equal(got.prices.length, 1);
  assert.equal(got.prices[0].priceMinor, 4200);
});

// ---------------------------------------------------------------------------------------------
// delete_item: reference census + idempotency
// ---------------------------------------------------------------------------------------------

test('deleteItem removes an orphan but refuses one on a price list (item_referenced)', () => {
  const { ctx } = setup();
  const orphan = createItem(ctx, { name: 'Weg', defaultUnitPriceMinor: 100 }).item;
  assert.equal(deleteItem(ctx, { itemId: orphan.id }).ok, true);
  assert.equal(listItems(ctx, { includeArchived: true }).items.some((i) => i.id === orphan.id), false);

  const list = upsertPriceList(ctx, { name: 'L', segment: 'key_account' }).priceList;
  const priced = createItem(ctx, { name: 'Bepreist', defaultUnitPriceMinor: 100 }).item;
  setPriceListPrice(ctx, { priceListId: list.id, itemId: priced.id, priceMinor: 100, validFrom: '2026-01-01' });
  const refused = deleteItem(ctx, { itemId: priced.id });
  assert.equal(refused.error, 'item_referenced');
  assert.deepEqual(refused.refs, ['price_list_item']);
});

test('deleteItem refuses an item that still has a variant', () => {
  const { ctx } = setup();
  const parent = createItem(ctx, { name: 'P', defaultUnitPriceMinor: 100 }).item;
  createItem(ctx, { name: 'V', defaultUnitPriceMinor: 100, variantOfId: parent.id });
  const refused = deleteItem(ctx, { itemId: parent.id });
  assert.equal(refused.error, 'item_referenced');
  assert.deepEqual(refused.refs, ['variant']);
});

test('deleteItem replays its result under a repeated idempotencyKey (no throw, no second effect)', () => {
  const { ctx, store, workspaceId } = setup();
  // Two items, so "the table is empty" cannot pass for "exactly one row was removed".
  createItem(ctx, { name: 'Bleibt', defaultUnitPriceMinor: 100 });
  const item = createItem(ctx, { name: 'Weg', defaultUnitPriceMinor: 100 }).item;
  assert.equal(rowCount(store, 'item', workspaceId), 2);

  const first = deleteItem(ctx, { itemId: item.id, idempotencyKey: 'del-1' });
  const afterFirst = rowCount(store, 'item', workspaceId);
  const second = deleteItem(ctx, { itemId: item.id, idempotencyKey: 'del-1' });

  assert.equal(first.ok, true);
  assert.equal(second.ok, true, 'replay returns the stored success, not not_found');
  assert.deepEqual(second, first);
  // ON ROWS, not only on the result: the replay must not delete a second time, and the identical
  // payload above cannot see that (it is read back out of the idempotency store either way).
  assert.equal(afterFirst, 1, 'the first call removed exactly one row');
  assert.equal(rowCount(store, 'item', workspaceId), 1, 'the replay removed nothing');
  assert.equal(rowCount(store, 'idempotency', workspaceId), 1, 'and recorded the key exactly once');
});

test('deleteItemCategory replays its result under a repeated idempotencyKey, on ROWS', () => {
  const { ctx, store, workspaceId } = setup();
  upsertItemCategory(ctx, { name: 'Bleibt' });
  const cat = upsertItemCategory(ctx, { name: 'Weg' }).category;
  assert.equal(rowCount(store, 'item_category', workspaceId), 2);

  const first = deleteItemCategory(ctx, { categoryId: cat.id, idempotencyKey: 'icd-1' });
  const afterFirst = rowCount(store, 'item_category', workspaceId);
  const second = deleteItemCategory(ctx, { categoryId: cat.id, idempotencyKey: 'icd-1' });

  assert.equal(first.ok, true);
  assert.equal(second.ok, true, 'replay returns the stored success, not not_found');
  assert.deepEqual(second, first);
  assert.equal(afterFirst, 1, 'the first call removed exactly one category');
  assert.equal(rowCount(store, 'item_category', workspaceId), 1, 'the replay removed nothing');
  assert.equal(rowCount(store, 'idempotency', workspaceId), 1, 'and recorded the key exactly once');
});

// ---------------------------------------------------------------------------------------------
// §H-TENANT across the new surfaces
// ---------------------------------------------------------------------------------------------

test('§H-TENANT: categories, price lists and resolvePrice never cross a workspace boundary', () => {
  const { ctx, deps } = setup();
  const cat = upsertItemCategory(ctx, { name: 'Nur A' }).category;
  const list = upsertPriceList(ctx, { name: 'Nur A', segment: 'key_account' }).priceList;
  const item = createItem(ctx, { name: 'Nur A', defaultUnitPriceMinor: 100 }).item;

  const other = newWorkspace(deps, 'Zweite AG');
  assert.equal(listItemCategories(other).categories.length, 0, 'no cross-workspace categories');
  assert.equal(listPriceLists(other).priceLists.length, 0, 'no cross-workspace price lists');
  // The other workspace cannot resolve, delete, or read the first workspace item.
  assert.equal(resolvePrice(other, { itemId: item.id }).error, 'not_found');
  assert.equal(deleteItem(other, { itemId: item.id }).error, 'not_found');
  assert.equal(deleteItemCategory(other, { categoryId: cat.id }).error, 'not_found');
  // Using the first workspace list id from the second workspace does not leak either.
  assert.equal(getPriceList(other, { priceListId: list.id }).error, 'not_found');
});

test('§H-TENANT: the three WRITE verbs refuse a foreign id rather than reaching across', () => {
  const { ctx, deps, store, workspaceId } = setup();
  const contact = createContact(ctx, { partyRole: 'customer', name: 'Muster AG' }).contact;
  const cat = upsertItemCategory(ctx, { name: 'Nur A' }).category;
  const list = upsertPriceList(ctx, { name: 'Nur A', contactId: contact.id }).priceList;
  const item = createItem(ctx, { name: 'Nur A', defaultUnitPriceMinor: 100 }).item;

  const other = newWorkspace(deps, 'Zweite AG');

  // upsertPriceList: a contact that exists, but in the OTHER workspace, is not a contact here.
  assert.equal(
    upsertPriceList(other, { name: 'Fremd', contactId: contact.id }).error,
    'contact_not_found',
    'a foreign contact cannot be given a price list',
  );
  // Editing a foreign list by id is a not_found, not an edit.
  assert.equal(upsertPriceList(other, { priceListId: list.id, name: 'Umbenannt' }).error, 'not_found');

  // upsertItemCategory: a foreign category id is neither editable nor adoptable as a parent.
  assert.equal(upsertItemCategory(other, { categoryId: cat.id, name: 'Umbenannt' }).error, 'not_found');
  assert.equal(upsertItemCategory(other, { name: 'Kind', parentId: cat.id }).error, 'parent_not_found');

  // setPriceListPrice: with EITHER id foreign, and with both.
  const ownList = upsertPriceList(other, { name: 'Eigen', segment: 'key_account' }).priceList;
  const ownItem = createItem(other, { name: 'Eigen', defaultUnitPriceMinor: 100 }).item;
  const price = { priceMinor: 4200, validFrom: '2026-01-01' };
  assert.equal(setPriceListPrice(other, { priceListId: list.id, itemId: ownItem.id, ...price }).error, 'not_found');
  assert.equal(setPriceListPrice(other, { priceListId: ownList.id, itemId: item.id, ...price }).error, 'not_found');
  assert.equal(setPriceListPrice(other, { priceListId: list.id, itemId: item.id, ...price }).error, 'not_found');

  // And nothing was written on the way to any of those refusals, in either workspace.
  assert.equal(rowCount(store, 'price_list_item', workspaceId), 0);
  assert.equal(rowCount(store, 'price_list_item', other.workspaceId), 0);
  assert.equal(rowCount(store, 'item_category', other.workspaceId), 0);
  assert.equal(rowCount(store, 'price_list', workspaceId), 1, 'the first workspace list was not renamed away');
  assert.equal(listPriceLists(ctx).priceLists[0].name, 'Nur A');
});

// ---------------------------------------------------------------------------------------------
// F1: `unit` narrowed from A09 free text to the ITEM_UNITS enum, WITHOUT stranding the old rows
// ---------------------------------------------------------------------------------------------

test('F1: a pre-D00 free-text unit survives a patch that does not touch the unit', () => {
  const { ctx, store } = setup();
  const item = createItem(ctx, { name: 'Beratung', defaultUnitPriceMinor: 15000 }).item;
  forceLegacyUnit(store, item.id, 'Stunde');

  // The Studio editor's real save shape: every loaded field resent, including the untouched unit.
  const resent = updateItem(ctx, {
    itemId: item.id,
    patch: { name: 'Beratung', defaultUnitPriceMinor: 16000, unit: 'Stunde', currency: 'CHF' },
  });
  assert.equal(resent.ok, true, 'resending the stored unit verbatim is not a change and is accepted');
  assert.equal(resent.item.unit, 'Stunde', 'and the operator word is left exactly as he typed it');
  assert.equal(resent.item.defaultUnitPriceMinor, 16000, 'the edit he actually made landed');

  // Omitting it entirely is accepted too.
  assert.equal(updateItem(ctx, { itemId: item.id, patch: { defaultUnitPriceMinor: 17000 } }).ok, true);
  assert.equal(getItem(ctx, { itemId: item.id }).item.unit, 'Stunde');
});

test('F1: the enum still binds the value being INTRODUCED, on create and on update', () => {
  const { ctx, store } = setup();
  // A fresh row has nothing legacy about it: a non-enum unit is refused, as D00 intends.
  assert.equal(createItem(ctx, { name: 'A', defaultUnitPriceMinor: 100, unit: 'Stunde' }).error, 'invalid_unit');

  const item = createItem(ctx, { name: 'B', defaultUnitPriceMinor: 100, unit: 'hour' }).item;
  // Moving an enum value to a non-enum value is a change, so it is refused.
  assert.equal(updateItem(ctx, { itemId: item.id, patch: { unit: 'Stunde' } }).error, 'invalid_unit');
  // Moving a LEGACY value to another non-enum value is also refused: the escape hatch is not a hole.
  const legacy = createItem(ctx, { name: 'C', defaultUnitPriceMinor: 100 }).item;
  forceLegacyUnit(store, legacy.id, 'Stunde');
  assert.equal(updateItem(ctx, { itemId: legacy.id, patch: { unit: 'Std.' } }).error, 'invalid_unit');
  // Moving it to an enum member migrates the row for good, and clearing it is always allowed.
  assert.equal(updateItem(ctx, { itemId: legacy.id, patch: { unit: 'hour' } }).item.unit, 'hour');
  assert.equal(updateItem(ctx, { itemId: legacy.id, patch: { unit: null } }).item.unit, null);
});

test('F1: an item with a legacy unit is still usable as a variant parent', () => {
  const { ctx, store } = setup();
  const parent = createItem(ctx, { name: 'T-Shirt', defaultUnitPriceMinor: 2500, kind: 'product' }).item;
  forceLegacyUnit(store, parent.id, 'Stück');

  // Inherited silently (the Studio's create-variant path seeds nothing).
  const inherited = createItem(ctx, { name: 'T-Shirt L', defaultUnitPriceMinor: 2500, variantOfId: parent.id });
  assert.equal(inherited.ok, true);
  assert.equal(inherited.item.unit, 'Stück', 'the snapshot carries the parent value as it stands');

  // Resent explicitly, which is what the ItemEditor actually sends after seeding from the parent.
  const resent = createItem(ctx, {
    name: 'T-Shirt M',
    defaultUnitPriceMinor: 2500,
    variantOfId: parent.id,
    unit: 'Stück',
  });
  assert.equal(resent.ok, true);
  assert.equal(resent.item.unit, 'Stück');

  // An override still has to be an enum member.
  assert.equal(
    createItem(ctx, { name: 'T-Shirt S', defaultUnitPriceMinor: 2500, variantOfId: parent.id, unit: 'Stk' }).error,
    'invalid_unit',
  );
});

// ---------------------------------------------------------------------------------------------
// F2 / F3: every date is a validated, normalised ISO day, because the comparison is a STRING one
// ---------------------------------------------------------------------------------------------

/** A contact list holding one price, so a skipped scope is visible as a fallback to base. */
function pricedFixture() {
  const s = setup();
  const contact = createContact(s.ctx, { partyRole: 'customer', name: 'Muster AG' }).contact;
  const item = createItem(s.ctx, { name: 'Widget', defaultUnitPriceMinor: 5000, currency: 'CHF' }).item;
  const list = upsertPriceList(s.ctx, { name: 'MusterListe', contactId: contact.id }).priceList;
  setPriceListPrice(s.ctx, { priceListId: list.id, itemId: item.id, priceMinor: 4000, validFrom: '2026-01-01' });
  return { ...s, contact, item, list };
}

test('F2: a de-CH formatted `at` is REFUSED, not quietly answered with the base price', () => {
  const { ctx, contact, item } = pricedFixture();
  // The exact string this capability's own surface renders through formatDate. It sorts below every
  // '2026-...' row, so the contact scope was skipped and the BASE price came back with ok:true.
  const res = resolvePrice(ctx, { itemId: item.id, contactId: contact.id, at: '16.07.2026' });
  assert.equal(res.ok, false, 'a date that cannot sort must not resolve a price');
  assert.equal(res.error, 'invalid_input');
  assert.equal(res.field, 'at');
});

test('F2: a non-date `at` is refused instead of letting a far-future price win', () => {
  const { ctx, contact, item, list } = pricedFixture();
  // A row nobody should ever be quoted today.
  setPriceListPrice(ctx, { priceListId: list.id, itemId: item.id, priceMinor: 99900, validFrom: '2099-01-01' });
  for (const at of ['heute', 'x', '2026', '2026-07', 'now', '', '16/07/2026', '2026-07-16 ']) {
    const res = resolvePrice(ctx, { itemId: item.id, contactId: contact.id, at });
    if (at === '') {
      // Empty is "unspecified", which means today: the 2099 row is inert and the 2026 one applies.
      assert.equal(res.ok, true);
      assert.equal(res.priceMinor, 4000, 'an empty at means today, not the end of time');
    } else {
      assert.equal(res.ok, false, `at=${JSON.stringify(at)} must be refused`);
      assert.equal(res.error, 'invalid_input');
      assert.equal(res.field, 'at');
    }
  }
});

test('F2: an impossible calendar date is refused, and a full ISO instant resolves as its own day', () => {
  const { ctx, contact, item } = pricedFixture();
  assert.equal(resolvePrice(ctx, { itemId: item.id, contactId: contact.id, at: '2026-02-30' }).error, 'invalid_input');
  assert.equal(resolvePrice(ctx, { itemId: item.id, contactId: contact.id, at: '2026-13-01' }).error, 'invalid_input');

  // A timestamp and the bare day it names must answer identically, or every caller has to know which
  // shape the resolver prefers.
  const day = resolvePrice(ctx, { itemId: item.id, contactId: contact.id, at: '2026-01-01' });
  const instant = resolvePrice(ctx, { itemId: item.id, contactId: contact.id, at: '2026-01-01T23:59:59.999Z' });
  assert.equal(day.ok, true);
  assert.equal(day.priceMinor, 4000, 'valid_from is inclusive of its own day');
  assert.deepEqual(instant, day);

  // Absent means the injected clock's day (the suite pins 2026-07-16), not the wall clock.
  const today = resolvePrice(ctx, { itemId: item.id, contactId: contact.id });
  assert.equal(today.source, 'contact');
  assert.equal(today.priceMinor, 4000);
});

test('F3: setPriceListPrice refuses an unanchored or impossible validFrom, and stores the bare day', () => {
  const { ctx, item, list, store, workspaceId } = pricedFixture();
  const bad = ['2026-13-99', '2026-01-01-GARBAGE', '2026-02-30', '2026-1-1', 'nope', '', '20260101'];
  for (const validFrom of bad) {
    const res = setPriceListPrice(ctx, { priceListId: list.id, itemId: item.id, priceMinor: 111, validFrom });
    assert.equal(res.ok, false, `validFrom=${JSON.stringify(validFrom)} must be refused`);
    assert.equal(res.error, 'invalid_input');
    assert.equal(res.field, 'validFrom');
  }
  assert.equal(rowCount(store, 'price_list_item', workspaceId), 1, 'not one refusal wrote a row');

  // A month-13 row would have sorted after every real date of 2026 and shadowed the real price for
  // over a year, with the surface showing it as set and history append-only.
  const still = resolvePrice(ctx, { itemId: item.id, contactId: pricedContactOf(ctx), at: '2026-12-31' });
  assert.equal(still.priceMinor, 4000);

  // A full instant is accepted and NORMALISED, so the row compares against a day like every other.
  const set = setPriceListPrice(ctx, {
    priceListId: list.id,
    itemId: item.id,
    priceMinor: 3500,
    validFrom: '2026-06-01T09:30:00.000Z',
  });
  assert.equal(set.ok, true);
  assert.equal(set.priceListItem.validFrom, '2026-06-01');
  assert.equal(
    store.db.prepare('SELECT valid_from AS v FROM price_list_item WHERE id = ?').get(set.priceListItem.id).v,
    '2026-06-01',
    'stored as the bare day, not as the instant',
  );
  assert.equal(resolvePrice(ctx, { itemId: item.id, contactId: pricedContactOf(ctx), at: '2026-06-01' }).priceMinor, 3500);
});

/** The single contact `pricedFixture` made, read back so the date tests do not re-thread it. */
function pricedContactOf(ctx) {
  return listPriceLists(ctx).priceLists[0].contactId;
}

// ---------------------------------------------------------------------------------------------
// F4: one scope holds at most one list, so no price is ever resolved by insertion order
// ---------------------------------------------------------------------------------------------

test('F4: a second list in an occupied scope is refused (scope_taken), naming the existing list', () => {
  const { ctx, store, workspaceId } = setup();
  const contact = createContact(ctx, { partyRole: 'customer', name: 'Muster AG' }).contact;

  const first = upsertPriceList(ctx, { name: 'Muster 2026', contactId: contact.id }).priceList;
  const dup = upsertPriceList(ctx, { name: 'Muster 2026 neu', contactId: contact.id });
  assert.equal(dup.ok, false);
  assert.equal(dup.error, 'scope_taken');
  assert.equal(dup.priceListId, first.id, 'the refusal names the list to edit instead');
  assert.equal(dup.contactId, contact.id);

  const seg = upsertPriceList(ctx, { name: 'Grosskunden', segment: 'key_account' }).priceList;
  const segDup = upsertPriceList(ctx, { name: 'Grosskunden neu', segment: 'key_account' });
  assert.equal(segDup.error, 'scope_taken');
  assert.equal(segDup.priceListId, seg.id);
  assert.equal(segDup.segment, 'key_account');

  // A DIFFERENT contact and a different segment are of course fine.
  const second = createContact(ctx, { partyRole: 'customer', name: 'Andere AG' }).contact;
  assert.equal(upsertPriceList(ctx, { name: 'Andere', contactId: second.id }).ok, true);
  assert.equal(upsertPriceList(ctx, { name: 'Kleinkunden', segment: 'retail' }).ok, true);
  assert.equal(rowCount(store, 'price_list', workspaceId), 4, 'two refusals wrote nothing');
});

test('F4: editing a list keeps its own scope, and moving one into an occupied scope is refused', () => {
  const { ctx } = setup();
  const a = createContact(ctx, { partyRole: 'customer', name: 'A AG' }).contact;
  const b = createContact(ctx, { partyRole: 'customer', name: 'B AG' }).contact;
  const listA = upsertPriceList(ctx, { name: 'A-Liste', contactId: a.id }).priceList;
  const listB = upsertPriceList(ctx, { name: 'B-Liste', contactId: b.id }).priceList;

  // A rename must not read the row it is renaming as its own duplicate.
  const renamed = upsertPriceList(ctx, { priceListId: listA.id, name: 'A-Liste 2027' });
  assert.equal(renamed.ok, true);
  assert.equal(renamed.priceList.name, 'A-Liste 2027');
  assert.equal(renamed.priceList.contactId, a.id, 'and the scope is untouched');

  // Re-pointing B at A's contact would create the ambiguity by the back door.
  const moved = upsertPriceList(ctx, { priceListId: listB.id, contactId: a.id });
  assert.equal(moved.error, 'scope_taken');
  assert.equal(moved.priceListId, listA.id);

  // Moving it to a free scope is allowed, and then A's scope is free for B in turn.
  assert.equal(upsertPriceList(ctx, { priceListId: listB.id, segment: 'key_account', contactId: null }).ok, true);
});

test('F4: the duplicate refusal does not fire on an idempotent REPLAY of the creating call', () => {
  const { ctx, store, workspaceId } = setup();
  const contact = createContact(ctx, { partyRole: 'customer', name: 'Muster AG' }).contact;
  const key = 'plu-replay';
  const first = upsertPriceList(ctx, { name: 'Muster', contactId: contact.id, idempotencyKey: key });
  const replay = upsertPriceList(ctx, { name: 'Muster', contactId: contact.id, idempotencyKey: key });
  assert.equal(first.ok, true);
  assert.equal(replay.ok, true, 'a replay must return its stored success, not scope_taken');
  assert.deepEqual(replay, first);
  assert.equal(rowCount(store, 'price_list', workspaceId), 1, 'and there is still exactly one list');
});

// ---------------------------------------------------------------------------------------------
// F9: the reference census covers the G00 custom-field attachment point
// ---------------------------------------------------------------------------------------------

test('F9: an item carrying a custom field value cannot be hard-deleted (item_referenced)', () => {
  const { ctx, store, workspaceId } = setup();
  const item = createItem(ctx, { name: 'Mit Zusatzfeld', defaultUnitPriceMinor: 100 }).item;
  const def = defineField(ctx, {
    entityKind: 'item',
    key: 'lieferant',
    labelI18n: { 'de-CH': 'Lieferant', en: 'Supplier' },
    type: 'text',
    idempotencyKey: 'df-1',
  });
  assert.equal(def.ok, true, 'the fixture itself has to work');
  // The payload names it `fieldDefId`, not `id`. This read used to be `def.fieldDef.id`, so the
  // confirm ran on `undefined` and did nothing: the assertions below held anyway because
  // `setFieldValue` keys on `fieldKey`, which is exactly how a silently inert fixture step survives.
  confirmField(ctx, { fieldDefId: def.fieldDef.fieldDefId });
  assert.equal(
    setFieldValue(ctx, { entityKind: 'item', entityId: item.id, fieldKey: 'lieferant', value: 'Meier AG' }).ok,
    true,
  );

  const refused = deleteItem(ctx, { itemId: item.id });
  assert.equal(refused.error, 'item_referenced');
  assert.deepEqual(refused.refs, ['custom_field_value']);
  assert.equal(rowCount(store, 'item', workspaceId), 1, 'the item is still there to archive instead');
  assert.equal(rowCount(store, 'custom_field_value', workspaceId), 1, 'and its value is not stranded');

  // An item with no values is unaffected: the census reads (entity_kind, entity_id), not the table.
  const orphan = createItem(ctx, { name: 'Ohne', defaultUnitPriceMinor: 100 }).item;
  assert.equal(deleteItem(ctx, { itemId: orphan.id }).ok, true);
});

// ---------------------------------------------------------------------------------------------
// F6: a price row and a price list can be removed, so the census can reach zero
// ---------------------------------------------------------------------------------------------

test('F6: unsetting an item price makes resolvePrice fall back to base and frees the hard delete', () => {
  // This is the §8 browser-flow step that was previously unimplementable: "price_resolve returns the
  // contact price then falls back to base AFTER LIST REMOVAL". Nothing removed a row, so the contact
  // price could only ever be shadowed and the item could never be hard-deleted again.
  const { ctx, store, workspaceId } = setup();
  const contact = createContact(ctx, { partyRole: 'customer', name: 'Meier AG' }).contact;
  const item = createItem(ctx, { name: 'Beratung', defaultUnitPriceMinor: 15000 }).item;
  const list = upsertPriceList(ctx, { name: 'Meier AG', contactId: contact.id }).priceList;
  setPriceListPrice(ctx, { priceListId: list.id, itemId: item.id, priceMinor: 13500, validFrom: '2026-01-01' });

  const priced = resolvePrice(ctx, { itemId: item.id, contactId: contact.id, at: '2026-06-30' });
  assert.equal(priced.priceMinor, 13500);
  assert.equal(priced.source, 'contact');
  // The reference census counts the row, so the item cannot be hard-deleted while it is priced.
  assert.equal(deleteItem(ctx, { itemId: item.id }).error, 'item_referenced');

  const unset = unsetPriceListPrice(ctx, { priceListId: list.id, itemId: item.id });
  assert.equal(unset.ok, true);
  assert.equal(unset.removed, 1);
  assert.equal(unset.validFrom, null, 'no validFrom means the whole per-item history in this list');
  assert.equal(rowCount(store, 'price_list_item', workspaceId), 0);

  const fellBack = resolvePrice(ctx, { itemId: item.id, contactId: contact.id, at: '2026-06-30' });
  assert.equal(fellBack.priceMinor, 15000, 'the item base sales price');
  assert.equal(fellBack.source, 'base');
  // And the census now passes, which is the consequence F6 said was unintended.
  assert.equal(deleteItem(ctx, { itemId: item.id }).ok, true);
});

test('F6: a validFrom-scoped unset retracts exactly one dated row and leaves the rest of the history', () => {
  const { ctx, store, workspaceId } = setup();
  const item = createItem(ctx, { name: 'Beratung', defaultUnitPriceMinor: 15000 }).item;
  const list = upsertPriceList(ctx, { name: 'Wiederverkauf', segment: 'reseller' }).priceList;
  setPriceListPrice(ctx, { priceListId: list.id, itemId: item.id, priceMinor: 13500, validFrom: '2026-01-01' });
  setPriceListPrice(ctx, { priceListId: list.id, itemId: item.id, priceMinor: 12000, validFrom: '2026-07-01' });
  assert.equal(rowCount(store, 'price_list_item', workspaceId), 2);

  // The mis-keyed later row goes; the earlier one is untouched and becomes effective again.
  const unset = unsetPriceListPrice(ctx, { priceListId: list.id, itemId: item.id, validFrom: '2026-07-01' });
  assert.equal(unset.removed, 1);
  assert.equal(unset.validFrom, '2026-07-01');
  assert.equal(rowCount(store, 'price_list_item', workspaceId), 1);
  assert.equal(getPriceList(ctx, { priceListId: list.id }).prices[0].priceMinor, 13500);

  // A full ISO instant names the same day, and a malformed date is refused rather than matching nothing.
  assert.equal(
    unsetPriceListPrice(ctx, { priceListId: list.id, itemId: item.id, validFrom: '2026-01-01T09:00:00Z' }).removed,
    1,
  );
  const bad = unsetPriceListPrice(ctx, { priceListId: list.id, itemId: item.id, validFrom: '01.01.2026' });
  assert.equal(bad.error, 'invalid_input');
  assert.equal(bad.field, 'validFrom');
});

test('F6: unsetPriceListPrice is idempotent ON ROWS, by key and by repetition', () => {
  const { ctx, store, workspaceId } = setup();
  const item = createItem(ctx, { name: 'A', defaultUnitPriceMinor: 100 }).item;
  const other = createItem(ctx, { name: 'B', defaultUnitPriceMinor: 100 }).item;
  const list = upsertPriceList(ctx, { name: 'L', segment: 'retail' }).priceList;
  setPriceListPrice(ctx, { priceListId: list.id, itemId: item.id, priceMinor: 90, validFrom: '2026-01-01' });
  // A second item's row, so "the table is empty" cannot pass for "exactly one row was removed".
  setPriceListPrice(ctx, { priceListId: list.id, itemId: other.id, priceMinor: 80, validFrom: '2026-01-01' });
  assert.equal(rowCount(store, 'price_list_item', workspaceId), 2);

  const first = unsetPriceListPrice(ctx, { priceListId: list.id, itemId: item.id, idempotencyKey: 'plup-1' });
  const afterFirst = rowCount(store, 'price_list_item', workspaceId);
  const replay = unsetPriceListPrice(ctx, { priceListId: list.id, itemId: item.id, idempotencyKey: 'plup-1' });

  assert.equal(first.removed, 1);
  assert.deepEqual(replay, first, 'the replay returns the stored count, not a fresh zero');
  assert.equal(afterFirst, 1, 'the first call removed exactly one row');
  assert.equal(rowCount(store, 'price_list_item', workspaceId), 1, 'the replay removed nothing');
  assert.equal(rowCount(store, 'idempotency', workspaceId), 1);

  // Without a key a repeat is not a replay: it honestly reports that there was nothing left to remove,
  // and the row count is the same either way, which is the invariant that matters.
  const repeat = unsetPriceListPrice(ctx, { priceListId: list.id, itemId: item.id });
  assert.equal(repeat.ok, true);
  assert.equal(repeat.removed, 0);
  assert.equal(rowCount(store, 'price_list_item', workspaceId), 1);
});

test('F6: deletePriceList cascades its price rows and leaves every other list alone', () => {
  const { ctx, store, workspaceId } = setup();
  const item = createItem(ctx, { name: 'A', defaultUnitPriceMinor: 100 }).item;
  const doomed = upsertPriceList(ctx, { name: 'Weg', segment: 'retail' }).priceList;
  const kept = upsertPriceList(ctx, { name: 'Bleibt', segment: 'reseller' }).priceList;
  setPriceListPrice(ctx, { priceListId: doomed.id, itemId: item.id, priceMinor: 90, validFrom: '2026-01-01' });
  setPriceListPrice(ctx, { priceListId: doomed.id, itemId: item.id, priceMinor: 85, validFrom: '2026-07-01' });
  setPriceListPrice(ctx, { priceListId: kept.id, itemId: item.id, priceMinor: 80, validFrom: '2026-01-01' });

  const gone = deletePriceList(ctx, { priceListId: doomed.id });
  assert.equal(gone.ok, true);
  assert.equal(gone.deleted, true);
  assert.equal(gone.removedPrices, 2, 'the cascade reports what it took, rather than reporting nothing');
  assert.equal(rowCount(store, 'price_list', workspaceId), 1);
  assert.equal(rowCount(store, 'price_list_item', workspaceId), 1, 'only the doomed list rows went');
  assert.deepEqual(
    listPriceLists(ctx).priceLists.map((l) => l.name),
    ['Bleibt'],
  );
  assert.equal(deletePriceList(ctx, { priceListId: doomed.id }).error, 'not_found');
});

test('F6: deletePriceList replays under a repeated idempotencyKey, on ROWS', () => {
  const { ctx, store, workspaceId } = setup();
  const item = createItem(ctx, { name: 'A', defaultUnitPriceMinor: 100 }).item;
  upsertPriceList(ctx, { name: 'Bleibt', segment: 'reseller' });
  const doomed = upsertPriceList(ctx, { name: 'Weg', segment: 'retail' }).priceList;
  setPriceListPrice(ctx, { priceListId: doomed.id, itemId: item.id, priceMinor: 90, validFrom: '2026-01-01' });

  const first = deletePriceList(ctx, { priceListId: doomed.id, idempotencyKey: 'pld-1' });
  const afterFirst = rowCount(store, 'price_list', workspaceId);
  const replay = deletePriceList(ctx, { priceListId: doomed.id, idempotencyKey: 'pld-1' });

  assert.equal(first.ok, true);
  assert.equal(replay.ok, true, 'the replay returns the stored success, not not_found');
  assert.deepEqual(replay, first);
  assert.equal(afterFirst, 1, 'the first call removed exactly one list');
  assert.equal(rowCount(store, 'price_list', workspaceId), 1, 'the replay removed nothing');
  assert.equal(rowCount(store, 'price_list_item', workspaceId), 0);
  assert.equal(rowCount(store, 'idempotency', workspaceId), 1);
});

test('F6: a price list carrying a custom field value is refused (price_list_referenced)', () => {
  // `price_list` is not an OP3 entity kind yet (spec §6b defers that line to G00), so `defineField`
  // cannot reach it and the row has to be written directly. That is the point of testing it: the
  // census is in place BEFORE the enum line lands, so the day it lands nothing is stranded.
  const { ctx, store, workspaceId, AT } = setup();
  const list = upsertPriceList(ctx, { name: 'Mit Zusatzfeld', segment: 'retail' }).priceList;
  // A REAL def, because `custom_field_value.field_def_id` carries an enforced FK: only the
  // `entity_kind` of the VALUE row is written by hand, which is the one thing no verb can do yet.
  const def = defineField(ctx, {
    entityKind: 'item',
    key: 'staffel',
    labelI18n: { 'de-CH': 'Staffel', en: 'Tier' },
    type: 'text',
    idempotencyKey: 'df-pl',
  });
  assert.equal(def.ok, true, 'the fixture itself has to work');
  store.db
    .prepare(
      `INSERT INTO custom_field_value (id, workspace_id, field_def_id, entity_kind, entity_id, value, created_at, updated_at)
       VALUES (?, ?, ?, 'price_list', ?, ?, ?, ?)`,
    )
    .run('cfv_pl', workspaceId, def.fieldDef.fieldDefId, list.id, '"A"', AT, AT);

  const refused = deletePriceList(ctx, { priceListId: list.id });
  assert.equal(refused.error, 'price_list_referenced');
  assert.deepEqual(refused.refs, ['custom_field_value']);
  assert.equal(rowCount(store, 'price_list', workspaceId), 1, 'the list is still there');
});

test('F6: §H-TENANT: neither removal reaches a list in another workspace', () => {
  const { ctx, deps } = setup();
  const item = createItem(ctx, { name: 'A', defaultUnitPriceMinor: 100 }).item;
  const list = upsertPriceList(ctx, { name: 'Nur A', segment: 'retail' }).priceList;
  setPriceListPrice(ctx, { priceListId: list.id, itemId: item.id, priceMinor: 90, validFrom: '2026-01-01' });

  const other = newWorkspace(deps, 'B AG');
  assert.equal(unsetPriceListPrice(other, { priceListId: list.id, itemId: item.id }).error, 'not_found');
  assert.equal(deletePriceList(other, { priceListId: list.id }).error, 'not_found');
  // Nothing crossed: the row and the list are both still readable from their own tenant.
  assert.equal(getPriceList(ctx, { priceListId: list.id }).prices.length, 1);
});

// ---------------------------------------------------------------------------------------------
// F7: the declared `sku UNIQUE(workspace)` has a database constraint behind it
// ---------------------------------------------------------------------------------------------

test('F7: a duplicate sku is refused by the DATABASE, not only by the read-then-write above it', () => {
  // `skuTaken` is a SELECT followed by an INSERT with no transaction around the pair, so two writers
  // can both pass the read. The verb is still the front door and still answers `sku_taken`; this
  // asserts the floor UNDER it, by going around the verb the way a second writer effectively does.
  const { ctx, store, workspaceId } = setup();
  const first = createItem(ctx, { name: 'Laptop', defaultUnitPriceMinor: 100, sku: 'SKU-1' }).item;
  assert.equal(createItem(ctx, { name: 'Zweitgerät', defaultUnitPriceMinor: 100, sku: 'SKU-1' }).error, 'sku_taken');

  const insertDirect = (id, sku) =>
    store.db
      .prepare(
        `INSERT INTO item (id, workspace_id, name, default_unit_price_minor, currency, created_at, item_sku)
         VALUES (?, ?, 'Direkt', 100, 'CHF', '2026-07-30T00:00:00.000Z', ?)`,
      )
      .run(id, workspaceId, sku);

  assert.throws(() => insertDirect('it_dup', 'SKU-1'), /UNIQUE constraint failed/);
  // PARTIAL: a null SKU is outside the index, so two unnumbered items never collide. That is the
  // reason for the WHERE clause and the thing a plain unique index would have broken.
  insertDirect('it_null_a', null);
  insertDirect('it_null_b', null);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM item WHERE item_sku IS NULL').get().n, 2);
  // And it is scoped to the workspace, not to the database: the same article number in another tenant
  // is a different article number (§H-TENANT).
  assert.equal(first.sku, 'SKU-1');
});

test('F7: the index is created on a database written BEFORE the item_sku column existed', () => {
  // The order this exists for: `SCHEMA_SQL` runs before `ADDITIVE_COLUMNS`, so an index naming
  // `item_sku` in that string throws `no such column` on a pre-D00 file. Simulated by dropping the
  // column and the index from a real file and reopening it, which is what an old `~/.till/till.db`
  // looks like to this engine.
  const { store, workspaceId } = setup();
  const location = store.location;
  assert.equal(location, ':memory:', 'the shared fixture is in-memory; this test opens its own file');

  const dir = mkdtempSync(join(tmpdir(), 'till-d00-f7-'));
  const file = join(dir, 'till.db');
  try {
    const clock = fixedClock('2026-07-16T00:00:00.000Z');
    const old = new SqliteStore({ location: file, clock });
    old.db.exec('DROP INDEX IF EXISTS item_sku_unique_per_workspace');
    old.db.exec('ALTER TABLE item DROP COLUMN item_sku');
    assert.equal(
      old.db.prepare("SELECT COUNT(*) AS n FROM pragma_index_list('item') WHERE name = ?").get('item_sku_unique_per_workspace').n,
      0,
      'the fixture really removed it',
    );
    old.close();

    const reopened = new SqliteStore({ location: file, clock });
    try {
      assert.equal(
        reopened.db
          .prepare("SELECT COUNT(*) AS n FROM pragma_index_list('item') WHERE name = ?")
          .get('item_sku_unique_per_workspace').n,
        1,
        'reopening an old file adds the column AND the index over it',
      );
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(typeof workspaceId, 'string');
});
