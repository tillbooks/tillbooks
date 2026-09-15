// C00 §7's automation regression test, which was never written, and which is why F2 shipped.
//
// The spec forbids `contacts_merge` and `contacts_anonymise` as automation ACTIONS in three separate
// places, and the engine enforced it nowhere: `shapeProblem` gated only on `isRegisteredWriteAction`,
// so a rule with `action.tool: 'contacts_anonymise'` on `contact.created` saved cleanly and fired with
// `status ok`. C00's own §0 reconciliation note is what made this invisible: it recorded the exclusion
// as holding because those verbs "are simply not emitters", which is a true statement about TRIGGERS
// and says nothing at all about actions.
//
// This lives beside the C00 suites rather than in `test/automation/` because it is C00's invariant
// asserted against G01's boundary: the spec line it holds is C00 §5/§6b/§7, and the file a future
// reader lands on from that spec should be this one.

import test from 'node:test';
import assert from 'node:assert/strict';

import { NOT_AUTOMATABLE } from '../../dist/core/automation/rules.js';
import { ACTIONS } from '../../dist/api/registry.js';
import { call, workspace, runRows } from '../automation/support.mjs';

const CONTACT_TEMPLATE = { contactId: 'contact_1', idempotencyKey: 'from-a-rule' };

test('C00 §7: neither elevated contact verb can be SAVED as a rule action', () => {
  const { deps, workspaceId } = workspace('c00-excl');
  for (const tool of ['contacts_merge', 'contacts_anonymise']) {
    const res = call(deps, 'create_automation_rule', {
      workspaceId,
      name: `verboten ${tool}`,
      trigger: { event: 'contact.created' },
      action: { tool, inputTemplate: CONTACT_TEMPLATE },
      idempotencyKey: `k-${tool}`,
    });
    assert.equal(res.ok, false, `${tool} must be refused as a rule action`);
    assert.equal(res.error, 'action_not_automatable');
    assert.equal(res.tool, tool);
  }
  // Refused at DEFINITION time means no rule and therefore nothing to fire, disable or explain later.
  // A workspace is born with the two G22 (D129) `builtin:checklist_autostart:*` rules, so the invariant
  // is that the elevated verbs added NONE of their own, not that the list is empty.
  const own = call(deps, 'list_automation_rules', { workspaceId }).rules.filter((r) => !r.ruleId.startsWith('builtin:checklist_autostart:'));
  assert.equal(own.length, 0);
});

test('C00 §7: a rule cannot be PATCHED into one either', () => {
  const { deps, workspaceId } = workspace('c00-patch');
  // A legal C00 action, so the rule exists and the patch is the only thing under test.
  const created = call(deps, 'create_automation_rule', {
    workspaceId,
    name: 'erlaubt',
    trigger: { event: 'contact.created' },
    action: { tool: 'contacts_tag', inputTemplate: { contactId: 'contact_1', segments: ['neu'] } },
    idempotencyKey: 'k-legal',
  });
  assert.equal(created.ok, true, JSON.stringify(created));

  const patched = call(deps, 'update_automation_rule', {
    workspaceId,
    ruleId: created.rule.ruleId,
    patch: { action: { tool: 'contacts_anonymise', inputTemplate: CONTACT_TEMPLATE } },
    idempotencyKey: 'k-patch',
  });
  assert.equal(patched.ok, false);
  assert.equal(patched.error, 'action_not_automatable');
  // And the stored rule is untouched: a refused patch must not half-apply.
  assert.equal(
    call(deps, 'get_automation_rule', { workspaceId, ruleId: created.rule.ruleId }).rule.action.tool,
    'contacts_tag',
  );
});

