// A41 critic round 1 (non-author), probe group 5: can anything other than a person release an unattended
// posting?
//
// G1 rules.autobook_requires_beleg is human-only and drafts under `post`, but the matcher that DECIDES whether
//    a waiting line may book (belege.vat_delta_tolerance_rappen, belege.match_date_window_days,
//    belege.match_fx_tolerance_pct) is agent-writable under `customize`. With the `customize` dial at auto
//    (the dial an owner opens so the agent can define fields), an agent widens the tolerance and the next
//    tick books a line the person's receipt gate held back: an unattended posting no person released.
// G2 (sound) the agent can neither set rules.autobook_requires_beleg nor answer an ask-first setting.
//
// SYNTHETIC BY CONSTRUCTION: invented counterparties, IBANs, amounts and dates.

import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { handleRest } from '../../dist/api/rest.js';
import { grantRuleAutobook, autobookDigest } from '../../dist/core/banking/autobook.js';
import { settingsSet, getSetting } from '../../dist/core/settings/settings.js';
import { must, assertClaimInvariantHolds } from '../banking/bank-inbox-support.mjs';
import { ruleWorld, debits, bookAsProposed, autopilot, decisionOf, at, TELCO } from '../banking/n04-autobook-support.mjs';
import { confirmedReceipt } from '../banking/a41-beleg-support.mjs';

// A41.3 re-cut v2 (D184, built 07.11.2026): the findings below run live against the assignment design. A probe
// whose premise the re-cut changed says so in its body (the verdict reads only the line's assignment).

afterEach(assertClaimInvariantHolds);

function heldBack() {
  const t = ruleWorld({ taxCode: 'VST-M' });
  debits(t, [1100, 1200, 1300]).forEach((id) => bookAsProposed(t, id));
  must(grantRuleAutobook(t.ctx, { standardId: t.ruleId, idempotencyKey: 'grant-g' }));
  must(settingsSet(t.ctx, { key: 'rules.autobook_requires_beleg', value: 'on', reason: 'critic', idempotencyKey: 'rb-g' }));
  at(t, '2026-07-20T08:00:00.000Z');
  const ap = autopilot(t);
  const [line] = debits(t, [1081]);
  const d = t.store.db.prepare('SELECT booking_date FROM bank_txn WHERE id = ?').get(line).booking_date;
  // CHF 10.81 at 8.1 %: the engine computes 0.81; the receipt prints 0.20, 61 Rappen off.
  // Re-cut: the engine pairs only trusted figures, so a person confirmed this receipt's (I-F).
  confirmedReceipt(t, { amount: 1081, vendor: TELCO, date: d, vat: 20 });
  ap.tick();
  assert.equal(decisionOf(t, line), undefined, 'the person\'s receipt gate holds the line back');
  assert.deepEqual(must(autobookDigest(t.ctx, {})).waitingForBeleg.map((w) => w.reason), ['beleg_vat_differs']);
  return { t, ap, line };
}

test('G1 fixed: an agent under the customize dial cannot widen the receipt tolerance, and the held line stays held', () => {
  const { t, ap, line } = heldBack();
  // A person opens the customize dial (field definitions, views): nothing about posting.
  const dial = getAction('set_agent_dial').run({ ...t.deps, actor: 'studio' }, { workspaceId: t.workspaceId, capability: 'customize', level: 'auto', idempotencyKey: 'dial-c' });
  assert.equal(dial.ok, true, JSON.stringify(dial));
  const res = handleRest('settings_set', { workspaceId: t.workspaceId, key: 'belege.vat_delta_tolerance_rappen', value: 500, reason: 'Agent', idempotencyKey: 'ag-tol' }, { ...t.deps, actor: 'agent' }).body;
  const applied = getSetting(t.ctx, 'belege.vat_delta_tolerance_rappen');
  ap.tick();
  const booked = decisionOf(t, line)?.state === 'booked';
  assert.equal(
    booked,
    false,
    `the agent's settings_set answered ${JSON.stringify(res).slice(0, 160)}; tolerance now ${applied}; the held-back line was then booked by autobook with no person's click`,
  );
});

test('G2 sound: the agent can neither switch the receipt gate nor answer an ask-first setting', () => {
  const { t } = heldBack();
  for (const key of ['rules.autobook_requires_beleg', 'bank.bulk_learned_min', 'rules.autobook_offer_after']) {
    const value = key === 'rules.autobook_requires_beleg' ? 'off' : 5;
    const res = handleRest('settings_set', { workspaceId: t.workspaceId, key, value, reason: 'Agent', idempotencyKey: `ag-${key}` }, { ...t.deps, actor: 'agent' }).body;
    assert.equal(res.error, 'human_only', `${key}: ${JSON.stringify(res)}`);
  }
});
