// A38 §4.6 (D129 leg 2): the `source='vat_settlement'` §H-PERIOD carve-out in `postEntry`, asserted
// BY NAME. This is the one place leg 2 touches A02, and the critic's first stop.
//
// The carve-out admits the MWST-Saldierung into a FILED, hard-locked period (the transfer of a filed
// quarter's VAT balances to 2201 is dated the period end, so it lands inside the `vat_filed` lock by
// construction) under three enforced conditions, each a rejection here:
//
//   1. no VAT trace on any line            invalid_line {reason: 'a settlement carries no VAT trace'}
//   2. only the tax accounts                invalid_line {reason: 'settlement_account'}
//   3. never into a year_close seal         period_locked {reason: 'year_close'}
//
// and one admission: a trace-free settlement on the tax accounts posts over the `vat_filed` lock. The
// CONTROLS matter as much as the assertions: the same lines with `source='manual'` are refused by the
// same lock, so the relaxation is proven source-specific and the lock proven real. A settlement's own
// `source='reversal'` rides the same carve-out (its mirror is trace-free on the same accounts), and an
// ordinary reversal into the locked period does not.
//
// And the reversal is OWNED: the raw `reverse_entry` tool (and the bare `reverseEntry` function) refuse
// a settlement target `owned_by {verb: 'vat_settlement_reverse'}`, because only that verb moves the
// `vat_settlement` row beside the mirror. Reversed through the raw tool, the row stayed `posted` with no
// reversal id and the period could never be settled again (critic finding, 2026-09-09).

import test from 'node:test';
import assert from 'node:assert/strict';

import { makeContext } from '../../dist/core/context.js';
import { postEntry, reverseEntry, ledgerPorts, hardCloseYear } from '../../dist/core/ledger/index.js';
// The owned reversal is an internal seam, deliberately NOT on the ledger index (the P3 guard pins that
// list): only an owning verb imports it, by module path, the way `vatSettlement.ts` does.
import { reverseOwnedEntry, OWNED_REVERSAL_SOURCES } from '../../dist/core/ledger/reverseEntry.js';
import { VAT_SETTLEMENT_ACCOUNTS, VAT_SETTLEMENT_SOURCE } from '../../dist/core/ledger/postEntry.js';
import { markVatPeriodFiled } from '../../dist/core/vat/index.js';
import { getAction } from '../../dist/api/registry.js';
import { setup } from '../vat/support.mjs';
import { freshDeps, mintWorkspace } from '../api/support.mjs';

/** The workspace seen through the REAL A03 ports, so a filed period actually refuses a post. */
function enforcing({ store, workspaceId, clock, ids }) {
  return makeContext(store, { workspaceId, actor: 'user_1', clock, ids, ...ledgerPorts({ store, workspaceId, ids }) });
}

function acc(ctx, number) {
  const row = ctx.store.db.prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?').get(ctx.workspaceId, number);
  assert.ok(row, `account ${number} is seeded`);
  return row.id;
}

let n = 0;
const key = (tag) => `carveout-${tag}-${(n += 1)}`;

/** A filed 2026-Q2 on an effektiv/soll workspace, through A07's own filing verb. */
function filedWorld() {
  const world = setup({ method: 'effektiv', timing: 'soll' });
  const ctx = enforcing(world);
  const filed = markVatPeriodFiled(ctx, { period: '2026-Q2', idempotencyKey: key('file') });
  assert.equal(filed.ok, true, JSON.stringify(filed));
  return { ...world, ctx };
}

const settlementLines = (ctx, amount = 8100) => [
  { account: acc(ctx, '2200'), debit: amount },
  { account: acc(ctx, '2201'), credit: amount },
];

function entryCount(ctx) {
  return ctx.store.db.prepare('SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ?').get(ctx.workspaceId).n;
}

test('the enum: VAT_SETTLEMENT_ACCOUNTS is exactly the four tax accounts plus 3809 (Q3), and the source is named', () => {
  assert.deepEqual([...VAT_SETTLEMENT_ACCOUNTS], ['1170', '1171', '2200', '2201', '3809']);
  assert.equal(VAT_SETTLEMENT_SOURCE, 'vat_settlement');
});

test('ADMISSION: a trace-free settlement on the tax accounts posts INTO the filed, hard-locked period', () => {
  const { ctx } = filedWorld();
  // The control first: the lock is real. The identical lines under `manual` are refused.
  const control = postEntry(ctx, { date: '2026-06-30', source: 'manual', idempotencyKey: key('ctl'), lines: settlementLines(ctx) });
  assert.equal(control.ok, false);
  assert.equal(control.error, 'period_locked');
  assert.equal(control.reason, 'vat_filed');

  const settled = postEntry(ctx, {
    date: '2026-06-30',
    source: VAT_SETTLEMENT_SOURCE,
    idempotencyKey: key('ok'),
    description: 'MWST-Saldierung 2026-Q2',
    lines: settlementLines(ctx),
  });
  assert.equal(settled.ok, true, JSON.stringify(settled));
  const row = ctx.store.db.prepare('SELECT source, date, status FROM journal_entry WHERE id = ?').get(settled.entryId);
  assert.deepEqual(row, { source: 'vat_settlement', date: '2026-06-30', status: 'posted' });
});

