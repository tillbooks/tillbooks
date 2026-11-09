/**
 * The theme provider over the `appearance.theme` preference (D178 point 7): `system` follows the OS
 * live, an explicit side wins, the toggle stores the opposite side, the engine's value is what a tree
 * inside the preference store shows, and the browser-only `till-theme` of earlier builds moves into the
 * engine once.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ThemeProvider, useTheme, THEME_STORAGE_KEY, importLegacyTheme } from './theme';
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

/** A tiny consumer that shows the theme and offers the toggle. */
function Probe() {
  const { theme, preference, toggle, setTheme } = useTheme();
  return (
    <>
      <span data-testid="theme">{theme}</span>
      <span data-testid="preference">{preference}</span>
      <button type="button" onClick={toggle}>
        flip
      </button>
      <button type="button" onClick={() => setTheme('system')}>
        system
      </button>
    </>
  );
}

/** A matchMedia mock answering the prefers-dark query; `change(dark)` fires the OS switch. */
function mockMatchMedia(prefersDark: boolean) {
  let dark = prefersDark;
  const listeners = new Set<() => void>();
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    get matches() {
      return dark && query.includes('dark');
    },
    media: query,
    onchange: null,
    addEventListener: (_: string, l: () => void) => listeners.add(l),
    removeEventListener: (_: string, l: () => void) => listeners.delete(l),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
  return {
    change(next: boolean) {
      dark = next;
      for (const l of listeners) l();
    },
  };
}

/** A fake engine holding one theme value. */
function engineWith(theme: string | null) {
  let stored = theme;
  const calls: { action: string; input: Record<string, unknown> }[] = [];
  const transport: Transport = async (action, input): Promise<RestResponse> => {
    calls.push({ action, input });
    if (action === 'prefs_list') {
      return {
        status: 200,
        body: {
          ok: true,
          prefs: [
            {
              key: 'appearance.theme',
              value: stored ?? 'system',
              default: 'system',
              isDefault: stored === null,
              stale: false,
              scope: 'person',
              schema: { type: 'enum', values: ['light', 'dark', 'system'] },
              area: { id: 'appearance', label: { en: 'Appearance', 'de-CH': 'Darstellung' } },
              label: { en: 'Colour scheme', 'de-CH': 'Farbschema' },
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
      const previous = stored ?? 'system';
      stored = input.value as string;
      return { status: 200, body: { ok: true, key: input.key, value: input.value, previousValue: previous, isDefault: false, changed: true } };
    }
    return { status: 404, body: { ok: false, error: 'unknown_action' } };
  };
  return { transport, calls, stored: () => stored };
}

function inStore(transport: Transport) {
  return render(
    <TillClientProvider client={new TillClient(transport)}>
      <WorkspaceProvider initialId="ws_test">
        <PrefsProvider>
          <ThemeProvider>
            <Probe />
          </ThemeProvider>
        </PrefsProvider>
      </WorkspaceProvider>
    </TillClientProvider>,
  );
}

describe('ThemeProvider (D178 point 7)', () => {
  beforeEach(() => {
    resetPrefsModuleForTests();
    document.documentElement.removeAttribute('data-theme');
  });

  afterEach(() => {
    // Remove the mock so the next test starts from a clean, matchMedia-less environment.
    Reflect.deleteProperty(window, 'matchMedia');
  });

  it('follows the OS by default (system), dark here, and writes nothing to the browser', () => {
    mockMatchMedia(true);
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('theme')).toHaveTextContent('dark');
    expect(screen.getByTestId('preference')).toHaveTextContent('system');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
  });

  it('defaults to light when the OS prefers light, and follows the OS when it switches', () => {
    const os = mockMatchMedia(false);
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('theme')).toHaveTextContent('light');
    act(() => os.change(true));
    expect(screen.getByTestId('theme')).toHaveTextContent('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('lets an explicit side win over the OS (initialTheme pins it outside a store)', () => {
    mockMatchMedia(true);
    render(
      <ThemeProvider initialTheme="light">
        <Probe />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('theme')).toHaveTextContent('light');
  });

  it('toggles to the opposite side, flips data-theme, and can go back to the system', async () => {
    mockMatchMedia(false);
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'flip' }));
    expect(screen.getByTestId('theme')).toHaveTextContent('dark');
    expect(screen.getByTestId('preference')).toHaveTextContent('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    await userEvent.click(screen.getByRole('button', { name: 'system' }));
    expect(screen.getByTestId('theme')).toHaveTextContent('light');
    expect(screen.getByTestId('preference')).toHaveTextContent('system');
  });

  it('inside the preference store, shows the engine value and stores a toggle through prefs_set', async () => {
    mockMatchMedia(false);
    const engine = engineWith('dark');
    inStore(engine.transport);
    await waitFor(() => expect(screen.getByTestId('theme')).toHaveTextContent('dark'));
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    await userEvent.click(screen.getByRole('button', { name: 'flip' }));
    await waitFor(() => expect(engine.stored()).toBe('light'));
    expect(engine.calls.filter((c) => c.action === 'prefs_set').map((c) => c.input)).toEqual([
      { workspaceId: 'ws_test', key: 'appearance.theme', value: 'light' },
    ]);
    expect(screen.getByTestId('theme')).toHaveTextContent('light');
  });

  it('moves the browser-only till-theme of earlier builds into the engine once, then clears it', async () => {
    mockMatchMedia(false);
    window.localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    const engine = engineWith(null);
    const outcome = importLegacyTheme();
    inStore(engine.transport);
    expect(await settle(outcome)).toBe('imported');
    expect(engine.stored()).toBe('dark');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
    await waitFor(() => expect(screen.getByTestId('theme')).toHaveTextContent('dark'));
  });

  it('throws when used outside a provider (a wiring bug, not a runtime state)', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<Probe />)).toThrow(/ThemeProvider/);
    spy.mockRestore();
  });
});
