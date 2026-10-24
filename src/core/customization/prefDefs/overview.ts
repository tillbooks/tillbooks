/**
 * D178 points 12, 13 and 14, the ÜBERSICHT area (and the motion level, which lives in Darstellung).
 *
 * The owner picked on the "TILL D178 Defaults" picker and asked that every alternative ship as a setting
 * (D178: every option presented is a setting). All four are `person` scope: a Treuhänder who switches
 * mandates keeps the home and the motion they chose. The Studio reads them through `usePref`; the engine
 * honours none of them by itself (`dashboard_overview` and `dashboard_series` answer the same figures
 * whatever the person chose), so an agent reads them only to know what the person sees.
 *
 *  - `overview.bank_action` (point 12): where the waiting bank lines show: a tile in the key-figure grid
 *    (default), an action card above the grid, or the slim Bankeingang bar.
 *  - `overview.content` (point 13): the STARTING set of cards under the key figures: bexio-like widgets
 *    (default), key figures with trend lines plus cash flow and top-expense bars, or the key figures
 *    alone. Since D180 it decides only while `overview.widgets` is empty, so it applies at first and
 *    again after Standard wiederherstellen; a card list the person arranged wins over it.
 *  - `overview.widgets`: the person's arrangement of the cards under the key figures, an ordered list of
 *    `{ id, on, w? }` over all six `OVERVIEW_WIDGET_IDS` (D180: one free card library, any card in any
 *    content). Empty (the default) is the chosen content's set; once the list holds an entry, it decides
 *    and the content only fills in a card the list never names. `w: 'full'` spans the card over the whole
 *    row (absent: half). Unknown ids are ignored, so a later build that drops a card never breaks a list.
 *  - `overview.tiles` (D180): the person's arrangement of the key figures, an ordered list of `{ id, on }`
 *    over `DASHBOARD_TILES` (the registry's tiles and the bank item, `bank_inbox`). Empty (the default) is
 *    the registry order. The list only orders and hides: a tile the person's role may not read is omitted
 *    by `dashboard_overview` whatever the list says, so a preference never widens what anyone sees.
 *  - `appearance.motion` (point 14): Lively (default), Standard, Calm, Off. The OS reduce-motion setting
 *    beats every level (brand/DESIGN.md, Motion levels). It sits in the Darstellung area beside the theme
 *    and the density; it is declared here, in the area file of the node that built it, with the
 *    Darstellung area's own label (the registry asserts the two labels agree).
 */

import { DASHBOARD_TILES } from '../../dashboards/tiles.js';
import type { PrefArea, PrefDef } from './types.js';

const OVERVIEW: PrefArea = { id: 'overview', label: { en: 'Overview', 'de-CH': 'Übersicht' } };

/** The Darstellung area, restated with the label `appearance.ts` gives it (asserted equal at load). */
const APPEARANCE: PrefArea = { id: 'appearance', label: { en: 'Appearance', 'de-CH': 'Darstellung' } };

/** Every widget id a content may offer (the Studio's `Uebersicht/widgets.ts` renders each). */
export const OVERVIEW_WIDGET_IDS = ['expense_donut', 'money_in_out', 'open_creditors', 'open_tasks', 'cash_flow', 'expense_bars'] as const;

export type OverviewWidgetId = (typeof OVERVIEW_WIDGET_IDS)[number];

/** Every key-figure id `overview.tiles` may arrange: the registry's tiles and the bank item (D180). */
export const OVERVIEW_TILE_IDS = DASHBOARD_TILES;

export type OverviewTileId = (typeof OVERVIEW_TILE_IDS)[number];

/** Each content's widgets, in their default order. `figures` has none: the key figures are the page. */
export const OVERVIEW_CONTENT_WIDGETS: Readonly<Record<'bexio' | 'trends' | 'figures', readonly OverviewWidgetId[]>> = {
  bexio: ['expense_donut', 'money_in_out', 'open_creditors', 'open_tasks'],
  trends: ['cash_flow', 'expense_bars'],
  figures: [],
};

