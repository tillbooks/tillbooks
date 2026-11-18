/**
 * D206, THE WHOLE-DAY MODE of the table door (A43 §2, "Whole-day mode"): the rules a turnover table WITHOUT an id is
 * booked by, day by day, and the one comparison of a day with what the source already holds.
 *
 * A turnover export, unlike a bank export, carries no balance chain that proves a day complete. So the mode is an
 * alternative setting, never the default (`settlement.table_event_id` = `column` | `column_else_day`), it needs a
 * mapping a PERSON confirmed lists whole days (`wholeDays: true`), and it refuses a mapping that names a payout id
 * (a per-payout report is not whole days by construction).
 *
 * THE ID. A row is `day:<ISO day>#<n>`, n from a sort on PARSED values only (the stated amount, the fee, the folded
 * type cell, then the file order), so a re-export in another order mints the same ids and a corrected kind map
 * keeps them. Minted by `eventIdOf` / `dayIdsOf` in `tableMapping.ts`, through the id spec like every other id.
 *
 * HELD DAYS are derived from `settlement_feed_event` (the import's observed record: every readable event of every
 * door, booked or not, with its day and amount; F2), for the workspace, system and processor, any id form. No new
 * table. `heldVerdictOf` is THE comparison, used by the door (`settlement_from_table`) and again INSIDE
 * `import_settlement`'s transaction (F4, the chokepoint):
 *  - `new`: the source holds nothing on the day: the day imports whole;
 *  - `passed`: every observed event of the day carries a `day:` id and the file's events are exactly those ids with
 *    those amounts: the day is handed to the import UNCHANGED, whose own idempotency answers already_imported,
 *    ignored, or books the straggler a locked period or an unknown type had refused (F3);
 *  - `in_books`: otherwise the same amounts (a day held through the JSON door or a feed, F7): nothing is booked;
 *  - `differs`: anything else: nothing is booked, both sides are shown, and the difference is booked by hand.
 *
 * THE DAY (D206 point 8, amended after critic r1 H1): a time with an explicit zone is converted to the company's day
 * (Europe/Zurich, `wholeDayOf` in `tableMapping.ts`); a cell without a zone keeps its written date. For the latter, a
 * row a re-export moved across midnight is caught by `movedFromNeighbourOf`.
 */

import type { WorkspaceContext } from '../context.js';
import { getSetting } from '../settings/index.js';
import { zurichParts } from '../banking/ebics/autoSync.js';

/** The prefix every whole-day event id carries. */
export const DAY_ID_PREFIX = 'day:';

export const isDayId = (id: string): boolean => id.startsWith(DAY_ID_PREFIX);

/** The id of the n-th row (1-based) of a day, in the day's sort order. */
export function dayIdOf(day: string, n: number): string {
  return `${DAY_ID_PREFIX}${day}#${n}`;
}

export const TABLE_EVENT_ID_MODES = ['column', 'column_else_day'] as const;
export type TableEventIdMode = (typeof TABLE_EVENT_ID_MODES)[number];
export const TABLE_EDGE_DAY_MODES = ['ask', 'include', 'exclude'] as const;
export type TableEdgeDaysMode = (typeof TABLE_EDGE_DAY_MODES)[number];

/** `settlement.table_event_id`, read fail-closed: anything unreadable is the default `column`. */
export function tableEventIdModeOf(ctx: WorkspaceContext): TableEventIdMode {
  return getSetting<string>(ctx, 'settlement.table_event_id') === 'column_else_day' ? 'column_else_day' : 'column';
}

/** `settlement.table_edge_days`, read fail-closed: anything unreadable is the default `ask`. */
export function tableEdgeDaysModeOf(ctx: WorkspaceContext): TableEdgeDaysMode {
  const v = getSetting<string>(ctx, 'settlement.table_edge_days');
  return v === 'include' || v === 'exclude' ? v : 'ask';
}

/** Today in Switzerland: a day of today or later never imports in the whole-day mode (it is not over). */
export function swissTodayOf(ctx: WorkspaceContext): string {
  return zurichParts(ctx.clock.now()).date;
}

