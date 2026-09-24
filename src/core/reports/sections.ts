/**
 * A08, the statement section map: the ONE place an account becomes a statutory line.
 *
 * The Bilanz and the Erfolgsrechnung both read this file, so the two can never fork the grouping
 * logic (§4). It is the spec's "KMU class to statement section map", written out.
 *
 * ## Provenance of the labels, and why it matters
 *
 * The German, French and Italian section labels below are the STATUTORY headings, copied verbatim
 * from the consolidated Obligationenrecht (SR 220) at fedlex.admin.ch, fetched 2026-07-26 from
 * `filestore/fedlex.data.admin.ch/eli/cc/27/317_321_377/20260101/{de,fr,it}/html/...`. Statutes are
 * excluded from copyright by URG Art. 5 Abs. 1 lit. a, and a heading an auditor already recognises
 * is the safest possible ground. English is not an official language of the OR, so the `en` label is
 * TILL's own wording, exactly as `kmuSeed.ts` handles it.
 *
 * The two article structures are:
 *
 *  - **OR Art. 959a** (Mindestgliederung der Bilanz): Aktiven split into Umlaufvermögen and
 *    Anlagevermögen by liquidity; Passiven split into kurzfristiges Fremdkapital, langfristiges
 *    Fremdkapital and Eigenkapital by maturity. Abs. 2 Ziff. 3 lit. f and lit. g require the
 *    Gewinn-/Verlustvortrag and the Jahresgewinn/-verlust as EQUITY positions, which is why the
 *    Bilanz below carries two computed equity lines and does not simply drop the P and L.
 *
 *  - **OR Art. 959b Abs. 2** (Produktionserfolgsrechnung, Gesamtkostenverfahren): eleven positions
 *    in a prescribed order. Ten are account-backed; the eleventh, `Jahresgewinn oder Jahresverlust`,
 *    is the result and is returned as `reingewinnMinor` rather than as a section of its own.
 *    A08 ships the Gesamtkostenverfahren only; the Absatzerfolgsrechnung (Abs. 3) is not built.
 *
 * ## WHAT THE BILANZ HERE IS NOT: OR Art. 959a's FIRST LEVEL ONLY
 *
 * This is the most important limitation in the file and it used to be undocumented, while the
 * paragraph above said "the STATUTORY headings, copied verbatim" and left a reader to conclude the
 * article was implemented. It is not. Abs. 1 and Abs. 2 do not stop at the groupings below.
 * Verbatim, from the fetch cited above:
 *
 *     Unter den Aktiven müssen ihrem Liquiditätsgrad entsprechend mindestens folgende Positionen
 *     einzeln und in der vorgegebenen Reihenfolge ausgewiesen werden: 1. Umlaufvermögen: a. flüssige
 *     Mittel und kurzfristig gehaltene Aktiven mit Börsenkurs, b. Forderungen aus Lieferungen und
 *     Leistungen, c. übrige kurzfristige Forderungen, d. Vorräte und nicht fakturierte
 *     Dienstleistungen, e. aktive Rechnungsabgrenzungen; 2. Anlagevermögen: a. Finanzanlagen,
 *     b. Beteiligungen, c. Sachanlagen, d. immaterielle Werte, e. nicht einbezahltes Grund-,
 *     Gesellschafter- oder Stiftungskapital.
 *
 * That is 24 named sub-positions across Abs. 1 and Abs. 2 (5 + 5 + 4 + 3 + 7), each of which the
 * article requires "einzeln und in der vorgegebenen Reihenfolge". `BILANZ_SECTIONS` models the SEVEN
 * first-level groupings and stops. Under each one A08 emits the raw account lines, ordered by
 * account number.
 *
 * On the shipped KMU chart that comes out looking right, and ONLY BY COINCIDENCE: the Kontenrahmen
 * KMU numbers ascend in the same order the statute lists (1000 flüssige Mittel before 1100
 * Forderungen before 1300 aktive Rechnungsabgrenzungen), so ordering by number reproduces the
 * statutory sequence without ever modelling it. A01 lets a workspace rename and renumber freely, so
 * a customised chart yields a Bilanz that names none of the required positions and may order them
 * arbitrarily. No reconciliation flag can see this: the statement still foots.
 *
 * Modelling the 24 sub-positions was CONSIDERED AND NOT DONE, deliberately. It would mean a second
 * number-range map one level finer, which is the same guess this one makes and no more reliable on
 * the very charts where the first level already fails. Assigning `1176 Vorsteuer` to "übrige
 * kurzfristige Forderungen" on a chart that had renumbered it would be a WRONG statutory position
 * stated confidently, which is worse than an account line under a correct grouping. So the gap is
 * recorded here, in `docs/specs/specs/A08-financial-statements.md` §10, and pinned by
 * `test/reports/or-structure.test.mjs`, rather than papered over.
 *
 * The Erfolgsrechnung has no equivalent gap: OR Art. 959b Abs. 2 is a FLAT list of eleven positions
 * with no sub-level, and all ten account-backed ones are modelled under their statutory wording.
 *
 * ## TYPE gates, NUMBER buckets
 *
 * An account reaches a statement through its `type`, and its `number` only chooses WHICH position
 * inside that statement. That ordering is deliberate and it is what makes the two statements a
 * partition of the chart: asset/liability/equity go to the Bilanz, income/expense to the
 * Erfolgsrechnung, and no account can reach both or neither. Bucketing by number first would let an
 * account typed `asset` but numbered 3500 land in Nettoerlöse, where it would inflate revenue and
 * simultaneously vanish from the Aktiven, and both statements would still foot.
 *
 * ## Nothing may fall off the edge
 *
 * `number` is a free-text column (A01 validates only that it is non-empty), so a workspace may hold
 * `1450`, `9100`, or `Sonderkonto`. Every classifier below is therefore TOTAL: an account whose
 * number matches no statutory range lands in an explicit residual position, never nowhere. The
 * residual is not an invention either, it is OR Art. 959a Abs. 3 and OR Art. 959b Abs. 5, both of
 * which require further positions to be shown separately when they are material.
 *
 * A silently dropped account is the defect class that survives every total-level check: the line
 * disappears AND its section subtotal shrinks by the same amount, so the statement still foots and
 * only the comparison against the ledger notices. The residual makes the drop unrepresentable.
 */

