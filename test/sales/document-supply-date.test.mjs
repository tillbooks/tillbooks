/**
 * D164 (04.10.2026): the document-level Leistungsdatum and the ONE rule every posting path prices a
 * document line at, `lineSupplyDate` (src/core/sales/supplyDate.ts): the line's own date, else the
 * document's, else the issue date. Provenance is by structure: nothing here infers a date's origin
 * from its value.
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
import { lineSupplyDate } from '../../dist/core/sales/supplyDate.js';

const AT = '2026-07-16T00:00:00.000Z';

function book(store, clock, ids, name) {
  const workspaceId = createWorkspace({ store, clock, ids }, { name }).workspaceId;
  const ctx = makeContext(store, { workspaceId, actor: 'user_1', clock, ids });
  seedTaxCodes(ctx);
  store.db.prepare("UPDATE workspace SET vat_method = 'effektiv', vat_accounting = 'soll' WHERE id = ?").run(workspaceId);
  store.db
    .prepare(
      `INSERT INTO contact (id, workspace_id, party_role, name, default_currency, payment_terms_days, created_at)
       VALUES (?, ?, 'customer', 'Muster AG', 'CHF', 0, ?)`,
    )
    .run(`ct_${name}`, workspaceId, AT);
  const run = (verb, input) => getAction(verb).run(ctx, { workspaceId, ...input });
  return { workspaceId, run, contactId: `ct_${name}` };
}

function setup() {
  const clock = fixedClock(AT);
  const ids = sequenceIdGen();
  const store = new SqliteStore({ clock });
  return { store, ...book(store, clock, ids, 'A'), second: () => book(store, clock, ids, 'B') };
}

const undated = { description: 'Beratung', quantityMilli: 1000, unitPriceMinor: 100000, taxCode: 'UST81' };
const row = (store, id) => ({ ...store.db.prepare('SELECT supply_date, issue_date, tax_minor, total_minor FROM document WHERE id = ?').get(id) });

test('the rule itself: the line date wins, then the document date, then null (the issue date)', () => {
  assert.equal(lineSupplyDate({ supply_date: '2023-06-01' }, { supply_date: '2026-01-02' }), '2023-06-01');
  assert.equal(lineSupplyDate({ supply_date: null }, { supply_date: '2023-12-20' }), '2023-12-20');
  assert.equal(lineSupplyDate({ supply_date: null }, { supply_date: null }), null);
  assert.equal(lineSupplyDate({ supply_date: null }, {}), null);
});

test('create, read, patch and clear the document-level date; a malformed date is refused at write', () => {
  const { run, contactId } = setup();
  const doc = run('create_document', { type: 'invoice', contactId, currency: 'CHF', supplyDate: '2023-12-20', lines: [undated] });
  assert.ok(doc.ok, JSON.stringify(doc));
  assert.equal(doc.document.supplyDate, '2023-12-20');
  assert.equal(run('get_document', { documentId: doc.document.id }).document.supplyDate, '2023-12-20');
  // A line written without a date stays without one: the document date is never copied into it.
  assert.equal(run('get_document', { documentId: doc.document.id }).lines[0].supplyDate, null);
  assert.equal(run('update_document', { documentId: doc.document.id, patch: { supplyDate: '2024-01-15' } }).document.supplyDate, '2024-01-15');
  assert.equal(run('update_document', { documentId: doc.document.id, patch: { supplyDate: null } }).document.supplyDate, null);
  const bad = run('create_document', { type: 'invoice', contactId, currency: 'CHF', supplyDate: '20.12.2023', lines: [undated] });
  assert.equal(bad.ok, false);
  assert.equal(bad.error, 'invalid_date');
  const badPatch = run('update_document', { documentId: doc.document.id, patch: { supplyDate: '2023-13-40' } });
  assert.equal(badPatch.error, 'invalid_date');
  // A document created without one reads null, the honest answer for every pre-D164 row too.
  const plain = run('create_document', { type: 'invoice', contactId, currency: 'CHF', lines: [undated] });
  assert.equal(plain.document.supplyDate, null);
});

test('§H-TENANT: another workspace can neither read nor patch the document-level date', () => {
  const { run, contactId, second } = setup();
  const doc = run('create_document', { type: 'invoice', contactId, currency: 'CHF', supplyDate: '2023-12-20', lines: [undated] });
  const other = second();
  assert.equal(other.run('get_document', { documentId: doc.document.id }).ok, false);
  assert.equal(other.run('update_document', { documentId: doc.document.id, patch: { supplyDate: '2026-01-01' } }).ok, false);
  assert.equal(run('get_document', { documentId: doc.document.id }).document.supplyDate, '2023-12-20');
});

test('posting: an undated line on a document dated 2023 posts at 7.7%, not at the 2026 issue date', () => {
  const { store, run, contactId } = setup();
  const doc = run('create_document', { type: 'invoice', contactId, currency: 'CHF', supplyDate: '2023-12-20', lines: [undated] });
  assert.ok(run('issue_invoice', { invoiceId: doc.document.id, idempotencyKey: 'I1' }).ok);
  assert.deepEqual(row(store, doc.document.id), { supply_date: '2023-12-20', issue_date: '2026-07-16', tax_minor: 7700, total_minor: 107700 });
});

test('posting: a line\'s own date wins over the document date', () => {
  const { store, run, contactId } = setup();
  const doc = run('create_document', {
    type: 'invoice',
    contactId,
    currency: 'CHF',
    supplyDate: '2023-12-20',
    lines: [{ ...undated, supplyDate: '2026-02-01' }, undated],
  });
  assert.ok(run('issue_invoice', { invoiceId: doc.document.id, idempotencyKey: 'I2' }).ok);
  // 8.1% on the line dated 2026, 7.7% on the undated line that follows the document's 2023.
  assert.equal(row(store, doc.document.id).tax_minor, 8100 + 7700);
});

test('posting: with neither date the line posts at the issue date', () => {
  const { store, run, contactId } = setup();
  const doc = run('create_document', { type: 'invoice', contactId, currency: 'CHF', lines: [undated] });
  assert.ok(run('issue_invoice', { invoiceId: doc.document.id, idempotencyKey: 'I3' }).ok);
  assert.equal(row(store, doc.document.id).tax_minor, 8100);
});

test('convert_document carries the document date as well as the line dates', () => {
  const { run, contactId } = setup();
  const quote = run('create_document', {
    type: 'quote',
    contactId,
    currency: 'CHF',
    supplyDate: '2023-12-20',
    lines: [undated, { ...undated, supplyDate: '2023-06-01' }],
  });
  for (const [to, key] of [['issued', 'q1'], ['sent', 'q2'], ['accepted', 'q3']]) {
    assert.ok(run('transition_document', { documentId: quote.document.id, to, idempotencyKey: key }).ok);
  }
  const inv = run('convert_document', { documentId: quote.document.id, toType: 'invoice', idempotencyKey: 'c1' });
  assert.ok(inv.ok, JSON.stringify(inv));
  const view = run('get_document', { documentId: inv.document.id });
  assert.equal(view.document.supplyDate, '2023-12-20');
  assert.deepEqual(view.lines.map((l) => l.supplyDate), [null, '2023-06-01']);
});

test('a derived Gutschrift pins the date each invoice line POSTED at (the document date included), and posts the credit at it', () => {
  const { store, run, contactId } = setup();
  const inv = run('create_document', { type: 'invoice', contactId, currency: 'CHF', supplyDate: '2023-12-20', lines: [undated] });
  assert.ok(run('issue_invoice', { invoiceId: inv.document.id, idempotencyKey: 'I4' }).ok);
  const cn = run('create_credit_note', { fromInvoiceId: inv.document.id, idempotencyKey: 'CN1' });
  assert.ok(cn.ok, JSON.stringify(cn));
  const view = run('get_document', { documentId: cn.document.id });
  assert.equal(view.lines[0].supplyDate, '2023-12-20');
  // The derivation owns the dates: a document-level date cannot be patched onto a derived Gutschrift.
  const patched = run('update_document', { documentId: cn.document.id, patch: { supplyDate: '2026-01-01' } });
  assert.equal(patched.error, 'credit_note_lines_derived');
  assert.ok(run('issue_credit_note', { creditNoteId: cn.document.id, idempotencyKey: 'ICN1' }).ok);
  assert.equal(row(store, cn.document.id).tax_minor, 7700);
});

test('a workspace historic-rate code: refused without a date (needs_supply_date names the position), issued with a document date', () => {
  const { store, run, contactId } = setup();
  assert.ok(run('vat_configure', { method: 'effektiv', timing: 'soll', registered: true, idempotencyKey: 'cfg' }).ok);
  const up = run('vat_code_upsert', { code: 'UST77', kind: 'output', rateBp: 770, formLine: '302', label: 'MWST 7.7% (bis 2023)', idempotencyKey: 'tc77' });
  assert.ok(up.ok, JSON.stringify(up));
  const line77 = { ...undated, taxCode: 'UST77' };
  const without = run('create_document', { type: 'invoice', contactId, currency: 'CHF', lines: [line77] });
  const refused = run('issue_invoice', { invoiceId: without.document.id, idempotencyKey: 'I5' });
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'needs_supply_date');
  assert.equal(refused.position, 1);
  const dated = run('create_document', { type: 'invoice', contactId, currency: 'CHF', supplyDate: '2023-06-01', lines: [line77] });
  assert.ok(run('issue_invoice', { invoiceId: dated.document.id, idempotencyKey: 'I6' }).ok);
  assert.equal(row(store, dated.document.id).tax_minor, 7700);
});

// --- Every clone path keeps both dates (critic round 5) -----------------------------------------

/** A quote with a document-level 2023-12-20 and one line stated 2023-06-01, taken to `accepted`. */
function acceptedQuote(run, contactId) {
  const quote = run('create_document', {
    type: 'quote',
    contactId,
    currency: 'CHF',
    supplyDate: '2023-12-20',
    lines: [undated, { ...undated, supplyDate: '2023-06-01' }],
  });
  assert.ok(quote.ok, JSON.stringify(quote));
  for (const [to, key] of [['issued', 'aq1'], ['sent', 'aq2'], ['accepted', 'aq3']]) {
    assert.ok(run('transition_document', { documentId: quote.document.id, to, idempotencyKey: `${key}-${quote.document.id}` }).ok);
  }
  return quote.document.id;
}

