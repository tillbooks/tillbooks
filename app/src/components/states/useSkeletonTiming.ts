/**
 * The two loading thresholds (K-34, D137): nothing appears before 200ms, and a skeleton that did
 * appear stays at least 300ms.
 *
 * WHY. TILL is local first: most reads are a SQLite query that answers in ten milliseconds. A skeleton
 * painted on every read is then a flash on every route change, which is worse than nothing. And a
 * skeleton that appears at 190ms and is swapped for the data at 210ms is a flicker. Stripe delays its
 * loading indicator 200 to 300ms and Vercel keeps one visible 300 to 500ms once shown; these are the
 * same two numbers as one rule.
 *
 * TWO HOOKS, because the two halves live in different places:
 *
 *   - `useRevealAfterDelay` is the skeleton's own: a ref callback that keeps the element rendered but
 *     invisible (`data-pending`, hidden by `states.css`) for the first 200ms, then reveals it. It
 *     touches the DOM directly rather than setting React state, so a test that keeps a skeleton up
 *     never sees a state update it did not wrap in `act()`. The element is in the DOM from the first
 *     commit, `role="status"` included, so every "the read is in flight" assertion still holds.
 *   - `useSkeletonHold` is the caller's: it answers "should I still render the skeleton?". It is
 *     `loading`, extended until the skeleton has been visible 300ms when a read outlasted the 200ms
 *     delay. A read that finished before the delay never showed a skeleton and is never held.
 *
 * Chrome never skeletons (rail, tabs, headers, buttons, inputs, menus, dialogs): only a region whose
 * shape is known and whose data is on its way.
 */
import { useCallback, useEffect, useRef, useState, type RefCallback } from 'react';

/** Nothing appears before this (DESIGN.md, The five states: loading; K-34). */
export const SKELETON_DELAY_MS = 200;

/** A skeleton that did appear stays at least this long, so it never flickers. */
export const SKELETON_MIN_VISIBLE_MS = 300;

/**
 * A ref callback for a skeleton root rendered with `data-pending=""`: the attribute (and with it the
 * `visibility: hidden` in `states.css`) is removed after `delay`. Unmounting before then cancels it.
 */
export function useRevealAfterDelay(delay: number = SKELETON_DELAY_MS): RefCallback<HTMLElement> {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  return useCallback(
    (node: HTMLElement | null) => {
      if (timer.current !== null) {
        clearTimeout(timer.current);
        timer.current = null;
      }
      if (node === null) return;
      timer.current = setTimeout(() => {
        node.removeAttribute('data-pending');
        timer.current = null;
      }, delay);
    },
    [delay],
  );
}

/**
 * Whether a skeleton should still be on screen: while `loading`, and after it for the rest of the
 * 300ms minimum when the read outlasted the 200ms delay (so the skeleton was visible). A read that
 * answered inside the delay returns `false` the moment it lands.
 */
export function useSkeletonHold(loading: boolean): boolean {
  const startedAt = useRef<number | null>(loading ? Date.now() : null);
  const [previous, setPrevious] = useState(loading);
  const [holdUntil, setHoldUntil] = useState<number | null>(null);

  // Derived during render, not in an effect, so the frame that receives `loading = false` already
  // knows whether to hold: an effect would paint the data for one frame and then swap the skeleton
  // back in, which is the flicker this exists to prevent.
  if (loading !== previous) {
    setPrevious(loading);
    if (loading) {
      startedAt.current = Date.now();
      if (holdUntil !== null) setHoldUntil(null);
    } else {
      const started = startedAt.current;
      startedAt.current = null;
      if (started !== null) {
        const revealedAt = started + SKELETON_DELAY_MS;
        const until = revealedAt + SKELETON_MIN_VISIBLE_MS;
        const now = Date.now();
        if (now >= revealedAt && now < until) setHoldUntil(until);
      }
    }
  }

  useEffect(() => {
    if (holdUntil === null) return undefined;
    const id = setTimeout(() => setHoldUntil(null), Math.max(0, holdUntil - Date.now()));
    return () => clearTimeout(id);
  }, [holdUntil]);

  return loading || holdUntil !== null;
}