import type { AccountType } from '../accounts/kmuSeed.js';

/** The four shipped label languages, matching `SeedAccountLabels`. `de` is the de-CH default. */
export interface SectionLabels {
  de: string;
  fr: string;
  it: string;
  en: string;
}

/** Which half of the Bilanz a section belongs to. */
export type BilanzSide = 'aktiven' | 'passiven';

export interface BilanzSectionDef {
  key: string;
  side: BilanzSide;
  labels: SectionLabels;
  /** The statutory citation, so a reader can check the heading against the source. */
  cite: string;
}

export interface ErfolgSectionDef {
  key: string;
  /**
   * What the position holds, so a GUI can choose a display sign without re-deriving one.
   * `revenue` positions add to profit, `expense` positions subtract, `mixed` positions (OR Art. 959b
   * Abs. 2 Ziff. 7, 8, 9) genuinely carry both and are shown net.
   */
  nature: 'revenue' | 'expense' | 'mixed';
  labels: SectionLabels;
  cite: string;
}

/**
 * The Bilanz positions, in the statutory order of OR Art. 959a (Aktiven by decreasing liquidity,
 * Passiven by decreasing maturity). The two residuals sit at the end of their own side.
 */
export const BILANZ_SECTIONS: readonly BilanzSectionDef[] = [
  {
    key: 'umlaufvermoegen',
    side: 'aktiven',
    cite: 'OR Art. 959a Abs. 1 Ziff. 1',
    labels: {
      de: 'Umlaufvermögen',
      fr: 'Actif circulant',
      it: 'Attivo circolante',
      en: 'Current assets',
    },
  },
  {
    key: 'anlagevermoegen',
    side: 'aktiven',
    cite: 'OR Art. 959a Abs. 1 Ziff. 2',
    labels: {
      de: 'Anlagevermögen',
      fr: 'Actif immobilisé',
      it: 'Attivo fisso',
      en: 'Non-current assets',
    },
  },
  {
    key: 'uebrige_aktiven',
    side: 'aktiven',
    cite: 'OR Art. 959a Abs. 3',
    labels: {
      de: 'Übrige Aktiven',
      fr: 'Autres actifs',
      it: 'Altri attivi',
      en: 'Other assets',
    },
  },
  {
    key: 'kurzfristiges_fremdkapital',
    side: 'passiven',
    cite: 'OR Art. 959a Abs. 2 Ziff. 1',
    labels: {
      de: 'Kurzfristiges Fremdkapital',
      fr: 'Capitaux étrangers à court terme',
      it: 'Capitale di terzi a breve termine',
      en: 'Current liabilities',
    },
  },
  {
    key: 'langfristiges_fremdkapital',
    side: 'passiven',
    cite: 'OR Art. 959a Abs. 2 Ziff. 2',
    labels: {
      de: 'Langfristiges Fremdkapital',
      fr: 'Capitaux étrangers à long terme',
      it: 'Capitale di terzi a lungo termine',
      en: 'Non-current liabilities',
    },
  },
  {
    key: 'eigenkapital',
    side: 'passiven',
    cite: 'OR Art. 959a Abs. 2 Ziff. 3',
    labels: {
      de: 'Eigenkapital',
      fr: 'Capitaux propres',
      it: 'Capitale proprio',
      en: 'Equity',
    },
  },
  {
    key: 'uebrige_passiven',
    side: 'passiven',
    cite: 'OR Art. 959a Abs. 3',
    labels: {
      de: 'Übrige Passiven',
      fr: 'Autres passifs',
      it: 'Altri passivi',
      en: 'Other liabilities',
    },
  },
];

