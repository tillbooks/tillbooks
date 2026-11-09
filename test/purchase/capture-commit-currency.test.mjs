/**
 * A31 commit carries the captured CURRENCY into the draft (critic R1-H2, joint G04/A31 round 1).
 *
 * A EUR QR-bill decodes to `amount: { minor, currency: 'EUR' }`; before the fix the commit read only
 * the minor units and the target defaulted to the base currency, so EUR 100.00 became CHF 100.00. Both
 * commit targets are covered, each in CHF and in EUR: the vendor bill (A17) keeps the transaction
 * currency and leaves §H-FX to its post, the expense line (E02) converts once at upsert, and a foreign
 * line with no resolvable rate is refused whole rather than relabelled.
 *
 * Synthetic payloads only: SIX's published sample IBAN (CH93 0076 2011 6238 5295 7) and invented
 * creditors. Nothing is derived from a real bill.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { captureIntake, captureExtract, captureCommit, getCapture, getVendorBill } from '../../dist/core/purchase/index.js';
import { createContact } from '../../dist/core/sales/index.js';
import { buildScorReference } from '../../dist/core/sales/qrbill.js';
import { setup, seedRate } from './support.mjs';
import { addEmployee } from '../hr/support.mjs';

function bill({ name = 'Beispiel Druckerei GmbH', amount = '100.00', ccy = 'CHF' } = {}) {
  return [
    'SPC', '0200', '1', 'CH9300762011623852957',
    'S', name, 'Seeweg', '12', '6000', 'Luzern', 'CH',
    '', '', '', '', '', '', '',
    amount, ccy,
    '', '', '', '', '', '', '',
    'SCOR', buildScorReference('CUR2026'), '', 'EPD',
  ].join('\n');
}

const RASTER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 3, 5, 7, 9, 11, 13, 15]).toString('base64');

function capturedBill(t, ccy, key = 'k') {
  const intake = captureIntake(t.ctx, { contentBase64: RASTER, mime: 'image/png', filename: 'beleg.png', idempotencyKey: `in-${key}` });
  assert.equal(intake.ok, true, JSON.stringify(intake));
  const x = captureExtract(t.ctx, { captureId: intake.captureId, source: 'operator', qrPayload: bill({ ccy }), idempotencyKey: `x-${key}` });
  assert.equal(x.ok, true, JSON.stringify(x));
  return intake.captureId;
}

function vendor(t) {
  const v = createContact(t.ctx, { partyRole: 'vendor', name: 'Beispiel Druckerei GmbH', idempotencyKey: 'v' });
  assert.equal(v.ok, true, JSON.stringify(v));
  return v.contact.id;
}

const status = (t, captureId) => getCapture(t.ctx, { captureId }).capture.status;
const lines = (t) => t.store.db.prepare('SELECT amount_minor, currency, amount_base_minor, fx_rate FROM expense_line WHERE workspace_id = ?').all(t.workspaceId);

for (const ccy of ['CHF', 'EUR']) {
  test(`R1-H2 vendor_bill: a ${ccy} QR-bill commits as a ${ccy} draft of the same minor units`, () => {
    const t = setup();
    const vendorId = vendor(t);
    const captureId = capturedBill(t, ccy);
    const commit = captureCommit(t.ctx, {
      captureId,
      target: { kind: 'vendor_bill', vendorId, billDate: '2026-07-01', expenseAccountId: t.acc('6500') },
      idempotencyKey: 'c',
    });
    assert.equal(commit.ok, true, JSON.stringify(commit));
    const vb = getVendorBill(t.ctx, { vendorBillId: commit.targetId });
    assert.equal(vb.ok, true, JSON.stringify(vb));
    assert.equal(vb.vendorBill.currency, ccy);
    assert.equal(vb.vendorBill.grossMinor, 10000);
  });
}

test('R1-H2 expense_line: a CHF receipt books CHF 100.00 with no conversion', () => {
  const t = setup();
  const { employeeId } = addEmployee(t.ctx);
  const captureId = capturedBill(t, 'CHF');
  const commit = captureCommit(t.ctx, { captureId, target: { kind: 'expense_line', employeeId, category: 'other', expenseDate: '2026-07-01' }, idempotencyKey: 'c' });
  assert.equal(commit.ok, true, JSON.stringify(commit));
  assert.deepEqual(lines(t), [{ amount_minor: 10000, currency: 'CHF', amount_base_minor: 10000, fx_rate: null }]);
});

test('R1-H2 expense_line: a EUR receipt stays EUR 100.00 and converts ONCE at the rate of its date', () => {
  const t = setup();
  seedRate(t.ctx, { currency: 'EUR', rate: '0.95', asOf: '2026-07-01' });
  const { employeeId } = addEmployee(t.ctx);
  const captureId = capturedBill(t, 'EUR');
  const commit = captureCommit(t.ctx, { captureId, target: { kind: 'expense_line', employeeId, category: 'other', expenseDate: '2026-07-01' }, idempotencyKey: 'c' });
  assert.equal(commit.ok, true, JSON.stringify(commit));
  const [line] = lines(t);
  assert.equal(line.currency, 'EUR');
  assert.equal(line.amount_minor, 10000);
  assert.equal(line.amount_base_minor, 9500, 'EUR 100.00 at 0.95 is CHF 95.00, never CHF 100.00');
});

test('R1-H2 expense_line: a EUR receipt with no resolvable rate is refused whole, never booked as CHF', () => {
  const t = setup();
  const { employeeId } = addEmployee(t.ctx);
  const captureId = capturedBill(t, 'EUR');
  const commit = captureCommit(t.ctx, { captureId, target: { kind: 'expense_line', employeeId, category: 'other', expenseDate: '2026-07-01' }, idempotencyKey: 'c' });
  assert.equal(commit.ok, false, `a EUR receipt with no rate committed: ${JSON.stringify(commit)}`);
  assert.deepEqual(lines(t), [], 'a refused commit left an expense line behind');
  assert.equal(status(t, captureId), 'needs_review');
});

test('R1-H2 a correction whose amount currency disagrees with the read currency is refused (currency_conflict), nothing written', () => {
  const t = setup();
  const vendorId = vendor(t);
  const captureId = capturedBill(t, 'EUR');
  const commit = captureCommit(t.ctx, {
    captureId,
    target: { kind: 'vendor_bill', vendorId, billDate: '2026-07-01', expenseAccountId: t.acc('6500') },
    corrections: [{ key: 'amount', value: { minor: 10000, currency: 'CHF' } }],
    idempotencyKey: 'c',
  });
  assert.equal(commit.ok, false);
  assert.equal(commit.error, 'currency_conflict', JSON.stringify(commit));
  assert.equal(t.store.db.prepare('SELECT COUNT(*) AS n FROM vendor_bill WHERE workspace_id = ?').get(t.workspaceId).n, 0);
  assert.equal(status(t, captureId), 'needs_review');
});

test('R1-H2 a bare { minor } correction takes the capture\'s read currency, not the base currency', () => {
  const t = setup();
  const vendorId = vendor(t);
  const captureId = capturedBill(t, 'EUR');
  const commit = captureCommit(t.ctx, {
    captureId,
    target: { kind: 'vendor_bill', vendorId, billDate: '2026-07-01', expenseAccountId: t.acc('6500') },
    corrections: [{ key: 'amount', value: { minor: 12000 } }],
    idempotencyKey: 'c',
  });
  assert.equal(commit.ok, true, JSON.stringify(commit));
  const vb = getVendorBill(t.ctx, { vendorBillId: commit.targetId });
  assert.equal(vb.vendorBill.currency, 'EUR');
  assert.equal(vb.vendorBill.grossMinor, 12000);
});
