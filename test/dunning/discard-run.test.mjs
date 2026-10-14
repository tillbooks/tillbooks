/**
 * D161.3: a proposed Mahnlauf can be discarded.
 *
 * The defect: a run is keyed one per workspace per day (`dunning_run_per_day`), and a proposed run had
 * no way out except being issued. A wrong proposal (the wrong date, invoices that should have waited)
 * blocked the day: re-proposing returned the same run, and the only exit was to issue letters nobody
 * wanted. `discard_dunning_run` removes a PROPOSED run with its items (nothing was booked, rendered or
 * sent), records the discard in the audit trail, and frees the day's slot. An issued or sent run is
 * refused: its letters and fee stand, and a wrong fee is corrected by `reverse_entry`.
 *
 * Idempotent (a replay, or a second discard of the same run under a new key, settles to the same
 * answer and writes nothing) and §H-TENANT (another workspace's run is `not_found`, untouched).
 *
 * Synthetic data only.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { mintWorkspace } from '../api/support.mjs';
import { SCENARIOS, fixture } from '../api/conformance-contract.mjs';

/** A book with one overdue invoice and a proposed run over it, acting as a person. */
function proposed() {
  const fx = fixture();
  fx.deps.actor = 'studio';
  SCENARIOS.propose_dunning_run(fx);
  const run = fx.call('propose_dunning_run', { idempotencyKey: 'p-1' });
  assert.equal(run.ok, true, JSON.stringify(run));
  assert.equal(run.proposed, true);
  return { fx, runId: run.runId };
}

const count = (fx, sql, ...p) => fx.deps.store.db.prepare(sql).get(...p).n;

test('a proposed run is discarded with its items, the day slot frees, and the discard is on the audit trail', () => {
  const { fx, runId } = proposed();
  assert.equal(fx.call('propose_dunning_run', { idempotencyKey: 'p-2' }).runId, runId, 'premise: the day is taken');

  const res = fx.call('discard_dunning_run', { runId, idempotencyKey: 'd-1' });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.discarded, true);
  assert.equal(count(fx, 'SELECT COUNT(*) AS n FROM dunning_run WHERE id = ?', runId), 0);
  assert.equal(count(fx, 'SELECT COUNT(*) AS n FROM dunning_item WHERE run_id = ?', runId), 0);
  assert.equal(
    count(fx, "SELECT COUNT(*) AS n FROM audit_log WHERE workspace_id = ? AND entity_kind = 'dunning_run' AND entity_id = ? AND action = 'discard'", fx.workspaceId, runId),
    1,
  );
  assert.equal(fx.call('get_dunning_run', { runId }).error, 'not_found');

  // The slot is free: a new proposal the same day mints a NEW run.
  const again = fx.call('propose_dunning_run', { idempotencyKey: 'p-3' });
  assert.equal(again.ok, true, JSON.stringify(again));
  assert.equal(again.proposed, true);
  assert.notEqual(again.runId, runId);
  fx.deps.store.close();
});

test('idempotent: a replay and a second discard under a new key settle and write nothing', () => {
  const { fx, runId } = proposed();
  const first = fx.call('discard_dunning_run', { runId, idempotencyKey: 'd-1' });
  assert.equal(first.ok, true, JSON.stringify(first));
  const audits = () => count(fx, 'SELECT COUNT(*) AS n FROM audit_log WHERE workspace_id = ?', fx.workspaceId);
  const before = audits();
  assert.deepEqual(fx.call('discard_dunning_run', { runId, idempotencyKey: 'd-1' }), first);
  const second = fx.call('discard_dunning_run', { runId, idempotencyKey: 'd-2' });
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(second.alreadyDiscarded, true);
  assert.equal(audits(), before, 'a second discard wrote an audit row');
  fx.deps.store.close();
});

