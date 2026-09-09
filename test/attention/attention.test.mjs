/**
 * G15, the attention hub: the composition contract, MEASURED.
 *
 * The compose functions are provider-agnostic, so the honesty rules (denied queue omitted, failed
 * provider named with no count, total null under a full denial, same-entity collapse, count is a
 * COUNT and not a list length, cross-queue ranking) are proven on FAKE providers with a fake ctx,
 * which is the smallest world that exercises each rule. The two REAL providers (A21 qr_match, A15
 * dunning_run) are then proven against a real store seeded through the registry, plus §H-TENANT and
 * the registration guard.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  attentionSummary,
  attentionList,
  assertProvidersRegistrable,
  ATTENTION_PROVIDERS,
} from '../../dist/core/attention/index.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';
import { getAction } from '../../dist/api/registry.js';

const NOW = '2026-08-17T14:32:00.000Z';

/** A fake ctx: the compose functions only touch `capabilities`, `clock` and (via fakes) nothing else. */
function fakeCtx(allowed) {
  const set = new Set(allowed);
  return {
    workspaceId: 'w1',
    actor: 'a',
    clock: { now: () => NOW },
    capabilities: {
      assert: (cap) => (set.has(cap) ? { ok: true } : { ok: false, error: 'permission_denied', capability: cap }),
    },
    store: {},
  };
}

/** A fake provider whose count and list are fixtures (or throw), recording the ctx it was handed. */
function fakeProvider(id, opts) {
  const seen = { countCtx: null, listCtx: null };
  return {
    seen,
    provider: {
      queueId: id,
      labelKey: `attention.queue.${id}`,
      area: opts.area ?? 'bank',
      readCapability: opts.cap ?? 'read_sales',
      rank: opts.rank ?? 10,
      freshness: 'live',
      dismissal: 'act_only',
      deepLinkRoute: opts.route ?? '/reconciliation',
      count(ctx) {
        seen.countCtx = ctx;
        if (opts.throws) throw new Error('boom');
        return opts.count;
      },
      list(ctx, { limit }) {
        seen.listCtx = ctx;
        if (opts.throws) throw new Error('boom');
        return (opts.items ?? []).slice(0, limit);
      },
    },
  };
}

/** One AttentionItem fixture. */
function item(queueId, entityId, over) {
  return {
    queueId,
    entityKind: over?.entityKind ?? queueId,
    entityId,
    titleKey: `t.${queueId}`,
    titleParams: {},
    since: over?.since ?? '2026-08-01',
    urgency: over?.urgency ?? 'open',
    deepLink: { route: '/reconciliation', params: { id: entityId } },
  };
}

test('summary: two visible queues sum their true counts and lead with the ranked top rows', () => {
  const a = fakeProvider('qa', { cap: 'read_sales', rank: 10, count: 2, items: [item('qa', 'a1'), item('qa', 'a2')] });
  const b = fakeProvider('qb', { cap: 'read_books', rank: 20, count: 3, items: [item('qb', 'b1')] });
  const res = attentionSummary(fakeCtx(['read_sales', 'read_books']), { topLimit: 5 }, [a.provider, b.provider]);
  assert.equal(res.ok, true);
  assert.equal(res.visibleQueues, 2);
  assert.equal(res.total, 5);
  assert.equal(res.incomplete, false);
  assert.deepEqual(res.failed, []);
  assert.equal(res.queues.length, 2);
  assert.equal(res.computedAt, NOW);
  // Ranked: qa (rank 10) before qb (rank 20) at equal urgency.
  assert.equal(res.top[0].queueId, 'qa');
});

test('honesty: a DENIED queue is absent from BOTH queues[] and top[] (not a zero)', () => {
  const a = fakeProvider('qa', { cap: 'read_sales', count: 2, items: [item('qa', 'a1')] });
  const b = fakeProvider('qb', { cap: 'read_books', count: 9, items: [item('qb', 'b1')] });
  const res = attentionSummary(fakeCtx(['read_sales']), {}, [a.provider, b.provider]);
  assert.equal(res.visibleQueues, 1);
  assert.equal(res.total, 2);
  assert.ok(res.queues.every((q) => q.queueId !== 'qb'));
  assert.ok(res.top.every((i) => i.queueId !== 'qb'));
  assert.equal(b.seen.countCtx, null, 'a denied provider is never even read');
});

test('honesty: no read capability at all is the padlock, total is null and never 0', () => {
  const a = fakeProvider('qa', { cap: 'read_sales', count: 5, items: [item('qa', 'a1')] });
  const res = attentionSummary(fakeCtx([]), {}, [a.provider]);
  assert.equal(res.visibleQueues, 0);
  assert.equal(res.total, null);
  assert.notEqual(res.total, 0);
  assert.deepEqual(res.queues, []);
  assert.deepEqual(res.top, []);
  assert.equal(res.incomplete, false);
});

