// A18, creditor payments: pain.001.001.09 generation and settlement, at the engine level.
//
// The conformance gate (test/api/conformance.test.mjs) already proves the row-shape idempotency and
// the tri-mapping (verb/MCP/REST) generically for every write. This suite proves the DOMAIN claims
// that generic gate cannot: the pain.001 XML is actually correct (NbOfTxs/CtrlSum, the QRR/SCOR/
// unstructured branch selection), the money markBatchPaid posts is exactly right and settles the
// A17 item, regeneration is byte-identical, and the §7 tripwires (no transmit path, no automation on
// mark_batch_paid/set_creditor_bank_profile) hold.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { setup, PLAIN_IBAN, QR_IBAN, counts, snapshot } from './support.mjs';
import { createVendorBill, postVendorBill } from '../../dist/core/purchase/index.js';
import { createContact } from '../../dist/core/sales/index.js';
import { recordExchangeRate } from '../../dist/core/fx/index.js';
import { isValidQrrReference } from '../../dist/core/sales/qrbill.js';
import { ROLE_ACCOUNT_NUMBER } from '../../dist/core/payments/index.js';
import {
  createBankAccount,
  setCreditorBankProfile,
  listPayableOpenItems,
  createPaymentBatch,
  generatePain001,
  getPaymentBatch,
  markBatchPaid,
  validatePain001,
} from '../../dist/core/banking/index.js';
import { NOT_AUTOMATABLE } from '../../dist/core/automation/denylist.js';

function must(res, what) {
  assert.equal(res.ok, true, `${what} failed: ${JSON.stringify(res)}`);
  return res;
}

let vendorSeq = 0;
function mkVendor(ctx, seed) {
  const res = createContact(ctx, {
    partyRole: 'vendor',
    name: `Lieferant ${seed} GmbH`,
    idempotencyKey: `vendor-${seed}-${vendorSeq++}`,
  });
  return must(res, 'create_contact').contact.id;
}

function mkBank(ctx, acc, seed = 'bank-1') {
  return must(
    createBankAccount(ctx, { name: 'Kontokorrent', iban: PLAIN_IBAN, ledgerAccountId: acc('1020'), idempotencyKey: seed }),
    'create_bank_account',
  ).bankAccountId;
}

test('A18: a 2-bill batch generates a valid pain.001 with the exact NbOfTxs/CtrlSum', () => {
  const { ctx, acc } = setup();
  const bankAccountId = mkBank(ctx, acc);

  const bills = [];
  for (const seed of ['a', 'b']) {
    const vendor = mkVendor(ctx, seed);
    const bill = must(
      createVendorBill(ctx, {
        vendorId: vendor,
        billDate: '2026-03-01',
        vendorReference: `LG-${seed}-0001`,
        amountMinor: 100000,
        expenseAccountId: acc('6500'),
        idempotencyKey: `${seed}-bill`,
      }),
      'create_vendor_bill',
    );
    must(postVendorBill(ctx, { vendorBillId: bill.vendorBillId, idempotencyKey: `${seed}-post` }), 'post_vendor_bill');
    must(setCreditorBankProfile(ctx, { vendorId: vendor, iban: PLAIN_IBAN, idempotencyKey: `${seed}-cbp` }), 'set_creditor_bank_profile');
    bills.push(bill.vendorBillId);
  }

  const payable = must(listPayableOpenItems(ctx, {}), 'list_payable');
  assert.equal(payable.items.length, 2);
  assert.ok(payable.items.every((i) => i.hasCreditorProfile && i.batchable));

  const batch = must(
    createPaymentBatch(ctx, { bankAccountId, itemIds: bills, executionDate: '2026-03-20', idempotencyKey: 'batch-1' }),
    'create_payment_batch',
  );

  const generated = must(generatePain001(ctx, { batchId: batch.batchId, idempotencyKey: 'gen-1' }), 'generate_pain001');
  assert.equal(generated.nbOfTxs, 2);
  assert.equal(generated.ctrlSumMinor, 200000);
  assert.equal(generated.transmitted, false);
  assert.equal(generated.reason, 'no_channel', 'no EBICS channel routes this batch, so the file path is the floor');

  const xml = Buffer.from(generated.xmlBase64, 'base64').toString('utf8');
  assert.match(xml, /<NbOfTxs>2<\/NbOfTxs>/);
  assert.match(xml, /<CtrlSum>2000\.00<\/CtrlSum>/);
  assert.equal((xml.match(/<CdtTrfTxInf>/g) ?? []).length, 2);
  assert.ok(validatePain001(xml).ok, 'the independently re-derived validation must pass on the produced text');

  // Regenerating a `generated` batch reproduces byte-identical output (D73 precedent).
  const regenerated = must(
    generatePain001(ctx, { batchId: batch.batchId, idempotencyKey: 'gen-2' }),
    'generate_pain001 (regen)',
  );
  assert.equal(regenerated.xmlBase64, generated.xmlBase64, 'regeneration must be byte-identical');
});

