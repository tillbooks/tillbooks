/**
 * D178 point 11, PENDENZEN IN SECTIONS: the arithmetic the owner could not find on 21.10.2026 ("I have 12
 * open points but when I click on it, I don't find the 12 points"), held as INVARIANTS.
 *
 *  - badge total (`attention_summary.total`) == the grouped total == the sum of the section counts == the
 *    sum of the rows' own `count` over EVERY page, for both groupings;
 *  - every queue's units appear in exactly ONE section;
 *  - a list that falls short of its COUNT gets one remainder row carrying exactly the difference;
 *  - a same-entity collapse hands its units to the survivor (one row, no unit lost, none counted twice);
 *  - the cursor pages a 40-row section completely, no row twice;
 *  - inside Bank: the Vorschläge, then the waiting lines, then the rest by urgency;
 *  - a bank Vorschlag is a Bank row, any other Vorschlag a System row;
 *  - the flat answer (no `grouping`) is unchanged.
 *
 * The compose rules are proven on FAKE providers (the smallest world for each rule); the real providers
 * are then proven on a seeded book that fills most of them at once. All fixtures are synthetic.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  attentionSummary,
  attentionList,
  assertProvidersRegistrable,
  ATTENTION_PROVIDERS,
  BANK_VORSCHLAG_VERBS,
  BATCHABLE_VERBS,
  isBankVorschlag,
  isBankVorschlagVerb,
  isBatchable,
  withKind,
} from '../../dist/core/attention/index.js';
import { getAction } from '../../dist/api/registry.js';
import { DIAL_CAPABILITY_FOR_ACTION } from '../../dist/core/agent/dialMap.js';
import { freshDeps, mintWorkspace, manualPost } from '../api/support.mjs';
import { syntheticIban, camt053 } from '../banking/ebics-support.mjs';

const NOW = '2026-10-21T08:00:00.000Z';

function fakeCtx(allowed) {
  const set = new Set(allowed);
  return {
    workspaceId: 'w1',
    actor: 'a',
    clock: { now: () => NOW },
    capabilities: { assert: (cap) => (set.has(cap) ? { ok: true } : { ok: false, error: 'permission_denied', capability: cap }) },
    store: {},
  };
}

/** A fake queue: `count` is its true COUNT, `items` its list (sliced by the limit asked). */
function fake(id, opts) {
  return {
    queueId: id,
    labelKey: `attention.queue.${id}`,
    area: opts.area ?? 'bank',
    kind: opts.kind ?? 'do',
    ...(opts.lead ? { lead: true } : {}),
    readCapability: opts.cap ?? 'read_sales',
    rank: opts.rank ?? 10,
    freshness: 'live',
    dismissal: 'act_only',
    deepLinkRoute: opts.route ?? '/bank',
    count() {
      if (opts.throws) throw new Error('boom');
      return opts.count ?? (opts.items ?? []).reduce((n, i) => n + (i.count ?? 1), 0);
    },
    list(_ctx, { limit }) {
      if (opts.throws) throw new Error('boom');
      return (opts.items ?? []).slice(0, Math.min(limit, opts.listCap ?? Infinity));
    },
  };
}

function row(queueId, entityId, over = {}) {
  return {
    queueId,
    entityKind: over.entityKind ?? queueId,
    entityId,
    titleKey: `t.${queueId}`,
    titleParams: {},
    since: over.since ?? '2026-10-01',
    urgency: over.urgency ?? 'open',
    deepLink: { route: '/bank', params: {} },
    ...(over.count !== undefined ? { count: over.count } : {}),
  };
}

const units = (item) => (typeof item.count === 'number' ? item.count : 1);
const sum = (xs, f = (x) => x) => xs.reduce((n, x) => n + f(x), 0);

/** Read EVERY page of every section of a grouped list, through the cursor, with a small page size. */
function allPages(ctx, grouping, providers, limit = 2) {
  const first = attentionList(ctx, { grouping, limit }, providers);
  assert.equal(first.ok, true, JSON.stringify(first));
  const sections = first.sections.map((s) => {
    const rows = [...s.items];
    let cursor = s.nextCursor;
    while (cursor !== undefined) {
      const next = attentionList(ctx, { grouping, limit, section: s.key, cursor }, providers);
      assert.equal(next.ok, true, JSON.stringify(next));
      assert.equal(next.sections.length, 1, `paging ${s.key} answers that one section`);
      assert.equal(next.sections[0].key, s.key);
      assert.equal(next.sections[0].count, s.count, 'the count is the whole section on every page');
      assert.equal(next.total, first.total, 'the total is the whole list on every page');
      rows.push(...next.sections[0].items);
      cursor = next.sections[0].nextCursor;
    }
    return { key: s.key, count: s.count, queues: s.queues, rows };
  });
  return { first, sections };
}

