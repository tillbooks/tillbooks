/**
 * B04, the Mandate tab (the disjoint `/time` child).
 *
 * The claims: the list and each row's burn-down render the numbers the tools return (P5); the empty
 * state says so; the create/generate/close/run-due controls are HIDDEN without `retainer.manage`
 * (spec §6, never shown-then-rejected) and the whole tab shows a lock without `billing.read`;
 * generate calls `retainer_generate_invoice` with the chosen period; run-due calls `retainer_run_due`.
 * Copy is asserted through the catalogue, never as a literal typed here.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider } from '../../app/workspace';
import { CapabilitiesProvider } from '../../lib/CapabilitiesProvider';
import { Retainers } from './Retainers';
import de from './messages.de-CH.json';

type CannedHandler = (input: Record<string, unknown>) => RestResponse;
type Canned = Record<string, RestResponse | CannedHandler>;

const ok = (data: Record<string, unknown> = {}): RestResponse => ({ status: 200, body: { ok: true, ...data } });

function fakeTransport(canned: Canned, asked?: Array<{ action: string; input: Record<string, unknown> }>): Transport {
  return async (action, input) => {
    asked?.push({ action, input: input ?? {} });
    const entry = canned[action];
    if (entry === undefined) return { status: 404, body: { ok: false, error: 'unknown_action' } };
    return typeof entry === 'function' ? entry(input ?? {}) : entry;
  };
}

const whoamiWith = (capabilities: string[]): RestResponse =>
  ok({ actor: 'studio', role: null, isMember: true, provisioned: true, memberId: 'm1', userId: 'studio', capabilities });

const RETAINER = {
  id: 'retainer_1',
  contactId: 'c1',
  projectId: null,
  period: 'monthly',
  feeRappen: 250000,
  includedHours: 10,
  capRappen: 400000,
  rollover: true,
  currency: 'CHF',
  startsOn: '2026-01-01',
  status: 'active',
};

const BURNDOWN = () =>
  ok({
    retainerId: 'retainer_1',
    periodKey: '2026-07',
    generated: false,
    includedMinutes: 600,
    carryoverInMinutes: 0,
    coverageMinutes: 600,
    consumedMinutes: 450,
    coveredMinutes: 450,
    remainingMinutes: 150,
    coverageValueRappen: 112500,
    capRappen: 400000,
    overCapMinutes: 0,
  });

const baseCanned = (caps: string[] = ['billing.read', 'retainer.manage']): Canned => ({
  whoami: whoamiWith(caps),
  retainer_list: ok({ retainers: [RETAINER] }),
  retainer_burndown: BURNDOWN(),
  list_contacts: ok({ contacts: [{ id: 'c1', name: 'Mandat AG' }] }),
  project_list: ok({ projects: [] }),
  retainer_generate_invoice: ok({ invoiceId: 'doc_9', existing: false, retainerId: 'retainer_1', periodKey: '2026-06' }),
  retainer_run_due: ok({ generated: [], existing: [], failed: [] }),
});

function renderTab(canned: Canned, asked?: Array<{ action: string; input: Record<string, unknown> }>) {
  return render(
    <TillClientProvider client={new TillClient(fakeTransport(canned, asked))}>
      <I18nProvider>
        <WorkspaceProvider initialId="ws_test">
          <CapabilitiesProvider>
            <MemoryRouter>
              <Retainers />
            </MemoryRouter>
          </CapabilitiesProvider>
        </WorkspaceProvider>
      </I18nProvider>
    </TillClientProvider>,
  );
}

describe('B04 Mandate tab', () => {
  it('renders the retainer list and its burn-down numbers', async () => {
    renderTab(baseCanned());
    expect(await screen.findByText('Mandat AG')).toBeInTheDocument();
    // 450 covered of 600 coverage minutes renders as h:mm (7:30 / 10:00), the numbers the tool returned.
    expect(screen.getByText(/7:30\s*\/\s*10:00/)).toBeInTheDocument();
  });

  it('says there are no retainers when the list is empty', async () => {
    renderTab({ ...baseCanned(), retainer_list: ok({ retainers: [] }) });
    expect(await screen.findByText(de.retainer.emptyTitle)).toBeInTheDocument();
  });

  it('hides create/generate/close without retainer.manage (never shown-then-rejected)', async () => {
    renderTab(baseCanned(['billing.read']));
    expect(await screen.findByText('Mandat AG')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: de.retainer.action.create })).toBeNull();
    expect(screen.queryByRole('button', { name: de.retainer.action.generate })).toBeNull();
    expect(screen.queryByRole('button', { name: de.retainer.action.close })).toBeNull();
  });

  it('shows a lock state without billing.read', async () => {
    renderTab(baseCanned([]));
    expect(await screen.findByText(de.retainer.error.permissionDenied)).toBeInTheDocument();
  });

  it('generates an invoice for the chosen period', async () => {
    const asked: Array<{ action: string; input: Record<string, unknown> }> = [];
    renderTab(baseCanned(), asked);
    const user = userEvent.setup();
    // K-21: Generieren sits in the row's overflow; the period is asked under the table.
    await user.click(await screen.findByRole('button', { name: /^Aktionen für das Mandat/ }));
    await user.click(screen.getByRole('menuitem', { name: de.retainer.action.generate }));
    const month = screen.getByLabelText(de.retainer.field.genPeriod);
    await user.type(month, '2026-06');
    const form = screen.getByRole('form', { name: de.retainer.action.generate });
    await user.click(within(form).getByRole('button', { name: de.retainer.action.generate }));
    const gen = asked.find((a) => a.action === 'retainer_generate_invoice');
    expect(gen).toBeDefined();
    expect(gen?.input.retainerId).toBe('retainer_1');
    expect(gen?.input.periodKey).toBe('2026-06');
  });

  it('runs all due retainers from the bulk action', async () => {
    const asked: Array<{ action: string; input: Record<string, unknown> }> = [];
    renderTab(baseCanned(), asked);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: de.retainer.action.runDue }));
    expect(asked.some((a) => a.action === 'retainer_run_due')).toBe(true);
  });
});
