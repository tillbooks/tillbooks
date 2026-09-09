/**
 * A11, the Swiss QR-bill payload (Swiss QR Code / SPC), pinned to SIX IG QR-bill v2.3.
 *
 * This is the statutory core: it emits the machine-readable Swiss Payments Code (SPC) exactly as the
 * SIX "Swiss Implementation Guidelines for the QR-bill", Version 2.3 (20.11.2023, in force since
 * 21.11.2025), Table 8 "Swiss QR Code data elements" defines it. The element ORDER, the fixed values
 * (`SPC` / `0200` / `1`), the CR+LF separators, the structured-address-only rule (v2.3, §4.3.1), the
 * QRR (27-digit mod-10 recursive) vs SCOR (ISO 11649) reference choice, and the CHF/EUR-only currency
 * are the guideline verbatim, not a TILL design choice (spec §6b, "Fixed").
 *
 * PINNED to v2.3 on purpose. The v2.4 bump (valid 14.11.2026, D28) is a SEPARATE, deliberate future
 * change: the `SWISS_QR_IG_VERSION` constant below is the single place a reviewer bumps it, never a
 * silent drift (§7 enumeration point).
 *
 * D31 (A32-OI2 resolved here): the payload emits the eBill `AltPmt` alternative-scheme element and the
 * Swico S1 `StrdBkgInf` billing-information string NOW, when the data exists. PDF/A-3b (A32-OI1) stays
 * DEFERRED and is NOT claimed anywhere (see renderInvoicePdf).
 *
 * This module NEVER renders a QR bitmap and NEVER claims SIX certification: it produces the payload
 * string and validates it structurally + against the guideline's own worked references (the SIX
 * Table 4 example is pinned in the test). The scannable graphic and the millimetre-exact payment-part
 * layout land with the Studio/G05 unit.
 *
 * Primary source (fetched 2026-07-22):
 *  - six-group.com/.../standards/qr-bill.html (version + in-force dates)
 *  - Swiss Implementation Guidelines for the QR-bill, v2.3 (20.11.2023), Table 8 + §4.3
 *  - "Using the Alternative Procedures", v1.0 (20.05.2022), Table 4 (eBill AltPmt = `eBill/B/<id>`)
 */

import { isQrIban } from '../setup/iban.js';

/** The SIX IG QR-bill version this emitter conforms to. Bumping to v2.4 (D28) is a reviewed change. */
export const SWISS_QR_IG_VERSION = '2.3' as const;

/** The `Version` element's fixed value: `0200` for master version 2 (IG §4.2.2). Not the IG version. */
const SPC_VERSION = '0200';

/** A structured party address (SIX §4.3.1; v2.3 permits ONLY the structured form, address type `S`). */
export interface QrStructuredAddress {
  name: string;
  street?: string | null;
  buildingNo?: string | null;
  postalCode: string;
  town: string;
  /** Two-letter ISO 3166-1 country code. */
  country: string;
}

export type QrReferenceType = 'QRR' | 'SCOR' | 'NON';

export interface BuildQrBillInput {
  /** The creditor IBAN or QR-IBAN (CH/LI). A QR-IBAN selects QRR; a plain IBAN selects SCOR. */
  iban: string;
  creditor: QrStructuredAddress;
  /** Amount in integer Rappen, or null for an amount-less QR-bill (both are guideline-valid). */
  amountMinor: number | null;
  /** `CHF` or `EUR` only (IG amount rules). */
  currency: string;
  /** The debtor (Ultimate Debtor). Optional: an open QR-bill omits it. */
  debtor?: QrStructuredAddress | null;
  /** The structured reference (already assigned). QRR = 27 digits; SCOR = `RF..`. */
  referenceType: QrReferenceType;
  reference: string;
  /** Unstructured message (Ustrd), e.g. the invoice number line. Ustrd + billingInfo <= 140 chars. */
  unstructuredMessage?: string | null;
  /** Swico S1 structured billing information (StrdBkgInf), D31. Omitted when null. */
  billingInfo?: string | null;
  /** eBill alternative-scheme identifier (AltPmt `eBill/B/<id>`), D31. Omitted when null. */
  ebillIdentifier?: string | null;
}

