/**
 * A07's eCH-0217 export: the MWST-Abrechnung as the file a person uploads to the ESTV himself.
 *
 * ## THIS TRANSMITS NOTHING, and that is the product, not a limitation to be worked around
 *
 * There is no ESTV submission API. Not a private one, not a partner one: none is documented
 * anywhere in public ESTV, eCH or vendor material, and `abrechnung.ts` and `api/registry.ts` both
 * already record the same finding. eCH-0217 is a FILE FORMAT, and the schema's own annotation says
 * what the file is for: `Spezifikation für die elektronische Einreichung von Mehrwertsteuer
 * (MWST)-Abrechnungen im Portal ESTV SuisseTax`. A portal upload
 * is a person signing for a figure. So the ceiling on this capability is a valid file plus the
 * address it goes to, and the result payload says `transmits: false` in as many words rather than
 * letting a caller infer it from the absence of a status field.
 *
 * ## The standard, and the version this was built against
 *
 * eCH-0217 **v2.0.0**, status `Genehmigt`, published 17.06.2025, listed as the current version at
 * `https://www.ech.ch/de/ech/ech-0217/2.0.0` (1.0.1 was superseded on 27.02.2024). The XSD and its
 * whole transitive import graph are vendored under `test/vat/fixtures/ech0217/`, and the generated
 * file is validated against them on every test run. The URLs that served each document are listed
 * in the header of `test/vat/ech0217-export.test.mjs`.
 *
 * ## THERE IS NO ZIFFER IN THE SCHEMA. The mapping below is the whole capability
 *
 * eCH-0217 names its elements semantically (`totalConsideration`, `inputTaxInvestments`) and never
 * by ESTV Ziffer, which is the same fact `abrechnung.ts` builds its internal model on: a Ziffer is a
 * PRINT concern. So this module is a translation table from the engine's Ziffern to the schema's
 * element names, and the table is the part a reader should check against the ESTV form and the XSD
 * side by side. Three consequences worth stating out loud:
 *
 *   - **The derived totals have no element.** Ziffern 289, 299, 399 and 479 are sums the ESTV
 *     recomputes, and the schema gives them nowhere to go. They are dropped deliberately, and the
 *     suite asserts they are not smuggled in somewhere else.
 *   - **The file carries no per-rate TAX figure at all.** `turnoverTaxRateType` is a bare
 *     `(taxRate, turnover)` pair, so the ESTV multiplies. The only tax figure in the whole document
 *     is `payableTax`. That is a real reconciliation risk and it is reported rather than hidden:
 *     see `taxCrossCheck` below.
 *   - **A Ziffer with no element STOPS the export.** It never silently drops out of the file. A
 *     return that is quietly short is signed by a person who cannot see what is missing. This is
 *     ENFORCED in three places, because for one release it was only claimed: `unmapped_form_line`
 *     for a Ziffer the table does not know, `form_line_not_in_method` for one whose element does not
 *     exist in the chosen method's sequence, and `mapped_amount_not_emitted` as a backstop that
 *     compares what was mapped against what was actually written. `AmountMapping.methods` used to be
 *     `block`, which was declared and never read, and eight Ziffern could evaporate between the
 *     mapping phase and the build phase while the document stayed schema-valid and the result said
 *     `ok`. A validator cannot see a missing optional element, so only this can.
 *
 * ## The method element depends on the PERIOD, and the XSD cannot check it
 *
 * The root `xs:choice` accepts all four method elements for any reporting period. The restriction
 * that `netTaxRateMethod` is valid only bis 31.12.2024 and `simpleTaxRateMethod` only ab 01.01.2025
 * lives in the specification PROSE (Kap. 4.4 Tabelle 1), and the ESTV enforces it at upload as
 * rejection rule MWST-0002. See `methodElementForPeriod`. Anything that validates the file against
 * the schema and stops there is blind to this by construction.
 *
 * ## Every figure is the engine's. Nothing here computes money
 *
 * The only arithmetic in this file is `minorToDecimal` (integer Rappen to a two-decimal string) and
 * `rateBpToPercent`. There is no multiplication by a rate, no netting, no rounding: `payableTax` is
 * `payableMinor - creditMinor` from `computeVatReturn` and every other amount is a field off one of
 * its lines. A file and a screen that can disagree is the exact defect A07 exists to avoid, and the
 * cheapest way to make disagreement impossible is to have only one place that can be right.
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { computeVatReturn } from './abrechnung.js';
import type { VatReturnLine } from './abrechnung.js';
import { generationsGoverning } from './saldoGenerations.js';

/** The eCH-0217 v2.0.0 target namespace, and the two namespaces its `generalInformation` imports. */
const NS_0217 = 'http://www.ech.ch/xmlns/eCH-0217/2';
const NS_0058 = 'http://www.ech.ch/xmlns/eCH-0058/5';
const NS_0108 = 'http://www.ech.ch/xmlns/eCH-0108/7';

/** Where the file goes. The SAME address the A07 surface links its fourth journey step to (W4). */
export const ESTV_EPORTAL_URL = 'https://www.estv.admin.ch/de/mwst-online-abrechnen';

/** eCH-0108 `uidType`: `CHE[1-9][0-9]{8}`, twelve characters, no separators and no ` MWST` suffix. */
const ECH_UID_RE = /^CHE[1-9][0-9]{8}$/;

/**
 * The UID's mod-11 check digit. The pattern above is a SHAPE; this is the number.
 *
 * The nine digits are eight payload digits plus a check digit, weighted 5,4,3,2,7,6,5,4. A remainder
 * of 10 means the prefix can never carry a check digit, so no UID with it was ever issued.
 *
 * Without this a transposed digit is schema-valid and fails at the ESTV under MWST-0009 (Kap. 7.7),
 * after the upload and after the deadline. Verified against two UIDs from the public register
 * (CHE-101.654.423, CHE-105.805.187) before being relied on, because a check digit implemented from
 * memory that rejects valid UIDs is worse than no check at all.
 */
const UID_WEIGHTS = [5, 4, 3, 2, 7, 6, 5, 4] as const;

function uidCheckDigitValid(uid: string): boolean {
  const digits = uid.slice(3);
  if (!/^\d{9}$/.test(digits)) return false;
  let sum = 0;
  for (let i = 0; i < 8; i += 1) sum += UID_WEIGHTS[i]! * Number(digits[i]);
  const remainder = 11 - (sum % 11);
  if (remainder === 10) return false;
  return (remainder === 11 ? 0 : remainder) === Number(digits[8]);
}

/**
 * `xs:token` whiteSpace=collapse, applied before the value reaches the file.
 *
 * eCH-0108 `unitNameType` restricts `xs:token`, so a receiving parser collapses the value and the
 * ESTV stores the collapsed form. Emitting the raw name meant the file did not say what the
 * authority would record. Note that this is NOT a validity fix: libxml2 accepts `Muster  AG` and
 * stores `Muster AG`. What it fixes is the disagreement between the two.
 */
