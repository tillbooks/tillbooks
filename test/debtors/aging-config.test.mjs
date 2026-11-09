// A16 §6b, the one write this capability owns: the aging bucket boundaries.
//
// Everything else in A16 is a read model. This is the single row a workspace may change, so it
// carries the full write discipline: validation that names the field, §H-IDEMPOTENT asserted by
// COUNTING ROWS and comparing the stored row rather than by trusting a return value, and §H-TENANT
// so one workspace's boundaries never reach another's OP-Liste.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getAgingBucketConfig,
  setAgingBucketConfig,
  listOpenItems,
} from '../../dist/core/debtors/index.js';

import { setup, secondWorkspace, configRows, configRow } from './support.mjs';

test('A16 §4: an unconfigured workspace reports the default boundaries and stores no row', () => {
  const t = setup();

  const got = getAgingBucketConfig(t.ctx, {});
  assert.equal(got.ok, true, JSON.stringify(got));
  assert.deepEqual(got.boundariesDays, [30, 60, 90]);
  assert.equal(got.configured, false);
  assert.equal(configRows(t.store, t.workspaceId), 0, 'a default is an absence, not a written row');
});

test('A16 §6b: setting boundaries round-trips and re-partitions the buckets', () => {
  const t = setup();

  const set = setAgingBucketConfig(t.ctx, { boundariesDays: [7, 14, 30, 60], idempotencyKey: 'k1' });
  assert.equal(set.ok, true, JSON.stringify(set));
  assert.deepEqual(set.boundariesDays, [7, 14, 30, 60]);

  const got = getAgingBucketConfig(t.ctx, {});
  assert.deepEqual(got.boundariesDays, [7, 14, 30, 60]);
  assert.equal(got.configured, true);
  assert.equal(configRows(t.store, t.workspaceId), 1);

  assert.deepEqual(Object.keys(listOpenItems(t.ctx, {}).bucketTotals), [
    '0-7',
    '8-14',
    '15-30',
    '31-60',
    '60+',
  ]);
});

test('A16 §8h: a repeat call under the same idempotency key writes nothing at all', () => {
  const t = setup();

  const first = setAgingBucketConfig(t.ctx, { boundariesDays: [10, 20], idempotencyKey: 'same' });
  assert.equal(first.ok, true, JSON.stringify(first));
  const afterFirst = configRow(t.store, t.workspaceId);

  // A DIFFERENT payload under the SAME key. If the key were decorative this would overwrite the
  // boundaries, which is exactly the failure a return-value assertion cannot see.
  const second = setAgingBucketConfig(t.ctx, { boundariesDays: [99], idempotencyKey: 'same' });
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.deepEqual(second.boundariesDays, [10, 20], 'the replay returns the stored config, not the request');

  assert.equal(configRows(t.store, t.workspaceId), 1, 'still exactly one row');
  assert.deepEqual(configRow(t.store, t.workspaceId), afterFirst, 'the stored row is byte-identical');
  assert.deepEqual(getAgingBucketConfig(t.ctx, {}).boundariesDays, [10, 20]);
});

test('A16 §6b: a new key genuinely replaces the boundaries, so the guard is not a freeze', () => {
  const t = setup();

  setAgingBucketConfig(t.ctx, { boundariesDays: [10, 20], idempotencyKey: 'k1' });
  const again = setAgingBucketConfig(t.ctx, { boundariesDays: [45, 90], idempotencyKey: 'k2' });
  assert.equal(again.ok, true, JSON.stringify(again));
  assert.deepEqual(again.boundariesDays, [45, 90]);
  assert.equal(configRows(t.store, t.workspaceId), 1, 'replaced in place, never appended');
});

test('A16 §8h: a LATE retry of an older key must not revert a newer edit', () => {
  const t = setup();

  // The out-of-order retry, which is the case an idempotency key exists for and the one a
  // same-key test cannot see. A caller sets A, a genuine second edit sets B, and only then does
  // A's original call get retried (a slow client, a queue redelivery, a resumed session).
  //
  // Asserted on the ROW, never on a return value: the failure this pins is that the retry of A is
  // not recognised as a replay at all and silently overwrites B's boundaries. A key remembered on
  // the config row itself cannot survive this, because the row holds exactly one key, so B's write
  // erases every trace that A was ever seen.
  const first = setAgingBucketConfig(t.ctx, { boundariesDays: [30, 60, 90], idempotencyKey: 'KEY-A' });
  assert.equal(first.ok, true, JSON.stringify(first));

  const newer = setAgingBucketConfig(t.ctx, { boundariesDays: [15, 30, 45], idempotencyKey: 'KEY-B' });
  assert.equal(newer.ok, true, JSON.stringify(newer));
  assert.deepEqual(newer.boundariesDays, [15, 30, 45], 'the genuine later edit landed');
  const afterB = configRow(t.store, t.workspaceId);

  const lateRetry = setAgingBucketConfig(t.ctx, { boundariesDays: [30, 60, 90], idempotencyKey: 'KEY-A' });
  assert.equal(lateRetry.ok, true, JSON.stringify(lateRetry));

  assert.deepEqual(
    getAgingBucketConfig(t.ctx, {}).boundariesDays,
    [15, 30, 45],
    'a retry of the OLDER key must not roll the configuration back to it',
  );
  assert.deepEqual(configRow(t.store, t.workspaceId), afterB, 'the stored row is untouched by the retry');
  assert.equal(configRows(t.store, t.workspaceId), 1, 'still exactly one row');
  assert.deepEqual(lateRetry, first, 'the retry replays A\'s original answer verbatim');
});

