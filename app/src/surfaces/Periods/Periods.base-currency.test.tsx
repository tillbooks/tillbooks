/**
 * The year-end result in a workspace whose books are NOT kept in francs.
 *
 * THE DEFECT THIS EXISTS FOR. `close_year` returns `result`, swept out of
 * `SUM(base_debit_minor - base_credit_minor)` over the P&L accounts, so it is a BASE-currency figure
 * by construction. Periods rendered it through `formatMoney(feedback.result)` with no currency, and
 * `formatMoney` defaults to CHF. In a EUR-base workspace that puts a franc label on a euro figure,
 * on the panel confirming the single most irreversible write in the app.
 *
 * WHAT CHANGED. The engine now NAMES the unit: `close_year` returns `baseCurrency` beside `result`,
 * unconditionally (yearClose.ts), and `test/format-money/format-money-currency-fixture.test.mjs`
 * pins that against the live engine. So the client reads the name off the very answer that carries
 * the number, and the `get_company_profile` read that used to exist here purely to label the figure
 * is gone, along with the null gate that held the figure back and the CHF fallback for a failed
 * read. That fallback was the guessed unit surviving inside its own workaround.
 *
 * WHAT THESE TESTS PROTECT, WHICH IS UNCHANGED. The figure is never rendered without a unit, and the
 * unit is never invented by the client. Both properties outlived the workaround, so they are
 * asserted here directly rather than through the mechanism that used to provide them: the two tests
 * that described the workaround were rewritten, not deleted. A removed workaround whose property
 * nothing asserts is how a silent regression gets in.
 *
 * The figures are the fixture's, not literals: a EUR-base workspace, one posted USD entry of
 * USD 1'000.00 at 0.86, swept to a result of EUR 860.00. The transaction figure is 100000 and the
 * result is 86000, so a panel that labelled the right number wrongly and a panel that showed the
 * wrong number entirely both fail here.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

import Periods from './index';
import { TillClient, type Transport, type RestResponse } from '../../lib/client';
import { TillClientProvider } from '../../lib/client-context';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider } from '../../app/workspace';
import { watchReads } from '../../test-transport';
import fixture from '../../i18n/format-money-currency.fixture.json';

type Handler = RestResponse | ((input: Record<string, unknown>) => RestResponse | Promise<RestResponse>);
type Handlers = Record<string, Handler>;

const ok = (data: Record<string, unknown> = {}): RestResponse => ({ status: 200, body: { ok: true, ...data } });

/**
 * The profile answers CHF while the engine's close answers EUR, on purpose.
 *
 * The two sources DISAGREE here, which is what lets every assertion below tell them apart. While
 * this surface labelled the figure from the profile, the fixture's own EUR profile made the right
 * answer appear for the wrong reason: the test passed whichever source the label came from.
 * Pointing the profile at francs removes that ambiguity, so a panel printing `CHF 860.00` is a panel
 * reading the profile, and the test says so by name.
 */
const CHF_PROFILE = { ...fixture.profile, baseCurrency: 'CHF' };

const BASE: Handlers = {
  get_audit_log: ok({ rows: [], chainVerified: true }),
  list_period_locks: ok({ locks: [] }),
  // The month-end checklist's reads (F-07), answered empty: this file is about the year-close figure.
  month_end_checklist: ok({ period: '2026-08', items: [] }),
  list_reconciliation: ok({ matched: [], unmatched: [], partial: [] }),
  review_status: ok({ period: '2026-08', total: 0, approved: 0, flagged: 0, open: 0, entries: [] }),
  get_company_profile: ok({ profile: CHF_PROFILE }),
  close_year: ok(fixture.yearClose),
};

function renderPeriods(handlers: Handlers = {}) {
  const merged: Handlers = { ...BASE, ...handlers };
  const base: Transport = async (action, input) => {
    const h = merged[action];
    if (h === undefined) return { status: 404, body: { ok: false, error: 'unknown_action' } };
    return typeof h === 'function' ? h(input) : h;
  };
  const transport = watchReads(base);
  const utils = render(
    <TillClientProvider client={new TillClient(transport)}>
      <I18nProvider initialLocale="en">
        <WorkspaceProvider initialId="ws_test">
          <MemoryRouter>
            <Periods />
          </MemoryRouter>
        </WorkspaceProvider>
      </I18nProvider>
    </TillClientProvider>,
  );
  return { ...utils, transport };
}

/** Drive the confirm-gated year close for the fixture's fiscal year. */
async function closeTheYear() {
  await screen.findByText(/No period closed yet/);
  await userEvent.click(screen.getByRole('combobox', { name: 'Year' }));
  await userEvent.click(screen.getByRole('option', { name: fixture.entry.date.slice(0, 4) }));
  await userEvent.click(screen.getByRole('button', { name: 'Run year-end close' }));
  const confirm = await screen.findByRole('alertdialog');
  await userEvent.click(within(confirm).getByRole('button', { name: 'Run year-end close' }));
}

