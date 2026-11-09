/**
 * Critic N4 round 2 (D178 points 5 and 11, the orchestrator's rulings of 21.10.2026), non-author probes on
 * the ENGINE side, against `origin/claude/bank-parity-n4` at 1d1c420db.
 *
 *  - REACH: only the bank-line decisions (`BATCHABLE_VERBS`) are `batchable`; every other bank Vorschlag keeps
 *    its own approve and never a box.
 *  - STALE: a Vorschlag whose Buchungsregel changed after the proposal is refused by the batch's verb, voided,
 *    and STAYS listed (kind `do`, no approve, not batchable); the rows before and after it in the same run
 *    still execute (D162); the agent seat is refused on every row (D161).
 *  - TOTAL: the row carries the line's SIGNED amount and its own currency.
 *  - COUNT TRUTH with the stale row present, for every capability subset and both groupings.
 *  - LEAK: a seat with `read_books` but without the bank's read right (`read_sales`, the right of
 *    `list_bank_inbox` and `list_bank_standards`) reads a line's counterparty, signed amount, currency, date
 *    and a Buchungsregel's booking account off a Vorschlag row (FINDING, pinned as observed).
 *
 * Synthetic by construction: invented names, IBANs, amounts and texts.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { callTool } from '../../dist/api/mcp.js';
import { getAction } from '../../dist/api/registry.js';
import { attentionSummary, attentionList } from '../../dist/core/attention/index.js';
import { makeContext } from '../../dist/core/context.js';
import { ok, err } from '../../dist/core/result.js';
import { CAPABILITY_FOR_ACTION } from '../../dist/core/access/actionCapabilities.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';
import { syntheticIban, camt053 } from '../banking/ebics-support.mjs';

const mcp = (deps, name, args) => JSON.parse(callTool(deps, name, args).content[0].text);
const human = (deps, name, input) => getAction(name).run({ ...deps, actor: 'studio' }, input);

function must(res, what) {
  assert.equal(res.ok, true, `${what}: ${JSON.stringify(res).slice(0, 400)}`);
  return res;
}

/** A book with four open debit lines (one with a counterparty), a vendor, and the agent drafting under ask. */
function world() {
  const deps = freshDeps();
  const { workspaceId, accId } = mintWorkspace({ ...deps, actor: 'studio' }, 'Kritik N4 Runde Zwei AG', 'r2-ws');
  const W = { workspaceId };
  must(human(deps, 'set_agent_dial', { ...W, capability: 'pay', level: 'ask', idempotencyKey: 'r2-dial-pay' }), 'dial pay');
  must(human(deps, 'set_agent_dial', { ...W, capability: 'post', level: 'ask', idempotencyKey: 'r2-dial-post' }), 'dial post');
  const vendorId = must(
    human(deps, 'create_contact', {
      ...W,
      partyRole: 'vendor',
      name: 'Erfundene Lieferung GmbH',
      address: { street: 'Probeweg', houseNo: '7', zip: '8000', city: 'Zürich', country: 'CH' },
      idempotencyKey: 'r2-vendor',
    }),
    'vendor',
  ).contact.id;
  const iban = syntheticIban(7311);
  const bankAccountId = must(
    human(deps, 'create_bank_account', { ...W, name: 'Erfundene Bank R2', iban, currency: 'CHF', ledgerAccountId: accId('1020'), idempotencyKey: 'r2-bank' }),
    'bank account',
  ).bankAccountId;
  const entries = [{ minor: -1100 }, { minor: -2200 }, { minor: -3300 }, { minor: 4400 }];
  must(human(deps, 'import_camt', { ...W, bankAccountId, xml: camt053({ iban, seq: 1, date: '2026-07-10', opening: 100000, entries }), idempotencyKey: 'r2-camt' }), 'camt');
  const lines = deps.store.db.prepare('SELECT id FROM bank_txn WHERE workspace_id = ? ORDER BY rowid').all(workspaceId).map((r) => r.id);
  // The synthetic camt names no counterparty; a Buchungsregel needs one to recognise its line by.
  lines.forEach((id, k) => deps.store.db.prepare('UPDATE bank_txn SET payer_name = ? WHERE id = ?').run(`Erfundene Partei ${k + 1}`, id));
  return { deps, W, accId, vendorId, lines, bankAccountId };
}

