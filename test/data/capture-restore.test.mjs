/**
 * G04 restore of A31 captures (critic F3 and R2-H1, 30.09.2026): a `.tillbackup` of a workspace whose
 * Belegeingang holds every kind of capture restores, beside the original and into an empty book, with
 * every link on the capture pointing at the RESTORED rows, and the restored queue still WORKS (the
 * original can be shown, the text-layer pass re-runs, a pending capture commits).
 *
 * The defect family this pins: the A31 tables reference other rows through columns that declare no
 * foreign key, and G04 remaps declared FKs only. Round 1 found `capture_fields.capture_id` (a restore
 * beside the original rolled back; into an empty book every field was orphaned). Round 2 found the
 * capture row's own `document_id`, `rescued_from_capture_id` and `target_id` (a restored capture named
 * the ORIGINAL workspace's document, bill and discarded twin, so it could not be shown or committed).
 * Round 3 found ids INSIDE a field's JSON value. Enumeration kept missing one more form, so G04 now
 * remaps through ONE chokepoint (spec G04 §0c) and the last test here is the list-free GATE: it scans
 * every value the restore wrote for any source id, whatever the column and wherever the id sits.
 *
 * All payloads are synthetic (invented creditors, SIX's published sample IBANs).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { captureIntake, captureExtract, captureCommit, captureDiscard, getCapture, getVendorBill } from '../../dist/core/purchase/index.js';
import { getFileContent } from '../../dist/core/files/files.js';
import { createContact } from '../../dist/core/sales/index.js';
import { buildScorReference } from '../../dist/core/sales/qrbill.js';
import { createBackup, restoreBackup } from '../../dist/core/data/portability.js';
import { makeContext } from '../../dist/core/context.js';
import { setup } from '../purchase/support.mjs';
import { sourceIdsOfBackup, scanRestoredWorkspace } from './restore-gate-support.mjs';

/** A synthetic QR-bill payload for an invented creditor, varied by amount so each file's bytes differ. */
function spc(amount, message) {
  return [
    'SPC', '0200', '1', 'CH9300762011623852957',
    'S', 'Beispiel Druckerei GmbH', 'Seeweg', '12', '6000', 'Luzern', 'CH',
    '', '', '', '', '', '', '',
    amount, 'CHF',
    '', '', '', '', '', '', '',
    'SCOR', buildScorReference('DR2026'), message, 'EPD',
  ].join('\n');
}
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const raster = (n) => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, n, n, n, n]).toString('base64');
const acc = (store, ws, number) => store.db.prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?').get(ws, number).id;

/**
 * A workspace holding every kind of capture:
 *  - QR: a raster read in from a supplied payload, then one decoded value corrected by hand;
 *  - TYPED: a raster with a typed field only;
 *  - PENDING: a text-layer QR-bill waiting for review (the one committed AFTER the restore);
 *  - COMMITTED: a text-layer QR-bill committed to a draft vendor bill (target_id);
 *  - DISCARDED and RESCUED: the same bytes discarded, then taken in again (rescued_from_capture_id).
 */
function seeded() {
  const t = setup();
  const vendor = createContact(t.ctx, { partyRole: 'vendor', name: 'Beispiel Druckerei GmbH', idempotencyKey: 'v' });
  assert.equal(vendor.ok, true, JSON.stringify(vendor));
  const take = (content, mime, key) => {
    const r = captureIntake(t.ctx, { contentBase64: content, mime, filename: `${key}.bin`, idempotencyKey: key });
    assert.equal(r.ok, true, JSON.stringify(r));
    return r.captureId;
  };
  const qr = take(raster(1), 'image/png', 'qr');
  assert.equal(captureExtract(t.ctx, { captureId: qr, source: 'operator', qrPayload: spc('88.20', 'Rechnung DR2026'), decoder: 'pasted', idempotencyKey: 'q' }).ok, true);
  assert.equal(captureExtract(t.ctx, { captureId: qr, source: 'operator', fields: [{ key: 'vendor_name', value: 'Druckerei Beispiel GmbH' }], idempotencyKey: 'c' }).ok, true);
  const typed = take(raster(2), 'image/png', 'typed');
  assert.equal(captureExtract(t.ctx, { captureId: typed, source: 'operator', fields: [{ key: 'invoice_no', value: 'R-17' }], idempotencyKey: 't' }).ok, true);
  take(b64(spc('120.00', 'Offen')), 'application/pdf', 'pending');
  const committed = take(b64(spc('45.10', 'Gebucht')), 'application/pdf', 'committed');
  const commit = captureCommit(t.ctx, {
    captureId: committed,
    target: { kind: 'vendor_bill', vendorId: vendor.contact.id, billDate: '2026-03-01', expenseAccountId: t.acc('6500') },
    idempotencyKey: 'cm',
  });
  assert.equal(commit.ok, true, JSON.stringify(commit));
  const discarded = take(b64(spc('9.90', 'Doppelt')), 'application/pdf', 'discarded');
  assert.equal(captureDiscard(t.ctx, { captureId: discarded, idempotencyKey: 'x' }).ok, true);
  const rescued = captureIntake(t.ctx, { contentBase64: b64(spc('9.90', 'Doppelt')), mime: 'application/pdf', filename: 'again.pdf', idempotencyKey: 'rescued' });
  assert.equal(rescued.rescuedFromCaptureId, discarded);
  return { t };
}

