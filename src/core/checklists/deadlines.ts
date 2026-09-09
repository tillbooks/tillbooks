/**
 * G22 due-date resolution: an offset from the period end, a statutory deadline rule, or another
 * item's date (items 1 to 3 inherit item 4's, so a fresh run never opens with three overdue rows).
 *
 * The two MWST rules are 60 days after the Abrechnungsperiode ends: Art. 71 Abs. 1 MWSTG for the
 * filing and Art. 86 Abs. 1 MWSTG for the payment (SR 641.20; verified 2026-09-09 against
 * https://www.estv.admin.ch/de/mwst-bezahlen, which quotes both and links the fedlex anchors
 * https://www.fedlex.admin.ch/eli/cc/2009/615/de#art_71 and #art_86). G20's three fiscal-year rules
 * are NOT resolvable from a period end and answer null here: a template that used one would need
 * the fiscal config G20 reads, which no shipped checklist template does.
 */

import type { ChecklistTemplateItem, DeadlineRule } from './types.js';

/** Days after the period end, per statutory rule; null when the rule needs a fiscal year instead. */
export const VAT_DEADLINE_DAYS: Readonly<Record<DeadlineRule, number | null>> = {
  vat_filing_60: 60,
  vat_payment_60: 60,
  umsatzabstimmung_180: null,
  berichtigung_240: null,
  prior_year_umsatzabstimmung: null,
};

/** ISO day arithmetic in UTC, so a Swiss period end never drifts across a DST boundary. */
export function addDays(isoDay: string, days: number): string {
  const [y, m, d] = isoDay.split('-').map(Number) as [number, number, number];
  const t = Date.UTC(y, m - 1, d) + days * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

/**
 * Resolve every item's due date for one period end, in template order, `dueLikeItemId` resolved
 * against the sibling's own resolution (which may itself be a rule). An item with no rule, no offset
 * and no sibling has no date (null): a deadline the canon does not state is not invented.
 */
export function resolveDueDates(
  items: readonly ChecklistTemplateItem[],
  periodEnd: string,
): ReadonlyMap<string, string | null> {
  const byId = new Map(items.map((i) => [i.itemId, i]));
  const memo = new Map<string, string | null>();
  const resolve = (item: ChecklistTemplateItem, seen: Set<string>): string | null => {
    const cached = memo.get(item.itemId);
    if (cached !== undefined) return cached;
    let due: string | null = null;
    if (item.deadlineRule !== undefined) {
      const days = VAT_DEADLINE_DAYS[item.deadlineRule];
      due = days === null ? null : addDays(periodEnd, days);
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
