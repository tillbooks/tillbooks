/**
 * A16, Offene Posten: the app-level suite the surface shipped without.
 *
 * WHAT THIS FILE IS ANCHORED ON, AND WHY IT MATTERS. Every figure, date, name and number asserted
 * below is read off the RECORDINGS in this directory, and those recordings are pinned to the live
 * engine VALUE for value by `test/debtors/studio-open-items-fixture.test.mjs`. That pairing is the
 * whole point: eight hand-typed account names once rode green through three Studio suites because
 * the fixtures agreed with the author rather than with the engine, and a keys-and-kinds guard cannot
 * see that. So the strings here are display forms of recorded values (`CHF 481.00` is `48100` Rappen
 * through `formatMoney`, `30.01.2026` is `2026-01-30` through `formatDate`) and nothing is invented.
 *
 * THE LOADING TESTS PROVE THEIR READ. `loading` initialises to `true`, so the skeleton is on screen
 * at the first commit, before any effect fires. `transport.started(...)` from `test-transport.ts` is
 * what turns "a skeleton is showing" into "the read really went in flight", and
 * `app/src/loading-state-convention.test.ts` fails this file if it ever stops doing that.
 *
 * THE AXE TEST IS ANCHORED ON A SETTLED SURFACE. Three files in this repo once shipped axe tests
 * that passed with their read hung forever, which audits the skeleton and calls it the surface. The
 * browser harness has `waitForPaintToSettle` (`.claude/ui-tests/lib/audit-tools.cjs`) for that, and
 * it cannot run here: it drives `document.getAnimations()` through Playwright, and its load-bearing
 * infinite-animation exclusion exists because `.skeleton` pulses `1.4s ease-in-out infinite`. The
 * jsdom equivalent is `settled()` below: real content present AND no `aria-busy` region left.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, it, expect, vi } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { MemoryRouter } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider } from '../../app/workspace';
import { neverSettles, watchReads } from '../../test-transport';
import OpenItems from './index';

import listFixture from './list-open-items.fixture.json';
import mixedFixture from './list-open-items.mixed.fixture.json';
import mismatchFixture from './list-open-items.mismatch.fixture.json';
import agingFixture from './aging-report.fixture.json';
import balanceFixture from './customer-balance.fixture.json';
import configFixture from './aging-bucket-config.fixture.json';

/** A canned handler exactly as the transport calls it: the request input in, a RestResponse out. */
type CannedHandler = (input: Record<string, unknown>) => RestResponse;

type Canned = Record<string, RestResponse | CannedHandler>;

function fakeTransport(canned: Canned): Transport {
  return async (action, input) => {
    const entry = canned[action];
    if (entry === undefined) return { status: 404, body: { ok: false, error: 'unknown_action' } };
    return typeof entry === 'function' ? entry(input) : entry;
  };
}

const ok = (data: Record<string, unknown> = {}): RestResponse => ({
  status: 200,
  body: { ok: true, ...data },
});

const reject = (error: string, status = 422, extra: Record<string, unknown> = {}): RestResponse => ({
  status,
  body: { ok: false, error, ...extra },
});

const HAPPY: Canned = {
  list_open_items: ok(listFixture),
  aging_report: ok(agingFixture),
  customer_balance: ok(balanceFixture),
  get_aging_bucket_config: ok(configFixture),
};

interface RenderOptions {
  workspaceId?: string | null;
  route?: string;
  transport?: Transport;
}

function renderOpenItems(canned: Canned = HAPPY, options: RenderOptions = {}) {
  const { workspaceId = 'ws_test', route = '/open-items', transport } = options;
  const client = new TillClient(transport ?? fakeTransport(canned));
  return render(
    <TillClientProvider client={client}>
      <I18nProvider>
        <WorkspaceProvider initialId={workspaceId}>
          <MemoryRouter initialEntries={[route]}>
            <OpenItems />
          </MemoryRouter>
        </WorkspaceProvider>
      </I18nProvider>
    </TillClientProvider>,
  );
}

/**
 * Wait until the surface is SETTLED, not merely mounted.
 *
 * Two conditions, and the second is the one that matters: some real recorded content is on screen,
 * and no `aria-busy` region is left anywhere in the tree. Anchoring an axe run on the first frame
 * audits the skeleton, which is why three earlier axe tests passed over a read that never returned.
 */
async function settled(container: HTMLElement, anchor: string): Promise<void> {
  await screen.findByText(anchor);
  await waitFor(() => {
    expect(container.querySelectorAll('[aria-busy="true"]')).toHaveLength(0);
  });
}

// --- the recording, addressed by value ------------------------------------------------------------

/** One recorded row by its document number. Throws rather than asserting against `undefined`. */
function recorded(number: string) {
  const row = listFixture.items.find((item) => item.number === number);
  if (row === undefined) throw new Error(`the recording has no document ${number}`);
  return row;
}

/** The parked rows, which are the two the chip copy is derived from. */
const CREDIT = listFixture.items.find((i) => i.kind === 'on_account' && i.direction === 'incoming');
const REFUND = listFixture.items.find((i) => i.kind === 'on_account' && i.direction === 'outgoing');

/** An otherwise-valid `list_open_items` answer holding no rows at all. */
function emptyList(overrides: Record<string, unknown> = {}) {
  const zeroed = Object.fromEntries(Object.keys(listFixture.bucketTotals).map((k) => [k, 0]));
  return {
    ...listFixture,
    items: [],
    bucketTotals: zeroed,
    baseBucketTotals: zeroed,
    totalOpenMinor: 0,
    baseTotalOpenMinor: 0,
    workspaceBaseTotalOpenMinor: 0,
    receivablesBalanceMinor: 0,
    reconciled: true,
    reconciliationDifferenceMinor: 0,
    ...overrides,
  };
}

