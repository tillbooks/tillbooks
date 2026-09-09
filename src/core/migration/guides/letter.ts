/**
 * The Datenherausgabe (data-handover request) letter template, shipped as data (US-G19.5).
 *
 * The last rung of the tactic ladder: a formal letter the operator downloads, completes and SENDS
 * THEMSELVES (TILL transmits nothing). It requests the undertaking's own records in a
 * machine-readable format and grounds on three levers, stated with their honest limits (the OP6
 * legal-claims rule: state our reading, conclude nothing):
 *   - revDSG Art. 28 (data portability), which covers the Personendaten the requester provided about
 *     themselves, so it is a lever for the personal-data slice (contacts, own account data), not a
 *     complete right to a company's books;
 *   - the CONTRACT (the customer's own data under their subscription);
 *   - OR 958f (their statutory ten-year retention duty needs their records).
 *
 * The `limitsParagraph` on every locale is ASSERTED PRESENT by a test (spec §7): the honest scope of
 * Art. 28 is the OP6 rule in artifact form, and removing it would ship an overclaim.
 *
 * The letter addresses the source PROVIDER (a third party), so it uses the formal register that
 * Swiss business correspondence uses toward a company; the app's own `du` register governs the
 * Studio UI copy, not a legal letter the user sends onward. Placeholders `{company}`, `{address}`
 * and `{source}` are filled by the caller from the A00 profile it already holds (spec §4).
 *
 * de-CH uses real umlauts (ä ö ü) and never `ss` for `ß`: Swiss German has no `ß` at all.
 */

import type { LetterTemplate } from './types.js';

