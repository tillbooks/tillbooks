/**
 * F-09 (friction ledger, Phase 2), J1.1 ideal step 3: the creditor IBAN saves WITHOUT the five
 * structured address fields, and the address is a deferral, never a refusal.
 *
 * THE DEFECT THIS EXISTS FOR. The first-hour path measured 52 extra keystrokes and a second save
 * because `set_creditor_profile` refused `needs_structured_address` for an IBAN alone. The QR-bill
 * really does need the address, but only when the first bill RENDERS: `buildQrBill` already refuses
 * `needs_creditor_address` at that moment, so storing the IBAN early costs nothing filing-grade.
 *
 * What stays refused: a PARTIAL address (half an address is a mistake), an explicit blank name, a
 * malformed IBAN, and an injected control character. What is new: no address keeps the stored one,
 * and no name defaults to the company name.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createWorkspace, setCreditorProfile, getCompanyProfile } from '../../dist/core/setup/index.js';
import { getAction } from '../../dist/api/registry.js';
import { setup } from './support.mjs';

const PLAIN_IBAN = 'CH9300762011623852957';
const ADDRESS = { street: 'Seestrasse', buildingNo: '12', zip: '8002', town: 'Zürich', country: 'CH' };

function fresh() {
  const { deps, ctxFor } = setup();
  const workspaceId = createWorkspace(deps, { name: 'Mara Design GmbH' }).workspaceId;
  return { deps, ctx: ctxFor(workspaceId), workspaceId };
}

test('an IBAN saves with no address at all, under the company name, and the address stays open', () => {
  const { ctx } = fresh();
  assert.equal(setCreditorProfile(ctx, { iban: PLAIN_IBAN }).ok, true);
  const { profile } = getCompanyProfile(ctx);
  assert.equal(profile.creditorIban, PLAIN_IBAN);
  assert.equal(profile.creditorName, 'Mara Design GmbH', 'the creditor name defaults to the company name');
  assert.equal(profile.creditorAddress, null, 'no address was invented');
});

test('an all-blank address object (what a form with empty fields sends) counts as no address', () => {
  const { ctx } = fresh();
  const blank = { street: '', buildingNo: '', zip: '', town: '', country: '' };
  assert.equal(setCreditorProfile(ctx, { creditorName: 'Mara Design GmbH', address: blank, iban: PLAIN_IBAN }).ok, true);
  assert.equal(getCompanyProfile(ctx).profile.creditorAddress, null);
});

test('a PARTIAL address is still refused with needs_structured_address, and nothing is written', () => {
  const { ctx } = fresh();
  const res = setCreditorProfile(ctx, { address: { street: 'Seestrasse' }, iban: PLAIN_IBAN });
  assert.equal(res.error, 'needs_structured_address');
  assert.equal(getCompanyProfile(ctx).profile.creditorIban, null, 'a refusal stores nothing');
});

test('saving the IBAN again without an address keeps the address stored earlier', () => {
  const { ctx } = fresh();
  assert.equal(setCreditorProfile(ctx, { creditorName: 'Mara Design GmbH', address: ADDRESS, iban: PLAIN_IBAN }).ok, true);
  assert.equal(setCreditorProfile(ctx, { iban: 'CH4431999123000889012' }).ok, true);
  const { profile } = getCompanyProfile(ctx);
  assert.equal(profile.creditorIban, 'CH4431999123000889012');
  assert.deepEqual(profile.creditorAddress, ADDRESS, 'the stored address survived an IBAN-only save');
});

test('an explicit blank name is still invalid_name; an explicit name wins over the default', () => {
  const { ctx } = fresh();
  assert.equal(setCreditorProfile(ctx, { creditorName: '   ', iban: PLAIN_IBAN }).error, 'invalid_name');
  assert.equal(setCreditorProfile(ctx, { creditorName: 'Mara Design', iban: PLAIN_IBAN }).ok, true);
  assert.equal(getCompanyProfile(ctx).profile.creditorName, 'Mara Design');
});

test('the advertised two-step flow: save IBAN, add the address in a SECOND call, the IBAN survives and the QR-bill renders', () => {
  // The exact lifecycle the verb sells: the IBAN saves without the address, the address is added
  // later. A follow-up call that carries only the address must PRESERVE the stored IBAN, not null
  // it. Reproduced through the getAction (agent/REST) boundary, which is the product thesis and the
  // one the Studio masks by re-sending the IBAN every time.
  const { deps, ctx, workspaceId } = fresh();
  const call = (name, input) => getAction(name).run(deps, { workspaceId, ...input });

  assert.equal(call('set_creditor_profile', { iban: PLAIN_IBAN }).ok, true, 'step 1: the IBAN saves alone');
  assert.equal(call('set_creditor_profile', { address: ADDRESS }).ok, true, 'step 2: the address is added later');

  const { profile } = getCompanyProfile(ctx);
  assert.equal(profile.creditorIban, PLAIN_IBAN, 'the IBAN saved in step 1 must survive an address-only follow-up');
  assert.deepEqual(profile.creditorAddress, ADDRESS, 'the address added in step 2 is stored');

  // The bill the whole flow exists to produce must now render: no needs_qr_iban, no needs_creditor_address.
  const contact = call('create_contact', {
    name: 'Bergblick AG',
    partyRole: 'customer',
    address: { street: 'Bergweg', houseNo: '3', zip: '3000', city: 'Bern', country: 'CH' },
    idempotencyKey: 'c-2step',
  });
  assert.equal(contact.ok, true, JSON.stringify(contact));
  const doc = call('create_document', {
    type: 'invoice',
    contactId: contact.contact.id,
    currency: 'CHF',
    lines: [{ description: 'Beratung', unitPriceMinor: 120000 }],
    idempotencyKey: 'd-2step',
  });
  assert.equal(doc.ok, true, JSON.stringify(doc));
  assert.equal(call('issue_invoice', { invoiceId: doc.document.id, idempotencyKey: 'i-2step' }).ok, true);
  const read = call('get_document', { documentId: doc.document.id, include: ['qr'] });
  assert.equal(read.ok, true, JSON.stringify(read));
  assert.notEqual(read.qr?.error, 'needs_qr_iban', `the IBAN must not have been erased: ${JSON.stringify(read.qr)}`);
  assert.notEqual(read.qr?.error, 'needs_creditor_address', `the address was supplied in step 2: ${JSON.stringify(read.qr)}`);
  assert.equal(read.qr?.error, undefined, `the QR-bill renders after the advertised two-step setup: ${JSON.stringify(read.qr)}`);
});

test('the symmetric case: a distinct creditor name set earlier survives an address-only follow-up', () => {
  // creditorName has the same omit-preserve contract as the IBAN. A caller that named a second
  // invoicing name in call 1 and then adds only the address in call 2 must keep that name, not have
  // it silently reset to the company name.
  const { deps, ctx, workspaceId } = fresh();
  const call = (name, input) => getAction(name).run(deps, { workspaceId, ...input });

  assert.equal(call('set_creditor_profile', { creditorName: 'Mara Studio', iban: PLAIN_IBAN }).ok, true);
  assert.equal(call('set_creditor_profile', { address: ADDRESS }).ok, true, 'the address is added later, the name is omitted');

  const { profile } = getCompanyProfile(ctx);
  assert.equal(profile.creditorName, 'Mara Studio', 'a distinct creditor name survives an address-only follow-up');
  assert.equal(profile.creditorIban, PLAIN_IBAN, 'and the IBAN survives alongside it');
  assert.deepEqual(profile.creditorAddress, ADDRESS);
});

test('the QR-bill gate still bites: buildQrBill needs the address, the invoice can still be issued', async () => {
  // The render-time gate is what makes deferring the address safe. Proven through the registry so the
  // boundary schema (address now optional) is part of the measurement.
  const { deps, workspaceId } = fresh();
  const call = (name, input) => getAction(name).run(deps, { workspaceId, ...input });
  assert.equal(call('set_creditor_profile', { iban: PLAIN_IBAN }).ok, true, 'the boundary accepts an IBAN alone');
  const contact = call('create_contact', {
    name: 'Bergblick AG',
    partyRole: 'customer',
    address: { street: 'Bergweg', houseNo: '3', zip: '3000', city: 'Bern', country: 'CH' },
    idempotencyKey: 'c-1',
  });
  assert.equal(contact.ok, true, JSON.stringify(contact));
  const doc = call('create_document', {
    type: 'invoice',
    contactId: contact.contact.id,
    currency: 'CHF',
    lines: [{ description: 'Beratung', unitPriceMinor: 120000 }],
    idempotencyKey: 'd-1',
  });
  assert.equal(doc.ok, true, JSON.stringify(doc));
  const documentId = doc.document.id;
  const issued = call('issue_invoice', { invoiceId: documentId, idempotencyKey: 'i-1' });
  assert.equal(issued.ok, true, `issue must not need the creditor address: ${JSON.stringify(issued)}`);
  const read = call('get_document', { documentId, include: ['qr'] });
  assert.equal(read.ok, true, JSON.stringify(read));
  assert.equal(read.qr?.error, 'needs_creditor_address', `the QR-bill, not the invoice, is what waits for the address: ${JSON.stringify(read.qr)}`);
});
