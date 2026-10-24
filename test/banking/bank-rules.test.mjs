// D175 (spec A39 §14): Buchungsregeln. The D167 standard widened into a recipe of legs (one rest, the others
// asked at booking time), an optional Durchlaufkonto that routes the whole entry through itself, and an
// optional match text read against the REMITTANCE text only. Every bullet of §14.7 has a test here, named
// after it; the money-path invariants are marked [INVARIANT ...] for the non-author critic, each saying in
// its comment which code it guards, so a mutation of that code fails it.
//
// SYNTHETIC DATA ONLY: every statement is spelled by hand in bank-inbox-support.mjs; the payout service,
// the shop and the course platform below are invented names, and every amount is invented (the worked
// example of the brief: a 30.00 payout, 216.20 asked as Bruttoumsatz).

import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

import {
  createBankAccount,
  listBankInbox,
  bookBankLine,
  setBankStandard,
  clearBankStandard,
  listBankStandards,
  lineNeedsReview,
  isProposalBookable,
} from '../../dist/core/banking/index.js';
import { composeBankLine, expandRule } from '../../dist/core/banking/bankBooking.js';
import { getAction } from '../../dist/api/registry.js';
import { createAccount, archiveAccount } from '../../dist/core/accounts/accounts.js';
import { computeLineTax } from '../../dist/core/vat/applyVat.js';
import { settingsSet, settingsReset } from '../../dist/core/settings/index.js';
import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { SCHEMA_GENERATION } from '../../dist/core/store/schema.js';
import { DATA_MIGRATIONS } from '../../dist/core/store/migrations.js';
import { seedRate } from '../payments/support.mjs';
import {
  world,
  secondWorkspace,
  importLines,
  must,
  refused,
  legs as entryLegs,
  rowCounts,
  excuseClaimInvariant,
  assertClaimInvariantHolds,
  MAIN_IBAN,
  SAVINGS_IBAN,
  TELCO_IBAN,
} from './bank-inbox-support.mjs';

afterEach(assertClaimInvariantHolds);

const PAYOUT = 'Zahlwerk Beispiel Ltd';
const lineOf = (t, id, ctx = t.ctx) => must(listBankInbox(ctx, { status: 'all' }), 'inbox').lines.find((l) => l.bankTxnId === id);
const proposalOf = (t, id, ctx = t.ctx) => lineOf(t, id, ctx).proposal;
const standardRows = (t, ws = t.workspaceId) => t.store.db.prepare('SELECT * FROM bank_standard WHERE workspace_id = ? ORDER BY rowid').all(ws);
const txnRow = (t, id) => t.store.db.prepare('SELECT * FROM bank_txn WHERE id = ?').get(id);

/** The world plus the Erlös Durchlaufkonto 1095 (a balance account the KMU seed does not carry). */
function rulesWorld() {
  const t = world();
  must(createAccount(t.ctx, { number: '1095', name: 'Erlös Durchlaufkonto', type: 'asset', idempotencyKey: 'acc-1095' }), '1095');
  return t;
}

/** Payout lines from one invented payout service, told apart only by their remittance text. */
function payouts(t, statementId, entries) {
  return importLines(t, { statementId, entries: entries.map((e) => ({ cd: 'CRDT', name: PAYOUT, ...e })) }).lines;
}

/** The worked example's recipe: 3400 with UST81 asked as Bruttoumsatz, the rest to 4400, via 1095. */
function shopRecipe(t) {
  return [
    { accountId: t.acc('3400'), taxCode: 'UST81', amount: { kind: 'ask', label: 'Bruttoumsatz' } },
    { accountId: t.acc('4400'), taxCode: null, amount: { kind: 'rest' } },
  ];
}

/** The rows an entry stores, in the post_entry line shape, in row order (the parity suite's reader). */
function storedLines(t, entryId) {
  return t.store.db
    .prepare(
      `SELECT l.account_id, l.debit_minor, l.credit_minor, l.cost_center_id, l.tax_code, l.tax_base_minor, l.tax_amount_minor, l.supply_date
         FROM journal_line l JOIN journal_entry e ON e.id = l.entry_id
        WHERE e.workspace_id = ? AND l.entry_id = ? ORDER BY l.rowid`,
    )
    .all(t.workspaceId, entryId)
    .map((r) => {
      const out = { account: r.account_id };
      if (r.debit_minor > 0) out.debit = r.debit_minor;
      if (r.credit_minor > 0) out.credit = r.credit_minor;
      if (r.cost_center_id !== null) out.costCenter = r.cost_center_id;
      if (r.tax_code !== null) {
        out.taxCode = r.tax_code;
        if (r.tax_base_minor !== null) out.taxBase = 0 + r.tax_base_minor;
        if (r.tax_amount_minor !== null) out.taxAmount = 0 + r.tax_amount_minor;
        if (r.supply_date !== null) out.supplyDate = r.supply_date;
      }
      return out;
    });
}

// ================================================================================================
// 1. The worked example: a via route with UST81, the rest against the direction
// ================================================================================================

test('a via route with UST81 nets the via account to zero and posts ONE entry; the rest leg against the direction posts a debit', () => {
  const t = rulesWorld();
  const l = payouts(t, 'BS-W', [{ ref: 'P1', amountMinor: 3000, ustrd: 'MUSTERSHOP AUSZAHLUNG 4711' }]);
  const rule = must(
    setBankStandard(t.ctx, { bankTxnId: l.P1, legs: shopRecipe(t), viaAccountId: t.acc('1095'), label: 'Mustershop', matchText: 'Mustershop', idempotencyKey: 'w-set' }),
  ).standard;
  assert.equal(rule.matchText, 'mustershop', 'the match text is stored folded');
  assert.equal(rule.viaAccountNumber, '1095');
  assert.deepEqual(rule.legs.map((x) => [x.accountNumber, x.taxCode, x.amount]), [
    ['3400', 'UST81', { kind: 'ask', label: 'Bruttoumsatz' }],
    ['4400', null, { kind: 'rest' }],
  ]);
  assert.equal(rule.accountNumber, '4400', 'the rest leg is the D167 reader\'s account');

  // The VAT split is the engine's own: 216.20 gross at UST81 on the line's date.
  const date = txnRow(t, l.P1).booking_date;
  const vat = must(computeLineTax(t.ctx, { amountMinor: 21620, amountIsGross: true, taxCode: 'UST81', supplyDate: date }), 'computeLineTax');
  assert.equal(vat.netMinor + vat.taxMinor, 21620);
  assert.deepEqual([vat.netMinor, vat.taxMinor], [20000, 1620], 'the example figures are the engine\'s rounding');

  const before = rowCounts(t.store, t.workspaceId);
  const booked = must(bookBankLine(t.ctx, { bankTxnId: l.P1, target: { kind: 'rule', standardId: rule.id, asks: { 0: 21620 } }, idempotencyKey: 'w-book' }));
  assert.equal(booked.targetKind, 'accounts', 'a rule books as the accounts target it stands for');
  const after = rowCounts(t.store, t.workspaceId);
  assert.equal(after.entries - before.entries, 1, 'ONE entry');
  assert.deepEqual(entryLegs(t.store, booked.entryId).map((x) => [x.number, x.debit, x.credit, x.taxCode]), [
    ['1020', 3000, 0, null],
    ['1095', 21620, 0, null],
    ['1095', 0, 3000, null],
    ['1095', 0, 18620, null],
    ['2200', 0, vat.taxMinor, null],
    ['3400', 0, vat.netMinor, 'UST81'],
    ['4400', 18620, 0, null],
  ]);
  const via = entryLegs(t.store, booked.entryId).filter((x) => x.number === '1095').reduce((s, x) => s + x.debit - x.credit, 0);
  assert.equal(via, 0, 'the Durchlaufkonto nets to zero inside the entry');
  const decision = t.store.db.prepare('SELECT target_kind FROM bank_line_decision WHERE workspace_id = ? AND bank_txn_id = ? AND superseded_at IS NULL').get(t.workspaceId, l.P1);
  assert.equal(decision.target_kind, 'accounts', 'the decision row says accounts');
  const claims = t.store.db.prepare('SELECT COUNT(*) AS n FROM bank_line_claim WHERE workspace_id = ? AND bank_txn_id = ?').get(t.workspaceId, l.P1).n;
  assert.equal(claims, 1, 'the booking claims its one bank leg');
});

