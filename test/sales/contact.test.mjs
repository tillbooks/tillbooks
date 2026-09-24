import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createContact,
  updateContact,
  archiveContact,
  unarchiveContact,
  getContact,
  listContacts,
} from '../../dist/core/sales/index.js';
import { setup, newWorkspace } from './support.mjs';

test('createContact stamps workspace_id, defaults, and round-trips through getContact', () => {
  const { ctx, workspaceId } = setup();
  const made = createContact(ctx, {
    partyRole: 'customer',
    name: 'Muster AG',
    address: { street: 'Bahnhofstrasse', houseNo: '1', zip: '8001', city: 'Zürich', country: 'CH' },
    vatNumber: 'CHE-123.456.789 MWST',
    email: 'hallo@muster.ch',
    defaultCurrency: 'CHF',
    paymentTermsDays: 30,
  });
  assert.equal(made.ok, true);
  assert.equal(made.contact.workspaceId, workspaceId);
  assert.equal(made.contact.partyRole, 'customer');
  assert.equal(made.contact.name, 'Muster AG');
  assert.equal(made.contact.address.city, 'Zürich');
  assert.equal(made.contact.paymentTermsDays, 30);
  assert.equal(made.contact.archived, false);
  assert.equal(made.contact.createdAt, '2026-07-16T00:00:00.000Z');
  // no warning: the structured address is complete
  assert.equal(made.warning, undefined);

  const got = getContact(ctx, { contactId: made.contact.id });
  assert.equal(got.ok, true);
  assert.equal(got.contact.name, 'Muster AG');
  assert.equal(got.contact.email, 'hallo@muster.ch');
});

test('getContact returns not_found for an unknown id', () => {
  const { ctx } = setup();
  assert.equal(getContact(ctx, { contactId: 'nope' }).error, 'not_found');
});

test('createContact rejects an invalid party role and an empty name', () => {
  const { ctx } = setup();
  assert.equal(createContact(ctx, { partyRole: 'lead', name: 'X' }).error, 'invalid_party_role');
  const empty = createContact(ctx, { partyRole: 'customer', name: '  ' });
  assert.equal(empty.error, 'invalid_input');
  assert.equal(empty.field, 'name');
});

test('createContact rejects a malformed MWST number and accepts the canonical format', () => {
  const { ctx } = setup();
  const bad = createContact(ctx, { partyRole: 'customer', name: 'A', vatNumber: 'CHE-1.2.3' });
  assert.equal(bad.error, 'invalid_vat_number');
  assert.equal(bad.expected, 'CHE-###.###.### MWST');
  const good = createContact(ctx, { partyRole: 'customer', name: 'B', vatNumber: 'CHE-123.456.789 MWST' });
  assert.equal(good.ok, true);
});

test('createContact rejects an unknown currency and a negative/non-integer term', () => {
  const { ctx } = setup();
  assert.equal(createContact(ctx, { partyRole: 'customer', name: 'A', defaultCurrency: 'GBP' }).error, 'invalid_currency');
  const neg = createContact(ctx, { partyRole: 'customer', name: 'A', paymentTermsDays: -1 });
  assert.equal(neg.error, 'invalid_input');
  assert.equal(neg.field, 'paymentTermsDays');
  assert.equal(createContact(ctx, { partyRole: 'customer', name: 'A', paymentTermsDays: 3.5 }).field, 'paymentTermsDays');
});

test('updateContact patches fields and rejects a bad patch value', () => {
  const { ctx } = setup();
  const id = createContact(ctx, { partyRole: 'customer', name: 'Alt' }).contact.id;
  const upd = updateContact(ctx, { contactId: id, patch: { name: 'Neu', paymentTermsDays: 14, email: 'a@b.ch' } });
  assert.equal(upd.ok, true);
  assert.equal(upd.contact.name, 'Neu');
  assert.equal(upd.contact.paymentTermsDays, 14);
  assert.equal(upd.contact.email, 'a@b.ch');
  assert.equal(updateContact(ctx, { contactId: id, patch: { vatNumber: 'nonsense' } }).error, 'invalid_vat_number');
  assert.equal(updateContact(ctx, { contactId: 'ghost', patch: { name: 'x' } }).error, 'not_found');
});

test('archiveContact hides from list by default, includeArchived reveals it, the row survives', () => {
  const { ctx, store, workspaceId } = setup();
  const id = createContact(ctx, { partyRole: 'customer', name: 'Archivar' }).contact.id;
  assert.equal(archiveContact(ctx, { contactId: id }).ok, true);

  assert.equal(listContacts(ctx, {}).contacts.some((c) => c.id === id), false);
  assert.equal(listContacts(ctx, { includeArchived: true }).contacts.some((c) => c.id === id), true);

  // never deleted: the row is still physically present
  const row = store.db.prepare('SELECT archived FROM contact WHERE workspace_id = ? AND id = ?').get(workspaceId, id);
  assert.equal(row.archived, 1);
});