/** THE invariant, for one grouping: badge == grouped total == sum of sections == sum of row units. */
function assertArithmetic(ctx, grouping, providers) {
  const summary = attentionSummary(ctx, {}, providers);
  const { first, sections } = allPages(ctx, grouping, providers);
  assert.equal(first.total, summary.total, `${grouping}: the grouped total is the badge`);
  assert.equal(sum(sections, (s) => s.count), first.total, `${grouping}: the sections add up to the total`);
  for (const s of sections) assert.equal(sum(s.rows, units), s.count, `${grouping}: the rows of ${s.key} add up to its count`);
  const keys = sections.flatMap((s) => s.rows.map((r) => `${r.entityKind}:${r.entityId}`));
  assert.equal(new Set(keys).size, keys.length, `${grouping}: no row twice`);
  // Every queue's units in exactly one section, and all of them.
  for (const q of summary.queues) {
    const holding = sections.filter((s) => s.rows.some((r) => r.queueId === q.queueId));
    assert.equal(holding.length, 1, `${grouping}: ${q.queueId} sits in exactly one section`);
    assert.equal(sum(holding[0].rows.filter((r) => r.queueId === q.queueId), units), q.count, `${grouping}: every unit of ${q.queueId} is a row`);
  }
  return { summary, first, sections };
}

// --- the compose rules, on fake queues -------------------------------------------------------------

const BANK_VS = fake('vs_bank', { area: 'bank', kind: 'approve', rank: 5, cap: 'read_books', items: [row('vs_bank', 'v1'), row('vs_bank', 'v2'), row('vs_bank', 'v3')] });
const LINES = fake('lines', { area: 'bank', kind: 'do', lead: true, rank: 12, items: [row('lines', 'acc1', { count: 5, entityKind: 'bank_account' })] });
const GAP = fake('gap', { area: 'bank', kind: 'do', rank: 7, items: [row('gap', 'g1', { urgency: 'due' })] });
const CHECK = fake('check', { area: 'accounting', kind: 'do', rank: 50, cap: 'read_books', items: [row('check', 'c1', { urgency: 'overdue' })] });
const FLAG = fake('flag', { area: 'accounting', kind: 'note', rank: 15, cap: 'read_books', items: [row('flag', 'f1')] });
const RUN = fake('run', { area: 'sales', kind: 'note', rank: 20, items: [row('run', 'r1')] });
const SYS_VS = fake('vs_sys', { area: 'system', kind: 'approve', rank: 5, cap: 'read_books', items: [row('vs_sys', 'v9')] });
const TWELVE = [BANK_VS, SYS_VS, LINES, GAP, CHECK, FLAG, RUN];
const ALL_CAPS = ['read_sales', 'read_books', 'pay'];

test('INVARIANT by_area: badge == grouped total == sum of sections == sum of row counts, and every unit sits in one section', () => {
  const { first, sections } = assertArithmetic(fakeCtx(ALL_CAPS), 'by_area', TWELVE);
  assert.equal(first.total, 13);
  assert.deepEqual(sections.map((s) => [s.key, s.count]), [['bank', 9], ['accounting', 2], ['sales', 1], ['system', 1]]);
});

test('INVARIANT by_kind: the same rows cut by kind add up to the same badge', () => {
  const { first, sections } = assertArithmetic(fakeCtx(ALL_CAPS), 'by_kind', TWELVE);
  assert.equal(first.total, 13);
  assert.deepEqual(sections.map((s) => [s.key, s.count]), [['approve', 4], ['do', 7], ['note', 2]]);
  // Inside a kind, Bank first: the bank Vorschläge lead Genehmigen, the bank lines lead Erledigen.
  assert.deepEqual(sections[0].rows.map((r) => r.queueId), ['vs_bank', 'vs_bank', 'vs_bank', 'vs_sys']);
  assert.deepEqual(sections[1].rows.map((r) => r.queueId), ['lines', 'gap', 'check']);
});

test('order inside Bank: the Vorschläge, then the waiting lines, then the rest by urgency (a due gap after the open lines)', () => {
  const res = attentionList(fakeCtx(ALL_CAPS), { grouping: 'by_area' }, TWELVE);
  const bank = res.sections.find((s) => s.key === 'bank');
  assert.deepEqual(bank.items.map((r) => r.entityId), ['v1', 'v2', 'v3', 'acc1', 'g1']);
  assert.deepEqual(bank.queues, ['vs_bank', 'lines', 'gap']);
  // Rows carry their queue's area and kind, and the aggregate row its units.
  assert.deepEqual([bank.items[3].area, bank.items[3].kind, bank.items[3].count], ['bank', 'do', 5]);
  const accounting = res.sections.find((s) => s.key === 'accounting');
  assert.deepEqual(accounting.items.map((r) => r.entityId), ['c1', 'f1'], 'overdue before open in an area with no Vorschlag');
});

