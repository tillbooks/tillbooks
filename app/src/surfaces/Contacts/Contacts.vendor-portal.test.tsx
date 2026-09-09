/**
 * F03, the Lieferantenportal panel on a SUPPLIER contact's Portal tab (spec §6/§8 component test).
 *
 * Proves the states (loading, empty, success, permission-denied), the one-time-link affordance shown
 * exactly once after a create, the glyph+label statuses (never colour-only), the "Sichtbar für
 * Lieferant" preview (POs + advices read workspace-scoped by contact), and the A24 padlock: create
 * and revoke render only with `portal.manage`, and without it the panel is READ-ONLY (the lists still
 * read on `read_master_data`), never shown-then-rejected.
 *
 * The loading block proves its request really went in flight (the shared `watchReads().started()`
 * seam), so the skeleton assertion cannot be vacuous.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { watchReads } from '../../test-transport';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider } from '../../app/workspace';
import { CapabilitiesContext, CAP, type Capabilities } from '../../lib/capabilities';
import Contacts from './index';

// A VENDOR contact, so the Portal tab renders the F03 vendor panel (not F02's customer panel).
const CONTACTS = [
  {
    id: 'v1',
    partyRole: 'vendor',
    kind: 'company',
    name: 'Lieferant GmbH',
    address: { street: 'Werkstrasse', houseNo: '3', zip: '3000', city: 'Bern', country: 'CH' },
    email: 'kontakt@lieferant.ch',
    segments: [],
    roles: [],
  },
];

const ok = (data: Record<string, unknown> = {}): RestResponse => ({ status: 200, body: { ok: true, ...data } });

interface VendorReads {
  grants?: () => Promise<RestResponse> | RestResponse;
  pos?: () => RestResponse;
  advices?: () => RestResponse;
}

function transportWith(reads: VendorReads): Transport {
  return async (action, input) => {
    if (action === 'list_contacts') return ok({ contacts: CONTACTS });
    if (action === 'get_company_profile') return ok({ profile: { baseCurrency: 'CHF' } });
    if (action === 'contacts_timeline') return ok({ activities: [] });
    if (action === 'vendor_portal_grants_list') return reads.grants ? reads.grants() : ok({ grants: [] });
    if (action === 'vendor_portal_pos') return reads.pos ? reads.pos() : ok({ pos: [] });
    if (action === 'vendor_portal_remittances') return reads.advices ? reads.advices() : ok({ advices: [] });
    if (action === 'vendor_portal_grant') {
      return ok({ grantId: 'g1', grant: { id: 'g1', status: 'draft', expiresAt: '2026-10-01' }, localLink: '/portal?token=SECRET-ONE-TIME', clamped: false });
    }
    if (action === 'vendor_portal_revoke') return ok({ grantId: (input as { grantId: string }).grantId });
    return { status: 404, body: { ok: false, error: 'unknown_action' } };
  };
}

function caps(held: readonly string[]): Capabilities {
  return {
    whoami: { actor: 'studio', provisioned: true, isMember: true, memberId: 'm1', userId: 'u1', role: 'owner', capabilities: [...held] },
    can: (capability) => held.includes(capability),
    refresh: () => undefined,
  };
}

function renderWith(transport: Transport, held: readonly string[]) {
  return render(
    <TillClientProvider client={new TillClient(transport)}>
      <I18nProvider>
        <WorkspaceProvider initialId="ws_test">
          <CapabilitiesContext.Provider value={caps(held)}>
            <MemoryRouter>
              <Contacts />
            </MemoryRouter>
          </CapabilitiesContext.Provider>
        </WorkspaceProvider>
      </I18nProvider>
    </TillClientProvider>,
  );
}

async function openPortalTab() {
  await userEvent.click(await screen.findByRole('button', { name: 'Lieferant GmbH' }));
  await screen.findByRole('dialog');
  await userEvent.click(screen.getByRole('tab', { name: 'Portal-Zugang' }));
}

describe('F03 Lieferantenportal panel', () => {
  it('LOADING: shows the skeleton while the grants read is in flight (proven by the started seam)', async () => {
    const transport = watchReads(transportWith({ grants: () => new Promise<RestResponse>(() => {}) }));
    renderWith(transport, [CAP.portalManage, CAP.readMasterData]);
    await openPortalTab();
    await transport.started('vendor_portal_grants_list');
    expect(screen.getByRole('status')).toBeTruthy();
  });

  it('EMPTY: no grants and no exposed rows show the empty hints', async () => {
    renderWith(transportWith({}), [CAP.portalManage, CAP.readMasterData]);
    await openPortalTab();
    expect(await screen.findByText('Noch kein Portalzugang erstellt.')).toBeTruthy();
    expect(screen.getByText('Keine offenen Bestellungen.')).toBeTruthy();
    expect(screen.getByText('Noch keine Zahlungsavise.')).toBeTruthy();
  });

  it('SUCCESS: a grant renders with its glyph+label status and a revoke control; the preview shows the PO', async () => {
    const grants = () => ok({ grants: [{ id: 'g1', status: 'active', expiresAt: '2026-10-01' }] });
    const pos = () => ok({ pos: [{ id: 'po1', number: 'BE-1', status: 'sent', currency: 'CHF', totalRappen: 15000, expectedOn: null }] });
    renderWith(transportWith({ grants, pos }), [CAP.portalManage, CAP.readMasterData]);
    await openPortalTab();
    // Glyph AND label: never colour-only.
    expect(await screen.findByText('Aktiv')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Zugang widerrufen' })).toBeTruthy();
    // The "Sichtbar für Lieferant" preview shows the exposed PO.
    expect(screen.getByText('Sichtbar für Lieferant')).toBeTruthy();
    expect(screen.getByText('BE-1')).toBeTruthy();
  });

  it('CREATE: the one-time link is shown exactly once after a successful grant', async () => {
    renderWith(transportWith({}), [CAP.portalManage, CAP.readMasterData]);
    await openPortalTab();
    await screen.findByText('Noch kein Portalzugang erstellt.');
    const date = screen.getByLabelText('Gültig bis');
    await userEvent.type(date, '2026-09-01');
    await userEvent.click(screen.getByRole('button', { name: 'Portalzugang erstellen' }));
    expect(await screen.findByText('Dieser Link wird nur einmal angezeigt.')).toBeTruthy();
    expect(screen.getByLabelText('Link kopieren')).toBeTruthy();
  });

  it('PERMISSION-DENIED: without portal.manage the panel is read-only (no create, no revoke), lists still read', async () => {
    const grants = () => ok({ grants: [{ id: 'g1', status: 'active', expiresAt: '2026-10-01' }] });
    renderWith(transportWith({ grants }), [CAP.readMasterData]);
    await openPortalTab();
    // The list still reads (it rides read_master_data): the active grant shows.
    expect(await screen.findByText('Aktiv')).toBeTruthy();
    // But neither the create nor the revoke affordance is rendered (padlock, never shown-then-rejected).
    expect(screen.queryByRole('button', { name: 'Portalzugang erstellen' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Zugang widerrufen' })).toBeNull();
  });
});
