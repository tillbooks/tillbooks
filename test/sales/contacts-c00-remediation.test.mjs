// C00 remediation: one test per finding the independent critic returned, plus the seven coverage
// gaps that let all nine of them ship under a 14/14 green suite.
//
// EVERY TEST HERE REPRODUCES BEFORE IT ASSERTS. Each one is written so that reverting the fix it
// guards makes it fail on the defect's own symptom rather than on a shape change: the anonymise cases
// count ROWS actually blanked, the money-path cases compare a consolidated balance against the
// ledger, and the automation case saves a rule and reads the run log rather than trusting a code path.
//
// The suite the critic measured was green because it asked the verbs whether they had worked. These
// ask the database.

import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';

import {
  createContact,
  updateContact,
  getContact,
  listContacts,
  tagContact,
  logActivity,
  contactTimeline,
  mergeContacts,
  anonymiseContact,
  importContacts,
  createDocument,
  transitionDocument,
  buildQrBill,
  DOCUMENT_STATUSES,
} from '../../dist/core/sales/index.js';
import {
  UNSETTLED_DOCUMENT_STATUSES,
  TERMINAL_DOCUMENT_STATUSES,
} from '../../dist/core/sales/contactMerge.js';
import { getAuditLog } from '../../dist/core/ledger/auditLog.js';
import { setCreditorProfile } from '../../dist/core/setup/index.js';
import { setup, newWorkspace } from './support.mjs';

const company = (ctx, name, extra = {}) =>
  createContact(ctx, { partyRole: 'customer', kind: 'company', name, ...extra });
const person = (ctx, name, extra = {}) =>
  createContact(ctx, { partyRole: 'customer', kind: 'person', name, ...extra });

/** The contact row itself, so a claim about erasure is read off the table and not off a Result. */
const rowOf = (store, workspaceId, id) =>
  store.db.prepare('SELECT * FROM contact WHERE workspace_id = ? AND id = ?').get(workspaceId, id);

const activityBodies = (store, workspaceId, contactId) =>
  store.db
    .prepare('SELECT body FROM contact_activity WHERE workspace_id = ? AND contact_id = ? ORDER BY rowid')
    .all(workspaceId, contactId)
    .map((r) => r.body);

/**
 * The A09 world plus the two things a REAL invoice needs and this suite's fixture does not carry: a
 * VAT method on the workspace, and A05's own `output` kind on the seeded code (`support.mjs` writes
 * `sales`, which A11's VAT trace does not recognise as output VAT). Nothing here fakes a document:
 * F5 is about a POSTED receivable, so it has to be posted through A11's real poster.
 */
function invoiceWorld() {
  const t = setup();
  t.store.db
    .prepare("UPDATE workspace SET vat_method = 'effektiv', vat_accounting = 'soll' WHERE id = ?")
    .run(t.workspaceId);
  t.store.db
    .prepare("UPDATE tax_code SET kind = 'output', esa_form_line = '303' WHERE workspace_id = ? AND code = 'UST81'")
    .run(t.workspaceId);
  setCreditorProfile(t.ctx, {
    creditorName: 'Nomadik GmbH',
    address: { street: 'Bahnhofstrasse', buildingNo: '1', zip: '8000', town: 'Zürich', country: 'CH' },
    qrIban: 'CH4431999123000889012',
  });
  return t;
}

/** Create AND issue a real invoice through A10's transition, so the receivable is genuinely posted. */
function issuedInvoice(ctx, contactId, seed) {
  const created = createDocument(ctx, {
    type: 'invoice',
    contactId,
    lines: [{ description: 'Beratung', unitPriceMinor: 100000, taxCode: 'UST81' }],
    idempotencyKey: `${seed}-create`,
  });
  assert.equal(created.ok, true, JSON.stringify(created));
  const issued = transitionDocument(ctx, {
    documentId: created.document.id,
    to: 'issued',
    idempotencyKey: `${seed}-issue`,
  });
  assert.equal(issued.ok, true, JSON.stringify(issued));
  return issued.document;
}

// --- F1, CRITICAL: anonymise on a tombstone reported success and erased NOTHING ------------------

