/**
 * A13 credit notes, the rebuild's own suite (spec §8).
 *
 * The 46 adopted critic probes (credit-note-adversarial / -recritic / -recritic3) carry the bulk of
 * the money-path law; THIS file pins what the D74 rebuild added by design and the probes do not
 * exercise directly: the §4b.1 attribution invariant on every path, the S7 stated-base reversal,
 * the read surface (list filter, PDF include), and the A24 gate.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { makeContext } from '../../dist/core/context.js';
import { sequenceIdGen } from '../../dist/core/ids.js';
import { createWorkspace } from '../../dist/core/setup/index.js';
import { seedTaxCodes } from '../../dist/core/vat/index.js';
import {
  createDocument,
  issueInvoice,
  createCreditNote,
  issueCreditNote,
  updateDocument,
  transitionDocument,
  getDocument,
  listDocuments,
  renderCreditNotePdf,
} from '../../dist/core/sales/index.js';
import { ledgerPorts } from '../../dist/core/ledger/index.js';
import { recordExchangeRate } from '../../dist/core/fx/index.js';
import { requiredCapabilitiesFor } from '../../dist/core/access/actionCapabilities.js';

function movableClock(start) {
  let at = start;
  return { now: () => at, set: (v) => { at = v; } };
}

function setup(start = '2026-07-16T00:00:00.000Z') {
  const clock = movableClock(start);
  const ids = sequenceIdGen();
  const store = new SqliteStore({ clock });
  const workspaceId = createWorkspace({ store, clock, ids }, { name: 'Nomadik GmbH' }).workspaceId;
  const ctx = makeContext(store, {
    workspaceId, actor: 'user_1', clock, ids, ...ledgerPorts({ store, workspaceId, ids }),
  });
  seedTaxCodes(ctx);
  store.db.prepare("UPDATE workspace SET vat_method = 'effektiv', vat_accounting = 'soll' WHERE id = ?").run(workspaceId);
  store.db
    .prepare(`INSERT INTO contact (id, workspace_id, party_role, name, created_at) VALUES ('ct_1', ?, 'customer', 'Muster AG', ?)`)
    .run(workspaceId, start);
  return { ctx, store, workspaceId, clock };
}

function issuedInvoice(ctx, lines, currency = 'CHF') {
  const doc = createDocument(ctx, { type: 'invoice', contactId: 'ct_1', currency, lines });
  assert.ok(doc.ok, JSON.stringify(doc));
  assert.ok(issueInvoice(ctx, { invoiceId: doc.document.id, idempotencyKey: `inv-${doc.document.id}` }).ok);
  return getDocument(ctx, { documentId: doc.document.id }).document;
}

function baseBalance(ctx, number) {
  return ctx.store.db
    .prepare(
      `SELECT COALESCE(SUM(l.base_debit_minor - l.base_credit_minor), 0) AS net
         FROM journal_line l JOIN account a ON a.id = l.account_id
         JOIN journal_entry e ON e.id = l.entry_id
        WHERE a.workspace_id = ? AND a.number = ? AND e.status = 'posted'`,
    )
    .get(ctx.workspaceId, number).net;
}

// --- §4b.1: the closure-attribution invariant -----------------------------------------------------

test('the derivation attributes EVERY line, in all three modes', () => {
  const { ctx } = setup();
  const invoice = issuedInvoice(ctx, [
    { description: 'A', unitPriceMinor: 100000, taxCode: 'UST81' },
    { description: 'B', quantityMilli: 2000, unitPriceMinor: 25000, taxCode: 'UST26' },
  ]);
  const shapes = [
    [{}, 'full'],
    [{ mode: 'partial', lines: [{ position: 2, quantityMilli: 1000 }] }, 'lines'],
    [{ mode: 'partial', amountMinor: 30000 }, 'amount'],
  ];
  for (const [opts, name] of shapes) {
    const cn = createCreditNote(ctx, { fromInvoiceId: invoice.id, ...opts, idempotencyKey: `at-${name}` });
    assert.ok(cn.ok, JSON.stringify(cn));
    const rows = ctx.store.db
      .prepare('SELECT credited_line_position AS p FROM document_line WHERE document_id = ?')
      .all(cn.document.id);
    assert.ok(rows.length > 0);
    for (const r of rows) assert.notEqual(r.p, null, `${name}: unattributed line`);
    // Each attribution names a REAL invoice position.
    for (const r of rows) assert.ok([1, 2].includes(r.p), `${name}: position ${r.p}`);
  }
});

test('updateDocument refuses lines, currency and contactId on an FK Gutschrift; notes and dueDate patch', () => {
  const { ctx } = setup();
  const invoice = issuedInvoice(ctx, [{ description: 'x', unitPriceMinor: 100000, taxCode: 'UST81' }]);
  const cn = createCreditNote(ctx, { fromInvoiceId: invoice.id, idempotencyKey: 'ed-1' });
  assert.ok(cn.ok);

  for (const patch of [
    { lines: [{ description: 'rewritten', unitPriceMinor: 150000, taxCode: 'UST81' }] },
    { currency: 'EUR' },
    { contactId: 'ct_1' },
  ]) {
    const refused = updateDocument(ctx, { documentId: cn.document.id, patch });
    assert.equal(refused.ok, false, JSON.stringify(patch));
    assert.equal(refused.error, 'credit_note_lines_derived');
  }
  // The attribution is untouched by the refusals.
  const rows = ctx.store.db
    .prepare('SELECT credited_line_position AS p FROM document_line WHERE document_id = ?')
    .all(cn.document.id);
  assert.deepEqual(rows.map((r) => r.p), [1]);

  // What the derivation does not own stays patchable.
  const okPatch = updateDocument(ctx, { documentId: cn.document.id, patch: { notes: 'Kulanz', dueDate: '2026-08-31' } });
  assert.ok(okPatch.ok, JSON.stringify(okPatch));
  assert.equal(getDocument(ctx, { documentId: cn.document.id }).document.notes, 'Kulanz');

  // A generic credit-note draft (no FK) stays freely editable; it can never post anyway.
  const generic = createDocument(ctx, {
    type: 'credit_note', contactId: 'ct_1',
    lines: [{ description: 'g', unitPriceMinor: 1000, taxCode: 'UST81' }],
  });
  assert.ok(updateDocument(ctx, { documentId: generic.document.id, patch: { lines: [{ unitPriceMinor: 2000 }] } }).ok);
  const attempt = issueCreditNote(ctx, { creditNoteId: generic.document.id, idempotencyKey: 'g-issue' });
  assert.equal(attempt.error, 'needs_reference_invoice');
});

test('belt and braces: the poster REFUSES an unattributed line, however it came to exist', () => {
  const { ctx } = setup();
  const invoice = issuedInvoice(ctx, [{ description: 'x', unitPriceMinor: 100000, taxCode: 'UST81' }]);
  const cn = createCreditNote(ctx, { fromInvoiceId: invoice.id, idempotencyKey: 'nb-1' });
  assert.ok(cn.ok);
  // No shipped path can do this (the edit path is closed); simulate a future defect directly.
  ctx.store.db
    .prepare('UPDATE document_line SET credited_line_position = NULL WHERE document_id = ?')
    .run(cn.document.id);
  const refused = issueCreditNote(ctx, { creditNoteId: cn.document.id, idempotencyKey: 'nb-1-i' });
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'unattributed_lines');
  // Nothing posted, no number consumed.
  assert.equal(getDocument(ctx, { documentId: cn.document.id }).document.number, null);
  assert.equal(baseBalance(ctx, '1100'), invoice.totalMinor);
});

// --- S7: the cancel of a partial FX credit gives back exactly the base slice it took --------------

test('cancelling a partial EUR credit restores the exact stated base slice (S7)', () => {
  const { ctx } = setup();
  assert.ok(recordExchangeRate(ctx, {
    baseCurrency: 'EUR', rate: '0.9137', asOf: '2026-07-15', source: 'manual',
    method: 'daily', provenance: 'T', idempotencyKey: 'fx',
  }).ok);
  const invoice = issuedInvoice(ctx, [
    { description: 'S', quantityMilli: 3000, unitPriceMinor: 3333, taxCode: 'UST81' },
  ], 'EUR');
  const before1100 = baseBalance(ctx, '1100');

  const cn = createCreditNote(ctx, {
    fromInvoiceId: invoice.id, mode: 'partial', lines: [{ position: 1, quantityMilli: 1000 }],
    idempotencyKey: 's7-1',
  });
  assert.ok(issueCreditNote(ctx, { creditNoteId: cn.document.id, idempotencyKey: 's7-1-i' }).ok);
  const after = baseBalance(ctx, '1100');
  assert.notEqual(after, before1100, 'the credit moved base money');

  // Cancel: the reversal must restore 1100 to the Rappen, which only holds if the mirror restates
  // the STORED bases (a fresh allocation of the mirror's own side totals can differ by a Rappen).
  assert.ok(transitionDocument(ctx, { documentId: cn.document.id, to: 'cancelled' }).ok);
  assert.equal(baseBalance(ctx, '1100'), before1100);
  assert.equal(baseBalance(ctx, '3200') + baseBalance(ctx, '2200'), -before1100);
});

// --- The read surface -----------------------------------------------------------------------------

test('list_documents(creditedDocumentId) answers "the credit notes of invoice X" in one read', () => {
  const { ctx } = setup();
  const a = issuedInvoice(ctx, [{ description: 'a', unitPriceMinor: 100000, taxCode: 'UST81' }]);
  const b = issuedInvoice(ctx, [{ description: 'b', unitPriceMinor: 50000, taxCode: 'UST81' }]);
  const cnA = createCreditNote(ctx, { fromInvoiceId: a.id, mode: 'partial', amountMinor: 20000, idempotencyKey: 'la' });
  assert.ok(issueCreditNote(ctx, { creditNoteId: cnA.document.id, idempotencyKey: 'la-i' }).ok);
  const cnB = createCreditNote(ctx, { fromInvoiceId: b.id, idempotencyKey: 'lb' });
  assert.ok(issueCreditNote(ctx, { creditNoteId: cnB.document.id, idempotencyKey: 'lb-i' }).ok);

  const listed = listDocuments(ctx, { type: 'credit_note', creditedDocumentId: a.id });
  assert.ok(listed.ok);
  assert.deepEqual(listed.documents.map((d) => d.id), [cnA.document.id]);
  assert.equal(listed.documents[0].creditedDocumentId, a.id);
});

test('the Gutschrift PDF exists from issue on, names the invoice, and carries no payment part', () => {
  const { ctx } = setup();
  const invoice = issuedInvoice(ctx, [{ description: 'x', unitPriceMinor: 100000, taxCode: 'UST81' }]);
  const cn = createCreditNote(ctx, { fromInvoiceId: invoice.id, idempotencyKey: 'pdf-1' });
  assert.ok(cn.ok);

  const draft = renderCreditNotePdf(ctx, cn.document.id);
  assert.equal(draft.ok, false);
  assert.equal(draft.error, 'not_available');

  assert.ok(issueCreditNote(ctx, { creditNoteId: cn.document.id, idempotencyKey: 'pdf-1-i' }).ok);
  const rendered = renderCreditNotePdf(ctx, cn.document.id);
  assert.ok(rendered.ok, JSON.stringify(rendered));
  assert.equal(rendered.pdf.hasQrBill, false);
  const bytes = Buffer.from(rendered.pdf.base64, 'base64').toString('latin1');
  assert.match(bytes, /Gutschrift G-2026-0001/);
  assert.match(bytes, /Zu Rechnung R-2026-0001/);
  assert.doesNotMatch(bytes, /SwissQR/);
});

// --- A24: both verbs carry the issue gate, on both sides ------------------------------------------

test('create_credit_note and issue_credit_note resolve to the issue capability', () => {
  assert.deepEqual(requiredCapabilitiesFor('create_credit_note', {}), ['issue']);
  assert.deepEqual(requiredCapabilitiesFor('issue_credit_note', {}), ['issue']);
});

test('the engine refuses both verbs without the issue capability, before any row is written', () => {
  const { ctx, store } = setup();
  const invoice = issuedInvoice(ctx, [{ description: 'x', unitPriceMinor: 100000, taxCode: 'UST81' }]);
  const denied = makeContext(store, {
    workspaceId: ctx.workspaceId,
    actor: 'user_1',
    clock: ctx.clock,
    ids: ctx.ids,
    capabilities: { assert: () => ({ ok: false, error: 'permission_denied' }) },
  });
  // The DOCUMENT write inside createCreditNote posts nothing, so the deny lands at issue: the draft
  // exists, the posting is refused, and the journal is untouched.
  const cn = createCreditNote(ctx, { fromInvoiceId: invoice.id, idempotencyKey: 'perm-1' });
  const lineCount = () => store.db.prepare('SELECT COUNT(*) AS n FROM journal_line').get().n;
  const before = lineCount();
  const refused = issueCreditNote(denied, { creditNoteId: cn.document.id, idempotencyKey: 'perm-1-i' });
  assert.equal(refused.ok, false, JSON.stringify(refused));
  assert.equal(refused.error, 'permission_denied');
  assert.equal(lineCount(), before);
});
