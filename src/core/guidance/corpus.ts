/**
 * G17, the Begriffe corpus: the authored, build-time explanation of the product's domain words.
 *
 * THE WORDING OF RECORD. The panel a human reads and the `get_concept` payload an agent cites are
 * this one constant, so the GUI face and the agent face can never explain a binding election in two
 * wordings. It is NOT tenant data, NOT customizable (G00 may not extend, relabel or override it: a
 * workspace-editable explanation of a statutory election would let one operator's wording become
 * another's evidence), and NEVER generated (design §6d: a generated sentence cannot pass a critic
 * gate that has to run before the sentence exists).
 *
 * AUTHORING RULES, each named with the gate that actually enforces it (corpus-critic F2 caught this
 * block claiming more than the gates held; the coverage below is the audited truth):
 *  - ~90 words per locale; NO DIGITS in any body (amounts arrive as interpolation tokens from
 *    era-scoped constants, `SALDO_ELIGIBILITY_ERAS` in `../vat/rateEras.js`; citations live in
 *    `articles`, never inline); no referring construction and no URL (offline-completability,
 *    design §5). Enforced by `test/guidance/corpus.test.mjs`.
 *  - de-CH in the `du` register, real umlauts, never a sharp s, no first person in either locale.
 *    Enforced by `test/guidance/register.test.mjs` over the BUILT corpus (the constant the verbs
 *    serve), with the tracked SOURCE additionally covered by
 *    `test/style/umlaut-transliteration.test.mjs` (its `.ts` string-literal corpus).
 *  - Every entry carries at least one of `seeAlso` or `docsPath` (the no-dead-end floor), at most
 *    four `seeAlso`, every target a corpus key, every `docsPath` a page in `site-docs/docs.json`.
 *    Enforced by `test/guidance/corpus.test.mjs`.
 *  - An entry whose subject TILL does not implement says so plainly (`notImplemented`) in a
 *    sentence where TILL is the subject of a negation, because an explanation that implies
 *    coverage is an outward-facing claim. Enforced by `test/guidance/corpus.test.mjs`.
 *  - An entry citing an article in the `MOVED_ARTICLES` register carries `era` at least as new as
 *    the move (the no-digit lint cannot see a spelled-out rule go stale). Enforced as a RULE
 *    derived from each entry's own citations by `test/guidance/corpus.test.mjs`; when the law
 *    moves, extend `MOVED_ARTICLES` there and the gate names every entry that needs re-reading.
 *
 * The Studio holds a generated projection (`app/src/lib/guidance-corpus.generated.json`, produced by
 * `scripts/generate-guidance-corpus.mjs`) because the browser build has no path into these sources;
 * `test/guidance/studio-corpus-drift.test.mjs` holds the two identical.
 */

/** The locales the corpus is authored in. Mirrors the Studio's `Locale`. */
export type GuidanceLocale = 'de-CH' | 'en';

/** A per-locale string pair. Both locales are mandatory: completeness is a gate, not a hope. */
export interface LocalizedText {
  readonly 'de-CH': string;
  readonly en: string;
}

/** The corpus areas (the palette group's secondary line). `jahresabschluss` joined with leg 2 (D129, G22 §10.10). */
export type ConceptArea = 'mwst' | 'steuern' | 'jahresabschluss';

/** One Begriff. See the module docblock for the authoring rules each field is held to. */
export interface ConceptEntry {
  readonly key: string;
  readonly area: ConceptArea;
  readonly term: LocalizedText;
  readonly body: LocalizedText;
  /** Structured citations, rendered below the body, NEVER inline in it. */
  readonly articles: readonly string[];
  /** Related corpus keys, at most four. Rendered as the panel's related-terms list. */
  readonly seeAlso: readonly string[];
  /** A page id in `site-docs/docs.json`. Absent renders no link at all. */
  readonly docsPath?: string;
  /**
   * Present when a rule the entry states has MOVED at least once: the day the current form took
   * effect and the source it was verified against. The staleness handle the no-digit lint lacks.
   */
  readonly era?: { readonly effectiveFrom: string; readonly source: string };
  /** True when the entry's subject is not implemented by TILL and the body says so. */
  readonly notImplemented?: boolean;
}

