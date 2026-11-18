/**
 * D195: the person's format preferences, handed to the plain formatters.
 *
 * `formatDate` and `formatMoney` are plain functions called from every surface (hundreds of call sites), so
 * they cannot each read a context. This stamp reads `appearance.date_format` and `appearance.amount_sign`
 * through the one preference store and sets them on the formatters, the way `MotionLevelStamp` stamps the
 * motion level on the document. It renders BEFORE the router (a sibling above it in `main.tsx`) and sets the
 * values while it renders, so the first paint of a surface already uses them; the assignment is idempotent.
 * A surface shows a changed format on its next render (a person changes it on Meine Einstellungen and the
 * next surface they open reads it).
 */
import { setFormatPrefs } from '../i18n';
import { usePref } from '../lib/prefs';

export const DATE_FORMAT_PREF = 'appearance.date_format';
export const AMOUNT_SIGN_PREF = 'appearance.amount_sign';

export function FormatPrefsStamp(): null {
  const [dateFormat] = usePref<string>(DATE_FORMAT_PREF);
  const [amountSign] = usePref<string>(AMOUNT_SIGN_PREF);
  setFormatPrefs({ dateFormat, amountSign });
  return null;
}
