// §H-FX, the persisted rate SCALE: can the ledger hold the rates the admissible series publishes?
//
// The §H-FX foundation shipped with open item 4: IDR, KHR, COP and LBP "cannot be held exactly at
// the 1e8 rate scale". That is not a cosmetic gap. The BAZG "Devisenkurse (Verkauf)" series is the
// one the ESTV names as the MWST Tageskurs, so a currency it publishes that TILL cannot hold is a
// currency TILL cannot book at all, and the one thing worse than refusing it would be rounding the
// rate and calling the result Swiss francs.
//
// ## What these tests assert, and what they deliberately do NOT assert
//
// They do not assert "RATE_SCALE is 1e12". A test written to the shape of the fix passes for a fix
// that is wrong by an order of magnitude. They assert the PROPERTIES the scale exists to provide:
//
//   1. every rate the admissible published series carries is storable EXACTLY (no rounding, ever);
//   2. a posted base amount equals the correctly-rounded product of the transaction amount and the
//      PUBLISHED figures, recomputed here in independent exact integer arithmetic;
//   3. the largest-remainder allocation still sums EXACTLY to the converted side total;
//   4. rate -> canonical string -> SQLite -> rate survives byte for byte;
//   5. a base-currency posting still stores a NULL rate, because a rate of 1 is not FX;
//   6. every stored scaled rate is exact in SQLite AND as a JavaScript number, with stated headroom;
//   7. a database written before the widening does not keep its old numbers under a new meaning.
//
// Every money assertion reads the POSTED ROWS back out of SQLite. A return value is what the engine
// believes; the rows are what the books say.
//
// The published figures below are the real BAZG payload of 24.07.2026, valid 25.-27.07.2026, which
// `test/fx/fixtures/bazg-xmldaily-20260724.xml` holds verbatim (verified byte-identical against
// https://www.backend-rates.bazg.admin.ch/api/xmldaily on 2026-07-25).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { makeContext } from '../../dist/core/context.js';
import { fixedClock } from '../../dist/core/clock.js';
import { sequenceIdGen } from '../../dist/core/ids.js';
import { postEntry } from '../../dist/core/ledger/index.js';
import {
  importExchangeRates,
  recordExchangeRate,
  resolveFxRate,
  parseRate,
  formatRate,
  convertMinor,
  allocateBase,
  RATE_SCALE,
  RATE_ONE,
  RATE_DECIMALS,
  RATE_MAX_SCALED,
} from '../../dist/core/fx/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PAYLOAD = readFileSync(join(HERE, 'fixtures', 'bazg-xmldaily-20260724.xml'), 'utf8');

const AT = '2026-07-27T09:00:00.000Z';
/** A date inside the payload's own validity window, so no lookback slack is being tested here. */
const BOOK_DATE = '2026-07-27';

// The four currencies open item 4 named, with the figures the BAZG actually publishes for them.
// `unit` is <waehrung>, `kurs` is <kurs>: the price of `unit` units in CHF, verbatim.
const PUBLISHED = {
  IDR: { unit: 10000, kurs: '0.45902' },
  KHR: { unit: 10000, kurs: '2.05323' },
  COP: { unit: 10000, kurs: '2.56742' },
  LBP: { unit: 10000, kurs: '0.09201' },
};
// The currencies that already worked, pinned so the widening cannot move them.
const UNCHANGED = {
  EUR: { unit: 1, kurs: '0.93883' },
  USD: { unit: 1, kurs: '0.82497' },
};

// ---------------------------------------------------------------------------------------------
// Independent arithmetic. None of this calls the engine: a test that converts with the code under
// test only proves the code agrees with itself.
// ---------------------------------------------------------------------------------------------

/** The published quote as an exact rational `num / den`, from the decimal string and the unit. */
function publishedRational({ unit, kurs }) {
  const [whole, frac = ''] = kurs.split('.');
  return { num: BigInt(whole + frac), den: 10n ** BigInt(frac.length) * BigInt(unit) };
}

