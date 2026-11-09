/**
 * D188 (A39 §21.1): the default of `bank.fee_texts`, in a LEAF module (it imports nothing), so the settings
 * registry can name it without an import cycle (the `hausbuch/sections.ts` precedent).
 *
 * A CLOSED LIST of whole-text patterns (re-cut after critic r2): a line's text must match one of them from
 * its first to its last character (case and spacing folded, both umlaut spellings, a final full stop
 * ignored). `<bank>` stands for the bank's short name, `<card>` for a masked card number, which every
 * card-fee pattern requires. No prefix and no suffix matching: "Kontoführung Juli" or "Preis für
 * Konzertkarte" is no fee key. Extend the list for another bank's exact wording.
 */

/** The default `bank.fee_texts`: whole-text patterns, separated by `;`. */
export const BANK_FEE_TEXTS_DEFAULT = [
  'Account maintenance',
  'Account maintenance fee',
  'Kontoführung',
  'Kontoführungsgebühr',
  'Frais de tenue de compte',
  'Fee for <bank> Visa Debit Card no. <card>',
  'Fee for <bank> Debit Card no. <card>',
  'Annual fee <bank> Visa Debit Card no. <card>',
  'Gebühr für <bank> Visa Debit Karte Nr. <card>',
  'Gebühr für <bank> Debitkarte Nr. <card>',
  'Jahresgebühr <bank> Debitkarte Nr. <card>',
  'Frais pour <bank> carte de débit Visa no <card>',
].join('; ');