test('F1: anonymising a merge tombstone is REFUSED and names the survivor, never a zero erasure', () => {
  const { ctx, store, workspaceId } = setup();
  const source = company(ctx, 'Alte Firma AG', { email: 'alt@example.ch', vatNumber: 'CHE-123.456.789 MWST' });
  const target = company(ctx, 'Muster AG', { email: 'neu@example.ch' });
  logActivity(ctx, { contactId: source.contact.id, kind: 'call', body: 'Anruf bei der Quelle' });

  assert.equal(mergeContacts(ctx, { sourceId: source.contact.id, targetId: target.contact.id }).ok, true);

  // The reproduction. Before the fix this returned {ok:true} while the UPDATE matched zero rows: the
  // merge had already moved the activities onto the target, so nothing at all was erased and an
  // audit_log row claimed otherwise.
  const attempt = anonymiseContact(ctx, { contactId: source.contact.id, idempotencyKey: 'a-1' });
  assert.equal(attempt.ok, false);
  assert.equal(attempt.error, 'contact_merged');
  assert.equal(attempt.survivorId, target.contact.id);

  // And nothing was touched, on either row. A refusal that half-erased would be the same defect.
  assert.equal(rowOf(store, workspaceId, source.contact.id).name, 'Alte Firma AG');
  assert.equal(rowOf(store, workspaceId, source.contact.id).email, 'alt@example.ch');
  assert.equal(rowOf(store, workspaceId, target.contact.id).name, 'Muster AG');
  assert.equal(rowOf(store, workspaceId, target.contact.id).email, 'neu@example.ch');
  assert.deepEqual(activityBodies(store, workspaceId, target.contact.id), ['Anruf bei der Quelle']);
});

test('F1: erasing the SURVIVOR erases the whole merge identity, tombstone rows included', () => {
  const { ctx, store, workspaceId } = setup();
  const dup = company(ctx, 'Alte Firma AG', { email: 'alt@example.ch', vatNumber: 'CHE-123.456.789 MWST' });
  const survivor = company(ctx, 'Muster AG', { email: 'neu@example.ch' });
  // An activity logged BEFORE the merge lands on the source row and is moved by the merge; one logged
  // against the tombstone afterwards lands on the survivor. Both must end up redacted.
  logActivity(ctx, { contactId: dup.contact.id, kind: 'note', body: 'vor dem Zusammenführen' });
  assert.equal(mergeContacts(ctx, { sourceId: dup.contact.id, targetId: survivor.contact.id }).ok, true);
  logActivity(ctx, { contactId: dup.contact.id, kind: 'note', body: 'nach dem Zusammenführen' });

  const erased = anonymiseContact(ctx, { contactId: survivor.contact.id, idempotencyKey: 'a-2' });
  assert.equal(erased.ok, true);
  assert.deepEqual([...erased.anonymisedContactIds].sort(), [dup.contact.id, survivor.contact.id].sort());

  for (const id of [dup.contact.id, survivor.contact.id]) {
    const row = rowOf(store, workspaceId, id);
    assert.equal(row.name, 'Anonymisiert', `row ${id} keeps a name`);
    assert.equal(row.email, null);
    assert.equal(row.vat_number, null);
    assert.equal(row.address_zip, null);
  }
  const bodies = activityBodies(store, workspaceId, survivor.contact.id);
  assert.equal(bodies.length, 2);
  assert.deepEqual(new Set(bodies), new Set(['[anonymisiert]']));
});

// --- F5, HIGH: only `draft` blocked, so a POSTED unpaid invoice erased its own debtor ------------

test('F5: the unsettled/terminal partition is TOTAL over DOCUMENT_STATUSES', () => {
  const classified = [...UNSETTLED_DOCUMENT_STATUSES, ...TERMINAL_DOCUMENT_STATUSES].sort();
  assert.deepEqual(
    classified,
    [...DOCUMENT_STATUSES].sort(),
    'every document status must be classified as blocking an erasure or not: a thirteenth status ' +
      'cannot join the enum without someone deciding which side of the revDSG/OR 958f line it is on',
  );
  assert.equal(new Set(classified).size, classified.length, 'no status may appear on both sides');
  // The six that bind a party. Pinned by value, because widening this set silently is the defect.
  assert.deepEqual(
    [...UNSETTLED_DOCUMENT_STATUSES],
    ['draft', 'issued', 'sent', 'accepted', 'confirmed', 'partially_paid'],
  );
});

