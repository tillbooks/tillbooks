// A11 remediation: the critic's B-1 + M-1/M-2/M-5 regression suite (money + statutory path).
//
// Each test here was written FAILING against the pre-remediation engine and pinned green by the fix:
//  - M-5: the posted journal entry carries the real invoice number (numbering runs BEFORE the poster).
//  - B-1: QR Amt == posted 1100 receivable == subtotal + VAT, to the Rappen (gross parity).
//  - M-1: a draft has no QR-bill and no payable PDF; the reference is stable from issue onward.
//  - M-2: send transmits AT MOST once per idempotency key, and only after every guard passes.

import test from 'node:test';
import assert from 'node:assert/strict';

import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { makeContext } from '../../dist/core/context.js';
import { fixedClock } from '../../dist/core/clock.js';
import { sequenceIdGen } from '../../dist/core/ids.js';
import { createWorkspace, setCreditorProfile } from '../../dist/core/setup/index.js';
import { seedTaxCodes } from '../../dist/core/vat/index.js';
import {
  createDocument,
  issueInvoice,
  buildQrBill,
  renderInvoicePdf,
  sendInvoice,
  formatQrAmount,
  validateQrBill,
  buildQrrReference,
  buildScorReference,
  invoiceEmailSubject,
} from '../../dist/core/sales/index.js';

const AT = '2026-07-16T00:00:00.000Z';

const CREDITOR = {
  creditorName: 'Nomadik GmbH',
  address: { street: 'Bahnhofstrasse', buildingNo: '1', zip: '8000', town: 'Zürich', country: 'CH' },
  qrIban: 'CH4431999123000889012',
};

function setup(overrides = {}) {
  const clock = fixedClock(AT);
  const ids = sequenceIdGen();
  const store = new SqliteStore({ clock });
  const deps = { store, clock, ids };
  const workspaceId = createWorkspace(deps, { name: 'Nomadik GmbH' }).workspaceId;
  const ctx = makeContext(store, { workspaceId, actor: 'user_1', clock, ids, ...overrides });
  seedTaxCodes(ctx);
  store.db
    .prepare("UPDATE workspace SET vat_method = 'effektiv', vat_accounting = 'soll', mwst_no = 'CHE-102.673.386 MWST' WHERE id = ?")
    .run(workspaceId);
  setCreditorProfile(ctx, CREDITOR);
  const contactId = store.db
    .prepare(
      `INSERT INTO contact (id, workspace_id, party_role, name, address_street, address_house_no, address_zip, address_city, address_country, email, default_currency, payment_terms_days, created_at)
       VALUES ('ct_1', ?, 'customer', 'Muster AG', 'Musterstrasse', '5', '3000', 'Bern', 'CH', 'billing@muster.example', 'CHF', 30, ?) RETURNING id`,
    )
    .get(workspaceId, AT).id;
  return { ctx, store, workspaceId, contactId };
}

function draftInvoice(ctx, contactId, lines) {
  const res = createDocument(ctx, {
    type: 'invoice',
    contactId,
    currency: 'CHF',
    lines: lines ?? [{ description: 'Beratung', unitPriceMinor: 100000, taxCode: 'UST81' }],
  });
  assert.ok(res.ok, `createDocument: ${JSON.stringify(res)}`);
  return res.document.id;
}

/** The posted 1100 Debitoren debit total for a document's entry, straight off the ROWS. */
function receivableDebit(store, ctx, documentId) {
  const doc = store.db.prepare('SELECT posted_entry_id FROM document WHERE id = ?').get(documentId);
  assert.ok(doc.posted_entry_id, 'posted_entry_id set');
  const debtorAccount = store.db
    .prepare("SELECT id FROM account WHERE workspace_id = ? AND number = '1100'")
    .get(ctx.workspaceId).id;
  return store.db
    .prepare('SELECT COALESCE(SUM(base_debit_minor), 0) AS d FROM journal_line WHERE entry_id = ? AND account_id = ?')
    .get(doc.posted_entry_id, debtorAccount).d;
}

/** The `Amt` element (line 19, 0-based 18) of a Swiss QR payload. */
function qrAmt(payload) {
  return payload.split('\r\n')[18];
}

