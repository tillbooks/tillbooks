// Critic r1 on D188 (A39 §21, card-line rules), probe group 1: the merchant a card text names.
//
// THE DEFECT THESE PROBES PIN. `cardMerchantOf` drops every whitespace token that carries a digit (meant for
// the ZIP, a shop number, a reference) and every letter outside Latin-1. A merchant whose OWN name carries a
// digit (`<Name>-<shop number>`, a name that starts with a numeral) or is written in another script loses its
// name entirely, and the next letter token becomes "the merchant": the TOWN. Two different businesses in one
// town then share one counterparty key `card:<town>`, and under the default `rules.autobook_derived_keys` =
// `all` a granted rule of the one books the other's line unattended, to the first one's account.
//
// SYNTHETIC BY CONSTRUCTION: every text, merchant, town, amount and date below is invented here in the SHAPE
// of a Swiss debit-card booking text (a masked card number, a merchant, a town). Every value is invented.

import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { listBankInbox } from '../../dist/core/banking/index.js';
import { setBankStandard, readLiveRule } from '../../dist/core/banking/bankStandards.js';
import { lineCounterpartyOf } from '../../dist/core/banking/bankProposals.js';
import { cardMerchantOf } from '../../dist/core/banking/derivedCounterparty.js';
import { readBankTxn, readBankTxnDetail } from '../../dist/core/banking/bankLines.js';
import { autobookEligibility, grantRuleAutobook } from '../../dist/core/banking/autobook.js';
import { settingsSet } from '../../dist/core/settings/settings.js';
import { world, importLines, must, assertClaimInvariantHolds } from '../banking/bank-inbox-support.mjs';
import { autopilot, at, bookAsProposed, decisionOf } from '../banking/n04-autobook-support.mjs';

afterEach(assertClaimInvariantHolds);

const CARD = 'Online purchase Beispielbank Visa Debit card no. xxxx 4711';

let n = 0;
function stmt(t, specs) {
  n += 1;
  const dates = specs.map((s) => s.date).sort();
  const res = importLines(t, {
    statementId: `CR1M-${n}`,
    seqNb: String(n),
    from: dates[0],
    to: dates[dates.length - 1],
    entries: specs.map((s, i) => ({ ref: `CR1M${n}L${i + 1}`, cd: 'DBIT', amountMinor: s.amount, date: s.date, ustrd: s.text })),
  });
  return specs.map((_, i) => res.lines[`CR1M${n}L${i + 1}`]);
}
const keyOf = (t, id) => lineCounterpartyOf(t.ctx, readBankTxn(t.ctx, id), readBankTxnDetail(t.ctx, id))?.key ?? null;
const lineOf = (t, id) => must(listBankInbox(t.ctx, { bankTxnId: id, status: 'all' })).lines[0];

// --- Pure: two different businesses, one key ---------------------------------------------------------

test('[FINDING M1] two merchants whose names carry a digit, in one town, are ONE counterparty (the town)', () => {
  const a = cardMerchantOf(`${CARD}, Ladenkette-1234 Beispielstadt`);
  const b = cardMerchantOf(`${CARD}, Tankstelle-5678 Beispielstadt`);
  const c = cardMerchantOf(`${CARD}, 1PASSWORTDIENST BEISPIELSTADT`);
  const d = cardMerchantOf(`${CARD}, 24STUNDENSHOP BEISPIELSTADT`);
  // What the module reads today: the town, four times.
  // A wrong counterparty is worse than none (the module's own header): these must differ, or be null.
  const keys = [a, b, c, d].filter((m) => m !== null).map((m) => m.toLowerCase());
  assert.equal(new Set(keys).size, keys.length, `four businesses read as: ${JSON.stringify([a, b, c, d])}`);
});

test('[FINDING M1] a merchant written in another script loses its name to the town', () => {
  const a = cardMerchantOf(`${CARD}, Καφενείο Ήλιος ATHINA`);
  const b = cardMerchantOf(`${CARD}, Ταβέρνα Θάλασσα ATHINA`);
  assert.ok(a === null || a !== b, `two shops read as one: ${JSON.stringify([a, b])}`);
});

// --- End to end: the rule of one business books the other's line --------------------------------------

test('[FINDING M1, end to end] a rule from one shop proposes SURE (bulk) on another shop in the same town', () => {
  const t = world();
  const [shop, fuel] = stmt(t, [
    { text: `${CARD}, Ladenkette-1234 Beispielstadt`, amount: 4210, date: '2026-07-02' },
    { text: `${CARD}, Tankstelle-5678 Beispielstadt`, amount: 9150, date: '2026-07-06' },
  ]);
  must(setBankStandard(t.ctx, { bankTxnId: shop, accountId: t.acc('6570'), taxCode: null, idempotencyKey: 'shop-rule' }));
  const other = lineOf(t, fuel);
  assert.notEqual(keyOf(t, fuel), keyOf(t, shop), 'another business is another counterparty');
  assert.ok(!(other.proposal?.reasonCode === 'standard' && other.proposal?.certainty === 'sure'), `the fuel line is proposed ${JSON.stringify(other.proposal)}`);
});

test('[FINDING M1, end to end] under the default `all`, a granted shop rule AUTOBOOKS another business\'s line', () => {
  const t = world();
  must(settingsSet(t.ctx, { key: 'rules.autobook_offer_after', value: 3, reason: 'critic', idempotencyKey: 'oa3' }));
  const shopText = `${CARD}, Ladenkette-1234 Beispielstadt`;
  const [first] = stmt(t, [{ text: shopText, amount: 4210, date: '2026-07-01' }]);
  const ruleId = must(setBankStandard(t.ctx, { bankTxnId: first, accountId: t.acc('6570'), taxCode: null, idempotencyKey: 'shop-rule' })).standard.id;
  assert.deepEqual(autobookEligibility(t.ctx, readLiveRule(t.ctx, ruleId)), { eligible: true, kind: 'complete' });
  for (const [i, amount] of [3990, 4420, 4105].entries()) {
    const [id] = stmt(t, [{ text: shopText, amount, date: `2026-07-${String(5 + i * 5).padStart(2, '0')}` }]);
    bookAsProposed(t, id);
  }
  must(grantRuleAutobook(t.ctx, { standardId: ruleId, idempotencyKey: 'grant' }), 'grant');
  at(t, '2026-07-25T08:00:00.000Z');
  // A different business: a fuel station in the same town.
  const [fuel] = stmt(t, [{ text: `${CARD}, Tankstelle-5678 Beispielstadt`, amount: 4300, date: '2026-07-24' }]);
  autopilot(t).tick();
  const d = decisionOf(t, fuel);
  assert.equal(d, undefined, `the fuel line was decided unattended: ${JSON.stringify(d)}`);
});
