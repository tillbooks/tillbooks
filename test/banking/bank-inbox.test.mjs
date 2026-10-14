// A39, the bank inbox: the engine claims that matter (spec A39 §4, §8), each walk row the brief named
// written as a regression test against the row's own measured failure (docs/ux/bank-process-walk.md on
// claude/ux-bank-process). The invariants (append-only, idempotent on rows, §H-TENANT) live in
// bank-inbox-invariants.test.mjs, marked as such for the non-author critic.
//
// SYNTHETIC DATA ONLY: every statement is spelled by hand in bank-inbox-support.mjs.

import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  createBankAccount,
  archiveBankAccount,
  importCamt,
  listBankInbox,
  bookBankLine,
  ignoreBankLine,
  reopenBankLine,
  bankReconciledForPeriod,
  listBankStatements,
  listReconciliation,
  createEntryForTxn,
  confirmCamtMatch,
  recordIncomingCredit,
  applyQrMatch,
  overrideQrMatch,
  setQrAutoApply,
  setCreditorBankProfile,
  createPaymentBatch,
  generatePain001,
  markBatchPaid,
} from '../../dist/core/banking/index.js';
import { frozenPmtInfId, frozenEndToEndId } from './frozen-refs-support.mjs';
import { buildQrrReference } from '../../dist/core/payments/reference.js';
import { postEntry, reverseEntry, softCloseMonth } from '../../dist/core/ledger/index.js';
import { evaluateCheck } from '../../dist/core/checklists/index.js';
import { settledOnVendorBill } from '../../dist/core/purchase/reads.js';
import { applySanitization } from '../../dist/core/landscape/sanitize.js';
import Database from 'better-sqlite3';
import { setCreditorProfile } from '../../dist/core/setup/index.js';
import { setDunningConfig, proposeDunningRun, issueDunningRun } from '../../dist/core/dunning/index.js';
import {
  assertClaimInvariantHolds,
  world,
  camt,
  importLines,
  postedBill,
  rowCounts,
  legs,
  balanceOf,
  must,
  refused,
  issueInvoice,
  MAIN_IBAN,
  SAVINGS_IBAN,
  TELCO_IBAN,
} from './bank-inbox-support.mjs';

// Critic A39R2-4: the claim invariant is asserted after EVERY scenario of this suite.
afterEach(assertClaimInvariantHolds);

const GROSS = 108100;
const lineOf = (inbox, id) => inbox.lines.find((l) => l.bankTxnId === id);

/** A second own Bankkonto (the savings account a transfer goes to), on 1000. */
function savings(t) {
  return must(
    createBankAccount(t.ctx, { name: 'Sparkonto', iban: SAVINGS_IBAN, currency: 'CHF', ledgerAccountId: t.acc('1000'), idempotencyKey: 'sav' }),
    'savings',
  ).bankAccountId;
}

function manualEntry(t, key, lines, date = '2026-07-20') {
  return must(postEntry(t.ctx, { date, source: 'manual', description: `von Hand ${key}`, idempotencyKey: key, lines }), key);
}

// ================================================================================================
// 1. The inbox: every line of every statement, one state each, a proposal on every open line
// ================================================================================================

test('the inbox lists lines across statements with a proposal per open line, and books straight from it', () => {
  const t = world();
  savings(t);
  const inv = issueInvoice(t.ctx, { contactId: t.customerId, key: 'inb1' });
  const a = importLines(t, {
    statementId: 'IN-A',
    entries: [
      { ref: 'Q1', amountMinor: GROSS, cd: 'CRDT', qrr: buildQrrReference(inv.number), name: 'Muster AG' },
      { ref: 'FEE', amountMinor: 500, cd: 'DBIT', name: 'Kontoführung', ustrd: 'Preis für die Kontoführung Juli' },
    ],
  });
  const b = importLines(t, {
    statementId: 'IN-B',
    seqNb: '2',
    from: '2026-07-01',
    to: '2026-07-31',
    openingMinor: GROSS - 500,
    entries: [{ ref: 'SAV', amountMinor: 50000, cd: 'DBIT', iban: SAVINGS_IBAN, name: 'Übertrag Sparkonto', date: '2026-07-25' }],
  });

  const inbox = must(listBankInbox(t.ctx, {}), 'inbox');
  assert.equal(inbox.total, 3, 'all three open lines of BOTH statements are listed');
  assert.deepEqual(new Set(inbox.lines.map((l) => l.state)), new Set(['open']));
  assert.equal(inbox.lines[0].bankTxnId, b.lines.SAV, 'newest first');

  const q1 = lineOf(inbox, a.lines.Q1);
  assert.equal(q1.amountMinor, GROSS, 'money in is positive');
  assert.equal(q1.counterparty.name, 'Muster AG');
  assert.equal(q1.proposal.certainty, 'sure', 'a QR reference and an exact amount prove the invoice');
  assert.equal(q1.proposal.reasonCode, 'qr_reference_exact');
  assert.deepEqual(q1.proposal.target, { kind: 'open_item', documentId: inv.id });

  const fee = lineOf(inbox, a.lines.FEE);
  assert.equal(fee.amountMinor, -500, 'money out is negative');
  assert.equal(fee.remittance.text, 'Preis für die Kontoführung Juli');
  assert.equal(fee.proposal.certainty, 'open');
  assert.equal(fee.proposal.reasonCode, 'no_proposal');

  const sav = lineOf(inbox, b.lines.SAV);
  assert.equal(sav.counterparty.iban, SAVINGS_IBAN);
  assert.equal(sav.proposal.certainty, 'check', 'the counterparty IBAN is one of our own accounts: a transfer, never sure (D139)');
  assert.equal(sav.proposal.reasonCode, 'own_account_transfer');
  assert.deepEqual(sav.proposal.target, { kind: 'accounts', legs: [{ accountId: t.acc('1000'), amountMinor: 50000 }] });

  // The Studio books straight from the proposal.
  must(bookBankLine(t.ctx, { bankTxnId: q1.bankTxnId, target: q1.proposal.target, idempotencyKey: 'q1' }), 'book q1');
  must(bookBankLine(t.ctx, { bankTxnId: sav.bankTxnId, target: sav.proposal.target, idempotencyKey: 'sav' }), 'book sav');
  assert.equal(balanceOf(t.store, t.workspaceId, '1000'), 50000, 'the transfer landed on the savings account');

  const after = must(listBankInbox(t.ctx, {}), 'inbox after');
  assert.deepEqual(after.lines.map((l) => l.bankTxnId), [a.lines.FEE], 'only the fee is still open');
  const all = must(listBankInbox(t.ctx, { status: 'all' }), 'all');
  assert.equal(lineOf(all, a.lines.Q1).state, 'booked');
  assert.equal(lineOf(all, a.lines.Q1).decision.targetKind, 'open_item');
  assert.equal(lineOf(all, a.lines.Q1).proposal, null, 'a decided line carries its decision, not a proposal');

  // The balance line (L4): three numbers, bank - ledger - open.
  const s = after.summary.find((x) => x.bankAccountId === t.bankAccountId);
  assert.equal(s.bankBalanceMinor, GROSS - 500 - 50000, 'the latest statement closing balance');
  assert.equal(s.ledgerBalanceMinor, GROSS - 50000, 'the linked account at that date');
  assert.equal(s.openCount, 1);
  assert.equal(s.openSumMinor, -500);
  assert.equal(s.differenceMinor, 0, 'bank and books agree once the one open line is booked');
});

test('the inbox filters by text, amount and account, and pages with a stable cursor', () => {
  const t = world();
  const entries = [];
  for (let i = 1; i <= 7; i += 1) {
    entries.push({ ref: `P${i}`, amountMinor: 1000 + i, cd: 'DBIT', name: i % 2 === 0 ? 'Papeterie Lindenhof' : 'Reinigung Moosacker', date: `2026-07-${String(10 + i).padStart(2, '0')}` });
  }
  importLines(t, { statementId: 'PG-1', entries });
  const page1 = must(listBankInbox(t.ctx, { limit: 3 }), 'page 1');
  assert.equal(page1.lines.length, 3);
  assert.equal(page1.total, 7);
  const page2 = must(listBankInbox(t.ctx, { limit: 3, cursor: page1.nextCursor }), 'page 2');
  const page3 = must(listBankInbox(t.ctx, { limit: 3, cursor: page2.nextCursor }), 'page 3');
  assert.equal(page3.nextCursor, null);
  const seen = [...page1.lines, ...page2.lines, ...page3.lines].map((l) => l.entryRef);
  assert.deepEqual(seen, ['P7', 'P6', 'P5', 'P4', 'P3', 'P2', 'P1'], 'every line exactly once, newest first');
  assert.equal(must(listBankInbox(t.ctx, { query: 'papeterie' })).total, 3);
  assert.equal(must(listBankInbox(t.ctx, { query: '10.04' })).lines[0].entryRef, 'P4', 'an amount query finds the line');
  refused(listBankInbox(t.ctx, { cursor: 'not-a-cursor' }), 'invalid_input');
  refused(listBankInbox(t.ctx, { status: 'pending' }), 'invalid_input');
  refused(listBankInbox(t.ctx, { bankAccountId: 'nope' }), 'not_found');
});

