/**
 * The rail's personal state and looks (D118 A1/A3/A4, rebuilt on the engine preferences by D178).
 *
 * WHERE IT LIVES. Until D178 the pins, the open groups and the rail width sat in `localStorage` per
 * workspace (`till-nav-*`), so a second browser lost them and no agent could read them. They are now G00
 * §10 preferences in the `nav` area (`src/core/customization/prefDefs/nav.ts`), read and written through
 * `usePref`, which holds the ONE preference store of the Studio:
 *   - `person` scope, the same in every workspace: `nav.favourite_style`, `nav.active_rule`,
 *     `nav.group_header_style` (the looks, D178 points 15 to 17);
 *   - `workspace` scope, per person per workspace: `nav.favourites`, `nav.expanded`, `nav.sections`,
 *     `nav.menu_layout`, `nav.rail`.
 * The old browser keys move into the engine ONCE (`useLegacyNavImport`, `importLegacyPref`).
 *
 * A REFUSED WRITE NEVER BREAKS THE RAIL. A rail that cannot remember its open groups still navigates:
 * every hook here keeps a value the engine refused for the rest of the session (the preference store
 * would otherwise roll it back under the person's pointer), and reports the refusal on `error` so a
 * surface that should say so (the Favoriten lane, the menu editor) can.
 *
 * ONE MODEL FOR THE WHOLE RAIL. `RailStateProvider` reads every one of these once and computes the one
 * answer the lane, the tree, the editor and the icon strip all render from: the personal tree, the
 * resolved favourites, the folded sections and the ONE active row (`resolveRailActive`, nav.ts). Before
 * D178 the lane and the tree each matched the URL on their own and both lit for a pinned page.
 */
import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useLocation } from 'react-router-dom';

import { importLegacyPref, PREF_CACHE_KEY, usePref, type PrefValue } from '../lib/prefs';
import type { Err } from '../lib/client';
import {
  isCanonicalMenuLayout,
  normalizeMenuLayout,
  personalNavTree,
  resolveNavTree,
  resolveOpenTopGroup,
  resolveRailActive,
  resolveSectionLocation,
  surfaceByNavId,
  type ActiveRule,
  type MenuLayout,
  type NavGroup,
  type NavItem,
  type RailActive,
  type RailLocation,
} from './nav';
import { useWorkspaceId } from './workspace';

// --- The preference keys and the legacy browser keys ----------------------------------------------

export const NAV_PREF = {
  favouriteStyle: 'nav.favourite_style',
  activeRule: 'nav.active_rule',
  groupHeaderStyle: 'nav.group_header_style',
  favourites: 'nav.favourites',
  expanded: 'nav.expanded',
  sections: 'nav.sections',
  menuLayout: 'nav.menu_layout',
  rail: 'nav.rail',
} as const;

/** The D118 browser key prefixes, read once per workspace by the legacy import and then cleared. */
export const NAV_EXPANDED_KEY_PREFIX = 'till-nav-expanded:';
export const NAV_FAVOURITES_KEY_PREFIX = 'till-nav-favourites:';
export const NAV_RAIL_KEY_PREFIX = 'till-nav-rail:';

/** How a favourite row is drawn (D178 point 15). */
export type FavouriteStyle = 'icon_star' | 'star_only' | 'icon_only';
/** How a section or group header is set (D178 point 17). */
export type GroupHeaderStyle = 'text_14_bold' | 'icon_14' | 'label_12';

const FAVOURITE_STYLES: readonly FavouriteStyle[] = ['icon_star', 'star_only', 'icon_only'];
const ACTIVE_RULES: readonly ActiveRule[] = ['favourite', 'tree', 'both_soft'];
const HEADER_STYLES: readonly GroupHeaderStyle[] = ['text_14_bold', 'icon_14', 'label_12'];

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

// --- Parsers: what the engine (or an old browser) holds, read defensively --------------------------

/** The longest alias a favourite may carry: a label in a 240px rail, not a paragraph. */
export const MAX_ALIAS_LENGTH = 60;

