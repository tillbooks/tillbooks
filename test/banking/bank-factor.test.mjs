// D177 (spec A39 §16.1, §16.4): COMPUTED amounts in a Buchungsregel (`{ kind: 'factor', label, num, den,
// explain? }`), the `rule_computed` rung, the setting `bank.buchungsregel_computed_mode`, compose parity,
// the pin on a factor edit, and the agent drafts (validated like a direct call before they are pinned, one
// pending Vorschlag per line). Every bullet of the §16.4 engine list has a test here, named after it; the
// money-path invariants are marked [INVARIANT ...] for the non-author critic, each naming in its comment
// the code it guards, so a mutation of that code fails it.
//
// SYNTHETIC DATA ONLY: every statement is spelled by hand in bank-inbox-support.mjs; the payout service is
// an invented name and every amount is invented. The worked example of the brief: a 30.00 payout with the
// fraction 1081/180 (MWST 8.1 % plus a 9.9 % fee on the net) gives a computed gross of 180.17.

import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  createBankAccount,
  listBankInbox,
  bookBankLine,
  ignoreBankLine,
  setBankStandard,
  listBankStandards,
  lineNeedsReview,
  isProposalBookable,
} from '../../dist/core/banking/index.js';
import { composeBankLine } from '../../dist/core/banking/bankBooking.js';
import { factorAmountMinor } from '../../dist/core/banking/bankStandards.js';
import { getAction } from '../../dist/api/registry.js';
import { runGoverned } from '../../dist/api/agent-gate.js';
import { createAccount, archiveAccount } from '../../dist/core/accounts/accounts.js';
import { settingsSet } from '../../dist/core/settings/index.js';
import { enqueueDraftedAction } from '../../dist/core/agent/index.js';
import { makeContext } from '../../dist/core/context.js';
import { seedRate } from '../payments/support.mjs';
import { world, secondWorkspace, importLines, postedBill, must, refused, legs as entryLegs, rowCounts, SAVINGS_IBAN } from './bank-inbox-support.mjs';
import { prevalidateBookBankLine, prevalidateIgnoreBankLine, reopenBankLine } from '../../dist/core/banking/index.js';
import { assertClaimInvariantHolds } from './bank-inbox-support.mjs';

afterEach(assertClaimInvariantHolds);

const PAYOUT = 'Zahlwerk Beispiel Ltd';
const lineOf = (t, id, ctx = t.ctx) => must(listBankInbox(ctx, { status: 'all' }), 'inbox').lines.find((l) => l.bankTxnId === id);
const proposalOf = (t, id, ctx = t.ctx) => lineOf(t, id, ctx).proposal;
const standardRows = (t, ws = t.workspaceId) => t.store.db.prepare('SELECT * FROM bank_standard WHERE workspace_id = ? ORDER BY rowid').all(ws);
const draftRows = (t, ws = t.workspaceId) =>
  t.store.db.prepare('SELECT id, action_tool, status, reject_reason, resolved_by, payload_json FROM agent_action WHERE workspace_id = ? ORDER BY rowid').all(ws);

/** The world plus the Durchlaufkonto 1095 (a balance account the KMU seed does not carry). */
function factorWorld() {
  const t = world();
  must(createAccount(t.ctx, { number: '1095', name: 'Erlös Durchlaufkonto', type: 'asset', idempotencyKey: 'acc-1095' }), '1095');
  return t;
}

/** Payout lines from the invented payout service. */
function payouts(t, statementId, entries) {
  return importLines(t, { statementId, entries: entries.map((e) => ({ cd: 'CRDT', name: PAYOUT, ...e })) }).lines;
}

/** The worked recipe: the gross on 3400 with UST81 COMPUTED as 1081/180 of the payout, the rest to 4400. */
function grossRecipe(t, { num = 1081, den = 180, explain = { vatBp: 810, feeBp: 990 } } = {}) {
  return [
    { accountId: t.acc('3400'), taxCode: 'UST81', amount: { kind: 'factor', label: 'Bruttoumsatz', num, den, ...(explain !== null ? { explain } : {}) } },
    { accountId: t.acc('4400'), taxCode: null, amount: { kind: 'rest' } },
  ];
}

/** One payout line of 30.00 and the worked rule on it (via 1095). */
function workedExample(t, { key = 'w', amountMinor = 3000, recipe = grossRecipe(t) } = {}) {
  // Each call its own entry reference: a camt entry is keyed on it, so a repeat would be a duplicate.
  const ref = `P-${key}`;
  const l = payouts(t, `BS-${key}`, [{ ref, amountMinor, ustrd: `AUSZAHLUNG ${key.toUpperCase()}` }]);
  const rule = must(setBankStandard(t.ctx, { bankTxnId: l[ref], legs: recipe, viaAccountId: t.acc('1095'), label: 'Plattform', idempotencyKey: `${key}-set` })).standard;
  return { line: l[ref], rule };
}

/** The agent seat's governed door, and a person's approval. */
const agentDeps = (t) => ({ store: t.store, clock: t.clock, ids: t.ids, actor: 'agent' });
const governed = (t, name, input) => runGoverned(agentDeps(t), getAction(name), { workspaceId: t.workspaceId, ...input });
const approve = (t, actionId) => getAction('approve_drafted_action').run({ store: t.store, clock: t.clock, ids: t.ids, actor: 'studio' }, { workspaceId: t.workspaceId, actionId });

// ================================================================================================
// 1. The rounding: exact, half up, in Rappen
// ================================================================================================

test('factor rounding: round-half-up(|line| x num / den) in Rappen, exact; the worked example is 180.17', () => {
  assert.equal(factorAmountMinor(3000, 1081, 180), 18017, '30.00 x 1081/180 = 180.1666.. -> 180.17');
  assert.equal(factorAmountMinor(-3000, 1081, 180), 18017, 'the line amount is taken absolute');
  assert.equal(factorAmountMinor(1, 1, 2), 1, '0.5 Rappen rounds up');
  assert.equal(factorAmountMinor(3, 1, 2), 2, '1.5 rounds up');
  assert.equal(factorAmountMinor(5, 1, 10), 1, '0.5 rounds up');
  assert.equal(factorAmountMinor(4, 1, 10), 0, '0.4 rounds down to 0');
  assert.equal(factorAmountMinor(14, 1, 10), 1, '1.4 rounds down');
  assert.equal(factorAmountMinor(15, 1, 10), 2, '1.5 rounds up');
  assert.equal(factorAmountMinor(Number.MAX_SAFE_INTEGER, 2, 1), null, 'beyond a safe integer is no amount');
  // A sweep against an independent BigInt reference (floor(x + 1/2) via the remainder), so no float
  // product ever decides a Rappen.
  let seed = 7;
  const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648);
  for (let i = 0; i < 3000; i += 1) {
    const a = next() % 10_000_000;
    const n = 1 + (next() % 5000);
    const d = 1 + (next() % 5000);
    const prod = BigInt(a) * BigInt(n);
    const q = prod / BigInt(d);
    const r = prod % BigInt(d);
    const want = Number(2n * r >= BigInt(d) ? q + 1n : q);
    assert.equal(factorAmountMinor(a, n, d), want, `${a} x ${n}/${d}`);
  }
});

// ================================================================================================
// 2. The recipe: shape, storage, refusals
// ================================================================================================

test('set_bank_standard stores a factor leg canonically and lists it; the same recipe again is unchanged', () => {
  const t = factorWorld();
  const { line, rule } = workedExample(t);
  assert.deepEqual(rule.legs.map((x) => [x.accountNumber, x.taxCode, x.amount]), [
    ['3400', 'UST81', { kind: 'factor', label: 'Bruttoumsatz', num: 1081, den: 180, explain: { vatBp: 810, feeBp: 990 } }],
    ['4400', null, { kind: 'rest' }],
  ]);
  const stored = standardRows(t)[0];
  assert.equal(
    stored.legs_json,
    JSON.stringify([
      { accountId: t.acc('3400'), taxCode: 'UST81', amount: { kind: 'factor', label: 'Bruttoumsatz', num: 1081, den: 180, explain: { vatBp: 810, feeBp: 990 } } },
      { accountId: t.acc('4400'), taxCode: null, amount: { kind: 'rest' } },
    ]),
    'canonical: fixed key order, explain in vatBp, feeBp order',
  );
  // Explain keys in the other order and a padded label are the same recipe.
  const again = must(
    setBankStandard(t.ctx, {
      bankTxnId: line,
      legs: [
        { accountId: t.acc('3400'), taxCode: 'UST81', amount: { den: 180, num: 1081, label: ' Bruttoumsatz ', kind: 'factor', explain: { feeBp: 990, vatBp: 810 } } },
        { accountId: t.acc('4400'), taxCode: null, amount: { kind: 'rest' } },
      ],
      viaAccountId: t.acc('1095'),
      label: 'Plattform',
      idempotencyKey: 'w-set-2',
    }),
  );
  assert.equal(again.unchanged, true);
  assert.equal(standardRows(t).length, 1);
  assert.deepEqual(must(listBankStandards(t.ctx, {})).standards[0].legs[0].amount, rule.legs[0].amount);
});

