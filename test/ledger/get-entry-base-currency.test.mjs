// @ts-check
/**
 * A02 §H-FX: `get_entry` names the currency of `baseDebit` / `baseCredit`, not just of `debit`.
 *
 * THE GAP THIS EXISTS FOR. Every `get_entry` line already says what `debit` and `credit` are
 * denominated in (`currency`, the TRANSACTION currency). Beside them sit `baseDebit` and
 * `baseCredit`, the figures the BOOKS actually hold, and nothing in the response said what unit
 * those are. A response that carries a figure whose unit is not in the response leaves every client
 * two options and no third: hardcode a currency, or fire a second verb for the label. Both are the
 * client inventing money, and both have already shipped defects in this repo.
 *
 * The live consequence, which is why this is not a tidiness argument: the Journal drawer's
 * `get_company_profile` read sat inside its `editable` branch, so a POSTED entry, the one arm where
 * the FX note renders at all, never asked what the books are kept in and labelled the engine's own
 * base figure from an initial CHF. A EUR-base workspace read "USD 1'000.00 at rate 0.86 is
 * CHF 860.00 in the books" on an immutable record. The drawer is fixed, but the shape that invited
 * it is fixed HERE: the label now travels beside the number it denominates.
 *
 * ## Why the field is UNCONDITIONAL, unlike `list_journal`'s FX group
 *
 * `list_journal` gates `baseTotal` / `fxRate` / `baseCurrency` on `statesConversionBasis`, because
 * those three figures are absent on a base-currency entry: restating an identical total under an
 * identical code would be noise on the overwhelming majority of entries. `get_entry` is the opposite
 * case. `baseDebit` and `baseCredit` are ALWAYS on the line, posted or draft, foreign or not, so a
 * label for them is always owed. Conditioning it would hand a client a bare integer on exactly the
 * entries it is most likely to render without checking, which is the original defect relocated.
 *
 * ## What denominates a base figure, and why it is not a guess
 *
 * `workspace.base_currency` is the ONLY answer, and it is a fact rather than today's setting for
 * anything posted: `needs_empty_ledger` in `updateWorkspace` locks the column the moment a line
 * exists, so for a posted entry it is provably the currency the ledger converted into. A draft's
 * `base_debit_minor` is a literal copy of `debit_minor`, but `saveDraft` also writes
 * `baseCurrencyOf(ctx)` as the row currency, so the copy and its label agree: a draft is the one
 * shape where the base figure and the transaction figure are the same money.
 *
 * Nothing below trusts a return value or a fixture for a figure. Every assertion reads
 * `journal_line` and `workspace` back out of SQLite and demands the read model equal THOSE rows,
 * and the workspace is EUR-based throughout so a hardcoded 'CHF' cannot pass any of it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { postEntry, saveDraft } from '../../dist/core/ledger/index.js';
import { statesConversionBasis } from '../../dist/core/ledger/postEntry.js';
import { recordExchangeRate } from '../../dist/core/fx/index.js';
import { getAction } from '../../dist/api/registry.js';
import { setup } from './support.mjs';
import { at, defined, num, obj, objs, okOf, row, str } from '../support/narrow.mjs';

const DATE = '2026-03-01';

/** A EUR-base workspace. Set before anything posts, which is the only time the column moves. */
function eurSetup() {
  const s = setup();
  s.store.db.prepare('UPDATE workspace SET base_currency = ? WHERE id = ?').run('EUR', s.workspaceId);
  return s;
}

/** What the LEDGER holds, straight out of SQLite. The only authority in this file. */
function ledgerRows(store, entryId) {
  return store.db
    .prepare(
      `SELECT id, currency, debit_minor, credit_minor, base_debit_minor, base_credit_minor, fx_rate
         FROM journal_line WHERE entry_id = ? ORDER BY rowid`,
    )
    .all(entryId);
}

/** The base currency as the DATABASE holds it, never as a test author typed it. */
function baseCurrencyRow(store, workspaceId) {
  return str(
    row(store.db.prepare('SELECT base_currency FROM workspace WHERE id = ?').get(workspaceId), 'the workspace row')
      .base_currency,
    'workspace.base_currency',
  );
}