function ctxFor(store, clock, ids, ws) {
  return makeContext(store, { workspaceId: ws, actor: 'user_1', clock, ids });
}

function capturesOf(ctx, store, ws) {
  const rows = store.db.prepare('SELECT id FROM captures WHERE workspace_id = ? ORDER BY created_at, rowid').all(ws);
  return rows.map((r) => getCapture(ctx, { captureId: r.id }));
}

/**
 * Everything a capture says, with the ids a restore re-mints replaced by what they RESOLVE to inside
 * the capture's own workspace: the document by its bytes, the target by its bill's amount and status,
 * the rescue link and the evidence links by position. Source and copy must compare equal.
 */
function resolved(ctx, all, g) {
  const byId = new Map(all.map((c) => [c.capture.id, c]));
  const payloadIndex = new Map(g.qrPayloads.map((p, i) => [p.id, i]));
  const doc = getFileContent(ctx, { fileId: g.documentId });
  const bill = g.capture.targetId === null ? null : getVendorBill(ctx, { vendorBillId: g.capture.targetId });
  return {
    status: g.capture.status,
    document: doc.ok ? doc.contentBase64 : `UNREADABLE ${doc.error}`,
    target:
      bill === null
        ? null
        : bill.ok
          ? {
              kind: g.capture.targetKind,
              gross: bill.vendorBill.grossMinor,
              status: bill.vendorBill.status,
              // The bill's receipt is the capture's document (A31's commit sets A17's receipt_ref to it).
              receipt: (() => {
                const r = getFileContent(ctx, { fileId: bill.vendorBill.receiptRef });
                return r.ok ? r.contentBase64 : `UNREADABLE ${r.error}`;
              })(),
            }
          : `UNRESOLVED ${bill.error}`,
    // The discarded twin, by what it IS in this workspace (its status and its document's bytes).
    rescuedFrom: (() => {
      if (g.capture.rescuedFromCaptureId === null) return null;
      const twin = byId.get(g.capture.rescuedFromCaptureId);
      if (twin === undefined) return `FOREIGN ${g.capture.rescuedFromCaptureId}`;
      const twinDoc = getFileContent(ctx, { fileId: twin.documentId });
      return { status: twin.capture.status, document: twinDoc.ok ? twinDoc.contentBase64 : 'UNREADABLE' };
    })(),
    fields: g.fields
      .map((f) => ({ key: f.key, value: f.value, provenance: f.provenance, superseded: f.superseded, payload: f.qrPayloadId === null ? null : payloadIndex.get(f.qrPayloadId) ?? 'FOREIGN' }))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    payloads: g.qrPayloads.map((p) => ({ payload: p.payload, source: p.source, decoder: p.decoder, fields: p.fieldIds.length })),
  };
}

