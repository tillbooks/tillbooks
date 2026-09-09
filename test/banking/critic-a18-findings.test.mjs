// A18 CRITIC PROBES (independent, non-author). Each test here is an ATTACK on the A18 landing,
// written to refute a claim rather than to confirm one. Where a probe FAILS, it names a defect that
// the branch's own suite does not reach; where it passes, it pins a claim the suite left implicit.
//
// The single most important structural point: `test/banking/support.mjs` runs every A18 test with
// `sequenceIdGen()`, so every id is `pbatch_1`/`pbitem_3`. PRODUCTION runs `systemIdGen`, which
// mints `pbatch_<uuid>`. Four pain.001 reference elements are derived from those ids, and all four
// are `Max35Text` in the ISO 20022 schema. The suite therefore cannot see the length defect at all.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { setup, PLAIN_IBAN, QR_IBAN, IID_BOUNDARY, snapshot } from './support.mjs';
import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { makeContext } from '../../dist/core/context.js';
import { fixedClock } from '../../dist/core/clock.js';
import { systemIdGen, sequenceIdGen } from '../../dist/core/ids.js';
import { createWorkspace } from '../../dist/core/setup/index.js';
import { createVendorBill, postVendorBill, getVendorBill } from '../../dist/core/purchase/index.js';
import { createContact } from '../../dist/core/sales/index.js';
import { recordExchangeRate } from '../../dist/core/fx/index.js';
import { recordPayment, PAYMENT_INTENTS } from '../../dist/core/payments/index.js';
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

function must(res, what) {
  assert.equal(res.ok, true, `${what} failed: ${JSON.stringify(res)}`);
  return res;
}

let seq = 0;
function mkVendor(ctx, seed) {
  return must(
    createContact(ctx, { partyRole: 'vendor', name: `Lieferant ${seed}`, idempotencyKey: `v-${seed}-${seq++}` }),
    'create_contact',
  ).contact.id;
}

function mkBill(ctx, acc, vendor, seed, amountMinor, extra = {}) {
  const bill = must(
    createVendorBill(ctx, {
      vendorId: vendor,
      billDate: '2026-03-01',
      amountMinor,
      expenseAccountId: acc('6500'),
      idempotencyKey: `bill-${seed}`,
      ...extra,
    }),
    'create_vendor_bill',
  );
  must(postVendorBill(ctx, { vendorBillId: bill.vendorBillId, idempotencyKey: `post-${seed}` }), 'post_vendor_bill');
  return bill.vendorBillId;
}

function mkBank(ctx, acc, seed = 'bank-1') {
  return must(
    createBankAccount(ctx, { name: 'Kontokorrent', iban: PLAIN_IBAN, ledgerAccountId: acc('1020'), idempotencyKey: seed }),
    'create_bank_account',
  ).bankAccountId;
}

function xmlOf(generated) {
  return Buffer.from(generated.xmlBase64, 'base64').toString('utf8');
}

// ---------------------------------------------------------------------------------------------
// PROBE 1. Max35Text on the four SPS reference elements, under PRODUCTION ids.
// ---------------------------------------------------------------------------------------------

test('CRITIC A18-1: MsgId/PmtInfId/InstrId/EndToEndId must fit Max35Text with production ids', () => {
  const clock = fixedClock('2026-07-19T00:00:00.000Z');
  const ids = systemIdGen; // <-- the ONLY difference from support.mjs's setup()
  const store = new SqliteStore({ clock });
  const workspaceId = createWorkspace({ store, clock, ids }, { name: 'Muster Grafik GmbH' }).workspaceId;
  const ctx = makeContext(store, { workspaceId, actor: 'user_1', clock, ids });
  const acc = (number) =>
    store.db.prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?').get(workspaceId, number).id;

  const bankAccountId = mkBank(ctx, acc);
  const vendor = mkVendor(ctx, 'p1');
  const bill = mkBill(ctx, acc, vendor, 'p1', 100000);
  must(setCreditorBankProfile(ctx, { vendorId: vendor, iban: PLAIN_IBAN, idempotencyKey: 'p1-cbp' }), 'set_creditor_bank_profile');

  const batch = must(
    createPaymentBatch(ctx, { bankAccountId, itemIds: [bill], executionDate: '2026-03-20', idempotencyKey: 'p1-batch' }),
    'create_payment_batch',
  );
  const generated = must(generatePain001(ctx, { batchId: batch.batchId, idempotencyKey: 'p1-gen' }), 'generate_pain001');
  const xml = xmlOf(generated);

  const grab = (tag) => {
    const m = new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(xml);
    return m === null ? null : m[1];
  };
  const offenders = [];
  for (const tag of ['MsgId', 'PmtInfId', 'InstrId', 'EndToEndId']) {
    const value = grab(tag);
    assert.notEqual(value, null, `${tag} must be present`);
    if (value.length > 35) offenders.push(`${tag}=${value} (${value.length} chars)`);
  }
  assert.deepEqual(
    offenders,
    [],
    'ISO 20022 pain.001.001.09 types all four of these as Max35Text; SIX IG 2025 §3.2 restricts their charset ' +
      'but the length ceiling is the schema\'s. Anything longer is rejected by the bank as a schema error, ' +
      'and the whole file (every payment in it) fails to execute.',
  );
});

