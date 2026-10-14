/**
 * Non-author critic probes (critic/phase0-installable-r1) for the P0.4e QR-completion step.
 *
 * The Studio's issue dialog (`app/src/surfaces/Documents/IssueDialog.tsx` + `QrCompletion.tsx`, driven
 * by `saveQrFix` in `DocumentEditor.tsx`) runs up to TWO writes before it issues:
 *   1. `set_creditor_profile {creditorName?, address?, iban?}` (one call, one UPDATE on `workspace`);
 *   2. `update_contact {contactId, patch:{address}}`;
 * then `issue_invoice` as a THIRD, separate request. There is no transaction spanning the three. These
 * probes pin what that leaves behind in each failure mode, and the adjacent questions the review brief
 * asks (idempotency, §H-TENANT, the agent seat). The shapes are exactly what `planQrFix` emits.
 *
 * All values are synthetic (invented names, the published SIX sample IBAN CH93 0076 2011 6238 5295 7).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { handleRest } from '../../dist/api/rest.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';

const must = (res, what) => {
  assert.equal(res.ok, true, `${what} failed: ${JSON.stringify(res)}`);
  return res;
};

const CREDITOR_FIX = {
  creditorName: 'Beispiel GmbH',
  address: { street: 'Seestrasse', buildingNo: '12', zip: '8001', town: 'Zürich', country: 'CH' },
};
const CUSTOMER_FIX = { address: { street: 'Musterweg', houseNo: '', zip: '3000', city: 'Bern', country: 'CH' } };

/** The day-0 company of the author's own suite: IBAN only, a name-only customer, one draft invoice. */
function dayZero(seed, deps = freshDeps()) {
  deps.actor = 'studio';
  const { workspaceId } = mintWorkspace(deps, 'Beispiel GmbH', `${seed}-ws`);
  const call = (name, input) => getAction(name).run(deps, { workspaceId, ...input });
  must(call('vat_seed_defaults', {}), 'vat seed');
  must(call('set_vat_method', { vatMethod: 'effektiv', vatAccounting: 'soll' }), 'vat method');
  must(call('set_creditor_profile', { iban: 'CH9300762011623852957' }), 'iban only');
  const contact = must(call('create_contact', { partyRole: 'customer', name: 'Muster AG', idempotencyKey: `${seed}-c` }), 'contact');
  const contactId = contact.contactId ?? contact.contact?.id;
  const draft = (key) =>
    must(
      call('create_document', {
        type: 'invoice',
        contactId,
        lines: [{ description: 'Beratung', quantityMilli: 2000, unitPriceMinor: 15000, taxCode: 'UST81' }],
        idempotencyKey: key,
      }),
      'draft',
    ).document.id;
  return { deps, workspaceId, call, contactId, invoiceId: draft(`${seed}-d`), draft };
}

const entriesOf = (w, docId) =>
  w.deps.store.db
    .prepare('SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ? AND id = (SELECT posted_entry_id FROM document WHERE id = ?)')
    .get(w.workspaceId, docId).n;
const postedCount = (w) => w.deps.store.db.prepare("SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ? AND status = 'posted'").get(w.workspaceId).n;
const docRow = (w, docId) => w.deps.store.db.prepare('SELECT status, number, posted_entry_id FROM document WHERE workspace_id = ? AND id = ?').get(w.workspaceId, docId);

