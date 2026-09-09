/**
 * The bexio extraction guide (US-G19.1), seeded from `docs/planning/bexio-to-till/
 * PHASE1-bexio-export-checklist.md`: all 16 export rows plus the 4 module-confirmation questions
 * (fixed assets, inventory, payroll, multi-currency) as guide prompts. A seed-coverage test diffs
 * the ids against a fixture list so the seed cannot silently shrink (spec §7).
 *
 * CLEAN-ROOM: the menu paths below are FUNCTIONAL FACTS recorded from bexio's published help docs
 * (help.bexio.com) and functional observation of the owner's own account, never vendor UI copy,
 * trade dress or source. bexio's plan may label a screen slightly differently or hide a module the
 * customer does not subscribe to, which is exactly what the module questions confirm.
 *
 * THE DELETION CLOCK is a CONTRACT FACT carried as data TO VERIFY, never asserted as law: bexio's
 * published figure is 30 days after subscription end, entered by the operator from their own
 * contract and checked against the live AGB (US-G19.3).
 *
 * BELEGE (row 15) is the documented rung-3/4 case: bexio has no bulk Beleg export, so the item names
 * the browser companion (US-G19.4) as the tactic and renders GATED until the companion's three gates
 * clear (owner acceptance, the Swiss attorney reading of bexio's live AGB, the credential-free UX
 * review). `companionGateClearedRef` is absent, so `hasCompanion` is provably false (spec §7).
 */

import type { ExtractionGuide } from './types.js';
import { DATENHERAUSGABE_LETTER } from './letter.js';

