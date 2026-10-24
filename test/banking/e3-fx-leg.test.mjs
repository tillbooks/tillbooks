// @ts-check
/**
 * D178 E3 (A39 §17.4): a counter-leg in the card transaction's currency, booked at the EFFECTIVE rate,
 * behind the `fx_counter_leg` acknowledgement.
 *
 * SYNTHETIC BY CONSTRUCTION: an invented card purchase (USD 100.00 at the bank's CHF 92.37 plus a CHF 1.85
 * commission, a CHF 94.22 line), statements spelled by hand.
 *
 * Held on ROWS: the conversion entry carries the leg in USD at the effective rate (journal_line.currency /
 * fx_rate), the bank entry is pure CHF; the realised-FX account nets to zero; NO foreign line lands on a
 * balance-sheet account, so A22's revaluation finds no position; the booking needs the acknowledgement and
 * refuses VAT on a foreign leg, a balance-sheet account, two currencies and amounts no one rate gives; the
 * raw Storno refuses both entries while the line holds them; `reopen_bank_line` reverses both.
 */

import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { world, importLines, must, refused, rowCounts, balanceOf, assertClaimInvariantHolds, SAVINGS_IBAN } from './bank-inbox-support.mjs';
import { bookBankLine, reopenBankLine, createBankAccount } from '../../dist/core/banking/index.js';
import { reverseEntry } from '../../dist/core/ledger/index.js';
import { computeFxRevaluation } from '../../dist/core/fx/index.js';

afterEach(assertClaimInvariantHolds);

function cardLine(t, cd = 'DBIT', amountMinor = 9422, id = 'e3f') {
  return importLines(t, { statementId: id, entries: [{ ref: 'CARD', amountMinor, cd, name: 'Cloud Hosting Inc', ustrd: 'USD 100.00 Kurs 0.9237 Kommission CHF 1.85' }] }).lines['CARD'];
}

function linesOf(t, entryId) {
  return t.store.db
    .prepare(
      `SELECT a.number AS number, l.currency AS currency, l.fx_rate AS rate, l.debit_minor AS debit, l.credit_minor AS credit,
              l.base_debit_minor AS baseDebit, l.base_credit_minor AS baseCredit
         FROM journal_line l JOIN account a ON a.id = l.account_id WHERE l.entry_id = ? ORDER BY l.rowid`,
    )
    .all(entryId);
}

const fxTarget = (t, extra = {}) => ({
  kind: 'accounts',
  legs: [
    { accountId: t.acc('6500'), amountMinor: 9237, fx: { currency: 'USD', amountMinor: 10000 } },
    { accountId: t.acc('6900'), amountMinor: 185 },
  ],
  ...extra,
});