test('critic P0.4e-1: both fix writes land, the issue is REFUSED: a draft with no number, no entry, no QR; only master data changed', () => {
  const w = dayZero('refused');
  must(w.call('set_creditor_profile', CREDITOR_FIX), 'write 1');
  must(w.call('update_contact', { contactId: w.contactId, patch: CUSTOMER_FIX }), 'write 2');
  // The draft is dated by the pinned clock (16.07.2026): a hard lock on July makes the issue refuse.
  must(w.call('lock_period', { period: '2026-07', kind: 'hard', idempotencyKey: 'lock-jul' }), 'lock');
  const before = postedCount(w);
  const refused = w.call('issue_invoice', { invoiceId: w.invoiceId, idempotencyKey: 'refused-issue' });
  assert.equal(refused.ok, false, JSON.stringify(refused));

  const row = docRow(w, w.invoiceId);
  assert.equal(row.status, 'draft', 'the invoice is still a draft');
  assert.equal(row.number, null, 'no number was consumed');
  assert.equal(row.posted_entry_id, null, 'nothing posted');
  assert.equal(postedCount(w), before, 'no journal entry appeared');
  const qr = must(w.call('get_document', { documentId: w.invoiceId, include: ['qr'] }), 'read').qr;
  assert.equal(qr.error, 'not_available', 'a draft has no QR-bill, so no reference exists to be consumed');

  // What IS left: the two master-data writes, exactly as typed. Neither is a posted or issued thing.
  const profile = must(w.call('get_company_profile', {}), 'profile').profile;
  assert.equal(profile.creditorAddress.street, 'Seestrasse');
  const contact = w.deps.store.db.prepare('SELECT address_street, address_house_no FROM contact WHERE id = ?').get(w.contactId);
  assert.equal(contact.address_street, 'Musterweg');
  assert.equal(contact.address_house_no, '', 'an empty house number is stored as an empty string, not null');

  // Unlock and issue: the number is the FIRST of the sequence (nothing was burned by the refusal).
  must(w.call('unlock_period', { period: '2026-07', idempotencyKey: 'unlock-jul' }), 'unlock');
  const issued = must(w.call('issue_invoice', { invoiceId: w.invoiceId, idempotencyKey: 'after-unlock' }), 'issue');
  const baseline = dayZero('baseline');
  const baseIssued = must(baseline.call('issue_invoice', { invoiceId: baseline.invoiceId, idempotencyKey: 'b' }), 'baseline issue');
  assert.equal(issued.document?.number ?? docRow(w, w.invoiceId).number, baseIssued.document?.number ?? docRow(baseline, baseline.invoiceId).number);
  assert.equal(issued.qr.available, true, JSON.stringify(issued.qr));
});

test('critic P0.4e-2: issue retried (same key, then a fresh key as the Studio mints per click): one number, one entry, one QR reference', () => {
  const w = dayZero('retry');
  must(w.call('set_creditor_profile', CREDITOR_FIX), 'write 1');
  must(w.call('update_contact', { contactId: w.contactId, patch: CUSTOMER_FIX }), 'write 2');
  const first = must(w.call('issue_invoice', { invoiceId: w.invoiceId, idempotencyKey: 'k1' }), 'issue');
  const posted = postedCount(w);
  const number = docRow(w, w.invoiceId).number;

  const replay = w.call('issue_invoice', { invoiceId: w.invoiceId, idempotencyKey: 'k1' });
  const fresh = w.call('issue_invoice', { invoiceId: w.invoiceId, idempotencyKey: 'k2-fresh' });
  // Either answer is acceptable (ok replay or a refusal of a non-draft); what must NOT happen is a second effect.
  assert.equal(postedCount(w), posted, `no second entry (replay=${JSON.stringify(replay).slice(0, 120)} fresh=${JSON.stringify(fresh).slice(0, 120)})`);
  assert.equal(docRow(w, w.invoiceId).number, number, 'the number did not move');
  assert.equal(entriesOf(w, w.invoiceId), 1);

  const r1 = must(w.call('get_document', { documentId: w.invoiceId, include: ['qr'] }), 'read 1').qr;
  const r2 = must(w.call('get_document', { documentId: w.invoiceId, include: ['qr'] }), 'read 2').qr;
  assert.equal(r1.reference, first.qr.reference);
  assert.equal(r2.reference, first.qr.reference, 'the QR reference is seeded from the number: stable across re-renders');
});

test('critic P0.4e-3 (pre-existing, recorded): an issued invoice\'s QR-bill is resolved LIVE from master data, so the fix step changes how an EARLIER issued invoice renders', () => {
  const w = dayZero('live');
  // Invoice 1 issues with no customer address and no creditor address: no payment part.
  const first = must(w.call('issue_invoice', { invoiceId: w.invoiceId, idempotencyKey: 'i1' }), 'issue 1');
  assert.equal(first.qr.available, false);
  // Invoice 2 goes through the completion step.
  const second = w.draft('live-d2');
  must(w.call('set_creditor_profile', CREDITOR_FIX), 'write 1');
  must(w.call('update_contact', { contactId: w.contactId, patch: CUSTOMER_FIX }), 'write 2');
  must(w.call('issue_invoice', { invoiceId: second, idempotencyKey: 'i2' }), 'issue 2');
  // Re-reading invoice 1 now yields a payment part it did not carry when it was issued and sent.
  const reread = must(w.call('get_document', { documentId: w.invoiceId, include: ['qr'] }), 'reread').qr;
  assert.equal(typeof reread.swissQrPayload, 'string', 'invoice 1 now renders WITH a QR-bill');
  assert.match(reread.swissQrPayload, /Musterweg/, 'carrying the address typed for invoice 2');
});

