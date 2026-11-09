// §H-FX, the `exchange_rate` store and rate resolution.
//
// This is the rate SOURCE the A11 multi-currency floor was waiting on. What is pinned here is not
// that rates can be stored (that is easy) but that the engine NEVER INVENTS ONE: the four ways a
// resolution can fail all end in a refusal a user can act on, and none of them ends in a rate of 1.

import test from 'node:test';
import assert from 'node:assert/strict';

import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { makeContext } from '../../dist/core/context.js';
import { fixedClock } from '../../dist/core/clock.js';
import { sequenceIdGen } from '../../dist/core/ids.js';
import { createWorkspace } from '../../dist/core/setup/index.js';
import {
  recordExchangeRate,
  listExchangeRates,
  getExchangeRate,
  resolveFxRate,
  baseCurrencyOf,
  EXCHANGE_RATE_SOURCES,
  FX_RATE_METHODS,
  MAX_RATE_AGE_DAYS,
} from '../../dist/core/fx/index.js';

const AT = '2026-07-16T00:00:00.000Z';

function setup() {
  const clock = fixedClock(AT);
  const ids = sequenceIdGen();
  const store = new SqliteStore({ clock });
  const workspaceId = createWorkspace({ store, clock, ids }, { name: 'Nomadik GmbH' }).workspaceId;
  const ctx = makeContext(store, { workspaceId, actor: 'user_1', clock, ids });
  return { ctx, store, workspaceId, clock, ids };
}

const EUR = (over = {}) => ({
  baseCurrency: 'EUR',
  rate: '0.9412',
  asOf: '2026-07-16',
  source: 'manual',
  method: 'daily',
  provenance: 'ESTV Tageskurs Verkauf, MWSTV Art. 45 Abs. 3',
  idempotencyKey: 'fx-1',
  ...over,
});

test('the exchange_rate store EXISTS, with the §D0 columns §H-FX names', () => {
  const { store } = setup();
  const tables = store.db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((r) => r.name);
  assert.ok(tables.includes('exchange_rate'), 'the §H-FX rate store is built');

  const columns = store.db.prepare('PRAGMA table_info(exchange_rate)').all().map((c) => c.name);
  for (const required of ['workspace_id', 'base_currency', 'quote_currency', 'rate', 'as_of', 'source', 'provenance']) {
    assert.ok(columns.includes(required), `exchange_rate.${required} (§D0)`);
  }
});

test('recording a rate stores the canonical decimal AND its exact scaled integer', () => {
  const { ctx, store } = setup();
  const res = recordExchangeRate(ctx, EUR({ rate: '0.94120000' }));
  assert.ok(res.ok, JSON.stringify(res));
  assert.equal(res.created, true);
  assert.equal(res.rate, '0.9412', 'stored in one canonical form');

  const row = store.db.prepare('SELECT * FROM exchange_rate WHERE id = ?').get(res.rateId);
  assert.equal(row.base_currency, 'EUR');
  assert.equal(row.quote_currency, 'CHF');
  assert.equal(row.rate, '0.9412');
  assert.equal(row.rate_scaled, 941_200_000_000, 'the integer the money math actually uses (RATE_SCALE, 1e12)');
  assert.equal(row.source, 'manual');
  assert.equal(row.method, 'daily', 'WHICH admissible MWSTV Art. 45 method priced the books');
  assert.match(row.provenance, /MWSTV Art. 45/, 'provenance is stored so an auditor can retrace it');
  assert.equal(row.workspace_id, ctx.workspaceId, '§H-TENANT');
});

test('recording the SAME rate twice moves the store once (§H-IDEMPOTENT, asserted on ROWS)', () => {
  const { ctx, store } = setup();
  const first = recordExchangeRate(ctx, EUR());
  const second = recordExchangeRate(ctx, EUR());
  assert.ok(first.ok && second.ok);
  assert.deepEqual(first, second, 'the replay returns the original result');
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM exchange_rate').get().n, 1, 'ONE row, not two');
});

test('re-recording the same key with a DIFFERENT rate is refused, not silently overwritten', () => {
  const { ctx, store } = setup();
  assert.ok(recordExchangeRate(ctx, EUR()).ok);
  const clash = recordExchangeRate(ctx, EUR({ rate: '0.9500', idempotencyKey: 'fx-2' }));
  assert.equal(clash.ok, false);
  assert.equal(clash.error, 'rate_conflict');
  assert.equal(clash.storedRate, '0.9412');
  assert.equal(clash.submittedRate, '0.95');
  assert.match(clash.reason, /already have priced a posted entry/);
  assert.equal(store.db.prepare('SELECT rate FROM exchange_rate').get().rate, '0.9412', 'unchanged');

  // The refusal is NOT memoised: recording the right rate under a fresh asOf still works afterwards.
  const later = recordExchangeRate(ctx, EUR({ rate: '0.95', asOf: '2026-07-17', idempotencyKey: 'fx-3' }));
  assert.ok(later.ok, JSON.stringify(later));
});

