/**
 * Non-author critic probes, round 2 (critic/phase0-installable-r1) against the remediation at
 * `claude/phase0-installable` head daf68e09. Round 1's probes live in
 * `phase0-qr-completion-critic.test.mjs` and `../checklists/phase0-books-start-critic.test.mjs`.
 *
 * Defects are written as the CORRECT behaviour and marked `todo`, so they report without reddening the
 * gate; the rest pin behaviour the round verified. All values are synthetic (invented names, the
 * published SIX sample IBANs).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { handleRest } from '../../dist/api/rest.js';
import { callTool } from '../../dist/api/mcp.js';
import { CONSEQUENCE_FOR_ACTION, CONSEQUENCE_ENTRY_FOR_ACTION } from '../../dist/core/agent/dialMap.js';
import { ech0058ProductVersion } from '../../dist/core/vat/ech0217.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';

const must = (res, what) => {
  assert.equal(res.ok, true, `${what} failed: ${JSON.stringify(res)}`);
  return res;
};

const IBAN_A = 'CH9300762011623852957';
const IBAN_B = 'CH5604835012345678009';
const CREDITOR = {
  creditorName: 'Beispiel GmbH',
  address: { street: 'Seestrasse', buildingNo: '12', zip: '8001', town: 'Zürich', country: 'CH' },
};
const CUSTOMER_ADDRESS = { street: 'Musterweg', houseNo: '3', zip: '3000', city: 'Bern', country: 'CH' };

/** A QR-ready company: creditor complete on IBAN A, one customer with a full address. */
function ready(seed) {
  const deps = freshDeps();
  deps.actor = 'studio';
  const { workspaceId } = mintWorkspace(deps, 'Beispiel GmbH', `${seed}-ws`);
  const call = (name, input) => getAction(name).run(deps, { workspaceId, ...input });
  must(call('vat_seed_defaults', {}), 'vat seed');
  must(call('set_vat_method', { vatMethod: 'effektiv', vatAccounting: 'soll' }), 'vat method');
  must(call('set_creditor_profile', { ...CREDITOR, iban: IBAN_A }), 'creditor');
  const contact = (name, address, key) => {
    const c = must(call('create_contact', { partyRole: 'customer', name, ...(address ? { address } : {}), idempotencyKey: key }), `contact ${key}`);
    return c.contactId ?? c.contact?.id;
  };
  const invoice = (contactId, key) =>
    must(
      call('create_document', {
        type: 'invoice',
        contactId,
        lines: [{ description: 'Beratung', quantityMilli: 1000, unitPriceMinor: 20000, taxCode: 'UST81' }],
        idempotencyKey: key,
      }),
      `draft ${key}`,
    ).document.id;
  return { deps, workspaceId, call, contact, invoice, agent: { ...deps, actor: 'agent' } };
}

// --- Item 5: nothing may pretend the QR data is frozen at issue ------------------------------------

test('r2 item 5 (fact): an IBAN change moves the QR-bill of an invoice issued BEFORE it (the QR-bill is resolved live)', () => {
  const w = ready('live-iban');
  const cid = w.contact('Muster AG', CUSTOMER_ADDRESS, 'c1');
  const earlier = w.invoice(cid, 'd1');
  const issued = must(w.call('issue_invoice', { invoiceId: earlier, idempotencyKey: 'i1' }), 'issue');
  assert.equal(issued.qr.available, true, JSON.stringify(issued.qr));
  assert.match(issued.qr.swissQrPayload, new RegExp(IBAN_A));
  must(w.call('set_creditor_profile', { iban: IBAN_B }), 'the IBAN changes after issue');
  const reread = must(w.call('get_document', { documentId: earlier, include: ['qr'] }), 'reread').qr;
  assert.match(reread.swissQrPayload, new RegExp(IBAN_B), 'the earlier invoice now asks to be paid into the NEW account');
});

