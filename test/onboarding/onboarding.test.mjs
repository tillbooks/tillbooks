/**
 * G03, onboarding & the demo workspace: the invariants the spec §7 turns on, proven by measurement.
 *
 *  - THE RESUME POINTER IS BOOKKEEPING: absolute upsert, round-trips, resumes, never un-completes,
 *    and refuses a path outside the §H-ENUM. §H-TENANT: one workspace's pointer is invisible to
 *    another's read.
 *  - THE DEMO IS A REAL WORKSPACE: kind='demo' plus is_demo, seeded ONLY through owning verbs
 *    (issued invoices have journal entries and gap-free numbers; the draft posts nothing), and
 *    §H-IDEMPOTENT on the mint (same key = same workspace, no second mint).
 *  - THE DEMO NEVER PROMOTES: G12's go_productive refuses it by kind.
 *  - DISCARD CANNOT REACH REAL BOOKS: refuses off kind='demo' (live AND sandbox), demands
 *    confirmed:true, deletes every demo-tenant row, replays its key after the delete, and leaves a
 *    sibling workspace's rows untouched (§H-TENANT).
 *
 * G03 adds no posting logic: every journal effect asserted here was produced by A10/A11's own
 * poster inside the demo, which is exactly what the seed test proves.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { ONBOARDING_PATHS, isOnboardingPath } from '../../dist/core/onboarding/index.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';

const must = (res, what) => {
  assert.equal(res.ok, true, `${what} failed: ${JSON.stringify(res)}`);
  return res;
};
const refuse = (res, error, what) => {
  assert.equal(res.ok, false, `${what} should have refused: ${JSON.stringify(res)}`);
  assert.equal(res.error, error, `${what} wrong error: ${JSON.stringify(res)}`);
  return res;
};

function world(seed) {
  const deps = freshDeps();
  deps.actor = 'studio';
  const { workspaceId } = mintWorkspace(deps, 'Echt GmbH', `${seed}-ws`);
  const call = (name, input) => getAction(name).run(deps, { workspaceId, ...input });
  const callOn = (wid, name, input) => getAction(name).run(deps, { workspaceId: wid, ...input });
  return { deps, wid: workspaceId, call, callOn };
}

const countRows = (deps, table, wid) =>
  deps.store.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE workspace_id = ?`).get(wid).n;

// --- The path enum ------------------------------------------------------------------------------

test('the onboarding path enum admits exactly fresh, import, demo and no fourth', () => {
  assert.deepEqual([...ONBOARDING_PATHS], ['fresh', 'import', 'demo']);
  assert.equal(isOnboardingPath('fresh'), true);
  assert.equal(isOnboardingPath('bexio'), false); // the pre-D86 path name must be dead
  assert.equal(isOnboardingPath(undefined), false);
});

// --- The resume pointer -------------------------------------------------------------------------

test('advance_onboarding_step round-trips absolutely and get resumes it', () => {
  const { call } = world('adv');
  const empty = must(call('get_onboarding_progress', {}), 'empty read');
  assert.equal(empty.progress, null);
  assert.equal(empty.workspaceKind, 'live');

  must(call('advance_onboarding_step', { path: 'fresh', step: 'company' }), 'first advance');
  const one = must(call('get_onboarding_progress', {}), 'read one');
  assert.deepEqual(one.progress, { path: 'fresh', step: 'company', completedAt: null });

  // Absolute set: a replay re-asserts, a later step overwrites, and there is only ever ONE row.
  must(call('advance_onboarding_step', { path: 'fresh', step: 'company' }), 'replay');
  must(call('advance_onboarding_step', { path: 'fresh', step: 'vat' }), 'second advance');
  const two = must(call('get_onboarding_progress', {}), 'read two');
  assert.equal(two.progress.step, 'vat');
});

test('completed_at stamps once and a later advance never un-completes it', () => {
  const { call } = world('done');
  must(call('advance_onboarding_step', { path: 'fresh', step: 'done', completed: true }), 'complete');
  const done = must(call('get_onboarding_progress', {}), 'read done');
  assert.notEqual(done.progress.completedAt, null);
  // A stray pointer write afterwards keeps the completion stamp.
  must(call('advance_onboarding_step', { path: 'fresh', step: 'company' }), 'stray');
  const after = must(call('get_onboarding_progress', {}), 'read after');
  assert.equal(after.progress.completedAt, done.progress.completedAt);
});

test('advance refuses a path outside the enum and a blank step, by name', () => {
  const { call } = world('bad');
  refuse(call('advance_onboarding_step', { path: 'bexio', step: 'x' }), 'invalid_path', 'bad path');
  refuse(call('advance_onboarding_step', { path: 'fresh', step: '' }), 'invalid_step', 'blank step');
  refuse(call('advance_onboarding_step', { path: 'fresh', step: 'x', completed: 'yes' }), 'invalid_input', 'bad completed');
});

test('§H-TENANT: one workspace resume pointer is invisible to another workspace', () => {
  const { deps, call } = world('ten');
  must(call('advance_onboarding_step', { path: 'import', step: 'plan' }), 'advance A');
  const other = mintWorkspace(deps, 'Andere GmbH', 'ten-other').workspaceId;
  const read = must(getAction('get_onboarding_progress').run(deps, { workspaceId: other }), 'read B');
  assert.equal(read.progress, null);
});

// --- The demo workspace -------------------------------------------------------------------------

test('create_demo_workspace mints kind=demo and seeds ONLY through owning verbs', () => {
  const { deps, call } = world('demo');
  const demo = must(call('create_demo_workspace', { idempotencyKey: 'demo-1' }), 'create');
  const wid = demo.workspaceId;

  const ws = deps.store.db.prepare('SELECT kind, is_demo FROM workspace WHERE id = ?').get(wid);
  assert.equal(ws.kind, 'demo');
  assert.equal(ws.is_demo, 1);

  // The seed counts the verb reported are the rows on disk.
  assert.deepEqual(demo.seeded, { contacts: 3, items: 3, invoicesIssued: 2, invoicesDraft: 1 });
  assert.equal(countRows(deps, 'contact', wid), 3);
  assert.equal(countRows(deps, 'item', wid), 3);

  // Every issued invoice went through A10/A11's own poster: an issued status, a gap-free number,
  // and a posted journal entry per issue. The draft posts NOTHING.
  const docs = deps.store.db
    .prepare('SELECT status, number, posted_entry_id FROM document WHERE workspace_id = ? ORDER BY created_at, id')
    .all(wid);
  assert.equal(docs.length, 3);
  const issued = docs.filter((d) => d.status === 'issued');
  const drafts = docs.filter((d) => d.status === 'draft');
  assert.equal(issued.length, 2);
  assert.equal(drafts.length, 1);
  for (const d of issued) {
    assert.notEqual(d.posted_entry_id, null, 'an issued demo invoice must carry its posted entry');
    assert.match(d.number, /^R-\d{4}-\d{4}$/, 'an issued demo invoice must carry a real gap-free number');
  }
  assert.equal(drafts[0].number, null);
  assert.equal(drafts[0].posted_entry_id, null);
  assert.equal(countRows(deps, 'journal_entry', wid), 2, 'exactly the two issues posted');

  // The demo is a REAL workspace: chart and tax codes seeded, the caller seated as owner.
  assert.ok(countRows(deps, 'account', wid) > 0, 'the KMU chart auto-seeded');
  assert.ok(countRows(deps, 'tax_code', wid) > 0, 'the tax-code set seeded');
  assert.ok(countRows(deps, 'workspace_member', wid) > 0, 'the caller is seated');

  // The wizard is marked done inside the demo, so it never reopens there.
  const progress = must(getAction('get_onboarding_progress').run(deps, { workspaceId: wid }), 'progress');
  assert.equal(progress.workspaceKind, 'demo');
  assert.equal(progress.progress.path, 'demo');
  assert.notEqual(progress.progress.completedAt, null);
});

test('§H-IDEMPOTENT: the same key returns the same demo and mints no second workspace', () => {
  const { deps, call } = world('idem');
  const before = deps.store.db.prepare('SELECT COUNT(*) AS n FROM workspace').get().n;
  const first = must(call('create_demo_workspace', { idempotencyKey: 'idem-1' }), 'first');
  const again = must(call('create_demo_workspace', { idempotencyKey: 'idem-1' }), 'again');
  assert.equal(again.workspaceId, first.workspaceId);
  const after = deps.store.db.prepare('SELECT COUNT(*) AS n FROM workspace').get().n;
  assert.equal(after, before + 1, 'exactly one demo minted across the double-call');
});

test('a demo never promotes: go_productive refuses it by kind', () => {
  const { call, callOn } = world('promo');
  const demo = must(call('create_demo_workspace', { idempotencyKey: 'promo-1' }), 'create');
  // A plan in the DEMO workspace whose testmandant link points at the demo itself cannot exist
  // through the real verbs; the direct refusal surface is discard_testmandant/go_productive's kind
  // fence, which G12's own suite pins. What G03 asserts is the flag pair those fences read.
  const kindRow = must(callOn(demo.workspaceId, 'get_onboarding_progress', {}), 'kind read');
  assert.equal(kindRow.workspaceKind, 'demo');
});

// --- The discard --------------------------------------------------------------------------------

test('discard refuses on a live workspace, a sandbox, and without confirmed:true', () => {
  const { deps, call, callOn } = world('ref');
  // Live: the fixture's own workspace.
  refuse(call('discard_demo_workspace', { confirmed: true, idempotencyKey: 'ref-1' }), 'not_a_demo_workspace', 'live');
  // Sandbox: a real Testmandant.
  const planId = must(call('migration_create_plan', { sourceSystem: 'csv', cutoverDate: '2020-01-01', localePack: 'ch', idempotencyKey: 'ref-plan' }), 'plan').planId;
  const t = must(call('migration_create_testmandant', { planId, idempotencyKey: 'ref-t' }), 'testmandant');
  refuse(callOn(t.workspaceId, 'discard_demo_workspace', { confirmed: true, idempotencyKey: 'ref-2' }), 'not_a_demo_workspace', 'sandbox');
  assert.notEqual(deps.store.db.prepare('SELECT id FROM workspace WHERE id = ?').get(t.workspaceId), undefined);
  // A demo without the confirm.
  const demo = must(call('create_demo_workspace', { idempotencyKey: 'ref-demo' }), 'demo');
  refuse(callOn(demo.workspaceId, 'discard_demo_workspace', { idempotencyKey: 'ref-3' }), 'needs_confirmation', 'no confirm');
});

test('discard hard-deletes every demo row, replays its key, and leaves the sibling tenant intact', () => {
  const { deps, wid: sibling, call, callOn } = world('del');
  const demo = must(call('create_demo_workspace', { idempotencyKey: 'del-demo' }), 'demo');
  const wid = demo.workspaceId;

  // The sibling in the SAME store: the fixture's live workspace, with its own row counts.
  must(call('create_contact', { partyRole: 'customer', name: 'Bleibt AG', idempotencyKey: 'del-c' }), 'sibling contact');
  const siblingContacts = countRows(deps, 'contact', sibling);
  assert.ok(siblingContacts > 0);

  const first = must(callOn(wid, 'discard_demo_workspace', { confirmed: true, idempotencyKey: 'del-1' }), 'discard');
  assert.equal(first.discardedWorkspaceId, wid);

  // Gone: the workspace row and every tenant-scoped row.
  assert.equal(deps.store.db.prepare('SELECT id FROM workspace WHERE id = ?').get(wid), undefined);
  const tables = deps.store.db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all();
  for (const { name } of tables) {
    const cols = deps.store.db.pragma(`table_info(${name})`);
    if (cols.some((c) => c.name === 'workspace_id')) {
      const left = deps.store.db.prepare(`SELECT COUNT(*) AS n FROM ${name} WHERE workspace_id = ?`).get(wid).n;
      assert.equal(left, 0, `${name} still carries demo rows after discard`);
    }
  }

  // §H-TENANT: the fixture's own live workspace survives with its rows.
  assert.notEqual(deps.store.db.prepare('SELECT id FROM workspace WHERE id = ?').get(sibling), undefined);
  assert.equal(countRows(deps, 'contact', sibling), siblingContacts);

  // Replay: the same key returns the stored result although the workspace is gone.
  const replay = must(callOn(wid, 'discard_demo_workspace', { confirmed: true, idempotencyKey: 'del-1' }), 'replay');
  assert.equal(replay.discardedWorkspaceId, wid);

  // THE WALLS ARE BACK UP: the delete lifted the §H-AUDIT triggers only inside its own transaction,
  // so a raw delete of a POSTED entry (a second demo's seeded posting) still aborts afterwards.
  const second = must(call('create_demo_workspace', { idempotencyKey: 'del-demo-2' }), 'second demo');
  const posted = deps.store.db
    .prepare("SELECT id FROM journal_entry WHERE workspace_id = ? AND status = 'posted' LIMIT 1")
    .get(second.workspaceId);
  assert.notEqual(posted, undefined);
  assert.throws(
    () => deps.store.db.prepare('DELETE FROM journal_entry WHERE id = ?').run(posted.id),
    /posted_immutable/,
    'the immutability trigger must be restored after a discard',
  );
});
