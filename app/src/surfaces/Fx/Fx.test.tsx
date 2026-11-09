/**
 * A22's surface suite. Every payload below is the exact shape the engine's `ok(...)` sends (read off
 * `src/core/fx/rates.ts` and `src/core/fx/revaluation.ts`): the rates list, the revaluation read
 * model, and the post result. The assertions read VALUES off the screen (the franc figure, the
 * closing rate, the reversal date, the actual German sentence a refusal shows), not just that a cell
 * rendered, because a test that asserts "a money figure rendered" passes over the wrong money.
 *
 * The default render lands on the ALLOW_ALL capabilities (no provider), which is the pre-A24
 * behaviour: both writes enabled. The permission-denied case injects a `can: () => false` context to
 * prove the padlock, exactly as the surface will behave once A24 seats a read-only role.
 */
import { afterEach, describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { axe } from 'jest-axe';

import { I18nProvider } from '../../i18n';
import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type Transport, type RestResponse } from '../../lib/client';
import { watchReads, neverSettles } from '../../test-transport';
import { WorkspaceProvider } from '../../app/workspace';
import { CapabilitiesContext, type Capabilities } from '../../lib/capabilities';
import { Fx } from './Fx';

type Body = RestResponse['body'];
const at = (payload: unknown, status = 200): RestResponse => ({ status, body: payload as Body });

const PROFILE = at({ ok: true, baseCurrency: 'CHF' });

const RATES = at({
  ok: true,
  rates: [
    {
      id: 'rate_1',
      baseCurrency: 'EUR',
      quoteCurrency: 'CHF',
      rate: '0.9520',
      asOf: '2026-06-30',
      source: 'manual',
      method: null,
      provenance: null,
    },
  ],
});

// A EUR bank position of EUR 10'000 booked at 0.9600 (CHF 9'600), revalued at 0.9520 (CHF 9'520):
// an unrealised LOSS of CHF 80, exactly the spec's worked US-A22.2 example.
const REVAL = at({
  ok: true,
  periodEnd: '2026-06-30',
  baseCurrency: 'CHF',
  positions: [
    {
      kind: 'bank',
      accountId: 'acc_1020',
      accountNumber: '1020',
      currency: 'EUR',
      fcAmountMinor: 1000000,
      bookChfMinor: 960000,
      rate: '0.9520',
      rateAsOf: '2026-06-30',
      revaluedChfMinor: 952000,
      diffChfMinor: -8000,
    },
  ],
  byCurrency: [
    { currency: 'EUR', fcAmountMinor: 1000000, bookChfMinor: 960000, revaluedChfMinor: 952000, diffChfMinor: -8000 },
  ],
  totalUnrealisedMinor: -8000,
  needsRate: [],
});

const REVAL_NEEDS_RATE = at({
  ok: true,
  periodEnd: '2026-06-30',
  baseCurrency: 'CHF',
  positions: [],
  byCurrency: [],
  totalUnrealisedMinor: 0,
  needsRate: [{ currency: 'USD', latestAsOf: '2026-05-31' }],
});

const REVAL_EMPTY = at({
  ok: true,
  periodEnd: '2026-06-30',
  baseCurrency: 'CHF',
  positions: [],
  byCurrency: [],
  totalUnrealisedMinor: 0,
  needsRate: [],
});

const POSTED = at({
  ok: true,
  runId: 'fxreval_1',
  periodEnd: '2026-06-30',
  posted: true,
  entryId: 'entry_1',
  reversalId: 'entry_2',
  totalUnrealisedMinor: -8000,
  reversalDate: '2026-07-01',
});

function routes(overrides: Record<string, RestResponse> = {}): Record<string, RestResponse> {
  return {
    list_exchange_rates: RATES,
    get_company_profile: PROFILE,
    fx_revaluation: REVAL,
    post_fx_revaluation: POSTED,
    record_exchange_rate: at({ ok: true, rateId: 'rate_2', rate: '0.9400', asOf: '2026-07-31', source: 'manual', method: null, created: true }),
    ...overrides,
  };
}

