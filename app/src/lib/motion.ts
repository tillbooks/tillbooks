/**
 * The motion primitives: the JS half of the Responsive vocabulary (D122 D-I, 2026-09-05).
 *
 * The vocabulary is three moments (navigate, commit, reveal), one ease pair, and a reduced-motion
 * setting that zeroes everything. The NUMBERS live in `brand/tokens/tokens.css` as `--t-motion-*`
 * tokens and the CSS half in `app/src/styles/motion.css`; this file is the small amount of script
 * the vocabulary genuinely needs, and no more:
 *
 *   - `navigate()` runs a DOM update (the router swapping the surface) as the Navigate moment: the
 *     new surface enters live, by a class on `<main>`. It is wired ONCE, at the router (see
 *     `installMotionNavigation`). The View Transitions API is NOT used, and that is a measurement,
 *     not a preference: see the note on `navigate()`.
 *   - `commitAck()` stamps `data-just-committed` on the row (or banner) a write just produced, and
 *     removes it once the tint has decayed. The CSS does the landing and the tint; this only marks
 *     WHICH element. `useCommitAck` bridges a DataTable row (which only exposes `rowClassName`) to
 *     that stamp; `useCommitAckState` does the same for a hand-rolled `<tr>` that can set the
 *     attribute itself.
 *   - `arriveLeave()` (D204, the fourth moment) plays an in-place change of a keyed list or grid: the
 *     layout changes at once, an item that arrived fades and scales in, one that left fades out from a
 *     detached copy, and every neighbour glides from its old place to the new one (FLIP on
 *     `transform`, the Web Animations API). `useArriveLeave` wires it to a container and its keys.
 *
 * NO MOTION LIBRARY (DESIGN.md, Dependencies). CSS transitions and the native View Transitions API
 * only. Everything here stays small because that is the size of the problem.
 *
 * REDUCED MOTION IS A KILL SWITCH. `tokens.css` zeroes every duration and delay under the setting;
 * this file additionally stamps nothing under it (no direction, no entrance class, no tint), so
 * nothing is ever scheduled that would have to be waited out.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';

import { usePref } from './prefs';

/** The token names, so a caller never spells a custom property by hand. */
export const MOTION_TOKENS = {
  navOut: '--t-motion-nav-out',
  navIn: '--t-motion-nav-in',
  pill: '--t-motion-pill',
  press: '--t-motion-press',
  commit: '--t-motion-commit',
  tint: '--t-motion-tint',
  reveal: '--t-motion-reveal',
  stagger: '--t-motion-stagger',
  hover: '--t-motion-hover',
  loop: '--t-motion-loop',
  grow: '--t-motion-grow',
  growStandard: '--t-motion-grow-standard',
  growStagger: '--t-motion-grow-stagger',
  arrive: '--t-motion-arrive',
  leave: '--t-motion-leave',
  shift: '--t-motion-shift',
} as const;

export type MotionToken = (typeof MOTION_TOKENS)[keyof typeof MOTION_TOKENS];

/**
 * The vocabulary in milliseconds, the SAME numbers `tokens.css` declares. This is the fallback when
 * no stylesheet is loaded (vitest runs with `css: false`), never a second source of truth:
 * `test/style/motion-tokens.test.mjs` pins each entry to the CSS value by name.
 */
export const MOTION_DEFAULT_MS: Readonly<Record<MotionToken, number>> = {
  '--t-motion-nav-out': 80,
  '--t-motion-nav-in': 200,
  '--t-motion-pill': 120,
  '--t-motion-press': 80,
  '--t-motion-commit': 180,
  '--t-motion-tint': 720,
  '--t-motion-reveal': 200,
  '--t-motion-stagger': 30,
  '--t-motion-hover': 120,
  '--t-motion-loop': 1400,
  '--t-motion-grow': 700,
  '--t-motion-grow-standard': 400,
  '--t-motion-grow-stagger': 60,
  '--t-motion-arrive': 200,
  '--t-motion-leave': 120,
  '--t-motion-shift': 200,
};

