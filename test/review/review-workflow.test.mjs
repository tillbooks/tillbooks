/**
 * A25 business rules: the review workflow over the immutable journal.
 *
 * What the derived conformance floor already proves is NOT re-proven here (double-call settles,
 * §H-TENANT per verb, append-only triggers). This suite holds the rules that are A25's own:
 * the status machine (latest event wins, a comment never moves the state), the sidecar boundary
 * (§H-AUDIT: journal rows byte-identical across every review verb, asserted on the rows rather
 * than trusted to the module docblock), the not-posted fence, the approve-after-reversal note,
 * and the cross-tenant coverage read.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { freshDeps, mintWorkspace, manualPost } from '../api/support.mjs';

function fixture(seed = 'rv') {
  const deps = freshDeps();
  const { workspaceId, accId } = mintWorkspace(deps, 'Review AG', `${seed}-ws`);
  const call = (name, input) => getAction(name).run(deps, { workspaceId, ...input });
  return { deps, workspaceId, accId, call };
}

function postEntry(fx, key, amount = 5000) {
  const posted = fx.call('post_entry', manualPost(fx.accId, key, amount));
  assert.equal(posted.ok, true, `post failed: ${JSON.stringify(posted)}`);
  return posted.entryId;
}

/** Every journal row of a workspace, as a comparable string: the §H-AUDIT sidecar tripwire. */
function journalSnapshot(deps, workspaceId) {
  const entries = deps.store.db
    .prepare('SELECT * FROM journal_entry WHERE workspace_id = ? ORDER BY id')
    .all(workspaceId);
  const lines = deps.store.db
    .prepare(
      `SELECT l.* FROM journal_line l JOIN journal_entry e ON e.id = l.entry_id
        WHERE e.workspace_id = ? ORDER BY l.id`,
    )
    .all(workspaceId);
  return JSON.stringify({ entries, lines });
}

test('A25: the status machine, latest event wins and a comment moves nothing', () => {
  const fx = fixture('sm');
  const entryId = postEntry(fx, 'sm-1');

  // No event yet: open.
  let status = fx.call('review_status', { period: '2026-03' });
  assert.equal(status.ok, true);
  assert.equal(status.total, 1);
  assert.deepEqual(
    { approved: status.approved, flagged: status.flagged, open: status.open },
    { approved: 0, flagged: 0, open: 1 },
  );

  // A comment carries the status it found and moves nothing.
  const commented = fx.call('comment_entry', { entryId, text: 'Wozu?', idempotencyKey: 'sm-c1' });
  assert.equal(commented.ok, true);
  assert.equal(commented.status, 'open');
  status = fx.call('review_status', { period: '2026-03' });
  assert.equal(status.open, 1);

  // Flag moves to flagged; a later comment still moves nothing.
  assert.equal(fx.call('flag_entry', { entryId, reason: 'Beleg fehlt', idempotencyKey: 'sm-f1' }).ok, true);
  const midComment = fx.call('comment_entry', { entryId, text: 'Beleg kommt.', idempotencyKey: 'sm-c2' });
  assert.equal(midComment.status, 'flagged');
  status = fx.call('review_status', { period: '2026-03' });
  assert.deepEqual(
    { approved: status.approved, flagged: status.flagged, open: status.open },
    { approved: 0, flagged: 1, open: 0 },
  );

  // Approve wins as the latest event, and the entry row reports its history.
  assert.equal(fx.call('approve_entry', { entryId, idempotencyKey: 'sm-a1' }).ok, true);
  status = fx.call('review_status', { period: '2026-03' });
  assert.deepEqual(
    { approved: status.approved, flagged: status.flagged, open: status.open },
    { approved: 1, flagged: 0, open: 0 },
  );
  const row = status.entries.find((e) => e.entryId === entryId);
  assert.equal(row.status, 'approved');
  assert.equal(row.commentCount, 2);
  assert.equal(row.flagCount, 1);
  // Counts reconcile to the entry set (US-A25.2's "142/150" bar has to foot).
  assert.equal(status.approved + status.flagged + status.open, status.total);
});

test('A25 §H-AUDIT: every review verb leaves the journal rows byte-identical', () => {
  const fx = fixture('tw');
  const entryId = postEntry(fx, 'tw-1');
  postEntry(fx, 'tw-2', 5000); // a duplicate-shaped pair, so prepare really writes flags
  const before = journalSnapshot(fx.deps, fx.workspaceId);

  assert.equal(fx.call('comment_entry', { entryId, text: 'Frage', idempotencyKey: 'tw-c' }).ok, true);
  assert.equal(fx.call('flag_entry', { entryId, reason: 'Zweifel', idempotencyKey: 'tw-f' }).ok, true);
  assert.equal(fx.call('approve_entry', { entryId, idempotencyKey: 'tw-a' }).ok, true);
  const prepared = fx.call('prepare_period', { period: '2026-03', idempotencyKey: 'tw-p' });
  assert.equal(prepared.ok, true, JSON.stringify(prepared));
  assert.ok(prepared.packet.flags.length > 0, 'prepare found nothing to flag, so the tripwire ran vacuous');

  assert.equal(journalSnapshot(fx.deps, fx.workspaceId), before, 'a review verb touched journal rows');
});

