// E00, the OR 958f retention rail: the golden fixture, the statutory floor, and the fiscal-year
// arithmetic the authored spec got wrong.
//
// OR Art. 958f Abs. 1, verified against the primary source on 30.07.2026: "Die Geschäftsbücher und die
// Buchungsbelege ... sind während zehn Jahren aufzubewahren", counted from the END OF THE FINANCIAL
// YEAR. The spec said "31 Dec of the linked record's fiscal year + 10 years", which is right only for a
// calendar-year book: `workspace.fiscal_year_start` is a real setting, so an April book keeps its
// vouchers to a March date and a rule that assumed December would release them seven months early.
// That is the case this suite exists for, and it is the one no calendar-year test can see.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  uploadFile,
  newFileVersion,
  linkFile,
  searchFiles,
  setFileRetention,
  deleteFile,
  fiscalYearEnd,
  statutoryRetentionUntil,
  accountingRecordDate,
  effectiveRetentionUntil,
  retentionFloor,
  ACCOUNTING_DATE_COLUMNS,
  ACCOUNTING_ENTITY_KINDS,
  isAccountingEntityKind,
  RETENTION_SOURCES,
  OR_958F_YEARS,
} from '../../dist/core/files/index.js';
import { ENTITY_KIND_IDS, entityKindDef } from '../../dist/core/customization/index.js';
import { createContact, createDocument, transitionDocument } from '../../dist/core/sales/index.js';
import { postEntry } from '../../dist/core/ledger/index.js';
import { listAccounts } from '../../dist/core/accounts/index.js';
import { setFiscalConfig } from '../../dist/core/setup/index.js';
import { setup, atTime, b64, counts } from './support.mjs';

const file = (ctx, seed = 'beleg') =>
  uploadFile(ctx, { title: seed, filename: `${seed}.pdf`, contentBase64: b64(`inhalt ${seed}`) }).file;

const invoice = (ctx) => {
  const contact = createContact(ctx, { partyRole: 'customer', name: 'Kunde AG' }).contact;
  return createDocument(ctx, {
    type: 'invoice',
    contactId: contact.id,
    lines: [{ description: 'Beratung', unitPriceMinor: 100000 }],
  }).document;
};

/**
 * An ISSUED invoice, because under D63 a DRAFT is not yet evidence and derives no floor. Issuing
 * stamps `issue_date` from the clock (2026-07-16 in the default fixture), so every expectation that
 * used to derive 2036-12-31 from the file's creation day now derives the same date from the record's
 * own issue date, which is the anchor the statute actually names.
 */
const issuedInvoice = (ctx, seed = 'i') => {
  const doc = invoice(ctx);
  const issued = transitionDocument(ctx, { documentId: doc.id, to: 'issued', idempotencyKey: `${seed}-issue` });
  assert.equal(issued.ok, true, `the fixture could not issue the invoice: ${JSON.stringify(issued)}`);
  return issued.document;
};


// --- The enumerations hold each other honest ---------------------------------------------------

test('every accounting entity kind is a kind the shared registry really knows', () => {
  // The list is E00's JUDGEMENT about G00's registry, not a copy of it, so it can rot into a set of
  // ghosts the day a kind is renamed. This is what stops that silently.
  for (const kind of ACCOUNTING_ENTITY_KINDS) {
    assert.ok(ENTITY_KIND_IDS.includes(kind), `${kind} is not a registered entity kind`);
  }
  assert.deepEqual([...ACCOUNTING_ENTITY_KINDS], ['document', 'payment', 'journal_entry']);
});

test('master data is deliberately NOT an accounting kind', () => {
  // Locking a CV attached to a contact for ten years would defeat the revDSG erasure duty that no
  // statute asked for here, so the omission is the decision.
  for (const kind of ['contact', 'item', 'bank_account', 'account', 'cost_center', 'automation_rule']) {
    assert.equal(isAccountingEntityKind(kind), false, `${kind} must not derive a statutory lock`);
  }
});