export const MOTION_PREFS: readonly PrefDef[] = [
  {
    key: 'appearance.motion',
    schema: { type: 'enum', values: ['lively', 'standard', 'calm', 'off'] },
    default: 'lively',
    scope: 'person',
    area: APPEARANCE,
    label: { en: 'Motion', 'de-CH': 'Bewegung' },
    description: {
      en: 'Lively (default): charts grow in, the overview figures count up, tiles lift on hover. Standard: charts grow in briefly. Calm: only the small transitions. Off: nothing moves. Your system setting for reduced motion always wins.',
      'de-CH': 'Lebendig (Standard): Diagramme wachsen ein, die Zahlen der Übersicht zählen hoch, Kacheln heben sich beim Überfahren. Normal: Diagramme wachsen kurz ein. Ruhig: nur die kleinen Übergänge. Aus: nichts bewegt sich. Die Systemeinstellung für weniger Bewegung gilt immer.',
    },
    valueLabels: {
      lively: { en: 'Lively', 'de-CH': 'Lebendig' },
      standard: { en: 'Standard', 'de-CH': 'Normal' },
      calm: { en: 'Calm', 'de-CH': 'Ruhig' },
      off: { en: 'Off', 'de-CH': 'Aus' },
    },
  },
];

export const OVERVIEW_PREFS: readonly PrefDef[] = [
  {
    key: 'overview.bank_action',
    schema: { type: 'enum', values: ['tile', 'card', 'bar'] },
    default: 'tile',
    scope: 'person',
    area: OVERVIEW,
    label: { en: 'Waiting bank lines', 'de-CH': 'Wartende Bankbuchungen' },
    description: {
      en: 'Where the overview shows the bank lines that wait for you: a tile among the key figures (default), a card above them, or a slim bar.',
      'de-CH': 'Wo die Übersicht die Bankbuchungen zeigt, die auf dich warten: als Kachel bei den Kennzahlen (Standard), als Karte darüber oder als schmale Leiste.',
    },
    valueLabels: {
      tile: { en: 'Tile', 'de-CH': 'Kachel' },
      card: { en: 'Card on top', 'de-CH': 'Karte oben' },
      bar: { en: 'Slim bar', 'de-CH': 'Schmale Leiste' },
    },
  },
  {
    key: 'overview.content',
    schema: { type: 'enum', values: ['bexio', 'trends', 'figures'] },
    default: 'bexio',
    scope: 'person',
    area: OVERVIEW,
    label: { en: 'Overview content', 'de-CH': 'Inhalt der Übersicht' },
    description: {
      en: 'The cards the overview starts with. Charts and lists (default): top expenses, money in and out per month, open creditors, open tasks. Trends: key figures with trend lines, cash flow, top expenses as bars. Figures only. Once you arrange the cards on the overview, your arrangement decides; this set applies again after Restore the standard.',
      'de-CH': 'Die Karten, mit denen die Übersicht beginnt. Diagramme und Listen (Standard): grösste Aufwände, Geld rein und raus pro Monat, offene Kreditoren, offene Aufgaben. Verlauf: Kennzahlen mit Verlaufslinie, Geldfluss, grösste Aufwände als Balken. Nur Kennzahlen. Sobald du die Karten auf der Übersicht anordnest, gilt deine Anordnung; nach Standard wiederherstellen gilt wieder diese Auswahl.',
    },
    valueLabels: {
      bexio: { en: 'Charts and lists', 'de-CH': 'Diagramme und Listen' },
      trends: { en: 'Trends', 'de-CH': 'Verlauf' },
      figures: { en: 'Figures only', 'de-CH': 'Nur Kennzahlen' },
    },
  },
  {
    key: 'overview.widgets',
    schema: { type: 'json', root: 'array', maxBytes: 1024 },
    default: [],
    scope: 'person',
    area: OVERVIEW,
    label: { en: 'Overview widgets', 'de-CH': 'Elemente der Übersicht' },
    description: {
      en: 'Which cards the overview shows, in what order and how wide. Empty means the cards of the chosen content.',
      'de-CH': 'Welche Karten die Übersicht zeigt, in welcher Reihenfolge und wie breit. Leer heisst: die Karten des gewählten Inhalts.',
    },
  },
  {
    key: 'overview.tiles',
    schema: { type: 'json', root: 'array', maxBytes: 1024 },
    default: [],
    scope: 'person',
    area: OVERVIEW,
    label: { en: 'Overview key figures', 'de-CH': 'Kennzahlen der Übersicht' },
    description: {
      en: 'Which key figures the overview shows and in what order. Empty means all of them in the standard order. Your role still decides which ones you may see.',
      'de-CH': 'Welche Kennzahlen die Übersicht zeigt und in welcher Reihenfolge. Leer heisst: alle in der Standardreihenfolge. Welche du sehen darfst, entscheidet weiterhin deine Rolle.',
    },
  },
];
