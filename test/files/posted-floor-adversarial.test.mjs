// D63's adversarial battery: the angles `posted-floor.test.mjs` does not take.
//
// The sales-document side of `ACCOUNTING_POSTED_CLAUSES` (the F1 family below caught the shipped
// `issue_date IS NOT NULL` clause locking issued quotes and orders for ten years, and now pins the
// `posted_entry_id` rule), the reversal path, a draft whose date moves before it posts, the version
// chain, the staged-delete race across the posting moment, and a tenant-crossing derive call.
//
// Every claim is asserted on ROWS where a row is what the claim is about.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  uploadFile,
  linkFile,
  newFileVersion,
  deleteFile,
  setFileRetention,
  deriveStatutoryOnPost,
  isPostedAccountingRecord,
  retentionFloor,
  effectiveRetentionUntil,
} from '../../dist/core/files/index.js';
import { postEntry, saveDraft } from '../../dist/core/ledger/index.js';
import { createContact, createDocument, transitionDocument, issueInvoice } from '../../dist/core/sales/index.js';
import { listAccounts } from '../../dist/core/accounts/index.js';
import { recordPayment, reversePayment, PAYMENT_INTENTS } from '../../dist/core/payments/index.js';
import { setup, newWorkspace, b64, atTime, asActor } from './support.mjs';

const upload = (ctx, seed = 'beleg') =>
  uploadFile(ctx, { title: seed, filename: `${seed}.pdf`, contentBase64: b64(`inhalt ${seed}`) }).file;

function lines(ctx, amount = 10000) {
  const accounts = listAccounts(ctx).accounts;
  const bank = accounts.find((a) => a.number === '1020') ?? accounts[0];
  const revenue = accounts.find((a) => a.number === '3000') ?? accounts[1];
  return [
    { account: bank.id, debit: amount },
    { account: revenue.id, credit: amount },
  ];
}

/** The stored row, so a claim about a column is a claim about the database. */
function row(fixture, fileId) {
  return fixture.store.db
    .prepare('SELECT * FROM stored_file WHERE workspace_id = ? AND id = ?')
    .get(fixture.workspaceId, fileId);
}

// --- F1: an issued QUOTE is not posted evidence -------------------------------------------------
//
// A10 stamps `issue_date` on the `draft -> issued` edge of EVERY document type, and the poster
// registry's own `posts` flag says quote and order post nothing (`NO_OP_POSTER`,
// src/core/sales/document.ts). An Offerte creates no journal entry and no receivable, so it must
// never derive the permanent OR 958f floor D63 reserved for posted evidence: `O-2026-0001` is a
// numbering series, not a Buchung (OR 957a Abs. 3). The clause that failed here once was
// `issue_date IS NOT NULL`; the one that holds is `posted_entry_id IS NOT NULL`.

test('D63 adversarial F1: an issued QUOTE derives NO floor, because it posts nothing', () => {
  const fixture = setup();
  const { ctx } = fixture;
  const contact = createContact(ctx, { partyRole: 'customer', name: 'Kundin AG', idempotencyKey: Math.random().toString(36) });
  const contactId = contact.contact.id;
  const quote = createDocument(ctx, {
    type: 'quote',
    contactId,
    lines: [{ description: 'Beratung', quantityMilli: 1000, unitPriceMinor: 10000 }],
    idempotencyKey: 'q1',
  });
  assert.equal(quote.ok, true, JSON.stringify(quote));
  const quoteId = quote.document.id;

  const beleg = upload(ctx, 'offerten-anhang');
  const linked = linkFile(ctx, { fileId: beleg.id, entityKind: 'document', entityId: quoteId, idempotencyKey: 'l1' });
  assert.equal(linked.ok, true, JSON.stringify(linked));

  // While the quote is a draft, D63 holds: nothing derived.
  assert.equal(row(fixture, beleg.id).retention_statutory_until, null);
  assert.equal(isPostedAccountingRecord(ctx, 'document', quoteId), false);

  // Issue the quote. NOTHING is posted: a quote's poster is the no-op.
  const issued = transitionDocument(ctx, { documentId: quoteId, to: 'issued', idempotencyKey: 'q1-issue' });
  assert.equal(issued.ok, true, JSON.stringify(issued));
  assert.equal(issued.document.postedEntryId ?? null, null, 'a quote must post no entry');
  const entries = fixture.store.db
    .prepare('SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ?')
    .get(fixture.workspaceId).n;
  assert.equal(entries, 0, 'issuing a quote wrote a journal entry, so this test proves nothing');

  const after = row(fixture, beleg.id);
  assert.equal(isPostedAccountingRecord(ctx, 'document', quoteId), false, 'an issued quote is not posted evidence');

  // THE POINT. An unposted quote derives nothing.
  assert.equal(
    after.retention_statutory_until,
    null,
    'an issued QUOTE (posts:false, zero journal entries) derived the OR 958f floor D63 reserved for posted evidence',
  );
});