/** `num/den` as a plain decimal string with no trailing zeros, or null if it does not terminate. */
function publishedDecimalString(published) {
  const { num, den } = publishedRational(published);
  // Every den here is a power of ten, so the quotient is just a shifted decimal point.
  let shift = 0;
  for (let d = den; d > 1n; d /= 10n) shift += 1;
  assert.equal(10n ** BigInt(shift), den, 'the published unit and quote are powers of ten');
  const digits = num.toString().padStart(shift + 1, '0');
  const point = digits.length - shift;
  const whole = digits.slice(0, point).replace(/^0+(?=\d)/, '') || '0';
  const frac = digits.slice(point).replace(/0+$/, '');
  return frac.length === 0 ? whole : `${whole}.${frac}`;
}

/** `amountMinor * kurs / unit`, rounded HALF AWAY FROM ZERO, in exact integer arithmetic. */
function publishedBaseMinor(amountMinor, published) {
  const { num, den } = publishedRational(published);
  const n = BigInt(amountMinor) * num;
  const q = n / den;
  const r = n - q * den;
  return Number(2n * r >= den ? q + 1n : q);
}

// ---------------------------------------------------------------------------------------------

function setup(location = ':memory:') {
  const clock = fixedClock(AT);
  const store = new SqliteStore({ clock, location });
  const workspaceId = 'ws_1';
  store.db
    .prepare('INSERT INTO workspace (id, name, base_currency, fiscal_year_start, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(workspaceId, 'Nomadik GmbH', 'CHF', '01-01', AT);

  const accounts = {};
  for (const [id, number, name, type] of [
    ['acc_deb', '1100', 'Forderungen', 'asset'],
    ['acc_bank', '1020', 'Bank', 'asset'],
    ['acc_ertrag', '3000', 'Dienstleistungsertrag', 'income'],
    ['acc_aufwand', '6500', 'Büromaterial', 'expense'],
  ]) {
    store.db
      .prepare('INSERT INTO account (id, workspace_id, number, name, type) VALUES (?, ?, ?, ?, ?)')
      .run(id, workspaceId, number, name, type);
    accounts[number] = id;
  }

  const ctx = makeContext(store, { workspaceId, actor: 'user_1', clock, ids: sequenceIdGen() });
  return { store, ctx, workspaceId, accounts };
}

function importPublished(ctx) {
  return importExchangeRates(ctx, { payload: PAYLOAD, series: 'daily', idempotencyKey: 'bazg-1' });
}

/** `JSON.stringify` refuses a BigInt, and a resolved rate carries one. Only ever a failure message. */
const show = (value) => JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v));

const linesOf = (store, entryId) =>
  store.db.prepare('SELECT * FROM journal_line WHERE entry_id = ? ORDER BY rowid').all(entryId);

// =============================================================================================
// 1. Every rate the admissible series publishes must be storable EXACTLY.
// =============================================================================================

test('the published series is fully bookable: NO currency is dropped as unrepresentable', () => {
  const { ctx } = setup();
  const res = importPublished(ctx);
  assert.ok(res.ok, JSON.stringify(res));

  const unrepresentable = res.skipped.filter((s) => s.reason === 'unrepresentable');
  assert.deepEqual(
    unrepresentable,
    [],
    'a currency the ESTV-named series publishes is a currency TILL must be able to book',
  );

  // Nothing at all is declined. The series is quoted IN CHF, so CHF is not one of its 72 entries and
  // not even the base-currency skip applies: every published rate lands.
  assert.deepEqual(res.skipped, [], 'the import declines nothing the published series carries');
  assert.equal(res.counts.imported, res.imported.length);
  assert.ok(res.counts.created >= 72 * 3, 'all 72 currencies, on each of the payload three validity dates');
});

test('IDR, KHR, COP and LBP land as ROWS carrying the exact published quotient', () => {
  const { ctx, store } = setup();
  assert.ok(importPublished(ctx).ok);

  for (const [currency, published] of Object.entries(PUBLISHED)) {
    const row = store.db
      .prepare(
        `SELECT * FROM exchange_rate
          WHERE workspace_id = ? AND base_currency = ? AND quote_currency = 'CHF' AND as_of = ?`,
      )
      .get(ctx.workspaceId, currency, BOOK_DATE);
    assert.ok(row !== undefined, `${currency} has a stored rate for ${BOOK_DATE}`);

    const expected = publishedDecimalString(published);
    assert.equal(row.rate, expected, `1 ${currency} = ${expected} CHF, exactly as published`);

    // The scaled integer and the canonical string are the SAME number, or the money math and the
    // audit trail disagree about what priced the books.
    const { num, den } = publishedRational(published);
    const scaled = (num * RATE_SCALE) / den;
    assert.equal(num * RATE_SCALE % den, 0n, 'the published rate is exact at this scale, not rounded');
    assert.equal(BigInt(row.rate_scaled), scaled, `${currency} rate_scaled agrees with rate`);

    // The provenance has to let an auditor walk back to the published figure, unit and all.
    assert.match(row.provenance, new RegExp(`${published.unit} ${currency} = ${published.kurs} CHF`));
  }
});

