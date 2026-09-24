/**
 * A31, the DETERMINISTIC extraction pass: parse a Swiss QR Code (SPC) payload and its Swico S1
 * billing-information string into typed fields. Pure functions, no I/O, so the statutory shapes are
 * testable in isolation against SIX's and Swico's own worked examples.
 *
 * THIS MODULE OWNS NO FORMAT LAW AND NO CHECK-DIGIT MATH OF ITS OWN. The QRR (mod-10 recursive) and
 * SCOR (ISO 11649 mod-97) validators, and the reference classifier, are A11's / A14's, imported here
 * and never re-implemented: if this module carried a second copy and the two ever disagreed, a bill
 * would quote a reference its own payment matcher rejects (A14's module note, verbatim). A31 parses
 * against A11's structure and revalidates the reference through A21's validators.
 *
 * THE QR SYMBOL DECODE IS NOT HERE, deliberately (spec §9 open question 1, resolved 2026-08-06). A
 * raster QR decoder that is MIT-compatible and provably offline was not admitted into the core, so
 * the deterministic pass locates the SPC payload as TEXT inside the file (a QR-bill whose payload is
 * embedded in the PDF text layer, or a payload uploaded directly), per the spec's own fallback. A
 * pure raster symbol whose payload is only in the pixels yields an honest empty extraction; the
 * raster decode is the G02 plugin lane (§6b), never a core dependency.
 */

import {
  isValidQrrReference,
  isValidScorReference,
} from '../sales/qrbill.js';

/** One field the deterministic pass extracted, before it becomes a `capture_fields` row. */
export interface ParsedField {
  key: string;
  /** JSON-serialisable value, typed per key (money is `{ minor, currency }`, dates are ISO). */
  value: unknown;
  provenance: 'qr' | 'swico';
  confidence: 'high' | 'medium' | 'low';
}

/** A per-field parse failure, recorded on the capture so a dropped value is honest, never guessed. */
export interface ParseNote {
  key: string;
  reason: string;
}

export interface ParsedPayload {
  qrPresent: boolean;
  swicoPresent: boolean;
  fields: ParsedField[];
  notes: ParseNote[];
  /** The creditor IBAN, surfaced for the vendor IBAN-fallback match. */
  iban: string | null;
  /** The Swico `/30/` numeric UID, surfaced for the vendor UID match. */
  swicoUid: string | null;
}

// --- SPC payload location + parse --------------------------------------------------------------

/**
 * Find the Swiss QR Code (SPC) payload inside a file's decoded text, or null when there is none.
 *
 * The SPC payload begins with the literal header `SPC`, then the fixed version `0200` and coding
 * type `1`, each on its own CR+LF-separated line (IG v2.3 §4.1.4, Table 8). We locate that header in
 * the text and return from it to the end, so a payload embedded in a PDF text layer (surrounded by
 * other extracted text) is found without a raster decode. Anything before the header is not payload.
 */
export function locateSpcPayload(text: string): string | null {
  // Normalise the two line-ending conventions to LF for the search; the parser splits on either.
  const idx = text.search(/(^|[\r\n])SPC(\r\n|\n)0200(\r\n|\n)/);
  if (idx < 0) return null;
  // Start exactly at the `SPC` header, not at the preceding newline the lookahead matched.
  const from = text.indexOf('SPC', idx);
  return from < 0 ? null : text.slice(from);
}

/**
 * The SPC element list, in IG v2.3 Table 8 order. Indices are fixed positions the payload guarantees,
 * so reading element 18 for the amount is a position lookup and not a search.
 */
const SPC = {
  HEADER: 0,
  VERSION: 1,
  CODING: 2,
  IBAN: 3,
  CDTR_ADDRTYPE: 4,
  CDTR_NAME: 5,
  CDTR_STREET: 6,
  CDTR_BUILDING: 7,
  CDTR_POSTAL: 8,
  CDTR_TOWN: 9,
  CDTR_COUNTRY: 10,
  // 11..17 ultimate creditor (unused, must be empty)
  AMOUNT: 18,
  CURRENCY: 19,
  // 20..26 ultimate debtor
  REF_TYPE: 27,
  REFERENCE: 28,
  UNSTRUCTURED: 29,
  TRAILER: 30,
  BILLING_INFO: 31,
} as const;

/**
 * Convert a QR `Amt` decimal string to integer Rappen EXACTLY, by string decomposition (P2).
 *
 * Never a float: `parseFloat('1081.00') * 100` is a rounding hazard on a receivable, so the whole and
 * fractional parts are read as integer strings and combined. A value that is not `d+` or `d+.dd`
 * (two decimals, the IG's own format) does not convert and returns null, which the caller records as
 * `unparseable` rather than guessing.
 */