test('A25: the review module source contains no UPDATE or DELETE statement at all', async () => {
  const { readdirSync, readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { join } = await import('node:path');
  const dir = join(fileURLToPath(new URL('../..', import.meta.url)), 'src/core/review');
  for (const file of readdirSync(dir)) {
    const source = readFileSync(join(dir, file), 'utf8')
      // Strip comments so prose ABOUT the rule cannot satisfy or violate it.
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    assert.ok(!/\b(UPDATE|DELETE)\b/.test(source), `${file} carries an UPDATE/DELETE statement`);
  }
});

test('A25: a draft is not reviewable, and an unknown entry is not_found', () => {
  const fx = fixture('df');
  const draft = fx.call('save_draft', {
    date: '2026-03-01',
    lines: [
      { account: fx.accId('6500'), debit: 700 },
      { account: fx.accId('1000'), credit: 700 },
    ],
    idempotencyKey: 'df-d',
  });
  assert.equal(draft.ok, true);
  for (const [verb, extra] of [
    ['comment_entry', { text: 'x' }],
    ['flag_entry', { reason: 'x' }],
    ['approve_entry', {}],
  ]) {
    const onDraft = fx.call(verb, { entryId: draft.entryId, idempotencyKey: `df-${verb}`, ...extra });
    assert.equal(onDraft.ok, false);
    assert.equal(onDraft.error, 'not_posted', `${verb} accepted a draft`);
    const onGhost = fx.call(verb, { entryId: 'no_such', idempotencyKey: `dg-${verb}`, ...extra });
    assert.equal(onGhost.error, 'not_found');
  }
  // A draft never appears in the coverage read either.
  const status = fx.call('review_status', { period: '2026-03' });
  assert.equal(status.total, 0);
});

test('A25: approving an already-reversed entry is allowed but noted', () => {
  const fx = fixture('ar');
  const entryId = postEntry(fx, 'ar-1');
  assert.equal(fx.call('reverse_entry', { entryId, idempotencyKey: 'ar-r' }).ok, true);
  const approved = fx.call('approve_entry', { entryId, idempotencyKey: 'ar-a' });
  assert.equal(approved.ok, true);
  assert.equal(approved.alreadyReversed, true);
  assert.match(approved.review.comment ?? '', /approved after reversal/);

  const plain = fx.call('approve_entry', { entryId: postEntry(fx, 'ar-2'), idempotencyKey: 'ar-b' });
  assert.equal(plain.alreadyReversed, false);
});

test('A25 §H-TENANT: review metadata never crosses a workspace', () => {
  const deps = freshDeps();
  const a = mintWorkspace(deps, 'Mandant A', 'ta-ws');
  const b = mintWorkspace(deps, 'Mandant B', 'tb-ws');
  const callA = (name, input) => getAction(name).run(deps, { workspaceId: a.workspaceId, ...input });
  const callB = (name, input) => getAction(name).run(deps, { workspaceId: b.workspaceId, ...input });

  const postedA = callA('post_entry', manualPost(a.accId, 'ta-1'));
  assert.equal(postedA.ok, true);
  assert.equal(callA('flag_entry', { entryId: postedA.entryId, reason: 'A only', idempotencyKey: 'ta-f' }).ok, true);

  // B cannot review A's entry by id, and B's coverage sees nothing of A.
  const cross = callB('flag_entry', { entryId: postedA.entryId, reason: 'cross', idempotencyKey: 'tb-f' });
  assert.equal(cross.error, 'not_found');
  const statusB = callB('review_status', { period: '2026-03' });
  assert.equal(statusB.total, 0);
  const statusA = callA('review_status', { period: '2026-03' });
  assert.equal(statusA.flagged, 1);
});

test('A25: review_status refuses a malformed period and accepts a year', () => {
  const fx = fixture('pp');
  postEntry(fx, 'pp-1');
  assert.equal(fx.call('review_status', { period: '2026-3' }).error, 'invalid_period');
  assert.equal(fx.call('review_status', { period: '03.2026' }).error, 'invalid_period');
  const year = fx.call('review_status', { period: '2026' });
  assert.equal(year.ok, true);
  assert.equal(year.total, 1);
});