test('every malformed factor refuses invalid_recipe detail factor naming the field; a Vorlage refuses factor; same may not name a factor leg', () => {
  const t = factorWorld();
  const l = payouts(t, 'BS-R', [{ ref: 'P1', amountMinor: 3000, ustrd: 'AUSZAHLUNG R' }]);
  const leg = (amount) => [
    { accountId: t.acc('3400'), taxCode: null, amount },
    { accountId: t.acc('4400'), taxCode: null, amount: { kind: 'rest' } },
  ];
  const cases = [
    [{ kind: 'factor', label: '', num: 1, den: 2 }, 'label'],
    [{ kind: 'factor', label: 'x'.repeat(41), num: 1, den: 2 }, 'label'],
    [{ kind: 'factor', label: 'Gebühr', num: 0, den: 2 }, 'num'],
    [{ kind: 'factor', label: 'Gebühr', num: -1, den: 2 }, 'num'],
    [{ kind: 'factor', label: 'Gebühr', num: 1.5, den: 2 }, 'num'],
    [{ kind: 'factor', label: 'Gebühr', num: '1', den: 2 }, 'num'],
    [{ kind: 'factor', label: 'Gebühr', num: 1, den: 0 }, 'den'],
    [{ kind: 'factor', label: 'Gebühr', num: 1, den: 2 ** 53 }, 'den'],
    [{ kind: 'factor', label: 'Gebühr', num: 1, den: 2, explain: [] }, 'explain'],
    [{ kind: 'factor', label: 'Gebühr', num: 1, den: 2, explain: { rateBp: 5 } }, 'explain.rateBp'],
    [{ kind: 'factor', label: 'Gebühr', num: 1, den: 2, explain: { vatBp: 10001 } }, 'explain.vatBp'],
    [{ kind: 'factor', label: 'Gebühr', num: 1, den: 2, explain: { feeBp: -1 } }, 'explain.feeBp'],
    // Critic D177-C5: bounded at save time (each term up to 1'000'000, the amount at most 1000 x the line).
    [{ kind: 'factor', label: 'Gebühr', num: 1_000_001, den: 1_000_000 }, 'num'],
    [{ kind: 'factor', label: 'Gebühr', num: 1, den: 1_000_001 }, 'den'],
    [{ kind: 'factor', label: 'Gebühr', num: 1001, den: 1 }, 'num'],
  ];
  for (const [amount, field] of cases) {
    const r = refused(setBankStandard(t.ctx, { bankTxnId: l.P1, legs: leg(amount), idempotencyKey: `r-${field}-${JSON.stringify(amount)}` }), 'invalid_recipe', field);
    assert.equal(r.detail, 'factor', JSON.stringify(amount));
    assert.equal(r.field, field, JSON.stringify(amount));
    assert.equal(r.legIndex, 0);
  }
  // A Vorlage has no line to compute from.
  const v = refused(
    setBankStandard(t.ctx, {
      scope: 'manual',
      label: 'Monatsabgrenzung',
      legs: [
        { accountId: t.acc('3400'), taxCode: null, side: 'credit', amount: { kind: 'factor', label: 'Anteil', num: 1, den: 2 } },
        { accountId: t.acc('4400'), taxCode: null, side: 'debit', amount: { kind: 'rest' } },
      ],
      idempotencyKey: 'r-manual',
    }),
    'invalid_recipe',
  );
  assert.equal(v.detail, 'factor');
  // `same` copies an ASKED amount only.
  const s = refused(
    setBankStandard(t.ctx, {
      bankTxnId: l.P1,
      legs: [
        { accountId: t.acc('3400'), taxCode: null, amount: { kind: 'factor', label: 'Gebühr', num: 1, den: 2 } },
        { accountId: t.acc('6500'), taxCode: null, amount: { kind: 'same', legIndex: 0 } },
        { accountId: t.acc('4400'), taxCode: null, amount: { kind: 'rest' } },
      ],
      idempotencyKey: 'r-same',
    }),
    'invalid_recipe',
  );
  assert.equal(s.detail, 'same_target');
  assert.equal(standardRows(t).length, 0, 'no refusal wrote a row');
});

// ================================================================================================
// 3. The rung: rule_computed, suggest vs bulk, attention, A36's review signal
// ================================================================================================

test('a computed-only recipe proposes { kind: rule, asks: {} }, reason rule_computed, check by default, with reasonParams.computed', () => {
  const t = factorWorld();
  const { line, rule } = workedExample(t);
  const l = lineOf(t, line);
  assert.deepEqual(l.proposal, {
    target: { kind: 'rule', standardId: rule.id, asks: {} },
    certainty: 'check',
    reasonCode: 'rule_computed',
    reasonParams: { standardId: rule.id, computed: [{ legIndex: 0, label: 'Bruttoumsatz', amountMinor: 18017, explain: { vatBp: 810, feeBp: 990 } }] },
    vatCode: null,
  });
  assert.equal(l.attention, 'needs', 'an estimate deserves a look: never in the bulk button by default');
  assert.equal(l.standardId, rule.id, 'the line names the rule its proposal used');
  // A36: the review signal stays on for a `check` computed proposal.
  assert.equal(lineNeedsReview(t.ctx, t.store.db.prepare('SELECT * FROM bank_txn WHERE id = ?').get(line)), true);
  // explain is null when the recipe gives none.
  const u = factorWorld();
  const plain = workedExample(u, { recipe: grossRecipe(u, { explain: null }) });
  assert.deepEqual(proposalOf(u, plain.line).reasonParams.computed, [{ legIndex: 0, label: 'Bruttoumsatz', amountMinor: 18017, explain: null }]);
});

test('[INVARIANT bulk-never-check] the setting bulk makes a computed proposal sure and bulk-bookable; suggest never; isProposalBookable needs the reason', () => {
  // Guards `computedModeOf` and the certainty expression of the `rule_computed` branch (bankProposals.ts),
  // `isProposalBookable`'s `reasonCode === 'rule_computed'` (bankInbox.ts) and the `rule_computed` entry
  // in `lineNeedsReview` (camtReconcile.ts).
  const t = factorWorld();
  const { line, rule } = workedExample(t);
  const row = () => t.store.db.prepare('SELECT * FROM bank_txn WHERE id = ?').get(line);
  const target = { kind: 'rule', standardId: rule.id, asks: {} };
  assert.equal(isProposalBookable(3000, target), false, 'a rule target with no asks is not bookable without a reason');
  assert.equal(isProposalBookable(3000, target, 'rule_needs_amount'), false, 'nor as a rule that asks');
  assert.equal(isProposalBookable(3000, target, 'rule_computed'), true, 'a computed one is complete as it stands');
  assert.equal(lineOf(t, line).attention, 'needs');
  assert.equal(lineNeedsReview(t.ctx, row()), true);

  must(settingsSet(t.ctx, { key: 'bank.buchungsregel_computed_mode', value: 'bulk', reason: 'Schätzung reicht', idempotencyKey: 'mode-bulk' }));
  const l = lineOf(t, line);
  assert.equal(l.proposal.certainty, 'sure');
  assert.equal(l.attention, 'sure', 'bulk: the computed line counts for the bulk button');
  assert.equal(lineNeedsReview(t.ctx, row()), false, 'a sure computed rule switches A36 off');
  // What the bulk path sends books exactly the computed amounts.
  const booked = must(bookBankLine(t.ctx, { bankTxnId: line, target: l.proposal.target, idempotencyKey: 'bulk-book' }));
  assert.ok(entryLegs(t.store, booked.entryId).some((x) => x.number === '1095' && x.debit === 18017));

  must(settingsSet(t.ctx, { key: 'bank.buchungsregel_computed_mode', value: 'suggest', reason: 'doch prüfen', idempotencyKey: 'mode-suggest' }));
  const u = workedExample(t, { key: 'u' });
  assert.equal(lineOf(t, u.line).proposal.certainty, 'check');
  assert.equal(lineOf(t, u.line).attention, 'needs');
});

test('a computed proposal the booking would refuse is check even under bulk: a computed 0 asks the person, a rest of 0 refuses', () => {
  const t = factorWorld();
  must(settingsSet(t.ctx, { key: 'bank.buchungsregel_computed_mode', value: 'bulk', reason: 'Test', idempotencyKey: 'mode' }));
  // 0.04 x 1/10 = 0.004 -> 0: the fraction is too small for the line.
  const tiny = workedExample(t, { key: 'tiny', amountMinor: 4, recipe: grossRecipe(t, { num: 1, den: 10, explain: null }) });
  const p = proposalOf(t, tiny.line);
  assert.equal(p.reasonCode, 'rule_computed');
  assert.equal(p.reasonParams.computed[0].amountMinor, 0);
  assert.equal(p.certainty, 'check');
  assert.equal(lineOf(t, tiny.line).attention, 'needs');
  const missing = refused(bookBankLine(t.ctx, { bankTxnId: tiny.line, target: p.target, idempotencyKey: 'tiny-book' }), 'ask_missing');
  assert.deepEqual([missing.legIndex, missing.label, missing.computed], [0, 'Bruttoumsatz', true]);
  // The person types it: the override books.
  must(bookBankLine(t.ctx, { bankTxnId: tiny.line, target: { ...p.target, asks: { 0: 3 } }, idempotencyKey: 'tiny-typed' }));

  // 1/1 of the line leaves nothing for the rest.
  const whole = workedExample(t, { key: 'whole', amountMinor: 2500, recipe: grossRecipe(t, { num: 1, den: 1, explain: null }) });
  const q = proposalOf(t, whole.line);
  assert.equal(q.certainty, 'check');
  refused(bookBankLine(t.ctx, { bankTxnId: whole.line, target: q.target, idempotencyKey: 'whole-book' }), 'rest_is_zero');
});

test('a taxed computed rule on a foreign-currency line says vatDropped and stays check under bulk; booking it refuses unsupported', () => {
  const t = factorWorld();
  must(settingsSet(t.ctx, { key: 'bank.buchungsregel_computed_mode', value: 'bulk', reason: 'Test', idempotencyKey: 'mode' }));
  seedRate(t.ctx, { currency: 'EUR', rate: '0.95', asOf: '2026-07-19' });
  const eur = must(createBankAccount(t.ctx, { name: 'EUR-Konto', iban: SAVINGS_IBAN, currency: 'EUR', ledgerAccountId: t.acc('1000'), idempotencyKey: 'eur' })).bankAccountId;
  const l = importLines(
    t,
    { statementId: 'EUR-F', iban: SAVINGS_IBAN, currency: 'EUR', entries: [{ ref: 'E1', amountMinor: 3000, cd: 'CRDT', name: PAYOUT, ustrd: 'AUSZAHLUNG EUR' }] },
    { bankAccountId: eur },
  ).lines;
  const rule = must(setBankStandard(t.ctx, { bankTxnId: l.E1, legs: grossRecipe(t), idempotencyKey: 'eur-set' })).standard;
  const p = proposalOf(t, l.E1);
  assert.equal(p.reasonCode, 'rule_computed');
  assert.equal(p.reasonParams.vatDropped, true);
  assert.equal(p.certainty, 'check');
  refused(bookBankLine(t.ctx, { bankTxnId: l.E1, target: { kind: 'rule', standardId: rule.id, asks: {} }, idempotencyKey: 'eur-book' }), 'unsupported');
});

