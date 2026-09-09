/**
 * F5: the Kontenplan surface had NO padlock gating at all; every write affordance leaned on the
 * engine's `permission_denied`. These tests hold the courtesy gate to the engine's declarations:
 * `manage_chart` for every account and cost-centre write. The `ALLOW_ALL` default is why no other
 * Accounts test needed touching, and why a test that never provides a denying context proves
 * nothing: these provide one.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider } from '../../app/workspace';
import { CapabilitiesContext, CAP, type Capabilities } from '../../lib/capabilities';
import Accounts from './index';

// The PINNED recording, never hand-typed rows: `test/accounts/studio-list-accounts-fixture.test.mjs`
// holds every Studio consumer of `list_accounts` to a real engine answer.
import listAccountsFixture from './list-accounts.fixture.json';

const COST_CENTERS = [{ id: 'cc1', code: 'KS1', name: 'Vertrieb', archived: false, inUse: false }];

const transport: Transport = async (action) => {
  const canned: Record<string, RestResponse> = {
    list_accounts: { status: 200, body: { ...listAccountsFixture, ok: true as const } },
    list_cost_centers: { status: 200, body: { ok: true, costCenters: COST_CENTERS } },
    vat_codes: { status: 200, body: { ok: true, codes: [] } },
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
    <TillClientProvider client={new TillClient(transport)}>
      <I18nProvider>
        <WorkspaceProvider initialId="ws_test">
          <CapabilitiesContext.Provider value={caps(held)}>
            <Accounts />
          </CapabilitiesContext.Provider>
        </WorkspaceProvider>
      </I18nProvider>
    </TillClientProvider>,
  );
}

describe('Kontenplan, the A24 padlock (F5)', () => {
  it('renders every write affordance for an actor holding manage_chart', async () => {
    renderWith([CAP.manageChart]);
    await screen.findByText('Kassenbestand');

    expect(screen.getByRole('button', { name: 'Neues Konto' })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Bearbeiten' }).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Neue Kostenstelle' })).toBeTruthy();
  });

  it('HIDES the create, edit and row overflows without it, while the chart still reads', async () => {
    renderWith(['read_books']);
    await screen.findByText('Kassenbestand');

    expect(screen.queryByRole('button', { name: 'Neues Konto' })).toBeNull();
    expect(screen.queryAllByRole('button', { name: 'Bearbeiten' })).toHaveLength(0);
    expect(screen.queryByRole('button', { name: 'Neue Kostenstelle' })).toBeNull();
    // The list itself still renders: the padlock hides writes, it does not blank the screen.
    expect(screen.getByText('Bankkonto')).toBeTruthy();
    expect(screen.getByText('Vertrieb')).toBeTruthy();
  });
});
