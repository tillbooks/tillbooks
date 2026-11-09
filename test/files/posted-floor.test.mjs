// D63: the statutory retention floor derives from POSTED evidence, not from a link.
//
// The trap this rule dissolves was measured before it was decided: the re-critic sealed
// `retention_statutory_until` so nothing can lower it, and a `files_link` to a DRAFT journal entry
// dated 2030 then locked the file to 2040-12-31 forever, surviving the draft's own deletion, with
// `set_retention` answering `retention_below_statutory` and `delete` answering `retention_locked` and
// no verb anywhere that could undo it. Safe for OR 958f, and exactly the revDSG data-minimisation
// tension E00 itself invokes when it refuses to derive a lock from a contact link.
//
// So this suite asserts the D63 shape end to end, through the product's own verbs:
//
//   1. a link to a DRAFT derives nothing;
//   2. the floor attaches at the moment the entry POSTS, in the posting transaction itself;
//   3. deleting a never-posted draft releases the derived floor (there was nothing to release);
//   4. a floor a POSTED record contributed survives every release path that exists, including the
//      deletion of a draft the file was later re-linked to;
//   5. the posting-time hook is idempotent on ROWS;
//   6. §H-TENANT: posting in one workspace derives nothing in another, and postedness itself cannot
//      be probed across tenants.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  uploadFile,
  linkFile,
  setFileRetention,
  deleteFile,
  deriveStatutoryOnPost,
  isPostedAccountingRecord,
  ACCOUNTING_POSTED_CLAUSES,
  ACCOUNTING_ENTITY_KINDS,
  retentionFloor,
  effectiveRetentionUntil,
} from '../../dist/core/files/index.js';
import { postEntry, saveDraft, deleteDraft } from '../../dist/core/ledger/index.js';
import { createContact, createDocument, transitionDocument } from '../../dist/core/sales/index.js';
import { listAccounts } from '../../dist/core/accounts/index.js';
import { entityKindDef } from '../../dist/core/customization/index.js';
import { setup, newWorkspace, b64, counts } from './support.mjs';

const file = (ctx, seed = 'beleg') =>
  uploadFile(ctx, { title: seed, filename: `${seed}.pdf`, contentBase64: b64(`inhalt ${seed}`) }).file;

/** Two balanced lines over the seeded KMU chart, so a draft or a post is one call. */
function lines(ctx, amount = 10000) {
  const accounts = listAccounts(ctx).accounts;
  const bank = accounts.find((a) => a.number === '1020') ?? accounts[0];
  const revenue = accounts.find((a) => a.number === '3000') ?? accounts[1];
  return [
    { account: bank.id, debit: amount },
    { account: revenue.id, credit: amount },
  ];
}

function draftEntry(ctx, seed, date = '2030-06-01') {
  const saved = saveDraft(ctx, { date, lines: lines(ctx), idempotencyKey: `${seed}-draft` });
  assert.equal(saved.ok, true, `saveDraft refused, so this test proves nothing: ${JSON.stringify(saved)}`);
  return saved.entryId;
}

function postDraft(ctx, entryId, seed, date = '2030-06-01') {
  const posted = postEntry(ctx, {
    entryId,
    date,
    source: 'manual',
    idempotencyKey: `${seed}-post`,
    lines: lines(ctx),
  });
  assert.equal(posted.ok, true, `the promotion refused: ${JSON.stringify(posted)}`);
  return posted.entryId;
}

// --- 1. A draft derives nothing ----------------------------------------------------------------

test('D63: a link to a DRAFT journal entry derives no floor, and the file stays fully free', () => {
  const { ctx } = setup();
  const beleg = file(ctx);
  const entryId = draftEntry(ctx, 'e1');

  const linked = linkFile(ctx, { fileId: beleg.id, entityKind: 'journal_entry', entityId: entryId, idempotencyKey: 'l' });
  assert.equal(linked.ok, true);
  assert.equal(linked.retentionDerived, false);
  assert.equal(linked.file.retentionUntil, null);
  assert.equal(linked.file.retentionStatutoryUntil, null);
  assert.equal(linked.file.retentionLocked, false);

  // No floor means both guards stay open: a short manual retention is legal, and so is deletion.
  const row = ctx.store.db.prepare('SELECT * FROM stored_file WHERE id = ?').get(beleg.id);
  assert.equal(retentionFloor(ctx, row), null);
  assert.equal(setFileRetention(ctx, { fileId: beleg.id, retentionUntil: '2026-12-31', idempotencyKey: 'r' }).ok, true);
});