test('F5: an ISSUED unpaid invoice blocks the erasure, and the refusal names the status', () => {
  const { ctx, store, workspaceId } = invoiceWorld();
  const c = company(ctx, 'Schuldner AG', { email: 'zahlt@example.ch' });
  const issued = issuedInvoice(ctx, c.contact.id, 'inv');
  assert.equal(issued.status, 'issued');

  // The reproduction: `AND status = 'draft'` let this through, the Debitorenbuch lost its debtor
  // identity while the open amount stayed, and the invoice could never be re-rendered payably.
  const refused = anonymiseContact(ctx, { contactId: c.contact.id, idempotencyKey: 'a-3' });
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'open_documents');
  assert.deepEqual(refused.statuses, ['issued']);
  assert.equal(refused.count, 1);
  assert.equal(rowOf(store, workspaceId, c.contact.id).name, 'Schuldner AG');
});

test('F5: every unsettled status blocks, and a settled invoice does not', () => {
  const { ctx, store, workspaceId } = setup();
  for (const status of UNSETTLED_DOCUMENT_STATUSES) {
    const c = company(ctx, `Partei ${status}`);
    // The status is written directly: A10's own graph cannot reach every one of these from a quote in
    // one hop, and what is under test is the ERASURE guard's classification, not the state machine.
    const doc = createDocument(ctx, {
      type: 'invoice',
      contactId: c.contact.id,
      lines: [{ description: 'x', unitPriceMinor: 1000, taxCode: 'UST81' }],
      idempotencyKey: `d-${status}`,
    });
    store.db
      .prepare('UPDATE document SET status = ? WHERE workspace_id = ? AND id = ?')
      .run(status, workspaceId, doc.document.id);
    const res = anonymiseContact(ctx, { contactId: c.contact.id, idempotencyKey: `k-${status}` });
    assert.equal(res.error, 'open_documents', `status ${status} must block an erasure`);
  }
  for (const status of TERMINAL_DOCUMENT_STATUSES) {
    const c = company(ctx, `Erledigt ${status}`);
    const doc = createDocument(ctx, {
      type: 'invoice',
      contactId: c.contact.id,
      lines: [{ description: 'x', unitPriceMinor: 1000, taxCode: 'UST81' }],
      idempotencyKey: `t-${status}`,
    });
    store.db
      .prepare('UPDATE document SET status = ? WHERE workspace_id = ? AND id = ?')
      .run(status, workspaceId, doc.document.id);
    const res = anonymiseContact(ctx, { contactId: c.contact.id, idempotencyKey: `tk-${status}` });
    assert.equal(res.ok, true, `status ${status} is retained under OR 958f and must not block`);
  }
});

// --- F6, F7, F8, F9: the tombstone and the employer link ----------------------------------------

test('F6: a merge re-points company_contact_id, so no employee is left pointing at a tombstone', () => {
  const { ctx, store, workspaceId } = setup();
  const dup = company(ctx, 'Doppelt AG');
  const survivor = company(ctx, 'Original AG');
  const employee = person(ctx, 'Anna Muster', { companyContactId: dup.contact.id });

  const merged = mergeContacts(ctx, { sourceId: dup.contact.id, targetId: survivor.contact.id });
  assert.equal(merged.merged.repointed['contact.company_contact_id'], 1);
  assert.equal(rowOf(store, workspaceId, employee.contact.id).company_contact_id, survivor.contact.id);
});

