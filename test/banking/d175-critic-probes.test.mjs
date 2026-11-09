// D175 non-author critic probes, round 1 (written as D173 on critic/d173-2026-10-15, renumbered D175 when
// the decision was). Synthetic data only: invented names, invented amounts, the published sample IBANs of
// bank-inbox-support.mjs. Each test is named after the finding or the property it probes. A test marked
// [FINDING ...] failed on the reviewed tip (a7b1fcd9) by design and passes since its fix landed on
// claude/d175-integration.

import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

import { listBankInbox, bookBankLine, setBankStandard, clearBankStandard } from '../../dist/core/banking/index.js';
import { composeBankLine } from '../../dist/core/banking/bankBooking.js';
import { createAccount, archiveAccount } from '../../dist/core/accounts/accounts.js';
import { computeVatReturn } from '../../dist/core/vat/index.js';
import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { getAction } from '../../dist/api/registry.js';
import { makeContext } from '../../dist/core/context.js';
import { enqueueDraftedAction } from '../../dist/core/agent/index.js';
import { SCENARIOS, fixture } from '../api/conformance-contract.mjs';
import { world, importLines, must, refused, legs as entryLegs, excuseClaimInvariant, assertClaimInvariantHolds, TELCO_IBAN } from './bank-inbox-support.mjs';

afterEach(assertClaimInvariantHolds);

const PAYOUT = 'Zahlwerk Beispiel Ltd';
const lineOf = (t, id) => must(listBankInbox(t.ctx, { status: 'all' }), 'inbox').lines.find((l) => l.bankTxnId === id);

function rulesWorld() {
  const t = world();
  must(createAccount(t.ctx, { number: '1095', name: 'Erlös Durchlaufkonto', type: 'asset', idempotencyKey: 'acc-1095' }), '1095');
  return t;
}

/** Every line of an entry except the bank ledger and the Durchlaufkonto, as [number, debit, credit, taxCode]. */
const businessLegs = (t, entryId) =>
  entryLegs(t.store, entryId)
    .filter((x) => x.number !== '1020' && x.number !== '1095')
    .map((x) => [x.number, x.debit, x.credit, x.taxCode]);

/** The VAT return of July 2026, without the per-entry drill-down ids (they differ only by id). */
function julyReturn(t) {
  const r = must(computeVatReturn(t.ctx, { periodStart: '2026-07-01', periodEnd: '2026-07-31' }), 'vat return');
  return JSON.parse(JSON.stringify(r, (k, v) => (k === 'entryIds' || k === 'entryId' || k === 'lineIds' ? undefined : v)));
}

// ================================================================================================
// Point 1: the via route posts exactly the direct route's net and VAT, and the VAT return reads it once
// ================================================================================================

/** One world per route: book the same legs on the same line, directly or through 1095. */
function bookBothWays(cd, amountMinor, legsOf) {
  const out = {};
  for (const route of ['direct', 'via']) {
    const t = rulesWorld();
    const l = importLines(t, { statementId: `PAR-${route}`, entries: [{ ref: 'L', amountMinor, cd, iban: TELCO_IBAN, name: 'Fernmelde Ostschweiz AG', ustrd: 'PROBE' }] }).lines;
    const target = { kind: 'accounts', legs: legsOf(t), ...(route === 'via' ? { viaAccountId: t.acc('1095') } : {}) };
    const composed = must(composeBankLine(t.ctx, { bankTxnId: l.L, target }), 'compose');
    assert.notEqual(composed.verdict?.ok, false, `${route}: ${JSON.stringify(composed.verdict)}`);
    const booked = must(bookBankLine(t.ctx, { bankTxnId: l.L, target, idempotencyKey: `par-${route}` }), `${route} book`);
    const all = entryLegs(t.store, booked.entryId);
    out[route] = {
      business: businessLegs(t, booked.entryId),
      bank: all.filter((x) => x.number === '1020').reduce((s, x) => s + x.debit - x.credit, 0),
      via: all.filter((x) => x.number === '1095').reduce((s, x) => s + x.debit - x.credit, 0),
      vat: julyReturn(t),
    };
  }
  return out;
}

