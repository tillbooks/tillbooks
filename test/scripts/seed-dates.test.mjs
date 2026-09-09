// Unit tests for scripts/lib/seed-dates.mjs: the rolling-TODAY calendar of the rich demo seed.
// Pure module, no db, no wall clock.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_TODAY,
  SEED_ANCHOR_YEAR,
  resolveSeedToday,
  isLeapYear,
  makeSeedCalendar,
} from '../../scripts/lib/seed-dates.mjs';

test('resolveSeedToday: unset or empty env falls back to the frozen default', () => {
  assert.equal(resolveSeedToday({}), DEFAULT_TODAY);
  assert.equal(resolveSeedToday({ TILL_SEED_TODAY: '' }), DEFAULT_TODAY);
  assert.equal(DEFAULT_TODAY, '2026-08-23');
  assert.equal(SEED_ANCHOR_YEAR, 2026);
});

test('resolveSeedToday: accepts a valid ISO date', () => {
  assert.equal(resolveSeedToday({ TILL_SEED_TODAY: '2027-03-10' }), '2027-03-10');
  assert.equal(resolveSeedToday({ TILL_SEED_TODAY: '2028-02-29' }), '2028-02-29'); // real leap day
});

test('resolveSeedToday: rejects malformed and impossible dates', () => {
  for (const bad of ['gestern', '2027-3-1', '20270310', '2027-13-01', '2027-02-30', '2027-00-10']) {
    assert.throws(() => resolveSeedToday({ TILL_SEED_TODAY: bad }), /TILL_SEED_TODAY/);
  }
});

test('isLeapYear: Gregorian rules', () => {
  assert.equal(isLeapYear(2024), true);
  assert.equal(isLeapYear(2026), false);
  assert.equal(isLeapYear(2000), true); // divisible by 400
  assert.equal(isLeapYear(2100), false); // divisible by 100, not 400
});

test('year mapping: 2026 -> year(TODAY), 2025 -> -1, 2024 -> -2', () => {
  const cal = makeSeedCalendar('2027-03-10');
  assert.equal(cal.yearDelta, 1);
  assert.equal(cal.d('2026-08-05'), '2027-08-05');
  assert.equal(cal.d('2025-05-14'), '2026-05-14');
  assert.equal(cal.d('2024-03-15'), '2025-03-15');
});

test('identity: TODAY equal to the default leaves every remap unchanged', () => {
  const cal = makeSeedCalendar(DEFAULT_TODAY);
  assert.equal(cal.identity, true);
  assert.equal(cal.yearDelta, 0);
  for (const iso of ['2024-03-15', '2025-01-01', '2026-08-23', '2026-12-31']) {
    assert.equal(cal.d(iso), iso);
  }
  assert.equal(cal.dm('2026-07'), '2026-07');
  assert.equal(cal.dq('2025-Q4'), '2025-Q4');
  assert.equal(cal.dt('2026-08-01T08:00:00'), '2026-08-01T08:00:00');
  assert.deepEqual(cal.months().slice(0, 2), ['2025-01', '2025-02']);
  assert.equal(cal.months().at(-1), '2026-08');
  assert.equal(cal.months().length, 20);
});

test('non-default calendars are flagged as rolled', () => {
  assert.equal(makeSeedCalendar('2026-08-26').identity, false);
  assert.equal(makeSeedCalendar('2027-03-10').identity, false);
});

test('Feb-29 clamps to Feb-28 when the target year is not a leap year', () => {
  // Seed 2024 (leap) maps to 2025 (not leap) when TODAY is in 2027.
  const cal = makeSeedCalendar('2027-03-10');
  assert.equal(cal.d('2024-02-29'), '2025-02-28');
  // ...and stays Feb-29 when the target year IS a leap year (2024 -> 2028 with TODAY in 2030).
  const leapTarget = makeSeedCalendar('2030-06-15');
  assert.equal(leapTarget.d('2024-02-29'), '2028-02-29');
});

test('skip decision: isFuture compares the date part against TODAY', () => {
  const cal = makeSeedCalendar('2027-03-10');
  assert.equal(cal.isFuture('2027-03-10'), false); // TODAY itself is seedable
  assert.equal(cal.isFuture('2027-03-11'), true);
  assert.equal(cal.isFuture('2026-12-31'), false);
  assert.equal(cal.isFuture('2027-03-11T08:00:00.000Z'), true);
  assert.equal(cal.isFuture('2027-03-09T23:59:59.000Z'), false);
});

test('month and quarter remap', () => {
  const cal = makeSeedCalendar('2027-03-10');
  assert.equal(cal.dm('2026-07'), '2027-07');
  assert.equal(cal.dm('2025-12'), '2026-12');
  assert.equal(cal.dq('2025-Q1'), '2026-Q1');
  assert.equal(cal.dq('2026-Q4'), '2027-Q4');
});

test('dt remaps the date part and keeps the time suffix verbatim', () => {
  const cal = makeSeedCalendar('2027-03-10');
  assert.equal(cal.dt('2026-08-01T08:00:00'), '2027-08-01T08:00:00');
  assert.equal(cal.dt('2026-07-31T23:59:59'), '2027-07-31T23:59:59');
  assert.equal(cal.dt('2025-01-01T09:00:00.000Z'), '2026-01-01T09:00:00.000Z');
});

test('horizon math: monthShift walks calendar months across year boundaries', () => {
  const frozen = makeSeedCalendar(DEFAULT_TODAY); // month 2026-08
  assert.equal(frozen.monthShift(0), '2026-08');
  assert.equal(frozen.monthShift(-1), '2026-07'); // depreciation / bill horizon
  assert.equal(frozen.monthShift(-2), '2026-06'); // close horizon
  assert.equal(frozen.monthShift(-3), '2026-05'); // paid-invoice horizon
  assert.equal(frozen.monthShift(-4), '2026-04'); // VAT filing cut

  const early = makeSeedCalendar('2027-03-10');
  assert.equal(early.monthShift(-1), '2027-02');
  assert.equal(early.monthShift(-3), '2026-12'); // crosses the year boundary
  assert.equal(early.monthShift(-4), '2026-11');
  assert.equal(early.monthShift(2), '2027-05');
});

test('horizon math: months() spans Jan of year(TODAY)-1 through month(TODAY)', () => {
  const early = makeSeedCalendar('2027-03-10');
  const months = early.months();
  assert.equal(months[0], '2026-01');
  assert.equal(months.at(-1), '2027-03');
  assert.equal(months.length, 15);

  const late = makeSeedCalendar('2026-12-15');
  assert.equal(late.months()[0], '2025-01');
  assert.equal(late.months().at(-1), '2026-12');
  assert.equal(late.months().length, 24);
});

test('validation: the remap helpers reject malformed input loudly', () => {
  const cal = makeSeedCalendar('2027-03-10');
  assert.throws(() => cal.d('2026-8-5'), /YYYY-MM-DD/);
  assert.throws(() => cal.dm('2026-07-01'), /YYYY-MM/);
  assert.throws(() => cal.dq('Q1-2026'), /YYYY-Qn/);
  assert.throws(() => cal.dt('nope'), /date-time/);
  assert.throws(() => cal.isFuture(42), /ISO date/);
  assert.throws(() => makeSeedCalendar('23.08.2026'), /ISO date/);
});