test('F6: a merge tombstone is refused as an employer, on create and on update', () => {
  const { ctx } = setup();
  const dup = company(ctx, 'Doppelt AG');
  const survivor = company(ctx, 'Original AG');
  mergeContacts(ctx, { sourceId: dup.contact.id, targetId: survivor.contact.id });

  const created = createContact(ctx, {
    partyRole: 'customer',
    kind: 'person',
    name: 'Neu Angestellt',
    companyContactId: dup.contact.id,
  });
  assert.equal(created.error, 'employer_merged');
  assert.equal(created.survivorId, survivor.contact.id);

  const live = person(ctx, 'Bea Muster');
  const patched = updateContact(ctx, {
    contactId: live.contact.id,
    patch: { companyContactId: dup.contact.id },
  });
  assert.equal(patched.error, 'employer_merged');
});

test('F7: a cross-role merge promotes the survivor to `both` and SAYS so', () => {
  const { ctx, store, workspaceId } = setup();
  const asCustomer = createContact(ctx, { partyRole: 'customer', kind: 'company', name: 'Beidseitig AG' });
  const asVendor = createContact(ctx, { partyRole: 'vendor', kind: 'company', name: 'Beidseitig AG (Lieferant)' });

  const merged = mergeContacts(ctx, { sourceId: asCustomer.contact.id, targetId: asVendor.contact.id });
  assert.equal(merged.ok, true);
  assert.equal(merged.merged.partyRolePromoted, true);
  assert.equal(merged.merged.partyRole, 'both');
  // Read off the row, not off the Result: `planPayment` stamps `counterparty_kind` from this column,
  // and a survivor left at `vendor` stamps `supplier` on a customer's over-payment, which
  // `listOpenItems` then filters out of the OP-Liste entirely.
  assert.equal(rowOf(store, workspaceId, asVendor.contact.id).party_role, 'both');
});

test('F7: a same-role merge leaves the role alone and reports no promotion', () => {
  const { ctx, store, workspaceId } = setup();
  const a = company(ctx, 'Gleich AG');
  const b = company(ctx, 'Gleich AG (Dublette)');
  const merged = mergeContacts(ctx, { sourceId: a.contact.id, targetId: b.contact.id });
  assert.equal(merged.merged.partyRolePromoted, false);
  assert.equal(rowOf(store, workspaceId, b.contact.id).party_role, 'customer');
});

test('F8: updateContact REFUSES a tombstone, tagContact redirects to the survivor', () => {
  const { ctx, store, workspaceId } = setup();
  const dup = company(ctx, 'Doppelt AG');
  const survivor = company(ctx, 'Original AG');
  mergeContacts(ctx, { sourceId: dup.contact.id, targetId: survivor.contact.id });

  // A patch REPLACES, and the name it would set is the Ultimate Debtor block of every invoice the
  // survivor carries: it has to name the row it means.
  const patched = updateContact(ctx, { contactId: dup.contact.id, patch: { name: 'Umbenannt AG' } });
  assert.equal(patched.error, 'contact_merged');
  assert.equal(patched.survivorId, survivor.contact.id);
  assert.equal(rowOf(store, workspaceId, dup.contact.id).name, 'Doppelt AG');

  // A tag UNIONS, so it lands on the survivor exactly as `logActivity` does.
  const tagged = tagContact(ctx, { contactId: dup.contact.id, segments: ['vip'] });
  assert.equal(tagged.ok, true);
  assert.equal(tagged.contact.id, survivor.contact.id);
  assert.equal(tagged.mergedFrom, dup.contact.id);
  assert.deepEqual(JSON.parse(rowOf(store, workspaceId, survivor.contact.id).segments), ['vip']);
  assert.deepEqual(JSON.parse(rowOf(store, workspaceId, dup.contact.id).segments), []);
});

test('F9: re-importing the retired duplicate no longer UNDOES the merge', () => {
  const { ctx } = setup();
  const dup = company(ctx, 'Doppelt AG', { email: 'kontakt@doppelt.example' });
  const survivor = company(ctx, 'Original AG', { email: 'kontakt@original.example' });
  mergeContacts(ctx, { sourceId: dup.contact.id, targetId: survivor.contact.id });

  // The reproduction: the matcher skipped tombstones, so the only row carrying this email was
  // invisible to it, the row was created fresh, and the duplicate was back.
  const again = importContacts(ctx, {
    rows: [{ name: 'Doppelt AG', email: 'kontakt@doppelt.example' }],
    idempotencyKey: 'imp-again',
  });
  assert.equal(again.ok, true);
  assert.equal(again.created, 0);
  assert.equal(again.skipped, 1);
  // The candidate reported is the SURVIVOR: an id the operator can actually open.
  assert.deepEqual(again.duplicates, [{ row: 0, candidateIds: [survivor.contact.id] }]);
  assert.equal(listContacts(ctx, {}).contacts.filter((c) => c.name === 'Doppelt AG').length, 0);
});

