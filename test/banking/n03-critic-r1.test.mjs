// N03 (D183), the non-author critic's round 1 on the rule-writing side, each probe turned into a test that
// fails on the defect it found:
//   1. a mined Vorschlag approved after the person set their own rule for the pattern replaced that rule;
//   2. a drafted set_bank_standard { fromBankTxnId } without legs saved the booking as it stood at APPROVAL;
//   3. a `same` leg compared as any amount of its sign;
//   4. a rule edited between viewing and booking (kept conservative: the booking charges the new version);
//   5. mine_rules was automatable, and Pendenzen re-ran a backtest per mined card per read;
//   6. an agent could pre-claim the miner's key and silence its proposal.
//
// SYNTHETIC DATA ONLY: the statements are spelled by hand in bank-inbox-support.mjs; the counterparty is an
// invented name on the invented TELCO_IBAN; every amount is invented.

import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { listBankInbox } from '../../dist/core/banking/index.js';
import { bookBankLine, reopenBankLine } from '../../dist/core/banking/bankBooking.js';
import { setBankStandard } from '../../dist/core/banking/bankStandards.js';
import { mineRules } from '../../dist/core/banking/ruleMiner.js';
import { LEGS_MATCH_BUDGET, expectedRuleLegs, legsMatch, ruleStats } from '../../dist/core/banking/ruleStats.js';
import { approveDraftedAction, enqueueDraftedAction } from '../../dist/core/agent/draftedActions.js';
import { NOT_AUTOMATABLE, NOT_AUTOMATABLE_LEGS } from '../../dist/core/automation/denylist.js';
import { getAction } from '../../dist/api/registry.js';
import { world, importLines, must, refused, assertClaimInvariantHolds, TELCO_IBAN } from './bank-inbox-support.mjs';

afterEach(assertClaimInvariantHolds);

const TELCO = 'Fernmeldewerk Beispiel AG';
const proposalOf = (t, id) => must(listBankInbox(t.ctx, { bankTxnId: id, status: 'all' })).lines[0].proposal;
const decisionOf = (t, id) => ({
  ...t.store.db
    .prepare('SELECT proposed_rule_id AS ruleId, rule_changed AS changed FROM bank_line_decision WHERE workspace_id = ? AND bank_txn_id = ? AND superseded_at IS NULL')
    .get(t.workspaceId, id),
});
const approve = (t, actionId) => approveDraftedAction(t.ctx, (verb, input) => getAction(verb).run({ ...t.deps, actor: 'user_1' }, input), { actionId });
const liveBankRules = (t) => t.store.db.prepare("SELECT id FROM bank_standard WHERE workspace_id = ? AND superseded_at IS NULL AND scope = 'bank'").all(t.workspaceId).map((r) => r.id);

function telco(t, sid, refs, amount = 10000) {
  return importLines(t, {
    statementId: sid,
    entries: refs.map((ref, i) => ({ ref, cd: 'DBIT', name: TELCO, iban: TELCO_IBAN, amountMinor: amount, date: `2026-07-${String(10 + i).padStart(2, '0')}` })),
  }).lines;
}

/** Three lines booked alike to 6570 (VST-M), then the miner's Vorschlag for them. */
function minedWorld() {
  const t = world();
  const l = telco(t, 'CR-1', ['L1', 'L2', 'L3', 'L4', 'L5'], 4500);
  for (const id of [l.L1, l.L2, l.L3]) {
    must(bookBankLine(t.ctx, { bankTxnId: id, target: { kind: 'accounts', legs: [{ accountId: t.acc('6570'), amountMinor: 4500, taxCode: 'VST-M' }] }, idempotencyKey: `b-${id}` }));
  }
  const run = must(mineRules(t.ctx));
  assert.equal(run.groups[0].outcome, 'drafted');
  return { t, l, actionId: run.groups[0].actionId };
}

// ================================================================================================
// Finding 1: a stale mined Vorschlag never replaces the person's newer rule
// ================================================================================================

test('[critic 1] approved late, a mined Vorschlag refuses rule_slot_changed and the person\'s own rule stays', () => {
  const { t, l, actionId } = minedWorld();
  const own = must(setBankStandard(t.ctx, { bankTxnId: l.L4, accountId: t.acc('6500'), taxCode: null, idempotencyKey: 'own' })).standard.id;
  const res = approve(t, actionId);
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.equal(res.error, 'rule_slot_changed');
  assert.deepEqual(liveBankRules(t), [own], 'the person\'s rule is the only live one');
  assert.equal(proposalOf(t, l.L5).reasonParams.standardId, own);
});

