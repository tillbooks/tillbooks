// A36 §4.7 (D150), before landing: the last known defect of the gap model closed (A1) and the critic's
// round-3 probes committed as tests. Each finding pinned by a test; A1's fails on bd4b12b8, proven by
// re-running it against that commit's files. Synthetic fixtures only (`ebics-support.mjs`).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { setup } from './support.mjs';
import { syntheticIban, camt053, container, mockBank } from './ebics-support.mjs';
import { createBankAccount, statementGaps, confirmStatementGap } from '../../dist/core/banking/index.js';
import { importCamt } from '../../dist/core/banking/camtReconcile.js';
import { connectBankChannel, syncBankChannel, readStatementGaps } from '../../dist/core/banking/ebics/index.js';
import { bankStatementGapProvider } from '../../dist/core/banking/attentionProviders.js';
import { makeContext } from '../../dist/core/context.js';

function must(res, label) {
  assert.equal(res.ok, true, `${label}: ${JSON.stringify(res)}`);
  return res;
}

let seq = 0;
function account(t, n) {
  seq += 1;
  return must(
    createBankAccount(t.ctx, { name: `Konto ${n}`, iban: syntheticIban(n), ledgerAccountId: t.acc('1020'), idempotencyKey: `ba-${n}-${seq}` }),
    'create_bank_account',
  ).bankAccountId;
}

function imp(t, bankAccountId, xml) {
  seq += 1;
  return must(importCamt(t.ctx, { bankAccountId, xml, idempotencyKey: `imp-${seq}` }), 'import');
}

/** The gap answer of an account without its row ids, so two import orders compare. */
function shape(t, id) {
  return statementGaps(t.ctx, { bankAccountId: id }).map((g) => ({
    after: g.after.number,
    before: g.before.number,
    missing: g.missing,
    chains: g.chains,
    confirmable: g.confirmable,
    incomplete: g.after.incomplete === true || g.before.incomplete === true,
    conflicting: g.after.conflicting === true || g.before.conflicting === true,
  }));
}

/**
 * Statement 5 as a whole copy AND as a complete two-page split, around 4 and 6, imported with the copy
 * first or the pages first. Eight filler statements on another account first, so the rows at 5 take the
 * ids bstmt_9 to bstmt_11: string order (bstmt_10 < bstmt_9) and number order disagree.
 */
function copyAndSplit(order) {
  const t = setup();
  const filler = account(t, 90);
  for (let k = 1; k <= 6; k += 1) imp(t, filler, camt053({ iban: syntheticIban(90), seq: k, date: `2026-03-0${k}`, opening: 0 }));
  const id = account(t, 91);
  const iban = syntheticIban(91);
  imp(t, id, camt053({ iban, seq: 4, date: '2026-06-04', opening: 1000 }));
  imp(t, id, camt053({ iban, seq: 6, date: '2026-06-06', opening: 1500 }));
  const copy = () => imp(t, id, camt053({ iban, seq: 5, date: '2026-06-05', opening: 1000, entries: [{ minor: 500 }], stmtId: 'C5', msgId: 'MSG-C5' }));
  const pages = () => {
    imp(t, id, camt053({ iban, seq: 5, date: '2026-06-05', opening: 1000, entries: [{ minor: 200 }], stmtId: 'S5', msgId: 'MSG-S5', page: { number: 1, last: false } }));
    imp(t, id, camt053({ iban, seq: 5, date: '2026-06-05', opening: 1200, entries: [{ minor: 300 }], stmtId: 'S5', msgId: 'MSG-S5', page: { number: 2, last: true } }));
  };
  if (order === 'copy-first') {
    copy();
    pages();
  } else {
    pages();
    copy();
  }
  const ids = t.store.db
    .prepare("SELECT id FROM bank_statement WHERE workspace_id = ? AND bank_account_id = ? AND electronic_seq_nb = '5'")
    .all(t.workspaceId, id)
    .map((r) => r.id)
    .sort();
  return { t, id, ids };
}