test('ADMISSION covers every settlement account, 1170 / 1171 / 2200 / 2201 and 3809 under Q3', () => {
  const { ctx } = filedWorld();
  // 3809 ships with the KMU seed since A38 (N2, `kmuSeed.ts`); `acc` throws if it did not.
  assert.equal(typeof acc(ctx, '3809'), 'string');
  const r = postEntry(ctx, {
    date: '2026-06-30',
    source: VAT_SETTLEMENT_SOURCE,
    idempotencyKey: key('all'),
    lines: [
      { account: acc(ctx, '2200'), debit: 8100 },
      { account: acc(ctx, '2201'), credit: 8100 },
      { account: acc(ctx, '2201'), debit: 1000 },
      { account: acc(ctx, '1170'), credit: 600 },
      { account: acc(ctx, '1171'), credit: 400 },
      { account: acc(ctx, '3809'), debit: 50 },
      { account: acc(ctx, '2201'), credit: 50 },
    ],
  });
  assert.equal(r.ok, true, JSON.stringify(r));
});

test('REJECTION 1: a settlement line carrying a VAT trace is invalid_line "a settlement carries no VAT trace", and nothing is written', () => {
  const { ctx } = filedWorld();
  const before = entryCount(ctx);
  for (const trace of [{ taxCode: 'UST81' }, { taxBase: 100000 }, { taxAmount: 8100 }]) {
    const r = postEntry(ctx, {
      date: '2026-06-30',
      source: VAT_SETTLEMENT_SOURCE,
      idempotencyKey: key('trace'),
      lines: [
        { account: acc(ctx, '2200'), debit: 8100, ...trace },
        { account: acc(ctx, '2201'), credit: 8100 },
      ],
    });
    assert.equal(r.ok, false, JSON.stringify(trace));
    assert.equal(r.error, 'invalid_line');
    assert.equal(r.reason, 'a settlement carries no VAT trace');
  }
  assert.equal(entryCount(ctx), before, 'a refused settlement writes nothing');
});

test('REJECTION 2: a settlement line outside the tax accounts is invalid_line "settlement_account", so the carve-out cannot move cash or revenue into a filed period', () => {
  const { ctx } = filedWorld();
  const before = entryCount(ctx);
  for (const [number, side] of [['1020', 'credit'], ['3200', 'credit'], ['6500', 'debit']]) {
    const lines =
      side === 'credit'
        ? [{ account: acc(ctx, '2200'), debit: 8100 }, { account: acc(ctx, number), credit: 8100 }]
        : [{ account: acc(ctx, number), debit: 8100 }, { account: acc(ctx, '2201'), credit: 8100 }];
    const r = postEntry(ctx, { date: '2026-06-30', source: VAT_SETTLEMENT_SOURCE, idempotencyKey: key('acct'), lines });
    assert.equal(r.ok, false, number);
    assert.equal(r.error, 'invalid_line');
    assert.equal(r.reason, 'settlement_account');
    assert.equal(r.account, acc(ctx, number), 'the offending line is named');
    assert.deepEqual(r.allowed, ['1170', '1171', '2200', '2201', '3809']);
  }
  // Rejection 2 also holds on an OPEN period: the condition is about the source, not the lock.
  const open = postEntry(ctx, {
    date: '2026-08-31',
    source: VAT_SETTLEMENT_SOURCE,
    idempotencyKey: key('open'),
    lines: [{ account: acc(ctx, '2200'), debit: 100 }, { account: acc(ctx, '1020'), credit: 100 }],
  });
  assert.equal(open.error, 'invalid_line');
  assert.equal(open.reason, 'settlement_account');
  assert.equal(entryCount(ctx), before);
});

test('REJECTION 3: a settlement dated inside a year_close SEAL is period_locked {reason: year_close}, even though it would pass a filing lock', () => {
  const { ctx } = filedWorld();
  const sealed = hardCloseYear(ctx, { year: 2026, idempotencyKey: key('seal') });
  assert.equal(sealed.ok, true, JSON.stringify(sealed));
  const before = entryCount(ctx);
  const r = postEntry(ctx, { date: '2026-06-30', source: VAT_SETTLEMENT_SOURCE, idempotencyKey: key('sealed'), lines: settlementLines(ctx) });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'period_locked');
  assert.equal(r.reason, 'year_close');
  assert.equal(r.period, '2026');
  assert.equal(entryCount(ctx), before);
  // And the seal is reported even when the MONTH carries its own vat_filed lock (the A03 masking fix).
  const q4 = postEntry(ctx, { date: '2026-12-31', source: VAT_SETTLEMENT_SOURCE, idempotencyKey: key('q4'), lines: settlementLines(ctx) });
  assert.equal(q4.error, 'period_locked');
  assert.equal(q4.reason, 'year_close');
});