test('the pair convention is enforced at the write: the ledger base currency is the QUOTE side', () => {
  const { ctx } = setup();
  assert.equal(baseCurrencyOf(ctx), 'CHF');
  const wrongWay = recordExchangeRate(ctx, EUR({ baseCurrency: 'CHF', quoteCurrency: 'EUR' }));
  assert.equal(wrongWay.ok, false);
  assert.equal(wrongWay.error, 'invalid_currency_pair');
  assert.equal(wrongWay.workspaceBaseCurrency, 'CHF');

  const selfPair = recordExchangeRate(ctx, EUR({ baseCurrency: 'CHF' }));
  assert.equal(selfPair.ok, false);
  assert.equal(selfPair.error, 'invalid_currency_pair');
});

test('a malformed rate, currency or source is a structured rejection, never a stored guess', () => {
  const { ctx, store } = setup();
  const cases = [
    // Thirteen decimal places: one more than the ledger holds, so it is refused rather than rounded.
    [EUR({ rate: '0.1234567891234' }), 'invalid_input'],
    // Above the storage ceiling, where rate_scaled would stop being an exact JavaScript number.
    [EUR({ rate: '9001' }), 'invalid_input'],
    [EUR({ rate: '0' }), 'invalid_input'],
    [EUR({ rate: 'abc' }), 'invalid_input'],
    [EUR({ baseCurrency: 'eur' }), 'invalid_input'],
    [EUR({ baseCurrency: 'EURO' }), 'invalid_input'],
    [EUR({ asOf: '2026-02-30' }), 'invalid_input'],
    [EUR({ source: 'vibes' }), 'invalid_source'],
    [EUR({ method: 'whatever_the_bank_said' }), 'invalid_fx_method'],
  ];
  for (const [input, code] of cases) {
    const res = recordExchangeRate(ctx, input);
    assert.equal(res.ok, false, JSON.stringify(input));
    assert.equal(res.error, code, JSON.stringify(res));
  }
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM exchange_rate').get().n, 0, 'nothing was stored');
  assert.deepEqual([...EXCHANGE_RATE_SOURCES], ['manual', 'rate_api'], '§H-ENUM, one list (§D0)');
  // MWSTV Art. 45: Monatsmittelkurs or Tageskurs Verkauf; a bank rate only where the ESTV publishes
  // none (Abs. 3bis); a group rate only for group members applied group-wide (Abs. 4).
  assert.deepEqual([...FX_RATE_METHODS], ['daily', 'monthly_avg', 'bank', 'group'], '§H-ENUM, one list');
});

test('resolution: the base currency needs no rate and converts at exactly 1', () => {
  const { ctx } = setup();
  const res = resolveFxRate(ctx, { currency: 'CHF', date: '2026-07-16' });
  assert.ok(res.ok);
  assert.equal(res.resolved.rate, '1');
  assert.equal(res.resolved.rateAsOf, null);
  assert.equal(res.resolved.rateSource, 'base');

  // A rate other than 1 on a base-currency posting means the caller is confused about something.
  const bogus = resolveFxRate(ctx, { currency: 'CHF', date: '2026-07-16', explicitRate: '0.94' });
  assert.equal(bogus.ok, false);
  assert.equal(bogus.error, 'invalid_fx_rate');
});

test('resolution: an EXPLICIT rate wins over the store, and is still validated', () => {
  const { ctx } = setup();
  recordExchangeRate(ctx, EUR());
  const res = resolveFxRate(ctx, { currency: 'EUR', date: '2026-07-16', explicitRate: '0.9700' });
  assert.ok(res.ok);
  assert.equal(res.resolved.rate, '0.97', 'the caller asserted the rate their books were made with');
  assert.equal(res.resolved.rateSource, 'explicit');

  const bad = resolveFxRate(ctx, { currency: 'EUR', date: '2026-07-16', explicitRate: '-1' });
  assert.equal(bad.ok, false);
  assert.equal(bad.error, 'invalid_input');
  assert.equal(bad.field, 'fxRate');
});

test('resolution: with NO rate on file the posting is refused, and the refusal names the fix', () => {
  const { ctx } = setup();
  const res = resolveFxRate(ctx, { currency: 'EUR', date: '2026-07-16' });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'needs_fx_rate');
  assert.equal(res.currency, 'EUR');
  assert.equal(res.baseCurrency, 'CHF');
  assert.equal(res.latestAsOf, null);
  assert.match(res.reason, /record_exchange_rate|fxRate/);
  // The distinguishing fact against the OLD deferral: this is a fixable configuration state, not a floor.
  assert.equal(res.deferred, undefined, 'nothing is deferred any more');
});