test(
  'r2 R2-1 (fixed): the sentence the approver reads on a drafted IBAN change does not limit it to bills issued afterwards',
  () => {
    const sentence = CONSEQUENCE_FOR_ACTION.set_creditor_profile;
    assert.doesNotMatch(sentence, /issued afterwards/, sentence);
    // It names the true reach until the D146 freeze: invoices already open move too.
    assert.match(sentence, /already open/, sentence);
    assert.match(sentence, /dunned/, sentence);
    // The Vorschlag card copy says the same, in both locales (du register in de-CH). D156: the card reads
    // the ONE engine catalogue, so both locales are read from it (the Studio projection is held equal to
    // it by test/agent/consequence-parity.test.mjs).
    const read = (loc) => CONSEQUENCE_ENTRY_FOR_ACTION.set_creditor_profile[loc];
    const en = read('en');
    assert.doesNotMatch(en, /issued afterwards/, en);
    assert.match(en, /already open/, en);
    const de = read('de-CH');
    assert.doesNotMatch(de, /danach ausgestellte/, de);
    assert.match(de, /offener Rechnungen/, de);
    assert.match(de, /\bdu\b/, de);
  },
);

// --- Item 2: the payee master data behind the pay dial ---------------------------------------------

test('r2 item 2: set_creditor_profile drafts for the agent on MCP too, a type-mismatched twin field does not slip past, and the human approval replays it', () => {
  const w = ready('gate');
  const viaMcp = JSON.parse(callTool(w.agent, 'set_creditor_profile', { workspaceId: w.workspaceId, iban: IBAN_B }).content[0].text);
  assert.equal(viaMcp.drafted, true, JSON.stringify(viaMcp));
  // A mistyped second field makes the input non-draftable: it must fall through to a REFUSAL, never a write.
  const odd = handleRest('set_creditor_profile', { workspaceId: w.workspaceId, iban: IBAN_B, qrIban: 5 }, w.agent).body;
  assert.equal(odd.ok, false, JSON.stringify(odd));
  const nullIban = handleRest('set_creditor_profile', { workspaceId: w.workspaceId, iban: null, qrIban: IBAN_B }, w.agent).body;
  assert.ok(nullIban.drafted === true || nullIban.ok === false, JSON.stringify(nullIban));
  assert.equal(must(w.call('get_company_profile', {}), 'profile').profile.creditorIban, IBAN_A, 'nothing moved yet');
  // The owner approves the MCP draft: the replay runs as the human and the account changes.
  must(w.call('approve_drafted_action', { actionId: viaMcp.actionId }), 'approve');
  assert.equal(must(w.call('get_company_profile', {}), 'profile').profile.creditorIban, IBAN_B);
});

test('r2 item 2: the agent may still complete the creditor name and address, but through the same value chokepoint', () => {
  const w = ready('addr');
  const bad = handleRest('set_creditor_profile', { workspaceId: w.workspaceId, ...CREDITOR, address: { ...CREDITOR.address, country: 'CHE' } }, w.agent).body;
  assert.equal(bad.ok, false);
  assert.equal(bad.error, 'invalid_country');
});

test('r2 item 2: update_contact carries no IBAN (the contact table has no IBAN column)', () => {
  const w = ready('noiban');
  const cols = w.deps.store.db.prepare('PRAGMA table_info(contact)').all().map((c) => c.name);
  assert.deepEqual(cols.filter((c) => /iban|bank/i.test(c)), []);
});

// --- Item 3: the value chokepoint, and the lenient create path -------------------------------------