// --- B-1: QR Amt == posted receivable == subtotal + VAT (gross parity) --------------------------

test('B-1: single-rate: QR Amt == posted 1100 receivable == subtotal + VAT, to the Rappen', () => {
  const { ctx, store, contactId } = setup();
  const id = draftInvoice(ctx, contactId); // 1000.00 net @ 8.1%
  const issued = issueInvoice(ctx, { invoiceId: id, idempotencyKey: 'k-b1' });
  assert.ok(issued.ok, JSON.stringify(issued));

  const receivable = receivableDebit(store, ctx, id);
  assert.equal(receivable, 108100, 'the books post GROSS to 1100');

  // The persisted document totals are gross-aware: tax filled, total = subtotal + tax.
  const row = store.db.prepare('SELECT subtotal_minor, tax_minor, total_minor FROM document WHERE id = ?').get(id);
  assert.equal(row.subtotal_minor, 100000);
  assert.equal(row.tax_minor, 8100, 'tax_minor is persisted at issue');
  assert.equal(row.total_minor, 108100, 'total_minor is the GROSS');
  assert.equal(row.total_minor, row.subtotal_minor + row.tax_minor);
  assert.equal(row.total_minor, receivable, 'document total == posted receivable');

  // The QR-bill bills the same gross the books carry.
  const qr = buildQrBill(ctx, id);
  assert.ok(qr.ok, JSON.stringify(qr));
  assert.equal(qrAmt(qr.qr.swissQrPayload), '1081.00', 'QR Amt is the gross');
  assert.equal(qrAmt(qr.qr.swissQrPayload), formatQrAmount(receivable), 'QR Amt == posted receivable');

  // The PDF prints the same figure.
  const pdf = renderInvoicePdf(ctx, id);
  assert.ok(pdf.ok);
  const bytes = Buffer.from(pdf.pdf.base64, 'base64').toString('latin1');
  assert.match(bytes, /CHF 1081\.00/, 'the PDF total is the gross');
});

test('B-1: mixed-rate: QR Amt == posted 1100 receivable == subtotal + VAT, to the Rappen', () => {
  const { ctx, store, contactId } = setup();
  const id = draftInvoice(ctx, contactId, [
    { description: 'Normalsatz', unitPriceMinor: 100000, taxCode: 'UST81' }, // 1000.00 @ 8.1% -> 81.00
    { description: 'Beherbergung', unitPriceMinor: 50000, taxCode: 'UST38' }, // 500.00 @ 3.8% -> 19.00
    { description: 'Export', unitPriceMinor: 25000, taxCode: 'EXPORT0' }, // 250.00 @ 0%
  ]);
  const issued = issueInvoice(ctx, { invoiceId: id, idempotencyKey: 'k-b1-mixed' });
  assert.ok(issued.ok, JSON.stringify(issued));

  const receivable = receivableDebit(store, ctx, id);
  const row = store.db.prepare('SELECT subtotal_minor, tax_minor, total_minor FROM document WHERE id = ?').get(id);
  assert.equal(row.subtotal_minor, 175000);
  assert.equal(row.tax_minor, 10000, '81.00 + 19.00 + 0.00');
  assert.equal(row.total_minor, 185000);
  assert.equal(row.total_minor, row.subtotal_minor + row.tax_minor);
  assert.equal(row.total_minor, receivable, 'document total == posted receivable');

  const qr = buildQrBill(ctx, id);
  assert.ok(qr.ok, JSON.stringify(qr));
  assert.equal(qrAmt(qr.qr.swissQrPayload), formatQrAmount(receivable), 'QR Amt == posted receivable');
  assert.equal(qrAmt(qr.qr.swissQrPayload), '1850.00');
});

// --- M-1: a draft has no QR-bill; the reference is stable from issue onward ---------------------

test('M-1: a draft is REFUSED a QR-bill and a payable PDF (structured not_available)', () => {
  const { ctx, contactId } = setup();
  const id = draftInvoice(ctx, contactId);

  const qr = buildQrBill(ctx, id);
  assert.ok(!qr.ok, 'a draft must not render a fully-payable QR');
  assert.equal(qr.error, 'not_available');
  assert.equal(qr.status, 'draft');

  const pdf = renderInvoicePdf(ctx, id);
  assert.ok(!pdf.ok, 'a draft must not render a payable PDF');
  assert.equal(pdf.error, 'not_available');
});

