// A41 critic round 1 (non-author), probe group 1: A41.3 waiting lines and the autobook digest.
//
// P1 a granted rule whose account is "Beleg = Kontoauszug" (6900 Finanzaufwand, statement_is_voucher by
//    default, D142 amendment) needs no receipt by the house's own definition, yet under
//    rules.autobook_requires_beleg = on its lines wait for one forever (no_beleg), and no receipt can be
//    supplied that the bank does not issue.
// P2 a granted rule on INCOMING money (a CRDT rule): captures pair with debit lines only, so under
//    requires_beleg = on its lines can never find a candidate and wait forever, while the digest tells the
//    person "no_beleg" as if capturing a receipt would help. Capturing one does not.
// P3 autobook_digest (read_sales only) answers waitingForBeleg reasons that disclose hidden receipt facts
//    (several_belege: two receipts exist; beleg_vat_differs: the hidden receipt's printed VAT) to a seat that
//    may NOT read the filing register, the very fact belegEvidence.ts hides (belege_not_readable).
//
// SYNTHETIC BY CONSTRUCTION: invented counterparties, IBANs, amounts and dates (n04/a41 support files).

import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { makeContext } from '../../dist/core/context.js';
import { ok, err } from '../../dist/core/result.js';
import { grantRuleAutobook, autobookDigest } from '../../dist/core/banking/autobook.js';
import { settingsSet } from '../../dist/core/settings/settings.js';
import { must, world, assertClaimInvariantHolds } from '../banking/bank-inbox-support.mjs';
import { setBankStandard } from '../../dist/core/banking/bankStandards.js';
import { ruleWorld, debits, bookAsProposed, autopilot, runs, decisionOf, at, TELCO } from '../banking/n04-autobook-support.mjs';
import { receipt, confirmedReceipt } from '../banking/a41-beleg-support.mjs';

// A41.3 re-cut v2 (D184, built 07.11.2026): the findings below run live against the assignment design. A probe
// whose premise the re-cut changed says so in its body (the verdict reads only the line's assignment).

afterEach(assertClaimInvariantHolds);

const LATER = '2026-07-20T08:00:00.000Z';
const dateOf = (t, line) => t.store.db.prepare('SELECT booking_date FROM bank_txn WHERE id = ?').get(line).booking_date;

function grantedOn(t, cd = 'DBIT') {
  debits(t, [1100, 1200, 1300], { cd }).forEach((id) => bookAsProposed(t, id));
  const g = must(grantRuleAutobook(t.ctx, { standardId: t.ruleId, idempotencyKey: 'grant-c1' }), 'grant').grant;
  must(settingsSet(t.ctx, { key: 'rules.autobook_requires_beleg', value: 'on', reason: 'critic', idempotencyKey: 'rb-on-c1' }));
  at(t, LATER);
  return { ...t, grantId: g.grantId, ap: autopilot(t) };
}

test('P1 control: with requires_beleg OFF a 6900 (Beleg = Kontoauszug) rule books its line', () => {
  const t = ruleWorld({ account: '6900' });
  debits(t, [1100, 1200, 1300]).forEach((id) => bookAsProposed(t, id));
  must(grantRuleAutobook(t.ctx, { standardId: t.ruleId, idempotencyKey: 'grant-ctl' }));
  at(t, LATER);
  const ap = autopilot(t);
  const [line] = debits(t, [1400]);
  ap.tick();
  assert.equal(decisionOf(t, line)?.state, 'booked');
});

test('P1 fixed: a 6900 (Beleg = Kontoauszug) rule books its line under requires_beleg = on, no receipt expected', () => {
  const t = grantedOn(ruleWorld({ account: '6900' }));
  const [line] = debits(t, [1400]);
  for (let i = 0; i < 3; i++) t.ap.tick();
  const waiting = must(autobookDigest(t.ctx, {})).waitingForBeleg.map((w) => [w.bankTxnId, w.reason]);
  // The house's own definition: a line booked to accounts whose voucher is the statement needs no Beleg
  // (needsReceipt is false for it). The autobook verdict ignores that and waits.
  assert.equal(decisionOf(t, line)?.state, 'booked', `expected the Kontoauszug line to book; it waits: ${JSON.stringify(waiting)}`);
});