test('a rule with an asked AND a computed leg stays rule_needs_amount and carries computed too; booking with the ask computes the rest', () => {
  const t = factorWorld();
  const l = payouts(t, 'BS-M', [{ ref: 'P1', amountMinor: 10000, ustrd: 'AUSZAHLUNG M' }]);
  const rule = must(
    setBankStandard(t.ctx, {
      bankTxnId: l.P1,
      legs: [
        { accountId: t.acc('3400'), taxCode: null, amount: { kind: 'ask', label: 'Umsatz' } },
        { accountId: t.acc('6900'), taxCode: null, amount: { kind: 'factor', label: 'Gebühr', num: 3, den: 100, explain: { feeBp: 300 } }, against: true },
        { accountId: t.acc('4400'), taxCode: null, amount: { kind: 'rest' } },
      ],
      idempotencyKey: 'm-set',
    }),
  ).standard;
  const p = proposalOf(t, l.P1);
  assert.equal(p.reasonCode, 'rule_needs_amount');
  assert.deepEqual(p.reasonParams.asks, [{ legIndex: 0, label: 'Umsatz' }]);
  assert.deepEqual(p.reasonParams.computed, [{ legIndex: 1, label: 'Gebühr', amountMinor: 300, explain: { feeBp: 300 } }]);
  assert.equal(lineOf(t, l.P1).attention, 'needs');
  refused(bookBankLine(t.ctx, { bankTxnId: l.P1, target: { kind: 'rule', standardId: rule.id, asks: {} }, idempotencyKey: 'm-none' }), 'ask_missing');
  const booked = must(bookBankLine(t.ctx, { bankTxnId: l.P1, target: { kind: 'rule', standardId: rule.id, asks: { 0: 9000 } }, idempotencyKey: 'm-book' }));
  // 100.00 in: 90.00 Umsatz, the fee 3.00 runs against (a debit), the rest 13.00 credit.
  assert.deepEqual(entryLegs(t.store, booked.entryId).map((x) => [x.number, x.debit, x.credit]), [
    ['1020', 10000, 0],
    ['3400', 0, 9000],
    ['4400', 0, 1300],
    ['6900', 300, 0],
  ]);
});

// ================================================================================================
// 4. Booking: the computed amounts, the override, compose parity
// ================================================================================================

test('book_bank_line with asks {} books the computed amounts through the via account; compose_entry previews exactly that', () => {
  const t = factorWorld();
  const { line, rule } = workedExample(t);
  const target = { kind: 'rule', standardId: rule.id, asks: {} };
  const preview = must(composeBankLine(t.ctx, { bankTxnId: line, target }));
  assert.equal(preview.verdict.ok, true, JSON.stringify(preview.verdict));
  assert.deepEqual(preview.target.legs.map((x) => [x.accountId, x.amountMinor, x.taxCode ?? null]), [
    [t.acc('3400'), 18017, 'UST81'],
    [t.acc('4400'), 3000 - 18017, null],
  ]);
  const before = rowCounts(t.store, t.workspaceId);
  const booked = must(bookBankLine(t.ctx, { bankTxnId: line, target, idempotencyKey: 'b-book' }));
  assert.equal(rowCounts(t.store, t.workspaceId).entries - before.entries, 1, 'ONE entry');
  const stored = t.store.db
    .prepare('SELECT account_id AS account, debit_minor AS d, credit_minor AS c, tax_code AS taxCode FROM journal_line WHERE entry_id = ? ORDER BY rowid')
    .all(booked.entryId)
    .map((r) => [r.account, r.d, r.c, r.taxCode]);
  assert.deepEqual(
    stored,
    preview.lines.map((x) => [x.account, x.debit ?? 0, x.credit ?? 0, x.taxCode ?? null]),
    'the preview IS the booking',
  );
  // The gross lands on the via account and nets to zero there.
  const legs = entryLegs(t.store, booked.entryId);
  const via = legs.filter((x) => x.number === '1095').reduce((s, x) => s + x.debit - x.credit, 0);
  assert.equal(via, 0, 'the Durchlaufkonto nets to zero');
  const revenue = legs.filter((x) => x.number === '3400' || x.number === '2200').reduce((s, x) => s + x.credit - x.debit, 0);
  assert.equal(revenue, 18017, 'revenue plus its VAT is the computed gross');
  assert.equal(lineOf(t, line).decision.ruleId, rule.id, 'the decision keeps the rule');
});

test('an override in asks[legIndex] replaces the computed amount; 0 asks the person; an ask on the rest leg is refused', () => {
  const t = factorWorld();
  const { line, rule } = workedExample(t);
  const preview = must(composeBankLine(t.ctx, { bankTxnId: line, target: { kind: 'rule', standardId: rule.id, asks: { 0: 18000 } } }));
  assert.equal(preview.target.legs[0].amountMinor, 18000, 'the person\'s figure wins');
  assert.equal(preview.target.legs[1].amountMinor, 3000 - 18000);
  const zero = must(composeBankLine(t.ctx, { bankTxnId: line, target: { kind: 'rule', standardId: rule.id, asks: { 0: 0 } } }));
  assert.equal(zero.verdict.error, 'ask_missing');
  assert.equal(zero.verdict.computed, true);
  const onRest = refused(bookBankLine(t.ctx, { bankTxnId: line, target: { kind: 'rule', standardId: rule.id, asks: { 1: 500 } }, idempotencyKey: 'o-rest' }), 'invalid_input');
  assert.equal(onRest.field, 'target.asks.1');
  const booked = must(bookBankLine(t.ctx, { bankTxnId: line, target: { kind: 'rule', standardId: rule.id, asks: { 0: 18000 } }, idempotencyKey: 'o-book' }));
  assert.ok(entryLegs(t.store, booked.entryId).some((x) => x.number === '1095' && x.debit === 18000));
});

test('[INVARIANT idempotent-on-rows] a replay adds no row: a factor rule set, a computed booking (even after the rule changed)', () => {
  // Guards the recall/remember pairs of setBankStandard and bookBankLine on the factor path: the rule is
  // expanded BEFORE the memo, so the replay must still answer the stored result and post nothing.
  const t = factorWorld();
  const l = payouts(t, 'BS-K', [{ ref: 'P1', amountMinor: 3000, ustrd: 'AUSZAHLUNG K' }]);
  const setInput = { bankTxnId: l.P1, legs: grossRecipe(t), viaAccountId: t.acc('1095'), idempotencyKey: 'k-set' };
  const s1 = must(setBankStandard(t.ctx, setInput));
  const rows = standardRows(t);
  assert.deepEqual(setBankStandard(t.ctx, setInput), s1);
  assert.deepEqual(standardRows(t), rows, 'the set replay moves no row');

  const input = { bankTxnId: l.P1, target: { kind: 'rule', standardId: s1.standard.id, asks: {} }, idempotencyKey: 'k-book' };
  const first = must(bookBankLine(t.ctx, input));
  const counts = rowCounts(t.store, t.workspaceId);
  assert.deepEqual(bookBankLine(t.ctx, input), first, 'the replay answers the stored result');
  assert.deepEqual(rowCounts(t.store, t.workspaceId), counts, 'and posts nothing');
  // The rule's fraction changes: the replay is still the memo, never a recomputation.
  must(setBankStandard(t.ctx, { standardId: s1.standard.id, legs: grossRecipe(t, { num: 1, den: 2 }), viaAccountId: t.acc('1095'), idempotencyKey: 'k-edit' }));
  assert.deepEqual(bookBankLine(t.ctx, input), first);
  assert.deepEqual(rowCounts(t.store, t.workspaceId), counts);
  refused(bookBankLine(t.ctx, { ...input, idempotencyKey: 'k-book-2' }), 'line_not_open', 'a new key on a booked line doubles nothing');
});

test('[INVARIANT tenant] a factor rule never reaches another workspace: book, compose and the ladder there know nothing of it', () => {
  // Guards the `workspace_id = ?` binding in `readLiveRule` and `liveRulesIndex` on the factor path.
  const t = factorWorld();
  const b = secondWorkspace(t);
  const bBank = must(createBankAccount(b.ctx, { name: 'Konto B', iban: SAVINGS_IBAN, currency: 'CHF', ledgerAccountId: b.acc('1020'), idempotencyKey: 'bb' })).bankAccountId;
  const { rule } = workedExample(t);
  const lb = importLines(t, { statementId: 'BS-HB', iban: SAVINGS_IBAN, entries: [{ ref: 'P1', amountMinor: 3000, cd: 'CRDT', name: PAYOUT, ustrd: 'AUSZAHLUNG W' }] }, { ctx: b.ctx, bankAccountId: bBank }).lines;
  const before = rowCounts(t.store, b.workspaceId);
  refused(bookBankLine(b.ctx, { bankTxnId: lb.P1, target: { kind: 'rule', standardId: rule.id, asks: {} }, idempotencyKey: 'h-b' }), 'rule_not_found');
  assert.equal(must(composeBankLine(b.ctx, { bankTxnId: lb.P1, target: { kind: 'rule', standardId: rule.id, asks: {} } })).verdict.error, 'rule_not_found');
  assert.notEqual(proposalOf(t, lb.P1, b.ctx).reasonCode, 'rule_computed');
  assert.deepEqual(rowCounts(t.store, b.workspaceId), before, 'B wrote nothing');
});

// ================================================================================================
// 5. The pin: an agent's computed booking goes stale when the fraction changes
// ================================================================================================

test('the pin: an agent drafts a computed booking, the person edits the fraction, approval refuses vorschlag_stale; unedited, it books', () => {
  const t = factorWorld();
  const { line, rule } = workedExample(t);
  const drafted = must(governed(t, 'book_bank_line', { bankTxnId: line, target: { kind: 'rule', standardId: rule.id, asks: {} }, idempotencyKey: 'pin-1' }));
  assert.equal(drafted.drafted, true, JSON.stringify(drafted));
  must(setBankStandard(t.ctx, { standardId: rule.id, legs: grossRecipe(t, { num: 1080, den: 180 }), viaAccountId: t.acc('1095'), label: 'Plattform', idempotencyKey: 'pin-edit' }));
  const before = rowCounts(t.store, t.workspaceId);
  const decided = approve(t, drafted.actionId);
  assert.equal(decided.error, 'vorschlag_stale', JSON.stringify(decided).slice(0, 300));
  assert.equal(rowCounts(t.store, t.workspaceId).entries, before.entries, 'nothing posted');

  // The agent proposes again on the edited rule; unedited, the approval books the computed amount.
  const live = must(listBankStandards(t.ctx, {})).standards[0];
  const again = must(governed(t, 'book_bank_line', { bankTxnId: line, target: { kind: 'rule', standardId: live.id, asks: {} }, idempotencyKey: 'pin-2' }));
  const ran = must(approve(t, again.actionId));
  assert.ok(ran.ok);
  assert.equal(lineOf(t, line).state, 'booked');
  assert.ok(entryLegs(t.store, lineOf(t, line).decision.entryId).some((x) => x.number === '1095' && x.debit === factorAmountMinor(3000, 1080, 180)));
});