const PARITY_CASES = [
  ['money in, UST81 gross with an odd Rappen, rest against the line (a marketplace payout)', 'CRDT', 3001, (t) => [
    { accountId: t.acc('3400'), amountMinor: 21623, taxCode: 'UST81' },
    { accountId: t.acc('4400'), amountMinor: 3001 - 21623 },
  ]],
  ['money out, VST-M26 and VST-I38 and an untaxed leg', 'DBIT', 33337, (t) => [
    { accountId: t.acc('6500'), amountMinor: 10001, taxCode: 'VST-M26' },
    { accountId: t.acc('6570'), amountMinor: 20003, taxCode: 'VST-I38' },
    { accountId: t.acc('6800'), amountMinor: 3333 },
  ]],
  ['money out, Bezugsteuer (priced on the base)', 'DBIT', 12345, (t) => [{ accountId: t.acc('6570'), amountMinor: 12345, taxCode: 'BEZUG' }]],
  ['money in on an input code (a supplier refund, mirrored)', 'CRDT', 5407, (t) => [{ accountId: t.acc('6500'), amountMinor: 5407, taxCode: 'VST-M' }]],
  ['money out on an output code (a customer refund, mirrored)', 'DBIT', 1081, (t) => [{ accountId: t.acc('3400'), amountMinor: 1081, taxCode: 'UST81' }]],
];

for (const [name, cd, amount, legsOf] of PARITY_CASES) {
  test(`via parity: ${name}: the via route posts the direct route's business lines, nets 1095 to zero, and the VAT return is identical`, () => {
    const r = bookBothWays(cd, amount, legsOf);
    assert.deepEqual(r.via.business, r.direct.business, 'net, VAT and every other business line are identical');
    assert.equal(r.via.bank, r.direct.bank, 'the bank moves by the line amount either way');
    assert.equal(r.via.via, 0, 'the Durchlaufkonto nets to zero inside the entry');
    assert.deepEqual(r.via.vat, r.direct.vat, 'the VAT return reads the via entry exactly as the direct one (turnover once, 1095 never)');
  });
}

// ================================================================================================
// Point 3: the ladder. A text rule that MATCHES the line but went invalid must not hand the line to the
// text-less rule as a `sure` booking to another account.
// ================================================================================================

test('[FINDING D175-C1] a matching text rule that went invalid does not let the text-less rule propose sure for its line', () => {
  const t = rulesWorld();
  const l = importLines(t, {
    statementId: 'C1',
    entries: [
      { ref: 'SEED', amountMinor: 1000, cd: 'CRDT', name: PAYOUT, ustrd: 'SEED' },
      { ref: 'SHOP', amountMinor: 3000, cd: 'CRDT', name: PAYOUT, ustrd: 'MUSTERSHOP AUSZAHLUNG 7' },
    ],
  }).lines;
  // Two complete rules for one payer: everything to 3200, and the shop payouts (by text) to 3400.
  const plain = must(setBankStandard(t.ctx, { bankTxnId: l.SEED, accountId: t.acc('3200'), taxCode: null, idempotencyKey: 'c1-plain' })).standard;
  const shop = must(setBankStandard(t.ctx, { bankTxnId: l.SEED, accountId: t.acc('3400'), taxCode: null, matchText: 'mustershop', idempotencyKey: 'c1-shop' })).standard;
  const before = lineOf(t, l.SHOP).proposal;
  assert.equal(before.reasonParams.standardId, shop.id, 'while valid, the text rule decides the shop line');
  // The shop rule goes quiet (its account archived): the line belongs to the shop rule, not to the plain one.
  must(archiveAccount(t.ctx, { accountId: t.acc('3400') }));
  const after = lineOf(t, l.SHOP).proposal;
  assert.ok(
    !(after.reasonCode === 'standard' && after.reasonParams.standardId === plain.id && after.certainty === 'sure'),
    `the shop line is now proposed SURE to 3200 by the text-less rule, so "Alle vorgeschlagenen buchen" would book a shop payout to the wrong account: ${JSON.stringify(after)}`,
  );
});