/**
 * One pinned favourite: the `navId` of the catalog surface it points at, and an OPTIONAL per-user
 * alias. The alias shows IN PLACE of the canonical label in the Favoriten lane ONLY; the canonical name
 * always survives as the row's tooltip and as the tree's label (D118 A3).
 */
export interface NavFavourite {
  navId: string;
  alias?: string;
}

/** The stored favourites: an ORDERED list. Order is the user's reorder, top to bottom. */
export type NavFavourites = readonly NavFavourite[];

/** Read a favourites value: an array of `{ navId, alias? }`; duplicates, non-records and pins of a
 *  surface this build does not know are dropped (validated against the catalog on every read), a blank
 *  alias cleared, an alias over the limit cut. Anything else reads as "nothing pinned". */
export function parseNavFavourites(value: unknown): NavFavourite[] {
  if (!Array.isArray(value)) return [];
  const out: NavFavourite[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const navId = entry.navId;
    if (typeof navId !== 'string' || seen.has(navId) || surfaceByNavId(navId) === undefined) continue;
    seen.add(navId);
    const rawAlias = entry.alias;
    const alias = typeof rawAlias === 'string' ? rawAlias.trim().slice(0, MAX_ALIAS_LENGTH) : '';
    out.push(alias.length > 0 ? { navId, alias } : { navId });
  }
  return out;
}

/** A user's explicit expand/collapse choices: node navId to the state the user toggled it into. */
export type NavOverrides = Record<string, boolean>;

/** Read an overrides value: a flat object of booleans; anything else reads as "nothing remembered". */
export function parseNavOverrides(value: unknown): NavOverrides {
  if (!isRecord(value)) return {};
  const out: NavOverrides = {};
  for (const [key, flag] of Object.entries(value)) if (typeof flag === 'boolean') out[key] = flag;
  return out;
}

/** The two folding sections of the rail (D178): which are folded away. */
export interface NavSections {
  favourites: boolean;
  menu: boolean;
}

export function parseNavSections(value: unknown): NavSections {
  const rec = isRecord(value) ? value : {};
  return { favourites: rec.favourites === true, menu: rec.menu === true };
}

/** Only the folded flags are stored, so unfolding both returns to the default `{}`. */
function serialiseSections(sections: NavSections): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  if (sections.favourites) out.favourites = true;
  if (sections.menu) out.menu = true;
  return out;
}

/** The rail's width bounds and its snapping widths (A4). */
export const RAIL_MIN_WIDTH = 200;
export const RAIL_MAX_WIDTH = 400;
export const RAIL_DEFAULT_WIDTH = 240;
export const RAIL_ICON_WIDTH = 56;

/** The persisted rail geometry: the last EXPANDED width (kept while collapsed) and the icon mode. */
export interface RailPrefs {
  width: number;
  collapsed: boolean;
}

/** Clamp a candidate width into the allowed range, rounding to a whole pixel; non-finite reads as default. */
export function clampRailWidth(width: number): number {
  if (!Number.isFinite(width)) return RAIL_DEFAULT_WIDTH;
  return Math.min(RAIL_MAX_WIDTH, Math.max(RAIL_MIN_WIDTH, Math.round(width)));
}

/** Read a rail geometry: an out-of-range width is re-clamped, anything malformed reads as the default. */
export function parseRailPrefs(value: unknown): RailPrefs {
  if (!isRecord(value)) return { width: RAIL_DEFAULT_WIDTH, collapsed: false };
  return {
    width: typeof value.width === 'number' ? clampRailWidth(value.width) : RAIL_DEFAULT_WIDTH,
    collapsed: typeof value.collapsed === 'boolean' ? value.collapsed : false,
  };
}

/** A raw `localStorage` string as JSON, or undefined. The legacy import's first step. */
function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

// --- The one-time legacy import (D178 point 7, G00 §10.5) ------------------------------------------