test('[critic 1] the next miner run voids a pending card whose pattern a rule now covers; it leaves Pendenzen', () => {
  const { t, l, actionId } = minedWorld();
  must(setBankStandard(t.ctx, { bankTxnId: l.L4, accountId: t.acc('6500'), taxCode: null, matchText: null, idempotencyKey: 'own' }));
  const rerun = must(mineRules(t.ctx));
  assert.deepEqual(rerun.voided, [actionId]);
  const row = t.store.db.prepare('SELECT status FROM agent_action WHERE id = ?').get(actionId);
  assert.equal(row.status, 'stale');
  refused(approve(t, actionId), 'vorschlag_stale');
  const listed = getAction('attention_list').run({ ...t.deps, actor: 'user_1' }, { workspaceId: t.workspaceId, queueId: 'agent_action_bank' });
  assert.equal(JSON.stringify(listed).includes(actionId), false, 'a voided card is not listed');
});

test('[critic 1] untouched, the mined Vorschlag still makes its rule when approved', () => {
  const { t, l, actionId } = minedWorld();
  assert.equal(approve(t, actionId).ok, true);
  assert.equal(proposalOf(t, l.L5).reasonCode, 'standard');
});

// ================================================================================================
// Finding 2: what you approved is what runs (no legless save from a booked line in a Vorschlag)
// ================================================================================================

test('[critic 2] a drafted save from a booked line without legs is refused at draft time (governed seat) and at approval', () => {
  const t = world();
  const l = telco(t, 'CR-2', ['L1'], 5000);
  must(bookBankLine(t.ctx, { bankTxnId: l.L1, target: { kind: 'accounts', legs: [{ accountId: t.acc('6570'), amountMinor: 5000, taxCode: 'VST-M' }] }, idempotencyKey: 'b1' }));
  const screen = getAction('set_bank_standard').prevalidate;
  assert.equal(typeof screen, 'function', 'set_bank_standard screens a governed seat before drafting');
  const refusedAtDraft = screen({ ...t.deps, actor: 'agent' }, { workspaceId: t.workspaceId, fromBankTxnId: l.L1, idempotencyKey: 'from-l1' });
  assert.equal(refusedAtDraft?.error, 'legs_required');
  assert.equal(screen({ ...t.deps, actor: 'agent' }, { workspaceId: t.workspaceId, fromBankTxnId: l.L1, legs: [{ accountId: t.acc('6570'), taxCode: 'VST-M', amount: { kind: 'rest' } }], idempotencyKey: 'ok' }), undefined);
  // A draft that got past the screen (enqueued directly): the approval refuses, nothing is saved from the line
  // as it stands after it was reopened and booked elsewhere.
  const drafted = must(enqueueDraftedAction({ ...t.ctx, actor: 'agent_probe' }, { actionTool: 'set_bank_standard', payload: { workspaceId: t.workspaceId, fromBankTxnId: l.L1, idempotencyKey: 'from-l1' }, dialCapability: 'post' }));
  must(reopenBankLine(t.ctx, { bankTxnId: l.L1, reason: 'falsch', idempotencyKey: 'r1' }));
  must(bookBankLine(t.ctx, { bankTxnId: l.L1, target: { kind: 'accounts', legs: [{ accountId: t.acc('6500'), amountMinor: 5000 }] }, idempotencyKey: 'b2' }));
  const res = approve(t, drafted.actionId);
  assert.equal(res.ok, false);
  assert.equal(res.error, 'legs_required');
  assert.deepEqual(liveBankRules(t), [], 'no rule was saved');
  // A person's own direct save from the line still prefills (the Studio sends legs anyway).
  assert.equal(must(setBankStandard(t.ctx, { fromBankTxnId: l.L1, idempotencyKey: 'direct' })).standard.legs[0].accountId, t.acc('6500'));
});

// ================================================================================================
// Finding 3: a `same` leg is tied to the amount it copies
// ================================================================================================