export interface QrBill {
  /** The Swiss Payments Code: the exact machine-readable string that is encoded INTO the QR graphic. */
  swissQrPayload: string;
  referenceType: QrReferenceType;
  reference: string;
  igVersion: typeof SWISS_QR_IG_VERSION;
}

// --- The permitted character set (IG v2.3 §4.1.1) ----------------------------------------------

/**
 * The five characters §4.1.1 names individually on top of the three permitted Unicode ranges:
 * U+0218/U+0219 (S with comma below), U+021A/U+021B (T with comma below), and U+20AC (EURO SIGN).
 */
const IG_EXTRA_CODEPOINTS: ReadonlySet<number> = new Set([0x0218, 0x0219, 0x021a, 0x021b, 0x20ac]);

/**
 * True if a code point may appear in the Swiss QR Code, per IG v2.3 §4.1.1 "Character set", fetched
 * 2026-07-25 from six-group.com (ig-qr-bill-v2.3-en.pdf, page 30):
 *
 *   "The following subset of characters from the Unicode UTF-8 character set is allowed in the Swiss
 *    QR Code in accordance with the Swiss standard:
 *      - Basic Latin (Unicode codepoints U+0020-U+007E)
 *      - Latin1 Supplement (Unicode codepoints U+00A0-U+00FF)
 *      - Latin Extended A (Unicode codepoints U+0100-U+017F)
 *    As well as the following additional characters: U+0218, U+0219, U+021A, U+021B, U+20AC."
 *
 * EVERY control character is excluded by construction, and that is the security property this
 * predicate exists for: Basic Latin starts at U+0020, so the whole C0 block (U+0000-U+001F, which is
 * where CR and LF live) and DEL (U+007F) are out; Latin-1 Supplement starts at U+00A0, so the C1
 * block (U+0080-U+009F, including U+0085 NEL) is out too. CR and LF are the SPC separator (§4.1.4):
 * a value carrying one would inject an element and shift every element below it, so this is not a
 * cosmetic conformance check, it is what keeps `Amt` from silently emptying into the IG's OPEN,
 * pay-any-amount form on a real receivable.
 */
export function isQrPermittedCodePoint(codePoint: number): boolean {
  if (codePoint >= 0x0020 && codePoint <= 0x007e) return true;
  if (codePoint >= 0x00a0 && codePoint <= 0x00ff) return true;
  if (codePoint >= 0x0100 && codePoint <= 0x017f) return true;
  return IG_EXTRA_CODEPOINTS.has(codePoint);
}

/** Where a value first leaves §4.1.1, or null when the whole value is permitted. Code-point aware. */
export function firstDisallowedQrChar(
  value: string,
): { char: string; codePoint: number; index: number } | null {
  let index = 0;
  for (const char of value) {
    const codePoint = char.codePointAt(0) as number;
    if (!isQrPermittedCodePoint(codePoint)) return { char, codePoint, index };
    index += char.length;
  }
  return null;
}

/** The `U+XXXX` form, for an error message a human can act on without a hex dump. */
function codePointLabel(codePoint: number): string {
  return `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`;
}

/**
 * The encoder's own refusal to emit a payload it was handed illegal input for. `validateQrBill` is
 * the caller-facing gate (it returns issues); this throw is the last line of defence, so that no
 * future call path can reach `join('\r\n')` with a value that would inject an element.
 */
export class QrPayloadCharsetError extends Error {
  constructor(
    readonly element: number,
    readonly codePoint: number,
  ) {
    super(
      `illegal_character in Swiss QR Code element ${element}: ${codePointLabel(codePoint)} is outside the IG v2.3 §4.1.1 permitted character set`,
    );
    this.name = 'QrPayloadCharsetError';
  }
}