// ================================================================================================
// 6. Agent drafts: validated like a direct call, one pending Vorschlag per line
// ================================================================================================

test('[INVARIANT draft-validated] a governed book_bank_line the verb would refuse is refused with the direct call\'s own error and drafts nothing', () => {
  // Guards `prevalidateBookBankLine` (bankBooking.ts) wired as `book_bank_line`'s `prevalidate`
  // (bank-inbox-actions.ts), which agent-gate.ts runs before `enqueueDraftedAction`.
  const t = factorWorld();
  const l = importLines(t, {
    statementId: 'BS-D',
    entries: [
      { ref: 'FEE', amountMinor: 470, cd: 'DBIT', name: 'Kartenterminal Beispiel AG', ustrd: 'TERMINAL JULI' },
      { ref: 'DONE', amountMinor: 1200, cd: 'DBIT', name: 'Kartenterminal Beispiel AG', ustrd: 'TERMINAL JUNI' },
    ],
  }).lines;
  must(bookBankLine(t.ctx, { bankTxnId: l.DONE, target: { kind: 'accounts', legs: [{ accountId: t.acc('6500'), amountMinor: 1200 }] }, idempotencyKey: 'd-done' }));
  const { rule } = workedExample(t);
  const askRule = must(
    setBankStandard(t.ctx, {
      bankTxnId: l.FEE,
      legs: [
        { accountId: t.acc('6500'), taxCode: null, amount: { kind: 'ask', label: 'Gebühr' } },
        { accountId: t.acc('6800'), taxCode: null, amount: { kind: 'rest' } },
      ],
      idempotencyKey: 'd-ask',
    }),
  ).standard;
  must(createAccount(t.ctx, { number: '6510', name: 'Alt', type: 'expense', idempotencyKey: 'acc-6510' }));
  must(archiveAccount(t.ctx, { accountId: t.acc('6510') }));
  const cases = [
    // The real defect's shape, with synthetic figures: the leg carries the wrong sign, so it does not sum.
    ['wrong sign', { bankTxnId: l.FEE, target: { kind: 'accounts', legs: [{ accountId: t.acc('6500'), amountMinor: -470 }] } }, 'legs_do_not_sum'],
    ['short legs', { bankTxnId: l.FEE, target: { kind: 'accounts', legs: [{ accountId: t.acc('6500'), amountMinor: 400 }] } }, 'legs_do_not_sum'],
    ['archived account', { bankTxnId: l.FEE, target: { kind: 'accounts', legs: [{ accountId: t.acc('6510'), amountMinor: 470 }] } }, 'account_archived'],
    ['unknown code', { bankTxnId: l.FEE, target: { kind: 'accounts', legs: [{ accountId: t.acc('6500'), amountMinor: 470, taxCode: 'NOPE' }] } }, null],
    ['zero leg', { bankTxnId: l.FEE, target: { kind: 'accounts', legs: [{ accountId: t.acc('6500'), amountMinor: 0 }] } }, 'invalid_input'],
    ['unknown line', { bankTxnId: 'btx_nope', target: { kind: 'accounts', legs: [{ accountId: t.acc('6500'), amountMinor: 470 }] } }, 'not_found'],
    ['decided line', { bankTxnId: l.DONE, target: { kind: 'accounts', legs: [{ accountId: t.acc('6500'), amountMinor: 1200 }] } }, 'line_not_open'],
    ['ask missing', { bankTxnId: l.FEE, target: { kind: 'rule', standardId: askRule.id, asks: {} } }, 'ask_missing'],
    ['rule of another payer', { bankTxnId: l.FEE, target: { kind: 'rule', standardId: rule.id, asks: {} } }, 'rule_not_applicable'],
  ];
  for (const [label, input, code] of cases) {
    const direct = bookBankLine(t.ctx, { ...input, idempotencyKey: `direct-${label}` });
    assert.equal(direct.ok, false, `${label}: the direct call refuses`);
    if (code !== null) assert.equal(direct.error, code, `${label}: the direct call's code`);
    const before = rowCounts(t.store, t.workspaceId);
    const viaAgent = governed(t, 'book_bank_line', { ...input, idempotencyKey: `agent-${label}` });
    assert.equal(viaAgent.ok, false, `${label}: the agent's call is refused, never drafted: ${JSON.stringify(viaAgent)}`);
    assert.equal(viaAgent.error, direct.error, `${label}: the same code as the direct call`);
    assert.deepEqual(rowCounts(t.store, t.workspaceId), before, `${label}: no draft, no row`);
  }
  // A valid one drafts.
  const ok = must(governed(t, 'book_bank_line', { bankTxnId: l.FEE, target: { kind: 'accounts', legs: [{ accountId: t.acc('6500'), amountMinor: 470 }] }, idempotencyKey: 'agent-ok' }));
  assert.equal(ok.drafted, true);
});

test('[INVARIANT one-pending-per-line] a new draft for a line rejects the older pending ones (reason ersetzt); other lines and resolved rows are untouched', () => {
  // Guards `supersedeOlderLineDrafts` (draftedActions.ts), called by `enqueueOnce` after a fresh insert.
  const t = factorWorld();
  const l = importLines(t, {
    statementId: 'BS-O',
    entries: [
      { ref: 'A', amountMinor: 470, cd: 'DBIT', name: 'Kartenterminal Beispiel AG', ustrd: 'TERMINAL A' },
      { ref: 'B', amountMinor: 820, cd: 'DBIT', name: 'Kartenterminal Beispiel AG', ustrd: 'TERMINAL B' },
    ],
  }).lines;
  const book = (id, account, amountMinor, key) =>
    must(governed(t, 'book_bank_line', { bankTxnId: id, target: { kind: 'accounts', legs: [{ accountId: t.acc(account), amountMinor }] }, idempotencyKey: key }));
  const first = book(l.A, '6500', 470, 'o-1');
  const other = book(l.B, '6500', 820, 'o-b');
  // A same-key replay is the same Vorschlag and supersedes nothing.
  const replay = book(l.A, '6500', 470, 'o-1');
  assert.equal(replay.actionId, first.actionId);
  assert.equal(draftRows(t).filter((r) => r.status === 'pending').length, 2);

  const second = book(l.A, '6800', 470, 'o-2');
  // Critic D177-C3: the agent learns which Vorschlag it replaced, and the trace names the replacement.
  assert.deepEqual(second.supersededActionIds, [first.actionId]);
  assert.equal(
    t.store.db.prepare('SELECT entity_ref FROM agent_call WHERE workspace_id = ? AND agent_action_id = ?').get(t.workspaceId, first.actionId).entity_ref,
    second.actionId,
  );
  const rows = draftRows(t);
  const byId = (id) => rows.find((r) => r.id === id);
  assert.equal(byId(first.actionId).status, 'rejected', 'the older draft of the line is resolved');
  assert.equal(byId(first.actionId).reject_reason, 'ersetzt');
  assert.equal(byId(first.actionId).resolved_by, 'agent', 'stamped by the drafting actor');
  assert.equal(byId(second.actionId).status, 'pending');
  assert.equal(byId(other.actionId).status, 'pending', 'another line keeps its Vorschlag');
  // The drafting call's trace backlink, as reject_drafted_action writes it.
  const call = t.store.db.prepare('SELECT resolved_by, resolved_at FROM agent_call WHERE workspace_id = ? AND agent_action_id = ?').get(t.workspaceId, first.actionId);
  assert.equal(call.resolved_by, 'agent');
  assert.ok(call.resolved_at !== null);
  // An ignore Vorschlag for the line replaces the booking Vorschlag too: one per line, whatever the verb.
  const ignore = must(governed(t, 'ignore_bank_line', { bankTxnId: l.A, reason: 'duplicate', idempotencyKey: 'o-ign' }));
  assert.equal(ignore.drafted, true, JSON.stringify(ignore));
  const pendingForA = draftRows(t).filter((r) => r.status === 'pending' && JSON.parse(r.payload_json).bankTxnId === l.A);
  assert.deepEqual(pendingForA.map((r) => r.id), [ignore.actionId], 'exactly ONE pending Vorschlag for the line');
  assert.equal(lineOf(t, l.A).vorschlagActionId, ignore.actionId);
  assert.equal(lineOf(t, l.B).vorschlagActionId, other.actionId);
  // A rejected (resolved) row is never touched again.
  assert.equal(draftRows(t).find((r) => r.id === second.actionId).status, 'rejected');
  assert.equal(draftRows(t).find((r) => r.id === second.actionId).reject_reason, 'ersetzt');
  // Approving a replaced one is refused: it is already resolved.
  assert.equal(approve(t, first.actionId).ok, false);
});

test('[INVARIANT tenant] the supersede never reaches another workspace\'s drafts, even for a payload naming the same line id', () => {
  // Guards the `workspace_id = ?` bindings of `supersedeOlderLineDrafts` (its read and its update).
  const t = factorWorld();
  const b = secondWorkspace(t);
  const l = importLines(t, { statementId: 'BS-T', entries: [{ ref: 'A', amountMinor: 470, cd: 'DBIT', name: 'Kartenterminal Beispiel AG' }] }).lines;
  const mine = must(governed(t, 'book_bank_line', { bankTxnId: l.A, target: { kind: 'accounts', legs: [{ accountId: t.acc('6500'), amountMinor: 470 }] }, idempotencyKey: 't-1' }));
  // An engine-seam draft in B whose payload names A's line id (the gate would refuse it as not_found in B).
  const bAgent = makeContext(t.store, { workspaceId: b.workspaceId, actor: 'agent', clock: t.clock, ids: t.ids });
  // `screened: true`, as the gate marks a draft that passed its full screen, so only the tenant binding
  // stands between it and A's row.
  must(enqueueDraftedAction(bAgent, { actionTool: 'book_bank_line', payload: { workspaceId: b.workspaceId, bankTxnId: l.A, target: { kind: 'accounts', legs: [] }, idempotencyKey: 't-b' }, screened: true }));
  assert.equal(draftRows(t).find((r) => r.id === mine.actionId).status, 'pending', 'A\'s Vorschlag stands');
  assert.equal(lineOf(t, l.A).vorschlagActionId, mine.actionId);
});

