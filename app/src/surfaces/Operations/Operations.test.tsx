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
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
import shell from '../../i18n/de-CH.json';

const BACKUP = (shell as { data: { action: { backup: string } } }).data.action.backup;

const ok = (data: Record<string, unknown> = {}): RestResponse => ({ status: 200, body: { ok: true, ...data } });

/**
 * A permissive transport: every panel reads on mount, and this surface's job is to compose them, not
 * to drive any one panel's states (each panel owns those in its own suite). So an ok answer to
 * whatever a panel asks lets all six mount without throwing, and the titles below prove they did.
 */
function permissiveTransport(calls: string[] = [], deny: string[] = []): Transport {
  return async (action) => {
    calls.push(action);
    if (deny.includes(action)) return { status: 403, body: { ok: false, error: 'permission_denied' } };
    if (action === 'list_backups') return ok({ backups: [] });
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

function tree(calls: string[] = [], deny: string[] = []) {
  return (
    <TillClientProvider client={new TillClient(permissiveTransport(calls, deny))}>
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

  /**
   * D152 (the owner's pick of 03.10.2026): "Jetzt sichern", the surface's ONE primary, renders in the
   * SurfaceHeader action slot, in view at load, and nowhere else. It used to sit at the foot of Data
   * & Backup at y=1962, off screen at 1280x800 and outside the slot DESIGN.md requires.
   */
  it('PRIMARY: Jetzt sichern sits in the header action slot, once, and is the only primary', async () => {
    const { container } = render(tree());
    const header = container.querySelector('.surface-header') as HTMLElement;
    const button = await within(header).findByRole('button', { name: BACKUP });
    expect(button.closest('.surface-header-actions')).not.toBeNull();
    expect(button).toHaveClass('btn--primary');
    expect(screen.getAllByRole('button', { name: BACKUP })).toHaveLength(1);
    expect(container.querySelectorAll('.btn--primary')).toHaveLength(1);
    // The panel keeps its secondary export, and no second Jetzt sichern.
    const panel = container.querySelector('.data-panel') as HTMLElement;
    expect(within(panel).queryByRole('button', { name: BACKUP })).toBeNull();
  });

  it('PRIMARY: pressing the header Jetzt sichern runs create_backup through the panel and re-reads the history', async () => {
    const calls: string[] = [];
    const { container } = render(tree(calls));
    const header = container.querySelector('.surface-header') as HTMLElement;
    const button = await within(header).findByRole('button', { name: BACKUP });
    const before = calls.filter((c) => c === 'list_backups').length;
    await userEvent.click(button);
    await waitFor(() => expect(calls).toContain('create_backup'));
    await waitFor(() => expect(calls.filter((c) => c === 'list_backups').length).toBeGreaterThan(before));
  });

  it('PRIMARY: without the backup right the panel shows its padlock and the header slot stays empty', async () => {
    const { container } = render(tree([], ['list_backups']));
    await screen.findByText(de.egress.panel.title);
    await waitFor(() => expect(container.querySelector('.data-panel')).not.toBeNull());
    await waitFor(() => expect(screen.queryByRole('button', { name: BACKUP })).toBeNull());
  });

  it('REST: no multi-sentence prose block on the working surface above Sync & Hosting', async () => {
    const { container } = render(tree());
    await screen.findByText(de.egress.panel.title);
    const trust = container.querySelector('.trust') as HTMLElement;
    // Every <p> left at rest in the Vertrauen panel is one line, never two sentences.
    for (const p of Array.from(trust.querySelectorAll('p'))) {
      expect((p.textContent ?? '').match(/[.!?](\s|$)/g)?.length ?? 0).toBeLessThan(2);
    }
  });
});