/**
 * The nine entries of the A05 worked example (design §8b). The authoring wave extends this list;
 * the shape and the gates do not change with it.
 */
export const CONCEPTS: readonly ConceptEntry[] = [
  {
    key: 'saldosteuersatz',
    area: 'mwst',
    term: { 'de-CH': 'Saldosteuersatz', en: 'Net tax rate (Saldosteuersatz)' },
    body: {
      'de-CH':
        'Mit der Saldosteuersatzmethode rechnest du die MWST vereinfacht ab: Du multiplizierst deinen steuerbaren Umsatz mit einem Saldosteuersatz, den dir die ESTV für deine Branche bewilligt hat. Die Vorsteuer ziehst du nicht separat ab, sie ist im tieferen Satz bereits eingerechnet. Deinen Kundinnen und Kunden stellst du weiterhin den gesetzlichen Satz in Rechnung. Die Methode steht dir offen, solange dein Umsatz und deine Steuer unter den gesetzlichen Grenzen bleiben, und sie bindet dich für mindestens eine Steuerperiode. Den Satz beantragst du bei der ESTV, bevor du wechselst.',
      en: 'Under the net tax rate method you settle VAT in a simplified way: you multiply your taxable turnover by a net tax rate the ESTV has approved for your line of business. You do not deduct input tax separately; it is already built into the lower rate. You still invoice your customers at the statutory rate. The method is open to you while your turnover and your tax stay under the statutory limits, and it binds you for at least one tax period. You apply for the rate at the ESTV before switching.',
    },
    articles: ['MWSTG Art. 37', 'MWST-Info 12'],
    seeAlso: ['effektive-methode', 'vorsteuer', 'bewilligung', 'steuerperiode'],
    docsPath: 'swiss/mwst',
    era: {
      effectiveFrom: '2024-01-01',
      source:
        'MWSTG Art. 37 Abs. 1, fedlex consolidation in force 1.1.2024: both eligibility limits raised with the Steuersatzerhöhung (verified 2026-08-17; the 20230101 text carries the previous pair)',
    },
  },
  {
    key: 'effektive-methode',
    area: 'mwst',
    term: { 'de-CH': 'Effektive Abrechnung', en: 'Effective accounting' },
    body: {
      'de-CH':
        'Bei der effektiven Abrechnung rechnest du die MWST auf deinem Umsatz zum gesetzlichen Satz ab und ziehst die Vorsteuer ab, die dir deine Lieferanten in Rechnung gestellt haben. Geschuldet ist die Differenz. Das ist der gesetzliche Normalfall und braucht keine Bewilligung. Die Methode berücksichtigt deine tatsächliche Vorsteuer; dafür musst du sie mit Belegen nachweisen und getrennt erfassen. Nach einem Wechsel vom Saldosteuersatz zur effektiven Methode kannst du frühestens nach drei Jahren wieder zurück, ein Wechsel gilt jeweils auf Beginn einer Steuerperiode.',
      en: 'Under effective accounting you settle VAT on your turnover at the statutory rate and deduct the input tax your suppliers invoiced you. You owe the difference. This is the statutory default and needs no approval. The method counts your actual input tax; in return you must evidence it with receipts and record it separately. After switching from the net tax rate to the effective method you can return at the earliest after three years, and a switch takes effect only at the start of a tax period.',
    },
    articles: ['MWSTG Art. 36', 'MWSTG Art. 37 Abs. 4'],
    seeAlso: ['saldosteuersatz', 'vorsteuer'],
    docsPath: 'swiss/mwst',
  },
  {
    key: 'vereinbarte-entgelte',
    area: 'mwst',
    term: { 'de-CH': 'Vereinbarte Entgelte (Soll)', en: 'Agreed consideration (accrual)' },
    body: {
      'de-CH':
        'Bei der Abrechnung nach vereinbarten Entgelten wird die MWST fällig, sobald du die Rechnung stellst, auch wenn sie noch nicht bezahlt ist. Massgebend ist das vereinbarte Entgelt, also der Rechnungsbetrag. Das ist der gesetzliche Normalfall, und er passt zur doppelten Buchhaltung, die Forderungen ohnehin bei der Rechnungsstellung erfasst. Zahlt eine Kundin später weniger oder gar nicht, korrigierst du die Abrechnung in der Periode, in der sich das Entgelt ändert. Die gewählte Abrechnungsart behältst du mindestens eine Steuerperiode.',
      en: 'Under accounting on agreed consideration, VAT falls due as soon as you issue the invoice, even if it has not been paid yet. What counts is the agreed consideration, the invoice amount. This is the statutory default, and it matches double-entry bookkeeping, which records receivables at invoicing anyway. If a customer later pays less or nothing at all, you correct the return in the period in which the consideration changes. You keep the chosen accounting basis for at least one tax period.',
    },
    articles: ['MWSTG Art. 39 Abs. 1 und 3'],
    seeAlso: ['vereinnahmte-entgelte', 'steuerperiode'],
    docsPath: 'swiss/mwst',
  },
  {
    key: 'vereinnahmte-entgelte',
    area: 'mwst',
    term: { 'de-CH': 'Vereinnahmte Entgelte (Ist)', en: 'Collected consideration (cash basis)' },
    body: {
      'de-CH':
        'Bei der Abrechnung nach vereinnahmten Entgelten wird die MWST erst fällig, wenn die Zahlung bei dir eingeht. Das entlastet Betriebe, deren Kundschaft spät zahlt, weil du die Steuer nicht vorschiessen musst. Diese Abrechnungsart musst du bei der ESTV beantragen, und du behältst sie mindestens eine Steuerperiode. TILL kann die Abrechnung nach vereinnahmten Entgelten noch nicht berechnen: Ist sie konfiguriert, bricht das Erstellen der Abrechnung ab, damit du keine falsche Zahl einreichst.',
      en: 'Under accounting on collected consideration, VAT falls due only when the payment reaches you. That relieves businesses whose customers pay late, because you do not advance the tax. You must apply to the ESTV for this accounting basis, and you keep it for at least one tax period. TILL cannot compute the return on collected consideration yet: if it is configured, preparing the return refuses, so that you never file a wrong figure.',
    },
    articles: ['MWSTG Art. 39 Abs. 2 und 3'],
    seeAlso: ['vereinbarte-entgelte', 'bewilligung'],
    docsPath: 'swiss/mwst',
    notImplemented: true,
  },
  {
    key: 'steuerperiode',
    area: 'mwst',
    term: { 'de-CH': 'Steuerperiode', en: 'Tax period (Steuerperiode)' },
    body: {
      'de-CH':
        'Die Steuerperiode ist der Zeitraum, für den die MWST insgesamt abgerechnet wird, im Normalfall das Kalenderjahr. Eingereicht wird in Abrechnungsperioden, die Teilstücke der Steuerperiode sind: im Normalfall quartalsweise, unter dem Saldosteuersatz halbjährlich, und auf Antrag bewilligt die ESTV bis zu einer Umsatzgrenze auch die jährliche Abrechnung. Wichtig ist die Steuerperiode, weil Bindungen an ihr gemessen werden: Methode und Abrechnungsart wechselst du nur auf ihren Beginn, und ein gewähltes Verfahren behältst du mindestens eine Steuerperiode lang.',
      en: 'The tax period is the span the VAT is settled for as a whole, normally the calendar year. Filing happens in reporting periods, which are slices of the tax period: normally quarterly, half-yearly under the net tax rate, and on application the ESTV also permits annual filing up to a turnover limit. The tax period matters because commitments are measured against it: you change method and accounting basis only at its start, and you keep an elected regime for at least one tax period.',
    },
    articles: ['MWSTG Art. 34', 'MWSTG Art. 35'],
    seeAlso: ['saldosteuersatz', 'vereinbarte-entgelte'],
    docsPath: 'swiss/mwst',
    era: {
      effectiveFrom: '2025-01-01',
      source:
        'MWSTG Art. 35, revised by BG vom 16. Juni 2023 (AS 2024 438), in force 1.1.2025: the cadence rewritten (quarterly; half-yearly under Saldo, Abs. 1) and the annual option inserted (Abs. 1bis lit. b). Verified 2026-08-18 against the 20250101 consolidation',
    },
  },
  {
    key: 'vorsteuer',
    area: 'mwst',
    term: { 'de-CH': 'Vorsteuer', en: 'Input tax (Vorsteuer)' },
    body: {
      'de-CH':
        'Vorsteuer ist die MWST, die dir deine Lieferanten in Rechnung stellen, wenn du für dein Unternehmen einkaufst. Bei der effektiven Abrechnung ziehst du sie von der Steuer auf deinem Umsatz ab und schuldest nur die Differenz; dafür brauchst du Belege, welche die Steuer ausweisen. Unter dem Saldosteuersatz ziehst du die Vorsteuer nicht separat ab, sie ist im bewilligten Satz pauschal eingerechnet. Ob sich der Saldosteuersatz für dich lohnt, hängt darum stark davon ab, wie viel Vorsteuer bei dir anfällt.',
      en: 'Input tax is the VAT your suppliers charge you when you buy for your business. Under effective accounting you deduct it from the tax on your own turnover and owe only the difference; for that you need receipts showing the tax. Under the net tax rate you do not deduct input tax separately; it is built into the approved rate as a flat allowance. Whether the net tax rate pays off for you therefore depends heavily on how much input tax you incur.',
    },
    articles: ['MWSTG Art. 28'],
    seeAlso: ['effektive-methode', 'saldosteuersatz'],
    docsPath: 'swiss/mwst',
    era: {
      effectiveFrom: '2024-01-01',
      source:
        'MWSTG Art. 28 Abs. 2 (the Urproduzenten flat input-tax deduction) Fassung per V vom 9. Dez. 2022 (AS 2022 863), in force 1.1.2024 with the Steuersatzerhöhung. Verified 2026-08-18 against the 20240101 consolidation',
    },
  },
  {
    key: 'bewilligung',
    area: 'mwst',
    term: { 'de-CH': 'Bewilligung der ESTV', en: 'ESTV approval' },
    body: {
      'de-CH':
        'Eine Bewilligung der ESTV ist die Zusage der Steuerverwaltung, dass du ein bestimmtes Verfahren anwenden darfst. Ein Saldosteuersatz und die Abrechnung nach vereinnahmten Entgelten sind keine Einstellungen, die du einfach wählst: Du beantragst sie bei der ESTV, und erst die Zusage macht sie gültig. TILL erfasst, was bewilligt wurde, und rechnet damit; den Antrag stellst du ausserhalb von TILL. Ob sich ein Verfahren für dich lohnt, ist eine Beratungsfrage: Dafür ist deine Treuhänderin oder dein Treuhänder die richtige Adresse.',
      en: 'An ESTV approval is the tax administration’s confirmation that you may apply a particular regime. A net tax rate and accounting on collected consideration are not settings you simply pick: you apply for them at the ESTV, and only the confirmation makes them valid. TILL records what was approved and computes with it; you file the application outside TILL. Whether a regime pays off for you is an advisory question: your fiduciary is the right address for it.',
    },
    articles: ['MWSTG Art. 37 Abs. 4', 'MWSTG Art. 39 Abs. 2', 'MWSTV Art. 86'],
    seeAlso: ['saldosteuersatz', 'vereinnahmte-entgelte'],
    docsPath: 'swiss/mwst',
    era: {
      effectiveFrom: '2025-01-01',
      source:
        'MWSTV Art. 84 und Art. 86 replaced by V vom 21. August 2024 (AS 2024 485), in force 1.1.2025 (the N-rate model). Art. 86 is "Bewilligung der Saldosteuersätze", the granting article; Art. 84 only governs using the granted rates. Verified 2026-08-18 against the 20250101 consolidation',
    },
  },
  {
    key: 'ziffer',
    area: 'mwst',
    term: { 'de-CH': 'Ziffer', en: 'Ziffer (form line)' },
    body: {
      'de-CH':
        'Eine Ziffer ist die Nummer eines Feldes auf dem MWST-Abrechnungsformular der ESTV. Jede Position der Abrechnung, etwa der Gesamtumsatz, die Abzüge oder die geschuldete Steuer, hat ihre eigene Ziffer, und die ESTV liest die Beträge über diese Nummern ein. TILL zeigt zu den berechneten Positionen die zugehörige Ziffer an, damit du die Zahlen beim Einreichen im ePortal ohne Übersetzungsarbeit zuordnen kannst. Die Ziffern sind eine Formularkonvention der ESTV, kein Gesetzesbegriff, und sie ändern sich, wenn die ESTV das Formular anpasst.',
      en: 'A Ziffer is the number of a field on the ESTV’s VAT return form. Every position of the return, such as total turnover, the deductions or the tax due, has its own Ziffer, and the ESTV reads the amounts in through these numbers. TILL shows the matching Ziffer beside the figures it computes, so you can map the numbers in the ePortal without translation work. The Ziffern are an ESTV form convention, not a legal term, and they change when the ESTV revises the form.',
    },
    articles: ['ESTV-Formularkonvention, kein Gesetzesartikel'],
    seeAlso: ['saldosteuersatz', 'steuerperiode'],
    docsPath: 'swiss/mwst',
    era: {
      effectiveFrom: '2025-01-01',
      source:
        'MWST-Info 12 Ziff. 18.1.4: the Saldo declaration moved to the Beiblatt zu den Ziffern 322 und 323 (Leistungen before and from 1.1.2024 split) with the N-rate model in force 1.1.2025, a different change from the Art. 37 Abs. 1 limit raise',
    },
  },
  {
    key: 'verrechnungssteuer',
    area: 'steuern',
    term: { 'de-CH': 'Verrechnungssteuer', en: 'Withholding tax (Verrechnungssteuer)' },
    body: {
      'de-CH':
        'Die Verrechnungssteuer ist eine Steuer des Bundes auf bestimmten Kapitalerträgen, etwa Zinsen und Dividenden. Sie wird an der Quelle abgezogen: Die Bank oder die Gesellschaft überweist sie direkt an die Steuerverwaltung, und du erhältst den Ertrag gekürzt. Wer den Ertrag ordnungsgemäss deklariert, kann die Steuer zurückfordern oder anrechnen lassen. Mit der MWST hat sie nichts zu tun. TILL führt im Kontenplan ein Konto für das Guthaben aus Verrechnungssteuer und mehr nicht: Rückforderung und Deklaration bildet TILL nicht ab.',
      en: 'Withholding tax is a federal tax on certain capital income, such as interest and dividends. It is deducted at source: the bank or the company transfers it directly to the tax administration, and you receive the income reduced. If you declare the income properly, you can reclaim the tax or have it credited. It has nothing to do with VAT. TILL carries an account for the withholding tax credit in the chart of accounts and nothing more: reclaim and declaration are not represented in TILL.',
    },
    articles: ['VStG (SR 642.21)'],
    seeAlso: ['vorsteuer'],
    notImplemented: true,
  },
  // --- Jahresabschluss (D129 leg 2, G22 §10.10): the nine concepts the guided close explains ------
  {
    key: 'transitorische-aktiven-passiven',
    area: 'jahresabschluss',
    term: { 'de-CH': 'Transitorische Aktiven und Passiven', en: 'Accruals and deferrals (transitorische Aktiven und Passiven)' },
    body: {
      'de-CH':
        'Transitorische Aktiven und Passiven grenzen Aufwand und Ertrag zeitlich ab: Was ins alte Jahr gehört, aber erst im neuen Jahr in Rechnung gestellt oder bezahlt wird, bucht TILL per Jahresende auf ein Abgrenzungskonto und am ersten Tag des neuen Jahres automatisch wieder zurück. Ein Aktivum steht für eine Vorauszahlung oder einen noch nicht fakturierten Ertrag, ein Passivum für einen noch nicht erhaltenen Aufwand oder eine Vorauszahlung eines Kunden. Kleine Betriebe unter der gesetzlichen Erlösschwelle dürfen auf die Abgrenzung verzichten; der Jahresabschluss fragt dich deshalb, ob du sie brauchst.',
      en: 'Accruals and deferrals separate expense and income by period: what belongs to the old year but is only invoiced or paid in the new one, TILL posts at the year end to an accrual account and reverses automatically on the first day of the new year. An active accrual stands for a prepayment or income not yet invoiced, a passive one for an expense not yet received or a customer prepayment. Small businesses below the statutory revenue threshold may forgo accruals, which is why the year close asks whether you need them.',
    },
    articles: ['OR Art. 958b Abs. 1 und Abs. 2 (SR 220)', 'OR Art. 959a Abs. 1 Ziff. 1 lit. d und Abs. 2 Ziff. 1 lit. d'],
    seeAlso: ['rueckstellung', 'jahresabschluss-sperre'],
  },
  {
    key: 'rueckstellung',
    area: 'jahresabschluss',
    term: { 'de-CH': 'Rückstellung', en: 'Provision (Rückstellung)' },
    body: {
      'de-CH':
        'Eine Rückstellung ist ein Aufwand für eine Verpflichtung aus der Vergangenheit, deren Höhe oder Fälligkeit noch offen ist: eine Garantiearbeit, ein hängiger Prozess, eine Grossreparatur. Das Gesetz verlangt sie, wo ein Mittelabfluss wahrscheinlich ist, und erlaubt sie zusätzlich für regelmässig anfallende Kosten und zur Sicherung des dauernden Gedeihens. TILL bucht eine Rückstellung per Jahresende gegen ein Rückstellungskonto, führt ihren offenen Saldo und löst sie später ganz oder teilweise auf. Eine gebuchte Rückstellung wird storniert, nie bearbeitet.',
      en: 'A provision is an expense for an obligation from the past whose amount or timing is still open: a warranty repair, a pending lawsuit, a major overhaul. The law requires one where an outflow is probable and allows one on top for regularly recurring costs and to secure the lasting prosperity of the business. TILL posts a provision at the year end against a provision account, tracks its open balance and releases it later in full or in part. A posted provision is reversed, never edited.',
    },
    articles: ['OR Art. 960e Abs. 2 bis Abs. 4 (SR 220)'],
    seeAlso: ['transitorische-aktiven-passiven', 'steuerrueckstellung'],
  },
  {
    key: 'umsatzabstimmung',
    area: 'jahresabschluss',
    term: { 'de-CH': 'Umsatzabstimmung', en: 'Turnover reconciliation (Umsatzabstimmung)' },
    body: {
      'de-CH':
        'Die Umsatzabstimmung vergleicht den Ertrag deiner Jahresrechnung mit dem Umsatz, den du in den MWST-Abrechnungen des Jahres deklariert hast. Die Verordnung verlangt sie von jeder steuerpflichtigen Person, weil beide Zahlen aus denselben Büchern stammen und eine Differenz auf einen vergessenen Umsatz, einen falschen Steuercode oder eine Abgrenzung zeigt. TILL rechnet sie aus den gebuchten Erträgen und den berechneten Abrechnungen, zieht die Abgrenzungen ab und zählt Anlageverkäufe dazu. Stimmt es nicht, korrigierst du mit der Berichtigungsabrechnung.',
      en: 'The turnover reconciliation compares the revenue of your annual accounts with the turnover you declared in the year\'s VAT returns. The ordinance requires it of every taxable person, because both figures come from the same books and a difference points to a forgotten sale, a wrong tax code or an accrual. TILL computes it from the posted revenue and the computed returns, subtracts the accruals and adds asset disposals. If it does not match, you correct it with the correction return.',
    },
    articles: ['MWSTV Art. 128 Abs. 2 (SR 641.201)', 'MWSTG Art. 72 Abs. 1 (SR 641.20)'],
    seeAlso: ['vorsteuerabstimmung', 'berichtigungsabrechnung', 'steuerperiode'],
    docsPath: 'swiss/mwst',
  },
  {
    key: 'vorsteuerabstimmung',
    area: 'jahresabschluss',
    term: { 'de-CH': 'Vorsteuerabstimmung', en: 'Input tax reconciliation (Vorsteuerabstimmung)' },
    body: {
      'de-CH':
        'Die Vorsteuerabstimmung vergleicht die Vorsteuer, die du im Jahr auf den Vorsteuerkonten gebucht hast, mit der Vorsteuer, die du in den MWST-Abrechnungen zurückgefordert hast. Sie ist das Gegenstück zur Umsatzabstimmung und ebenso vorgeschrieben. Eine Differenz entsteht, wenn eine Rechnung ohne Steuercode gebucht oder eine Abrechnung nach einer Korrektur nicht mehr aktualisiert wurde. TILL liest beide Seiten aus den Büchern; unter der Saldosteuersatzmethode entfällt die Abstimmung, weil dort keine Vorsteuer einzeln abgezogen wird.',
      en: 'The input tax reconciliation compares the input tax you posted to the input tax accounts over the year with the input tax you reclaimed in the VAT returns. It is the counterpart of the turnover reconciliation and just as mandatory. A difference arises when an invoice was posted without a tax code or a return was not updated after a correction. TILL reads both sides from the books; under the net tax rate method the reconciliation does not apply, because no input tax is deducted individually there.',
    },
    articles: ['MWSTV Art. 128 Abs. 3 (SR 641.201)'],
    seeAlso: ['umsatzabstimmung', 'vorsteuer', 'saldosteuersatz'],
    docsPath: 'swiss/mwst',
  },
  {
    key: 'berichtigungsabrechnung',
    area: 'jahresabschluss',
    term: { 'de-CH': 'Berichtigungsabrechnung', en: 'Correction return (Berichtigungsabrechnung)' },
    body: {
      'de-CH':
        'Die Berichtigungsabrechnung ist das Formular, mit dem du der ESTV Fehler in den eingereichten MWST-Abrechnungen eines Jahres meldest, nachdem die Umsatz- und die Vorsteuerabstimmung sie gezeigt haben. Du deklarierst nur die Differenzen, nicht die ganzen Abrechnungen nochmals. Das Gesetz setzt dafür eine Frist nach Ende des Geschäftsjahres; reicht niemand eine Berichtigung ein, gilt die eingereichte Abrechnung als vollständig. TILL nennt dir das Formular und die Frist; einreichen musst du es selbst im ePortal, und bestätigst danach das Datum.',
      en: 'The correction return is the form with which you report errors in the year\'s filed VAT returns to the ESTV once the turnover and input tax reconciliations have revealed them. You declare only the differences, never the whole returns again. The law sets a deadline after the end of the fiscal year; if nobody files a correction, the filed return counts as complete. TILL names the form and the deadline; you file it yourself in the ePortal and then confirm the date.',
    },
    articles: ['MWSTG Art. 72 Abs. 1 und Abs. 2 (SR 641.20)'],
    seeAlso: ['umsatzabstimmung', 'vorsteuerabstimmung', 'ziffer'],
    docsPath: 'swiss/mwst',
  },
  {
    key: 'steuerrueckstellung',
    area: 'jahresabschluss',
    term: { 'de-CH': 'Steuerrückstellung', en: 'Tax provision (Steuerrückstellung)' },
    body: {
      'de-CH':
        'Die Steuerrückstellung ist der Aufwand für die Gewinn- und Kapitalsteuern des Geschäftsjahres, die erst später veranlagt und bezahlt werden. Eine GmbH oder AG bucht sie per Jahresende, damit der ausgewiesene Gewinn nach Steuern stimmt; bei einer Einzelfirma versteuert der Inhaber den Gewinn privat, und das Geschäft bucht nichts. Weil die Steuer vom Gewinn nach Steuern berechnet wird, rechnet TILL den Betrag nach der Formel der Steuerverwaltung aus dem Gewinn vor Steuern und zieht bereits bezahlte Raten ab. Der Satz ist deine Schätzung.',
      en: 'The tax provision is the expense for the profit and capital taxes of the fiscal year that are assessed and paid only later. A GmbH or AG posts it at the year end so that the reported profit after tax is right; in a sole proprietorship the owner is taxed personally and the business posts nothing. Because the tax is computed on the profit after tax, TILL derives the amount from the profit before tax with the tax administration\'s formula and subtracts instalments already paid. The rate is your estimate.',
    },
    articles: ['OR Art. 960e Abs. 2 (SR 220)', 'Zürcher Steuerbuch Nr. 27/1'],
    seeAlso: ['rueckstellung', 'kapitalverlust'],
  },
  {
    key: 'jahresabschluss-sperre',
    area: 'jahresabschluss',
    term: { 'de-CH': 'Jahresabschluss und Sperre', en: 'Year close and seal (Jahresabschluss)' },
    body: {
      'de-CH':
        'Der Jahresabschluss in TILL hat zwei Stufen. Die vorläufige Sperre schliesst die Bücher, während du die Jahresrechnung prüfst und die Generalversammlung wartet; sie lässt sich wieder aufheben. Der endgültige Abschluss überträgt den Gewinn oder Verlust ins Eigenkapital und versiegelt das Geschäftsjahr: Danach kannst du in diesem Jahr nichts mehr buchen und nichts rückgängig machen, und es gibt keinen Weg zurück. Eine spätere Korrektur buchst du im neuen Jahr. Jeder Schritt davor ist mit einer Stornobuchung umkehrbar, nie durch Bearbeiten.',
      en: 'The year close in TILL has two stages. The provisional lock closes the books while you review the annual accounts and the general meeting is pending; it can be lifted again. The final close sweeps the profit or loss into equity and seals the fiscal year: after that you cannot post or undo anything in that year, and there is no way back. A later correction is posted in the new year. Every step before it is reversible with a reversing entry, never by editing.',
    },
    articles: ['OR Art. 958 Abs. 2 und Art. 958f (SR 220)'],
    seeAlso: ['generalversammlung-frist', 'transitorische-aktiven-passiven', 'steuerperiode'],
    docsPath: 'introduction',
  },
  {
    key: 'generalversammlung-frist',
    area: 'jahresabschluss',
    term: { 'de-CH': 'Frist der Generalversammlung', en: 'General meeting deadline (Generalversammlung)' },
    body: {
      'de-CH':
        'Die ordentliche Generalversammlung einer AG und die Gesellschafterversammlung einer GmbH müssen die Jahresrechnung innert sechs Monaten nach Ende des Geschäftsjahres genehmigen. Die Frist steht im Obligationenrecht und ist keine Empfehlung: Wer sie verpasst, riskiert die Handlungsfähigkeit des Verwaltungsrats und eine Beanstandung der Revisionsstelle. TILL rechnet den Termin aus dem Geschäftsjahresende und zeigt ihn als Frist; die Versammlung selbst findet ausserhalb von TILL statt, und du bestätigst danach das Datum. Eine Einzelfirma kennt keine Generalversammlung.',
      en: 'The ordinary general meeting of an AG and the members\' meeting of a GmbH must approve the annual accounts within six months after the end of the fiscal year. The deadline is in the Code of Obligations and is no recommendation: missing it puts the board\'s capacity to act and the auditor\'s report at risk. TILL computes the date from the fiscal year end and shows it as a deadline; the meeting itself takes place outside TILL, and you confirm the date afterwards. A sole proprietorship holds no general meeting.',
    },
    articles: ['OR Art. 699 Abs. 2 (SR 220)', 'OR Art. 805 Abs. 2 (SR 220)'],
    seeAlso: ['jahresabschluss-sperre', 'kapitalverlust'],
  },
  {
    key: 'kapitalverlust',
    area: 'jahresabschluss',
    term: { 'de-CH': 'Kapitalverlust', en: 'Capital loss (Kapitalverlust)' },
    body: {
      'de-CH':
        'Ein Kapitalverlust liegt vor, wenn das Eigenkapital der letzten Jahresrechnung nicht mehr die Hälfte aus Aktien- oder Stammkapital, nicht rückzahlbarer gesetzlicher Kapitalreserve und gesetzlicher Gewinnreserve deckt. Dann muss der Verwaltungsrat Massnahmen zur Beseitigung ergreifen, und eine Gesellschaft ohne Revision muss die Jahresrechnung eingeschränkt prüfen lassen. TILL rechnet die Kennzahl aus den Eigenkapitalkonten und dem Jahresergebnis und weist dich im Jahresabschluss darauf hin; die Überschuldung, eine Stufe weiter, bildet TILL nicht ab.',
      en: 'A capital loss exists when the equity of the last annual accounts no longer covers half of the sum of share capital, non-repayable statutory capital reserve and statutory retained earnings. The board must then take measures to remove it, and a company without an audit must have the annual accounts reviewed in a limited audit. TILL computes the figure from the equity accounts and the year\'s result and points it out in the year close; overindebtedness, one stage further, is not represented in TILL.',
    },
    articles: ['OR Art. 725a Abs. 1 und Abs. 2 (SR 220)'],
    seeAlso: ['generalversammlung-frist', 'steuerrueckstellung'],
  },
];

/** Every corpus key, in authored order. The single list every reference gate checks against. */
export const CONCEPT_KEYS: readonly string[] = CONCEPTS.map((c) => c.key);

/** Resolve one entry, or undefined. Callers wanting a structured miss use `getConcept` (verbs.ts). */
export function conceptByKey(key: string): ConceptEntry | undefined {
  return CONCEPTS.find((c) => c.key === key);
}
