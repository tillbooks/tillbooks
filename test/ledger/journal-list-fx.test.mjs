// @ts-check
/**
 * A02 §H-FX: `list_journal` says which currency its `total` is in, and what the BOOKS hold.
 *
 * THE DEFECT THIS EXISTS FOR. `list_journal`'s `total` is `SUM(debit_minor)`, the TRANSACTION
 * amount, and the read model sent no currency beside it. The Studio journal list therefore rendered
 * a EUR entry's total under a hardcoded CHF label: the wrong number and the wrong unit at once. The
 * surface carried a written KNOWN GAP rather than a workaround, because the only workarounds
 * available to a client (guess the currency, or fire a `get_entry` per row and convert) are the
 * client inventing money. The fix belongs here, at the read model, and this file is what holds it up.
 *
 * The figures are DERIVED from the entry's own posted rows at read time, never persisted beside
 * them, exactly as A10's `DOCUMENT_SELECT` derives a document's. A stored copy of a converted total
 * is a second source of truth that can disagree with the ledger, and a read model that disagrees
 * with the ledger is worse than one that stays silent. So no assertion below compares the read model
 * against a literal or against the return value of the call that produced it: every one of them
 * reads `journal_line` back out of SQLite and demands the read model equal THOSE rows.
 *
 * ## The arms, established against the LIVE engine and not assumed
 *
 * A journal entry's arms are NOT a document's. The gate on the FX group is the same single
 * predicate, A02's `statesConversionBasis` (imported, never re-derived), but what can reach each arm
 * differs, because a journal entry's currency lives only on its lines:
 *
 *   1. an entry with NO lines: `currency` is null, because a currency is a property of the rows and
 *      there are none. Documents have no such arm; an empty draft is the ordinary way to reach it.
 *   2. base currency, posted or draft: `currency` is the base code, and the FX group is absent.
 *   3. foreign, posted: all three of the group, with real figures.
 *   4. foreign, posted at parity: all three, `fxRate` exactly '1'. Parity is a stated basis, not the
 *      absence of one, so this arm is NOT arm 2 even though the two totals coincide.
 *
 * ## One currency per entry, and why that is a fact rather than a hope
 *
 * `writePostedEntry` stamps `fx.currency` and one `fxRate` onto EVERY row of the entry it writes,
 * from a single per-ENTRY `currency` input; a per-LINE currency is not part of `LineInput` and is
 * ignored if passed. Promotion deletes and rewrites the whole line set. `saveDraft` writes one
 * literal for all its rows. There is no fourth writer of `journal_line`. A mixed-currency entry is
 * therefore not representable, which is why the read model reports ONE currency per entry with
 * confidence rather than hedging with a per-line breakdown. `one currency per entry` below asserts
 * that over every entry these suites write, so the day a fifth writer appears this goes red.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { postEntry, saveDraft, listJournal, getEntry } from '../../dist/core/ledger/index.js';
import { statesConversionBasis } from '../../dist/core/ledger/postEntry.js';
import { recordExchangeRate } from '../../dist/core/fx/index.js';
import { getAction } from '../../dist/api/registry.js';
import { setup } from './support.mjs';
import { defined, id, num, obj, objs, okOf, str, strCol } from '../support/narrow.mjs';

const DATE = '2026-03-01';

function rate(ctx, currency, value, key, source = 'manual') {
  const res = recordExchangeRate(ctx, {
    baseCurrency: currency,
    rate: value,
    asOf: DATE,
    source,
    method: 'daily',
    provenance: 'ESTV Tageskurs Verkauf (MWSTV Art. 45 Abs. 3)',
    idempotencyKey: key,
  });
  assert.ok(res.ok, JSON.stringify(res));
}

/** A balanced two-line entry, optionally in a transaction currency. */
/**
 * @param {any} ctx
 * @param {ReturnType<typeof setup>['accounts']} accounts
 * @param {{ key: string, currency?: string, amount?: number, date?: string }} spec
 */