test('critic P0.4e-4: §H-TENANT: the fix writes cannot reach another workspace', () => {
  const deps = freshDeps();
  const a = dayZero('ten-a', deps);
  const b = dayZero('ten-b', deps);
  // Workspace A names workspace B's contact.
  const cross = a.call('update_contact', { contactId: b.contactId, patch: CUSTOMER_FIX });
  assert.equal(cross.ok, false, JSON.stringify(cross));
  const bContact = deps.store.db.prepare('SELECT address_street FROM contact WHERE id = ?').get(b.contactId);
  assert.equal(bContact.address_street, null, 'B\'s contact is untouched');
  must(a.call('set_creditor_profile', CREDITOR_FIX), 'A creditor');
  const bProfile = must(b.call('get_company_profile', {}), 'B profile').profile;
  assert.equal(bProfile.creditorAddress, null, 'B\'s creditor address is untouched');
});

test('critic P0.4e-5a: the agent seat cannot ISSUE the invoice without the human gate (the step itself is Studio-only)', () => {
  const w = dayZero('agent');
  const agent = { ...w.deps, actor: 'agent' };
  const r = handleRest('issue_invoice', { workspaceId: w.workspaceId, invoiceId: w.invoiceId, idempotencyKey: 'agent-issue' }, agent).body;
  assert.ok(r.drafted === true || (r.ok === false && r.error === 'permission_denied'), JSON.stringify(r).slice(0, 300));
  assert.equal(r.approveAt?.path, '/agent', 'the draft names where a human approves it');
  assert.equal(docRow(w, w.invoiceId).status, 'draft');
});

test(
  'critic P0.4e-5b (PRE-EXISTING, fixed on remed/phase0-installable): the agent seat cannot rewrite the creditor IBAN every QR-bill pays into without a human',
  () => {
    const w = dayZero('agent-iban');
    const agent = { ...w.deps, actor: 'agent' };
    const r = handleRest('set_creditor_profile', { workspaceId: w.workspaceId, iban: 'CH5604835012345678009' }, agent).body;
    assert.equal(r.drafted, true, `executed: ${JSON.stringify(r)}`);
    assert.equal(r.approveAt?.path, '/agent', 'the draft names where a human approves it');
    assert.equal(must(w.call('get_company_profile', {}), 'profile').profile.creditorIban, 'CH9300762011623852957');
    // The QR-IBAN field is the same destination under another name: it drafts too.
    const q = handleRest('set_creditor_profile', { workspaceId: w.workspaceId, qrIban: 'CH4431999123000889012' }, agent).body;
    assert.equal(q.drafted, true, JSON.stringify(q));
    // The creditor name and address decide no payment's destination: the agent may still complete them.
    const addr = handleRest('set_creditor_profile', { workspaceId: w.workspaceId, ...CREDITOR_FIX }, agent).body;
    assert.equal(addr.ok, true, JSON.stringify(addr));
    assert.notEqual(addr.drafted, true);
    // The human Studio path is untouched: the same IBAN change executes at once.
    const human = handleRest('set_creditor_profile', { workspaceId: w.workspaceId, iban: 'CH5604835012345678009' }, w.deps).body;
    assert.equal(human.ok, true, JSON.stringify(human));
    assert.notEqual(human.drafted, true);
    assert.equal(must(w.call('get_company_profile', {}), 'profile').profile.creditorIban, 'CH5604835012345678009');
  },
);

