/**
 * D178 E3 (A39 §17.9): the words of the new bank-line booking targets, in en and de-CH, in ONE place.
 *
 * Every refusal the E3 targets add carries a stable code AND a `sentence { en, 'de-CH' }` in its payload,
 * so an agent over MCP reads the same words a person reads in the Studio, and the Studio (node N3) can show
 * the engine's sentence instead of composing its own. The consequence of a counter-leg in the transaction
 * currency follows the shape of the engine's consequence catalogue (`../agent/consequences.ts`: at most two
 * sentences, what happens, then what you can still do, with how far it can be undone).
 *
 * de-CH house style: "du", real umlauts, no sharp-s, no em dash. Pure data plus one helper; it imports only
 * the result constructor, so every banking module can use it without a cycle.
 */

import { err } from '../result.js';
import type { Err } from '../result.js';
import type { Consequence } from '../agent/consequences.js';

export interface BankTargetSentence {
  readonly en: string;
  readonly 'de-CH': string;
}

/** The sentence per refusal code of the E3 targets (A39 §17.1 to §17.4). */
export const BANK_TARGET_REFUSALS: Readonly<Record<string, BankTargetSentence>> = {
  needs_anzahlung_account: {
    en: 'The prepayment account is not in your chart. Create it, or name another account in the settings.',
    'de-CH': 'Das Anzahlungskonto gibt es in deinem Kontenplan nicht. Lege es an oder wähle in den Einstellungen ein anderes Konto.',
  },
  invalid_anzahlung_account: {
    en: 'This account cannot hold a prepayment: one from a customer needs a liability account, one to a supplier an asset account.',
    'de-CH': 'Auf diesem Konto kann keine Anzahlung stehen: Die eines Kunden braucht ein Passivkonto, die an einen Lieferanten ein Aktivkonto.',
  },
  contact_archived: {
    en: 'This contact is archived. Restore it first, or book to another contact.',
    'de-CH': 'Dieser Kontakt ist archiviert. Hole ihn zuerst zurück oder buche auf einen anderen Kontakt.',
  },
  counterparty_merged: {
    en: 'This contact was merged into another one. Book to the contact that remains.',
    'de-CH': 'Dieser Kontakt wurde mit einem anderen zusammengeführt. Buche auf den Kontakt, der bleibt.',
  },
  reason_required: {
    en: 'A booking that differs from the workspace setting needs a reason.',
    'de-CH': 'Weicht eine Buchung von der Einstellung ab, braucht sie einen Grund.',
  },
  allocation_contact_mismatch: {
    en: 'All documents settled by one bank line belong to one contact.',
    'de-CH': 'Alle Belege, die eine Bankzeile begleicht, gehören zu einem Kontakt.',
  },
  allocation_exceeds_open: {
    en: 'More is allocated to this document than it still asks.',
    'de-CH': 'Diesem Beleg ist mehr zugeordnet, als noch offen ist.',
  },
  allocations_exceed_line: {
    en: 'The allocations add up to more than the bank line moved.',
    'de-CH': 'Die Zuordnungen ergeben mehr, als die Bankzeile bewegt hat.',
  },
  deviation_needs_remainder: {
    en: 'Part of the amount is not allocated. Allocate it, or keep it as the contact\'s credit (Guthaben).',
    'de-CH': 'Ein Teil des Betrags ist nicht zugeordnet. Ordne ihn zu oder behalte ihn als Guthaben des Kontakts.',
  },
  wrong_direction: {
    en: 'Money in settles invoices, money out settles vendor bills and expense claims.',
    'de-CH': 'Ein Zahlungseingang begleicht Rechnungen, ein Zahlungsausgang Lieferantenrechnungen und Spesen.',
  },
  claim_not_approved: {
    en: 'Only approved expense claims can be paid from a bank line.',
    'de-CH': 'Nur genehmigte Spesen lassen sich mit einer Bankzeile bezahlen.',
  },
  amount_mismatch: {
    en: 'The expense claims add up to another amount than the bank line.',
    'de-CH': 'Die Spesen ergeben einen anderen Betrag als die Bankzeile.',
  },
  fx_leg_vat_refused: {
    en: 'No VAT is booked on a foreign-currency amount here: book the Swiss VAT from the supplier\'s invoice as a journal entry.',
    'de-CH': 'Auf einen Betrag in Fremdwährung bucht TILL hier keine MWST: Buche die Schweizer MWST aus der Rechnung des Lieferanten im Journal.',
  },
  fx_leg_needs_base_line: {
    en: 'A counter-leg in another currency is only possible on a bank line in your book\'s currency.',
    'de-CH': 'Eine Gegenposition in einer anderen Währung geht nur bei einer Bankzeile in der Buchungswährung.',
  },
  fx_currency_mismatch: {
    en: 'All foreign-currency positions of one booking share one currency, other than your book\'s.',
    'de-CH': 'Alle Positionen in Fremdwährung einer Buchung haben dieselbe Währung, eine andere als die Buchungswährung.',
  },
  invalid_fx_leg_account: {
    en: 'A counter-leg in another currency books an income or expense account, never a balance-sheet account.',
    'de-CH': 'Eine Gegenposition in Fremdwährung geht auf ein Ertrags- oder Aufwandkonto, nie auf ein Bilanzkonto.',
  },
  fx_leg_amounts_inconsistent: {
    en: 'The CHF and the foreign amounts do not give one rate for every position. Use the amounts the rate gives.',
    'de-CH': 'Die Beträge in CHF und in der Fremdwährung ergeben nicht für jede Position denselben Kurs. Nimm die Beträge, die der Kurs ergibt.',
  },
  /**
   * Not a code of its own: the sentence of `unsupported` with `reason: 'foreign_currency_settlement'`.
   * A14 books a payment in the base currency, so a Guthaben or a settlement from a Bankkonto in another
   * currency would leave the account's ledger in francs; booked as an Anzahlung or to accounts it books
   * in the account's own currency.
   */
  foreign_currency_settlement: {
    en: 'A payment on a bank account in another currency cannot settle open items or become a Guthaben here: book it as an Anzahlung or to accounts.',
    'de-CH': 'Eine Zahlung auf einem Bankkonto in einer anderen Währung kann hier keine offenen Posten begleichen und kein Guthaben werden: Buche sie als Anzahlung oder auf Konten.',
  },
  fx_ack_required: {
    en: 'Books the counter-leg in the card\'s currency at the rate the bank applied. Confirm this to book it.',
    'de-CH': 'Bucht die Gegenposition in der Kartenwährung zum Kurs der Bank. Bestätige das, um zu buchen.',
  },
};

