/**
 * B02, the Unverrechnet panel and the WIP card (the disjoint `/time` child).
 *
 * The claims: the grouped pile and its total render the numbers the tool returns (P1); the empty
 * pile says so; the Rechnungsentwurf-erstellen CTA is HIDDEN without `billing.generate` (spec §6,
 * never shown-then-rejected) and the whole panel shows a lock without `billing.read`; the CTA calls
 * `billing_generate_invoice` with the selected entries; the WIP card renders the report's value.
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
import { Unbilled } from './Unbilled';
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

const PREVIEW = () =>
  ok({
    totalRappen: 22500,
    groups: [
      {
        contactId: 'c1',
        currency: 'CHF',
        subtotalRappen: 22500,
        projects: [
          {
            projectId: 'proj_1',
            subtotalRappen: 22500,
            phases: [
              {
                phaseId: null,
                subtotalRappen: 22500,
                entries: [
                  { id: 'te_1', startedAt: '2026-07-10T09:00:00.000Z', minutes: 60, notes: 'Konzept', valueRappen: 15000 },
                  { id: 'te_2', startedAt: '2026-07-11T09:00:00.000Z', minutes: 30, notes: null, valueRappen: 7500 },
                ],
              },
            ],
          },
        ],
      },
    ],
  });

const WIP = () =>
  ok({
    totalRappen: 22500,
    asOf: '2026-07-16',
    rows: [{ projectId: 'proj_1', contactId: 'c1', currency: 'CHF', wipRappen: 22500, minutes: 90, entryCount: 2, oldestEntryDate: '2026-07-10', oldestEntryAgeDays: 6 }],
  });

const baseCanned = (caps: string[] = ['billing.read', 'billing.generate']): Canned => ({
  whoami: whoamiWith(caps),
  billing_unbilled_preview: PREVIEW(),
  billing_wip_report: WIP(),
  project_list: ok({ projects: [{ id: 'proj_1', code: 'P-0001', name: 'Website Relaunch', contactId: 'c1', status: 'active' }] }),
  list_contacts: ok({ contacts: [{ id: 'c1', name: 'Kunde AG' }] }),
  billing_generate_invoice: ok({ invoiceId: 'doc_9', lineIds: ['dl_1'], billedEntryIds: ['te_1', 'te_2'], totalRappen: 22500, currency: 'CHF' }),
});

function renderPanel(canned: Canned, asked?: Array<{ action: string; input: Record<string, unknown> }>) {
  return render(
    <TillClientProvider client={new TillClient(fakeTransport(canned, asked))}>
      <I18nProvider>
        <WorkspaceProvider initialId="ws_test">
          <CapabilitiesProvider>
            <MemoryRouter>
              <Unbilled />
            </MemoryRouter>
          </CapabilitiesProvider>
        </WorkspaceProvider>
      </I18nProvider>
    </TillClientProvider>,
  );
}

describe('B02 Unverrechnet panel', () => {
  it('renders the grouped pile and the unbilled total the tool returned', async () => {
    renderPanel(baseCanned());
    expect(await screen.findByText('Kunde AG')).toBeInTheDocument();
    expect(screen.getByText('Konzept', { exact: false })).toBeInTheDocument();
    // The footer total renders CHF 225.00 (22500 Rappen), the number the tool returned.
    expect(screen.getByText(de.billing.total, { exact: false })).toBeInTheDocument();
    expect(screen.getAllByText(/225\.00/).length).toBeGreaterThan(0);
  });

  it('says the pile is empty when there is no unbilled time', async () => {
    renderPanel({ ...baseCanned(), billing_unbilled_preview: ok({ groups: [], totalRappen: 0 }) });
    expect(await screen.findByText(de.billing.empty.unbilled)).toBeInTheDocument();
  });

  it('hides the create-draft CTA without billing.generate (never shown-then-rejected)', async () => {
    renderPanel(baseCanned(['billing.read']));
    expect(await screen.findByText('Kunde AG')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: de.billing.action.generate_draft })).toBeNull();
  });

  it('shows a lock state without billing.read', async () => {
    renderPanel(baseCanned([]));
    expect(await screen.findByText(de.billing.error.permissionDenied)).toBeInTheDocument();
  });

  it('renders the WIP card value from the report', async () => {
    renderPanel(baseCanned());
    const wip = await screen.findByRole('group', { name: de.billing.wip.title });
    expect(within(wip).getAllByText(/225\.00/).length).toBeGreaterThan(0);
  });

  it('generates a draft invoice from the selected entries', async () => {
    const asked: Array<{ action: string; input: Record<string, unknown> }> = [];
    renderPanel(baseCanned(), asked);
    const user = userEvent.setup();
    const checkboxes = await screen.findAllByRole('checkbox');
    await user.click(checkboxes[0]);
    const cta = screen.getByRole('button', { name: de.billing.action.generate_draft });
    expect(cta).toBeEnabled();
    await user.click(cta);
    const gen = asked.find((a) => a.action === 'billing_generate_invoice');
    expect(gen).toBeDefined();
    expect(gen?.input.contactId).toBe('c1');
    expect(gen?.input.timeEntryIds).toEqual(['te_1']);
  });
});