// --- Reference check digits (statutory) --------------------------------------------------------

/** Modulo-10 recursive table (SIX ESR/QRR): the check digit of a 26-digit QRR base is the 27th. */
const MOD10_TABLE = [0, 9, 4, 6, 8, 2, 7, 1, 3, 5] as const;

/** The mod-10 recursive check digit over a numeric string (IG §4.3.2, QR reference). */
export function mod10RecursiveCheckDigit(digits: string): number {
  let carry = 0;
  for (const ch of digits) {
    carry = MOD10_TABLE[(carry + Number(ch)) % 10]!;
  }
  return (10 - carry) % 10;
}

/** True if a 27-digit QRR reference carries the correct trailing mod-10 recursive check digit. */
export function isValidQrrReference(reference: string): boolean {
  if (!/^\d{27}$/.test(reference)) return false;
  const base = reference.slice(0, 26);
  const check = Number(reference.slice(26));
  return mod10RecursiveCheckDigit(base) === check;
}

/**
 * Build a 27-digit QRR reference from a numeric seed (typically the invoice number's digits):
 * right-justify to 26 digits, then append the mod-10 recursive check digit. Deterministic, so the
 * same invoice always yields the same reference (it is derived, never stored, spec §4 data model).
 */
export function buildQrrReference(numericSeed: string): string {
  const digitsOnly = numericSeed.replace(/\D/g, '');
  const base = digitsOnly.slice(-26).padStart(26, '0');
  return base + String(mod10RecursiveCheckDigit(base));
}

/** The ISO 11649 (mod-97-10) check digits for a SCOR reference body (the part after `RF##`). */
export function iso11649CheckDigits(body: string): string {
  const rearranged = `${body}RF00`.toUpperCase();
  let remainder = 0;
  for (const ch of rearranged) {
    const chunk = ch >= 'A' && ch <= 'Z' ? String(ch.charCodeAt(0) - 55) : ch;
    for (const d of chunk) remainder = (remainder * 10 + Number(d)) % 97;
  }
  return String(98 - remainder).padStart(2, '0');
}

/** True if a SCOR reference (`RF` + 2 check digits + 1..21 alphanumerics) validates per ISO 11649. */
export function isValidScorReference(reference: string): boolean {
  const s = reference.toUpperCase();
  if (!/^RF\d{2}[A-Z0-9]{1,21}$/.test(s)) return false;
  const body = s.slice(4);
  return iso11649CheckDigits(body) === s.slice(2, 4);
}

/** Build a valid SCOR (ISO 11649 Creditor Reference) from an alphanumeric seed. */
export function buildScorReference(alphanumericSeed: string): string {
  const body = alphanumericSeed.replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 21) || '0';
  return `RF${iso11649CheckDigits(body)}${body}`;
}

// --- Amount + currency -------------------------------------------------------------------------

const CURRENCIES = new Set(['CHF', 'EUR']);

/** True if the currency is one the QR-bill permits (CHF/EUR only, IG amount rules, M13). */
export function isQrCurrency(currency: string): boolean {
  return CURRENCIES.has(currency);
}

/**
 * Format integer Rappen as the QR `Amt` element: no leading zeroes, a `.` decimal separator, exactly
 * two decimal places (IG: 0.01 to 999,999,999.99). Locale-neutral by the guideline (P11).
 */
export function formatQrAmount(amountMinor: number): string {
  // The sign is carried separately, because `Math.trunc(-50 / 100)` is `-0` and `${-0}` is `"0"`:
  // every amount from -1 to -99 Rappen used to render as POSITIVE. The QR `Amt` element itself
  // cannot reach that band today (negative positions are refused at ingress, `validateQrBill` floors
  // `Amt` at 1), but this same function renders the Swico `/32/` VAT amounts, where nothing
  // range-checks the value, and it becomes reachable the moment discounts or credit notes land.
  const sign = amountMinor < 0 ? '-' : '';
  const whole = Math.abs(Math.trunc(amountMinor / 100));
  const rappen = Math.abs(amountMinor % 100);
  return `${sign}${whole}.${String(rappen).padStart(2, '0')}`;
}

