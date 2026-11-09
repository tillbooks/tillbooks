/**
 * A31 §0a, the STRICT Swiss QR Code (SPC) decoder: a payload a caller supplies (text read by a phone
 * scanner, found by the Studio in an image, or handed over by a G02 decoder plugin) is checked against
 * the SIX "Swiss Implementation Guidelines for the QR-bill" v2.3 (the version A11 pins) and either
 * decoded whole or refused with EVERY violation named. Pure: no I/O, no clock, no database.
 *
 * WHY STRICT, WHEN THE TEXT-LAYER PARSER IN `captureParse.ts` IS PER-FIELD LENIENT. A payload found in
 * the stored bytes is corroborated by those bytes, so dropping one bad field and keeping the rest is
 * honest there (spec US-A31.1). A supplied payload has nothing to corroborate it: the only evidence it
 * is a real QR-bill is that it obeys the guideline, so a payload that breaks any rule is refused whole
 * and nothing it says reaches the capture (spec §0a item 11).
 *
 * THIS MODULE OWNS NO CHECK-DIGIT MATH AND NO CHARACTER SET. The QRR mod-10 recursive and SCOR ISO 11649
 * validators and the §4.1.1 character set are A11's (`sales/qrbill.ts`), the IBAN mod-97 and QR-IID range
 * are A00's (`setup/iban.ts`), the Rappen conversion and the Swico S1 parser are A31's text-layer ones:
 * a second copy that disagreed would let a bill through that its own payment matcher rejects.
 *
 * Every issue is `{code, element, line, message}`: `code` is one of `QR_DECODE_ISSUE_CODES` (the
 * §H-ENUM single source the Studio localises), `element` the IG Table 8 element name, `line` the
 * 1-based line of the pasted text, `message` an English sentence an agent can act on. An ERROR refuses
 * the payload; a WARNING is reported and changes nothing the decoder returns.
 *
 * Primary source, fetched 2026-09-30: six-group.com ig-qr-bill-v2.3-en.pdf, §4.1.1 to §4.1.4, §4.2.2
 * Table 8, §4.3.1 and §6.2 (997 characters). IG v2.4 (valid 14.11.2026) changes one rule for EUR,
 * reported as a warning while v2.3 is the pinned version.
 */

import { firstDisallowedQrChar, isValidQrrReference, isValidScorReference } from '../../sales/qrbill.js';
import { isValidIban, isQrIban } from '../../setup/iban.js';
import { amountToRappen, parseSwicoS1, type ParsedField, type ParseNote } from '../captureParse.js';
import { ISO_3166_ALPHA2 } from './iso3166.js';
import { NOTIFICATION_NOTICES } from './notification.js';

/** The issue codes, errors and warnings alike. One list, so the Studio's copy can never drift from it. */
export const QR_DECODE_ISSUE_CODES = [
  // structure (errors that stop the decode: positions cannot be trusted after them)
  'empty_payload',
  'not_spc',
  'unsupported_version',
  'separator',
  'element_count',
  // structure (errors that do not stop it)
  'unsupported_coding',
  'payload_too_long',
  'disallowed_character',
  'field_too_long',
  'blank_only',
  'trailer',
  // creditor account
  'iban_format',
  'iban_country',
  'iban_check_digits',
  // addresses
  'address_type_combined',
  'address_type',
  'address_incomplete',
  'country_code',
  'ultimate_creditor_filled',
  // amount and currency
  'amount_format',
  'amount_range',
  'currency',
  // reference
  'reference_type',
  'qr_iban_requires_qrr',
  'qrr_requires_qr_iban',
  'reference_missing',
  'qrr_format',
  'qrr_check_digit',
  'scor_format',
  'scor_check_digit',
  'non_reference_present',
  'additional_info_too_long',
  // warnings
  'trailing_separator',
  'blank_padding',
  'amount_open',
  'billing_info_unrecognised',
  'swico_value',
  'eur_qrr_ig_v24',
  'notification',
  'country_user_assigned',
] as const;
export type QrDecodeIssueCode = (typeof QR_DECODE_ISSUE_CODES)[number];

