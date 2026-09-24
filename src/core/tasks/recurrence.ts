/**
 * E03's recurrence grammar: one pure parser for the RFC-5545 SUBSET, and the next-occurrence math.
 *
 * THE GRAMMAR IS DELIBERATELY CLOSED (spec §4/§6b Fixed): `FREQ=DAILY|WEEKLY|MONTHLY|YEARLY`
 * (mandatory), optional `INTERVAL=1..99`, optional `BYDAY=MO..SU` (WEEKLY only, exactly one day),
 * and at most ONE of `UNTIL=<ISO date>` | `COUNT=n`. Anything else is `recurrence_invalid`, and
 * nothing invalid is ever stored: an open-ended RRULE parser is a correctness and input-validation
 * surface, not a business customization, and this subset covers every persona's use case.
 *
 * NEXT-OCCURRENCE MATH ANCHORS ON THE PREVIOUS `due_at`, never on completion time, so completing
 * late (or early) never shifts the cadence (US-E03.3). Monthly and yearly steps clamp to the last
 * day of a short target month (Jan 31 + 1 month = Feb 28/29), the conventional reading. If the
 * computed next occurrence is already in the past it is spawned overdue: an honest queue, no
 * silent skip.
 *
 * VERIFIED against RFC 5545 §3.3.10 (RRULE): FREQ is required; INTERVAL defaults to 1; UNTIL and
 * COUNT are mutually exclusive. The BYDAY handling here is the documented subset semantics, not
 * full RRULE expansion: with WEEKLY+BYDAY the series lands on that weekday, aligning first if the
 * anchor is on a different day.
 */

/** `FREQ` (fixed §H-ENUM). */
export const RECURRENCE_FREQS = ['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'] as const;
export type RecurrenceFreq = (typeof RECURRENCE_FREQS)[number];

const WEEKDAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const;
export type RecurrenceWeekday = (typeof WEEKDAYS)[number];

export interface TaskRecurrence {
  readonly freq: RecurrenceFreq;
  /** 1..99; RFC 5545 defaults an absent INTERVAL to 1. */
  readonly interval: number;
  /** WEEKLY only: the weekday the series lands on. */
  readonly byDay?: RecurrenceWeekday | undefined;
  /** ISO `YYYY-MM-DD`; the last day an occurrence may fall ON (inclusive). Excludes `count`. */
  readonly until?: string | undefined;
  /** Total occurrences in the series, the anchor task included; >= 2. Excludes `until`. */
  readonly count?: number | undefined;
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parse a rule text, or return undefined when it is not in the subset. Undefined is the single
 * "invalid" answer so every caller maps it to ONE structured error (`recurrence_invalid`) and no
 * partially-parsed rule can leak through.
 */
export function parseTaskRecurrence(rule: unknown): TaskRecurrence | undefined {
  if (typeof rule !== 'string' || rule.length === 0 || rule.length > 200) return undefined;
  const seen = new Set<string>();
  let freq: RecurrenceFreq | undefined;
  let interval = 1;
  let byDay: RecurrenceWeekday | undefined;
  let until: string | undefined;
  let count: number | undefined;

  for (const part of rule.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) return undefined;
    const key = part.slice(0, eq);
    const value = part.slice(eq + 1);
    if (seen.has(key)) return undefined;
    seen.add(key);
    if (key === 'FREQ') {
      if (!(RECURRENCE_FREQS as readonly string[]).includes(value)) return undefined;
      freq = value as RecurrenceFreq;
    } else if (key === 'INTERVAL') {
      if (!/^\d{1,2}$/.test(value)) return undefined;
      const n = Number(value);
      if (n < 1 || n > 99) return undefined;
      interval = n;
    } else if (key === 'BYDAY') {
      if (!(WEEKDAYS as readonly string[]).includes(value)) return undefined;
      byDay = value as RecurrenceWeekday;
    } else if (key === 'UNTIL') {
      if (!ISO_DAY.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) return undefined;
      until = value;
    } else if (key === 'COUNT') {
      if (!/^\d{1,4}$/.test(value)) return undefined;
      count = Number(value);
    } else {
      return undefined;
    }
  }

