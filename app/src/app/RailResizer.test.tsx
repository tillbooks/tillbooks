import { describe, it, expect, beforeEach } from 'vitest';
import { useState } from 'react';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { axe } from 'jest-axe';

import { I18nProvider } from '../i18n';
import { resetPrefsModuleForTests } from '../lib/prefs';
import { RailResizer } from './RailResizer';
import {
  clampRailWidth,
  parseRailPrefs,
  resetNavPrefsForTests,
  useRailPrefs,
  RAIL_DEFAULT_WIDTH,
  RAIL_MAX_WIDTH,
  RAIL_MIN_WIDTH,
  RAIL_WRITE_DELAY_MS,
} from './nav-prefs';
import { fakePrefsEngine, renderWithRail } from './rail-test-kit';

/** A controlled harness that mirrors the Shell's ownership of the geometry: it clamps a width change
 *  and expands (exactly as `useRailPrefs.setWidth` does), collapses on request, and resets. The
 *  current geometry is exposed as attributes so a test reads it back without reaching into state. */
function Harness({ initialWidth = RAIL_DEFAULT_WIDTH, initialCollapsed = false }: { initialWidth?: number; initialCollapsed?: boolean }) {
  const [width, setWidth] = useState(initialWidth);
  const [collapsed, setCollapsed] = useState(initialCollapsed);
  return (
    <I18nProvider>
      <div className="frame">
        <nav id="studio-rail" aria-label="rail" />
        <RailResizer
          width={width}
          collapsed={collapsed}
          controlsId="studio-rail"
          onWidthChange={(w) => {
            setWidth(clampRailWidth(w));
            setCollapsed(false);
          }}
          onCollapse={() => setCollapsed(true)}
          onReset={() => {
            setWidth(RAIL_DEFAULT_WIDTH);
            setCollapsed(false);
          }}
        />
        <output data-testid="width">{width}</output>
        <output data-testid="collapsed">{String(collapsed)}</output>
      </div>
    </I18nProvider>
  );
}

const sep = () => screen.getByRole('separator');
const width = () => screen.getByTestId('width').textContent;
const collapsed = () => screen.getByTestId('collapsed').textContent;

/** jsdom ships no `PointerEvent` and drops `clientX` off a synthetic pointer event, so a real
 *  `MouseEvent` (which carries a genuine `clientX`) is dispatched under the pointer event's type. React
 *  reads `clientX` off the native event, so the drag maths sees real coordinates. */
const firePointer = (type: 'pointerdown' | 'pointermove' | 'pointerup', clientX: number): void => {
  fireEvent(sep(), new MouseEvent(type, { clientX, button: 0, bubbles: true, cancelable: true }));
};

describe('RailResizer: the WAI-ARIA window splitter (D118 A4)', () => {
  it('exposes the separator contract: vertical, bounded, controlling the rail, with a name', () => {
    render(<Harness />);
    const s = sep();
    expect(s).toHaveAttribute('aria-orientation', 'vertical');
    expect(s).toHaveAttribute('aria-controls', 'studio-rail');
    expect(s).toHaveAttribute('aria-valuemin', String(RAIL_MIN_WIDTH));
    expect(s).toHaveAttribute('aria-valuemax', String(RAIL_MAX_WIDTH));
    expect(s).toHaveAttribute('aria-valuenow', String(RAIL_DEFAULT_WIDTH));
    expect(s).toHaveAttribute('tabindex', '0');
    // The de-CH default locale, real umlauts.
    expect(s).toHaveAccessibleName('Navigationsbreite anpassen');
  });

  it('resizes by a 16px step on Left/Right and tracks it in aria-valuenow', () => {
    render(<Harness />);
    fireEvent.keyDown(sep(), { key: 'ArrowRight' });
    expect(sep()).toHaveAttribute('aria-valuenow', '256');
    expect(width()).toBe('256');
    fireEvent.keyDown(sep(), { key: 'ArrowLeft' });
    fireEvent.keyDown(sep(), { key: 'ArrowLeft' });
    expect(sep()).toHaveAttribute('aria-valuenow', '224');
  });

  it('clamps at the bounds: Home to the minimum, End to the maximum, no overshoot', () => {
    render(<Harness />);
    fireEvent.keyDown(sep(), { key: 'End' });
    expect(width()).toBe(String(RAIL_MAX_WIDTH));
    fireEvent.keyDown(sep(), { key: 'ArrowRight' });
    expect(width()).toBe(String(RAIL_MAX_WIDTH)); // stays at 400
    fireEvent.keyDown(sep(), { key: 'Home' });
    expect(width()).toBe(String(RAIL_MIN_WIDTH));
    fireEvent.keyDown(sep(), { key: 'ArrowLeft' });
    expect(width()).toBe(String(RAIL_MIN_WIDTH)); // stays at 200, never collapses on an arrow
    expect(collapsed()).toBe('false');
  });

  it('double-click resets to the default width', () => {
    render(<Harness initialWidth={RAIL_MAX_WIDTH} />);
    expect(width()).toBe(String(RAIL_MAX_WIDTH));
    fireEvent.doubleClick(sep());
    expect(width()).toBe(String(RAIL_DEFAULT_WIDTH));
  });

  it('Enter collapses an expanded rail and restores a collapsed one (the APG action)', () => {
    render(<Harness initialWidth={320} />);
    fireEvent.keyDown(sep(), { key: 'Enter' });
    expect(collapsed()).toBe('true');
    // While collapsed the value clamps to the minimum: the range describes the expanded rail.
    expect(sep()).toHaveAttribute('aria-valuenow', String(RAIL_MIN_WIDTH));
    fireEvent.keyDown(sep(), { key: 'Enter' });
    expect(collapsed()).toBe('false');
    expect(width()).toBe('320'); // the last expanded width is restored
  });

  it('a free drag resizes within the range', () => {
    render(<Harness />);
    firePointer('pointerdown', 300);
    firePointer('pointermove', 350); // dx +50 -> 290
    expect(width()).toBe('290');
    firePointer('pointerup', 350);
  });

  it('dragging below the minimum snaps to the collapsed icon strip', () => {
    render(<Harness />);
    firePointer('pointerdown', 300);
    firePointer('pointermove', 160); // dx -140 -> 100, below the snap threshold
    expect(collapsed()).toBe('true');
    firePointer('pointerup', 160);
  });

  it('dragging the collapsed strip back out restores an expanded rail', () => {
    render(<Harness initialCollapsed initialWidth={240} />);
    // Rendered width while collapsed is the 56px icon strip, so a +200px drag proposes ~256px.
    firePointer('pointerdown', 100);
    firePointer('pointermove', 300); // dx +200 -> 56 + 200 = 256
    expect(collapsed()).toBe('false');
    expect(width()).toBe('256');
    firePointer('pointerup', 300);
  });

  it('has no axe violations in either theme', async () => {
    const { container, rerender } = render(<Harness />);
    document.documentElement.setAttribute('data-theme', 'light');
    expect(await axe(container)).toHaveNoViolations();
    document.documentElement.setAttribute('data-theme', 'dark');
    rerender(<Harness />);
    expect(await axe(container)).toHaveNoViolations();
    document.documentElement.removeAttribute('data-theme');
  });
});