/** The legacy parsers: a value that does not parse is discarded, one that does is moved once. */
export function parseLegacyFavourites(raw: string): PrefValue | undefined {
  const parsed = parseJson(raw);
  return Array.isArray(parsed) ? (parseNavFavourites(parsed) as unknown as PrefValue) : undefined;
}

export function parseLegacyOverrides(raw: string): PrefValue | undefined {
  const parsed = parseJson(raw);
  return isRecord(parsed) ? parseNavOverrides(parsed) : undefined;
}

export function parseLegacyRail(raw: string): PrefValue | undefined {
  const parsed = parseJson(raw);
  return isRecord(parsed) ? (parseRailPrefs(parsed) as unknown as PrefValue) : undefined;
}

/** The workspaces whose legacy keys this tab already queued (the import is once, not once per render). */
const importedWorkspaces = new Set<string>();

/** Move one workspace's D118 browser keys into the engine, once. Answers when all three settled. */
export function importLegacyNavPrefs(workspaceId: string): Promise<unknown> {
  importedWorkspaces.add(workspaceId);
  return Promise.all([
    importLegacyPref(NAV_PREF.favourites, `${NAV_FAVOURITES_KEY_PREFIX}${workspaceId}`, parseLegacyFavourites),
    importLegacyPref(NAV_PREF.expanded, `${NAV_EXPANDED_KEY_PREFIX}${workspaceId}`, parseLegacyOverrides),
    importLegacyPref(NAV_PREF.rail, `${NAV_RAIL_KEY_PREFIX}${workspaceId}`, parseLegacyRail),
  ]);
}

/** Run the legacy import for the open workspace, once per workspace per tab. */
export function useLegacyNavImport(): void {
  const workspaceId = useWorkspaceId();
  useEffect(() => {
    if (workspaceId === null || importedWorkspaces.has(workspaceId)) return;
    void importLegacyNavPrefs(workspaceId);
  }, [workspaceId]);
}

/** Test seam: forget which workspaces were imported and the palette's mirror. */
export function resetNavPrefsForTests(): void {
  importedWorkspaces.clear();
  liveFavourites.clear();
}

// --- The session-keeping preference hook -----------------------------------------------------------

/**
 * One rail preference, parsed, with a write that never breaks the rail. `set` takes a value or an
 * updater over the CURRENT value (so two quick clicks compose); the store shows it at once; when the
 * engine refuses it, the value is kept for this session (keyed to the workspace) and `error` names
 * the refusal. The next write starts clean.
 */
function useNavPref<T>(
  key: string,
  parse: (value: unknown) => T,
  serialise: (value: T) => PrefValue,
): { value: T; set: (next: T | ((current: T) => T)) => void; error: Err | null; isDefault: boolean; reset: () => void } {
  const workspaceId = useWorkspaceId();
  const [raw, setRaw, meta] = usePref<PrefValue>(key);
  const parsed = useMemo(() => parse(raw), [raw, parse]);
  const [kept, setKept] = useState<{ ws: string | null; value: T } | null>(null);
  const value = kept !== null && kept.ws === workspaceId ? kept.value : parsed;
  const latest = useRef(value);
  latest.current = value;

  const set = useCallback(
    (next: T | ((current: T) => T)): void => {
      const resolved = typeof next === 'function' ? (next as (current: T) => T)(latest.current) : next;
      latest.current = resolved;
      setKept(null);
      void setRaw(serialise(resolved)).then((accepted) => {
        if (!accepted) setKept({ ws: workspaceId, value: resolved });
      });
    },
    [setRaw, serialise, workspaceId],
  );
  const reset = useCallback((): void => {
    setKept(null);
    void meta.reset();
  }, [meta]);
  return { value, set, error: meta.error, isDefault: meta.isDefault, reset };
}

/** A `person` look: an enum read defensively (a value this build does not know reads as the default). */
function useLook<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  const [value] = usePref<PrefValue>(key);
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

