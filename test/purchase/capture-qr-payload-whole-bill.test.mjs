/**
 * A31 §0a: a supplied QR payload is ONE whole bill (critic R1-M1, joint G04/A31 round 1).
 *
 * Fields merge one by one, so before the fix a second payload that stated no amount (open) or no
 * reference (NON) left the FIRST payload's amount and reference live beside its own creditor. These
 * tests pin the rule the fix states: a new payload retires every live field an earlier supplied payload
 * wrote that it does not restate (kept as superseded history), within the merge rules' own limit that
 * an `agent` cannot retire what an `operator` asserted, and never touching fields from another source.
 *
 * Synthetic payloads only: SIX IG v2.3 Annex A example 2 (published) and SIX's published sample IBAN
 * with invented creditors.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { captureIntake, captureExtract, getCapture } from '../../dist/core/purchase/index.js';
import { createContact } from '../../dist/core/sales/index.js';
import { buildScorReference } from '../../dist/core/sales/qrbill.js';
import { setup } from './support.mjs';

// SIX IG v2.3 Annex A, example 2 (Table 18): QR-IBAN, QRR, Swico S1 (with the UID /30/) and a message.
const SIX_EXAMPLE_2 = [
  'SPC', '0200', '1', 'CH4431999123000889012',
  'S', 'Max Muster & Söhne', 'Musterstrasse', '123', '8000', 'Seldwyla', 'CH',
  '', '', '', '', '', '', '',
  '1949.75', 'CHF',
  'S', 'Simon Muster', 'Musterstrasse', '1', '8000', 'Seldwyla', 'CH',
  'QRR', '210000000003139471430009017', 'Order from 15.10.2020', 'EPD',
  '//S1/10/1234/11/201021/30/102673386/32/7.7/40/0:30',
  'eBill/B/simon.muster@example.com',
].join('\r\n');

/** A synthetic plain-IBAN bill: open amount with `amount` '', no reference with `tp` NON. */
function bill({ name = 'Richtige Firma GmbH', amount = '', tp = 'NON' } = {}) {
  return [
    'SPC', '0200', '1', 'CH9300762011623852957',
    'S', name, 'Seeweg', '12', '6000', 'Luzern', 'CH',
    '', '', '', '', '', '', '',
    amount, 'CHF',
    '', '', '', '', '', '', '',
    tp, tp === 'SCOR' ? buildScorReference('WB2026') : '', '', 'EPD',
  ].join('\n');
}

const RASTER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 2, 4, 6, 8, 10, 12, 14, 16]).toString('base64');

function drop(t, key = 'img') {
  const r = captureIntake(t.ctx, { contentBase64: RASTER, mime: 'image/png', filename: 'rechnung.png', idempotencyKey: key });
  assert.equal(r.ok, true, JSON.stringify(r));
  return r.captureId;
}

function supply(t, captureId, qrPayload, source = 'operator', key) {
  const r = captureExtract(t.ctx, { captureId, source, qrPayload, ...(key ? { idempotencyKey: key } : {}) });
  assert.equal(r.ok, true, JSON.stringify(r));
  return r;
}

const live = (t, captureId) =>
  Object.fromEntries(getCapture(t.ctx, { captureId }).fields.filter((f) => !f.superseded).map((f) => [f.key, f]));
const history = (t, captureId, key) => getCapture(t.ctx, { captureId }).fields.filter((f) => f.key === key && f.superseded);
const payloadRows = (t, captureId) => getCapture(t.ctx, { captureId }).qrPayloads.length;

test('R1-M1 a second payload retires EVERY field of the first it does not restate, Swico keys and the UID-matched vendor included', () => {
  const t = setup();
  createContact(t.ctx, { partyRole: 'vendor', name: 'Muster Söhne', vatNumber: 'CHE-102.673.386 MWST', idempotencyKey: 'v' });
  const captureId = drop(t);
  supply(t, captureId, SIX_EXAMPLE_2);
  const before = live(t, captureId);
  for (const k of ['amount', 'reference', 'payment_message', 'invoice_no', 'invoice_date', 'vendor_contact_id']) {
    assert.ok(before[k] !== undefined, `the first payload proposes ${k}`);
  }

  supply(t, captureId, bill());
  const after = live(t, captureId);
  assert.equal(after.vendor_name.value, 'Richtige Firma GmbH');
  assert.equal(after.reference_type.value, 'NON');
  assert.equal(after.iban.value, 'CH9300762011623852957');
  for (const k of ['amount', 'reference', 'payment_message', 'invoice_no', 'invoice_date', 'vendor_contact_id']) {
    assert.equal(after[k], undefined, `the first bill's ${k} is still live beside the second creditor: ${JSON.stringify(after[k]?.value)}`);
    assert.equal(history(t, captureId, k).length, 1, `the first bill's ${k} is kept as superseded history, never dropped`);
  }
  assert.equal(payloadRows(t, captureId), 2, 'the second payload is on record as the one that retired them');
});

