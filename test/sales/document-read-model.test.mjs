// A10/A11 read-model gaps found from the client side by the GUI agent, which correctly STOPPED
// rather than working around them in the client.
//
// GAP A: `document.sent_to_email` is stored but was never exposed on the read model. A11 §4 makes it
// the A11-owned column whose entire purpose is recording TO WHOM an invoice went, and M16's
// acceptance criterion ("Timeline shows 'Versendet an kunde@example.ch'") was unreachable after a
// page reload because of it.
//
// GAP B: there was no `targetDocumentId`, the reverse of the existing `sourceDocumentId`. A10-G6
// (converted documents are dead ends) needs it, and the Studio was deriving the reverse link by
// scanning `list_documents` for converted documents, which inherits the D34 1000-row ceiling and
// silently breaks past it.
//
// The drift guard is the point, not the decoration: five defects have shipped from the Studio
// assuming a key the engine never sends, so these tests assert the ENGINE shape and the app fixtures
// are pinned to it in document-fixture.test.mjs.

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
  transitionDocument,
  convertDocument,
  getDocument,
  listDocuments,
  issueInvoice,
  sendInvoice,
} from '../../dist/core/sales/index.js';

const AT = '2026-07-16T00:00:00.000Z';

/** The exact key list `mapDocument` must return. A drift here is a defect, in either direction. */
const DOCUMENT_KEYS = [
  'contactId',
  'createdAt',
  // A13: the invoice a Gutschrift credits; null on every other type.
  'creditedDocumentId',
  'currency',
  'dueDate',
  'id',
  'issueDate',
  'notes',
  'number',
  // G21: the carry-forward origin (native | migrated), exposed quietly for a saved-view Herkunft
  // column. A migrated open item is a normal open item everywhere else: no shouting badge.
  'origin',
  'postedEntryId',
  'sentToEmail',
  'sourceDocumentId',
  'status',
  'subtotalMinor',
  'targetDocumentId',
  'taxMinor',
  'totalMinor',
  'type',
  'workspaceId',
];

function setup(overrides = {}) {
  const clock = fixedClock(AT);
  const ids = sequenceIdGen();
  const store = new SqliteStore({ clock });
  const deps = { store, clock, ids };
  const workspaceId = createWorkspace(deps, { name: 'Nomadik GmbH' }).workspaceId;
  const ctx = makeContext(store, { workspaceId, actor: 'user_1', clock, ids, ...overrides });
  seedTaxCodes(ctx);
  store.db
    .prepare("UPDATE workspace SET vat_method = 'effektiv', vat_accounting = 'soll' WHERE id = ?")
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
  return { ctx, store, workspaceId, deps };
}

function draftInvoice(ctx) {
  const doc = createDocument(ctx, {
    type: 'invoice',
    contactId: 'ct_1',
    currency: 'CHF',
    lines: [{ description: 'Beratung', unitPriceMinor: 100000, taxCode: 'UST81' }],
  });
  assert.ok(doc.ok, JSON.stringify(doc));
  return doc.document.id;
}

// --- The shape itself ---------------------------------------------------------------------------

test('the document read model exposes exactly the documented key set, on every read path', () => {
  const { ctx } = setup();
  const id = draftInvoice(ctx);
  assert.deepEqual(Object.keys(getDocument(ctx, { documentId: id }).document).sort(), DOCUMENT_KEYS);
  assert.deepEqual(Object.keys(listDocuments(ctx, {}).documents[0]).sort(), DOCUMENT_KEYS);
});

test('convert_document returns the SAME read-model shape as get_document', () => {
  const { ctx } = setup();
  const quote = createDocument(ctx, {
    type: 'quote',
    contactId: 'ct_1',
    lines: [{ description: 'Beratung', unitPriceMinor: 100000, taxCode: 'UST81' }],
  });
  transitionDocument(ctx, { documentId: quote.document.id, to: 'issued' });
  transitionDocument(ctx, { documentId: quote.document.id, to: 'sent' });
  transitionDocument(ctx, { documentId: quote.document.id, to: 'accepted' });
  const converted = convertDocument(ctx, { documentId: quote.document.id, toType: 'order' });
  assert.ok(converted.ok, JSON.stringify(converted));
  assert.deepEqual(Object.keys(converted.document).sort(), DOCUMENT_KEYS);
});

// --- GAP A: sentToEmail ---------------------------------------------------------------------------

test('GAP A: sentToEmail is null until a transmission, then durable across reads', () => {
  const box = [];
  const relay = { send: (m) => { box.push(m); return { ok: true }; } };
  const { ctx } = setup({ emailRelay: relay });
  const id = draftInvoice(ctx);
  issueInvoice(ctx, { invoiceId: id });

  assert.equal(getDocument(ctx, { documentId: id }).document.sentToEmail, null, 'nothing sent yet');

  const sent = sendInvoice(ctx, { invoiceId: id, idempotencyKey: 'k', confirmed: true });
  assert.equal(sent.ok, true, JSON.stringify(sent));
  assert.equal(box.length, 1, 'a real transmission happened');

  // The whole point of GAP A: a LATER read (a page reload) still knows the recipient.
  assert.equal(getDocument(ctx, { documentId: id }).document.sentToEmail, 'billing@muster.example');
  const listed = listDocuments(ctx, {}).documents.find((d) => d.id === id);
  assert.equal(listed.sentToEmail, 'billing@muster.example');
});

