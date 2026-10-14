/**
 * D157: a portal link opens nothing until it is sent.
 *
 * The defect: a customer grant minted by `portal_grant_create` was live the moment it existed, because
 * `isLive` read only revocation and expiry. Two earlier fixes failed review: requiring `sent_at` broke
 * every old vendor grant (whose `sent_at` is NULL), and exempting `kind: 'vendor'` let a caller pass
 * `kind: 'vendor'` to `portal_grant_create` and get a live grant without sending. The rebuild reads an
 * ENGINE-WRITTEN marker (`minted_draft`, 1 on every grant minted since D157, the DDL default 0 on every
 * older row) and takes `kind` out of caller input. This suite holds:
 *
 *   1. a draft is dead on every token path, writes nothing and is audited; a confirmed send opens it;
 *   2. `kind` cannot relabel a customer create, through the registry, REST, MCP or a stored rule;
 *   3. no input key smuggles a live state into a create, and the vendor door always mints vendor;
 *   4. a book written before D157 widens on open, and its grants keep their old liveness (owner 1);
 *   5. an old-shaped current-generation snapshot restores with no link live (D161.2); a new draft stays a draft;
 *   6. `status === 'active'` exactly when the grant is live, across every shape a row can have;
 *   7. structural: every INSERT into `portal_grant` under `src/` names `minted_draft` (the DEFAULT 0
 *      fails OPEN, so this is the guard), and the barrel does not export `createVendorGrant`;
 *   8. idempotency and §H-TENANT on create and send.
 *
 * Synthetic data only.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

import { getAction } from '../../dist/api/registry.js';
import { handleRest } from '../../dist/api/rest.js';
import { callTool } from '../../dist/api/mcp.js';
import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { fixedClock } from '../../dist/core/clock.js';
import { sequenceIdGen, systemIdGen } from '../../dist/core/ids.js';
import { schemaShapeOf, schemaFingerprint } from '../../dist/core/store/schemaShape.js';
import { SCHEMA_GENERATION } from '../../dist/core/store/schema.js';
import { mapGrant, isGrantLive } from '../../dist/core/portal/index.js';
import * as portalBarrel from '../../dist/core/portal/index.js';
import { freshDeps, mintWorkspace, AT } from '../api/support.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TODAY = AT.slice(0, 10); // 2026-07-16, the fixture clock's day

let seq = 0;
const k = (p) => `${p}-${(seq += 1)}`;

/** A call bound to one workspace (the operator face). */
const callFor = (deps, workspaceId) => (name, input) => getAction(name).run(deps, { workspaceId, ...input });
/** The token face: no workspace, the grant binds it. */
const tokenCall = (deps, name, input) => getAction(name).run(deps, input);

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

function customer(call, name = 'Kundin AG') {
  const c = call('create_contact', { partyRole: 'customer', name, idempotencyKey: k('c') });
  assert.equal(c.ok, true, JSON.stringify(c));
  return c.contact.id;
}
function supplier(call, name = 'Lieferant GmbH') {
  const c = call('create_contact', { partyRole: 'vendor', name, idempotencyKey: k('v') });
  assert.equal(c.ok, true, JSON.stringify(c));
  return c.contact.id;
}
function sentQuote(call, contactId) {
  const q = call('quotes_create', { contactId, validUntil: '2027-01-31', lines: [{ description: 'Leistung', unitPriceMinor: 30000 }], idempotencyKey: k('q') });
  assert.equal(q.ok, true, JSON.stringify(q));
  const sent = call('quotes_send', { quoteId: q.document.id, idempotencyKey: k('qs') });
  assert.equal(sent.ok, true, JSON.stringify(sent));
  return q.document.id;
}

/**
 * The trails a call leaves whatever it does: the audit log (a denial is audited on purpose) and the
 * agent trace the transport seam writes for every call it carries (REST/MCP as the agent seat).
 */
const TRACE_TABLES = new Set(['audit_log', 'audit_head', 'agent_call', 'agent_turn', 'agent_session']);

/** Every row of every table except the trails, as one comparable value. */
function businessRows(db) {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((r) => r.name)
    .filter((n) => !TRACE_TABLES.has(n));
  return Object.fromEntries(tables.map((t) => [t, db.prepare(`SELECT * FROM "${t}" ORDER BY rowid`).all()]));
}

const denies = (db, grantId) =>
  db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE entity_kind = 'portal_grant' AND entity_id = ? AND action = 'deny'").get(grantId).n;

const grantRow = (db, grantId) => db.prepare('SELECT * FROM portal_grant WHERE id = ?').get(grantId);

// --- 1. a draft is dead ----------------------------------------------------------------------------

