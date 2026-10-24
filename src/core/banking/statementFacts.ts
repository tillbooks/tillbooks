/**
 * D178 points 3 and 4 (A20 §11.1): THE FACTS OF A BANK LINE, whichever format brought it in.
 *
 * A line's booked fact stays where it always was (`bank_txn`: the amount in the account currency, the
 * booking and value date, the D81 identity key; `bank_txn_detail`: the counterparty). What a statement
 * says ABOUT the movement beyond that is kept here, in `bank_txn_fact`, one row per line, OUT of the
 * identity key and the statement hash, so a camt imported before this module still re-imports as
 * `duplicate: true`:
 *
 *  - the bank transaction code (SIX: `BkTxCd/Domn/Cd`, `Fmly/Cd`, `SubFmlyCd`, and `Prtry/Cd` + `Issr`)
 *    with the SIX "Swiss Market Individualization" text as its label, in en and de-CH;
 *  - the bank texts as SEPARATE facts (`RmtInf/Ustrd`, `AddtlTxInf`, `AddtlNtryInf`), where A39's
 *    `remittance_text` keeps the one merged text its proposals have always read;
 *  - the references (`EndToEndId`, `AcctSvcrRef`, `InstrId`, `TxId`);
 *  - the amounts of SPS 2.3 §3.3 (`InstdAmt`, `TxAmt`, `CntrValAmt`), the exchange (`CcyXchg`: source,
 *    target and unit currency, the bank's rate verbatim) and TILL's own effective rate;
 *  - the charges (`Chrgs`: the total and every record with `CdtDbtInd`, `ChrgInclInd`, type) and the
 *    derived FEE: the charge in the line's own currency, and whether the line's amount contains it.
 *
 * PRIMARY SOURCES, fetched 21.10.2026 and read directly: SIX, Swiss Implementation Guidelines
 * Customer-Bank Messages (Reports) 2.3 (20.02.2026), §3.3 p.18-19, C-level p.66-71, D-level p.76-81; SIX,
 * List of BTC codes used in Switzerland 1.0, the en edition (extracted at
 * `test/fixtures/btc-codes-sps-ch.json`) and the de edition (`btc-codes-sps-de.xlsx`), whose texts are the
 * labels below verbatim, normalised only as the extractor normalises the en edition (soft hyphens out,
 * non-breaking hyphens to plain ones) and with the validity note "(valid from 20.8.2024)" dropped.
 *
 * MONEY IS EXACT. Every amount is integer hundredths of the currency unit as written (the camt and MT940
 * shape); a rate is the bank's decimal STRING, never a float; the effective rate and the "is the fee
 * inside the amount" check run on BigInt. Pure functions here, plus the one writer and the one reader of
 * the table, both §H-TENANT.
 */

import type { WorkspaceContext } from '../context.js';
import type Database from 'better-sqlite3';

export type FactSource = 'camt053' | 'camt054' | 'mt940' | 'csv';
export type FactOrigin = 'structured' | 'text';

export interface MoneyFact {
  amountMinor: number;
  currency: string;
}

export interface BankCodeFact {
  domain: string | null;
  family: string | null;
  subFamily: string | null;
  /** `BkTxCd/Prtry/Cd` (camt), the MT940 type code, the German GVC, the ZKB business-case number. */
  proprietary: string | null;
  /** `BkTxCd/Prtry/Issr` (camt), `SWIFT`, `DK` or `ZKB` for the MT940 codes. */
  issuer: string | null;
}

export interface ExchangeFact {
  sourceCurrency: string | null;
  targetCurrency: string | null;
  /** SPS p.68: "if 1 CHF = xxx CUR, then the unit currency is CHF". */
  unitCurrency: string | null;
  /** The bank's `XchgRate` verbatim (a decimal string), or null when the line carries none. */
  rate: string | null;
  /** TILL's figure: the booked amount per ONE instructed unit, six decimals, fee included. */
  effectiveRate: string | null;
  origin: FactOrigin;
}

export interface ChargeRecordFact {
  amountMinor: number;
  currency: string;
  creditDebit: 'CRDT' | 'DBIT' | null;
  /** `ChrgInclInd`: true when the charge is inside the entry amount, false when booked apart, null unsaid. */
  included: boolean | null;
  type: string | null;
}

export interface ChargesFact {
  totalMinor: number | null;
  currency: string | null;
  records: ChargeRecordFact[];
  origin: FactOrigin;
}

export interface FeeFact {
  /** Positive, in the LINE's currency. */
  amountMinor: number;
  currency: string;
  /** True: the line's amount contains the fee. False: it does not. Null: not known. */
  included: boolean | null;
  origin: 'charges' | 'text';
}

export interface LineRefsFact {
  endToEndId: string | null;
  accountServicerRef: string | null;
  instructionId: string | null;
  transactionId: string | null;
}

/** What a parser read off ONE line, before TILL derives the fee and the effective rate. */
export interface ParsedLineFacts {
  source: FactSource;
  bankCode: BankCodeFact | null;
  bankText: string | null;
  additionalInfo: string | null;
  entryInfo: string | null;
  refs: LineRefsFact;
  instructed: MoneyFact | null;
  transactionAmount: MoneyFact | null;
  counterValue: MoneyFact | null;
  exchange: ExchangeFact | null;
  /** `Chrgs` (camt); an MT940 `/CHGS/` or ZKB `?4:` to `?8:`, a mapped CSV fee column: one record each. */
  charges: ChargesFact | null;
}