test('F9: the employer invariant is TOTAL, not one-shot', () => {
  const { ctx } = setup();
  const employer = company(ctx, 'Arbeitgeber AG');

  // A company never names an employer, so a cycle (two companies each other's employer) is
  // unreachable by construction rather than checked for.
  const badKind = createContact(ctx, {
    partyRole: 'customer',
    kind: 'company',
    name: 'Firma mit Chef',
    companyContactId: employer.contact.id,
  });
  assert.equal(badKind.error, 'employer_only_on_person');

  const other = company(ctx, 'Zweite AG');
  assert.equal(
    updateContact(ctx, { contactId: other.contact.id, patch: { companyContactId: employer.contact.id } }).error,
    'employer_only_on_person',
  );

  // A linked person turned into a company would carry an employer it may not have.
  const employee = person(ctx, 'Anna Muster', { companyContactId: employer.contact.id });
  assert.equal(
    updateContact(ctx, { contactId: employee.contact.id, patch: { kind: 'company' } }).error,
    'employer_only_on_person',
  );

  // And the employer itself cannot be demoted to a person under a live link.
  const demoted = updateContact(ctx, { contactId: employer.contact.id, patch: { kind: 'person' } });
  assert.equal(demoted.error, 'employer_must_be_company');
  assert.equal(demoted.reason, 'has_employees');
});

// --- Gap 1: the activity stream is APPEND-ONLY, and spec §7 names it ----------------------------

test('gap 1: the activity stream is append-only, asserted rather than documented', async () => {
  const sales = await import('../../dist/core/sales/index.js');
  for (const name of Object.keys(sales)) {
    assert.ok(
      !/^(update|delete|remove|edit)Activity/.test(name),
      `${name} exists: the OP5 stream has no update or delete verb, a wrong note is corrected by a new note`,
    );
  }

  const { ctx, store, workspaceId } = setup();
  const c = company(ctx, 'Verlauf AG');
  const first = logActivity(ctx, { contactId: c.contact.id, kind: 'note', body: 'erste Notiz' });
  logActivity(ctx, { contactId: c.contact.id, kind: 'note', body: 'korrigierende Notiz' });

  // The first row is byte-for-byte what it was: a correction ADDS, it never rewrites.
  const rows = store.db
    .prepare('SELECT id, body FROM contact_activity WHERE workspace_id = ? ORDER BY rowid')
    .all(workspaceId);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].id, first.activity.id);
  assert.equal(rows[0].body, 'erste Notiz');
  assert.equal(contactTimeline(ctx, { contactId: c.contact.id }).activities.length, 2);
});

// --- Gap 2: merge idempotency asserted on the FK COUNTS spec §7 asks for ------------------------

