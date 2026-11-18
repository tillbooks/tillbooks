/**
 * D202 (owner, 15.11.2026): HOW A SETTING IS SHOWN AND FOUND, keyed by its registry key.
 *
 * WHY A FILE OF ITS OWN. The registry row (`./registry.ts`) says what a setting IS: its value shape, its
 * default, who may change it. This file says how a person meets it: the area of the ten it lives in
 * (`./areas.ts`), the sub-heading inside the area, a plain label, a label for every value of an enum (so no
 * raw value such as `propose_split` ever reaches a screen), and the words a person searches it by. It is
 * keyed by the setting key and never restated on the registry row, because several builders add or remove
 * single registry rows in parallel and a field on every row would make each of those edits collide.
 *
 * THE GUARD. `test/settings/presentation.test.mjs` holds that every registry key has an entry here, with a
 * de-CH and an en label, an area of the ten, and a label in both locales for every value of an enum. An entry
 * for a key the registry does not carry (one a parallel build is about to add, or just retired) is allowed:
 * it is never read for a key that does not exist. `presentationOf` falls back to the registry's own label and
 * the area named by the key's prefix for a key without an entry, so a forgotten entry degrades, never crashes;
 * the guard is what keeps that from shipping.
 *
 * Synonyms in the engine, not in the Studio: an agent reading `settings_list` finds a key by the same words
 * the person types into the Einstellungen search and Cmd K.
 */

import { SETTINGS_AREA_DEFS, parseSettingsSections, type SettingsArea } from './areas.js';

export interface PresentationText {
  readonly en: string;
  readonly 'de-CH': string;
}

export interface SettingPresentation {
  readonly area: SettingsArea;
  /** The sub-heading inside the area. */
  readonly subgroup: PresentationText;
  readonly label: PresentationText;
  /** Every enum value in words; absent for a non-enum setting. */
  readonly valueLabels?: Readonly<Record<string, PresentationText>>;
  readonly keywords: { readonly en: readonly string[]; readonly 'de-CH': readonly string[] };
  /** D202 §4.1: approving a change of it gives the agent more rights (the Pendenzen row says so). */
  readonly widensAgent?: boolean;
}

type Pair = readonly [de: string, en: string];

function t([de, en]: Pair): PresentationText {
  return { 'de-CH': de, en };
}

function values(map: Record<string, Pair>): Record<string, PresentationText> {
  return Object.fromEntries(Object.entries(map).map(([k, v]) => [k, t(v)]));
}

interface EntryInput {
  area: SettingsArea;
  sub: Pair;
  label: Pair;
  values?: Record<string, Pair>;
  kw?: readonly string[];
  kwEn?: readonly string[];
  widensAgent?: boolean;
}

function entry(e: EntryInput): SettingPresentation {
  return {
    area: e.area,
    subgroup: t(e.sub),
    label: t(e.label),
    ...(e.values !== undefined ? { valueLabels: values(e.values) } : {}),
    keywords: { 'de-CH': e.kw ?? [], en: e.kwEn ?? [] },
    ...(e.widensAgent === true ? { widensAgent: true } : {}),
  };
}

// Sub-headings, one pair each, so the same words never drift between two rows.
const SUB = {
  belegnummern: ['Belegnummern', 'Voucher numbers'],
  lohn: ['Lohn', 'Payroll'],
  anlagen: ['Anlagen', 'Fixed assets'],
  checklisten: ['Checklisten', 'Checklists'],
  bankzeilen: ['Bankzeilen', 'Bank lines'],
  sammelbuchen: ['Sammelbuchen', 'Book all'],
  csv: ['Lücken aus Exporten', 'Gaps from exports'],
  anzahlungen: ['Anzahlungen', 'Advance payments'],
  zahlungsanbieter: ['Zahlungsanbieter', 'Payment providers'],
  mwstAnzahlungen: ['MWST auf Anzahlungen', 'VAT on advance payments'],
  belegeingang: ['Belegeingang', 'Receipt inbox'],
  zuordnen: ['Belege zuordnen', 'Matching receipts'],
  ablage: ['Ablage-Links', 'Drop links'],
  mahnwesen: ['Mahnwesen', 'Dunning'],
  serien: ['Serienrechnungen', 'Recurring invoices'],
  mail: ['Mail-Programm', 'Mail client'],
  darf: ['Was der Agent darf', 'What the agent may do'],
  regeln: ['Regeln und Autopilot', 'Rules and autopilot'],
  hausbuch: ['Hausbuch', 'House book'],
  technik: ['Technik', 'Technical'],
  neuigkeiten: ['Neuigkeiten', "What's new"],
  allgemein: ['Allgemein', 'General'],
} as const satisfies Record<string, Pair>;

const ON_OFF: Record<string, Pair> = { on: ['Ein', 'On'], off: ['Aus', 'Off'] };
const REFUSE_WARN_OFF: Record<string, Pair> = { refuse: ['Ablehnen', 'Refuse'], warn: ['Mit Warnung', 'With a warning'], off: ['Nicht prüfen', 'Do not check'] };
const BULK_SUGGEST: Record<string, Pair> = { bulk: ['Sammelknopf bucht', 'Book all includes them'], suggest: ['Einzeln prüfen', 'Check one by one'] };
const WARN_REFUSE_IGNORE: Record<string, Pair> = { warn: ['Warnen', 'Warn'], refuse: ['Ablehnen', 'Refuse'], ignore: ['Übergehen', 'Ignore'] };