// ================================================================================================
// 2. accounts: N legs, VAT per leg exactly as a manual journal line (walk B6.2, B6.5, B7.1)
// ================================================================================================

test('B6.2 Vorsteuer: a telecom debit booked with VST-M splits the gross into net and 1170', () => {
  const t = world();
  const { lines } = importLines(t, { statementId: 'V-1', entries: [{ ref: 'TEL', amountMinor: 10810, cd: 'DBIT', name: 'Alpina Telecom AG' }] });
  const res = must(
    bookBankLine(t.ctx, { bankTxnId: lines.TEL, target: { kind: 'accounts', legs: [{ accountId: t.acc('6500'), amountMinor: 10810, taxCode: 'VST-M' }] }, idempotencyKey: 'tel' }),
  );
  assert.equal(res.state, 'booked');
  assert.deepEqual(legs(t.store, res.entryId), [
    { number: '1020', debit: 0, credit: 10810, taxCode: null, taxBase: null, taxAmount: null },
    { number: '1170', debit: 810, credit: 0, taxCode: null, taxBase: null, taxAmount: null },
    { number: '6500', debit: 10000, credit: 0, taxCode: 'VST-M', taxBase: 10000, taxAmount: 810 },
  ]);
});

test('B6.2 Bezugsteuer: a foreign service paid net books the owed 2200 and the deductible 1170 on top', () => {
  const t = world();
  const { lines } = importLines(t, { statementId: 'V-2', entries: [{ ref: 'GCP', amountMinor: 5400, cd: 'DBIT', name: 'Cloud Services Ltd, Dublin' }] });
  const res = must(
    bookBankLine(t.ctx, { bankTxnId: lines.GCP, target: { kind: 'accounts', legs: [{ accountId: t.acc('6500'), amountMinor: 5400, taxCode: 'BEZUG' }] }, idempotencyKey: 'gcp' }),
  );
  // Art. 45 MWSTG: the amount paid IS the base; 8.1 % of 54.00 = 4.374, one round to 4.37.
  assert.deepEqual(legs(t.store, res.entryId), [
    { number: '1020', debit: 0, credit: 5400, taxCode: null, taxBase: null, taxAmount: null },
    { number: '1170', debit: 437, credit: 0, taxCode: null, taxBase: null, taxAmount: null },
    { number: '2200', debit: 0, credit: 437, taxCode: null, taxBase: null, taxAmount: null },
    { number: '6500', debit: 5400, credit: 0, taxCode: 'BEZUG', taxBase: 5400, taxAmount: 437 },
  ]);
  assert.equal(balanceOf(t.store, t.workspaceId, '1020'), -5400, 'the bank moved by the amount paid, not by the tax');
});

test('B7.1: one line split across two accounts, one leg taxed and one not, is ONE balanced entry', () => {
  const t = world();
  const { lines } = importLines(t, { statementId: 'V-3', entries: [{ ref: 'MIX', amountMinor: 15000, cd: 'DBIT' }] });
  refused(
    bookBankLine(t.ctx, { bankTxnId: lines.MIX, target: { kind: 'accounts', legs: [{ accountId: t.acc('6500'), amountMinor: 10000 }, { accountId: t.acc('6800'), amountMinor: 4000 }] }, idempotencyKey: 'mix-bad' }),
    'legs_do_not_sum',
  );
  const res = must(
    bookBankLine(t.ctx, {
      bankTxnId: lines.MIX,
      target: { kind: 'accounts', legs: [{ accountId: t.acc('6500'), amountMinor: 10000, taxCode: 'VST-M' }, { accountId: t.acc('6800'), amountMinor: 5000 }] },
      idempotencyKey: 'mix',
    }),
  );
  const l = legs(t.store, res.entryId);
  const debit = l.reduce((s, x) => s + x.debit, 0);
  const credit = l.reduce((s, x) => s + x.credit, 0);
  assert.equal(debit, credit, 'balanced');
  assert.equal(l.filter((x) => x.number === '1020').length, 1, 'the bank movement is named once');
  assert.equal(l.find((x) => x.number === '1020').credit, 15000);
  // CHF 100.00 gross at 8.1 %: tax round(10000 * 810 / 10810) = 749.
  assert.equal(l.find((x) => x.number === '1170').debit, 749);
  assert.equal(l.find((x) => x.number === '6800').debit, 5000);
});

test('B6.5: a credit with no invoice (interest, a refund) books to an account, credits and debits alike', () => {
  const t = world();
  const { lines } = importLines(t, {
    statementId: 'V-4',
    entries: [
      { ref: 'INT', amountMinor: 1234, cd: 'CRDT', name: 'Zins' },
      { ref: 'REF', amountMinor: 1081, cd: 'CRDT', name: 'Büro Plus AG', ustrd: 'Gutschrift Rücksendung' },
      { ref: 'OUT', amountMinor: 10810, cd: 'CRDT', name: 'Barverkauf' },
    ],
  });
  must(bookBankLine(t.ctx, { bankTxnId: lines.INT, target: { kind: 'accounts', legs: [{ accountId: t.acc('3000'), amountMinor: 1234 }] }, idempotencyKey: 'int' }));
  assert.equal(balanceOf(t.store, t.workspaceId, '3000'), -1234);
  // A vendor refund on an INPUT code is the same booking mirrored: the Vorsteuer is reduced, never invented.
  const refund = must(bookBankLine(t.ctx, { bankTxnId: lines.REF, target: { kind: 'accounts', legs: [{ accountId: t.acc('6500'), amountMinor: 1081, taxCode: 'VST-M' }] }, idempotencyKey: 'ref' }));
  assert.deepEqual(legs(t.store, refund.entryId).map((x) => [x.number, x.debit, x.credit]), [
    ['1020', 1081, 0],
    ['1170', 0, 81],
    ['6500', 0, 1000],
  ]);
  // An output code on money arriving books the sale: 2200 carries the Umsatzsteuer.
  const sale = must(bookBankLine(t.ctx, { bankTxnId: lines.OUT, target: { kind: 'accounts', legs: [{ accountId: t.acc('3000'), amountMinor: 10810, taxCode: 'UST81' }] }, idempotencyKey: 'out' }));
  assert.deepEqual(legs(t.store, sale.entryId).map((x) => [x.number, x.debit, x.credit]), [
    ['1020', 10810, 0],
    ['2200', 0, 810],
    ['3000', 0, 10000],
  ]);
  // The A20 wrapper books a credit too now (it used to refuse use_qr_queue).
  const { lines: more } = importLines(t, { statementId: 'V-4b', seqNb: '2', entries: [{ ref: 'INT2', amountMinor: 99, cd: 'CRDT' }] });
  must(createEntryForTxn(t.ctx, { bankTxnId: more.INT2, contraAccountId: t.acc('3000'), idempotencyKey: 'int2' }));
  refused(
    bookBankLine(t.ctx, { bankTxnId: lines.INT, target: { kind: 'accounts', legs: [{ accountId: t.acc('6500'), amountMinor: 1234, taxCode: 'NOPE' }] }, idempotencyKey: 'int-again' }),
    'line_not_open',
  );
});