test('the OWNED reversal of a settlement rides the same carve-out into the filed period; the raw reverseEntry is owned_by; an ordinary reversal does not ride it', () => {
  const { ctx } = filedWorld();
  const settled = postEntry(ctx, { date: '2026-06-30', source: VAT_SETTLEMENT_SOURCE, idempotencyKey: key('s'), lines: settlementLines(ctx) });
  assert.equal(settled.ok, true);
  const before = entryCount(ctx);
  // The raw function (what the `reverse_entry` tool calls) is refused BY NAME, and writes nothing.
  const raw = reverseEntry(ctx, { entryId: settled.entryId, date: '2026-06-30', idempotencyKey: key('raw') });
  assert.equal(raw.ok, false, `the raw reverseEntry must not reverse a settlement: ${JSON.stringify(raw)}`);
  assert.deepEqual(raw, { ok: false, error: 'owned_by', verb: 'vat_settlement_reverse', entryId: settled.entryId, source: 'vat_settlement', ownedEntryId: settled.entryId, ownedSource: 'vat_settlement' });
  assert.equal(entryCount(ctx), before);
  // A caller naming the wrong owner is refused the same way: the owner is the verb, not any string.
  const impostor = reverseOwnedEntry(ctx, { entryId: settled.entryId, date: '2026-06-30', idempotencyKey: key('imp') }, 'fx_revaluation_reverse');
  assert.equal(impostor.error, 'owned_by');
  // The settlement's owner is the verb by name; A38's other two sources joined the map at the N2
  // integration, and A22's `fx` on the critic's BLOCKING finding of 2026-09-10.
  assert.equal(OWNED_REVERSAL_SOURCES.vat_settlement, 'vat_settlement_reverse');
  assert.deepEqual(Object.keys(OWNED_REVERSAL_SOURCES).sort(), ['accrual', 'fx', 'provision', 'vat_settlement']);

  const reversed = reverseOwnedEntry(ctx, { entryId: settled.entryId, date: '2026-06-30', idempotencyKey: key('rev') }, 'vat_settlement_reverse');
  assert.equal(reversed.ok, true, JSON.stringify(reversed));
  const rev = ctx.store.db.prepare('SELECT source, date, reverses_entry_id FROM journal_entry WHERE id = ?').get(reversed.reversalId);
  assert.deepEqual(rev, { source: 'reversal', date: '2026-06-30', reverses_entry_id: settled.entryId });

  // The control: an ordinary posted entry from before the filing cannot be reversed INTO the lock.
  const ordinary = postEntry(ctx, {
    date: '2026-03-15',
    source: 'manual',
    idempotencyKey: key('ord'),
    lines: [{ account: acc(ctx, '1020'), debit: 500 }, { account: acc(ctx, '3200'), credit: 500 }],
  });
  assert.equal(ordinary.ok, true);
  const blocked = reverseEntry(ctx, { entryId: ordinary.entryId, date: '2026-06-30', idempotencyKey: key('ordrev') });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error, 'period_locked');
  assert.equal(blocked.reason, 'vat_filed');
});

test('the reversal of a settlement is STILL refused into a year_close seal (condition 3 has no reversal exception)', () => {
  const { ctx } = filedWorld();
  const settled = postEntry(ctx, { date: '2026-06-30', source: VAT_SETTLEMENT_SOURCE, idempotencyKey: key('s2'), lines: settlementLines(ctx) });
  assert.equal(settled.ok, true);
  assert.equal(hardCloseYear(ctx, { year: 2026, idempotencyKey: key('seal2') }).ok, true);
  const r = reverseOwnedEntry(ctx, { entryId: settled.entryId, date: '2026-06-30', idempotencyKey: key('rev2') }, 'vat_settlement_reverse');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'period_locked');
  assert.equal(r.reason, 'year_close');
});

test('the close relaxation is unchanged: a source=close entry still posts over a filing lock and still refuses a VAT trace', () => {
  const { ctx } = filedWorld();
  const closeOk = postEntry(ctx, {
    date: '2026-06-30',
    source: 'close',
    idempotencyKey: key('close'),
    lines: [{ account: acc(ctx, '3200'), debit: 100 }, { account: acc(ctx, '2979'), credit: 100 }],
  });
  assert.equal(closeOk.ok, true, JSON.stringify(closeOk));
  const traced = postEntry(ctx, {
    date: '2026-06-30',
    source: 'close',
    idempotencyKey: key('closetrace'),
    lines: [{ account: acc(ctx, '3200'), debit: 100, taxCode: 'UST81' }, { account: acc(ctx, '2979'), credit: 100 }],
  });
  assert.equal(traced.error, 'invalid_line');
  assert.equal(traced.reason, 'a close entry carries no VAT trace');
});

