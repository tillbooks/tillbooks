/**
 * D02 Einkauf: the surface's five states and the lifecycle affordances, plus the embedded 3-way-match
 * panel. Follows the house discipline: a gate claim mounts a real CapabilitiesProvider over a transport
 * that answers `whoami`, a loading assertion waits for the read to have STARTED, and every copy
 * assertion goes through the catalogue rather than a literal typed here.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider } from '../../app/workspace';
import { CapabilitiesProvider } from '../../lib/CapabilitiesProvider';
import { neverSettles, watchReads } from '../../test-transport';
import { BillMatchPanel } from './BillMatchPanel';
import Purchasing from './index';
import de from './messages.de-CH.json';

type CannedHandler = (input: Record<string, unknown>) => RestResponse;
type Canned = Record<string, RestResponse | CannedHandler>;

const ok = (data: Record<string, unknown> = {}): RestResponse => ({ status: 200, body: { ok: true, ...data } });
const reject = (error: string, extra: Record<string, unknown> = {}, status = 422): RestResponse => ({ status, body: { ok: false, error, ...extra } });

function fakeTransport(canned: Canned): Transport {
  return async (action, input) => {
    const entry = canned[action];
    if (entry === undefined) return { status: 404, body: { ok: false, error: 'unknown_action' } };
    return typeof entry === 'function' ? entry(input ?? {}) : entry;
  };
}

const PO = (over: Record<string, unknown> = {}) => ({
  id: 'po_1',
  number: 'PO-0001',
  supplierContactId: 'contact_1',
  status: 'draft',
  revision: 1,
  currency: 'CHF',
  totalRappen: 100000,
  expectedOn: null,
  ...over,
});

const DETAIL = (po: Record<string, unknown>) =>
  ok({
    po,
    lines: [{ id: 'pl_1', itemId: 'item_1', description: null, qty: 10, unitPriceRappen: 10000, receivedQty: 0, billedQty: 0, openQty: 10 }],
    receipts: [],
    matches: [],
  });

const whoamiWith = (capabilities: string[]): RestResponse =>
  ok({ actor: 'studio', role: null, isMember: true, provisioned: true, memberId: 'm1', userId: 'u1', capabilities });

const baseCanned = (pos: Record<string, unknown>[] = [PO()]): Canned => ({
  whoami: whoamiWith(['read_master_data', 'manage_master_data']),
  po_list: ok({ pos }),
  po_get: DETAIL(pos[0] ?? PO()),
  po_open_lines: ok({ lines: [] }),
  supplier_price_list: ok({ prices: [], resolved: null }),
  list_contacts: ok({ contacts: [{ id: 'contact_1', name: 'Lieferant GmbH' }] }),
  list_items: ok({ items: [{ id: 'item_1', name: 'Rohstoff' }] }),
  stock_on_hand: ok({ locations: [{ id: 'loc_1', name: 'Wareneingang', archived: false }] }),
});

function tree(canned: Canned, workspaceId: string | null, withProvider: boolean) {
  const inner = (
    <MemoryRouter>
      <Purchasing />
    </MemoryRouter>
  );
  return (
    <TillClientProvider client={new TillClient(fakeTransport(canned))}>
      <I18nProvider>
        <WorkspaceProvider initialId={workspaceId}>{withProvider ? <CapabilitiesProvider>{inner}</CapabilitiesProvider> : inner}</WorkspaceProvider>
      </I18nProvider>
    </TillClientProvider>
  );
}

const renderSurface = (canned: Canned, workspaceId: string | null = 'ws_test') => render(tree(canned, workspaceId, false));
const withCapabilities = (canned: Canned, workspaceId: string | null = 'ws_test') => render(tree(canned, workspaceId, true));

describe('Purchasing, the load states', () => {
  it('shows the loading skeleton once the list read has actually started', async () => {
    const transport = watchReads(neverSettles);
    render(
      <TillClientProvider client={new TillClient(transport)}>
        <I18nProvider>
          <WorkspaceProvider initialId="ws_test">
            <MemoryRouter>
              <Purchasing />
            </MemoryRouter>
          </WorkspaceProvider>
        </I18nProvider>
      </TillClientProvider>,
    );
    await transport.started('po_list');
    const busy = document.querySelector('[aria-busy="true"]');
    expect(busy).not.toBeNull();
  });

  it('renders the padlock when the list read is refused, never an empty list', async () => {
    renderSurface({ ...baseCanned(), po_list: reject('permission_denied', {}, 403) });
    expect(await screen.findByText(de.po.error.permissionDenied.read)).toBeInTheDocument();
    expect(screen.queryByText(de.po.empty)).not.toBeInTheDocument();
  });

  it('renders the error banner on a failed read', async () => {
    renderSurface({ ...baseCanned(), po_list: reject('boom', {}, 500) });
    expect(await screen.findByText(de.po.error.transport)).toBeInTheDocument();
  });

  it('renders the empty state when there are no purchase orders', async () => {
    renderSurface({ ...baseCanned([]) });
    expect(await screen.findByText(de.po.empty)).toBeInTheDocument();
  });
});

describe('Purchasing, the list and detail', () => {
  it('lists a PO with its number and a glyph+label status', async () => {
    renderSurface(baseCanned());
    expect(await screen.findByText('PO-0001')).toBeInTheDocument();
    expect(screen.getByText(de.po.status.draft)).toBeInTheDocument();
  });

  it('opens the detail and offers Send on a draft PO', async () => {
    const user = userEvent.setup();
    withCapabilities(baseCanned());
    // The PO list is the shared DataTable now: the row is a keyboard-activatable <tr>, opened by
    // clicking its number cell, and the detail lives in a DetailDrawer.
    await user.click(await screen.findByText('PO-0001'));
    expect(await screen.findByRole('button', { name: de.po.action.send })).toBeInTheDocument();
    // The detail is the shared DetailDrawer, a focus-trapped dialog.
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('offers the goods-receipt form on a sent PO', async () => {
    const user = userEvent.setup();
    const sent = PO({ status: 'sent' });
    withCapabilities({ ...baseCanned([sent]), po_get: DETAIL(sent) });
    await user.click(await screen.findByText('PO-0001'));
    expect(await screen.findByRole('button', { name: de.po.action.receipt })).toBeInTheDocument();
  });
});

describe('Purchasing, the permission gate', () => {
  it('hides the New order action without the write capability', async () => {
    withCapabilities({ ...baseCanned(), whoami: whoamiWith(['read_master_data']) });
    expect(await screen.findByText('PO-0001')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: de.po.action.new })).not.toBeInTheDocument();
  });

  it('shows the New order action with the write capability', async () => {
    withCapabilities(baseCanned());
    expect(await screen.findByRole('button', { name: de.po.action.new })).toBeInTheDocument();
  });
});

describe('Purchasing, the Offene Mengen tab', () => {
  it('lists open lines from po_open_lines', async () => {
    const user = userEvent.setup();
    renderSurface({ ...baseCanned(), po_open_lines: ok({ lines: [{ lineId: 'pl_1', poId: 'po_1', poNumber: 'PO-0001', itemId: 'item_1', qty: 10, receivedQty: 4, openQty: 6 }] }) });
    await user.click(await screen.findByRole('tab', { name: de.po.tab.open }));
    expect(await screen.findByText('Rohstoff')).toBeInTheDocument();
  });
});

function matchTree(canned: Canned) {
  return (
    <TillClientProvider client={new TillClient(fakeTransport(canned))}>
      <I18nProvider>
        <WorkspaceProvider initialId="ws_test">
          <MemoryRouter>
            <BillMatchPanel billId="vbill_1" vendorId="contact_1" />
          </MemoryRouter>
        </WorkspaceProvider>
      </I18nProvider>
    </TillClientProvider>
  );
}

describe('BillMatchPanel, the embedded 3-way-match affordance', () => {
  it('reports a matched verdict within tolerance', async () => {
    const user = userEvent.setup();
    render(
      matchTree({
        po_list: ok({ pos: [PO({ status: 'received' })] }),
        po_get: DETAIL(PO({ status: 'received' })),
        match_bill: ok({ match: { status: 'matched', priceVarianceRappen: 0 }, matched: true }),
      }),
    );
    // Pick the PO, then run the match.
    const select = await screen.findByRole('combobox');
    await user.click(select);
    await user.click(await screen.findByRole('option', { name: 'PO-0001' }));
    await user.click(await screen.findByRole('button', { name: de.po.action.match }));
    expect(await screen.findByText(de.po.match.ok)).toBeInTheDocument();
  });

  it('reports a variance and offers an override when over tolerance', async () => {
    const user = userEvent.setup();
    render(
      matchTree({
        po_list: ok({ pos: [PO({ status: 'received' })] }),
        po_get: DETAIL(PO({ status: 'received' })),
        match_bill: reject('variance_exceeded', { priceVarianceRappen: 5000 }),
      }),
    );
    const select = await screen.findByRole('combobox');
    await user.click(select);
    await user.click(await screen.findByRole('option', { name: 'PO-0001' }));
    await user.click(await screen.findByRole('button', { name: de.po.action.match }));
    expect(await screen.findByText(de.po.error.variance_exceeded)).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: de.po.match.override })).toBeInTheDocument();
  });

  it('shows the empty state when the supplier has no matchable PO', async () => {
    render(matchTree({ po_list: ok({ pos: [] }) }));
    expect(await screen.findByText(de.po.emptyMatch)).toBeInTheDocument();
  });
});

const SCORECARD = () =>
  ok({
    supplier: { id: 'contact_1', name: 'Lieferant GmbH' },
    period: { from: '2026-01-01', to: '2026-03-31', windowDays: 90 },
    counts: { receipts: 3, lines: 5, matches: 2 },
    empty: false,
    metrics: [
      { id: 'otif_pct', value: 80, unit: 'pct', normalised: 80, status: 'amber', weight: 40 },
      { id: 'price_variance_pct', value: 2, unit: 'pct', normalised: 98, status: 'green', weight: 25 },
      { id: 'overall_score', value: 75, unit: 'score', normalised: 75, status: 'amber', weight: null },
    ],
    overallScore: 75,
    activityCount: 3,
    previous: { from: '2025-10-03', to: '2025-12-31', overallScore: 73 },
    trendDelta: 2,
    exceptions: [{ kind: 'late_delivery', receiptNumber: 'GR-0001', poId: 'po_1', detail: { delayDays: 4 } }],
  });

const scorecardCanned = (): Canned => ({
  ...baseCanned(),
  supplier_performance_rank: ok({
    metric: 'overall_score',
    rows: [{ supplierId: 'contact_1', name: 'Lieferant GmbH', score: 75, metricValue: 75, activityCount: 3, previousDelta: 2 }],
    insufficient: [],
    total: 1,
  }),
  supplier_performance_alerts: ok({ alerts: [{ supplierId: 'contact_1', name: 'Lieferant GmbH', metric: 'otif_pct', value: 80, threshold: 85 }] }),
  supplier_scorecard_get: SCORECARD(),
});

describe('Purchasing, the I05 scorecard tab', () => {
  it('shows the ranked leaderboard and alerts when the scorecard tab is opened', async () => {
    const user = userEvent.setup();
    renderSurface(scorecardCanned());
    await user.click(await screen.findByRole('tab', { name: de.po.tab.scorecard }));
    expect(await screen.findByText(de.po.scorecard.leaderboard)).toBeInTheDocument();
    expect(await screen.findByText(de.po.scorecard.alertsTitle)).toBeInTheDocument();
  });

  it('renders the overall score and metric cards once a supplier is picked', async () => {
    const user = userEvent.setup();
    renderSurface(scorecardCanned());
    await user.click(await screen.findByRole('tab', { name: de.po.tab.scorecard }));
    const picker = await screen.findByLabelText(de.po.scorecard.supplier);
    await user.click(picker);
    await user.click(await screen.findByRole('option', { name: 'Lieferant GmbH' }));
    expect(await screen.findByText(de.po.scorecard.metric.otif_pct)).toBeInTheDocument();
    // The OTIF card value renders from the picked supplier's scorecard.
    expect(await screen.findByText('80%')).toBeInTheDocument();
  });
});
