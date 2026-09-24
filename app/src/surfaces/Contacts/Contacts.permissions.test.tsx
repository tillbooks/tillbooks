/**
 * Coverage gap 7: the Kontakte surface had NO padlock gating at all.
 *
 * Merge, Import and Anonymisieren always rendered and leaned on the engine's `permission_denied`,
 * which is the shown-then-rejected shape the A24 forward pattern exists to prevent and which five
 * shipped surfaces already avoid (`app/src/lib/capabilities.ts`, and Customization.tsx's
 * `canManageFields ? … : null`).
 *
 * Two properties, and the second one is the one that keeps the tests honest: with the capability the
 * whole surface is exactly what it was, and without it every write affordance is absent rather than
 * merely disabled. The `ALLOW_ALL` default is why no other Contacts test needed touching, and it is
 * also why a test that never provides a denying context proves nothing: these provide one.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
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
    vatNumber: 'CHE-123.456.789 MWST',
    email: 'kontakt@muster.ch',
    segments: ['newsletter'],
    roles: [],
  },
  {
    id: 'k2',
    partyRole: 'customer',
    kind: 'company',
    name: 'Muster Aktiengesellschaft',
    address: null,
    segments: [],
    roles: [],
  },
];

const transport: Transport = async (action) => {
  const canned: Record<string, RestResponse> = {
    list_contacts: { status: 200, body: { ok: true, contacts: CONTACTS } },
    get_company_profile: { status: 200, body: { ok: true, profile: { baseCurrency: 'CHF' } } },
    contacts_timeline: { status: 200, body: { ok: true, activities: [] } },
  };
  return canned[action] ?? { status: 404, body: { ok: false, error: 'unknown_action' } };
};

/** A capability context that answers a fixed set, so the fail-open default cannot mask the gate. */
function caps(held: readonly string[]): Capabilities {
  return {
    whoami: {
      actor: 'studio',
      provisioned: true,
      isMember: true,
      memberId: 'm1',
      userId: 'u1',
      role: 'viewer',
      capabilities: [...held],
    },
    can: (capability) => held.includes(capability),
    refresh: () => undefined,
  };
}

function renderWith(held: readonly string[]) {
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

describe('Kontakte, the A24 padlock', () => {
  it('renders every write affordance for an actor holding manage_master_data AND contacts.merge', async () => {
    renderWith([CAP.manageMasterData, CAP.contactsMerge]);
    await screen.findByRole('row', { name: 'Muster AG' });

    expect(screen.getByRole('button', { name: 'Importieren' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Neuer Kontakt' })).toBeTruthy();
    expect(screen.getAllByRole('checkbox', { name: /für das Zusammenführen auswählen/ }).length).toBeGreaterThan(0);
  });

  it('holding only manage_master_data keeps the ordinary writes and HIDES the elevated pair (F5)', async () => {
    // The engine requires ['manage_master_data', 'contacts.merge'] for merge and anonymise since the
    // F5 retrofit, so the courtesy gate must match: checkboxes feed only the merge, and Anonymisieren
    // is the erasure path. Create, edit and import stay, because the coarse grant still covers them.
    renderWith([CAP.manageMasterData]);
    await screen.findByRole('row', { name: 'Muster AG' });

    expect(screen.getByRole('button', { name: 'Importieren' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Neuer Kontakt' })).toBeTruthy();
    expect(screen.queryAllByRole('checkbox', { name: /für das Zusammenführen auswählen/ })).toHaveLength(0);
    expect(screen.queryByRole('button', { name: 'Zusammenführen' })).toBeNull();

    await userEvent.click(screen.getByRole('row', { name: 'Muster AG' }));
    await screen.findByRole('dialog');
    expect(screen.queryByRole('button', { name: 'Anonymisieren' })).toBeNull();
    // The ordinary drawer write survives: the split removes the elevated pair, nothing else.
    expect(screen.getByLabelText('Segment hinzufügen')).toBeTruthy();
  });

  it('HIDES Importieren, Kontakt anlegen, Bearbeiten and the merge selection without it', async () => {
    renderWith(['read_master_data']);
    await screen.findByRole('row', { name: 'Muster AG' });

    expect(screen.queryByRole('button', { name: 'Importieren' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Neuer Kontakt' })).toBeNull();
    expect(screen.queryAllByRole('button', { name: 'Bearbeiten' })).toHaveLength(0);
    // K-21: Bearbeiten lives in the row overflow, and without the right there is no overflow at all.
    expect(screen.queryAllByRole('button', { name: /Weitere Aktionen für Kontakt/ })).toHaveLength(0);
    // No selection checkbox, so the merge toolbar it feeds can never appear: a selection whose only
    // consumer is hidden is a dead end.
    expect(screen.queryAllByRole('checkbox', { name: /für das Zusammenführen auswählen/ })).toHaveLength(0);
    expect(screen.queryByRole('button', { name: 'Zusammenführen' })).toBeNull();
    // The LIST still reads. The padlock hides writes, it does not blank the screen.
    expect(screen.getByRole('row', { name: 'Muster AG' })).toBeTruthy();
  });

  it('HIDES Anonymisieren and the drawer write forms without it, while the timeline still reads', async () => {
    renderWith(['read_master_data']);
    await userEvent.click(await screen.findByRole('row', { name: 'Muster AG' }));
    const drawer = await screen.findByRole('dialog');

    expect(screen.queryByRole('button', { name: 'Anonymisieren' })).toBeNull();
    // The add-a-segment write is gone; the chips that READ the same field stay.
    expect(screen.queryByLabelText('Segment hinzufügen')).toBeNull();
    expect(drawer.textContent).toContain('newsletter');

    // Verlauf: the log form is hidden (US-C00.3's padlock) and the timeline itself still loads.
    await userEvent.click(screen.getByRole('tab', { name: 'Verlauf' }));
    await waitFor(() => {
      expect(screen.queryByLabelText('Text')).toBeNull();
    });
    expect(screen.queryByRole('button', { name: 'Erfassen' })).toBeNull();
  });

  it('shows the drawer write forms WITH the capabilities, so the gate is not a wall', async () => {
    renderWith([CAP.manageMasterData, CAP.contactsMerge]);
    await userEvent.click(await screen.findByRole('row', { name: 'Muster AG' }));
    await screen.findByRole('dialog');

    expect(screen.getByRole('button', { name: 'Anonymisieren' })).toBeTruthy();
    expect(screen.getByLabelText('Segment hinzufügen')).toBeTruthy();
  });
});