function transportFor(table: Record<string, RestResponse>): Transport {
  return async (action) => table[action] ?? at({ ok: false, error: 'unknown_action' }, 404);
}

const DENY_POST: Capabilities = {
  whoami: null,
  can: (cap: string) => cap !== 'post',
  refresh: () => undefined,
};

function renderSurface(
  transport: Transport,
  opts: { workspaceId?: string | null; capabilities?: Capabilities } = {},
) {
  const { workspaceId = 'ws_1', capabilities } = opts;
  const tree = (
    <TillClientProvider client={new TillClient(transport)}>
      <I18nProvider>
        <WorkspaceProvider initialId={workspaceId}>
          <MemoryRouter initialEntries={['/fx']}>
            <Fx />
          </MemoryRouter>
        </WorkspaceProvider>
      </I18nProvider>
    </TillClientProvider>
  );
  return render(
    capabilities === undefined ? tree : <CapabilitiesContext.Provider value={capabilities}>{tree}</CapabilitiesContext.Provider>,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Fx surface: the loading state', () => {
  it('shows a skeleton that traces the table while the rate read is in flight', async () => {
    // watchReads proves the rate read really went in flight before we claim the skeleton is a load
    // in progress, not the default-true skeleton every surface shows at its first commit
    // (loading-state-convention.test.ts).
    const transport = watchReads(neverSettles);
    const { container } = renderSurface(transport);
    await transport.started('list_exchange_rates');
    const skeleton = container.querySelector('[aria-busy="true"]');
    expect(skeleton).toBeInTheDocument();
    expect(skeleton).toHaveAttribute('role', 'status');
  });
});

describe('Fx surface: the rate register', () => {
  it('renders the recorded rate with its pair, value and date', async () => {
    renderSurface(transportFor(routes()));
    const cell = await screen.findByText('0.9520');
    expect(cell).toBeInTheDocument();
    expect(screen.getByText('EUR')).toBeInTheDocument();
    expect(screen.getByText(/30\.06\.2026/)).toBeInTheDocument();
  });

  it('names the first action when there is no rate yet', async () => {
    renderSurface(transportFor(routes({ list_exchange_rates: at({ ok: true, rates: [] }) })));
    expect(await screen.findByText('Noch keine Wechselkurse')).toBeInTheDocument();
  });

  it('adds a rate through record_exchange_rate and reloads the list', async () => {
    const calls: { action: string; input: Record<string, unknown> }[] = [];
    const table = routes();
    const transport: Transport = async (action, input) => {
      calls.push({ action, input });
      return table[action] ?? at({ ok: false, error: 'unknown_action' }, 404);
    };
    renderSurface(transport);
    await screen.findByText('0.9520');

    await userEvent.type(screen.getByLabelText('Währung'), 'usd');
    await userEvent.type(screen.getByLabelText('Kurs'), '0.8600');
    await userEvent.click(screen.getByRole('button', { name: 'Kurs erfassen' }));

    await waitFor(() => {
      const record = calls.find((c) => c.action === 'record_exchange_rate');
      expect(record).toBeDefined();
      // The currency is upcased to the ISO code the engine expects, and an idempotency key travels.
      expect(record?.input.baseCurrency).toBe('USD');
      expect(record?.input.rate).toBe('0.8600');
      expect(typeof record?.input.idempotencyKey).toBe('string');
    });
  });
});

