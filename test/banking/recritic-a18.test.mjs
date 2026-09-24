// A18 RE-CRITIC PROBES (independent, non-author). Written fresh, not copied from the author's
// critic-a18-findings.test.mjs. Each is an ATTACK aimed at the ORIGINAL FAIL findings, measured
// against the remediation head.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { setup, PLAIN_IBAN, QR_IBAN, snapshot } from './support.mjs';
import { makeContext } from '../../dist/core/context.js';
import { fixedClock } from '../../dist/core/clock.js';
import { systemIdGen } from '../../dist/core/ids.js';
import { createVendorBill, postVendorBill } from '../../dist/core/purchase/index.js';
import { createContact } from '../../dist/core/sales/index.js';
import {
  createBankAccount,
  setCreditorBankProfile,
  createPaymentBatch,
  generatePain001,
  getPaymentBatch,
  listPayableOpenItems,
  markBatchPaid,
  discardPaymentBatch,
  validatePain001,
} from '../../dist/core/banking/index.js';
import { compactReference } from '../../dist/core/banking/pain001.js';

function must(res, what) {
  assert.equal(res.ok, true, `${what} failed: ${JSON.stringify(res)}`);
  return res;
}

// A fresh workspace whose ctx uses PRODUCTION ids (systemIdGen) and a MOVING clock, which is exactly
// what the author's own suite never does. `setup()` gives us a seeded chart; we then rebuild ctx.
function prodEnv() {
  const t = setup();
  let now = '2026-07-19T00:00:00.000Z';
  const ids = systemIdGen;
  const clock = { now: () => now, setNow: (v) => (now = v) };
  const ctx = makeContext(t.store, { workspaceId: t.workspaceId, actor: 'user_1', clock, ids });
  return { t, ctx, store: t.store, acc: t.acc, setNow: (v) => (now = v), clock };
}

function mkVendor(ctx, seed) {
  return must(createContact(ctx, { partyRole: 'vendor', name: `Lieferant ${seed}`, idempotencyKey: `v-${seed}` }), 'contact').contact.id;
}
function mkBill(ctx, acc, vendor, seed, amountMinor, extra = {}) {
  const b = must(createVendorBill(ctx, { vendorId: vendor, billDate: '2026-03-01', amountMinor, expenseAccountId: acc('6500'), idempotencyKey: `bill-${seed}`, ...extra }), 'bill');
  must(postVendorBill(ctx, { vendorBillId: b.vendorBillId, idempotencyKey: `post-${seed}` }), 'post');
  return b.vendorBillId;
}
function mkBank(ctx, acc) {
  return must(createBankAccount(ctx, { name: 'Kontokorrent', iban: PLAIN_IBAN, ledgerAccountId: acc('1020'), idempotencyKey: 'bank-1' }), 'bank').bankAccountId;
}

// ---------------------------------------------------------------------------------------------
// F1: a duplicated bill in itemIds is refused, AND the UNIQUE index is the DB floor.
// ---------------------------------------------------------------------------------------------
test('F1 input guard refuses a duplicated bill', () => {
  const { ctx, acc } = prodEnv();
  const v = mkVendor(ctx, 'f1');
  const bill = mkBill(ctx, acc, v, 'f1', 100000);
  const bank = mkBank(ctx, acc);
  must(setCreditorBankProfile(ctx, { vendorId: v, iban: PLAIN_IBAN, idempotencyKey: 'p-f1' }), 'profile');
  const res = createPaymentBatch(ctx, { bankAccountId: bank, itemIds: [bill, bill], executionDate: '2026-07-20', idempotencyKey: 'b-f1' });
  assert.equal(res.ok, false, 'duplicate selection must be refused');
  assert.equal(res.error, 'duplicate_item', `expected duplicate_item, got ${JSON.stringify(res)}`);
});