describe('nav-prefs: the rail geometry is the nav.rail preference (D118 A4, D178)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetPrefsModuleForTests();
    resetNavPrefsForTests();
  });

  it('clamps a width into [200, 400] and rounds to a pixel', () => {
    expect(clampRailWidth(120)).toBe(RAIL_MIN_WIDTH);
    expect(clampRailWidth(999)).toBe(RAIL_MAX_WIDTH);
    expect(clampRailWidth(287.6)).toBe(288);
    expect(clampRailWidth(Number.NaN)).toBe(RAIL_DEFAULT_WIDTH);
  });

  it('reads a malformed or out-of-range value as the default, re-clamped, never trusted', () => {
    expect(parseRailPrefs(undefined)).toEqual({ width: RAIL_DEFAULT_WIDTH, collapsed: false });
    expect(parseRailPrefs('not an object')).toEqual({ width: RAIL_DEFAULT_WIDTH, collapsed: false });
    expect(parseRailPrefs({ width: 9999, collapsed: 'yes' })).toEqual({ width: RAIL_MAX_WIDTH, collapsed: false });
    expect(parseRailPrefs({ width: 320, collapsed: true })).toEqual({ width: 320, collapsed: true });
  });

  /** Drives `useRailPrefs` the way the splitter does. */
  function Probe() {
    const { width, collapsed, setWidth, setCollapsed } = useRailPrefs();
    return (
      <>
        <output data-testid="w">{width}</output>
        <output data-testid="c">{String(collapsed)}</output>
        <button type="button" onClick={() => [250, 260, 270, 280].forEach((w) => setWidth(w))}>
          drag
        </button>
        <button type="button" onClick={() => setCollapsed(true)}>
          collapse
        </button>
      </>
    );
  }

  it('moves the rail at once during a drag and writes ONE preference once the resize rests', async () => {
    const engine = fakePrefsEngine();
    renderWithRail(<Probe />, { engine });
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'drag' }));
    expect(screen.getByTestId('w').textContent).toBe('280');
    expect(engine.calls.filter((c) => c.action === 'prefs_set')).toHaveLength(0);
    await waitFor(() => expect(engine.get('ws_a', 'nav.rail')).toEqual({ width: 280, collapsed: false }), {
      timeout: RAIL_WRITE_DELAY_MS * 5,
    });
    expect(engine.calls.filter((c) => c.action === 'prefs_set' && c.input.key === 'nav.rail')).toHaveLength(1);
  });

  it('keeps the stored width while collapsed, per workspace', async () => {
    const engine = fakePrefsEngine();
    engine.put('ws_a', 'nav.rail', { width: 320, collapsed: false });
    const { unmount } = renderWithRail(<Probe />, { engine });
    await waitFor(() => expect(screen.getByTestId('w').textContent).toBe('320'));
    fireEvent.click(screen.getByRole('button', { name: 'collapse' }));
    await waitFor(() => expect(engine.get('ws_a', 'nav.rail')).toEqual({ width: 320, collapsed: true }));
    unmount();
    renderWithRail(<Probe />, { engine, workspaceId: 'ws_b' });
    await act(async () => {});
    expect(screen.getByTestId('w').textContent).toBe(String(RAIL_DEFAULT_WIDTH));
    expect(screen.getByTestId('c').textContent).toBe('false');
  });
});