test('a list that falls short of its COUNT gets ONE remainder row carrying exactly the difference, opening the owning surface', () => {
  const capped = fake('capped', { area: 'sales', rank: 30, count: 7, listCap: 3, route: '/dunning', items: [1, 2, 3, 4, 5, 6, 7].map((i) => row('capped', `x${i}`)) });
  const { sections } = assertArithmetic(fakeCtx(ALL_CAPS), 'by_area', [capped]);
  const rows = sections[0].rows;
  assert.equal(rows.length, 4);
  const rest = rows.find((r) => r.entityKind === 'attention_remainder');
  assert.ok(rest, 'the remainder row is there');
  assert.equal(rest.count, 4);
  assert.deepEqual(rest.titleParams, { count: 4, queueId: 'capped' });
  assert.equal(rest.deepLink.route, '/dunning');
  assert.deepEqual(rest.decisionOptions.map((o) => [o.id, o.verb, o.role]), [['open', null, 'link']]);
});

test('one entity, one row: a collapsed duplicate hands its units to the survivor (the lower rank number), so no unit is lost', () => {
  const hi = fake('qhi', { area: 'bank', rank: 10, items: [row('qhi', 'X', { entityKind: 'payment' })] });
  const lo = fake('qlo', { area: 'sales', rank: 20, items: [row('qlo', 'X', { entityKind: 'payment', urgency: 'overdue' })] });
  const ctx = fakeCtx(ALL_CAPS);
  const res = attentionList(ctx, { grouping: 'by_area' }, [hi, lo]);
  assert.equal(res.total, 2, 'both units are still counted');
  assert.equal(res.total, attentionSummary(ctx, {}, [hi, lo]).total);
  assert.deepEqual(res.sections.map((s) => [s.key, s.count, s.items.length]), [['bank', 2, 1]]);
  const [survivor] = res.sections[0].items;
  assert.deepEqual([survivor.queueId, survivor.count, survivor.collapsedWithQueueId], ['qhi', 2, 'qlo']);
});

test('a section of 40 rows pages completely through the cursor: 25, then 15, no row twice, the count 40 on both pages', () => {
  const many = fake('many', { area: 'bank', rank: 10, items: Array.from({ length: 40 }, (_, i) => row('many', `m${String(i).padStart(2, '0')}`)) });
  const ctx = fakeCtx(ALL_CAPS);
  const page1 = attentionList(ctx, { grouping: 'by_area' }, [many]);
  assert.equal(page1.sections[0].count, 40);
  assert.equal(page1.sections[0].items.length, 25, 'the default page is 25 rows');
  assert.equal(page1.sections[0].nextCursor, '25');
  const page2 = attentionList(ctx, { grouping: 'by_area', section: 'bank', cursor: page1.sections[0].nextCursor }, [many]);
  assert.equal(page2.sections[0].count, 40);
  assert.equal(page2.sections[0].items.length, 15);
  assert.equal(page2.sections[0].nextCursor, undefined);
  const ids = [...page1.sections[0].items, ...page2.sections[0].items].map((r) => r.entityId);
  assert.equal(new Set(ids).size, 40);
});

test('honesty in sections: a failed queue is named, counts nowhere, and both faces still agree; no read right is the padlock', () => {
  const bad = fake('bad', { area: 'bank', throws: true });
  const ctx = fakeCtx(ALL_CAPS);
  const res = attentionList(ctx, { grouping: 'by_area' }, [...TWELVE, bad]);
  assert.deepEqual(res.failed, ['bad']);
  assert.equal(res.incomplete, true);
  assert.equal(res.total, attentionSummary(ctx, {}, [...TWELVE, bad]).total);
  assert.ok(res.sections.every((s) => !s.queues.includes('bad')));

  const denied = attentionList(fakeCtx([]), { grouping: 'by_kind' }, TWELVE);
  assert.deepEqual([denied.visibleQueues, denied.total, denied.sections], [0, null, []]);
  // A denied queue is absent from the sections, as from the summary.
  const salesOnly = attentionList(fakeCtx(['read_sales']), { grouping: 'by_area' }, TWELVE);
  assert.ok(salesOnly.sections.every((s) => s.queues.every((q) => !['vs_bank', 'vs_sys', 'check', 'flag'].includes(q))));
});

test('an unknown grouping is refused; without grouping the flat page answers exactly as before', () => {
  const ctx = fakeCtx(ALL_CAPS);
  const refused = attentionList(ctx, { grouping: 'by_colour' }, TWELVE);
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'invalid_input');
  const flat = attentionList(ctx, {}, TWELVE);
  assert.equal(flat.ok, true);
  assert.ok(Array.isArray(flat.items));
  assert.equal(flat.sections, undefined);
  // The flat page still ranks urgency first (the summary's own order).
  assert.equal(flat.items[0].urgency, 'overdue');
});