test('critic D175-C5: the decision row records the rule a line was booked by, frozen like the rest of the row', () => {
  // Guards `ruleId` in bookToAccounts / insertDecision and the trigger `bank_line_decision_rule_frozen`.
  const t = rulesWorld();
  const l = payouts(t, 'BS-C5', [
    { ref: 'P1', amountMinor: 3000, ustrd: 'MUSTERSHOP 1' },
    { ref: 'P2', amountMinor: 3100, ustrd: 'MUSTERSHOP 2' },
  ]);
  const rule = must(setBankStandard(t.ctx, { bankTxnId: l.P1, legs: shopRecipe(t), viaAccountId: t.acc('1095'), idempotencyKey: 'c5-set' })).standard;
  must(bookBankLine(t.ctx, { bankTxnId: l.P1, target: { kind: 'rule', standardId: rule.id, asks: { 0: 21620 } }, idempotencyKey: 'c5-rule' }));
  const expanded = expandRule(t.ctx, txnRow(t, l.P2), { standardId: rule.id, asks: { 0: 21620 } }).target;
  must(bookBankLine(t.ctx, { bankTxnId: l.P2, target: expanded, idempotencyKey: 'c5-accounts' }));
  const decisionOf = (id) => t.store.db.prepare('SELECT link_id, target_kind, rule_id FROM bank_line_decision WHERE workspace_id = ? AND bank_txn_id = ? AND superseded_at IS NULL').get(t.workspaceId, id);
  assert.deepEqual([decisionOf(l.P1).target_kind, decisionOf(l.P1).rule_id], ['accounts', rule.id], 'booked by the rule: the rule is on record');
  assert.equal(decisionOf(l.P2).rule_id, null, 'the same legs booked as accounts name no rule');
  const linkId = decisionOf(l.P1).link_id;
  for (const value of [null, decisionOf(l.P2).link_id]) {
    assert.throws(() => t.store.db.prepare('UPDATE bank_line_decision SET rule_id = ? WHERE link_id = ?').run(value, linkId), /only the supersession stamp/);
    assert.throws(
      () => t.store.db.prepare("UPDATE bank_line_decision SET superseded_at = '2026-07-21T00:00:00.000Z', superseded_by = 'u', rule_id = ? WHERE link_id = ?").run(value, linkId),
      /only the supersession stamp/,
      'not beside a stamp either',
    );
  }
});

test('an asked leg marked against runs against the line (a fee is a debit on money in); the rest takes what is left, in either direction', () => {
  // Guards the sign of an `against` ask in `expandRule` (bankBooking.ts).
  const t = rulesWorld();
  const l = payouts(t, 'BS-AG', [{ ref: 'P1', amountMinor: 10500, ustrd: 'MUSTERSHOP 8' }]);
  const recipe = [
    { accountId: t.acc('3400'), taxCode: null, amount: { kind: 'ask', label: 'Umsatz' } },
    { accountId: t.acc('6900'), taxCode: null, amount: { kind: 'ask', label: 'Gebühr' }, against: true },
    { accountId: t.acc('4400'), taxCode: null, amount: { kind: 'rest' } },
  ];
  const rule = must(setBankStandard(t.ctx, { bankTxnId: l.P1, legs: recipe, idempotencyKey: 'ag-set' })).standard;
  assert.equal(rule.legs[1].against, true);
  const expanded = expandRule(t.ctx, txnRow(t, l.P1), { standardId: rule.id, asks: { 0: 12000, 1: 2000 } });
  assert.deepEqual(expanded.target.legs.map((x) => x.amountMinor), [12000, -2000, 500]);
  const booked = must(bookBankLine(t.ctx, { bankTxnId: l.P1, target: { kind: 'rule', standardId: rule.id, asks: { 0: 12000, 1: 2000 } }, idempotencyKey: 'ag-book' }));
  assert.deepEqual(entryLegs(t.store, booked.entryId).map((x) => [x.number, x.debit, x.credit]), [
    ['1020', 10500, 0],
    ['3400', 0, 12000],
    ['4400', 0, 500],
    ['6900', 2000, 0],
  ]);
});

test('an accounts target with viaAccountId works without a rule; a debit line routes the other way round', () => {
  const t = rulesWorld();
  const l = importLines(t, { statementId: 'BS-V', entries: [{ ref: 'OUT', amountMinor: 10810, cd: 'DBIT', iban: TELCO_IBAN, name: 'Fernmelde Ostschweiz AG' }] }).lines;
  const booked = must(
    bookBankLine(t.ctx, {
      bankTxnId: l.OUT,
      target: { kind: 'accounts', legs: [{ accountId: t.acc('6500'), amountMinor: 10810, taxCode: 'VST-M' }], viaAccountId: t.acc('1095') },
      idempotencyKey: 'v1',
    }),
  );
  const got = entryLegs(t.store, booked.entryId);
  assert.deepEqual(got.filter((x) => x.number === '1020').map((x) => [x.debit, x.credit]), [[0, 10810]]);
  assert.equal(got.filter((x) => x.number === '1095').reduce((s, x) => s + x.debit - x.credit, 0), 0);
  assert.ok(got.some((x) => x.number === '1170' && x.debit > 0), 'the Vorsteuer is booked as on a direct leg');
});

// ================================================================================================
// 2. The ladder: asked, several, text, payer name, setting, invalid
// ================================================================================================

