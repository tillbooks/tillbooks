// D177 non-author critic probes, engine half (critic/d177-engine-2026-10-16, reviewed tip ba161889).
// Tests named [FINDING ...] assert the behaviour the contract asks for and FAIL on ba161889 by design;
// [PROBE] tests pass and record what was checked. Synthetic data only: every payer, amount and text is
// invented.
//
// Copied onto claude/d177-engine with the remediation (16.10.2026). Five [PROBE] tests recorded behaviour
// the remediation changed by design; each now asserts the remedied contract and says which finding moved
// it (C3 the gate passes supersededActionIds, C4 the supersede stays within one actor, C5 the fraction is
// bounded at save time, C6 a decided line resolves its other pending drafts). The [FINDING] tests are
// unchanged.

import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { listBankInbox, bookBankLine, setBankStandard, prevalidateBookBankLine } from '../../dist/core/banking/index.js';
import { composeBankLine } from '../../dist/core/banking/bankBooking.js';
import { factorAmountMinor } from '../../dist/core/banking/bankStandards.js';
import { getAction } from '../../dist/api/registry.js';
import { runGoverned } from '../../dist/api/agent-gate.js';
import { createAccount } from '../../dist/core/accounts/accounts.js';
import { settingsSet } from '../../dist/core/settings/index.js';
import { world, importLines, must, refused, legs as entryLegs } from './bank-inbox-support.mjs';
import { assertClaimInvariantHolds } from './bank-inbox-support.mjs';
import { chainedOpening } from './e2-adapt.mjs';

afterEach(assertClaimInvariantHolds);

const PAYOUT = 'Zahlwerk Beispiel Ltd';
const lineOf = (t, id) => must(listBankInbox(t.ctx, { status: 'all' }), 'inbox').lines.find((l) => l.bankTxnId === id);
const draftRows = (t) =>
  t.store.db.prepare('SELECT id, action_tool, status, reject_reason, resolved_by, payload_json FROM agent_action WHERE workspace_id = ? ORDER BY rowid').all(t.workspaceId);
const agentDeps = (t, actor = 'agent') => ({ store: t.store, clock: t.clock, ids: t.ids, actor });
const governed = (t, name, input, actor) => runGoverned(agentDeps(t, actor), getAction(name), { workspaceId: t.workspaceId, ...input });
const approve = (t, actionId) => getAction('approve_drafted_action').run({ store: t.store, clock: t.clock, ids: t.ids, actor: 'studio' }, { workspaceId: t.workspaceId, actionId });

function factorWorld() {
  const t = world();
  must(createAccount(t.ctx, { number: '1095', name: 'Erlös Durchlaufkonto', type: 'asset', idempotencyKey: 'acc-1095' }), '1095');
  return t;
}

/** Every table's row count, so a probe sees ANY write. */
function everyCount(t) {
  const tables = t.store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  const out = {};
  for (const { name } of tables) out[name] = t.store.db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get().n;
  return out;
}

function feeLine(t, key = 'F') {
  return importLines(t, { statementId: `BS-${key}`, entries: [{ ref: key, amountMinor: 470, cd: 'DBIT', name: 'Kartenterminal Beispiel AG', ustrd: `TERMINAL ${key}` }] }).lines[key];
}

const goodBook = (t, line, key) => governed(t, 'book_bank_line', { bankTxnId: line, target: { kind: 'accounts', legs: [{ accountId: t.acc('6500'), amountMinor: 470 }] }, idempotencyKey: key });

// ---------------------------------------------------------------------------------------------------
// Agent drafts: what may supersede a good Vorschlag
// ---------------------------------------------------------------------------------------------------

test('[FINDING D177-C1] an ignore_bank_line draft the verb would refuse (unknown reason) supersedes a bookable Vorschlag', () => {
  const t = factorWorld();
  const line = feeLine(t);
  const good = must(goodBook(t, line, 'c1-good'));
  assert.equal(good.drafted, true);
  // The direct call refuses this input outright.
  refused(getAction('ignore_bank_line').run({ store: t.store, clock: t.clock, ids: t.ids, actor: 'studio' }, { workspaceId: t.workspaceId, bankTxnId: line, reason: 'gibt_es_nicht', idempotencyKey: 'c1-direct' }), 'invalid_input');
  const bad = governed(t, 'ignore_bank_line', { bankTxnId: line, reason: 'gibt_es_nicht', idempotencyKey: 'c1-bad' });
  const goodRow = draftRows(t).find((r) => r.id === good.actionId);
  // Contract (D177 point 8, §16.1): one pending Vorschlag per line, and a draft the approval can only fail
  // never reaches a person. Here it does, AND it displaces the bookable one.
  assert.equal(goodRow.status, 'pending', `the bookable Vorschlag must survive an unbookable newcomer; got ${goodRow.status}/${goodRow.reject_reason}, newcomer ${JSON.stringify(bad).slice(0, 160)}`);
});

