/**
 * Critic probes, A31 bill chokepoint, round 5 (confirmation round on R4-L1; non-author critic,
 * 01.10.2026), against `claude/g04-restore-chokepoint` 0cfe5755. A test that FAILS there is a finding;
 * the report is `docs/critique/g04-a31-restore-qr-critic-r5.md`.
 *
 * Synthetic payloads only: SIX's published sample IBANs and invented creditors.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { captureIntake, captureExtract, getCapture } from '../../dist/core/purchase/index.js';
import { buildScorReference } from '../../dist/core/sales/qrbill.js';
import { setup } from './support.mjs';

/** A synthetic bill; `iban` defaults to the SIX plain-IBAN sample. */
function bill({ name, amount, seed, iban = 'CH9300762011623852957' }) {
  return [
    'SPC', '0200', '1', iban,
    'S', name, 'Seeweg', '12', '6000', 'Luzern', 'CH',
    '', '', '', '', '', '', '',
    amount, 'CHF',
    '', '', '', '', '', '', '',
    'SCOR', buildScorReference(seed), '', 'EPD',
  ].join('\n');
}

const RASTER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 5, 5, 5, 5]).toString('base64');
const fields = (t, captureId) => getCapture(t.ctx, { captureId }).fields;
const live = (t, captureId) => Object.fromEntries(fields(t, captureId).filter((f) => !f.superseded).map((f) => [f.key, f]));

test('R5-M1 probe: an operator CONFIRMATION of one bill\'s amount does not keep that amount live beside a different bill the operator supplies next', () => {
  const t = setup();
  const intake = captureIntake(t.ctx, { contentBase64: RASTER, mime: 'image/png', filename: 'beleg.png', idempotencyKey: 'in' });
  assert.equal(intake.ok, true, JSON.stringify(intake));
  const captureId = intake.captureId;

  // The reader picked up the wrong bill on the desk; the operator looks at it and confirms its amount
  // by typing the value the field already shows. Since 1e5e10cb that pins it as a typed operator row.
  const wrong = bill({ name: 'Falsche Firma AG', amount: '4321.00', seed: 'WRONG1' });
  assert.equal(captureExtract(t.ctx, { captureId, source: 'operator', qrPayload: wrong, idempotencyKey: 'p1' }).ok, true);
  assert.equal(
    captureExtract(t.ctx, { captureId, source: 'operator', fields: [{ key: 'amount', value: { minor: 432100, currency: 'CHF' } }], idempotencyKey: 'confirm' }).ok,
    true,
  );
  // Then the operator notices and scans the RIGHT bill: another creditor, another amount.
  const right = bill({ name: 'Richtige Firma GmbH', amount: '2000.00', seed: 'RIGHT1' });
  const r = captureExtract(t.ctx, { captureId, source: 'operator', qrPayload: right, idempotencyKey: 'p2' });
  assert.equal(r.ok, true, JSON.stringify(r));

  const f = live(t, captureId);
  assert.equal(f.vendor_name.value, 'Richtige Firma GmbH', 'the second bill took the capture over');
  const secondAmountAnywhere = fields(t, captureId).some((x) => JSON.stringify(x.value) === JSON.stringify({ minor: 200000, currency: 'CHF' }));
  // Either the second bill's amount is live, or (if a confirmation must stand) the disagreement is at
  // least ON RECORD as a field row the review drawer can show. Neither holds: the capture proposes the
  // first bill's amount for the second creditor, and the second bill's amount exists in no field row.
  assert.ok(
    JSON.stringify(f.amount?.value) === JSON.stringify({ minor: 200000, currency: 'CHF' }) || secondAmountAnywhere,
    `the capture proposes ${JSON.stringify(f.amount?.value)} (${f.amount?.provenance}) for ${f.vendor_name.value}, whose bill says CHF 2'000.00, and that amount is in no field row (live or superseded)`,
  );
});
