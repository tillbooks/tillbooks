/**
 * Where the rail remembers which tree nodes a user has expanded (D118, modernisation phase 1, A1).
 *
 * The rail is a real tree now: groups and parents collapse, and every collapsible node DEFAULTS TO
 * COLLAPSED so a fresh workspace shows roughly a dozen rows and the rail never has to scroll (the
 * DESIGN.md "the rail never scrolls" law). A user's own expansions have to survive a reload, so they
 * live here in `localStorage`, keyed per workspace (the closest the app has to "per user per
 * workspace" until a real user-preference verb exists: the audit's stated migration target is the
 * G00 saved-view seam, and this module is the seam's local stand-in).
 *
 * WHAT IS STORED. Not the full expanded set, but the user's explicit OVERRIDES: a map of node navId
 * to a boolean the user chose by toggling. A node with no entry falls back to its computed default
 * (collapsed, unless it is an ancestor of the active route, which auto-expands so the active item is
 * always visible: see `useNavExpansion`). Storing overrides rather than the whole set is what keeps
 * the default-collapsed rhythm: visiting a group to read it does not permanently pin it open, only a
 * deliberate toggle does.
 *
 * FAILURE IS SILENT. `localStorage` can throw outright (Safari private mode, a hardened profile) and
 * a Studio that cannot remember which groups were open must still open, so a read failure is "no
 * overrides remembered" and a write failure is a no-op, never an exception. This mirrors
 * `lib/workspace-store.ts`, the sibling store for the tenant id.
 */
import { useCallback, useEffect, useState } from 'react';

import { useWorkspaceId } from './workspace';

/** The `localStorage` key prefix. One entry per workspace scope, sibling of `till-workspace`. */
export const NAV_EXPANDED_KEY_PREFIX = 'till-nav-expanded:';

/** The favourites `localStorage` key prefix (A3). One ordered list per workspace scope, sibling of
 *  the expanded-overrides entry above, so a Treuhänder's pins are a property of the books in front of
 *  them, not of the session. */
export const NAV_FAVOURITES_KEY_PREFIX = 'till-nav-favourites:';

/** A user's explicit expand/collapse choices: node navId to the state the user toggled it into. */
export type NavOverrides = Record<string, boolean>;

/** The scope a set of overrides is filed under: the workspace, or a shared fallback when none is
 *  selected yet (the rail still renders on the no-workspace setup screen). */
function scopeKey(workspaceId: string | null): string {
  return `${NAV_EXPANDED_KEY_PREFIX}${workspaceId ?? 'global'}`;
}

/** The favourites scope key, keyed exactly like `scopeKey` so a workspace's pins reload with it. */
function favouritesScopeKey(workspaceId: string | null): string {
  return `${NAV_FAVOURITES_KEY_PREFIX}${workspaceId ?? 'global'}`;
}

/** Read a scope's stored overrides. Any parse or storage failure reads as "nothing remembered". A
 *  stored value that is not a flat object of booleans is discarded rather than trusted. */