test('the retention source enumeration is exactly the two provenances the drawer renders', () => {
  assert.deepEqual([...RETENTION_SOURCES], ['manual', 'statutory_auto']);
  assert.equal(OR_958F_YEARS, 10);
});

// --- The fiscal-year arithmetic ----------------------------------------------------------------

test('a calendar-year book ends on 31 December', () => {
  assert.equal(fiscalYearEnd('2026-01-01', '01-01'), '2026-12-31');
  assert.equal(fiscalYearEnd('2026-06-15', '01-01'), '2026-12-31');
  assert.equal(fiscalYearEnd('2026-12-31', '01-01'), '2026-12-31');
});

test('an April book ends on 31 March, and February belongs to the PRIOR fiscal year', () => {
  // The case the authored spec would have got wrong in the direction that matters: a February 2026
  // voucher belongs to fiscal 2025 (Apr 2025 to Mar 2026), so it is kept to 2036-03-31 and not to
  // 2035-12-31 or 2036-12-31.
  assert.equal(fiscalYearEnd('2026-02-15', '04-01'), '2026-03-31');
  assert.equal(fiscalYearEnd('2026-04-01', '04-01'), '2027-03-31');
  assert.equal(fiscalYearEnd('2026-06-15', '04-01'), '2027-03-31');
});

test('a leap year is handled by date arithmetic and not by a month table', () => {
  // A March-start book's fiscal year ends the last day of February, which is the 29th in a leap year.
  assert.equal(fiscalYearEnd('2027-06-01', '03-01'), '2028-02-29');
  assert.equal(fiscalYearEnd('2026-06-01', '03-01'), '2027-02-28');
});

test('the ten-year floor is added to the fiscal year END, and 29 February is clamped not rolled', () => {
  const calendar = setup();
  assert.equal(statutoryRetentionUntil(calendar.ctx, '2026-06-15'), '2036-12-31');

  const april = setup({ fiscalYearStart: '04-01' });
  assert.equal(statutoryRetentionUntil(april.ctx, '2026-06-15'), '2037-03-31');
  assert.equal(statutoryRetentionUntil(april.ctx, '2026-02-15'), '2036-03-31');

  // 2028-02-29 + 10 years is not a date. Rolling it into 01.03 would move a statutory deadline into a
  // different month, so it is clamped to the 28th instead.
  const march = setup({ fiscalYearStart: '03-01' });
  assert.equal(statutoryRetentionUntil(march.ctx, '2027-06-01'), '2038-02-28');
});

// --- The golden fixture (US-E00.5, §8) ---------------------------------------------------------

test('OR 958f golden fixture: an invoice-linked file derives 2036-12-31 and refuses deletion until then', () => {
  const at = '2026-07-16T00:00:00.000Z';
  const { ctx } = setup({ at });
  const beleg = file(ctx);
  const doc = issuedInvoice(ctx);

  const linked = linkFile(ctx, {
    fileId: beleg.id,
    entityKind: 'document',
    entityId: doc.id,
    idempotencyKey: 'l-1',
  });
  assert.equal(linked.ok, true);
  assert.equal(linked.retentionDerived, true);
  assert.equal(linked.file.retentionUntil, '2036-12-31');
  assert.equal(linked.file.retentionSource, 'statutory_auto');
  assert.equal(linked.file.retentionLocked, true);
});