// --- Swico S1 billing information (StrdBkgInf), D31 --------------------------------------------

export interface SwicoS1Input {
  /** The invoice number (Swico tag /10/). */
  invoiceNumber: string;
  /** The invoice/document date, ISO `YYYY-MM-DD` (Swico tag /11/, emitted as YYMMDD). */
  invoiceDate: string;
  /** The MWST number in ESTV form (`CHE-###.###.### MWST`); the digits become Swico tag /30/. */
  vatNumber?: string | null;
  /**
   * The VAT details (Swico tag /32/): either a single percentage applied to the whole invoiced
   * amount (`8.1`) or the `rate:net;rate:net` list. Already reconciled by the caller; see
   * `swicoVatDetails` in invoice.ts, which is the only thing allowed to construct it.
   */
  vatRatePercent?: string | null;
  /** Payment conditions (Swico tag /40/), e.g. `0:30` (0% discount, 30 days). */
  paymentConditions?: string | null;
}

/** ISO `YYYY-MM-DD` to the Swico `YYMMDD` day form. Returns '' for a malformed date. */
function toYyMmDd(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (m === null) return '';
  return `${m[1]!.slice(2)}${m[2]}${m[3]}`;
}

/**
 * Escape a Swico S1 field VALUE, per IG v2.3 Annex D Table 29: "Field content must not contain the
 * characters '/' and '\'; these must be replaced by '\/' and '\\' (escape)." Table 31 Example 4
 * shows it on a real invoice number: `/10/X.66711\/8824` is the number `X.66711/8824`.
 *
 * Unreachable with today's `R-YYYY-NNNN` number mask, and a landmine the moment D32 lets a workspace
 * choose its own: an unescaped `/` inside a value forges a tag boundary, so a parser reads
 * `//S1/10/R/2026/0001/11/...` as tag 10 = "R". The backslash goes first: escaping the slash
 * introduces backslashes that must not then be escaped again.
 */
export function swicoEscape(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\//g, '\\/');
}

/**
 * Build the Swico S1 structured billing-information string for `StrdBkgInf` (D31). The `//S1/` prefix
 * and the tag numbers (10 invoice no, 11 date, 30 VAT no, 32 VAT rate, 40 conditions) are the Swico
 * S1 syntax; only the tags whose data exists are emitted. Not part of the SIX standardisation itself
 * (IG Table 8 notes StrdBkgInf usage is out of scope), it is the interface-recommendation format the
 * eBill `qrbill` format expects.
 */
export function buildSwicoS1(input: SwicoS1Input): string {
  // Table 29: the /nn/ tags are emitted in ascending order and each appears at most once. The VALUES
  // are escaped (`/` and `\`); the separators between tags are structure and stay literal.
  const parts: string[] = ['//S1', `10/${swicoEscape(input.invoiceNumber)}`];
  const date = toYyMmDd(input.invoiceDate);
  if (date !== '') parts.push(`11/${date}`);
  if (input.vatNumber != null) {
    const digits = input.vatNumber.replace(/\D/g, '');
    if (digits.length > 0) parts.push(`30/${digits}`);
  }
  if (input.vatRatePercent != null && input.vatRatePercent.length > 0) {
    parts.push(`32/${swicoEscape(input.vatRatePercent)}`);
  }
  if (input.paymentConditions != null && input.paymentConditions.length > 0) {
    parts.push(`40/${swicoEscape(input.paymentConditions)}`);
  }
  return parts.join('/');
}

