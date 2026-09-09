/**
 * The A11 currency-picker fixture-versus-engine drift guard (M11-M13).
 *
 * The Studio's currency picker renders `exchange-rate.fixture.json` in jsdom, standing in for the
 * live `get_exchange_rate`, `list_exchange_rates` and `get_fx_method` responses. Same contract as
 * `invoice-gui-fixture.test.mjs` and `document-fixture.test.mjs`: pin every arm to the real engine
 * response, KEYS and KINDS (null its own kind), so an app test can never pass green against a shape
 * the engine does not return.
 *
 * This repo has shipped four Studio defects by assuming a key the engine never sends. The §H-FX
 * surface adds two traps of its own, and both are asserted below:
 *
 *  - the base-currency arm is an `ok` answer carrying `rateSource: 'base'` and a rate of `'1'`, not
 *    a rejection and not an absent rate. A picker that treated it as either would either show an
 *    error for a CHF invoice or render "1.00" beside one, and §H-FX says a rate of 1 is not FX.
 *  - `fx_method_not_elected` names a BASIS and carries no `currency` at all, because the refusal is
 *    about the election rather than about the pair. The client has to remember what it asked.
 *
 * The mirrored SIX cutover date is pinned here too: the app cannot import the engine's own constant
 * (its module reaches the store, which the browser bundle never touches), so the copy is a mirror,
 * and a mirror nobody checks is a fact with a half-life.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { makeContext } from '../../dist/core/context.js';
import { fixedClock } from '../../dist/core/clock.js';
import { sequenceIdGen } from '../../dist/core/ids.js';
import { createWorkspace } from '../../dist/core/setup/index.js';
import { configureVat } from '../../dist/core/vat/index.js';
import { createDocument } from '../../dist/core/sales/index.js';
import { issueInvoice, buildQrBill, QR_IBAN_CHF_ONLY_FROM } from '../../dist/core/sales/invoice.js';
import {
  recordExchangeRate,
  listExchangeRates,
  getExchangeRate,
  setFxMethod,
  getFxMethod,
  FX_RATE_METHODS,
  EXCHANGE_RATE_SOURCES,
} from '../../dist/core/fx/index.js';
import { getAction } from '../../dist/api/registry.js';

const DIR = new URL('../../app/src/surfaces/Documents/', import.meta.url);
const FIXTURE = JSON.parse(readFileSync(new URL('exchange-rate.fixture.json', DIR), 'utf8'));
const CURRENCY_TS = readFileSync(new URL('currency.ts', DIR), 'utf8');
const DE = JSON.parse(readFileSync(new URL('messages.de-CH.json', DIR), 'utf8'));
const EN = JSON.parse(readFileSync(new URL('messages.en.json', DIR), 'utf8'));

function keysOf(obj) {
  return Object.keys(obj).sort();
}
function kindOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}
function assertShape(fixture, live, where) {
  assert.deepEqual(keysOf(fixture), keysOf(live), `${where}: key drift`);
  for (const key of Object.keys(live)) {
    assert.equal(kindOf(fixture[key]), kindOf(live[key]), `${where}.${key}: kind drift`);
  }
}

/**
 * A workspace that can actually issue an invoice: VAT configured, a QR-IBAN, and a customer with the
 * structured address IG v2.3 requires. `at` moves the clock, which is what decides whether an
 * invoice falls on the far side of the SIX v2.4 cutover.
 */
function liveWorld({ at = '2026-07-16T00:00:00.000Z' } = {}) {
  const clock = fixedClock(at);
  const ids = sequenceIdGen();
  const store = new SqliteStore({ clock });
  const workspaceId = createWorkspace({ store, clock, ids }, { name: 'Muster Grafik' }).workspaceId;
  const ctx = makeContext(store, { workspaceId, actor: 'user_1', clock, ids });
  store.db
    .prepare('UPDATE workspace SET creditor_iban=?, creditor_name=?, creditor_address=? WHERE id=?')
    .run(
      'CH4431999123000889012',
      'Muster Grafik GmbH',
      JSON.stringify({ street: 'Bahnhofstrasse', buildingNo: '1', zip: '8001', town: 'Zürich', country: 'CH' }),
      workspaceId,
    );
  configureVat(ctx, { method: 'effektiv', timing: 'soll', registered: true, idempotencyKey: 'k' });
  store.db
    .prepare(
      `INSERT INTO contact (id, workspace_id, party_role, name, default_currency, payment_terms_days, created_at,
        email, address_street, address_house_no, address_zip, address_city, address_country)
       VALUES ('ct_1', ?, 'customer','Muster AG','CHF',30,'2026-07-16T00:00:00.000Z',
        'kunde@example.ch','Musterweg','7','3000','Bern','CH')`,
    )
    .run(workspaceId);
  return { ctx, store, workspaceId };
}

