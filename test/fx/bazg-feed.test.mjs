// §H-FX, the ESTV/BAZG rate feed: `source='rate_api'` finally has something writing to it.
//
// ## Which series, and why it took a citation chain rather than a guess
//
// The foundation left this open because picking the wrong published series shifts every conversion
// by a day, and a wrong rate is wrong money in the books. The chain, fetched 2026-07-25:
//
//  1. ESTV, "Fremdwährungskurse MWST" (estv.admin.ch/de/mwst-fremdwaehrungskurse, the URL slug is
//     ASCII, the page heading is not): "Für die Umrechnung kann wahlweise der von der
//     Eidgenössischen Steuerverwaltung ESTV publizierte Monatsmittelkurs oder der Tageskurs
//     (Devisenkurs Verkauf) angewendet werden."
//  2. ESTV, "Tageskurse MWST" (estv.admin.ch/de/mwst-tageskurse): "Der aktuelle Tageskurs wird
//     übermittelt vom Bundesamt für Zoll und Grenzsicherheit (BAZG)", under a link labelled
//     "Tageskurs BAZG: Devisenkurse (Verkauf)".
//  3. BAZG, "Devisenkurse (Verkauf)": that page publishes the machine endpoint
//     https://www.backend-rates.bazg.admin.ch/api/xmldaily
//  4. The Monatsmittelkurs endpoint is linked from the ESTV page itself:
//     https://www.backend-rates.bazg.admin.ch/api/xmlavgmonth
//
// So the endpoint is not "the customs series that looks close enough": it IS the series the ESTV
// names as the MWST Tageskurs, reached in two hops from the ESTV's own page.
//
// ## The two traps the foundation named, both real, both handled here
//
//  - The forward-dated window is not a wrong series. `<datum>` is the day the rate was DETERMINED
//    and `<gueltigkeit>` lists the days it is VALID FOR. A Friday determination carries the weekend.
//    The importer stores one row per VALIDITY date, so `exchange_rate.as_of` keeps meaning exactly
//    what §H-FX says it means: the date the rate is valid FOR.
//  - Some currencies are quoted per 100, per 1000 or per 10000 units, in `<waehrung>`. Ignoring that
//    would be wrong by up to four orders of magnitude.
//
// And one the foundation did not know about, found by running the real payload through: four of the
// 72 published daily rates (IDR, KHR, COP, LBP) need NINE decimal places once divided by their unit
// of 10000, which the old 1e8 rate scale could not hold. The scale was widened to 1e12 rather than
// the rates rounded, so all 72 now land exactly. The report-never-round path still exists and is
// still tested, on a quote deep enough to exceed even the wider scale.
//
// Everything here runs OFFLINE against the real payloads, captured verbatim. The live endpoint is
// exercised by `rate-feed-live.test.mjs`, which skips itself when the network is not there.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { makeContext } from '../../dist/core/context.js';
import { fixedClock } from '../../dist/core/clock.js';
import { sequenceIdGen } from '../../dist/core/ids.js';
import { createWorkspace } from '../../dist/core/setup/index.js';
import { postEntry } from '../../dist/core/ledger/index.js';
import {
  parseBazgFeed,
  importExchangeRates,
  describeRateFeed,
  setFxMethod,
  BAZG_DAILY_URL,
  BAZG_MONTHLY_URL,
  RATE_DECIMALS,
} from '../../dist/core/fx/index.js';

const DAILY = readFileSync(new URL('./fixtures/bazg-xmldaily-20260724.xml', import.meta.url), 'utf8');
const MONTHLY = readFileSync(new URL('./fixtures/bazg-xmlavgmonth-2026-08.xml', import.meta.url), 'utf8');

const AT = '2026-07-25T09:00:00.000Z';

function setup() {
  const clock = fixedClock(AT);
  const ids = sequenceIdGen();
  const store = new SqliteStore({ clock });
  const workspaceId = createWorkspace({ store, clock, ids }, { name: 'Nomadik GmbH' }).workspaceId;
  const ctx = makeContext(store, { workspaceId, actor: 'user_1', clock, ids });
  const accId = (number) =>
    store.db.prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?').get(workspaceId, number).id;
  return { ctx, store, workspaceId, accId };
}

const rateOf = (parsed, currency) => parsed.rates.find((r) => r.currency === currency);

// ---------------------------------------------------------------------------
// The parser: what the published payload actually says
// ---------------------------------------------------------------------------

