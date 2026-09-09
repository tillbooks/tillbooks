/**
 * The A11 GUI fixture-versus-engine drift guard.
 *
 * The invoice app suites render `issue-invoice.fixture.json`, `invoice-artifacts.fixture.json` and
 * `send-invoice.fixture.json` in jsdom, standing in for the live `issue_invoice`,
 * `get_document(include:['qr','pdf'])` and `send_invoice` responses. Same contract as
 * test/sales/document-fixture.test.mjs and test/vat/tax-codes-fixture.test.mjs: pin the fixtures to
 * the real engine response, KEYS and KINDS (null its own kind), so an app test can never pass green
 * against a shape the engine does not return.
 *
 * This exists because the Studio has shipped four defects by assuming a key the engine never sends
 * (`vatCodes` vs `taxCodes`, the profile wrapper, `address` vs `creditorAddress`, `null` vs
 * `undefined`). The A11 trap is worse than a rename: the QR arrives in TWO envelopes, `issue_invoice`
 * wrapping it as `{available, ...}` and `get_document` returning either the bare bill or the RAW
 * rejection. Both arms are asserted below.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { makeContext } from '../../dist/core/context.js';
import { fixedClock } from '../../dist/core/clock.js';
import { sequenceIdGen } from '../../dist/core/ids.js';
import { createWorkspace } from '../../dist/core/setup/index.js';
import { configureVat } from '../../dist/core/vat/index.js';
import { createDocument } from '../../dist/core/sales/index.js';
import { issueInvoice, sendInvoice } from '../../dist/core/sales/invoice.js';
import { getAction } from '../../dist/api/registry.js';

const DIR = new URL('../../app/src/surfaces/Documents/', import.meta.url);
const ISSUE_FIXTURE = new URL('issue-invoice.fixture.json', DIR);
const ARTIFACTS_FIXTURE = new URL('invoice-artifacts.fixture.json', DIR);
const SEND_FIXTURE = new URL('send-invoice.fixture.json', DIR);

function keysOf(obj) {
  return Object.keys(obj).sort();
}
function kindOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}
function assertShape(fixture, live, where) {
  assert.deepEqual(keysOf(fixture), keysOf(live), `${where}: key drift`);
  for (const key of Object.keys(live)) {
    assert.equal(kindOf(fixture[key]), kindOf(live[key]), `${where}.${key}: kind drift`);
  }
}

/**
 * The exact world the fixtures depict: a QR-IBAN workspace, a structured-address customer, one
 * invoice, and a transport wired behind the relay.
 *
 * The transport is not decoration. `workspace.email_relay` is a SETTING and never by itself a
 * transport (M18/OP4), so a mode alone now answers `needs_email_transport` and no send fixture can
 * be captured from it. The send fixture depicts a SUCCESSFUL transmission, which is the state S7
 * renders on its happy path, so the world that produces it has to contain a transport that accepted
 * the message. The recording box doubles as the evidence that one really did.
 */
function liveWorld({ transport = true } = {}) {
  const clock = fixedClock('2026-07-16T00:00:00.000Z');
  const ids = sequenceIdGen();
  const store = new SqliteStore({ clock });
  const sent = [];
  const emailRelay = {
    send: (msg) => {
      sent.push(msg);
      return { ok: true };
    },
  };
  const workspaceId = createWorkspace({ store, clock, ids }, { name: 'Muster Grafik' }).workspaceId;
  const ctx = makeContext(store, {
    workspaceId,
    actor: 'user_1',
    clock,
    ids,
    ...(transport ? { emailRelay } : {}),
  });
  store.db
    .prepare('UPDATE workspace SET creditor_iban=?, creditor_name=?, creditor_address=?, mwst_no=? WHERE id=?')
    .run(
      'CH4431999123000889012',
      'Muster Grafik GmbH',
      JSON.stringify({ street: 'Bahnhofstrasse', buildingNo: '1', zip: '8001', town: 'Zürich', country: 'CH' }),
      'CHE-123.456.789 MWST',
      workspaceId,
    );
  configureVat(ctx, { method: 'effektiv', timing: 'soll', registered: true, idempotencyKey: 'k' });
  store.db
    .prepare(
      `INSERT INTO contact (id, workspace_id, party_role, name, default_currency, payment_terms_days, created_at,
        email, address_street, address_house_no, address_zip, address_city, address_country)
       VALUES ('ct_1', ?, 'customer','Muster AG','CHF',30,'2026-07-16T00:00:00.000Z',
        'kunde@example.ch','Musterweg','7','3000','Bern','CH')`,
    )
    .run(workspaceId);
  const draft = createDocument(ctx, {
    type: 'invoice',
    contactId: 'ct_1',
    lines: [{ description: 'Beratung', quantityMilli: 10000, unitPriceMinor: 15000, taxCode: 'UST81' }],
  });
  return { ctx, store, workspaceId, invoiceId: draft.document.id, sent };
}

