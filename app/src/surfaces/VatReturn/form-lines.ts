/**
 * The ESTV form skeleton: which Ziffern exist, in which order, under which heading, per method.
 *
 * WHY THE STUDIO HOLDS A ZIFFER LIST AT ALL, when the engine sends labelled lines.
 *
 * `computeVatReturn` emits a line only where the ledger produced a figure: the recorded healthy
 * return carries nine Ziffern, and the recorded zero return carries two. A filer's task on this
 * screen is matching it against a paper form, and a form with only the filled-in boxes on it is not
 * the form. So the skeleton below is the BOX LIST, and the engine's payload fills it in. A box the
 * ledger never touched renders `-`, which says "nothing of this kind happened"; the alternative,
 * omitting the row, says "this line does not exist", which is false and is the exact distinction
 * `abrechnung.ts` calls out in its own label-map header.
 *
 * THE LABELS ARE THE ENGINE'S WHEREVER THE ENGINE SENDS ONE. `VatReturnLine.label` wins over the
 * table here on every line the payload carries, so the screen matches the form the engine
 * transcribed. The table is the fallback for the boxes the engine never emits, and
 * `test/vat/studio-vat-return-fixture.test.mjs` asserts the two agree STRING FOR STRING on every
 * Ziffer both hold. Two copies of a tax-form label with nothing comparing them is how a screen stops
 * matching the document it exists to reproduce.
 *
 * THE TOTALS ARE NOT LINES. 399, 479, 500 and 510 never appear in `lines[]`: they are the payload's
 * top-level `totalTaxDueMinor`, `totalInputTaxMinor`, `payableMinor` and `creditMinor`. They are
 * declared here as rows with `from: 'total'` so the form renders in one pass and nothing has to
 * remember which four boxes are special.
 *
 * VINTAGE. The ESTV form prints both rate vintages side by side ("ab 01.01.2024" and
 * "bis 31.12.2023") and totals them together at 399. The skeleton lists the CURRENT vintage; a
 * legacy Ziffer the payload carries (302/312/342/382/322/332 on a pre-2024 or straddling period) is
 * inserted beside its current sibling by `formRows`, so a straddle renders two rows rather than one
 * blended row. That is a property of the data, not a mode to switch into.
 */

/** Where a row's figure comes from. */
export type FigureSource =
  /** A `lines[]` entry, matched by Ziffer. Absent means the ledger produced nothing: renders `-`. */
  | 'line'
  /** A payload top-level total. Always renders a number, including `CHF 0.00`. */
  | 'total'
  /** A box TILL cannot compute at all. Renders `-` with a footnote, never a fabricated zero. */
  | 'uncomputed';

/** Which column a row's figure belongs in. */
export type FigureColumn = 'turnover' | 'tax' | 'both';

export interface FormRowSpec {
  code: string;
  /** The fallback label, used only where the payload carries no line for this Ziffer. */
  label: string;
  from: FigureSource;
  column: FigureColumn;
  /** True for 289, 299, 399, 479, 500: a declared figure, so it renders a number and never `-`. */
  declared?: boolean;
}

export interface FormSection {
  /** i18n key for the heading. */
  titleKey: string;
  /** i18n key for a sub-heading inside the section ("Abzüge"), or absent. */
  subheadKey?: string;
  /** Rows before the sub-heading. */
  rows: readonly FormRowSpec[];
  /** Rows after the sub-heading. Present only where `subheadKey` is. */
  subRows?: readonly FormRowSpec[];
}

/**
 * The fallback labels, transcribed from ESTV forms DM_0550_03 / 01.24 (effektiv) and
 * DM_0553_03 / 01.24 (Saldo), the same two documents `abrechnung.ts` transcribed. They stay German
 * in every locale: they are the ESTV's own form text, and the filer's whole task is matching the
 * screen against that document, which exists in German, French and Italian and never in English.
 */
