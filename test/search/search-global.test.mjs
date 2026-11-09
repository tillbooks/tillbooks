/**
 * G07, `search_global`: the cross-entity read over the searchable-kind roster.
 *
 * WHAT THIS SUITE HOLDS, in the order the spec's §7/§8 name it:
 *
 *   COVERAGE OF THE ROSTER. Every kind in `SEARCHABLE_ENTITY_KINDS` is seeded through its own real
 *   creation verb and found by one query, and the seed map is asserted total over the roster, so a
 *   kind added tomorrow reddens this file until it is driven (the G00 `RECORD_FACTORIES` shape).
 *
 *   RBAC EXCLUSION (US-G07.5). An actor whose role lacks a kind's read capability gets zero rows of
 *   that kind and NO SIGNAL: no count, no placeholder, and a scoped query into the refused kind
 *   answers a plain empty success, indistinguishable from "no such record exists".
 *
 *   RANKING (US-G07.1). Exact > prefix > contains > custom-field-only, deterministic across calls.
 *
 *   WORKSPACE ISOLATION (§H-TENANT). An identical matching string in workspace B never appears in
 *   workspace A's results, driven over the same store.
 *
 *   THE OP7 BRANCH (US-G07.2). A confirmed text field is findable on the very next call (no reindex
 *   exists to forget), a DRAFT def is invisible until confirmed, and a money-typed value never
 *   free-text matches even when its JSON encoding contains the query.
 *
 *   THE E04-E07 BOUNDARY (US-G07.6), structurally: the roster's tables are disjoint from the
 *   local-correspondence tables, and the search module's source imports nothing from mail, voice,
 *   drafting or egress. A build-time exclusion, checked at test time against the shipped source.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { getAction } from '../../dist/api/registry.js';
import { SEARCHABLE_ENTITY_KINDS, SEARCHABLE_KIND_IDS } from '../../dist/core/search/index.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';

const MARK = 'Musterfund';

function must(res, what) {
  assert.equal(res.ok, true, `${what} failed: ${JSON.stringify(res)}`);
  return res;
}

/**
 * One record per searchable kind carrying the marker in a MATCHED column, minted through that
 * kind's own creation verb, never by INSERT (the G00 factory rule: a hand-written row would keep
 * passing over a kind whose real creation path changed).
 */
const SEEDS = {
  contact: (call, ids) =>
    must(call('create_contact', { partyRole: 'customer', name: `${MARK} Kontakt`, idempotencyKey: 'sg-contact' }), 'create_contact').contact.id,
  item: (call) =>
    must(call('create_item', { name: `${MARK} Artikel`, defaultUnitPriceMinor: 1500, idempotencyKey: 'sg-item' }), 'create_item').item.id,
  document: (call) =>
    must(call('create_document', { type: 'invoice', notes: `${MARK} Beleg`, idempotencyKey: 'sg-doc' }), 'create_document').document.id,
  project: (call, ids) =>
    must(call('project_create', { name: `${MARK} Projekt`, contactId: ids.contactId, idempotencyKey: 'sg-proj' }), 'project_create').project.id,
  deal: (call, ids) =>
    must(call('deals_create', { contactId: ids.contactId, title: `${MARK} Deal`, valueMinor: 50000, idempotencyKey: 'sg-deal' }), 'deals_create').dealId,
  task: (call) =>
    must(call('tasks_create', { title: `${MARK} Aufgabe`, assigneeUserId: 'studio', idempotencyKey: 'sg-task' }), 'tasks_create').taskId,
  vendor_bill: (call, ids) =>
    must(
      call('create_vendor_bill', {
        vendorId: ids.vendorId,
        billDate: '2026-07-01',
        amountMinor: 10000,
        expenseAccountId: ids.accId('6500'),
        vendorReference: `${MARK}-VB-1`,
        idempotencyKey: 'sg-vb',
      }),
      'create_vendor_bill',
    ).vendorBillId,
  sales_order: (call, ids) =>
    must(call('sales_order_create', { contactId: ids.contactId, notes: `${MARK} Auftrag`, idempotencyKey: 'sg-so' }), 'sales_order_create').salesOrder.id,
  po: (call, ids) =>
    must(call('po_upsert', { supplierContactId: ids.vendorId, note: `${MARK} Bestellung`, idempotencyKey: 'sg-po' }), 'po_upsert').poId,
};