test('[FINDING D177-C2] a book_bank_line settlement draft naming no document passes the pre-draft screen and supersedes a bookable Vorschlag', () => {
  const t = factorWorld();
  const line = feeLine(t);
  const good = must(goodBook(t, line, 'c2-good'));
  const input = { bankTxnId: line, target: { kind: 'open_item', documentId: 'doc_gibt_es_nicht' } };
  const direct = bookBankLine(t.ctx, { ...input, idempotencyKey: 'c2-direct' });
  assert.equal(direct.ok, false, 'the direct call refuses');
  assert.equal(direct.error, 'not_found');
  const pre = prevalidateBookBankLine(t.ctx, { ...input, idempotencyKey: 'c2-pre' });
  const bad = governed(t, 'book_bank_line', { ...input, idempotencyKey: 'c2-bad' });
  const goodRow = draftRows(t).find((r) => r.id === good.actionId);
  assert.equal(
    goodRow.status,
    'pending',
    `prevalidate answered ${JSON.stringify(pre)}; the agent got ${JSON.stringify(bad).slice(0, 120)}; the bookable Vorschlag is ${goodRow.status}/${goodRow.reject_reason}`,
  );
});

test('[PROBE, remedied C4] supersede stays within one actor: a second governed seat\'s draft leaves the first seat\'s Vorschlag pending', () => {
  const t = factorWorld();
  t.store.db.prepare("INSERT INTO user (actor_id, kind, display_name, created_at) VALUES ('agent-zwei', 'agent', 'Zweiter Agent', '2026-07-01T00:00:00.000Z')").run();
  const line = feeLine(t);
  const first = must(goodBook(t, line, 'x-1'));
  const second = governed(t, 'ignore_bank_line', { bankTxnId: line, reason: 'duplicate', idempotencyKey: 'x-2' }, 'agent-zwei');
  assert.equal(second.drafted, true, JSON.stringify(second));
  const row = draftRows(t).find((r) => r.id === first.actionId);
  assert.equal(row.status, 'pending', 'C4 (owner ruling): another seat never withdraws the first seat\'s Vorschlag');
  assert.equal(lineOf(t, line).vorschlagActionId, second.actionId, 'the inbox names the newest');
});

test('[PROBE, remedied C3] the gate tells the agent which Vorschlag its draft replaced, and the trace names the replacement', () => {
  const t = factorWorld();
  const line = feeLine(t);
  const first = must(goodBook(t, line, 's-1'));
  const second = must(governed(t, 'book_bank_line', { bankTxnId: line, target: { kind: 'accounts', legs: [{ accountId: t.acc('6800'), amountMinor: 470 }] }, idempotencyKey: 's-2' }));
  assert.equal(second.drafted, true);
  assert.deepEqual(second.supersededActionIds, [first.actionId], 'C3: the gate passes the ids through');
  const call = t.store.db.prepare('SELECT entity_ref FROM agent_call WHERE workspace_id = ? AND agent_action_id = ?').get(t.workspaceId, first.actionId);
  assert.equal(call.entity_ref, second.actionId, 'C3: the replaced draft\'s trace names the replacement');
});

// ---------------------------------------------------------------------------------------------------
// prevalidate: no side effects, no more and no less than the direct call
// ---------------------------------------------------------------------------------------------------

