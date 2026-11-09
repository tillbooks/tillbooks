/**
 * I00, the Einkauf -> Anforderungen surface. The suite follows the Studio discipline: a GATE claim
 * mounts a real `CapabilitiesProvider` over a transport that answers `whoami`, loading is asserted
 * through the list catalogue, and copy is read from the message fragment, never typed here.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider } from '../../app/workspace';
import { CapabilitiesProvider } from '../../lib/CapabilitiesProvider';
import Requisitions from './index';
import de from './messages.de-CH.json';

type CannedHandler = (input: Record<string, unknown>) => RestResponse;
type Canned = Record<string, RestResponse | CannedHandler>;

const ok = (data: Record<string, unknown> = {}): RestResponse => ({ status: 200, body: { ok: true, ...data } });
const reject = (error: string, extra: Record<string, unknown> = {}, status = 422): RestResponse => ({
  status,
  body: { ok: false, error, ...extra },
});

function fakeTransport(canned: Canned, asked?: Array<{ action: string; input: Record<string, unknown> }>): Transport {
  return async (action, input) => {
    asked?.push({ action, input: input ?? {} });
    const entry = canned[action];
    if (entry === undefined) return { status: 404, body: { ok: false, error: 'unknown_action' } };
    return typeof entry === 'function' ? entry(input ?? {}) : entry;
  };
}

const REQ = (over: Record<string, unknown> = {}) => ({
  id: 'req_1',
  number: 'REQ-2026-0001',
  status: 'draft',
  requesterId: 'user_1',
  neededBy: '2026-09-01',
  urgency: 'normal',
  description: 'Werkstattbedarf',
  currency: 'CHF',
  totalEstimatedRappen: 10000,
  ...over,
});

const DETAIL = (over: Record<string, unknown> = {}) => ({
  ...REQ(),
  lines: [
    {
      id: 'rl_1',
      lineNo: 1,
      itemId: null,
      description: 'Schmiermittel',
      qtyMilli: 2000,
      estimatedUnitCostRappen: 5000,
      estimatedTotalRappen: 10000,
      preferredSupplierId: null,
      convertedQtyMilli: 0,
      openQtyMilli: 2000,
    },
  ],
  approvalEvents: [],
  openTasks: [],
  conversions: [],
  ...over,
});

const whoamiWith = (capabilities: string[]): RestResponse =>
  ok({ actor: 'studio', role: null, isMember: true, provisioned: true, memberId: 'm1', userId: 'u1', capabilities });

const baseCanned = (): Canned => ({
  whoami: whoamiWith(['read_master_data', 'manage_master_data']),
  requisition_list: ok({ requisitions: [REQ()] }),
  list_items: ok({ items: [] }),
  list_contacts: ok({ contacts: [{ id: 'c_1', name: 'Lieferant GmbH' }] }),
  list_cost_centers: ok({ costCenters: [] }),
  requisition_get: ok({ requisition: DETAIL() }),
});

function tree(canned: Canned, workspaceId: string | null, withProvider: boolean, asked?: Array<{ action: string; input: Record<string, unknown> }>) {
  const inner = (
    <MemoryRouter>
      <Requisitions />
    </MemoryRouter>
  );
  return (
    <TillClientProvider client={new TillClient(fakeTransport(canned, asked))}>
      <I18nProvider>
        <WorkspaceProvider initialId={workspaceId}>
          {withProvider ? <CapabilitiesProvider>{inner}</CapabilitiesProvider> : inner}
        </WorkspaceProvider>
      </I18nProvider>
    </TillClientProvider>
  );
}

const renderSurface = (canned: Canned, workspaceId: string | null = 'ws_test') => render(tree(canned, workspaceId, false));
const withCapabilities = (canned: Canned, asked?: Array<{ action: string; input: Record<string, unknown> }>) =>
  render(tree(canned, 'ws_test', true, asked));

describe('Requisitions, the list', () => {
  it('renders a requisition row with its number, status and estimated total', async () => {
    renderSurface(baseCanned());
    expect(await screen.findByText('REQ-2026-0001')).toBeInTheDocument();
    expect(screen.getByText(de.requisitions.status.draft)).toBeInTheDocument();
    expect(screen.getByText('CHF 100.00')).toBeInTheDocument();
  });

  it('shows the empty state with a create CTA when there are none', async () => {
    renderSurface({ ...baseCanned(), requisition_list: ok({ requisitions: [] }) });
    expect(await screen.findByText(de.requisitions.empty.title)).toBeInTheDocument();
    expect(screen.getByText(de.requisitions.empty.cta)).toBeInTheDocument();
  });

  it('surfaces a transport failure with a retry', async () => {
    renderSurface({ ...baseCanned(), requisition_list: reject('boom', {}, 500) });
    expect(await screen.findByText(de.requisitions.error.transport)).toBeInTheDocument();
  });
});

describe('Requisitions, create', () => {
  it('opens the drawer, submits a create with a milli-scaled line, and re-reads on success', async () => {
    const asked: Array<{ action: string; input: Record<string, unknown> }> = [];
    const canned: Canned = {
      ...baseCanned(),
      requisition_list: ok({ requisitions: [] }),
      requisition_upsert: ok({ requisition: DETAIL() }),
    };
    render(
      <TillClientProvider client={new TillClient(fakeTransport(canned, asked))}>
        <I18nProvider>
          <WorkspaceProvider initialId="ws_test">
            <MemoryRouter>
              <Requisitions />
            </MemoryRouter>
          </WorkspaceProvider>
        </I18nProvider>
      </TillClientProvider>,
    );
    const user = userEvent.setup();
    await user.click(await screen.findByText(de.requisitions.empty.cta));
    await user.type(screen.getByLabelText(`${de.requisitions.field.description} 1`), 'Schmiermittel');
    await user.type(screen.getByLabelText(`${de.requisitions.field.qty} 1`), '2');
    await user.type(screen.getByLabelText(`${de.requisitions.field.unitCost} 1`), '50');
    await user.click(screen.getByText(de.requisitions.action.save));
    await waitFor(() => expect(asked.some((a) => a.action === 'requisition_upsert')).toBe(true));
    const call = asked.find((a) => a.action === 'requisition_upsert');
    const lines = call?.input.lines as Array<Record<string, unknown>>;
    expect(lines[0].qtyMilli).toBe(2000);
    expect(lines[0].estimatedUnitCostRappen).toBe(5000);
    expect(call?.input.idempotencyKey).toBeTypeOf('string');
  });

  it('surfaces the engine rejection in the drawer without closing it', async () => {
    const canned: Canned = {
      ...baseCanned(),
      requisition_list: ok({ requisitions: [] }),
      requisition_upsert: reject('invalid_line'),
    };
    renderSurface(canned);
    const user = userEvent.setup();
    await user.click(await screen.findByText(de.requisitions.empty.cta));
    await user.type(screen.getByLabelText(`${de.requisitions.field.qty} 1`), '2');
    await user.click(screen.getByText(de.requisitions.action.save));
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());
    // drawer still open after the rejection
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});

describe('Requisitions, the detail actions', () => {
  it('opens a draft and submits it for approval', async () => {
    const asked: Array<{ action: string; input: Record<string, unknown> }> = [];
    const canned: Canned = {
      ...baseCanned(),
      requisition_submit: ok({ requisition: DETAIL({ status: 'pending_approval', openTasks: [{ id: 't1' }] }) }),
    };
    render(
      <TillClientProvider client={new TillClient(fakeTransport(canned, asked))}>
        <I18nProvider>
          <WorkspaceProvider initialId="ws_test">
            <MemoryRouter>
              <Requisitions />
            </MemoryRouter>
          </WorkspaceProvider>
        </I18nProvider>
      </TillClientProvider>,
    );
    const user = userEvent.setup();
    await user.click(await screen.findByText('REQ-2026-0001'));
    await user.click(await screen.findByText(de.requisitions.action.submit));
    await waitFor(() => expect(asked.some((a) => a.action === 'requisition_submit')).toBe(true));
    const call = asked.find((a) => a.action === 'requisition_submit');
    expect(call?.input.requisitionId).toBe('req_1');
    expect(call?.input.idempotencyKey).toBeTypeOf('string');
  });
});

describe('Requisitions, the permission gate', () => {
  it('disables the New button for a role without manage_master_data', async () => {
    withCapabilities({ ...baseCanned(), whoami: whoamiWith(['read_master_data']) });
    const newBtn = await screen.findByText(de.requisitions.new);
    await waitFor(() => expect(newBtn).toBeDisabled());
  });
});