/** The three looks (D178 points 15 to 17). */
export function useNavLook(): { favouriteStyle: FavouriteStyle; activeRule: ActiveRule; groupHeaderStyle: GroupHeaderStyle } {
  return {
    favouriteStyle: useLook(NAV_PREF.favouriteStyle, FAVOURITE_STYLES, 'icon_star'),
    activeRule: useLook(NAV_PREF.activeRule, ACTIVE_RULES, 'favourite'),
    groupHeaderStyle: useLook(NAV_PREF.groupHeaderStyle, HEADER_STYLES, 'text_14_bold'),
  };
}

const asPref = <T,>(value: T): PrefValue => value as unknown as PrefValue;

// --- Favourites (A3, D178 point 15) ------------------------------------------------------------------

/**
 * The palette's mirror of the pins, per workspace (the Favoriten section of the command palette reads
 * them synchronously, outside React). Updated by every rail render that knows them.
 */
const liveFavourites = new Map<string, NavFavourite[]>();

/**
 * The pins of `workspaceId`, synchronously: the rail's live value, else the preference store's boot
 * cache (the engine's last answer), else the D118 browser key not yet imported. Never throws.
 */
export function readNavFavourites(workspaceId: string | null): NavFavourite[] {
  const scope = workspaceId ?? 'global';
  const live = liveFavourites.get(scope);
  if (live !== undefined) return live;
  try {
    if (workspaceId !== null) {
      const cache = parseJson(window.localStorage.getItem(PREF_CACHE_KEY) ?? 'null');
      const ws = isRecord(cache) && isRecord(cache.ws) ? cache.ws[workspaceId] : undefined;
      if (isRecord(ws) && NAV_PREF.favourites in ws) return parseNavFavourites(ws[NAV_PREF.favourites]);
    }
    const legacy = window.localStorage.getItem(`${NAV_FAVOURITES_KEY_PREFIX}${scope}`);
    return legacy === null ? [] : parseNavFavourites(parseJson(legacy));
  } catch {
    return [];
  }
}

const serialiseFavourites = (f: NavFavourite[]): PrefValue => asPref(f);

/**
 * The favourites lane's state. `pin` lands a new pin at the END; `move` is the WCAG 2.5.7 keyboard and
 * single-pointer reorder; `reorder` is the drag commit; `setAlias` sets or clears the rename.
 */
export function useNavFavourites(): {
  favourites: NavFavourite[];
  isFavourite: (navId: string) => boolean;
  pin: (navId: string) => void;
  unpin: (navId: string) => void;
  toggleFavourite: (navId: string) => void;
  move: (navId: string, direction: 'up' | 'down') => void;
  reorder: (fromIndex: number, toIndex: number) => void;
  setAlias: (navId: string, alias: string | null) => void;
  error: Err | null;
} {
  const workspaceId = useWorkspaceId();
  const { value: favourites, set, error } = useNavPref(NAV_PREF.favourites, parseNavFavourites, serialiseFavourites);

  useEffect(() => {
    liveFavourites.set(workspaceId ?? 'global', favourites);
  }, [workspaceId, favourites]);

  const isFavourite = useCallback((navId: string) => favourites.some((f) => f.navId === navId), [favourites]);
  const pin = useCallback(
    (navId: string) => set((current) => (current.some((f) => f.navId === navId) ? current : [...current, { navId }])),
    [set],
  );
  const unpin = useCallback((navId: string) => set((current) => current.filter((f) => f.navId !== navId)), [set]);
  const toggleFavourite = useCallback(
    (navId: string) =>
      set((current) =>
        current.some((f) => f.navId === navId) ? current.filter((f) => f.navId !== navId) : [...current, { navId }],
      ),
    [set],
  );
  const move = useCallback(
    (navId: string, direction: 'up' | 'down') =>
      set((current) => {
        const index = current.findIndex((f) => f.navId === navId);
        const target = direction === 'up' ? index - 1 : index + 1;
        if (index === -1 || target < 0 || target >= current.length) return current;
        const next = [...current];
        [next[index], next[target]] = [next[target], next[index]];
        return next;
      }),
    [set],
  );
  const reorder = useCallback(
    (fromIndex: number, toIndex: number) =>
      set((current) => {
        if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0 || fromIndex >= current.length || toIndex >= current.length) {
          return current;
        }
        const next = [...current];
        const [moved] = next.splice(fromIndex, 1);
        next.splice(toIndex, 0, moved);
        return next;
      }),
    [set],
  );
  const setAlias = useCallback(
    (navId: string, alias: string | null) =>
      set((current) => {
        const index = current.findIndex((f) => f.navId === navId);
        if (index === -1) return current;
        const trimmed = alias === null ? '' : alias.trim().slice(0, MAX_ALIAS_LENGTH);
        const next = [...current];
        next[index] = trimmed.length > 0 ? { navId, alias: trimmed } : { navId };
        return next;
      }),
    [set],
  );

  return { favourites, isFavourite, pin, unpin, toggleFavourite, move, reorder, setAlias, error };
}