const booking = (w, line, k, account = '6500', amount = 1100) =>
  mcp(w.deps, 'book_bank_line', {
    ...w.W,
    bankTxnId: line,
    target: { kind: 'accounts', legs: [{ accountId: w.accId(account), amountMinor: amount }] },
    idempotencyKey: `r2-book-${k}`,
  });

/** A Vorschlag booking `line` by a Buchungsregel, and the rule's id. */
function ruleBooking(w, line, k) {
  const rule = must(
    human(w.deps, 'set_bank_standard', {
      ...w.W,
      bankTxnId: line,
      label: `Regel ${k}`,
      legs: [{ accountId: w.accId('6500'), taxCode: null, amount: { kind: 'rest' } }],
      idempotencyKey: `r2-rule-${k}`,
    }),
    'rule',
  ).standard;
  const drafted = mcp(w.deps, 'book_bank_line', { ...w.W, bankTxnId: line, target: { kind: 'rule', standardId: rule.id, asks: {} }, idempotencyKey: `r2-rbook-${k}` });
  assert.equal(drafted.drafted, true, JSON.stringify(drafted));
  return { actionId: drafted.actionId, rule };
}

/** Edit the rule after the proposal (another account), which makes the Vorschlag stale (D162). */
function editRule(w, line, rule, k) {
  const row = w.deps.store.db.prepare('SELECT * FROM bank_standard WHERE id = ?').get(rule.id);
  must(
    human(w.deps, 'set_bank_standard', {
      ...w.W,
      bankTxnId: line,
      label: row.label,
      legs: JSON.parse(row.legs_json).map((l) => ({ ...l, accountId: w.accId('6570') ?? w.accId('6800') })),
      idempotencyKey: `r2-rule-edit-${k}`,
    }),
    'rule edit',
  );
}

const grouped = (w, input = {}) => must(human(w.deps, 'attention_list', { ...w.W, grouping: 'by_area', ...input }), 'grouped');
const bankItems = (g) => g.sections.flatMap((s) => s.items).filter((i) => i.queueId === 'agent_action_bank');

test('REACH: only the line decisions are batchable; an IBAN redirect and the auto-apply switch keep their own approve and no box', () => {
  const w = world();
  assert.equal(booking(w, w.lines[0], 'a').drafted, true);
  assert.equal(mcp(w.deps, 'ignore_bank_line', { ...w.W, bankTxnId: w.lines[1], reason: 'duplicate', idempotencyKey: 'r2-ign' }).drafted, true);
  assert.equal(mcp(w.deps, 'set_creditor_bank_profile', { ...w.W, vendorId: w.vendorId, iban: syntheticIban(4242), idempotencyKey: 'r2-iban' }).drafted, true);
  assert.equal(mcp(w.deps, 'set_qr_auto_apply', { ...w.W, autoApply: true, idempotencyKey: 'r2-auto' }).drafted, true);
  const items = bankItems(grouped(w));
  const byTool = Object.fromEntries(items.map((i) => [i.subtitleParams.tool, i.batchable]));
  assert.deepEqual(byTool, { book_bank_line: true, ignore_bank_line: true, set_creditor_bank_profile: false, set_qr_auto_apply: false });
  for (const i of items) assert.ok(i.decisionOptions.some((o) => o.id === 'approve'), `${i.subtitleParams.tool} keeps its own approve`);
  w.deps.store.close();
});

test('TOTAL: the row carries the line\'s signed amount and own currency (a credit positive, a debit negative)', () => {
  const w = world();
  const out = booking(w, w.lines[0], 'out');
  const inn = mcp(w.deps, 'ignore_bank_line', { ...w.W, bankTxnId: w.lines[3], reason: 'other', idempotencyKey: 'r2-in' });
  const items = bankItems(grouped(w));
  const of = (id) => items.find((i) => i.entityId === id);
  assert.deepEqual([of(out.actionId).amountMinor, of(out.actionId).currency], [-1100, 'CHF']);
  assert.deepEqual([of(inn.actionId).amountMinor, of(inn.actionId).currency], [4400, 'CHF']);
  w.deps.store.close();
});