/** The class `rowClassName` stamps on the row `useCommitAck` should acknowledge. */
export const COMMIT_TARGET_CLASS = 'motion-commit-target';

/** The attribute the CSS keys the landing and the tint on. */
export const COMMITTED_ATTR = 'data-just-committed';

/** The attribute on `<html>` that tells the entrance CSS which way the surface travels. */
export const NAV_DIRECTION_ATTR = 'data-motion-nav';

export type NavDirection = 'forward' | 'back';

/** True when the OS asks to minimise motion. Guarded for environments without matchMedia (jsdom). */
function osReducesMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// --- Motion levels (D178 point 14) ----------------------------------------------------------------

/** The four levels of the person's `appearance.motion` preference. */
export type MotionLevel = 'lively' | 'standard' | 'calm' | 'off';

/** The engine preference key (`src/core/customization/prefDefs/overview.ts`). */
export const MOTION_PREF = 'appearance.motion';

/** The attribute on `<html>` that carries the level; `motion.css` maps it to what charts and tiles read. */
export const MOTION_LEVEL_ATTR = 'data-motion';

/** The level stamped on the root, Lively (the default) when nothing is stamped yet. */
export function motionLevel(): MotionLevel {
  const raw = typeof document === 'undefined' ? null : document.documentElement.getAttribute(MOTION_LEVEL_ATTR);
  return raw === 'standard' || raw === 'calm' || raw === 'off' ? raw : 'lively';
}

/**
 * True when nothing may move: the OS asks to minimise motion, or the person chose Off (which DESIGN.md
 * defines as "the same as the OS setting"). Every primitive below stamps nothing under it.
 */
export function prefersReducedMotion(): boolean {
  return osReducesMotion() || motionLevel() === 'off';
}

/**
 * Stamp the person's motion level on the root, the deliberate twin of `DensityProvider`'s `data-density`.
 * Mounted once, beside the density provider (`main.tsx`). Renders nothing.
 */
export function MotionLevelStamp(): null {
  const [level] = usePref<MotionLevel>(MOTION_PREF);
  useEffect(() => {
    if (typeof document !== 'undefined') document.documentElement.setAttribute(MOTION_LEVEL_ATTR, level);
  }, [level]);
  return null;
}

/**
 * The Übersicht's headline count-up (Lively only): `target` counted up from zero over `--t-motion-grow`,
 * eased out, final from the first frame under every other level and under reduced motion. ONLY for a
 * headline figure: never in a table, an input, a bank amount or anything a person acts on (DESIGN.md,
 * Motion levels). Integers in, integers out: the caller formats.
 */