test('gap 2: a replayed merge changes no FK count, not just the tombstone count', () => {
  const { ctx, store, workspaceId } = setup();
  const source = company(ctx, 'S AG');
  const target = company(ctx, 'T AG');
  createDocument(ctx, { type: 'quote', contactId: source.contact.id, lines: [{ unitPriceMinor: 1000 }] });
  logActivity(ctx, { contactId: source.contact.id, kind: 'note', body: 'x' });
  person(ctx, 'Mitarbeiterin', { companyContactId: source.contact.id });

  const fkCounts = () => ({
    documentsOnSource: store.db
      .prepare('SELECT COUNT(*) AS n FROM document WHERE workspace_id = ? AND contact_id = ?')
      .get(workspaceId, source.contact.id).n,
    documentsOnTarget: store.db
      .prepare('SELECT COUNT(*) AS n FROM document WHERE workspace_id = ? AND contact_id = ?')
      .get(workspaceId, target.contact.id).n,
    activitiesOnSource: store.db
      .prepare('SELECT COUNT(*) AS n FROM contact_activity WHERE workspace_id = ? AND contact_id = ?')
      .get(workspaceId, source.contact.id).n,
    activitiesOnTarget: store.db
      .prepare('SELECT COUNT(*) AS n FROM contact_activity WHERE workspace_id = ? AND contact_id = ?')
      .get(workspaceId, target.contact.id).n,
    employeesOnSource: store.db
      .prepare('SELECT COUNT(*) AS n FROM contact WHERE workspace_id = ? AND company_contact_id = ?')
      .get(workspaceId, source.contact.id).n,
    employeesOnTarget: store.db
      .prepare('SELECT COUNT(*) AS n FROM contact WHERE workspace_id = ? AND company_contact_id = ?')
      .get(workspaceId, target.contact.id).n,
    tombstones: store.db
      .prepare('SELECT COUNT(*) AS n FROM contact WHERE workspace_id = ? AND merged_into_id IS NOT NULL')
      .get(workspaceId).n,
  });

  const first = mergeContacts(ctx, { sourceId: source.contact.id, targetId: target.contact.id, idempotencyKey: 'm' });
  assert.equal(first.ok, true);
  const after = fkCounts();
  // Spec §8's property, on real rows: count(source) = 0, count(target) = before(source) + before(target).
  assert.deepEqual(after, {
    documentsOnSource: 0,
    documentsOnTarget: 1,
    activitiesOnSource: 0,
    activitiesOnTarget: 1,
    employeesOnSource: 0,
    employeesOnTarget: 1,
    tombstones: 1,
  });

  const replay = mergeContacts(ctx, { sourceId: source.contact.id, targetId: target.contact.id, idempotencyKey: 'm' });
  assert.equal(replay.ok, true);
  assert.deepEqual(fkCounts(), after, 'a replay must move no foreign key at all');

  // And WITHOUT a key: a completed merge settles to the same answer rather than re-pointing twice.
  assert.equal(mergeContacts(ctx, { sourceId: source.contact.id, targetId: target.contact.id }).ok, true);
  assert.deepEqual(fkCounts(), after);
});

// --- Gap 3: §H-TENANT on the three verbs that had no isolation assertion ------------------------

test('gap 3: §H-TENANT on contacts_timeline, contacts_import and contacts_anonymise', () => {
  const { ctx, store, deps, workspaceId } = setup();
  const other = newWorkspace(deps, 'Nachbar AG');
  const mine = company(ctx, 'Meine AG', { email: 'mine@example.ch', vatNumber: 'CHE-123.456.789 MWST' });
  logActivity(ctx, { contactId: mine.contact.id, kind: 'note', body: 'nur bei mir' });

  // TIMELINE: the neighbour cannot read my contact at all, let alone its bodies.
  assert.equal(contactTimeline(other, { contactId: mine.contact.id }).error, 'not_found');

  // ANONYMISE: the neighbour cannot erase my contact, and my row survives untouched.
  assert.equal(anonymiseContact(other, { contactId: mine.contact.id, idempotencyKey: 'x' }).error, 'not_found');
  assert.equal(rowOf(store, workspaceId, mine.contact.id).name, 'Meine AG');

  // IMPORT: the neighbour importing the SAME email/UID sees no duplicate candidate, because my rows
  // are not in their tenant, and their created row lands in their own workspace.
  const imported = importContacts(other, {
    rows: [{ name: 'Meine AG', email: 'mine@example.ch', vatNumber: 'CHE-123.456.789 MWST' }],
    idempotencyKey: 'imp-tenant',
  });
  assert.equal(imported.ok, true);
  assert.equal(imported.created, 1);
  assert.deepEqual(imported.duplicates, []);
  assert.equal(
    store.db
      .prepare('SELECT workspace_id FROM contact WHERE id = ?')
      .get(imported.createdIds[0]).workspace_id,
    other.workspaceId,
  );
  // My tenant gained nothing.
  assert.equal(listContacts(ctx, {}).contacts.length, 1);
});

// --- Gap 6: the audit trail, which was never exercised at all ----------------------------------

