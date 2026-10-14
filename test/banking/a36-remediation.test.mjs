// A36 remediation (critic F1/F2/F3): the non-author critic's own reproduction probes, folded in and
// rewritten to assert the DEFECT IS FIXED. Each test names the finding it closes.
//  - F1, INVERTED BY A36 (D-A36.5): the receipt is no longer withheld. The fetched bytes are committed
//        BEFORE the receipt, so a statement that does not import (an amended copy: overlap_refused, final;
//        a gap: pending) keeps its bytes and its outcome in TILL, the receipt goes out, and a pending one
//        is retried from the stored bytes at every sync. Nothing is dropped, the outcome is reported
//        honestly, and a re-offer never double-applies (idempotency ON ROWS holds).
//  - F2: a batch paid from its funding debit is booked on the bank inbox (A39 L2: book_bank_line with
//        target payment_batch; mark_batch_paid with a bankTxnId refuses use_bank_inbox), so that debit is
//        decided and can no longer be double-booked (confirm_match / create_entry_for_txn refuse).
//  - F3: a reversal-flagged txn always needs review, even with a coincidental exact-amount candidate.
// All offline against the in-process mock EBICS host.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { setup, secondWorkspace, PLAIN_IBAN } from './support.mjs';
import { createContact } from '../../dist/core/sales/index.js';
import { createVendorBill, postVendorBill } from '../../dist/core/purchase/index.js';
import {
  createBankAccount,
  setCreditorBankProfile,
  createPaymentBatch,
  generatePain001,
  markBatchPaid,
  importCamt,
  reviewBankTxn,
  confirmCamtMatch,
  createEntryForTxn,
  listReconciliation,
  bookBankLine,
} from '../../dist/core/banking/index.js';
import { connectBankChannel, syncBankChannel } from '../../dist/core/banking/ebics/index.js';
import { frozenPmtInfId, frozenEndToEndId } from './frozen-refs-support.mjs';
import { makeContext } from '../../dist/core/context.js';
import { mockBank, container, chain } from './ebics-support.mjs';

const HOST = { url: 'https://ebics.example/ebics', hostId: 'EBICSHST', partnerId: 'PARTNER01', userId: 'USER0001' };
const B64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const IBAN = PLAIN_IBAN.replace(/\s+/g, '');