/** Basis-point VAT rate (e.g. 810) to the Swico percent string (`8.1`), trimming trailing zeroes. */
export function bpToPercentString(rateBp: number): string {
  const pct = rateBp / 100;
  return String(pct).replace(/\.0+$/, '');
}

// --- The SPC encoder (statutory element order, IG v2.3 Table 8) --------------------------------

/** One structured-address block as its seven SPC lines (address type is always `S` in v2.3). */
function addressLines(address: QrStructuredAddress | null | undefined): string[] {
  if (address == null) return ['', '', '', '', '', '', ''];
  return [
    'S',
    address.name,
    address.street ?? '',
    address.buildingNo ?? '',
    address.postalCode,
    address.town,
    address.country,
  ];
}

/**
 * Encode the ordered SPC element list into the Swiss QR Code payload string (IG v2.3 Table 8). The
 * separator is CR+LF; the trailing separator after the final used element is eliminated (IG §4.1.4).
 * `StrdBkgInf` and the two `AltPmt` lines are status "A" (additional): omitted when unused and no
 * later element follows. This is a PURE function of its structured fields, tested against the SIX
 * Table 4 worked example.
 */
export function encodeSwissQrPayload(input: BuildQrBillInput): string {
  const amount = input.amountMinor === null ? '' : formatQrAmount(input.amountMinor);
  const elements: string[] = [
    // Header
    'SPC',
    SPC_VERSION,
    '1',
    // Creditor information
    input.iban.replace(/\s+/g, '').toUpperCase(),
    // Creditor (Cdtr), structured
    ...addressLines(input.creditor),
    // Ultimate creditor (UltmtCdtr): "must not be filled in", but the separators must be present
    ...['', '', '', '', '', '', ''],
    // Payment amount information (CcyAmt)
    amount,
    input.currency,
    // Ultimate debtor (UltmtDbtr)
    ...addressLines(input.debtor),
    // Payment reference (RmtInf)
    input.referenceType,
    input.referenceType === 'NON' ? '' : input.reference,
    // Additional information (AddInf)
    input.unstructuredMessage ?? '',
    'EPD',
  ];

  // Status "A" trailing elements: StrdBkgInf (Swico S1), then up to two AltPmt lines. Emit only as
  // far as the last used element, then drop the rest (IG §4.1.4).
  const billingInfo = input.billingInfo ?? '';
  const altPmt1 = input.ebillIdentifier != null && input.ebillIdentifier.length > 0
    ? `eBill/B/${input.ebillIdentifier}`
    : '';
  const trailing = [billingInfo, altPmt1];
  let lastUsed = -1;
  for (let i = 0; i < trailing.length; i += 1) {
    if (trailing[i] !== '') lastUsed = i;
  }
  for (let i = 0; i <= lastUsed; i += 1) {
    elements.push(trailing[i]!);
  }

  // The separator is CR+LF (§4.1.4), so a CR or an LF INSIDE a value is an injected element, not a
  // formatting quirk: everything below it shifts up one position and `Amt` reads as the element
  // above it (empty, i.e. the IG's open pay-any-amount form) on a real receivable. Rather than
  // sanitising silently (which would ship a payment part whose creditor is not the stored creditor),
  // the encoder REFUSES. Callers go through `validateQrBill` first and get structured issues; this
  // throw exists so that no path, present or future, can reach the join with an illegal value.
  for (let i = 0; i < elements.length; i += 1) {
    const bad = firstDisallowedQrChar(elements[i]!);
    if (bad !== null) throw new QrPayloadCharsetError(i, bad.codePoint);
  }

  return elements.join('\r\n');
}

/**
 * Build the QR-bill payload for a given set of fields, returning the payload plus the reference it
 * carries. `buildQrBill` (invoice.ts) resolves the workspace/invoice into this input; this stays a
 * pure encoder so the statutory shape is testable in isolation.
 */
