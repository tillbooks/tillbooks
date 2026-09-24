/**
 * The motion primitives (D122 D-I): what moves is CSS, so what these assert is the SCRIPT half's
 * contract: which element is stamped, when the stamp lifts, that the entrance runs (and nothing
 * under reduced motion), that no view transition is ever asked for, which way a move travels, and
 * that the durations the script schedules on come from the tokens with the mirror table as the
 * fallback.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

import {
  COMMITTED_ATTR,
  COMMIT_TARGET_CLASS,
  MOTION_DEFAULT_MS,
  MOTION_TOKENS,
  NAV_DIRECTION_ATTR,
  commitAck,
  installMotionNavigation,
  motionMs,
  navDirection,
  navigate,
  prefersReducedMotion,
  useCommitAck,
  useCommitAckState,
} from './motion';

/** Install a matchMedia that answers the reduced-motion query with `reduce`. */
function reduceMotion(matches: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: matches && query.includes('prefers-reduced-motion'),
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

afterEach(() => {
  Reflect.deleteProperty(window, 'matchMedia');
  document.documentElement.removeAttribute(NAV_DIRECTION_ATTR);
  document.body.innerHTML = '';
  vi.useRealTimers();
});

describe('the token bridge', () => {
  it('falls back to the mirror table when no stylesheet defines the token (vitest runs css:false)', () => {
    expect(motionMs(MOTION_TOKENS.tint)).toBe(MOTION_DEFAULT_MS['--t-motion-tint']);
    expect(motionMs(MOTION_TOKENS.navIn)).toBe(200);
    expect(motionMs(MOTION_TOKENS.stagger)).toBe(30);
  });

  it('reads a live token when the document defines one, in ms or s', () => {
    document.documentElement.style.setProperty(MOTION_TOKENS.reveal, '0.25s');
    document.documentElement.style.setProperty(MOTION_TOKENS.press, '90ms');
    // jsdom resolves inline custom properties through getComputedStyle.
    expect(motionMs(MOTION_TOKENS.reveal)).toBe(250);
    expect(motionMs(MOTION_TOKENS.press)).toBe(90);
    document.documentElement.style.removeProperty(MOTION_TOKENS.reveal);
    document.documentElement.style.removeProperty(MOTION_TOKENS.press);
  });

  it('is zero under reduced motion, so nothing schedules a wait for a motion that is not happening', () => {
    reduceMotion(true);
    expect(prefersReducedMotion()).toBe(true);
    expect(motionMs(MOTION_TOKENS.tint)).toBe(0);
  });

  it('treats an environment without matchMedia as motion allowed', () => {
    expect(prefersReducedMotion()).toBe(false);
  });
});

describe('navDirection', () => {
  const order = ['/overview', '/journal', '/documents', '/payments'];

  it('is forward to a later rail surface and back to an earlier one', () => {
    expect(navDirection('/overview', '/journal', order)).toBe('forward');
    expect(navDirection('/payments', '/journal', order)).toBe('back');
  });

  it('is null for a same-surface move (a list to its detail, a route closing a drawer)', () => {
    expect(navDirection('/documents', '/documents/doc_1', order)).toBeNull();
    expect(navDirection('/payments/new', '/payments', order)).toBeNull();
  });

  it('is null when either side is outside the rail (a redirect, the /w/ hop, a cold load)', () => {
    expect(navDirection('/', '/overview', order)).toBeNull();
    expect(navDirection('/w/ws_1', '/overview', order)).toBeNull();
    expect(navDirection('/journal', '/nowhere', order)).toBeNull();
  });
});

describe('navigate', () => {
  it('runs the update, stamps the travel direction, and enters <main> live, lifting the class after nav-in', async () => {
    vi.useFakeTimers();
    const main = document.createElement('main');
    main.id = 'main-content';
    document.body.append(main);
    const update = vi.fn();
    await navigate(update, { direction: 'back' });
    expect(update).toHaveBeenCalledTimes(1);
    expect(document.documentElement.getAttribute(NAV_DIRECTION_ATTR)).toBe('back');
    expect(main.classList.contains('motion-nav-enter')).toBe(true);
    vi.advanceTimersByTime(MOTION_DEFAULT_MS['--t-motion-nav-in']);
    expect(main.classList.contains('motion-nav-enter')).toBe(false);
  });

  it('defaults the direction to forward', async () => {
    await navigate(() => undefined);
    expect(document.documentElement.getAttribute(NAV_DIRECTION_ATTR)).toBe('forward');
  });

  it('never asks for a view transition: a transition holds the pointer and eats the next click (measured)', async () => {
    const start = vi.fn();
    (document as { startViewTransition?: unknown }).startViewTransition = start;
    try {
      await navigate(() => undefined);
      expect(start).not.toHaveBeenCalled();
    } finally {
      Reflect.deleteProperty(document, 'startViewTransition');
    }
  });

  it('runs the update bare under reduced motion: no direction stamp, no entrance class', async () => {
    reduceMotion(true);
    const main = document.createElement('main');
    main.id = 'main-content';
    document.body.append(main);
    const update = vi.fn();
    await navigate(update, { direction: 'forward' });
    expect(update).toHaveBeenCalledTimes(1);
    expect(document.documentElement.hasAttribute(NAV_DIRECTION_ATTR)).toBe(false);
    expect(main.classList.contains('motion-nav-enter')).toBe(false);
  });

  it('tolerates a document without <main>', async () => {
    await expect(navigate(() => undefined)).resolves.toBeUndefined();
  });
});

describe('commitAck', () => {
  it('stamps data-just-committed and lifts it once the tint has decayed', () => {
    vi.useFakeTimers();
    const row = document.createElement('tr');
    document.body.append(row);
    commitAck(row);
    expect(row.hasAttribute(COMMITTED_ATTR)).toBe(true);
    vi.advanceTimersByTime(MOTION_DEFAULT_MS['--t-motion-tint'] - 1);
    expect(row.hasAttribute(COMMITTED_ATTR)).toBe(true);
    vi.advanceTimersByTime(1);
    expect(row.hasAttribute(COMMITTED_ATTR)).toBe(false);
  });

  it('returns a cancel that lifts the stamp early (an unmount mid-tint)', () => {
    vi.useFakeTimers();
    const row = document.createElement('tr');
    const cancel = commitAck(row);
    cancel();
    expect(row.hasAttribute(COMMITTED_ATTR)).toBe(false);
  });

  it('stamps nothing under reduced motion: the words carry the ack', () => {
    reduceMotion(true);
    const row = document.createElement('tr');
    commitAck(row);
    expect(row.hasAttribute(COMMITTED_ATTR)).toBe(false);
  });

  it('tolerates a missing element', () => {
    expect(() => commitAck(null)()).not.toThrow();
  });
});

describe('useCommitAck (the DataTable bridge)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('acknowledges the row rowClassName stamped, once the rows that carry it have rendered', () => {
    const row = document.createElement('tr');
    row.className = COMMIT_TARGET_CLASS;
    const { rerender } = renderHook(({ id, rows }) => useCommitAck(id, rows), {
      initialProps: { id: 'e1' as string | null, rows: [] as string[] },
    });
    // The id is known before the refetch has rendered the row: nothing to stamp yet.
    expect(row.hasAttribute(COMMITTED_ATTR)).toBe(false);
    document.body.append(row);
    rerender({ id: 'e1', rows: ['e1'] });
    expect(row.hasAttribute(COMMITTED_ATTR)).toBe(true);
    act(() => {
      vi.advanceTimersByTime(MOTION_DEFAULT_MS['--t-motion-tint']);
    });
    expect(row.hasAttribute(COMMITTED_ATTR)).toBe(false);
    // A later re-render with the same id does not re-land the row.
    rerender({ id: 'e1', rows: ['e1', 'e2'] });
    expect(row.hasAttribute(COMMITTED_ATTR)).toBe(false);
  });
});