test('the denylist covers every irreversible or compliance-sensitive verb it claims to', () => {
  const { deps, workspaceId } = workspace('c00-denylist');
  const registered = new Set(ACTIONS.filter((a) => a.kind === 'write').map((a) => a.name));
  for (const tool of NOT_AUTOMATABLE) {
    // Each name must be a REAL write verb. A denylist entry that matches nothing is a typo that reads
    // like a guard, and it would silently stop guarding the day the verb was renamed.
    assert.ok(registered.has(tool), `${tool} is on NOT_AUTOMATABLE but is not a registered write verb`);
    const res = call(deps, 'create_automation_rule', {
      workspaceId,
      name: `verboten ${tool}`,
      trigger: { event: 'contact.created' },
      action: { tool, inputTemplate: {} },
      idempotencyKey: `d-${tool}`,
    });
    assert.equal(res.error, 'action_not_automatable', `${tool} must be refused`);
  }
  // The five legs the criterion names, pinned so a later edit has to argue with a test. The F5
  // retrofit pass (docs/planning/f5-retrofit-survey.md) grew this from C00's original nine.
  for (const tool of [
    // (a) irreversible
    'contacts_merge',
    'contacts_anonymise',
    'delete_account',
    'delete_cost_center',
    'delete_draft',
    'delete_item',
    'item_categories_delete',
    'price_lists_delete',
    'price_lists_unset_price',
    'files_delete',
    'close_year',
    // (b) statutory acts a human owns
    'vat_mark_filed',
    'vat_saldo_declaration_basis',
    'unlock_period',
    // (c) who may act
    'revoke_member',
    'set_role',
    'define_role',
    'invite_member',
    // (d) outside the tenant, where the fire path's tenant overwrite binds nothing
    'create_workspace',
    'bootstrap_workspace',
    'accept_invite',
    // (e) self-administration of the unattended subsystem
    'create_automation_rule',
    'update_automation_rule',
    'enable_automation_rule',
    'run_due_automations',
    'retry_automation_run',
  ]) {
    assert.ok(NOT_AUTOMATABLE.has(tool), `${tool} must stay on the denylist`);
  }
});

test('the ACTION CATALOGUE hides them too, so no picker offers what the save refuses', () => {
  const { deps, workspaceId } = workspace('c00-catalogue');
  const catalogue = call(deps, 'list_automation_rules', { workspaceId }).catalogue.actions;
  assert.ok(catalogue.length > 0, 'the catalogue must be populated or this assertion proves nothing');
  for (const tool of NOT_AUTOMATABLE) {
    assert.ok(!catalogue.includes(tool), `${tool} must not be offered as an action`);
  }
  // The archive counterpart of a denied hard delete IS automatable, which is what makes the criterion
  // a line rather than a blanket.
  assert.ok(catalogue.includes('archive_account'));
  assert.ok(catalogue.includes('archive_contact'));
  assert.ok(catalogue.includes('contacts_tag'));
});

test('the legal C00 actions still fire, so the denylist is not a blanket over the capability', () => {
  const { deps, workspaceId } = workspace('c00-legal');
  const contact = call(deps, 'create_contact', {
    workspaceId,
    partyRole: 'customer',
    name: 'Automat AG',
    idempotencyKey: 'ct-1',
  });
  assert.equal(contact.ok, true, JSON.stringify(contact));

  const rule = call(deps, 'create_automation_rule', {
    workspaceId,
    name: 'segmentiere neue Kontakte',
    trigger: { event: 'contact.created' },
    action: { tool: 'contacts_tag', inputTemplate: { contactId: contact.contact.id, segments: ['neu'] } },
    idempotencyKey: 'k-fire',
  });
  assert.equal(rule.ok, true, JSON.stringify(rule));

  const second = call(deps, 'create_contact', {
    workspaceId,
    partyRole: 'customer',
    name: 'Zweite AG',
    idempotencyKey: 'ct-2',
  });
  assert.equal(second.ok, true);
  const runs = runRows(deps, workspaceId);
  assert.equal(runs.length, 1, JSON.stringify(runs));
  assert.equal(runs[0].action_tool, 'contacts_tag');
  assert.equal(runs[0].status, 'ok', JSON.stringify(runs));
});