test('P2 fixed: an incoming-money rule books under requires_beleg = on, no receipt expected on a credit line', () => {
  const t = world();
  const [first] = debits(t, [1000], { cd: 'CRDT' });
  const ruleId = must(setBankStandard(t.ctx, { bankTxnId: first, accountId: t.acc('3400'), taxCode: null, idempotencyKey: 'rule-in' })).standard.id;
  must(settingsSet(t.ctx, { key: 'rules.autobook_offer_after', value: 3, reason: 'critic', idempotencyKey: 'oa-in' }));
  const g = grantedOn({ ...t, ruleId, firstLine: first }, 'CRDT');
  const [line] = debits(g, [1400], { cd: 'CRDT' });
  // Control: with the setting off the same line books (so the rule CAN autobook incoming money).
  const [control] = debits(g, [1450], { cd: 'CRDT' });
  receipt(g, { amount: 1400, vendor: TELCO, date: dateOf(g, line) });
  for (let i = 0; i < 3; i++) g.ap.tick();
  const reasons = must(autobookDigest(g.ctx, {})).waitingForBeleg.filter((w) => w.bankTxnId === line).map((w) => w.reason);
  must(settingsSet(g.ctx, { key: 'rules.autobook_requires_beleg', value: 'off', reason: 'critic', idempotencyKey: 'rb-off-in' }));
  g.ap.tick();
  assert.equal(decisionOf(g, control)?.state, 'booked', 'control: the incoming rule autobooks with the setting off');
  assert.deepEqual(reasons, [], `with the setting on, the incoming line waited ${JSON.stringify(reasons)} although its receipt is captured: no receipt can ever pair with a credit line`);
});

const denying = (t, denied) =>
  makeContext(t.store, {
    workspaceId: t.workspaceId,
    actor: 'user_1',
    clock: t.clock,
    ids: t.ids,
    capabilities: { assert: (c) => (denied.includes(c) ? err('permission_denied', { capability: c }) : ok()) },
  });

test('P3 fixed: autobook_digest shows a seat without the filing right one uniform waiting reason', () => {
  const t = grantedOn(ruleWorld({ taxCode: 'VST-M' }));
  const [none, two, vat] = debits(t, [1500, 1600, 1081]);
  const d = dateOf(t, two);
  const shift = (n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
  // Re-cut: trusted figures and one engine pass, so a reader's reasons really differ (control below).
  confirmedReceipt(t, { amount: 1600, vendor: TELCO, date: shift(-4) });
  confirmedReceipt(t, { amount: 1600, vendor: TELCO, date: shift(4) });
  confirmedReceipt(t, { amount: 1081, vendor: TELCO, date: dateOf(t, vat), vat: 70 });
  t.ap.tick();
  const reader = Object.fromEntries(must(autobookDigest(t.ctx, {})).waitingForBeleg.map((w) => [w.bankTxnId, w.reason]));
  assert.notEqual(reader[none], reader[vat], `control: a reader sees the receipt facts ${JSON.stringify(reader)}`);
  const noFiles = denying(t, ['read_master_data']);
  const seen = Object.fromEntries(must(autobookDigest(noFiles, {})).waitingForBeleg.map((w) => [w.bankTxnId, w.reason]));
  // A seat that may not read captured receipts learns, per line, whether receipts exist, how many, and
  // whether the hidden receipt's printed VAT differs: three distinguishable answers.
  const distinct = new Set([seen[none], seen[two], seen[vat]]);
  assert.equal(distinct.size, 1, `hidden receipt facts leak through the digest: ${JSON.stringify(seen)}`);
});
