// A02 + §H-FX: posting in a transaction currency, with the full txn + base(CHF) + rate trace.
//
// The invariants under test are the ones a wrong FX ledger violates quietly:
//   - the books balance in BASE currency, never merely in the transaction currency;
//   - every posted row carries all three of the trace, so no reader re-derives a historical rate;
//   - a posting NEVER converts at a guess: no rate means no entry;
//   - a foreign entry is still append-only, still idempotent, and still reversible into exact zero.

import test from 'node:test';
import assert from 'node:assert/strict';

import { postEntry } from '../../dist/core/ledger/index.js';
import { reverseEntry } from '../../dist/core/ledger/index.js';
import { recordExchangeRate } from '../../dist/core/fx/index.js';
import { setup, withVat } from './support.mjs';

const EUR_RATE = {
  baseCurrency: 'EUR',
  rate: '0.9412',
  asOf: '2026-03-01',
  source: 'manual',
  method: 'daily',
  provenance: 'ESTV Tageskurs Verkauf (MWSTV Art. 45 Abs. 3)',
  idempotencyKey: 'rate-eur-1',
};

/** A EUR sale: debit the receivable gross, credit revenue net + output VAT. */
function eurSale(accounts, { net, vat, key = 'fx-1', currency = 'EUR', fxRate } = {}) {
  return {
    date: '2026-03-01',
    description: 'Beratung Kunde EU',
    source: 'invoice',
    idempotencyKey: key,
    currency,
    ...(fxRate !== undefined ? { fxRate } : {}),
    lines: [
      { account: accounts['1000'], debit: net + vat },
      { account: accounts['3000'], credit: net },
      // A zero-VAT sale is a two-line entry: a line with neither side positive is not a line.
      ...(vat > 0 ? [{ account: accounts['1020'], credit: vat }] : []),
    ],
  };
}

function lines(store, entryId) {
  return store.db.prepare('SELECT * FROM journal_line WHERE entry_id = ? ORDER BY rowid').all(entryId);
}

test('a CHF posting is UNCHANGED by the FX work: base equals txn, fx_rate stays NULL', () => {
  const { store, ctx, accounts } = setup();
  const res = postEntry(ctx, {
    date: '2026-03-01',
    source: 'manual',
    idempotencyKey: 'chf-1',
    lines: [
      { account: accounts['6500'], debit: 5000 },
      { account: accounts['1000'], credit: 5000 },
    ],
  });
  assert.ok(res.ok, JSON.stringify(res));
  assert.equal(res.currency, undefined, 'a base-currency post reports no FX, because there is none');
  for (const l of lines(store, res.entryId)) {
    assert.equal(l.currency, 'CHF');
    assert.equal(l.fx_rate, null, 'a rate of 1 is not FX and is not stamped');
    assert.equal(l.base_debit_minor, l.debit_minor);
    assert.equal(l.base_credit_minor, l.credit_minor);
  }
});

test('a EUR posting stores the WHOLE §H-FX trace on every line, and the books hold CHF', () => {
  const { store, ctx, accounts } = setup();
  assert.ok(recordExchangeRate(ctx, EUR_RATE).ok);

  // EUR 1'000.00 net + EUR 81.00 VAT (8.1%) = EUR 1'081.00 gross, at EUR/CHF 0.9412.
  const res = postEntry(ctx, eurSale(accounts, { net: 100000, vat: 8100 }));
  assert.ok(res.ok, JSON.stringify(res));
  assert.equal(res.currency, 'EUR');
  assert.equal(res.fxRate, '0.9412');
  assert.equal(res.fxRateAsOf, '2026-03-01');

  const rows = lines(store, res.entryId);
  for (const l of rows) {
    assert.equal(l.currency, 'EUR', 'the transaction currency, on every row');
    assert.equal(l.fx_rate, '0.9412', 'the rate that turned one into the other, on every row');
  }

  // Transaction currency: exactly what was billed.
  assert.deepEqual(
    rows.map((l) => [l.debit_minor, l.credit_minor]),
    [[108100, 0], [0, 100000], [0, 8100]],
  );
  // Base currency: what the books carry. 1081.00 * 0.9412 = 1017.4372 -> CHF 1'017.44.
  assert.deepEqual(
    rows.map((l) => [l.base_debit_minor, l.base_credit_minor]),
    [[101744, 0], [0, 94120], [0, 7624]],
  );

  const baseDebit = rows.reduce((s, l) => s + l.base_debit_minor, 0);
  const baseCredit = rows.reduce((s, l) => s + l.base_credit_minor, 0);
  assert.equal(baseDebit, baseCredit, '§H-LEDGER holds in BASE currency');
  assert.equal(baseDebit, 101744);
});