export function buildQrBillPayload(input: BuildQrBillInput): QrBill {
  return {
    swissQrPayload: encodeSwissQrPayload(input),
    referenceType: input.referenceType,
    reference: input.referenceType === 'NON' ? '' : input.reference,
    igVersion: SWISS_QR_IG_VERSION,
  };
}

// --- Structural validation (validateQrBill) ----------------------------------------------------

export interface QrValidationIssue {
  field: string;
  reason: string;
  /** Human-actionable context, e.g. which code point put a field outside §4.1.1. */
  detail?: string;
}

/**
 * Flag a field whose value leaves the IG §4.1.1 permitted character set (which is also what catches
 * every control character, CR and LF included). Runs over the value the ENCODER will emit, so a
 * field the encoder normalises (the IBAN's whitespace) is checked in its normalised form.
 */
function validateCharset(field: string, value: string | null | undefined, issues: QrValidationIssue[]): void {
  if (value == null || value.length === 0) return;
  const bad = firstDisallowedQrChar(value);
  if (bad !== null) {
    issues.push({ field, reason: 'illegal_character', detail: `${codePointLabel(bad.codePoint)} at index ${bad.index}` });
  }
}

/** Every element of a structured address block, checked against §4.1.1. */
function validateAddressCharset(prefix: string, address: QrStructuredAddress | null | undefined, issues: QrValidationIssue[]): void {
  if (address == null) return;
  validateCharset(`${prefix}.name`, address.name, issues);
  validateCharset(`${prefix}.street`, address.street, issues);
  validateCharset(`${prefix}.buildingNo`, address.buildingNo, issues);
  validateCharset(`${prefix}.postalCode`, address.postalCode, issues);
  validateCharset(`${prefix}.town`, address.town, issues);
  validateCharset(`${prefix}.country`, address.country, issues);
}

/** The IG v2.3 Table 8 per-field maximum lengths for a structured address (m-2). */
const ADDRESS_FIELD_MAX = { name: 70, street: 70, buildingNo: 16, postalCode: 16, town: 35 } as const;

/** A structured-address block is complete when name, postal code, town, and a 2-letter country exist. */
function validateAddress(prefix: string, address: QrStructuredAddress | null | undefined, issues: QrValidationIssue[], required: boolean): void {
  if (address == null) {
    if (required) issues.push({ field: prefix, reason: 'address_missing' });
    return;
  }
  if (!address.name || address.name.length === 0) issues.push({ field: `${prefix}.name`, reason: 'empty' });
  if (!address.postalCode || address.postalCode.length === 0) issues.push({ field: `${prefix}.postalCode`, reason: 'empty' });
  if (!address.town || address.town.length === 0) issues.push({ field: `${prefix}.town`, reason: 'empty' });
  if (!/^[A-Za-z]{2}$/.test(address.country ?? '')) issues.push({ field: `${prefix}.country`, reason: 'not_iso_3166' });
  // m-2: the IG's per-field caps. A QR reader truncates or rejects an over-long element, so an
  // overrun is a flagged, fixable error here, never a silently mangled payment part.
  if (address.name != null && address.name.length > ADDRESS_FIELD_MAX.name) issues.push({ field: `${prefix}.name`, reason: 'too_long' });
  if (address.street != null && address.street.length > ADDRESS_FIELD_MAX.street) issues.push({ field: `${prefix}.street`, reason: 'too_long' });
  if (address.buildingNo != null && address.buildingNo.length > ADDRESS_FIELD_MAX.buildingNo) issues.push({ field: `${prefix}.buildingNo`, reason: 'too_long' });
  if (address.postalCode != null && address.postalCode.length > ADDRESS_FIELD_MAX.postalCode) issues.push({ field: `${prefix}.postalCode`, reason: 'too_long' });
  if (address.town != null && address.town.length > ADDRESS_FIELD_MAX.town) issues.push({ field: `${prefix}.town`, reason: 'too_long' });
}

