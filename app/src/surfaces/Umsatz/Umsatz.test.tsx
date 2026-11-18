/**
 * A42 and D203, Umsatz: the two tabs, the KPI tiles from the books with their comparison and derivation, the review
 * rows and the checks, ignore and include with no reason asked, a test payment included through not_test, the book
 * bar only with something to book (the same range and digest), the calm start without a source, the Regeln tab
 * (template, settings without a reason, the payout bank rules), the states and axe.
 * Synthetic data only (invented platform, payers, ids and amounts).
 */
import { describe, it, expect } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { axe } from 'jest-axe';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type Transport, type RestResponse } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { CapabilitiesContext, ALLOW_ALL, type Capabilities } from '../../lib/capabilities';
import { recordedOk } from '../../lib/test-support';
import { WorkspaceProvider } from '../../app/workspace';
import { UmsatzPage, shiftPeriod, reviewedPart, periodOptions, toBookOf, type Review, type ReviewRow, type Derivation } from './Umsatz';
import { compareLine, type TurnoverSummary } from './Figures';
import { payoutRulesOf, sourcesOf } from './Rules';
import listAccountsFixture from '../Accounts/list-accounts.fixture.json';

/** A book's own clearing account (Durchlaufkonto): not part of the shipped chart, created per workspace. */
const BOOK_OWN_CLEARING = { number: '1095', id: 'acc_1095', name: 'Durchlaufkonto', type: 'asset' };

const row = (eventId: string, extra: Partial<ReviewRow> = {}): ReviewRow => ({
  eventId,
  kind: 'sale',
  day: '2026-07-14',
  outsidePeriod: false,
  amountMinor: 5405,
  netMinor: 5000,
  vatMinor: 405,
  counterparty: { email: 'lena.beispiel@kurswerk.example', name: 'Lena Beispiel', masked: false, document: 'KW-R-2001', chargeId: 'ch_inv_2001' },
  test: false,
  included: true,
  inclusion: { state: 'included', source: 'default', reason: null, actor: null, at: null },
  status: 'to_book',
  reason: null,
  code: null,
  sentence: null,
  entryId: null,
  vatPostedMinor: 405,
  toggleable: true,
  includeVia: 'inclusion',
  derivation: null,
  ...extra,
});

/** An invented derivation: net 50.00, platform fee 9.9 % = 4.95, processing fee 1.08, coach 43.97 = self-bill. */
const derivation = (extra: Partial<Derivation> = {}): Derivation => ({
  derivedFrom: 'kurswerk_transaction',
  sellerRole: 'deemed_supplier',
  vatRule: 'ch_standard_8_1',
  vatRatePercent: '8.1',
  platformFee: { bp: 990, amountMinor: 495, waived: false, waiverReason: null },
  processingFeeMinor: 108,
  processingFeeSource: 'fee_transaction',
  payoutNetMinor: 5000,
  coachPayoutExpectedMinor: 4397,
  selfBill: { number: 'KW-G-2001', amountMinor: 4397, hasVat: null },
  coachTransferMinor: 4397,
  coachPayoutAdjustmentMinor: 0,
  coachVatRegistered: false,
  ids: { bookingId: 'kw_bk_2001', sessionId: 'kw_ss_2001', liveSessionId: null, paymentIntentId: 'pi_inv_2001', chargeId: 'ch_inv_2001', transferId: 'tr_inv_2001', payoutId: 'po_inv_1' },
  stated: { ok: true, diffMinor: 0 },
  till: true,
  ok: true,
  refsTrimmed: false,
  ...extra,
});

const REVIEW: Review = {
  mode: 'feed',
  system: 'Kurswerk',
  processor: 'Zahlfix',
  period: { from: '2026-07-01', to: '2026-09-30', unit: 'quarter' },
  reviewSha256: 'a'.repeat(64),
  rows: [
    row('kw:sale:2001', { derivation: derivation() }),
    row('kw:sale:2101', {
      derivation: derivation({ platformFee: { bp: 0, amountMinor: 0, waived: true, waiverReason: 'new_coach_window' }, stated: { ok: null, diffMinor: null }, till: null, ok: null, coachTransferMinor: null, selfBill: { number: null, amountMinor: null, hasVat: null } }),
      test: true,
      included: false,
      inclusion: { state: 'ignored', source: 'test_default', reason: null, actor: null, at: null },
      status: 'skipped',
      reason: 'test_event',
      sentence: 'the event belongs to a test payment',
      vatPostedMinor: 0,
      includeVia: 'not_test',
      counterparty: { email: null, name: null, masked: false, document: null, chargeId: 'ch_inv_2101' },
    }),
    row('zf_po_1', { kind: 'bank_payout', amountMinor: -3297, netMinor: -3297, vatMinor: null, status: 'skipped', reason: 'template_skip', toggleable: false, vatPostedMinor: 0, counterparty: { email: null, name: null, masked: false, document: null, chargeId: null } }),
  ],
  toBook: 1,
  totals: {
    turnoverNetMinor: 5000,
    outputVat: { amountMinor: 405, formLines: ['303'] },
    inputVat: { amountMinor: 8, formLines: ['405'] },
    ignored: { events: 0, vatMinor: 0 },
    test: { events: 1, vatMinor: 162 },
    notBooked: { events: 0, vatMinor: 0 },
  },
  checks: {
    payouts: { state: 'ok', payouts: [{ eventId: 'zf_po_1', day: '2026-07-16', basis: 'refs', restMinor: 0, testRestMinor: 0, skippedRestMinor: 0, unexplainedMinor: null }] },
    vat: { state: 'differs', statedMinor: 567, bookedMinor: 405, differing: ['kw:sale:2201'] },
  },
  warnings: ['Eine Zahlung ohne Datensatz (erfunden).'],
};