test('the daily payload identifies itself, and datum is the DETERMINATION day, not the validity day', () => {
  const parsed = parseBazgFeed(DAILY);
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
  assert.equal(parsed.series, 'daily');
  assert.equal(parsed.determinedOn, '2026-07-24', '<datum>24.07.2026</datum>, a Friday');
  assert.equal(parsed.determinedTime, '07:00:04');
  // <gueltigkeit>25.07.2026,26.07.2026,27.07.2026</gueltigkeit>: Saturday, Sunday, Monday.
  assert.deepEqual(parsed.validFor, ['2026-07-25', '2026-07-26', '2026-07-27']);
  assert.equal(parsed.endpoint, BAZG_DAILY_URL);
});

test('the monthly payload carries its month, and the rate is valid for that whole month', () => {
  const parsed = parseBazgFeed(MONTHLY);
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
  assert.equal(parsed.series, 'monthly_avg');
  assert.equal(parsed.month, '2026-08');
  assert.deepEqual(parsed.validFor, ['2026-08-01'], 'one row, on the first of its month');
  assert.equal(parsed.endpoint, BAZG_MONTHLY_URL);
});

test('a rate quoted per ONE unit passes through unscaled', () => {
  const eur = rateOf(parseBazgFeed(DAILY), 'EUR');
  assert.equal(eur.unit, 1);
  assert.equal(eur.quotedRate, '0.93883', 'as published: 1 EUR = 0.93883 CHF');
  assert.equal(eur.rate, '0.93883');
  assert.equal(rateOf(parseBazgFeed(DAILY), 'USD').rate, '0.82497');
});

test('a rate quoted per 100 units is divided by 100, exactly, in decimal string arithmetic', () => {
  const egp = rateOf(parseBazgFeed(DAILY), 'EGP');
  assert.equal(egp.unit, 100);
  assert.equal(egp.quotedRate, '1.60858', 'as published: 100 EGP = 1.60858 CHF');
  assert.equal(egp.rate, '0.0160858', 'so 1 EGP = 0.0160858 CHF, not 1.60858');
});

test('per 1000 and per 10000 quotes scale too, and a trailing zero is not lost precision', () => {
  const parsed = parseBazgFeed(DAILY);
  const clp = rateOf(parsed, 'CLP');
  assert.equal(clp.unit, 1000);
  assert.equal(clp.rate, '0.00087211', '1000 CLP = 0.87211 CHF, exactly eight places');
  const vnd = rateOf(parsed, 'VND');
  assert.equal(vnd.unit, 10000);
  assert.equal(vnd.quotedRate, '0.31330');
  // Nine places on paper, eight in fact: the published trailing zero is not significant, and
  // treating it as if it were would refuse a rate TILL can hold exactly.
  assert.equal(vnd.rate, '0.00003133');
});

test('every rate the published series carries is holdable EXACTLY', () => {
  const parsed = parseBazgFeed(DAILY);
  assert.deepEqual(
    parsed.rates.filter((r) => r.rate === null).map((r) => r.currency),
    [],
    'the whole 24.07.2026 daily series fits at RATE_DECIMALS places',
  );
  // The four the §H-FX foundation had to report as unrepresentable at the old 1e8 scale. They are
  // the deepest the series goes: five quoted places divided by a unit of 10000 is nine places.
  for (const [currency, unit, quoted, exact] of [
    ['IDR', 10000, '0.45902', '0.000045902'],
    ['KHR', 10000, '2.05323', '0.000205323'],
    ['COP', 10000, '2.56742', '0.000256742'],
    ['LBP', 10000, '0.09201', '0.000009201'],
  ]) {
    const r = rateOf(parsed, currency);
    assert.equal(r.unit, unit);
    assert.equal(r.quotedRate, quoted);
    assert.equal(r.rate, exact, `1 ${currency} = ${exact} CHF, exactly as published`);
  }
});

test('a rate TILL still cannot hold EXACTLY is reported, never rounded into the books', () => {
  // The widening did not delete this safety net, it moved it. A quote deep enough to exceed
  // RATE_DECIMALS once divided by its unit is still REPORTED with the published figures rather than
  // rounded, because a truncated rate is a wrong rate at any scale, and the operator recording their
  // own rounding is an assertion they made rather than one TILL made silently for them.
  const parsed = parseBazgFeed(
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<wechselkurse>',
      '  <datum>24.07.2026</datum>',
      '  <gueltigkeit>25.07.2026</gueltigkeit>',
      '  <devise code="zzz"><waehrung>10000 ZZZ</waehrung><kurs>0.1234567891</kurs></devise>',
      '</wechselkurse>',
    ].join('\n'),
  );
  const zzz = rateOf(parsed, 'ZZZ');
  assert.equal(zzz.rate, null);
  assert.equal(zzz.reason, 'unrepresentable');
  assert.equal(zzz.exact, '0.00001234567891', 'fourteen places, and the exact value is reported');
  assert.equal(zzz.rateDecimals, RATE_DECIMALS, 'the scale TILL stores rates at');
  assert.equal(zzz.unit, 10000);
  assert.equal(zzz.quotedRate, '0.1234567891');
});

