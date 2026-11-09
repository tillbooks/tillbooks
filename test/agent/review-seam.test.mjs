/**
 * A26 -> A25 INTEGRATION SEAM (batch-1). Proves `reviewSeam` (src/core/agent/reviewSeam.ts) now
 * reaches A25's REAL review module rather than the old declining local default.
 *
 * The seam was built against a narrow interface with a `review_unavailable` stub so A26 could gate
 * standalone while A25 was built concurrently. At integration the stub was replaced by A25's exported
 * `flagEntry`/`preparePeriod`. These assertions bite on that wiring: the seam must actually RECORD an
 * `entry_review` flag row (not decline), must be idempotent on ROWS through the derived key, and
 * `preparePeriod` must reach the real packet builder rather than answer `review_unavailable`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { reviewSeam } from '../../dist/core/agent/index.js';
import { makeContext } from '../../dist/core/context.js';
import { freshDeps, mintWorkspace, manualPost } from '../api/support.mjs';

function fixture(seed = 'seam') {
  const deps = freshDeps();
  const { workspaceId, accId } = mintWorkspace(deps, 'Seam AG', `${seed}-ws`);
  const call = (name, input) => getAction(name).run(deps, { workspaceId, ...input });
  const ctx = makeContext(deps.store, { workspaceId });
  return { deps, workspaceId, accId, call, ctx };
}

function flagRows(deps, workspaceId, entryId) {
  return deps.store.db
    .prepare(
      "SELECT * FROM entry_review WHERE workspace_id = ? AND entry_id = ? AND kind = 'flag' ORDER BY id",
    )
    .all(workspaceId, entryId);
}

test('seam.flagEntry reaches the real A25 review module and RECORDS a flag', () => {
  const fx = fixture('flag');
  const posted = fx.call('post_entry', manualPost(fx.accId, 'seam-seed'));
  assert.equal(posted.ok, true, JSON.stringify(posted));

  // Before: no review row exists for the entry.
  assert.equal(flagRows(fx.deps, fx.workspaceId, posted.entryId).length, 0);

  const res = reviewSeam.flagEntry(fx.ctx, {
    entryId: posted.entryId,
    reason: 'Beleg fehlt (agent anomaly)',
  });
  assert.equal(res.ok, true, `seam should record, not decline: ${JSON.stringify(res)}`);
  assert.notEqual(res.reason, 'review_unavailable');

  // A real entry_review 'flag' row now exists, with the reason carried as the comment.
  const rows = flagRows(fx.deps, fx.workspaceId, posted.entryId);
  assert.equal(rows.length, 1, 'exactly one flag row recorded');
  assert.equal(rows[0].status, 'flagged');

  // The verb-level status read (posted 2026-03) sees the seam's flag: it truly reached the sidecar.
  const status = fx.call('review_status', { period: '2026-03' });
  assert.equal(status.ok, true, JSON.stringify(status));
  assert.equal(status.flagged, 1, `the flagged count reflects the seam's write: ${JSON.stringify(status)}`);
});

test('seam.flagEntry is idempotent on ROWS via the derived key', () => {
  const fx = fixture('idem');
  const posted = fx.call('post_entry', manualPost(fx.accId, 'idem-seed'));
  assert.equal(posted.ok, true);

  const first = reviewSeam.flagEntry(fx.ctx, { entryId: posted.entryId, reason: 'dup check' });
  const second = reviewSeam.flagEntry(fx.ctx, { entryId: posted.entryId, reason: 'dup check' });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(second.ok, true, JSON.stringify(second));

  // The derived key (`agent-flag:<entryId>`) collapses the redelivery: still exactly one row.
  assert.equal(flagRows(fx.deps, fx.workspaceId, posted.entryId).length, 1);
});

test('seam.preparePeriod reaches the real A25 packet builder, not the stub', () => {
  const fx = fixture('prep');
  const posted = fx.call('post_entry', manualPost(fx.accId, 'prep-seed'));
  assert.equal(posted.ok, true);

  const res = reviewSeam.preparePeriod(fx.ctx, { period: '2026-03' });
  // The stub answered { ok:false, reason:'review_unavailable' }. The real module answers a packet.
  assert.notEqual(res.reason, 'review_unavailable', 'seam must not fall back to the local stub');
  assert.equal(res.ok, true, `real preparePeriod should answer ok: ${JSON.stringify(res)}`);
});