function collapseToken(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** eCH-0108 `unitNameType`, after collapsing: minLength 1, maxLength 255. */
const ORG_NAME_MAX = 255;

/**
 * `sendingApplication`, an eCH-0058 triple. `manufacturer` is capped at 30 characters by that
 * schema, which is why the legal name is used bare rather than with a suffix.
 */
const SENDING_APPLICATION = { manufacturer: 'Nomadik GmbH', product: 'TILL', productVersion: '0.0.0' } as const;

// --- The Ziffer -> element translation table ------------------------------------------------------

/**
 * A Ziffer that becomes a bare `amountType` element, and which of the line's two columns it takes.
 *
 * `column` is load-bearing and is the mapping's easiest mistake: the turnover block declares the
 * LEISTUNGEN column (`baseMinor`) and the Vorsteuer block declares the STEUER column (`taxMinor`).
 * Ziffer 400 carries both a base and a tax, and putting the base in `inputTaxMaterialAndServices`
 * would claim the whole purchase as input tax.
 */
interface AmountMapping {
  block: 'turnover' | 'method' | 'flows';
  element: string;
  column: 'base' | 'tax';
  /**
   * For `block: 'method'`, the method elements whose `xs:sequence` actually carries this element.
   *
   * This is READ, and refusing on it is the whole of F2's fix. It used to be absent, `block` was
   * declared and never read, and the build phase picked element names per branch from one flat map:
   * a Ziffer whose element belonged to the other branch passed the unmapped-Ziffer guard and then
   * silently never got emitted. The document stayed schema-valid and the result said `ok`, so
   * nothing anywhere could see the money go missing.
   */
  methods?: readonly MethodElement[];
}

/** The three method elements TILL can emit. `flatTaxRateMethod` is the Pauschal regime, not built. */
type MethodElement = 'effectiveReportingMethod' | 'netTaxRateMethod' | 'simpleTaxRateMethod';

const EFFECTIVE = ['effectiveReportingMethod'] as const;
const NET = ['netTaxRateMethod'] as const;
/** Ziffer 415 is the one element the effektiv and the 2025 Saldo sequences share. */
const EFFECTIVE_AND_SIMPLE = ['effectiveReportingMethod', 'simpleTaxRateMethod'] as const;

const AMOUNT_BY_ZIFFER: Readonly<Record<string, AmountMapping>> = {
  // turnoverComputationType, in its xs:sequence order.
  '200': { block: 'turnover', element: 'totalConsideration', column: 'base' },
  '220': { block: 'turnover', element: 'suppliesToForeignCountries', column: 'base' },
  '221': { block: 'turnover', element: 'suppliesAbroad', column: 'base' },
  '225': { block: 'turnover', element: 'transferNotificationProcedure', column: 'base' },
  '230': { block: 'turnover', element: 'suppliesExemptFromTax', column: 'base' },
  '235': { block: 'turnover', element: 'reductionOfConsideration', column: 'base' },
  // 280 is `variousDeductionType`, an amount PLUS a mandatory description, so it is handled apart.

  // effectiveReportingMethodType, in its xs:sequence order (XSD lines 226-241).
  '205': { block: 'method', element: 'opted', column: 'base', methods: EFFECTIVE },
  '400': { block: 'method', element: 'inputTaxMaterialAndServices', column: 'tax', methods: EFFECTIVE },
  '405': { block: 'method', element: 'inputTaxInvestments', column: 'tax', methods: EFFECTIVE },
  '410': { block: 'method', element: 'subsequentInputTaxDeduction', column: 'tax', methods: EFFECTIVE },
  // 415 is the ONE input-tax element the 2025 Saldo sequence also carries (XSD line 283), which is
  // Kap. 5.3.6's "Korrekturen bei unbeweglichen Gegenständen (Art. 82 Abs. 2 und Art. 93 MWSTV)".
  '415': { block: 'method', element: 'inputTaxCorrections', column: 'tax', methods: EFFECTIVE_AND_SIMPLE },
  '420': { block: 'method', element: 'inputTaxReductions', column: 'tax', methods: EFFECTIVE },

  // netTaxRateMethodType ONLY. The Saldo form's 470/471 are the Steueranrechnung, NOT a Vorsteuer
  // total: Art. 37 gives a Saldo filer no input-tax deduction and the schema gives the method no
  // element for one. Note the scope: `simpleTaxRateMethodType` (XSD lines 280-285) drops both, so
  // from 01.01.2025 these two have NOWHERE to go and must refuse rather than evaporate.
  '470': { block: 'method', element: 'compensationExport', column: 'tax', methods: NET },
  '471': { block: 'method', element: 'deemedInputTaxDeduction', column: 'tax', methods: NET },

  // otherFlowsOfFundsType (Art. 18 Abs. 2).
  '900': { block: 'flows', element: 'subsidies', column: 'base' },
  '910': { block: 'flows', element: 'donations', column: 'base' },
};

/** The Ziffern that become a `(taxRate, turnover)` pair, and which repeated element they feed. */
const PER_RATE_BY_ZIFFER: Readonly<Record<string, { element: 'suppliesPerTaxRate' | 'acquisitionTax'; saldo: boolean }>> = {
  '302': { element: 'suppliesPerTaxRate', saldo: false }, // Normal 7,7% (bis 31.12.2023)
  '303': { element: 'suppliesPerTaxRate', saldo: false }, // Normal 8,1% (ab 01.01.2024)
  '312': { element: 'suppliesPerTaxRate', saldo: false }, // Reduziert 2,5%
  '313': { element: 'suppliesPerTaxRate', saldo: false }, // Reduziert 2,6%
  '342': { element: 'suppliesPerTaxRate', saldo: false }, // Beherbergung 3,7%
  '343': { element: 'suppliesPerTaxRate', saldo: false }, // Beherbergung 3,8%
  '322': { element: 'suppliesPerTaxRate', saldo: true }, //  Saldosteuersatz 1. Satz (bis 31.12.2023)
  '323': { element: 'suppliesPerTaxRate', saldo: true }, //  Saldosteuersatz 1. Satz (ab 01.01.2024)
  '332': { element: 'suppliesPerTaxRate', saldo: true }, //  Saldosteuersatz 2. Satz (bis 31.12.2023)
  '333': { element: 'suppliesPerTaxRate', saldo: true }, //  Saldosteuersatz 2. Satz (ab 01.01.2024)
  '382': { element: 'acquisitionTax', saldo: false }, //     Bezugsteuer (bis 31.12.2023)
  '383': { element: 'acquisitionTax', saldo: false }, //     Bezugsteuer (ab 01.01.2024)
};

/**
 * The Ziffern that are DERIVED TOTALS, dropped on purpose because eCH-0217 has no element for them.
 *
 * Listed rather than left to fall through the unmapped-Ziffer refusal, so that "this Ziffer is not
 * in the file" is a decision a reader can find and check, and a NEW Ziffer the engine grows still
 * stops the export instead of joining them silently.
 *
 *   289  Total Ziff. 220 bis 280     the ESTV sums the deductions itself
 *   299  Steuerbarer Gesamtumsatz    200 less 289
 *   399  Total geschuldete Steuer    the ESTV multiplies each (taxRate, turnover) pair itself
 *   479  Total Ziff. 400 bis 420     likewise, from the input-tax elements
 *   500  Zu bezahlender Betrag       these two ARE in the file, as the single signed `payableTax`
 *   510  Guthaben der steuerpflichtigen Person
 */
const DERIVED_TOTALS = new Set(['289', '299', '399', '479', '500', '510']);

/**
 * The day the Saldo/Pauschal regime changed, and with it the element the file must use.
 *
 * eCH-0217 v2.0.0, Kap. 4.4 Tabelle 1, verbatim:
 *
 *   netTaxRateMethod     netTaxRateMethodType     1..1  (Für Abrechnungsperioden bis 31.12.2024)
 *   simpleTaxRateMethod  simpleTaxRateMethodType  1..1  (Für Abrechnungsperioden ab  01.01.2025)
 *
 * Kap. 3.2 says why: "Für die Saldosteuersatzmethode müssen für Abrechnungsperioden bis 31.12.2024
 * pro Steuersatz alle Leistungen resp. Umsätze kumulativ ausgewiesen werden. Für Abrechnungsperioden
 * ab dem 01.01.2025 muss die Kumulation pro Tätigkeit erfolgen." Hence the mandatory `activityID`.
 *
 * And Kap. 7.2 makes it a REJECTION rule rather than a preference: "Die Abrechnungsmethode wird
 * aufgrund des Vorhandenseins der folgenden Elemente gemäss Kap. 4.4 ermittelt [...] netTaxRateMethod
 * = Saldosteuersatzmethode für Abrechnungsperioden bis 31.12.2024 [...] und für Abrechnungsperioden
 * ab 01.01.2025 simpleTaxRateMethode [...] (Fehlercode „MWST-0002 ...")".
 *
 * NONE OF THIS IS IN THE XSD. The root `xs:choice` accepts all four method elements for any period,
 * so a validator cannot see a violation and neither can `xmllint`. The restriction lives only in the
 * specification prose, which is exactly why it shipped wrong: the XSD was fetched and the
 * specification document was not.
 */
const SALDO_ACTIVITY_REGIME_START = '2025-01-01';
const SALDO_ACTIVITY_REGIME_LAST_LEGACY_DAY = '2024-12-31';

/**
 * Which method element a period must be filed under. ISO days compare correctly as strings.
 *
 * A period may not straddle the boundary. Kap. 7.2 forbids changing the Abrechnungsmethode inside a
 * Steuerperiode and Art. 34 Abs. 2 MWSTG makes the calendar year the Steuerperiode, so a straddling
 * Abrechnungsperiode is not a thing that exists. Picking either element for one would file half the
 * period under a regime that did not govern it.
 */
/**
 * Kap. 7.3, MWST-0003: the permitted Abrechnungsperiode lengths, in whole months, per method.
 *
 *   "Bei Verwendung der effektiven Abrechnungsmethode beträgt die Abrechnungsperiode 3 Monate oder
 *    bei Vorhandensein einer entsprechenden Bewilligung der ESTV ein Monat resp. ein Jahr."
 *   "Bei Verwendung der Saldosteuersatzmethode beträgt die Abrechnungsperiode 6 Monate oder bei
 *    Vorhandensein einer entsprechenden Bewilligung der ESTV, ein Jahr."
 *
 * The one-month and one-year cadences need an ESTV Bewilligung that TILL cannot see, so they are
 * ACCEPTED rather than refused: the standard permits them, and refusing what the ESTV allowed would
 * be this module inventing a rule. What is refused is a length no Bewilligung can produce.
 */
const STATUTORY_PERIOD_MONTHS: Readonly<Record<'effektiv' | 'saldo', readonly number[]>> = {
  effektiv: [1, 3, 12],
  saldo: [6, 12],
};

/** Whole months between two ISO days, iff the range is exactly first-of-month to last-of-month. */
function wholeMonthSpan(periodStart: string, periodEnd: string): number | null {
  const start = new Date(`${periodStart}T00:00:00Z`);
  const end = new Date(`${periodEnd}T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  if (start.getUTCDate() !== 1) return null;
  // The last day of a month is the day before the first of the next one.
  const dayAfterEnd = new Date(end.getTime() + 86_400_000);
  if (dayAfterEnd.getUTCDate() !== 1) return null;
  const months =
    (dayAfterEnd.getUTCFullYear() - start.getUTCFullYear()) * 12 + (dayAfterEnd.getUTCMonth() - start.getUTCMonth());
  return months > 0 ? months : null;
}

/**
 * MWST-0003, as far as an ERP can honestly run it.
 *
 * What this CANNOT check, and deliberately does not guess at: whether the ESTV granted a monthly or
 * annual cadence (Kap. 7.3), whether the period is a Schlussabrechnung running to the last day of
 * liability, and whether a Jahresabstimmung matches the Steuerperiode. All three are facts about the
 * ESTV's records, not about the ledger. Kap. 7.3 permits those deviations "ausschliesslich nach
 * Vorgabe der ESTV", so the caller can assert one instead of being walled in.
 */
function periodLengthRefusal(method: string, periodStart: string, periodEnd: string): Result | null {
  const permitted = STATUTORY_PERIOD_MONTHS[method === 'saldo' ? 'saldo' : 'effektiv'];
  const months = wholeMonthSpan(periodStart, periodEnd);
  if (months !== null && permitted.includes(months)) return null;
  return err('period_length_not_statutory', {
    periodStart,
    periodEnd,
    method,
    months,
    permittedMonths: permitted,
    nextStep: `eCH-0217 Kap. 7.3 fixes the Abrechnungsperiode for this method at ${permitted.join(', ')} whole months (rejection rule MWST-0003), and this period is not one of them. Use \`vat_periods\` to get the exact boundaries of the reporting periods for the year. If the ESTV sanctioned this period (a Schlussabrechnung, or the start or end of Steuerpflicht), re-run the export with \`periodDeviationApproved: true\`.`,
  });
}