export const SETTING_PRESENTATION: Readonly<Record<string, SettingPresentation>> = {
  // --- Buchhaltung ---------------------------------------------------------------------------------
  'checklists.attention_window_days': entry({ area: 'buchhaltung', sub: SUB.checklisten, label: ['Fällige Checklisten-Schritte im Voraus', 'Checklist steps shown ahead'], kw: ['Pendenzen', 'fällig'], kwEn: ['due'] }),
  // D210: Aufgaben left the menu; the ones due soon show in Pendenzen, as the checklist steps do.
  'attention.tasks_due_days': entry({ area: 'buchhaltung', sub: SUB.checklisten, label: ['Fällige Aufgaben im Voraus', 'Tasks shown ahead'], kw: ['Pendenzen', 'Aufgaben', 'fällig'], kwEn: ['tasks', 'due'] }),
  'payroll.month_guard': entry({ area: 'buchhaltung', sub: SUB.lohn, label: ['Zweite Lohnbuchung im selben Monat', 'Second wage journal in a month'], values: REFUSE_WARN_OFF, kw: ['Lohnjournal'], kwEn: ['wage journal'] }),
  'assets.proceeds_check': entry({ area: 'buchhaltung', sub: SUB.anlagen, label: ['Abgang stornieren, solange sein Erlösbeleg gilt', 'Reverse a disposal while its proceeds stand'], values: REFUSE_WARN_OFF, kw: ['Anlage', 'Verkauf', 'Storno'], kwEn: ['asset', 'sale'] }),
  'assets.proceeds_booking': entry({
    area: 'buchhaltung',
    sub: SUB.anlagen,
    label: ['Erlös eines Abgangs mit Rechnung', 'Proceeds of a disposal with an invoice'],
    values: { clear_via_document: ['Über die Rechnung', 'Through the invoice'], book_proceeds: ['Erlös buchen', 'Book the proceeds'] },
    kw: ['Anlage', 'Verkauf'],
    kwEn: ['asset', 'sale'],
  }),
  'assets.cross_year_sale': entry({
    area: 'buchhaltung',
    sub: SUB.anlagen,
    label: ['Abgang und Rechnung in zwei Geschäftsjahren', 'Disposal and invoice in two fiscal years'],
    values: { post_abgrenzung: ['Abgrenzung buchen', 'Post an accrual'], refuse: ['Ablehnen', 'Refuse'] },
    kw: ['Abgrenzung', 'Jahreswechsel'],
    kwEn: ['accrual'],
  }),
  'ledger.belegnummer_mode': entry({
    area: 'buchhaltung',
    sub: SUB.belegnummern,
    label: ['Belegnummern', 'Voucher numbers'],
    values: {
      continue_migrated: ['Übernommene weiterführen', 'Continue migrated numbers'],
      from_start: ['Ab Startnummer', 'From the start number'],
      per_fiscal_year: ['Pro Geschäftsjahr', 'Per fiscal year'],
      off: ['Aus', 'Off'],
    },
    kw: ['Beleg-Nr.', 'Nummerierung', 'bexio'],
    kwEn: ['numbering'],
  }),
  'ledger.belegnummer_start': entry({ area: 'buchhaltung', sub: SUB.belegnummern, label: ['Erste Belegnummer', 'First voucher number'], kw: ['Beleg-Nr.', 'Nummerierung'], kwEn: ['numbering'] }),
  'ledger.belegnummer_prefix': entry({ area: 'buchhaltung', sub: SUB.belegnummern, label: ['Präfix der Belegnummer', 'Voucher number prefix'], kw: ['Beleg-Nr.', 'Vorsilbe'], kwEn: ['numbering'] }),
  'ledger.belegnummer_split_voucher': entry({
    area: 'buchhaltung',
    sub: SUB.belegnummern,
    label: ['Ein alter Beleg in mehreren Buchungen', 'One old voucher in several entries'],
    values: { share: ['Gleiche Nummer', 'Same number'], suffix: ['Mit Zusatz .2, .3', 'With .2, .3'], first_keeps: ['Erste behält sie', 'First one keeps it'] },
    kw: ['Beleg-Nr.', 'bexio', 'Migration'],
    kwEn: ['numbering', 'migration'],
  }),

  // --- Bank ----------------------------------------------------------------------------------------
  'bank.buchungsregel_mode': entry({ area: 'bank', sub: SUB.sammelbuchen, label: ['Buchungsregeln im Sammelbuchen', 'Booking rules in Book all'], values: BULK_SUGGEST, kw: ['Buchungsregel', 'Alle buchen'], kwEn: ['booking rule'] }),
  'bank.bulk_learned_min': entry({ area: 'bank', sub: SUB.sammelbuchen, label: ['Gelernte Zeilen im Sammelbuchen', 'Learned lines in Book all'], kw: ['gelernt', 'Schwelle'], kwEn: ['learned', 'threshold'] }),
  'bank.bulk_book_scope': entry({
    area: 'bank',
    sub: SUB.sammelbuchen,
    label: ['Was das Sammelbuchen bucht', 'What Book all books'],
    values: { bookable: ['Alles Vollständige', 'Everything complete'], sure: ['Nur Sicheres', 'Only sure lines'] },
    kw: ['Alle buchen'],
  }),
  'bank.row_approve': entry({ area: 'bank', sub: SUB.bankzeilen, label: ['Das Häkchen auf einer Bankzeile', 'The tick on a bank line'], values: { direct: ['Bucht direkt', 'Books at once'], review: ['Öffnet die Prüfung', 'Opens the review'] }, kw: ['Häkchen', 'freigeben'], kwEn: ['tick', 'approve'] }),
  'bank.buchungsregel_ignore_mode': entry({ area: 'bank', sub: SUB.sammelbuchen, label: ["'Nicht buchen'-Regeln im Sammelbuchen", "'Do not book' rules in Book all"], values: { suggest: ['Einzeln prüfen', 'Check one by one'], bulk: ['Sammelknopf legt beiseite', 'Book all sets them aside'] }, kw: ['ignorieren', 'Buchungsregel'], kwEn: ['ignore'] }),
  'bank.ignore_default_reason': entry({
    area: 'bank',
    sub: SUB.bankzeilen,
    label: ['Grund beim Ignorieren mit einem Klick', 'Reason of a one-click ignore'],
    values: {
      other: ['Anderes', 'Other'],
      booked_elsewhere: ['Anderswo gebucht', 'Booked elsewhere'],
      clearing_account: ['Durchlaufkonto', 'Clearing account'],
      before_start: ['Vor dem Start', 'Before the start'],
      duplicate: ['Duplikat', 'Duplicate'],
    },
    kw: ['ignorieren', 'Grund'],
    kwEn: ['ignore', 'reason'],
  }),
  'bank.buchungsregel_computed_mode': entry({ area: 'bank', sub: SUB.sammelbuchen, label: ['Berechnete Beträge im Sammelbuchen', 'Computed amounts in Book all'], values: { suggest: ['Einzeln prüfen', 'Check one by one'], bulk: ['Sammelknopf bucht', 'Book all includes them'] }, kw: ['Faktor', 'Buchungsregel'], kwEn: ['factor'] }),
  'bank.fx_mode': entry({
    area: 'bank',
    sub: SUB.bankzeilen,
    label: ['Kartenzahlungen in Fremdwährung', 'Card payments in a foreign currency'],
    values: {
      propose_split: ['Aufteilung vorschlagen', 'Propose a split'],
      prefill_split: ['Aufteilung ausfüllen', 'Prefill the split'],
      facts_only: ['Nur Fakten', 'Facts only'],
      transaction_currency: ['In Fremdwährung buchen', 'Book in the foreign currency'],
    },
    kw: ['Fremdwährung', 'Kurs', 'Karte', 'EUR', 'USD'],
    kwEn: ['foreign currency', 'exchange rate', 'card'],
  }),
  'bank.cross_format_duplicates': entry({ area: 'bank', sub: SUB.bankzeilen, label: ['Mögliche Duplikate über Formate', 'Possible duplicates across formats'], values: { ask: ['Fragen', 'Ask'], auto_strong: ['Sichere weglassen', 'Drop sure ones'] }, kw: ['Duplikat', 'camt', 'CSV'], kwEn: ['duplicate'] }),
  'bank.csv_fill_balance_tie': entry({ area: 'bank', sub: SUB.csv, label: ['Salden müssen anschliessen', 'Balances must tie'], values: { required: ['Verlangt', 'Required'], warn: ['Nur warnen', 'Warn only'] }, kw: ['CSV', 'Lücke', 'Saldo'], kwEn: ['gap', 'balance'] }),
  'bank.csv_fill_duplicates': entry({ area: 'bank', sub: SUB.csv, label: ['Zeilen, die schon im Buch sind', 'Lines already in the book'], values: { skip_proven: ['Weglassen', 'Leave out'], ask: ['Fragen', 'Ask'] }, kw: ['CSV', 'Lücke', 'Duplikat'], kwEn: ['gap', 'duplicate'] }),
  'bank.csv_fill_fed_accounts': entry({ area: 'bank', sub: SUB.csv, label: ['Lücke bei einem EBICS-Konto', 'Gap on an EBICS account'], values: { allow: ['Erlauben', 'Allow'], refuse: ['Ablehnen', 'Refuse'] }, kw: ['CSV', 'EBICS', 'Lücke'], kwEn: ['gap'] }),
  'bank.csv_fill_proof': entry({ area: 'bank', sub: SUB.csv, label: ['Womit die Tage geprüft werden', 'How the days are proven'], values: { auto: ['Automatisch', 'Automatic'], running_balance_only: ['Nur laufender Saldo', 'Running balance only'] }, kw: ['CSV', 'Lücke', 'Export'], kwEn: ['gap', 'export'] }),
  'bank.derive_counterparty': entry({ area: 'bank', sub: SUB.bankzeilen, label: ['Gegenpartei aus dem Buchungstext', 'Counterparty from the booking text'], values: ON_OFF, kw: ['Händler', 'Gegenpartei', 'Karte'], kwEn: ['merchant', 'counterparty'] }),
  'bank.entry_text_from_leg': entry({ area: 'bank', sub: SUB.bankzeilen, label: ['Buchungstext einer Bankbuchung', 'Entry text of a bank booking'], values: { leg: ['Aus der Buchungsregel', 'From the booking rule'], bank: ['Text der Bank', 'The bank\'s text'] }, kw: ['Buchungstext', 'Buchungsregel', 'Text'], kwEn: ['booking text', 'entry text'] }),
  'bank.fee_texts': entry({ area: 'bank', sub: SUB.bankzeilen, label: ['Texte von Bankgebühren', 'Bank fee texts'], kw: ['Gebühr', 'Spesen'], kwEn: ['fee'] }),
  'bank.fee_account': entry({ area: 'bank', sub: SUB.bankzeilen, label: ['Konto für Bankspesen', 'Bank fee account'], kw: ['Gebühr', 'Spesen', 'Konto'], kwEn: ['fee', 'account'] }),
  'bank.contact_booking_mode': entry({ area: 'bank', sub: SUB.anzahlungen, label: ['Bankzeile auf einen Kontakt', 'A bank line to a contact'], values: { guthaben: ['Als Guthaben', 'As a credit'], anzahlung: ['Als Anzahlung', 'As an advance'] }, kw: ['Kontakt', 'Guthaben'], kwEn: ['contact', 'credit'] }),
  'bank.anzahlung_customer_account': entry({ area: 'bank', sub: SUB.anzahlungen, label: ['Konto für erhaltene Anzahlungen', 'Account for advances received'], kw: ['Anzahlung', 'Konto'], kwEn: ['advance', 'account'] }),
  'bank.anzahlung_supplier_account': entry({ area: 'bank', sub: SUB.anzahlungen, label: ['Konto für geleistete Anzahlungen', 'Account for advances paid'], kw: ['Anzahlung', 'Konto'], kwEn: ['advance', 'account'] }),
  'bank.anzahlung_fx_mode': entry({ area: 'bank', sub: SUB.anzahlungen, label: ['Anzahlungen in Fremdwährung', 'Advances in a foreign currency'], values: { fixed: ['Kurs bei Eingang', 'Rate on receipt'], foreign: ['Neu bewerten', 'Revalue'] }, kw: ['Anzahlung', 'Fremdwährung'], kwEn: ['advance', 'foreign currency'] }),
  'settlement.pull_mode': entry({ area: 'bank', sub: SUB.zahlungsanbieter, label: ['Abrechnungs-Feed abholen', 'Fetch the settlement feed'], values: { manual: ['Von Hand', 'By hand'], daily: ['Täglich', 'Daily'] }, kw: ['Stripe', 'Twint', 'Feed'], kwEn: ['feed'] }),
  'settlement.test_events': entry({ area: 'bank', sub: SUB.zahlungsanbieter, label: ['Testzahlungen', 'Test payments'], values: { skip: ['Nicht buchen', 'Do not book'], book: ['Buchen', 'Book'] }, kw: ['Stripe', 'Test'], kwEn: ['test'] }),
  'settlement.test_fees': entry({ area: 'bank', sub: SUB.zahlungsanbieter, label: ['Gebühren auf Testzahlungen', 'Fees on test payments'], values: { book: ['Buchen', 'Book'], skip: ['Nicht buchen', 'Do not book'] }, kw: ['Stripe', 'Gebühr'], kwEn: ['fee'] }),
  'settlement.review_period': entry({ area: 'bank', sub: SUB.zahlungsanbieter, label: ['Zeitraum der Umsatz-Prüfung', 'Period of the turnover review'], values: { quarter: ['Quartal', 'Quarter'], month: ['Monat', 'Month'], year: ['Jahr', 'Year'] }, kw: ['Umsatz', 'Prüfung'], kwEn: ['turnover', 'review'] }),
  'settlement.agent_sees_email': entry({ area: 'bank', sub: SUB.zahlungsanbieter, label: ['E-Mail der Zahlenden für den Agenten', 'Payer email for the agent'], values: { masked: ['Verborgen', 'Hidden'], shown: ['Sichtbar', 'Shown'] }, kw: ['Datenschutz', 'E-Mail'], kwEn: ['privacy', 'email'] }),
  'settlement.table_event_id': entry({ area: 'bank', sub: SUB.zahlungsanbieter, label: ['Tabellen ohne ID', 'Tables without an id'], values: { column: ['ID-Spalte nötig', 'Id column required'], column_else_day: ['Sonst nach ganzen Tagen', 'Else by whole days'] }, kw: ['Umsatz', 'Tabelle', 'Tag'], kwEn: ['turnover', 'table', 'day'] }),
  'settlement.table_edge_days': entry({ area: 'bank', sub: SUB.zahlungsanbieter, label: ['Erster und letzter Tag einer Tabelle', 'First and last day of a table'], values: { ask: ['Nachfragen', 'Ask'], include: ['Buchen', 'Book'], exclude: ['Auslassen', 'Leave out'] }, kw: ['Umsatz', 'Tabelle', 'Tag'], kwEn: ['turnover', 'table', 'day'] }),
  'settlement.pull_overlap_days': entry({ area: 'bank', sub: SUB.zahlungsanbieter, label: ['Überlappung beim Abholen', 'Overlap when fetching'], kw: ['Feed'], kwEn: ['feed'] }),
  'settlement.check_cancelling_groups': entry({
    area: 'bank',
    sub: SUB.zahlungsanbieter,
    label: ['Aufgehobene Verkäufe vor dem Einreichen', 'Cancelled sales before filing'],
    values: { hide_test: ['Tests ausblenden', 'Hide tests'], hide_all: ['Alle ausblenden', 'Hide all'], show: ['Alle zeigen', 'Show all'] },
    kw: ['Rückerstattung', 'MWST'],
    kwEn: ['refund', 'VAT'],
  }),

  // --- MWST ----------------------------------------------------------------------------------------
  'bank.anzahlung_vat': entry({ area: 'mwst', sub: SUB.mwstAnzahlungen, label: ['MWST auf erhaltenen Anzahlungen', 'VAT on advances received'], kw: ['Anzahlung', 'Mehrwertsteuer'], kwEn: ['advance'] }),
  'bank.anzahlung_vat_code': entry({ area: 'mwst', sub: SUB.mwstAnzahlungen, label: ['MWST-Code für Anzahlungen', 'VAT code for advances'], kw: ['Anzahlung', 'Steuercode'], kwEn: ['advance', 'tax code'] }),
  'bank.anzahlung_vat_refund': entry({ area: 'mwst', sub: SUB.mwstAnzahlungen, label: ['MWST bei Rückzahlung einer Anzahlung', 'VAT when an advance is refunded'], values: { reverse: ['Automatisch korrigieren', 'Correct automatically'], refuse: ['Angabe verlangen', 'Ask for it'], warn: ['Mit Hinweis', 'With a note'] }, kw: ['Anzahlung', 'Rückzahlung'], kwEn: ['advance', 'refund'] }),

  // --- Belege --------------------------------------------------------------------------------------
  'files.source_roots': entry({ area: 'belege', sub: SUB.belegeingang, label: ['Ordner, aus denen der Agent Dateien anhängen darf', 'Folders the agent may attach files from'], kw: ['Ordner', 'Chat', 'Upload'], kwEn: ['folder', 'chat'], widensAgent: true }),
  'files.duplicate_beleg': entry({ area: 'belege', sub: SUB.zuordnen, label: ['Ein Beleg, der schon gebucht ist', 'A receipt that is already booked'], values: { confirm: ['Bestätigen lassen', 'Ask to confirm'], allow: ['Erlauben', 'Allow'], refuse: ['Ablehnen', 'Refuse'] }, kw: ['doppelt', 'zweimal'], kwEn: ['twice', 'duplicate'], widensAgent: true }),
  'files.capture_on_attach': entry({ area: 'belege', sub: SUB.belegeingang, label: ['Wartender Beleg nach dem Buchen', 'A waiting receipt once booked'], values: { close: ['Abschliessen', 'Close it'], keep: ['In der Liste lassen', 'Keep it listed'] }, kw: ['erfasst', 'Liste'], kwEn: ['capture'] }),
  'files.drop_link_hours': entry({ area: 'belege', sub: SUB.ablage, label: ['Gültigkeit eines Ablage-Links (Stunden)', 'Drop link validity (hours)'], kw: ['Link', 'Chat'], kwEn: ['link'] }),
  'files.drop_link_keep_days': entry({ area: 'belege', sub: SUB.ablage, label: ['Alte Ablage-Links behalten', 'Keep old drop links'], kw: ['Link'], kwEn: ['link'] }),
  'files.belegeingang_folder': entry({ area: 'belege', sub: SUB.belegeingang, label: ['Ordner Belegeingang', 'Receipt inbox folder'], kw: ['Ordner', 'Scan'], kwEn: ['folder', 'scan'], widensAgent: true }),
  'files.belegeingang_scan': entry({ area: 'belege', sub: SUB.belegeingang, label: ['Ordner Belegeingang beobachten', 'Watch the receipt inbox folder'], values: ON_OFF, kw: ['Ordner', 'Scan'], kwEn: ['folder', 'scan'] }),
  'files.belegeingang_after': entry({ area: 'belege', sub: SUB.belegeingang, label: ['Nach dem Erfassen', 'After capture'], values: { move: ['Nach Erledigt verschieben', 'Move to Done'], keep: ['Liegen lassen', 'Leave it'] }, kw: ['Ordner', 'Erledigt'], kwEn: ['folder'] }),
  'belege.match_mode': entry({ area: 'belege', sub: SUB.zuordnen, label: ['Beleg zur Bankzeile vorschlagen', 'Suggest a receipt for a bank line'], values: { suggest: ['Vorschlagen', 'Suggest'], off: ['Aus', 'Off'] }, kw: ['Abgleich', 'Bankzeile'], kwEn: ['match', 'bank line'] }),
  'belege.match_date_window_days': entry({ area: 'belege', sub: SUB.zuordnen, label: ['Beleg und Bankzeile: Tage auseinander', 'Receipt and bank line: days apart'], kw: ['Abgleich', 'Datum'], kwEn: ['match', 'date'] }),
  'belege.match_fx_tolerance_pct': entry({ area: 'belege', sub: SUB.zuordnen, label: ['Beleg in Fremdwährung: Toleranz', 'Foreign-currency receipt: tolerance'], kw: ['Abgleich', 'Fremdwährung'], kwEn: ['match', 'foreign currency'] }),
  'belege.match_vendor_prefix': entry({ area: 'belege', sub: SUB.zuordnen, label: ['Händlername mit mehr im Banktext', 'Merchant name with more in the bank text'], values: { suggest: ['Vorschlagen', 'Suggest'], engine: ['TILL ordnet zu', 'TILL assigns'], off: ['Nur ganze Wörter', 'Whole words only'] }, kw: ['Händler', 'Abgleich'], kwEn: ['merchant', 'match'] }),
  'belege.vat_delta_tolerance_rappen': entry({ area: 'belege', sub: SUB.zuordnen, label: ['MWST auf dem Beleg: Toleranz (Rappen)', 'VAT on the receipt: tolerance (centimes)'], kw: ['MWST', 'Rundung'], kwEn: ['VAT', 'rounding'] }),
  'belege.vat_from_receipt': entry({ area: 'belege', sub: SUB.zuordnen, label: ['MWST auf dem Beleg wählt den Code', 'The receipt VAT picks the code'], values: { propose: ['Code übernehmen', 'Take the code'], compare_only: ['Nur vergleichen', 'Compare only'] }, kw: ['MWST', 'Vorsteuer'], kwEn: ['VAT', 'input tax'] }),
  'belege.autobook_figure_trust': entry({ area: 'belege', sub: SUB.zuordnen, label: ['Belegzahlen für das automatische Buchen', 'Receipt figures for automatic booking'], values: { confirmed: ['Nur bestätigte', 'Confirmed only'], agent: ['Auch vom Agenten gelesene', 'Also read by the agent'] }, kw: ['Autopilot', 'vertrauen'], kwEn: ['autopilot', 'trust'], widensAgent: true }),
  'belege.assigned_move': entry({ area: 'belege', sub: SUB.zuordnen, label: ['Zugeordneter Beleg anderswo verwendet', 'An assigned receipt used elsewhere'], values: { refuse: ['Ablehnen', 'Refuse'], move: ['Übergeben', 'Move it'] }, kw: ['zuordnen', 'lösen'], kwEn: ['assign'] }),
  'belege.drop_on_open_line': entry({
    area: 'belege',
    sub: SUB.zuordnen,
    label: ['Datei auf eine offene Bankzeile gezogen', 'A file dropped on an open bank line'],
    values: { assign: ['Zuordnen', 'Assign'], assign_if_stated: ['Zuordnen mit Betrag', 'Assign when it states an amount'], file: ['Nur ablegen', 'File only'] },
    kw: ['ziehen', 'ablegen', 'Drag'],
    kwEn: ['drop'],
  }),
  'belege.undated_lookback_days': entry({ area: 'belege', sub: SUB.zuordnen, label: ['Belege ohne Datum: Rückblick (Tage)', 'Undated receipts: look back (days)'], kw: ['Datum'], kwEn: ['date'] }),
  'belege.qr_trust_folder': entry({ area: 'belege', sub: SUB.belegeingang, label: ['QR-Code aus dem Ordner vertrauen', 'Trust the QR code from the folder'], values: ON_OFF, kw: ['QR', 'Ordner', 'Autopilot'], kwEn: ['QR', 'folder'], widensAgent: true }),

  // --- Verkauf -------------------------------------------------------------------------------------
  'dunning.refreeze': entry({ area: 'verkauf', sub: SUB.mahnwesen, label: ['Offene Briefe bei stornierter Mahngebühr', 'Open letters when a dunning fee is reversed'], values: { 're-issue': ['Neu ausstellen', 'Re-issue'], hold: ['Zurückhalten', 'Hold'] }, kw: ['Mahnung', 'Gebühr'], kwEn: ['dunning', 'fee'] }),
  'dunning.letter_date': entry({ area: 'verkauf', sub: SUB.mahnwesen, label: ['Datum eines neu ausgestellten Briefs', 'Date of a re-issued letter'], values: { run_date: ['Datum des Mahnlaufs', 'Run date'], today: ['Heute', 'Today'] }, kw: ['Mahnung', 'Datum'], kwEn: ['dunning', 'date'] }),
  'recurring.auto_generate': entry({
    area: 'verkauf',
    sub: SUB.serien,
    label: ['Fällige Serienrechnungen', 'Due recurring invoices'],
    values: { draft: ['Als Entwurf', 'As drafts'], honour_auto_issue: ['Ausstellen, wo eingestellt', 'Issue where set'], off: ['Aus', 'Off'] },
    kw: ['Abo', 'wiederkehrend', 'Rechnung'],
    kwEn: ['subscription', 'recurring'],
  }),
  'mail.mbox_client_guard': entry({
    area: 'verkauf',
    sub: SUB.mail,
    label: ['Mail-Programm prüfen vor einem Entwurf', 'Check the mail client before a draft'],
    values: { refuse: ['Ablehnen, wenn unklar', 'Refuse when unsure'], refuse_running: ['Nur wenn offen', 'Only when open'], off: ['Nicht prüfen', 'Do not check'] },
    kw: ['Thunderbird', 'E-Mail', 'Entwurf'],
    kwEn: ['email', 'draft'],
  }),

  // --- Agent und Automatik -------------------------------------------------------------------------
  'attention.approval_batch_mode': entry({
    area: 'agent',
    sub: SUB.darf,
    label: ['Mehrere Bank-Vorschläge freigeben', 'Approve several bank proposals'],
    values: { tick: ['Auswahl', 'Selection'], single: ['Einzeln', 'One by one'], all_with_confirm: ['Alle nach Bestätigung', 'All after confirming'] },
    kw: ['Pendenzen', 'genehmigen', 'Vorschlag'],
    kwEn: ['approve', 'proposal'],
  }),
  'attention.auto_rule_confirm': entry({
    area: 'agent',
    sub: SUB.regeln,
    label: ['Regel bei "künftig automatisch" bestätigen', 'Confirm the rule of "automate"'],
    values: { never: ['Ein Klick', 'One click'], always: ['Regel zuerst zeigen', 'Show the rule first'] },
    kw: ['Pendenzen', 'Buchungsregel', 'automatisch', 'freigeben'],
    kwEn: ['rule', 'automate', 'approve'],
  }),
  'attention.row_hints': entry({
    area: 'agent',
    sub: SUB.darf,
    label: ['Hinweise auf Vorschlagszeilen', 'Hints on proposal rows'],
    values: { missing: ['Nur wenn etwas fehlt', 'Only when something is missing'], none: ['Keine', 'None'] },
    kw: ['Pendenzen', 'Beleg', 'Hinweis'],
    kwEn: ['receipt', 'hint'],
  }),
  'attention.undo_seconds': entry({ area: 'agent', sub: SUB.darf, label: ['Sekunden zum Rückgängigmachen', 'Seconds to undo'], kw: ['Pendenzen', 'Rückgängig', 'freigeben'], kwEn: ['undo', 'approve'] }),
  'attention.keys': entry({ area: 'agent', sub: SUB.darf, label: ['Tasten in der Vorschlagsliste', 'Keys in the proposal list'], kw: ['Pendenzen', 'Tastatur'], kwEn: ['keyboard', 'shortcut'] }),
  'agent.decide_proposals': entry({
    area: 'agent',
    sub: SUB.darf,
    label: ['Agent entscheidet Vorschläge', 'Agent decides proposals'],
    values: { off: ['Aus', 'Off'], reject: ['Verwerfen', 'Reject'], decide: ['Verwerfen und genehmigen', 'Reject and approve'] },
    kw: ['Freigabe', 'genehmigen', 'ablehnen'],
    kwEn: ['grant', 'approve', 'reject'],
    widensAgent: true,
  }),
  'agent.approve_on_owner_word': entry({
    area: 'agent',
    sub: SUB.darf,
    label: ['Agent genehmigt auf dein Wort', 'Agent approves on your word'],
    values: { off: ['Aus', 'Off'], on: ['Ein', 'On'] },
    kw: ['Freigabe', 'genehmigen', 'Wort', 'Chat'],
    kwEn: ['approve', 'word', 'chat'],
    widensAgent: true,
  }),
  'agent.owner_word_before_draft_minutes': entry({ area: 'agent', sub: SUB.darf, label: ['Freigabe im Chat: Worte vor dem Vorschlag', 'Approval in chat: words before the proposal'], kw: ['Freigabe', 'Chat', 'Minuten'], kwEn: ['approve', 'chat', 'minutes'] }),
  'agent.owner_word_excluded': entry({
    area: 'agent',
    sub: SUB.darf,
    label: ['Immer dein Klick, auch auf dein Wort', 'Always your click, even on your word'],
    // The dial families, one toggle each in the Studio (a string setting whose presentation names its values).
    values: {
      'close-period': ['Periode schliessen', 'Close period'],
      'go-live': ['Produktiv gehen', 'Go live'],
      erase: ['Löschen', 'Erase'],
      'vat-file': ['MWST einreichen', 'File VAT'],
      pay: ['Zahlen', 'Pay'],
      issue: ['Ausstellen', 'Issue'],
      send: ['Senden', 'Send'],
      share: ['Freigeben', 'Share'],
      dun: ['Mahnen', 'Dun'],
      post: ['Buchen', 'Post'],
      stock: ['Lager', 'Stock'],
      'plugin-install': ['Plugins', 'Plugins'],
      customize: ['Anpassen', 'Customize'],
    },
    kw: ['Freigabe', 'Chat', 'Wort', 'MWST', 'Plugin'],
    kwEn: ['approve', 'chat', 'word', 'VAT', 'plugin'],
    widensAgent: true,
  }),
  'agent.ignore_under_grant': entry({ area: 'agent', sub: SUB.darf, label: ['Agent ignoriert Bankzeilen in einem Schritt', 'Agent ignores bank lines in one step'], values: { one_call: ['In einem Schritt', 'In one step'], two_calls: ['In zwei Schritten', 'In two steps'] }, kw: ['ignorieren', 'Freigabe'], kwEn: ['ignore'], widensAgent: true }),
  'agent.reject_reason': entry({ area: 'agent', sub: SUB.darf, label: ['Agent begründet Ablehnungen', 'Agent explains rejections'], values: { required: ['Verlangt', 'Required'], optional: ['Freiwillig', 'Optional'] }, kw: ['ablehnen', 'Grund'], kwEn: ['reject', 'reason'] }),
  'agent.settings_sections': entry({ area: 'agent', sub: SUB.darf, label: ['Bereiche, die der Agent ändern darf', 'Areas the agent may change'], kw: ['Einstellungen', 'Erlaubnis', 'Freigabe'], kwEn: ['settings', 'permission'], widensAgent: true }),
  'agent.settings_area_respects_strong_default': entry({ area: 'agent', sub: SUB.darf, label: ['Offene Bereiche fragen bei heiklen Einstellungen nach', 'Opened areas keep asking for sensitive settings'], kw: ['Erlaubnis', 'MWST', 'Vorschlag'], kwEn: ['permission'], widensAgent: true }),
  'agent.settings_proposals_open_max': entry({ area: 'agent', sub: SUB.darf, label: ['Offene Einstellungs-Vorschläge des Agenten', 'Open setting proposals by the agent'], kw: ['Vorschlag', 'Einstellungen'], kwEn: ['proposal'], widensAgent: true }),
  'agent.batch_max_items': entry({ area: 'agent', sub: SUB.technik, label: ['Höchstzahl Positionen in einem Sammelaufruf', 'Most items in one batch call'], kw: ['Batch', 'MCP'], kwEn: ['batch'] }),
  'agent.undo_hints': entry({ area: 'agent', sub: SUB.technik, label: ['Rückgängig-Hinweis in der Antwort', 'Undo hint in the answer'], values: ON_OFF, kw: ['rückgängig', 'MCP'], kwEn: ['undo'] }),
  'rules.miner': entry({ area: 'agent', sub: SUB.regeln, label: ['Neue Regeln aus den Buchungen vorschlagen', 'Suggest new rules from bookings'], values: ON_OFF, kw: ['Buchungsregel', 'lernen'], kwEn: ['booking rule', 'learn'] }),
  'rules.miner_min_repeats': entry({ area: 'agent', sub: SUB.regeln, label: ['Gleiche Buchungen bis zum Regelvorschlag', 'Same bookings before a rule is suggested'], kw: ['Buchungsregel'], kwEn: ['booking rule'] }),
  'rules.miner_lookback_days': entry({ area: 'agent', sub: SUB.regeln, label: ['Wie weit Regelvorschläge zurückschauen', 'How far rule suggestions look back'], kw: ['Buchungsregel'], kwEn: ['booking rule'] }),
  'rules.miner_max_open': entry({ area: 'agent', sub: SUB.regeln, label: ['Höchstens offene Regelvorschläge', 'Most open rule suggestions'], kw: ['Buchungsregel'], kwEn: ['booking rule'] }),
  'rules.health_changed_of_last5': entry({ area: 'agent', sub: SUB.regeln, label: ["Wann eine Regel 'Regel anpassen?' fragt", "When a rule asks 'Adjust rule?'"], kw: ['Buchungsregel'], kwEn: ['booking rule'] }),
  'rules.autobook': entry({ area: 'agent', sub: SUB.regeln, label: ['Regeln, die selbst buchen', 'Rules that book on their own'], values: { offer: ['Anbieten', 'Offer'], off: ['Aus', 'Off'] }, kw: ['Autopilot', 'automatisch buchen'], kwEn: ['autopilot', 'autobook'], widensAgent: true }),
  'rules.vorlage_agent_open_max': entry({ area: 'agent', sub: SUB.regeln, label: ['Offene Vorschläge einer Agenten-Wiederholung', 'Open proposals of an agent schedule'], kw: ['Dauerbuchung', 'Vorlage'], kwEn: ['schedule'] }),
  'rules.autobook_offer_after': entry({ area: 'agent', sub: SUB.regeln, label: ['Unveränderte Buchungen bis zum Angebot', 'Unchanged bookings before the offer'], kw: ['Autopilot'], kwEn: ['autopilot'], widensAgent: true }),
  'rules.autobook_amount_headroom': entry({ area: 'agent', sub: SUB.regeln, label: ['Betragsgrenze über der grössten Buchung', 'Amount ceiling above the largest booking'], kw: ['Autopilot', 'Grenze'], kwEn: ['autopilot', 'ceiling'], widensAgent: true }),
  'rules.autobook_suspend_on_change': entry({ area: 'agent', sub: SUB.regeln, label: ['Regel pausieren, wenn du ihren Vorschlag änderst', 'Pause a rule when you change its proposal'], values: ON_OFF, kw: ['Autopilot', 'pausieren'], kwEn: ['autopilot', 'pause'] }),
  'rules.autobook_scope': entry({ area: 'agent', sub: SUB.regeln, label: ['Welche Zeilen eine eingeschaltete Regel bucht', 'Which lines a switched-on rule books'], values: { new_lines: ['Nur neue Zeilen', 'New lines only'], open_lines: ['Auch offene Zeilen', 'Open lines too'] }, kw: ['Autopilot'], kwEn: ['autopilot'], widensAgent: true }),
  'rules.autobook_derived_keys': entry({ area: 'agent', sub: SUB.regeln, label: ['Automatisch buchen ohne angegebene Gegenpartei', 'Autobook without a stated counterparty'], values: { all: ['Alle', 'All'], bank_fees: ['Nur Bankgebühren', 'Bank fees only'], off: ['Aus', 'Off'] }, kw: ['Autopilot', 'Karte', 'Händler'], kwEn: ['autopilot', 'merchant'], widensAgent: true }),
  'rules.autobook_requires_beleg': entry({ area: 'agent', sub: SUB.regeln, label: ['Automatisches Buchen braucht den Beleg', 'Automatic booking needs the receipt'], values: { off: ['Aus', 'Off'], on: ['Ein', 'On'] }, kw: ['Autopilot', 'Beleg'], kwEn: ['autopilot', 'receipt'] }),
  'hausbuch.brief_sections': entry({ area: 'agent', sub: SUB.hausbuch, label: ['Was das Briefing enthält', 'What the brief carries'], kw: ['Briefing', 'Hausbuch'], kwEn: ['brief'] }),
  'idempotency.hash_free_text': entry({ area: 'agent', sub: SUB.technik, label: ['Freitext bei einer wiederholten Anfrage', 'Free text in a repeated request'], values: { exclude: ['Gleiche Anfrage', 'Same request'], include: ['Andere Anfrage', 'Another request'] }, kw: ['Idempotenz', 'MCP'], kwEn: ['idempotency'] }),
  'ledger.account_numbers': entry({ area: 'agent', sub: SUB.technik, label: ['Konten über die Kontonummer', 'Accounts by their number'], values: { accept: ['Annehmen', 'Accept'], ids_only: ['Nur IDs', 'IDs only'] }, kw: ['Konto', 'MCP'], kwEn: ['account'] }),
  'mcp.unknown_fields_agent': entry({ area: 'agent', sub: SUB.technik, label: ['Unbekannte Felder vom Agenten', 'Unknown fields from the agent'], values: WARN_REFUSE_IGNORE, kw: ['MCP', 'Feld'], kwEn: ['field'] }),
  'mcp.unknown_fields_studio': entry({ area: 'agent', sub: SUB.technik, label: ['Unbekannte Felder vom Studio', 'Unknown fields from the Studio'], values: WARN_REFUSE_IGNORE, kw: ['MCP', 'Feld'], kwEn: ['field'] }),

  // --- Darstellung ---------------------------------------------------------------------------------
  'releases.whats_new_toast': entry({ area: 'darstellung', sub: SUB.neuigkeiten, label: ['Neuigkeiten nach einem Update zeigen', "Show what's new after an update"], kw: ['Update', 'Version'], kwEn: ['update', 'version'] }),
  'releases.whats_new_versions': entry({ area: 'darstellung', sub: SUB.neuigkeiten, label: ['Versionen in den Neuigkeiten', "Versions in what's new"], kw: ['Update', 'Version'], kwEn: ['update', 'version'] }),

  // --- Keys a parallel build adds (D204 point 4): read only once the registry carries them. ----------
  'audit.ask_reason': entry({
    area: 'buchhaltung',
    sub: SUB.allgemein,
    label: ['Nach einem Grund fragen', 'Ask for a reason'],
    values: { never: ['Nie', 'Never'], optional: ['Freiwillig', 'Optional'] },
    kw: ['Grund', 'Begründung', 'Audit'],
    kwEn: ['reason', 'audit'],
  }),
};