test('list_bank_inbox names the NEWEST pending Vorschlag of a line a book drafted before D177 holds twice', () => {
  const t = factorWorld();
  const l = importLines(t, { statementId: 'BS-L', entries: [{ ref: 'A', amountMinor: 470, cd: 'DBIT', name: 'Kartenterminal Beispiel AG' }] }).lines;
  const raw = (id, at) =>
    t.store.db
      .prepare(
        `INSERT INTO agent_action (id, workspace_id, actor, dial_capability, action_tool, payload_json, status, idempotency_key, created_at)
         VALUES (?, ?, 'agent', 'post', 'book_bank_line', ?, 'pending', ?, ?)`,
      )
      .run(id, t.workspaceId, JSON.stringify({ workspaceId: t.workspaceId, bankTxnId: l.A, target: { kind: 'accounts', legs: [] }, idempotencyKey: id }), id, at);
  raw('aa_old', '2026-07-01T08:00:00.000Z');
  raw('aa_new', '2026-07-02T08:00:00.000Z');
  const line = lineOf(t, l.A);
  assert.equal(line.vorschlagActionId, 'aa_new');
  assert.equal(line.attention, 'needs', 'a line a Vorschlag names is never in the bulk button');
  // Without a Vorschlag the field is null; an ignore decided by a person leaves none.
  const m = importLines(t, { statementId: 'BS-L2', entries: [{ ref: 'B', amountMinor: 820, cd: 'DBIT', name: 'Kartenterminal Beispiel AG' }] }).lines;
  must(ignoreBankLine(t.ctx, { bankTxnId: m.B, reason: 'duplicate', idempotencyKey: 'l-ign' }));
  assert.equal(lineOf(t, m.B).vorschlagActionId, null);
});

// ================================================================================================
// 7. Critic D177 remediation: what may supersede, who, and what a decision resolves
// ================================================================================================

/** Every table's row count, so a screen that writes ANYTHING shows. */
function everyCount(t) {
  const tables = t.store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  const out = {};
  for (const { name } of tables) out[name] = t.store.db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get().n;
  return out;
}

const studioRun = (t, name, input) => getAction(name).run({ store: t.store, clock: t.clock, ids: t.ids, actor: 'studio' }, { workspaceId: t.workspaceId, ...input });
const addSecondSeat = (t) =>
  t.store.db.prepare("INSERT INTO user (actor_id, kind, display_name, created_at) VALUES ('agent-zwei', 'agent', 'Zweiter Agent', '2026-07-01T00:00:00.000Z')").run();

test('[INVARIANT screened-supersede] a draft the verb would refuse is refused at draft time and never withdraws a bookable Vorschlag (ignore and settlement)', () => {
  // Guards `prevalidateIgnoreBankLine` and the dry run of `prevalidateBookBankLine` (bankBooking.ts), wired
  // as `prevalidate` (bank-inbox-actions.ts), and the `screened` gate on the supersede (draftedActions.ts).
  const t = factorWorld();
  const l = importLines(t, { statementId: 'BS-S', entries: [{ ref: 'A', amountMinor: 470, cd: 'DBIT', name: 'Kartenterminal Beispiel AG', ustrd: 'TERMINAL S' }] }).lines;
  const good = must(governed(t, 'book_bank_line', { bankTxnId: l.A, target: { kind: 'accounts', legs: [{ accountId: t.acc('6500'), amountMinor: 470 }] }, idempotencyKey: 's-good' }));
  const bad = [
    ['ignore_bank_line', { bankTxnId: l.A, reason: 'gibt_es_nicht' }, 'invalid_input'],
    ['ignore_bank_line', { bankTxnId: l.A, reason: 'other', note: 'x'.repeat(501) }, 'invalid_input'],
    ['ignore_bank_line', { bankTxnId: 'btx_nope', reason: 'duplicate' }, 'not_found'],
    ['ignore_bank_line', { bankTxnId: l.A, reason: 'duplicate', standardId: 'bstd_nope' }, 'rule_not_found'],
    ['book_bank_line', { bankTxnId: l.A, target: { kind: 'open_item', documentId: 'doc_gibt_es_nicht' } }, 'not_found'],
    ['book_bank_line', { bankTxnId: l.A, target: { kind: 'payment_batch', batchId: 'batch_gibt_es_nicht' } }, 'not_found'],
    ['book_bank_line', { bankTxnId: l.A, target: { kind: 'existing_entry', entryId: 'entry_gibt_es_nicht' } }, 'not_found'],
  ];
  for (const [verb, input, code] of bad) {
    const label = `${verb} ${JSON.stringify(input).slice(0, 80)}`;
    const direct = studioRun(t, verb, { ...input, idempotencyKey: `direct-${label}` });
    assert.equal(direct.ok, false, `${label}: the direct call refuses`);
    assert.equal(direct.error, code, `${label}: direct code`);
    const before = rowCounts(t.store, t.workspaceId);
    const viaAgent = governed(t, verb, { ...input, idempotencyKey: `agent-${label}` });
    assert.equal(viaAgent.ok, false, `${label}: refused, never drafted: ${JSON.stringify(viaAgent).slice(0, 160)}`);
    assert.equal(viaAgent.error, direct.error, `${label}: the direct call's code`);
    assert.deepEqual(rowCounts(t.store, t.workspaceId), before, `${label}: nothing written`);
    assert.equal(draftRows(t).find((r) => r.id === good.actionId).status, 'pending', `${label}: the bookable Vorschlag stands`);
  }
});

test('the settlement dry run answers the direct call and keeps nothing: a payable bill passes, a decided line is line_not_open', () => {
  const t = factorWorld();
  const bill = postedBill(t, { grossMinor: 21500, seed: 'dr' });
  const l = importLines(t, {
    statementId: 'BS-DR',
    entries: [
      { ref: 'PAY', amountMinor: 21500, cd: 'DBIT', name: 'Druckerei Tannenbach AG', ustrd: 'RECHNUNG DR' },
      { ref: 'DONE', amountMinor: 900, cd: 'DBIT', name: 'Druckerei Tannenbach AG', ustrd: 'RECHNUNG ALT' },
    ],
  }).lines;
  must(bookBankLine(t.ctx, { bankTxnId: l.DONE, target: { kind: 'accounts', legs: [{ accountId: t.acc('6500'), amountMinor: 900 }] }, idempotencyKey: 'dr-done' }));
  const before = everyCount(t);
  assert.equal(prevalidateBookBankLine(t.ctx, { bankTxnId: l.PAY, target: { kind: 'open_item', documentId: bill.vendorBillId }, idempotencyKey: 'dr-1' }), undefined, 'a payable bill passes the screen');
  // Critic D177-C6 (M5b): the line-state check for a settlement target.
  const decided = prevalidateBookBankLine(t.ctx, { bankTxnId: l.DONE, target: { kind: 'open_item', documentId: bill.vendorBillId }, idempotencyKey: 'dr-2' });
  assert.equal(decided?.error, 'line_not_open');
  assert.equal(prevalidateIgnoreBankLine(t.ctx, { bankTxnId: l.DONE, reason: 'duplicate', idempotencyKey: 'dr-3' })?.error, 'line_not_open');
  assert.deepEqual(everyCount(t), before, 'the dry run rolled every write back');
  // The screened booking really books afterwards, on the same key (no memo survived the dry run).
  const booked = must(bookBankLine(t.ctx, { bankTxnId: l.PAY, target: { kind: 'open_item', documentId: bill.vendorBillId }, idempotencyKey: 'dr-1' }));
  assert.equal(booked.targetKind, 'open_item');
});

test('[INVARIANT supersede-own-seat] the supersede stays within the drafting actor and never touches a row whose approval committed', () => {
  // Guards the `actor = ?` and `committed_at IS NULL` conditions of `supersedeOlderLineDrafts` (draftedActions.ts).
  const t = factorWorld();
  addSecondSeat(t);
  const l = importLines(t, { statementId: 'BS-A', entries: [{ ref: 'A', amountMinor: 470, cd: 'DBIT', name: 'Kartenterminal Beispiel AG', ustrd: 'TERMINAL A' }] }).lines;
  const mine = must(governed(t, 'book_bank_line', { bankTxnId: l.A, target: { kind: 'accounts', legs: [{ accountId: t.acc('6500'), amountMinor: 470 }] }, idempotencyKey: 'a-1' }));
  const theirs = must(runGoverned({ ...agentDeps(t), actor: 'agent-zwei' }, getAction('ignore_bank_line'), { workspaceId: t.workspaceId, bankTxnId: l.A, reason: 'duplicate', idempotencyKey: 'a-2' }));
  assert.equal(theirs.drafted, true, JSON.stringify(theirs));
  assert.equal(theirs.supersededActionIds, undefined, 'another seat replaces nothing');
  assert.equal(draftRows(t).find((r) => r.id === mine.actionId).status, 'pending', "the first seat's Vorschlag stands");
  assert.equal(lineOf(t, l.A).vorschlagActionId, theirs.actionId, 'the inbox names the newest');
  // A row whose approval already committed (D165) is never resolved by a supersede.
  t.store.db.prepare("UPDATE agent_action SET committed_at = '2026-07-20T00:00:00.000Z' WHERE id = ?").run(mine.actionId);
  const again = must(governed(t, 'book_bank_line', { bankTxnId: l.A, target: { kind: 'accounts', legs: [{ accountId: t.acc('6800'), amountMinor: 470 }] }, idempotencyKey: 'a-3' }));
  assert.equal(again.supersededActionIds, undefined);
  assert.equal(draftRows(t).find((r) => r.id === mine.actionId).status, 'pending', 'a committed row is not rejected');
  // Critic D177-C1: a draft that did not pass the verb's full screen (the engine seam without `screened`)
  // supersedes nothing, not even its own seat's.
  const unscreened = must(enqueueDraftedAction(makeContext(t.store, { workspaceId: t.workspaceId, actor: 'agent', clock: t.clock, ids: t.ids }), {
    actionTool: 'book_bank_line',
    payload: { workspaceId: t.workspaceId, bankTxnId: l.A, target: { kind: 'accounts', legs: [] }, idempotencyKey: 'a-4' },
  }));
  assert.equal(unscreened.supersededActionIds, undefined);
  assert.equal(draftRows(t).find((r) => r.id === again.actionId).status, 'pending', 'the screened Vorschlag stands');
});