test('R1-M1 re-supplying the SAME payload is still a no-op: nothing retired, no evidence row added', () => {
  const t = setup();
  const captureId = drop(t);
  supply(t, captureId, SIX_EXAMPLE_2);
  const rowsBefore = getCapture(t.ctx, { captureId }).fields.length;
  supply(t, captureId, SIX_EXAMPLE_2);
  assert.equal(getCapture(t.ctx, { captureId }).fields.length, rowsBefore);
  assert.equal(payloadRows(t, captureId), 1);
});

test('R1-M1 a payload that differs from the first ONLY by what it leaves out still retires it, with its own evidence row', () => {
  const t = setup();
  const captureId = drop(t);
  supply(t, captureId, bill({ amount: '50.00', tp: 'SCOR' }));
  assert.ok(live(t, captureId).amount);
  // Same creditor, same IBAN, but open amount and NON: every restated key is identical (a no-op), and
  // only the retirement changes anything.
  supply(t, captureId, bill({ amount: '', tp: 'NON' }));
  const f = live(t, captureId);
  assert.equal(f.amount, undefined);
  assert.equal(f.reference, undefined);
  assert.equal(f.reference_type.value, 'NON');
  assert.equal(payloadRows(t, captureId), 2);
});

test('R1-M1 an AGENT payload cannot retire what an OPERATOR payload asserted (merge rule 2 holds by omission too)', () => {
  const t = setup();
  const captureId = drop(t);
  supply(t, captureId, bill({ name: 'Geprüfte Firma AG', amount: '75.00', tp: 'SCOR' }), 'operator');
  supply(t, captureId, bill({ name: 'Andere Firma GmbH', amount: '', tp: 'NON' }), 'agent');
  const f = live(t, captureId);
  assert.equal(f.vendor_name.value, 'Geprüfte Firma AG');
  assert.deepEqual(f.amount.value, { minor: 7500, currency: 'CHF' });
  assert.equal(f.reference_type.value, 'SCOR');
  assert.ok(f.reference);
});

test('R1-M1 a typed value on a key no bill states survives every later payload; one on a bill key goes with its bill (owner 01.10.2026)', () => {
  const t = setup();
  const captureId = drop(t);
  const typed = captureExtract(t.ctx, { captureId, source: 'operator', fields: [{ key: 'tax_code', value: 'VST-M' }, { key: 'due_date', value: '2026-08-31' }] });
  assert.equal(typed.ok, true, JSON.stringify(typed));
  supply(t, captureId, bill({ amount: '20.00', tp: 'SCOR' }));
  supply(t, captureId, bill());
  assert.equal(live(t, captureId).tax_code?.value, 'VST-M', 'a booking choice no bill states is never touched');
  assert.equal(live(t, captureId).due_date, undefined, 'a typed due date belongs to its bill: a different bill resets it');
  const discarded = getCapture(t.ctx, { captureId }).fields.find((f) => f.key === 'due_date' && f.superseded);
  assert.equal(discarded?.supersededReason, 'discarded_with_bill', 'kept as history, with its reason');
});

// --- R2-M1: the stored bytes' own read is part of "the bill on the capture" --------------------------

/** A PDF whose text layer carries SIX example 2 (QRR, Swico, UID, a message): the intake reads it `qr`/`swico`. */
function dropBytesBill(t, key = 'pdf') {
  const r = captureIntake(t.ctx, { contentBase64: Buffer.from(SIX_EXAMPLE_2, 'utf8').toString('base64'), mime: 'application/pdf', filename: 'rechnung.pdf', idempotencyKey: key });
  assert.equal(r.ok, true, JSON.stringify(r));
  const f = live(t, r.captureId);
  for (const k of ['amount', 'reference', 'invoice_no']) assert.ok(['qr', 'swico'].includes(f[k]?.provenance), `the bytes' read proposes ${k}`);
  return r.captureId;
}