test('the card purchase: a USD conversion entry at the effective rate and a CHF bank entry; 4906 nets to zero, the bank holds only CHF', () => {
  const t = world();
  const line = cardLine(t);
  const before = rowCounts(t.store, t.workspaceId);
  const res = must(bookBankLine(t.ctx, { bankTxnId: line, target: fxTarget(t, { acknowledgeFx: true }), idempotencyKey: 'fx1' }), 'book');
  assert.deepEqual(res.fx, { currency: 'USD', foreignMinor: 10000, baseMinor: 9237, rate: '0.9237' });
  assert.equal(res.entryIds.length, 2);
  assert.ok(res.warnings.includes('fx_counter_leg'));
  const [conversion, bank] = res.entryIds;
  assert.equal(res.entryId, conversion, 'the decision names the conversion entry');
  assert.deepEqual(linesOf(t, conversion), [
    { number: '6500', currency: 'USD', rate: '0.9237', debit: 10000, credit: 0, baseDebit: 9237, baseCredit: 0 },
    { number: '4906', currency: 'USD', rate: '0.9237', debit: 0, credit: 10000, baseDebit: 0, baseCredit: 9237 },
  ]);
  for (const l of linesOf(t, bank)) assert.equal(l.currency, 'CHF', 'the bank entry is pure CHF');
  assert.equal(balanceOf(t.store, t.workspaceId, '1020'), -9422, 'the bank moved exactly what the bank booked');
  assert.equal(balanceOf(t.store, t.workspaceId, '4906'), 0, 'the realised-FX account nets to zero');
  assert.equal(balanceOf(t.store, t.workspaceId, '6500'), 9237);
  assert.equal(balanceOf(t.store, t.workspaceId, '6900'), 185);
  const after = rowCounts(t.store, t.workspaceId);
  assert.equal(after.entries - before.entries, 2);
  assert.equal(after.claims - before.claims, 1, 'the line claims the bank entry\'s one bank leg');
  // No foreign line on any balance-sheet account: A22 finds nothing to revalue at the period end.
  const reval = must(computeFxRevaluation(t.ctx, { periodEnd: '2026-07-31' }), 'revaluation');
  assert.deepEqual(reval.positions, []);
  assert.deepEqual(reval.needsRate, []);
  // A replay writes nothing.
  const counts = rowCounts(t.store, t.workspaceId);
  must(bookBankLine(t.ctx, { bankTxnId: line, target: fxTarget(t, { acknowledgeFx: true }), idempotencyKey: 'fx1' }), 'replay');
  assert.deepEqual(rowCounts(t.store, t.workspaceId), counts);
  // While the line holds them, the raw Storno refuses BOTH entries (L3).
  for (const entryId of res.entryIds) {
    const r = refused(reverseEntry(t.ctx, { entryId, idempotencyKey: `raw-${entryId}` }), 'owned_by');
    assert.equal(r.verb, 'reopen_bank_line');
  }
  // The undo reverses both; every balance is back to zero.
  const undone = must(reopenBankLine(t.ctx, { bankTxnId: line, reason: 'falscher Kurs', idempotencyKey: 'fx2' }), 'reopen');
  assert.deepEqual(undone.reversedEntryIds, [conversion, bank]);
  for (const n of ['1020', '4906', '6500', '6900']) assert.equal(balanceOf(t.store, t.workspaceId, n), 0, n);
  assert.deepEqual(must(computeFxRevaluation(t.ctx, { periodEnd: '2026-07-31' }), 'reval after').positions, []);
});

test('money in (a USD payout to a CHF account) runs through 3806 the same way', () => {
  const t = world();
  const line = cardLine(t, 'CRDT', 45000, 'e3f-in');
  const res = must(
    bookBankLine(t.ctx, { bankTxnId: line, target: { kind: 'accounts', legs: [{ accountId: t.acc('3200'), amountMinor: 45000, fx: { currency: 'EUR', amountMinor: 48000 } }], acknowledgeFx: true }, idempotencyKey: 'in1' }),
    'book',
  );
  assert.equal(res.fx.rate, '0.9375');
  assert.equal(balanceOf(t.store, t.workspaceId, '3806'), 0);
  assert.equal(balanceOf(t.store, t.workspaceId, '3200'), -45000);
  assert.equal(balanceOf(t.store, t.workspaceId, '1020'), 45000);
});

test('the acknowledgement is required, and the refusal carries the consequence in both languages', () => {
  const t = world();
  const line = cardLine(t);
  const counts = rowCounts(t.store, t.workspaceId);
  const r = refused(bookBankLine(t.ctx, { bankTxnId: line, target: fxTarget(t), idempotencyKey: 'ack1' }), 'fx_ack_required');
  assert.equal(r.consequence.code, 'fx_counter_leg');
  assert.equal(r.consequence.reversibility, 'correctable');
  assert.match(r.consequence['de-CH'], /Kartenwährung/);
  assert.deepEqual(rowCounts(t.store, t.workspaceId), counts);
});

