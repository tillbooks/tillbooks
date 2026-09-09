// C00, contacts / CRM core: the engine invariants the money path and the wave gate depend on.
//
// These prove the properties a merge/anonymise/tag/activity surface must hold before it lands:
// §H-TENANT on every query, merge idempotency asserted on ROWS (not on a returned id), tombstone
// exclusion + transitive merge-chain resolution, the append-only activity stream, and the revDSG
// anonymise path that keeps posted-document FKs intact. C00 has NO posting path (P3 by absence), so
// there is no ledger assertion here: a contact is pre-financial master data.

import test from 'node:test';
import assert from 'node:assert/strict';

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
} from '../../dist/core/sales/index.js';
import { setup, newWorkspace } from './support.mjs';

const company = (ctx, name) => createContact(ctx, { partyRole: 'customer', kind: 'company', name });
const person = (ctx, name, extra = {}) =>
  createContact(ctx, { partyRole: 'customer', kind: 'person', name, ...extra });

// --- kind + employer link (US-C00.1) -----------------------------------------------------------

test('kind defaults to company, and an explicit person + employer link round-trips', () => {
  const { ctx } = setup();
  const bare = createContact(ctx, { partyRole: 'customer', name: 'Default GmbH' });
  assert.equal(bare.contact.kind, 'company');

  const employer = company(ctx, 'Muster AG');
  const p = person(ctx, 'Anna Muster', { companyContactId: employer.contact.id });
  assert.equal(p.ok, true);
  assert.equal(p.contact.kind, 'person');
  assert.equal(p.contact.companyContactId, employer.contact.id);
});

test('an employer must be a company contact, and must exist in this tenant', () => {
  const { ctx } = setup();
  const p = person(ctx, 'Bea Muster');
  const bad = createContact(ctx, {
    partyRole: 'customer',
    kind: 'person',
    name: 'Chris',
    companyContactId: p.contact.id,
  });
  assert.equal(bad.error, 'employer_must_be_company');

  const ghost = createContact(ctx, { partyRole: 'customer', kind: 'person', name: 'D', companyContactId: 'nope' });
  assert.equal(ghost.error, 'not_found');
});

test('an invalid kind and an invalid lang are refused at the single enum point', () => {
  const { ctx } = setup();
  assert.equal(createContact(ctx, { partyRole: 'customer', name: 'X', kind: 'robot' }).error, 'invalid_contact_kind');
  assert.equal(createContact(ctx, { partyRole: 'customer', name: 'X', lang: 'es' }).error, 'invalid_lang');
});

// --- tags & segments (US-C00.2) ----------------------------------------------------------------

test('tagContact unions into the arrays, dedupes case-insensitively, and enforces the limits', () => {
  const { ctx } = setup();
  const c = company(ctx, 'Tag AG');
  tagContact(ctx, { contactId: c.contact.id, segments: ['newsletter', 'VIP'] });
  const again = tagContact(ctx, { contactId: c.contact.id, segments: ['newsletter', 'kanton-zh'] });
  assert.deepEqual(again.contact.segments, ['newsletter', 'VIP', 'kanton-zh']);

  const long = tagContact(ctx, { contactId: c.contact.id, roles: ['x'.repeat(41)] });
  assert.equal(long.error, 'tag_too_long');

  const many = Array.from({ length: 51 }, (_, i) => `seg${i}`);
  assert.equal(tagContact(ctx, { contactId: c.contact.id, segments: many }).error, 'too_many_tags');
});

test('listContacts filters by segment with EXACT membership, never a substring collision', () => {
  const { ctx } = setup();
  const a = company(ctx, 'A AG');
  const b = company(ctx, 'B AG');
  tagContact(ctx, { contactId: a.contact.id, segments: ['newsletter'] });
  tagContact(ctx, { contactId: b.contact.id, segments: ['newsletter_paused'] });
  const hits = listContacts(ctx, { segment: 'newsletter' });
  assert.deepEqual(hits.contacts.map((c) => c.name), ['A AG']);
});

// --- activity log (US-C00.3, the OP5 seam) -----------------------------------------------------