test('every registered queue declares a kind; the registration guard refuses one without', () => {
  for (const p of ATTENTION_PROVIDERS) assert.ok(['approve', 'do', 'note'].includes(p.kind), `${p.queueId} declares a kind`);
  const { kind: _drop, ...noKind } = fake('nk', { area: 'bank', route: '/bank' });
  assert.throws(() => assertProvidersRegistrable([noKind]), /declares no kind/);
  assert.doesNotThrow(() => assertProvidersRegistrable([withKind(noKind, 'do')]));
  // The decided cut (G15 §4 table).
  const kinds = Object.fromEntries(ATTENTION_PROVIDERS.map((p) => [p.queueId, [p.area, p.kind]]));
  assert.deepEqual(kinds, {
    agent_action_bank: ['bank', 'approve'],
    agent_action: ['system', 'approve'],
    qr_match: ['bank', 'note'],
    review_flag: ['accounting', 'note'],
    dunning_run: ['sales', 'approve'],
    checklist_items_due: ['accounting', 'do'],
    bank_keys_review: ['bank', 'do'],
    bank_activation: ['bank', 'do'],
    bank_fetch_failed: ['bank', 'do'],
    bank_statement_gap: ['bank', 'do'],
    bank_lines_waiting: ['bank', 'do'],
  });
  assert.deepEqual(ATTENTION_PROVIDERS.filter((p) => p.lead === true).map((p) => p.queueId), ['bank_lines_waiting']);
});

test('BANK_VORSCHLAG_VERBS: every entry is a registered verb, the owner\'s two are in, and no entry is listed twice', () => {
  for (const verb of BANK_VORSCHLAG_VERBS) assert.ok(getAction(verb) !== undefined, `${verb} is a registered verb`);
  assert.equal(new Set(BANK_VORSCHLAG_VERBS).size, BANK_VORSCHLAG_VERBS.length);
  assert.ok(isBankVorschlagVerb('book_bank_line') && isBankVorschlagVerb('ignore_bank_line'));
  assert.equal(isBankVorschlagVerb('post_entry'), false);
  assert.equal(isBankVorschlagVerb('issue_invoice'), false);
  // Only a dial-governed verb can be drafted at all; every bank verb the dial name-keys is either listed or
  // deliberately not a bank verb. book_bank_line is governed input-keyed, so it is not in the name map.
  const bankish = Object.keys(DIAL_CAPABILITY_FOR_ACTION).filter((v) => /(^|_)bank(_|$)|camt|qr_match|payment|pain001|statement_gap/.test(v));
  for (const verb of bankish) assert.ok(isBankVorschlagVerb(verb), `${verb} looks like a bank verb and is not listed`);
  // Critic N4 L5: the input-keyed Bankkonto edit files under Bank; a reimbursement only when it pays from a Bankkonto.
  assert.ok(isBankVorschlagVerb('update_bank_account'));
  assert.equal(isBankVorschlag('expense_claim_reimburse', { bankAccountId: 'ba_1' }), true);
  assert.equal(isBankVorschlag('expense_claim_reimburse', {}), false);
});

test('THE BATCH REACH (critic N4 M1, orchestrator ruling): only the decisions on a bank line are batchable, an explicit three', () => {
  assert.deepEqual([...BATCHABLE_VERBS], ['book_bank_line', 'ignore_bank_line', 'confirm_match']);
  for (const verb of BATCHABLE_VERBS) assert.ok(getAction(verb) !== undefined && isBankVorschlagVerb(verb), `${verb} is a registered bank verb`);
  for (const verb of ['set_creditor_bank_profile', 'set_qr_auto_apply', 'payment_batch_transmit', 'bank_channel_disconnect', 'create_bank_account', 'update_bank_account', 'set_bank_sync_schedule', 'set_write_off_threshold', 'reverse_payment', 'revoke_statement_gap_confirmation', 'apply_qr_match', 'record_payment']) {
    assert.equal(isBatchable(verb), false, `${verb} is approved one at a time`);
  }
});

// --- the real queues, on one seeded book -----------------------------------------------------------

/**
 * One synthetic book that fills most queues at once: two bank Vorschläge and one System Vorschlag, four
 * bank lines on one Bankkonto (two named by the Vorschläge), a statement gap, a hand-typed credit, a
 * flagged entry and a proposed Mahnlauf.
 */