test('F1 UNIQUE index bites on a direct duplicate insert', () => {
  const { ctx, acc, store } = prodEnv();
  const v = mkVendor(ctx, 'f1b');
  const bill = mkBill(ctx, acc, v, 'f1b', 100000);
  const bank = mkBank(ctx, acc);
  must(setCreditorBankProfile(ctx, { vendorId: v, iban: PLAIN_IBAN, idempotencyKey: 'p-f1b' }), 'profile');
  const created = must(createPaymentBatch(ctx, { bankAccountId: bank, itemIds: [bill], executionDate: '2026-07-20', idempotencyKey: 'b-f1b' }), 'batch');
  const batchId = created.batchId;
  const wsId = ctx.workspaceId;
  // Attempt to insert a SECOND item row for the same (workspace, batch, bill) directly, bypassing
  // the input guard entirely. The UNIQUE index must reject it.
  let threw = null;
  try {
    store.db.prepare(
      `INSERT INTO payment_batch_item (id, batch_id, workspace_id, vendor_bill_id, vendor_id, amount_minor, currency, creditor_iban, is_qr_iban, reference_kind, reference_value, posted_payment_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 'none', NULL, NULL, ?)`,
    ).run('pbitem_dup', batchId, wsId, bill, v, 100000, 'CHF', PLAIN_IBAN.replace(/\s+/g, ''), '2026-07-19');
  } catch (e) { threw = e; }
  assert.notEqual(threw, null, 'the UNIQUE index must reject a duplicate bill row');
  assert.match(String(threw.message), /UNIQUE|constraint/i, `expected a UNIQUE violation, got ${threw && threw.message}`);
});

// ---------------------------------------------------------------------------------------------
// F2: all four references are Max35Text under PRODUCTION ids. Validator asserts the ceiling.
// ---------------------------------------------------------------------------------------------
test('F2 all four references <=35 under systemIdGen; validator passes', () => {
  const { ctx, acc } = prodEnv();
  const v = mkVendor(ctx, 'f2');
  const bill = mkBill(ctx, acc, v, 'f2', 100000);
  const bank = mkBank(ctx, acc);
  must(setCreditorBankProfile(ctx, { vendorId: v, iban: PLAIN_IBAN, idempotencyKey: 'p-f2' }), 'profile');
  const created = must(createPaymentBatch(ctx, { bankAccountId: bank, itemIds: [bill], executionDate: '2026-07-20', idempotencyKey: 'b-f2' }), 'batch');
  const gen = must(generatePain001(ctx, { batchId: created.batchId, idempotencyKey: 'g-f2' }), 'generate');
  const xml = Buffer.from(gen.xmlBase64, 'base64').toString('utf8');
  const lens = {};
  for (const tag of ['MsgId', 'PmtInfId', 'InstrId', 'EndToEndId']) {
    const m = new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(xml);
    assert.notEqual(m, null, `missing ${tag}`);
    lens[tag] = m[1].length;
    assert.ok(m[1].length <= 35, `${tag} length ${m[1].length} > 35: ${m[1]}`);
  }
  // and the batch id itself must be a real uuid-bearing production id, not a short sequence id.
  assert.match(created.batchId, /pbatch_[0-9a-f]{8}-/, `expected production id, got ${created.batchId}`);
  console.log('F2 lengths under production ids:', JSON.stringify(lens), 'batchId=', created.batchId);
});

