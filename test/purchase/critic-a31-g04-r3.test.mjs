/**
 * Critic probes, A31 whole-bill rule, round 3 of the joint G04/A31 review (non-author critic,
 * 01.10.2026), against `claude/g04-restore-chokepoint` a4e0b085. A test that FAILS there is a finding;
 * the report is `docs/critique/g04-a31-restore-qr-critic-r3.md`.
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

const live = (ctx, captureId) =>
  Object.fromEntries(getCapture(ctx, { captureId }).fields.filter((f) => !f.superseded).map((f) => [f.key, f]));

test('R3-M1 probe: re-running the text-layer pass after an operator payload took the bill over does not bring the other bill back', () => {
  const t = setup();
  const pdf = Buffer.from(bill({ name: 'Falsche Firma AG', amount: '4321.00', seed: 'BYTES1' }), 'utf8').toString('base64');
  const intake = captureIntake(t.ctx, { contentBase64: pdf, mime: 'application/pdf', filename: 'rechnung.pdf', idempotencyKey: 'in' });
  assert.equal(intake.ok, true, JSON.stringify(intake));
  const captureId = intake.captureId;

  // The operator supplies the QR code on the paper in hand: another creditor, open amount, NON. Since
  // a3c13860 the payload takes the whole bill over and retires the bytes' amount and reference.
  const op = captureExtract(t.ctx, { captureId, source: 'operator', qrPayload: bill({ name: 'Richtige Firma GmbH', amount: '', tp: 'NON' }), idempotencyKey: 'op' });
  assert.equal(op.ok, true, JSON.stringify(op));
  const after = live(t.ctx, captureId);
  assert.equal(after.amount, undefined, 'the round-2 fix holds: the bytes\' amount was retired');

  // Anyone (an agent, the Studio's "read again") re-runs the deterministic pass over the stored bytes.
  const rerun = captureExtract(t.ctx, { captureId, source: 'qr', idempotencyKey: 'rerun' });
  assert.equal(rerun.ok, true, JSON.stringify(rerun));
  const f = live(t.ctx, captureId);
  assert.equal(f.vendor_name.value, 'Richtige Firma GmbH', 'the operator\'s creditor stands');
  assert.equal(
    f.amount,
    undefined,
    `the re-run resurrected ${JSON.stringify(f.amount?.value)} (${f.amount?.provenance}) beside ${f.vendor_name.value}, whose bill leaves the amount open`,
  );
  assert.equal(f.reference, undefined, `the re-run resurrected reference ${f.reference?.value} (${f.reference?.provenance}) beside reference_type ${f.reference_type?.value}`);
});
