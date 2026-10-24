// The feed's start (the audit of the "Differenz" banner, 16.10.2026): a book migrated with a history the
// bank feed never saw differs from the bank BEFORE the first imported statement, and no line, decision or
// match can explain that. The balance read names it: the earliest statement's opening balance against
// the linked account's balance the day before. A fact beside the identity, never a term of it.
//
// SYNTHETIC DATA ONLY: invented amounts, the shared synthetic IBAN of bank-inbox-support.

import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { listBankInbox, createBankAccount, setBankOpeningBalance, ignoreBankLine } from '../../dist/core/banking/index.js';
import { postEntry } from '../../dist/core/ledger/index.js';
import { assertClaimInvariantHolds, world, must, importLines, secondWorkspace, MAIN_IBAN } from './bank-inbox-support.mjs';
import { seedOpeningBalanceAccount } from './support.mjs';

afterEach(assertClaimInvariantHolds);

const summaryOf = (t) => must(listBankInbox(t.ctx, { bankAccountId: t.bankAccountId })).summary[0];

/** The migrated books: CHF 1'500.00 on the bank account on 01.07., the last movement the feed never saw. */
function migratedBook() {
  const t = world();
  must(postEntry(t.ctx, { date: '2026-07-01', source: 'manual', description: 'Übernahme Bank', idempotencyKey: 'mig', lines: [{ account: t.acc('1020'), debit: 150000 }, { account: t.acc('3400'), credit: 150000 }] }));
  return t;
}

test('the feed starts lower than the books: the start names the whole difference, bank and books that morning', () => {
  const t = migratedBook();
  importLines(t, { statementId: 'S-20', seqNb: '20', from: '2026-07-20', to: '2026-07-20', openingMinor: 90000, entries: [{ ref: 'fee', amountMinor: 1000, cd: 'DBIT', date: '2026-07-20' }] });
  const s = summaryOf(t);
  assert.equal(s.differenceMinor, 89000 - 150000 - -1000, 'the identity is unchanged: bank - books - open');
  assert.deepEqual(s.start, { date: '2026-07-20', bankMinor: 90000, ledgerMinor: 150000, gapMinor: -60000 });
  assert.equal(s.start.gapMinor, s.differenceMinor, 'here the whole difference lies before the feed');
});

test('books that meet the first statement: the start gap is 0 while an open line still counts in the identity', () => {
  const t = migratedBook();
  importLines(t, { statementId: 'S-20', seqNb: '20', from: '2026-07-20', to: '2026-07-20', openingMinor: 150000, entries: [{ ref: 'fee', amountMinor: 1000, cd: 'DBIT', date: '2026-07-20' }] });
  const s = summaryOf(t);
  assert.equal(s.differenceMinor, 0);
  assert.equal(s.start.gapMinor, 0);
});

test('the books are read up to the day BEFORE the first statement: an entry on its first day is not in the start', () => {
  const t = migratedBook();
  must(postEntry(t.ctx, { date: '2026-07-20', source: 'manual', description: 'Am Auszugstag', idempotencyKey: 'same-day', lines: [{ account: t.acc('1020'), debit: 5000 }, { account: t.acc('3400'), credit: 5000 }] }));
  importLines(t, { statementId: 'S-20', seqNb: '20', from: '2026-07-20', to: '2026-07-20', openingMinor: 150000, entries: [{ ref: 'in', amountMinor: 5000, cd: 'CRDT', date: '2026-07-20' }] });
  const s = summaryOf(t);
  assert.equal(s.start.ledgerMinor, 150000, 'the same-day entry belongs to the statement, not to the history before it');
  assert.equal(s.start.gapMinor, 0);
});

test('the start is the EARLIEST statement by its own dates, not the first one imported', () => {
  const t = migratedBook();
  importLines(t, { statementId: 'S-25', seqNb: '25', from: '2026-07-25', to: '2026-07-25', openingMinor: 80000, entries: [{ ref: 'b', amountMinor: 500, cd: 'DBIT', date: '2026-07-25' }] });
  assert.equal(summaryOf(t).start.date, '2026-07-25');
  importLines(t, { statementId: 'S-20', seqNb: '20', from: '2026-07-20', to: '2026-07-20', openingMinor: 90000, entries: [{ ref: 'a', amountMinor: 1000, cd: 'DBIT', date: '2026-07-20' }] });
  const s = summaryOf(t);
  assert.deepEqual(s.start, { date: '2026-07-20', bankMinor: 90000, ledgerMinor: 150000, gapMinor: -60000 }, 'an older statement found later moves the start back');
  assert.equal(s.statementDate, '2026-07-25', 'the identity still reads the latest statement');
});

test('no statement yet: the account cannot be judged and has no start', () => {
  const t = migratedBook();
  const s = summaryOf(t);
  assert.equal(s.judgeable, false);
  assert.equal(s.start, null);
});

