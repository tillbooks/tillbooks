// A32, eBill issuing engine (spec §8): the delivery machine's business rules, the reconciled OI1
// conformance boundary, the OP4 connector split, transmit idempotency + at-least-once, the mirrored
// partner status, §H-TENANT, and the load-bearing invariant that A32 POSTS NOTHING (P3 by absence).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { makeContext } from '../../dist/core/context.js';
import { fixedClock } from '../../dist/core/clock.js';
import { sequenceIdGen } from '../../dist/core/ids.js';
import { createWorkspace, setCreditorProfile } from '../../dist/core/setup/index.js';
import { seedTaxCodes } from '../../dist/core/vat/index.js';
import { getFileContent } from '../../dist/core/files/index.js';
import {
  createDocument,
  issueInvoice,
  transitionDocument,
  getDocument,
  renderInvoicePdf,
  buildQrBill,
  setEbillConfig,
  getEbillConfig,
  prepareEbill,
  transmitEbill,
  getEbillDeliveryStatus,
  mirrorEbillPartnerStatus,
} from '../../dist/core/sales/index.js';

const AT = '2026-07-16T00:00:00.000Z';
const CREDITOR = {
  creditorName: 'Nomadik GmbH',
  address: { street: 'Bahnhofstrasse', buildingNo: '1', zip: '8000', town: 'Zürich', country: 'CH' },
  qrIban: 'CH4431999123000889012',
};
const VALID_PID = '41000000000000000';

/** A stub renderer that declares a conformant PDF/A-3b payload, to exercise the post-OI1 transmit path
 *  WITHOUT a second render pipeline. Production always uses the real `renderInvoicePdf` (pdfaProfile
 *  null), proven by the recorded-fact tests below. */
const CONFORMANT_RENDER = {
  renderInvoicePdf: () => ({
    ok: true,
    pdf: {
      base64: Buffer.from('%PDF-1.4 conformant eBill payload bytes').toString('base64'),
      byteLength: 39,
      hasQrBill: true,
      qrUnavailable: null,
      pdfaProfile: 'PDF/A-3b',
    },
  }),
};

function mockConnector() {
  const calls = [];
  return {
    calls,
    port: {
      submit(req) {
        calls.push(req);
        return { ok: true, businessCaseId: `NWPBCID-${calls.length}` };
      },
    },
  };
}

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
  return { ctx, store, workspaceId, deps, contactId, clock, ids };
}

/** Create + issue an invoice, returning its id. */
function issuedInvoice(ctx, contactId, key = 'inv') {
  const doc = createDocument(ctx, {
    workspaceId: ctx.workspaceId,
    type: 'invoice',
    contactId,
    currency: 'CHF',
    lines: [{ description: 'Beratung', unitPriceMinor: 100000, taxCode: 'UST81' }],
    idempotencyKey: `${key}-doc`,
  });
  assert.equal(doc.ok, true, JSON.stringify(doc));
  const id = doc.document.id;
  const iss = issueInvoice(ctx, { workspaceId: ctx.workspaceId, invoiceId: id, idempotencyKey: `${key}-issue` });
  assert.equal(iss.ok, true, JSON.stringify(iss));
  return id;
}

