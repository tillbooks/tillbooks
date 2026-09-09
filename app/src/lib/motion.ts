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
 *
 * NO MOTION LIBRARY (DESIGN.md, Dependencies). CSS transitions and the native View Transitions API
 * only. Everything here is under 150 lines because that is the size of the problem.
 *
 * REDUCED MOTION IS A KILL SWITCH. `tokens.css` zeroes every duration and delay under the setting;
 * this file additionally stamps nothing under it (no direction, no entrance class, no tint), so
 * nothing is ever scheduled that would have to be waited out.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

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
};

/** The class `rowClassName` stamps on the row `useCommitAck` should acknowledge. */
export const COMMIT_TARGET_CLASS = 'motion-commit-target';

/** The attribute the CSS keys the landing and the tint on. */
export const COMMITTED_ATTR = 'data-just-committed';

/** The attribute on `<html>` that tells the entrance CSS which way the surface travels. */
export const NAV_DIRECTION_ATTR = 'data-motion-nav';

export type NavDirection = 'forward' | 'back';

/** True when the OS asks to minimise motion. Guarded for environments without matchMedia (jsdom). */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
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