test('[PROBE] prevalidateBookBankLine writes nothing, for valid and refused inputs alike', () => {
  const t = factorWorld();
  const line = feeLine(t);
  // D178 point 19 (re-cut): the next statement opens where the last one closed, as a bank's do.
  const p = importLines(t, { statementId: 'BS-PV', seqNb: '2', openingMinor: chainedOpening(t), entries: [{ ref: 'P', amountMinor: 3000, cd: 'CRDT', name: PAYOUT, ustrd: 'AUSZAHLUNG PV' }] }).lines.P;
  const rule = must(
    setBankStandard(t.ctx, {
      bankTxnId: p,
      legs: [
        { accountId: t.acc('3400'), taxCode: 'UST81', amount: { kind: 'factor', label: 'Brutto', num: 1081, den: 180 } },
        { accountId: t.acc('4400'), taxCode: null, amount: { kind: 'rest' } },
      ],
      viaAccountId: t.acc('1095'),
      idempotencyKey: 'pv-set',
    }),
  ).standard;
  const before = everyCount(t);
  const inputs = [
    { bankTxnId: line, target: { kind: 'accounts', legs: [{ accountId: t.acc('6500'), amountMinor: 470 }] }, idempotencyKey: 'pv-1' },
    { bankTxnId: line, target: { kind: 'accounts', legs: [{ accountId: t.acc('6500'), amountMinor: -470 }] }, idempotencyKey: 'pv-2' },
    { bankTxnId: p, target: { kind: 'rule', standardId: rule.id, asks: {} }, idempotencyKey: 'pv-3' },
    { bankTxnId: p, target: { kind: 'rule', standardId: rule.id, asks: { 0: 0 } }, idempotencyKey: 'pv-4' },
    { bankTxnId: line, target: { kind: 'rule', standardId: rule.id, asks: {} }, idempotencyKey: 'pv-5' },
  ];
  const answers = inputs.map((i) => prevalidateBookBankLine(t.ctx, i));
  assert.deepEqual(everyCount(t), before, 'no table moved');
  assert.equal(answers[0], undefined);
  assert.equal(answers[2], undefined);
  assert.equal(answers[1].error, 'legs_do_not_sum');
  assert.equal(answers[3].error, 'ask_missing');
  assert.equal(answers[4].error, 'rule_not_applicable');
  // And the valid ones still book afterwards on the same key (no memo was written by the screen).
  must(bookBankLine(t.ctx, inputs[2]));
});

test('[PROBE] prevalidate accepts what the direct call accepts: a control-account leg (warning, not refusal) drafts', () => {
  const t = factorWorld();
  const l = importLines(t, { statementId: 'BS-CA', entries: [{ ref: 'C', amountMinor: 5000, cd: 'CRDT', name: 'Kundin Beispiel', ustrd: 'RECHNUNG 1' }] }).lines.C;
  const input = { bankTxnId: l, target: { kind: 'accounts', legs: [{ accountId: t.acc('1100'), amountMinor: 5000 }] } };
  const pre = prevalidateBookBankLine(t.ctx, { ...input, idempotencyKey: 'ca-pre' });
  const viaAgent = governed(t, 'book_bank_line', { ...input, idempotencyKey: 'ca-agent' });
  const direct = bookBankLine(t.ctx, { ...input, idempotencyKey: 'ca-direct' });
  assert.equal(direct.ok, pre === undefined, `direct ${JSON.stringify(direct).slice(0, 160)} vs prevalidate ${JSON.stringify(pre)}`);
  if (direct.ok) assert.equal(viaAgent.drafted, true);
});

// ---------------------------------------------------------------------------------------------------
// Factor amounts: overflow, many legs, parity
// ---------------------------------------------------------------------------------------------------

test('[PROBE, remedied C5] a fraction that could leave a safe integer is refused at save time with invalid_recipe detail factor', () => {
  const t = factorWorld();
  const p = importLines(t, { statementId: 'BS-OV', entries: [{ ref: 'P', amountMinor: 3000, cd: 'CRDT', name: PAYOUT, ustrd: 'AUSZAHLUNG OV' }] }).lines.P;
  for (const [num, den, field] of [
    [Number.MAX_SAFE_INTEGER, 1, 'num'],
    [1, 2_000_000, 'den'],
    [1001, 1, 'num'],
  ]) {
    const r = refused(
      setBankStandard(t.ctx, {
        bankTxnId: p,
        legs: [
          { accountId: t.acc('3400'), taxCode: null, amount: { kind: 'factor', label: 'Brutto', num, den } },
          { accountId: t.acc('4400'), taxCode: null, amount: { kind: 'rest' } },
        ],
        idempotencyKey: `ov-${num}-${den}`,
      }),
      'invalid_recipe',
    );
    assert.equal(r.detail, 'factor');
    assert.equal(r.field, field);
  }
  // The bound itself is accepted: 1000 x the line.
  must(setBankStandard(t.ctx, { bankTxnId: p, legs: [
    { accountId: t.acc('3400'), taxCode: null, amount: { kind: 'factor', label: 'Brutto', num: 1000, den: 1 } },
    { accountId: t.acc('4400'), taxCode: null, amount: { kind: 'rest' } },
  ], idempotencyKey: 'ov-ok' }));
});

