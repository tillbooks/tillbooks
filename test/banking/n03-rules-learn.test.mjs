// N03 (D183): Buchungsregeln that learn. The rule's track record along its version chain (`bank_rule_stats`),
// the backtest (`backtest_bank_rule`), the miner (`mine_rules`: one Vorschlag per pattern, drafted as system,
// the rejection remembered by its key, the cap), and saving a rule from a booked line
// (`set_bank_standard { fromBankTxnId }`).
//
// SYNTHETIC DATA ONLY: every statement is spelled by hand in bank-inbox-support.mjs; the counterparties
// below are invented names on invented IBANs (TELCO_IBAN and the published samples), every amount invented.

import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { listBankInbox } from '../../dist/core/banking/index.js';
import { bookBankLine, reopenBankLine } from '../../dist/core/banking/bankBooking.js';
import { setBankStandard, clearBankStandard } from '../../dist/core/banking/bankStandards.js';
import { ruleStats } from '../../dist/core/banking/ruleStats.js';
import { backtestRule, mineRules, minedProposalFacts } from '../../dist/core/banking/ruleMiner.js';
import { approveDraftedAction, rejectDraftedAction } from '../../dist/core/agent/draftedActions.js';
import { settingsSet } from '../../dist/core/settings/settings.js';
import { getAction } from '../../dist/api/registry.js';
import { makeContext } from '../../dist/core/context.js';
import { createScheduler } from '../../dist/api/scheduler.js';
import { world, importLines, must, refused, assertClaimInvariantHolds, TELCO_IBAN } from './bank-inbox-support.mjs';

afterEach(assertClaimInvariantHolds);

const TELCO = 'Fernmeldewerk Beispiel AG';
const PRINT = 'Druckhaus Muster GmbH';
const PRINT_IBAN = 'CH5604835012345678009';

const proposalOf = (t, id) => must(listBankInbox(t.ctx, { bankTxnId: id, status: 'all' })).lines[0].proposal;
const toAccount = (t, id, number, minor, taxCode) =>
  must(bookBankLine(t.ctx, { bankTxnId: id, target: { kind: 'accounts', legs: [{ accountId: t.acc(number), amountMinor: minor, ...(taxCode ? { taxCode } : {}) }] }, idempotencyKey: `b-${id}` }));

/** Debit lines of one invented counterparty, by IBAN, dated through the month. */
function lines(t, statementId, name, iban, amounts, ustrd) {
  return importLines(t, {
    statementId,
    entries: amounts.map((a, i) => ({ ref: `L${i + 1}`, cd: 'DBIT', name, iban, amountMinor: a, date: `2026-07-${String(10 + i).padStart(2, '0')}`, ...(ustrd ? { ustrd } : {}) })),
  }).lines;
}

const mined = (t) => t.store.db.prepare("SELECT * FROM agent_action WHERE workspace_id = ? AND action_tool = 'set_bank_standard' ORDER BY rowid").all(t.workspaceId);

// ================================================================================================
// 1. The track record
// ================================================================================================

