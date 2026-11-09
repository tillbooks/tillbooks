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
export const OVERVIEW_WIDGET_IDS = ['expense_donut', 'money_in_out', 'open_creditors', 'open_tasks', 'cash_flow', 'expense_bars', 'revenue_months', 'balance_history'] as const;

export type OverviewWidgetId = (typeof OVERVIEW_WIDGET_IDS)[number];

/** Every key-figure id `overview.tiles` may arrange: the registry's tiles and the bank item (D180). */
export const OVERVIEW_TILE_IDS = DASHBOARD_TILES;

export type OverviewTileId = (typeof OVERVIEW_TILE_IDS)[number];

/**
 * D186: the key figures that start hidden (the owner's pick of 09.11.2026). A person turns any of them on
 * under Anpassen, an agent through `overview.tiles`; a list that names a tile decides for it.
 */
export const OVERVIEW_TILES_OFF_BY_DEFAULT: readonly OverviewTileId[] = ['cash', 'margin', 'revenue_ltm', 'dso', 'top_customer'];

/** D186: the key figures that start double width. */
export const OVERVIEW_TILES_DOUBLE_BY_DEFAULT: readonly OverviewTileId[] = ['bank_balance'];

/** D186: what a key figure is compared with (`overview.compare`, and per tile in `overview.tiles`). */
export const OVERVIEW_COMPARE_MODES = ['previous_year', 'previous_period', 'none'] as const;

/** Each content's widgets, in their default order. `figures` has none: the key figures are the page. */
export const OVERVIEW_CONTENT_WIDGETS: Readonly<Record<'bexio' | 'trends' | 'figures', readonly OverviewWidgetId[]>> = {
  // D186 (owner, 09.11.2026): Umsatz und Aufwand pro Monat and the Kontostand join the standard set.
  bexio: ['revenue_months', 'balance_history', 'expense_donut', 'money_in_out', 'open_creditors', 'open_tasks'],
  trends: ['revenue_months', 'balance_history', 'cash_flow', 'expense_bars'],
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
    // D186: an entry is `{ id, on, w?: 'double', compare?, trend? }` over every tile, so the list is longer.
    schema: { type: 'json', root: 'array', maxBytes: 4096 },
    default: [],
    scope: 'person',
    area: OVERVIEW,
    label: { en: 'Overview key figures', 'de-CH': 'Kennzahlen der Übersicht' },
    description: {
      en: 'Which key figures the overview shows, in what order, how wide (w: double), what each compares with (compare: previous_year, previous_period or none; absent follows Compare with) and whether it shows its twelve-month line (trend). Empty means the standard. Your role still decides which ones you may see.',
      'de-CH': 'Welche Kennzahlen die Übersicht zeigt, in welcher Reihenfolge, wie breit (w: double), womit jede vergleicht (compare: previous_year, previous_period oder none; fehlt es, gilt «Vergleichen mit») und ob sie ihren Verlauf über zwölf Monate zeigt (trend). Leer heisst: der Standard. Welche du sehen darfst, entscheidet weiterhin deine Rolle.',
    },
  },
  {
    key: 'overview.compare',
    schema: { type: 'enum', values: [...OVERVIEW_COMPARE_MODES] },
    default: 'previous_year',
    scope: 'person',
    area: OVERVIEW,
    label: { en: 'Compare with', 'de-CH': 'Vergleichen mit' },
    description: {
      en: 'What the key figures are compared with, always up to the same day: the previous year (default), the previous period, or nothing. A key figure can choose its own under Anpassen.',
      'de-CH': 'Womit die Kennzahlen verglichen werden, immer bis zum gleichen Tag: mit dem Vorjahr (Standard), der Vorperiode oder gar nicht. Eine Kennzahl kann unter Anpassen ihren eigenen Vergleich wählen.',
    },
    valueLabels: {
      previous_year: { en: 'Previous year', 'de-CH': 'Vorjahr' },
      previous_period: { en: 'Previous period', 'de-CH': 'Vorperiode' },
      none: { en: 'No comparison', 'de-CH': 'Kein Vergleich' },
    },
  },
  {
    key: 'overview.compare_cut',
    schema: { type: 'enum', values: ['same_day', 'whole_period'] },
    default: 'same_day',
    scope: 'person',
    area: OVERVIEW,
    label: { en: 'Compare a running period', 'de-CH': 'Laufende Periode vergleichen' },
    description: {
      en: 'Up to the same day (default): the 1st to the 9th against the 1st to the 9th. Whole period: the running period against the whole earlier one.',
      'de-CH': 'Bis zum gleichen Tag (Standard): der 1. bis 9. gegen den 1. bis 9. Ganze Periode: die laufende Periode gegen die ganze frühere.',
    },
    valueLabels: {
      same_day: { en: 'Up to the same day', 'de-CH': 'Bis zum gleichen Tag' },
      whole_period: { en: 'Whole period', 'de-CH': 'Ganze Periode' },
    },
  },
  {
    key: 'overview.estimate_basis',
    schema: { type: 'enum', values: ['rules', 'all', 'off'] },
    default: 'rules',
    scope: 'person',
    area: OVERVIEW,
    label: { en: 'Estimated turnover', 'de-CH': 'Geschätzter Umsatz' },
    description: {
      en: 'Which open bank lines the turnover estimate counts. Rules (default): lines a booking rule books, and the sure and learned proposals. All proposals: also the ones to check. Off: no estimate.',
      'de-CH': 'Welche offenen Bankzeilen der geschätzte Umsatz zählt. Regeln (Standard): Zeilen, die eine Buchungsregel bucht, und die sicheren und gelernten Vorschläge. Alle Vorschläge: auch die zum Prüfen. Aus: keine Schätzung.',
    },
    valueLabels: {
      rules: { en: 'Rules', 'de-CH': 'Regeln' },
      all: { en: 'All proposals', 'de-CH': 'Alle Vorschläge' },
      off: { en: 'Off', 'de-CH': 'Aus' },
    },
  },
  {
    key: 'overview.runway_months',
    schema: { type: 'enum', values: ['3', '6', '12'] },
    default: '6',
    scope: 'person',
    area: OVERVIEW,
    label: { en: 'Runway average', 'de-CH': 'Reichweite: Schnitt über' },
    description: {
      en: 'How many whole months the runway averages the expense over.',
      'de-CH': 'Über wie viele ganze Monate die Reichweite den Aufwand mittelt.',
    },
    valueLabels: {
      '3': { en: '3 months', 'de-CH': '3 Monate' },
      '6': { en: '6 months', 'de-CH': '6 Monate' },
      '12': { en: '12 months', 'de-CH': '12 Monate' },
    },
  },
  {
    key: 'overview.expense_by',
    schema: { type: 'enum', values: ['account', 'vendor'] },
    default: 'account',
    scope: 'person',
    area: OVERVIEW,
    label: { en: 'Largest expenses by', 'de-CH': 'Grösste Aufwände nach' },
    description: {
      en: 'Whether the largest-expenses cards group by expense account (default) or by vendor.',
      'de-CH': 'Ob die Karten der grössten Aufwände nach Aufwandkonto (Standard) oder nach Lieferant gruppieren.',
    },
    valueLabels: {
      account: { en: 'Account', 'de-CH': 'Konto' },
      vendor: { en: 'Vendor', 'de-CH': 'Lieferant' },
    },
  },
];