const L = {
  '200': 'Total der vereinbarten bzw. vereinnahmten Entgelte, inkl. optierte Leistungen, Entgelte aus Übertragungen im Meldeverfahren sowie aus Leistungen im Ausland (weltweiter Umsatz)',
  '200_saldo':
    'Total der vereinbarten bzw. vereinnahmten Entgelte, inkl. Entgelte aus Übertragungen im Meldeverfahren sowie aus Leistungen im Ausland (weltweiter Umsatz)',
  '205': 'In Ziffer 200 enthaltene Entgelte aus von der Steuer ausgenommenen Leistungen (Art. 21), für welche nach Art. 22 optiert wird',
  '220': 'Von der Steuer befreite Leistungen (u.a. Exporte, Art. 23), von der Steuer befreite Leistungen an begünstigte Einrichtungen und Personen (Art. 107 Abs. 1 Bst. a)',
  '221': 'Leistungen im Ausland (Ort der Leistung im Ausland)',
  '225': 'Übertragung im Meldeverfahren (Art. 38, bitte zusätzlich Form. 764 einreichen)',
  '230': 'Von der Steuer ausgenommene Inlandleistungen (Art. 21), für die nicht nach Art. 22 optiert wird',
  '235': 'Entgeltsminderungen wie Skonti, Rabatte usw.',
  '280': 'Diverses (z.B. Wert des Bodens, Ankaufspreise Margenbesteuerung)',
  '280_saldo': 'Diverses (z.B. Wert des Bodens)',
  '289': 'Total Ziff. 220 bis 280',
  '299': 'Steuerbarer Gesamtumsatz (Ziff. 200 abzüglich Ziff. 289)',
  '302': 'Normal 7,7% (bis 31.12.2023)',
  '303': 'Normal 8,1% (ab 01.01.2024)',
  '312': 'Reduziert 2,5% (bis 31.12.2023)',
  '313': 'Reduziert 2,6% (ab 01.01.2024)',
  // 322/323 are the two rate ERAS and, from 01.01.2025, the only Saldo rows the form has: every
  // approved Saldosteuersatz declares on them and the split lives in the Beiblatt (A07 §3.1a).
  // 332/333 are the abolished 2. Satz rows, still labelled because a Berichtigungsabrechnung for a
  // period up to 31.12.2024 declares on them.
  '322': 'Saldosteuersatz Leistungen bis 31.12.2023',
  '323': 'Saldosteuersatz Leistungen ab 01.01.2024',
  '332': 'Saldosteuersatz 2. Satz, Leistungen bis 31.12.2023 (Formular bis 31.12.2024)',
  '333': 'Saldosteuersatz 2. Satz, Leistungen ab 01.01.2024 (Formular bis 31.12.2024)',
  '342': 'Beherbergung 3,7% (bis 31.12.2023)',
  '343': 'Beherbergung 3,8% (ab 01.01.2024)',
  '382': 'Bezugsteuer (bis 31.12.2023)',
  '383': 'Bezugsteuer (ab 01.01.2024)',
  '399': 'Total geschuldete Steuer',
  '400': 'Vorsteuer auf Material- und Dienstleistungsaufwand',
  '405': 'Vorsteuer auf Investitionen und übrigem Betriebsaufwand',
  '410': 'Einlageentsteuerung (Art. 32, bitte detaillierte Aufstellung beilegen)',
  '415': 'Vorsteuerkorrekturen: gemischte Verwendung (Art. 30), Eigenverbrauch (Art. 31)',
  '420': 'Vorsteuerkürzungen: Nicht-Entgelte wie Subventionen, Tourismusabgaben (Art. 33 Abs. 2)',
  '470': 'Steueranrechnung gemäss Formular Nr. 1050',
  '471': 'Steueranrechnung gemäss Formular Nr. 1055, 1056',
  '479': 'Total Ziff. 400 bis 420',
  '479_saldo': 'Total Ziff. 470 bis 471',
  '500': 'Zu bezahlender Betrag',
  '510': 'Guthaben der steuerpflichtigen Person',
  '900': 'Andere Mittelflüsse (Art. 18 Abs. 2): Subventionen, durch Kurvereine eingenommene Tourismusabgaben, Entsorgungs- und Wasserwerkbeiträge (Bst. a-c)',
  '910': 'Andere Mittelflüsse (Art. 18 Abs. 2): Spenden, Dividenden, Schadenersatz usw. (Bst. d-l)',
} as const;

const row = (code: string, label: string, from: FigureSource, column: FigureColumn, declared = false): FormRowSpec => ({
  code,
  label,
  from,
  column,
  ...(declared ? { declared } : {}),
});

