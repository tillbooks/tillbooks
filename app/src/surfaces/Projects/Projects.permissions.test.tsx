/**
 * The A24 padlock on the Projekte surface: with `manage_master_data` every write affordance is
 * present, and without it every one is ABSENT rather than merely disabled (the forward pattern:
 * never shown-then-rejected). Reads keep working either way; the read gate is the engine's.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider } from '../../app/workspace';
import { CapabilitiesContext, CAP, type Capabilities } from '../../lib/capabilities';
import Projects from './index';

const PROJECT = {
  id: 'p1',
  code: 'P-0001',
  name: 'Website Relaunch',
  contactId: 'c1',
  status: 'draft',
  currency: 'CHF',
  budgetMinor: 500000,
  budgetHours: 0,
  budgetBaseMinor: null,
  fxRate: null,
  startsOn: null,
  endsOn: null,
  parentId: null,
};

const transport: Transport = async (action) => {
  const canned: Record<string, RestResponse> = {
    project_list: { status: 200, body: { ok: true, projects: [PROJECT] } },
    list_contacts: { status: 200, body: { ok: true, contacts: [{ id: 'c1', name: 'Muster AG' }] } },
    get_company_profile: { status: 200, body: { ok: true, profile: { baseCurrency: 'CHF' } } },
    project_get: { status: 200, body: { ok: true, project: { ...PROJECT, phases: [] } } },
    project_budget_actual: {
      status: 200,
      body: {
        ok: true,
        budgetMinor: 500000,
        budgetHours: 0,
        actualCostMinor: 0,
        actualHours: 0,
        remainingMinor: 500000,
        remainingHours: 0,
        overBudget: false,
        currency: 'CHF',
        phases: [],
      },
    },
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

function renderWith(capabilities: Capabilities) {
  const client = new TillClient(transport);
  return render(
    <TillClientProvider client={client}>
      <I18nProvider>
        <WorkspaceProvider initialId="ws_test">
          <CapabilitiesContext.Provider value={capabilities}>
            <MemoryRouter>
              <Projects />
            </MemoryRouter>
          </CapabilitiesContext.Provider>
        </WorkspaceProvider>
      </I18nProvider>
    </TillClientProvider>,
  );
}

describe('Projects: the A24 padlock', () => {
  it('with manage_master_data: create, status actions and the row overflow render', async () => {
    const user = userEvent.setup();
    renderWith(caps([CAP.manageMasterData, CAP.readMasterData]));
    const list = await screen.findByRole('table', { name: 'Projektliste' });
    expect(screen.getByRole('button', { name: 'Neues Projekt' })).toBeInTheDocument();
    expect(within(list).getByRole('button', { name: /Aktionen für Website Relaunch/ })).toBeInTheDocument();

    await user.click(within(list).getByRole('row', { name: /^P-0001/ }));
    expect(await screen.findByRole('button', { name: 'Aktivieren' })).toBeInTheDocument();
  });

  it('without it: every write affordance is absent and the panel says read-only', async () => {
    const user = userEvent.setup();
    renderWith(caps([CAP.readMasterData]));
    const list = await screen.findByRole('table', { name: 'Projektliste' });
    expect(screen.queryByRole('button', { name: 'Neues Projekt' })).not.toBeInTheDocument();
    expect(within(list).queryByRole('button', { name: /Aktionen für/ })).not.toBeInTheDocument();

    await user.click(within(list).getByRole('row', { name: /^P-0001/ }));
    await waitFor(() => expect(screen.getByText('Nur Lesezugriff')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Aktivieren' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Phase hinzufügen' })).not.toBeInTheDocument();
  });

  // B03 US-B03.6: the profitability layer gates on its OWN read, separate from the master data
  // around it. Without `costing.read` the panel and the Marge column are HIDDEN (never
  // shown-then-rejected) while the project page itself stays intact.
  it('without costing.read: the Projekterfolg layer is absent, the project page intact', async () => {
    const user = userEvent.setup();
    renderWith(caps([CAP.readMasterData]));
    const list = await screen.findByRole('table', { name: 'Projektliste' });
    await user.click(within(list).getByRole('row', { name: /^P-0001/ }));
    await waitFor(() => expect(screen.getByText('Budget vs. Ist')).toBeInTheDocument());
    expect(screen.queryByText('Projekterfolg')).not.toBeInTheDocument();
    expect(screen.queryByText(/Marge:/)).not.toBeInTheDocument();
  });

  it('with costing.read: the Projekterfolg panel renders inside the detail', async () => {
    const user = userEvent.setup();
    renderWith(caps([CAP.readMasterData, CAP.costingRead]));
    const list = await screen.findByRole('table', { name: 'Projektliste' });
    await user.click(within(list).getByRole('row', { name: /^P-0001/ }));
    // The canned transport answers 404 for the costing verbs here; the panel still mounts and
    // renders its own region, which is the gating claim this suite owns.
    expect(await screen.findByText('Projekterfolg')).toBeInTheDocument();
  });
});