// --- Expand state (A1) and the two sections (D178) ---------------------------------------------------

const serialiseOverrides = (o: NavOverrides): PrefValue => o;

/** No accordion: the default for a caller that holds no top-level groups (one stable identity). */
const NO_GROUPS: readonly string[] = [];

/**
 * The rail's expand/collapse state. A stored override wins; otherwise a node is open exactly when it is
 * in `autoExpand` (the ancestors of the lit tree row, which `resolveRailActive` names), and collapsed
 * everywhere else. The top-level headed groups (`topLevel`) are an accordion held at render: at most ONE
 * is open (`resolveOpenTopGroup`: the lit row's group unless closed by hand, else the first opened).
 * `toggle(navId)` stores the opposite of the RESOLVED state, so a group shown closed because another
 * holds the lit row opens on the first click; opening a top-level group closes its siblings.
 */
export function useNavExpansion(
  autoExpand: ReadonlySet<string>,
  topLevel: readonly string[] = NO_GROUPS,
): {
  isExpanded: (navId: string) => boolean;
  toggle: (navId: string, exclusiveWith?: readonly string[]) => void;
} {
  const { value: overrides, set } = useNavPref(NAV_PREF.expanded, parseNavOverrides, serialiseOverrides);
  const resolvedIn = useCallback(
    (current: NavOverrides, navId: string): boolean =>
      topLevel.includes(navId)
        ? resolveOpenTopGroup(topLevel, current, autoExpand) === navId
        : (current[navId] ?? autoExpand.has(navId)),
    [topLevel, autoExpand],
  );
  const isExpanded = useCallback((navId: string): boolean => resolvedIn(overrides, navId), [overrides, resolvedIn]);
  const toggle = useCallback(
    (navId: string, exclusiveWith?: readonly string[]): void =>
      set((current) => {
        const opened = !resolvedIn(current, navId);
        const next: NavOverrides = { ...current, [navId]: opened };
        const siblings = exclusiveWith ?? (topLevel.includes(navId) ? topLevel : undefined);
        if (opened && siblings !== undefined) {
          // The accordion closes an open sibling with an explicit override; a sibling that is closed
          // by default keeps NO override, so a later deep link into it still opens it (the active row
          // is never hidden in a group the person merely passed by).
          for (const sibling of siblings) {
            if (sibling === navId) continue;
            if (autoExpand.has(sibling)) next[sibling] = false;
            else delete next[sibling];
          }
        }
        return next;
      }),
    [set, autoExpand, resolvedIn, topLevel],
  );
  return { isExpanded, toggle };
}

const serialiseSectionsPref = (s: NavSections): PrefValue => serialiseSections(s);

