/**
 * A41 (D184), THE ONE READING of a captured receipt's figures: its amount, its currency and the VAT it
 * prints. A LEAF (no imports), so the matcher (`belegMatch.ts`), the evidence, the A41.3 assignment and the
 * store's one-time migration all read a receipt the same way (critic A41 r1 E1: the pool and the evidence
 * must agree).
 */

/** A receipt's figures as the matcher and the assignment compare them. */
export interface ReceiptFigures {
  amountMinor: number;
  currency: string;
  /** The printed VAT in the receipt's currency, else null. */
  vatMinor: number | null;
}

/** A positive money value `{ minor, currency? }`, else null. */
export function moneyOf(v: unknown): { minor: number; currency: string | null } | null {
  if (v === null || typeof v !== 'object') return null;
  const m = v as { minor?: unknown; currency?: unknown };
  if (!Number.isSafeInteger(m.minor) || (m.minor as number) <= 0) return null;
  return { minor: m.minor as number, currency: typeof m.currency === 'string' && /^[A-Z]{3}$/.test(m.currency) ? m.currency : null };
}

/**
 * The figures of a receipt from its live fields: the amount, its currency (the amount's own, else the
 * stated `currency` field, else the workspace's base currency) and the printed VAT in that currency. Null
 * when the receipt states no positive amount.
 */
export function receiptFigures(fields: ReadonlyMap<string, unknown>, baseCurrency: string): ReceiptFigures | null {
  const amount = moneyOf(fields.get('amount'));
  if (amount === null) return null;
  const stated = fields.get('currency');
  const currency = amount.currency ?? (typeof stated === 'string' && /^[A-Z]{3}$/.test(stated) ? stated : baseCurrency);
  const vat = moneyOf(fields.get('vat_amount'));
  return { amountMinor: amount.minor, currency, vatMinor: vat !== null && (vat.currency === null || vat.currency === currency) ? vat.minor : null };
}

/** The field keys whose live rows make up a receipt's figures (amount, its currency, the printed VAT). */
export const FIGURE_KEYS = ['amount', 'currency', 'vat_amount'] as const;

/**
 * A41.3 re-cut v2 (critic A41.3 r1 S1/S2, security review 07.11.2026): EVERY capture field the engine's
 * pairing reads, the figures and the match keys alike (the matcher's sender words, IBAN and UID, and its
 * dates). ONE set: the matcher reads a capture only through `engineFieldsOf` (so it cannot read a key outside
 * it, `test/banking/a41-3-fields.test.mjs`), and the trust check requires a person's confirmation or the QR read
 * to cover every key in it. A governed seat that rewrites any of them after the confirmation voids the trust,
 * so it can no more steer a confirmed receipt onto another line than change its amount.
 */
export const ENGINE_CAPTURE_KEYS = ['amount', 'currency', 'vat_amount', 'vendor_name', 'iban', 'vendor_uid', 'invoice_date', 'due_date', 'reference'] as const;
export type EngineCaptureKey = (typeof ENGINE_CAPTURE_KEYS)[number];

/** The date keys of the set: each must be a real calendar day (`calendarDay`). */
export const ENGINE_DATE_KEYS = ['invoice_date', 'due_date'] as const;

/**
 * Critic A41.3 r2 P1, THE ONE DATE PARSER every reader of a capture date goes through: a `YYYY-MM-DD` string
 * that names a real calendar day, else null. Never throws; a null date makes a receipt no candidate on that
 * date (a legacy row holding `2026-13-01` is simply undated).
 */
export function calendarDay(v: unknown): string | null {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const [y, m, d] = v.split('-').map(Number) as [number, number, number];
  const t = Date.UTC(y, m - 1, d);
  if (!Number.isFinite(t)) return null;
  const back = new Date(t);
  return back.getUTCFullYear() === y && back.getUTCMonth() === m - 1 && back.getUTCDate() === d ? v : null;
}

/** The live fields restricted to the engine's set: the only view of a capture the pairing may read. */
export function engineFieldsOf(fields: ReadonlyMap<string, unknown>): ReadonlyMap<EngineCaptureKey, unknown> {
  const out = new Map<EngineCaptureKey, unknown>();
  for (const k of ENGINE_CAPTURE_KEYS) if (fields.has(k)) out.set(k, fields.get(k));
  return out;
}

/**
 * The canonical snapshot of a capture's engine fields: the live value text per key of the set, keys in the
 * set's order, absent keys omitted. Two snapshots are equal exactly when no engine field moved.
 */
export function engineSnapshotOf(rows: readonly { key: string; value: string }[]): string {
  const live = new Map(rows.map((r) => [r.key, r.value]));
  const out: [string, string][] = [];
  for (const k of ENGINE_CAPTURE_KEYS) {
    const v = live.get(k);
    if (v !== undefined) out.push([k, v]);
  }
  return JSON.stringify(out);
}

/** Do two readings name the same figures? */
export function sameFigures(a: ReceiptFigures | null, b: ReceiptFigures | null): boolean {
  if (a === null || b === null) return a === b;
  return a.amountMinor === b.amountMinor && a.currency === b.currency && a.vatMinor === b.vatMinor;
}

/** JSON with object keys sorted, so two equal values compare equal however they were written. */
export function canonicalJson(v: unknown): string {
  if (v === undefined) return 'undefined';
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .filter((k) => o[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(',')}}`;
}

/**
 * The live engine fields of a capture as values (`{ key: value }`, absent keys omitted): what a person saw and
 * sends back as `expected.fields` when confirming them (`confirm_capture_figures`), and what capture reads show.
 */
export function engineFieldValuesOf(rows: readonly { key: string; value: string }[]): Partial<Record<EngineCaptureKey, unknown>> {
  const parsed = parseFieldRows(rows);
  const out: Partial<Record<EngineCaptureKey, unknown>> = {};
  for (const k of ENGINE_CAPTURE_KEYS) if (parsed.has(k)) out[k] = parsed.get(k);
  return out;
}

/** Do the `expected` fields name exactly the live engine fields (every key of the set, absent as absent)? */
export function engineFieldsMatch(live: Partial<Record<EngineCaptureKey, unknown>>, expected: unknown): boolean {
  if (expected === null || typeof expected !== 'object' || Array.isArray(expected)) return false;
  const e = expected as Record<string, unknown>;
  if (Object.keys(e).some((k) => !(ENGINE_CAPTURE_KEYS as readonly string[]).includes(k))) return false;
  return ENGINE_CAPTURE_KEYS.every((k) => canonicalJson(live[k]) === canonicalJson(e[k]));
}

/** Parse a capture's live field rows (`capture_fields` key and JSON value). */
export function parseFieldRows(rows: readonly { key: string; value: string }[]): Map<string, unknown> {
  const out = new Map<string, unknown>();
  for (const r of rows) {
    try {
      out.set(r.key, JSON.parse(r.value));
    } catch {
      out.set(r.key, r.value);
    }
  }
  return out;
}
