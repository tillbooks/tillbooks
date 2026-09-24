/**
 * A31, document capture: the money-path-adjacent proofs a non-author critic reads.
 *
 * The capability posts nothing, but everything it proposes becomes accounting input at commit, so
 * the assertions here are the ones the spec §7/§8 asks for and the ones a misparse would break:
 *
 *  - the DETERMINISTIC parser is checked against Swico's own worked examples and A11's check digits,
 *    including the escape rule and the exact string-to-Rappen conversion (never a float);
 *  - a QR-less document yields an EMPTY extraction, never a guessed field (no-guess tripwire);
 *  - the MERGE rules are proved as a truth table, on ROW COUNTS, not on an error string;
 *  - intake and commit are idempotent on ROWS: a double intake leaves ONE capture and ONE file, a
 *    double commit leaves ONE draft;
 *  - commit produces a DRAFT and posts NOTHING (P3): no journal entry exists after a commit;
 *  - §H-TENANT: a capture is invisible and un-committable from another workspace.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  captureIntake,
  captureExtract,
  captureCommit,
  captureDiscard,
  listCaptures,
  getCapture,
  getVendorBill,
} from '../../dist/core/purchase/index.js';
import {
  parseSpcPayload,
  locateSpcPayload,
  amountToRappen,
  splitSwico,
  swicoDateToIso,
} from '../../dist/core/purchase/captureParse.js';
import {
  isValidQrrReference,
  isValidScorReference,
  buildQrrReference,
  buildScorReference,
} from '../../dist/core/sales/qrbill.js';
import { postVendorBill } from '../../dist/core/purchase/index.js';
import { createContact } from '../../dist/core/sales/index.js';
import { setup, secondWorkspace, legsOf, GROSS_MINOR, TAX_MINOR, NET_MINOR } from './support.mjs';

// --- fixtures -----------------------------------------------------------------------------------

const VALID_QRR = buildQrrReference('10201409'); // a QRR with a correct mod-10 recursive check digit

function spcPayload({ reference = VALID_QRR, refType = 'QRR', swico = '//S1/10/10201409/11/190512/30/106017086/32/8.1/40/0:30' } = {}) {
  return [
    'SPC', '0200', '1', 'CH4431999123000889012',
    'S', 'Lieferant GmbH', 'Musterstrasse', '1', '8000', 'Zürich', 'CH',
    '', '', '', '', '', '', '',
    '1081.00', 'CHF',
    '', '', '', '', '', '', '',
    refType, reference, 'Rechnung Nr 10201409', 'EPD',
    swico,
  ].join('\n');
}

function b64(s) {
  return Buffer.from(s, 'utf8').toString('base64');
}

function drop(ctx, payload = spcPayload(), key = 'k1', mime = 'application/pdf') {
  return captureIntake(ctx, { contentBase64: b64(payload), mime, filename: 'beleg.pdf', idempotencyKey: key });
}

function fieldMap(ctx, workspaceId) {
  return (captureId) => {
    const g = getCapture(ctx, { captureId });
    const map = {};
    for (const f of g.fields.filter((f) => !f.superseded)) map[f.key] = f;
    return map;
  };
}

function captureRowCount(store, workspaceId) {
  return store.db.prepare('SELECT COUNT(*) AS n FROM captures WHERE workspace_id = ?').get(workspaceId).n;
}
function fieldRowCount(store, workspaceId, captureId) {
  return store.db.prepare('SELECT COUNT(*) AS n FROM capture_fields WHERE workspace_id = ? AND capture_id = ?').get(workspaceId, captureId).n;
}
function journalCount(store, workspaceId) {
  return store.db.prepare('SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ?').get(workspaceId).n;
}

// --- the deterministic parser -------------------------------------------------------------------

test('QRR / SCOR check digits come from A11, and a failing one is flagged not dropped', () => {
  assert.equal(isValidQrrReference(VALID_QRR), true);
  // Flip the trailing check digit: the parser keeps the field but grades it medium with a note.
  const tampered = VALID_QRR.slice(0, 26) + String((Number(VALID_QRR.slice(26)) + 1) % 10);
  assert.equal(isValidQrrReference(tampered), false);
  const parsed = parseSpcPayload(spcPayload({ reference: tampered }));
  const ref = parsed.fields.find((f) => f.key === 'reference');
  assert.equal(ref.value, tampered);
  assert.equal(ref.confidence, 'medium');
  assert.ok(parsed.notes.some((n) => n.key === 'reference' && n.reason === 'reference_check_digit'));

  const scor = buildScorReference('RECHNUNG10201409');
  assert.equal(isValidScorReference(scor), true);
});

test('amount string converts to Rappen EXACTLY and rejects a non-decimal', () => {
  assert.equal(amountToRappen('1081.00'), 108100);
  assert.equal(amountToRappen('0.05'), 5);
  assert.equal(amountToRappen('999999.99'), 99999999);
  assert.equal(amountToRappen('12'), 1200);
  assert.equal(amountToRappen('1,081.00'), null); // a thousands separator is not the IG format
  assert.equal(amountToRappen('1081.000'), null); // three decimals is not the IG format
  assert.equal(amountToRappen('abc'), null);
});

test('Swico S1 parses the documented tags, honours the escape, and derives the due date', () => {
  const parsed = parseSpcPayload(spcPayload());
  const m = Object.fromEntries(parsed.fields.map((f) => [f.key, f.value]));
  assert.equal(m.invoice_no, '10201409');
  assert.equal(m.invoice_date, '2019-05-12'); // /11/ 190512 -> ISO
  assert.equal(m.vendor_uid, '106017086'); // /30/ numeric UID
  assert.equal(m.vat_rate, '8.1'); // /32/
  assert.equal(m.payment_conditions, '0:30'); // /40/
  assert.equal(m.due_date, '2019-06-11'); // /11/ + 30 days
  assert.deepEqual(m.amount, { minor: 108100, currency: 'CHF' });
  assert.equal(parsed.swicoPresent, true);
  assert.equal(parsed.swicoUid, '106017086');

  // The escape rule (Swico Beispiel 4): `/10/X.66711\/8824` is the number `X.66711/8824`.
  const esc = parseSpcPayload(spcPayload({ swico: '//S1/10/X.66711\\/8824/11/190512' }));
  assert.equal(esc.fields.find((f) => f.key === 'invoice_no').value, 'X.66711/8824');
  assert.equal(splitSwico('10/X.66711\\/8824').join('|'), '10|X.66711/8824');
  assert.equal(swicoDateToIso('190512'), '2019-05-12');
  assert.equal(swicoDateToIso('19053x'), null);
});

test('locateSpcPayload finds a payload embedded in surrounding text, and null otherwise', () => {
  assert.notEqual(locateSpcPayload('preamble text\n' + spcPayload() + '\ntrailer'), null);
  assert.equal(locateSpcPayload('a scanned receipt with no QR code at all'), null);
});

// --- intake -------------------------------------------------------------------------------------

test('intake lands qr/swico fields, needs_review, with an UTF-8 creditor name', () => {
  const t = setup();
  const res = drop(t.ctx);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.duplicate, false);
  const fm = fieldMap(t.ctx, t.workspaceId)(res.captureId);
  assert.equal(fm.vendor_name.value, 'Lieferant GmbH');
  assert.equal(fm.vendor_name.provenance, 'qr');
  assert.deepEqual(fm.amount.value, { minor: 108100, currency: 'CHF' });
  assert.equal(fm.vendor_uid.provenance, 'swico');
  const cap = getCapture(t.ctx, { captureId: res.captureId }).capture;
  assert.equal(cap.status, 'needs_review');
  assert.equal(cap.qrPresent, true);
  assert.equal(cap.swicoPresent, true);
});

test('unsupported mime is refused BEFORE any write, and a QR-less doc extracts nothing', () => {
  const t = setup();
  const bad = captureIntake(t.ctx, { contentBase64: b64('x'), mime: 'video/mp4', idempotencyKey: 'm1' });
  assert.equal(bad.ok, false);
  assert.equal(bad.error, 'unsupported_mime');
  assert.equal(captureRowCount(t.store, t.workspaceId), 0); // nothing persisted on refusal

  // no-guess tripwire: a document with no SPC payload stores zero fields.
  const res = drop(t.ctx, 'ein eingescannter Beleg ohne QR-Code', 'noqr');
  assert.equal(res.ok, true);
  assert.equal(fieldRowCount(t.store, t.workspaceId, res.captureId), 0);
  assert.equal(getCapture(t.ctx, { captureId: res.captureId }).capture.status, 'needs_review');
});

test('a byte-identical re-drop returns the existing capture and writes no second row', () => {
  const t = setup();
  const first = drop(t.ctx, spcPayload(), 'dup-a');
  const before = captureRowCount(t.store, t.workspaceId);
  const again = captureIntake(t.ctx, { contentBase64: b64(spcPayload()), mime: 'application/pdf', idempotencyKey: 'dup-b' });
  assert.equal(again.duplicate, true);
  assert.equal(again.captureId, first.captureId);
  assert.equal(captureRowCount(t.store, t.workspaceId), before);
});

test('a discard then a re-drop of the same bytes creates a fresh capture cross-linking the discarded one', () => {
  const t = setup();
  const first = drop(t.ctx, spcPayload(), 'rec-a');
  captureDiscard(t.ctx, { captureId: first.captureId, idempotencyKey: 'rec-d' });
  const again = captureIntake(t.ctx, { contentBase64: b64(spcPayload()), mime: 'application/pdf', idempotencyKey: 'rec-b' });
  assert.equal(again.ok, true);
  assert.equal(again.duplicate, false);
  assert.notEqual(again.captureId, first.captureId);
  assert.equal(getCapture(t.ctx, { captureId: again.captureId }).capture.rescuedFromCaptureId, first.captureId);
});

test('intake is idempotent on ROWS: the same key twice leaves one capture and one field set', () => {
  const t = setup();
  const a = drop(t.ctx, spcPayload(), 'idem');
  const captures1 = captureRowCount(t.store, t.workspaceId);
  const fields1 = fieldRowCount(t.store, t.workspaceId, a.captureId);
  const b = drop(t.ctx, spcPayload(), 'idem');
  assert.equal(b.captureId, a.captureId);
  assert.equal(captureRowCount(t.store, t.workspaceId), captures1);
  assert.equal(fieldRowCount(t.store, t.workspaceId, a.captureId), fields1);
});

// --- the merge rules ----------------------------------------------------------------------------

test('merge: operator supersedes qr, agent-high beats qr-medium, and a re-run is a no-op on rows', () => {
  const t = setup();
  const cap = drop(t.ctx, spcPayload(), 'mrg').captureId;
  const rowsFor = (key) => t.store.db.prepare('SELECT * FROM capture_fields WHERE workspace_id = ? AND capture_id = ? AND key = ? ORDER BY created_at').all(t.workspaceId, cap, key);

  // operator correction: the qr row is superseded, the operator row is live.
  captureExtract(t.ctx, { captureId: cap, source: 'operator', fields: [{ key: 'vendor_name', value: 'Anders GmbH' }], idempotencyKey: 'op1' });
  const vn = rowsFor('vendor_name');
  assert.equal(vn.length, 2);
  const liveVn = vn.find((r) => r.superseded === 0);
  assert.equal(liveVn.provenance, 'operator');
  assert.equal(JSON.parse(liveVn.value), 'Anders GmbH');

  // a machine source may not overwrite the operator value (rule 2).
  captureExtract(t.ctx, { captureId: cap, source: 'agent', fields: [{ key: 'vendor_name', value: 'Bot GmbH', confidence: 'high' }], idempotencyKey: 'op2' });
  assert.equal(JSON.parse(rowsFor('vendor_name').find((r) => r.superseded === 0).value), 'Anders GmbH');

  // re-running the exact same operator value is a no-op: no new row (rule 1).
  const beforeCount = fieldRowCount(t.store, t.workspaceId, cap);
  captureExtract(t.ctx, { captureId: cap, source: 'operator', fields: [{ key: 'vendor_name', value: 'Anders GmbH' }], idempotencyKey: 'op3' });
  assert.equal(fieldRowCount(t.store, t.workspaceId, cap), beforeCount);
});

test('extract refuses an unknown field key and degrades local_model honestly', () => {
  const t = setup();
  const cap = drop(t.ctx, spcPayload(), 'ext').captureId;
  const bad = captureExtract(t.ctx, { captureId: cap, source: 'agent', fields: [{ key: 'not_a_key', value: 'x', confidence: 'high' }], idempotencyKey: 'e1' });
  assert.equal(bad.ok, false);
  assert.equal(bad.error, 'unknown_field_key');
  const lm = captureExtract(t.ctx, { captureId: cap, source: 'local_model', idempotencyKey: 'e2' });
  assert.equal(lm.ok, false);
  assert.equal(lm.error, 'needs_local_runtime');
});

// --- vendor match -------------------------------------------------------------------------------

test('the Swico UID proposes the C00 contact stored as CHE-106.017.086 MWST', () => {
  const t = setup();
  const vendor = createContact(t.ctx, { partyRole: 'vendor', name: 'Lieferant GmbH', vatNumber: 'CHE-106.017.086 MWST', idempotencyKey: 'uv' });
  assert.equal(vendor.ok, true, JSON.stringify(vendor));
  const cap = drop(t.ctx, spcPayload(), 'uid').captureId;
  const fm = fieldMap(t.ctx, t.workspaceId)(cap);
  assert.equal(fm.vendor_contact_id.value, vendor.contact.id);
});

// --- commit -------------------------------------------------------------------------------------

test('commit produces a DRAFT vendor bill and posts NOTHING (P3), idempotent on the draft', () => {
  const t = setup();
  const vendor = createContact(t.ctx, { partyRole: 'vendor', name: 'Lieferant GmbH', idempotencyKey: 'cv' });
  const cap = drop(t.ctx, spcPayload(), 'cmt').captureId;
  const journalsBefore = journalCount(t.store, t.workspaceId);

  const commit = captureCommit(t.ctx, {
    captureId: cap,
    target: { kind: 'vendor_bill', vendorId: vendor.contact.id, billDate: '2026-03-01', expenseAccountId: t.acc('6500') },
    idempotencyKey: 'commit-1',
  });
  assert.equal(commit.ok, true, JSON.stringify(commit));
  assert.equal(commit.targetKind, 'vendor_bill');

  // The delegated target is a DRAFT, and nothing was posted to the ledger.
  const bill = getVendorBill(t.ctx, { vendorBillId: commit.targetId });
  assert.equal(bill.vendorBill.status, 'draft');
  assert.equal(journalCount(t.store, t.workspaceId), journalsBefore); // P3: no posting

  // The capture flipped to committed with the target recorded.
  const after = getCapture(t.ctx, { captureId: cap }).capture;
  assert.equal(after.status, 'committed');
  assert.equal(after.targetId, commit.targetId);

  // Double commit under the same key returns the same target and mints no second bill.
  const billsBefore = t.store.db.prepare('SELECT COUNT(*) AS n FROM vendor_bill WHERE workspace_id = ?').get(t.workspaceId).n;
  const again = captureCommit(t.ctx, {
    captureId: cap,
    target: { kind: 'vendor_bill', vendorId: vendor.contact.id, billDate: '2026-03-01', expenseAccountId: t.acc('6500') },
    idempotencyKey: 'commit-1',
  });
  assert.equal(again.targetId, commit.targetId);
  assert.equal(t.store.db.prepare('SELECT COUNT(*) AS n FROM vendor_bill WHERE workspace_id = ?').get(t.workspaceId).n, billsBefore);
});

// Critic F3 (2026-09-05): the Studio's one act commits and posts back to back, and the engine's
// fall-back for the code is a `tax_code` field the capture never proposes. So the code the surface
// DECIDES must reach the bill: with `target.taxCode` the posted bill carries the code and the 1170
// Vorsteuer leg; with `target.taxCode: null` it books gross with no leg, which is the stated "ohne
// MWST" and never a silent default. Drop the `target.taxCode` plumbing in `captureCommit` and the
// first case fails on `tax_code`.
test('commit with a tax code then post: the bill carries the code and the 1170 Vorsteuer leg; null books without one', () => {
  const t = setup();
  const vendor = createContact(t.ctx, { partyRole: 'vendor', name: 'Lieferant GmbH', idempotencyKey: 'cv-tax' });
  const withCode = drop(t.ctx, spcPayload(), 'tax-1').captureId;
  const commit = captureCommit(t.ctx, {
    captureId: withCode,
    target: { kind: 'vendor_bill', vendorId: vendor.contact.id, billDate: '2026-03-01', expenseAccountId: t.acc('6500'), taxCode: 'VST-M' },
    idempotencyKey: 'commit-tax-1',
  });
  assert.equal(commit.ok, true, JSON.stringify(commit));
  assert.equal(getVendorBill(t.ctx, { vendorBillId: commit.targetId }).vendorBill.taxCode, 'VST-M');
  const posted = postVendorBill(t.ctx, { vendorBillId: commit.targetId, idempotencyKey: 'post-tax-1' });
  assert.equal(posted.ok, true, JSON.stringify(posted));
  // The 1'081.00 Swico bill at 8.1%: 6500 net, 1170 the Vorsteuer, 2000 the gross. Read off
  // journal_line by account NUMBER, sharing nothing with the planner.
  assert.deepEqual(
    legsOf(t.store, t.workspaceId, posted.entryId).map((l) => ({ number: l.number, debit: l.debit, credit: l.credit })),
    [
      { number: '1170', debit: TAX_MINOR, credit: 0 },
      { number: '2000', debit: 0, credit: GROSS_MINOR },
      { number: '6500', debit: NET_MINOR, credit: 0 },
    ],
  );

  // The explicit "none": the same capture bytes under a second vendor-less path would dedupe, so a
  // second document is dropped; its bill books gross with no 1170 leg and a null code.
  const noCode = drop(t.ctx, spcPayload({ swico: '//S1/10/10201410/11/190512/30/106017086/40/0:30' }), 'tax-2').captureId;
  const commitNone = captureCommit(t.ctx, {
    captureId: noCode,
    target: { kind: 'vendor_bill', vendorId: vendor.contact.id, billDate: '2026-03-01', expenseAccountId: t.acc('6500'), taxCode: null },
    idempotencyKey: 'commit-tax-2',
  });
  assert.equal(commitNone.ok, true, JSON.stringify(commitNone));
  assert.equal(getVendorBill(t.ctx, { vendorBillId: commitNone.targetId }).vendorBill.taxCode, null);
  const postedNone = postVendorBill(t.ctx, { vendorBillId: commitNone.targetId, idempotencyKey: 'post-tax-2' });
  assert.equal(postedNone.ok, true, JSON.stringify(postedNone));
  assert.deepEqual(
    legsOf(t.store, t.workspaceId, postedNone.entryId).map((l) => ({ number: l.number, debit: l.debit, credit: l.credit })),
    [
      { number: '2000', debit: 0, credit: GROSS_MINOR },
      { number: '6500', debit: GROSS_MINOR, credit: 0 },
    ],
  );
});

test('commit refuses when the capture is not in needs_review, and a missing vendor rolls back', () => {
  const t = setup();
  const cap = drop(t.ctx, spcPayload(), 'inv').captureId;
  // no vendor supplied and no UID match: the delegated createVendorBill would refuse, and the
  // corrections/writes inside the transaction roll back (nothing memoised).
  const noVendor = captureCommit(t.ctx, { captureId: cap, target: { kind: 'vendor_bill', expenseAccountId: t.acc('6500') }, idempotencyKey: 'nv' });
  assert.equal(noVendor.ok, false);
  assert.equal(noVendor.error, 'needs_vendor');
  // the capture is untouched and re-committable
  assert.equal(getCapture(t.ctx, { captureId: cap }).capture.status, 'needs_review');

  captureDiscard(t.ctx, { captureId: cap, idempotencyKey: 'd' });
  const onDiscarded = captureCommit(t.ctx, { captureId: cap, target: { kind: 'vendor_bill' }, idempotencyKey: 'x' });
  assert.equal(onDiscarded.error, 'invalid_state');
});

// --- tenancy ------------------------------------------------------------------------------------

test('§H-TENANT: a capture is invisible and un-committable from another workspace', () => {
  const t = setup();
  const cap = drop(t.ctx, spcPayload(), 'ten').captureId;
  const b = secondWorkspace(t);
  assert.equal(getCapture(b.ctx, { captureId: cap }).error, 'not_found');
  assert.equal(captureCommit(b.ctx, { captureId: cap, target: { kind: 'vendor_bill' }, idempotencyKey: 'z' }).error, 'not_found');
  assert.equal(captureDiscard(b.ctx, { captureId: cap, idempotencyKey: 'zz' }).error, 'not_found');
  // and B's queue does not see A's capture
  assert.equal(listCaptures(b.ctx, {}).captures.length, 0);
});