test('A1: a whole copy plus a complete split of one statement give the same answer in either import order', () => {
  const a = copyAndSplit('copy-first');
  const b = copyAndSplit('pages-first');
  assert.deepEqual(a.ids, ['bstmt_10', 'bstmt_11', 'bstmt_9'], 'the ids cross bstmt_9 / bstmt_10');
  assert.deepEqual(b.ids, ['bstmt_10', 'bstmt_11', 'bstmt_9']);
  assert.deepEqual(shape(a.t, a.id), [], 'copy first: 5 is present and complete');
  assert.deepEqual(shape(b.t, b.id), [], 'pages first: the same answer');
});

test('A1: a complete split and a whole copy that disagree are a conflict in either order, never incomplete', () => {
  for (const order of ['copy-first', 'pages-first']) {
    const t = setup();
    const id = account(t, 92);
    const iban = syntheticIban(92);
    imp(t, id, camt053({ iban, seq: 4, date: '2026-06-04', opening: 1000 }));
    imp(t, id, camt053({ iban, seq: 6, date: '2026-06-06', opening: 1500 }));
    const copy = () => imp(t, id, camt053({ iban, seq: 5, date: '2026-06-05', opening: 1000, entries: [{ minor: 900 }], stmtId: 'C5', msgId: 'MSG-C5' }));
    const pages = () => {
      imp(t, id, camt053({ iban, seq: 5, date: '2026-06-05', opening: 1000, entries: [{ minor: 200 }], stmtId: 'S5', msgId: 'MSG-S5', page: { number: 1, last: false } }));
      imp(t, id, camt053({ iban, seq: 5, date: '2026-06-05', opening: 1200, entries: [{ minor: 300 }], stmtId: 'S5', msgId: 'MSG-S5', page: { number: 2, last: true } }));
    };
    if (order === 'copy-first') {
      copy();
      pages();
    } else {
      pages();
      copy();
    }
    assert.deepEqual(shape(t, id), [{ after: 5, before: 6, missing: [], chains: false, confirmable: false, incomplete: false, conflicting: true }], order);
  }
});

// --- the critic's round-3 probes, committed --------------------------------------------------------

test('probe: three equal copies are one statement; a differing fourth copy is a conflict item with no confirm', () => {
  const t = setup();
  const id = account(t, 93);
  const iban = syntheticIban(93);
  imp(t, id, camt053({ iban, seq: 4, date: '2026-06-04', opening: 1000 }));
  for (const k of ['A', 'B', 'C']) imp(t, id, camt053({ iban, seq: 5, date: '2026-06-05', opening: 1000, stmtId: `${k}5`, msgId: `MSG-${k}5`, copy: k !== 'A' }));
  imp(t, id, camt053({ iban, seq: 6, date: '2026-06-06', opening: 1000 }));
  assert.deepEqual(shape(t, id), [], 'three equal copies: one statement, no gap');
  imp(t, id, camt053({ iban, seq: 5, date: '2026-06-05', opening: 1000, closing: 1400, stmtId: 'D5', msgId: 'MSG-D5', copy: true }));
  assert.deepEqual(shape(t, id), [{ after: 5, before: 6, missing: [], chains: false, confirmable: false, incomplete: false, conflicting: true }]);
  const [item] = bankStatementGapProvider.list(t.ctx, { limit: 5 });
  assert.equal(item.titleKey, 'attention.item.bankStatementGap.titleConflicting');
  assert.deepEqual(item.decisionOptions.map((o) => o.id), ['open']);
});