test('logActivity appends, timeline reads newest-first, and the stream validates kind + time', () => {
  const { ctx } = setup();
  const c = company(ctx, 'Verlauf AG');
  logActivity(ctx, { contactId: c.contact.id, kind: 'note', body: 'älter', occurredAt: '2026-01-01' });
  logActivity(ctx, { contactId: c.contact.id, kind: 'call', body: 'neuer', occurredAt: '2026-05-01' });

  const tl = contactTimeline(ctx, { contactId: c.contact.id });
  assert.deepEqual(tl.activities.map((a) => a.body), ['neuer', 'älter']);
  assert.equal(tl.activities[0].userId, 'user_1');

  assert.equal(logActivity(ctx, { contactId: c.contact.id, kind: 'sms', body: 'x' }).error, 'invalid_activity_kind');
  assert.equal(logActivity(ctx, { contactId: c.contact.id, kind: 'note', body: '  ' }).error, 'invalid_input');
  const future = logActivity(ctx, { contactId: c.contact.id, kind: 'note', body: 'x', occurredAt: '2099-01-01' });
  assert.equal(future.error, 'occurred_in_future');
});

// --- merge (US-C00.4) --------------------------------------------------------------------------

test('mergeContacts re-points document + activity FKs, tombstones the source, and consolidates', () => {
  const { ctx } = setup();
  const source = company(ctx, 'Doppelt AG');
  const target = company(ctx, 'Original AG');
  createDocument(ctx, { type: 'quote', contactId: source.contact.id, lines: [{ unitPriceMinor: 1000 }] });
  logActivity(ctx, { contactId: source.contact.id, kind: 'note', body: 'auf der Quelle' });

  const merged = mergeContacts(ctx, { sourceId: source.contact.id, targetId: target.contact.id });
  assert.equal(merged.ok, true);
  // Keyed by table AND column: `contact.company_contact_id` is a re-point surface too, so a bare
  // table key could let a second contact-owned FK overwrite the first one's count.
  assert.equal(merged.merged.repointed['document.contact_id'], 1);
  assert.equal(merged.merged.repointed['contact_activity.contact_id'], 1);
  assert.equal(merged.merged.repointed['contact.company_contact_id'], 0);

  // A read of the tombstone lands on the survivor and reports where it came from.
  const followed = getContact(ctx, { contactId: source.contact.id });
  assert.equal(followed.contact.id, target.contact.id);
  assert.equal(followed.mergedFrom, source.contact.id);

  // The tombstone is gone from the list, and the survivor now carries the source's activity.
  const names = listContacts(ctx, {}).contacts.map((c) => c.name);
  assert.ok(!names.includes('Doppelt AG'));
  assert.equal(contactTimeline(ctx, { contactId: target.contact.id }).activities.length, 1);
});

test('mergeContacts is idempotent on ROWS: the same key twice writes nothing the second time', () => {
  const { ctx, store, workspaceId } = setup();
  const source = company(ctx, 'S AG');
  const target = company(ctx, 'T AG');
  logActivity(ctx, { contactId: source.contact.id, kind: 'note', body: 'x' });

  const rowCount = () =>
    store.db.prepare('SELECT COUNT(*) AS n FROM contact WHERE workspace_id = ? AND merged_into_id IS NOT NULL').get(workspaceId).n;

  const first = mergeContacts(ctx, { sourceId: source.contact.id, targetId: target.contact.id, idempotencyKey: 'm-1' });
  const tombstonesAfterFirst = rowCount();
  const second = mergeContacts(ctx, { sourceId: source.contact.id, targetId: target.contact.id, idempotencyKey: 'm-1' });
  assert.deepEqual(second, first);
  assert.equal(rowCount(), tombstonesAfterFirst, 'a replay must not create a second tombstone');
});