test('[FINDING D175-C4] the match text is a whole-token match, not a substring ("shop" must not match "WORKSHOP")', () => {
  const t = rulesWorld();
  const l = importLines(t, {
    statementId: 'C4',
    entries: [
      { ref: 'SEED', amountMinor: 1000, cd: 'CRDT', name: PAYOUT, ustrd: 'SHOP 1' },
      { ref: 'WS', amountMinor: 2000, cd: 'CRDT', name: PAYOUT, ustrd: 'WORKSHOP KURSGELD' },
    ],
  }).lines;
  must(setBankStandard(t.ctx, { bankTxnId: l.SEED, accountId: t.acc('3400'), taxCode: null, matchText: 'shop', idempotencyKey: 'c4' }));
  const p = lineOf(t, l.WS).proposal;
  assert.notEqual(p.certainty, 'sure', `a "shop" rule is sure for a WORKSHOP line: ${JSON.stringify(p)}`);
});

// ================================================================================================
// Point 5: D162. A governed seat drafts book_bank_line with a rule target; approval must replay exactly
// what was pinned, including the MWST code of an ASKED leg.
// ================================================================================================

const agentCtx = (fx) => makeContext(fx.deps.store, { workspaceId: fx.workspaceId, actor: 'agent', clock: fx.deps.clock, ids: fx.deps.ids });
const approve = (fx, actionId) => getAction('approve_drafted_action').run({ ...fx.deps, actor: 'studio' }, { workspaceId: fx.workspaceId, actionId });

for (const shape of ['accounts', 'rule']) {
  test(`[FINDING D175-C2] pin: a ${shape} target drafted by an agent, then the asked leg's code VST-M changes rate: approval refuses vorschlag_stale`, () => {
    excuseClaimInvariant();
    const fx = fixture();
    const base = SCENARIOS.book_bank_line(fx);
    assert.equal(base.target.kind, 'rule');
    const input =
      shape === 'rule'
        ? base
        : { ...base, target: /** @type {any} */ (fx.call('compose_entry', { mode: 'expand', bankTxnId: base.bankTxnId, target: base.target })).target };
    const drafted = /** @type {any} */ (enqueueDraftedAction(agentCtx(fx), { actionTool: 'book_bank_line', payload: { ...input, workspaceId: fx.workspaceId } }));
    assert.equal(drafted.ok, true, JSON.stringify(drafted));
    // A content change to the code the asked leg names (its rate), written to the row as any ungoverned writer could.
    const changed = fx.deps.store.db.prepare("UPDATE tax_code SET rate_bp = rate_bp + 100 WHERE workspace_id = ? AND code = 'VST-M'").run(fx.workspaceId).changes;
    assert.ok(changed >= 1);
    const decided = /** @type {any} */ (approve(fx, drafted.actionId));
    assert.equal(decided.error, 'vorschlag_stale', `${shape}: the approval ran on a code the person never saw: ${JSON.stringify(decided).slice(0, 300)}`);
    fx.deps.store.close();
  });
}

// ================================================================================================
// Point 4: generation 15 on a generation-14 book: the append-only triggers still bite afterwards
// ================================================================================================