test('the issue-invoice fixture matches the live issueInvoice response, keys and kinds', () => {
  const { ctx, invoiceId } = liveWorld();
  const live = issueInvoice(ctx, { invoiceId, idempotencyKey: 'i1' });
  const fixture = JSON.parse(readFileSync(ISSUE_FIXTURE, 'utf8'));

  assert.deepEqual(keysOf(fixture), keysOf(live), 'issue_invoice envelope drifted');
  assertShape(fixture.document, live.document, 'document');
  assertShape(fixture.lines[0], live.lines[0], 'lines[0]');
  assertShape(fixture.history[0], live.history[0], 'history[0]');

  // The QR rides the issue response under an `available` flag, NOT as a bare bill: the Studio's
  // `readQr` normaliser exists for exactly this. Both arms are load-bearing.
  assertShape(fixture.qr, live.qr, 'qr');
  assert.equal(live.qr.available, true, 'a QR-IBAN workspace must issue an available QR');
  assert.equal(fixture.qr.available, true);
  assert.equal(kindOf(fixture.qr.swissQrPayload), 'string');
  assert.equal(fixture.qr.referenceType, live.qr.referenceType, 'reference type drifted');
  assert.equal(fixture.qr.reference, live.qr.reference, 'the reference itself drifted');
  assert.equal(fixture.qr.igVersion, live.qr.igVersion, 'the pinned IG version drifted');
});

test('the issue_invoice QR failure arm carries {available:false, reason}, not a bare rejection', () => {
  const { ctx, store, workspaceId } = liveWorld();
  // No IBAN of any kind: M9's needs_qr_iban. Issuing still succeeds (the invoice posts), only the QR
  // is unavailable, which is exactly the arm the editor and the S3 panel must render.
  store.db.prepare('UPDATE workspace SET creditor_iban = NULL WHERE id = ?').run(workspaceId);
  const draft = createDocument(ctx, {
    type: 'invoice',
    contactId: 'ct_1',
    lines: [{ description: 'Beratung', unitPriceMinor: 15000, taxCode: 'UST81' }],
  });
  const live = issueInvoice(ctx, { invoiceId: draft.document.id, idempotencyKey: 'i2' });
  assert.equal(live.ok, true, 'a missing QR-IBAN must not block issuing');
  assert.equal(live.qr.available, false);
  assert.equal(live.qr.reason, 'needs_qr_iban');
  assert.equal(live.qr.swissQrPayload, undefined, 'the failure arm carries no payload');
});

test('the invoice-artifacts fixture matches live get_document(include:[qr,pdf]), keys and kinds', () => {
  const { ctx, workspaceId, invoiceId } = liveWorld();
  issueInvoice(ctx, { invoiceId, idempotencyKey: 'i1' });
  const live = getAction('get_document').run(ctx, { workspaceId, documentId: invoiceId, include: ['qr', 'pdf'] });
  const fixture = JSON.parse(readFileSync(ARTIFACTS_FIXTURE, 'utf8'));

  assert.deepEqual(keysOf(fixture), keysOf(live), 'get_document(include) envelope drifted');

  // The document block itself, which this test used to skip: it checked the envelope, the QR and the
  // PDF and never the thing all three hang off. So when the read model gained `sentToEmail` and
  // `targetDocumentId` this fixture went stale in exactly the way its two siblings went RED, and
  // stayed green about it. A guard with a hole in it is worse than no guard, because it is believed.
  assertShape(fixture.document, live.document, 'document');
  assertShape(fixture.lines[0], live.lines[0], 'lines[0]');
  assertShape(fixture.history[0], live.history[0], 'history[0]');

  // The QR arm here is the BARE bill (no `available` key): the second envelope `readQr` normalises.
  assertShape(fixture.qr, live.qr, 'qr');
  assert.equal(fixture.qr.available, undefined, 'get_document must NOT wrap the QR in an availability flag');
  assert.equal(fixture.qr.reference, live.qr.reference, 'the reference drifted');
  assert.equal(fixture.qr.referenceType, live.qr.referenceType);

  // The PDF arm: base64 + byteLength + hasQrBill + an explicitly NULL pdfaProfile (A32-OI1 deferred,
  // D31: the engine never claims PDF/A conformance, so the viewer must never imply it either).
  assertShape(fixture.pdf, live.pdf, 'pdf');
  assert.equal(kindOf(fixture.pdf.base64), 'string');
  assert.equal(fixture.pdf.pdfaProfile, null, 'PDF/A-3b is deferred and must stay unclaimed');
  assert.equal(fixture.pdf.hasQrBill, live.pdf.hasQrBill);

  // The viewer's whole contract: the artifact carries the SAME payload the QR panel shows, byte for
  // byte (spec §8). Decoding the fixture's own base64 proves it without a QR reader.
  const pdfText = Buffer.from(fixture.pdf.base64, 'base64').toString('latin1');
  const embedded = fixture.qr.swissQrPayload.replace(/\r?\n/g, '\\n');
  assert.ok(pdfText.includes(embedded), 'the PDF must embed the exact QR payload, byte for byte');

  // ...and the same payload the ENGINE emits, which the check above cannot see. Everything else in
  // this test compares the fixture to `live` by KEY and KIND, so a `swissQrPayload` that has drifted
  // in CONTENT stays a string and stays green. That is not hypothetical: this fixture sat 42KB stale
  // from `59f2015` through both "encode the QR symbol once, not twice" commits (a0e77bb, 60200a2)
  // without a single test noticing, because the assertion above only ever asked the fixture about
  // itself. A golden that is only self-consistent is a golden that proves nothing.
  //
  // Both bodies are deterministic (fixed clock, sequence ids, no embedded timestamps), so pinning
  // them byte-for-byte is safe rather than flaky, and it is what makes the creditor address in the
  // payload a fact about the engine instead of a fact about whoever last hand-edited the JSON.
  assert.equal(
    fixture.qr.swissQrPayload,
    live.qr.swissQrPayload,
    'the golden QR payload drifted from the engine: regenerate the fixture, do not hand-edit it',
  );
  assert.equal(
    fixture.pdf.base64,
    live.pdf.base64,
    'the golden PDF drifted from the engine: regenerate the fixture, do not hand-edit it',
  );
  assert.equal(fixture.pdf.byteLength, live.pdf.byteLength, 'the PDF byte length drifted');
});

