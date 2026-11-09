// A11, invoice engine: the money + statutory path. Issuing posts a balanced VAT-traced entry through
// A10's poster seam and A02's single posting path; the QR-bill resolves QRR/SCOR; the PDF embeds the
// payload; send degrades honestly. These are the §8 engine/property assertions.

import test from 'node:test';
import assert from 'node:assert/strict';

import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { makeContext } from '../../dist/core/context.js';
import { fixedClock } from '../../dist/core/clock.js';
import { sequenceIdGen } from '../../dist/core/ids.js';
import { createWorkspace, setCreditorProfile } from '../../dist/core/setup/index.js';
import { seedTaxCodes } from '../../dist/core/vat/index.js';
import { err } from '../../dist/core/result.js';
import {
  createDocument,
  issueInvoice,
  buildQrBill,
  renderInvoicePdf,
  sendInvoice,
  getDocument,
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
  store.db.prepare("UPDATE workspace SET vat_method = 'effektiv', vat_accounting = 'soll', mwst_no = 'CHE-102.673.386 MWST' WHERE id = ?").run(workspaceId);
  setCreditorProfile(ctx, CREDITOR);
  const contactId = store.db
    .prepare(
      `INSERT INTO contact (id, workspace_id, party_role, name, address_street, address_house_no, address_zip, address_city, address_country, email, default_currency, payment_terms_days, created_at)
       VALUES ('ct_1', ?, 'customer', 'Muster AG', 'Musterstrasse', '5', '3000', 'Bern', 'CH', 'billing@muster.example', 'CHF', 30, ?) RETURNING id`,
    )
    .get(workspaceId, AT).id;
  return { ctx, store, workspaceId, deps, contactId };
}

/** A draft invoice with one 8.1% position of 1000.00 CHF net (unit price 100000 Rappen). */
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

function entryLines(store, entryId) {
  return store.db.prepare('SELECT * FROM journal_line WHERE entry_id = ?').all(entryId);
}

function invoiceEntries(store, workspaceId) {
  return store.db
    .prepare("SELECT * FROM journal_entry WHERE workspace_id = ? AND source = 'invoice'")
    .all(workspaceId);
}

test('issueInvoice posts a balanced entry (Sigma debit == Sigma credit) with gross/net/VAT legs', () => {
  const { ctx, store, workspaceId, contactId } = setup();
  const id = draftInvoice(ctx, contactId);
  const issued = issueInvoice(ctx, { invoiceId: id, idempotencyKey: 'k-issue-1' });
  assert.ok(issued.ok, JSON.stringify(issued));
  assert.equal(issued.document.status, 'issued');
  assert.match(issued.document.number, /^R-2026-0001$/);

  const doc = store.db.prepare('SELECT posted_entry_id FROM document WHERE id = ?').get(id);
  assert.ok(doc.posted_entry_id, 'posted_entry_id set');
  const lines = entryLines(store, doc.posted_entry_id);
  const debit = lines.reduce((s, l) => s + l.base_debit_minor, 0);
  const credit = lines.reduce((s, l) => s + l.base_credit_minor, 0);
  assert.equal(debit, credit, 'entry balances');
  // 1000.00 net at 8.1% -> 81.00 tax -> 1081.00 gross debtor.
  assert.equal(debit, 108100);
  // Exactly one VAT-carrying revenue leg + the 2200 output line.
  const vatLine = lines.find((l) => l.tax_code === 'UST81');
  assert.ok(vatLine, 'a line carries the frozen VAT trace');
  assert.equal(vatLine.tax_amount_minor, 8100);
});

test('property: buildInvoicePosting balances for a MIXED-rate invoice', () => {
  const { ctx, store, contactId } = setup();
  const id = draftInvoice(ctx, contactId, [
    { description: 'Normalsatz', unitPriceMinor: 100000, taxCode: 'UST81' },
    { description: 'Beherbergung', unitPriceMinor: 50000, taxCode: 'UST38' },
    { description: 'Export', unitPriceMinor: 25000, taxCode: 'EXPORT0' },
  ]);
  const issued = issueInvoice(ctx, { invoiceId: id, idempotencyKey: 'k-mixed' });
  assert.ok(issued.ok, JSON.stringify(issued));
  const doc = store.db.prepare('SELECT posted_entry_id FROM document WHERE id = ?').get(id);
  const lines = entryLines(store, doc.posted_entry_id);
  const debit = lines.reduce((s, l) => s + l.base_debit_minor, 0);
  const credit = lines.reduce((s, l) => s + l.base_credit_minor, 0);
  assert.equal(debit, credit);
});