test('F2 validator REFUSES an over-length reference', () => {
  // Feed validatePain001 a hand-built file with a 46-char MsgId. It must be caught.
  const longMsg = 'PB-pbatch-643185b2-cdca-4c7a-8103-0932dce6cc6f'; // 46 chars
  assert.equal(longMsg.length, 46);
  const xml =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.001.001.09"><CstmrCdtTrfInitn>' +
    `<GrpHdr><MsgId>${longMsg}</MsgId><CreDtTm>2026-07-19T00:00:00.000Z</CreDtTm><NbOfTxs>1</NbOfTxs><CtrlSum>10.00</CtrlSum><InitgPty><Nm>X</Nm></InitgPty></GrpHdr>` +
    '<PmtInf><PmtInfId>P1</PmtInfId><PmtMtd>TRF</PmtMtd><BtchBookg>true</BtchBookg><NbOfTxs>1</NbOfTxs><CtrlSum>10.00</CtrlSum><ReqdExctnDt><Dt>2026-07-20</Dt></ReqdExctnDt><Dbtr><Nm>X</Nm></Dbtr>' +
    `<DbtrAcct><Id><IBAN>${PLAIN_IBAN.replace(/\s+/g, '')}</IBAN></Id></DbtrAcct><ChrgBr>SLEV</ChrgBr>` +
    `<CdtTrfTxInf><PmtId><InstrId>I1</InstrId><EndToEndId>E1</EndToEndId></PmtId><Amt><InstdAmt Ccy="CHF">10.00</InstdAmt></Amt><Cdtr><Nm>Y</Nm></Cdtr><CdtrAcct><Id><IBAN>${QR_IBAN.replace(/\s+/g, '')}</IBAN></Id></CdtrAcct></CdtTrfTxInf>` +
    '</PmtInf></CstmrCdtTrfInitn></Document>';
  const res = validatePain001(xml);
  assert.equal(res.ok, false, 'over-length MsgId must fail validation');
  const codes = res.errors.map((e) => e.code);
  assert.ok(codes.includes('reference_too_long'), `expected reference_too_long, got ${JSON.stringify(codes)}`);
});

// ---------------------------------------------------------------------------------------------
// F3: validator catches a B-level (PmtInf) total mismatch.
// ---------------------------------------------------------------------------------------------
test('F3 validator catches a B-level NbOfTxs/CtrlSum mismatch', () => {
  // A file whose GrpHdr totals are correct (1 tx, 10.00) but whose PmtInf totals lie (99, 9999.00).
  const xml =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.001.001.09"><CstmrCdtTrfInitn>' +
    '<GrpHdr><MsgId>M1</MsgId><CreDtTm>2026-07-19T00:00:00.000Z</CreDtTm><NbOfTxs>1</NbOfTxs><CtrlSum>10.00</CtrlSum><InitgPty><Nm>X</Nm></InitgPty></GrpHdr>' +
    '<PmtInf><PmtInfId>P1</PmtInfId><PmtMtd>TRF</PmtMtd><BtchBookg>true</BtchBookg><NbOfTxs>99</NbOfTxs><CtrlSum>9999.00</CtrlSum><ReqdExctnDt><Dt>2026-07-20</Dt></ReqdExctnDt><Dbtr><Nm>X</Nm></Dbtr>' +
    `<DbtrAcct><Id><IBAN>${PLAIN_IBAN.replace(/\s+/g, '')}</IBAN></Id></DbtrAcct><ChrgBr>SLEV</ChrgBr>` +
    `<CdtTrfTxInf><PmtId><InstrId>I1</InstrId><EndToEndId>E1</EndToEndId></PmtId><Amt><InstdAmt Ccy="CHF">10.00</InstdAmt></Amt><Cdtr><Nm>Y</Nm></Cdtr><CdtrAcct><Id><IBAN>${PLAIN_IBAN.replace(/\s+/g, '')}</IBAN></Id></CdtrAcct><RmtInf><Ustrd>x</Ustrd></RmtInf></CdtTrfTxInf>` +
    '</PmtInf></CstmrCdtTrfInitn></Document>';
  const res = validatePain001(xml);
  assert.equal(res.ok, false, 'B-level mismatch must fail');
  const codes = res.errors.map((e) => e.code);
  assert.ok(codes.includes('nb_of_txs_mismatch'), `expected nb_of_txs_mismatch, got ${JSON.stringify(codes)}`);
  assert.ok(codes.includes('ctrlsum_mismatch'), `expected ctrlsum_mismatch, got ${JSON.stringify(codes)}`);
});