/** The codes of every consequence an E3 preview may carry. */
export const BANK_TARGET_CONSEQUENCE_CODES = ['fx_counter_leg'] as const;
export type BankTargetConsequenceCode = (typeof BANK_TARGET_CONSEQUENCE_CODES)[number];

/** A consequence as a preview carries it: the catalogue's shape plus the code the booking acknowledges. */
export type BankTargetConsequence = Consequence & { readonly code: BankTargetConsequenceCode };

/**
 * D178 point 3 (A39 §17.4): booking a counter-leg in the transaction currency at the effective rate. The
 * act is `correctable`: the line is taken back with `reopen_bank_line`, which reverses both entries.
 */
export const FX_COUNTER_LEG_CONSEQUENCE: BankTargetConsequence = {
  code: 'fx_counter_leg',
  en: "Books the counter-leg in the card's currency at the rate the bank applied, so it matches the bank exactly. If it is wrong, take the line back; both entries are reversed.",
  'de-CH': 'Bucht die Gegenposition in der Kartenwährung zum Kurs der Bank, damit sie genau zur Bank passt. Ist es falsch, holst du die Zeile zurück; beide Buchungen werden storniert.',
  reversibility: 'correctable',
};

/** A refusal of the E3 targets: the stable code, its params and its sentence (when the catalogue has one). */
export function bankTargetRefusal(code: string, params: Record<string, unknown> = {}): Err {
  const sentence = BANK_TARGET_REFUSALS[code];
  return err(code, { ...params, ...(sentence !== undefined ? { sentence } : {}) });
}

/**
 * D178 E3: `unsupported` for an A14 settlement (a Guthaben, several documents) from a Bankkonto that is
 * not in the base currency. A14 books a payment in the base currency, so its bank leg could never carry
 * the line's own amount; refused by name before anything is written, with the two paths that do work.
 */
export function foreignCurrencySettlementRefusal(params: Record<string, unknown>): Err {
  return err('unsupported', { ...params, reason: 'foreign_currency_settlement', sentence: BANK_TARGET_REFUSALS['foreign_currency_settlement'] });
}