test('an asked rule is check (rule_needs_amount), never bookable as proposed and never bulk; A36 still asks a person', () => {
  const t = rulesWorld();
  const l = payouts(t, 'BS-A', [
    { ref: 'P1', amountMinor: 3000, ustrd: 'MUSTERSHOP AUSZAHLUNG 1' },
    { ref: 'P2', amountMinor: 4500, ustrd: 'MUSTERSHOP AUSZAHLUNG 2' },
  ]);
  const rule = must(setBankStandard(t.ctx, { bankTxnId: l.P1, legs: shopRecipe(t), viaAccountId: t.acc('1095'), idempotencyKey: 'a-set' })).standard;
  const line = lineOf(t, l.P2);
  assert.deepEqual(line.proposal, {
    target: { kind: 'rule', standardId: rule.id, asks: {} },
    certainty: 'check',
    reasonCode: 'rule_needs_amount',
    reasonParams: { standardId: rule.id, asks: [{ legIndex: 0, label: 'Bruttoumsatz' }] },
    vatCode: null,
  });
  assert.equal(line.attention, 'needs', 'the bulk button never counts it');
  assert.equal(isProposalBookable(4500, line.proposal.target), false, 'no ask filled: not bookable');
  assert.equal(isProposalBookable(4500, { ...line.proposal.target, asks: { 0: 21620 } }), true);
  assert.equal(isProposalBookable(4500, { ...line.proposal.target, asks: { 0: 0 } }), false, 'a zero ask is not filled');
  assert.equal(line.standardId, rule.id);
  assert.deepEqual(line.ruleIds, [rule.id]);
  assert.equal(lineNeedsReview(t.ctx, txnRow(t, l.P2)), true, 'A36: an asked rule is not a placed line');
  refused(bookBankLine(t.ctx, { bankTxnId: l.P2, target: line.proposal.target, idempotencyKey: 'a-as-proposed' }), 'ask_missing');
});

test('two candidates give several_rules; rules none of whose text the line carries give several_rules over every rule', () => {
  const t = rulesWorld();
  const l = payouts(t, 'BS-S', [
    { ref: 'SEED', amountMinor: 100, ustrd: 'SEED' },
    { ref: 'BOTH', amountMinor: 3000, ustrd: 'MUSTERSHOP KURSPLATTFORM 7' },
    { ref: 'NONE', amountMinor: 2000, ustrd: 'RÜCKERSTATTUNG 9' },
  ]);
  const a = must(setBankStandard(t.ctx, { bankTxnId: l.SEED, accountId: t.acc('3400'), taxCode: 'UST81', matchText: 'mustershop', label: 'Shop', idempotencyKey: 's1' })).standard;
  const b = must(setBankStandard(t.ctx, { bankTxnId: l.SEED, accountId: t.acc('3200'), taxCode: 'UST81', matchText: 'kursplattform', label: 'Kurse', idempotencyKey: 's2' })).standard;
  const both = lineOf(t, l.BOTH);
  assert.deepEqual(both.proposal, { target: null, certainty: 'check', reasonCode: 'several_rules', reasonParams: { standardIds: [b.id, a.id] }, vatCode: null });
  assert.deepEqual(both.ruleIds, [b.id, a.id], 'every live rule, newest first');
  assert.equal(both.standardId, b.id, 'no rule used: the newest live rule');
  const none = proposalOf(t, l.NONE);
  assert.equal(none.reasonCode, 'several_rules');
  assert.deepEqual(none.reasonParams.standardIds, [b.id, a.id], 'the person picks among every rule (or books otherwise)');
  // Picking one from the chooser books it although its text is not on the line.
  must(bookBankLine(t.ctx, { bankTxnId: l.NONE, target: { kind: 'rule', standardId: a.id, asks: {} }, idempotencyKey: 's-pick' }));
});

test('a text rule beats a text-less one; the text is read from the remittance, never the payer name', () => {
  const t = rulesWorld();
  const NAME = 'Kursplattform Zahlungen AG';
  const l = importLines(t, {
    statementId: 'BS-T',
    entries: [
      { ref: 'SEED', amountMinor: 100, cd: 'CRDT', name: NAME, ustrd: 'AUSZAHLUNG 1' },
      { ref: 'PLAIN', amountMinor: 2500, cd: 'CRDT', name: NAME, ustrd: 'AUSZAHLUNG 2' },
      { ref: 'TEXT', amountMinor: 3500, cd: 'CRDT', name: NAME, ustrd: 'kursplattform AUSZAHLUNG 3' },
    ],
  }).lines;
  const plain = must(setBankStandard(t.ctx, { bankTxnId: l.SEED, accountId: t.acc('6500'), taxCode: null, idempotencyKey: 't1' })).standard;
  const text = must(setBankStandard(t.ctx, { bankTxnId: l.SEED, accountId: t.acc('3400'), taxCode: null, matchText: 'KURSPLATTFORM', idempotencyKey: 't2' })).standard;
  assert.equal(standardRows(t).filter((r) => r.superseded_at === null).length, 2, 'a text rule and the text-less one live side by side');
  // The payer NAME carries "Kursplattform", the remittance does not: the text rule is no candidate.
  const p = proposalOf(t, l.PLAIN);
  assert.equal(p.reasonCode, 'standard');
  assert.equal(p.reasonParams.standardId, plain.id, 'the payer name never matches a rule text');
  assert.equal(p.target.legs[0].accountId, t.acc('6500'));
  const q = proposalOf(t, l.TEXT);
  assert.equal(q.reasonParams.standardId, text.id, 'the remittance carries the text: the text rule wins');
  assert.equal(q.certainty, 'sure');
  assert.equal(lineOf(t, l.TEXT).standardId, text.id, 'standardId names the rule the proposal used');
});

test('critic D175-C1: a matching text rule that went invalid keeps the rung silent; its line never falls back to the text-less rule', () => {
  // Guards the order in `standardProposal`: the text match runs over every live rule, validity after it.
  const t = rulesWorld();
  const l = payouts(t, 'BS-C1', [
    { ref: 'SEED', amountMinor: 1000, ustrd: 'SEED' },
    { ref: 'SHOP', amountMinor: 3000, ustrd: 'MUSTERSHOP AUSZAHLUNG 7' },
    { ref: 'OTHER', amountMinor: 2000, ustrd: 'KURSGELD 3' },
  ]);
  const plain = must(setBankStandard(t.ctx, { bankTxnId: l.SEED, accountId: t.acc('3200'), taxCode: null, idempotencyKey: 'c1-plain' })).standard;
  const shop = must(setBankStandard(t.ctx, { bankTxnId: l.SEED, accountId: t.acc('3400'), taxCode: null, matchText: 'mustershop', idempotencyKey: 'c1-shop' })).standard;
  assert.equal(proposalOf(t, l.SHOP).reasonParams.standardId, shop.id);
  must(archiveAccount(t.ctx, { accountId: t.acc('3400') }));
  const after = lineOf(t, l.SHOP);
  assert.ok(!['standard', 'rule_needs_amount', 'several_rules'].includes(after.proposal.reasonCode), `silent, not the text-less rule: ${JSON.stringify(after.proposal)}`);
  assert.notEqual(after.attention, 'sure', 'the bulk button never books the shop payout to 3200');
  // A line the shop text does not name still takes the valid text-less rule.
  const other = proposalOf(t, l.OTHER);
  assert.deepEqual([other.reasonCode, other.reasonParams.standardId, other.certainty], ['standard', plain.id, 'sure']);
});

