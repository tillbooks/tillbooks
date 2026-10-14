// A36 §4.7 (D150), the non-author critic round 2 on the statement gaps: each finding pinned by a test
// that FAILS on 903cde65 (proven by re-running it against that commit's files). Synthetic fixtures
// only (`ebics-support.mjs`). Money-path invariant tests are reviewed by a non-author (CLAUDE.md).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { setup } from './support.mjs';
import { syntheticIban, camt053 } from './ebics-support.mjs';
import { createBankAccount, statementGaps } from '../../dist/core/banking/index.js';
import { importCamt } from '../../dist/core/banking/camtReconcile.js';
import { bankStatementGapProvider } from '../../dist/core/banking/attentionProviders.js';

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

/** An EBICS-fed account whose channel holds a refused 184 inside the chained gap 182 to 187. */
async function refusedInside(t, n) {
  const { mockBank, container } = await import('./ebics-support.mjs');
  const { connectBankChannel, syncBankChannel } = await import('../../dist/core/banking/ebics/index.js');
  const { makeContext } = await import('../../dist/core/context.js');
  const id = account(t, n);
  const iban = syntheticIban(n);
  const bank = mockBank();
  const ctx = makeContext(t.store, { workspaceId: t.workspaceId, actor: 'user_1', clock: t.clock, ids: t.ids, ebicsTransport: bank.port });
  seq += 1;
  const c = must(connectBankChannel(ctx, { host: { url: 'https://ebics.example/ebicsweb', hostId: 'SYNTHHST', partnerId: `PARTNERR${seq}`, userId: `USERR${seq}` }, routeBankAccountIds: [id], confirm: true, idempotencyKey: `c-${seq}` }), 'connect');
  const fetched = must(connectBankChannel(ctx, { connectionId: c.connectionId, confirm: true }), 'fetch');
  must(connectBankChannel(ctx, { connectionId: c.connectionId, confirm: true, confirmBankKeys: true, expectedBankKeyHashes: fetched.bankKeyHashes }), 'keys');
  const s182 = imp(t, id, camt053({ iban, seq: 182, date: '2026-09-22', opening: 40000 }));
  const s187 = imp(t, id, camt053({ iban, seq: 187, date: '2026-09-29', opening: 40000 }));
  return { id, iban, bank, ctx, connectionId: c.connectionId, s182, s187, deliver: () => {
    bank.offer(container([camt053({ iban, seq: 184, date: '2026-09-24', opening: 40300 })]));
    must(syncBankChannel(ctx, { connectionId: c.connectionId, idempotencyKey: `press-${seq}` }), 'press');
  } };
}

test('round 2 LOW 2: the engine confirmation reads the waiting statements itself; no caller can forget them', async () => {
  const { confirmStatementGap } = await import('../../dist/core/banking/index.js');
  const t = setup();
  const w = await refusedInside(t, 86);
  w.deliver();
  // Called the way a direct embedder would, with no list of waiting statements at all.
  const res = confirmStatementGap(w.ctx, { bankAccountId: w.id, afterStatementId: w.s182.statementId, beforeStatementId: w.s187.statementId, reason: 'leer', confirmed: true, idempotencyKey: 'l2' });
  assert.equal(res.error, 'gap_has_waiting_statement');
  assert.equal(t.store.db.prepare('SELECT COUNT(*) AS n FROM bank_statement_gap_ack WHERE workspace_id = ?').get(t.workspaceId).n, 0);
});

test('round 2 LOW 1: a confirmation a refused statement made void is withdrawable, and the item says it no longer holds', async () => {
  const { confirmStatementGap, revokeStatementGapConfirmation } = await import('../../dist/core/banking/index.js');
  const t = setup();
  const w = await refusedInside(t, 87);
  const input = { bankAccountId: w.id, afterStatementId: w.s182.statementId, beforeStatementId: w.s187.statementId, confirmed: true };
  must(confirmStatementGap(w.ctx, { ...input, reason: 'leer', idempotencyKey: 'v-1' }), 'confirm while nothing waits');
  assert.equal(statementGaps(w.ctx).length, 0);
  // ZKB then delivers 184, which does not chain: the gap is open again and says why.
  w.deliver();
  const { readStatementGaps } = await import('../../dist/core/banking/ebics/index.js');
  const [gap] = readStatementGaps(w.ctx);
  assert.equal(gap.confirmationVoid, true);
  const [item] = bankStatementGapProvider.list(w.ctx, { limit: 5 });
  assert.equal(item.reasonKey, 'attention.item.bankStatementGap.confirmationVoid');
  // The person withdraws the stale confirmation: a revoke row, never notConfirmed.
  const revoked = must(revokeStatementGapConfirmation(w.ctx, { ...input, reason: 'Auszug 184 zeigt Geld', idempotencyKey: 'v-2' }), 'revoke');
  assert.equal(revoked.notConfirmed, undefined);
  assert.equal(typeof revoked.ackId, 'string');
  const rows = t.store.db.prepare('SELECT action FROM bank_statement_gap_ack WHERE workspace_id = ? ORDER BY rowid').all(t.workspaceId).map((r) => r.action);
  assert.deepEqual(rows, ['confirm', 'revoke']);
});