function post(ctx, accounts, { key, currency, amount = 100000, date = DATE }) {
  const res = postEntry(ctx, {
    date,
    source: 'manual',
    idempotencyKey: key,
    ...(currency !== undefined ? { currency } : {}),
    lines: [
      { account: accounts['6500'], debit: amount },
      { account: accounts['1000'], credit: amount },
    ],
  });
  return id(res, 'entryId', 'postEntry');
}

/** What the LEDGER holds for one entry, straight out of SQLite. The only authority in this file. */
function ledgerFigures(store, entryId) {
  const rows = store.db
    .prepare(
      'SELECT currency, debit_minor, base_debit_minor, fx_rate FROM journal_line WHERE entry_id = ? ORDER BY rowid',
    )
    .all(entryId);
  const currencies = [...new Set(rows.map((r) => r.currency))];
  const rates = [...new Set(rows.map((r) => r.fx_rate))];
  assert.ok(currencies.length <= 1, `an entry carries ONE currency, found ${JSON.stringify(currencies)}`);
  assert.ok(rates.length <= 1, `an entry converts on ONE basis, found ${JSON.stringify(rates)}`);
  return {
    rows,
    currency: rows.length === 0 ? null : currencies[0],
    rate: rows.length === 0 ? null : rates[0],
    debitTotal: rows.reduce((sum, r) => sum + r.debit_minor, 0),
    baseDebitTotal: rows.reduce((sum, r) => sum + r.base_debit_minor, 0),
  };
}

function listed(ctx, entryId, filter = {}) {
  const entries = objs(okOf(listJournal(ctx, filter), 'listJournal').entries, 'listJournal.entries');
  return obj(
    entries.find((e) => e.id === entryId),
    `${entryId} in list_journal`,
  );
}

/**
 * Does the READ MODEL state a conversion basis? The mirror of `statesConversionBasis`, asked of the
 * thing under test rather than of the rule, so the two can be compared instead of assumed equal.
 */
const readModelStatesBasis = (row) => Object.prototype.hasOwnProperty.call(row, 'baseCurrency');

const has = (row, key) => Object.prototype.hasOwnProperty.call(row, key);

test('a posted FOREIGN entry names its currency and reports the base total the LEDGER posted', () => {
  const { store, ctx, accounts } = setup();
  rate(ctx, 'EUR', '0.9412', 'r-eur');
  const entryId = post(ctx, accounts, { key: 'eur', currency: 'EUR' });

  const row = listed(ctx, entryId);
  const ledger = ledgerFigures(store, entryId);

  // The invariant: the read model's figures ARE the posted rows' figures. Not close to them, not
  // recomputable from them, equal to them.
  assert.equal(row.currency, ledger.currency, 'the total is denominated in the currency the rows carry');
  assert.equal(row.total, ledger.debitTotal, 'the transaction total is still the posted debits');
  assert.equal(row.baseTotal, ledger.baseDebitTotal, 'the base total must equal the posted base debits');
  assert.equal(row.fxRate, ledger.rate, 'the rate must be the rate stamped on the posted rows');
  assert.equal(row.baseCurrency, 'CHF', 'the base figure is denominated, never a bare number');

  // A CONVERTED figure, not a copy of the transaction total under a different name. Without this an
  // implementation that set baseTotal = total would satisfy every assertion above in a CHF book.
  assert.notEqual(row.baseTotal, row.total, 'EUR 1000.00 at 0.9412 is not CHF 1000.00');
  assert.equal(readModelStatesBasis(row), ledger.rate !== null, 'the read model states a basis iff the ledger did');
});