test('bank_rule_stats: uses, last use and changes follow the rule through an edit; the health flag reads the last five', () => {
  const t = world();
  const l = lines(t, 'BS-S1', TELCO, TELCO_IBAN, [1000, 1000, 1000, 1000, 1000, 1000, 1000]);
  const v1 = must(setBankStandard(t.ctx, { bankTxnId: l.L1, accountId: t.acc('6570'), taxCode: 'VST-M', idempotencyKey: 'v1' })).standard.id;
  must(bookBankLine(t.ctx, { bankTxnId: l.L2, target: proposalOf(t, l.L2).target, idempotencyKey: 's2' }));
  toAccount(t, l.L3, '6500', 1000);
  // An edit replaces v1 by v2 (the same slot); the chain keeps both.
  const v2 = must(setBankStandard(t.ctx, { standardId: v1, accountId: t.acc('6570'), taxCode: 'VST-M', label: 'Telefon', idempotencyKey: 'v2' })).standard.id;
  const row = t.store.db.prepare('SELECT replaces_id FROM bank_standard WHERE id = ?').get(v2);
  assert.equal(row.replaces_id, v1, 'the new version names the one it replaced');
  must(bookBankLine(t.ctx, { bankTxnId: l.L4, target: proposalOf(t, l.L4).target, idempotencyKey: 's4' }));
  toAccount(t, l.L5, '6500', 1000);
  let s = must(ruleStats(t.ctx, { standardId: v2 })).stats[0];
  assert.deepEqual(
    { uses: s.uses, changed: s.changed, lastFive: s.lastFive, currentVersion: s.currentVersion, health: s.health, versionIds: s.versionIds },
    { uses: 4, changed: 2, lastFive: { uses: 4, changed: 2 }, currentVersion: { uses: 2, changed: 1 }, health: 'adjust', versionIds: [v2, v1] },
  );
  assert.ok(typeof s.lastUsedAt === 'string');
  // The threshold is a setting: at 3 the same record is ok.
  must(settingsSet(t.ctx, { key: 'rules.health_changed_of_last5', value: 3, reason: 'N03 test', idempotencyKey: 'h3' }));
  s = must(ruleStats(t.ctx, { standardId: v2 })).stats[0];
  assert.equal(s.health, 'ok');
  // A reopened booking is no use any more; its rebooking (as proposed) is.
  must(reopenBankLine(t.ctx, { bankTxnId: l.L5, reason: 'falsch', idempotencyKey: 'undo5' }));
  must(bookBankLine(t.ctx, { bankTxnId: l.L5, target: proposalOf(t, l.L5).target, idempotencyKey: 's5b' }));
  s = must(ruleStats(t.ctx, { standardId: v2 })).stats[0];
  assert.deepEqual({ uses: s.uses, changed: s.changed }, { uses: 4, changed: 1 });
});

test('bank_rule_stats: a cleared rule ends its chain; a rule never used reads zero; a superseded or foreign id is rule_not_found', () => {
  const t = world();
  const l = lines(t, 'BS-S2', TELCO, TELCO_IBAN, [500, 500, 500]);
  const first = must(setBankStandard(t.ctx, { bankTxnId: l.L1, accountId: t.acc('6570'), taxCode: null, idempotencyKey: 'a' })).standard.id;
  must(bookBankLine(t.ctx, { bankTxnId: l.L2, target: proposalOf(t, l.L2).target, idempotencyKey: 'b2' }));
  must(clearBankStandard(t.ctx, { standardId: first, idempotencyKey: 'clr' }));
  const second = must(setBankStandard(t.ctx, { bankTxnId: l.L1, accountId: t.acc('6570'), taxCode: null, idempotencyKey: 'c' })).standard.id;
  const s = must(ruleStats(t.ctx, { standardId: second })).stats[0];
  assert.deepEqual({ uses: s.uses, lastUsedAt: s.lastUsedAt, versionIds: s.versionIds, health: s.health }, { uses: 0, lastUsedAt: null, versionIds: [second], health: 'ok' });
  refused(ruleStats(t.ctx, { standardId: first }), 'rule_not_found');
  refused(ruleStats(t.ctx, { standardId: 'bstd_nowhere' }), 'rule_not_found');
  const all = must(ruleStats(t.ctx, {})).stats.map((x) => x.standardId);
  assert.deepEqual(all, [second], 'every live bank rule, and only those');
});

// ================================================================================================
// 2. The backtest
// ================================================================================================

