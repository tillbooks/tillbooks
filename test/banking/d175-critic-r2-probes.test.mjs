// D175 non-author critic probes, round 2 (critic/d175-r2-2026-10-15, on claude/d175-integration 42eddc10).
// Synthetic data only: invented names and amounts, the published sample IBANs of bank-inbox-support.mjs.
// A test marked [FINDING R2-...] FAILS on 42eddc10 by design: it states what the critic expects.
//
// The REAL-BUILD migration test at the bottom opens a book written by an older build (generation 11 at
// dd1df7b2, the owner's live line; generation 14 at develop 28650c69). It runs only when those builds sit
// under .tmp-support/gen11 and .tmp-support/gen14 (`git worktree add --detach .tmp-support/gen11 dd1df7b2`,
// then `npx tsc -p tsconfig.json` inside), and is skipped otherwise.

import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { listBankInbox, bookBankLine, setBankStandard, clearBankStandard, listBankStandards, reopenBankLine } from '../../dist/core/banking/index.js';
import { createAccount } from '../../dist/core/accounts/accounts.js';
import { createBackup, restoreBackup } from '../../dist/core/data/portability.js';
import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { SCHEMA_GENERATION } from '../../dist/core/store/schema.js';
import { makeContext } from '../../dist/core/context.js';
import { systemIdGen } from '../../dist/core/ids.js';
import { world, importLines, must, refused, excuseClaimInvariant, assertClaimInvariantHolds, TELCO_IBAN } from './bank-inbox-support.mjs';

afterEach(assertClaimInvariantHolds);

const PAYOUT = 'Zahlwerk Beispiel Ltd';
const lineOf = (ctx, id) => must(listBankInbox(ctx, { status: 'all' }), 'inbox').lines.find((l) => l.bankTxnId === id);

function rulesWorld(opts = {}) {
  const t = world(opts);
  must(createAccount(t.ctx, { number: '1095', name: 'Erlös Durchlaufkonto', type: 'asset', idempotencyKey: 'acc-1095' }), '1095');
  return t;
}

const shopRecipe = (t) => [
  { accountId: t.acc('3400'), taxCode: 'UST81', amount: { kind: 'ask', label: 'Bruttoumsatz' } },
  { accountId: t.acc('4400'), taxCode: null, amount: { kind: 'rest' } },
];

// ================================================================================================
// G04: a restored copy keeps its Buchungsregeln working, and rule_id points into the copy
// ================================================================================================