test('the lock refuses on the last day and releases on the next', () => {
  // ONE seeding in 2026, then only the READER's clock moves. Re-seeding at each date would move the
  // derivation too and the lock would recede ahead of every attempt to reach the guard.
  const seed = () => {
    const fixture = setup();
    const beleg = file(fixture.ctx);
    const doc = issuedInvoice(fixture.ctx);
    const linked = linkFile(fixture.ctx, {
      fileId: beleg.id,
      entityKind: 'document',
      entityId: doc.id,
      idempotencyKey: 'l',
    });
    assert.equal(linked.file.retentionUntil, '2036-12-31');
    return { fixture, fileId: beleg.id };
  };

  const before = seed();
  const refusedBefore = deleteFile(atTime(before.fixture, '2036-12-30T00:00:00.000Z'), {
    fileId: before.fileId,
    idempotencyKey: 'd',
  });
  assert.equal(refusedBefore.error, 'retention_locked');

  // ON the retention date it is still refused: "aufzubewahren bis" includes the day it names.
  const onTheDay = seed();
  const refusedOn = deleteFile(atTime(onTheDay.fixture, '2036-12-31T00:00:00.000Z'), {
    fileId: onTheDay.fileId,
    idempotencyKey: 'd',
  });
  assert.equal(refusedOn.error, 'retention_locked');
  assert.equal(refusedOn.retentionUntil, '2036-12-31');

  // The day after, the duty flips from keeping to deleting (revDSG), and the bytes really go.
  const after = seed();
  const allowed = deleteFile(atTime(after.fixture, '2037-01-01T00:00:00.000Z'), {
    fileId: after.fileId,
    idempotencyKey: 'd',
  });
  assert.equal(allowed.ok, true);
  assert.equal(allowed.deleted, true);
  assert.equal(counts(after.fixture.store, after.fixture.workspaceId).blobs, 0, 'the bytes are really gone');
  assert.equal(counts(after.fixture.store, after.fixture.workspaceId).files, 0);
});

test('a SUPERSEDED version is retained too: v2 existing is not a reason v1 may go', () => {
  const { ctx } = setup();
  const v1 = file(ctx);
  const doc = issuedInvoice(ctx);
  linkFile(ctx, { fileId: v1.id, entityKind: 'document', entityId: doc.id, idempotencyKey: 'l' });
  const v2 = newFileVersion(ctx, { fileId: v1.id, contentBase64: b64('fassung zwei'), idempotencyKey: 'v' }).file;

  // The successor inherited the lock, so it is locked for its own reason.
  assert.equal(v2.retentionUntil, '2036-12-31');
  assert.equal(v2.retentionSource, 'statutory_auto');

  // And v1 is refused on the RETENTION ground, not merely on the chain ground: OR 958f retains the
  // trail rather than only the current copy, and reporting `not_head_version` here would suggest that
  // deleting the head first would release it.
  const refused = deleteFile(ctx, { fileId: v1.id, idempotencyKey: 'd' });
  assert.equal(refused.error, 'retention_locked');
  assert.equal(refused.version, 1);
});

// --- The floor (US-E00.5 error case) -----------------------------------------------------------

test('a retention date below the statutory floor is refused, and the refusal names the floor', () => {
  const { ctx } = setup();
  const beleg = file(ctx);
  const doc = issuedInvoice(ctx);
  linkFile(ctx, { fileId: beleg.id, entityKind: 'document', entityId: doc.id, idempotencyKey: 'l' });

  const res = setFileRetention(ctx, { fileId: beleg.id, retentionUntil: '2030-12-31', idempotencyKey: 'r' });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'retention_below_statutory');
  assert.equal(res.statutoryFloor, '2036-12-31');
  assert.equal(res.requested, '2030-12-31');
});

test('extending is always allowed, and a hand-set date is recorded as manual provenance', () => {
  const { ctx, audit } = setup();
  const beleg = file(ctx);
  const doc = invoice(ctx);
  linkFile(ctx, { fileId: beleg.id, entityKind: 'document', entityId: doc.id, idempotencyKey: 'l' });

  const res = setFileRetention(ctx, { fileId: beleg.id, retentionUntil: '2046-12-31', idempotencyKey: 'r' });
  assert.equal(res.ok, true);
  assert.equal(res.file.retentionUntil, '2046-12-31');
  // An operator who deliberately keeps a record for twenty years should not see it labelled
  // "gesetzlich": the provenance is a claim about WHO decided, not about how long.
  assert.equal(res.file.retentionSource, 'manual');

  // Moving a statutory deadline is stamped into the A03 chain.
  assert.deepEqual(
    audit.events.map((e) => [e.entityKind, e.action]),
    [['stored_file', 'file_retention']],
  );
  assert.equal(audit.events[0].actor, 'studio');
});

