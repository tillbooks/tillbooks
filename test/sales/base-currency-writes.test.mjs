// A base currency is a SETTING, not a synonym for CHF.
//
// `workspace.base_currency` is a real column and `baseCurrencyOf(ctx)` is its accessor. Two write
// paths in A09/A10 stamped the literal `'CHF'` instead of reading it, so a EUR-based book got francs
// on rows nobody named a currency for. That is the same defect `saveDraft` (§H-FX, generation 3) and
// `createItem` already had, arriving through two more doors:
//
//  - `createDocument` writes `document.currency`, and `issueInvoice` hands THAT value to
//    `resolveFxRate`. A EUR book issuing a document nobody named a currency for therefore asks for a
//    CHF/EUR rate: either a `needs_fx_rate` refusal naming a pair the operator never traded, or, once
//    somebody records that rate to make the refusal go away, a CONVERTED posting in a book whose own
//    currency was already the invoice's.
//  - `createContact` writes `contact.default_currency`, which is the currency the documents raised
//    against that party inherit. A wrong seed there is wrong on every invoice afterwards.
//
// The read model makes the shape visible without posting anything: `mapDocument` gates its FX block
// on `statesConversionBasis({ currency, baseCurrency })`, so a 'CHF' row in a EUR book reads as
// FOREIGN and the document claims a conversion basis for a conversion that never happened.
//
// Every assertion below reads the ROW BACK OUT OF SQLITE. A return value is the code agreeing with
// itself; the row is what the next verb, the next process and the auditor will see.

import test from 'node:test';
import assert from 'node:assert/strict';

import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { makeContext } from '../../dist/core/context.js';
import { fixedClock } from '../../dist/core/clock.js';
import { sequenceIdGen } from '../../dist/core/ids.js';
import { createWorkspace } from '../../dist/core/setup/index.js';
import { createDocument, getDocument, createContact } from '../../dist/core/sales/index.js';
import { statesConversionBasis } from '../../dist/core/ledger/postEntry.js';

const AT = '2026-07-16T00:00:00.000Z';

/** A store holding books in `baseCurrency`, plus a second tenant when one is asked for. */
function books(baseCurrency) {
  const clock = fixedClock(AT);
  const ids = sequenceIdGen();
  const store = new SqliteStore({ clock });
  const deps = { store, clock, ids };
  const ctx = tenant(deps, `Books ${baseCurrency}`, baseCurrency);
  return { ctx, store, deps };
}

function tenant(deps, name, baseCurrency) {
  const minted = createWorkspace(deps, { name, baseCurrency });
  assert.ok(minted.ok !== false, JSON.stringify(minted));
  return makeContext(deps.store, {
    workspaceId: minted.workspaceId,
    actor: 'user_1',
    clock: deps.clock,
    ids: deps.ids,
  });
}

const docRow = (store, id) =>
  store.db.prepare('SELECT currency FROM document WHERE id = ?').get(id);
const contactRow = (store, id) =>
  store.db.prepare('SELECT default_currency FROM contact WHERE id = ?').get(id);

function newDocument(ctx, input = {}) {
  const res = createDocument(ctx, { type: 'invoice', ...input });
  assert.ok(res.ok !== false, JSON.stringify(res));
  return res.document.id;
}

function newContact(ctx, input = {}) {
  const res = createContact(ctx, { partyRole: 'customer', name: 'Kundin AG', ...input });
  assert.ok(res.ok !== false, JSON.stringify(res));
  return res.contact.id;
}

// =============================================================================================
// createDocument
// =============================================================================================

test('a document nobody named a currency for is denominated in the BOOK, not in francs', () => {
  const { ctx, store } = books('EUR');
  const id = newDocument(ctx);
  assert.equal(
    docRow(store, id).currency,
    'EUR',
    'the stored row, not the label: a EUR book raises EUR documents by default',
  );
  store.close();
});

test('an explicit document currency still wins over the base one', () => {
  const { ctx, store } = books('EUR');
  assert.equal(docRow(store, newDocument(ctx, { currency: 'USD' })).currency, 'USD');
  assert.equal(docRow(store, newDocument(ctx, { currency: 'CHF' })).currency, 'CHF');
  store.close();
});

test('a CHF book is unchanged: an unnamed document currency is still CHF', () => {
  const { ctx, store } = books('CHF');
  assert.equal(docRow(store, newDocument(ctx)).currency, 'CHF');
  assert.equal(docRow(store, newDocument(ctx, { currency: 'EUR' })).currency, 'EUR');
  store.close();
});

test('a document nobody converted states no conversion basis in the read model', () => {
  const { ctx, store } = books('EUR');
  const id = newDocument(ctx);
  const view = getDocument(ctx, { documentId: id });
  assert.ok(view.ok !== false, JSON.stringify(view));
  const doc = view.document;

  assert.equal(
    statesConversionBasis({ currency: doc.currency, baseCurrency: 'EUR' }),
    false,
    'a document in the book currency is not a foreign one',
  );
  // The predicate decides the shape, so these two are one assertion made twice: the block is absent.
  assert.equal('fxRate' in doc, false, 'a domestic document has no rate to show');
  assert.equal('baseCurrency' in doc, false, 'nor a currency it was converted into');
  store.close();
});

test('two tenants in ONE store each get their own base currency on the row', () => {
  const { ctx: eur, store, deps } = books('EUR');
  const chf = tenant(deps, 'Zweite AG', 'CHF');
  assert.equal(docRow(store, newDocument(eur)).currency, 'EUR');
  assert.equal(docRow(store, newDocument(chf)).currency, 'CHF');
  store.close();
});

// =============================================================================================
// createContact
// =============================================================================================

test('a contact nobody named a currency for defaults to the BOOK, not to francs', () => {
  const { ctx, store } = books('EUR');
  assert.equal(
    contactRow(store, newContact(ctx)).default_currency,
    'EUR',
    'the currency the documents raised against this party will inherit',
  );
  store.close();
});

test('an explicit contact currency still wins over the base one', () => {
  const { ctx, store } = books('EUR');
  assert.equal(contactRow(store, newContact(ctx, { defaultCurrency: 'USD' })).default_currency, 'USD');
  assert.equal(contactRow(store, newContact(ctx, { defaultCurrency: 'CHF' })).default_currency, 'CHF');
  store.close();
});

test('a CHF book is unchanged: an unnamed contact currency is still CHF', () => {
  const { ctx, store } = books('CHF');
  assert.equal(contactRow(store, newContact(ctx)).default_currency, 'CHF');
  assert.equal(contactRow(store, newContact(ctx, { defaultCurrency: 'EUR' })).default_currency, 'EUR');
  store.close();
});

test('two tenants in ONE store each seed contacts with their own base currency', () => {
  const { ctx: eur, store, deps } = books('EUR');
  const chf = tenant(deps, 'Zweite AG', 'CHF');
  assert.equal(contactRow(store, newContact(eur)).default_currency, 'EUR');
  assert.equal(contactRow(store, newContact(chf)).default_currency, 'CHF');
  store.close();
});