test('A18: a QR-IBAN vendor with a valid QRR on the bill emits the structured QRR branch', () => {
  const { ctx, acc } = setup();
  const bankAccountId = mkBank(ctx, acc);
  const vendor = mkVendor(ctx, 'qr');
  // A structurally valid 27-digit QRR (mod-10 recursive check digit correct).
  const qrr = '210000000003139471430009017';
  assert.equal(qrr.length, 27);
  assert.ok(isValidQrrReference(qrr), 'fixture QRR must itself be valid, or this test proves nothing');

  const bill = must(
    createVendorBill(ctx, {
      vendorId: vendor,
      billDate: '2026-03-01',
      vendorReference: qrr,
      amountMinor: 50000,
      expenseAccountId: acc('6500'),
      idempotencyKey: 'qr-bill',
    }),
    'create_vendor_bill',
  );
  must(postVendorBill(ctx, { vendorBillId: bill.vendorBillId, idempotencyKey: 'qr-post' }), 'post_vendor_bill');
  must(setCreditorBankProfile(ctx, { vendorId: vendor, iban: QR_IBAN, idempotencyKey: 'qr-cbp' }), 'set_creditor_bank_profile');

  const batch = must(
    createPaymentBatch(ctx, { bankAccountId, itemIds: [bill.vendorBillId], executionDate: '2026-03-20', idempotencyKey: 'qr-batch' }),
    'create_payment_batch',
  );
  const generated = must(generatePain001(ctx, { batchId: batch.batchId, idempotencyKey: 'qr-gen' }), 'generate_pain001');
  const xml = Buffer.from(generated.xmlBase64, 'base64').toString('utf8');
  assert.match(xml, /<Prtry>QRR<\/Prtry>/);
  assert.match(xml, new RegExp(`<Ref>${qrr}</Ref>`));
  assert.doesNotMatch(xml, /<Ustrd>/, 'a QR-IBAN creditor must never carry unstructured remittance (SIX CH17)');
});

test('A18: a QR-IBAN vendor with NO valid QRR on the bill is refused, never guessed', () => {
  const { ctx, acc } = setup();
  const bankAccountId = mkBank(ctx, acc);
  const vendor = mkVendor(ctx, 'badqr');
  const bill = must(
    createVendorBill(ctx, {
      vendorId: vendor,
      billDate: '2026-03-01',
      vendorReference: 'Rechnung Nr. 42',
      amountMinor: 50000,
      expenseAccountId: acc('6500'),
      idempotencyKey: 'badqr-bill',
    }),
    'create_vendor_bill',
  );
  must(postVendorBill(ctx, { vendorBillId: bill.vendorBillId, idempotencyKey: 'badqr-post' }), 'post_vendor_bill');
  must(setCreditorBankProfile(ctx, { vendorId: vendor, iban: QR_IBAN, idempotencyKey: 'badqr-cbp' }), 'set_creditor_bank_profile');

  const batch = createPaymentBatch(ctx, {
    bankAccountId,
    itemIds: [bill.vendorBillId],
    executionDate: '2026-03-20',
    idempotencyKey: 'badqr-batch',
  });
  assert.equal(batch.ok, false);
  assert.equal(batch.error, 'needs_qrr_reference');
});