test('quotes_revise keeps the document-level date and the line dates on the new version', () => {
  const { run, contactId } = setup();
  const quote = run('create_document', { type: 'quote', contactId, currency: 'CHF', supplyDate: '2023-12-20', lines: [undated, { ...undated, supplyDate: '2023-06-01' }] });
  assert.ok(run('transition_document', { documentId: quote.document.id, to: 'issued', idempotencyKey: 'r1' }).ok);
  assert.ok(run('transition_document', { documentId: quote.document.id, to: 'sent', idempotencyKey: 'r2' }).ok);
  const revised = run('quotes_revise', { quoteId: quote.document.id, idempotencyKey: 'rv' });
  assert.ok(revised.ok, JSON.stringify(revised));
  const newId = revised.quote?.id ?? revised.document?.id ?? revised.quoteId;
  const view = run('get_document', { documentId: newId });
  assert.equal(view.document.supplyDate, '2023-12-20');
  assert.deepEqual(view.lines.map((l) => l.supplyDate), [null, '2023-06-01']);
});

test('quote -> sales order -> invoice -> issue: both dates travel, and the invoice posts at them (7.7% twice)', () => {
  const { store, run, contactId } = setup();
  const quoteId = acceptedQuote(run, contactId);
  const order = run('sales_order_from_quote', { quoteId, idempotencyKey: 'so' });
  assert.ok(order.ok, JSON.stringify(order));
  const orderId = order.salesOrder.id;
  assert.equal(store.db.prepare('SELECT supply_date FROM sales_order WHERE id = ?').get(orderId).supply_date, '2023-12-20');
  assert.deepEqual(
    store.db.prepare('SELECT supply_date FROM so_line WHERE sales_order_id = ? ORDER BY sort').all(orderId).map((r) => r.supply_date),
    [null, '2023-06-01'],
  );
  assert.ok(run('sales_order_confirm', { salesOrderId: orderId, idempotencyKey: 'soc' }).ok);
  const invoiced = run('sales_order_invoice', { salesOrderId: orderId, idempotencyKey: 'soi' });
  assert.ok(invoiced.ok, JSON.stringify(invoiced));
  const view = run('get_document', { documentId: invoiced.invoiceId });
  assert.equal(view.document.supplyDate, '2023-12-20');
  assert.deepEqual(view.lines.map((l) => l.supplyDate), [null, '2023-06-01']);
  assert.ok(run('issue_invoice', { invoiceId: invoiced.invoiceId, idempotencyKey: 'soii' }).ok);
  // Both lines are 2023 supplies: 2 x (1'000.00 + 77.00), never the 2026 issue date's 8.1%.
  assert.deepEqual(row(store, invoiced.invoiceId), { supply_date: '2023-12-20', issue_date: '2026-07-16', tax_minor: 15400, total_minor: 215400 });
});