test('resolution reaches BACK over a weekend but never forward, and never past the age bound', () => {
  const { ctx } = setup();
  // Friday's rate.
  assert.ok(recordExchangeRate(ctx, EUR({ asOf: '2026-07-10', idempotencyKey: 'fri' })).ok);

  // Saturday and Sunday legitimately use Friday's published rate, and SAY so.
  const saturday = resolveFxRate(ctx, { currency: 'EUR', date: '2026-07-11' });
  assert.ok(saturday.ok);
  assert.equal(saturday.resolved.rateAsOf, '2026-07-10', 'the rate reports the day it is actually from');

  // A posting BEFORE the only rate on file is refused: a rate cannot price a day it postdates.
  const before = resolveFxRate(ctx, { currency: 'EUR', date: '2026-07-09' });
  assert.equal(before.ok, false);
  assert.equal(before.error, 'needs_fx_rate');
  assert.equal(before.latestAsOf, '2026-07-10');

  // And a rate goes stale rather than pricing the rest of the year.
  const edge = resolveFxRate(ctx, { currency: 'EUR', date: '2026-07-17' });
  assert.ok(edge.ok, `exactly ${MAX_RATE_AGE_DAYS} days old is still admissible`);
  const stale = resolveFxRate(ctx, { currency: 'EUR', date: '2026-07-18' });
  assert.equal(stale.ok, false);
  assert.equal(stale.error, 'needs_fx_rate');
  assert.equal(stale.ageDays, MAX_RATE_AGE_DAYS + 1);
  assert.equal(stale.maxAgeDays, MAX_RATE_AGE_DAYS);
});

test('resolution takes the NEWEST admissible rate, not the first one recorded', () => {
  const { ctx } = setup();
  recordExchangeRate(ctx, EUR({ asOf: '2026-07-14', rate: '0.9300', idempotencyKey: 'a' }));
  recordExchangeRate(ctx, EUR({ asOf: '2026-07-16', rate: '0.9412', idempotencyKey: 'b' }));
  recordExchangeRate(ctx, EUR({ asOf: '2026-07-20', rate: '0.9500', idempotencyKey: 'c' }));

  const res = resolveFxRate(ctx, { currency: 'EUR', date: '2026-07-16' });
  assert.ok(res.ok);
  assert.equal(res.resolved.rate, '0.9412', 'the 20th is in the future for a posting on the 16th');
  assert.equal(res.resolved.rateAsOf, '2026-07-16');
});

test('§H-TENANT: one workspace never resolves another workspace rate', () => {
  const { ctx, store, workspaceId, clock, ids } = setup();
  recordExchangeRate(ctx, EUR());
  const otherId = createWorkspace({ store, clock, ids }, { name: 'Andere AG' }).workspaceId;
  assert.notEqual(otherId, workspaceId);
  const other = makeContext(store, { workspaceId: otherId, actor: 'user_2', clock, ids });

  const res = resolveFxRate(other, { currency: 'EUR', date: '2026-07-16' });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'needs_fx_rate');
  assert.deepEqual(listExchangeRates(other, {}).rates, [], 'and it lists none');
});

test('list and get expose the rates a human and an agent both need before issuing', () => {
  const { ctx } = setup();
  recordExchangeRate(ctx, EUR({ asOf: '2026-07-14', rate: '0.93', idempotencyKey: 'a' }));
  recordExchangeRate(ctx, EUR({ asOf: '2026-07-16', idempotencyKey: 'b' }));

  const listed = listExchangeRates(ctx, { baseCurrency: 'EUR' });
  assert.ok(listed.ok);
  assert.equal(listed.rates.length, 2);
  assert.equal(listed.rates[0].asOf, '2026-07-16', 'newest validity date first');
  assert.equal(listed.rates[0].method, 'daily');
  assert.match(listed.rates[0].provenance, /MWSTV Art. 45/);

  const got = getExchangeRate(ctx, { currency: 'EUR', date: '2026-07-16' });
  assert.ok(got.ok);
  assert.equal(got.rate, '0.9412');
  assert.equal(got.rateAsOf, '2026-07-16');
  assert.equal(got.rateMethod, 'daily');
  assert.equal(got.baseCurrency, 'CHF');

  // Asking about a currency with no rate answers honestly rather than inventing one.
  const missing = getExchangeRate(ctx, { currency: 'USD', date: '2026-07-16' });
  assert.equal(missing.ok, false);
  assert.equal(missing.error, 'needs_fx_rate');
});

test('reads do not write: listing and getting leave the store untouched', () => {
  const { ctx, store } = setup();
  recordExchangeRate(ctx, EUR());
  const snapshot = () => JSON.stringify(store.db.prepare('SELECT * FROM exchange_rate ORDER BY id').all());
  const before = snapshot();
  listExchangeRates(ctx, {});
  getExchangeRate(ctx, { currency: 'EUR' });
  resolveFxRate(ctx, { currency: 'EUR', date: '2026-07-16' });
  assert.equal(snapshot(), before);
});
