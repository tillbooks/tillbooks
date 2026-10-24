/**
 * D178 point 10, the BANK area: where the /bank detail area sits and how big it is, for one person.
 *
 * The owner's pick is the default (`automatic`: decided when the page opens, bottom at the threshold or
 * fewer open lines, right above, never moved while the person works); right and bottom are the
 * alternatives, every one a setting (D178's rule). Dragging the area's header to the other edge, or the
 * dock control in its header, writes `bank.detail_position`; dragging the divider writes the size of the
 * position in force. All `person` scope: a Treuhänder who switches mandates keeps their layout.
 *
 * The sizes are absolute bounds in CSS pixels. The Studio clamps them again to the room the window leaves
 * (the list never shrinks under its own minimum), so a size set on a large screen still opens sensibly on a
 * laptop. Spec: A39 §18.2.
 */

import type { PrefArea, PrefDef } from './types.js';

const BANK: PrefArea = { id: 'bank', label: { en: 'Bank inbox', 'de-CH': 'Bank' } };

export const BANK_PREFS: readonly PrefDef[] = [
  {
    key: 'bank.detail_position',
    schema: { type: 'enum', values: ['automatic', 'right', 'bottom'] },
    default: 'automatic',
    scope: 'person',
    area: BANK,
    label: { en: 'Where the details sit', 'de-CH': 'Wo die Details stehen' },
    description: {
      en: 'Automatic (default) decides when the page opens: at the bottom with few open lines, on the right with more. Right and bottom keep their place.',
      'de-CH': 'Automatisch (Standard) entscheidet beim Öffnen der Seite: unten bei wenigen offenen Zeilen, rechts bei mehr. Rechts und unten bleiben, wo sie sind.',
    },
    valueLabels: {
      automatic: { en: 'Automatic', 'de-CH': 'Automatisch' },
      right: { en: 'Right', 'de-CH': 'Rechts' },
      bottom: { en: 'Bottom', 'de-CH': 'Unten' },
    },
  },
  {
    key: 'bank.detail_auto_threshold',
    schema: { type: 'integer', min: 0, max: 500 },
    default: 8,
    scope: 'person',
    area: BANK,
    label: { en: 'Automatic: bottom up to this many open lines', 'de-CH': 'Automatisch: unten bis so viele offene Zeilen' },
    description: {
      en: 'With this many open lines or fewer (default 8) the details open at the bottom, with more on the right.',
      'de-CH': 'Bei so vielen offenen Zeilen oder weniger (Standard 8) öffnen die Details unten, bei mehr rechts.',
    },
  },
  {
    key: 'bank.detail_width',
    schema: { type: 'integer', min: 320, max: 960 },
    default: 360,
    scope: 'person',
    area: BANK,
    label: { en: 'Width of the details on the right (px)', 'de-CH': 'Breite der Details rechts (px)' },
    description: {
      en: 'Set by dragging the divider beside the details. Default 360.',
      'de-CH': 'Stellst du ein, indem du die Trennlinie neben den Details ziehst. Standard 360.',
    },
  },
  {
    key: 'bank.detail_height',
    schema: { type: 'integer', min: 200, max: 800 },
    default: 320,
    scope: 'person',
    area: BANK,
    label: { en: 'Height of the details at the bottom (px)', 'de-CH': 'Höhe der Details unten (px)' },
    description: {
      en: 'Set by dragging the divider above the details. Default 320.',
      'de-CH': 'Stellst du ein, indem du die Trennlinie über den Details ziehst. Standard 320.',
    },
  },
  // D178 point 9 (N3, A39 §20): how the selected line is booked. The owner's pick is the default.
  {
    key: 'bank.booking_view',
    schema: { type: 'enum', values: ['focus', 'tabs', 'smart'] },
    default: 'focus',
    scope: 'person',
    area: BANK,
    label: { en: 'How a line is booked', 'de-CH': 'Wie eine Zeile gebucht wird' },
    description: {
      en: 'Focus (default): one line at a time, the bank facts beside the booking, then the next line. Tabs: the booking kinds as tabs in the details. One field: one search over accounts, open items, contacts and Spesen.',
      'de-CH': 'Fokus (Standard): eine Zeile nach der anderen, die Bankdaten neben der Buchung, dann die nächste Zeile. Reiter: die Buchungsarten als Reiter in den Details. Ein Feld: eine Suche über Konten, offene Posten, Kontakte und Spesen.',
    },
    valueLabels: {
      focus: { en: 'Focus', 'de-CH': 'Fokus' },
      tabs: { en: 'Tabs', 'de-CH': 'Reiter' },
      smart: { en: 'One field', 'de-CH': 'Ein Feld' },
    },
  },
  {
    key: 'bank.focus_list_hidden',
    schema: { type: 'boolean' },
    default: false,
    scope: 'person',
    area: BANK,
    label: { en: 'Focus: hide the list', 'de-CH': 'Fokus: Liste ausblenden' },
    description: {
      en: 'In the focus view, show only the line being booked, without the list beside it. Off by default.',
      'de-CH': 'In der Fokus-Ansicht nur die Zeile zeigen, die du buchst, ohne die Liste daneben. Standard: aus.',
    },
  },
];
