/**
 * NON-AUTHOR critic, round 3 of A31 §0a (branch HEAD 3e3c79ed).
 *
 * Round 3 remapped every `*_id` COLUMN of the A31 tables on a G04 restore. These probes look at the
 * references that are not columns: capture field VALUES that name another row (`vendor_contact_id`,
 * `expense_account_id`), the free-text `vendor_bill.receipt_ref` named reference, and the XK exception.
 *
 * Synthetic data only: SIX's published sample UID 102673386 (IG v2.3 Annex A example 2), invented names.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { decodeSwissQrBill } from '../../dist/core/purchase/qrbill/decode.js';
import { captureIntake, captureExtract, captureCommit, getCapture, getVendorBill } from '../../dist/core/purchase/index.js';
import { createContact } from '../../dist/core/sales/index.js';
import { createBackup, restoreBackup } from '../../dist/core/data/portability.js';
import { makeContext } from '../../dist/core/context.js';
import { setup } from './support.mjs';

function spc(overrides = {}) {
  const b = [
    'SPC', '0200', '1', 'CH9300762011623852957',
    'S', 'Beispiel Werkstatt AG', 'Talweg', '7', '3000', 'Bern', 'CH',
    '', '', '', '', '', '', '',
    '120.00', 'CHF',
    '', '', '', '', '', '', '',
    'NON', '', 'Rechnung 4711', 'EPD',
    '//S1/10/4711/11/260301/30/102673386',
  ];
  for (const [i, v] of Object.entries(overrides)) b[Number(i)] = v;
  return b.join('\n');
}
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

function restoreBeside(t, dir, key = 'bk') {
  const deps = { store: t.store, clock: t.clock, ids: t.ids, actor: 'user_1', backupDir: join(dir, 'b') };
  const backup = createBackup(deps, { workspaceId: t.workspaceId, idempotencyKey: key });
  assert.equal(backup.ok, true, JSON.stringify(backup));
  const restored = restoreBackup(deps, { source: backup.artifactRef, newWorkspaceName: 'Kopie AG', confirmed: true });
  assert.equal(restored.ok, true, JSON.stringify(restored));
  return { ws: restored.workspaceId, ctx: makeContext(t.store, { workspaceId: restored.workspaceId, actor: 'user_1', clock: t.clock, ids: t.ids }) };
}

// --- R3-1: a capture field whose VALUE is another row's id --------------------------------------

test('R3-1 restore beside the original: the proposed vendor (vendor_contact_id field) names the RESTORED contact', () => {
  // The Swico /30/ UID proposes a vendor: capture_fields.value = JSON of the contact id. G04 remaps
  // columns, never JSON inside a text column, so the restored proposal still names the ORIGINAL
  // workspace's contact. capture_commit falls back to that field when the caller names no vendor.
  const dir = mkdtempSync(join(tmpdir(), 'a31-r3-'));
  try {
    const t = setup();
    const vendor = createContact(t.ctx, { partyRole: 'vendor', name: 'Beispiel Werkstatt AG', vatNumber: 'CHE-102.673.386 MWST', idempotencyKey: 'v' });
    assert.equal(vendor.ok, true, JSON.stringify(vendor));
    const intake = captureIntake(t.ctx, { contentBase64: b64(spc()), mime: 'application/pdf', filename: 'b.pdf', idempotencyKey: 'd' });
    assert.equal(intake.ok, true, JSON.stringify(intake));
    const proposed = getCapture(t.ctx, { captureId: intake.captureId }).fields.find((f) => f.key === 'vendor_contact_id' && !f.superseded);
    assert.equal(proposed?.value, vendor.contact.id, 'precondition: the Swico UID proposes the vendor');

    const r = restoreBeside(t, dir);
    const capId = t.store.db.prepare('SELECT id FROM captures WHERE workspace_id = ?').get(r.ws).id;
    const copy = getCapture(r.ctx, { captureId: capId }).fields.find((f) => f.key === 'vendor_contact_id' && !f.superseded);
    const owner = t.store.db.prepare('SELECT workspace_id FROM contact WHERE id = ?').get(copy.value)?.workspace_id;
    assert.equal(owner, r.ws, `the restored proposal names contact ${copy.value} of workspace ${owner}, not the restored one`);

    // And the commit that relies on the proposal (no vendorId given) lands on a vendor of THIS workspace.
    const account = t.store.db.prepare("SELECT id FROM account WHERE workspace_id = ? AND number = '6500'").get(r.ws).id;
    const commit = captureCommit(r.ctx, { captureId: capId, target: { kind: 'vendor_bill', expenseAccountId: account }, idempotencyKey: 'c' });
    assert.equal(commit.ok, true, `commit on the proposal after a restore: ${JSON.stringify(commit)}`);
    const bill = getVendorBill(r.ctx, { vendorBillId: commit.targetId });
    assert.equal(t.store.db.prepare('SELECT workspace_id FROM contact WHERE id = ?').get(bill.vendorBill.vendorId)?.workspace_id, r.ws);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('R3-2 restore beside the original: an operator-chosen expense account (expense_account_id field) names the RESTORED account', () => {
  const dir = mkdtempSync(join(tmpdir(), 'a31-r3-'));
  try {
    const t = setup();
    const intake = captureIntake(t.ctx, { contentBase64: b64(spc()), mime: 'application/pdf', filename: 'b.pdf', idempotencyKey: 'd' });
    const acc6500 = t.acc('6500');
    assert.equal(captureExtract(t.ctx, { captureId: intake.captureId, source: 'operator', fields: [{ key: 'expense_account_id', value: acc6500 }], idempotencyKey: 'op' }).ok, true);
    const r = restoreBeside(t, dir);
    const capId = t.store.db.prepare('SELECT id FROM captures WHERE workspace_id = ?').get(r.ws).id;
    const copy = getCapture(r.ctx, { captureId: capId }).fields.find((f) => f.key === 'expense_account_id' && !f.superseded);
    const owner = t.store.db.prepare('SELECT workspace_id FROM account WHERE id = ?').get(copy.value)?.workspace_id;
    assert.equal(owner, r.ws, `the restored field names account ${copy.value} of workspace ${owner}, not the restored one`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- R3-3: the free-text receipt_ref named reference ---------------------------------------------

test('R3-3 receipt_ref: a free-text value, or another workspace\'s file id, is copied verbatim, never remapped onto a file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'a31-r3-'));
  try {
    const t = setup();
    const vendor = createContact(t.ctx, { partyRole: 'vendor', name: 'Beispiel Werkstatt AG', idempotencyKey: 'v' });
    // Two draft bills whose receipt_ref is free text: a paper-archive note, and an id-shaped string that
    // names NO file of this workspace. Written straight to the column (A17's own attach verb may refuse
    // them; the column is what a restore copies).
    const intake = captureIntake(t.ctx, { contentBase64: b64(spc()), mime: 'application/pdf', filename: 'b.pdf', idempotencyKey: 'd' });
    const commit = captureCommit(t.ctx, { captureId: intake.captureId, target: { kind: 'vendor_bill', vendorId: vendor.contact.id, expenseAccountId: t.acc('6500') }, idempotencyKey: 'c' });
    assert.equal(commit.ok, true, JSON.stringify(commit));
    const own = t.store.db.prepare('SELECT receipt_ref FROM vendor_bill WHERE id = ?').get(commit.targetId).receipt_ref;
    t.store.db.prepare("UPDATE vendor_bill SET receipt_ref = 'Ordner 2026/17' WHERE id = ?").run(commit.targetId);
    const r1 = restoreBeside(t, dir);
    assert.deepEqual(
      t.store.db.prepare('SELECT receipt_ref FROM vendor_bill WHERE workspace_id = ?').all(r1.ws).map((x) => x.receipt_ref),
      ['Ordner 2026/17'],
    );
    // The original file id, restored as its copy's id; a string that is not a file of the snapshot stays.
    t.store.db.prepare("UPDATE vendor_bill SET receipt_ref = 'file_999' WHERE id = ?").run(commit.targetId);
    const r2 = restoreBeside(t, join(dir, 'x'), 'bk2');
    assert.deepEqual(t.store.db.prepare('SELECT receipt_ref FROM vendor_bill WHERE workspace_id = ?').all(r2.ws).map((x) => x.receipt_ref), ['file_999']);
    assert.notEqual(own, 'file_999');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- R3-4: the XK exception cannot be widened ---------------------------------------------------

test('R3-4 XK is the ONE exception: lower case, padding tricks and every other user-assigned code stay refused', () => {
  const at = (ctry, i = 10) => decodeSwissQrBill(spc({ [i]: ctry }));
  const ok = at('XK');
  assert.equal(ok.ok, true, JSON.stringify(ok.errors));
  assert.ok(ok.warnings.some((w) => w.code === 'country_user_assigned'));
  // The ultimate debtor too.
  const ud = decodeSwissQrBill(spc({ 20: 'S', 21: 'Muster Hans', 24: '10000', 25: 'Prishtina', 26: 'XK' }));
  assert.equal(ud.ok, true, JSON.stringify(ud.errors));
  // Refused: case, spacing inside, and the whole user-assigned ranges (AA, QM..QZ, XA..XZ except XK, ZZ).
  const userAssigned = ['AA', 'ZZ'];
  for (let c = 'M'.charCodeAt(0); c <= 'Z'.charCodeAt(0); c += 1) userAssigned.push(`Q${String.fromCharCode(c)}`);
  for (let c = 'A'.charCodeAt(0); c <= 'Z'.charCodeAt(0); c += 1) if (c !== 'K'.charCodeAt(0)) userAssigned.push(`X${String.fromCharCode(c)}`);
  for (const code of ['xk', 'Xk', 'xK', 'X K', 'XKX', 'KX', ...userAssigned]) {
    const r = at(code);
    assert.equal(r.ok, false, `accepted Ctry ${JSON.stringify(code)}`);
  }
  // Padding around XK is trimmed like any value (a warning), and still the one exception, not a widening.
  const padded = at(' XK ');
  assert.equal(padded.ok, true);
  assert.ok(padded.warnings.some((w) => w.code === 'blank_padding'));
});

// --- R3-5: the enumeration-free check (a chokepoint, not a list) --------------------------------

/**
 * Restore beside the original and scan every text value of the restored workspace's rows in the
 * tables A31 writes (captures, capture_fields, capture_qr_payloads, stored_file, vendor_bill) for any
 * SOURCE-workspace surrogate id, as a whole value or as a quoted JSON string. A restored row must never
 * name a source row: whatever the column is called and whether or not the id sits inside JSON.
 */