test('STALE inside a run (D162): the stale middle row is refused and voided, the rows around it execute, and it STAYS listed, unbatchable, with no approve', () => {
  const w = world();
  const first = booking(w, w.lines[0], 'first');
  const { actionId: middle, rule } = ruleBooking(w, w.lines[1], 'mid');
  const last = booking(w, w.lines[2], 'last', '6500', 3300);
  editRule(w, w.lines[1], rule, 'mid');
  const before = bankItems(grouped(w)).find((i) => i.entityId === middle);
  assert.equal(before.changedSinceProposal, true, 'the edit made it changed');
  assert.equal(before.batchable, false, 'a changed row is never batchable');

  // The batch is N sequential approvals; run exactly what the Studio runs, the stale one included.
  const results = [first.actionId, middle, last.actionId].map((actionId) => human(w.deps, 'approve_drafted_action', { ...w.W, actionId }));
  assert.equal(results[0].ok, true, JSON.stringify(results[0]));
  assert.deepEqual([results[1].ok, results[1].error], [false, 'vorschlag_stale']);
  assert.equal(results[2].ok, true, JSON.stringify(results[2]));
  const status = (id) => w.deps.store.db.prepare('SELECT status FROM agent_action WHERE id = ?').get(id).status;
  assert.deepEqual([status(first.actionId), status(middle), status(last.actionId)], ['executed', 'stale', 'executed']);
  // Nothing was booked for the stale line.
  const lineState = w.deps.store.db.prepare('SELECT COUNT(*) AS n FROM agent_action WHERE id = ? AND committed_at IS NOT NULL').get(middle).n;
  assert.equal(lineState, 0, 'the stale approval committed nothing');

  const after = grouped(w);
  const row = bankItems(after).find((i) => i.entityId === middle);
  assert.ok(row, 'the stale Vorschlag stays listed while its line is open');
  assert.equal(row.stale, true);
  assert.equal(row.batchable, false);
  assert.equal(row.kind, 'do');
  assert.deepEqual(row.decisionOptions.map((o) => o.id), ['check_in_bank'], 'no approve, no reject: one way on');
  // A second approval of the voided row still runs nothing.
  assert.equal(human(w.deps, 'approve_drafted_action', { ...w.W, actionId: middle }).error, 'vorschlag_stale');
  w.deps.store.close();
});

test('D161: the agent seat is refused on every batchable row', () => {
  const w = world();
  const a = booking(w, w.lines[0], 'ag');
  const res = mcp(w.deps, 'approve_drafted_action', { ...w.W, actionId: a.actionId });
  assert.equal(res.ok, false);
  assert.equal(w.deps.store.db.prepare('SELECT status FROM agent_action WHERE id = ?').get(a.actionId).status, 'pending');
  w.deps.store.close();
});

