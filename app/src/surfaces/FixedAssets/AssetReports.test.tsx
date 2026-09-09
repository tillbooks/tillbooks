/**
 * H09, the Fixed Assets -> Reports surface. Same discipline as the AssetReconciliation suite: a fake
 * transport answers each report verb, loading is asserted through the rendered table, and copy is read
 * from the message fragment, never typed here. The cases that matter: the default Register tab renders
 * rows and a totals footer; switching to Disposals loads that verb and shows the gain/loss; switching to
 * Forecast shows the projected periods and surfaces the production-data warning.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider } from '../../app/workspace';
import { AssetReports } from './AssetReports';
import de from './messages.de-CH.json';

type CannedHandler = (input: Record<string, unknown>) => RestResponse;
type Canned = Record<string, RestResponse | CannedHandler>;

const ok = (data: Record<string, unknown> = {}): RestResponse => ({ status: 200, body: { ok: true, ...data } });

function fakeTransport(canned: Canned): Transport {
  return async (action, input) => {
    const entry = canned[action];
    if (entry === undefined) return { status: 404, body: { ok: false, error: 'unknown_action' } };
    return typeof entry === 'function' ? entry(input ?? {}) : entry;
  };
}

const registerReport = ok({
  rows: [
    {
      id: 'a1',
      number: 'FA-0001',
      name: 'CNC Fräse',
      categoryCode: 'MACH',
      status: 'active',
      acquisitionCostRappen: 1_200_000,
      accumulatedDeprRappen: 100_000,
      netBookValueRappen: 1_100_000,
    },
  ],
  totals: { count: 1, costRappen: 1_200_000, accumRappen: 100_000, nbvRappen: 1_100_000 },
});

const disposalSummary = ok({
  disposals: [
    {
      transactionId: 't1',
      assetNumber: 'FA-0002',
      name: 'Presse',
      disposalDate: '2026-07-20',
      originalCostRappen: 600_000,
      accumDeprAtDisposalRappen: 0,
      nbvAtDisposalRappen: 600_000,
      proceedsRappen: 700_000,
      gainLossRappen: 100_000,
      journalEntryId: 'je1',
    },
  ],
  totals: { count: 1, proceedsRappen: 700_000, gainRappen: 100_000, lossRappen: 0, netGainLossRappen: 100_000 },
});

const forecast = ok({
  fromPeriod: '2026-08',
  toPeriod: '2026-10',
  groupBy: 'none',
  periods: [
    { period: '2026-08', totalAmountRappen: 100_000 },
    { period: '2026-09', totalAmountRappen: 100_000 },
    { period: '2026-10', totalAmountRappen: 100_000 },
  ],
  totalProjectedRappen: 300_000,
  assetsReachingResidual: 0,
  warnings: ['production_data_required'],
});

function renderSurface(canned: Canned, workspaceId: string | null = 'ws_test') {
  return render(
    <TillClientProvider client={new TillClient(fakeTransport(canned))}>
      <I18nProvider>
        <WorkspaceProvider initialId={workspaceId}>
          <MemoryRouter>
            <AssetReports />
          </MemoryRouter>
        </WorkspaceProvider>
      </I18nProvider>
    </TillClientProvider>,
  );
}

describe('AssetReports', () => {
  it('renders the Register tab by default with rows and a totals footer', async () => {
    renderSurface({ asset_register_report: registerReport });
    expect(await screen.findByText(/FA-0001/)).toBeInTheDocument();
    expect(screen.getByText('CNC Fräse')).toBeInTheDocument();
    // The NBV appears in the row and again in the totals footer.
    expect(screen.getAllByText("CHF 11'000.00").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(de.assets.reports.status.active)).toBeInTheDocument();
  });

  it('loads the Disposals report when its tab is selected and shows the gain', async () => {
    renderSurface({ asset_register_report: registerReport, asset_disposal_summary: disposalSummary });
    await screen.findByText(/FA-0001/);
    const user = userEvent.setup();
    await user.click(screen.getByRole('tab', { name: de.assets.reports.tab.disposals }));
    expect(await screen.findByText(/FA-0002/)).toBeInTheDocument();
    // The gain is proceeds above book value: it shows in the row and again in the totals net cell.
    expect(screen.getAllByText("CHF 1'000.00").length).toBeGreaterThanOrEqual(2);
  });

  it('loads the Forecast report and surfaces the production-data warning', async () => {
    renderSurface({ asset_register_report: registerReport, asset_depreciation_forecast: forecast });
    await screen.findByText(/FA-0001/);
    const user = userEvent.setup();
    await user.click(screen.getByRole('tab', { name: de.assets.reports.tab.forecast }));
    expect(await screen.findByText('2026-08')).toBeInTheDocument();
    expect(screen.getByText(de.assets.reports.forecast.productionDataRequired)).toBeInTheDocument();
  });
});