/** One event of a day, as the comparison reads it: its id and its amount (the effect on the processor balance). */
export interface DayEvent {
  eventId: string;
  amountMinor: number;
}

/** What the source holds on each of the given days (`settlement_feed_event`), §H-TENANT. */
export function observedByDay(ctx: WorkspaceContext, system: string, processor: string, days: readonly string[]): Map<string, DayEvent[]> {
  const out = new Map<string, DayEvent[]>();
  if (days.length === 0) return out;
  const unique = [...new Set(days)];
  for (let i = 0; i < unique.length; i += 400) {
    const chunk = unique.slice(i, i + 400);
    const rows = ctx.store.db
      .prepare(
        `SELECT day, event_id, amount_minor FROM settlement_feed_event
          WHERE workspace_id = ? AND source_system = ? AND source_processor = ? AND day IN (${chunk.map(() => '?').join(',')})`,
      )
      .all(ctx.workspaceId, system, processor, ...chunk) as { day: string; event_id: string; amount_minor: number }[];
    for (const r of rows) {
      const list = out.get(r.day) ?? [];
      list.push({ eventId: r.event_id, amountMinor: r.amount_minor });
      out.set(r.day, list);
    }
  }
  return out;
}

/** Does the source hold any whole-day event on the given days? (F7: such a day stays gated whatever the mapping.) */
export function holdsDayIds(observed: readonly DayEvent[] | undefined): boolean {
  return observed !== undefined && observed.some((o) => isDayId(o.eventId));
}

export type HeldVerdict = 'new' | 'passed' | 'in_books' | 'differs';

const amountsOf = (list: readonly DayEvent[]): string => JSON.stringify(list.map((e) => e.amountMinor).sort((a, b) => a - b));
const pairsOf = (list: readonly DayEvent[]): string => JSON.stringify(list.map((e) => [e.eventId, e.amountMinor]).sort((a, b) => (a[0] as string) < (b[0] as string) ? -1 : (a[0] as string) > (b[0] as string) ? 1 : 0));

/**
 * THE COMPARISON of one day of a file with what the source holds on it (module header). `file` is every event the
 * file states for the day; `observed` every event the source holds for it.
 */
export function heldVerdictOf(observed: readonly DayEvent[] | undefined, file: readonly DayEvent[]): HeldVerdict {
  if (observed === undefined || observed.length === 0) return 'new';
  if (observed.every((o) => isDayId(o.eventId)) && file.every((f) => isDayId(f.eventId)) && pairsOf(observed) === pairsOf(file)) return 'passed';
  if (amountsOf(observed) === amountsOf(file)) return 'in_books';
  return 'differs';
}

/**
 * D206, A ROW THAT MOVED ACROSS MIDNIGHT (critic r1 H1, the belt for cells without a zone): a re-export whose times
 * carry no zone, made in another zone, can move a row from a held day onto the next or previous day. The held day
 * then `differs` (an amount is missing from the file's side) and the neighbour would look `new`, so the row would
 * book twice. A `new` day books nothing (`differs`, naming the neighbour) when it is calendar-adjacent to a day that
 * differs AND it carries an amount the neighbour's books hold but the file's side of that neighbour lacks. A new day
 * next to a differing day with no such amount stays new, so an ordinary overlapping export never stalls.
 */
export function movedFromNeighbourOf(
  verdicts: ReadonlyMap<string, HeldVerdict>,
  observed: ReadonlyMap<string, readonly DayEvent[]>,
  fileByDay: ReadonlyMap<string, readonly DayEvent[]>,
): Map<string, string> {
  const out = new Map<string, string>();
  const shift = shiftDay;
  for (const [day, verdict] of verdicts) {
    if (verdict !== 'new') continue;
    const here = (fileByDay.get(day) ?? []).map((e) => e.amountMinor);
    for (const neighbour of [shift(day, -1), shift(day, 1)]) {
      if (verdicts.get(neighbour) !== 'differs') continue;
      const missing = (observed.get(neighbour) ?? []).map((e) => e.amountMinor);
      for (const a of (fileByDay.get(neighbour) ?? []).map((e) => e.amountMinor)) {
        const i = missing.indexOf(a);
        if (i >= 0) missing.splice(i, 1);
      }
      if (missing.some((a) => here.includes(a))) {
        out.set(day, neighbour);
        break;
      }
    }
  }
  return out;
}