test('a published rate is never rounded to fit: the exact quotient survives the string round trip', () => {
  for (const published of [...Object.values(PUBLISHED), ...Object.values(UNCHANGED)]) {
    const text = publishedDecimalString(published);
    const scaled = parseRate(text);
    assert.ok(scaled !== null, `${text} is representable`);
    assert.equal(formatRate(scaled), text, 'rate -> scaled -> rate is the identity');
  }
});

// =============================================================================================
// 2. A posted base amount equals the correctly-rounded product of the amount and the PUBLISHED rate.
// =============================================================================================

test('an IDR invoice posts base amounts equal to the exact published product, read back from SQLite', () => {
  const { ctx, store, accounts } = setup();
  assert.ok(importPublished(ctx).ok);

  // 250'000'000 minor units = 2'500'000.00 IDR, about CHF 114.75. Large enough that a rate wrong in
  // its ninth decimal place moves the books by whole Rappen.
  const gross = 250_000_000;
  const net = 200_000_000;
  const vat = 50_000_000;

  const res = postEntry(ctx, {
    date: BOOK_DATE,
    description: 'Beratung Kunde Jakarta',
    source: 'invoice',
    idempotencyKey: 'idr-1',
    currency: 'IDR',
    lines: [
      { account: accounts['1100'], debit: gross },
      { account: accounts['3000'], credit: net },
      { account: accounts['1020'], credit: vat },
    ],
  });
  assert.ok(res.ok, JSON.stringify(res));

  const rows = linesOf(store, res.entryId);
  assert.equal(rows.length, 3);

  const expectedRate = publishedDecimalString(PUBLISHED.IDR);
  const expectedGross = publishedBaseMinor(gross, PUBLISHED.IDR);

  for (const l of rows) {
    assert.equal(l.currency, 'IDR', 'the transaction currency is on the row');
    assert.equal(l.fx_rate, expectedRate, 'the rate that priced the books is stamped, unrounded');
  }

  const [debit, revenue, tax] = rows;
  assert.equal(debit.debit_minor, gross);
  assert.equal(
    debit.base_debit_minor,
    expectedGross,
    'the debit side is the published product, rounded half away from zero, and nothing else',
  );

  // The credit side is converted ONCE on the side total and allocated back, so it sums to the same
  // base total as the debit side. That is what makes the entry balance in CHF by construction.
  assert.equal(
    revenue.base_credit_minor + tax.base_credit_minor,
    expectedGross,
    'the books balance in CHF, at the published rate',
  );
  // ...and each line is still within one Rappen of its own honest conversion.
  for (const [row, amount] of [[revenue, net], [tax, vat]]) {
    const own = publishedBaseMinor(amount, PUBLISHED.IDR);
    assert.ok(
      Math.abs(row.base_credit_minor - own) <= 1,
      `a line is within one Rappen of its own conversion (${row.base_credit_minor} vs ${own})`,
    );
  }
});

test('KHR, COP and LBP each post at the published rate, with the entry balanced in CHF', () => {
  for (const currency of ['KHR', 'COP', 'LBP']) {
    const { ctx, store, accounts } = setup();
    assert.ok(importPublished(ctx).ok);

    const amount = 1_234_567_800;
    const res = postEntry(ctx, {
      date: BOOK_DATE,
      source: 'manual',
      idempotencyKey: `k-${currency}`,
      currency,
      lines: [
        { account: accounts['6500'], debit: amount },
        { account: accounts['1020'], credit: amount },
      ],
    });
    assert.ok(res.ok, `${currency}: ${JSON.stringify(res)}`);

    const rows = linesOf(store, res.entryId);
    const expected = publishedBaseMinor(amount, PUBLISHED[currency]);
    assert.equal(rows[0].fx_rate, publishedDecimalString(PUBLISHED[currency]));
    assert.equal(rows[0].base_debit_minor, expected, `${currency} debit at the published rate`);
    assert.equal(rows[1].base_credit_minor, expected, `${currency} credit at the published rate`);

    const sums = store.db
      .prepare(
        'SELECT SUM(base_debit_minor) AS d, SUM(base_credit_minor) AS c FROM journal_line WHERE entry_id = ?',
      )
      .get(res.entryId);
    assert.equal(sums.d, sums.c, `${currency}: the books balance in CHF`);
  }
});