test('P0.4e-5b twin: the agent seat cannot redirect the IBAN a vendor is paid at (set_creditor_bank_profile) without a human', () => {
  const w = dayZero('agent-vendor-iban');
  const vendor = must(w.call('create_contact', { partyRole: 'vendor', name: 'Lieferant AG', idempotencyKey: 'v-1' }), 'vendor');
  const vendorId = vendor.contactId ?? vendor.contact?.id;
  must(w.call('set_creditor_bank_profile', { vendorId, iban: 'CH9300762011623852957', idempotencyKey: 'v-iban-1' }), 'human sets the vendor IBAN');
  const agent = { ...w.deps, actor: 'agent' };
  const r = handleRest('set_creditor_bank_profile', { workspaceId: w.workspaceId, vendorId, iban: 'CH5604835012345678009', idempotencyKey: 'v-iban-agent' }, agent).body;
  assert.equal(r.drafted, true, `executed: ${JSON.stringify(r)}`);
  assert.equal(r.approveAt?.path, '/agent');
  const stored = w.deps.store.db.prepare('SELECT iban FROM creditor_bank_profile WHERE workspace_id = ? AND contact_id = ?').get(w.workspaceId, vendorId);
  assert.equal(stored.iban, 'CH9300762011623852957', 'the vendor is still paid at the IBAN the human set');

  // Critic r2 (UX): the queue read names the vendor, so the approver sees WHICH vendor is redirected.
  // The payload itself is untouched (it is what the approval replays).
  const listed = must(w.call('list_drafted_actions', {}), 'list').actions.find((a) => a.actionId === r.actionId);
  assert.equal(listed.payloadLabels.vendorId, 'Lieferant AG');
  assert.equal(listed.payload.vendorId, vendorId);
  assert.equal('payloadLabels' in listed.payload, false);
});

test('critic r2 (UX): §H-TENANT: a drafted payload naming ANOTHER workspace\'s contact resolves no name', () => {
  const deps = freshDeps();
  const a = dayZero('labels-a', deps);
  const b = dayZero('labels-b', deps);
  const agent = { ...deps, actor: 'agent' };
  // Workspace A's agent drafts a vendor IBAN naming B's contact id (the verb would refuse it on replay).
  const r = handleRest('set_creditor_bank_profile', { workspaceId: a.workspaceId, vendorId: b.contactId, iban: 'CH5604835012345678009', idempotencyKey: 'x-ten' }, agent).body;
  assert.equal(r.drafted, true, JSON.stringify(r));
  const listed = must(a.call('list_drafted_actions', {}), 'list').actions.find((x) => x.actionId === r.actionId);
  assert.deepEqual(listed.payloadLabels, {}, 'B\'s contact name never reaches A');
});

test(
  'critic P0.4e-6 (LOW, inherited, fixed): a creditor country the QR-bill refuses is refused where it is typed, not stored and discovered at issue',
  () => {
    const w = dayZero('iso');
    // planQrFix trims and upper-cases the country field; it does not check ISO 3166 alpha-2.
    const saved = w.call('set_creditor_profile', { ...CREDITOR_FIX, address: { ...CREDITOR_FIX.address, country: 'SCHWEIZ' } });
    must(w.call('update_contact', { contactId: w.contactId, patch: CUSTOMER_FIX }), 'write 2');
    const issued = must(w.call('issue_invoice', { invoiceId: w.invoiceId, idempotencyKey: 'iso-issue' }), 'issue');
    assert.ok(saved.ok === false || issued.qr.available === true, `stored, then issued with qr=${JSON.stringify(issued.qr)}`);
  },
);

test(
  'critic P0.4e-7 (LOW, inherited, fixed): a creditor IBAN the QR-bill refuses (valid, but not CH/LI) is not accepted as making the invoice QR-ready',
  () => {
    const w = dayZero('deiban');
    const saved = w.call('set_creditor_profile', { ...CREDITOR_FIX, iban: 'DE89370400440532013000' });
    must(w.call('update_contact', { contactId: w.contactId, patch: CUSTOMER_FIX }), 'write 2');
    const issued = must(w.call('issue_invoice', { invoiceId: w.invoiceId, idempotencyKey: 'de-issue' }), 'issue');
    assert.ok(saved.ok === false || issued.qr.available === true, `stored, then issued with qr=${JSON.stringify(issued.qr)}`);
  },
);

// --- The fix (remed/phase0-installable): one engine chokepoint, `qrAddressValueIssues` + `isQrCreditorIban`
// in core/sales/qrbill.ts, which validateQrBill itself runs, now refuses at both master-data verbs. ----