test('M-1: reference stability: draft(refused) -> issued -> re-render gives the SAME reference', () => {
  const { ctx, contactId } = setup();
  const id = draftInvoice(ctx, contactId);
  assert.ok(!buildQrBill(ctx, id).ok, 'draft: refused, so no draft-time reference can ever differ');

  issueInvoice(ctx, { invoiceId: id, idempotencyKey: 'k-m1' });
  const first = buildQrBill(ctx, id);
  const second = buildQrBill(ctx, id);
  assert.ok(first.ok && second.ok);
  assert.equal(first.qr.reference, second.qr.reference, 'the issued reference is stable across renders');
  // The reference is seeded from the REAL number, never the internal doc id.
  assert.equal(first.qr.reference, second.qr.reference);
  assert.match(first.qr.swissQrPayload, /R-2026-0001/);
});

// --- M-2: send transmits at most once, behind every guard ---------------------------------------

test('M-2: a send retry with the same idempotency key transmits AT MOST once (relay called 1x)', () => {
  const sentBox = [];
  const relay = { send: (msg) => { sentBox.push(msg); return { ok: true }; } };
  const { ctx, store, contactId } = setup();
  ctx.emailRelay = relay;
  const id = draftInvoice(ctx, contactId);
  issueInvoice(ctx, { invoiceId: id, idempotencyKey: 'k-m2-issue' });

  const first = sendInvoice(ctx, { invoiceId: id, idempotencyKey: 'k-m2-send', confirmed: true });
  const second = sendInvoice(ctx, { invoiceId: id, idempotencyKey: 'k-m2-send', confirmed: true });
  assert.ok(first.ok, JSON.stringify(first));
  assert.ok(second.ok, 'the retry replays the first result instead of failing on the sent status');
  assert.equal(second.transmitted, true);
  assert.equal(second.sentToEmail, first.sentToEmail);
  assert.equal(sentBox.length, 1, '§H-IDEMPOTENT covers the outbound side effect: ONE transmission');
  assert.equal(store.db.prepare('SELECT status FROM document WHERE id = ?').get(id).status, 'sent');
});

test('M-2: a draft send transmits ZERO times (status legality precedes the relay)', () => {
  const sentBox = [];
  const relay = { send: (msg) => { sentBox.push(msg); return { ok: true }; } };
  const { ctx, store, contactId } = setup();
  ctx.emailRelay = relay;
  const id = draftInvoice(ctx, contactId);
  // NOT issued. confirmed:true passes the P8 gate, so only the status guard stands between the
  // draft and the wire.
  const res = sendInvoice(ctx, { invoiceId: id, idempotencyKey: 'k-m2-draft', confirmed: true });
  assert.ok(!res.ok);
  assert.equal(res.error, 'illegal_transition');
  assert.equal(sentBox.length, 0, 'the guard fired BEFORE the transmission, not after');
  assert.equal(store.db.prepare('SELECT status FROM document WHERE id = ?').get(id).status, 'draft');
});

test('M-2: a failed relay is not memoised: the retry may transmit again after the fault clears', () => {
  let fail = true;
  const sentBox = [];
  const relay = {
    send: (msg) => {
      if (fail) return { ok: false, reason: 'smtp_down' };
      sentBox.push(msg);
      return { ok: true };
    },
  };
  const { ctx, store, contactId } = setup();
  ctx.emailRelay = relay;
  const id = draftInvoice(ctx, contactId);
  issueInvoice(ctx, { invoiceId: id, idempotencyKey: 'k-m2r-issue' });

  const failed = sendInvoice(ctx, { invoiceId: id, idempotencyKey: 'k-m2r-send', confirmed: true });
  assert.equal(failed.error, 'email_send_failed');
  assert.equal(store.db.prepare('SELECT status FROM document WHERE id = ?').get(id).status, 'issued', 'a failed send leaves the status at issued');

  fail = false;
  const retried = sendInvoice(ctx, { invoiceId: id, idempotencyKey: 'k-m2r-send', confirmed: true });
  assert.ok(retried.ok, JSON.stringify(retried));
  assert.equal(sentBox.length, 1, 'exactly one successful transmission');
});