export const BEXIO_GUIDE: ExtractionGuide = {
  sourceSystem: 'bexio',
  label: 'bexio',
  // A contract fact carried as a default TO VERIFY, never a legal conclusion (US-G19.3).
  deletionClock: {
    days: 30,
    trigger: 'Ende des bexio-Abonnements',
    verifyAgainst: 'deinem bexio-Vertrag und den aktuellen AGB',
  },
  letterTemplate: DATENHERAUSGABE_LETTER,
  // companionGateClearedRef DELIBERATELY ABSent: no @tillbooks/extract-bexio has cleared its gates,
  // so hasCompanion is false and the Belege item renders as "vorgesehen, noch nicht verfügbar".
  cleanRoomSource: [
    'https://help.bexio.com/s/article/000001598?language=de',
    'https://www.bexio.com/de-CH/agb',
  ],
  items: [
    // --- A. Master data (all commit-wired in TILL today) ----------------------------------------
    {
      id: 'contacts',
      what: 'Kontakte (Kunden und Lieferanten)',
      sourceArea: 'Kontakte -> Export',
      formats: ['CSV', 'Excel'],
      dataClasses: ['contacts'],
      rung: 1,
      quirks: ['Prüfen, ob UIDs vorhanden sind und wie viele Kontakte Kunden bzw. Lieferanten sind.'],
      statutory: false,
    },
    {
      id: 'chart_of_accounts',
      what: 'Kontenplan',
      sourceArea: 'Buchhaltung -> Kontenplan -> Export',
      formats: ['CSV', 'Excel'],
      dataClasses: ['chart_of_accounts'],
      rung: 1,
      quirks: ['Kontenzahl und Nummerierungsschema notieren (ob es der KMU-Kontenrahmen ist).'],
      statutory: false,
    },
    {
      id: 'items',
      what: 'Artikel und Produkte',
      sourceArea: 'Artikel/Produkte -> Export',
      formats: ['CSV', 'Excel'],
      dataClasses: ['items'],
      rung: 1,
      quirks: ['Prüfen, ob Preise und MWST-Codes am Artikel hängen.'],
      statutory: false,
    },
    {
      id: 'tax_codes',
      what: 'MWST-Codes / Steuer-Codes',
      sourceArea: 'Einstellungen -> MWST / Steuern',
      formats: ['CSV', 'Screenshot'],
      dataClasses: ['tax_codes'],
      rung: 1,
      quirks: ['Der Code-Satz muss zur A05-Steuerzuordnung passen.'],
      statutory: false,
    },
    {
      id: 'payment_terms',
      what: 'Zahlungskonditionen',
      sourceArea: 'Einstellungen -> Zahlungskonditionen',
      formats: ['CSV', 'Screenshot'],
      dataClasses: ['payment_terms'],
      rung: 1,
      quirks: ['Die tatsächlich verwendeten Konditionen erfassen.'],
      statutory: false,
    },
    {
      id: 'bank_accounts',
      what: 'Bankkonten und IBAN',
      sourceArea: 'Banking / Einstellungen -> Bankkonten',
      formats: ['CSV', 'Excel', 'Liste'],
      dataClasses: ['bank_accounts'],
      rung: 1,
      quirks: ['IBANs und das verknüpfte Buchhaltungskonto erfassen.'],
      statutory: false,
    },
    // --- B. The opening position (A04's single live entry) --------------------------------------
    {
      id: 'opening_balances',
      what: 'Saldenliste / Kontostände per Übernahmestichtag',
      sourceArea: 'Buchhaltung -> Kontenblatt / Saldenliste / Bilanz und Erfolgsrechnung, per Stichtag',
      formats: ['CSV', 'Excel', 'PDF'],
      dataClasses: ['opening_balances'],
      rung: 1,
      quirks: [
        'Das PDF ist die menschlich unterschreibbare Kontrollsumme, auf die die Eröffnungsprüfung (G11) abgleicht.',
        'Das Datum ist entscheidend: es ist der Übernahmestichtag des Plans.',
      ],
      statutory: false,
    },
    // --- C. Open items (offene Posten) ----------------------------------------------------------
    {
      id: 'open_items_ar',
      what: 'Offene Debitorenrechnungen (OP-Liste)',
      sourceArea: 'Verkauf -> Rechnungen, Filter offen, oder Buchhaltung -> OP Debitoren',
      formats: ['CSV', 'Excel'],
      dataClasses: ['open_items_ar'],
      rung: 2,
      quirks: [
        'Zeilenzahl, Total offene Forderungen und Fälligkeitsbuckets erfassen.',
        'Der Berichtsbildschirm wird exportiert, wo keine direkte Ausgabe besteht.',
      ],
      statutory: false,
    },
    {
      id: 'open_items_ap',
      what: 'Offene Lieferantenrechnungen (OP-Liste)',
      sourceArea: 'Einkauf -> Lieferantenrechnungen, Filter offen, oder Buchhaltung -> OP Kreditoren',
      formats: ['CSV', 'Excel'],
      dataClasses: ['open_items_ap'],
      rung: 2,
      quirks: ['Zeilenzahl, Total offene Verbindlichkeiten und Fälligkeitsbuckets erfassen.'],
      statutory: false,
    },
    // --- D. Statutory artefacts that MUST survive (OR 958f, GeBüV, MWSTG) -----------------------
    {
      id: 'vat_returns',
      what: 'Jede eingereichte MWST-Abrechnung (alle eingereichten Perioden)',
      sourceArea: 'Buchhaltung -> MWST -> Abrechnungen',
      formats: ['PDF'],
      dataClasses: ['vat_history'],
      rung: 1,
      quirks: [
        'MWST-Kontinuität und Aufbewahrung: das eingereichte Formular als PDF sichern.',
        'Zeigt die Methode (effektiv vs. Saldosteuersatz) und die letzte eingereichte Periode.',
      ],
      statutory: true,
    },
    {
      id: 'vat_settings',
      what: 'MWST-Methode und Einstellungen',
      sourceArea: 'Einstellungen -> MWST',
      formats: ['Screenshot'],
      dataClasses: ['tax_codes'],
      rung: 1,
      quirks: ['Damit die A05/A07-Konfiguration ab Periode eins exakt ist.'],
      statutory: false,
    },
    {
      id: 'annual_accounts',
      what: 'Letzter Jahresabschluss (Bilanz und Erfolgsrechnung)',
      sourceArea: 'Buchhaltung -> Abschluss / Reports',
      formats: ['PDF'],
      dataClasses: ['gl_history'],
      rung: 1,
      quirks: ['Die letzten unterzeichneten Abschlüsse, archivwürdig.'],
      statutory: true,
    },
    {
      id: 'journal',
      what: 'Vollständiges Journal / Hauptbuch je gewünschtem Jahr',
      sourceArea: 'Buchhaltung -> Buchungen -> Export',
      formats: ['CSV', 'Excel'],
      dataClasses: ['gl_history'],
      rung: 1,
      quirks: ['Speist das schreibgeschützte G13-Archiv. Welche Jahre live vs. Archiv ist eine Phase-3-Entscheidung.'],
      statutory: true,
    },
    {
      id: 'bank_statements',
      what: 'Bankauszüge (camt.053, sonst PDF/CSV)',
      sourceArea: 'Banking -> Auszüge oder das E-Banking der Bank',
      formats: ['camt.053 XML', 'PDF', 'CSV'],
      dataClasses: ['bank_statements'],
      rung: 1,
      quirks: ['A20 liest camt direkt. Optional für den Cutover, nötig für abgestimmte Historie.'],
      statutory: false,
    },
    {
      id: 'belege',
      what: 'Belege / Dokumente zu den Buchungen',
      sourceArea: 'Pro Dokument herunterladen (bexio hat keinen Bulk-Beleg-Export)',
      formats: ['PDF'],
      dataClasses: ['documents'],
      // Rung 3: no bulk Beleg export, so the browser companion pages through the customer's OWN
      // logged-in session. GATED (§3) until the companion's three gates clear; renders as
      // "vorgesehen, noch nicht verfügbar" and never as a working control (US-G19.2/US-G19.4).
      rung: 3,
      quirks: [
        'OR 958f: zehn Jahre Aufbewahrung. Kein Bulk-Export in bexio.',
        'Solange die drei Gates nicht erfüllt sind, ist der Begleiter vorgesehen, aber nicht verfügbar; als letzte Stufe steht der Datenherausgabe-Brief.',
      ],
      statutory: true,
    },
    {
      id: 'number_ranges',
      what: 'Nummernkreise (Belegnummern)',
      sourceArea: 'Einstellungen -> Nummerierung',
      formats: ['Screenshot'],
      dataClasses: ['documents'],
      rung: 1,
      quirks: ['Damit TILL die Rechnungs- und Dokumentnummerierung ohne Kollision weiterführt.'],
      statutory: false,
    },
    // --- E. Module-confirmation questions (US-G19.1): a "no" marks the item not_used --------------
    {
      id: 'module_fixed_assets',
      what: 'Anlagen / Abschreibungen',
      sourceArea: 'Anlagen (falls abonniert)',
      formats: ['CSV', 'Screenshot'],
      dataClasses: ['fixed_assets'],
      rung: 1,
      quirks: ['Falls nicht genutzt: als "nicht verwendet" markieren, dann fällt die Klasse aus dem Nenner.'],
      statutory: false,
      moduleQuestion: 'Führt bexio Abschreibungen für dich, oder macht das dein Treuhänder im Abschluss?',
    },
    {
      id: 'module_inventory',
      what: 'Lager / Bestand',
      sourceArea: 'Lager (falls abonniert)',
      formats: ['CSV', 'Screenshot'],
      dataClasses: ['inventory'],
      rung: 1,
      quirks: ['Falls nicht genutzt: als "nicht verwendet" markieren.'],
      statutory: false,
      moduleQuestion: 'Führst du Bestand in bexio, oder sind die Artikel reine Dienstleistungen?',
    },
    {
      id: 'module_payroll',
      what: 'Lohn (bexio Lohn)',
      sourceArea: 'bexio Lohn (falls abonniert)',
      formats: ['CSV', 'Screenshot'],
      dataClasses: ['payroll'],
      rung: 1,
      quirks: ['Falls ja: A34 wage_journal_post ist die Import-Grenze (TILL führt keinen Lohn).'],
      statutory: false,
      moduleQuestion: 'Läuft der Lohn in bexio?',
    },
    {
      id: 'module_multi_currency',
      what: 'Fremdwährungen',
      sourceArea: 'Konten und Rechnungen in Fremdwährung (falls vorhanden)',
      formats: ['CSV', 'Screenshot'],
      dataClasses: ['opening_balances'],
      rung: 1,
      quirks: ['A22 FX ist gebaut; Fremdwährungen betreffen die Eröffnungsbilanz.'],
      statutory: false,
      moduleQuestion: 'Gibt es Konten oder Rechnungen in Fremdwährung?',
    },
  ],
};
