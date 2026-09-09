// @ts-check
// A03 `close_year` names the currency of the figure it returns.
//
// THE GAP THIS CLOSES. `hardCloseYear` swept `SUM(base_debit_minor - base_credit_minor)` over the P&L
// accounts and handed back `result` with nothing saying what unit that was in. It is the workspace
// BASE currency by construction, and a workspace's base currency is a setting rather than a synonym
// for CHF (`workspace.base_currency`, and CURRENCIES admits CHF, EUR and USD). So every caller that
// wanted to print the number had to go and read `get_company_profile` for its name, or guess. Guessing
// is how `Total MWST CHF 81.00` reached a EUR document whose true franc VAT was 76.24.
//
// This is the third of the same kind: `get_document` gained `baseCurrency`, `get_entry` is gaining the
// currency of its base figures, and this is the close.
//
// HOW IT IS PROVED. Not by comparing the return value against a literal a test author typed. Every
// assertion below is anchored in rows read back OUT of SQLite after the close has posted:
//
//   * the reported currency must equal `workspace.base_currency` as stored;
//   * it must NOT equal the transaction currency stamped on the posted `journal_line` rows the
//     movement actually arrived in, which is the mislabel this exists to make impossible;
//   * the figure it labels must equal the sweep recomputed from the posted rows themselves; and
//   * it must equal the currency the ledger DENOMINATED THE CLOSING ENTRY IN, which is the strongest
//     of the four: the verb's answer and the posted evidence are then the same fact, not two.
//
// The workspace is EUR-based and the movement arrives in USD at 0.86, so the transaction figure and
// the base figure differ in BOTH the number and the unit (USD 1'000.00 books EUR 860.00). A CHF book
// would prove nothing here, because CHF is exactly what a guessing caller would have said anyway.

import test from 'node:test';
import assert from 'node:assert/strict';

import { postEntry, hardCloseYear } from '../../dist/core/ledger/index.js';
import { recordExchangeRate } from '../../dist/core/fx/index.js';
import { getAction } from '../../dist/api/registry.js';
import { setup, entry } from './a03-support.mjs';
import { defined, numCol, objs, strCol } from '../support/narrow.mjs';

const YEAR = 2026;
const FROM = '2026-01-01';
const TO = '2026-12-31';

/** An EUR-based book with a USD rate recorded, and one USD sale plus one USD cost posted into 2026. */
function eurBookWithUsdMovement() {
  const s = setup({ baseCurrency: 'EUR' });
  const { ctx, byNumber } = s;
  // Both postings sit inside the rate's freshness window on purpose: A19 refuses to price a posting
  // off a stale quote, and a suite about LABELLING a figure should not be the one arguing about that.
  const rate = recordExchangeRate(ctx, {
    baseCurrency: 'USD', // the pair's base side: 1 USD = 0.86 EUR, EUR being the book's own currency
    rate: '0.86',
    asOf: '2026-05-01',
    source: 'manual',
    idempotencyKey: 'fx-usd',
  });
  assert.ok(rate.ok, JSON.stringify(rate));

  // USD 1'000.00 of revenue and USD 400.00 of cost => a USD 600.00 result, booked as EUR 516.00.
  const sale = postEntry(ctx, {
    ...entry(byNumber, { debitNo: '1020', creditNo: '3000', amount: 100_000, date: '2026-05-02', idempotencyKey: 'p1' }),
    currency: 'USD',
  });
  assert.ok(sale.ok, JSON.stringify(sale));
  const cost = postEntry(ctx, {
    ...entry(byNumber, { debitNo: '6500', creditNo: '1020', amount: 40_000, date: '2026-05-05', idempotencyKey: 'p2' }),
    currency: 'USD',
  });
  assert.ok(cost.ok, JSON.stringify(cost));
  return s;
}

/** The P&L sweep, recomputed from the POSTED rows. `result` is the negative of the swept net. */
function resultFromPostedRows(store, workspaceId) {
  return store.db
    .prepare(
      `SELECT COALESCE(SUM(l.base_credit_minor - l.base_debit_minor), 0) AS result
         FROM journal_line l
         JOIN journal_entry e ON e.id = l.entry_id
         JOIN account a ON a.id = l.account_id
        WHERE e.workspace_id = ? AND e.status = 'posted' AND e.source != 'close'
          AND e.date >= ? AND e.date <= ?
          AND a.type IN ('income', 'expense')`,
    )
    .get(workspaceId, FROM, TO).result;
}

/** Every distinct `currency` stamped on the posted lines of one entry. */
function currenciesOfPostedEntry(store, entryId) {
  return store.db
    .prepare(
      `SELECT DISTINCT l.currency AS currency
         FROM journal_line l JOIN journal_entry e ON e.id = l.entry_id
        WHERE e.id = ? AND e.status = 'posted'
        ORDER BY l.currency`,
    )
    .all(entryId)
    .map((r) => r.currency);
}

