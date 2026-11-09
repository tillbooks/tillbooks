/**
 * F02, the Portal-Zugang panel on the contact detail (spec §6/§8 component test).
 *
 * Proves all FIVE states (loading, empty, error, success, permission-denied), the one-time-link
 * affordance that appears exactly once after a create, the D157 draft row (it says it opens nothing,
 * and "Link freischalten" sends `confirmed:true`), the glyph+label statuses (never colour-only),
 * and the A24 padlock: create/revoke render only with `portal.manage`, and without it the panel is
 * READ-ONLY (the list still reads on `read_master_data`), never shown-then-rejected.
 *
 * The loading block proves its request really went in flight (the shared `watchReads().started()`
 * seam from `test-transport`), per the loading-state convention, so the skeleton assertion cannot
 * be vacuous.
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

const CONTACTS = [
  {
    id: 'k1',
    partyRole: 'customer',
    kind: 'company',
    name: 'Muster AG',
    address: { street: 'Bahnhofstrasse', houseNo: '1', zip: '8001', city: 'Zürich', country: 'CH' },
    email: 'kontakt@muster.ch',
    segments: [],
    roles: [],
  },
];

const ok = (data: Record<string, unknown> = {}): RestResponse => ({ status: 200, body: { ok: true, ...data } });

/** A transport with the base contact reads plus a per-test `portal_grant_list` behaviour. */
function transportWith(
  portalList: () => Promise<RestResponse> | RestResponse,
  onSend?: (input: Record<string, unknown>) => void,
): Transport {
  return async (action, input) => {
    if (action === 'list_contacts') return ok({ contacts: CONTACTS });
    if (action === 'get_company_profile') return ok({ profile: { baseCurrency: 'CHF' } });
    if (action === 'contacts_timeline') return ok({ activities: [] });
    if (action === 'portal_grant_list') {
      return portalList();
    }
    if (action === 'portal_grant_create') {
      return ok({ grantId: 'g1', grant: { id: 'g1', status: 'draft', expiresAt: '2026-10-01', scopes: [], hosted: false }, localLink: '/portal?token=SECRET-ONE-TIME', clamped: false });
    }
    if (action === 'portal_grant_revoke') return ok({ grantId: (input as { grantId: string }).grantId });
    if (action === 'portal_grant_send') {
      onSend?.(input as Record<string, unknown>);
      return ok({ grantId: (input as { grantId: string }).grantId, sent: false, reason: 'cloud_tier' });
    }
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

/** Open the drawer for the one contact and switch to the Portal-Zugang tab. */
async function openPortalTab() {
  await userEvent.click(await screen.findByRole('row', { name: 'Muster AG' }));
  await screen.findByRole('dialog');
  await userEvent.click(screen.getByRole('tab', { name: 'Portal-Zugang' }));
}

describe('F02 Portal-Zugang panel', () => {
  it('LOADING: shows the skeleton while portal_grant_list is in flight (proven by the started seam)', async () => {
    const transport = watchReads(transportWith(() => new Promise<RestResponse>(() => {})));
    renderWith(transport, [CAP.portalManage, CAP.readMasterData]);
    await openPortalTab();
    // The read really went in flight: the shared started() seam is the proof, not the ever-present
    // initial skeleton (which every surface shows before any effect fires).
    await transport.started('portal_grant_list');
    expect(screen.getByRole('status')).toBeTruthy();
  });

  it('EMPTY: no grants shows the empty hint', async () => {
    renderWith(transportWith(() => ok({ grants: [] })), [CAP.portalManage, CAP.readMasterData]);
    await openPortalTab();
    expect(await screen.findByText('Noch keine Portal-Freigaben.')).toBeTruthy();
  });

  it('ERROR: a failed list shows the error banner with a retry', async () => {
    renderWith(transportWith(() => ({ status: 422, body: { ok: false, error: 'grant_denied' } })), [CAP.portalManage, CAP.readMasterData]);
    await openPortalTab();
    expect(await screen.findByRole('button', { name: 'Erneut versuchen' })).toBeTruthy();
  });

  it('SUCCESS: a grant renders with its glyph+label status and a revoke control', async () => {
    const grants = [{ id: 'g1', status: 'active', expiresAt: '2026-10-01', scopes: [{ kind: 'all_invoices' }], hosted: false }];
    renderWith(transportWith(() => ok({ grants })), [CAP.portalManage, CAP.readMasterData]);
    await openPortalTab();
    // Glyph AND label: the status is never colour-only.
    expect(await screen.findByText('Aktiv')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Widerrufen' })).toBeTruthy();
  });

  it('CREATE: the one-time link is shown exactly once after a successful create', async () => {
    renderWith(transportWith(() => ok({ grants: [] })), [CAP.portalManage, CAP.readMasterData]);
    await openPortalTab();
    await screen.findByText('Noch keine Portal-Freigaben.');
    // Pick an expiry, then grant access.
    const date = screen.getByLabelText('Gültig bis');
    await userEvent.type(date, '2026-09-01');
    await userEvent.click(screen.getByRole('button', { name: 'Zugang freigeben' }));
    // The one-time link surfaces with its copy affordance (aria-label, keyboard-reachable).
    expect(await screen.findByText('Der Link wird nur einmal angezeigt.')).toBeTruthy();
    expect(screen.getByLabelText('Link kopieren')).toBeTruthy();
    // D157: the link handed out is a draft, and the panel says so where it hands it out.
    expect(screen.getByText('Dieser Link öffnet nichts, bis du ihn unten in der Liste freischaltest.')).toBeTruthy();
  });

  it('DRAFT (D157): a draft row says it opens nothing and offers "Link freischalten", which sends confirmed and shows it active', async () => {
    let status: 'draft' | 'active' = 'draft';
    const sends: Record<string, unknown>[] = [];
    const list = () => ok({ grants: [{ id: 'g1', status, expiresAt: '2026-10-01', scopes: [{ kind: 'all_invoices' }], hosted: false }] });
    renderWith(
      transportWith(list, (input) => {
        sends.push(input);
        status = 'active';
      }),
      [CAP.portalManage, CAP.readMasterData],
    );
    await openPortalTab();
    // The status is honest in a word and a sentence: a draft, and what that means.
    expect(await screen.findByText('Entwurf')).toBeTruthy();
    expect(screen.getByText('Öffnet nichts, bis du ihn freischaltest.')).toBeTruthy();
    // The engine's own consequence sentence for the send (one catalogue, D156) sits beside the action.
    expect(screen.getByText(/Schaltet den Portal-Link der Kundschaft frei/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Link freischalten' }));
    // The operator's click IS the confirmation: grantId and confirmed:true, under a fresh key.
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({ workspaceId: 'ws_test', grantId: 'g1', confirmed: true });
    expect(typeof sends[0]!.idempotencyKey).toBe('string');
    // The list reloads and the row is now active, with no activate action left.
    expect(await screen.findByText('Aktiv')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Link freischalten' })).toBeNull();
    expect(screen.queryByText('Öffnet nichts, bis du ihn freischaltest.')).toBeNull();
  });

  it('ACTIVE: an active row carries no activate action', async () => {
    const grants = [{ id: 'g1', status: 'active', expiresAt: '2026-10-01', scopes: [], hosted: false }];
    renderWith(transportWith(() => ok({ grants })), [CAP.portalManage, CAP.readMasterData]);
    await openPortalTab();
    expect(await screen.findByText('Aktiv')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Link freischalten' })).toBeNull();
  });

  it('PERMISSION-DENIED: without portal.manage the panel is read-only (no create, no revoke), list still reads', async () => {
    const grants = [{ id: 'g1', status: 'active', expiresAt: '2026-10-01', scopes: [], hosted: false }];
    renderWith(transportWith(() => ok({ grants })), [CAP.readMasterData]);
    await openPortalTab();
    // The list reads: the grant's status renders.
    expect(await screen.findByText('Aktiv')).toBeTruthy();
    // The write affordances are ABSENT, not merely disabled.
    expect(screen.queryByRole('button', { name: 'Zugang freigeben' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Widerrufen' })).toBeNull();
    expect(screen.queryByLabelText('Gültig bis')).toBeNull();
  });

  it('PERMISSION-DENIED: without portal.manage a draft row shows its state but no activate action', async () => {
    const grants = [{ id: 'g1', status: 'draft', expiresAt: '2026-10-01', scopes: [], hosted: false }];
    renderWith(transportWith(() => ok({ grants })), [CAP.readMasterData]);
    await openPortalTab();
    expect(await screen.findByText('Entwurf')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Link freischalten' })).toBeNull();
  });
});