// ---------------------------------------------------------------------------------------------
// F4: discard frees the bills; discarded status excluded by liveBatchFor.
// ---------------------------------------------------------------------------------------------
test('F4 discard a draft frees its bill and writes discarded (no row deleted)', () => {
  const { ctx, acc, store } = prodEnv();
  const v = mkVendor(ctx, 'f4');
  const bill = mkBill(ctx, acc, v, 'f4', 100000);
  const bank = mkBank(ctx, acc);
  must(setCreditorBankProfile(ctx, { vendorId: v, iban: PLAIN_IBAN, idempotencyKey: 'p-f4' }), 'profile');
  const created = must(createPaymentBatch(ctx, { bankAccountId: bank, itemIds: [bill], executionDate: '2026-07-20', idempotencyKey: 'b-f4' }), 'batch');
  // Bill is now locked.
  let payable = must(listPayableOpenItems(ctx, {}), 'list').items.find((i) => i.billId === bill);
  assert.equal(payable.alreadyBatchedInto, created.batchId, 'bill should be locked into the batch');
  const itemRowsBefore = store.db.prepare('SELECT COUNT(*) AS n FROM payment_batch_item WHERE workspace_id = ?').get(ctx.workspaceId).n;
  const disc = discardPaymentBatch(ctx, { batchId: created.batchId, idempotencyKey: 'd-f4' });
  assert.equal(disc.ok, true, `discard failed: ${JSON.stringify(disc)}`);
  assert.equal(disc.batch.status, 'discarded');
  // Bill freed.
  payable = must(listPayableOpenItems(ctx, {}), 'list2').items.find((i) => i.billId === bill);
  assert.equal(payable.alreadyBatchedInto, null, 'bill must be payable again after discard');
  // No row deleted (append-only): item rows unchanged.
  const itemRowsAfter = store.db.prepare('SELECT COUNT(*) AS n FROM payment_batch_item WHERE workspace_id = ?').get(ctx.workspaceId).n;
  assert.equal(itemRowsAfter, itemRowsBefore, 'discard must not delete item rows');
  // The freed bill can be re-batched.
  must(createPaymentBatch(ctx, { bankAccountId: bank, itemIds: [bill], executionDate: '2026-07-21', idempotencyKey: 'b-f4-2' }), 'rebatch');
});

test('F4 discard of a GENERATED batch needs confirmation', () => {
  const { ctx, acc } = prodEnv();
  const v = mkVendor(ctx, 'f4b');
  const bill = mkBill(ctx, acc, v, 'f4b', 100000);
  const bank = mkBank(ctx, acc);
  must(setCreditorBankProfile(ctx, { vendorId: v, iban: PLAIN_IBAN, idempotencyKey: 'p-f4b' }), 'profile');
  const created = must(createPaymentBatch(ctx, { bankAccountId: bank, itemIds: [bill], executionDate: '2026-07-20', idempotencyKey: 'b-f4b' }), 'batch');
  must(generatePain001(ctx, { batchId: created.batchId, idempotencyKey: 'g-f4b' }), 'gen');
  const noConfirm = discardPaymentBatch(ctx, { batchId: created.batchId, idempotencyKey: 'd-f4b' });
  assert.equal(noConfirm.ok, false, 'generated discard without confirmation must be refused');
  assert.equal(noConfirm.error, 'confirmation_required');
  const withConfirm = must(discardPaymentBatch(ctx, { batchId: created.batchId, confirmation: true, idempotencyKey: 'd-f4b2' }), 'discard');
  assert.equal(withConfirm.batch.status, 'discarded');
});

test('F4 a PAID batch cannot be discarded', () => {
  const { ctx, acc } = prodEnv();
  const v = mkVendor(ctx, 'f4c');
  const bill = mkBill(ctx, acc, v, 'f4c', 100000);
  const bank = mkBank(ctx, acc);
  must(setCreditorBankProfile(ctx, { vendorId: v, iban: PLAIN_IBAN, idempotencyKey: 'p-f4c' }), 'profile');
  const created = must(createPaymentBatch(ctx, { bankAccountId: bank, itemIds: [bill], executionDate: '2026-07-20', idempotencyKey: 'b-f4c' }), 'batch');
  must(generatePain001(ctx, { batchId: created.batchId, idempotencyKey: 'g-f4c' }), 'gen');
  must(markBatchPaid(ctx, { batchId: created.batchId, confirmation: true, valueDate: '2026-07-21', idempotencyKey: 'm-f4c' }), 'paid');
  const disc = discardPaymentBatch(ctx, { batchId: created.batchId, confirmation: true, idempotencyKey: 'd-f4c' });
  assert.equal(disc.ok, false);
  assert.equal(disc.error, 'already_paid');
});