test('D63: a link to a draft document (before issue) derives no floor either', () => {
  const { ctx } = setup();
  const contact = createContact(ctx, { partyRole: 'customer', name: 'Kunde AG' }).contact;
  const doc = createDocument(ctx, {
    type: 'invoice',
    contactId: contact.id,
    lines: [{ description: 'Beratung', unitPriceMinor: 100000 }],
  }).document;
  const beleg = file(ctx);
  const linked = linkFile(ctx, { fileId: beleg.id, entityKind: 'document', entityId: doc.id, idempotencyKey: 'l' });
  assert.equal(linked.retentionDerived, false);
  assert.equal(linked.file.retentionStatutoryUntil, null);
});

// --- 2. The floor attaches at the moment of posting --------------------------------------------

test('D63: posting the linked draft attaches the floor, anchored on the ENTRY date, permanently', () => {
  const { ctx } = setup();
  const beleg = file(ctx);
  const entryId = draftEntry(ctx, 'e2', '2030-06-01');
  linkFile(ctx, { fileId: beleg.id, entityKind: 'journal_entry', entityId: entryId, idempotencyKey: 'l' });
  assert.equal(ctx.store.db.prepare('SELECT retention_statutory_until AS s FROM stored_file WHERE id = ?').get(beleg.id).s, null);

  postDraft(ctx, entryId, 'e2', '2030-06-01');

  // The hook wrote the durable column in the posting transaction: 2030 fiscal year end + 10 years.
  const row = ctx.store.db.prepare('SELECT * FROM stored_file WHERE id = ?').get(beleg.id);
  assert.equal(row.retention_statutory_until, '2040-12-31');
  assert.equal(row.retention_until, '2040-12-31');
  assert.equal(row.retention_source, 'statutory_auto');
  assert.equal(retentionFloor(ctx, row), '2040-12-31');

  // And from this moment the seal is exactly the one the re-critic attacked: nothing lowers it.
  assert.equal(
    setFileRetention(ctx, { fileId: beleg.id, retentionUntil: '2031-01-01', idempotencyKey: 'r' }).error,
    'retention_below_statutory',
  );
  assert.equal(deleteFile(ctx, { fileId: beleg.id, idempotencyKey: 'd' }).error, 'retention_locked');
});

// --- 3. A never-posted draft releases on its own deletion --------------------------------------

test('D63: deleting a never-posted draft releases the file completely', () => {
  // The reproduced trap, replayed against the fix: draft dated 2030, linked, deleted. Before D63 the
  // file was locked to 2040-12-31 forever; now nothing it evidenced ever entered the books, so
  // nothing is locked and the revDSG erasure duty is servable again.
  const fixture = setup();
  const { ctx } = fixture;
  const beleg = file(ctx);
  const entryId = draftEntry(ctx, 'e3', '2030-06-01');
  linkFile(ctx, { fileId: beleg.id, entityKind: 'journal_entry', entityId: entryId, idempotencyKey: 'l' });

  assert.equal(deleteDraft(ctx, { entryId, idempotencyKey: 'e3-del' }).ok, true);

  const row = ctx.store.db.prepare('SELECT * FROM stored_file WHERE id = ?').get(beleg.id);
  assert.equal(retentionFloor(ctx, row), null, 'no posted record ever contributed, so no floor stands');
  assert.equal(effectiveRetentionUntil(ctx, row), null);
  const removed = deleteFile(ctx, { fileId: beleg.id, idempotencyKey: 'd' });
  assert.equal(removed.ok, true);
  assert.equal(removed.deleted, true);
  assert.equal(counts(fixture.store, fixture.workspaceId).blobs, 0);
});