test('a BASE-currency entry names its currency and states no basis, because it converted nothing', () => {
  const { store, ctx, accounts } = setup();
  const entryId = post(ctx, accounts, { key: 'chf' });

  const row = listed(ctx, entryId);
  const ledger = ledgerFigures(store, entryId);

  assert.equal(ledger.rate, null, 'the ledger stamped no rate on a base-currency posting');
  assert.equal(readModelStatesBasis(row), false, 'the read model must not invent a basis the ledger declined to state');

  // The currency is still reported, and that is the whole point of the change: the total has to be
  // LABELLED even when there is nothing to convert. What is conditional is the FX group, never the
  // unit of the number beside it.
  assert.equal(row.currency, 'CHF', 'the label is unconditional: a total nobody can denominate is a bare integer');
  assert.equal(row.total, ledger.debitTotal);

  // Absent, not null-shaped. A CHF entry restating its own total as a "base total" under an identical
  // `baseCurrency` is noise on the overwhelming majority of entries, and it is the same mistake as
  // stamping a literal rate of 1 on every franc row: the arithmetic survives, the disclosure stops
  // meaning anything.
  assert.equal(has(row, 'baseTotal'), false, 'a base-currency entry reports no separate base total');
  assert.equal(has(row, 'fxRate'), false);
  assert.equal(has(row, 'baseCurrency'), false);
  assert.equal(row.total, ledger.baseDebitTotal, 'the transaction total already IS the base total');
});

test('a foreign entry pegged at exactly 1 still states its basis, because it converted', () => {
  const { store, ctx, accounts } = setup();
  // Parity is a rate, not the absence of one (§H-FX, docs/specs/03-fx-foundation.md section 13).
  rate(ctx, 'USD', '1', 'r-usd');
  const entryId = post(ctx, accounts, { key: 'usd', currency: 'USD', amount: 7000 });

  const row = listed(ctx, entryId);
  const ledger = ledgerFigures(store, entryId);

  assert.equal(ledger.rate, '1', 'A02 stamps the basis even at parity');
  assert.equal(row.fxRate, '1');
  assert.equal(row.currency, 'USD');
  assert.equal(row.baseCurrency, 'CHF');
  // The two figures coincide, which is exactly why the RATE and the CURRENCY have to be stated
  // separately: a reader comparing only the numbers could not tell this apart from a CHF entry.
  assert.equal(row.baseTotal, row.total, 'at parity the figures coincide');
  assert.equal(row.baseTotal, ledger.baseDebitTotal);
  assert.equal(readModelStatesBasis(row), true, 'a foreign entry states a basis even when the rate is 1');
});

test('an entry with NO lines claims no currency at all, rather than guessing the base one', () => {
  const { store, ctx } = setup();
  const draft = saveDraft(ctx, { date: DATE, idempotencyKey: 'empty', lines: [] });
  assert.ok(draft.ok, JSON.stringify(draft));

  const row = listed(ctx, draft.entryId);
  const ledger = ledgerFigures(store, draft.entryId);

  assert.equal(ledger.rows.length, 0, 'the entry really has no lines');
  assert.equal(row.total, 0, 'a header with no lines totals 0');
  // Null, not 'CHF'. There is no row to read a currency off, so reporting one would be the engine
  // making the same guess the Studio was refusing to make. A denominated zero is a claim.
  assert.equal(row.currency, null, 'a currency is a property of the ROWS, and there are none');
  assert.equal(readModelStatesBasis(row), false);
});

test('a DRAFT is labelled but reports no base total, because nothing has been converted yet', () => {
  const { store, ctx, accounts } = setup();
  const draft = saveDraft(ctx, {
    date: DATE,
    idempotencyKey: 'draft',
    lines: [{ account: accounts['6500'], debit: 4200 }],
  });
  assert.ok(draft.ok, JSON.stringify(draft));

  const row = listed(ctx, draft.entryId);
  const ledger = ledgerFigures(store, draft.entryId);

  assert.equal(row.currency, ledger.currency, 'a draft total is labelled from its own rows like any other');
  assert.equal(row.total, 4200);
  assert.equal(ledger.rate, null, 'a draft has no rate: nothing has posted');
  // `saveDraft` writes base_debit_minor as a literal COPY of debit_minor with no rate behind it.
  // Summing that and calling it a base total would report a conversion that never happened, so the
  // figures are fenced to POSTED entries even though the label is not.
  assert.equal(ledger.baseDebitTotal, 4200, 'the draft row copies the transaction amount into the base column');
  assert.equal(has(row, 'baseTotal'), false, 'a base-currency draft states nothing to convert');
});