test('D63 adversarial F1b: a declined-and-cancelled quote attachment stays fully releasable', () => {
  const fixture = setup();
  const { ctx } = fixture;
  const contactId = createContact(ctx, { partyRole: 'customer', name: 'Kundin AG', idempotencyKey: Math.random().toString(36) }).contact.id;
  const quoteId = createDocument(ctx, {
    type: 'quote',
    contactId,
    lines: [{ description: 'Beratung', quantityMilli: 1000, unitPriceMinor: 10000 }],
    idempotencyKey: 'q2',
  }).document.id;
  const beleg = upload(ctx, 'lebenslauf');
  linkFile(ctx, { fileId: beleg.id, entityKind: 'document', entityId: quoteId, idempotencyKey: 'l2' });
  transitionDocument(ctx, { documentId: quoteId, to: 'issued', idempotencyKey: 'q2-issue' });
  // The customer says no. A quote that was issued can be cancelled, but the row (and its issue_date)
  // survives: only a DRAFT is deleted outright.
  transitionDocument(ctx, { documentId: quoteId, to: 'cancelled', idempotencyKey: 'q2-cancel' });
  const stillThere = fixture.store.db
    .prepare('SELECT status, issue_date FROM document WHERE workspace_id = ? AND id = ?')
    .get(fixture.workspaceId, quoteId);
  assert.equal(stillThere.status, 'cancelled');
  assert.notEqual(stillThere.issue_date, null, 'the cancelled quote keeps its issue_date, which is the point');

  // A SHORT manual retention is legal (no statutory floor stands), and once it runs out the file
  // really goes: the erase happens the day after the manual date, because a manual retention binds
  // while it runs (A9) and that is the operator's own choice, not the statute's.
  const lowered = setFileRetention(ctx, { fileId: beleg.id, retentionUntil: '2027-01-01', idempotencyKey: 'r2' });
  const erased = deleteFile(atTime(fixture, '2027-01-02T00:00:00.000Z'), { fileId: beleg.id, idempotencyKey: 'd2' });
  assert.equal(
    lowered.ok === true && erased.ok === true,
    true,
    'a declined-and-cancelled Offerte attachment is locked for ten years with no verb able to release it',
  );
});

// --- A2: a draft whose DATE moves before it posts ----------------------------------------------

test('D63 adversarial A2: the floor is computed from the values AT POSTING, not at link time', () => {
  const fixture = setup();
  const { ctx } = fixture;
  const beleg = upload(ctx, 'wanderdatum');
  const draft = saveDraft(ctx, { date: '2035-01-01', lines: lines(ctx), idempotencyKey: 'a2-draft' });
  assert.equal(draft.ok, true, JSON.stringify(draft));
  linkFile(ctx, { fileId: beleg.id, entityKind: 'journal_entry', entityId: draft.entryId, idempotencyKey: 'a2-l' });
  assert.equal(row(fixture, beleg.id).retention_statutory_until, null, 'a draft link must derive nothing');

  // The operator corrects the date DOWN before posting: 2035 was a typo for 2020.
  const posted = postEntry(ctx, {
    entryId: draft.entryId,
    date: '2020-06-01',
    source: 'manual',
    idempotencyKey: 'a2-post',
    lines: lines(ctx),
  });
  assert.equal(posted.ok, true, JSON.stringify(posted));
  const after = row(fixture, beleg.id);
  assert.equal(after.retention_statutory_until, '2030-12-31', 'the anchor must be the date the entry POSTED with');
  assert.equal(after.retention_until, '2030-12-31');
  assert.equal(after.retention_source, 'statutory_auto');
});

