// D176 (spec A39 §15): Buchungsregeln everywhere. A Buchungsregel gains a SCOPE (`bank`, the D175 rule a
// bank line proposes; `manual`, a VORLAGE the Buchungssatz composer books from), an OUTCOME (`legs`, or
// `ignore`: "Nicht buchen" with a reason and a note) and a NEXT STEP (a follow-up Vorlage). Every bullet of
// §15.5 has a test here, named after it; the money-path invariants are marked [INVARIANT ...] for the
// non-author critic, each saying in its comment which code it guards, so a mutation of that code fails it.
//
// SYNTHETIC DATA ONLY: every statement is spelled by hand in bank-inbox-support.mjs; the payout service and
// the course platform are invented names, every amount is invented. The worked example: a month entry of a
// course platform with a gross of 216.20 (UST81) and a coach share of 186.20, through 1095.

import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

import {
  listBankInbox,
  bookBankLine,
  ignoreBankLine,
  setBankStandard,
  clearBankStandard,
  listBankStandards,
  lineNeedsReview,
  isProposalBookable,
  createBankAccount,
} from '../../dist/core/banking/index.js';
import { composeBankLine } from '../../dist/core/banking/bankBooking.js';
import { composeTemplate, expandTemplate, postEntryFromTemplate } from '../../dist/core/banking/bankTemplates.js';
import { getAction } from '../../dist/api/registry.js';
import { createAccount, archiveAccount } from '../../dist/core/accounts/accounts.js';
import { computeLineTax } from '../../dist/core/vat/applyVat.js';
import { settingsSet } from '../../dist/core/settings/index.js';
import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { makeContext } from '../../dist/core/context.js';
import { SCHEMA_GENERATION } from '../../dist/core/store/schema.js';
import { DATA_MIGRATIONS } from '../../dist/core/store/migrations.js';
import {
  world,
  secondWorkspace,
  importLines,
  must,
  refused,
  legs as entryLegs,
  rowCounts,
  balanceOf,
  excuseClaimInvariant,
  assertClaimInvariantHolds,
  TELCO_IBAN,
  SAVINGS_IBAN,
} from './bank-inbox-support.mjs';

afterEach(assertClaimInvariantHolds);

const PAYOUT = 'Zahlwerk Beispiel Ltd';
const DATE = '2026-07-31';
const lineOf = (t, id, ctx = t.ctx) => must(listBankInbox(ctx, { status: 'all' }), 'inbox').lines.find((l) => l.bankTxnId === id);
const proposalOf = (t, id, ctx = t.ctx) => lineOf(t, id, ctx).proposal;
const standardRows = (t, ws = t.workspaceId) => t.store.db.prepare('SELECT * FROM bank_standard WHERE workspace_id = ? ORDER BY rowid').all(ws);
const txnRow = (t, id) => t.store.db.prepare('SELECT * FROM bank_txn WHERE id = ?').get(id);
const call = (t, name, input, deps = t.deps) => getAction(name).run(deps, { workspaceId: t.workspaceId, ...input });

/** The world plus the Erlös Durchlaufkonto 1095 (a balance account the KMU seed does not carry). */
function vorlagenWorld() {
  const t = world();
  must(createAccount(t.ctx, { number: '1095', name: 'Erlös Durchlaufkonto', type: 'asset', idempotencyKey: 'acc-1095' }), '1095');
  return t;
}

/**
 * The worked example's Vorlage "Monatsumsatz": 1095 Soll asked as Bruttoumsatz; 3400 Haben with UST81, the
 * SAME amount as leg 0; 4400 Soll asked as Coach-Anteil; 1095 Haben the rest.
 */
function monthRecipe(t) {
  return [
    { accountId: t.acc('1095'), taxCode: null, side: 'debit', amount: { kind: 'ask', label: 'Bruttoumsatz' } },
    { accountId: t.acc('3400'), taxCode: 'UST81', side: 'credit', amount: { kind: 'same', legIndex: 0 } },
    { accountId: t.acc('4400'), taxCode: null, side: 'debit', amount: { kind: 'ask', label: 'Coach-Anteil' } },
    { accountId: t.acc('1095'), taxCode: null, side: 'credit', amount: { kind: 'rest' } },
  ];
}

function monthVorlage(t, key = 'v-month', label = 'Monatsumsatz', ctx = t.ctx) {
  return must(setBankStandard(ctx, { scope: 'manual', label, legs: monthRecipe(t), idempotencyKey: key }), 'Vorlage').standard;
}

/** Payout lines from the invented payout service. */
function payouts(t, statementId, entries) {
  return importLines(t, { statementId, entries: entries.map((e) => ({ cd: 'CRDT', name: PAYOUT, ...e })) }).lines;
}

/** The rows an entry stores, in the post_entry line shape, in row order. */
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

const postTemplate = (t, template, key, extra = {}, deps = t.deps) =>
  call(t, 'post_entry', { date: DATE, source: 'manual', template, idempotencyKey: key, ...extra }, deps);

// ================================================================================================
// 1. A manual Vorlage with `same` posts the month entry and balances
// ================================================================================================

test('a manual Vorlage with same posts the month entry (1095 D gross / 3400 + 2200 C; 4400 D / 1095 C) and balances', () => {
  const t = vorlagenWorld();
  const v = monthVorlage(t);
  assert.equal(v.scope, 'manual');
  assert.equal(v.outcome, 'legs');
  assert.equal(v.label, 'Monatsumsatz');
  assert.deepEqual([v.counterpartyKey, v.counterpartyLabel, v.direction], [null, null, null], 'a Vorlage has no counterparty and no direction');
  assert.deepEqual(
    v.legs.map((l) => [l.accountNumber, l.side, l.taxCode, l.amount]),
    [
      ['1095', 'debit', null, { kind: 'ask', label: 'Bruttoumsatz' }],
      ['3400', 'credit', 'UST81', { kind: 'same', legIndex: 0 }],
      ['4400', 'debit', null, { kind: 'ask', label: 'Coach-Anteil' }],
      ['1095', 'credit', null, { kind: 'rest' }],
    ],
  );
  assert.equal(standardRows(t)[0].counterparty_key, 'vorlage:monatsumsatz', 'keyed by its folded label');

  // The VAT split is the engine's own: 216.20 gross at UST81 on the entry date.
  const vat = must(computeLineTax(t.ctx, { amountMinor: 21620, amountIsGross: true, taxCode: 'UST81', supplyDate: DATE }), 'computeLineTax');
  assert.deepEqual([vat.netMinor, vat.taxMinor], [20000, 1620]);

  const template = { standardId: v.id, asks: { 0: 21620, 2: 18620 } };
  const before = rowCounts(t.store, t.workspaceId);
  const posted = must(postTemplate(t, template, 'm-post'), 'post_entry template');
  const after = rowCounts(t.store, t.workspaceId);
  assert.equal(after.entries - before.entries, 1, 'ONE entry');
  assert.deepEqual(entryLegs(t.store, posted.entryId).map((x) => [x.number, x.debit, x.credit, x.taxCode]), [
    ['1095', 21620, 0, null],
    ['1095', 0, 18620, null],
    ['2200', 0, 1620, null],
    ['3400', 0, 20000, 'UST81'],
    ['4400', 18620, 0, null],
  ]);
  const sums = entryLegs(t.store, posted.entryId).reduce((s, x) => [s[0] + x.debit, s[1] + x.credit], [0, 0]);
  assert.deepEqual(sums, [40240, 40240], 'debits equal credits');
  assert.equal(balanceOf(t.store, t.workspaceId, '1095'), 3000, '1095 keeps the 30.00 the payout line then clears');
  const entry = t.store.db.prepare('SELECT description, source, status FROM journal_entry WHERE id = ?').get(posted.entryId);
  assert.deepEqual(entry, { description: 'Monatsumsatz', source: 'manual', status: 'posted' }, 'the text defaults to the Vorlage name');
});