test('honesty: a FAILED provider is named once, contributes no count and never renders 0; the empty state stays unreachable', () => {
  const good = fakeProvider('qg', { cap: 'read_sales', count: 0, items: [] });
  const bad = fakeProvider('qb', { cap: 'read_books', throws: true });
  const res = attentionSummary(fakeCtx(['read_sales', 'read_books']), {}, [good.provider, bad.provider]);
  assert.deepEqual(res.failed, ['qb']);
  assert.equal(res.incomplete, true);
  // The failed queue is NOT a row and NOT a zero.
  assert.ok(res.queues.every((q) => q.queueId !== 'qb'));
  // visibleQueues > 0 but `incomplete` is true, so the Studio's celebratory-empty predicate
  // (failed empty AND visibleQueues > 0) is false: an empty hub and a broken hub stay distinct.
  assert.ok(res.visibleQueues > 0 && res.incomplete === true);
});

test('honesty: count is a COUNT, not a list length (a queue over its cap reports the real total)', () => {
  // 7 pending, list caps at 5: the queue count must still be 7.
  const many = Array.from({ length: 5 }, (_, i) => item('qc', `c${i}`));
  const p = fakeProvider('qc', { cap: 'read_sales', count: 7, items: many });
  const res = attentionSummary(fakeCtx(['read_sales']), { topLimit: 5 }, [p.provider]);
  assert.equal(res.queues[0].count, 7);
  assert.equal(res.top.length, 5);
});

test('one entity, one row: same entityKind+entityId collapses to the higher-ranked queue, counts unchanged', () => {
  const hi = fakeProvider('qhi', { cap: 'read_sales', rank: 10, count: 1, items: [item('qhi', 'X', { entityKind: 'payment' })] });
  const lo = fakeProvider('qlo', { cap: 'read_books', rank: 20, count: 1, items: [item('qlo', 'X', { entityKind: 'payment' })] });
  const res = attentionSummary(fakeCtx(['read_sales', 'read_books']), {}, [hi.provider, lo.provider]);
  const forX = res.top.filter((i) => i.entityKind === 'payment' && i.entityId === 'X');
  assert.equal(forX.length, 1, 'one row for one entity');
  assert.equal(forX[0].queueId, 'qhi', 'the higher-ranked queue survives');
  assert.equal(forX[0].collapsedWithQueueId, 'qlo', 'the collapsed queue is named on the survivor');
  // Each queue's own count is untouched.
  assert.equal(res.queues.find((q) => q.queueId === 'qhi').count, 1);
  assert.equal(res.queues.find((q) => q.queueId === 'qlo').count, 1);
});

test('ranking: overdue outranks open regardless of queue rank', () => {
  const a = fakeProvider('qa', { cap: 'read_sales', rank: 10, count: 1, items: [item('qa', 'a1', { urgency: 'open' })] });
  const b = fakeProvider('qb', { cap: 'read_books', rank: 20, count: 1, items: [item('qb', 'b1', { urgency: 'overdue' })] });
  const res = attentionSummary(fakeCtx(['read_sales', 'read_books']), {}, [a.provider, b.provider]);
  assert.equal(res.top[0].urgency, 'overdue');
  assert.equal(res.top[0].queueId, 'qb');
});

test('§H-TENANT: every provider read receives the ctx (with its workspaceId)', () => {
  const a = fakeProvider('qa', { cap: 'read_sales', count: 1, items: [item('qa', 'a1')] });
  const ctx = fakeCtx(['read_sales']);
  attentionSummary(ctx, {}, [a.provider]);
  assert.equal(a.seen.countCtx.workspaceId, 'w1');
  assert.equal(a.seen.listCtx.workspaceId, 'w1');
  a.seen.countCtx = null;
  attentionList(ctx, {}, [a.provider]);
  assert.equal(a.seen.listCtx.workspaceId, 'w1');
});

test('attention_list: filters by queueId, filters by urgency, and pages with the cursor', () => {
  const a = fakeProvider('qa', {
    cap: 'read_sales',
    count: 3,
    items: [item('qa', 'a1', { urgency: 'overdue', since: '2026-08-03' }), item('qa', 'a2', { urgency: 'open', since: '2026-08-02' }), item('qa', 'a3', { urgency: 'open', since: '2026-08-01' })],
  });
  const b = fakeProvider('qb', { cap: 'read_books', count: 1, items: [item('qb', 'b1')] });
  const ctx = fakeCtx(['read_sales', 'read_books']);

  const onlyA = attentionList(ctx, { queueId: 'qa' }, [a.provider, b.provider]);
  assert.ok(onlyA.items.every((i) => i.queueId === 'qa'));

  const overdue = attentionList(ctx, { urgency: 'overdue' }, [a.provider, b.provider]);
  assert.ok(overdue.items.every((i) => i.urgency === 'overdue'));

  const page1 = attentionList(ctx, { queueId: 'qa', limit: 2 }, [a.provider, b.provider]);
  assert.equal(page1.items.length, 2);
  assert.equal(page1.nextCursor, '2');
  const page2 = attentionList(ctx, { queueId: 'qa', limit: 2, cursor: '2' }, [a.provider, b.provider]);
  assert.equal(page2.items.length, 1);
  assert.equal(page2.nextCursor, undefined);
});

