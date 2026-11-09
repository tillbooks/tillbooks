/**
 * A41.3 re-cut v2 (security review, 07.11.2026): "Zahlen bestätigen" vouches for the figures the person SAW.
 * An agent may rewrite a capture's fields between the read that rendered them and the click, so the
 * confirmation sends back, per capture, what that read answered: its `sha256` and its `engineFields` (every field
 * TILL pairs a receipt with a bank line on, an absent one absent), as `confirm_capture_figures { captures:
 * [{ captureId, expected: { sha256, fields } }] }`. The engine compares them with the live capture under the write
 * lock and refuses the whole call `figures_changed { captureIds }` when anything moved; the Studio then re-reads
 * and asks again, never retrying on its own.
 *
 * WHAT IS SHOWN IS WHAT IS SENT. Every engine field with a value is rendered as its own labelled element, from
 * the same `engineFields` that are sent, each value isolated left to right (`dir="ltr"`, `unicode-bidi:
 * isolate`). A free-text value holding control, format (bidi, zero-width) or line-break characters cannot be
 * shown exactly, so such a capture is NOT confirmable here: `confirmEntryOf` answers null and the host says why
 * (fail closed: nothing is sent, so no value the person did not see is ever vouched for); the value is corrected
 * in the Belegeingang first. Sending the normalised text instead would only meet `figures_changed` on every try.
 *
 * The key list mirrors the engine's `ENGINE_CAPTURE_KEYS` (`core/banking/belegFigures.ts`), held equal by
 * `test/style/studio-mirrors-engine-enums.test.mjs`; it orders the display and names the fields to show.
 */

/** The capture fields the engine's trust covers (a mirror of `ENGINE_CAPTURE_KEYS`). */
export const CAPTURE_TRUST_FIELD_KEYS = ['amount', 'currency', 'vat_amount', 'vendor_name', 'iban', 'vendor_uid', 'invoice_date', 'due_date', 'reference'] as const;

/** One capture's confirmation: the read's bytes hash and its engine fields, exactly as answered. */
export interface ConfirmEntry {
  captureId: string;
  expected: { sha256: string; fields: Record<string, unknown> };
}

/** The refusal that means "what you saw is no longer what is there": reload, say so, ask again. */
export const STALE_FIGURE_ERRORS: ReadonlySet<string> = new Set(['figures_changed']);

/**
 * What a free-text value cannot hold and still be shown exactly (security review, 07.11.2026): control
 * characters (Cc), format characters (Cf: the bidi overrides and isolates U+202A to U+202E and U+2066 to U+2069,
 * the zero-width U+200B to U+200F, U+FEFF, ...) and the line and paragraph separators (Zl, Zp). A right-to-left
 * override would make a vendor or an IBAN DISPLAY differently from its stored value.
 */
const UNSHOWABLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const UNSHOWABLE_RUNS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu;
/** The no-break space family, shown as a plain space (it looks like one). */
const NBSP_FAMILY = /[\u00a0\u2007\u202f]/g;

/** A free-text value as it is displayed: the unshowable characters and the no-break spaces as plain spaces. */
export function normaliseShown(value: unknown): unknown {
  return typeof value === 'string' ? value.replace(UNSHOWABLE_RUNS, ' ').replace(NBSP_FAMILY, ' ') : value;
}

/** Does a value hold, at ANY depth (an object's member, an array's item), text that cannot be shown exactly? */
function unshowableDeep(value: unknown, depth = 0): boolean {
  // A shape nested this deep is no capture field the Studio knows how to show: fail closed.
  if (depth > 8) return true;
  if (typeof value === 'string') return UNSHOWABLE.test(value);
  if (Array.isArray(value)) return value.some((v) => unshowableDeep(v, depth + 1));
  if (value !== null && typeof value === 'object') return Object.entries(value).some(([k, v]) => UNSHOWABLE.test(k) || unshowableDeep(v, depth + 1));
  return false;
}

/** The money fields (`{ minor, currency }`): what `formatMoney` shows exactly. */
const MONEY_KEYS: ReadonlySet<string> = new Set(['amount', 'vat_amount']);

/**
 * A money value the Studio would show differently from what it sends (security review, 07.11.2026): a minor that
 * is not a safe integer (`formatMoney` truncates a fraction) or a currency that is not three capital letters.
 */
function moneyShownDifferently(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return true;
  const m = value as { minor?: unknown; currency?: unknown };
  return !Number.isSafeInteger(m.minor) || typeof m.currency !== 'string' || !/^[A-Z]{3}$/.test(m.currency);
}

/**
 * Does any engine field hold a value that cannot be shown exactly as it stands: unshowable text at any depth,
 * or a money field `formatMoney` would show differently? Such a capture is not confirmable here (fail closed).
 * The engine refuses these characters on write since 7b4fdc98b; this guards rows written before it.
 */
export function hasUnshowableText(fields: Readonly<Record<string, unknown>>): boolean {
  return Object.entries(fields).some(([key, v]) => unshowableDeep(v) || (MONEY_KEYS.has(key) && moneyShownDifferently(v)));
}

/** The engine fields a read answered, restricted to the trust set (a key outside it is never sent). */
export function engineFieldsOfRead(raw: unknown): Record<string, unknown> | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of CAPTURE_TRUST_FIELD_KEYS) if (r[k] !== undefined) out[k] = r[k];
  return out;
}

/**
 * The confirmation of one capture from the read that rendered it, or null when it cannot be confirmed here:
 * the read named no sha256 or no engine fields, or a value cannot be shown exactly (see the module comment).
 */
export function confirmEntryOf(captureId: string, sha256: unknown, engineFields: unknown): ConfirmEntry | null {
  const fields = engineFieldsOfRead(engineFields);
  if (typeof sha256 !== 'string' || sha256 === '' || fields === null || hasUnshowableText(fields)) return null;
  return { captureId, expected: { sha256, fields } };
}