/** The stored and projected facts: the parsed ones plus what TILL derived. */
export interface LineFacts extends ParsedLineFacts {
  fee: FeeFact | null;
}

/** The read model (`list_bank_inbox` `facts`): the stored facts with the code's SIX label. */
export interface BankLineFacts extends Omit<LineFacts, 'bankCode'> {
  bankCode: (BankCodeFact & { label: { en: string; 'de-CH': string } | null }) | null;
}

/** An empty fact set for a source, the shape every parser fills. */
export function emptyFacts(source: FactSource): ParsedLineFacts {
  return {
    source,
    bankCode: null,
    bankText: null,
    additionalInfo: null,
    entryInfo: null,
    refs: { endToEndId: null, accountServicerRef: null, instructionId: null, transactionId: null },
    instructed: null,
    transactionAmount: null,
    counterValue: null,
    exchange: null,
    charges: null,
  };
}

// --- The SIX BTC labels ---------------------------------------------------------------------------

/**
 * The 48 rows of the SIX list (both sheets), each with the en and de "Swiss Market Individualization".
 * `subFamily: null` is SIX's own row for the domestic instant payments, whose sheet says the sub-family
 * "does not change to normal payments": it labels any sub-family of that family no other row names.
 * `test/banking/e2-statement-facts.test.mjs` asserts every en text below against the extracted fixture.
 */
