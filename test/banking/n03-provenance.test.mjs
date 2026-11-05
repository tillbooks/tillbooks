// N03 (D183): THE PROVENANCE OF A BOOKING. Every booking of a bank line stores which Buchungsregel proposed
// it (`proposed_rule_id`) and whether the person changed it (`rule_changed`), read BEFORE the booking writes
// and stamped by the one decision writer as the row is inserted. N04's earned autonomy books on its own on
// the strength of these two columns, so each rule of the comparison (N03 §2 "Changed, exactly") and each
// door (book_bank_line, confirm_match, create_entry_for_txn) has a test here, marked [INVARIANT ...] for the
// non-author critic with the code it guards.
//
// SYNTHETIC DATA ONLY: every statement is spelled by hand in bank-inbox-support.mjs (TELCO_IBAN and the
// names below are invented), the card statement is fixtures/e2-camt053-card-fx.xml (synthetic), and every
// amount is invented.

import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { listBankInbox, importCamt, ignoreBankLine, reopenBankLine } from '../../dist/core/banking/index.js';
import { bookBankLine, composeBankLine, prevalidateBookBankLine } from '../../dist/core/banking/bankBooking.js';
import { setBankStandard } from '../../dist/core/banking/bankStandards.js';
import { confirmCamtMatch, createEntryForTxn } from '../../dist/core/banking/camtReconcile.js';
import { expectedRuleLegs, legsMatch } from '../../dist/core/banking/ruleStats.js';
import { settingsSet } from '../../dist/core/settings/settings.js';
import { postEntry } from '../../dist/core/ledger/postEntry.js';
import { world, importLines, must, refused, postedBill, assertClaimInvariantHolds, TELCO_IBAN } from './bank-inbox-support.mjs';

afterEach(assertClaimInvariantHolds);

const HERE = dirname(fileURLToPath(import.meta.url));
const FX_XML = readFileSync(join(HERE, 'fixtures', 'e2-camt053-card-fx.xml'), 'utf8');

const TELCO = 'Fernmeldewerk Beispiel AG';
const SHOP = 'Ladenzeile Muster GmbH';

/** The live decision of a line, as the provenance columns store it. */
function decisionOf(t, bankTxnId) {
  return t.store.db
    .prepare('SELECT proposed_rule_id AS ruleId, rule_changed AS changed, rule_id AS bookedByRule FROM bank_line_decision WHERE workspace_id = ? AND bank_txn_id = ? AND superseded_at IS NULL')
    .get(t.workspaceId, bankTxnId);
}

const proposalOf = (t, id) => must(listBankInbox(t.ctx, { bankTxnId: id, status: 'all' })).lines[0].proposal;

/** Debits from the invented telecom supplier, by IBAN (one counterparty key), told apart by ref. */
function telcoLines(t, statementId, entries) {
  return importLines(t, { statementId, entries: entries.map((e) => ({ cd: 'DBIT', name: TELCO, iban: TELCO_IBAN, ...e })) }).lines;
}

/** A complete rule (one rest leg, 6570 with VST-M) saved from line `from`. */
function telcoRule(t, from, extra = {}) {
  return must(setBankStandard(t.ctx, { bankTxnId: from, accountId: t.acc('6570'), taxCode: 'VST-M', idempotencyKey: `rule-${from}`, ...extra })).standard.id;
}

// ================================================================================================
// 1. book_bank_line: unchanged and changed, rule by rule
// ================================================================================================

test('[INVARIANT provenance/book unchanged] a complete rule booked exactly as proposed stores the rule and 0', () => {
  // Guards computeRuleProvenance's exact rest leg and the bound value reaching insertDecision.
  const t = world();
  const l = telcoLines(t, 'BS-P1', [{ ref: 'A', amountMinor: 8990 }, { ref: 'B', amountMinor: 8990 }]);
  const ruleId = telcoRule(t, l.A);
  const p = proposalOf(t, l.B);
  assert.equal(p.reasonCode, 'standard');
  must(bookBankLine(t.ctx, { bankTxnId: l.B, target: p.target, idempotencyKey: 'book-b' }));
  assert.deepEqual({ ...decisionOf(t, l.B) }, { ruleId, changed: 0, bookedByRule: null });
});

