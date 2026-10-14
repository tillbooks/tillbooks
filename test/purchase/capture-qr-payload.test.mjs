/**
 * A31 §0a, a SUPPLIED QR payload through `capture_extract` (engine level): the proofs a non-author
 * critic reads for the new write path.
 *
 *  - a clean payload lands its fields with the SUPPLIER's provenance, never `qr`/`swico` (the
 *    laundering guard: those mean "read from the stored bytes");
 *  - it records ONE evidence row naming exactly the field rows it wrote;
 *  - an invalid payload writes NOTHING (rows counted, not an error string trusted);
 *  - supplying the same payload again is idempotent on ROWS, keyed or not;
 *  - the merge rules are the existing ones: an operator value is never overwritten by an agent payload;
 *  - commit afterwards produces a DRAFT from the decoded amount and posts nothing (P3);
 *  - §H-TENANT: another workspace can neither supply to nor read this capture's payloads.
 *
 * The payloads are the SIX IG v2.3 Annex A samples or synthetic ones; nothing is derived from a real bill.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  captureIntake,
  captureExtract,
  captureCommit,
  getCapture,
  getVendorBill,
} from '../../dist/core/purchase/index.js';
import { createContact } from '../../dist/core/sales/index.js';
import { buildScorReference } from '../../dist/core/sales/qrbill.js';
import { setup, secondWorkspace } from './support.mjs';

// SIX IG v2.3 Annex A, example 2 (Table 18): QR-IBAN, QRR, Swico S1 and an eBill alternative procedure.
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

/** A synthetic plain-IBAN bill with a SCOR reference and an invented creditor. */
function scorBill(amount = '88.20') {
  return [
    'SPC', '0200', '1', 'CH9300762011623852957',
    'S', 'Beispiel Druckerei GmbH', 'Seeweg', '12', '6000', 'Luzern', 'CH',
    '', '', '', '', '', '', '',
    amount, 'CHF',
    '', '', '', '', '', '', '',
    'SCOR', buildScorReference('DR2026'), '', 'EPD',
  ].join('\n');
}

/** Raster bytes with no SPC text anywhere: the case the text-layer pass can never read. */
const RASTER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8]).toString('base64');

function dropRaster(ctx, key = 'img') {
  const r = captureIntake(ctx, { contentBase64: RASTER, mime: 'image/png', filename: 'rechnung.png', idempotencyKey: key });
  assert.equal(r.ok, true, JSON.stringify(r));
  return r.captureId;
}

const fieldRows = (t, cap) => t.store.db.prepare('SELECT COUNT(*) AS n FROM capture_fields WHERE workspace_id = ? AND capture_id = ?').get(t.workspaceId, cap).n;
const payloadRows = (t, cap) => t.store.db.prepare('SELECT COUNT(*) AS n FROM capture_qr_payloads WHERE workspace_id = ? AND capture_id = ?').get(t.workspaceId, cap).n;
const live = (ctx, cap) => Object.fromEntries(getCapture(ctx, { captureId: cap }).fields.filter((f) => !f.superseded).map((f) => [f.key, f]));

