/**
 * Critic probes, A31 supplied QR payload seam, round 2 of the joint G04/A31 review (non-author critic,
 * 30.09.2026), against `claude/g04-restore-chokepoint` 2cbbcec3. A test that FAILS there is a finding;
 * the report is `docs/critique/g04-a31-restore-qr-critic-r2.md`.
 *
 * Synthetic payloads only: SIX's published sample IBAN (CH93 0076 2011 6238 5295 7) and invented
 * creditors. Nothing is derived from a real bill.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { captureIntake, captureExtract, getCapture } from '../../dist/core/purchase/index.js';
import { buildScorReference } from '../../dist/core/sales/qrbill.js';
import { setup } from './support.mjs';

function bill({ name, amount, tp = 'SCOR', seed = 'DR2026' }) {
  return [
    'SPC', '0200', '1', 'CH9300762011623852957',
    'S', name, 'Seeweg', '12', '6000', 'Luzern', 'CH',
    '', '', '', '', '', '', '',
    amount, 'CHF',
    '', '', '', '', '', '', '',
    tp, tp === 'SCOR' ? buildScorReference(seed) : '', '', 'EPD',
  ].join('\n');
}

const liveFields = (ctx, captureId) => getCapture(ctx, { captureId }).fields.filter((f) => !f.superseded);

test('R2-M1 probe: a supplied payload for another bill does not leave the STORED BYTES\' amount and reference live beside its creditor', () => {
  const t = setup();
  // The stored document carries a QR-bill of one creditor in its text layer; the intake reads it (`qr`).
  const pdf = Buffer.from(bill({ name: 'Falsche Firma AG', amount: '4321.00', seed: 'BYTES1' }), 'utf8').toString('base64');
  const intake = captureIntake(t.ctx, { contentBase64: pdf, mime: 'application/pdf', filename: 'rechnung.pdf', idempotencyKey: 'in' });
  assert.equal(intake.ok, true, JSON.stringify(intake));
  const captureId = intake.captureId;
  const before = Object.fromEntries(liveFields(t.ctx, captureId).map((f) => [f.key, f]));
  assert.equal(before.amount?.provenance, 'qr', 'the text-layer pass proposed the stored bill\'s amount');

  // The reviewer scans the QR code on the paper in hand: ANOTHER creditor, an open amount, no reference.
  // By supplying it, the operator asserts this capture is that bill.
  const supplied = captureExtract(t.ctx, {
    captureId,
    source: 'operator',
    qrPayload: bill({ name: 'Richtige Firma GmbH', amount: '', tp: 'NON' }),
    idempotencyKey: 'op',
  });
  assert.equal(supplied.ok, true, JSON.stringify(supplied));
  const f = Object.fromEntries(liveFields(t.ctx, captureId).map((x) => [x.key, x]));
  assert.equal(f.vendor_name.value, 'Richtige Firma GmbH');
  assert.equal(f.reference_type.value, 'NON');
  // A whole-bill rule that stops at earlier SUPPLIED payloads still proposes a bill no QR code states:
  // the second creditor with the first bill's CHF 4'321.00 and its SCOR reference.
  assert.equal(
    f.amount,
    undefined,
    `the capture proposes ${JSON.stringify(f.amount?.value)} (${f.amount?.provenance}) for ${f.vendor_name.value}, whose bill leaves the amount open`,
  );
  assert.equal(f.reference, undefined, `the capture proposes reference ${f.reference?.value} (${f.reference?.provenance}) beside reference_type NON`);
});