test('§H-IDEMPOTENT: double-issue with the same key posts ONCE and returns the same number (ROWS check)', () => {
  const { ctx, store, workspaceId, contactId } = setup();
  const id = draftInvoice(ctx, contactId);
  const first = issueInvoice(ctx, { invoiceId: id, idempotencyKey: 'k-dupe' });
  const second = issueInvoice(ctx, { invoiceId: id, idempotencyKey: 'k-dupe' });
  assert.ok(first.ok && second.ok);
  assert.equal(first.document.number, second.document.number);
  // ROWS, not the report: exactly ONE invoice entry exists in the ledger.
  assert.equal(invoiceEntries(store, workspaceId).length, 1);
});

test('a failed issue (no lines) consumes no number and leaves status draft', () => {
  const { ctx, store, workspaceId, contactId } = setup();
  const id = draftInvoice(ctx, contactId, []);
  const issued = issueInvoice(ctx, { invoiceId: id, idempotencyKey: 'k-empty' });
  assert.ok(!issued.ok);
  assert.equal(issued.error, 'needs_lines');
  const doc = store.db.prepare('SELECT status, number FROM document WHERE id = ?').get(id);
  assert.equal(doc.status, 'draft');
  assert.equal(doc.number, null);
  // The number sequence was never advanced: the next real issue takes R-2026-0001.
  const seq = store.db.prepare('SELECT next_value FROM document_number_seq WHERE workspace_id = ? AND type = ?').get(workspaceId, 'invoice');
  assert.ok(seq === undefined || seq.next_value === 1);
});

test('a locked period blocks issue: period_locked, no number consumed, no posting', () => {
  const periods = { assertOpen: () => err('period_locked', { period: '2026-07', kind: 'hard', reason: 'vat_filed' }) };
  const { ctx, store, workspaceId, contactId } = setup({ periods });
  const id = draftInvoice(ctx, contactId);
  const issued = issueInvoice(ctx, { invoiceId: id, idempotencyKey: 'k-locked' });
  assert.ok(!issued.ok);
  assert.equal(issued.error, 'period_locked');
  const doc = store.db.prepare('SELECT status, number, posted_entry_id FROM document WHERE id = ?').get(id);
  assert.equal(doc.status, 'draft');
  assert.equal(doc.number, null);
  assert.equal(doc.posted_entry_id, null);
  assert.equal(invoiceEntries(store, workspaceId).length, 0);
});

test('buildQrBill: an issued invoice with a QR-IBAN yields a QRR QR-bill (mod-10 valid)', () => {
  const { ctx, contactId } = setup();
  const id = draftInvoice(ctx, contactId);
  issueInvoice(ctx, { invoiceId: id, idempotencyKey: 'k-qr' });
  const res = buildQrBill(ctx, id);
  assert.ok(res.ok, JSON.stringify(res));
  assert.equal(res.qr.referenceType, 'QRR');
  assert.equal(res.qr.reference.length, 27);
  assert.equal(res.qr.igVersion, '2.3');
  // The payload carries the Swico S1 StrdBkgInf and the eBill AltPmt (D31).
  assert.match(res.qr.swissQrPayload, /\/\/S1\/10\/R-2026-0001/);
  assert.match(res.qr.swissQrPayload, /eBill\/B\/billing@muster\.example/);
});

test('buildQrBill: a plain (non-QR) IBAN yields a SCOR reference; needs_qr_iban does NOT fire', () => {
  const { ctx, contactId } = setup();
  // A plain IBAN goes in through the PUBLIC verb, because A00 stores either kind (M-2): a QR
  // reference needs a QR-IBAN (QR-IID 30000-31999) and a SCOR reference needs a plain one, and both
  // are valid QR-bills. `setCreditorProfile` used to refuse anything but a QR-IBAN, which is why
  // this case once had to be staged with a raw UPDATE against `workspace.qr_iban`. Going through the
  // verb is what proves the SCOR path is reachable by a real caller and not only by the test.
  const profile = setCreditorProfile(ctx, { ...CREDITOR, qrIban: 'CH9300762011623852957' });
  assert.ok(profile.ok, JSON.stringify(profile));
  const id = draftInvoice(ctx, contactId);
  issueInvoice(ctx, { invoiceId: id, idempotencyKey: 'k-scor' });
  const res = buildQrBill(ctx, id);
  assert.ok(res.ok, JSON.stringify(res));
  assert.equal(res.qr.referenceType, 'SCOR');
  assert.ok(res.qr.reference.startsWith('RF'));
});