test('generation 15 on a generation-14 book: after the upgrade the recipe columns are frozen and a D167 row still clears', () => {
  excuseClaimInvariant();
  const dir = mkdtempSync(join(tmpdir(), 'd175-critic-gen15-'));
  const file = join(dir, 'book.db');
  try {
    const t = world({ location: file });
    const l = importLines(t, { statementId: 'G', entries: [{ ref: 'TEL', amountMinor: 8650, cd: 'DBIT', iban: TELCO_IBAN, name: 'Fernmelde Ostschweiz AG' }] }).lines;
    const s = must(setBankStandard(t.ctx, { bankTxnId: l.TEL, accountId: t.acc('6500'), taxCode: 'VST-M', idempotencyKey: 'g1' })).standard;
    const acc6570 = t.acc('6570');
    t.store.close();
    const raw = new Database(file);
    raw.exec('DROP INDEX bank_standard_one_live_rule');
    raw.exec('DROP TRIGGER bank_standard_recipe_frozen');
    raw.exec('DROP TRIGGER bank_line_decision_rule_frozen');
    raw.exec('ALTER TABLE bank_line_decision DROP COLUMN rule_id');
    for (const col of ['label', 'match_text', 'legs_json', 'via_account_id']) raw.exec(`ALTER TABLE bank_standard DROP COLUMN ${col}`);
    raw.exec('CREATE UNIQUE INDEX bank_standard_one_live ON bank_standard (workspace_id, counterparty_key, direction) WHERE superseded_at IS NULL');
    raw.pragma('user_version = 14');
    raw.close();

    const store = new SqliteStore({ location: file });
    const db = store.db;
    for (const [col, value] of [['legs_json', '[]'], ['via_account_id', 'x'], ['match_text', 'x'], ['label', 'x']]) {
      assert.throws(
        () => db.prepare(`UPDATE bank_standard SET superseded_at = '2026-07-21T00:00:00.000Z', superseded_by = 'u', ${col} = ? WHERE id = ?`).run(value, s.id),
        /only the supersession stamp/,
        `${col} frozen on the upgraded book`,
      );
    }
    assert.throws(() => db.prepare('DELETE FROM bank_standard WHERE id = ?').run(s.id), /never deleted/);
    // A second rule with a text beside the D167 row is possible now (the narrow index is gone).
    const ctx = makeContext(store, { workspaceId: t.workspaceId, actor: 'user_1', clock: t.ctx.clock, ids: t.ctx.ids });
    must(setBankStandard(ctx, { bankTxnId: l.TEL, accountId: acc6570, taxCode: null, matchText: 'roaming', idempotencyKey: 'g2' }));
    assert.equal(must(clearBankStandard(ctx, { standardId: s.id, idempotencyKey: 'g3' })).cleared, true, 'the D167 row still clears');
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ================================================================================================
// Point 2: asks validation through the registry verb (the MCP and REST face) equals the engine's
// ================================================================================================

test('asks validation is the same through the registry verb: rest-leg key, beyond the recipe, string, float, null, negative', () => {
  const t = rulesWorld();
  const l = importLines(t, { statementId: 'AS', entries: [{ ref: 'P1', amountMinor: 3000, cd: 'CRDT', name: PAYOUT, ustrd: 'MUSTERSHOP 1' }] }).lines;
  const rule = must(
    setBankStandard(t.ctx, {
      bankTxnId: l.P1,
      legs: [
        { accountId: t.acc('3400'), taxCode: 'UST81', amount: { kind: 'ask', label: 'Bruttoumsatz' } },
        { accountId: t.acc('4400'), taxCode: null, amount: { kind: 'rest' } },
      ],
      viaAccountId: t.acc('1095'),
      idempotencyKey: 'as-set',
    }),
  ).standard;
  const deps = { store: t.store, clock: t.ctx.clock, ids: t.ctx.ids, actor: 'user_1' };
  const cases = [
    [{ 1: 100 }, 'invalid_input'],
    [{ 0: 21620, 5: 1 }, 'invalid_input'],
    [{ 0: '21620' }, 'invalid_input'],
    [{ 0: 216.2 }, 'invalid_input'],
    [{ 0: null }, 'ask_missing'],
    [{ 0: -1 }, 'ask_missing'],
    [{ '00': 21620 }, 'invalid_input'],
  ];
  for (const [i, [asks, code]] of cases.entries()) {
    const target = { kind: 'rule', standardId: rule.id, asks };
    const engine = bookBankLine(t.ctx, { bankTxnId: l.P1, target, idempotencyKey: `as-e-${i}` });
    const verb = getAction('book_bank_line').run(deps, { workspaceId: t.workspaceId, bankTxnId: l.P1, target, idempotencyKey: `as-v-${i}` });
    assert.equal(engine.ok, false, `case ${i} engine`);
    assert.equal(engine.error, code, `case ${i} engine: ${JSON.stringify(engine)}`);
    assert.equal(verb.error, code, `case ${i} verb: ${JSON.stringify(verb)}`);
  }
  assert.equal(lineOf(t, l.P1).state, 'open', 'nothing booked');
});