test('[INVARIANT provenance/book changed] another account, another code, a split or a missing code are each a change', () => {
  // Guards legsMatch on account, tax code, amount and leg count.
  const t = world();
  const l = telcoLines(t, 'BS-P2', [
    { ref: 'R', amountMinor: 5000 },
    { ref: 'ACC', amountMinor: 5000 },
    { ref: 'CODE', amountMinor: 5000 },
    { ref: 'NOCODE', amountMinor: 5000 },
    { ref: 'SPLIT', amountMinor: 5000 },
  ]);
  const ruleId = telcoRule(t, l.R);
  must(bookBankLine(t.ctx, { bankTxnId: l.ACC, target: { kind: 'accounts', legs: [{ accountId: t.acc('6500'), amountMinor: 5000, taxCode: 'VST-M' }] }, idempotencyKey: 'acc' }));
  must(bookBankLine(t.ctx, { bankTxnId: l.CODE, target: { kind: 'accounts', legs: [{ accountId: t.acc('6570'), amountMinor: 5000, taxCode: 'VST-M26' }] }, idempotencyKey: 'code' }));
  must(bookBankLine(t.ctx, { bankTxnId: l.NOCODE, target: { kind: 'accounts', legs: [{ accountId: t.acc('6570'), amountMinor: 5000 }] }, idempotencyKey: 'nocode' }));
  must(
    bookBankLine(t.ctx, {
      bankTxnId: l.SPLIT,
      target: { kind: 'accounts', legs: [{ accountId: t.acc('6570'), amountMinor: 4000, taxCode: 'VST-M' }, { accountId: t.acc('6500'), amountMinor: 1000 }] },
      idempotencyKey: 'split',
    }),
  );
  for (const ref of ['ACC', 'CODE', 'NOCODE', 'SPLIT']) assert.deepEqual({ ...decisionOf(t, l[ref]) }, { ruleId, changed: 1, bookedByRule: null }, ref);
});

test('[INVARIANT provenance/text and order] the leg text and the order of the legs never count as a change', () => {
  const t = world();
  const l = telcoLines(t, 'BS-P3', [{ ref: 'R', amountMinor: 7000 }, { ref: 'X', amountMinor: 7000 }]);
  const recipe = [
    { accountId: t.acc('6570'), taxCode: 'VST-M', amount: { kind: 'factor', label: 'Abo', num: 1, den: 2 } },
    { accountId: t.acc('6500'), taxCode: null, amount: { kind: 'rest' } },
  ];
  const ruleId = must(setBankStandard(t.ctx, { bankTxnId: l.R, legs: recipe, idempotencyKey: 'r' })).standard.id;
  assert.equal(proposalOf(t, l.X).reasonCode, 'rule_computed');
  // The rule's legs on 70.00: 35.00 computed to 6510, the rest 35.00 to 6500; given reversed and with words.
  must(
    bookBankLine(t.ctx, {
      bankTxnId: l.X,
      target: {
        kind: 'accounts',
        legs: [
          { accountId: t.acc('6500'), amountMinor: 3500, description: 'Rest, in eigenen Worten' },
          { accountId: t.acc('6570'), amountMinor: 3500, taxCode: 'VST-M', description: 'Abo' },
        ],
      },
      idempotencyKey: 'x',
    }),
  );
  assert.deepEqual({ ...decisionOf(t, l.X) }, { ruleId, changed: 0, bookedByRule: null });
});

