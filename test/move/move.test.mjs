/**
 * M03, the Move record: the invariants the spec §3.1 turns on, proven by measurement.
 *
 *  - THE POINTER IS BOOKKEEPING: absolute upsert, round-trips, resumes, replayed done keeps its
 *    original timestamp, and refuses a direction outside the §H-ENUM. §H-TENANT: one workspace's
 *    pointer is invisible to another's read, and there is at most ONE row per workspace ever.
 *  - COMPLETION IS DERIVED, HONESTLY: all five steps done stamps completed_at; un-doing a step
 *    (the step-4 trial-balance-mismatch recovery) clears it again.
 *  - A DIRECTION CHANGE IS A FRESH START: the checklist resets, never a half-carried one.
 *  - ABANDON DELETES: "Umzug abbrechen" removes the row, and replaying the abandon settles.
 *  - A COMPLETED ROW SURVIVES: the S7.5 stale-writable notice is derived from a completed move
 *    over an unarchived workspace, so completion must never delete the record.
 *  - NEVER A GATE: an unrelated write verb runs identically with and without an active move.
 *
 * M03 adds no posting logic: nothing here touches a journal row.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { MOVE_DIRECTIONS, MOVE_STEP_COUNT, isMoveDirection } from '../../dist/core/move/index.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';

const must = (res, what) => {
  assert.equal(res.ok, true, `${what} failed: ${JSON.stringify(res)}`);
  return res;
};
const refuse = (res, error, what) => {
  assert.equal(res.ok, false, `${what} should have refused: ${JSON.stringify(res)}`);
  assert.equal(res.error, error, `${what} wrong error: ${JSON.stringify(res)}`);
  return res;
};

function world(seed) {
  const deps = freshDeps();
  deps.actor = 'studio';
  const { workspaceId } = mintWorkspace(deps, 'Echt GmbH', `${seed}-ws`);
  const call = (name, input) => getAction(name).run(deps, { workspaceId, ...input });
  return { deps, wid: workspaceId, call };
}

// --- The direction enum -------------------------------------------------------------------------

test('the move direction enum admits exactly the six ladder legs and no seventh', () => {
  assert.deepEqual(
    [...MOVE_DIRECTIONS],
    [
      'local_to_selfhost',
      'local_to_managed',
      'selfhost_to_managed',
      'selfhost_to_local',
      'managed_to_local',
      'managed_to_selfhost',
    ],
  );
  assert.equal(MOVE_STEP_COUNT, 5);
  assert.equal(isMoveDirection('local_to_selfhost'), true);
  assert.equal(isMoveDirection('device_sync'), false); // D106 leaves nothing for it to mean
  assert.equal(isMoveDirection(undefined), false);
});

// --- The resume pointer -------------------------------------------------------------------------

test('advance_move_step starts, checks steps off absolutely, and get resumes it', () => {
  const { call } = world('adv');
  const empty = must(call('get_move_state', {}), 'empty read');
  assert.equal(empty.move, null);

  // Umzug starten: direction alone mints the pointer with five unchecked steps.
  const started = must(call('advance_move_step', { direction: 'local_to_selfhost' }), 'start');
  assert.equal(started.move.direction, 'local_to_selfhost');
  assert.equal(started.move.steps.length, 5);
  assert.deepEqual(started.move.steps.map((s) => s.step), [1, 2, 3, 4, 5]);
  assert.ok(started.move.steps.every((s) => s.doneAt === null));
  assert.notEqual(started.move.startedAt, null);
  assert.equal(started.move.completedAt, null);

  // Check step 1 off; the read resumes it.
  must(call('advance_move_step', { direction: 'local_to_selfhost', step: 1 }), 'step 1');
  const one = must(call('get_move_state', {}), 'read one');
  assert.notEqual(one.move.steps[0].doneAt, null);
  assert.equal(one.move.steps[1].doneAt, null);

  // A replayed done keeps the ORIGINAL timestamp (the idempotency of an absolute set).
  must(call('advance_move_step', { direction: 'local_to_selfhost', step: 1 }), 'replay step 1');
  const replay = must(call('get_move_state', {}), 'read replay');
  assert.equal(replay.move.steps[0].doneAt, one.move.steps[0].doneAt);
  assert.equal(replay.move.startedAt, one.move.startedAt);
});

test('completion is derived from all five steps and un-doing a step un-completes, honestly', () => {
  const { call } = world('done');
  for (let step = 1; step <= 5; step += 1) {
    must(call('advance_move_step', { direction: 'local_to_managed', step }), `step ${step}`);
  }
  const done = must(call('get_move_state', {}), 'read done');
  assert.notEqual(done.move.completedAt, null);
  assert.ok(done.move.steps.every((s) => s.doneAt !== null));

  // The step-4 mismatch recovery: un-checking step 4 clears the completion stamp.
  must(call('advance_move_step', { direction: 'local_to_managed', step: 4, done: false }), 'undo 4');
  const reopened = must(call('get_move_state', {}), 'read reopened');
  assert.equal(reopened.move.steps[3].doneAt, null);
  assert.equal(reopened.move.completedAt, null);

  // Re-doing it completes again.
  must(call('advance_move_step', { direction: 'local_to_managed', step: 4 }), 'redo 4');
  const redone = must(call('get_move_state', {}), 'read redone');
  assert.notEqual(redone.move.completedAt, null);
});

test('a different direction resets the checklist: a fresh start, never a half-carried one', () => {
  const { deps, wid, call } = world('dir');
  must(call('advance_move_step', { direction: 'local_to_selfhost', step: 1 }), 'step 1');
  must(call('advance_move_step', { direction: 'managed_to_local' }), 'switch direction');
  const after = must(call('get_move_state', {}), 'read after switch');
  assert.equal(after.move.direction, 'managed_to_local');
  assert.ok(after.move.steps.every((s) => s.doneAt === null), 'steps must reset on a direction change');
  // At most one row per workspace, ever (the PRIMARY KEY invariant, measured).
  const n = deps.store.db.prepare('SELECT COUNT(*) AS n FROM move_record WHERE workspace_id = ?').get(wid).n;
  assert.equal(n, 1);
});

test('abandon deletes the pointer and replaying the abandon settles on the same absent row', () => {
  const { call } = world('aband');
  must(call('advance_move_step', { direction: 'local_to_selfhost', step: 1 }), 'step 1');
  const gone = must(call('advance_move_step', { direction: 'local_to_selfhost', abandon: true }), 'abandon');
  assert.equal(gone.move, null);
  assert.equal(must(call('get_move_state', {}), 'read gone').move, null);
  // Replay: abandoning an absent row is the same absent row, never an error.
  const again = must(call('advance_move_step', { direction: 'local_to_selfhost', abandon: true }), 'replay abandon');
  assert.equal(again.move, null);
});

test('a completed move keeps its row (the S7.5 stale-writable notice depends on it)', () => {
  const { deps, wid, call } = world('keep');
  for (let step = 1; step <= 5; step += 1) {
    must(call('advance_move_step', { direction: 'local_to_selfhost', step }), `step ${step}`);
  }
  const row = deps.store.db.prepare('SELECT completed_at FROM move_record WHERE workspace_id = ?').get(wid);
  assert.notEqual(row, undefined, 'the completed record must survive');
  assert.notEqual(row.completed_at, null);
});

test('advance refuses a direction outside the enum, a step outside 1..5, and non-boolean flags, by name', () => {
  const { call } = world('bad');
  refuse(call('advance_move_step', { direction: 'device_sync' }), 'invalid_direction', 'bad direction');
  refuse(call('advance_move_step', { direction: 'local_to_selfhost', step: 0 }), 'invalid_step', 'step 0');
  refuse(call('advance_move_step', { direction: 'local_to_selfhost', step: 6 }), 'invalid_step', 'step 6');
  // A fractional step is refused at the schema boundary (INT), before the engine's range check.
  refuse(call('advance_move_step', { direction: 'local_to_selfhost', step: 1.5 }), 'invalid_input', 'fraction');
  refuse(call('advance_move_step', { direction: 'local_to_selfhost', done: 'yes' }), 'invalid_input', 'bad done');
  refuse(call('advance_move_step', { direction: 'local_to_selfhost', abandon: 'yes' }), 'invalid_input', 'bad abandon');
});

test('§H-TENANT: one workspace move pointer is invisible to another workspace', () => {
  const { deps, call } = world('ten');
  must(call('advance_move_step', { direction: 'selfhost_to_managed', step: 1 }), 'advance A');
  const other = mintWorkspace(deps, 'Andere GmbH', 'ten-other').workspaceId;
  const read = must(getAction('get_move_state').run(deps, { workspaceId: other }), 'read B');
  assert.equal(read.move, null);
});

test('NEVER A GATE: an unrelated write runs identically with an active move in every state', () => {
  const { call } = world('gate');
  const contact = (key) =>
    call('create_contact', { partyRole: 'customer', name: `K ${key}`, idempotencyKey: `mv-${key}` });
  must(contact('before'), 'write before any move');
  must(call('advance_move_step', { direction: 'local_to_selfhost', step: 1 }), 'move active');
  must(contact('during'), 'write during a move');
  for (let step = 2; step <= 5; step += 1) {
    must(call('advance_move_step', { direction: 'local_to_selfhost', step }), `step ${step}`);
  }
  must(contact('after'), 'write after a completed move');
});
