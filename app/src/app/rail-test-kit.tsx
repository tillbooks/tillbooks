/**
 * The rail's test kit (D178): a fake preference engine and one harness that mounts the rail the way the
 * Shell does (client, workspace, the ONE preference store, the router, the rail's model).
 *
 * The fake engine keeps one value per (scope, key) the way `prefs_set` / `prefs_reset` do over the real
 * registry: a `person` preference is one value for the actor, a `workspace` one is kept per workspace.
 * So a test reads what the engine would answer (a pin made in workspace A is absent in B) rather than a
 * canned body that agrees with the store by construction. Every other action answers the quiet
 * `{ ok: true, total: 0 }` the rail's badges read as "nothing waiting". SYNTHETIC BY CONSTRUCTION.
 *
 * Not a test file itself: the rail suites import it.
 */
import type { ReactElement, ReactNode } from 'react';
import { render } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

import { I18nProvider } from '../i18n';
import { TillClientProvider } from '../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../lib/client';
import { PrefsProvider, type PrefValue } from '../lib/prefs';
import { PREF_DEFS } from '../../../src/core/customization/prefDefs/index.js';
import { ThemeProvider, type Theme } from './theme';
import { WorkspaceProvider } from './workspace';
import { RailStateProvider } from './nav-prefs';

export interface FakePrefsEngine {
  transport: Transport;
  calls: { action: string; input: Record<string, unknown> }[];
  /** The stored value of `key` for `workspaceId` (a person key ignores the workspace), or undefined. */
  get: (workspaceId: string, key: string) => PrefValue | undefined;
  /** Store a value directly, as if an earlier session had set it. */
  put: (workspaceId: string, key: string, value: PrefValue) => void;
  /** Refuse the next `prefs_set` with `code`. */
  refuseNext: (code: string) => void;
  /** Refuse every `prefs_set` with `code` until called with null. */
  refuseAll: (code: string | null) => void;
}

export function fakePrefsEngine(): FakePrefsEngine {
  const stored = new Map<string, PrefValue>();
  const calls: FakePrefsEngine['calls'] = [];
  let refuseOnce: string | null = null;
  let refuseAlways: string | null = null;
  const slot = (workspaceId: string, key: string): string => {
    const def = PREF_DEFS.find((d) => d.key === key);
    return def?.scope === 'workspace' ? `${workspaceId}|${key}` : key;
  };
  const view = (workspaceId: string, key: string) => {
    const def = PREF_DEFS.find((d) => d.key === key)!;
    const has = stored.has(slot(workspaceId, key));
    return {
      key,
      value: has ? stored.get(slot(workspaceId, key))! : def.default,
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
    const workspaceId = String(input.workspaceId ?? '');
    if (action === 'prefs_list') {
      const areas = PREF_DEFS.map((d) => d.area).filter((a, i, all) => all.findIndex((b) => b.id === a.id) === i);
      return ok({ prefs: PREF_DEFS.map((d) => view(workspaceId, d.key)), areas });
    }
    if (action === 'prefs_set') {
      const code = refuseOnce ?? refuseAlways;
      if (code !== null) {
        refuseOnce = null;
        return { status: 422, body: { ok: false, error: code } };
      }
      const key = input.key as string;
      const previous = view(workspaceId, key).value;
      stored.set(slot(workspaceId, key), input.value as PrefValue);
      return ok({ key, value: input.value, previousValue: previous, isDefault: false, changed: true });
    }
    if (action === 'prefs_reset') {
      const keys =
        input.key !== undefined ? [input.key as string] : PREF_DEFS.filter((d) => d.area.id === input.area).map((d) => d.key);
      const reset = keys.filter((k) => stored.delete(slot(workspaceId, k)));
      return ok({ reset, changed: reset.length > 0 });
    }
    return ok({ total: 0 });
  };
  return {
    transport,
    calls,
    get: (workspaceId, key) => stored.get(slot(workspaceId, key)),
    put: (workspaceId, key, value) => {
      stored.set(slot(workspaceId, key), value);
    },
    refuseNext: (code) => {
      refuseOnce = code;
    },
    refuseAll: (code) => {
      refuseAlways = code;
    },
  };
}

/** Shows the router's location, so a test can assert where a click went. */
export function LocationProbe() {
  const location = useLocation();
  return <div data-testid="loc">{location.pathname}</div>;
}

/**
 * Mount `children` inside the rail's providers at `path`, on workspace `workspaceId`, against `engine`.
 * The rail's model is computed by the real `RailStateProvider`, so every component under it reads the
 * same answer the Shell's do.
 */
export function renderWithRail(
  children: ReactNode,
  {
    path = '/overview',
    workspaceId = 'ws_a',
    engine = fakePrefsEngine(),
    theme = 'light' as Theme,
  }: { path?: string; workspaceId?: string | null; engine?: FakePrefsEngine; theme?: Theme } = {},
): ReturnType<typeof render> & { engine: FakePrefsEngine } {
  const tree: ReactElement = (
    <ThemeProvider initialTheme={theme}>
      <I18nProvider>
        <TillClientProvider client={new TillClient(engine.transport)}>
          <WorkspaceProvider initialId={workspaceId}>
            <PrefsProvider>
              <MemoryRouter initialEntries={[path]}>
                <Routes>
                  <Route
                    path="*"
                    element={
                      <RailStateProvider>
                        {children}
                        <LocationProbe />
                      </RailStateProvider>
                    }
                  />
                </Routes>
              </MemoryRouter>
            </PrefsProvider>
          </WorkspaceProvider>
        </TillClientProvider>
      </I18nProvider>
    </ThemeProvider>
  );
  return { ...render(tree), engine };
}