describe('Fx surface: the period-end revaluation', () => {
  it('computes and shows the unrealised loss to the Rappen with a total', async () => {
    renderSurface(transportFor(routes()));
    await screen.findByText('0.9520');
    await userEvent.click(screen.getByRole('button', { name: 'Berechnen' }));

    // The position row: the account, the closing rate, and the CHF -80.00 loss.
    expect(await screen.findByText('1020')).toBeInTheDocument();
    const losses = screen.getAllByText('CHF -80.00');
    // Once on the position row, once on the total row.
    expect(losses.length).toBe(2);
    // The loss is announced by a labelled glyph, never colour alone.
    expect(screen.getAllByLabelText('Unrealisierter Verlust').length).toBeGreaterThan(0);
    expect(screen.getByText('Total unrealisiert')).toBeInTheDocument();
  });

  it('offers the add-rate CTA when a currency has no closing rate', async () => {
    renderSurface(transportFor(routes({ fx_revaluation: REVAL_NEEDS_RATE })));
    await screen.findByText('0.9520');
    await userEvent.click(screen.getByRole('button', { name: 'Berechnen' }));
    expect(await screen.findByText('Ein Stichtagskurs fehlt')).toBeInTheDocument();
    expect(screen.getByText(/USD hat eine offene Position/)).toBeInTheDocument();
  });

  it('says there is nothing to revalue when no open FC position exists', async () => {
    renderSurface(transportFor(routes({ fx_revaluation: REVAL_EMPTY })));
    await screen.findByText('0.9520');
    await userEvent.click(screen.getByRole('button', { name: 'Berechnen' }));
    expect(await screen.findByText('Nichts neu zu bewerten')).toBeInTheDocument();
  });

  it('posts the revaluation and confirms the next-period reversal date', async () => {
    const calls: { action: string; input: Record<string, unknown> }[] = [];
    const table = routes();
    const transport: Transport = async (action, input) => {
      calls.push({ action, input });
      return table[action] ?? at({ ok: false, error: 'unknown_action' }, 404);
    };
    renderSurface(transport);
    await screen.findByText('0.9520');
    await userEvent.click(screen.getByRole('button', { name: 'Berechnen' }));
    await screen.findByText('1020');
    await userEvent.click(screen.getByRole('button', { name: 'Neubewertung buchen' }));

    expect(await screen.findByText('Gebucht. Storniert am 01.07.2026.')).toBeInTheDocument();
    const post = calls.find((c) => c.action === 'post_fx_revaluation');
    expect(typeof post?.input.periodEnd).toBe('string');
    expect(String(post?.input.periodEnd)).toHaveLength(10);
    expect(typeof post?.input.idempotencyKey).toBe('string');
  });

  it('names an already_posted rejection instead of a stack trace', async () => {
    renderSurface(
      transportFor(routes({ post_fx_revaluation: at({ ok: false, error: 'already_posted', periodEnd: '2026-06-30', runId: 'fxreval_1', postedAt: '2026-07-02T09:00:00.000Z' }, 422) })),
    );
    await screen.findByText('0.9520');
    await userEvent.click(screen.getByRole('button', { name: 'Berechnen' }));
    await screen.findByText('1020');
    await userEvent.click(screen.getByRole('button', { name: 'Neubewertung buchen' }));
    expect(await screen.findByText('Bereits neu bewertet')).toBeInTheDocument();
  });

  it('routes a period_locked rejection to the periods surface', async () => {
    renderSurface(
      transportFor(routes({ post_fx_revaluation: at({ ok: false, error: 'period_locked' }, 422) })),
    );
    await screen.findByText('0.9520');
    await userEvent.click(screen.getByRole('button', { name: 'Berechnen' }));
    await screen.findByText('1020');
    await userEvent.click(screen.getByRole('button', { name: 'Neubewertung buchen' }));
    const cta = await screen.findByRole('link', { name: 'Perioden öffnen' });
    expect(cta).toHaveAttribute('href', '/periods');
  });
});

describe('Fx surface: the A24 padlock', () => {
  it('hides the add-rate form and disables Post when the actor lacks post', async () => {
    renderSurface(transportFor(routes()), { capabilities: DENY_POST });
    await screen.findByText('0.9520');
    // The add-rate form is replaced by the locked note.
    expect(screen.queryByRole('button', { name: 'Kurs erfassen' })).toBeNull();
    expect(screen.getByText('Zum Erfassen eines Kurses braucht es die Buchhalter-Rolle.')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Berechnen' }));
    await screen.findByText('1020');
    const post = screen.getByRole('button', { name: /Neubewertung buchen/ });
    expect(post).toBeDisabled();
  });
});

describe('Fx surface: accessibility', () => {
  it('has no axe violations once the rate register has rendered', async () => {
    const { container } = renderSurface(transportFor(routes()));
    await screen.findByText('0.9520');
    expect(await axe(container)).toHaveNoViolations();
  });
});
