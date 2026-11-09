/**
 * EVERY DENYLISTED VERB CARRIES ITS LEG TAGS, AND THE TAGS ARE THE SET (D156 point 3).
 *
 * `NOT_AUTOMATABLE` is the set the three G01 enforcement points read; `NOT_AUTOMATABLE_LEGS` is the
 * same population as data, tagged with the criterion legs (a) to (f) the module note argues. The agent
 * approval dial reads the tags (`test/agent/dial-covers-irreversible.test.mjs`: every leg (a) and (f)
 * write is governed or excluded in writing), so a verb added to the set without a tag would slip past
 * that coverage in silence. HOW IT BITES: add a verb to `NOT_AUTOMATABLE` alone and the first test
 * names it; tag a verb that is not denylisted and the same test names that.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  NOT_AUTOMATABLE,
  NOT_AUTOMATABLE_LEGS,
  DENYLIST_LEGS,
  denylistVerbsOnLeg,
} from '../../dist/core/automation/denylist.js';
import { ACTIONS } from '../../dist/api/registry.js';

test('the leg tags cover exactly the denylist: no untagged verb, no stray tag', () => {
  const tagged = Object.keys(NOT_AUTOMATABLE_LEGS).sort();
  const denied = [...NOT_AUTOMATABLE].sort();
  assert.deepEqual(
    denied.filter((v) => !tagged.includes(v)),
    [],
    'denylisted verbs without a leg tag in NOT_AUTOMATABLE_LEGS (src/core/automation/denylist.ts)',
  );
  assert.deepEqual(
    tagged.filter((v) => !NOT_AUTOMATABLE.has(v)),
    [],
    'leg tags for verbs that are not on the denylist',
  );
});

test('every verb has at least one known leg, and every tag is a registered write', () => {
  const writes = new Set(ACTIONS.filter((a) => a.kind === 'write').map((a) => a.name));
  for (const [verb, legs] of Object.entries(NOT_AUTOMATABLE_LEGS)) {
    assert.ok(legs.length > 0, `${verb}: at least one leg`);
    for (const leg of legs) assert.ok(DENYLIST_LEGS.includes(leg), `${verb}: '${leg}' is a known leg`);
    assert.equal(new Set(legs).size, legs.length, `${verb}: no repeated leg`);
    assert.ok(writes.has(verb), `${verb}: a registered write verb`);
  }
});

test('the legs read the way the module note argues them (spot checks on both ends)', () => {
  const a = denylistVerbsOnLeg('a');
  for (const verb of ['contacts_anonymise', 'contacts_merge', 'files_delete', 'price_lists_delete', 'close_year', 'env_delete', 'gl_archive_purge']) {
    assert.ok(a.includes(verb), `${verb} is leg (a): its effect cannot be undone by another verb`);
  }
  const f = denylistVerbsOnLeg('f');
  for (const verb of ['set_creditor_profile', 'update_bank_account', 'set_creditor_bank_profile']) {
    assert.ok(f.includes(verb), `${verb} is leg (f): it alters a payment destination`);
  }
  // Not every denied verb is irreversible: a membership change is (c), a stop is still (e).
  assert.ok(!a.includes('set_role'));
  assert.ok(!a.includes('disable_automation_rule'), 'not denylisted at all');
});
