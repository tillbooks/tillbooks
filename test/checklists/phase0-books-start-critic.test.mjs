/**
 * Non-author critic probe (critic/phase0-installable-r1) for the P0.4a auto-start bound
 * (`booksStartOf` in `src/core/checklists/periods.ts`, applied in `checklistStart`, `runs.ts`).
 *
 * The bound's sources are a migration Stichtag, an A04 opening balance, or the day the workspace was
 * created. A company that opens TILL AFTER a quarter ended and books that quarter by hand (no G09 plan,
 * no A04 import: ordinary back-posting to prepare the MWST return it still owes) has posted entries
 * INSIDE the quarter, yet the bound is its creation day, so the MWST-Periode checklist for that quarter
 * is never auto-started. The checklist auto-start is the only proactive MWST-deadline reminder in
 * Pendenzen (no other attention provider reads VAT due dates), and the "last ended period" moves on,
 * so the reminder is lost, not late. Synthetic data only.
 *
 * FIXED (remed/phase0-installable): `booksStartOf` carries a fourth source, `first_posting`, the earliest
 * posted non-import entry, and the earliest source wins. The probe below was `todo`; it now holds.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';

const { getAction } = await import('../../dist/api/registry.js');
const { freshDeps, mintWorkspace } = await import('../api/support.mjs');

const chk = await import('../../dist/core/checklists/index.js');

const must = (res, what) => {
  assert.equal(res.ok, true, `${what} failed: ${JSON.stringify(res)}`);
  return res;
};

test(
  'critic P0.4a-1: a company created on 05.10 that books its Q3 by hand still gets the Q3 MWST-Periode auto-started',
  () => {
    const deps = freshDeps();
    deps.actor = 'studio';
    let today = '2026-10-05T08:00:00.000Z';
    deps.clock = { now: () => today };
    const { workspaceId, accId } = mintWorkspace(deps, 'Nachtrag GmbH', 'backpost-ws');
    const call = (name, input) => getAction(name).run(deps, { workspaceId, ...input });
    must(call('vat_seed_defaults', {}), 'seed vat');
    must(call('set_vat_method', { vatMethod: 'effektiv', vatAccounting: 'soll' }), 'method');
    // Q3 booked by hand after the fact: a July expense and a September expense.
    for (const [date, key] of [['2026-07-14', 'jul'], ['2026-09-22', 'sep']]) {
      must(
        call('post_entry', {
          date,
          source: 'manual',
          description: 'Büromaterial',
          idempotencyKey: `bp-${key}`,
          lines: [
            { account: accId('6500'), debit: 12000 },
            { account: accId('1020'), credit: 12000 },
          ],
        }),
        `post ${date}`,
      );
    }
    today = '2026-10-06T03:00:00.000Z';
    must(call('run_due_automations', { asOf: today }), 'tick');
    const vat = must(call('checklist_list', { templateId: 'vat_period' }), 'vat').runs.map((r) => r.periodLabel);
    assert.deepEqual(vat, ['2026-Q3'], 'the quarter these books hold entries for, whose return is still owed');
  },
);

/** A world created on `createdAt`, with a clock the test moves. */
function worldOn(seed, createdAt) {
  const deps = freshDeps();
  deps.actor = 'studio';
  let today = createdAt;
  deps.clock = { now: () => today };
  const { workspaceId, accId } = mintWorkspace(deps, 'Nachtrag GmbH', `${seed}-ws`);
  const call = (name, input) => getAction(name).run(deps, { workspaceId, ...input });
  must(call('vat_seed_defaults', {}), 'seed vat');
  must(call('set_vat_method', { vatMethod: 'effektiv', vatAccounting: 'soll' }), 'method');
  const post = (date, key) =>
    must(
      call('post_entry', {
        date,
        source: 'manual',
        description: 'Büromaterial',
        idempotencyKey: `bp-${key}`,
        lines: [
          { account: accId('6500'), debit: 12000 },
          { account: accId('1020'), credit: 12000 },
        ],
      }),
      `post ${date}`,
    );
  const ctx = { store: deps.store, workspaceId, clock: deps.clock };
  return { deps, workspaceId, call, post, ctx, at: (iso) => (today = iso) };
}