/** A workspace with one marked record of EVERY searchable kind, owned by `studio`. */
function seededWorld(seed = 'sgw') {
  const deps = freshDeps();
  deps.actor = 'studio';
  const { workspaceId, accId } = mintWorkspace(deps, 'Suche GmbH', `${seed}-ws`);
  const call = (name, input) => getAction(name).run(deps, { workspaceId, ...input });

  const contactId = SEEDS.contact(call, {});
  const vendorId = must(
    call('create_contact', { partyRole: 'vendor', name: 'Lieferant AG', idempotencyKey: `${seed}-vendor` }),
    'create_contact (vendor)',
  ).contact.id;

  const ids = { contactId, vendorId, accId };
  const byKind = { contact: contactId };
  for (const kind of SEARCHABLE_KIND_IDS) {
    if (kind === 'contact') continue;
    byKind[kind] = SEEDS[kind](call, ids);
  }
  return { deps, workspaceId, call, ids, byKind };
}

test('G07: the seed map is total over the roster, so a new kind reddens this file until driven', () => {
  assert.deepEqual(
    [...SEARCHABLE_KIND_IDS].sort(),
    Object.keys(SEEDS).sort(),
    'SEARCHABLE_ENTITY_KINDS and the SEEDS map disagree: add a seed line for the new kind',
  );
});

test('G07: one query finds a record of EVERY searchable kind, each routed to its own surface', () => {
  const { call, byKind } = seededWorld('sg-all');
  const res = must(call('search_global', { q: MARK, limit: 50 }), 'search_global');

  const found = new Map(res.results.map((r) => [r.entityKind, r]));
  for (const kind of SEARCHABLE_KIND_IDS) {
    const hit = found.get(kind);
    assert.ok(hit !== undefined, `no ${kind} hit for '${MARK}'; got ${JSON.stringify(res.results)}`);
    assert.equal(hit.entityId, byKind[kind], `${kind}: found a different record than the seeded one`);
    assert.equal(typeof hit.title, 'string');
    assert.ok(hit.title.length > 0, `${kind}: an empty title is not a result a person can act on`);
    assert.ok(hit.route.startsWith('/'), `${kind}: route '${hit.route}' is not a Studio route`);
    assert.equal(hit.matchedVia, 'field');
  }
  assert.equal(res.failedKinds.length, 0, `adapters failed: ${res.failedKinds}`);
  // Answers identically twice: the ranking is deterministic and the read moved nothing.
  assert.deepEqual(call('search_global', { q: MARK, limit: 50 }), res);
});

test('G07: rejections are P9 values naming what was wrong', () => {
  const { call } = seededWorld('sg-rej');
  assert.deepEqual(call('search_global', { q: 'x' }), { ok: false, error: 'query_too_short', minLength: 2 });
  const unknown = call('search_global', { q: MARK, entityKinds: ['journal_entry'] });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error, 'unknown_entity_kind');
  assert.deepEqual(unknown.known, [...SEARCHABLE_KIND_IDS], 'the refusal names the real roster');
  assert.equal(call('search_global', { q: MARK, limit: 0 }).error, 'invalid_limit');
  assert.equal(call('search_global', { q: MARK, cursor: 'nope' }).error, 'invalid_cursor');
});