export function useCountUp(target: number): number {
  const previous = useRef(0);
  const [shown, setShown] = useState(() => (motionLevel() === 'lively' && !prefersReducedMotion() ? 0 : target));
  useEffect(() => {
    if (motionLevel() !== 'lively' || prefersReducedMotion() || typeof window.requestAnimationFrame !== 'function') {
      setShown(target);
      return undefined;
    }
    const duration = motionMs(MOTION_TOKENS.grow);
    if (duration <= 0) {
      setShown(target);
      return undefined;
    }
    // A changed figure counts on from the one on screen, never from zero again.
    const from = previous.current;
    previous.current = target;
    let frame = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      // The vocabulary's ease-out, approximated by a cubic: fast start, gentle landing.
      const eased = 1 - (1 - t) ** 3;
      setShown(t >= 1 ? target : Math.round(from + (target - from) * eased));
      if (t < 1) frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [target]);
  return shown;
}

/**
 * A motion token's duration in milliseconds, read from the live stylesheet with the mirror table as
 * the fallback. Zero under reduced motion, so a caller that schedules cleanup on this value never
 * waits for a motion that is not happening.
 */
export function motionMs(token: MotionToken): number {
  if (prefersReducedMotion()) return 0;
  if (typeof document !== 'undefined') {
    const raw = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
    const m = /^(\d+(?:\.\d+)?)(ms|s)$/.exec(raw);
    if (m) return m[2] === 's' ? Number(m[1]) * 1000 : Number(m[1]);
  }
  return MOTION_DEFAULT_MS[token];
}

/**
 * Which way a change of surface travels, given the rail's order of surface paths: a move to a
 * later surface is `forward` (the new one enters from the right), to an earlier one `back`. Returns
 * `null` when the move is NOT a navigation in the vocabulary's sense: the same surface (a list to
 * its detail, a route that closes a drawer) or a path outside the rail (the `/w/:id` hop, `/`), so
 * a redirect or a cold load never gets a transition it has no old surface for.
 */
export function navDirection(fromPath: string, toPath: string, order: readonly string[]): NavDirection | null {
  const surfaceOf = (p: string) => `/${p.split('/').filter(Boolean)[0] ?? ''}`;
  const from = surfaceOf(fromPath);
  const to = surfaceOf(toPath);
  if (from === to) return null;
  const fromIndex = order.indexOf(from);
  const toIndex = order.indexOf(to);
  if (fromIndex < 0 || toIndex < 0) return null;
  return toIndex < fromIndex ? 'back' : 'forward';
}

/** The live entrance of the new surface: `<main>` enters in `--t-motion-nav-in` from the travel side. */
function enterSurface(): void {
  const main = document.getElementById('main-content');
  if (main === null) return;
  main.classList.remove('motion-nav-enter');
  // Restart the animation when two entrances land inside one frame.
  void main.offsetWidth;
  main.classList.add('motion-nav-enter');
  window.setTimeout(() => main.classList.remove('motion-nav-enter'), motionMs(MOTION_TOKENS.navIn));
}

/**
 * Run `update` (a DOM change: the router swapping the surface) as the Navigate moment: the new
 * surface enters in `--t-motion-nav-in` (a fade) from `--t-travel` on the travel side, the travel
 * settling in the `--t-motion-nav-out` beat. The animation itself is CSS (`motion.css`); the
 * entrance is started inside the same update so it is in the new state from its first frame.
 *
 * WHY THE OLD SURFACE DOES NOT LEAVE (measured 2026-09-05, on the harness Chromium). D122 D-I
 * asked for the old surface to leave in 80 ms, and the View Transitions API is the one way to keep
 * it on screen without a motion library. It was built, with `::view-transition { pointer-events:
 * none }` as the documentation advises, and measured: a raw pointer click at "Neue Buchung" issued
 * 150 ms after the rail click, while the transition ran, hit `html` and was LOST, four of four (the
 * composer never opened); the act after a navigation cost 325 ms median with nothing but the 80 ms
 * exit inside the transition, against 172 ms with the transition nulled; and three transition
 * animations ran when one was declared, the user agent's group animations, which is why its life
 * was about 250 ms and not 80. A courtesy that eats a click is the thing DESIGN.md forbids by name
 * ("a transition never fights the pointer"), so the exit was withdrawn and the API stays unused
 * here. The entrance alone costs nothing: the same act measured level with reduced motion.
 *
 * Under reduced motion the update runs bare and no attribute is set.
 */
export function navigate(update: () => void | Promise<void>, opts: { direction?: NavDirection } = {}): Promise<void> {
  const root = typeof document === 'undefined' ? null : document.documentElement;
  if (root === null || prefersReducedMotion()) {
    root?.removeAttribute(NAV_DIRECTION_ATTR);
    return Promise.resolve(update()).then(() => undefined);
  }
  root.setAttribute(NAV_DIRECTION_ATTR, opts.direction ?? 'forward');
  return Promise.resolve(update()).then(() => enterSurface());
}

/**
 * Acknowledge a commit on `el`: stamp `data-just-committed` so the CSS lands the row from 8 px above
 * in `--t-motion-commit` and decays an accent-soft tint over `--t-motion-tint`, then lift the stamp
 * when the tint is gone. Returns a cancel function for an unmount mid-tint. Under reduced motion
 * nothing is stamped: there is no motion to acknowledge with, and the words carry the ack.
 */
export function commitAck(el: Element | null): () => void {
  if (el === null || prefersReducedMotion()) return () => undefined;
  el.setAttribute(COMMITTED_ATTR, '');
  const timer = window.setTimeout(() => el.removeAttribute(COMMITTED_ATTR), motionMs(MOTION_TOKENS.tint));
  return () => {
    window.clearTimeout(timer);
    el.removeAttribute(COMMITTED_ATTR);
  };
}

/**
 * Acknowledge the DataTable row that `rowClassName` stamped with `COMMIT_TARGET_CLASS`. A DataTable
 * exposes a class hook and no attribute hook, and the row only exists once the list has refetched,
 * so the hook re-runs whenever `rows` changes and acknowledges each `id` exactly once.
 *
 * Usage: `useCommitAck(justPostedId, entries)` beside
 * `rowClassName={(e) => (e.id === justPostedId ? COMMIT_TARGET_CLASS : undefined)}`.
 */
export function useCommitAck(id: string | null, rows: unknown): void {
  // Refs, not state: acknowledging must not re-render the list, and the cancel belongs to the
  // unmount alone (an effect cleanup on a dependency change would lift the stamp it just set).
  const acked = useRef<string | null>(null);
  const cancels = useRef<Array<() => void>>([]);
  useEffect(() => {
    if (id === null || acked.current === id) return;
    const targets = document.querySelectorAll(`.${COMMIT_TARGET_CLASS}`);
    if (targets.length === 0) return;
    acked.current = id;
    cancels.current = Array.from(targets, (el) => commitAck(el));
    // `rows` is the trigger: the row appears only after the refetch renders it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, rows]);
  useEffect(
    () => () => {
      cancels.current.forEach((cancel) => cancel());
    },
    [],
  );
}

/**
 * The stateful twin for a hand-rolled `<tr>` (Payments, Reconciliation): `ack(id)` marks an id as
 * just committed and the hook clears it once the tint has decayed. The row renders
 * `data-just-committed={ackId === row.id ? '' : undefined}` itself. Under reduced motion `ack` is
 * a no-op, for the same reason `commitAck` is.
 */
export function useCommitAckState(): [string | null, (id: string) => void] {
  const [ackId, setAckId] = useState<string | null>(null);
  useEffect(() => {
    if (ackId === null) return undefined;
    const timer = window.setTimeout(() => setAckId(null), motionMs(MOTION_TOKENS.tint));
    return () => window.clearTimeout(timer);
  }, [ackId]);
  const ack = useCallback((id: string) => {
    if (!prefersReducedMotion()) setAckId(id);
  }, []);
  return [ackId, ack];
}

/**
 * The shape of the data router this hooks into: `navigate`, the current location, and the
 * subscription. Structural on purpose, so the primitive does not import react-router.
 */
interface NavigableRouter {
  navigate: (...args: never[]) => Promise<void>;
  state: { location: { pathname: string }; historyAction: string };
  subscribe: (fn: (state: { location: { pathname: string }; historyAction: string }) => void) => () => void;
}

/**
 * Wire the Navigate moment into a data router, once. Every `router.navigate` to a DIFFERENT rail
 * surface runs inside `navigate()` with `flushSync`, so the DOM has swapped before the entrance
 * starts (a class added before the swap would animate the old content); a redirect (`replace`), a
 * same-surface move or a path outside the rail runs bare. A history POP (the back button) does not pass through `router.navigate`, so it gets
 * the entrance after the fact, travelling back (nothing leaves: there is no old snapshot to fade).
 *
 * `order` is the rail's surface order, the source of `forward` versus `back`.
 */
export function installMotionNavigation(router: NavigableRouter, order: readonly string[]): void {
  type NavigateFn = (to: unknown, opts?: Record<string, unknown>) => Promise<void>;
  const native = (router.navigate as unknown as NavigateFn).bind(router);
  const patched: NavigateFn = (to, opts) => {
    if (typeof to === 'number' || to === null || to === undefined || opts?.replace === true) return native(to, opts);
    const toPath = typeof to === 'string' ? to : String((to as { pathname?: string }).pathname ?? '');
    const direction = navDirection(router.state.location.pathname, toPath, order);
    if (direction === null) return native(to, opts);
    return navigate(() => native(to, { ...opts, flushSync: true }), { direction });
  };
  (router as { navigate: unknown }).navigate = patched;

  let last = router.state.location.pathname;
  router.subscribe((state) => {
    const previous = last;
    last = state.location.pathname;
    if (state.historyAction !== 'POP') return;
    const direction = navDirection(previous, state.location.pathname, order);
    if (direction === null || prefersReducedMotion() || typeof document === 'undefined') return;
    document.documentElement.setAttribute(NAV_DIRECTION_ATTR, direction);
    enterSurface();
  });
}

// --- Arrive and leave (D204, 15.11.2026) -----------------------------------------------------------

/** The attribute that names an item `arriveLeave` follows (a card, a row). Its value is the item's key. */
export const ARRIVE_KEY_ATTR = 'data-arrive-key';

/** Where each keyed item stood, relative to its container, and the node itself (for its leave copy). */
export interface ArriveLeaveSnapshot {
  items: Map<string, { left: number; top: number; width: number; height: number; node: HTMLElement }>;
}

/** The glide `arriveLeave` started per element, so a second change starts from where the eye is. */
const running = new WeakMap<Element, Animation>();

/** The keyed items directly inside `container` (a nested list keeps its own keys to itself). */
function keyedItems(container: HTMLElement, attr: string): HTMLElement[] {
  return Array.from(container.children).filter((el): el is HTMLElement => el instanceof HTMLElement && el.hasAttribute(attr));
}

function rootToken(name: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback;
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return raw === '' ? fallback : raw;
}

/** True where the Web Animations API can run (jsdom has none): without it every change is instant. */
function canAnimate(el: Element | null): boolean {
  return el !== null && typeof (el as HTMLElement).animate === 'function';
}

/**
 * Where every keyed item inside `container` stands NOW, as the eye sees it (a running glide included).
 * Take it before the change and hand it to `arriveLeave` once the DOM has the new layout.
 */
export function snapshotArrangement(container: HTMLElement | null, attr: string = ARRIVE_KEY_ATTR): ArriveLeaveSnapshot | null {
  if (container === null) return null;
  const box = container.getBoundingClientRect();
  const items: ArriveLeaveSnapshot['items'] = new Map();
  for (const el of keyedItems(container, attr)) {
    const key = el.getAttribute(attr);
    if (key === null) continue;
    const r = el.getBoundingClientRect();
    items.set(key, { left: r.left - box.left, top: r.top - box.top, width: r.width, height: r.height, node: el });
  }
  return { items };
}

/** A static copy of an item that left, for its exit: no ids, nothing focusable, nothing a reader meets. */
function leaveCopy(node: HTMLElement, at: { left: number; top: number; width: number; height: number }): HTMLElement {
  const copy = node.cloneNode(true) as HTMLElement;
  for (const el of [copy, ...copy.querySelectorAll<HTMLElement>('[id]')]) el.removeAttribute('id');
  copy.removeAttribute(ARRIVE_KEY_ATTR);
  copy.setAttribute('aria-hidden', 'true');
  copy.setAttribute('inert', '');
  copy.classList.add('motion-leave-copy');
  copy.style.left = `${at.left}px`;
  copy.style.top = `${at.top}px`;
  copy.style.width = `${at.width}px`;
  copy.style.height = `${at.height}px`;
  return copy;
}

/**
 * Play the change from `before` to the layout the DOM shows now (the Arrive and leave moment, D204).
 *
 *  - An item that is new fades in and scales from `--t-arrive-scale` in `--t-motion-arrive`, eased out.
 *  - An item that left is gone from the layout at once; a detached copy of it fades and shrinks out in
 *    `--t-motion-leave`, eased in, above the page and never in the pointer's way.
 *  - Every item that stayed and moved plays its old-to-new offset on `transform` in `--t-motion-shift`.
 *
 * Only `transform` and `opacity` move. Under reduced motion, the Off level, or without the Web
 * Animations API nothing is scheduled: the new layout simply stands.
 */
export function arriveLeave(container: HTMLElement | null, before: ArriveLeaveSnapshot | null, attr: string = ARRIVE_KEY_ATTR): void {
  if (container === null || before === null || prefersReducedMotion() || !canAnimate(container)) return;
  const items = keyedItems(container, attr);
  // A glide still running would falsify where an item stands now: end it first, then measure.
  for (const el of items) {
    running.get(el)?.cancel();
    running.delete(el);
  }
  const box = container.getBoundingClientRect();
  const out = rootToken('--t-ease-out', 'cubic-bezier(0.2, 0, 0, 1)');
  const scaleRaw = Number.parseFloat(rootToken('--t-arrive-scale', '0.98'));
  const scale = Number.isFinite(scaleRaw) && scaleRaw > 0 ? scaleRaw : 0.98;
  const seen = new Set<string>();
  for (const el of items) {
    const key = el.getAttribute(attr);
    if (key === null || !canAnimate(el)) continue;
    seen.add(key);
    const was = before.items.get(key);
    let anim: Animation | null = null;
    if (was === undefined) {
      anim = el.animate([{ opacity: 0, transform: `scale(${scale})` }, { opacity: 1, transform: 'none' }], { duration: motionMs(MOTION_TOKENS.arrive), easing: out });
    } else {
      const r = el.getBoundingClientRect();
      const dx = was.left - (r.left - box.left);
      const dy = was.top - (r.top - box.top);
      if (Math.abs(dx) >= 0.5 || Math.abs(dy) >= 0.5) {
        anim = el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: motionMs(MOTION_TOKENS.shift), easing: out });
      }
    }
    if (anim !== null) {
      const mine = anim;
      running.set(el, mine);
      mine.onfinish = () => {
        if (running.get(el) === mine) running.delete(el);
      };
    }
  }
  for (const [key, was] of before.items) {
    if (seen.has(key) || was.node.isConnected) continue;
    const copy = leaveCopy(was.node, { left: box.left + was.left, top: box.top + was.top, width: was.width, height: was.height });
    document.body.appendChild(copy);
    if (!canAnimate(copy)) {
      copy.remove();
      continue;
    }
    const anim = copy.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: `scale(${scale})` }], {
      duration: motionMs(MOTION_TOKENS.leave),
      easing: rootToken('--t-ease-in', 'cubic-bezier(0.4, 0, 1, 1)'),
      fill: 'forwards',
    });
    const drop = () => copy.remove();
    anim.onfinish = drop;
    anim.oncancel = drop;
  }
}

/**
 * Arrive and leave for a keyed list or grid: whenever `keys` change (an item shown, hidden, moved or
 * gone), the container's items glide from where they stood to where they stand now. Each item carries
 * `data-arrive-key` (`ARRIVE_KEY_ATTR`) with its key and is a DIRECT child of the container.
 *
 * The old arrangement is read while React renders the change (the DOM still shows the old layout then)
 * and played once the new layout is committed, before the browser paints it.
 */
export function useArriveLeave(container: RefObject<HTMLElement | null>, keys: readonly string[], attr: string = ARRIVE_KEY_ATTR): void {
  const signature = keys.join('\u0000');
  const last = useRef<string | null>(null);
  const before = useRef<ArriveLeaveSnapshot | null>(null);
  if (last.current !== signature) {
    // The first render has nothing to play from: the page arrives with the Navigate moment.
    before.current = last.current === null ? null : snapshotArrangement(container.current, attr);
    last.current = signature;
  }
  useLayoutEffect(() => {
    const from = before.current;
    before.current = null;
    if (from !== null) arriveLeave(container.current, from, attr);
    // The signature is the trigger; the container ref and the attribute are fixed for the list's life.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);
}