export function methodElementForPeriod(
  method: string,
  periodStart: string,
  periodEnd: string,
): { ok: true; element: MethodElement } | { ok: false; straddles: true } {
  if (method !== 'saldo') return { ok: true, element: 'effectiveReportingMethod' };
  if (periodEnd <= SALDO_ACTIVITY_REGIME_LAST_LEGACY_DAY) return { ok: true, element: 'netTaxRateMethod' };
  if (periodStart >= SALDO_ACTIVITY_REGIME_START) return { ok: true, element: 'simpleTaxRateMethod' };
  return { ok: false, straddles: true };
}

// --- Formatting ----------------------------------------------------------------------------------

/**
 * Integer Rappen to an `amountType` string, in INTEGER arithmetic.
 *
 * `(minor / 100).toFixed(2)` is the obvious version and it is a float round-trip on the money path
 * for no reason at all. This one cannot lose a Rappen to a representation error.
 */
function minorToDecimal(minor: number): string {
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  return `${sign}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** Basis points to an eCH `percentType`: 810 -> `8.10`, 260 -> `2.60`, 620 -> `6.20`. */
function rateBpToPercent(rateBp: number): string {
  const sign = rateBp < 0 ? '-' : '';
  const abs = Math.abs(rateBp);
  return `${sign}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

const escapeXml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c] as string);

// --- The document tree ---------------------------------------------------------------------------

/** A serialisable node. `prefix` is the eCH namespace prefix the element is written under. */
interface Node {
  prefix: 'eCH-0217' | 'eCH-0058';
  name: string;
  text?: string;
  children?: Node[];
}

const leaf = (name: string, text: string, prefix: Node['prefix'] = 'eCH-0217'): Node => ({ prefix, name, text });

function serialise(node: Node, depth: number): string {
  const pad = '  '.repeat(depth);
  const tag = `${node.prefix}:${node.name}`;
  if (node.children === undefined) return `${pad}<${tag}>${escapeXml(node.text ?? '')}</${tag}>\n`;
  const inner = node.children.map((c) => serialise(c, depth + 1)).join('');
  return `${pad}<${tag}>\n${inner}${pad}</${tag}>\n`;
}

// --- The mapper ----------------------------------------------------------------------------------

export interface Ech0217Identity {
  /** The UID in eCH form, `CHE` plus nine digits. `normaliseUid` produces it from the stored form. */
  uid: string;
  organisationName: string;
  /** An ISO-8601 instant. Taken from `ctx.clock`, never from the wall clock, so exports repeat. */
  generationTime: string;
  /** 1 Ersteinreichung (the default), 2 Korrekturabrechnung, 3 Jahresabstimmung. */
  typeOfSubmission?: 1 | 2 | 3;
}

/**
 * A return line as this mapper reads it: the engine's, plus the Tätigkeitscode a Saldo row carries.
 *
 * `activityId` stays OPTIONAL on the line. F11 supplies it through `saldoActivities` instead, because
 * from 01.01.2025 the accumulation is PER TÄTIGKEIT and several Tätigkeiten may share one rate and
 * therefore one Ziffer (eCH-0217 Kap. 5.3.6, MWSTV Art. 86 Abs. 3). A single `activityId` on a Ziffer
 * line cannot express that, and stamping one would silently file two Tätigkeiten under the first
 * one's code.
 */
type Ech0217Line = VatReturnLine & { activityId?: string | null };

/**
 * One Tätigkeit's turnover, as `computeVatReturn` reports it on a multi-rate Saldo return.
 *
 * TURNOVER ONLY. eCH-0217 carries no per-rate tax element, so there is nothing here for a tax figure
 * to become, and the tax is rounded once per RATE over the accumulated turnover (MWSTV Art. 84
 * Abs. 3) rather than per Tätigkeit.
 */
interface SaldoActivityTurnover {
  activityId: string;
  name: string;
  activityCode: string | null;
  rateBp: number;
  formLine: string | null;
  baseMinor: number;
}