/**
 * The two COMPUTED equity positions, which no account carries and which the Bilanz cannot foot
 * without (§4).
 *
 * Income and expense accounts are not on the Bilanz, so until a year is closed their net sits
 * outside both sides. OR Art. 959a Abs. 2 Ziff. 3 lit. f and lit. g are exactly the two positions
 * that put it back:
 *
 *  - `jahresergebnis` (lit. g) is the result of the fiscal year the reporting date falls in;
 *  - `ergebnisvortrag` (lit. f) is the result accumulated in EARLIER fiscal years that were never
 *    closed. It is zero in the ordinary case, because A03's `close_year` moves that result into
 *    2979 and then 2970, which are real equity accounts and appear as ordinary lines.
 *
 * Splitting them matters for the tie-out: US-A08.3 requires the Erfolgsrechnung's Reingewinn to
 * equal the Eigenkapital MOVEMENT, and that claim is only true of the current year's half. Folding
 * an unclosed prior year into one combined line would make the Bilanz foot and the tie-out lie.
 *
 * ## `labels` is the POSITION NAME. `statutoryWording` is the enacted text, and they differ
 *
 * lit. e, f and g all end "als Minusposten" in the German and "en diminution des capitaux propres"
 * in the French, on the 2026-01-01 consolidation. That suffix is a presentation INSTRUCTION to the
 * preparer, not part of what the line is called: no Swiss Bilanz prints "Jahresgewinn oder
 * Jahresverlust als Minusposten" on its face, and doing so would read as an error to the Treuhänder
 * the document is for. So `labels` carries the name that belongs on the page.
 *
 * The suffix is nonetheless enacted text, and the previous version of this file dropped it while
 * `or-structure.test.mjs` asserted the shortened string as though it were verbatim. Both halves are
 * now here: the display name and the full statutory wording, each asserted for what it is. A reader
 * checking A08 against the article can see the whole phrase without leaving the repo.
 */
export const COMPUTED_EQUITY_LINES: readonly {
  key: string;
  labels: SectionLabels;
  cite: string;
  statutoryWording: { de: string; fr: string };
}[] = [
  {
    key: 'ergebnisvortrag',
    cite: 'OR Art. 959a Abs. 2 Ziff. 3 lit. f',
    labels: {
      de: 'Gewinnvortrag oder Verlustvortrag',
      fr: 'Bénéfice reporté ou perte reportée',
      it: 'Utile o perdita riportati',
      en: 'Profit or loss carried forward',
    },
    statutoryWording: {
      de: 'Gewinnvortrag oder Verlustvortrag als Minusposten',
      fr: 'bénéfice reporté ou perte reportée en diminution des capitaux propres',
    },
  },
  {
    key: 'jahresergebnis',
    cite: 'OR Art. 959a Abs. 2 Ziff. 3 lit. g',
    labels: {
      de: 'Jahresgewinn oder Jahresverlust',
      fr: "Bénéfice ou perte de l'exercice",
      it: "Utile o perdita dell'esercizio",
      en: 'Annual profit or annual loss',
    },
    statutoryWording: {
      de: 'Jahresgewinn oder Jahresverlust als Minusposten',
      fr: "bénéfice de l'exercice ou perte de l'exercice en diminution des capitaux propres",
    },
  },
];

