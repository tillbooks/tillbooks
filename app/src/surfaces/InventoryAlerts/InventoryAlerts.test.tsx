/**
 * J07 Bestand & Alarme: the surface's load states, the report switch, money-at-the-edge rendering and
 * the severity chip. House discipline: every copy assertion goes through the de-CH catalogue rather
 * than a literal typed here, and the loading assertion proves the read went in flight.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider, formatMoney } from '../../i18n';
import { WorkspaceProvider } from '../../app/workspace';
import { watchReads, neverSettles } from '../../test-transport';
import InventoryAlerts from './index';
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
  inventory_alerts: ok({
    alerts: [
      { alert_key: 'low_stock:it1', type: 'low_stock', severity: 'critical', title: 'Low stock', summary: 'Widget: 0/5', suggested_action: 'create_requisition' },
    ],
    counts_by_severity: { critical: 1, warning: 0, info: 0 },
  }),
  inventory_stock_position: ok({
    rows: [{ item_id: 'it1', item_name: 'Widget', item_number: 'W-1', location_name: 'Lager', qty: 12, extended_value_rappen: 40000 }],
    totals: { count: 1, qty: 12, value_rappen: 40000 },
  }),
  inventory_low_stock: ok({ items: [], count: 0 }),
  inventory_reorder_candidates: ok({ candidates: [], count: 0 }),
  inventory_slow_movers: ok({ items: [], count: 0 }),
  inventory_anomalies: ok({ anomalies: [], counts_by_severity: { critical: 0, warning: 0, info: 0 } }),
  inventory_valuation_status: ok({ status: 'aligned', current_value_rappen: 0, last_posted_value_rappen: null, drift_rappen: 0, drift_pct: null }),
  inventory_cycle_count_status: ok({ sessions: [], count: 0 }),
});

function tree(canned: Canned, workspaceId: string | null) {
  return (
    <TillClientProvider client={new TillClient(fakeTransport(canned))}>
      <I18nProvider>
        <WorkspaceProvider initialId={workspaceId}>
          <MemoryRouter>
            <InventoryAlerts />
          </MemoryRouter>
        </WorkspaceProvider>
      </I18nProvider>
    </TillClientProvider>
  );
}

const renderSurface = (canned: Canned, workspaceId: string | null = 'ws_test') => render(tree(canned, workspaceId));

describe('InventoryAlerts, the load states', () => {
  it('shows the loading skeleton once the first report read has started', async () => {
    const transport = watchReads(neverSettles);
    render(
      <TillClientProvider client={new TillClient(transport)}>
        <I18nProvider>
          <WorkspaceProvider initialId="ws_test">
            <MemoryRouter>
              <InventoryAlerts />
            </MemoryRouter>
          </WorkspaceProvider>
        </I18nProvider>
      </TillClientProvider>,
    );
    await transport.started('inventory_alerts');
    expect(document.querySelector('[aria-busy="true"]')).not.toBeNull();
  });

  it('prompts for a workspace when none is chosen', () => {
    renderSurface(baseCanned(), null);
    expect(screen.getByText(de.inventory.alerts.noWorkspace)).toBeInTheDocument();
  });

  it('surfaces the error banner on a failed read', async () => {
    renderSurface({ ...baseCanned(), inventory_alerts: reject('unexpected_error', 500) });
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });
});

describe('InventoryAlerts, the report body', () => {
  it('renders the unified alert with its severity chip, localized on the de-CH default', async () => {
    renderSurface(baseCanned());
    // The low_stock type token localizes to the de-CH label in both the type and title columns.
    expect((await screen.findAllByText(de.inventory.alerts.type.low_stock)).length).toBeGreaterThan(0);
    // The chip carries the localized severity text, not the raw 'critical' token.
    const chip = document.querySelector('.invalerts__chip--critical');
    expect(chip).not.toBeNull();
    expect(chip?.textContent).toBe(de.inventory.alerts.severity.critical);
    // The raw English title must not leak on the de-CH surface.
    expect(screen.queryByText('Low stock')).not.toBeInTheDocument();
  });

  it('localizes an alert row and formats the drift summary as CHF, not raw tokens or Rappen', async () => {
    renderSurface({
      ...baseCanned(),
      inventory_alerts: ok({
        alerts: [
          {
            alert_key: 'valuation_drift:r1',
            type: 'valuation_drift',
            severity: 'warning',
            title: 'Valuation drift',
            summary: '65864 Rappen',
            suggested_action: 'run_valuation',
            payload: { driftRappen: 65864, driftPct: 1.2, lastRunId: 'r1' },
          },
        ],
        counts_by_severity: { critical: 0, warning: 1, info: 0 },
      }),
    });

    // The drift summary is CHF-formatted from the structured payload, not the engine's Rappen prose.
    expect(await screen.findByText(formatMoney(65864, 'CHF'))).toBeInTheDocument();
    // Localized severity on the chip, plus localized type and suggested action (de-CH default).
    const chip = document.querySelector('.invalerts__chip--warning');
    expect(chip?.textContent).toBe(de.inventory.alerts.severity.warning);
    expect(screen.getAllByText(de.inventory.alerts.type.valuation_drift).length).toBeGreaterThan(0);
    expect(screen.getByText(de.inventory.alerts.action.run_valuation)).toBeInTheDocument();

    // None of the raw machine tokens, the English title, nor the raw minor-unit prose may leak.
    expect(screen.queryByText('warning')).not.toBeInTheDocument();
    expect(screen.queryByText('valuation_drift')).not.toBeInTheDocument();
    expect(screen.queryByText('Valuation drift')).not.toBeInTheDocument();
    expect(screen.queryByText('run_valuation')).not.toBeInTheDocument();
    expect(screen.queryByText('65864 Rappen')).not.toBeInTheDocument();
  });

  it('switches to stock position and formats money to CHF at the edge', async () => {
    const user = userEvent.setup();
    renderSurface(baseCanned());
    await screen.findAllByText(de.inventory.alerts.type.low_stock);
    await user.click(screen.getByText(de.inventory.alerts.report.stockPosition));
    expect(await screen.findByText('Widget')).toBeInTheDocument();
    // 40000 Rappen -> 400.00, at the edge, in the row and the totals strip.
    expect(screen.getAllByText('400.00').length).toBeGreaterThan(0);
  });
});