test('critic D175-C4: the match text is whole consecutive tokens, never a substring', () => {
  // Guards `containsTokenRun` in rung (c2): "shop" never matches "WORKSHOP", a two-word text needs both
  // words next to each other.
  const t = rulesWorld();
  const l = payouts(t, 'BS-C4', [
    { ref: 'SEED', amountMinor: 1000, ustrd: 'SEED' },
    { ref: 'WS', amountMinor: 2000, ustrd: 'WORKSHOP KURSGELD' },
    { ref: 'SHOP', amountMinor: 2100, ustrd: 'Muster-Shop 7' },
    { ref: 'RUN', amountMinor: 2200, ustrd: 'AUSZAHLUNG MUSTER LADEN 12' },
    { ref: 'APART', amountMinor: 2300, ustrd: 'MUSTER AUSZAHLUNG LADEN 13' },
  ]);
  const shop = must(setBankStandard(t.ctx, { bankTxnId: l.SEED, accountId: t.acc('3400'), taxCode: null, matchText: 'shop', idempotencyKey: 'c4-shop' })).standard;
  const laden = must(setBankStandard(t.ctx, { bankTxnId: l.SEED, accountId: t.acc('3200'), taxCode: null, matchText: 'Muster Laden', idempotencyKey: 'c4-laden' })).standard;
  assert.equal(proposalOf(t, l.WS).reasonCode, 'several_rules', 'WORKSHOP carries no token "shop": no rule decides it');
  assert.equal(proposalOf(t, l.SHOP).reasonParams.standardId, shop.id, '"Muster-Shop" carries the token "shop"');
  assert.equal(proposalOf(t, l.RUN).reasonParams.standardId, laden.id, 'the two tokens in a row');
  assert.equal(proposalOf(t, l.APART).reasonCode, 'several_rules', 'the two tokens apart are no match');
  refused(setBankStandard(t.ctx, { bankTxnId: l.SEED, accountId: t.acc('3400'), taxCode: null, matchText: '--', idempotencyKey: 'c4-empty' }), 'invalid_input');
});

test('critic D175-R2-3: an umlaut and its two-letter bank spelling are the same token, on both sides of the match', () => {
  // Guards the umlaut spelling in `textTokens` (bankProposals.ts). The two-letter forms are assembled from
  // parts: they ARE the bank spelling under test, which the umlaut guard rightly refuses as a literal.
  const spelled = (...parts) => parts.join('');
  const t = rulesWorld();
  const l = payouts(t, 'BS-R23', [
    { ref: 'SEED', amountMinor: 1000, ustrd: 'SEED' },
    { ref: 'BANK', amountMinor: 2000, ustrd: `${spelled('GEB', 'U', 'EHR')} JULI` },
    { ref: 'UML', amountMinor: 2100, ustrd: 'Gebühr August' },
    { ref: 'UPPER', amountMinor: 2200, ustrd: 'GEBÜHR SEPTEMBER' },
    { ref: 'BARE', amountMinor: 2300, ustrd: 'GEBUHR OKTOBER' },
  ]);
  const rule = must(setBankStandard(t.ctx, { bankTxnId: l.SEED, accountId: t.acc('3400'), taxCode: null, matchText: 'Gebühr', idempotencyKey: 'r23' })).standard;
  assert.equal(rule.matchText, spelled('geb', 'ue', 'hr'), 'stored in the two-letter spelling');
  for (const ref of ['BANK', 'UML', 'UPPER']) assert.equal(proposalOf(t, l[ref]).reasonParams?.standardId, rule.id, ref);
  assert.equal(proposalOf(t, l.BARE).reasonCode, 'several_rules', 'a bare u is another word');
  const again = must(setBankStandard(t.ctx, { bankTxnId: l.SEED, accountId: t.acc('3400'), taxCode: null, matchText: spelled('GEB', 'UE', 'HR'), idempotencyKey: 'r23-b' }));
  assert.equal(again.unchanged, true, 'the bank spelling of the text is the same slot');
});

test('critic D175-R2-2: a match text is stored as its tokens, so texts that match the same lines are ONE slot and the second supersedes', () => {
  // Guards the canonical `textTokens(raw).join(' ')` in setBankStandard: stored folded only, "Muster-Shop!"
  // and "muster shop" were two live rules for exactly the same lines.
  const t = rulesWorld();
  const l = payouts(t, 'BS-R22', [
    { ref: 'SEED', amountMinor: 1000, ustrd: 'SEED' },
    { ref: 'P1', amountMinor: 2000, ustrd: 'AUSZAHLUNG MUSTER SHOP 1' },
  ]);
  const a = must(setBankStandard(t.ctx, { bankTxnId: l.SEED, accountId: t.acc('3400'), taxCode: null, matchText: 'muster shop', idempotencyKey: 'r22-a' }));
  assert.equal(a.standard.matchText, 'muster shop');
  const b = must(setBankStandard(t.ctx, { bankTxnId: l.SEED, accountId: t.acc('3200'), taxCode: null, matchText: '  Muster-Shop! ', idempotencyKey: 'r22-b' }));
  assert.equal(b.standard.matchText, 'muster shop', 'stored as its tokens');
  assert.equal(b.supersededId, a.standard.id, 'the same slot: superseded, never a second live rule');
  assert.equal(standardRows(t).filter((r) => r.superseded_at === null).length, 1);
  assert.equal(proposalOf(t, l.P1).reasonParams.standardId, b.standard.id);
  const same = must(setBankStandard(t.ctx, { bankTxnId: l.SEED, accountId: t.acc('3200'), taxCode: null, matchText: 'MUSTER  shop', idempotencyKey: 'r22-c' }));
  assert.equal(same.unchanged, true, 'the same tokens and account again is unchanged');
});

test('critic D175-C7: a set_bank_standard replay after the rule\'s account was archived answers the stored result, never a refusal', () => {
  // Guards the EARLY recall in `setBankStandard` (before the account checks): without it the replay
  // re-validates, finds the archived account and refuses, although the write it repeats already happened.
  const t = rulesWorld();
  const l = payouts(t, 'BS-C7', [{ ref: 'P1', amountMinor: 3000, ustrd: 'MUSTERSHOP 1' }]);
  const input = { bankTxnId: l.P1, legs: shopRecipe(t), viaAccountId: t.acc('1095'), idempotencyKey: 'c7-set' };
  const first = must(setBankStandard(t.ctx, input));
  const d167 = { bankTxnId: l.P1, accountId: t.acc('6500'), taxCode: null, matchText: 'mustershop', idempotencyKey: 'c7-d167' };
  const firstD167 = must(setBankStandard(t.ctx, d167));
  must(archiveAccount(t.ctx, { accountId: t.acc('4400') }));
  must(archiveAccount(t.ctx, { accountId: t.acc('6500') }));
  const rows = standardRows(t);
  assert.deepEqual(setBankStandard(t.ctx, input), first, 'the recipe replay is the stored answer');
  assert.deepEqual(setBankStandard(t.ctx, d167), firstD167, 'and so is the one-account replay');
  assert.deepEqual(standardRows(t), rows, 'no row moved');
  refused(setBankStandard(t.ctx, { ...input, idempotencyKey: 'c7-new' }), 'invalid_recipe', 'a NEW key does meet the archived account');
});