test('an unknown tax code refuses before anything posts, and the line stays open', () => {
  const t = world();
  const { lines } = importLines(t, { statementId: 'V-5', entries: [{ ref: 'X', amountMinor: 500, cd: 'DBIT' }] });
  const before = rowCounts(t.store, t.workspaceId);
  refused(bookBankLine(t.ctx, { bankTxnId: lines.X, target: { kind: 'accounts', legs: [{ accountId: t.acc('6500'), amountMinor: 500, taxCode: 'NOPE' }] }, idempotencyKey: 'x' }), 'unknown_tax_code');
  assert.deepEqual(rowCounts(t.store, t.workspaceId), before);
  assert.equal(must(listBankInbox(t.ctx, {})).lines[0].state, 'open');
});

// ================================================================================================
// 3. existing_entry: the guard (walk B9.3)
// ================================================================================================

test('B9.3: an existing entry links only when it books THIS account with THIS amount, and backs one line', () => {
  const t = world();
  const e20 = manualEntry(t, 'e20', [{ account: t.acc('6500'), debit: 2000 }, { account: t.acc('1020'), credit: 2000 }]);
  const eOther = manualEntry(t, 'eother', [{ account: t.acc('6500'), debit: 2000 }, { account: t.acc('1000'), credit: 2000 }]);
  const { lines } = importLines(t, {
    statementId: 'E-1',
    entries: [
      { ref: 'L1', amountMinor: 2000, cd: 'DBIT', date: '2026-07-22' },
      { ref: 'L2', amountMinor: 2000, cd: 'DBIT', date: '2026-07-23' },
      { ref: 'L3', amountMinor: 2500, cd: 'DBIT', date: '2026-07-23' },
    ],
  });
  const inbox = must(listBankInbox(t.ctx, {}));
  const p1 = lineOf(inbox, lines.L1).proposal;
  assert.equal(p1.reasonCode, 'existing_entry_amount_date', 'the unlinked entry is proposed');
  assert.equal(p1.certainty, 'check', 'an amount and a date alone never make it sure (it could be a second payment)');
  assert.deepEqual(p1.target, { kind: 'existing_entry', entryId: e20.entryId });

  const m = must(bookBankLine(t.ctx, { bankTxnId: lines.L1, target: { kind: 'existing_entry', entryId: e20.entryId }, idempotencyKey: 'l1' }));
  assert.equal(m.state, 'matched');
  assert.equal(m.entryId, e20.entryId);

  // The same entry cannot back a second line (walk B9.3: it did, and the ledger missed a movement).
  const taken = refused(bookBankLine(t.ctx, { bankTxnId: lines.L2, target: { kind: 'existing_entry', entryId: e20.entryId }, idempotencyKey: 'l2' }), 'entry_already_linked');
  assert.equal(taken.bankTxnId, lines.L1, 'the refusal names the line that holds the entry');
  assert.equal(lineOf(must(listBankInbox(t.ctx, {})), lines.L2).proposal.reasonCode, 'no_proposal', 'a claimed entry is no longer proposed');

  // Another amount refuses with both amounts; accepting the difference links and records it.
  const e25 = manualEntry(t, 'e25', [{ account: t.acc('6500'), debit: 2400 }, { account: t.acc('1020'), credit: 2400 }], '2026-07-23');
  const mm = refused(bookBankLine(t.ctx, { bankTxnId: lines.L3, target: { kind: 'existing_entry', entryId: e25.entryId }, idempotencyKey: 'l3' }), 'amount_mismatch');
  assert.equal(mm.lineAmountMinor, -2500);
  assert.equal(mm.entryAmountMinor, -2400);
  const accepted = must(bookBankLine(t.ctx, { bankTxnId: lines.L3, target: { kind: 'existing_entry', entryId: e25.entryId, acceptDifference: true, differenceReason: 'Bankspesen im Betrag' }, idempotencyKey: 'l3-accept' }));
  assert.equal(accepted.differenceMinor, -100);
  assert.deepEqual(accepted.warnings, ['accepted_difference']);
  const decision = t.store.db.prepare('SELECT accept_difference, difference_minor, note FROM bank_line_decision WHERE link_id = ?').get(accepted.linkId);
  assert.deepEqual(decision, { accept_difference: 1, difference_minor: -100, note: 'Bankspesen im Betrag' }, 'the accepted difference is recorded with its reason');

  // An entry that never touched the bank account is refused outright.
  refused(bookBankLine(t.ctx, { bankTxnId: lines.L2, target: { kind: 'existing_entry', entryId: eOther.entryId }, idempotencyKey: 'l2-other' }), 'entry_not_on_bank_account');
});

test('B9.3: ONE entry that books two bank movements backs two lines, each on its own leg', () => {
  const t = world();
  const both = manualEntry(t, 'both', [
    { account: t.acc('6500'), debit: 7000 },
    { account: t.acc('1020'), credit: 3000 },
    { account: t.acc('1020'), credit: 4000 },
  ]);
  const { lines } = importLines(t, { statementId: 'E-2', entries: [{ ref: 'A', amountMinor: 3000, cd: 'DBIT' }, { ref: 'B', amountMinor: 4000, cd: 'DBIT' }] });
  const a = must(bookBankLine(t.ctx, { bankTxnId: lines.A, target: { kind: 'existing_entry', entryId: both.entryId }, idempotencyKey: 'a' }));
  const b = must(bookBankLine(t.ctx, { bankTxnId: lines.B, target: { kind: 'existing_entry', entryId: both.entryId }, idempotencyKey: 'b' }));
  const claimed = t.store.db.prepare('SELECT journal_line_id FROM bank_line_decision WHERE link_id IN (?, ?)').all(a.linkId, b.linkId).map((r) => r.journal_line_id);
  assert.equal(new Set(claimed).size, 2, 'each line claimed its own leg');
  const { lines: c } = importLines(t, { statementId: 'E-3', seqNb: '2', entries: [{ ref: 'C', amountMinor: 3000, cd: 'DBIT' }] });
  refused(bookBankLine(t.ctx, { bankTxnId: c.C, target: { kind: 'existing_entry', entryId: both.entryId }, idempotencyKey: 'c' }), 'entry_already_linked');
});

test('a reversed entry, or a reversal itself, can never back a line', () => {
  const t = world();
  const e = manualEntry(t, 'rev', [{ account: t.acc('6500'), debit: 900 }, { account: t.acc('1020'), credit: 900 }]);
  const r = must(reverseEntry(t.ctx, { entryId: e.entryId, idempotencyKey: 'rev-r' }));
  const { lines } = importLines(t, { statementId: 'E-4', entries: [{ ref: 'R', amountMinor: 900, cd: 'DBIT' }] });
  refused(bookBankLine(t.ctx, { bankTxnId: lines.R, target: { kind: 'existing_entry', entryId: e.entryId }, idempotencyKey: 'r1' }), 'entry_reversed');
  refused(bookBankLine(t.ctx, { bankTxnId: lines.R, target: { kind: 'existing_entry', entryId: r.reversalId }, idempotencyKey: 'r2' }), 'entry_is_reversal');
});

// ================================================================================================
// 4. open_item: invoices, bills, remainders (spec §0.1 D-A39.2)
// ================================================================================================

test('open_item on a credit: short leaves the rest open, write_off forgives it, a surplus parks as Guthaben', () => {
  const t = world();
  const i1 = issueInvoice(t.ctx, { contactId: t.customerId, key: 'oi1' });
  const i2 = issueInvoice(t.ctx, { contactId: t.customerId, key: 'oi2' });
  const i3 = issueInvoice(t.ctx, { contactId: t.customerId, key: 'oi3' });
  const { lines } = importLines(t, {
    statementId: 'OI-1',
    entries: [
      { ref: 'SHORT', amountMinor: GROSS - 1000, cd: 'CRDT' },
      { ref: 'WOFF', amountMinor: GROSS - 50, cd: 'CRDT' },
      { ref: 'OVER', amountMinor: GROSS + 900, cd: 'CRDT' },
    ],
  });
  const short = must(bookBankLine(t.ctx, { bankTxnId: lines.SHORT, target: { kind: 'open_item', documentId: i1.id }, idempotencyKey: 'short' }));
  assert.deepEqual(short.remainder, { kind: 'open', amountMinor: 1000, documentOpenMinor: 1000, feeOpenMinor: 0 });
  const woff = must(bookBankLine(t.ctx, { bankTxnId: lines.WOFF, target: { kind: 'open_item', documentId: i2.id, remainder: 'write_off' }, idempotencyKey: 'woff' }));
  assert.deepEqual(woff.remainder, { kind: 'written_off', amountMinor: 50, documentOpenMinor: 0, feeOpenMinor: 0 });
  assert.equal(balanceOf(t.store, t.workspaceId, '3805') > 0, true, 'the shortfall went to A14\'s write-off role account');
  refused(bookBankLine(t.ctx, { bankTxnId: lines.OVER, target: { kind: 'open_item', documentId: i3.id, remainder: 'write_off' }, idempotencyKey: 'over-w' }), 'invalid_input');
  const over = must(bookBankLine(t.ctx, { bankTxnId: lines.OVER, target: { kind: 'open_item', documentId: i3.id }, idempotencyKey: 'over' }));
  assert.deepEqual(over.remainder, { kind: 'on_account', amountMinor: 900, documentOpenMinor: 0, feeOpenMinor: 0 });
  const status = (id) => t.store.db.prepare('SELECT status FROM document WHERE id = ?').get(id).status;
  assert.equal(status(i1.id), 'partially_paid');
  assert.equal(status(i2.id), 'settled');
  assert.equal(status(i3.id), 'settled');
});