/** The deduction block, identical on both forms. */
const DEDUCTIONS: readonly FormRowSpec[] = [
  row('220', L['220'], 'line', 'turnover'),
  row('221', L['221'], 'line', 'turnover'),
  row('225', L['225'], 'line', 'turnover'),
  row('230', L['230'], 'line', 'turnover'),
  row('235', L['235'], 'line', 'turnover'),
  row('280', L['280'], 'line', 'turnover'),
  row('289', L['289'], 'line', 'turnover', true),
];

/** 500 / 510 and block III, identical on both forms. */
const SETTLEMENT: readonly FormRowSpec[] = [
  row('500', L['500'], 'total', 'tax', true),
  row('510', L['510'], 'total', 'tax'),
];

const OTHER_FLOWS: readonly FormRowSpec[] = [
  row('900', L['900'], 'line', 'turnover'),
  row('910', L['910'], 'line', 'turnover'),
];

/**
 * The effektiv form.
 *
 * Ziff. 205 sits ABOVE the "Abzüge" sub-heading because on the form it is a memo line inside
 * Ziff. 200, not a deduction. Putting it below would make Ziff. 289 look as though it should include
 * it, which is an arithmetic claim and a wrong one.
 */
const EFFEKTIV: readonly FormSection[] = [
  {
    titleKey: 'vat.return.section.turnover',
    subheadKey: 'vat.return.section.deductions',
    rows: [row('200', L['200'], 'line', 'turnover'), row('205', L['205'], 'line', 'turnover')],
    subRows: [...DEDUCTIONS, row('299', L['299'], 'line', 'turnover', true)],
  },
  {
    titleKey: 'vat.return.section.taxCalc',
    rows: [
      row('303', L['303'], 'line', 'both'),
      row('313', L['313'], 'line', 'both'),
      row('343', L['343'], 'line', 'both'),
      row('383', L['383'], 'line', 'both'),
      row('399', L['399'], 'total', 'tax', true),
    ],
  },
  {
    titleKey: 'vat.return.section.inputTax',
    rows: [
      row('400', L['400'], 'line', 'tax'),
      row('405', L['405'], 'line', 'tax'),
      row('410', L['410'], 'line', 'tax'),
      row('415', L['415'], 'line', 'tax'),
      row('420', L['420'], 'line', 'tax'),
      row('479', L['479'], 'total', 'tax', true),
    ],
  },
  { titleKey: 'vat.return.section.settlement', rows: SETTLEMENT },
  { titleKey: 'vat.return.section.otherFlows', rows: OTHER_FLOWS },
];

/**
 * The Saldo form, and it is a DIFFERENT form rather than the effektiv one with fields hidden.
 *
 *  - Ziff. 205 is absent from form DM_0553_03 entirely, so it is absent here. Not blank: absent.
 *  - Block II depends on the REPORTED PERIOD (A07 §3.1a). Up to 31.12.2024 it is "1. Satz" 323 and
 *    "2. Satz" 333, whose rate boxes the form leaves blank because the rate is the workspace's own,
 *    with the third row BLACKED OUT. From 01.01.2025 the 2. Satz row is gone: MWST-Info 12 Ziff.
 *    18.1.4 defines only "Ziffer 322: Leistungen bis 31.12.2023" and "Ziffer 323: Leistungen ab
 *    01.01.2024", and every approved Saldosteuersatz declares on the one row, with the split carried
 *    in the Beiblatt. Rendering an empty 333 on a modern return would print a box the form does not
 *    have, next to figures a person is about to sign.
 *  - The Vorsteuer block is REPLACED by the Steueranrechnung, 470 and 471 into 479, and the
 *    remaining rows are blacked out.
 *
 * 470, 471 AND THE SALDO 479 ARE `uncomputed`, WHICH IS THE ONE PLACE THE DECLARED-TOTAL RULE
 * YIELDS. Nothing in TILL produces a Steueranrechnung: no spec defines it, no engine code computes
 * it, and the figures come off ESTV forms 1050 / 1055 / 1056 that live outside this product. A
 * declared total normally renders a number so the filer can tell zero from unknown, but printing
 * `CHF 0.00` on 479 here would declare a Steueranrechnung of nil that TILL never computed and cannot
 * check. `-` plus the footnote is the honest reading, and it is also why the Saldo Ziff. 500 carries
 * its own caveat: the engine derives it as 399 minus nothing.
 */