/**
 * The creditor town in the golden payload carries a REAL umlaut, and the standard permits it.
 *
 * This is the half of the umlaut sweep that a byte-exact golden makes dangerous: the city is spelled
 * once in the seed and once inside a frozen payload that a PDF embeds, so correcting one and not the
 * other yields either a green test proving nothing or a red one for the wrong reason. The assertions
 * below tie all three together, and they are only legitimate because the character set says so.
 *
 * Swiss Implementation Guidelines QR-bill v2.3, §4.1.1 "Character set", fetched 2026-07-25 from
 * six-group.com/dam/download/banking-services/standardization/qr-bill/ig-qr-bill-v2.3-en.pdf:
 *
 *   "The following subset of characters from the Unicode UTF-8 character set is allowed in the Swiss
 *    QR Code in accordance with the Swiss standard:
 *      - Basic Latin (Unicode codepoints U+0020-U+007E)
 *      - Latin1 Supplement (Unicode codepoints U+00A0-U+00FF)
 *      - Latin Extended A (Unicode codepoints U+0100-U+017F)"
 *
 * `ü` is U+00FC, inside Latin1 Supplement, so it is permitted outright: there is no QR-bill exception
 * to carve out here and the ASCII spelling was never required by the standard. IG v2.3 §4.3.3 caps
 * the creditor town at "Maximum 35 characters permitted", and "Zürich" is 6.
 */
test('the golden QR payload spells its creditor town with a real umlaut, within the IG charset', async () => {
  const { firstDisallowedQrChar } = await import('../../dist/core/sales/qrbill.js');
  const fixture = JSON.parse(readFileSync(ARTIFACTS_FIXTURE, 'utf8'));
  const elements = fixture.qr.swissQrPayload.split('\r\n');

  // Element 9 of the SPC block is the creditor's town (IBAN, address type, name, street, building
  // number, postal code, town...). Asserted by position so a shifted element cannot pass silently.
  assert.equal(elements[9], 'Zürich', 'the creditor town must carry the umlaut, not "Zuerich"');
  assert.ok(elements[9].length <= 35, 'IG v2.3: the creditor town is capped at 35 characters');
  assert.ok(!fixture.qr.swissQrPayload.includes('Zuerich'), 'no ASCII transliteration survives in the payload');

  // Every element is inside §4.1.1. CR and LF are the element SEPARATOR, so this is checked per
  // element and not over the assembled payload, which necessarily contains them.
  const offenders = elements
    .map((value, index) => ({ index, value, bad: firstDisallowedQrChar(value) }))
    .filter((e) => e.bad !== null);
  assert.deepEqual(offenders, [], 'an element left the IG v2.3 §4.1.1 character set');

  // And the umlaut really did reach the PDF the customer receives, not just the panel.
  const pdfText = Buffer.from(fixture.pdf.base64, 'base64').toString('latin1');
  assert.ok(
    pdfText.includes(fixture.qr.swissQrPayload.replace(/\r?\n/g, '\\n')),
    'the PDF must embed the umlaut payload, or the two artifacts have drifted apart again',
  );
});

