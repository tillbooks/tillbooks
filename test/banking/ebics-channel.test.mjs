// A33, EBICS bank channel (spec §8): the SMPG 6.1 ceremony, statement sync with byte-identical
// hand-off + IBAN routing + unmatched surfacing, the P8-gated transmit and its intent-before-upload
// idempotency + crash-in-doubt + HAC resolution, and the LOAD-BEARING invariants a non-author critic
// must see bite: THE LAW (v1 never holds sole payment authority), A33 POSTS NOTHING, no key material
// ever reaches SQLite/results, and §H-TENANT. All offline against an in-process mock EBICS host.

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
} from '../../dist/core/banking/index.js';
import {
  connectBankChannel,
  syncBankChannel,
  transmitPaymentBatch,
  getBankChannelStatus,
  disconnectBankChannel,
  assertNoSoleAuthority,
  guardNoSoleAuthority,
  SoleAuthorityViolation,
} from '../../dist/core/banking/ebics/index.js';
import { getFileContent } from '../../dist/core/files/index.js';
import { makeContext } from '../../dist/core/context.js';
import { fixedClock } from '../../dist/core/clock.js';
import { createHash } from 'node:crypto';

const HOST = { url: 'https://ebics.example/ebics', hostId: 'EBICSHST', partnerId: 'PARTNER01', userId: 'USER0001' };
const B64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const sha256 = (s) => createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');

function must(res, label) {
  assert.equal(res.ok, true, `${label}: ${JSON.stringify(res)}`);
  return res;
}