const SIX_BTC: readonly { d: string; f: string; s: string | null; en: string; de: string }[] = [
  // CH-specific (mandatory)
  { d: 'PMNT', f: 'ICDT', s: 'VCOM', en: 'Domestic QRR or SCOR payment instruction', de: 'Zahlungsauftrag QRR oder SCOR Inland' },
  { d: 'PMNT', f: 'IDDT', s: 'PMDD', en: 'Credit from direct debit', de: 'Gutschrift aus Lastschriftverfahren' },
  { d: 'PMNT', f: 'IDDT', s: 'RCDD', en: 'Debit from chargeback direct debit', de: 'Belastung aus Rückbuchung Lastschriftverfahren' },
  { d: 'PMNT', f: 'IDDT', s: 'UPDD', en: 'Debit from chargeback direct debit', de: 'Belastung aus Rückbuchung Lastschriftverfahren' },
  { d: 'PMNT', f: 'IDDT', s: 'PRDD', en: 'Debit from chargeback direct debit', de: 'Belastung aus Rückbuchung Lastschriftverfahren' },
  {
    d: 'PMNT',
    f: 'RCDT',
    s: 'VCOM',
    en: 'Incoming payment with structured reference, QR-IBAN incoming payment, domestic SCOR incoming payment.',
    de: 'Zahlungseingang mit strukturierter Referenz, QR-IBAN-Zahlungseingang, SCOR-Inland-Zahlungseingang.',
  },
  { d: 'PMNT', f: 'RDDT', s: 'PMDD', en: 'Debit from direct debit', de: 'Belastung aus Lastschriftverfahren' },
  { d: 'PMNT', f: 'RDDT', s: 'PRDD', en: 'Credit from chargeback direct debit', de: 'Gutschrift aus Rückbuchung Lastschriftverfahren' },
  { d: 'PMNT', f: 'IRCT', s: null, en: 'Debit from domestic instant payment', de: 'Belastung aus Domestic Instant-Zahlung' },
  { d: 'PMNT', f: 'RRCT', s: null, en: 'Credit from domestic instant payment', de: 'Gutschrift aus Domestic Instant-Zahlung' },
  {
    d: 'PMNT',
    f: 'IRCT',
    s: 'RRTN',
    en: 'Reversal of a credit (due to revocation) based on a domestic instant payment',
    de: 'Rückbuchung einer Gutschrift (resultiert aus Rückzahlungsbegehren) basierend auf einer Domestic Instant-Zahlung',
  },
  {
    d: 'PMNT',
    f: 'RRCT',
    s: 'RRTN',
    en: 'Domestic instant payment debit chargeback (due to an undeliverable transfer or revocation) based on a domestic instant payment',
    de: 'Rückbuchung einer Belastung (resultierend aus unanbringlicher Überweisung oder Rückzahulungsbegehren) basierend auf einer Domestic Instant-Zahlung',
  },
  // CH general (usual)
  { d: 'PMNT', f: 'CNTR', s: 'CDPT', en: 'Cash deposit at counter', de: 'Schalter Bareinzahlung' },
  { d: 'PMNT', f: 'CNTR', s: 'CWDL', en: 'Cash withdrawal at counter', de: 'Schalter Barauszahlung' },
  { d: 'PMNT', f: 'CNTR', s: 'CHKD', en: 'Check cashing at counter', de: 'Schalter Checkeinlösung' },
  { d: 'PMNT', f: 'CCRD', s: 'CDPT', en: 'Deposit at machine with card', de: 'Einzahlung Automat mit Karte' },
  { d: 'PMNT', f: 'CCRD', s: 'CWDL', en: 'Withdrawal from machine with card', de: 'Auszahlung Automat mit Karte' },
  { d: 'PMNT', f: 'CCRD', s: 'XBCW', en: 'Withdrawal from machine abroad with card', de: 'Auszahlung Automat Ausland mit Karte' },
  { d: 'PMNT', f: 'CCRD', s: 'POSD', en: 'Payment with card at POS', de: 'Zahlung mit Karte am POS' },
  { d: 'PMNT', f: 'ICHQ', s: 'CCHQ', en: 'Check debit', de: 'Check Belastung' },
  { d: 'PMNT', f: 'ICHQ', s: 'XBCQ', en: 'Check debit abroad', de: 'Check Belastung Ausland' },
  { d: 'PMNT', f: 'ICDT', s: 'AUTT', en: 'Electronic payment order', de: 'Elektronischer Zahlungsauftrag' },
  { d: 'PMNT', f: 'ICDT', s: 'DMCT', en: 'Paper-bound payment order', de: 'Papiergebundener Zahlungsauftrag' },
  { d: 'PMNT', f: 'ICDT', s: 'BOOK', en: 'Account transfer debit', de: 'Kontoübertrag Belastung' },
  { d: 'PMNT', f: 'ICDT', s: 'SALA', en: 'Salary payment instruction', de: 'Zahlungsauftrag Salär' },
  { d: 'PMNT', f: 'ICDT', s: 'PRCT', en: 'Priority payment instruction', de: 'Zahlungsauftrag priorisiert' },
  { d: 'PMNT', f: 'ICDT', s: 'RRTN', en: 'Chargeback payment', de: 'Rückbuchung Zahlung' },
  { d: 'PMNT', f: 'ICDT', s: 'ESCT', en: 'SEPA payment instruction', de: 'Zahlungsauftrag SEPA' },
  { d: 'PMNT', f: 'ICDT', s: 'STDO', en: 'Standing order', de: 'Dauerauftrag' },
  { d: 'PMNT', f: 'IDDT', s: 'XBDD', en: 'Credit from abroad from direct debit', de: 'Gutschrift vom Ausland aus Lastschriftverfahren' },
  { d: 'PMNT', f: 'IDDT', s: 'BBDD', en: 'Credit from SEPA B2B direct debit', de: 'Gutschrift aus SEPA-Firmenlastschrift' },
  { d: 'PMNT', f: 'IDDT', s: 'ESDD', en: 'Credit from SEPA Core direct debit', de: 'Gutschrift aus SEPA-Basislastschrift' },
  { d: 'PMNT', f: 'RCHQ', s: 'CCHQ', en: 'Check credit', de: 'Check Gutschrift' },
  { d: 'PMNT', f: 'RCHQ', s: 'CQRV', en: 'Chargeback check', de: 'Check Rückbuchung' },
  { d: 'PMNT', f: 'RCHQ', s: 'URCQ', en: 'Check credit receipt reserved', de: 'Check Gutschrift Eingang vorbehalten' },
  { d: 'PMNT', f: 'RCDT', s: 'ATXN', en: 'Interbank incoming payment', de: 'Interbank Zahlungseingang' },
  { d: 'PMNT', f: 'RCDT', s: 'AUTT', en: 'Electronic incoming payment', de: 'Elektronischer Zahlungseingang' },
  { d: 'PMNT', f: 'RCDT', s: 'XBCT', en: 'Foreign incoming payment', de: 'Ausland Zahlungseingang' },
  { d: 'PMNT', f: 'RCDT', s: 'DMCT', en: 'Paper-bound incoming payment', de: 'Papiergebundener Zahlungseingang' },
  { d: 'PMNT', f: 'RCDT', s: 'BOOK', en: 'Account transfer credit', de: 'Kontoübertrag Gutschrift' },
  { d: 'PMNT', f: 'RCDT', s: 'SALA', en: 'Salary incoming payment', de: 'Salär Zahlungseingang' },
  { d: 'PMNT', f: 'RCDT', s: 'ESCT', en: 'SEPA incoming payment', de: 'SEPA Zahlungseingang' },
  { d: 'PMNT', f: 'RDDT', s: 'BBDD', en: 'Debit from SEPA B2B direct debit', de: 'Belastung aus SEPA-Firmenlastschrift' },
  { d: 'PMNT', f: 'RDDT', s: 'ESDD', en: 'Debit from SEPA Core direct debit', de: 'Belastung aus SEPA-Basislastschrift' },
  { d: 'PMNT', f: 'IRCT', s: 'ESCT', en: 'Debit from SEPA Instant Credit Transfer', de: 'Belastung aus SEPA Instant Credit Transfer' },
  { d: 'PMNT', f: 'RRCT', s: 'ESCT', en: 'Credit from SEPA Instant Credit Transfer', de: 'Gutschrift aus SEPA Instant Credit Transfer' },
  // The SEPA Instant reversals share their code with the mandatory domestic rows above; listed for the
  // record, never reached by `btcLabel` (the mandatory row is found first).
  {
    d: 'PMNT',
    f: 'IRCT',
    s: 'RRTN',
    en: 'SEPA Credit Transfer Instant chargeback (resulting from undeliverable transfer or revocation)',
    de: 'SEPA Credit Transfer Instant Rückbuchung (resultierend aus unanbringlicher Überweisung oder Rückruf)',
  },
  {
    d: 'PMNT',
    f: 'RRCT',
    s: 'RRTN',
    en: 'SEPA Credit Transfer Instant chargeback (resulting from undeliverable transfer or revocation)',
    de: 'SEPA Credit Transfer Instant Rückbuchung (resultierend aus unanbringlicher Überweisung oder Rückruf)',
  },
];

