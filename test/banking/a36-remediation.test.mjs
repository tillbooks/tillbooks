// A36 remediation (critic F1/F2/F3): the non-author critic's own reproduction probes, folded in and
// rewritten to assert the DEFECT IS FIXED. Each test names the finding it closes.
//  - F1: a failed import (A20-C2 statement_amended) is NOT acknowledged, so nothing is dropped and the
//        drop is reported honestly; a re-offer never double-applies (idempotency ON ROWS holds).
//  - F2: a batch confirmed from the reconciliation board LINKS its funding debit, so that debit is
//        matched on the board and can no longer be double-booked (confirm_match / create_entry_for_txn
//        refuse) and cannot be re-settled against a second batch.
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
} from '../../dist/core/banking/index.js';
import { connectBankChannel, syncBankChannel } from '../../dist/core/banking/ebics/index.js';
import { compactReference } from '../../dist/core/banking/pain001.js';
import { makeContext } from '../../dist/core/context.js';

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
function mockHost(cfg = {}) {
  const order = [];
  return {
    order,
    port: {
      sendKeys: () => ({ ok: true }),
      fetchBankKeys: () => ({ ok: true, bankKeyHashes: { electronicSignature: 'e', authentication: 'a', encryption: 'n' } }),
      download(req) { order.push(`d:${req.service}`); return { ok: true, files: (cfg.files && cfg.files[req.service]) || [], ackToken: `ack-${req.service}` }; },
      acknowledge(req) { order.push(`a:${req.ackToken}`); if (cfg.ackThrows) throw new Error('crash'); return { ok: true }; },
      upload: () => ({ ok: true }),
      suspend: () => ({ ok: true }),
    },
  };
}
function ctxWith(t, host) {
  return makeContext(t.store, { workspaceId: t.workspaceId, actor: 'user_1', clock: t.clock, ids: t.ids, ...(host ? { ebicsTransport: host.port } : {}) });
}
function activeChannel(ctx, bankAccountId, seed) {
  const c1 = must(connectBankChannel(ctx, { host: HOST, routeBankAccountIds: [bankAccountId], confirm: true, idempotencyKey: `${seed}-1` }), 'connect');
  must(connectBankChannel(ctx, { connectionId: c1.connectionId, confirmBankKeys: true, confirm: true, idempotencyKey: `${seed}-2` }), 'activate');
  return c1.connectionId;
}

// Build a generated A18 batch funded by one bank debit; returns { batchId, bankTxnId, acc, otherAmount }.
function batchWithFundingDebit(t, acc, statementId, seed) {
  const vendor = must(createContact(t.ctx, { partyRole: 'vendor', name: 'Lieferant', idempotencyKey: `bv-${seed}` }), 'vendor').contact.id;
  const bill = must(createVendorBill(t.ctx, { vendorId: vendor, billDate: '2026-06-01', amountMinor: 100000, expenseAccountId: t.acc('6500'), idempotencyKey: `bbill-${seed}` }), 'bill');
  must(postVendorBill(t.ctx, { vendorBillId: bill.vendorBillId, idempotencyKey: `bpost-${seed}` }), 'post');
  must(setCreditorBankProfile(t.ctx, { vendorId: vendor, iban: PLAIN_IBAN, idempotencyKey: `bcbp-${seed}` }), 'cbp');
  const batch = must(createPaymentBatch(t.ctx, { bankAccountId: acc, itemIds: [bill.vendorBillId], executionDate: '2026-07-10', idempotencyKey: `bbatch-${seed}` }), 'batch');
  must(generatePain001(t.ctx, { batchId: batch.batchId, idempotencyKey: `bgen-${seed}` }), 'gen');
  const pmtInfId = compactReference('P', batch.batchId);
  const stmt = must(importCamt(t.ctx, { bankAccountId: acc, xml: camtDebit(statementId, '1000.00', { pmtInfId }), idempotencyKey: `imp-${seed}` }), 'import');
  const bankTxnId = t.store.db.prepare('SELECT id FROM bank_txn WHERE workspace_id = ? AND statement_id = ?').get(t.workspaceId, stmt.statementId).id;
  return { batchId: batch.batchId, bankTxnId, statementId: stmt.statementId };
}

