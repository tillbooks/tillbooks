/**
 * N02 US-N02.4 (Wave 0): EVERY accounting Beleg is locked for the OR 958f period, whatever kind of
 * posted record it is filed against.
 *
 * The defect: `ACCOUNTING_ENTITY_KINDS` listed `document`, `payment`, `journal_entry` and `bank_txn`,
 * while `docs/CONTRACT.md` promised that the Beleg `capture_commit` links to a vendor bill "derives
 * OR 958f retention". A receipt filed against a POSTED Kreditorenrechnung or an approved
 * Spesenabrechnung derived no floor at all and `files_delete` erased it the same day.
 *
 * Driven end to end through the registry (the verbs a person and an agent call), one case per kind in
 * `ACCOUNTING_ENTITY_KINDS`, so a kind added later without a case here fails the totality check. For
 * each: a Beleg linked to the POSTED record carries the floor (ten years from the end of the record's
 * own financial year) and `files_delete` refuses `retention_locked`. For the two new kinds the D63 half
 * is driven too: a link to the still-DRAFT bill or the unapproved claim derives nothing, and the floor
 * attaches at the posting moment. Fixtures are the conformance scenarios: synthetic by construction.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { getAction } from '../../dist/api/registry.js';
import {
  ACCOUNTING_ENTITY_KINDS,
  ACCOUNTING_DATE_COLUMNS,
  ACCOUNTING_POSTED_CLAUSES,
} from '../../dist/core/files/index.js';
import { entityKindDef } from '../../dist/core/customization/index.js';
import { requiredCapabilitiesFor } from '../../dist/core/access/index.js';
import { SCENARIOS, fixture } from '../api/conformance-contract.mjs';

const run = (fx, name, input) => getAction(name).run(fx.deps, { workspaceId: fx.workspaceId, ...input });

function upload(fx, seed) {
  const res = run(fx, 'files_upload', {
    title: `Beleg ${seed}`,
    filename: `${seed}.pdf`,
    mime: 'application/pdf',
    contentBase64: Buffer.from(`%PDF-1.4 synthetischer Beleg ${seed}`).toString('base64'),
    idempotencyKey: `${seed}-upload`,
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  return res.file.id;
}

function link(fx, fileId, entityKind, entityId, seed) {
  const res = run(fx, 'files_link', { fileId, entityKind, entityId, idempotencyKey: `${seed}-link` });
  assert.equal(res.ok, true, `${entityKind}: ${JSON.stringify(res)}`);
}

function fileRow(fx, fileId) {
  return fx.deps.store.db
    .prepare('SELECT retention_until, retention_statutory_until FROM stored_file WHERE workspace_id = ? AND id = ?')
    .get(fx.workspaceId, fileId);
}

/** The record's own date (the `ACCOUNTING_DATE_COLUMNS` anchor), as a day. */
function recordDay(fx, kind, id) {
  const def = entityKindDef(kind);
  const row = fx.deps.store.db
    .prepare(`SELECT ${ACCOUNTING_DATE_COLUMNS.get(kind)} AS d FROM ${def.table} WHERE workspace_id = ? AND ${def.idColumn} = ?`)
    .get(fx.workspaceId, id);
  assert.equal(typeof row?.d, 'string', `${kind} ${id}: no anchor date`);
  return row.d.slice(0, 10);
}

/** The fixture book is a calendar-year book: the floor is 31.12 of the record's year plus ten. */
function expectedFloor(fx, day) {
  const start = fx.deps.store.db.prepare('SELECT fiscal_year_start AS s FROM workspace WHERE id = ?').get(fx.workspaceId).s;
  assert.equal(start, '01-01', 'the arithmetic below assumes a calendar-year book');
  return `${Number(day.slice(0, 4)) + 10}-12-31`;
}

function assertLocked(fx, kind, id, fileId, seed) {
  const floor = expectedFloor(fx, recordDay(fx, kind, id));
  const row = fileRow(fx, fileId);
  assert.equal(row.retention_statutory_until, floor, `${kind}: the OR 958f floor`);
  assert.ok(row.retention_until >= floor, `${kind}: the retention date is raised to the floor`);
  const del = run(fx, 'files_delete', { fileId, idempotencyKey: `${seed}-delete` });
  assert.equal(del.ok, false, `${kind}: a Beleg of posted evidence must not be erasable before its floor`);
  assert.equal(del.error, 'retention_locked', `${kind}: ${JSON.stringify(del)}`);
  const still = fx.deps.store.db.prepare('SELECT COUNT(*) AS n FROM stored_file WHERE id = ?').get(fileId).n;
  assert.equal(still, 1, `${kind}: the refused delete removed the file`);
}