test("[INVARIANT decided-line-drafts] a decision of a line resolves every other pending Vorschlag for it as Zeile entschieden, never the one being approved, never another tenant's", () => {
  // Guards `resolveLineDraftsOnDecision` (bankLines.ts), called by `writeLineLink`, its tenant binding, its
  // `committed_at` condition, and the `approving.ts` exclusion of the draft whose approval decides the line.
  const t = factorWorld();
  addSecondSeat(t);
  const l = importLines(t, {
    statementId: 'BS-Z',
    entries: [
      { ref: 'A', amountMinor: 470, cd: 'DBIT', name: 'Kartenterminal Beispiel AG', ustrd: 'TERMINAL ZA' },
      { ref: 'B', amountMinor: 820, cd: 'DBIT', name: 'Kartenterminal Beispiel AG', ustrd: 'TERMINAL ZB' },
      { ref: 'C', amountMinor: 610, cd: 'DBIT', name: 'Kartenterminal Beispiel AG', ustrd: 'TERMINAL ZC' },
    ],
  }).lines;
  const book = (id, amountMinor, key, actor = 'agent') =>
    must(runGoverned({ ...agentDeps(t), actor }, getAction('book_bank_line'), { workspaceId: t.workspaceId, bankTxnId: id, target: { kind: 'accounts', legs: [{ accountId: t.acc('6500'), amountMinor }] }, idempotencyKey: key }));
  const rowOf = (id, ws = t.workspaceId) => t.store.db.prepare('SELECT status, reject_reason, resolved_by FROM agent_action WHERE workspace_id = ? AND id = ?').get(ws, id);

  // Line A: two seats' Vorschläge, then a PERSON books the line directly.
  const a1 = book(l.A, 470, 'z-a1');
  const a2 = book(l.A, 470, 'z-a2', 'agent-zwei');
  // A Vorschlag of the line whose approval committed stays as it is (D165).
  const committed = book(l.A, 470, 'z-a3', 'agent-zwei');
  t.store.db.prepare("UPDATE agent_action SET committed_at = '2026-07-20T00:00:00.000Z' WHERE id = ?").run(committed.actionId);
  // Another workspace's draft naming the same line id (engine seam) is out of reach.
  const b = secondWorkspace(t);
  const bAgent = makeContext(t.store, { workspaceId: b.workspaceId, actor: 'agent', clock: t.clock, ids: t.ids });
  const foreign = must(enqueueDraftedAction(bAgent, { actionTool: 'book_bank_line', payload: { workspaceId: b.workspaceId, bankTxnId: l.A, target: { kind: 'accounts', legs: [] }, idempotencyKey: 'z-b' } }));
  // Critic D177 round 2 (G1): a Vorschlag for ANOTHER line, pending while line A is decided.
  const otherLine = book(l.B, 820, 'z-other');
  must(bookBankLine(t.ctx, { bankTxnId: l.A, target: { kind: 'accounts', legs: [{ accountId: t.acc('6500'), amountMinor: 470 }] }, idempotencyKey: 'z-person' }));
  assert.equal(rowOf(otherLine.actionId).status, 'pending', 'a decision of line A leaves line B\'s Vorschlag untouched');
  assert.equal(lineOf(t, l.B).vorschlagActionId, otherLine.actionId);
  // a2 was superseded by `committed` (same seat) before the booking; a1 was still pending.
  assert.deepEqual(rowOf(a1.actionId), { status: 'rejected', reject_reason: 'Zeile entschieden', resolved_by: t.ctx.actor }, 'resolved by the decision');
  const call = t.store.db.prepare('SELECT resolved_by FROM agent_call WHERE workspace_id = ? AND agent_action_id = ?').get(t.workspaceId, a1.actionId);
  assert.equal(call.resolved_by, t.ctx.actor, 'the trace says who resolved it');
  assert.equal(rowOf(a2.actionId).reject_reason, 'ersetzt');
  assert.equal(rowOf(committed.actionId).status, 'pending', 'a committed row is left alone');
  assert.equal(rowOf(foreign.actionId, b.workspaceId).status, 'pending', "another tenant's row is out of reach");

  // Line B: two seats' Vorschläge; approving one books the line, executes it, and resolves the other.
  const b1 = book(l.B, 820, 'z-b1');
  const b2 = book(l.B, 820, 'z-b2', 'agent-zwei');
  must(approve(t, b2.actionId));
  assert.equal(lineOf(t, l.B).state, 'booked', 'the approved booking committed (its own cleanup never touched it)');
  assert.equal(rowOf(b2.actionId).status, 'executed');
  assert.deepEqual([rowOf(b1.actionId).status, rowOf(b1.actionId).reject_reason], ['rejected', 'Zeile entschieden']);
  // `otherLine` (agent) was replaced by b1 (the same seat) before line B was decided.
  assert.equal(rowOf(otherLine.actionId).reject_reason, 'ersetzt');
  assert.equal(lineOf(t, l.B).vorschlagActionId, null);

  // An ignore decides a line too. Approving an IGNORE Vorschlag: its first write is the decision itself
  // (no inner transaction has stamped its commit mark yet), so only the `approving.ts` exclusion keeps the
  // cleanup from resolving the very draft being approved, which would roll the approval back.
  const c1 = book(l.C, 610, 'z-c1');
  const c2 = must(runGoverned({ ...agentDeps(t), actor: 'agent-zwei' }, getAction('ignore_bank_line'), { workspaceId: t.workspaceId, bankTxnId: l.C, reason: 'duplicate', idempotencyKey: 'z-c2' }));
  const decided = approve(t, c2.actionId);
  assert.equal(decided.ok, true, JSON.stringify(decided).slice(0, 300));
  assert.equal(lineOf(t, l.C).state, 'ignored');
  assert.equal(rowOf(c2.actionId).status, 'executed');
  assert.deepEqual([rowOf(c1.actionId).status, rowOf(c1.actionId).reject_reason], ['rejected', 'Zeile entschieden']);
});

// ================================================================================================
// 8. Critic D177 round 2
// ================================================================================================

test('[INVARIANT spent-key] a draft that reuses a key which decided the line before it was reopened is refused, never screened, and supersedes nothing', () => {
  // Guards `spentKeyOnOpenLine` in the memo branch of `prevalidateBookBankLine` and `prevalidateIgnoreBankLine`
  // (bankBooking.ts): a memo hit counts as screened only while the decision it answers is still in force.
  const t = factorWorld();
  const l = importLines(t, { statementId: 'BS-K2', entries: [{ ref: 'A', amountMinor: 470, cd: 'DBIT', name: 'Kartenterminal Beispiel AG', ustrd: 'TERMINAL K2' }] }).lines;
  const spent = 'k2-booked';
  must(bookBankLine(t.ctx, { bankTxnId: l.A, target: { kind: 'accounts', legs: [{ accountId: t.acc('6500'), amountMinor: 470 }] }, idempotencyKey: spent }));
  // While the line is still booked, the same key is a genuine retry: the screen lets the verb replay it.
  assert.equal(prevalidateBookBankLine(t.ctx, { bankTxnId: l.A, target: { kind: 'accounts', legs: [{ accountId: t.acc('6500'), amountMinor: 470 }] }, idempotencyKey: spent }), undefined);
  must(reopenBankLine(t.ctx, { bankTxnId: l.A, reason: 'falsches Konto (synthetisch)', idempotencyKey: 'k2-reopen' }));
  const valid = must(governed(t, 'book_bank_line', { bankTxnId: l.A, target: { kind: 'accounts', legs: [{ accountId: t.acc('6800'), amountMinor: 470 }] }, idempotencyKey: 'k2-valid' }));
  const before = rowCounts(t.store, t.workspaceId);
  for (const [verb, input] of [
    ['book_bank_line', { bankTxnId: l.A, target: { kind: 'accounts', legs: [{ accountId: t.acc('6500'), amountMinor: 1 }] }, idempotencyKey: spent }],
    ['book_bank_line', { bankTxnId: l.A, target: { kind: 'accounts', legs: [{ accountId: t.acc('6500'), amountMinor: 470 }] }, idempotencyKey: spent }],
  ]) {
    const answer = governed(t, verb, input);
    assert.equal(answer.ok, false, JSON.stringify(answer).slice(0, 200));
    assert.equal(answer.error, 'idempotency_key_conflict');
  }
  assert.deepEqual(rowCounts(t.store, t.workspaceId), before, 'nothing drafted');
  assert.equal(draftRows(t).find((r) => r.id === valid.actionId).status, 'pending', 'the valid Vorschlag stands');
  // The same for an ignore whose decision was undone.
  const m = importLines(t, { statementId: 'BS-K3', entries: [{ ref: 'B', amountMinor: 820, cd: 'DBIT', name: 'Kartenterminal Beispiel AG', ustrd: 'TERMINAL K3' }] }).lines;
  must(ignoreBankLine(t.ctx, { bankTxnId: m.B, reason: 'duplicate', idempotencyKey: 'k3-ign' }));
  must(reopenBankLine(t.ctx, { bankTxnId: m.B, reason: 'doch buchen (synthetisch)', idempotencyKey: 'k3-reopen' }));
  assert.equal(prevalidateIgnoreBankLine(t.ctx, { bankTxnId: m.B, reason: 'duplicate', idempotencyKey: 'k3-ign' })?.error, 'idempotency_key_conflict');
});

