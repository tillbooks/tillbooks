/**
 * D178 point 14, the motion levels: the person's level is stamped on the root, Off reads as reduced
 * motion to every primitive, the OS setting beats every level, and the count-up runs under Lively only.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, renderHook } from '@testing-library/react';

import { MOTION_LEVEL_ATTR, MotionLevelStamp, commitAck, motionLevel, prefersReducedMotion, useCountUp } from './motion';
import { PrefsProvider, PrefsStore } from './prefs';
import { TillClientProvider } from './client-context';
import { TillClient, type Transport } from './client';
import { WorkspaceProvider } from '../app/workspace';

const silent: Transport = async () => ({ status: 404, body: { ok: false, error: 'unknown_action' } });

function osReduce(matches: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: matches && query.includes('prefers-reduced-motion'),
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
    onchange: null,
  })) as unknown as typeof window.matchMedia;
}

afterEach(() => {
  document.documentElement.removeAttribute(MOTION_LEVEL_ATTR);
  osReduce(false);
  vi.useRealTimers();
});

describe('motion levels', () => {
  it('stamps the person\'s level on the root, Lively by default', () => {
    render(<MotionLevelStamp />);
    expect(document.documentElement.getAttribute(MOTION_LEVEL_ATTR)).toBe('lively');
    const store = new PrefsStore(null, null, { useCache: false });
    store.seed('appearance.motion', 'calm');
    render(
      <TillClientProvider client={new TillClient(silent)}>
        <WorkspaceProvider initialId="ws_test">
          <PrefsProvider store={store}>
            <MotionLevelStamp />
          </PrefsProvider>
        </WorkspaceProvider>
      </TillClientProvider>,
    );
    expect(motionLevel()).toBe('calm');
  });

  it('Off is reduced motion for every primitive: nothing is stamped on a commit', () => {
    document.documentElement.setAttribute(MOTION_LEVEL_ATTR, 'off');
    expect(prefersReducedMotion()).toBe(true);
    const row = document.createElement('div');
    commitAck(row);
    expect(row.hasAttribute('data-just-committed')).toBe(false);
  });

  it('the count-up is final at once under Calm, Standard and the OS setting', () => {
    for (const level of ['calm', 'standard']) {
      document.documentElement.setAttribute(MOTION_LEVEL_ATTR, level);
      expect(renderHook(() => useCountUp(4200)).result.current).toBe(4200);
    }
    document.documentElement.setAttribute(MOTION_LEVEL_ATTR, 'lively');
    osReduce(true);
    expect(renderHook(() => useCountUp(4200)).result.current).toBe(4200);
  });

  it('under Lively the figure counts up from zero and lands on the target', async () => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance'] });
    document.documentElement.setAttribute(MOTION_LEVEL_ATTR, 'lively');
    const { result } = renderHook(() => useCountUp(4200));
    expect(result.current).toBe(0);
    await act(async () => {
      vi.advanceTimersByTime(800);
    });
    expect(result.current).toBe(4200);
  });
});