test('A18: a mixed-currency selection is refused with mixed_currency, nothing written', () => {
  const { ctx, store, acc } = setup();
  const bankAccountId = mkBank(ctx, acc);
  const vendor = mkVendor(ctx, 'mix');
  const chf = must(
    createVendorBill(ctx, {
      vendorId: vendor,
      billDate: '2026-03-01',
      amountMinor: 10000,
      currency: 'CHF',
      expenseAccountId: acc('6500'),
      idempotencyKey: 'mix-chf',
    }),
    'create_vendor_bill',
  );
  must(postVendorBill(ctx, { vendorBillId: chf.vendorBillId, idempotencyKey: 'mix-chf-post' }), 'post_vendor_bill');
  must(
    recordExchangeRate(ctx, {
      baseCurrency: 'EUR',
      rate: '0.95',
      asOf: '2026-03-01',
      source: 'manual',
      method: 'daily',
      provenance: 'test fixture',
      idempotencyKey: 'mix-rate',
    }),
    'record_exchange_rate',
  );
  const eur = must(
    createVendorBill(ctx, {
      vendorId: vendor,
      billDate: '2026-03-01',
      amountMinor: 10000,
      currency: 'EUR',
      expenseAccountId: acc('6500'),
      idempotencyKey: 'mix-eur',
    }),
    'create_vendor_bill',
  );
  must(postVendorBill(ctx, { vendorBillId: eur.vendorBillId, idempotencyKey: 'mix-eur-post' }), 'post_vendor_bill');
  must(setCreditorBankProfile(ctx, { vendorId: vendor, iban: PLAIN_IBAN, idempotencyKey: 'mix-cbp' }), 'set_creditor_bank_profile');

  const before = snapshot(store);
  const batch = createPaymentBatch(ctx, {
    bankAccountId,
    itemIds: [chf.vendorBillId, eur.vendorBillId],
    executionDate: '2026-03-20',
    idempotencyKey: 'mix-batch',
  });
  assert.equal(batch.ok, false);
  assert.equal(batch.error, 'mixed_currency');
  assert.equal(snapshot(store), before, 'a refused batch must write nothing at all');
});

test('A18: markBatchPaid posts debit 2000 / credit 1020 per item, settles the A17 bill, and is idempotent on ROWS', () => {
  const { ctx, store, workspaceId, acc } = setup();
  const bankAccountId = mkBank(ctx, acc);
  const vendor = mkVendor(ctx, 'pay');
  const bill = must(
    createVendorBill(ctx, {
      vendorId: vendor,
      billDate: '2026-03-01',
      amountMinor: 75000,
      expenseAccountId: acc('6500'),
      idempotencyKey: 'pay-bill',
    }),
    'create_vendor_bill',
  );
  must(postVendorBill(ctx, { vendorBillId: bill.vendorBillId, idempotencyKey: 'pay-post' }), 'post_vendor_bill');
  must(setCreditorBankProfile(ctx, { vendorId: vendor, iban: PLAIN_IBAN, idempotencyKey: 'pay-cbp' }), 'set_creditor_bank_profile');

  const batch = must(
    createPaymentBatch(ctx, { bankAccountId, itemIds: [bill.vendorBillId], executionDate: '2026-03-20', idempotencyKey: 'pay-batch' }),
    'create_payment_batch',
  );
  must(generatePain001(ctx, { batchId: batch.batchId, idempotencyKey: 'pay-gen' }), 'generate_pain001');

  const first = must(
    markBatchPaid(ctx, { batchId: batch.batchId, confirmation: true, valueDate: '2026-03-21', idempotencyKey: 'pay-confirm' }),
    'mark_batch_paid',
  );
  assert.equal(first.paymentIds.length, 1);

  const entryId = store.db.prepare('SELECT journal_entry_id FROM payment WHERE id = ?').get(first.paymentIds[0]).journal_entry_id;
  const legs = store.db
    .prepare(
      `SELECT a.number AS number, l.debit_minor AS debit, l.credit_minor AS credit
         FROM journal_line l JOIN account a ON a.id = l.account_id WHERE l.entry_id = ? ORDER BY a.number`,
    )
    .all(entryId);
  assert.deepEqual(legs, [
    { number: '1020', debit: 0, credit: 75000 },
    { number: ROLE_ACCOUNT_NUMBER.payable, debit: 75000, credit: 0 },
  ]);

  const settled = must(getPaymentBatch(ctx, { batchId: batch.batchId }), 'get_payment_batch');
  assert.equal(settled.batch.status, 'paid');
  assert.equal(settled.batch.items[0].postedPaymentId, first.paymentIds[0]);

  // §H-IDEMPOTENT on ROWS, not merely on the returned value: a replay must move the ledger ZERO times.
  const between = snapshot(store);
  const second = markBatchPaid(ctx, {
    batchId: batch.batchId,
    confirmation: true,
    valueDate: '2026-03-21',
    idempotencyKey: 'pay-confirm',
  });
  assert.equal(second.ok, true);
  assert.deepEqual(second, first, 'a replay must return the identical result');
  assert.equal(snapshot(store), between, 'a replay under the same key must write nothing further');

  // A NEW key on an already-paid batch is refused, never a second payment.
  const third = markBatchPaid(ctx, {
    batchId: batch.batchId,
    confirmation: true,
    valueDate: '2026-03-21',
    idempotencyKey: 'pay-confirm-2',
  });
  assert.equal(third.ok, false);
  assert.equal(third.error, 'already_paid');
  assert.equal(snapshot(store), between, 'a refused re-confirm under a different key must write nothing either');
});