test('compose_entry with a template answers exactly the lines post_entry stores, and the amounts per leg', () => {
  const t = vorlagenWorld();
  const v = monthVorlage(t);
  const template = { standardId: v.id, asks: { 0: 21620, 2: 18620 } };
  const before = rowCounts(t.store, t.workspaceId);
  const composed = must(call(t, 'compose_entry', { mode: 'expand', date: DATE, template }), 'compose');
  assert.deepEqual(rowCounts(t.store, t.workspaceId), before, 'the read writes nothing');
  assert.equal(composed.verdict.ok, true);
  assert.deepEqual(composed.template, {
    standardId: v.id,
    label: 'Monatsumsatz',
    amounts: [
      { legIndex: 0, side: 'debit', amount: 21620 },
      { legIndex: 1, side: 'credit', amount: 21620 },
      { legIndex: 2, side: 'debit', amount: 18620 },
      { legIndex: 3, side: 'credit', amount: 18620 },
    ],
  });
  assert.deepEqual(composeTemplate(t.ctx, { date: DATE, template }), composed, 'the registry verb dispatches to the template composer');
  const posted = must(postTemplate(t, template, 'p-post'));
  assert.deepEqual(storedLines(t, posted.entryId), JSON.parse(JSON.stringify(composed.lines)), 'the preview IS the posting');
});

test('same also works in a bank recipe: the payout through 1095 asks the gross once and books it twice', () => {
  const t = vorlagenWorld();
  const l = payouts(t, 'BS-S', [{ ref: 'P1', amountMinor: 3000, ustrd: 'KURSPLATTFORM AUSZAHLUNG 7' }]);
  const rule = must(
    setBankStandard(t.ctx, {
      bankTxnId: l.P1,
      label: 'Kursplattform',
      legs: [
        { accountId: t.acc('3400'), taxCode: 'UST81', amount: { kind: 'ask', label: 'Bruttoumsatz' } },
        { accountId: t.acc('1095'), taxCode: null, amount: { kind: 'same', legIndex: 0 }, against: true },
        { accountId: t.acc('4400'), taxCode: null, amount: { kind: 'rest' } },
      ],
      idempotencyKey: 's-set',
    }),
  ).standard;
  const booked = must(bookBankLine(t.ctx, { bankTxnId: l.P1, target: { kind: 'rule', standardId: rule.id, asks: { 0: 21620 } }, idempotencyKey: 's-book' }));
  // 3400 +216.20 (in), 1095 -216.20 (against), the rest 4400 = 30.00 - 216.20 + 216.20 = 30.00.
  assert.deepEqual(entryLegs(t.store, booked.entryId).map((x) => [x.number, x.debit, x.credit]), [
    ['1020', 3000, 0],
    ['1095', 21620, 0],
    ['2200', 0, 1620],
    ['3400', 0, 20000],
    ['4400', 0, 3000],
  ]);
});

// ================================================================================================
// 2. The rest leg: it balances on its own side, or the template refuses
// ================================================================================================

/** A Vorlage whose rest can be pushed to the other side: 6500 Soll asked, 1000 Haben asked, 1095 Haben rest. */
function cashVorlage(t) {
  return must(
    setBankStandard(t.ctx, {
      scope: 'manual',
      label: 'Barauslage',
      legs: [
        { accountId: t.acc('6500'), taxCode: null, side: 'debit', amount: { kind: 'ask', label: 'Aufwand' } },
        { accountId: t.acc('1000'), taxCode: null, side: 'credit', amount: { kind: 'ask', label: 'Bar bezahlt' } },
        { accountId: t.acc('1095'), taxCode: null, side: 'credit', amount: { kind: 'rest' } },
      ],
      idempotencyKey: 'v-cash',
    }),
  ).standard;
}

test('a rest that would change side is refused (rest_changes_side), and a rest of 0 too (rest_is_zero): compose says it, post writes nothing', () => {
  const t = vorlagenWorld();
  const v = cashVorlage(t);
  const before = rowCounts(t.store, t.workspaceId);
  // 100.00 expense, 130.00 cash: the rest would be a DEBIT of 30.00 on a leg set to Haben.
  const flipped = { standardId: v.id, asks: { 0: 10000, 1: 13000 } };
  const verdict = must(call(t, 'compose_entry', { mode: 'expand', date: DATE, template: flipped })).verdict;
  assert.equal(verdict.error, 'rest_changes_side');
  assert.deepEqual([verdict.side, verdict.wouldBe, verdict.amountMinor, verdict.legIndex], ['credit', 'debit', 3000, 2]);
  refused(postTemplate(t, flipped, 'r-1'), 'rest_changes_side');
  const zero = { standardId: v.id, asks: { 0: 10000, 1: 10000 } };
  assert.equal(must(call(t, 'compose_entry', { mode: 'expand', date: DATE, template: zero })).verdict.error, 'rest_is_zero');
  refused(postTemplate(t, zero, 'r-2'), 'rest_is_zero');
  assert.deepEqual(rowCounts(t.store, t.workspaceId), before, 'nothing written');
  // The same Vorlage with a rest on its own side posts.
  const fine = must(postTemplate(t, { standardId: v.id, asks: { 0: 10000, 1: 7000 } }, 'r-3'));
  assert.deepEqual(entryLegs(t.store, fine.entryId).map((x) => [x.number, x.debit, x.credit]), [
    ['1000', 0, 7000],
    ['1095', 0, 3000],
    ['6500', 10000, 0],
  ]);
});

test('every template refusal: ask_missing, an ask on a leg that is not asked, a malformed template, lines and template together', () => {
  const t = vorlagenWorld();
  const v = monthVorlage(t);
  const before = rowCounts(t.store, t.workspaceId);
  const missing = refused(postTemplate(t, { standardId: v.id, asks: { 0: 21620 } }, 'a-1'), 'ask_missing');
  assert.deepEqual([missing.legIndex, missing.label], [2, 'Coach-Anteil']);
  refused(postTemplate(t, { standardId: v.id, asks: { 0: 21620, 2: 0 } }, 'a-2'), 'ask_missing', 'a zero ask is no ask');
  assert.equal(refused(postTemplate(t, { standardId: v.id, asks: { 0: 21620, 2: 18620, 1: 500 } }, 'a-3'), 'invalid_input').field, 'template.asks.1');
  refused(postTemplate(t, { asks: {} }, 'a-4'), 'invalid_input');
  refused(postTemplate(t, 'Monatsumsatz', 'a-5'), 'invalid_input');
  refused(postTemplate(t, { standardId: v.id, asks: { 0: 21620, 2: 18620 } }, 'a-6', { lines: [] }), 'invalid_input');
  refused(call(t, 'compose_entry', { mode: 'expand', date: DATE, template: { standardId: v.id, asks: {} }, lines: [] }), 'invalid_input', 'compose: a template replaces the lines');
  assert.equal(must(call(t, 'compose_entry', { mode: 'expand', date: DATE, template: { standardId: v.id, asks: { 0: 21620 } } })).verdict.error, 'ask_missing');
  assert.deepEqual(rowCounts(t.store, t.workspaceId), before);
});

