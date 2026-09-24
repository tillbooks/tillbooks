/**
 * `formatMoney(minor, currency = 'CHF')`: the default that mislabels money, and what the engine
 * actually sends so the Studio never has to reach for it.
 *
 * THE DEFECT THIS EXISTS FOR. The VAT panel rendered `Total MWST CHF 81.00` on a EUR document whose
 * true franc VAT was 76.24: wrong in both currencies, on the screen a person reads before filing a
 * VAT return. It was invisible on CHF documents, which is why it survived to a posted record. The
 * cause is one defaulted parameter, and the same trap was still armed at seven more call sites in
 * `EntryDrawer.tsx` and `Periods.tsx`.
 *
 * A workspace's base currency is a SETTING, not a synonym for CHF (`workspace.base_currency`, and
 * `CURRENCIES` admits CHF, EUR and USD). So "it defaults to CHF and the books are Swiss" is not a
 * defence: this file builds a EUR-base workspace, posts one USD entry into it, and pins the three
 * engine answers those seven call sites render, so the app suite asserts over what the engine sends
 * rather than over numbers a test author typed.
 *
 * The scenario is chosen so a mislabel is impossible to miss. USD 1'000.00 at 0.86 books EUR 860.00,
 * so the two figures differ in BOTH the number and the unit, and the CHF default gets each of them
 * wrong at once: `CHF 1'000.00` for a USD amount, `CHF 860.00` for a EUR one.
 *
 * Two of these tests were written as GAPS rather than guarantees, deliberately, so that the day the
 * engine grew the missing field the test would go RED and be the reminder to RENDER it rather than
 * keep paying for a second read. BOTH have now fired and BOTH are closed, each by a different agent
 * working in parallel, which is the mechanism working rather than failing:
 *
 *   - `get_entry` now denominates BOTH pairs: `currency` names the transaction amounts and
 *     `baseCurrency` names `baseDebit` / `baseCredit`. It rides the LINE, because the figure it
 *     denominates does (`src/core/ledger/reads.ts`, `mapLine`; `test/ledger/get-entry-base-currency.test.mjs`
 *     holds the engine side up against SQLite rows).
 *   - `close_year` returns `result` swept from `base_debit_minor - base_credit_minor`, so it is a
 *     base-currency figure by construction, and it now NAMES that currency: `baseCurrency`,
 *     unconditional, because `result` has no transaction twin beside it and so has no rendering that
 *     does not need a unit (`test/ledger/year-close-currency.test.mjs`).
 *
 * Both tests below assert presence and value where they used to assert absence.
 *
 * What FOLLOWS from that is a Studio change neither engine agent made: the Journal drawer no longer
 * needs its second read, and `app/src/surfaces/Periods/**` still reads `get_company_profile` purely
 * to label this figure and holds it back until that read settles. That workaround is now paying for
 * a gap that is closed.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { makeContext } from '../../dist/core/context.js';
import { fixedClock } from '../../dist/core/clock.js';
import { sequenceIdGen } from '../../dist/core/ids.js';
import { createWorkspace } from '../../dist/core/setup/index.js';
import { seedChartOfAccounts, listAccounts } from '../../dist/core/accounts/index.js';
import { recordExchangeRate } from '../../dist/core/fx/index.js';
import { getAction } from '../../dist/api/registry.js';

const FIXTURE_PATH = new URL('../../app/src/i18n/format-money-currency.fixture.json', import.meta.url);
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));

const AT = '2026-07-16T00:00:00.000Z';

/** A EUR-base workspace with a seeded chart and a USD rate recorded. Nothing posted yet. */
function setup() {
  const clock = fixedClock(AT);
  const ids = sequenceIdGen();
  const store = new SqliteStore({ clock });
  const { workspaceId } = createWorkspace(
    { store, clock, ids },
    { name: 'Nomadik GmbH', baseCurrency: fixture.baseCurrency },
  );
  const ctx = makeContext(store, { workspaceId, actor: 'user_1', clock, ids });
  seedChartOfAccounts(ctx, {});
  const accounts = listAccounts(ctx, {});
  assert.ok(accounts.ok, JSON.stringify(accounts));
  const byNumber = new Map(accounts.accounts.map((a) => [a.number, a.id]));
  const rate = recordExchangeRate(ctx, {
    baseCurrency: fixture.transactionCurrency,
    rate: fixture.fxRate,
    asOf: '2026-07-15',
    source: 'manual',
    idempotencyKey: 'fx-usd',
  });
  assert.ok(rate.ok, JSON.stringify(rate));
  return { ctx, store, workspaceId, byNumber };
}

/** Post the exact USD entry the fixture describes: bank against revenue, one currency, one rate. */
function postFixtureEntry(ctx, workspaceId, byNumber) {
  const posted = getAction('post_entry').run(ctx, {
    workspaceId,
    date: fixture.entry.date,
    ref: fixture.entry.ref,
    description: fixture.entry.description,
    currency: fixture.transactionCurrency,
    lines: [
      { account: byNumber.get('1020'), debit: fixture.lines[0].debit },
      { account: byNumber.get('3200'), credit: fixture.lines[1].credit },
    ],
    source: 'manual',
    idempotencyKey: fixture.entry.idempotencyKey,
  });
  assert.ok(posted.ok, JSON.stringify(posted));
  return posted.entryId;
}