test('D63 adversarial A2b: a draft date moved FORWARD before posting lengthens the floor', () => {
  const fixture = setup();
  const { ctx } = fixture;
  const beleg = upload(ctx, 'vorwaerts');
  const draft = saveDraft(ctx, { date: '2020-01-01', lines: lines(ctx), idempotencyKey: 'a2b-draft' });
  linkFile(ctx, { fileId: beleg.id, entityKind: 'journal_entry', entityId: draft.entryId, idempotencyKey: 'a2b-l' });
  postEntry(ctx, {
    entryId: draft.entryId,
    date: '2035-06-01',
    source: 'manual',
    idempotencyKey: 'a2b-post',
    lines: lines(ctx),
  });
  assert.equal(row(fixture, beleg.id).retention_statutory_until, '2045-12-31');
});

// --- A3: the reversal path ----------------------------------------------------------------------

test('D63 adversarial A3: reversing a posted entry lowers no floor, and the reversal derives on its own', () => {
  const fixture = setup();
  const { ctx } = fixture;
  const original = postEntry(ctx, {
    date: '2026-06-01',
    source: 'manual',
    idempotencyKey: 'a3-post',
    lines: lines(ctx),
  });
  assert.equal(original.ok, true, JSON.stringify(original));
  const beleg = upload(ctx, 'original-beleg');
  linkFile(ctx, { fileId: beleg.id, entityKind: 'journal_entry', entityId: original.entryId, idempotencyKey: 'a3-l' });
  const before = row(fixture, beleg.id);
  assert.equal(before.retention_statutory_until, '2036-12-31');

  const mirrored = lines(ctx).map((l) =>
    l.debit === undefined ? { account: l.account, debit: l.credit } : { account: l.account, credit: l.debit },
  );
  const reversal = postEntry(ctx, {
    date: '2026-06-01',
    source: 'reversal',
    reversesEntryId: original.entryId,
    idempotencyKey: 'a3-rev',
    lines: mirrored,
  });
  assert.equal(reversal.ok, true, JSON.stringify(reversal));

  const after = row(fixture, beleg.id);
  assert.equal(after.retention_statutory_until, '2036-12-31', 'a reversal must not lower the original beleg floor');
  assert.equal(retentionFloor(ctx, after), '2036-12-31');

  // A file filed against the REVERSAL derives from the reversal's own date.
  const stornoBeleg = upload(ctx, 'storno-beleg');
  linkFile(ctx, { fileId: stornoBeleg.id, entityKind: 'journal_entry', entityId: reversal.entryId, idempotencyKey: 'a3-l2' });
  assert.equal(row(fixture, stornoBeleg.id).retention_statutory_until, '2036-12-31');
});

// --- A4: idempotent replay of the posting verb, asserted on ROWS --------------------------------

test('D63 adversarial A4: replaying post_entry does not re-run the hook or touch the file row', () => {
  const fixture = setup();
  const { ctx } = fixture;
  const beleg = upload(ctx, 'replay');
  const draft = saveDraft(ctx, { date: '2026-06-01', lines: lines(ctx), idempotencyKey: 'a4-draft' });
  linkFile(ctx, { fileId: beleg.id, entityKind: 'journal_entry', entityId: draft.entryId, idempotencyKey: 'a4-l' });
  const args = {
    entryId: draft.entryId,
    date: '2026-06-01',
    source: 'manual',
    idempotencyKey: 'a4-post',
    lines: lines(ctx),
  };
  const first = postEntry(ctx, args);
  assert.equal(first.ok, true, JSON.stringify(first));
  const afterFirst = row(fixture, beleg.id);
  const second = postEntry(ctx, args);
  assert.equal(second.ok, true, JSON.stringify(second));
  const afterSecond = row(fixture, beleg.id);
  assert.deepEqual(afterSecond, afterFirst, 'the replay changed a stored_file row');
  const entryCount = fixture.store.db
    .prepare('SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ?')
    .get(fixture.workspaceId).n;
  assert.equal(entryCount, 1);
  // And the hook itself is idempotent when called a third time directly.
  assert.equal(deriveStatutoryOnPost(ctx, 'journal_entry', draft.entryId), 0, 'a re-run must raise nothing');
  assert.deepEqual(row(fixture, beleg.id), afterFirst);
});

// --- A5: the version chain ----------------------------------------------------------------------

