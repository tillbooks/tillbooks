/**
 * A07, the MWST-Abrechnung: the ESTV VAT return as a pure read model over the journal.
 *
 * A07 NEVER POSTS (P3 by absence) and persists no return. The figures are recomputed from source on
 * every call, so they can never drift from the ledger; the only row this capability ever writes is
 * A03's `period_lock`, and it writes that through A03's own verb rather than with a statement of its
 * own.
 *
 * ## The internal model is rate-agnostic. Ziffern are a print concern.
 *
 * We read the eCH-0217 v2.0.0 XSD: `turnoverTaxRateType` is a bare `(taxRate, turnover)` pair and
 * THERE IS NO ZIFFER ANYWHERE IN THE SCHEMA. So the computation below groups by `(formLine, rate,
 * kind)` tuples and the Ziffer is a LABEL attached at the end. Two consequences worth stating: the
 * 2024 renumbering is a non-event for the XML path, and a future rate (the 8.5% the 2026-11-29
 * referendum would bring from 2028) needs no model change at all, only a new versioned rate row.
 *
 * ## Both Ziffer vintages stay live, and the form itself says so
 *
 * ESTV form DM_0550_03 / 01.24 prints the current AND the legacy tax-calculation block side by side,
 * as two columns headed "ab 01.01.2024" and "bis 31.12.2023":
 *
 *   Normal      303  8,1%   |  302  7,7%
 *   Reduziert   313  2,6%   |  312  2,5%
 *   Beherbergung 343 3,8%   |  342  3,7%
 *   Bezugsteuer 383         |  382
 *
 * and form DM_0536_04 / 01.24 does the same for Saldo (1. Satz 323 | 322, 2. Satz 333 | 332).
 *
 * PROVENANCE, CORRECTED against the primary source. `DM_0550_03` is NOT the periodic return, and an
 * earlier version of this docblock and of the test header said it was. Its own title line reads
 * `Jahresabstimmung (Berichtigungsabrechnung nach Art. 72 MWSTG, effektive Methode)`, under
 * `In dieser Abrechnung sind nur die Differenzen zu den bisher eingereichten Abrechnungen zu
 * deklarieren.`; the Saldo counterpart cited here is `Korrekturabrechnung (Saldosteuersatz /
 * Pauschalsteuersatz)`, `DM_0536_04 / 01.24`. (An earlier pass dismissed `DM_0553_03` as "a third
 * document again". It is not: its own PDF title is `Jahresabstimmung (Berichtigungsabrechnung nach
 * Art. 72 MWSTG, Saldosteuersatz / Pauschalsteuersatz)`, the exact Saldo counterpart of 0550_03, so
 * A05's `config.ts` citing it for 323/333 is sound. None of the three is the PERIODIC return, which
 * is the only claim that ever mattered here.) Nothing computes wrong from the mix-up, because these
 * forms carry the same Ziffern the
 * periodic return does, and that is exactly what let it survive: a citation that happens to give the
 * right answer is still one nobody can follow back.
 *
 * Fetched 2026-07-25 from `estv2.admin.ch/mwst/formulare/`, which serves the PDFs directly. The
 * `www.estv.admin.ch/dam/...` mirrors 502 and the fedlex form pages are JS-gated, which is where
 * earlier passes stalled.
 *
 * That the two vintages both stay live is not an inference from the form id: a Berichtigungsabrechnung
 * under Art. 72 for a closed pre-2024 period declares on the legacy numbers, so both sets must stay
 * addressable indefinitely. The vintage is chosen by the PERIOD BEING REPORTED and, per line, by the
 * SUPPLY DATE, never by today's date, and the selection itself is not reimplemented here: it is
 * `resolveTax`'s existing era mapping (P6, the single branch point).
 *
 * ## The franc figure is READ from the books, never recomputed by multiplication
 *
 * An MWST-Abrechnung is filed in francs (MWSTV Art. 45). The VAT trace on a journal line
 * (`tax_base_minor` / `tax_amount_minor`) stays in the TRANSACTION currency by design, while
 * `base_debit_minor` / `base_credit_minor` hold what the books are actually kept in. For a
 * base-currency entry the two are the same integer and the trace IS the franc figure. For a foreign
 * one they are not, and the franc tax is taken from the BOOKED movement on the VAT account rather
 * than from `taxAmount * rate`: `applyFx` rounds once per side on the side TOTAL and allocates back
 * by largest remainder, so a per-figure product is a second opinion about the ledger's rounding that
 * is free to disagree, and on a real two-rate EUR invoice it does, by a Rappen
 * (test/sales/document-base-vat.test.mjs posts the witness). A read model that disagrees with the
 * books is worse than one that stays silent.
 *
 * ## The 2200 reconciliation is a DRIFT CHECK on the TOTAL, and it proves less than it looks
 *
 * The 2200 rows carry no `tax_code`, deliberately: the tag rides the BASE line whose booked amount
 * is the tax base, because a tax amount is not recoverable back to a base (applyVat.ts states the
 * convention and A02's post-boundary gate enforces it). So 2200 cannot be attributed to a Ziffer and
 * cannot be the per-line source. It is still the right thing to compare the TOTAL against.
 *
 * WHAT IT CATCHES: a 2200 movement that no tagged line explains. A manual journal posted straight at
 * the liability account with no tax code moves the account without moving any Ziffer, and that is a
 * real and ordinary defect. Under Saldo the flat-rate figure is unrelated to 2200 by construction
 * (Art. 37), so the check reports itself not applicable rather than failing.
 *
 * WHAT IT CANNOT CATCH, stated plainly because this docblock used to oversell it. Under effektiv the
 * comparison is close to an arithmetic IDENTITY: the allocation below distributes each entry's own
 * booked 2200 movement over that entry's tagged lines, so the parts sum to the booked total BY
 * CONSTRUCTION. Everything internal to that distribution is invisible to it. All four of these were
 * real defects in this file, and every one of them returned `reconciled: true`:
 *
 *   - a Ziffer rendered TWICE, so a consumer keying by Ziffer saw half the Vorsteuer;
 *   - two rate VINTAGES merged into one line, so a Ziffer declared a turnover its own rate does not
 *     produce (ESTV cross-foots exactly that);
 *   - a SIGN inverted between two lines of one entry, tax declared positive on negative turnover;
 *   - a Saldosteuersatz applied to a period whose ESTV ladder never offered it.
 *
 * A green reconciliation is evidence about the total and about nothing else. The per-Ziffer
 * assertions in test/vat/abrechnung.test.mjs are what carry the rest, and they read the figures back
 * out of SQLite rather than comparing the return against the fixture that produced it.
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { resolveTax } from './resolveTax.js';
import { effectiveRateBp } from './applyVat.js';
import { isValidRateDate, saldoLadderOn, vatRatesOn } from './rateEras.js';
import {
  electedDeclarationBasis,
  generationsGoverning,
  methodOn,
  methodsGoverning,
  saldoDeclarationRegimeForPeriod,
  SALDO_PER_POSITION_LAST_DAY,
} from './saldoGenerations.js';
// A03's lock verb, imported from the LEAF module rather than from `../ledger/index.js`. The index
// re-exports `postEntry`, which imports `computeLineTax` from this package, so importing the index
// here would close a cycle. `ledger/periods.ts` imports nothing from `core/vat`, so this edge is
// one-directional and stays that way.
import { lockPeriod } from '../ledger/periods.js';
import { vatBridgeOf } from './bridge.js';

/**
 * The output VAT account (Umsatzsteuer) and the two Vorsteuer accounts, by KMU number.
 * EXPORTED as A07's single source: G11's `vat_balance_at_cutover` control reads these rather than
 * restating the numbers, which is also what keeps G10's locale fence honest (no Swiss account
 * number may live under `src/core/migration/` outside the ch locale pack).
 */
export const OUTPUT_VAT_ACCOUNT = '2200';
export const INPUT_VAT_ACCOUNTS: readonly string[] = ['1170', '1171'];