/** An invented quarter from the books: turnover 1'250.00 against 1'000.00 the quarter before. */
const SUMMARY: TurnoverSummary = {
  period: { from: '2026-07-01', to: '2026-09-30' },
  vatMethod: 'effektiv',
  compare: { mode: 'previous_period', from: '2026-04-01', to: '2026-06-30' },
  totals: {
    turnoverNetMinor: 125000,
    settlementTurnoverMinor: 50000,
    outputVat: { amountMinor: 10125, formLines: ['303'] },
    feeInputVat: { amountMinor: 324, formLines: ['405'] },
    sales: { count: 5, netMinor: 130000, averageMinor: 26000 },
    reductionsMinor: -5000,
    payouts: { count: 2, amountMinor: 98000 },
    entries: 6,
  },
  previous: {
    turnoverNetMinor: 100000,
    settlementTurnoverMinor: 40000,
    outputVat: { amountMinor: 8100, formLines: ['303'] },
    feeInputVat: { amountMinor: 200, formLines: ['405'] },
    sales: { count: 4, netMinor: 100000, averageMinor: 25000 },
    reductionsMinor: 0,
    payouts: { count: 1, amountMinor: 50000 },
    entries: 4,
  },
  byMonth: [
    { month: '2026-07', turnoverNetMinor: 50000, bySource: { 'settlement:kurswerk:zahlfix': 50000 } },
    { month: '2026-08', turnoverNetMinor: 75000, bySource: { invoices: 75000 } },
    { month: '2026-09', turnoverNetMinor: 0, bySource: {} },
  ],
  bySource: [
    { key: 'settlement:kurswerk:zahlfix', kind: 'settlement', system: 'kurswerk', processor: 'zahlfix', turnoverNetMinor: 50000, salesCount: 3 },
    { key: 'invoices', kind: 'invoices', system: null, processor: null, turnoverNetMinor: 75000, salesCount: 2 },
  ],
  byCustomer: {
    top: [{ key: 'contact:c1', name: 'Atelier Erfunden GmbH', email: null, masked: false, turnoverNetMinor: 75000, salesCount: 2 }],
    rest: { customers: 2, turnoverNetMinor: 50000 },
  },
  accounts: { revenue: '3xxx', outputVat: ['2200'], inputVat: ['1170', '1171'], clearing: ['1095'] },
};

const PERIODS = {
  unit: 'quarter',
  periods: [
    { from: '2026-04-01', to: '2026-06-30', state: 'booked', booked: 4, waiting: 0, observed: 6 },
    { from: '2026-07-01', to: '2026-09-30', state: 'to_book', booked: 2, waiting: 1, observed: 4 },
  ],
};

type Route = RestResponse | ((input: Record<string, unknown>) => RestResponse);
const okBody = (body: Record<string, unknown>): RestResponse => ({ status: 200, body: recordedOk({ ok: true, ...body }) });

function renderPage(routes: Record<string, Route>, caps: Capabilities = ALLOW_ALL) {
  const calls: { action: string; input: Record<string, unknown> }[] = [];
  const all: Record<string, Route> = { turnover_summary: okBody(SUMMARY as unknown as Record<string, unknown>), settlement_periods: okBody(PERIODS), ...routes };
  const transport: Transport = async (action, input) => {
    calls.push({ action, input });
    const route = all[action];
    if (route === undefined) return { status: 404, body: { ok: false, error: 'unknown_action' } };
    return typeof route === 'function' ? route(input) : route;
  };
  const view = render(
    <MemoryRouter>
      <TillClientProvider client={new TillClient(transport)}>
        <I18nProvider initialLocale="de-CH">
          <WorkspaceProvider initialId="ws_test">
            <CapabilitiesContext.Provider value={caps}>
              <UmsatzPage workspaceId="ws_test" />
            </CapabilitiesContext.Provider>
          </WorkspaceProvider>
        </I18nProvider>
      </TillClientProvider>
    </MemoryRouter>,
  );
  return { calls, container: view.container };
}