test('D63 adversarial A5: posting raises the SUPERSEDED version too, not only the head', () => {
  const fixture = setup();
  const { ctx } = fixture;
  const v1 = upload(ctx, 'v1');
  const draft = saveDraft(ctx, { date: '2026-06-01', lines: lines(ctx), idempotencyKey: 'a5-draft' });
  linkFile(ctx, { fileId: v1.id, entityKind: 'journal_entry', entityId: draft.entryId, idempotencyKey: 'a5-l' });
  const v2 = newFileVersion(ctx, { fileId: v1.id, contentBase64: b64('korrigiert'), idempotencyKey: 'a5-v' });
  assert.equal(v2.ok, true, JSON.stringify(v2));
  const v2Id = v2.file.id;
  postEntry(ctx, {
    entryId: draft.entryId,
    date: '2026-06-01',
    source: 'manual',
    idempotencyKey: 'a5-post',
    lines: lines(ctx),
  });
  assert.equal(row(fixture, v1.id).retention_statutory_until, '2036-12-31', 'the superseded row must be retained too');
  assert.equal(row(fixture, v2Id).retention_statutory_until, '2036-12-31');
});

// --- A6: the file that walks away before the entry posts ----------------------------------------

test('D63 adversarial A6: re-linking away from a draft before it posts derives nothing for that file', () => {
  const fixture = setup();
  const { ctx } = fixture;
  const beleg = upload(ctx, 'weggezogen');
  const contactId = createContact(ctx, { partyRole: 'vendor', name: 'Lieferant AG', idempotencyKey: 'c-a6' }).contact.id;
  const draft = saveDraft(ctx, { date: '2026-06-01', lines: lines(ctx), idempotencyKey: 'a6-draft' });
  linkFile(ctx, { fileId: beleg.id, entityKind: 'journal_entry', entityId: draft.entryId, idempotencyKey: 'a6-l1' });
  linkFile(ctx, { fileId: beleg.id, entityKind: 'contact', entityId: contactId, idempotencyKey: 'a6-l2' });
  postEntry(ctx, {
    entryId: draft.entryId,
    date: '2026-06-01',
    source: 'manual',
    idempotencyKey: 'a6-post',
    lines: lines(ctx),
  });
  const after = row(fixture, beleg.id);
  assert.equal(after.entity_kind, 'contact');
  assert.equal(after.retention_statutory_until, null, 'a file no longer linked to the entry must derive nothing');
  assert.equal(effectiveRetentionUntil(ctx, after), null);
});

// --- A7: the staged delete that races the posting moment ----------------------------------------

test('D63 adversarial A7: a delete staged while the entry was a draft is refused once the entry posts', () => {
  const fixture = setup();
  const { ctx } = fixture;
  const agent = asActor(fixture, 'agent');
  const beleg = upload(ctx, 'gestaffelt');
  const draft = saveDraft(ctx, { date: '2026-06-01', lines: lines(ctx), idempotencyKey: 'a7-draft' });
  linkFile(ctx, { fileId: beleg.id, entityKind: 'journal_entry', entityId: draft.entryId, idempotencyKey: 'a7-l' });

  const staged = deleteFile(agent, { fileId: beleg.id, idempotencyKey: 'a7-del' });
  assert.equal(staged.ok, true, JSON.stringify(staged));
  assert.equal(staged.staged, true);

  postEntry(ctx, {
    entryId: draft.entryId,
    date: '2026-06-01',
    source: 'manual',
    idempotencyKey: 'a7-post',
    lines: lines(ctx),
  });

  const confirmed = deleteFile(agent, { fileId: beleg.id, confirmed: true, idempotencyKey: 'a7-del' });
  assert.equal(confirmed.ok, false, 'confirming a pre-posting staged delete erased a posted Buchungsbeleg');
  assert.equal(confirmed.error, 'retention_locked');
  assert.notEqual(row(fixture, beleg.id), undefined);
});

test('D63 adversarial A7b: the stale-staged re-check is tenant-scoped and stays deterministic', () => {
  const fixture = setup();
  const { ctx } = fixture;
  const agent = asActor(fixture, 'agent');
  const beleg = upload(ctx, 'freischwebend');
  const staged = deleteFile(agent, { fileId: beleg.id, idempotencyKey: 'a7b' });
  assert.equal(staged.staged, true);
  // A legitimate retry while the row is still there replays the promise, unchanged.
  assert.deepEqual(deleteFile(agent, { fileId: beleg.id, idempotencyKey: 'a7b' }), staged);
  // A human erases it under a different key.
  const erased = deleteFile(ctx, { fileId: beleg.id, idempotencyKey: 'a7b-human' });
  assert.equal(erased.ok, true, JSON.stringify(erased));
  // The stale promise now answers honestly, and keeps answering the same thing.
  const first = deleteFile(agent, { fileId: beleg.id, idempotencyKey: 'a7b' });
  const second = deleteFile(agent, { fileId: beleg.id, idempotencyKey: 'a7b' });
  assert.equal(first.ok, false);
  assert.equal(first.error, 'not_found');
  assert.deepEqual(second, first);
});

