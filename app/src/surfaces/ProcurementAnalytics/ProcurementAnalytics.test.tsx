/**
 * I06 Einkaufs-Auswertungen: the surface's load states, the report switch, and the money-at-the-edge
 * rendering. House discipline: every copy assertion goes through the de-CH catalogue rather than a
 * literal typed here, and the loading assertion proves the read went in flight.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider } from '../../app/workspace';
import { watchReads, neverSettles } from '../../test-transport';
import ProcurementAnalytics from './index';
import de from './messages.de-CH.json';

type CannedHandler = (input: Record<string, unknown>) => RestResponse;
type Canned = Record<string, RestResponse | CannedHandler>;

const ok = (data: Record<string, unknown> = {}): RestResponse => ({ status: 200, body: { ok: true, ...data } });
const reject = (error: string, status = 422): RestResponse => ({ status, body: { ok: false, error } });

function fakeTransport(canned: Canned): Transport {
  return async (action, input) => {
    const entry = canned[action];
    if (entry === undefined) return { status: 404, body: { ok: false, error: 'unknown_action' } };
    return typeof entry === 'function' ? entry(input ?? {}) : entry;
  };
}

const baseCanned = (): Canned => ({
  procurement_open_commitments: ok({
    rows: [{ poNumber: 'PO-1', supplierName: 'Lieferant GmbH', openQty: 4, openValueRappen: 40000, agingBucket: '0-30' }],
    totals: { count: 1, open_value_rappen: 40000, by_aging: {} },
  }),
  procurement_match_status: ok({ summary: { matched: { count: 1, value_rappen: 100000 } }, exceptions: [], status: 'clean' }),
  procurement_spend_summary: ok({ rows: [], grand_total: { billed_rappen: 0 } }),
  procurement_supplier_scorecard: ok({ rows: [] }),
  procurement_requisition_pipeline: ok({ summary: {}, rows: [], conversion: { conversion_rate_pct: 0 } }),
  procurement_grir_clearing: ok({ received_not_invoiced: { count: 0, residual_value_rappen: 0 }, invoiced_not_received: { count: 0, residual_value_rappen: 0 }, net_exposure_rappen: 0, status: 'cleared' }),
  procurement_landed_cost_variance: ok({ rows: [] }),
  procurement_po_cycle: ok({ groups: [] }),
  procurement_anomalies: ok({ anomalies: [] }),
});

function tree(canned: Canned, workspaceId: string | null) {
  return (
    <TillClientProvider client={new TillClient(fakeTransport(canned))}>
      <I18nProvider>
        <WorkspaceProvider initialId={workspaceId}>
          <MemoryRouter>
            <ProcurementAnalytics />
          </MemoryRouter>
        </WorkspaceProvider>
      </I18nProvider>
    </TillClientProvider>
  );
}

const renderSurface = (canned: Canned, workspaceId: string | null = 'ws_test') => render(tree(canned, workspaceId));

describe('ProcurementAnalytics, the load states', () => {
  it('shows the loading skeleton once the first report read has started', async () => {
    const transport = watchReads(neverSettles);
    render(
      <TillClientProvider client={new TillClient(transport)}>
        <I18nProvider>
          <WorkspaceProvider initialId="ws_test">
            <MemoryRouter>
              <ProcurementAnalytics />
            </MemoryRouter>
          </WorkspaceProvider>
        </I18nProvider>
      </TillClientProvider>,
    );
    await transport.started('procurement_open_commitments');
    expect(document.querySelector('[aria-busy="true"]')).not.toBeNull();
  });

  it('prompts for a workspace when none is chosen', () => {
    renderSurface(baseCanned(), null);
    expect(screen.getByText(de.procurement.analytics.noWorkspace)).toBeInTheDocument();
  });

  it('surfaces the error banner on a failed read', async () => {
    renderSurface({ ...baseCanned(), procurement_open_commitments: reject('unexpected_error', 500) });
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });
});

describe('ProcurementAnalytics, the report body', () => {
  it('renders the open-commitments rows with money formatted to CHF at the edge', async () => {
    renderSurface(baseCanned());
    expect(await screen.findByText('PO-1')).toBeInTheDocument();
    expect(screen.getByText('Lieferant GmbH')).toBeInTheDocument();
    // 40000 Rappen -> 400.00 (formatted at the edge); it appears in the row and the totals strip.
    expect(screen.getAllByText('400.00').length).toBeGreaterThan(0);
  });

  it('switches to another report and runs its verb, rendering its empty state', async () => {
    const user = userEvent.setup();
    renderSurface(baseCanned());
    await screen.findByText('PO-1');
    await user.click(screen.getByText(de.procurement.analytics.report.grirClearing));
    // GR/IR always renders its two RNI/INR rows, and the net-exposure total from the payload.
    expect(await screen.findByText(de.procurement.analytics.total.netExposure)).toBeInTheDocument();
  });
});