test('a manual extension cannot later be walked back below the statutory floor', () => {
  const { ctx } = setup();
  const beleg = file(ctx);
  const doc = issuedInvoice(ctx);
  linkFile(ctx, { fileId: beleg.id, entityKind: 'document', entityId: doc.id, idempotencyKey: 'l' });
  setFileRetention(ctx, { fileId: beleg.id, retentionUntil: '2046-12-31', idempotencyKey: 'r1' });
  // Shortening from 2046 back to 2040 is legal (still above the floor) but going under it is not, and
  // the floor is recomputed from the LINK rather than read off the row a manual edit overwrote.
  assert.equal(setFileRetention(ctx, { fileId: beleg.id, retentionUntil: '2040-01-01', idempotencyKey: 'r2' }).ok, true);
  assert.equal(
    setFileRetention(ctx, { fileId: beleg.id, retentionUntil: '2029-01-01', idempotencyKey: 'r3' }).error,
    'retention_below_statutory',
  );
});

test('an UNLINKED file has no floor at all, because no statute applies to it', () => {
  const { ctx } = setup();
  const beleg = file(ctx, 'Bürofoto');
  const res = setFileRetention(ctx, { fileId: beleg.id, retentionUntil: '2026-12-31', idempotencyKey: 'r' });
  assert.equal(res.ok, true);
  assert.equal(res.file.retentionUntil, '2026-12-31');
  assert.equal(res.file.retentionSource, 'manual');
});

test('a malformed retention date is refused, never coerced', () => {
  const { ctx } = setup();
  const beleg = file(ctx);
  for (const value of ['31.12.2036', '2036-13-01', '2036-12-32', '2036-12', 'morgen', 20361231]) {
    const res = setFileRetention(ctx, { fileId: beleg.id, retentionUntil: value, idempotencyKey: `r-${value}` });
    assert.equal(res.ok, false, `${value} must be refused`);
    assert.equal(res.error, 'invalid_input');
  }
});

test('a re-link never silently overwrites a retention that is already set', () => {
  const { ctx } = setup();
  const beleg = file(ctx);
  setFileRetention(ctx, { fileId: beleg.id, retentionUntil: '2050-12-31', idempotencyKey: 'r' });
  const doc = invoice(ctx);
  const linked = linkFile(ctx, { fileId: beleg.id, entityKind: 'document', entityId: doc.id, idempotencyKey: 'l' });
  assert.equal(linked.retentionDerived, false);
  assert.equal(linked.file.retentionUntil, '2050-12-31');
  assert.equal(linked.file.retentionSource, 'manual');
});

// --- F1: the escape a LEGITIMATE extension used to open ----------------------------------------
//
// Every step below returned `ok` on the shipped branch, and the fifth erased a Buchungsbeleg. The
// mechanism was that `retention_until` was the ONLY record of the statutory date, so an extension (a
// write the capability pair is designed to permit) flipped provenance to `manual` and destroyed the
// derivation, and a later re-link to a non-accounting kind then left no floor on either guard.
//
// Step 2 is what makes this a real finding rather than a permissions question: omit it and step 4 is
// correctly refused. The role doing this holds exactly what E00's own §0 says it should.