// --- A8: §H-TENANT on the derive query ----------------------------------------------------------

test('D63 adversarial A8: the posting hook cannot raise a neighbour tenant row that names the same entity id', () => {
  const fixture = setup();
  const { ctx, deps } = fixture;
  const other = newWorkspace(deps, 'Nachbar GmbH');
  const draft = saveDraft(ctx, { date: '2026-06-01', lines: lines(ctx), idempotencyKey: 'a8-draft' });

  // A file in the NEIGHBOUR workspace whose link columns name our entry id: no verb can produce this
  // (linkFile proves existence in the caller's tenant), so it is forced, which is the point: it
  // isolates the derive query's own tenant predicate.
  const foreign = upload(other, 'fremd');
  deps.store.db
    .prepare('UPDATE stored_file SET entity_kind = ?, entity_id = ? WHERE id = ?')
    .run('journal_entry', draft.entryId, foreign.id);

  postEntry(ctx, {
    entryId: draft.entryId,
    date: '2026-06-01',
    source: 'manual',
    idempotencyKey: 'a8-post',
    lines: lines(ctx),
  });

  const foreignRow = deps.store.db.prepare('SELECT * FROM stored_file WHERE id = ?').get(foreign.id);
  assert.equal(foreignRow.retention_statutory_until, null, 'the hook crossed a tenant boundary');
  // And postedness itself is not probeable across tenants.
  assert.equal(isPostedAccountingRecord(other, 'journal_entry', draft.entryId), false);
  assert.equal(deriveStatutoryOnPost(other, 'journal_entry', draft.entryId), 0);
});

// --- A9: the accepted window, and the moment it closes ------------------------------------------

test('D63 adversarial A9: the draft window is really open, and really shuts at the posting moment', () => {
  const fixture = setup();
  const { ctx } = fixture;
  const doomed = upload(ctx, 'im-fenster');
  const survivor = upload(ctx, 'nach-dem-fenster');
  const draft = saveDraft(ctx, { date: '2026-06-01', lines: lines(ctx), idempotencyKey: 'a9-draft' });
  linkFile(ctx, { fileId: doomed.id, entityKind: 'journal_entry', entityId: draft.entryId, idempotencyKey: 'a9-l1' });
  linkFile(ctx, { fileId: survivor.id, entityKind: 'journal_entry', entityId: draft.entryId, idempotencyKey: 'a9-l2' });

  // BY DESIGN (D63): inside the window the file may be erased, and a manual retention still binds.
  const manual = setFileRetention(ctx, { fileId: survivor.id, retentionUntil: '2028-01-01', idempotencyKey: 'a9-r' });
  assert.equal(manual.ok, true, JSON.stringify(manual));
  const refusedByManual = deleteFile(ctx, { fileId: survivor.id, idempotencyKey: 'a9-d0' });
  assert.equal(refusedByManual.ok, false);
  assert.equal(refusedByManual.error, 'retention_locked');

  const erased = deleteFile(ctx, { fileId: doomed.id, idempotencyKey: 'a9-d1' });
  assert.equal(erased.ok, true, 'the accepted D63 window must really be open');

  postEntry(ctx, {
    entryId: draft.entryId,
    date: '2026-06-01',
    source: 'manual',
    idempotencyKey: 'a9-post',
    lines: lines(ctx),
  });

  // The window shuts. Even a decade later, on the last statutory day, the file cannot go.
  const lastDay = atTime(fixture, '2036-12-31T09:00:00.000Z');
  const late = deleteFile(lastDay, { fileId: survivor.id, idempotencyKey: 'a9-d2' });
  assert.equal(late.ok, false);
  assert.equal(late.error, 'retention_locked');
  const dayAfter = atTime(fixture, '2037-01-01T09:00:00.000Z');
  assert.equal(deleteFile(dayAfter, { fileId: survivor.id, idempotencyKey: 'a9-d3' }).ok, true);
});

// --- F1c: the same rule on the ORDER type -------------------------------------------------------