test('1. a draft is dead: resolve and quote-accept deny, write zero rows, leave the quote sent, and audit the deny', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  const call = callFor(deps, workspaceId);
  const contactId = customer(call);
  const quoteId = sentQuote(call, contactId);

  const g = call('portal_grant_create', { contactId, scopes: [{ kind: 'quote', id: quoteId }, { kind: 'all_invoices' }], expiresAt: '2026-09-30', idempotencyKey: k('g') });
  assert.equal(g.ok, true, JSON.stringify(g));
  assert.equal(g.grant.status, 'draft');
  assert.equal(grantRow(deps.store.db, g.grantId).minted_draft, 1, 'the engine wrote the draft marker');

  const before = businessRows(deps.store.db);
  const resolved = tokenCall(deps, 'portal_resolve', { token: g.tokenOnce });
  assert.deepEqual(resolved, { ok: false, error: 'grant_denied' }, 'a draft token opened the portal');
  const accepted = tokenCall(deps, 'portal_quote_accept', { token: g.tokenOnce, quoteId, idempotencyKey: k('pa') });
  assert.deepEqual(accepted, { ok: false, error: 'grant_denied' }, 'a draft token accepted a quote');
  assert.deepEqual(businessRows(deps.store.db), before, 'a denied draft wrote a row (or stamped last_resolved_at)');
  assert.equal(call('quotes_get', { quoteId }).document.status, 'sent', 'the quote moved under a draft token');
  assert.equal(denies(deps.store.db, g.grantId), 2, 'each denied attempt lands one deny row in the audit trail');

  // An UNCONFIRMED send keeps it dead.
  const unconfirmed = call('portal_grant_send', { grantId: g.grantId, idempotencyKey: k('s') });
  assert.equal(unconfirmed.error, 'needs_confirmation');
  assert.equal(grantRow(deps.store.db, g.grantId).sent_at, null);
  assert.equal(tokenCall(deps, 'portal_resolve', { token: g.tokenOnce }).error, 'grant_denied', 'an unconfirmed send opened the link');

  // A CONFIRMED send opens the SAME token.
  const sent = call('portal_grant_send', { grantId: g.grantId, confirmed: true, idempotencyKey: k('s') });
  assert.equal(sent.ok, true, JSON.stringify(sent));
  assert.equal(sent.grant.status, 'active');
  const open = tokenCall(deps, 'portal_resolve', { token: g.tokenOnce });
  assert.equal(open.ok, true, JSON.stringify(open));
  assert.deepEqual(open.quotes.map((q) => q.id), [quoteId]);
  const acceptedNow = tokenCall(deps, 'portal_quote_accept', { token: g.tokenOnce, quoteId, idempotencyKey: k('pa') });
  assert.equal(acceptedNow.ok, true, JSON.stringify(acceptedNow));
  assert.equal(call('quotes_get', { quoteId }).document.status, 'accepted');
  deps.store.close();
});

// --- 2. relabel ------------------------------------------------------------------------------------

test('2. relabel: portal_grant_create {kind:"vendor"} is invalid_input {field:"kind"} and writes zero rows, through the registry, REST and MCP', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  const call = callFor(deps, workspaceId);
  const contactId = supplier(call, 'Beides GmbH'); // a supplier: the vendor fence would have let it through
  const input = { workspaceId, contactId, scopes: [{ kind: 'pos.read' }], expiresAt: '2026-09-30', kind: 'vendor' };
  const before = businessRows(deps.store.db);

  const viaRegistry = getAction('portal_grant_create').run(deps, { ...input, idempotencyKey: k('r') });
  assert.equal(viaRegistry.ok, false);
  assert.equal(viaRegistry.error, 'invalid_input');
  assert.equal(viaRegistry.field, 'kind');

  const viaRest = handleRest('portal_grant_create', { ...input, idempotencyKey: k('r') }, deps).body;
  assert.equal(viaRest.ok, false, JSON.stringify(viaRest));
  assert.equal(viaRest.error, 'invalid_input');
  assert.equal(viaRest.field, 'kind');

  const viaMcp = JSON.parse(callTool(deps, 'portal_grant_create', { ...input, idempotencyKey: k('r') }).content[0].text);
  assert.equal(viaMcp.ok, false, JSON.stringify(viaMcp));
  assert.equal(viaMcp.error, 'invalid_input');

  // Any other value is refused too; only undefined and 'customer' pass.
  for (const kind of ['VENDOR', 'supplier', '', null, 1, ['vendor']]) {
    const r = getAction('portal_grant_create').run(deps, { ...input, kind, idempotencyKey: k('r') });
    assert.equal(r.error, 'invalid_input', `kind ${JSON.stringify(kind)} was not refused`);
  }
  assert.deepEqual(businessRows(deps.store.db), before, 'a refused relabel wrote a row');
  assert.equal(deps.store.db.prepare('SELECT COUNT(*) AS n FROM portal_grant').get().n, 0);

  // kind:'customer' is accepted, and still a draft.
  const cust = customer(call);
  const okCustomer = call('portal_grant_create', { contactId: cust, scopes: [{ kind: 'all_invoices' }], expiresAt: '2026-09-30', kind: 'customer', idempotencyKey: k('g') });
  assert.equal(okCustomer.ok, true, JSON.stringify(okCustomer));
  assert.equal(okCustomer.grant.kind, 'customer');
  assert.equal(okCustomer.grant.status, 'draft');
  assert.equal(tokenCall(deps, 'portal_resolve', { token: okCustomer.tokenOnce }).error, 'grant_denied');
  deps.store.close();
});

/** A workspace whose seeded G22 rules are retired, so the only rule that fires is the test's own. */
function ruleWorld(seed) {
  const deps = freshDeps();
  deps.actor = 'studio';
  const { workspaceId } = mintWorkspace(deps, 'Regel AG', `${seed}-ws`);
  for (const { id } of deps.store.db.prepare("SELECT id FROM automation_rule WHERE workspace_id = ?").all(workspaceId)) {
    assert.equal(getAction('disable_automation_rule').run(deps, { workspaceId, ruleId: id }).ok, true);
  }
  return { deps, workspaceId, call: callFor(deps, workspaceId) };
}