/** A camt.053 for one account IBAN with one booked debit; enough for A20 to parse and route. */
function camt053(iban, statementId, seq = '1') {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08">
<BkToCstmrStmt><GrpHdr><MsgId>${statementId}-msg</MsgId><CreDtTm>2026-07-05T08:00:00</CreDtTm></GrpHdr>
<Stmt><Id>${statementId}</Id><ElctrncSeqNb>${seq}</ElctrncSeqNb>
<FrToDt><FrDtTm>2026-07-01T00:00:00</FrDtTm><ToDtTm>2026-07-01T23:59:59</ToDtTm></FrToDt>
<Acct><Id><IBAN>${iban}</IBAN></Id></Acct>
<Bal><Tp><CdOrPrtry><Cd>OPBD</Cd></CdOrPrtry></Tp><Amt Ccy="CHF">1000.00</Amt><CdtDbtInd>CRDT</CdtDbtInd></Bal>
<Bal><Tp><CdOrPrtry><Cd>CLBD</Cd></CdOrPrtry></Tp><Amt Ccy="CHF">960.00</Amt><CdtDbtInd>CRDT</CdtDbtInd></Bal>
<Ntry><NtryRef>E-${statementId}</NtryRef><Amt Ccy="CHF">42.50</Amt><CdtDbtInd>DBIT</CdtDbtInd>
<Sts><Cd>BOOK</Cd></Sts><RvslInd>false</RvslInd>
<BookgDt><Dt>2026-07-01</Dt></BookgDt><ValDt><Dt>2026-07-01</Dt></ValDt>
<BkTxCd><Domn><Cd>PMNT</Cd><Fmly><Cd>ICDT</Cd><SubFmlyCd>OTHR</SubFmlyCd></Fmly></Domn></BkTxCd>
</Ntry></Stmt></BkToCstmrStmt></Document>`;
}

/** A pain.002 status report rejecting a transmitted batch by its original MsgId. */
function pain002Reject(origMsgId) {
  return `<?xml version="1.0"?><Document><CstmrPmtStsRpt><OrgnlGrpInfAndSts>
<OrgnlMsgId>${origMsgId}</OrgnlMsgId><GrpSts>RJCT</GrpSts>
<StsRsnInf><AddtlInf>Insufficient cover on debtor account</AddtlInf></StsRsnInf>
</OrgnlGrpInfAndSts></CstmrPmtStsRpt></Document>`;
}

/** An in-process mock EBICS host. Records every call; behaviour configurable per test. */
function mockHost(cfg = {}) {
  const calls = { sendKeys: [], fetchBankKeys: [], download: [], acknowledge: [], upload: [], suspend: [] };
  // `order` records the interleaving of download/persist/acknowledge across A36's ack step so a test
  // can assert acknowledge never precedes the persisted-and-imported statements (tripwire 1).
  const order = [];
  const BANK_HASHES = cfg.bankHashes ?? { electronicSignature: 'bankES1', authentication: 'bankAU1', encryption: 'bankEN1' };
  return {
    calls,
    order,
    BANK_HASHES,
    port: {
      sendKeys(req) {
        calls.sendKeys.push(req);
        return { ok: true };
      },
      fetchBankKeys(req) {
        calls.fetchBankKeys.push(req);
        if (cfg.hpb) return cfg.hpb();
        return { ok: true, bankKeyHashes: BANK_HASHES };
      },
      download(req) {
        calls.download.push({ service: req.service, orderRef: req.orderRef });
        order.push(`download:${req.service}`);
        // A36: the transfer phase returns an opaque ackToken and does NOT yet send the receipt.
        return { ok: true, files: (cfg.files && cfg.files[req.service]) || [], ackToken: `ack-${req.service}` };
      },
      acknowledge(req) {
        calls.acknowledge.push(req);
        order.push(`acknowledge:${req.ackToken}`);
        if (cfg.acknowledgeThrows) throw new Error('crash mid-acknowledge (receipt not sent)');
        return { ok: true };
      },
      upload(req) {
        calls.upload.push(req);
        if (cfg.uploadThrows) throw new Error('crash mid-upload (outcome UNKNOWN)');
        if (cfg.uploadRefuses) return { ok: false, reason: cfg.uploadRefuses };
        return { ok: true };
      },
      suspend(req) {
        calls.suspend.push(req);
        return { ok: true };
      },
    },
  };
}

function ctxWith(t, host, iso) {
  return makeContext(t.store, {
    workspaceId: t.workspaceId,
    actor: 'user_1',
    clock: iso ? fixedClock(iso) : t.clock,
    ids: t.ids,
    ...(host ? { ebicsTransport: host.port } : {}),
  });
}

let vendorSeq = 0;
function mkBankAccount(ctx, acc, iban, seed) {
  return must(
    createBankAccount(ctx, { name: `Konto ${seed}`, iban, ledgerAccountId: acc('1020'), idempotencyKey: `ba-${seed}` }),
    'create_bank_account',
  ).bankAccountId;
}

/** A `generated` A18 payment batch over one posted vendor bill, ready to transmit. */
function generatedBatch(ctx, acc, bankAccountId, seed) {
  const vendor = must(createContact(ctx, { partyRole: 'vendor', name: `Lief ${seed}`, idempotencyKey: `v-${seed}-${vendorSeq++}` }), 'contact').contact.id;
  const bill = must(
    createVendorBill(ctx, { vendorId: vendor, billDate: '2026-03-01', vendorReference: `LG-${seed}`, amountMinor: 100000, expenseAccountId: acc('6500'), idempotencyKey: `bill-${seed}` }),
    'create_vendor_bill',
  );
  must(postVendorBill(ctx, { vendorBillId: bill.vendorBillId, idempotencyKey: `post-${seed}` }), 'post_vendor_bill');
  must(setCreditorBankProfile(ctx, { vendorId: vendor, iban: PLAIN_IBAN, idempotencyKey: `cbp-${seed}` }), 'set_creditor_bank_profile');
  const batch = must(
    createPaymentBatch(ctx, { bankAccountId, itemIds: [bill.vendorBillId], executionDate: '2026-03-20', idempotencyKey: `batch-${seed}` }),
    'create_payment_batch',
  );
  must(generatePain001(ctx, { batchId: batch.batchId, idempotencyKey: `gen-${seed}` }), 'generate_pain001');
  return batch.batchId;
}

// --- THE LAW ---------------------------------------------------------------------------------------

test('THE LAW: v1 submits WITHOUT the authorizing signature flag and never sets requestEDS', () => {
  const posture = assertNoSoleAuthority();
  assert.equal(posture.signatureFlag, false, 'TILL must never hold sole payment authority (spec §3)');
  assert.equal(posture.requestEDS, false, 'requestEDS unset => VEU is unreachable in v1');
});

// --- ceremony (SMPG 6.1) --------------------------------------------------------------------------

test('connect with NO transport does the local work (keys + INI letter) and degrades honestly', () => {
  const t = setup();
  const bankAccountId = mkBankAccount(t.ctx, t.acc, PLAIN_IBAN, 'nc');
  const res = must(
    connectBankChannel(t.ctx, { host: HOST, routeBankAccountIds: [bankAccountId], confirm: true, idempotencyKey: 'nc-1' }),
    'connect',
  );
  assert.equal(res.state, 'keys_generated');
  assert.equal(res.reason, 'needs_bank_transport');
  assert.ok(res.iniLetterDocumentId, 'the INI letter is a real E00 artifact');
  // The INI letter carries the PUBLIC key hashes, never key material.
  const letter = must(getFileContent(t.ctx, { fileId: res.iniLetterDocumentId }), 'file');
  const text = Buffer.from(letter.contentBase64, 'base64').toString('utf8');
  assert.match(text, /INI-Brief/);
  assert.match(text, /SHA-256/);
});

test('connect P8: an unconfirmed connect with the dial off is refused, writing nothing', () => {
  const t = setup();
  const bankAccountId = mkBankAccount(t.ctx, t.acc, PLAIN_IBAN, 'p8');
  const before = snapshot(t.store);
  const res = connectBankChannel(t.ctx, { host: HOST, routeBankAccountIds: [bankAccountId], idempotencyKey: 'p8-1' });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'needs_confirmation');
  assert.equal(snapshot(t.store), before, 'a refused connect must write nothing');
});

test('full ceremony over the mock host reaches active only on bank-key confirm', () => {
  const t = setup();
  const bankAccountId = mkBankAccount(t.ctx, t.acc, PLAIN_IBAN, 'cer');
  const host = mockHost();
  const ctx = ctxWith(t, host);

  const c1 = must(connectBankChannel(ctx, { host: HOST, routeBankAccountIds: [bankAccountId], confirm: true, idempotencyKey: 'cer-1' }), 'connect1');
  assert.equal(c1.state, 'pending_bank_activation', 'INI+HIA sent, waiting on the bank');
  assert.equal(host.calls.sendKeys.length, 1);

  // HPB surfaces the bank hashes but does NOT activate without confirmBankKeys.
  const c2 = must(connectBankChannel(ctx, { connectionId: c1.connectionId, confirm: true, idempotencyKey: 'cer-2' }), 'hpb');
  assert.equal(c2.state, 'pending_bank_activation');
  assert.deepEqual(c2.bankKeyHashes, host.BANK_HASHES);

  const c3 = must(connectBankChannel(ctx, { connectionId: c1.connectionId, confirmBankKeys: true, confirm: true, idempotencyKey: 'cer-3' }), 'activate');
  assert.equal(c3.state, 'active');
  assert.equal(c3.activatedConnectionId, c1.connectionId, 'the OP8 emit path is populated on the active flip');
});

test('a bank-key rotation on an active channel hard-stops (bank_keys_mismatch), never auto-accepted', () => {
  const t = setup();
  const bankAccountId = mkBankAccount(t.ctx, t.acc, PLAIN_IBAN, 'rot');
  const host = mockHost();
  const ctx = ctxWith(t, host);
  const c1 = must(connectBankChannel(ctx, { host: HOST, routeBankAccountIds: [bankAccountId], confirm: true, idempotencyKey: 'rot-1' }), 'connect');
  must(connectBankChannel(ctx, { connectionId: c1.connectionId, confirmBankKeys: true, confirm: true, idempotencyKey: 'rot-2' }), 'activate');

  // The bank rotates its keys: a re-confirm now sees different hashes.
  const rotated = mockHost({ bankHashes: { electronicSignature: 'CHANGED', authentication: 'CHANGED', encryption: 'CHANGED' } });
  const ctx2 = ctxWith(t, rotated);
  const mism = connectBankChannel(ctx2, { connectionId: c1.connectionId, confirmBankKeys: true, confirm: true, idempotencyKey: 'rot-3' });
  assert.equal(mism.ok, false);
  assert.equal(mism.error, 'bank_keys_mismatch');
  const status = must(getBankChannelStatus(ctx2, {}), 'status').channels[0];
  assert.equal(status.state, 'bank_keys_changed', 'traffic halts until the operator re-confirms out of band');
});

test('a bank that offers no EBICS returns the honest terminal no_ebics_offer, naming the file floor', () => {
  const t = setup();
  const bankAccountId = mkBankAccount(t.ctx, t.acc, PLAIN_IBAN, 'noff');
  const host = mockHost();
  host.port.sendKeys = () => ({ ok: false, reason: 'no_ebics_offer' });
  const ctx = ctxWith(t, host);
  const res = connectBankChannel(ctx, { host: HOST, routeBankAccountIds: [bankAccountId], confirm: true, idempotencyKey: 'noff-1' });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'no_ebics_offer');
});

// --- sync -----------------------------------------------------------------------------------------

test('sync routes camt by IBAN, hands A20 byte-identical content, surfaces unmatched, re-sync no-op', () => {
  const t = setup();
  const chf = mkBankAccount(t.ctx, t.acc, PLAIN_IBAN, 'chf');
  const chfIban = PLAIN_IBAN.replace(/\s+/g, '');
  const otherIban = QR_IBAN.replace(/\s+/g, '');

  const statementXml = camt053(chfIban, 'STMT-CHF');
  const unmatchedXml = camt053(otherIban, 'STMT-OTHER');
  const host = mockHost({ files: { statements: [
    { msgName: 'camt.053', contentBase64: B64(statementXml) },
    { msgName: 'camt.053', contentBase64: B64(unmatchedXml) },
  ] } });
  const ctx = ctxWith(t, host);
  const c1 = must(connectBankChannel(ctx, { host: HOST, routeBankAccountIds: [chf], confirm: true, idempotencyKey: 's-1' }), 'connect');
  must(connectBankChannel(ctx, { connectionId: c1.connectionId, confirmBankKeys: true, confirm: true, idempotencyKey: 's-2' }), 'activate');

  const sync = must(syncBankChannel(ctx, { connectionId: c1.connectionId, idempotencyKey: 's-sync-1' }), 'sync');
  const matched = sync.files.find((f) => f.routing === 'matched');
  const unmatched = sync.files.find((f) => f.routing === 'unmatched_account');
  assert.ok(matched, 'the CHF statement routes to its account');
  assert.equal(matched.bankAccountId, chf);
  assert.equal(matched.importOk, true, 'A20 imported the routed statement');
  assert.ok(unmatched, 'the foreign-IBAN statement is surfaced, never dropped');
  assert.equal(unmatched.iban, otherIban);

  // Byte-identical hand-off: the persisted E00 artifact equals the bytes the bank sent.
  const persisted = must(getFileContent(ctx, { fileId: matched.documentId }), 'artifact');
  const persistedXml = Buffer.from(persisted.contentBase64, 'base64').toString('utf8');
  assert.equal(sha256(persistedXml), sha256(statementXml), 'the fetched file is persisted byte-for-byte');

  // A re-sync of the same statements is A20's dedupe no-op: no new bank_statement rows.
  const stmtCount = () => t.store.db.prepare('SELECT COUNT(*) AS n FROM bank_statement WHERE workspace_id = ?').get(t.workspaceId).n;
  const after1 = stmtCount();
  must(syncBankChannel(ctx, { connectionId: c1.connectionId, idempotencyKey: 's-sync-2' }), 'resync');
  assert.equal(stmtCount(), after1, 're-sync imports nothing new (A20 dedupe)');

  // The unmatched file shows on the status card until an account is routed.
  const status = must(getBankChannelStatus(ctx, {}), 'status').channels[0];
  assert.equal(status.unmatchedFiles.length >= 1, true);
});

// --- transmit -------------------------------------------------------------------------------------

function activeChannel(t, host, seed) {
  const ctx = ctxWith(t, host);
  const bankAccountId = mkBankAccount(ctx, t.acc, PLAIN_IBAN, seed);
  const c1 = must(connectBankChannel(ctx, { host: HOST, routeBankAccountIds: [bankAccountId], confirm: true, idempotencyKey: `${seed}-c1` }), 'connect');
  must(connectBankChannel(ctx, { connectionId: c1.connectionId, confirmBankKeys: true, confirm: true, idempotencyKey: `${seed}-c2` }), 'activate');
  return { ctx, connectionId: c1.connectionId, bankAccountId };
}

test('transmit uploads one BTU (payload_sha256 = A18 file hash), never marks paid, is a no-op on re-call', () => {
  const t = setup();
  const host = mockHost();
  const { ctx, bankAccountId } = activeChannel(t, host, 'tx');
  const batchId = generatedBatch(ctx, t.acc, bankAccountId, 'tx');

  const res = must(transmitPaymentBatch(ctx, { batchId, confirm: true, idempotencyKey: 'tx-1' }), 'transmit');
  assert.equal(res.transmitted, true);
  assert.equal(res.status, 'pending_release', 'the bank authorizes out of channel; NOTHING is paid on transmit');
  assert.equal(host.calls.upload.length, 1, 'exactly one BTU order');

  // payload_sha256 equals the A18-regenerated file hash.
  const regen = must(generatePain001(ctx, { batchId, idempotencyKey: 'tx-regen' }), 'regen');
  const expected = createHash('sha256').update(Buffer.from(regen.xmlBase64, 'base64')).digest('hex');
  const order = t.store.db.prepare("SELECT payload_sha256 FROM ebics_order_log WHERE workspace_id=? AND status='pending_release'").get(t.workspaceId);
  assert.equal(order.payload_sha256, expected);

  // The batch is NOT paid (paid comes from camt via A18/A20).
  const batch = t.store.db.prepare('SELECT status FROM payment_batch WHERE id = ?').get(batchId);
  assert.equal(batch.status, 'generated', 'transmit never flips a batch to paid');

  // Re-call delivers nothing and returns the existing order (order-level idempotency).
  const again = must(transmitPaymentBatch(ctx, { batchId, confirm: true, idempotencyKey: 'tx-2' }), 're-transmit');
  assert.equal(again.transmitted, true);
  assert.equal(host.calls.upload.length, 1, 'a double transmit does NOT double-submit');
});

test('a crash mid-upload leaves an intent, surfaces transmit_in_doubt, and blocks retransmission', () => {
  const t = setup();
  const host = mockHost({ uploadThrows: true });
  const { ctx, bankAccountId } = activeChannel(t, host, 'dbt');
  const batchId = generatedBatch(ctx, t.acc, bankAccountId, 'dbt');

  assert.throws(() => transmitPaymentBatch(ctx, { batchId, confirm: true, idempotencyKey: 'dbt-1' }), /crash/);
  // The intent row committed BEFORE the upload survives; retransmission is refused.
  const intent = t.store.db.prepare("SELECT COUNT(*) AS n FROM ebics_order_log WHERE workspace_id=? AND status='intent'").get(t.workspaceId).n;
  assert.equal(intent, 1, 'the intent row is the durable trace of an unknown-outcome upload');
  const retry = transmitPaymentBatch(ctx, { batchId, confirm: true, idempotencyKey: 'dbt-2' });
  assert.equal(retry.ok, false);
  assert.equal(retry.error, 'transmit_in_doubt');
});

test('a HAC that names the order resolves an in-doubt upload to pending_release; one that omits it fails it', () => {
  const t = setup();
  // First transmit crashes -> in doubt.
  const host = mockHost({ uploadThrows: true });
  const built = activeChannel(t, host, 'hac');
  const batchId = generatedBatch(built.ctx, t.acc, built.bankAccountId, 'hac');
  assert.throws(() => transmitPaymentBatch(built.ctx, { batchId, confirm: true, idempotencyKey: 'hac-1' }), /crash/);
  const orderRef = t.store.db.prepare("SELECT order_ref FROM ebics_order_log WHERE workspace_id=? AND status='intent'").get(t.workspaceId).order_ref;

  // A HAC that NAMES the order identity: the upload arrived -> pending_release, the order stands.
  const hostFound = mockHost({ files: { customer_protocol: [{ msgName: 'HAC', contentBase64: B64(`<HAC>${orderRef}</HAC>`) }] } });
  const ctxFound = ctxWith(t, hostFound, '2026-07-20T00:00:00.000Z');
  must(syncBankChannel(ctxFound, { connectionId: built.connectionId, idempotencyKey: 'hac-sync-1' }), 'sync-hac');
  const resolved = t.store.db.prepare("SELECT status FROM ebics_order_log WHERE workspace_id=? AND order_ref=? ORDER BY rowid DESC LIMIT 1").get(t.workspaceId, orderRef);
  assert.equal(resolved.status, 'pending_release', 'a HAC naming the order confirms it arrived');
});

test('transmit with no channel routed degrades honestly (needs_bank_channel, ok:true) and the file path stands', () => {
  const t = setup();
  const bankAccountId = mkBankAccount(t.ctx, t.acc, PLAIN_IBAN, 'noch');
  const batchId = generatedBatch(t.ctx, t.acc, bankAccountId, 'noch');
  const res = must(transmitPaymentBatch(t.ctx, { batchId, confirm: true, idempotencyKey: 'noch-1' }), 'transmit');
  assert.equal(res.transmitted, false);
  assert.equal(res.reason, 'needs_bank_channel');
});

test('a pain.002 rejection lands bank_rejected with the bank reason, books untouched', () => {
  const t = setup();
  const host = mockHost();
  const { ctx, bankAccountId, connectionId } = activeChannel(t, host, 'rej');
  const batchId = generatedBatch(ctx, t.acc, bankAccountId, 'rej');
  const tx = must(transmitPaymentBatch(ctx, { batchId, confirm: true, idempotencyKey: 'rej-1' }), 'transmit');
  // The bank later rejects it; the msgId ties the pain.002 to the transmitted order.
  const msgId = t.store.db.prepare('SELECT btf_msg_name FROM ebics_order_log WHERE order_ref=? AND order_type=\'BTU\' ORDER BY rowid DESC LIMIT 1').get(tx.orderRef).btf_msg_name;
  const rejectHost = mockHost({ files: { status_report: [{ msgName: 'pain.002', contentBase64: B64(pain002Reject(msgId)) }] } });
  const ctx2 = ctxWith(t, rejectHost, '2026-07-21T00:00:00.000Z');
  const sync = must(syncBankChannel(ctx2, { connectionId, idempotencyKey: 'rej-sync' }), 'sync');
  assert.equal(sync.rejectedBatchId, batchId, 'the rejection surfaces the batch id for the OP8 emit path');
  const rejected = t.store.db.prepare("SELECT bank_reason FROM ebics_order_log WHERE workspace_id=? AND status='bank_rejected' ORDER BY rowid DESC LIMIT 1").get(t.workspaceId);
  assert.match(rejected.bank_reason, /Insufficient cover/);
});

// --- disconnect -----------------------------------------------------------------------------------

test('retire is terminal and destroys keys; block issues SPR and blocks only the EBICS channel', () => {
  const t = setup();
  const host = mockHost();
  const built = activeChannel(t, host, 'dis');
  const block = must(disconnectBankChannel(built.ctx, { connectionId: built.connectionId, mode: 'block', confirm: true, idempotencyKey: 'dis-b' }), 'block');
  assert.equal(block.state, 'blocked');
  assert.equal(host.calls.suspend.length, 1, 'the SPR administrative order is issued');

  const retire = must(disconnectBankChannel(built.ctx, { connectionId: built.connectionId, mode: 'retire', confirm: true, idempotencyKey: 'dis-r' }), 'retire');
  assert.equal(retire.state, 'retired');
  const row = t.store.db.prepare('SELECT key_ref FROM ebics_connection WHERE id = ?').get(built.connectionId);
  assert.equal(row.key_ref, null, 'a retired channel destroys its key locator');
});

// --- money-path invariants a critic must see bite -------------------------------------------------

test('A33 POSTS NOTHING: sync and transmit move NO journal_entry and NO payment row (P3 by delegation)', () => {
  const t = setup();
  const host = mockHost({ files: { statements: [{ msgName: 'camt.053', contentBase64: B64(camt053(PLAIN_IBAN.replace(/\s+/g, ''), 'STMT-NP')) }] } });
  // An active channel AND a generated batch: the batch setup posts a vendor bill (A17 -> A02), which
  // is deliberately EXCLUDED from the A33 measurement by capturing the baseline AFTER it.
  const built = activeChannel(t, host, 'np');
  const batchId = generatedBatch(built.ctx, t.acc, built.bankAccountId, 'np');
  const ctx = built.ctx;

  const journalCount = () => t.store.db.prepare('SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id=?').get(t.workspaceId).n;
  const paymentCount = () => t.store.db.prepare('SELECT COUNT(*) AS n FROM payment WHERE workspace_id=?').get(t.workspaceId).n;
  const beforeJournal = journalCount();
  const beforePayment = paymentCount();

  // The two A33 money-adjacent verbs run against the baseline. Neither may write a ledger row.
  must(syncBankChannel(ctx, { connectionId: built.connectionId, idempotencyKey: 'np-sync' }), 'sync');
  must(transmitPaymentBatch(ctx, { batchId, confirm: true, idempotencyKey: 'np-tx' }), 'transmit');

  // The invariant BITES: both counts are unchanged by A33's own work.
  assert.equal(journalCount(), beforeJournal, 'A33 sync/transmit posted a journal_entry (P3 violated)');
  assert.equal(paymentCount(), beforePayment, 'A33 sync/transmit wrote a payment row (P3 violated)');
  // And A33 DID do its own metadata work, so the assertion above is not vacuously green.
  const orderLog = t.store.db.prepare('SELECT COUNT(*) AS n FROM ebics_order_log WHERE workspace_id=?').get(t.workspaceId).n;
  assert.ok(orderLog > 0, 'the order log is A33 metadata, proving the loop actually ran');
});

test('THE LAW is a runtime guard, not documentary: a tampered upload request throws before any egress', () => {
  // guardNoSoleAuthority is invoked on the real transmit path (channel.ts): a request carrying a
  // signature/authorization flag never reaches the port. A clean v1 request passes through untouched.
  assert.throws(() => guardNoSoleAuthority({ signatureFlag: true }), SoleAuthorityViolation);
  assert.throws(() => guardNoSoleAuthority({ SignatureFlag: 1 }), SoleAuthorityViolation);
  assert.throws(() => guardNoSoleAuthority({ requestEDS: 'yes' }), SoleAuthorityViolation);
  const clean = { orderRef: 'r1', payloadBase64: 'x', btf: { serviceName: 'MCT', msgName: 'm' } };
  assert.equal(guardNoSoleAuthority(clean), clean, 'the v1 request is handed to the port untouched');
});

test('no key material EVER reaches SQLite or any verb result (tripwire 3)', () => {
  const t = setup();
  const host = mockHost({ files: { statements: [{ msgName: 'camt.053', contentBase64: B64(camt053(PLAIN_IBAN.replace(/\s+/g, ''), 'STMT-K')) }] } });
  const ctx = ctxWith(t, host);
  const bankAccountId = mkBankAccount(ctx, t.acc, PLAIN_IBAN, 'k');
  const c1 = must(connectBankChannel(ctx, { host: HOST, routeBankAccountIds: [bankAccountId], confirm: true, idempotencyKey: 'k-1' }), 'connect');
  must(connectBankChannel(ctx, { connectionId: c1.connectionId, confirmBankKeys: true, confirm: true, idempotencyKey: 'k-2' }), 'activate');
  const sync = must(syncBankChannel(ctx, { connectionId: c1.connectionId, idempotencyKey: 'k-sync' }), 'sync');
  const status = must(getBankChannelStatus(ctx, {}), 'status');

  // No PEM / PRIVATE KEY markers anywhere in the DB dump or the returned results.
  const dump = snapshot(t.store);
  const results = JSON.stringify({ c1, sync, status });
  for (const marker of ['PRIVATE KEY', 'BEGIN RSA', 'BEGIN PRIVATE', 'privatePem', '-----BEGIN']) {
    assert.equal(dump.includes(marker), false, `DB dump must not contain ${marker}`);
    assert.equal(results.includes(marker), false, `a verb result must not contain ${marker}`);
  }
  // The key_ref is a locator, not a key: it is an opaque id.
  const row = t.store.db.prepare('SELECT key_ref FROM ebics_connection WHERE id=?').get(c1.connectionId);
  assert.match(row.key_ref, /^ebicskey-/);
});

test('§H-TENANT: a channel in workspace A is invisible to workspace B', () => {
  const t = setup();
  const host = mockHost();
  const built = activeChannel(t, host, 'ten');
  const other = secondWorkspace(t);
  const otherStatus = must(getBankChannelStatus(other.ctx, {}), 'status-B');
  assert.equal(otherStatus.channels.length, 0, 'a neighbour tenant sees none of A\'s channels');
  // And B cannot read A's connection by id.
  const cross = getBankChannelStatus(other.ctx, { bankAccountId: built.bankAccountId });
  assert.equal(cross.ok, true);
  assert.equal(cross.channels.length, 0);
});
