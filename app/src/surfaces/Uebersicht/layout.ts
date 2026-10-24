/**
 * D178 points 12 and 13, D180: what the Übersicht shows, read off the person's preferences. Pure, so the
 * arrangement rules are unit-tested as data.
 *
 * The widget and tile ids and each content's default set come from the engine's own preference registry
 * (`src/core/customization/prefDefs/overview.ts`, imported at runtime like every pref default), so the
 * Studio and an agent reading `overview.widgets` or `overview.tiles` agree on the vocabulary by
 * construction.
 *
 * D180 made the cards ONE free library: every one of the six cards is a slot, shown or hidden, in any
 * content. `overview.content` is only the default set an empty list stands for (and the set it fills in
 * for a card a stored list never names), so an old stored list keeps meaning what it meant.
 */
import {
  OVERVIEW_CONTENT_WIDGETS,
  OVERVIEW_TILE_IDS,
  OVERVIEW_WIDGET_IDS,
  type OverviewTileId,
  type OverviewWidgetId,
} from '../../../../src/core/customization/prefDefs/overview.js';

export type OverviewContent = 'bexio' | 'trends' | 'figures';
export type BankActionPlace = 'tile' | 'card' | 'bar';
export type { OverviewTileId, OverviewWidgetId };

/** Anything arranged on the page: an id, and whether it shows. */
export interface Slot<Id extends string = string> {
  id: Id;
  on: boolean;
}

/** A card under the key figures. `w: 'full'` spans the whole row; absent is half. */
export interface WidgetSlot extends Slot<OverviewWidgetId> {
  w?: 'full';
}

/** A key figure (the bank item, `bank_inbox`, among them while it sits in the tile zone). */
export type TileSlot = Slot<OverviewTileId>;

const KNOWN_WIDGETS: ReadonlySet<string> = new Set(OVERVIEW_WIDGET_IDS);
const KNOWN_TILES: ReadonlySet<string> = new Set(OVERVIEW_TILE_IDS);

function widgetOf(raw: unknown): WidgetSlot | null {
  if (raw === null || typeof raw !== 'object') return null;
  const { id, on, w } = raw as { id?: unknown; on?: unknown; w?: unknown };
  if (typeof id !== 'string' || !KNOWN_WIDGETS.has(id)) return null;
  return { id: id as OverviewWidgetId, on: on !== false, ...(w === 'full' ? { w: 'full' as const } : {}) };
}

function tileOf(raw: unknown): TileSlot | null {
  if (raw === null || typeof raw !== 'object') return null;
  const { id, on } = raw as { id?: unknown; on?: unknown };
  return typeof id === 'string' && KNOWN_TILES.has(id) ? { id: id as OverviewTileId, on: on !== false } : null;
}

/** The stored entries a reader understands, each id once, in the stored order. */
function storedSlots<T extends Slot>(stored: unknown, read: (raw: unknown) => T | null): T[] {
  const out: T[] = [];
  if (!Array.isArray(stored)) return out;
  for (const raw of stored) {
    const slot = read(raw);
    if (slot !== null && !out.some((s) => s.id === slot.id)) out.push(slot);
  }
  return out;
}

/**
 * All six cards in the person's order: the stored slots first (each once, any card, D180), then every
 * card of the chosen content the list never names, shown, then every other card, hidden. An empty list is
 * therefore exactly the content's default set, with the rest waiting as hidden slots.
 */
export function arrangement(content: OverviewContent, stored: unknown): WidgetSlot[] {
  const offered = OVERVIEW_CONTENT_WIDGETS[content];
  const out = storedSlots(stored, widgetOf);
  for (const id of offered) if (!out.some((s) => s.id === id)) out.push({ id, on: true });
  for (const id of OVERVIEW_WIDGET_IDS) if (!out.some((s) => s.id === id)) out.push({ id, on: false });
  return out;
}

/** The value to store for the cards: every slot, its width only when it is full. */
export function withSlots(slots: readonly WidgetSlot[]): WidgetSlot[] {
  return slots.map((s) => ({ id: s.id, on: s.on, ...(s.w === 'full' ? { w: 'full' as const } : {}) }));
}

/**
 * The key figures in the person's order, over the tiles this person can see right now (`available`, in
 * the order the read answered): the stored slots of those first, then every available tile the list
 * never names, shown. A stored id that is not available (no right, not set up, unknown) is dropped here,
 * so a preference never widens what the read returned.
 */
export function tileArrangement(stored: unknown, available: readonly string[]): TileSlot[] {
  const can = new Set(available);
  const out = storedSlots(stored, tileOf).filter((s) => can.has(s.id));
  for (const id of available) {
    if (KNOWN_TILES.has(id) && !out.some((s) => s.id === id)) out.push({ id: id as OverviewTileId, on: true });
  }
  return out;
}

/** The value to store for the tiles: the arranged slots, then the stored ones not arranged now, kept. */
export function withTiles(stored: unknown, slots: readonly TileSlot[]): TileSlot[] {
  const rest = storedSlots(stored, tileOf).filter((s) => !slots.some((t) => t.id === s.id));
  return [...slots.map((s) => ({ id: s.id, on: s.on })), ...rest];
}