export interface QrDecodeIssue {
  code: QrDecodeIssueCode;
  /** The IG v2.3 Table 8 element, dotted by data group (`Cdtr.PstCd`), or `payload` for the whole. */
  element: string;
  /** The 1-based line of the supplied text the issue sits on, or null for a whole-payload issue. */
  line: number | null;
  message: string;
  /** Extra facts for the message (a limit, a character), never needed to act on the code. */
  detail?: Record<string, string | number>;
}

/** A structured `S` address, as the payload carries it (empty optional parts omitted). */
export interface QrAddress {
  name: string;
  street?: string;
  buildingNumber?: string;
  postalCode: string;
  town: string;
  country: string;
}

export type QrReferenceType = 'QRR' | 'SCOR' | 'NON';

export interface DecodedQrBill {
  /** `0200`, the only value master version 02 permits (IG Table 8, Version). */
  version: string;
  iban: string;
  /** True when the IBAN's QR-IID lies in 30000 to 31999, which is what makes QRR mandatory. */
  qrIban: boolean;
  creditor: QrAddress;
  /** Integer Rappen (or euro cents), or null for an OPEN amount the payer fills in. */
  amountMinor: number | null;
  currency: 'CHF' | 'EUR';
  ultimateDebtor: QrAddress | null;
  referenceType: QrReferenceType;
  /** Upper-cased for SCOR (banks do not distinguish case), null for NON. */
  reference: string | null;
  unstructuredMessage: string | null;
  /** IG §4.4: a "do not use for payment" notification (amount 0.00 plus the notice); no amount is proposed. */
  notification: boolean;
  billingInformation: string | null;
  alternativeProcedures: string[];
  /** The Swico S1 tags, when the billing information is S1. Provenance is set by the caller. */
  swico: { fields: ParsedField[]; notes: ParseNote[]; uid: string | null } | null;
}

export type QrDecodeResult =
  | { ok: true; bill: DecodedQrBill; warnings: QrDecodeIssue[] }
  | { ok: false; errors: QrDecodeIssue[]; warnings: QrDecodeIssue[] };

/** The supplied text is refused unread above this size: ten times the IG maximum, a guard not a rule. */
export const QR_SUPPLIED_TEXT_MAX = 9970;
/** IG §6.2: "The maximum Swiss QR Code data content permitted is 997 characters (including the element separators)." */
export const QR_PAYLOAD_MAX_CHARS = 997;

/** IG Table 8 element positions (0-based). The payload's position IS its meaning, so these are fixed. */
const E = {
  QRTYPE: 0,
  VERSION: 1,
  CODING: 2,
  IBAN: 3,
  CDTR: 4, // 4..10: AdrTp, Name, StrtNmOrAdrLine1, BldgNbOrAdrLine2, PstCd, TwnNm, Ctry
  UCDTR: 11, // 11..17
  AMT: 18,
  CCY: 19,
  UDBTR: 20, // 20..26
  TP: 27,
  REF: 28,
  USTRD: 29,
  TRAILER: 30,
  STRDBKGINF: 31,
  ALTPMT1: 32,
  ALTPMT2: 33,
} as const;

/** The one user-assigned country code accepted, by owner decision of 30.09.2026 (with a warning). */
const USER_ASSIGNED_KOSOVO = 'XK';

const MIN_ELEMENTS = 31;
const MAX_ELEMENTS = 34;

const ADDRESS_PARTS = ['AdrTp', 'Name', 'StrtNmOrAdrLine1', 'BldgNbOrAdrLine2', 'PstCd', 'TwnNm', 'Ctry'] as const;
/** IG Table 8 maximum lengths per address part (AdrTp and Ctry are fixed-length and checked by shape). */
const ADDRESS_MAX: Record<string, number> = { Name: 70, StrtNmOrAdrLine1: 70, BldgNbOrAdrLine2: 16, PstCd: 16, TwnNm: 35 };