test('the parser reads every published currency, and never invents one', () => {
  const parsed = parseBazgFeed(DAILY);
  assert.equal(parsed.rates.length, 72, 'the captured payload publishes 72 currencies');
  assert.equal(new Set(parsed.rates.map((r) => r.currency)).size, 72, 'no duplicates');
  for (const r of parsed.rates) assert.match(r.currency, /^[A-Z]{3}$/, `${r.currency} is an ISO 4217 code`);
  assert.equal(parseBazgFeed(MONTHLY).rates.length, 72);
  // CHF is not in either payload, which is right: these are prices OF a currency IN Swiss francs.
  assert.ok(!parsed.rates.some((r) => r.currency === 'CHF'));
});

test('garbage in is a refusal with a code, never a throw and never a half-parsed feed', () => {
  for (const payload of ['', '<html>403</html>', '<wechselkurse></wechselkurse>', null, 42]) {
    const parsed = parseBazgFeed(payload);
    assert.equal(parsed.ok, false, JSON.stringify(payload));
    assert.equal(typeof parsed.error, 'string');
  }
});

// ---------------------------------------------------------------------------
// The import: source='rate_api', with the provenance an ESTV control needs
// ---------------------------------------------------------------------------

test('importing the daily feed writes source=rate_api, one row per VALIDITY date', () => {
  const { ctx, store } = setup();
  const res = importExchangeRates(ctx, { payload: DAILY, currencies: ['EUR', 'USD'], idempotencyKey: 'imp-1' });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.series, 'daily');
  assert.equal(res.counts.imported, 6, 'two currencies over three validity dates');

  const rows = store.db.prepare('SELECT * FROM exchange_rate ORDER BY base_currency, as_of').all();
  assert.equal(rows.length, 6);
  for (const row of rows) {
    assert.equal(row.source, 'rate_api', 'the schema enum finally has a writer');
    assert.equal(row.method, 'daily');
    assert.equal(row.quote_currency, 'CHF');
  }
  assert.deepEqual(
    rows.filter((r) => r.base_currency === 'EUR').map((r) => [r.as_of, r.rate]),
    [
      ['2026-07-25', '0.93883'],
      ['2026-07-26', '0.93883'],
      ['2026-07-27', '0.93883'],
    ],
    'Friday priced the weekend and the Monday, which is what <gueltigkeit> says',
  );
});

test('the provenance names the series, the endpoint, the published quote and the determination', () => {
  const { ctx, store } = setup();
  importExchangeRates(ctx, { payload: DAILY, currencies: ['EGP'], idempotencyKey: 'imp-prov' });
  const row = store.db.prepare("SELECT * FROM exchange_rate WHERE base_currency = 'EGP' LIMIT 1").get();
  // An ESTV control has to be able to go from a posted entry back to a published figure. That means
  // the SCALING has to be retraceable too, so the published unit and quote are in the text verbatim.
  assert.match(row.provenance, /Devisenkurse \(Verkauf\)/);
  assert.match(row.provenance, /100 EGP = 1\.60858 CHF/);
  assert.match(row.provenance, /2026-07-24/, 'the determination date');
  assert.match(row.provenance, /backend-rates\.bazg\.admin\.ch\/api\/xmldaily/);
  assert.match(row.provenance, /Art\. 45/);
});

test('importing the monthly feed stores ONE row per currency, on the first of its month', () => {
  const { ctx, store } = setup();
  const res = importExchangeRates(ctx, { payload: MONTHLY, currencies: ['EUR'], idempotencyKey: 'imp-m' });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.series, 'monthly_avg');
  const rows = store.db.prepare("SELECT * FROM exchange_rate WHERE base_currency = 'EUR'").all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].as_of, '2026-08-01');
  assert.equal(rows[0].method, 'monthly_avg');
  assert.equal(rows[0].rate, '0.9328');
});