/** The two folding sections, Favoriten and Menü (D178), persisted in `nav.sections`. */
export function useNavSections(): { sections: NavSections; toggleSection: (section: keyof NavSections) => void } {
  const { value: sections, set } = useNavPref(NAV_PREF.sections, parseNavSections, serialiseSectionsPref);
  const toggleSection = useCallback(
    (section: keyof NavSections) => set((current) => ({ ...current, [section]: !current[section] })),
    [set],
  );
  return { sections, toggleSection };
}

// --- The personal menu (D178 point 6) ------------------------------------------------------------------

/** The canonical layout is stored as `{}`, so a reset and an untouched menu are the same row. */
const serialiseLayout = (layout: MenuLayout): PrefValue =>
  isCanonicalMenuLayout(layout) ? {} : asPref({ v: 1, ...layout });

/** The personal menu order, normalised against the catalog on every read. */
export function useMenuLayout(): {
  layout: MenuLayout;
  setLayout: (next: MenuLayout | ((current: MenuLayout) => MenuLayout)) => void;
  resetLayout: () => void;
  isCustom: boolean;
  error: Err | null;
} {
  const { value: layout, set, reset, error } = useNavPref(NAV_PREF.menuLayout, normalizeMenuLayout, serialiseLayout);
  return { layout, setLayout: set, resetLayout: reset, isCustom: !isCanonicalMenuLayout(layout), error };
}

// --- The resizable rail (A4) ------------------------------------------------------------------------

const serialiseRail = (r: RailPrefs): PrefValue => asPref(r);

/** How long a resize must rest before it is written: a drag is one write, not one per pointer move. */
export const RAIL_WRITE_DELAY_MS = 400;

/**
 * The rail's width and icon mode. `setWidth` (a drag step, an arrow key) moves the rail at once and is
 * written once the resize rests; it also clears the icon mode, since a chosen width is an expanded rail.
 * `setCollapsed` keeps the stored width, so expanding restores it. `reset` is the double-click.
 */
export function useRailPrefs(): {
  width: number;
  collapsed: boolean;
  setWidth: (width: number) => void;
  setCollapsed: (collapsed: boolean) => void;
  reset: () => void;
} {
  const { value: prefs, set } = useNavPref(NAV_PREF.rail, parseRailPrefs, serialiseRail);
  const [draft, setDraft] = useState<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<number | null>(null);

  const flush = useCallback((): void => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    const width = pending.current;
    pending.current = null;
    if (width !== null) set({ width, collapsed: false });
    setDraft(null);
  }, [set]);

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  const setWidth = useCallback(
    (width: number): void => {
      const next = clampRailWidth(width);
      pending.current = next;
      setDraft(next);
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = setTimeout(flush, RAIL_WRITE_DELAY_MS);
    },
    [flush],
  );
  const setCollapsed = useCallback(
    (collapsed: boolean): void => {
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
      const width = pending.current ?? prefs.width;
      pending.current = null;
      setDraft(null);
      set({ width, collapsed });
    },
    [set, prefs.width],
  );
  const reset = useCallback((): void => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    pending.current = null;
    setDraft(null);
    set({ width: RAIL_DEFAULT_WIDTH, collapsed: false });
  }, [set]);

  return {
    width: draft ?? prefs.width,
    collapsed: draft !== null ? false : prefs.collapsed,
    setWidth,
    setCollapsed,
    reset,
  };
}

// --- The one rail model (D178) ---------------------------------------------------------------------

/** A favourite joined to its catalog surface (a pin whose surface is gone is dropped, never shown broken). */
export interface ResolvedFavourite {
  navId: string;
  surface: NavItem;
  alias?: string;
}