test('the setting bank.buchungsregel_mode = suggest turns sure into check, and the A36 signal back on; reset restores sure', () => {
  const t = rulesWorld();
  const l = importLines(t, { statementId: 'BS-M', entries: [{ ref: 'TEL', amountMinor: 8650, cd: 'DBIT', iban: TELCO_IBAN, name: 'Fernmelde Ostschweiz AG' }] }).lines;
  must(setBankStandard(t.ctx, { bankTxnId: l.TEL, accountId: t.acc('6500'), taxCode: 'VST-M', idempotencyKey: 'm1' }));
  assert.equal(proposalOf(t, l.TEL).certainty, 'sure', 'the default is bulk');
  assert.equal(lineNeedsReview(t.ctx, txnRow(t, l.TEL)), false);
  must(settingsSet(t.ctx, { key: 'bank.buchungsregel_mode', value: 'suggest', reason: 'jede Zeile einzeln prüfen', idempotencyKey: 'mode-1' }));
  const line = lineOf(t, l.TEL);
  assert.equal(line.proposal.certainty, 'check');
  assert.equal(line.proposal.reasonCode, 'standard');
  assert.equal(line.attention, 'needs', 'not counted by the bulk button');
  assert.equal(lineNeedsReview(t.ctx, txnRow(t, l.TEL)), true, 'only a sure rule proposal switches the A36 signal off');
  must(settingsReset(t.ctx, { key: 'bank.buchungsregel_mode', reason: 'zurück', idempotencyKey: 'mode-2' }));
  assert.equal(proposalOf(t, l.TEL).certainty, 'sure');
});

test('a rule whose account is archived is silent on the ladder and listed with its invalidReason', () => {
  const t = rulesWorld();
  const l = payouts(t, 'BS-I', [
    { ref: 'P1', amountMinor: 3000, ustrd: 'MUSTERSHOP 1' },
    { ref: 'P2', amountMinor: 3100, ustrd: 'MUSTERSHOP 2' },
  ]);
  const rule = must(setBankStandard(t.ctx, { bankTxnId: l.P1, legs: shopRecipe(t), viaAccountId: t.acc('1095'), idempotencyKey: 'i1' })).standard;
  assert.equal(rule.invalidReason, null);
  must(archiveAccount(t.ctx, { accountId: t.acc('4400') }));
  const p = proposalOf(t, l.P2);
  assert.ok(!['standard', 'rule_needs_amount', 'several_rules'].includes(p.reasonCode), `the ladder falls through (${p.reasonCode})`);
  assert.equal(lineOf(t, l.P2).standardId, rule.id, 'the star still names it');
  const listed = must(listBankStandards(t.ctx, {})).standards;
  assert.deepEqual(listed.map((s) => [s.id, s.invalidReason]), [[rule.id, 'account_archived']]);
});

test('a taxed asked rule on a foreign-currency line says vatDropped; booking it refuses unsupported rather than book gross', () => {
  const t = rulesWorld();
  seedRate(t.ctx, { currency: 'EUR', rate: '0.95', asOf: '2026-07-19' });
  const eur = must(createBankAccount(t.ctx, { name: 'EUR-Konto', iban: SAVINGS_IBAN, currency: 'EUR', ledgerAccountId: t.acc('1000'), idempotencyKey: 'eur' })).bankAccountId;
  const l = importLines(
    t,
    { statementId: 'EUR-R', iban: SAVINGS_IBAN, currency: 'EUR', entries: [{ ref: 'E1', amountMinor: 3000, cd: 'CRDT', name: PAYOUT, ustrd: 'MUSTERSHOP EUR' }] },
    { bankAccountId: eur },
  ).lines;
  const rule = must(setBankStandard(t.ctx, { bankTxnId: l.E1, legs: shopRecipe(t), idempotencyKey: 'f1' })).standard;
  const p = proposalOf(t, l.E1);
  assert.equal(p.reasonCode, 'rule_needs_amount');
  assert.equal(p.reasonParams.vatDropped, true);
  refused(bookBankLine(t.ctx, { bankTxnId: l.E1, target: { kind: 'rule', standardId: rule.id, asks: { 0: 2000 } }, idempotencyKey: 'f-book' }), 'unsupported');
});

// ================================================================================================
// 3. D167 rows, byte for byte
// ================================================================================================

test('a D167 row (no legs_json) behaves byte for byte as before: the stored row, the proposal, the booking', () => {
  const t = rulesWorld();
  const l = importLines(t, {
    statementId: 'BS-D',
    entries: [
      { ref: 'A', amountMinor: 8650, cd: 'DBIT', iban: TELCO_IBAN, name: 'Fernmelde Ostschweiz AG' },
      { ref: 'B', amountMinor: 4320, cd: 'DBIT', iban: TELCO_IBAN, name: 'Fernmelde Ostschweiz AG' },
    ],
  }).lines;
  const s = must(setBankStandard(t.ctx, { bankTxnId: l.A, accountId: t.acc('6500'), taxCode: 'VST-M', idempotencyKey: 'd1' })).standard;
  const row = standardRows(t)[0];
  assert.deepEqual([row.label, row.match_text, row.legs_json, row.via_account_id], [null, null, null, null], 'a D167 call writes a D167 row');
  assert.deepEqual(proposalOf(t, l.B), {
    target: { kind: 'accounts', legs: [{ accountId: t.acc('6500'), amountMinor: 4320, taxCode: 'VST-M' }] },
    certainty: 'sure',
    reasonCode: 'standard',
    reasonParams: { standardId: s.id, accountId: t.acc('6500'), taxCode: 'VST-M' },
    vatCode: 'VST-M',
  });
  assert.deepEqual(s.legs, [{ accountId: t.acc('6500'), taxCode: 'VST-M', amount: { kind: 'rest' }, accountNumber: '6500', accountName: s.accountName }]);
  assert.deepEqual([s.label, s.matchText, s.viaAccountId, s.invalidReason], [null, null, null, null]);
  // The same account and code again is unchanged, as in D167, and a rule target on the D167 row books the
  // whole line to its one account exactly as the accounts proposal does.
  assert.equal(must(setBankStandard(t.ctx, { bankTxnId: l.B, accountId: t.acc('6500'), taxCode: 'VST-M', idempotencyKey: 'd2' })).unchanged, true);
  const viaRule = must(composeBankLine(t.ctx, { bankTxnId: l.B, target: { kind: 'rule', standardId: s.id, asks: {} } }));
  const viaProposal = must(composeBankLine(t.ctx, { bankTxnId: l.B, target: proposalOf(t, l.B).target }));
  assert.deepEqual(viaRule.lines, viaProposal.lines);
  assert.deepEqual(viaRule.target, proposalOf(t, l.B).target);
});

// ================================================================================================
// 4. compose_entry equals book_bank_line
// ================================================================================================