test('open_item on a debit settles a posted vendor bill; the wrong pairing refuses wrong_direction', () => {
  const t = world();
  const bill = postedBill(t, { grossMinor: 32430, seed: 'ob1', vendorReference: 'LR-2026-121' });
  const inv = issueInvoice(t.ctx, { contactId: t.customerId, key: 'ob-inv' });
  const { lines } = importLines(t, { statementId: 'OB-1', entries: [{ ref: 'D', amountMinor: 32430, cd: 'DBIT', ustrd: 'LR-2026-121' }, { ref: 'C', amountMinor: 32430, cd: 'CRDT' }] });
  const p = lineOf(must(listBankInbox(t.ctx, {})), lines.D).proposal;
  assert.equal(p.reasonCode, 'vendor_bill_reference');
  assert.equal(p.certainty, 'sure', 'the supplier reference in the remittance and the exact amount prove the bill');
  refused(bookBankLine(t.ctx, { bankTxnId: lines.D, target: { kind: 'open_item', documentId: inv.id }, idempotencyKey: 'd-inv' }), 'wrong_direction');
  refused(bookBankLine(t.ctx, { bankTxnId: lines.C, target: { kind: 'open_item', documentId: bill.vendorBillId }, idempotencyKey: 'c-bill' }), 'wrong_direction');
  must(bookBankLine(t.ctx, { bankTxnId: lines.D, target: p.target, idempotencyKey: 'd' }));
  assert.equal(settledOnVendorBill(t.ctx, bill.vendorBillId), 32430);
});

test('B5.2 on the inbox: a credit short of invoice plus Mahngebühr names exactly what stays open', () => {
  const t = world();
  const feeAccount = t.store.db.prepare(`SELECT id FROM account WHERE workspace_id = ? AND type = 'income' ORDER BY number LIMIT 1`).get(t.workspaceId);
  must(setCreditorProfile(t.ctx, { creditorName: 'Muster Grafik GmbH', address: { street: 'Bahnhofstrasse', buildingNo: '1', zip: '8000', town: 'Zürich', country: 'CH' }, iban: MAIN_IBAN }));
  must(setDunningConfig(t.ctx, { levels: [{ level: 1, daysOverdue: 10, feeMinor: 2000, bookFee: true, feeIncomeAccountId: feeAccount.id }, { level: 2, daysOverdue: 20, feeMinor: 0 }, { level: 3, daysOverdue: 30, feeMinor: 0 }], idempotencyKey: 'dun' }));
  const inv = issueInvoice(t.ctx, { contactId: t.customerId, key: 'b52', dueDate: '2026-06-01' });
  const run = must(proposeDunningRun(t.ctx, { idempotencyKey: 'dun-p' }));
  must(issueDunningRun(t.ctx, { runId: run.runId, confirmed: true, idempotencyKey: 'dun-i' }));
  const { lines } = importLines(t, { statementId: 'B52', entries: [{ ref: 'S', amountMinor: GROSS + 2000 - 50, cd: 'CRDT', qrr: buildQrrReference(inv.number) }] });
  const booked = must(bookBankLine(t.ctx, { bankTxnId: lines.S, target: { kind: 'open_item', documentId: inv.id }, idempotencyKey: 's' }));
  assert.deepEqual(booked.remainder, { kind: 'open', amountMinor: 50, documentOpenMinor: 0, feeOpenMinor: 50 }, 'the unpaid CHF 0.50 is named, on the fee');
  const allocs = t.store.db.prepare('SELECT target_kind, amount_minor FROM payment_allocation WHERE payment_id = ? ORDER BY target_kind').all(booked.paymentId);
  assert.deepEqual(allocs, [
    { target_kind: 'document', amount_minor: GROSS },
    { target_kind: 'dunning_fee', amount_minor: 1950 },
  ], 'the fee took its share through A14 instead of parking as a Guthaben');
});

// ================================================================================================
// 5. payment runs (walk B8.8)
// ================================================================================================

function run(t, seed, amounts) {
  const bills = amounts.map((a, i) => postedBill(t, { grossMinor: a, seed: `${seed}-${i}`, vendorName: `Lieferant ${seed} ${i}` }));
  for (const [i, b] of bills.entries()) must(setCreditorBankProfile(t.ctx, { vendorId: b.vendorId, iban: SAVINGS_IBAN, idempotencyKey: `${seed}-cbp-${i}` }));
  const batch = must(createPaymentBatch(t.ctx, { bankAccountId: t.bankAccountId, itemIds: bills.map((b) => b.vendorBillId), executionDate: '2026-07-22', idempotencyKey: `${seed}-batch` }));
  must(generatePain001(t.ctx, { batchId: batch.batchId, idempotencyKey: `${seed}-gen` }));
  return { batchId: batch.batchId, bills };
}

test('a generated run is booked from its debit: the PmtInfId proves it, A18 marks it paid', () => {
  const t = world();
  const r = run(t, 'gen', [60000, 40000]);
  const { lines } = importLines(t, { statementId: 'PR-1', entries: [{ ref: 'RUN', amountMinor: 100000, cd: 'DBIT', pmtInfId: frozenPmtInfId(t, r.batchId) }] });
  const p = lineOf(must(listBankInbox(t.ctx, {})), lines.RUN).proposal;
  assert.equal(p.reasonCode, 'payment_batch_reference');
  assert.equal(p.certainty, 'sure');
  const booked = must(bookBankLine(t.ctx, { bankTxnId: lines.RUN, target: p.target, idempotencyKey: 'run' }));
  assert.equal(booked.state, 'booked');
  assert.equal(booked.paymentIds.length, 2);
  assert.equal(t.store.db.prepare('SELECT status FROM payment_batch WHERE id = ?').get(r.batchId).status, 'paid');
  for (const b of r.bills) assert.ok(settledOnVendorBill(t.ctx, b.vendorBillId) > 0);
});

test('B8.8: a run ALREADY marked paid by hand is MATCHED to its payments and posts nothing again', () => {
  const t = world();
  const r = run(t, 'paid', [60000, 40000]);
  must(markBatchPaid(t.ctx, { batchId: r.batchId, confirmation: true, valueDate: '2026-07-22', idempotencyKey: 'by-hand' }));
  const { lines } = importLines(t, { statementId: 'PR-2', openingMinor: 100000, entries: [{ ref: 'RUN', amountMinor: 100000, cd: 'DBIT', date: '2026-07-23', pmtInfId: frozenPmtInfId(t, r.batchId) }] });
  const p = lineOf(must(listBankInbox(t.ctx, {})), lines.RUN).proposal;
  assert.equal(p.reasonCode, 'payment_batch_reference', 'the paid run is still proposed by its PmtInfId');
  assert.equal(p.reasonParams.batchStatus, 'paid');
  const before = rowCounts(t.store, t.workspaceId);
  const matched = must(bookBankLine(t.ctx, { bankTxnId: lines.RUN, target: p.target, idempotencyKey: 'run' }));
  assert.equal(matched.state, 'matched', 'the payments existed, so the line is matched, not booked');
  const after = rowCounts(t.store, t.workspaceId);
  assert.equal(after.entries, before.entries, 'no second bank booking (the walk\'s double-booking risk)');
  assert.equal(after.payments, before.payments);
  assert.equal(balanceOf(t.store, t.workspaceId, '1020'), -100000, 'the bank moved exactly once');
  // A second line with the same PmtInfId cannot claim the same payments.
  const { lines: again } = importLines(t, { statementId: 'PR-3', seqNb: '2', entries: [{ ref: 'RUN2', amountMinor: 100000, cd: 'DBIT', pmtInfId: frozenPmtInfId(t, r.batchId) }] });
  refused(bookBankLine(t.ctx, { bankTxnId: again.RUN2, target: { kind: 'payment_batch', batchId: r.batchId }, idempotencyKey: 'run2' }), 'batch_already_linked');
});