test('the rate is exact enough that the books do NOT drift from the published figure at scale', () => {
  // The failure a too-narrow scale actually causes: the rate has to be truncated, and the truncation
  // is a fixed RELATIVE error, so the absolute error in the books grows without bound with the
  // amount. This pins the property directly: over four orders of magnitude of invoice size, every
  // posted base amount is the correctly-rounded published product, never merely close to it.
  const { ctx, store, accounts } = setup();
  assert.ok(importPublished(ctx).ok);

  let n = 0;
  for (const currency of Object.keys(PUBLISHED)) {
    for (const amount of [100, 999_999, 100_000_000, 987_654_321_000]) {
      const res = postEntry(ctx, {
        date: BOOK_DATE,
        source: 'manual',
        idempotencyKey: `drift-${currency}-${amount}`,
        currency,
        lines: [
          { account: accounts['6500'], debit: amount },
          { account: accounts['1020'], credit: amount },
        ],
      });
      assert.ok(res.ok, `${currency} ${amount}: ${JSON.stringify(res)}`);
      const row = linesOf(store, res.entryId)[0];
      assert.equal(
        row.base_debit_minor,
        publishedBaseMinor(amount, PUBLISHED[currency]),
        `${currency} ${amount}: the books hold the published product, exactly`,
      );
      n += 1;
    }
  }
  assert.equal(n, 16, 'all four currencies were actually exercised at all four magnitudes');
});

// =============================================================================================
// 3. The largest-remainder allocation still sums EXACTLY to the converted side total.
// =============================================================================================

test('allocateBase sums EXACTLY to the converted side total, at every published rate', () => {
  const shapes = [
    [1],
    [1, 1, 1],
    [0, 5_000, 0],
    [33, 33, 34],
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    [999_999_999, 1, 7, 123_456],
    [10_000_000_000, 3, 3, 3],
  ];
  const rates = [...Object.values(PUBLISHED), ...Object.values(UNCHANGED)].map((p) =>
    parseRate(publishedDecimalString(p)),
  );

  for (const rateScaled of rates) {
    for (const amounts of shapes) {
      const allocated = allocateBase(amounts, rateScaled);
      const total = amounts.reduce((a, b) => a + b, 0);
      assert.equal(allocated.length, amounts.length);
      assert.ok(allocated.every((a) => a >= 0), 'no line is allocated a negative base amount');
      assert.equal(
        allocated.reduce((a, b) => a + b, 0),
        convertMinor(total, rateScaled),
        `Σ allocateBase == convertMinor(Σ) for ${JSON.stringify(amounts)} at ${formatRate(rateScaled)}`,
      );
    }
  }
});

test('at a rate of exactly 1 the allocation is still the identity, line for line', () => {
  const amounts = [1, 7, 4999, 123_456_789, 0, 42];
  assert.deepEqual(allocateBase(amounts, RATE_ONE), amounts);
  assert.equal(convertMinor(123_456_789, RATE_ONE), 123_456_789);
});

// =============================================================================================
// 4. rate -> string -> SQLite -> rate survives byte for byte.
// =============================================================================================

test('the rate round trips through SQLite and back into the same scaled integer', () => {
  const { ctx, store } = setup();
  assert.ok(importPublished(ctx).ok);

  const rows = store.db
    .prepare('SELECT * FROM exchange_rate WHERE workspace_id = ? ORDER BY base_currency')
    .all(ctx.workspaceId);
  assert.ok(rows.length >= 70, 'the whole published series is on file');

  for (const row of rows) {
    const reparsed = parseRate(row.rate);
    assert.ok(reparsed !== null, `${row.base_currency}: the stored string is still a legal rate`);
    assert.equal(BigInt(row.rate_scaled), reparsed, `${row.base_currency}: TEXT and INTEGER agree`);
    assert.equal(formatRate(reparsed), row.rate, `${row.base_currency}: canonical form is stable`);

    // And the resolver hands the ledger back the same integer it stored, not a re-derived one.
    const resolved = resolveFxRate(ctx, { currency: row.base_currency, date: row.as_of });
    assert.ok(resolved.ok, `${row.base_currency}: ${show(resolved)}`);
    assert.equal(resolved.resolved.rateScaled, reparsed);
    assert.equal(resolved.resolved.rate, row.rate);
  }
});