test('unarchiveContact reactivates a soft-archived contact (round-trip + idempotent + unknown id)', () => {
  const { ctx } = setup();
  const id = createContact(ctx, { partyRole: 'customer', name: 'Archivar' }).contact.id;
  assert.equal(archiveContact(ctx, { contactId: id }).ok, true);
  assert.equal(listContacts(ctx, {}).contacts.some((c) => c.id === id), false, 'archived: hidden');

  const back = unarchiveContact(ctx, { contactId: id });
  assert.equal(back.ok, true);
  assert.equal(back.contact.archived, false, 'the returned record is active again');
  assert.equal(listContacts(ctx, {}).contacts.some((c) => c.id === id), true, 'reactivated: back on the active list');

  // Idempotent, and an unknown id is a structured error, not a throw.
  assert.equal(unarchiveContact(ctx, { contactId: id }).ok, true);
  const miss = unarchiveContact(ctx, { contactId: 'contact_nope' });
  assert.equal(miss.ok, false);
  assert.equal(miss.error, 'not_found');
});

test('listContacts searches name / vat_number / email and filters by party role', () => {
  const { ctx } = setup();
  createContact(ctx, { partyRole: 'customer', name: 'Alpha AG', email: 'info@alpha.ch' });
  createContact(ctx, { partyRole: 'vendor', name: 'Beta GmbH', vatNumber: 'CHE-111.222.333 MWST' });

  assert.equal(listContacts(ctx, { query: 'alpha' }).contacts.length, 1);
  assert.equal(listContacts(ctx, { query: 'info@alpha' }).contacts.length, 1);
  assert.equal(listContacts(ctx, { query: '111.222.333' }).contacts.length, 1);
  assert.equal(listContacts(ctx, { partyRole: 'vendor' }).contacts.length, 1);
  assert.equal(listContacts(ctx, { partyRole: 'vendor' }).contacts[0].name, 'Beta GmbH');
});

test('createContact is idempotent under a repeated idempotencyKey', () => {
  const { ctx } = setup();
  const first = createContact(ctx, { partyRole: 'customer', name: 'Once', idempotencyKey: 'k1' });
  const second = createContact(ctx, { partyRole: 'customer', name: 'Once', idempotencyKey: 'k1' });
  assert.equal(first.contact.id, second.contact.id);
  assert.equal(listContacts(ctx, { query: 'Once' }).contacts.length, 1);
});

test('US-A09.4: a free-text description parses into the exact structured fields', () => {
  const { ctx } = setup();
  const made = createContact(ctx, {
    partyRole: 'customer',
    description: 'Kunde Muster AG, Bahnhofstrasse 1, 8001 Zürich, MWST CHE-123.456.789, zahlbar 30 Tage',
  });
  assert.equal(made.ok, true);
  const c = made.contact;
  assert.equal(c.name, 'Muster AG');
  assert.equal(c.address.street, 'Bahnhofstrasse');
  assert.equal(c.address.houseNo, '1');
  assert.equal(c.address.zip, '8001');
  assert.equal(c.address.city, 'Zürich');
  assert.equal(c.address.country, 'CH');
  assert.equal(c.vatNumber, 'CHE-123.456.789 MWST');
  assert.equal(c.paymentTermsDays, 30);
  // a complete parsed address means no warning
  assert.equal(made.warning, undefined);
});

test('a name-only contact is valid but warns needs_structured_address', () => {
  const { ctx } = setup();
  const fromDesc = createContact(ctx, { partyRole: 'customer', description: 'Kundin Einzelfrau Meier' });
  assert.equal(fromDesc.ok, true);
  assert.equal(fromDesc.contact.name, 'Einzelfrau Meier');
  assert.equal(fromDesc.warning, 'needs_structured_address');

  const structured = createContact(ctx, { partyRole: 'customer', name: 'Nur Name AG' });
  assert.equal(structured.ok, true);
  assert.equal(structured.warning, 'needs_structured_address');
});

test('§H-TENANT: a second workspace sees none of the first workspace contacts', () => {
  const { ctx, deps } = setup();
  createContact(ctx, { partyRole: 'customer', name: 'Erste Firma' });
  const other = newWorkspace(deps, 'Zweite AG');
  assert.equal(listContacts(other, {}).contacts.length, 0);
  assert.equal(listContacts(other, { includeArchived: true }).contacts.length, 0);
  // and the first still sees its own
  assert.equal(listContacts(ctx, {}).contacts.length, 1);
});