test('an issued run is refused: its letters and fee stand', () => {
  const fx = fixture();
  fx.deps.actor = 'studio';
  const input = SCENARIOS.issue_dunning_run(fx);
  assert.equal(fx.call('issue_dunning_run', input).ok, true);
  const res = fx.call('discard_dunning_run', { runId: input.runId, idempotencyKey: 'd-x' });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'invalid_transition');
  assert.equal(count(fx, 'SELECT COUNT(*) AS n FROM dunning_run WHERE id = ?', input.runId), 1);
  fx.deps.store.close();
});

test('critic F1, the race: a run issued between the discard\'s read and its transaction is refused whole, items intact, no audit row', () => {
  const { fx, runId } = proposed();
  const store = fx.deps.store;
  const items = () => count(fx, 'SELECT COUNT(*) AS n FROM dunning_item WHERE run_id = ?', runId);
  const itemsBefore = items();
  assert.ok(itemsBefore > 0, 'premise: the run has items');
  // Another caller issues the run in the window between the discard's checks and its write
  // transaction: the store's transaction door is where that window closes.
  const original = store.rememberIdempotent.bind(store);
  let raced = false;
  store.rememberIdempotent = (workspaceId, key, verb, compute) => {
    if (verb === 'discard_dunning_run' && !raced) {
      raced = true;
      const issued = getAction('issue_dunning_run').run({ ...fx.deps, actor: 'studio' }, { workspaceId: fx.workspaceId, runId, confirmed: true, idempotencyKey: 'race-issue' });
      assert.equal(issued.ok, true, JSON.stringify(issued));
    }
    return original(workspaceId, key, verb, compute);
  };
  const res = fx.call('discard_dunning_run', { runId, idempotencyKey: 'd-race' });
  store.rememberIdempotent = original;
  assert.equal(raced, true, 'premise: the race window was reached');
  assert.equal(res.ok, false, `an issued run was discarded: ${JSON.stringify(res)}`);
  assert.equal(res.error, 'invalid_transition');
  assert.equal(fx.deps.store.db.prepare('SELECT status FROM dunning_run WHERE id = ?').get(runId).status, 'issued');
  assert.equal(items(), itemsBefore, 'the issued run lost its items');
  assert.equal(
    count(fx, "SELECT COUNT(*) AS n FROM audit_log WHERE workspace_id = ? AND entity_kind = 'dunning_run' AND entity_id = ? AND action = 'discard'", fx.workspaceId, runId),
    0,
  );
  // The refusal was not remembered: the key is still free, and a retry answers the same refusal.
  assert.equal(fx.call('discard_dunning_run', { runId, idempotencyKey: 'd-race' }).error, 'invalid_transition');
  fx.deps.store.close();
});

test('§H-TENANT: another workspace cannot discard the run, and does not learn it exists', () => {
  const { fx, runId } = proposed();
  const other = mintWorkspace(fx.deps, 'Fremd AG', 'other-ws');
  const res = getAction('discard_dunning_run').run(fx.deps, { workspaceId: other.workspaceId, runId, idempotencyKey: 'd-t' });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'not_found');
  assert.equal(count(fx, 'SELECT COUNT(*) AS n FROM dunning_run WHERE id = ?', runId), 1);
  // And after the owner discards it, the other workspace still reads not_found, never alreadyDiscarded.
  assert.equal(fx.call('discard_dunning_run', { runId, idempotencyKey: 'd-o' }).ok, true);
  assert.equal(getAction('discard_dunning_run').run(fx.deps, { workspaceId: other.workspaceId, runId, idempotencyKey: 'd-t2' }).error, 'not_found');
  fx.deps.store.close();
});

test('the agent seat drafts a discard under the dun dial (D161.3): nothing is removed until a person approves', async () => {
  const { handleRest } = await import('../../dist/api/rest.js');
  const { fx, runId } = proposed();
  const body = handleRest('discard_dunning_run', { workspaceId: fx.workspaceId, runId, idempotencyKey: 'd-a' }, { ...fx.deps, actor: 'agent' }).body;
  assert.equal(body.drafted, true, JSON.stringify(body));
  assert.equal(body.dialCapability, 'dun');
  assert.equal(count(fx, 'SELECT COUNT(*) AS n FROM dunning_run WHERE id = ?', runId), 1);
  fx.deps.store.close();
});