describe('Periods, the year result is denominated in the books own currency', () => {
  it('labels the swept result with the currency the ENGINE named, never a defaulted CHF', async () => {
    renderPeriods();
    await closeTheYear();

    expect(await screen.findByText('Year 2026 closed.')).toBeInTheDocument();
    // EUR 860.00: the number the engine swept, under the unit the engine named beside it.
    expect(await screen.findByText(/EUR 860\.00/)).toBeInTheDocument();
    // CHF is the interesting negative twice over: it is what `formatMoney` defaults to AND what the
    // profile in scope says. Seeing it would mean the label came from a guess or from the old read.
    expect(screen.queryByText(/CHF/)).toBeNull();
    // And never the transaction figure it converted from, which would be a different defect.
    expect(screen.queryByText(/1'000\.00/)).toBeNull();
    expect(fixture.yearClose.result).toBe(86000);
    expect(fixture.yearClose.baseCurrency).toBe('EUR');
    expect(CHF_PROFILE.baseCurrency).toBe('CHF');
  });

  it('asks the engine for no company profile at all: the label rides the close answer', async () => {
    // The read this surface used to hold open existed for one purpose, labelling this figure, and
    // the engine now supplies that label itself. This is the assertion that keeps it gone: without
    // it the read could drift back in and every other test here would stay green.
    const { transport } = renderPeriods();
    await closeTheYear();
    await screen.findByText(/EUR 860\.00/);

    expect(transport.asked).not.toContain('get_company_profile');
    expect(transport.asked).toContain('close_year');
  });

  it('LOADING: prints no figure while the close is in flight, so no unit can precede it', async () => {
    // The property the old null gate provided, asserted against the read that is actually left. The
    // figure and its currency arrive in ONE answer now, so the only window in which a number could
    // exist without a unit is the window before that answer lands. Nothing is printed in it.
    let release: (r: RestResponse) => void = () => {};
    const { transport } = renderPeriods({
      close_year: () =>
        new Promise<RestResponse>((resolve) => {
          release = resolve;
        }),
    });
    await closeTheYear();
    await transport.started('close_year');

    expect(screen.queryByText(/860\.00/)).toBeNull();
    expect(screen.queryByText(/CHF|EUR|USD/)).toBeNull();

    // And it is a state the panel passes THROUGH: figure and unit arrive together, or not at all.
    release({ status: 200, body: { ok: true, ...fixture.yearClose } });
    expect(await screen.findByText(/EUR 860\.00/)).toBeInTheDocument();
  });

  it('names no currency at all before the close, so nothing can leak a label onto an empty panel', async () => {
    renderPeriods();
    await screen.findByText(/No period closed yet/);
    expect(screen.queryByText(/EUR|CHF|USD/)).toBeNull();
  });

  it('confirms the close but prints NO figure when the engine names no currency', async () => {
    // This is the rewritten fallback test. The old behaviour (settle to CHF) is gone: defaulting was
    // the original guessed-unit defect preserved inside the workaround for it, and with the engine
    // naming the unit unconditionally there is no honest reason left to guess.
    //
    // The close itself is still confirmed. The year really was closed and saying nothing about that
    // would be worse than saying it: what is withheld is only the figure whose unit is unknown.
    const { closingEntryId, carryEntryId, result } = fixture.yearClose;
    renderPeriods({ close_year: ok({ closingEntryId, carryEntryId, result }) });
    await closeTheYear();

    expect(await screen.findByText('Year 2026 closed.')).toBeInTheDocument();
    expect(screen.queryByText(/860\.00/)).toBeNull();
    expect(screen.queryByText(/CHF/)).toBeNull();
    expect(screen.queryByText(/Year result/)).toBeNull();
  });

  it('prints no figure when the engine sends an empty currency, rather than an unlabelled number', async () => {
    // An empty string is not a unit. It sails through a plain `typeof === 'string'` check and would
    // render `860.00` with a bare space where the currency belongs, which is exactly the unlabelled
    // figure this file exists to prevent.
    const { closingEntryId, carryEntryId, result } = fixture.yearClose;
    renderPeriods({ close_year: ok({ closingEntryId, carryEntryId, result, baseCurrency: '' }) });
    await closeTheYear();

    expect(await screen.findByText('Year 2026 closed.')).toBeInTheDocument();
    expect(screen.queryByText(/860\.00/)).toBeNull();
    expect(screen.queryByText(/Year result/)).toBeNull();
  });
});
