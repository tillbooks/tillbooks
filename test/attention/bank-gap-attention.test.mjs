// D150 (A36 §4.7), the bank's three attention queues: what the Übersicht said nothing about on
// 01.10.2026. A statement gap is an item until it is filled or (only when it chains) confirmed; the bank
// lines that need a person are counted once (a line a pending Vorschlag names stays in `agent_action`);
// a failed automatic fetch that waits for a person is an item until a later fetch succeeds. True counts,
// read rights per queue, never another workspace.
//
// All fixtures synthetic (`test/banking/ebics-support.mjs`).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { syntheticIban, camt053, mockBank } from '../banking/ebics-support.mjs';
import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { sequenceIdGen } from '../../dist/core/ids.js';
import { makeContext } from '../../dist/core/context.js';
import { createWorkspace } from '../../dist/core/setup/index.js';
import { createBankAccount, bankInboxAttention, confirmStatementGap } from '../../dist/core/banking/index.js';
import { importCamt } from '../../dist/core/banking/camtReconcile.js';
import { connectBankChannel, recordAutoSyncAttempt } from '../../dist/core/banking/ebics/index.js';
import { attentionSummary, attentionList, ATTENTION_PROVIDERS, assertProvidersRegistrable } from '../../dist/core/attention/index.js';
import { bankFetchFailedProvider, bankLinesWaitingProvider, bankStatementGapProvider, missingRangeText } from '../../dist/core/banking/attentionProviders.js';
import { ok, err } from '../../dist/core/result.js';

function must(res, label) {
  assert.equal(res.ok, true, `${label}: ${JSON.stringify(res)}`);
  return res;
}

let n = 0;
function world({ capabilities } = {}) {
  n += 1;
  const clock = { current: '2026-10-01T08:00:00.000Z', now() { return this.current; } };
  const ids = sequenceIdGen();
  const store = new SqliteStore({ clock });
  const workspaceId = must(createWorkspace({ store, clock, ids }, { name: `Synthetische Lücken ${n} AG` }), 'workspace').workspaceId;
  const bank = mockBank();
  const ctx = makeContext(store, { workspaceId, actor: 'user_1', clock, ids, ebicsTransport: bank.port });
  const ledger = store.db.prepare("SELECT id FROM account WHERE workspace_id = ? AND number = '1020'").get(workspaceId).id;
  const iban = syntheticIban(7700 + n);
  const accountId = must(createBankAccount(ctx, { name: 'ZKB Geschäftskonto', iban, ledgerAccountId: ledger, idempotencyKey: `ba-${n}` }), 'account').bankAccountId;
  const as = (caps) => makeContext(store, { workspaceId, actor: 'user_1', clock, ids, capabilities: caps });
  return { clock, ids, store, workspaceId, bank, ctx, iban, accountId, as, ledger, capabilities };
}

let k = 0;
function imp(w, xml) {
  k += 1;
  return must(importCamt(w.ctx, { bankAccountId: w.accountId, xml, idempotencyKey: `imp-${k}` }), 'import');
}

function queue(summary, id) {
  return summary.queues.find((q) => q.queueId === id);
}

const denyOnly = (denied) => ({ assert: (c) => (c === denied ? err('permission_denied', { capability: c }) : ok()) });

test('the three queues register: a real capability, a routed deep link', () => {
  assert.doesNotThrow(() => assertProvidersRegistrable(ATTENTION_PROVIDERS));
  const ids = ATTENTION_PROVIDERS.map((p) => p.queueId);
  for (const id of ['bank_fetch_failed', 'bank_statement_gap', 'bank_lines_waiting']) assert.ok(ids.includes(id), id);
  assert.deepEqual(
    [bankFetchFailedProvider, bankStatementGapProvider, bankLinesWaitingProvider].map((p) => [p.readCapability, p.deepLinkRoute, p.rank]),
    [['pay', '/bank-accounts', 6], ['pay', '/bank-accounts', 7], ['read_sales', '/bank', 12]],
  );
});