const ISO_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The ESTV Ziffer labels, VERBATIM from the forms. de-CH: real umlauts, no sharp-s.
 *
 * SOURCES, fetched and text-extracted 2026-07-25:
 *   `DM_0550_03 / 01.24` (effektiv), estv2.admin.ch/mwst/formulare/mwst-form-0550-03-2024-de.pdf
 *   `DM_0536_04 / 01.24` (Saldo/Pauschal), estv2.admin.ch/mwst/formulare/mwst-form-0536-04-2024-de.pdf
 *
 * PROVENANCE, CORRECTED. These are NOT the periodic returns, and this file used to say they were.
 * 0550 is headed `Jahresabstimmung (Berichtigungsabrechnung nach Art. 72 MWSTG, effektive Methode)`
 * and carries `In dieser Abrechnung sind nur die Differenzen zu den bisher eingereichten
 * Abrechnungen zu deklarieren.`; 0536 is `Korrekturabrechnung (Saldosteuersatz /
 * Pauschalsteuersatz)`. The Ziffern are the same set the periodic return uses, so nothing computed
 * wrong, which is exactly what let the mis-citation survive. The `www.estv.admin.ch/dam/...` mirrors
 * of both 502, and the periodic-form pages are JS-gated; `estv2.admin.ch` serves them directly.
 *
 * THE TWO FORMS DO NOT AGREE ON EVERY LABEL, so there are two maps. Ziffer 200 gains `inkl. optierte
 * Leistungen` under effektiv, 280 gains `Ankaufspreise Margenbesteuerung`, 205 exists only under
 * effektiv, and 479 is a DIFFERENT FIGURE on each: `Total Ziff. 400 bis 420` (the Vorsteuer total)
 * under effektiv, `Total Ziff. 470 bis 471` (Steueranrechnung) under Saldo, where the form carries
 * no Vorsteuer total at all (Art. 37). Rendering one form's wording on the other is a small lie
 * printed beside a figure a person signs, so `formLineLabel` picks by method.
 *
 * The two exceptions to "verbatim", both stated rather than silently normalised:
 *   - 399 reads `Total geschuldete Steuer (Ziff. 302 bis 383)` on 0550 and `(Ziff. 322 bis 383)` on
 *     0536. The parenthetical is dropped, because it names the range of the form it came from.
 *   - the per-rate lines (302/303/312/313/342/343/322/323/332/333) carry no sentence on the form at
 *     all: the rate lives in a column header (`ab 01.01.2024` / `bis 31.12.2023`) and the row is
 *     labelled `Normal` / `Reduziert` / `Beherbergung` / `1. Satz` / `2. Satz`. The labels below
 *     fold the column into the row, which is what a single-column read model needs.
 *
 * THESE MAPS ARE THE FORM, NOT THE ENGINE'S OUTPUT, and the two are deliberately different sizes.
 * `computeVatReturn` can currently produce 200 / 220 / 230 / 289 / 299, the per-rate output pairs,
 * the Bezugsteuer and Saldo pairs, 400 and 405. The rest are on the paper form and unreachable from
 * a journal line today: 205 and 221 need an Art. 22 option / place-of-supply flag no tax code
 * carries, 225 needs the Meldeverfahren, 235 needs discounts (unimplemented, see
 * `src/core/sales/document.ts`), 280 needs Margenbesteuerung, 410/415/420 are PERIOD-LEVEL Vorsteuer
 * corrections that no per-line P6 result can express (A05's own header says so), 470/471 are
 * Steueranrechnungen claimed on separate ESTV forms, and 900/910 are non-consideration cash flows
 * the ledger does not tag.
 *
 * They are KEPT rather than pruned, because a GUI rendering the real form needs every box labelled
 * even where TILL contributes nothing to it, and a filer looking at an empty 415 has learned
 * something true. Pruning would turn "TILL cannot compute this line" into "this line does not
 * exist". The distinction is documented here rather than encoded, since nothing branches on a label.
 */
export const ESTV_FORM_LINE_LABELS: Readonly<Record<string, string>> = {
  '200': 'Total der vereinbarten bzw. vereinnahmten Entgelte, inkl. optierte Leistungen, Entgelte aus Übertragungen im Meldeverfahren sowie aus Leistungen im Ausland (weltweiter Umsatz)',
  '205': 'In Ziffer 200 enthaltene Entgelte aus von der Steuer ausgenommenen Leistungen (Art. 21), für welche nach Art. 22 optiert wird',
  '220': 'Von der Steuer befreite Leistungen (u.a. Exporte, Art. 23), von der Steuer befreite Leistungen an begünstigte Einrichtungen und Personen (Art. 107 Abs. 1 Bst. a)',
  '221': 'Leistungen im Ausland (Ort der Leistung im Ausland)',
  '225': 'Übertragung im Meldeverfahren (Art. 38, bitte zusätzlich Form. 764 einreichen)',
  '230': 'Von der Steuer ausgenommene Inlandleistungen (Art. 21), für die nicht nach Art. 22 optiert wird',
  '235': 'Entgeltsminderungen wie Skonti, Rabatte usw.',
  '280': 'Diverses (z.B. Wert des Bodens, Ankaufspreise Margenbesteuerung)',
  '289': 'Total Ziff. 220 bis 280',
  '299': 'Steuerbarer Gesamtumsatz (Ziff. 200 abzüglich Ziff. 289)',
  '302': 'Normal 7,7% (bis 31.12.2023)',
  '303': 'Normal 8,1% (ab 01.01.2024)',
  '312': 'Reduziert 2,5% (bis 31.12.2023)',
  '313': 'Reduziert 2,6% (ab 01.01.2024)',
  '342': 'Beherbergung 3,7% (bis 31.12.2023)',
  '343': 'Beherbergung 3,8% (ab 01.01.2024)',
  '382': 'Bezugsteuer (bis 31.12.2023)',
  '383': 'Bezugsteuer (ab 01.01.2024)',
  // The Saldo Ziffern. 322/323 are the two rate ERAS and, from 01.01.2025, the only two the form has:
  // MWST-Info 12 Ziff. 18.1.4 labels them "Leistungen bis 31.12.2023" and "Leistungen ab 01.01.2024"
  // with no "(1. Satz)" qualifier, because every approved Saldosteuersatz declares on them and the
  // split lives in the Beiblatt. 332/333 are the abolished 2. Satz rows of the pre-2025 form, kept
  // addressable because a Berichtigungsabrechnung for such a period still declares on them (A07 §3.1a).
  '322': 'Saldosteuersatz Leistungen bis 31.12.2023',
  '323': 'Saldosteuersatz Leistungen ab 01.01.2024',
  '332': 'Saldosteuersatz 2. Satz, Leistungen bis 31.12.2023 (Formular bis 31.12.2024)',
  '333': 'Saldosteuersatz 2. Satz, Leistungen ab 01.01.2024 (Formular bis 31.12.2024)',
  '399': 'Total geschuldete Steuer',
  '400': 'Vorsteuer auf Material- und Dienstleistungsaufwand',
  '405': 'Vorsteuer auf Investitionen und übrigem Betriebsaufwand',
  '410': 'Einlageentsteuerung (Art. 32, bitte detaillierte Aufstellung beilegen)',
  '415': 'Vorsteuerkorrekturen: gemischte Verwendung (Art. 30), Eigenverbrauch (Art. 31)',
  '420': 'Vorsteuerkürzungen: Nicht-Entgelte wie Subventionen, Tourismusabgaben (Art. 33 Abs. 2)',
  '479': 'Total Ziff. 400 bis 420',
  '500': 'Zu bezahlender Betrag',
  '510': 'Guthaben der steuerpflichtigen Person',
  '900': 'Andere Mittelflüsse (Art. 18 Abs. 2): Subventionen, durch Kurvereine eingenommene Tourismusabgaben, Entsorgungs- und Wasserwerkbeiträge (Bst. a-c)',
  '910': 'Andere Mittelflüsse (Art. 18 Abs. 2): Spenden, Dividenden, Schadenersatz usw. (Bst. d-l)',
};

/**
 * The lines the SALDO form words differently, or carries and the effektiv form does not. Everything
 * absent here is identical on both, so this is an override layer rather than a second full copy: a
 * second copy would drift, and a drifted label on a tax form is exactly what F8 was about.
 */
export const ESTV_FORM_LINE_LABELS_SALDO: Readonly<Record<string, string>> = {
  '200': 'Total der vereinbarten bzw. vereinnahmten Entgelte, inkl. Entgelte aus Übertragungen im Meldeverfahren sowie aus Leistungen im Ausland (weltweiter Umsatz)',
  '280': 'Diverses (z.B. Wert des Bodens)',
  '470': 'Steueranrechnung gemäss Formular Nr. 1050',
  '471': 'Steueranrechnung gemäss Formular Nr. 1055, 1056',
  // NOT the Vorsteuer total. The Saldo form has none (Art. 37); this 479 is the Steueranrechnung.
  '479': 'Total Ziff. 470 bis 471',
};

/** The label for a Ziffer under the method being filed, or the bare code when the form has none. */
export function formLineLabel(code: string, saldo: boolean): string {
  if (saldo) {
    const override = ESTV_FORM_LINE_LABELS_SALDO[code];
    if (override !== undefined) return override;
  }
  return ESTV_FORM_LINE_LABELS[code] ?? code;
}

/** Round half-away-from-zero, exact in integer arithmetic (Pattern P2). */
function roundHalfAwayFromZero(numer: number, denom: number): number {
  const sign = numer < 0 ? -1 : 1;
  const a = Math.abs(numer);
  return sign * Math.floor((a + Math.trunc(denom / 2)) / denom);
}

/** One line of the rendered return. `entryIds` is the drill-down (P5). */
export interface VatReturnLine {
  /** The ESTV Ziffer. */
  code: string;
  label: string;
  /** The Leistungen / Umsatz column, integer Rappen in the BASE currency. */
  baseMinor: number;
  /** The Steuer column, integer Rappen in the BASE currency. */
  taxMinor: number;
  /** The statutory rate in basis points, or null for a turnover-only line. */
  rateBp: number | null;
  /** The `tax_code.kind` the line aggregates, or null for a derived total. */
  kind: string | null;
  entryIds: string[];
}

export interface ComputeVatReturnInput {
  periodStart: string;
  periodEnd: string;
}

interface TaggedRow {
  entry_id: string;
  /**
   * The account the tagged line books to: under Saldo, the ERTRAGSKONTO that carries the turnover.
   *
   * It is on the tagged line and not somewhere else because of a convention A02's post-boundary gate
   * already enforces: the tax code rides the BASE line whose booked amount is the tax base, never the
   * 2200 line, since a tax amount is not recoverable back to a base. So the line that says how much
   * turnover there was is also the line that says which account it landed on, and MWSTV Art. 84
   * Abs. 3's "separat verbuchen" is discharged by the chart rather than by a second tag.
   */
  account_id: string;
  account_number: string;
  account_name: string;
  date: string;
  /** The Leistungsdatum stamped on the line, or null when the entry date governs. */
  supply_date: string | null;
  currency: string;
  tax_code: string;
  tax_base_minor: number | null;
  tax_amount_minor: number | null;
  base_debit_minor: number;
  base_credit_minor: number;
  debit_minor: number;
  credit_minor: number;
}

/**
 * An accumulator for ONE Ziffer.
 *
 * THE ZIFFER IS THE KEY, and nothing else may join it. A form line is a BOX on a paper return: the
 * ESTV receives one figure per Ziffer, so a return that renders the same Ziffer twice is not a
 * detailed return, it is an ambiguous one. Every consumer resolves a Ziffer by `.find()` (the GUI
 * form-line table, the drill-down, this repo's own `ziff()` test helper), so the second occurrence
 * is simply invisible and its money silently leaves the form.
 *
 * The bucket used to key on `(code, rate, kind)`, which reads like extra fidelity and is actually
 * the defect: two different kinds legitimately report on ONE Ziffer. Ordinary Vorsteuer (`input`,
 * stored rate 0) and the deduction leg of Bezugsteuer (`reverse_charge`, rate 810) both claim on
 * Ziffer 400, because the form gives the Bezugsteuer deduction no line of its own. They landed in
 * separate buckets, both rendered, and a consumer keying by Ziffer under-reported Vorsteuer by the
 * whole Bezugsteuer leg while Ziffer 479 (the total) still read correctly: a return whose parts do
 * not add up to its own total.
 *
 * `rateBp` and `kind` survive as REPORTED METADATA rather than as identity: a single contributing
 * value is reported, a mixture reports null. Null is the honest answer for a box that aggregates
 * two rates, and it is the same null the derived turnover lines already carry.
 */
interface Bucket {
  code: string;
  baseMinor: number;
  taxMinor: number;
  /** Every rate that contributed, so the rendered line names one only when it is unambiguous. */
  rateBps: Set<number>;
  /** Every `tax_code.kind` that contributed, same rule. */
  kinds: Set<string>;
  entryIds: Set<string>;
}

function bucketOf(map: Map<string, Bucket>, code: string): Bucket {
  let b = map.get(code);
  if (b === undefined) {
    b = { code, baseMinor: 0, taxMinor: 0, rateBps: new Set(), kinds: new Set(), entryIds: new Set() };
    map.set(code, b);
  }
  return b;
}

/** Add one resolved line's figures to its Ziffer. */
function accumulate(b: Bucket, rateBp: number, kind: string, baseMinor: number, taxMinor: number, entryId: string): void {
  b.baseMinor += baseMinor;
  b.taxMinor += taxMinor;
  b.rateBps.add(rateBp);
  b.kinds.add(kind);
  b.entryIds.add(entryId);
}

/** The single contributing value, or null when the box aggregates more than one. */
function soleOf<T>(values: Set<T>): T | null {
  return values.size === 1 ? ([...values][0] as T) : null;
}

/**
 * The base-currency VAT movement each entry actually booked, keyed by entry id.
 *
 * Output side is the net CREDIT on 2200; input side is the net DEBIT on 1170/1171. Both are read as
 * credits-net-of-debits (output) and debits-net-of-credits (input) so a reversal, which mirrors the
 * entry with every leg flipped, subtracts rather than adding a second time with the wrong sign.
 */
function bookedVatByEntry(
  ctx: WorkspaceContext,
  periodStart: string,
  periodEnd: string,
): Map<string, { output: number; input: number }> {
  const rows = ctx.store.db
    .prepare(
      `SELECT e.id AS entry_id,
              COALESCE(SUM(CASE WHEN a.number = ?
                                THEN l.base_credit_minor - l.base_debit_minor ELSE 0 END), 0) AS output_minor,
              COALESCE(SUM(CASE WHEN a.number IN (?, ?)
                                THEN l.base_debit_minor - l.base_credit_minor ELSE 0 END), 0) AS input_minor
         FROM journal_entry e
         JOIN journal_line l ON l.entry_id = e.id
         JOIN account a ON a.id = l.account_id
        WHERE e.workspace_id = ? AND e.status = 'posted' AND e.date >= ? AND e.date <= ?
        GROUP BY e.id`,
    )
    .all(
      OUTPUT_VAT_ACCOUNT,
      INPUT_VAT_ACCOUNTS[0],
      INPUT_VAT_ACCOUNTS[1],
      ctx.workspaceId,
      periodStart,
      periodEnd,
    ) as { entry_id: string; output_minor: number; input_minor: number }[];

  const map = new Map<string, { output: number; input: number }>();
  for (const r of rows) map.set(r.entry_id, { output: r.output_minor, input: r.input_minor });
  return map;
}

/**
 * Split `total` over `weights` by LARGEST REMAINDER, so the parts sum to `total` exactly.
 *
 * This is the same allocation `applyFx` uses when it pushes a once-rounded side total back over the
 * lines, and it is used for the same reason: the whole must equal the booked figure, and the only
 * question is which line absorbs the odd Rappen. With a single weight it is the identity, which is
 * the overwhelmingly common case (one tagged line per side per entry).
 *
 * THE WEIGHTS ARE SIGNED, and that is load-bearing rather than incidental. The call sites used to
 * pass `Math.abs(txTax)`, which is total-preserving (the parts still sum to `total`) and therefore
 * invisible to every total-level check, including the 2200 reconciliation. On an entry carrying tax
 * of BOTH signs, a sale beside a rebate line at another rate, it splits the NET booked total over
 * ABSOLUTE weights: measured, a CHF 10'000 sale at 8.1% next to a CHF -3'000 rebate at 2.6% put
 * 66'770 on Ziffer 303 instead of 81'000, and put +6'430 of tax on Ziffer 313 against NEGATIVE
 * turnover. Two wrong signable figures whose sum is right.
 *
 * With signed weights the exact parts are `total * w_i / sum(w)`, which for a base-currency entry
 * (where the booked total IS the trace total) is the identity per line, sign included, and for a
 * foreign one is the ledger's own once-rounded figure spread the same way `applyFx` spread it.
 * `Math.floor` on a negative exact still yields a fraction in [0, 1), so the remainder stays
 * non-negative and the distribution loop is unchanged.
 *
 * When the weights cancel exactly (`sum === 0`) there is no proportion to allocate by. Every part is
 * zero, which is right whenever `total` is zero too and is otherwise reported as DRIFT by the 2200
 * reconciliation rather than papered over with a guess.
 */
function allocateByLargestRemainder(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum === 0) return weights.map(() => 0);
  const exact = weights.map((w) => (total * w) / sum);
  const floors = exact.map((x) => Math.floor(x));
  let remainder = total - floors.reduce((a, b) => a + b, 0);
  const order = exact
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  const out = floors.slice();
  for (const { i } of order) {
    if (remainder <= 0) break;
    out[i] = (out[i] as number) + 1;
    remainder -= 1;
  }
  return out;
}