test('a FOREIGN entry that has not posted reports its base currency with both figures null', () => {
  const { store, ctx, accounts, workspaceId } = setup();
  // The third arm: `baseCurrency` present while both figures are null, the same arm `mapDocument`
  // has. It used to be reachable through a DEFECT, and that defect is now fixed: `saveDraft` stamped
  // the literal 'CHF' instead of `baseCurrencyOf(ctx)`, so every draft in a non-CHF book claimed to
  // be foreign (see `test/ledger/draft-base-currency.test.mjs`).
  //
  // With that fixed, NO sequence of verbs reaches this arm. The only two statements that insert into
  // `journal_line` are `saveDraft`, which now always writes the base currency, and
  // `writePostedEntry`, which flips the entry to `posted` in the same transaction. So a foreign row
  // on a draft entry is not a state the engine can commit.
  //
  // The arm is still asserted, because the read model still emits this shape for such a row and a
  // client keyed on `baseCurrency` alone renders "EUR 0.00" for a figure the books never held. So
  // the row state is built deliberately: everything is engine-made except the line's currency, which
  // is moved off the base by hand. The entry is a draft, so the immutability trigger cannot be
  // involved. Without the `status = 'posted'` fence the read model would sum this draft's
  // `base_debit_minor` (a literal copy of `debit_minor`, written with no rate behind it) and report
  // a conversion that never happened, at a rate it could not name.
  store.db.prepare('UPDATE workspace SET base_currency = ? WHERE id = ?').run('EUR', workspaceId);
  const draft = saveDraft(ctx, {
    date: DATE,
    idempotencyKey: 'foreign-draft',
    lines: [{ account: accounts['6500'], debit: 4200 }],
  });
  assert.ok(draft.ok, JSON.stringify(draft));
  assert.equal(
    ledgerFigures(store, draft.entryId).currency,
    'EUR',
    'the draft starts in the base currency, which is the fixed behaviour this arm is built on top of',
  );
  store.db.prepare('UPDATE journal_line SET currency = ? WHERE entry_id = ?').run('CHF', draft.entryId);

  const row = listed(ctx, draft.entryId);
  const ledger = ledgerFigures(store, draft.entryId);

  assert.equal(ledger.currency, 'CHF', 'the row carries a currency the book is not kept in');
  assert.equal(row.currency, 'CHF', 'the read model reports the rows, never a correction of them');
  assert.equal(readModelStatesBasis(row), true, 'CHF in a EUR book states a basis, by the one predicate');
  assert.equal(row.baseCurrency, 'EUR', 'the books are kept in EUR and say so before anything posts');
  assert.equal(row.baseTotal, null, 'nothing posted, so there is no converted figure to report');
  assert.equal(row.fxRate, null, 'and no rate was stamped to report it at');
  assert.equal(ledger.baseDebitTotal, 4200, 'the draft row DOES hold a base figure, and it is a copy, not a conversion');
  assert.notEqual(row.baseTotal, ledger.baseDebitTotal, 'which is exactly the figure the fence refuses to report');
});

