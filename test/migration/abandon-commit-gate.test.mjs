/**
 * US-G09.4: after any commit, abandoning a migration plan requires `commit_migration`.
 *
 * The tool description, docs/CONTRACT.md, the abandonPlan docstring and G09 all said so, while the
 * boundary (`actionCapabilities.ts`) asks only for `manage_import` and abandonPlan checked nothing. The
 * check now sits in abandonPlan before the memo, in discard's `anyCommitted` shape, so a refusal
 * writes nothing; and an agent's drafted abandon replayed by an approver without the right is refused.
 *
 * Synthetic data only: invented names.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { handleRest } from '../../dist/api/rest.js';
import { makeContext } from '../../dist/core/context.js';
import { ledgerPorts } from '../../dist/core/ledger/index.js';
import { abandonPlan } from '../../dist/core/migration/index.js';
import { err, ok } from '../../dist/core/result.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';

const must = (res, what) => {
  assert.equal(res.ok, true, `${what} failed: ${JSON.stringify(res)}`);
  return res;
};

/** A plan with one COMMITTED step (set on the row: the state the check reads), driven by studio. */
function world(seed) {
  const deps = freshDeps();
  deps.actor = 'studio';
  const { workspaceId } = mintWorkspace(deps, 'Abbruch GmbH', `${seed}-ws`);
  const call = (name, input, actor = 'studio') => getAction(name).run({ ...deps, actor }, { workspaceId, ...input });
  const planId = must(call('migration_create_plan', { sourceSystem: 'csv', cutoverDate: '2020-01-01', localePack: 'ch', idempotencyKey: `${seed}-plan` }), 'plan').planId;
  must(call('migration_set_scope', { planId, classes: [{ dataClass: 'contacts', include: true }], idempotencyKey: `${seed}-scope` }), 'scope');
  const changed = deps.store.db.prepare("UPDATE migration_step SET status = 'committed' WHERE plan_id = ?").run(planId).changes;
  assert.ok(changed > 0, 'the precondition: a committed step');
  return { deps, workspaceId, call, planId };
}

const statusOf = (w) => w.deps.store.db.prepare('SELECT status FROM migration_plan WHERE id = ?').get(w.planId).status;
const memoRows = (w, key) =>
  w.deps.store.db.prepare('SELECT COUNT(*) AS n FROM idempotency WHERE workspace_id = ? AND key = ?').get(w.workspaceId, key)?.n ?? 0;

function ctxFor(w, capabilities) {
  return makeContext(w.deps.store, {
    workspaceId: w.workspaceId,
    actor: 'studio',
    clock: w.deps.clock,
    ids: w.deps.ids,
    ...(capabilities !== undefined ? { capabilities } : {}),
    ...ledgerPorts({ store: w.deps.store, workspaceId: w.workspaceId, ids: w.deps.ids }),
  });
}

const withoutCommitMigration = {
  assert: (capability) => (capability === 'commit_migration' ? err('permission_denied', { capability }) : ok({})),
};

test('after a commit, abandon without commit_migration is refused and writes nothing; granted, the same call succeeds', () => {
  const w = world('gate');
  const before = statusOf(w);
  const changesBefore = w.deps.store.db.prepare('SELECT total_changes() AS n').get().n;
  const denied = abandonPlan(ctxFor(w, withoutCommitMigration), { planId: w.planId, confirmed: true, idempotencyKey: 'gate-1' });
  assert.deepEqual([denied.ok, denied.error, denied.capability], [false, 'permission_denied', 'commit_migration'], JSON.stringify(denied));
  assert.equal(statusOf(w), before, 'the plan is not abandoned');
  assert.equal(w.deps.store.db.prepare('SELECT total_changes() AS n').get().n, changesBefore, 'not one row written, the key not memoised');

  // The SAME key, now with the right: the refusal burned nothing, so it runs.
  const granted = abandonPlan(ctxFor(w, undefined), { planId: w.planId, confirmed: true, idempotencyKey: 'gate-1' });
  assert.equal(granted.ok, true, JSON.stringify(granted));
  assert.equal(statusOf(w), 'abandoned');
  w.deps.store.close();
});

test('before any commit, manage_import alone abandons (the escalation is after-commit only)', () => {
  const w = world('pre');
  w.deps.store.db.prepare("UPDATE migration_step SET status = 'mapped' WHERE plan_id = ?").run(w.planId);
  must(abandonPlan(ctxFor(w, withoutCommitMigration), { planId: w.planId, confirmed: true, idempotencyKey: 'pre-1' }), 'abandon');
  assert.equal(statusOf(w), 'abandoned');
  w.deps.store.close();
});

test('an agent\'s drafted abandon, replayed by an approver who lacks commit_migration, is refused and nothing changes', () => {
  const w = world('rep');
  // The D50 flip seats both actors as owners; then the approver's own seat is narrowed to a custom
  // role that may approve drafts and work the migration, but not commit it.
  must(w.call('invite_member', { email: 'rep@muster.ch', role: 'bookkeeper', idempotencyKey: 'rep-inv' }), 'invite');
  const role = must(
    w.call('define_role', { name: 'Freigabe ohne Übernahme', capabilities: ['manage_agent_dial', 'manage_import', 'read_books'], idempotencyKey: 'rep-role' }),
    'define_role',
  );
  const drafted = handleRest('migration_abandon_plan', { workspaceId: w.workspaceId, planId: w.planId, confirmed: true, idempotencyKey: 'rep-ab' }, { ...w.deps, actor: 'agent' }).body;
  assert.equal(drafted.drafted, true, JSON.stringify(drafted));
  assert.equal(drafted.dialCapability, 'erase', 'abandoning deletes the Testmandant: governed beside discard_testmandant');

  const seat = must(w.call('list_members', {}), 'list_members').members.find((m) => m.actorId === 'studio');
  must(w.call('set_role', { memberId: seat.memberId, role: role.roleId }), 'set_role');

  const approved = w.call('approve_drafted_action', { actionId: drafted.actionId });
  assert.deepEqual([approved.ok, approved.error, approved.capability], [false, 'permission_denied', 'commit_migration'], JSON.stringify(approved));
  assert.notEqual(statusOf(w), 'abandoned', 'the plan is not abandoned');
  assert.equal(
    w.deps.store.db.prepare('SELECT status FROM agent_action WHERE id = ?').get(drafted.actionId).status,
    'pending',
    'the Vorschlag stays pending for someone who holds the right',
  );
  assert.equal(memoRows(w, 'rep-ab'), 0, 'the replay memoised nothing under the drafted key');
  w.deps.store.close();
});
