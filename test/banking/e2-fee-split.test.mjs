// D178 point 3 (spec A20 §11.5, A39 §19): the fee of a card payment, proposed onto the bank-charges
// account under the setting `bank.fx_mode`. propose_split (the default) offers it beside the proposal,
// prefill_split makes it the target, facts_only and transaction_currency (until its node lands) add nothing.
// The bank-charges account comes from the chart (bank.fee_account, else 6940, else 6900), never an id. The
// offered legs book as they stand. A credit, a fee not inside the amount, a settlement and a fee line get
// no split; the certainty never rises.
//
// SYNTHETIC DATA ONLY: fixtures/e2-camt053-card-fx.xml, fixtures/e2-mt940-two-days.sta and files spelled here.

import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { importCamt, listBankInbox, isProposalBookable } from '../../dist/core/banking/index.js';
import { importBankStatement } from '../../dist/core/banking/statementImport.js';
import { bookBankLine } from '../../dist/core/banking/bankBooking.js';
import { setBankStandard } from '../../dist/core/banking/bankStandards.js';
import { settingsSet } from '../../dist/core/settings/settings.js';
import { createAccount } from '../../dist/core/accounts/accounts.js';
import { world, must, legs, assertClaimInvariantHolds } from './bank-inbox-support.mjs';

afterEach(assertClaimInvariantHolds);

const HERE = dirname(fileURLToPath(import.meta.url));
const FX_XML = readFileSync(join(HERE, 'fixtures', 'e2-camt053-card-fx.xml'), 'utf8');
const STA = readFileSync(join(HERE, 'fixtures', 'e2-mt940-two-days.sta'), 'utf8');

/** The world with the card statement imported and a Buchungsregel for the bookshop onto 6500. */
function cardWorld({ rule = true } = {}) {
  const t = world();
  must(importCamt(t.ctx, { bankAccountId: t.bankAccountId, xml: FX_XML, idempotencyKey: 'fx' }));
  const card = t.store.db.prepare('SELECT id FROM bank_txn WHERE workspace_id = ? AND amount_minor = 4988').get(t.workspaceId).id;
  if (rule) must(setBankStandard(t.ctx, { bankTxnId: card, accountId: t.acc('6500'), taxCode: null, idempotencyKey: 'std' }));
  return { ...t, card };
}

const lineOf = (t, id) => must(listBankInbox(t.ctx, { bankTxnId: id, status: 'all' })).lines[0];
const setMode = (t, value) => must(settingsSet(t.ctx, { key: 'bank.fx_mode', value, reason: 'E2 test', idempotencyKey: `mode-${value}` }));

test('propose_split (default): the split is offered beside the unchanged proposal, fee on 6900 (no 6940 in the core chart)', () => {
  const t = cardWorld();
  const line = lineOf(t, t.card);
  assert.equal(line.proposal.reasonCode, 'standard');
  assert.equal(line.proposal.certainty, 'sure');
  assert.deepEqual(line.proposal.target.legs, [{ accountId: t.acc('6500'), amountMinor: 4988 }], 'the target is untouched');
  assert.deepEqual(line.proposal.feeSplit, {
    mode: 'propose_split',
    feeMinor: 62,
    restMinor: 4926,
    currency: 'CHF',
    feeAccountId: t.acc('6900'),
    restAccountId: t.acc('6500'),
    restTaxCode: null,
    legs: [
      { accountId: t.acc('6500'), amountMinor: 4926 },
      { accountId: t.acc('6900'), amountMinor: 62 },
    ],
    applied: false,
    origin: 'charges',
  });
  // The offered legs book as they stand: 6500 49.26 and 6900 0.62 against the bank 49.88.
  const booked = must(bookBankLine(t.ctx, { bankTxnId: t.card, target: { kind: 'accounts', legs: line.proposal.feeSplit.legs }, idempotencyKey: 'book' }));
  const posted = legs(t.store, booked.entryId);
  assert.deepEqual(posted.map((l) => [l.number, l.debit, l.credit]), [['1020', 0, 4988], ['6500', 4926, 0], ['6900', 62, 0]]);
});

test('the chart decides the fee account: 6940 Bankspesen when it exists; the setting bank.fee_account wins', () => {
  const t = cardWorld();
  const bankspesen = must(createAccount(t.ctx, { number: '6940', name: 'Bankspesen', type: 'expense', idempotencyKey: 'acc6940' })).accountId;
  assert.equal(lineOf(t, t.card).proposal.feeSplit.feeAccountId, bankspesen);
  must(settingsSet(t.ctx, { key: 'bank.fee_account', value: '6570', reason: 'E2 test', idempotencyKey: 'fee-acc' }));
  const custom = t.acc('6570');
  assert.ok(custom !== undefined, 'the core chart carries 6570');
  assert.equal(lineOf(t, t.card).proposal.feeSplit.feeAccountId, custom);
  must(settingsSet(t.ctx, { key: 'bank.fee_account', value: '9999', reason: 'E2 test', idempotencyKey: 'fee-acc-2' }));
  assert.equal(lineOf(t, t.card).proposal.feeSplit.feeAccountId, bankspesen, 'a number naming no account falls back to the chart');
});