/**
 * A value of a setting in words, for a person (the Pendenzen row of a settings Vorschlag, the history): an
 * enum's own label, On/Off for a boolean, "None" for an empty text, else the value itself.
 */
export function settingValueWords(
  key: string,
  schema: { readonly type: string },
  value: unknown,
  locale: 'en' | 'de-CH',
): string {
  // Critic L4: the agent's areas are a list of area ids; a person reads the areas' names.
  if (key === 'agent.settings_sections') {
    const areas = parseSettingsSections(value).map((id) => SETTINGS_AREA_DEFS.find((a) => a.id === id)?.label[locale] ?? id);
    return areas.length === 0 ? (locale === 'en' ? 'None' : 'Keine') : areas.join(', ');
  }
  const labels = SETTING_PRESENTATION[key]?.valueLabels;
  if (schema.type === 'enum' && typeof value === 'string' && labels?.[value] !== undefined) return labels[value][locale];
  // A list setting whose values have words (`agent.owner_word_excluded`): each name in words.
  if (schema.type === 'string' && typeof value === 'string' && labels !== undefined) {
    const names = value.split(',').map((x) => x.trim()).filter((x) => x.length > 0 && x !== 'none');
    return names.length === 0 ? (locale === 'en' ? 'None' : 'Keine') : names.map((n) => labels[n]?.[locale] ?? n).join(', ');
  }
  if (schema.type === 'boolean') return value === true ? (locale === 'en' ? 'On' : 'Ein') : locale === 'en' ? 'Off' : 'Aus';
  if (value === '' || value === null || value === undefined) return locale === 'en' ? 'None' : 'Keine';
  return String(value);
}

/** The prefix fallback for a key without an entry (the guard keeps it from shipping). */
const PREFIX_AREA: Readonly<Record<string, SettingsArea>> = {
  bank: 'bank',
  settlement: 'bank',
  files: 'belege',
  belege: 'belege',
  ledger: 'buchhaltung',
  payroll: 'buchhaltung',
  assets: 'buchhaltung',
  checklists: 'buchhaltung',
  audit: 'buchhaltung',
  dunning: 'verkauf',
  recurring: 'verkauf',
  mail: 'verkauf',
  releases: 'darstellung',
};

/** How a key is shown: its entry, else a fallback from the registry label and the key's prefix. */
export function presentationOf(key: string, fallbackLabel: PresentationText): SettingPresentation {
  const own = SETTING_PRESENTATION[key];
  if (own !== undefined) return own;
  const prefix = key.split('.')[0] ?? '';
  return {
    area: PREFIX_AREA[prefix] ?? 'agent',
    subgroup: t(SUB.allgemein),
    label: fallbackLabel,
    keywords: { 'de-CH': [], en: [] },
  };
}