/** One POSTED record per accounting kind, created through the verbs. Returns its id. */
const POSTED = {
  document: (fx) => {
    const input = SCENARIOS.issue_invoice(fx);
    assert.equal(getAction('issue_invoice').run(fx.deps, input).ok, true);
    return input.invoiceId;
  },
  payment: (fx) => {
    const res = getAction('record_payment').run(fx.deps, SCENARIOS.record_payment(fx));
    assert.equal(res.ok, true, JSON.stringify(res));
    return res.paymentId;
  },
  journal_entry: (fx) => {
    const res = getAction('post_entry').run(fx.deps, SCENARIOS.post_entry(fx));
    assert.equal(res.ok, true, JSON.stringify(res));
    return res.entryId;
  },
  bank_txn: (fx) => {
    const input = SCENARIOS.book_bank_line(fx);
    const res = getAction('book_bank_line').run(fx.deps, input);
    assert.equal(res.ok, true, JSON.stringify(res));
    return input.bankTxnId;
  },
  vendor_bill: (fx) => {
    const input = SCENARIOS.post_vendor_bill(fx);
    const res = getAction('post_vendor_bill').run(fx.deps, input);
    assert.equal(res.ok, true, JSON.stringify(res));
    return input.vendorBillId;
  },
  expense_claim: (fx) => {
    const input = SCENARIOS.expense_claim_approve(fx);
    const res = getAction('expense_claim_approve').run(fx.deps, input);
    assert.equal(res.ok, true, JSON.stringify(res));
    return input.claimId;
  },
};

test('every accounting kind has an end-to-end case here, and the two Wave 0 kinds are in the list', () => {
  assert.deepEqual(Object.keys(POSTED).sort(), [...ACCOUNTING_ENTITY_KINDS].sort());
  for (const kind of ['vendor_bill', 'expense_claim']) {
    assert.ok(ACCOUNTING_ENTITY_KINDS.includes(kind), `${kind} must be an accounting kind`);
    assert.ok(ACCOUNTING_DATE_COLUMNS.has(kind), `${kind} needs its date column`);
    assert.ok(ACCOUNTING_POSTED_CLAUSES.has(kind), `${kind} needs its posted predicate`);
  }
  assert.equal(ACCOUNTING_POSTED_CLAUSES.get('vendor_bill'), 'entry_id IS NOT NULL');
  assert.equal(ACCOUNTING_POSTED_CLAUSES.get('expense_claim'), 'posted_entry_id IS NOT NULL');
  assert.equal(ACCOUNTING_DATE_COLUMNS.get('vendor_bill'), 'bill_date');
  assert.equal(ACCOUNTING_DATE_COLUMNS.get('expense_claim'), 'approved_at');
});

test('every kind docs/CONTRACT.md names as retained accounting evidence is an accounting kind', () => {
  // The contract text is the promise; each phrase is quoted from it, so a reworded contract fails here
  // and is re-read rather than silently drifting from the list.
  const contract = readFileSync(new URL('../../docs/CONTRACT.md', import.meta.url), 'utf8');
  const promised = {
    document: 'a document whose issue posted an entry',
    payment: 'a payment, a posted journal entry',
    journal_entry: 'a posted journal entry',
    vendor_bill: "target.kind='vendor_bill' delegates to A17 create_vendor_bill (+ attach_receipt + the E00 entity link that derives OR 958f retention)",
  };
  for (const [kind, phrase] of Object.entries(promised)) {
    assert.ok(contract.includes(phrase), `CONTRACT.md no longer says: ${phrase}`);
    assert.ok(ACCOUNTING_ENTITY_KINDS.includes(kind), `CONTRACT.md promises a floor for ${kind}, the list does not derive one`);
  }
});

for (const kind of Object.keys(POSTED)) {
  test(`${kind}: a Beleg linked to the posted record carries the OR 958f floor and cannot be deleted before it`, () => {
    const fx = fixture();
    try {
      const id = POSTED[kind](fx);
      const fileId = upload(fx, `n02-${kind}`);
      link(fx, fileId, kind, id, `n02-${kind}`);
      assertLocked(fx, kind, id, fileId, `n02-${kind}`);
    } finally {
      fx.deps.store.close();
    }
  });
}