// ---------------------------------------------------------------------------------------------
// F5: generate on a paid batch is refused.
// ---------------------------------------------------------------------------------------------
test('F5 generate_pain001 refuses a paid batch (already_paid)', () => {
  const { ctx, acc } = prodEnv();
  const v = mkVendor(ctx, 'f5');
  const bill = mkBill(ctx, acc, v, 'f5', 100000);
  const bank = mkBank(ctx, acc);
  must(setCreditorBankProfile(ctx, { vendorId: v, iban: PLAIN_IBAN, idempotencyKey: 'p-f5' }), 'profile');
  const created = must(createPaymentBatch(ctx, { bankAccountId: bank, itemIds: [bill], executionDate: '2026-07-20', idempotencyKey: 'b-f5' }), 'batch');
  must(generatePain001(ctx, { batchId: created.batchId, idempotencyKey: 'g-f5' }), 'gen');
  must(markBatchPaid(ctx, { batchId: created.batchId, confirmation: true, valueDate: '2026-07-21', idempotencyKey: 'm-f5' }), 'paid');
  const regen = generatePain001(ctx, { batchId: created.batchId, idempotencyKey: 'g-f5-2' });
  assert.equal(regen.ok, false, 'regenerating a paid batch must be refused');
  assert.equal(regen.error, 'already_paid');
});

// ---------------------------------------------------------------------------------------------
// F6: regeneration is byte-identical under a MOVING clock.
// ---------------------------------------------------------------------------------------------
test('F6 regeneration byte-identical under a moving clock', () => {
  const { ctx, acc, setNow } = prodEnv();
  const v = mkVendor(ctx, 'f6');
  const bill = mkBill(ctx, acc, v, 'f6', 100000);
  const bank = mkBank(ctx, acc);
  must(setCreditorBankProfile(ctx, { vendorId: v, iban: PLAIN_IBAN, idempotencyKey: 'p-f6' }), 'profile');
  const created = must(createPaymentBatch(ctx, { bankAccountId: bank, itemIds: [bill], executionDate: '2026-07-20', idempotencyKey: 'b-f6' }), 'batch');
  const gen1 = must(generatePain001(ctx, { batchId: created.batchId, idempotencyKey: 'g-f6-1' }), 'gen1');
  // Advance the clock by more than a day, then regenerate with a FRESH idempotency key.
  setNow('2026-07-25T09:31:00.000Z');
  const gen2 = must(generatePain001(ctx, { batchId: created.batchId, idempotencyKey: 'g-f6-2' }), 'gen2');
  const xml1 = Buffer.from(gen1.xmlBase64, 'base64').toString('utf8');
  const xml2 = Buffer.from(gen2.xmlBase64, 'base64').toString('utf8');
  assert.equal(xml1, xml2, 'regeneration must be byte-identical under a moving clock');
  assert.ok(xml1.includes('<CreDtTm>2026-07-19T00:00:00.000Z</CreDtTm>'), 'CreDtTm must be the creation timestamp');
});

