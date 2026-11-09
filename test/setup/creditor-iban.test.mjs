// M-2: a business without a QR-IBAN must be able to invoice.
//
// §2/US-A11.2 and §6 both state that a plain IBAN yields a SCOR QR-bill and that `needs_qr_iban`
// does NOT fire, and `buildQrBill` implements that correctly. The branch shipped it unreachable:
// the workspace's one creditor-IBAN column had a writer that refused anything that was not a
// QR-IBAN, and `bootstrapWorkspace` demanded a QR-IBAN in `needs`. The SCOR path could be reached
// only by a hand-written UPDATE straight at the column. A large share of Swiss SMEs have no
// QR-IBAN, so as shipped they could not invoice at all.
//
// Per the SIX Implementation Guidelines the two reference types are mutually exclusive: a QR
// reference may be used ONLY with a QR-IBAN (whose QR-IID falls in 30000-31999), and the Structured
// Creditor Reference (SCOR, ISO 11649) may be used ONLY with a plain IBAN. Both are fully valid
// QR-bills, so setup must accept either kind of IBAN and let the reference type follow from it.
//
// These tests drive the SETUP path end to end into the rendered QR-bill, because the defect was
// exactly that the two halves were correct and not connected.

import test from 'node:test';
import assert from 'node:assert/strict';

import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { makeContext } from '../../dist/core/context.js';
import { fixedClock } from '../../dist/core/clock.js';
import { sequenceIdGen } from '../../dist/core/ids.js';
import {
  createWorkspace,
  bootstrapWorkspace,
  setCreditorProfile,
  getCompanyProfile,
} from '../../dist/core/setup/index.js';
import { seedTaxCodes } from '../../dist/core/vat/index.js';
import { createDocument, issueInvoice, buildQrBill } from '../../dist/core/sales/index.js';

const AT = '2026-07-16T00:00:00.000Z';

/** A real QR-IBAN: the QR-IID 31999 sits inside the reserved 30000-31999 range. */
const QR_IBAN = 'CH4431999123000889012';
/** A plain IBAN. Valid, ordinary, and what most Swiss SMEs actually have. */
const PLAIN_IBAN = 'CH9300762011623852957';

const ADDRESS = { street: 'Bahnhofstrasse', buildingNo: '1', zip: '8000', town: 'Zürich', country: 'CH' };

function setup() {
  const clock = fixedClock(AT);
  const ids = sequenceIdGen();
  const store = new SqliteStore({ clock });
  const deps = { store, clock, ids };
  const { workspaceId } = createWorkspace(deps, { name: 'Nomadik GmbH' });
  const ctx = makeContext(store, { workspaceId, actor: 'user_1', clock, ids });
  seedTaxCodes(ctx);
  store.db
    .prepare("UPDATE workspace SET vat_method = 'effektiv', vat_accounting = 'soll' WHERE id = ?")
    .run(workspaceId);
  const contactId = store.db
    .prepare(
      `INSERT INTO contact (id, workspace_id, party_role, name, address_street, address_house_no, address_zip, address_city, address_country, email, default_currency, payment_terms_days, created_at)
       VALUES ('ct_1', ?, 'customer', 'Muster AG', 'Musterstrasse', '5', '3000', 'Bern', 'CH', 'billing@muster.example', 'CHF', 30, ?) RETURNING id`,
    )
    .get(workspaceId, AT).id;
  return { ctx, store, deps, workspaceId, contactId };
}

/** Issue a one-position invoice and return its id, so a QR-bill can be built from it. */
function issuedInvoice(ctx, contactId, key) {
  const draft = createDocument(ctx, {
    type: 'invoice',
    contactId,
    currency: 'CHF',
    lines: [{ description: 'Beratung', unitPriceMinor: 100000, taxCode: 'UST81' }],
  });
  assert.ok(draft.ok, JSON.stringify(draft));
  const issued = issueInvoice(ctx, { invoiceId: draft.document.id, idempotencyKey: key });
  assert.ok(issued.ok, JSON.stringify(issued));
  return draft.document.id;
}