test('D63: cancelling a draft document (which deletes it) releases the file the same way', () => {
  const { ctx } = setup();
  const contact = createContact(ctx, { partyRole: 'customer', name: 'Kunde AG' }).contact;
  const doc = createDocument(ctx, {
    type: 'invoice',
    contactId: contact.id,
    lines: [{ description: 'Beratung', unitPriceMinor: 100000 }],
  }).document;
  const beleg = file(ctx);
  linkFile(ctx, { fileId: beleg.id, entityKind: 'document', entityId: doc.id, idempotencyKey: 'l' });

  const cancelled = transitionDocument(ctx, { documentId: doc.id, to: 'cancelled', idempotencyKey: 'c' });
  assert.equal(cancelled.ok, true);
  assert.equal(cancelled.deleted, true, 'a draft cancellation is a real deletion');

  assert.equal(deleteFile(ctx, { fileId: beleg.id, idempotencyKey: 'd' }).ok, true);
});

// --- 4. A posted floor survives every release path ---------------------------------------------

test('D63: a floor a POSTED record contributed survives a re-link to a draft AND that draft dying', () => {
  const { ctx } = setup();
  const beleg = file(ctx);

  // Post first, link second: the link itself records the floor durably.
  const postedId = postDraft(ctx, draftEntry(ctx, 'e4', '2026-05-01'), 'e4', '2026-05-01');
  linkFile(ctx, { fileId: beleg.id, entityKind: 'journal_entry', entityId: postedId, idempotencyKey: 'l1' });
  assert.equal(
    ctx.store.db.prepare('SELECT retention_statutory_until AS s FROM stored_file WHERE id = ?').get(beleg.id).s,
    '2036-12-31',
  );

  // Re-link to a DRAFT (derives nothing) and then delete that draft: the deletable target, deleted.
  const draftId = draftEntry(ctx, 'e5', '2030-06-01');
  linkFile(ctx, { fileId: beleg.id, entityKind: 'journal_entry', entityId: draftId, idempotencyKey: 'l2' });
  assert.equal(deleteDraft(ctx, { entryId: draftId, idempotencyKey: 'e5-del' }).ok, true);

  // The recorded floor stands on both guards: the recompute may not touch what posting contributed.
  const row = ctx.store.db.prepare('SELECT * FROM stored_file WHERE id = ?').get(beleg.id);
  assert.equal(row.retention_statutory_until, '2036-12-31', 'the recorded column survived both moves');
  assert.equal(retentionFloor(ctx, row), '2036-12-31');
  assert.equal(
    setFileRetention(ctx, { fileId: beleg.id, retentionUntil: '2030-01-01', idempotencyKey: 'r' }).error,
    'retention_below_statutory',
  );
  assert.equal(deleteFile(ctx, { fileId: beleg.id, idempotencyKey: 'd' }).error, 'retention_locked');
});

test('D63: the draft-derived NOTHING never shortens a floor already earned (the seal direction)', () => {
  // The inverse ordering of the test above: floor first through the HOOK, then a draft link. The
  // draft contributes nothing, and contributing nothing must not be confused with contributing null.
  const { ctx } = setup();
  const beleg = file(ctx);
  const entryId = draftEntry(ctx, 'e6', '2026-05-01');
  linkFile(ctx, { fileId: beleg.id, entityKind: 'journal_entry', entityId: entryId, idempotencyKey: 'l1' });
  postDraft(ctx, entryId, 'e6', '2026-05-01');

  const draftId = draftEntry(ctx, 'e7', '2027-06-01');
  const relinked = linkFile(ctx, { fileId: beleg.id, entityKind: 'journal_entry', entityId: draftId, idempotencyKey: 'l2' });
  assert.equal(relinked.ok, true);
  assert.equal(relinked.file.retentionStatutoryUntil, '2036-12-31', 'the earned floor is untouched');
  assert.equal(relinked.file.retentionUntil, '2036-12-31');
});

// --- 5. The hook is idempotent on ROWS ---------------------------------------------------------