// ---------------------------------------------------------------------------------------------
// F7: full creditor IBAN exposed for review.
// ---------------------------------------------------------------------------------------------
test('F7 get_payment_batch and list_payable expose the full creditor IBAN', () => {
  const { ctx, acc } = prodEnv();
  const v = mkVendor(ctx, 'f7');
  const bill = mkBill(ctx, acc, v, 'f7', 100000);
  const bank = mkBank(ctx, acc);
  const cred = 'CH93 0076 2011 6238 5295 7';
  must(setCreditorBankProfile(ctx, { vendorId: v, iban: cred, idempotencyKey: 'p-f7' }), 'profile');
  const created = must(createPaymentBatch(ctx, { bankAccountId: bank, itemIds: [bill], executionDate: '2026-07-20', idempotencyKey: 'b-f7' }), 'batch');
  const got = must(getPaymentBatch(ctx, { batchId: created.batchId }), 'get');
  const item = got.batch.items[0];
  assert.equal(item.creditorIban, cred.replace(/\s+/g, ''), `full IBAN expected, got ${item.creditorIban}`);
  const payable = must(listPayableOpenItems(ctx, {}), 'list').items.find((i) => i.billId === bill);
  assert.equal(payable.creditorIban, cred.replace(/\s+/g, ''), 'list_payable must expose full IBAN');
});

// ---------------------------------------------------------------------------------------------
// Money-path: idempotency proven on ROWS, no double-count; §H-TENANT on discard.
// ---------------------------------------------------------------------------------------------
test('markBatchPaid is idempotent on ROWS (no double journal entries)', () => {
  const { ctx, acc, store } = prodEnv();
  const v = mkVendor(ctx, 'mp');
  const bill = mkBill(ctx, acc, v, 'mp', 100000);
  const bank = mkBank(ctx, acc);
  must(setCreditorBankProfile(ctx, { vendorId: v, iban: PLAIN_IBAN, idempotencyKey: 'p-mp' }), 'profile');
  const created = must(createPaymentBatch(ctx, { bankAccountId: bank, itemIds: [bill], executionDate: '2026-07-20', idempotencyKey: 'b-mp' }), 'batch');
  must(generatePain001(ctx, { batchId: created.batchId, idempotencyKey: 'g-mp' }), 'gen');
  const entriesBefore = store.db.prepare('SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ?').get(ctx.workspaceId).n;
  must(markBatchPaid(ctx, { batchId: created.batchId, confirmation: true, valueDate: '2026-07-21', idempotencyKey: 'm-mp' }), 'paid1');
  const entriesMid = store.db.prepare('SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ?').get(ctx.workspaceId).n;
  // Replay under the SAME key.
  must(markBatchPaid(ctx, { batchId: created.batchId, confirmation: true, valueDate: '2026-07-21', idempotencyKey: 'm-mp' }), 'paid2');
  const entriesAfter = store.db.prepare('SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ?').get(ctx.workspaceId).n;
  assert.equal(entriesMid - entriesBefore, 1, 'exactly one payment entry posted');
  assert.equal(entriesAfter, entriesMid, 'replay must post NO further entry');
});

test('discard_payment_batch is §H-TENANT scoped', async () => {
  const { ctx, acc, store } = prodEnv();
  const v = mkVendor(ctx, 'ten');
  const bill = mkBill(ctx, acc, v, 'ten', 100000);
  const bank = mkBank(ctx, acc);
  must(setCreditorBankProfile(ctx, { vendorId: v, iban: PLAIN_IBAN, idempotencyKey: 'p-ten' }), 'profile');
  const created = must(createPaymentBatch(ctx, { bankAccountId: bank, itemIds: [bill], executionDate: '2026-07-20', idempotencyKey: 'b-ten' }), 'batch');
  // A second workspace ctx in the SAME store, production ids.
  const { createWorkspace } = await import('../../dist/core/setup/index.js');
  const otherWs = createWorkspace({ store, clock: { now: () => '2026-07-19T00:00:00.000Z' }, ids: systemIdGen }, { name: 'Nachbar AG' }).workspaceId;
  const otherCtx = makeContext(store, { workspaceId: otherWs, actor: 'user_2', clock: { now: () => '2026-07-19T00:00:00.000Z' }, ids: systemIdGen });
  const cross = discardPaymentBatch(otherCtx, { batchId: created.batchId, idempotencyKey: 'd-ten' });
  assert.equal(cross.ok, false, 'a cross-tenant discard must not find the batch');
  assert.equal(cross.error, 'not_found');
  // The batch is untouched in the owning tenant.
  const still = must(getPaymentBatch(ctx, { batchId: created.batchId }), 'get').batch;
  assert.equal(still.status, 'draft', 'the cross-tenant call must not have changed the batch');
});

