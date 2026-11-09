/**
 * The Pipeline surface: C01's human face over the deal board.
 *
 * The suite follows the Aufgaben discipline: every claim about a GATE mounts a real
 * `CapabilitiesProvider` over a transport that answers `whoami` (the hook fails open, so a test
 * without the provider measures the permissive default and calls it a permission test), a loading
 * assertion waits for the read to have STARTED, and copy is asserted through the catalogue, never
 * as a literal typed here.
 *
 * The two C01-specific claims worth singling out: picking the LOST stage never fires a write
 * directly (the reason form appears first, so `lost_reason_required` is a form and not a
 * surprise), and picking the WON stage routes through `deals_mark` rather than `deals_move`,
 * mirroring the engine's one-door rule.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { MemoryRouter } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider } from '../../app/workspace';
import { CapabilitiesProvider } from '../../lib/CapabilitiesProvider';
import { neverSettles, watchReads } from '../../test-transport';
import Deals from './index';
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

// --- The engine's own payload shapes -----------------------------------------------------------

const STAGES = [
  { id: 'st_lead', pipelineId: 'pl_1', name: 'Lead', sort: 0, probability: 10, outcome: null },
  { id: 'st_qual', pipelineId: 'pl_1', name: 'Qualifiziert', sort: 1, probability: 35, outcome: null },
  { id: 'st_won', pipelineId: 'pl_1', name: 'Gewonnen', sort: 3, probability: 100, outcome: 'won' },
  { id: 'st_lost', pipelineId: 'pl_1', name: 'Verloren', sort: 4, probability: 0, outcome: 'lost' },
];

const DEAL = (over: Record<string, unknown> = {}) => ({
  id: 'deal_1',
  contactId: 'contact_1',
  pipelineId: 'pl_1',
  stageId: 'st_lead',
  title: 'Website-Relaunch',
  status: 'open',
  probability: 10,
  probabilityOverridden: false,
  valueMinor: 250000,
  currency: 'CHF',
  valueBaseMinor: 250000,
  fxRate: '1',
  weightedMinor: 25000,
  expectedCloseOn: null,
  lostReason: null,
  quoteId: null,
  createdAt: '2026-07-01T00:00:00.000Z',
  updatedAt: '2026-07-01T00:00:00.000Z',
  ...over,
});

const BOARD = (deals: Record<string, unknown>[] = [DEAL()], over: Record<string, unknown> = {}) =>
  ok({
    pipelines: [{ id: 'pl_1', name: 'Pipeline' }],
    pipeline: { id: 'pl_1', name: 'Pipeline' },
    stages: STAGES,
    deals,
    weightedTotalMinor: deals.filter((d) => d.status === 'open').reduce((s, d) => s + (d.weightedMinor as number), 0),
    total: deals.length,
    baseCurrency: 'CHF',
    ...over,
  });

const whoamiWith = (actor: string, capabilities: string[]): RestResponse =>
  ok({ actor, role: null, isMember: true, provisioned: true, memberId: 'm1', userId: 'u1', capabilities });

const baseCanned = (): Canned => ({
  whoami: whoamiWith('studio', ['deals.read', 'deals.write']),
  deals_list: BOARD(),
  list_saved_views: ok({ savedViews: [] }),
  list_contacts: ok({ contacts: [{ id: 'contact_1', name: 'Muster AG' }] }),
});

function tree(canned: Canned, workspaceId: string | null, withProvider: boolean) {
  const inner = (
    <MemoryRouter>
      <Deals />
    </MemoryRouter>
  );
  return (
    <TillClientProvider client={new TillClient(fakeTransport(canned))}>
      <I18nProvider>
        <WorkspaceProvider initialId={workspaceId}>
          {withProvider ? <CapabilitiesProvider>{inner}</CapabilitiesProvider> : inner}
        </WorkspaceProvider>
      </I18nProvider>
    </TillClientProvider>
  );
}

const renderDeals = (canned: Canned, workspaceId: string | null = 'ws_test') => render(tree(canned, workspaceId, false));
const withCapabilities = (canned: Canned, workspaceId: string | null = 'ws_test') => render(tree(canned, workspaceId, true));

describe('Deals, the load states', () => {
  it('shows the loading skeleton once the board read has actually started', async () => {
    const transport = watchReads(neverSettles);
    render(
      <TillClientProvider client={new TillClient(transport)}>
        <I18nProvider>
          <WorkspaceProvider initialId="ws_test">
            <MemoryRouter>
              <Deals />
            </MemoryRouter>
          </WorkspaceProvider>
        </I18nProvider>
      </TillClientProvider>,
    );
    await transport.started('deals_list');
    const statuses = screen.getAllByRole('status');
    expect(statuses.length).toBeGreaterThan(0);
    for (const node of statuses) expect(node).toHaveAttribute('aria-busy', 'true');
  });

  it('renders a board-shaped loading skeleton (columns matching the layout, not a bare stack) once the read has started', async () => {
    const transport = watchReads(neverSettles);
    const { container } = render(
      <TillClientProvider client={new TillClient(transport)}>
        <I18nProvider>
          <WorkspaceProvider initialId="ws_test">
            <MemoryRouter>
              <Deals />
            </MemoryRouter>
          </WorkspaceProvider>
        </I18nProvider>
      </TillClientProvider>,
    );
    await transport.started('deals_list');
    // DESIGN.md "Skeleton matching the real layout" + C01 spec section 6 "column skeletons": the
    // loading region is one status node holding board-shaped column blocks, not a flat row stack.
    const region = container.querySelector('.deals-board-skeleton');
    expect(region).not.toBeNull();
    expect(region).toHaveAttribute('role', 'status');
    expect(region).toHaveAttribute('aria-busy', 'true');
    expect(container.querySelectorAll('.deals-skeleton-column').length).toBeGreaterThan(1);
  });

  it('renders the padlock when the board read is refused (the deals.read gate), never an empty board', async () => {
    renderDeals({ ...baseCanned(), deals_list: reject('permission_denied', { capability: 'deals.read' }, 403) });
    expect(await screen.findByText(de.deals.error.permissionDenied.read)).toBeInTheDocument();
    expect(screen.queryByText(de.deals.empty)).not.toBeInTheDocument();
  });

  it('renders the error banner with a retry on a failed read', async () => {
    renderDeals({ ...baseCanned(), deals_list: reject('boom', {}, 500) });
    expect(await screen.findByText(de.deals.error.transport)).toBeInTheDocument();
  });

  it('states what the surface is for when there are no deals, with the create CTA', async () => {
    renderDeals({ ...baseCanned(), deals_list: BOARD([]) });
    expect(await screen.findByText(de.deals.empty)).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: de.deals.action.create }).length).toBeGreaterThan(0);
  });
});

describe('Deals, the board', () => {
  it('groups cards under stage columns and shows the weighted pill in the base currency', async () => {
    const canned = {
      ...baseCanned(),
      deals_list: BOARD([
        DEAL(),
        DEAL({ id: 'deal_2', title: 'Wartungsvertrag', stageId: 'st_qual', probability: 35, weightedMinor: 43750, valueMinor: 125000, valueBaseMinor: 125000 }),
      ]),
    };
    renderDeals(canned);
    expect(await screen.findByText('Website-Relaunch')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Qualifiziert/ })).toBeInTheDocument();
    // 25'000 + 43'750 Rappen weighted = CHF 687.50: the pill shows the SUM the payload states.
    expect(screen.getByText(/687\.50/)).toBeInTheDocument();
    // Empty columns state their own emptiness rather than collapsing.
    expect(screen.getAllByText(de.deals.emptyColumn).length).toBeGreaterThan(0);
  });

  it('shows "-" in the weighted pill when no open deal exists (data honesty, never CHF 0.00)', async () => {
    const canned = {
      ...baseCanned(),
      deals_list: BOARD([DEAL({ status: 'lost', stageId: 'st_lost', lostReason: 'Budget', weightedMinor: 0 })]),
    };
    renderDeals(canned);
    expect(await screen.findByText('Website-Relaunch')).toBeInTheDocument();
    expect(screen.getByText('-')).toBeInTheDocument();
  });

  it('the FilterBar quick-filter narrows the board to matching cards (client-side, title or contact)', async () => {
    const canned = {
      ...baseCanned(),
      deals_list: BOARD([
        DEAL(),
        DEAL({ id: 'deal_2', title: 'Wartungsvertrag', stageId: 'st_qual', weightedMinor: 43750, valueMinor: 125000, valueBaseMinor: 125000 }),
      ]),
    };
    renderDeals(canned);
    expect(await screen.findByText('Website-Relaunch')).toBeInTheDocument();
    expect(screen.getByText('Wartungsvertrag')).toBeInTheDocument();
    // Typing a title fragment hides the non-matching card; the read is not re-issued (purely local).
    await userEvent.type(screen.getByRole('searchbox', { name: de.deals.search }), 'Wartung');
    expect(screen.getByText('Wartungsvertrag')).toBeInTheDocument();
    expect(screen.queryByText('Website-Relaunch')).not.toBeInTheDocument();
    // Clear is the way back from a filtered-empty board (FilterBar's own affordance).
    await userEvent.click(screen.getByRole('button', { name: de.deals.filter.clear }));
    expect(screen.getByText('Website-Relaunch')).toBeInTheDocument();
  });

  it('has no axe violations on the loaded board', async () => {
    const { container } = renderDeals(baseCanned());
    await screen.findByText('Website-Relaunch');
    expect(await axe(container)).toHaveNoViolations();
  });

  it('opens the detail as a right-side pane beside the board (never a dead click below the fold)', async () => {
    const { container } = renderDeals(baseCanned());
    await userEvent.click(await screen.findByRole('button', { name: /Website-Relaunch/ }));
    // The board and the drawer are siblings in the two-pane workspace, so opening a card shows its
    // detail alongside the board rather than pushing it under a horizontally-scrolling column set.
    const workspace = container.querySelector('.deals-workspace');
    expect(workspace).not.toBeNull();
    expect(workspace?.querySelector('.deals-main')).not.toBeNull();
    const drawer = workspace?.querySelector('.deals-drawer');
    expect(drawer).not.toBeNull();
    expect(screen.getByRole('heading', { name: 'Website-Relaunch' })).toBeInTheDocument();
    // The drawer stays keyboard-escapable: its close control carries an aria-label, never a bare glyph.
    expect(screen.getByRole('button', { name: de.deals.drawer.close })).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('Deals, the gates (real CapabilitiesProvider, real whoami)', () => {
  it('hides create, settings and the stage picker without deals.write', async () => {
    const canned = { ...baseCanned(), whoami: whoamiWith('viewer-actor', ['deals.read']) };
    withCapabilities(canned);
    await screen.findByText('Website-Relaunch');
    expect(screen.queryByRole('button', { name: de.deals.action.create })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: de.deals.settings.open })).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: de.deals.action.move })).not.toBeInTheDocument();
  });
});

describe('Deals, the writes', () => {
  it('moves to an OPEN stage through deals_move with the picked stageId', async () => {
    const asked: Array<{ action: string; input: Record<string, unknown> }> = [];
    const canned = { ...baseCanned(), deals_move: ok({ dealId: 'deal_1' }) };
    render(
      <TillClientProvider client={new TillClient(fakeTransport(canned, asked))}>
        <I18nProvider>
          <WorkspaceProvider initialId="ws_test">
            <MemoryRouter>
              <Deals />
            </MemoryRouter>
          </WorkspaceProvider>
        </I18nProvider>
      </TillClientProvider>,
    );
    await screen.findByText('Website-Relaunch');
    await userEvent.click(screen.getByRole('combobox', { name: de.deals.action.move }));
    await userEvent.click(screen.getByRole('option', { name: 'Qualifiziert' }));
    await waitFor(() => {
      const move = asked.find((a) => a.action === 'deals_move');
      expect(move?.input.stageId).toBe('st_qual');
      expect(move?.input.dealId).toBe('deal_1');
    });
  });

  it('routes the WON stage through deals_mark (the one door), never deals_move', async () => {
    const asked: Array<{ action: string; input: Record<string, unknown> }> = [];
    const canned = { ...baseCanned(), deals_mark: ok({ dealId: 'deal_1', wonDealId: 'deal_1', lostDealId: null }) };
    render(
      <TillClientProvider client={new TillClient(fakeTransport(canned, asked))}>
        <I18nProvider>
          <WorkspaceProvider initialId="ws_test">
            <MemoryRouter>
              <Deals />
            </MemoryRouter>
          </WorkspaceProvider>
        </I18nProvider>
      </TillClientProvider>,
    );
    await screen.findByText('Website-Relaunch');
    await userEvent.click(screen.getByRole('combobox', { name: de.deals.action.move }));
    await userEvent.click(screen.getByRole('option', { name: 'Gewonnen' }));
    await waitFor(() => {
      expect(asked.some((a) => a.action === 'deals_mark' && a.input.status === 'won')).toBe(true);
      expect(asked.some((a) => a.action === 'deals_move')).toBe(false);
    });
  });

  it('picking the LOST stage opens the reason form first, and submits deals_mark with the reason', async () => {
    const asked: Array<{ action: string; input: Record<string, unknown> }> = [];
    const canned = { ...baseCanned(), deals_mark: ok({ dealId: 'deal_1', wonDealId: null, lostDealId: 'deal_1' }) };
    render(
      <TillClientProvider client={new TillClient(fakeTransport(canned, asked))}>
        <I18nProvider>
          <WorkspaceProvider initialId="ws_test">
            <MemoryRouter>
              <Deals />
            </MemoryRouter>
          </WorkspaceProvider>
        </I18nProvider>
      </TillClientProvider>,
    );
    await screen.findByText('Website-Relaunch');
    await userEvent.click(screen.getByRole('combobox', { name: de.deals.action.move }));
    await userEvent.click(screen.getByRole('option', { name: 'Verloren' }));
    // No write yet: the reason comes first.
    expect(asked.some((a) => a.action === 'deals_mark')).toBe(false);
    await userEvent.type(screen.getByLabelText(de.deals.lost.reason), 'Budget gestrichen');
    await userEvent.click(screen.getByRole('button', { name: de.deals.action.markLost }));
    await waitFor(() => {
      const mark = asked.find((a) => a.action === 'deals_mark');
      expect(mark?.input.status).toBe('lost');
      expect(mark?.input.lostReason).toBe('Budget gestrichen');
    });
  });

  it('converts to a quote from the drawer and shows the FX base amount beside a foreign value', async () => {
    const asked: Array<{ action: string; input: Record<string, unknown> }> = [];
    const canned = {
      ...baseCanned(),
      deals_list: BOARD([
        DEAL({ currency: 'EUR', valueMinor: 100000, valueBaseMinor: 93000, fxRate: '0.93', weightedMinor: 9300 }),
      ]),
      deals_to_quote: ok({ dealId: 'deal_1', quoteId: 'doc_9', created: true }),
    };
    render(
      <TillClientProvider client={new TillClient(fakeTransport(canned, asked))}>
        <I18nProvider>
          <WorkspaceProvider initialId="ws_test">
            <MemoryRouter>
              <Deals />
            </MemoryRouter>
          </WorkspaceProvider>
        </I18nProvider>
      </TillClientProvider>,
    );
    await screen.findByText('Website-Relaunch');
    await userEvent.click(screen.getByRole('button', { name: /Website-Relaunch/ }));
    // The drawer shows the txn amount AND the frozen base beside it (§H-FX, both formatted).
    expect(await screen.findByText(/930\.00/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: de.deals.action.to_quote }));
    await waitFor(() => {
      expect(asked.some((a) => a.action === 'deals_to_quote' && a.input.dealId === 'deal_1')).toBe(true);
    });
  });

  it('surfaces the engine refusal through the catalogue (lost_reason_required as an example)', async () => {
    const canned = { ...baseCanned(), deals_to_quote: reject('needs_quotes_module') };
    renderDeals(canned);
    await screen.findByText('Website-Relaunch');
    await userEvent.click(screen.getByRole('button', { name: /Website-Relaunch/ }));
    await userEvent.click(await screen.findByRole('button', { name: de.deals.action.to_quote }));
    expect(await screen.findByText(de.deals.error.needs_quotes_module)).toBeInTheDocument();
  });
});