test('critic D176-C1: a Vorlage is checked when it books: an account turned Bankkonto ledger, or archived, refuses rule_invalid and writes nothing', () => {
  // Guards the `ruleInvalidReason` check in `expandTemplate` (bankTemplates.ts): without it the Vorlage
  // below books the new Bankkonto's ledger (D139) and the archived account.
  const t = vorlagenWorld();
  must(createAccount(t.ctx, { number: '1025', name: 'Sparkonto Beispiel', type: 'asset', idempotencyKey: 'acc-1025' }));
  const leg = (number, side, amount) => ({ accountId: t.acc(number), taxCode: null, side, amount });
  const saving = must(
    setBankStandard(t.ctx, { scope: 'manual', label: 'Sparen', legs: [leg('1025', 'debit', { kind: 'ask', label: 'Betrag' }), leg('2800', 'credit', { kind: 'rest' })], idempotencyKey: 'ri-1' }),
  ).standard;
  const accrual = must(
    setBankStandard(t.ctx, { scope: 'manual', label: 'Abgrenzung', legs: [leg('6570', 'debit', { kind: 'ask', label: 'Betrag' }), leg('2800', 'credit', { kind: 'rest' })], idempotencyKey: 'ri-2' }),
  ).standard;
  must(createBankAccount(t.ctx, { name: 'Sparkonto', iban: SAVINGS_IBAN, currency: 'CHF', ledgerAccountId: t.acc('1025'), idempotencyKey: 'ri-bank' }));
  must(archiveAccount(t.ctx, { accountId: t.acc('6570') }));
  const before = rowCounts(t.store, t.workspaceId);
  for (const [v, reason] of [
    [saving, 'account_not_bookable'],
    [accrual, 'account_archived'],
  ]) {
    const template = { standardId: v.id, asks: { 0: 5000 } };
    const verdict = must(call(t, 'compose_entry', { mode: 'expand', date: DATE, template })).verdict;
    assert.deepEqual([verdict.error, verdict.invalidReason], ['rule_invalid', reason]);
    const posted = refused(postTemplate(t, template, `ri-post-${v.id}`), 'rule_invalid');
    assert.equal(posted.invalidReason, reason);
    assert.equal(must(listBankStandards(t.ctx, { scope: 'manual' })).standards.find((s) => s.id === v.id).invalidReason, reason, 'the list says the same');
  }
  assert.deepEqual(rowCounts(t.store, t.workspaceId), before, 'nothing written');
});

test('critic D176 M13: postEntryFromTemplate itself asks read_sales, for an embedder that bypasses the registry; it writes nothing without it', () => {
  // Guards the engine-side `read_sales` assert in postEntryFromTemplate (bankTemplates.ts): the registry's
  // capability rule covers MCP and REST, this covers a caller that runs the engine function directly.
  const t = vorlagenWorld();
  const v = monthVorlage(t);
  const withoutBank = makeContext(t.store, {
    workspaceId: t.workspaceId,
    actor: 'user_1',
    clock: t.deps.clock,
    ids: t.deps.ids,
    capabilities: { assert: (capability) => (capability === 'read_sales' ? { ok: false, error: 'permission_denied', capability } : { ok: true }) },
  });
  const before = rowCounts(t.store, t.workspaceId);
  const denied = refused(postEntryFromTemplate(withoutBank, { date: DATE, source: 'manual', template: { standardId: v.id, asks: { 0: 21620, 2: 18620 } }, idempotencyKey: 'm13' }), 'permission_denied');
  assert.equal(denied.capability, 'read_sales');
  assert.deepEqual(rowCounts(t.store, t.workspaceId), before, 'nothing written');
  // The same call with the right posts.
  must(postEntryFromTemplate(t.ctx, { date: DATE, source: 'manual', template: { standardId: v.id, asks: { 0: 21620, 2: 18620 } }, idempotencyKey: 'm13' }));
});

// ================================================================================================
// 3. wrong_scope, both ways; wrong_outcome
// ================================================================================================

test('wrong_scope both ways: a Vorlage never books a bank line, a bank rule is never a template, an edit keeps its scope', () => {
  const t = vorlagenWorld();
  const l = payouts(t, 'BS-WS', [{ ref: 'P1', amountMinor: 3000 }]);
  const vorlage = monthVorlage(t);
  const rule = must(setBankStandard(t.ctx, { bankTxnId: l.P1, accountId: t.acc('3400'), taxCode: null, idempotencyKey: 'ws-rule' })).standard;
  const before = rowCounts(t.store, t.workspaceId);

  refused(bookBankLine(t.ctx, { bankTxnId: l.P1, target: { kind: 'rule', standardId: vorlage.id, asks: { 0: 3000, 2: 100 } }, idempotencyKey: 'ws-1' }), 'wrong_scope');
  assert.equal(must(composeBankLine(t.ctx, { bankTxnId: l.P1, target: { kind: 'rule', standardId: vorlage.id, asks: {} } })).verdict.error, 'wrong_scope');
  refused(postTemplate(t, { standardId: rule.id, asks: {} }, 'ws-2'), 'wrong_scope');
  assert.equal(must(call(t, 'compose_entry', { mode: 'expand', date: DATE, template: { standardId: rule.id, asks: {} } })).verdict.error, 'wrong_scope');
  refused(setBankStandard(t.ctx, { standardId: vorlage.id, accountId: t.acc('3200'), taxCode: null, idempotencyKey: 'ws-3' }), 'wrong_scope');
  refused(setBankStandard(t.ctx, { scope: 'manual', standardId: rule.id, label: 'X', legs: monthRecipe(t), idempotencyKey: 'ws-4' }), 'wrong_scope');
  assert.deepEqual(rowCounts(t.store, t.workspaceId), before, 'nothing written');
  assert.equal(standardRows(t).filter((r) => r.superseded_at === null).length, 2, 'both rules still live');
});

// ================================================================================================
// 4. The "Nicht buchen" outcome
// ================================================================================================

function ignoreWorld() {
  const t = vorlagenWorld();
  const l = importLines(t, {
    statementId: 'BS-IG',
    entries: [
      { ref: 'TEL', amountMinor: 8650, cd: 'DBIT', iban: TELCO_IBAN, name: 'Fernmelde Ostschweiz AG' },
      { ref: 'TEL2', amountMinor: 4300, cd: 'DBIT', iban: TELCO_IBAN, name: 'Fernmelde Ostschweiz AG' },
      { ref: 'OTHER', amountMinor: 1200, cd: 'DBIT', name: 'Papeterie Beispiel' },
    ],
  }).lines;
  const rule = must(
    setBankStandard(t.ctx, { bankTxnId: l.TEL, outcome: 'ignore', ignoreReason: 'booked_elsewhere', ignoreNote: 'über die Kreditkarte gebucht', label: 'Telefon', idempotencyKey: 'ig-set' }),
  ).standard;
  return { t, l, rule };
}

