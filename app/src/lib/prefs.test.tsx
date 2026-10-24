/**
 * D178 point 7, the Studio's preference store: `usePref`, the one shared store, the optimistic write and
 * its rollback, the default while loading, the boot cache, and the one-time legacy import.
 *
 * The transport is a fake engine that keeps one value per key, the way `prefs_set` / `prefs_reset` do,
 * so a test reads what the engine would answer rather than a canned body that agrees with the store by
 * construction. SYNTHETIC BY CONSTRUCTION.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';

import { TillClientProvider } from './client-context';
import { TillClient, type RestResponse, type Transport } from './client';
import { WorkspaceProvider } from '../app/workspace';
import {
  PREF_CACHE_KEY,
  PREF_PENDING_PREFIX,
  PrefsProvider,
  PrefsStore,
  importLegacyPref,
  resetPrefsModuleForTests,
  usePref,
  type PrefValue,
} from './prefs';
import { PREF_DEFS } from '../../../src/core/customization/prefDefs/index.js';
import { neverSettles, watchReads } from '../test-transport';

/** Await an outcome whose path updates React state, inside act (the console guard refuses a stray update). */
async function settle<T>(work: Promise<T> | (() => Promise<T>)): Promise<T> {
  let value!: T;
  await act(async () => {
    value = await (typeof work === 'function' ? work() : work);
  });
  return value;
}

type Call = { action: string; input: Record<string, unknown> };

/** A fake engine over the real registry: one stored value per key, the verbs' answers, a call log. */
function fakeEngine(seed: Record<string, PrefValue> = {}) {
  const stored = new Map<string, PrefValue>(Object.entries(seed));
  const calls: Call[] = [];
  let refuseNextSet: string | null = null;
  let holdSet: Promise<void> | null = null;
  const view = (key: string) => {
    const def = PREF_DEFS.find((d) => d.key === key)!;
    const has = stored.has(key);
    return {
      key,
      value: has ? stored.get(key)! : def.default,
      default: def.default,
      isDefault: !has,
      stale: false,
      scope: def.scope,
      schema: def.schema,
      area: def.area,
      label: def.label,
      description: def.description,
      valueLabels: def.valueLabels ?? null,
      updatedAt: has ? '2026-10-21T08:00:00.000Z' : null,
    };
  };
  const ok = (body: Record<string, unknown>): RestResponse => ({ status: 200, body: { ok: true, ...body } });
  const transport: Transport = async (action, input) => {
    calls.push({ action, input });
    if (action === 'prefs_list') {
      return ok({ prefs: PREF_DEFS.map((d) => view(d.key)), areas: [PREF_DEFS[0]!.area] });
    }
    if (action === 'prefs_set') {
      if (holdSet !== null) await holdSet;
      if (refuseNextSet !== null) {
        const code = refuseNextSet;
        refuseNextSet = null;
        return { status: 422, body: { ok: false, error: code } };
      }
      const key = input.key as string;
      const previous = view(key).value;
      stored.set(key, input.value as PrefValue);
      return ok({ key, value: input.value, previousValue: previous, isDefault: false, changed: true });
    }
    if (action === 'prefs_reset') {
      const keys = input.key !== undefined ? [input.key as string] : PREF_DEFS.filter((d) => d.area.id === input.area).map((d) => d.key);
      const reset = keys.filter((k) => stored.delete(k));
      return ok({ reset, changed: reset.length > 0 });
    }
    return { status: 404, body: { ok: false, error: 'unknown_action' } };
  };
  return {
    transport,
    calls,
    stored,
    refuseNext: (code: string) => {
      refuseNextSet = code;
    },
    hold: () => {
      let release!: () => void;
      holdSet = new Promise<void>((r) => {
        release = r;
      });
      return () => {
        holdSet = null;
        release();
      };
    },
  };
}

function Tree({ transport, children }: { transport: Transport; children: ReactNode }) {
  return (
    <TillClientProvider client={new TillClient(transport)}>
      <WorkspaceProvider initialId="ws_test">
        <PrefsProvider>{children}</PrefsProvider>
      </WorkspaceProvider>
    </TillClientProvider>
  );
}