test('[PROBE] two factor legs, one against, plus the rest: compose equals the booking, the entry balances, the Durchlaufkonto nets to zero', () => {
  const t = factorWorld();
  must(createAccount(t.ctx, { number: '6941', name: 'Plattformgebühr', type: 'expense', idempotencyKey: 'acc-6941' }));
  const p = importLines(t, { statementId: 'BS-MF', entries: [{ ref: 'P', amountMinor: 1512, cd: 'CRDT', name: PAYOUT, ustrd: 'AUSZAHLUNG MF' }] }).lines.P;
  const rule = must(
    setBankStandard(t.ctx, {
      bankTxnId: p,
      legs: [
        { accountId: t.acc('3400'), taxCode: 'UST81', amount: { kind: 'factor', label: 'Brutto', num: 1081, den: 180 } },
        { accountId: t.acc('6941'), taxCode: null, amount: { kind: 'factor', label: 'Gebühr', num: 2, den: 3 }, against: true },
        { accountId: t.acc('4400'), taxCode: null, amount: { kind: 'rest' } },
      ],
      viaAccountId: t.acc('1095'),
      idempotencyKey: 'mf-set',
    }),
  ).standard;
  assert.equal(factorAmountMinor(1512, 1081, 180), 9080, 'the D177 worked figure: 15.12 gives 90.80');
  const target = { kind: 'rule', standardId: rule.id, asks: {} };
  const preview = must(composeBankLine(t.ctx, { bankTxnId: p, target }));
  assert.equal(preview.verdict.ok, true, JSON.stringify(preview.verdict));
  assert.deepEqual(preview.target.legs.map((x) => x.amountMinor), [9080, -1008, 1512 - 9080 + 1008]);
  const booked = must(bookBankLine(t.ctx, { bankTxnId: p, target, idempotencyKey: 'mf-book' }));
  const stored = t.store.db
    .prepare('SELECT account_id AS a, debit_minor AS d, credit_minor AS c, tax_code AS tc FROM journal_line WHERE entry_id = ? ORDER BY rowid')
    .all(booked.entryId)
    .map((r) => [r.a, r.d, r.c, r.tc]);
  assert.deepEqual(stored, preview.lines.map((x) => [x.account, x.debit ?? 0, x.credit ?? 0, x.taxCode ?? null]));
  const legs = entryLegs(t.store, booked.entryId);
  assert.equal(legs.reduce((s, x) => s + x.debit - x.credit, 0), 0, 'balances');
  assert.equal(legs.filter((x) => x.number === '1095').reduce((s, x) => s + x.debit - x.credit, 0), 0, 'via nets to zero');
});

test('[PROBE] a huge but safe computed gross with UST81: compose equals the booking and the entry balances', () => {
  const t = factorWorld();
  // C5 bounds a fraction at 1000 x the line, so the huge gross comes from a huge line (synthetic).
  const p = importLines(t, { statementId: 'BS-HG', entries: [{ ref: 'P', amountMinor: 4_000_000_00, cd: 'CRDT', name: PAYOUT, ustrd: 'AUSZAHLUNG HG' }] }).lines.P;
  const rule = must(
    setBankStandard(t.ctx, {
      bankTxnId: p,
      legs: [
        { accountId: t.acc('3400'), taxCode: 'UST81', amount: { kind: 'factor', label: 'Brutto', num: 1000, den: 1 } },
        { accountId: t.acc('4400'), taxCode: null, amount: { kind: 'rest' } },
      ],
      idempotencyKey: 'hg-set',
    }),
  ).standard;
  const target = { kind: 'rule', standardId: rule.id, asks: {} };
  const preview = must(composeBankLine(t.ctx, { bankTxnId: p, target }));
  const booked = bookBankLine(t.ctx, { bankTxnId: p, target, idempotencyKey: 'hg-book' });
  if (!preview.verdict.ok) {
    console.log('huge gross verdict', JSON.stringify(preview.verdict));
    assert.equal(booked.ok, false, 'a preview refusal is a booking refusal');
    assert.equal(booked.error, preview.verdict.error);
    return;
  }
  must(booked);
  const legs = entryLegs(t.store, booked.entryId);
  assert.equal(legs.reduce((s, x) => s + x.debit - x.credit, 0), 0, 'balances');
});