test('M-2: setCreditorProfile accepts a PLAIN IBAN, the only kind most Swiss SMEs have', () => {
  const { ctx } = setup();
  const res = setCreditorProfile(ctx, { creditorName: 'Nomadik GmbH', address: ADDRESS, qrIban: PLAIN_IBAN });
  assert.ok(res.ok, `a plain IBAN must be accepted: ${JSON.stringify(res)}`);
  assert.equal(getCompanyProfile(ctx).profile.creditorIban, PLAIN_IBAN, 'the IBAN must actually be stored');
});

test('M-2: a plain IBAN configured through SETUP yields a SCOR QR-bill; needs_qr_iban does NOT fire', () => {
  const { ctx, contactId } = setup();
  // The whole finding in one flow: configure through the public verb, no hand-written UPDATE.
  assert.ok(setCreditorProfile(ctx, { creditorName: 'Nomadik GmbH', address: ADDRESS, qrIban: PLAIN_IBAN }).ok);
  const invoiceId = issuedInvoice(ctx, contactId, 'k-scor');

  const qr = buildQrBill(ctx, invoiceId);
  assert.ok(qr.ok, `a plain IBAN must still produce a QR-bill: ${JSON.stringify(qr)}`);
  assert.notEqual(qr.error, 'needs_qr_iban');
  assert.equal(qr.qr.referenceType, 'SCOR', 'SCOR is the reference type a plain IBAN takes');
  assert.ok(qr.qr.reference.startsWith('RF'), `an ISO 11649 reference starts with RF: ${qr.qr.reference}`);
});

test('M-2: a QR-IBAN configured through SETUP still yields QRR', () => {
  const { ctx, contactId } = setup();
  assert.ok(setCreditorProfile(ctx, { creditorName: 'Nomadik GmbH', address: ADDRESS, qrIban: QR_IBAN }).ok);
  const invoiceId = issuedInvoice(ctx, contactId, 'k-qrr');

  const qr = buildQrBill(ctx, invoiceId);
  assert.ok(qr.ok, JSON.stringify(qr));
  assert.equal(qr.qr.referenceType, 'QRR', 'a QR-IBAN may only be used with a QR reference');
  assert.equal(qr.qr.reference.length, 27);
});

test('M-2: what is refused is an INVALID IBAN, not a non-QR one', () => {
  const { ctx } = setup();
  for (const bad of ['CH9300762011623852958', 'not-an-iban', 'CH93', '']) {
    const res = setCreditorProfile(ctx, { creditorName: 'Nomadik GmbH', address: ADDRESS, qrIban: bad });
    assert.equal(res.ok, false, `${JSON.stringify(bad)} is not a valid IBAN and must be refused`);
    assert.equal(res.error, 'invalid_iban', `the refusal must name the real problem, got ${JSON.stringify(res)}`);
  }
  // And the profile is unchanged: a refused write writes nothing.
  assert.equal(getCompanyProfile(ctx).profile.creditorIban, null);
});

test('M-2: bootstrap asks for an IBAN, not specifically a QR-IBAN', () => {
  const clock = fixedClock(AT);
  const store = new SqliteStore({ clock });
  const deps = { store, clock, ids: sequenceIdGen(), actor: 'agent' };
  const res = bootstrapWorkspace(deps, {
    description: 'Nomadik GmbH, Zürich, MWST effektiv',
    idempotencyKey: 'boot-1',
  });
  assert.ok(res.ok, JSON.stringify(res));
  assert.ok(res.needs.includes('creditorIban'), `bootstrap must ask for an IBAN of either kind: ${JSON.stringify(res.needs)}`);
  assert.ok(
    !res.needs.includes('qrIban'),
    'bootstrap must not demand a QR-IBAN: a business without one can still invoice with SCOR',
  );
  store.close();
});