test('vendor_bill (D63): a Beleg on the DRAFT bill derives nothing; the post attaches the floor', () => {
  const fx = fixture();
  try {
    const input = SCENARIOS.post_vendor_bill(fx);
    const fileId = upload(fx, 'n02-draft-bill');
    link(fx, fileId, 'vendor_bill', input.vendorBillId, 'n02-draft-bill');
    assert.equal(fileRow(fx, fileId).retention_statutory_until, null, 'a draft bill is not yet evidence');

    const posted = getAction('post_vendor_bill').run(fx.deps, input);
    assert.equal(posted.ok, true, JSON.stringify(posted));
    assertLocked(fx, 'vendor_bill', input.vendorBillId, fileId, 'n02-draft-bill');
  } finally {
    fx.deps.store.close();
  }
});

test('vendor_bill: a voided bill stays evidence, its Beleg stays locked', () => {
  const fx = fixture();
  try {
    const id = POSTED.vendor_bill(fx);
    const fileId = upload(fx, 'n02-void-bill');
    link(fx, fileId, 'vendor_bill', id, 'n02-void-bill');
    const voided = run(fx, 'void_vendor_bill', { vendorBillId: id, reason: 'Doppelt erfasst', idempotencyKey: 'n02-void' });
    assert.equal(voided.ok, true, JSON.stringify(voided));
    assertLocked(fx, 'vendor_bill', id, fileId, 'n02-void-bill');
  } finally {
    fx.deps.store.close();
  }
});

test('expense_claim (D63): a Beleg on the unapproved claim derives nothing; the approval attaches the floor', () => {
  const fx = fixture();
  try {
    const input = SCENARIOS.expense_claim_approve(fx);
    const fileId = upload(fx, 'n02-draft-claim');
    link(fx, fileId, 'expense_claim', input.claimId, 'n02-draft-claim');
    assert.equal(fileRow(fx, fileId).retention_statutory_until, null, 'a submitted claim is not yet evidence');

    const approved = getAction('expense_claim_approve').run(fx.deps, input);
    assert.equal(approved.ok, true, JSON.stringify(approved));
    assertLocked(fx, 'expense_claim', input.claimId, fileId, 'n02-draft-claim');
  } finally {
    fx.deps.store.close();
  }
});

// --- The receipt POINTERS (N01 critic findings 2 and 3): a Beleg named by a pointer is linked too ------

test('A17 attach_receipt naming a stored file links it to the POSTED bill: floored, and files_delete refuses', () => {
  const fx = fixture();
  try {
    const input = SCENARIOS.attach_receipt(fx); // the bill is posted (record_expense)
    const fileId = upload(fx, 'n02-ar');
    const res = run(fx, 'attach_receipt', { vendorBillId: input.vendorBillId, receiptRef: fileId, idempotencyKey: 'n02-ar' });
    assert.equal(res.ok, true, JSON.stringify(res));
    const link = fx.deps.store.db.prepare('SELECT entity_kind, entity_id FROM stored_file WHERE id = ?').get(fileId);
    assert.deepEqual({ ...link }, { entity_kind: 'vendor_bill', entity_id: input.vendorBillId });
    const del = run(fx, 'files_delete', { fileId, confirmed: true, idempotencyKey: 'n02-ar-del' });
    assert.equal(del.error, 'retention_locked', JSON.stringify(del));
    assertLocked(fx, 'vendor_bill', input.vendorBillId, fileId, 'n02-ar-2');
    assert.equal(fx.deps.store.db.prepare('SELECT receipt_ref FROM vendor_bill WHERE id = ?').get(input.vendorBillId).receipt_ref, fileId, 'the pointer still names a file that exists');
  } finally {
    fx.deps.store.close();
  }
});

test('A17 attach_receipt with a ref that names no stored file stays a plain pointer', () => {
  const fx = fixture();
  try {
    const input = SCENARIOS.attach_receipt(fx);
    const before = fx.deps.store.db.prepare('SELECT COUNT(*) AS n FROM stored_file').get().n;
    const res = run(fx, 'attach_receipt', input);
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(fx.deps.store.db.prepare('SELECT COUNT(*) AS n FROM stored_file').get().n, before);
  } finally {
    fx.deps.store.close();
  }
});