describe('the recording these assertions are read off', () => {
  // A suite asserting display strings derived from a fixture is only as good as its claim about that
  // fixture. If the recording is re-captured against a different seed, these fail FIRST and name the
  // drift, instead of every assertion below failing as an unexplained string mismatch.
  it('holds the seven rows, four buckets and reconciled totals the tests below assume', () => {
    expect(listFixture.items).toHaveLength(7);
    expect(listFixture.baseCurrency).toBe('CHF');
    expect(listFixture.currencies).toEqual(['CHF']);
    expect(listFixture.boundariesDays).toEqual([30, 60, 90]);
    expect(listFixture.baseTotalOpenMinor).toBe(407500);
    expect(listFixture.reconciled).toBe(true);
    expect(recorded('R-2026-0006').openMinor).toBe(48100);
    expect(CREDIT?.openMinor).toBe(-35000);
    expect(REFUND?.openMinor).toBe(12000);
  });

  it('records an as-of that is in the past, which is what puts the historical band on screen', () => {
    // The band is `asOf !== todayIso()`. The recording is 19.07.2026 and today is later, so the
    // branch is live in every populated test below. Asserted rather than assumed.
    expect(listFixture.asOf).toBe('2026-07-19');
    expect(listFixture.asOf < new Date().toISOString().slice(0, 10)).toBe(true);
  });
});

// --- the five states ------------------------------------------------------------------------------

describe('OpenItems, five states', () => {
  it('LOADING: shows the skeleton while list_open_items is genuinely in flight', async () => {
    const transport = watchReads(neverSettles);
    renderOpenItems(HAPPY, { transport });
    // The proof. Without it this assertion holds over a surface that reads nothing at all: `loading`
    // starts true, so both regions are on screen before any effect has run.
    await transport.started('list_open_items');

    const regions = screen.getAllByRole('status');
    expect(regions).toHaveLength(2);
    for (const region of regions) expect(region).toHaveAttribute('aria-busy', 'true');
    // No plausible zero anywhere: an unavailable total is a muted placeholder, never `CHF 0.00`.
    expect(screen.queryByText(/CHF 0\.00/)).not.toBeInTheDocument();
  });

  it('LOADING: the customer tab proves aging_report, not list_open_items', async () => {
    const transport = watchReads(neverSettles);
    renderOpenItems(HAPPY, { transport, route: '/open-items?by=customer' });
    await transport.started('aging_report');
    expect(transport.asked).not.toContain('list_open_items');
    expect(screen.getAllByRole('status')[0]).toHaveAttribute('aria-busy', 'true');
  });

  it('NO WORKSPACE: offers the way to /setup and asks the engine for nothing', async () => {
    const listSpy = vi.fn<CannedHandler>(() => ok(listFixture));
    renderOpenItems({ ...HAPPY, list_open_items: listSpy }, { workspaceId: null });

    expect(await screen.findByText('Kein Arbeitsbereich vorhanden')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Arbeitsbereich einrichten' })).toHaveAttribute(
      'href',
      '/setup',
    );
    expect(listSpy).not.toHaveBeenCalled();
  });

  it('EMPTY: says everything is paid, and points at issuing an invoice', async () => {
    renderOpenItems({ ...HAPPY, list_open_items: ok(emptyList()) });

    expect(await screen.findByText('Alles bezahlt, keine offenen Posten.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Rechnung ausstellen' })).toHaveAttribute(
      'href',
      '/documents',
    );
    // It must NOT blame a filter that is not set.
    expect(screen.queryByText('Keine offenen Posten für diese Auswahl.')).not.toBeInTheDocument();
  });

  it('EMPTY (filtered): blames the filter, not the workspace, and offers to reset it', async () => {
    renderOpenItems(
      { ...HAPPY, list_open_items: ok(emptyList({ filtered: true })) },
      { route: '/open-items?customer=contact_1' },
    );

    expect(await screen.findByText('Keine offenen Posten für diese Auswahl.')).toBeInTheDocument();
    expect(screen.queryByText('Alles bezahlt, keine offenen Posten.')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Filter zurücksetzen' }));
    // The reset drops the filter parameters, so the surface re-reads without them.
    expect(await screen.findByText('Alles bezahlt, keine offenen Posten.')).toBeInTheDocument();
  });

  it('EMPTY (filtered): renders no zero tiles above the panel (gate F8.4)', async () => {
    // `bucketTotals` is computed over the FILTERED set, so with no rows every tile is zero. Four
    // `CHF 0.00` tiles stacked over "Keine offenen Posten für diese Auswahl" are noise, and the
    // design's §5.1 asked for exactly this suppression: "The tiles render no amounts".
    const { container } = renderOpenItems(
      { ...HAPPY, list_open_items: ok(emptyList({ filtered: true })) },
      { route: '/open-items?customer=contact_1' },
    );

    await screen.findByText('Keine offenen Posten für diese Auswahl.');
    expect(
      screen.queryByRole('group', { name: 'Aufteilung nach Fälligkeit' }),
    ).not.toBeInTheDocument();
    expect(container.querySelectorAll('.oi-tile')).toHaveLength(0);
    expect(screen.queryByText('CHF 0.00')).not.toBeInTheDocument();
  });

  it('KEEPS the tiles when a BUCKET filter is the thing that matched nothing', async () => {
    // The other half of the rule, and the one that stops the fix above becoming a dead end: here
    // the engine did return rows, the empty view is the operator's own tile click, and the tiles
    // are the way back out of it.
    const without90 = {
      ...listFixture,
      items: listFixture.items.filter((item) => item.bucket !== '90+'),
    };
    renderOpenItems({ ...HAPPY, list_open_items: ok(without90) }, { route: '/open-items?bucket=90%2B' });

    await screen.findByText('Keine offenen Posten für diese Auswahl.');
    expect(screen.getByRole('group', { name: 'Aufteilung nach Fälligkeit' })).toBeInTheDocument();
  });

  it('ERROR: names what failed and retries the read in place', async () => {
    let calls = 0;
    renderOpenItems({
      ...HAPPY,
      list_open_items: () => {
        calls += 1;
        return calls === 1 ? reject('transport_error', 500) : ok(listFixture);
      },
    });

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByText('Offene Posten konnten nicht geladen werden.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Erneut versuchen' }));
    await waitFor(() => expect(calls).toBe(2));
    expect(await screen.findByText('R-2026-0006')).toBeInTheDocument();
  });

  it('DENIED: renders the padlock panel naming the missing READ right', async () => {
    renderOpenItems({ ...HAPPY, list_open_items: reject('permission_denied', 403) });

    expect(await screen.findByRole('heading', { name: 'Kein Zugriff' })).toBeInTheDocument();
    expect(
      screen.getByText('Dir fehlt die Berechtigung, offene Posten zu sehen.'),
    ).toBeInTheDocument();
    // A denied read is a state, not an error banner, and it replaces the table rather than sitting
    // above an empty one.
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('POPULATED: renders the recorded rows with recorded money and recorded dates', async () => {
    renderOpenItems();

    const row = (await screen.findByRole('link', { name: 'R-2026-0006' })).closest(
      'tr',
    ) as HTMLElement;
    expect(within(row).getByText('Muster AG')).toBeInTheDocument();
    // 2026-01-30 and 2026-03-01 as TT.MM.JJJJ, 48100 Rappen as CHF 481.00, 140 days overdue.
    expect(within(row).getByText('30.01.2026')).toBeInTheDocument();
    expect(within(row).getByText('01.03.2026')).toBeInTheDocument();
    expect(within(row).getByText('CHF 481.00')).toBeInTheDocument();
    expect(within(row).getByText('140 Tage')).toBeInTheDocument();
    expect(row.querySelector('a')).toHaveAttribute('href', '/documents/doc_6');

    // The header total is the BASE figure, labelled, and it is the recorded 407500 Rappen.
    expect(screen.getByText("CHF 4'075.00 offen")).toBeInTheDocument();
    // A row that is not overdue says so in words rather than showing a bare 0.
    const current = screen.getByRole('link', { name: 'R-2026-0002' }).closest('tr') as HTMLElement;
    expect(within(current).getByText('nicht überfällig')).toBeInTheDocument();
  });

  it('has no axe violations on a SETTLED populated surface', async () => {
    const { container } = renderOpenItems();
    await settled(container, 'R-2026-0006');
    const results = await axe(container, {
      rules: { region: { enabled: false }, 'page-has-heading-one': { enabled: false } },
    });
    expect(results).toHaveNoViolations();
  });
});

