/**
 * NON-AUTHOR critic, round 2 of A31 §0a (after the F1 to L4 remediation, branch HEAD b69a296b).
 *
 * Round 1's tests live in critic-a31-qr-decode.test.mjs. These probe what the remediation claims
 * beyond them: that a capture "survives a G04 restore" as a whole (not only its fields and QR
 * evidence), that the §4.4 notification cannot land a 0.00 amount, and the new strictness.
 *
 * Synthetic payloads only (an invented creditor, SIX's published sample IBANs). Nothing real.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { decodeSwissQrBill } from '../../dist/core/purchase/qrbill/decode.js';
import { buildScorReference } from '../../dist/core/sales/qrbill.js';
import { captureIntake, captureExtract, captureCommit, captureDiscard, getCapture, getVendorBill } from '../../dist/core/purchase/index.js';
import { getFileContent } from '../../dist/core/files/files.js';
import { createContact } from '../../dist/core/sales/index.js';
import { createBackup, restoreBackup } from '../../dist/core/data/portability.js';
import { makeContext } from '../../dist/core/context.js';
import { setup } from './support.mjs';

function spc(overrides = {}) {
  const b = [
    'SPC', '0200', '1', 'CH9300762011623852957',
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
const NOTICE = 'NICHT ZUR ZAHLUNG VERWENDEN';

function restoreBeside(t, dir) {
  const deps = { store: t.store, clock: t.clock, ids: t.ids, actor: 'user_1', backupDir: join(dir, 'b') };
  const backup = createBackup(deps, { workspaceId: t.workspaceId, idempotencyKey: 'bk' });
  assert.equal(backup.ok, true, JSON.stringify(backup));
  const restored = restoreBackup(deps, { source: backup.artifactRef, newWorkspaceName: 'Kopie AG', confirmed: true });
  assert.equal(restored.ok, true, JSON.stringify(restored));
  const ctx = makeContext(t.store, { workspaceId: restored.workspaceId, actor: 'user_1', clock: t.clock, ids: t.ids });
  const capOf = (sha) => t.store.db.prepare('SELECT id FROM captures WHERE workspace_id = ? AND sha256 = ? ORDER BY created_at, rowid').all(restored.workspaceId, sha);
  return { ws: restored.workspaceId, ctx, capOf };
}

// --- R2-1: the rest of the captures row after a restore beside the original ----------------------

test('R2-1 restore beside the original: a restored capture names ITS OWN workspace\'s document, not the original\'s', () => {
  // captures.document_id declares no REFERENCES either (captureSchema.ts), and RESTORE_NAMED_REFS
  // names only capture_fields.capture_id. A restored capture that names the ORIGINAL workspace's file
  // cannot show its original, cannot re-run the text-layer pass, and would attach a foreign file at commit.
  const dir = mkdtempSync(join(tmpdir(), 'a31-r2-'));
  try {
    const t = setup();
    const intake = captureIntake(t.ctx, { contentBase64: b64(spc()), mime: 'application/pdf', filename: 'beleg.pdf', idempotencyKey: 'doc' });
    assert.equal(intake.ok, true, JSON.stringify(intake));
    const original = getCapture(t.ctx, { captureId: intake.captureId }).capture;
    const r = restoreBeside(t, dir);
    const [row] = r.capOf(original.sha256);
    assert.ok(row, 'capture not restored');
    const copy = getCapture(r.ctx, { captureId: row.id });
    assert.equal(copy.ok, true, JSON.stringify(copy));
    assert.notEqual(copy.documentId, original.documentId, 'the restored capture points at the ORIGINAL workspace\'s document id');
    assert.equal(getFileContent(r.ctx, { fileId: copy.documentId }).ok, true, 'the restored capture\'s document is not readable in the restored workspace');
    const rerun = captureExtract(r.ctx, { captureId: row.id, source: 'qr', idempotencyKey: 'rerun' });
    assert.equal(rerun.ok, true, `text-layer re-run in the restored workspace: ${JSON.stringify(rerun)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('R2-2 restore beside the original: a committed capture\'s target_id names the RESTORED draft bill', () => {
  const dir = mkdtempSync(join(tmpdir(), 'a31-r2-'));
  try {
    const t = setup();
    const vendor = createContact(t.ctx, { partyRole: 'vendor', name: 'Beispiel Werkstatt AG', idempotencyKey: 'v' });
    const intake = captureIntake(t.ctx, { contentBase64: b64(spc()), mime: 'application/pdf', filename: 'beleg.pdf', idempotencyKey: 'doc' });
    const commit = captureCommit(t.ctx, {
      captureId: intake.captureId,
      target: { kind: 'vendor_bill', vendorId: vendor.contact.id, billDate: '2026-03-01', expenseAccountId: t.acc('6500') },
      idempotencyKey: 'c',
    });
    assert.equal(commit.ok, true, JSON.stringify(commit));
    const original = getCapture(t.ctx, { captureId: intake.captureId }).capture;
    const r = restoreBeside(t, dir);
    const [row] = r.capOf(original.sha256);
    const copy = getCapture(r.ctx, { captureId: row.id }).capture;
    assert.notEqual(copy.targetId, original.targetId, 'the restored capture points at the ORIGINAL workspace\'s bill');
    assert.equal(getVendorBill(r.ctx, { vendorBillId: copy.targetId }).ok, true, 'the restored capture\'s target bill is not in the restored workspace');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('R2-3 restore beside the original: rescued_from_capture_id names the RESTORED discarded twin', () => {
  const dir = mkdtempSync(join(tmpdir(), 'a31-r2-'));
  try {
    const t = setup();
    const first = captureIntake(t.ctx, { contentBase64: b64(spc()), mime: 'application/pdf', filename: 'beleg.pdf', idempotencyKey: 'd1' });
    assert.equal(captureDiscard(t.ctx, { captureId: first.captureId, idempotencyKey: 'x' }).ok, true);
    const second = captureIntake(t.ctx, { contentBase64: b64(spc()), mime: 'application/pdf', filename: 'beleg.pdf', idempotencyKey: 'd2' });
    assert.equal(second.rescuedFromCaptureId, first.captureId);
    const sha = getCapture(t.ctx, { captureId: first.captureId }).capture.sha256;
    const r = restoreBeside(t, dir);
    const restoredIds = r.capOf(sha).map((x) => x.id);
    assert.equal(restoredIds.length, 2);
    const rescued = restoredIds.map((id) => getCapture(r.ctx, { captureId: id }).capture).find((c) => c.rescuedFromCaptureId !== null);
    assert.ok(restoredIds.includes(rescued.rescuedFromCaptureId), `rescued_from names ${rescued.rescuedFromCaptureId}, a capture of the ORIGINAL workspace`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- R2-4: the §4.4 notification never lands a 0.00 amount -------------------------------------

test('R2-4 F1 cannot be abused: the notification needs the exact capitalised notice, and never proposes an amount', () => {
  // Exact Table 10 notices decode, with no amount.
  for (const n of ['NICHT ZUR ZAHLUNG VERWENDEN', 'NE PAS UTILISER POUR LE PAIEMENT', 'NON UTILIZZARE PER IL PAGAMENTO', 'DO NOT USE FOR PAYMENT']) {
    const r = decodeSwissQrBill(spc({ 18: '0.00', 29: n }));
    assert.equal(r.ok, true, `${n}: ${JSON.stringify(r.errors)}`);
    assert.equal(r.bill.amountMinor, null);
    assert.equal(r.bill.notification, true);
  }
  // Anything else at 0.00 stays refused.
  for (const n of ['nicht zur zahlung verwenden', 'NICHT ZUR ZAHLUNG', 'Rechnung 4711', '', 'NICHT  ZUR ZAHLUNG VERWENDEN']) {
    assert.equal(decodeSwissQrBill(spc({ 18: '0.00', 29: n })).ok, false, `0.00 accepted with Ustrd ${JSON.stringify(n)}`);
  }
  // The notice in the billing information instead of Ustrd is not the notification form.
  assert.equal(decodeSwissQrBill(spc({ 18: '0.00', 29: '', 31: NOTICE })).ok, false);
  // A notice with a real amount is an ordinary bill with that amount.
  assert.equal(decodeSwissQrBill(spc({ 18: '10.00', 29: NOTICE })).bill.amountMinor, 1000);

  // Through the seam: no amount row is written, and an amount already on record is untouched.
  const t = setup();
  const intake = captureIntake(t.ctx, { contentBase64: b64(spc({ 18: '100.00' })), mime: 'application/pdf', filename: 'b.pdf', idempotencyKey: 'n' });
  const before = t.store.db.prepare("SELECT COUNT(*) AS n FROM capture_fields WHERE workspace_id = ? AND capture_id = ? AND key = 'amount'").get(t.workspaceId, intake.captureId).n;
  const r = captureExtract(t.ctx, { captureId: intake.captureId, source: 'agent', qrPayload: spc({ 18: '0.00', 29: NOTICE }), idempotencyKey: 'n1' });
  assert.equal(r.ok, true, JSON.stringify(r));
  const amounts = t.store.db.prepare("SELECT value FROM capture_fields WHERE workspace_id = ? AND capture_id = ? AND key = 'amount'").all(t.workspaceId, intake.captureId);
  assert.equal(amounts.length, before);
  for (const a of amounts) assert.notEqual(JSON.parse(a.value).minor, 0);
});

test('R2-5 (pre-existing text-layer path, recorded): a §4.4 notification found in the stored bytes lands NO 0.00 amount', () => {
  // §0a item 11 keeps the text-layer pass per-field lenient and unchanged. Measured here: it still
  // proposes {minor: 0} with provenance qr, the provenance §6b's auto-commit example trusts.
  const t = setup();
  const intake = captureIntake(t.ctx, { contentBase64: b64(spc({ 18: '0.00', 29: NOTICE })), mime: 'application/pdf', filename: 'n.pdf', idempotencyKey: 'n' });
  assert.equal(intake.ok, true);
  const amount = getCapture(t.ctx, { captureId: intake.captureId }).fields.find((f) => f.key === 'amount' && !f.superseded);
  assert.equal(amount, undefined, `the text-layer pass proposed ${JSON.stringify(amount?.value)} (${amount?.provenance}) for a do-not-pay notification`);
});

// --- R2-6: the new strictness, pinned ------------------------------------------------------------

test('R2-6 blank_only is an error on any element; padding around a value stays a warning; NBSP-only counts as blank', () => {
  assert.ok(decodeSwissQrBill(spc({ 29: '   ' })).errors.some((e) => e.code === 'blank_only'));
  assert.ok(decodeSwissQrBill(spc({ 13: '  ' })).errors.some((e) => e.code === 'blank_only'));
  assert.ok(decodeSwissQrBill(spc({ 29: ' ' })).errors.some((e) => e.code === 'blank_only'));
  const padded = decodeSwissQrBill(spc({ 5: ' Beispiel Werkstatt AG ' }));
  assert.equal(padded.ok, true);
  assert.ok(padded.warnings.some((w) => w.code === 'blank_padding'));
});
