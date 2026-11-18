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
// D188: the default fee phrases, from a leaf module for the same reason.
import { BANK_FEE_TEXTS_DEFAULT } from '../banking/feeTexts.js';
// D202: the closed area names, from a leaf module for the same reason.
import { SETTINGS_SECTIONS_MAX_LENGTH } from './areas.js';
import { OWNER_WORD_EXCLUDED_DEFAULT, OWNER_WORD_EXCLUDED_MAX_LENGTH } from '../agent/ownerWordExcluded.js';

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
  /**
   * A41 (D184 point 6): ASK FIRST. Until a person in the workspace has set this value, the behaviour that
   * reads it stays in its conservative state (`answeredSetting` answers null) and the setting reads
   * `answered: false`; `default` is only the suggestion a question pre-selects. Always `humanOnly` too (an
   * agent reads the open question, never answers it). A reset makes it unanswered again. Absent means false.
   */
  readonly askFirst?: boolean;
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
  // --- A03, the audit trail (D204) ---------------------------------------------------------------
  // D204 point 4 (owner, 15.11.2026): no typed reason is ever mandatory. This decides only whether the
  // Studio OFFERS a reason field: `never` (default) shows none, `optional` offers an optional note that
  // never disables a button. No value makes the engine refuse; a given reason is recorded (A03 §11).
  {
    key: 'audit.ask_reason',
    schema: { type: 'enum', values: ['never', 'optional'] },
    default: 'never',
    owningCapability: 'manage_settings',
    dialCapability: 'customize',
    area: { id: 'A03', label: { en: 'Audit trail', 'de-CH': 'Protokoll' } },
    label: { en: 'Offer a reason field', 'de-CH': 'Feld für einen Grund anbieten' },
    description: {
      en: 'never (default): no reason field; every change keeps who, what, when and with which permission. optional: an optional note you may leave empty.',
      'de-CH': 'never (Standard): kein Feld für einen Grund; jede Änderung hält fest, wer was wann mit welcher Berechtigung getan hat. optional: eine freiwillige Notiz, die du leer lassen kannst.',
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
  // D204 (16.11.2026): `payroll.nonregular_reason` (D173 Q14) is retired. No run is refused for a missing
  // reason (A03 §11), so the key gated nothing; a stored row of it is ignored (no reader, no listing).
  // --- H06, the asset disposal ---------------------------------------------------------------------
  // D191 (owner Q4, 15.10.2026): what `asset_transaction_reverse` does with a disposal whose linked
  // proceeds document (an invoice or an incoming payment) still stands. `refuse` is the decided rule
  // (`proceeds_settled`, undo the money act first; one case may differ by the audited
  // `overrideProceedsCheck`); `warn` reverses and names the standing document in `warnings`; `off` does
  // not check. It changes what money does, so it is owned by `post` and drafts under the `post` family,
  // the capability and family `asset_transaction_reverse` itself uses (never cheaper).
  {
    key: 'assets.proceeds_check',
    schema: { type: 'enum', values: ['refuse', 'warn', 'off'] },
    default: 'refuse',
    owningCapability: 'post',
    dialCapability: 'post',
    area: { id: 'H06', label: { en: 'Fixed assets', 'de-CH': 'Anlagen' } },
    label: { en: 'Reversing a disposal whose proceeds document stands', 'de-CH': 'Abgang stornieren, solange sein Erlösbeleg gilt' },
    description: {
      en: 'When a disposal names its proceeds invoice or payment and that document still stands: refuse the reversal (default), reverse with a warning, or do not check.',
      'de-CH': 'Wenn ein Abgang seine Erlösrechnung oder Zahlung nennt und dieser Beleg noch gilt: das Stornieren ablehnen (Standard), mit Warnung stornieren oder nicht prüfen.',
    },
  },
  // D192 (owner 09.11.2026, D191 point 8): how a disposal linked to an invoice books its proceeds.
  // `clear_via_document` (default) derives the proceeds from the invoice's one sale line and debits that
  // line's account, so the sale and its VAT count once, on the invoice; `book_proceeds` is D191's
  // behaviour (the caller's account and amount, warned when that double counts). It changes what money
  // does, so it is owned by `post` and drafts under the `post` family, as `asset_dispose` does.
  {
    key: 'assets.proceeds_booking',
    schema: { type: 'enum', values: ['clear_via_document', 'book_proceeds'] },
    default: 'clear_via_document',
    owningCapability: 'post',
    dialCapability: 'post',
    area: { id: 'H06', label: { en: 'Fixed assets', 'de-CH': 'Anlagen' } },
    label: { en: 'Proceeds of a disposal linked to an invoice', 'de-CH': 'Erlös eines Abgangs mit Rechnung' },
    description: {
      en: 'Clear via the invoice: the disposal takes its proceeds from the invoice and counts the sale once (default). Book proceeds: the disposal books the proceeds you enter.',
      'de-CH': 'Über die Rechnung ausgleichen: Der Abgang übernimmt den Erlös aus der Rechnung und zählt den Verkauf einmal (Standard). Erlös buchen: Der Abgang bucht den Erlös, den du eingibst.',
    },
  },
  // D192 point 11 (owner option b, 10.11.2026): a disposal whose invoice falls in the other financial
  // year. `post_abgrenzung` (default) posts the A38 Abgrenzung in the same transaction, so both years are
  // right; `refuse` asks the person to date the disposal in the invoice's year. Both give correct books.
  {
    key: 'assets.cross_year_sale',
    schema: { type: 'enum', values: ['post_abgrenzung', 'refuse'] },
    default: 'post_abgrenzung',
    owningCapability: 'post',
    dialCapability: 'post',
    area: { id: 'H06', label: { en: 'Fixed assets', 'de-CH': 'Anlagen' } },
    label: { en: 'Disposal and invoice in different financial years', 'de-CH': 'Abgang und Rechnung in verschiedenen Geschäftsjahren' },
    description: {
      en: 'Post the Abgrenzung with the disposal, so both years are right (default), or refuse and ask for a date in the invoice\'s year.',
      'de-CH': 'Die Abgrenzung mit dem Abgang buchen, damit beide Jahre stimmen (Standard), oder ablehnen und ein Datum im Jahr der Rechnung verlangen.',
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
  // A41.6 (D184 point 5): a "Gelernt" line (the history rung) whose count of equal earlier bookings reaches
  // this number is booked by the pick bar's bulk Buchen beside the sure lines. ASK FIRST (point 6): until a
  // person answered, learned lines never bulk; the pick bar asks the moment one is ticked. 0 = only sure lines.
  {
    key: 'bank.bulk_learned_min',
    schema: { type: 'integer', min: 0, max: 50, unit: 'items' },
    default: 5,
    owningCapability: 'post',
    dialCapability: 'post',
    humanOnly: true,
    askFirst: true,
    area: { id: 'A39', label: { en: 'Bank', 'de-CH': 'Bank' } },
    label: { en: 'Learned lines in the bulk booking', 'de-CH': 'Gelernte Zeilen im Sammelbuchen' },
    description: {
      en: 'From how many equal earlier bookings a learned line is booked together with the sure lines. 0: only sure lines. Until you answer, learned lines are never booked in bulk.',
      'de-CH': 'Ab wie vielen gleichen früheren Buchungen eine gelernte Zeile mit den sicheren Zeilen gebucht wird. 0: Nur sichere Zeilen. Bis du antwortest, werden gelernte Zeilen nie gesammelt gebucht.',
    },
  },
  // D198 point 5: how a saved settlement source is pulled. `manual` (the default): a person (or an agent under
  // the `post` dial) runs pull_settlement. `daily`: the scheduler pulls each source once per Swiss day as the
  // person who saved it, and books through the saved template. Human-only: it decides that books are posted
  // with nobody at the keyboard, which an agent may not switch on.
  {
    key: 'settlement.pull_mode',
    schema: { type: 'enum', values: ['manual', 'daily'] },
    default: 'manual',
    owningCapability: 'post',
    dialCapability: 'post',
    humanOnly: true,
    area: { id: 'A39', label: { en: 'Bank', 'de-CH': 'Bank' } },
    label: { en: 'Pull the settlement feed', 'de-CH': 'Abrechnungs-Feed abholen' },
    description: {
      en: 'manual: a settlement feed is pulled when someone asks. daily: TILL pulls every saved source once a day and books it through its template.',
      'de-CH': 'manual: Der Abrechnungs-Feed wird abgeholt, wenn jemand es auslöst. daily: TILL holt jede gespeicherte Quelle einmal am Tag ab und bucht sie nach ihrer Vorlage.',
    },
  },
  // D198 re-cut R1 (owner, 12.11.2026: "be sure we don't record or book test transactions as actual
  // transactions"): what `import_settlement` (both doors, the pull and a file) does with an event of a TEST
  // transaction (`refs.test`, sticky per transaction key, `settlement_feed_flag`). `skip` (the default, and
  // the fallback when unreadable): never booked, kept as seen, listed by the pre-filing check. `book`: booked
  // like any event. Human-only: it decides what reaches the books.
  {
    key: 'settlement.test_events',
    schema: { type: 'enum', values: ['skip', 'book'] },
    default: 'skip',
    owningCapability: 'post',
    dialCapability: 'post',
    humanOnly: true,
    area: { id: 'A39', label: { en: 'Bank', 'de-CH': 'Bank' } },
    label: { en: 'Test payments in the settlement feed', 'de-CH': 'Testzahlungen im Abrechnungs-Feed' },
    description: {
      en: 'skip: events of a test payment are kept but never booked (a test sale, its refund, a test transfer and its reversal). book: they are booked like every other event. Switching to book books a skipped event the next time a feed or file carries it.',
      'de-CH': 'skip: Ereignisse einer Testzahlung werden festgehalten, aber nie gebucht (Testverkauf, Rückerstattung, Testüberweisung und ihre Rückbuchung). book: Sie werden wie jedes andere Ereignis gebucht. Stellst du auf book um, wird ein übersprungenes Ereignis gebucht, sobald ein Feed oder eine Datei es wieder bringt.',
    },
  },
  // D198 re-cut, the test fee residue (owner, 12.11.2026: "Book as real fees"). Under `settlement.test_events`
  // skip, the processor fee charged on a TEST payment (`processing_fee`, `service_fee`) is real money the
  // processor kept. `book` (the default, and the fallback when unreadable): booked like a non-test fee,
  // through the template's account and tax code, so the clearing account follows the processor balance.
  // `skip`: left off the books with the rest of the test payment (the residue stays on the clearing account).
  // Human-only: it decides what reaches the books.
  {
    key: 'settlement.test_fees',
    schema: { type: 'enum', values: ['book', 'skip'] },
    default: 'book',
    owningCapability: 'post',
    dialCapability: 'post',
    humanOnly: true,
    area: { id: 'A39', label: { en: 'Bank', 'de-CH': 'Bank' } },
    label: { en: 'Processor fees on test payments', 'de-CH': 'Gebühren auf Testzahlungen' },
    description: {
      en: 'book: the fee a processor charged on a test payment is booked like any fee (its template account and tax code), so the clearing account matches the processor balance. skip: it stays off the books with the test payment, and the clearing account keeps the difference.',
      'de-CH': 'book: Die Gebühr, die der Zahlungsanbieter auf einer Testzahlung belastet hat, wird wie jede Gebühr gebucht (Konto und Steuercode der Vorlage), so stimmt das Durchlaufkonto mit dem Saldo beim Anbieter überein. skip: Sie bleibt mit der Testzahlung ungebucht, und das Durchlaufkonto behält die Differenz.',
    },
  },
  // A42, the Umsatz review (owner, 13.11.2026): the period the review opens on. `quarter` (the default: the
  // MWST period of the owner's effective method) | `month` | `year`. A view choice, so not human-only; it books
  // nothing.
  {
    key: 'settlement.review_period',
    schema: { type: 'enum', values: ['quarter', 'month', 'year'] },
    default: 'quarter',
    owningCapability: 'post',
    dialCapability: 'post',
    area: { id: 'A39', label: { en: 'Bank', 'de-CH': 'Bank' } },
    label: { en: 'Umsatz review period', 'de-CH': 'Zeitraum der Umsatz-Prüfung' },
    description: {
      en: 'quarter: the Umsatz review opens on the current quarter. month: on the current month. year: on the current year.',
      'de-CH': 'quarter: Die Umsatz-Prüfung öffnet das laufende Quartal. month: den laufenden Monat. year: das laufende Jahr.',
    },
  },
  // A42 (paper critic r1 M8): whether an agent seat sees a payer's email in the Umsatz review. `masked` (the
  // default: an agent's context reaches its model provider) | `shown`. Human-only: it decides what personal
  // data an agent reads.
  {
    key: 'settlement.agent_sees_email',
    schema: { type: 'enum', values: ['masked', 'shown'] },
    default: 'masked',
    owningCapability: 'post',
    dialCapability: 'post',
    humanOnly: true,
    area: { id: 'A39', label: { en: 'Bank', 'de-CH': 'Bank' } },
    label: { en: 'Payer email for the agent', 'de-CH': 'E-Mail der Zahlenden für den Agenten' },
    description: {
      en: 'masked: the agent sees that a settlement event has a payer email, never the address. shown: the agent sees the address like a person does.',
      'de-CH': 'masked: Der Agent sieht, dass ein Abrechnungsereignis eine E-Mail der zahlenden Person trägt, nie die Adresse. shown: Der Agent sieht die Adresse wie eine Person.',
    },
  },
  // D198 re-cut R2: how far a default pull reaches back before the watermark (late events, payouts whose
  // arrival day lay ahead). The import's idempotency makes the overlap free. Human-only like the pull mode.
  {
    key: 'settlement.pull_overlap_days',
    schema: { type: 'integer', min: 1, max: 60, unit: 'days' },
    default: 7,
    owningCapability: 'post',
    dialCapability: 'post',
    humanOnly: true,
    area: { id: 'A39', label: { en: 'Bank', 'de-CH': 'Bank' } },
    label: { en: 'Settlement pull overlap', 'de-CH': 'Überlappung beim Abholen' },
    description: {
      en: "How many days before the last pulled day a pull starts again. Events before a source's from-date are never booked, from a pull or a file: save another from-date to book them.",
      'de-CH': 'Wie viele Tage vor dem zuletzt abgeholten Tag ein Abholen wieder beginnt. Ereignisse vor dem Startdatum einer Quelle werden nie gebucht, weder aus dem Feed noch aus einer Datei: Speichere ein anderes Startdatum, um sie zu buchen.',
    },
  },
  // D198 re-cut R4: which CANCELLING GROUPS the pre-filing check hides (the unbooked sale and refund events of
  // one transaction, all in the period, whose amounts, nets and VAT each sum to zero; recomputed on every
  // read, never a booking). `hide_test` (the default): groups of test events. `hide_all`: real groups too.
  // `show`: none. Human-only: it decides what a person is warned about before filing.
  {
    key: 'settlement.check_cancelling_groups',
    schema: { type: 'enum', values: ['hide_test', 'hide_all', 'show'] },
    default: 'hide_test',
    owningCapability: 'post',
    dialCapability: 'post',
    humanOnly: true,
    area: { id: 'A39', label: { en: 'Bank', 'de-CH': 'Bank' } },
    label: { en: 'Sales cancelled by a refund, before filing', 'de-CH': 'Durch Rückerstattung aufgehobene Verkäufe vor dem Einreichen' },
    description: {
      en: 'hide_test: an unbooked test sale and its full refund are not listed. hide_all: real ones are hidden too; their VAT nets to zero, but Ziffer 200 and 235 stay short by the amount. show: every one is listed.',
      'de-CH': 'hide_test: Ein ungebuchter Testverkauf und seine volle Rückerstattung werden nicht aufgeführt. hide_all: Auch echte werden ausgeblendet; ihre MWST hebt sich auf, aber Ziffer 200 und 235 fehlen um den Betrag. show: Jeder wird aufgeführt.',
    },
  },
  // D206 (A43 §2, the whole-day mode): how a settlement event read from a turnover TABLE gets its external id, the
  // key the import's idempotency rests on. `column` (the default): only an id the export carries (one column or
  // composed), so an id-less table refuses id_column_missing. `column_else_day`: an id-less table whose mapping a
  // person confirmed lists WHOLE DAYS is read day by day, each row `day:<day>#<n>`, and a day already in the books
  // is never booked again. Re-added (it was removed while it had one value). Human-only: it decides what counts as
  // the same event, so what is booked once.
  {
    key: 'settlement.table_event_id',
    schema: { type: 'enum', values: ['column', 'column_else_day'] },
    default: 'column',
    owningCapability: 'post',
    dialCapability: 'post',
    humanOnly: true,
    area: { id: 'A39', label: { en: 'Bank', 'de-CH': 'Bank' } },
    label: { en: 'Event id from a turnover table', 'de-CH': 'Ereignis-ID aus einer Umsatztabelle' },
    description: {
      en: 'column: a turnover table is booked only by an id it carries (one column, or several composed); a table without one is refused. column_else_day: a table without an id whose mapping you confirmed lists whole days is booked day by day, and a day already in the books is never booked again; a day that differs from the books is shown and booked by hand.',
      'de-CH': 'column: Eine Umsatztabelle wird nur über eine ID gebucht, die sie trägt (eine Spalte oder mehrere zusammengesetzt); eine Tabelle ohne ID wird abgelehnt. column_else_day: Eine Tabelle ohne ID, deren Zuordnung du als ganze Tage bestätigt hast, wird Tag für Tag gebucht, und ein Tag, der schon im Buch ist, wird nie ein zweites Mal gebucht; ein Tag, der vom Buch abweicht, wird gezeigt und von Hand gebucht.',
    },
  },
  // D206: in the whole-day mode, what happens to the FIRST and the LAST day of a turnover table, which an export cut
  // at a time of day lists only in part. `ask` (the default): the Studio asks per file whether they are complete and
  // passes the answer to the import, which records it. `include`: they are booked like every other day. `exclude`:
  // they are left out (a later file that covers them whole books them). A day of today or later is never booked.
  // Human-only: it decides what reaches the books.
  {
    key: 'settlement.table_edge_days',
    schema: { type: 'enum', values: ['ask', 'include', 'exclude'] },
    default: 'ask',
    owningCapability: 'post',
    dialCapability: 'post',
    humanOnly: true,
    area: { id: 'A39', label: { en: 'Bank', 'de-CH': 'Bank' } },
    label: { en: 'First and last day of a turnover table', 'de-CH': 'Erster und letzter Tag einer Umsatztabelle' },
    description: {
      en: 'Only for tables read by whole days. ask: you are asked per file whether its first and last day are complete. include: they are booked like every other day. exclude: they are left out until a later file covers them whole. A day of today or later is never booked. Whatever you pick, a new day that shares an amount with a booked day beside it is always asked about (a re-export may have moved that row across midnight).',
      'de-CH': 'Nur für Tabellen, die nach ganzen Tagen gelesen werden. ask: Du wirst pro Datei gefragt, ob ihr erster und ihr letzter Tag vollständig sind. include: Sie werden wie jeder andere Tag gebucht. exclude: Sie bleiben weg, bis eine spätere Datei sie ganz enthält. Ein Tag von heute oder später wird nie gebucht. Unabhängig davon wirst du immer gefragt, wenn ein neuer Tag einen Betrag mit einem gebuchten Nachbartag teilt (ein neuer Export kann diese Zeile über Mitternacht verschoben haben).',
    },
  },
  // D195: what the pick bar's bulk Buchen books of the lines a person ticked. `bookable` (the default, the
  // owner's ask of 12.11.2026): every ticked line whose booking is complete as its row shows it, and it says
  // which it skipped and why. `sure`: the D184 rule, only sure lines and the learned lines the engine backs
  // under `bank.bulk_learned_min`. A pending agent Vorschlag is never booked over either way. Read by the
  // Studio only (the engine books one line per call). Human-only: an agent may not widen a person's bulk act.
  {
    key: 'bank.bulk_book_scope',
    schema: { type: 'enum', values: ['bookable', 'sure'] },
    default: 'bookable',
    owningCapability: 'post',
    dialCapability: 'post',
    humanOnly: true,
    area: { id: 'A39', label: { en: 'Bank', 'de-CH': 'Bank' } },
    label: { en: 'What the bulk booking books', 'de-CH': 'Was das Sammelbuchen bucht' },
    description: {
      en: 'bookable: every ticked line that is complete as its row shows it; the rest is skipped with its reason. sure: only sure lines and the learned lines allowed by the threshold.',
      'de-CH': 'bookable: Jede angehakte Zeile, die so, wie sie steht, vollständig ist; die übrigen bleiben mit ihrem Grund stehen. sure: Nur sichere Zeilen und die gelernten Zeilen, die die Schwelle erlaubt.',
    },
  },
  // A41.5 (D184 point 7): the ✓ on a bank inbox row. `direct` (the default, the owner's ruling of 07.11.2026):
  // the ✓ books the line as the row shows it (or approves the agent's pending Vorschlag), a "Bitte prüfen" line
  // included. `review`: the ✓ opens the line's review view (the Beleg beside the booking) and the booking is
  // made there. Either way a person's click books; no line books unattended. Human-only: it sets how much
  // review a person's own click gets, which an agent may not loosen.
  {
    key: 'bank.row_approve',
    schema: { type: 'enum', values: ['direct', 'review'] },
    default: 'direct',
    owningCapability: 'post',
    dialCapability: 'post',
    humanOnly: true,
    area: { id: 'A39', label: { en: 'Bank', 'de-CH': 'Bank' } },
    label: { en: 'The check mark on a bank line', 'de-CH': 'Das Häkchen auf einer Bankzeile' },
    description: {
      en: 'direct: the check mark books the line as shown (or approves the agent proposal). review: it opens the review view with the receipt first.',
      'de-CH': 'direct: Das Häkchen bucht die Zeile so, wie sie steht (oder gibt den Vorschlag des Agenten frei). review: Es öffnet zuerst die Prüfansicht mit dem Beleg.',
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
  // D196 point 2 (founder, 12.11.2026): ONE-CLICK IGNORE. `ignore_bank_line` no longer requires a reason: a
  // call without one records this default, so "Ignorieren" is one click with an optional note. The closed
  // reasons stay available per call (a caller that sends one keeps it) and as this default.
  {
    key: 'bank.ignore_default_reason',
    schema: { type: 'enum', values: ['other', 'booked_elsewhere', 'clearing_account', 'before_start', 'duplicate'] },
    default: 'other',
    owningCapability: 'post',
    dialCapability: 'post',
    area: { id: 'A39', label: { en: 'Bank', 'de-CH': 'Bank' } },
    label: { en: 'Reason of a one-click ignore', 'de-CH': 'Grund beim Ignorieren mit einem Klick' },
    description: {
      en: 'The reason recorded when a bank line is ignored without one: other (default), booked_elsewhere, clearing_account, before_start or duplicate. A note is always optional.',
      'de-CH': 'Der Grund, der gespeichert wird, wenn eine Bankzeile ohne Grund ignoriert wird: other (Standard), booked_elsewhere, clearing_account, before_start oder duplicate. Eine Notiz ist immer freiwillig.',
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
  // A20 §12 (09.11.2026): filling a statement gap from the bank's CSV export. Each stretch is proven by the
  // CSV's running balance and tied to the statements on both sides; these three settings carry the choices.
  {
    key: 'bank.csv_fill_balance_tie',
    schema: { type: 'enum', values: ['required', 'warn'] },
    default: 'required',
    owningCapability: 'pay',
    dialCapability: 'pay',
    area: { id: 'A39', label: { en: 'Bank', 'de-CH': 'Bank' } },
    label: {
      en: 'Gap fill from a CSV: balances must tie',
      'de-CH': 'Lücke aus CSV füllen: Salden müssen anschliessen',
    },
    description: {
      en: 'required: days from a CSV export are imported only when its running balance adds up and meets the statements before and after; otherwise nothing of those days is imported. warn: they are imported anyway, with a warning, and the gap stays open.',
      'de-CH': 'required: Tage aus einem CSV-Export kommen nur ins Buch, wenn der laufende Saldo aufgeht und an die Auszüge davor und danach anschliesst; sonst kommt von diesen Tagen nichts ins Buch. warn: Sie kommen trotzdem ins Buch, mit einer Warnung, und die Lücke bleibt offen.',
    },
  },
  {
    key: 'bank.csv_fill_duplicates',
    schema: { type: 'enum', values: ['skip_proven', 'ask'] },
    default: 'skip_proven',
    owningCapability: 'pay',
    dialCapability: 'pay',
    area: { id: 'A39', label: { en: 'Bank', 'de-CH': 'Bank' } },
    label: {
      en: 'Gap fill from a CSV: rows already in the books',
      'de-CH': 'Lücke aus CSV füllen: Zeilen, die schon im Buch sind',
    },
    description: {
      en: 'skip_proven: a CSV row the books already hold is left out (the bank reference with the same amount, or the same date, amount and text). ask: every row is imported, and possible duplicates wait for your decision.',
      'de-CH': 'skip_proven: Eine CSV-Zeile, die schon im Buch ist, bleibt weg (gleiche Bankreferenz und gleicher Betrag, oder gleiches Datum, gleicher Betrag und gleicher Text). ask: Jede Zeile kommt ins Buch, und mögliche Duplikate warten auf deinen Entscheid.',
    },
  },
  {
    key: 'bank.csv_fill_fed_accounts',
    schema: { type: 'enum', values: ['allow', 'refuse'] },
    default: 'allow',
    owningCapability: 'pay',
    dialCapability: 'pay',
    area: { id: 'A39', label: { en: 'Bank', 'de-CH': 'Bank' } },
    label: {
      en: 'Gap fill from a CSV on an EBICS account',
      'de-CH': 'Lücke aus CSV füllen bei einem EBICS-Konto',
    },
    description: {
      en: 'allow: a bank account fed over EBICS still takes a CSV export for the days the feed never delivered. refuse: such an account takes camt.053 from the feed only.',
      'de-CH': 'allow: Ein Bankkonto mit EBICS nimmt einen CSV-Export trotzdem für die Tage, die der Bankkanal nie geliefert hat. refuse: Ein solches Konto nimmt nur camt.053 aus dem Bankkanal.',
    },
  },
  // A20 §13.3 (D205): a gap between two stored statements proven without a balance column, by the sum.
  {
    key: 'bank.csv_fill_proof',
    schema: { type: 'enum', values: ['auto', 'running_balance_only'] },
    default: 'auto',
    owningCapability: 'pay',
    dialCapability: 'pay',
    area: { id: 'A39', label: { en: 'Bank', 'de-CH': 'Bank' } },
    label: {
      en: 'Gap fill from an export: how the days are proven',
      'de-CH': 'Lücke aus einem Export füllen: womit die Tage geprüft werden',
    },
    description: {
      en: "auto: by the export's running balance when one is mapped, else, for a gap between two statements in the books, by the sum: the export's rows on the missing days must add up exactly to what the two statements leave open, the export must reach past both ends, hold no unreadable row, and agree with the books on both boundary days. running_balance_only: only the running balance proves a fill.",
      'de-CH': 'auto: am laufenden Saldo des Exports, wenn einer zugeordnet ist, sonst bei einer Lücke zwischen zwei Auszügen im Buch an der Summe: die Zeilen des Exports an den fehlenden Tagen ergeben genau, was die zwei Auszüge offen lassen, der Export reicht über beide Enden hinaus, hat keine unlesbare Zeile und stimmt an beiden Grenztagen mit dem Buch überein. running_balance_only: nur der laufende Saldo prüft eine Füllung.',
    },
  },
  // D188 (A39 §21): a line that names no counterparty (a debit-card purchase, a bank fee) gets the one its
  // text names: the merchant after the masked card number, or the account's own bank for a fee. `on` (the
  // default) reads it wherever the counterparty is read (rules, history, the miner, the inbox); `off` reads
  // only what the bank stated, as before, and a rule saved under a derived counterparty then stays silent.
  // It decides what a booking proposes, so `post` owns it and drafts it, like `bank.buchungsregel_mode`.
  {
    key: 'bank.derive_counterparty',
    schema: { type: 'enum', values: ['on', 'off'] },
    default: 'on',
    owningCapability: 'post',
    dialCapability: 'post',
    area: { id: 'A39', label: { en: 'Bank', 'de-CH': 'Bank' } },
    label: {
      en: 'Counterparty from the booking text',
      'de-CH': 'Gegenpartei aus dem Buchungstext',
    },
    description: {
      en: 'on (default): a bank line without a counterparty name or IBAN gets the one its text names: the merchant of a card purchase, or your bank for a fee line. Rules, history and rule suggestions then work on these lines. off: only what the bank stated counts.',
      'de-CH': 'on (Standard): Eine Bankzeile ohne Namen oder IBAN der Gegenpartei bekommt die Gegenpartei aus ihrem Text: den Händler einer Kartenzahlung oder deine Bank bei einer Gebühr. Buchungsregeln, Verlauf und Regelvorschläge funktionieren dann auch für diese Zeilen. off: Es zählt nur, was die Bank angibt.',
    },
  },
  // D208 point 8: the text of an entry a bank booking posts. `leg` (the default) takes the description of the
  // booking's rest leg, which is where a Buchungsregel keeps the booking text the person typed with the star;
  // `bank` keeps the bank's default text ("Bank: counterparty, remittance"), as before. A text the booking
  // names wins either way. It decides what a booking posts, so `post` owns it and drafts it.
  {
    key: 'bank.entry_text_from_leg',
    schema: { type: 'enum', values: ['leg', 'bank'] },
    default: 'leg',
    owningCapability: 'post',
    dialCapability: 'post',
    area: { id: 'A39', label: { en: 'Bank', 'de-CH': 'Bank' } },
    label: {
      en: 'Entry text of a bank booking',
      'de-CH': 'Buchungstext einer Bankbuchung',
    },
    description: {
      en: 'leg (default): an entry booked by a Buchungsregel carries the rule\'s booking text. bank: every bank entry carries the bank\'s text with counterparty and remittance. A text you type for one booking always wins.',
      'de-CH': 'leg (Standard): Eine Buchung über eine Buchungsregel trägt deren Buchungstext. bank: Jede Bankbuchung trägt den Text der Bank mit Gegenpartei und Mitteilung. Ein Text, den du für eine Buchung eingibst, gilt immer.',
    },
  },
  // D188 (A39 §21.1): the CLOSED list of a bank's own fee texts, `;`-separated whole-text patterns (`<bank>`,
  // `<card>`), matched anchored at both ends. A line that matches one and names no counterparty is the
  // account's own bank. Extend it for another bank's exact wording; empty leaves only the bank code (CHRG).
  {
    key: 'bank.fee_texts',
    schema: { type: 'string', maxLength: 2000 },
    default: BANK_FEE_TEXTS_DEFAULT,
    owningCapability: 'post',
    dialCapability: 'post',
    area: { id: 'A39', label: { en: 'Bank', 'de-CH': 'Bank' } },
    label: {
      en: 'Texts of bank fee lines',
      'de-CH': 'Texte von Bankgebühren',
    },
    description: {
      en: 'The exact texts of your bank\'s own fee lines, separated by semicolons. A line without a counterparty whose WHOLE text is one of them is booked as coming from your bank, so one rule books all of them. <bank> stands for the bank\'s name and <card> for a masked card number (for example: Fee for <bank> Visa Debit Card no. <card>). Any other text is no fee line.',
      'de-CH': 'Die genauen Texte der Gebührenzeilen deiner Bank, durch Strichpunkte getrennt. Eine Zeile ohne Gegenpartei, deren GANZER Text einer davon ist, gilt als Zeile deiner Bank, sodass eine Regel alle davon bucht. <bank> steht für den Namen der Bank und <card> für eine maskierte Kartennummer (zum Beispiel: Gebühr für <bank> Debitkarte Nr. <card>). Jeder andere Text ist keine Gebührenzeile.',
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
  // A41 (D184 point 6): ASK FIRST. Until a person answered it, no rule is offered and none can be granted; the
  // rule card asks 3 / 5 / 10 with the suggestion (5, was 10 before D184) pre-selected.
  {
    key: 'rules.autobook_offer_after',
    schema: { type: 'integer', min: 3, max: 100, unit: 'items' },
    default: 5,
    owningCapability: 'post',
    dialCapability: 'post',
    humanOnly: true,
    askFirst: true,
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
  // D188 (A39 §21): may a rule keyed by a DERIVED counterparty (read from the booking text, not stated by
  // the bank) book its own lines? N04 keeps a NAME key out of the autopilot because a name could be another
  // business. `all` (the default, the owner's pick of 09.11.2026): a card merchant's rule and a fee rule of the
  // account's own bank may book unattended, still only after the person's grant and with N04's receipt and
  // amount checks. `bank_fees`: only the own bank's fee lines (the text starts with the bank's fee phrase and
  // the line names nobody else). `off`: no derived key ever books unattended. Human-only like every autobook
  // setting.
  {
    key: 'rules.autobook_derived_keys',
    schema: { type: 'enum', values: ['all', 'bank_fees', 'off'] },
    default: 'all',
    owningCapability: 'post',
    dialCapability: 'post',
    humanOnly: true,
    area: { id: 'N04', label: { en: 'Autopilot', 'de-CH': 'Autopilot' } },
    label: { en: 'Automatic booking of lines without a stated counterparty', 'de-CH': 'Automatisches Buchen von Zeilen ohne angegebene Gegenpartei' },
    description: {
      en: 'all (default): a rule whose counterparty TILL read from the booking text (a card merchant, the fee lines of your own bank) may book automatically once you switch it on, with the same receipt and amount checks as every rule. bank_fees: only the fee lines of your own bank. off: such a rule never books by itself.',
      'de-CH': 'all (Standard): Eine Regel, deren Gegenpartei TILL aus dem Buchungstext gelesen hat (ein Kartenhändler, die Gebührenzeilen deiner eigenen Bank), darf automatisch buchen, sobald du sie einschaltest, mit denselben Beleg- und Betragsprüfungen wie jede Regel. bank_fees: Nur die Gebührenzeilen deiner eigenen Bank. off: Eine solche Regel bucht nie von selbst.',
    },
  },
  // A41.3 re-cut v2 (D184 point 2): a switched-on rule books a line that expects a receipt only with the line's
  // ASSIGNED receipt (`belegVerdict.ts`: the engine's unique pairing, or a person's "Anhängen"), attached in the
  // booking's own transaction; otherwise the line waits ("wartet auf Beleg"). Human-only like every autobook
  // setting.
  {
    key: 'rules.autobook_requires_beleg',
    schema: { type: 'enum', values: ['off', 'on'] },
    default: 'off',
    owningCapability: 'post',
    dialCapability: 'post',
    humanOnly: true,
    area: { id: 'N04', label: { en: 'Autopilot', 'de-CH': 'Autopilot' } },
    label: { en: 'Automatic booking needs its receipt', 'de-CH': 'Automatisches Buchen braucht den Beleg' },
    description: {
      en: 'off (default): a switched-on rule books its lines as before. on: it books a line that needs a receipt only when that receipt is assigned to the line (TILL found exactly one fitting receipt, or you attached it), and attaches it in the same booking; otherwise the line waits for its receipt and shows in the daily digest.',
      'de-CH': 'off (Standard): Eine eingeschaltete Regel bucht ihre Zeilen wie bisher. on: Sie bucht eine Zeile, die einen Beleg braucht, nur wenn der Zeile ihr Beleg zugeordnet ist (TILL hat genau einen passenden Beleg gefunden, oder du hast ihn angehängt), und hängt ihn in derselben Buchung an; sonst wartet die Zeile auf ihren Beleg und steht in der Tagesübersicht.',
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
  // D208 (owner, 18.11.2026): the calm Vorschlag rows of Pendenzen and the Übersicht card. Presentation only:
  // none of the three changes what a click books. `row_hints`: `missing` (default) shows the one hint a row can
  // need, a missing Beleg on a line that claims Vorsteuer (the paperclip in the warn ink, which attaches);
  // `none` shows no hint. `undo_seconds`: how long the confirmation of an approval keeps Rückgängig (0: no
  // Rückgängig in the confirmation; the booking still follows the normal reversal rules). `keys`: the list's
  // keys (↑ ↓ move, Enter opens, F freigeben, R ablehnen) on or off.
  {
    key: 'attention.row_hints',
    schema: { type: 'enum', values: ['missing', 'none'] },
    default: 'missing',
    owningCapability: 'manage_settings',
    dialCapability: 'customize',
    area: { id: 'G15', label: { en: 'Pendenzen', 'de-CH': 'Pendenzen' } },
    label: { en: 'Hints on proposal rows', 'de-CH': 'Hinweise auf Vorschlagszeilen' },
    description: {
      en: 'missing (default): a row shows a glyph only when something is missing (a receipt for a line that claims input tax). none: no hints.',
      'de-CH': 'missing (Standard): Eine Zeile zeigt ein Zeichen nur, wenn etwas fehlt (der Beleg zu einer Zeile mit Vorsteuer). none: keine Hinweise.',
    },
  },
  {
    key: 'attention.undo_seconds',
    schema: { type: 'integer', min: 0, max: 60 },
    default: 10,
    owningCapability: 'manage_settings',
    dialCapability: 'customize',
    area: { id: 'G15', label: { en: 'Pendenzen', 'de-CH': 'Pendenzen' } },
    label: { en: 'Seconds to undo an approval', 'de-CH': 'Sekunden zum Rückgängigmachen einer Freigabe' },
    description: {
      en: 'How long the confirmation of an approval offers Undo (default 10). 0: no Undo in the confirmation.',
      'de-CH': 'Wie lange die Bestätigung einer Freigabe Rückgängig anbietet (Standard 10). 0: kein Rückgängig in der Bestätigung.',
    },
  },
  {
    key: 'attention.keys',
    schema: { type: 'boolean' },
    default: true,
    owningCapability: 'manage_settings',
    dialCapability: 'customize',
    area: { id: 'G15', label: { en: 'Pendenzen', 'de-CH': 'Pendenzen' } },
    label: { en: 'Keys in the list of proposals', 'de-CH': 'Tasten in der Vorschlagsliste' },
    description: {
      en: 'On (default): arrow up and down move, Enter opens, F approves, R rejects. Off: only the arrows move.',
      'de-CH': 'Ein (Standard): Pfeil hoch und runter wechseln die Zeile, Enter öffnet, F gibt frei, R lehnt ab. Aus: nur die Pfeile wechseln.',
    },
  },
  // D207 point 3 (owner, 16.11.2026, pick A): "Freigeben und künftig automatisch" on a bank booking Vorschlag
  // books the line and saves a Buchungsregel from that booking in ONE click (`never`, the default). `always`
  // keeps the confirm step the owner did not pick: the rule shows in the opened row first and a second click
  // saves it. Human-only: it sets how much a person's own click is checked, which an agent may not loosen.
  {
    key: 'attention.auto_rule_confirm',
    schema: { type: 'enum', values: ['never', 'always'] },
    default: 'never',
    owningCapability: 'post',
    dialCapability: 'post',
    humanOnly: true,
    area: { id: 'G15', label: { en: 'Pendenzen', 'de-CH': 'Pendenzen' } },
    label: { en: 'Confirm the rule of "approve and automate"', 'de-CH': 'Regel bei "Freigeben und künftig automatisch" bestätigen' },
    description: {
      en: 'never (default): one click books the bank line and saves the Buchungsregel. always: the rule shows first and a second click saves it.',
      'de-CH': 'never (Standard): Ein Klick bucht die Bankzeile und speichert die Buchungsregel. always: Die Regel erscheint zuerst, ein zweiter Klick speichert sie.',
    },
  },
  // D210 (owner, 18.11.2026): Aufgaben left the menu; the ones due soon arrive in Pendenzen' Erledigen
  // section. The window is a setting; 0 keeps them on the Aufgaben page only.
  {
    key: 'attention.tasks_due_days',
    schema: { type: 'integer', min: 0, max: 90, unit: 'days' },
    default: 14,
    owningCapability: 'manage_settings',
    dialCapability: 'customize',
    area: { id: 'G15', label: { en: 'Pendenzen', 'de-CH': 'Pendenzen' } },
    label: { en: 'Due tasks in Pendenzen', 'de-CH': 'Fällige Aufgaben in Pendenzen' },
    description: {
      en: 'How many days ahead Pendenzen lists open tasks as due, overdue ones included. 0 lists no task in Pendenzen.',
      'de-CH': 'Wie viele Tage im Voraus Pendenzen offene Aufgaben als fällig zeigt, überfällige eingeschlossen. 0 zeigt keine Aufgabe in Pendenzen.',
    },
  },
  // --- A26, the agent's decisions on Vorschläge (D196) ---------------------------------------------
  // D196 (founder, 12.11.2026): an EXPLICIT, owner-only, revocable grant that lets the governed agent seat
  // decide Vorschläge itself. `off` (the default): only a person approves or rejects, exactly as before.
  // `reject`: the agent may reject (`reject_drafted_action`, `reject_drafted_actions`). `decide`: the agent may reject AND approve
  // (`approve_drafted_action`, `approve_drafted_actions`). Owned by `manage_agent_dial` (the right that
  // decides) and HUMAN-ONLY, so the agent can neither switch it nor propose switching it. The grant is in
  // force only while the person who set it still holds `manage_agent_dial` (`core/agent/decisionGrant.ts`):
  // a demoted grantor's grant fails closed. Every decision taken under it names the grant on the row's
  // history and in the trace. `customize` is the dial family a change of this setting would draft under.
  {
    key: 'agent.decide_proposals',
    schema: { type: 'enum', values: ['off', 'reject', 'decide'] },
    default: 'off',
    owningCapability: 'manage_agent_dial',
    dialCapability: 'customize',
    humanOnly: true,
    area: { id: 'A26', label: { en: 'Agent', 'de-CH': 'Agent' } },
    label: { en: 'Agent decides proposals', 'de-CH': 'Agent entscheidet Vorschläge' },
    description: {
      en: 'off (default): only a person approves or rejects proposals. reject: the agent may reject proposals itself. decide: the agent may also approve bank-line decisions and booking rules; everything else waits for you. TILL\'s own offers always wait for you. Every decision the agent takes shows your grant. Only a person can change this; switch it back to off at any time.',
      'de-CH': 'off (Standard): Nur eine Person genehmigt oder verwirft Vorschläge. reject: Der Agent darf Vorschläge selbst verwerfen. decide: Der Agent darf zusätzlich Entscheide zu Bankzeilen und Buchungsregeln genehmigen; alles andere wartet auf dich. Die Angebote von TILL warten immer auf dich. Jede Entscheidung des Agenten zeigt deine Freigabe. Nur eine Person kann das ändern; stell es jederzeit auf off zurück.',
    },
  },
  // D209 (owner, 18.11.2026: "If I tell you it's approved, then you must have the ability to actually do this"):
  // APPROVAL ON THE OWNER'S WORD. `off` (the default): the agent's approval needs the standing grant above or a
  // person's click. `on`: when the owner approves named Vorschläge in their own message to the agent, the agent
  // may approve exactly those, every kind (owner's pick "every one"), passing the owner's words verbatim and
  // when they were said (`ownerWord`); each runs as drafted, as the agent, and the words land on the row's
  // history and the A03 chain. A protected setting and the dial stay a person's click. TILL cannot read the
  // chat, so THIS setting is the trust root: owned by `manage_agent_dial`, HUMAN-ONLY (the agent can neither
  // switch it nor propose switching it to effect), in force only while its grantor still holds
  // `manage_agent_dial` (`core/agent/decisionGrant.ts`).
  {
    key: 'agent.approve_on_owner_word',
    schema: { type: 'enum', values: ['off', 'on'] },
    default: 'off',
    owningCapability: 'manage_agent_dial',
    dialCapability: 'customize',
    humanOnly: true,
    area: { id: 'A26', label: { en: 'Agent', 'de-CH': 'Agent' } },
    label: { en: 'Agent approves on your word', 'de-CH': 'Agent genehmigt auf dein Wort' },
    description: {
      en: 'off (default): a Vorschlag waits for your click, or for the grant above. on: when you tell the agent in your own message that named Vorschläge are approved, it approves exactly those and runs them as drafted, of every kind. Your words are kept verbatim on each Vorschlag and in the Verlauf. Protected settings and "automate from now on" always wait for your click. Only a person can change this.',
      'de-CH': 'off (Standard): Ein Vorschlag wartet auf deinen Klick oder auf die Freigabe oben. on: Sagst du dem Agenten in deiner eigenen Nachricht, dass genannte Vorschläge genehmigt sind, genehmigt er genau diese und führt sie so aus, wie sie entworfen sind, jede Art. Deine Worte bleiben wörtlich bei jedem Vorschlag und im Verlauf. Geschützte Einstellungen und "künftig automatisch" warten immer auf deinen Klick. Nur eine Person kann das ändern.',
    },
  },
  // D209 (critic r2 L1, D172): how long before a Vorschlag was drafted the owner's words may have been written
  // ("approved, do it" said just before the agent drafts it). 0 means only words written after the draft count.
  // Human-only and owned by `manage_agent_dial`, like the setting it qualifies.
  {
    key: 'agent.owner_word_before_draft_minutes',
    schema: { type: 'integer', min: 0, max: 1440 },
    default: 60,
    owningCapability: 'manage_agent_dial',
    dialCapability: 'customize',
    humanOnly: true,
    area: { id: 'A26', label: { en: 'Agent', 'de-CH': 'Agent' } },
    label: { en: 'Approval in chat: words before the proposal', 'de-CH': 'Freigabe im Chat: Worte vor dem Vorschlag' },
    description: {
      en: 'How many minutes before the agent drafted a proposal your approving words may have been written (default 60). 0: only words written after the proposal count. Only a person can change this.',
      'de-CH': 'Wie viele Minuten vor dem Entwurf eines Vorschlags deine Freigabe geschrieben sein darf (Standard 60). 0: Nur Worte nach dem Vorschlag zählen. Nur eine Person kann das ändern.',
    },
  },
  // D209 amendment (owner, 18.11.2026, after a security review: TILL cannot verify a quote the agent supplies):
  // the dial families the owner's word never approves; they always wait for a person's click. A comma-separated
  // list of dial families, default filing the VAT return, plugins and sharing with someone outside (D172: a
  // person may shrink or grow it). Human-only and owned by `manage_agent_dial`, like the setting it limits; read
  // fail closed (`ownerWordExcludedFamilies` in `core/agent/decisionGrant.ts`).
  {
    key: 'agent.owner_word_excluded',
    schema: { type: 'string', maxLength: OWNER_WORD_EXCLUDED_MAX_LENGTH },
    default: OWNER_WORD_EXCLUDED_DEFAULT,
    owningCapability: 'manage_agent_dial',
    dialCapability: 'customize',
    humanOnly: true,
    area: { id: 'A26', label: { en: 'Agent', 'de-CH': 'Agent' } },
    label: { en: 'Always your click, even on your word', 'de-CH': 'Immer dein Klick, auch auf dein Wort' },
    description: {
      en: 'The kinds of proposal the agent never approves on your word; they wait for your click in the Studio. A comma-separated list of dial families, or none. Default: filing VAT, plugins and sharing with someone outside. Only a person can change this.',
      'de-CH': 'Die Arten von Vorschlägen, die der Agent nie auf dein Wort genehmigt; sie warten auf deinen Klick im Studio. Eine Liste von Freigabe-Familien mit Komma, oder none. Standard: MWST einreichen, Plugins und Freigeben an Aussenstehende. Nur eine Person kann das ändern.',
    },
  },
  // D196 item 8 (owner, 12.11.2026): the agent's one-call Ignorieren under the grant. With `one_call` (the
  // default) an agent seat's `ignore_bank_line` that drafts (the `post` dial at ask) is approved under a live
  // `agent.decide_proposals = decide` grant in the same call, through the existing approval
  // (`src/api/agent-gate.ts`): nothing the two-call path cannot do. `two_calls` keeps the draft and the agent
  // approves it with a second call (or a person does). Without a `decide` grant it changes nothing. Owned by
  // `manage_agent_dial` and human-only, like the grant itself.
  {
    key: 'agent.ignore_under_grant',
    schema: { type: 'enum', values: ['one_call', 'two_calls'] },
    default: 'one_call',
    owningCapability: 'manage_agent_dial',
    dialCapability: 'customize',
    humanOnly: true,
    area: { id: 'A26', label: { en: 'Agent', 'de-CH': 'Agent' } },
    label: { en: 'Agent ignores bank lines in one step', 'de-CH': 'Agent ignoriert Bankzeilen in einem Schritt' },
    description: {
      en: 'one_call (default): when the agent may decide proposals (decide), its Ignorieren of a bank line is decided in the same step and shows your grant. two_calls: it stays a proposal until the agent or a person approves it. Without the decide grant nothing changes. Only a person can change this.',
      'de-CH': 'one_call (Standard): Darf der Agent Vorschläge entscheiden (decide), ist sein Ignorieren einer Bankzeile im selben Schritt entschieden und zeigt deine Freigabe. two_calls: Es bleibt ein Vorschlag, bis der Agent oder eine Person ihn genehmigt. Ohne die Freigabe decide ändert sich nichts. Nur eine Person kann das ändern.',
    },
  },
  // D196 item 9 (owner, 13.11.2026, with the batch reject `reject_drafted_actions`): whether the agent must say
  // WHY when it rejects a Vorschlag under the owner's grant. `optional` (the default since D204, 16.11.2026:
  // no mandatory reason anywhere, A03 §11): it may leave it out. `required`: a rejection the agent takes
  // under `agent.decide_proposals` without a reason refuses `reason_required`, for a team that wants the
  // reason on every row the agent closed (D172 keeps the choice). A person's
  // rejection never needs one. Checked in `rejectDraftedAction`, so the single verb and the batch agree.
  // Owned by `manage_agent_dial` and human-only, like the grant itself.
  {
    key: 'agent.reject_reason',
    schema: { type: 'enum', values: ['required', 'optional'] },
    default: 'optional',
    owningCapability: 'manage_agent_dial',
    dialCapability: 'customize',
    humanOnly: true,
    area: { id: 'A26', label: { en: 'Agent', 'de-CH': 'Agent' } },
    label: { en: 'Agent says why it rejects', 'de-CH': 'Agent begründet Ablehnungen' },
    description: {
      en: 'optional (default): when the agent rejects proposals under your grant, it may leave the reason out; who rejected and when are always kept. required: it must say why, and you see the reason on every proposal it rejected. Your own rejections never need one. Only a person can change this.',
      'de-CH': 'optional (Standard): Lehnt der Agent mit deiner Freigabe Vorschläge ab, darf er den Grund weglassen; wer wann abgelehnt hat, bleibt immer festgehalten. required: Er muss sagen, warum, und du siehst den Grund bei jedem Vorschlag, den er abgelehnt hat. Deine eigenen Ablehnungen brauchen nie einen Grund. Nur eine Person kann das ändern.',
    },
  },
  // D202 point 4 (owner, 15.11.2026, pick A): the areas of the Einstellungen in which the agent may change a
  // setting when the person tells it to, without a Vorschlag. A comma-separated list of area ids
  // (`./areas.ts`), empty by default (no area). It never covers a human-only setting (those are always a
  // person-only Vorschlag, D202 point 5). Owned by `manage_agent_dial` (the right that decides what the agent
  // may do) and HUMAN-ONLY: the agent can propose it, never apply it. In force only while the person who set
  // it still holds `manage_agent_dial` (`./agentAccess.ts`), like the D196 grant.
  {
    key: 'agent.settings_sections',
    schema: { type: 'string', maxLength: SETTINGS_SECTIONS_MAX_LENGTH },
    default: '',
    owningCapability: 'manage_agent_dial',
    dialCapability: 'customize',
    humanOnly: true,
    area: { id: 'A26', label: { en: 'Agent', 'de-CH': 'Agent' } },
    label: { en: 'Areas the agent may change', 'de-CH': 'Bereiche, die der Agent ändern darf' },
    description: {
      en: 'In these areas of the settings the agent changes a setting when you tell it to, without a proposal. Protected settings stay a proposal for you. None by default.',
      'de-CH': 'In diesen Bereichen der Einstellungen ändert der Agent eine Einstellung, wenn du es ihm sagst, ohne Vorschlag. Geschützte Einstellungen bleiben ein Vorschlag an dich. Standardmässig keiner.',
    },
  },
  // D202 point 5: how many person-only settings Vorschläge (a protected setting the agent proposes) may wait
  // at once. 3 is the decided rule. Human-only, owned by `manage_agent_dial`, like the permission above.
  {
    key: 'agent.settings_proposals_open_max',
    schema: { type: 'integer', min: 1, max: 10, unit: 'items' },
    default: 3,
    owningCapability: 'manage_agent_dial',
    dialCapability: 'customize',
    humanOnly: true,
    area: { id: 'A26', label: { en: 'Agent', 'de-CH': 'Agent' } },
    label: { en: 'Open setting proposals by the agent', 'de-CH': 'Offene Einstellungs-Vorschläge des Agenten' },
    description: {
      en: 'How many proposals to change a protected setting the agent may leave waiting for you at once.',
      'de-CH': 'Wie viele Vorschläge zu geschützten Einstellungen der Agent dir gleichzeitig offen lassen darf.',
    },
  },
  // D202 critic L1 (D172): whether an area opened to the agent (`agent.settings_sections`) still sends two
  // kinds of setting to a person: one whose dial family carries D103's strong default (`vat-file`,
  // `plugin-install`: what files with the ESTV or brings in third-party code), and any setting of the
  // Agent und Automatik area (what the agent may do and how its calls are judged). `true` (the default):
  // those stay a one-click Vorschlag even in an opened area. `false`: an opened area applies them at once.
  // Human-only and owned by `manage_agent_dial`, like the permission it narrows.
  {
    key: 'agent.settings_area_respects_strong_default',
    schema: { type: 'boolean' },
    default: true,
    owningCapability: 'manage_agent_dial',
    dialCapability: 'customize',
    humanOnly: true,
    area: { id: 'A26', label: { en: 'Agent', 'de-CH': 'Agent' } },
    label: { en: 'Opened areas keep asking for sensitive settings', 'de-CH': 'Offene Bereiche fragen bei heiklen Einstellungen nach' },
    description: {
      en: 'On (default): even in an area the agent may change, a setting that files with the tax office, installs code, or decides what the agent may do stays a proposal for you. Off: the opened area applies those at once too.',
      'de-CH': 'Ein (Standard): Auch in einem Bereich, den der Agent ändern darf, bleibt eine Einstellung zur MWST-Abrechnung, zu Erweiterungen oder dazu, was der Agent darf, ein Vorschlag an dich. Aus: Der offene Bereich ändert auch diese sofort.',
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
  // --- A41, the Beleg-Abgleich (D184) --------------------------------------------------------------
  // Critic A41 r1 G1: every belege.* setting feeds a decision (the evidence's certainty, and through it what the
  // bulk Buchen may take), so it is human-only and sits under the `post` dial: an agent may not widen a
  // tolerance to make its own Vorschlag look sure. (The A41.3 receipt gate for autobook is re-cut pending.)
  // Whether a captured receipt is offered as the Beleg of the bank line it fits (`belegCandidates` on the
  // inbox line, `bankLineCandidates` on a capture). A suggestion only: nothing is linked until a person or a
  // booking attaches it.
  {
    key: 'belege.match_mode',
    schema: { type: 'enum', values: ['suggest', 'off'] },
    default: 'suggest',
    owningCapability: 'post',
    dialCapability: 'post',
    humanOnly: true,
    area: { id: 'N02', label: { en: 'Receipts', 'de-CH': 'Belege' } },
    label: { en: 'Suggest the receipt of a bank line', 'de-CH': 'Beleg zur Bankzeile vorschlagen' },
    description: {
      en: 'suggest (default): a captured receipt whose amount, date and sender fit a bank line is shown on that line, ready to attach. off: no receipt is suggested.',
      'de-CH': 'suggest (Standard): Ein erfasster Beleg, dessen Betrag, Datum und Absender zu einer Bankzeile passen, wird bei dieser Zeile angezeigt und lässt sich anhängen. off: Es wird kein Beleg vorgeschlagen.',
    },
  },
  {
    key: 'belege.match_date_window_days',
    schema: { type: 'integer', min: 0, max: 60, unit: 'days' },
    default: 7,
    owningCapability: 'post',
    dialCapability: 'post',
    humanOnly: true,
    area: { id: 'N02', label: { en: 'Receipts', 'de-CH': 'Belege' } },
    label: { en: 'Receipt and bank line: days apart', 'de-CH': 'Beleg und Bankzeile: Tage auseinander' },
    description: {
      en: "How many days a receipt's invoice or due date may lie from the bank line's booking date for the two to fit. 7 by default.",
      'de-CH': 'Wie viele Tage das Rechnungs- oder Fälligkeitsdatum eines Belegs vom Buchungsdatum der Bankzeile entfernt sein darf, damit beide zusammenpassen. Standard 7.',
    },
  },
  {
    key: 'belege.match_fx_tolerance_pct',
    schema: { type: 'integer', min: 0, max: 20, unit: 'percent' },
    default: 3,
    owningCapability: 'post',
    dialCapability: 'post',
    humanOnly: true,
    area: { id: 'N02', label: { en: 'Receipts', 'de-CH': 'Belege' } },
    label: { en: 'Foreign-currency receipt: tolerance (percent)', 'de-CH': 'Beleg in Fremdwährung: Toleranz (Prozent)' },
    description: {
      en: "A receipt in another currency fits a CHF line when its amount, converted at the stored rate, lies within this percentage of the line. Used only when the statement does not state the amount in the receipt's currency. 3 by default.",
      'de-CH': 'Ein Beleg in anderer Währung passt zu einer CHF-Zeile, wenn sein Betrag, zum gespeicherten Kurs umgerechnet, höchstens so viele Prozent von der Zeile abweicht. Nur wenn der Kontoauszug den Betrag nicht in der Währung des Belegs nennt. Standard 3.',
    },
  },
  // D188 (A39 §21): a receipt's vendor word may match the START of a longer word of the line's counterparty or
  // card merchant ("MongoDB" in "MONGODBCLOUD"). `suggest` (default): such a receipt is a candidate a person
  // confirms, never one the engine pairs unattended. `engine`: the engine may pair it too. `off`: whole words only.
  {
    key: 'belege.match_vendor_prefix',
    schema: { type: 'enum', values: ['suggest', 'engine', 'off'] },
    default: 'suggest',
    owningCapability: 'post',
    dialCapability: 'post',
    humanOnly: true,
    area: { id: 'N02', label: { en: 'Receipts', 'de-CH': 'Belege' } },
    label: { en: 'Vendor name joined to more in the bank text', 'de-CH': 'Händlername im Banktext mit mehr verbunden' },
    description: {
      en: 'The bank often writes a vendor joined to more, for example MONGODBCLOUD for MongoDB. suggest (default): such a receipt is offered for the line, and you confirm it. engine: TILL may also assign it by itself when it is the only fitting receipt. off: only whole words count.',
      'de-CH': 'Die Bank schreibt einen Händler oft mit mehr zusammen, etwa MONGODBCLOUD für MongoDB. suggest (Standard): Ein solcher Beleg wird für die Zeile vorgeschlagen, und du bestätigst ihn. engine: TILL darf ihn auch selbst zuordnen, wenn er der einzige passende Beleg ist. off: Nur ganze Wörter zählen.',
    },
  },
  {
    key: 'belege.vat_delta_tolerance_rappen',
    schema: { type: 'integer', min: 0, max: 500 },
    default: 5,
    owningCapability: 'post',
    dialCapability: 'post',
    humanOnly: true,
    area: { id: 'N02', label: { en: 'Receipts', 'de-CH': 'Belege' } },
    label: { en: 'VAT on the receipt: tolerance (Rappen)', 'de-CH': 'MWST auf dem Beleg: Toleranz (Rappen)' },
    description: {
      en: "How many Rappen the receipt's VAT may differ from the VAT TILL computes before the proposal says to check it. A smaller difference is only noted. TILL always books the computed VAT. 5 by default.",
      'de-CH': 'Um wie viele Rappen die MWST auf dem Beleg von der MWST abweichen darf, die TILL rechnet, bevor der Vorschlag zum Prüfen auffordert. Eine kleinere Abweichung wird nur vermerkt. TILL bucht immer die gerechnete MWST. Standard 5.',
    },
  },
  // A41.8 (D193, owner 12.11.2026): whether the VAT a TRUSTED receipt states picks the input tax code of a bank
  // line's proposal. `propose` (default): yes; `compare_only`: the ladder's code as before, the receipt only compared.
  // Human-only under `post` like every belege.* setting (it decides what a proposal books).
  {
    key: 'belege.vat_from_receipt',
    schema: { type: 'enum', values: ['propose', 'compare_only'] },
    default: 'propose',
    owningCapability: 'post',
    dialCapability: 'post',
    humanOnly: true,
    area: { id: 'N02', label: { en: 'Receipts', 'de-CH': 'Belege' } },
    label: { en: 'VAT on the receipt picks the tax code', 'de-CH': 'MWST auf dem Beleg wählt den MWST-Code' },
    description: {
      en: 'propose (default): when a bank line has exactly one receipt that covers it, whose figures TILL trusts and which states one VAT rate, the proposal takes the matching Vorsteuer code (8.1, 2.6 or 3.8 %), or no code when the receipt states no VAT, but only if the VAT that code books matches the receipt. TILL still books the VAT it computes. compare_only: the proposal keeps the code of the rule or the history. In both modes a line whose receipt VAT differs, or cannot be checked because it has several receipts, a receipt that does not cover it or one in another currency, is not approved in bulk. Automatic booking waits on a differing receipt only while "Automatic booking needs its receipt" is on.',
      'de-CH': 'propose (Standard): Hat eine Bankzeile genau einen Beleg, der sie deckt, dessen Zahlen TILL vertraut und der einen MWST-Satz nennt, übernimmt der Vorschlag den passenden Vorsteuer-Code (8.1, 2.6 oder 3.8 %), oder keinen Code, wenn der Beleg keine MWST nennt, aber nur, wenn die MWST dieses Codes zum Beleg passt. TILL bucht weiterhin die MWST, die es rechnet. compare_only: Der Vorschlag behält den Code der Regel oder des Verlaufs. In beiden Fällen gibt TILL eine Zeile nicht gesammelt frei, deren Beleg-MWST abweicht oder sich nicht prüfen lässt, weil sie mehrere Belege hat, einen Beleg, der sie nicht deckt, oder einen in einer anderen Währung. Das automatische Buchen wartet bei abweichender Beleg-MWST nur, solange «Automatisches Buchen braucht den Beleg» eingeschaltet ist.',
    },
  },
  // A41.3 re-cut v2 (D184, I-F, owner decision 07.11.2026): which receipt figures may back an UNATTENDED
  // booking. `confirmed` (default): only figures a person confirmed ("Zahlen bestätigen") or read from a Swiss
  // QR code. `agent`: also figures an agent read. Human-only under `post` like every belege.* setting.
  {
    key: 'belege.autobook_figure_trust',
    schema: { type: 'enum', values: ['confirmed', 'agent'] },
    default: 'confirmed',
    owningCapability: 'post',
    dialCapability: 'post',
    humanOnly: true,
    area: { id: 'N02', label: { en: 'Receipts', 'de-CH': 'Belege' } },
    label: { en: 'Receipt figures automatic booking trusts', 'de-CH': 'Belegzahlen, denen das automatische Buchen vertraut' },
    description: {
      en: 'confirmed (default): TILL pairs a receipt with a bank line on its own, for automatic booking, only when a person confirmed its figures (Confirm figures) or TILL read them from the Swiss QR code. agent: figures an agent read count too; you accept that an agent reading error can book unattended.',
      'de-CH': 'confirmed (Standard): TILL ordnet einen Beleg für das automatische Buchen nur dann selbst einer Bankzeile zu, wenn eine Person seine Zahlen bestätigt hat (Zahlen bestätigen) oder TILL sie aus dem Swiss QR Code gelesen hat. agent: Auch Zahlen, die ein Agent gelesen hat, zählen; du nimmst in Kauf, dass ein Lesefehler des Agenten unbeaufsichtigt bucht.',
    },
  },
  // A41.3 re-cut v3 (owner 07.11.2026, D172): what a PERSON's act does with a receipt a PERSON assigned to another
  // bank line (an attach, a link, a pointer onto another booking). `refuse` (default): refused; "Lösen" there first,
  // then the act again. `move`: the receipt moves (the old line's assignment ends, its files leave the line, the line
  // is open again). It governs person rows only: a person's act always overrides TILL's own pairing, and a person's
  // capture commit always releases. Human-only under `post`.
  {
    key: 'belege.assigned_move',
    schema: { type: 'enum', values: ['refuse', 'move'] },
    default: 'refuse',
    owningCapability: 'post',
    dialCapability: 'post',
    humanOnly: true,
    area: { id: 'N02', label: { en: 'Receipts', 'de-CH': 'Belege' } },
    label: { en: 'A receipt you assigned, used elsewhere', 'de-CH': 'Zugeordneter Beleg, anderswo verwendet' },
    description: {
      en: 'refuse (default): a receipt you assigned to a bank line cannot be attached to another booking until you release it there (Release). move: it moves to the new booking, and the bank line it left is open again for another receipt. A receipt TILL paired on its own always gives way to your act.',
      'de-CH': 'refuse (Standard): Einen Beleg, den du einer Bankzeile zugeordnet hast, kannst du keiner anderen Buchung anhängen, bis du ihn dort löst (Lösen). move: Er geht zur neuen Buchung über, und die Bankzeile ist wieder offen für einen anderen Beleg. Ein Beleg, den TILL selbst zugeordnet hat, weicht deiner Handlung immer.',
    },
  },
  // A41.3 follow-ups (D172): what a file a person drops on an OPEN bank line becomes (`assign_beleg_file`). `assign`
  // (default): filed, captured and assigned in one act; a file that states no amount of its own takes the line's
  // amount as the person's. `assign_if_stated`: assigned only when the file states its amount, else filed and
  // captured, and the line waits. `file`: filed only (the D142 path). Human-only under `post`.
  {
    key: 'belege.drop_on_open_line',
    schema: { type: 'enum', values: ['assign', 'assign_if_stated', 'file'] },
    default: 'assign',
    owningCapability: 'post',
    dialCapability: 'post',
    humanOnly: true,
    area: { id: 'N02', label: { en: 'Receipts', 'de-CH': 'Belege' } },
    label: { en: 'A file dropped on an open bank line', 'de-CH': 'Datei auf eine offene Bankzeile gezogen' },
    description: {
      en: 'assign (default): TILL files it on the line, captures it and assigns it to the line as your receipt; if the file states no amount of its own (no QR code), the line\'s amount counts as yours. assign_if_stated: the same, but a file without its own amount is only filed and captured, and the line waits until you state the amount and assign it. file: TILL only files it on the line; you assign it later.',
      'de-CH': 'assign (Standard): TILL legt die Datei auf der Zeile ab, erfasst sie und ordnet sie der Zeile als deinen Beleg zu; nennt die Datei keinen eigenen Betrag (kein QR-Code), gilt der Betrag der Zeile als deiner. assign_if_stated: genauso, aber eine Datei ohne eigenen Betrag wird nur abgelegt und erfasst, und die Zeile wartet, bis du den Betrag nennst und sie zuordnest. file: TILL legt die Datei nur auf der Zeile ab; du ordnest sie später zu.',
    },
  },
  // A41.3 re-cut v2 (critic r2 F3, orchestrator decision 07.11.2026, a conservative default): an UNDATED receipt
  // (no invoice or due date of its own, a QR bill states none) pairs unattended only on an exact reference match,
  // or when it fits exactly one receipt-less line of its sender and amount within this many days back. 0: an
  // undated receipt never pairs on its own. Human-only under `post`.
  {
    key: 'belege.undated_lookback_days',
    schema: { type: 'integer', min: 0, max: 400 },
    default: 120,
    owningCapability: 'post',
    dialCapability: 'post',
    humanOnly: true,
    area: { id: 'N02', label: { en: 'Receipts', 'de-CH': 'Belege' } },
    label: { en: 'Receipts without a date: look back (days)', 'de-CH': 'Belege ohne Datum: Rückblick (Tage)' },
    description: {
      en: 'A receipt that states no date of its own (a QR bill, for one) is paired with a bank line automatically only when its payment reference matches the line, or when it fits exactly one line without a receipt of the same sender and amount within this many days back. 0: such receipts always wait for you. 120 by default.',
      'de-CH': 'Ein Beleg ohne eigenes Datum (zum Beispiel eine QR-Rechnung) wird einer Bankzeile nur dann automatisch zugeordnet, wenn seine Referenz zur Zeile passt, oder wenn er innerhalb dieser Anzahl Tage zurück zu genau einer Zeile ohne Beleg desselben Absenders und Betrags passt. 0: Solche Belege warten immer auf dich. Standard 120.',
    },
  },
  // A41.3 re-cut v2 (D184, I-F, security review 07.11.2026): a QR code counts as trusted only on a document a
  // person brought in. Whether a receipt from the Belegeingang folder (the owner's own channel) counts: `on`
  // (default). An agent with write access to that folder could plant a QR invoice there; `off` makes folder
  // receipts need "Zahlen bestätigen" like any other. Human-only under `post`.
  {
    key: 'belege.qr_trust_folder',
    schema: { type: 'enum', values: ['on', 'off'] },
    default: 'on',
    owningCapability: 'post',
    dialCapability: 'post',
    humanOnly: true,
    area: { id: 'N02', label: { en: 'Receipts', 'de-CH': 'Belege' } },
    label: { en: 'Trust the QR code of folder receipts', 'de-CH': 'QR-Code von Belegen aus dem Ordner vertrauen' },
    description: {
      en: 'on (default): the Swiss QR code of a receipt from your Belegeingang folder counts like one you captured yourself, for automatic booking. off: such receipts need Confirm figures first. Whoever can write into that folder (an agent with file access too) can put a QR invoice there.',
      'de-CH': 'on (Standard): Der Swiss QR Code eines Belegs aus deinem Belegeingang-Ordner zählt für das automatische Buchen wie einer, den du selbst erfasst hast. off: Solche Belege brauchen zuerst «Zahlen bestätigen». Wer in diesen Ordner schreiben kann (auch ein Agent mit Dateizugriff), kann dort eine QR-Rechnung ablegen.',
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
  // --- E04, the local mail store ------------------------------------------------------------------
  // D172 (critic R2-M1 on the aux-durability port): what the busy check before a Thunderbird mbox Drafts
  // write does (`MBOX_CLIENT_GUARDS` in `src/core/mail/adapters.ts`). `refuse` is the critic-R1-L1 rule:
  // refuse when a mail client holds the mbox or its profile, and when `lsof` cannot answer.
  // `refuse_running` refuses only a proven holder (a sandboxed TILL.app or a box without lsof would
  // otherwise never write a Drafts mbox again); `off` does not check. The rename-time change check stays
  // under every value, so a draft the client saved meanwhile is never overwritten. Owned by `mail.write`,
  // the capability `mail_draft_write` itself needs. HUMAN-ONLY (critic r3 nit 1): it guards writes into
  // the user's own mail file, so an agent seat can neither loosen it nor draft a Vorschlag to, under any
  // dial. There is no mail dial family to gate it by (`payroll.month_guard` drafts under `post`).
  {
    key: 'mail.mbox_client_guard',
    schema: { type: 'enum', values: ['refuse', 'refuse_running', 'off'] },
    default: 'refuse',
    owningCapability: 'mail.write',
    dialCapability: 'customize',
    humanOnly: true,
    area: { id: 'E04', label: { en: 'Mail', 'de-CH': 'Mail' } },
    label: { en: 'Mail app check before writing a draft', 'de-CH': 'Mail-Programm prüfen vor einem Entwurf' },
    description: {
      en: 'Before TILL writes a draft into a Thunderbird mbox Drafts file: refuse while a mail app has it open or when the check cannot answer (default), refuse only while a mail app is proven to have it open, or do not check. A Drafts file that changed meanwhile is always refused.',
      'de-CH': 'Bevor TILL einen Entwurf in eine Thunderbird-Entwurfsdatei (mbox) schreibt: ablehnen, solange ein Mail-Programm sie offen hat oder die Prüfung keine Antwort gibt (Standard), nur ablehnen, wenn ein Mail-Programm sie nachweislich offen hat, oder nicht prüfen. Eine Entwurfsdatei, die sich inzwischen geändert hat, wird immer abgelehnt.',
    },
  },
  // --- O00, What's new (D199) ---------------------------------------------------------------------
  // Display choices of the release notes. Neither changes what money does.
  {
    key: 'releases.whats_new_toast',
    schema: { type: 'boolean' },
    default: true,
    owningCapability: 'manage_settings',
    dialCapability: 'customize',
    area: { id: 'O00', label: { en: 'Updates', 'de-CH': 'Updates' } },
    label: { en: "Show What's new after an update", 'de-CH': 'Neuigkeiten nach einem Update zeigen' },
    description: {
      en: "After TILL updates, show a short note with a What's new button once. The notes stay in the menu either way.",
      'de-CH': 'Nach einem Update einmal einen kurzen Hinweis mit Neuigkeiten zeigen. Im Menü bleiben sie so oder so.',
    },
  },
  {
    key: 'releases.whats_new_versions',
    schema: { type: 'integer', min: 1, max: 20, unit: 'items' },
    default: 10,
    owningCapability: 'manage_settings',
    dialCapability: 'customize',
    area: { id: 'O00', label: { en: 'Updates', 'de-CH': 'Updates' } },
    label: { en: 'Versions in the notes', 'de-CH': 'Versionen in den Neuigkeiten' },
    description: {
      en: 'How many versions the notes list shows. Older versions are on tillbooks.ch/changelog.',
      'de-CH': 'Wie viele Versionen die Neuigkeiten zeigen. Ältere stehen auf tillbooks.ch/changelog.',
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
    if (s.askFirst === true && s.humanOnly !== true) {
      throw new Error(`settings registry: the ask-first setting '${s.key}' must be humanOnly (only a person answers it)`);
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
