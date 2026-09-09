import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { DensityProvider, useDensity, DENSITY_STORAGE_KEY } from './density';

/** A tiny consumer that shows the density and offers the toggle. */
function Probe() {
  const { density, toggle } = useDensity();
  return (
    <>
      <span data-testid="density">{density}</span>
      <button type="button" onClick={toggle}>
        flip
      </button>
    </>
  );
}

/** A minimal in-memory Storage, so the suite does not depend on the jsdom localStorage shape. */
function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key: string) => (map.has(key) ? (map.get(key) as string) : null),
    key: (index: number) => Array.from(map.keys())[index] ?? null,
    removeItem: (key: string) => {
      map.delete(key);
    },
    setItem: (key: string, value: string) => {
      map.set(key, String(value));
    },
  };
}

describe('DensityProvider', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'localStorage', {
      value: memoryStorage(),
      configurable: true,
      writable: true,
    });
    document.documentElement.removeAttribute('data-density');
  });

  it('defaults to Komfortabel and stamps data-density, without persisting the default', () => {
    render(
      <DensityProvider>
        <Probe />
      </DensityProvider>,
    );
    expect(screen.getByTestId('density')).toHaveTextContent('komfortabel');
    expect(document.documentElement.getAttribute('data-density')).toBe('komfortabel');
    // A default is not a choice: nothing is written until the operator picks.
    expect(window.localStorage.getItem(DENSITY_STORAGE_KEY)).toBeNull();
  });

  it('restores a stored Kompakt choice on load, before the toggle is touched', () => {
    window.localStorage.setItem(DENSITY_STORAGE_KEY, 'kompakt');
    render(
      <DensityProvider>
        <Probe />
      </DensityProvider>,
    );
    expect(screen.getByTestId('density')).toHaveTextContent('kompakt');
    expect(document.documentElement.getAttribute('data-density')).toBe('kompakt');
  });

  it('ignores a corrupt stored value and falls back to Komfortabel', () => {
    window.localStorage.setItem(DENSITY_STORAGE_KEY, 'cosy');
    render(
      <DensityProvider>
        <Probe />
      </DensityProvider>,
    );
    expect(screen.getByTestId('density')).toHaveTextContent('komfortabel');
  });

  it('toggles to Kompakt, flips data-density, and persists the choice', async () => {
    render(
      <DensityProvider>
        <Probe />
      </DensityProvider>,
    );
    expect(screen.getByTestId('density')).toHaveTextContent('komfortabel');

    await userEvent.click(screen.getByRole('button', { name: 'flip' }));

    expect(screen.getByTestId('density')).toHaveTextContent('kompakt');
    expect(document.documentElement.getAttribute('data-density')).toBe('kompakt');
    expect(window.localStorage.getItem(DENSITY_STORAGE_KEY)).toBe('kompakt');

    // And back again, so the toggle is a real flip, not a one-way latch.
    await userEvent.click(screen.getByRole('button', { name: 'flip' }));
    expect(screen.getByTestId('density')).toHaveTextContent('komfortabel');
    expect(window.localStorage.getItem(DENSITY_STORAGE_KEY)).toBe('komfortabel');
  });

  it('does not throw when localStorage is unavailable (private mode)', () => {
    Object.defineProperty(window, 'localStorage', {
      get() {
        throw new Error('storage disabled');
      },
      configurable: true,
    });
    expect(() =>
      render(
        <DensityProvider>
          <Probe />
        </DensityProvider>,
      ),
    ).not.toThrow();
    expect(screen.getByTestId('density')).toHaveTextContent('komfortabel');
  });

  it('throws when used outside a provider (a wiring bug, not a runtime state)', () => {
    // Silence the expected React error boundary log for this one deliberate throw.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<Probe />)).toThrow(/DensityProvider/);
    spy.mockRestore();
  });
});