/** Element names for messages, by position. */
function elementName(i: number): string {
  if (i === E.QRTYPE) return 'Header.QRType';
  if (i === E.VERSION) return 'Header.Version';
  if (i === E.CODING) return 'Header.Coding';
  if (i === E.IBAN) return 'CdtrInf.IBAN';
  if (i >= E.CDTR && i < E.CDTR + 7) return `Cdtr.${ADDRESS_PARTS[i - E.CDTR]}`;
  if (i >= E.UCDTR && i < E.UCDTR + 7) return `UltmtCdtr.${ADDRESS_PARTS[i - E.UCDTR]}`;
  if (i === E.AMT) return 'CcyAmt.Amt';
  if (i === E.CCY) return 'CcyAmt.Ccy';
  if (i >= E.UDBTR && i < E.UDBTR + 7) return `UltmtDbtr.${ADDRESS_PARTS[i - E.UDBTR]}`;
  if (i === E.TP) return 'RmtInf.Tp';
  if (i === E.REF) return 'RmtInf.Ref';
  if (i === E.USTRD) return 'AddInf.Ustrd';
  if (i === E.TRAILER) return 'AddInf.Trailer';
  if (i === E.STRDBKGINF) return 'AddInf.StrdBkgInf';
  return `AltPmtInf.AltPmt${i - E.ALTPMT1 + 1}`;
}