function seededBook() {
  const deps = freshDeps();
  const { workspaceId, accId } = mintWorkspace(deps, 'Abschnitte Synthetisch AG', 'sec-ws');
  const call = (name, input, d = deps) => {
    const res = getAction(name).run(d, { workspaceId, ...input });
    assert.equal(res.ok, true, `${name}: ${JSON.stringify(res)}`);
    return res;
  };

  // A15: one overdue invoice and a proposed run.
  call('vat_seed_defaults', {});
  call('set_vat_method', { vatMethod: 'effektiv', vatAccounting: 'soll' });
  call('set_creditor_profile', {
    creditorName: 'Synthetisch AG',
    address: { street: 'Seestrasse', buildingNo: '1', zip: '8700', town: 'Küsnacht', country: 'CH' },
    qrIban: 'CH4431999123000889012',
  });
  const customerId = call('create_contact', {
    partyRole: 'customer',
    name: 'Säumig Synthetisch AG',
    address: { street: 'Musterweg', houseNo: '2', zip: '3000', city: 'Bern', country: 'CH' },
    idempotencyKey: 'sec-contact',
  }).contact.id;
  const invoiceId = call('create_document', {
    type: 'invoice',
    contactId: customerId,
    currency: 'CHF',
    dueDate: '2026-06-01',
    lines: [{ description: 'Beratung', unitPriceMinor: 100000, taxCode: 'UST81' }],
    idempotencyKey: 'sec-doc',
  }).document.id;
  call('issue_invoice', { invoiceId, idempotencyKey: 'sec-issue' });
  const level = { feeMinor: 0, bookFee: false, showInterest: false };
  call('set_dunning_config', {
    levels: [
      { level: 1, daysOverdue: 10, ...level },
      { level: 2, daysOverdue: 20, ...level },
      { level: 3, daysOverdue: 30, ...level },
    ],
    idempotencyKey: 'sec-cfg',
  });
  call('propose_dunning_run', { idempotencyKey: 'sec-propose' });

  // A25: a flagged posting.
  const posted = call('post_entry', manualPost(accId, 'sec-post'));
  call('flag_entry', { entryId: posted.entryId ?? posted.entry?.id, reason: 'Konto prüfen', idempotencyKey: 'sec-flag' }, { ...deps, actor: 'reto' });

  // A39 / D150: four lines on statement 4, statement 6 after it: a gap (5).
  const iban = syntheticIban(9104);
  const bankAccountId = call('create_bank_account', { name: 'Synthetische Bank Konto', iban, currency: 'CHF', ledgerAccountId: accId('1020'), idempotencyKey: 'sec-bank' }).bankAccountId;
  const entries = [{ minor: -1234 }, { minor: -2345 }, { minor: -3456 }, { minor: -4567 }];
  call('import_camt', { bankAccountId, xml: camt053({ iban, seq: 4, date: '2026-07-10', opening: 100000, entries }), idempotencyKey: 'sec-imp-4' });
  const closing4 = 100000 + entries.reduce((n, e) => n + e.minor, 0);
  call('import_camt', { bankAccountId, xml: camt053({ iban, seq: 6, date: '2026-07-14', opening: closing4, entries: [] }), idempotencyKey: 'sec-imp-6' });

  // A21: one hand-typed credit with no invoice.
  call('record_incoming_credit', { bankAccountId, amountMinor: 33300, valueDate: '2026-07-15', idempotencyKey: 'sec-credit' });

  // A35: two bank Vorschläge naming two of the lines, one System Vorschlag (synthetic rows, as the seam stores them).
  const lines = deps.store.db.prepare('SELECT id FROM bank_txn WHERE workspace_id = ? ORDER BY rowid').all(workspaceId).map((r) => r.id);
  const draft = deps.store.db.prepare(
    `INSERT INTO agent_action (id, workspace_id, actor, dial_capability, action_tool, payload_json, status, idempotency_key, created_at)
     VALUES (?, ?, 'till-agent', 'post', ?, ?, 'pending', ?, ?)`,
  );
  draft.run(
    'aa_sec_1',
    workspaceId,
    'book_bank_line',
    JSON.stringify({ workspaceId, bankTxnId: lines[0], target: { kind: 'accounts', legs: [{ accountId: accId('6500'), amountMinor: 1234 }] } }),
    'sec-k1',
    deps.clock.now(),
  );
  draft.run('aa_sec_2', workspaceId, 'ignore_bank_line', JSON.stringify({ workspaceId, bankTxnId: lines[1] }), 'sec-k2', deps.clock.now());
  draft.run('aa_sec_3', workspaceId, 'post_entry', JSON.stringify({ workspaceId, ...manualPost(accId, 'sec-draft') }), 'sec-k3', deps.clock.now());
  return { deps, workspaceId };
}

