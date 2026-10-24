// CRITIC PROBES, D178 node E2 round 1 (non-author): the fee split proposal (A20 §11.5).
//
// Each probe asserts the CORRECT outcome; a failing probe is the evidence of a defect (see
// docs/critique/bank-parity-e2-critic-r1.md).
//
// SYNTHETIC BY CONSTRUCTION: the author's invented card statement (fixtures/e2-camt053-card-fx.xml) and
// values spelled here.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { importCamt, listBankInbox } from '../../dist/core/banking/index.js';
import { bookBankLine } from '../../dist/core/banking/bankBooking.js';
import { setBankStandard } from '../../dist/core/banking/bankStandards.js';
import { settingsSet } from '../../dist/core/settings/settings.js';
import { createAccount, archiveAccount } from '../../dist/core/accounts/accounts.js';
import { world, must } from '../banking/bank-inbox-support.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FX_XML = readFileSync(join(HERE, '..', 'banking', 'fixtures', 'e2-camt053-card-fx.xml'), 'utf8');

function cardWorld() {
  const t = world();
  must(importCamt(t.ctx, { bankAccountId: t.bankAccountId, xml: FX_XML, idempotencyKey: 'fx' }));
  const card = t.store.db.prepare('SELECT id FROM bank_txn WHERE workspace_id = ? AND amount_minor = 4988').get(t.workspaceId).id;
  must(setBankStandard(t.ctx, { bankTxnId: card, accountId: t.acc('6500'), taxCode: null, idempotencyKey: 'std' }));
  return { ...t, card };
}
const lineOf = (t, id) => must(listBankInbox(t.ctx, { bankTxnId: id, status: 'all' })).lines[0];

test('E2-F1: bank.fee_account naming the bank ledger itself (1020) is never proposed as the fee account', () => {
  const t = cardWorld();
  must(settingsSet(t.ctx, { key: 'bank.fee_account', value: '1020', reason: 'critic probe', idempotencyKey: 'fee-1020' }));
  must(settingsSet(t.ctx, { key: 'bank.fx_mode', value: 'prefill_split', reason: 'critic probe', idempotencyKey: 'mode' }));
  const line = lineOf(t, t.card);
  assert.notEqual(line.proposal.feeSplit?.feeAccountId, t.acc('1020'), `the split proposes the bank ledger: ${JSON.stringify(line.proposal.feeSplit)}`);
});

test('E2-F2 (sound check): an archived 6940 falls back to 6900', () => {
  const t = cardWorld();
  const id = must(createAccount(t.ctx, { number: '6940', name: 'Bankspesen', type: 'expense', idempotencyKey: 'a6940' })).accountId;
  assert.equal(lineOf(t, t.card).proposal.feeSplit.feeAccountId, id);
  const archived = archiveAccount(t.ctx, { accountId: id, idempotencyKey: 'arch' });
  assert.equal(archived.ok, true, JSON.stringify(archived));
  assert.equal(lineOf(t, t.card).proposal.feeSplit.feeAccountId, t.acc('6900'));
});

test('E2-F3 (sound check): the prefilled split books to the Rappen and only on the person\'s booking', () => {
  const t = cardWorld();
  must(settingsSet(t.ctx, { key: 'bank.fx_mode', value: 'prefill_split', reason: 'critic probe', idempotencyKey: 'mode' }));
  const before = t.store.db.prepare('SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ?').get(t.workspaceId).n;
  const line = lineOf(t, t.card);
  assert.equal(t.store.db.prepare('SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ?').get(t.workspaceId).n, before, 'reading proposes, never posts');
  const sum = line.proposal.target.legs.reduce((s, l) => s + l.amountMinor, 0);
  assert.equal(sum, 4988);
  must(bookBankLine(t.ctx, { bankTxnId: t.card, target: line.proposal.target, idempotencyKey: 'book' }));
});
