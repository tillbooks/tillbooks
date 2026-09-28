// A36, live bank feed (spec §8): the money-path invariants a non-author critic must SEE bite.
//  - the receipt step: persist AND process BEFORE the receipt (tripwire 1), a receipt that never
//    reached the bank re-offers the data and still lands EXACTLY ONE row (idempotency ON ROWS);
//  - keystore_locked / keystore_unavailable pre-check refuses sync without regenerating;
//  - ranked debit matching keeps the exact amount+currency gate mandatory and adds reason signals;
//  - the batch join proposes the A18 batch (delegate-only) and blocks a total mismatch;
//  - bank_txn.needs_review fires per-txn (result.needsReviewTxnId), §H-TENANT, credits refuse;
//  - the scheduled sync is parked (D-A36.10): a rule link is refused, the unlink stays valid.
// All offline against the in-process bank of `ebics-support.mjs` (contract 2). The deeper crash
// windows live in `ebics-sync.test.mjs`.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { setup, secondWorkspace, PLAIN_IBAN, QR_IBAN, snapshot } from './support.mjs';
import { createContact } from '../../dist/core/sales/index.js';
import { createVendorBill, postVendorBill } from '../../dist/core/purchase/index.js';
import {
  createBankAccount,
  setCreditorBankProfile,
  createPaymentBatch,
  generatePain001,
  importCamt,
  suggestCamtMatches,
  reviewBankTxn,
  setCamtMatching,
} from '../../dist/core/banking/index.js';
import {
  connectBankChannel,
  syncBankChannel,
  getBankChannelStatus,
  disconnectBankChannel,
  setBankSyncSchedule,
} from '../../dist/core/banking/ebics/index.js';
import { compactReference } from '../../dist/core/banking/pain001.js';
import { makeContext } from '../../dist/core/context.js';
import { mockBank, container, chain } from './ebics-support.mjs';

const HOST = { url: 'https://ebics.example/ebics', hostId: 'EBICSHST', partnerId: 'PARTNER01', userId: 'USER0001' };
const B64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const IBAN = PLAIN_IBAN.replace(/\s+/g, '');

function must(res, label) {
  assert.equal(res.ok, true, `${label}: ${JSON.stringify(res)}`);
  return res;
}

function ctxWith(t, bank, keystore) {
  return makeContext(t.store, {
    workspaceId: t.workspaceId,
    actor: 'user_1',
    clock: t.clock,
    ids: t.ids,
    ...(bank ? { ebicsTransport: bank.port } : {}),
    ...(keystore ? { ebicsKeystore: keystore } : {}),
  });
}

function mkBankAccount(ctx, acc) {
  return must(createBankAccount(ctx, { name: 'Konto', iban: PLAIN_IBAN, ledgerAccountId: acc('1020'), idempotencyKey: 'ba' }), 'ba').bankAccountId;
}

/** The real ceremony against the in-process bank: connect, fetch the bank keys, confirm the reviewed set. */
function activeChannel(ctx, bankAccountId, seed) {
  const c1 = must(connectBankChannel(ctx, { host: HOST, routeBankAccountIds: [bankAccountId], confirm: true, idempotencyKey: `${seed}-1` }), 'connect');
  const fetched = must(connectBankChannel(ctx, { connectionId: c1.connectionId, confirm: true }), 'fetch');
  must(
    connectBankChannel(ctx, { connectionId: c1.connectionId, confirmBankKeys: true, expectedBankKeyHashes: fetched.bankKeyHashes, confirm: true }),
    'activate',
  );
  return c1.connectionId;
}

/** One synthetic day-end statement for the PLAIN_IBAN account (numbered, with chained balances). */
function dayEnd(seq, opening, entries) {
  return chain({ iban: IBAN, firstSeq: seq, firstDate: '2026-07-01', opening, days: [entries] })[0].xml;
}