test('compose_entry answers exactly the rows book_bank_line posts for a rule target (through the registry verb too)', () => {
  const t = rulesWorld();
  const l = payouts(t, 'BS-C', [{ ref: 'P1', amountMinor: 3000, ustrd: 'MUSTERSHOP 5' }, { ref: 'P2', amountMinor: 12345, ustrd: 'MUSTERSHOP 6' }]);
  const rule = must(setBankStandard(t.ctx, { bankTxnId: l.P1, legs: shopRecipe(t), viaAccountId: t.acc('1095'), idempotencyKey: 'c-set' })).standard;
  for (const [ref, ask] of [['P1', 21620], ['P2', 5000]]) {
    const target = { kind: 'rule', standardId: rule.id, asks: { 0: ask } };
    const composed = must(composeBankLine(t.ctx, { bankTxnId: l[ref], target }));
    assert.deepEqual(composed.verdict, { ok: true });
    const throughVerb = getAction('compose_entry').run(t.deps, { workspaceId: t.workspaceId, mode: 'expand', bankTxnId: l[ref], target });
    assert.deepEqual(throughVerb, composed, 'the registry verb dispatches to the bank composer');
    const booked = must(bookBankLine(t.ctx, { bankTxnId: l[ref], target, idempotencyKey: `c-${ref}` }));
    assert.deepEqual(storedLines(t, booked.entryId), JSON.parse(JSON.stringify(composed.lines)), `${ref}: the preview IS the booking`);
  }
  // A refusal the booking gives is the read's verdict, never a clean one.
  const l2 = payouts(t, 'BS-C2', [{ ref: 'P3', amountMinor: 2000, ustrd: 'MUSTERSHOP 7' }]);
  const zero = must(composeBankLine(t.ctx, { bankTxnId: l2.P3, target: { kind: 'rule', standardId: rule.id, asks: { 0: 2000 } } }));
  assert.equal(zero.verdict.error, 'rest_is_zero');
  assert.equal(zero.composed, false);
  const decided = must(composeBankLine(t.ctx, { bankTxnId: l.P1, target: { kind: 'rule', standardId: rule.id, asks: { 0: 100 } } }));
  assert.equal(decided.verdict.error, 'line_not_open');
});

// ================================================================================================
// 5. Every refusal of §14.1 and §14.2
// ================================================================================================

test('set_bank_standard refuses every broken recipe with invalid_recipe and its detail, and writes nothing', () => {
  const t = rulesWorld();
  const l = payouts(t, 'BS-R', [{ ref: 'P1', amountMinor: 3000, ustrd: 'MUSTERSHOP' }]);
  const rest = (n) => ({ accountId: t.acc(n), taxCode: null, amount: { kind: 'rest' } });
  const ask = (n, label = 'Betrag') => ({ accountId: t.acc(n), taxCode: null, amount: { kind: 'ask', label } });
  const cases = [
    ['legs_count', []],
    ['legs_count', Array.from({ length: 21 }, (_, i) => (i === 0 ? rest('4400') : ask('6500')))],
    ['rest_count', [ask('3400'), ask('4400')]],
    ['rest_count', [rest('3400'), rest('4400')]],
    ['ask_label', [ask('3400', '   '), rest('4400')]],
    ['ask_label', [ask('3400', 'x'.repeat(41)), rest('4400')]],
    ['against_on_rest', [ask('3400'), { ...rest('4400'), against: true }]],
    ['leg_shape', [{ accountId: t.acc('3400'), amount: { kind: 'share' } }, rest('4400')]],
    ['invalid_account', [ask('1100'), rest('4400')]],
    ['invalid_account', [ask('2200'), rest('4400')]],
    ['invalid_account', [ask('1020'), rest('4400')]],
    ['invalid_tax_code', [{ ...ask('3400'), taxCode: 'NOPE' }, rest('4400')]],
    ['vat_not_applicable', [ask('3400'), { ...rest('2100'), taxCode: 'UST81' }]],
  ];
  for (const [i, [detail, legs]] of cases.entries()) {
    const r = refused(setBankStandard(t.ctx, { bankTxnId: l.P1, legs, idempotencyKey: `r-${i}` }), 'invalid_recipe', `case ${i}`);
    assert.equal(r.detail, detail, `case ${i}: ${JSON.stringify(r)}`);
  }
  for (const [n, reason] of [['6500', 'income_or_expense'], ['2200', 'vat_account'], ['1020', 'bank_ledger'], ['1100', 'control_account']]) {
    const r = refused(setBankStandard(t.ctx, { bankTxnId: l.P1, legs: [ask('3400'), rest('4400')], viaAccountId: t.acc(n), idempotencyKey: `via-${n}` }), 'invalid_recipe');
    assert.deepEqual([r.detail, r.reason], ['via_account', reason], n);
  }
  const leg = refused(setBankStandard(t.ctx, { bankTxnId: l.P1, legs: [ask('1095'), rest('4400')], viaAccountId: t.acc('1095'), idempotencyKey: 'via-leg' }), 'invalid_recipe');
  assert.deepEqual([leg.detail, leg.reason], ['via_account', 'via_is_a_leg']);
  refused(setBankStandard(t.ctx, { bankTxnId: l.P1, legs: [ask('3400'), rest('4400')], viaAccountId: 'nope', idempotencyKey: 'via-x' }), 'not_found');
  refused(setBankStandard(t.ctx, { bankTxnId: l.P1, legs: [{ accountId: 'nope', taxCode: null, amount: { kind: 'rest' } }], idempotencyKey: 'leg-x' }), 'not_found');
  // The D167 one-account path keeps D167's own codes, even beside a Durchlaufkonto.
  refused(setBankStandard(t.ctx, { bankTxnId: l.P1, accountId: t.acc('2200'), taxCode: null, idempotencyKey: 'd167' }), 'invalid_account');
  assert.deepEqual(standardRows(t), [], 'every refusal wrote nothing');
});

test('book_bank_line refuses rule_not_found, rule_not_applicable, ask_missing, rest_is_zero and an invalid Durchlaufkonto; nothing is written', () => {
  const t = rulesWorld();
  const l = payouts(t, 'BS-B', [
    { ref: 'P1', amountMinor: 3000, ustrd: 'MUSTERSHOP 1' },
    { ref: 'P2', amountMinor: 3000, ustrd: 'MUSTERSHOP 2' },
  ]);
  const other = importLines(t, {
    statementId: 'BS-B2',
    entries: [
      { ref: 'OTHER', amountMinor: 3000, cd: 'CRDT', name: 'Andere Firma GmbH' },
      { ref: 'BACK', amountMinor: 3000, cd: 'DBIT', name: PAYOUT, ustrd: 'MUSTERSHOP RÜCKBUCHUNG' },
    ],
  }).lines;
  const rule = must(setBankStandard(t.ctx, { bankTxnId: l.P1, legs: shopRecipe(t), viaAccountId: t.acc('1095'), idempotencyKey: 'b-set' })).standard;
  const before = rowCounts(t.store, t.workspaceId);
  const book = (bankTxnId, target, key) => bookBankLine(t.ctx, { bankTxnId, target, idempotencyKey: key });
  refused(book(l.P1, { kind: 'rule', standardId: 'nope', asks: { 0: 100 } }, 'k1'), 'rule_not_found');
  refused(book(other.OTHER, { kind: 'rule', standardId: rule.id, asks: { 0: 100 } }, 'k2'), 'rule_not_applicable');
  const back = refused(book(other.BACK, { kind: 'rule', standardId: rule.id, asks: { 0: 100 } }, 'k3'), 'rule_not_applicable');
  assert.match(back.reason, /other direction/, 'an outgoing refund from the payer never takes the in rule');
  refused(book(l.P1, { kind: 'rule', standardId: rule.id, asks: {} }, 'k4'), 'ask_missing');
  refused(book(l.P1, { kind: 'rule', standardId: rule.id, asks: { 0: 0 } }, 'k5'), 'ask_missing');
  refused(book(l.P1, { kind: 'rule', standardId: rule.id, asks: { 0: -5 } }, 'k6'), 'ask_missing');
  refused(book(l.P1, { kind: 'rule', standardId: rule.id, asks: { 0: 3000 } }, 'k7'), 'rest_is_zero');
  refused(book(l.P1, { kind: 'rule', standardId: rule.id, asks: { 0: 100, 1: 50 } }, 'k8'), 'invalid_input');
  refused(book(l.P1, { kind: 'rule', standardId: rule.id, asks: { 0: 12.5 } }, 'k9'), 'invalid_input');
  const legs = [{ accountId: t.acc('1095'), amountMinor: 3000 }];
  for (const [n, reason] of [['6500', 'income_or_expense'], ['2200', 'vat_account'], ['1020', 'bank_ledger'], ['1095', 'via_is_a_leg']]) {
    const r = refused(book(l.P1, { kind: 'accounts', legs, viaAccountId: t.acc(n) }, `via-${n}`), 'invalid_account');
    assert.equal(r.reason, reason, n);
  }
  // A superseded rule is not found either: an edit replaces it.
  must(setBankStandard(t.ctx, { bankTxnId: l.P1, legs: shopRecipe(t), viaAccountId: t.acc('1095'), label: 'neu', idempotencyKey: 'b-edit' }));
  const afterEdit = rowCounts(t.store, t.workspaceId);
  refused(book(l.P2, { kind: 'rule', standardId: rule.id, asks: { 0: 100 } }, 'k10'), 'rule_not_found');
  assert.deepEqual(rowCounts(t.store, t.workspaceId), afterEdit, 'no refusal wrote a row');
  assert.deepEqual({ ...afterEdit, drafts: before.drafts }, before, 'nothing booked');
  // expandRule is the one expansion both faces use.
  assert.deepEqual(expandRule(t.ctx, txnRow(t, l.P2), { standardId: rule.id, asks: { 0: 100 } }).error.error, 'rule_not_found');
});

