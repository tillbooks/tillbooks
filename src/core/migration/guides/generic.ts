/**
 * The GENERIC extraction guide (US-G19.1 empty state): the source-agnostic export canon a source
 * with no registered guide falls back to, so "no guide" is unreachable (spec §2). It names what
 * every migration needs out of any system, mapped to the tactic ladder's first rungs, with the
 * formal Datenherausgabe letter as the last resort. It carries NO vendor menu paths (there is no
 * vendor), only functional descriptions of the export canon.
 */

import type { ExtractionGuide } from './types.js';
import { DATENHERAUSGABE_LETTER } from './letter.js';

export const GENERIC_GUIDE: ExtractionGuide = {
  sourceSystem: 'generic',
  label: 'Allgemein (unbekanntes Quellsystem)',
  deletionClock: null,
  letterTemplate: DATENHERAUSGABE_LETTER,
  cleanRoomSource: [
    // The canon derives from Swiss statute, not any vendor: OR 958f retention and GeBüV readability.
    'https://www.fedlex.admin.ch/eli/cc/27/317_321_377/de',
    'https://www.fedlex.admin.ch/eli/cc/2002/390/de',
  ],
  items: [
    {
      id: 'master_data',
      what: 'Stammdaten (Kontakte, Kontenplan, Artikel, Steuer-Codes, Zahlungskonditionen, Bankverbindungen)',
      sourceArea: 'Die Export-Funktion des Quellsystems je Liste',
      formats: ['CSV', 'Excel'],
      dataClasses: ['contacts', 'chart_of_accounts', 'items', 'tax_codes', 'payment_terms', 'bank_accounts'],
      rung: 1,
      quirks: ['CSV oder Excel bevorzugen: tabellarisch und wieder einlesbar.'],
      statutory: false,
    },
    {
      id: 'trial_balance',
      what: 'Saldenliste und Bilanz per Übernahmestichtag',
      sourceArea: 'Die Auswertungen des Quellsystems, exportiert auf den gewählten Stichtag',
      formats: ['CSV', 'Excel', 'PDF'],
      dataClasses: ['opening_balances'],
      rung: 1,
      quirks: [
        'Das PDF ist die menschlich unterschreibbare Kontrollsumme, auf die die Eröffnungsprüfung (G11) abgleicht.',
      ],
      statutory: false,
    },
    {
      id: 'open_items',
      what: 'Offene Posten Debitoren und Kreditoren auf Belegebene',
      sourceArea: 'Die OP-Listen des Quellsystems (Bericht), gefiltert auf offen',
      formats: ['CSV', 'Excel'],
      dataClasses: ['open_items_ar', 'open_items_ap'],
      rung: 2,
      quirks: ['Wo keine direkte Ausgabe besteht, den Berichtsbildschirm exportieren.'],
      statutory: false,
    },
    {
      id: 'statutory_bundle',
      what: 'Gesetzlicher Bund: eingereichte MWST-Abrechnungen, letzter Jahresabschluss, Journal, Belege',
      sourceArea: 'Die Buchhaltungs- und Abschluss-Auswertungen des Quellsystems',
      formats: ['PDF', 'CSV'],
      dataClasses: ['vat_history', 'gl_history', 'documents'],
      rung: 1,
      quirks: [
        'Aufbewahrungspflicht OR 958f (zehn Jahre): das Original-PDF eingereichter Formulare sichern.',
        'Wo ein Bulk-Export der Belege fehlt, greift die Belege-Taktik der quellenspezifischen Anleitung.',
      ],
      statutory: true,
    },
    {
      id: 'number_ranges',
      what: 'Nummernkreise (Belegnummern), damit die Nummerierung ohne Kollision weiterläuft',
      sourceArea: 'Die Nummerierungs-Einstellungen des Quellsystems',
      formats: ['Screenshot', 'Liste'],
      dataClasses: ['documents'],
      rung: 1,
      quirks: ['Meist keine Export-Funktion: die Werte notieren oder als Screenshot sichern.'],
      statutory: false,
    },
  ],
};