function eurInvoice(ctx) {
  return createDocument(ctx, {
    type: 'invoice',
    contactId: 'ct_1',
    currency: 'EUR',
    lines: [{ description: 'Beratung', quantityMilli: 10000, unitPriceMinor: 15000, taxCode: 'UST81' }],
  }).document.id;
}

test('the resolved arm of get_exchange_rate matches the fixture, keys and kinds', () => {
  const { ctx } = liveWorld();
  recordExchangeRate(ctx, {
    baseCurrency: 'EUR',
    rate: '0.9412',
    asOf: '2026-07-15',
    method: 'daily',
    provenance: 'ESTV Tageskurs Verkauf',
    idempotencyKey: 'r1',
  });
  const live = getExchangeRate(ctx, { currency: 'EUR', date: '2026-07-16' });
  assert.equal(live.ok, true);
  assertShape(FIXTURE.resolved, live, 'get_exchange_rate(resolved)');
  // The rate is a STRING on the wire and stays one: a number here would already have lost precision.
  assert.equal(kindOf(live.rate), 'string');
  assert.equal(FIXTURE.resolved.rate, live.rate, 'the canonical rate string drifted');
  assert.equal(FIXTURE.resolved.rateAsOf, live.rateAsOf, 'the rate validity date drifted');
  assert.equal(FIXTURE.resolved.rateSource, live.rateSource);
  assert.equal(FIXTURE.resolved.rateMethod, live.rateMethod);
});

test('the BASE arm is an ok answer with rateSource base, not a rejection and not a rate of 1.00', () => {
  const { ctx } = liveWorld();
  const live = getExchangeRate(ctx, { currency: 'CHF', date: '2026-07-16' });
  assert.equal(live.ok, true, 'asking for the base currency is not an error');
  assertShape(FIXTURE.base, live, 'get_exchange_rate(base)');
  assert.equal(live.rateSource, 'base', 'the picker keys the no-FX state off this exact value');
  assert.equal(live.rateAsOf, null, 'a base-currency posting has no rate validity date');
  assert.equal(live.rateMethod, null, 'a base-currency posting declares no MWSTV Art. 45 basis');
  assert.equal(FIXTURE.base.rate, live.rate);
});

test('both needs_fx_rate arms match the fixture: nothing recorded, and too old to price this date', () => {
  const { ctx } = liveWorld();

  const empty = getExchangeRate(ctx, { currency: 'EUR', date: '2026-07-16' });
  assert.equal(empty.ok, false);
  assert.equal(empty.error, 'needs_fx_rate');
  assertShape(FIXTURE.needsRateEmpty, empty, 'needs_fx_rate(empty)');
  assert.equal(empty.latestAsOf, null, 'nothing on file means no newest rate to name');
  assert.equal(empty.ageDays, undefined, 'with no rate on file there is no age to report');

  recordExchangeRate(ctx, {
    baseCurrency: 'EUR',
    rate: '0.9412',
    asOf: '2026-07-15',
    method: 'daily',
    idempotencyKey: 'r1',
  });
  const stale = getExchangeRate(ctx, { currency: 'EUR', date: '2026-09-30' });
  assert.equal(stale.ok, false);
  assert.equal(stale.error, 'needs_fx_rate');
  assertShape(FIXTURE.needsRateStale, stale, 'needs_fx_rate(stale)');
  // The two arms differ by exactly the keys the panel branches on, so the branch is real.
  assert.equal(kindOf(stale.latestAsOf), 'string');
  assert.equal(kindOf(stale.ageDays), 'number');
  assert.equal(stale.maxAgeDays, FIXTURE.needsRateStale.maxAgeDays, 'the age bound drifted');
});

test('fx_method_not_elected names a basis and carries NO currency, which is why the client remembers it', () => {
  const { ctx } = liveWorld();
  recordExchangeRate(ctx, {
    baseCurrency: 'EUR',
    rate: '0.9412',
    asOf: '2026-07-15',
    method: 'daily',
    idempotencyKey: 'r1',
  });
  setFxMethod(ctx, { method: 'monthly_avg', taxPeriod: '2026' });

  const live = getExchangeRate(ctx, { currency: 'EUR', date: '2026-07-16' });
  assert.equal(live.ok, false);
  assert.equal(live.error, 'fx_method_not_elected');
  assertShape(FIXTURE.methodNotElected, live, 'fx_method_not_elected');
  assert.equal(live.currency, undefined, 'the refusal is about the basis: the pair is the caller to remember');
  assert.equal(live.electedMethod, 'monthly_avg');
  assert.equal(live.method, 'daily');
  assert.equal(kindOf(live.taxPeriod), 'string');
});