test('prefill_split: the split IS the target, the certainty unchanged, bookable as it stands', () => {
  const t = cardWorld();
  setMode(t, 'prefill_split');
  const line = lineOf(t, t.card);
  assert.equal(line.proposal.certainty, 'sure', 'the certainty never changes');
  assert.deepEqual(line.proposal.target.legs, [
    { accountId: t.acc('6500'), amountMinor: 4926 },
    { accountId: t.acc('6900'), amountMinor: 62 },
  ]);
  assert.equal(line.proposal.feeSplit.applied, true);
  assert.equal(isProposalBookable(4988, line.proposal.target, line.proposal.reasonCode), true);
});

test('facts_only and transaction_currency: no split; the facts stay on the line', () => {
  for (const mode of ['facts_only', 'transaction_currency']) {
    const t = cardWorld();
    setMode(t, mode);
    const line = lineOf(t, t.card);
    assert.equal('feeSplit' in line.proposal, false, `${mode}: no feeSplit key`);
    assert.deepEqual(line.proposal.target.legs, [{ accountId: t.acc('6500'), amountMinor: 4988 }]);
    assert.equal(line.facts.fee.amountMinor, 62, `${mode}: the fee is still a fact`);
  }
});

test('an open line: the split names the fee account and leaves the rest account to the person; nothing becomes bookable', () => {
  const t = cardWorld({ rule: false });
  const line = lineOf(t, t.card);
  assert.equal(line.proposal.target, null);
  assert.equal(line.proposal.certainty, 'open');
  assert.equal(line.proposal.feeSplit.restAccountId, null);
  assert.equal(line.proposal.feeSplit.legs, null);
  assert.equal(line.proposal.feeSplit.applied, false);
  setMode(t, 'prefill_split');
  const pre = lineOf(t, t.card);
  assert.equal(pre.proposal.target, null, 'prefill never invents an account');
  assert.equal(pre.proposal.certainty, 'open');
});

test('the text fallback fee splits too; a fee NOT inside the amount, a credit and a fee line get none', () => {
  const t = cardWorld({ rule: false });
  const textLine = t.store.db.prepare('SELECT id FROM bank_txn WHERE workspace_id = ? AND amount_minor = 4023').get(t.workspaceId).id;
  assert.equal(lineOf(t, textLine).proposal.feeSplit.origin, 'text');
  assert.equal(lineOf(t, textLine).proposal.feeSplit.feeMinor, 75);
  // ChrgInclInd false: the fee was booked as its own line, so it is not inside this one.
  const apart = FX_XML.replace('<ChrgInclInd>true</ChrgInclInd>', '<ChrgInclInd>false</ChrgInclInd>').replace(/E2FX-/g, 'E2AP-');
  const u = world();
  must(importCamt(u.ctx, { bankAccountId: u.bankAccountId, xml: apart, idempotencyKey: 'apart' }));
  const apartLine = u.store.db.prepare('SELECT id FROM bank_txn WHERE workspace_id = ? AND amount_minor = 4988').get(u.workspaceId).id;
  const l = lineOf(u, apartLine);
  assert.equal(l.facts.fee.included, false);
  assert.equal('feeSplit' in l.proposal, false);
  // A credit with the payer's charges deducted (MT940 ?4:): a fact, never a split.
  const v = world();
  must(importBankStatement(v.ctx, { bankAccountId: v.bankAccountId, content: STA, idempotencyKey: 'sta' }));
  const credit = v.store.db.prepare("SELECT id FROM bank_txn WHERE workspace_id = ? AND credit_debit = 'CRDT' AND amount_minor = 68835").get(v.workspaceId).id;
  const c = lineOf(v, credit);
  assert.equal(c.facts.fee.amountMinor, 1200);
  assert.equal('feeSplit' in c.proposal, false);
  // A line the ladder already books to the bank-charges account is a fee line: nothing to split off it.
  const w = cardWorld({ rule: false });
  must(setBankStandard(w.ctx, { bankTxnId: w.card, accountId: w.acc('6900'), taxCode: null, idempotencyKey: 'std-fee' }));
  assert.equal('feeSplit' in lineOf(w, w.card).proposal, false);
});