test('a run whose total differs is shown for checking and refuses amount_mismatch naming both totals', () => {
  const t = world();
  const r = run(t, 'mis', [60000, 40000]);
  const { lines } = importLines(t, { statementId: 'PR-4', entries: [{ ref: 'RUN', amountMinor: 60000, cd: 'DBIT', pmtInfId: frozenPmtInfId(t, r.batchId) }] });
  const p = lineOf(must(listBankInbox(t.ctx, {})), lines.RUN).proposal;
  assert.equal(p.reasonCode, 'payment_batch_total_differs');
  assert.equal(p.certainty, 'check');
  assert.equal(p.target, null, 'no target that can only refuse (critic M5 lean)');
  const res = refused(bookBankLine(t.ctx, { bankTxnId: lines.RUN, target: { kind: 'payment_batch', batchId: r.batchId }, idempotencyKey: 'run' }), 'amount_mismatch');
  assert.equal(res.lineAmountMinor, 60000);
  assert.equal(res.batchTotalMinor, 100000);
});

test('L6: a run booked one line per payment (camt.053 mit Details): EndToEndId names the item, the first line marks the run paid', () => {
  const t = world();
  const r = run(t, 'item', [60000, 40000]);
  const items = t.store.db.prepare('SELECT id, amount_minor FROM payment_batch_item WHERE batch_id = ? ORDER BY rowid').all(r.batchId);
  const pmt = frozenPmtInfId(t, r.batchId);
  const { lines } = importLines(t, {
    statementId: 'IT-1',
    entries: [
      { ref: 'I1', amountMinor: 60000, cd: 'DBIT', pmtInfId: pmt, e2e: frozenEndToEndId(t, items[0].id) },
      { ref: 'I2', amountMinor: 40000, cd: 'DBIT', pmtInfId: pmt, e2e: frozenEndToEndId(t, items[1].id) },
    ],
  });
  const inbox = must(listBankInbox(t.ctx, {}));
  for (const ref of ['I1', 'I2']) {
    const p = lineOf(inbox, lines[ref]).proposal;
    assert.equal(p.reasonCode, 'payment_batch_item');
    assert.equal(p.certainty, 'sure', 'TILL\'s own EndToEndId and the item amount prove it');
  }
  const first = must(bookBankLine(t.ctx, { bankTxnId: lines.I1, target: { kind: 'payment_batch', batchId: r.batchId }, idempotencyKey: 'i1' }));
  assert.equal(first.state, 'booked', 'the first item line marks the generated run paid');
  assert.equal(first.paymentIds.length, 1, 'and accounts for its own payment only');
  assert.equal(t.store.db.prepare('SELECT status FROM payment_batch WHERE id = ?').get(r.batchId).status, 'paid');
  const before = rowCounts(t.store, t.workspaceId);
  const second = must(bookBankLine(t.ctx, { bankTxnId: lines.I2, target: lineOf(must(listBankInbox(t.ctx, {})), lines.I2).proposal.target, idempotencyKey: 'i2' }));
  assert.equal(second.state, 'matched', 'the run is paid: the second item line matches and posts nothing');
  assert.equal(rowCounts(t.store, t.workspaceId).entries, before.entries);
  assert.equal(balanceOf(t.store, t.workspaceId, '1020'), -100000, 'the bank moved once per payment');
  // An item line whose amount is not its item's refuses, naming both.
  const { lines: odd } = importLines(t, { statementId: 'IT-2', seqNb: '2', entries: [{ ref: 'I3', amountMinor: 1, cd: 'DBIT', e2e: frozenEndToEndId(t, items[0].id) }] });
  const res = refused(bookBankLine(t.ctx, { bankTxnId: odd.I3, target: { kind: 'payment_batch', batchId: r.batchId }, idempotencyKey: 'i3' }), 'amount_mismatch');
  assert.equal(res.itemAmountMinor, 60000);
});

test('L6/C8: a run in another currency refuses currency_mismatch with the parked fix; a bill of a live run refuses already_batched', () => {
  const t = world();
  const r = run(t, 'cur', [30000]);
  t.store.db.prepare("UPDATE payment_batch_item SET currency = 'EUR' WHERE batch_id = ?").run(r.batchId);
  const { lines } = importLines(t, { statementId: 'CU-1', entries: [{ ref: 'EUR', amountMinor: 30000, cd: 'DBIT', pmtInfId: frozenPmtInfId(t, r.batchId) }] });
  assert.equal(lineOf(must(listBankInbox(t.ctx, {})), lines.EUR).proposal.reasonCode === 'payment_batch_reference', false, 'a run in another currency is never proposed');
  const res = refused(bookBankLine(t.ctx, { bankTxnId: lines.EUR, target: { kind: 'payment_batch', batchId: r.batchId }, idempotencyKey: 'eur' }), 'currency_mismatch');
  assert.match(res.fix, /creditor-payments/);
  t.store.db.prepare("UPDATE payment_batch_item SET currency = 'CHF' WHERE batch_id = ?").run(r.batchId);
  // The run's bill cannot be settled from another line: the run pays it.
  const held = refused(bookBankLine(t.ctx, { bankTxnId: lines.EUR, target: { kind: 'open_item', documentId: r.bills[0].vendorBillId }, idempotencyKey: 'bill' }), 'already_batched');
  assert.equal(held.batchId, r.batchId);
});

// ================================================================================================
// 6. Undo without editing history (walk B11.2, B14.5)
// ================================================================================================

test('B11.2: reopening a booked line reverses its entry, supersedes the link, and the line books anew', () => {
  const t = world();
  const { lines } = importLines(t, { statementId: 'RO-1', entries: [{ ref: 'FEE', amountMinor: 700, cd: 'DBIT' }] });
  const first = must(bookBankLine(t.ctx, { bankTxnId: lines.FEE, target: { kind: 'accounts', legs: [{ accountId: t.acc('6500'), amountMinor: 700 }] }, idempotencyKey: 'b1' }));
  const reopened = must(reopenBankLine(t.ctx, { bankTxnId: lines.FEE, reason: 'falsches Konto', idempotencyKey: 'r1' }));
  assert.equal(reopened.previousState, 'booked');
  assert.deepEqual(reopened.reversedEntryIds, [first.entryId]);
  assert.equal(reopened.supersededLinkId, first.linkId);
  const original = t.store.db.prepare('SELECT status FROM journal_entry WHERE id = ?').get(first.entryId);
  assert.equal(original.status, 'posted', 'the original entry is untouched: the correction is a new entry');
  const reversal = t.store.db.prepare('SELECT id FROM journal_entry WHERE reverses_entry_id = ?').get(first.entryId);
  assert.ok(reversal, 'a reversing entry was posted');
  const stamped = t.store.db.prepare('SELECT superseded_at, superseded_by, supersede_reason FROM bank_line_decision WHERE link_id = ?').get(first.linkId);
  assert.ok(stamped.superseded_at !== null && stamped.supersede_reason === 'falsches Konto', 'the old link is stamped, with who and why');
  assert.equal(balanceOf(t.store, t.workspaceId, '6500'), 0);
  const second = must(bookBankLine(t.ctx, { bankTxnId: lines.FEE, target: { kind: 'accounts', legs: [{ accountId: t.acc('6800'), amountMinor: 700 }] }, idempotencyKey: 'b2' }));
  assert.notEqual(second.linkId, first.linkId);
  assert.equal(balanceOf(t.store, t.workspaceId, '6800'), 700);
  assert.equal(t.store.db.prepare('SELECT COUNT(*) AS n FROM bank_txn_link WHERE bank_txn_id = ?').get(lines.FEE).n, 2, 'both links are on record, none deleted');
  // The statement list and the board agree with the inbox.
  assert.equal(must(listBankStatements(t.ctx, {})).statements[0].openCount, 0);
});