test('backtest_bank_rule: hits and identical bookings, the match text, open and ignored lines, since', () => {
  const t = world();
  const l = lines(t, 'BS-B1', PRINT, PRINT_IBAN, [2000, 3000, 4000, 5000, 6000], 'RECHNUNG DRUCK');
  toAccount(t, l.L1, '6600', 2000);
  toAccount(t, l.L2, '6600', 3000);
  toAccount(t, l.L3, '6500', 4000);
  must(getAction('ignore_bank_line').run({ ...t.deps, actor: 'user_1' }, { workspaceId: t.workspaceId, bankTxnId: l.L4, reason: 'other', idempotencyKey: 'ig4' }));
  const test1 = must(backtestRule(t.ctx, { recipe: { bankTxnId: l.L5, accountId: t.acc('6600') }, since: '2026-07-01' }));
  assert.deepEqual(
    { hits: test1.hits, identical: test1.identical, open: test1.openLines, ignored: test1.ignoredLines, direction: test1.direction },
    { hits: 3, identical: 2, open: 1, ignored: 1, direction: 'out' },
  );
  assert.deepEqual(test1.lines.map((x) => [x.bankTxnId, x.state, x.identical]), [
    [l.L5, 'open', null],
    [l.L4, 'ignored', null],
    [l.L3, 'booked', false],
    [l.L2, 'booked', true],
    [l.L1, 'booked', true],
  ]);
  const later = must(backtestRule(t.ctx, { recipe: { bankTxnId: l.L5, accountId: t.acc('6600') }, since: '2026-07-12' }));
  assert.equal(later.hits, 1, 'since bounds the booking date');
  const texted = must(backtestRule(t.ctx, { recipe: { bankTxnId: l.L5, accountId: t.acc('6600'), matchText: 'gutschrift' }, since: '2026-07-01' }));
  assert.equal(texted.hits + texted.openLines + texted.ignoredLines, 0, 'a match text the lines lack hits nothing');
  refused(backtestRule(t.ctx, { recipe: { accountId: t.acc('6600') } }), 'invalid_input');
  refused(backtestRule(t.ctx, { recipe: { bankTxnId: l.L5, legs: [] } }), 'invalid_recipe');
  refused(backtestRule(t.ctx, { recipe: { standardId: 'bstd_none', accountId: t.acc('6600') } }), 'rule_not_found');
});

test('backtest_bank_rule: a taxed recipe compares the posted VAT lines; an asked recipe compares the shape', () => {
  const t = world();
  const l = lines(t, 'BS-B2', TELCO, TELCO_IBAN, [10810, 5405, 3000]);
  toAccount(t, l.L1, '6570', 10810, 'VST-M');
  must(
    bookBankLine(t.ctx, {
      bankTxnId: l.L2,
      target: { kind: 'accounts', legs: [{ accountId: t.acc('6570'), amountMinor: 5000, taxCode: 'VST-M' }, { accountId: t.acc('6500'), amountMinor: 405 }] },
      idempotencyKey: 'split',
    }),
  );
  const taxed = must(backtestRule(t.ctx, { recipe: { bankTxnId: l.L3, accountId: t.acc('6570'), taxCode: 'VST-M' }, since: '2026-07-01' }));
  assert.deepEqual([taxed.hits, taxed.identical], [2, 1], 'the one-leg taxed booking is identical; the split is not');
  const asked = must(
    backtestRule(t.ctx, {
      recipe: {
        bankTxnId: l.L3,
        legs: [
          { accountId: t.acc('6500'), taxCode: null, amount: { kind: 'ask', label: 'Zusatz' } },
          { accountId: t.acc('6570'), taxCode: 'VST-M', amount: { kind: 'rest' } },
        ],
      },
      since: '2026-07-01',
    }),
  );
  assert.deepEqual([asked.hits, asked.identical], [2, 1], 'the asked recipe matches the split booking by its shape');
});

// ================================================================================================
// 3. The miner
// ================================================================================================