test('[INVARIANT dry-run-not-partial] the settlement dry run leaves the change count where it was; a throw inside it is a refusal that changed nothing', () => {
  // Guards `SqliteStore.discardingChanges` around `dryRunBooking` (bankBooking.ts): `changeCount` is what the
  // registry's `guarded` reads to say whether a refused call had already changed the book.
  const t = factorWorld();
  const bill = postedBill(t, { grossMinor: 21500, seed: 'np' });
  const l = importLines(t, { statementId: 'BS-NP', entries: [{ ref: 'PAY', amountMinor: 21500, cd: 'DBIT', name: 'Druckerei Tannenbach AG', ustrd: 'RECHNUNG NP' }] }).lines;
  const input = { workspaceId: t.workspaceId, bankTxnId: l.PAY, target: { kind: 'open_item', documentId: bill.vendorBillId }, idempotencyKey: 'np-1' };
  const before = t.store.changeCount();
  assert.equal(getAction('book_bank_line').prevalidate(agentDeps(t), input), undefined, 'a payable bill passes');
  assert.equal(t.store.changeCount(), before, 'a passing dry run counts no change');
  // A throw after the body of every transaction the dry run opens (a synthetic failure, not a refusal).
  const original = t.store.tx.bind(t.store);
  t.store.tx = (fn) =>
    original(() => {
      fn();
      throw new RangeError('synthetic failure after the body');
    });
  let answer;
  try {
    answer = getAction('book_bank_line').prevalidate(agentDeps(t), input);
  } finally {
    t.store.tx = original;
  }
  assert.equal(answer?.error, 'unexpected_error', JSON.stringify(answer));
  assert.equal(answer.partial, false, 'nothing the dry run wrote survived, so the refusal is not partial');
  assert.equal(t.store.changeCount(), before);
  assert.equal(t.store.db.inTransaction, false);
});

test('the approval exclusion counts depth: a nested approval of the same id keeps it until the outermost one ends', async () => {
  const { withApproving, approvingActionIds } = await import('../../dist/core/agent/approving.js');
  withApproving('aa_depth', () => {
    withApproving('aa_depth', () => assert.deepEqual(approvingActionIds(), ['aa_depth']));
    assert.deepEqual(approvingActionIds(), ['aa_depth'], 'the inner end keeps the outer exclusion');
  });
  assert.deepEqual(approvingActionIds(), [], 'gone once the outermost ends');
  assert.throws(() => withApproving('aa_throw', () => { throw new Error('synthetic'); }));
  assert.deepEqual(approvingActionIds(), [], 'released on a throw too');
});

// ================================================================================================
// 9. The UX walk: an undo gives back the Vorschläge its decision closed
// ================================================================================================

test('[INVARIANT reopen-revives] undoing a decision gives back exactly the Vorschläge it closed, only while they still run, never another tenant\'s', () => {
  // Guards `reviveLineDraftsOnReopen` (bankBooking.ts), called by `reopenBankLine`, and the
  // `closed_by_link_id` that `resolveLineDraftsOnDecision` (bankLines.ts) records: its tenant binding, its
  // `closed_by_link_id` / reason / `committed_at` conditions, the pin check, the screen and the trace reset.
  const t = factorWorld();
  addSecondSeat(t);
  const l = importLines(t, {
    statementId: 'BS-RV',
    entries: [
      { ref: 'I', amountMinor: 470, cd: 'DBIT', name: 'Kartenterminal Beispiel AG', ustrd: 'TERMINAL RV I' },
      { ref: 'B', amountMinor: 820, cd: 'DBIT', name: 'Kartenterminal Beispiel AG', ustrd: 'TERMINAL RV B' },
      { ref: 'S', amountMinor: 1081, cd: 'DBIT', name: 'Kartenterminal Beispiel AG', ustrd: 'TERMINAL RV S' },
      { ref: 'V', amountMinor: 610, cd: 'DBIT', name: 'Kartenterminal Beispiel AG', ustrd: 'TERMINAL RV V' },
    ],
  }).lines;
  const draft = (id, legs, key, actor = 'agent') =>
    must(runGoverned({ ...agentDeps(t), actor }, getAction('book_bank_line'), { workspaceId: t.workspaceId, bankTxnId: id, target: { kind: 'accounts', legs }, idempotencyKey: key }));
  const rowOf = (id, ws = t.workspaceId) => t.store.db.prepare('SELECT status, reject_reason, closed_by_link_id FROM agent_action WHERE workspace_id = ? AND id = ?').get(ws, id);
  const traceOf = (id) => t.store.db.prepare('SELECT resolved_by, resolved_at FROM agent_call WHERE workspace_id = ? AND agent_action_id = ?').get(t.workspaceId, id);

  // 1. Ignore, then Rückgängig: the Vorschlag is back, the same id, and still books.
  const vi = draft(l.I, [{ accountId: t.acc('6500'), amountMinor: 470 }], 'rv-i');
  must(ignoreBankLine(t.ctx, { bankTxnId: l.I, reason: 'duplicate', idempotencyKey: 'rv-i-ign' }));
  assert.equal(rowOf(vi.actionId).reject_reason, 'Zeile entschieden');
  const ri = must(reopenBankLine(t.ctx, { bankTxnId: l.I, reason: 'doch buchen (synthetisch)', idempotencyKey: 'rv-i-reopen' }));
  assert.deepEqual(ri.revivedActionIds, [vi.actionId]);
  assert.deepEqual(rowOf(vi.actionId), { status: 'pending', reject_reason: null, closed_by_link_id: null });
  assert.equal(lineOf(t, l.I).vorschlagActionId, vi.actionId, 'the inbox shows the same Vorschlag again');
  assert.deepEqual(traceOf(vi.actionId), { resolved_by: null, resolved_at: null }, 'the trace no longer says it was resolved');
  must(approve(t, vi.actionId));
  assert.equal(lineOf(t, l.I).state, 'booked');

  // 2. Book, then Rückgängig (the entry reversed): the same. A Vorschlag a PERSON rejected, one a newer one
  // replaced ("ersetzt"), and a legacy "Zeile entschieden" row closed by no recorded decision stay rejected.
  const personNo = draft(l.B, [{ accountId: t.acc('6800'), amountMinor: 820 }], 'rv-b-no', 'agent-zwei');
  must(getAction('reject_drafted_action').run({ store: t.store, clock: t.clock, ids: t.ids, actor: 'studio' }, { workspaceId: t.workspaceId, actionId: personNo.actionId, reason: 'falsches Konto' }));
  const replaced = draft(l.B, [{ accountId: t.acc('6800'), amountMinor: 820 }], 'rv-b-1');
  const vb = draft(l.B, [{ accountId: t.acc('6500'), amountMinor: 820 }], 'rv-b-2');
  assert.equal(rowOf(replaced.actionId).reject_reason, 'ersetzt');
  t.store.db
    .prepare(
      `INSERT INTO agent_action (id, workspace_id, actor, dial_capability, action_tool, payload_json, status, idempotency_key, created_at, resolved_at, resolved_by, reject_reason)
       VALUES ('aa_legacy', ?, 'agent', 'post', 'book_bank_line', ?, 'rejected', 'aa_legacy', '2026-07-01T08:00:00.000Z', '2026-07-02T08:00:00.000Z', 'studio', 'Zeile entschieden')`,
    )
    .run(t.workspaceId, JSON.stringify({ workspaceId: t.workspaceId, bankTxnId: l.B, target: { kind: 'accounts', legs: [{ accountId: t.acc('6500'), amountMinor: 820 }] }, idempotencyKey: 'aa_legacy' }));
  must(bookBankLine(t.ctx, { bankTxnId: l.B, target: { kind: 'accounts', legs: [{ accountId: t.acc('6900'), amountMinor: 820 }] }, idempotencyKey: 'rv-b-book' }));
  const closingLink = rowOf(vb.actionId).closed_by_link_id;
  assert.ok(closingLink !== null, 'the decision records which link closed it');
  // Another tenant's row that (by construction) names the same closing link is out of reach.
  const b = secondWorkspace(t);
  const bAgent = makeContext(t.store, { workspaceId: b.workspaceId, actor: 'agent', clock: t.clock, ids: t.ids });
  const foreign = must(enqueueDraftedAction(bAgent, { actionTool: 'book_bank_line', payload: { workspaceId: b.workspaceId, bankTxnId: l.B, target: { kind: 'accounts', legs: [{ accountId: t.acc('6500'), amountMinor: 820 }] }, idempotencyKey: 'rv-foreign' } }));
  t.store.db.prepare("UPDATE agent_action SET status = 'rejected', reject_reason = 'Zeile entschieden', closed_by_link_id = ? WHERE id = ?").run(closingLink, foreign.actionId);
  const rb = must(reopenBankLine(t.ctx, { bankTxnId: l.B, reason: 'falsches Konto (synthetisch)', idempotencyKey: 'rv-b-reopen' }));
  assert.equal(rb.reversedEntryIds.length, 1, 'the booking was reversed');
  assert.deepEqual(rb.revivedActionIds, [vb.actionId]);
  assert.equal(rowOf(vb.actionId).status, 'pending');
  assert.equal(lineOf(t, l.B).vorschlagActionId, vb.actionId);
  assert.deepEqual([rowOf(personNo.actionId).status, rowOf(personNo.actionId).reject_reason], ['rejected', 'falsches Konto'], 'a person\'s no stays a no');
  assert.deepEqual([rowOf(replaced.actionId).status, rowOf(replaced.actionId).reject_reason], ['rejected', 'ersetzt'], 'a replaced draft stays replaced');
  assert.equal(rowOf('aa_legacy').status, 'rejected', 'a closure no recorded decision made stays');
  assert.equal(rowOf(foreign.actionId, b.workspaceId).status, 'rejected', 'another tenant is untouched');

  // 3. A Vorschlag whose pinned data changed since it was drafted (the rate of its code) stays rejected,
  // with the reason in words; so does one that no longer screens (its account archived); so does one
  // whose approval had committed (D165).
  must(createAccount(t.ctx, { number: '6575', name: 'Alt Gebühren', type: 'expense', idempotencyKey: 'acc-6575' }));
  const vs = draft(l.S, [{ accountId: t.acc('6500'), amountMinor: 1081, taxCode: 'VST-M' }], 'rv-s');
  const vv = draft(l.V, [{ accountId: t.acc('6575'), amountMinor: 610 }], 'rv-v');
  const vc = draft(l.V, [{ accountId: t.acc('6500'), amountMinor: 610 }], 'rv-c', 'agent-zwei');
  must(ignoreBankLine(t.ctx, { bankTxnId: l.S, reason: 'duplicate', idempotencyKey: 'rv-s-ign' }));
  must(ignoreBankLine(t.ctx, { bankTxnId: l.V, reason: 'duplicate', idempotencyKey: 'rv-v-ign' }));
  t.store.db.prepare("UPDATE tax_code SET rate_bp = rate_bp + 100 WHERE workspace_id = ? AND code = 'VST-M'").run(t.workspaceId);
  must(archiveAccount(t.ctx, { accountId: t.acc('6575') }));
  t.store.db.prepare("UPDATE agent_action SET committed_at = '2026-07-20T00:00:00.000Z' WHERE id = ?").run(vc.actionId);
  const rs = must(reopenBankLine(t.ctx, { bankTxnId: l.S, reason: 'Test (synthetisch)', idempotencyKey: 'rv-s-reopen' }));
  const rv = must(reopenBankLine(t.ctx, { bankTxnId: l.V, reason: 'Test (synthetisch)', idempotencyKey: 'rv-v-reopen' }));
  assert.equal(rs.revivedActionIds, undefined);
  assert.equal(rv.revivedActionIds, undefined);
  assert.equal(rowOf(vs.actionId).status, 'rejected');
  assert.match(rowOf(vs.actionId).reject_reason, /geändert/, 'the reason says the data changed');
  assert.equal(rowOf(vv.actionId).status, 'rejected');
  assert.match(rowOf(vv.actionId).reject_reason, /nicht mehr gebucht/, 'the reason says it can no longer book');
  assert.equal(rowOf(vc.actionId).status, 'rejected', 'a committed row is never revived');
  assert.equal(lineOf(t, l.S).vorschlagActionId, null);
});

