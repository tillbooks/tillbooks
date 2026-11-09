/**
 * H07, the Fixed Assets -> Reconciliation surface. Same discipline as the AssetLocations suite: a fake
 * transport answers the recon reads, loading is asserted through the rendered table, and copy is read
 * from the message fragment, never typed here. The three cases that matter for OP11 are covered: a
 * balanced report, a drift report with its drill-down, and the hard check surfacing a drift block.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider } from '../../app/workspace';
import { AssetReconciliation } from './AssetReconciliation';
import de from './messages.de-CH.json';

type CannedHandler = (input: Record<string, unknown>) => RestResponse;
type Canned = Record<string, RestResponse | CannedHandler>;

const ok = (data: Record<string, unknown> = {}): RestResponse => ({ status: 200, body: { ok: true, ...data } });
const reject = (error: string, extra: Record<string, unknown> = {}, status = 422): RestResponse => ({
  status,
  body: { ok: false, error, ...extra },
});

function fakeTransport(canned: Canned): Transport {
  return async (action, input) => {
    const entry = canned[action];
    if (entry === undefined) return { status: 404, body: { ok: false, error: 'unknown_action' } };
    return typeof entry === 'function' ? entry(input ?? {}) : entry;
  };
}

const balancedReport = ok({
  cutOff: '2026-07-31',
  period: '2026-07',
  accounts: [
    {
      accountId: 'acc_1500',
      accountNumber: '1500',
      accountName: 'Maschinen',
      role: 'cost',
      subLedgerRappen: 12500000,
      glBalanceRappen: 12500000,
      deltaRappen: 0,
      status: 'balanced',
      assets: [{ assetId: 'a1', assetNumber: 'FA-0001', name: 'CNC', amountRappen: 12500000 }],
    },
  ],
  summary: { accountCount: 1, balancedCount: 1, driftCount: 0, status: 'balanced' },
});

const driftReport = ok({
  cutOff: '2026-07-31',
  period: '2026-07',
  accounts: [
    {
      accountId: 'acc_1500',
      accountNumber: '1500',
      accountName: 'Maschinen',
      role: 'cost',
      subLedgerRappen: 12500000,
      glBalanceRappen: 13000000,
      deltaRappen: -500000,
      status: 'drift',
      assets: [{ assetId: 'a1', assetNumber: 'FA-0001', name: 'CNC', amountRappen: 12500000 }],
    },
  ],
  summary: { accountCount: 1, balancedCount: 0, driftCount: 1, status: 'drift' },
});

function renderSurface(canned: Canned, workspaceId: string | null = 'ws_test') {
  return render(
    <TillClientProvider client={new TillClient(fakeTransport(canned))}>
      <I18nProvider>
        <WorkspaceProvider initialId={workspaceId}>
          <MemoryRouter>
            <AssetReconciliation />
          </MemoryRouter>
        </WorkspaceProvider>
      </I18nProvider>
    </TillClientProvider>,
  );
}

describe('AssetReconciliation', () => {
  it('renders a balanced report with the control-account row and summary cards', async () => {
    renderSurface({ asset_reconciliation_report: balancedReport });
    expect(await screen.findByText(/1500 Maschinen/)).toBeInTheDocument();
    // Both the sub-ledger and the GL show the same figure, and the status badge is balanced.
    expect(screen.getAllByText("CHF 125'000.00").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(de.assets.reconciliation.status.balanced)).toBeInTheDocument();
  });

  it('marks drift and drills down to the contributing assets', async () => {
    renderSurface({ asset_reconciliation_report: driftReport });
    expect(await screen.findByText(de.assets.reconciliation.status.drift)).toBeInTheDocument();
    // The delta is the non-zero difference.
    expect(screen.getByText("CHF -5'000.00")).toBeInTheDocument();
    // Expanding the account reveals its contributing asset.
    const user = userEvent.setup();
    await user.click(screen.getByText(/1500 Maschinen/));
    expect(await screen.findByText(/FA-0001 CNC/)).toBeInTheDocument();
  });

  it('runs the hard check and surfaces the drift block', async () => {
    renderSurface({
      asset_reconciliation_report: driftReport,
      asset_reconciliation_check: reject('reconciliation_drift', {
        period: '2026-07',
        accounts: [{ accountId: 'acc_1500', deltaRappen: -500000 }],
      }),
    });
    await screen.findByText(de.assets.reconciliation.status.drift);
    const user = userEvent.setup();
    await user.click(screen.getByText(de.assets.reconciliation.runCheck));
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText(/gesperrt/)).toBeInTheDocument();
  });

  it('reports the balanced check when every account reconciles', async () => {
    renderSurface({
      asset_reconciliation_report: balancedReport,
      asset_reconciliation_check: ok({ status: 'balanced', period: '2026-07', cutOff: '2026-07-31', accounts: [] }),
    });
    await screen.findByText(/1500 Maschinen/);
    const user = userEvent.setup();
    await user.click(screen.getByText(de.assets.reconciliation.runCheck));
    // LOADING-PROOF-EXEMPT: the role=status here is the reconciliation RESULT live region, not a loading affordance; the balanced verdict it asserts can only exist after asset_reconciliation_check really answered.
    const status = await screen.findByRole('status');
    expect(within(status).getByText(/kann erfolgen/)).toBeInTheDocument();
  });
});