test('D63 adversarial F1c: an issued ORDER (Auftrag) posts nothing and derives nothing either', () => {
  const fixture = setup();
  const { ctx } = fixture;
  const contactId = createContact(ctx, { partyRole: 'customer', name: 'Bestellerin AG', idempotencyKey: 'c-f1c' })
    .contact.id;
  const orderId = createDocument(ctx, {
    type: 'order',
    contactId,
    lines: [{ description: 'Lieferung', quantityMilli: 1000, unitPriceMinor: 5000 }],
    idempotencyKey: 'o1',
  }).document.id;
  const beleg = upload(ctx, 'auftrags-anhang');
  linkFile(ctx, { fileId: beleg.id, entityKind: 'document', entityId: orderId, idempotencyKey: 'l3' });
  const issued = transitionDocument(ctx, { documentId: orderId, to: 'issued', idempotencyKey: 'o1-issue' });
  assert.equal(issued.ok, true, JSON.stringify(issued));
  assert.equal(
    fixture.store.db.prepare('SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ?').get(fixture.workspaceId).n,
    0,
  );
  assert.equal(row(fixture, beleg.id).retention_statutory_until, null, 'an issued ORDER derived the OR 958f floor');
});

// --- A10: a reversed payment ---------------------------------------------------------------------

test('D63 adversarial A10: a reversed payment keeps its floor (it was evidence) and lowers nothing', () => {
  const fixture = setup();
  const { ctx } = fixture;
  const accounts = listAccounts(ctx).accounts;
  const bank = accounts.find((a) => a.number === '1020');
  const contactId = createContact(ctx, { partyRole: 'customer', name: 'Zahlerin AG', idempotencyKey: 'c-a10' })
    .contact.id;
  const paid = recordPayment(ctx, {
    intent: PAYMENT_INTENTS.record,
    direction: 'incoming',
    date: '2026-06-01',
    amountMinor: 10000,
    bankAccountId: bank.id,
    counterpartyKind: 'customer',
    counterpartyId: contactId,
    idempotencyKey: 'a10-pay',
  });
  assert.equal(paid.ok, true, JSON.stringify(paid));
  const paymentId = paid.paymentId;
  const beleg = upload(ctx, 'zahlungsbeleg');
  linkFile(ctx, { fileId: beleg.id, entityKind: 'payment', entityId: paymentId, idempotencyKey: 'a10-l' });
  assert.equal(row(fixture, beleg.id).retention_statutory_until, '2036-12-31', 'a payment link derives at once');

  const reversed = reversePayment(ctx, {
    intent: PAYMENT_INTENTS.reverse,
    paymentId,
    date: '2026-06-02',
    idempotencyKey: 'a10-rev',
  });
  assert.equal(reversed.ok, true, JSON.stringify(reversed));
  const after = row(fixture, beleg.id);
  assert.equal(after.retention_statutory_until, '2036-12-31', 'a reversal must not release a payment beleg');
  assert.equal(isPostedAccountingRecord(ctx, 'payment', paymentId), true);
  assert.equal(retentionFloor(ctx, after), '2036-12-31');
});

// --- F1d: the CONTROL case. An issued invoice IS a Buchungsbeleg, and must keep deriving. --------
//
// This is the row the recommended predicate must not break: an `invoice` really does post, so its
// `posted_entry_id` is stamped in the same transaction, and the floor is right.

test('D63 adversarial F1d (control): an issued INVOICE posts an entry and derives, as it must', () => {
  const fixture = setup();
  const { ctx } = fixture;
  const contactId = createContact(ctx, { partyRole: 'customer', name: 'Rechnungskundin AG', idempotencyKey: 'c-f1d' })
    .contact.id;
  const invoiceId = createDocument(ctx, {
    type: 'invoice',
    contactId,
    lines: [{ description: 'Arbeit', quantityMilli: 1000, unitPriceMinor: 10000 }],
    idempotencyKey: 'i-f1d',
  }).document.id;
  const beleg = upload(ctx, 'rechnungs-pdf');
  linkFile(ctx, { fileId: beleg.id, entityKind: 'document', entityId: invoiceId, idempotencyKey: 'l-f1d' });
  assert.equal(row(fixture, beleg.id).retention_statutory_until, null, 'a draft invoice derives nothing (D63)');

  const issued = issueInvoice(ctx, { invoiceId, idempotencyKey: 'i-f1d-issue' });
  assert.equal(issued.ok, true, JSON.stringify(issued));
  const doc = fixture.store.db
    .prepare('SELECT issue_date, posted_entry_id FROM document WHERE workspace_id = ? AND id = ?')
    .get(fixture.workspaceId, invoiceId);
  assert.notEqual(doc.posted_entry_id, null, 'an issued invoice must carry its posted entry id');
  assert.equal(row(fixture, beleg.id).retention_statutory_until, '2036-12-31');
});