test('an ignore rule proposes ignore, check by default; A36 stays on; book_bank_line refuses wrong_outcome', () => {
  const { t, l, rule } = ignoreWorld();
  assert.deepEqual([rule.outcome, rule.ignoreReason, rule.ignoreNote, rule.legs, rule.accountId, rule.taxCode], ['ignore', 'booked_elsewhere', 'über die Kreditkarte gebucht', [], null, null]);
  const line = lineOf(t, l.TEL);
  assert.deepEqual(line.proposal, {
    target: { kind: 'ignore', reason: 'booked_elsewhere', note: 'über die Kreditkarte gebucht', standardId: rule.id },
    certainty: 'check',
    reasonCode: 'rule_ignore',
    reasonParams: { standardId: rule.id, reason: 'booked_elsewhere', note: 'über die Kreditkarte gebucht' },
    vatCode: null,
  });
  assert.equal(line.standardId, rule.id, 'the line names the rule its proposal used');
  assert.equal(line.attention, 'needs', 'check: never counted by the bulk button');
  assert.equal(lineNeedsReview(t.ctx, txnRow(t, l.TEL)), true, 'A36: an ignore proposal never switches the signal off');
  const before = rowCounts(t.store, t.workspaceId);
  const wrong = refused(bookBankLine(t.ctx, { bankTxnId: l.TEL, target: { kind: 'rule', standardId: rule.id, asks: {} }, idempotencyKey: 'ig-book' }), 'wrong_outcome');
  assert.equal(wrong.ignoreReason, 'booked_elsewhere');
  assert.equal(must(composeBankLine(t.ctx, { bankTxnId: l.TEL, target: { kind: 'rule', standardId: rule.id, asks: {} } })).verdict.error, 'wrong_outcome');
  assert.deepEqual(rowCounts(t.store, t.workspaceId), before);
});

test('the bulk setting makes the ignore proposal sure; the bulk path ignores it with the rule on record; A36 stays on', () => {
  const { t, l, rule } = ignoreWorld();
  must(settingsSet(t.ctx, { key: 'bank.buchungsregel_ignore_mode', value: 'bulk', reason: 'Telefon läuft über die Karte', idempotencyKey: 'im-1' }));
  const line = lineOf(t, l.TEL);
  assert.equal(line.proposal.certainty, 'sure');
  assert.equal(line.attention, 'sure', 'counted by the bulk button');
  assert.equal(isProposalBookable(8650, line.proposal.target), true, 'decidable as it stands');
  assert.equal(lineNeedsReview(t.ctx, txnRow(t, l.TEL)), true, 'A36: still a person looks, even under bulk');

  // What the Studio's bulk path sends for a `sure` ignore proposal: ignore_bank_line with its reason, note and rule.
  const before = rowCounts(t.store, t.workspaceId);
  for (const id of [l.TEL, l.TEL2]) {
    const p = lineOf(t, id).proposal;
    assert.equal(p.target.kind, 'ignore');
    must(ignoreBankLine(t.ctx, { bankTxnId: id, reason: p.target.reason, note: p.target.note, standardId: p.target.standardId, idempotencyKey: `bulk-${id}` }));
  }
  const after = rowCounts(t.store, t.workspaceId);
  assert.equal(after.entries, before.entries, 'an ignore posts nothing');
  assert.equal(after.decisions - before.decisions, 2);
  const decided = lineOf(t, l.TEL);
  assert.equal(decided.state, 'ignored');
  assert.deepEqual([decided.decision.ignoreReason, decided.decision.note, decided.decision.ruleId], ['booked_elsewhere', 'über die Kreditkarte gebucht', rule.id]);
  assert.equal(lineOf(t, l.OTHER).proposal.reasonCode !== 'rule_ignore', true, 'another counterparty is untouched');
});

test('critic D176-C3: an ignore row holds a Bankkonto ledger as its placeholder (saved from a line, or by an edit), and no reader treats it as a target', () => {
  // Guards the placeholder rule in setBankStandard (the line's ledger, else the oldest Bankkonto's for an
  // edit) and every reader keying on `outcome`: the placeholder is a bank ledger, so a reader that took it
  // for a leg would report `account_not_bookable` or propose booking the bank to itself.
  const t = vorlagenWorld();
  const l = importLines(t, {
    statementId: 'BS-PH',
    entries: [
      { ref: 'TEL', amountMinor: 8650, cd: 'DBIT', iban: TELCO_IBAN, name: 'Fernmelde Ostschweiz AG' },
      { ref: 'PAP', amountMinor: 1200, cd: 'DBIT', name: 'Papeterie Beispiel' },
    ],
  }).lines;
  const saved = must(setBankStandard(t.ctx, { bankTxnId: l.TEL, outcome: 'ignore', ignoreReason: 'booked_elsewhere', idempotencyKey: 'ph-1' })).standard;
  const booking = must(setBankStandard(t.ctx, { bankTxnId: l.PAP, accountId: t.acc('6500'), taxCode: null, idempotencyKey: 'ph-2' })).standard;
  const edited = must(setBankStandard(t.ctx, { standardId: booking.id, outcome: 'ignore', ignoreReason: 'duplicate', idempotencyKey: 'ph-3' })).standard;
  const reEdited = must(setBankStandard(t.ctx, { standardId: edited.id, outcome: 'ignore', ignoreReason: 'other', ignoreNote: 'doppelt geliefert', idempotencyKey: 'ph-4' })).standard;
  for (const s of [saved, edited, reEdited]) {
    const row = standardRows(t).find((x) => x.id === s.id);
    assert.equal(row.account_id, t.bankId, 'the placeholder is the Bankkonto ledger, whichever path wrote the row');
    assert.equal(row.legs_json, '[]');
    if (s === edited) continue; // superseded by the re-edit, so no longer listed
    const listed = must(listBankStandards(t.ctx, {})).standards.find((x) => x.id === s.id);
    assert.deepEqual([listed.accountId, listed.accountNumber, listed.taxCode, listed.legs, listed.invalidReason], [null, null, null, [], null], 'no leg, and valid: the ledger is never checked as a target');
    assert.ok(!JSON.stringify(listed).includes(t.bankId), 'the placeholder never leaves the row');
  }
  for (const id of [l.TEL, l.PAP]) {
    const line = lineOf(t, id);
    assert.equal(line.proposal.target.kind, 'ignore');
    assert.ok(!JSON.stringify(line.proposal).includes(t.bankId), 'the proposal names no account');
    refused(bookBankLine(t.ctx, { bankTxnId: id, target: { kind: 'rule', standardId: line.proposal.target.standardId, asks: {} }, idempotencyKey: `ph-b-${id}` }), 'wrong_outcome');
  }
});

test('ignore_bank_line with a standardId: wrong_outcome for a booking rule, rule_not_applicable for another counterparty, wrong_scope for a Vorlage', () => {
  const { t, l, rule } = ignoreWorld();
  const legsRule = must(setBankStandard(t.ctx, { bankTxnId: l.OTHER, accountId: t.acc('6500'), taxCode: null, idempotencyKey: 'ig-legs' })).standard;
  const vorlage = monthVorlage(t);
  const before = rowCounts(t.store, t.workspaceId);
  refused(ignoreBankLine(t.ctx, { bankTxnId: l.OTHER, reason: 'other', standardId: legsRule.id, idempotencyKey: 'x1' }), 'wrong_outcome');
  refused(ignoreBankLine(t.ctx, { bankTxnId: l.OTHER, reason: 'other', standardId: rule.id, idempotencyKey: 'x2' }), 'rule_not_applicable');
  refused(ignoreBankLine(t.ctx, { bankTxnId: l.OTHER, reason: 'other', standardId: vorlage.id, idempotencyKey: 'x3' }), 'wrong_scope');
  refused(ignoreBankLine(t.ctx, { bankTxnId: l.OTHER, reason: 'other', standardId: 'bstd_nope', idempotencyKey: 'x4' }), 'rule_not_found');
  assert.deepEqual(rowCounts(t.store, t.workspaceId), before);
});

