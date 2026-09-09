/**
 * F-09 (2026-09-06, friction ledger J1.4 ideal step 4): the Übernahmestichtag as a CALENDAR gate.
 *
 * A migration is PREPARED before its date. The owner's own go-live is 01.10.2026 and is prepared
 * through September: scope, map, preview, trial load into the Testmandant and the Eröffnungsprüfung
 * are all rehearsal, and none of them writes the live books. What waits for the date is the COMMIT:
 * `commitStep` (the write into the live workspace) and `goProductive` (the promotion) refuse
 * `cutover_in_future` until the Stichtag has arrived, and `readiness` names that wait as a blocking
 * item. `createPlan` used to refuse a future date outright, which made the 20-minute migration
 * budget (D-K) unreachable by construction.
 *
 * A separate module, imported by `plan.ts`, `steps.ts` and `testmandant.ts` alike, so the gate has
 * ONE definition and no import cycle (`plan.ts` reaches `testmandant.ts` through `seams.ts`).
 * Compared as ISO dates on the ENGINE clock, so a test can move the calendar and prove both sides.
 */

import type { WorkspaceContext } from '../context.js';
import type { Result } from '../result.js';
import { err } from '../result.js';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Is the plan's Stichtag still ahead of today? A malformed or absent date is never "pending": that
 * is a validation question `createPlan` already answered, not a calendar one.
 */
export function isCutoverPending(ctx: WorkspaceContext, plan: { cutover_date: string | null }): boolean {
  const stichtag = plan.cutover_date;
  if (typeof stichtag !== 'string' || !ISO_DATE.test(stichtag)) return false;
  return stichtag > ctx.clock.now().slice(0, 10);
}

/** The structured refusal a commit before the Stichtag returns, naming both dates (P9). */
export function cutoverInFuture(ctx: WorkspaceContext, plan: { cutover_date: string | null }): Result {
  return err('cutover_in_future', { cutoverDate: plan.cutover_date, today: ctx.clock.now().slice(0, 10) });
}
