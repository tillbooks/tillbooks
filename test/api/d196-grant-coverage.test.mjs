// @ts-nocheck
/**
 * D196 (owner, after three critic FAILs on a broad reach and a paper critic on the re-cut): THE GRANT
 * APPROVES BANK DECISIONS ONLY. The approvable set is pinned here, so a widening is a deliberate, reviewed
 * edit (one verb at a time, each with its own critic review of its inputs and book-state effects), never a
 * side effect of another change.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { GRANT_APPROVABLE_TOOLS, GRANT_EXCLUDED_DIAL_FAMILIES } from '../../dist/core/agent/decisionGrant.js';
import { DIAL_CAPABILITY_FOR_ACTION } from '../../dist/core/agent/dialMap.js';
import { getAction } from '../../dist/api/registry.js';

test('the approvable set is exactly the reviewed bank decisions', () => {
  assert.deepEqual([...GRANT_APPROVABLE_TOOLS].sort(), ['book_bank_line', 'confirm_match', 'ignore_bank_line', 'set_bank_standard']);
});

test('every approvable verb is a registered, dial-governed write outside the excluded families by name', () => {
  for (const v of GRANT_APPROVABLE_TOOLS) {
    const action = getAction(v);
    assert.ok(action !== undefined && action.kind === 'write', `${v} is a registered write`);
    const family = DIAL_CAPABILITY_FOR_ACTION[v];
    if (family !== undefined) assert.ok(!GRANT_EXCLUDED_DIAL_FAMILIES.has(family), `${v} is not in an excluded family`);
  }
});

test('the verbs the critics found standing stay out', () => {
  for (const v of ['set_settlement_template', 'clear_bank_standard', 'import_bank_statement', 'contacts_merge', 'settings_set', 'set_qr_auto_apply', 'create_automation_rule', 'enable_automation_rule', 'unlock_period', 'reopen_month', 'env_delete', 'set_creditor_bank_profile', 'vat_mark_filed']) {
    assert.ok(!GRANT_APPROVABLE_TOOLS.has(v), v);
  }
});