test('[INVARIANT miner] three lines booked alike become ONE Vorschlag drafted as system; a rerun drafts nothing; approving makes the rule', () => {
  const t = world();
  const l = lines(t, 'BS-M1', TELCO, TELCO_IBAN, [8990, 7990, 9990, 4500]);
  toAccount(t, l.L1, '6570', 8990, 'VST-M');
  toAccount(t, l.L2, '6570', 7990, 'VST-M');
  toAccount(t, l.L3, '6570', 9990, 'VST-M');
  const run = must(mineRules(t.ctx));
  assert.equal(run.groups.length, 1);
  assert.deepEqual({ ...run.groups[0], actionId: undefined, shapeHash: undefined }, {
    counterpartyKey: `iban:${TELCO_IBAN}`,
    direction: 'out',
    shapeHash: undefined,
    repeats: 3,
    bankTxnId: l.L3,
    outcome: 'drafted',
    actionId: undefined,
  });
  const rows = mined(t);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].actor, 'system', 'drafted as system, so the person who ran it may approve it');
  assert.equal(rows[0].dial_capability, null);
  assert.match(rows[0].idempotency_key, new RegExp(`^mine:iban:${TELCO_IBAN}:[0-9a-f]{12}$`));
  const payload = JSON.parse(rows[0].payload_json);
  assert.deepEqual(payload.legs, [{ accountId: t.acc('6570'), taxCode: 'VST-M', amount: { kind: 'rest' } }]);
  assert.equal(payload.label, TELCO);
  // Pendenzen's facts, computed when read.
  const facts = minedProposalFacts(t.ctx, payload);
  assert.deepEqual({ counterparty: facts.counterparty, repeats: facts.repeats, hits: facts.hits, evidence: facts.evidence.map((e) => e.bankTxnId) }, {
    counterparty: TELCO,
    repeats: 3,
    hits: 3,
    evidence: [l.L3, l.L2, l.L1],
  });
  // A rerun finds the open Vorschlag by its key: no second row.
  assert.equal(must(mineRules(t.ctx)).groups[0].outcome, 'open');
  assert.equal(mined(t).length, 1);
  // The person approves: the rule exists exactly as set_bank_standard makes it, and the next line proposes it.
  const approved = approveDraftedAction(t.ctx, (verb, input) => getAction(verb).run({ ...t.deps, actor: 'user_1' }, input), { actionId: rows[0].id });
  assert.equal(approved.ok, true, JSON.stringify(approved));
  assert.equal(proposalOf(t, l.L4).reasonCode, 'standard');
  // With the rule live the pattern is covered: nothing new is drafted.
  assert.deepEqual(must(mineRules(t.ctx)).groups.filter((g) => g.outcome === 'drafted'), []);
});

test('[INVARIANT miner] a rejected Vorschlag is never offered again for that counterparty and shape', () => {
  const t = world();
  const l = lines(t, 'BS-M2', TELCO, TELCO_IBAN, [100, 200, 300, 400]);
  for (const [ref, a] of [['L1', 100], ['L2', 200], ['L3', 300]]) toAccount(t, l[ref], '6500', a);
  must(mineRules(t.ctx));
  const row = mined(t)[0];
  must(rejectDraftedAction(t.ctx, { actionId: row.id, reason: 'nein' }));
  toAccount(t, l.L4, '6500', 400);
  const again = must(mineRules(t.ctx));
  assert.equal(again.groups[0].outcome, 'rejected');
  assert.equal(mined(t).length, 1, 'no second Vorschlag');
});

test('[INVARIANT miner] one differing leg or too few lines: no Vorschlag; the threshold and the switch are settings', () => {
  const t = world();
  const a = lines(t, 'BS-M3', TELCO, TELCO_IBAN, [100, 200, 300]);
  toAccount(t, a.L1, '6500', 100);
  toAccount(t, a.L2, '6500', 200);
  toAccount(t, a.L3, '6570', 300);
  assert.deepEqual(must(mineRules(t.ctx)).groups, [], 'two alike and one different: no group reaches three');
  must(settingsSet(t.ctx, { key: 'rules.miner_min_repeats', value: 2, reason: 'N03 test', idempotencyKey: 'mr2' }));
  assert.equal(must(mineRules(t.ctx)).groups.length, 1, 'the threshold is a setting');
  must(settingsSet(t.ctx, { key: 'rules.miner', value: 'off', reason: 'N03 test', idempotencyKey: 'off' }));
  assert.deepEqual(must(mineRules(t.ctx)), { ok: true, ran: false, since: null, considered: 0, groups: [], capped: 0, voided: [] });
});

