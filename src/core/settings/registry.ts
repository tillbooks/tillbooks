/**
 * D172, THE WORKSPACE SETTINGS REGISTRY: the one code-side list of every user setting.
 *
 * The owner's standing principle (15.10.2026): "give full configurability always. so users can
 * customize all of this. make a general note for future decisions to always leave all options for
 * configurability for the users with default setups". So every behaviour choice a decision makes is a
 * setting here, with the decided rule as its DEFAULT and the alternatives available as values.
 *
 * ONE ENTRY IS THE WHOLE OPT-IN. A capability that wants a setting adds one row below and reads it with
 * `getSetting(ctx, key)` (`./settings.ts`). The verbs (`settings_list`, `settings_get`, `settings_set`,
 * `settings_reset`), the A24 gate, the agent dial, the Vorschlag pin, the history and the Studio's
 * Einstellungen section all derive from the row; nothing else is edited.
 *
 * WHAT A ROW DECLARES.
 *  - `key`: stable, dotted, lower-case (`<area>.<name>`). Never renamed once shipped (a stored row is
 *    addressed by it); a retired key stays listed as `retired` rather than disappearing.
 *  - `schema`: the closed value shape. Integer and number carry inclusive bounds, a string carries a
 *    maximum length, an enum its members. A write is checked against it (`invalid_setting_value`), and a
 *    stored value that no longer fits reads as the default, so a read never throws.
 *  - `default`: the decided rule. It must itself satisfy the schema (asserted at load).
 *  - `owningCapability`: the A24 capability a person needs to CHANGE it (reading is `read_master_data`).
 *  - `dialCapability`: the agent-dial family a governed seat's change drafts under. `customize` is the
 *    floor; a setting that changes what money does names its family (`pay`, `post`, `vat-file`, ...),
 *    exactly as the per-capability config verbs do (`set_qr_auto_apply` is `pay`).
 *  - `area`: the owning capability (spec id and name) the Studio groups by.
 *  - `label` / `description`: en and de-CH, shown in the Studio and returned by `settings_list`.
 *
 * Module load ASSERTS the registry (unique keys, a key shape, a default that fits its schema, a known
 * capability and a known dial family), so a malformed row is a crash on import, not a runtime surprise.
 */

import { isCapability, type Capability } from '../access/capabilities.js';
// N00: the brief's section names. A leaf module (it imports nothing), so this creates no cycle.
import { BRIEF_SECTIONS_DEFAULT, BRIEF_SECTIONS_MAX_LENGTH } from '../hausbuch/sections.js';

/** The agent-dial families a setting's change may draft under (a subset of A26's `DIAL_CAPABILITIES`). */
export const SETTING_DIAL_CAPABILITIES = ['customize', 'post', 'pay', 'issue', 'send', 'dun', 'vat-file', 'close-period'] as const;
export type SettingDialCapability = (typeof SETTING_DIAL_CAPABILITIES)[number];

export type SettingValue = number | boolean | string;

export type SettingSchema =
  | { readonly type: 'integer'; readonly min: number; readonly max: number; readonly unit?: 'days' | 'items' | 'percent' }
  | { readonly type: 'number'; readonly min: number; readonly max: number }
  | { readonly type: 'boolean' }
  | { readonly type: 'string'; readonly maxLength: number }
  | { readonly type: 'enum'; readonly values: readonly string[] };

export interface LocalisedText {
  readonly en: string;
  readonly 'de-CH': string;
}

export interface SettingDef {
  readonly key: string;
  readonly schema: SettingSchema;
  readonly default: SettingValue;
  readonly owningCapability: Capability;
  readonly dialCapability: SettingDialCapability;
  readonly area: { readonly id: string; readonly label: LocalisedText };
  readonly label: LocalisedText;
  readonly description: LocalisedText;
  /**
   * N02/N04 (D183): a setting only a PERSON may change. `settings_set` and `settings_reset` refuse a
   * governed seat (`isGovernedSeat`: the local agent, a served agent member, a plugin call) with
   * `human_only` under every dial, before a Vorschlag is drafted and at execution alike, so an agent can
   * neither change it nor propose a change for a careless approval. For the settings that widen what TILL
   * reads from this computer (`files.source_roots`, `files.belegeingang_folder`) and, in N04, the
   * autobook settings. Absent means false.
   */
  readonly humanOnly?: boolean;
}

/**
 * THE REGISTRY. Append a row next to its capability's siblings, never reorder (the Studio groups by
 * `area` and keeps this order inside a group).
 */