test('TRIPWIRE: the agent-facing post_entry boundary refuses source=vat_settlement, so only the settlement verb reaches the carve-out', () => {
  const deps = freshDeps();
  const { workspaceId, accId } = mintWorkspace(deps);
  const r = getAction('post_entry').run(deps, {
    workspaceId,
    date: '2026-06-30',
    source: 'vat_settlement',
    idempotencyKey: 'tripwire-1',
    lines: [{ account: accId('2200'), debit: 100 }, { account: accId('2201'), credit: 100 }],
  });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'invalid_source');
  assert.ok(!r.allowed.includes('vat_settlement'));
});

test('OWNED: the raw reverse_entry TOOL refuses a settlement entry owned_by vat_settlement_reverse; the owned verb reverses it with the row in sync, and the period settles again', () => {
  const deps = freshDeps();
  const { workspaceId, accId } = mintWorkspace(deps);
  const run = (name, input) => getAction(name).run(deps, { workspaceId, ...input });
  run('vat_seed_defaults', {});
  run('set_vat_method', { vatMethod: 'effektiv', vatAccounting: 'soll' });
  const sale = run('post_entry', {
    date: '2026-05-10',
    source: 'manual',
    idempotencyKey: 'owned-sale',
    lines: [{ account: accId('1100'), debit: 108_100 }, { account: accId('3200'), credit: 100_000, taxCode: 'UST81' }, { account: accId('2200'), credit: 8_100 }],
  });
  assert.equal(sale.ok, true, JSON.stringify(sale));
  assert.equal(run('vat_mark_filed', { period: '2026-Q2', idempotencyKey: 'owned-file' }).ok, true);
  const posted = run('vat_settlement_post', { period: '2026-Q2', idempotencyKey: 'owned-post' });
  assert.equal(posted.ok, true, JSON.stringify(posted));
  const bal2200 = () =>
    deps.store.db
      .prepare(`SELECT COALESCE(SUM(l.base_debit_minor - l.base_credit_minor), 0) AS net FROM journal_line l JOIN journal_entry e ON e.id = l.entry_id JOIN account a ON a.id = l.account_id WHERE e.workspace_id = ? AND a.number = '2200' AND e.status = 'posted'`)
      .get(workspaceId).net;
  assert.equal(bal2200(), 0, 'the settlement emptied 2200');

  // The raw tool, the agent's generic correction: refused by name, 2200 untouched, the row untouched.
  const raw = run('reverse_entry', { entryId: posted.entryId, date: '2026-06-30', idempotencyKey: 'owned-raw' });
  assert.equal(raw.ok, false, `reverse_entry must refuse a settlement target: ${JSON.stringify(raw)}`);
  assert.equal(raw.error, 'owned_by');
  assert.equal(raw.verb, 'vat_settlement_reverse');
  assert.equal(raw.entryId, posted.entryId);
  assert.equal(bal2200(), 0);
  const rowRaw = deps.store.db.prepare('SELECT status, reversal_entry_id FROM vat_settlement WHERE id = ?').get(posted.settlementId);
  assert.deepEqual(rowRaw, { status: 'posted', reversal_entry_id: null });

  // The owning verb: the mirror posts AND the row moves in the same transaction, in sync with the journal.
  const owned = run('vat_settlement_reverse', { settlementId: posted.settlementId, idempotencyKey: 'owned-rev' });
  assert.equal(owned.ok, true, JSON.stringify(owned));
  assert.equal(bal2200(), -8_100, 'the invoiced tax is back on 2200');
  const row = deps.store.db.prepare('SELECT status, reversal_entry_id FROM vat_settlement WHERE id = ?').get(posted.settlementId);
  const mirror = deps.store.db.prepare('SELECT id, source FROM journal_entry WHERE workspace_id = ? AND reverses_entry_id = ?').get(workspaceId, posted.entryId);
  assert.deepEqual(row, { status: 'reversed', reversal_entry_id: mirror.id });
  assert.equal(mirror.source, 'reversal');
  assert.equal(owned.reversalEntryId, mirror.id);

  // The desync the raw path caused is gone: the period settles again under a new key.
  const again = run('vat_settlement_post', { period: '2026-Q2', idempotencyKey: 'owned-post-2' });
  assert.equal(again.ok, true, JSON.stringify(again));
  assert.notEqual(again.settlementId, posted.settlementId);
  assert.equal(bal2200(), 0);
});