/** The engine payload this maps. Structural only: every field is read, none is recomputed. */
interface VatReturnPayload {
  method: string;
  timing: string;
  periodStart: string;
  periodEnd: string;
  lines: Ech0217Line[];
  /** Present only on a multi-rate Saldo return computed on the MWSTV Art. 88 Abs. 1 basis. */
  saldoActivities?: SaldoActivityTurnover[];
  payableMinor: number;
  creditMinor: number;
  empty: boolean;
  /**
   * The caller asserts the ESTV sanctioned a period length Kap. 7.3 does not list by default.
   *
   * Kap. 7.3 permits deviations "ausschliesslich nach Vorgabe der ESTV (beispielsweise beim Beginn
   * oder am Ende der Steuerpflicht)". Without this the MWST-0003 check would block a legitimate
   * Schlussabrechnung, which is trading one dead end for another.
   */
  periodDeviationApproved?: boolean;
}

/**
 * Translate a `computeVatReturn` payload into an eCH-0217 document.
 *
 * Exported so the mapping table can be driven directly by tests: the forward-compatibility refusals
 * below are properties of the TABLE rather than of the workspace, and proving them through the verb
 * would need a test-only parameter on the export path. A backdoor on the money path is a second
 * code path that ships.
 */
export function mapReturnToEch0217(ret: VatReturnPayload, identity: Ech0217Identity): Result {
  if (!ECH_UID_RE.test(identity.uid)) {
    return err('invalid_company_uid', {
      uid: identity.uid,
      expected: 'CHE followed by nine digits, the first non-zero (eCH-0108 uidType)',
      nextStep: 'Correct the UID on the company profile (`update_company_profile`, format `CHE-###.###.###`), then export again.',
    });
  }
  if (!uidCheckDigitValid(identity.uid)) {
    return err('invalid_company_uid', {
      uid: identity.uid,
      reason: 'check_digit',
      expected: 'a UID whose ninth digit is the mod-11 check digit of the first eight',
      nextStep:
        'This UID has the right shape but fails its check digit, so it is not a UID the ESTV ever issued: a digit is wrong or transposed. eCH-0217 would accept it and the portal would reject the upload under MWST-0009. Correct it on the company profile (`update_company_profile`, format `CHE-###.###.###`) against the UID register at `https://www.uid.admin.ch`, then export again.',
    });
  }

  // eCH-0108 `unitNameType` is `xs:token`, so the receiving parser collapses whitespace and the ESTV
  // stores the collapsed form. Collapse here so the file says what the authority will record.
  const organisationName = collapseToken(identity.organisationName);
  if (organisationName.length < 1 || organisationName.length > ORG_NAME_MAX) {
    return err('invalid_organisation_name', {
      length: organisationName.length,
      maxLength: ORG_NAME_MAX,
      nextStep: `eCH-0217 carries the company name as \`unitNameType\`, which is between 1 and ${ORG_NAME_MAX} characters once whitespace is collapsed. This workspace's name is ${organisationName.length === 0 ? 'empty once whitespace is collapsed' : `${organisationName.length} characters`}, so the file would be rejected under MWST-0001. Set a name that fits with \`update_company_profile\` (Studio: Einstellungen, Firmenprofil), then export again.`,
    });
  }

  const periodRefusal = periodLengthRefusal(ret.method, ret.periodStart, ret.periodEnd);
  if (periodRefusal !== null && ret.periodDeviationApproved !== true) return periodRefusal;

  // WHICH METHOD ELEMENT, and it is a function of the PERIOD as well as the method. See
  // `methodElementForPeriod`: from 01.01.2025 a Saldo return is `simpleTaxRateMethod`, and filing it
  // as `netTaxRateMethod` is ESTV rejection rule MWST-0002.
  const chosen = methodElementForPeriod(ret.method, ret.periodStart, ret.periodEnd);
  if (!chosen.ok) {
    return err('period_straddles_method_change', {
      periodStart: ret.periodStart,
      periodEnd: ret.periodEnd,
      boundary: SALDO_ACTIVITY_REGIME_START,
      nextStep:
        'The Saldosteuersatzmethode changed form on 01.01.2025 (eCH-0217 Kap. 4.4), and an Abrechnungsperiode may not span the change: MWSTG Art. 34 Abs. 2 makes the calendar year the Steuerperiode. Export the part up to 31.12.2024 and the part from 01.01.2025 as separate periods, or file this period in the ESTV ePortal by hand.',
    });
  }
  const methodElement = chosen.element;

  // --- Sort every Ziffer into its block, refusing anything with nowhere to go -------------------
  const amounts = new Map<string, string>(); // element name -> formatted amount
  const perRate: {
    element: string;
    code: string;
    /** A stable secondary sort key, so two Tätigkeiten on one Ziffer emit in a fixed order. */
    order: string;
    percent: string;
    turnover: string;
    activityId?: string;
  }[] = [];

  // From 01.01.2025 the Saldo accumulation is PER TÄTIGKEIT and the ESTV's five-character
  // Tätigkeitscode is mandatory on every row (Kap. 3.2, Kap. 5.3.11, XSD
  // `activityIDTurnoverTaxRateType` minLength 5 maxLength 5). When the engine reports the per-activity
  // turnover, THOSE are the rows, and the Ziffer lines that carry the tax are skipped here: a Ziffer
  // accumulating two Tätigkeiten at one rate is one figure with two codes, and the file wants two rows.
  const saldoActivities = ret.saldoActivities ?? [];
  const perActivityRows = methodElement === 'simpleTaxRateMethod' && saldoActivities.length > 0;
  const SALDO_ZIFFERN = new Set(['322', '323', '332', '333']);
  let variousDeduction: string | null = null;
  const unmapped: string[] = [];
  const ambiguous: string[] = [];
  const wrongMethod: { code: string; element: string }[] = [];

  for (const line of ret.lines) {
    const { code } = line;
    if (DERIVED_TOTALS.has(code)) continue;

    if (code === '280') {
      variousDeduction = minorToDecimal(line.baseMinor);
      continue;
    }

    const rated = PER_RATE_BY_ZIFFER[code];
    if (rated !== undefined) {
      // The Saldo Ziffern are emitted from `saldoActivities` below when the engine reports them, so
      // the accumulated line is skipped here rather than emitted a second time under one code.
      if (perActivityRows && SALDO_ZIFFERN.has(code)) continue;
      // A per-rate element has a mandatory `taxRate` and nowhere to record "several". `rateBp` is
      // null exactly when the bucket aggregated more than one rate, and naming one of them would
      // declare a turnover that rate did not produce. ESTV cross-foots precisely that.
      if (line.rateBp === null) {
        ambiguous.push(code);
        continue;
      }
      perRate.push({
        element: rated.element,
        code,
        order: code,
        percent: rateBpToPercent(line.rateBp),
        turnover: minorToDecimal(line.baseMinor),
        ...(line.activityId === undefined || line.activityId === null ? {} : { activityId: line.activityId }),
      });
      continue;
    }

    const amount = AMOUNT_BY_ZIFFER[code];
    if (amount === undefined) {
      unmapped.push(code);
      continue;
    }
    // F2: `methods` is READ. A Ziffer whose element does not exist in the chosen method's
    // xs:sequence has nowhere to go, and the old code let it through the unmapped guard and then
    // dropped it during the build without a word. Under `simpleTaxRateMethod` that is 470 and 471;
    // under `effectiveReportingMethod` it is 470 and 471 too; under `netTaxRateMethod` it is 205 and
    // 400/405/410/415/420. Eight Ziffern, every one of them money.
    if (amount.block === 'method' && amount.methods !== undefined && !amount.methods.includes(methodElement)) {
      wrongMethod.push({ code, element: amount.element });
      continue;
    }
    amounts.set(amount.element, minorToDecimal(amount.column === 'base' ? line.baseMinor : line.taxMinor));
  }

  // One row per Tätigkeit, each carrying its own approved Saldosteuersatz and the ESTV's code. Kap.
  // 5.3.6, verbatim: "Leistung (Umsatz) und Saldo- und Pauschalsteuersatz pro Tätigkeit (bei
  // unterschiedlichen Tätigkeiten kann der gleiche Steuersatz mehrmals vorkommen)."
  // ROW ORDER, said out loud because it MOVED and a reader will otherwise assume it did not. The sort
  // key below is `${formLine}:${activityId}`, and under the Beiblatt regime every `formLine` is the
  // same Ziffer, so ordering falls through to the INTERNAL `activityId` rather than to the ESTV
  // `activityID` code the row carries. On the café fixture that emits the codes 00103, 00102, 00101,
  // which looks descending only because the internal ids sort the other way. eCH-0217 puts no
  // ordering constraint on `suppliesPerTaxRate` (`maxOccurs="100"`) and the ESTV sums the rows, so
  // this is presentation; it is recorded because a 2025+ export is NOT byte-identical to the one the
  // per-position model produced, and a spec sentence claiming it was had to be corrected.
  if (perActivityRows) {
    for (const a of saldoActivities) {
      // A Tätigkeit that produced no turnover in this period has no row to file. Emitting a zero row
      // would declare an activity the person did not carry on in the period.
      if (a.baseMinor === 0) continue;
      perRate.push({
        element: 'suppliesPerTaxRate',
        code: a.formLine ?? '323',
        order: `${a.formLine ?? '323'}:${a.activityId}`,
        percent: rateBpToPercent(a.rateBp),
        turnover: minorToDecimal(a.baseMinor),
        ...(a.activityCode === null ? {} : { activityId: a.activityCode }),
      });
    }
  }

  if (unmapped.length > 0) {
    return err('unmapped_form_line', {
      codes: unmapped.sort(),
      nextStep:
        'The return carries an ESTV Ziffer that eCH-0217 v2.0.0 has no element for, so the file would be short by that figure. File this period in the ePortal by hand and open an issue naming the Ziffer, rather than filing an incomplete return.',
    });
  }
  if (ambiguous.length > 0) {
    return err('ambiguous_rate_on_form_line', {
      codes: ambiguous.sort(),
      nextStep:
        'A per-rate Ziffer aggregated more than one tax rate, so no single rate can be declared for it. Split the postings behind that Ziffer so each carries one rate (check the tax codes on the entries the drill-down names), then export again.',
    });
  }

  if (wrongMethod.length > 0) {
    return err('form_line_not_in_method', {
      codes: wrongMethod.map((w) => w.code).sort(),
      methodElement,
      elements: wrongMethod.map((w) => w.element).sort(),
      nextStep: `The return carries an ESTV Ziffer whose eCH-0217 element does not exist under \`${methodElement}\`, the element this period must be filed with, so the file would be short by that figure. File this period in the ESTV ePortal by hand, and open an issue naming the Ziffer.`,
    });
  }

  const rateElements = perRate.filter((p) => p.element === 'suppliesPerTaxRate');

  // F4: the two-row ceiling is the PRE-2025 form, and binds only there. The ESTV paper form of that
  // era carries Ziff. 323 and 333 and no third row, and A05 hands position 3 a null form line for
  // that reason. From 01.01.2025 the accumulation is per Tätigkeit, the schema allows 100 rows, and
  // Kap. 5.3.6 says a rate may legitimately repeat: "Leistung (Umsatz) und Saldo- und
  // Pauschalsteuersatz pro Tätigkeit (bei unterschiedlichen Tätigkeiten kann der gleiche Steuersatz
  // mehrmals vorkommen)". Refusing a third row from 2025 would block a filing the regime permits.
  if (methodElement === 'netTaxRateMethod' && rateElements.length > 2) {
    return err('saldo_rates_exceed_form_lines', {
      codes: rateElements.map((p) => p.code),
      nextStep:
        'The pre-2025 ESTV MWST form carries two Saldosteuersatz rows (Ziff. 323 and 333) and no third. File this period in the ePortal by hand, and reduce the workspace to at most two Saldosteuersätze with `vat_configure` before exporting again.',
    });
  }

  // F1's remedy. From 01.01.2025 each Saldo turnover row is keyed by a five-character `activityID`
  // (XSD `activityIDTurnoverTaxRateType`, minLength 5 and maxLength 5, mandatory). That code is
  // ISSUED BY THE ESTV: Kap. 5.3.11 calls it a "5-stelliger Tätigkeitscode ersichtlich jeweils in
  // den «Subformularen» sowie unter «Abrechnungsmodalitäten» in der Applikation «Mehrwertsteuer
  // abrechnen»" and adds "Es dürfen nur bewilligte activityId übermittelt werden."
  //
  // TILL has no such code and CANNOT derive one from the ledger, so there is no honest file to
  // build. The alternatives were to invent a code (a schema-valid lie, rejected at upload under
  // MWST-0002/0008) or to keep emitting `netTaxRateMethod` (rejected under MWST-0002). A refusal
  // that names the ePortal is the only one of the three that does not waste a statutory deadline.
  // Everything below this line already emits the 2025 element correctly, so closing the data gap is
  // a deletion of this guard rather than a design.
  if (methodElement === 'simpleTaxRateMethod') {
    const missing = rateElements.filter((p) => p.activityId === undefined).map((p) => p.code);
    if (missing.length > 0) {
      return err('saldo_activity_id_required', {
        codes: missing.sort(),
        periodStart: ret.periodStart,
        periodEnd: ret.periodEnd,
        nextStep: `From 01.01.2025 a Saldo return declares its turnover per Tätigkeit, and eCH-0217 requires the ESTV's five-digit Tätigkeitscode on every row (eCH-0217 v2.0.0 Kap. 3.2 and 5.3.11). Only codes the ESTV approved may be sent, and TILL has none on file, so this period cannot be exported yet. File it in the ESTV ePortal by hand: ${ESTV_EPORTAL_URL}. The codes are listed there under «Abrechnungsmodalitäten».`,
      });
    }
  }

  // MWST-0005, Kap. 7.5: "Der steuerbare Gesamtumsatz gemäss Kap. 6.3 muss der Summe der Leistungen
  // gemäss Kap. 6.4 (Ziffern 300 - 34x) entsprechen. Dazu sind alle Beträge inkl. Zwischenschritte
  // rappengenau auf die zweite Nachkommastelle zu berechnen."
  //
  // Kap. 6.3 Tabelle 26 derives Ziffer 299 from the turnoverComputation block: totalConsideration
  // less every deduction. The right-hand side is the per-rate SUPPLY turnovers only.
  //
  // SCOPE, and it is the easy mistake here: `acquisitionTax` (Ziffern 38x) is EXCLUDED. Kap. 6.4
  // Tabelle 27 sums it alongside `suppliesPerTaxRate` for its own purposes, but the MWST-0005 rule
  // text narrows to "Ziffern 300 - 34x", and the Bezugsteuer is a separate part of the form rather
  // than Umsatz. Including it makes this check fire on correct returns.
  const declaredTurnover =
    ret.lines.find((l) => l.code === '200')?.baseMinor ??
    0;
  const deductions = ret.lines
    .filter((l) => ['220', '221', '225', '230', '235', '280'].includes(l.code))
    .reduce((a, l) => a + l.baseMinor, 0);
  const suppliesTotal = ret.lines
    .filter((l) => PER_RATE_BY_ZIFFER[l.code]?.element === 'suppliesPerTaxRate')
    .reduce((a, l) => a + l.baseMinor, 0);
  if (declaredTurnover - deductions !== suppliesTotal) {
    return err('turnover_cross_foot_failed', {
      steuerbarerGesamtumsatzMinor: declaredTurnover - deductions,
      suppliesPerTaxRateTotalMinor: suppliesTotal,
      differenceMinor: declaredTurnover - deductions - suppliesTotal,
      nextStep:
        'eCH-0217 Kap. 7.5 (rejection rule MWST-0005) requires the steuerbarer Gesamtumsatz (Ziffer 299, which the ESTV derives from Ziffer 200 less the deductions) to equal the sum of the per-rate turnovers (Ziffern 300-34x). They do not agree here, so the ESTV would reject the upload. This is an inconsistency in the computed return rather than in the file: check the tax codes on the postings in this period with the MWST-Abrechnung drill-down, and file in the ESTV ePortal by hand meanwhile.',
    });
  }

  // --- Build the document, in the schema's own sequence order -----------------------------------
  //
  // The order below IS the xs:sequence of each complexType, and it is not negotiable: an
  // xs:sequence makes position normative, so a correct figure in the wrong slot is an invalid
  // document. The `pick` helper appends only what the return actually produced, which is what the
  // minOccurs="0" on almost every element is for.
  const pick = (into: Node[], element: string): void => {
    const value = amounts.get(element);
    if (value !== undefined) into.push(leaf(element, value));
  };

  const turnover: Node[] = [];
  // `totalConsideration` is the ONE mandatory element of turnoverComputationType. computeVatReturn
  // always emits Ziffer 200 (`pushTurnover` exempts 200 and 299 from its zero-suppression), so a
  // nil return still declares 0.00 rather than omitting the element and failing validation.
  turnover.push(leaf('totalConsideration', amounts.get('totalConsideration') ?? '0.00'));
  for (const e of ['suppliesToForeignCountries', 'suppliesAbroad', 'transferNotificationProcedure', 'suppliesExemptFromTax', 'reductionOfConsideration']) {
    pick(turnover, e);
  }
  if (variousDeduction !== null) {
    turnover.push({
      prefix: 'eCH-0217',
      name: 'variousDeduction',
      children: [
        leaf('amountVariousDeduction', variousDeduction),
        // `descriptionVariousDeduction` is MANDATORY inside the type and capped at 50 characters.
        // The engine's own Ziffer 280 wording is the honest description, trimmed to the cap.
        leaf('descriptionVariousDeduction', 'Diverses (Ziff. 280)'),
      ],
    });
  }

  // Per-rate elements are emitted in ascending ZIFFER order, which is the order the ESTV form
  // prints its rows in (Normal, Reduziert, Beherbergung) with each row's two vintages adjacent.
  // Any total order would validate; a stated one makes the output byte-stable.
  const rateNodes = (element: string): Node[] =>
    perRate
      .filter((p) => p.element === element)
      .sort((a, b) => a.order.localeCompare(b.order))
      .map((p) => ({
        prefix: 'eCH-0217' as const,
        name: element,
        children: [
          // `activityID` is FIRST in `activityIDTurnoverTaxRateType`, and only `suppliesPerTaxRate`
          // under `simpleTaxRateMethod` carries it. `acquisitionTax` stays `turnoverTaxRateType`
          // under every method, so it never takes one.
          ...(element === 'suppliesPerTaxRate' && methodElement === 'simpleTaxRateMethod' && p.activityId !== undefined
            ? [leaf('activityID', p.activityId)]
            : []),
          leaf('taxRate', p.percent),
          leaf('turnover', p.turnover),
        ],
      }));

  // The AMOUNT elements each method's xs:sequence carries, IN that sequence's order, verbatim from
  // the vendored XSD. `suppliesPerTaxRate` and `acquisitionTax` are the repeated pair and are spliced
  // in at their own position below.
  const METHOD_AMOUNT_SEQUENCE: Readonly<Record<MethodElement, readonly string[]>> = {
    effectiveReportingMethod: ['inputTaxMaterialAndServices', 'inputTaxInvestments', 'subsequentInputTaxDeduction', 'inputTaxCorrections', 'inputTaxReductions'],
    netTaxRateMethod: ['compensationExport', 'deemedInputTaxDeduction'],
    simpleTaxRateMethod: ['inputTaxCorrections'],
  };

  const method: Node[] = [];
  if (methodElement === 'effectiveReportingMethod') {
    // `grossOrNet` = 1 (Netto). Not a preference: MWSTG Art. 24 makes the Entgelt exclusive of the
    // tax under effektiv, and `abrechnung.ts` adds the franc tax into Ziffer 200 ONLY under Saldo.
    // Declaring 2 (Brutto) over the same figure would understate the turnover by the whole VAT.
    method.push(leaf('grossOrNet', '1'));
    pick(method, 'opted');
  }
  method.push(...rateNodes('suppliesPerTaxRate'), ...rateNodes('acquisitionTax'));
  for (const e of METHOD_AMOUNT_SEQUENCE[methodElement]) pick(method, e);

  const flows: Node[] = [];
  for (const e of ['subsidies', 'donations']) pick(flows, e);

  // THE BACKSTOP, and the reason F2 cannot come back. Everything above decides WHERE a figure goes;
  // this asserts that every figure actually went somewhere. Without it the guarantee this module
  // rests on ("a Ziffer with no element STOPS the export") was prose: `block` was declared, never
  // read, and eight Ziffern evaporated between the mapping phase and the build phase while the
  // document stayed schema-valid and the result said `ok`.
  //
  // A refusal rather than a throw: this is the money path, and a caller on a filing deadline gets a
  // next step, not a stack trace.
  const emitted = new Set([...turnover, ...method, ...flows].map((n) => n.name));
  const dropped = [...amounts.keys()].filter((e) => !emitted.has(e));
  if (dropped.length > 0) {
    return err('mapped_amount_not_emitted', {
      elements: dropped.sort(),
      methodElement,
      nextStep:
        'A figure was mapped to an eCH-0217 element and then not written to the file, which is a defect in TILL rather than in the book. File this period in the ESTV ePortal by hand and open an issue quoting this error: the export refused rather than hand over a return that is quietly short.',
    });
  }

  const root: Node = {
    prefix: 'eCH-0217',
    name: 'VATDeclaration',
    children: [
      {
        prefix: 'eCH-0217',
        name: 'generalInformation',
        children: [
          leaf('uid', identity.uid),
          leaf('organisationName', organisationName),
          leaf('generationTime', identity.generationTime),
          leaf('reportingPeriodFrom', ret.periodStart),
          leaf('reportingPeriodTill', ret.periodEnd),
          leaf('typeOfSubmission', String(identity.typeOfSubmission ?? 1)),
          // 1 vereinbart, 2 vereinnahmt. `computeVatReturn` refuses `ist` outright, so the only
          // basis TILL can ever have computed is the agreed one. The assertion is here, next to the
          // literal, because the schema would happily accept the other value.
          leaf('formOfReporting', ret.timing === 'ist' ? '2' : '1'),
          leaf('businessReferenceId', `TILL-${identity.uid}-${ret.periodStart}-${ret.periodEnd}`),
          {
            prefix: 'eCH-0217',
            name: 'sendingApplication',
            children: [
              leaf('manufacturer', SENDING_APPLICATION.manufacturer, 'eCH-0058'),
              leaf('product', SENDING_APPLICATION.product, 'eCH-0058'),
              leaf('productVersion', SENDING_APPLICATION.productVersion, 'eCH-0058'),
            ],
          },
        ],
      },
      { prefix: 'eCH-0217', name: 'turnoverComputation', children: turnover },
      { prefix: 'eCH-0217', name: methodElement, children: method },
      // The one tax figure in the entire document. `payableMinor` and `creditMinor` are the engine's
      // Ziffern 500 and 510 and exactly one of them is ever non-zero, so their difference is the
      // signed amount without any netting being performed here.
      leaf('payableTax', minorToDecimal(ret.payableMinor - ret.creditMinor)),
    ],
  };
  if (flows.length > 0) {
    root.children!.push({ prefix: 'eCH-0217', name: 'otherFlowsOfFunds', children: flows });
  }

  const xml =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    `<eCH-0217:VATDeclaration xmlns:eCH-0217="${NS_0217}" xmlns:eCH-0058="${NS_0058}" xmlns:eCH-0108="${NS_0108}">\n` +
    root.children!.map((c) => serialise(c, 1)).join('') +
    '</eCH-0217:VATDeclaration>\n';

  return ok({ xml, nil: ret.empty });
}