/**
 * The ten account-backed positions of OR Art. 959b Abs. 2, in the prescribed order, plus the
 * residual of Abs. 5.
 *
 * Position 11 (`Jahresgewinn oder Jahresverlust`) is the RESULT and is returned as
 * `reingewinnMinor`, not as a section: it is the sum of the others, and rendering it as an eleventh
 * bucket that accounts could fall into is how a report double-counts itself.
 */
export const ERFOLG_SECTIONS: readonly ErfolgSectionDef[] = [
  {
    key: 'netto_erloese',
    nature: 'revenue',
    cite: 'OR Art. 959b Abs. 2 Ziff. 1',
    labels: {
      de: 'Nettoerlöse aus Lieferungen und Leistungen',
      fr: 'Produits nets des ventes de biens et de prestations de services',
      it: 'Importo netto dei ricavi da forniture e prestazioni',
      en: 'Net revenue from goods and services',
    },
  },
  {
    key: 'bestandes_aenderungen',
    nature: 'mixed',
    cite: 'OR Art. 959b Abs. 2 Ziff. 2',
    labels: {
      de: 'Bestandesänderungen an unfertigen und fertigen Erzeugnissen sowie an nicht fakturierten Dienstleistungen',
      fr: 'Variation des stocks de produits finis et semi-finis et variation des prestations de services non facturées',
      it: 'Variazione delle scorte di prodotti finiti e in corso di fabbricazione e delle prestazioni di servizi non fatturate',
      en: 'Change in inventories of finished and unfinished goods and in unbilled services',
    },
  },
  {
    key: 'materialaufwand',
    nature: 'expense',
    cite: 'OR Art. 959b Abs. 2 Ziff. 3',
    labels: {
      de: 'Materialaufwand',
      fr: 'Charges de matériel',
      it: 'Costi per il materiale',
      en: 'Material expenses',
    },
  },
  {
    key: 'personalaufwand',
    nature: 'expense',
    cite: 'OR Art. 959b Abs. 2 Ziff. 4',
    labels: {
      de: 'Personalaufwand',
      fr: 'Charges de personnel',
      it: 'Costi per il personale',
      en: 'Personnel expenses',
    },
  },
  {
    key: 'uebriger_betrieblicher_aufwand',
    nature: 'expense',
    cite: 'OR Art. 959b Abs. 2 Ziff. 5',
    labels: {
      de: 'Übriger betrieblicher Aufwand',
      fr: "Autres charges d'exploitation",
      it: "Altri costi d'esercizio",
      en: 'Other operating expenses',
    },
  },
  {
    key: 'abschreibungen',
    nature: 'expense',
    cite: 'OR Art. 959b Abs. 2 Ziff. 6',
    labels: {
      de: 'Abschreibungen und Wertberichtigungen auf Positionen des Anlagevermögens',
      fr: "Amortissements et corrections de valeur sur les postes de l'actif immobilisé",
      it: "Ammortamenti e rettifiche di valore sulle poste dell'attivo fisso",
      en: 'Depreciation and value adjustments on non-current assets',
    },
  },
  {
    key: 'finanzergebnis',
    nature: 'mixed',
    cite: 'OR Art. 959b Abs. 2 Ziff. 7',
    labels: {
      de: 'Finanzaufwand und Finanzertrag',
      fr: 'Charges et produits financiers',
      it: 'Costi e ricavi finanziari',
      en: 'Financial expenses and financial income',
    },
  },
  {
    key: 'betriebsfremder_erfolg',
    nature: 'mixed',
    cite: 'OR Art. 959b Abs. 2 Ziff. 8',
    labels: {
      de: 'Betriebsfremder Aufwand und betriebsfremder Ertrag',
      fr: 'Charges et produits hors exploitation',
      it: "Costi e ricavi estranei all'esercizio",
      en: 'Non-operating expenses and non-operating income',
    },
  },
  {
    key: 'ausserordentlicher_erfolg',
    nature: 'mixed',
    cite: 'OR Art. 959b Abs. 2 Ziff. 9',
    labels: {
      de: 'Ausserordentlicher, einmaliger oder periodenfremder Aufwand und Ertrag',
      fr: 'Charges et produits exceptionnels, uniques ou hors période',
      it: 'Costi e ricavi straordinari, unici o relativi ad altri periodi contabili',
      en: 'Extraordinary, non-recurring or prior-period expenses and income',
    },
  },
  {
    key: 'direkte_steuern',
    nature: 'expense',
    cite: 'OR Art. 959b Abs. 2 Ziff. 10',
    labels: {
      de: 'Direkte Steuern',
      fr: 'Impôts directs',
      it: 'Imposte dirette',
      en: 'Direct taxes',
    },
  },
  {
    key: 'uebrige_positionen',
    nature: 'mixed',
    cite: 'OR Art. 959b Abs. 5',
    labels: {
      de: 'Übrige Positionen',
      fr: 'Autres postes',
      it: 'Altre poste',
      en: 'Other positions',
    },
  },
];

