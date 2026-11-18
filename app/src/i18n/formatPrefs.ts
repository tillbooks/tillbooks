/**
 * D195: the person's format preferences, held for the plain formatters (`formatDate`, `formatMoney`'s signed
 * form, the bank row's short date). Set by `FormatPrefsStamp` from `appearance.date_format` and
 * `appearance.amount_sign` (and by a suite). The formatters are plain functions called from every surface, so
 * they read these values rather than a context; a surface shows a changed format on its next render.
 *
 * A module of its own, with no React and no catalogue: `app/src/surfaces/Bank/model.ts` reads it, and the root
 * suites import that file straight under Node.
 */

/** `appearance.amount_sign`: a plus before money in and a minus before money out, or only the minus. */
export type AmountSignStyle = 'plus_minus' | 'minus_only';
/** `appearance.date_format`: `31.12.2026`, `2026-12-31` or `12/31/2026`. */
export type DateFormat = 'ch' | 'iso' | 'us';

const DEFAULT_FORMAT_PREFS: { amountSign: AmountSignStyle; dateFormat: DateFormat } = { amountSign: 'plus_minus', dateFormat: 'ch' };
const formatPrefs: { amountSign: AmountSignStyle; dateFormat: DateFormat } = { ...DEFAULT_FORMAT_PREFS };

/** Sets what the person chose; an unknown value is ignored. */
export function setFormatPrefs(next: { amountSign?: string | null; dateFormat?: string | null }): void {
  if (next.amountSign === 'plus_minus' || next.amountSign === 'minus_only') formatPrefs.amountSign = next.amountSign;
  if (next.dateFormat === 'ch' || next.dateFormat === 'iso' || next.dateFormat === 'us') formatPrefs.dateFormat = next.dateFormat;
}

/** Back to the defaults (a suite's cleanup). */
export function resetFormatPrefs(): void {
  Object.assign(formatPrefs, DEFAULT_FORMAT_PREFS);
}

/** The format preferences in force. */
export function formatPrefsNow(): { amountSign: AmountSignStyle; dateFormat: DateFormat } {
  return { ...formatPrefs };
}

/**
 * The sign of a SIGNED amount (`formatMoney(..., { signed: true })`): the typographic minus before money out,
 * a plus before money in unless the person chose `minus_only`, nothing for zero.
 */
export function signedPrefix(minor: number): string {
  if (minor < 0) return '−';
  if (minor > 0 && formatPrefs.amountSign === 'plus_minus') return '+';
  return '';
}
