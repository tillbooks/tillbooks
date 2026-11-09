// The email relay reaches `send_invoice` through the API layer, or nothing claims a send.
//
// `EmailRelayPort` is a typed seam on `WorkspaceContext` and `makeContext` carries it through, but
// the API layer is where a host actually wires one: `ApiDeps` is what MCP, the REST twins and the
// Studio bridge all hand to `action.run`. Until `ApiDeps` carried the port and `ctxOf` spread it,
// there was no way to reach the transport from any shipped surface at all, and the only thing that
// made `send_invoice` look like it worked was the stub behind `workspace.email_relay` that the money
// agent deleted: it returned `{ok:true}` without sending anything, so the verb reported
// `transmitted: true` and wrote a `sent` row into the audit trail with no email ever sent.
//
// So these tests inject a RECORDING double and assert against what it actually received. The rule
// they pin is the A11 US-A11.5 rule at the API boundary: no transport, no transmission claim.

import test from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { freshDeps, recordingRelay } from './support.mjs';

const EMAIL = 'billing@versand.example';

/** An issued invoice with a customer that has an email address, built through the registry. */
function issuedInvoice(deps) {
  const call = (name, input) => getAction(name).run(deps, input);
  const { workspaceId } = call('create_workspace', { name: 'Nomadik GmbH', idempotencyKey: 'ws' });
  const ws = { workspaceId };
  call('vat_seed_defaults', ws);
  call('set_vat_method', { ...ws, vatMethod: 'effektiv', vatAccounting: 'soll' });
  call('set_creditor_profile', {
    ...ws,
    creditorName: 'Nomadik GmbH',
    address: { street: 'Bahnhofstrasse', buildingNo: '1', zip: '8000', town: 'Zürich', country: 'CH' },
    qrIban: 'CH4431999123000889012',
  });
  const contact = call('create_contact', {
    ...ws,
    partyRole: 'customer',
    name: 'Versand AG',
    address: { street: 'Musterstrasse', houseNo: '5', zip: '3000', city: 'Bern', country: 'CH' },
    email: EMAIL,
    idempotencyKey: 'ct-1',
  });
  const doc = call('create_document', {
    ...ws,
    type: 'invoice',
    contactId: contact.contact.id,
    currency: 'CHF',
    lines: [{ description: 'Beratung', unitPriceMinor: 100000, taxCode: 'UST81' }],
    idempotencyKey: 'doc-1',
  });
  const issued = call('issue_invoice', { ...ws, invoiceId: doc.document.id, idempotencyKey: 'iss-1' });
  assert.ok(issued.ok, JSON.stringify(issued));
  return { workspaceId, invoiceId: doc.document.id, call };
}

/** What the stored records claim about a transmission, read straight off the rows. */
function evidence(deps, workspaceId, invoiceId) {
  return {
    sentToEmail: deps.store.db
      .prepare('SELECT sent_to_email FROM document WHERE workspace_id = ? AND id = ?')
      .get(workspaceId, invoiceId).sent_to_email,
    sentRows: deps.store.db
      .prepare("SELECT count(*) AS n FROM document_status_history WHERE document_id = ? AND to_status = 'sent'")
      .get(invoiceId).n,
  };
}

test('API seam: with NO relay wired into ApiDeps, send_invoice claims nothing and records nothing', () => {
  const deps = freshDeps();
  const { workspaceId, invoiceId, call } = issuedInvoice(deps);

  const res = call('send_invoice', { workspaceId, invoiceId, confirmed: true, idempotencyKey: 'snd-1' });
  assert.equal(res.ok, false, `no transport must mean no send: ${JSON.stringify(res)}`);
  assert.equal(res.error, 'needs_email_config');
  assert.equal(res.transmitted, false);
  assert.deepEqual(evidence(deps, workspaceId, invoiceId), { sentToEmail: null, sentRows: 0 });
});

test('API seam: a relay on ApiDeps reaches the verb, and the claim matches what it received', () => {
  const relay = recordingRelay();
  const deps = { ...freshDeps(), emailRelay: relay };
  const { workspaceId, invoiceId, call } = issuedInvoice(deps);

  const res = call('send_invoice', { workspaceId, invoiceId, confirmed: true, idempotencyKey: 'snd-1' });
  assert.ok(res.ok, `an injected transport must be reachable from the API layer: ${JSON.stringify(res)}`);
  assert.equal(res.transmitted, true);
  // The claim is only true because the transport really got the message.
  assert.equal(relay.sent.length, 1, 'exactly one message must have reached the transport');
  assert.equal(relay.sent[0].to, EMAIL);
  assert.ok(relay.sent[0].pdfBase64.length > 0, 'the PDF must be handed to the transport, not promised');
  assert.deepEqual(evidence(deps, workspaceId, invoiceId), { sentToEmail: EMAIL, sentRows: 1 });
});

test('API seam: a replayed send transmits at most once, counted on the TRANSPORT', () => {
  const relay = recordingRelay();
  const deps = { ...freshDeps(), emailRelay: relay };
  const { workspaceId, invoiceId, call } = issuedInvoice(deps);
  const input = { workspaceId, invoiceId, confirmed: true, idempotencyKey: 'snd-1' };

  const first = call('send_invoice', input);
  const second = call('send_invoice', input);
  assert.deepEqual(second, first, 'the replay must return the original Result');
  assert.equal(relay.sent.length, 1, 'a retry must not put a second email on the wire');
  assert.deepEqual(evidence(deps, workspaceId, invoiceId), { sentToEmail: EMAIL, sentRows: 1 });
});

test('API seam: a transport that REFUSES leaves the audit trail silent about a send', () => {
  const relay = recordingRelay({ ok: false, reason: 'smtp_unreachable' });
  const deps = { ...freshDeps(), emailRelay: relay };
  const { workspaceId, invoiceId, call } = issuedInvoice(deps);

  const res = call('send_invoice', { workspaceId, invoiceId, confirmed: true, idempotencyKey: 'snd-1' });
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.equal(res.transmitted, false);
  assert.equal(relay.sent.length, 1, 'the transport was reached');
  assert.deepEqual(
    evidence(deps, workspaceId, invoiceId),
    { sentToEmail: null, sentRows: 0 },
    'nothing left the building, so nothing may be recorded as having left it',
  );
});