test('R3-5 no restored A31 row names a SOURCE-workspace row, by any column or inside any JSON value', () => {
  const dir = mkdtempSync(join(tmpdir(), 'a31-r3-'));
  try {
    const t = setup();
    const vendor = createContact(t.ctx, { partyRole: 'vendor', name: 'Beispiel Werkstatt AG', vatNumber: 'CHE-102.673.386 MWST', idempotencyKey: 'v' });
    assert.equal(vendor.ok, true, JSON.stringify(vendor));
    // A text-layer capture: the Swico UID proposes the vendor; the operator picks an expense account.
    const a = captureIntake(t.ctx, { contentBase64: b64(spc()), mime: 'application/pdf', filename: 'a.pdf', idempotencyKey: 'a' });
    assert.equal(captureExtract(t.ctx, { captureId: a.captureId, source: 'operator', fields: [{ key: 'expense_account_id', value: t.acc('6500') }], idempotencyKey: 'op' }).ok, true);
    // A raster capture read in from a supplied payload, then committed to a draft bill.
    const raster = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 3, 3, 3, 3]).toString('base64');
    const b = captureIntake(t.ctx, { contentBase64: raster, mime: 'image/png', filename: 'b.png', idempotencyKey: 'b' });
    assert.equal(captureExtract(t.ctx, { captureId: b.captureId, source: 'operator', qrPayload: spc({ 18: '88.20' }), idempotencyKey: 'q' }).ok, true);
    assert.equal(captureCommit(t.ctx, { captureId: b.captureId, target: { kind: 'vendor_bill', vendorId: vendor.contact.id, expenseAccountId: t.acc('6500') }, idempotencyKey: 'c' }).ok, true);

    const sourceIds = new Set();
    const tables = t.store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name);
    for (const table of tables) {
      const cols = t.store.db.pragma(`table_info("${table}")`);
      if (!cols.some((c) => c.name === 'workspace_id') || !cols.some((c) => c.name === 'id' && c.pk > 0)) continue;
      for (const r of t.store.db.prepare(`SELECT id FROM "${table}" WHERE workspace_id = ?`).all(t.workspaceId)) sourceIds.add(String(r.id));
    }
    sourceIds.add(t.workspaceId);

    const r = restoreBeside(t, dir);
    const leaks = [];
    for (const table of ['captures', 'capture_fields', 'capture_qr_payloads', 'stored_file', 'vendor_bill']) {
      const cols = t.store.db.pragma(`table_info("${table}")`).map((c) => c.name);
      for (const row of t.store.db.prepare(`SELECT * FROM "${table}" WHERE workspace_id = ?`).all(r.ws)) {
        for (const col of cols) {
          const v = row[col];
          if (typeof v !== 'string') continue;
          for (const id of sourceIds) {
            if (v === id || v.includes(JSON.stringify(id))) leaks.push(`${table}.${col}${table === 'capture_fields' ? `[${row.key}]` : ''} = ${v}`);
          }
        }
      }
    }
    assert.deepEqual(leaks, [], `restored rows still name source rows:\n${leaks.join('\n')}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- R3-6: the polymorphic target_id, expense_line branch ----------------------------------------

test('R3-6 restore beside the original: a capture committed to an EXPENSE LINE names the restored line and its receipt', async () => {
  const { addEmployee } = await import('../hr/support.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'a31-r3-'));
  try {
    const t = setup();
    const { employeeId } = addEmployee(t.ctx);
    const intake = captureIntake(t.ctx, { contentBase64: b64(spc()), mime: 'application/pdf', filename: 'spesen.pdf', idempotencyKey: 'e' });
    assert.equal(intake.ok, true, JSON.stringify(intake));
    const commit = captureCommit(t.ctx, { captureId: intake.captureId, target: { kind: 'expense_line', employeeId, category: 'other' }, idempotencyKey: 'c' });
    assert.equal(commit.ok, true, JSON.stringify(commit));
    const r = restoreBeside(t, dir);
    const row = t.store.db.prepare('SELECT target_kind, target_id, document_id FROM captures WHERE workspace_id = ?').get(r.ws);
    assert.equal(row.target_kind, 'expense_line');
    const line = t.store.db.prepare('SELECT workspace_id, receipt_document_id FROM expense_line WHERE id = ?').get(row.target_id);
    assert.equal(line?.workspace_id, r.ws, `target_id ${row.target_id} is not a line of the restored workspace`);
    assert.equal(line.receipt_document_id, row.document_id, 'the restored line\'s receipt is not the restored capture\'s document');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