/** An ISO day moved by n calendar days. */
export function shiftDay(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/**
 * D206, A NEW DAY NEXT TO A HELD DAY (critic r2 M-A, r4 H-1; owner 18.11.2026: accept the residual and warn, keep it
 * simple). A re-export without zones can move a row across midnight onto a day the source does not hold yet, and the
 * file alone cannot tell a moved row from a coincidence. A move shifts a row by one day at most (zone offsets differ by
 * less than a day), so a moved row always lands NEXT TO the day it is booked on. The one rule: a new day that carries
 * an amount the books hold on the day before or after (fee events left out, critic r3 L-1: a flat fee is shared by
 * nearly every day) is never booked without a person's answer, whatever `settlement.table_edge_days` says, and the
 * question names the amounts. Answers the neighbour and the shared amounts, else null. The residual (a person confirms
 * a day that did take a moved row) is accepted and stated in A43 §2.
 */
export function nearHeldOf(day: string, file: readonly DayEvent[], observed: ReadonlyMap<string, readonly DayEvent[]>): { day: string; amountsMinor: number[] } | null {
  const notFee = (e: DayEvent): boolean => !e.eventId.endsWith(':fee');
  for (const neighbour of [shiftDay(day, -1), shiftDay(day, 1)]) {
    const held = (observed.get(neighbour) ?? []).filter(notFee).map((e) => e.amountMinor);
    if (held.length === 0) continue;
    const shared = [...new Set(file.filter(notFee).map((e) => e.amountMinor).filter((a) => held.includes(a)))].sort((a, b) => a - b);
    if (shared.length > 0) return { day: neighbour, amountsMinor: shared };
  }
  return null;
}

/**
 * The rule a NEW day of a whole-day document is decided by, else null (it books): an edge by
 * `settlement.table_edge_days`, a near-held day (`nearHeldOf`) by `ask` (an edge under `exclude` stays out).
 */
export function newDayModeOf(mode: TableEdgeDaysMode, isEdge: boolean, nearHeld: boolean): TableEdgeDaysMode | null {
  if (nearHeld) return isEdge && mode === 'exclude' ? 'exclude' : 'ask';
  return isEdge ? mode : null;
}

/** Every calendar day from `first` to `last`, both included. */
export function daysBetween(first: string, last: string): string[] {
  const out: string[] = [];
  for (let d = first; d <= last && out.length <= 4000; d = shiftDay(d, 1)) out.push(d);
  return out;
}

/**
 * D206, A HELD DAY THE FILE IS SILENT ON (critic r3 H-1). A day inside the file's range that the source holds by
 * whole-day ids, and that the file has no row for, before today, is a day that differs (the file's side is empty):
 * a re-export that moved that day's late sale onto the next day must not book it there. With it, every one-way move
 * is met, because a move across midnight shifts a row by one day at most: from a day inside the range by
 * `movedFromNeighbourOf`, from the day just outside it by `nearHeldOf`. A day held through another door (not by
 * whole-day ids) is not counted (one door per source, A43 §2).
 */
export function silentHeldDaysOf(fileDays: ReadonlySet<string>, first: string, last: string, observed: ReadonlyMap<string, readonly DayEvent[]>, today: string): string[] {
  return daysBetween(first, last).filter((d) => d < today && !fileDays.has(d) && (observed.get(d) ?? []).length > 0 && (observed.get(d) ?? []).every((o) => isDayId(o.eventId)));
}

/** The sum and count of a list of day events. */
export function daySumOf(list: readonly DayEvent[]): { events: number; amountMinor: number } {
  return { events: list.length, amountMinor: list.reduce((s, e) => s + e.amountMinor, 0) };
}