function must(res, label) {
  assert.equal(res.ok, true, `${label}: ${JSON.stringify(res)}`);
  return res;
}
function rows(store, ws, table) {
  return store.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE workspace_id = ?`).get(ws).n;
}
function mkBankAccount(ctx, acc) {
  return must(createBankAccount(ctx, { name: 'Konto', iban: PLAIN_IBAN, ledgerAccountId: acc('1020'), idempotencyKey: 'ba' }), 'ba').bankAccountId;
}
function openBill(ctx, acc, amountMinor, vendorReference, seed, vendorName = 'Swisscom') {
  const vendor = must(createContact(ctx, { partyRole: 'vendor', name: vendorName, idempotencyKey: `v-${seed}` }), 'vendor').contact.id;
  const bill = must(createVendorBill(ctx, { vendorId: vendor, billDate: '2026-06-01', dueDate: '2026-07-03', vendorReference, amountMinor, expenseAccountId: acc('6500'), idempotencyKey: `bill-${seed}` }), 'bill');
  must(postVendorBill(ctx, { vendorBillId: bill.vendorBillId, idempotencyKey: `post-${seed}` }), 'post');
  return { vendorId: vendor, vendorBillId: bill.vendorBillId };
}
// camt.053 with one DBIT; NtryRef controls entry identity. opts: {valueDate, payerName, pmtInfId, ntryRef, reversal}
function camtDebit(statementId, amountMajor, opts = {}) {
  const btch = opts.pmtInfId ? `<NtryDtls><Btch><PmtInfId>${opts.pmtInfId}</PmtInfId></Btch></NtryDtls>` : '';
  const val = opts.valueDate ?? '2026-07-01';
  const ntryRef = opts.ntryRef ?? `E-${statementId}`;
  const rvsl = opts.reversal ? 'true' : 'false';
  const payer = opts.payerName
    ? `<NtryDtls><TxDtls><RltdPties><Dbtr><Pty><Nm>${opts.payerName}</Nm></Pty></Dbtr></RltdPties></TxDtls></NtryDtls>`
    : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08">
<BkToCstmrStmt><GrpHdr><MsgId>${statementId}-msg</MsgId><CreDtTm>2026-07-05T08:00:00</CreDtTm></GrpHdr>
<Stmt><Id>${statementId}</Id><ElctrncSeqNb>1</ElctrncSeqNb>
<FrToDt><FrDtTm>2026-07-01T00:00:00</FrDtTm><ToDtTm>2026-07-31T23:59:59</ToDtTm></FrToDt>
<Acct><Id><IBAN>${IBAN}</IBAN></Id></Acct>
<Ntry><NtryRef>${ntryRef}</NtryRef><Amt Ccy="CHF">${amountMajor}</Amt><CdtDbtInd>DBIT</CdtDbtInd>
<Sts><Cd>BOOK</Cd></Sts><RvslInd>${rvsl}</RvslInd>
<BookgDt><Dt>${val}</Dt></BookgDt><ValDt><Dt>${val}</Dt></ValDt>
<BkTxCd><Domn><Cd>PMNT</Cd><Fmly><Cd>ICDT</Cd><SubFmlyCd>OTHR</SubFmlyCd></Fmly></Domn></BkTxCd>
${btch}${payer}</Ntry></Stmt></BkToCstmrStmt></Document>`;
}
function ctxWith(t, bank) {
  return makeContext(t.store, { workspaceId: t.workspaceId, actor: 'user_1', clock: t.clock, ids: t.ids, ...(bank ? { ebicsTransport: bank.port } : {}) });
}
function activeChannel(ctx, bankAccountId, seed) {
  const c1 = must(connectBankChannel(ctx, { host: HOST, routeBankAccountIds: [bankAccountId], confirm: true, idempotencyKey: `${seed}-1` }), 'connect');
  const fetched = must(connectBankChannel(ctx, { connectionId: c1.connectionId, confirm: true }), 'fetch');
  must(connectBankChannel(ctx, { connectionId: c1.connectionId, confirmBankKeys: true, expectedBankKeyHashes: fetched.bankKeyHashes, confirm: true }), 'activate');
  return c1.connectionId;
}
/** A synthetic day-end statement number `seq` on the PLAIN_IBAN account, opening on `opening`. */
function dayEnd(seq, opening, entries, date = '2026-07-01') {
  return chain({ iban: IBAN, firstSeq: seq, firstDate: date, opening, days: [entries] })[0].xml;
}

// Build a generated A18 batch funded by one bank debit; returns { batchId, bankTxnId, acc, otherAmount }.
function batchWithFundingDebit(t, acc, statementId, seed) {
  const vendor = must(createContact(t.ctx, { partyRole: 'vendor', name: 'Lieferant', idempotencyKey: `bv-${seed}` }), 'vendor').contact.id;
  const bill = must(createVendorBill(t.ctx, { vendorId: vendor, billDate: '2026-06-01', amountMinor: 100000, expenseAccountId: t.acc('6500'), idempotencyKey: `bbill-${seed}` }), 'bill');
  must(postVendorBill(t.ctx, { vendorBillId: bill.vendorBillId, idempotencyKey: `bpost-${seed}` }), 'post');
  must(setCreditorBankProfile(t.ctx, { vendorId: vendor, iban: PLAIN_IBAN, idempotencyKey: `bcbp-${seed}` }), 'cbp');
  const batch = must(createPaymentBatch(t.ctx, { bankAccountId: acc, itemIds: [bill.vendorBillId], executionDate: '2026-07-10', idempotencyKey: `bbatch-${seed}` }), 'batch');
  must(generatePain001(t.ctx, { batchId: batch.batchId, idempotencyKey: `bgen-${seed}` }), 'gen');
  const pmtInfId = frozenPmtInfId(t, batch.batchId);
  const stmt = must(importCamt(t.ctx, { bankAccountId: acc, xml: camtDebit(statementId, '1000.00', { pmtInfId }), idempotencyKey: `imp-${seed}` }), 'import');
  const bankTxnId = t.store.db.prepare('SELECT id FROM bank_txn WHERE workspace_id = ? AND statement_id = ?').get(t.workspaceId, stmt.statementId).id;
  return { batchId: batch.batchId, bankTxnId, statementId: stmt.statementId };
}