/**
 * Structurally validate a QR-bill input against IG v2.3 BEFORE rendering (spec §4, `validateQrBill`):
 * IBAN shape, reference/reference-type coherence + check digit, structured creditor address
 * completeness (an incomplete customer address is a flagged, fixable error, never an unstructured
 * fallback, M10), and CHF/EUR-only currency (M13). Returns `[]` when the payload is well-formed. This
 * is a STRUCTURAL check against cited references, never a claim of SIX certification.
 */
export function validateQrBill(input: BuildQrBillInput): QrValidationIssue[] {
  const issues: QrValidationIssue[] = [];
  const iban = input.iban.replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban) || !(iban.startsWith('CH') || iban.startsWith('LI'))) {
    issues.push({ field: 'iban', reason: 'not_ch_li_iban' });
  }
  if (!isQrCurrency(input.currency)) issues.push({ field: 'currency', reason: 'not_chf_or_eur' });
  if (input.amountMinor !== null && (input.amountMinor < 1 || input.amountMinor > 99_999_999_999)) {
    issues.push({ field: 'amount', reason: 'out_of_range' });
  }
  validateAddress('creditor', input.creditor, issues, true);
  if (input.debtor != null) validateAddress('debtor', input.debtor, issues, false);

  if (input.referenceType === 'QRR' && !isValidQrrReference(input.reference)) {
    issues.push({ field: 'reference', reason: 'invalid_qrr_check_digit' });
  }
  if (input.referenceType === 'SCOR' && !isValidScorReference(input.reference)) {
    issues.push({ field: 'reference', reason: 'invalid_scor_check_digit' });
  }

  // m-2: IBAN-type vs reference-type coherence (IG §4.3.2/§4.3.3): a QR-IBAN mandates the QRR
  // reference, and a QRR reference is only payable against a QR-IBAN. An incoherent pair scans but
  // bounces at the bank, so it is a structural error here.
  const qrIban = isQrIban(iban);
  if (input.referenceType === 'QRR' && !qrIban) {
    issues.push({ field: 'referenceType', reason: 'qrr_requires_qr_iban' });
  }
  if (input.referenceType !== 'QRR' && qrIban) {
    issues.push({ field: 'referenceType', reason: 'qr_iban_requires_qrr' });
  }

  // AddInf: Ustrd and StrdBkgInf each cap at 140 AND share a 140-char budget (IG Table 8, AddInf).
  if ((input.unstructuredMessage ?? '').length > 140) issues.push({ field: 'unstructuredMessage', reason: 'too_long' });
  if ((input.billingInfo ?? '').length > 140) issues.push({ field: 'billingInfo', reason: 'too_long' });
  const addInfLen = (input.unstructuredMessage ?? '').length + (input.billingInfo ?? '').length;
  if (addInfLen > 140) issues.push({ field: 'addInf', reason: 'over_140_chars' });
  if (input.ebillIdentifier != null && `eBill/B/${input.ebillIdentifier}`.length > 100) {
    issues.push({ field: 'altPmt', reason: 'over_100_chars' });
  }

  // §4.1.1 permitted character set, over EVERY field that reaches the payload. This is the check
  // that stops a CR+LF in master data from injecting an SPC element (and emptying `Amt` into the
  // open, pay-any-amount form), and it also keeps out-of-charset text (Cyrillic homoglyphs, emoji)
  // from being emitted verbatim into a payment part no Swiss reader is required to accept.
  validateCharset('iban', iban, issues);
  validateAddressCharset('creditor', input.creditor, issues);
  validateAddressCharset('debtor', input.debtor, issues);
  validateCharset('currency', input.currency, issues);
  validateCharset('reference', input.referenceType === 'NON' ? '' : input.reference, issues);
  validateCharset('unstructuredMessage', input.unstructuredMessage, issues);
  validateCharset('billingInfo', input.billingInfo, issues);
  validateCharset('ebillIdentifier', input.ebillIdentifier, issues);

  return issues;
}