test(
  'r2 R2-2 (fixed): a customer created with a country the QR-bill refuses does not reach issue silently',
  () => {
    const w = ready('lenient');
    const created = w.call('create_contact', { partyRole: 'customer', name: 'Lenient AG', address: { ...CUSTOMER_ADDRESS, country: 'Schweiz' }, idempotencyKey: 'c-len' });
    assert.equal(created.ok, false, 'refused where it is typed');
    assert.equal(created.error, 'invalid_country');
    assert.equal(created.field, 'address.country');
    // contacts_import (importContacts) goes through create_contact and refuses the whole file on the first bad row.
    const imported = w.call('contacts_import', {
      rows: [
        { partyRole: 'customer', name: 'Gut AG', address: CUSTOMER_ADDRESS },
        { partyRole: 'customer', name: 'Schlecht AG', address: { ...CUSTOMER_ADDRESS, city: 'X'.repeat(36) } },
      ],
      idempotencyKey: 'imp-len',
    });
    assert.equal(imported.ok, false, JSON.stringify(imported));
    assert.equal(imported.error, 'invalid_import_format');
    assert.equal(imported.row, 1);
    assert.equal(imported.detail, 'field_too_long');
    const names = w.deps.store.db.prepare('SELECT name FROM contact WHERE workspace_id = ?').all(w.workspaceId).map((r) => r.name);
    assert.ok(!names.includes('Gut AG'), 'the refused file stored nothing');
    if (!created.ok) return; // refused where it is typed: the hole is closed.
    const cid = created.contactId ?? created.contact?.id;
    const issued = must(w.call('issue_invoice', { invoiceId: w.invoice(cid, 'd-len'), idempotencyKey: 'i-len' }), 'issue');
    assert.equal(issued.qr.available, true, `issued with no payment part: ${JSON.stringify(issued.qr)}`);
  },
);

test(
  'r2 R2-2b (fixed): a customer name over the IG 70-character maximum is refused where it is typed',
  () => {
    const w = ready('longname');
    const cid = w.contact('Kurz AG', CUSTOMER_ADDRESS, 'c-ln');
    const long = `Genossenschaft ${'für gemeinnützigen Wohnungsbau '.repeat(3)}Zürich`;
    assert.ok(long.length > 70);
    const upd = w.call('update_contact', { contactId: cid, patch: { name: long } });
    assert.equal(upd.ok, false);
    assert.equal(upd.error, 'field_too_long');
    assert.equal(upd.field, 'name');
    assert.equal(upd.max, 70);
    const created = w.call('create_contact', { partyRole: 'customer', name: long, idempotencyKey: 'c-ln-2' });
    assert.equal(created.error, 'field_too_long', 'create_contact runs the same rule');
    // Exactly 70 is the IG maximum and is accepted.
    must(w.call('update_contact', { contactId: cid, patch: { name: 'N'.repeat(70) } }), '70 characters');
    if (!upd.ok) return;
    const issued = must(w.call('issue_invoice', { invoiceId: w.invoice(cid, 'd-ln'), idempotencyKey: 'i-ln' }), 'issue');
    assert.equal(issued.qr.available, true, `issued with no payment part: ${JSON.stringify(issued.qr)}`);
  },
);

// --- Item 4: eCH-0058 productVersion ----------------------------------------------------------------

test('r2 item 4: eCH-0058 productVersion stays within 10 characters and stays a prerelease', () => {
  const table = {
    '1.0.0': '1.0.0',
    '1.0.0-rc.1': '1.0.0-rc.1',
    '1.0.0-beta.1': '1.0.0-b.1',
    '1.0.0-rc.10': '1.0.0-r.10',
    '1.0.0-alpha.12': '1.0.0-a.12',
    '10.2.3-beta.10': '10.2.3-b10',
    '10.20.30-beta.100': '10.20.30-b',
    '1.0.0-beta-2': '1.0.0-beta',
  };
  for (const [v, want] of Object.entries(table)) {
    const got = ech0058ProductVersion(v);
    assert.equal(got, want, v);
    assert.ok(got.length >= 1 && got.length <= 10, `${v} -> ${got}`);
    if (v.includes('-')) assert.ok(got.includes('-'), `${v} stays a prerelease: ${got}`);
    assert.doesNotMatch(got, /\s/, 'xs:token carries no whitespace');
  }
});