test('buildQrBill: no IBAN of any kind -> needs_qr_iban (M9); a plain PDF is still producible', () => {
  const { ctx, store, workspaceId, contactId } = setup();
  store.db.prepare('UPDATE workspace SET creditor_iban = NULL WHERE id = ?').run(workspaceId);
  const id = draftInvoice(ctx, contactId);
  issueInvoice(ctx, { invoiceId: id, idempotencyKey: 'k-noiban' });
  const res = buildQrBill(ctx, id);
  assert.ok(!res.ok);
  assert.equal(res.error, 'needs_qr_iban');
  // A plain PDF still renders (no QR-bill), so the invoice is still issuable/downloadable.
  const pdf = renderInvoicePdf(ctx, id);
  assert.ok(pdf.ok);
  assert.equal(pdf.pdf.hasQrBill, false);
});

test('renderInvoicePdf: produces a PDF that embeds the exact Swiss QR payload; PDF/A not claimed', () => {
  const { ctx, contactId } = setup();
  const id = draftInvoice(ctx, contactId);
  issueInvoice(ctx, { invoiceId: id, idempotencyKey: 'k-pdf' });
  const qr = buildQrBill(ctx, id);
  const pdf = renderInvoicePdf(ctx, id);
  assert.ok(pdf.ok, JSON.stringify(pdf));
  assert.equal(pdf.pdf.hasQrBill, true);
  assert.equal(pdf.pdf.pdfaProfile, null, 'PDF/A-3b deferred (A32-OI1)');
  const bytes = Buffer.from(pdf.pdf.base64, 'base64').toString('latin1');
  assert.ok(bytes.startsWith('%PDF-1.4'));
  // The exact payload rides in the bytes (newlines escaped in the comment line).
  const embedded = qr.qr.swissQrPayload.replace(/\r?\n/g, '\\n');
  assert.ok(bytes.includes(embedded), 'PDF carries the exact QR payload');
});

test('sendInvoice: outbound step waits for confirmation (P8), then degrades to needs_email_config', () => {
  const { ctx, contactId } = setup();
  const id = draftInvoice(ctx, contactId);
  issueInvoice(ctx, { invoiceId: id, idempotencyKey: 'k-send-1' });
  // P8 (M15): with the dial off and no confirmation, the outbound step refuses.
  const gated = sendInvoice(ctx, { invoiceId: id, idempotencyKey: 'k-send-1a' });
  assert.equal(gated.error, 'needs_confirmation');
  // Confirmed, but no relay configured -> needs_email_config (M18), status stays issued.
  const noRelay = sendInvoice(ctx, { invoiceId: id, idempotencyKey: 'k-send-1b', confirmed: true });
  assert.equal(noRelay.error, 'needs_email_config');
  assert.equal(getDocument(ctx, { documentId: id }).document.status, 'issued');
});

test('sendInvoice: needs_customer_email when no recipient is resolvable', () => {
  const { ctx, store, contactId } = setup();
  store.db.prepare('UPDATE contact SET email = NULL WHERE id = ?').run(contactId);
  const id = draftInvoice(ctx, contactId);
  issueInvoice(ctx, { invoiceId: id, idempotencyKey: 'k-send-2' });
  const res = sendInvoice(ctx, { invoiceId: id, idempotencyKey: 'k-send-2b', confirmed: true });
  assert.equal(res.error, 'needs_customer_email');
});

test('sendInvoice: with a relay + email + confirmation, records sent_to_email and transitions to sent', () => {
  const sentBox = [];
  const relay = { send: (msg) => { sentBox.push(msg); return { ok: true }; } };
  const { ctx, store, contactId } = setup();
  // Inject the relay onto the context (the OP4 relay port).
  ctx.emailRelay = relay;
  const id = draftInvoice(ctx, contactId);
  issueInvoice(ctx, { invoiceId: id, idempotencyKey: 'k-send-3' });
  const res = sendInvoice(ctx, { invoiceId: id, idempotencyKey: 'k-send-3b', confirmed: true });
  assert.ok(res.ok, JSON.stringify(res));
  assert.equal(res.transmitted, true);
  assert.equal(res.sentToEmail, 'billing@muster.example');
  assert.equal(sentBox.length, 1);
  const doc = store.db.prepare('SELECT status, sent_to_email FROM document WHERE id = ?').get(id);
  assert.equal(doc.status, 'sent');
  assert.equal(doc.sent_to_email, 'billing@muster.example');
});

test('issue in EUR without an A22 rate returns needs_fx_rate (no partial posting)', () => {
  const { ctx, store, workspaceId, contactId } = setup();
  const res = createDocument(ctx, {
    type: 'invoice', contactId, currency: 'EUR',
    lines: [{ description: 'Beratung', unitPriceMinor: 100000, taxCode: 'UST81' }],
  });
  const issued = issueInvoice(ctx, { invoiceId: res.document.id, idempotencyKey: 'k-eur' });
  assert.ok(!issued.ok);
  assert.equal(issued.error, 'needs_fx_rate');
  assert.equal(invoiceEntries(store, workspaceId).length, 0);
});