// --- The verb --------------------------------------------------------------------------------------

/** `CHE-116.281.277` (the stored ESTV format) and `CHE-116.281.277 MWST` both yield `CHE116281277`. */
function normaliseUid(stored: string): string {
  return stored.replace(/\s*MWST\s*$/i, '').replace(/[-.\s]/g, '').toUpperCase();
}

export interface ExportVatReturnEch0217Input {
  periodStart: string;
  periodEnd: string;
  typeOfSubmission?: 1 | 2 | 3;
  /**
   * Assert that the ESTV sanctioned a period whose length Kap. 7.3 does not list (a Schlussabrechnung,
   * or the start or end of Steuerpflicht). NOT yet exposed on the MCP verb: `src/api/registry.ts`
   * belongs to another chain, so adding it to the tool schema is a separate, reported change.
   */
  periodDeviationApproved?: boolean;
}

/**
 * The MWST-Abrechnung for a period, as an eCH-0217 v2.0.0 file. Pure: reads, writes nothing.
 *
 * Every refusal names a NEXT STEP. A dead end on this path is worse than useless: the person is on
 * a statutory deadline, the fallback (typing the figures into the ePortal) always exists, and an
 * error that does not say so leaves them believing they are blocked when they are not.
 */
export function exportVatReturnEch0217(ctx: WorkspaceContext, input: ExportVatReturnEch0217Input): Result {
  const { periodStart, periodEnd, typeOfSubmission } = input ?? ({} as ExportVatReturnEch0217Input);

  if (typeOfSubmission !== undefined && ![1, 2, 3].includes(typeOfSubmission)) {
    return err('invalid_input', {
      field: 'typeOfSubmission',
      expected: '1 (Ersteinreichung), 2 (Korrekturabrechnung) or 3 (Jahresabstimmung)',
      nextStep: 'Omit `typeOfSubmission` for an ordinary first filing, or pass 1, 2 or 3.',
    });
  }

  // THE FIGURES COME FROM THE ENGINE, INCLUDING ITS REFUSALS. Every validity question about the
  // period, the method and the timing is already answered there, and answering any of them a second
  // time here would create a second opinion about whether a return may be filed.
  const computed = computeVatReturn(ctx, { periodStart, periodEnd });
  if (!computed.ok) return withNextStep(computed);

  const ws = ctx.store.db
    .prepare('SELECT name, uid, base_currency FROM workspace WHERE id = ?')
    .get(ctx.workspaceId) as { name: string; uid: string | null; base_currency: string } | undefined;
  if (ws === undefined) return err('not_found', { workspaceId: ctx.workspaceId, nextStep: 'Open an existing workspace, or create one with `create_workspace`, then export again.' });

  // The franc is the Landeswährung the return is denominated in, and eCH-0217 has no currency
  // element at all, so a non-CHF book would put foreign-currency figures into a franc form with
  // nothing in the document saying so. That is why this cannot be handled by labelling it.
  //
  // MWSTV Art. 45 is cited for what it ACTUALLY says. It is headed "Entgelte in ausländischer
  // Währung" and it governs per-transaction conversion: Abs. 1 requires an Entgelt in a foreign
  // currency to be converted into Landeswährung when the Steuerforderung arises, Abs. 3 prescribes
  // the ESTV's published Monatsmittelkurs or Tageskurs, and Abs. 5 requires the chosen basis to be
  // kept for at least one Steuerperiode. It does NOT state that the return is filed in francs, which
  // is what this refusal used to claim it said. The article is the right authority for the remedy,
  // so it stays and the next step now names the rate it prescribes.
  if (ws.base_currency !== 'CHF') {
    return err('unsupported_base_currency', {
      baseCurrency: ws.base_currency,
      nextStep:
        'eCH-0217 carries no currency element, so every figure in the file is read as Swiss francs and a book kept in another base currency cannot be exported. File this period in the ePortal by hand, converting each Entgelt into francs at the ESTV rate MWSTV Art. 45 Abs. 3 prescribes (the published Monatsmittelkurs or the Tageskurs for the sale of foreign currency), and keep whichever basis you choose for at least one Steuerperiode (Abs. 5).',
    });
  }

  if (ws.uid === null || ws.uid.trim() === '') {
    return err('needs_company_uid', {
      nextStep:
        "Set the company UID first: `update_company_profile` with `uid` in the ESTV format `CHE-###.###.###` (Studio: Einstellungen, Firmenprofil). eCH-0217 requires it on every declaration, so the file cannot be built without it.",
    });
  }

  // A PRE-2025 Saldo workspace with more rates approved than the form has Ziffern to carry them.
  // Counted from the APPROVAL rather than from the payload, because a third rate falling back onto
  // Ziffer 323 merges into the first one and is invisible in the computed lines.
  //
  // AND COUNTED FOR THE PERIOD, not over the table. This check used to run
  // `SELECT COUNT(*) FROM vat_saldo_rate`, which was sound only while that table held current state.
  // The moment it held an approval history the count became generations times rates, and a workspace
  // that had held exactly ONE Saldosteuersatz in every period of its life was refused with
  // `configuredRates: 3` after two ordinary ESTV re-grants, while its return stayed byte-identical.
  // The refusal then stated something untrue about the book, on a correction return the filer still
  // has to send. `generationsGoverning` is the same read `computeVatReturn` files from, so the two
  // can no longer disagree.
  //
  // Scoped to `netTaxRateMethod` (F4): from 01.01.2025 the accumulation is per Tätigkeit, the schema
  // allows 100 rows and Kap. 5.3.6 says the same rate may repeat across Tätigkeiten, so a third rate
  // is legitimate and refusing it would block a filing the regime permits.
  const periodElement = methodElementForPeriod(computed.method as string, periodStart, periodEnd);
  if (computed.method === 'saldo' && periodElement.ok && periodElement.element === 'netTaxRateMethod') {
    const governing = generationsGoverning(ctx, periodStart, periodEnd);
    const approved = governing[0]?.rates.length ?? 0;
    if (approved > 2) {
      return err('saldo_rates_exceed_form_lines', {
        configuredRates: approved,
        periodStart,
        periodEnd,
        nextStep:
          'The pre-2025 ESTV MWST form carries two Saldosteuersatz rows (Ziff. 323 and 333) and no third, so a period ending before 01.01.2025 cannot be exported while more than two Saldosteuersätze governed it. File this period in the ePortal by hand, or record what the ESTV actually approved for it with `vat_configure`.',
      });
    }
  }

  const identity: Ech0217Identity = {
    uid: normaliseUid(ws.uid),
    organisationName: ws.name,
    // The INJECTED clock, never `new Date()`: an export that answers differently on every call is
    // not a read, and the conformance gate drives every read twice and compares.
    generationTime: ctx.clock.now(),
    ...(typeOfSubmission === undefined ? {} : { typeOfSubmission }),
  };

  const mapped = mapReturnToEch0217(
    { ...(computed as unknown as VatReturnPayload), ...(input.periodDeviationApproved === true ? { periodDeviationApproved: true } : {}) },
    identity,
  );
  if (!mapped.ok) return mapped;

  const xml = mapped.xml as string;
  return ok({
    schema: { standard: 'eCH-0217', version: '2.0.0', namespace: NS_0217 },
    filename: `eCH-0217_${identity.uid}_${periodStart}_${periodEnd}.xml`,
    contentType: 'application/xml',
    xml,
    byteLength: Buffer.byteLength(xml, 'utf8'),
    method: computed.method,
    periodStart,
    periodEnd,
    typeOfSubmission: identity.typeOfSubmission ?? 1,
    nil: mapped.nil,
    // SAID, not implied. There is no ESTV submission API: this verb produces a file and a person
    // uploads it. A caller that has to infer "nothing was transmitted" from a missing field will
    // eventually infer wrong.
    transmits: false,
    upload: {
      portal: 'ESTV ePortal',
      url: ESTV_EPORTAL_URL,
      note: 'TILL erstellt die Datei. Eingereicht wird sie von einer Person im ESTV ePortal: eine Übermittlungsschnittstelle gibt es nicht.',
    },
    // The document carries no per-rate tax figure (`turnoverTaxRateType` is a bare rate/turnover
    // pair), so the ESTV RECOMPUTES the tax from the declared turnovers and compares it to
    // `payableTax`. Where the books rounded differently, that difference is real and shows up at
    // the authority rather than here, so it is reported with the file instead of being discovered
    // on submission. Diagnostic only: nothing in the XML is derived from it.
    // The second argument mirrors `mapReturnToEch0217`'s own `perActivityRows`: the recomputation has
    // to read the rows the file carries, and from 01.01.2025 those are the per-Tätigkeit rows rather
    // than the accumulated Saldo Ziffer. An empty `saldoActivities` makes it fall back on its own.
    taxCrossCheck: taxCrossCheck(
      computed as unknown as VatReturnPayload,
      periodElement.ok && periodElement.element === 'simpleTaxRateMethod',
    ),
  });
}

