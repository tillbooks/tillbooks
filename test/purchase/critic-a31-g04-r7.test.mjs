/**
 * Critic probes, A31 bill identity (`qrbill/identity.ts`), round 7 (non-author critic, 01.10.2026),
 * against `claude/g04-restore-chokepoint` cc808f05. The report is
 * `docs/critique/g04-a31-restore-qr-critic-r7.md`. Synthetic payloads only (SIX's published sample
 * IBAN, invented creditors).
 *
 * R7-L1 is LOW (the round-7 verdict is PASS). FIXED: the identity (v2) carries the unstructured message
 * and the Swico billing information, the probe's `todo` is dropped and it must pass.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { captureIntake, captureExtract, getCapture } from '../../dist/core/purchase/index.js';
import { billIdentity } from '../../dist/core/purchase/qrbill/identity.js';
import { setup } from './support.mjs';

/** A plain-IBAN bill WITHOUT a reference (NON), as small creditors send them: rent, memberships. */
function rent(month, invoiceNo) {
  return [
    'SPC', '0200', '1', 'CH9300762011623852957',
    'S', 'Beispiel Liegenschaften GmbH', 'Seeweg', '12', '6000', 'Luzern', 'CH',
    '', '', '', '', '', '', '',
    '1500.00', 'CHF',
    '', '', '', '', '', '', '',
    'NON', '', `Miete ${month} 2026`, 'EPD', `//S1/10/${invoiceNo}/11/261001`,
  ].join('\n');
}

const RASTER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7, 7, 7]).toString('base64');
const live = (t, captureId) => Object.fromEntries(getCapture(t.ctx, { captureId }).fields.filter((f) => !f.superseded).map((f) => [f.key, f]));

// Fixed (R7-L1): the critic's check asserted the limit; with the message and the billing information in
// the identity (v2) the two months are two bills, so the check now asserts that.
test('R7 check: two monthly NON bills of one creditor are TWO identities since v2 (the stated limit is closed)', () => {
  assert.notEqual(billIdentity(rent('Oktober', 'M-2026-10')), billIdentity(rent('November', 'M-2026-11')));
});

test(
  'R7-L1 probe: a correction made for one month\'s NON bill does not carry over when the operator supplies the next month\'s bill',
  () => {
    const t = setup();
    const intake = captureIntake(t.ctx, { contentBase64: RASTER, mime: 'image/png', filename: 'miete.png', idempotencyKey: 'in' });
    assert.equal(intake.ok, true, JSON.stringify(intake));
    const captureId = intake.captureId;
    assert.equal(captureExtract(t.ctx, { captureId, source: 'operator', qrPayload: rent('Oktober', 'M-2026-10'), idempotencyKey: 'okt' }).ok, true);
    // October only: a rent reduction agreed for that month.
    assert.equal(
      captureExtract(t.ctx, { captureId, source: 'operator', fields: [{ key: 'amount', value: { minor: 120000, currency: 'CHF' } }], idempotencyKey: 'fix' }).ok,
      true,
    );
    // The November paper was the one meant for this capture.
    assert.equal(captureExtract(t.ctx, { captureId, source: 'operator', qrPayload: rent('November', 'M-2026-11'), idempotencyKey: 'nov' }).ok, true);
    const f = live(t, captureId);
    assert.equal(f.payment_message.value, 'Miete November 2026', 'the November bill took the capture over');
    assert.deepEqual(
      f.amount.value,
      { minor: 150000, currency: 'CHF' },
      `October's correction ${JSON.stringify(f.amount.value)} (${f.amount.provenance}) stands beside the November bill`,
    );
  },
);