test('[INVARIANT provenance/asked and computed] an asked amount is free; overriding a computed amount is a change', () => {
  // Guards expectedRuleLegs: `ask` legs open (signed), the rest open when the recipe asks, `factor` exact.
  const t = world();
  const l = telcoLines(t, 'BS-P4', [
    { ref: 'R', amountMinor: 10000, ustrd: 'ABO' },
    { ref: 'ASK', amountMinor: 10000, ustrd: 'ABO' },
    { ref: 'R2', amountMinor: 10000, ustrd: 'MIETE' },
    { ref: 'FAC', amountMinor: 10000, ustrd: 'MIETE' },
    { ref: 'OVR', amountMinor: 10000, ustrd: 'MIETE' },
  ]);
  const asked = must(
    setBankStandard(t.ctx, {
      bankTxnId: l.R,
      matchText: 'ABO',
      legs: [
        { accountId: t.acc('6570'), taxCode: 'VST-M', amount: { kind: 'ask', label: 'Gebühr' } },
        { accountId: t.acc('6500'), taxCode: null, amount: { kind: 'rest' } },
      ],
      idempotencyKey: 'asked',
    }),
  ).standard.id;
  const computed = must(
    setBankStandard(t.ctx, {
      bankTxnId: l.R2,
      matchText: 'MIETE',
      legs: [
        { accountId: t.acc('6570'), taxCode: 'VST-M', amount: { kind: 'factor', label: 'Anteil', num: 1, den: 4 } },
        { accountId: t.acc('6500'), taxCode: null, amount: { kind: 'rest' } },
      ],
      idempotencyKey: 'computed',
    }),
  ).standard.id;
  assert.equal(proposalOf(t, l.ASK).reasonCode, 'rule_needs_amount');
  must(bookBankLine(t.ctx, { bankTxnId: l.ASK, target: { kind: 'rule', standardId: asked, asks: { 0: 1234 } }, idempotencyKey: 'ask' }));
  assert.deepEqual({ ...decisionOf(t, l.ASK) }, { ruleId: asked, changed: 0, bookedByRule: asked }, 'any asked amount books the rule unchanged');
  must(bookBankLine(t.ctx, { bankTxnId: l.FAC, target: { kind: 'rule', standardId: computed, asks: {} }, idempotencyKey: 'fac' }));
  assert.deepEqual({ ...decisionOf(t, l.FAC) }, { ruleId: computed, changed: 0, bookedByRule: computed }, 'the computed amounts as computed');
  must(bookBankLine(t.ctx, { bankTxnId: l.OVR, target: { kind: 'rule', standardId: computed, asks: { 0: 3000 } }, idempotencyKey: 'ovr' }));
  assert.deepEqual({ ...decisionOf(t, l.OVR) }, { ruleId: computed, changed: 1, bookedByRule: computed }, 'an overridden computed amount is a change');
});

test('[INVARIANT provenance/other rule] booking through another rule, or settling instead, is a change of the proposed rule', () => {
  const t = world();
  const l = telcoLines(t, 'BS-P5', [
    { ref: 'R1', amountMinor: 2000, ustrd: 'MOBIL' },
    { ref: 'R2', amountMinor: 2000, ustrd: 'FESTNETZ' },
    { ref: 'X', amountMinor: 2000, ustrd: 'MOBIL' },
  ]);
  const mobil = telcoRule(t, l.R1, { matchText: 'MOBIL' });
  const festnetz = must(setBankStandard(t.ctx, { bankTxnId: l.R2, accountId: t.acc('6500'), taxCode: null, matchText: 'FESTNETZ', idempotencyKey: 'fest' })).standard.id;
  assert.equal(proposalOf(t, l.X).reasonParams.standardId, mobil);
  // The other rule's text is not on the line, but a person may pick it (expandRule does not check the text).
  must(bookBankLine(t.ctx, { bankTxnId: l.X, target: { kind: 'rule', standardId: festnetz, asks: {} }, idempotencyKey: 'x' }));
  assert.deepEqual({ ...decisionOf(t, l.X) }, { ruleId: mobil, changed: 1, bookedByRule: festnetz });
});

test('[INVARIANT provenance/no rule] no rule, the picker, or an earlier rung: both columns stay NULL', () => {
  // Guards ruleRungForLine: only the ONE rule of rung c2 is recorded, and an earlier rung outranks it.
  const t = world();
  const l = telcoLines(t, 'BS-P6', [
    { ref: 'NONE', amountMinor: 1500, name: 'Niemand Beispiel', iban: undefined },
    { ref: 'R1', amountMinor: 1500, ustrd: 'EINS' },
    { ref: 'R2', amountMinor: 1500, ustrd: 'ZWEI' },
    { ref: 'PICK', amountMinor: 1500, ustrd: 'NICHTS' },
  ]);
  must(bookBankLine(t.ctx, { bankTxnId: l.NONE, target: { kind: 'accounts', legs: [{ accountId: t.acc('6500'), amountMinor: 1500 }] }, idempotencyKey: 'none' }));
  assert.deepEqual({ ...decisionOf(t, l.NONE) }, { ruleId: null, changed: null, bookedByRule: null });
  telcoRule(t, l.R1, { matchText: 'EINS' });
  telcoRule(t, l.R2, { matchText: 'ZWEI' });
  assert.equal(proposalOf(t, l.PICK).reasonCode, 'several_rules');
  must(bookBankLine(t.ctx, { bankTxnId: l.PICK, target: { kind: 'accounts', legs: [{ accountId: t.acc('6570'), amountMinor: 1500, taxCode: 'VST-M' }] }, idempotencyKey: 'pick' }));
  assert.deepEqual({ ...decisionOf(t, l.PICK) }, { ruleId: null, changed: null, bookedByRule: null });
});