test('§H-TENANT: a second workspace in the same store, with an earlier statement and its own books, never moves this start', () => {
  const t = migratedBook();
  const b = secondWorkspace(t);
  const bBank = must(createBankAccount(b.ctx, { name: 'Konto B', iban: MAIN_IBAN, currency: 'CHF', ledgerAccountId: b.acc('1020'), idempotencyKey: 'b-bank' })).bankAccountId;
  must(postEntry(b.ctx, { date: '2026-06-01', source: 'manual', description: 'Nachbar', idempotencyKey: 'b-mig', lines: [{ account: b.acc('1020'), debit: 777700 }, { account: b.acc('3400'), credit: 777700 }] }));
  importLines(t, { statementId: 'B-01', seqNb: '1', from: '2026-07-02', to: '2026-07-02', openingMinor: 1, entries: [{ ref: 'u', amountMinor: 1, cd: 'DBIT', date: '2026-07-02' }] }, { ctx: b.ctx, bankAccountId: bBank, key: 'b-imp' });
  importLines(t, { statementId: 'S-20', seqNb: '20', from: '2026-07-20', to: '2026-07-20', openingMinor: 90000, entries: [{ ref: 'a', amountMinor: 1000, cd: 'DBIT', date: '2026-07-20' }] });
  assert.deepEqual(summaryOf(t).start, { date: '2026-07-20', bankMinor: 90000, ledgerMinor: 150000, gapMinor: -60000 }, 'neither the neighbour\'s statement nor its books count here');
  const theirs = must(listBankInbox(b.ctx, { bankAccountId: bBank })).summary[0].start;
  assert.deepEqual(theirs, { date: '2026-07-02', bankMinor: 1, ledgerMinor: 777700, gapMinor: 1 - 777700 }, 'and ours never count there');
});

/** A stored statement row written directly (the parser refuses these shapes on import). */
function storeStatement(t, { id, workspaceId = t.workspaceId, from, to = from, opening, currency = 'CHF', page = 1 }) {
  t.store.db
    .prepare(`INSERT INTO bank_statement (id, workspace_id, bank_account_id, message_type, statement_id, page_number, last_page_ind, from_date, to_date, opening_balance_minor, closing_balance_minor, balance_currency, imported_at)
              VALUES (?, ?, ?, 'camt053', ?, ?, 1, ?, ?, ?, ?, ?, '2026-07-01T08:00:00.000Z')`)
    .run(id, workspaceId, t.bankAccountId, id, page, from, to, opening, opening, currency);
}

test('a gap alone is not missing money: an opening entry dated on the first statement day reads as one, and the difference does not', () => {
  const t = world();
  seedOpeningBalanceAccount(t.ctx);
  must(setBankOpeningBalance(t.ctx, { bankAccountId: t.bankAccountId, amountMinor: 250000, date: '2026-07-20', idempotencyKey: 'ob' }));
  const { lines } = importLines(t, { statementId: 'S-20', seqNb: '20', from: '2026-07-20', to: '2026-07-20', openingMinor: 250000, entries: [{ ref: 'fee', amountMinor: 4200, cd: 'DBIT', date: '2026-07-20' }] });
  must(ignoreBankLine(t.ctx, { bankTxnId: lines.fee, reason: 'other', idempotencyKey: 'ig' }));
  const s = summaryOf(t);
  assert.equal(s.differenceMinor, -4200, 'the real difference is the ignored fee');
  assert.deepEqual(s.start, { date: '2026-07-20', bankMinor: 250000, ledgerMinor: 0, gapMinor: 250000 }, 'the raw fact');
  assert.notEqual(s.start.gapMinor, s.differenceMinor, 'so the difference does not lie before the feed, and nothing may say it does');
});

test('§H-TENANT: a forged statement row of this account under ANOTHER workspace never becomes the start', () => {
  const t = migratedBook();
  const b = secondWorkspace(t);
  importLines(t, { statementId: 'S-20', seqNb: '20', from: '2026-07-20', to: '2026-07-20', openingMinor: 90000, entries: [{ ref: 'a', amountMinor: 1000, cd: 'DBIT', date: '2026-07-20' }] });
  storeStatement(t, { id: 'forged', workspaceId: b.workspaceId, from: '2026-07-05', opening: 1 });
  assert.equal(summaryOf(t).start.date, '2026-07-20');
});

test('only a statement in the account\'s currency, with its own first day, can be the start; a split statement starts on its first page', () => {
  const t = migratedBook();
  importLines(t, { statementId: 'S-20', seqNb: '20', from: '2026-07-20', to: '2026-07-20', openingMinor: 90000, entries: [{ ref: 'a', amountMinor: 1000, cd: 'DBIT', date: '2026-07-20' }] });
  storeStatement(t, { id: 'eur', from: '2026-07-05', opening: 777, currency: 'EUR' });
  assert.equal(summaryOf(t).start.date, '2026-07-20', 'a statement in another currency is skipped');
  storeStatement(t, { id: 'undated', from: null, to: '2026-07-06', opening: 555 });
  assert.equal(summaryOf(t).start.date, '2026-07-20', 'an undated statement would make the day before a guess');
  storeStatement(t, { id: 'split-2', from: '2026-07-10', opening: 222, page: 2 });
  storeStatement(t, { id: 'split-1', from: '2026-07-10', opening: 111, page: 1 });
  assert.deepEqual(summaryOf(t).start, { date: '2026-07-10', bankMinor: 111, ledgerMinor: 150000, gapMinor: 111 - 150000 }, 'page 1 opens the split statement');
});
