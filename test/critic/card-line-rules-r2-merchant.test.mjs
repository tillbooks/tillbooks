// Critic r2 on D188 (A39 §21, card-line rules), probe group 1: does the r1 fix (`cardKeyOf`, the new
// `merchantOfSegment`) still MERGE two businesses? The module now promises the key "FAILS TOWARD SPLITTING,
// NEVER TOWARD MERGING" and "never a later token such as the town".
//
// N1. `merchantOfSegment` drops a LEADING (and trailing) token that is an ISO 4217 code in capitals. Card
//     texts are capitals, and many three-letter currency codes are ordinary words: TOP (Tonga), ALL
//     (Albania), MAD (Morocco), CUP (Cuba), TRY (Turkey), BOB (Bolivia). So "TOP PIZZA", "MAD PIZZA" and
//     "PIZZA" in one town are one key, and "CAFE BOB" and "CAFE TOP" are "CAFE".
// N2. `cardMerchantOf` SKIPS a segment that starts with a clause word (`CLAUSE_START`: rate, fee, kurs, ...)
//     and takes the next one. A merchant whose name starts with such a word, written "<merchant>, <town>",
//     is read as the town.
//
// SYNTHETIC BY CONSTRUCTION: every text, merchant, town, amount and date is invented here.

import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { listBankInbox } from '../../dist/core/banking/index.js';
import { setBankStandard, readLiveRule } from '../../dist/core/banking/bankStandards.js';
import { lineCounterpartyOf } from '../../dist/core/banking/bankProposals.js';
import { cardMerchantOf, cardKeyOf } from '../../dist/core/banking/derivedCounterparty.js';
import { readBankTxn, readBankTxnDetail } from '../../dist/core/banking/bankLines.js';
import { autobookEligibility, grantRuleAutobook } from '../../dist/core/banking/autobook.js';
import { settingsSet } from '../../dist/core/settings/settings.js';
import { world, importLines, must, assertClaimInvariantHolds } from '../banking/bank-inbox-support.mjs';
import { autopilot, at, bookAsProposed, decisionOf } from '../banking/n04-autobook-support.mjs';

afterEach(assertClaimInvariantHolds);

const CARD = 'Online purchase Beispielbank Visa Debit card no. xxxx 4711';
const keyOfText = (s) => {
  const m = cardMerchantOf(`${CARD}, ${s}`);
  return m === null ? null : cardKeyOf(m);
};
/** Distinct businesses must have distinct keys, or no key: a merge is the one wrong answer. */
function assertNoMerge(texts) {
  const keys = texts.map(keyOfText);
  const given = keys.filter((k) => k !== null);
  assert.equal(new Set(given).size, given.length, `distinct businesses read as: ${JSON.stringify(Object.fromEntries(texts.map((t, i) => [t, keys[i]])))}`);
}

let n = 0;
function stmt(t, specs) {
  n += 1;
  const dates = specs.map((s) => s.date).sort();
  const res = importLines(t, {
    statementId: `CR2M-${n}`,
    seqNb: String(n),
    from: dates[0],
    to: dates[dates.length - 1],
    entries: specs.map((s, i) => ({ ref: `CR2M${n}L${i + 1}`, cd: 'DBIT', amountMinor: s.amount, date: s.date, ustrd: s.text })),
  });
  return specs.map((_, i) => res.lines[`CR2M${n}L${i + 1}`]);
}
const keyOf = (t, id) => lineCounterpartyOf(t.ctx, readBankTxn(t.ctx, id), readBankTxnDetail(t.ctx, id))?.key ?? null;

test('[FINDING N1] a leading capital word that is also a currency code is dropped: TOP / MAD / ALL PIZZA are one merchant', () => {
  assertNoMerge(['TOP PIZZA BEISPIELSTADT', 'MAD PIZZA BEISPIELSTADT', 'ALL PIZZA BEISPIELSTADT', 'PIZZA BEISPIELSTADT']);
});

test('[FINDING N1] a trailing capital word that is also a currency code is dropped: CAFE BOB and CAFE TOP are CAFE', () => {
  assertNoMerge(['CAFE BOB', 'CAFE TOP', 'CAFE']);
  assertNoMerge(['CUP CAKE', 'TRY CAKE']);
});

test('[FINDING N2] a merchant that starts with a clause word, then its town, is read as the TOWN', () => {
  assertNoMerge(['RATE MY PLATE, BEISPIELSTADT', 'FEE FIGHTERS, BEISPIELSTADT', 'KURS AG, BEISPIELSTADT', 'BEISPIELSTADT']);
});

