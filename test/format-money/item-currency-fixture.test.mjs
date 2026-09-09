/**
 * A09 items: what an item's currency GENUINELY is, and why the Studio's `?? 'CHF'` was two bugs.
 *
 * THE CALL SITE THIS EXISTS FOR. `Items.tsx` rendered `formatMoney(item.defaultUnitPriceMinor,
 * item.currency ?? 'CHF')`. Because the currency is an explicit argument there, removing
 * `formatMoney`'s defaulted parameter could not reach it: the fallback survived the change that
 * closed every other call site. Two separate questions are hiding in that one expression, and they
 * have different answers.
 *
 * ## 1. Can `currency` be null on the read model? No.
 *
 * `item.currency` is `TEXT NOT NULL DEFAULT 'CHF'` (`schema.ts`) and `mapItem` passes the column
 * straight through, so `list_items` and `get_item` cannot report a missing currency for a row that
 * exists. The Studio fallback was therefore unreachable over any engine answer: dead code that
 * looked like a safety net. It is asserted below against the `item` table rather than against the
 * verb's return value, because "the read model equals the row" is the claim being made.
 *
 * ## 2. Was the value it fell back to right? Also no, and that one WAS reachable.
 *
 * `createItem` wrote a literal `'CHF'` when the caller named no currency. In a EUR-base workspace
 * that stamped francs on every item created without an explicit pick, and the Studio then rendered
 * "CHF 150.00" perfectly honestly for a price that will go on a EUR document. Deleting the Studio
 * fallback alone would not have fixed that: the wrong currency was in the DATABASE, so the label
 * was right about a row that was wrong.
 *
 * A workspace's base currency is a SETTING (`workspace.base_currency`; `CURRENCIES` admits CHF, EUR
 * and USD), so the honest default is `baseCurrencyOf(ctx)`, read from the workspace, the same source
 * `saveDraft` and `postEntry` resolve theirs from. Every assertion below reads `item` and
 * `workspace` back out of SQLite, and the workspaces are deliberately EUR- and USD-based so a
 * hardcoded CHF cannot pass.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { makeContext } from '../../dist/core/context.js';
import { fixedClock } from '../../dist/core/clock.js';
import { sequenceIdGen } from '../../dist/core/ids.js';
import { createWorkspace } from '../../dist/core/setup/index.js';
import { getAction } from '../../dist/api/registry.js';

const AT = '2026-07-16T00:00:00.000Z';

/** A workspace on the named base currency. Nothing is seeded that A09 does not read. */
function setup(baseCurrency) {
  const clock = fixedClock(AT);
  const ids = sequenceIdGen();
  const store = new SqliteStore({ clock });
  const { workspaceId } = createWorkspace({ store, clock, ids }, { name: 'Nomadik GmbH', baseCurrency });
  const ctx = makeContext(store, { workspaceId, actor: 'user_1', clock, ids });
  return { ctx, store, workspaceId };
}

/** The currency the DATABASE holds for an item, never the one the verb reported. */
function storedCurrency(store, itemId) {
  return store.db.prepare('SELECT currency FROM item WHERE id = ?').get(itemId).currency;
}

/** The base currency as the DATABASE holds it, never as a test author typed it. */
function storedBase(store, workspaceId) {
  return store.db.prepare('SELECT base_currency FROM workspace WHERE id = ?').get(workspaceId).base_currency;
}

/** `create_item` through the registry: whatever the Studio does, an agent must reach the same way. */
function create(ctx, workspaceId, input) {
  const res = getAction('create_item').run(ctx, { workspaceId, ...input });
  assert.ok(res.ok, JSON.stringify(res));
  return res.item;
}

test('an item created with NO currency takes the workspace base currency, not a literal CHF', () => {
  const { ctx, store, workspaceId } = setup('EUR');
  const item = create(ctx, workspaceId, { name: 'Beratung', defaultUnitPriceMinor: 15000 });

  const base = storedBase(store, workspaceId);
  assert.equal(base, 'EUR', 'the books are kept in EUR, so a hardcoded CHF cannot pass this file');
  // The DATABASE, not the answer. A read model can only be as honest as the row behind it, and this
  // is the row a Studio label would have been perfectly accurate about and still wrong.
  assert.equal(storedCurrency(store, item.id), base, 'the stored currency is the base currency');
  assert.notEqual(storedCurrency(store, item.id), 'CHF', 'francs are what this workspace does NOT use');
  assert.equal(item.currency, base, 'and the read model reports the row');
});

test('an explicit currency still wins, because a foreign-priced item is a real thing to sell', () => {
  const { ctx, store, workspaceId } = setup('EUR');
  const item = create(ctx, workspaceId, { name: 'Export', defaultUnitPriceMinor: 9900, currency: 'USD' });

  assert.equal(storedCurrency(store, item.id), 'USD', 'the caller named a currency and it was kept');
  assert.notEqual(storedCurrency(store, item.id), storedBase(store, workspaceId));
  assert.equal(item.currency, 'USD');
});

test('a CHF workspace is unchanged: the default became a READ, not a different literal', () => {
  const { ctx, store, workspaceId } = setup('CHF');
  const item = create(ctx, workspaceId, { name: 'Beratung', defaultUnitPriceMinor: 15000 });

  assert.equal(storedBase(store, workspaceId), 'CHF');
  assert.equal(storedCurrency(store, item.id), 'CHF', 'the overwhelmingly common case did not move');
  assert.equal(item.currency, 'CHF');
});

test('every item the engine reports names a currency, so a client fallback is unreachable', () => {
  // The fact the Studio's `?? 'CHF'` was standing on. `item.currency` is TEXT NOT NULL with a
  // column default, and `mapItem` passes it through, so there is no engine answer in which the field
  // is absent, null or empty. Three items across three shapes, checked through both read verbs.
  const { ctx, store, workspaceId } = setup('USD');
  const made = [
    create(ctx, workspaceId, { name: 'Default', defaultUnitPriceMinor: 100 }),
    create(ctx, workspaceId, { name: 'Explicit', defaultUnitPriceMinor: 200, currency: 'CHF' }),
    create(ctx, workspaceId, { name: 'Free', defaultUnitPriceMinor: 0 }),
  ];

  const list = getAction('list_items').run(ctx, { workspaceId });
  assert.ok(list.ok, JSON.stringify(list));
  assert.equal(list.items.length, 3);
  for (const row of list.items) {
    assert.equal(typeof row.currency, 'string', 'list_items always denominates the price');
    assert.notEqual(row.currency, '');
    assert.equal(row.currency, storedCurrency(store, row.id), 'and reports the row, not a guess');
  }
  for (const item of made) {
    const got = getAction('get_item').run(ctx, { workspaceId, itemId: item.id });
    assert.ok(got.ok, JSON.stringify(got));
    assert.equal(got.item.currency, storedCurrency(store, item.id), 'get_item agrees with the row');
  }

  // And the default one is the workspace's, in a book kept in neither francs nor euros.
  assert.equal(storedCurrency(store, made[0].id), 'USD');
  assert.equal(storedCurrency(store, made[2].id), 'USD');
});
