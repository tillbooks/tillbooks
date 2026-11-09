/**
 * A34 tripwire 4, the DEFERRED-import-target safety test (the actual protection the spec's original
 * tripwire 4 only PROMISED). The G03 `journal_entry` ImportWizard target and its `use_wage_journal_post`
 * commit refusal were NOT built in this landing; `wage_journal_post` (self-contained, `fileRef`-driven)
 * is the real, governed door. This suite asserts the three safety facts that keep it the ONLY door, so
 * there is no post-free / P8-free path to a wage posting. It FAILS the moment any of them regresses.
 *
 *   (a) G03's import-target single source (the migration DATA_CLASSES registry) does NOT carry a
 *       `journal_entry` target. Adding one would open the ungoverned ImportWizard path the spec forbids.
 *   (b) The migration `payroll` data class is `commitBuilt:false`, owned by A34, money-path. Because
 *       `commitRoute` carries no `payroll` branch, a payroll commit can only ever fall through to
 *       `class_commit_unavailable`; and `set_scope` refuses to even create a payroll step
 *       (`not_in_first_scope`), so the migration harness cannot reach a wage posting at all.
 *   (c) `wage_journal_post` is the self-contained door and is GOVERNED: it needs the `post` capability
 *       and it is P8 preview-then-confirm (a dial-off call posts nothing). Complements (a)/(b): the real
 *       door exists and bites, and it is the only one.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DATA_CLASSES, dataClassDef } from '../../dist/core/migration/index.js';
import { wageJournalPost } from '../../dist/core/payroll/index.js';
import { getAction } from '../../dist/api/registry.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';
import { setup, capCtx, counts, wageLines } from './support.mjs';

const DATE = '2026-07-05';

test('A34 tripwire 4 (a): G03 import-target single source does NOT include a journal_entry target', () => {
  assert.equal(
    DATA_CLASSES.includes('journal_entry'),
    false,
    'a journal_entry import target reappeared in DATA_CLASSES: the ungoverned ImportWizard posting path the spec defers',
  );
  assert.equal(
    dataClassDef('journal_entry'),
    undefined,
    'the migration registry resolved a journal_entry class: nothing may route a wage journal through the generic import commit',
  );
});

test('A34 tripwire 4 (b): the migration payroll class is commitBuilt:false and unreachable as a posting path', () => {
  const def = dataClassDef('payroll');
  assert.ok(def, 'the payroll data class vanished from the migration registry');
  assert.equal(def.commitBuilt, false, 'payroll flipped to commitBuilt:true: a generic import commit could now post wages, bypassing wage_journal_post');
  assert.equal(def.commitVerb, 'wage_journal_post', 'payroll must route by NAME to the governed wage_journal_post verb, never a generic writer');
  assert.equal(def.owner, 'A34', 'the payroll class owner drifted');
  assert.equal(def.moneyPath, true, 'payroll stopped being money-path: the commit_migration + approval + backup gates would fall away');

  // End to end at the API: scoping payroll is refused as not-in-first-scope, so the migration harness
  // never even creates a payroll step, let alone commits one.
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  const call = (name, input) => getAction(name).run(deps, input);
  const plan = call('migration_create_plan', { workspaceId, sourceSystem: 'csv', cutoverDate: '2026-01-01', localePack: 'ch', idempotencyKey: 'dit-plan' });
  assert.equal(plan.ok, true, JSON.stringify(plan));
  const scope = call('migration_set_scope', { workspaceId, planId: plan.planId, classes: [{ dataClass: 'payroll', include: true }], idempotencyKey: 'dit-scope' });
  assert.equal(scope.ok, true, JSON.stringify(scope));
  assert.equal(scope.steps.length, 0, 'a payroll migration step was created: the deferred import path became reachable');
  const unavailable = scope.unavailable.find((u) => u.dataClass === 'payroll');
  assert.ok(unavailable, 'payroll was silently dropped from set_scope instead of named unavailable');
  assert.equal(unavailable.owner, 'A34');
  assert.equal(unavailable.reason, 'not_in_first_scope', 'payroll became first-scope: it would gain a commit step through the generic harness');
});

test('A34 tripwire 4 (c): wage_journal_post is the self-contained door and is GOVERNED (post capability + P8 confirm)', () => {
  // The `post` capability is required: without it, zero rows reach the ledger.
  const t1 = setup();
  const noPost = capCtx(t1, 'clerk', ['hr.read', 'hr.manage']);
  const before = counts(t1.store, t1.workspaceId);
  const denied = wageJournalPost(noPost, { lines: wageLines(), entryDate: DATE, confirm: true, idempotencyKey: 'dit-noperm' });
  assert.equal(denied.ok, false);
  assert.equal(denied.error, 'permission_denied');
  assert.equal(denied.capability, 'post', 'the wage journal must gate on the `post` capability, not manage_import alone');
  assert.deepEqual(counts(t1.store, t1.workspaceId), before, 'a post-less wage journal wrote rows');

  // P8: a dial-off call (no confirm) returns the preview and posts NOTHING.
  const t2 = setup();
  const baseline = counts(t2.store, t2.workspaceId);
  const preview = wageJournalPost(t2.ctx, { lines: wageLines(), entryDate: DATE, idempotencyKey: 'dit-p8' });
  assert.equal(preview.ok, true, JSON.stringify(preview));
  assert.ok(preview.preview, 'a dial-off wage_journal_post must return a preview');
  assert.equal(preview.postedEntryId, undefined, 'the dial-off preview posted an entry: P8 was bypassed');
  assert.deepEqual(counts(t2.store, t2.workspaceId), baseline, 'the P8 preview wrote rows');
});
