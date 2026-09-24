/**
 * The document fixture-versus-engine drift guard (A10).
 *
 * The Documents app suite renders `get-document.fixture.json` and `list-documents.fixture.json` in
 * jsdom, standing in for the live `get_document` / `list_documents` responses. Like
 * test/vat/tax-codes-fixture.test.mjs, this pins those fixtures to the real engine response, keys AND
 * kinds (null its own kind), against a live-built document, so an app test can never pass green against
 * a shape the engine does not actually return.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { makeContext } from '../../dist/core/context.js';
import { fixedClock } from '../../dist/core/clock.js';
import { sequenceIdGen } from '../../dist/core/ids.js';
import { createWorkspace } from '../../dist/core/setup/index.js';
import { createDocument, transitionDocument, getDocument, listDocuments } from '../../dist/core/sales/index.js';

const GET_FIXTURE = new URL('../../app/src/surfaces/Documents/get-document.fixture.json', import.meta.url);
const LIST_FIXTURE = new URL('../../app/src/surfaces/Documents/list-documents.fixture.json', import.meta.url);

function keysOf(obj) {
  return Object.keys(obj).sort();
}
function kindOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/** Build the exact scenario the fixtures depict: an issued quote plus a draft invoice. */
function liveWorld() {
  const clock = fixedClock('2026-07-16T00:00:00.000Z');
  const ids = sequenceIdGen();
  const store = new SqliteStore({ clock });
  const deps = { store, clock, ids };
  const workspaceId = createWorkspace(deps, { name: 'Muster Grafik' }).workspaceId;
  const ctx = makeContext(store, { workspaceId, actor: 'user_1', clock, ids });
  store.db
    .prepare(
      `INSERT INTO contact (id, workspace_id, party_role, name, default_currency, payment_terms_days, created_at)
       VALUES ('ct_1', ?, 'customer', 'Muster AG', 'CHF', 30, '2026-07-16T00:00:00.000Z')`,
    )
    .run(workspaceId);
  const q = createDocument(ctx, {
    type: 'quote',
    contactId: 'ct_1',
    lines: [{ description: 'Beratung', quantityMilli: 10000, unitPriceMinor: 15000, taxCode: 'UST81' }],
  });
  transitionDocument(ctx, { documentId: q.document.id, to: 'issued' });
  createDocument(ctx, { type: 'invoice', contactId: 'ct_1', lines: [{ description: 'Spesen', unitPriceMinor: 4000 }] });
  return { ctx, quoteId: q.document.id };
}

/** Assert two objects have the same keys and the same per-key value kinds. */
function assertShape(fixture, live, where) {
  assert.deepEqual(keysOf(fixture), keysOf(live), `${where}: key drift`);
  for (const key of Object.keys(live)) {
    assert.equal(kindOf(fixture[key]), kindOf(live[key]), `${where}.${key}: kind drift`);
  }
}

test('the get-document fixture matches the live getDocument response, keys and kinds', () => {
  const { ctx, quoteId } = liveWorld();
  const live = getDocument(ctx, { documentId: quoteId });
  const fixture = JSON.parse(readFileSync(GET_FIXTURE, 'utf8'));

  assert.deepEqual(keysOf(fixture), keysOf(live), 'get_document envelope drifted');
  assertShape(fixture.document, live.document, 'document');
  assert.equal(kindOf(fixture.lines), 'array');
  assert.equal(fixture.lines.length, live.lines.length, 'line count drifted');
  assertShape(fixture.lines[0], live.lines[0], 'lines[0]');
  assert.equal(kindOf(fixture.history), 'array');
  assertShape(fixture.history[0], live.history[0], 'history[0]');
});

test('the list-documents fixture matches the live listDocuments response, keys and kinds', () => {
  const { ctx } = liveWorld();
  const live = listDocuments(ctx, {});
  const fixture = JSON.parse(readFileSync(LIST_FIXTURE, 'utf8'));

  assert.deepEqual(keysOf(fixture), keysOf(live), 'list_documents envelope drifted');
  assert.equal(kindOf(fixture.documents), 'array');
  assert.equal(fixture.documents.length, live.documents.length, 'document count drifted');
  assertShape(fixture.documents[0], live.documents[0], 'documents[0]');
  assert.equal(kindOf(fixture.truncated), kindOf(live.truncated), 'truncated kind drift');
  assert.equal(kindOf(fixture.total), kindOf(live.total), 'total kind drift');
  assert.equal(kindOf(fixture.ceiling), kindOf(live.ceiling), 'ceiling kind drift');
});