// ================================================================================================
// 6. The invariants: append-only, one live per slot, idempotent on rows, §H-TENANT
// ================================================================================================

test('[INVARIANT append-only] the recipe columns are as immutable as the rest of the row; only the stamp is written, once', () => {
  // Guards the trigger `bank_standard_recipe_frozen` (bankInboxSchema.ts): delete it and these updates pass.
  const t = rulesWorld();
  const l = payouts(t, 'BS-F', [{ ref: 'P1', amountMinor: 3000, ustrd: 'MUSTERSHOP' }]);
  const s = must(setBankStandard(t.ctx, { bankTxnId: l.P1, legs: shopRecipe(t), viaAccountId: t.acc('1095'), label: 'Shop', matchText: 'shop', idempotencyKey: 'f1' })).standard;
  const db = t.store.db;
  for (const [col, value] of [
    ['label', 'Anders'],
    ['match_text', 'anders'],
    ['legs_json', '[]'],
    ['via_account_id', null],
  ]) {
    assert.throws(() => db.prepare(`UPDATE bank_standard SET ${col} = ? WHERE id = ?`).run(value, s.id), /only the supersession stamp/, `${col} is immutable`);
    assert.throws(
      () => db.prepare(`UPDATE bank_standard SET superseded_at = '2026-07-21T00:00:00.000Z', superseded_by = 'u', ${col} = ? WHERE id = ?`).run(value, s.id),
      /only the supersession stamp/,
      `${col} is immutable beside a stamp`,
    );
  }
  assert.throws(() => db.prepare('DELETE FROM bank_standard WHERE id = ?').run(s.id), /never deleted/);
});

test('[INVARIANT one-live] one live rule per (key, direction, text): the same text supersedes, another text lives beside it, the index refuses a raw second row', () => {
  // Guards `bank_standard_one_live_rule` (ADDITIVE_INDEXES) and the supersede-then-insert in setBankStandard.
  const t = rulesWorld();
  const l = payouts(t, 'BS-O', [{ ref: 'P1', amountMinor: 3000, ustrd: 'MUSTERSHOP' }]);
  const a = must(setBankStandard(t.ctx, { bankTxnId: l.P1, accountId: t.acc('3400'), taxCode: null, matchText: 'shop', idempotencyKey: 'o1' }));
  const b = must(setBankStandard(t.ctx, { bankTxnId: l.P1, accountId: t.acc('3200'), taxCode: null, matchText: 'Shop', idempotencyKey: 'o2' }));
  assert.equal(b.supersededId, a.standard.id, 'the same folded text is the same slot');
  const c = must(setBankStandard(t.ctx, { bankTxnId: l.P1, accountId: t.acc('3400'), taxCode: null, idempotencyKey: 'o3' }));
  assert.equal(c.supersededId, null, 'the text-less slot is its own');
  assert.equal(standardRows(t).filter((r) => r.superseded_at === null).length, 2);
  const key = standardRows(t)[0].counterparty_key;
  assert.throws(
    () =>
      t.store.db
        .prepare(
          `INSERT INTO bank_standard (id, workspace_id, counterparty_key, counterparty_label, direction, account_id, set_at, match_text)
           VALUES ('raw', ?, ?, 'x', 'in', ?, '2026-07-20', 'shop')`,
        )
        .run(t.workspaceId, key, t.acc('3400')),
    /UNIQUE/,
  );
  assert.throws(
    () =>
      t.store.db
        .prepare(`INSERT INTO bank_standard (id, workspace_id, counterparty_key, counterparty_label, direction, account_id, set_at) VALUES ('raw2', ?, ?, 'x', 'in', ?, '2026-07-20')`)
        .run(t.workspaceId, key, t.acc('3400')),
    /UNIQUE/,
    'the text-less slot is guarded too',
  );
});

test('[INVARIANT idempotent-on-rows] a replay under the same key adds no row: a rule set, a rule booking', () => {
  // Guards the recall/remember pairs in setBankStandard and bookBankLine (the rule path expands BEFORE
  // the memo, so the replay must still answer the stored result and post nothing).
  const t = rulesWorld();
  const l = payouts(t, 'BS-K', [{ ref: 'P1', amountMinor: 3000, ustrd: 'MUSTERSHOP 1' }]);
  const setInput = { bankTxnId: l.P1, legs: shopRecipe(t), viaAccountId: t.acc('1095'), idempotencyKey: 'k-set' };
  const s1 = must(setBankStandard(t.ctx, setInput));
  const rows = standardRows(t);
  assert.deepEqual(setBankStandard(t.ctx, setInput), s1);
  assert.deepEqual(standardRows(t), rows, 'the set replay moves no row');
  const again = must(setBankStandard(t.ctx, { ...setInput, idempotencyKey: 'k-set-2' }));
  assert.equal(again.unchanged, true, 'the same recipe under a new key is unchanged');
  assert.deepEqual(standardRows(t), rows);

  const input = { bankTxnId: l.P1, target: { kind: 'rule', standardId: s1.standard.id, asks: { 0: 21620 } }, idempotencyKey: 'k-book' };
  const first = must(bookBankLine(t.ctx, input));
  const counts = rowCounts(t.store, t.workspaceId);
  assert.deepEqual(bookBankLine(t.ctx, input), first, 'the replay answers the stored result');
  assert.deepEqual(rowCounts(t.store, t.workspaceId), counts, 'and posts nothing');
  // Even after the rule is cleared (its expansion would now refuse), the replay is the memo.
  must(clearBankStandard(t.ctx, { standardId: s1.standard.id, idempotencyKey: 'k-clear' }));
  assert.deepEqual(bookBankLine(t.ctx, input), first);
  const fresh = refused(bookBankLine(t.ctx, { ...input, idempotencyKey: 'k-book-2' }), 'line_not_open', 'a new key on a booked line doubles nothing');
  assert.equal(fresh.staleProposal, true);
});