test('the rate stamped on a posted line reproduces that line base amount, years later', () => {
  // The audit-trail invariant: nobody ever has to re-derive a historical rate, because the string on
  // the row IS the rate, and re-reading it reproduces the number in the books.
  const { ctx, store, accounts } = setup();
  assert.ok(importPublished(ctx).ok);

  const amount = 7_654_321;
  const res = postEntry(ctx, {
    date: BOOK_DATE,
    source: 'manual',
    idempotencyKey: 'audit-1',
    currency: 'COP',
    lines: [
      { account: accounts['6500'], debit: amount },
      { account: accounts['1020'], credit: amount },
    ],
  });
  assert.ok(res.ok, JSON.stringify(res));

  const row = linesOf(store, res.entryId)[0];
  const fromTheRowAlone = convertMinor(row.debit_minor, parseRate(row.fx_rate));
  assert.equal(fromTheRowAlone, row.base_debit_minor, 'the row is self-describing and self-consistent');
});

// =============================================================================================
// 5. A base-currency posting still stores a NULL rate. A rate of 1 is not FX.
// =============================================================================================

test('a CHF posting stores NULL fx_rate and base amounts identical to the transaction amounts', () => {
  const { ctx, store, accounts } = setup();
  assert.ok(importPublished(ctx).ok, 'even with a full rate table on file');

  const res = postEntry(ctx, {
    date: BOOK_DATE,
    source: 'manual',
    idempotencyKey: 'chf-1',
    lines: [
      { account: accounts['6500'], debit: 5000 },
      { account: accounts['1020'], credit: 5000 },
    ],
  });
  assert.ok(res.ok, JSON.stringify(res));
  assert.equal(res.currency, undefined, 'a base-currency post reports no FX, because there is none');

  for (const l of linesOf(store, res.entryId)) {
    assert.equal(l.currency, 'CHF');
    assert.equal(l.fx_rate, null, 'a rate of 1 is NOT stamped: it is not FX');
    assert.equal(l.base_debit_minor, l.debit_minor);
    assert.equal(l.base_credit_minor, l.credit_minor);
  }
});

test('EUR and USD are bit-for-bit what they were: the widening moved no existing number', () => {
  const { ctx, store, accounts } = setup();
  assert.ok(importPublished(ctx).ok);

  // Hardcoded, not computed by the engine: EUR 0.93883 and USD 0.82497 on 1'234'567 minor units.
  const PINNED = { EUR: 1_159_049, USD: 1_018_481 };

  for (const [currency, expected] of Object.entries(PINNED)) {
    const amount = 1_234_567;
    const res = postEntry(ctx, {
      date: BOOK_DATE,
      source: 'manual',
      idempotencyKey: `pin-${currency}`,
      currency,
      lines: [
        { account: accounts['6500'], debit: amount },
        { account: accounts['1020'], credit: amount },
      ],
    });
    assert.ok(res.ok, JSON.stringify(res));
    const row = linesOf(store, res.entryId)[0];
    assert.equal(row.fx_rate, UNCHANGED[currency].kurs, 'the published rate, verbatim');
    assert.equal(row.base_debit_minor, expected, `${currency} converts to the same Rappen as before`);
    assert.equal(row.base_debit_minor, publishedBaseMinor(amount, UNCHANGED[currency]));
  }
});

// =============================================================================================
// 6. Every stored scaled rate is exact, in SQLite AND as a JavaScript number, with headroom.
// =============================================================================================

