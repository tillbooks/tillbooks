/**
 * B04 period math: the one place a period_key is formed, bounded and stepped. Pure functions, so this
 * suite pins the boundaries the money path measures against (period_not_closed, rollover-next).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isPeriodKey,
  periodKeyOf,
  periodStart,
  periodEndExclusive,
  nextPeriodKey,
  periodHasEnded,
} from '../../dist/core/retainers/index.js';

test('B04 periods: monthly key formation, bounds and stepping', () => {
  assert.equal(periodKeyOf('monthly', '2026-06-10'), '2026-06');
  assert.equal(periodStart('monthly', '2026-06'), '2026-06-01');
  assert.equal(periodEndExclusive('monthly', '2026-06'), '2026-07-01');
  assert.equal(periodEndExclusive('monthly', '2026-12'), '2027-01-01');
  assert.equal(nextPeriodKey('monthly', '2026-12'), '2027-01');
});

test('B04 periods: quarterly key formation, bounds and stepping', () => {
  assert.equal(periodKeyOf('quarterly', '2026-06-10'), '2026-Q2');
  assert.equal(periodKeyOf('quarterly', '2026-01-01'), '2026-Q1');
  assert.equal(periodKeyOf('quarterly', '2026-12-31'), '2026-Q4');
  assert.equal(periodStart('quarterly', '2026-Q2'), '2026-04-01');
  assert.equal(periodEndExclusive('quarterly', '2026-Q2'), '2026-07-01');
  assert.equal(periodEndExclusive('quarterly', '2026-Q4'), '2027-01-01');
  assert.equal(nextPeriodKey('quarterly', '2026-Q4'), '2027-Q1');
});

test('B04 periods: a period has ended only when it lies fully in the past', () => {
  // 2026-06 ends exclusive on 2026-07-01, so it has ended at 2026-07-16 but not at 2026-06-30.
  assert.equal(periodHasEnded('monthly', '2026-06', '2026-07-16'), true);
  assert.equal(periodHasEnded('monthly', '2026-06', '2026-06-30'), false);
  assert.equal(periodHasEnded('monthly', '2026-07', '2026-07-16'), false);
  assert.equal(periodHasEnded('monthly', '2026-06', '2026-07-01'), true);
});

test('B04 periods: isPeriodKey validates the shape for the retainer type', () => {
  assert.equal(isPeriodKey('monthly', '2026-06'), true);
  assert.equal(isPeriodKey('monthly', '2026-13'), false);
  assert.equal(isPeriodKey('monthly', '2026-Q2'), false);
  assert.equal(isPeriodKey('quarterly', '2026-Q2'), true);
  assert.equal(isPeriodKey('quarterly', '2026-Q5'), false);
  assert.equal(isPeriodKey('quarterly', '2026-06'), false);
});