test('L3: the journal Storno of an entry a line holds refuses owned_by reopen_bank_line; reopening reverses it once', () => {
  const t = world();
  const { lines } = importLines(t, { statementId: 'RO-2', entries: [{ ref: 'FEE', amountMinor: 700, cd: 'DBIT' }] });
  const booked = must(bookBankLine(t.ctx, { bankTxnId: lines.FEE, target: { kind: 'accounts', legs: [{ accountId: t.acc('6500'), amountMinor: 700 }] }, idempotencyKey: 'b' }));
  const before = rowCounts(t.store, t.workspaceId);
  const raw = refused(reverseEntry(t.ctx, { entryId: booked.entryId, idempotencyKey: 'by-hand' }), 'owned_by');
  assert.equal(raw.verb, 'reopen_bank_line');
  assert.equal(raw.bankTxnId, lines.FEE, 'the refusal names the line that holds the entry');
  assert.deepEqual(rowCounts(t.store, t.workspaceId), before, 'the refused Storno moved nothing');
  const reopened = must(reopenBankLine(t.ctx, { bankTxnId: lines.FEE, reason: 'falsch gebucht', idempotencyKey: 'r' }));
  assert.deepEqual(reopened.reversedEntryIds, [booked.entryId]);
  assert.equal(rowCounts(t.store, t.workspaceId).entries, before.entries + 1, 'exactly one reversal');
  assert.equal(must(listBankInbox(t.ctx, {})).total, 1, 'the line is open again');
  // The reversed camt entry and its Storno stay owned: the raw tool refuses both.
  refused(reverseEntry(t.ctx, { entryId: booked.entryId, idempotencyKey: 'again' }), 'owned_by');
  const storno = t.store.db.prepare('SELECT id FROM journal_entry WHERE reverses_entry_id = ?').get(booked.entryId).id;
  refused(reverseEntry(t.ctx, { entryId: storno, idempotencyKey: 'storno' }), 'owned_by');
});

test('reopening a settlement reverses the payment and the invoice is open again; a match only unlinks', () => {
  const t = world();
  const inv = issueInvoice(t.ctx, { contactId: t.customerId, key: 'ro3' });
  const e = manualEntry(t, 'ro3-e', [{ account: t.acc('6500'), debit: 300 }, { account: t.acc('1020'), credit: 300 }]);
  const { lines } = importLines(t, { statementId: 'RO-3', entries: [{ ref: 'PAY', amountMinor: GROSS, cd: 'CRDT', qrr: buildQrrReference(inv.number) }, { ref: 'M', amountMinor: 300, cd: 'DBIT' }] });
  const paid = must(bookBankLine(t.ctx, { bankTxnId: lines.PAY, target: { kind: 'open_item', documentId: inv.id }, idempotencyKey: 'pay' }));
  must(bookBankLine(t.ctx, { bankTxnId: lines.M, target: { kind: 'existing_entry', entryId: e.entryId }, idempotencyKey: 'm' }));
  const r1 = must(reopenBankLine(t.ctx, { bankTxnId: lines.PAY, reason: 'falsche Rechnung', idempotencyKey: 'r1' }));
  assert.deepEqual(r1.reversedPaymentIds, [paid.paymentId]);
  assert.equal(t.store.db.prepare('SELECT status FROM payment WHERE id = ?').get(paid.paymentId).status, 'reversed');
  assert.notEqual(t.store.db.prepare('SELECT status FROM document WHERE id = ?').get(inv.id).status, 'settled');
  const credit = t.store.db.prepare('SELECT status, reversed_payment_ids FROM reconciliation_match WHERE bank_txn_id = ?').get(lines.PAY);
  assert.equal(credit.status, 'open', 'the credit is back in the QR queue');
  assert.deepEqual(JSON.parse(credit.reversed_payment_ids), [paid.paymentId]);
  const before = rowCounts(t.store, t.workspaceId);
  const r2 = must(reopenBankLine(t.ctx, { bankTxnId: lines.M, reason: 'andere Buchung', idempotencyKey: 'r2' }));
  assert.equal(r2.previousState, 'matched');
  assert.equal(rowCounts(t.store, t.workspaceId).entries, before.entries, 'unlinking a match reverses nothing');
  // The entry is free again: the proposal comes back.
  assert.equal(lineOf(must(listBankInbox(t.ctx, {})), lines.M).proposal.target.entryId, e.entryId);
});

// ================================================================================================
// 7. Ignore (owner answer 1, walk B10)
// ================================================================================================

test('B10: an ignored line leaves the inbox and every count, a dismissed credit IS an ignored line', () => {
  const t = world();
  const { statementId, lines } = importLines(t, {
    statementId: 'IG-1',
    entries: [
      { ref: 'TURN', amountMinor: 55000, cd: 'CRDT', name: 'Kartenterminal Sammelgutschrift' },
      { ref: 'QX', amountMinor: 1234, cd: 'CRDT', name: 'Unbekannt' },
      { ref: 'FEE', amountMinor: 300, cd: 'DBIT' },
    ],
  });
  refused(ignoreBankLine(t.ctx, { bankTxnId: lines.TURN, reason: 'because', idempotencyKey: 'bad' }), 'invalid_input');
  const ig = must(ignoreBankLine(t.ctx, { bankTxnId: lines.TURN, reason: 'clearing_account', note: 'über 1091 gebucht', idempotencyKey: 'ig' }));
  assert.equal(ig.state, 'ignored');
  assert.equal(must(ignoreBankLine(t.ctx, { bankTxnId: lines.TURN, reason: 'clearing_account', idempotencyKey: 'ig-2' })).alreadyIgnored, true);
  const credit = (id) => t.store.db.prepare('SELECT status FROM reconciliation_match WHERE bank_txn_id = ?').get(id).status;
  assert.equal(credit(lines.TURN), 'dismissed', 'the credit left the QR queue with it');

  // A21's "Keine Kundenzahlung" on an imported credit refuses (L2): the line is ignored on the inbox.
  const qx = t.store.db.prepare('SELECT id FROM reconciliation_match WHERE bank_txn_id = ?').get(lines.QX).id;
  refused(overrideQrMatch(t.ctx, { creditId: qx, action: 'dismiss', idempotencyKey: 'dismiss' }), 'use_bank_inbox');
  must(ignoreBankLine(t.ctx, { bankTxnId: lines.QX, reason: 'other', idempotencyKey: 'ig-qx' }));
  assert.equal(credit(lines.QX), 'dismissed');
  const all = must(listBankInbox(t.ctx, { status: 'all' }));
  assert.equal(lineOf(all, lines.QX).state, 'ignored');
  assert.equal(lineOf(all, lines.TURN).decision.ignoreReason, 'clearing_account');

  const open = must(listBankInbox(t.ctx, {}));
  assert.deepEqual(open.lines.map((l) => l.bankTxnId), [lines.FEE], 'only the fee is still to decide');
  assert.equal(must(listBankStatements(t.ctx, {})).statements[0].openCount, 1, 'the statement list counts the same one line');
  const board = must(listReconciliation(t.ctx, { statementId }));
  assert.equal(board.ignored.length, 2, 'the board keeps ignored lines out of its three lanes');
  assert.equal(board.unmatched.length, 1);
  const s = open.summary[0];
  // L4: an ignored line whose money is not on the books simply shows as a difference.
  assert.equal(s.differenceMinor, 56234, 'bank 559.34 - ledger 0 - open -3.00: the ignored money is missing from the books');

  // A booked line is not ignored: its decision is undone with reopen_bank_line first.
  must(bookBankLine(t.ctx, { bankTxnId: lines.FEE, target: { kind: 'accounts', legs: [{ accountId: t.acc('6500'), amountMinor: 300 }] }, idempotencyKey: 'fee' }));
  refused(ignoreBankLine(t.ctx, { bankTxnId: lines.FEE, reason: 'other', idempotencyKey: 'x' }), 'line_not_open');
  // reopen_bank_line brings an ignored line back (it replaced unignore) and posts nothing.
  const before = rowCounts(t.store, t.workspaceId);
  assert.equal(must(reopenBankLine(t.ctx, { bankTxnId: lines.TURN, reason: 'doch buchen', idempotencyKey: 'un' })).previousState, 'ignored');
  assert.equal(rowCounts(t.store, t.workspaceId).entries, before.entries, 'bringing an ignored line back posts nothing');
  assert.equal(credit(lines.TURN), 'open', 'the credit is back in the queue');
  assert.equal(must(listBankInbox(t.ctx, {})).total, 1);
  assert.equal(must(reopenBankLine(t.ctx, { bankTxnId: lines.QX, reason: 'doch Kundenzahlung', idempotencyKey: 'rq' })).previousState, 'ignored');
  assert.equal(credit(lines.QX), 'open');
  assert.equal(must(listBankInbox(t.ctx, {})).total, 2);
});