// ---------------------------------------------------------------------------------------------
// PROBE 2. The same bill selected TWICE in one batch: does the file pay the vendor twice?
// ---------------------------------------------------------------------------------------------

test('CRITIC A18-2: the same bill twice in one selection must not become two payment instructions', () => {
  const { ctx, acc } = setup();
  const bankAccountId = mkBank(ctx, acc);
  const vendor = mkVendor(ctx, 'p2');
  const bill = mkBill(ctx, acc, vendor, 'p2', 100000);
  must(setCreditorBankProfile(ctx, { vendorId: vendor, iban: PLAIN_IBAN, idempotencyKey: 'p2-cbp' }), 'set_creditor_bank_profile');

  const batch = createPaymentBatch(ctx, {
    bankAccountId,
    itemIds: [bill, bill], // the SAME bill id, twice
    executionDate: '2026-03-20',
    idempotencyKey: 'p2-batch',
  });

  if (batch.ok === false) {
    // Acceptable outcome: refused at the door.
    assert.ok(
      ['duplicate_item', 'already_batched', 'invalid_input'].includes(batch.error),
      `a duplicate selection should be refused with a duplicate-shaped error, got ${JSON.stringify(batch)}`,
    );
    return;
  }

  const generated = must(generatePain001(ctx, { batchId: batch.batchId, idempotencyKey: 'p2-gen' }), 'generate_pain001');
  const xml = xmlOf(generated);
  const txCount = (xml.match(/<CdtTrfTxInf>/g) ?? []).length;
  assert.equal(
    txCount,
    1,
    'THE FILE THE BANK EXECUTES CARRIES ' +
      txCount +
      ' INSTRUCTIONS FOR ONE BILL. The bank pays this vendor ' +
      txCount +
      'x. Nothing downstream can reverse a transfer that already left the account: ' +
      `CtrlSum=${generated.ctrlSumMinor} against an open bill of 100000.`,
  );
});

test('CRITIC A18-2b: and the ledger side of that same duplicate cannot be booked at all', () => {
  const { ctx, store, acc } = setup();
  const bankAccountId = mkBank(ctx, acc);
  const vendor = mkVendor(ctx, 'p2b');
  const bill = mkBill(ctx, acc, vendor, 'p2b', 100000);
  must(setCreditorBankProfile(ctx, { vendorId: vendor, iban: PLAIN_IBAN, idempotencyKey: 'p2b-cbp' }), 'set_creditor_bank_profile');

  const batch = createPaymentBatch(ctx, {
    bankAccountId,
    itemIds: [bill, bill],
    executionDate: '2026-03-20',
    idempotencyKey: 'p2b-batch',
  });
  if (batch.ok === false) return; // covered by A18-2
  must(generatePain001(ctx, { batchId: batch.batchId, idempotencyKey: 'p2b-gen' }), 'generate_pain001');

  const before = snapshot(store);
  const paid = markBatchPaid(ctx, {
    batchId: batch.batchId,
    confirmation: true,
    valueDate: '2026-03-21',
    idempotencyKey: 'p2b-confirm',
  });
  // Whatever happens, record it: either the ledger double-books (worse) or the batch is unbookable
  // forever after the money has already left (bad, and there is no discard verb to escape it).
  assert.equal(
    paid.ok,
    true,
    'markBatchPaid on the duplicate batch is REFUSED (' +
      JSON.stringify(paid) +
      '), which leaves the batch permanently in `generated`: the one-way status trigger forbids ' +
      'returning it to draft, `payment_batch_no_delete` forbids removing it, and both bills stay ' +
      '`already_batched` forever. The money has already moved; the books can never record it through A18.',
  );
  assert.notEqual(snapshot(store), before);
});