test('[INVARIANT provenance/rung a] an entry already on the bank ledger outranks the rule: the match records no rule', () => {
  const t = world();
  const l = telcoLines(t, 'BS-P7', [{ ref: 'R', amountMinor: 3300 }, { ref: 'M', amountMinor: 3300 }]);
  telcoRule(t, l.R);
  const posted = must(postEntry(t.ctx, {
    date: '2026-07-20',
    source: 'manual',
    description: 'Telefon bar erfasst',
    lines: [
      { account: t.acc('6570'), debit: 3300 },
      { account: t.bankId, credit: 3300 },
    ],
    idempotencyKey: 'pre-3300',
  }));
  assert.equal(proposalOf(t, l.M).reasonCode, 'existing_entry_amount_date');
  must(bookBankLine(t.ctx, { bankTxnId: l.M, target: { kind: 'existing_entry', entryId: posted.entryId }, idempotencyKey: 'm' }));
  assert.deepEqual({ ...decisionOf(t, l.M) }, { ruleId: null, changed: null, bookedByRule: null });
});

// ================================================================================================
// 2. The other doors
// ================================================================================================

test('[INVARIANT provenance/create_entry_for_txn] the A20 booking door records the rule, unchanged and changed', () => {
  const t = world();
  const l = telcoLines(t, 'BS-P8', [{ ref: 'R', amountMinor: 4200 }, { ref: 'SAME', amountMinor: 4200 }, { ref: 'OTHER', amountMinor: 4200 }]);
  const ruleId = telcoRule(t, l.R);
  must(createEntryForTxn(t.ctx, { bankTxnId: l.SAME, contraAccountId: t.acc('6570'), taxCode: 'VST-M', idempotencyKey: 'same' }));
  must(createEntryForTxn(t.ctx, { bankTxnId: l.OTHER, contraAccountId: t.acc('6500'), idempotencyKey: 'other' }));
  assert.deepEqual({ ...decisionOf(t, l.SAME) }, { ruleId, changed: 0, bookedByRule: null });
  assert.deepEqual({ ...decisionOf(t, l.OTHER) }, { ruleId, changed: 1, bookedByRule: null });
});

