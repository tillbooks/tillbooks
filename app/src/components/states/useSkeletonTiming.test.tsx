/**
 * The two placeholder thresholds (K-34, D137): nothing appears before 200ms, and a placeholder that
 * did appear stays at least 300ms.
 *
 * These are unit tests of two hooks with no transport behind them, so they are written, titled and
 * asserted in the vocabulary of time rather than of reads: the read-in-flight convention guard is for
 * surfaces, and nothing here is a read.
 */
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { act, render, renderHook } from '@testing-library/react';

import { I18nProvider } from '../../i18n';
import { Skeleton } from './Skeleton';
import {
  SKELETON_DELAY_MS,
  SKELETON_MIN_VISIBLE_MS,
  useRevealAfterDelay,
  useSkeletonHold,
} from './useSkeletonTiming';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useRevealAfterDelay: nothing appears before 200ms', () => {
  function Probe() {
    const ref = useRevealAfterDelay();
    return <div ref={ref} data-pending="" data-testid="probe" />;
  }

  it('holds the region back for the first 200ms and reveals it after', () => {
    const { getByTestId } = render(<Probe />);
    const node = getByTestId('probe');
    expect(node).toHaveAttribute('data-pending');
    act(() => vi.advanceTimersByTime(SKELETON_DELAY_MS - 1));
    expect(node).toHaveAttribute('data-pending');
    act(() => vi.advanceTimersByTime(1));
    expect(node).not.toHaveAttribute('data-pending');
  });

  it('an unmount before the delay cancels the reveal', () => {
    const { unmount } = render(<Probe />);
    unmount();
    // No timer left behind to touch a detached node.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('the placeholder primitive is in the DOM at once and becomes visible only after the delay', () => {
    const { container } = render(
      <I18nProvider>
        <Skeleton rows={2} />
      </I18nProvider>,
    );
    const region = container.querySelector('.skeleton-region');
    expect(region).not.toBeNull();
    expect(container.querySelectorAll('.skeleton')).toHaveLength(2);
    expect(region).toHaveAttribute('data-pending');
    act(() => vi.advanceTimersByTime(SKELETON_DELAY_MS));
    expect(region).not.toHaveAttribute('data-pending');
  });
});

describe('useSkeletonHold: once shown, at least 300ms', () => {
  it('a read that answers inside 200ms is released at once, never held', () => {
    const { result, rerender } = renderHook(({ on }) => useSkeletonHold(on), {
      initialProps: { on: true },
    });
    expect(result.current).toBe(true);
    act(() => vi.advanceTimersByTime(SKELETON_DELAY_MS - 50));
    rerender({ on: false });
    expect(result.current).toBe(false);
  });

  it('a read that outlasts 200ms keeps the placeholder until it has been visible 300ms', () => {
    const { result, rerender } = renderHook(({ on }) => useSkeletonHold(on), {
      initialProps: { on: true },
    });
    // Visible from 200ms; the answer lands at 250ms, 50ms into the minimum.
    act(() => vi.advanceTimersByTime(SKELETON_DELAY_MS + 50));
    rerender({ on: false });
    expect(result.current).toBe(true);
    act(() => vi.advanceTimersByTime(SKELETON_MIN_VISIBLE_MS - 51));
    expect(result.current).toBe(true);
    act(() => vi.advanceTimersByTime(1));
    expect(result.current).toBe(false);
  });

  it('a read that outlasts the whole minimum is released at once', () => {
    const { result, rerender } = renderHook(({ on }) => useSkeletonHold(on), {
      initialProps: { on: true },
    });
    act(() => vi.advanceTimersByTime(SKELETON_DELAY_MS + SKELETON_MIN_VISIBLE_MS + 10));
    rerender({ on: false });
    expect(result.current).toBe(false);
  });

  it('a new read during the hold ends the hold and starts a fresh window', () => {
    const { result, rerender } = renderHook(({ on }) => useSkeletonHold(on), {
      initialProps: { on: true },
    });
    act(() => vi.advanceTimersByTime(SKELETON_DELAY_MS + 10));
    rerender({ on: false });
    expect(result.current).toBe(true);
    rerender({ on: true });
    expect(result.current).toBe(true);
    // The fresh read answers quickly: released at once, the old hold does not linger.
    act(() => vi.advanceTimersByTime(20));
    rerender({ on: false });
    expect(result.current).toBe(false);
  });

  it('never holds when there was never a read', () => {
    const { result } = renderHook(() => useSkeletonHold(false));
    expect(result.current).toBe(false);
  });
});
