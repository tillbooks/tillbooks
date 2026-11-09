// A41.7 (D184 point 6): rules.autobook_offer_after is ASK FIRST. Until a person answered it, no rule is
// offered automatic booking and none can be granted; the rule card is told to ask (asksThreshold). An agent
// cannot answer. Answering applies at once.
//
// SYNTHETIC BY CONSTRUCTION: invented counterparties on invented IBANs (bank-inbox-support.mjs).

import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { handleRest } from '../../dist/api/rest.js';
import { autobookCandidates, grantRuleAutobook } from '../../dist/core/banking/autobook.js';
import { setBankStandard } from '../../dist/core/banking/bankStandards.js';
import { must, world, assertClaimInvariantHolds } from './bank-inbox-support.mjs';
import { debits, bookAsProposed, autopilot, at } from './n04-autobook-support.mjs';

afterEach(assertClaimInvariantHolds);

const offers = (t) => t.store.db.prepare("SELECT COUNT(*) AS n FROM agent_action WHERE workspace_id = ? AND action_tool = 'grant_rule_autobook'").get(t.workspaceId).n;

/** A rule with three clean uses by a person, and the threshold NEVER answered. */
function unanswered() {
  const t = world();
  const [first] = debits(t, [1000]);
  const ruleId = must(setBankStandard(t.ctx, { bankTxnId: first, accountId: t.acc('6570'), taxCode: null, idempotencyKey: 'rule-v1' })).standard.id;
  debits(t, [1100, 1200, 1300]).forEach((id) => bookAsProposed(t, id));
  return { ...t, ruleId };
}

test('unanswered: no offer is drafted, no grant is made, and the rule card is told to ask', () => {
  const t = unanswered();
  at(t, '2026-07-20T08:00:00.000Z');
  autopilot(t).tick();
  assert.equal(offers(t), 0, 'no offer while the threshold is unanswered');
  const c = must(autobookCandidates(t.ctx));
  assert.equal(c.offerAfterAnswered, false);
  assert.equal(c.offerAfter, 5, 'the suggestion the question pre-selects');
  const rule = c.rules.find((r) => r.standardId === t.ruleId);
  assert.equal(rule.asksThreshold, true);
  assert.equal(rule.grantable, false);
  const refused = grantRuleAutobook(t.ctx, { standardId: t.ruleId, idempotencyKey: 'g-early' });
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'needs_setting_answer');
  assert.equal(refused.key, 'rules.autobook_offer_after');
});

test('an agent cannot answer the threshold; a person answering 3 makes the rule grantable and the next tick offers it', () => {
  const t = unanswered();
  const agent = handleRest('settings_set', { workspaceId: t.workspaceId, key: 'rules.autobook_offer_after', value: 3, reason: 'Agent', idempotencyKey: 'ag' }, { ...t.deps, actor: 'agent' }).body;
  assert.equal(agent.error, 'human_only');
  assert.equal(must(autobookCandidates(t.ctx)).offerAfterAnswered, false);
  must(getAction('settings_set').run({ ...t.deps, actor: 'user_1' }, { workspaceId: t.workspaceId, key: 'rules.autobook_offer_after', value: 3, reason: 'ab drei', idempotencyKey: 'p3' }));
  const c = must(autobookCandidates(t.ctx));
  assert.equal(c.offerAfterAnswered, true);
  const rule = c.rules.find((r) => r.standardId === t.ruleId);
  assert.equal(rule.asksThreshold, false);
  assert.equal(rule.grantable, true);
  at(t, '2026-07-20T08:00:00.000Z');
  autopilot(t).tick();
  assert.equal(offers(t), 1, 'answered: the offer follows');
});
