/**
 * D178 N2 (A39 §18.2, §18.3): where the /bank detail area docks, how big it is, and the page that never
 * scrolls.
 *
 * POSITION. `bank.detail_position` is the person's (`automatic`, `right`, `bottom`). Automatic is decided
 * ON ENTRY, once: the first time the page's open-line count answers for a workspace, bottom at
 * `bank.detail_auto_threshold` or fewer, right above. Nothing the person does on the page re-decides it
 * (booking lines changes the count, a tab or a filter changes the view); a new entry (a remount, a
 * workspace switch, D153) does. Without an answer the area docks right.
 *
 * SIZE. `bank.detail_width` (docked right) and `bank.detail_height` (docked at the bottom), each written
 * when a drag lets go or the divider's keys stop, and clamped at render time to the room the workspace
 * leaves: the list keeps `LIST_MIN` beside or above the area. The bounds of the preferences come from the
 * engine's own def registry (imported at runtime, one implementation), so the Studio and the verbs agree.
 *
 * Pure helpers are exported for the suites; the hooks hold no DOM knowledge beyond what they measure.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';

import { prefDef } from '../../../../src/core/customization/prefDefs/index.js';
import { usePref } from '../../lib/prefs';

export type DockEdge = 'right' | 'bottom';
export type DockPreference = 'automatic' | DockEdge;
/** Where the area renders: docked at an edge, or the shared drawer below the breakpoint. */
export type AreaPlacement = DockEdge | 'drawer';

/** The divider's thickness (its hit area), in px. */
export const DIVIDER_PX = 8;
/** What the list keeps beside (right) or above (bottom) the area, in px. */
export const LIST_MIN: Readonly<Record<DockEdge, number>> = Object.freeze({ right: 240, bottom: 160 });
/** One arrow-key step on the divider, and the step with Shift. */
export const DIVIDER_STEP = 16;
export const DIVIDER_STEP_LARGE = 64;
/** How long the divider's keys must rest before the size is written to the preference. */
export const SIZE_WRITE_DELAY_MS = 400;
/** The shortest the page may become, so a tiny window still shows the toolbar and a few lines. */
export const PAGE_MIN_HEIGHT = 320;

/**
 * B5 judge: the height a bottom-docked area needs to show its controls (header, focus bar, mode switch, a
 * picker, the footer). A workspace that cannot give it that beside the list's minimum docks right instead,
 * for as long as the room stays short; the person's preference is not rewritten.
 */
export const BOTTOM_AREA_NEEDS = 360;

/** The edge the area takes in this room: bottom falls back to right when the bottom cannot hold the controls. */
export function edgeForRoom(edge: DockEdge, room: { width: number; height: number } | null): DockEdge {
  if (edge !== 'bottom' || room === null) return edge;
  const short = room.height - DIVIDER_PX - LIST_MIN.bottom < BOTTOM_AREA_NEEDS;
  const wideEnough = room.width >= LIST_MIN.right + DIVIDER_PX + sizeDef('right').min;
  return short && wideEnough ? 'right' : edge;
}

const SIZE_KEY: Readonly<Record<DockEdge, string>> = Object.freeze({ right: 'bank.detail_width', bottom: 'bank.detail_height' });

/** The preference bounds and default of a size, read off the engine's def (never restated here). */
export function sizeDef(edge: DockEdge): { min: number; max: number; default: number } {
  const def = prefDef(SIZE_KEY[edge]);
  const schema = def?.schema;
  if (def === undefined || schema === undefined || schema.type !== 'integer' || typeof def.default !== 'number') {
    throw new Error(`the bank size preference ${SIZE_KEY[edge]} is missing from the registry`);
  }
  return { min: schema.min, max: schema.max, default: def.default };
}

/** Automatic, decided once: bottom at the threshold or fewer open lines, right above (and without a count). */
export function decideAutomatic(openCount: number | null, threshold: number): DockEdge {
  if (openCount === null) return 'right';
  return openCount <= threshold ? 'bottom' : 'right';
}

