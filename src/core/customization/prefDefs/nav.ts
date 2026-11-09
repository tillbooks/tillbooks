/**
 * D178 points 6, 7 and 15 to 17, the NAV area: how the Studio's left rail looks and is arranged for one
 * person.
 *
 * Three LOOKS are `person` scope, the same in every workspace (a Treuhänder who switches mandates keeps
 * them): how a favourite is drawn, which row lights when a pinned page is open, and how a group header
 * is set. Each default is the owner's pick on the "TILL D178 Defaults" picker; every alternative on that
 * picker is a value here (D178's rule: every option presented is a setting).
 *
 * Five STATE preferences are `workspace` scope, one value per person per workspace (G00 §10.3): the
 * pinned favourites, the explicit expand/collapse overrides, the two folded sections, the personal menu
 * order and the rail's width. They lived in the browser until D178 (`till-nav-*` in `localStorage`); the
 * Studio moves them here once with `importLegacyPref`. Their shape is validated by the Studio against the
 * surface catalog on every read (an unknown id is dropped, a new surface is re-homed), because the engine
 * does not know the Studio's catalog; the engine bounds them by root and size.
 */

import type { PrefArea, PrefDef } from './types.js';

const NAV: PrefArea = { id: 'nav', label: { en: 'Menu', 'de-CH': 'Menü' } };

export const NAV_PREFS: readonly PrefDef[] = [
  {
    key: 'nav.favourite_style',
    schema: { type: 'enum', values: ['icon_star', 'star_only', 'icon_only'] },
    default: 'icon_star',
    scope: 'person',
    area: NAV,
    label: { en: 'Favourites in the menu', 'de-CH': 'Favoriten im Menü' },
    description: {
      en: 'How pinned pages look at the top of the menu.',
      'de-CH': 'Wie angeheftete Seiten oben im Menü aussehen.',
    },
    valueLabels: {
      icon_star: { en: 'Icon and star', 'de-CH': 'Symbol und Stern' },
      star_only: { en: 'Star instead of the icon', 'de-CH': 'Stern statt Symbol' },
      icon_only: { en: 'Icon only', 'de-CH': 'Nur Symbol' },
    },
  },
  {
    key: 'nav.active_rule',
    schema: { type: 'enum', values: ['favourite', 'tree', 'both_soft'] },
    default: 'favourite',
    scope: 'person',
    area: NAV,
    label: { en: 'Open page in the menu', 'de-CH': 'Offene Seite im Menü' },
    description: {
      en: 'Which row lights up when the open page is also a favourite.',
      'de-CH': 'Welche Zeile hervorgehoben ist, wenn die offene Seite auch ein Favorit ist.',
    },
    valueLabels: {
      favourite: { en: 'The favourite only', 'de-CH': 'Nur der Favorit' },
      tree: { en: 'The menu row only', 'de-CH': 'Nur die Menüzeile' },
      both_soft: { en: 'Both, the menu row softer', 'de-CH': 'Beide, Menüzeile dezent' },
    },
  },
  {
    key: 'nav.group_header_style',
    schema: { type: 'enum', values: ['text_14_bold', 'icon_14', 'label_12'] },
    default: 'text_14_bold',
    scope: 'person',
    area: NAV,
    label: { en: 'Group names in the menu', 'de-CH': 'Gruppennamen im Menü' },
    description: {
      en: 'How the headings of the menu groups look.',
      'de-CH': 'Wie die Überschriften der Menügruppen aussehen.',
    },
    valueLabels: {
      text_14_bold: { en: 'Semibold, no icon', 'de-CH': 'Halbfett, ohne Symbol' },
      icon_14: { en: 'With an icon', 'de-CH': 'Mit Symbol' },
      label_12: { en: 'Small grey label', 'de-CH': 'Klein und grau' },
    },
  },
  {
    key: 'nav.favourites',
    schema: { type: 'json', root: 'array', maxBytes: 8192 },
    default: [],
    scope: 'workspace',
    area: NAV,
    label: { en: 'Favourites', 'de-CH': 'Favoriten' },
    description: {
      en: 'The pages you pinned at the top of the menu.',
      'de-CH': 'Die Seiten, die du oben im Menü angeheftet hast.',
    },
  },
  {
    key: 'nav.expanded',
    schema: { type: 'json', root: 'object', maxBytes: 4096 },
    default: {},
    scope: 'workspace',
    area: NAV,
    label: { en: 'Open groups', 'de-CH': 'Offene Gruppen' },
    description: {
      en: 'Which menu groups are open. All others start closed.',
      'de-CH': 'Welche Menügruppen offen sind. Alle anderen starten zu.',
    },
  },
  {
    key: 'nav.sections',
    schema: { type: 'json', root: 'object', maxBytes: 256 },
    default: {},
    scope: 'workspace',
    area: NAV,
    label: { en: 'Folded sections', 'de-CH': 'Eingeklappte Bereiche' },
    description: {
      en: 'Whether the favourites or the menu are folded.',
      'de-CH': 'Ob Favoriten oder Menü eingeklappt sind.',
    },
  },
  {
    key: 'nav.menu_layout',
    schema: { type: 'json', root: 'object', maxBytes: 8192 },
    default: {},
    scope: 'workspace',
    area: NAV,
    label: { en: 'Menu order', 'de-CH': 'Menüreihenfolge' },
    description: {
      en: 'Your order in the menu and the pages you hid. Hidden pages are still in the search.',
      'de-CH': 'Deine Reihenfolge im Menü und die Seiten, die du ausgeblendet hast. Ausgeblendetes findest du weiter über die Suche.',
    },
  },
  {
    key: 'nav.rail',
    schema: { type: 'json', root: 'object', maxBytes: 256 },
    default: { width: 240, collapsed: false },
    scope: 'workspace',
    area: NAV,
    label: { en: 'Menu width', 'de-CH': 'Menübreite' },
    description: {
      en: 'How wide the menu is, or icons only.',
      'de-CH': 'Wie breit das Menü ist, oder nur Symbole.',
    },
  },
];