test('E02 an expense line receipt is linked to its claim: nothing before approval (D63), floored after, files_delete refuses', () => {
  const fx = fixture();
  try {
    const contactId = run(fx, 'create_contact', { partyRole: 'vendor', name: 'Mitarbeiterin Muster', idempotencyKey: 'n02-el-ct' }).contact.id;
    const employee = run(fx, 'hr_employee_upsert', {
      employee: { firstName: 'Alex', lastName: 'Muster', employmentPct: 80, startsOn: '2026-01-01', contactId },
      idempotencyKey: 'n02-el-emp',
    });
    assert.equal(employee.ok, true, JSON.stringify(employee));
    const claim = run(fx, 'expense_claim_create', { employeeId: employee.employeeId, title: 'Reise', idempotencyKey: 'n02-el-c' });
    assert.equal(claim.ok, true, JSON.stringify(claim));
    const fileId = upload(fx, 'n02-el');
    const line = run(fx, 'expense_line_upsert', {
      claimId: claim.claimId,
      line: { expenseDate: '2026-06-15', category: 'travel', amountMinor: 4000, receiptDocumentId: fileId },
      idempotencyKey: 'n02-el-1',
    });
    assert.equal(line.ok, true, JSON.stringify(line));
    const link = fx.deps.store.db.prepare('SELECT entity_kind, entity_id, retention_statutory_until FROM stored_file WHERE id = ?').get(fileId);
    assert.deepEqual({ ...link }, { entity_kind: 'expense_claim', entity_id: claim.claimId, retention_statutory_until: null });

    assert.equal(run(fx, 'expense_claim_submit', { claimId: claim.claimId, idempotencyKey: 'n02-el-s' }).ok, true);
    // The approver is not the claimant (E02's four-eyes rule).
    fx.deps.store.db.prepare("UPDATE expense_claim SET created_by = 'claimant' WHERE id = ?").run(claim.claimId);
    const approved = run(fx, 'expense_claim_approve', { claimId: claim.claimId, confirm: true, idempotencyKey: 'n02-el-a' });
    assert.equal(approved.ok, true, JSON.stringify(approved));
    assertLocked(fx, 'expense_claim', claim.claimId, fileId, 'n02-el');
  } finally {
    fx.deps.store.close();
  }
});

// --- Security review (re-link hijack): a receipt pointer never moves a file off another record ----------

/** A posted journal entry with a Beleg filed against it: the evidence a hijack would strip. */
function postedEntryWithBeleg(fx, seed) {
  const posted = getAction('post_entry').run(fx.deps, SCENARIOS.post_entry(fx));
  assert.equal(posted.ok, true, JSON.stringify(posted));
  const fileId = upload(fx, seed);
  link(fx, fileId, 'journal_entry', posted.entryId, seed);
  return { entryId: posted.entryId, fileId };
}

function linkOf(fx, fileId) {
  return { ...fx.deps.store.db.prepare('SELECT entity_kind, entity_id, retention_statutory_until FROM stored_file WHERE id = ?').get(fileId) };
}

test('attach_receipt refuses a file filed against another record (a posted entry\'s Beleg): nothing moves, nothing written', () => {
  const fx = fixture();
  try {
    const input = SCENARIOS.attach_receipt(fx);
    const { entryId, fileId } = postedEntryWithBeleg(fx, 'hj-ar');
    const before = linkOf(fx, fileId);
    const refRow = () => fx.deps.store.db.prepare('SELECT receipt_ref FROM vendor_bill WHERE id = ?').get(input.vendorBillId).receipt_ref;
    const refBefore = refRow();
    const res = run(fx, 'attach_receipt', { vendorBillId: input.vendorBillId, receiptRef: fileId, idempotencyKey: 'hj-ar' });
    assert.equal(res.ok, false);
    assert.equal(res.error, 'receipt_linked_elsewhere', JSON.stringify(res));
    assert.deepEqual(res.linkedTo, { entityKind: 'journal_entry', entityId: entryId });
    assert.deepEqual(linkOf(fx, fileId), before, 'the Beleg stays on its entry');
    assert.equal(refRow(), refBefore, 'the pointer was not written either');
  } finally {
    fx.deps.store.close();
  }
});