export function readNavOverrides(workspaceId: string | null): NavOverrides {
  try {
    const raw = window.localStorage.getItem(scopeKey(workspaceId));
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: NavOverrides = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'boolean') out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

/** Persist a scope's overrides. Never throws: a Studio that cannot persist still works this session. */
export function writeNavOverrides(workspaceId: string | null, overrides: NavOverrides): void {
  try {
    window.localStorage.setItem(scopeKey(workspaceId), JSON.stringify(overrides));
  } catch {
    // A rail that cannot remember its open groups still navigates.
  }
}

/**
 * The rail's expand/collapse state, resolved and persisted.
 *
 * `isExpanded(navId)` answers for one collapsible node: a stored user override wins; otherwise the
 * node auto-expands exactly when it is an ancestor of the ACTIVE route (so a deep link is never
 * hidden inside a collapsed group), and is collapsed by default everywhere else. `toggle(navId)`
 * records the opposite of the node's current resolved state as an explicit override and persists it.
 *
 * `activeAncestors` is the set of group/parent navIds on the path to the active leaf; the caller
 * computes it from the route so this hook stays free of routing. The stored overrides reload when
 * the workspace changes, because a Treuhänder's open groups are a property of the books in front of
 * them, not of the session.
 */
export function useNavExpansion(activeAncestors: ReadonlySet<string>): {
  isExpanded: (navId: string) => boolean;
  toggle: (navId: string) => void;
} {
  const workspaceId = useWorkspaceId();
  const [overrides, setOverrides] = useState<NavOverrides>(() => readNavOverrides(workspaceId));

  // Reload the remembered overrides when the workspace changes: a different set of books carries a
  // different set of open groups. Not on first mount (the initializer already read them).
  const [loadedScope, setLoadedScope] = useState<string | null>(workspaceId);
  useEffect(() => {
    if (loadedScope === workspaceId) return;
    setLoadedScope(workspaceId);
    setOverrides(readNavOverrides(workspaceId));
  }, [workspaceId, loadedScope]);

  const isExpanded = useCallback(
    (navId: string): boolean => {
      const override = overrides[navId];
      return override === undefined ? activeAncestors.has(navId) : override;
    },
    [overrides, activeAncestors],
  );

  const toggle = useCallback(
    (navId: string): void => {
      setOverrides((current) => {
        const resolved = current[navId] === undefined ? activeAncestors.has(navId) : current[navId];
        const next: NavOverrides = { ...current, [navId]: !resolved };
        writeNavOverrides(workspaceId, next);
        return next;
      });
    },
    [workspaceId, activeAncestors],
  );

  return { isExpanded, toggle };
}

// --- Favourites: the personal lane above the canonical tree (D118 A3) ----------------------------

/**
 * One pinned favourite: the `navId` of the catalog surface it points at, and an OPTIONAL per-user
 * alias. The alias is a rename that shows IN PLACE of the canonical label in the Favoriten lane ONLY;
 * the canonical name always survives (it is what the row's tooltip carries, and it is the label the
 * canonical tree below keeps). Aliasing is favourites-only by design (A3 / OD-10 recommendation A):
 * the canonical tree keeps one shared vocabulary for documentation, support and the agent, and only
 * the personal lane on top bends to a single user's wording.
 */
export interface NavFavourite {
  navId: string;
  alias?: string;
}

/** The stored favourites: an ORDERED list. Order is the user's reorder, top to bottom. */
export type NavFavourites = readonly NavFavourite[];

/** Read a scope's stored favourites. Any parse or storage failure reads as "nothing pinned". A stored
 *  value that is not an array of `{ navId: string, alias?: string }` records is discarded whole rather
 *  than trusted, mirroring `readNavOverrides`. A blank or non-string alias is dropped to undefined. */
export function readNavFavourites(workspaceId: string | null): NavFavourite[] {
  try {
    const raw = window.localStorage.getItem(favouritesScopeKey(workspaceId));
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: NavFavourite[] = [];
    const seen = new Set<string>();
    for (const entry of parsed) {
      if (entry === null || typeof entry !== 'object') continue;
      const navId = (entry as Record<string, unknown>).navId;
      if (typeof navId !== 'string' || navId.length === 0 || seen.has(navId)) continue;
      seen.add(navId);
      const rawAlias = (entry as Record<string, unknown>).alias;
      const alias = typeof rawAlias === 'string' && rawAlias.trim().length > 0 ? rawAlias.trim() : undefined;
      out.push(alias === undefined ? { navId } : { navId, alias });
    }
    return out;
  } catch {
    return [];
  }
}

/** Persist a scope's favourites. Never throws: a rail that cannot remember its pins still navigates. */
export function writeNavFavourites(workspaceId: string | null, favourites: NavFavourites): void {
  try {
    window.localStorage.setItem(favouritesScopeKey(workspaceId), JSON.stringify(favourites));
  } catch {
    // A rail that cannot persist its favourites still works this session.
  }
}

/**
 * A tiny in-memory pub/sub so EVERY `useNavFavourites` instance stays in sync within one tab.
 *
 * The favourites hook is consumed in two places at once: the pin star on each tree leaf (NavTree) and
 * the Favoriten lane itself (FavouritesRail). Without a shared channel, pinning in the tree would
 * write localStorage but leave the lane's local state stale until a reload. localStorage is the source
 * of truth; a mutation writes it and then broadcasts, and every subscriber re-reads. (localStorage's
 * own `storage` event fires across TABS, never in the writing tab, so it cannot serve this same-tab
 * need.) */
const favouriteSubscribers = new Set<() => void>();
function broadcastFavourites(): void {
  for (const notify of favouriteSubscribers) notify();
}

/**
 * The favourites lane's state, resolved and persisted per workspace.
 *
 * `favourites` is the ordered pin list. `isFavourite(navId)` answers whether a leaf is pinned (the
 * tree's star affordance reads it). `pin`/`unpin` add or remove a pin (a new pin lands at the END of
 * the lane, the natural "most recently added" spot). `move(navId, 'up'|'down')` is the WCAG 2.5.7
 * keyboard reorder: a single-pointer, non-dragging alternative to the drag handle, and the primary
 * path for keyboard users. `reorder(from, to)` is the drag-drop commit (dnd-kit hands it index moves).
 * `setAlias(navId, alias)` sets or clears the per-user rename (a blank alias clears it).
 *
 * Every mutation persists synchronously, so the lane survives a reload. The stored list reloads when
 * the workspace changes, exactly like the expand overrides.
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
} {
  const workspaceId = useWorkspaceId();
  const [favourites, setFavourites] = useState<NavFavourite[]>(() => readNavFavourites(workspaceId));

  // Re-read whenever the workspace changes OR another instance in this tab mutates the pins (the pin
  // star and the lane are two consumers of one store). One effect covers both: it reloads immediately
  // for the current scope and subscribes to the broadcast, re-reading on every notification.
  useEffect(() => {
    const reload = (): void => setFavourites(readNavFavourites(workspaceId));
    reload();
    favouriteSubscribers.add(reload);
    return () => {
      favouriteSubscribers.delete(reload);
    };
  }, [workspaceId]);

  // Every mutator reads the CURRENT persisted list (never a stale closure), computes the next list,
  // persists it, and broadcasts so all instances re-read. This keeps localStorage the single truth.
  const mutate = useCallback(
    (fn: (current: NavFavourite[]) => NavFavourite[]): void => {
      const next = fn(readNavFavourites(workspaceId));
      writeNavFavourites(workspaceId, next);
      broadcastFavourites();
    },
    [workspaceId],
  );

  const isFavourite = useCallback(
    (navId: string): boolean => favourites.some((f) => f.navId === navId),
    [favourites],
  );

  const pin = useCallback(
    (navId: string): void =>
      mutate((current) => (current.some((f) => f.navId === navId) ? current : [...current, { navId }])),
    [mutate],
  );

  const unpin = useCallback(
    (navId: string): void => mutate((current) => current.filter((f) => f.navId !== navId)),
    [mutate],
  );

  const toggleFavourite = useCallback(
    (navId: string): void =>
      mutate((current) =>
        current.some((f) => f.navId === navId)
          ? current.filter((f) => f.navId !== navId)
          : [...current, { navId }],
      ),
    [mutate],
  );

  const move = useCallback(
    (navId: string, direction: 'up' | 'down'): void =>
      mutate((current) => {
        const index = current.findIndex((f) => f.navId === navId);
        if (index === -1) return current;
        const target = direction === 'up' ? index - 1 : index + 1;
        if (target < 0 || target >= current.length) return current;
        const next = [...current];
        [next[index], next[target]] = [next[target], next[index]];
        return next;
      }),
    [mutate],
  );

  const reorder = useCallback(
    (fromIndex: number, toIndex: number): void =>
      mutate((current) => {
        if (
          fromIndex === toIndex ||
          fromIndex < 0 ||
          toIndex < 0 ||
          fromIndex >= current.length ||
          toIndex >= current.length
        ) {
          return current;
        }
        const next = [...current];
        const [moved] = next.splice(fromIndex, 1);
        next.splice(toIndex, 0, moved);
        return next;
      }),
    [mutate],
  );

  const setAlias = useCallback(
    (navId: string, alias: string | null): void =>
      mutate((current) => {
        const index = current.findIndex((f) => f.navId === navId);
        if (index === -1) return current;
        const trimmed = alias === null ? '' : alias.trim();
        const next = [...current];
        next[index] = trimmed.length > 0 ? { navId, alias: trimmed } : { navId };
        return next;
      }),
    [mutate],
  );

  return { favourites, isFavourite, pin, unpin, toggleFavourite, move, reorder, setAlias };
}

// --- Resizable rail: the width and the collapsed icon mode (D118 A4) ------------------------------

/**
 * The rail's width bounds and its snapping widths (A4, recommendation A). The splitter clamps a free
 * resize to [MIN, MAX]; a double-click on the separator resets to DEFAULT; dragging the separator
 * below MIN snaps the rail to the ICON strip. These are exported so the separator component and its
 * tests read one source of truth rather than each restating the numbers.
 */
export const RAIL_MIN_WIDTH = 200;
export const RAIL_MAX_WIDTH = 400;
export const RAIL_DEFAULT_WIDTH = 240;
export const RAIL_ICON_WIDTH = 56;

/** The `localStorage` key prefix for the rail's width and collapsed flag. One entry per workspace
 *  scope, a sibling of the expand-overrides and favourites entries above, so a Treuhänder's rail
 *  width is a property of the books in front of them rather than of the session. */
export const NAV_RAIL_KEY_PREFIX = 'till-nav-rail:';

/** The persisted rail geometry: the last EXPANDED width (always kept, even while collapsed, so
 *  expanding restores the width the user chose) and whether the rail is collapsed to the icon strip. */
export interface RailPrefs {
  width: number;
  collapsed: boolean;
}

function railScopeKey(workspaceId: string | null): string {
  return `${NAV_RAIL_KEY_PREFIX}${workspaceId ?? 'global'}`;
}

/** Clamp a candidate width into the allowed range, rounding to a whole pixel. A non-finite value
 *  (a corrupted store, a bad drag maths) falls back to the default rather than to NaN. */
export function clampRailWidth(width: number): number {
  if (!Number.isFinite(width)) return RAIL_DEFAULT_WIDTH;
  return Math.min(RAIL_MAX_WIDTH, Math.max(RAIL_MIN_WIDTH, Math.round(width)));
}

/** Read a scope's stored rail geometry. Any parse or storage failure, or a stored value that is not
 *  the expected shape, reads as the default geometry (240px, expanded), mirroring `readNavOverrides`. */
export function readRailPrefs(workspaceId: string | null): RailPrefs {
  const fallback: RailPrefs = { width: RAIL_DEFAULT_WIDTH, collapsed: false };
  try {
    const raw = window.localStorage.getItem(railScopeKey(workspaceId));
    if (raw === null) return fallback;
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return fallback;
    const rec = parsed as Record<string, unknown>;
    const width = typeof rec.width === 'number' ? clampRailWidth(rec.width) : RAIL_DEFAULT_WIDTH;
    const collapsed = typeof rec.collapsed === 'boolean' ? rec.collapsed : false;
    return { width, collapsed };
  } catch {
    return fallback;
  }
}

/** Persist a scope's rail geometry. Never throws: a rail that cannot remember its width still works. */
export function writeRailPrefs(workspaceId: string | null, prefs: RailPrefs): void {
  try {
    window.localStorage.setItem(railScopeKey(workspaceId), JSON.stringify(prefs));
  } catch {
    // A rail that cannot persist its width still navigates this session.
  }
}

/**
 * The rail's width and collapsed state, resolved and persisted per workspace.
 *
 * `setWidth(px)` records a free-resize or a keyboard step: it clamps into [MIN, MAX] and, because a
 * chosen width is inherently an expanded rail, it also clears the collapsed flag. `setCollapsed(b)`
 * flips the icon mode while KEEPING the stored width, so expanding restores the last width the user
 * chose. `reset()` returns to the default width, expanded (the separator's double-click). Every
 * mutation persists synchronously, and the stored geometry reloads when the workspace changes,
 * exactly like the expand overrides and the favourites.
 */
export function useRailPrefs(): {
  width: number;
  collapsed: boolean;
  setWidth: (width: number) => void;
  setCollapsed: (collapsed: boolean) => void;
  reset: () => void;
} {
  const workspaceId = useWorkspaceId();
  const [prefs, setPrefs] = useState<RailPrefs>(() => readRailPrefs(workspaceId));

  // Reload the remembered geometry when the workspace changes. Not on first mount (the initializer
  // already read it), mirroring the expand-overrides reload above.
  const [loadedScope, setLoadedScope] = useState<string | null>(workspaceId);
  useEffect(() => {
    if (loadedScope === workspaceId) return;
    setLoadedScope(workspaceId);
    setPrefs(readRailPrefs(workspaceId));
  }, [workspaceId, loadedScope]);

  const setWidth = useCallback(
    (width: number): void => {
      const next: RailPrefs = { width: clampRailWidth(width), collapsed: false };
      writeRailPrefs(workspaceId, next);
      setPrefs(next);
    },
    [workspaceId],
  );

  const setCollapsed = useCallback(
    (collapsed: boolean): void => {
      setPrefs((current) => {
        const next: RailPrefs = { width: current.width, collapsed };
        writeRailPrefs(workspaceId, next);
        return next;
      });
    },
    [workspaceId],
  );

  const reset = useCallback((): void => {
    const next: RailPrefs = { width: RAIL_DEFAULT_WIDTH, collapsed: false };
    writeRailPrefs(workspaceId, next);
    setPrefs(next);
  }, [workspaceId]);

  return { width: prefs.width, collapsed: prefs.collapsed, setWidth, setCollapsed, reset };
}