/** A second synthetic bill with its own SCOR seed and amount. */
function otherBill({ name, amount, tp = 'SCOR', seed = 'R2M1B' }) {
  return [
    'SPC', '0200', '1', 'CH9300762011623852957',
    'S', name, 'Seeweg', '12', '6000', 'Luzern', 'CH',
    '', '', '', '', '', '', '',
    amount, 'CHF',
    '', '', '', '', '', '', '',
    tp, tp === 'SCOR' ? buildScorReference(seed) : '', 'Rechnung Juli', 'EPD',
  ].join('\n');
}

test('R2-M1 an OPERATOR payload for another bill retires every bytes-read field it does not restate (open amount, NON, Swico keys)', () => {
  const t = setup();
  const captureId = dropBytesBill(t);
  supply(t, captureId, bill({ name: 'Richtige Firma GmbH', amount: '', tp: 'NON' }));
  const f = live(t, captureId);
  assert.equal(f.vendor_name.value, 'Richtige Firma GmbH');
  assert.equal(f.reference_type.value, 'NON');
  for (const k of ['amount', 'reference', 'invoice_no', 'invoice_date']) {
    assert.equal(f[k], undefined, `the bytes' ${k} is still live beside the supplied creditor: ${JSON.stringify(f[k]?.value)} (${f[k]?.provenance})`);
    assert.ok(history(t, captureId, k).some((h) => ['qr', 'swico'].includes(h.provenance)), `the bytes' ${k} is kept as superseded history`);
  }
  assert.equal(payloadRows(t, captureId), 1, 'the payload that retired them is on record');
});

test('R2-M1 an OPERATOR payload that RESTATES the fields replaces the bytes\' values and still retires the keys it leaves out', () => {
  const t = setup();
  const captureId = dropBytesBill(t);
  supply(t, captureId, otherBill({ name: 'Richtige Firma GmbH', amount: '50.00', seed: 'RESTATE1' }));
  const f = live(t, captureId);
  assert.equal(f.vendor_name.value, 'Richtige Firma GmbH');
  assert.deepEqual(f.amount.value, { minor: 5000, currency: 'CHF' });
  assert.equal(f.amount.provenance, 'operator');
  assert.equal(f.reference_type.value, 'SCOR');
  assert.equal(f.reference.value, buildScorReference('RESTATE1'));
  assert.equal(f.payment_message.value, 'Rechnung Juli');
  // The bytes' Swico keys are not restated by a payload without billing information: retired.
  assert.equal(f.invoice_no, undefined);
  assert.equal(f.invoice_date, undefined);
  assert.ok(history(t, captureId, 'amount').some((h) => h.provenance === 'qr'), 'the bytes\' amount is kept as history');
});

test('R2-M1 supplying the SAME bill the bytes carry retires nothing: every key they state is restated identically', () => {
  const t = setup();
  const captureId = dropBytesBill(t);
  const before = live(t, captureId);
  supply(t, captureId, SIX_EXAMPLE_2);
  const after = live(t, captureId);
  assert.equal(getCapture(t.ctx, { captureId }).fields.filter((f) => f.superseded).length, 0, 'nothing was retired or superseded');
  for (const k of Object.keys(before)) {
    assert.deepEqual(after[k].value, before[k].value, `${k} kept its value`);
    assert.equal(after[k].provenance, before[k].provenance, `${k} kept the stored bytes' provenance (an identical value is a no-op)`);
  }
  // Only what the text-layer pass does not propose (the address, the message) is added by the payload.
  for (const k of Object.keys(after).filter((k) => !(k in before))) assert.equal(after[k].provenance, 'operator');
});

test('R2-M1 an AGENT payload for another bill LOSES whole to the bytes\' read: nothing of it goes live, nothing is retired', () => {
  const t = setup();
  const captureId = dropBytesBill(t);
  const before = live(t, captureId);
  supply(t, captureId, otherBill({ name: 'Andere Firma GmbH', amount: '12.00', seed: 'AGENT1' }), 'agent');
  const f = live(t, captureId);
  assert.deepEqual(Object.keys(f).sort(), Object.keys(before).sort(), 'no key of the agent payload went live, none was retired');
  for (const k of Object.keys(before)) assert.deepEqual(f[k].value, before[k].value, `${k} kept the bytes' value`);
  assert.equal(f.payment_message, undefined, 'the agent bill\'s message did not mix in');
  assert.ok(history(t, captureId, 'vendor_name').some((h) => h.provenance === 'agent' && h.value === 'Andere Firma GmbH'), 'the agent bill is on record as a loser');
});