/** The number of statutory (non-residual) positions OR Art. 959b Abs. 2 prescribes as accounts. */
export const STATUTORY_ERFOLG_POSITIONS = 10;

/** How many positions one Absatz of a Mindestgliederung article prescribes, and how many A08 models. */
export interface OrArticleCoverage {
  /** Positions the Absatz requires "einzeln und in der vorgegebenen Reihenfolge". */
  requiredPositions: number;
  /** How many of those A08 emits BY NAME. Equal to `requiredPositions` only when nothing is missing. */
  modelledPositions: number;
}

/**
 * The COVERAGE LEDGER: what A08 may honestly say it implements, per Absatz, in numbers.
 *
 * The docblock at the top of this file explains the Bilanz gap in prose, and prose is exactly what a
 * tool description can contradict without anything going red. A description that opened "in the OR
 * Art. 959a minimum structure" shipped for a whole capability while the paragraph above said the
 * article "is not" implemented, because nothing connected the two. This table is that connection:
 * `test/reports/statutory-claims.test.mjs` reads every registered tool description, finds the article
 * conformance claims, and looks them up HERE. A claim on an Absatz whose two numbers differ is red.
 *
 * The counts are read off the consolidated Obligationenrecht (SR 220) at fedlex.admin.ch, the
 * 2026-01-01 consolidation, re-fetched and recounted 2026-07-26:
 *
 *  - **959a Abs. 1**, Aktiven: Ziff. 1 Umlaufvermögen lit. a to e (5) plus Ziff. 2 Anlagevermögen
 *    lit. a to e (5) = 10. `BILANZ_SECTIONS` models Ziff. 1 and Ziff. 2 themselves, which are the
 *    GROUPINGS and not the positions, so nothing on this Absatz is modelled by name.
 *  - **959a Abs. 2**, Passiven: Ziff. 1 lit. a to d (4) plus Ziff. 2 lit. a to c (3) plus Ziff. 3
 *    lit. a to g (7) = 14. Two are modelled, lit. f and lit. g, and only because the Bilanz cannot
 *    foot without them (`COMPUTED_EQUITY_LINES`), not because the sub-level is implemented.
 *  - 10 + 14 = the 24 the file docblock names, and `test/reports/or-structure.test.mjs` transcribes
 *    all 24 and asserts 22 of them unmodelled, from the statutory text rather than from this count.
 *  - **959b Abs. 2**, Produktionserfolgsrechnung: a FLAT list of eleven, no sub-level. Ten are
 *    account-backed sections and the eleventh is the result (`reingewinnMinor`), so all eleven are
 *    modelled and this Absatz is the one claim A08 can make in full. The eleventh carried an
 *    asterisk until 2026-07-26: it was modelled as a figure but the exported Erfolgsrechnung headed
 *    it "Reingewinn oder Reinverlust", the conventional Treuhand wording, while the statute enacts
 *    "Jahresgewinn oder Jahresverlust" and the Bilanz printed that same figure under the enacted
 *    name at Abs. 2 Ziff. 3 lit. g. `export.ts` now prints the enacted wording, resolved by sign,
 *    so this 11 no longer rests on a heading the article does not know.
 *  - **959b Abs. 3**, Absatzerfolgsrechnung: eight positions, none built (A08 ships the
 *    Gesamtkostenverfahren only). Declared rather than omitted, so a future claim on it goes red
 *    instead of going unnoticed.
 *
 * Abs. 959a Abs. 3 and 959b Abs. 5 are deliberately ABSENT: they prescribe no enumerated positions,
 * only "weitere Positionen ... sofern wesentlich", which is a materiality judgement A08 does not
 * make. An unknown key is a failure in the guard, not a pass, so naming one of those in a
 * conformance claim goes red and has to be argued rather than assumed.
 */