test('A16 §8h: a replay is BYTE-identical to the answer it replays', () => {
  const t = setup();

  // Every other key-carrying verb in the engine replays through the store's idempotency table, which
  // returns the stored Result verbatim. A discriminator that told the caller "this one was a replay"
  // would make call 2 differ from call 1, which is precisely what the conformance gate forbids: a
  // retrying client must not be able to tell that it retried.
  const first = setAgingBucketConfig(t.ctx, { boundariesDays: [10, 20], idempotencyKey: 'byte' });
  const second = setAgingBucketConfig(t.ctx, { boundariesDays: [10, 20], idempotencyKey: 'byte' });
  assert.deepEqual(second, first, 'call 2 must be indistinguishable from call 1');
});

test('A16 §8h: a completed key replays even when the retry carries a payload that no longer validates', () => {
  const t = setup();

  // A key that COMPLETED must replay unconditionally, ahead of every guard. This is the order
  // postEntry and createCostCenter use, and it is what makes the replay a property of the key
  // rather than of the retry's payload: a client that garbles its own retry, or a caller replaying
  // against a build whose validation has since tightened, still gets the original answer back
  // instead of a rejection for work that already succeeded.
  const first = setAgingBucketConfig(t.ctx, { boundariesDays: [10, 20], idempotencyKey: 'done' });
  assert.equal(first.ok, true, JSON.stringify(first));
  const afterFirst = configRow(t.store, t.workspaceId);

  const retry = setAgingBucketConfig(t.ctx, { boundariesDays: [60, 30], idempotencyKey: 'done' });
  assert.deepEqual(retry, first, 'the completed key replays, it does not re-validate');
  assert.deepEqual(configRow(t.store, t.workspaceId), afterFirst, 'and it writes nothing');
});

test('A16 §8h: a non-increasing, non-positive, empty or non-integer boundary list is refused', () => {
  const t = setup();

  const cases = [
    [[60, 30], 'not strictly increasing'],
    [[30, 30], 'not strictly increasing'],
    [[0, 30], 'not positive'],
    [[-5], 'not positive'],
    [[], 'empty'],
    [[30.5], 'not an integer'],
    [['30'], 'not a number'],
    ['30', 'not a list'],
  ];
  for (const [boundariesDays, why] of cases) {
    const res = setAgingBucketConfig(t.ctx, { boundariesDays, idempotencyKey: `bad-${why}` });
    assert.equal(res.ok, false, `${why}: ${JSON.stringify(boundariesDays)} must be refused`);
    assert.equal(res.error, 'invalid_input');
    assert.equal(res.field, 'boundariesDays');
  }
  assert.equal(configRows(t.store, t.workspaceId), 0, 'a refused write leaves no row behind');
});

test('A16 §8h: the idempotency key is required, like every other write in the engine', () => {
  const t = setup();

  const res = setAgingBucketConfig(t.ctx, { boundariesDays: [30] });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'invalid_input');
  assert.equal(res.field, 'idempotencyKey');
  assert.equal(configRows(t.store, t.workspaceId), 0);
});

test('A16 §7 §H-TENANT: one workspace\'s boundaries never reach another\'s', () => {
  const t = setup();
  const other = secondWorkspace(t, 'Nachbar AG');

  setAgingBucketConfig(t.ctx, { boundariesDays: [5], idempotencyKey: 'mine' });

  assert.deepEqual(getAgingBucketConfig(t.ctx, {}).boundariesDays, [5]);
  assert.deepEqual(
    getAgingBucketConfig(other.ctx, {}).boundariesDays,
    [30, 60, 90],
    'the neighbour still sees the shipped default',
  );
  assert.equal(configRows(t.store, t.workspaceId), 1);
  assert.equal(configRows(t.store, other.workspaceId), 0);
});