test('D63: the posting hook is idempotent on ROWS, directly and through an idempotent replay', () => {
  const { ctx } = setup();
  const beleg = file(ctx);
  const entryId = draftEntry(ctx, 'e8', '2030-06-01');
  linkFile(ctx, { fileId: beleg.id, entityKind: 'journal_entry', entityId: entryId, idempotencyKey: 'l' });
  postDraft(ctx, entryId, 'e8', '2030-06-01');

  const first = ctx.store.db.prepare('SELECT * FROM stored_file WHERE id = ?').get(beleg.id);
  assert.equal(first.retention_statutory_until, '2040-12-31');

  // A second direct run writes nothing: both dates already carry the values `later` would produce,
  // so the early-out leaves even `updated_at` alone.
  assert.equal(deriveStatutoryOnPost(ctx, 'journal_entry', entryId), 0);
  assert.deepEqual(ctx.store.db.prepare('SELECT * FROM stored_file WHERE id = ?').get(beleg.id), first);

  // And the replay of the posting itself is memoised before the hook, so it re-runs nothing at all.
  const replayed = postEntry(ctx, {
    entryId,
    date: '2030-06-01',
    source: 'manual',
    idempotencyKey: 'e8-post',
    lines: lines(ctx),
  });
  assert.equal(replayed.ok, true);
  assert.deepEqual(ctx.store.db.prepare('SELECT * FROM stored_file WHERE id = ?').get(beleg.id), first);
  assert.equal(ctx.store.db.prepare('SELECT COUNT(*) AS n FROM stored_file').get().n, 1);
});

// --- 6. §H-TENANT ------------------------------------------------------------------------------

test('D63: posting in one workspace derives nothing in another, and postedness does not cross tenants', () => {
  const { ctx, deps } = setup();
  const other = newWorkspace(deps, 'Nachbar GmbH');

  // The same shape on both sides: a file linked to a draft entry.
  const ourFile = file(ctx, 'unser');
  const ourDraft = draftEntry(ctx, 'we', '2030-06-01');
  linkFile(ctx, { fileId: ourFile.id, entityKind: 'journal_entry', entityId: ourDraft, idempotencyKey: 'l1' });

  const theirFile = file(other, 'ihr');
  const theirDraft = draftEntry(other, 'they', '2030-06-01');
  linkFile(other, { fileId: theirFile.id, entityKind: 'journal_entry', entityId: theirDraft, idempotencyKey: 'l2' });

  // OUR draft posts. THEIR file must stay free.
  postDraft(ctx, ourDraft, 'we', '2030-06-01');
  assert.equal(
    ctx.store.db.prepare('SELECT retention_statutory_until AS s FROM stored_file WHERE id = ?').get(ourFile.id).s,
    '2040-12-31',
  );
  assert.equal(
    other.store.db.prepare('SELECT retention_statutory_until AS s FROM stored_file WHERE id = ?').get(theirFile.id).s,
    null,
  );

  // Postedness is scoped: their posted entry is not posted evidence from OUR side of the boundary,
  // and the hook aimed across the boundary derives nothing.
  postDraft(other, theirDraft, 'they', '2030-06-01');
  assert.equal(isPostedAccountingRecord(other, 'journal_entry', theirDraft), true);
  assert.equal(isPostedAccountingRecord(ctx, 'journal_entry', theirDraft), false);
  assert.equal(deriveStatutoryOnPost(ctx, 'journal_entry', theirDraft), 0);
});

// --- The map discipline ------------------------------------------------------------------------

test('the posted-clause map covers every accounting kind, and only real tables', () => {
  // The same discipline `ACCOUNTING_DATE_COLUMNS` is held to, so the map cannot rot into ghosts: a
  // kind added to `ACCOUNTING_ENTITY_KINDS` without a postedness answer fails here, which is the one
  // moment somebody states when records of that kind become evidence.
  const { ctx } = setup();
  assert.deepEqual([...ACCOUNTING_POSTED_CLAUSES.keys()].sort(), [...ACCOUNTING_ENTITY_KINDS].sort());
  for (const kind of ACCOUNTING_POSTED_CLAUSES.keys()) {
    const def = entityKindDef(kind);
    assert.ok(def !== undefined, `${kind} is not a registered entity kind`);
    // The clause parses against the real table: preparing the probe throws on a ghost column.
    assert.doesNotThrow(() =>
      ctx.store.db.prepare(
        `SELECT 1 FROM ${def.table} WHERE workspace_id = ? AND ${def.idColumn} = ? AND (${ACCOUNTING_POSTED_CLAUSES.get(kind)})`,
      ),
    );
  }
});