const SALDO: readonly FormSection[] = [
  {
    titleKey: 'vat.return.section.turnover',
    subheadKey: 'vat.return.section.deductions',
    rows: [row('200', L['200_saldo'], 'line', 'turnover')],
    subRows: [
      ...DEDUCTIONS.slice(0, 5),
      row('280', L['280_saldo'], 'line', 'turnover'),
      row('289', L['289'], 'line', 'turnover', true),
      row('299', L['299'], 'line', 'turnover', true),
    ],
  },
  {
    titleKey: 'vat.return.section.taxCalc',
    rows: [
      row('323', L['323'], 'line', 'both'),
      row('383', L['383'], 'line', 'both'),
      row('399', L['399'], 'total', 'tax', true),
    ],
  },
  {
    titleKey: 'vat.return.section.taxCredit',
    rows: [
      row('470', L['470'], 'uncomputed', 'tax'),
      row('471', L['471'], 'uncomputed', 'tax'),
      row('479', L['479_saldo'], 'uncomputed', 'tax'),
    ],
  },
  { titleKey: 'vat.return.section.settlement', rows: SETTLEMENT },
  { titleKey: 'vat.return.section.otherFlows', rows: OTHER_FLOWS },
];

/**
 * The pre-2025 Saldo form, which carries the 2. Satz row the current one dropped.
 *
 * Built from `SALDO` rather than written out again, so the two cannot drift on the fifteen rows they
 * share. The only difference between the forms is this one row.
 */
const SALDO_PER_POSITION: readonly FormSection[] = SALDO.map((section) =>
  section.titleKey === 'vat.return.section.taxCalc'
    ? {
        ...section,
        rows: [
          row('323', L['323'], 'line', 'both'),
          row('333', L['333'], 'line', 'both'),
          ...section.rows.filter((r) => r.code !== '323'),
        ],
      }
    : section,
);

/**
 * Which Saldo form the reported period files on (A07 §3.1a), on the engine's own boundary.
 *
 * Duplicated from `saldoDeclarationRegimeForPeriod` in the engine rather than imported, because the
 * Studio never imports engine modules. That duplication is held to the engine's value by
 * `test/vat/studio-vat-return-fixture.test.mjs`, which reads this constant out of this file as text,
 * the same way it already checks the form labels: a Studio that drew the boundary a day from the
 * engine's would render a 333 box next to a figure the engine had already folded into 323.
 */
export const SALDO_PER_POSITION_LAST_DAY = '2024-12-31';

/** The form for a method, and for Saldo the period's declaration regime. */
export function formSections(method: string, periodEnd?: string): readonly FormSection[] {
  if (method !== 'saldo') return EFFEKTIV;
  // No period is the live screen before a period is chosen, which files under the current form.
  if (periodEnd !== undefined && periodEnd !== '' && periodEnd <= SALDO_PER_POSITION_LAST_DAY) {
    return SALDO_PER_POSITION;
  }
  return SALDO;
}

/** Every Ziffer the skeleton knows, with its fallback label, for the engine-parity guard. */
export function skeletonLabels(method: string, periodEnd?: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const section of formSections(method, periodEnd)) {
    for (const spec of [...section.rows, ...(section.subRows ?? [])]) out[spec.code] = spec.label;
  }
  return out;
}

/**
 * The legacy sibling of a current-vintage Ziffer, so a straddling period renders two rows.
 *
 * The pairs are the ESTV form's own two columns. A legacy code the payload carries and this map does
 * not is still rendered, appended to its section, rather than dropped: a figure with no box is money
 * silently leaving the form, which is worse than a row in an unexpected place.
 */
export const LEGACY_OF: Readonly<Record<string, string>> = {
  '303': '302',
  '313': '312',
  '343': '342',
  '383': '382',
  '323': '322',
  '333': '332',
};

/** The fallback label for any Ziffer the skeleton names, legacy vintages included. */
export function fallbackLabel(code: string, saldo: boolean): string {
  const table = L as Record<string, string>;
  if (saldo) {
    const override = table[`${code}_saldo`];
    if (override !== undefined) return override;
  }
  return table[code] ?? code;
}