/**
 * The ESTV's own recomputation, run here so a mismatch is visible before the file is uploaded.
 *
 * ## Why the difference exists at all
 *
 * The file carries no per-rate TAX figure: `turnoverTaxRateType` is a bare `(taxRate, turnover)`
 * pair, so the ESTV multiplies. TILL's `payableTax` is the sum of per-invoice BOOKED tax, each
 * already rounded to the Rappen, because `abrechnung.ts` takes the ledger's figure rather than
 * arguing with it. Those two are not the same number, and the gap does not cancel: each invoice
 * contributes up to half a Rappen and they can all drift the same way.
 *
 * ## The rounding rule, and how this used to get it wrong
 *
 * Kap. 6.2.1: "Die Steuer muss auf zwei Nachkommastellen OHNE RUNDEN IN DEN ZWISCHENSCHRITTEN
 * berechnet werden. Erst am Schluss beim Element payableTax (Ziffer 500/510) kann optional auf 5
 * Rappen zu Gunsten der steuerpflichtigen Unternehmung gerundet werden". Kap. 7.5 makes it rejection
 * rule MWST-0006.
 *
 * This function used to round EACH LINE to the Rappen and sum the results, which is exactly the
 * intermediate rounding the standard forbids, so it did not model what the ESTV does and could
 * report a difference of its own making. It now accumulates the products exactly, in integer units
 * of Rappen x 10 000 (`baseMinor` is Rappen, `rateBp` is basis points), and rounds ONCE at the end.
 * No float is involved, so nothing is lost to representation.
 *
 * ## This DIAGNOSES, it does not correct
 *
 * Kap. 6.2.1 also says whose job the correction is: "Eine allfällige Differenz [...] muss entweder
 * im ERP-System automatisiert (im Zuge der MWST-Abrechnungserstellung) oder mittels manueller
 * Buchungen bereinigt werden." Whether TILL books that adjustment, and against which account, is an
 * open decision for the owner and is NOT implemented here. What is implemented is a correct,
 * exhaustively tested measurement, so that either answer is cheap to reach from here.
 */