test('F1: a manual extension followed by a re-link cannot walk the statutory date back', () => {
  const fixture = setup();
  const { ctx } = fixture;
  const beleg = file(ctx);
  const doc = issuedInvoice(ctx);
  const kunde = createContact(ctx, { partyRole: 'customer', name: 'Muster GmbH' }).contact;

  const linked = linkFile(ctx, { fileId: beleg.id, entityKind: 'document', entityId: doc.id, idempotencyKey: 'l1' });
  assert.equal(linked.file.retentionUntil, '2036-12-31');
  assert.equal(linked.file.retentionStatutoryUntil, '2036-12-31', 'the derivation is recorded durably');

  // A legitimate extension. It flips provenance, and that flip used to be the whole defect.
  const extended = setFileRetention(ctx, { fileId: beleg.id, retentionUntil: '2046-12-31', idempotencyKey: 'r1' });
  assert.equal(extended.ok, true);
  assert.equal(extended.file.retentionSource, 'manual');
  assert.equal(
    extended.file.retentionStatutoryUntil,
    '2036-12-31',
    'files_set_retention must not touch the statutory column: that is what erased the floor',
  );

  // A re-link to a NON-accounting kind. The file stops deriving a statutory date and keeps the one it
  // already earned: OR 958f does not stop applying because somebody re-filed a voucher on a contact.
  const moved = linkFile(ctx, { fileId: beleg.id, entityKind: 'contact', entityId: kunde.id, idempotencyKey: 'l2' });
  assert.equal(moved.ok, true);
  assert.equal(moved.file.entityKind, 'contact');
  assert.equal(moved.file.retentionStatutoryUntil, '2036-12-31');

  const walkedBack = setFileRetention(ctx, { fileId: beleg.id, retentionUntil: '2020-01-01', idempotencyKey: 'r2' });
  assert.equal(walkedBack.ok, false, 'the escape: this answered ok and set 2020-01-01');
  assert.equal(walkedBack.error, 'retention_below_statutory');
  assert.equal(walkedBack.statutoryFloor, '2036-12-31');

  const removal = deleteFile(ctx, { fileId: beleg.id, idempotencyKey: 'd1' });
  assert.equal(removal.ok, false, 'the escape: this answered {ok:true, deleted:true} and the blob went');
  assert.equal(removal.error, 'retention_locked');
  // On ROWS, because the finding was that the bytes were really gone.
  const after = counts(fixture.store, fixture.workspaceId);
  assert.equal(after.files, 1);
  assert.equal(after.blobs, 1);
});

test('F1: deleteFile compares against the recomputed floor, not against the stored column alone', () => {
  // The narrower half of the same fix, and the one a `retention_until` of null used to walk straight
  // past. A file that carries a statutory memory and NO stored retention is still retained.
  const fixture = setup();
  const { ctx } = fixture;
  const beleg = file(ctx);
  const doc = issuedInvoice(ctx);
  linkFile(ctx, { fileId: beleg.id, entityKind: 'document', entityId: doc.id, idempotencyKey: 'l' });

  // Reach around every verb and blank the column a manual overwrite used to be able to reach. This is
  // the hand-edited-database case, and it is exactly the shape the escape produced.
  ctx.store.db
    .prepare('UPDATE stored_file SET retention_until = NULL, retention_source = NULL WHERE id = ?')
    .run(beleg.id);

  const refused = deleteFile(ctx, { fileId: beleg.id, idempotencyKey: 'd' });
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'retention_locked');
  assert.equal(refused.retentionUntil, '2036-12-31', 'the floor answers even with no stored retention');
  assert.equal(refused.storedRetentionUntil, null);
});

// --- F2: the anchor is the RECORD'S own date ---------------------------------------------------

test('F2: a future-dated journal entry retains from its OWN fiscal year, not from the clock', () => {
  // A02 has no future-date guard, so this entry posts while the clock reads 2026. The shipped
  // derivation read the clock and produced 2036-12-31 where the entry's own financial year demands
  // 2038-12-31: under-retained by two years, and invisible to every backdated test, because a
  // backdated filing errs the other way.
  const { ctx } = setup();
  const accounts = listAccounts(ctx).accounts;
  const bank = accounts.find((a) => a.number === '1020') ?? accounts[0];
  const revenue = accounts.find((a) => a.number === '3000') ?? accounts[1];
  const entry = postEntry(ctx, {
    date: '2028-06-01',
    source: 'manual',
    idempotencyKey: 'e-1',
    lines: [
      { account: bank.id, debit: 10000 },
      { account: revenue.id, credit: 10000 },
    ],
  });
  assert.equal(entry.ok, true, `post_entry refused, so this test proves nothing: ${JSON.stringify(entry)}`);

  const beleg = file(ctx, 'zukunft');
  const linked = linkFile(ctx, {
    fileId: beleg.id,
    entityKind: 'journal_entry',
    entityId: entry.entryId,
    idempotencyKey: 'l',
  });
  assert.equal(linked.ok, true);
  assert.equal(linked.file.retentionUntil, '2038-12-31');
  assert.equal(linked.file.retentionSource, 'statutory_auto');
});