test('G04 restore: after a restore a recipe rule still names the COPY\'s accounts and stays valid; a decision\'s rule_id names the copy\'s rule', () => {
  excuseClaimInvariant();
  const dir = mkdtempSync(join(tmpdir(), 'd175-r2-restore-'));
  try {
    const t = rulesWorld();
    const l = importLines(t, {
      statementId: 'R1',
      entries: [
        { ref: 'P1', amountMinor: 3000, cd: 'CRDT', name: PAYOUT, ustrd: 'MUSTERSHOP 1' },
        { ref: 'P2', amountMinor: 4000, cd: 'CRDT', name: PAYOUT, ustrd: 'MUSTERSHOP 2' },
      ],
    }).lines;
    const rule = must(setBankStandard(t.ctx, { bankTxnId: l.P1, legs: shopRecipe(t), viaAccountId: t.acc('1095'), label: 'Shop', idempotencyKey: 'r-set' })).standard;
    must(bookBankLine(t.ctx, { bankTxnId: l.P1, target: { kind: 'rule', standardId: rule.id, asks: { 0: 21620 } }, idempotencyKey: 'r-book' }));

    const deps = { store: t.store, clock: t.clock, ids: t.ids, actor: 'user_1', backupDir: join(dir, 'b') };
    const backup = must(createBackup(deps, { workspaceId: t.workspaceId, idempotencyKey: 'bk' }));
    const restored = must(restoreBackup(deps, { source: backup.artifactRef, newWorkspaceName: 'Kopie AG', confirmed: true }));
    const ws = restored.workspaceId;
    const ctx2 = makeContext(t.store, { workspaceId: ws, actor: 'user_1', clock: t.clock, ids: systemIdGen });
    const db = t.store.db;

    // The decision's rule_id must name a bank_standard row of the COPY, never the original's.
    const decision = db.prepare('SELECT rule_id FROM bank_line_decision WHERE workspace_id = ? AND rule_id IS NOT NULL').get(ws);
    assert.ok(decision !== undefined, 'the copy keeps which rule booked the line');
    const owner = db.prepare('SELECT workspace_id FROM bank_standard WHERE id = ?').get(decision.rule_id);
    assert.equal(owner?.workspace_id, ws, `rule_id ${decision.rule_id} must point into the copy, not into ${owner?.workspace_id}`);

    // The copy's rule names the copy's accounts, inside legs_json too, and stays valid.
    const copyRule = must(listBankStandards(ctx2, {})).standards[0];
    const copyAccounts = new Set(db.prepare('SELECT id FROM account WHERE workspace_id = ?').all(ws).map((r) => r.id));
    for (const leg of copyRule.legs) assert.ok(copyAccounts.has(leg.accountId), `leg account ${leg.accountId} is not an account of the copy (legs_json was not re-minted)`);
    assert.equal(copyRule.invalidReason, null, `the restored rule went quiet: ${copyRule.invalidReason}`);
    const p2 = db.prepare("SELECT id FROM bank_txn WHERE workspace_id = ? AND entry_ref = 'P2'").get(ws).id;
    assert.equal(lineOf(ctx2, p2).proposal.reasonCode, 'rule_needs_amount', 'the copy proposes by its rule as the original does');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ================================================================================================
// rule_id: written only for a rule target, frozen, and a decision with it still supersedes (reopen)
// ================================================================================================

test('rule_id: set by a rule target, null for an accounts target, frozen, and reopen still supersedes the decision', () => {
  const t = rulesWorld();
  const l = importLines(t, {
    statementId: 'RID',
    entries: [
      { ref: 'P1', amountMinor: 3000, cd: 'CRDT', name: PAYOUT, ustrd: 'MUSTERSHOP 1' },
      { ref: 'P2', amountMinor: 3000, cd: 'CRDT', name: PAYOUT, ustrd: 'MUSTERSHOP 2' },
    ],
  }).lines;
  const rule = must(setBankStandard(t.ctx, { bankTxnId: l.P1, legs: shopRecipe(t), viaAccountId: t.acc('1095'), idempotencyKey: 'rid-set' })).standard;
  const byRule = must(bookBankLine(t.ctx, { bankTxnId: l.P1, target: { kind: 'rule', standardId: rule.id, asks: { 0: 21620 } }, idempotencyKey: 'rid-1' }));
  const composed = { kind: 'accounts', legs: [{ accountId: t.acc('3400'), amountMinor: 21620, taxCode: 'UST81' }, { accountId: t.acc('4400'), amountMinor: 3000 - 21620 }], viaAccountId: t.acc('1095') };
  must(bookBankLine(t.ctx, { bankTxnId: l.P2, target: composed, idempotencyKey: 'rid-2' }));
  const db = t.store.db;
  const dec = (id) => db.prepare('SELECT link_id, rule_id, superseded_at FROM bank_line_decision WHERE workspace_id = ? AND bank_txn_id = ? ORDER BY rowid').all(t.workspaceId, id);
  assert.equal(dec(l.P1)[0].rule_id, rule.id);
  assert.equal(dec(l.P2)[0].rule_id, null, 'the same booking typed by hand names no rule');
  assert.throws(() => db.prepare('UPDATE bank_line_decision SET rule_id = NULL WHERE link_id = ?').run(dec(l.P1)[0].link_id), /only the supersession stamp/);
  assert.throws(
    () => db.prepare("UPDATE bank_line_decision SET superseded_at = '2026-07-21', superseded_by = 'u', rule_id = 'x' WHERE link_id = ?").run(dec(l.P1)[0].link_id),
    /only the supersession stamp/,
  );
  must(reopenBankLine(t.ctx, { bankTxnId: l.P1, reason: 'Probe', idempotencyKey: 'rid-reopen' }), 'reopen');
  const after = dec(l.P1);
  assert.notEqual(after[0].superseded_at, null, 'the stamp is still writable on a row that carries a rule_id');
  assert.equal(after[0].rule_id, rule.id, 'and the rule_id survives the stamp');
  assert.ok(byRule.entryId);
});

// ================================================================================================
// Token matching edges (C4 fix)
// ================================================================================================

function tokenWorld(texts) {
  const t = rulesWorld();
  const entries = [{ ref: 'SEED', amountMinor: 1000, cd: 'CRDT', name: PAYOUT, ustrd: 'SEED' }, ...texts.map((ustrd, i) => ({ ref: `L${i}`, amountMinor: 2000 + i, cd: 'CRDT', name: PAYOUT, ustrd }))];
  const l = importLines(t, { statementId: `TOK-${texts.length}-${texts[0]?.length ?? 0}`, entries }).lines;
  return { t, l };
}

test('token match: start, end, whole text, multi-token across punctuation, umlaut folding, never inside a word', () => {
  const texts = ['SHOP 4711', 'Auszahlung SHOP', 'SHOP', 'Muster-Shop AG', 'WORKSHOP 7', 'SHOPS 8', 'Gebühr Shop', 'shop.'];
  const { t, l } = tokenWorld(texts);
  const r = must(setBankStandard(t.ctx, { bankTxnId: l.SEED, accountId: t.acc('3400'), taxCode: null, matchText: 'Shop', idempotencyKey: 'tok' })).standard;
  const hit = (i) => lineOf(t.ctx, l[`L${i}`]).proposal.reasonParams?.standardId === r.id;
  assert.deepEqual(texts.map((_, i) => hit(i)), [true, true, true, true, false, false, true, true]);
});

test('token match: a multi-token text needs the tokens consecutive and in order', () => {
  const texts = ['MUSTER SHOP 1', 'SHOP MUSTER 2', 'MUSTER X SHOP 3', 'muster/shop', 'MUSTERSHOP'];
  const { t, l } = tokenWorld(texts);
  const r = must(setBankStandard(t.ctx, { bankTxnId: l.SEED, accountId: t.acc('3400'), taxCode: null, matchText: 'Muster Shop', idempotencyKey: 'tok2' })).standard;
  const hit = (i) => lineOf(t.ctx, l[`L${i}`]).proposal.reasonParams?.standardId === r.id;
  assert.deepEqual(texts.map((_, i) => hit(i)), [true, false, false, true, false]);
});

test('token match: a text of punctuation only is refused; a text differing only in punctuation is the SAME slot as its token form', () => {
  const { t, l } = tokenWorld(['MUSTER SHOP 1']);
  refused(setBankStandard(t.ctx, { bankTxnId: l.SEED, accountId: t.acc('3400'), taxCode: null, matchText: '--!', idempotencyKey: 'p0' }), 'invalid_input');
  const a = must(setBankStandard(t.ctx, { bankTxnId: l.SEED, accountId: t.acc('3400'), taxCode: null, matchText: 'muster shop', idempotencyKey: 'p1' }));
  const b = must(setBankStandard(t.ctx, { bankTxnId: l.SEED, accountId: t.acc('3200'), taxCode: null, matchText: 'Muster-Shop!', idempotencyKey: 'p2' }));
  // [FINDING R2-2] both texts match exactly the same lines, so they must be one slot: the second supersedes.
  assert.equal(b.supersededId, a.standard.id, `"Muster-Shop!" is stored as ${JSON.stringify(b.standard.matchText)}, a second live rule beside "muster shop" for the same lines`);
});

test('[FINDING R2-3] token match: a transliterated umlaut in the bank text matches the rule written with the umlaut', () => {
  // Swiss camt remittance is often transliterated (the two letters U and E for Ü). foldText strips the
  // diaeresis ("gebuhr"), so the bank's transliterated spelling never matches a rule saved as "Gebühr".
  // The bank text is assembled from parts on purpose: it IS the ASCII spelling under test, and the umlaut
  // guard (test/style/umlaut-transliteration.test.mjs) rightly refuses that spelling as a literal.
  const bankSpelling = ['GEB', 'U', 'EHR'].join('');
  const { t, l } = tokenWorld([`${bankSpelling} JULI`]);
  const r = must(setBankStandard(t.ctx, { bankTxnId: l.SEED, accountId: t.acc('3400'), taxCode: null, matchText: 'Gebühr', idempotencyKey: 'um' })).standard;
  assert.equal(lineOf(t.ctx, l.L0).proposal.reasonParams?.standardId, r.id);
});

// ================================================================================================
// C1 fix: validity is asked after the text; two matching rules, one invalid
// ================================================================================================

test('C1 fix edges: two text rules match, one valid one not: silent; the text-less rule invalid and no text matches: silent', () => {
  const t = rulesWorld();
  const l = importLines(t, {
    statementId: 'C1E',
    entries: [
      { ref: 'SEED', amountMinor: 1000, cd: 'CRDT', name: PAYOUT, ustrd: 'SEED' },
      { ref: 'BOTH', amountMinor: 2000, cd: 'CRDT', name: PAYOUT, ustrd: 'MUSTER SHOP' },
      { ref: 'NONE', amountMinor: 2100, cd: 'CRDT', name: PAYOUT, ustrd: 'ANDERES' },
    ],
  }).lines;
  must(createAccount(t.ctx, { number: '3410', name: 'Erlös Probe', type: 'income', idempotencyKey: 'a3410' }));
  must(createAccount(t.ctx, { number: '3420', name: 'Erlös Probe 2', type: 'income', idempotencyKey: 'a3420' }));
  must(setBankStandard(t.ctx, { bankTxnId: l.SEED, accountId: t.acc('3400'), taxCode: null, matchText: 'muster', idempotencyKey: 'e1' }));
  must(setBankStandard(t.ctx, { bankTxnId: l.SEED, accountId: t.acc('3410'), taxCode: null, matchText: 'shop', idempotencyKey: 'e2' }));
  must(setBankStandard(t.ctx, { bankTxnId: l.SEED, accountId: t.acc('3420'), taxCode: null, idempotencyKey: 'e3' }));
  assert.equal(lineOf(t.ctx, l.BOTH).proposal.reasonCode, 'several_rules');
  t.store.db.prepare('UPDATE account SET archived = 1 WHERE workspace_id = ? AND number = ?').run(t.workspaceId, '3410');
  const both = lineOf(t.ctx, l.BOTH).proposal;
  assert.ok(!(both.certainty === 'sure'), `one matching rule invalid: ${JSON.stringify(both)}`);
  t.store.db.prepare('UPDATE account SET archived = 1 WHERE workspace_id = ? AND number = ?').run(t.workspaceId, '3420');
  const none = lineOf(t.ctx, l.NONE).proposal;
  assert.ok(!['standard', 'several_rules', 'rule_needs_amount'].includes(none.reasonCode) || none.certainty !== 'sure', JSON.stringify(none));
});

// ================================================================================================
// Real older builds: generation 11 (the owner's line) and generation 14 open on generation 15
// ================================================================================================

const ROOT = resolve(import.meta.dirname, '../..');
for (const [gen, dirName] of [
  [11, 'gen11'],
  [14, 'gen14'],
]) {
  const oldRoot = join(ROOT, '.tmp-support', dirName);
  test(`a book written by the REAL generation-${gen} build opens on generation ${SCHEMA_GENERATION}: rows intact, rules and rule_id work, the triggers bite`, { skip: !existsSync(join(oldRoot, 'dist')) && `no ${dirName} build` }, async () => {
    excuseClaimInvariant();
    const dir = mkdtempSync(join(tmpdir(), `d175-r2-${dirName}-`));
    const file = join(dir, 'book.db');
    try {
      const old = await import(join(oldRoot, 'test/banking/bank-inbox-support.mjs'));
      const oldBanking = await import(join(oldRoot, 'dist/core/banking/index.js'));
      const o = old.world({ location: file });
      const ol = old.importLines(o, {
        statementId: `OLD-${gen}`,
        entries: [
          { ref: 'TEL', amountMinor: 8650, cd: 'DBIT', iban: TELCO_IBAN, name: 'Fernmelde Ostschweiz AG' },
          { ref: 'TEL2', amountMinor: 4320, cd: 'DBIT', iban: TELCO_IBAN, name: 'Fernmelde Ostschweiz AG' },
          { ref: 'P1', amountMinor: 3000, cd: 'CRDT', name: PAYOUT, ustrd: 'MUSTERSHOP 1' },
          { ref: 'P2', amountMinor: 3100, cd: 'CRDT', name: PAYOUT, ustrd: 'MUSTERSHOP 2' },
        ],
      }).lines;
      const std = old.must(oldBanking.setBankStandard(o.ctx, { bankTxnId: ol.TEL, accountId: o.acc('6500'), taxCode: 'VST-M', idempotencyKey: 'old-std' })).standard;
      old.must(oldBanking.bookBankLine(o.ctx, { bankTxnId: ol.TEL, target: { kind: 'accounts', legs: [{ accountId: o.acc('6500'), amountMinor: 8650, taxCode: 'VST-M' }] }, idempotencyKey: 'old-book' }));
      const acc = (n) => o.acc(n);
      const ids = { a6570: acc('6570'), a3400: acc('3400'), a4400: acc('4400'), a6500: acc('6500') };
      const before = {
        standards: o.store.db.prepare('SELECT * FROM bank_standard ORDER BY rowid').all(),
        decisions: o.store.db.prepare('SELECT * FROM bank_line_decision ORDER BY rowid').all(),
        lines: o.store.db.prepare('SELECT COUNT(*) AS n FROM journal_line').get().n,
      };
      const ws = o.workspaceId;
      o.store.close();

      const store = new SqliteStore({ location: file });
      const db = store.db;
      assert.equal(db.pragma('user_version', { simple: true }), SCHEMA_GENERATION);
      const strip = (rows, cols) => rows.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !cols.includes(k))));
      assert.deepEqual(strip(db.prepare('SELECT * FROM bank_standard ORDER BY rowid').all(), ['label', 'match_text', 'legs_json', 'via_account_id']), before.standards);
      assert.deepEqual(strip(db.prepare('SELECT * FROM bank_line_decision ORDER BY rowid').all(), ['rule_id']), before.decisions);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM journal_line').get().n, before.lines);
      const ctx = makeContext(store, { workspaceId: ws, actor: 'user_1', clock: o.clock, ids: systemIdGen });
      // The old standard still proposes, sure, as before.
      const p = must(listBankInbox(ctx, { status: 'all' })).lines.find((x) => x.bankTxnId === ol.TEL2).proposal;
      assert.deepEqual([p.reasonCode, p.certainty, p.reasonParams.standardId], ['standard', 'sure', std.id]);
      // A recipe rule beside it, booked by rule: rule_id written; frozen; the old decision reopens.
      must(createAccount(ctx, { number: '1095', name: 'Erlös Durchlaufkonto', type: 'asset', idempotencyKey: 'n-1095' }));
      const via = db.prepare("SELECT id FROM account WHERE workspace_id = ? AND number = '1095'").get(ws).id;
      const legs = [
        { accountId: ids.a3400, taxCode: 'UST81', amount: { kind: 'ask', label: 'Bruttoumsatz' } },
        { accountId: ids.a4400, taxCode: null, amount: { kind: 'rest' } },
      ];
      const rule = must(setBankStandard(ctx, { bankTxnId: ol.P1, legs, viaAccountId: via, matchText: 'mustershop', idempotencyKey: 'n-rule' })).standard;
      must(bookBankLine(ctx, { bankTxnId: ol.P1, target: { kind: 'rule', standardId: rule.id, asks: { 0: 21620 } }, idempotencyKey: 'n-book' }));
      const d = db.prepare('SELECT link_id, rule_id FROM bank_line_decision WHERE workspace_id = ? AND bank_txn_id = ?').get(ws, ol.P1);
      assert.equal(d.rule_id, rule.id);
      assert.throws(() => db.prepare('UPDATE bank_line_decision SET rule_id = NULL WHERE link_id = ?').run(d.link_id), /only the supersession stamp/);
      assert.throws(() => db.prepare("UPDATE bank_standard SET superseded_at = 'x', superseded_by = 'u', legs_json = '[]' WHERE id = ?").run(rule.id), /only the supersession stamp/);
      must(reopenBankLine(ctx, { bankTxnId: ol.TEL, reason: 'Probe', idempotencyKey: 'n-reopen' }), 'an old decision reopens');
      assert.equal(must(clearBankStandard(ctx, { standardId: std.id, idempotencyKey: 'n-clear' })).cleared, true);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