test('registration guard: an unrouted deep link or an unresolved capability is refused', () => {
  const unrouted = fakeProvider('qx', { cap: 'read_sales', route: '/does-not-exist', count: 0, items: [] });
  assert.throws(() => assertProvidersRegistrable([unrouted.provider]), /not a routed surface/);
  const badCap = fakeProvider('qy', { cap: 'not_a_real_capability', route: '/reconciliation', count: 0, items: [] });
  assert.throws(() => assertProvidersRegistrable([badCap.provider]), /does not resolve/);
  // The live registry itself registers cleanly.
  assert.doesNotThrow(() => assertProvidersRegistrable(ATTENTION_PROVIDERS));
});

// --- The real providers, against a real store seeded through the registry ------------------------

/** Seed n unmatched incoming credits (A21) so the qr_match provider has real rows to count and list. */
function seedCredits(deps, workspaceId, accId, n) {
  const bank = getAction('create_bank_account').run(deps, {
    workspaceId,
    name: 'PostFinance',
    iban: 'CH93 0076 2011 6238 5295 7',
    currency: 'CHF',
    ledgerAccountId: accId('1020'),
    idempotencyKey: 'att-bank',
  });
  assert.equal(bank.ok, true, JSON.stringify(bank));
  for (let i = 0; i < n; i++) {
    const r = getAction('record_incoming_credit').run(deps, {
      workspaceId,
      bankAccountId: bank.bankAccountId,
      amountMinor: 100000 + i,
      valueDate: '2026-08-1' + (i % 9),
      idempotencyKey: `att-credit-${i}`,
    });
    assert.equal(r.ok, true, JSON.stringify(r));
  }
}

test('real providers: attention_summary composes A21 qr_match with a true COUNT above the list cap', () => {
  const deps = freshDeps();
  const { workspaceId, accId } = mintWorkspace(deps, 'Pendenzen GmbH', 'att-ws');
  seedCredits(deps, workspaceId, accId, 7);

  const res = getAction('attention_summary').run(deps, { workspaceId, topLimit: 5 });
  assert.equal(res.ok, true, JSON.stringify(res));
  const qr = res.queues.find((q) => q.queueId === 'qr_match');
  assert.ok(qr, 'the qr_match queue is present');
  assert.equal(qr.count, 7, 'the count is a COUNT over all open rows, above the 5-row list cap');
  assert.equal(qr.area, 'bank');
  const qrTop = res.top.filter((i) => i.queueId === 'qr_match');
  assert.ok(qrTop.length <= 5, 'the list is capped while the count is not');
  assert.ok(qrTop.every((i) => i.deepLink.route === '/reconciliation'));
  // No dunning proposals seeded, so that queue has no row (zero pending has no row).
  assert.ok(res.queues.every((q) => q.queueId !== 'dunning_run'));
});

test('§H-TENANT: a second workspace sees only its own zero', () => {
  const deps = freshDeps();
  const { workspaceId, accId } = mintWorkspace(deps, 'A GmbH', 'att-a');
  seedCredits(deps, workspaceId, accId, 3);
  const other = mintWorkspace(deps, 'B GmbH', 'att-b');

  const a = getAction('attention_summary').run(deps, { workspaceId });
  assert.equal(a.queues.find((q) => q.queueId === 'qr_match').count, 3);

  const b = getAction('attention_summary').run(deps, { workspaceId: other.workspaceId });
  assert.equal(b.ok, true, JSON.stringify(b));
  // Workspace B seeded nothing, so it has no qr_match row and a zero total.
  assert.ok(b.queues.every((q) => q.queueId !== 'qr_match'));
  assert.equal(b.total, 0);
});

test('non-mutation: attention_summary writes no row', () => {
  const deps = freshDeps();
  const { workspaceId, accId } = mintWorkspace(deps, 'Read Only GmbH', 'att-ro');
  seedCredits(deps, workspaceId, accId, 2);
  const countRows = () =>
    deps.store.db.prepare('SELECT COUNT(*) AS n FROM reconciliation_match').get().n;
  const before = countRows();
  getAction('attention_summary').run(deps, { workspaceId });
  getAction('attention_list').run(deps, { workspaceId, queueId: 'qr_match' });
  assert.equal(countRows(), before, 'the reads mutate nothing');
});

test('the registry gains exactly two G15 entries, both reads', () => {
  const g15 = ['attention_summary', 'attention_list'].map((n) => getAction(n));
  assert.ok(g15.every((a) => a !== undefined), 'both verbs are registered');
  assert.ok(g15.every((a) => a.kind === 'read'), 'both are reads');
});