test('the list_exchange_rates row matches the fixture the picker builds its options from', () => {
  const { ctx } = liveWorld();
  recordExchangeRate(ctx, {
    baseCurrency: 'EUR',
    rate: '0.9412',
    asOf: '2026-07-15',
    method: 'daily',
    provenance: 'ESTV Tageskurs Verkauf',
    idempotencyKey: 'r1',
  });
  const live = listExchangeRates(ctx, {});
  assert.equal(live.ok, true);
  assertShape(FIXTURE.list, live, 'list_exchange_rates');
  assertShape(FIXTURE.list.rates[0], live.rates[0], 'list_exchange_rates.rates[0]');
  // The pair convention the option list depends on: the LEDGER base currency is the QUOTE side, so
  // the billable foreign currency is the row's `baseCurrency`. Reading it the other way round would
  // offer CHF as a foreign currency and hide EUR.
  assert.equal(live.rates[0].baseCurrency, 'EUR');
  assert.equal(live.rates[0].quoteCurrency, 'CHF');
});

test('get_fx_method matches the fixture in both the open and the LOCKED arm', () => {
  const open = liveWorld();
  setFxMethod(open.ctx, { method: 'monthly_avg', taxPeriod: '2026' });
  const liveOpen = getFxMethod(open.ctx, { date: '2026-07-16' });
  assert.equal(liveOpen.ok, true);
  assertShape(FIXTURE.fxMethod, liveOpen, 'get_fx_method(open)');
  assert.equal(liveOpen.locked, false, 'nothing foreign is posted yet, so the basis is still open');
  assert.equal(liveOpen.earliestChangeablePeriod, null);

  // The locked arm needs a POSTED foreign-currency entry, which is the only thing that settles a
  // Steuerperiode's basis (MWSTV Art. 45 Abs. 5). So issue a real EUR invoice.
  const locked = liveWorld();
  setFxMethod(locked.ctx, { method: 'daily', taxPeriod: '2026' });
  recordExchangeRate(locked.ctx, {
    baseCurrency: 'EUR',
    rate: '0.9412',
    asOf: '2026-07-15',
    method: 'daily',
    idempotencyKey: 'r1',
  });
  const issued = issueInvoice(locked.ctx, { invoiceId: eurInvoice(locked.ctx), idempotencyKey: 'i1' });
  assert.equal(issued.ok, true, `the EUR invoice must issue: ${JSON.stringify(issued)}`);

  const liveLocked = getFxMethod(locked.ctx, { date: '2026-07-16' });
  assertShape(FIXTURE.fxMethodLocked, liveLocked, 'get_fx_method(locked)');
  assert.equal(liveLocked.locked, true, 'a posted foreign-currency entry settles the basis');
  assert.equal(liveLocked.earliestChangeablePeriod, '2027', 'the next period is the earliest switch');
  assert.equal(kindOf(liveLocked.newestForeignCurrencyPosting), 'string');
});

test('the converted CHF total reaches a caller on the DOCUMENT, not on the issue envelope', () => {
  const { ctx, workspaceId } = liveWorld();
  recordExchangeRate(ctx, {
    baseCurrency: 'EUR',
    rate: '0.9412',
    asOf: '2026-07-15',
    method: 'daily',
    idempotencyKey: 'r1',
  });
  const invoiceId = eurInvoice(ctx);
  const issued = issueInvoice(ctx, { invoiceId, idempotencyKey: 'i1' });
  assert.equal(issued.ok, true, `the EUR invoice must issue: ${JSON.stringify(issued)}`);

  // GAP C, closed. This test used to pin the gap: `buildInvoicePosting` composed an FX summary at
  // issue and documented it as "§9 DoD, said out loud to the caller", and A10's `transitionDocument`
  // read exactly one field off the poster's result (`postedEntryId`) and returned a fresh
  // `documentView`, so the summary was discarded before any caller saw it.
  //
  // The fix put the figures on the READ MODEL rather than on that one result, so they survive a
  // reload and reach `get_document` and `list_documents` too. The issue ENVELOPE is still bare on
  // purpose, which is why this loop stays: `transition_document` is generic across four document
  // types and every legal transition, so invoice-specific FX keys on its top level would make the
  // result shape depend on what was transitioned. The document it returns is where they live.
  for (const field of ['currency', 'fxRate', 'fxRateAsOf', 'totalBaseMinor', 'baseCurrency']) {
    assert.equal(issued[field], undefined, `the transition envelope stays generic: ${field} belongs on the document`);
  }
  assert.equal(issued.document.currency, 'EUR', 'and the document it returns carries the FX context');
  assert.equal(kindOf(issued.document.totalBaseMinor), 'number');

  // So M11's "EUR total and CHF base preview side by side" is buildable for an ISSUED invoice
  // without the client ever multiplying a rate out in JavaScript. For a DRAFT it still is not, and
  // correctly so: no rate is stamped until the invoice posts, so the picker goes on showing the RATE
  // and stating what will happen at issue rather than a converted amount it would have to invent.
  const read = getAction('get_document').run(ctx, { workspaceId, documentId: invoiceId });
  assert.equal(read.ok, true);
  assert.equal(read.document.currency, 'EUR', 'the transaction currency IS on the read model');
  assert.equal(read.document.baseCurrency, 'CHF', 'and so is the currency the books hold');
  assert.notEqual(read.document.totalBaseMinor, undefined, 'the document read model reports a base total');
  assert.equal(read.document.fxRate, '0.9412', 'and the rate that priced it');
  // `fxRateAsOf` is the one field of A11's summary that did NOT move here: no `rate_as_of` column
  // exists on either journal table, so reporting it would mean re-resolving it from the mutable rate
  // store and handing back a validity date that may never have priced this invoice.
  assert.equal(read.document.fxRateAsOf, undefined, 'the read model reports only what the ledger holds');

  // Where the figures come FROM, and the reason the read model cannot drift away from them: it does
  // not keep a copy, it derives them from these rows on every read.
  const entry = getAction('get_entry').run(ctx, { workspaceId, entryId: read.document.postedEntryId });
  assert.equal(entry.ok, true);
  const debtor = entry.lines.find((l) => (l.debit ?? 0) > 0);
  assert.equal(debtor.currency, 'EUR');
  assert.equal(debtor.fxRate, '0.9412');
  assert.equal(kindOf(debtor.baseDebit), 'number');
  assert.notEqual(debtor.baseDebit, debtor.debit, 'the base amount is a converted figure, not a copy');
  assert.equal(read.document.fxRate, debtor.fxRate, 'the document quotes the entry, it does not restate it');
  assert.equal(read.document.totalBaseMinor, debtor.baseDebit, 'and the same for the base total');
});