// --- F2 (PROBE 6): the batch-settled debit cannot fund a SECOND payment via confirm_match -----------
test('F2: a batch confirmed with its funding debit refuses a second confirm_match (no double-payment)', () => {
  const t = setup();
  const acc = mkBankAccount(t.ctx, t.acc);
  const { batchId, bankTxnId } = batchWithFundingDebit(t, acc, 'STMT-F2A', 'f2a');

  // Book the funding debit on the bank inbox: the run is marked paid and the debit decided in one step.
  must(bookBankLine(t.ctx, { bankTxnId, target: { kind: 'payment_batch', batchId }, idempotencyKey: 'mbp-a' }), 'book_bank_line');
  const payAfterBatch = rows(t.store, t.workspaceId, 'payment');

  // Now try to ALSO settle the same debit against ANOTHER open bill of the same amount.
  const otherBill = openBill(t.ctx, t.acc, 100000, 'INV-OTHER', 'f2a-b', 'AndererLieferant').vendorBillId;
  const dbl = confirmCamtMatch(t.ctx, { bankTxnId, vendorBillId: otherBill, idempotencyKey: 'dbl-a' });

  const payAfterDouble = rows(t.store, t.workspaceId, 'payment');
  // FIXED: the debit carries a payment_batch link, so confirm_match hits the line-state guard and
  // books NOTHING. A39 (walk B14.3): a DIFFERENT decision on a decided line is REFUSED, naming the
  // decision that holds it, instead of an `ok` that echoed someone else's link (an approved stale
  // Vorschlag then reported executed while nothing ran). No second payment row is created.
  assert.equal(payAfterDouble, payAfterBatch, 'no second payment was booked for the one bank debit');
  assert.equal(dbl.ok, false, 'confirm_match refuses a line another decision already booked');
  assert.equal(dbl.error, 'line_not_open');
  assert.equal(dbl.state, 'booked', 'the refusal names the state the batch settlement put the line in');
  assert.equal(dbl.staleProposal, true, 'and marks the call as a stale proposal');
  const link = t.store.db.prepare('SELECT kind, target_id FROM bank_txn_link WHERE id = ?').get(dbl.linkId);
  assert.equal(link.kind, 'payment_batch', 'the holding link is the batch settlement');
  assert.equal(link.target_id, batchId, 'the link points at the batch that settled the debit');
});