test('a DRAFT invoice is refused both artifacts with a structured reason (M-1)', () => {
  const { ctx, workspaceId, invoiceId } = liveWorld();
  const live = getAction('get_document').run(ctx, { workspaceId, documentId: invoiceId, include: ['qr', 'pdf'] });
  assert.equal(live.ok, true, 'the document itself still reads');
  assert.equal(live.qr.ok, false, 'a draft QR arrives as the RAW rejection, no availability flag');
  assert.equal(live.qr.error, 'not_available');
  assert.equal(live.qr.reason, 'draft_has_no_qr_bill');
  assert.equal(live.pdf.ok, false);
  assert.equal(live.pdf.reason, 'draft_has_no_invoice_pdf');
});

test('the send-invoice fixture matches the live sendInvoice response, keys and kinds', () => {
  const { ctx, store, workspaceId, invoiceId, sent } = liveWorld();
  issueInvoice(ctx, { invoiceId, idempotencyKey: 'i1' });
  store.db.prepare("UPDATE workspace SET email_relay='local' WHERE id=?").run(workspaceId);
  const live = sendInvoice(ctx, { invoiceId, confirmed: true, idempotencyKey: 's1' });

  assert.equal(live.ok, true, `the send fixture depicts a SUCCESS: ${JSON.stringify(live)}`);
  assert.equal(sent.length, 1, 'the fixture depicts a real transmission, so one must have happened');
  const fixture = JSON.parse(readFileSync(SEND_FIXTURE, 'utf8'));

  assert.deepEqual(keysOf(fixture), keysOf(live), 'send_invoice envelope drifted');
  assertShape(fixture.document, live.document, 'document');
  assertShape(fixture.lines[0], live.lines[0], 'lines[0]');
  assertShape(fixture.history[0], live.history[0], 'history[0]');
  assert.equal(fixture.document.status, 'sent');
  assert.equal(kindOf(fixture.sentToEmail), 'string', 'the GUI reads sentToEmail, not `email`');
  assert.equal(fixture.transmitted, true);

  // GAP A: the recipient is DURABLE, not just an echo of the call. S3 renders "Versendet an ..."
  // after a reload from the document read model, so the same address must be on the document row.
  assert.equal(
    live.document.sentToEmail,
    live.sentToEmail,
    'the read model must carry the recipient the send reported, or a reload has to guess',
  );
  assert.equal(fixture.document.sentToEmail, fixture.sentToEmail);
});

test('the send_invoice rejection codes the send dialog renders are the codes the engine emits', () => {
  const { ctx, store, workspaceId, invoiceId } = liveWorld({ transport: false });
  issueInvoice(ctx, { invoiceId, idempotencyKey: 'i1' });

  // P8 (M15): without the dial and without a human confirmation, the outbound step waits.
  const unconfirmed = sendInvoice(ctx, { invoiceId, idempotencyKey: 's0' });
  assert.equal(unconfirmed.ok, false);
  assert.equal(unconfirmed.error, 'needs_confirmation');

  // M18: no relay configured degrades honestly, and names the recipient it would have used.
  const noRelay = sendInvoice(ctx, { invoiceId, confirmed: true, idempotencyKey: 's1' });
  assert.equal(noRelay.ok, false);
  assert.equal(noRelay.error, 'needs_email_config');
  assert.equal(kindOf(noRelay.email), 'string');

  // OP4, and the arm the Studio had nothing mapped for: `workspace.email_relay` NAMES a relay while
  // nothing is wired behind it. A setting is not a transport, so this is its own refusal and not
  // `needs_email_config`. The dialog must offer the same ways out (PDF, Setup) rather than the
  // generic banner, or a user with a half-finished relay config is simply stuck.
  store.db.prepare("UPDATE workspace SET email_relay='local' WHERE id=?").run(workspaceId);
  const inert = sendInvoice(ctx, { invoiceId, confirmed: true, idempotencyKey: 's1b' });
  assert.equal(inert.ok, false);
  assert.equal(inert.error, 'needs_email_transport');
  assert.equal(inert.transmitted, false, 'a refusal must never look like a send');
  store.db.prepare('UPDATE workspace SET email_relay = NULL WHERE id = ?').run(workspaceId);

  // M17: no email on file, and the dialog must ask for one rather than invent it.
  store.db.prepare('UPDATE contact SET email = NULL WHERE workspace_id = ?').run(workspaceId);
  const noEmail = sendInvoice(ctx, { invoiceId, confirmed: true, idempotencyKey: 's2' });
  assert.equal(noEmail.ok, false);
  assert.equal(noEmail.error, 'needs_customer_email');
});
