/**
 * Critic probes, A31 bill chokepoint (`billMerge.ts`), round 4 of the joint G04/A31 review (non-author
 * critic, 01.10.2026), against `claude/g04-restore-chokepoint` d5365657. A test that FAILS there is a
 * finding; the report is `docs/critique/g04-a31-restore-qr-critic-r4.md`.
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

function bill({ name, amount, tp = 'SCOR', seed = 'DR2026', ccy = 'CHF' }) {
  return [
    'SPC', '0200', '1', 'CH9300762011623852957',
    'S', name, 'Seeweg', '12', '6000', 'Luzern', 'CH',
    '', '', '', '', '', '', '',
    amount, ccy,
    '', '', '', '', '', '', '',
    tp, tp === 'SCOR' ? buildScorReference(seed) : '', '', 'EPD',
  ].join('\n');
}

const RASTER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 4, 4, 4, 4]).toString('base64');
const rows = (t, captureId) => t.store.db.prepare('SELECT id, key, value, provenance, superseded, updated_at FROM capture_fields WHERE capture_id = ? ORDER BY rowid').all(captureId);
const live = (t, captureId) => Object.fromEntries(rows(t, captureId).filter((r) => r.superseded === 0).map((r) => [r.key, r]));

// LOW (round-4 verdict PASS), FIXED: a bill never displaces a typed operator row, and a payload that is
// the live bill's own evidence is a no-op. The critic's `todo` is dropped, so the probe must pass.
test('R4-L1 probe: re-supplying the same operator payload after an operator correction is the no-op billMerge promises, and the correction stands', () => {
  const t = setup();
  const intake = captureIntake(t.ctx, { contentBase64: RASTER, mime: 'image/png', filename: 'beleg.png', idempotencyKey: 'in' });
  assert.equal(intake.ok, true, JSON.stringify(intake));
  const captureId = intake.captureId;
  const payload = bill({ name: 'Beispiel Druckerei GmbH', amount: '1000.00' });

  assert.equal(captureExtract(t.ctx, { captureId, source: 'operator', qrPayload: payload, idempotencyKey: 'scan-1' }).ok, true);
  // The reviewer corrects the amount by hand (a 2 % Skonto agreed on the phone, say): an operator correction.
  assert.equal(
    captureExtract(t.ctx, { captureId, source: 'operator', fields: [{ key: 'amount', value: { minor: 98000, currency: 'CHF' } }], idempotencyKey: 'fix' }).ok,
    true,
  );
  assert.deepEqual(JSON.parse(live(t, captureId).amount.value), { minor: 98000, currency: 'CHF' });
  const before = rows(t, captureId);

  // The same paper is scanned again (a second click of "QR-Code lesen", a retried agent call with a new key).
  const again = captureExtract(t.ctx, { captureId, source: 'operator', qrPayload: payload, idempotencyKey: 'scan-2' });
  assert.equal(again.ok, true, JSON.stringify(again));
  const after = rows(t, captureId);
  // billMerge.ts header: "RE-RUNNING ON UNCHANGED INPUT IS A NO-OP, after any history" and "against a
  // TYPED row the per-key rules decide as always (an operator correction stands)".
  assert.deepEqual(
    JSON.parse(live(t, captureId).amount.value),
    { minor: 98000, currency: 'CHF' },
    `the re-scan reverted the operator's correction to ${live(t, captureId).amount.value}`,
  );
  assert.equal(after.length, before.length, `the re-scan wrote ${after.length - before.length} new row(s)`);
});

test('R4 check: a payload that LOSES never moves the vendor match, and the winning bill\'s match commits to the right vendor', () => {
  const t = setup();
  const a = createContact(t.ctx, { partyRole: 'vendor', name: 'Erste Firma AG', vatNumber: 'CHE-102.673.386 MWST', idempotencyKey: 'a' });
  const b = createContact(t.ctx, { partyRole: 'vendor', name: 'Zweite Firma AG', vatNumber: 'CHE-109.322.551 MWST', idempotencyKey: 'b' });
  assert.equal(a.ok && b.ok, true);
  const withUid = (name, uid, amount) =>
    [
      'SPC', '0200', '1', 'CH9300762011623852957',
      'S', name, 'Seeweg', '12', '6000', 'Luzern', 'CH',
      '', '', '', '', '', '', '',
      amount, 'CHF',
      '', '', '', '', '', '', '',
      'NON', '', '', 'EPD', `//S1/30/${uid}`,
    ].join('\n');
  const pdf = Buffer.from(withUid('Erste Firma AG', '102673386', '50.00'), 'utf8').toString('base64');
  const intake = captureIntake(t.ctx, { contentBase64: pdf, mime: 'application/pdf', filename: 'r.pdf', idempotencyKey: 'in' });
  assert.equal(intake.ok, true, JSON.stringify(intake));
  const captureId = intake.captureId;
  assert.equal(JSON.parse(live(t, captureId).vendor_contact_id.value), a.contact.id, 'the bytes\' UID matched the first vendor');
  // An agent supplies another bill naming the second vendor's UID: it loses to the bytes' read whole.
  assert.equal(captureExtract(t.ctx, { captureId, source: 'agent', qrPayload: withUid('Zweite Firma AG', '109322551', '70.00') }).ok, true);
  assert.equal(JSON.parse(live(t, captureId).vendor_contact_id.value), a.contact.id, 'a losing agent bill moved the vendor match');
  assert.deepEqual(JSON.parse(live(t, captureId).amount.value), { minor: 5000, currency: 'CHF' });
  const commit = captureCommit(t.ctx, { captureId, target: { kind: 'vendor_bill', billDate: '2026-03-01', expenseAccountId: t.acc('6500') }, idempotencyKey: 'c' });
  assert.equal(commit.ok, true, JSON.stringify(commit));
  const vb = getVendorBill(t.ctx, { vendorBillId: commit.targetId });
  assert.equal(vb.vendorBill.vendorId ?? vb.vendorBill.contactId, a.contact.id);
  assert.equal(vb.vendorBill.grossMinor, 5000);
  assert.equal(vb.vendorBill.currency, 'CHF');
});
