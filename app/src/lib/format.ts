/**
 * The one home for calendar display (K-38, D137): a day is `TT.MM.JJJJ`, a month is "August 2026".
 *
 * WHY. The same ledger wrote "06.09.2026" in the Journal and "2026-09-06" three clicks away on the
 * Anlagen, Wareneingänge and Review surfaces, and "Monatsabschluss 2026-08" on Perioden, because each
 * surface reached for whatever the engine handed it. The design law says dates are `TT.MM.JJJJ` in
 * de-CH and no raw machine value reaches the screen; this module is how a surface keeps that without
 * re-deriving it.
 *
 *   - `formatDate` IS the Journal's formatter (`i18n/formatDate`), re-exported rather than copied, so
 *     there is exactly one implementation of a day on screen. The digits are the same in de-CH and en
 *     (`31.12.2026`) by house style.
 *   - `formatMonth` turns `2026-08` (or any date inside it) into "August 2026" / "August 2026", from
 *     fixed month tables rather than `Intl`, so the output does not depend on the runtime's ICU build.
 *   - `formatCalendar` takes whatever the engine sent (`2026-08`, `2026-08-31`, a full instant) and
 *     picks the right one of the two, for a column that mixes periods and days.
 *
 * A value that is not a calendar value is returned unchanged rather than mangled, so a defect stays
 * visible instead of turning into a plausible wrong date.
 */
import { useMemo } from 'react';

import { formatDate, useI18n, type Locale } from '../i18n';

export { formatDate };

const MONTHS: Record<Locale, readonly string[]> = {
  'de-CH': [
    'Januar',
    'Februar',
    'März',
    'April',
    'Mai',
    'Juni',
    'Juli',
    'August',
    'September',
    'Oktober',
    'November',
    'Dezember',
  ],
  en: [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
  ],
};

/** `YYYY-MM`, optionally followed by `-DD` and a time: the calendar values the engine emits. */
const ISO_MONTH = /^(\d{4})-(\d{2})(?:$|-)/;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}(?:$|T|\s)/;

/**
 * A month as words: `2026-08` (or `2026-08-31`, or an instant in August) becomes "August 2026".
 * Anything that is not a calendar value comes back unchanged.
 */
export function formatMonth(value: string, locale: Locale = 'de-CH'): string {
  const match = ISO_MONTH.exec(value);
  if (match === null) return value;
  const year = match[1] as string;
  const month = Number(match[2]);
  const name = MONTHS[locale][month - 1];
  return name === undefined ? value : `${name} ${year}`;
}

/**
 * Whatever calendar value the engine sent, in the house format: a bare `YYYY-MM` period becomes
 * "August 2026", a day or an instant becomes `31.08.2026`, anything else comes back unchanged.
 */
export function formatCalendar(value: string, locale: Locale = 'de-CH'): string {
  if (ISO_DAY.test(value)) return formatDate(value);
  if (/^\d{4}-\d{2}$/.test(value)) return formatMonth(value, locale);
  return value;
}

/** The calendar formatters bound to the current locale, for a component. */
export interface CalendarFormat {
  date: (value: string) => string;
  month: (value: string) => string;
  calendar: (value: string) => string;
}

export function useCalendarFormat(): CalendarFormat {
  const { locale } = useI18n();
  return useMemo(
    () => ({
      date: formatDate,
      month: (value: string) => formatMonth(value, locale),
      calendar: (value: string) => formatCalendar(value, locale),
    }),
    [locale],
  );
}
