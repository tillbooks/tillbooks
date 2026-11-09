/**
 * A00's single-source enums (§H-ENUM): legal form, VAT method / timing, base currency, and the
 * fiscal-year-start shape. These are compliance-fixed (§6b), so they live in one place; a spec that
 * legitimately extends one adds the value here.
 */

export const LEGAL_FORMS = new Set(['einzelfirma', 'gmbh', 'ag']);
export const VAT_METHODS = new Set(['effektiv', 'saldo', 'none']);
export const VAT_TIMINGS = new Set(['ist', 'soll']);
export const CURRENCIES = new Set(['CHF', 'EUR', 'USD']);

/** `MM-DD`, a real month and a day valid within it (rejects `13-01`, `02-30`). */
export function isFiscalYearStart(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{2}-\d{2}$/.test(value)) return false;
  const month = Number(value.slice(0, 2));
  const day = Number(value.slice(3, 5));
  if (month < 1 || month > 12 || day < 1) return false;
  const daysInMonth = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= (daysInMonth[month - 1] ?? 31);
}