test('refusals write nothing: VAT on a foreign leg, a balance-sheet account, two currencies, amounts no one rate gives', () => {
  const t = world();
  const line = cardLine(t);
  const counts = rowCounts(t.store, t.workspaceId);
  const book = (target, key) => bookBankLine(t.ctx, { bankTxnId: line, target: { ...target, acknowledgeFx: true }, idempotencyKey: key });
  refused(
    book({ kind: 'accounts', legs: [{ accountId: t.acc('6500'), amountMinor: 9422, taxCode: 'VST-M', fx: { currency: 'USD', amountMinor: 10200 } }] }, 'v1'),
    'fx_leg_vat_refused',
  );
  refused(book({ kind: 'accounts', legs: [{ accountId: t.acc('1520'), amountMinor: 9422, fx: { currency: 'USD', amountMinor: 10200 } }] }, 'v2'), 'invalid_fx_leg_account');
  refused(
    book({ kind: 'accounts', legs: [{ accountId: t.acc('6500'), amountMinor: 5000, fx: { currency: 'USD', amountMinor: 5400 } }, { accountId: t.acc('6570'), amountMinor: 4422, fx: { currency: 'EUR', amountMinor: 4700 } }] }, 'v3'),
    'fx_currency_mismatch',
  );
  refused(book({ kind: 'accounts', legs: [{ accountId: t.acc('6500'), amountMinor: 9422, fx: { currency: 'CHF', amountMinor: 9422 } }] }, 'v4'), 'fx_currency_mismatch');
  // Two legs of USD 100.00 each at CHF 47.10 and 47.12: one entry has one rate, which cannot give both.
  const odd = refused(
    book({ kind: 'accounts', legs: [{ accountId: t.acc('6500'), amountMinor: 4710, fx: { currency: 'USD', amountMinor: 5100 } }, { accountId: t.acc('6570'), amountMinor: 4712, fx: { currency: 'USD', amountMinor: 5100 } }] }, 'v5'),
    'fx_leg_amounts_inconsistent',
  );
  assert.equal(odd.legs.length, 2);
  refused(book({ kind: 'accounts', legs: [{ accountId: t.acc('6500'), amountMinor: 9422, fx: { currency: 'usd', amountMinor: 10200 } }] }, 'v6'), 'invalid_input');
  refused(book({ kind: 'accounts', legs: [{ accountId: t.acc('6500'), amountMinor: 9422, fx: { currency: 'USD', amountMinor: 0 } }] }, 'v7'), 'invalid_input');
  assert.deepEqual(rowCounts(t.store, t.workspaceId), counts, 'no refusal wrote a row');
});

test('a foreign leg on a foreign-currency line refuses fx_leg_needs_base_line', () => {
  const t = world();
  // A EUR Bankkonto (an invented second account) whose own statement is in EUR: its lines book in EUR,
  // so a counter-leg in yet another currency has no CHF to convert from.
  const eur = must(createBankAccount(t.ctx, { name: 'EUR-Konto', iban: SAVINGS_IBAN, currency: 'EUR', ledgerAccountId: t.acc('1060'), idempotencyKey: 'eur-acc' }), 'eur account');
  const { lines } = importLines(t, { statementId: 'e3f-eur', currency: 'EUR', iban: SAVINGS_IBAN, entries: [{ ref: 'EU', amountMinor: 5000, cd: 'DBIT', name: 'Hotel' }] }, { bankAccountId: eur.bankAccountId });
  const counts = rowCounts(t.store, t.workspaceId);
  refused(
    bookBankLine(t.ctx, { bankTxnId: lines['EU'], target: { kind: 'accounts', legs: [{ accountId: t.acc('6500'), amountMinor: 5000, fx: { currency: 'USD', amountMinor: 5400 } }], acknowledgeFx: true }, idempotencyKey: 'eur1' }),
    'fx_leg_needs_base_line',
  );
  assert.deepEqual(rowCounts(t.store, t.workspaceId), counts);
});
