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
];
