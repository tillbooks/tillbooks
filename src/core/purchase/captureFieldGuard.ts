/**
 * A41.3 (security review, 07.11.2026): DEFENCE AT THE ENGINE WRITE for the capture fields the engine's pairing
 * reads (`ENGINE_CAPTURE_KEYS`). A value that would steer or hide what a person sees is refused before anything
 * is written, whoever writes it (an agent's or an operator's `capture_extract`, a supplied QR payload, the
 * corrections of `capture_commit`):
 *  - no control, format, line- or paragraph-separator character in any text (`\p{Cc}`, `\p{Cf}`, `\p{Zl}`,
 *    `\p{Zp}`: a right-to-left override that makes "AG Telco" read "Telco AG", a zero-width joiner inside an
 *    IBAN): `invalid_field_characters { key }`;
 *  - an `iban` must pass its mod-97 checksum (an empty value clears it): `invalid_iban { key }`;
 *  - a date of the set is a real calendar day: `invalid_date { key }`;
 *  - `vendor_uid` keeps no format rule (foreign VAT ids exist), only the character rule.
 * A LEAF beside `captureHold.ts`.
 */

import { err } from '../result.js';
import type { Err } from '../result.js';
import { ENGINE_CAPTURE_KEYS, ENGINE_DATE_KEYS, calendarDay } from '../banking/belegFigures.js';
import { isValidIban } from '../setup/iban.js';

const FORBIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

/** Every string inside a field value (an amount is `{ minor, currency }`). */
function stringsOf(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) for (const x of v) stringsOf(x, out);
  else if (v !== null && typeof v === 'object') for (const x of Object.values(v as Record<string, unknown>)) stringsOf(x, out);
  return out;
}

/** Why `value` may not be written to the engine field `key`, or null (any other key is not judged here). */
export function engineFieldRefusal(key: string, value: unknown): Err | null {
  if (!(ENGINE_CAPTURE_KEYS as readonly string[]).includes(key)) return null;
  if (stringsOf(value).some((s) => FORBIDDEN.test(s))) {
    return err('invalid_field_characters', { key, reason: 'control, format or separator characters (such as a bidi override or a zero-width space) are not allowed in this field' }) as Err;
  }
  // Critic A41.3 r2 P1: a date the pairing reads is a real calendar day (`2026-13-01` is not); an empty value
  // clears it.
  if ((ENGINE_DATE_KEYS as readonly string[]).includes(key) && !(value === '' || calendarDay(value) !== null)) {
    return err('invalid_date', { key, reason: 'a date is a real calendar day, YYYY-MM-DD' }) as Err;
  }
  if (key === 'iban') {
    if (typeof value !== 'string') return err('invalid_iban', { key, reason: 'an IBAN is text' }) as Err;
    if (value.trim() !== '' && !isValidIban(value)) return err('invalid_iban', { key, reason: 'the IBAN fails its check digits (mod 97)' }) as Err;
  }
  return null;
}