function taxCrossCheck(
  ret: VatReturnPayload,
  perActivityRows: boolean,
): {
  recomputedTaxMinor: number;
  engineTaxMinor: number;
  differenceMinor: number;
  /** True when the two agree exactly, so a caller does not have to compare numbers to find out. */
  reconciled: boolean;
} {
  // RECOMPUTE FROM THE ROWS THE FILE ACTUALLY CARRIES, which is what the ESTV multiplies. When the
  // export emits per-Tätigkeit rows it SKIPS the accumulated Saldo Ziffer (see `perActivityRows`
  // above), so reading the rate off that Ziffer is reading a figure that is not on the wire.
  //
  // Under the Beiblatt regime (A07 §3.1a, periods from 01.01.2025) one Ziffer carries every approved
  // Saldosteuersatz, so its own `rateBp` is null and the old `rateBp === null` skip silently dropped
  // the entire Saldo turnover from the recomputation: `recomputedTaxMinor` came back 0 against a real
  // `engineTaxMinor`, reporting an enormous fictitious MWST-0006 difference on a correct file.
  //
  // For a pre-2025 return this is arithmetically identical to the old path and not merely close:
  // the activity rows partition the Ziffer's base at one rate per row, and `a*r + b*r = (a+b)*r`
  // exactly in integers, with no rounding anywhere in the accumulation.
  const saldoActivities = perActivityRows ? (ret.saldoActivities ?? []) : [];
  const carriedByActivityRows = new Set(
    saldoActivities.map((a) => a.formLine).filter((c): c is string => typeof c === 'string'),
  );

  // Units: Rappen x 10 000. Exact, because both factors are integers.
  let scaled = 0;
  for (const line of ret.lines) {
    if (PER_RATE_BY_ZIFFER[line.code] === undefined) continue;
    if (carriedByActivityRows.has(line.code)) continue;
    if (line.rateBp === null) continue;
    scaled += line.baseMinor * line.rateBp;
  }
  for (const a of saldoActivities) {
    if (a.formLine === null) continue;
    scaled += a.baseMinor * a.rateBp;
  }
  // One rounding, at the end, half away from zero.
  const sign = scaled < 0 ? -1 : 1;
  const recomputed = sign * Math.floor((Math.abs(scaled) + 5000) / 10000);

  const engineTax = ret.lines
    .filter((l) => PER_RATE_BY_ZIFFER[l.code] !== undefined)
    .reduce((a, l) => a + l.taxMinor, 0);
  return {
    recomputedTaxMinor: recomputed,
    engineTaxMinor: engineTax,
    differenceMinor: recomputed - engineTax,
    reconciled: recomputed === engineTax,
  };
}