test('probe: an incomplete and a conflicting statement each yield exactly one item, as the newest and as the only one', () => {
  const t = setup();
  const cases = [];
  // Incomplete, as the newest.
  const a = account(t, 94);
  imp(t, a, camt053({ iban: syntheticIban(94), seq: 7, date: '2026-06-07', opening: 1000 }));
  imp(t, a, camt053({ iban: syntheticIban(94), seq: 8, date: '2026-06-08', opening: 1000, page: { number: 1, last: false } }));
  cases.push([a, 'incomplete']);
  // Incomplete, as the only one.
  const b = account(t, 95);
  imp(t, b, camt053({ iban: syntheticIban(95), seq: 8, date: '2026-06-08', opening: 1000, page: { number: 1, last: false } }));
  cases.push([b, 'incomplete']);
  // Conflicting, as the newest.
  const c = account(t, 96);
  imp(t, c, camt053({ iban: syntheticIban(96), seq: 7, date: '2026-06-07', opening: 1000 }));
  imp(t, c, camt053({ iban: syntheticIban(96), seq: 8, date: '2026-06-08', opening: 1000, stmtId: 'A8', msgId: 'MSG-A8' }));
  imp(t, c, camt053({ iban: syntheticIban(96), seq: 8, date: '2026-06-08', opening: 1000, closing: 2000, stmtId: 'B8', msgId: 'MSG-B8', copy: true }));
  cases.push([c, 'conflicting']);
  // Conflicting, as the only one.
  const d = account(t, 97);
  imp(t, d, camt053({ iban: syntheticIban(97), seq: 8, date: '2026-06-08', opening: 1000, stmtId: 'A8', msgId: 'MSG-A8' }));
  imp(t, d, camt053({ iban: syntheticIban(97), seq: 8, date: '2026-06-08', opening: 1000, closing: 2000, stmtId: 'B8', msgId: 'MSG-B8', copy: true }));
  cases.push([d, 'conflicting']);
  for (const [id, kind] of cases) {
    const s = shape(t, id);
    assert.equal(s.length, 1, `${kind} ${id}: one item`);
    assert.equal(s[0][kind], true, `${kind} ${id}`);
    assert.equal(s[0].confirmable, false);
  }
  assert.equal(bankStatementGapProvider.count(t.ctx), 4);
});

test("probe: two accounts on one connection: B's refused 184 does not block A's confirm, and B stays unconfirmable", () => {
  const t = setup();
  const a = account(t, 98);
  const b = account(t, 99);
  const bank = mockBank();
  const ctx = makeContext(t.store, { workspaceId: t.workspaceId, actor: 'user_1', clock: t.clock, ids: t.ids, ebicsTransport: bank.port });
  const conn = must(connectBankChannel(ctx, { host: { url: 'https://ebics.example/ebicsweb', hostId: 'SYNTHHST', partnerId: 'PARTNERTWO', userId: 'USERTWO' }, routeBankAccountIds: [a, b], confirm: true, idempotencyKey: 'two-c' }), 'connect');
  const fetched = must(connectBankChannel(ctx, { connectionId: conn.connectionId, confirm: true }), 'fetch');
  must(connectBankChannel(ctx, { connectionId: conn.connectionId, confirm: true, confirmBankKeys: true, expectedBankKeyHashes: fetched.bankKeyHashes }), 'keys');
  const ends = {};
  for (const [id, n] of [[a, 98], [b, 99]]) {
    ends[id] = [imp(t, id, camt053({ iban: syntheticIban(n), seq: 182, date: '2026-09-22', opening: 40000 })), imp(t, id, camt053({ iban: syntheticIban(n), seq: 187, date: '2026-09-29', opening: 40000 }))];
  }
  // ZKB delivers a 184 for B only, which does not chain.
  bank.offer(container([camt053({ iban: syntheticIban(99), seq: 184, date: '2026-09-24', opening: 40300 })]));
  must(syncBankChannel(ctx, { connectionId: conn.connectionId, idempotencyKey: 'two-press' }), 'press');
  const byAccount = Object.fromEntries(readStatementGaps(ctx).map((g) => [g.bankAccountId, g]));
  assert.deepEqual([byAccount[a].confirmable, byAccount[b].confirmable], [true, false]);
  const input = (id) => ({ bankAccountId: id, afterStatementId: ends[id][0].statementId, beforeStatementId: ends[id][1].statementId, reason: 'leer', confirmed: true });
  must(confirmStatementGap(ctx, { ...input(a), idempotencyKey: 'two-a' }), "A's confirm");
  assert.equal(confirmStatementGap(ctx, { ...input(b), idempotencyKey: 'two-b' }).error, 'gap_has_waiting_statement');
  assert.deepEqual(readStatementGaps(ctx).map((g) => g.bankAccountId), [b], 'A is closed, B stays open');
});