// ================================================================================================
// 8. The balance truth and G22's check (walk B16, B17.2, B17.3)
// ================================================================================================

test('D139: an account without a camt.053, or a period before its first statement, reads not_started and passes', () => {
  const t = world();
  // Books before the first statement (a migrated bexio year) never make an earlier period fail.
  manualEntry(t, 'bexio', [{ account: t.acc('1020'), debit: 90000 }, { account: t.acc('3000'), credit: 90000 }], '2026-04-10');
  let res = bankReconciledForPeriod(t.ctx, '2026-04-01', '2026-06-30');
  assert.equal(res.passed, true);
  assert.equal(res.accounts[0].status, 'not_started');
  importLines(t, { statementId: 'FIRST', from: '2026-09-10', to: '2026-09-30', openingMinor: 90000, entries: [] });
  res = bankReconciledForPeriod(t.ctx, '2026-04-01', '2026-06-30');
  assert.equal(res.accounts[0].status, 'not_started', 'Q2 ends before the first statement opens');
  res = bankReconciledForPeriod(t.ctx, '2026-07-01', '2026-09-30');
  assert.equal(res.accounts[0].status, 'reconciled', 'Q3 is judged at its end, from the first statement');
  res = bankReconciledForPeriod(t.ctx, '2026-10-01', '2026-12-31');
  assert.equal(res.passed, false);
  assert.equal(res.accounts[0].status, 'not_covered', 'no statement reaches the Q4 end');
  assert.equal(res.accounts[0].action, 'import_camt');
});

test('B17.2: the check compares the statement balance with the ledger and names the difference', () => {
  const t = world();
  // One statement covering the whole quarter (critic A39-10: a period is judged at its END).
  const { lines } = importLines(t, { statementId: 'G-1', to: '2026-09-30', openingMinor: 0, entries: [{ ref: 'FEE', amountMinor: 700, cd: 'DBIT', date: '2026-07-10' }] });
  let res = bankReconciledForPeriod(t.ctx, '2026-07-01', '2026-09-30');
  assert.equal(res.passed, false);
  assert.equal(res.openLines, 1);
  assert.equal(res.accounts[0].status, 'open_lines');
  assert.equal(res.accounts[0].differenceMinor, -700, 'the bank is CHF 7.00 below the books');
  must(bookBankLine(t.ctx, { bankTxnId: lines.FEE, target: { kind: 'accounts', legs: [{ accountId: t.acc('6500'), amountMinor: 700 }] }, idempotencyKey: 'fee' }));
  res = bankReconciledForPeriod(t.ctx, '2026-07-01', '2026-09-30');
  assert.equal(res.passed, true);
  assert.equal(res.accounts[0].status, 'reconciled');
  // The G22 check is this read, with the figures in its detail.
  const check = evaluateCheck(t.ctx, 'bank_reconciled', { periodStart: '2026-07-01', periodEnd: '2026-09-30', label: '2026-Q3' }, {});
  assert.equal(check.passed, true);
  assert.equal(check.detail.accounts[0].status, 'reconciled');

  // A statement whose closing balance disagrees names the gap even with every line decided.
  importLines(t, { statementId: 'G-2', seqNb: '2', from: '2026-09-15', to: '2026-09-30', openingMinor: -700, closingMinor: -1000, entries: [] });
  res = bankReconciledForPeriod(t.ctx, '2026-07-01', '2026-09-30');
  assert.equal(res.passed, false);
  assert.equal(res.accounts[0].differenceMinor, -300);
});

test('B17.3: an old open line counts only in its OWN period, never in every later one', () => {
  const t = world();
  importLines(t, { statementId: 'Q1', from: '2026-03-01', to: '2026-03-31', openingMinor: 0, entries: [{ ref: 'OLD', amountMinor: 1000, cd: 'DBIT', date: '2026-03-15' }] });
  // Q3 has its own statement, reconciled: the old Q1 line is carried in the opening balance, and the
  // books got the money another way (a manual entry), so the balance agrees.
  manualEntry(t, 'q1-manual', [{ account: t.acc('6500'), debit: 1000 }, { account: t.acc('1020'), credit: 1000 }], '2026-03-15');
  importLines(t, { statementId: 'Q3', seqNb: '2', from: '2026-07-01', to: '2026-09-30', openingMinor: -1000, closingMinor: -1000, entries: [] });
  const q3 = bankReconciledForPeriod(t.ctx, '2026-07-01', '2026-09-30');
  assert.equal(q3.openLines, 0, 'the March line does not count in Q3');
  assert.equal(q3.passed, true);
  const q1 = bankReconciledForPeriod(t.ctx, '2026-01-01', '2026-03-31');
  assert.equal(q1.openLines, 1, 'it counts in its own quarter');
  assert.equal(q1.passed, false);
});

test('L4: an entry on the bank account that no line backs shows as a difference in the balance line', () => {
  const t = world();
  manualEntry(t, 'cash-in', [{ account: t.acc('1020'), debit: 5000 }, { account: t.acc('3000'), credit: 5000 }], '2026-07-15');
  importLines(t, { statementId: 'SU-1', openingMinor: 0, closingMinor: 0, entries: [] });
  const s = must(listBankInbox(t.ctx, {})).summary[0];
  assert.equal(s.judgeable, true);
  assert.equal(s.bankBalanceMinor, 0);
  assert.equal(s.ledgerBalanceMinor, 5000);
  assert.equal(s.openSumMinor, 0);
  assert.equal(s.differenceMinor, -5000, 'the booking the bank never saw');
});

// ================================================================================================
// 9. One door per imported line (L2)
// ================================================================================================

test('L2: the A21 dial never applies an imported credit, and the queue refuses it; the row follows its line', () => {
  const t = world();
  must(setQrAutoApply(t.ctx, { autoApply: true, idempotencyKey: 'dial' }));
  const inv = issueInvoice(t.ctx, { contactId: t.customerId, key: 'a21' });
  const { lines } = importLines(t, { statementId: 'A21-1', entries: [{ ref: 'Q', amountMinor: GROSS, cd: 'CRDT', qrr: buildQrrReference(inv.number) }] });
  const line = lineOf(must(listBankInbox(t.ctx, {})), lines.Q);
  assert.equal(line.state, 'open', 'nothing was applied at import');
  assert.equal(line.proposal.certainty, 'sure');
  const creditId = t.store.db.prepare('SELECT id FROM reconciliation_match WHERE bank_txn_id = ?').get(lines.Q).id;
  const before = rowCounts(t.store, t.workspaceId);
  refused(applyQrMatch(t.ctx, { creditId, invoiceId: inv.id, mode: 'full', confirmed: true, idempotencyKey: 'ap' }), 'use_bank_inbox');
  refused(overrideQrMatch(t.ctx, { creditId, action: 'unmatch', confirmed: true, idempotencyKey: 'un' }), 'use_bank_inbox');
  assert.deepEqual(rowCounts(t.store, t.workspaceId), before, 'the refusals moved nothing');
  const status = () => t.store.db.prepare('SELECT status FROM reconciliation_match WHERE id = ?').get(creditId).status;
  must(bookBankLine(t.ctx, { bankTxnId: lines.Q, target: line.proposal.target, idempotencyKey: 'book' }));
  assert.equal(status(), 'applied', 'the queue row follows the booked line');
  must(reopenBankLine(t.ctx, { bankTxnId: lines.Q, reason: 'falsch', idempotencyKey: 'ro' }));
  assert.equal(status(), 'open', 'and the reopened line');
  // A hand-typed credit keeps its A21 verbs.
  const typed = must(recordIncomingCredit(t.ctx, { bankAccountId: t.bankAccountId, amountMinor: 500, valueDate: '2026-07-20', idempotencyKey: 'typed' }));
  must(overrideQrMatch(t.ctx, { creditId: typed.credit.creditId, action: 'dismiss', idempotencyKey: 'typed-d' }));
});