export function amountToRappen(raw: string): number | null {
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(raw.trim());
  if (m === null) return null;
  const whole = m[1]!;
  const frac = (m[2] ?? '').padEnd(2, '0');
  // Safe-integer guard: a payload amount past Number.MAX_SAFE_INTEGER Rappen is not a real bill.
  const minor = Number(whole) * 100 + Number(frac);
  return Number.isSafeInteger(minor) ? minor : null;
}

/**
 * Parse a located SPC payload into typed fields, revalidating the reference through A11/A21.
 *
 * Deterministic and per-field honest: a value that does not parse (an amount that is not a decimal, a
 * reference whose check digit fails) does not become a guessed field. The reference is a special
 * case worth stating: a failing check digit is NOT dropped, it lands with `confidence:'medium'` and a
 * note, because "the paper says this reference but it does not validate" is exactly the fact a
 * reviewer needs, and silently dropping it would hide a typo on a real payment.
 */
export function parseSpcPayload(payload: string): ParsedPayload {
  const el = payload.split(/\r\n|\n/);
  const at = (i: number): string => (el[i] ?? '').trim();
  const fields: ParsedField[] = [];
  const notes: ParseNote[] = [];

  const push = (key: string, value: unknown): void => {
    fields.push({ key, value, provenance: 'qr', confidence: 'high' });
  };

  if (at(SPC.HEADER) !== 'SPC') {
    return { qrPresent: false, swicoPresent: false, fields, notes, iban: null, swicoUid: null };
  }

  const name = at(SPC.CDTR_NAME);
  if (name.length > 0) push('vendor_name', name);

  const iban = at(SPC.IBAN).replace(/\s+/g, '').toUpperCase();
  if (iban.length > 0) push('iban', iban);

  const amountRaw = at(SPC.AMOUNT);
  const currency = at(SPC.CURRENCY);
  if (amountRaw.length > 0) {
    const minor = amountToRappen(amountRaw);
    if (minor === null) notes.push({ key: 'amount', reason: 'unparseable' });
    else if (currency.length === 0) notes.push({ key: 'amount', reason: 'missing_currency' });
    else push('amount', { minor, currency });
  }
  if (currency.length > 0) push('currency', currency);

  const refType = at(SPC.REF_TYPE);
  const reference = at(SPC.REFERENCE).replace(/\s+/g, '');
  if (refType === 'QRR' || refType === 'SCOR' || refType === 'NON') {
    push('reference_type', refType);
  }
  if (reference.length > 0 && refType !== 'NON') {
    // Revalidate through A11's validators (A21 re-exports the same primitives). A structured
    // reference whose check digit fails is a flagged typo, never a silently-high field.
    const valid =
      refType === 'QRR'
        ? isValidQrrReference(reference)
        : refType === 'SCOR'
          ? isValidScorReference(reference.toUpperCase())
          : true;
    if (valid) {
      fields.push({ key: 'reference', value: refType === 'SCOR' ? reference.toUpperCase() : reference, provenance: 'qr', confidence: 'high' });
    } else {
      fields.push({ key: 'reference', value: refType === 'SCOR' ? reference.toUpperCase() : reference, provenance: 'qr', confidence: 'medium' });
      notes.push({ key: 'reference', reason: 'reference_check_digit' });
    }
  }

  const swico = parseSwicoInto(at(SPC.BILLING_INFO), fields, notes);

  return { qrPresent: true, swicoPresent: swico.present, fields, notes, iban: iban || null, swicoUid: swico.uid };
}

// --- Swico S1 billing information --------------------------------------------------------------

/**
 * Split a Swico S1 string on its structural `/` separators, honouring the value escapes.
 *
 * Swico S1 (IG v2.3 Annex D, Table 29): a VALUE must not contain `/` or `\`, and if it does they are
 * escaped `\/` and `\\`. So a `/` is a separator only when it is NOT escaped, and `\\` is a literal
 * backslash. We walk the string, tracking the escape, so `/10/X.66711\/8824` yields the value
 * `X.66711/8824` and not two tokens (Beispiel 4).
 */
export function splitSwico(s: string): string[] {
  const tokens: string[] = [];
  let cur = '';
  let i = 0;
  while (i < s.length) {
    const ch = s[i]!;
    if (ch === '\\' && i + 1 < s.length) {
      // An escaped `/` or `\` contributes the literal second character to the current value.
      cur += s[i + 1];
      i += 2;
      continue;
    }
    if (ch === '/') {
      tokens.push(cur);
      cur = '';
      i += 1;
      continue;
    }
    cur += ch;
    i += 1;
  }
  tokens.push(cur);
  return tokens;
}

/** Swico `/11/` and `/31/` YYMMDD day form to ISO `YYYY-MM-DD`, or null when it is not a day. */
export function swicoDateToIso(yymmdd: string): string | null {
  const m = /^(\d{2})(\d{2})(\d{2})$/.exec(yymmdd);
  if (m === null) return null;
  const mm = Number(m[2]!);
  const dd = Number(m[3]!);
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  // Swico dates are recent (an invoice date), so the century pivot is simple and stated: 20xx.
  return `20${m[1]}-${m[2]}-${m[3]}`;
}