/**
 * The MWST-Abrechnung for a period. Pure: reads the journal, writes nothing.
 *
 * `periodStart`/`periodEnd` are inclusive ISO days. The method (effektiv/saldo) and timing
 * (ist/soll) come from A05 config and are never parameters here: MWSTG Art. 37/39 make them a
 * property of the taxable person, not of the return.
 */
export function computeVatReturn(ctx: WorkspaceContext, input: ComputeVatReturnInput): Result {
  const { periodStart, periodEnd } = input ?? ({} as ComputeVatReturnInput);
  // A malformed date is a structured rejection, never a silently coerced range: a coerced period
  // picks the wrong Ziffer vintage and the wrong set of entries without telling anyone.
  if (typeof periodStart !== 'string' || !ISO_DAY_RE.test(periodStart) || !isValidRateDate(periodStart)) {
    return err('invalid_input', { field: 'periodStart', expected: 'YYYY-MM-DD' });
  }
  if (typeof periodEnd !== 'string' || !ISO_DAY_RE.test(periodEnd) || !isValidRateDate(periodEnd)) {
    return err('invalid_input', { field: 'periodEnd', expected: 'YYYY-MM-DD' });
  }
  if (periodEnd < periodStart) {
    return err('invalid_period', { periodStart, periodEnd, reason: 'periodEnd precedes periodStart' });
  }

  // THE METHOD THAT GOVERNED THE PERIOD, not the one configured today.
  //
  // MWSTG Art. 37 Abs. 4 lets a filer leave the Saldosteuersatzmethode at the start of a
  // Steuerperiode ("Wechsel sind jeweils auf Beginn einer Steuerperiode möglich"). Read off the
  // workspace row, as this did until F11, every earlier Saldo period silently recomputed under the
  // new regime: measured on a one-supply book, a filed CHF 67.02 became CHF 81.00, on a different
  // Ziffer, with nothing refusing, warning or recording which figure had been filed. On a real book
  // the error runs the other way and is unbounded, because effektiv deducts input tax and Saldo does
  // not.
  //
  // It also decides which of the two branches below runs at all, which is why versioning the RATES
  // and leaving the method undated preserved the approval history and made it unreachable.
  const eras = methodsGoverning(ctx, periodStart, periodEnd);
  if (eras.length > 1) {
    // No single figure is correct for a period spanning two tax regimes, and picking an end would
    // produce a signable one. The two halves are each filable on their own.
    return err('period_straddles_method_change', {
      periodStart,
      periodEnd,
      methods: eras.map((e) => ({
        method: e.method,
        timing: e.timing,
        validFrom: e.validFrom,
        validTo: e.validTo,
      })),
      reason:
        'The Abrechnungsmethode changed inside this period, and the two halves are computed under different tax regimes (MWSTG Art. 36/37).',
      hint: `File the part up to ${eras[0]!.validTo ?? periodEnd} and the part from the day after as separate periods. A method change takes effect at the start of a Steuerperiode (MWSTG Art. 37 Abs. 4), so a statutory quarter or half-year never spans one.`,
    });
  }
  const era = eras[0]!;
  const method = era.method;
  const timing = era.timing;
  // P9: an unconfigured workspace gets the SAME code the GUI's banner-CTA and `resolveTax` branch
  // on, so the agent and the human share one code path into A05's setup.
  if (method !== 'effektiv' && method !== 'saldo') {
    return err('needs_vat_config', { method });
  }

  // IST TIMING IS NOT IMPLEMENTED, AND SAYS SO.
  //
  // Under vereinnahmte Entgelte (MWSTG Art. 39 Abs. 2) a supply enters the period it was PAID in,
  // not the period it was invoiced in, so the selection below (which keys on the entry date) is the
  // Soll rule and computes a figure an Ist filer must not file. A14 stores the seam this needs,
  // `payment_allocation.recognized_at` with its own `tax_base_minor` / `tax_amount_minor`, but the
  // allocation names a DOCUMENT rather than a tax code, so attributing it to a Ziffer still needs a
  // per-code split for documents carrying more than one rate.
  //
  // Returning the Soll figures here would hand an Ist filer a wrong return that looks right, which
  // on this path is the worst available outcome: it is a number they would sign. So the verb
  // refuses and names what is missing.
  if (timing === 'ist') {
    return err('unsupported', {
      timing: 'ist',
      reason: 'ist_timing_not_implemented',
      hint: 'Vereinnahmte Entgelte (MWSTG Art. 39 Abs. 2) recognise VAT on payment. A07 currently computes the vereinbarte (Soll) basis only.',
    });
  }

  const saldo = method === 'saldo';

  // The Ziffer vintage of the period being reported, used for the report-level label and for the
  // Saldo lines (whose Ziffer comes from A05 config rather than from a per-line tax code).
  const periodEra = vatRatesOn(periodStart);
  const vintage = periodEra !== null && periodEra.effectiveFrom >= '2024-01-01' ? 'current' : 'legacy';
  const eraDigit = vintage === 'current' ? '3' : '2';

  // §H-TENANT on every read: the workspace is on the ENTRY, which is the row that carries it.
  const rows = ctx.store.db
    .prepare(
      `SELECT e.id AS entry_id, e.date AS date, l.supply_date AS supply_date,
              l.currency AS currency, l.tax_code AS tax_code,
              l.account_id AS account_id, a.number AS account_number, a.name AS account_name,
              l.tax_base_minor, l.tax_amount_minor, l.base_debit_minor, l.base_credit_minor,
              l.debit_minor, l.credit_minor
         FROM journal_entry e
         JOIN journal_line l ON l.entry_id = e.id
         JOIN account a ON a.id = l.account_id AND a.workspace_id = e.workspace_id
        WHERE e.workspace_id = ? AND e.status = 'posted'
          AND e.date >= ? AND e.date <= ? AND l.tax_code IS NOT NULL
        ORDER BY e.date, e.id`,
    )
    .all(ctx.workspaceId, periodStart, periodEnd) as TaggedRow[];

  const booked = bookedVatByEntry(ctx, periodStart, periodEnd);

  // --- Franc tax per tagged line -------------------------------------------------------------
  //
  // Group the tagged lines by entry and side, then hand each side the base-currency figure the
  // entry actually booked on its VAT account. For a base-currency entry that figure equals the sum
  // of the transaction traces and the allocation is the identity; for a foreign one it is the
  // ledger's own converted, once-rounded number, which is the figure a return is filed on.
  interface Resolved {
    row: TaggedRow;
    kind: string;
    formLine: string | null;
    rateBp: number;
    deductible: boolean;
    /** Signed transaction tax on the line's natural side. */
    txTax: number;
    /** Signed base-currency turnover (the Leistungen column) for this line. */
    baseTurnover: number;
    /** Signed base-currency tax, filled by the allocation below. */
    francTax: number;
  }

  const resolvedRows: Resolved[] = [];
  for (const row of rows) {
    // THE SUPPLY DATE GOVERNS THE ZIFFER VINTAGE, and it is READ, not assumed.
    //
    // A06 §3 prices a line at the rate in force on the LEISTUNGSDATUM, and `journal_line.supply_date`
    // now stores the date it priced at. A07 resolves the Ziffer from that same date, so the two
    // halves of a straddle agree: a supply dated 20.12.2023 invoiced 15.01.2024 carries tax computed
    // at 7.7% and reports on the legacy Ziffer 302, inside a 2024 return, which is exactly what the
    // ESTV form's two side-by-side columns ("ab 01.01.2024" / "bis 31.12.2023") are FOR.
    //
    // Read off the entry date instead, as this did until the column existed, the line was not merely
    // mislabelled: it was ABSORBED. It resolved to 303, merged with the genuine 8.1% turnover, and
    // Ziffer 302 never appeared at all, leaving 303 declaring a turnover its own rate does not
    // produce. ESTV cross-foots that. Measured on the fixture below: a CHF 40.00 unexplained gap,
    // reported as `reconciled: true`, because the 2200 total was right the whole time.
    //
    // NULL means the entry date governs, which is the ordinary same-period booking and every row
    // written before the column existed. It is a FALLBACK, never a guess: those rows genuinely
    // carry no other date, and using the entry date reproduces exactly the figure they were filed
    // with.
    const supplyDate = row.supply_date ?? row.date;
    const r = resolveTax(ctx, { taxCode: row.tax_code, supplyDate });
    if (!r.ok) return r;
    const kind = r.kind as string;
    if (kind === 'none') continue;

    const txTax = row.tax_amount_minor ?? 0;
    // The Leistungen column is the line's own BASE movement, signed on its natural side. Output and
    // the zero/exempt turnover kinds are credit-natural; input, import and Bezugsteuer are
    // debit-natural (the expense they sit on is a debit).
    const creditNatural = kind === 'output' || kind === 'zero' || kind === 'exempt';
    const baseTurnover = creditNatural
      ? row.base_credit_minor - row.base_debit_minor
      : row.base_debit_minor - row.base_credit_minor;

    resolvedRows.push({
      row,
      kind,
      formLine: (r.formLine as string | null) ?? null,
      // The rate the line was PRICED at, not the one its code stores. On a straddle those differ:
      // the stored 810 prices a 2023 supply at 770, and a Ziffer 302 line headed "Normal 7,7%"
      // reporting a rateBp of 810 is a return arguing with itself.
      rateBp: effectiveRateBp(kind, r.rateBp as number, supplyDate),
      deductible: r.deductible as boolean,
      txTax,
      baseTurnover,
      francTax: 0,
    });
  }

  // Allocate the booked franc VAT over each entry's tagged lines, per side.
  const OUTPUT_KINDS = new Set(['output', 'reverse_charge']);
  const INPUT_KINDS = new Set(['input', 'import', 'reverse_charge']);
  const byEntry = new Map<string, Resolved[]>();
  for (const r of resolvedRows) {
    const list = byEntry.get(r.row.entry_id);
    if (list === undefined) byEntry.set(r.row.entry_id, [r]);
    else list.push(r);
  }
  /** The deducted franc input tax per resolved row, parallel to `francTax` on the output side. */
  const francInput = new Map<Resolved, number>();
  for (const [entryId, list] of byEntry) {
    const bookedEntry = booked.get(entryId) ?? { output: 0, input: 0 };

    // SIGNED weights, never absolute ones: a credit-note or rebate leg inside the same entry carries
    // negative tax, and its sign has to survive into the Ziffer it reports on.
    const outs = list.filter((r) => OUTPUT_KINDS.has(r.kind));
    const outAlloc = allocateByLargestRemainder(bookedEntry.output, outs.map((r) => r.txTax));
    outs.forEach((r, i) => {
      r.francTax = outAlloc[i] as number;
    });

    // Only the DEDUCTIBLE input kinds book to 1170/1171 (Art. 37 folds the rest into the expense),
    // so only those share the booked input movement.
    //
    // `r.deductible` is REDUNDANT today and stays as a statement of intent, which is worth saying
    // out loud because a mutation test will find it unfalsifiable. Under effektiv `deductible` is
    // true for every one of INPUT_KINDS, so it selects nothing extra; under Saldo it is false for
    // all of them, but the result is never read (the bucket loop returns at the saldo branch) and
    // the booked input movement is zero regardless, because no 1170/1171 leg is written. Removing it
    // would be behaviour-identical and would leave the deduction rule expressed nowhere.
    const ins = list.filter((r) => INPUT_KINDS.has(r.kind) && r.deductible);
    const inAlloc = allocateByLargestRemainder(bookedEntry.input, ins.map((r) => r.txTax));
    ins.forEach((r, i) => {
      francInput.set(r, inAlloc[i] as number);
    });
  }

  // --- Bucket into Ziffern ---------------------------------------------------------------------
  const outputBuckets = new Map<string, Bucket>();
  const inputBuckets = new Map<string, Bucket>();
  let worldwideTurnover = 0; // Ziffer 200
  let exemptTurnover = 0; //    Ziffer 230
  let zeroTurnover = 0; //      Ziffer 220
  const turnoverEntries = new Set<string>();

  for (const r of resolvedRows) {
    const { kind, formLine } = r;

    // Ziffer 200 is the worldwide turnover: every supply, taxable or not. Under Saldo the ESTV
    // declares the GROSS (the flat rate is applied to the consideration including VAT); under
    // effektiv the Entgelt is exclusive of the tax (MWSTG Art. 24).
    if (kind === 'output' || kind === 'zero' || kind === 'exempt') {
      worldwideTurnover += r.baseTurnover + (saldo ? r.francTax : 0);
      turnoverEntries.add(r.row.entry_id);
      if (kind === 'zero') zeroTurnover += r.baseTurnover;
      if (kind === 'exempt') exemptTurnover += r.baseTurnover;
    }

    if (saldo) {
      // Art. 37: no per-rate output Ziffer and no input deduction. The whole taxable turnover is
      // taxed at the workspace's Saldosteuersatz below, so nothing accumulates here except
      // Bezugsteuer, which stays owed under Saldo (MWSTV Art. 91: the flat rate imputes the input
      // tax, so it is owed but not reclaimable).
      if (kind === 'reverse_charge' && formLine !== null) {
        accumulate(bucketOf(outputBuckets, formLine), r.rateBp, kind, r.baseTurnover, r.francTax, r.row.entry_id);
      }
      continue;
    }

    // Effektiv. An output line reports its tax on its per-rate Ziffer (303/313/343, or the legacy
    // 302/312/342 for a pre-2024 period). Bezugsteuer reports OWED on 383/382 and, when deductible,
    // its matching deduction on the Vorsteuer Ziffer: `sign:'both'` in P6 means exactly this pair.
    if (OUTPUT_KINDS.has(kind) && formLine !== null) {
      accumulate(bucketOf(outputBuckets, formLine), r.rateBp, kind, r.baseTurnover, r.francTax, r.row.entry_id);
    }

    const deducted = francInput.get(r);
    if (deducted !== undefined && deducted !== 0) {
      // Bezugsteuer's deduction leg has no Ziffer of its own on the form: it is claimed with the
      // ordinary Vorsteuer. 400 is the default; a code that reports on 405 (Investitionen) keeps it.
      // It therefore SHARES Ziffer 400 with ordinary Vorsteuer, which is why the bucket keys on the
      // Ziffer alone (see `Bucket`): keyed any wider, 400 renders twice and the first one wins.
      const inputLine = kind === 'reverse_charge' ? '400' : (formLine ?? '400');
      accumulate(bucketOf(inputBuckets, inputLine), r.rateBp, kind, r.baseTurnover, deducted, r.row.entry_id);
    }
  }

  // --- Saldo: gross turnover per Tätigkeit, times the Saldosteuersatz approved for it ------------
  //
  // MWSTV Art. 88 Abs. 1: "Die Umsätze aus Tätigkeiten der steuerpflichtigen Person, der mehr als ein
  // Saldosteuersatz bewilligt worden ist, sind zum bewilligten Saldosteuersatz zu versteuern, der für
  // die betreffende Tätigkeit festgelegt ist." Art. 84 Abs. 3 obliges the filer to book the Erträge
  // separately per RATE, which is the accumulation below: several Tätigkeiten may share one rate
  // (Art. 86 Abs. 3 and Abs. 4 both say so), and they report on one Ziffer as one figure.
  //
  // NEVER PER TÄTIGKEIT, and since the F11 critic pass, not per rate either: ONE round over the
  // whole Saldo tax, at the single point the rates are applied (P2). The three differ. On the
  // fixture in test/vat/saldo-multirate.test.mjs, two Tätigkeiten at 6.2% carrying 1'340'440 and
  // 216'200 Rappen give round(1'556'640 * 620 / 10'000) = 96'512 accumulated, against
  // 83'107 + 13'404 = 96'511 rounded separately.
  //
  // Art. 84 Abs. 3 is why the per-TÄTIGKEIT figure is wrong: it obliges the filer to book the
  // Erträge separately per RATE, so the accumulation is per rate. It is NOT why the per-rate
  // ROUNDING would be right, and it used to be cited for that too. It is a bookkeeping rule about
  // the Erträge and it is silent on rounding the tax. eCH-0217 Kap. 6.2.1 is the rule that speaks,
  // and it forbids rounding in the intermediate steps. See the allocation below.
  const saldoActivityLines: {
    activityId: string;
    name: string;
    activityCode: string | null;
    position: number;
    rateBp: number;
    formLine: string | null;
    baseMinor: number;
  }[] = [];
  let saldoDeclarationBasis: string | null = null;

  if (saldo) {
    const generations = generationsGoverning(ctx, periodStart, periodEnd);
    if (generations.length === 0) {
      return err('needs_vat_config', { method, reason: 'saldo method with no Saldosteuersatz configured' });
    }
    if (generations.length > 1) {
      // Two ESTV approvals govern parts of this period, so there is no single set of rates to file
      // it under. The previous engine could not see this at all: the rates were current config with
      // no date, so a mid-year Neuzuteilung left nothing behind saying the first half was different.
      return err('saldo_rates_changed_within_period', {
        periodStart,
        periodEnd,
        generations: generations.map((g) => ({
          validFrom: g.validFrom,
          validTo: g.validTo,
          ratesBp: g.rates.map((r) => r.rateBp),
        })),
        reason:
          'The ESTV approved different Saldosteuersätze inside this period, so no single set of rates governs it.',
        hint: `File the part up to ${generations[0]!.validTo ?? periodEnd} and the part from the day after as separate periods, which is what the Abrechnung the ESTV expects looks like after a Neuzuteilung (MWSTV Art. 84 Abs. 2).`,
      });
    }
    const generation = generations[0]!;
    const rates = generation.rates.map((r) => ({
      position: r.position,
      rate_bp: r.rateBp,
      form_line: r.formLine,
    }));
    if (rates.length === 0) {
      return err('needs_vat_config', { method, reason: 'saldo method with no Saldosteuersatz configured' });
    }

    // The ESTV ladder (SR 641.202.62) was rebased with effect 1.1.2024 and differs from the 2018 one
    // on six of its ten rungs, so a rate that is lawful today is frequently not one that existed for
    // a pre-2024 period. Checked against the period being reported, for every approved rate, before
    // anything is attributed: filing 6.2% on a 2023 correction return is not an approximation, it is
    // a rate the law did not offer.
    const ladder = saldoLadderOn(periodStart);
    if (ladder !== null) {
      const offLadder = rates.filter((r) => !ladder.has(r.rate_bp));
      if (offLadder.length > 0) {
        return err('saldo_rate_not_valid_for_period', {
          rateBp: offLadder[0]!.rate_bp,
          ratesBp: offLadder.map((r) => r.rate_bp),
          periodStart,
          periodEnd,
          validFrom: generation.validFrom,
          ladderBp: [...ladder].sort((a, b) => a - b),
          reason:
            'An approved Saldosteuersatz is not on the ESTV ladder (SR 641.202.62) in force for the period being reported.',
          hint: 'Record what the ESTV granted for THIS period with `vat_configure`, passing `saldoRates` and an `asOf` inside it, or file the period from the rate the ESTV granted for it.',
        });
      }
    }

    // --- Which Ziffer model the REPORTED PERIOD files under (A07 §3.1a) --------------------------
    //
    // Up to 31.12.2024 the ESTV form numbered a Saldo row per (rate position x rate era) and stopped
    // at two positions. From 01.01.2025 the position dimension is gone: MWST-Info 12 Ziff. 18.1.4
    // defines only "Ziffer 322: Leistungen bis 31.12.2023 / Ziffer 323: Leistungen ab 01.01.2024",
    // and "Die Deklaration erfolgt über das Beiblatt zu den Ziffern 322 und 323, in welchem das
    // Entgelt - sofern die ESTV mehrere SSS bewilligt hat - auf die verschiedenen SSS aufzuteilen
    // ist." Ziffern 332 and 333 appear nowhere in that edition, and the publication's own Beispiel 2
    // is a two-rate filer (4,5% and 1,3%) declaring under Ziffer 323 alone.
    //
    // So this is chosen by the period and never by today, exactly like the rate-era vintage above: a
    // Berichtigungsabrechnung for S2/2024 filed in 2027 still declares on the 2024 form.
    const regime = saldoDeclarationRegimeForPeriod(periodStart, periodEnd);
    if (regime === null) {
      // The period crosses 31.12.2024, so half of it files on a form with a Ziffer per rate position
      // and half on a form without one. There is no single answer and picking either silently prints
      // one half under the other's rules. `methodElementForPeriod` already refuses the same span at
      // the export; this is the return agreeing with it instead of showing a figure nothing can file.
      return err('saldo_period_straddles_form_change', {
        periodStart,
        periodEnd,
        boundary: SALDO_PER_POSITION_LAST_DAY,
        reason:
          'This period spans 31.12.2024, and the ESTV changed the Saldo part of the MWST form on 01.01.2025: up to that day it numbers a Ziffer per approved rate, from it a single Ziffer per rate era with the split carried in the Beiblatt. A period lying across the change has no one form to report on.',
        hint: 'Report the statutory half-years either side of the change separately (`vat_periods` gives their exact boundaries). eCH-0217 Kap. 7.3 fixes the Saldo Abrechnungsperiode at six whole months, so a span across 31.12.2024 is not a filable period in any case.',
      });
    }

    // The Ziffer a rate declares on. Under `beiblatt` every approved rate shares one, so the buckets
    // below collapse into it by construction and the per-rate split lives in `saldoActivityLines`,
    // which IS the Beiblatt. `32` is the only Saldo prefix the current form has; the stored `33`
    // prefix is the abolished 2. Satz row and is read only for a pre-2025 period.
    //
    // THE LAST DIGIT IS THE PERIOD'S RATE ERA, NOT THE LINE'S, and the guard directly below is what
    // stops that being a silent wrong answer. See `saldo_turnover_spans_rate_eras`.
    const saldoZiffer = (storedFormLine: string | null): string | null => {
      if (regime === 'beiblatt') return '32' + eraDigit;
      return storedFormLine === null ? null : storedFormLine.slice(0, 2) + eraDigit;
    };

    // --- The Saldo Ziffer follows the LEISTUNGSDATUM, so cross-era turnover cannot be accumulated --
    //
    // MWST-Info 12 Ziff. 18.1.4 is explicit that the era is chosen by the supply, not the invoice:
    // "Bei einer Anpassung der gesetzlichen Steuersätze sind weder das Datum der Rechnungsstellung
    // noch der Zahlung für die Beurteilung relevant, welcher Steuersatz zur Anwendung gelangt,
    // sondern der Zeitpunkt respektive der Zeitraum der Leistungserbringung." The effektiv path
    // already honours that, per LINE, and says so where it reads `supply_date`.
    //
    // The Saldo path cannot, because its taxable base is a PERIOD-LEVEL aggregate: the flat rate is
    // applied to the whole gross turnover, not to individual lines, so there is one `eraDigit` for
    // the period and one Ziffer for all of it. Measured by the critic: a supply dated 15.12.2023
    // posted into a 2026 period declared on 323 rather than 322.
    //
    // AND UNDER SALDO THAT IS A FIGURE ERROR, not only a label one. The Saldosteuersatz LADDER was
    // rebased with effect 01.01.2024 (SR 641.202.62) and six of its ten rungs moved, so a supply from
    // the older era is owed at the rate the ESTV approved for THAT era. Accumulating it with current
    // turnover taxes it at the wrong rate as well as printing it in the wrong box.
    //
    // Refusing is this engine's established answer to exactly this shape: `saldo_rates_changed_within_period`
    // already refuses a period two approvals govern rather than picking one of them. Computing the
    // split properly needs per-era accumulation of the taxable base AND a decision about how one
    // Tätigkeit spanning two eras appears in the Beiblatt, where eCH-0217 Kap. 5.3.6 admits a
    // repeated rate only across DIFFERENT Tätigkeiten. That is a design change, not a patch, so what
    // ships here is the refusal that makes the wrong figure unreachable.
    if (regime === 'beiblatt') {
      const eras = new Set<string>();
      for (const r of resolvedRows) {
        if (r.kind !== 'output' && r.kind !== 'zero' && r.kind !== 'exempt') continue;
        const era = vatRatesOn(r.row.supply_date ?? r.row.date);
        if (era !== null) eras.add(era.effectiveFrom);
      }
      const periodFrom = periodEra?.effectiveFrom ?? null;
      const foreign = [...eras].filter((e) => e !== periodFrom).sort();
      if (foreign.length > 0) {
        return err('saldo_turnover_spans_rate_eras', {
          periodStart,
          periodEnd,
          periodRateEraFrom: periodFrom,
          turnoverRateErasFrom: [...eras].sort(),
          foreignRateErasFrom: foreign,
          reason:
            'This period carries turnover whose Leistungsdatum falls in a different statutory rate era than the period itself, and under the Saldosteuersatzmethode the flat rate is applied to the whole gross turnover at once, so TILL cannot split it onto the era Ziffern (322 and 323) or tax each part at the Saldosteuersatz its own era carried.',
          hint: 'Report the period that the turnover belongs to, or correct the Leistungsdatum on the entries the drill-down names when it was recorded wrongly. A Saldo return that mixes rate eras has to be filed in the ESTV ePortal by hand, where the Beiblatt to Ziffern 322 und 323 takes the split.',
        });
      }
    }

    // MWSTV Art. 88 Abs. 6, the voluntary simplification, elected per Steuerperiode. It is read here
    // and never assumed: an engine that applied it on its own would be raising a person's tax bill.
    const basis = electedDeclarationBasis(ctx, periodStart.slice(0, 4));
    saldoDeclarationBasis = basis ?? 'per_activity';

    // The taxable turnover is the worldwide turnover less the exempt and zero-rated supplies. Under
    // Saldo the flat rate applies to the consideration INCLUDING tax (MWSTG Art. 37 Abs. 2), which is
    // why `worldwideTurnover` already carries the franc tax on this branch.
    const taxableGross = worldwideTurnover - exemptTurnover - zeroTurnover;

    if (basis === 'highest_rate') {
      // "Die steuerpflichtige Person kann den gesamten Umsatz aus steuerbaren Leistungen freiwillig
      // zum höchsten bewilligten Saldosteuersatz abrechnen." Everything on one Ziffer, and no
      // attribution is needed at all: the whole point of the election is that the split stops
      // mattering. That also makes it the lawful way out of a third approved rate the current ESTV
      // form has no Ziffer for.
      const highest = rates.reduce((a, b) => (b.rate_bp > a.rate_bp ? b : a));
      const saldoTax = roundHalfAwayFromZero(taxableGross * highest.rate_bp, 10000);
      // Under `beiblatt` this is '32' + era whichever position the highest rate sits at, which is the
      // point: electing Abs. 6 never needed a second Ziffer, and before this it borrowed 333 from the
      // highest rate's position whenever that position was 2.
      const code = saldoZiffer(highest.form_line) ?? '32' + eraDigit;
      const b = bucketOf(outputBuckets, code);
      b.baseMinor += taxableGross;
      b.taxMinor += saldoTax;
      b.rateBps.add(highest.rate_bp);
      b.kinds.add('output');
      for (const id of turnoverEntries) b.entryIds.add(id);

      // THE ELECTION STILL HAS TO BE FILEABLE, and it was not. Leaving `saldoActivityLines` empty
      // here made `ech0217.ts` fall back to the accumulated Ziffer line, which carries no
      // `activityId`, so from 01.01.2025 the export refused every Abs. 6 period with
      // `saldo_activity_id_required` even when the ESTV Tätigkeitscodes were all on file. The engine
      // was recommending Abs. 6 as the way out of `saldo_form_line_missing` and then refusing to
      // export the result: one refusal traded for another, with a higher tax bill in between.
      //
      // ONE ROW, because that is what the election means: "den gesamten Umsatz aus steuerbaren
      // Leistungen freiwillig zum höchsten bewilligten Saldosteuersatz abrechnen" (MWSTV Art. 88
      // Abs. 6). The whole taxable turnover, one rate, and no attribution at all, which is the point
      // of electing it. Declared under a Tätigkeit the ESTV approved AT that highest rate, because
      // eCH-0217 Kap. 5.3.11 admits only approved codes.
      //
      // Where several Tätigkeiten share the highest rate the first one approved at it carries the
      // row. That is a choice, and it is safe to make because it moves no money: the rate and the
      // turnover on the wire are identical whichever of them is named, and each is equally
      // `bewilligt`. A workspace with NO Tätigkeit recorded still has no code TILL may invent, so it
      // still refuses at the export, which is the honest answer rather than a schema-valid lie.
      const declaring = generation.activities.find((a) => a.position === highest.position);
      if (declaring !== undefined) {
        saldoActivityLines.push({
          activityId: declaring.activityId,
          name: declaring.name,
          activityCode: declaring.activityCode,
          position: declaring.position,
          rateBp: highest.rate_bp,
          formLine: code,
          baseMinor: taxableGross,
        });
      }
    } else if (rates.length === 1 && generation.activities.length === 0) {
      // ONE approved rate and no Tätigkeit recorded. Art. 84 Abs. 3 obliges separate bookkeeping only
      // for a person "denen mehrere Saldosteuersätze bewilligt wurden", so a single-rate filer owes no
      // mapping and must not be refused for want of one. This is the shape every Saldo workspace had
      // before F11 and it keeps computing exactly as it did.
      const rate = rates[0]!;
      const saldoTax = roundHalfAwayFromZero(taxableGross * rate.rate_bp, 10000);
      // Position 1 gives the `32` prefix under both regimes, so this branch is unchanged by the
      // remodelling. It is routed through the helper anyway so there is ONE place the Ziffer is minted.
      const b = bucketOf(outputBuckets, saldoZiffer(rate.form_line) ?? '32' + eraDigit);
      b.baseMinor += taxableGross;
      b.taxMinor += saldoTax;
      b.rateBps.add(rate.rate_bp);
      b.kinds.add('output');
      for (const id of turnoverEntries) b.entryIds.add(id);
    } else {
      // --- Art. 84 Abs. 3, discharged through the chart ------------------------------------------
      const activityOfAccount = new Map<string, string>();
      for (const a of generation.activities) {
        for (const account of a.accounts) activityOfAccount.set(account.accountId, a.activityId);
      }

      const grossByActivity = new Map<string, number>();
      const unmapped = new Map<string, { accountId: string; number: string; name: string; grossMinor: number }>();
      for (const r of resolvedRows) {
        if (r.kind !== 'output') continue;
        const gross = r.baseTurnover + r.francTax;
        const activityId = activityOfAccount.get(r.row.account_id);
        if (activityId === undefined) {
          const seen = unmapped.get(r.row.account_id);
          if (seen === undefined) {
            unmapped.set(r.row.account_id, {
              accountId: r.row.account_id,
              number: r.row.account_number,
              name: r.row.account_name,
              grossMinor: gross,
            });
          } else {
            seen.grossMinor += gross;
          }
          continue;
        }
        grossByActivity.set(activityId, (grossByActivity.get(activityId) ?? 0) + gross);
      }

      if (unmapped.size > 0) {
        // NO GUESS IS AVAILABLE HERE, and every plausible one is worse than the refusal. Attributing
        // the turnover to the first rate, the highest rate, or the largest activity all put taxable
        // turnover on a Saldosteuersatz the ESTV never granted for it, which is precisely what
        // Art. 88 Abs. 1 forbids. The refusal names the accounts, so the remedy is one edit away.
        //
        // AND ART. 88 ABS. 2 IS NOT THE ANSWER TO IT, though it looks like one. Fetched: "Wurde für
        // eine Tätigkeit der dafür festgelegte Saldosteuersatz nicht bewilligt, so sind die damit
        // erzielten Umsätze wie folgt zu versteuern: a. zum nächsttieferen bewilligten
        // Saldosteuersatz, wenn kein höherer Satz bewilligt ist; b. zum nächsthöheren bewilligten
        // Saldosteuersatz in den übrigen Fällen." That is mandatory and it is addressed to the
        // steuerpflichtige Person, not to the ESTV. It just answers a DIFFERENT question. Abs. 2
        // presupposes a known Tätigkeit whose proper rate was refused; an unmapped Ertragskonto is
        // the case where TILL does not know which Tätigkeit the turnover belongs to, so there is no
        // "nächsttiefer" or "nächsthöher" to be next to. Applying the ladder here would be inventing
        // the premise, not following the rule.
        const accounts = [...unmapped.values()].sort((a, b) => a.number.localeCompare(b.number));
        return err('saldo_activity_split_required', {
          periodStart,
          periodEnd,
          validFrom: generation.validFrom,
          unmappedAccounts: accounts,
          unmappedGrossMinor: accounts.reduce((n, a) => n + a.grossMinor, 0),
          // THE APPROVED RATES STAY ON THIS REFUSAL, and dropping them was a regression this rebuild
          // introduced against the shape already shipped. A workspace with rates but no Tätigkeit yet
          // reports `activities: []`, so without this the refusal names accounts to map and nothing
          // to map them ONTO.
          //
          // `formLine` is the Ziffer for THE PERIOD BEING REPORTED, not the stored per-position one.
          // It used to be the stored value, which on a 2026 period told the operator that their
          // second rate declares on Ziffer 333: a box that form does not have. Under `beiblatt` every
          // entry here reads 323, which is the honest answer and also the one the return will render.
          // It is null only for a third rate on a pre-2025 period, and this refusal is then the one
          // place that null is visible before it would have reached a signed form.
          rates: rates.map((r) => ({
            position: r.position,
            rateBp: r.rate_bp,
            formLine: saldoZiffer(r.form_line),
          })),
          activities: generation.activities.map((a) => ({
            activityId: a.activityId,
            name: a.name,
            rateBp: a.rateBp,
          })),
          reason:
            'Turnover was booked on an Ertragskonto that belongs to no approved Tätigkeit, and MWSTV Art. 88 Abs. 1 taxes each Tätigkeit at the rate approved for it.',
          hint: 'Assign each account above to a Tätigkeit with `vat_configure` (Studio: Einstellungen, MWST, Tätigkeiten). Or elect MWSTV Art. 88 Abs. 6 for this Steuerperiode with `vat_saldo_declaration_basis`, which declares the whole turnover at the highest approved Saldosteuersatz and needs no split.',
        });
      }

      const grossByPosition = new Map<number, number>();
      for (const a of generation.activities) {
        const gross = grossByActivity.get(a.activityId) ?? 0;
        saldoActivityLines.push({
          activityId: a.activityId,
          name: a.name,
          activityCode: a.activityCode,
          position: a.position,
          rateBp: a.rateBp,
          formLine: saldoZiffer(a.formLine),
          baseMinor: gross,
        });
        grossByPosition.set(a.position, (grossByPosition.get(a.position) ?? 0) + gross);
      }

      // --- ONE ROUND OVER ALL RATES, then allocated back (eCH-0217 Kap. 6.2.1) ------------------
      //
      // This used to round PER RATE and sum the results, on the stated ground that MWSTV Art. 84
      // Abs. 3 accumulates per rate. Fetched, Abs. 3 says: "Steuerpflichtige Personen, denen mehrere
      // Saldosteuersätze bewilligt wurden, müssen die Erträge für jeden dieser Saldosteuersätze
      // separat verbuchen." It is a BOOKKEEPING rule about the Erträge and it says nothing whatever
      // about rounding the tax. The rule that does is eCH-0217 Kap. 6.2.1: "Die Steuer muss auf zwei
      // Nachkommastellen OHNE RUNDEN IN DEN ZWISCHENSCHRITTEN berechnet werden", and Kap. 7.5 makes
      // the resulting mismatch rejection rule MWST-0006. Rounding each rate first IS an
      // intermediate rounding.
      //
      // It is also FREE to fix here, which is what makes this different from the effektiv path. The
      // eCH file carries no per-rate tax at all, so the ESTV multiplies the turnovers TILL sends and
      // compares its own total to `payableTax`. Under effektiv the engine reports the tax the LEDGER
      // booked per invoice, already rounded, and cannot un-round it. Under Saldo NO TAX IS EVER
      // BOOKED: the return computes it from the period's gross turnover, so it can simply compute it
      // the way the standard requires and there is no residue left to reconcile.
      //
      //   book: net 100'000 on 6.2%, net 100'016 on 3.7%
      //   per-rate rounding  payable 10702, ESTV recompute 10703, MWST-0006 mismatch
      //   one round          payable 10703, difference 0
      //
      // The residual is then allocated back to the Ziffern by LARGEST REMAINDER, so the parts still
      // foot to the whole and no Ziffer moves by more than a Rappen.
      //
      // Under the `beiblatt` regime every share resolves to the SAME Ziffer, so the allocation is
      // invisible in the rendered lines: the parts land in one bucket and sum to `totalSaldoTax`
      // exactly. It is still computed per share because `saldoActivityLines` reports the per-rate
      // turnover the Beiblatt splits, and because the `per_position` regime still needs it.
      const shares: { rate: (typeof rates)[number]; code: string; gross: number; scaled: number; floor: number }[] =
        [];
      let totalScaled = 0;
      for (const rate of rates) {
        const gross = grossByPosition.get(rate.position) ?? 0;
        if (gross === 0) continue;
        const stored = saldoZiffer(rate.form_line);
        if (stored === null) {
          // A third or later approved rate on a PRE-2025 period, and this is now the only way to get
          // here: `saldoZiffer` returns null only under the `per_position` regime, so from
          // 01.01.2025 this branch is unreachable and a tenth approved rate files without complaint.
          //
          // For a period up to 31.12.2024 the refusal is not a TILL limitation, it is the form. That
          // form's Steuerberechnung block defines a row per rate position and stops at two:
          // MWST-Info 12 (edition 30.08.2024, the one that GOVERNED 2024) Ziff. 20.1.4, "Ziffer 322:
          // Leistungen bis 31.12.2023 (1. Satz) / Ziffer 323: Leistungen ab 01.01.2024 (1. Satz) /
          // Ziffer 332: ... (2. Satz) / Ziffer 333: ... (2. Satz)", splitting the Entgelt "sofern die
          // ESTV ZWEI SSS bewilligt hat ... auf die BEIDEN SSS". There is no third box to render into
          // and none may be invented, because a return whose Ziffer lines do not sum to its own
          // payable is worse than one that stops.
          //
          // The remedy is therefore about the PERIOD, not about the configuration: nothing needs
          // changing to file 2025 onward, and only a correction return reaching back past 31.12.2024
          // is affected. Art. 88 Abs. 6 is still offered, still last, and still labelled as the
          // voluntary tax increase it is rather than as a repair.
          return err('saldo_form_line_missing', {
            position: rate.position,
            rateBp: rate.rate_bp,
            grossMinor: gross,
            periodStart,
            periodEnd,
            regime,
            reason:
              'The ESTV form for a period up to 31.12.2024 numbers its Saldosteuersatz rows per rate position (Ziff. 322/332 and 323/333) and defines only two, so a third approved rate has no box on that form. From 01.01.2025 the position dimension no longer exists and this rate declares on the same Ziffer as the first (MWST-Info 12 Ziff. 18.1.4, the Beiblatt to Ziffern 322 und 323).',
            hint: 'A period from 01.01.2025 files normally: no configuration change is needed, because every approved Saldosteuersatz declares on one Ziffer with the split carried in `saldoActivities`. Only this pre-2025 correction return is affected, and it is filed in the ESTV ePortal by hand. Electing MWSTV Art. 88 Abs. 6 with `vat_saldo_declaration_basis` also computes it here, but only by declaring the WHOLE taxable turnover at the HIGHEST approved Saldosteuersatz, which usually raises the tax owed: it is a voluntary simplification, not a repair.',
          });
        }
        // Units: Rappen x 10'000. Exact, because both factors are integers and nothing is a float.
        const scaled = gross * rate.rate_bp;
        shares.push({ rate, code: stored, gross, scaled, floor: Math.floor(scaled / 10000) });
        totalScaled += scaled;
      }

      // The one rounding the standard allows, taken over the accumulated products.
      const totalSaldoTax = roundHalfAwayFromZero(totalScaled, 10000);
      const floored = shares.reduce((n, s) => n + s.floor, 0);
      // `floor` is superadditive, so this residual is between 0 and the number of shares. Handing it
      // to the largest fractional parts is the standard largest-remainder allocation, and it is
      // deterministic: ties break on the earlier rate position, which is the order `rates` is in.
      let residual = totalSaldoTax - floored;
      const order = shares
        .map((s, i) => ({ i, frac: s.scaled - s.floor * 10000 }))
        .sort((a, b) => b.frac - a.frac || a.i - b.i);
      const extra = new Set<number>();
      for (const o of order) {
        if (residual <= 0) break;
        extra.add(o.i);
        residual -= 1;
      }

      shares.forEach((s, i) => {
        const b = bucketOf(outputBuckets, s.code);
        b.baseMinor += s.gross;
        b.taxMinor += s.floor + (extra.has(i) ? 1 : 0);
        b.rateBps.add(s.rate.rate_bp);
        b.kinds.add('output');
        for (const id of turnoverEntries) b.entryIds.add(id);
      });

      // The parts must equal the whole, checked rather than assumed. Both sides are integer Rappen
      // sums over the same rows, so a difference means the attribution dropped or double-counted a
      // line, and a return whose per-Tätigkeit rows do not foot to its own Ziffer 299 is one the ESTV
      // cross-foots and rejects (eCH-0217 rejection rule MWST-0006).
      const attributed = saldoActivityLines.reduce((n, a) => n + a.baseMinor, 0);
      if (attributed !== taxableGross) {
        return err('turnover_cross_foot_failed', {
          periodStart,
          periodEnd,
          attributedMinor: attributed,
          taxableGrossMinor: taxableGross,
          reason:
            'The turnover attributed to the approved Tätigkeiten does not equal the taxable turnover on Ziffer 299.',
        });
      }
    }
  }


  // --- Render ----------------------------------------------------------------------------------
  const toLine = (b: Bucket): VatReturnLine => ({
    code: b.code,
    label: formLineLabel(b.code, saldo),
    baseMinor: b.baseMinor,
    taxMinor: b.taxMinor,
    rateBp: soleOf(b.rateBps),
    kind: soleOf(b.kinds),
    entryIds: [...b.entryIds].sort(),
  });

  const turnoverLines: VatReturnLine[] = [];
  const pushTurnover = (code: string, baseMinor: number): void => {
    if (baseMinor === 0 && code !== '200' && code !== '299') return;
    turnoverLines.push({
      code,
      label: formLineLabel(code, saldo),
      baseMinor,
      taxMinor: 0,
      rateBp: null,
      kind: null,
      entryIds: [...turnoverEntries].sort(),
    });
  };
  const deductions = zeroTurnover + exemptTurnover;
  pushTurnover('200', worldwideTurnover);
  if (zeroTurnover !== 0) pushTurnover('220', zeroTurnover);
  if (exemptTurnover !== 0) pushTurnover('230', exemptTurnover);
  if (deductions !== 0) pushTurnover('289', deductions);
  pushTurnover('299', worldwideTurnover - deductions);

  const outputLines = [...outputBuckets.values()].map(toLine).sort((a, b) => a.code.localeCompare(b.code));
  const inputLines = [...inputBuckets.values()].map(toLine).sort((a, b) => a.code.localeCompare(b.code));

  const totalTaxDueMinor = outputLines.reduce((a, l) => a + l.taxMinor, 0); //  Ziffer 399
  // Ziffer 479 UNDER EFFEKTIV ONLY (`Total Ziff. 400 bis 420`). Under Saldo there is no Vorsteuer
  // total on the form at all (Art. 37) and this is structurally 0; the Saldo form's own 479 is
  // `Total Ziff. 470 bis 471`, the Steueranrechnung, which is a different figure this engine does
  // not compute. Right number, wrong heading, until now.
  const totalInputTaxMinor = inputLines.reduce((a, l) => a + l.taxMinor, 0);
  const net = totalTaxDueMinor - totalInputTaxMinor;

  // The drift check. Under effektiv the return's owed total must equal the period movement on 2200;
  // under Saldo the flat-rate figure is unrelated to it by construction (Art. 37), so the comparison
  // is reported as not applicable rather than as a failure.
  let outputVatBookedMinor = 0;
  for (const v of booked.values()) outputVatBookedMinor += v.output;
  const driftMinor = totalTaxDueMinor - outputVatBookedMinor;

  return ok({
    method,
    timing,
    vintage,
    periodStart,
    periodEnd,
    /**
     * The per-Tätigkeit turnover, present only on a multi-rate Saldo return computed on the Art. 88
     * Abs. 1 basis.
     *
     * TURNOVER ONLY, AND NO TAX FIGURE. eCH-0217 carries no per-rate tax element at all: `payableTax`
     * is the only tax element in the document and the ESTV derives the rest from the rates and
     * turnovers TILL supplies. A per-Tätigkeit tax would therefore be a number with nowhere to go
     * AND a second opinion about the rounding, since the tax is rounded ONCE over the accumulated
     * turnover of every rate (eCH-0217 Kap. 6.2.1, no rounding in the intermediate steps) and
     * per-activity rounding disagrees by a Rappen.
     *
     * The Ziffer lines above carry the tax; these carry the identity the 2025 eCH-0217 Saldo element
     * requires on every row (Kap. 3.2, and Kap. 5.3.6 permits the same rate to repeat across rows,
     * which is what several Tätigkeiten at one Saldosteuersatz look like on the wire).
     */
    saldoActivities: saldoActivityLines,
    /** `per_activity` (Art. 88 Abs. 1, the default) or `highest_rate` (Abs. 6, elected). Null under effektiv. */
    saldoDeclarationBasis,
    lines: [...turnoverLines, ...outputLines, ...inputLines],
    totalTaxDueMinor,
    totalInputTaxMinor,
    payableMinor: net > 0 ? net : 0, //  Ziffer 500
    creditMinor: net < 0 ? -net : 0, // Ziffer 510
    empty: resolvedRows.length === 0,
    reconciled: saldo ? null : driftMinor === 0,
    reconciliation: {
      applicable: !saldo,
      outputVatAccount: OUTPUT_VAT_ACCOUNT,
      outputVatBookedMinor,
      driftMinor,
    },
    // G22 (D127): the Abstimmung bridge, ONE derivation shared by the Studio strip and the
    // `abstimmung_resolved` checklist check. Pure over the two figures above (`bridge.ts`).
    bridge: vatBridgeOf({
      totalTaxDueMinor,
      reconciliation: { applicable: !saldo, outputVatAccount: OUTPUT_VAT_ACCOUNT, outputVatBookedMinor, driftMinor },
    }),
  });
}