test('the profile fixture is the live get_company_profile: a EUR base currency, keys and kinds', () => {
  const { ctx, workspaceId, byNumber } = setup();
  postFixtureEntry(ctx, workspaceId, byNumber);
  const res = getAction('get_company_profile').run(ctx, { workspaceId });
  assert.ok(res.ok, JSON.stringify(res));

  // The whole object, key for key. The Studio reads exactly one field off it, but four defects in
  // this repo shipped from a key the engine never sent, so the shape is pinned rather than the field.
  assert.deepEqual(res.profile, fixture.profile);

  // The one that matters, stated on its own so a rename reads as a rename: the wrapper is
  // `{ok, profile}` and the currency lives INSIDE it, never at `body.baseCurrency`.
  assert.equal(res.profile.baseCurrency, fixture.baseCurrency);
  assert.equal(res.baseCurrency, undefined, 'the base currency is never at the top level of the body');
  assert.notEqual(fixture.baseCurrency, 'CHF', 'the fixture would prove nothing in a CHF workspace');
});

test('the entry fixture is the live get_entry: USD lines, EUR base figures, and BOTH units named', () => {
  const { ctx, workspaceId, byNumber } = setup();
  const entryId = postFixtureEntry(ctx, workspaceId, byNumber);
  const res = getAction('get_entry').run(ctx, { workspaceId, entryId });
  assert.ok(res.ok, JSON.stringify(res));

  assert.deepEqual(res.entry, fixture.entry);
  assert.deepEqual(res.lines, fixture.lines);

  // The property the drawer's two columns turn on: `debit` is the TRANSACTION amount and `currency`
  // denominates it, while `baseDebit` is what the BOOKS hold. Different numbers, different units.
  const [debitLine] = res.lines;
  assert.equal(debitLine.currency, fixture.transactionCurrency);
  assert.equal(debitLine.debit, 100000, 'USD 1000.00, the transaction amount');
  assert.equal(debitLine.baseDebit, 86000, 'EUR 860.00, the booked amount');
  assert.notEqual(debitLine.debit, debitLine.baseDebit, 'one label cannot serve both figures');

  // THE GAP, CLOSED. This block used to assert that `baseCurrency` was absent and to say so was the
  // reason the drawer had to read `get_company_profile` for its FX note. The engine now sends it, so
  // the assertion is inverted rather than deleted: presence AND value, on EVERY line, because a
  // label that is right on the first line and missing on the second is worse than none at all.
  assert.equal(debitLine.baseCurrency, fixture.baseCurrency, 'the base figures are denominated now');
  assert.notEqual(debitLine.baseCurrency, debitLine.currency, 'a USD entry in a EUR book has two units');
  for (const line of res.lines) {
    assert.equal(line.currency, fixture.transactionCurrency, 'every line names its transaction unit');
    assert.equal(line.baseCurrency, fixture.baseCurrency, 'and every line names its base unit');
  }

  // The label rides the LINE, beside the figure it denominates, and there is no workspace-level echo
  // of it: an entry with no lines has no base figure to name, so a top-level field would denominate
  // a zero nobody entered (`test/ledger/get-entry-base-currency.test.mjs` holds that arm).
  assert.equal(res.baseCurrency, undefined, 'the response denominates lines, not the workspace');
});

test('the year-close fixture is the live close_year: a BASE-currency result that NAMES its currency', () => {
  const { ctx, workspaceId, byNumber } = setup();
  postFixtureEntry(ctx, workspaceId, byNumber);
  const res = getAction('close_year').run(ctx, {
    workspaceId,
    year: fixture.entry.date.slice(0, 4),
    idempotencyKey: 'y1',
  });
  assert.ok(res.ok, JSON.stringify(res));

  // The whole body, key for key, the way the profile test pins its object. The fixture was recaptured
  // from this engine rather than hand-edited to match, so a key that appears or vanishes reddens here
  // instead of reaching the Studio as a silent shape change.
  const { ok: _ok, ...body } = res;
  assert.deepEqual(body, fixture.yearClose);

  // The sweep is `SUM(base_debit_minor - base_credit_minor)` over the P&L accounts (yearClose.ts),
  // so the result is a base-currency figure BY CONSTRUCTION and never the transaction one. The USD
  // revenue was 100000; the result is 86000. A Periods panel labelling it CHF is wrong twice.
  assert.equal(res.result, 86000, 'EUR 860.00, the swept base figure');
  assert.notEqual(res.result, 100000, 'the result is never the USD revenue it came from');

  // THE GAP, CLOSED. This asserted the ABSENCE of a currency until the engine grew one, which is what
  // made the absence a decision rather than an oversight. `baseCurrency` is now sent, it is the
  // workspace base and not the transaction currency the movement arrived in, and it agrees with the
  // separate `get_company_profile` read the Studio currently makes to get the same string.
  assert.equal(res.baseCurrency, fixture.baseCurrency, 'close_year must name the currency of its result');
  assert.equal(res.baseCurrency, 'EUR');
  assert.notEqual(res.baseCurrency, fixture.transactionCurrency, 'never the currency the result converted FROM');
  assert.notEqual(res.baseCurrency, 'CHF', 'and a defaulted CHF here would be the original defect relocated');
  assert.equal(
    res.baseCurrency,
    getAction('get_company_profile').run(ctx, { workspaceId }).profile.baseCurrency,
    'the field and the extra read must agree, or dropping the read would change what Periods prints',
  );

  // Only ONE name for it, so a client cannot pick a synonym that later disappears.
  for (const absent of ['currency', 'resultCurrency', 'ledgerCurrency']) {
    assert.equal(res[absent], undefined, `close_year must name its currency once, not also as ${absent}`);
  }
});
