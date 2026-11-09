// A39, the walk (spec §8): one day-end camt.053 of a Geschäftskonto and the same day of its Sparkonto,
// imported and booked line by line exactly as the owner does at go-live (D139): the QR credit settles its
// invoice, a credit already on the books from the migration is matched, the bank fee and a card purchase
// with Vorsteuer are booked to accounts, TILL's payment run arrives one detail per payment, and an
// own-account transfer is confirmed on side one and matched on side two. Bank equals books per account,
// the MWST checklist's "Bank abgestimmt" passes for the quarter and reads not_started for the one
// before, a re-import adds nothing, a second confirmation moves nothing, and an undo nets once.
//
// SYNTHETIC DATA ONLY: fixtures/bank-inbox-day-camt053.xml and fixtures/bank-inbox-day-savings-camt053.xml
// (invented values; four placeholders filled from the books this test builds).

import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  createBankAccount,
  setBankOpeningBalance,
  setCreditorBankProfile,
  createPaymentBatch,
  generatePain001,
  importCamt,
  listBankInbox,
  bookBankLine,
  reopenBankLine,
} from '../../dist/core/banking/index.js';
import { frozenPmtInfId, frozenEndToEndId } from './frozen-refs-support.mjs';
import { buildQrrReference } from '../../dist/core/payments/reference.js';
import { postEntry } from '../../dist/core/ledger/index.js';
import { checklistStart, checklistGet } from '../../dist/core/checklists/index.js';
import { seedOpeningBalanceAccount } from './support.mjs';
import { assertClaimInvariantHolds, world, postedBill, issueInvoice, must, refused, rowCounts, legs, balanceOf, SAVINGS_IBAN } from './bank-inbox-support.mjs';
import { legClaimViolations } from './bank-inbox-invariants.mjs';

afterEach(assertClaimInvariantHolds);

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const read = (name) => readFileSync(join(FIXTURES, name), 'utf8');

/** The books before the day: two Bankkonten with their opening, an invoice, a migrated receipt, a run. */
function goLiveBook() {
  const t = world();
  seedOpeningBalanceAccount(t.ctx);
  const sav = must(createBankAccount(t.ctx, { name: 'Sparkonto', iban: SAVINGS_IBAN, currency: 'CHF', ledgerAccountId: t.acc('1000'), idempotencyKey: 'sav' })).bankAccountId;
  must(setBankOpeningBalance(t.ctx, { bankAccountId: t.bankAccountId, amountMinor: 2000000, currency: 'CHF', date: '2026-09-29', idempotencyKey: 'ob-main' }));
  must(setBankOpeningBalance(t.ctx, { bankAccountId: sav, amountMinor: 3000000, currency: 'CHF', date: '2026-09-29', idempotencyKey: 'ob-sav' }));
  const inv = issueInvoice(t.ctx, { contactId: t.customerId, key: 'day-inv' });
  // A receipt the migration already booked (a bexio entry), whose bank line arrives on the day.
  const migrated = must(postEntry(t.ctx, { date: '2026-09-29', source: 'manual', description: 'Übernahme: Akonto Pflegevertrag', idempotencyKey: 'migrated', lines: [{ account: t.acc('1020'), debit: 50000 }, { account: t.acc('3400'), credit: 50000 }] }));
  const bills = [60000, 40000].map((a, i) => postedBill(t, { grossMinor: a, seed: `day-${i}`, vendorName: i === 0 ? 'Lieferant Tannenweg AG' : 'Lieferant Birkenhof GmbH' }));
  for (const [i, b] of bills.entries()) must(setCreditorBankProfile(t.ctx, { vendorId: b.vendorId, iban: 'CH7200235123456789012', idempotencyKey: `day-cbp-${i}` }));
  const batch = must(createPaymentBatch(t.ctx, { bankAccountId: t.bankAccountId, itemIds: bills.map((b) => b.vendorBillId), executionDate: '2026-09-30', idempotencyKey: 'day-run' }));
  must(generatePain001(t.ctx, { batchId: batch.batchId, idempotencyKey: 'day-gen' }));
  const items = t.store.db.prepare('SELECT id, amount_minor FROM payment_batch_item WHERE batch_id = ? ORDER BY rowid').all(batch.batchId);
  assert.deepEqual(items.map((i) => i.amount_minor), [60000, 40000]);
  const fill = {
    QRR_INVOICE: buildQrrReference(inv.number),
    PMTINF: frozenPmtInfId(t, batch.batchId),
    E2E_1: frozenEndToEndId(t, items[0].id),
    E2E_2: frozenEndToEndId(t, items[1].id),
  };
  const main = read('bank-inbox-day-camt053.xml').replace(/@@([A-Z0-9_]+)@@/g, (_, k) => fill[k]);
  assert.equal(/@@/.test(main), false, 'every placeholder is filled');
  return { t, sav, inv, migrated, batch, bills, main, savings: read('bank-inbox-day-savings-camt053.xml') };
}