test('the rounding case that would have unbalanced the books balances to the Rappen', () => {
  const { store, ctx, accounts } = setup();
  assert.ok(recordExchangeRate(ctx, EUR_RATE).ok);

  // EUR 12.00 net + EUR 0.97 VAT = EUR 12.97 gross. Converting each line on its own gives
  // CHF 11.29 + CHF 0.91 = CHF 12.20 against a receivable of CHF 12.21: one Rappen of air.
  const res = postEntry(ctx, eurSale(accounts, { net: 1200, vat: 97, key: 'fx-drift' }));
  assert.ok(res.ok, JSON.stringify(res));

  const rows = lines(store, res.entryId);
  const baseDebit = rows.reduce((s, l) => s + l.base_debit_minor, 0);
  const baseCredit = rows.reduce((s, l) => s + l.base_credit_minor, 0);
  assert.equal(baseDebit, 1221, "CHF 12.21, the conversion of the invoice TOTAL");
  assert.equal(baseCredit, 1221, 'and the credits were allocated to that same total, not rounded apart');
  // No plug: nothing was booked to a rounding-difference account, because none exists.
  assert.equal(rows.length, 3);
});

test('NO rate means NO entry: the posting is refused and nothing is written', () => {
  const { store, ctx, accounts } = setup();
  const res = postEntry(ctx, eurSale(accounts, { net: 100000, vat: 8100 }));
  assert.equal(res.ok, false);
  assert.equal(res.error, 'needs_fx_rate');
  assert.equal(res.currency, 'EUR');
  assert.equal(res.baseCurrency, 'CHF');
  assert.equal(res.latestAsOf, null);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM journal_entry').get().n, 0);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM journal_line').get().n, 0);
  // And the refusal was not memoised: recording the rate makes the SAME call succeed.
  assert.ok(recordExchangeRate(ctx, EUR_RATE).ok);
  assert.ok(postEntry(ctx, eurSale(accounts, { net: 100000, vat: 8100 })).ok);
});

test('a caller may assert the rate EXPLICITLY, and a malformed one is refused', () => {
  const { store, ctx, accounts } = setup();
  const res = postEntry(ctx, eurSale(accounts, { net: 100000, vat: 8100, fxRate: '0.95' }));
  assert.ok(res.ok, JSON.stringify(res));
  assert.equal(res.fxRate, '0.95', 'no rate was on file: the caller supplied it');
  assert.equal(lines(store, res.entryId)[0].base_debit_minor, 102695, "EUR 1'081.00 * 0.95");

  // '0.1234567891234' is thirteen places: one more than the ledger holds. Nine places used to be
  // over the line and no longer is, because the rate scale was widened to 1e12 so the four
  // currencies the BAZG series publishes per 10000 units (IDR, KHR, COP, LBP) can be booked at all.
  // '9001' is above the storage ceiling, where rate_scaled would stop being an exact number.
  for (const bad of ['0', '-1', 'abc', '0.1234567891234', '9001']) {
    const rejected = postEntry(ctx, eurSale(accounts, { net: 100, vat: 0, key: `bad-${bad}`, fxRate: bad }));
    assert.equal(rejected.ok, false, bad);
    assert.equal(rejected.error, 'invalid_input');
    assert.equal(rejected.field, 'fxRate');
  }
});