test('INVARIANT on the real queues, both groupings: the badge is the page, and the bank Vorschläge lead Bank', () => {
  const { deps, workspaceId } = seededBook();
  const ctxOf = () => {
    const read = (input) => getAction('attention_list').run({ ...deps, actor: 'studio' }, { workspaceId, ...input });
    return read;
  };
  const read = ctxOf();
  const summary = getAction('attention_summary').run({ ...deps, actor: 'studio' }, { workspaceId });
  assert.equal(summary.ok, true, JSON.stringify(summary));
  const byQueue = Object.fromEntries(summary.queues.map((q) => [q.queueId, q.count]));
  assert.equal(byQueue.agent_action_bank, 2, 'the two bank Vorschläge');
  assert.equal(byQueue.agent_action, 1, 'the one System Vorschlag');
  assert.equal(byQueue.bank_lines_waiting, 2, 'four lines, two of them named by a Vorschlag');
  assert.equal(byQueue.bank_statement_gap, 1);
  assert.equal(byQueue.qr_match, 1);
  assert.equal(byQueue.review_flag, 1);
  assert.equal(byQueue.dunning_run, 1);
  assert.deepEqual(summary.queues.map((q) => [q.queueId, q.kind]).find(([id]) => id === 'agent_action_bank'), ['agent_action_bank', 'approve']);

  for (const grouping of ['by_area', 'by_kind']) {
    // Page every section with a page of 1, through the verb itself (the MCP and REST face).
    const first = read({ grouping, limit: 1 });
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(first.total, summary.total, `${grouping}: the grouped total is the badge`);
    assert.equal(first.approvalBatchMode, 'tick', 'the default batch mode rides the answer');
    assert.equal(sum(first.sections, (s) => s.count), summary.total, `${grouping}: the sections add up to the badge`);
    const rowsBySection = new Map();
    for (const s of first.sections) {
      const rows = [...s.items];
      let cursor = s.nextCursor;
      while (cursor !== undefined) {
        const next = read({ grouping, limit: 1, section: s.key, cursor });
        rows.push(...next.sections[0].items);
        cursor = next.sections[0].nextCursor;
      }
      assert.equal(sum(rows, units), s.count, `${grouping}: the rows of ${s.key} add up to its count`);
      rowsBySection.set(s.key, rows);
    }
    for (const q of summary.queues) {
      const holding = [...rowsBySection.entries()].filter(([, rows]) => rows.some((r) => r.queueId === q.queueId));
      assert.equal(holding.length, 1, `${grouping}: ${q.queueId} sits in exactly one section`);
      assert.equal(sum(holding[0][1].filter((r) => r.queueId === q.queueId), units), q.count, `${grouping}: every unit of ${q.queueId}`);
    }
    if (grouping === 'by_area') {
      assert.deepEqual(first.sections.map((s) => s.key), ['bank', 'accounting', 'sales', 'system']);
      const bank = rowsBySection.get('bank').map((r) => r.queueId);
      assert.deepEqual(bank.slice(0, 3), ['agent_action_bank', 'agent_action_bank', 'bank_lines_waiting'], 'the Vorschläge, then the lines');
      assert.ok(rowsBySection.get('system').every((r) => r.queueId === 'agent_action'), 'the other Vorschlag is a System row');
    } else {
      assert.deepEqual(first.sections.map((s) => s.key), ['approve', 'do', 'note']);
      // Bank first inside Genehmigen, then Verkauf (the Mahnlauf waits for its Freigabe, D178), then System.
      assert.deepEqual(rowsBySection.get('approve').map((r) => r.queueId), ['agent_action_bank', 'agent_action_bank', 'dunning_run', 'agent_action'], 'bank first inside Genehmigen');
    }
  }
  deps.store.close();
});

test('the batch mode the workspace set rides the grouped answer', () => {
  const { deps, workspaceId } = seededBook();
  const human = { ...deps, actor: 'studio' };
  const set = getAction('settings_set').run(human, { workspaceId, key: 'attention.approval_batch_mode', value: 'all_with_confirm', reason: 'Testfall', idempotencyKey: 'sec-mode' });
  assert.equal(set.ok, true, JSON.stringify(set));
  const res = getAction('attention_list').run(human, { workspaceId, grouping: 'by_area' });
  assert.equal(res.approvalBatchMode, 'all_with_confirm');
  deps.store.close();
});

// --- critic N4 round 2 and the design judge: the line's facts, the batch reach, a stale Vorschlag stays --

const read = (deps, workspaceId, input) => getAction('attention_list').run({ ...deps, actor: 'studio' }, { workspaceId, ...input });
const badge = (deps, workspaceId) => getAction('attention_summary').run({ ...deps, actor: 'studio' }, { workspaceId });
const rowsOf = (res) => res.sections.flatMap((s) => s.items);
const lineOf = (deps, actionId) => deps.store.db.prepare("SELECT json_extract(payload_json, '$.bankTxnId') AS l FROM agent_action WHERE id = ?").get(actionId).l;

test('THE LINE\'S FACTS (critic N4 M2): a line Vorschlag carries the line\'s signed amount, its currency, its date and its target in words', () => {
  const { deps, workspaceId } = seededBook();
  const rows = rowsOf(read(deps, workspaceId, { grouping: 'by_area' }));
  const book = rows.find((r) => r.entityId === 'aa_sec_1');
  // A debit of 12.34 out of the account: signed, never an absolute, never a guessed currency.
  assert.deepEqual([book.amountMinor, book.currency, book.subtitleParams.date], [-1234, 'CHF', '2026-07-10']);
  assert.deepEqual([book.subtitleParams.targetKind, book.batchable], ['accounts', true]);
  assert.match(String(book.subtitleParams.target), /^6500 \S/, 'the account in words, number and name');
  const ignore = rows.find((r) => r.entityId === 'aa_sec_2');
  assert.deepEqual([ignore.amountMinor, ignore.subtitleParams.targetKind, ignore.batchable], [-2345, 'ignore', true]);
  // R2-M2: a booking to accounts mints an entry; a line set aside books nothing.
  assert.deepEqual([book.posts, ignore.posts], [true, false]);
  // A System Vorschlag names no line: no amount from a line, and never batchable.
  const sys = rows.find((r) => r.entityId === 'aa_sec_3');
  assert.deepEqual([sys.amountMinor, sys.currency, sys.batchable], [undefined, undefined, false]);
  deps.store.close();
});