test('[critic 3] a booking no version of a same-leg rule can produce reads as changed; the tied booking as unchanged', () => {
  const t = world();
  const l = telco(t, 'CR-3', ['R', 'X', 'Y']);
  const rule = must(
    setBankStandard(t.ctx, {
      bankTxnId: l.R,
      legs: [
        { accountId: t.acc('6570'), taxCode: null, amount: { kind: 'ask', label: 'Anteil' } },
        { accountId: t.acc('6500'), taxCode: null, amount: { kind: 'same', legIndex: 0 } },
        { accountId: t.acc('6000'), taxCode: null, amount: { kind: 'rest' } },
      ],
      idempotencyKey: 'same',
    }),
  ).standard.id;
  const legs = (a, b, c) => [
    { accountId: t.acc('6570'), amountMinor: a },
    { accountId: t.acc('6500'), amountMinor: b },
    { accountId: t.acc('6000'), amountMinor: c },
  ];
  must(bookBankLine(t.ctx, { bankTxnId: l.X, target: { kind: 'accounts', legs: legs(1000, 7000, 2000) }, idempotencyKey: 'x' }));
  assert.deepEqual(decisionOf(t, l.X), { ruleId: rule, changed: 1 });
  must(bookBankLine(t.ctx, { bankTxnId: l.Y, target: { kind: 'accounts', legs: legs(3000, 3000, 4000) }, idempotencyKey: 'y' }));
  assert.deepEqual(decisionOf(t, l.Y), { ruleId: rule, changed: 0 });
});

// ================================================================================================
// Finding 4: an edit between viewing and booking (conservative, documented in the spec)
// ================================================================================================

test('[critic 4] a booking of the proposal the person saw before an edit counts as a change of the new version', () => {
  const t = world();
  const l = telco(t, 'CR-4', ['R', 'X'], 2000);
  const v1 = must(setBankStandard(t.ctx, { bankTxnId: l.R, accountId: t.acc('6570'), taxCode: 'VST-M', idempotencyKey: 'v1' })).standard.id;
  const shown = proposalOf(t, l.X).target;
  const v2 = must(setBankStandard(t.ctx, { standardId: v1, accountId: t.acc('6500'), taxCode: null, idempotencyKey: 'v2' })).standard.id;
  must(bookBankLine(t.ctx, { bankTxnId: l.X, target: shown, idempotencyKey: 'x' }));
  // Conservative by design (N03 §2): the rule standing on the line when it was booked is v2, and the legs are
  // not v2's, so the use is never clean evidence for v2's autonomy (N04).
  assert.deepEqual(decisionOf(t, l.X), { ruleId: v2, changed: 1 });
  const s = must(ruleStats(t.ctx, { standardId: v2 })).stats[0];
  assert.deepEqual(s.currentVersion, { uses: 1, changed: 1 });
});

// ================================================================================================
// Finding 5: mine_rules is the scheduler's, and Pendenzen reads the stored evidence
// ================================================================================================

test('[critic 5] mine_rules is on the G01 denylist (leg e)', () => {
  assert.equal(NOT_AUTOMATABLE.has('mine_rules'), true);
  assert.deepEqual(NOT_AUTOMATABLE_LEGS.mine_rules, ['e']);
});

test('[critic 5] the evidence is stored in the Vorschlag at draft time; listing Pendenzen runs no backtest', () => {
  const { t, actionId } = minedWorld();
  const payload = JSON.parse(t.store.db.prepare('SELECT payload_json FROM agent_action WHERE id = ?').get(actionId).payload_json);
  assert.deepEqual({ ...payload.minedFacts, since: undefined, evidence: payload.minedFacts.evidence.length }, {
    counterparty: TELCO,
    repeats: 3,
    since: undefined,
    hits: 3,
    identical: 3,
    evidence: 3,
  });
  assert.equal(payload.expectSlotStandardId, null, 'the slot was empty when it was drafted');
  const db = t.store.db;
  const original = db.prepare;
  const seen = [];
  db.prepare = function (text) {
    seen.push(String(text));
    return original.call(this, text);
  };
  try {
    const listed = getAction('attention_list').run({ ...t.deps, actor: 'user_1' }, { workspaceId: t.workspaceId, queueId: 'agent_action_bank' });
    assert.equal(listed.ok, true);
    assert.ok(JSON.stringify(listed).includes('"repeats":3'), 'the card carries the stored facts');
  } finally {
    db.prepare = original;
  }
  assert.deepEqual(seen.filter((s) => s.includes('LEFT JOIN bank_line_decision dec')), [], 'no backtest read on a Pendenzen read');
});

// ================================================================================================
// Finding 6: the miner's key prefix is reserved, and only the miner's rows answer for a pattern
// ================================================================================================

