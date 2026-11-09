/**
 * K-10, US-G16.9: an unmatched address is a detour in plain words, never the crash screen.
 *
 * The route table used to have two top-level routes and no catch-all, so any unmatched path (a
 * shared per-workspace link like `/w/ws_1/payments`, a typo like `/paymnets`) raised the router's
 * own 404 into `RouteCrash`, the panel that claims a screen stopped working. These tests run the
 * REAL route table from `router.tsx` (via `useRoutes`, inside a plain MemoryRouter for the same
 * jsdom reason `Shell.test.tsx` documents) and pin both repairs: the `/w/:workspaceId/*` splat
 * adopts the workspace and lands on the surface the link names, and everything else lands on the
 * NotFound detour with its two ways forward.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation, useRoutes } from 'react-router-dom';

import { I18nProvider } from '../i18n';
import { TillClientProvider } from '../lib/client-context';
import { TillClient, type Transport } from '../lib/client';
import { WORKSPACE_STORAGE_KEY } from '../lib/workspace-store';
import { ThemeProvider } from './theme';
import { DensityProvider } from './density';
import { WorkspaceProvider } from './workspace';
import { routes } from './router';

function makeClient(): TillClient {
  const transport: Transport = async () => ({ status: 404, body: { ok: false, error: 'unknown_action' } });
  return new TillClient(transport);
}

/** The address the router settled on, rendered next to the route tree so a redirect is observable. */
function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location-probe">{location.pathname}</div>;
}

function App() {
  return (
    <>
      {useRoutes(routes)}
      <LocationProbe />
    </>
  );
}

function renderAt(initialPath: string) {
  return render(
    <ThemeProvider initialTheme="light">
      <DensityProvider initialDensity="komfortabel">
        <TillClientProvider client={makeClient()}>
          <I18nProvider>
            <WorkspaceProvider initialId={null}>
              <MemoryRouter initialEntries={[initialPath]}>
                <App />
              </MemoryRouter>
            </WorkspaceProvider>
          </I18nProvider>
        </TillClientProvider>
      </DensityProvider>
    </ThemeProvider>,
  );
}

afterEach(() => {
  window.localStorage.removeItem(WORKSPACE_STORAGE_KEY);
});

describe('K-10: the router catch-all and the per-workspace deep link', () => {
  it('a shared per-workspace link resolves to the surface with the workspace adopted', async () => {
    renderAt('/w/ws_1/payments');
    // The splat adopts the tenant and hands over to the surface path inside the Shell.
    expect((await screen.findByTestId('location-probe')).textContent).toBe('/payments');
    expect(window.localStorage.getItem(WORKSPACE_STORAGE_KEY)).toBe('ws_1');
    // The detour never masquerades as a defect: neither the crash panel nor the 404 page renders.
    expect(screen.queryByText(/Dieser Bildschirm funktioniert nicht mehr/)).toBeNull();
    expect(screen.queryByText('Diese Adresse gibt es nicht.')).toBeNull();
  });

  it('a malformed workspace id under the splat takes the US-G16.9 detour to the picker', async () => {
    renderAt('/w/not-a-workspace/payments');
    expect((await screen.findByTestId('location-probe')).textContent).toBe('/setup');
    expect(window.localStorage.getItem(WORKSPACE_STORAGE_KEY)).toBeNull();
  });

  it('a typo path renders the NotFound detour, never the crash screen', async () => {
    renderAt('/paymnets');
    expect(
      await screen.findByRole('heading', { level: 2, name: 'Diese Adresse gibt es nicht.' }),
    ).toBeInTheDocument();
    // Plain words and two ways forward, per the shell's own copy.
    expect(screen.getByRole('link', { name: 'Zur Übersicht' })).toHaveAttribute('href', '/overview');
    expect(screen.getByRole('link', { name: 'Wähle einen Arbeitsbereich' })).toHaveAttribute('href', '/setup');
    // RouteCrash stays what it is: the panel for a route that THREW, not for an unknown address.
    expect(screen.queryByText(/Dieser Bildschirm funktioniert nicht mehr/)).toBeNull();
    expect((screen.getByTestId('location-probe')).textContent).toBe('/paymnets');
  });
});