// ---------------------------------------------------------------------------------------------
// PROBE 3. A batch drafted against a WRONG creditor IBAN can never be abandoned.
// ---------------------------------------------------------------------------------------------

test('CRITIC A18-3: a bill batched against a mistyped IBAN must be recoverable without paying it', () => {
  const { ctx, acc } = setup();
  const bankAccountId = mkBank(ctx, acc);
  const vendor = mkVendor(ctx, 'p3');
  const bill = mkBill(ctx, acc, vendor, 'p3', 100000);
  // The correction the operator makes afterwards: a different, check-digit-valid plain IBAN.
  const WRONG = IID_BOUNDARY[29999];
  must(setCreditorBankProfile(ctx, { vendorId: vendor, iban: PLAIN_IBAN, idempotencyKey: 'p3-cbp' }), 'set_creditor_bank_profile');
  const batch = must(
    createPaymentBatch(ctx, { bankAccountId, itemIds: [bill], executionDate: '2026-03-20', idempotencyKey: 'p3-batch' }),
    'create_payment_batch',
  );

  // The operator notices before uploading and corrects the profile.
  const fixed = setCreditorBankProfile(ctx, { vendorId: vendor, iban: WRONG, idempotencyKey: 'p3-cbp-2' });
  assert.equal(fixed.ok, true, 'correcting a vendor IBAN must be possible');

  // The batch's snapshot is deliberately frozen (documented). So the ONLY escape is to abandon this
  // draft and re-batch. F4 gives that escape: discard_payment_batch on a draft, no confirmation.
  const discarded = discardPaymentBatch(ctx, { batchId: batch.batchId, idempotencyKey: 'p3-discard' });
  assert.equal(discarded.ok, true, `a draft batch must be discardable: ${JSON.stringify(discarded)}`);
  assert.equal(discarded.batch.status, 'discarded');

  const relisted = must(listPayableOpenItems(ctx, {}), 'list_payable');
  const row = relisted.items.find((i) => i.billId === bill);
  assert.equal(
    row.alreadyBatchedInto,
    null,
    'after discard the bill must be payable again (liveBatchFor excludes a discarded batch), so it ' +
      'can be re-batched against the corrected IBAN without ever paying the wrong one.',
  );
});

// ---------------------------------------------------------------------------------------------
// PROBE 4. markBatchPaid atomicity: one bad item must write NOTHING.
// ---------------------------------------------------------------------------------------------

test('CRITIC A18-4: a rejection on item 2 rolls item 1 back (savepoint nesting is a claim, not evidence)', () => {
  const { ctx, store, acc } = setup();
  const bankAccountId = mkBank(ctx, acc);
  const vendorA = mkVendor(ctx, 'p4a');
  const vendorB = mkVendor(ctx, 'p4b');
  const billA = mkBill(ctx, acc, vendorA, 'p4a', 40000);
  const billB = mkBill(ctx, acc, vendorB, 'p4b', 60000);
  for (const [v, k] of [[vendorA, 'p4a'], [vendorB, 'p4b']]) {
    must(setCreditorBankProfile(ctx, { vendorId: v, iban: PLAIN_IBAN, idempotencyKey: `${k}-cbp` }), 'set_creditor_bank_profile');
  }
  const batch = must(
    createPaymentBatch(ctx, { bankAccountId, itemIds: [billA, billB], executionDate: '2026-03-20', idempotencyKey: 'p4-batch' }),
    'create_payment_batch',
  );
  must(generatePain001(ctx, { batchId: batch.batchId, idempotencyKey: 'p4-gen' }), 'generate_pain001');

  // Sabotage item 2 the way reality does: bill B gets settled by an ordinary A14 payment in between
  // (the bookkeeper paid it manually from e-banking and recorded it), so its allocation now exceeds
  // the open amount and recordPayment must refuse it.
  must(
    recordPayment(ctx, {
      direction: 'outgoing',
      date: '2026-03-19',
      amountMinor: 60000,
      currency: 'CHF',
      bankAccountId: (() => {
        return store.db.prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?').get(ctx.workspaceId, '1020').id;
      })(),
      counterpartyKind: 'supplier',
      counterpartyId: vendorB,
      allocations: [{ vendorBillId: billB, amountMinor: 60000 }],
      intent: PAYMENT_INTENTS.record,
      source: 'manual',
      idempotencyKey: 'p4-manual',
    }),
    'record_payment (the manual one that races the batch)',
  );

  const before = snapshot(store);
  const paid = markBatchPaid(ctx, {
    batchId: batch.batchId,
    confirmation: true,
    valueDate: '2026-03-21',
    idempotencyKey: 'p4-confirm',
  });
  assert.equal(paid.ok, false, 'item 2 is already settled, so the batch must refuse');
  assert.equal(
    snapshot(store),
    before,
    'ATOMICITY: item 1 must not have posted. Any diff here means a partial batch was booked and the ' +
      'batch row is stranded between generated and paid.',
  );
});