// --- what the surface deliberately does NOT show --------------------------------------------------

describe('A16 invariants that are absences', () => {
  it('INV-4: shows no Mahnstufe, no Mahnen and no Verzug, in any state', async () => {
    const { container } = renderOpenItems();
    await settled(container, 'R-2026-0006');
    // `dunningLevel` is hardcoded 0 by the engine while A15 is unbuilt, so a column would read 0 on
    // every row of every workspace and imply a dunning system that has decided nothing.
    expect(container.textContent).not.toMatch(/Mahn|Verzug/);
  });

  it('renders no primary action, because A16 writes nothing to the ledger', async () => {
    const { container } = renderOpenItems();
    await settled(container, 'R-2026-0006');
    expect(container.querySelectorAll('.btn--primary')).toHaveLength(0);
  });
});

// --- the parked rows ------------------------------------------------------------------------------

describe('parked rows read the engine direction, never the sign of the amount', () => {
  it('calls incoming parked money Guthaben and outgoing money a Rückzahlung', async () => {
    renderOpenItems();
    await screen.findByText('R-2026-0006');

    // Both rows carry a chip instead of a Beleg-Nr., because neither belongs to a document.
    const credit = screen.getByText('Guthaben').closest('tr') as HTMLElement;
    expect(within(credit).getByText('CHF -350.00')).toBeInTheDocument();
    expect(within(credit).queryByRole('link')).not.toBeInTheDocument();

    const refund = screen.getByText('Rückzahlung, nicht zugewiesen').closest('tr') as HTMLElement;
    // The refund's amount is POSITIVE and its chip still says refund: a sign-derived chip would
    // have called this one Guthaben and stated the opposite of the fact.
    expect(within(refund).getByText('CHF 120.00')).toBeInTheDocument();
  });

  it('offers Zuweisen on a parked row and Zahlung erfassen on a document row', async () => {
    renderOpenItems();
    await screen.findByText('R-2026-0006');

    const credit = screen.getByText('Guthaben').closest('tr') as HTMLElement;
    await userEvent.click(within(credit).getByRole('button', { name: /Aktionen für Guthaben/ }));
    expect(within(credit).getByRole('menuitem', { name: 'Zuweisen' })).toBeInTheDocument();
    expect(within(credit).queryByRole('menuitem', { name: 'Zahlung erfassen' })).not.toBeInTheDocument();
    await userEvent.keyboard('{Escape}');

    const invoice = screen.getByRole('link', { name: 'R-2026-0006' }).closest('tr') as HTMLElement;
    await userEvent.click(
      within(invoice).getByRole('button', { name: /Aktionen für R-2026-0006/ }),
    );
    expect(within(invoice).getByRole('menuitem', { name: 'Zahlung erfassen' })).toBeInTheDocument();
  });
});

// --- the tiles ------------------------------------------------------------------------------------