/** The SIX label table, exported for the guard suite only. */
export const SIX_BTC_LABELS = SIX_BTC;

/**
 * The SIX label of a code, or null when SIX names none (a proprietary code, a code outside the Swiss
 * list). An exact Domain/Family/Sub-Family row wins; the instant-payment families fall back to their
 * family row. The two SEPA Instant reversal rows (IRCT/RRTN, RRCT/RRTN on the "usual" sheet) share their
 * code with the mandatory domestic rows; the mandatory row is the one SIX makes binding, so it wins.
 */
export function btcLabel(code: Pick<BankCodeFact, 'domain' | 'family' | 'subFamily'> | null): { en: string; 'de-CH': string } | null {
  if (code === null || code.domain === null || code.family === null) return null;
  const exact = SIX_BTC.find((r) => r.d === code.domain && r.f === code.family && r.s !== null && r.s === code.subFamily);
  const row = exact ?? SIX_BTC.find((r) => r.d === code.domain && r.f === code.family && r.s === null);
  return row === undefined ? null : { en: row.en, 'de-CH': row.de };
}

// --- Exact decimal arithmetic -----------------------------------------------------------------------

/** A non-negative decimal string as a scaled BigInt, or null when it is not one. `.` or `,` as the point. */
export function parseDecimal(text: string | null | undefined): { n: bigint; scale: number } | null {
  if (text === null || text === undefined || text.length > 64) return null;
  const t = text.trim().replace(',', '.');
  if (t.length > 30 || !/^\d+(\.\d+)?$/.test(t)) return null;
  const [whole, frac = ''] = t.split('.') as [string, string?];
  return { n: BigInt(whole + frac), scale: frac.length };
}

/** a / b rounded half up (a, b non-negative, b > 0). */
function divHalfUp(a: bigint, b: bigint): bigint {
  return (a * 2n + b) / (2n * b);
}

/**
 * The effective rate: `bookedMinor / instructedMinor`, six decimals, half up, as a string (`0.820665`).
 * Null when the instructed amount is zero.
 */
export function effectiveRateOf(bookedMinor: number, instructedMinor: number): string | null {
  if (!Number.isSafeInteger(bookedMinor) || !Number.isSafeInteger(instructedMinor) || instructedMinor <= 0 || bookedMinor < 0) return null;
  const q = divHalfUp(BigInt(bookedMinor) * 1_000_000n, BigInt(instructedMinor));
  const s = q.toString().padStart(7, '0');
  return `${s.slice(0, -6)}.${s.slice(-6)}`;
}

/**
 * The account-currency principal of an instructed amount at the bank's rate, half up. The unit currency
 * decides the direction (SPS p.68): unit = source ("1 USD = 0.81 CHF") multiplies, unit = target
 * ("1 CHF = 1.23 USD") divides. Null when the rate is unreadable or the unit is neither side.
 */
export function principalAtRate(instructed: MoneyFact, exchange: ExchangeFact, lineCurrency: string): number | null {
  const rate = parseDecimal(exchange.rate);
  if (rate === null || rate.n === 0n) return null;
  const scale = 10n ** BigInt(rate.scale);
  const unit = exchange.unitCurrency ?? exchange.sourceCurrency ?? instructed.currency;
  const amount = BigInt(instructed.amountMinor);
  let principal: bigint;
  if (unit === instructed.currency) principal = divHalfUp(amount * rate.n, scale);
  else if (unit === lineCurrency) principal = divHalfUp(amount * scale, rate.n);
  else return null;
  return principal > BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(principal);
}

// --- Amounts in free text ----------------------------------------------------------------------------

/**
 * A Swiss amount string to integer hundredths: `1'234.50`, `1’234.50`, `1 234,50`, `1234,50`, `60.78`,
 * `0.62`, `100,`. A trailing or leading sign is the caller's; this reads the magnitude only. More than
 * two decimals is unreadable (null), never rounded.
 *
 * `decimal` names the decimal separator when the caller knows it (a CSV mapping); the other one is then a
 * thousands separator. Without it, the LAST `.` or `,` is the decimal point, except a lone separator
 * followed by exactly three digits after a non-zero whole part (`1,234`, `12.500`), which is a thousands
 * group: a Swiss amount has at most two decimals. `0.125` is unreadable, never 125.00.
 */