export const OR_ARTICLE_COVERAGE: Readonly<Record<string, OrArticleCoverage>> = {
  'OR Art. 959a Abs. 1': { requiredPositions: 10, modelledPositions: 0 },
  'OR Art. 959a Abs. 2': { requiredPositions: 14, modelledPositions: 2 },
  'OR Art. 959b Abs. 2': { requiredPositions: 11, modelledPositions: 11 },
  'OR Art. 959b Abs. 3': { requiredPositions: 8, modelledPositions: 0 },
};

/**
 * The leading integer of an account number, or `null` when it has none.
 *
 * `number` is free text, so `Sonderkonto` and `1000a` both have to be survivable. `1000a` yields
 * 1000, which is the answer a bookkeeper would give; `Sonderkonto` yields null and lands in the
 * residual position. Parsing with `Number()` instead would turn `1000a` into NaN and silently move a
 * cash account into "Übrige Aktiven".
 */
export function accountNumberValue(number: string): number | null {
  const match = /^\s*(\d{1,9})/.exec(number);
  return match === null ? null : Number(match[1]);
}

/**
 * Scale a number to its four-digit position, so a chart using 6 or 8 digits still classifies.
 *
 * The Kontenrahmen KMU is four-digit and the ranges below are written in four digits. A workspace
 * that numbers `600000` for Miete would otherwise fall past every range into the residual. Dividing
 * down to the 1000..9999 band keeps the leading digits, which are the only thing the class map ever
 * looks at. A number SHORTER than four digits (`60`) is scaled up for the same reason.
 */
function toFourDigits(value: number): number | null {
  if (value <= 0) return null;
  let scaled = value;
  while (scaled >= 10000) scaled = Math.floor(scaled / 10);
  while (scaled < 1000) scaled *= 10;
  return scaled;
}

/** The four-digit class position of an account number, or `null` when it has none. */
export function classPosition(number: string): number | null {
  const value = accountNumberValue(number);
  return value === null ? null : toFourDigits(value);
}

/**
 * Which Bilanz section an account belongs to. TOTAL over the three balance-sheet types.
 *
 * The number ranges are the Kontenrahmen KMU's own: 10-13 Umlaufvermögen and 14-19 Anlagevermögen
 * (OR Art. 959a Abs. 1's liquidity split), 20-23 kurzfristiges and 24-27 langfristiges Fremdkapital
 * (Abs. 2's maturity split, with 2300 passive Rechnungsabgrenzungen short per Abs. 2 Ziff. 1 lit. d
 * and 2600 Rückstellungen long per Ziff. 2 lit. c). Equity is decided by TYPE and not by number,
 * because the equity block sits inside the 2xxx range and only the type tells it apart.
 */
export function bilanzSectionFor(account: { number: string; type: AccountType }): string {
  if (account.type === 'equity') return 'eigenkapital';
  const position = classPosition(account.number);
  if (account.type === 'asset') {
    if (position === null) return 'uebrige_aktiven';
    if (position >= 1000 && position < 1400) return 'umlaufvermoegen';
    if (position >= 1400 && position < 2000) return 'anlagevermoegen';
    return 'uebrige_aktiven';
  }
  // Liability.
  if (position === null) return 'uebrige_passiven';
  if (position >= 2000 && position < 2400) return 'kurzfristiges_fremdkapital';
  if (position >= 2400 && position < 2800) return 'langfristiges_fremdkapital';
  return 'uebrige_passiven';
}