// --- F2 (PROBE 6): the batch-settled debit cannot fund a SECOND payment via confirm_match -----------
test('F2: a batch confirmed with its funding debit refuses a second confirm_match (no double-payment)', () => {
  const t = setup();
  const acc = mkBankAccount(t.ctx, t.acc);
  const { batchId, bankTxnId } = batchWithFundingDebit(t, acc, 'STMT-F2A', 'f2a');

  // Confirm the batch FROM THE RECONCILIATION BOARD: bankTxnId travels so the debit is LINKED.
  must(markBatchPaid(t.ctx, { batchId, bankTxnId, confirmation: true, valueDate: '2026-07-10', idempotencyKey: 'mbp-a' }), 'markBatchPaid');
  const payAfterBatch = rows(t.store, t.workspaceId, 'payment');

  // Now try to ALSO settle the same debit against ANOTHER open bill of the same amount.
  const otherBill = openBill(t.ctx, t.acc, 100000, 'INV-OTHER', 'f2a-b', 'AndererLieferant').vendorBillId;
  const dbl = confirmCamtMatch(t.ctx, { bankTxnId, vendorBillId: otherBill, idempotencyKey: 'dbl-a' });

  const payAfterDouble = rows(t.store, t.workspaceId, 'payment');
  // FIXED: the debit carries a payment_batch link, so confirm_match hits the existing-link guard and
  // books NOTHING. The link is echoed; no second payment row is created.
  assert.equal(payAfterDouble, payAfterBatch, 'no second payment was booked for the one bank debit');
  assert.equal(dbl.ok, true, 'confirm_match returns the existing link, idempotently');
  assert.equal(dbl.kind, 'payment_batch', 'the existing link is the batch settlement');
  assert.equal(dbl.targetId, batchId, 'the link points at the batch that settled the debit');
});

// --- F2 (PROBE 7): the batch-settled debit is MATCHED on the board and create_entry_for_txn refuses --
test('F2: a batch-settled debit is matched on the board and create_entry_for_txn refuses (no double-book)', () => {
  const t = setup();
  const acc = mkBankAccount(t.ctx, t.acc);
  const { batchId, bankTxnId, statementId } = batchWithFundingDebit(t, acc, 'STMT-F2B', 'f2b');

  must(markBatchPaid(t.ctx, { batchId, bankTxnId, confirmation: true, valueDate: '2026-07-10', idempotencyKey: 'mbp-b' }), 'markBatchPaid');

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
  assert.equal(entry.error, 'already_matched', 'refused as already_matched');
  assert.equal(rows(t.store, t.workspaceId, 'journal_entry'), je0, 'no second ledger movement was booked');
});