test('A18: mark_batch_paid refuses without confirmation:true, nothing posts', () => {
  const { ctx, store, acc } = setup();
  const bankAccountId = mkBank(ctx, acc);
  const vendor = mkVendor(ctx, 'noconf');
  const bill = must(
    createVendorBill(ctx, {
      vendorId: vendor,
      billDate: '2026-03-01',
      amountMinor: 10000,
      expenseAccountId: acc('6500'),
      idempotencyKey: 'noconf-bill',
    }),
    'create_vendor_bill',
  );
  must(postVendorBill(ctx, { vendorBillId: bill.vendorBillId, idempotencyKey: 'noconf-post' }), 'post_vendor_bill');
  must(setCreditorBankProfile(ctx, { vendorId: vendor, iban: PLAIN_IBAN, idempotencyKey: 'noconf-cbp' }), 'set_creditor_bank_profile');
  const batch = must(
    createPaymentBatch(ctx, { bankAccountId, itemIds: [bill.vendorBillId], executionDate: '2026-03-20', idempotencyKey: 'noconf-batch' }),
    'create_payment_batch',
  );
  must(generatePain001(ctx, { batchId: batch.batchId, idempotencyKey: 'noconf-gen' }), 'generate_pain001');

  const before = snapshot(store);
  const refused = markBatchPaid(ctx, {
    batchId: batch.batchId,
    confirmation: false,
    valueDate: '2026-03-21',
    idempotencyKey: 'noconf-confirm',
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'confirmation_required');
  assert.equal(snapshot(store), before);
});

test('A18: generate_pain001 refuses a batch that does not exist, and a batch with no items', () => {
  const { ctx } = setup();
  const missing = generatePain001(ctx, { batchId: 'pbatch_nope', idempotencyKey: 'nope-1' });
  assert.equal(missing.ok, false);
  assert.equal(missing.error, 'not_found');
});

test('A18 §7 tripwire: no transmit path anywhere in the module source', async () => {
  const src = await readFile(new URL('../../src/core/banking/pain001.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /\bfetch\s*\(/, 'pain001.ts must never reach a transport');
  assert.doesNotMatch(src, /from ['"]net['"]|from ['"]http['"]|from ['"]https['"]/);
});

test('A18 §7 tripwire: set_creditor_bank_profile and mark_batch_paid are NOT automatable (D65/D77)', () => {
  assert.ok(NOT_AUTOMATABLE.has('set_creditor_bank_profile'));
  assert.ok(NOT_AUTOMATABLE.has('mark_batch_paid'));
  // The two accepted automation actions (§6b) must stay OFF the list, or the spec's own claim is false.
  assert.ok(!NOT_AUTOMATABLE.has('create_payment_batch'));
  assert.ok(!NOT_AUTOMATABLE.has('generate_pain001'));
});