test('the read model keeps the LEDGER rate after the rate store moves under it (no re-resolution)', () => {
  const { store, ctx, accounts } = setup();
  rate(ctx, 'EUR', '0.9412', 'r-eur');
  const entryId = post(ctx, accounts, { key: 'eur', currency: 'EUR' });

  const before = listed(ctx, entryId);
  const ledgerBefore = ledgerFigures(store, entryId);

  // A rate recorded AFTER the entry posted, valid ON the entry date, from a different provenance so
  // the store accepts it beside the manual one. This is not exotic: it is exactly what importing a
  // BAZG feed does. An implementation that re-resolved at read time, or that recomputed the base
  // total from a freshly resolved rate, could now report a figure the books never posted.
  rate(ctx, 'EUR', '0.5', 'r-eur-2', 'rate_api');

  const after = listed(ctx, entryId);
  const ledgerAfter = ledgerFigures(store, entryId);
  assert.equal(ledgerAfter.rate, ledgerBefore.rate, 'the posted rows are immutable: the ledger did not move');
  assert.equal(after.fxRate, ledgerAfter.rate, 'the read model followed the ledger, not the rate store');
  assert.equal(after.baseTotal, ledgerAfter.baseDebitTotal, 'the base total followed the ledger too');
  assert.equal(after.baseTotal, before.baseTotal);
  assert.notEqual(after.fxRate, '0.5', 'the newer rate must not reprice a posted entry');
});

test('the base total is the LEDGER base total, NOT the transaction total multiplied by the rate', () => {
  const { store, ctx, accounts } = setup();
  // EUR 1.00 at 1.005. The ledger converts in exact scaled integers and rounds half away from zero,
  // so it posts CHF 1.01. A client that took the honest-looking shortcut and computed the figure
  // itself would print CHF 1.00: `100 * 1.005` is 100.49999999999999 in binary floating point, which
  // rounds DOWN. One Rappen, on a path where the whole point is that the numbers agree with the
  // books. This is why the engine sends the figure and the client never derives it.
  rate(ctx, 'EUR', '1.005', 'r-eur');
  const entryId = post(ctx, accounts, { key: 'eur', currency: 'EUR', amount: 100 });

  const row = listed(ctx, entryId);
  const ledger = ledgerFigures(store, entryId);

  assert.equal(row.baseTotal, ledger.baseDebitTotal, 'the read model reports what the rows hold');
  assert.equal(ledger.baseDebitTotal, 101, 'the ledger rounds half away from zero, in exact integers');
  assert.equal(Math.round(num(row.total, 'list_journal.total') * Number(row.fxRate)), 100, 'the float shortcut lands a Rappen low');
  assert.notEqual(
    row.baseTotal,
    Math.round(num(row.total, 'list_journal.total') * Number(row.fxRate)),
    'a client deriving the base figure from the rate would disagree with the books',
  );
});

test('ONE currency per entry: every row of every entry these suites write agrees', () => {
  const { store, ctx, accounts } = setup();
  rate(ctx, 'EUR', '0.9412', 'r-eur');
  rate(ctx, 'USD', '1', 'r-usd');
  post(ctx, accounts, { key: 'chf' });
  post(ctx, accounts, { key: 'eur', currency: 'EUR' });
  post(ctx, accounts, { key: 'usd', currency: 'USD', amount: 7000 });
  // A per-LINE currency is not part of `LineInput`. Passing one is ignored, and `writePostedEntry`
  // stamps the ENTRY currency on every row: a mixed entry is not representable, by construction.
  //
  // "Not part of `LineInput`" is now stated twice, and the second statement is the stronger one.
  // The directives below make the compiler agree that these properties do not exist, so the day
  // `LineInput` grows a `currency` they go unused, TS2578 fails the build, and the sentence above
  // has to be rewritten by whoever made it false. `src/core/ledger/draft.ts` says the same thing in
  // prose; this is the version that cannot go stale quietly.
  const mixed = postEntry(ctx, {
    date: DATE,
    source: 'manual',
    idempotencyKey: 'mixed-attempt',
    currency: 'EUR',
    lines: [
      // @ts-expect-error a per-line `currency` is not in `LineInput`, which is the point of the test
      { account: accounts['6500'], debit: 5000, currency: 'CHF' },
      // @ts-expect-error same again on the credit leg, so both halves of the mix are refused
      { account: accounts['1000'], credit: 5000, currency: 'USD' },
    ],
  });
  assert.ok(mixed.ok, JSON.stringify(mixed));

  const disagreements = store.db
    .prepare(
      `SELECT entry_id, COUNT(DISTINCT currency) AS currencies, COUNT(DISTINCT IFNULL(fx_rate, '')) AS rates
         FROM journal_line GROUP BY entry_id HAVING currencies > 1 OR rates > 1`,
    )
    .all();
  assert.deepEqual(disagreements, [], 'no entry may carry two currencies or two rates');

  const mixedRows = ledgerFigures(store, mixed.entryId);
  assert.equal(mixedRows.currency, 'EUR', 'the ENTRY currency wins on every row, including the ignored per-line one');
  assert.equal(listed(ctx, mixed.entryId).currency, 'EUR');
});