test('[critic 6] keys under mine: are reserved: refused directly and at draft time, while the miner keeps its own row and write', () => {
  const t = world();
  const l = telco(t, 'CR-6', ['L1', 'L2', 'L3'], 4500);
  refused(setBankStandard(t.ctx, { bankTxnId: l.L1, accountId: t.acc('6570'), taxCode: null, idempotencyKey: 'mine:squat' }), 'invalid_input');
  const screen = getAction('set_bank_standard').prevalidate;
  assert.equal(screen({ ...t.deps, actor: 'agent' }, { workspaceId: t.workspaceId, bankTxnId: l.L1, accountId: t.acc('6570'), idempotencyKey: 'mine:squat' })?.error, 'invalid_input');
  // The miner itself drafts under the reserved prefix (its Vorschlag row), and its rule write under a minted key.
  for (const id of [l.L1, l.L2, l.L3]) {
    must(bookBankLine(t.ctx, { bankTxnId: id, target: { kind: 'accounts', legs: [{ accountId: t.acc('6570'), amountMinor: 4500, taxCode: 'VST-M' }] }, idempotencyKey: `b-${id}` }));
  }
  const first = must(mineRules(t.ctx)).groups[0];
  const row = t.store.db.prepare('SELECT actor, idempotency_key AS k, payload_json FROM agent_action WHERE id = ?').get(first.actionId);
  assert.equal(row.actor, 'system');
  assert.match(row.k, /^mine:/);
  assert.doesNotMatch(JSON.parse(row.payload_json).idempotencyKey, /^mine:/, 'the save the approval replays carries no reserved key');
  assert.equal(approve(t, first.actionId).ok, true, 'and the approval is not refused by the reservation');
});

// ================================================================================================
// Security review of the finding-3 fix: the leg pairing is bounded
// ================================================================================================

test('[security] twenty legs pair (or fail) fast: identical legs, a failing sign, ties, and the budget', () => {
  const a = (i) => `acc_${i}`;
  const ask = (accountId) => ({ accountId, taxCode: null, amount: { kind: 'ask', label: 'x' } });
  const rest = (accountId) => ({ accountId, taxCode: null, amount: { kind: 'rest' } });
  const b = (accountId, amountMinor) => ({ accountId, amountMinor, taxCode: null });
  const timed = (fn) => {
    const t0 = performance.now();
    const answer = fn();
    return { answer, ms: performance.now() - t0 };
  };
  // 19 asked legs on ONE account and a rest: every booked leg fits every asked leg (the factorial case).
  const sameAccount = [...Array.from({ length: 19 }, () => ask(a(1))), rest(a(2))];
  const expected = expectedRuleLegs(sameAccount, 100_000, false);
  const good = [...Array.from({ length: 19 }, (_, i) => b(a(1), 100 + i)), b(a(2), 50_000)];
  const okRun = timed(() => legsMatch(expected, good));
  assert.equal(okRun.answer, true);
  // One asked leg booked against the direction: no pairing exists, and proving it must not explode.
  const bad = [...Array.from({ length: 18 }, (_, i) => b(a(1), 100 + i)), b(a(1), -5), b(a(2), 50_000)];
  const badRun = timed(() => legsMatch(expected, bad));
  assert.equal(badRun.answer, false);
  // Ten asked legs and nine `same` legs copying them, on two accounts, booked consistently and then not.
  const tied = [
    ...Array.from({ length: 10 }, () => ask(a(1))),
    ...Array.from({ length: 9 }, (_, i) => ({ accountId: a(3), taxCode: null, amount: { kind: 'same', legIndex: i } })),
    rest(a(2)),
  ];
  const tiedExpected = expectedRuleLegs(tied, 100_000, false);
  const tiedGood = [...Array.from({ length: 10 }, (_, i) => b(a(1), 200 + i)), ...Array.from({ length: 9 }, (_, i) => b(a(3), 200 + i)), b(a(2), 1)];
  const tiedBad = [...Array.from({ length: 10 }, (_, i) => b(a(1), 200 + i)), ...Array.from({ length: 9 }, (_, i) => b(a(3), 300 + i)), b(a(2), 1)];
  const tiedOk = timed(() => legsMatch(tiedExpected, tiedGood));
  const tiedNo = timed(() => legsMatch(tiedExpected, tiedBad));
  assert.equal(tiedOk.answer, true);
  assert.equal(tiedNo.answer, false);
  for (const [name, run] of [['identical', okRun], ['failing sign', badRun], ['ties', tiedOk], ['ties failing', tiedNo]]) {
    assert.ok(run.ms < 1000, `${name} took ${run.ms.toFixed(0)} ms`);
  }
  assert.ok(LEGS_MATCH_BUDGET > 0 && LEGS_MATCH_BUDGET <= 100_000, 'a budget caps the search; past it the booking reads as changed');
});