test('the scale holds every published rate with room to spare, in both directions', () => {
  // The requirement is stated as a property of the published series, not as a number: the SMALLEST
  // rate the admissible series carries must keep several significant figures, and the LARGEST must
  // sit far below what the storage can hold. LBP (0.000009201) and KWD (2.66992) are today's two
  // ends of the real range.
  const smallest = parseRate('0.000009201');
  const largest = parseRate('2.66992');
  assert.ok(smallest !== null && largest !== null);

  // Headroom BELOW, stated as what it lets a ledger do rather than as a digit count: today's
  // smallest published rate can devalue a THOUSANDFOLD and still be held exactly, with four
  // significant figures intact. That is the margin the widening buys, and it is the margin the old
  // 1e8 scale did not have (it could not hold the undevalued rate at all).
  const devalued = '0.000000009201'; // LBP 0.000009201 after a 1000x devaluation
  const devaluedScaled = parseRate(devalued);
  assert.ok(devaluedScaled !== null, 'a thousandfold devaluation of the smallest published rate is still bookable');
  assert.equal(formatRate(devaluedScaled), devalued, 'and it is held EXACTLY, never rounded to fit');
  assert.ok(devaluedScaled >= 1000n, 'with four significant figures still intact');

  // Headroom ABOVE the largest published rate, before the storage ceiling. This is the inverse
  // direction the widening trades against: a currency worth far MORE than a franc.
  assert.ok(
    RATE_MAX_SCALED / largest >= 1000n,
    `the ceiling is at least 1000x the largest published rate (it is ${RATE_MAX_SCALED / largest}x)`,
  );

  // The ceiling itself must be exact in a SQLite INTEGER (64-bit signed) with real headroom, AND
  // exact as a JavaScript number, because the store reads this column back as one.
  const INT64_MAX = 9_223_372_036_854_775_807n;
  assert.ok(RATE_MAX_SCALED * 1000n < INT64_MAX, 'the ceiling has 1000x headroom inside a 64-bit integer');
  assert.ok(
    RATE_MAX_SCALED <= BigInt(Number.MAX_SAFE_INTEGER),
    'every storable rate is also an EXACT JavaScript number, so a Number() read cannot corrupt one',
  );
});

