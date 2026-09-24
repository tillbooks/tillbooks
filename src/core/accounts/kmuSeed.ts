/**
 * A curated CORE Swiss SME chart of accounts, in de-CH / fr / it / en.
 *
 * PROVENANCE (owner decision D1, 2026-07-19). This dataset is clean-room:
 *
 * 1. **The 4-digit account NUMBERS are the standard Swiss SME numbering.** Numbers are
 *    unprotectable (they carry no individual character under URG Art. 2), and interoperability with
 *    every Treuhänder, every export, and every competing package depends on them staying put.
 * 2. **The STRUCTURE follows OR Art. 959a (Mindestgliederung der Bilanz) and OR Art. 959b
 *    (Mindestgliederung der Erfolgsrechnung).** Statutes are excluded from copyright by URG
 *    Art. 5(1)(a), and the structure is in any case mandated by law, not chosen by anyone.
 * 3. **The LABELS are our own wording.** Where OR Art. 959a/959b prescribes a heading, we use the
 *    statutory heading verbatim in each of the four languages (the safest possible ground: it is
 *    public domain and it is what an auditor reads). Where the statute is silent, the label is
 *    TILL's own de-CH / fr / it / en wording.
 * 4. **No third-party chart was reproduced.** No text from the veb.ch "Schweizer Kontenrahmen KMU"
 *    or its Schulkontenrahmen PDF was copied, quoted, or ingested for this file, and neither was
 *    any label from Odoo `l10n_ch`, the ERPNext chart JSON, or Gäld. The two VAT input-tax labels
 *    (1170, 1171) follow the ESTV MWST-Abrechnung form headings for Ziffer 400 and Ziffer 405,
 *    which are federal-authority text.
 *
 * That note is the audit trail. If the provenance of a label is ever questioned, this is the answer.
 *
 * The money-path-critical accounts stay separately fixture-pinned by number + type: the equity carry
 * block (2800/2850/2970/2979) is A03's year-close targets, and the VAT accounts (1170/1171/2200/2201)
 * are what A05 posts through. The number-range type mapping is enforced by test: 1xxx asset, 2xxx
 * liability EXCEPT the equity block equity, 3xxx income, 4xxx-6xxx expense.
 *
 * This is a representative CORE, not a closed chart: it is a customizable DEFAULT, and A01
 * `createAccount`/`updateAccount` let any workspace add or rename accounts freely on top of it
 * (verified by the fixture test).
 *
 * de-CH house style: real umlauts, and Swiss German has no sharp-s at all.
 *
 * `cc` marks accounts that may carry a cost centre (income and expense, not balance-sheet).
 */

export type AccountType = 'asset' | 'liability' | 'equity' | 'income' | 'expense';

export const ACCOUNT_TYPES: ReadonlySet<AccountType> = new Set([
  'asset',
  'liability',
  'equity',
  'income',
  'expense',
]);

/** The four shipped label languages. `de` is the de-CH default `name`. */
export interface SeedAccountLabels {
  de: string;
  fr: string;
  it: string;
  en: string;
}

export interface SeedAccount {
  number: string;
  /** de-CH label, the default `account.name`. Single-sourced from `labels.de`. */
  name: string;
  labels: SeedAccountLabels;
  type: AccountType;
  costCenterAllowed: boolean;
}

const cc = true;

function acc(
  number: string,
  type: AccountType,
  costCenterAllowed: boolean,
  de: string,
  fr: string,
  it: string,
  en: string,
): SeedAccount {
  return { number, name: de, labels: { de, fr, it, en }, type, costCenterAllowed };
}