/** `get_entry` through the registry, because whatever the Studio renders an agent must reach too. */
function read(ctx, workspaceId, entryId) {
  const res = okOf(defined(getAction('get_entry'), "the 'get_entry' action").run(ctx, { workspaceId, entryId }), 'get_entry');
  return { baseCurrency: res.baseCurrency, lines: objs(res.lines, 'get_entry.lines') };
}

function rate(ctx, currency, value, key) {
  const res = recordExchangeRate(ctx, {
    baseCurrency: currency,
    rate: value,
    asOf: DATE,
    source: 'manual',
    method: 'daily',
    provenance: 'ESTV Tageskurs Verkauf (MWSTV Art. 45 Abs. 3)',
    idempotencyKey: key,
  });
  assert.ok(res.ok, JSON.stringify(res));
}

/**
 * @param {any} ctx
 * @param {ReturnType<typeof setup>['accounts']} accounts
 * @param {{ key: string, currency?: string, amount?: number }} spec
 */
function post(ctx, accounts, { key, currency, amount = 100000 }) {
  const res = postEntry(ctx, {
    date: DATE,
    source: 'manual',
    idempotencyKey: key,
    ...(currency !== undefined ? { currency } : {}),
    lines: [
      { account: accounts['6500'], debit: amount },
      { account: accounts['1000'], credit: amount },
    ],
  });
  assert.ok(res.ok, JSON.stringify(res));
  return res.entryId;
}

test('a FOREIGN posted line names both units: the transaction one and the one the books hold', () => {
  const { store, ctx, workspaceId, accounts } = eurSetup();
  rate(ctx, 'USD', '0.86', 'r-usd');
  const entryId = post(ctx, accounts, { key: 'usd', currency: 'USD' });

  const res = read(ctx, workspaceId, entryId);
  const rows = ledgerRows(store, entryId);
  const base = baseCurrencyRow(store, workspaceId);

  assert.equal(base, 'EUR', 'the books are kept in EUR, so a hardcoded CHF cannot pass this file');
  assert.equal(rows.length, 2, 'the entry really posted two lines');

  for (const [i, line] of res.lines.entries()) {
    const row = rows[i];
    // The pairing, stated per line: `currency` denominates `debit` / `credit`, `baseCurrency`
    // denominates `baseDebit` / `baseCredit`. Both figures come off the row, both labels are named.
    assert.equal(line.currency, row.currency, 'the transaction currency is the row currency');
    assert.equal(line.debit, row.debit_minor);
    assert.equal(line.credit, row.credit_minor);
    assert.equal(line.baseDebit, row.base_debit_minor);
    assert.equal(line.baseCredit, row.base_credit_minor);
    assert.equal(line.baseCurrency, base, 'the base figures are named with what the workspace holds');
    assert.notEqual(line.baseCurrency, line.currency, 'a USD entry in a EUR book has two units');
    assert.equal(
      statesConversionBasis({ currency: line.currency, baseCurrency: line.baseCurrency }),
      true,
      'and the single predicate agrees the line states a basis',
    );
  }

  // The figures differ as well as the units, so a single label would be wrong twice over. USD
  // 1'000.00 at 0.86 books EUR 860.00: neither "EUR 1'000.00" nor "USD 860.00" is a real amount.
  const debitLine = obj(
    res.lines.find((l) => num(l.debit, 'get_entry.lines[].debit') > 0),
    'the debit line get_entry reports',
  );
  assert.equal(debitLine.debit, 100000);
  assert.equal(debitLine.baseDebit, 86000);
  assert.notEqual(debitLine.debit, debitLine.baseDebit, 'one label cannot serve both figures');
});