test('a nonsense currency code is a structured rejection, never a stored guess', () => {
  const { ctx, accounts } = setup();
  for (const bad of ['eur', 'EURO', 'E', '978']) {
    const res = postEntry(ctx, eurSale(accounts, { net: 100, vat: 0, key: `c-${bad}`, currency: bad, fxRate: '0.9' }));
    assert.equal(res.ok, false, bad);
    assert.equal(res.error, 'invalid_input');
    assert.equal(res.field, 'currency');
  }
});

test('a EUR post is IDEMPOTENT, asserted on ROWS: a double-post does not double the books', () => {
  const { store, ctx, accounts } = setup();
  assert.ok(recordExchangeRate(ctx, EUR_RATE).ok);
  const input = eurSale(accounts, { net: 100000, vat: 8100, key: 'once' });

  const first = postEntry(ctx, input);
  const second = postEntry(ctx, input);
  assert.ok(first.ok && second.ok);
  assert.deepEqual(first, second);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM journal_entry').get().n, 1, 'ONE entry');
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM journal_line').get().n, 3, 'THREE lines');
  assert.equal(
    store.db.prepare('SELECT SUM(base_debit_minor) AS d FROM journal_line').get().d,
    101744,
    'the CHF receivable was booked ONCE',
  );
});

test('a posted EUR entry is IMMUTABLE: the trigger refuses to change its rate or its base amount', () => {
  const { store, ctx, accounts } = setup();
  assert.ok(recordExchangeRate(ctx, EUR_RATE).ok);
  const res = postEntry(ctx, eurSale(accounts, { net: 100000, vat: 8100, key: 'sealed' }));
  assert.ok(res.ok);

  assert.throws(
    () => store.db.prepare('UPDATE journal_line SET fx_rate = ? WHERE entry_id = ?').run('9.99', res.entryId),
    /posted_immutable/,
  );
  assert.throws(
    () => store.db.prepare('UPDATE journal_line SET base_debit_minor = 1 WHERE entry_id = ?').run(res.entryId),
    /posted_immutable/,
  );
  assert.throws(
    () => store.db.prepare('DELETE FROM journal_line WHERE entry_id = ?').run(res.entryId),
    /posted_immutable/,
  );
});

test('reversing a EUR entry nets the books to EXACTLY zero in both currencies', () => {
  const { store, ctx, accounts } = setup();
  assert.ok(recordExchangeRate(ctx, EUR_RATE).ok);
  const posted = postEntry(ctx, eurSale(accounts, { net: 1200, vat: 97, key: 'to-reverse' }));
  assert.ok(posted.ok, JSON.stringify(posted));

  const reversed = reverseEntry(ctx, { entryId: posted.entryId, idempotencyKey: 'rev-1' });
  assert.ok(reversed.ok, JSON.stringify(reversed));

  const both = store.db
    .prepare(
      `SELECT account_id,
              SUM(debit_minor - credit_minor) AS txn,
              SUM(base_debit_minor - base_credit_minor) AS base
         FROM journal_line WHERE entry_id IN (?, ?) GROUP BY account_id`,
    )
    .all(posted.entryId, reversed.reversalId);
  assert.equal(both.length, 3);
  for (const row of both) {
    assert.equal(row.txn, 0, `${row.account_id} nets to zero in EUR`);
    assert.equal(row.base, 0, `${row.account_id} nets to zero in CHF (the rounding was mirrored, not re-done)`);
  }

  // The reversal carries the ORIGINAL's rate, not today's.
  for (const l of lines(store, reversed.reversalId)) {
    assert.equal(l.currency, 'EUR');
    assert.equal(l.fx_rate, '0.9412');
  }
});

test('a correction is never blocked by a rate that has gone stale', () => {
  const { ctx, accounts } = setup();
  assert.ok(recordExchangeRate(ctx, EUR_RATE).ok);
  const posted = postEntry(ctx, eurSale(accounts, { net: 100000, vat: 8100, key: 'old' }));
  assert.ok(posted.ok);

  // Months later, with no fresh rate on file, the entry must still be correctable: an entry you
  // cannot reverse is an entry you can only fix by editing, which §H-AUDIT forbids.
  const reversed = reverseEntry(ctx, {
    entryId: posted.entryId,
    date: '2026-11-30',
    idempotencyKey: 'rev-late',
  });
  assert.ok(reversed.ok, JSON.stringify(reversed));
});

