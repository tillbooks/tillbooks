/**
 * F01's schedule subset (§2 US-F01.3, §6b Fixed): the ONLY cadences `reports_schedule` accepts, and
 * their canonical form.
 *
 * The subset is deliberately narrow so the delivery contract stays auditable and the GUI can always
 * show a schedule honestly: `daily|weekly|monthly` plus a time, and for weekly a weekday, for monthly
 * a day-of-month. Arbitrary cron (step values, ranges, multiple fields) is refused with
 * `invalid_schedule`: a schedule the GUI cannot render is a schedule the operator cannot trust.
 *
 * `canonicalise` returns a stable string the `saved_reports.schedule` column stores and the next-run
 * indicator reads back. It is NOT a full cron expression evaluator: the OSS core stores the intent and
 * runs on demand, and the cloud tier (OP4) owns the actual firing. Storing a canonical string rather
 * than the raw input means two equivalent inputs compare equal and a replay is a genuine no-op.
 */

export const SCHEDULE_FREQUENCIES = ['daily', 'weekly', 'monthly'] as const;
export type ScheduleFrequency = (typeof SCHEDULE_FREQUENCIES)[number];

export interface ScheduleSpec {
  freq: ScheduleFrequency;
  /** HH:mm, 24-hour. */
  at: string;
  /** 0..6 (Sun..Sat), weekly only. */
  weekday?: number;
  /** 1..28, monthly only (28 is the safe ceiling: never skips a February). */
  dayOfMonth?: number;
}

const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * Validate a caller's schedule object against the published subset. Returns the canonical string on
 * success or a structured `invalid_schedule` reason on refusal (the caller turns it into a P9 err).
 */
export function parseSchedule(
  input: unknown,
): { ok: true; canonical: string; spec: ScheduleSpec } | { ok: false; reason: string } {
  if (input === null || input === undefined) return { ok: false, reason: 'missing' };
  if (typeof input !== 'object') return { ok: false, reason: 'not_an_object' };
  const raw = input as Record<string, unknown>;

  const freq = raw.freq;
  if (typeof freq !== 'string' || !(SCHEDULE_FREQUENCIES as readonly string[]).includes(freq)) {
    return { ok: false, reason: 'freq' };
  }
  const at = raw.at;
  if (typeof at !== 'string' || !HHMM_RE.test(at)) return { ok: false, reason: 'at' };

  const spec: ScheduleSpec = { freq: freq as ScheduleFrequency, at };

  if (freq === 'weekly') {
    const wd = raw.weekday;
    if (!Number.isInteger(wd) || (wd as number) < 0 || (wd as number) > 6) {
      return { ok: false, reason: 'weekday' };
    }
    spec.weekday = wd as number;
  } else if (raw.weekday !== undefined && raw.weekday !== null) {
    // A weekday on a daily/monthly schedule is a shape the GUI cannot show: refuse rather than ignore.
    return { ok: false, reason: 'weekday_not_allowed' };
  }

  if (freq === 'monthly') {
    const dom = raw.dayOfMonth;
    if (!Number.isInteger(dom) || (dom as number) < 1 || (dom as number) > 28) {
      return { ok: false, reason: 'day_of_month' };
    }
    spec.dayOfMonth = dom as number;
  } else if (raw.dayOfMonth !== undefined && raw.dayOfMonth !== null) {
    return { ok: false, reason: 'day_of_month_not_allowed' };
  }

  return { ok: true, canonical: canonicalise(spec), spec };
}

/** The stable stored form. Two equivalent schedule objects canonicalise to the same string. */
export function canonicalise(spec: ScheduleSpec): string {
  const parts = [`freq=${spec.freq}`, `at=${spec.at}`];
  if (spec.freq === 'weekly') parts.push(`weekday=${spec.weekday}`);
  if (spec.freq === 'monthly') parts.push(`dayOfMonth=${spec.dayOfMonth}`);
  return parts.join(';');
}
