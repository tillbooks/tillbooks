/**
 * G05 §10, the built-in default Textbausteine: one subject and body per document kind and locale.
 *
 * A LEAF ON PURPOSE. It imports nothing, so the Studio's Versand editor can load the SAME literal
 * the engine falls back to (the editor prefills it as an editable value, D152 rule 1) without a
 * hand-mirrored copy and without pulling the SQLite-backed `dispatch.ts` into the browser bundle
 * (`test/style/studio-sees-payloads.test.mjs`). `dispatch.ts` resolves through `dispatchDefaultText`
 * below, so the fallback the engine sends and the text the editor shows cannot drift.
 */

/** One built-in text: the subject and body templates, `{{variable}}` tokens unresolved. */
export interface DispatchDefaultText {
  subject: string;
  body: string;
}

/**
 * The built-in default text per kind and locale (P9: a send never fails for lack of a saved text,
 * and the log then carries `dispatch_text_defaulted:true`). Plain business prose, real umlauts,
 * no sharp-s (de-CH has none). Every variable named here is in the kind's registry
 * (`DISPATCH_VARIABLES` in `dispatch.ts`).
 */
export const DISPATCH_DEFAULT_TEXTS: Readonly<Record<string, Readonly<Record<string, DispatchDefaultText>>>> =
  Object.freeze({
    invoice: Object.freeze({
      'de-CH': {
        subject: 'Rechnung {{invoice_number}} von {{company_name}}',
        body: 'Guten Tag {{contact_name}}\n\nIm Anhang finden Sie die Rechnung {{invoice_number}} über {{amount_total}}, zahlbar bis {{due_date}}.\n\nFreundliche Grüsse\n{{company_name}}',
      },
      'fr-CH': {
        subject: 'Facture {{invoice_number}} de {{company_name}}',
        body: 'Bonjour {{contact_name}}\n\nVous trouverez en annexe la facture {{invoice_number}} de {{amount_total}}, payable au {{due_date}}.\n\nMeilleures salutations\n{{company_name}}',
      },
      'it-CH': {
        subject: 'Fattura {{invoice_number}} da {{company_name}}',
        body: 'Buongiorno {{contact_name}}\n\nIn allegato trova la fattura {{invoice_number}} di {{amount_total}}, pagabile entro il {{due_date}}.\n\nCordiali saluti\n{{company_name}}',
      },
      en: {
        subject: 'Invoice {{invoice_number}} from {{company_name}}',
        body: 'Dear {{contact_name}}\n\nPlease find attached invoice {{invoice_number}} for {{amount_total}}, due by {{due_date}}.\n\nKind regards\n{{company_name}}',
      },
    }),
    quote: Object.freeze({
      'de-CH': {
        subject: 'Offerte {{quote_number}} von {{company_name}}',
        body: 'Guten Tag {{contact_name}}\n\nIm Anhang finden Sie unsere Offerte {{quote_number}} über {{amount_total}}, gültig bis {{valid_until}}.\n\nFreundliche Grüsse\n{{company_name}}',
      },
      'fr-CH': {
        subject: 'Offre {{quote_number}} de {{company_name}}',
        body: 'Bonjour {{contact_name}}\n\nVous trouverez en annexe notre offre {{quote_number}} de {{amount_total}}, valable jusqu’au {{valid_until}}.\n\nMeilleures salutations\n{{company_name}}',
      },
      'it-CH': {
        subject: 'Offerta {{quote_number}} da {{company_name}}',
        body: 'Buongiorno {{contact_name}}\n\nIn allegato trova la nostra offerta {{quote_number}} di {{amount_total}}, valida fino al {{valid_until}}.\n\nCordiali saluti\n{{company_name}}',
      },
      en: {
        subject: 'Quote {{quote_number}} from {{company_name}}',
        body: 'Dear {{contact_name}}\n\nPlease find attached our quote {{quote_number}} for {{amount_total}}, valid until {{valid_until}}.\n\nKind regards\n{{company_name}}',
      },
    }),
    dunning_run: Object.freeze({
      'de-CH': {
        subject: 'Zahlungserinnerung von {{company_name}}',
        body: 'Guten Tag {{contact_name}}\n\nZu den Rechnungen {{invoice_numbers}} sind {{overdue_total}} offen (Mahnstufe {{dunning_level}}, Stand {{run_date}}). Details finden Sie im Anhang.\n\nFreundliche Grüsse\n{{company_name}}',
      },
      'fr-CH': {
        subject: 'Rappel de paiement de {{company_name}}',
        body: 'Bonjour {{contact_name}}\n\nPour les factures {{invoice_numbers}}, un montant de {{overdue_total}} reste ouvert (niveau de rappel {{dunning_level}}, au {{run_date}}). Vous trouverez les détails en annexe.\n\nMeilleures salutations\n{{company_name}}',
      },
      'it-CH': {
        subject: 'Sollecito di pagamento da {{company_name}}',
        body: 'Buongiorno {{contact_name}}\n\nPer le fatture {{invoice_numbers}} risulta aperto un importo di {{overdue_total}} (livello di sollecito {{dunning_level}}, al {{run_date}}). I dettagli sono in allegato.\n\nCordiali saluti\n{{company_name}}',
      },
      en: {
        subject: 'Payment reminder from {{company_name}}',
        body: 'Dear {{contact_name}}\n\n{{overdue_total}} is outstanding on invoices {{invoice_numbers}} (reminder level {{dunning_level}}, as of {{run_date}}). Details are attached.\n\nKind regards\n{{company_name}}',
      },
    }),
  });

/**
 * The built-in text for one slot: an unknown kind falls back to the invoice text and an unknown
 * locale to de-CH, exactly the fallback `resolveDispatchText` has always applied.
 */
export function dispatchDefaultText(documentKind: string, locale: string): DispatchDefaultText {
  const defaults = DISPATCH_DEFAULT_TEXTS[documentKind] ?? DISPATCH_DEFAULT_TEXTS['invoice']!;
  return defaults[locale] ?? defaults['de-CH']!;
}
