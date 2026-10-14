/**
 * Critic probes, A31 bill chokepoint, round 6 (owner decision 01.10.2026, "corrections belong to their
 * bill"; non-author critic), against `claude/g04-restore-chokepoint` bc3ec56f. A test that FAILS there is
 * a finding; the report is `docs/critique/g04-a31-restore-qr-critic-r6.md`.
 *
 * The decision under test: a DIFFERENT winning bill discards typed values on bill keys; the SAME bill
 * never touches a correction. The probes re-supply the SAME bill in two everyday ways and check that
 * the correction stands. Synthetic payloads only (SIX's published sample IBAN, invented creditors).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { captureIntake, captureExtract, getCapture } from '../../dist/core/purchase/index.js';
import { buildScorReference } from '../../dist/core/sales/qrbill.js';
import { setup } from './support.mjs';

function lines({ name, amount, seed }) {
  return [
    'SPC', '0200', '1', 'CH9300762011623852957',
    'S', name, 'Seeweg', '12', '6000', 'Luzern', 'CH',
    '', '', '', '', '', '', '',
    amount, 'CHF',
    '', '', '', '', '', '', '',
    'SCOR', buildScorReference(seed), '', 'EPD',
  ];
}

const RASTER = (n) => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, n, n, n, n]).toString('base64');
const live = (t, captureId) => Object.fromEntries(getCapture(t.ctx, { captureId }).fields.filter((f) => !f.superseded).map((f) => [f.key, f]));

/** A raster capture with the operator's bill P1 (CHF 1'000.00) and a hand correction of its amount to CHF 980.00. */
function corrected(t, key, p1) {
  const intake = captureIntake(t.ctx, { contentBase64: RASTER(key.length), mime: 'image/png', filename: `${key}.png`, idempotencyKey: key });
  assert.equal(intake.ok, true, JSON.stringify(intake));
  const captureId = intake.captureId;
  assert.equal(captureExtract(t.ctx, { captureId, source: 'operator', qrPayload: p1, idempotencyKey: `${key}-p1` }).ok, true);
  assert.equal(
    captureExtract(t.ctx, { captureId, source: 'operator', fields: [{ key: 'amount', value: { minor: 98000, currency: 'CHF' } }], idempotencyKey: `${key}-fix` }).ok,
    true,
  );
  assert.deepEqual(live(t, captureId).amount.value, { minor: 98000, currency: 'CHF' });
  return captureId;
}

test('R6-M1 probe (a): an agent payload that LOSES to the corrected capture does not arm the operator\'s re-scan of the SAME bill to discard the correction', () => {
  const t = setup();
  const p1 = lines({ name: 'Beispiel Druckerei GmbH', amount: '1000.00', seed: 'SAME1' }).join('\n');
  const captureId = corrected(t, 'agent-between', p1);
  // An agent supplies some other bill: it loses whole against the corrected capture (as decided), but
  // its loser rows make it the capture's LATEST evidence.
  const agent = captureExtract(t.ctx, { captureId, source: 'agent', qrPayload: lines({ name: 'Andere Firma AG', amount: '55.00', seed: 'OTHER1' }).join('\n') });
  assert.equal(agent.ok, true, JSON.stringify(agent));
  assert.deepEqual(live(t, captureId).amount.value, { minor: 98000, currency: 'CHF' }, 'the agent bill lost whole, as decided');
  // The operator scans the SAME paper P1 again.
  assert.equal(captureExtract(t.ctx, { captureId, source: 'operator', qrPayload: p1, idempotencyKey: 'again' }).ok, true);
  const f = live(t, captureId);
  assert.deepEqual(
    f.amount.value,
    { minor: 98000, currency: 'CHF' },
    `a re-scan of the SAME bill discarded the correction as "for the previous bill": amount ${JSON.stringify(f.amount.value)} (${f.amount.provenance})`,
  );
});

test('R6-M1 probe (b): the SAME QR code read with CR+LF instead of LF (another reader) does not discard the correction', () => {
  const t = setup();
  const p1 = lines({ name: 'Beispiel Druckerei GmbH', amount: '1000.00', seed: 'SAME2' });
  const captureId = corrected(t, 'crlf', p1.join('\n'));
  // IG §4.1.4 permits CR+LF or LF; a phone scanner and the Studio's image decode need not agree.
  const again = captureExtract(t.ctx, { captureId, source: 'operator', qrPayload: p1.join('\r\n'), idempotencyKey: 'crlf-again' });
  assert.equal(again.ok, true, JSON.stringify(again));
  const f = live(t, captureId);
  assert.deepEqual(
    f.amount.value,
    { minor: 98000, currency: 'CHF' },
    `the same bill, read with other line breaks, discarded the correction: amount ${JSON.stringify(f.amount.value)} (${f.amount.provenance})`,
  );
});