function codePointLabel(cp: number): string {
  return `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;
}

/** Length in characters (code points), the unit the guideline counts in. */
function charLength(s: string): number {
  return [...s].length;
}

/**
 * Decode a supplied Swiss QR Code payload strictly. Collects every issue it can see; stops early only
 * when the structure itself (header, separator, element count) makes element positions meaningless.
 */
export function decodeSwissQrBill(supplied: string): QrDecodeResult {
  const errors: QrDecodeIssue[] = [];
  const warnings: QrDecodeIssue[] = [];
  const error = (code: QrDecodeIssueCode, element: string, line: number | null, message: string, detail?: QrDecodeIssue['detail']): void => {
    errors.push({ code, element, line, message, ...(detail !== undefined ? { detail } : {}) });
  };
  const warn = (code: QrDecodeIssueCode, element: string, line: number | null, message: string, detail?: QrDecodeIssue['detail']): void => {
    warnings.push({ code, element, line, message, ...(detail !== undefined ? { detail } : {}) });
  };
  const refuse = (): QrDecodeResult => ({ ok: false, errors, warnings });

  if (typeof supplied !== 'string' || supplied.length === 0) {
    error('empty_payload', 'payload', null, 'No payload was supplied.');
    return refuse();
  }
  if (supplied.length > QR_SUPPLIED_TEXT_MAX) {
    error('payload_too_long', 'payload', null, `The supplied text is far longer than any Swiss QR Code (${QR_PAYLOAD_MAX_CHARS} characters at most).`, { max: QR_PAYLOAD_MAX_CHARS });
    return refuse();
  }

  // A UTF-8 byte order mark is an encoding artefact of the reader, not payload content.
  let text = supplied.charCodeAt(0) === 0xfeff ? supplied.slice(1) : supplied;

  // IG §4.1.4: "The carriage return after the final element is eliminated." A reader that appends one
  // changes nothing the payload says, so it is stripped and reported, never refused.
  const withoutTrailing = text.replace(/(?:\r\n|\n|\r)+$/, '');
  if (withoutTrailing.length !== text.length) {
    warn('trailing_separator', 'payload', null, 'The payload ends with a line break; the guideline eliminates the one after the final element. It was ignored.');
    text = withoutTrailing;
  }

  // IG §4.1.4: CR+LF or LF, and "The same type of carriage return must always be used within a document."
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/\n/g) ?? []).length - crlf;
  const loneCr = (text.match(/\r(?!\n)/g) ?? []).length;
  if (loneCr > 0) {
    error('separator', 'payload', null, 'A lone carriage return (CR without LF) separates elements; only CR+LF or LF are permitted.');
    return refuse();
  }
  if (crlf > 0 && lf > 0) {
    error('separator', 'payload', null, 'The payload mixes CR+LF and LF separators; one type must be used throughout.');
    return refuse();
  }

  const el = text.split(crlf > 0 ? '\r\n' : '\n');
  const lineOf = (i: number): number => i + 1;

  if (el[E.QRTYPE] !== 'SPC') {
    error('not_spc', 'Header.QRType', 1, 'This is not a Swiss QR Code: the first line must be exactly "SPC".');
    return refuse();
  }
  if (el[E.VERSION] !== '0200') {
    error('unsupported_version', 'Header.Version', 2, `Version "${el[E.VERSION] ?? ''}" is not supported; master version 02 permits only "0200".`);
    return refuse();
  }
  if (el.length < MIN_ELEMENTS || el.length > MAX_ELEMENTS) {
    const epd = el.indexOf('EPD');
    const hint = epd >= 0 ? ` The trailer "EPD" is on line ${lineOf(epd)} instead of line ${lineOf(E.TRAILER)}, so elements are missing or extra.` : '';
    error('element_count', 'payload', null, `The payload has ${el.length} elements; a Swiss QR Code has ${MIN_ELEMENTS} to ${MAX_ELEMENTS}.${hint}`, { count: el.length });
    return refuse();
  }

  // From here every position is meaningful: collect every issue, then decide.
  if (charLength(text) > QR_PAYLOAD_MAX_CHARS) {
    error('payload_too_long', 'payload', null, `The payload has ${charLength(text)} characters; at most ${QR_PAYLOAD_MAX_CHARS} are permitted, separators included.`, { max: QR_PAYLOAD_MAX_CHARS });
  }
  if (el[E.CODING] !== '1') {
    error('unsupported_coding', 'Header.Coding', 3, `Coding type "${el[E.CODING] ?? ''}" is not supported; the only coding type is "1" (UTF-8, Latin subset).`);
  }

  // Character set (IG §4.1.1) and blank padding (IG §4.1.3), per element.
  const v: string[] = el.map((raw, i) => {
    const bad = firstDisallowedQrChar(raw);
    if (bad !== null) {
      error('disallowed_character', elementName(i), lineOf(i), `The character ${codePointLabel(bad.codePoint)} is outside the Swiss QR Code character set.`, { char: codePointLabel(bad.codePoint) });
    }
    const trimmed = raw.trim();
    if (raw !== '' && trimmed === '') {
      // IG §4.1.3: "It is not permitted to fill in the elements with blanks." Trimming padding AROUND a
      // value keeps its meaning; trimming an element that is ONLY blanks would change it (a blank Amt
      // would turn a priced bill into an open one), so that is refused, never reinterpreted (critic L2).
      error('blank_only', elementName(i), lineOf(i), 'The element holds only blanks; an unused element must be empty, not padded.');
    } else if (trimmed !== raw) {
      warn('blank_padding', elementName(i), lineOf(i), 'Leading or trailing blanks were removed; the guideline does not permit padding.');
    }
    return trimmed;
  });
  const at = (i: number): string => v[i] ?? '';

  const tooLong = (i: number, max: number): boolean => {
    const len = charLength(at(i));
    if (len <= max) return false;
    error('field_too_long', elementName(i), lineOf(i), `The value has ${len} characters; at most ${max} are permitted.`, { max });
    return true;
  };

  // --- Creditor account (IG Table 8, IBAN) ------------------------------------------------------
  const iban = at(E.IBAN).toUpperCase();
  let qrIban = false;
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{17}$/.test(iban)) {
    error('iban_format', 'CdtrInf.IBAN', lineOf(E.IBAN), 'The IBAN must be exactly 21 letters and digits without spaces.');
  } else if (!iban.startsWith('CH') && !iban.startsWith('LI')) {
    error('iban_country', 'CdtrInf.IBAN', lineOf(E.IBAN), 'Only IBANs with the country code CH or LI are permitted.');
  } else if (!isValidIban(iban)) {
    error('iban_check_digits', 'CdtrInf.IBAN', lineOf(E.IBAN), 'The IBAN check digits do not match (ISO 13616 mod-97).');
  } else {
    qrIban = isQrIban(iban);
  }

  // --- Addresses (IG §4.3.1, Table 8) -----------------------------------------------------------
  const address = (base: number, group: 'Cdtr' | 'UltmtDbtr'): QrAddress | null => {
    const parts = ADDRESS_PARTS.map((_, k) => at(base + k));
    const [adrTp, name, street, building, postal, town, country] = parts as [string, string, string, string, string, string, string];
    if (group === 'UltmtDbtr' && parts.every((p) => p === '')) return null;
    let valid = true;
    if (adrTp === 'K') {
      error('address_type_combined', `${group}.AdrTp`, lineOf(base), 'The combined address type "K" was removed in IG v2.3 (in force since 21.11.2025); only the structured type "S" is permitted.');
      valid = false;
    } else if (adrTp !== 'S') {
      error('address_type', `${group}.AdrTp`, lineOf(base), `Address type "${adrTp}" is not permitted; it must be "S" (structured).`);
      valid = false;
    }
    ADDRESS_PARTS.forEach((part, k) => {
      const max = ADDRESS_MAX[part];
      if (max !== undefined && tooLong(base + k, max)) valid = false;
    });
    const missing: string[] = [];
    if (name === '') missing.push('Name');
    if (postal === '') missing.push('PstCd');
    if (town === '') missing.push('TwnNm');
    if (country === '') missing.push('Ctry');
    if (missing.length > 0) {
      error('address_incomplete', `${group}.${missing[0]}`, lineOf(base + ADDRESS_PARTS.indexOf(missing[0] as (typeof ADDRESS_PARTS)[number])), `The address lacks ${missing.join(', ')}; name, postal code, town and country must be filled.`, { missing: missing.join(',') });
      valid = false;
    } else if (country === USER_ASSIGNED_KOSOVO) {
      // Owner decision of 30.09.2026: XK (Kosovo) is a user-assigned code, not an ISO 3166-1 one, and
      // SIX does not list it; SWIFT, the EU and bank systems use it, and real bills carry it. Accepted
      // as the ONE documented exception, with a warning so a person checks the address.
      warn('country_user_assigned', `${group}.Ctry`, lineOf(base + 6), 'XK (Kosovo) is not an ISO 3166-1 code and SIX does not list it; it is accepted as a documented exception. Check the address before you commit.');
    } else if (!ISO_3166_ALPHA2.has(country)) {
      error('country_code', `${group}.Ctry`, lineOf(base + 6), `Country "${country}" is not an assigned ISO 3166-1 alpha-2 code.`);
      valid = false;
    }
    if (!valid) return null;
    return {
      name,
      ...(street !== '' ? { street } : {}),
      ...(building !== '' ? { buildingNumber: building } : {}),
      postalCode: postal,
      town,
      country,
    };
  };
  const creditor = address(E.CDTR, 'Cdtr');

  // IG Table 8: "This entire data group must not be filled in" (status X, the separators still present).
  for (let k = 0; k < 7; k += 1) {
    if (at(E.UCDTR + k) !== '') {
      error('ultimate_creditor_filled', elementName(E.UCDTR + k), lineOf(E.UCDTR + k), 'The ultimate creditor must stay empty; the guideline reserves it.');
      break;
    }
  }

  // --- Amount and currency (IG Table 8, Amt/Ccy) ------------------------------------------------
  const amtRaw = at(E.AMT);
  let amountMinor: number | null = null;
  let notification = false;
  if (amtRaw === '') {
    warn('amount_open', 'CcyAmt.Amt', lineOf(E.AMT), 'The amount is open: the bill leaves it to the payer, so it has to be entered by hand.');
  } else if (!/^(?:0|[1-9]\d*)\.\d{2}$/.test(amtRaw)) {
    error('amount_format', 'CcyAmt.Amt', lineOf(E.AMT), `Amount "${amtRaw}" is malformed: it needs a "." and exactly two decimals, and no leading zeroes.`);
  } else {
    const minor = amountToRappen(amtRaw);
    if (minor === 0 && NOTIFICATION_NOTICES.has(at(E.USTRD))) {
      // IG §4.4 Table 10: amount 0.00 with the capitalised notice in the additional information is a
      // "DO NOT USE FOR PAYMENT" notification (the amount is collected by direct debit or eBill). It is
      // a valid QR-bill, but 0.00 is not the bill's amount, so none is proposed.
      notification = true;
      warn('notification', 'CcyAmt.Amt', lineOf(E.AMT), 'The bill is a "do not use for payment" notification: the amount is collected another way (direct debit or eBill), so it has to be entered by hand.');
    } else if (minor === null || minor < 1 || minor > 99_999_999_999) {
      error('amount_range', 'CcyAmt.Amt', lineOf(E.AMT), 'The amount must be between 0.01 and 999999999.99 (0.00 only on a "do not use for payment" notification, IG §4.4).');
    } else {
      amountMinor = minor;
    }
  }
  const ccy = at(E.CCY);
  if (ccy !== 'CHF' && ccy !== 'EUR') {
    error('currency', 'CcyAmt.Ccy', lineOf(E.CCY), `Currency "${ccy}" is not permitted; only CHF and EUR are.`);
  }

  const ultimateDebtor = address(E.UDBTR, 'UltmtDbtr');

  // --- Reference (IG Table 8, Tp/Ref) -----------------------------------------------------------
  const tp = at(E.TP);
  const refRaw = at(E.REF);
  let reference: string | null = null;
  if (tp !== 'QRR' && tp !== 'SCOR' && tp !== 'NON') {
    error('reference_type', 'RmtInf.Tp', lineOf(E.TP), `Reference type "${tp}" is not permitted; it must be QRR, SCOR or NON.`);
  } else {
    // Only judged when the IBAN itself decoded, or the pairing message would be noise on top of it.
    const ibanOk = !errors.some((e) => e.element === 'CdtrInf.IBAN');
    if (ibanOk && qrIban && tp !== 'QRR') {
      error('qr_iban_requires_qrr', 'RmtInf.Tp', lineOf(E.TP), 'The IBAN is a QR-IBAN (QR-IID 30000 to 31999), which requires the reference type QRR.');
    }
    if (ibanOk && !qrIban && tp === 'QRR') {
      error('qrr_requires_qr_iban', 'RmtInf.Tp', lineOf(E.TP), 'A QR reference (QRR) may only be used with a QR-IBAN; this IBAN is an ordinary one, which takes SCOR or NON.');
    }
    if (tp === 'NON') {
      if (refRaw !== '') error('non_reference_present', 'RmtInf.Ref', lineOf(E.REF), 'The reference must be empty for the reference type NON.');
    } else if (refRaw === '') {
      error('reference_missing', 'RmtInf.Ref', lineOf(E.REF), `The reference type ${tp} requires a reference.`);
    } else if (tp === 'QRR') {
      if (!/^\d{27}$/.test(refRaw)) {
        error('qrr_format', 'RmtInf.Ref', lineOf(E.REF), 'A QR reference is exactly 27 digits, without spaces.');
      } else if (!isValidQrrReference(refRaw)) {
        error('qrr_check_digit', 'RmtInf.Ref', lineOf(E.REF), 'The check digit of the QR reference is wrong (modulo 10 recursive, the 27th digit).');
      } else {
        reference = refRaw;
      }
    } else {
      const scor = refRaw.toUpperCase();
      if (!/^RF\d{2}[A-Z0-9]{1,21}$/.test(scor)) {
        error('scor_format', 'RmtInf.Ref', lineOf(E.REF), 'A creditor reference (ISO 11649) is "RF", two check digits and 1 to 21 letters or digits, 5 to 25 characters, without spaces.');
      } else if (!isValidScorReference(scor)) {
        error('scor_check_digit', 'RmtInf.Ref', lineOf(E.REF), 'The check digits of the creditor reference are wrong (ISO 11649, modulo 97-10).');
      } else {
        reference = scor;
      }
    }
    if (tp === 'QRR' && ccy === 'EUR') {
      warn('eur_qrr_ig_v24', 'RmtInf.Tp', lineOf(E.TP), 'EUR with a QR reference is valid under IG v2.3, which stays valid until November 2027; IG v2.4 (valid from 14.11.2026) provides for EUR only with an IBAN and SCOR or no reference.');
    }
  }

  // --- Additional information (IG Table 8, Ustrd/Trailer/StrdBkgInf/AltPmt) -------------------
  const ustrd = at(E.USTRD);
  const strd = at(E.STRDBKGINF);
  const ustrdLong = tooLong(E.USTRD, 140);
  const strdLong = el.length > E.STRDBKGINF ? tooLong(E.STRDBKGINF, 140) : false;
  if (!ustrdLong && !strdLong && charLength(ustrd) + charLength(strd) > 140) {
    error('additional_info_too_long', 'RmtInf.AddInf', lineOf(E.USTRD), 'The unstructured message and the billing information together exceed 140 characters.', { max: 140 });
  }
  if (at(E.TRAILER) !== 'EPD') {
    error('trailer', 'AddInf.Trailer', lineOf(E.TRAILER), `Line ${lineOf(E.TRAILER)} must be the trailer "EPD".`);
  }
  const alternativeProcedures: string[] = [];
  for (const i of [E.ALTPMT1, E.ALTPMT2]) {
    if (el.length > i && at(i) !== '') {
      tooLong(i, 100);
      alternativeProcedures.push(at(i));
    }
  }

  // --- Swico S1 billing information (outside the SIX standardisation: warnings only) ------------
  let swico: DecodedQrBill['swico'] = null;
  if (strd !== '') {
    const parsed = parseSwicoS1(strd);
    if (parsed.present) {
      swico = { fields: parsed.fields, notes: parsed.notes, uid: parsed.uid };
      for (const n of parsed.notes) {
        warn('swico_value', 'AddInf.StrdBkgInf', lineOf(E.STRDBKGINF), `The Swico S1 value for ${n.key} could not be read (${n.reason}); it was left out.`, { key: n.key });
      }
    } else {
      warn('billing_info_unrecognised', 'AddInf.StrdBkgInf', lineOf(E.STRDBKGINF), 'The billing information is not in the Swico S1 syntax; it is kept as text and not interpreted.');
    }
  }

  if (errors.length > 0 || creditor === null) return refuse();

  return {
    ok: true,
    bill: {
      version: at(E.VERSION),
      iban,
      qrIban,
      creditor,
      amountMinor,
      currency: ccy as 'CHF' | 'EUR',
      ultimateDebtor,
      referenceType: tp as QrReferenceType,
      reference,
      unstructuredMessage: ustrd !== '' ? ustrd : null,
      notification,
      billingInformation: strd !== '' ? strd : null,
      alternativeProcedures,
      swico,
    },
    warnings,
  };
}