test('GAP A: sentToEmail stays null on every path that did NOT transmit (it is evidence, not decoration)', () => {
  // No transport wired, and a workspace that has merely CONFIGURED a relay: neither is a send.
  const { ctx, store, workspaceId } = setup();
  store.db.prepare("UPDATE workspace SET email_relay = 'smtp' WHERE id = ?").run(workspaceId);
  const id = draftInvoice(ctx);
  issueInvoice(ctx, { invoiceId: id });

  const res = sendInvoice(ctx, { invoiceId: id, idempotencyKey: 'k', confirmed: true });
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.equal(getDocument(ctx, { documentId: id }).document.sentToEmail, null, 'no transmission, no evidence');
});

// --- GAP B: targetDocumentId ----------------------------------------------------------------------

test('GAP B: targetDocumentId is the reverse of sourceDocumentId, in ONE read', () => {
  const { ctx } = setup();
  const quote = createDocument(ctx, {
    type: 'quote',
    contactId: 'ct_1',
    lines: [{ description: 'Beratung', unitPriceMinor: 100000, taxCode: 'UST81' }],
  });
  const quoteId = quote.document.id;
  assert.equal(getDocument(ctx, { documentId: quoteId }).document.targetDocumentId, null, 'not converted yet');

  transitionDocument(ctx, { documentId: quoteId, to: 'issued' });
  transitionDocument(ctx, { documentId: quoteId, to: 'sent' });
  transitionDocument(ctx, { documentId: quoteId, to: 'accepted' });
  const order = convertDocument(ctx, { documentId: quoteId, toType: 'order' });
  const orderId = order.document.id;

  const source = getDocument(ctx, { documentId: quoteId }).document;
  const target = getDocument(ctx, { documentId: orderId }).document;
  assert.equal(source.status, 'converted', 'A10-G6: the source is a dead end');
  assert.equal(source.targetDocumentId, orderId, 'the forward link the GUI had to scan for');
  assert.equal(target.sourceDocumentId, quoteId, 'the existing back link still points home');
  assert.equal(target.targetDocumentId, null, 'the target has not itself been converted');
});

test('GAP B: the reverse link survives a chain (quote -> order -> invoice)', () => {
  const { ctx } = setup();
  const quote = createDocument(ctx, {
    type: 'quote',
    contactId: 'ct_1',
    lines: [{ description: 'Beratung', unitPriceMinor: 100000, taxCode: 'UST81' }],
  });
  const quoteId = quote.document.id;
  transitionDocument(ctx, { documentId: quoteId, to: 'issued' });
  transitionDocument(ctx, { documentId: quoteId, to: 'sent' });
  transitionDocument(ctx, { documentId: quoteId, to: 'accepted' });
  const orderId = convertDocument(ctx, { documentId: quoteId, toType: 'order' }).document.id;
  transitionDocument(ctx, { documentId: orderId, to: 'issued' });
  transitionDocument(ctx, { documentId: orderId, to: 'sent' });
  transitionDocument(ctx, { documentId: orderId, to: 'confirmed' });
  const invoiceId = convertDocument(ctx, { documentId: orderId, toType: 'invoice' }).document.id;

  const byId = Object.fromEntries(listDocuments(ctx, {}).documents.map((d) => [d.id, d]));
  assert.equal(byId[quoteId].targetDocumentId, orderId);
  assert.equal(byId[orderId].targetDocumentId, invoiceId);
  assert.equal(byId[invoiceId].targetDocumentId, null);
  assert.equal(byId[invoiceId].sourceDocumentId, orderId);
});

test('GAP B: §H-TENANT: a foreign workspace document is never reported as the target', () => {
  const { ctx, store, workspaceId, deps } = setup();
  const quote = createDocument(ctx, {
    type: 'quote',
    contactId: 'ct_1',
    lines: [{ description: 'Beratung', unitPriceMinor: 100000, taxCode: 'UST81' }],
  });
  const quoteId = quote.document.id;

  // A second tenant in the SAME store, with a row that claims this quote as its source. A
  // workspace-blind reverse lookup would leak it as the target; the scoped subquery must not.
  const otherId = createWorkspace(deps, { name: 'Fremd AG' }).workspaceId;
  store.db
    .prepare(
      `INSERT INTO document (id, workspace_id, type, status, currency, source_document_id, created_at)
       VALUES ('doc_foreign', ?, 'order', 'draft', 'CHF', ?, ?)`,
    )
    .run(otherId, quoteId, AT);

  assert.equal(
    getDocument(ctx, { documentId: quoteId }).document.targetDocumentId,
    null,
    'the cross-tenant row must be invisible',
  );
  assert.equal(listDocuments(ctx, {}).documents.find((d) => d.id === quoteId).targetDocumentId, null);
  // And the foreign workspace does not see this one's documents either.
  const otherCtx = makeContext(store, { workspaceId: otherId, actor: 'user_1', clock: deps.clock, ids: deps.ids });
  assert.equal(listDocuments(otherCtx, {}).documents.some((d) => d.workspaceId === workspaceId), false);
});

test('GAP B: filters still work now that every clause is alias-qualified', () => {
  const { ctx } = setup();
  const invoiceId = draftInvoice(ctx);
  issueInvoice(ctx, { invoiceId });
  createDocument(ctx, { type: 'quote', contactId: 'ct_1', lines: [{ description: 'X', unitPriceMinor: 100 }] });

  assert.equal(listDocuments(ctx, { type: 'invoice' }).documents.length, 1);
  assert.equal(listDocuments(ctx, { status: 'draft' }).documents.length, 1);
  assert.equal(listDocuments(ctx, { contactId: 'ct_1' }).documents.length, 2);
  assert.equal(listDocuments(ctx, { from: '2026-07-16' }).documents.length, 1, 'issue-date range still excludes drafts');
  assert.equal(listDocuments(ctx, { to: '2026-07-15' }).documents.length, 0);
});