test('a BASE-currency posted line names the base too: the label is owed whenever the figure is sent', () => {
  const { store, ctx, workspaceId, accounts } = eurSetup();
  const entryId = post(ctx, accounts, { key: 'eur', currency: 'EUR' });

  const res = read(ctx, workspaceId, entryId);
  const rows = ledgerRows(store, entryId);
  const base = baseCurrencyRow(store, workspaceId);

  for (const [i, line] of res.lines.entries()) {
    assert.equal(line.baseDebit, rows[i].base_debit_minor, 'the base figure is sent');
    assert.equal(line.baseCredit, rows[i].base_credit_minor);
    // So the label is sent. This is the arm that forbids gating the field on
    // `statesConversionBasis`: the predicate is false here and the figure is present anyway.
    assert.equal(
      statesConversionBasis({ currency: str(line.currency, 'get_entry.lines[].currency'), baseCurrency: base }),
      false,
      'a base-currency line states no conversion basis',
    );
    assert.equal(line.baseCurrency, base, 'and is denominated all the same');
    assert.equal(line.baseCurrency, line.currency, 'both units coincide, which is a fact, not an absence');
    assert.equal(line.baseDebit, line.debit, 'as do both figures');
  }
  // The rate is the part that stays absent on a base-currency posting: no conversion happened, so
  // there is nothing to state it at (`statesConversionBasis`, the single predicate for that).
  assert.equal(rows[0].fx_rate, null, 'a base-currency posting stores NO rate');
});

test('a DRAFT line is denominated too, and its base label agrees with the copy it labels', () => {
  const { store, ctx, workspaceId, accounts } = eurSetup();
  const draft = saveDraft(ctx, {
    date: DATE,
    idempotencyKey: 'draft',
    lines: [{ account: accounts['6500'], debit: 4200 }],
  });
  assert.ok(draft.ok, JSON.stringify(draft));

  const res = read(ctx, workspaceId, draft.entryId);
  const rows = ledgerRows(store, draft.entryId);
  const base = baseCurrencyRow(store, workspaceId);

  // `saveDraft` writes `baseCurrencyOf(ctx)` as the row currency and copies `debit_minor` into
  // `base_debit_minor`. The copy is honest precisely because the two currencies are the same one, so
  // naming the base here is a statement about EUR 42.00, not a conversion nobody performed.
  assert.equal(rows[0].currency, base, 'a draft is denominated in the base currency, by construction');
  assert.equal(rows[0].fx_rate, null, 'and carries no rate, because nothing has been converted');
  assert.equal(at(res.lines, 0, 'get_entry.lines').baseDebit, rows[0].base_debit_minor);
  assert.equal(at(res.lines, 0, 'get_entry.lines').baseCurrency, base);
  assert.equal(at(res.lines, 0, 'get_entry.lines').baseCurrency, at(res.lines, 0, 'get_entry.lines').currency);
});

test('an entry with NO lines has no figure to denominate, and claims no currency anywhere', () => {
  const { store, ctx, workspaceId } = eurSetup();
  const draft = saveDraft(ctx, { date: DATE, idempotencyKey: 'empty', lines: [] });
  assert.ok(draft.ok, JSON.stringify(draft));

  const res = read(ctx, workspaceId, draft.entryId);
  assert.equal(ledgerRows(store, draft.entryId).length, 0, 'the entry really has no lines');
  assert.equal(res.lines.length, 0);
  // The label lives on the line because the figure does. With no rows there is no base figure, and
  // a workspace-level echo would be the engine denominating a zero nobody entered.
  assert.equal(res.baseCurrency, undefined, 'the response denominates lines, not the workspace');
});

test('the base label follows the WORKSPACE, so a CHF book and a EUR book cannot both be right', () => {
  // The same posting, twice, in two differently-based workspaces. If the field were a literal rather
  // than a read, one of these two must be wrong; both being right is the whole point of the change.
  const chf = setup();
  const chfEntry = post(chf.ctx, chf.accounts, { key: 'k' });
  const chfLine = at(read(chf.ctx, chf.workspaceId, chfEntry).lines, 0, 'get_entry.lines');
  assert.equal(chfLine.baseCurrency, baseCurrencyRow(chf.store, chf.workspaceId));
  assert.equal(chfLine.baseCurrency, 'CHF');

  const eur = eurSetup();
  const eurEntry = post(eur.ctx, eur.accounts, { key: 'k' });
  const eurLine = at(read(eur.ctx, eur.workspaceId, eurEntry).lines, 0, 'get_entry.lines');
  assert.equal(eurLine.baseCurrency, baseCurrencyRow(eur.store, eur.workspaceId));
  assert.equal(eurLine.baseCurrency, 'EUR');

  assert.notEqual(chfLine.baseCurrency, eurLine.baseCurrency, 'the setting is what moved, not the code');
});