test('a chained gap is an item with the numbers, the days, the repair link and the confirm; confirming it clears the item', () => {
  const w = world();
  const s1 = camt053({ iban: w.iban, seq: 182, date: '2026-09-22', opening: 10000 });
  imp(w, s1);
  imp(w, camt053({ iban: w.iban, seq: 187, date: '2026-09-29', opening: 10000 }));
  const summary = must(attentionSummary(w.ctx, { topLimit: 10 }), 'summary');
  assert.equal(queue(summary, 'bank_statement_gap').count, 1);
  const item = summary.top.find((i) => i.queueId === 'bank_statement_gap');
  assert.equal(item.titleKey, 'attention.item.bankStatementGap.titleManyDays');
  assert.deepEqual(item.titleParams, { bank: 'ZKB Geschäftskonto', range: '183–186', after: '182/2026', fromDate: '2026-09-23', toDate: '2026-09-28' });
  assert.equal(item.subtitleKey, 'attention.item.bankStatementGap.subtitleChained');
  assert.equal(item.urgency, 'due');
  assert.deepEqual(item.deepLink, { route: '/bank-accounts', params: { repair: w.accountId, gap: item.entityId } });
  const confirm = item.decisionOptions.find((o) => o.id === 'confirm_gap');
  assert.deepEqual([confirm.verb, confirm.humanConfirm, confirm.reasonField, confirm.capability], ['confirm_statement_gap', true, true, 'pay']);
  assert.equal(confirm.confirmLabelKey, 'attention.act.confirmGapConfirm');

  // The hub's row carries the whole call: a person confirms with a reason, and the item leaves the queue.
  must(confirmStatementGap(w.ctx, { ...confirm.input, reason: 'Tage ohne Buchung', confirmed: true }), 'confirm via the row');
  const after = must(attentionSummary(w.ctx, { topLimit: 10 }), 'after');
  assert.equal(queue(after, 'bank_statement_gap'), undefined);
});

test('an unchained gap names its amount and offers no confirmation; one missing day reads as one', () => {
  const w = world();
  imp(w, camt053({ iban: w.iban, seq: 4, date: '2026-09-22', opening: 10000 }));
  imp(w, camt053({ iban: w.iban, seq: 6, date: '2026-09-24', opening: 60000 }));
  const [item] = bankStatementGapProvider.list(w.ctx, { limit: 5 });
  assert.equal(item.titleKey, 'attention.item.bankStatementGap.titleOneDay');
  assert.deepEqual(item.titleParams, { bank: 'ZKB Geschäftskonto', range: '5', after: '4/2026', fromDate: '2026-09-23', toDate: '2026-09-23' });
  assert.equal(item.subtitleKey, 'attention.item.bankStatementGap.subtitleUnchained');
  assert.deepEqual(item.subtitleParams, { after: 4, before: 6, differenceMinor: 50000, currency: 'CHF' });
  assert.deepEqual(item.decisionOptions.map((o) => o.id), ['open']);
  assert.equal(item.consequenceKey, null);
  assert.equal(missingRangeText({ missing: [{ year: 2026, from: 1, to: 2 }], oldYearTailUnknown: true }), '1–2/2026');
});

test('bank lines waiting: one item per account, the true count, minus the lines a pending Vorschlag names', () => {
  const w = world();
  const xml = camt053({ iban: w.iban, seq: 1, date: '2026-09-30', opening: 10000, entries: [{ minor: -1234 }, { minor: -2345 }, { minor: -3456 }] });
  const statementId = imp(w, xml).statementId;
  const needs = bankInboxAttention(w.ctx).total.needs;
  assert.ok(needs >= 2, `the fixture lines need a person (${needs})`);
  assert.equal(bankLinesWaitingProvider.count(w.ctx), needs);
  const [item] = bankLinesWaitingProvider.list(w.ctx, { limit: 5 });
  // D178 point 11: the row says the number of lines and stands for them (`count`), the account is the meta.
  assert.deepEqual([item.titleKey, item.titleParams], ['attention.item.bankLines.title.other', { bank: 'ZKB Geschäftskonto', count: needs }]);
  assert.deepEqual([item.subtitleKey, item.subtitleParams, item.count], ['attention.item.bankLines.subtitle', { bank: 'ZKB Geschäftskonto' }, needs]);
  assert.deepEqual(item.deepLink, { route: '/bank', params: { facet: 'needs', account: w.accountId } });
  assert.equal(item.since, '2026-09-30');

  // A Vorschlag names one line: the agent queue counts it, this queue no longer does.
  const line = w.store.db.prepare('SELECT id FROM bank_txn WHERE workspace_id = ? AND statement_id = ? ORDER BY rowid LIMIT 1').get(w.workspaceId, statementId).id;
  w.store.db
    .prepare(
      `INSERT INTO agent_action (id, workspace_id, actor, dial_capability, action_tool, payload_json, status, idempotency_key, created_at)
       VALUES (?, ?, 'till-agent', 'post', 'book_bank_line', ?, 'pending', 'syn-k', ?)`,
    )
    .run('aa_syn_1', w.workspaceId, JSON.stringify({ bankTxnId: line }), w.clock.now());
  const summary = must(attentionSummary(w.ctx, { topLimit: 10 }), 'summary');
  assert.equal(queue(summary, 'bank_lines_waiting').count, needs - 1, 'the named line is not counted here');
  // D178: a bank Vorschlag is counted by the bank Vorschläge queue, under Bank.
  assert.equal(queue(summary, 'agent_action_bank').count, 1, 'it is counted there');
  assert.equal(queue(summary, 'agent_action'), undefined, 'and not as a System Vorschlag');
  assert.equal(summary.total, summary.queues.reduce((s, q) => s + q.count, 0));

  // read_sales gates the queue; pay gates the other two.
  const noSales = must(attentionSummary(w.as(denyOnly('read_sales')), {}), 'no sales');
  assert.equal(queue(noSales, 'bank_lines_waiting'), undefined);
});