export function swissAmountToMinor(raw: string, decimal?: '.' | ','): number | null {
  if (raw.length > 64) return null;
  const t = raw.trim().replace(/[’'   ]/g, '');
  if (t === '' || !/^[\d.,]+$/.test(t)) return null;
  let whole = t;
  let frac = '';
  if (decimal !== undefined) {
    const thousands = decimal === '.' ? ',' : '.';
    const parts = t.split(decimal);
    if (parts.length > 2) return null;
    whole = (parts[0] as string).split(thousands).join('');
    frac = parts[1] ?? '';
    if (frac.includes(thousands)) return null;
  } else {
    const sep = Math.max(t.lastIndexOf('.'), t.lastIndexOf(','));
    if (sep >= 0) {
      const after = t.slice(sep + 1);
      const before = t.slice(0, sep);
      const sepChar = t[sep] as string;
      if (before.includes(sepChar)) {
        // The same separator twice (`1.234.567`): thousands groups only, every group three digits.
        const groups = t.split(sepChar);
        if (!/^[1-9]\d{0,2}$/.test(groups[0] as string) || groups.slice(1).some((g) => !/^\d{3}$/.test(g))) return null;
        whole = groups.join('');
        frac = '';
      } else if (after.length === 3 && /^[1-9]\d{0,2}$/.test(before)) {
        whole = before + after;
        frac = '';
      } else {
        whole = before.replace(/[.,]/g, '');
        frac = after;
      }
    }
  }
  if (!/^\d+$/.test(whole) || !/^\d{0,2}$/.test(frac)) return null;
  const value = Number(whole) * 100 + Number((frac + '00').slice(0, 2));
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * An amount inside free text; the lookahead keeps `60.78,` whole and never stops inside a number. Every
 * repetition is bounded (at most 12 digits, 4 thousands groups), so a long digit run costs a constant.
 */
const AMOUNT_RE = String.raw`(?:\d{1,3}(?:[’' ]\d{3}){1,4}(?:[.,]\d{1,2})?|\d{1,12}(?:[.,]\d{1,2})?)(?!\d)(?![.,]\d)`;

/** The longest bank text the FX fallback reads (camt Ustrd is 140, an MT940 :86: 6x65). */
const FX_TEXT_MAX_CHARS = 2000;

/**
 * The currency codes the text fallback reads as money: the circulating alphabetic codes of ISO 4217
 * list one (SIX, the maintenance agency, published 17.09.2026), without the fund, metal and test codes
 * (BOV, CHE, CHW, XAU, XTS, XXX, ...), which no card text carries and a masked card number (`XXX 1234`)
 * would otherwise imitate. A three-letter word that is not here (`ZUG 6300`, `LSG 445566`) is no money.
 */
const TEXT_CURRENCIES: ReadonlySet<string> = new Set([
  'AED', 'AFN', 'ALL', 'AMD', 'AOA', 'ARS', 'AUD', 'AWG', 'AZN', 'BAM', 'BBD', 'BDT', 'BHD', 'BIF', 'BMD',
  'BND', 'BOB', 'BRL', 'BSD', 'BTN', 'BWP', 'BYN', 'BZD', 'CAD', 'CDF', 'CHF', 'CLP', 'CNY', 'COP', 'CRC',
  'CUP', 'CVE', 'CZK', 'DJF', 'DKK', 'DOP', 'DZD', 'EGP', 'ERN', 'ETB', 'EUR', 'FJD', 'FKP', 'GBP', 'GEL',
  'GHS', 'GIP', 'GMD', 'GNF', 'GTQ', 'GYD', 'HKD', 'HNL', 'HTG', 'HUF', 'IDR', 'INR', 'IQD', 'IRR', 'ISK',
  'JMD', 'JOD', 'JPY', 'KES', 'KGS', 'KHR', 'KMF', 'KPW', 'KRW', 'KWD', 'KYD', 'KZT', 'LAK', 'LBP', 'LKR',
  'LRD', 'LSL', 'LYD', 'MAD', 'MDL', 'MGA', 'MKD', 'MMK', 'MNT', 'MOP', 'MRU', 'MUR', 'MVR', 'MWK', 'MXN',
  'MYR', 'MZN', 'NAD', 'NGN', 'NIO', 'NOK', 'NPR', 'NZD', 'OMR', 'PAB', 'PEN', 'PGK', 'PHP', 'PKR', 'PLN',
  'PYG', 'QAR', 'RON', 'RSD', 'RUB', 'RWF', 'SAR', 'SBD', 'SCR', 'SDG', 'SEK', 'SGD', 'SHP', 'SLE', 'SOS',
  'SRD', 'SSP', 'STN', 'SVC', 'SYP', 'SZL', 'THB', 'TJS', 'TMT', 'TND', 'TOP', 'TRY', 'TTD', 'TWD', 'TZS',
  'UAH', 'UGX', 'USD', 'UYU', 'UZS', 'VED', 'VES', 'VND', 'VUV', 'WST', 'XAF', 'XCD', 'XCG', 'XOF', 'XPF',
  'YER', 'ZAR', 'ZMW', 'ZWG',
]);

/**
 * THE TEXT FALLBACK (A20 §11.1): the foreign amount, the rate and the fee a Swiss card text carries when
 * the statement has no structured FX, e.g. `<Händler> ..., USD 60.78, abgerechnet in CHF, Kurs 0.810464,
 * 01.09.2026, Kommission CHF 0.62`. Pure; never throws; reads nothing it cannot point at in the text.
 *
 * STRICT, ALL OR NOTHING (critic M4): a fact is written once and the file is not kept, so a wrong one
 * could never be corrected. The text is read only when it carries the WHOLE exchange pattern: a
 * settlement clause naming the line's own currency (`abgerechnet in CHF`, `settled in CHF`), a rate with
 * decimals after its keyword (`Kurs 0.810464`; "Kurs 12" is a course, "Rate 3" an instalment), and an
 * ISO 4217 amount in another currency before the settlement clause. Then the fee keyword's amount is read
 * too; without the pattern nothing is (no instructed amount, no rate, no fee).
 */
export function parseFxText(
  texts: readonly (string | null)[],
  lineCurrency: string,
): { instructed: MoneyFact | null; rate: string | null; fee: MoneyFact | null } {
  const none = { instructed: null, rate: null, fee: null };
  // Bounded input and bounded whitespace in every pattern below: a bank text is a few hundred
  // characters (camt Ustrd 140, MT940 :86: 6x65), and no text of any length can make a pattern backtrack.
  const text = texts
    .filter((t): t is string => t !== null && t.trim() !== '')
    .map((t) => t.slice(0, FX_TEXT_MAX_CHARS))
    .join(' • ');
  if (text === '') return none;
  const settledMatch = /\b(?:[Aa]bgerechnet|[Vv]errechnet|[Ss]ettled|[Dd](?:é|e)compt(?:é|e)) {1,3}(?:in|en) {1,3}([A-Z]{3})\b/u.exec(text);
  if (settledMatch === null || settledMatch[1] !== lineCurrency) return none;
  const rateMatch = /\b(?:Kurs|Wechselkurs|exchange {1,3}rate|rate|cours|taux) {0,3}:? {0,3}(\d{1,6}[.,]\d{1,12})(?![\d.,]\d)/iu.exec(text);
  if (rateMatch === null) return none;
  const rate = (rateMatch[1] as string).replace(',', '.');
  const feeRe = new RegExp(
    String.raw`\b(?:Kommission|Bearbeitungsgeb(?:ü|ue)hr|Auslandsgeb(?:ü|ue)hr|Fremdw(?:ä|ae)hrungsgeb(?:ü|ue)hr|Geb(?:ü|ue)hr|commission|fee|frais) {0,3}:? {0,3}([A-Z]{3}) {0,3}(${AMOUNT_RE})`,
    'iu',
  );
  const feeMatch = feeRe.exec(text);
  let fee: MoneyFact | null = null;
  let feeSpan: [number, number] | null = null;
  if (feeMatch !== null && TEXT_CURRENCIES.has(feeMatch[1] as string)) {
    const minor = swissAmountToMinor(feeMatch[2] as string);
    if (minor !== null) {
      fee = { amountMinor: minor, currency: feeMatch[1] as string };
      feeSpan = [feeMatch.index, feeMatch.index + feeMatch[0].length];
    }
  }
  // The foreign amount: the last ISO 4217 pair in another currency BEFORE the settlement clause.
  const pairRe = new RegExp(String.raw`\b([A-Z]{3}) {0,3}(${AMOUNT_RE})`, 'gu');
  let pick: MoneyFact | null = null;
  let m: RegExpExecArray | null;
  while ((m = pairRe.exec(text)) !== null && m.index < settledMatch.index) {
    if (feeSpan !== null && m.index >= feeSpan[0] && m.index < feeSpan[1]) continue;
    const currency = m[1] as string;
    if (currency === lineCurrency || !TEXT_CURRENCIES.has(currency)) continue;
    const minor = swissAmountToMinor(m[2] as string);
    if (minor !== null && minor > 0) pick = { amountMinor: minor, currency };
  }
  if (pick === null) return none;
  return { instructed: pick, rate, fee };
}

// --- Deriving the fee and the effective rate --------------------------------------------------------

/**
 * TILL's derivation over what the parser read (A20 §11.1): the text fallback where the statement carries
 * no structured FX, the effective rate, and the FEE (the charge in the line's currency) with whether the
 * line's amount contains it. `line` is the booked fact: its amount (positive), currency and direction.
 */
export function deriveFacts(parsed: ParsedLineFacts, line: { amountMinor: number; currency: string; creditDebit: 'CRDT' | 'DBIT' }): LineFacts {
  const facts: LineFacts = { ...parsed, refs: { ...parsed.refs }, fee: null };
  let textFee: MoneyFact | null = null;

  // The text fallback, only where the structure is silent.
  if (facts.instructed === null && facts.exchange === null) {
    const fromText = parseFxText([facts.bankText, facts.additionalInfo, facts.entryInfo], line.currency);
    if (fromText.instructed !== null) {
      facts.instructed = fromText.instructed;
      facts.exchange = {
        sourceCurrency: fromText.instructed.currency,
        targetCurrency: line.currency,
        // "Kurs 0.810464" on a USD amount settled in CHF is CHF per ONE USD: the unit is the source.
        unitCurrency: fromText.instructed.currency,
        rate: fromText.rate !== null && parseDecimal(fromText.rate) !== null ? fromText.rate : null,
        effectiveRate: null,
        origin: 'text',
      };
    }
    if (fromText.fee !== null) textFee = fromText.fee;
  }

  // The effective rate: booked per instructed unit, fee included.
  if (facts.instructed !== null && facts.instructed.currency !== line.currency) {
    const effective = effectiveRateOf(line.amountMinor, facts.instructed.amountMinor);
    facts.exchange =
      facts.exchange === null
        ? { sourceCurrency: facts.instructed.currency, targetCurrency: line.currency, unitCurrency: null, rate: null, effectiveRate: effective, origin: 'structured' }
        : { ...facts.exchange, effectiveRate: effective };
  }

  // The fee: the charge records in the line's own currency, else the text's fee in that currency.
  const records = (facts.charges?.records ?? []).filter((r) => r.currency === line.currency);
  let feeMinor = 0;
  let included: boolean | null = null;
  let origin: FeeFact['origin'] | null = null;
  if (records.length > 0) {
    for (const r of records) feeMinor += r.creditDebit === 'CRDT' ? -r.amountMinor : r.amountMinor;
    origin = 'charges';
    if (records.every((r) => r.included === true)) included = true;
    else if (records.some((r) => r.included === false)) included = false;
  } else if (facts.charges !== null && facts.charges.totalMinor !== null && facts.charges.currency === line.currency) {
    feeMinor = facts.charges.totalMinor;
    origin = 'charges';
  } else if (textFee !== null && textFee.currency === line.currency) {
    feeMinor = textFee.amountMinor;
    origin = 'text';
  }
  if (origin !== null && feeMinor > 0) {
    if (included === null) included = feeIsInside(facts, line, feeMinor);
    facts.fee = { amountMinor: feeMinor, currency: line.currency, included, origin };
  }
  return facts;
}

/**
 * Whether the line's booked amount contains the fee, proved by the arithmetic when no `ChrgInclInd` says
 * so: the counter value ("in account currency before charges", SPS p.69) plus the fee is the booked
 * amount, or the instructed amount at the bank's rate plus the fee is (within one hundredth, the bank's
 * own rounding). A debit carries the fee on top; a credit has it deducted. Null when nothing proves it.
 */
function feeIsInside(facts: LineFacts, line: { amountMinor: number; currency: string; creditDebit: 'CRDT' | 'DBIT' }, feeMinor: number): boolean | null {
  const sign = line.creditDebit === 'DBIT' ? 1 : -1;
  if (facts.counterValue !== null && facts.counterValue.currency === line.currency) {
    if (facts.counterValue.amountMinor + sign * feeMinor === line.amountMinor) return true;
  }
  // An instructed amount in the line's own currency (a domestic payment with the payer's bank charges
  // deducted, ZKB `?0:CHF700,35?4:CHF12,` on a 688.35 credit): exact, no rate involved.
  if (facts.instructed !== null && facts.instructed.currency === line.currency) {
    return facts.instructed.amountMinor + sign * feeMinor === line.amountMinor ? true : null;
  }
  if (facts.instructed !== null && facts.exchange !== null) {
    const principal = principalAtRate(facts.instructed, facts.exchange, line.currency);
    if (principal !== null && Math.abs(principal + sign * feeMinor - line.amountMinor) <= 1) return true;
  }
  return null;
}

// --- Storage (`bank_txn_fact`, DDL in `camtSchema.ts`) -----------------------------------------------

interface FactRow {
  bank_txn_id: string;
  source: string;
  btc_domain: string | null;
  btc_family: string | null;
  btc_sub_family: string | null;
  btc_proprietary: string | null;
  btc_issuer: string | null;
  remittance_text: string | null;
  description: string | null;
  remark: string | null;
  end_to_end_id: string | null;
  acct_svcr_ref: string | null;
  instruction_id: string | null;
  transaction_id: string | null;
  instructed_minor: number | null;
  instructed_currency: string | null;
  tx_amount_minor: number | null;
  tx_amount_currency: string | null;
  counter_value_minor: number | null;
  counter_value_currency: string | null;
  fx_source_currency: string | null;
  fx_target_currency: string | null;
  fx_unit_currency: string | null;
  fx_rate: string | null;
  fx_effective_rate: string | null;
  fx_origin: string | null;
  charges_total_minor: number | null;
  charges_currency: string | null;
  charges_records: string | null;
  charges_origin: string | null;
  fee_minor: number | null;
  fee_currency: string | null;
  fee_included: number | null;
  fee_origin: string | null;
}

/** The fact insert, compiled once per connection (an import writes one per line; critic M5). */
const factInsert = new WeakMap<object, Database.Statement<unknown[]>>();

/** Write one line's facts (once, at import, inside the import's transaction). §H-TENANT. */
export function writeLineFacts(ctx: WorkspaceContext, bankTxnId: string, f: LineFacts): void {
  const db = ctx.store.db;
  let insert = factInsert.get(db);
  if (insert === undefined) {
    insert = db.prepare(
      `INSERT INTO bank_txn_fact
         (bank_txn_id, workspace_id, source, btc_domain, btc_family, btc_sub_family, btc_proprietary, btc_issuer,
          remittance_text, description, remark, end_to_end_id, acct_svcr_ref, instruction_id, transaction_id,
          instructed_minor, instructed_currency, tx_amount_minor, tx_amount_currency, counter_value_minor,
          counter_value_currency, fx_source_currency, fx_target_currency, fx_unit_currency, fx_rate,
          fx_effective_rate, fx_origin, charges_total_minor, charges_currency, charges_records, charges_origin,
          fee_minor, fee_currency, fee_included, fee_origin, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    factInsert.set(db, insert);
  }
  insert.run(
      bankTxnId,
      ctx.workspaceId,
      f.source,
      f.bankCode?.domain ?? null,
      f.bankCode?.family ?? null,
      f.bankCode?.subFamily ?? null,
      f.bankCode?.proprietary ?? null,
      f.bankCode?.issuer ?? null,
      f.bankText,
      f.additionalInfo,
      f.entryInfo,
      f.refs.endToEndId,
      f.refs.accountServicerRef,
      f.refs.instructionId,
      f.refs.transactionId,
      f.instructed?.amountMinor ?? null,
      f.instructed?.currency ?? null,
      f.transactionAmount?.amountMinor ?? null,
      f.transactionAmount?.currency ?? null,
      f.counterValue?.amountMinor ?? null,
      f.counterValue?.currency ?? null,
      f.exchange?.sourceCurrency ?? null,
      f.exchange?.targetCurrency ?? null,
      f.exchange?.unitCurrency ?? null,
      f.exchange?.rate ?? null,
      f.exchange?.effectiveRate ?? null,
      f.exchange?.origin ?? null,
      f.charges?.totalMinor ?? null,
      f.charges?.currency ?? null,
      f.charges === null ? null : JSON.stringify(f.charges.records),
      f.charges?.origin ?? null,
      f.fee?.amountMinor ?? null,
      f.fee?.currency ?? null,
      f.fee === null ? null : f.fee.included === null ? null : f.fee.included ? 1 : 0,
      f.fee?.origin ?? null,
      ctx.clock.now(),
    );
}

function money(minor: number | null, currency: string | null): MoneyFact | null {
  return minor === null || currency === null ? null : { amountMinor: minor, currency };
}

function chargeRecordsOf(json: string | null): ChargeRecordFact[] {
  if (json === null) return [];
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (r): r is ChargeRecordFact =>
        r !== null && typeof r === 'object' && Number.isSafeInteger((r as ChargeRecordFact).amountMinor) && typeof (r as ChargeRecordFact).currency === 'string',
    );
  } catch {
    return [];
  }
}

function asSource(s: string): FactSource {
  return s === 'mt940' || s === 'csv' || s === 'camt054' ? s : 'camt053';
}

function asOrigin(s: string | null): FactOrigin {
  return s === 'text' ? 'text' : 'structured';
}

/** One stored row as the read model. */
export function factsOfRow(r: FactRow): BankLineFacts {
  const code: BankCodeFact | null =
    r.btc_domain !== null || r.btc_proprietary !== null
      ? { domain: r.btc_domain, family: r.btc_family, subFamily: r.btc_sub_family, proprietary: r.btc_proprietary, issuer: r.btc_issuer }
      : null;
  const exchange: ExchangeFact | null =
    r.fx_source_currency !== null || r.fx_rate !== null || r.fx_effective_rate !== null
      ? {
          sourceCurrency: r.fx_source_currency,
          targetCurrency: r.fx_target_currency,
          unitCurrency: r.fx_unit_currency,
          rate: r.fx_rate,
          effectiveRate: r.fx_effective_rate,
          origin: asOrigin(r.fx_origin),
        }
      : null;
  const records = chargeRecordsOf(r.charges_records);
  const charges: ChargesFact | null =
    r.charges_origin !== null
      ? { totalMinor: r.charges_total_minor, currency: r.charges_currency, records, origin: asOrigin(r.charges_origin) }
      : null;
  return {
    source: asSource(r.source),
    bankCode: code === null ? null : { ...code, label: btcLabel(code) },
    bankText: r.remittance_text,
    additionalInfo: r.description,
    entryInfo: r.remark,
    refs: { endToEndId: r.end_to_end_id, accountServicerRef: r.acct_svcr_ref, instructionId: r.instruction_id, transactionId: r.transaction_id },
    instructed: money(r.instructed_minor, r.instructed_currency),
    transactionAmount: money(r.tx_amount_minor, r.tx_amount_currency),
    counterValue: money(r.counter_value_minor, r.counter_value_currency),
    exchange,
    charges,
    fee:
      r.fee_minor === null || r.fee_currency === null
        ? null
        : { amountMinor: r.fee_minor, currency: r.fee_currency, included: r.fee_included === null ? null : r.fee_included === 1, origin: r.fee_origin === 'text' ? 'text' : 'charges' },
  };
}

/** The facts of several lines in one query (the inbox page), keyed by line id. §H-TENANT. */
export function readLineFactsMap(ctx: WorkspaceContext, bankTxnIds: readonly string[]): Map<string, BankLineFacts> {
  const out = new Map<string, BankLineFacts>();
  for (let i = 0; i < bankTxnIds.length; i += 500) {
    const chunk = bankTxnIds.slice(i, i + 500);
    const rows = ctx.store.db
      .prepare(`SELECT * FROM bank_txn_fact WHERE workspace_id = ? AND bank_txn_id IN (${chunk.map(() => '?').join(', ')})`)
      .all(ctx.workspaceId, ...chunk) as FactRow[];
    for (const r of rows) out.set(r.bank_txn_id, factsOfRow(r));
  }
  return out;
}

/** One line's stored fee (what the proposal ladder reads), or null. §H-TENANT. */
export function readLineFee(ctx: WorkspaceContext, bankTxnId: string): FeeFact | null {
  const r = ctx.store.db
    .prepare('SELECT fee_minor, fee_currency, fee_included, fee_origin FROM bank_txn_fact WHERE workspace_id = ? AND bank_txn_id = ?')
    .get(ctx.workspaceId, bankTxnId) as Pick<FactRow, 'fee_minor' | 'fee_currency' | 'fee_included' | 'fee_origin'> | undefined;
  if (r === undefined || r.fee_minor === null || r.fee_currency === null) return null;
  return { amountMinor: r.fee_minor, currency: r.fee_currency, included: r.fee_included === null ? null : r.fee_included === 1, origin: r.fee_origin === 'text' ? 'text' : 'charges' };
}
