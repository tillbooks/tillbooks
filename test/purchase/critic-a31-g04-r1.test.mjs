/**
 * Critic probes, A31 supplied QR payload seam, round 1 of the joint G04/A31 review (non-author critic,
 * 30.09.2026). A test that FAILS on `claude/g04-restore-chokepoint` (de1a7176) is a finding; the report
 * is `docs/critique/g04-a31-restore-qr-critic-r1.md`.
 *
 * Synthetic payloads only: SIX's published sample IBAN (CH93 0076 2011 6238 5295 7) and invented
 * creditors. Nothing is derived from a real bill.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { captureIntake, captureExtract, captureCommit, getCapture, getVendorBill } from '../../dist/core/purchase/index.js';
import { createContact } from '../../dist/core/sales/index.js';
import { buildScorReference } from '../../dist/core/sales/qrbill.js';
import { setup } from './support.mjs';

/** A synthetic plain-IBAN bill; `amount` '' is an open amount, `tp` NON drops the reference. */
function bill({ name = 'Beispiel Druckerei GmbH', amount = '100.00', ccy = 'CHF', tp = 'SCOR', seed = 'DR2026' } = {}) {
  return [
    'SPC', '0200', '1', 'CH9300762011623852957',
    'S', name, 'Seeweg', '12', '6000', 'Luzern', 'CH',
    '', '', '', '', '', '', '',
    amount, ccy,
    '', '', '', '', '', '', '',
    tp, tp === 'SCOR' ? buildScorReference(seed) : '', '', 'EPD',
  ].join('\n');
}

const RASTER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 8, 7, 6, 5, 4, 3, 2]).toString('base64');

function dropRaster(ctx, key) {
  const r = captureIntake(ctx, { contentBase64: RASTER, mime: 'image/png', filename: 'beleg.png', idempotencyKey: key });
  assert.equal(r.ok, true, JSON.stringify(r));
  return r.captureId;
}

const live = (ctx, captureId) =>
  Object.fromEntries(getCapture(ctx, { captureId }).fields.filter((f) => !f.superseded).map((f) => [f.key, f.value]));

test('R1-H2 probe: a clean EUR QR-bill committed from a capture lands as a EUR bill, never as the same number in CHF', () => {
  const t = setup();
  const vendor = createContact(t.ctx, { partyRole: 'vendor', name: 'Beispiel Druckerei GmbH', idempotencyKey: 'v' });
  assert.equal(vendor.ok, true);
  const captureId = dropRaster(t.ctx, 'eur');
  const extracted = captureExtract(t.ctx, { captureId, source: 'operator', qrPayload: bill({ amount: '100.00', ccy: 'EUR' }), idempotencyKey: 'x' });
  assert.equal(extracted.ok, true, JSON.stringify(extracted));
  assert.deepEqual(live(t.ctx, captureId).amount, { minor: 10000, currency: 'EUR' }, 'the decoder proposes EUR 100.00');

  const commit = captureCommit(t.ctx, {
    captureId,
    target: { kind: 'vendor_bill', vendorId: vendor.contact.id, billDate: '2026-03-01', expenseAccountId: t.acc('6500') },
    idempotencyKey: 'c',
  });
  // Either a clean refusal or a EUR bill is acceptable; CHF 100.00 is a wrong amount.
  if (!commit.ok) return;
  const vb = getVendorBill(t.ctx, { vendorBillId: commit.targetId });
  assert.equal(vb.ok, true, JSON.stringify(vb));
  assert.equal(vb.vendorBill.currency, 'EUR', `a EUR 100.00 bill was committed as ${vb.vendorBill.currency} ${vb.vendorBill.grossMinor / 100}`);
});

test('R1-M1 probe: a second supplied payload does not leave the FIRST bill\'s amount and reference live beside its own creditor', () => {
  const t = setup();
  const captureId = dropRaster(t.ctx, 'mix');
  // The reader first picked up the wrong bill on the desk (a priced SCOR bill)...
  const first = captureExtract(t.ctx, { captureId, source: 'operator', qrPayload: bill({ name: 'Falsche Firma AG', amount: '4321.00', seed: 'WRONG1' }), idempotencyKey: 'a' });
  assert.equal(first.ok, true, JSON.stringify(first));
  // ...then the right one: another creditor, an OPEN amount (the payer fills it in) and no reference.
  const second = captureExtract(t.ctx, { captureId, source: 'operator', qrPayload: bill({ name: 'Richtige Firma GmbH', amount: '', tp: 'NON' }), idempotencyKey: 'b' });
  assert.equal(second.ok, true, JSON.stringify(second));
  const f = live(t.ctx, captureId);
  assert.equal(f.vendor_name, 'Richtige Firma GmbH');
  assert.equal(f.reference_type, 'NON');
  // The second payload states NO amount and NO reference; the capture must not keep proposing the
  // first bill's, which a commit would book against the second creditor.
  assert.equal(f.amount, undefined, `the capture still proposes the first bill's amount ${JSON.stringify(f.amount)} for ${f.vendor_name}`);
  assert.equal(f.reference, undefined, `the capture still proposes the first bill's reference ${f.reference} with reference_type NON`);
});