test('mergeContacts refuses a self-merge and a tombstone target, and resolves chains transitively', () => {
  const { ctx } = setup();
  const a = company(ctx, 'A');
  const b = company(ctx, 'B');
  const cc = company(ctx, 'C');
  assert.equal(mergeContacts(ctx, { sourceId: a.contact.id, targetId: a.contact.id }).error, 'self_merge');

  mergeContacts(ctx, { sourceId: a.contact.id, targetId: b.contact.id });
  mergeContacts(ctx, { sourceId: b.contact.id, targetId: cc.contact.id });
  // A -> B -> C: a read of A lands on C.
  assert.equal(getContact(ctx, { contactId: a.contact.id }).contact.id, cc.contact.id);

  // B is now a tombstone; merging into it is refused.
  assert.equal(mergeContacts(ctx, { sourceId: cc.contact.id, targetId: b.contact.id }).error, 'target_merged');
});

// --- anonymise (US-C00.6, revDSG bounded by OR 958f) -------------------------------------------

test('anonymiseContact blanks personal fields, redacts activities, and keeps the row id', () => {
  const { ctx } = setup();
  const c = person(ctx, 'Privat Person', { email: 'privat@example.ch' });
  logActivity(ctx, { contactId: c.contact.id, kind: 'call', body: 'sensibler Inhalt' });

  const done = anonymiseContact(ctx, { contactId: c.contact.id });
  assert.equal(done.ok, true);
  assert.equal(done.contact.id, c.contact.id, 'the id survives so posted-document FKs stay intact');
  assert.equal(done.contact.name, 'Anonymisiert');
  assert.equal(done.contact.email, null);
  assert.equal(contactTimeline(ctx, { contactId: c.contact.id }).activities[0].body, '[anonymisiert]');
});

test('anonymiseContact refuses while an open (draft) document still references the contact', () => {
  const { ctx } = setup();
  const c = person(ctx, 'Mit Entwurf');
  createDocument(ctx, { type: 'invoice', contactId: c.contact.id, lines: [{ unitPriceMinor: 1000 }] });
  assert.equal(anonymiseContact(ctx, { contactId: c.contact.id }).error, 'open_documents');
});

// --- import (US-C00.5) -------------------------------------------------------------------------

test('importContacts creates clean rows and returns matches as duplicates without auto-merging', () => {
  const { ctx } = setup();
  createContact(ctx, { partyRole: 'customer', name: 'Bestehend AG', email: 'kontakt@bestehend.ch' });
  const res = importContacts(ctx, {
    rows: [
      { partyRole: 'customer', name: 'Neu GmbH', email: 'neu@example.ch' },
      { partyRole: 'customer', name: 'Bestehend AG', email: 'kontakt@bestehend.ch' },
    ],
    idempotencyKey: 'imp-1',
  });
  assert.equal(res.created, 1);
  assert.equal(res.skipped, 1);
  assert.equal(res.duplicates.length, 1);
  assert.equal(res.duplicates[0].row, 1);

  // Re-running the same import under the same key is a no-op (same result, no second contact).
  const replay = importContacts(ctx, { rows: res ? [] : [], idempotencyKey: 'imp-1' });
  assert.equal(replay.created, 1, 'the stored result is replayed, not recomputed on the empty rows');
});

test('importContacts rejects a non-array payload as invalid_import_format', () => {
  const { ctx } = setup();
  assert.equal(importContacts(ctx, { rows: 'nope', idempotencyKey: 'imp-bad' }).error, 'invalid_import_format');
});

// --- §H-TENANT ---------------------------------------------------------------------------------

test('every C00 query is tenant-scoped: a contact from another workspace is invisible', () => {
  const { ctx, deps } = setup();
  const other = newWorkspace(deps, 'Other AG');
  const theirs = company(other, 'Fremd AG');

  // Reads, tags, merges and the timeline all refuse to reach across the tenant boundary.
  assert.equal(getContact(ctx, { contactId: theirs.contact.id }).error, 'not_found');
  assert.equal(tagContact(ctx, { contactId: theirs.contact.id, segments: ['x'] }).error, 'not_found');
  assert.equal(logActivity(ctx, { contactId: theirs.contact.id, kind: 'note', body: 'x' }).error, 'not_found');
  const mine = company(ctx, 'Mein AG');
  assert.equal(mergeContacts(ctx, { sourceId: theirs.contact.id, targetId: mine.contact.id }).error, 'not_found');
});
