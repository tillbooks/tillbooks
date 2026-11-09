// A34 money path: one STANDING wage journal per month (D173, owner decision Q7, 15.10.2026).
//
// Before D173 `wage_journal_post` deduplicated only on the idempotency key: a second confirm for the
// same month under a new key booked the wages twice. The month is the `YYYY-MM` of `entry_date`, the
// only period field the hand-off carries. A posting STANDS while its entry has an EVEN chain of posted
// mirrors (zero included), walked by D171's own `wageJournalChain`; a reversed posting frees the month.
//
// SYNTHETIC BY CONSTRUCTION: no employee, no name, no AHV number; the journal is an invented aggregate
// on the shipped KMU chart (the same canonical lines the rest of this suite uses).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { postEntry } from '../../dist/core/ledger/index.js';
import { reverseOwnedEntry } from '../../dist/core/ledger/reverseEntry.js';
import { wageJournalPost, wageJournalReverse, listPayrollHandoffs } from '../../dist/core/payroll/index.js';
import { setup, counts, wageLines, secondWorkspace } from './support.mjs';

const DATE = '2026-07-05';

function must(res, what = 'call') {
  assert.equal(res.ok, true, `${what} failed: ${JSON.stringify(res)}`);
  return res;
}

const post = (ctx, key, entryDate = DATE) =>
  wageJournalPost(ctx, { lines: wageLines(), entryDate, confirm: true, idempotencyKey: key });

test('D173: a second post for the same month under a new key refuses month_already_posted and writes nothing', () => {
  const t = setup();
  const first = must(post(t.ctx, 'm-1'), 'first post');
  const before = counts(t.store, t.workspaceId);

  const again = post(t.ctx, 'm-2', '2026-07-28'); // another day, same month
  assert.equal(again.ok, false);
  assert.equal(again.error, 'month_already_posted');
  assert.equal(again.month, '2026-07');
  assert.equal(again.wageJournalPostId, first.wageJournalPostId, 'names the standing posting');
  assert.equal(again.postedEntryId, first.postedEntryId, 'names the standing entry');
  assert.match(again.hint, /wage_journal_reverse/);
  assert.deepEqual(counts(t.store, t.workspaceId), before, 'nothing written');

  // The preview (dial off) still works: it writes nothing and the refusal lands at confirm.
  const pv = wageJournalPost(t.ctx, { lines: wageLines(), entryDate: DATE, idempotencyKey: 'm-3' });
  assert.equal(pv.ok, true);
  // Another month is free.
  must(post(t.ctx, 'm-4', '2026-08-05'), 'next month');
});

test('D173: the same idempotencyKey replay of the first post still replays, before the month guard', () => {
  const t = setup();
  const first = must(post(t.ctx, 'r-1'), 'first post');
  const before = counts(t.store, t.workspaceId);
  const replay = must(post(t.ctx, 'r-1'), 'replay');
  assert.equal(replay.wageJournalPostId, first.wageJournalPostId);
  assert.equal(replay.postedEntryId, first.postedEntryId);
  assert.deepEqual(counts(t.store, t.workspaceId), before, 'idempotent on ROWS');
});

test('D173: after wage_journal_reverse (odd chain) the month is free and the corrected journal posts', () => {
  const t = setup();
  const first = must(post(t.ctx, 'c-1'), 'first post');
  must(wageJournalReverse(t.ctx, { wageJournalPostId: first.wageJournalPostId, reason: 'Falscher Betrag', idempotencyKey: 'c-rev' }), 'reverse');
  const corrected = must(post(t.ctx, 'c-2'), 'corrected re-import');
  assert.notEqual(corrected.postedEntryId, first.postedEntryId);
  // And now the corrected one stands, so a third refuses naming IT, not the reversed one.
  const third = post(t.ctx, 'c-3');
  assert.equal(third.error, 'month_already_posted');
  assert.equal(third.wageJournalPostId, corrected.wageJournalPostId);
  assert.equal(third.standing.length, 1);
});

