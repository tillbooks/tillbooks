/**
 * G22 due-date resolution: an offset from the period end, a statutory deadline rule, or another
 * item's date (items 1 to 3 inherit item 4's, so a fresh run never opens with three overdue rows).
 *
 * The two MWST rules are 60 days after the Abrechnungsperiode ends: Art. 71 Abs. 1 MWSTG for the
 * filing and Art. 86 Abs. 1 MWSTG for the payment (SR 641.20; verified 2026-09-09 against
 * https://www.estv.admin.ch/de/mwst-bezahlen, which quotes both and links the fedlex anchors
 * https://www.fedlex.admin.ch/eli/cc/2009/615/de#art_71 and #art_86).
 *
 * The fiscal-year rules resolve ONLY on a `year` run, whose period end IS the fiscal year end (spec
 * §10.3): the Umsatzabstimmung at + 180 days and the Berichtigung at + 240 days (Art. 72 Abs. 1 MWSTG
 * names the return of the period containing the 180th day; the row text carries that sentence, the
 * due date is the 180th day), and the ordentliche Generalversammlung six months on (Art. 699 Abs. 2
 * OR for the AG, Art. 805 OR for the GmbH). On a `vat_period` or `month` run they answer null: a
 * deadline the canon does not state for that period is not invented.
 */

import type { ChecklistPeriodKind, ChecklistTemplateItem, DeadlineRule } from './types.js';

/**
 * Days after the period end, per statutory rule and period kind; null when the rule does not resolve
 * from that kind's period end. `gv_6_months` is a calendar rule (`addMonths`), spelled here as the
 * sentinel `MONTHS_6` so the table stays the single source of which rule resolves on which kind.
 */
export const MONTHS_6 = 'months:6' as const;
export const DEADLINE_DAYS_AFTER_PERIOD_END: Readonly<
  Record<DeadlineRule, Readonly<Record<ChecklistPeriodKind, number | typeof MONTHS_6 | null>>>
> = {
  vat_filing_60: { vat_period: 60, month: null, year: null },
  vat_payment_60: { vat_period: 60, month: null, year: null },
  umsatzabstimmung_180: { vat_period: null, month: null, year: 180 },
  berichtigung_240: { vat_period: null, month: null, year: 240 },
  gv_6_months: { vat_period: null, month: null, year: MONTHS_6 },
  prior_year_umsatzabstimmung: { vat_period: null, month: null, year: null },
};

/** ISO day arithmetic in UTC, so a Swiss period end never drifts across a DST boundary. */
export function addDays(isoDay: string, days: number): string {
  const [y, m, d] = isoDay.split('-').map(Number) as [number, number, number];
  const t = Date.UTC(y, m - 1, d) + days * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

/** The last day of the month an ISO day falls in. */
export function endOfMonth(isoDay: string): string {
  const [y, m] = isoDay.split('-').map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(last).padStart(2, '0')}`;
}

/** The same calendar day `months` on, clamped to that month's last day (31.12. + 6 -> 30.06.). */
export function addMonths(isoDay: string, months: number): string {
  const [y, m, d] = isoDay.split('-').map(Number) as [number, number, number];
  const total = y * 12 + (m - 1) + months;
  const ty = Math.floor(total / 12);
  const tm = (total % 12) + 1;
  const last = new Date(Date.UTC(ty, tm, 0)).getUTCDate();
  return `${String(ty).padStart(4, '0')}-${String(tm).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}

/** The day before an ISO day. */
export function dayBefore(isoDay: string): string {
  return addDays(isoDay, -1);
}

/**
 * Resolve every item's due date for one period end, in template order, `dueLikeItemId` resolved
 * against the sibling's own resolution (which may itself be a rule). An item with no rule, no offset
 * and no sibling has no date (null): a deadline the canon does not state is not invented.
 */
export function resolveDueDates(
  items: readonly ChecklistTemplateItem[],
  periodEnd: string,
  periodKind: ChecklistPeriodKind = 'vat_period',
): ReadonlyMap<string, string | null> {
  const byId = new Map(items.map((i) => [i.itemId, i]));
  const memo = new Map<string, string | null>();
  const resolve = (item: ChecklistTemplateItem, seen: Set<string>): string | null => {
    const cached = memo.get(item.itemId);
    if (cached !== undefined) return cached;
    let due: string | null = null;
    if (item.deadlineRule !== undefined) {
      const rule = DEADLINE_DAYS_AFTER_PERIOD_END[item.deadlineRule][periodKind];
      due = rule === null ? null : rule === MONTHS_6 ? addMonths(periodEnd, 6) : addDays(periodEnd, rule);
    } else if (item.dueOffsetDays !== undefined) {
      due = addDays(periodEnd, item.dueOffsetDays);
    } else if (item.dueLikeItemId !== undefined && !seen.has(item.dueLikeItemId)) {
      const sibling = byId.get(item.dueLikeItemId);
      due = sibling === undefined ? null : resolve(sibling, new Set([...seen, item.itemId]));
    }
    memo.set(item.itemId, due);
    return due;
  };
  for (const item of items) resolve(item, new Set([item.itemId]));
  return memo;
}
