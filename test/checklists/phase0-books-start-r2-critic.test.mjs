/**
 * Non-author critic probes, round 2 (critic/phase0-installable-r1), on the `first_posting` books-start
 * source (`src/core/checklists/periods.ts`, `booksStartOf` + `periodPredatesBooks`) at daf68e09.
 * Synthetic data only.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';

const { getAction } = await import('../../dist/api/registry.js');
const chk = await import('../../dist/core/checklists/index.js');
const { freshDeps, mintWorkspace } = await import('../api/support.mjs');

const must = (res, what) => {
  assert.equal(res.ok, true, `${what} failed: ${JSON.stringify(res)}`);
  return res;
};

function createdOn(seed, iso) {
  const deps = freshDeps();
  deps.actor = 'studio';
  let today = iso;
  deps.clock = { now: () => today };
  const { workspaceId, accId } = mintWorkspace(deps, 'Nachtrag GmbH', `${seed}-ws`);
  const call = (name, input) => getAction(name).run(deps, { workspaceId, ...input });
  must(call('vat_seed_defaults', {}), 'seed vat');
  must(call('set_vat_method', { vatMethod: 'effektiv', vatAccounting: 'soll' }), 'method');
  const post = (date, key, source = 'manual') =>
    must(
      call('post_entry', {
        date,
        source,
        description: 'Büromaterial',
        idempotencyKey: key,
        lines: [
          { account: accId('6500'), debit: 12000 },
          { account: accId('1020'), credit: 12000 },
        ],
      }),
      `post ${date}`,
    );
  const ctx = () => ({ store: deps.store, workspaceId, clock: deps.clock });
  return { deps, workspaceId, call, post, ctx, at: (d) => (today = d) };
}

const vatRuns = (w) => must(w.call('checklist_list', { templateId: 'vat_period' }), 'vat').runs.map((r) => r.periodLabel);

test('r2 item 1: reversal-only books are no first posting; the reversed original still is (append-only keeps it posted)', () => {
  const w = createdOn('rev', '2026-10-05T08:00:00.000Z');
  const orig = w.post('2026-07-14', 'bp-jul');
  const entryId = orig.entryId ?? orig.entry?.id;
  const rev = w.call('reverse_entry', { entryId, idempotencyKey: 'rev-jul' });
  const bs = chk.booksStartOf(w.ctx());
  const origStatus = w.deps.store.db.prepare('SELECT status FROM journal_entry WHERE id = ?').get(entryId).status;
  if (origStatus === 'posted') {
    assert.equal(bs.source, 'first_posting', JSON.stringify({ bs, rev }));
    assert.equal(bs.date, '2026-07-14');
  } else {
    // A reversed original leaves the workspace-created bound: a Q3 whose only activity nets to zero.
    assert.equal(bs.source, 'workspace_created', JSON.stringify({ bs, origStatus }));
  }
  assert.equal(rev.ok, true, JSON.stringify(rev));
  // A reversal dated EARLIER than any other posting must never become the first posting by itself.
  const only = createdOn('rev-only', '2026-10-05T08:00:00.000Z');
  only.deps.store.db
    .prepare(
      `INSERT INTO journal_entry (id, workspace_id, date, status, source, created_at)
       VALUES ('je_rev_only', ?, '2026-07-01', 'posted', 'reversal', '2026-10-05T08:00:00.000Z')`,
    )
    .run(only.workspaceId);
  assert.equal(chk.booksStartOf(only.ctx()).source, 'workspace_created');
});

test('r2 item 1: a far-back typo date can only re-enable the LAST ended period (the auto-start never starts an older one)', () => {
  const w = createdOn('typo', '2026-10-05T08:00:00.000Z');
  w.post('2016-07-14', 'typo-2016');
  assert.equal(chk.booksStartOf(w.ctx()).date, '2016-07-14');
  w.at('2026-10-06T03:00:00.000Z');
  must(w.call('run_due_automations', { asOf: '2026-10-06T03:00:00.000Z' }), 'tick');
  assert.deepEqual(vatRuns(w), ['2026-Q3'], 'only the last ended quarter, never 2016');
  const months = must(w.call('checklist_list', { templateId: 'month_close' }), 'm').runs.map((r) => r.periodLabel);
  assert.deepEqual(months, ['2026-09']);
});

test(
  'r2 R2-3 (fixed): a hand back-posting labelled source "import" still keeps its MWST reminder',
  () => {
    const w = createdOn('imp', '2026-10-05T08:00:00.000Z');
    w.post('2026-07-14', 'imp-jul', 'import');
    w.at('2026-10-06T03:00:00.000Z');
    must(w.call('run_due_automations', { asOf: '2026-10-06T03:00:00.000Z' }), 'tick');
    assert.deepEqual(vatRuns(w), ['2026-Q3']);
  },
);

test('R2-3 fix: the engine\'s own opening postings (A04 opening-balances:, A19 bank-opening:) still never count as a first posting', () => {
  const w = createdOn('own-openings', '2026-10-05T08:00:00.000Z');
  // A04: the workspace opening position, dated at its Stichtag.
  must(
    w.call('set_opening_balances', {
      asOf: '2026-07-01',
      lines: [{ account: '1020', debitMinor: 500000 }, { account: '2800', creditMinor: 500000 }],
      idempotencyKey: 'ob-1',
    }),
    'A04 opening',
  );
  assert.deepEqual(chk.booksStartOf(w.ctx()), { date: '2026-07-01', source: 'opening_balance', inclusive: false });
  const imports = w.deps.store.db
    .prepare("SELECT idempotency_key FROM journal_entry WHERE workspace_id = ? AND source = 'import'")
    .all(w.ctx().workspaceId)
    .map((r) => r.idempotency_key);
  assert.ok(imports.length > 0 && imports.every((k) => k.startsWith('opening-balances:')), JSON.stringify(imports));
  // The same prefix on a NON-import entry is activity: only the engine's opening writers are excluded.
  w.post('2026-06-20', 'opening-balances:2026:forged', 'manual');
  assert.equal(chk.booksStartOf(w.ctx()).source, 'first_posting');
});