const byRef = (lines, text) => lines.find((l) => (l.remittance.text ?? '').includes(text) || (l.counterparty.name ?? '').includes(text));

test('the go-live day: import, book every line by its proposal, bank equals books, the MWST checklist passes', () => {
  const { t, sav, inv, migrated, batch, main, savings } = goLiveBook();

  // --- Import both day-end statements ------------------------------------------------------------
  const a = must(importCamt(t.ctx, { bankAccountId: t.bankAccountId, xml: main, idempotencyKey: 'imp-main' }), 'import main');
  const b = must(importCamt(t.ctx, { bankAccountId: sav, xml: savings, idempotencyKey: 'imp-sav' }), 'import savings');
  assert.equal(a.txnCount, 7, 'six bookings, the run fanned out into its two payments');
  assert.deepEqual(a.warnings, [], 'a day-end statement');
  assert.deepEqual(a.skipped, [], 'the run\'s shared AcctSvcrRef skips nothing (L7 (a))');
  assert.equal(b.txnCount, 1);
  const keys = t.store.db.prepare("SELECT entry_key FROM bank_txn WHERE workspace_id = ? AND entry_key LIKE 'asr:DAY0930-A005%' ORDER BY entry_key").all(t.workspaceId).map((r) => r.entry_key);
  assert.deepEqual(keys, ['asr:DAY0930-A005', 'asr:DAY0930-A005#1']);

  // --- Every open line with one proposal -----------------------------------------------------------
  const first = must(listBankInbox(t.ctx, {})).lines;
  assert.equal(first.length, 8);
  const qr = byRef(first, 'Holzbau Lindenegg');
  assert.deepEqual([qr.proposal.certainty, qr.proposal.reasonCode], ['sure', 'qr_reference_exact']);
  assert.deepEqual(qr.proposal.target, { kind: 'open_item', documentId: inv.id });
  const akonto = byRef(first, 'Akonto Pflegevertrag');
  assert.deepEqual([akonto.proposal.certainty, akonto.proposal.reasonCode], ['check', 'existing_entry_amount_date']);
  assert.deepEqual(akonto.proposal.target, { kind: 'existing_entry', entryId: migrated.entryId });
  const fee = byRef(first, 'Kontoführung');
  assert.equal(fee.proposal.certainty, 'open');
  const card = byRef(first, 'Papeterie am Bach');
  assert.equal(card.proposal.certainty, 'open');
  const items = first.filter((l) => l.proposal?.reasonCode === 'payment_batch_item');
  assert.equal(items.length, 2, 'each payment of the run is proven by TILL\'s own EndToEndId');
  for (const l of items) {
    assert.equal(l.proposal.certainty, 'sure');
    assert.deepEqual(l.proposal.target, { kind: 'payment_batch', batchId: batch.batchId });
  }
  const out = first.find((l) => l.bankAccountId === t.bankAccountId && l.counterparty.iban === SAVINGS_IBAN);
  const inn = first.find((l) => l.bankAccountId === sav);
  for (const side of [out, inn]) {
    assert.equal(side.proposal.certainty, 'check', 'an own-account transfer is never sure (D139)');
    assert.equal(side.proposal.reasonCode, 'own_account_transfer');
  }
  // Right after the import the migrated receipt is on the books while its line is open.
  const openSummary = must(listBankInbox(t.ctx, { bankAccountId: t.bankAccountId })).summary[0];
  assert.equal(openSummary.differenceMinor, -50000, 'the entry no line backs yet shows as a difference');

  // --- "Alle sicheren buchen": book_bank_line per sure line; no transfer is posted (A39R2-2) --------
  for (const l of first.filter((x) => x.proposal?.certainty === 'sure')) {
    must(bookBankLine(t.ctx, { bankTxnId: l.bankTxnId, target: l.proposal.target, idempotencyKey: `sure-${l.bankTxnId}` }), `sure ${l.bankTxnId}`);
  }
  assert.equal(balanceOf(t.store, t.workspaceId, '1000'), 3000000, 'no transfer reached the savings ledger');
  assert.equal(t.store.db.prepare('SELECT status FROM payment_batch WHERE id = ?').get(batch.batchId).status, 'paid');
  assert.equal(t.store.db.prepare('SELECT status FROM document WHERE id = ?').get(inv.id).status, 'settled');

  // --- The rest, a person confirming each line ------------------------------------------------------
  must(bookBankLine(t.ctx, { bankTxnId: akonto.bankTxnId, target: akonto.proposal.target, idempotencyKey: 'akonto' }), 'match the migrated entry');
  must(bookBankLine(t.ctx, { bankTxnId: fee.bankTxnId, target: { kind: 'accounts', legs: [{ accountId: t.acc('6900'), amountMinor: 1200 }] }, idempotencyKey: 'fee' }), 'fee');
  const cardBooked = must(bookBankLine(t.ctx, { bankTxnId: card.bankTxnId, target: { kind: 'accounts', legs: [{ accountId: t.acc('6500'), amountMinor: 10810, taxCode: 'VST-M' }] }, idempotencyKey: 'card' }), 'card');
  assert.deepEqual(legs(t.store, cardBooked.entryId).map((l) => [l.number, l.debit, l.credit]), [
    ['1020', 0, 10810],
    ['1170', 810, 0],
    ['6500', 10000, 0],
  ]);
  const transfer = must(bookBankLine(t.ctx, { bankTxnId: out.bankTxnId, target: out.proposal.target, idempotencyKey: 'side-one' }), 'side one');
  const second = must(listBankInbox(t.ctx, {})).lines;
  assert.equal(second.length, 1, 'only side two is left');
  assert.deepEqual([second[0].proposal.certainty, second[0].proposal.reasonCode], ['check', 'own_account_transfer_booked']);
  assert.deepEqual(second[0].proposal.target, { kind: 'existing_entry', entryId: transfer.entryId });
  const matched = must(bookBankLine(t.ctx, { bankTxnId: inn.bankTxnId, target: second[0].proposal.target, idempotencyKey: 'side-two' }), 'side two');
  assert.equal(matched.state, 'matched');

  // --- Bank equals books, per account --------------------------------------------------------------
  const summary = must(listBankInbox(t.ctx, {})).summary;
  for (const s of summary) {
    assert.equal(s.openCount, 0, `${s.name}: nothing open`);
    assert.equal(s.differenceMinor, 0, `${s.name}: bank ${s.bankBalanceMinor} = books ${s.ledgerBalanceMinor}`);
  }
  assert.equal(balanceOf(t.store, t.workspaceId, '1020'), 1546090, 'the Geschäftskonto closes at the statement\'s CLBD');
  assert.equal(balanceOf(t.store, t.workspaceId, '1000'), 3500000, 'the Sparkonto closes at its CLBD');
  assert.deepEqual(legClaimViolations(t.store, t.workspaceId), []);

  // --- G22: the MWST-Periode checklist's "Bank abgestimmt" -----------------------------------------
  const bankItem = (period) => {
    const run = must(checklistStart(t.ctx, { templateId: 'vat_period', period, idempotencyKey: `cl-${period}` }), `start ${period}`);
    const view = must(checklistGet(t.ctx, { runId: run.run?.runId ?? run.runId }), `get ${period}`);
    const items = view.items ?? view.run?.items;
    return items.find((i) => i.itemId === 'bank_reconciled');
  };
  const q3 = bankItem('2026-Q3');
  assert.equal(q3.checkResult.passed, true, JSON.stringify(q3.checkResult));
  assert.deepEqual(q3.checkResult.detail.accounts.map((x) => x.status), ['reconciled', 'reconciled']);
  const q2 = bankItem('2026-Q2');
  assert.equal(q2.checkResult.passed, true);
  assert.deepEqual(q2.checkResult.detail.accounts.map((x) => x.status), ['not_started', 'not_started']);

  // --- A re-import is a duplicate with zero rows ---------------------------------------------------
  const rows = rowCounts(t.store, t.workspaceId);
  const txns = () => t.store.db.prepare('SELECT COUNT(*) AS n FROM bank_txn WHERE workspace_id = ?').get(t.workspaceId).n;
  const before = txns();
  const again = must(importCamt(t.ctx, { bankAccountId: t.bankAccountId, xml: main, idempotencyKey: 'imp-main-again' }));
  assert.equal(again.duplicate, true);
  assert.equal(txns(), before);
  assert.deepEqual(rowCounts(t.store, t.workspaceId), rows, 'the re-import changed no decision');

  // --- A double confirm moves nothing --------------------------------------------------------------
  refused(bookBankLine(t.ctx, { bankTxnId: fee.bankTxnId, target: { kind: 'accounts', legs: [{ accountId: t.acc('6900'), amountMinor: 1200 }] }, idempotencyKey: 'fee-again' }), 'line_not_open');
  assert.deepEqual(must(bookBankLine(t.ctx, { bankTxnId: fee.bankTxnId, target: { kind: 'accounts', legs: [{ accountId: t.acc('6900'), amountMinor: 1200 }] }, idempotencyKey: 'fee' })).entryId, must(listBankInbox(t.ctx, { status: 'all' })).lines.find((l) => l.bankTxnId === fee.bankTxnId).decision.entryId, 'the same key replays');
  assert.deepEqual(rowCounts(t.store, t.workspaceId), rows);

  // --- Reopen the card purchase, rebook it: the ledger nets once ------------------------------------
  const undone = must(reopenBankLine(t.ctx, { bankTxnId: card.bankTxnId, reason: 'falsches Konto', idempotencyKey: 'card-undo' }));
  assert.deepEqual(undone.reversedEntryIds, [cardBooked.entryId]);
  must(bookBankLine(t.ctx, { bankTxnId: card.bankTxnId, target: { kind: 'accounts', legs: [{ accountId: t.acc('6570'), amountMinor: 10810, taxCode: 'VST-M' }] }, idempotencyKey: 'card-2' }));
  assert.equal(balanceOf(t.store, t.workspaceId, '6500'), 100000, 'the first booking is reversed (the two bills of the run remain)');
  assert.equal(balanceOf(t.store, t.workspaceId, '6570'), 10000);
  assert.equal(balanceOf(t.store, t.workspaceId, '1170'), 810, 'the Vorsteuer counted once');
  assert.equal(balanceOf(t.store, t.workspaceId, '1020'), 1546090, 'the bank moved once');
  assert.equal(must(listBankInbox(t.ctx, { bankAccountId: t.bankAccountId })).summary[0].differenceMinor, 0);
});