export const DATENHERAUSGABE_LETTER: LetterTemplate = {
  'de-CH': {
    subject: 'Herausgabe unserer Daten und Unterlagen ({company})',
    body: [
      'Sehr geehrte Damen und Herren',
      'Wir, {company}, {address}, wechseln unsere Buchhaltungssoftware. Wir bitten Sie, uns sämtliche Daten und Unterlagen unseres Kontos bei {source} in einem maschinenlesbaren Format (CSV oder Excel für tabellarische Daten, das Original-PDF für eingereichte Belege und Abschlüsse) herauszugeben.',
      'Konkret betrifft dies unsere Stammdaten (Kontakte, Kontenplan, Artikel, Steuer-Codes, Zahlungskonditionen, Bankverbindungen), die Saldenliste und Bilanz per Stichtag, die offenen Posten auf Belegebene, die eingereichten MWST-Abrechnungen und den letzten Jahresabschluss, das vollständige Journal sowie die zu den Buchungen gehörenden Belege.',
      'Wir stützen dieses Begehren auf unseren laufenden Vertrag mit Ihnen (es sind unsere eigenen Daten), auf unsere gesetzliche Aufbewahrungspflicht nach OR 958f (zehn Jahre, die unsere Unterlagen voraussetzt) sowie, für die uns betreffenden Personendaten, auf das Recht auf Datenherausgabe nach Art. 28 revDSG.',
      'Bitte teilen Sie uns mit, bis wann und in welcher Form Sie uns die Daten bereitstellen. Besten Dank für Ihre Unterstützung.',
      'Freundliche Grüsse',
      '{company}',
    ],
    limitsParagraph:
      'Hinweis zum Umfang: Art. 28 revDSG deckt die Personendaten ab, die wir Ihnen über uns selbst bekannt gegeben haben (etwa unsere eigenen Kontakt- und Kontodaten), nicht die gesamte Buchhaltung eines Unternehmens. Für die vollständige Herausgabe der Bücher stützen wir uns daher zusätzlich auf den Vertrag und auf OR 958f. Dieses Schreiben ist eine Vorlage und keine Rechtsberatung.',
  },
  fr: {
    subject: 'Restitution de nos données et documents ({company})',
    body: [
      'Madame, Monsieur,',
      "Nous, {company}, {address}, changeons de logiciel de comptabilité. Nous vous prions de nous restituer l'ensemble des données et documents de notre compte auprès de {source} dans un format lisible par machine (CSV ou Excel pour les données tabulaires, le PDF original pour les pièces et les clôtures déposées).",
      'Cela concerne nos données de base (contacts, plan comptable, articles, codes de TVA, conditions de paiement, comptes bancaires), la balance et le bilan à la date de reprise, les postes ouverts au niveau des pièces, les décomptes TVA déposés et les derniers comptes annuels, le journal complet ainsi que les pièces justificatives liées aux écritures.',
      "Nous fondons cette demande sur notre contrat en cours avec vous (il s'agit de nos propres données), sur notre obligation légale de conservation selon l'art. 958f CO (dix ans, qui suppose nos documents) et, pour les données personnelles nous concernant, sur le droit à la remise des données selon l'art. 28 nLPD.",
      "Merci de nous indiquer d'ici quand et sous quelle forme vous mettrez les données à disposition. Nous vous remercions de votre soutien.",
      'Meilleures salutations',
      '{company}',
    ],
    limitsParagraph:
      "Remarque sur la portée: l'art. 28 nLPD couvre les données personnelles que nous vous avons communiquées à notre sujet (par exemple nos propres coordonnées et données de compte), et non l'ensemble de la comptabilité d'une entreprise. Pour la remise complète des livres, nous nous fondons donc en plus sur le contrat et sur l'art. 958f CO. Ce courrier est un modèle et non un conseil juridique.",
  },
  it: {
    subject: 'Consegna dei nostri dati e documenti ({company})',
    body: [
      'Gentili Signore e Signori,',
      "Noi, {company}, {address}, cambiamo il software di contabilità. Vi preghiamo di consegnarci tutti i dati e i documenti del nostro conto presso {source} in un formato leggibile dalla macchina (CSV o Excel per i dati tabellari, il PDF originale per i giustificativi e le chiusure presentate).",
      "Cio riguarda i nostri dati anagrafici (contatti, piano dei conti, articoli, codici IVA, condizioni di pagamento, conti bancari), il bilancio di verifica e il bilancio alla data di ripresa, le partite aperte a livello di documento, i rendiconti IVA presentati e l'ultimo conto annuale, il giornale completo e i giustificativi collegati alle registrazioni.",
      "Fondiamo questa richiesta sul nostro contratto in corso con voi (si tratta dei nostri stessi dati), sul nostro obbligo legale di conservazione secondo l'art. 958f CO (dieci anni, che presuppone i nostri documenti) e, per i dati personali che ci riguardano, sul diritto alla consegna dei dati secondo l'art. 28 nLPD.",
      'Vi preghiamo di comunicarci entro quando e in quale forma metterete a disposizione i dati. Grazie per il vostro sostegno.',
      'Cordiali saluti',
      '{company}',
    ],
    limitsParagraph:
      "Nota sulla portata: l'art. 28 nLPD copre i dati personali che vi abbiamo comunicato sul nostro conto (ad esempio i nostri recapiti e dati del conto), non l'intera contabilità di un'impresa. Per la consegna completa dei libri ci fondiamo pertanto anche sul contratto e sull'art. 958f CO. Questa lettera e un modello e non una consulenza legale.",
  },
  en: {
    subject: 'Release of our data and records ({company})',
    body: [
      'Dear Sir or Madam,',
      'We, {company}, {address}, are changing our accounting software. We ask you to release to us all data and records of our account with {source} in a machine-readable format (CSV or Excel for tabular data, the original PDF for filed vouchers and financial statements).',
      'This concerns our master data (contacts, chart of accounts, items, tax codes, payment terms, bank accounts), the trial balance and balance sheet at the cut-over date, open items at document level, the filed VAT returns and the last annual accounts, the full journal, and the vouchers attached to the bookings.',
      'We base this request on our ongoing contract with you (this is our own data), on our statutory retention duty under Art. 958f CO (ten years, which presupposes our records), and, for the personal data concerning us, on the right to data portability under Art. 28 revFADP.',
      'Please let us know by when and in what form you will make the data available. Thank you for your support.',
      'Kind regards',
      '{company}',
    ],
    limitsParagraph:
      "Note on scope: Art. 28 revFADP covers the personal data we provided to you about ourselves (for example our own contact and account data), not the whole of a company's bookkeeping. For the complete release of the books we therefore also rely on the contract and on Art. 958f CO. This letter is a template and not legal advice.",
  },
};
