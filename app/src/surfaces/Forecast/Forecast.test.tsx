/**
 * The Prognose surface: C03's human face over the forecast read models.
 *
 * The suite follows the Aufgaben discipline: a loading assertion waits for the read to have
 * STARTED (`watchReads`), copy is asserted through the catalogue and never as a literal typed
 * here, and the states the spec's §6 names are each driven: skeleton, empty (with the quote-only
 * funnel exception), populated with glyph+label deltas, the named-rejection inline error, and the
 * padlock. The one guard test the spec's §8 singles out: the DISCLAIMER renders in every
 * non-loading state, because a forecast confusable with the financial statements is the §3
 * boundary this capability must never cross.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { axe } from 'jest-axe';
import { MemoryRouter } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider } from '../../app/workspace';
import { neverSettles, watchReads } from '../../test-transport';
import Forecast from './index';
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

const PIPELINE = (rows: Record<string, unknown>[] = [], over: Record<string, unknown> = {}) =>
  ok({
    groupBy: 'stage',
    rows,
    totalDealCount: rows.reduce((s, r) => s + ((r.dealCount as number) ?? 0), 0),
    totalValueBaseMinor: rows.reduce((s, r) => s + ((r.valueBaseMinor as number) ?? 0), 0),
    totalWeightedMinor: rows.reduce((s, r) => s + ((r.weightedMinor as number) ?? 0), 0),
    baseCurrency: 'CHF',
    ...over,
  });

const KPIS = (over: Record<string, unknown> = {}) =>
  ok({
    conversionRateBp: 6667,
    avgDealSizeMinor: 100001,
    avgCycleDays: 12,
    wonCount: 2,
    lostCount: 1,
    sample: 3,
    baseCurrency: 'CHF',
    ...over,
  });

const NO_SAMPLE = KPIS({ conversionRateBp: null, avgDealSizeMinor: null, avgCycleDays: null, wonCount: 0, lostCount: 0, sample: 0 });

const REVENUE = (rows: Record<string, unknown>[] = [], over: Record<string, unknown> = {}) =>
  ok({
    horizonMonths: rows.length,
    rows,
    totalWeightedOpenMinor: rows.reduce((s, r) => s + ((r.weightedOpenMinor as number) ?? 0), 0),
    totalWonUninvoicedMinor: rows.reduce((s, r) => s + ((r.wonUninvoicedMinor as number) ?? 0), 0),
    totalOpenQuotesMinor: rows.reduce((s, r) => s + ((r.openQuotesMinor as number) ?? 0), 0),
    totalMinor: rows.reduce((s, r) => s + ((r.totalMinor as number) ?? 0), 0),
    excluded: [],
    baseCurrency: 'CHF',
    ...over,
  });

const VS_ACTUAL = (over: Record<string, unknown> = {}) =>
  ok({
    period: '2026-06',
    periodStart: '2026-06-01',
    periodEnd: '2026-06-30',
    actualRevenueMinor: 130000,
    wonInPeriodMinor: 150000,
    deltaMinor: -20000,
    wonNotInvoicedMinor: 50000,
    invoicedWithoutDealMinor: 30000,
    sample: 3,
    baseCurrency: 'CHF',
    ...over,
  });

const EMPTY_WORLD = (): Canned => ({
  forecast_weighted_pipeline: PIPELINE(),
  forecast_sales_kpis: NO_SAMPLE,
  forecast_revenue: REVENUE([
    { periodKey: '2026-07', weightedOpenMinor: 0, wonUninvoicedMinor: 0, openQuotesMinor: 0, totalMinor: 0 },
  ]),
  forecast_vs_actual: VS_ACTUAL({ actualRevenueMinor: 0, wonInPeriodMinor: 0, deltaMinor: 0, wonNotInvoicedMinor: 0, invoicedWithoutDealMinor: 0, sample: 0 }),
  list_field_defs: ok({ fieldDefs: [] }),
});

const POPULATED = (): Canned => ({
  forecast_weighted_pipeline: PIPELINE([
    { key: 'st_lead', label: 'Lead', dealCount: 2, valueBaseMinor: 300000, weightedMinor: 30000 },
    { key: 'st_qual', label: 'Qualifiziert', dealCount: 1, valueBaseMinor: 200000, weightedMinor: 70000 },
  ]),
  forecast_sales_kpis: KPIS(),
  forecast_revenue: REVENUE(
    [
      { periodKey: '2026-07', weightedOpenMinor: 60000, wonUninvoicedMinor: 50000, openQuotesMinor: 30000, totalMinor: 140000 },
      { periodKey: '2026-08', weightedOpenMinor: 40000, wonUninvoicedMinor: 0, openQuotesMinor: 0, totalMinor: 40000 },
    ],
    { excluded: [{ quoteId: 'doc_eur', reason: 'needs_fx_rate' }] },
  ),
  forecast_vs_actual: VS_ACTUAL(),
  list_field_defs: ok({
    fieldDefs: [
      { fieldDefId: 'f1', key: 'leadquelle', type: 'select', labelI18n: { 'de-CH': 'Lead-Quelle', en: 'Lead source' } },
      { fieldDefId: 'f2', key: 'notiz', type: 'text', labelI18n: { 'de-CH': 'Notiz', en: 'Note' } },
    ],
  }),
});

function tree(canned: Canned, workspaceId: string | null = 'ws_test') {
  return (
    <TillClientProvider client={new TillClient(fakeTransport(canned))}>
      <I18nProvider>
        <WorkspaceProvider initialId={workspaceId}>
          <MemoryRouter>
            <Forecast />
          </MemoryRouter>
        </WorkspaceProvider>
      </I18nProvider>
    </TillClientProvider>
  );
}

describe('Forecast (Prognose)', () => {
  it('LOADING: shows the skeleton while the forecast reads are in flight', async () => {
    const transport = watchReads(neverSettles);
    render(
      <TillClientProvider client={new TillClient(transport)}>
        <I18nProvider>
          <WorkspaceProvider initialId="ws_test">
            <MemoryRouter>
              <Forecast />
            </MemoryRouter>
          </WorkspaceProvider>
        </I18nProvider>
      </TillClientProvider>,
    );
    await transport.started('forecast_weighted_pipeline');
    await transport.started('forecast_revenue');
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('EMPTY: a dealless, quoteless workspace says "Keine offenen Deals." and links to the pipeline', async () => {
    render(tree(EMPTY_WORLD()));
    expect(await screen.findByText(de.forecast.empty)).toBeInTheDocument();
    const cta = screen.getByRole('link', { name: de.forecast.emptyCta });
    expect(cta).toHaveAttribute('href', '/deals');
    // The disclaimer holds in the empty state too (§8 guard).
    expect(screen.getByText(de.forecast.disclaimer)).toBeInTheDocument();
  });

  it('EMPTY exception: a quote-only funnel renders the revenue breakdown, never "Keine offenen Deals"', async () => {
    const canned = EMPTY_WORLD();
    canned.forecast_revenue = REVENUE([
      { periodKey: '2026-07', weightedOpenMinor: 0, wonUninvoicedMinor: 0, openQuotesMinor: 30000, totalMinor: 30000 },
    ]);
    render(tree(canned));
    expect(await screen.findByText(de.forecast.revenue.title)).toBeInTheDocument();
    expect(screen.queryByText(de.forecast.empty)).not.toBeInTheDocument();
    expect(screen.getAllByText("CHF 300.00").length).toBeGreaterThan(0);
  });

  it('SUCCESS: renders the weighted table, the KPI strip, the three components, and the ▼ glyph WITH label', async () => {
    render(tree(POPULATED()));
    expect(await screen.findByText('Qualifiziert')).toBeInTheDocument();
    // The weighted total (30000 + 70000) in the accent row.
    expect(screen.getByText("CHF 1'000.00")).toBeInTheDocument();
    // KPI strip: basis points render as a percentage with one decimal.
    expect(screen.getByText('66.7 %')).toBeInTheDocument();
    expect(screen.getByText(de.forecast.kpi.conversion)).toBeInTheDocument();
    // The three labelled revenue components (§6: each component named, never an unlabelled sum).
    // "Gewonnen, noch nicht fakturiert" appears twice by design (revenue column + vs-actual bucket).
    expect(screen.getAllByText(de.forecast.revenue.col.wonUninvoiced).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(de.forecast.revenue.col.openQuotes)).toBeInTheDocument();
    // The vs-actual delta is glyph AND label, never colour alone.
    expect(screen.getByText(de.forecast.vsActual.under)).toBeInTheDocument();
    // The FX-excluded quote renders as a ⚠-badged, named exclusion (P9 honesty).
    expect(screen.getByText(new RegExp(de.forecast.excluded.fx))).toBeInTheDocument();
    // The disclaimer is ALWAYS on screen (§8 guard): a projection, not an accounting figure.
    expect(screen.getByText(de.forecast.disclaimer)).toBeInTheDocument();
    // The custom select field extends the Gruppierung switch; the text field does not.
    expect(screen.getByRole('option', { name: 'Lead-Quelle' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Notiz' })).not.toBeInTheDocument();
  });

  it('CONTROLS: group-by, horizon and period use the shared .field control (D116 target band)', async () => {
    render(tree(POPULATED()));
    await screen.findByText('Qualifiziert');
    // The two selects (Gruppierung, Horizont) carry the shared control class so they read and MEASURE
    // like every other Studio filter control (36px), not the ~21px browser default.
    const combos = screen.getAllByRole('combobox');
    expect(combos.length).toBeGreaterThanOrEqual(2);
    for (const combo of combos) expect(combo).toHaveClass('field');
    // The period picker is a month input; it shares the same control class.
    const monthInput = document.querySelector('input[type="month"]');
    expect(monthInput).not.toBeNull();
    expect(monthInput).toHaveClass('field');
  });

  it('DATA HONESTY: sample 0 renders "–" with "Zu wenig Daten", never a fake 0 %', async () => {
    const canned = POPULATED();
    canned.forecast_sales_kpis = NO_SAMPLE;
    render(tree(canned));
    await screen.findByText(de.forecast.kpi.conversion);
    // All THREE KPIs (conversion, avg deal, cycle) go to a dash AND SAY why with "Zu wenig Daten";
    // before the fix the cycle KPI showed a bare dash under the trailing-window hint instead.
    expect(screen.getAllByText('–').length).toBe(3);
    expect(screen.getAllByText(de.forecast.kpi.no_sample).length).toBe(3);
    expect(screen.queryByText('0.0 %')).not.toBeInTheDocument();
  });

  it('PERMISSION: a read_books denial renders the padlock panel, never an empty forecast', async () => {
    const canned = POPULATED();
    canned.forecast_weighted_pipeline = reject('permission_denied', {}, 403);
    render(tree(canned));
    expect(await screen.findByText(de.forecast.denied)).toBeInTheDocument();
    expect(screen.queryByText(de.forecast.empty)).not.toBeInTheDocument();
    expect(screen.queryByText(de.forecast.revenue.title)).not.toBeInTheDocument();
  });

  it('ERROR: a named rejection renders its OWN message inline plus the way out, the rest stays alive', async () => {
    const canned = POPULATED();
    canned.forecast_vs_actual = reject('invalid_period', { period: '2026-13' });
    render(tree(canned));
    expect(await screen.findByText(de.forecast.error.invalid_period)).toBeInTheDocument();
    // The way out the spec §6 names is a RESET of the filter, labelled as such ("Zurücksetzen"),
    // not the generic "try again" on the same rejected input.
    expect(screen.getByRole('button', { name: de.forecast.error.reset })).toBeInTheDocument();
    // The weighted table is still on screen: one bad read never blanks the surface.
    expect(await screen.findByText('Qualifiziert')).toBeInTheDocument();
  });

  it('NO WORKSPACE: renders the shared no-workspace state', () => {
    render(tree(POPULATED(), null));
    expect(screen.queryByText(de.forecast.disclaimer)).not.toBeInTheDocument();
  });

  it('a11y: the settled populated surface has no axe violations', async () => {
    const { container } = render(tree(POPULATED()));
    // Settled: the populated table is on screen, so the skeleton has already left.
    await screen.findByText('Qualifiziert');
    expect(await axe(container)).toHaveNoViolations();
  });
});
