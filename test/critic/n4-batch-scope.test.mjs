/**
 * Critic N4 (D178 points 5 and 11), non-author probes on the ENGINE side of the Pendenzen batch.
 *
 *  - SCOPE: which drafted acts land in `agent_action_bank` and which of them the batch may touch ("Ausgewählte
 *    genehmigen", "Alle genehmigen") acts on. D178 point 5 is the batch approval of bank Vorschläge; the
 *    owner's words were the bank TRANSACTIONS ("bank account transactions, where it can be approved").
 *    The probe drafts, as the real agent seat over MCP, an IBAN redirect (`set_creditor_bank_profile`,
 *    on the automation denylist because it "alters who a future payment reaches") and the unattended
 *    money dial (`set_qr_auto_apply`, not automatable because it "would bypass the human approval the
 *    dial exists to record"), and shows both arrive in the batch queue with the approve exit the Studio's
 *    `approvable` keys on, beside an ordinary bank-line booking.
 *  - THE SETTING: an agent seat cannot switch `attention.approval_batch_mode` by itself, and a person's
 *    switch leaves the D172 change row and the A03 audit row.
 *  - HUMAN-ONLY per item: the batch is N calls of `approve_drafted_action`; the agent seat is refused on
 *    each, whatever the batch mode says.
 *
 * Synthetic by construction: invented names, an invented IBAN, invented amounts.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { callTool } from '../../dist/api/mcp.js';
import { getAction } from '../../dist/api/registry.js';
import { attentionSummary, attentionList } from '../../dist/core/attention/index.js';
import { makeContext } from '../../dist/core/context.js';
import { ok, err } from '../../dist/core/result.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';
import { syntheticIban, camt053 } from '../banking/ebics-support.mjs';

const mcp = (deps, name, args) => JSON.parse(callTool(deps, name, args).content[0].text);
const human = (deps, name, input) => getAction(name).run({ ...deps, actor: 'studio' }, input);

function must(res, what) {
  assert.equal(res.ok, true, `${what}: ${JSON.stringify(res).slice(0, 400)}`);
  return res;
}

function world() {
  const deps = freshDeps();
  const { workspaceId, accId } = mintWorkspace({ ...deps, actor: 'studio' }, 'Kritik N4 Synthetisch AG', 'n4c-ws');
  const W = { workspaceId };
  // The agent drafts what it may not do alone: `pay` and `post` ask.
  must(human(deps, 'set_agent_dial', { ...W, capability: 'pay', level: 'ask', idempotencyKey: 'n4c-dial-pay' }), 'dial pay');
  must(human(deps, 'set_agent_dial', { ...W, capability: 'post', level: 'ask', idempotencyKey: 'n4c-dial-post' }), 'dial post');
  const vendorId = must(
    human(deps, 'create_contact', {
      ...W,
      partyRole: 'vendor',
      name: 'Lieferant Erfunden GmbH',
      address: { street: 'Erfundenweg', houseNo: '3', zip: '8000', city: 'Zürich', country: 'CH' },
      idempotencyKey: 'n4c-vendor',
    }),
    'vendor',
  ).contact.id;
  const iban = syntheticIban(9471);
  const bankAccountId = must(
    human(deps, 'create_bank_account', { ...W, name: 'Erfundene Bank', iban, currency: 'CHF', ledgerAccountId: accId('1020'), idempotencyKey: 'n4c-bank' }),
    'bank account',
  ).bankAccountId;
  must(
    human(deps, 'import_camt', { ...W, bankAccountId, xml: camt053({ iban, seq: 1, date: '2026-07-10', opening: 100000, entries: [{ minor: -4200 }] }), idempotencyKey: 'n4c-camt' }),
    'camt',
  );
  const lineId = deps.store.db.prepare('SELECT id FROM bank_txn WHERE workspace_id = ? ORDER BY rowid').get(workspaceId).id;
  return { deps, W, accId, vendorId, lineId };
}

test('SCOPE (fixed, round 2): an IBAN redirect and the unattended-money dial stay under Bank with their own approve, but are never batchable; the booking is', () => {
  const w = world();
  const booking = mcp(w.deps, 'book_bank_line', {
    ...w.W,
    bankTxnId: w.lineId,
    target: { kind: 'accounts', legs: [{ accountId: w.accId('6500'), amountMinor: 4200 }] },
    idempotencyKey: 'n4c-book',
  });
  assert.equal(booking.drafted, true, JSON.stringify(booking));
  const redirect = mcp(w.deps, 'set_creditor_bank_profile', { ...w.W, vendorId: w.vendorId, iban: syntheticIban(1234), idempotencyKey: 'n4c-redirect' });
  assert.equal(redirect.drafted, true, `the IBAN redirect is a Vorschlag: ${JSON.stringify(redirect)}`);
  const autoApply = mcp(w.deps, 'set_qr_auto_apply', { ...w.W, autoApply: true, idempotencyKey: 'n4c-auto' });
  assert.equal(autoApply.drafted, true, `the auto-apply switch is a Vorschlag: ${JSON.stringify(autoApply)}`);

  const grouped = must(human(w.deps, 'attention_list', { ...w.W, grouping: 'by_area' }), 'grouped');
  const bank = grouped.sections.find((s) => s.key === 'bank');
  const batchQueue = bank.items.filter((i) => i.queueId === 'agent_action_bank');
  const tools = batchQueue.map((i) => i.subtitleParams.tool).sort();
  // Round 2 (orchestrator ruling on M1): all three stay filed under Bank, each with its own approve, but the
  // engine marks only the bank-line decision `batchable`, and the Studio's `approvable` keys on that flag alone.
  assert.deepEqual(tools, ['book_bank_line', 'set_creditor_bank_profile', 'set_qr_auto_apply']);
  for (const item of batchQueue) {
    assert.ok(
      item.decisionOptions.some((o) => o.id === 'approve' && o.verb === 'approve_drafted_action'),
      `${item.subtitleParams.tool} keeps its own approve`,
    );
    assert.notEqual(item.changedSinceProposal, true);
    assert.equal(item.batchable, item.subtitleParams.tool === 'book_bank_line', `${item.subtitleParams.tool}: batchable only for the line decision`);
  }
  w.deps.store.close();
});

test('TOTAL (fixed, round 2): a bank Vorschlag on a EUR Bankkonto reaches the hub with the line\'s signed EUR amount, so no total has to guess a currency', () => {
  const w = world();
  const iban = syntheticIban(5150);
  const eurAccount = must(
    human(w.deps, 'create_bank_account', { ...w.W, name: 'Erfundene Bank EUR', iban, currency: 'EUR', ledgerAccountId: w.accId('1020'), idempotencyKey: 'n4c-bank-eur' }),
    'EUR bank account',
  ).bankAccountId;
  must(
    human(w.deps, 'import_camt', { ...w.W, bankAccountId: eurAccount, xml: camt053({ iban, seq: 1, date: '2026-07-10', opening: 100000, currency: 'EUR', entries: [{ minor: -50000 }] }), idempotencyKey: 'n4c-camt-eur' }),
    'EUR camt',
  );
  must(human(w.deps, 'record_exchange_rate', { ...w.W, baseCurrency: 'EUR', rate: '0.9400', asOf: '2026-07-10', method: 'daily', idempotencyKey: 'n4c-fx' }), 'fx rate');
  const line = w.deps.store.db.prepare('SELECT id, amount_minor AS amount, currency FROM bank_txn WHERE workspace_id = ? AND bank_account_id = ?').get(w.W.workspaceId, eurAccount);
  assert.equal(line.currency, 'EUR', 'the line is a EUR line');
  const drafted = mcp(w.deps, 'book_bank_line', {
    ...w.W,
    bankTxnId: line.id,
    target: { kind: 'accounts', legs: [{ accountId: w.accId('6500'), amountMinor: Math.abs(line.amount) }] },
    idempotencyKey: 'n4c-book-eur',
  });
  assert.equal(drafted.drafted, true, JSON.stringify(drafted));

  const grouped = must(human(w.deps, 'attention_list', { ...w.W, grouping: 'by_area' }), 'grouped');
  const item = grouped.sections.find((s) => s.key === 'bank').items.find((i) => i.entityId === drafted.actionId);
  assert.ok(item, 'the EUR booking is a bank Vorschlag');
  // Round 2 (M2): the hub row carries the line's own signed amount and currency (a debit of EUR 500.00) ...
  assert.equal(item.amountMinor, -50000);
  assert.equal(item.currency, 'EUR');
  assert.equal(item.subtitleParams.date, '2026-07-10');
  // ... so the Studio sums per currency from the row and never reads a currency out of the payload.
  const payload = must(human(w.deps, 'list_drafted_actions', { ...w.W, status: 'pending' }), 'drafted').actions.find((a) => a.actionId === drafted.actionId).payload;
  assert.equal(payload.currency, undefined, 'the payload still names none: the row is the source');
  w.deps.store.close();
});

test('COUNT TRUTH under partial rights: for every capability subset the grouped total is the badge, the sections and the rows add up, and no section names a queue the actor cannot read', () => {
  const w = world();
  // A bank Vorschlag naming the line (so the waiting-lines subtraction runs), a System one, a statement gap.
  const named = mcp(w.deps, 'ignore_bank_line', { ...w.W, bankTxnId: w.lineId, reason: 'duplicate', idempotencyKey: 'n4c-ign' });
  assert.equal(named.drafted, true, JSON.stringify(named));
  const second = w.deps.store.db.prepare('SELECT bank_account_id AS b FROM bank_txn WHERE id = ?').get(w.lineId).b;
  const iban = w.deps.store.db.prepare('SELECT iban FROM bank_account WHERE id = ?').get(second).iban;
  must(human(w.deps, 'import_camt', { ...w.W, bankAccountId: second, xml: camt053({ iban, seq: 3, date: '2026-07-14', opening: 100000 - 4200, entries: [{ minor: -100 }, { minor: -200 }] }), idempotencyKey: 'n4c-camt-3' }), 'gap');
  const sys = mcp(w.deps, 'post_entry', {
    ...w.W,
    date: '2026-07-01',
    description: 'Erfundene Buchung',
    source: 'manual',
    idempotencyKey: 'n4c-sys',
    lines: [
      { account: w.accId('6500'), debit: 700 },
      { account: w.accId('1000'), credit: 700 },
    ],
  });
  assert.equal(sys.drafted, true, JSON.stringify(sys));

  const ws = w.W.workspaceId;
  const subsets = [
    ['read_sales', 'read_books', 'pay'],
    ['read_sales'],
    ['read_books'],
    ['pay'],
    ['read_sales', 'pay'],
    [],
  ];
  for (const allowed of subsets) {
    const set = new Set(allowed);
    const ctx = makeContext(w.deps.store, {
      workspaceId: ws,
      actor: 'user_1',
      clock: w.deps.clock,
      ids: w.deps.ids,
      capabilities: { assert: (c) => (set.has(c) ? ok() : err('permission_denied', { capability: c })) },
    });
    const summary = attentionSummary(ctx, {});
    assert.equal(summary.ok, true, JSON.stringify(summary));
    const readable = new Set(summary.queues.map((q) => q.queueId));
    if (allowed.length === 3) {
      // The world is not trivial: both Vorschläge queues, the gap and the waiting lines all hold work.
      const counts = Object.fromEntries(summary.queues.map((q) => [q.queueId, q.count]));
      assert.ok(counts.agent_action_bank >= 1 && counts.agent_action >= 1 && counts.bank_statement_gap >= 1 && counts.bank_lines_waiting >= 1, JSON.stringify(counts));
    }
    for (const grouping of ['by_area', 'by_kind']) {
      const first = attentionList(ctx, { grouping, limit: 1 });
      assert.equal(first.ok, true, JSON.stringify(first));
      assert.equal(first.total, summary.total, `${allowed.join('+') || 'none'} ${grouping}: total is the badge`);
      assert.equal(first.visibleQueues, summary.visibleQueues);
      if (summary.visibleQueues === 0) {
        assert.deepEqual(first.sections, []);
        continue;
      }
      assert.equal(first.sections.reduce((n, s) => n + s.count, 0), summary.total);
      for (const s of first.sections) {
        const rows = [...s.items];
        let cursor = s.nextCursor;
        while (cursor !== undefined) {
          const next = attentionList(ctx, { grouping, limit: 1, section: s.key, cursor });
          rows.push(...next.sections[0].items);
          cursor = next.sections[0].nextCursor;
        }
        assert.equal(rows.reduce((n, r) => n + (r.count ?? 1), 0), s.count, `${allowed.join('+')} ${grouping} ${s.key}: rows add up`);
        for (const q of s.queues) assert.ok(readable.has(q), `${q} is readable by ${allowed.join('+')}`);
        for (const r of rows) assert.ok(readable.has(r.queueId), `row of ${r.queueId} is readable by ${allowed.join('+')}`);
      }
    }
  }
  w.deps.store.close();
});

test('HUMAN-ONLY per item: the agent seat cannot approve any row of the batch queue, whatever the mode says', () => {
  const w = world();
  must(human(w.deps, 'settings_set', { ...w.W, key: 'attention.approval_batch_mode', value: 'all_with_confirm', reason: 'Kritik', idempotencyKey: 'n4c-mode' }), 'mode');
  const booking = mcp(w.deps, 'book_bank_line', {
    ...w.W,
    bankTxnId: w.lineId,
    target: { kind: 'accounts', legs: [{ accountId: w.accId('6500'), amountMinor: 4200 }] },
    idempotencyKey: 'n4c-book-2',
  });
  assert.equal(booking.drafted, true, JSON.stringify(booking));
  const refused = mcp(w.deps, 'approve_drafted_action', { ...w.W, actionId: booking.actionId });
  assert.equal(refused.ok, false, 'the governed seat never approves');
  // Nothing ran: still pending, the line still open.
  assert.equal(w.deps.store.db.prepare('SELECT status FROM agent_action WHERE id = ?').get(booking.actionId).status, 'pending');
  w.deps.store.close();
});

test('THE SETTING: the agent seat cannot switch the batch mode by itself; a person\'s switch leaves the change row and the audit row', () => {
  const w = world();
  const byAgent = mcp(w.deps, 'settings_set', { ...w.W, key: 'attention.approval_batch_mode', value: 'all_with_confirm', reason: 'schneller', idempotencyKey: 'n4c-agent-mode' });
  assert.notEqual(byAgent.ok === true && byAgent.drafted !== true, true, `the agent seat must not set it directly: ${JSON.stringify(byAgent)}`);
  const stillDefault = must(human(w.deps, 'attention_list', { ...w.W, grouping: 'by_area' }), 'read');
  assert.equal(stillDefault.approvalBatchMode, 'tick', 'the agent call changed nothing');

  const before = w.deps.store.db.prepare("SELECT COUNT(*) AS n FROM workspace_setting_change WHERE workspace_id = ? AND key = 'attention.approval_batch_mode'").get(w.W.workspaceId).n;
  must(human(w.deps, 'settings_set', { ...w.W, key: 'attention.approval_batch_mode', value: 'single', reason: 'Kritik', idempotencyKey: 'n4c-human-mode' }), 'human');
  const change = w.deps.store.db
    .prepare("SELECT kind, new_value_json, reason, actor FROM workspace_setting_change WHERE workspace_id = ? AND key = 'attention.approval_batch_mode' ORDER BY rowid DESC")
    .get(w.W.workspaceId);
  assert.equal(before + 1, w.deps.store.db.prepare("SELECT COUNT(*) AS n FROM workspace_setting_change WHERE workspace_id = ? AND key = 'attention.approval_batch_mode'").get(w.W.workspaceId).n);
  assert.deepEqual([change.kind, JSON.parse(change.new_value_json), change.reason, change.actor], ['set', 'single', 'Kritik', 'studio']);
  const audit = w.deps.store.db
    .prepare("SELECT action, actor FROM audit_log WHERE workspace_id = ? AND entity_kind = 'workspace_setting' AND entity_id = 'attention.approval_batch_mode'")
    .all(w.W.workspaceId);
  assert.deepEqual(audit, [{ action: 'update', actor: 'studio' }], 'one A03 chain row, the person\'s');
  w.deps.store.close();
});