test('COUNT TRUTH with a stale row listed: every capability subset, both groupings, badge == sections == rows, no unreadable queue', () => {
  const w = world();
  booking(w, w.lines[0], 'c1');
  const { actionId: staleId, rule } = ruleBooking(w, w.lines[1], 'c2');
  editRule(w, w.lines[1], rule, 'c2');
  assert.equal(human(w.deps, 'approve_drafted_action', { ...w.W, actionId: staleId }).error, 'vorschlag_stale');
  assert.equal(
    mcp(w.deps, 'post_entry', {
      ...w.W,
      date: '2026-07-01',
      description: 'Erfundene Buchung',
      source: 'manual',
      idempotencyKey: 'r2-sys',
      lines: [
        { account: w.accId('6500'), debit: 700 },
        { account: w.accId('1000'), credit: 700 },
      ],
    }).drafted,
    true,
  );
  const ws = w.W.workspaceId;
  for (const allowed of [['read_sales', 'read_books', 'pay'], ['read_sales'], ['read_books'], ['pay'], ['read_sales', 'pay'], ['read_books', 'pay'], []]) {
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
      const counts = Object.fromEntries(summary.queues.map((q) => [q.queueId, q.count]));
      // Two bank Vorschläge (one pending, one stale and listed), one System one, and the waiting lines (the
      // Buchungsregel makes the debit lines 'sure', so only the credit waits).
      assert.deepEqual([counts.agent_action_bank, counts.agent_action, counts.bank_lines_waiting], [2, 1, 1], JSON.stringify(counts));
    }
    for (const grouping of ['by_area', 'by_kind']) {
      const first = attentionList(ctx, { grouping, limit: 1 });
      assert.equal(first.ok, true, JSON.stringify(first));
      assert.equal(first.total, summary.total, `${allowed.join('+') || 'none'} ${grouping}: total is the badge`);
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
        for (const r of rows) assert.ok(readable.has(r.queueId), `row of ${r.queueId} readable by ${allowed.join('+')}`);
      }
    }
  }
  w.deps.store.close();
});

test('FINDING M1 (fixed, flipped): a seat with read_books but without the bank read right sees the Vorschlag WITHOUT the bank line\'s facts or the Buchungsregel', () => {
  const w = world();
  // A line with a counterparty the bank reported (synthetic), booked by a rule.
  w.deps.store.db
    .prepare('UPDATE bank_txn SET payer_name = ? WHERE id = ?')
    .run('Geheime Gegenpartei AG', w.lines[3]);
  const { actionId } = ruleBooking(w, w.lines[3], 'leak');
  const booksOnly = makeContext(w.deps.store, {
    workspaceId: w.W.workspaceId,
    actor: 'user_1',
    clock: w.deps.clock,
    ids: w.deps.ids,
    capabilities: { assert: (c) => (c === 'read_books' ? ok() : err('permission_denied', { capability: c })) },
  });
  // The bank's own reads refuse this seat (the D175-C6 rule: books without the bank cannot read a line).
  assert.deepEqual([CAPABILITY_FOR_ACTION.list_bank_inbox, CAPABILITY_FOR_ACTION.list_bank_standards, CAPABILITY_FOR_ACTION.list_drafted_actions], ['read_sales', 'read_sales', 'read_books']);
  const res = attentionList(booksOnly, { grouping: 'by_area' });
  const row = res.sections.flatMap((s) => s.items).find((i) => i.entityId === actionId);
  assert.ok(row, 'the Vorschlag is listed for a read_books seat');
  // ... and the row hands over none of the line's facts nor the rule's account (R2-M1 fixed).
  assert.equal(row.amountMinor, undefined);
  assert.equal(row.currency, undefined);
  assert.equal(row.subtitleParams.counterparty, undefined);
  assert.equal(row.subtitleParams.date, undefined);
  assert.equal(row.subtitleParams.target, undefined, 'no Buchungsregel recipe account, a list_bank_standards fact');
  assert.equal(JSON.stringify(row).includes('Geheime'), false);
  // A seat that may read the bank still sees all of them.
  const full = attentionList(makeContext(w.deps.store, { workspaceId: w.W.workspaceId, actor: 'user_1', clock: w.deps.clock, ids: w.deps.ids }), { grouping: 'by_area' })
    .sections.flatMap((s) => s.items)
    .find((i) => i.entityId === actionId);
  assert.deepEqual([full.amountMinor, full.currency, full.subtitleParams.counterparty, full.subtitleParams.date], [4400, 'CHF', 'Geheime Gegenpartei AG', '2026-07-10']);
  assert.match(String(full.subtitleParams.target), /^6500 /);
  // The drafted payload this seat may read (list_drafted_actions, read_books) names none of them.
  const payload = JSON.parse(w.deps.store.db.prepare('SELECT payload_json FROM agent_action WHERE id = ?').get(actionId).payload_json);
  assert.equal(JSON.stringify(payload).includes('Geheime'), false);
  assert.equal(JSON.stringify(payload).includes('4400'), false);
  w.deps.store.close();
});
