// A11 US-A11.5: `sendInvoice` and the email relay. The audit trail must not be able to lie.
//
// THE HARD RULE these tests pin: no code path may write a `sent` status record, set `sent_to_email`,
// or return `transmitted: true` without a real transmission having occurred.
//
// The defects they were written against:
//  - MAJOR 3: `emailRelay` resolved in two steps and both were dead or dishonest. `ctx.emailRelay`
//    was not a member of `WorkspaceContext` and `makeContext` dropped it, so only test files could
//    ever set it. `workspace.email_relay` had no writer anywhere in src or app/src, and when set by
//    hand it returned `{ send: () => ({ ok: true }) }`: a stub. `sendInvoice` then reported
//    `transmitted: true`, wrote `sent_to_email`, and appended a `sent` row to the status history
//    with no email ever sent.
//  - MINOR 1: "a retry transmits at most once" was false after a post-transmit fault. The transport
//    call sat INSIDE the idempotency transaction, so a fault after `relay.send` returned ok rolled
//    the idempotency row back and the retry sent a second email.

import test from 'node:test';
import assert from 'node:assert/strict';

import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { makeContext } from '../../dist/core/context.js';
import { fixedClock } from '../../dist/core/clock.js';
import { sequenceIdGen } from '../../dist/core/ids.js';
import { createWorkspace, setCreditorProfile } from '../../dist/core/setup/index.js';
import { seedTaxCodes } from '../../dist/core/vat/index.js';
import { createDocument, issueInvoice, sendInvoice } from '../../dist/core/sales/index.js';

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
  store.db
    .prepare(
      `INSERT INTO contact (id, workspace_id, party_role, name, address_street, address_house_no, address_zip, address_city, address_country, email, default_currency, payment_terms_days, created_at)
       VALUES ('ct_1', ?, 'customer', 'Muster AG', 'Musterstrasse', '5', '3000', 'Bern', 'CH', 'billing@muster.example', 'CHF', 30, ?)`,
    )
    .run(workspaceId, AT);
  return { ctx, store, workspaceId, contactId: 'ct_1' };
}

function issuedInvoice(ctx) {
  const doc = createDocument(ctx, {
    type: 'invoice',
    contactId: 'ct_1',
    currency: 'CHF',
    lines: [{ description: 'Beratung', unitPriceMinor: 100000, taxCode: 'UST81' }],
  });
  const res = issueInvoice(ctx, { invoiceId: doc.document.id });
  assert.ok(res.ok, JSON.stringify(res));
  return doc.document.id;
}

/** Everything the audit trail claims about a transmission, straight off the rows. */
function transmissionEvidence(store, id) {
  return {
    status: store.db.prepare('SELECT status FROM document WHERE id = ?').get(id).status,
    sentToEmail: store.db.prepare('SELECT sent_to_email AS e FROM document WHERE id = ?').get(id).e,
    sentRows: store.db
      .prepare("SELECT COUNT(*) AS n FROM document_status_history WHERE document_id = ? AND to_status = 'sent'")
      .get(id).n,
  };
}

// --- MAJOR 3: no fake success -------------------------------------------------------------------

test('MAJOR 3: workspace.email_relay set with NO transport reports honestly and transmits nothing', () => {
  const { ctx, store, workspaceId } = setup();
  store.db.prepare("UPDATE workspace SET email_relay = 'smtp' WHERE id = ?").run(workspaceId);
  const id = issuedInvoice(ctx);

  const res = sendInvoice(ctx, { invoiceId: id, idempotencyKey: 'k1', confirmed: true });
  assert.equal(res.ok, false, `a configured-but-unwired relay must NOT report success: ${JSON.stringify(res)}`);
  assert.equal(res.error, 'needs_email_transport');
  assert.equal(res.transmitted, false);

  const ev = transmissionEvidence(store, id);
  assert.equal(ev.status, 'issued', 'the status stays issued');
  assert.equal(ev.sentToEmail, null, 'sent_to_email is NOT written without a transmission');
  assert.equal(ev.sentRows, 0, 'no `sent` row may exist without a transmission');
});

