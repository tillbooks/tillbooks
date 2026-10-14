/**
 * The engine facts the Neue Rechnung editor's fixes rely on, from the non-author critic's probes
 * (written at eb7e7f75). The Studio side, flipped to assert each fix, is
 * app/src/surfaces/Documents/critic-new-invoice.probe.test.tsx. Each test names the fix it backs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { makeContext } from '../../dist/core/context.js';
import { fixedClock } from '../../dist/core/clock.js';
import { sequenceIdGen } from '../../dist/core/ids.js';
import { createWorkspace } from '../../dist/core/setup/index.js';
import { seedTaxCodes } from '../../dist/core/vat/index.js';
import { getAction } from '../../dist/api/registry.js';

const AT = '2026-07-16T00:00:00.000Z';

function setup() {
  const clock = fixedClock(AT);
  const ids = sequenceIdGen();
  const store = new SqliteStore({ clock });
  const workspaceId = createWorkspace({ store, clock, ids }, { name: 'Probe GmbH' }).workspaceId;
  const ctx = makeContext(store, { workspaceId, actor: 'user_1', clock, ids });
  seedTaxCodes(ctx);
  store.db.prepare("UPDATE workspace SET vat_method = 'effektiv', vat_accounting = 'soll' WHERE id = ?").run(workspaceId);
  store.db
    .prepare(
      `INSERT INTO contact (id, workspace_id, party_role, name, default_currency, payment_terms_days, created_at)
       VALUES ('ct_1', ?, 'customer', 'Muster AG', 'CHF', 0, ?)`,
    )
    .run(workspaceId, AT);
  const run = (verb, input) => getAction(verb).run(ctx, { workspaceId, ...input });
  return { ctx, store, run };
}

const line = { description: 'Beratung', quantityMilli: 1000, unitPriceMinor: 15000, taxCode: 'UST81', supplyDate: '2026-07-16' };

test('FACT for F1: a create replayed under its key returns the STORED type, and the generic transition posts an invoice, so the editor adopts the stored type', () => {
  const { store, run } = setup();
  const first = run('create_document', { type: 'invoice', contactId: 'ct_1', currency: 'CHF', lines: [line], idempotencyKey: 'K1' });
  assert.ok(first.ok, JSON.stringify(first));
  const retry = run('create_document', { type: 'quote', contactId: 'ct_1', currency: 'CHF', lines: [line], idempotencyKey: 'K1' });
  assert.ok(retry.ok);
  assert.equal(retry.document.id, first.document.id);
  assert.equal(retry.document.type, 'invoice');
  const issued = run('transition_document', { documentId: first.document.id, to: 'issued', idempotencyKey: 'T1' });
  assert.ok(issued.ok, JSON.stringify(issued));
  const row = store.db.prepare('SELECT type, posted_entry_id, total_minor, number FROM document WHERE id = ?').get(first.document.id);
  assert.equal(row.type, 'invoice');
  assert.notEqual(row.posted_entry_id, null, 'the generic transition POSTED the invoice');
  assert.equal(row.total_minor, 16215);
});

test('FACT for F2: vat_preview says 1215 on 15000 UST81, and issue_invoice posts 16215, so no confirm may state 15000', () => {
  const { store, run } = setup();
  const p = run('vat_preview', { amountMinor: 15000, amountIsGross: false, taxCode: 'UST81', supplyDate: '2026-07-16' });
  assert.equal(p.taxMinor, 1215);
  const doc = run('create_document', { type: 'invoice', contactId: 'ct_1', currency: 'CHF', lines: [line] });
  const issued = run('issue_invoice', { invoiceId: doc.document.id, idempotencyKey: 'I1' });
  assert.ok(issued.ok, JSON.stringify(issued));
  const row = store.db.prepare('SELECT total_minor, tax_minor FROM document WHERE id = ?').get(doc.document.id);
  assert.deepEqual({ ...row }, { total_minor: 16215, tax_minor: 1215 });
});

test('FACT for F3: a due date before the issue date is accepted, so the confirm has to say it', () => {
  const { store, run } = setup();
  const doc = run('create_document', { type: 'invoice', contactId: 'ct_1', currency: 'CHF', dueDate: '2026-07-15', lines: [line] });
  const issued = run('issue_invoice', { invoiceId: doc.document.id, idempotencyKey: 'I2' });
  assert.ok(issued.ok, JSON.stringify(issued));
  const row = store.db.prepare('SELECT issue_date, due_date FROM document WHERE id = ?').get(doc.document.id);
  assert.deepEqual({ ...row }, { issue_date: '2026-07-16', due_date: '2026-07-15' });
});

test('FACT for the zero-line reason: a zero-amount position is refused at issue with invalid_line', () => {
  const { run } = setup();
  const doc = run('create_document', { type: 'invoice', contactId: 'ct_1', currency: 'CHF', lines: [line, { ...line, unitPriceMinor: 0 }] });
  assert.ok(doc.ok, JSON.stringify(doc));
  const issued = run('issue_invoice', { invoiceId: doc.document.id, idempotencyKey: 'I3' });
  assert.equal(issued.ok, false);
  assert.equal(issued.error, 'invalid_line', JSON.stringify(issued));
});

test('FACT for R2-1: a derived Gutschrift keeps the pinned 2023 supply date on its line and posts at it (7.7%), not at the document date (8.1%)', () => {
  const { store, run } = setup();
  const inv = run('create_document', { type: 'invoice', contactId: 'ct_1', currency: 'CHF', lines: [{ ...line, unitPriceMinor: 100000, supplyDate: '2023-06-01' }] });
  assert.ok(run('issue_invoice', { invoiceId: inv.document.id, idempotencyKey: 'R2I' }).ok);
  const cn = run('create_credit_note', { fromInvoiceId: inv.document.id, idempotencyKey: 'R2C' });
  assert.ok(cn.ok, JSON.stringify(cn));
  const view = run('get_document', { documentId: cn.document.id });
  assert.equal(view.lines[0].supplyDate, '2023-06-01');
  const atDocumentDate = run('vat_preview', { amountMinor: 100000, amountIsGross: false, taxCode: 'UST81', supplyDate: '2026-07-16' });
  assert.equal(atDocumentDate.taxMinor, 8100);
  assert.ok(run('issue_credit_note', { creditNoteId: cn.document.id, idempotencyKey: 'R2IC' }).ok);
  const row = store.db.prepare('SELECT tax_minor, total_minor FROM document WHERE id = ?').get(cn.document.id);
  assert.deepEqual({ ...row }, { tax_minor: 7700, total_minor: 107700 });
});

// --- The facts the "Datum unless stated" line date model relies on (owner; provenance by structure, D164) ---

test('FACT for the date model: a line WITHOUT a supply date, on a document without one, posts at the issue date (8.1% in 2026), so an untouched Datum is never written', () => {
  const { store, run } = setup();
  const { supplyDate: _drop, ...undated } = line;
  const doc = run('create_document', { type: 'invoice', contactId: 'ct_1', currency: 'CHF', lines: [{ ...undated, unitPriceMinor: 100000 }] });
  assert.ok(doc.ok, JSON.stringify(doc));
  assert.equal(run('get_document', { documentId: doc.document.id }).lines[0].supplyDate, null);
  assert.ok(run('issue_invoice', { invoiceId: doc.document.id, idempotencyKey: 'DM1' }).ok);
  const row = store.db.prepare('SELECT issue_date, tax_minor FROM document WHERE id = ?').get(doc.document.id);
  assert.deepEqual({ ...row }, { issue_date: '2026-07-16', tax_minor: 8100 });
});

test('FACT for the date model: update_document replaces the lines, so "auf Datum setzen" (a line sent without supplyDate) really releases a stored line date', () => {
  const { run } = setup();
  const doc = run('create_document', { type: 'invoice', contactId: 'ct_1', currency: 'CHF', lines: [line] });
  assert.equal(run('get_document', { documentId: doc.document.id }).lines[0].supplyDate, '2026-07-16');
  const { supplyDate: _drop, ...undated } = line;
  assert.ok(run('update_document', { documentId: doc.document.id, patch: { lines: [undated] } }).ok);
  assert.equal(run('get_document', { documentId: doc.document.id }).lines[0].supplyDate, null);
});

test('FACT for the date model: convert_document copies each line supply date (the Studio shows a copied date as stated), and the draft has no issue date', () => {
  const { run } = setup();
  const quote = run('create_document', { type: 'quote', contactId: 'ct_1', currency: 'CHF', lines: [{ ...line, supplyDate: '2023-11-20' }] });
  assert.ok(run('transition_document', { documentId: quote.document.id, to: 'issued', idempotencyKey: 'Q1' }).ok);
  assert.ok(run('transition_document', { documentId: quote.document.id, to: 'sent', idempotencyKey: 'Q2' }).ok);
  assert.ok(run('transition_document', { documentId: quote.document.id, to: 'accepted', idempotencyKey: 'Q3' }).ok);
  const converted = run('convert_document', { documentId: quote.document.id, toType: 'invoice', idempotencyKey: 'C1' });
  assert.ok(converted.ok, JSON.stringify(converted));
  const view = run('get_document', { documentId: converted.document.id });
  assert.equal(view.lines[0].supplyDate, '2023-11-20');
  assert.equal(view.document.issueDate, null);
  assert.equal(view.document.sourceDocumentId, quote.document.id);
  assert.equal(typeof view.document.createdAt, 'string');
});