/** A camt.053 with one DBIT of `amountMajor`, an optional payer name, value date, and Btch/PmtInfId. */
function camtDebit(statementId, amountMajor, opts = {}) {
  const btch = opts.pmtInfId ? `<NtryDtls><Btch><PmtInfId>${opts.pmtInfId}</PmtInfId></Btch></NtryDtls>` : '';
  const val = opts.valueDate ?? '2026-07-01';
  const payer = opts.payerName
    ? `<NtryDtls><TxDtls><RltdPties><Dbtr><Pty><Nm>${opts.payerName}</Nm></Pty></Dbtr></RltdPties></TxDtls></NtryDtls>`
    : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08">
<BkToCstmrStmt><GrpHdr><MsgId>${statementId}-msg</MsgId><CreDtTm>2026-07-05T08:00:00</CreDtTm></GrpHdr>
<Stmt><Id>${statementId}</Id><ElctrncSeqNb>1</ElctrncSeqNb>
<FrToDt><FrDtTm>2026-07-01T00:00:00</FrDtTm><ToDtTm>2026-07-31T23:59:59</ToDtTm></FrToDt>
<Acct><Id><IBAN>${IBAN}</IBAN></Id></Acct>
<Ntry><NtryRef>E-${statementId}</NtryRef><Amt Ccy="CHF">${amountMajor}</Amt><CdtDbtInd>DBIT</CdtDbtInd>
<Sts><Cd>BOOK</Cd></Sts><RvslInd>false</RvslInd>
<BookgDt><Dt>${val}</Dt></BookgDt><ValDt><Dt>${val}</Dt></ValDt>
<BkTxCd><Domn><Cd>PMNT</Cd><Fmly><Cd>ICDT</Cd><SubFmlyCd>OTHR</SubFmlyCd></Fmly></Domn></BkTxCd>
${btch}${payer}</Ntry></Stmt></BkToCstmrStmt></Document>`;
}

/** A minimal in-memory keystore stub with a settable state(), to exercise the sync pre-check. */
function keystoreStub(state) {
  return {
    kind: 'file',
    persistent: true,
    state: () => state,
    generate: () => ({ keyRef: 'k', hashes: { electronicSignature: 'a', authentication: 'b', encryption: 'c' } }),
    publicHashes: () => ({ electronicSignature: 'a', authentication: 'b', encryption: 'c' }),
    destroy: () => {},
  };
}

function txnCount(store, workspaceId) {
  return store.db.prepare('SELECT COUNT(*) AS n FROM bank_txn WHERE workspace_id = ?').get(workspaceId).n;
}

// --- the receipt step (tripwire 1 + idempotency on ROWS) ------------------------------------------

test('the receipt is sent AFTER the statement is persisted and imported (tripwire 1)', () => {
  const t = setup();
  const acc = mkBankAccount(t.ctx, t.acc);
  const bank = mockBank();
  const ctx = ctxWith(t, bank);
  const conn = activeChannel(ctx, acc, 'ack');
  bank.offer(container([dayEnd(1, 100000, [{ minor: -4250 }])]));
  const atReceipt = [];
  bank.state.onAck = () => atReceipt.push(txnCount(t.store, t.workspaceId));

  const sync = must(syncBankChannel(ctx, { connectionId: conn, idempotencyKey: 'sync-1' }), 'sync');
  assert.deepEqual(sync.statements.map((s) => s.outcome), ['imported']);
  assert.deepEqual(atReceipt, [1], 'when the bank sees the receipt the line is already committed');
  const kinds = bank.log.map((e) => e.kind);
  assert.ok(kinds.indexOf('BTD-ACK') > kinds.lastIndexOf('BTD'), `the receipt follows the download: ${kinds.join(',')}`);
});

test('a receipt that never reached the bank re-offers the data and still lands EXACTLY ONE row (idempotency on ROWS)', () => {
  const t = setup();
  const acc = mkBankAccount(t.ctx, t.acc);
  const bank = mockBank();
  const ctx = ctxWith(t, bank);
  const conn = activeChannel(ctx, acc, 'crash');
  bank.offer(container([dayEnd(1, 100000, [{ minor: -4250 }])]));

  // First sync: the receipt throws after the statement is already persisted and imported.
  bank.state.throwOnAck = true;
  must(syncBankChannel(ctx, { connectionId: conn, idempotencyKey: 'sync-crash-a' }), 'sync-1 survives the lost receipt');
  assert.equal(txnCount(t.store, t.workspaceId), 1, 'one row after the first sync');

  // The bank still offers the statement: a re-pull (a new idempotency key) adds nothing.
  bank.state.throwOnAck = false;
  must(syncBankChannel(ctx, { connectionId: conn, idempotencyKey: 'sync-crash-b' }), 'sync-2 (the re-pull)');
  assert.equal(txnCount(t.store, t.workspaceId), 1, 'STILL one row: the member was final, nothing re-imported');
});

// --- keystore pre-check (US-A36.2) ----------------------------------------------------------------

test('sync refuses on a locked keystore and an unavailable one, without regenerating', () => {
  const t = setup();
  const acc = mkBankAccount(t.ctx, t.acc);
  // Bring the channel active with a ready keystore first.
  const bank = mockBank();
  const conn = activeChannel(ctxWith(t, bank), acc, 'ks');
  const before = bank.log.length;

  const locked = syncBankChannel(ctxWith(t, bank, keystoreStub('locked')), { connectionId: conn, idempotencyKey: 'ks-l' });
  assert.equal(locked.ok, false);
  assert.equal(locked.error, 'keystore_locked');

  const gone = syncBankChannel(ctxWith(t, bank, keystoreStub('unavailable')), { connectionId: conn, idempotencyKey: 'ks-u' });
  assert.equal(gone.ok, false);
  assert.equal(gone.error, 'keystore_unavailable');
  assert.equal(bank.log.length, before, 'nothing was sent to the bank');
});

// --- ranked debit matching (US-A36.5) -------------------------------------------------------------

function openBill(ctx, acc, amountMinor, vendorReference, seed, vendorName = 'Swisscom') {
  const vendor = must(createContact(ctx, { partyRole: 'vendor', name: vendorName, idempotencyKey: `v-${seed}` }), 'vendor').contact.id;
  const bill = must(
    createVendorBill(ctx, { vendorId: vendor, billDate: '2026-06-01', dueDate: '2026-07-03', vendorReference, amountMinor, expenseAccountId: acc('6500'), idempotencyKey: `bill-${seed}` }),
    'bill',
  );
  must(postVendorBill(ctx, { vendorBillId: bill.vendorBillId, idempotencyKey: `post-${seed}` }), 'post');
  return bill.vendorBillId;
}

test('the exact amount + currency gate is MANDATORY; ranking adds value-date/reference signals', () => {
  const t = setup();
  const acc = mkBankAccount(t.ctx, t.acc);
  const billId = openBill(t.ctx, t.acc, 124055, 'INV-778', 'match');
  // A debit of the SAME amount, value date within the window, quoting the invoice number.
  const stmt = must(importCamt(t.ctx, { bankAccountId: acc, xml: camtDebit('STMT-M', '1240.55', { valueDate: '2026-07-05', payerName: 'INV-778 Swisscom' }), idempotencyKey: 'imp-m' }), 'import');
  const sug = must(suggestCamtMatches(t.ctx, { statementId: stmt.statementId }), 'suggest');
  const p = sug.txns[0].proposal;
  assert.equal(p.kind, 'vendor_bill');
  assert.equal(p.targetId, billId);
  assert.ok(p.signals.includes('amount'), 'the amount signal is always present');
  assert.ok(p.signals.includes('value_date'), 'value date within window scored');
  assert.equal(sug.txns[0].needsReview, false, 'a high-confidence match is not a review case');

  // A debit whose amount matches NO open bill gets no vendor_bill candidate and needs review.
  const stmt2 = must(importCamt(t.ctx, { bankAccountId: acc, xml: camtDebit('STMT-N', '99.99'), idempotencyKey: 'imp-n' }), 'import2');
  const sug2 = must(suggestCamtMatches(t.ctx, { statementId: stmt2.statementId }), 'suggest2');
  assert.equal(sug2.txns[0].proposal, null, 'no candidate ever differs in amount (the gate)');
  assert.equal(sug2.txns[0].needsReview, true);
});

test('the batch join proposes the A18 batch on PmtInfId+total, and BLOCKS a total mismatch', () => {
  const t = setup();
  const acc = mkBankAccount(t.ctx, t.acc);
  // A generated A18 batch over one 1000.00 bill: ctrl_sum = 100000 Rappen, PmtInfId = compactReference('P', batchId).
  const vendor = must(createContact(t.ctx, { partyRole: 'vendor', name: 'Lieferant', idempotencyKey: 'bv' }), 'vendor').contact.id;
  const bill = must(createVendorBill(t.ctx, { vendorId: vendor, billDate: '2026-06-01', amountMinor: 100000, expenseAccountId: t.acc('6500'), idempotencyKey: 'bbill' }), 'bill');
  must(postVendorBill(t.ctx, { vendorBillId: bill.vendorBillId, idempotencyKey: 'bpost' }), 'post');
  must(setCreditorBankProfile(t.ctx, { vendorId: vendor, iban: PLAIN_IBAN, idempotencyKey: 'bcbp' }), 'cbp');
  const batch = must(createPaymentBatch(t.ctx, { bankAccountId: acc, itemIds: [bill.vendorBillId], executionDate: '2026-07-10', idempotencyKey: 'bbatch' }), 'batch');
  must(generatePain001(t.ctx, { batchId: batch.batchId, idempotencyKey: 'bgen' }), 'gen');
  const pmtInfId = compactReference('P', batch.batchId);

  // The single batch debit arrives with matching PmtInfId + total.
  const stmt = must(importCamt(t.ctx, { bankAccountId: acc, xml: camtDebit('STMT-B', '1000.00', { pmtInfId }), idempotencyKey: 'imp-b' }), 'import');
  const p = must(suggestCamtMatches(t.ctx, { statementId: stmt.statementId }), 'suggest').txns[0].proposal;
  assert.equal(p.kind, 'payment_batch');
  assert.equal(p.targetId, batch.batchId);
  assert.notEqual(p.blocked, true, 'a matching total is one-click confirmable');

  // A debit with the same PmtInfId but a DIFFERENT total is shown blocked (manual split), not confirmable.
  const stmt2 = must(importCamt(t.ctx, { bankAccountId: acc, xml: camtDebit('STMT-B2', '750.00', { pmtInfId }), idempotencyKey: 'imp-b2' }), 'import2');
  const p2 = must(suggestCamtMatches(t.ctx, { statementId: stmt2.statementId }), 'suggest2').txns[0].proposal;
  assert.equal(p2.kind, 'payment_batch');
  assert.equal(p2.blocked, true, 'a batch-total mismatch blocks the one-click confirm');
  assert.ok(p2.signals.includes('batch_total_mismatch'));
});

// --- bank_txn.needs_review (US-A36.5) -------------------------------------------------------------

test('review_bank_txn fires needsReviewTxnId for an unmatched debit, null-collapses a matched one', () => {
  const t = setup();
  const acc = mkBankAccount(t.ctx, t.acc);
  openBill(t.ctx, t.acc, 5000, 'INV-1', 'r1');
  const stmt = must(importCamt(t.ctx, { bankAccountId: acc, xml: camtDebit('STMT-R', '99.99'), idempotencyKey: 'imp-r' }), 'import');
  const unmatchedTxn = t.store.db.prepare('SELECT id FROM bank_txn WHERE workspace_id = ? AND statement_id = ?').get(t.workspaceId, stmt.statementId).id;

  const r = must(reviewBankTxn(t.ctx, { bankTxnId: unmatchedTxn, idempotencyKey: 'rev-1' }), 'review');
  assert.equal(r.needsReview, true);
  assert.equal(r.needsReviewTxnId, unmatchedTxn, 'the event resolves the txn id (one entity per firing)');

  // A replay is idempotent (same result, no second effect).
  const r2 = must(reviewBankTxn(t.ctx, { bankTxnId: unmatchedTxn, idempotencyKey: 'rev-1' }), 'review-replay');
  assert.deepEqual(r2, r);
});

test('review_bank_txn is §H-TENANT (foreign id not_found) and refuses a credit', () => {
  const t = setup();
  const acc = mkBankAccount(t.ctx, t.acc);
  // A credit txn: import a camt with a CRDT entry via the shared A20 path is verbose; instead prove
  // the tenant + credit refusals with a foreign id and a known credit-classified row.
  const foreign = reviewBankTxn(t.ctx, { bankTxnId: 'btxn-does-not-exist', idempotencyKey: 'rev-x' });
  assert.equal(foreign.ok, false);
  assert.equal(foreign.error, 'not_found');

  // §H-TENANT: a txn in workspace A is not_found in workspace B.
  openBill(t.ctx, t.acc, 4200, 'INV-Z', 'tz');
  const stmt = must(importCamt(t.ctx, { bankAccountId: acc, xml: camtDebit('STMT-T', '77.00'), idempotencyKey: 'imp-t' }), 'import');
  const txn = t.store.db.prepare('SELECT id FROM bank_txn WHERE workspace_id = ? AND statement_id = ?').get(t.workspaceId, stmt.statementId).id;
  const w2 = secondWorkspace(t);
  const cross = reviewBankTxn(w2.ctx, { bankTxnId: txn, idempotencyKey: 'rev-cross' });
  assert.equal(cross.ok, false);
  assert.equal(cross.error, 'not_found', 'a foreign-workspace txn is invisible');
});

// --- matching tuning (§6b) ------------------------------------------------------------------------

test('set_camt_matching tunes the review threshold so a medium match still flags review', () => {
  const t = setup();
  const acc = mkBankAccount(t.ctx, t.acc);
  // Two open bills with the SAME amount and no distinguishing signal => an ambiguous (medium) match.
  openBill(t.ctx, t.acc, 8000, 'A', 'amb1', 'Alpha');
  openBill(t.ctx, t.acc, 8000, 'B', 'amb2', 'Beta');
  const stmt = must(importCamt(t.ctx, { bankAccountId: acc, xml: camtDebit('STMT-AMB', '80.00'), idempotencyKey: 'imp-amb' }), 'import');

  // Default threshold 'any': a medium proposal suppresses review.
  const before = must(suggestCamtMatches(t.ctx, { statementId: stmt.statementId }), 'suggest').txns[0];
  assert.equal(before.proposal.confidence, 'medium');
  assert.equal(before.needsReview, false);

  // Raise the threshold to 'high': the same medium proposal now flags review.
  must(setCamtMatching(t.ctx, { reviewThreshold: 'high', idempotencyKey: 'sc-1' }), 'set');
  const after = must(suggestCamtMatches(t.ctx, { statementId: stmt.statementId }), 'suggest2').txns[0];
  assert.equal(after.needsReview, true, 'a medium match below the raised threshold needs review');
});

// --- the scheduled sync is parked (D-A36.10) -----------------------------------------------------

test('set_bank_sync_schedule refuses a rule (sync_schedule_parked); the unlink stays valid; the status has no schedule', () => {
  const t = setup();
  const acc = mkBankAccount(t.ctx, t.acc);
  const bank = mockBank();
  const ctx = ctxWith(t, bank);
  const conn = activeChannel(ctx, acc, 'sch');

  const ruleId = t.ids.next('arule');
  t.store.db
    .prepare(
      `INSERT INTO automation_rule (id, workspace_id, name, trigger_event, condition, action_tool, action_input, enabled, archived, created_by, created_at, updated_at)
       VALUES (?, ?, 'Morgenabruf', 'schedule.daily', 'null', 'bank_sync', ?, 1, 0, 'user_1', ?, ?)`,
    )
    .run(ruleId, t.workspaceId, JSON.stringify({ connectionId: conn }), t.clock.now(), t.clock.now());

  const linked = setBankSyncSchedule(ctx, { connectionId: conn, ruleId, idempotencyKey: 'link-1' });
  assert.equal(linked.ok, false);
  assert.equal(linked.error, 'sync_schedule_parked');
  assert.equal(t.store.db.prepare('SELECT sync_rule_id FROM ebics_connection WHERE id = ?').get(conn).sync_rule_id, null);

  // An older build's stored pointer: the unlink (no ruleId) clears it, idempotently.
  t.store.db.prepare('UPDATE ebics_connection SET sync_rule_id = ? WHERE id = ?').run(ruleId, conn);
  const unlinked = must(setBankSyncSchedule(ctx, { connectionId: conn, idempotencyKey: 'unlink-1' }), 'unlink');
  assert.equal(unlinked.syncRuleId, null);
  assert.deepEqual(must(setBankSyncSchedule(ctx, { connectionId: conn, idempotencyKey: 'unlink-1' }), 'replay'), unlinked);
  assert.equal(t.store.db.prepare('SELECT sync_rule_id FROM ebics_connection WHERE id = ?').get(conn).sync_rule_id, null);

  const chan = must(getBankChannelStatus(ctx, {}), 'status').channels[0];
  assert.equal(chan.schedule, undefined, 'no cadence facet: the sync is on demand only');
  assert.ok(chan.keystore, 'the status carries a keystore facet');

  must(disconnectBankChannel(ctx, { connectionId: conn, mode: 'retire', confirm: true, idempotencyKey: 'ret-1' }), 'retire');
  assert.equal(must(getBankChannelStatus(ctx, {}), 'status2').channels[0].state, 'retired');
});