test('[INVARIANT miner] at most rules.miner_max_open mined Vorschläge wait; the newest evidence comes first', () => {
  const t = world();
  const parties = ['Alpha Beispiel AG', 'Beta Beispiel AG', 'Gamma Beispiel AG'];
  // One statement (a second one for the same days would wait for its duplicate answer), names only.
  const l = importLines(t, {
    statementId: 'BS-C',
    entries: parties.flatMap((name, i) =>
      [1, 2, 3].map((n) => ({ ref: `C${i}${n}`, cd: 'DBIT', name, amountMinor: 1000 + n, date: `2026-07-${String(10 + i * 3 + n).padStart(2, '0')}` })),
    ),
  }).lines;
  parties.forEach((_, i) => {
    for (const n of [1, 2, 3]) toAccount(t, l[`C${i}${n}`], '6500', 1000 + n);
  });
  must(settingsSet(t.ctx, { key: 'rules.miner_max_open', value: 2, reason: 'N03 test', idempotencyKey: 'max2' }));
  const run = must(mineRules(t.ctx));
  assert.deepEqual(run.groups.map((g) => g.counterpartyKey), ['name:gamma beispiel', 'name:beta beispiel'], 'the newest evidence first');
  assert.equal(run.capped, 1);
  assert.equal(mined(t).length, 2);
});

test('mine_rules over the registry: a person runs it and may approve what it drafted (system drafted it, not them)', () => {
  const t = world();
  const l = lines(t, 'BS-M5', TELCO, TELCO_IBAN, [100, 200, 300]);
  for (const [ref, a] of [['L1', 100], ['L2', 200], ['L3', 300]]) toAccount(t, l[ref], '6500', a);
  const deps = { ...t.deps, actor: 'user_1' };
  const res = getAction('mine_rules').run(deps, { workspaceId: t.workspaceId });
  assert.equal(res.ok, true, JSON.stringify(res));
  const row = mined(t)[0];
  const ctx = makeContext(t.store, { workspaceId: t.workspaceId, actor: 'user_1', clock: t.clock, ids: t.ids });
  const approved = approveDraftedAction(ctx, (verb, input) => getAction(verb).run(deps, input), { actionId: row.id });
  assert.equal(approved.ok, true, JSON.stringify(approved));
});

test('the scheduler mines once a Swiss day per workspace, as system, and a later day mines again', () => {
  const t = world();
  const a = lines(t, 'BS-T1', TELCO, TELCO_IBAN, [100, 200, 300]);
  for (const [ref, x] of [['L1', 100], ['L2', 200], ['L3', 300]]) toAccount(t, a[ref], '6500', x);
  let at = new Date('2026-07-30T06:00:00Z');
  const scheduler = createScheduler({ ...t.deps, actor: 'system' }, { runDue: () => {}, bankAutoSync: false, now: () => at, listWorkspaceIds: () => [t.workspaceId] });
  scheduler.tickOnce();
  assert.equal(mined(t).length, 1, 'the first tick is the catch-up');
  assert.equal(mined(t)[0].actor, 'system');
  const b = importLines(t, {
    statementId: 'BS-T2',
    from: '2026-08-01',
    to: '2026-08-31',
    entries: [1, 2, 3].map((n) => ({ ref: `P${n}`, cd: 'DBIT', name: PRINT, amountMinor: 500 + n, date: `2026-08-0${n}` })),
  }).lines;
  for (const n of [1, 2, 3]) toAccount(t, b[`P${n}`], '6600', 500 + n);
  at = new Date('2026-07-30T20:00:00Z');
  scheduler.tickOnce();
  assert.equal(mined(t).length, 1, 'the same Swiss day does not mine twice');
  at = new Date('2026-07-30T22:30:00Z');
  scheduler.tickOnce();
  assert.equal(mined(t).length, 2, 'past midnight in Zurich is the next day');
});

test('Pendenzen: a mined Vorschlag carries its counterparty, repeats, backtest and evidence, and no "künftig automatisch"', () => {
  const t = world();
  const l = lines(t, 'BS-A1', TELCO, TELCO_IBAN, [100, 200, 300]);
  for (const [ref, x] of [['L1', 100], ['L2', 200], ['L3', 300]]) toAccount(t, l[ref], '6500', x);
  must(mineRules(t.ctx));
  const listed = getAction('attention_list').run({ ...t.deps, actor: 'user_1' }, { workspaceId: t.workspaceId, queueId: 'agent_action_bank' });
  assert.equal(listed.ok, true, JSON.stringify(listed));
  const items = JSON.stringify(listed);
  const item = (listed.items ?? listed.sections?.flatMap((s) => s.items) ?? []).find((i) => i.entityKind === 'agent_action');
  assert.ok(item !== undefined, `the mined Vorschlag is listed: ${items.slice(0, 400)}`);
  assert.deepEqual({ ...item.ruleProposal, since: undefined, evidence: item.ruleProposal.evidence.length }, {
    counterparty: TELCO,
    repeats: 3,
    since: undefined,
    hits: 3,
    identical: 3,
    bankTxnId: l.L3,
    evidence: 3,
  });
  assert.deepEqual(item.decisionOptions.map((o) => [o.id, o.labelKey]), [
    ['approve', 'attention.ruleProposed.create'],
    ['reject', 'attention.ruleProposed.dismiss'],
  ]);
});