// Multi-item batch under production ids: distinct references, correct A- and B-level totals, real
// QR-IBAN routing shape, validator passes the produced file.
test('multi-item QR-IBAN batch: distinct refs, correct totals, valid file (production ids)', () => {
  const { ctx, acc } = prodEnv();
  const QRR = '210000000003139471430009017';
  const vQr = mkVendor(ctx, 'mqr');
  const bQr = mkBill(ctx, acc, vQr, 'mqr', 10000, { vendorReference: QRR });
  must(setCreditorBankProfile(ctx, { vendorId: vQr, iban: QR_IBAN, idempotencyKey: 'p-mqr' }), 'cbp');
  const vFt = mkVendor(ctx, 'mft');
  const bFt = mkBill(ctx, acc, vFt, 'mft', 30000, { vendorReference: 'Rechnung 42' });
  must(setCreditorBankProfile(ctx, { vendorId: vFt, iban: PLAIN_IBAN, idempotencyKey: 'p-mft' }), 'cbp');
  const bank = mkBank(ctx, acc);
  const created = must(createPaymentBatch(ctx, { bankAccountId: bank, itemIds: [bQr, bFt], executionDate: '2026-07-20', idempotencyKey: 'b-multi' }), 'batch');
  const gen = must(generatePain001(ctx, { batchId: created.batchId, idempotencyKey: 'g-multi' }), 'gen');
  const xml = Buffer.from(gen.xmlBase64, 'base64').toString('utf8');
  // Distinct InstrId and EndToEndId per tx.
  const instrIds = [...xml.matchAll(/<InstrId>([^<]*)<\/InstrId>/g)].map((m) => m[1]);
  const e2eIds = [...xml.matchAll(/<EndToEndId>([^<]*)<\/EndToEndId>/g)].map((m) => m[1]);
  assert.equal(instrIds.length, 2);
  assert.equal(new Set(instrIds).size, 2, `InstrId collision: ${instrIds}`);
  assert.equal(new Set(e2eIds).size, 2, `EndToEndId collision: ${e2eIds}`);
  assert.equal(new Set([...instrIds, ...e2eIds]).size, 4, 'InstrId and EndToEndId must all be distinct');
  // Totals correct at BOTH A and B level (2 tx, 400.00).
  const nb = [...xml.matchAll(/<NbOfTxs>(\d+)<\/NbOfTxs>/g)].map((m) => m[1]);
  const cs = [...xml.matchAll(/<CtrlSum>([\d.]+)<\/CtrlSum>/g)].map((m) => m[1]);
  assert.deepEqual(nb, ['2', '2'], `NbOfTxs A/B: ${nb}`);
  assert.deepEqual(cs, ['400.00', '400.00'], `CtrlSum A/B: ${cs}`);
  // QR-IBAN tx carries QRR, plain-IBAN tx carries Ustrd; validator passes the real file.
  assert.ok(xml.includes('<Prtry>QRR</Prtry>'), 'QR-IBAN tx must carry QRR');
  assert.ok(xml.includes('<Ustrd>Rechnung 42</Ustrd>'), 'plain-IBAN tx must carry Ustrd');
  assert.equal(gen.valid, true);
  assert.equal(validatePain001(xml).ok, true, 'validator must pass the produced multi-item file');
});

// compactReference unit: production uuid ids compress under 35.
test('compactReference keeps production uuid ids <=35', () => {
  const id = 'pbatch_643185b2-cdca-4c7a-8103-0932dce6cc6f';
  for (const tag of ['M', 'P', 'I', 'E']) {
    const r = compactReference(tag, id);
    assert.ok(r.length <= 35, `${tag}: ${r} len ${r.length}`);
    assert.match(r, /^[A-Za-z0-9 '()+,\-./:?]+$/, `charset violation: ${r}`);
  }
});