test('the count and the list are computed once per state of the book, and a write in between is seen', () => {
  const w = world();
  imp(w, camt053({ iban: w.iban, seq: 1, date: '2026-09-29', opening: 10000, entries: [{ minor: -100 }] }));
  const first = bankLinesWaitingProvider.count(w.ctx);
  assert.equal(bankLinesWaitingProvider.list(w.ctx, { limit: 5 })[0].titleParams.count, first);
  imp(w, camt053({ iban: w.iban, seq: 2, date: '2026-09-30', opening: 9900, entries: [{ minor: -200 }] }));
  assert.equal(bankLinesWaitingProvider.count(w.ctx), first + 1, 'a new import is never served from the memo');
});

/** Activate the real ceremony against the in-process bank, then return the connection id. */
function activate(w) {
  const c = must(connectBankChannel(w.ctx, { host: { url: 'https://ebics.example/ebicsweb', hostId: 'ZKBKCHZZ', partnerId: `PARTNERG${n}`, userId: `USERG${n}` }, routeBankAccountIds: [w.accountId], confirm: true, idempotencyKey: `c-${n}` }), 'connect');
  const fetched = must(connectBankChannel(w.ctx, { connectionId: c.connectionId, confirm: true }), 'fetch');
  must(connectBankChannel(w.ctx, { connectionId: c.connectionId, confirm: true, confirmBankKeys: true, expectedBankKeyHashes: fetched.bankKeyHashes }), 'confirm');
  return c.connectionId;
}

function attempt(w, connectionId, { n: number, result, retryable, at }) {
  recordAutoSyncAttempt(w.ctx, {
    connectionId,
    localDate: at.slice(0, 10),
    attempt: number,
    idempotencyKey: `a36-auto-${connectionId}-${at.slice(0, 10)}-${number}`,
    startedAt: at,
    finishedAt: at,
    result,
    retryable,
    runAs: 'studio',
  });
}

test('a failed automatic fetch is an item only once it waits for a person, with the bank code, until a later success', () => {
  const w = world();
  const connectionId = activate(w);
  const busy = err('download_refused', { kind: 'busy', code: '091119' });
  // A retryable failure with attempts left: the scheduler tries again, nothing waits for a person yet.
  attempt(w, connectionId, { n: 1, result: busy, retryable: true, at: '2026-10-01T05:02:00.000Z' });
  assert.equal(bankFetchFailedProvider.count(w.ctx), 0);
  attempt(w, connectionId, { n: 2, result: busy, retryable: true, at: '2026-10-01T06:03:00.000Z' });
  attempt(w, connectionId, { n: 3, result: busy, retryable: true, at: '2026-10-01T07:04:00.000Z' });
  // Three attempts: the day is used up.
  assert.equal(bankFetchFailedProvider.count(w.ctx), 1);
  const [item] = bankFetchFailedProvider.list(w.ctx, { limit: 5 });
  assert.deepEqual(
    [item.titleKey, item.titleParams.bank, item.subtitleKey, item.subtitleParams.code, item.urgency, item.deepLink.route],
    ['attention.item.bankFetchFailed.title', 'ZKB', 'attention.item.bankFetchFailed.busy', '091119', 'due', '/bank-accounts'],
  );

  // A later success (the next day's run) ends it.
  attempt(w, connectionId, { n: 1, result: ok({ download: { outcome: 'no_data' }, statements: [] }), retryable: false, at: '2026-10-02T05:01:00.000Z' });
  assert.equal(bankFetchFailedProvider.count(w.ctx), 0);

  // A refusal a person must clear is an item at once, worded by its kind.
  attempt(w, connectionId, { n: 1, result: err('download_refused', { kind: 'not_granted', code: '090003' }), retryable: false, at: '2026-10-03T05:01:00.000Z' });
  const [denied] = bankFetchFailedProvider.list(w.ctx, { limit: 5 });
  assert.deepEqual([denied.subtitleKey, denied.subtitleParams.code], ['attention.item.bankFetchFailed.notGranted', '090003']);
  // pay gates it.
  assert.equal(queue(must(attentionSummary(w.as(denyOnly('pay')), {}), 'no pay'), 'bank_fetch_failed'), undefined);
});