/** The size range the area may take in a workspace of this size: the preference's, inside the room the list leaves. */
export function sizeBounds(edge: DockEdge, room: { width: number; height: number } | null): { min: number; max: number } {
  const def = sizeDef(edge);
  if (room === null) return { min: def.min, max: def.max };
  const extent = edge === 'right' ? room.width : room.height;
  // The list keeps its minimum; on a room too small for both, the area keeps its own minimum and the list
  // takes what is left.
  const roomMax = Math.floor(extent - DIVIDER_PX - LIST_MIN[edge]);
  return { min: def.min, max: Math.max(def.min, Math.min(def.max, roomMax)) };
}

/** A size held inside its bounds, in whole pixels. */
export function clampSize(edge: DockEdge, size: number, room: { width: number; height: number } | null): number {
  const { min, max } = sizeBounds(edge, room);
  if (!Number.isFinite(size)) return min;
  return Math.round(Math.min(max, Math.max(min, size)));
}

/**
 * The edge a header drag would dock the area at, for a pointer at `point` over a workspace `rect`, or null
 * when the pointer is not in the other edge's half: from the right, the lower 40 percent; from the bottom,
 * the right 40 percent. Dropping anywhere else changes nothing.
 */
export function dropEdgeAt(from: DockEdge, point: { x: number; y: number }, rect: { left: number; top: number; width: number; height: number }): DockEdge | null {
  if (rect.width <= 0 || rect.height <= 0) return null;
  const inside = point.x >= rect.left && point.x <= rect.left + rect.width && point.y >= rect.top && point.y <= rect.top + rect.height;
  if (!inside) return null;
  if (from === 'right') return point.y >= rect.top + rect.height * 0.6 ? 'bottom' : null;
  return point.x >= rect.left + rect.width * 0.6 ? 'right' : null;
}

/** The size the divider's keys move to, or null for a key it does not take. */
export function sizeForKey(edge: DockEdge, key: string, shift: boolean, size: number, bounds: { min: number; max: number }): number | null {
  const step = shift ? DIVIDER_STEP_LARGE : DIVIDER_STEP;
  // Docked right the divider stands between the list and the area: Left grows the area, Right shrinks it.
  // Docked at the bottom it lies above the area: Up grows it, Down shrinks it.
  const grow = edge === 'right' ? 'ArrowLeft' : 'ArrowUp';
  const shrink = edge === 'right' ? 'ArrowRight' : 'ArrowDown';
  if (key === grow) return Math.min(bounds.max, size + step);
  if (key === shrink) return Math.max(bounds.min, size - step);
  if (key === 'Home') return bounds.min;
  if (key === 'End') return bounds.max;
  return null;
}

/** The workspace's size, measured, for the bounds (null until it has rendered). */
export function useMeasuredRoom(ref: RefObject<HTMLElement | null>): { width: number; height: number } | null {
  const [room, setRoom] = useState<{ width: number; height: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return undefined;
    const measure = () => {
      const r = el.getBoundingClientRect();
      // A box with no extent (not laid out yet, or a test DOM without layout) tells nothing about the room.
      const next = r.width > 0 && r.height > 0 ? { width: r.width, height: r.height } : null;
      setRoom((prev) => (prev === next || (prev !== null && next !== null && prev.width === next.width && prev.height === next.height) ? prev : next));
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(el);
    window.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
    };
  });
  return room;
}

export interface DetailLayout {
  /** The person's preference as it stands. */
  preference: DockPreference;
  /** Where the area docks now (automatic resolved). */
  edge: DockEdge;
  /** The area's size at that edge, clamped to the room. */
  size: number;
  bounds: { min: number; max: number };
  /** Dock at an edge: the person's choice, written to `bank.detail_position`. */
  dock: (edge: DockEdge) => void;
  /** A size the pointer or a key is driving now (shown at once, written by `commit`). */
  drive: (size: number) => void;
  /** Write the driven size to the edge's preference. */
  commit: () => void;
  /** Back to the edge's default size. */
  reset: () => void;
}