// ---------------------------------------------------------------------------------------------
// PROBE 5. A bill already settled by an ordinary record_payment must never be batchable.
// ---------------------------------------------------------------------------------------------

test('CRITIC A18-5: a bill paid outside A18 cannot be re-batched, and a PARTIAL payment batches only the rest', () => {
  const { ctx, store, acc } = setup();
  const bankAccountId = mkBank(ctx, acc);
  const ledger1020 = store.db
    .prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?')
    .get(ctx.workspaceId, '1020').id;
  const vendor = mkVendor(ctx, 'p5');
  const bill = mkBill(ctx, acc, vendor, 'p5', 100000);
  must(setCreditorBankProfile(ctx, { vendorId: vendor, iban: PLAIN_IBAN, idempotencyKey: 'p5-cbp' }), 'set_creditor_bank_profile');

  // Partial: 30'000 of 100'000 paid manually.
  must(
    recordPayment(ctx, {
      direction: 'outgoing',
      date: '2026-03-05',
      amountMinor: 30000,
      currency: 'CHF',
      bankAccountId: ledger1020,
      counterpartyKind: 'supplier',
      counterpartyId: vendor,
      allocations: [{ vendorBillId: bill, amountMinor: 30000 }],
      intent: PAYMENT_INTENTS.record,
      source: 'manual',
      idempotencyKey: 'p5-partial',
    }),
    'record_payment (partial)',
  );

  const batch = must(
    createPaymentBatch(ctx, { bankAccountId, itemIds: [bill], executionDate: '2026-03-20', idempotencyKey: 'p5-batch' }),
    'create_payment_batch',
  );
  const generated = must(generatePain001(ctx, { batchId: batch.batchId, idempotencyKey: 'p5-gen' }), 'generate_pain001');
  assert.equal(generated.ctrlSumMinor, 70000, 'the batch must pay the REMAINING open amount, never the gross');
  assert.match(xmlOf(generated), /<InstdAmt Ccy="CHF">700\.00<\/InstdAmt>/);

  must(markBatchPaid(ctx, { batchId: batch.batchId, confirmation: true, valueDate: '2026-03-21', idempotencyKey: 'p5-confirm' }), 'mark_batch_paid');
  const settled = must(getVendorBill(ctx, { vendorBillId: bill }), 'get_vendor_bill');
  assert.equal(settled.vendorBill.openMinor, 0, 'the bill must be fully settled at exactly 100000');

  // And a fully-settled bill can never enter a new batch.
  const again = createPaymentBatch(ctx, {
    bankAccountId,
    itemIds: [bill],
    executionDate: '2026-03-25',
    idempotencyKey: 'p5-batch-2',
  });
  assert.equal(again.ok, false);
  assert.equal(again.error, 'not_payable');
});

// ---------------------------------------------------------------------------------------------
// PROBE 6. A EUR bill: the file's InstdAmt must be the EUR figure, and the ledger the base figure.
// ---------------------------------------------------------------------------------------------