function rowCount(store, table, workspaceId) {
  return store.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE workspace_id = ?`).get(workspaceId).n;
}

// --- config ------------------------------------------------------------------------------------

test('A32: setEbillConfig validates the SWP billerPid shape and reads back; naturally idempotent', () => {
  const { ctx } = setup();
  assert.equal(getEbillConfig(ctx).config, null);

  for (const bad of ['31000000000000000', '4100000000000000', '410000000000000000', '41abcdef000000000', '']) {
    const r = setEbillConfig(ctx, { billerPid: bad });
    assert.equal(r.ok, false, `expected refusal for ${bad}`);
    assert.equal(r.error, 'invalid_biller_pid');
  }
  assert.equal(getEbillConfig(ctx).config, null, 'a refused config persists nothing');

  const ok1 = setEbillConfig(ctx, { billerPid: VALID_PID });
  assert.equal(ok1.ok, true);
  assert.equal(ok1.config.billerPid, VALID_PID);
  assert.equal(getEbillConfig(ctx).config.billerPid, VALID_PID);
  // Natural idempotency: re-asserting the same absolute state converges to one row.
  setEbillConfig(ctx, { billerPid: VALID_PID });
  const n = ctx.store.db.prepare('SELECT COUNT(*) AS n FROM ebill_config WHERE workspace_id = ?').get(ctx.workspaceId).n;
  assert.equal(n, 1);
});

// --- prepare -----------------------------------------------------------------------------------

test('A32: prepareEbill refuses draft/cancelled/settled and writes nothing', () => {
  const { ctx, store, contactId } = setup();
  // draft
  const doc = createDocument(ctx, {
    workspaceId: ctx.workspaceId,
    type: 'invoice',
    contactId,
    currency: 'CHF',
    lines: [{ description: 'X', unitPriceMinor: 100000, taxCode: 'UST81' }],
    idempotencyKey: 'd-doc',
  });
  const draftId = doc.document.id;
  const rDraft = prepareEbill(ctx, { invoiceId: draftId, idempotencyKey: 'p-draft' });
  assert.equal(rDraft.ok, false);
  assert.equal(rDraft.error, 'invalid_state');
  assert.equal(rowCount(store, 'ebill_deliveries', ctx.workspaceId), 0);

  // cancelled
  const cancId = issuedInvoice(ctx, contactId, 'canc');
  transitionDocument(ctx, { workspaceId: ctx.workspaceId, documentId: cancId, to: 'cancelled', idempotencyKey: 'c-x' });
  const rCanc = prepareEbill(ctx, { invoiceId: cancId, idempotencyKey: 'p-canc' });
  assert.equal(rCanc.ok, false);
  assert.equal(rCanc.error, 'invalid_state');

  // settled (forced): the same PREPARABLE_STATUSES guard refuses it.
  const setId = issuedInvoice(ctx, contactId, 'set');
  store.db.prepare("UPDATE document SET status = 'settled' WHERE workspace_id = ? AND id = ?").run(ctx.workspaceId, setId);
  const rSet = prepareEbill(ctx, { invoiceId: setId, idempotencyKey: 'p-set' });
  assert.equal(rSet.ok, false);
  assert.equal(rSet.error, 'invalid_state');
  assert.equal(rowCount(store, 'ebill_deliveries', ctx.workspaceId), 0, 'no refusal wrote a delivery row');
});

test('A32: prepareEbill records conformance facts honestly (pdfaProfile null, ebill-addressed true) and is idempotent by outcome', () => {
  const { ctx } = setup();
  const inv = issuedInvoice(ctx, 'ct_1', 'a');
  const p1 = prepareEbill(ctx, { invoiceId: inv, idempotencyKey: 'p1' });
  assert.equal(p1.ok, true, JSON.stringify(p1));
  assert.equal(p1.delivery.status, 'prepared');
  assert.equal(p1.delivery.pdfaProfile, null, 'A11 emits no PDF/A profile (A32-OI1 deferred): recorded, never claimed');
  assert.equal(p1.delivery.ebillAddressed, true, 'A11 emits the eBill AltPmt element (A32-OI2 resolved)');

  // Re-prepare under the SAME key AND a DIFFERENT key returns the SAME active row: one active delivery.
  const p2 = prepareEbill(ctx, { invoiceId: inv, idempotencyKey: 'p1' });
  const p3 = prepareEbill(ctx, { invoiceId: inv, idempotencyKey: 'DIFFERENT' });
  assert.equal(p2.delivery.id, p1.delivery.id);
  assert.equal(p3.delivery.id, p1.delivery.id);
  assert.equal(rowCount(ctx.store, 'ebill_deliveries', ctx.workspaceId), 1, 'no duplicate delivery');
});

test('A32: after a failed delivery, prepareEbill mints a successor and the one-active index still holds', () => {
  const conn = { submit: () => ({ ok: false, reason: 'partner_refused' }) };
  const { ctx } = setup({ ebillTransmitter: conn });
  const inv = issuedInvoice(ctx, 'ct_1', 'f');
  setEbillConfig(ctx, { billerPid: VALID_PID });
  const p1 = prepareEbill(ctx, { invoiceId: inv, idempotencyKey: 'fp1' }, CONFORMANT_RENDER);
  assert.equal(p1.ok, true);
  const t = transmitEbill(ctx, { deliveryId: p1.delivery.id, confirmed: true, idempotencyKey: 'ft1' });
  assert.equal(t.ok, false);
  assert.equal(t.error, 'transmit_failed');
  const failed = getEbillDeliveryStatus(ctx, { deliveryId: p1.delivery.id });
  assert.equal(failed.delivery.status, 'failed');

  // A successor may now be minted; the partial unique index counts only non-failed rows.
  const p2 = prepareEbill(ctx, { invoiceId: inv, idempotencyKey: 'fp2' }, CONFORMANT_RENDER);
  assert.equal(p2.ok, true);
  assert.notEqual(p2.delivery.id, p1.delivery.id);
  assert.equal(rowCount(ctx.store, 'ebill_deliveries', ctx.workspaceId), 2);
});

test('A32: the prepared artifact is A11 renderInvoicePdf byte-for-byte, carrying A11 QR reference intact', () => {
  const { ctx } = setup();
  const inv = issuedInvoice(ctx, 'ct_1', 'b');
  const p = prepareEbill(ctx, { invoiceId: inv, idempotencyKey: 'bp' });
  const stored = getFileContent(ctx, { fileId: p.delivery.artifactDocumentId });
  assert.equal(stored.ok, true, JSON.stringify(stored));
  // The delivery carries A11's OWN rendered bytes, unmodified: A32 packages, it never re-renders a
  // second payload that could drift from the invoice's statutory QR reference.
  const rendered = renderInvoicePdf(ctx, inv);
  assert.equal(stored.contentBase64, rendered.pdf.base64, 'the stored payload is A11 renderInvoicePdf verbatim');
  // And the QR reference the payload advertises is A11's own, carried into the eBill addressing.
  const qr = buildQrBill(ctx, inv);
  assert.equal(qr.ok, true);
  assert.ok(qr.qr.swissQrPayload.includes(qr.qr.reference), 'the payload carries A11 QR reference');
  assert.ok(/\neBill\/B\//.test(qr.qr.swissQrPayload), 'and the eBill AltPmt addressing element (A32-OI2 resolved in A11)');
});

// --- transmit / OP4 boundary -------------------------------------------------------------------

test('A32: transmit without a connector returns cloud_tier, leaves status prepared, even with no biller_pid', () => {
  const { ctx } = setup(); // no ebillTransmitter wired
  const inv = issuedInvoice(ctx, 'ct_1', 'ct');
  const p = prepareEbill(ctx, { invoiceId: inv, idempotencyKey: 'ctp' });
  const t = transmitEbill(ctx, { deliveryId: p.delivery.id, confirmed: true, idempotencyKey: 'ctt' });
  assert.equal(t.ok, true, 'the honest OP4 shape is a success, not an error');
  assert.equal(t.transmitted, false);
  assert.equal(t.reason, 'cloud_tier');
  assert.equal(getEbillDeliveryStatus(ctx, { deliveryId: p.delivery.id }).delivery.status, 'prepared');
});

test('A32: transmit guard order: connector, then needs_biller_pid, then needs_confirmation, then payload_not_conformant', () => {
  const conn = mockConnector();
  const { ctx } = setup({ ebillTransmitter: conn.port });
  const inv = issuedInvoice(ctx, 'ct_1', 'g');
  const p = prepareEbill(ctx, { invoiceId: inv, idempotencyKey: 'gp' }); // real render: pdfaProfile null

  // connector present but no biller_pid
  let t = transmitEbill(ctx, { deliveryId: p.delivery.id, confirmed: true, idempotencyKey: 'g1' });
  assert.equal(t.error, 'needs_biller_pid');

  setEbillConfig(ctx, { billerPid: VALID_PID });
  // biller present, but not confirmed and dial off -> P8
  t = transmitEbill(ctx, { deliveryId: p.delivery.id, idempotencyKey: 'g2' });
  assert.equal(t.error, 'needs_confirmation');

  // confirmed, but the real payload is not PDF/A-3b -> the reconciled OI1 boundary bites
  t = transmitEbill(ctx, { deliveryId: p.delivery.id, confirmed: true, idempotencyKey: 'g3' });
  assert.equal(t.error, 'payload_not_conformant');
  assert.ok(t.missing.some((m) => m.includes('pdfa_profile')), JSON.stringify(t.missing));
  assert.equal(conn.calls.length, 0, 'nothing non-conformant ever reached the connector');
});

test('A32: a conformant payload transmits, records the business case, and drives A10 issued->sent once', () => {
  const conn = mockConnector();
  const { ctx } = setup({ ebillTransmitter: conn.port });
  setEbillConfig(ctx, { billerPid: VALID_PID });
  const inv = issuedInvoice(ctx, 'ct_1', 'h');
  const p = prepareEbill(ctx, { invoiceId: inv, idempotencyKey: 'hp' }, CONFORMANT_RENDER);
  assert.equal(p.delivery.pdfaProfile, 'PDF/A-3b');

  const t = transmitEbill(ctx, { deliveryId: p.delivery.id, confirmed: true, idempotencyKey: 'ht' });
  assert.equal(t.ok, true, JSON.stringify(t));
  assert.equal(t.transmitted, true);
  assert.equal(t.transmittedDeliveryId, p.delivery.id);
  assert.equal(t.delivery.status, 'transmitted');
  assert.equal(t.delivery.businessCaseId, 'NWPBCID-1');
  assert.equal(t.delivery.correlationId, 'ht');
  assert.equal(getDocument(ctx, { documentId: inv }).document.status, 'sent', 'one lifecycle: transmit drove issued->sent');
  assert.equal(conn.calls.length, 1);
  assert.equal(conn.calls[0].billerPid, VALID_PID);
  assert.equal(conn.calls[0].format, 'qrbill');
  assert.equal(conn.calls[0].bcFunction, 'bill');

  // A second transmit, same key or a fresh key, resubmits NOTHING and returns the recorded result.
  const again = transmitEbill(ctx, { deliveryId: p.delivery.id, confirmed: true, idempotencyKey: 'ht' });
  assert.equal(again.transmitted, true);
  const freshKey = transmitEbill(ctx, { deliveryId: p.delivery.id, confirmed: true, idempotencyKey: 'ht-2' });
  assert.equal(freshKey.transmitted, true);
  assert.equal(conn.calls.length, 1, 'the mock connector was called EXACTLY once (no double-send)');
});

test('A32: the A10 sent delegation is a no-op against an already-sent invoice (no illegal_transition)', () => {
  const conn = mockConnector();
  const { ctx } = setup({ ebillTransmitter: conn.port });
  setEbillConfig(ctx, { billerPid: VALID_PID });
  const inv = issuedInvoice(ctx, 'ct_1', 'no');
  transitionDocument(ctx, { workspaceId: ctx.workspaceId, documentId: inv, to: 'sent', idempotencyKey: 'no-sent' });
  const p = prepareEbill(ctx, { invoiceId: inv, idempotencyKey: 'nop' }, CONFORMANT_RENDER);
  const t = transmitEbill(ctx, { deliveryId: p.delivery.id, confirmed: true, idempotencyKey: 'not' });
  assert.equal(t.ok, true, JSON.stringify(t));
  assert.equal(t.delivery.status, 'transmitted');
  assert.equal(getDocument(ctx, { documentId: inv }).document.status, 'sent', 'no re-driven transition, no error');
});

test('A32: transmit on a failed delivery returns invalid_state; a submitting row resubmits with the STORED correlation id and mints no second row', () => {
  const conn = mockConnector();
  const { ctx, store } = setup({ ebillTransmitter: conn.port });
  setEbillConfig(ctx, { billerPid: VALID_PID });
  const inv = issuedInvoice(ctx, 'ct_1', 's');
  const p = prepareEbill(ctx, { invoiceId: inv, idempotencyKey: 'sp' }, CONFORMANT_RENDER);

  // Simulate a crash window: the row sits at `submitting` with a stored correlation id.
  store.db
    .prepare("UPDATE ebill_deliveries SET status = 'submitting', correlation_id = 'crash-corr' WHERE workspace_id = ? AND id = ?")
    .run(ctx.workspaceId, p.delivery.id);
  const t = transmitEbill(ctx, { deliveryId: p.delivery.id, confirmed: true, idempotencyKey: 'brand-new-key' });
  assert.equal(t.ok, true, JSON.stringify(t));
  assert.equal(conn.calls[0].correlationId, 'crash-corr', 'the retry reused the STORED correlation id, not the new key');
  assert.equal(rowCount(store, 'ebill_deliveries', ctx.workspaceId), 1, 'no second local row');

  // Now it is transmitted; transmit refuses a failed row with invalid_state.
  store.db.prepare("UPDATE ebill_deliveries SET status = 'failed' WHERE workspace_id = ? AND id = ?").run(ctx.workspaceId, p.delivery.id);
  const f = transmitEbill(ctx, { deliveryId: p.delivery.id, confirmed: true, idempotencyKey: 'k' });
  assert.equal(f.ok, false);
  assert.equal(f.error, 'invalid_state');
});

// --- mirrored partner status -------------------------------------------------------------------

test('A32: mirrorEbillPartnerStatus stores each SWP value verbatim, an unknown value survives, and re-delivery of an eventId is a no-op', () => {
  const { ctx, store } = setup();
  const inv = issuedInvoice(ctx, 'ct_1', 'm');
  const p = prepareEbill(ctx, { invoiceId: inv, idempotencyKey: 'mp' });
  const id = p.delivery.id;

  for (const [i, s] of ['NWP_PENDING', 'OPEN', 'APPROVED', 'REJECTED', 'COMPLETED', 'SOME_FUTURE_VALUE'].entries()) {
    const r = mirrorEbillPartnerStatus(ctx, { deliveryId: id, eventId: `ev-${i}`, occurredAt: AT, partnerStatus: s, reason: i === 3 ? 'bad address' : undefined });
    assert.equal(r.ok, true);
    assert.equal(r.delivery.partnerStatus, s, `stored verbatim: ${s}`);
  }
  const status = getEbillDeliveryStatus(ctx, { deliveryId: id });
  assert.equal(status.events.length, 6, 'each event appended one row');
  assert.equal(status.delivery.partnerStatus, 'SOME_FUTURE_VALUE', 'an unknown reported value survives round-trip');

  // Re-delivery of the same eventId is a no-op (idempotent event stream).
  const dup = mirrorEbillPartnerStatus(ctx, { deliveryId: id, eventId: 'ev-0', occurredAt: AT, partnerStatus: 'OPEN' });
  assert.equal(dup.duplicate, true);
  assert.equal(getEbillDeliveryStatus(ctx, { deliveryId: id }).events.length, 6, 'no duplicate event row');
  assert.equal(rowCount(store, 'ebill_delivery_events', ctx.workspaceId), 6);
});

// --- §H-TENANT ---------------------------------------------------------------------------------

test('A32: a delivery in workspace A is invisible to workspace B (§H-TENANT)', () => {
  const a = setup();
  const invA = issuedInvoice(a.ctx, 'ct_1', 'ta');
  const pA = prepareEbill(a.ctx, { invoiceId: invA, idempotencyKey: 'tap' });

  // A second workspace on the SAME store.
  const wsB = createWorkspace(a.deps, { name: 'Andere GmbH' }).workspaceId;
  const ctxB = makeContext(a.store, { workspaceId: wsB, actor: 'user_2', clock: a.clock, ids: a.ids });
  const seen = getEbillDeliveryStatus(ctxB, { deliveryId: pA.delivery.id });
  assert.equal(seen.ok, false, 'B cannot read A’s delivery by id');
  assert.equal(getEbillDeliveryStatus(ctxB, { invoiceId: invA }).deliveries.length, 0, 'B’s list never carries A’s rows');
  const mirror = mirrorEbillPartnerStatus(ctxB, { deliveryId: pA.delivery.id, eventId: 'x', occurredAt: AT, partnerStatus: 'OPEN' });
  assert.equal(mirror.ok, false, 'B cannot mirror onto A’s delivery');
});

// --- P3 by absence: A32 POSTS NOTHING ----------------------------------------------------------

test('A32 POSTS NOTHING: no ledger/payment write path exists in the module, and prepare+transmit move no money rows', () => {
  const src = readFileSync(fileURLToPath(new URL('../../src/core/sales/ebill.ts', import.meta.url)), 'utf8');
  // Strip comments so a mention of postEntry in prose does not trip the guard, then assert no call.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '');
  assert.ok(!/\bpostEntry\s*\(/.test(code), 'ebill.ts must never CALL postEntry');
  assert.ok(!/\brecordPayment\s*\(/.test(code), 'ebill.ts must never CALL recordPayment');
  assert.ok(!/\breverseEntry\s*\(/.test(code), 'ebill.ts must never CALL reverseEntry');

  const conn = mockConnector();
  const { ctx, store } = setup({ ebillTransmitter: conn.port });
  setEbillConfig(ctx, { billerPid: VALID_PID });
  const inv = issuedInvoice(ctx, 'ct_1', 'p3');
  const jBefore = rowCount(store, 'journal_entry', ctx.workspaceId);
  const payBefore = rowCount(store, 'payment', ctx.workspaceId);
  const p = prepareEbill(ctx, { invoiceId: inv, idempotencyKey: 'p3p' }, CONFORMANT_RENDER);
  transmitEbill(ctx, { deliveryId: p.delivery.id, confirmed: true, idempotencyKey: 'p3t' });
  assert.equal(rowCount(store, 'journal_entry', ctx.workspaceId), jBefore, 'prepare+transmit posted no journal entry');
  assert.equal(rowCount(store, 'payment', ctx.workspaceId), payBefore, 'prepare+transmit recorded no payment');
});
