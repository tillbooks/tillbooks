/**
 * THE `till-settlement/v1` FORMAT: what a payment processor or a marketplace hands TILL about the money
 * that moved through its balance, and the exact rules TILL reads it by.
 *
 * The format is processor-neutral on purpose. Any system that holds a balance on the company's behalf (a
 * card acquirer, a marketplace, a payment platform, a booking platform that collects for its sellers) can
 * emit it, and TILL books it the same way: each event becomes one entry against the owner's clearing
 * account (the Durchlaufkonto), under a booking template the OWNER keeps in TILL (`template.ts`). The file
 * never decides an account or a tax code: its `clearingAccount` and every `vat.code` are the producer's
 * labels, read for nothing.
 *
 * A file:
 *
 *   { schema: 'till-settlement/v1', source: { system, processor, entity? }, generatedAt?, period?,
 *     currency?, clearingAccount?, signConvention?, warnings?: string[], events: Event[] }
 *
 * An event:
 *
 *   { id, kind, day (YYYY-MM-DD, the booking day in the company's time zone), currency,
 *     amount (signed effect on the processor balance, gross incl. VAT; positive = into the balance),
 *     net, vat: { amount, code?, rate? } | null, document?: { type?, number } | null,
 *     counterparty?, description?, refs?: { ...string keys }, date? (ISO instant), month? }
 *
 * The rules, each a refusal with a code and a sentence (`readSettlementDocument`):
 *
 *  - the whole file refuses when it is not an object, when `schema` is not `till-settlement/v1`
 *    (`unsupported_schema`), when `source.system` / `source.processor` are missing (`invalid_settlement`),
 *    or when `events` is not an array of at most `SETTLEMENT_MAX_EVENTS`;
 *  - ONE EVENT refuses (the others still import) when: it is not an object (`invalid_event`); its `id` is
 *    missing or blank (`missing_id`) or another event of the file carries the same id (`duplicate_id`, every
 *    occurrence: which one is right is not knowable); `day` is not a real calendar date (`invalid_day`); its
 *    `currency` is not the workspace's (`currency_mismatch`); its `kind` is not one of `SETTLEMENT_KINDS`
 *    (`unknown_kind`); `amount`, `net` or `vat.amount` is not an exact decimal of at most two places
 *    (`invalid_amount`); or `amount` is not `net + vat.amount` to the Rappen (`amount_mismatch`);
 *  - unknown extra fields, at any level, are ignored.
 *
 * MONEY IS READ EXACTLY, never through a float. An amount is a JSON number or a decimal string; a number is
 * read through its shortest decimal spelling (`String(10.81)` is `"10.81"`, the same text JSON carried), and
 * the decimal text is then turned into integer Rappen by its digits. Three places (`10.815`), an exponent
 * (`1e-3`), a sign other than a leading minus, or more than 13 integer digits refuse `invalid_amount`.
 */

/** The one schema this reader takes. */
export const SETTLEMENT_SCHEMA = 'till-settlement/v1';

/** Every event kind the format knows (§H-ENUM, single point; the template is keyed by them). */
export const SETTLEMENT_KINDS = [
  'sale',
  'refund',
  'processing_fee',
  'service_fee',
  'third_party_payout',
  'third_party_payout_reversal',
  'reserve',
  'bank_payout',
  'bank_payout_summary',
  'other',
] as const;
export type SettlementKind = (typeof SETTLEMENT_KINDS)[number];

/** The most events one file carries (a busy month of a small platform, with room). */
export const SETTLEMENT_MAX_EVENTS = 20_000;
/** The longest id, source name, document number and text field TILL keeps. */
export const SETTLEMENT_ID_MAX = 200;
export const SETTLEMENT_SOURCE_MAX = 100;
export const SETTLEMENT_TEXT_MAX = 500;
/** The most bytes of `refs` (as JSON) TILL keeps per event. */
export const SETTLEMENT_REFS_MAX_BYTES = 4096;

/** The per-event refusal codes, with the sentence an agent reads (the Studio renders its own words). */
export const SETTLEMENT_EVENT_REFUSALS: Readonly<Record<string, string>> = {
  invalid_event: 'the event is not an object',
  missing_id: 'the event has no id',
  duplicate_id: 'another event of the same file carries this id, so which one is right is not knowable',
  invalid_day: 'day is not a calendar date in the form YYYY-MM-DD',
  currency_mismatch: 'the event is in another currency than the workspace',
  unknown_kind: 'the kind is not one the format knows',
  invalid_amount: 'an amount is not an exact decimal with at most two places',
  amount_mismatch: 'amount is not net plus the VAT amount to the Rappen',
};