test('[INVARIANT provenance/confirm_match] the A20 settlement door records the rule as changed, by both of its paths', () => {
  // A settlement is never the rule's legs. The one-bill path runs performBooking; the several-bill split
  // writes its own decision (camtReconcile.ts) and binds the provenance itself.
  const t = world();
  const l = importLines(t, {
    statementId: 'BS-P9',
    entries: [
      { ref: 'R', cd: 'DBIT', amountMinor: 11100, name: SHOP, ustrd: 'WARE' },
      { ref: 'ONE', cd: 'DBIT', amountMinor: 11100, name: SHOP, ustrd: 'WARE' },
      { ref: 'TWO', cd: 'DBIT', amountMinor: 22200, name: SHOP, ustrd: 'WARE' },
    ],
  }).lines;
  const ruleId = must(setBankStandard(t.ctx, { bankTxnId: l.R, accountId: t.acc('6500'), taxCode: null, idempotencyKey: 'shop' })).standard.id;
  const one = postedBill(t, { grossMinor: 11100, seed: 'one', vendorName: 'Lieferwerk Anders AG' });
  const a = postedBill(t, { grossMinor: 11100, seed: 'a', vendorName: 'Lieferwerk Anders AG' });
  const b = postedBill(t, { grossMinor: 11100, seed: 'b', vendorName: 'Lieferwerk Anders AG' });
  const before = { one: proposalOf(t, l.ONE), two: proposalOf(t, l.TWO) };
  must(confirmCamtMatch(t.ctx, { bankTxnId: l.ONE, vendorBillId: one.vendorBillId, idempotencyKey: 'one' }));
  must(
    confirmCamtMatch(t.ctx, {
      bankTxnId: l.TWO,
      allocations: [
        { vendorBillId: a.vendorBillId, amountMinor: 11100 },
        { vendorBillId: b.vendorBillId, amountMinor: 11100 },
      ],
      idempotencyKey: 'two',
    }),
  );
  // What each line proposed decides what is recorded: the rule when the rule rung spoke, else nothing.
  for (const [ref, p] of [['ONE', before.one], ['TWO', before.two]]) {
    const expected = p.reasonParams.standardId === ruleId ? { ruleId, changed: 1, bookedByRule: null } : { ruleId: null, changed: null, bookedByRule: null };
    assert.deepEqual({ ...decisionOf(t, l[ref]) }, expected, `${ref} (${p.reasonCode})`);
  }
  assert.equal(before.two.reasonParams.standardId, ruleId, 'the several-bill line was proposed by the rule (the split path is exercised)');
});

// ================================================================================================
// 3. The fee split, the ignore, the reopen, the dry run, the immutable row
// ================================================================================================

test('[INVARIANT provenance/fee split] a card payment booked as proposed, plain or split, is unchanged in both modes', () => {
  // Guards the feeSplitLegs alternative in computeRuleProvenance (withFeeSplit's legs are the proposal too).
  for (const mode of ['propose_split', 'prefill_split']) {
    for (const how of ['plain', 'split']) {
      const t = world();
      must(importCamt(t.ctx, { bankAccountId: t.bankAccountId, xml: FX_XML, idempotencyKey: 'fx' }));
      const card = t.store.db.prepare('SELECT id FROM bank_txn WHERE workspace_id = ? AND amount_minor = 4988').get(t.workspaceId).id;
      const other = t.store.db.prepare('SELECT id FROM bank_txn WHERE workspace_id = ? AND id <> ? ORDER BY rowid LIMIT 1').get(t.workspaceId, card);
      const ruleId = must(setBankStandard(t.ctx, { bankTxnId: card, accountId: t.acc('6500'), taxCode: null, idempotencyKey: 'std' })).standard.id;
      must(settingsSet(t.ctx, { key: 'bank.fx_mode', value: mode, reason: 'N03 test', idempotencyKey: `mode-${mode}` }));
      const p = proposalOf(t, card);
      const legs = how === 'plain' ? [{ accountId: t.acc('6500'), amountMinor: 4988 }] : p.feeSplit.legs;
      must(bookBankLine(t.ctx, { bankTxnId: card, target: { kind: 'accounts', legs }, idempotencyKey: `book-${how}` }));
      assert.deepEqual({ ...decisionOf(t, card) }, { ruleId, changed: 0, bookedByRule: null }, `${mode} ${how}`);
      void other;
    }
  }
});

test('[INVARIANT provenance/ignore] an ignore is no booking: a "Nicht buchen" rule used, or booked against, is recorded right', () => {
  const t = world();
  const l = telcoLines(t, 'BS-P10', [{ ref: 'R', amountMinor: 900 }, { ref: 'IGN', amountMinor: 900 }, { ref: 'BOOK', amountMinor: 900 }]);
  const ruleId = must(
    setBankStandard(t.ctx, { bankTxnId: l.R, outcome: 'ignore', ignoreReason: 'booked_elsewhere', ignoreNote: 'über die Kreditkarte', idempotencyKey: 'ign' }),
  ).standard.id;
  assert.equal(proposalOf(t, l.IGN).reasonCode, 'rule_ignore');
  must(ignoreBankLine(t.ctx, { bankTxnId: l.IGN, reason: 'booked_elsewhere', standardId: ruleId, idempotencyKey: 'i' }));
  assert.deepEqual({ ...decisionOf(t, l.IGN) }, { ruleId: null, changed: null, bookedByRule: ruleId }, 'an ignore carries no provenance (not counted)');
  must(bookBankLine(t.ctx, { bankTxnId: l.BOOK, target: { kind: 'accounts', legs: [{ accountId: t.acc('6570'), amountMinor: 900 }] }, idempotencyKey: 'b' }));
  assert.deepEqual({ ...decisionOf(t, l.BOOK) }, { ruleId, changed: 1, bookedByRule: null }, 'booking a line the rule would ignore is a change');
});

