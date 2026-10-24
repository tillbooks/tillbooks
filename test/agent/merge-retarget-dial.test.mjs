/**
 * A merge that moves an auto-issuing recurring schedule drafts under `issue` (D141 follow-up 4, the
 * non-author critic's F1 on `claude/d141-followups`).
 *
 * `contacts_merge` re-points the source's schedules onto the target. That is the retarget
 * `update_recurring_schedule {patch: {contactId}}` drafts under `issue` (D141.2), but the merge's own
 * tier is `erase`, which the owner may set to `auto` on its own. Measured on the branch before this
 * rule: with `erase=auto` and `issue=ask`, the agent merged a human's auto-issuing customer into a
 * contact it had just created, the merge executed, and the next tick issued two invoices to that
 * contact with no Vorschlag.
 *
 * HOW IT BITES: delete the `contacts_merge` book-keyed rule from `INPUT_KEYED_DIAL_RULES`
 * (src/core/agent/dialMap.ts) and the first test's merge executes on both faces.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { handleRest } from '../../dist/api/rest.js';
import { callTool } from '../../dist/api/mcp.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';

const rest = (deps, name, input) => handleRest(name, input, deps).body;
const mcp = (deps, name, args) => JSON.parse(callTool(deps, name, args).content[0].text);
const human = (deps, name, input) => getAction(name).run({ ...deps, actor: 'studio' }, input);

function world(seed, { autoIssue }) {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps, 'Serie GmbH', `${seed}-ws`);
  const dial = human(deps, 'set_agent_dial', { workspaceId, capability: 'erase', level: 'auto', idempotencyKey: `${seed}-dial` });
  assert.equal(dial.ok, true, JSON.stringify(dial));
  const x = human(deps, 'create_contact', { workspaceId, partyRole: 'customer', name: 'Kunde X AG', idempotencyKey: `${seed}-x` });
  const y = human(deps, 'create_contact', { workspaceId, partyRole: 'customer', name: 'Ganz Andere GmbH', idempotencyKey: `${seed}-y` });
  const sched = human(deps, 'create_recurring_schedule', {
    workspaceId,
    contactId: x.contact.id,
    lines: [{ description: 'Retainer', unitPriceMinor: 100000 }],
    interval: 'monthly',
    anchorDate: '2026-01-01',
    autoIssue,
    idempotencyKey: `${seed}-sched`,
  });
  assert.equal(sched.ok, true, JSON.stringify(sched));
  const contactOf = () =>
    deps.store.db.prepare('SELECT contact_id AS c FROM recurring_schedule WHERE workspace_id = ? AND id = ?').get(workspaceId, sched.schedule.id).c;
  return { deps, workspaceId, x: x.contact.id, y: y.contact.id, contactOf };
}

for (const [face, call] of [
  ['REST', (deps, input) => rest(deps, 'contacts_merge', input)],
  ['MCP', (deps, input) => mcp(deps, 'contacts_merge', input)],
]) {
  test(`${face}: with erase=auto, an agent's merge of an auto-issuing customer drafts under issue and moves nothing`, () => {
    const w = world(`mrd-${face}`, { autoIssue: true });
    const res = call(w.deps, { workspaceId: w.workspaceId, sourceId: w.x, targetId: w.y, idempotencyKey: 'mrd-merge' });
    assert.equal(res.drafted, true, JSON.stringify(res));
    assert.equal(res.dialCapability, 'issue');
    assert.equal(w.contactOf(), w.x, 'the schedule still bills the customer a person chose');
    w.deps.store.close();
  });
}

test('with erase=auto, an agent\'s merge of a customer whose schedule only drafts executes as erase allows', () => {
  const w = world('mrd-draft', { autoIssue: false });
  const res = rest(w.deps, 'contacts_merge', { workspaceId: w.workspaceId, sourceId: w.x, targetId: w.y, idempotencyKey: 'mrd-merge' });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.drafted, undefined);
  assert.equal(w.contactOf(), w.y, 'a draft-only schedule follows the merge; its tick makes review drafts only');
  w.deps.store.close();
});

test('the approval of the drafted merge runs it as the approving person, schedule included', () => {
  const w = world('mrd-appr', { autoIssue: true });
  const drafted = rest(w.deps, 'contacts_merge', { workspaceId: w.workspaceId, sourceId: w.x, targetId: w.y, idempotencyKey: 'mrd-merge' });
  assert.equal(drafted.drafted, true, JSON.stringify(drafted));
  const approved = human(w.deps, 'approve_drafted_action', { workspaceId: w.workspaceId, actionId: drafted.actionId });
  assert.equal(approved.ok, true, JSON.stringify(approved));
  assert.equal(w.contactOf(), w.y);
  w.deps.store.close();
});
