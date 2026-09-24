import { describe, it, expect, beforeEach } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { axe } from 'jest-axe';

import { I18nProvider } from '../i18n';
import { RailResizer } from './RailResizer';
import {
  clampRailWidth,
  readRailPrefs,
  writeRailPrefs,
  RAIL_DEFAULT_WIDTH,
  RAIL_MAX_WIDTH,
  RAIL_MIN_WIDTH,
} from './nav-prefs';

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

describe('nav-prefs: the rail geometry round-trips through storage (D118 A4)', () => {
  beforeEach(() => window.localStorage.clear());

  it('clamps a width into [200, 400] and rounds to a pixel', () => {
    expect(clampRailWidth(120)).toBe(RAIL_MIN_WIDTH);
    expect(clampRailWidth(999)).toBe(RAIL_MAX_WIDTH);
    expect(clampRailWidth(287.6)).toBe(288);
    expect(clampRailWidth(Number.NaN)).toBe(RAIL_DEFAULT_WIDTH);
  });

  it('reads the default geometry when nothing is stored', () => {
    expect(readRailPrefs('ws_1')).toEqual({ width: RAIL_DEFAULT_WIDTH, collapsed: false });
  });

  it('persists and reloads the width and the collapsed flag per workspace', () => {
    writeRailPrefs('ws_1', { width: 320, collapsed: true });
    expect(readRailPrefs('ws_1')).toEqual({ width: 320, collapsed: true });
    // A different workspace does not see it.
    expect(readRailPrefs('ws_2')).toEqual({ width: RAIL_DEFAULT_WIDTH, collapsed: false });
  });

  it('discards a corrupted or out-of-range stored value rather than trusting it', () => {
    window.localStorage.setItem('till-nav-rail:ws_1', 'not json');
    expect(readRailPrefs('ws_1')).toEqual({ width: RAIL_DEFAULT_WIDTH, collapsed: false });
    writeRailPrefs('ws_1', { width: 9999, collapsed: false });
    expect(readRailPrefs('ws_1').width).toBe(RAIL_MAX_WIDTH); // re-clamped on read
  });
});