test('the list and get_entry agree about the currency, so the drawer never contradicts the row', () => {
  const { ctx, accounts } = setup();
  rate(ctx, 'EUR', '0.9412', 'r-eur');
  const entryId = post(ctx, accounts, { key: 'eur', currency: 'EUR' });

  const row = listed(ctx, entryId);
  const detail = okOf(getEntry(ctx, { entryId }), 'getEntry');
  for (const line of objs(detail.lines, 'getEntry.lines')) {
    assert.equal(line.currency, row.currency, 'the row label and the drawer lines name the same currency');
    assert.equal(line.fxRate, row.fxRate, 'and the same rate');
  }
});

test('MCP: an AGENT calling list_journal through the registry gets the same currency and figures', () => {
  const { store, ctx, accounts, workspaceId } = setup();
  rate(ctx, 'EUR', '0.9412', 'r-eur');
  const entryId = post(ctx, accounts, { key: 'eur', currency: 'EUR' });

  // The GUI is one client of this verb, not the reason the field exists (MCP-first). An agent
  // reading the journal must be able to denominate the totals it reads without a second call.
  const res = okOf(defined(getAction('list_journal'), "the 'list_journal' action").run(ctx, { workspaceId }), 'list_journal');
  const row = obj(
    objs(res.entries, 'list_journal.entries').find((e) => e.id === entryId),
    'the entry list_journal reports',
  );
  const ledger = ledgerFigures(store, entryId);
  assert.equal(row.currency, ledger.currency);
  assert.equal(row.baseTotal, ledger.baseDebitTotal);
  assert.equal(row.fxRate, ledger.rate);
  assert.equal(row.baseCurrency, 'CHF');
});

test('the FX group is gated on statesConversionBasis itself, not on a second copy of the rule', () => {
  const { store, ctx, accounts } = setup();
  rate(ctx, 'EUR', '0.9412', 'r-eur');
  rate(ctx, 'USD', '1', 'r-usd');
  const ids = [
    post(ctx, accounts, { key: 'chf' }),
    post(ctx, accounts, { key: 'eur', currency: 'EUR' }),
    post(ctx, accounts, { key: 'usd', currency: 'USD', amount: 7000 }),
    id(saveDraft(ctx, { date: DATE, idempotencyKey: 'd', lines: [{ account: accounts['6500'], debit: 900 }] }), 'entryId', 'saveDraft'),
  ];

  // The governing property, held in EVERY arm: the read model states a basis if and only if the
  // predicate says the entry has one to state. Asserting `fxRate === '0.9412'` on the EUR arm alone
  // would merely describe the fix; this also fails an implementation that reports a basis on every
  // franc entry, or that goes quiet on a pegged foreign one.
  const baseCurrency = strCol(
    store.db.prepare('SELECT base_currency FROM workspace WHERE id = ?').get('ws_1'),
    'base_currency',
    'the workspace row',
  );
  for (const entryId of ids) {
    const row = listed(ctx, entryId);
    const expected =
      row.currency !== null && statesConversionBasis({ currency: str(row.currency, 'list_journal.currency'), baseCurrency });
    assert.equal(readModelStatesBasis(row), expected, `${entryId}: the gate and the predicate disagree`);
  }
});