test('D173 parity: an EVEN non-empty chain (a mirror itself reversed) means the posting stands again and blocks the month', () => {
  const t = setup();
  const first = must(post(t.ctx, 'e-1'), 'first post');
  const r1 = must(wageJournalReverse(t.ctx, { wageJournalPostId: first.wageJournalPostId, reason: 'x', idempotencyKey: 'e-r1' }), 'reverse');
  // The Storno of the Storno a pre-D171 book could carry, simulated under the owner token (as the D171
  // suite does): a posted mirror of R1, so the chain is W -> R1 -> R2, even, and W stands again.
  must(reverseOwnedEntry(t.ctx, { entryId: r1.reversalEntryId, idempotencyKey: 'e-r2' }, 'wage_journal_reverse'), 'raw Storno of the Storno');
  const again = post(t.ctx, 'e-2');
  assert.equal(again.error, 'month_already_posted', 'an even chain stands');
  assert.equal(again.wageJournalPostId, first.wageJournalPostId);
});

test('D173 §H-TENANT: another workspace posting the same month is unaffected', () => {
  const t = setup();
  must(post(t.ctx, 't-1'), 'workspace A');
  const other = secondWorkspace(t);
  must(post(other.ctx, 't-1'), 'workspace B, same month, same key');
  must(post(other.ctx, 't-2', '2026-06-30'), 'workspace B, another month');
  assert.equal(post(other.ctx, 't-3').error, 'month_already_posted', 'B is guarded on its own posting');
});

test('D173 legacy: a book already holding two standing postings for one month stays readable and refuses a third until the duplicate is reversed, after which one still stands', () => {
  const t = setup();
  const a = must(post(t.ctx, 'l-1'), 'first');
  const b = seedLegacyDuplicate(t, DATE);
  const list = must(listPayrollHandoffs(t.ctx, {}), 'list still reads');
  const postings = list.handoffs.filter((r) => r.type === 'posting');
  assert.equal(postings.length, 2);
  assert.ok(postings.every((r) => r.reversalEntryId === null), 'both stand');

  const third = post(t.ctx, 'l-3');
  assert.equal(third.error, 'month_already_posted');
  assert.deepEqual(third.standing.map((s) => s.wageJournalPostId), [a.wageJournalPostId, b]);

  // The owner's fix: reverse the duplicate. One then still stands, so the month stays taken.
  must(wageJournalReverse(t.ctx, { wageJournalPostId: b, reason: 'Doppelt gebucht', idempotencyKey: 'l-rev' }), 'reverse the duplicate');
  const fourth = post(t.ctx, 'l-4');
  assert.equal(fourth.error, 'month_already_posted');
  assert.equal(fourth.wageJournalPostId, a.wageJournalPostId);
  assert.equal(fourth.standing.length, 1);
});

// --- helpers -------------------------------------------------------------------------------------

function accountIdOf(t, number) {
  return t.store.db.prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?').get(t.workspaceId, number).id;
}

/**
 * A book written before D173 could hold a second standing posting for the month. Seed one the way
 * the old engine would have: a real posted entry plus its `wage_journal_posts` row, bypassing the guard.
 */
function seedLegacyDuplicate(t, entryDate) {
  const e = must(
    postEntry(t.ctx, {
      date: entryDate,
      description: 'Lohnbuchung (vor D173 doppelt)',
      source: 'import',
      lines: [
        { account: accountIdOf(t, '5000'), debit: 500000 },
        { account: accountIdOf(t, '5700'), debit: 50000 },
        { account: accountIdOf(t, '2260'), credit: 550000 },
      ],
      idempotencyKey: 'legacy-dup',
    }),
    'legacy entry',
  );
  const id = 'wjp_legacy_dup';
  t.store.db
    .prepare(
      `INSERT INTO wage_journal_posts (id, workspace_id, posted_entry_id, entry_date, mapping_id, source_sha256, line_count, actor, created_at)
       VALUES (?, ?, ?, ?, NULL, NULL, 3, 'user_1', '2026-07-19T23:59:59.000Z')`,
    )
    .run(id, t.workspaceId, e.entryId, entryDate);
  return id;
}