export const SETTINGS: readonly SettingDef[] = [
  // --- G22, the checklists ------------------------------------------------------------------------
  // The seed entry (D172): a genuine default that was hard-coded until now. The Pendenzen hub's
  // `checklist_items_due` queue showed every open checklist item due within 14 days
  // (`CHECKLIST_DUE_WINDOW_DAYS`, G22 spec §2 story 7). Harmless: it decides what the hub SHOWS, never
  // what a checklist requires or when it is due. 14 stays the default.
  {
    key: 'checklists.attention_window_days',
    schema: { type: 'integer', min: 1, max: 90, unit: 'days' },
    default: 14,
    owningCapability: 'manage_checklists',
    dialCapability: 'customize',
    area: { id: 'G22', label: { en: 'Checklists', 'de-CH': 'Checklisten' } },
    label: { en: 'Look-ahead for due checklist steps', 'de-CH': 'Vorschau für fällige Checklisten-Schritte' },
    description: {
      en: 'How many days ahead Pendenzen lists open checklist steps as due. Overdue steps are always listed.',
      'de-CH': 'Wie viele Tage im Voraus Pendenzen offene Checklisten-Schritte als fällig zeigt. Überfällige Schritte erscheinen immer.',
    },
  },
  // --- A34, the payroll hand-off -------------------------------------------------------------------
  // D173 (owner Q7 + Q8, 15.10.2026): what `wage_journal_post` does when an earlier wage journal for
  // the same month still stands. `refuse` is the decided rule (Q7); `warn` posts and names the standing
  // posting(s); `off` does not check. It changes what money does, so it is owned by `post` and drafts
  // under the `post` family, the capability and family `wage_journal_post` itself uses (never cheaper).
  {
    key: 'payroll.month_guard',
    schema: { type: 'enum', values: ['refuse', 'warn', 'off'] },
    default: 'refuse',
    owningCapability: 'post',
    dialCapability: 'post',
    area: { id: 'A34', label: { en: 'Payroll', 'de-CH': 'Lohn' } },
    label: { en: 'Second wage journal for a month', 'de-CH': 'Zweite Lohnbuchung für einen Monat' },
    description: {
      en: 'What happens when a wage journal is posted for a month whose journal still stands: refuse (default), post with a warning, or do not check.',
      'de-CH': 'Was passiert, wenn für einen Monat gebucht wird, dessen Lohnbuchung noch steht: ablehnen (Standard), mit Warnung buchen oder nicht prüfen.',
    },
  },
  // D173 (owner Q14, 15.10.2026): when a non-regular payroll run (bonus, 13th salary, correction) needs a
  // reason. `correction` is the decided rule. Every non-regular run is audited whatever this says. Owned by
  // `post` and drafted under `post`, like `payroll.month_guard`.
  {
    key: 'payroll.nonregular_reason',
    schema: { type: 'enum', values: ['none', 'correction', 'all'] },
    default: 'correction',
    owningCapability: 'post',
    dialCapability: 'post',
    area: { id: 'A34', label: { en: 'Payroll', 'de-CH': 'Lohn' } },
    label: { en: 'Reason for a non-regular payroll run', 'de-CH': 'Grund für einen besonderen Lohnlauf' },
    description: {
      en: 'Which non-regular wage journals need a reason: none, corrections only (default), or every bonus, 13th salary and correction.',
      'de-CH': 'Welche besonderen Lohnbuchungen einen Grund brauchen: keine, nur Korrekturen (Standard) oder jeder Bonus, 13. Monatslohn und jede Korrektur.',
    },
  },
  // --- A15, the Mahnwesen --------------------------------------------------------------------------
  // D174 (owner Q1, 15.10.2026): what a fee reversal does to the run's UNSENT letters. `re-issue` is the
  // decided rule (the critic-passed behaviour: re-frozen without the fee, then sendable); `hold` is
  // D169's behaviour (the frozen demand stands and send holds the letter as `fee_reversed`). It changes
  // what a customer is sent, so it is owned by `dun` and drafts under the `dun` family, as
  // `dunning_fee_reverse` and `send_dunning_run` do.
  {
    key: 'dunning.refreeze',
    schema: { type: 'enum', values: ['re-issue', 'hold'] },
    default: 're-issue',
    owningCapability: 'dun',
    dialCapability: 'dun',
    area: { id: 'A15', label: { en: 'Dunning', 'de-CH': 'Mahnwesen' } },
    label: { en: 'Unsent letters when a fee is reversed', 'de-CH': 'Offene Briefe bei stornierter Mahngebühr' },
    description: {
      en: 'When a dunning run\'s fee is reversed: re-issue the letters not yet sent without the fee so they can be sent (default), or hold them unsent.',
      'de-CH': 'Wenn die Mahngebühr eines Mahnlaufs storniert wird: noch nicht versandte Briefe ohne die Gebühr neu ausstellen, damit sie versandt werden können (Standard), oder sie zurückhalten.',
    },
  },
  // D174 (owner Q9): the date a RE-ISSUED letter carries. `run_date` (default): the run's date, since
  // under OR 102 a Mahnung takes effect on receipt and this letter was never received. `today`: the day
  // of the re-issue, fixed at the re-freeze (a later change of this setting never re-dates a letter).
  {
    key: 'dunning.letter_date',
    schema: { type: 'enum', values: ['run_date', 'today'] },
    default: 'run_date',
    owningCapability: 'dun',
    dialCapability: 'dun',
    area: { id: 'A15', label: { en: 'Dunning', 'de-CH': 'Mahnwesen' } },
    label: { en: 'Date of a re-issued letter', 'de-CH': 'Datum eines neu ausgestellten Briefs' },
    description: {
      en: 'The date a letter re-issued without a reversed fee carries: the run date (default) or the day it was re-issued.',
      'de-CH': 'Das Datum eines Briefs, der ohne die stornierte Gebühr neu ausgestellt wird: das Datum des Mahnlaufs (Standard) oder der Tag der Neuausstellung.',
    },
  },
  // --- A39, the bank inbox ------------------------------------------------------------------------
  // D175 point 5 (A39 §14.4): a complete Buchungsregel (nothing to ask) proposes its booking `sure`, so the
  // one bulk button "Alle vorgeschlagenen buchen" books it (`bulk`, the owner's pick and the default); with
  // `suggest` a rule's proposal is never `sure` and every line waits for its own click. Nothing ever posts
  // by itself either way. Owned by `post` (the right `set_bank_standard` asserts) and drafted under `post`
  // on the agent dial: the setting decides what the bulk button books.
  {
    key: 'bank.buchungsregel_mode',
    schema: { type: 'enum', values: ['bulk', 'suggest'] },
    default: 'bulk',
    owningCapability: 'post',
    dialCapability: 'post',
    area: { id: 'A39', label: { en: 'Bank', 'de-CH': 'Bank' } },
    label: {
      en: "Booking rules and 'Book all proposed'",
      'de-CH': "Buchungsregeln und 'Alle vorgeschlagenen buchen'",
    },
    description: {
      en: 'bulk: a complete booking rule counts for the bulk button. suggest: every line is checked one by one.',
      'de-CH': 'bulk: Eine vollständige Buchungsregel zählt für den Sammelknopf. suggest: Jede Zeile wird einzeln geprüft.',
    },
  },
  // D176 point 3 (A39 §15.3): a "Nicht buchen" Buchungsregel proposes ignoring its lines. `suggest` (the
  // default, the decision's ruling): each such line waits for its own click, because an ignored line never
  // reaches the ledger and a mistaken bulk ignore hides money. `bulk`: the proposal is `sure` and the bulk
  // button ignores the line with the rule's reason and note. A36's review signal stays on either way.
  {
    key: 'bank.buchungsregel_ignore_mode',
    schema: { type: 'enum', values: ['suggest', 'bulk'] },
    default: 'suggest',
    owningCapability: 'post',
    dialCapability: 'post',
    area: { id: 'A39', label: { en: 'Bank', 'de-CH': 'Bank' } },
    label: {
      en: "'Do not book' rules and 'Book all proposed'",
      'de-CH': "'Nicht buchen'-Regeln und 'Alle vorgeschlagenen buchen'",
    },
    description: {
      en: "suggest: a line a 'Do not book' rule matches waits for its own click. bulk: the bulk button sets such lines aside with the rule's reason.",
      'de-CH': "suggest: Eine Zeile, auf die eine 'Nicht buchen'-Regel passt, wartet auf deinen Klick. bulk: Der Sammelknopf legt solche Zeilen mit dem Grund der Regel beiseite.",
    },
  },
  // D177 point 2 (A39 §16.1): a Buchungsregel whose amounts are COMPUTED from the line (`factor` legs, an
  // estimate such as a platform payout's gross) proposes the booking. `suggest` (the default, the
  // decision's ruling: an estimate deserves a look): each such line books with its own click. `bulk`: the
  // proposal is `sure` and the bulk button books it with the computed amounts.
  {
    key: 'bank.buchungsregel_computed_mode',
    schema: { type: 'enum', values: ['suggest', 'bulk'] },
    default: 'suggest',
    owningCapability: 'post',
    dialCapability: 'post',
    area: { id: 'A39', label: { en: 'Bank', 'de-CH': 'Bank' } },
    label: {
      en: "Computed amounts and 'Book all proposed'",
      'de-CH': "Berechnete Beträge und 'Alle vorgeschlagenen buchen'",
    },
    description: {
      en: 'suggest: a line whose rule computes an amount waits for its own click. bulk: the bulk button books such lines with the computed amounts.',
      'de-CH': 'suggest: Eine Zeile, deren Regel einen Betrag berechnet, wartet auf deinen Klick. bulk: Der Sammelknopf bucht solche Zeilen mit den berechneten Beträgen.',
    },
  },
  // D178 point 3 (A20 §11.5, A39 §19): a bank line in the account currency whose statement says it paid a
  // foreign amount with a fee inside it (a card payment abroad). `propose_split` (the owner's pick, the
  // default): book in the account currency and OFFER splitting the fee onto the bank-charges account;
  // `prefill_split`: the split is the proposal; `facts_only`: show amount, rate and fee, propose nothing;
  // `transaction_currency`: book the counter-leg in the transaction currency at the effective rate, behind
  // a consequence warning, MWST on it refused at the control. The last is DEFINED here and implemented in
  // posting by a later D178 node; until it lands the proposal reads it as `facts_only`. Nothing posts by
  // itself in any mode. Owned by `post` and drafted under `post`: it decides what a booking proposes.
  {
    key: 'bank.fx_mode',
    schema: { type: 'enum', values: ['propose_split', 'prefill_split', 'facts_only', 'transaction_currency'] },
    default: 'propose_split',
    owningCapability: 'post',
    dialCapability: 'post',
    area: { id: 'A39', label: { en: 'Bank', 'de-CH': 'Bank' } },
    label: {
      en: 'Card payments in a foreign currency',
      'de-CH': 'Kartenzahlungen in Fremdwährung',
    },
    description: {
      en: 'propose_split: book in the account currency and offer splitting the fee onto bank charges. prefill_split: the split is filled in. facts_only: show amount, rate and fee only. transaction_currency: book the expense in the foreign currency at the effective rate; it is then revalued at the period end and MWST on it is refused (in preparation: until then it acts like facts_only).',
      'de-CH': 'propose_split: In Kontowährung buchen und anbieten, die Gebühr auf Bankspesen abzuspalten. prefill_split: Die Aufteilung ist schon ausgefüllt. facts_only: Nur Betrag, Kurs und Gebühr zeigen. transaction_currency: Den Aufwand in der Fremdwährung zum effektiven Kurs buchen; er wird dann am Periodenende neu bewertet, und MWST darauf lehnt TILL ab (in Vorbereitung: bis dahin wie facts_only).',
    },
  },
  // D178 point 19 (owner, 21.10.2026; A20 §11.4): what happens to a line another statement format may
  // already have brought in. `ask` (the owner's default): nothing is dropped across formats, every possible
  // duplicate waits for the person's decision. `auto_strong`: the bank's own reference on the same booking
  // date with the same money drops the new line; everything weaker is still asked.
  {
    key: 'bank.cross_format_duplicates',
    schema: { type: 'enum', values: ['ask', 'auto_strong'] },
    default: 'ask',
    owningCapability: 'pay',
    dialCapability: 'pay',
    area: { id: 'A39', label: { en: 'Bank', 'de-CH': 'Bank' } },
    label: {
      en: 'Possible duplicates across statement formats',
      'de-CH': 'Mögliche Duplikate über Auszugsformate',
    },
    description: {
      en: 'ask: every line another format may already have brought in is imported and waits for your decision (Duplikat or Kein Duplikat). auto_strong: a line with the bank\'s own reference, the same money and the same booking date is left out; everything else still waits for you.',
      'de-CH': 'ask: Jede Zeile, die ein anderes Format vielleicht schon gebracht hat, wird importiert und wartet auf deinen Entscheid (Duplikat oder Kein Duplikat). auto_strong: Eine Zeile mit der Referenz der Bank, gleichem Betrag und gleichem Buchungsdatum wird weggelassen; alles andere wartet weiter auf dich.',
    },
  },
  // D178 point 3 (A20 §11.5): the account a card payment's fee is proposed on. Empty (the default):
  // resolved in the chart, never by an id: 6940 Bankspesen when the chart has it, else the core seed's
  // 6900 Finanzaufwand. A number that names no live account falls back the same way.
  {
    key: 'bank.fee_account',
    schema: { type: 'string', maxLength: 16 },
    default: '',
    owningCapability: 'post',
    dialCapability: 'post',
    area: { id: 'A39', label: { en: 'Bank', 'de-CH': 'Bank' } },
    label: {
      en: 'Account for bank charges',
      'de-CH': 'Konto für Bankspesen',
    },
    description: {
      en: 'The account number a card payment fee is proposed on. Empty: 6940 Bankspesen if the chart has it, else 6900 Finanzaufwand. A number a bank line cannot be booked to (the bank account itself, for one) is passed over the same way.',
      'de-CH': 'Die Kontonummer, auf die TILL die Gebühr einer Kartenzahlung vorschlägt. Leer: 6940 Bankspesen, falls dein Kontenplan es hat, sonst 6900 Finanzaufwand. Eine Nummer, auf die keine Bankzeile gebucht werden kann (etwa das Bankkonto selbst), übergeht TILL ebenso.',
    },
  },
  // D178 point 1 (A39 §17.1): a bank line booked against a CONTACT with no document (bexio's
  // "Kundenbuchung"). `guthaben` (the owner's pick and the default): the amount becomes the contact's
  // Guthaben through A14's unallocated rest, applied later to an invoice or bill by `allocate_payment`.
  // `anzahlung`: the amount is booked to an Anzahlungen account instead (the two accounts below). It
  // changes what money does and where, so it is owned by `pay`, the right the contact target needs, and
  // drafted under the `pay` family on the agent dial. A single booking may differ with an audited reason.
  {
    key: 'bank.contact_booking_mode',
    schema: { type: 'enum', values: ['guthaben', 'anzahlung'] },
    default: 'guthaben',
    owningCapability: 'pay',
    dialCapability: 'pay',
    area: { id: 'A39', label: { en: 'Bank', 'de-CH': 'Bank' } },
    label: { en: 'Booking a bank line to a contact', 'de-CH': 'Bankzeile auf einen Kontakt buchen' },
    description: {
      en: 'guthaben: the amount becomes the contact\'s credit and is applied to a later invoice or bill. anzahlung: the amount is booked to the prepayment accounts below.',
      'de-CH': 'guthaben: Der Betrag wird zum Guthaben des Kontakts und später mit einer Rechnung verrechnet. anzahlung: Der Betrag wird auf die Anzahlungskonten unten gebucht.',
    },
  },
  // D178 point 1 (A39 §17.1): the account a customer's prepayment (or its refund) is booked to in the
  // `anzahlung` mode. 2030 "Erhaltene Anzahlungen" in the Schweizer Kontenrahmen KMU (school version and
  // veb.ch edition, group 200), a liability. TILL's core seed does not carry it: the booking refuses
  // `needs_anzahlung_account` until the account exists or this setting names another one.
  {
    key: 'bank.anzahlung_customer_account',
    schema: { type: 'string', maxLength: 10 },
    default: '2030',
    owningCapability: 'pay',
    dialCapability: 'pay',
    area: { id: 'A39', label: { en: 'Bank', 'de-CH': 'Bank' } },
    label: { en: 'Account for customer prepayments', 'de-CH': 'Konto für erhaltene Anzahlungen' },
    description: {
      en: 'The account number a prepayment received from a customer is booked to when a bank line is booked to a contact as a prepayment.',
      'de-CH': 'Die Kontonummer, auf die eine Anzahlung eines Kunden gebucht wird, wenn eine Bankzeile als Anzahlung auf einen Kontakt gebucht wird.',
    },
  },
  // D178 point 1 (A39 §17.1): the account a prepayment MADE to a supplier (or its refund) is booked to in
  // the `anzahlung` mode. The KMU chart has no dedicated account for it: 1190 "Sonstige kurzfristige
  // Forderungen" (group 114) holds a claim to a delivery; 1170/1171 are Vorsteuer and never a default.
  {
    key: 'bank.anzahlung_supplier_account',
    schema: { type: 'string', maxLength: 10 },
    default: '1190',
    owningCapability: 'pay',
    dialCapability: 'pay',
    area: { id: 'A39', label: { en: 'Bank', 'de-CH': 'Bank' } },
    label: { en: 'Account for prepayments to suppliers', 'de-CH': 'Konto für geleistete Anzahlungen' },
    description: {
      en: 'The account number a prepayment made to a supplier is booked to when a bank line is booked to a contact as a prepayment.',
      'de-CH': 'Die Kontonummer, auf die eine Anzahlung an einen Lieferanten gebucht wird, wenn eine Bankzeile als Anzahlung auf einen Kontakt gebucht wird.',
    },
  },
  // Owner, 21.10.2026 (A39 §17.1): an Anzahlung received or made on a Bankkonto in ANOTHER currency.
  // `fixed` (the owner's pick, the default): fixed in the base currency at the receipt rate, a
  // non-monetary item never revalued (a conversion entry carries the bank leg, the Anzahlungen account
  // holds francs). `foreign`: held in the account's currency and revalued at the period end like any
  // foreign position. It decides where money sits, so `pay` owns it, as the mode above.
  {
    key: 'bank.anzahlung_fx_mode',
    schema: { type: 'enum', values: ['fixed', 'foreign'] },
    default: 'fixed',
    owningCapability: 'pay',
    dialCapability: 'pay',
    area: { id: 'A39', label: { en: 'Bank', 'de-CH': 'Bank' } },
    label: { en: 'Prepayments on a foreign-currency account', 'de-CH': 'Anzahlungen auf einem Fremdwährungskonto' },
    description: {
      en: 'fixed: the prepayment is fixed in the book currency at the receipt rate and never revalued. foreign: it is held in the account currency and revalued at the period end.',
      'de-CH': 'fixed: Die Anzahlung wird zum Kurs bei Eingang in der Buchungswährung festgehalten und nie neu bewertet. foreign: Sie bleibt in der Kontowährung und wird am Periodenende neu bewertet.',
    },
  },
  // Owner, 21.10.2026: VAT on a RECEIVED customer Anzahlung. Off (the default): the VAT arises with the
  // invoice. On: the Umsatzsteuer is booked when the Anzahlung arrives (MWSTG Art. 40) and cleared when the
  // Guthaben is applied to the invoice (anzahlungVat.ts). It changes a filed figure, so it is owned by the
  // VAT configuration right and drafted under `vat-file`, as `set_fx_method` is.
  {
    key: 'bank.anzahlung_vat',
    schema: { type: 'boolean' },
    default: false,
    owningCapability: 'manage_vat_config',
    dialCapability: 'vat-file',
    area: { id: 'A39', label: { en: 'Bank', 'de-CH': 'Bank' } },
    label: { en: 'VAT on received prepayments', 'de-CH': 'MWST auf erhaltenen Anzahlungen' },
    description: {
      en: 'On: the VAT on a customer prepayment is booked when it arrives and cleared when the prepayment is applied to the invoice. Off: the VAT arises with the invoice.',
      'de-CH': 'Ein: Die MWST auf einer Anzahlung eines Kunden wird bei Eingang gebucht und beim Anrechnen an die Rechnung zurückgebucht. Aus: Die MWST entsteht mit der Rechnung.',
    },
  },
  // The code the VAT on a received Anzahlung is booked with: the normal rate, `UST81`, by default.
  {
    key: 'bank.anzahlung_vat_code',
    schema: { type: 'string', maxLength: 20 },
    default: 'UST81',
    owningCapability: 'manage_vat_config',
    dialCapability: 'vat-file',
    area: { id: 'A39', label: { en: 'Bank', 'de-CH': 'Bank' } },
    label: { en: 'VAT code for received prepayments', 'de-CH': 'MWST-Code für erhaltene Anzahlungen' },
    description: {
      en: 'The output VAT code a received prepayment is taxed with when VAT on received prepayments is on.',
      'de-CH': 'Der Umsatzsteuer-Code, mit dem eine erhaltene Anzahlung besteuert wird, wenn die MWST auf erhaltenen Anzahlungen eingeschaltet ist.',
    },
  },
  // Owner, 21.10.2026 (critic E3-R2-2): a refund of a customer prepayment whose VAT was booked on receipt is
  // an Entgeltsminderung. `reverse` (the default): the matching share of the receipt VAT is corrected
  // automatically. `refuse`: the refund books only once the call states the correction. `warn`: the refund
  // books with a warning and the VAT stays. A filed figure, so owned and drafted like the two above.
  {
    key: 'bank.anzahlung_vat_refund',
    schema: { type: 'enum', values: ['reverse', 'refuse', 'warn'] },
    default: 'reverse',
    owningCapability: 'manage_vat_config',
    dialCapability: 'vat-file',
    area: { id: 'A39', label: { en: 'Bank', 'de-CH': 'Bank' } },
    label: { en: 'VAT when a prepayment is refunded', 'de-CH': 'MWST bei Rückzahlung einer Anzahlung' },
    description: {
      en: 'reverse: the VAT booked on the refunded prepayment is corrected automatically. refuse: the refund needs the correction stated. warn: the refund books with a warning.',
      'de-CH': 'reverse: Die MWST auf der zurückbezahlten Anzahlung wird automatisch korrigiert. refuse: Die Rückzahlung braucht die Angabe zur Korrektur. warn: Die Rückzahlung wird mit einem Hinweis gebucht.',
    },
  },
  // --- N03, Buchungsregeln that learn ---------------------------------------------------------------
  // D183 (N03 §6b): the rule miner and the rule health flag. Each only decides what TILL OFFERS (a
  // Vorschlag a person approves, a "Regel anpassen?" hint); the miner never writes a rule and stats are
  // derived evidence, never edited (Fixed). Owned by `post` and drafted under `post`: they shape what a
  // booking proposes, the capability `set_bank_standard` itself asks.
  {
    key: 'rules.miner',
    schema: { type: 'enum', values: ['on', 'off'] },
    default: 'on',
    owningCapability: 'post',
    dialCapability: 'post',
    area: { id: 'N03', label: { en: 'Buchungsregeln', 'de-CH': 'Buchungsregeln' } },
    label: { en: 'Propose new rules from the bookings', 'de-CH': 'Neue Regeln aus den Buchungen vorschlagen' },
    description: {
      en: 'on (default): once a day TILL looks for counterparties you booked the same way several times and proposes a rule in Pendenzen. off: no proposals.',
      'de-CH': 'on (Standard): Einmal am Tag sucht TILL Gegenparteien, die du mehrmals gleich gebucht hast, und schlägt in den Pendenzen eine Regel vor. off: keine Vorschläge.',
    },
  },
  {
    key: 'rules.miner_min_repeats',
    schema: { type: 'integer', min: 2, max: 50, unit: 'items' },
    default: 3,
    owningCapability: 'post',
    dialCapability: 'post',
    area: { id: 'N03', label: { en: 'Buchungsregeln', 'de-CH': 'Buchungsregeln' } },
    label: { en: 'Same bookings before a rule is proposed', 'de-CH': 'Gleiche Buchungen bis zum Regelvorschlag' },
    description: {
      en: 'How many lines of one counterparty must be booked to the same accounts, VAT codes and split before TILL proposes a rule.',
      'de-CH': 'Wie viele Zeilen einer Gegenpartei gleich gebucht sein müssen (Konten, MWST-Codes, Aufteilung), bis TILL eine Regel vorschlägt.',
    },
  },
  {
    key: 'rules.miner_lookback_days',
    schema: { type: 'integer', min: 30, max: 1095, unit: 'days' },
    default: 365,
    owningCapability: 'post',
    dialCapability: 'post',
    area: { id: 'N03', label: { en: 'Buchungsregeln', 'de-CH': 'Buchungsregeln' } },
    label: { en: 'How far back proposals look', 'de-CH': 'Wie weit Regelvorschläge zurückschauen' },
    description: {
      en: 'Only bank lines booked within this many days count towards a proposed rule, and its test looks this far back by default.',
      'de-CH': 'Nur Bankzeilen aus so vielen Tagen zählen für einen Regelvorschlag, und sein Test schaut standardmässig so weit zurück.',
    },
  },
  {
    key: 'rules.miner_max_open',
    schema: { type: 'integer', min: 1, max: 100, unit: 'items' },
    default: 10,
    owningCapability: 'post',
    dialCapability: 'post',
    area: { id: 'N03', label: { en: 'Buchungsregeln', 'de-CH': 'Buchungsregeln' } },
    label: { en: 'Open rule proposals at most', 'de-CH': 'Höchstens offene Regelvorschläge' },
    description: {
      en: 'At most this many rule proposals wait in Pendenzen at once; the ones with the newest bookings come first.',
      'de-CH': 'Höchstens so viele Regelvorschläge warten gleichzeitig in den Pendenzen; die mit den neusten Buchungen kommen zuerst.',
    },
  },
  {
    key: 'rules.health_changed_of_last5',
    schema: { type: 'integer', min: 1, max: 5, unit: 'items' },
    default: 2,
    owningCapability: 'post',
    dialCapability: 'post',
    area: { id: 'N03', label: { en: 'Buchungsregeln', 'de-CH': 'Buchungsregeln' } },
    label: { en: "When a rule asks 'Adjust rule?'", 'de-CH': "Wann eine Regel 'Regel anpassen?' fragt" },
    description: {
      en: 'A rule is flagged when at least this many of its last 5 proposals were changed before booking.',
      'de-CH': 'Eine Regel wird markiert, wenn mindestens so viele ihrer letzten 5 Vorschläge vor dem Buchen geändert wurden.',
    },
  },
  // --- N04, Autopilot: rules that earn the right to book, and Dauerbuchungen ------------------------------
  // D183 (N04 §6b): earned autonomy per Buchungsregel. Every autobook setting is HUMAN-ONLY (a governed seat
  // can neither change nor propose a change): together with the grant they decide what books with no person
  // looking, so an agent never widens its own reach. Owned by `post` (the right `book_bank_line` asserts for
  // a booking to accounts, the right the grant itself needs) and drafted under `post`.
  {
    key: 'rules.autobook',
    schema: { type: 'enum', values: ['offer', 'off'] },
    default: 'offer',
    owningCapability: 'post',
    dialCapability: 'post',
    humanOnly: true,
    area: { id: 'N04', label: { en: 'Autopilot', 'de-CH': 'Autopilot' } },
    label: { en: 'Rules that book on their own', 'de-CH': 'Regeln, die selbst buchen' },
    description: {
      en: 'offer (default): a rule you accepted unchanged often enough is offered for automatic booking, and a rule you switched on books its lines by itself. off: nothing is booked automatically and nothing is offered; the switches are kept and work again when you choose offer.',
      'de-CH': 'offer (Standard): Eine Regel, die du oft genug unverändert übernommen hast, wird dir zum automatischen Buchen angeboten, und eine eingeschaltete Regel bucht ihre Zeilen selbst. off: Nichts wird automatisch gebucht und nichts angeboten; die Schalter bleiben gespeichert und gelten wieder, sobald du offer wählst.',
    },
  },
  // Critic N04 F5: a schedule an AGENT set proposes as `system`; how many of its Vorschläge may wait at once
  // (catch-up of a far start included), so an agent's schedule cannot flood Pendenzen. A person's schedule
  // is bounded only by the engine's per-tick catch-up cap. Human-only.
  {
    key: 'rules.vorlage_agent_open_max',
    schema: { type: 'integer', min: 1, max: 24, unit: 'items' },
    default: 3,
    owningCapability: 'post',
    dialCapability: 'post',
    humanOnly: true,
    area: { id: 'N04', label: { en: 'Autopilot', 'de-CH': 'Autopilot' } },
    label: { en: 'Open proposals of an agent schedule', 'de-CH': 'Offene Vorschläge einer Agenten-Wiederholung' },
    description: {
      en: 'How many proposals a recurring entry set up by the agent may have waiting at once. Further periods are proposed once you decided the waiting ones; none is skipped.',
      'de-CH': 'Wie viele Vorschläge eine vom Agenten eingerichtete Dauerbuchung gleichzeitig offen haben darf. Weitere Perioden folgen, sobald du die offenen entschieden hast; keine fällt weg.',
    },
  },
  {
    key: 'rules.autobook_offer_after',
    schema: { type: 'integer', min: 3, max: 100, unit: 'items' },
    default: 10,
    owningCapability: 'post',
    dialCapability: 'post',
    humanOnly: true,
    area: { id: 'N04', label: { en: 'Autopilot', 'de-CH': 'Autopilot' } },
    label: { en: 'Unchanged bookings before the offer', 'de-CH': 'Unveränderte Buchungen bis zum Angebot' },
    description: {
      en: "How many times you must have booked a rule's proposal unchanged (since the rule was last edited or paused) before TILL offers to book it automatically.",
      'de-CH': 'Wie oft du den Vorschlag einer Regel unverändert gebucht haben musst (seit sie zuletzt bearbeitet oder pausiert wurde), bis TILL dir das automatische Buchen anbietet.',
    },
  },
  {
    key: 'rules.autobook_amount_headroom',
    schema: { type: 'integer', min: 100, max: 1000, unit: 'percent' },
    default: 150,
    owningCapability: 'post',
    dialCapability: 'post',
    humanOnly: true,
    area: { id: 'N04', label: { en: 'Autopilot', 'de-CH': 'Autopilot' } },
    label: { en: 'Amount ceiling (percent of the largest booking)', 'de-CH': 'Betragsgrenze (Prozent der grössten Buchung)' },
    description: {
      en: "When you switch a rule on, its ceiling is fixed at this percentage of the largest booking you confirmed yourself, in that booking's currency. A larger line or one in another currency is never booked automatically.",
      'de-CH': 'Beim Einschalten wird die Grenze einer Regel auf diesen Prozentsatz der grössten Buchung festgelegt, die du selbst bestätigt hast, in deren Währung. Eine grössere Zeile oder eine in anderer Währung wird nie automatisch gebucht.',
    },
  },
  {
    key: 'rules.autobook_suspend_on_change',
    schema: { type: 'enum', values: ['on', 'off'] },
    default: 'on',
    owningCapability: 'post',
    dialCapability: 'post',
    humanOnly: true,
    area: { id: 'N04', label: { en: 'Autopilot', 'de-CH': 'Autopilot' } },
    label: { en: 'Pause a rule when you change its proposal', 'de-CH': 'Regel pausieren, wenn du ihren Vorschlag änderst' },
    description: {
      en: "on (default): booking a line differently from what an automatic rule proposes pauses that rule's automatic booking. off: it keeps booking. Undoing an automatic booking always pauses the rule.",
      'de-CH': 'on (Standard): Buchst du eine Zeile anders, als eine automatische Regel vorschlägt, pausiert das automatische Buchen dieser Regel. off: Sie bucht weiter. Das Rückgängigmachen einer automatischen Buchung pausiert die Regel immer.',
    },
  },
  {
    key: 'rules.autobook_scope',
    schema: { type: 'enum', values: ['new_lines', 'open_lines'] },
    default: 'new_lines',
    owningCapability: 'post',
    dialCapability: 'post',
    humanOnly: true,
    area: { id: 'N04', label: { en: 'Autopilot', 'de-CH': 'Autopilot' } },
    label: { en: 'Which lines a switched-on rule books', 'de-CH': 'Welche Zeilen eine eingeschaltete Regel bucht' },
    description: {
      en: 'new_lines (default): only bank lines imported after you switched the rule on. open_lines: also the lines that were already waiting.',
      'de-CH': 'new_lines (Standard): Nur Bankzeilen, die nach dem Einschalten der Regel eingelesen werden. open_lines: Auch die Zeilen, die schon offen waren.',
    },
  },
  // D183 (N04 US-N04.5): due Serienrechnungen generated by the scheduler as the owner seat. `draft` (the
  // default): due invoices become drafts and are never issued unattended, whatever a schedule's autoIssue
  // says. `honour_auto_issue`: each schedule's own autoIssue decides. `off`: the scheduler leaves A12 alone.
  // Human-only (an agent never arms unattended issuing); owned by `issue`, the right `run_due_recurring` asks.
  {
    key: 'recurring.auto_generate',
    schema: { type: 'enum', values: ['draft', 'honour_auto_issue', 'off'] },
    default: 'draft',
    owningCapability: 'issue',
    dialCapability: 'issue',
    humanOnly: true,
    area: { id: 'N04', label: { en: 'Autopilot', 'de-CH': 'Autopilot' } },
    label: { en: 'Due recurring invoices', 'de-CH': 'Fällige Serienrechnungen' },
    description: {
      en: 'draft (default): TILL creates due recurring invoices as drafts by itself and never issues them. honour_auto_issue: a schedule set to issue automatically is issued. off: nothing is created until you run it.',
      'de-CH': 'draft (Standard): TILL erstellt fällige Serienrechnungen selbst als Entwürfe und stellt sie nie aus. honour_auto_issue: Eine Serie, die automatisch ausstellen soll, wird ausgestellt. off: Nichts wird erstellt, bis du es auslöst.',
    },
  },
  // --- A02, the journal: the Belegnummer ----------------------------------------------------------
  // D178 point 2 (owner, 21.10.2026): a Belegnummer on every posted entry, gap-free per series, assigned in
  // the posting transaction (`core/ledger/entryNumber.ts`, A02 §4b). `continue_migrated` is the decided
  // default (bexio's numbers carry on); the other options the decision named are values here. Every change
  // applies FORWARD only: a number already assigned never moves. Owned by `manage_settings` (book
  // configuration, the `set_fiscal_config` capability) and drafted under `post` on the dial, so a governed
  // seat never changes the numbering more cheaply than it could post.
  {
    key: 'ledger.belegnummer_mode',
    schema: { type: 'enum', values: ['continue_migrated', 'from_start', 'per_fiscal_year', 'off'] },
    default: 'continue_migrated',
    owningCapability: 'manage_settings',
    dialCapability: 'post',
    area: { id: 'A02', label: { en: 'Journal', 'de-CH': 'Journal' } },
    label: { en: 'Voucher numbering', 'de-CH': 'Belegnummern' },
    description: {
      en: 'continue_migrated (default): a migrated entry keeps its old number when its reference carries one, either a plain integer or a bexio reference such as "Manuelle Buchung 4711 (8801)", which keeps 8801. Imports, and reversals that correct an import, stay without a number for now. The first booking that does not come from an import numbers them all in one run: old numbers stay, new entries follow after the highest. A later import keeps its old number only if that number is free, below the next number and claimed by no other voucher. Otherwise it gets the next number and keeps the old one as reference. from_start: one run from the start number. per_fiscal_year: one run per fiscal year, shown as 2026-0001. off: no numbers. When you switch numbering back on, entries without a number get one at once. Imports and their reversals under continue_migrated still wait for the first booking that does not come from an import. A change never renumbers an entry.',
      'de-CH': 'continue_migrated (Standard): Eine übernommene Buchung behält ihre alte Nummer, wenn ihre Referenz eine trägt, also eine reine Zahl oder eine bexio-Referenz wie "Manuelle Buchung 4711 (8801)", die 8801 behält. Importe und Stornos, die einen Import korrigieren, bleiben vorerst ohne Nummer. Erst die erste Buchung, die nicht aus einem Import stammt, nummeriert alle in einem Lauf: Alte Nummern bleiben, neue Buchungen folgen nach der höchsten. Ein späterer Import behält seine alte Nummer nur, wenn sie frei ist, unter der nächsten Nummer liegt und kein anderer Beleg sie beansprucht. Sonst erhält er die nächste Nummer und behält die alte als Referenz. from_start: ein Lauf ab der Startnummer. per_fiscal_year: ein Lauf pro Geschäftsjahr, angezeigt als 2026-0001. off: keine Nummern. Schaltest du die Nummerierung wieder ein, erhalten Buchungen ohne Nummer sofort eine. Importe und ihre Stornos unter continue_migrated warten aber weiter auf die erste Buchung, die nicht aus einem Import stammt. Eine Änderung nummeriert nie eine Buchung um.',
    },
  },
  // The first number of a series that has not started yet (a fresh book, a new fiscal year under
  // `per_fiscal_year`). A running series keeps its next number: no jump, no gap.
  {
    key: 'ledger.belegnummer_start',
    schema: { type: 'integer', min: 1, max: 999999999 },
    default: 1,
    owningCapability: 'manage_settings',
    dialCapability: 'post',
    area: { id: 'A02', label: { en: 'Journal', 'de-CH': 'Journal' } },
    label: { en: 'First voucher number', 'de-CH': 'Erste Belegnummer' },
    description: {
      en: 'The first number of a run that has not started yet: a new book, or a new fiscal year when numbering per fiscal year. A running series keeps its next number.',
      'de-CH': 'Die erste Nummer eines Laufs, der noch nicht begonnen hat: ein neues Buch oder ein neues Geschäftsjahr bei Nummern pro Geschäftsjahr. Ein laufender Lauf behält seine nächste Nummer.',
    },
  },
  // Text before every number assigned from now on (`B17`, `B2026-0001`). Stored in the number's display at
  // assignment, so changing it never rewrites a number already shown.
  {
    key: 'ledger.belegnummer_prefix',
    schema: { type: 'string', maxLength: 12 },
    default: '',
    owningCapability: 'manage_settings',
    dialCapability: 'post',
    area: { id: 'A02', label: { en: 'Journal', 'de-CH': 'Journal' } },
    label: { en: 'Voucher number prefix', 'de-CH': 'Präfix der Belegnummer' },
    description: {
      en: 'Text placed before every number assigned from now on, for example B gives B17 or B2026-0001. Empty by default, or up to 12 characters from A-Z a-z 0-9 . _ / -, starting with a letter or digit and not ending in a digit. A prefix that could repeat an existing number is refused. Numbers already assigned keep their form.',
      'de-CH': 'Text vor jeder ab jetzt vergebenen Nummer, zum Beispiel ergibt B die Nummer B17 oder B2026-0001. Standardmässig leer, sonst bis zu 12 Zeichen aus A-Z a-z 0-9 . _ / -, beginnend mit einem Buchstaben oder einer Ziffer und nicht auf eine Ziffer endend. Ein Präfix, das eine bestehende Nummer wiederholen könnte, wird abgelehnt. Bereits vergebene Nummern behalten ihre Form.',
    },
  },
  // D178 point 2 follow-up (owner, 21.10.2026): one bexio voucher migrated as several TILL entries (all with
  // the same `(<Belegnummer>)` in their ref). `share` is the owner's default: every entry of the voucher reads
  // the voucher's number. The other options shown ship as values (D172): `suffix` (8802, 8802.2, 8802.3 in entry
  // order) and `first_keeps` (the first entry keeps 8802, the others take TILL's next numbers). Applies to the
  // backfill and to later imports; an assigned number stays unique per entry in every mode.
  {
    key: 'ledger.belegnummer_split_voucher',
    schema: { type: 'enum', values: ['share', 'suffix', 'first_keeps'] },
    default: 'share',
    owningCapability: 'manage_settings',
    dialCapability: 'post',
    area: { id: 'A02', label: { en: 'Journal', 'de-CH': 'Journal' } },
    label: { en: 'One old voucher in several entries', 'de-CH': 'Ein alter Beleg in mehreren Buchungen' },
    description: {
      en: 'When one migrated voucher (bexio, e.g. "Bank Buchung 912 (8802)") became several entries: share (default) gives every entry the number 8802; suffix gives 8802, 8802.2, 8802.3 in entry order; first_keeps gives 8802 to the first entry and the next numbers to the others. Entries with identical content count as pieces too. The numbering plan flags them as a possible double import for you to check.',
      'de-CH': 'Wenn ein übernommener Beleg (bexio, z. B. "Bank Buchung 912 (8802)") zu mehreren Buchungen wurde: share (Standard) gibt jeder Buchung die Nummer 8802; suffix gibt 8802, 8802.2, 8802.3 in der Reihenfolge der Buchungen; first_keeps gibt 8802 der ersten Buchung und den übrigen die nächsten Nummern. Buchungen mit identischem Inhalt zählen ebenfalls als Teile. Der Nummerierungsplan markiert sie als möglichen Doppelimport, damit du sie prüfen kannst.',
    },
  },
  // --- G15, Pendenzen ---------------------------------------------------------------------------
  // D178 point 5 (owner, 21.10.2026): how Pendenzen approves several bank Vorschläge. `tick` (the default):
  // the person ticks rows (never pre-ticked, D152 rule 5) and approves the selection; `single`: one by
  // one, no boxes; `all_with_confirm`: one button for all, behind a confirmation naming the count and
  // the total. Every mode runs the existing `approve_drafted_action` once per row, so the human-only
  // (D161) and stale (D162) guards hold per item whatever this says, and only a decision on a bank line is
  // ever batched (critic N4 M1). Owned by `manage_agent_dial`, the right that approves: the agent seat is
  // denied it at step 0, so it can neither change nor even propose this setting. `post` is the dial family
  // a governed seat that held the right would draft under (it decides how bookings are approved).
  {
    key: 'attention.approval_batch_mode',
    schema: { type: 'enum', values: ['tick', 'single', 'all_with_confirm'] },
    default: 'tick',
    owningCapability: 'manage_agent_dial',
    dialCapability: 'post',
    area: { id: 'G15', label: { en: 'Pendenzen', 'de-CH': 'Pendenzen' } },
    label: { en: 'Approving several bank proposals', 'de-CH': 'Mehrere Bank-Vorschläge genehmigen' },
    description: {
      en: 'tick (default): you tick the proposals and approve the selection. single: one by one. all_with_confirm: one button for all, after a confirmation with the count and the total.',
      'de-CH': 'tick (Standard): Du wählst Vorschläge aus und genehmigst die Auswahl. single: einzeln. all_with_confirm: ein Knopf für alle, nach einer Bestätigung mit Anzahl und Summe.',
    },
  },
  // --- N02, Belege aus dem Chat (D183) --------------------------------------------------------------
  // The folders an agent may hand TILL a file from by path (`sourcePath`). HUMAN-ONLY: an agent can never
  // widen its own read roots, not even by proposing it. Owned by `manage_settings` (the owner), because
  // the value decides what on this computer TILL may read. `;` separates folders; a leading `~/` is the
  // home folder. A folder that does not exist is skipped.
  {
    key: 'files.source_roots',
    schema: { type: 'string', maxLength: 2000 },
    default: '~/.claude/uploads;~/TILL/Belegeingang',
    owningCapability: 'manage_settings',
    dialCapability: 'customize',
    humanOnly: true,
    area: { id: 'N02', label: { en: 'Receipts', 'de-CH': 'Belege' } },
    label: { en: 'Folders an agent may attach files from', 'de-CH': 'Ordner, aus denen ein Agent Dateien anhängen darf' },
    description: {
      en: 'Folders, separated by ;, from which an agent may hand TILL a receipt by its path (PDF and images only). ~/ is your home folder. Only a person can change this.',
      'de-CH': 'Ordner, getrennt durch ;, aus denen ein Agent TILL einen Beleg über seinen Pfad übergeben darf (nur PDF und Bilder). ~/ ist dein Benutzerordner. Nur eine Person kann das ändern.',
    },
  },
  // D183 / R1 (receiptGuard.ts): one receipt evidences at most one live booking. `confirm` (default): a
  // person confirms a second booking with a reason, an agent's call becomes a Vorschlag; `allow` skips the
  // rule; `refuse` refuses every second booking, a confirmation included.
  {
    key: 'files.duplicate_beleg',
    schema: { type: 'enum', values: ['confirm', 'allow', 'refuse'] },
    default: 'confirm',
    owningCapability: 'manage_files',
    dialCapability: 'customize',
    // Critic: `allow` switches the receipt guard off, so only a person sets it (an agent at customize=auto
    // would otherwise lift the rule it runs under).
    humanOnly: true,
    area: { id: 'N02', label: { en: 'Receipts', 'de-CH': 'Belege' } },
    label: { en: 'A receipt that is already booked', 'de-CH': 'Ein Beleg, der schon gebucht ist' },
    description: {
      en: 'confirm (default): booking a receipt a second time needs a person to confirm it with a reason; an agent can only propose it. allow: a receipt may evidence several bookings. refuse: a second booking is always refused and names the record that holds the receipt. Only a person can change this.',
      'de-CH': 'confirm (Standard): Wer einen Beleg ein zweites Mal bucht, bestätigt das mit einer Begründung; ein Agent kann es nur vorschlagen. allow: Ein Beleg darf mehrere Buchungen belegen. refuse: Eine zweite Buchung wird immer abgelehnt und nennt den Eintrag, der den Beleg schon hat. Nur eine Person kann das ändern.',
    },
  },
  // Critic F1 (D183): a booking whose attach resolves to a receipt still waiting in Belege ohne Buchung
  // links its own filing row over the same bytes; `close` (default) then closes that capture as booked,
  // so it leaves the queue and can never be committed into a second booking; `keep` leaves it waiting.
  {
    key: 'files.capture_on_attach',
    schema: { type: 'enum', values: ['close', 'keep'] },
    default: 'close',
    owningCapability: 'manage_files',
    dialCapability: 'customize',
    area: { id: 'N02', label: { en: 'Receipts', 'de-CH': 'Belege' } },
    label: { en: 'A receipt waiting in Belege ohne Buchung is booked', 'de-CH': 'Ein Beleg aus Belege ohne Buchung wird gebucht' },
    description: {
      en: 'close (default): the waiting capture is closed as booked by that entry, so it cannot be booked a second time. keep: it stays in the queue.',
      'de-CH': 'close (Standard): Der wartende Beleg wird als gebucht abgeschlossen, damit er nicht ein zweites Mal gebucht wird. keep: Er bleibt in der Liste.',
    },
  },
  // How long a one-time drop link (`files_drop_link`) stays open.
  {
    key: 'files.drop_link_hours',
    schema: { type: 'integer', min: 1, max: 168 },
    default: 24,
    owningCapability: 'manage_files',
    dialCapability: 'customize',
    area: { id: 'N02', label: { en: 'Receipts', 'de-CH': 'Belege' } },
    label: { en: 'Drop link validity (hours)', 'de-CH': 'Gültigkeit eines Ablage-Links (Stunden)' },
    description: {
      en: 'How many hours a one-time link for dropping a receipt onto a booking stays valid. 24 by default.',
      'de-CH': 'Wie viele Stunden ein einmaliger Link zum Ablegen eines Belegs auf einer Buchung gültig bleibt. Standard 24.',
    },
  },
  // Critic F3/F7 (D183): how long a used or expired drop link row is kept before the scheduler prunes it.
  {
    key: 'files.drop_link_keep_days',
    schema: { type: 'integer', min: 1, max: 3650, unit: 'days' },
    default: 30,
    owningCapability: 'manage_files',
    dialCapability: 'customize',
    area: { id: 'N02', label: { en: 'Receipts', 'de-CH': 'Belege' } },
    label: { en: 'Keep old drop links (days)', 'de-CH': 'Alte Ablage-Links behalten (Tage)' },
    description: {
      en: 'How many days after it expired a drop link is still listed before it is removed. 30 by default. The receipt it brought stays.',
      'de-CH': 'Wie viele Tage nach dem Ablauf ein Ablage-Link noch aufgeführt bleibt, bevor er entfernt wird. Standard 30. Der damit abgelegte Beleg bleibt.',
    },
  },
  // The watched folder. HUMAN-ONLY for the same reason as the roots: it decides which folder the tick
  // reads and empties into `Erledigt/`.
  {
    key: 'files.belegeingang_folder',
    schema: { type: 'string', maxLength: 500 },
    default: '~/TILL/Belegeingang',
    owningCapability: 'manage_settings',
    dialCapability: 'customize',
    humanOnly: true,
    area: { id: 'N02', label: { en: 'Receipts', 'de-CH': 'Belege' } },
    label: { en: 'Belegeingang folder', 'de-CH': 'Ordner Belegeingang' },
    description: {
      en: 'Receipts you save into this folder are captured into Belege ohne Buchung on the next scheduler tick while TILL runs. TILL never creates the folder. Only a person can change this.',
      'de-CH': 'Belege, die du in diesem Ordner speicherst, landen beim nächsten Durchlauf in Belege ohne Buchung, solange TILL läuft. TILL legt den Ordner nie selbst an. Nur eine Person kann das ändern.',
    },
  },
  {
    key: 'files.belegeingang_scan',
    schema: { type: 'enum', values: ['on', 'off'] },
    default: 'on',
    owningCapability: 'manage_files',
    dialCapability: 'customize',
    area: { id: 'N02', label: { en: 'Receipts', 'de-CH': 'Belege' } },
    label: { en: 'Watch the Belegeingang folder', 'de-CH': 'Ordner Belegeingang beobachten' },
    description: {
      en: 'on (default): the folder is scanned on every scheduler tick, when it exists. off: it is never read.',
      'de-CH': 'on (Standard): Der Ordner wird bei jedem Durchlauf gelesen, wenn es ihn gibt. off: Er wird nie gelesen.',
    },
  },
  {
    key: 'files.belegeingang_after',
    schema: { type: 'enum', values: ['move', 'keep'] },
    default: 'move',
    owningCapability: 'manage_files',
    dialCapability: 'customize',
    area: { id: 'N02', label: { en: 'Receipts', 'de-CH': 'Belege' } },
    label: { en: 'After a receipt is captured', 'de-CH': 'Nachdem ein Beleg erfasst ist' },
    description: {
      en: 'move (default): the file moves into the Erledigt folder beside it once the capture is saved. keep: it stays where it is and is not captured again.',
      'de-CH': 'move (Standard): Die Datei wandert in den Ordner Erledigt daneben, sobald die Erfassung gespeichert ist. keep: Sie bleibt, wo sie ist, und wird nicht nochmals erfasst.',
    },
  },
  // --- N00, the workspace brief and the Hausbuch ---------------------------------------------------
  // D183 (N00 §6b): which sections `workspace_brief` carries when the caller names none. A comma-separated
  // list because the registry has no list schema; the closed names and the parser live in
  // `core/hausbuch/sections.ts`, and `settings.ts` refuses an unknown or repeated name before anything is
  // written. Every section is the default. It decides only what an agent reads first, never what any verb
  // does, so `manage_settings` owns it and a governed seat drafts under `customize`.
  {
    key: 'hausbuch.brief_sections',
    schema: { type: 'string', maxLength: BRIEF_SECTIONS_MAX_LENGTH },
    default: BRIEF_SECTIONS_DEFAULT,
    owningCapability: 'manage_settings',
    dialCapability: 'customize',
    area: { id: 'N00', label: { en: 'House book', 'de-CH': 'Hausbuch' } },
    label: { en: 'What the workspace brief carries', 'de-CH': 'Was das Arbeitsbereich-Briefing enthält' },
    description: {
      en: 'The sections an agent reads first, comma-separated: accounts, vatCodes, bankAccounts, rules, notes, counts. All by default; an agent can still ask for one section by name.',
      'de-CH': 'Die Abschnitte, die ein Agent zuerst liest, durch Komma getrennt: accounts, vatCodes, bankAccounts, rules, notes, counts. Standardmässig alle; ein Agent kann einzelne Abschnitte trotzdem gezielt anfragen.',
    },
  },
  // --- N01, agent ergonomics: one key, one meaning ------------------------------------------------------
  // N01 US-N01.5 (orchestrator, conservative default, 02.11.2026): whether a free-text `reason` is part of
  // what an idempotency key means. `exclude` (the default): a retry that rewords its reason replays the one
  // act instead of tempting the caller to mint a second key; `include`: a reworded reason is another call
  // and refuses `idempotency_key_conflict`. Every other argument is compared either way (the invariant
  // itself is fixed). It decides whether a second act can happen under a key, so it is owned by
  // `manage_settings` and drafted under `post`, never cheaper.
  {
    key: 'idempotency.hash_free_text',
    schema: { type: 'enum', values: ['exclude', 'include'] },
    default: 'exclude',
    owningCapability: 'manage_settings',
    dialCapability: 'post',
    area: { id: 'N01', label: { en: 'Agents', 'de-CH': 'Agenten' } },
    label: { en: 'Free-text reason in a repeated request', 'de-CH': 'Freitext-Begründung bei einer wiederholten Anfrage' },
    description: {
      en: 'exclude (default): a repeated request whose only change is the wording of its reason counts as the same request. include: a changed reason counts as a different request and is refused under the same key.',
      'de-CH': 'exclude (Standard): Eine wiederholte Anfrage, bei der sich nur der Wortlaut der Begründung ändert, gilt als dieselbe Anfrage. include: Eine geänderte Begründung gilt als andere Anfrage und wird unter demselben Schlüssel abgelehnt.',
    },
  },
  // N01 US-N01.1 (§6b): whether a field that takes an account also takes its NUMBER ("6500"), resolved to
  // the id at the registry boundary (`src/api/input-boundary.ts`). `accept` is the default; `ids_only`
  // passes a number through untouched, so the verb answers it as before. It decides only which spelling
  // of an account a call may use, never which account a valid id names, so `customize` drafts it.
  {
    key: 'ledger.account_numbers',
    schema: { type: 'enum', values: ['accept', 'ids_only'] },
    default: 'accept',
    owningCapability: 'manage_settings',
    dialCapability: 'customize',
    area: { id: 'N01', label: { en: 'Agents', 'de-CH': 'Agenten' } },
    label: { en: 'Accounts by number', 'de-CH': 'Konten über die Kontonummer' },
    description: {
      en: 'accept (default): a call may name an account by its number (6500) instead of its id. ids_only: only ids are accepted.',
      'de-CH': 'accept (Standard): Ein Aufruf darf ein Konto über seine Nummer (6500) statt über seine ID nennen. ids_only: Nur IDs werden angenommen.',
    },
  },
  // N01 US-N01.4 (§6b, D183 amendment): what a field an agent sends that the verb does not know does.
  // `warn` (the conservative default, D183 rule 3 amending rule 6): the call runs and its answer carries
  // `warnings` with the closest field name; `refuse` refuses `unknown_field` and nothing runs; `ignore`
  // says nothing. The Studio's own calls have their own setting below.
  {
    key: 'mcp.unknown_fields_agent',
    schema: { type: 'enum', values: ['warn', 'refuse', 'ignore'] },
    default: 'warn',
    owningCapability: 'manage_settings',
    dialCapability: 'customize',
    area: { id: 'N01', label: { en: 'Agents', 'de-CH': 'Agenten' } },
    label: { en: 'Unknown fields in an agent call', 'de-CH': 'Unbekannte Felder in einem Agenten-Aufruf' },
    description: {
      en: 'warn (default): the call runs and the agent is told which field is unknown and what it probably meant. refuse: the call is refused and nothing is done. ignore: the field is dropped silently.',
      'de-CH': 'warn (Standard): Der Aufruf läuft, und der Agent erfährt, welches Feld unbekannt ist und welches wohl gemeint war. refuse: Der Aufruf wird abgelehnt, nichts passiert. ignore: Das Feld wird stillschweigend übergangen.',
    },
  },
  {
    key: 'mcp.unknown_fields_studio',
    schema: { type: 'enum', values: ['warn', 'refuse', 'ignore'] },
    default: 'warn',
    owningCapability: 'manage_settings',
    dialCapability: 'customize',
    area: { id: 'N01', label: { en: 'Agents', 'de-CH': 'Agenten' } },
    label: { en: 'Unknown fields in a Studio or member call', 'de-CH': 'Unbekannte Felder in einem Studio- oder Mitglieder-Aufruf' },
    description: {
      en: 'The same choice for calls that do not come from an agent seat (the Studio, people with their own login): warn (default), refuse or ignore.',
      'de-CH': 'Dieselbe Wahl für Aufrufe, die nicht von einem Agenten kommen (das Studio, Personen mit eigenem Login): warn (Standard), refuse oder ignore.',
    },
  },
  // N01 US-N01.6 (§6b): the most items one batch call (`book_bank_lines`, `post_entries`) may carry. More
  // refuses `batch_too_large` before any item runs. Every item is still its own act, so the bound is about
  // the size of one answer, never about what an item may do.
  {
    key: 'agent.batch_max_items',
    schema: { type: 'integer', min: 1, max: 1000, unit: 'items' },
    default: 200,
    owningCapability: 'manage_settings',
    dialCapability: 'customize',
    area: { id: 'N01', label: { en: 'Agents', 'de-CH': 'Agenten' } },
    label: { en: 'Most items in one batch call', 'de-CH': 'Höchstzahl Positionen in einem Sammelaufruf' },
    description: {
      en: 'How many bank lines or entries one batch call may carry. Each item is still booked as its own act.',
      'de-CH': 'Wie viele Bankzeilen oder Buchungen ein Sammelaufruf enthalten darf. Jede Position wird weiterhin einzeln gebucht.',
    },
  },
  // N01 US-N01.8 (§6b): whether a write's answer names the verb that undoes it (`undo { tool, args }`),
  // only where the inverse and its arguments are unambiguous. `on` is the default; `off` drops the hint.
  {
    key: 'agent.undo_hints',
    schema: { type: 'enum', values: ['on', 'off'] },
    default: 'on',
    owningCapability: 'manage_settings',
    dialCapability: 'customize',
    area: { id: 'N01', label: { en: 'Agents', 'de-CH': 'Agenten' } },
    label: { en: 'Undo hint in a write answer', 'de-CH': 'Rückgängig-Hinweis in der Antwort' },
    description: {
      en: 'on (default): a booking or a bank-line booking answers with the call that undoes it (reverse_entry, reopen_bank_line). off: no hint.',
      'de-CH': 'on (Standard): Eine Buchung oder eine gebuchte Bankzeile antwortet mit dem Aufruf, der sie rückgängig macht (reverse_entry, reopen_bank_line). off: kein Hinweis.',
    },
  },
];