test('round 2 LOW 3: the year-turn grace counts SIC business days, not calendar days', () => {
  const t = setup();
  // Fri 29.12.2023 to Wed 03.01.2024, chained: 30.12 and 31.12 are a weekend, 1.1 and 2.1 holidays.
  const a = account(t, 88);
  imp(t, a, camt053({ iban: syntheticIban(88), seq: 250, date: '2023-12-29', opening: 100 }));
  imp(t, a, camt053({ iban: syntheticIban(88), seq: 1, date: '2024-01-03', opening: 100 }));
  // Thu 30.12.2027 to Mon 03.01.2028, chained: Fri 31.12.2027 is a business day, its statement may be missing.
  const b = account(t, 89);
  imp(t, b, camt053({ iban: syntheticIban(89), seq: 250, date: '2027-12-30', opening: 100 }));
  imp(t, b, camt053({ iban: syntheticIban(89), seq: 1, date: '2028-01-03', opening: 100 }));
  assert.deepEqual(statementGaps(t.ctx, { bankAccountId: a }), [], 'no business day lies between');
  const gb = statementGaps(t.ctx, { bankAccountId: b });
  assert.deepEqual(gb.map((g) => [g.after.number, g.before.number, g.missing, g.oldYearTailUnknown, g.chains]), [[250, 1, [], true, true]]);
});

test('N1: an incomplete split statement between consecutive neighbours always yields an item, never confirmable', () => {
  const t = setup();
  const id = account(t, 81);
  const iban = syntheticIban(81);
  imp(t, id, camt053({ iban, seq: 7, date: '2026-06-07', opening: 1000 }));
  // Only page 1 of a two-page statement 8 is in the books.
  imp(t, id, camt053({ iban, seq: 8, date: '2026-06-08', opening: 1000, entries: [{ minor: 300 }], page: { number: 1, last: false } }));
  imp(t, id, camt053({ iban, seq: 9, date: '2026-06-09', opening: 1700 }));
  const gaps = statementGaps(t.ctx, { bankAccountId: id });
  assert.equal(gaps.length, 1, 'the incomplete 8 is an item');
  const [g] = gaps;
  assert.deepEqual([g.after.number, g.after.incomplete, g.missing, g.chains, g.confirmable, g.unexplained], [8, true, [], false, false, true]);
  const [item] = bankStatementGapProvider.list(t.ctx, { limit: 5 });
  assert.deepEqual([item.titleKey, item.titleParams.incomplete, item.subtitleKey], ['attention.item.bankStatementGap.titleIncomplete', '8/2026', 'attention.item.bankStatementGap.subtitleIncomplete']);
  assert.deepEqual(item.decisionOptions.map((o) => o.id), ['open']);
});

test('N2: two whole copies of one statement (a DUPL under another Stmt/Id) are ONE complete statement', () => {
  const t = setup();
  const id = account(t, 84);
  const iban = syntheticIban(84);
  imp(t, id, camt053({ iban, seq: 4, date: '2026-06-04', opening: 1000 }));
  const s5 = imp(t, id, camt053({ iban, seq: 5, date: '2026-06-05', opening: 1000, entries: [{ minor: 500 }], stmtId: 'A5', msgId: 'MSG-A5' }));
  imp(t, id, camt053({ iban, seq: 5, date: '2026-06-05', opening: 1000, entries: [{ minor: 500 }], stmtId: 'B5', msgId: 'MSG-B5', copy: true }));
  imp(t, id, camt053({ iban, seq: 7, date: '2026-06-07', opening: 1500 }));
  const gaps = statementGaps(t.ctx, { bankAccountId: id });
  assert.deepEqual(
    gaps.map((g) => [g.after.number, g.before.number, g.missing, g.chains, g.confirmable, g.after.incomplete === true]),
    [[5, 7, [{ year: 2026, from: 6, to: 6 }], true, true, false]],
  );
  assert.equal(gaps[0].after.statementRowId, s5.statementId, 'the gap names the first copy');
});

test('N2: copies of one statement with DIFFERENT balances are named a conflict, never incomplete, never confirmable', () => {
  const t = setup();
  const id = account(t, 85);
  const iban = syntheticIban(85);
  imp(t, id, camt053({ iban, seq: 4, date: '2026-06-04', opening: 1000 }));
  imp(t, id, camt053({ iban, seq: 5, date: '2026-06-05', opening: 1000, stmtId: 'A5', msgId: 'MSG-A5' }));
  imp(t, id, camt053({ iban, seq: 5, date: '2026-06-05', opening: 1000, closing: 1900, stmtId: 'B5', msgId: 'MSG-B5', copy: true }));
  imp(t, id, camt053({ iban, seq: 6, date: '2026-06-06', opening: 1000 }));
  const gaps = statementGaps(t.ctx, { bankAccountId: id });
  assert.deepEqual(gaps.map((g) => [g.after.number, g.after.conflicting === true, g.after.incomplete === true, g.confirmable]), [[5, true, false, false]]);
  const [item] = bankStatementGapProvider.list(t.ctx, { limit: 5 });
  assert.deepEqual([item.titleKey, item.subtitleKey], ['attention.item.bankStatementGap.titleConflicting', 'attention.item.bankStatementGap.subtitleConflicting']);
});

test('N1: an incomplete statement that is the newest, or the only one, still yields its item', () => {
  const t = setup();
  const newest = account(t, 82);
  imp(t, newest, camt053({ iban: syntheticIban(82), seq: 7, date: '2026-06-07', opening: 1000 }));
  imp(t, newest, camt053({ iban: syntheticIban(82), seq: 8, date: '2026-06-08', opening: 1000, page: { number: 1, last: false } }));
  const only = account(t, 83);
  imp(t, only, camt053({ iban: syntheticIban(83), seq: 8, date: '2026-06-08', opening: 1000, page: { number: 1, last: false } }));
  const byAccount = (id) => statementGaps(t.ctx, { bankAccountId: id }).map((g) => [g.before.number, g.before.incomplete === true || g.after.incomplete === true, g.confirmable]);
  assert.deepEqual(byAccount(newest), [[8, true, false]]);
  assert.deepEqual(byAccount(only), [[8, true, false]]);
});