test('CRITIC A18-6: a EUR bill emits EUR in the file and books the base-currency value in the ledger', () => {
  const { ctx, store, acc } = setup();
  const bankAccountId = mkBank(ctx, acc);
  const vendor = mkVendor(ctx, 'p6');
  for (const [asOf, key] of [['2026-03-01', 'p6-rate-a'], ['2026-03-21', 'p6-rate-b']]) {
    must(
      recordExchangeRate(ctx, {
        baseCurrency: 'EUR',
        rate: '0.95',
        asOf,
        source: 'manual',
        method: 'daily',
        provenance: 'critic probe',
        idempotencyKey: key,
      }),
      'record_exchange_rate',
    );
  }
  const bill = mkBill(ctx, acc, vendor, 'p6', 100000, { currency: 'EUR' });
  must(setCreditorBankProfile(ctx, { vendorId: vendor, iban: PLAIN_IBAN, idempotencyKey: 'p6-cbp' }), 'set_creditor_bank_profile');

  const batch = must(
    createPaymentBatch(ctx, { bankAccountId, itemIds: [bill], executionDate: '2026-03-20', idempotencyKey: 'p6-batch' }),
    'create_payment_batch',
  );
  const generated = must(generatePain001(ctx, { batchId: batch.batchId, idempotencyKey: 'p6-gen' }), 'generate_pain001');
  const xml = xmlOf(generated);
  assert.match(xml, /<InstdAmt Ccy="EUR">1000\.00<\/InstdAmt>/, 'the bank must be told EUR 1000.00, not a CHF figure');
  assert.ok(validatePain001(xml).ok);

  const paid = markBatchPaid(ctx, {
    batchId: batch.batchId,
    confirmation: true,
    valueDate: '2026-03-21',
    idempotencyKey: 'p6-confirm',
  });
  assert.equal(paid.ok, true, `a EUR batch must settle: ${JSON.stringify(paid)}`);
  const entryId = store.db.prepare('SELECT journal_entry_id FROM payment WHERE id = ?').get(paid.paymentIds[0]).journal_entry_id;
  const legs = store.db
    .prepare(
      `SELECT a.number AS number, l.debit_minor AS d, l.credit_minor AS c
         FROM journal_line l JOIN account a ON a.id = l.account_id WHERE l.entry_id = ? ORDER BY a.number, l.rowid`,
    )
    .all(entryId);
  const debits = legs.reduce((n, l) => n + l.d, 0);
  const credits = legs.reduce((n, l) => n + l.c, 0);
  assert.equal(debits, credits, `the EUR settlement entry must balance in base currency: ${JSON.stringify(legs)}`);
  const bank = legs.filter((l) => l.number === '1020');
  assert.ok(bank.length > 0, 'the bank leg must exist');
});

// ---------------------------------------------------------------------------------------------
// PROBE 7. §H-TENANT: a batch and a creditor profile from workspace A are invisible in workspace B.
// ---------------------------------------------------------------------------------------------

test('CRITIC A18-7: every A18 read and write is tenant-scoped', () => {
  const clock = fixedClock('2026-07-19T00:00:00.000Z');
  const ids = sequenceIdGen();
  const store = new SqliteStore({ clock });
  const deps = { store, clock, ids };
  const wsA = createWorkspace(deps, { name: 'A GmbH' }).workspaceId;
  const wsB = createWorkspace(deps, { name: 'B GmbH' }).workspaceId;
  const ctxA = makeContext(store, { workspaceId: wsA, actor: 'user_1', clock, ids });
  const ctxB = makeContext(store, { workspaceId: wsB, actor: 'user_1', clock, ids });
  const accFor = (ws) => (n) =>
    store.db.prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?').get(ws, n).id;

  const bankA = mkBank(ctxA, accFor(wsA), 'ws-a-bank');
  const vendorA = mkVendor(ctxA, 'p7a');
  const billA = mkBill(ctxA, accFor(wsA), vendorA, 'p7a', 50000);
  must(setCreditorBankProfile(ctxA, { vendorId: vendorA, iban: PLAIN_IBAN, idempotencyKey: 'p7-cbp' }), 'set_creditor_bank_profile');
  const batchA = must(
    createPaymentBatch(ctxA, { bankAccountId: bankA, itemIds: [billA], executionDate: '2026-03-20', idempotencyKey: 'p7-batch' }),
    'create_payment_batch',
  );
  must(generatePain001(ctxA, { batchId: batchA.batchId, idempotencyKey: 'p7-gen' }), 'generate_pain001');

  assert.equal(getPaymentBatch(ctxB, { batchId: batchA.batchId }).ok, false, 'get_payment_batch must not cross tenants');
  assert.equal(generatePain001(ctxB, { batchId: batchA.batchId, idempotencyKey: 'p7-x' }).error, 'not_found');
  assert.equal(markBatchPaid(ctxB, { batchId: batchA.batchId, confirmation: true, valueDate: '2026-03-21', idempotencyKey: 'p7-y' }).error, 'not_found');
  assert.equal(must(listPayableOpenItems(ctxB, {}), 'list_payable').items.length, 0);
  // A vendor from workspace A may not be given a profile from workspace B.
  assert.equal(setCreditorBankProfile(ctxB, { vendorId: vendorA, iban: PLAIN_IBAN, idempotencyKey: 'p7-z' }).error, 'needs_vendor');
});