test('R2-M1 a typed correction to the bytes\' bill is discarded with it when an operator payload for another bill wins; a typed-only key survives', () => {
  const t = setup();
  const captureId = dropBytesBill(t);
  const typed = captureExtract(t.ctx, { captureId, source: 'operator', fields: [{ key: 'due_date', value: '2026-08-31' }, { key: 'expense_account_id', value: 'acc_x' }] });
  assert.equal(typed.ok, true, JSON.stringify(typed));
  // A re-read of the SAME bytes never touches the correction.
  assert.equal(captureExtract(t.ctx, { captureId, source: 'qr' }).ok, true);
  assert.equal(live(t, captureId).due_date?.value, '2026-08-31');
  supply(t, captureId, bill({ name: 'Richtige Firma GmbH', amount: '', tp: 'NON' }));
  assert.equal(live(t, captureId).due_date, undefined);
  assert.equal(live(t, captureId).expense_account_id?.value, 'acc_x');
  assert.ok(getCapture(t.ctx, { captureId }).fields.some((f) => f.key === 'due_date' && f.value === '2026-08-31' && f.supersededReason === 'discarded_with_bill'));
});

// --- R5-M1 / owner decision 01.10.2026: corrections belong to their bill ------------------------------

test('R5-M1 a hand CORRECTION to one bill goes with it: a different bill resets the key, the correction stays as history with its reason', () => {
  const t = setup();
  const captureId = drop(t);
  supply(t, captureId, bill({ name: 'Falsche Firma AG', amount: '4321.00', tp: 'SCOR' }));
  const fix = captureExtract(t.ctx, { captureId, source: 'operator', fields: [{ key: 'amount', value: { minor: 98000, currency: 'CHF' } }] });
  assert.equal(fix.ok, true, JSON.stringify(fix));
  // A re-scan of the SAME paper never touches the correction.
  supply(t, captureId, bill({ name: 'Falsche Firma AG', amount: '4321.00', tp: 'SCOR' }));
  assert.deepEqual(live(t, captureId).amount.value, { minor: 98000, currency: 'CHF' });
  // The right bill: its amount is live, the correction to the old bill is history.
  supply(t, captureId, bill({ name: 'Richtige Firma GmbH', amount: '2000.00', tp: 'NON' }));
  const f = live(t, captureId);
  assert.equal(f.vendor_name.value, 'Richtige Firma GmbH');
  assert.deepEqual(f.amount.value, { minor: 200000, currency: 'CHF' });
  const discarded = getCapture(t.ctx, { captureId }).fields.filter((x) => x.supersededReason === 'discarded_with_bill');
  assert.deepEqual(discarded.map((x) => [x.key, x.value]), [['amount', { minor: 98000, currency: 'CHF' }]]);
});

test('R5-M1 a different bill that leaves the amount OPEN leaves no live amount, so the commit asks again (needs_amount)', async () => {
  const { captureCommit } = await import('../../dist/core/purchase/index.js');
  const t = setup();
  const vendor = createContact(t.ctx, { partyRole: 'vendor', name: 'Richtige Firma GmbH', idempotencyKey: 'v' });
  const captureId = drop(t);
  supply(t, captureId, bill({ name: 'Falsche Firma AG', amount: '4321.00', tp: 'SCOR' }));
  assert.equal(captureExtract(t.ctx, { captureId, source: 'operator', fields: [{ key: 'amount', value: { minor: 432100, currency: 'CHF' } }] }).ok, true);
  supply(t, captureId, bill({ name: 'Richtige Firma GmbH', amount: '', tp: 'NON' }));
  assert.equal(live(t, captureId).amount, undefined);
  const commit = captureCommit(t.ctx, { captureId, target: { kind: 'vendor_bill', vendorId: vendor.contact.id, billDate: '2026-03-01', expenseAccountId: t.acc('6500') }, idempotencyKey: 'c' });
  assert.equal(commit.ok, false);
  assert.equal(commit.error, 'needs_amount');
});

test('R5-M1 an AGENT bill never resets an operator correction: against it, the agent bill loses whole', () => {
  const t = setup();
  const captureId = drop(t);
  supply(t, captureId, bill({ name: 'Erste Firma AG', amount: '10.00', tp: 'SCOR' }), 'agent');
  assert.equal(captureExtract(t.ctx, { captureId, source: 'operator', fields: [{ key: 'amount', value: { minor: 1200, currency: 'CHF' } }] }).ok, true);
  supply(t, captureId, bill({ name: 'Zweite Firma AG', amount: '99.00', tp: 'NON' }), 'agent');
  const f = live(t, captureId);
  assert.equal(f.vendor_name.value, 'Erste Firma AG');
  assert.deepEqual(f.amount.value, { minor: 1200, currency: 'CHF' });
});
