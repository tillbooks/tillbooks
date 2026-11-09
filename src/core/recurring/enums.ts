/**
 * A12 §H-ENUM: the single source for the recurring schedule's closed enumerations.
 *
 * The schedule `status` and `interval` are fixed engine enums owned solely by A12 (spec §6b): adding
 * an interval kind or a status is an engine change (new date math, new transition), never a
 * customization. The run-log `outcome` set is the rebuild's designed answer to the triangle (spec
 * §4b): three SETTLED outcomes that occupy the partial UNIQUE index and can never repeat for a
 * period, and two OPEN outcomes that record an observation and leave the period retryable.
 */

/** `recurring_schedule.interval` (fixed §H-ENUM). `custom` requires `custom_days`. */
export const RECURRING_INTERVALS = ['monthly', 'quarterly', 'yearly', 'custom'] as const;
export type RecurringInterval = (typeof RECURRING_INTERVALS)[number];

/** `recurring_schedule.status` (fixed §H-ENUM): `active` <-> `paused` -> `ended`; `ended` is terminal. */
export const RECURRING_STATUSES = ['active', 'paused', 'ended'] as const;
export type RecurringStatus = (typeof RECURRING_STATUSES)[number];

/**
 * `recurring_run_log.outcome` (fixed §H-ENUM).
 *
 * SETTLED (inside the partial UNIQUE index, spec §4b): `drafted` (review mode produced a draft),
 * `issued` (the period's invoice is issued and posted, whether by the tick, by a human hand-issuing
 * the waiting draft, or found issued on a crash replay), `discarded` (the period's draft was
 * deliberately cancelled by a human; the period is consciously spent and never re-billed).
 *
 * OPEN (outside the index, many observations legal): `skipped_locked` (§H-PERIOD refused the
 * posting; retried once the lock lifts) and `failed` (the invoked verb refused; retried next tick).
 */
export const RUN_OUTCOMES = ['drafted', 'issued', 'discarded', 'skipped_locked', 'failed'] as const;
export type RunOutcome = (typeof RUN_OUTCOMES)[number];

/** The settled half: exactly the outcomes the partial UNIQUE index in `schema.ts` names. */
export const SETTLED_OUTCOMES: readonly RunOutcome[] = ['drafted', 'issued', 'discarded'];

/**
 * The catch-up burst bound: at most this many settles per schedule per tick. A later tick continues
 * where this one stopped, so nothing is dropped (critic probe C7); the bound only keeps one tick
 * from flooding a day's ledger without a pause for review.
 */
export const CATCH_UP_CAP = 24;

export function isRecurringInterval(value: unknown): value is RecurringInterval {
  return typeof value === 'string' && (RECURRING_INTERVALS as readonly string[]).includes(value);
}