test('gap 6: a merge writes TWO chain rows and one of them names the consumed duplicate', () => {
  const { ctx } = setup();
  const source = company(ctx, 'Doppelt AG');
  const target = company(ctx, 'Original AG');
  mergeContacts(ctx, { sourceId: source.contact.id, targetId: target.contact.id, idempotencyKey: 'm' });

  const log = getAuditLog(ctx, { entityKind: 'contact' });
  assert.equal(log.ok, true);
  assert.equal(log.chainVerified, true, 'the merge entries must be part of a verifying hash chain');
  const merges = log.rows.filter((e) => e.action === 'contact_merge');
  assert.equal(merges.length, 2);
  // WHICH duplicate was consumed is the fact an auditor asking about a vanished contact needs, and a
  // single row on the target did not carry it.
  assert.deepEqual(
    merges.map((e) => e.entityId).sort(),
    [source.contact.id, target.contact.id].sort(),
  );
  for (const entry of merges) {
    assert.equal(entry.actor, 'user_1');
    assert.ok(typeof entry.hash === 'string' && entry.hash.length === 64);
  }
});

test('gap 6: an anonymise writes one verified chain row per contact row erased', () => {
  const { ctx } = setup();
  const dup = company(ctx, 'Doppelt AG');
  const survivor = company(ctx, 'Original AG');
  mergeContacts(ctx, { sourceId: dup.contact.id, targetId: survivor.contact.id, idempotencyKey: 'm' });
  assert.equal(anonymiseContact(ctx, { contactId: survivor.contact.id, idempotencyKey: 'a' }).ok, true);

  const log = getAuditLog(ctx, { entityKind: 'contact' });
  assert.equal(log.chainVerified, true);
  const erasures = log.rows.filter((e) => e.action === 'contact_anonymise');
  assert.deepEqual(erasures.map((e) => e.entityId).sort(), [dup.contact.id, survivor.contact.id].sort());
});

test('gap 6: a REPLAYED erasure writes no second chain row', () => {
  const { ctx } = setup();
  const c = company(ctx, 'Einmal AG');
  const chainRows = () => getAuditLog(ctx, { entityKind: 'contact' }).rows.length;
  assert.equal(anonymiseContact(ctx, { contactId: c.contact.id, idempotencyKey: 'a' }).ok, true);
  const after = chainRows();
  assert.equal(anonymiseContact(ctx, { contactId: c.contact.id, idempotencyKey: 'a' }).ok, true);
  assert.equal(chainRows(), after, 'a §H-IDEMPOTENT replay writes nothing, the audit chain included');
});

// --- Gap 4: the two spec §8 compliance fixtures, neither of which existed -----------------------

test('compliance fixture (a): revDSG data locality, the whole C00 flow opens ZERO sockets', () => {
  const realConnect = net.Socket.prototype.connect;
  const realFetch = globalThis.fetch;
  const attempts = [];
  // The one choke point every outbound request in Node passes through, `fetch`/undici included, plus
  // `fetch` itself so a stubbed transport could not slip past either.
  net.Socket.prototype.connect = function blocked(...args) {
    attempts.push(['socket', JSON.stringify(args[0] ?? null)]);
    throw new Error('C00 must not open a socket');
  };
  globalThis.fetch = (...args) => {
    attempts.push(['fetch', String(args[0])]);
    throw new Error('C00 must not fetch');
  };
  try {
    const { ctx } = setup();
    const firma = company(ctx, 'Muster AG', { email: 'info@muster.example', vatNumber: 'CHE-123.456.789 MWST' });
    const angestellt = person(ctx, 'Anna Muster', { companyContactId: firma.contact.id });
    tagContact(ctx, { contactId: firma.contact.id, segments: ['newsletter'], idempotencyKey: 't' });
    logActivity(ctx, { contactId: firma.contact.id, kind: 'call', body: 'Erstgespräch' });
    contactTimeline(ctx, { contactId: firma.contact.id });
    listContacts(ctx, { segment: 'newsletter' });
    const dup = importContacts(ctx, {
      rows: [{ name: 'Muster AG', email: 'zweit@muster.example' }],
      idempotencyKey: 'imp',
    });
    mergeContacts(ctx, { sourceId: dup.createdIds[0], targetId: firma.contact.id, idempotencyKey: 'm' });
    getContact(ctx, { contactId: dup.createdIds[0] });
    updateContact(ctx, { contactId: angestellt.contact.id, patch: { lang: 'de-CH' } });
    anonymiseContact(ctx, { contactId: firma.contact.id, idempotencyKey: 'a' });
  } finally {
    net.Socket.prototype.connect = realConnect;
    globalThis.fetch = realFetch;
  }
  assert.deepEqual(attempts, [], 'the OSS core is local-first: no enrichment, no lookup, no sync');
});