  if (freq === undefined) return undefined;
  if (byDay !== undefined && freq !== 'WEEKLY') return undefined;
  if (until !== undefined && count !== undefined) return undefined;
  // COUNT=1 (or 0) is a one-off pretending to recur: the anchor task is occurrence one, so a series
  // that can never spawn is refused at the gate rather than silently created (US-E03.3 Empty).
  if (count !== undefined && count < 2) return undefined;
  return { freq, interval, byDay, until, count };
}

const DAY_MS = 86_400_000;

/** The date part of an ISO day or instant, or undefined when it does not parse. */
function dayPartOf(iso: string): string | undefined {
  const day = iso.slice(0, 10);
  if (!ISO_DAY.test(day) || Number.isNaN(Date.parse(`${day}T00:00:00Z`))) return undefined;
  return day;
}

function toUtc(day: string): Date {
  return new Date(`${day}T00:00:00Z`);
}

function fmt(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Add calendar months in UTC, clamping to the last day of a short target month. */
function addMonthsClamped(day: string, months: number): string {
  const d = toUtc(day);
  const targetMonth = d.getUTCMonth() + months;
  const probe = new Date(Date.UTC(d.getUTCFullYear(), targetMonth, 1));
  const lastDay = new Date(Date.UTC(probe.getUTCFullYear(), probe.getUTCMonth() + 1, 0)).getUTCDate();
  probe.setUTCDate(Math.min(d.getUTCDate(), lastDay));
  return fmt(probe);
}

/** ISO weekday of a `YYYY-MM-DD` day, as the RFC token (`MO`..`SU`). */
function weekdayOf(day: string): RecurrenceWeekday {
  // `getUTCDay()` is 0=Sunday; the WEEKDAYS list is Monday-first, per ISO 8601 and RFC 5545 WKST=MO.
  const index = (toUtc(day).getUTCDay() + 6) % 7;
  return WEEKDAYS[index] as RecurrenceWeekday;
}

/**
 * The next occurrence DAY after `fromDueAt`, or undefined when `UNTIL` ends the series there.
 * `COUNT` termination is the caller's (it needs the chain length, which is a database fact).
 *
 * Returns a `YYYY-MM-DD` day; the caller re-attaches any time-of-day the anchor carried, so a
 * `2026-03-31T14:00` monthly task recurs at 14:00.
 */
export function nextOccurrenceDay(rule: TaskRecurrence, fromDueAt: string): string | undefined {
  const from = dayPartOf(fromDueAt);
  if (from === undefined) return undefined;

  let next: string;
  if (rule.freq === 'DAILY') {
    next = fmt(new Date(toUtc(from).getTime() + rule.interval * DAY_MS));
  } else if (rule.freq === 'WEEKLY') {
    if (rule.byDay === undefined) {
      next = fmt(new Date(toUtc(from).getTime() + rule.interval * 7 * DAY_MS));
    } else if (weekdayOf(from) === rule.byDay) {
      // Aligned series: the plain weekly step keeps landing on the same weekday.
      next = fmt(new Date(toUtc(from).getTime() + rule.interval * 7 * DAY_MS));
    } else {
      // Unaligned anchor: the first hop aligns onto the BYDAY weekday (the documented subset
      // semantics), and every later hop is the aligned case above.
      let probe = toUtc(from).getTime();
      do {
        probe += DAY_MS;
      } while (weekdayOf(fmt(new Date(probe))) !== rule.byDay);
      next = fmt(new Date(probe));
    }
  } else if (rule.freq === 'MONTHLY') {
    next = addMonthsClamped(from, rule.interval);
  } else {
    next = addMonthsClamped(from, rule.interval * 12);
  }

  if (rule.until !== undefined && next > rule.until) return undefined;
  return next;
}