describe('useCommitAckState (the hand-rolled row twin)', () => {
  it('holds the id for the tint and clears it', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useCommitAckState());
    expect(result.current[0]).toBeNull();
    act(() => result.current[1]('p1'));
    expect(result.current[0]).toBe('p1');
    act(() => {
      vi.advanceTimersByTime(MOTION_DEFAULT_MS['--t-motion-tint']);
    });
    expect(result.current[0]).toBeNull();
  });

  it('is a no-op under reduced motion', () => {
    reduceMotion(true);
    const { result } = renderHook(() => useCommitAckState());
    act(() => result.current[1]('p1'));
    expect(result.current[0]).toBeNull();
  });
});

describe('installMotionNavigation (the router hook)', () => {
  const order = ['/overview', '/journal', '/documents'];

  function fakeRouter(pathname: string) {
    const listeners: Array<(s: { location: { pathname: string }; historyAction: string }) => void> = [];
    const native = vi.fn(async (to: unknown) => {
      router.state.location.pathname = typeof to === 'string' ? to : String((to as { pathname: string }).pathname);
    });
    const router = {
      navigate: native as unknown as (...args: never[]) => Promise<void>,
      state: { location: { pathname }, historyAction: 'POP' },
      subscribe: (fn: (typeof listeners)[number]) => {
        listeners.push(fn);
        return () => undefined;
      },
    };
    return { router, native, emit: (s: { location: { pathname: string }; historyAction: string }) => listeners.forEach((l) => l(s)) };
  }

  it('swaps a move between two rail surfaces with flushSync, stamps the direction and enters <main>', async () => {
    vi.useFakeTimers();
    const main = document.createElement('main');
    main.id = 'main-content';
    document.body.append(main);
    const { router, native } = fakeRouter('/overview');
    installMotionNavigation(router, order);
    await (router.navigate as unknown as (to: unknown, opts?: object) => Promise<void>)({ pathname: '/documents' }, { fromRouteId: 'x' });
    expect(native).toHaveBeenCalledWith({ pathname: '/documents' }, { fromRouteId: 'x', flushSync: true });
    expect(document.documentElement.getAttribute(NAV_DIRECTION_ATTR)).toBe('forward');
    expect(main.classList.contains('motion-nav-enter')).toBe(true);
  });

  it('runs a same-surface move, a replace redirect and a numeric history step bare', async () => {
    const main = document.createElement('main');
    main.id = 'main-content';
    document.body.append(main);
    const { router, native } = fakeRouter('/documents');
    installMotionNavigation(router, order);
    const nav = router.navigate as unknown as (to: unknown, opts?: object) => Promise<void>;
    await nav('/documents/doc_1');
    await nav('/journal', { replace: true });
    await nav(-1);
    expect(main.classList.contains('motion-nav-enter')).toBe(false);
    expect(native).toHaveBeenCalledTimes(3);
    expect(native.mock.calls[0]).toEqual(['/documents/doc_1', undefined]);
    expect(native.mock.calls[1]).toEqual(['/journal', { replace: true }]);
  });

  it('gives a history POP between two surfaces the class-based entrance, travelling back', () => {
    vi.useFakeTimers();
    const main = document.createElement('main');
    main.id = 'main-content';
    document.body.append(main);
    const { router, emit } = fakeRouter('/documents');
    installMotionNavigation(router, order);
    emit({ location: { pathname: '/journal' }, historyAction: 'POP' });
    expect(document.documentElement.getAttribute(NAV_DIRECTION_ATTR)).toBe('back');
    expect(main.classList.contains('motion-nav-enter')).toBe(true);
    vi.advanceTimersByTime(200);
    expect(main.classList.contains('motion-nav-enter')).toBe(false);
  });

  it('never animates a POP under reduced motion', () => {
    reduceMotion(true);
    const main = document.createElement('main');
    main.id = 'main-content';
    document.body.append(main);
    const { router, emit } = fakeRouter('/documents');
    installMotionNavigation(router, order);
    emit({ location: { pathname: '/journal' }, historyAction: 'POP' });
    expect(main.classList.contains('motion-nav-enter')).toBe(false);
  });
});