// --- m-2: validateQrBill enforces the IG per-field caps and IBAN/reference coherence ------------

const VALID_QR_INPUT = {
  iban: 'CH4431999123000889012', // QR-IBAN (IID 31999)
  creditor: { name: 'Nomadik GmbH', street: 'Bahnhofstrasse', buildingNo: '1', postalCode: '8000', town: 'Zürich', country: 'CH' },
  amountMinor: 108100,
  currency: 'CHF',
  debtor: { name: 'Muster AG', street: 'Musterstrasse', buildingNo: '5', postalCode: '3000', town: 'Bern', country: 'CH' },
  referenceType: 'QRR',
  reference: buildQrrReference('R-2026-0001'),
  unstructuredMessage: 'Rechnung R-2026-0001',
  billingInfo: null,
  ebillIdentifier: null,
};

test('m-2: validateQrBill flags IG field-length overruns (name/street 70, buildingNo/postalCode 16, town 35, Ustrd 140)', () => {
  const over = (n) => 'x'.repeat(n + 1);
  const cases = [
    [{ creditor: { ...VALID_QR_INPUT.creditor, name: over(70) } }, 'creditor.name'],
    [{ creditor: { ...VALID_QR_INPUT.creditor, street: over(70) } }, 'creditor.street'],
    [{ creditor: { ...VALID_QR_INPUT.creditor, buildingNo: over(16) } }, 'creditor.buildingNo'],
    [{ creditor: { ...VALID_QR_INPUT.creditor, postalCode: over(16) } }, 'creditor.postalCode'],
    [{ creditor: { ...VALID_QR_INPUT.creditor, town: over(35) } }, 'creditor.town'],
    [{ debtor: { ...VALID_QR_INPUT.debtor, name: over(70) } }, 'debtor.name'],
    [{ unstructuredMessage: over(140), billingInfo: null }, 'unstructuredMessage'],
  ];
  for (const [patch, field] of cases) {
    const issues = validateQrBill({ ...VALID_QR_INPUT, ...patch });
    assert.ok(issues.some((i) => i.field === field && i.reason === 'too_long'), `${field}: ${JSON.stringify(issues)}`);
  }
  assert.deepEqual(validateQrBill(VALID_QR_INPUT), [], 'the valid input stays valid');
});

test('m-2: validateQrBill flags IBAN-type vs reference-type incoherence (QRR needs a QR-IBAN and vice versa)', () => {
  const PLAIN_IBAN = 'CH9300762011623852957';
  // QRR with a plain IBAN: invalid (a QRR reference is only payable against a QR-IBAN).
  const qrrOnPlain = validateQrBill({ ...VALID_QR_INPUT, iban: PLAIN_IBAN });
  assert.ok(qrrOnPlain.some((i) => i.field === 'referenceType' && i.reason === 'qrr_requires_qr_iban'), JSON.stringify(qrrOnPlain));
  // SCOR with a QR-IBAN: invalid (a QR-IBAN mandates the QRR reference).
  const scorOnQr = validateQrBill({
    ...VALID_QR_INPUT,
    referenceType: 'SCOR',
    reference: buildScorReference('R-2026-0001'),
  });
  assert.ok(scorOnQr.some((i) => i.field === 'referenceType' && i.reason === 'qr_iban_requires_qrr'), JSON.stringify(scorOnQr));
  // The coherent pairs stay valid.
  assert.deepEqual(validateQrBill({ ...VALID_QR_INPUT, iban: PLAIN_IBAN, referenceType: 'SCOR', reference: buildScorReference('R-2026-0001') }), []);
});

// --- m-3: a zero-total invoice gets no open-amount QR -------------------------------------------