test('attach_receipt refuses a payroll hand-off artefact (filed against its hand-off)', () => {
  const fx = fixture();
  try {
    const input = SCENARIOS.attach_receipt(fx);
    const fileId = upload(fx, 'hj-pay');
    // The artefact as the A34 export leaves it: filed against its hand-off record.
    fx.deps.store.db.prepare("UPDATE stored_file SET entity_kind = 'payroll_handoff', entity_id = 'payho_1' WHERE id = ?").run(fileId);
    const res = run(fx, 'attach_receipt', { vendorBillId: input.vendorBillId, receiptRef: fileId, idempotencyKey: 'hj-pay' });
    assert.equal(res.error, 'receipt_linked_elsewhere', JSON.stringify(res));
    assert.deepEqual(linkOf(fx, fileId).entity_kind, 'payroll_handoff');
  } finally {
    fx.deps.store.close();
  }
});

test('attach_receipt accepts a file already filed against the same bill', () => {
  const fx = fixture();
  try {
    const input = SCENARIOS.attach_receipt(fx);
    const fileId = upload(fx, 'hj-same');
    link(fx, fileId, 'vendor_bill', input.vendorBillId, 'hj-same');
    const res = run(fx, 'attach_receipt', { vendorBillId: input.vendorBillId, receiptRef: fileId, idempotencyKey: 'hj-same' });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(linkOf(fx, fileId).entity_id, input.vendorBillId);
  } finally {
    fx.deps.store.close();
  }
});

test('expense_line_upsert refuses a receipt filed against another record, writing nothing; accepts one already on the claim', () => {
  const fx = fixture();
  try {
    const input = SCENARIOS.expense_line_upsert(fx);
    const { entryId, fileId } = postedEntryWithBeleg(fx, 'hj-el');
    const lines = () => fx.deps.store.db.prepare('SELECT COUNT(*) AS n FROM expense_line').get().n;
    const linesBefore = lines();
    const res = run(fx, 'expense_line_upsert', { ...input, line: { ...input.line, receiptDocumentId: fileId }, idempotencyKey: 'hj-el' });
    assert.equal(res.ok, false);
    assert.equal(res.error, 'receipt_linked_elsewhere', JSON.stringify(res));
    assert.deepEqual(res.linkedTo, { entityKind: 'journal_entry', entityId: entryId });
    assert.equal(lines(), linesBefore);
    assert.equal(linkOf(fx, fileId).entity_id, entryId, 'the Beleg stays on its entry');

    const own = upload(fx, 'hj-el-own');
    link(fx, own, 'expense_claim', input.claimId, 'hj-el-own');
    const ok = run(fx, 'expense_line_upsert', { ...input, line: { ...input.line, receiptDocumentId: own }, idempotencyKey: 'hj-el-own' });
    assert.equal(ok.ok, true, JSON.stringify(ok));
  } finally {
    fx.deps.store.close();
  }
});

test('the receipt pointers require exactly what files_link requires for the same target', () => {
  assert.deepEqual(requiredCapabilitiesFor('attach_receipt', {}), requiredCapabilitiesFor('files_link', { entityKind: 'vendor_bill' }));
  assert.deepEqual(requiredCapabilitiesFor('expense_line_upsert', {}), requiredCapabilitiesFor('files_link', { entityKind: 'expense_claim' }));
});

test('files_delete of a receipt on a DRAFT claim refuses file_in_use by name (not a raw FK error), and deletes nothing', () => {
  const fx = fixture();
  try {
    const input = SCENARIOS.expense_line_upsert(fx); // a draft claim: no floor yet (D63)
    const fileId = upload(fx, 'inuse-el');
    const line = run(fx, 'expense_line_upsert', { ...input, line: { ...input.line, receiptDocumentId: fileId }, idempotencyKey: 'inuse-el' });
    assert.equal(line.ok, true, JSON.stringify(line));
    assert.equal(fileRow(fx, fileId).retention_statutory_until, null, 'the premise: no retention floor stops this delete');
    const del = run(fx, 'files_delete', { fileId, confirmed: true, idempotencyKey: 'inuse-del' });
    assert.equal(del.ok, false);
    assert.equal(del.error, 'file_in_use', JSON.stringify(del));
    assert.deepEqual(del.referencedBy, [{ table: 'expense_line', column: 'receipt_document_id' }]);
    assert.equal(fx.deps.store.db.prepare('SELECT COUNT(*) AS n FROM stored_file WHERE id = ?').get(fileId).n, 1);
    // An unreferenced file in the same workspace still deletes.
    const free = upload(fx, 'inuse-free');
    assert.equal(run(fx, 'files_delete', { fileId: free, confirmed: true, idempotencyKey: 'inuse-free' }).ok, true);
  } finally {
    fx.deps.store.close();
  }
});