test('[INVARIANT provenance/reopen] a reopened booking keeps its provenance on the superseded row; the rebooking records its own', () => {
  const t = world();
  const l = telcoLines(t, 'BS-P11', [{ ref: 'R', amountMinor: 6100 }, { ref: 'X', amountMinor: 6100 }]);
  const ruleId = telcoRule(t, l.R);
  must(bookBankLine(t.ctx, { bankTxnId: l.X, target: { kind: 'accounts', legs: [{ accountId: t.acc('6500'), amountMinor: 6100 }] }, idempotencyKey: 'b1' }));
  must(reopenBankLine(t.ctx, { bankTxnId: l.X, reason: 'falsches Konto', idempotencyKey: 'undo' }));
  must(bookBankLine(t.ctx, { bankTxnId: l.X, target: proposalOf(t, l.X).target, idempotencyKey: 'b2' }));
  const rows = t.store.db
    .prepare('SELECT proposed_rule_id AS ruleId, rule_changed AS changed, superseded_at IS NOT NULL AS old FROM bank_line_decision WHERE workspace_id = ? AND bank_txn_id = ? ORDER BY rowid')
    .all(t.workspaceId, l.X)
    .map((r) => ({ ...r }));
  assert.deepEqual(rows, [
    { ruleId, changed: 1, old: 1 },
    { ruleId, changed: 0, old: 0 },
  ]);
});

test('[INVARIANT provenance/dry run] the preview and the pre-draft screen record nothing and read no rule', () => {
  // Guards performBooking's `dryRun` skip: the settlement preview (dryRunCapture) and the pre-draft screen
  // (dryRunBooking) run the real booking and roll it back; the provenance read is never made inside them.
  const t = world();
  const l = importLines(t, { statementId: 'BS-P12', entries: [{ ref: 'R', cd: 'DBIT', amountMinor: 7700, name: SHOP }, { ref: 'X', cd: 'DBIT', amountMinor: 7700, name: SHOP }] }).lines;
  must(setBankStandard(t.ctx, { bankTxnId: l.R, accountId: t.acc('6500'), taxCode: null, idempotencyKey: 'shop' }));
  const bill = postedBill(t, { grossMinor: 7700, seed: 'dry', vendorName: 'Lieferwerk Anders AG' });
  const seen = spySql(t);
  const decisions = () => t.store.db.prepare('SELECT COUNT(*) AS n FROM bank_line_decision WHERE workspace_id = ?').get(t.workspaceId).n;
  const before = decisions();
  must(composeBankLine(t.ctx, { bankTxnId: l.X, target: { kind: 'open_item', documentId: bill.vendorBillId } }));
  assert.equal(prevalidateBookBankLine(t.ctx, { bankTxnId: l.X, target: { kind: 'open_item', documentId: bill.vendorBillId }, idempotencyKey: 'screen' }), undefined);
  seen.stop();
  assert.equal(decisions(), before, 'nothing survives a dry run');
  assert.deepEqual(seen.sql.filter(isRuleRungRead), [], 'no rule rung read inside a dry run');
});

test('[INVARIANT provenance/immutable] the two columns cannot be rewritten after the booking', () => {
  const t = world();
  const l = telcoLines(t, 'BS-P13', [{ ref: 'R', amountMinor: 1200 }, { ref: 'X', amountMinor: 1200 }]);
  telcoRule(t, l.R);
  must(bookBankLine(t.ctx, { bankTxnId: l.X, target: proposalOf(t, l.X).target, idempotencyKey: 'x' }));
  assert.throws(() => t.store.db.prepare('UPDATE bank_line_decision SET rule_changed = 1 WHERE bank_txn_id = ?').run(l.X), /only the supersession stamp/);
  assert.throws(() => t.store.db.prepare('UPDATE bank_line_decision SET proposed_rule_id = NULL WHERE bank_txn_id = ?').run(l.X), /only the supersession stamp/);
});