test('P0.4e-6 fix: set_creditor_profile refuses a non-alpha-2 country and an over-long element with typed codes, storing nothing', () => {
  const w = dayZero('iso-codes');
  const country = w.call('set_creditor_profile', { ...CREDITOR_FIX, address: { ...CREDITOR_FIX.address, country: 'SCHWEIZ' } });
  assert.equal(country.ok, false);
  assert.equal(country.error, 'invalid_country');
  assert.equal(country.field, 'address.country');
  const town = w.call('set_creditor_profile', { ...CREDITOR_FIX, address: { ...CREDITOR_FIX.address, town: 'Z'.repeat(36) } });
  assert.equal(town.error, 'field_too_long');
  assert.equal(town.field, 'address.town');
  assert.equal(town.max, 35);
  const name = w.call('set_creditor_profile', { ...CREDITOR_FIX, creditorName: 'N'.repeat(71) });
  assert.equal(name.error, 'field_too_long');
  assert.equal(name.field, 'creditorName');
  assert.equal(must(w.call('get_company_profile', {}), 'profile').profile.creditorAddress, null, 'no refused address was stored');
  // The IG maxima themselves are accepted (a boundary, not an off-by-one).
  must(w.call('set_creditor_profile', { ...CREDITOR_FIX, address: { ...CREDITOR_FIX.address, town: 'Z'.repeat(35), country: 'li' } }), 'at the limit');
});

test('P0.4e-7 fix: set_creditor_profile refuses a valid non-CH/LI IBAN (iban_not_ch_li), keeps a malformed one invalid_iban, and never re-judges a stored IBAN it only preserves', () => {
  const w = dayZero('ch-li');
  const de = w.call('set_creditor_profile', { iban: 'DE89370400440532013000' });
  assert.equal(de.error, 'iban_not_ch_li');
  const deQr = w.call('set_creditor_profile', { qrIban: 'DE89370400440532013000' });
  assert.equal(deQr.error, 'iban_not_ch_li', 'the qrIban spelling is the same field');
  assert.equal(w.call('set_creditor_profile', { iban: 'DE00 not an iban' }).error, 'invalid_iban');
  assert.equal(must(w.call('get_company_profile', {}), 'profile').profile.creditorIban, 'CH9300762011623852957');
  // LI is a QR-bill country.
  must(w.call('set_creditor_profile', { iban: 'LI21088100002324013AA' }), 'LI IBAN');
  // A legacy stored IBAN outside CH/LI (written before the rule) does not block an address-only save.
  w.deps.store.db.prepare('UPDATE workspace SET creditor_iban = ? WHERE id = ?').run('DE89370400440532013000', w.workspaceId);
  must(w.call('set_creditor_profile', CREDITOR_FIX), 'address-only save over a legacy IBAN');
});

test('P0.4e-6 fix: update_contact refuses a customer address the QR-bill would refuse, and still accepts a partial one', () => {
  const w = dayZero('contact-rules');
  const country = w.call('update_contact', { contactId: w.contactId, patch: { address: { ...CUSTOMER_FIX.address, country: 'Schweiz' } } });
  assert.equal(country.error, 'invalid_country');
  assert.equal(country.field, 'address.country');
  const city = w.call('update_contact', { contactId: w.contactId, patch: { address: { ...CUSTOMER_FIX.address, city: 'B'.repeat(36) } } });
  assert.equal(city.error, 'field_too_long');
  assert.equal(city.field, 'address.city');
  const zip = w.call('update_contact', { contactId: w.contactId, patch: { address: { ...CUSTOMER_FIX.address, zip: '9'.repeat(17) } } });
  assert.equal(zip.error, 'field_too_long');
  assert.equal(zip.max, 16);
  const row = w.deps.store.db.prepare('SELECT address_street, address_country FROM contact WHERE workspace_id = ? AND id = ?').get(w.workspaceId, w.contactId);
  assert.equal(row.address_street, null, 'nothing refused was stored');
  // A foreign alpha-2 country is fine, and so is a partial address (no payment part until complete).
  must(w.call('update_contact', { contactId: w.contactId, patch: { address: { ...CUSTOMER_FIX.address, country: 'DE' } } }), 'DE');
  must(w.call('update_contact', { contactId: w.contactId, patch: { address: { street: 'Musterweg' } } }), 'partial');
});

test('P0.4e-6 fix: §H-TENANT: a refused update_contact against another workspace stays not_found, the rule never leaks the row', () => {
  const deps = freshDeps();
  const a = dayZero('rules-ten-a', deps);
  const b = dayZero('rules-ten-b', deps);
  const cross = a.call('update_contact', { contactId: b.contactId, patch: { address: { ...CUSTOMER_FIX.address, country: 'Schweiz' } } });
  assert.equal(cross.ok, false);
  assert.equal(cross.error, 'not_found');
});