// ================================================================================================
// 5. The next step: a follow-up appears only after the decision
// ================================================================================================

test('the follow-up appears only after the decision, for a booking and for an ignore, and follows the Vorlage through an edit', () => {
  const t = vorlagenWorld();
  const l = payouts(t, 'BS-F', [
    { ref: 'P1', amountMinor: 3000, ustrd: 'KURSPLATTFORM 1' },
    { ref: 'P2', amountMinor: 4100, ustrd: 'KURSPLATTFORM 2' },
    { ref: 'P3', amountMinor: 2500, ustrd: 'KURSPLATTFORM 3' },
  ]);
  const vorlage = monthVorlage(t);
  const rule = must(
    setBankStandard(t.ctx, { bankTxnId: l.P1, accountId: t.acc('1095'), taxCode: null, label: 'Kursplattform', followUpStandardId: vorlage.id, idempotencyKey: 'f-set' }),
  ).standard;
  assert.deepEqual([rule.followUpStandardId, rule.followUpLabel], [vorlage.id, 'Monatsumsatz']);
  assert.equal(lineOf(t, l.P1).followUp, null, 'open: no next step yet');

  // Booked BY the rule: the next step shows.
  must(bookBankLine(t.ctx, { bankTxnId: l.P1, target: { kind: 'rule', standardId: rule.id, asks: {} }, idempotencyKey: 'f-b1' }));
  assert.deepEqual(lineOf(t, l.P1).followUp, { standardId: vorlage.id, label: 'Monatsumsatz' });
  assert.equal(lineOf(t, l.P1).decision.ruleId, rule.id);
  // Booked by hand to the same account: no rule decided it, so no next step.
  must(bookBankLine(t.ctx, { bankTxnId: l.P2, target: { kind: 'accounts', legs: [{ accountId: t.acc('1095'), amountMinor: 4100 }] }, idempotencyKey: 'f-b2' }));
  assert.equal(lineOf(t, l.P2).followUp, null);

  // The Vorlage edited under the same name: the next step follows it. Renamed away: it is gone.
  const edited = must(setBankStandard(t.ctx, { scope: 'manual', standardId: vorlage.id, label: 'Monatsumsatz', legs: monthRecipe(t).map((x, i) => (i === 2 ? { ...x, accountId: t.acc('6570') } : x)), idempotencyKey: 'f-edit' }));
  assert.equal(edited.supersededId, vorlage.id);
  assert.deepEqual(lineOf(t, l.P1).followUp, { standardId: edited.standard.id, label: 'Monatsumsatz' });
  must(setBankStandard(t.ctx, { scope: 'manual', standardId: edited.standard.id, label: 'Umsatz Kurse', legs: monthRecipe(t), idempotencyKey: 'f-rename' }));
  assert.equal(lineOf(t, l.P1).followUp, null, 'renamed away: no live Vorlage under that name');

  // An ignore rule with a next step: after the ignore with the rule, it shows.
  const next = monthVorlage(t, 'v-next', 'Nachbuchung');
  const t2 = importLines(t, { statementId: 'BS-F2', entries: [{ ref: 'TEL', amountMinor: 8650, cd: 'DBIT', iban: TELCO_IBAN, name: 'Fernmelde Ostschweiz AG' }] }).lines;
  const ig = must(setBankStandard(t.ctx, { bankTxnId: t2.TEL, outcome: 'ignore', ignoreReason: 'clearing_account', followUpStandardId: next.id, idempotencyKey: 'f-ig' })).standard;
  assert.equal(lineOf(t, t2.TEL).followUp, null);
  must(ignoreBankLine(t.ctx, { bankTxnId: t2.TEL, reason: 'clearing_account', standardId: ig.id, idempotencyKey: 'f-ig-1' }));
  assert.deepEqual(lineOf(t, t2.TEL).followUp, { standardId: next.id, label: 'Nachbuchung' });
});

test('a follow-up must be a live Vorlage of this workspace (invalid_recipe follow_up)', () => {
  const t = vorlagenWorld();
  const b = secondWorkspace(t);
  const l = payouts(t, 'BS-FU', [{ ref: 'P1', amountMinor: 3000 }]);
  const bankRule = must(setBankStandard(t.ctx, { bankTxnId: l.P1, accountId: t.acc('3400'), taxCode: null, matchText: 'kurs', idempotencyKey: 'fu-1' })).standard;
  must(createAccount(b.ctx, { number: '1095', name: 'Erlös Durchlaufkonto', type: 'asset', idempotencyKey: 'b-1095' }));
  const foreign = must(setBankStandard(b.ctx, { scope: 'manual', label: 'Monatsumsatz', legs: monthRecipe(b), idempotencyKey: 'fu-b' })).standard;
  const v = monthVorlage(t);
  must(clearBankStandard(t.ctx, { standardId: v.id, idempotencyKey: 'fu-clear' }));
  for (const [id, why] of [
    [bankRule.id, 'a bank rule'],
    [foreign.id, 'another workspace'],
    [v.id, 'a cleared Vorlage'],
  ]) {
    const r = refused(setBankStandard(t.ctx, { bankTxnId: l.P1, accountId: t.acc('3400'), taxCode: null, followUpStandardId: id, idempotencyKey: `fu-${why}` }), 'invalid_recipe', why);
    assert.equal(r.detail, 'follow_up', why);
  }
  assert.equal(
    refused(setBankStandard(t.ctx, { scope: 'manual', label: 'Y', legs: monthRecipe(t), followUpStandardId: v.id, idempotencyKey: 'fu-m' }), 'invalid_input').field,
    'followUpStandardId',
    'a Vorlage names no next step',
  );
});

// ================================================================================================
// 6. Recipe rules (invalid_recipe + detail)
// ================================================================================================

