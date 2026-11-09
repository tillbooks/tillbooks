/**
 * E03's recurrence grammar and next-occurrence math (spec §8: the property test).
 *
 * The property that matters: the spawned due date is a function of the RULE and the PRIOR DUE DATE
 * alone, never of completion time, so cadence cannot drift however late (or early) an occurrence is
 * completed. Termination is exact at UNTIL; COUNT is the engine's (chain length) and is proven in
 * `tasks.test.mjs` where a chain exists.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { parseTaskRecurrence, nextOccurrenceDay } from '../../dist/core/tasks/recurrence.js';

test('E03: the closed grammar accepts exactly the subset and nothing else', () => {
  // The subset, one witness per feature.
  assert.deepEqual(parseTaskRecurrence('FREQ=DAILY'), { freq: 'DAILY', interval: 1, byDay: undefined, until: undefined, count: undefined });
  assert.equal(parseTaskRecurrence('FREQ=WEEKLY;INTERVAL=2').interval, 2);
  assert.equal(parseTaskRecurrence('FREQ=WEEKLY;BYDAY=WE').byDay, 'WE');
  assert.equal(parseTaskRecurrence('FREQ=MONTHLY;UNTIL=2026-12-31').until, '2026-12-31');
  assert.equal(parseTaskRecurrence('FREQ=YEARLY;COUNT=3').count, 3);

  // The refusals, one witness per rule of the grammar.
  const invalid = [
    '', // empty
    'INTERVAL=2', // FREQ mandatory
    'FREQ=HOURLY', // outside the FREQ enum
    'FREQ=DAILY;INTERVAL=0', // interval below 1
    'FREQ=DAILY;INTERVAL=100', // interval above 99
    'FREQ=MONTHLY;BYDAY=MO', // BYDAY is WEEKLY-only
    'FREQ=WEEKLY;BYDAY=XX', // not a weekday token
    'FREQ=DAILY;UNTIL=2026-12-31;COUNT=3', // UNTIL and COUNT are mutually exclusive (RFC 5545)
    'FREQ=DAILY;COUNT=1', // a series that can never spawn is a one-off pretending to recur
    'FREQ=DAILY;UNTIL=31.12.2026', // not an ISO day
    'FREQ=DAILY;FREQ=WEEKLY', // duplicate key
    'FREQ=DAILY;WKST=MO', // outside the subset
  ];
  for (const rule of invalid) {
    assert.equal(parseTaskRecurrence(rule), undefined, `accepted: ${rule}`);
  }
});

test('E03: monthly and yearly steps clamp to the last day of a short target month', () => {
  const monthly = parseTaskRecurrence('FREQ=MONTHLY');
  assert.equal(nextOccurrenceDay(monthly, '2026-01-31'), '2026-02-28');
  assert.equal(nextOccurrenceDay(monthly, '2028-01-31'), '2028-02-29'); // leap year
  assert.equal(nextOccurrenceDay(monthly, '2026-03-31'), '2026-04-30');
  const yearly = parseTaskRecurrence('FREQ=YEARLY');
  assert.equal(nextOccurrenceDay(yearly, '2028-02-29'), '2029-02-28');
});

test('E03: WEEKLY;BYDAY aligns an unaligned anchor and then keeps the weekday', () => {
  const rule = parseTaskRecurrence('FREQ=WEEKLY;BYDAY=WE');
  // 2026-07-16 is a Thursday: the first hop aligns onto the next Wednesday.
  assert.equal(nextOccurrenceDay(rule, '2026-07-16'), '2026-07-22');
  // From a Wednesday, the aligned step is a plain week.
  assert.equal(nextOccurrenceDay(rule, '2026-07-22'), '2026-07-29');
  const biweekly = parseTaskRecurrence('FREQ=WEEKLY;INTERVAL=2;BYDAY=WE');
  assert.equal(nextOccurrenceDay(biweekly, '2026-07-22'), '2026-08-05');
});

test('E03: UNTIL termination is exact: on the boundary spawns, past it ends the series', () => {
  const onBoundary = parseTaskRecurrence('FREQ=DAILY;UNTIL=2026-07-17');
  assert.equal(nextOccurrenceDay(onBoundary, '2026-07-16'), '2026-07-17');
  assert.equal(nextOccurrenceDay(onBoundary, '2026-07-17'), undefined);
});

test('E03 property: the next occurrence depends on the rule and the prior due alone, and always advances', () => {
  // A deterministic fuzz over the whole grammar. For every combination: (1) recomputing yields the
  // same answer (pure), (2) the next day is strictly after the anchor, (3) a DAILY/WEEKLY step is
  // exactly the interval, and (4) an UNTIL-terminated answer never lands past UNTIL.
  const freqs = ['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'];
  const intervals = [1, 2, 5, 99];
  const anchors = ['2026-01-01', '2026-02-28', '2026-07-16', '2026-12-31', '2028-02-29'];
  const byDays = [undefined, 'MO', 'FR', 'SU'];
  let cases = 0;
  for (const freq of freqs) {
    for (const interval of intervals) {
      for (const anchor of anchors) {
        for (const byDay of byDays) {
          if (byDay !== undefined && freq !== 'WEEKLY') continue;
          const text = `FREQ=${freq};INTERVAL=${interval}${byDay === undefined ? '' : `;BYDAY=${byDay}`}`;
          const rule = parseTaskRecurrence(text);
          assert.notEqual(rule, undefined, `grammar refused its own subset: ${text}`);
          const next = nextOccurrenceDay(rule, anchor);
          cases += 1;
          assert.equal(nextOccurrenceDay(rule, anchor), next, `not pure: ${text} from ${anchor}`);
          assert.ok(next > anchor, `${text} from ${anchor} did not advance: ${next}`);
          const dayMs = 86_400_000;
          const stepDays = (Date.parse(`${next}T00:00:00Z`) - Date.parse(`${anchor}T00:00:00Z`)) / dayMs;
          if (freq === 'DAILY') assert.equal(stepDays, interval, `${text} from ${anchor}`);
          if (freq === 'WEEKLY' && byDay === undefined) assert.equal(stepDays, interval * 7, `${text} from ${anchor}`);
          if (freq === 'WEEKLY' && byDay !== undefined) {
            const weekday = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'][(new Date(`${next}T00:00:00Z`).getUTCDay() + 6) % 7];
            assert.equal(weekday, byDay, `${text} from ${anchor} landed on ${weekday}`);
          }
          // And with an UNTIL exactly on the computed next, the boundary is inclusive; one day
          // before it, the series ends.
          const untilRule = parseTaskRecurrence(`${text};UNTIL=${next}`);
          assert.equal(nextOccurrenceDay(untilRule, anchor), next);
          const before = new Date(Date.parse(`${next}T00:00:00Z`) - dayMs).toISOString().slice(0, 10);
          if (before > anchor) {
            const endedRule = parseTaskRecurrence(`${text};UNTIL=${before}`);
            assert.equal(nextOccurrenceDay(endedRule, anchor), undefined, `${text} UNTIL=${before} from ${anchor} should end`);
          }
        }
      }
    }
  }
  assert.ok(cases >= 100, `the fuzz collapsed to ${cases} cases`);
});