test('F2: a BACKDATED record retains from its own year too, which is shorter than the clock answer', () => {
  // The other direction, and the reason the old docblock claim ("can only ever be LONGER") had to be
  // deleted rather than repaired: the rule is now the statute's own answer, which errs in neither
  // direction. A 2024 entry filed in 2026 is kept to 2034 and not to 2036.
  const { ctx } = setup();
  const accounts = listAccounts(ctx).accounts;
  const bank = accounts.find((a) => a.number === '1020') ?? accounts[0];
  const revenue = accounts.find((a) => a.number === '3000') ?? accounts[1];
  const entry = postEntry(ctx, {
    date: '2024-05-01',
    source: 'manual',
    idempotencyKey: 'e-2',
    lines: [
      { account: bank.id, debit: 5000 },
      { account: revenue.id, credit: 5000 },
    ],
  });
  assert.equal(entry.ok, true, JSON.stringify(entry));
  const beleg = file(ctx, 'rückwirkend');
  const linked = linkFile(ctx, {
    fileId: beleg.id,
    entityKind: 'journal_entry',
    entityId: entry.entryId,
    idempotencyKey: 'l',
  });
  assert.equal(linked.file.retentionUntil, '2034-12-31');
});

test('F2/D63: a DRAFT document has no date because it is not yet evidence, and derives nothing', () => {
  // A DRAFT document has no `issue_date`, and attaching the PDF before the invoice is issued is the
  // ordinary order of work. This used to derive from the file's creation day; D63 replaced that with
  // the honest answer: a draft is not a Buchungsbeleg, so the link derives NOTHING, and the floor
  // attaches at issue (asserted end to end in `posted-floor.test.mjs`). The `created_at` fallback
  // survives in the derivation for the hand-edited-database case, but no verb can reach it through a
  // draft any more.
  const { ctx } = setup();
  const doc = invoice(ctx);
  assert.equal(accountingRecordDate(ctx, 'document', doc.id), null, 'a draft has no issue_date to read');
  const beleg = file(ctx, 'entwurf');
  const linked = linkFile(ctx, { fileId: beleg.id, entityKind: 'document', entityId: doc.id, idempotencyKey: 'l' });
  assert.equal(linked.retentionDerived, false);
  assert.equal(linked.file.retentionUntil, null);
  assert.equal(linked.file.retentionStatutoryUntil, null);
});

test('the date-column map covers every accounting kind and names a column that really exists', () => {
  // Same discipline as `ACCOUNTING_ENTITY_KINDS`: this is E00's judgement about G00's registry, so it
  // can rot into a set of ghosts. Both halves are checked, because a map that covered the kinds while
  // naming a renamed column would fail silently by returning null and losing the anchor.
  const { ctx } = setup();
  assert.deepEqual([...ACCOUNTING_DATE_COLUMNS.keys()].sort(), [...ACCOUNTING_ENTITY_KINDS].sort());
  for (const [kind, column] of ACCOUNTING_DATE_COLUMNS) {
    const def = entityKindDef(kind);
    assert.ok(def !== undefined, `${kind} is not a registered entity kind`);
    const columns = ctx.store.db
      .prepare(`SELECT name FROM pragma_table_info(?)`)
      .all(def.table)
      .map((r) => r.name);
    assert.ok(columns.includes(column), `${def.table} has no column '${column}'`);
  }
});

// --- F3: a fiscal-year change must not desynchronise the two guards ----------------------------