// ---------------------------------------------------------------------------------------------------
// Settings and the dial
// ---------------------------------------------------------------------------------------------------

test('[PROBE] computed_mode bulk is sure even while buchungsregel_mode says suggest (two independent switches)', () => {
  const t = factorWorld();
  must(settingsSet(t.ctx, { key: 'bank.buchungsregel_mode', value: 'suggest', reason: 'alles prüfen', idempotencyKey: 'm1' }));
  must(settingsSet(t.ctx, { key: 'bank.buchungsregel_computed_mode', value: 'bulk', reason: 'Schätzung reicht', idempotencyKey: 'm2' }));
  const p = importLines(t, { statementId: 'BS-SW', entries: [{ ref: 'P', amountMinor: 3000, cd: 'CRDT', name: PAYOUT, ustrd: 'AUSZAHLUNG SW' }] }).lines.P;
  must(
    setBankStandard(t.ctx, {
      bankTxnId: p,
      legs: [
        { accountId: t.acc('3400'), taxCode: null, amount: { kind: 'factor', label: 'Brutto', num: 2, den: 1 } },
        { accountId: t.acc('4400'), taxCode: null, amount: { kind: 'rest' } },
      ],
      idempotencyKey: 'sw-set',
    }),
  );
  assert.equal(lineOf(t, p).attention, 'sure', 'recorded as observed: the computed switch alone decides');
});

test('[PROBE] an agent changing bank.buchungsregel_computed_mode drafts under post', () => {
  const t = factorWorld();
  const r = governed(t, 'settings_set', { key: 'bank.buchungsregel_computed_mode', value: 'bulk', reason: 'Agent', idempotencyKey: 'ag-set' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.drafted, true, JSON.stringify(r));
  assert.equal(r.dialCapability, 'post');
});

// ---------------------------------------------------------------------------------------------------
// A book that already holds two drafts (drafted before D177)
// ---------------------------------------------------------------------------------------------------

test('[PROBE, remedied C6] two legacy pending drafts: the older (wrong sign) cannot book; approving the newer books once and resolves the older', () => {
  const t = factorWorld();
  const line = feeLine(t);
  const raw = (id, at, amountMinor) =>
    t.store.db
      .prepare(
        `INSERT INTO agent_action (id, workspace_id, actor, dial_capability, action_tool, payload_json, status, idempotency_key, created_at)
         VALUES (?, ?, 'agent', 'post', 'book_bank_line', ?, 'pending', ?, ?)`,
      )
      .run(id, t.workspaceId, JSON.stringify({ workspaceId: t.workspaceId, bankTxnId: line, target: { kind: 'accounts', legs: [{ accountId: t.acc('6500'), amountMinor }] }, idempotencyKey: id }), id, at);
  raw('aa_alt', '2026-07-01T08:00:00.000Z', -470);
  raw('aa_neu', '2026-07-02T08:00:00.000Z', 470);
  assert.equal(lineOf(t, line).vorschlagActionId, 'aa_neu');
  const old = approve(t, 'aa_alt');
  assert.equal(old.ok, false, 'the wrong-signed legacy draft cannot book');
  must(approve(t, 'aa_neu'));
  assert.equal(lineOf(t, line).state, 'booked');
  const again = approve(t, 'aa_alt');
  assert.equal(again.ok, false, 'line_not_open: nothing doubles');
  const entries = t.store.db.prepare("SELECT COUNT(*) AS n FROM bank_txn_link WHERE workspace_id = ? AND bank_txn_id = ?").get(t.workspaceId, line).n;
  assert.equal(entries, 1);
  const alt = draftRows(t).find((r) => r.id === 'aa_alt');
  assert.deepEqual([alt.status, alt.reject_reason], ['rejected', 'Zeile entschieden'], 'C6: the decision resolves the legacy duplicate');
});
