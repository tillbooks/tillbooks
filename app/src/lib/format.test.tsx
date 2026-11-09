/**
 * The calendar formatters (K-38, D137): a day is `TT.MM.JJJJ`, a month is "August 2026", and a value
 * that is not a calendar value comes back unchanged. `formatDate` is asserted to BE the Journal's
 * formatter, so there is one implementation of a day on screen.
 */
import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';

import { I18nProvider, formatDate as journalFormatDate } from '../i18n';
import { formatCalendar, formatDate, formatMonth, useCalendarFormat } from './format';

describe('formatDate: the Journal formatter, re-exported', () => {
  it('is the very same function the Journal uses', () => {
    expect(formatDate).toBe(journalFormatDate);
  });

  it('writes a day as TT.MM.JJJJ, from a date or an instant', () => {
    expect(formatDate('2026-09-06')).toBe('06.09.2026');
    expect(formatDate('2024-03-15T10:12:00Z')).toBe('15.03.2024');
  });
});

describe('formatMonth: a month in words', () => {
  it('writes 2026-08 as "August 2026" in both locales', () => {
    expect(formatMonth('2026-08')).toBe('August 2026');
    expect(formatMonth('2026-08', 'en')).toBe('August 2026');
  });

  it('spells the German months with real umlauts and the English ones in English', () => {
    expect(formatMonth('2026-03')).toBe('März 2026');
    expect(formatMonth('2026-05')).toBe('Mai 2026');
    expect(formatMonth('2026-03', 'en')).toBe('March 2026');
    expect(formatMonth('2026-12', 'en')).toBe('December 2026');
  });

  it('takes the month of a full date or instant', () => {
    expect(formatMonth('2026-10-31')).toBe('Oktober 2026');
    expect(formatMonth('2026-01-01T00:00:00Z', 'en')).toBe('January 2026');
  });

  it('returns a non-calendar value unchanged rather than inventing a month', () => {
    expect(formatMonth('2026-13')).toBe('2026-13');
    expect(formatMonth('Q3 2026')).toBe('Q3 2026');
    expect(formatMonth('')).toBe('');
  });
});

describe('formatCalendar: the right one of the two', () => {
  it('a period becomes a month, a day or an instant becomes a date, anything else is untouched', () => {
    expect(formatCalendar('2026-08')).toBe('August 2026');
    expect(formatCalendar('2026-08-31')).toBe('31.08.2026');
    expect(formatCalendar('2026-09-06T08:00:00Z')).toBe('06.09.2026');
    expect(formatCalendar('RE-001')).toBe('RE-001');
  });

  it('leaves no ISO date shape behind for a calendar value', () => {
    for (const value of ['2026-08', '2026-08-31', '2026-09-06T08:00:00Z']) {
      expect(formatCalendar(value)).not.toMatch(/\d{4}-\d{2}/);
    }
  });
});

describe('useCalendarFormat: bound to the current locale', () => {
  function wrap(locale: 'de-CH' | 'en') {
    return ({ children }: { children: ReactNode }) => (
      <I18nProvider initialLocale={locale}>{children}</I18nProvider>
    );
  }

  it('names months in the reader locale', () => {
    const de = renderHook(() => useCalendarFormat(), { wrapper: wrap('de-CH') });
    expect(de.result.current.month('2026-03')).toBe('März 2026');
    expect(de.result.current.calendar('2026-03-01')).toBe('01.03.2026');
    const en = renderHook(() => useCalendarFormat(), { wrapper: wrap('en') });
    expect(en.result.current.month('2026-03')).toBe('March 2026');
    expect(en.result.current.date('2026-03-01')).toBe('01.03.2026');
  });
});