// ---------------------------------------------------------------------------------------------
// PROBE 8. Routing-shape exclusivity: QR-IBAN => QRR only; plain IBAN => never QRR.
// ---------------------------------------------------------------------------------------------

test('CRITIC A18-8: the three routing shapes stay mutually exclusive in the emitted XML', () => {
  const { ctx, acc } = setup();
  const bankAccountId = mkBank(ctx, acc);
  const QRR = '210000000003139471430009017';
  const SCOR = 'RF18539007547034';

  // Shape A: QR-IBAN + QRR.
  const vQr = mkVendor(ctx, 'p8qr');
  const bQr = mkBill(ctx, acc, vQr, 'p8qr', 10000, { vendorReference: QRR });
  must(setCreditorBankProfile(ctx, { vendorId: vQr, iban: QR_IBAN, idempotencyKey: 'p8qr-cbp' }), 'cbp');
  // Shape B: plain IBAN + SCOR.
  const vSc = mkVendor(ctx, 'p8sc');
  const bSc = mkBill(ctx, acc, vSc, 'p8sc', 20000, { vendorReference: SCOR });
  must(setCreditorBankProfile(ctx, { vendorId: vSc, iban: PLAIN_IBAN, idempotencyKey: 'p8sc-cbp' }), 'cbp');
  // Shape C: plain IBAN + free text.
  const vFt = mkVendor(ctx, 'p8ft');
  const bFt = mkBill(ctx, acc, vFt, 'p8ft', 30000, { vendorReference: 'Rechnung 42' });
  must(setCreditorBankProfile(ctx, { vendorId: vFt, iban: PLAIN_IBAN, idempotencyKey: 'p8ft-cbp' }), 'cbp');

  const batch = must(
    createPaymentBatch(ctx, { bankAccountId, itemIds: [bQr, bSc, bFt], executionDate: '2026-03-20', idempotencyKey: 'p8-batch' }),
    'create_payment_batch',
  );
  const xml = xmlOf(must(generatePain001(ctx, { batchId: batch.batchId, idempotencyKey: 'p8-gen' }), 'generate_pain001'));

  const txs = xml.split('<CdtTrfTxInf>').slice(1);
  assert.equal(txs.length, 3);
  const qrTx = txs.find((t) => t.includes(QR_IBAN.replace(/\s/g, '')));
  assert.ok(qrTx.includes('<Prtry>QRR</Prtry>'), 'the QR-IBAN instruction must carry QRR');
  assert.ok(!qrTx.includes('<Ustrd>'), 'SIX IG: Ustrd must not be supplied with a QR-IBAN');
  assert.ok(!qrTx.includes('<Cd>SCOR</Cd>'), 'SIX IG: Cd=SCOR must not be used with a QR-IBAN');

  const scorTx = txs.find((t) => t.includes(SCOR));
  assert.ok(scorTx.includes('<Cd>SCOR</Cd>'));
  assert.ok(!scorTx.includes('<Prtry>QRR</Prtry>'), 'SIX IG: QRR only in combination with a QR-IBAN');

  const ftTx = txs.find((t) => t.includes('Rechnung 42'));
  assert.ok(ftTx.includes('<Ustrd>Rechnung 42</Ustrd>'));
  assert.ok(!ftTx.includes('<Strd>'));

  // And the check-digit floor: a QRR whose check digit is wrong never reaches the file.
  const bad = '210000000003139471430009018'; // last digit tampered
  const vBad = mkVendor(ctx, 'p8bad');
  const bBad = mkBill(ctx, acc, vBad, 'p8bad', 5000, { vendorReference: bad });
  must(setCreditorBankProfile(ctx, { vendorId: vBad, iban: QR_IBAN, idempotencyKey: 'p8bad-cbp' }), 'cbp');
  const refused = createPaymentBatch(ctx, {
    bankAccountId,
    itemIds: [bBad],
    executionDate: '2026-03-20',
    idempotencyKey: 'p8bad-batch',
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'needs_qrr_reference');
});

// ---------------------------------------------------------------------------------------------
// PROBE 9. Generation must NOT book, and the state machine must not walk backwards.
// ---------------------------------------------------------------------------------------------

test('CRITIC A18-9: generate_pain001 writes no journal row, and a paid batch cannot be re-generated into a new file', () => {
  const { ctx, store, acc } = setup();
  const bankAccountId = mkBank(ctx, acc);
  const vendor = mkVendor(ctx, 'p9');
  const bill = mkBill(ctx, acc, vendor, 'p9', 100000);
  must(setCreditorBankProfile(ctx, { vendorId: vendor, iban: PLAIN_IBAN, idempotencyKey: 'p9-cbp' }), 'cbp');
  const batch = must(
    createPaymentBatch(ctx, { bankAccountId, itemIds: [bill], executionDate: '2026-03-20', idempotencyKey: 'p9-batch' }),
    'create_payment_batch',
  );

  const entriesBefore = store.db
    .prepare('SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ?')
    .get(ctx.workspaceId).n;
  must(generatePain001(ctx, { batchId: batch.batchId, idempotencyKey: 'p9-gen' }), 'generate_pain001');
  const entriesAfter = store.db
    .prepare('SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ?')
    .get(ctx.workspaceId).n;
  assert.equal(entriesAfter, entriesBefore, 'generation is an artefact, never a posting');

  must(markBatchPaid(ctx, { batchId: batch.batchId, confirmation: true, valueDate: '2026-03-21', idempotencyKey: 'p9-confirm' }), 'mark_batch_paid');

  // A PAID batch: can a fresh idempotency key still hand out a file the operator might upload again?
  const regen = generatePain001(ctx, { batchId: batch.batchId, idempotencyKey: 'p9-gen-2' });
  assert.equal(
    regen.ok,
    false,
    'a PAID batch still hands out a fully valid pain.001 (' +
      (regen.ok ? `nbOfTxs=${regen.nbOfTxs}, ctrlSum=${regen.ctrlSumMinor}, filename=${regen.filename}` : '') +
      '). Uploading that file a second time is a second execution by the bank, and the batch status ' +
      'gives the operator no signal at all: the answer carries valid:true and no warning.',
  );
});

// ---------------------------------------------------------------------------------------------
// PROBE 10. Regeneration byte-identity, with a clock that moves (as it does in production).
// ---------------------------------------------------------------------------------------------

test('CRITIC A18-10: regeneration is byte-identical even when the wall clock has moved', () => {
  const clock = { now: () => clock.value, value: '2026-07-19T00:00:00.000Z' };
  const ids = sequenceIdGen();
  const store = new SqliteStore({ clock });
  const workspaceId = createWorkspace({ store, clock, ids }, { name: 'Muster Grafik GmbH' }).workspaceId;
  const ctx = makeContext(store, { workspaceId, actor: 'user_1', clock, ids });
  const acc = (n) => store.db.prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?').get(workspaceId, n).id;

  const bankAccountId = mkBank(ctx, acc);
  const vendor = mkVendor(ctx, 'p10');
  const bill = mkBill(ctx, acc, vendor, 'p10', 100000);
  must(setCreditorBankProfile(ctx, { vendorId: vendor, iban: PLAIN_IBAN, idempotencyKey: 'p10-cbp' }), 'cbp');
  const batch = must(
    createPaymentBatch(ctx, { bankAccountId, itemIds: [bill], executionDate: '2026-03-20', idempotencyKey: 'p10-batch' }),
    'create_payment_batch',
  );
  const first = must(generatePain001(ctx, { batchId: batch.batchId, idempotencyKey: 'p10-gen' }), 'generate_pain001');

  clock.value = '2026-07-20T09:31:00.000Z'; // the operator comes back the next morning
  const second = must(generatePain001(ctx, { batchId: batch.batchId, idempotencyKey: 'p10-gen-2' }), 'generate_pain001');
  assert.equal(
    second.xmlBase64,
    first.xmlBase64,
    'the module comment and the MCP tool description both promise "byte-identical" regeneration. ' +
      'CreDtTm is taken from ctx.clock.now() at BUILD time, so the promise holds only under a frozen ' +
      'test clock. Under a real clock the two files differ, which matters because MsgId does NOT ' +
      'change: two textually different files carry the same duplicate-detection key.',
  );
});

// ---------------------------------------------------------------------------------------------
// PROBE 11. What validatePain001 claims to re-derive, versus what it actually reads.
// ---------------------------------------------------------------------------------------------

test('CRITIC A18-11: validatePain001 must re-derive BOTH NbOfTxs/CtrlSum occurrences, not only the first', () => {
  // A pain.001 carries NbOfTxs/CtrlSum twice: once in GrpHdr (A level) and once in PmtInf (B level).
  // This file's B level contradicts its own single instruction outright.
  const xml =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.001.001.09"><CstmrCdtTrfInitn>' +
    '<GrpHdr><MsgId>X</MsgId><CreDtTm>2026-01-01T00:00:00.000Z</CreDtTm>' +
    '<NbOfTxs>1</NbOfTxs><CtrlSum>10.00</CtrlSum></GrpHdr>' +
    '<PmtInf><PmtInfId>Y</PmtInfId><PmtMtd>TRF</PmtMtd>' +
    '<NbOfTxs>99</NbOfTxs><CtrlSum>9999.00</CtrlSum>' +
    '<CdtTrfTxInf><Amt><InstdAmt Ccy="CHF">10.00</InstdAmt></Amt></CdtTrfTxInf>' +
    '</PmtInf></CstmrCdtTrfInitn></Document>';
  const result = validatePain001(xml);
  assert.equal(
    result.ok,
    false,
    'the B-level control totals claim 99 transactions worth 9999.00 over a single 10.00 instruction, ' +
      'and validatePain001 answers ok:true. Its regexes use .exec (first match) rather than .matchAll, ' +
      'so the module comment\'s "NbOfTxs/CtrlSum as WRITTEN equal what the text\'s own occurrences sum to" ' +
      'is true of exactly one of the two places they are written.',
  );
});

test('CRITIC A18-12: validatePain001 must reject a reference element that breaks Max35Text', () => {
  const long = 'PB-pbatch-643185b2-cdca-4c7a-8103-0932dce6cc6f'; // 46 chars, the real production shape
  assert.equal(long.length, 46);
  const xml =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.001.001.09"><CstmrCdtTrfInitn>' +
    `<GrpHdr><MsgId>${long}</MsgId><CreDtTm>2026-01-01T00:00:00.000Z</CreDtTm>` +
    '<NbOfTxs>1</NbOfTxs><CtrlSum>10.00</CtrlSum></GrpHdr>' +
    '<PmtInf><PmtInfId>Y</PmtInfId><PmtMtd>TRF</PmtMtd>' +
    '<CdtTrfTxInf><Amt><InstdAmt Ccy="CHF">10.00</InstdAmt></Amt></CdtTrfTxInf>' +
    '</PmtInf></CstmrCdtTrfInitn></Document>';
  assert.equal(
    validatePain001(xml).ok,
    false,
    'validatePain001 is offered as the substitute for XSD validation. Max35Text on the four reference ' +
      'elements is exactly the class of schema rule an XSD run enforces, it is the rule this landing ' +
      'actually breaks in production, and the substitute does not look at length at all.',
  );
});

// ---------------------------------------------------------------------------------------------
// PROBE 13. Can an operator (or an agent) READ BACK the destination it is about to pay?
// ---------------------------------------------------------------------------------------------

test('CRITIC A18-13: the full creditor IBAN must be readable from some A18 verb before upload', () => {
  const { ctx, acc } = setup();
  const bankAccountId = mkBank(ctx, acc);
  const vendor = mkVendor(ctx, 'p13');
  const bill = mkBill(ctx, acc, vendor, 'p13', 100000);
  must(setCreditorBankProfile(ctx, { vendorId: vendor, iban: PLAIN_IBAN, idempotencyKey: 'p13-cbp' }), 'cbp');
  const batch = must(
    createPaymentBatch(ctx, { bankAccountId, itemIds: [bill], executionDate: '2026-03-20', idempotencyKey: 'p13-batch' }),
    'create_payment_batch',
  );
  const full = PLAIN_IBAN.replace(/\s/g, '');
  const surfaces = JSON.stringify({
    getPaymentBatch: getPaymentBatch(ctx, { batchId: batch.batchId }),
    listPayable: listPayableOpenItems(ctx, {}),
  });
  assert.ok(
    surfaces.includes(full),
    'every A18 read masks the creditor IBAN to its last four characters (`maskIban`). The destination ' +
      'of the money is the one fact a payment-review step exists to check, and the only place it ' +
      'appears in full is inside the base64 XML blob. An agent that stored a profile cannot read back ' +
      'what it stored, and a human reviewing the batch cannot see where the money goes.',
  );
});