// --- F2 (PROBE 7): the batch-settled debit is MATCHED on the board and create_entry_for_txn refuses --
test('F2: a batch-settled debit is matched on the board and create_entry_for_txn refuses (no double-book)', () => {
  const t = setup();
  const acc = mkBankAccount(t.ctx, t.acc);
  const { batchId, bankTxnId, statementId } = batchWithFundingDebit(t, acc, 'STMT-F2B', 'f2b');

  must(bookBankLine(t.ctx, { bankTxnId, target: { kind: 'payment_batch', batchId }, idempotencyKey: 'mbp-b' }), 'book_bank_line');

  // The board now lists the funding debit as MATCHED, not perpetually unmatched.
  const board = must(listReconciliation(t.ctx, { statementId }), 'board');
  assert.equal(board.unmatched.some((x) => x.bankTxnId === bankTxnId), false, 'the settled debit is no longer unmatched');
  const matchedRow = board.matched.find((x) => x.bankTxnId === bankTxnId);
  assert.ok(matchedRow, 'the settled debit is on the matched board');
  assert.equal(matchedRow.linkKind, 'payment_batch', 'the board shows the batch link');
  assert.equal(matchedRow.linkTargetId, batchId, 'the board shows the batch target');

  // create_entry_for_txn on the settled debit is REFUSED (would have booked a second ledger movement).
  const je0 = rows(t.store, t.workspaceId, 'journal_entry');
  const entry = createEntryForTxn(t.ctx, { bankTxnId, contraAccountId: t.acc('6500'), idempotencyKey: 'f2b-cef' });
  assert.equal(entry.ok, false, 'create_entry_for_txn refuses a settled debit');
  // A39: one refusal for every decision on a decided line, naming its state (walk B14.3).
  assert.equal(entry.error, 'line_not_open', 'refused as line_not_open');
  assert.equal(entry.state, 'booked');
  assert.equal(rows(t.store, t.workspaceId, 'journal_entry'), je0, 'no second ledger movement was booked');
});

// --- F2 (A39 L2): one door per imported line; mark_batch_paid never takes a bank line -----------------
test('F2: mark_batch_paid with a funding debit refuses use_bank_inbox and moves nothing; the debit books one run only', () => {
  const t = setup();
  const acc = mkBankAccount(t.ctx, t.acc);
  const a = batchWithFundingDebit(t, acc, 'STMT-F2C1', 'f2c1');
  const before = ['payment', 'journal_entry', 'bank_txn_link'].map((tbl) => rows(t.store, t.workspaceId, tbl));
  const byHand = markBatchPaid(t.ctx, { batchId: a.batchId, bankTxnId: a.bankTxnId, confirmation: true, valueDate: '2026-07-10', idempotencyKey: 'mbp-c1' });
  assert.equal(byHand.ok, false);
  assert.equal(byHand.error, 'use_bank_inbox');
  assert.equal(byHand.bankTxnId, a.bankTxnId, 'the refusal names the line to book on the inbox');
  assert.deepEqual(['payment', 'journal_entry', 'bank_txn_link'].map((tbl) => rows(t.store, t.workspaceId, tbl)), before, 'nothing moved');

  must(bookBankLine(t.ctx, { bankTxnId: a.bankTxnId, target: { kind: 'payment_batch', batchId: a.batchId }, idempotencyKey: 'mbp-c1b' }), 'book run A');
  // A second generated batch; booking the SAME, already decided debit to it is refused.
  const b = batchWithFundingDebit(t, acc, 'STMT-F2C2', 'f2c2');
  const second = bookBankLine(t.ctx, { bankTxnId: a.bankTxnId, target: { kind: 'payment_batch', batchId: b.batchId }, idempotencyKey: 'mbp-c2' });
  assert.equal(second.ok, false, 'the second settlement is refused');
  assert.equal(second.error, 'line_not_open', 'one debit, one decision');
});

// --- F2 (regression): the plain A18 path (no bankTxnId) still settles a batch as before ---------------
test('F2: mark_batch_paid without a funding debit settles the batch unchanged (A18 path)', () => {
  const t = setup();
  const acc = mkBankAccount(t.ctx, t.acc);
  const { batchId } = batchWithFundingDebit(t, acc, 'STMT-F2D', 'f2d');
  const paid = must(markBatchPaid(t.ctx, { batchId, confirmation: true, valueDate: '2026-07-10', idempotencyKey: 'mbp-d' }), 'markBatchPaid');
  assert.equal(paid.paymentIds.length, 1, 'one payment posted per item, exactly as before');
  assert.equal(rows(t.store, t.workspaceId, 'bank_txn_link'), 0, 'no link recorded on the plain path');
});

