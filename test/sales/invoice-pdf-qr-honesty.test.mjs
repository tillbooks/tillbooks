// A11: the PDF must not lie about WHY the payment part is missing, and a payment-part-less invoice
// must not leave the building silently.
//
// `renderInvoicePdf` hardcoded ONE reason for every `buildQrBill` failure:
//
//   PDF body: "(QR-bill: not available \(kein IBAN konfiguriert\))"
//
// observed on a run where a valid QR-IBAN WAS configured and the real cause was
// `needs_customer_address / illegal_character`. `sendInvoice` only aborted on `!pdf.ok`, so that
// PDF (an invoice with no payment part and a false explanation printed on it) is what reached the
// customer, and the document then advanced to `sent`. The operator checks the IBAN, finds it fine,
// and is stuck with no way to learn the real cause.
//
// Two properties are asserted here:
//   1. The printed reason NAMES the real cause and never asserts a cause that is contradicted by the
//      workspace's own configuration.
//   2. A Swiss invoice with no payment part is not something a customer can pay, so `sendInvoice`
//      refuses it and names the real cause, instead of transmitting and advancing to `sent`.

import test from 'node:test';
import assert from 'node:assert/strict';

import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { makeContext } from '../../dist/core/context.js';
import { fixedClock } from '../../dist/core/clock.js';
import { sequenceIdGen } from '../../dist/core/ids.js';
import { createWorkspace, setCreditorProfile } from '../../dist/core/setup/index.js';
import { seedTaxCodes } from '../../dist/core/vat/index.js';
import { createDocument, issueInvoice, sendInvoice, renderInvoicePdf, buildQrBill } from '../../dist/core/sales/index.js';

const AT = '2026-07-16T00:00:00.000Z';

function setup() {
  const clock = fixedClock(AT);
  const ids = sequenceIdGen();
  const store = new SqliteStore({ clock });
  const sent = [];
  const emailRelay = {
    send(message) {
      sent.push(message);
      return { ok: true, messageId: `msg_${sent.length}` };
    },
  };
  const deps = { store, clock, ids };
  const workspaceId = createWorkspace(deps, { name: 'Nomadik GmbH' }).workspaceId;
  const ctx = makeContext(store, { workspaceId, actor: 'user_1', clock, ids, emailRelay });
  seedTaxCodes(ctx);
  store.db
    .prepare("UPDATE workspace SET vat_method = 'effektiv', vat_accounting = 'soll', posting_auto_issue = 1 WHERE id = ?")
    .run(workspaceId);
  setCreditorProfile(ctx, {
    creditorName: 'Nomadik GmbH',
    address: { street: 'Bahnhofstrasse', buildingNo: '1', zip: '8000', town: 'Zürich', country: 'CH' },
    qrIban: 'CH4431999123000889012',
  });
  store.db
    .prepare(
      `INSERT INTO contact (id, workspace_id, party_role, name, address_street, address_house_no, address_zip, address_city, address_country, email, default_currency, payment_terms_days, created_at)
       VALUES ('ct_1', ?, 'customer', 'Muster AG', 'Musterstrasse', '5', '3000', 'Bern', 'CH', 'billing@muster.example', 'CHF', 30, ?)`,
    )
    .run(workspaceId, AT);
  return { ctx, store, workspaceId, sent };
}

function issuedInvoice(ctx) {
  const doc = createDocument(ctx, {
    type: 'invoice',
    contactId: 'ct_1',
    currency: 'CHF',
    lines: [{ description: 'Beratung', unitPriceMinor: 100000, taxCode: 'UST81' }],
  });
  const invoiceId = doc.document.id;
  const issue = issueInvoice(ctx, { invoiceId });
  assert.equal(issue.ok, true, JSON.stringify(issue));
  return invoiceId;
}

/** Break the CUSTOMER address after issue, leaving the workspace QR-IBAN perfectly valid. */
function breakCustomerAddress(store, workspaceId) {
  store.db.prepare('UPDATE contact SET address_zip = NULL WHERE workspace_id = ? AND id = ?').run(workspaceId, 'ct_1');
}

const pdfText = (result) => Buffer.from(result.pdf.base64, 'base64').toString('latin1');

test('the PDF names the REAL reason the payment part is missing, not a hardcoded IBAN excuse', () => {
  const { ctx, store, workspaceId } = setup();
  const invoiceId = issuedInvoice(ctx);
  breakCustomerAddress(store, workspaceId);

  // The premise: the QR is genuinely refused, and NOT because of the IBAN.
  const qr = buildQrBill(ctx, invoiceId);
  assert.equal(qr.ok, false, 'a customer address without a postal code must be refused');
  assert.equal(qr.error, 'needs_customer_address');

  const pdf = renderInvoicePdf(ctx, invoiceId);
  assert.equal(pdf.ok, true, JSON.stringify(pdf));
  assert.equal(pdf.pdf.hasQrBill, false);
  const body = pdfText(pdf);

  // The lie: a workspace with a valid QR-IBAN configured must never print that none is configured.
  const iban = store.db.prepare('SELECT creditor_iban FROM workspace WHERE id = ?').get(workspaceId).creditor_iban;
  assert.equal(iban, 'CH4431999123000889012', 'the IBAN really is configured');
  assert.equal(
    /kein IBAN konfiguriert/.test(body),
    false,
    'the PDF must not blame a missing IBAN when one is configured',
  );
  // The truth: the printed reason names the cause the engine actually returned.
  assert.match(body, /needs_customer_address/, `the real cause must be printed: ${body.slice(0, 400)}`);
});

test('the PDF still names a genuinely missing IBAN, in the case the old text was written for', () => {
  const { ctx, store, workspaceId } = setup();
  const invoiceId = issuedInvoice(ctx);
  store.db.prepare('UPDATE workspace SET creditor_iban = NULL WHERE id = ?').run(workspaceId);

  const qr = buildQrBill(ctx, invoiceId);
  assert.equal(qr.ok, false);
  const pdf = renderInvoicePdf(ctx, invoiceId);
  assert.equal(pdf.ok, true, JSON.stringify(pdf));
  assert.equal(pdf.pdf.hasQrBill, false);
  assert.match(pdfText(pdf), new RegExp(qr.error), 'the engine reason is what gets printed, whatever it is');
});

test('sendInvoice REFUSES an invoice with no payment part, and names the real cause', () => {
  const { ctx, store, workspaceId, sent } = setup();
  const invoiceId = issuedInvoice(ctx);
  breakCustomerAddress(store, workspaceId);

  const res = sendInvoice(ctx, { invoiceId, confirmed: true });
  assert.equal(res.ok, false, `an unpayable invoice must not be transmitted: ${JSON.stringify(res)}`);
  assert.equal(res.transmitted, false);
  assert.equal(res.error, 'needs_qr_bill');
  assert.equal(res.reason, 'needs_customer_address', 'the operator learns the cause they must fix');
  assert.equal(sent.length, 0, 'nothing left the building');
  assert.equal(
    store.db.prepare('SELECT status, sent_to_email FROM document WHERE id = ?').get(invoiceId).status,
    'issued',
    'and the document did NOT advance to sent',
  );
});

test('sendInvoice still sends a well-formed invoice, with the payment part attached', () => {
  const { ctx, store, sent } = setup();
  const invoiceId = issuedInvoice(ctx);

  const res = sendInvoice(ctx, { invoiceId, confirmed: true });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.transmitted, true);
  assert.equal(sent.length, 1);
  assert.equal(
    store.db.prepare('SELECT status FROM document WHERE id = ?').get(invoiceId).status,
    'sent',
  );
});