test('m-3: a zero-total issued invoice is refused a QR-bill (an amount-less QR is payable with ANY amount)', () => {
  // No engine path can ISSUE a zero-total invoice today (postEntry rejects zero/negative legs), so
  // this guard is defense-in-depth: the row is fabricated directly to pin the refusal against any
  // future path (imports, credit offsets) that lands an issued document with nothing to collect.
  const { ctx, store, workspaceId, contactId } = setup();
  const AT_DATE = AT.slice(0, 10);
  store.db
    .prepare(
      `INSERT INTO document (id, workspace_id, type, number, status, contact_id, currency, subtotal_minor, tax_minor, total_minor, issue_date, created_at)
       VALUES ('doc_zero', ?, 'invoice', 'R-2026-0099', 'issued', ?, 'CHF', 0, 0, 0, ?, ?)`,
    )
    .run(workspaceId, contactId, AT_DATE, AT);
  const qr = buildQrBill(ctx, 'doc_zero');
  assert.ok(!qr.ok, 'no QR for a zero total');
  assert.equal(qr.error, 'zero_total');
  // The plain PDF still renders (without a QR payment part), so the document stays deliverable.
  const pdf = renderInvoicePdf(ctx, 'doc_zero');
  assert.ok(pdf.ok, JSON.stringify(pdf));
  assert.equal(pdf.pdf.hasQrBill, false);
});

// --- m-4: the email subject carries the number --------------------------------------------------

test('m-4: the send subject carries the invoice number (de-CH default, en seam)', () => {
  assert.equal(invoiceEmailSubject('R-2026-0001'), 'Rechnung R-2026-0001');
  assert.equal(invoiceEmailSubject('R-2026-0001', 'en'), 'Invoice R-2026-0001');

  const sentBox = [];
  const relay = { send: (msg) => { sentBox.push(msg); return { ok: true }; } };
  const { ctx, contactId } = setup();
  ctx.emailRelay = relay;
  const id = draftInvoice(ctx, contactId);
  issueInvoice(ctx, { invoiceId: id, idempotencyKey: 'k-subj' });
  const res = sendInvoice(ctx, { invoiceId: id, idempotencyKey: 'k-subj-send', confirmed: true });
  assert.ok(res.ok, JSON.stringify(res));
  assert.equal(sentBox[0].subject, 'Rechnung R-2026-0001');
});

// --- M-5: the journal entry carries the invoice number ------------------------------------------

test('M-5: the posted journal entry description and ref carry the REAL invoice number', () => {
  const { ctx, store, contactId } = setup();
  const id = draftInvoice(ctx, contactId);
  const issued = issueInvoice(ctx, { invoiceId: id, idempotencyKey: 'k-m5' });
  assert.ok(issued.ok, JSON.stringify(issued));
  assert.equal(issued.document.number, 'R-2026-0001');

  const doc = store.db.prepare('SELECT posted_entry_id FROM document WHERE id = ?').get(id);
  const entry = store.db.prepare('SELECT ref, description FROM journal_entry WHERE id = ?').get(doc.posted_entry_id);
  assert.equal(entry.ref, 'R-2026-0001', 'journal ref carries the number');
  assert.match(entry.description, /R-2026-0001/, 'description names the number, not the raw doc id');
  assert.ok(!/doc_/.test(entry.description), 'description does not leak the internal doc id');
});

test('M-5: a failed issue (poster rejection) still consumes no number', () => {
  const { ctx, store, workspaceId, contactId } = setup();
  // A line with an unknown tax code makes the poster reject INSIDE the transaction, after the
  // number assignment was reordered ahead of it: the rollback must still leave the counter untouched.
  const id = draftInvoice(ctx, contactId, [{ description: 'kaputt', unitPriceMinor: 1000, taxCode: 'NO_SUCH_CODE' }]);
  const issued = issueInvoice(ctx, { invoiceId: id, idempotencyKey: 'k-m5-fail' });
  assert.ok(!issued.ok);
  const doc = store.db.prepare('SELECT status, number FROM document WHERE id = ?').get(id);
  assert.equal(doc.status, 'draft');
  assert.equal(doc.number, null);
  const seq = store.db
    .prepare('SELECT next_value FROM document_number_seq WHERE workspace_id = ? AND type = ?')
    .get(workspaceId, 'invoice');
  assert.ok(seq === undefined || seq.next_value === 1, 'gap-free: no number consumed');
  // The next successful issue takes R-2026-0001.
  const good = draftInvoice(ctx, contactId);
  const ok2 = issueInvoice(ctx, { invoiceId: good, idempotencyKey: 'k-m5-ok' });
  assert.ok(ok2.ok);
  assert.equal(ok2.document.number, 'R-2026-0001');
});