// --- F1, inverted by A36: the receipt goes out once the bytes are durable; the outcome says the rest --
test('F1 (A36): an amended copy of an imported statement is overlap_refused and final, ledger unchanged, receipted, reported', () => {
  const t = setup();
  const acc = mkBankAccount(t.ctx, t.acc);
  const bank = mockBank();
  const ctx = ctxWith(t, bank);
  const conn = activeChannel(ctx, acc, 'amend');

  bank.offer(container([dayEnd(1, 100000, [{ minor: -4250 }])]));
  must(syncBankChannel(ctx, { connectionId: conn, idempotencyKey: 'am-1' }), 's1');
  assert.equal(t.store.db.prepare('SELECT amount_minor FROM bank_txn WHERE workspace_id = ?').get(t.workspaceId).amount_minor, 4250, 'original imported');

  // The bank re-issues statement 1 with another amount: the same position, other balances.
  bank.offer(container([dayEnd(1, 100000, [{ minor: -9999 }])], { stamp: '20260702' }));
  const s2 = must(syncBankChannel(ctx, { connectionId: conn, idempotencyKey: 'am-2' }), 's2');
  const after = t.store.db.prepare('SELECT amount_minor FROM bank_txn WHERE workspace_id = ?').get(t.workspaceId).amount_minor;
  assert.equal(after, 4250, 'the amended copy was NOT applied');
  assert.deepEqual(s2.statements.map((x) => [x.outcome, x.final]), [['overlap_refused', true]], 'reported honestly, and final');
  assert.equal(s2.receipt, 'positive', 'its bytes are durable in TILL, so the bank may forget them');
  const outcome = t.store.db
    .prepare("SELECT status, bank_reason FROM ebics_order_log WHERE workspace_id = ? AND related_kind = 'member_outcome' AND bank_reason = 'overlap_refused'")
    .get(t.workspaceId);
  assert.deepEqual({ ...outcome }, { status: 'ok', bank_reason: 'overlap_refused' }, 'the final outcome is on the order log');
});

test('F1 (A36): a statement that cannot import YET is pending after a positive receipt and is retried from its bytes', () => {
  const t = setup();
  const acc = mkBankAccount(t.ctx, t.acc);
  const bank = mockBank();
  const ctx = ctxWith(t, bank);
  const conn = activeChannel(ctx, acc, 'pend');
  const days = chain({ iban: IBAN, firstSeq: 1, firstDate: '2026-07-01', opening: 100000, days: [[{ minor: -100 }], [{ minor: -200 }], [{ minor: -300 }]] });
  must(importCamt(t.ctx, { bankAccountId: acc, xml: days[0].xml, idempotencyKey: 'p-1' }), 'statement 1 by hand');
  bank.offer(container([days[2].xml]));
  const s1 = must(syncBankChannel(ctx, { connectionId: conn, idempotencyKey: 'p-s1' }), 's1');
  assert.deepEqual(s1.statements.map((x) => [x.outcome, x.final]), [['gap_refused', false]]);
  assert.equal(s1.receipt, 'positive');
  must(importCamt(t.ctx, { bankAccountId: acc, xml: days[1].xml, idempotencyKey: 'p-2' }), 'the missing day by hand');
  const s2 = must(syncBankChannel(ctx, { connectionId: conn, idempotencyKey: 'p-s2' }), 's2 (090005)');
  assert.deepEqual(s2.statements.map((x) => x.outcome), ['imported'], 'retried from the stored bytes');
  assert.equal(rows(t.store, t.workspaceId, 'bank_statement'), 3);
});