export const KMU_CORE_SEED: readonly SeedAccount[] = [
  // 1xxx Aktiven. OR Art. 959a Abs. 1: Umlaufvermögen by liquidity, then Anlagevermögen.
  acc('1000', 'asset', false,
    'Kassenbestand',
    'Espèces en caisse',
    'Contanti in cassa',
    'Cash on hand'),
  acc('1020', 'asset', false,
    'Bankkonto',
    'Compte bancaire',
    'Conto bancario',
    'Bank account'),
  acc('1060', 'asset', false,
    'Kurzfristig gehaltene Wertpapiere',
    'Titres détenus à court terme',
    'Titoli detenuti a breve termine',
    'Short-term securities'),
  // OR Art. 959a Abs. 1 Ziff. 1 lit. b, statutory heading in all four languages.
  acc('1100', 'asset', false,
    'Forderungen aus Lieferungen und Leistungen',
    'Créances résultant de la vente de biens et de prestations de services',
    'Crediti da forniture e prestazioni',
    'Trade receivables'),
  acc('1109', 'asset', false,
    'Wertberichtigung auf Forderungen',
    'Correctif de valeur sur créances',
    'Rettifica di valore su crediti',
    'Allowance for doubtful receivables'),
  // 1170 / 1171 follow the ESTV MWST-Abrechnung headings for Ziffer 400 / Ziffer 405.
  acc('1170', 'asset', false,
    'Vorsteuer auf Material- und Dienstleistungsaufwand',
    'Impôt préalable sur charges de matériel et de services',
    'Imposta precedente su costi per materiale e prestazioni',
    'Input VAT on material and service costs'),
  acc('1171', 'asset', false,
    'Vorsteuer auf Investitionen und übrigem Betriebsaufwand',
    "Impôt préalable sur investissements et autres charges d'exploitation",
    "Imposta precedente su investimenti e altri costi d'esercizio",
    'Input VAT on investments and other operating costs'),
  acc('1176', 'asset', false,
    'Guthaben Verrechnungssteuer',
    "Créance d'impôt anticipé",
    "Credito d'imposta preventiva",
    'Withholding tax receivable'),
  acc('1200', 'asset', false,
    'Vorräte Handelswaren',
    'Stocks de marchandises',
    'Scorte di merci',
    'Merchandise inventory'),
  // OR Art. 959a Abs. 1 Ziff. 1 lit. e, statutory heading.
  acc('1300', 'asset', false,
    'Aktive Rechnungsabgrenzung',
    'Actifs de régularisation',
    'Ratei e risconti attivi',
    'Accrued income and prepaid expenses'),
  acc('1500', 'asset', false,
    'Maschinen und Produktionsanlagen',
    'Machines et installations de production',
    'Macchine e impianti di produzione',
    'Machinery and production equipment'),
  acc('1510', 'asset', false,
    'Betriebseinrichtungen und Mobiliar',
    "Installations d'exploitation et mobilier",
    'Installazioni aziendali e mobilio',
    'Fixtures and furniture'),
  acc('1520', 'asset', false,
    'Informatik- und Kommunikationsanlagen',
    'Équipements informatiques et de communication',
    'Apparecchiature informatiche e di comunicazione',
    'IT and communication equipment'),
  acc('1530', 'asset', false,
    'Fahrzeuge',
    'Véhicules',
    'Veicoli',
    'Vehicles'),

  // 2xxx Passiven, then the equity block. OR Art. 959a Abs. 2.
  // OR Art. 959a Abs. 2 Ziff. 1 lit. a, statutory heading.
  acc('2000', 'liability', false,
    'Verbindlichkeiten aus Lieferungen und Leistungen',
    "Dettes résultant de l'achat de biens et de prestations de services",
    'Debiti per forniture e prestazioni',
    'Trade creditors'),
  acc('2100', 'liability', false,
    'Kurzfristige Bankschulden',
    'Dettes bancaires à court terme',
    'Debiti bancari a breve termine',
    'Short-term bank liabilities'),
  acc('2200', 'liability', false,
    'Geschuldete MWST auf Erlösen',
    "TVA due sur le chiffre d'affaires",
    "IVA dovuta sulla cifra d'affari",
    'VAT payable on revenue'),
  acc('2201', 'liability', false,
    'MWST-Abrechnung mit der ESTV',
    "Décompte TVA avec l'AFC",
    "Rendiconto IVA con l'AFC",
    'VAT settlement account with the FTA'),
  // Übrige kurzfristige Verbindlichkeiten (OR Art. 959a Abs. 2 Ziff. 1 lit. c). The statute is
  // silent on this sub-line, so the label is TILL's own clean-room wording. Amounts the workspace
  // owes its OWN staff (E02 Spesen reimbursements, D95, 2026-08-05), kept OFF 2000 Kreditoren so
  // vendor AP aging never commingles employees with suppliers. The canonical KMU number 2270 is the
  // social-insurance/pension current account ("Sozialversicherungen und Vorsorgeeinrichtungen"), so
  // this employee-payable takes the free 2260 slot in the same "übrige kurzfristige" group instead.
  acc('2260', 'liability', false,
    'Verbindlichkeiten gegenüber Personal',
    'Dettes envers le personnel',
    'Debiti verso il personale',
    'Payables to employees'),
  // OR Art. 959a Abs. 2 Ziff. 1 lit. d, statutory heading.
  acc('2300', 'liability', false,
    'Passive Rechnungsabgrenzung',
    'Passifs de régularisation',
    'Ratei e risconti passivi',
    'Deferred income and accrued expenses'),
  // A38 (D129 Q4): the SHORT-TERM provisions the Rückstellung verbs and the tax helper post to.
  // OR Art. 959a Abs. 2 has no separate heading for it (short-term provisions fall under Ziff. 1
  // lit. c, übrige kurzfristige Verbindlichkeiten; the statutory "Rückstellungen" heading is Ziff. 2
  // lit. c and stays on 2600 below), so this label is TILL's own wording on the standard number.
  acc('2330', 'liability', false,
    'Kurzfristige Rückstellungen',
    'Provisions à court terme',
    'Accantonamenti a breve termine',
    'Short-term provisions'),
  acc('2400', 'liability', false,
    'Langfristige Bankschulden',
    'Dettes bancaires à long terme',
    'Debiti bancari a lungo termine',
    'Long-term bank liabilities'),
  acc('2450', 'liability', false,
    'Langfristige Darlehen',
    'Prêts à long terme',
    'Prestiti a lungo termine',
    'Long-term loans'),
  // OR Art. 959a Abs. 2 Ziff. 2 lit. c, statutory heading (shortened to the noun).
  acc('2600', 'liability', false,
    'Rückstellungen',
    'Provisions',
    'Accantonamenti',
    'Provisions'),
  // OR Art. 959a Abs. 2 Ziff. 3 lit. a, statutory heading.
  acc('2800', 'equity', false,
    'Grund-, Gesellschafter- oder Stiftungskapital',
    'Capital social ou capital de la fondation',
    'Capitale sociale o capitale della fondazione',
    'Basic, shareholder or foundation capital'),
  acc('2850', 'equity', false,
    'Privatkonto',
    'Compte privé',
    'Conto privato',
    "Owner's drawings account"),
  // OR Art. 959a Abs. 2 Ziff. 3 lit. f, statutory heading.
  acc('2970', 'equity', false,
    'Gewinnvortrag oder Verlustvortrag',
    'Bénéfice ou perte reporté',
    'Utile o perdita riportati',
    'Profit carried forward or loss carried forward'),
  // OR Art. 959a Abs. 2 Ziff. 3 lit. g / Art. 959b Abs. 2 Ziff. 11, statutory heading.
  acc('2979', 'equity', false,
    'Jahresgewinn oder Jahresverlust',
    "Bénéfice ou perte de l'exercice",
    "Utile o perdita dell'esercizio",
    'Annual profit or annual loss'),

  // 3xxx Ertrag. OR Art. 959b Abs. 2 Ziff. 1 splits net revenue from supplies and services.
  acc('3000', 'income', cc,
    'Erlöse aus eigener Produktion',
    'Produits de la production propre',
    'Ricavi da produzione propria',
    'Revenue from own production'),
  acc('3200', 'income', cc,
    'Erlöse aus Handelswaren',
    'Produits de la vente de marchandises',
    'Ricavi dalla vendita di merci',
    'Revenue from merchandise sales'),
  acc('3400', 'income', cc,
    'Erlöse aus Dienstleistungen',
    'Produits des prestations de services',
    'Ricavi da prestazioni di servizi',
    'Revenue from services'),
  acc('3600', 'income', cc,
    'Übrige betriebliche Erlöse',
    "Autres produits d'exploitation",
    "Altri ricavi d'esercizio",
    'Other operating revenue'),
  acc('3800', 'income', cc,
    'Rabatte, Skonti und Gutschriften',
    'Rabais, escomptes et notes de crédit',
    'Ribassi, sconti e note di credito',
    'Discounts, rebates and credit notes'),
  // The P&L counterpart of 1109. A residual a customer never paid is a LOSS on the receivable, and
  // it is a different economic event from a discount the business chose to grant: absorbing it into
  // 3800 would report a bad debt as a price concession. A14 write-offs resolve this account.
  acc('3805', 'income', cc,
    'Verluste aus Forderungen und Veränderung der Wertberichtigung',
    'Pertes sur créances et variation du correctif de valeur',
    'Perdite su crediti e variazione della rettifica di valore',
    'Losses on receivables and change in the allowance'),
  // The REALISED currency difference on clearing a RECEIVABLE, which A14 posts when an invoice
  // booked at one day's rate is paid at another's. It belongs in the Erlösminderungen next to 3800
  // and 3805 because settling a trade receivable is operating activity: the financial-result
  // accounts (6949 below and its gain twin 6999) are for revaluing FINANCIAL positions, which is
  // A22's period-end job and a different event. The account is bidirectional by convention, so a
  // gain and a loss net here without either being renamed, and the label says "Differenzen" rather
  // than naming one direction for exactly that reason.
  acc('3806', 'income', cc,
    'Kursdifferenzen auf Forderungen',
    'Différences de change sur créances',
    'Differenze di cambio su crediti',
    'Exchange rate differences on receivables'),
  // A38 (D129 Q3): the Ertragsminderung a Saldosteuersatz workspace books its MWST due against
  // (Dr 3809 / Cr 2201) when a filed period is settled. An income account by class and a
  // contra-revenue by convention, so the net Erlös after Saldosteuer reads off the Erfolgsrechnung.
  // TILL's own wording (D129); no Kontenrahmen text was reproduced.
  acc('3809', 'income', cc,
    'Ertragsminderung MWST Saldosteuersatz',
    'Réduction de produits TVA taux de la dette fiscale nette',
    'Riduzione ricavi IVA aliquota saldo',
    'Revenue reduction net tax rate VAT'),

  // 4xxx-6xxx Aufwand. OR Art. 959b Abs. 2 Ziff. 3 to 10.
  acc('4000', 'expense', cc,
    'Materialaufwand Fertigung',
    'Charges de matériel de fabrication',
    'Costi per il materiale di produzione',
    'Production material costs'),
  acc('4200', 'expense', cc,
    'Einkauf Handelswaren',
    'Achats de marchandises',
    'Acquisto di merci',
    'Merchandise purchases'),
  acc('4400', 'expense', cc,
    'Bezogene Fremdleistungen',
    'Prestations de tiers',
    'Prestazioni di terzi',
    'Third-party services purchased'),
  // The purchase-side mirror of 3800: the standard chart collects every Aufwandminderung (Skonti,
  // Rabatte) in 4900 exactly as it collects every Erlösminderung in 3800. A Skonto the business
  // takes on a supplier bill reduces COST, so it must not be booked through 3800, which would
  // inflate turnover and expenses at the same time.
  acc('4900', 'expense', cc,
    'Erhaltene Rabatte und Skonti',
    'Rabais et escomptes obtenus',
    'Ribassi e sconti ottenuti',
    'Discounts and rebates received'),
  // 3806's purchase-side twin, and it exists for the same reason 4900 does: a difference realised
  // on clearing a PAYABLE adjusts what the goods actually cost, so it is an Einkaufspreisminderung.
  // Booking it through 3806 would move a purchase adjustment across into revenue.
  acc('4906', 'expense', cc,
    'Kursdifferenzen auf Verbindlichkeiten',
    'Différences de change sur dettes',
    'Differenze di cambio su debiti',
    'Exchange rate differences on payables'),
  acc('5000', 'expense', cc,
    'Löhne und Gehälter',
    'Salaires et traitements',
    'Salari e stipendi',
    'Wages and salaries'),
  acc('5700', 'expense', cc,
    'Sozialversicherungsbeiträge Arbeitgeber',
    "Cotisations sociales de l'employeur",
    'Contributi sociali del datore di lavoro',
    'Employer social security contributions'),
  acc('5800', 'expense', cc,
    'Übrige Personalkosten',
    'Autres frais de personnel',
    'Altri costi del personale',
    'Other personnel costs'),
  acc('6000', 'expense', cc,
    'Miete und Nebenkosten Geschäftsräume',
    'Loyer et charges des locaux commerciaux',
    'Affitto e spese accessorie dei locali commerciali',
    'Rent and utilities for business premises'),
  acc('6100', 'expense', cc,
    'Unterhalt und Reparaturen an Anlagen',
    'Entretien et réparations des installations',
    'Manutenzione e riparazioni degli impianti',
    'Maintenance and repairs of equipment'),
  acc('6200', 'expense', cc,
    'Fahrzeug- und Transportkosten',
    'Frais de véhicules et de transport',
    'Costi di veicoli e trasporto',
    'Vehicle and transport costs'),
  acc('6300', 'expense', cc,
    'Versicherungen, Gebühren und Bewilligungen',
    'Assurances, taxes et autorisations',
    'Assicurazioni, tasse e autorizzazioni',
    'Insurance, fees and permits'),
  acc('6400', 'expense', cc,
    'Energie und Entsorgung',
    'Énergie et élimination des déchets',
    'Energia e smaltimento',
    'Energy and waste disposal'),
  acc('6500', 'expense', cc,
    'Verwaltungs- und Bürokosten',
    "Frais d'administration et de bureau",
    'Costi amministrativi e di ufficio',
    'Administrative and office costs'),
  acc('6570', 'expense', cc,
    'Informatik, Software und Lizenzen',
    'Informatique, logiciels et licences',
    'Informatica, software e licenze',
    'IT, software and licences'),
  acc('6600', 'expense', cc,
    'Werbung und Marketing',
    'Publicité et marketing',
    'Pubblicità e marketing',
    'Advertising and marketing'),
  // OR Art. 959b Abs. 2 Ziff. 5, statutory heading.
  acc('6700', 'expense', cc,
    'Übriger betrieblicher Aufwand',
    "Autres charges d'exploitation",
    "Altri costi d'esercizio",
    'Other operating expenses'),
  // OR Art. 959b Abs. 2 Ziff. 6, statutory heading.
  acc('6800', 'expense', cc,
    'Abschreibungen und Wertberichtigungen auf Positionen des Anlagevermögens',
    "Amortissements et corrections de valeur sur les postes de l'actif immobilisé",
    "Ammortamenti e rettifiche di valore sulle poste dell'attivo fisso",
    'Depreciation and value adjustments on fixed assets'),
  // OR Art. 959b Abs. 2 Ziff. 7, statutory heading (the expense half).
  acc('6900', 'expense', cc,
    'Finanzaufwand',
    'Charges financières',
    'Costi finanziari',
    'Financial expenses'),
  // The currency loss on a FINANCIAL position, revalued at period end. That is A22's event, not
  // A14's: a trade settlement realises its difference in the operating blocks (3806 and 4906
  // above), because a receivable a customer paid late is not a financial investment. In the
  // standard numbering 6949 is the LOSS account and 6999 is its gain twin; 6999 is an Ertrag and
  // would break the 4xxx-6xxx expense rule this seed enforces, so the core ships the loss account
  // alone and a gain nets against it as a credit.
  acc('6949', 'expense', cc,
    'Währungsverluste',
    'Pertes de change',
    'Perdite di cambio',
    'Currency losses'),

  // 8xxx betriebsfremder und ausserordentlicher Erfolg. The core ships ONE account of the class:
  // A38 (D129 Q4) the direct taxes the Steuerrückstellung is charged to (Dr 8900 / Cr 2330), and the
  // account whose debit balance the tax helper reads as the year's provisorische Bezüge. The 8 class
  // mixes Aufwand and Ertrag in the standard numbering; 8900 is an expense, and the seed's
  // number-range rule names the class as such.
  acc('8900', 'expense', cc,
    'Direkte Steuern',
    'Impôts directs',
    'Imposte dirette',
    'Direct taxes'),
];