/**
 * Derive the due date from `/40/` conditions plus the `/11/` invoice date. `/40/` is a
 * `discount:days;discount:days` list (e.g. `2:10;0:30`); the net term is the `0:<days>` pair, so the
 * due date is the invoice date plus those days. Returns null when neither is derivable. Pure date
 * arithmetic in UTC, no locale.
 */
function deriveDueDate(invoiceIso: string | null, conditions: string): string | null {
  if (invoiceIso === null) return null;
  let netDays: number | null = null;
  for (const pair of conditions.split(';')) {
    const m = /^(\d+):(\d+)$/.exec(pair.trim());
    if (m !== null && Number(m[1]) === 0) netDays = Number(m[2]);
  }
  if (netDays === null) return null;
  const base = new Date(`${invoiceIso}T00:00:00.000Z`);
  if (Number.isNaN(base.getTime())) return null;
  base.setUTCDate(base.getUTCDate() + netDays);
  return base.toISOString().slice(0, 10);
}

/**
 * Parse a Swico S1 `StrdBkgInf` string, appending its tags as `swico`-provenance fields.
 *
 * Tags parsed (Swico S1 v1.2, 23.11.2018): `/10/` invoice number, `/11/` invoice date (YYMMDD),
 * `/20/` customer reference, `/30/` numeric UID, `/31/` VAT date/period, `/32/` VAT rate(s) with net
 * amounts, `/33/` import VAT, `/40/` conditions (and the derived due date). VAT amounts are stored as
 * PROPOSED values only and are never summed into anything: at commit, A05/A06 recompute the tax (P6).
 */
function parseSwicoInto(
  raw: string,
  fields: ParsedField[],
  notes: ParseNote[],
): { present: boolean; uid: string | null } {
  const s = raw.trim();
  if (!s.startsWith('//S1')) return { present: false, uid: null };

  // After the `//S1` prefix, the string is `/tag/value/tag/value...`. splitSwico on `//S1/10/...`
  // yields ['', '', 'S1', '10', '<v>', '11', '<v>', ...]: the leading `//` produces TWO empty
  // tokens and then the `S1` marker, so the tag/value pairs begin right AFTER `S1`.
  const toks = splitSwico(s);
  const marker = toks.indexOf('S1');
  const start = marker >= 0 ? marker + 1 : 2;
  const tags = new Map<string, string>();
  for (let i = start; i + 1 < toks.length; i += 2) {
    const tag = toks[i]!;
    const val = toks[i + 1]!;
    if (tag.length > 0) tags.set(tag, val);
  }

  const push = (key: string, value: unknown, confidence: 'high' | 'medium' | 'low' = 'high'): void => {
    fields.push({ key, value, provenance: 'swico', confidence });
  };

  const invoiceNo = tags.get('10');
  if (invoiceNo !== undefined && invoiceNo.length > 0) push('invoice_no', invoiceNo);

  let invoiceIso: string | null = null;
  const date11 = tags.get('11');
  if (date11 !== undefined && date11.length > 0) {
    invoiceIso = swicoDateToIso(date11);
    if (invoiceIso !== null) push('invoice_date', invoiceIso);
    else notes.push({ key: 'invoice_date', reason: 'unparseable' });
  }

  const custRef = tags.get('20');
  if (custRef !== undefined && custRef.length > 0) push('customer_reference', custRef);

  const uidDigits = (() => {
    const raw30 = tags.get('30');
    if (raw30 === undefined) return null;
    const digits = raw30.replace(/\D/g, '');
    return digits.length > 0 ? digits : null;
  })();
  if (uidDigits !== null) push('vendor_uid', uidDigits);

  const vat32 = tags.get('32');
  if (vat32 !== undefined && vat32.length > 0) {
    // A single percentage (`7.7`) or a `rate:net;rate:net` list. Store both a single `vat_rate`
    // (the whole-invoice rate, when it is one value) and the full `vat_breakdown` list, as PROPOSED
    // values only. Never summed: A05/A06 own the tax at commit.
    if (/^\d+(\.\d+)?$/.test(vat32)) push('vat_rate', vat32);
    push('vat_breakdown', vat32);
  }

  const importVat = tags.get('33');
  if (importVat !== undefined && importVat.length > 0) push('import_vat', importVat);

  const conditions = tags.get('40');
  if (conditions !== undefined && conditions.length > 0) {
    push('payment_conditions', conditions);
    const due = deriveDueDate(invoiceIso, conditions);
    if (due !== null) push('due_date', due);
  }

  return { present: true, uid: uidDigits };
}