const KEY_SHAPE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

/** Whether `value` satisfies `schema` exactly (no coercion: `'14'` is not the integer 14). */
export function valueFitsSchema(schema: SettingSchema, value: unknown): value is SettingValue {
  switch (schema.type) {
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value) && value >= schema.min && value <= schema.max;
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) && value >= schema.min && value <= schema.max;
    case 'boolean':
      return typeof value === 'boolean';
    case 'string':
      return typeof value === 'string' && value.length <= schema.maxLength;
    case 'enum':
      return typeof value === 'string' && schema.values.includes(value);
  }
}

/** Throws on a malformed registry; runs at module load and is exported for the guard suite. */
export function assertSettingsRegistry(rows: readonly SettingDef[]): void {
  const seen = new Set<string>();
  for (const s of rows) {
    if (!KEY_SHAPE.test(s.key)) throw new Error(`settings registry: key '${s.key}' is not <area>.<name> in lower case`);
    if (seen.has(s.key)) throw new Error(`settings registry: key '${s.key}' is registered twice`);
    seen.add(s.key);
    if (!valueFitsSchema(s.schema, s.default)) {
      throw new Error(`settings registry: the default of '${s.key}' (${JSON.stringify(s.default)}) does not fit its schema`);
    }
    if (!isCapability(s.owningCapability)) throw new Error(`settings registry: '${s.key}' names the unknown capability '${String(s.owningCapability)}'`);
    if (!(SETTING_DIAL_CAPABILITIES as readonly string[]).includes(s.dialCapability)) {
      throw new Error(`settings registry: '${s.key}' names the unknown dial family '${String(s.dialCapability)}'`);
    }
    if (s.schema.type === 'enum' && s.schema.values.length < 2) {
      throw new Error(`settings registry: the enum '${s.key}' needs at least two values (one value is not a choice)`);
    }
    for (const text of [s.label, s.description, s.area.label]) {
      if (text.en.trim() === '' || text['de-CH'].trim() === '') throw new Error(`settings registry: '${s.key}' lacks an en or de-CH text`);
    }
  }
}

assertSettingsRegistry(SETTINGS);

const BY_KEY: ReadonlyMap<string, SettingDef> = new Map(SETTINGS.map((s) => [s.key, s]));

/** The registry row for `key`, or undefined for a key this build does not know. */
export function settingDef(key: unknown): SettingDef | undefined {
  return typeof key === 'string' ? BY_KEY.get(key) : undefined;
}

/** The A24 capability a CHANGE to `key` requires; an unknown key falls back to `manage_settings`. */
export function owningCapabilityFor(key: unknown): Capability {
  return settingDef(key)?.owningCapability ?? 'manage_settings';
}

/** The dial family a governed change to `key` drafts under; an unknown key falls back to `customize`. */
export function dialCapabilityForSetting(key: unknown): SettingDialCapability {
  return settingDef(key)?.dialCapability ?? 'customize';
}