/** One event as TILL read it: every amount in signed integer Rappen. */
export interface SettlementEvent {
  /** The event's place in the file, 0-based. */
  index: number;
  id: string;
  kind: SettlementKind;
  day: string;
  currency: string;
  amountMinor: number;
  netMinor: number;
  /** The VAT amount the file states, or null when the event carries no VAT object. */
  vatMinor: number | null;
  /** The producer's VAT code and rate, kept for the record and never read to book. */
  vatCode: string | null;
  vatRate: string | null;
  documentType: string | null;
  documentNumber: string | null;
  counterparty: string | null;
  description: string | null;
  /** The external references as compact JSON (at most `SETTLEMENT_REFS_MAX_BYTES`), or null. */
  refsJson: string | null;
}

/** One event TILL refused, with what it could read of it. */
export interface RefusedSettlementEvent {
  index: number;
  id: string | null;
  kind: string | null;
  code: string;
  reason: string;
  /** The amount when it could be read exactly, so the reconciliation still counts it. */
  amountMinor: number | null;
}

export interface SettlementDocument {
  system: string;
  processor: string;
  entity: string | null;
  warnings: string[];
  events: SettlementEvent[];
  refused: RefusedSettlementEvent[];
}

export type SettlementReadError = { ok: false; error: string; field?: string; reason: string };

const AMOUNT_TEXT = /^-?\d{1,13}(?:\.\d{1,2})?$/;
const DAY_TEXT = /^\d{4}-\d{2}-\d{2}$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Object.prototype.toString.call(value) === '[object Object]';
}

/**
 * An exact decimal amount in integer Rappen, or null when it is not one. A JSON number goes through its
 * shortest round-trip spelling, so `10.81` reads as the text `10.81` (never as 1080.9999...). `-0` is 0.
 */
export function parseExactMinor(value: unknown): number | null {
  let text: string;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    text = String(value);
  } else if (typeof value === 'string') {
    text = value;
  } else {
    return null;
  }
  if (!AMOUNT_TEXT.test(text)) return null;
  const negative = text.startsWith('-');
  const body = negative ? text.slice(1) : text;
  const [whole, frac = ''] = body.split('.');
  const minor = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  if (!Number.isSafeInteger(minor)) return null;
  return negative ? 0 - minor : minor;
}