test('MAJOR 3: no relay configured at all degrades to the spec shape {ok:false, needs_email_config, transmitted:false}', () => {
  const { ctx, store } = setup();
  const id = issuedInvoice(ctx);
  const res = sendInvoice(ctx, { invoiceId: id, idempotencyKey: 'k2', confirmed: true });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'needs_email_config');
  assert.equal(res.transmitted, false, 'US-A11.5 words this shape verbatim');
  assert.deepEqual(transmissionEvidence(store, id), { status: 'issued', sentToEmail: null, sentRows: 0 });
});

test('MAJOR 3: EVERY rejection carries transmitted:false and leaves no trace of a send', () => {
  const cases = [
    ['needs_customer_email', (ctx, store, id) => {
      store.db.prepare('UPDATE contact SET email = NULL WHERE id = ?').run('ct_1');
      return sendInvoice(ctx, { invoiceId: id, confirmed: true });
    }],
    ['needs_confirmation', (ctx, _store, id) => sendInvoice(ctx, { invoiceId: id })],
    ['needs_email_config', (ctx, _store, id) => sendInvoice(ctx, { invoiceId: id, confirmed: true })],
  ];
  for (const [expected, run] of cases) {
    const { ctx, store } = setup();
    const id = issuedInvoice(ctx);
    const res = run(ctx, store, id);
    assert.equal(res.ok, false, `${expected}: ${JSON.stringify(res)}`);
    assert.equal(res.error, expected);
    assert.equal(res.transmitted, false, `${expected} must state transmitted:false`);
    assert.deepEqual(transmissionEvidence(store, id), { status: 'issued', sentToEmail: null, sentRows: 0 });
  }
});

test('MAJOR 3: the relay is a TYPED context seam that makeContext carries through', () => {
  const box = [];
  const relay = { send: (msg) => { box.push(msg); return { ok: true }; } };
  // No cast, no monkey-patch after construction: the host passes it to makeContext like any port.
  const { ctx, store } = setup({ emailRelay: relay });
  assert.equal(ctx.emailRelay, relay, 'makeContext must not drop the relay');

  const id = issuedInvoice(ctx);
  const res = sendInvoice(ctx, { invoiceId: id, idempotencyKey: 'k3', confirmed: true });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.transmitted, true);
  assert.equal(box.length, 1);
  assert.deepEqual(transmissionEvidence(store, id), {
    status: 'sent',
    sentToEmail: 'billing@muster.example',
    sentRows: 1,
  });
});

test('MAJOR 3: a relay that refuses leaves the audit trail silent about a send', () => {
  const relay = { send: () => ({ ok: false, reason: 'smtp_down' }) };
  const { ctx, store } = setup({ emailRelay: relay });
  const id = issuedInvoice(ctx);
  const res = sendInvoice(ctx, { invoiceId: id, idempotencyKey: 'k4', confirmed: true });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'email_send_failed');
  assert.equal(res.transmitted, false);
  assert.deepEqual(transmissionEvidence(store, id), { status: 'issued', sentToEmail: null, sentRows: 0 });
});

// --- MINOR 1: an outbound side effect cannot live inside a transaction that can roll back --------

