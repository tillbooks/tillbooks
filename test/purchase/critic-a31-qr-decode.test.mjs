/**
 * NON-AUTHOR critic, A31 §0a (the strict Swiss QR Code decoder and the supplied-payload seam).
 *
 * Each test here states a claim the branch makes (in the spec, a docstring or the MCP description)
 * and tries to break it. A test that FAILS on the author's code is a finding in
 * docs/critique/a31-qr-decode-critique.md; a test that passes is a probe that held, kept so the
 * behaviour stays pinned.
 *
 * Every payload is synthetic (invented creditor, SIX's own sample IBANs) or a published SIX sample.
 * Nothing here is derived from a real bill.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { decodeSwissQrBill } from '../../dist/core/purchase/qrbill/decode.js';
import { buildQrrReference, buildScorReference } from '../../dist/core/sales/qrbill.js';
import { captureIntake, captureExtract, getCapture } from '../../dist/core/purchase/index.js';
import { createBackup, restoreBackup } from '../../dist/core/data/portability.js';
import { makeContext } from '../../dist/core/context.js';
import { setup } from './support.mjs';

const PLAIN_IBAN = 'CH9300762011623852957';
const QR_IBAN = 'CH4431999123000889012';

function base(overrides = {}) {
  const b = [
    'SPC', '0200', '1', PLAIN_IBAN,
    'S', 'Beispiel Werkstatt AG', 'Talweg', '7', '3000', 'Bern', 'CH',
    '', '', '', '', '', '', '',
    '215.40', 'CHF',
    '', '', '', '', '', '', '',
    'SCOR', buildScorReference('W4711'), 'Rechnung 4711', 'EPD',
  ];
  for (const [i, v] of Object.entries(overrides)) b[Number(i)] = v;
  return b.join('\n');
}

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const fieldRows = (t, cap) => t.store.db.prepare('SELECT COUNT(*) AS n FROM capture_fields WHERE workspace_id = ? AND capture_id = ?').get(t.workspaceId, cap).n;
const payloadRows = (t, cap) => t.store.db.prepare('SELECT COUNT(*) AS n FROM capture_qr_payloads WHERE workspace_id = ? AND capture_id = ?').get(t.workspaceId, cap).n;

// --- 1. IG v2.3 §4.4: the "DO NOT USE FOR PAYMENT" notification QR-bill ---------------------------

test('F1 IG v2.3 §4.4: a notification QR-bill (amount 0.00, NICHT ZUR ZAHLUNG VERWENDEN) is a valid QR-bill and must not be refused', () => {
  // §4.4: "All three forms of QR-bill can be used to notify the invoice recipient. The specifications
  // for the QR-bill must still be complied with nonetheless." Table 10 prescribes Amount 0.00 and the
  // capitalised notice in "Additional information". This is the bill a creditor sends when the amount
  // is collected by LSV+/Debit Direct or eBill: exactly the kind of bill a bookkeeper captures.
  const r = decodeSwissQrBill(base({ 18: '0.00', 29: 'NICHT ZUR ZAHLUNG VERWENDEN', 27: 'NON', 28: '' }));
  assert.equal(r.ok, true, `refused a §4.4 notification bill: ${JSON.stringify(r.errors?.map((e) => e.code))}`);
  // And it must never propose a zero amount as if it were the bill's amount.
  assert.equal(r.bill.amountMinor, null);
});

// --- 2. Probes that held (kept pinned) ----------------------------------------------------------

test('probe: SIX Annex A example 1 with its trailing empty billing and AltPmt lines (Table 17) decodes', () => {
  const ex1 = [
    'SPC', '0200', '1', 'CH6431961000004421557',
    'S', 'Max Muster & Söhne', 'Musterstrasse', '123', '8000', 'Seldwyla', 'CH',
    '', '', '', '', '', '', '',
    '50.00', 'CHF',
    'S', 'Simon Muster', 'Musterstrasse', '1', '8000', 'Seldwyla', 'CH',
    'QRR', '000008207791225857421286694', 'Payment of travel', 'EPD', '', '', '',
  ].join('\r\n');
  const r = decodeSwissQrBill(ex1);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

test('probe: an element carrying an embedded CR (CR+LF document) cannot shift positions', () => {
  const p = base().split('\n').join('\r\n').replace('Beispiel Werkstatt AG', 'Beispiel\rWerkstatt AG');
  const r = decodeSwissQrBill(p);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.code === 'separator'));
});

test('probe: QRR with a plain IBAN, SCOR with a QR-IBAN, NON with a reference are all refused', () => {
  assert.ok(decodeSwissQrBill(base({ 27: 'QRR', 28: buildQrrReference('1') })).errors.some((e) => e.code === 'qrr_requires_qr_iban'));
  assert.ok(decodeSwissQrBill(base({ 3: QR_IBAN })).errors.some((e) => e.code === 'qr_iban_requires_qrr'));
  assert.ok(decodeSwissQrBill(base({ 27: 'NON' })).errors.some((e) => e.code === 'non_reference_present'));
});

test('probe: amount edge values convert exactly by string decomposition, never through a float', () => {
  assert.equal(decodeSwissQrBill(base({ 18: '0.01' })).bill.amountMinor, 1);
  assert.equal(decodeSwissQrBill(base({ 18: '0.29' })).bill.amountMinor, 29); // 0.29 * 100 = 28.999... as a float
  assert.equal(decodeSwissQrBill(base({ 18: '1.15' })).bill.amountMinor, 115); // 1.15 * 100 = 114.999... as a float
  assert.equal(decodeSwissQrBill(base({ 18: '999999999.99' })).bill.amountMinor, 99999999999);
  for (const bad of ['1000000000.00', '0.00', '-1.00', '1.5', '01.50', '1,50', '1.500', '1e3', '١.٠٠']) {
    assert.equal(decodeSwissQrBill(base({ 18: bad })).ok, false, `accepted amount ${bad}`);
  }
});

test('probe: a partial ultimate debtor, an ultimate creditor, a K address, a 3-letter country are refused', () => {
  assert.equal(decodeSwissQrBill(base({ 21: 'Nur Name' })).ok, false);
  assert.equal(decodeSwissQrBill(base({ 12: 'Jemand' })).ok, false);
  assert.equal(decodeSwissQrBill(base({ 4: 'K' })).ok, false);
  assert.equal(decodeSwissQrBill(base({ 10: 'CHE' })).ok, false);
});

test('L2 IG v2.3 §4.1.3: an Amt element that is ONLY blanks is refused, not silently read as an open amount', () => {
  // "It is not permitted to fill in the elements with blanks." Trimming padding around a value keeps
  // its meaning; trimming a blanks-only Amt changes the bill from "pay 215.40" to "pay what you like".
  const r = decodeSwissQrBill(base({ 18: '      ' }));
  assert.equal(r.ok, false, 'a blanks-only amount decoded as an open amount');
});

test('L3 Table 8 Ctry is an ISO 3166-1 code: a well-shaped but non-existent code (XX) is refused', () => {
  const r = decodeSwissQrBill(base({ 10: 'XX' }));
  assert.equal(r.ok, false, 'Ctry "XX" accepted');
});

// --- 3. Idempotency on ROWS, the unkeyed re-run -------------------------------------------------

test('F2 idempotency on ROWS: re-supplying the same agent payload on a capture whose stored bytes disagree writes NO new rows', () => {
  // The claim (spec §0a item 9, capture.ts): "supplying the same payload twice is a no-op by rule,
  // keyed or not". The author's test proves it only on an EMPTY capture. Here the stored bytes carry
  // their own SPC text (provenance qr, rank 3), and an agent supplies a payload for a different amount
  // (rank 2). The agent value LOSES and is kept as a superseded row, which is correct once. A re-run
  // with the same payload must not add another loser row and another evidence row every time.
  const t = setup();
  const stored = base({ 18: '100.00' });
  const intake = captureIntake(t.ctx, { contentBase64: b64(stored), mime: 'application/pdf', filename: 'beleg.pdf', idempotencyKey: 'doc' });
  assert.equal(intake.ok, true, JSON.stringify(intake));
  const cap = intake.captureId;

  const supplied = base({ 18: '105.00' });
  const first = captureExtract(t.ctx, { captureId: cap, source: 'agent', qrPayload: supplied, idempotencyKey: 'a1' });
  assert.equal(first.ok, true, JSON.stringify(first));
  const fieldsAfterFirst = fieldRows(t, cap);
  const payloadsAfterFirst = payloadRows(t, cap);

  for (const key of ['a2', 'a3', 'a4']) {
    const again = captureExtract(t.ctx, { captureId: cap, source: 'agent', qrPayload: supplied, idempotencyKey: key });
    assert.equal(again.ok, true);
  }
  assert.equal(fieldRows(t, cap), fieldsAfterFirst, 'every re-run added another superseded capture_fields row');
  assert.equal(payloadRows(t, cap), payloadsAfterFirst, 'every re-run added another capture_qr_payloads evidence row');
});

test('F2-baseline (pre-existing on develop): the same loser-row growth through source agent + fields', () => {
  // The root cause sits in applyField (rule 1 compares only against the LIVE row, never against an
  // identical superseded loser), which predates this branch. The branch inherits it and adds an
  // evidence row per re-run on top.
  const t = setup();
  const intake = captureIntake(t.ctx, { contentBase64: b64(base({ 18: '100.00' })), mime: 'application/pdf', filename: 'beleg.pdf', idempotencyKey: 'doc' });
  const cap = intake.captureId;
  const input = (k) => ({ captureId: cap, source: 'agent', fields: [{ key: 'amount', value: { minor: 10500, currency: 'CHF' }, confidence: 'high' }], idempotencyKey: k });
  assert.equal(captureExtract(t.ctx, input('f1')).ok, true);
  const after = fieldRows(t, cap);
  assert.equal(captureExtract(t.ctx, input('f2')).ok, true);
  assert.equal(fieldRows(t, cap), after, 'an unkeyed re-run of identical agent fields added a row');
});

test('M3 §H-TENANT on the evidence READ: a payload row in workspace B naming A\'s capture id never shows in A', () => {
  // The author's tenant test is refused at readCapture before the payload read runs, so dropping the
  // workspace filter from qrPayloadsOf survives it (mutation measured). The filter is load-bearing
  // exactly where capture ids are shared across workspaces: a G04 restore copies capture_id verbatim
  // (F3). This test bites that mutation; on the author's code it passes.
  const t = setup();
  const raster = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 5, 5, 5, 5]).toString('base64');
  const cap = captureIntake(t.ctx, { contentBase64: raster, mime: 'image/png', filename: 'r.png', idempotencyKey: 'img' }).captureId;
  t.store.db
    // (Author, F3 fix: the `field_ids` column is gone, replaced by `capture_fields.qr_payload_id`.)
    .prepare(`INSERT INTO capture_qr_payloads (id, workspace_id, capture_id, payload, sha256, source, decoder, warnings, created_by, created_at)
              VALUES ('capq_foreign', 'ws_other', ?, 'SPC', 'x', 'agent', NULL, '[]', 'user_9', '2026-01-01T00:00:00Z')`)
    .run(cap);
  const g = getCapture(t.ctx, { captureId: cap });
  assert.equal(g.ok, true);
  assert.equal(g.qrPayloads.length, 0, 'another workspace\'s evidence row is visible');
});

// --- 4. Backup and restore (G04) keep the evidence attributable --------------------------------

test('F3 a restored .tillbackup keeps the supplied-payload evidence attached to the field rows it wrote', () => {
  const dir = mkdtempSync(join(tmpdir(), 'a31-critic-'));
  try {
    const t = setup();
    const raster = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9, 9, 9]).toString('base64');
    const intake = captureIntake(t.ctx, { contentBase64: raster, mime: 'image/png', filename: 'r.png', idempotencyKey: 'img' });
    assert.equal(intake.ok, true);
    const r = captureExtract(t.ctx, { captureId: intake.captureId, source: 'operator', qrPayload: base(), idempotencyKey: 'q' });
    assert.equal(r.ok, true, JSON.stringify(r));

    const deps = { store: t.store, clock: t.clock, ids: t.ids, actor: 'user_1', backupDir: join(dir, 'b') };
    const backup = createBackup(deps, { workspaceId: t.workspaceId, idempotencyKey: 'bk' });
    assert.equal(backup.ok, true, JSON.stringify(backup));
    const restored = restoreBackup(deps, { source: backup.artifactRef, newWorkspaceName: 'Kopie AG', confirmed: true });
    assert.equal(restored.ok, true, JSON.stringify(restored));

    const ws = restored.workspaceId;
    const ctx = makeContext(t.store, { workspaceId: ws, actor: 'user_1', clock: t.clock, ids: t.ids });
    const capRow = t.store.db.prepare('SELECT id FROM captures WHERE workspace_id = ?').get(ws);
    assert.ok(capRow, 'the capture was not restored');
    const g = getCapture(ctx, { captureId: capRow.id });
    assert.equal(g.ok, true, JSON.stringify(g));
    assert.ok(g.fields.length > 0, 'the restored capture has no fields: capture_fields.capture_id was not remapped');
    assert.equal(g.qrPayloads.length, 1, 'the restored capture lost its payload evidence: capture_qr_payloads.capture_id was not remapped');
    const ids = new Set(g.fields.map((f) => f.id));
    for (const fid of g.qrPayloads[0].fieldIds) assert.ok(ids.has(fid), `evidence names field row ${fid}, which does not exist after restore`);
    for (const f of g.fields) assert.equal(f.qrPayloadId, g.qrPayloads[0].id, `${f.key} lost its qrPayloadId after restore`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('F3-baseline (pre-existing on develop): restoring beside the original fails for ANY capture with fields, payload or not', () => {
  // Isolates F3 from this branch: operator corrections only, no supplied payload. capture_fields
  // declares no REFERENCES on capture_id, so G04's restore (which remaps declared FKs only) copies the
  // ORIGINAL capture id, and the global partial unique (capture_id, key) WHERE superseded = 0
  // collides with the original's live rows.
  const dir = mkdtempSync(join(tmpdir(), 'a31-critic-'));
  try {
    const t = setup();
    const raster = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7, 7, 7]).toString('base64');
    const intake = captureIntake(t.ctx, { contentBase64: raster, mime: 'image/png', filename: 'r.png', idempotencyKey: 'img' });
    assert.equal(intake.ok, true);
    const r = captureExtract(t.ctx, { captureId: intake.captureId, source: 'operator', fields: [{ key: 'vendor_name', value: 'Beispiel AG' }], idempotencyKey: 'op' });
    assert.equal(r.ok, true, JSON.stringify(r));
    const deps = { store: t.store, clock: t.clock, ids: t.ids, actor: 'user_1', backupDir: join(dir, 'b') };
    const backup = createBackup(deps, { workspaceId: t.workspaceId, idempotencyKey: 'bk' });
    assert.equal(backup.ok, true, JSON.stringify(backup));
    let restored;
    assert.doesNotThrow(() => {
      restored = restoreBackup(deps, { source: backup.artifactRef, newWorkspaceName: 'Kopie AG', confirmed: true });
    });
    assert.equal(restored.ok, true, JSON.stringify(restored));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('F3-fresh: restored into an EMPTY book, the capture keeps its fields and its payload evidence', () => {
  const dir = mkdtempSync(join(tmpdir(), 'a31-critic-'));
  try {
    const t = setup();
    const raster = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 8, 8, 8, 8]).toString('base64');
    const intake = captureIntake(t.ctx, { contentBase64: raster, mime: 'image/png', filename: 'r.png', idempotencyKey: 'img' });
    const r = captureExtract(t.ctx, { captureId: intake.captureId, source: 'operator', qrPayload: base(), idempotencyKey: 'q' });
    assert.equal(r.ok, true, JSON.stringify(r));
    const deps = { store: t.store, clock: t.clock, ids: t.ids, actor: 'user_1', backupDir: join(dir, 'b') };
    const backup = createBackup(deps, { workspaceId: t.workspaceId, idempotencyKey: 'bk' });
    assert.equal(backup.ok, true);

    const fresh = setup({ location: join(dir, 'fresh.sqlite') });
    const fdeps = { store: fresh.store, clock: fresh.clock, ids: fresh.ids, actor: 'user_1', backupDir: join(dir, 'b2') };
    const restored = restoreBackup(fdeps, { source: backup.artifactRef, newWorkspaceName: 'Kopie AG', confirmed: true });
    assert.equal(restored.ok, true, JSON.stringify(restored));
    const ws = restored.workspaceId;
    const ctx = makeContext(fresh.store, { workspaceId: ws, actor: 'user_1', clock: fresh.clock, ids: fresh.ids });
    const capRow = fresh.store.db.prepare('SELECT id FROM captures WHERE workspace_id = ?').get(ws);
    const g = getCapture(ctx, { captureId: capRow.id });
    assert.equal(g.ok, true, JSON.stringify(g));
    assert.ok(g.fields.length > 0, 'restored capture has no fields: capture_fields.capture_id still names the source capture id');
    assert.equal(g.qrPayloads.length, 1, 'restored capture lost its payload evidence: capture_qr_payloads.capture_id not remapped');
    const ids = new Set(g.fields.map((f) => f.id));
    for (const fid of g.qrPayloads[0].fieldIds) assert.ok(ids.has(fid), `evidence names ${fid}, which does not exist after restore (field_ids JSON not remapped)`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