/** A real calendar date `YYYY-MM-DD` (rejects `2026-02-30` by round-trip). */
export function isSettlementDay(value: unknown): value is string {
  if (typeof value !== 'string' || !DAY_TEXT.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** A trimmed string of at most `max` characters, else null (a longer one is cut, never refused). */
function textOf(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const t = value.trim();
  if (t.length === 0) return null;
  return t.length > max ? t.slice(0, max) : t;
}

/** A source name as the template and the idempotency key read it: trimmed and lower case. */
export function normalizeSourceName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const t = value.trim().toLowerCase();
  return t.length === 0 || t.length > SETTLEMENT_SOURCE_MAX ? null : t;
}

function refusal(field: string | undefined, error: string, reason: string): SettlementReadError {
  return { ok: false, error, ...(field !== undefined ? { field } : {}), reason };
}

/**
 * Read a `till-settlement/v1` document: the whole-file checks first (any of them refuses the file), then
 * every event on its own (a refused event never stops the others). `currency` is the workspace's base
 * currency, the only one an event may carry.
 */
export function readSettlementDocument(raw: unknown, currency: string): { ok: true; document: SettlementDocument } | SettlementReadError {
  if (!isPlainObject(raw)) return refusal('settlement', 'invalid_settlement', 'the settlement must be a JSON object');
  if (raw['schema'] !== SETTLEMENT_SCHEMA) {
    return refusal('schema', 'unsupported_schema', `this TILL reads ${SETTLEMENT_SCHEMA} only; the file says ${JSON.stringify(raw['schema'] ?? null)}`);
  }
  const source = raw['source'];
  if (!isPlainObject(source)) return refusal('source', 'invalid_settlement', 'source must name the system and the processor');
  const system = normalizeSourceName(source['system']);
  const processor = normalizeSourceName(source['processor']);
  if (system === null) return refusal('source.system', 'invalid_settlement', `source.system must be a name of 1 to ${SETTLEMENT_SOURCE_MAX} characters`);
  if (processor === null) return refusal('source.processor', 'invalid_settlement', `source.processor must be a name of 1 to ${SETTLEMENT_SOURCE_MAX} characters`);
  const events = raw['events'];
  if (!Array.isArray(events)) return refusal('events', 'invalid_settlement', 'events must be an array');
  if (events.length > SETTLEMENT_MAX_EVENTS) return refusal('events', 'invalid_settlement', `at most ${SETTLEMENT_MAX_EVENTS} events per file`);
  const warnings = Array.isArray(raw['warnings']) ? (raw['warnings'] as unknown[]).filter((w): w is string => typeof w === 'string').map((w) => w.slice(0, SETTLEMENT_TEXT_MAX)) : [];

  // Ids that occur more than once refuse every occurrence.
  const seen = new Map<string, number>();
  for (const e of events) {
    if (!isPlainObject(e)) continue;
    const id = textOf(e['id'], SETTLEMENT_ID_MAX + 1);
    if (id !== null) seen.set(id, (seen.get(id) ?? 0) + 1);
  }

  const read: SettlementEvent[] = [];
  const refused: RefusedSettlementEvent[] = [];
  events.forEach((e, index) => {
    const refuse = (code: string, id: string | null, kind: string | null, amountMinor: number | null): void => {
      refused.push({ index, id, kind, code, reason: SETTLEMENT_EVENT_REFUSALS[code] ?? code, amountMinor });
    };
    if (!isPlainObject(e)) return refuse('invalid_event', null, null, null);
    const kindRaw = typeof e['kind'] === 'string' ? e['kind'] : null;
    const amountRead = parseExactMinor(e['amount']);
    const id = textOf(e['id'], SETTLEMENT_ID_MAX + 1);
    if (id === null || id.length > SETTLEMENT_ID_MAX) return refuse('missing_id', null, kindRaw, amountRead);
    if ((seen.get(id) ?? 0) > 1) return refuse('duplicate_id', id, kindRaw, amountRead);
    if (!isSettlementDay(e['day'])) return refuse('invalid_day', id, kindRaw, amountRead);
    if (e['currency'] !== currency) return refuse('currency_mismatch', id, kindRaw, null);
    if (kindRaw === null || !(SETTLEMENT_KINDS as readonly string[]).includes(kindRaw)) return refuse('unknown_kind', id, kindRaw, amountRead);
    const netMinor = parseExactMinor(e['net']);
    const vat = e['vat'];
    let vatMinor: number | null = null;
    let vatCode: string | null = null;
    let vatRate: string | null = null;
    if (vat !== null && vat !== undefined) {
      if (!isPlainObject(vat)) return refuse('invalid_amount', id, kindRaw, amountRead);
      vatMinor = parseExactMinor(vat['amount']);
      if (vatMinor === null) return refuse('invalid_amount', id, kindRaw, amountRead);
      vatCode = textOf(vat['code'], SETTLEMENT_SOURCE_MAX);
      vatRate = typeof vat['rate'] === 'number' || typeof vat['rate'] === 'string' ? String(vat['rate']).slice(0, 20) : null;
    }
    if (amountRead === null || netMinor === null) return refuse('invalid_amount', id, kindRaw, amountRead);
    if (amountRead !== netMinor + (vatMinor ?? 0)) return refuse('amount_mismatch', id, kindRaw, amountRead);
    const doc = e['document'];
    const refs = e['refs'];
    let refsJson: string | null = null;
    if (isPlainObject(refs)) {
      const json = JSON.stringify(refs);
      refsJson = Buffer.byteLength(json, 'utf8') <= SETTLEMENT_REFS_MAX_BYTES ? json : JSON.stringify({ truncated: true });
    }
    read.push({
      index,
      id,
      kind: kindRaw as SettlementKind,
      day: e['day'] as string,
      currency,
      amountMinor: amountRead,
      netMinor,
      vatMinor,
      vatCode,
      vatRate,
      documentType: isPlainObject(doc) ? textOf(doc['type'], SETTLEMENT_SOURCE_MAX) : null,
      documentNumber: isPlainObject(doc) ? textOf(doc['number'], SETTLEMENT_ID_MAX) : null,
      counterparty: textOf(e['counterparty'], SETTLEMENT_TEXT_MAX),
      description: textOf(e['description'], SETTLEMENT_TEXT_MAX),
      refsJson,
    });
  });

  return {
    ok: true,
    document: { system, processor, entity: textOf(source['entity'], SETTLEMENT_TEXT_MAX), warnings, events: read, refused },
  };
}
