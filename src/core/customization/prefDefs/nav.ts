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
      en: 'How a pinned page looks: its own icon with a star at the right (default), a star in place of the icon, or the icon alone, with the star showing on hover to unpin.',
      'de-CH': 'Wie eine angeheftete Seite aussieht: ihr eigenes Symbol mit einem Stern rechts (Standard), ein Stern statt des Symbols oder nur das Symbol, der Stern erscheint dann beim Darüberfahren zum Lösen.',
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
      en: 'Which row lights up when a pinned page is open: only the favourite (default), only its row in the menu, which then opens to it, or both, the menu row in accent ink without a fill.',
      'de-CH': 'Welche Zeile leuchtet, wenn eine angeheftete Seite offen ist: nur der Favorit (Standard), nur ihre Zeile im Menü, das sich dann dorthin öffnet, oder beide, die Menüzeile dann nur in Akzentschrift ohne Fläche.',
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
      en: 'How Favoriten, Menü and the groups are named: at item size in semibold, without an icon (default), at item size with a group icon, or as the small grey label of earlier versions.',
      'de-CH': 'Wie Favoriten, Menü und die Gruppen beschriftet sind: in Zeilengrösse und halbfett ohne Symbol (Standard), in Zeilengrösse mit einem Gruppensymbol oder als kleine graue Beschriftung wie bisher.',
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
      en: 'The pages you pinned above the menu, in your order, with the names you gave them.',
      'de-CH': 'Die Seiten, die du über dem Menü angeheftet hast, in deiner Reihenfolge und mit deinen Namen.',
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
      en: 'The menu groups you opened or closed yourself. Everything else starts closed.',
      'de-CH': 'Die Menügruppen, die du selbst geöffnet oder geschlossen hast. Alles andere startet zu.',
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
      en: 'Whether you folded Favoriten or Menü away.',
      'de-CH': 'Ob du Favoriten oder Menü eingeklappt hast.',
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
      en: 'Your order of groups and pages, the pages you moved and the ones you hid. Hidden pages stay reachable through the search.',
      'de-CH': 'Deine Reihenfolge der Gruppen und Seiten, verschobene und ausgeblendete Seiten. Ausgeblendete Seiten findest du weiterhin über die Suche.',
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
      en: 'How wide the menu is, and whether it is folded to icons.',
      'de-CH': 'Wie breit das Menü ist und ob es auf Symbole eingeklappt ist.',
    },
  },
];