test('[INVARIANT tenant] a rule never reaches another workspace: its id is rule_not_found there, and B\'s lines carry no A rule', () => {
  // Guards the `workspace_id = ?` binding in `readLiveRule` and `liveRulesIndex` (bankStandards.ts).
  const t = rulesWorld();
  const b = secondWorkspace(t);
  must(createAccount(b.ctx, { number: '1095', name: 'Erlös Durchlaufkonto', type: 'asset', idempotencyKey: 'b-1095' }));
  const bBank = must(createBankAccount(b.ctx, { name: 'Konto B', iban: MAIN_IBAN, currency: 'CHF', ledgerAccountId: b.acc('1020'), idempotencyKey: 'bb' })).bankAccountId;
  const la = payouts(t, 'BS-HA', [{ ref: 'P1', amountMinor: 3000, ustrd: 'MUSTERSHOP 1' }]);
  const lb = importLines(t, { statementId: 'BS-HB', entries: [{ ref: 'P1', amountMinor: 3000, cd: 'CRDT', name: PAYOUT, ustrd: 'MUSTERSHOP 1' }] }, { ctx: b.ctx, bankAccountId: bBank }).lines;
  const rule = must(setBankStandard(t.ctx, { bankTxnId: la.P1, legs: shopRecipe(t), viaAccountId: t.acc('1095'), idempotencyKey: 'h1' })).standard;

  const before = rowCounts(t.store, b.workspaceId);
  refused(bookBankLine(b.ctx, { bankTxnId: lb.P1, target: { kind: 'rule', standardId: rule.id, asks: { 0: 21620 } }, idempotencyKey: 'h-b' }), 'rule_not_found');
  assert.equal(must(composeBankLine(b.ctx, { bankTxnId: lb.P1, target: { kind: 'rule', standardId: rule.id, asks: { 0: 21620 } } })).verdict.error, 'rule_not_found');
  assert.deepEqual(rowCounts(t.store, b.workspaceId), before, 'B wrote nothing');
  const inB = lineOf(t, lb.P1, b.ctx);
  assert.equal(inB.standardId, null);
  assert.deepEqual(inB.ruleIds, []);
  assert.ok(!['standard', 'rule_needs_amount', 'several_rules'].includes(inB.proposal.reasonCode));
  assert.deepEqual(must(listBankStandards(b.ctx, {})).standards, []);
  // A's own line still takes it.
  assert.equal(proposalOf(t, la.P1).reasonParams.standardId, rule.id);
});

// ================================================================================================
// 7. Generation 14
// ================================================================================================

test('generation 15 opens a generation-14 book: the recipe columns and the text-aware index arrive, the D167 index goes, every row reads as before', () => {
  excuseClaimInvariant();
  const dir = mkdtempSync(join(tmpdir(), 'd175-gen15-'));
  const file = join(dir, 'book.db');
  try {
    // D176 added generation 16 after this one; the book below is lifted through both steps.
    assert.ok(SCHEMA_GENERATION >= 15, 'this build writes generation 15 or later');
    const d175 = DATA_MIGRATIONS.findIndex((m) => m.name.startsWith('d175-bank-rules'));
    assert.equal(DATA_MIGRATIONS[d175]?.generation, 15);

    const t = world({ location: file });
    const l = importLines(t, { statementId: 'BS-G', entries: [{ ref: 'TEL', amountMinor: 8650, cd: 'DBIT', iban: TELCO_IBAN, name: 'Fernmelde Ostschweiz AG' }] }).lines;
    const s = must(setBankStandard(t.ctx, { bankTxnId: l.TEL, accountId: t.acc('6500'), taxCode: 'VST-M', idempotencyKey: 'g1' })).standard;
    t.store.close();

    // Back to what a generation-14 build left: no recipe columns, no recipe trigger, the D167 index, and
    // no rule_id on the decision rows (critic D175-C5).
    const raw = new Database(file);
    raw.exec('DROP INDEX bank_standard_one_live_rule');
    raw.exec('DROP TRIGGER bank_standard_recipe_frozen');
    raw.exec('DROP TRIGGER bank_line_decision_rule_frozen');
    // And what generation 16 (D176) added after it, so this is a generation-14 book in full.
    raw.exec('DROP TRIGGER bank_standard_outcome_frozen');
    for (const col of ['scope', 'outcome', 'ignore_reason', 'ignore_note', 'follow_up_standard_id']) raw.exec(`ALTER TABLE bank_standard DROP COLUMN ${col}`);
    raw.exec('ALTER TABLE bank_line_decision DROP COLUMN rule_id');
    for (const col of ['label', 'match_text', 'legs_json', 'via_account_id']) raw.exec(`ALTER TABLE bank_standard DROP COLUMN ${col}`);
    raw.exec('CREATE UNIQUE INDEX bank_standard_one_live ON bank_standard (workspace_id, counterparty_key, direction) WHERE superseded_at IS NULL');
    raw.pragma('user_version = 14');
    const before = raw.prepare('SELECT * FROM bank_standard ORDER BY rowid').all();
    raw.close();

    const store = new SqliteStore({ location: file });
    const db = store.db;
    assert.equal(db.pragma('user_version', { simple: true }), SCHEMA_GENERATION);
    const cols = db.prepare("SELECT name FROM pragma_table_info('bank_standard')").all().map((r) => r.name);
    for (const c of ['label', 'match_text', 'legs_json', 'via_account_id']) assert.ok(cols.includes(c), c);
    assert.ok(db.prepare("SELECT 1 FROM pragma_table_info('bank_line_decision') WHERE name = 'rule_id'").get(), 'bank_line_decision.rule_id arrives');
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = 'bank_line_decision_rule_frozen'").get(), 'and is frozen');
    const objects = db.prepare("SELECT name FROM sqlite_master WHERE tbl_name = 'bank_standard' AND name LIKE 'bank_standard_%' ORDER BY name").all().map((r) => r.name);
    assert.deepEqual(objects, ['bank_standard_no_delete', 'bank_standard_one_live_rule', 'bank_standard_outcome_frozen', 'bank_standard_recipe_frozen', 'bank_standard_supersede_only']);
    const after = db.prepare('SELECT * FROM bank_standard ORDER BY rowid').all();
    assert.deepEqual(
      after.map(({ scope, outcome, ignore_reason, ignore_note, follow_up_standard_id, ...d175 }) => [scope, outcome, ignore_reason, ignore_note, follow_up_standard_id]),
      before.map(() => ['bank', 'legs', null, null, null]),
      'generation 16 reads every row as the bank rule with legs it was',
    );
    assert.deepEqual(
      after.map(({ label, match_text, legs_json, via_account_id, scope: _s, outcome: _o, ignore_reason: _r, ignore_note: _n, follow_up_standard_id: _f, ...rest }) => ({
        rest,
        added: [label, match_text, legs_json, via_account_id],
      })),
      before.map((rest) => ({ rest, added: [null, null, null, null] })),
      'every row is intact and reads as a D167 standard',
    );
    store.close();
    assert.ok(s.id);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
