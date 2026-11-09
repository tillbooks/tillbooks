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
      en: 'Where a bank line\'s details open: automatically, on the right, or at the bottom.',
      'de-CH': 'Wo die Details einer Bankzeile aufgehen: automatisch, rechts oder unten.',
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
      en: 'Up to this many open lines the details open at the bottom, with more on the right.',
      'de-CH': 'Bis zu so vielen offenen Zeilen gehen die Details unten auf, bei mehr rechts.',
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
      en: 'The width of the details on the right. Dragging the divider changes it.',
      'de-CH': 'Die Breite der Details rechts. Ziehst du an der Trennlinie, ändert sie sich.',
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
      en: 'The height of the details at the bottom. Dragging the divider changes it.',
      'de-CH': 'Die Höhe der Details unten. Ziehst du an der Trennlinie, ändert sie sich.',
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
      en: 'Focus shows one line after the other, Tabs the booking kinds as tabs, One field one search over everything.',
      'de-CH': 'Fokus zeigt eine Zeile nach der anderen, Reiter die Buchungsarten als Reiter, Ein Feld eine Suche über alles.',
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
      en: 'While you book, show only the current line, without the list beside it.',
      'de-CH': 'Beim Buchen nur die aktuelle Zeile zeigen, ohne die Liste daneben.',
    },
  },
];