test('F3: after a fiscalYearStart change both guards answer with the SAME recomputed floor', () => {
  // Measured on the shipped branch: `files_set_retention` refused anything below 2036-12-31 (it
  // recomputed) while `files_delete` on 2036-04-01 succeeded (it read the stale column). Two guards,
  // one statutory date, opposite answers, nine months early.
  //
  // SINCE THE POSTED-EVIDENCE RULE (D63 as repaired by the critic), this scenario is UNREACHABLE
  // through the verbs: a floor now requires posted evidence, posted evidence requires a posted
  // entry, and `set_fiscal_config` refuses with `needs_empty_ledger` the moment one exists. That
  // unreachability is asserted below, and then the config is moved by direct SQL anyway, because
  // the two guards must agree even over a hand-edited or restored database: their consistency is a
  // property of the ONE shared expression, not of how the configuration got there.
  const fixture = setup({ at: '2026-02-15T00:00:00.000Z', fiscalYearStart: '04-01' });
  const { ctx } = fixture;
  const beleg = file(ctx, 'april');
  const doc = issuedInvoice(ctx);
  const linked = linkFile(ctx, { fileId: beleg.id, entityKind: 'document', entityId: doc.id, idempotencyKey: 'l' });
  assert.equal(linked.file.retentionUntil, '2036-03-31', 'an April book keeps a February voucher to March');

  // The verb path is closed: issuing the invoice posted an entry, so the config is locked.
  assert.equal(setFiscalConfig(ctx, { fiscalYearStart: '01-01' }).error, 'needs_empty_ledger');
  ctx.store.db.prepare('UPDATE workspace SET fiscal_year_start = ? WHERE id = ?').run('01-01', fixture.workspaceId);

  const refused = setFileRetention(ctx, { fileId: beleg.id, retentionUntil: '2036-04-01', idempotencyKey: 'r' });
  assert.equal(refused.ok, false);
  assert.equal(refused.statutoryFloor, '2036-12-31');

  const removal = deleteFile(atTime(fixture, '2036-04-01T00:00:00.000Z'), { fileId: beleg.id, idempotencyKey: 'd' });
  assert.equal(removal.ok, false, 'the escape: this answered {deleted:true} nine months early');
  assert.equal(removal.error, 'retention_locked');
  assert.equal(removal.retentionUntil, '2036-12-31');
  assert.equal(removal.statutoryFloor, '2036-12-31', 'both guards read one expression now');

  // WHAT IS AND IS NOT CLAIMED HERE, stated as an assertion rather than left to be assumed. Moving the
  // book BACK to April returns the statute's own answer for an April book, so the floor falls to the
  // March date again: that is not the rail leaking, it is the rule following the configuration. What
  // may never fall is the RECORDED date, which is the durable half, and this is the assertion that
  // pins it.
  ctx.store.db.prepare('UPDATE workspace SET fiscal_year_start = ? WHERE id = ?').run('04-01', fixture.workspaceId);
  const row = ctx.store.db.prepare('SELECT * FROM stored_file WHERE id = ?').get(beleg.id);
  assert.equal(row.retention_statutory_until, '2036-03-31');
  assert.equal(retentionFloor(ctx, row), '2036-03-31', 'the April answer, and never below the recorded one');
  assert.equal(
    deleteFile(atTime(fixture, '2036-03-31T00:00:00.000Z'), { fileId: beleg.id, idempotencyKey: 'd2' }).error,
    'retention_locked',
    'the recorded date is inclusive and holds on its own last day',
  );
});

test('the two guards are ONE expression, asserted directly on the pair', () => {
  // The unit-level statement of the same claim, so a future refactor that reintroduces two comparisons
  // fails here rather than only through a nine-month-wide behavioural gap.
  const { ctx } = setup();
  const beleg = file(ctx);
  const doc = issuedInvoice(ctx);
  linkFile(ctx, { fileId: beleg.id, entityKind: 'document', entityId: doc.id, idempotencyKey: 'l' });
  setFileRetention(ctx, { fileId: beleg.id, retentionUntil: '2046-12-31', idempotencyKey: 'r' });
  const row = ctx.store.db.prepare('SELECT * FROM stored_file WHERE id = ?').get(beleg.id);

  assert.equal(retentionFloor(ctx, row), '2036-12-31', 'the floor is the statute');
  assert.equal(effectiveRetentionUntil(ctx, row), '2046-12-31', 'the lock is the later of the two');
  // The invariant the read model relies on to derive its badge without a query.
  assert.ok(row.retention_until >= row.retention_statutory_until, 'retention_until >= the statutory column');
});