/** A rule that mints a portal grant for every new contact, with `extra` merged into its stored input. */
function grantRule(w, extra, seed) {
  const created = w.call('create_automation_rule', {
    name: 'Portal für jeden Kontakt',
    trigger: { event: 'contact.created' },
    action: { tool: 'portal_grant_create', inputTemplate: { contactId: '{{result.contact.id}}', scopes: [{ kind: 'all_invoices' }], expiresAt: '2026-09-30' } },
    idempotencyKey: `${seed}-rule`,
  });
  assert.equal(created.ok, true, JSON.stringify(created));
  // The STORED input is what a rule fires with; write the relabel into it directly, the shape any
  // stored row could have, so the refusal is proven at fire time and not only at save time.
  const ruleId = created.rule.ruleId;
  const stored = JSON.parse(w.deps.store.db.prepare('SELECT action_input FROM automation_rule WHERE id = ?').get(ruleId).action_input);
  w.deps.store.db.prepare('UPDATE automation_rule SET action_input = ? WHERE id = ?').run(JSON.stringify({ ...stored, ...extra }), ruleId);
  return ruleId;
}

const runsOf = (w, ruleId) =>
  w.deps.store.db.prepare('SELECT status, error_code, action_tool FROM automation_run WHERE rule_id = ? ORDER BY started_at, id').all(ruleId);

test('2. relabel: an automation rule whose stored input carries kind:"vendor" fails invalid_input and mints nothing', () => {
  const w = ruleWorld('rl-vendor');
  const ruleId = grantRule(w, { kind: 'vendor' }, 'rl-vendor');
  assert.equal(w.call('create_contact', { partyRole: 'both', name: 'Auslöser AG', idempotencyKey: 'rl-c' }).ok, true);
  assert.deepEqual(runsOf(w, ruleId), [{ status: 'failed', error_code: 'invalid_input', action_tool: 'portal_grant_create' }]);
  assert.equal(w.deps.store.db.prepare('SELECT COUNT(*) AS n FROM portal_grant').get().n, 0, 'the rule minted a grant');
  w.deps.store.close();

  // Control: the same rule without the relabel really reaches the verb, and mints a DRAFT.
  const c = ruleWorld('rl-plain');
  const plain = grantRule(c, {}, 'rl-plain');
  assert.equal(c.call('create_contact', { partyRole: 'customer', name: 'Auslöser AG', idempotencyKey: 'rl-c' }).ok, true);
  assert.deepEqual(runsOf(c, plain).map((r) => r.status), ['ok'], 'the control rule did not fire: the refusal above would be vacuous');
  const minted = c.deps.store.db.prepare('SELECT kind, sent_at, minted_draft FROM portal_grant').all();
  assert.deepEqual(minted.map((r) => ({ ...r })), [{ kind: 'customer', sent_at: null, minted_draft: 1 }]);
  c.deps.store.close();
});

// --- 3. smuggling ----------------------------------------------------------------------------------

test('3. smuggling: sentAt, sent_at, minted_draft:0 and status:"active" on a create still produce a dead draft', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  const call = callFor(deps, workspaceId);
  const contactId = customer(call);
  const g = call('portal_grant_create', {
    contactId,
    scopes: [{ kind: 'all_invoices' }],
    expiresAt: '2026-09-30',
    sentAt: '2026-07-01T00:00:00.000Z',
    sent_at: '2026-07-01T00:00:00.000Z',
    minted_draft: 0,
    mintedDraft: 0,
    status: 'active',
    revoked_at: null,
    idempotencyKey: k('g'),
  });
  assert.equal(g.ok, true, JSON.stringify(g));
  assert.equal(g.grant.status, 'draft');
  const row = grantRow(deps.store.db, g.grantId);
  assert.equal(row.sent_at, null, 'a caller-supplied sent_at reached the row');
  assert.equal(row.minted_draft, 1, 'a caller-supplied minted_draft reached the row');
  assert.equal(tokenCall(deps, 'portal_resolve', { token: g.tokenOnce }).error, 'grant_denied');
  deps.store.close();
});

test('3. smuggling: vendor_portal_grant {kind:"customer"} still mints a vendor grant, live when granted', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  const call = callFor(deps, workspaceId);
  const v = supplier(call);
  const g = call('vendor_portal_grant', { contactId: v, expiresAt: '2026-09-30', kind: 'customer', sent_at: null, minted_draft: 0, idempotencyKey: k('vg') });
  assert.equal(g.ok, true, JSON.stringify(g));
  const row = grantRow(deps.store.db, g.grantId);
  assert.equal(row.kind, 'vendor', 'the vendor door minted another kind');
  assert.equal(row.minted_draft, 1);
  assert.equal(row.sent_at, AT, 'owner decision 2: a supplier link is handed over when it is granted');
  assert.equal(g.grant.status, 'active');
  assert.equal(call('vendor_portal_pos', { grantToken: g.tokenOnce }).ok, true, 'a vendor grant must read at once');
  // A customer contact cannot be relabelled through the vendor door either (the supplier fence).
  const cust = customer(call);
  assert.equal(call('vendor_portal_grant', { contactId: cust, expiresAt: '2026-09-30', idempotencyKey: k('vg') }).error, 'contact_not_found');
  deps.store.close();
});