test('every recipe rule of §15.1 refuses with its detail', () => {
  const t = vorlagenWorld();
  const l = payouts(t, 'BS-R', [{ ref: 'P1', amountMinor: 3000 }]);
  const leg = (number, side, amount, extra = {}) => ({ accountId: t.acc(number), taxCode: null, side, amount, ...extra });
  const manual = (legs, extra = {}) => setBankStandard(t.ctx, { scope: 'manual', label: 'Probe', legs, idempotencyKey: `r-${JSON.stringify(legs).length}-${Object.keys(extra).join()}`, ...extra });
  const detail = (res, d, label) => assert.equal(refused(res, 'invalid_recipe', label).detail, d, label);

  detail(manual([leg('6500', 'debit', { kind: 'rest' })]), 'legs_count', 'a Vorlage needs two legs');
  detail(manual([{ ...leg('6500', 'debit', { kind: 'ask', label: 'A' }), side: undefined }, leg('1000', 'credit', { kind: 'rest' })]), 'side', 'a side on every leg');
  detail(manual([leg('6500', 'debit', { kind: 'ask', label: 'A' }, { against: true }), leg('1000', 'credit', { kind: 'rest' })]), 'side', 'against is a bank rule\'s');
  detail(manual([leg('6500', 'debit', { kind: 'same', legIndex: 1 }), leg('1000', 'credit', { kind: 'rest' })]), 'same_target', 'same names an asked leg, never the rest');
  detail(manual([leg('6500', 'debit', { kind: 'same', legIndex: 0 }), leg('1000', 'credit', { kind: 'rest' })]), 'same_target', 'never itself');
  detail(manual([leg('6500', 'debit', { kind: 'same', legIndex: 7 }), leg('1000', 'credit', { kind: 'rest' })]), 'same_target', 'never out of range');
  detail(manual([leg('6500', 'debit', { kind: 'ask', label: 'A' }), leg('1000', 'credit', { kind: 'ask', label: 'B' })]), 'rest_count', 'exactly one rest');
  const bankLedger = refused(manual([leg('6500', 'debit', { kind: 'ask', label: 'A' }), leg('1020', 'credit', { kind: 'rest' })]), 'invalid_recipe');
  assert.deepEqual([bankLedger.detail, bankLedger.reason], ['invalid_account', 'bank_ledger'], 'a Vorlage never books a bank ledger (D139)');
  detail(manual([leg('6500', 'debit', { kind: 'ask', label: 'A' }), leg('1000', 'credit', { kind: 'rest' })], { outcome: 'ignore' }), 'ignore_outcome', 'a Vorlage books');
  assert.equal(refused(manual([leg('6500', 'debit', { kind: 'ask', label: 'A' }), leg('1000', 'credit', { kind: 'rest' })], { label: '  ' }), 'invalid_input').field, 'label');
  assert.equal(refused(manual([leg('6500', 'debit', { kind: 'ask', label: 'A' }), leg('1000', 'credit', { kind: 'rest' })], { matchText: 'x' }), 'invalid_input').field, 'matchText');
  assert.equal(refused(manual([leg('6500', 'debit', { kind: 'ask', label: 'A' }), leg('1000', 'credit', { kind: 'rest' })], { bankTxnId: l.P1 }), 'invalid_input').field, 'bankTxnId');

  // Bank scope: no side; an ignore has no legs and a valid reason.
  detail(setBankStandard(t.ctx, { bankTxnId: l.P1, legs: [{ accountId: t.acc('3400'), taxCode: null, side: 'credit', amount: { kind: 'rest' } }], idempotencyKey: 'rb-1' }), 'side');
  detail(setBankStandard(t.ctx, { bankTxnId: l.P1, outcome: 'ignore', ignoreReason: 'duplicate', legs: [{ accountId: t.acc('3400'), taxCode: null, amount: { kind: 'rest' } }], idempotencyKey: 'rb-2' }), 'ignore_outcome');
  detail(setBankStandard(t.ctx, { bankTxnId: l.P1, outcome: 'ignore', ignoreReason: 'vergessen', idempotencyKey: 'rb-3' }), 'ignore_outcome');
  detail(
    setBankStandard(t.ctx, { bankTxnId: l.P1, legs: [{ accountId: t.acc('3400'), taxCode: null, amount: { kind: 'same', legIndex: 0 } }, { accountId: t.acc('4400'), taxCode: null, amount: { kind: 'rest' } }], idempotencyKey: 'rb-4' }),
    'same_target',
  );
  assert.equal(refused(setBankStandard(t.ctx, { bankTxnId: l.P1, accountId: t.acc('3400'), taxCode: null, ignoreReason: 'duplicate', idempotencyKey: 'rb-5' }), 'invalid_input').field, 'ignoreReason');
  assert.equal(standardRows(t).length, 0, 'no refusal wrote a row');
});

// ================================================================================================
// 7. The edit path, the scope filter
// ================================================================================================

test('a bank rule is edited by its standardId, no line needed: it is superseded, the counterparty and direction kept', () => {
  const t = vorlagenWorld();
  const l = payouts(t, 'BS-E', [{ ref: 'P1', amountMinor: 3000, ustrd: 'KURSPLATTFORM 9' }]);
  const rule = must(setBankStandard(t.ctx, { bankTxnId: l.P1, accountId: t.acc('3400'), taxCode: null, label: 'Kurse', idempotencyKey: 'e-1' })).standard;
  const edited = must(setBankStandard(t.ctx, { standardId: rule.id, accountId: t.acc('3200'), taxCode: null, label: 'Kurse', idempotencyKey: 'e-2' }));
  assert.equal(edited.supersededId, rule.id);
  assert.deepEqual([edited.standard.counterpartyKey, edited.standard.direction, edited.standard.accountNumber], [rule.counterpartyKey, 'in', '3200']);
  assert.equal(proposalOf(t, l.P1).reasonParams.standardId, edited.standard.id);
  const again = must(setBankStandard(t.ctx, { standardId: edited.standard.id, accountId: t.acc('3200'), taxCode: null, label: 'Kurse', idempotencyKey: 'e-3' }));
  assert.equal(again.unchanged, true, 'the same rule again is unchanged');
  refused(setBankStandard(t.ctx, { standardId: rule.id, accountId: t.acc('3200'), taxCode: null, idempotencyKey: 'e-4' }), 'rule_not_found', 'a superseded rule is not edited');
  assert.equal(refused(setBankStandard(t.ctx, { standardId: edited.standard.id, bankTxnId: l.P1, accountId: t.acc('3200'), taxCode: null, idempotencyKey: 'e-5' }), 'invalid_input').field, 'bankTxnId');
  // The same edit as an ignore rule: the outcome changes, the slot stays.
  const ig = must(setBankStandard(t.ctx, { standardId: edited.standard.id, outcome: 'ignore', ignoreReason: 'duplicate', idempotencyKey: 'e-6' }));
  assert.equal(ig.standard.outcome, 'ignore');
  assert.equal(proposalOf(t, l.P1).reasonCode, 'rule_ignore');
});

test('list_bank_standards narrows by scope; a Vorlage and an ignore rule read as such', () => {
  const { t, rule } = ignoreWorld();
  const v = monthVorlage(t);
  const ids = (scope) => must(listBankStandards(t.ctx, scope === undefined ? {} : { scope })).standards.map((s) => s.id);
  assert.deepEqual(ids('manual'), [v.id]);
  assert.deepEqual(ids('bank'), [rule.id]);
  assert.deepEqual(new Set(ids()), new Set([v.id, rule.id]));
  refused(listBankStandards(t.ctx, { scope: 'alle' }), 'invalid_input');
  const through = must(call(t, 'list_bank_standards', { scope: 'manual' }));
  assert.deepEqual(through.standards.map((s) => s.id), [v.id], 'the verb takes the filter');
});

