/**
 * The Projekterfolg panel (B03 §8): the five canonical states, the basis toggle re-querying the
 * engine, the honesty hints (ⓘ degraded basis, ⚠ over budget, the unattributable note), and the
 * drill table walking its component through `costing_drilldown`. The transport is canned per
 * action, so every assertion is about what the panel sends and renders, not about the engine.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { neverSettles, watchReads } from '../../test-transport';
import { ProjectProfitability } from './index';

type CannedHandler = (input: Record<string, unknown>) => RestResponse;
type Canned = Record<string, RestResponse | CannedHandler>;

function fakeTransport(canned: Canned): Transport {
  return async (action, input) => {
    const entry = canned[action];
    if (entry === undefined) return { status: 404, body: { ok: false, error: 'unknown_action' } };
    return typeof entry === 'function' ? entry(input) : entry;
  };
}

const ok = (data: Record<string, unknown> = {}): RestResponse => ({ status: 200, body: { ok: true, ...data } });
const reject = (error: string, status = 422): RestResponse => ({ status, body: { ok: false, error } });

const PL = {
  projectId: 'p1',
  currency: 'CHF',
  basis: 'bill',
  basisDegraded: false,
  revenueMinor: 900000,
  costMinor: 650000,
  costBreakdown: { timeMinor: 650000, expensesMinor: 0, purchasesMinor: 0, accruedPurchasesMinor: 0 },
  committedMinor: 0,
  marginMinor: 250000,
  marginBp: 2778,
  timeMinutes: 2600,
  unattributableComponents: ['expenses', 'purchases', 'accrued_purchases', 'committed'],
};

const BUDGET = {
  projectId: 'p1',
  budgeted: true,
  currency: 'CHF',
  budgetMinor: 1000000,
  budgetHours: 80,
  costToDateMinor: 650000,
  hoursToDate: 43.33,
  remainingMinor: 350000,
  consumedBp: 6500,
  overBudget: false,
};

const TIME_ROWS = [
  { id: 't1', sourceKind: 'time_entry', amountMinor: 22500, startedAt: '2026-07-01T08:00:00.000Z', minutes: 90, status: 'billed' },
  { id: 't2', sourceKind: 'time_entry', amountMinor: 7500, startedAt: '2026-07-02T08:00:00.000Z', minutes: 30, status: 'approved' },
];

const REVENUE_ROWS = [
  { id: 'l1', sourceKind: 'invoice_line', amountMinor: 900000, issueDate: '2026-07-16', number: 'RE-2026-0001', postedEntryId: 'je1' },
];

const happyCanned = (): Canned => ({
  costing_project_pl: ok(PL),
  costing_budget_vs_actual: ok(BUDGET),
  costing_drilldown: (input) =>
    input.component === 'revenue' ? ok({ rows: REVENUE_ROWS, totalMinor: 900000, nextCursor: null }) : ok({ rows: TIME_ROWS, totalMinor: 650000, nextCursor: null }),
});

function renderPanel(canned: Canned | Transport) {
  const transport = typeof canned === 'function' ? canned : fakeTransport(canned);
  const client = new TillClient(transport);
  return render(
    <TillClientProvider client={client}>
      <I18nProvider>
        <ProjectProfitability workspaceId="ws_test" projectId="p1" />
      </I18nProvider>
    </TillClientProvider>,
  );
}

describe('ProjectProfitability: the five states', () => {
  it('loading: the skeleton is a read in flight, not a default', async () => {
    const transport = watchReads(neverSettles);
    renderPanel(transport);
    await transport.started('costing_project_pl');
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('permission denied: the shared PermissionDenied padlock panel, no emoji, the rest untouched', async () => {
    const { container } = renderPanel({ ...happyCanned(), costing_project_pl: reject('permission_denied', 403) });
    await waitFor(() => expect(screen.getByText('Kein Zugriff auf den Projekterfolg.')).toBeInTheDocument());
    // The DESIGN-conformant shared padlock panel, an SVG glyph plus text, never an emoji marker.
    const denied = screen.getByRole('note');
    expect(denied.querySelector('svg.state-glyph')).not.toBeNull();
    expect(container.textContent).not.toContain('\u{1F512}'); // no padlock emoji marker
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('error: fx_base_missing renders its mapped sentence, never the raw code', async () => {
    renderPanel({ ...happyCanned(), costing_project_pl: reject('fx_base_missing') });
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByText(/CHF-Basisbetrag/)).toBeInTheDocument();
    expect(screen.queryByText('fx_base_missing')).not.toBeInTheDocument();
  });

  it('empty: the zero card with the empty sentence and the margin dash, never a fake 0%', async () => {
    renderPanel({
      ...happyCanned(),
      costing_project_pl: ok({
        ...PL,
        revenueMinor: 0,
        costMinor: 0,
        costBreakdown: { ...PL.costBreakdown, timeMinor: 0 },
        marginMinor: 0,
        marginBp: null,
        timeMinutes: 0,
      }),
      costing_budget_vs_actual: ok({ projectId: 'p1', budgeted: false, currency: 'CHF', costToDateMinor: 0, hoursToDate: 0 }),
      costing_drilldown: ok({ rows: [], totalMinor: 0, nextCursor: null }),
    });
    await waitFor(() => expect(screen.getByText('Noch keine Kosten oder Erträge.')).toBeInTheDocument());
    expect(screen.getByText('–')).toBeInTheDocument();
    // No budget panel on budgeted:false: no fake 0-budget overrun.
    expect(screen.queryByText('Budgetvergleich')).not.toBeInTheDocument();
  });

  it('success: card figures through formatMoney, the budget panel, the unattributable hint', async () => {
    const { container } = renderPanel(happyCanned());
    await waitFor(() => expect(screen.getByText("CHF 9'000.00")).toBeInTheDocument());
    expect(screen.getByText("CHF 2'500.00")).toBeInTheDocument();
    expect(screen.getByText('27.8%')).toBeInTheDocument();
    expect(screen.getByText('Budgetvergleich')).toBeInTheDocument();
    expect(screen.getByText("CHF 3'500.00")).toBeInTheDocument();
    expect(screen.getByText(/können noch keinem Projekt zugeordnet werden/)).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('ProjectProfitability: honesty and interaction', () => {
  it('over budget: the ⚠ badge is glyph+label, never colour alone', async () => {
    renderPanel({
      ...happyCanned(),
      costing_budget_vs_actual: ok({ ...BUDGET, remainingMinor: -50000, consumedBp: 10500, overBudget: true }),
    });
    await waitFor(() => expect(screen.getByText('Budget überschritten')).toBeInTheDocument());
  });

  it('basis toggle: re-queries with basis=cost and shows the degraded-basis hint', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const pl = vi.fn<CannedHandler>((input) => {
      calls.push(input);
      return input.basis === 'cost' ? ok({ ...PL, basis: 'cost', basisDegraded: true }) : ok(PL);
    });
    const user = userEvent.setup();
    renderPanel({ ...happyCanned(), costing_project_pl: pl });
    await waitFor(() => expect(screen.getByText("CHF 9'000.00")).toBeInTheDocument());

    await user.click(screen.getByRole('radio', { name: 'Zu Kostensätzen' }));
    await waitFor(() => expect(screen.getByText('Kein Kostensatz hinterlegt; Verrechnungssatz verwendet.')).toBeInTheDocument());
    expect(calls[calls.length - 1]).toMatchObject({ basis: 'cost', projectId: 'p1' });
  });

  it('drill table: renders the time rows and walks to revenue on the component toggle', async () => {
    const drill = vi.fn<CannedHandler>((input) =>
      input.component === 'revenue'
        ? ok({ rows: REVENUE_ROWS, totalMinor: 900000, nextCursor: null })
        : ok({ rows: TIME_ROWS, totalMinor: 650000, nextCursor: null }),
    );
    const user = userEvent.setup();
    renderPanel({ ...happyCanned(), costing_drilldown: drill });

    await waitFor(() => expect(screen.getByText('01.07.2026')).toBeInTheDocument());
    expect(screen.getByText('90 Min.')).toBeInTheDocument();

    await user.click(screen.getByRole('radio', { name: 'Ertrag' }));
    await waitFor(() => expect(screen.getByText('RE-2026-0001')).toBeInTheDocument());
    expect(drill.mock.calls.some(([input]) => input.component === 'revenue')).toBe(true);
  });
});