test('G07: ranking is exact > prefix > contains > custom-field-only, deterministic', () => {
  const deps = freshDeps();
  deps.actor = 'studio';
  const { workspaceId } = mintWorkspace(deps, 'Rang GmbH', 'sg-rank-ws');
  const call = (name, input) => getAction(name).run(deps, { workspaceId, ...input });

  const exact = must(call('create_contact', { partyRole: 'customer', name: 'Alpha', idempotencyKey: 'r-1' }), 'c1').contact.id;
  const prefix = must(call('create_contact', { partyRole: 'customer', name: 'Alphabet AG', idempotencyKey: 'r-2' }), 'c2').contact.id;
  const contains = must(call('create_contact', { partyRole: 'customer', name: 'Der Alpha Laden', idempotencyKey: 'r-3' }), 'c3').contact.id;
  const fieldOnly = must(call('create_contact', { partyRole: 'customer', name: 'Beta GmbH', idempotencyKey: 'r-4' }), 'c4').contact.id;

  const def = must(
    call('define_field', {
      entityKind: 'contact',
      key: 'segment_note',
      labelI18n: { 'de-CH': 'Segment-Notiz', en: 'Segment note' },
      type: 'text',
      idempotencyKey: 'r-def',
    }),
    'define_field',
  );
  must(call('confirm_field', { fieldDefId: def.fieldDef.fieldDefId, idempotencyKey: 'r-conf' }), 'confirm_field');
  must(
    call('set_field_value', { entityKind: 'contact', entityId: fieldOnly, fieldKey: 'segment_note', value: 'Alpha-Kunde', idempotencyKey: 'r-val' }),
    'set_field_value',
  );

  const res = must(call('search_global', { q: 'Alpha' }), 'search_global');
  assert.deepEqual(
    res.results.map((r) => r.entityId),
    [exact, prefix, contains, fieldOnly],
    `ranking order wrong: ${JSON.stringify(res.results)}`,
  );
  assert.equal(res.results[3].matchedVia, 'custom_field');
  assert.equal(res.results[3].snippet, 'Segment-Notiz: Alpha-Kunde');
});

test('G07: a kind the actor cannot read is silently absent, with no count and no signal (US-G07.5)', () => {
  const { deps, workspaceId, call } = seededWorld('sg-rbac');

  // Provision the workspace (the invite seats studio+agent as owners), then narrow the agent to a
  // custom role holding ONLY read_master_data: the product's own US-A24.5 flow, no row by hand.
  must(call('invite_member', { email: 'sg-rbac@muster.ch', role: 'viewer', idempotencyKey: 'rbac-invite' }), 'invite_member');
  const role = must(call('define_role', { name: 'Stammdaten-Leser', capabilities: ['read_master_data'], idempotencyKey: 'rbac-role' }), 'define_role');
  const seat = must(call('list_members', {}), 'list_members').members.find((m) => m.actorId === 'agent');
  assert.ok(seat !== undefined, 'the provisioning flip did not seat the agent');
  must(call('set_role', { memberId: seat.memberId, role: role.roleId }), 'set_role');

  deps.actor = 'agent';
  const res = must(call('search_global', { q: MARK, limit: 50 }), 'search_global as restricted agent');
  const kinds = new Set(res.results.map((r) => r.entityKind));

  // read_master_data covers contact, item, project and po; every other kind must be ABSENT.
  for (const readable of ['contact', 'item', 'project', 'po']) {
    assert.ok(kinds.has(readable), `${readable} should be readable with read_master_data`);
  }
  for (const hidden of ['document', 'deal', 'task', 'vendor_bill', 'sales_order']) {
    assert.ok(!kinds.has(hidden), `${hidden} leaked to an actor without its read capability`);
  }
  // The total counts ONLY what the caller may see: a count including hidden kinds is a signal.
  assert.equal(res.total, res.results.length);

  // Scoping INTO a refused kind is a plain empty success, indistinguishable from "no such record".
  const scoped = must(call('search_global', { q: MARK, entityKinds: ['document'] }), 'scoped into refused kind');
  assert.deepEqual(scoped.results, []);
  assert.equal(scoped.total, 0);
  assert.equal(scoped.hasMore, false);
});

test('G07: workspace isolation, the same string in another workspace never crosses over (§H-TENANT)', () => {
  const deps = freshDeps();
  deps.actor = 'studio';
  const a = mintWorkspace(deps, 'Mandant A', 'iso-a');
  const b = mintWorkspace(deps, 'Mandant B', 'iso-b');
  const callIn = (ws, name, input) => getAction(name).run(deps, { workspaceId: ws, ...input });

  const inA = must(callIn(a.workspaceId, 'create_contact', { partyRole: 'customer', name: 'Isolation AG', idempotencyKey: 'iso-1' }), 'c-a').contact.id;
  must(callIn(b.workspaceId, 'create_contact', { partyRole: 'customer', name: 'Isolation AG', idempotencyKey: 'iso-2' }), 'c-b');

  const res = must(callIn(a.workspaceId, 'search_global', { q: 'Isolation' }), 'search in A');
  assert.equal(res.results.length, 1);
  assert.equal(res.results[0].entityId, inA);
});