test('a Monatsmittelkurs prices its WHOLE month, and never reaches into the next one', () => {
  const { ctx, accId } = setup();
  setFxMethod(ctx, { method: 'monthly_avg', taxPeriod: '2026' });
  importExchangeRates(ctx, { payload: MONTHLY, currencies: ['EUR'], idempotencyKey: 'imp-m2' });

  // The seven-day daily bound would have refused everything from the 9th of the month onwards, which
  // would make the entire Abs. 3 monthly basis unusable.
  const late = postEntry(ctx, {
    date: '2026-08-28',
    description: 'EUR Einkauf Ende August',
    source: 'manual',
    currency: 'EUR',
    idempotencyKey: 'p-aug',
    lines: [
      { account: accId('6500'), debit: 10000 },
      { account: accId('1000'), credit: 10000 },
    ],
  });
  assert.equal(late.ok, true, JSON.stringify(late));
  assert.equal(late.fxRate, '0.9328');

  const september = postEntry(ctx, {
    date: '2026-09-02',
    description: 'EUR Einkauf September',
    source: 'manual',
    currency: 'EUR',
    idempotencyKey: 'p-sep',
    lines: [
      { account: accId('6500'), debit: 10000 },
      { account: accId('1000'), credit: 10000 },
    ],
  });
  assert.equal(september.ok, false, 'August average must not price September');
  assert.equal(september.error, 'needs_fx_rate');
});

test('the import is idempotent on ROWS: a replay writes nothing and reports the same thing', () => {
  const { ctx, store } = setup();
  const input = { payload: DAILY, currencies: ['EUR', 'USD'], idempotencyKey: 'imp-replay' };
  const first = importExchangeRates(ctx, input);
  const snapshot = JSON.stringify(store.db.prepare('SELECT * FROM exchange_rate ORDER BY id').all());
  const second = importExchangeRates(ctx, input);
  assert.deepEqual(second, first);
  assert.equal(JSON.stringify(store.db.prepare('SELECT * FROM exchange_rate ORDER BY id').all()), snapshot);
});

test('a per-10000 currency lands as ROWS at its exact per-unit rate, alongside the rest', () => {
  const { ctx, store } = setup();
  const res = importExchangeRates(ctx, { payload: DAILY, currencies: ['EUR', 'IDR'], idempotencyKey: 'imp-idr' });
  assert.equal(res.ok, true);
  assert.deepEqual(res.skipped, [], 'IDR is no longer refused for want of a ninth decimal place');
  const rows = store.db
    .prepare("SELECT * FROM exchange_rate WHERE base_currency='IDR' ORDER BY as_of")
    .all();
  assert.equal(rows.length, 3, 'one row per validity date in the payload');
  for (const row of rows) {
    assert.equal(row.rate, '0.000045902', 'published 10000 IDR = 0.45902 CHF, divided exactly');
    assert.equal(row.rate_scaled, 45_902_000, 'and the same value as the integer the money math uses');
  }
  assert.equal(store.db.prepare("SELECT COUNT(*) AS c FROM exchange_rate WHERE base_currency='EUR'").get().c, 3);
});

test('the whole published payload imports in one call, with nothing left behind', () => {
  const { ctx, store } = setup();
  const res = importExchangeRates(ctx, { payload: DAILY, idempotencyKey: 'imp-all' });
  assert.equal(res.ok, true, JSON.stringify(res.error));
  assert.equal(res.counts.imported, 72 * 3, 'all 72 published currencies over three validity dates');
  assert.equal(res.counts.skipped, 0, 'IDR, KHR, COP and LBP included');
  assert.ok(!res.imported.some((r) => r.currency === 'CHF'), 'a currency needs no rate against itself');
  assert.equal(store.db.prepare("SELECT COUNT(*) AS c FROM exchange_rate WHERE source='rate_api'").get().c, 216);
});

test('a payload that is the WRONG SERIES is refused rather than mis-dated', () => {
  const { ctx } = setup();
  const res = importExchangeRates(ctx, { payload: MONTHLY, series: 'daily', idempotencyKey: 'imp-x' });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'rate_feed_series_mismatch');
  assert.equal(res.expected, 'daily');
  assert.equal(res.found, 'monthly_avg');
  assert.equal(ctx.store.db.prepare('SELECT COUNT(*) AS c FROM exchange_rate').get().c, 0);
});

test('an unparseable payload is refused whole: nothing lands from a 403 page', () => {
  const { ctx } = setup();
  const res = importExchangeRates(ctx, { payload: '<HTML><H1>403 ERROR</H1></HTML>', idempotencyKey: 'imp-403' });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'invalid_rate_feed');
  assert.equal(ctx.store.db.prepare('SELECT COUNT(*) AS c FROM exchange_rate').get().c, 0);
});