// --- 4. old shape on a live book -------------------------------------------------------------------

/**
 * Four grants as the pre-D157 engine wrote them: no `minted_draft` column exists, a customer grant was
 * live from creation, and a vendor grant never carried a `sent_at`.
 */
const OLD_ROWS = [
  { id: 'pg_old_vendor', who: 'vendor', kind: 'vendor', scopes: '[{"kind":"pos.read"},{"kind":"remittance.read"}]', expires: '2026-09-30', revoked: null, live: true, status: 'active' },
  { id: 'pg_old_customer', who: 'customer', kind: 'customer', scopes: '[{"kind":"all_invoices"}]', expires: '2026-09-30', revoked: null, live: true, status: 'active' },
  { id: 'pg_old_revoked', who: 'customer', kind: 'customer', scopes: '[{"kind":"all_invoices"}]', expires: '2026-09-30', revoked: '2026-07-01T00:00:00.000Z', live: false, status: 'revoked' },
  { id: 'pg_old_expired', who: 'vendor', kind: 'vendor', scopes: '[{"kind":"pos.read"}]', expires: '2026-07-01', revoked: null, live: false, status: 'expired' },
];
const tokenOf = (id) => `old-token-${id}`.padEnd(64, '0');

/** Insert OLD_ROWS through the old INSERT shape (no minted_draft named, none exists to name). */
function insertOldRows(db, workspaceId, contacts) {
  const cols = db.pragma('table_info(portal_grant)').map((c) => c.name);
  assert.equal(cols.includes('minted_draft'), false, 'premise: the table is old-shaped');
  const insert = db.prepare(
    `INSERT INTO portal_grant (id, workspace_id, contact_id, kind, token_hash, scopes, expires_at, sent_at, revoked_at,
       last_resolved_at, local_artifact_json, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, '{}', 'studio', '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z')`,
  );
  for (const r of OLD_ROWS) insert.run(r.id, workspaceId, contacts[r.who], r.kind, sha256(tokenOf(r.id)), r.scopes, r.expires, r.revoked);
}

/**
 * Assert every OLD_ROWS outcome against a workspace that holds them (status, and every token path).
 * `restored`: the rows came back through a restore, where (D161.2) a grant that was live lands as a
 * draft awaiting a new hand-over (the marker written 1), and a revoked or expired one stays dead.
 */
function assertOldOutcomes(deps, workspaceId, idOf = (id) => id, restored = false) {
  const call = callFor(deps, workspaceId);
  const listed = call('portal_grant_list', {});
  assert.equal(listed.ok, true, JSON.stringify(listed));
  for (const r of OLD_ROWS) {
    const id = idOf(r.id);
    const row = grantRow(deps.store.db, id);
    const live = restored ? false : r.live;
    const status = restored && r.status === 'active' ? 'draft' : r.status;
    if (restored) {
      assert.equal(row.minted_draft, r.revoked === null ? 1 : 0, `${r.id}: a restored grant that is not revoked is a draft again`);
    } else {
      assert.equal(row.minted_draft, 0, `${r.id}: the column default, never a value someone wrote`);
    }
    assert.equal(listed.grants.find((g) => g.id === id).status, status, `${r.id}: status`);
    const token = tokenOf(r.id);
    if (r.kind === 'customer') {
      const res = tokenCall(deps, 'portal_resolve', { token });
      assert.equal(res.ok, live, `${r.id}: portal_resolve ${JSON.stringify(res)}`);
    } else {
      const res = call('vendor_portal_pos', { grantToken: token });
      assert.equal(res.ok, live, `${r.id}: vendor_portal_pos ${JSON.stringify(res)}`);
    }
  }
}