test('backtest_bank_rule { fromBankTxnId }: the booked legs are the recipe tested, and the answer names them', () => {
  const t = world();
  const l = lines(t, 'BS-B3', TELCO, TELCO_IBAN, [5405, 7000]);
  must(
    bookBankLine(t.ctx, {
      bankTxnId: l.L1,
      target: { kind: 'accounts', legs: [{ accountId: t.acc('6570'), amountMinor: 5000, taxCode: 'VST-M' }, { accountId: t.acc('6500'), amountMinor: 405 }] },
      idempotencyKey: 'split',
    }),
  );
  const res = must(backtestRule(t.ctx, { recipe: { fromBankTxnId: l.L1 }, since: '2026-07-01' }));
  assert.deepEqual(res.recipe.legs.map((x) => [x.accountId, x.taxCode, x.amount.kind]), [
    [t.acc('6570'), 'VST-M', 'rest'],
    [t.acc('6500'), null, 'ask'],
  ]);
  assert.deepEqual([res.hits, res.identical, res.openLines], [1, 1, 1]);
  refused(backtestRule(t.ctx, { recipe: { fromBankTxnId: l.L2 } }), 'not_booked_to_accounts');
});

// ================================================================================================
// 4. Save from a booked line
// ================================================================================================

test('set_bank_standard { fromBankTxnId }: the booked legs become the rule; an open or ignored line refuses', () => {
  const t = world();
  const l = lines(t, 'BS-F1', TELCO, TELCO_IBAN, [5405, 1000, 1000]);
  must(
    bookBankLine(t.ctx, {
      bankTxnId: l.L1,
      target: { kind: 'accounts', legs: [{ accountId: t.acc('6570'), amountMinor: 5000, taxCode: 'VST-M' }, { accountId: t.acc('6500'), amountMinor: 405 }] },
      idempotencyKey: 'split',
    }),
  );
  const saved = must(setBankStandard(t.ctx, { fromBankTxnId: l.L1, idempotencyKey: 'from' })).standard;
  assert.deepEqual(
    saved.legs.map((x) => [x.accountNumber, x.taxCode, x.amount]),
    [
      ['6570', 'VST-M', { kind: 'rest' }],
      ['6500', null, { kind: 'ask', label: 'Verwaltungs- und Bürokosten' }],
    ],
  );
  assert.equal(saved.counterpartyKey, `iban:${TELCO_IBAN}`);
  refused(setBankStandard(t.ctx, { fromBankTxnId: l.L2, idempotencyKey: 'open' }), 'not_booked_to_accounts');
  must(getAction('ignore_bank_line').run({ ...t.deps, actor: 'user_1' }, { workspaceId: t.workspaceId, bankTxnId: l.L3, reason: 'other', idempotencyKey: 'ig' }));
  refused(setBankStandard(t.ctx, { fromBankTxnId: l.L3, idempotencyKey: 'ign' }), 'not_booked_to_accounts');
  refused(setBankStandard(t.ctx, { fromBankTxnId: l.L1, bankTxnId: l.L2, idempotencyKey: 'two' }), 'invalid_input');
  // Given legs win over the booking's.
  const own = must(setBankStandard(t.ctx, { fromBankTxnId: l.L1, accountId: t.acc('6500'), taxCode: null, matchText: 'EXTRA', idempotencyKey: 'own' })).standard;
  assert.deepEqual(own.legs.map((x) => x.accountNumber), ['6500']);
});
