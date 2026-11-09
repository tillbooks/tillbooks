/**
 * The density provider over the `appearance.density` preference (D178 point 7): Komfortabel by default,
 * a real two-way toggle stamped on the document, the engine's value inside the preference store, and
 * the browser-only `till-density` of earlier builds moved into the engine once.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { DensityProvider, useDensity, DENSITY_STORAGE_KEY, importLegacyDensity } from './density';
import { WorkspaceProvider } from './workspace';
import { TillClientProvider } from '../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../lib/client';
import { PrefsProvider, resetPrefsModuleForTests } from '../lib/prefs';

/** Await an outcome whose path updates React state, inside act (the console guard refuses a stray update). */
async function settle<T>(work: Promise<T> | (() => Promise<T>)): Promise<T> {
  let value!: T;
  await act(async () => {
    value = await (typeof work === 'function' ? work() : work);
  });
  return value;
}

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

/** A fake engine holding one density value. */
function engineWith(density: string | null) {
  let stored = density;
  const sets: Record<string, unknown>[] = [];
  const transport: Transport = async (action, input): Promise<RestResponse> => {
    if (action === 'prefs_list') {
      return {
        status: 200,
        body: {
          ok: true,
          prefs: [
            {
              key: 'appearance.density',
              value: stored ?? 'komfortabel',
              default: 'komfortabel',
              isDefault: stored === null,
              stale: false,
              scope: 'person',
              schema: { type: 'enum', values: ['komfortabel', 'kompakt'] },
              area: { id: 'appearance', label: { en: 'Appearance', 'de-CH': 'Darstellung' } },
              label: { en: 'Density', 'de-CH': 'Dichte' },
              description: { en: 'x', 'de-CH': 'x' },
              valueLabels: null,
              updatedAt: null,
            },
          ],
          areas: [],
        },
      };
    }
    if (action === 'prefs_set') {
      sets.push(input);
      const previous = stored ?? 'komfortabel';
      stored = input.value as string;
      return { status: 200, body: { ok: true, key: input.key, value: input.value, previousValue: previous, isDefault: false, changed: true } };
    }
    return { status: 404, body: { ok: false, error: 'unknown_action' } };
  };
  return { transport, sets, stored: () => stored };
}

function inStore(transport: Transport) {
  return render(
    <TillClientProvider client={new TillClient(transport)}>
      <WorkspaceProvider initialId="ws_test">
        <PrefsProvider>
          <DensityProvider>
            <Probe />
          </DensityProvider>
        </PrefsProvider>
      </WorkspaceProvider>
    </TillClientProvider>,
  );
}

describe('DensityProvider (D178 point 7)', () => {
  beforeEach(() => {
    resetPrefsModuleForTests();
    document.documentElement.removeAttribute('data-density');
  });

  it('defaults to Komfortabel and stamps data-density, writing nothing to the browser', () => {
    render(
      <DensityProvider>
        <Probe />
      </DensityProvider>,
    );
    expect(screen.getByTestId('density')).toHaveTextContent('komfortabel');
    expect(document.documentElement.getAttribute('data-density')).toBe('komfortabel');
    expect(window.localStorage.getItem(DENSITY_STORAGE_KEY)).toBeNull();
  });

  it('pins a start outside a store with initialDensity', () => {
    render(
      <DensityProvider initialDensity="kompakt">
        <Probe />
      </DensityProvider>,
    );
    expect(screen.getByTestId('density')).toHaveTextContent('kompakt');
    expect(document.documentElement.getAttribute('data-density')).toBe('kompakt');
  });

  it('toggles to Kompakt and back, flipping data-density both ways', async () => {
    render(
      <DensityProvider>
        <Probe />
      </DensityProvider>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'flip' }));
    expect(screen.getByTestId('density')).toHaveTextContent('kompakt');
    expect(document.documentElement.getAttribute('data-density')).toBe('kompakt');
    await userEvent.click(screen.getByRole('button', { name: 'flip' }));
    expect(screen.getByTestId('density')).toHaveTextContent('komfortabel');
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

  it('inside the preference store, shows the engine value and stores a toggle through prefs_set', async () => {
    const engine = engineWith('kompakt');
    inStore(engine.transport);
    await waitFor(() => expect(screen.getByTestId('density')).toHaveTextContent('kompakt'));
    await userEvent.click(screen.getByRole('button', { name: 'flip' }));
    await waitFor(() => expect(engine.stored()).toBe('komfortabel'));
    expect(engine.sets).toEqual([{ workspaceId: 'ws_test', key: 'appearance.density', value: 'komfortabel' }]);
  });

  it('moves the browser-only till-density of earlier builds into the engine once, then clears it', async () => {
    window.localStorage.setItem(DENSITY_STORAGE_KEY, 'kompakt');
    const engine = engineWith(null);
    const outcome = importLegacyDensity();
    inStore(engine.transport);
    expect(await settle(outcome)).toBe('imported');
    expect(engine.stored()).toBe('kompakt');
    expect(window.localStorage.getItem(DENSITY_STORAGE_KEY)).toBeNull();
    await waitFor(() => expect(screen.getByTestId('density')).toHaveTextContent('kompakt'));
  });

  it('throws when used outside a provider (a wiring bug, not a runtime state)', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<Probe />)).toThrow(/DensityProvider/);
    spy.mockRestore();
  });
});
