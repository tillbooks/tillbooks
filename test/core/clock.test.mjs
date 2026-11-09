import test from 'node:test';
import assert from 'node:assert/strict';

import { systemClock, fixedClock } from '../../dist/core/clock.js';

test('fixedClock always returns the pinned instant, for deterministic tests', () => {
  const clock = fixedClock('2026-07-16T08:00:00.000Z');
  assert.equal(clock.now(), '2026-07-16T08:00:00.000Z');
  assert.equal(clock.now(), '2026-07-16T08:00:00.000Z');
});

test('systemClock returns a parseable ISO-8601 instant in UTC', () => {
  const s = systemClock.now();
  assert.match(s, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal(Number.isNaN(Date.parse(s)), false);
});
