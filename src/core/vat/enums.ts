/**
 * A05 owns the single tax enumeration point (§H-ENUM). Every later spec (A06/A07/A17/A22) adds codes
 * HERE, never forks the enum. Rates are basis points (integer), never float.
 *
 * VERIFIED (docs/planning/statutory-verification.md, owner decisions 2026-07-16) against the official
 * ESTV Abrechnungsformulare (effektiv 0550-03, Saldo 0553-03) and SR 641.202.62. The former flags are
 * lifted:
 *
 *  1. `ESTV_SALDO_RATES_BP` is now the authoritative 2024 ladder and a HARD allow-list `configureVat`
 *     enforces (a rate off the ladder is rejected).
 *  2. The output/Bezug/Saldo `formLine` Ziffern carry the corrected 2024+ vintage (303/313/343/383 and
 *     Saldo 323/333). The trailing digit encodes the rate era: 1 = pre-2018, 2 = 2018-2023 (old rates
 *     7.7/2.5/3.7 pair to 302/312/342/382 and Saldo 322/332), 3 = from 2024. The 400/405/220/230
 *     Vorsteuer/Export/Ausgenommen lines are period-stable and unchanged.
 */

import { currentVatRates } from './rateEras.js';

export const VAT_METHODS: ReadonlySet<string> = new Set(['effektiv', 'saldo', 'none']);
export const VAT_TIMINGS: ReadonlySet<string> = new Set(['ist', 'soll']);

/**
 * Tax-code kinds, the single source A06 (`stamp trace`) and A07 (`read trace`) branch on. `output` and
 * `input` are the ordinary VAT sides; `reverse_charge` is Bezugsteuer (Art. 45, owed AND deductible);
 * `import` is Einfuhrsteuer (Art. 50, deductible input paid at the border); `zero` is echt befreit
 * (Art. 23, 0% with input preserved); `exempt` is ausgenommen (Art. 21, no output tax AND no input
 * deduction); `none` is a line that bears no VAT.
 *
 * (Note: §6b's Fixed list names five kinds and omits `zero`/`exempt`, but US-A05.1's seed and §6's
 * `vat.code.kind.zero`/`.exempt` i18n keys both require them, so the authoritative enum carries all
 * seven. Surfaced to the owner as a spec-internal inconsistency resolved in favour of the seed.)
 */
export const TAX_CODE_KINDS: ReadonlySet<string> = new Set([
  'output',
  'input',
  'reverse_charge',
  'import',
  'zero',
  'exempt',
  'none',
]);

/**
 * The Normalsatz of the CURRENT era, in basis points (MWSTG Art. 25). A saldo rate cannot exceed it.
 *
 * DERIVED from `VAT_RATE_ERAS`, never an independent literal: the Swiss rates move (7.7 until
 * 31.12.2023, 8.1 from 1.1.2024), and a bare constant silently mis-computes every correction return
 * for a pre-2024 period. Anything reasoning about a SPECIFIC PERIOD must call `normalRateBpOn(date)`
 * instead of reading this: this value is only the current era's rate.
 */
export const NORMAL_RATE_BP: number = currentVatRates().normalBp;

/**
 * The Saldosteuersatz ladder of the CURRENT era, in basis points (SR 641.202.62): 0.1, 0.6, 1.3, 2.1,
 * 3.0, 3.7, 4.5, 5.3, 6.2, 6.8 %. The HARD allow-list `configureVat` validates each configured rate
 * against when no period date is supplied (owner decision 2026-07-16, statutory-verification.md).
 *
 * The ladder itself was REBASED in the septennial review (SR 641.202.62, rebased by AS 2023 18 with
 * effect from 1.1.2024) and is therefore era-dependent in principle AND in fact: the pre-2024 ladder
 * was 0.1/0.6/1.2/2.0/2.8/3.5/4.3/5.1/5.9/6.5 %, differing on six of the ten rungs. VERIFIED against
 * the fedlex version of SR 641.202.62 in force 1.1.2018. Use `saldoLadderOn(date)` for a historical
 * period; this export is a view onto the current era, kept for call sites that mean "today".
 */
export const ESTV_SALDO_RATES_BP: ReadonlySet<number> = new Set(currentVatRates().saldoLadderBp);

export interface SeedTaxCode {
  code: string;
  kind: string;
  rateBp: number;
  formLine: string;
  label: string;
}

/**
 * The default Swiss tax-code set (US-A05.1), seeded idempotently. Rates from MWSTG Art. 25 (8.1 / 2.6 /
 * 3.8 from 1.1.2024). Input codes carry rate 0 because the input rate is whatever a vendor charged
 * (resolved per line by A06, not fixed by the code). The `formLine` Ziffern are the VERIFIED 2024+
 * vintage from ESTV forms 0550/0553 (303/313/343 output, 383 Bezug); the old-rate codes (7.7/2.5/3.7)
 * a workspace adds for legacy periods pair to 302/312/342/382 instead (see the module header era map).
 */
export const DEFAULT_TAX_CODES: readonly SeedTaxCode[] = [
  { code: 'UST81', kind: 'output', rateBp: 810, formLine: '303', label: 'Umsatzsteuer 8.1% (Normalsatz)' },
  { code: 'UST26', kind: 'output', rateBp: 260, formLine: '313', label: 'Umsatzsteuer 2.6% (reduziert)' },
  { code: 'UST38', kind: 'output', rateBp: 380, formLine: '343', label: 'Umsatzsteuer 3.8% (Beherbergung)' },
  { code: 'VST-M', kind: 'input', rateBp: 0, formLine: '400', label: 'Vorsteuer Material, Waren, Dienstleistungen' },
  { code: 'VST-I', kind: 'input', rateBp: 0, formLine: '405', label: 'Vorsteuer Investitionen und übriger Betriebsaufwand' },
  { code: 'EXPORT0', kind: 'zero', rateBp: 0, formLine: '220', label: 'Export, echt befreit (Art. 23)' },
  { code: 'AUSGENOMMEN', kind: 'exempt', rateBp: 0, formLine: '230', label: 'Von der Steuer ausgenommen (Art. 21)' },
  { code: 'BEZUG', kind: 'reverse_charge', rateBp: 810, formLine: '383', label: 'Bezugsteuer (Art. 45)' },
  { code: 'IMPORT', kind: 'import', rateBp: 0, formLine: '400', label: 'Einfuhrsteuer (Art. 50)' },
];