test('the statutory column carries forward to a new version, provenance and all', () => {
  const { ctx } = setup();
  const v1 = file(ctx);
  const doc = issuedInvoice(ctx);
  linkFile(ctx, { fileId: v1.id, entityKind: 'document', entityId: doc.id, idempotencyKey: 'l' });
  const v2 = newFileVersion(ctx, { fileId: v1.id, contentBase64: b64('fassung zwei'), idempotencyKey: 'v' }).file;
  assert.equal(v2.retentionStatutoryUntil, '2036-12-31');

  // And the escape is closed on the SUCCESSOR too: extending v2 by hand then re-linking it away must
  // not release it either, which is the case a v2 that inherited only the date would have opened.
  const kunde = createContact(ctx, { partyRole: 'customer', name: 'Muster GmbH' }).contact;
  setFileRetention(ctx, { fileId: v2.id, retentionUntil: '2046-12-31', idempotencyKey: 'r' });
  linkFile(ctx, { fileId: v2.id, entityKind: 'contact', entityId: kunde.id, idempotencyKey: 'l2' });
  assert.equal(
    setFileRetention(ctx, { fileId: v2.id, retentionUntil: '2027-01-01', idempotencyKey: 'r2' }).error,
    'retention_below_statutory',
  );
});

test('an ISSUED document sets the floor from its issue date, and the draft before it set none (D63)', () => {
  // The end-to-end shape of D63 on the document kind: the draft link derives nothing, and the ISSUE
  // is the moment the floor attaches, anchored on the record's own `issue_date` and not on the link
  // day. A draft linked in 2026 and issued in 2027 is held to the ISSUED year.
  const fixture = setup();
  const { ctx } = fixture;
  const beleg = file(ctx, 'wirdgestellt');
  const doc = invoice(ctx);
  linkFile(ctx, { fileId: beleg.id, entityKind: 'document', entityId: doc.id, idempotencyKey: 'l' });
  assert.equal(searchFiles(ctx, {}).files[0].retentionStatutoryUntil, null, 'a draft link derives nothing');

  // `transitionDocument` stamps `issue_date` from the clock at issue, and the D63 posting-time hook
  // writes the floor onto the linked FILE in the same transaction.
  const issued = transitionDocument(atTime(fixture, '2027-03-01T00:00:00.000Z'), {
    documentId: doc.id,
    to: 'issued',
    idempotencyKey: 'i',
  });
  assert.equal(issued.ok, true, `the fixture could not issue the invoice: ${JSON.stringify(issued)}`);
  assert.equal(accountingRecordDate(ctx, 'document', doc.id), '2027-03-01');
  const row = ctx.store.db.prepare('SELECT * FROM stored_file WHERE id = ?').get(beleg.id);
  assert.equal(row.retention_statutory_until, '2037-12-31', 'the hook recorded the floor durably');
  assert.equal(retentionFloor(ctx, row), '2037-12-31', 'the record issued into 2027, so the floor is 2037');
  assert.equal(
    setFileRetention(ctx, { fileId: beleg.id, retentionUntil: '2037-01-01', idempotencyKey: 'r' }).error,
    'retention_below_statutory',
  );
});

test('replaying a retention key writes ONE audit row, not two', () => {
  const { ctx, audit } = setup();
  const beleg = file(ctx);
  setFileRetention(ctx, { fileId: beleg.id, retentionUntil: '2040-12-31', idempotencyKey: 'r-1' });
  setFileRetention(ctx, { fileId: beleg.id, retentionUntil: '2040-12-31', idempotencyKey: 'r-1' });
  // The audit chain has no uniqueness constraint of any kind, so a verb that re-ran instead of
  // replaying would leave two events behind and nothing in the database would complain.
  assert.equal(audit.events.length, 1);
});