test('ONE MEANING PER SLOT (the fresh-eyes judge, N4 M3): the counterparty rides on the item for the title, and a Buchungsregel is named by the account it books to, never by its label', () => {
  const { deps, workspaceId } = seededBook();
  const accId = (n) => deps.store.db.prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?').get(workspaceId, n).id;
  const lines = deps.store.db.prepare('SELECT id FROM bank_txn WHERE workspace_id = ? ORDER BY rowid').all(workspaceId).map((r) => r.id);
  // The bank reported who the first and the third line paid (the parsed detail row the camt import keeps).
  const named = deps.store.db.prepare(
    `INSERT INTO bank_txn_detail (bank_txn_id, workspace_id, counterparty_name) VALUES (?, ?, ?)
     ON CONFLICT(bank_txn_id) DO UPDATE SET counterparty_name = excluded.counterparty_name`,
  );
  named.run(lines[0], workspaceId, 'Rösterei Synthetisch AG');
  named.run(lines[2], workspaceId, 'Elektro Synthetisch GmbH');
  // A Buchungsregel labelled like a counterparty ("Elektro Service"), whose recipe books to 6570.
  const set = getAction('set_bank_standard').run(deps, {
    workspaceId,
    bankTxnId: lines[2],
    label: 'Elektro Service',
    legs: [{ accountId: accId('6570'), taxCode: null, amount: { kind: 'rest' } }],
    idempotencyKey: 'sec-rule',
  });
  assert.equal(set.ok, true, JSON.stringify(set));
  const standardId = deps.store.db.prepare('SELECT id FROM bank_standard WHERE workspace_id = ? ORDER BY rowid DESC LIMIT 1').get(workspaceId).id;
  deps.store.db
    .prepare(
      `INSERT INTO agent_action (id, workspace_id, actor, dial_capability, action_tool, payload_json, status, idempotency_key, created_at)
       VALUES ('aa_sec_rule', ?, 'till-agent', 'post', 'book_bank_line', ?, 'pending', 'sec-k-rule', ?)`,
    )
    .run(workspaceId, JSON.stringify({ workspaceId, bankTxnId: lines[2], target: { kind: 'rule', standardId, asks: {} } }), deps.clock.now());
  const rows = rowsOf(read(deps, workspaceId, { grouping: 'by_area' }));
  const book = rows.find((r) => r.entityId === 'aa_sec_1');
  assert.equal(book.subtitleParams.counterparty, 'Rösterei Synthetisch AG');
  const byRule = rows.find((r) => r.entityId === 'aa_sec_rule');
  assert.equal(byRule.subtitleParams.targetKind, 'rule');
  assert.match(String(byRule.subtitleParams.target), /^6570 \S/, 'the rule named by its account, number and name');
  assert.doesNotMatch(String(byRule.subtitleParams.target), /Elektro Service/, 'never by the rule label');
  // A line the bank named nobody on carries no counterparty, never an empty string.
  assert.equal(rows.find((r) => r.entityId === 'aa_sec_2').subtitleParams.counterparty, undefined);
  deps.store.close();
});

test('THE BATCH REACH on items (critic N4 M1): an IBAN redirect and the auto-apply switch stay under Bank, never batchable; Bankkonto edits and paid reimbursements file under Bank', () => {
  const { deps, workspaceId } = seededBook();
  const draft = deps.store.db.prepare(
    `INSERT INTO agent_action (id, workspace_id, actor, dial_capability, action_tool, payload_json, status, idempotency_key, created_at)
     VALUES (?, ?, 'till-agent', 'pay', ?, ?, 'pending', ?, ?)`,
  );
  draft.run('aa_iban', workspaceId, 'set_creditor_bank_profile', JSON.stringify({ workspaceId, vendorId: 'ct_x', iban: 'CH00' }), 'k-iban', deps.clock.now());
  draft.run('aa_auto', workspaceId, 'set_qr_auto_apply', JSON.stringify({ workspaceId, autoApply: true }), 'k-auto', deps.clock.now());
  draft.run('aa_acct', workspaceId, 'update_bank_account', JSON.stringify({ workspaceId, bankAccountId: 'ba_x', iban: 'CH00' }), 'k-acct', deps.clock.now());
  draft.run('aa_spesen_bank', workspaceId, 'expense_claim_reimburse', JSON.stringify({ workspaceId, claimId: 'c1', bankAccountId: 'ba_x' }), 'k-sp1', deps.clock.now());
  draft.run('aa_spesen', workspaceId, 'expense_claim_reimburse', JSON.stringify({ workspaceId, claimId: 'c2' }), 'k-sp2', deps.clock.now());
  const res = read(deps, workspaceId, { grouping: 'by_area' });
  const rows = rowsOf(res);
  const of = (id) => rows.find((r) => r.entityId === id);
  for (const id of ['aa_iban', 'aa_auto', 'aa_acct', 'aa_spesen_bank']) {
    assert.deepEqual([of(id).queueId, of(id).area, of(id).batchable], ['agent_action_bank', 'bank', false], id);
  }
  assert.deepEqual([of('aa_spesen').queueId, of('aa_spesen').area], ['agent_action', 'system']);
  assert.deepEqual(rows.filter((r) => r.batchable === true).map((r) => r.entityId).sort(), ['aa_sec_1', 'aa_sec_2']);
  // The counts still add up with the new filing.
  assert.equal(res.total, badge(deps, workspaceId).total);
  deps.store.close();
});