/**
 * The detail area's layout for the /bank page. `openCount` is the engine's open-line total (null until it
 * answers); `entryKey` is what makes a new entry (the workspace). `room` is the workspace's measured size.
 */
export function useDetailLayout(openCount: number | null, entryKey: string | null, room: { width: number; height: number } | null): DetailLayout {
  const [position, setPosition] = usePref<string>('bank.detail_position');
  const [threshold] = usePref<number>('bank.detail_auto_threshold');
  const [width, setWidth, widthMeta] = usePref<number>('bank.detail_width');
  const [height, setHeight, heightMeta] = usePref<number>('bank.detail_height');
  const preference: DockPreference = position === 'right' || position === 'bottom' ? position : 'automatic';

  // Automatic, decided once per entry: the first answer of the count for this workspace.
  const [decided, setDecided] = useState<{ key: string | null; edge: DockEdge } | null>(null);
  useEffect(() => {
    if (decided !== null && decided.key === entryKey) return;
    if (openCount === null) return;
    setDecided({ key: entryKey, edge: decideAutomatic(openCount, threshold) });
  }, [openCount, entryKey, threshold, decided]);
  const autoEdge: DockEdge = decided !== null && decided.key === entryKey ? decided.edge : 'right';
  const edge: DockEdge = edgeForRoom(preference === 'automatic' ? autoEdge : preference, room);

  const [driven, setDriven] = useState<{ edge: DockEdge; size: number } | null>(null);
  const stored = edge === 'right' ? width : height;
  const bounds = sizeBounds(edge, room);
  const size = clampSize(edge, driven !== null && driven.edge === edge ? driven.size : stored, room);

  const latest = useRef({ edge, driven, setWidth, setHeight });
  latest.current = { edge, driven, setWidth, setHeight };

  const dock = useCallback(
    (next: DockEdge) => {
      setDriven(null);
      void setPosition(next);
    },
    [setPosition],
  );
  const drive = useCallback((next: number) => setDriven({ edge: latest.current.edge, size: next }), []);
  const commit = useCallback(() => {
    const { driven: d, setWidth: w, setHeight: h } = latest.current;
    if (d === null) return;
    const def = sizeDef(d.edge);
    const value = Math.round(Math.min(def.max, Math.max(def.min, d.size)));
    void (d.edge === 'right' ? w(value) : h(value)).then(() => setDriven((cur) => (cur === d ? null : cur)));
  }, []);
  const reset = useCallback(() => {
    setDriven(null);
    void (latest.current.edge === 'right' ? widthMeta.reset() : heightMeta.reset());
  }, [widthMeta, heightMeta]);

  return { preference, edge, size, bounds, dock, drive, commit, reset };
}

/**
 * A39 §18.3, ONE SCROLL OWNER: the /bank page takes exactly the height `<main>` leaves, so the page itself
 * never scrolls and the list and the detail area own their scroll. Measured, not assumed: whatever sits
 * above the surface in `<main>` (the demo banner) and `<main>`'s own padding are taken off. Re-measured when
 * `<main>` or the window changes size. Outside a `<main>` (a component test) it does nothing.
 */
export function usePageFit(el: HTMLElement | null): void {
  useLayoutEffect(() => {
    const main = el?.closest('main') ?? null;
    if (el === null || main === null) return undefined;
    const fit = () => {
      const style = window.getComputedStyle(main);
      const padBottom = Number.parseFloat(style.paddingBottom) || 0;
      const top = el.getBoundingClientRect().top - main.getBoundingClientRect().top + main.scrollTop;
      const height = Math.max(PAGE_MIN_HEIGHT, Math.floor(main.clientHeight - top - padBottom));
      el.style.height = `${height}px`;
      // A page that arrived scrolled (from a long surface) starts at its top.
      if (main.scrollTop !== 0 && main.scrollHeight <= main.clientHeight + 1) main.scrollTop = 0;
    };
    fit();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(fit);
    observer?.observe(main);
    window.addEventListener('resize', fit);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', fit);
      el.style.height = '';
    };
  }, [el]);
}