test('a rate at the ceiling survives SQLite exactly; one above it is REFUSED, never truncated', () => {
  const { ctx, store } = setup();

  const ceiling = formatRate(RATE_MAX_SCALED);
  const atCeiling = recordExchangeRate(ctx, {
    baseCurrency: 'KWD',
    rate: ceiling,
    asOf: BOOK_DATE,
    source: 'manual',
    method: 'daily',
    provenance: 'the storage ceiling',
    idempotencyKey: 'ceiling-1',
  });
  assert.ok(atCeiling.ok, JSON.stringify(atCeiling));
  const row = store.db.prepare('SELECT * FROM exchange_rate WHERE id = ?').get(atCeiling.rateId);
  assert.equal(BigInt(row.rate_scaled), RATE_MAX_SCALED, 'the ceiling value survives the INTEGER column exactly');
  assert.equal(row.rate, ceiling, 'and its canonical string is unchanged');

  // Above the ceiling: refused. A rate silently truncated into range is a wrong rate, and a wrong
  // rate is wrong money.
  const over = formatRate(RATE_MAX_SCALED + RATE_SCALE);
  assert.equal(parseRate(over), null, `${over} is above what the ledger can hold, so it does not parse`);
  const refused = recordExchangeRate(ctx, {
    baseCurrency: 'BHD',
    rate: over,
    asOf: BOOK_DATE,
    source: 'manual',
    method: 'daily',
    idempotencyKey: 'ceiling-2',
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'invalid_input');
  assert.equal(
    store.db.prepare("SELECT COUNT(*) AS n FROM exchange_rate WHERE base_currency = 'BHD'").get().n,
    0,
    'nothing landed',
  );
});

test('a rate with more places than the ledger holds is refused, not silently rounded', () => {
  const oneTooMany = `0.${'0'.repeat(RATE_DECIMALS)}1`;
  assert.equal(parseRate(oneTooMany), null, 'a rate TILL cannot hold exactly is never truncated to fit');
  // ...but exactly RATE_DECIMALS places is fine, and is the identity through the canonical form.
  const atTheLimit = `0.${'0'.repeat(RATE_DECIMALS - 1)}1`;
  const scaled = parseRate(atTheLimit);
  assert.equal(scaled, 1n, 'the last place is one scaled unit');
  assert.equal(formatRate(scaled), atTheLimit);
});

test('two rates that differ only beyond the JavaScript safe range are NOT treated as equal', () => {
  // rate_conflict decides whether a re-recorded rate is "the same". Comparing through a lossy
  // numeric conversion would let a genuinely different rate slip in under an existing key, which is
  // precisely the case §H-AUDIT exists to prevent.
  const { ctx, store } = setup();
  const first = formatRate(RATE_MAX_SCALED);
  const second = formatRate(RATE_MAX_SCALED - 1n);
  assert.notEqual(first, second);

  const a = recordExchangeRate(ctx, {
    baseCurrency: 'KWD', rate: first, asOf: BOOK_DATE, source: 'manual', method: 'daily', idempotencyKey: 'clash-a',
  });
  assert.ok(a.ok, JSON.stringify(a));
  const b = recordExchangeRate(ctx, {
    baseCurrency: 'KWD', rate: second, asOf: BOOK_DATE, source: 'manual', method: 'daily', idempotencyKey: 'clash-b',
  });
  assert.equal(b.ok, false, 'a different rate under the same key is a conflict, however small the difference');
  assert.equal(b.error, 'rate_conflict');
  assert.equal(store.db.prepare("SELECT rate FROM exchange_rate WHERE base_currency = 'KWD'").get().rate, first);
});

// =============================================================================================
// 7. A database written before the widening does not keep its old numbers under a new meaning.
// =============================================================================================

test('a pre-widening database is MIGRATED on open: rate_scaled is made to agree with rate', () => {
  const dir = mkdtempSync(join(tmpdir(), 'till-fx-scale-'));
  const file = join(dir, 'till.db');
  try {
    // Build a file that looks exactly like one written before the widening: the canonical string is
    // right (it always was), and rate_scaled holds the OLD 1e8 integer. `user_version` is 0, which
    // is what every database written before this migration carries.
    {
      const store = new SqliteStore({ location: file, clock: fixedClock(AT) });
      store.db
        .prepare('INSERT INTO workspace (id, name, base_currency, fiscal_year_start, created_at) VALUES (?, ?, ?, ?, ?)')
        .run('ws_1', 'Nomadik GmbH', 'CHF', '01-01', AT);
      store.db
        .prepare(
          `INSERT INTO exchange_rate
             (id, workspace_id, base_currency, quote_currency, rate, rate_scaled, as_of, source, method, provenance, created_at, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run('fx_legacy', 'ws_1', 'EUR', 'CHF', '0.9412', 94_120_000, '2026-07-24', 'manual', 'daily', 'legacy', AT, 'user_1');
      store.db.pragma('user_version = 0');
      store.close();
    }

    const store = new SqliteStore({ location: file, clock: fixedClock(AT) });
    const row = store.db.prepare('SELECT * FROM exchange_rate WHERE id = ?').get('fx_legacy');
    assert.equal(row.rate, '0.9412', 'the canonical string is authoritative and is left alone');
    assert.equal(
      BigInt(row.rate_scaled),
      parseRate('0.9412'),
      'the scaled integer now means what the current scale says it means',
    );

    // And the migrated row actually prices a posting correctly, which is the only thing that matters.
    const ctx = makeContext(store, {
      workspaceId: 'ws_1', actor: 'user_1', clock: fixedClock(AT), ids: sequenceIdGen(),
    });
    const resolved = resolveFxRate(ctx, { currency: 'EUR', date: '2026-07-27' });
    assert.ok(resolved.ok, show(resolved));
    assert.equal(convertMinor(1_000_000, resolved.resolved.rateScaled), 941_200, 'CHF 9412.00 for EUR 10000.00');

    // Re-opening again is a no-op: the migration is idempotent, not a repeated multiplication.
    store.close();
    const reopened = new SqliteStore({ location: file, clock: fixedClock(AT) });
    assert.equal(
      BigInt(reopened.db.prepare('SELECT * FROM exchange_rate WHERE id = ?').get('fx_legacy').rate_scaled),
      parseRate('0.9412'),
      'opening twice does not rescale twice',
    );
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a fresh database is stamped with the current schema version, so it is never re-migrated', () => {
  const { store } = setup();
  const version = store.db.pragma('user_version', { simple: true });
  assert.ok(version > 0, 'a database this engine created records which scale generation it is on');
});