/**
 * Add a NEXT STEP to a refusal the engine raised, without touching its code or its detail.
 *
 * The code stays byte-identical so a client that already branches on `needs_vat_config` keeps
 * working; what is added is the sentence that turns a diagnosis into an instruction. The engine's
 * own refusals carry a `hint` that DESCRIBES the problem (`A07 currently computes the vereinbarte
 * (Soll) basis only`), which is not the same thing as telling a person on a filing deadline what to
 * do in the next five minutes.
 */
function withNextStep(refusal: Result): Result {
  const nextStep = NEXT_STEP_BY_ERROR[refusal.error as string] ?? DEFAULT_NEXT_STEP;
  return { ...refusal, nextStep };
}

const DEFAULT_NEXT_STEP =
  'The return could not be computed, so there is nothing to export. Resolve the reason above, or file this period in the ESTV ePortal by hand: the figures are on the MWST-Abrechnung screen.';

const NEXT_STEP_BY_ERROR: Readonly<Record<string, string>> = {
  needs_vat_config:
    'Configure MWST first: `set_vat_method` with the method (effektiv or saldo) and the timing (soll or ist) the ESTV granted this business (Studio: Einstellungen, MWST). Nothing can be computed or exported until then.',
  unsupported:
    'This workspace files on vereinnahmte Entgelte (Ist). A07 computes the vereinbarte (Soll) basis only, and handing an Ist filer Soll figures would produce a file that looks right and is not. Either file this period in the ESTV ePortal by hand, or, if the ESTV granted this business the vereinbarte basis, correct it with `set_vat_method` (vatAccounting: soll).',
  saldo_activity_split_required:
    'A workspace with two Saldosteuersätze must apportion its turnover per business activity (MWSTV Art. 86/88) before a return can be computed, and no tax code carries an activity yet. File this period in the ESTV ePortal by hand, where the split is entered directly.',
  // NOT `set_vat_method`. That verb updates two columns, `vat_method` and `vat_accounting`, and
  // takes neither `asOf` nor rates: an agent following the old wording would pass `asOf`, have it
  // silently ignored, get `{ok: true}`, re-export and hit this identical refusal. `vat_configure` is
  // the verb that accepts both. A refusal naming a remedy that cannot perform it is a dead end
  // dressed as an instruction.
  saldo_rate_not_valid_for_period:
    'The configured Saldosteuersatz is not on the ESTV ladder in force for this period, so the rate that governed it cannot be recovered. Reconfigure with `vat_configure`, passing `saldoRates` and an `asOf` inside the reported period (`set_vat_method` cannot do this: it sets only the method and the timing). Or file this period from the rate the ESTV granted for it.',
  invalid_input:
    'The period is not a pair of ISO days (YYYY-MM-DD). Pass the first and last day of the reporting period, inclusive; `vat_periods` lists this year’s periods with their exact boundaries.',
  invalid_period:
    'The period runs backwards. Pass `periodStart` as the FIRST day and `periodEnd` as the LAST day of the reporting period; `vat_periods` lists this year’s periods with their exact boundaries.',
};