test('close_year names the currency of its result, and it is the workspace base read back from SQLite', () => {
  const { ctx, store, workspaceId } = eurBookWithUsdMovement();

  const closed = hardCloseYear(ctx, { year: YEAR, idempotencyKey: 'close-2026' });
  assert.equal(closed.ok, true, JSON.stringify(closed));

  // 1. The stored setting, not a literal. If someone changes A00's default this test still asks the
  //    right question, and it fails loudly rather than agreeing with a new wrong answer.
  const stored = strCol(
    store.db.prepare('SELECT base_currency FROM workspace WHERE id = ?').get(workspaceId),
    'base_currency',
    'the workspace row',
  );
  assert.equal(stored, 'EUR', 'the fixture must really be a non-Swiss book, or nothing below discriminates');
  assert.equal(closed.baseCurrency, stored, 'close_year must report the currency its result is denominated in');

  // 2. And it is NOT the currency the movement arrived in. This is the whole defect in one line: a
  //    caller with only `result` in hand cannot tell EUR 860.00 from the USD 1'000.00 it came from.
  const txnCurrencyRows = store.db
    .prepare(
      `SELECT DISTINCT l.currency AS currency
         FROM journal_line l JOIN journal_entry e ON e.id = l.entry_id
        WHERE e.workspace_id = ? AND e.status = 'posted' AND e.source = 'manual'`,
    )
    .all(workspaceId);
  const txnCurrencies = objs(txnCurrencyRows, 'posted manual lines').map((r) => r.currency);
  assert.deepEqual(txnCurrencies, ['USD'], 'the posted movement must really be foreign');
  assert.notEqual(closed.baseCurrency, 'USD', 'the base currency is never the transaction currency it converted from');
});

test('the figure that currency labels is the sweep recomputed from the posted rows', () => {
  const { ctx, store, workspaceId } = eurBookWithUsdMovement();

  const closed = hardCloseYear(ctx, { year: YEAR, idempotencyKey: 'close-2026' });
  assert.equal(closed.ok, true, JSON.stringify(closed));

  const fromRows = resultFromPostedRows(store, workspaceId);
  assert.equal(fromRows, 51_600, 'EUR 516.00: USD 600.00 at 0.86, which the ledger stored as base Rappen');
  assert.equal(closed.result, fromRows, 'the reported result must be the base sweep the rows hold');
  assert.notEqual(closed.result, 60_000, 'and never the USD 600.00 it was converted from');
});

test('the reported currency is the one the ledger DENOMINATED THE CLOSING ENTRY IN', () => {
  const { ctx, store } = eurBookWithUsdMovement();

  const closed = hardCloseYear(ctx, { year: YEAR, idempotencyKey: 'close-2026' });
  assert.equal(closed.ok, true, JSON.stringify(closed));

  // The close posts through A02 with no `currency`, so postEntry stamps the workspace base on every
  // row. Reading it back makes the verb's answer and the posted evidence one fact instead of two: if
  // they ever disagreed, the number on screen would be labelled with a unit the books do not hold.
  assert.deepEqual(currenciesOfPostedEntry(store, closed.closingEntryId), [closed.baseCurrency]);
  assert.deepEqual(currenciesOfPostedEntry(store, closed.carryEntryId), [closed.baseCurrency]);
});

test('the idempotent REPLAY carries the currency too, so a retry is not a worse answer', () => {
  const { ctx, store, workspaceId } = eurBookWithUsdMovement();

  const first = hardCloseYear(ctx, { year: YEAR, idempotencyKey: 'close-2026' });
  assert.equal(first.ok, true, JSON.stringify(first));
  const replayed = hardCloseYear(ctx, { year: YEAR, idempotencyKey: 'close-2026' });

  // The replay comes back out of the idempotency store, so it is a serialised snapshot rather than a
  // fresh computation: a field that survives the round trip has to be IN the remembered value.
  assert.deepEqual(replayed, first, 'a replay is the original answer, currency and all');
  assert.equal(
    replayed.baseCurrency,
    strCol(
      store.db.prepare('SELECT base_currency FROM workspace WHERE id = ?').get(workspaceId),
      'base_currency',
      'the workspace row',
    ),
  );

  // And the replay did not post a second close: the books still hold exactly one closing entry.
  const closeEntries = numCol(
    store.db
      .prepare("SELECT COUNT(*) AS c FROM journal_entry WHERE workspace_id = ? AND source = 'close' AND status = 'posted'")
      .get(workspaceId),
    'c',
    'posted close entries',
  );
  assert.equal(closeEntries, 2, 'one P&L close and one carry, posted once between them');
});

test('the currency is unconditional: a CHF book gets it too, and a year with no movement still gets it', () => {
  // Unlike `get_document`, where a base figure beside an identical currency would be noise on every
  // domestic row, `result` is a single number with no transaction twin beside it. There is no reading
  // of it that does not need a unit, so the field is never omitted.
  const chf = setup();
  const chfClose = hardCloseYear(chf.ctx, { year: YEAR, idempotencyKey: 'close-chf' });
  assert.equal(chfClose.ok, true, JSON.stringify(chfClose));
  assert.equal(chfClose.result, 0, 'nothing was posted, so the year closes at zero');
  assert.equal(chfClose.closingEntryId, null, 'and no closing entry was needed');
  assert.equal(
    chfClose.baseCurrency,
    strCol(
      chf.store.db.prepare('SELECT base_currency FROM workspace WHERE id = ?').get(chf.workspaceId),
      'base_currency',
      'the CHF workspace row',
    ),
  );

  // Same through the MCP verb, because MCP-first means the agent surface is the contract and not a
  // second-class view of it. A field the GUI can reach and an agent cannot is not shipped.
  const viaVerb = defined(getAction('close_year'), "the 'close_year' action").run(chf.ctx, {
    workspaceId: chf.workspaceId,
    year: '2025',
    idempotencyKey: 'close-chf-2025',
  });
  assert.equal(viaVerb.ok, true, JSON.stringify(viaVerb));
  assert.equal(viaVerb.baseCurrency, 'CHF');
});