test('the reversal slot cannot be squatted with the right CHF reached by a different rate', () => {
  const { ctx, accounts } = setup();
  assert.ok(recordExchangeRate(ctx, EUR_RATE).ok);
  const posted = postEntry(ctx, eurSale(accounts, { net: 100000, vat: 8100, key: 'target' }));
  assert.ok(posted.ok);

  const squat = postEntry(ctx, {
    date: '2026-03-02',
    source: 'reversal',
    reversesEntryId: posted.entryId,
    idempotencyKey: 'squat',
    currency: 'EUR',
    fxRate: '0.5',
    lines: [
      { account: accounts['1000'], credit: 108100 },
      { account: accounts['3000'], debit: 100000 },
      { account: accounts['1020'], debit: 8100 },
    ],
  });
  assert.equal(squat.ok, false);
  assert.equal(squat.error, 'not_a_mirror');
  assert.equal(squat.targetFxRate, '0.9412');
  assert.equal(squat.fxRate, '0.5');

  // A CHF "mirror" of a EUR entry is refused for the same reason.
  const wrongCurrency = postEntry(ctx, {
    date: '2026-03-02',
    source: 'reversal',
    reversesEntryId: posted.entryId,
    idempotencyKey: 'squat-2',
    lines: [
      { account: accounts['1000'], credit: 108100 },
      { account: accounts['3000'], debit: 100000 },
      { account: accounts['1020'], debit: 8100 },
    ],
  });
  assert.equal(wrongCurrency.ok, false);
  assert.equal(wrongCurrency.error, 'not_a_mirror');
});

// --- Parity: a foreign currency at a rate of exactly 1 -------------------------------------------
//
// A peg (or a day on which the market simply landed on 1) is not an absence of FX. What decides
// whether a row states a conversion basis is the CURRENCY, not the number: a base-currency row
// carries no rate because nothing was converted, a foreign-currency row carries its rate because
// something was. See docs/specs/03-fx-foundation.md section 13 for the MWSTV Art. 45 Abs. 5 /
// OR Art. 957a Abs. 2 Ziff. 5 reasoning and the fetched sources.
const EUR_PEG = { ...EUR_RATE, rate: '1', asOf: '2026-03-01', idempotencyKey: 'rate-eur-peg' };

test('a EUR entry at a rate of exactly 1 still discloses its currency and its rate', () => {
  const { store, ctx, accounts } = setup();
  assert.ok(recordExchangeRate(ctx, EUR_PEG).ok);
  const res = postEntry(ctx, eurSale(accounts, { net: 100000, vat: 8100, key: 'peg-1' }));
  assert.ok(res.ok, JSON.stringify(res));

  const rows = lines(store, res.entryId);
  assert.equal(rows.length, 3);
  for (const l of rows) {
    assert.equal(l.currency, 'EUR', 'the debt is denominated in euros and the row says so');
    // The invariant: the row STATES the basis it was converted on. Not "the string is X".
    assert.notEqual(l.fx_rate, null, `a foreign-currency row states its conversion basis: ${JSON.stringify(l)}`);
    assert.equal(
      Math.round(l.debit_minor * Number(l.fx_rate)),
      l.base_debit_minor,
      'the stated rate re-derives the stored base debit',
    );
    assert.equal(
      Math.round(l.credit_minor * Number(l.fx_rate)),
      l.base_credit_minor,
      'the stated rate re-derives the stored base credit',
    );
  }
  // Disclosure is reported to the caller too, not only stored.
  assert.equal(res.currency, 'EUR', JSON.stringify(res));
  assert.notEqual(res.fxRate, undefined, `the caller is told the basis it posted on: ${JSON.stringify(res)}`);
  assert.equal(Number(res.fxRate), 1, 'and the basis reported is the parity one that was applied');
});

