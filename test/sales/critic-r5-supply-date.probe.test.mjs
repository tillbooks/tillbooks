/**
 * Non-author critic, round 5 (D164 at a5fb57cb): the document-level Leistungsdatum on the paths that
 * COPY or RESTORE a document. Synthetic data only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { sequenceIdGen } from '../../dist/core/ids.js';
import { getAction } from '../../dist/api/registry.js';

function world(at = '2024-01-10T09:00:00.000Z', extra = {}) {
  let now = at;
  const clock = { now: () => now };
  const deps = { store: new SqliteStore({ clock }), clock, ids: sequenceIdGen(), actor: 'user_1', ...extra };
  const { workspaceId } = getAction('create_workspace').run(deps, { name: 'Probe GmbH', idempotencyKey: 'ws' });
  const run = (verb, input) => getAction(verb).run(deps, { workspaceId, ...input });
  assert.equal(run('vat_configure', { method: 'effektiv', timing: 'soll', registered: true, idempotencyKey: 'cfg' }).ok, true);
  const ct = run('create_contact', { partyRole: 'customer', name: 'Muster AG', idempotencyKey: 'ct' });
  assert.equal(ct.ok, true, JSON.stringify(ct));
  return { deps, workspaceId, run, contactId: ct.contact.id, setNow: (iso) => (now = iso) };
}

const LINE = { description: 'Umbau', quantityMilli: 1000, unitPriceMinor: 100000, taxCode: 'UST81' };

test('PROBE quotes_revise: a quote stated at 20.12.2023 (document Datum) keeps its Leistungsdatum through a revision and a conversion', () => {
  const w = world();
  const q = w.run('create_document', { type: 'quote', contactId: w.contactId, currency: 'CHF', supplyDate: '2023-12-20', lines: [LINE], idempotencyKey: 'q' });
  assert.equal(q.ok, true, JSON.stringify(q));
  assert.equal(w.run('transition_document', { documentId: q.document.id, to: 'issued', idempotencyKey: 'q1' }).ok, true);
  assert.equal(w.run('transition_document', { documentId: q.document.id, to: 'sent', idempotencyKey: 'q2' }).ok, true);
  const revised = w.run('quotes_revise', { quoteId: q.document.id, idempotencyKey: 'rv' });
  assert.equal(revised.ok, true, JSON.stringify(revised));
  const newId = revised.quote?.id ?? revised.document?.id ?? revised.quoteId;
  const view = w.run('get_document', { documentId: newId });
  const after = { documentDate: view.document.supplyDate, lineDates: view.lines.map((l) => l.supplyDate) };
  // Then accepted, converted, issued: what does the invoice post?
  w.run('transition_document', { documentId: newId, to: 'issued', idempotencyKey: 'n1' });
  w.run('transition_document', { documentId: newId, to: 'sent', idempotencyKey: 'n2' });
  w.run('transition_document', { documentId: newId, to: 'accepted', idempotencyKey: 'n3' });
  const conv = w.run('convert_document', { documentId: newId, toType: 'invoice', idempotencyKey: 'cv' });
  assert.equal(conv.ok, true, JSON.stringify(conv));
  const iss = w.run('issue_invoice', { invoiceId: conv.document.id, idempotencyKey: 'is' });
  assert.equal(iss.ok, true, JSON.stringify(iss));
  assert.deepEqual({ ...after, posted: iss.document.totalMinor }, { documentDate: '2023-12-20', lineDates: [null], posted: 107700 });
});

test('PROBE backup/restore: the document-level Leistungsdatum survives, and the restored draft posts at it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'r5-bk-'));
  try {
    const w = world('2024-01-10T09:00:00.000Z', { backupDir: join(dir, 'b') });
    const d = w.run('create_document', { type: 'invoice', contactId: w.contactId, currency: 'CHF', supplyDate: '2023-12-20', lines: [LINE], idempotencyKey: 'd' });
    assert.equal(d.ok, true);
    const bk = w.run('create_backup', { idempotencyKey: 'bk' });
    assert.equal(bk.ok, true, JSON.stringify(bk));
    const restored = getAction('restore_backup').run(w.deps, { source: bk.artifactRef, newWorkspaceName: 'Kopie AG', confirmed: true });
    assert.equal(restored.ok, true, JSON.stringify(restored));
    const ws2 = restored.workspaceId;
    const docs = getAction('list_documents').run(w.deps, { workspaceId: ws2 });
    assert.equal(docs.ok, true, JSON.stringify(docs));
    const copy = docs.documents[0];
    assert.equal(copy.supplyDate, '2023-12-20', 'list_documents carries it');
    const iss = getAction('issue_invoice').run(w.deps, { workspaceId: ws2, invoiceId: copy.id, idempotencyKey: 'is2' });
    assert.equal(iss.ok, true, JSON.stringify(iss));
    assert.equal(iss.document.totalMinor, 107700);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('PROBE pre-D164 file: a ledger without document.supply_date opens, gains the column as NULL, and a draft issues at the issue date', () => {
  const dir = mkdtempSync(join(tmpdir(), 'r5-old-'));
  try {
    const file = join(dir, 'old.db');
    const clock = { now: () => '2024-01-10T09:00:00.000Z' };
    let store = new SqliteStore({ clock, location: file });
    const deps = { store, clock, ids: sequenceIdGen(), actor: 'user_1' };
    const { workspaceId } = getAction('create_workspace').run(deps, { name: 'Alt AG', idempotencyKey: 'ws' });
    getAction('vat_configure').run(deps, { workspaceId, method: 'effektiv', timing: 'soll', registered: true, idempotencyKey: 'cfg' });
    const d = getAction('create_document').run(deps, { workspaceId, type: 'invoice', currency: 'CHF', lines: [{ ...LINE, supplyDate: '2023-12-20' }] });
    assert.equal(d.ok, true, JSON.stringify(d));
    store.db.exec('ALTER TABLE document DROP COLUMN supply_date');
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM pragma_table_info('document') WHERE name = 'supply_date'").get().n, 0);
    store.db.close();
    store = new SqliteStore({ clock, location: file });
    const deps2 = { store, clock, ids: sequenceIdGen(), actor: 'user_1' };
    const view = getAction('get_document').run(deps2, { workspaceId, documentId: d.document.id });
    assert.equal(view.ok, true, JSON.stringify(view));
    assert.deepEqual({ doc: view.document.supplyDate, line: view.lines[0].supplyDate }, { doc: null, line: '2023-12-20' });
    store.db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('PROBE derived Gutschrift of an invoice whose Datum was stated at the document level: pinned at that date', () => {
  const w = world();
  const inv = w.run('create_document', { type: 'invoice', contactId: w.contactId, currency: 'CHF', supplyDate: '2023-12-20', lines: [LINE], idempotencyKey: 'i' });
  assert.equal(w.run('issue_invoice', { invoiceId: inv.document.id, idempotencyKey: 'ii' }).document.totalMinor, 107700);
  const cn = w.run('create_credit_note', { fromInvoiceId: inv.document.id, idempotencyKey: 'cn' });
  assert.equal(cn.ok, true, JSON.stringify(cn));
  const view = w.run('get_document', { documentId: cn.document.id });
  assert.equal(view.lines[0].supplyDate, '2023-12-20');
  assert.equal(w.run('update_document', { documentId: cn.document.id, patch: { supplyDate: '2024-01-05' } }).error, 'credit_note_lines_derived');
  const iss = w.run('issue_credit_note', { creditNoteId: cn.document.id, idempotencyKey: 'ic' });
  assert.equal(iss.ok, true, JSON.stringify(iss));
  assert.equal(iss.document.totalMinor, 107700);
});

test('PROBE invalid document date refused at write', () => {
  const w = world();
  for (const bad of ['2023-13-01', '2023-02-30', 'gestern', 20231220]) {
    const r = w.run('create_document', { type: 'invoice', contactId: w.contactId, currency: 'CHF', supplyDate: bad, lines: [LINE] });
    assert.ok(r.error === 'invalid_date' || (typeof bad !== 'string' && r.error === 'invalid_input'), `${bad}: ${JSON.stringify(r)}`);
  }
});