// ================================================================================================
// 10. Stale decisions (walk B14.3) and late lines (spec §0 item 6)
// ================================================================================================

test('B14.3: a stale second decision refuses and says whose decision holds the line', () => {
  const t = world();
  const { lines } = importLines(t, { statementId: 'ST-1', entries: [{ ref: 'A10', amountMinor: 4200, cd: 'DBIT' }] });
  const human = must(bookBankLine(t.ctx, { bankTxnId: lines.A10, target: { kind: 'accounts', legs: [{ accountId: t.acc('6500'), amountMinor: 4200 }] }, idempotencyKey: 'human' }));
  const before = rowCounts(t.store, t.workspaceId);
  const stale = refused(createEntryForTxn(t.ctx, { bankTxnId: lines.A10, contraAccountId: t.acc('6800'), idempotencyKey: 'agent-draft' }), 'line_not_open');
  assert.equal(stale.staleProposal, true);
  assert.equal(stale.state, 'booked');
  assert.equal(stale.linkId, human.linkId);
  refused(confirmCamtMatch(t.ctx, { bankTxnId: lines.A10, entryId: human.entryId, idempotencyKey: 'agent-confirm' }), 'line_not_open');
  assert.deepEqual(rowCounts(t.store, t.workspaceId), before, 'nothing ran');
});

test('L5: a line in a closed month refuses period_locked unchanged; a date override is refused; ignoring works in any period', () => {
  const t = world({ realPeriods: true });
  must(softCloseMonth(t.ctx, { period: '2026-07', idempotencyKey: 'close' }));
  const { lines } = importLines(t, { statementId: 'PL-1', entries: [{ ref: 'LATE', amountMinor: 800, cd: 'DBIT', date: '2026-07-20' }] });
  const target = { kind: 'accounts', legs: [{ accountId: t.acc('6500'), amountMinor: 800 }] };
  const res = refused(bookBankLine(t.ctx, { bankTxnId: lines.LATE, target, idempotencyKey: 'late' }), 'period_locked');
  assert.equal(res.suggestion, undefined, "A03's refusal passes through, no rebooking into another period");
  refused(bookBankLine(t.ctx, { bankTxnId: lines.LATE, target, date: '2026-08-01', idempotencyKey: 'late-2' }), 'invalid_input');
  refused(reopenBankLine(t.ctx, { bankTxnId: lines.LATE, reason: 'x', date: '2026-08-01', idempotencyKey: 'late-3' }), 'invalid_input');
  // Ignoring posts nothing, so it works in a closed month; so does bringing the line back.
  must(ignoreBankLine(t.ctx, { bankTxnId: lines.LATE, reason: 'booked_elsewhere', idempotencyKey: 'ig' }));
  must(reopenBankLine(t.ctx, { bankTxnId: lines.LATE, reason: 'zurück', idempotencyKey: 'ro' }));
});

// ================================================================================================
// 11. Learning: history (owner answer 2; bank rules are parked, spec §10)
// ================================================================================================

test('history pre-fills the account and VAT code this counterparty was booked to last time, with the count', () => {
  const t = world();
  const { lines } = importLines(t, { statementId: 'H-1', entries: [{ ref: 'T1', amountMinor: 8990, cd: 'DBIT', name: 'Alpina Telecom AG', iban: TELCO_IBAN, date: '2026-07-05' }] });
  must(bookBankLine(t.ctx, { bankTxnId: lines.T1, target: { kind: 'accounts', legs: [{ accountId: t.acc('6500'), amountMinor: 8990, taxCode: 'VST-M' }] }, idempotencyKey: 't1' }));
  const { lines: next } = importLines(t, { statementId: 'H-2', seqNb: '2', entries: [{ ref: 'T2', amountMinor: 9120, cd: 'DBIT', name: 'Alpina Telecom AG', iban: TELCO_IBAN, date: '2026-07-28' }] });
  const p = lineOf(must(listBankInbox(t.ctx, {})), next.T2).proposal;
  assert.equal(p.certainty, 'learned');
  assert.equal(p.reasonCode, 'history');
  assert.equal(p.reasonParams.count, 1);
  assert.equal(p.vatCode, 'VST-M');
  assert.deepEqual(p.target, { kind: 'accounts', legs: [{ accountId: t.acc('6500'), amountMinor: 9120, taxCode: 'VST-M' }] });
});

// ================================================================================================
// 12. The camt door (walk B2.2, frame §4 item 10 (d))
// ================================================================================================

test('an archived Bankkonto refuses a statement', () => {
  const t = world();
  must(archiveBankAccount(t.ctx, { bankAccountId: t.bankAccountId, idempotencyKey: 'arch' }));
  refused(importCamt(t.ctx, { bankAccountId: t.bankAccountId, xml: camt({ statementId: 'AR-1', entries: [{ ref: 'X', amountMinor: 100, cd: 'DBIT' }] }), idempotencyKey: 'ar' }), 'bank_account_archived');
});

test('the camt import stores the counterparty facts the proposals read, outside the statement identity', () => {
  const t = world();
  const { lines } = importLines(t, { statementId: 'CP-1', entries: [{ ref: 'X', amountMinor: 100, cd: 'DBIT', name: 'Gartenbau Seewis GmbH', iban: TELCO_IBAN, ustrd: 'Rechnung 4711', e2e: 'E2E-1' }] });
  const d = t.store.db.prepare('SELECT counterparty_name, counterparty_iban, remittance_text, end_to_end_id FROM bank_txn_detail WHERE bank_txn_id = ?').get(lines.X);
  assert.deepEqual(d, { counterparty_name: 'Gartenbau Seewis GmbH', counterparty_iban: TELCO_IBAN, remittance_text: 'Rechnung 4711', end_to_end_id: 'E2E-1' });
  const again = must(importCamt(t.ctx, { bankAccountId: t.bankAccountId, xml: camt({ statementId: 'CP-1', entries: [{ ref: 'X', amountMinor: 100, cd: 'DBIT', name: 'Gartenbau Seewis GmbH', iban: TELCO_IBAN, ustrd: 'Rechnung 4711', e2e: 'E2E-1' }] }), idempotencyKey: 'again' }));
  assert.equal(again.duplicate, true, 'a byte-identical re-import is still a safe duplicate');
});

// ================================================================================================
// 13. The landscape sanitiser (lean critic C12)
// ================================================================================================

test('C12: a pseudonymized copy masks the counterparty a line names and redacts its remittance and supersede reason', () => {
  const t = world();
  const { lines } = importLines(t, { statementId: 'SAN-1', entries: [{ ref: 'X', amountMinor: 100, cd: 'DBIT', name: 'Gartenbau Seewis GmbH', iban: TELCO_IBAN, ustrd: 'Rechnung 4711', e2e: 'E2E-SAN-1' }] });
  must(bookBankLine(t.ctx, { bankTxnId: lines.X, target: { kind: 'accounts', legs: [{ accountId: t.acc('6500'), amountMinor: 100 }] }, idempotencyKey: 'b' }));
  must(reopenBankLine(t.ctx, { bankTxnId: lines.X, reason: 'Herr Muster hat angerufen', idempotencyKey: 'r' }));
  const copy = new Database(t.store.db.serialize());
  try {
    // The landscape copy suspends the append-only guards while it transforms its clone; so does this probe.
    for (const g of copy.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND sql LIKE '%RAISE(ABORT%'").all()) copy.exec(`DROP TRIGGER "${g.name}"`);
    applySanitization(copy, { level: 'pseudonymize', workspaceIds: [t.workspaceId] });
    const d = copy.prepare('SELECT counterparty_name, counterparty_iban, remittance_text, end_to_end_id FROM bank_txn_detail WHERE bank_txn_id = ?').get(lines.X);
    assert.notEqual(d.counterparty_name, 'Gartenbau Seewis GmbH');
    assert.notEqual(d.counterparty_iban, TELCO_IBAN);
    assert.match(d.remittance_text, /^\[redigiert /);
    assert.equal(d.end_to_end_id, 'E2E-SAN-1', 'an identifier, TILL\'s own match key, stays');
    const reason = copy.prepare('SELECT supersede_reason FROM bank_line_decision WHERE bank_txn_id = ? AND superseded_at IS NOT NULL').get(lines.X).supersede_reason;
    assert.match(reason, /^\[redigiert /);
  } finally {
    copy.close();
  }
});