test('a raster capture has an empty extraction, and an operator-supplied payload fills it with operator provenance', () => {
  const t = setup();
  const cap = dropRaster(t.ctx);
  assert.equal(fieldRows(t, cap), 0);

  const r = captureExtract(t.ctx, { captureId: cap, source: 'operator', qrPayload: SIX_EXAMPLE_2, decoder: 'phone-scanner', idempotencyKey: 'q1' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(typeof r.qrPayload.id, 'string');
  assert.deepEqual(r.qrPayload.warnings, []);

  const f = live(t.ctx, cap);
  assert.equal(f.vendor_name.value, 'Max Muster & Söhne');
  assert.deepEqual(f.vendor_address.value, { street: 'Musterstrasse', buildingNumber: '123', postalCode: '8000', town: 'Seldwyla', country: 'CH' });
  assert.equal(f.iban.value, 'CH4431999123000889012');
  assert.deepEqual(f.amount.value, { minor: 194975, currency: 'CHF' });
  assert.equal(f.reference_type.value, 'QRR');
  assert.equal(f.reference.value, '210000000003139471430009017');
  assert.equal(f.payment_message.value, 'Order from 15.10.2020');
  assert.equal(f.invoice_no.value, '1234');
  assert.equal(f.invoice_date.value, '2020-10-21');
  assert.equal(f.due_date.value, '2020-11-20');
  assert.equal(f.vat_rate.value, '7.7');

  // The laundering guard: nothing a caller supplied is stamped as read from the stored bytes.
  for (const field of Object.values(f)) {
    assert.equal(field.provenance, 'operator', `${field.key} carries ${field.provenance}`);
    assert.equal(field.confidence, 'high');
    assert.equal(field.qrPayloadId, r.qrPayload.id, `${field.key} is not attributed to the payload`);
  }

  // One evidence row, naming exactly the field rows the payload wrote.
  const g = getCapture(t.ctx, { captureId: cap });
  assert.equal(g.qrPayloads.length, 1);
  const p = g.qrPayloads[0];
  assert.equal(p.payload, SIX_EXAMPLE_2);
  assert.equal(p.source, 'operator');
  assert.equal(p.decoder, 'phone-scanner');
  assert.equal(p.sha256.length, 64);
  assert.deepEqual([...p.fieldIds].sort(), g.fields.map((x) => x.id).sort());
  // The capture's own flags still describe the stored bytes: no SPC text was found in them.
  assert.equal(g.capture.qrPresent, false);
});

test('an invalid payload writes NOTHING and names every issue', () => {
  const t = setup();
  const cap = dropRaster(t.ctx);
  const auditBefore = t.store.db.prepare('SELECT COUNT(*) AS n FROM audit_log WHERE workspace_id = ?').get(t.workspaceId).n;
  const broken = SIX_EXAMPLE_2.replace('1949.75', '1949,75').replace('\r\nS\r\nMax', '\r\nK\r\nMax');
  const r = captureExtract(t.ctx, { captureId: cap, source: 'operator', qrPayload: broken, idempotencyKey: 'bad' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'qr_payload_invalid');
  assert.deepEqual(r.errors.map((e) => e.code).sort(), ['address_type_combined', 'amount_format']);
  for (const e of r.errors) assert.equal(typeof e.line, 'number');
  assert.equal(fieldRows(t, cap), 0);
  assert.equal(payloadRows(t, cap), 0);
  assert.equal(t.store.db.prepare('SELECT COUNT(*) AS n FROM audit_log WHERE workspace_id = ?').get(t.workspaceId).n, auditBefore);

  // The refusal is not memoised: the same key with a corrected payload goes through.
  const fixed = captureExtract(t.ctx, { captureId: cap, source: 'operator', qrPayload: SIX_EXAMPLE_2, idempotencyKey: 'bad' });
  assert.equal(fixed.ok, true, JSON.stringify(fixed));
});

test('supplying the same payload again is idempotent on ROWS, keyed replay and unkeyed re-run alike', () => {
  const t = setup();
  const cap = dropRaster(t.ctx);
  const first = captureExtract(t.ctx, { captureId: cap, source: 'agent', qrPayload: scorBill(), idempotencyKey: 'same' });
  assert.equal(first.ok, true, JSON.stringify(first));
  const fields = fieldRows(t, cap);
  assert.equal(payloadRows(t, cap), 1);

  const replay = captureExtract(t.ctx, { captureId: cap, source: 'agent', qrPayload: scorBill(), idempotencyKey: 'same' });
  assert.deepEqual(replay, first);
  const rerun = captureExtract(t.ctx, { captureId: cap, source: 'agent', qrPayload: scorBill(), idempotencyKey: 'other' });
  assert.equal(rerun.ok, true);
  assert.equal(rerun.qrPayload.id, null); // nothing changed, so no second evidence row
  assert.equal(fieldRows(t, cap), fields);
  assert.equal(payloadRows(t, cap), 1);
});

test('idempotent on ROWS where the payload LOSES: stored bytes that disagree keep one loser row and one evidence row (critic F2)', () => {
  const t = setup();
  // The stored bytes carry their own SPC text for 100.00 (provenance qr); the supplied payload says 88.20.
  const stored = scorBill('100.00');
  const cap = captureIntake(t.ctx, { contentBase64: Buffer.from(stored, 'utf8').toString('base64'), mime: 'application/pdf', filename: 'b.pdf', idempotencyKey: 'doc' }).captureId;
  assert.equal(live(t.ctx, cap).amount.provenance, 'qr');
  const first = captureExtract(t.ctx, { captureId: cap, source: 'agent', qrPayload: scorBill('88.20'), idempotencyKey: 'x1' });
  assert.equal(first.ok, true, JSON.stringify(first));
  const fields = fieldRows(t, cap);
  assert.equal(payloadRows(t, cap), 1);
  // The disagreement is on record exactly once, and the read value stays the one from the bytes.
  const losers = () => t.store.db.prepare("SELECT COUNT(*) AS n FROM capture_fields WHERE workspace_id = ? AND capture_id = ? AND key = 'amount' AND superseded = 1").get(t.workspaceId, cap).n;
  assert.equal(losers(), 1);
  for (const key of ['x2', 'x3']) {
    const again = captureExtract(t.ctx, { captureId: cap, source: 'agent', qrPayload: scorBill('88.20'), idempotencyKey: key });
    assert.equal(again.ok, true);
    assert.equal(again.qrPayload.id, null);
  }
  assert.equal(fieldRows(t, cap), fields);
  assert.equal(payloadRows(t, cap), 1);
  assert.equal(losers(), 1);
  assert.deepEqual(live(t.ctx, cap).amount.value, { minor: 10000, currency: 'CHF' });
});

test('an IG §4.4 notification bill reads in with every field but the amount, and says why (critic F1)', () => {
  const t = setup();
  const cap = dropRaster(t.ctx);
  const notice = scorBill('0.00').replace(/\n\nEPD$/, '\nDO NOT USE FOR PAYMENT\nEPD');
  const r = captureExtract(t.ctx, { captureId: cap, source: 'operator', qrPayload: notice, idempotencyKey: 'n' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.qrPayload.warnings.map((w) => w.code), ['notification']);
  const f = live(t.ctx, cap);
  assert.equal(f.amount, undefined); // never a zero amount as if it were the bill's
  assert.equal(f.vendor_name.value, 'Beispiel Druckerei GmbH');
  assert.equal(f.payment_message.value, 'DO NOT USE FOR PAYMENT');
});

test('merge rules hold: an agent payload never overwrites an operator value; against an operator assertion it loses WHOLE, on record', () => {
  const t = setup();
  const cap = dropRaster(t.ctx);
  const op = captureExtract(t.ctx, { captureId: cap, source: 'operator', fields: [{ key: 'amount', value: { minor: 9000, currency: 'CHF' } }], idempotencyKey: 'op' });
  assert.equal(op.ok, true);
  // The operator's typed amount is part of the bill on the capture and speaks with operator authority
  // (owner 01.10.2026, "corrections belong to their bill"), so an agent's bill cannot take over: nothing
  // of it goes live (no creditor beside the operator's amount), and every value it states is on record.
  const r = captureExtract(t.ctx, { captureId: cap, source: 'agent', qrPayload: scorBill('88.20'), decoder: 'plugin:zxing', idempotencyKey: 'ag' });
  assert.equal(r.ok, true, JSON.stringify(r));
  const f = live(t.ctx, cap);
  assert.deepEqual(f.amount.value, { minor: 9000, currency: 'CHF' });
  assert.equal(f.amount.provenance, 'operator');
  assert.equal(f.amount.qrPayloadId, null);
  assert.equal(f.vendor_name, undefined, 'a losing agent bill puts no creditor beside the operator\'s amount');
  const p = getCapture(t.ctx, { captureId: cap }).qrPayloads[0];
  const rows = getCapture(t.ctx, { captureId: cap }).fields.filter((x) => p.fieldIds.includes(x.id));
  assert.ok(rows.length > 0 && rows.every((x) => x.superseded && x.provenance === 'agent'), 'the evidence lists exactly the agent bill\'s recorded losers');
});

test('the Swico UID in a supplied payload proposes the matching vendor, with the supplier provenance', () => {
  const t = setup();
  const vendor = createContact(t.ctx, { partyRole: 'vendor', name: 'Muster Söhne', vatNumber: 'CHE-102.673.386 MWST', idempotencyKey: 'v' });
  assert.equal(vendor.ok, true, JSON.stringify(vendor));
  const cap = dropRaster(t.ctx);
  const r = captureExtract(t.ctx, { captureId: cap, source: 'agent', qrPayload: SIX_EXAMPLE_2, idempotencyKey: 'uid' });
  assert.equal(r.ok, true, JSON.stringify(r));
  const f = live(t.ctx, cap);
  assert.equal(f.vendor_contact_id.value, vendor.contact.id);
  assert.equal(f.vendor_contact_id.provenance, 'agent');
});

test('input validation refuses before any write', () => {
  const t = setup();
  const cap = dropRaster(t.ctx);
  const cases = [
    [{ source: 'qr', qrPayload: scorBill() }, 'source'],
    [{ source: 'operator', qrPayload: scorBill(), fields: [] }, 'fields'],
    [{ source: 'operator', qrPayload: 42 }, 'qrPayload'],
    [{ source: 'operator', qrPayload: scorBill(), decoder: 'x'.repeat(65) }, 'decoder'],
    [{ source: 'operator', qrPayload: scorBill(), decoder: 'bad\nlabel' }, 'decoder'],
    [{ source: 'operator', fields: [{ key: 'vendor_name', value: 'X' }], decoder: 'phone' }, 'decoder'],
  ];
  for (const [input, field] of cases) {
    const r = captureExtract(t.ctx, { captureId: cap, idempotencyKey: `v-${field}-${Math.random()}`, ...input });
    assert.equal(r.error, 'invalid_input', JSON.stringify(input));
    assert.equal(r.field, field);
  }
  assert.equal(fieldRows(t, cap), 0);
  assert.equal(payloadRows(t, cap), 0);
});

test('commit after a supplied payload: a DRAFT bill for the decoded amount, nothing posted (P3)', () => {
  const t = setup();
  const vendor = createContact(t.ctx, { partyRole: 'vendor', name: 'Beispiel Druckerei GmbH', idempotencyKey: 'cv' });
  const cap = dropRaster(t.ctx);
  assert.equal(captureExtract(t.ctx, { captureId: cap, source: 'operator', qrPayload: scorBill('88.20'), idempotencyKey: 's' }).ok, true);
  const journals = t.store.db.prepare('SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ?').get(t.workspaceId).n;
  const commit = captureCommit(t.ctx, {
    captureId: cap,
    target: { kind: 'vendor_bill', vendorId: vendor.contact.id, billDate: '2026-03-01', expenseAccountId: t.acc('6500') },
    idempotencyKey: 'c',
  });
  assert.equal(commit.ok, true, JSON.stringify(commit));
  const bill = getVendorBill(t.ctx, { vendorBillId: commit.targetId }).vendorBill;
  assert.equal(bill.status, 'draft');
  assert.equal(bill.grossMinor, 8820);
  assert.equal(t.store.db.prepare('SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ?').get(t.workspaceId).n, journals);

  // A committed capture takes no further payload.
  const late = captureExtract(t.ctx, { captureId: cap, source: 'operator', qrPayload: scorBill('99.00'), idempotencyKey: 'late' });
  assert.equal(late.error, 'invalid_state');
});

// Adopted from the non-author critic (M3, 30.09.2026): the test below it is refused at `readCapture`
// before the evidence read runs, so it cannot see the evidence read's own workspace filter. Capture ids
// ARE shared across workspaces in one book (a restore beside the original re-mints them now, but the
// filter must not depend on that), so the read must fence evidence rows by workspace itself.
test('§H-TENANT on the evidence READ: a payload row in another workspace naming this capture id never shows', () => {
  const t = setup();
  const cap = dropRaster(t.ctx);
  assert.equal(captureExtract(t.ctx, { captureId: cap, source: 'operator', qrPayload: scorBill(), idempotencyKey: 'own' }).ok, true);
  t.store.db
    .prepare(`INSERT INTO capture_qr_payloads (id, workspace_id, capture_id, payload, sha256, source, decoder, warnings, created_by, created_at)
              VALUES ('capq_foreign', 'ws_other', ?, 'SPC', 'x', 'agent', NULL, '[]', 'user_9', '2026-01-01T00:00:00Z')`)
    .run(cap);
  const g = getCapture(t.ctx, { captureId: cap });
  assert.equal(g.ok, true);
  assert.deepEqual(g.qrPayloads.map((p) => p.id).includes('capq_foreign'), false);
  assert.equal(g.qrPayloads.length, 1);
});

test('§H-TENANT: another workspace can neither supply a payload to this capture nor read its evidence', () => {
  const t = setup();
  const cap = dropRaster(t.ctx);
  assert.equal(captureExtract(t.ctx, { captureId: cap, source: 'operator', qrPayload: scorBill(), idempotencyKey: 'a' }).ok, true);
  const b = secondWorkspace(t);
  assert.equal(captureExtract(b.ctx, { captureId: cap, source: 'operator', qrPayload: scorBill('1.00'), idempotencyKey: 'b' }).error, 'not_found');
  assert.equal(getCapture(b.ctx, { captureId: cap }).error, 'not_found');
  assert.equal(t.store.db.prepare('SELECT COUNT(*) AS n FROM capture_qr_payloads WHERE workspace_id = ?').get(b.workspaceId).n, 0);
  assert.equal(payloadRows(t, cap), 1);
});