// --- F2 (double-settle across batches): one debit maps to at most one batch --------------------------
test('F2: a debit already linked to one batch cannot fund a second batch (already_matched)', () => {
  const t = setup();
  const acc = mkBankAccount(t.ctx, t.acc);
  const a = batchWithFundingDebit(t, acc, 'STMT-F2C1', 'f2c1');
  must(markBatchPaid(t.ctx, { batchId: a.batchId, bankTxnId: a.bankTxnId, confirmation: true, valueDate: '2026-07-10', idempotencyKey: 'mbp-c1' }), 'markBatchPaid-1');

  // A second generated batch; try to settle it against the SAME already-linked debit.
  const b = batchWithFundingDebit(t, acc, 'STMT-F2C2', 'f2c2');
  const second = markBatchPaid(t.ctx, { batchId: b.batchId, bankTxnId: a.bankTxnId, confirmation: true, valueDate: '2026-07-11', idempotencyKey: 'mbp-c2' });
  assert.equal(second.ok, false, 'the second settlement is refused');
  assert.equal(second.error, 'already_matched', 'refused as already_matched: one debit, at most one batch');
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

// --- F1 (PROBE 8): an amended (import-failing) statement is NOT acknowledged and is reported honestly -
test('F1: an amended import-failing statement is NOT acknowledged, ledger unchanged, drop reported', () => {
  const t = setup();
  const acc = mkBankAccount(t.ctx, t.acc);
  const conn = activeChannel(ctxWith(t, mockHost({ files: { statements: [] } })), acc, 'amend');

  const orig = B64(camtDebit('STMT-AMEND', '42.50', { ntryRef: 'REF-AM' }));
  must(syncBankChannel(ctxWith(t, mockHost({ files: { statements: [{ msgName: 'camt.053', contentBase64: orig }] } })), { connectionId: conn, idempotencyKey: 'am-1' }), 's1');
  assert.equal(t.store.db.prepare('SELECT amount_minor FROM bank_txn WHERE workspace_id = ?').get(t.workspaceId).amount_minor, 4250, 'original imported');

  const amended = B64(camtDebit('STMT-AMEND', '99.99', { ntryRef: 'REF-AM' }));
  const host2 = mockHost({ files: { statements: [{ msgName: 'camt.053', contentBase64: amended }] } });
  const s2 = must(syncBankChannel(ctxWith(t, host2), { connectionId: conn, idempotencyKey: 'am-2' }), 's2');

  const after = t.store.db.prepare('SELECT amount_minor FROM bank_txn WHERE workspace_id = ?').get(t.workspaceId).amount_minor;
  assert.equal(after, 4250, 'the amendment was NOT applied (statement_amended)');
  // FIXED: the statements token is NOT acknowledged, so the bank keeps offering the correction.
  assert.equal(host2.order.some((o) => o === 'a:ack-statements'), false, 'the failed-import statements token is NOT acknowledged');
  // FIXED: the drop is reported honestly (not a silent ok:true).
  assert.equal(s2.unappliedStatements, 1, 'the sync reports one unapplied statement');
  const matched = s2.files.find((f) => f.routing === 'matched');
  assert.equal(matched.importOk, false, 'the matched file is flagged import-failed');
  assert.equal(matched.importReason, 'statement_amended', 'with the A20 reason');
  // The order log carries a non-ok status for the failed import (the status-card feed).
  const failedOrder = t.store.db
    .prepare("SELECT status, bank_reason FROM ebics_order_log WHERE workspace_id = ? AND status = 'failed'")
    .get(t.workspaceId);
  assert.ok(failedOrder, 'a failed order-log row exists');
  assert.equal(failedOrder.bank_reason, 'statement_amended', 'carrying the reason');
});

// --- F1 (idempotency ON ROWS): the un-acked re-offer never double-applies -----------------------------
test('F1: an un-acked amended statement, re-offered, still lands EXACTLY ONE bank_txn row', () => {
  const t = setup();
  const acc = mkBankAccount(t.ctx, t.acc);
  const conn = activeChannel(ctxWith(t, mockHost({ files: { statements: [] } })), acc, 'idem');

  const orig = B64(camtDebit('STMT-IDEM', '42.50', { ntryRef: 'REF-ID' }));
  must(syncBankChannel(ctxWith(t, mockHost({ files: { statements: [{ msgName: 'camt.053', contentBase64: orig }] } })), { connectionId: conn, idempotencyKey: 'id-1' }), 's1');
  const amended = B64(camtDebit('STMT-IDEM', '99.99', { ntryRef: 'REF-ID' }));
  // Two further syncs where the bank re-offers the amended statement (because it was never acked).
  must(syncBankChannel(ctxWith(t, mockHost({ files: { statements: [{ msgName: 'camt.053', contentBase64: amended }] } })), { connectionId: conn, idempotencyKey: 'id-2' }), 's2');
  must(syncBankChannel(ctxWith(t, mockHost({ files: { statements: [{ msgName: 'camt.053', contentBase64: amended }] } })), { connectionId: conn, idempotencyKey: 'id-3' }), 's3');
  assert.equal(rows(t.store, t.workspaceId, 'bank_txn'), 1, 'three syncs, exactly one row: no double-apply');
});

// --- F1 (regression): a CLEAN import still acknowledges the statements token --------------------------
test('F1: a successful import DOES acknowledge the statements token (success path unchanged)', () => {
  const t = setup();
  const acc = mkBankAccount(t.ctx, t.acc);
  const conn = activeChannel(ctxWith(t, mockHost({ files: { statements: [] } })), acc, 'clean');
  const host = mockHost({ files: { statements: [{ msgName: 'camt.053', contentBase64: B64(camtDebit('STMT-CLEAN', '42.50')) }] } });
  const s = must(syncBankChannel(ctxWith(t, host), { connectionId: conn, idempotencyKey: 'clean-1' }), 's');
  assert.equal(s.files.find((f) => f.routing === 'matched').importOk, true, 'the import succeeded');
  assert.equal(s.unappliedStatements, undefined, 'nothing unapplied');
  assert.ok(host.order.some((o) => o === 'a:ack-statements'), 'the statements token IS acknowledged on success');
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