test('the import honours the Art. 45 Abs. 5 election: the wrong series is refused whole', () => {
  const { ctx } = setup();
  setFxMethod(ctx, { method: 'monthly_avg', taxPeriod: '2026' });
  const res = importExchangeRates(ctx, { payload: DAILY, idempotencyKey: 'imp-locked' });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'fx_method_not_elected');
  assert.equal(res.electedMethod, 'monthly_avg');
  assert.equal(ctx.store.db.prepare('SELECT COUNT(*) AS c FROM exchange_rate').get().c, 0);
});

test('a conflicting rate under the same key is reported, and does not abort the rest of the import', () => {
  const { ctx, store } = setup();
  // Somebody already recorded a DIFFERENT EUR rate from the feed for the same date and source, and it
  // may already have priced a posted entry (§H-AUDIT), so it cannot be overwritten.
  store.db
    .prepare(
      `INSERT INTO exchange_rate (id, workspace_id, base_currency, quote_currency, rate, rate_scaled, as_of, source, method, provenance, created_at, created_by)
       VALUES ('fxrate_x', ?, 'EUR', 'CHF', '0.9', 90000000, '2026-07-25', 'rate_api', 'daily', 'hand-seeded', ?, 'user_1')`,
    )
    .run(ctx.workspaceId, AT);

  const res = importExchangeRates(ctx, { payload: DAILY, currencies: ['EUR', 'USD'], idempotencyKey: 'imp-conf' });
  assert.equal(res.ok, true, 'one clash must not cost the operator the other 71 currencies');
  const clash = res.skipped.find((s) => s.currency === 'EUR' && s.asOf === '2026-07-25');
  assert.equal(clash.reason, 'rate_conflict');
  assert.equal(store.db.prepare("SELECT rate FROM exchange_rate WHERE id = 'fxrate_x'").get().rate, '0.9');
  assert.equal(store.db.prepare("SELECT COUNT(*) AS c FROM exchange_rate WHERE base_currency='USD'").get().c, 3);
});

test('an imported rate prices a posting end to end, and stamps the whole §H-FX trace', () => {
  const { ctx, accId, store } = setup();
  importExchangeRates(ctx, { payload: DAILY, currencies: ['EUR'], idempotencyKey: 'imp-post' });
  const posted = postEntry(ctx, {
    date: '2026-07-27',
    description: 'EUR Wareneinkauf',
    source: 'manual',
    currency: 'EUR',
    idempotencyKey: 'p-feed',
    lines: [
      { account: accId('6500'), debit: 100000 },
      { account: accId('1000'), credit: 100000 },
    ],
  });
  assert.equal(posted.ok, true, JSON.stringify(posted));
  assert.equal(posted.fxRate, '0.93883');
  assert.equal(posted.fxRateAsOf, '2026-07-27', 'the Monday the Friday rate was published FOR');
  const line = store.db.prepare('SELECT * FROM journal_line WHERE entry_id = ? AND debit_minor > 0').get(posted.entryId);
  assert.equal(line.debit_minor, 100000, 'EUR 1000.00');
  assert.equal(line.base_debit_minor, 93883, 'CHF 938.83');
  assert.equal(line.fx_rate, '0.93883');
});

// ---------------------------------------------------------------------------
// describe_rate_feed: how a caller learns WHAT to fetch, without guessing
// ---------------------------------------------------------------------------

test('describeRateFeed names both series, their endpoints, and the citation chain', () => {
  const { ctx } = setup();
  const res = describeRateFeed(ctx);
  assert.equal(res.ok, true);
  const daily = res.series.find((s) => s.method === 'daily');
  assert.equal(daily.endpoint, BAZG_DAILY_URL);
  assert.match(daily.name, /Devisenkurse \(Verkauf\)/);
  assert.ok(daily.citations.some((c) => c.includes('estv.admin.ch')), 'the ESTV page that names the series');
  const monthly = res.series.find((s) => s.method === 'monthly_avg');
  assert.equal(monthly.endpoint, BAZG_MONTHLY_URL);
  // The engine performs no network I/O at all: it says what to fetch and parses what comes back.
  assert.equal(res.fetchedByEngine, false);
});

test('describeRateFeed points at the series the WORKSPACE has elected', () => {
  const { ctx } = setup();
  assert.equal(describeRateFeed(ctx).recommended, null, 'nothing elected, nothing recommended');
  setFxMethod(ctx, { method: 'monthly_avg', taxPeriod: '2026' });
  const res = describeRateFeed(ctx);
  assert.equal(res.recommended.method, 'monthly_avg');
  assert.equal(res.recommended.endpoint, BAZG_MONTHLY_URL);
});