// ================================================================================================
// 10. Critic D177 round 4: the round trip on record, one per seat on revive, trust counts people only
// ================================================================================================

test('[INVARIANT draft-history] a Vorschlag keeps its round trip: closed by the decision, revived by its undo, replaced, or kept closed with the reason', () => {
  // Guards the `appendDraftHistory` calls (draftHistory.ts) in `resolveLineDraftsOnDecision` (bankLines.ts),
  // `reviveLineDraftsOnReopen` (bankBooking.ts, revived and not_revived) and `supersedeOlderLineDrafts`
  // (draftedActions.ts), and the `closure_kind` each closure stamps.
  const t = factorWorld();
  const l = importLines(t, {
    statementId: 'BS-H',
    entries: [
      { ref: 'A', amountMinor: 470, cd: 'DBIT', name: 'Kartenterminal Beispiel AG', ustrd: 'TERMINAL HA' },
      { ref: 'B', amountMinor: 820, cd: 'DBIT', name: 'Kartenterminal Beispiel AG', ustrd: 'TERMINAL HB' },
    ],
  }).lines;
  const draft = (id, account, amountMinor, key) =>
    must(governed(t, 'book_bank_line', { bankTxnId: id, target: { kind: 'accounts', legs: [{ accountId: t.acc(account), amountMinor }] }, idempotencyKey: key }));
  const rowOf = (id) => t.store.db.prepare('SELECT status, closure_kind, history_json FROM agent_action WHERE workspace_id = ? AND id = ?').get(t.workspaceId, id);
  const historyOf = (id) => JSON.parse(rowOf(id).history_json ?? '[]');

  const x = draft(l.A, '6500', 470, 'h-x');
  must(ignoreBankLine(t.ctx, { bankTxnId: l.A, reason: 'duplicate', idempotencyKey: 'h-ign' }));
  const linkId = lineOf(t, l.A).decision.linkId;
  assert.equal(rowOf(x.actionId).closure_kind, 'line_decided');
  must(reopenBankLine(t.ctx, { bankTxnId: l.A, reason: 'Rückgängig (synthetisch)', idempotencyKey: 'h-reopen' }));
  assert.equal(rowOf(x.actionId).status, 'pending');
  assert.equal(rowOf(x.actionId).closure_kind, null, 'pending again: no current closure');
  assert.deepEqual(
    historyOf(x.actionId).map((e) => [e.event, e.kind ?? null, e.reason ?? null, e.linkId ?? e.undoneLinkId ?? null]),
    [
      ['closed', 'line_decided', 'Zeile entschieden', linkId],
      ['revived', null, null, linkId],
    ],
    'closed by the decision, then revived by its undo',
  );
  // The listing carries it.
  const listed = must(getAction('list_drafted_actions').run({ store: t.store, clock: t.clock, ids: t.ids, actor: 'studio' }, { workspaceId: t.workspaceId, status: 'pending' }));
  assert.equal(listed.actions.find((a) => a.actionId === x.actionId).history.length, 2);
  // A newer Vorschlag of the seat replaces it: recorded too.
  const y = draft(l.A, '6800', 470, 'h-y');
  assert.equal(rowOf(x.actionId).closure_kind, 'superseded');
  const last = historyOf(x.actionId).at(-1);
  assert.deepEqual([last.event, last.kind, last.reason, last.replacedBy], ['closed', 'superseded', 'ersetzt', y.actionId]);
  // A Vorschlag that cannot come back (its account archived meanwhile) says so in its history.
  must(createAccount(t.ctx, { number: '6576', name: 'Alt Porto', type: 'expense', idempotencyKey: 'acc-6576' }));
  const z = draft(l.B, '6576', 820, 'h-z');
  must(ignoreBankLine(t.ctx, { bankTxnId: l.B, reason: 'duplicate', idempotencyKey: 'h-ign-b' }));
  must(archiveAccount(t.ctx, { accountId: t.acc('6576') }));
  must(reopenBankLine(t.ctx, { bankTxnId: l.B, reason: 'Rückgängig (synthetisch)', idempotencyKey: 'h-reopen-b' }));
  const kept = historyOf(z.actionId).at(-1);
  assert.equal(rowOf(z.actionId).status, 'rejected');
  assert.equal(rowOf(z.actionId).closure_kind, 'line_decided', 'still a system closure');
  assert.equal(kept.event, 'not_revived');
  assert.match(kept.reason, /nicht mehr gebucht/);
});

test('[INVARIANT one-per-seat-on-revive] an undo brings back ONE Vorschlag per seat: the newest; an older one of the same seat is ersetzt by it', () => {
  // Guards the same-seat supersede at the end of `reviveLineDraftsOnReopen` (bankBooking.ts).
  const t = factorWorld();
  addSecondSeat(t);
  const l = importLines(t, { statementId: 'BS-OS', entries: [{ ref: 'A', amountMinor: 470, cd: 'DBIT', name: 'Kartenterminal Beispiel AG', ustrd: 'TERMINAL OS' }] }).lines;
  const raw = (id, actor, at) =>
    t.store.db
      .prepare(
        `INSERT INTO agent_action (id, workspace_id, actor, dial_capability, action_tool, payload_json, status, idempotency_key, created_at)
         VALUES (?, ?, ?, 'post', 'book_bank_line', ?, 'pending', ?, ?)`,
      )
      .run(id, t.workspaceId, actor, JSON.stringify({ workspaceId: t.workspaceId, bankTxnId: l.A, target: { kind: 'accounts', legs: [{ accountId: t.acc('6500'), amountMinor: 470 }] }, idempotencyKey: id }), id, at);
  // A book drafted before D177: two Vorschläge of one seat, one of another.
  raw('aa_alt', 'agent', '2026-07-01T08:00:00.000Z');
  raw('aa_neu', 'agent', '2026-07-02T08:00:00.000Z');
  raw('aa_zwei', 'agent-zwei', '2026-07-01T09:00:00.000Z');
  must(ignoreBankLine(t.ctx, { bankTxnId: l.A, reason: 'duplicate', idempotencyKey: 'os-ign' }));
  const r = must(reopenBankLine(t.ctx, { bankTxnId: l.A, reason: 'Rückgängig (synthetisch)', idempotencyKey: 'os-reopen' }));
  assert.deepEqual([...r.revivedActionIds].sort(), ['aa_neu', 'aa_zwei'], 'one per seat');
  const alt = t.store.db.prepare('SELECT status, reject_reason, closure_kind, history_json FROM agent_action WHERE id = ?').get('aa_alt');
  assert.deepEqual([alt.status, alt.reject_reason, alt.closure_kind], ['rejected', 'ersetzt', 'superseded']);
  assert.equal(JSON.parse(alt.history_json).at(-1).replacedBy, 'aa_neu');
  assert.equal(lineOf(t, l.A).vorschlagActionId, 'aa_neu');
});

test('[INVARIANT trust-person-only] the trust read counts a person\'s rejection only; ersetzt and Zeile entschieden never lower the grant suggestion', async () => {
  // Guards `closure_kind IS NULL` in `agentTrustSummary` (trust.ts) and the `closure_kind` the two system
  // closures stamp (draftedActions.ts, bankLines.ts).
  const { agentTrustSummary } = await import('../../dist/core/agent/trust.js');
  const t = factorWorld();
  const l = importLines(t, {
    statementId: 'BS-TR',
    entries: [
      { ref: 'A', amountMinor: 470, cd: 'DBIT', name: 'Kartenterminal Beispiel AG', ustrd: 'TERMINAL TA' },
      { ref: 'B', amountMinor: 820, cd: 'DBIT', name: 'Kartenterminal Beispiel AG', ustrd: 'TERMINAL TB' },
    ],
  }).lines;
  const draft = (id, account, amountMinor, key) =>
    must(governed(t, 'book_bank_line', { bankTxnId: id, target: { kind: 'accounts', legs: [{ accountId: t.acc(account), amountMinor }] }, idempotencyKey: key }));
  const rejectedFor = () => must(agentTrustSummary(t.ctx, {})).rows.find((row) => row.capability === 'post').rejected;
  draft(l.A, '6500', 470, 'tr-1');
  draft(l.A, '6800', 470, 'tr-2'); // replaces tr-1: "ersetzt"
  must(bookBankLine(t.ctx, { bankTxnId: l.A, target: { kind: 'accounts', legs: [{ accountId: t.acc('6500'), amountMinor: 470 }] }, idempotencyKey: 'tr-person' })); // closes tr-2
  assert.equal(rejectedFor(), 0, 'two system closures are no rejection of the agent');
  const no = draft(l.B, '6500', 820, 'tr-3');
  must(getAction('reject_drafted_action').run({ store: t.store, clock: t.clock, ids: t.ids, actor: 'studio' }, { workspaceId: t.workspaceId, actionId: no.actionId, reason: 'falsches Konto' }));
  assert.equal(rejectedFor(), 1, 'a person\'s rejection counts');
});
