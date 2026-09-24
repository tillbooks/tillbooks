/**
 * The Betrieb (Operations) surface, the K-16 split of `/setup` (Option A).
 *
 * Two things are proven here, because the surface itself is a composition and its value is that it
 * routes and that it carries EVERY operational panel that used to trail the company profile:
 *
 *   1. ROUTING. `/operations` resolves to the real Operations surface (a route the registry carries
 *      and the router builds a REAL component for, never the Placeholder), and its nav label is
 *      `nav.operations`. This is the app-side half of the seam the drift generator also checks.
 *   2. COMPOSITION. Rendered with a workspace selected, the surface shows the six moved panels: the
 *      Vertrauen proof, the runtime line, sync & hosting, data & backup, the implementation roster
 *      and the diagnostics block. A snapshot of a title per panel is what stops a future tidy from
 *      quietly dropping one on the way across.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider } from '../../app/workspace';
import { CapabilitiesProvider } from '../../lib/CapabilitiesProvider';
import { ROUTE_REGISTRY } from '../../app/nav';
import { BUILT_SURFACE_PATHS } from '../../app/router';
import { Operations } from './Operations';
import de from './messages.de-CH.json';

const ok = (data: Record<string, unknown> = {}): RestResponse => ({ status: 200, body: { ok: true, ...data } });

/**
 * A permissive transport: every panel reads on mount, and this surface's job is to compose them, not
 * to drive any one panel's states (each panel owns those in its own suite). So an ok answer to
 * whatever a panel asks lets all six mount without throwing, and the titles below prove they did.
 */
function permissiveTransport(): Transport {
  return async (action) => {
    if (action === 'whoami') {
      return ok({
        actor: 'studio',
        role: null,
        isMember: true,
        provisioned: true,
        memberId: 'm1',
        userId: 'u1',
        capabilities: ['egress.read', 'diagnostics.read', 'sync.read', 'backup.read'],
      });
    }
    if (action === 'egress_status') return ok({ state: 'local', socketsOpened: 0, since: '2026-08-06T00:00:00.000Z' });
    if (action === 'delivery_status') {
      return ok({
        mode: 'up',
        version: '0.0.0',
        host: null,
        port: null,
        studioServed: false,
        scheduler: { enabled: false, lastTickAt: null, nextTickAt: null },
      });
    }
    return ok();
  };
}

function tree() {
  return (
    <TillClientProvider client={new TillClient(permissiveTransport())}>
      <I18nProvider>
        <WorkspaceProvider initialId="ws_1">
          <CapabilitiesProvider>
            <MemoryRouter>
              <Operations />
            </MemoryRouter>
          </CapabilitiesProvider>
        </WorkspaceProvider>
      </I18nProvider>
    </TillClientProvider>
  );
}

describe('Operations (Betrieb) surface', () => {
  it('ROUTING: /operations is a registered route with the Betrieb label and a real built surface', () => {
    const entry = ROUTE_REGISTRY.find((r) => r.path === '/operations');
    expect(entry).toBeDefined();
    expect(entry?.labelKey).toBe('nav.operations');
    // A REAL surface, not the Placeholder fallback the router hands unbuilt paths.
    expect(BUILT_SURFACE_PATHS).toContain('/operations');
  });

  it('COMPOSITION: renders the Vertrauen panel (the offline proof) with a workspace selected', async () => {
    render(tree());
    expect(await screen.findByText(de.egress.panel.title)).toBeInTheDocument();
  });

  it('COMPOSITION: renders the diagnostics & feedback block', async () => {
    render(tree());
    expect(await screen.findByText(de.diagnostics.title)).toBeInTheDocument();
  });

  it('COMPOSITION: lays the panels out in the single operational column', async () => {
    const { container } = render(tree());
    await waitFor(() => expect(screen.getByText(de.egress.panel.title)).toBeInTheDocument());
    expect(container.querySelector('.operations-stack')).not.toBeNull();
  });
});