export interface RailState {
  look: ReturnType<typeof useNavLook>;
  favourites: ReturnType<typeof useNavFavourites>;
  /** The pins that resolve to a surface, in order. */
  resolvedFavourites: ResolvedFavourite[];
  /** The folded sections AS SHOWN: the Menü folds only while it has a header (there are favourites). */
  sections: NavSections;
  toggleSection: (section: keyof NavSections) => void;
  /** The Menü header shows only above favourites (judge round 1 M3): alone, the menu needs no title. */
  menuHeader: boolean;
  menu: ReturnType<typeof useMenuLayout>;
  /** The visible personal tree, resolved (hidden rows and empty headers left out). */
  rail: readonly NavGroup[];
  /** The ONE active row (D178 point 16), for the expanded rail. */
  active: RailActive;
  /** The folded section header that stands in for the open page (`aria-current="location"`), or null. */
  location: RailLocation;
  expansion: ReturnType<typeof useNavExpansion>;
  /** "Menü anpassen" is open (D178 point 6). */
  customising: boolean;
  setCustomising: (open: boolean) => void;
}

const RailContext = createContext<RailState | null>(null);

/** Read every rail preference once, and compute the rail's one model. */
function useRailModel(): RailState {
  const { pathname } = useLocation();
  const look = useNavLook();
  const favourites = useNavFavourites();
  const { sections: stored, toggleSection } = useNavSections();
  const menu = useMenuLayout();
  const [customising, setCustomising] = useState(false);

  const resolvedFavourites = useMemo<ResolvedFavourite[]>(
    () =>
      favourites.favourites.flatMap((f) => {
        const surface = surfaceByNavId(f.navId);
        if (surface === undefined) return [];
        const item: NavItem = { navId: surface.navId, path: surface.path, labelKey: surface.labelKey, icon: surface.icon };
        return [f.alias === undefined ? { navId: f.navId, surface: item } : { navId: f.navId, surface: item, alias: f.alias }];
      }),
    [favourites.favourites],
  );
  const menuHeader = resolvedFavourites.length > 0;
  // A Menü without a header cannot be unfolded, so it is never shown folded.
  const sections = useMemo<NavSections>(
    () => ({ favourites: stored.favourites, menu: stored.menu && menuHeader }),
    [stored.favourites, stored.menu, menuHeader],
  );
  const rail = useMemo(() => resolveNavTree(personalNavTree(menu.layout, { visibleOnly: true })), [menu.layout]);
  const topLevel = useMemo(() => rail.filter((g) => g.labelKey !== null).map((g) => g.navId), [rail]);
  const pinned = useMemo(
    () => resolvedFavourites.map((f) => ({ navId: f.navId, path: f.surface.path })),
    [resolvedFavourites],
  );
  const active = useMemo(
    () =>
      resolveRailActive({
        pathname,
        favourites: sections.favourites ? [] : pinned,
        // While "Menü anpassen" is open the editor stands where the tree was: no tree row is on screen.
        rail: sections.menu || customising ? [] : rail,
        rule: look.activeRule,
      }),
    [pathname, sections, pinned, rail, look.activeRule, customising],
  );
  const location = useMemo(
    () => resolveSectionLocation(active, resolveRailActive({ pathname, favourites: pinned, rail, rule: look.activeRule })),
    [active, pathname, pinned, rail, look.activeRule],
  );
  const expansion = useNavExpansion(active.expand, topLevel);

  return {
    look,
    favourites,
    resolvedFavourites,
    sections,
    toggleSection,
    menuHeader,
    menu,
    rail,
    active,
    location,
    expansion,
    customising,
    setCustomising,
  };
}

/**
 * The rail's one model, for everything inside it: the Favoriten lane, the menu, its editor, the icon
 * strip and the status menu's "Menü anpassen". Mount it once around the rail, inside the router.
 */
export function RailStateProvider({ children }: { children: ReactNode }) {
  useLegacyNavImport();
  const state = useRailModel();
  return createElement(RailContext.Provider, { value: state }, children);
}

/** The rail's model. Throws outside `RailStateProvider`, which is a wiring bug, not a runtime state. */
export function useRail(): RailState {
  const ctx = useContext(RailContext);
  if (ctx === null) throw new Error('useRail must be used within a RailStateProvider.');
  return ctx;
}

/** The rail's model, or null outside a provider (the status menu renders in isolation in its tests). */
export function useRailOptional(): RailState | null {
  return useContext(RailContext);
}
