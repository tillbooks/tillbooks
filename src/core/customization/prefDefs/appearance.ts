/**
 * D178 point 7, the APPEARANCE area: how the Studio looks to one person.
 *
 * Both were browser-only until D178 (`till-theme`, `till-density` in `localStorage`), so a second browser
 * or a cleared cache reset them and no agent could read them. Both are `person` scope: a Treuhänder who
 * switches mandates keeps their look. The defaults are the behaviour the Studio already had: the theme
 * follows the operating system until the person picks a side, and the density is Komfortabel.
 */

import type { PrefArea, PrefDef } from './types.js';

const APPEARANCE: PrefArea = { id: 'appearance', label: { en: 'Appearance', 'de-CH': 'Darstellung' } };

export const APPEARANCE_PREFS: readonly PrefDef[] = [
  {
    key: 'appearance.theme',
    schema: { type: 'enum', values: ['light', 'dark', 'system'] },
    default: 'system',
    scope: 'person',
    area: APPEARANCE,
    label: { en: 'Colour scheme', 'de-CH': 'Farbschema' },
    description: {
      en: 'Light, dark, or whatever your device is set to.',
      'de-CH': 'Hell, dunkel oder wie dein Gerät gerade eingestellt ist.',
    },
    valueLabels: {
      light: { en: 'Light', 'de-CH': 'Hell' },
      dark: { en: 'Dark', 'de-CH': 'Dunkel' },
      system: { en: 'Same as system', 'de-CH': 'Wie das System' },
    },
  },
  {
    key: 'appearance.density',
    schema: { type: 'enum', values: ['komfortabel', 'kompakt'] },
    default: 'komfortabel',
    scope: 'person',
    area: APPEARANCE,
    label: { en: 'Density', 'de-CH': 'Dichte' },
    description: {
      en: 'Compact fits more rows on a screen; comfortable gives them more room.',
      'de-CH': 'Kompakt zeigt mehr Zeilen auf einmal, Komfortabel lässt ihnen mehr Luft.',
    },
    valueLabels: {
      komfortabel: { en: 'Comfortable', 'de-CH': 'Komfortabel' },
      kompakt: { en: 'Compact', 'de-CH': 'Kompakt' },
    },
  },
  // D195: how a date reads everywhere in the Studio (`formatDate`) and how the shared DateField parses one.
  {
    key: 'appearance.date_format',
    schema: { type: 'enum', values: ['ch', 'iso', 'us'] },
    default: 'ch',
    scope: 'person',
    area: APPEARANCE,
    label: { en: 'Date format', 'de-CH': 'Datumsformat' },
    description: {
      en: 'How dates are shown and typed: 31.12.2026, 2026-12-31 or 12/31/2026.',
      'de-CH': 'Wie Daten angezeigt und eingegeben werden: 31.12.2026, 2026-12-31 oder 12/31/2026.',
    },
    valueLabels: {
      ch: { en: '31.12.2026', 'de-CH': '31.12.2026' },
      iso: { en: '2026-12-31', 'de-CH': '2026-12-31' },
      us: { en: '12/31/2026', 'de-CH': '12/31/2026' },
    },
  },
  // D195: whether a signed amount (the bank list) carries a plus before money in, or only a minus before money out.
  {
    key: 'appearance.amount_sign',
    schema: { type: 'enum', values: ['plus_minus', 'minus_only'] },
    default: 'plus_minus',
    scope: 'person',
    area: APPEARANCE,
    label: { en: 'Signs on amounts', 'de-CH': 'Vorzeichen bei Beträgen' },
    description: {
      en: 'Plus before money in and minus before money out, or only the minus.',
      'de-CH': 'Plus vor Geld, das reinkommt, und Minus vor Geld, das rausgeht, oder nur das Minus.',
    },
    valueLabels: {
      plus_minus: { en: '+ and −', 'de-CH': '+ und −' },
      minus_only: { en: 'Only −', 'de-CH': 'Nur −' },
    },
  },
];