test('MINOR 1: a post-transmit fault does NOT let the retry send a second email', () => {
  let invocations = 0;
  const relay = {
    send: () => {
      invocations += 1;
      return { ok: true };
    },
  };
  const { ctx, store } = setup({ emailRelay: relay });
  const id = issuedInvoice(ctx);

  // A fault AFTER the transport returned ok: the status flip throws. The old code ran the transport
  // inside the idempotency transaction, so the rollback erased the record that it had transmitted.
  const realPrepare = store.db.prepare.bind(store.db);
  let armed = true;
  store.db.prepare = (sql) => {
    if (armed && sql.includes('UPDATE document SET sent_to_email')) {
      armed = false;
      throw new Error('simulated post-transmit fault');
    }
    return realPrepare(sql);
  };

  let threw = null;
  try {
    sendInvoice(ctx, { invoiceId: id, idempotencyKey: 'k-retry', confirmed: true });
  } catch (e) {
    threw = e.message;
  }
  store.db.prepare = realPrepare;
  assert.equal(invocations, 1, 'the first attempt reached the transport exactly once');
  assert.equal(threw, 'simulated post-transmit fault');

  // The retry with the SAME key must not transmit again. It knows a transmission already happened.
  const retried = sendInvoice(ctx, { invoiceId: id, idempotencyKey: 'k-retry', confirmed: true });
  assert.equal(invocations, 1, `TOTAL TRANSPORT INVOCATIONS must stay 1, got ${invocations}`);
  assert.notEqual(retried.transmitted, false, `the retry must not claim nothing was sent: ${JSON.stringify(retried)}`);
});

test('MINOR 1: a fault whose outcome is UNKNOWN never re-transmits on retry', () => {
  let invocations = 0;
  const relay = {
    send: () => {
      invocations += 1;
      throw new Error('connection reset mid-DATA');
    },
  };
  const { ctx, store } = setup({ emailRelay: relay });
  const id = issuedInvoice(ctx);

  assert.throws(() => sendInvoice(ctx, { invoiceId: id, idempotencyKey: 'k-unknown', confirmed: true }));
  assert.equal(invocations, 1);

  // The transport threw: whether the mail left the building is unknowable. A retry must refuse
  // rather than gamble on a duplicate.
  const retried = sendInvoice(ctx, { invoiceId: id, idempotencyKey: 'k-unknown', confirmed: true });
  assert.equal(invocations, 1, 'the retry must NOT transmit again');
  assert.equal(retried.ok, false, JSON.stringify(retried));
  assert.equal(retried.error, 'send_outcome_unknown');
  // Nothing is claimed either way in the audit trail.
  assert.deepEqual(transmissionEvidence(store, id), { status: 'issued', sentToEmail: null, sentRows: 0 });
});

test('MINOR 1: the happy path still transmits exactly once per key (M-2 does not regress)', () => {
  let invocations = 0;
  const relay = { send: () => { invocations += 1; return { ok: true }; } };
  const { ctx, store } = setup({ emailRelay: relay });
  const id = issuedInvoice(ctx);

  const first = sendInvoice(ctx, { invoiceId: id, idempotencyKey: 'k-happy', confirmed: true });
  const second = sendInvoice(ctx, { invoiceId: id, idempotencyKey: 'k-happy', confirmed: true });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(second.transmitted, true);
  assert.equal(second.sentToEmail, first.sentToEmail);
  assert.equal(invocations, 1);
  assert.equal(transmissionEvidence(store, id).sentRows, 1, 'exactly one `sent` row');
});

test('MINOR 1: a refused relay is still not memoised, so a later retry may transmit once', () => {
  let fail = true;
  let invocations = 0;
  const relay = {
    send: () => {
      if (fail) return { ok: false, reason: 'smtp_down' };
      invocations += 1;
      return { ok: true };
    },
  };
  const { ctx, store } = setup({ emailRelay: relay });
  const id = issuedInvoice(ctx);

  const failed = sendInvoice(ctx, { invoiceId: id, idempotencyKey: 'k-clears', confirmed: true });
  assert.equal(failed.error, 'email_send_failed');
  fail = false;
  const retried = sendInvoice(ctx, { invoiceId: id, idempotencyKey: 'k-clears', confirmed: true });
  assert.equal(retried.ok, true, JSON.stringify(retried));
  assert.equal(invocations, 1, 'exactly one successful transmission');
  assert.equal(transmissionEvidence(store, id).sentRows, 1);
});