test('the mirrored SIX v2.4 cutover date equals the engine constant, and the refusal is real', () => {
  // The app mirrors the date rather than importing it, so the mirror is checked here or nowhere.
  const mirrored = /QR_IBAN_CHF_ONLY_FROM = '(\d{4}-\d{2}-\d{2})'/.exec(CURRENCY_TS);
  assert.notEqual(mirrored, null, 'the app no longer declares QR_IBAN_CHF_ONLY_FROM');
  assert.equal(mirrored[1], QR_IBAN_CHF_ONLY_FROM, 'the mirrored SIX cutover date drifted from the engine');

  // And the consequence the picker warns about is the one the engine actually produces: a EUR
  // invoice on a QR-IBAN, issued on the far side of the cutover, gets no payment part.
  const { ctx } = liveWorld({ at: '2026-11-20T00:00:00.000Z' });
  recordExchangeRate(ctx, {
    baseCurrency: 'EUR',
    rate: '0.9412',
    asOf: '2026-11-19',
    method: 'daily',
    idempotencyKey: 'r1',
  });
  const invoiceId = eurInvoice(ctx);
  const issued = issueInvoice(ctx, { invoiceId, idempotencyKey: 'i1' });
  assert.equal(issued.ok, true, 'the cutover costs the payment part, never the invoice');
  const qr = buildQrBill(ctx, invoiceId);
  assert.equal(qr.ok, false);
  assert.equal(qr.error, 'qr_iban_chf_only', 'the code the picker and the artifacts panel map');
  assert.equal(qr.effectiveFrom, QR_IBAN_CHF_ONLY_FROM);
});

test('every admissible method and rate source the engine can emit has copy in BOTH locales', () => {
  // These keys are assembled from engine data (`invoice.fx.method.${row.method}`), so the app's
  // literal-key scan cannot see them. `tStrict` throws in dev on a miss, which makes an unlabelled
  // enum value a crash rather than a raw dot-path on screen; this is what keeps it from ever firing.
  for (const [locale, catalog] of [
    ['de-CH', DE],
    ['en', EN],
  ]) {
    for (const method of FX_RATE_METHODS) {
      assert.equal(
        typeof catalog.invoice.fx.method[method],
        'string',
        `${locale} has no label for the MWSTV Art. 45 basis "${method}"`,
      );
    }
    for (const source of EXCHANGE_RATE_SOURCES) {
      assert.equal(
        typeof catalog.invoice.fx.source[source],
        'string',
        `${locale} has no label for the rate source "${source}"`,
      );
    }
    // `base` and `explicit` are not stored `source` values: they are what `resolveFxRate` reports
    // for a base-currency posting and a caller-supplied rate, and the panel renders both.
    for (const resolved of ['base', 'explicit']) {
      assert.equal(typeof catalog.invoice.fx.source[resolved], 'string', `${locale} has no label for "${resolved}"`);
    }
  }
});