function ThemeProbe({ id }: { id: string }) {
  const [value, setValue, meta] = usePref<string>('appearance.theme');
  return (
    <div>
      <span data-testid={`${id}-value`}>{value}</span>
      <span data-testid={`${id}-default`}>{meta.isDefault ? 'default' : 'custom'}</span>
      <span data-testid={`${id}-error`}>{meta.error?.error ?? ''}</span>
      <span data-testid={`${id}-status`}>{meta.status}</span>
      <button type="button" onClick={() => void setValue('dark')}>
        {`${id} dark`}
      </button>
      <button type="button" onClick={() => void meta.reset()}>
        {`${id} reset`}
      </button>
    </div>
  );
}

beforeEach(() => {
  resetPrefsModuleForTests();
});

describe('usePref (D178 point 7)', () => {
  it('outside a provider keeps local state from the registry default, or from initial', async () => {
    function Local() {
      const [a, setA] = usePref<string>('appearance.theme');
      const [b] = usePref<string>('appearance.density', { initial: 'kompakt' });
      return (
        <>
          <span data-testid="a">{a}</span>
          <span data-testid="b">{b}</span>
          <button type="button" onClick={() => void setA('light')}>
            set
          </button>
        </>
      );
    }
    render(<Local />);
    expect(screen.getByTestId('a')).toHaveTextContent('system');
    expect(screen.getByTestId('b')).toHaveTextContent('kompakt');
    await userEvent.click(screen.getByRole('button', { name: 'set' }));
    expect(screen.getByTestId('a')).toHaveTextContent('light');
  });

  it('an unknown key is a programming error, not a silent undefined', () => {
    function Bad() {
      usePref('appearance.colour');
      return null;
    }
    // Silence the expected React error log for this one deliberate throw.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<Bad />)).toThrow(/not in the preference registry/);
    spy.mockRestore();
  });

  it('LOADING: answers the registry default while prefs_list is in flight', async () => {
    const transport = watchReads(neverSettles);
    render(
      <Tree transport={transport}>
        <ThemeProbe id="one" />
      </Tree>,
    );
    await transport.started('prefs_list');
    expect(screen.getByTestId('one-value')).toHaveTextContent('system');
    expect(screen.getByTestId('one-default')).toHaveTextContent('default');
  });

  it('answers the engine value once prefs_list answered', async () => {
    const engine = fakeEngine({ 'appearance.theme': 'dark' });
    render(
      <Tree transport={engine.transport}>
        <ThemeProbe id="one" />
      </Tree>,
    );
    await waitFor(() => expect(screen.getByTestId('one-value')).toHaveTextContent('dark'));
    expect(screen.getByTestId('one-default')).toHaveTextContent('custom');
  });

  it('two consumers on one key share one store: a write in one shows in the other', async () => {
    const engine = fakeEngine();
    render(
      <Tree transport={engine.transport}>
        <ThemeProbe id="one" />
        <ThemeProbe id="two" />
      </Tree>,
    );
    await waitFor(() => expect(screen.getByTestId('one-status')).toHaveTextContent('ready'));
    await userEvent.click(screen.getByRole('button', { name: 'one dark' }));
    await waitFor(() => expect(screen.getByTestId('two-value')).toHaveTextContent('dark'));
    expect(engine.calls.filter((c) => c.action === 'prefs_set')).toEqual([
      { action: 'prefs_set', input: { workspaceId: 'ws_test', key: 'appearance.theme', value: 'dark' } },
    ]);
    await userEvent.click(screen.getByRole('button', { name: 'two reset' }));
    await waitFor(() => expect(screen.getByTestId('one-value')).toHaveTextContent('system'));
    expect(screen.getByTestId('one-default')).toHaveTextContent('default');
  });

  it('a write is optimistic, and a refusal rolls it back and lands on meta.error', async () => {
    const engine = fakeEngine();
    render(
      <Tree transport={engine.transport}>
        <ThemeProbe id="one" />
        <ThemeProbe id="two" />
      </Tree>,
    );
    await waitFor(() => expect(screen.getByTestId('one-status')).toHaveTextContent('ready'));
    const release = engine.hold();
    engine.refuseNext('invalid_pref_value');
    await userEvent.click(screen.getByRole('button', { name: 'one dark' }));
    // In flight: both consumers already show the new value.
    expect(screen.getByTestId('one-value')).toHaveTextContent('dark');
    expect(screen.getByTestId('two-value')).toHaveTextContent('dark');
    act(() => release());
    await waitFor(() => expect(screen.getByTestId('one-value')).toHaveTextContent('system'));
    expect(screen.getByTestId('two-value')).toHaveTextContent('system');
    expect(screen.getByTestId('one-error')).toHaveTextContent('invalid_pref_value');
    expect(engine.stored.has('appearance.theme')).toBe(false);
  });

  it('keeps the engine answer in the boot cache, so the next start shows it before the engine answers', async () => {
    const engine = fakeEngine({ 'appearance.theme': 'dark' });
    const { unmount } = render(
      <Tree transport={engine.transport}>
        <ThemeProbe id="one" />
      </Tree>,
    );
    await waitFor(() => expect(screen.getByTestId('one-value')).toHaveTextContent('dark'));
    unmount();
    expect(JSON.parse(window.localStorage.getItem(PREF_CACHE_KEY)!).person).toEqual({ 'appearance.theme': 'dark' });
    // A fresh store, before any engine answer, already shows the person's last answered theme.
    const store = new PrefsStore(null, 'ws_test');
    expect(store.value('appearance.theme')).toBe('dark');
    expect(store.isDefault('appearance.theme')).toBe(false);
  });
});