const reviewRoute = (review: Review = REVIEW): Route => okBody(review as unknown as Record<string, unknown>);

describe('Umsatz (A42)', () => {
  it('shows each event with who paid, its amount and VAT, the band of figures and both checks with their words on hover', async () => {
    renderPage({ settlement_review: reviewRoute() });
    expect(await screen.findByText('lena.beispiel@kurswerk.example')).toBeInTheDocument();
    expect(screen.getByText('Lena Beispiel')).toBeInTheDocument();
    expect(screen.getByText('ch_inv_2101')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Zahlen' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Regeln' })).toBeInTheDocument();
    expect(screen.getByLabelText('Jede Auszahlung ist durch die gebuchten Ereignisse erklärt')).toBeInTheDocument();
    expect(screen.getByLabelText('1 einbezogene Ereignisse tragen eine andere MWST als das Buch')).toBeInTheDocument();
    expect(screen.getByLabelText('Testzahlung')).toBeInTheDocument();
    const testRow = document.querySelector('[data-event="kw:sale:2101"]') as HTMLElement;
    expect(testRow.className).toContain('umsatz-row--ignored');
    const payoutRow = document.querySelector('[data-event="zf_po_1"]') as HTMLElement;
    expect(within(payoutRow).queryByRole('button')).toBeNull();
  });

  it('ignores an event at once, asking no reason, and reads the review again (D203 point 5)', async () => {
    const user = userEvent.setup();
    const { calls } = renderPage({ settlement_review: reviewRoute(), set_settlement_event_ignored: okBody({ inclusionId: 'stlinc_1', state: 'ignored' }) });
    const saleRow = (await screen.findByText('lena.beispiel@kurswerk.example')).closest('tr') as HTMLElement;
    await user.click(within(saleRow).getByRole('button', { name: 'Ignorieren' }));
    expect(screen.queryByRole('textbox')).toBeNull();
    await waitFor(() => expect(calls.some((c) => c.action === 'set_settlement_event_ignored')).toBe(true));
    const sent = calls.find((c) => c.action === 'set_settlement_event_ignored')!.input;
    expect(sent).toMatchObject({ system: 'Kurswerk', processor: 'Zahlfix', eventId: 'kw:sale:2001', ignored: true });
    expect(sent).not.toHaveProperty('reason');
    await waitFor(() => expect(calls.filter((c) => c.action === 'settlement_review').length).toBe(2));
  });

  it('includes a test payment through not_test at once, with no reason', async () => {
    const user = userEvent.setup();
    const { calls } = renderPage({ settlement_review: reviewRoute(), resolve_settlement_event: okBody({ resolutionId: 'stlres_1' }) });
    const testRow = (await screen.findByText('ch_inv_2101')).closest('tr') as HTMLElement;
    await user.click(within(testRow).getByRole('button', { name: 'Einbeziehen' }));
    await waitFor(() => expect(calls.some((c) => c.action === 'resolve_settlement_event')).toBe(true));
    const sent = calls.find((c) => c.action === 'resolve_settlement_event')!.input;
    expect(sent).toMatchObject({ eventId: 'kw:sale:2101', resolution: 'not_test' });
    expect(sent).not.toHaveProperty('reason');
  });

  it('Buchen pulls the same range with the review digest, and says how many were booked', async () => {
    const user = userEvent.setup();
    const { calls } = renderPage({ settlement_review: reviewRoute(), pull_settlement: okBody({ import: { booked: 1 } }) });
    await screen.findByText('lena.beispiel@kurswerk.example');
    const bar = screen.getByRole('region', { name: 'Buchen' });
    expect(within(bar).getByText(/1 Ereignisse: .*50\.00 Umsatz, .*4\.05 MWST/)).toBeInTheDocument();
    await user.click(within(bar).getByRole('button', { name: 'Buchen' }));
    expect(await screen.findByText('1 gebucht')).toBeInTheDocument();
    expect(calls.find((c) => c.action === 'pull_settlement')!.input).toMatchObject({ from: '2026-07-01', to: '2026-09-30', expectReviewSha256: 'a'.repeat(64) });
  });

  it('the book bar counts, sums and names the same rows Buchen books, an event outside the period included (critic r1 F2)', async () => {
    const outside = row('kw:sale:3001', { day: '2026-10-02', outsidePeriod: true, amountMinor: 10810, netMinor: 10000, vatMinor: 810 });
    const review: Review = { ...REVIEW, rows: [...REVIEW.rows, outside], toBook: 2 };
    expect(toBookOf(review)).toEqual({ count: 2, netMinor: 15000, vatMinor: 1215, outside: 1 });
    renderPage({ settlement_review: reviewRoute(review) });
    await screen.findAllByText('lena.beispiel@kurswerk.example');
    const bar = screen.getByRole('region', { name: 'Buchen' });
    expect(within(bar).getByText(/2 Ereignisse: .*150\.00 Umsatz, .*12\.15 MWST/)).toBeInTheDocument();
    expect(within(bar).getByText('davon 1 ausserhalb')).toBeInTheDocument();
    expect(within(bar).getByLabelText(/^davon 1 ausserhalb: Ausserhalb dieser Periode/)).toBeInTheDocument();
  });

  it('the VAT tile says what it is, the VAT on these sales less the input VAT on their fees (critic r1 L5)', async () => {
    const user = userEvent.setup();
    renderPage({ settlement_review: reviewRoute() });
    const kpis = await screen.findByRole('list', { name: 'Kennzahlen' });
    await user.hover(within(kpis).getByText('MWST aus Abrechnungen'));
    expect(await screen.findByText(/MWST auf diesen Verkäufen abzüglich der Vorsteuer auf ihren Gebühren/)).toBeInTheDocument();
    expect(screen.queryByText(/zieht die MWST-Abrechnung ab/)).toBeNull();
  });

  it('with nothing to book there is no Buchen at all, never a button that looks enabled and does nothing (D203 point 4)', async () => {
    renderPage({ settlement_review: reviewRoute({ ...REVIEW, toBook: 0 }) });
    await screen.findByText('lena.beispiel@kurswerk.example');
    expect(screen.queryByRole('button', { name: 'Buchen' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Buchen' })).toBeNull();
  });

  it('no source is a calm start: two ways in, no red, the figures from the books still there (D203 point 3)', async () => {
    const none: Review = { ...REVIEW, mode: 'none', system: '', processor: '', rows: [], toBook: 0, reviewSha256: '' };
    const { calls } = renderPage({ settlement_review: reviewRoute(none) });
    expect(await screen.findByRole('button', { name: 'Datei laden' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Quelle verbinden' })).toHaveAttribute('href', '/bank-accounts');
    expect(screen.queryByText('Laden fehlgeschlagen')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Erneut versuchen' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Buchen' })).toBeNull();
    await waitFor(() => expect(calls.some((c) => c.action === 'turnover_summary')).toBe(true));
    expect(await screen.findByText(/1.?250\.00/)).toBeInTheDocument();
    expect(calls.find((c) => c.action === 'turnover_summary')!.input).toMatchObject({ from: '2026-07-01', to: '2026-09-30', compare: 'previous_period' });
  });

  it('a configuration refusal (a missing token) is a calm line with the way there and keeps the figures; a transient one offers a retry', async () => {
    renderPage({ settlement_review: { status: 422, body: { ok: false, error: 'token_missing' } } });
    expect(await screen.findByText(/Der Token dieser Quelle fehlt/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Quelle verbinden' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Erneut versuchen' })).toBeNull();
    expect(await screen.findByText(/1.?250\.00/)).toBeInTheDocument();
  });

  it('a transient refusal of the review (the feed unreachable) offers a retry', async () => {
    renderPage({ settlement_review: { status: 503, body: { ok: false, error: 'feed_unreachable' } } });
    expect(await screen.findByRole('button', { name: 'Erneut versuchen' })).toBeInTheDocument();
  });

  it('shows the padlock without the right to post', () => {
    renderPage({ settlement_review: reviewRoute() }, { ...ALLOW_ALL, can: () => false } as Capabilities);
    expect(screen.getByText('Abrechnungsereignisse prüfen braucht das Recht zu buchen.')).toBeInTheDocument();
  });

  it('shows the empty period', async () => {
    renderPage({ settlement_review: reviewRoute({ ...REVIEW, rows: [], toBook: 0 }) });
    expect(await screen.findByText('Keine Abrechnungsereignisse in dieser Periode')).toBeInTheDocument();
  });

  it("books a file's reviewed period only: the events dated in the period, the rest of the file left for its own period", () => {
    const file = JSON.stringify({
      schema: 'till-settlement/v1',
      source: { system: 'Kurswerk', processor: 'Zahlfix' },
      events: [{ id: 'kw:sale:2001', day: '2026-07-14' }, { id: 'zf_po_1', day: '2026-09-30' }, { id: 'kw:sale:3001', day: '2026-10-01' }, { id: 'bad' }],
    });
    const part = reviewedPart(file, { from: '2026-07-01', to: '2026-09-30' }) as { events: { id: string }[]; schema: string };
    expect(part.schema).toBe('till-settlement/v1');
    expect(part.events.map((e) => e.id)).toEqual(['kw:sale:2001', 'zf_po_1']);
  });

  it('on review_stale it says so and reads the period again', async () => {
    const user = userEvent.setup();
    const { calls } = renderPage({ settlement_review: reviewRoute(), pull_settlement: { status: 422, body: { ok: false, error: 'review_stale' } } });
    await screen.findByText('lena.beispiel@kurswerk.example');
    await user.click(within(screen.getByRole('region', { name: 'Buchen' })).getByRole('button', { name: 'Buchen' }));
    expect(await screen.findByText(/Seit du geschaut hast, hat sich etwas geändert/)).toBeInTheDocument();
    await waitFor(() => expect(calls.filter((c) => c.action === 'settlement_review').length).toBe(2));
  });

  it('offers the periods around the one shown in the shared Select, the one shown among them', () => {
    const options = periodOptions({ from: '2026-07-01', to: '2026-09-30' }, 'quarter');
    expect(options).toHaveLength(13);
    expect(options[8]!.value).toBe('2026-07-01|2026-09-30');
    expect(options[7]!.value).toBe('2026-04-01|2026-06-30');
    expect(options[9]!.value).toBe('2026-10-01|2026-12-31');
    expect(options[0]!.value).toBe('2024-07-01|2024-09-30');
  });

  it('steps a period by its unit', () => {
    expect(shiftPeriod('2026-07-01', 'quarter', -1)).toEqual({ from: '2026-04-01', to: '2026-06-30' });
    expect(shiftPeriod('2026-12-01', 'month', 1)).toEqual({ from: '2027-01-01', to: '2027-01-31' });
    expect(shiftPeriod('2026-01-01', 'year', 1)).toEqual({ from: '2027-01-01', to: '2027-12-31' });
  });

  it('shows how each sale is derived: glyph chips with their figures on hover, a waived fee with its reason, the verdict', async () => {
    renderPage({ settlement_review: reviewRoute() });
    const saleRow = (await screen.findByText('lena.beispiel@kurswerk.example')).closest('tr') as HTMLElement;
    expect(within(saleRow).getByLabelText(/^Plattformgebühr 9\.9 %: .*4\.95$/)).toBeInTheDocument();
    expect(within(saleRow).getByLabelText(/^Zahlungsgebühr: .*1\.08$/)).toBeInTheDocument();
    expect(within(saleRow).getByLabelText(/^An den Coach: .*43\.97$/)).toBeInTheDocument();
    expect(within(saleRow).getByLabelText('MWST 8.1 %')).toBeInTheDocument();
    expect(within(saleRow).getByLabelText('Herleitung geht auf')).toBeInTheDocument();
    const testRow = document.querySelector('[data-event="kw:sale:2101"]') as HTMLElement;
    expect(within(testRow).getByLabelText('Plattformgebühr erlassen: Startfenster für neue Coaches')).toBeInTheDocument();
    expect(within(testRow).queryByLabelText(/Herleitung geht/)).toBeNull();
    const payoutRow = document.querySelector('[data-event="zf_po_1"]') as HTMLElement;
    expect(within(payoutRow).queryByLabelText(/Plattformgebühr/)).toBeNull();
  });

  it('a verdict that does not add up shows the cross', async () => {
    renderPage({ settlement_review: reviewRoute({ ...REVIEW, rows: [row('kw:sale:2001', { derivation: derivation({ till: false, ok: false }) })] }) });
    await screen.findByText('lena.beispiel@kurswerk.example');
    expect(screen.getByLabelText('Herleitung geht nicht auf')).toBeInTheDocument();
  });

  it('the info button opens every figure of the derivation in the drawer, and Escape closes it', async () => {
    const user = userEvent.setup();
    renderPage({ settlement_review: reviewRoute() });
    const saleRow = (await screen.findByText('lena.beispiel@kurswerk.example')).closest('tr') as HTMLElement;
    await user.click(within(saleRow).getByRole('button', { name: 'Herleitung' }));
    const drawer = await screen.findByRole('dialog');
    expect(within(drawer).getByText('Gutschrift des Coaches')).toBeInTheDocument();
    expect(within(drawer).getByText(/KW-G-2001/)).toBeInTheDocument();
    expect(within(drawer).getByText('kw_bk_2001')).toBeInTheDocument();
    expect(within(drawer).getByText('Prüfung von TILL')).toBeInTheDocument();
    expect(within(drawer).queryByText('Live-Sitzung')).toBeNull();
    expect(within(drawer).queryByText(/lena\.beispiel/)).toBeNull();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('a row without derivation refs shows no chip and no info button (an older feed or pack file)', async () => {
    renderPage({ settlement_review: reviewRoute({ ...REVIEW, rows: [row('kw:sale:2001')] }) });
    const saleRow = (await screen.findByText('lena.beispiel@kurswerk.example')).closest('tr') as HTMLElement;
    expect(within(saleRow).queryByRole('button', { name: 'Herleitung' })).toBeNull();
    expect(within(saleRow).queryByLabelText(/Plattformgebühr/)).toBeNull();
  });

  it('check (a): a payout gap shows its figure and, beside it, the producer\'s warnings; never ok', async () => {
    const gap: Review = {
      ...REVIEW,
      checks: {
        ...REVIEW.checks,
        payouts: { state: 'unknown', payouts: [{ eventId: 'zf_po_2', day: '2026-07-30', basis: 'partial', restMinor: null, testRestMinor: 0, skippedRestMinor: 0, unexplainedMinor: -726 }] },
      },
    };
    renderPage({ settlement_review: reviewRoute(gap) });
    await screen.findByText('lena.beispiel@kurswerk.example');
    expect(screen.getByLabelText(/^Nicht prüfbar.*Auszahlung vom 30\.07\.2026: .*7\.26 nicht durch ihre Ereignisse erklärt\. Eine Zahlung ohne Datensatz \(erfunden\)\.$/)).toBeInTheDocument();
    renderPage({ settlement_review: reviewRoute() });
    expect(await screen.findByLabelText('Jede Auszahlung ist durch die gebuchten Ereignisse erklärt')).toBeInTheDocument();
  });

  it('words what check (a) set apart (test payments, a reserve, the opening balance), never silently', async () => {
    const apart: Review = {
      ...REVIEW,
      checks: {
        ...REVIEW.checks,
        payouts: { state: 'ok', payouts: [{ eventId: 'zf_po_1', day: '2026-07-16', basis: 'refs', restMinor: 0, testRestMinor: 2162, skippedRestMinor: -500, openingRestMinor: 1081, unexplainedMinor: null }] },
      },
    };
    renderPage({ settlement_review: reviewRoute(apart) });
    await screen.findByText('lena.beispiel@kurswerk.example');
    const label = screen.getByLabelText(/^Jede Auszahlung ist durch die gebuchten Ereignisse erklärt\./).getAttribute('aria-label') ?? '';
    expect(label).toMatch(/21\.62 aus Testzahlungen/);
    expect(label).toMatch(/5\.00 bleiben auf dem Durchlaufkonto/);
    expect(label).toMatch(/10\.81 aus der Zeit vor dem Startdatum/);
  });

  it('shows an unreadable event as a refused row with its sentence on hover, without a toggle', async () => {
    renderPage({
      settlement_review: reviewRoute({
        ...REVIEW,
        rows: [
          row('kw:sale:2001'),
          row('kw:sale:2901', { status: 'refused', unreadable: true, code: 'duplicate_id', sentence: 'the id appears twice', toggleable: false, vatMinor: null, vatPostedMinor: 0, counterparty: { email: null, name: null, masked: false, document: null, chargeId: null } }),
        ],
      }),
    });
    await screen.findByText('lena.beispiel@kurswerk.example');
    const refusedRow = document.querySelector('[data-event="kw:sale:2901"]') as HTMLElement;
    expect(within(refusedRow).getByLabelText('the id appears twice')).toBeInTheDocument();
    expect(within(refusedRow).queryByRole('button')).toBeNull();
  });

  it('a booked row the producer restated or re-sent unreadable shows the warning glyph and its sentence', async () => {
    renderPage({
      settlement_review: reviewRoute({
        ...REVIEW,
        rows: [row('kw:sale:2001', { status: 'booked', code: 'event_amended', sentence: 'the producer restated a booked event', toggleable: false })],
      }),
    });
    await screen.findByText('lena.beispiel@kurswerk.example');
    expect(screen.getByLabelText('Gebucht; der Absender meldet es neu: the producer restated a booked event')).toBeInTheDocument();
  });

  it('the KPIs come first, from the books, each against the previous period, with its derivation and Ziffer on hover', async () => {
    const user = userEvent.setup();
    renderPage({ settlement_review: reviewRoute() });
    const kpis = await screen.findByRole('list', { name: 'Kennzahlen' });
    for (const label of ['Umsatz exkl. MWST', 'MWST aus Abrechnungen', 'Anzahl Verkäufe', 'Durchschnittlicher Verkauf', 'Auszahlungen', 'Zu buchen']) {
      expect(within(kpis).getByText(label)).toBeInTheDocument();
    }
    expect(await within(kpis).findByText(/1.?250\.00/)).toBeInTheDocument();
    // Turnover, VAT and the sales count each rose 25 %.
    expect(within(kpis).getAllByText(/\+25 % gegenüber Vorperiode/)).toHaveLength(3);
    await user.hover(within(kpis).getByText('Umsatz exkl. MWST'));
    expect(await screen.findByText(/Ziffer 200, steuerbar Ziffer 299/)).toBeInTheDocument();
    await user.hover(within(kpis).getByText('MWST aus Abrechnungen'));
    expect(await screen.findByText(/Ziffer 303\./)).toBeInTheDocument();
    // The order is KPIs, then the breakdowns, then the events (pick A).
    const order = [...document.querySelectorAll('.umsatz-kpis, .umsatz-breakdowns, .umsatz-events')].map((n) => n.className.split(' ')[0]);
    expect(order).toEqual(['umsatz-kpis', 'umsatz-breakdowns', 'umsatz-events']);
    expect(screen.getByRole('list', { name: 'Nach Monat' })).toBeInTheDocument();
    expect(screen.getByText('kurswerk · zahlfix')).toBeInTheDocument();
    expect(screen.getByText('Rechnungen')).toBeInTheDocument();
    expect(screen.getByText('Atelier Erfunden GmbH')).toBeInTheDocument();
    expect(screen.getByText('2 weitere')).toBeInTheDocument();
  });

  it('the Umsatz tile names its settlement share; a Saldo book shows the VAT billed and no fee input VAT (re-cut d, e)', async () => {
    const user = userEvent.setup();
    renderPage({ settlement_review: reviewRoute() });
    const kpis = await screen.findByRole('list', { name: 'Kennzahlen' });
    expect(await within(kpis).findByText(/davon .*500\.00 aus Abrechnungen/)).toBeInTheDocument();
    expect(within(kpis).getByText('MWST aus Abrechnungen')).toBeInTheDocument();
    await user.hover(within(kpis).getByText('MWST aus Abrechnungen'));
    expect(await screen.findByText(/aus den Verkäufen und Rückerstattungen deiner Abrechnungen/)).toBeInTheDocument();
  });

  it('under Saldo the VAT tile is the VAT billed, never geschuldet, with no fee input VAT', async () => {
    const user = userEvent.setup();
    const saldo = { ...SUMMARY, vatMethod: 'saldo', totals: { ...SUMMARY.totals, feeInputVat: null }, previous: { ...SUMMARY.previous!, feeInputVat: null } };
    renderPage({ settlement_review: reviewRoute(), turnover_summary: okBody(saldo as unknown as Record<string, unknown>) });
    const kpis = await screen.findByRole('list', { name: 'Kennzahlen' });
    expect(await within(kpis).findByText('MWST in Rechnung gestellt')).toBeInTheDocument();
    expect(within(kpis).queryByText('MWST aus Abrechnungen')).toBeNull();
    await user.hover(within(kpis).getByText('MWST in Rechnung gestellt'));
    expect(await screen.findByText(/keine Vorsteuer ab/)).toBeInTheDocument();
    expect(screen.queryByText(/abzüglich der Vorsteuer/)).toBeNull();
  });

  it('the comparison switches to the previous year and reads the books again', async () => {
    const user = userEvent.setup();
    const { calls } = renderPage({ settlement_review: reviewRoute() });
    await screen.findByRole('list', { name: 'Kennzahlen' });
    await user.click(screen.getByRole('radio', { name: 'Vorjahr' }));
    await waitFor(() => expect(calls.filter((c) => c.action === 'turnover_summary').some((c) => c.input.compare === 'previous_year')).toBe(true));
  });

  it('the Zu buchen tile filters the events to what Buchen books, and back', async () => {
    const user = userEvent.setup();
    renderPage({ settlement_review: reviewRoute() });
    await screen.findByText('lena.beispiel@kurswerk.example');
    expect(document.querySelectorAll('.umsatz-table tbody tr')).toHaveLength(3);
    await user.click(screen.getByRole('button', { name: /Zu buchen/ }));
    expect(document.querySelectorAll('.umsatz-table tbody tr')).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Alle zeigen' }));
    expect(document.querySelectorAll('.umsatz-table tbody tr')).toHaveLength(3);
  });

  it('each period in the control carries its booking state', () => {
    const words: Record<string, string> = { 'umsatz.periodState.to_book': 'zu buchen', 'umsatz.periodState.booked': 'gebucht' };
    const options = periodOptions({ from: '2026-07-01', to: '2026-09-30' }, 'quarter', PERIODS.periods as never, (k) => words[k] ?? k);
    expect(options[8]!.label).toMatch(/zu buchen$/);
    expect(options[7]!.label).toMatch(/gebucht$/);
    expect(options[6]!.label).not.toMatch(/·/);
  });

  it('the unit switch reads the month around the period shown', async () => {
    const user = userEvent.setup();
    const { calls } = renderPage({ settlement_review: reviewRoute() });
    await screen.findByText('lena.beispiel@kurswerk.example');
    await user.click(screen.getByRole('radio', { name: 'Monat' }));
    await waitFor(() => expect(calls.filter((c) => c.action === 'settlement_review').some((c) => c.input.from === '2026-07-01' && c.input.to === '2026-07-31')).toBe(true));
    await waitFor(() => expect(calls.some((c) => c.action === 'settlement_periods' && c.input.unit === 'month')).toBe(true));
  });

  it('Regeln: the booking template per source (the A43 editor), the settings saved on change with no reason, the payout bank rules', async () => {
    const user = userEvent.setup();
    const { calls } = renderPage({
      settlement_review: reviewRoute(),
      get_settlement_template: okBody({ templates: [{ system: 'Kurswerk', processor: 'Zahlfix', template: { clearingAccountId: 'acc_1095', kinds: { sale: { action: 'book', accountId: 'acc_31', taxCode: 'UST81' } } } }] }),
      get_settlement_source: okBody({ sources: [] }),
      settings_list: okBody({ settings: [{ key: 'settlement.test_events', value: 'skip' }, { key: 'settlement.review_period', value: 'quarter' }] }),
      list_bank_standards: okBody({
        standards: [
          { id: 'std_1', label: 'Zahlfix Auszahlung', counterpartyLabel: 'ZAHLFIX', accountNumber: '1095', legs: [{ accountNumber: '1095' }] },
          { id: 'std_2', label: 'Miete', counterpartyLabel: 'Vermieter', accountNumber: '6000', legs: [{ accountNumber: '6000' }] },
        ],
      }),
      // The shipped chart, as the engine answers it, plus the clearing account a book adds itself (1095 is not in
      // the shipped KMU chart, so it cannot come from the recording).
      list_accounts: okBody({ accounts: [...listAccountsFixture.accounts, BOOK_OWN_CLEARING] }),
      vat_codes: okBody({ taxCodes: [{ code: 'UST81', kind: 'output', label: 'MWST 8.1 %', active: true }] }),
      settings_set: okBody({ key: 'settlement.test_events', value: 'book' }),
    });
    await screen.findByText('lena.beispiel@kurswerk.example');
    await user.click(screen.getByRole('tab', { name: 'Regeln' }));
    expect(await screen.findByRole('form', { name: /Kurswerk/ })).toBeInTheDocument();
    expect(await screen.findByText('Zahlfix Auszahlung')).toBeInTheDocument();
    expect(screen.queryByText('Miete')).toBeNull();
    await user.click(screen.getByRole('combobox', { name: 'Testzahlungen' }));
    await user.click(await screen.findByRole('option', { name: 'Buchen' }));
    await waitFor(() => expect(calls.some((c) => c.action === 'settings_set')).toBe(true));
    const sent = calls.find((c) => c.action === 'settings_set')!.input;
    expect(sent).toMatchObject({ key: 'settlement.test_events', value: 'book' });
    expect(sent).not.toHaveProperty('reason');
  });

  it('pure helpers: what Buchen books, the comparison words, the sources, the payout rules', () => {
    expect(toBookOf(REVIEW)).toEqual({ count: 1, netMinor: 5000, vatMinor: 405, outside: 0 });
    expect(toBookOf(null)).toBeNull();
    const t = (k: string, v?: Record<string, string | number>) => `${k}:${JSON.stringify(v ?? {})}`;
    expect(compareLine(t, 125000, 100000, 'previous_period', true)).toMatch(/^umsatz\.figures\.delta:.*"sign":"\+","pct":25/);
    expect(compareLine(t, 0, 0, 'previous_year', true)).toMatch(/^umsatz\.figures\.same/);
    expect(compareLine(t, 5, null, 'previous_year', false)).toBe('');
    expect(sourcesOf([{ system: 'Kurswerk', processor: 'Zahlfix' }], [{ system: 'kurswerk', processor: 'ZAHLFIX' }, { system: 'Laden', processor: 'Kasse' }])).toHaveLength(2);
    expect(payoutRulesOf([{ id: 'a', label: null, counterpartyLabel: null, legs: [{ accountNumber: '1095' }] }, { id: 'b', label: null, counterpartyLabel: null, legs: [{ accountNumber: '6000' }] }], ['1095']).map((r) => r.id)).toEqual(['a']);
  });

  it('a11y: the calm start has no axe violations', async () => {
    const none: Review = { ...REVIEW, mode: 'none', system: '', processor: '', rows: [], toBook: 0, reviewSha256: '' };
    const { container } = renderPage({ settlement_review: reviewRoute(none) });
    await screen.findByRole('button', { name: 'Datei laden' });
    expect(await axe(container)).toHaveNoViolations();
  });

  it('a11y: the populated surface has no axe violations', async () => {
    const { container } = renderPage({ settlement_review: reviewRoute() });
    await screen.findByText('lena.beispiel@kurswerk.example');
    expect(await axe(container)).toHaveNoViolations();
  });

  it('a11y: the open derivation drawer has no axe violations', async () => {
    const user = userEvent.setup();
    renderPage({ settlement_review: reviewRoute() });
    const saleRow = (await screen.findByText('lena.beispiel@kurswerk.example')).closest('tr') as HTMLElement;
    await user.click(within(saleRow).getByRole('button', { name: 'Herleitung' }));
    expect(await axe(document.body)).toHaveNoViolations();
  });
});