test('§H-TENANT: another workspace on the same store sees none of the three', () => {
  const w = world();
  imp(w, camt053({ iban: w.iban, seq: 1, date: '2026-09-22', opening: 0, entries: [{ minor: 500 }] }));
  imp(w, camt053({ iban: w.iban, seq: 3, date: '2026-09-24', opening: 500 }));
  const other = must(createWorkspace({ store: w.store, clock: w.clock, ids: w.ids }, { name: 'Fremde Synthetik AG' }), 'other').workspaceId;
  const otherCtx = makeContext(w.store, { workspaceId: other, actor: 'user_1', clock: w.clock, ids: w.ids });
  for (const p of [bankFetchFailedProvider, bankStatementGapProvider, bankLinesWaitingProvider]) {
    assert.equal(p.count(otherCtx), 0, p.queueId);
    assert.deepEqual(p.list(otherCtx, { limit: 5 }), [], p.queueId);
  }
  assert.ok(bankStatementGapProvider.count(w.ctx) === 1 && bankLinesWaitingProvider.count(w.ctx) >= 1);
  const listed = must(attentionList(w.ctx, { area: 'bank' }), 'list');
  assert.ok(listed.items.some((i) => i.queueId === 'bank_statement_gap'));
});

test('critic LOW 5: the band and the hub say one number; without read_books the Vorschlag lines stay in bank_lines_waiting', async () => {
  const { dashboardTile } = await import('../../dist/core/dashboards/index.js');
  const w = world();
  const xml = camt053({ iban: w.iban, seq: 1, date: '2026-09-30', opening: 10000, entries: [{ minor: -1234 }, { minor: -2345 }, { minor: -3456 }] });
  const statementId = imp(w, xml).statementId;
  const line = w.store.db.prepare('SELECT id FROM bank_txn WHERE workspace_id = ? AND statement_id = ? ORDER BY rowid LIMIT 1').get(w.workspaceId, statementId).id;
  w.store.db
    .prepare(
      `INSERT INTO agent_action (id, workspace_id, actor, dial_capability, action_tool, payload_json, status, idempotency_key, created_at)
       VALUES ('aa_syn_5', ?, 'till-agent', 'post', 'book_bank_line', ?, 'pending', 'syn-5', ?)`,
    )
    .run(w.workspaceId, JSON.stringify({ bankTxnId: line }), w.clock.now());
  const tileOf = (ctx) => must(dashboardTile(ctx, { tile: 'bank_inbox', from: '2026-09-30', to: '2026-09-30' }), 'tile').tile;
  const tile = tileOf(w.ctx);
  const needs = bankInboxAttention(w.ctx).total.needs;
  assert.deepEqual([tile.needs, tile.waiting, tile.vorschlag], [needs, needs - 1, 1]);
  assert.equal(tile.waiting, bankLinesWaitingProvider.count(w.ctx), 'the band and the hub say one number');

  // An actor who may read the bank lines but not the books does not see agent_action: the Vorschlag
  // line is counted here instead, so it vanishes from neither.
  const salesOnly = w.as({ assert: (c) => (c === 'read_books' ? err('permission_denied', { capability: c }) : ok()) });
  assert.equal(bankLinesWaitingProvider.count(salesOnly), needs);
  const summary = must(attentionSummary(salesOnly, {}), 'summary');
  assert.equal(queue(summary, 'agent_action'), undefined);
  assert.equal(queue(summary, 'agent_action_bank'), undefined, 'D178: the bank Vorschläge share the read_books gate');
  assert.equal(queue(summary, 'bank_lines_waiting').count, needs);
  // The band's tile itself needs read_books, so such an actor sees no band: the hub is the one number.
  assert.equal(dashboardTile(salesOnly, { tile: 'bank_inbox', from: '2026-09-30', to: '2026-09-30' }).error, 'permission_denied');
});

test('critic LOW 3: a retryable failure with attempts left counts once its Swiss day is over', () => {
  const w = world();
  const connectionId = activate(w);
  // 01.10.2026 07:02 in Zurich: the bank did not answer; two attempts would be left that day.
  attempt(w, connectionId, { n: 1, result: err('channel_unreachable', { reason: 'network' }), retryable: true, at: '2026-10-01T05:02:00.000Z' });
  w.clock.current = '2026-10-01T08:00:00.000Z';
  assert.equal(bankFetchFailedProvider.count(w.ctx), 0, 'the same day: the scheduler still retries');
  // TILL was closed for the retries; it is 02.10 05:00 in Zurich, before the next run.
  w.clock.current = '2026-10-02T03:00:00.000Z';
  assert.equal(bankFetchFailedProvider.count(w.ctx), 1, 'yesterday failed and nobody fetched since');
  const [item] = bankFetchFailedProvider.list(w.ctx, { limit: 5 });
  assert.deepEqual([item.subtitleKey, item.subtitleParams.code], ['attention.item.bankFetchFailed.unreachable', 'network']);
});