test('reversing a parity EUR entry mirrors its currency and rate, and a CHF mirror is refused', () => {
  const { store, ctx, accounts } = setup();
  assert.ok(recordExchangeRate(ctx, EUR_PEG).ok);
  const posted = postEntry(ctx, eurSale(accounts, { net: 100000, vat: 8100, key: 'peg-target' }));
  assert.ok(posted.ok, JSON.stringify(posted));

  // The franc "mirror" goes FIRST, while the reversal slot is still empty, so the refusal below can
  // only be the currency-and-rate check speaking: with the slot already taken the guard would answer
  // `already_reversed` and prove nothing. This entry nets the CHF books to zero on integers identical
  // to the original's, which is exactly why the currency has to be part of the match: the arithmetic
  // agrees and the story does not.
  const chfMirror = postEntry(ctx, {
    date: '2026-03-02',
    source: 'reversal',
    reversesEntryId: posted.entryId,
    idempotencyKey: 'peg-squat',
    lines: [
      { account: accounts['1000'], credit: 108100 },
      { account: accounts['3000'], debit: 100000 },
      { account: accounts['1020'], debit: 8100 },
    ],
  });
  assert.equal(chfMirror.ok, false, JSON.stringify(chfMirror));
  assert.equal(chfMirror.error, 'not_a_mirror', JSON.stringify(chfMirror));
  assert.notEqual(chfMirror.targetFxRate, null, 'the target it was compared against states a basis');

  // The predicate that decides what gets STORED and the one that decides what a reversal must MATCH
  // are the same predicate. If they drift apart, the honest reversal below stops being possible.
  const reversed = reverseEntry(ctx, { entryId: posted.entryId, idempotencyKey: 'peg-rev' });
  assert.ok(reversed.ok, JSON.stringify(reversed));
  for (const l of lines(store, reversed.reversalId)) {
    assert.equal(l.currency, 'EUR');
    assert.equal(l.fx_rate, lines(store, posted.entryId)[0].fx_rate, 'the reversal carries the original basis');
  }
});

test('the VAT trace rides the transaction currency, and the CHF filing figure is STORED not derived', () => {
  const { store, ctx, accounts } = setup();
  const vat = withVat(store);
  assert.ok(recordExchangeRate(ctx, EUR_RATE).ok);

  // A EUR purchase: net expense + deductible Vorsteuer, gross to the bank.
  const res = postEntry(ctx, {
    date: '2026-03-01',
    source: 'invoice',
    idempotencyKey: 'fx-vat',
    currency: 'EUR',
    lines: [
      { account: accounts['6500'], debit: 100000, taxCode: vat.code },
      { account: vat.vorsteuer, debit: 8100 },
      { account: accounts['1020'], credit: 108100 },
    ],
  });
  assert.ok(res.ok, JSON.stringify(res));

  const rows = lines(store, res.entryId);
  const expense = rows.find((l) => l.account_id === accounts['6500']);
  assert.equal(expense.tax_base_minor, 100000, 'the trace is in EUR, on the same row as the EUR amount');
  assert.equal(expense.tax_amount_minor, 8100);

  // The MWST filing needs CHF, and it is already a stored value: the base movement on 1170.
  const vorsteuerChf = store.db
    .prepare('SELECT SUM(base_debit_minor - base_credit_minor) AS chf FROM journal_line WHERE entry_id = ? AND account_id = ?')
    .get(res.entryId, vat.vorsteuer).chf;
  assert.equal(vorsteuerChf, 7624, 'CHF 76.24 of Vorsteuer, read off the ledger, never recomputed');
});

test('§H-PERIOD still bites on a foreign-currency posting', () => {
  const { ctx, accounts } = setup({
    periods: { assertOpen: () => ({ ok: false, error: 'period_locked', period: '2026-03', kind: 'hard' }) },
  });
  assert.ok(recordExchangeRate(ctx, EUR_RATE).ok);
  const res = postEntry(ctx, eurSale(accounts, { net: 100000, vat: 8100, key: 'locked' }));
  assert.equal(res.ok, false);
  assert.equal(res.error, 'period_locked');
});