test('quote -> invoice by convert_document -> issue: posts at the quote\'s dates', () => {
  const { store, run, contactId } = setup();
  const quoteId = acceptedQuote(run, contactId);
  const inv = run('convert_document', { documentId: quoteId, toType: 'invoice', idempotencyKey: 'cv2' });
  assert.ok(inv.ok, JSON.stringify(inv));
  assert.ok(run('issue_invoice', { invoiceId: inv.document.id, idempotencyKey: 'cvi' }).ok);
  assert.equal(row(store, inv.document.id).tax_minor, 15400);
});

test('quote -> order document -> invoice by convert_document -> issue: both hops keep both dates', () => {
  const { store, run, contactId } = setup();
  const quoteId = acceptedQuote(run, contactId);
  const order = run('convert_document', { documentId: quoteId, toType: 'order', idempotencyKey: 'co1' });
  assert.ok(order.ok, JSON.stringify(order));
  for (const [to, key] of [['issued', 'o1'], ['sent', 'o2'], ['confirmed', 'o3']]) {
    const moved = run('transition_document', { documentId: order.document.id, to, idempotencyKey: key });
    assert.ok(moved.ok, JSON.stringify(moved));
  }
  const inv = run('convert_document', { documentId: order.document.id, toType: 'invoice', idempotencyKey: 'co2' });
  assert.ok(inv.ok, JSON.stringify(inv));
  const view = run('get_document', { documentId: inv.document.id });
  assert.equal(view.document.supplyDate, '2023-12-20');
  assert.deepEqual(view.lines.map((l) => l.supplyDate), [null, '2023-06-01']);
  assert.ok(run('issue_invoice', { invoiceId: inv.document.id, idempotencyKey: 'coi' }).ok);
  assert.equal(row(store, inv.document.id).tax_minor, 15400);
});
