/**
 * J06, the Inventory -> Bestandesbewertung & Abstimmung surface. The suite follows the Studio
 * discipline: a transport answers `whoami` and the reads, loading is asserted through the rendered
 * table, copy is read from the message fragment (never typed here), and every write is proven by the
 * action the transport was ASKED for, including the generated idempotency key.
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
import ValuationRuns from './index';
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
  ok({ actor: 'studio', role: null, isMember: true, provisioned: true, memberId: 'm1', userId: 'u1', capabilities });

const RUN = (over: Record<string, unknown> = {}) => ({
  id: 'run_1',
  asOf: '2026-03-31',
  period: '2026-03',
  method: 'weighted_average',
  status: 'posted',
  totalValueRappen: 18000,
  deltaRappen: 18000,
  lineCount: 1,
  journalEntryId: 'e1',
  isOpening: false,
  ...over,
});

const DRAFT_LINE = {
  id: 'l1',
  itemId: 'it_1',
  itemName: 'Widget',
  locationId: 'loc_a',
  qty: 12,
  unitCostRappen: 1500,
  valueRappen: 18000,
  controlAccountId: 'acc_1200',
  isMarketWriteDown: false,
};

const baseCanned = (): Canned => ({
  whoami: whoamiWith(['read_master_data', 'post']),
  inventory_valuation_list: ok({ items: [RUN()], total: 1 }),
  inventory_valuation_create: ok({ run: RUN({ id: 'run_2', status: 'draft', deltaRappen: 18000 }), lines: [DRAFT_LINE] }),
  inventory_valuation_post: ok({ run: RUN({ id: 'run_2' }), journalEntryId: 'e2', deltaRappen: 18000 }),
  inventory_valuation_report: ok({
    source: 'live',
    totalValueRappen: 18000,
    byAccount: [{ accountId: 'acc_1200', valueRappen: 18000, lineCount: 1 }],
    lines: [DRAFT_LINE],
  }),
  inventory_reconciliation_report: ok({
    status: 'balanced',
    accounts: [{ accountId: 'acc_1200', subLedgerRappen: 18000, glBalanceRappen: 18000, deltaRappen: 0, status: 'balanced' }],
    balancedCount: 1,
    driftCount: 0,
    unpostedCount: 0,
  }),
});

function renderSurface(canned: Canned, asked?: Array<{ action: string; input: Record<string, unknown> }>) {
  return render(
    <TillClientProvider client={new TillClient(fakeTransport(canned, asked))}>
      <I18nProvider>
        <WorkspaceProvider initialId="ws_test">
          <CapabilitiesProvider>
            <MemoryRouter>
              <ValuationRuns />
            </MemoryRouter>
          </CapabilitiesProvider>
        </WorkspaceProvider>
      </I18nProvider>
    </TillClientProvider>,
  );
}

describe('ValuationRuns, the J06 GL-link surface', () => {
  it('lists valuation runs with their status and value', async () => {
    renderSurface(baseCanned());
    expect(await screen.findByTestId('runs-table')).toBeInTheDocument();
    expect(screen.getByText('2026-03-31')).toBeInTheDocument();
    expect(screen.getByText(de.invRun.status.posted)).toBeInTheDocument();
    expect(screen.getAllByText("CHF 180.00").length).toBeGreaterThanOrEqual(1);
  });

  it('drafts a run, shows the review lines and the proposed adjustment, then posts it', async () => {
    const asked: Array<{ action: string; input: Record<string, unknown> }> = [];
    renderSurface(baseCanned(), asked);
    await screen.findByTestId('runs-table');

    await userEvent.click(screen.getByTestId('new-run'));
    await userEvent.click(screen.getByTestId('calculate'));

    // The review table shows the drafted line and the proposed value.
    expect(await screen.findByTestId('draft-review')).toBeInTheDocument();
    expect(screen.getByTestId('draft-line')).toBeInTheDocument();
    const createCall = asked.find((a) => a.action === 'inventory_valuation_create');
    expect(typeof createCall?.input.idempotencyKey).toBe('string');
    expect(createCall?.input.asOf).toBeTruthy();

    // Posting is confirm-gated: the drawer's Post opens the alertdialog, and the post only leaves the
    // surface on the confirm. The confirm dialog reads its ARIA role from the Modal primitive.
    await userEvent.click(screen.getByTestId('post-run'));
    const confirm = await screen.findByTestId('confirm-post-run');
    expect(confirm).toBeInTheDocument();
    await userEvent.click(confirm);
    await waitFor(() => expect(asked.some((a) => a.action === 'inventory_valuation_post')).toBe(true));
    const postCall = asked.find((a) => a.action === 'inventory_valuation_post');
    expect(postCall?.input.runId).toBe('run_2');
    expect(typeof postCall?.input.idempotencyKey).toBe('string');
  });

  it('computes the live valuation report grouped by control account', async () => {
    const asked: Array<{ action: string; input: Record<string, unknown> }> = [];
    renderSurface(baseCanned(), asked);
    await screen.findByTestId('runs-table');
    await userEvent.click(screen.getByRole('tab', { name: de.invRun.tab.report }));
    await userEvent.click(screen.getByTestId('run-report'));
    expect(await screen.findByTestId('report-result')).toBeInTheDocument();
    expect(asked.some((a) => a.action === 'inventory_valuation_report')).toBe(true);
  });

  it('reconciles a period and shows the balanced status per account', async () => {
    renderSurface(baseCanned());
    await screen.findByTestId('runs-table');
    await userEvent.click(screen.getByRole('tab', { name: de.invRun.tab.reconciliation }));
    await userEvent.click(screen.getByTestId('run-recon'));
    expect(await screen.findByTestId('recon-result')).toBeInTheDocument();
    // The per-account reconciliation row renders inside the shared DataTable, keyed by its account.
    expect(screen.getByText('acc_1200')).toBeInTheDocument();
    expect(screen.getByTestId('recon-status')).toHaveTextContent(de.invRun.reconStatus.balanced);
  });

  it('surfaces a reconciliation drift as an error state on the report', async () => {
    const canned = baseCanned();
    canned.inventory_reconciliation_report = ok({
      status: 'drift',
      accounts: [{ accountId: 'acc_1200', subLedgerRappen: 18000, glBalanceRappen: 23000, deltaRappen: -5000, status: 'drift' }],
      driftCount: 1,
      balancedCount: 0,
      unpostedCount: 0,
    });
    renderSurface(canned);
    await screen.findByTestId('runs-table');
    await userEvent.click(screen.getByRole('tab', { name: de.invRun.tab.reconciliation }));
    await userEvent.click(screen.getByTestId('run-recon'));
    expect(await screen.findByTestId('recon-status')).toHaveTextContent(de.invRun.reconStatus.drift);
  });

  it('hides the post/reverse affordance without the post capability', async () => {
    const canned = baseCanned();
    canned.whoami = whoamiWith(['read_master_data']);
    renderSurface(canned);
    await screen.findByTestId('runs-table');
    expect(screen.getByTestId('new-run')).toBeDisabled();
    // A posted run offers no reverse control to a reader who cannot post.
    expect(screen.queryByText(de.invRun.reverse)).not.toBeInTheDocument();
  });
});