test('critic D176-C2, R2-1: a new Vorlage or a rename onto a name another Vorlage holds refuses label_taken unless the caller names that holder; an edit that keeps its name is no collision', () => {
  // Guards the `label_taken` check before the memo in setBankStandard (bankStandards.ts).
  const t = vorlagenWorld();
  const leg = (number, side, amount) => ({ accountId: t.acc(number), taxCode: null, side, amount });
  const wages = [leg('5000', 'debit', { kind: 'ask', label: 'Brutto' }), leg('2800', 'credit', { kind: 'rest' })];
  const a = monthVorlage(t, 'lt-a', 'Monatsumsatz');
  const b = must(setBankStandard(t.ctx, { scope: 'manual', label: 'Lohn', legs: wages, idempotencyKey: 'lt-b' })).standard;
  const rows = standardRows(t);
  // A rename of A onto B's name: refused, nothing moves; B keeps its legs and its id.
  const renamed = refused(setBankStandard(t.ctx, { scope: 'manual', standardId: a.id, label: 'lohn', legs: monthRecipe(t), idempotencyKey: 'lt-1' }), 'label_taken');
  assert.deepEqual([renamed.standardId, renamed.label], [b.id, 'Lohn']);
  // A new Vorlage under B's name: refused too.
  refused(setBankStandard(t.ctx, { scope: 'manual', label: 'Lohn', legs: monthRecipe(t), idempotencyKey: 'lt-2' }), 'label_taken');
  assert.deepEqual(standardRows(t), rows, 'no row moved');
  // B saved again exactly as it is: unchanged, not a collision with itself.
  assert.equal(must(setBankStandard(t.ctx, { scope: 'manual', label: 'Lohn', legs: wages, idempotencyKey: 'lt-3' })).unchanged, true);
  // An edit of B that keeps its own name changes it.
  const kept = must(setBankStandard(t.ctx, { scope: 'manual', standardId: b.id, label: 'Lohn', legs: [leg('5000', 'debit', { kind: 'ask', label: 'Bruttolohn' }), leg('2800', 'credit', { kind: 'rest' })], idempotencyKey: 'lt-4' }));
  assert.equal(kept.supersededId, b.id);
  // Critic R2-1: naming the holder the caller SAW (b, since edited into kept) is refused with the current
  // holder, so a drafted save never replaces an edit it never saw; a bare `replace` flag is refused.
  const stale = refused(setBankStandard(t.ctx, { scope: 'manual', standardId: a.id, label: 'Lohn', legs: monthRecipe(t), replaceStandardId: b.id, idempotencyKey: 'lt-5a' }), 'label_taken');
  assert.deepEqual([stale.standardId, stale.expectedStandardId], [kept.standard.id, b.id]);
  assert.equal(refused(setBankStandard(t.ctx, { scope: 'manual', standardId: a.id, label: 'Lohn', legs: monthRecipe(t), replace: true, idempotencyKey: 'lt-5b' }), 'invalid_input').field, 'replace');
  // Naming the holder as it stands replaces it, as the caller said.
  const replaced = must(setBankStandard(t.ctx, { scope: 'manual', standardId: a.id, label: 'Lohn', legs: monthRecipe(t), replaceStandardId: kept.standard.id, idempotencyKey: 'lt-5' }));
  const live = standardRows(t).filter((r) => r.superseded_at === null && r.scope === 'manual');
  assert.deepEqual(live.map((r) => r.id), [replaced.standard.id]);
});

// ================================================================================================
// 8. The money-path invariants
// ================================================================================================

test('[INVARIANT append-only] a Vorlage is never updated or deleted: the scope, outcome, reason, note and follow-up are frozen; an edit supersedes', () => {
  // Guards the trigger `bank_standard_outcome_frozen` (bankInboxSchema.ts) beside the D167/D175 triggers.
  // Critic D176-C4: each UPDATE writes the supersession stamp TOO, the one update the older triggers let
  // through, so only the D176 trigger can refuse it (a D176 column alone is refused by D167's trigger).
  const t = vorlagenWorld();
  const v = monthVorlage(t);
  const db = t.store.db;
  for (const [column, value] of [
    ['scope', 'bank'],
    ['outcome', 'ignore'],
    ['ignore_reason', 'duplicate'],
    ['ignore_note', 'x'],
    ['follow_up_standard_id', v.id],
  ]) {
    assert.throws(
      () => db.prepare(`UPDATE bank_standard SET superseded_at = '2026-07-31T00:00:00.000Z', superseded_by = 'u', ${column} = ? WHERE id = ?`).run(value, v.id),
      /only the supersession stamp/,
      column,
    );
  }
  assert.equal(standardRows(t).find((r) => r.id === v.id).superseded_at, null, 'no refused update left a stamp');
  assert.throws(() => db.prepare('DELETE FROM bank_standard WHERE id = ?').run(v.id), /never deleted/);
  const edited = must(setBankStandard(t.ctx, { scope: 'manual', standardId: v.id, label: 'Monatsumsatz', legs: monthRecipe(t).slice(0, 2).concat([monthRecipe(t)[3]]), idempotencyKey: 'ao-edit' }));
  const rows = standardRows(t);
  assert.equal(rows.length, 2, 'the edit added a row, it did not change one');
  assert.equal(rows[0].superseded_at !== null, true, 'the old Vorlage is stamped superseded');
  assert.equal(rows[1].id, edited.standard.id);
});

test('[INVARIANT one-live-label] one live Vorlage per folded label: the same name supersedes, a raw second live row is refused', () => {
  // Guards the `vorlage:<folded label>` key (vorlageKeyOf, bankStandards.ts) under `bank_standard_one_live_rule`.
  const t = vorlagenWorld();
  const a = monthVorlage(t, 'ol-1', 'Monatsumsatz');
  // The same folded name is the same slot: without naming the holder the save is refused (critic D176-C2),
  // naming it (`replaceStandardId`, R2-1) the new row supersedes the old.
  const taken = refused(setBankStandard(t.ctx, { scope: 'manual', label: '  monatsumsatz! ', legs: monthRecipe(t), idempotencyKey: 'ol-2a' }), 'label_taken');
  assert.equal(taken.standardId, a.id, 'the refusal names the Vorlage that holds the name');
  const b = must(setBankStandard(t.ctx, { scope: 'manual', label: '  monatsumsatz! ', legs: monthRecipe(t), replaceStandardId: a.id, idempotencyKey: 'ol-2' }));
  assert.equal(b.supersededId, a.id, 'the same folded label is the same Vorlage');
  const c = monthVorlage(t, 'ol-3', 'Quartalsumsatz');
  assert.equal(standardRows(t).filter((r) => r.superseded_at === null).length, 2);
  assert.notEqual(c.id, b.standard.id);
  assert.throws(
    () =>
      t.store.db
        .prepare(
          `INSERT INTO bank_standard (id, workspace_id, counterparty_key, counterparty_label, direction, account_id, set_at, scope, legs_json)
           VALUES ('raw', ?, 'vorlage:monatsumsatz', 'x', 'out', ?, '2026-07-31', 'manual', '[]')`,
        )
        .run(t.workspaceId, t.acc('1095')),
    /UNIQUE/,
  );
  // A bank counterparty can never meet a Vorlage slot: its key is iban: or name:.
  assert.ok(standardRows(t).every((r) => r.scope !== 'manual' || r.counterparty_key.startsWith('vorlage:')));
});