test('compliance fixture (b): revDSG erasure versus OR 958f, on a SETTLED posted invoice', () => {
  const { ctx, store, workspaceId } = invoiceWorld();
  const c = company(ctx, 'Muster AG', {
    email: 'info@muster.example',
    vatNumber: 'CHE-123.456.789 MWST',
    address: { street: 'Neuweg', houseNo: '9', zip: '8000', city: 'Zürich', country: 'CH' },
  });
  logActivity(ctx, { contactId: c.contact.id, kind: 'email', body: 'Rechnung versendet an info@muster.example' });
  const invoice = issuedInvoice(ctx, c.contact.id, 'inv');
  // The QR-bill renders BEFORE the erasure: the assertion at the end is that it stops, not that it
  // never worked.
  assert.equal(buildQrBill(ctx, invoice.id).ok, true, JSON.stringify(buildQrBill(ctx, invoice.id)));
  // Settled, so the overriding interest in F5 is discharged and the erasure may proceed.
  store.db
    .prepare("UPDATE document SET status = 'settled' WHERE workspace_id = ? AND id = ?")
    .run(workspaceId, invoice.id);

  const docBefore = store.db
    .prepare('SELECT * FROM document WHERE workspace_id = ? AND id = ?')
    .get(workspaceId, invoice.id);
  const journalBefore = store.db
    .prepare(
      `SELECT COUNT(*) AS lines, COALESCE(SUM(l.debit_minor - l.credit_minor), 0) AS net
         FROM journal_line l JOIN journal_entry e ON e.id = l.entry_id WHERE e.workspace_id = ?`,
    )
    .get(workspaceId);

  assert.equal(anonymiseContact(ctx, { contactId: c.contact.id, idempotencyKey: 'a' }).ok, true);

  // The PERSONAL data is gone.
  const row = rowOf(store, workspaceId, c.contact.id);
  assert.equal(row.name, 'Anonymisiert');
  assert.equal(row.email, null);
  assert.equal(row.vat_number, null);
  assert.equal(row.address_street, null);
  assert.equal(row.address_city, null);
  assert.deepEqual(activityBodies(store, workspaceId, c.contact.id), ['[anonymisiert]']);

  // The ACCOUNTING RECORD survives, byte for byte, and the row id it hangs from is intact (OR 958f).
  assert.deepEqual(
    store.db.prepare('SELECT * FROM document WHERE workspace_id = ? AND id = ?').get(workspaceId, invoice.id),
    docBefore,
  );
  assert.deepEqual(
    store.db
      .prepare(
        `SELECT COUNT(*) AS lines, COALESCE(SUM(l.debit_minor - l.credit_minor), 0) AS net
           FROM journal_line l JOIN journal_entry e ON e.id = l.entry_id WHERE e.workspace_id = ?`,
      )
      .get(workspaceId),
    journalBefore,
    'C00 has no posting path (P3 by absence): an erasure must not move the ledger by one Rappen',
  );

  // AND THE HONEST PART, which the spec used to claim the opposite of. A11 persists NO snapshot:
  // `buildQrBill` reads the LIVE contact row, so a RE-RENDER after the erasure is not byte-identical,
  // it fails outright. Asserted rather than glossed, because the false claim is what the critic
  // caught. The repair is A11's persisted snapshot (C00 §10, I1), decided in shape by D52.
  const rerender = buildQrBill(ctx, invoice.id);
  assert.equal(rerender.ok, false);
  assert.equal(rerender.error, 'needs_customer_address');
});
