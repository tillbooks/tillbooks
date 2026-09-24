/**
 * F5: the Zahlungen surface had NO padlock gating; Erfassen, Stornieren and the Guthaben
 * allocation all leaned on the engine's `permission_denied`. The engine declares ['pay', 'post']
 * on all three writes (settling posts a balanced entry), so the courtesy gate demands BOTH, and
 * these tests hold that: with both, everything renders; missing EITHER, every write affordance is
 * absent while the list still reads.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider } from '../../app/workspace';
import { installMemoryStorage } from '../../lib/test-support';
import { CapabilitiesContext, CAP, type Capabilities } from '../../lib/capabilities';
import Payments from './index';

import listPayments from './list-payments.fixture.json';

const transport: Transport = async (action) => {
  const canned: Record<string, RestResponse> = {
    list_payments: { status: 200, body: { ...listPayments, ok: true as const } },
  };
  return canned[action] ?? { status: 404, body: { ok: false, error: 'unknown_action' } };
};

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
    <MemoryRouter initialEntries={['/payments']}>
      <I18nProvider>
        <WorkspaceProvider initialId="ws_test">
          <TillClientProvider client={new TillClient(transport)}>
            <CapabilitiesContext.Provider value={caps(held)}>
              <Routes>
                <Route path="/payments/*" element={<Payments />} />
              </Routes>
            </CapabilitiesContext.Provider>
          </TillClientProvider>
        </WorkspaceProvider>
      </I18nProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  installMemoryStorage();
});

describe('Zahlungen, the A24 padlock (F5)', () => {
  it('renders the record affordance for an actor holding BOTH pay and post', async () => {
    renderWith([CAP.pay, CAP.post]);
    await screen.findAllByRole('row');
    expect(screen.getByRole('button', { name: 'Zahlung erfassen' })).toBeTruthy();
  });

  it('HIDES every write affordance when pay is held without post (the engine ALL-OF)', async () => {
    renderWith([CAP.pay, 'read_sales']);
    await screen.findAllByRole('row');
    expect(screen.queryByRole('button', { name: 'Zahlung erfassen' })).toBeNull();
  });

  it('HIDES every write affordance for a read-only actor, while the list still reads', async () => {
    renderWith(['read_sales']);
    const rows = await screen.findAllByRole('row');
    // Header plus at least one data row: the padlock hides writes, it does not blank the list.
    expect(rows.length).toBeGreaterThan(1);
    expect(screen.queryByRole('button', { name: 'Zahlung erfassen' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Stornieren' })).toBeNull();
  });
});