test('[INVARIANT idempotent-on-rows] a replay adds no row: a Vorlage set, a template post (even after the Vorlage is cleared), an ignore with its rule', () => {
  // Guards the recall/remember pair in setBankStandard and the recall BEFORE the expansion in
  // postEntryFromTemplate (bankTemplates.ts): a replay answers the stored result and posts nothing.
  const t = vorlagenWorld();
  const input = { scope: 'manual', label: 'Monatsumsatz', legs: monthRecipe(t), idempotencyKey: 'i-set' };
  const first = must(setBankStandard(t.ctx, input));
  const rows = standardRows(t);
  assert.deepEqual(setBankStandard(t.ctx, input), first);
  assert.deepEqual(standardRows(t), rows, 'the set replay moves no row');
  assert.equal(must(setBankStandard(t.ctx, { ...input, idempotencyKey: 'i-set-2' })).unchanged, true, 'the same Vorlage under a new key is unchanged');
  assert.deepEqual(standardRows(t), rows);

  const template = { standardId: first.standard.id, asks: { 0: 21620, 2: 18620 } };
  const posted = must(postTemplate(t, template, 'i-post'));
  const counts = rowCounts(t.store, t.workspaceId);
  assert.deepEqual(postTemplate(t, template, 'i-post'), posted, 'the replay answers the stored result');
  must(clearBankStandard(t.ctx, { standardId: first.standard.id, idempotencyKey: 'i-clear' }));
  assert.deepEqual(postTemplate(t, template, 'i-post'), posted, 'even once the Vorlage is gone');
  assert.deepEqual(rowCounts(t.store, t.workspaceId), counts, 'and posts nothing');
  refused(postTemplate(t, template, 'i-post-2'), 'rule_not_found', 'a new key on a cleared Vorlage');

  // Critic D176-C5: an EDIT by standardId replays too. Without the recall the replay would find its row
  // superseded and answer rule_not_found (or, worse, write again); with it, the stored result, no row.
  const quarter = monthVorlage(t, 'i-q', 'Quartalsumsatz');
  const editInput = {
    scope: 'manual',
    standardId: quarter.id,
    label: 'Quartalsumsatz',
    legs: monthRecipe(t).map((x, i) => (i === 2 ? { ...x, accountId: t.acc('6570') } : x)),
    idempotencyKey: 'i-edit',
  };
  const editedOnce = must(setBankStandard(t.ctx, editInput));
  assert.equal(editedOnce.supersededId, quarter.id);
  const afterEdit = standardRows(t);
  assert.deepEqual(setBankStandard(t.ctx, editInput), editedOnce, 'the edit replay answers the stored result');
  assert.deepEqual(standardRows(t), afterEdit, 'and moves no row');

  const { t: u, l, rule } = ignoreWorld();
  const ig = { bankTxnId: l.TEL, reason: 'booked_elsewhere', standardId: rule.id, idempotencyKey: 'i-ig' };
  const done = must(ignoreBankLine(u.ctx, ig));
  const after = rowCounts(u.store, u.workspaceId);
  assert.deepEqual(ignoreBankLine(u.ctx, ig), done);
  assert.deepEqual(rowCounts(u.store, u.workspaceId), after);
});

test('[INVARIANT tenant] a Vorlage never reaches another workspace: compose and post say rule_not_found there, its list and edits do not see it', () => {
  // Guards the `workspace_id = ?` binding in `readLiveRule` (expandTemplate) and `listBankStandards`.
  const t = vorlagenWorld();
  const b = secondWorkspace(t);
  must(createAccount(b.ctx, { number: '1095', name: 'Erlös Durchlaufkonto', type: 'asset', idempotencyKey: 'b-1095' }));
  const v = monthVorlage(t);
  const template = { standardId: v.id, asks: { 0: 21620, 2: 18620 } };
  const bDeps = t.deps;
  const before = rowCounts(t.store, b.workspaceId);
  refused(postEntryFromTemplate(b.ctx, { date: DATE, source: 'manual', template, idempotencyKey: 'h-1' }), 'rule_not_found');
  assert.equal(must(composeTemplate(b.ctx, { date: DATE, template })).verdict.error, 'rule_not_found');
  assert.equal(expandTemplate(b.ctx, DATE, template).error.error, 'rule_not_found');
  refused(getAction('post_entry').run(bDeps, { workspaceId: b.workspaceId, date: DATE, source: 'manual', template, idempotencyKey: 'h-2' }), 'rule_not_found');
  refused(setBankStandard(b.ctx, { scope: 'manual', standardId: v.id, label: 'Monatsumsatz', legs: monthRecipe(b), idempotencyKey: 'h-3' }), 'rule_not_found');
  assert.deepEqual(rowCounts(t.store, b.workspaceId), before, 'B wrote nothing');
  assert.deepEqual(must(listBankStandards(b.ctx, {})).standards, []);
  // A's own composer still takes it.
  assert.equal(must(composeTemplate(t.ctx, { date: DATE, template })).verdict.ok, true);
});

// ================================================================================================
// 9. Generation 16
// ================================================================================================

test('generation 16 opens a generation-15 book: the five columns and the freeze trigger arrive, every row reads as a bank rule with legs', () => {
  excuseClaimInvariant();
  const dir = mkdtempSync(join(tmpdir(), 'd176-gen16-'));
  const file = join(dir, 'book.db');
  try {
    // D178 (generation 17) followed: the pin is that this build writes at least 16, not that 16 is last.
    assert.ok(SCHEMA_GENERATION >= 16, 'this build writes generation 16 or later');
    const d176 = DATA_MIGRATIONS.findIndex((m) => m.name.startsWith('d176-bank-vorlagen'));
    assert.equal(DATA_MIGRATIONS[d176]?.generation, 16);
    assert.equal(DATA_MIGRATIONS.filter((m) => m.generation === 16).length, 1, 'd176 is the one generation-16 step');
    assert.ok(DATA_MIGRATIONS.slice(d176 + 1).every((m) => m.generation > 16), 'every step after d176 is a later generation');

    const t = world({ location: file });
    const l = importLines(t, { statementId: 'BS-G', entries: [{ ref: 'TEL', amountMinor: 8650, cd: 'DBIT', iban: TELCO_IBAN, name: 'Fernmelde Ostschweiz AG' }] }).lines;
    const s = must(setBankStandard(t.ctx, { bankTxnId: l.TEL, accountId: t.acc('6500'), taxCode: 'VST-M', label: 'Telefon', idempotencyKey: 'g1' })).standard;
    t.store.close();

    // Back to what a generation-15 build left: no D176 columns and no D176 trigger.
    const raw = new Database(file);
    raw.exec('DROP TRIGGER bank_standard_outcome_frozen');
    for (const col of ['scope', 'outcome', 'ignore_reason', 'ignore_note', 'follow_up_standard_id']) raw.exec(`ALTER TABLE bank_standard DROP COLUMN ${col}`);
    raw.pragma('user_version = 15');
    const before = raw.prepare('SELECT * FROM bank_standard ORDER BY rowid').all();
    raw.close();

    const store = new SqliteStore({ location: file });
    const db = store.db;
    assert.equal(db.pragma('user_version', { simple: true }), SCHEMA_GENERATION);
    const cols = db.prepare("SELECT name FROM pragma_table_info('bank_standard')").all().map((r) => r.name);
    for (const c of ['scope', 'outcome', 'ignore_reason', 'ignore_note', 'follow_up_standard_id']) assert.ok(cols.includes(c), c);
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = 'bank_standard_outcome_frozen'").get(), 'the freeze trigger arrives');
    const after = db.prepare('SELECT * FROM bank_standard ORDER BY rowid').all();
    assert.deepEqual(
      after.map(({ scope, outcome, ignore_reason, ignore_note, follow_up_standard_id, ...rest }) => ({ rest, added: [scope, outcome, ignore_reason, ignore_note, follow_up_standard_id] })),
      before.map((rest) => ({ rest, added: ['bank', 'legs', null, null, null] })),
      'every row is intact and reads as the bank rule with legs it was',
    );
    assert.throws(() => db.prepare("UPDATE bank_standard SET outcome = 'ignore' WHERE id = ?").run(s.id), /only the supersession stamp/);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
