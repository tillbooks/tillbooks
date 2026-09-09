// @ts-check
// A02 §H-FX: a DRAFT line is denominated in the workspace BASE currency.
//
// `saveDraft` wrote the literal `'CHF'` into `journal_line.currency`. `workspace.base_currency` is a
// real column with a real accessor (`baseCurrencyOf`), so in a EUR-based workspace every draft line
// claimed to be in francs. Two things go wrong at once, and the second is the worse one:
//
//  1. The label is simply false. `list_journal` now reports `currency` straight off the rows, so the
//     Studio and any agent read "CHF 50.00" for money nobody entered in francs.
//  2. The row states a conversion basis it does not hold. A draft carries a NULL `fx_rate` (nothing
//     is converted until posting), which is honest ONLY on a row whose currency IS the base. A `CHF`
//     row in a EUR workspace reads as foreign to `statesConversionBasis`, so it claims a conversion
//     happened and then declines to say on what basis: the exact shape `postEntry` refuses to write
//     (docs/specs/03-fx-foundation.md section 9), arrived at from the other direction.
//
// These suites assert against rows read back out of SQLite, never against a return value, and the
// promotion test states the invariant as an EQUALITY between the two write paths rather than as the
// literal a fix happens to use.

import test from 'node:test';
import assert from 'node:assert/strict';

import { postEntry, saveDraft } from '../../dist/core/ledger/index.js';
import { statesConversionBasis } from '../../dist/core/ledger/postEntry.js';
import { baseCurrencyOf } from '../../dist/core/fx/rates.js';
import { setup } from './support.mjs';
import { id } from '../support/narrow.mjs';

/** `setup()` seeds a CHF workspace. The base currency is a COLUMN, so a real workspace may differ. */
function eurSetup() {
  const env = setup();
  env.store.db.prepare('UPDATE workspace SET base_currency = ? WHERE id = ?').run('EUR', env.workspaceId);
  return env;
}

const twoLines = (accounts, amt = 5000) => [
  { account: accounts['6500'], debit: amt },
  { account: accounts['1000'], credit: amt },
];

const lineRows = (store, entryId) =>
  store.db
    .prepare(
      `SELECT currency, fx_rate, debit_minor, credit_minor, base_debit_minor, base_credit_minor
         FROM journal_line WHERE entry_id = ? ORDER BY id`,
    )
    .all(entryId);

test('a draft line is denominated in the workspace base currency, not the literal CHF', () => {
  const { ctx, store, accounts } = eurSetup();
  const base = baseCurrencyOf(ctx);
  assert.equal(base, 'EUR', 'fixture guard: this workspace must not be CHF-based');

  const draft = saveDraft(ctx, {
    date: '2026-03-01',
    description: 'Büromaterial',
    idempotencyKey: 'd1',
    lines: twoLines(accounts),
  });
  assert.equal(draft.ok, true);

  const rows = lineRows(store, draft.entryId);
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.currency, base);
  }
});

test('a draft states no conversion basis, which is what its NULL rate is honest about', () => {
  const { ctx, store, accounts } = eurSetup();
  const baseCurrency = baseCurrencyOf(ctx);

  const draft = saveDraft(ctx, {
    date: '2026-03-01',
    idempotencyKey: 'd1',
    lines: twoLines(accounts),
  });

  for (const row of lineRows(store, draft.entryId)) {
    // The invariant, not the fix: a row may carry a NULL rate only while it states no basis. A02's
    // predicate decides that, imported rather than re-derived, so this cannot drift from the posting
    // path's reading of the same rule.
    assert.equal(
      statesConversionBasis({ currency: row.currency, baseCurrency }),
      false,
      `a draft line must not claim a conversion basis (currency ${row.currency}, base ${baseCurrency})`,
    );
    assert.equal(row.fx_rate, null);
    // Nothing was converted, so the base amounts are the transaction amounts. Stated here because it
    // is the other half of "this row states no basis": the two must agree or the row is incoherent.
    assert.equal(row.base_debit_minor, row.debit_minor);
    assert.equal(row.base_credit_minor, row.credit_minor);
  }
});

test('a draft is denominated in what promoting it will write, so promotion relabels nothing', () => {
  const { ctx, store, accounts } = eurSetup();

  const draft = saveDraft(ctx, {
    date: '2026-03-01',
    description: 'idea',
    idempotencyKey: 'd1',
    lines: twoLines(accounts),
  });
  const draftCurrencies = lineRows(store, draft.entryId).map((r) => r.currency);

  // Promotion in place, stating no currency: the only thing `SaveDraftInput` can express, and what
  // `postEntry` resolves to the base currency.
  const posted = postEntry(ctx, {
    entryId: id(draft, 'entryId', 'saveDraft'),
    date: '2026-03-01',
    description: 'idea',
    source: 'manual',
    idempotencyKey: 'p1',
    lines: twoLines(accounts),
  });
  assert.equal(posted.ok, true);

  const postedCurrencies = lineRows(store, draft.entryId).map((r) => r.currency);
  assert.deepEqual(
    draftCurrencies,
    postedCurrencies,
    'the money did not change currency by being posted: the draft was mislabelled',
  );
});

test('re-saving an existing draft rewrites its lines in the base currency too', () => {
  const { ctx, store, accounts } = eurSetup();
  const base = baseCurrencyOf(ctx);

  const draft = saveDraft(ctx, {
    date: '2026-03-01',
    idempotencyKey: 'd1',
    lines: twoLines(accounts),
  });
  // The UPDATE arm: `saveDraft` deletes the line set and inserts a fresh one, a second write site for
  // the same literal.
  const again = saveDraft(ctx, {
    entryId: id(draft, 'entryId', 'saveDraft'),
    date: '2026-03-02',
    idempotencyKey: 'd2',
    lines: twoLines(accounts, 7500),
  });
  assert.equal(again.ok, true);

  const rows = lineRows(store, draft.entryId);
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.currency, base);
    assert.equal(row.debit_minor + row.credit_minor, 7500);
  }
});

test('a CHF workspace still stores CHF: the fix reads the column, it does not invert the literal', () => {
  const { ctx, store, accounts } = setup();
  assert.equal(baseCurrencyOf(ctx), 'CHF');

  const draft = saveDraft(ctx, {
    date: '2026-03-01',
    idempotencyKey: 'd1',
    lines: twoLines(accounts),
  });
  for (const row of lineRows(store, draft.entryId)) {
    assert.equal(row.currency, 'CHF');
  }
});