// --- Periods -----------------------------------------------------------------------------------

const YEAR_RE = /^\d{4}$/;
/** `YYYY-Qn` (quarterly, effektiv) or `YYYY-Hn` (semi-annual, Saldo). */
const PERIOD_LABEL_RE = /^(\d{4})-(Q[1-4]|H[12])$/;

export interface VatPeriod {
  label: string;
  periodStart: string;
  periodEnd: string;
  months: string[];
  filed: boolean;
}

/** The last day of `YYYY-MM`, as an ISO day. */
function endOfMonth(year: number, month: number): string {
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}-${String(month).padStart(2, '0')}-${String(last).padStart(2, '0')}`;
}

/** The months a period label spans, or null when the label is malformed. */
export function monthsOfVatPeriod(label: string): string[] | null {
  const m = PERIOD_LABEL_RE.exec(label ?? '');
  if (m === null) return null;
  const year = Number(m[1]);
  const tag = m[2] as string;
  const span = tag[0] === 'Q' ? 3 : 6;
  const first = (Number(tag.slice(1)) - 1) * span + 1;
  const months: string[] = [];
  for (let i = 0; i < span; i += 1) {
    months.push(`${year}-${String(first + i).padStart(2, '0')}`);
  }
  return months;
}

function periodOf(label: string): VatPeriod | null {
  const months = monthsOfVatPeriod(label);
  if (months === null) return null;
  const year = Number(label.slice(0, 4));
  const firstMonth = Number((months[0] as string).slice(5));
  const lastMonth = Number((months[months.length - 1] as string).slice(5));
  return {
    label,
    periodStart: `${year}-${String(firstMonth).padStart(2, '0')}-01`,
    periodEnd: endOfMonth(year, lastMonth),
    months,
    filed: false,
  };
}

/**
 * The reporting periods of a year, derived from the configured method.
 *
 * MWSTG Art. 35 Abs. 1, verbatim from the consolidated version in force since 1.1.2025 (fedlex
 * SR 641.20, verified 2026-07-25):
 *
 *   "Innerhalb der Steuerperiode erfolgt die Abrechnung der Steuer vierteljährlich. Bei der
 *    Abrechnung nach Saldosteuersätzen (Art. 37 Abs. 1 und 2) erfolgt die Abrechnung halbjährlich."
 *
 * So quarterly is the unqualified default and the Saldosteuersatz carve-out is the only exception,
 * which is exactly the split below. The Steuerperiode itself is the CALENDAR year (Art. 34 Abs. 2),
 * and A00's fiscal-year setting does not move it: Art. 34 Abs. 3, which would let a taxable person
 * elect the Geschäftsjahr instead, is marked "Noch nicht in Kraft (AS 2009 5203)" and has never
 * entered into force. A fiscal-year MWST Steuerperiode is therefore not a thing to model.
 *
 * KNOWN GAP, stated rather than silently approximated. Art. 35 Abs. 1bis (inserted by the BG of
 * 16.6.2023, in force since 1.1.2025) adds two further frequencies ON APPLICATION to the ESTV:
 * monthly "bei regelmässigem Vorsteuerüberschuss", and annual "bei einem Umsatz von nicht mehr als
 * 5 005 000 Franken pro Jahr aus steuerbaren Leistungen" (governed by the new Art. 35a). A05 stores
 * no elected-frequency field, so neither can be derived here yet. This function reports the
 * statutory default for the configured method and nothing else; a workspace that filed a successful
 * application under Abs. 1bis is not modelled, and pretending otherwise would put periods on the
 * screen that the ESTV never granted.
 */
export function listVatPeriods(ctx: WorkspaceContext, input?: { year?: string }): Result {
  const year = input?.year ?? ctx.clock.now().slice(0, 4);
  if (!YEAR_RE.test(year)) return err('invalid_input', { field: 'year', expected: 'YYYY' });

  // The method that governed THAT YEAR, not today's. A workspace that left Saldo on 01.01.2027 filed
  // 2026 in two half-years and 2027 in four quarters, and a period list that renders today's method
  // over the whole history offers the wrong periods for every closed year, which is where a
  // correction return is filed from. MWSTG Art. 35 Abs. 1 ties the frequency to the method, and
  // Art. 37 Abs. 4 puts a change at the start of a Steuerperiode, so a calendar year never spans one.
  const method = methodOn(ctx, `${year}-01-01`).method;
  if (method !== 'effektiv' && method !== 'saldo') return err('needs_vat_config', { method });

  const labels =
    method === 'saldo' ? [`${year}-H1`, `${year}-H2`] : [1, 2, 3, 4].map((n) => `${year}-Q${n}`);

  // "Filed" means every month of the period carries a hard lock applied by a filing (A03's
  // `vat_filed` reason). Reading the locks is what makes the flag true rather than claimed.
  const locked = new Set(
    (
      ctx.store.db
        .prepare("SELECT period FROM period_lock WHERE workspace_id = ? AND kind = 'hard' AND reason = 'vat_filed'")
        .all(ctx.workspaceId) as { period: string }[]
    ).map((r) => r.period),
  );

  const periods = labels.map((label) => {
    const p = periodOf(label) as VatPeriod;
    return { ...p, filed: p.months.every((m) => locked.has(m)) };
  });

  return ok({ method, year, periods });
}

// --- Filing --------------------------------------------------------------------------------------

export interface MarkVatPeriodFiledInput {
  period: string;
  idempotencyKey: string;
}

/**
 * Record that the human filed a period, by applying A03's hard lock to each of its months.
 *
 * THIS TRANSMITS NOTHING. There is no ESTV submission API: eCH-0217 is a file format, not a
 * transport, and every Swiss vendor does what TILL does, which is produce a file a human uploads to
 * the ePortal. The most an agent can ever do for MWST is hand a valid file to a person, so this verb
 * records a fact about the world rather than performing an act in it.
 *
 * It mints NO journal entry (A07 never posts, P3 by absence) and writes no lock statement of its
 * own: A03's `lockPeriod` is the single writer, called once per month because `period_lock` keys on
 * `YYYY-MM` or `YYYY` and a quarter is neither. Each delegated call carries its own derived
 * idempotency key, so a replay of the whole filing replays each lock and no second row is minted.
 */
export function markVatPeriodFiled(ctx: WorkspaceContext, input: MarkVatPeriodFiledInput): Result {
  if (typeof input?.idempotencyKey !== 'string' || input.idempotencyKey.length === 0) {
    return err('invalid_input', { field: 'idempotencyKey' });
  }
  const months = monthsOfVatPeriod(input?.period);
  if (months === null) {
    return err('invalid_period', { period: input?.period, expected: 'YYYY-Qn or YYYY-Hn' });
  }

  const locks: unknown[] = [];
  for (const month of months) {
    const r = lockPeriod(ctx, {
      period: month,
      kind: 'hard',
      reason: 'vat_filed',
      idempotencyKey: `${input.idempotencyKey}:${month}`,
    });
    // A refusal on any month stops the filing where it is and reports it. The months already sealed
    // stay sealed: they are hard locks on periods a human declared filed, and silently unwinding
    // them would be a destructive edit of an audit fact (§H-AUDIT).
    if (!r.ok) return r;
    locks.push(r);
  }

  return ok({ period: input.period, months, kind: 'hard', reason: 'vat_filed', locks });
}