/** `slots` with the one at `index` moved by `delta` (clamped), a new array. */
export function moveSlot<T>(slots: readonly T[], index: number, delta: number): T[] {
  const next = [...slots];
  const target = Math.max(0, Math.min(next.length - 1, index + delta));
  const [moved] = next.splice(index, 1);
  if (moved !== undefined) next.splice(target, 0, moved);
  return next;
}

/** `slots` with `id` moved into `overId`'s place (a drop), a new array; unchanged for an unknown id. */
export function moveSlotTo<T extends Slot>(slots: readonly T[], id: string, overId: string): T[] {
  const from = slots.findIndex((s) => s.id === id);
  const to = slots.findIndex((s) => s.id === overId);
  if (from < 0 || to < 0) return [...slots];
  return moveSlot(slots, from, to - from);
}

/** `slots` with `id` switched on or off, a new array. */
export function toggleSlot<T extends Slot>(slots: readonly T[], id: string): T[] {
  return slots.map((s) => (s.id === id ? { ...s, on: !s.on } : s));
}

/** The cards with `id` switched between half and full width, a new array. */
export function toggleWidth(slots: readonly WidgetSlot[], id: OverviewWidgetId): WidgetSlot[] {
  return slots.map((s) => {
    if (s.id !== id) return s;
    return s.w === 'full' ? { id: s.id, on: s.on } : { ...s, w: 'full' as const };
  });
}

/** The layout a saved dashboard view carries (D180), read defensively. */
export interface ViewLayout {
  rangePreset?: 'month' | 'quarter' | 'year' | 'custom';
  /** The dates of a `custom` period, when the view stored them. */
  custom?: { from: string; to: string };
  widgets?: WidgetSlot[];
  bankAction?: BankActionPlace;
  /** The whole key-figure arrangement, every tile shown or hidden: replaces the person's. */
  tiles?: TileSlot[];
  /**
   * Only an order (a view saved before D180, or by an agent with `columns` alone): these tiles first,
   * shown, and every tile it does not name left exactly as the person has it (`withTileOrder`).
   */
  tileOrder?: OverviewTileId[];
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * What applying a saved view writes. A D180 view carries the whole layout in `filters`
 * (`{ rangePreset, from?, to?, widgets, bankAction, tiles }`); `columns` (the visible tiles in order)
 * stays for agents. An older view, or one an agent saved with `columns` only, says nothing about the
 * tiles it does not name, so those (the bank item among them) are left as they are rather than
 * hidden. A part the view does not carry is left alone.
 */
export function viewLayout(view: { filters?: unknown; columns?: unknown }): ViewLayout {
  const out: ViewLayout = {};
  const f = view.filters !== null && typeof view.filters === 'object' ? (view.filters as Record<string, unknown>) : {};
  const preset = f.rangePreset;
  if (preset === 'month' || preset === 'quarter' || preset === 'year' || preset === 'custom') out.rangePreset = preset;
  if (preset === 'custom' && typeof f.from === 'string' && typeof f.to === 'string' && ISO_DAY.test(f.from) && ISO_DAY.test(f.to)) {
    out.custom = { from: f.from, to: f.to };
  }
  if (Array.isArray(f.widgets)) out.widgets = storedSlots(f.widgets, widgetOf);
  if (f.bankAction === 'tile' || f.bankAction === 'card' || f.bankAction === 'bar') out.bankAction = f.bankAction;
  if (Array.isArray(f.tiles)) {
    out.tiles = storedSlots(f.tiles, tileOf);
    return out;
  }
  const columns = Array.isArray(view.columns)
    ? [...new Set(view.columns.filter((c): c is OverviewTileId => typeof c === 'string' && KNOWN_TILES.has(c)))]
    : [];
  if (columns.length === 0) return out;
  if (out.widgets !== undefined || out.bankAction !== undefined) {
    // A layout view without a tiles list: what it does not name, it hides.
    out.tiles = [
      ...columns.map((id) => ({ id, on: true })),
      ...OVERVIEW_TILE_IDS.filter((id) => !columns.includes(id)).map((id) => ({ id, on: false })),
    ];
  } else {
    out.tileOrder = columns;
  }
  return out;
}

/** `current` with `order` moved to the front and shown, every other tile left as it is. */
export function withTileOrder(current: readonly TileSlot[], order: readonly OverviewTileId[]): TileSlot[] {
  return [...order.map((id) => ({ id, on: true })), ...current.filter((s) => !order.includes(s.id))];
}

export function asContent(value: unknown): OverviewContent {
  return value === 'trends' || value === 'figures' ? value : 'bexio';
}

export function asBankPlace(value: unknown): BankActionPlace {
  return value === 'card' || value === 'bar' ? value : 'tile';
}

/** The twelve calendar months ending with the month of `to` (an ISO day): the charts' window. */
export function seriesWindow(to: string): { from: string; to: string } {
  const year = Number(to.slice(0, 4));
  const month = Number(to.slice(5, 7));
  const startMonth = month === 12 ? 1 : month + 1;
  const startYear = month === 12 ? year : year - 1;
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return {
    from: `${startYear}-${String(startMonth).padStart(2, '0')}-01`,
    to: `${to.slice(0, 7)}-${String(last).padStart(2, '0')}`,
  };
}