test('[FINDING N1, end to end] a granted "TOP PIZZA" rule autobooks the line of "MAD PIZZA" under the default `all`', () => {
  const t = world();
  must(settingsSet(t.ctx, { key: 'rules.autobook_offer_after', value: 3, reason: 'critic', idempotencyKey: 'oa3' }));
  const mine = `${CARD}, TOP PIZZA BEISPIELSTADT`;
  const [first] = stmt(t, [{ text: mine, amount: 4210, date: '2026-07-01' }]);
  const ruleId = must(setBankStandard(t.ctx, { bankTxnId: first, accountId: t.acc('6570'), taxCode: null, idempotencyKey: 'pizza-rule' })).standard.id;
  assert.deepEqual(autobookEligibility(t.ctx, readLiveRule(t.ctx, ruleId)), { eligible: true, kind: 'complete' });
  for (const [i, amount] of [3990, 4420, 4105].entries()) {
    const [id] = stmt(t, [{ text: mine, amount, date: `2026-07-${String(5 + i * 5).padStart(2, '0')}` }]);
    bookAsProposed(t, id);
  }
  must(grantRuleAutobook(t.ctx, { standardId: ruleId, idempotencyKey: 'grant' }), 'grant');
  at(t, '2026-07-25T08:00:00.000Z');
  const [other] = stmt(t, [{ text: `${CARD}, MAD PIZZA BEISPIELSTADT`, amount: 4300, date: '2026-07-24' }]);
  autopilot(t).tick();
  const d = decisionOf(t, other);
  assert.equal(d, undefined, `the other business's line was decided unattended: ${JSON.stringify(d)}`);
  assert.notEqual(keyOf(t, other), keyOf(t, first), 'another business is another counterparty');
});

// --- What the fix got right (held) -------------------------------------------------------------------

test('[HELD] chain branches, a varying town or ZIP, and the r1 digit names split; a bare facilitator or a number-first segment has no key', () => {
  assertNoMerge(['Ladenkette-1234 Beispielstadt', 'Ladenkette-5678 Beispielstadt', 'Tankstelle-5678 Beispielstadt', '1PASSWORTDIENST BEISPIELSTADT', '24STUNDENSHOP BEISPIELSTADT']);
  assertNoMerge(['Καφενείο Ήλιος ATHINA', 'Ταβέρνα Θάλασσα ATHINA']);
  assertNoMerge(['PAYPAL *NETFLIX', 'PAYPAL *SPOTIFY', 'PAYPAL *AB12CD', 'PAYPAL *XY34ZZ']);
  // Splits, the safe direction: the same merchant with a different town is two keys, never one with another.
  assert.notEqual(keyOfText('RENDER.COM SAN FRANCISCO'), keyOfText('RENDER.COM 94107'));
  for (const s of ['PAYPAL *', '1234 BEISPIELSTADT', 'ABC*', 'X 12']) assert.equal(keyOfText(s), null, s);
});

test('[HELD, benign] what the fold merges is one name written two ways (punctuation, width, ligature, accent)', () => {
  // Re-cut (zero token removal, A39 §21.1): the postcode stays, so the benign merge holds only with it.
  assert.equal(keyOfText('RENDER.COM 94107'), keyOfText('RENDER-COM 94107'));
  assert.notEqual(keyOfText('RENDER.COM 94107'), keyOfText('RENDER-COM'));
  assert.equal(keyOfText('ＲＥＮＤＥＲ'), keyOfText('RENDER'));
  assert.equal(keyOfText('ﬁnca'), keyOfText('finca'));
  // Re-cut (closed-world rule, A39 §21.1): marks are KEPT, so an accent is a SPLIT now, the safe direction.
  assert.notEqual(keyOfText('Café'), keyOfText('Cafe'));
});

test('[HELD] the inbox key is the one the probe reads', () => {
  const t = world();
  const [a] = stmt(t, [{ text: `${CARD}, Ladenkette-1234 Beispielstadt`, amount: 100, date: '2026-07-02' }]);
  assert.equal(keyOf(t, a), 'card:ladenkette 1234 beispielstadt');
  assert.deepEqual(must(listBankInbox(t.ctx, { bankTxnId: a, status: 'all' })).lines[0].derivedCounterparty, { kind: 'card', label: 'Ladenkette-1234 Beispielstadt' });
});