test('G07: a custom field is findable on the NEXT call, a draft is not, a money value never (US-G07.2)', () => {
  const deps = freshDeps();
  deps.actor = 'studio';
  const { workspaceId } = mintWorkspace(deps, 'Felder GmbH', 'cf-ws');
  const call = (name, input) => getAction(name).run(deps, { workspaceId, ...input });
  const contactId = must(call('create_contact', { partyRole: 'customer', name: 'Feld AG', idempotencyKey: 'cf-c' }), 'c').contact.id;

  // A DRAFT def (agent-authored, P8) is invisible to search until confirmed.
  deps.actor = 'agent';
  const draft = must(
    call('define_field', { entityKind: 'contact', key: 'aktenzeichen', labelI18n: { 'de-CH': 'Aktenzeichen', en: 'File ref' }, type: 'text', idempotencyKey: 'cf-def' }),
    'define_field',
  );
  assert.equal(draft.fieldDef.draft, true, 'an agent-authored def should land as a P8 draft');
  // A draft def cannot even HOLD a value (G00 refuses the write), so there is nothing for search to
  // leak pre-confirm; the verb's own d.draft = 0 filter is defence in depth over that guarantee.
  const refused = call('set_field_value', { entityKind: 'contact', entityId: contactId, fieldKey: 'aktenzeichen', value: 'AZ-77413', idempotencyKey: 'cf-draftval' });
  assert.equal(refused.error, 'field_draft');
  deps.actor = 'studio';
  must(call('confirm_field', { fieldDefId: draft.fieldDef.fieldDefId, idempotencyKey: 'cf-conf' }), 'confirm_field');
  must(call('set_field_value', { entityKind: 'contact', entityId: contactId, fieldKey: 'aktenzeichen', value: 'AZ-77413', idempotencyKey: 'cf-val' }), 'set_field_value');

  // Findable immediately: the design is a live fan-out, there is no reindex step to forget.
  const found = must(call('search_global', { q: '77413' }), 'search_global');
  assert.equal(found.results.length, 1);
  assert.equal(found.results[0].entityId, contactId);
  assert.equal(found.results[0].matchedVia, 'custom_field');
  assert.equal(found.results[0].snippet, 'Aktenzeichen: AZ-77413');

  // A money-typed value never free-text matches, even though its JSON encoding contains the query.
  const money = must(
    call('define_field', { entityKind: 'contact', key: 'kreditlimite', labelI18n: { 'de-CH': 'Kreditlimite', en: 'Credit limit' }, type: 'money', idempotencyKey: 'cf-money' }),
    'define_field (money)',
  );
  must(call('confirm_field', { fieldDefId: money.fieldDef.fieldDefId, idempotencyKey: 'cf-mconf' }), 'confirm_field (money)');
  must(call('set_field_value', { entityKind: 'contact', entityId: contactId, fieldKey: 'kreditlimite', value: 88555, idempotencyKey: 'cf-mval' }), 'set_field_value (money)');
  const none = must(call('search_global', { q: '88555' }), 'search_global (money probe)');
  assert.deepEqual(none.results, [], 'a money-typed custom field must never free-text match');
});

test('G07: limit and cursor page the ranked list without losing or repeating a row', () => {
  const deps = freshDeps();
  deps.actor = 'studio';
  const { workspaceId } = mintWorkspace(deps, 'Seiten GmbH', 'pg-ws');
  const call = (name, input) => getAction(name).run(deps, { workspaceId, ...input });
  for (let i = 1; i <= 5; i += 1) {
    must(call('create_contact', { partyRole: 'customer', name: `Seite ${i} AG`, idempotencyKey: `pg-${i}` }), `c${i}`);
  }

  const first = must(call('search_global', { q: 'Seite', limit: 2 }), 'page 1');
  assert.equal(first.results.length, 2);
  assert.equal(first.total, 5);
  assert.equal(first.hasMore, true);
  assert.equal(first.nextCursor, '2');

  const second = must(call('search_global', { q: 'Seite', limit: 2, cursor: first.nextCursor }), 'page 2');
  const third = must(call('search_global', { q: 'Seite', limit: 2, cursor: second.nextCursor }), 'page 3');
  assert.equal(third.hasMore, false);
  assert.equal(third.nextCursor, undefined);

  const seen = [...first.results, ...second.results, ...third.results].map((r) => r.entityId);
  assert.equal(new Set(seen).size, 5, `pages lost or repeated a row: ${seen}`);
});