function snapshotOf(ctx, store, ws) {
  const all = capturesOf(ctx, store, ws);
  // Ordered by content, not by insertion: a restore re-mints ids and need not keep row order.
  return all.map((g) => resolved(ctx, all, g)).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

/** The restored queue mirrors the source, every link resolves inside it, and the queue still works. */
function assertRestoredWorks(store, clock, ids, ws, source) {
  const ctx = ctxFor(store, clock, ids, ws);
  const restored = snapshotOf(ctx, store, ws);
  assert.equal(restored.length, 6);
  assert.deepEqual(restored, source);
  // Every referenced row lives in the restored workspace (not merely "resolves" through a lenient read).
  for (const row of store.db.prepare('SELECT document_id, target_id, rescued_from_capture_id FROM captures WHERE workspace_id = ?').all(ws)) {
    assert.equal(store.db.prepare('SELECT workspace_id FROM stored_file WHERE id = ?').get(row.document_id)?.workspace_id, ws);
    if (row.target_id !== null) {
      const bill = store.db.prepare('SELECT workspace_id, receipt_ref FROM vendor_bill WHERE id = ?').get(row.target_id);
      assert.equal(bill?.workspace_id, ws);
      assert.equal(store.db.prepare('SELECT workspace_id FROM stored_file WHERE id = ?').get(bill.receipt_ref)?.workspace_id, ws);
    }
    if (row.rescued_from_capture_id !== null) assert.equal(store.db.prepare('SELECT workspace_id FROM captures WHERE id = ?').get(row.rescued_from_capture_id)?.workspace_id, ws);
  }
  assert.deepEqual(store.db.pragma('foreign_key_check'), []);

  // The restored queue works: the pending text-layer capture re-reads its own original and commits.
  const pending = capturesOf(ctx, store, ws).find((g) => g.capture.status === 'needs_review' && g.capture.qrPresent && g.capture.rescuedFromCaptureId === null);
  assert.ok(pending, 'no pending text-layer capture restored');
  const rerun = captureExtract(ctx, { captureId: pending.capture.id, source: 'qr', idempotencyKey: 'after-restore' });
  assert.equal(rerun.ok, true, JSON.stringify(rerun));
  const vendorId = store.db.prepare("SELECT id FROM contact WHERE workspace_id = ? AND name = 'Beispiel Druckerei GmbH'").get(ws).id;
  const commit = captureCommit(ctx, {
    captureId: pending.capture.id,
    target: { kind: 'vendor_bill', vendorId, billDate: '2026-03-02', expenseAccountId: acc(store, ws, '6500') },
    idempotencyKey: 'commit-after-restore',
  });
  assert.equal(commit.ok, true, JSON.stringify(commit));
  const bill = getVendorBill(ctx, { vendorBillId: commit.targetId });
  assert.equal(bill.ok, true);
  assert.equal(bill.vendorBill.grossMinor, 12000);
}

test('restore BESIDE the original: every capture, link and the working queue survive, and the original is untouched', () => {
  const dir = mkdtempSync(join(tmpdir(), 'a31-restore-'));
  try {
    const { t } = seeded();
    const sourceCtx = ctxFor(t.store, t.clock, t.ids, t.workspaceId);
    const source = snapshotOf(sourceCtx, t.store, t.workspaceId);
    // The world really has each kind: evidence, a superseded decoded row, a target, a rescue link.
    assert.equal(source.filter((c) => c.payloads.length === 1).length, 1);
    assert.ok(source.some((c) => c.fields.some((f) => f.payload === 0 && f.superseded)));
    assert.ok(source.some((c) => c.target !== null && c.target.gross === 4510));
    assert.ok(source.some((c) => c.rescuedFrom !== null && c.rescuedFrom.status === 'discarded'));

    const deps = { store: t.store, clock: t.clock, ids: t.ids, actor: 'user_1', backupDir: join(dir, 'b') };
    const backup = createBackup(deps, { workspaceId: t.workspaceId, idempotencyKey: 'bk' });
    assert.equal(backup.ok, true, JSON.stringify(backup));
    const restored = restoreBackup(deps, { source: backup.artifactRef, newWorkspaceName: 'Kopie AG', confirmed: true });
    assert.equal(restored.ok, true, JSON.stringify(restored));

    assertRestoredWorks(t.store, t.clock, t.ids, restored.workspaceId, source);
    // The original is untouched by the copy beside it (read after the copy's own commit, too).
    assert.deepEqual(snapshotOf(sourceCtx, t.store, t.workspaceId), source);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('restore into an EMPTY book: every capture, link and the working queue survive', () => {
  const dir = mkdtempSync(join(tmpdir(), 'a31-restore-'));
  try {
    const { t } = seeded();
    const source = snapshotOf(ctxFor(t.store, t.clock, t.ids, t.workspaceId), t.store, t.workspaceId);
    const deps = { store: t.store, clock: t.clock, ids: t.ids, actor: 'user_1', backupDir: join(dir, 'b') };
    const backup = createBackup(deps, { workspaceId: t.workspaceId, idempotencyKey: 'bk' });
    assert.equal(backup.ok, true);

    const fresh = setup({ location: join(dir, 'fresh.sqlite') });
    const fdeps = { store: fresh.store, clock: fresh.clock, ids: fresh.ids, actor: 'user_1', backupDir: join(dir, 'b2') };
    const restored = restoreBackup(fdeps, { source: backup.artifactRef, newWorkspaceName: 'Kopie AG', confirmed: true });
    assert.equal(restored.ok, true, JSON.stringify(restored));
    assertRestoredWorks(fresh.store, fresh.clock, fresh.ids, restored.workspaceId, source);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- The gate: the outcome, not a list -----------------------------------------------------------

/**
 * Rounds 1 to 3 each added one more column to a list, and each next round found a form the list did
 * not cover. This gate asks the OUTCOME instead (spec G04 §0c item 5, probe R3-5 generalised): after a
 * restore beside the original, no TEXT value of any row the restore wrote names a SOURCE row, whole,
 * inside JSON, or as a token of a structured value. The world holds a UID-proposed vendor and an
 * operator-chosen expense account (ids INSIDE `capture_fields.value`), besides every kind of capture.
 */
test('GATE: no restored row of the capture world names a SOURCE row, by any column, inside JSON or as a token', () => {
  const dir = mkdtempSync(join(tmpdir(), 'a31-restore-'));
  try {
    const { t } = seeded();
    const qr = t.store.db.prepare("SELECT id FROM captures WHERE workspace_id = ? AND status = 'needs_review' ORDER BY rowid LIMIT 1").get(t.workspaceId).id;
    assert.equal(captureExtract(t.ctx, { captureId: qr, source: 'operator', fields: [{ key: 'expense_account_id', value: t.acc('6500') }], idempotencyKey: 'acct' }).ok, true);
    const vendor = t.store.db.prepare("SELECT id FROM contact WHERE workspace_id = ? AND name = 'Beispiel Druckerei GmbH'").get(t.workspaceId).id;
    assert.equal(captureExtract(t.ctx, { captureId: qr, source: 'operator', fields: [{ key: 'vendor_contact_id', value: vendor }], idempotencyKey: 'vend' }).ok, true);

    const deps = { store: t.store, clock: t.clock, ids: t.ids, actor: 'user_1', backupDir: join(dir, 'b') };
    const backup = createBackup(deps, { workspaceId: t.workspaceId, idempotencyKey: 'bk' });
    assert.equal(backup.ok, true, JSON.stringify(backup));
    const restored = restoreBackup(deps, { source: backup.artifactRef, newWorkspaceName: 'Kopie AG', confirmed: true });
    assert.equal(restored.ok, true, JSON.stringify(restored));

    const sourceIds = sourceIdsOfBackup(backup.artifactRef);
    // The world really carries ids inside JSON values, so the scan is not vacuous on that form.
    const idValued = t.store.db
      .prepare("SELECT key, value FROM capture_fields WHERE workspace_id = ? AND key IN ('vendor_contact_id', 'expense_account_id') AND superseded = 0")
      .all(t.workspaceId);
    assert.ok(idValued.length >= 2 && idValued.every((f) => sourceIds.has(JSON.parse(f.value))), JSON.stringify(idValued));

    assert.deepEqual(scanRestoredWorkspace(t.store.db, restored.workspaceId, sourceIds), []);
    // Every id-valued field of the copy names a row OF THE COPY.
    for (const f of t.store.db
      .prepare("SELECT key, value FROM capture_fields WHERE workspace_id = ? AND key IN ('vendor_contact_id', 'expense_account_id') AND superseded = 0")
      .all(restored.workspaceId)) {
      const table = f.key === 'vendor_contact_id' ? 'contact' : 'account';
      assert.equal(t.store.db.prepare(`SELECT workspace_id FROM "${table}" WHERE id = ?`).get(JSON.parse(f.value))?.workspace_id, restored.workspaceId, f.key);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