/**
 * Which Erfolgsrechnung position an account belongs to. TOTAL over the two result types.
 *
 * The ranges are the Kontenrahmen KMU's classes read against OR Art. 959b Abs. 2: 30-38 revenue and
 * its Erlösminderungen are one NET position (Ziff. 1 says "Nettoerlöse", so a discount belongs in it
 * and not in an expense line), 39 Bestandesänderungen (Ziff. 2), 4 Material (Ziff. 3), 5 Personal
 * (Ziff. 4), 60-67 übriger betrieblicher Aufwand (Ziff. 5), 68 Abschreibungen (Ziff. 6), 69
 * Finanzergebnis (Ziff. 7), 7 betriebsfremd (Ziff. 8), 80-88 ausserordentlich (Ziff. 9), 89 direkte
 * Steuern (Ziff. 10). Class 9 is the Abschluss class and belongs to no statement position, so it
 * falls to the residual rather than being folded into a neighbour.
 */
export function erfolgSectionFor(account: { number: string }): string {
  const position = classPosition(account.number);
  if (position === null) return 'uebrige_positionen';
  if (position >= 3000 && position < 3900) return 'netto_erloese';
  if (position >= 3900 && position < 4000) return 'bestandes_aenderungen';
  if (position >= 4000 && position < 5000) return 'materialaufwand';
  if (position >= 5000 && position < 6000) return 'personalaufwand';
  if (position >= 6000 && position < 6800) return 'uebriger_betrieblicher_aufwand';
  if (position >= 6800 && position < 6900) return 'abschreibungen';
  if (position >= 6900 && position < 7000) return 'finanzergebnis';
  if (position >= 7000 && position < 8000) return 'betriebsfremder_erfolg';
  if (position >= 8000 && position < 8900) return 'ausserordentlicher_erfolg';
  if (position >= 8900 && position < 9000) return 'direkte_steuern';
  return 'uebrige_positionen';
}

/**
 * The Kontenrahmen KMU class of an account (`'1'`..`'9'`), the default `groupBy` bucket for the
 * working papers (Saldenbilanz and Kontoblatt). `'?'` for a number with no leading digit.
 */
export function kmuClassOf(number: string): string {
  const position = classPosition(number);
  return position === null ? '?' : String(Math.floor(position / 1000));
}

/** The de-CH / fr / it / en labels of a KMU class, for the Saldenbilanz grouping header. */
export const KMU_CLASS_LABELS: Readonly<Record<string, SectionLabels>> = {
  '1': { de: 'Aktiven', fr: 'Actifs', it: 'Attivi', en: 'Assets' },
  '2': { de: 'Passiven', fr: 'Passifs', it: 'Passivi', en: 'Liabilities and equity' },
  '3': { de: 'Betrieblicher Ertrag', fr: "Produits d'exploitation", it: "Ricavi d'esercizio", en: 'Operating income' },
  '4': { de: 'Materialaufwand', fr: 'Charges de matériel', it: 'Costi per il materiale', en: 'Material expenses' },
  '5': { de: 'Personalaufwand', fr: 'Charges de personnel', it: 'Costi per il personale', en: 'Personnel expenses' },
  '6': {
    de: 'Übriger betrieblicher Aufwand',
    fr: "Autres charges d'exploitation",
    it: "Altri costi d'esercizio",
    en: 'Other operating expenses',
  },
  '7': {
    de: 'Betrieblicher Nebenerfolg',
    fr: 'Résultat accessoire',
    it: "Risultato accessorio",
    en: 'Ancillary operating result',
  },
  '8': {
    de: 'Ausserordentlicher Erfolg und Steuern',
    fr: 'Résultat exceptionnel et impôts',
    it: 'Risultato straordinario e imposte',
    en: 'Extraordinary result and taxes',
  },
  '9': { de: 'Abschluss', fr: 'Clôture', it: 'Chiusura', en: 'Closing' },
  '?': { de: 'Ohne Klasse', fr: 'Sans classe', it: 'Senza classe', en: 'Unclassified' },
};