test('G07: a saved global search re-runs LIVE through savedViewId, explicit fields winning (US-G07.4)', () => {
  const { deps, call, byKind } = seededWorld('sg-saved');
  const savedRes = call('create_saved_view', {
    entityKind: 'global_search',
    name: 'Musterfund in Kontakten',
    filters: { q: MARK, entityKinds: ['contact'] },
    idempotencyKey: 'sgv-1',
  });
  assert.equal(savedRes.ok, true, JSON.stringify(savedRes));

  // The stored filters drive the search: q AND the contact scope arrive from the view.
  const viaView = call('search_global', { savedViewId: savedRes.savedView.viewId });
  assert.equal(viaView.ok, true, JSON.stringify(viaView));
  assert.deepEqual(viaView.results.map((r) => r.entityKind), ['contact']);
  assert.equal(viaView.results[0].entityId, byKind.contact);

  // Always live, never a cached result set (P5): a record created after the save is found.
  const later = call('create_contact', { partyRole: 'customer', name: `${MARK} Zwei AG`, idempotencyKey: 'sgv-2' });
  assert.equal(later.ok, true);
  const rerun = call('search_global', { savedViewId: savedRes.savedView.viewId });
  assert.equal(rerun.results.length, 2);

  // An explicitly named field WINS over the stored one: scoping to items overrides the view.
  const overridden = call('search_global', { savedViewId: savedRes.savedView.viewId, entityKinds: ['item'] });
  assert.deepEqual(overridden.results.map((r) => r.entityKind), ['item']);

  // Neither q nor a view is still a refusal, not a full-table answer.
  assert.equal(call('search_global', {}).error, 'query_too_short');
  void deps;
});

test('G07: one failing adapter names its kind and never fails the search (P9)', () => {
  const { deps, call } = seededWorld('sg-fail');
  // Force a real adapter failure: the task table is gone, every other kind must still answer.
  deps.store.db.exec('DROP TABLE task');
  const res = must(call('search_global', { q: MARK, limit: 50 }), 'search_global with a broken adapter');
  assert.ok(res.failedKinds.includes('task'), `failedKinds ${JSON.stringify(res.failedKinds)} does not name task`);
  const kinds = new Set(res.results.map((r) => r.entityKind));
  assert.ok(!kinds.has('task'));
  assert.ok(kinds.has('contact') && kinds.has('document'), 'the healthy adapters must still answer');
});

test('G07: the E04-E07 boundary is structural, no correspondence table and no import (US-G07.6)', () => {
  // The roster's tables are disjoint from the local-correspondence and drafting tables.
  const FORBIDDEN_TABLES = ['mail_thread', 'mail_message', 'mail_draft', 'mail_attachment', 'voice_exemplar', 'voice_profile', 'draft_run'];
  for (const def of SEARCHABLE_ENTITY_KINDS) {
    assert.ok(!FORBIDDEN_TABLES.includes(def.table), `${def.kind} reads ${def.table}, inside the OP6 boundary`);
    assert.ok(!/^(mail|voice|draft)_/.test(def.table), `${def.kind} reads ${def.table}, which is correspondence-shaped`);
  }
  // And the module's source reaches no E04-E07 module. Comments stripped, so prose cannot trip it.
  const dir = fileURLToPath(new URL('../../src/core/search', import.meta.url));
  for (const file of readdirSync(dir)) {
    const source = readFileSync(join(dir, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    for (const banned of ['../mail/', '../voice/', '../drafting/', '../egress/']) {
      assert.ok(!source.includes(banned), `${file} imports ${banned}, crossing the E04-E07 boundary`);
    }
  }
  // Non-vacuous: the same probe finds a legitimate import in the module itself.
  const barrel = readFileSync(join(dir, 'index.ts'), 'utf8');
  assert.ok(barrel.includes("./searchGlobal.js"), 'the probe cannot even see the barrel import');
});