test('4. old shape on a live book: the store widens portal_grant on open; old vendor and customer grants stay live until expiry, revoked and expired stay dead', () => {
  const dir = mkdtempSync(join(tmpdir(), 'd157-old-'));
  try {
    const file = join(dir, 'till.db');
    const first = { store: new SqliteStore({ location: file, clock: fixedClock(AT) }), clock: fixedClock(AT), ids: sequenceIdGen(), actor: 'studio' };
    const { workspaceId } = mintWorkspace(first);
    const call = callFor(first, workspaceId);
    const contacts = { customer: customer(call), vendor: supplier(call) };
    first.store.close();

    // Take the file back to the pre-D157 shape, then write the grants the old engine wrote.
    const raw = new Database(file);
    raw.exec('ALTER TABLE portal_grant DROP COLUMN minted_draft');
    insertOldRows(raw, workspaceId, contacts);
    raw.close();

    // Open it the way TILL opens a book: ADDITIVE_COLUMNS widens the table, and nothing writes a value.
    const reopened = { store: new SqliteStore({ location: file, clock: fixedClock(AT) }), clock: fixedClock(AT), ids: systemIdGen, actor: 'studio' };
    assert.ok(reopened.store.db.pragma('table_info(portal_grant)').some((c) => c.name === 'minted_draft'), 'the store did not widen the table');
    assertOldOutcomes(reopened, workspaceId);

    // A grant minted AFTER the upgrade, in the same book, is a draft.
    const fresh = callFor(reopened, workspaceId)('portal_grant_create', { contactId: contacts.customer, scopes: [{ kind: 'all_invoices' }], expiresAt: '2026-09-30', idempotencyKey: 'after-upgrade' });
    assert.equal(fresh.grant.status, 'draft');
    assert.equal(tokenCall(reopened, 'portal_resolve', { token: fresh.tokenOnce }).error, 'grant_denied');
    reopened.store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- 5. restore ------------------------------------------------------------------------------------

/** Take the backup's snapshot back to the pre-D157 shape and re-seal its manifest the way it was written. */
function makeSnapshotOldShaped(artifactRef) {
  const sqlitePath = join(artifactRef, 'data.sqlite');
  const snap = new Database(sqlitePath);
  snap.exec('ALTER TABLE portal_grant DROP COLUMN minted_draft');
  snap.exec('VACUUM');
  const shape = schemaShapeOf(snap);
  assert.equal(snap.pragma('table_info(portal_grant)').some((c) => c.name === 'minted_draft'), false);
  // D157 bumped no generation, so the old shape is the CURRENT generation without the column (9 when
  // D157 landed, 10 since D163's contact-terms migration).
  assert.equal(snap.pragma('user_version', { simple: true }), SCHEMA_GENERATION, 'premise: a current-generation snapshot');
  snap.close();
  const manifestPath = join(artifactRef, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const bytes = readFileSync(sqlitePath);
  manifest.files['data.sqlite'] = { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: statSync(sqlitePath).size };
  if (manifest.schemaShape !== undefined) manifest.schemaShape = shape;
  if (manifest.schemaFingerprint !== undefined) manifest.schemaFingerprint = schemaFingerprint(shape);
  assert.equal(manifest.schemaVersion, SCHEMA_GENERATION);
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
}

/** A book (with a backup dir) holding OLD_ROWS-shaped grants, as the pre-D157 engine left them. */
function backupWorld(dir) {
  const deps = { ...freshDeps(), actor: 'studio', backupDir: join(dir, 'b') };
  const { workspaceId } = mintWorkspace(deps);
  const call = callFor(deps, workspaceId);
  const contacts = { customer: customer(call), vendor: supplier(call) };
  return { deps, workspaceId, call, contacts };
}

test('5. restore: an old-shaped current-generation snapshot restores with no link live (D161.2); a new-shape draft stays a draft; beside the original the copy lands revoked', () => {
  const dir = mkdtempSync(join(tmpdir(), 'd157-restore-'));
  try {
    const w = backupWorld(dir);
    // The live book is new-shaped, so the OLD rows enter it without naming minted_draft (as the old
    // engine did); the snapshot below then loses the column entirely, so its value cannot travel.
    const db = w.deps.store.db;
    const insert = db.prepare(
      `INSERT INTO portal_grant (id, workspace_id, contact_id, kind, token_hash, scopes, expires_at, sent_at, revoked_at,
         last_resolved_at, local_artifact_json, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, '{}', 'studio', '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z')`,
    );
    for (const r of OLD_ROWS) insert.run(r.id, w.workspaceId, w.contacts[r.who], r.kind, sha256(tokenOf(r.id)), r.scopes, r.expires, r.revoked);

    const bkp = w.call('create_backup', { idempotencyKey: 'bk-old' });
    assert.equal(bkp.ok, true, JSON.stringify(bkp));
    makeSnapshotOldShaped(bkp.artifactRef);
    assert.equal(getAction('verify_backup').run(w.deps, { source: bkp.artifactRef }).ok, true, 'the old-shaped artifact verifies');

    // Into an EMPTY book: the restored ids are new, the token hashes are kept.
    const empty = { ...freshDeps(), actor: 'studio', backupDir: join(dir, 'b2') };
    const restored = getAction('restore_backup').run(empty, { source: bkp.artifactRef, newWorkspaceName: 'Neu AG', confirmed: true });
    assert.equal(restored.ok, true, JSON.stringify(restored));
    const idByHash = (id) => empty.store.db.prepare('SELECT id FROM portal_grant WHERE workspace_id = ? AND token_hash = ?').get(restored.workspaceId, sha256(tokenOf(id))).id;
    assertOldOutcomes(empty, restored.workspaceId, idByHash, true);
    empty.store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const dir2 = mkdtempSync(join(tmpdir(), 'd157-restore-'));
  try {
    const w = backupWorld(dir2);
    const draft = w.call('portal_grant_create', { contactId: w.contacts.customer, scopes: [{ kind: 'all_invoices' }], expiresAt: '2026-09-30', idempotencyKey: 'd' });
    const live = w.call('portal_grant_create', { contactId: w.contacts.customer, scopes: [{ kind: 'all_invoices' }], expiresAt: '2026-09-30', idempotencyKey: 'l' });
    assert.equal(w.call('portal_grant_send', { grantId: live.grantId, confirmed: true, idempotencyKey: 'ls' }).ok, true);
    const bkp = w.call('create_backup', { idempotencyKey: 'bk-new' });
    assert.equal(bkp.ok, true, JSON.stringify(bkp));

    // New shape into an empty book: the draft stays a draft and its token stays dead. The live link
    // lands a draft too (D161.2: the backup cannot know of a revocation made after it), and opens
    // again only when a person hands it over again.
    const empty = { ...freshDeps(), actor: 'studio', backupDir: join(dir2, 'b2') };
    const restored = getAction('restore_backup').run(empty, { source: bkp.artifactRef, newWorkspaceName: 'Neu AG', confirmed: true });
    assert.equal(restored.ok, true, JSON.stringify(restored));
    const rows = empty.store.db.prepare('SELECT * FROM portal_grant WHERE workspace_id = ? ORDER BY sent_at IS NULL').all(restored.workspaceId);
    assert.deepEqual(rows.map((r) => [r.minted_draft, r.sent_at === null]), [[1, true], [1, true]]);
    assert.equal(tokenCall(empty, 'portal_resolve', { token: draft.tokenOnce }).error, 'grant_denied', 'a restored draft opened');
    assert.equal(tokenCall(empty, 'portal_resolve', { token: live.tokenOnce }).error, 'grant_denied', 'a restored link opened before a new hand-over');
    const statuses = callFor(empty, restored.workspaceId)('portal_grant_list', {}).grants.map((g) => g.status).sort();
    assert.deepEqual(statuses, ['draft', 'draft']);
    empty.store.close();

    // Beside the original: the copy lands revoked, the original's link keeps working.
    const beside = getAction('restore_backup').run(w.deps, { source: bkp.artifactRef, newWorkspaceName: 'Kopie AG', confirmed: true });
    assert.equal(beside.ok, true, JSON.stringify(beside));
    const copies = callFor(w.deps, beside.workspaceId)('portal_grant_list', {}).grants;
    assert.deepEqual(copies.map((g) => g.status), ['revoked', 'revoked']);
    assert.equal(tokenCall(w.deps, 'portal_resolve', { token: live.tokenOnce }).ok, true, 'the original link died');
    w.deps.store.close();
  } finally {
    rmSync(dir2, { recursive: true, force: true });
  }
});

// --- 6. status and liveness agree ------------------------------------------------------------------

test('6. status === "active" iff isGrantLive, across kind x marker x sent_at x revoked x expired', () => {
  let cases = 0;
  for (const kind of ['customer', 'vendor']) {
    for (const minted_draft of [0, 1]) {
      for (const sent_at of [null, '2026-07-10T00:00:00.000Z']) {
        for (const revoked_at of [null, '2026-07-12T00:00:00.000Z']) {
          for (const expires_at of ['2026-07-01', TODAY, '2026-09-30']) {
            const row = {
              id: 'pg_x', workspace_id: 'ws', contact_id: 'ct', kind, token_hash: 'h', scopes: '[]', expires_at,
              sent_at, revoked_at, minted_draft, last_resolved_at: null, local_artifact_json: '{}',
              created_by: 'studio', created_at: AT, updated_at: AT,
            };
            const live = isGrantLive(row, TODAY);
            const status = mapGrant(row, TODAY).status;
            const label = JSON.stringify({ kind, minted_draft, sent_at, revoked_at, expires_at });
            assert.equal(status === 'active', live, `${label}: status ${status} but live ${live}`);
            // And the rule itself, spelled out: a D157 grant needs the hand-over, an older one does not.
            const expected = revoked_at === null && expires_at >= TODAY && (sent_at !== null || minted_draft === 0);
            assert.equal(live, expected, `${label}: liveness`);
            if (revoked_at === null && expires_at >= TODAY && !expected) assert.equal(status, 'draft', `${label}: a dead, unexpired, unrevoked grant is a draft`);
            cases += 1;
          }
        }
      }
    }
  }
  assert.equal(cases, 48);
});

// --- 7. structural ---------------------------------------------------------------------------------

function sourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    return e.isDirectory() ? sourceFiles(p) : /\.(ts|mts|js|mjs)$/.test(e.name) ? [p] : [];
  });
}

test('7. structural: every INSERT INTO portal_grant under src/ names minted_draft (the DEFAULT 0 fails open)', () => {
  const pattern = /INSERT\s+(?:OR\s+\w+\s+)?INTO\s+["`]?portal_grant["`]?\s*\(([^)]*)\)/g;
  const found = [];
  for (const file of sourceFiles(join(ROOT, 'src'))) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(pattern)) found.push({ file: file.slice(ROOT.length + 1), columns: m[1] });
    // A bare mention with no column list would dodge the pattern above: refuse it outright.
    for (const m of text.matchAll(/INSERT\s+(?:OR\s+\w+\s+)?INTO\s+["`]?portal_grant\b(?!["`]?\s*\()/g)) {
      assert.fail(`${file}: an INSERT INTO portal_grant without an explicit column list (${m[0]})`);
    }
  }
  assert.ok(found.length >= 1, 'the probe found no INSERT at all: it is vacuous');
  for (const { file, columns } of found) assert.match(columns, /\bminted_draft\b/, `${file}: an INSERT INTO portal_grant that leaves minted_draft to its DEFAULT 0 (live)`);
});

test('7. structural: the portal barrel does not export createVendorGrant', () => {
  assert.equal('createVendorGrant' in portalBarrel, false);
  const barrel = readFileSync(join(ROOT, 'src/core/portal/index.ts'), 'utf8');
  assert.doesNotMatch(barrel, /createVendorGrant/);
  assert.equal(typeof portalBarrel.createGrant, 'function');
});

// --- 8. idempotency and §H-TENANT ------------------------------------------------------------------

test('8. a create replay is still a draft, a second send keeps the first sent_at, and another workspace cannot send', () => {
  let now = AT;
  const clock = { now: () => now };
  const deps = { store: new SqliteStore({ clock }), clock, ids: sequenceIdGen(), actor: 'studio' };
  const A = mintWorkspace(deps, 'A GmbH', 'wsA').workspaceId;
  const B = mintWorkspace(deps, 'B GmbH', 'wsB').workspaceId;
  const callA = callFor(deps, A);
  const callB = callFor(deps, B);
  const contactId = customer(callA);

  const input = { contactId, scopes: [{ kind: 'all_invoices' }], expiresAt: '2026-09-30', idempotencyKey: 'same-key' };
  const first = callA('portal_grant_create', input);
  const count = () => deps.store.db.prepare('SELECT COUNT(*) AS n FROM portal_grant').get().n;
  const replay = callA('portal_grant_create', input);
  assert.equal(replay.grantId, first.grantId);
  assert.equal(replay.grant.status, 'draft');
  assert.equal(count(), 1, 'a replay minted a second grant');
  assert.equal(tokenCall(deps, 'portal_resolve', { token: replay.tokenOnce }).error, 'grant_denied');

  // §H-TENANT: B cannot send A's grant, and A's grant stays a dead draft.
  const foreign = callB('portal_grant_send', { grantId: first.grantId, confirmed: true, idempotencyKey: 'b-send' });
  assert.equal(foreign.ok, false);
  assert.equal(foreign.error, 'not_found');
  assert.equal(grantRow(deps.store.db, first.grantId).sent_at, null);
  assert.equal(tokenCall(deps, 'portal_resolve', { token: first.tokenOnce }).error, 'grant_denied');

  const sent = callA('portal_grant_send', { grantId: first.grantId, confirmed: true, idempotencyKey: 's1' });
  assert.equal(sent.grant.sentAt, AT);
  now = '2026-07-20T00:00:00.000Z';
  const again = callA('portal_grant_send', { grantId: first.grantId, confirmed: true, idempotencyKey: 's2' });
  assert.equal(again.ok, true);
  assert.equal(again.grant.sentAt, AT, 'a second send moved the first sent_at');
  // The replay of the create, after the send, mints nothing and does not turn the grant back.
  callA('portal_grant_create', input);
  assert.equal(count(), 1);
  assert.equal(tokenCall(deps, 'portal_resolve', { token: first.tokenOnce }).ok, true);
  deps.store.close();
});

// --- critic F1: a vendor grant can never carry customer scopes, and no token path crosses kinds ----

/** A contact that is both customer and supplier, with a sent quote: the critic's F1 world. */
function bothWorld() {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  const call = callFor(deps, workspaceId);
  const c = call('create_contact', { partyRole: 'both', name: 'Beides AG', idempotencyKey: k('b') });
  assert.equal(c.ok, true, JSON.stringify(c));
  const quoteId = sentQuote(call, c.contact.id);
  return { deps, workspaceId, call, contactId: c.contact.id, quoteId };
}

test('critic F1: vendor_portal_grant with customer scopes is invalid_scope and writes zero rows', () => {
  const w = bothWorld();
  const before = businessRows(w.deps.store.db);
  for (const scopes of [
    [{ kind: 'all_invoices' }, { kind: 'quote', id: w.quoteId }],
    [{ kind: 'pos.read' }, { kind: 'quote', id: w.quoteId }],
    [{ kind: 'all_invoices' }],
    [{ kind: 'nonsense' }],
  ]) {
    const r = w.call('vendor_portal_grant', { contactId: w.contactId, expiresAt: '2026-09-30', scopes, idempotencyKey: k('vg') });
    assert.equal(r.ok, false, `a vendor grant with ${JSON.stringify(scopes)} was minted`);
    assert.equal(r.error, 'invalid_scope');
  }
  assert.deepEqual(businessRows(w.deps.store.db), before, 'a refused vendor grant wrote a row');
  // The vendor set itself still mints.
  assert.equal(w.call('vendor_portal_grant', { contactId: w.contactId, expiresAt: '2026-09-30', scopes: [{ kind: 'pos.read' }], idempotencyKey: k('vg') }).ok, true);
  w.deps.store.close();
});

test('critic F1: a live VENDOR token never reaches portal_resolve or portal_quote_accept, even carrying customer scopes', () => {
  const w = bothWorld();
  const g = w.call('vendor_portal_grant', { contactId: w.contactId, expiresAt: '2026-09-30', idempotencyKey: k('vg') });
  assert.equal(g.grant.status, 'active');
  // A row the fence above would refuse today (an older engine, or a hand-edited book): the token
  // paths must deny it on its kind alone.
  w.deps.store.db
    .prepare('UPDATE portal_grant SET scopes = ? WHERE id = ?')
    .run(JSON.stringify([{ kind: 'all_invoices' }, { kind: 'quote', id: w.quoteId }]), g.grantId);
  const before = businessRows(w.deps.store.db);
  assert.deepEqual(tokenCall(w.deps, 'portal_resolve', { token: g.tokenOnce }), { ok: false, error: 'grant_denied' });
  assert.deepEqual(tokenCall(w.deps, 'portal_quote_accept', { token: g.tokenOnce, quoteId: w.quoteId, idempotencyKey: k('pa') }), { ok: false, error: 'grant_denied' });
  assert.deepEqual(businessRows(w.deps.store.db), before, 'a denied vendor token wrote a row');
  assert.equal(w.call('quotes_get', { quoteId: w.quoteId }).document.status, 'sent', 'a vendor token accepted a quote');
  assert.equal(denies(w.deps.store.db, g.grantId), 2, 'both attempts are audited as denials');
  w.deps.store.close();
});

test('critic F1 reverse: a live CUSTOMER token never reaches the vendor reads', () => {
  const w = bothWorld();
  const g = w.call('portal_grant_create', { contactId: w.contactId, scopes: [{ kind: 'all_invoices' }], expiresAt: '2026-09-30', idempotencyKey: k('g') });
  assert.equal(w.call('portal_grant_send', { grantId: g.grantId, confirmed: true, idempotencyKey: k('s') }).ok, true);
  assert.equal(tokenCall(w.deps, 'portal_resolve', { token: g.tokenOnce }).ok, true, 'premise: the customer link is live');
  // Even with the vendor scopes written onto it, its kind keeps it off the vendor reads.
  w.deps.store.db.prepare('UPDATE portal_grant SET scopes = ? WHERE id = ?').run('[{"kind":"pos.read"},{"kind":"remittance.read"}]', g.grantId);
  assert.equal(w.call('vendor_portal_pos', { grantToken: g.tokenOnce }).error, 'grant_invalid');
  assert.equal(w.call('vendor_portal_remittances', { grantToken: g.tokenOnce }).error, 'grant_invalid');
  w.deps.store.close();
});

// --- critic F2: each door replays only its own kind ---------------------------------------------

test('critic F2: a customer create keyed with the vendor door\'s prefixed key never returns the vendor grant or its token', () => {
  const w = bothWorld();
  const vendor = w.call('vendor_portal_grant', { contactId: w.contactId, expiresAt: '2026-09-30', idempotencyKey: 'K1' });
  assert.equal(vendor.ok, true, JSON.stringify(vendor));
  const probe = w.call('portal_grant_create', { contactId: w.contactId, scopes: [{ kind: 'all_invoices' }], expiresAt: '2026-09-30', idempotencyKey: '["vendor","K1"]' });
  assert.notEqual(probe.grantId, vendor.grantId, 'the customer door replayed the vendor grant');
  assert.notEqual(probe.tokenOnce, vendor.tokenOnce, 'the customer door handed out the vendor token');
  assert.equal(probe.ok, true, JSON.stringify(probe));
  assert.equal(probe.grant.kind, 'customer');
  assert.equal(probe.grant.status, 'draft');
  // And the vendor door's own replay is untouched.
  assert.equal(w.call('vendor_portal_grant', { contactId: w.contactId, expiresAt: '2026-09-30', idempotencyKey: 'K1' }).grantId, vendor.grantId);
  w.deps.store.close();
});

test('critic F2: a replay stored under the SHARED verb (before the split) is handed out only to its own kind', () => {
  const w = bothWorld();
  // A vendor result stored the way the engine stored it before the split: shared verb, prefixed key.
  const vendor = w.call('vendor_portal_grant', { contactId: w.contactId, expiresAt: '2026-09-30', idempotencyKey: 'seed-v' });
  w.deps.store.rememberIdempotent(w.workspaceId, '["vendor","K2"]', 'portal_grant_create', () => vendor);
  const count = () => w.deps.store.db.prepare('SELECT COUNT(*) AS n FROM portal_grant').get().n;
  const rows = count();

  const asCustomer = w.call('portal_grant_create', { contactId: w.contactId, scopes: [{ kind: 'all_invoices' }], expiresAt: '2026-09-30', idempotencyKey: '["vendor","K2"]' });
  assert.equal(asCustomer.ok, false, 'the customer door handed out a stored vendor grant');
  assert.equal(asCustomer.error, 'idempotency_key_conflict');
  assert.equal(asCustomer.tokenOnce, undefined);
  assert.equal(count(), rows);
  // The vendor door still answers its own old replay (idempotency survives the split).
  assert.equal(w.call('vendor_portal_grant', { contactId: w.contactId, expiresAt: '2026-09-30', idempotencyKey: 'K2' }).grantId, vendor.grantId);
  assert.equal(count(), rows);

  // Reverse: a CUSTOMER result stored under the shared verb with a vendor-shaped key is never
  // replayed by the vendor door.
  const cust = w.call('portal_grant_create', { contactId: w.contactId, scopes: [{ kind: 'all_invoices' }], expiresAt: '2026-09-30', idempotencyKey: '["vendor","K3"]' });
  assert.equal(cust.ok, true, JSON.stringify(cust));
  const asVendor = w.call('vendor_portal_grant', { contactId: w.contactId, expiresAt: '2026-09-30', idempotencyKey: 'K3' });
  assert.equal(asVendor.ok, false, 'the vendor door replayed a customer grant');
  assert.equal(asVendor.error, 'idempotency_key_conflict');
  assert.equal(asVendor.tokenOnce, undefined);
  w.deps.store.close();
});