describe('the aging tiles', () => {
  it('derives its tile count from boundariesDays and shows base amounts and row counts', async () => {
    renderOpenItems();
    await screen.findByText('R-2026-0006');

    const group = screen.getByRole('group', { name: 'Aufteilung nach Fälligkeit' });
    // [30, 60, 90] yields four buckets, never a hardcoded four.
    expect(within(group).getAllByRole('button')).toHaveLength(4);

    const first = within(group).getByRole('button', { name: /0 bis 30 Tage/ });
    // 143200 Rappen across four rows: doc_3, doc_2 and the two parked rows.
    expect(within(first).getByText("CHF 1'432.00")).toBeInTheDocument();
    expect(within(first).getByText('4 Posten')).toBeInTheDocument();

    const last = within(group).getByRole('button', { name: /Über 90 Tage/ });
    expect(within(last).getByText('CHF 481.00')).toBeInTheDocument();
    expect(within(last).getByText('1 Posten')).toBeInTheDocument();
  });

  it('filters the list to one bucket and back, and says which tile is pressed', async () => {
    renderOpenItems();
    await screen.findByText('R-2026-0006');

    const group = screen.getByRole('group', { name: 'Aufteilung nach Fälligkeit' });
    const tile = within(group).getByRole('button', { name: /31 bis 60 Tage/ });
    await userEvent.click(tile);

    expect(await screen.findByRole('link', { name: 'R-2026-0004' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'R-2026-0006' })).not.toBeInTheDocument();
    expect(within(group).getByRole('button', { name: /31 bis 60 Tage/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    await userEvent.click(screen.getByRole('button', { name: 'Alle anzeigen' }));
    expect(await screen.findByRole('link', { name: 'R-2026-0006' })).toBeInTheDocument();
  });
});

// --- the reconciliation statement -----------------------------------------------------------------

describe('the reconciliation statement', () => {
  it('states agreement with 1100 in words when the engine says reconciled', async () => {
    renderOpenItems();
    expect(
      await screen.findByText('Stimmt mit 1100 Forderungen aus Lieferungen und Leistungen überein'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/unterscheiden sich um/)).not.toBeInTheDocument();
  });

  it('replaces it with the mismatch band, quoting both recorded figures', async () => {
    renderOpenItems({ ...HAPPY, list_open_items: ok(mismatchFixture) });

    // -1250 Rappen difference, list 407500, ledger 408750: all three off the recording.
    expect(
      await screen.findByText('Die offenen Posten und Konto 1100 unterscheiden sich um CHF -12.50.'),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Die Liste zeigt CHF 4'075.00, das Konto CHF 4'087.50."),
    ).toBeInTheDocument();
    expect(screen.queryByText('Stimmt mit 1100 Forderungen aus Lieferungen und Leistungen überein')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Journal öffnen' })).toHaveAttribute('href', '/journal');
  });

  it('lists two causes in a single-currency workspace, and never states a tolerance', async () => {
    renderOpenItems({ ...HAPPY, list_open_items: ok(mismatchFixture) });
    await screen.findByText(/unterscheiden sich um/);

    await userEvent.click(screen.getByRole('button', { name: 'Was jetzt?' }));
    const causes = await screen.findByRole('list');
    // The FX-plus-Skonto line is withheld: the recording holds one currency, and a permanent caveat
    // trains the operator to discount the one statement here that has to stay trustworthy.
    expect(within(causes).getAllByRole('listitem')).toHaveLength(2);
    expect(within(causes).queryByText(/Fremdwährungsrechnung/)).not.toBeInTheDocument();
  });

  it('moves the passing mark onto its own line, with the WORKSPACE total, under a filter', async () => {
    renderOpenItems(
      { ...HAPPY, list_open_items: ok({ ...listFixture, filtered: true }) },
      { route: '/open-items?customer=contact_1' },
    );
    // `reconciled` is computed over ALL items, so beside a filtered total it would claim the ledger
    // validated a figure it has never seen.
    expect(
      await screen.findByText("Arbeitsbereich total CHF 4'075.00, stimmt mit 1100 überein"),
    ).toBeInTheDocument();
  });
});

// --- multi-currency -------------------------------------------------------------------------------

describe('a mixed-currency workspace', () => {
  it('shows every row in its own currency and never converts one in the browser', async () => {
    renderOpenItems({ ...HAPPY, list_open_items: ok(mixedFixture) });

    const eur = (await screen.findByRole('link', { name: 'R-2026-0007' })).closest(
      'tr',
    ) as HTMLElement;
    // The recorded row is 108100 EUR face with 101744 base Rappen. The cell shows the FACE amount
    // in EUR: printing francs there would be the whole failure at once.
    expect(within(eur).getByText("EUR 1'081.00")).toBeInTheDocument();
    expect(within(eur).queryByText("CHF 1'017.44")).not.toBeInTheDocument();

    // The header total is the base figure, and it is the engine's, not a browser sum.
    expect(screen.getByText("CHF 4'972.44 offen")).toBeInTheDocument();
  });

  it('offers exactly the currencies the engine returned, plus an all-currencies option', async () => {
    renderOpenItems({ ...HAPPY, list_open_items: ok(mixedFixture) });
    await screen.findByRole('link', { name: 'R-2026-0007' });

    const picker = screen.getByLabelText('Währung');
    expect(
      within(picker).getAllByRole('option').map((option) => option.textContent),
    ).toEqual(['Alle Währungen', 'CHF', 'EUR']);
  });

  it('tiles in base currency even when the rows are not, so they tie to the header', async () => {
    renderOpenItems({ ...HAPPY, list_open_items: ok(mixedFixture) });
    await screen.findByRole('link', { name: 'R-2026-0007' });

    const group = screen.getByRole('group', { name: 'Aufteilung nach Fälligkeit' });
    // 209844 base Rappen in 31-60, which includes the EUR row's base figure and no face sum.
    expect(within(group).getByText("CHF 2'098.44")).toBeInTheDocument();
  });
});

// --- the Kunde filter ----------------------------------------------------------------------------

describe('the Kunde filter', () => {
  // --- the Kunde filter (gate F2) ---------------------------------------------------------------
  //
  // `?customer=` was honoured by the read, counted as an active filter and given its own
  // reconciliation sentence, with NO control anywhere that set it, named it or cleared it. The
  // design's §5.1 wireframe draws `Kunde [alle v]` between Stand and the currency picker and counts
  // it as one of the toolbar's five decisions. "Filter zurücksetzen" lived only inside the
  // filtered-empty panel, so the one way out appeared exactly when the filter had matched nothing.

  it('offers exactly the customers the engine returned, plus an all-customers option', async () => {
    renderOpenItems();
    await screen.findByText('R-2026-0006');

    const picker = screen.getByLabelText('Kunde');
    // The recording holds two customers across seven rows: each is offered once.
    expect(within(picker).getAllByRole('option').map((option) => option.textContent)).toEqual([
      'Alle Kunden',
      'Beispiel GmbH',
      'Muster AG',
    ]);
    expect(picker).toHaveValue('');
  });

  it('sends the chosen customer to the engine and puts it in the URL', async () => {
    const listSpy = vi.fn<CannedHandler>(() => ok(listFixture));
    renderOpenItems({ ...HAPPY, list_open_items: listSpy });
    await screen.findByText('R-2026-0006');

    await userEvent.selectOptions(screen.getByLabelText('Kunde'), 'contact_2');
    await waitFor(() => expect(listSpy).toHaveBeenCalledTimes(2));
    expect(listSpy.mock.calls[1][0]).toMatchObject({
      workspaceId: 'ws_test',
      customerId: 'contact_2',
    });
  });

  it('NAMES the customer a URL-borne filter is narrowed to, and clears it back to all', async () => {
    const listSpy = vi.fn<CannedHandler>(() => ok({ ...listFixture, filtered: true }));
    renderOpenItems({ ...HAPPY, list_open_items: listSpy }, { route: '/open-items?customer=contact_1' });
    await screen.findByText('R-2026-0006');

    // The state is on screen as a NAME, not only as a reduced table and a reduced total.
    const picker = screen.getByLabelText('Kunde');
    expect(picker).toHaveValue('contact_1');
    expect(within(picker).getByRole('option', { selected: true }).textContent).toBe('Muster AG');

    await userEvent.selectOptions(picker, '');
    await waitFor(() => expect(listSpy).toHaveBeenCalledTimes(2));
    expect(listSpy.mock.calls[1][0]).not.toHaveProperty('customerId');
  });

  it('still names the filtered customer when the filter matched nothing at all', async () => {
    // The one case the returned rows cannot name, and the one where an unnamed filter is worst:
    // the table is empty, so a picker built only from the rows would fall back to a blank control
    // over an empty panel. The id is the only fact available and it is shown as one.
    renderOpenItems(
      { ...HAPPY, list_open_items: ok(emptyList({ filtered: true })) },
      { route: '/open-items?customer=contact_9' },
    );
    await screen.findByText('Keine offenen Posten für diese Auswahl.');

    const picker = screen.getByLabelText('Kunde');
    expect(picker).toHaveValue('contact_9');
    expect(within(picker).getByRole('option', { selected: true }).textContent).toBe(
      'Kunde contact_9',
    );
  });
});

// --- the as-of cut-off ----------------------------------------------------------------------------

describe('the historical as-of band', () => {
  it('says which date the figures are cut at, and offers the way back to today', async () => {
    renderOpenItems();
    expect(
      await screen.findByText('Stand 19.07.2026. Zahlungen nach diesem Datum zählen nicht mit.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Auf heute' })).toBeInTheDocument();
  });

  it('sends the asOf the operator picked to the engine', async () => {
    const listSpy = vi.fn<CannedHandler>(() => ok(listFixture));
    renderOpenItems(
      { ...HAPPY, list_open_items: listSpy },
      { route: '/open-items?asOf=2026-06-30' },
    );
    await waitFor(() => expect(listSpy).toHaveBeenCalled());
    expect(listSpy.mock.calls[0][0]).toMatchObject({ workspaceId: 'ws_test', asOf: '2026-06-30' });
  });
});

// --- the Nach-Kunde tab ---------------------------------------------------------------------------

describe('the Nach-Kunde tab', () => {
  const customerRoute = '/open-items?by=customer';

  it('renders one row per customer, largest debtor first, with recorded figures', async () => {
    renderOpenItems(HAPPY, { route: customerRoute });

    const first = (await screen.findByRole('button', { name: /Beispiel GmbH/ })).closest(
      'tr',
    ) as HTMLElement;
    expect(within(first).getByText('2')).toBeInTheDocument();
    expect(within(first).getByText('90 Tage')).toBeInTheDocument();
    expect(within(first).getByText("CHF 2'162.00")).toBeInTheDocument();

    const rows = screen.getAllByRole('row').slice(1);
    expect(rows[0].textContent).toContain('Beispiel GmbH');
    expect(rows[1].textContent).toContain('Muster AG');

    // The column is a day count, never a legal term: Verzug belongs to A15.
    expect(screen.getByRole('columnheader', { name: 'Längste Überfälligkeit' })).toBeInTheDocument();
  });

  it('EMPTY: an aging report with no customers says everything is paid', async () => {
    renderOpenItems(
      { ...HAPPY, aging_report: ok({ ...agingFixture, byCustomer: [] }) },
      { route: customerRoute },
    );
    expect(await screen.findByText('Alles bezahlt, keine offenen Posten.')).toBeInTheDocument();
  });

  it('DENIED: the tab renders the padlock panel too', async () => {
    renderOpenItems(
      { ...HAPPY, aging_report: reject('permission_denied', 403) },
      { route: customerRoute },
    );
    expect(await screen.findByRole('heading', { name: 'Kein Zugriff' })).toBeInTheDocument();
  });

  it('LOADING: expanding a customer proves customer_balance went in flight', async () => {
    const transport = watchReads(async (action, input) =>
      action === 'customer_balance'
        ? neverSettles(action, input)
        : fakeTransport(HAPPY)(action, input),
    );
    const { container } = renderOpenItems(HAPPY, { route: customerRoute, transport });

    await userEvent.click(await screen.findByRole('button', { name: /Muster AG/ }));
    await transport.started('customer_balance');
    // Scoped to the expansion row: the surface around it has settled, and the as-of band is a
    // `role="status"` of its own, so an unscoped query would not be about this read.
    const expansion = container.querySelector('.oi-expansion-row') as HTMLElement;
    expect(within(expansion).getByRole('status')).toHaveAttribute('aria-busy', 'true');
  });

  it('expands a customer into its items and its signed parked position', async () => {
    const balanceSpy = vi.fn<CannedHandler>(() => ok(balanceFixture));
    const { container } = renderOpenItems(
      { ...HAPPY, customer_balance: balanceSpy },
      { route: customerRoute },
    );

    const toggle = await screen.findByRole('button', { name: /Muster AG/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(toggle);

    expect(await screen.findByText('Offen total')).toBeInTheDocument();
    // Scoped to the expansion: the aggregate row above it carries the SAME CHF 1'913.00, which is
    // the point (the two derivations agree), and an unscoped query cannot tell them apart.
    const panel = container.querySelector('.oi-expansion') as HTMLElement;
    // 191300 Rappen open, 23000 parked and POSITIVE, so it is a credit and already deducted.
    expect(within(panel).getByText("CHF 1'913.00")).toBeInTheDocument();
    expect(within(panel).getByText('CHF 230.00')).toBeInTheDocument();
    expect(within(panel).getByText('(bereits abgezogen)')).toBeInTheDocument();
    expect(balanceSpy.mock.calls[0][0]).toMatchObject({
      workspaceId: 'ws_test',
      customerId: 'contact_1',
      asOf: '2026-07-19',
    });
  });

  it('hangs Zuweisen off each parked row, never off the aggregate figure', async () => {
    renderOpenItems(HAPPY, { route: customerRoute });
    await userEvent.click(await screen.findByRole('button', { name: /Muster AG/ }));
    await screen.findByText('Offen total');

    // `customer_balance` returns two parked rows with different payment ids, and
    // `/payments/new?allocate=<id>` (the D113 Werkbank route) takes exactly one, so one aggregate
    // button could not say which.
    const links = screen.getAllByRole('link', { name: 'Zuweisen' });
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      '/payments/new?allocate=pay_3',
      '/payments/new?allocate=pay_4',
    ]);
  });

  it('ERROR: a failed customer_balance stays inside the expansion and retries there', async () => {
    let calls = 0;
    renderOpenItems(
      {
        ...HAPPY,
        customer_balance: () => {
          calls += 1;
          return calls === 1 ? reject('transport_error', 500) : ok(balanceFixture);
        },
      },
      { route: customerRoute },
    );

    await userEvent.click(await screen.findByRole('button', { name: /Muster AG/ }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    // The table around it is untouched: one row failed, not the surface.
    expect(screen.getByRole('button', { name: /Beispiel GmbH/ })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Erneut versuchen' }));
    await waitFor(() => expect(calls).toBe(2));
    expect(await screen.findByText('Offen total')).toBeInTheDocument();
  });

  it('has no axe violations on a SETTLED expanded customer', async () => {
    const { container } = renderOpenItems(HAPPY, { route: customerRoute });
    await userEvent.click(await screen.findByRole('button', { name: /Muster AG/ }));
    await settled(container, 'Offen total');
    const results = await axe(container, {
      rules: { region: { enabled: false }, 'page-has-heading-one': { enabled: false } },
    });
    expect(results).toHaveNoViolations();
  });
});

// --- D-S4, the boundaries popover -----------------------------------------------------------------

describe('the Fälligkeits-Aufteilung popover', () => {
  async function openPopover(canned: Canned = HAPPY, opts: { settled?: boolean } = {}) {
    const { settled = true } = opts;
    const rendered = renderOpenItems(canned);
    await screen.findByText('R-2026-0006');
    await userEvent.click(
      screen.getByRole('button', { name: 'Aktionen für die offenen Posten' }),
    );
    await userEvent.click(screen.getByRole('menuitem', { name: 'Aufteilung nach Fälligkeit anpassen' }));
    // The popover body is skeleton-gated on `get_aging_bucket_config`, so a synchronous getBy right
    // after the dialog appears samples the skeleton under CPU starvation. Anchoring on the loaded
    // field here lets every caller query synchronously. The failed-read test opts out: its config
    // read never produces a field to wait for.
    if (settled) await screen.findByLabelText('Grenze 1');
    return rendered;
  }

  it('LOADING: proves get_aging_bucket_config went in flight before showing its skeleton', async () => {
    const transport = watchReads(async (action, input) =>
      action === 'get_aging_bucket_config'
        ? neverSettles(action, input)
        : fakeTransport(HAPPY)(action, input),
    );
    renderOpenItems(HAPPY, { transport });
    await screen.findByText('R-2026-0006');
    await userEvent.click(screen.getByRole('button', { name: 'Aktionen für die offenen Posten' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Aufteilung nach Fälligkeit anpassen' }));

    await transport.started('get_aging_bucket_config');
    const dialog = screen.getByRole('dialog', { name: 'Aufteilung nach Fälligkeit anpassen' });
    expect(within(dialog).getByRole('status')).toHaveAttribute('aria-busy', 'true');
  });

  it('says whether the boundaries are the defaults or a deliberate choice', async () => {
    await openPopover();
    const dialog = await screen.findByRole('dialog', { name: 'Aufteilung nach Fälligkeit anpassen' });
    // The recording has `configured: false`.
    expect(within(dialog).getByText('Du siehst die Standardgrenzen.')).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Grenze 1')).toHaveValue(30);
    expect(within(dialog).getByLabelText('Grenze 3')).toHaveValue(90);
  });

  it('previews the labels the current fields would produce, and states it is not a deadline', async () => {
    await openPopover();
    const dialog = await screen.findByRole('dialog', { name: 'Aufteilung nach Fälligkeit anpassen' });
    expect(
      within(dialog).getByText(
        'Ergibt: 0 bis 30 Tage, 31 bis 60 Tage, 61 bis 90 Tage, Über 90 Tage',
      ),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText(
        'Das ist eine Darstellung, keine Frist. Die Summe und die Übereinstimmung mit 1100 ändern sich nicht.',
      ),
    ).toBeInTheDocument();
    // The forbidden vocabulary is absent in this state as well.
    expect(dialog.textContent).not.toMatch(/Mahn|Verzug/);
  });

  it('caps the boundary list at five, with the reason on screen rather than on hover', async () => {
    await openPopover();
    const dialog = await screen.findByRole('dialog', { name: 'Aufteilung nach Fälligkeit anpassen' });
    const add = within(dialog).getByRole('button', { name: 'Grenze hinzufügen' });

    await userEvent.click(add);
    await userEvent.click(add);
    expect(within(dialog).getByRole('button', { name: 'Grenze hinzufügen' })).toBeDisabled();
    expect(within(dialog).getByText('Mehr als sechs Zeiträume werden unübersichtlich.')).toBeInTheDocument();
  });

  // --- prevention at the control (gate F5) --------------------------------------------------------
  //
  // The popover already computed `complete` and spent it only on the "Ergibt" preview, so an empty
  // field or a non-increasing pair went to the engine and came back refused. `set_aging_bucket_config`
  // is never called in any of the three cases below: the answer is client-side arithmetic and the
  // file's own header, the design's §5.6 and the canon all say prevent rather than submit-and-reject.

  it('does not submit an empty boundary field: Save is off and the reason is on screen', async () => {
    const saveSpy = vi.fn<CannedHandler>(() => ok());
    await openPopover({ ...HAPPY, set_aging_bucket_config: saveSpy });
    const dialog = await screen.findByRole('dialog', { name: 'Aufteilung nach Fälligkeit anpassen' });

    await userEvent.click(within(dialog).getByRole('button', { name: 'Grenze hinzufügen' }));
    expect(within(dialog).getByRole('button', { name: 'Speichern' })).toBeDisabled();
    expect(
      within(dialog).getByText('Die Grenzen müssen ganze Zahlen über null sein.'),
    ).toBeInTheDocument();
    expect(saveSpy).not.toHaveBeenCalled();
  });

  it('does not submit a non-increasing pair, and flags the field that breaks the order', async () => {
    const saveSpy = vi.fn<CannedHandler>(() => ok());
    await openPopover({ ...HAPPY, set_aging_bucket_config: saveSpy });
    const dialog = await screen.findByRole('dialog', { name: 'Aufteilung nach Fälligkeit anpassen' });

    // The recording is [30, 60, 90]. Making the second boundary 20 breaks the order at Grenze 2.
    const second = within(dialog).getByLabelText('Grenze 2');
    await userEvent.clear(second);
    await userEvent.type(second, '20');

    expect(within(dialog).getByRole('button', { name: 'Speichern' })).toBeDisabled();
    const flagged = within(dialog).getByText('Jede Grenze muss grösser sein als die davor.');
    expect(second.closest('.oi-boundary-row')).toContainElement(flagged);
    expect(second).toHaveAttribute('aria-invalid', 'true');
    expect(saveSpy).not.toHaveBeenCalled();
  });

  it('does not submit an empty boundary LIST, and says one is needed', async () => {
    const saveSpy = vi.fn<CannedHandler>(() => ok());
    await openPopover({ ...HAPPY, set_aging_bucket_config: saveSpy });
    const dialog = await screen.findByRole('dialog', { name: 'Aufteilung nach Fälligkeit anpassen' });

    for (const n of [3, 2, 1]) {
      await userEvent.click(within(dialog).getByRole('button', { name: `Grenze ${n} entfernen` }));
    }
    expect(within(dialog).getByRole('button', { name: 'Speichern' })).toBeDisabled();
    expect(within(dialog).getByText('Es braucht mindestens eine Grenze.')).toBeInTheDocument();
    expect(saveSpy).not.toHaveBeenCalled();
  });

  it('writes the boundaries with one idempotency key that a retry REUSES', async () => {
    let calls = 0;
    const saveSpy = vi.fn<CannedHandler>(() => {
      calls += 1;
      return calls === 1 ? reject('transport_error', 500) : ok();
    });
    await openPopover({ ...HAPPY, set_aging_bucket_config: saveSpy });

    const dialog = await screen.findByRole('dialog', { name: 'Aufteilung nach Fälligkeit anpassen' });
    const field = within(dialog).getByLabelText('Grenze 1');
    await userEvent.clear(field);
    await userEvent.type(field, '15');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Speichern' }));

    await waitFor(() => expect(saveSpy).toHaveBeenCalledOnce());
    expect(saveSpy.mock.calls[0][0]).toMatchObject({
      workspaceId: 'ws_test',
      boundariesDays: [15, 60, 90],
    });
    // The rejection leaves every typed value where it was.
    expect(await within(dialog).findByRole('alert')).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Grenze 1')).toHaveValue(15);

    await userEvent.click(within(dialog).getByRole('button', { name: 'Speichern' }));
    await waitFor(() => expect(saveSpy).toHaveBeenCalledTimes(2));
    const firstKey = saveSpy.mock.calls[0][0].idempotencyKey;
    expect(typeof firstKey).toBe('string');
    expect(saveSpy.mock.calls[1][0].idempotencyKey).toBe(firstKey);
  });

  // The other half of the test directly above, and the half that was missing. Reusing the key is
  // right for a retry of the SAME list and wrong for a retry of a CHANGED one, and the popover held
  // one key for its whole open regardless. `setAgingBucketConfig` fingerprints NOTHING but the key
  // (`src/core/debtors/openItems.ts`: `recallIdempotent(workspaceId, key, 'set_aging_bucket_config')`
  // runs before the boundaries are even validated), so an edited list under a recorded key is
  // answered with the FIRST list, byte-identical and with no `replayed` marker to notice. The
  // popover then calls `onSaved` and closes: the operator is told the cut they typed was saved, and
  // the tiles re-partition to the cut they typed away.
  it('mints a NEW key once the boundaries change, so a lost response cannot replay the first list', async () => {
    const sent: Array<{ boundariesDays: unknown; idempotencyKey: unknown }> = [];
    const saveSpy = vi.fn<CannedHandler>((input) => {
      sent.push({ boundariesDays: input.boundariesDays, idempotencyKey: input.idempotencyKey });
      return sent.length === 1 ? reject('transport_error', 500) : ok();
    });
    await openPopover({ ...HAPPY, set_aging_bucket_config: saveSpy });

    const dialog = await screen.findByRole('dialog', { name: 'Aufteilung nach Fälligkeit anpassen' });
    const field = within(dialog).getByLabelText('Grenze 1');
    await userEvent.clear(field);
    await userEvent.type(field, '15');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Speichern' }));
    await waitFor(() => expect(sent).toHaveLength(1));
    // The spy fires when the request goes IN FLIGHT, not when its answer has been processed:
    // Speichern is disabled while `saving` is true, and a click on a disabled button is swallowed
    // silently. Wait for the refusal round-trip to re-enable it before saving again.
    await waitFor(() =>
      expect(within(dialog).getByRole('button', { name: 'Speichern' })).toBeEnabled(),
    );

    // The write landed and the answer was lost. Reading a failure, the operator tries a different
    // first boundary rather than the same one, which is the ordinary human response to a refusal.
    await userEvent.clear(within(dialog).getByLabelText('Grenze 1'));
    await userEvent.type(within(dialog).getByLabelText('Grenze 1'), '20');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Speichern' }));
    await waitFor(() => expect(sent).toHaveLength(2));

    expect(sent.map((call) => call.boundariesDays)).toEqual([
      [15, 60, 90],
      [20, 60, 90],
    ]);
    expect(sent[1].idempotencyKey).not.toBe(sent[0].idempotencyKey);
  });

  it('maps each invalid_input expectation to its own sentence', async () => {
    await openPopover({
      ...HAPPY,
      set_aging_bucket_config: reject('invalid_input', 422, {
        expected: 'strictly increasing day counts',
      }),
    });
    const dialog = await screen.findByRole('dialog', { name: 'Aufteilung nach Fälligkeit anpassen' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Speichern' }));
    expect(
      await within(dialog).findByText('Jede Grenze muss grösser sein als die davor.'),
    ).toBeInTheDocument();
  });

  it('names the missing WRITE right when the save is denied', async () => {
    await openPopover({ ...HAPPY, set_aging_bucket_config: reject('permission_denied', 403) });
    const dialog = await screen.findByRole('dialog', { name: 'Aufteilung nach Fälligkeit anpassen' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Speichern' }));
    // A denied WRITE renders where it was attempted, never as the whole-surface padlock.
    expect(
      await within(dialog).findByText('Dir fehlt die Berechtigung, die Aufteilung nach Fälligkeit zu ändern.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Kein Zugriff' })).not.toBeInTheDocument();
  });

  it('ERROR: a failed config read says so inside the popover', async () => {
    await openPopover(
      { ...HAPPY, get_aging_bucket_config: reject('transport_error', 500) },
      { settled: false },
    );
    const dialog = await screen.findByRole('dialog', { name: 'Aufteilung nach Fälligkeit anpassen' });
    expect(
      await within(dialog).findByText('Offene Posten konnten nicht geladen werden.'),
    ).toBeInTheDocument();
  });

  it('re-reads the list after a successful save, so the tiles re-partition in place', async () => {
    let listCalls = 0;
    await openPopover({
      ...HAPPY,
      list_open_items: () => {
        listCalls += 1;
        return ok(listFixture);
      },
      set_aging_bucket_config: ok(),
    });
    const before = listCalls;
    const dialog = await screen.findByRole('dialog', { name: 'Aufteilung nach Fälligkeit anpassen' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Speichern' }));
    // BOTH halves of the end state are waited for TOGETHER, and that is the whole point.
    //
    // `onSaved` does two things in one go (`OpenItems.tsx`): it drops `?boundaries=1`, which is a
    // router state update that React has to render before the dialog leaves the tree, and it starts
    // the re-read, which dispatches `list_open_items` synchronously and therefore bumps `listCalls`
    // in the same tick, before any render happens. Waiting on the counter alone and then asserting
    // the unmount SYNCHRONOUSLY is waiting on the earlier of the two events and asserting the
    // later: under load the counter is up while the close has not been flushed, and the assertion
    // fails. Measured on this branch's parent: 22 of 24 concurrent runs red on exactly this test,
    // `expect(element).not.toBeInTheDocument()`. Asserting both inside one `waitFor` waits for the
    // end state itself instead of for a proxy of it, and adds no timeout and no sleep.
    await waitFor(() => {
      expect(listCalls).toBeGreaterThan(before);
      expect(
        screen.queryByRole('dialog', { name: 'Aufteilung nach Fälligkeit anpassen' }),
      ).not.toBeInTheDocument();
    });
  });

  // --- it is a POPOVER, which is a claim about where it is and not only about what it holds -------
  //
  // The gate's F1: the panel rendered as the last child of the surface, in normal document flow,
  // with a stylesheet that gave `.oi-popover` no `position` and no `z-index` at all. The trigger is
  // the header overflow at the top right and the panel appeared below the tiles and below the whole
  // table, so clicking the one write control on A16 changed nothing the operator could see.
  //
  // NEITHER SHIPPED HARNESS COULD EXPRESS THAT, which is why 42 green browser checks and 44 green
  // component tests passed over it. Playwright auto-scrolls a target into view before acting on it,
  // so "the flow filled the field and saved" is true of a panel a human never finds. jsdom has no
  // viewport and applies no stylesheet, so a geometric assertion here would be theatre.
  //
  // So the position is asserted in the two halves that ARE checkable, and the defect fails both:
  // the DOM half (the panel hangs off the element that holds its trigger, not off the surface root)
  // and the STYLESHEET half (that element establishes a containing block and the panel is lifted
  // out of flow above the table). Read as source, because no rule in this file is applied to the
  // jsdom tree.

  /**
   * One rule's declaration block from `OpenItems.css`, by EXACT selector.
   *
   * The `\n<selector> {` anchor is deliberate: a substring search for `.oi-popover` also finds
   * `.oi-popover-title`, and a probe that matches the neighbouring rule would report a `position`
   * this file never set.
   */
  function cssBlock(selector: string): string {
    // NOT `new URL('./OpenItems.css', import.meta.url)`, which is the obvious spelling and does not
    // work here: Vite rewrites that exact pattern into an ASSET url, so it resolves to
    // `http://localhost:3000/src/surfaces/OpenItems/OpenItems.css` and `fs` rejects it with "The
    // URL must be of scheme file" on a path that was never wrong. The sibling path is derived from
    // this file's own path instead, and the derivation is asserted rather than assumed.
    const here = fileURLToPath(import.meta.url);
    const path = here.replace(/OpenItems\.test\.tsx$/, 'OpenItems.css');
    if (path === here) throw new Error(`could not derive the stylesheet path from ${here}`);
    const css = readFileSync(path, 'utf8');
    const at = css.indexOf(`\n${selector} {`);
    if (at === -1) throw new Error(`OpenItems.css has no rule for \`${selector}\``);
    const open = css.indexOf('{', at);
    const close = css.indexOf('}', open);
    return css.slice(open + 1, close);
  }

  it('hangs off the element that holds its trigger, and the stylesheet lifts it out of flow', async () => {
    await openPopover();
    const dialog = await screen.findByRole('dialog', { name: 'Aufteilung nach Fälligkeit anpassen' });

    const anchor = dialog.closest('.oi-popover-anchor');
    expect(anchor).not.toBeNull();
    // The same element holds the overflow trigger, so the panel opens where the eye already is.
    expect(anchor?.querySelector('.overflow-menu-trigger')).not.toBeNull();

    expect(cssBlock('.oi-popover-anchor')).toMatch(/position:\s*relative/);
    const popover = cssBlock('.oi-popover');
    expect(popover).toMatch(/position:\s*absolute/);
    expect(popover).toMatch(/z-index:\s*\d+/);
  });

  it('moves focus into the panel on open', async () => {
    await openPopover();
    const dialog = await screen.findByRole('dialog', { name: 'Aufteilung nach Fälligkeit anpassen' });
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(dialog).getByRole('heading', { name: 'Aufteilung nach Fälligkeit anpassen' }),
      ),
    );
  });

  it('closes on Escape and hands focus back to the trigger', async () => {
    await openPopover();
    await screen.findByRole('dialog', { name: 'Aufteilung nach Fälligkeit anpassen' });
    await userEvent.keyboard('{Escape}');
    await waitFor(() =>
      expect(
        screen.queryByRole('dialog', { name: 'Aufteilung nach Fälligkeit anpassen' }),
      ).not.toBeInTheDocument(),
    );
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Aktionen für die offenen Posten' }),
    );
  });

  it('closes on a pointer press outside itself, and a press inside leaves it open', async () => {
    await openPopover();
    const dialog = await screen.findByRole('dialog', { name: 'Aufteilung nach Fälligkeit anpassen' });

    await userEvent.click(within(dialog).getByLabelText('Grenze 1'));
    expect(screen.getByRole('dialog', { name: 'Aufteilung nach Fälligkeit anpassen' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('heading', { name: 'Offene Posten' }));
    await waitFor(() =>
      expect(
        screen.queryByRole('dialog', { name: 'Aufteilung nach Fälligkeit anpassen' }),
      ).not.toBeInTheDocument(),
    );
  });

  it('has no axe violations on a SETTLED popover', async () => {
    const { container } = await openPopover();
    await settled(container, 'Du siehst die Standardgrenzen.');
    const results = await axe(container, {
      rules: { region: { enabled: false }, 'page-has-heading-one': { enabled: false } },
    });
    expect(results).toHaveNoViolations();
  });
});