test('A STALE VORSCHLAG STAYS (the design judge): listed, counted once, kind do, one way on, until its line is decided or proposed again', () => {
  const { deps, workspaceId } = seededBook();
  const before = badge(deps, workspaceId);
  const waiting = (s) => s.queues.find((q) => q.queueId === 'bank_lines_waiting')?.count ?? 0;
  // The engine voids a Vorschlag whose pinned records changed (`markStale`); the state it leaves, synthetically.
  deps.store.db.prepare("UPDATE agent_action SET status = 'stale', resolved_at = ? WHERE workspace_id = ? AND id = 'aa_sec_1'").run(deps.clock.now(), workspaceId);
  const after = badge(deps, workspaceId);
  assert.equal(after.total, before.total, 'the badge falls only by what was approved: nothing was');
  assert.equal(after.queues.find((q) => q.queueId === 'agent_action_bank').count, 2, 'the stale one still counts among the bank Vorschläge');
  assert.equal(waiting(after), waiting(before), 'and its line is not counted a second time among the waiting lines');

  const byArea = read(deps, workspaceId, { grouping: 'by_area' });
  assert.equal(byArea.total, after.total);
  const stale = rowsOf(byArea).find((r) => r.entityId === 'aa_sec_1');
  assert.deepEqual([stale.stale, stale.changedSinceProposal, stale.kind, stale.batchable], [true, true, 'do', false]);
  assert.deepEqual(
    stale.decisionOptions.map((o) => [o.id, o.verb, o.deepLink?.route, o.deepLink?.params.line]),
    [['check_in_bank', null, '/bank', lineOf(deps, 'aa_sec_1')]],
    'one way on, and no approve or reject on a void Vorschlag',
  );
  // Inside Bank: the approvable one first, then the stale one, then the lines.
  const bank = byArea.sections.find((s) => s.key === 'bank').items.map((r) => r.queueId === 'bank_lines_waiting' ? 'lines' : r.entityId);
  assert.ok(bank.indexOf('aa_sec_2') < bank.indexOf('aa_sec_1') && bank.indexOf('aa_sec_1') < bank.indexOf('lines'), bank.join(','));
  // By kind it waits under Erledigen, not Genehmigen.
  const byKind = read(deps, workspaceId, { grouping: 'by_kind' });
  assert.ok(byKind.sections.find((s) => s.key === 'do').items.some((r) => r.entityId === 'aa_sec_1'));
  assert.ok(!byKind.sections.find((s) => s.key === 'approve').items.some((r) => r.entityId === 'aa_sec_1'));
  assert.equal(byKind.total, after.total);

  // The agent proposes the line again: the new pending Vorschlag takes the stale one's place.
  const line = lineOf(deps, 'aa_sec_1');
  deps.store.db
    .prepare(
      `INSERT INTO agent_action (id, workspace_id, actor, dial_capability, action_tool, payload_json, status, idempotency_key, created_at)
       VALUES ('aa_again', ?, 'till-agent', 'post', 'book_bank_line', ?, 'pending', 'k-again', ?)`,
    )
    .run(workspaceId, JSON.stringify({ workspaceId, bankTxnId: line }), deps.clock.now());
  const again = rowsOf(read(deps, workspaceId, { grouping: 'by_area' }));
  assert.ok(!again.some((r) => r.entityId === 'aa_sec_1') && again.some((r) => r.entityId === 'aa_again'));
  assert.equal(badge(deps, workspaceId).total, after.total, 'one line, one unit');

  // The newer one goes stale too: it is the listed one. Then the person decides the line: it leaves with it.
  deps.store.db.prepare("UPDATE agent_action SET status = 'stale' WHERE id = 'aa_again'").run();
  const listed = rowsOf(read(deps, workspaceId, { grouping: 'by_area' }));
  assert.ok(listed.some((r) => r.entityId === 'aa_again') && !listed.some((r) => r.entityId === 'aa_sec_1'), 'the newest stale one is the listed one');
  const ignored = getAction('ignore_bank_line').run({ ...deps, actor: 'studio' }, { workspaceId, bankTxnId: line, reason: 'duplicate', idempotencyKey: 'sec-ign' });
  assert.equal(ignored.ok, true, JSON.stringify(ignored));
  const decided = rowsOf(read(deps, workspaceId, { grouping: 'by_area' }));
  assert.ok(!decided.some((r) => r.entityId === 'aa_again' || r.entityId === 'aa_sec_1'), 'a decided line has no Vorschlag left');
  assert.equal(badge(deps, workspaceId).total, after.total - 1);
  deps.store.close();
});
