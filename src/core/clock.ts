/**
 * The clock, injected.
 *
 * Audit timestamps and the hash chain (A03) must be reproducible in tests, so no engine code reads
 * the wall clock directly: it reads a `Clock` from the context. Production uses `systemClock`; tests
 * pin time with `fixedClock`.
 */

export interface Clock {
  /** An ISO-8601 instant in UTC, e.g. `2026-07-16T08:00:00.000Z`. */
  now(): string;
}

export const systemClock: Clock = {
  now: () => new Date().toISOString(),
};

export function fixedClock(instant: string): Clock {
  return { now: () => instant };
}