// ================================================================================================
// 4. The cost: the light path (N03 §4, the brief's measure)
// ================================================================================================

/** Record every statement the store prepares until `stop()`. */
function spySql(t) {
  const db = t.store.db;
  const original = db.prepare;
  const sql = [];
  db.prepare = function (text) {
    sql.push(String(text).replace(/\s+/g, ' ').trim());
    return original.call(this, text);
  };
  return { sql, stop: () => { db.prepare = original; } };
}

/** The whole-book reads the inbox's context pays once per page (history, journal, every claim). */
const WHOLE_BOOK = [
  /FROM bank_line_decision d JOIN bank_txn t .* LIMIT 2000/, // historyIndex (rung d)
  /FROM journal_entry e LEFT JOIN journal_entry rv .* LIMIT 2000/, // journalIndex (rung d2)
  /^SELECT journal_line_id AS lineId, bank_txn_id AS txn FROM bank_line_claim WHERE workspace_id = \? AND released_at IS NULL$/, // claimedLegs
  /FROM bank_model/, // the model rung
];

/** A read only the rule rung makes (the live rules index, the per-leg claim probe). */
const isRuleRungRead = (s) => /FROM bank_standard s WHERE s\.workspace_id = \? AND s\.superseded_at IS NULL AND s\.scope = 'bank'/.test(s) || /SELECT 1 AS h FROM bank_line_claim/.test(s);

test('[MEASURE provenance/light] a booking reads the rule rung, never the whole-book context of the inbox', () => {
  const t = world();
  const l = telcoLines(t, 'BS-P14', [{ ref: 'R', amountMinor: 2500 }, { ref: 'X', amountMinor: 2500 }, { ref: 'Y', amountMinor: 2500, name: 'Ohne Regel Beispiel', iban: undefined }]);
  telcoRule(t, l.R);
  const target = proposalOf(t, l.X).target;
  const seen = spySql(t);
  must(bookBankLine(t.ctx, { bankTxnId: l.X, target, idempotencyKey: 'x' }));
  must(bookBankLine(t.ctx, { bankTxnId: l.Y, target: { kind: 'accounts', legs: [{ accountId: t.acc('6500'), amountMinor: 2500 }] }, idempotencyKey: 'y' }));
  seen.stop();
  for (const pattern of WHOLE_BOOK) assert.deepEqual(seen.sql.filter((s) => pattern.test(s)), [], `no ${pattern}`);
  assert.ok(seen.sql.some(isRuleRungRead), 'the rule rung was read for the line with a rule');
});

// ================================================================================================
// 5. The comparison itself, as a unit
// ================================================================================================

test('legsMatch pairs exact amounts first, then signed open amounts, then either sign', () => {
  const e = (accountId, amountMinor, sign = 0, taxCode = null) => ({ accountId, taxCode, amountMinor, sign });
  const b = (accountId, amountMinor, taxCode = null) => ({ accountId, amountMinor, taxCode });
  assert.equal(legsMatch([e('a', null, 1), e('a', null, 0)], [b('a', -5), b('a', 5)]), true, 'the signed open leg is paired before the free one');
  assert.equal(legsMatch([e('a', 10)], [b('a', 10, 'X')]), false, 'the code is compared');
  assert.equal(legsMatch([e('a', 10), e('b', 5)], [b('a', 10)]), false, 'the leg count is compared');
  assert.deepEqual(
    expectedRuleLegs([{ accountId: 'a', taxCode: 'V', amount: { kind: 'factor', label: 'x', num: 1, den: 3 } }, { accountId: 'b', taxCode: null, amount: { kind: 'rest' } }], 1000, true),
    [e('a', 333, 1), e('b', 667, 0)],
    'computed exactly, the rest takes the remainder, a dropped code is dropped',
  );
  assert.equal(expectedRuleLegs([{ accountId: 'a', taxCode: null, amount: { kind: 'factor', label: 'x', num: 1, den: 1 } }, { accountId: 'b', taxCode: null, amount: { kind: 'rest' } }], 1000, false), null, 'a rest of 0 cannot be the proposal');
  void refused;
});