test('P0.4a-1 fix: created 30.09 and booked ON 30.09: September and Q3 auto-start (the first posting is a book day)', () => {
  const w = worldOn('same-day', '2026-09-30T08:00:00.000Z');
  w.post('2026-09-30', 'd0');
  assert.deepEqual(chk.booksStartOf(w.ctx), { date: '2026-09-30', source: 'first_posting', inclusive: true });
  w.at('2026-10-01T03:00:00.000Z');
  must(w.call('run_due_automations', { asOf: '2026-10-01T03:00:00.000Z' }), 'tick');
  assert.deepEqual(must(w.call('checklist_list', { templateId: 'month_close' }), 'months').runs.map((r) => r.periodLabel), ['2026-09']);
  assert.deepEqual(must(w.call('checklist_list', { templateId: 'vat_period' }), 'vat').runs.map((r) => r.periodLabel), ['2026-Q3']);
});

test('P0.4a-1 fix: created 30.09 with nothing booked keeps the day-0 behaviour (September ends on the creation day, nothing to close)', () => {
  const w = worldOn('same-day-empty', '2026-09-30T08:00:00.000Z');
  assert.deepEqual(chk.booksStartOf(w.ctx), { date: '2026-09-30', source: 'workspace_created', inclusive: false });
  assert.equal(chk.periodPredatesBooks('2026-09-30', chk.booksStartOf(w.ctx)), true);
  assert.equal(chk.periodPredatesBooks('2026-10-31', chk.booksStartOf(w.ctx)), false);
  w.at('2026-10-01T03:00:00.000Z');
  must(w.call('run_due_automations', { asOf: '2026-10-01T03:00:00.000Z' }), 'tick');
  assert.equal(must(w.call('checklist_list', {}), 'list').runs.length, 0);
});

test('P0.4a-1 fix: the earliest source wins, the opening position (source import) is not a first posting, and a posting ON a Stichtag leaves it the Stichtag\'s', () => {
  const w = worldOn('sources', '2026-09-30T08:00:00.000Z');
  // An A04 opening balance posts source 'import': the bound is the opening Stichtag, not a first posting.
  must(
    w.call('set_opening_balances', {
      asOf: '2026-07-01',
      lines: [{ account: '1020', debitMinor: 500000 }, { account: '2800', creditMinor: 500000 }],
      idempotencyKey: 'opening-1',
    }),
    'opening',
  );
  assert.deepEqual(chk.booksStartOf(w.ctx), { date: '2026-07-01', source: 'opening_balance', inclusive: false });
  // A posting ON the Stichtag day does not take the period ending on it from the old system.
  w.post('2026-07-01', 'on-stichtag');
  assert.deepEqual(chk.booksStartOf(w.ctx), { date: '2026-07-01', source: 'opening_balance', inclusive: false });
  // A posting before it does: the books hold an entry in that period, so the earliest source wins.
  w.post('2026-06-15', 'before');
  assert.deepEqual(chk.booksStartOf(w.ctx), { date: '2026-06-15', source: 'first_posting', inclusive: true });
  assert.equal(chk.periodPredatesBooks('2026-06-30', chk.booksStartOf(w.ctx)), false, 'June holds an entry: it starts');
  assert.equal(chk.periodPredatesBooks('2026-06-14', chk.booksStartOf(w.ctx)), true);
});

test('P0.4a-1 fix: §H-TENANT: another workspace\'s back-posting does not move this workspace\'s bound', () => {
  const deps = freshDeps();
  deps.actor = 'studio';
  const today = '2026-10-05T08:00:00.000Z';
  deps.clock = { now: () => today };
  const a = mintWorkspace(deps, 'Alpha GmbH', 'ten-a-ws');
  const b = mintWorkspace(deps, 'Beta GmbH', 'ten-b-ws');
  must(
    getAction('post_entry').run(deps, {
      workspaceId: b.workspaceId,
      date: '2026-07-14',
      source: 'manual',
      description: 'Büromaterial',
      idempotencyKey: 'b-jul',
      lines: [
        { account: b.accId('6500'), debit: 12000 },
        { account: b.accId('1020'), credit: 12000 },
      ],
    }),
    'B posts July',
  );
  const ctxA = { store: deps.store, workspaceId: a.workspaceId, clock: deps.clock };
  assert.deepEqual(chk.booksStartOf(ctxA), { date: '2026-10-05', source: 'workspace_created', inclusive: false });
});