describe('importLegacyPref (D178 point 7)', () => {
  const parse = (raw: string) => (raw === 'light' || raw === 'dark' ? raw : undefined);

  async function mounted(engine: ReturnType<typeof fakeEngine>) {
    render(
      <Tree transport={engine.transport}>
        <ThemeProbe id="one" />
      </Tree>,
    );
    await waitFor(() => expect(screen.getByTestId('one-status')).toHaveTextContent('ready'));
  }

  it('moves the browser value into the engine once and clears it, queued until the store has loaded', async () => {
    window.localStorage.setItem('till-theme', 'dark');
    const engine = fakeEngine();
    const outcome = importLegacyPref('appearance.theme', 'till-theme', parse);
    await mounted(engine);
    expect(await settle(outcome)).toBe('imported');
    expect(engine.stored.get('appearance.theme')).toBe('dark');
    expect(window.localStorage.getItem('till-theme')).toBeNull();
    await waitFor(() => expect(screen.getByTestId('one-value')).toHaveTextContent('dark'));
    // Once: a second run finds nothing.
    expect(await settle(() => importLegacyPref('appearance.theme', 'till-theme', parse))).toBe('nothing');
    expect(engine.calls.filter((c) => c.action === 'prefs_set')).toHaveLength(1);
  });

  it('lets an engine value win over the browser copy, and discards a value that does not parse', async () => {
    window.localStorage.setItem('till-theme', 'dark');
    window.localStorage.setItem('till-density', 'cosy');
    const engine = fakeEngine({ 'appearance.theme': 'light' });
    await mounted(engine);
    expect(await settle(() => importLegacyPref('appearance.theme', 'till-theme', parse))).toBe('engine_kept');
    const density = (raw: string) => (raw === 'komfortabel' || raw === 'kompakt' ? raw : undefined);
    expect(await settle(() => importLegacyPref('appearance.density', 'till-density', density))).toBe('discarded');
    expect(engine.stored.get('appearance.theme')).toBe('light');
    expect(window.localStorage.getItem('till-theme')).toBeNull();
    expect(window.localStorage.getItem('till-density')).toBeNull();
    expect(engine.calls.filter((c) => c.action === 'prefs_set')).toHaveLength(0);
  });

  it('keeps the browser copy when the engine refuses, for the next start', async () => {
    window.localStorage.setItem('till-theme', 'dark');
    const engine = fakeEngine();
    await mounted(engine);
    engine.refuseNext('permission_denied');
    expect(await settle(() => importLegacyPref('appearance.theme', 'till-theme', parse))).toBe('failed');
    expect(window.localStorage.getItem('till-theme')).toBe('dark');
  });

  it('a choice made while no workspace was open waits in the browser and reaches the first workspace', async () => {
    const detached = new PrefsStore(null, null, { pendingSync: true });
    await detached.set('appearance.theme', 'dark');
    expect(window.localStorage.getItem(`${PREF_PENDING_PREFIX}appearance.theme`)).toBe('"dark"');
    const engine = fakeEngine({ 'appearance.theme': 'light' });
    await mounted(engine);
    await waitFor(() => expect(engine.stored.get('appearance.theme')).toBe('dark'));
    expect(window.localStorage.getItem(`${PREF_PENDING_PREFIX}appearance.theme`)).toBeNull();
  });
});