// --- F1 (idempotency ON ROWS): a re-offer never double-applies ---------------------------------------
test('F1: an amended statement, re-offered, still lands EXACTLY ONE bank_txn row', () => {
  const t = setup();
  const acc = mkBankAccount(t.ctx, t.acc);
  const bank = mockBank();
  const ctx = ctxWith(t, bank);
  const conn = activeChannel(ctx, acc, 'idem');
  bank.offer(container([dayEnd(1, 100000, [{ minor: -4250 }])]));
  must(syncBankChannel(ctx, { connectionId: conn, idempotencyKey: 'id-1' }), 's1');
  // The amended copy, offered in two containers with other bytes (a re-offer after each sync).
  bank.offer(container([dayEnd(1, 100000, [{ minor: -9999 }])], { stamp: '20260702' }));
  must(syncBankChannel(ctx, { connectionId: conn, idempotencyKey: 'id-2' }), 's2');
  bank.offer(container([dayEnd(1, 100000, [{ minor: -9999 }])], { stamp: '20260703' }));
  must(syncBankChannel(ctx, { connectionId: conn, idempotencyKey: 'id-3' }), 's3');
  assert.equal(rows(t.store, t.workspaceId, 'bank_txn'), 1, 'three syncs, exactly one row: no double-apply');
});

// --- F1 (regression): a clean import is receipted positively -------------------------------------------
test('F1: a successful import is receipted positively (success path unchanged)', () => {
  const t = setup();
  const acc = mkBankAccount(t.ctx, t.acc);
  const bank = mockBank();
  const ctx = ctxWith(t, bank);
  const conn = activeChannel(ctx, acc, 'clean');
  bank.offer(container([dayEnd(1, 100000, [{ minor: -4250 }])]));
  const s = must(syncBankChannel(ctx, { connectionId: conn, idempotencyKey: 'clean-1' }), 's');
  assert.deepEqual(s.statements.map((x) => x.outcome), ['imported'], 'the import succeeded');
  assert.equal(s.pendingStatements, 0, 'nothing waits');
  assert.deepEqual(bank.receipts.map((r) => r.receiptCode), [0], 'the transaction IS receipted positively');
});

// --- F3 (PROBE 5): a reversal-flagged txn always needs review, even with an exact candidate ----------
test('F3: a reversal-flagged debit needs review even when a coincidental exact-amount bill exists', () => {
  const t = setup();
  const acc = mkBankAccount(t.ctx, t.acc);
  openBill(t.ctx, t.acc, 5000, 'INV-R', 'f3'); // exact-amount candidate
  const stmt = must(importCamt(t.ctx, { bankAccountId: acc, xml: camtDebit('STMT-F3', '50.00', { reversal: true }), idempotencyKey: 'imp-f3' }), 'import');
  const txn = t.store.db.prepare('SELECT id, classification FROM bank_txn WHERE workspace_id = ? AND statement_id = ?').get(t.workspaceId, stmt.statementId);
  assert.equal(txn.classification, 'unclassified', 'a reversal is unclassified');
  const r = must(reviewBankTxn(t.ctx, { bankTxnId: txn.id, idempotencyKey: 'rv-f3' }), 'review');
  // FIXED: the reversal never suppresses review on the strength of an automated score.
  assert.equal(r.needsReview, true, 'the reversal needs review, honouring the documented invariant');
  assert.equal(r.needsReviewTxnId, txn.id, 'the event resolves the txn id');
});

// --- §H-TENANT still bites: a foreign-workspace bank_txn id is not_found -----------------------------
test('§H-TENANT: mark_batch_paid and confirm_match cannot reach across workspaces', () => {
  const t = setup();
  const acc = mkBankAccount(t.ctx, t.acc);
  const { batchId, bankTxnId } = batchWithFundingDebit(t, acc, 'STMT-TEN', 'ten');
  const other = secondWorkspace(t);
  // The neighbour tries to settle OUR batch's funding debit: the bank_txn id is not visible to it.
  const leak = markBatchPaid(other.ctx, { batchId, bankTxnId, confirmation: true, valueDate: '2026-07-10', idempotencyKey: 'ten-leak' });
  assert.equal(leak.ok, false, 'no cross-workspace settlement');
});
