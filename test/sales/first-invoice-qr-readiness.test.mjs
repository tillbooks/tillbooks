/**
 * P0.4e, the engine half: the calls the issue dialog makes when it asks for the missing addresses
 * are the calls that turn the first invoice into a QR-bill.
 *
 * The first-run audit's company saved only an IBAN in Setup (A00's one-panel save, F-09: the address
 * is deferred until the first QR-bill) and created its customer inline with a name only. R-2026-0001
 * issued with `qr.available:false`. The Studio's `planQrFix` (`app/src/surfaces/Documents/
 * QrCompletion.tsx`, pinned by its own component test) emits `set_creditor_profile {creditorName,
 * address:{street,buildingNo,zip,town,country}, iban?}` and `update_contact {contactId, patch:{address:
 * {street,houseNo,zip,city,country}}}`. This suite drives exactly those shapes through the registry
 * and proves the invoice issued afterwards carries a payment part, and that without them it does
 * not, with the engine's own reason. All fixture values are synthetic.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';

const must = (res, what) => {
  assert.equal(res.ok, true, `${what} failed: ${JSON.stringify(res)}`);
  return res;
};

/** The audit's day-0 company: an IBAN and nothing else on the creditor, a customer with a name only. */
function dayZero(seed) {
  const deps = freshDeps();
  deps.actor = 'studio';
  const { workspaceId } = mintWorkspace(deps, 'Beispiel GmbH', `${seed}-ws`);
  const call = (name, input) => getAction(name).run(deps, { workspaceId, ...input });
  must(call('vat_seed_defaults', {}), 'vat seed');
  must(call('set_vat_method', { vatMethod: 'effektiv', vatAccounting: 'soll' }), 'vat method');
  must(call('set_creditor_profile', { iban: 'CH9300762011623852957' }), 'iban only');
  const contact = must(call('create_contact', { partyRole: 'customer', name: 'Muster AG', idempotencyKey: `${seed}-c` }), 'contact');
  const contactId = contact.contactId ?? contact.contact?.id;
  const draft = must(
    call('create_document', {
      type: 'invoice',
      contactId,
      lines: [{ description: 'Beratung', quantityMilli: 2000, unitPriceMinor: 15000, taxCode: 'UST81' }],
      idempotencyKey: `${seed}-d`,
    }),
    'draft',
  );
  return { call, contactId, invoiceId: draft.document.id };
}

test('P0.4e: without the addresses the first invoice issues with no payment part, and the engine says why', () => {
  const w = dayZero('without');
  const issued = must(w.call('issue_invoice', { invoiceId: w.invoiceId, idempotencyKey: 'without-issue' }), 'issue');
  assert.equal(issued.qr.available, false);
  assert.equal(issued.qr.reason, 'needs_creditor_address');
});

test('P0.4e: the dialog\'s two calls, then issue: the first invoice carries a QR-bill', () => {
  const w = dayZero('with');
  // Exactly the shapes planQrFix emits (creditor block + customer block).
  must(
    w.call('set_creditor_profile', {
      creditorName: 'Beispiel GmbH',
      address: { street: 'Seestrasse', buildingNo: '12', zip: '8001', town: 'Zürich', country: 'CH' },
    }),
    'creditor address',
  );
  must(
    w.call('update_contact', {
      contactId: w.contactId,
      patch: { address: { street: 'Musterweg', houseNo: '', zip: '3000', city: 'Bern', country: 'CH' } },
    }),
    'customer address',
  );
  const issued = must(w.call('issue_invoice', { invoiceId: w.invoiceId, idempotencyKey: 'with-issue' }), 'issue');
  assert.equal(issued.qr.available, true, JSON.stringify(issued.qr));
  assert.equal(issued.qr.referenceType, 'SCOR', 'a plain IBAN yields a SCOR reference');
  assert.match(issued.qr.swissQrPayload, /Seestrasse/);
  assert.match(issued.qr.swissQrPayload, /Musterweg/);
});
