/**
 * A08, Auswertungen: the app-level suite for the four statements, their ten surfaces and every state.
 *
 * ANCHORED ON THE RECORDINGS, NOT ON PROSE. Every account name, statutory heading, figure and
 * reconciliation verdict below is read off the fixtures in this directory, and
 * `test/reports/studio-reports-fixture.test.mjs` pins those to the live engine VALUE for value,
 * asserts the key set exactly, and asserts the ABSENCE of the four fields a statement surface might
 * be tempted to invent. Nothing here is hand-typed: eight hand-written account names in three other
 * Studio suites were wrong against the shipped chart while every KIND matched, and on a statement
 * surface the same mistake would put a wrong statutory heading on a document a Treuhänder reads.
 *
 * AXE RUNS ON A SETTLED SURFACE, NEVER THE FIRST FRAME. Three files once shipped axe tests that
 * passed with their read hung forever, auditing a skeleton. `settled()` below is the jsdom
 * equivalent of the browser harness's `waitForPaintToSettle`: real content present AND no `aria-busy`
 * region anywhere in the container.
 *
 * EVERY LOADING TEST AWAITS `transport.started(...)` BEFORE IT ASSERTS. This surface initialises
 * `loading` to `true`, so the skeleton is on screen at the first commit, before any effect has fired:
 * an assertion made without that wait would hold over a surface that reads nothing at all.
 * `app/src/loading-state-convention.test.ts` fails the build for one that does not, and no exemption
 * is registered from here.
 *
 * NO `CurrencyPicker` IS MOUNTED, so there is no unpinned `list_exchange_rates` to hang forever. The
 * only FX-shaped fact on this surface is `baseCurrency`, which every read model carries.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { MemoryRouter } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider } from '../../app/workspace';
import { installMemoryStorage } from '../../lib/test-support';
import { neverSettles, watchReads } from '../../test-transport';
import { allowConsole } from '../../test-console';
import Reports from './index';

import trialFixture from './trial-balance.fixture.json';
import trialCompareFixture from './trial-balance.compare.fixture.json';
import trialEmptyFixture from './trial-balance.empty.fixture.json';
import trialMismatchFixture from './trial-balance.mismatch.fixture.json';
import balanceFixture from './balance-sheet.fixture.json';
import balanceEmptyFixture from './balance-sheet.empty.fixture.json';
import incomeFixture from './income-statement.fixture.json';
import incomeEmptyFixture from './income-statement.empty.fixture.json';
import ledgerFixture from './general-ledger.fixture.json';
import ledgerStillFixture from './general-ledger.no-movement.fixture.json';
import accountsFixture from './list-accounts.fixture.json';
import exportFixture from './export-statement.csv.fixture.json';

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

const reject = (error: string, status = 422, extra: Record<string, unknown> = {}): RestResponse => ({
  status,
  body: { ok: false, error, ...extra },
});

/** The workspace keeps its books in francs and closes on 31 December, like the recorded one. */
const PROFILE = ok({ profile: { baseCurrency: 'CHF', fiscalYearStart: '01-01' } });

const HAPPY: Canned = {
  get_company_profile: PROFILE,
  trial_balance: ok(trialFixture),
  balance_sheet: ok(balanceFixture),
  income_statement: ok(incomeFixture),
  general_ledger: ok(ledgerFixture),
  list_accounts: ok(accountsFixture),
  export_statement: ok(exportFixture),
  // The drawer's own reads, so opening it from a Kontoblatt line is a real drill and not a stub.
  get_entry: ok({ entry: { id: 'entry_3', date: '2026-02-03', status: 'posted', lines: [] } }),
  vat_codes: ok({ codes: [] }),
  list_cost_centers: ok({ costCenters: [] }),
};

/** The recorded period, so no test depends on the wall clock unless it says so. */
const PERIOD_QUERY = 'from=2026-01-01&to=2026-03-31';

interface RenderOptions {
  workspaceId?: string | null;
  route?: string;
  transport?: Transport;
}

function renderReports(canned: Canned = HAPPY, options: RenderOptions = {}) {
  const { workspaceId = 'ws_test', route = `/reports?${PERIOD_QUERY}`, transport } = options;
  const client = new TillClient(transport ?? fakeTransport(canned));
  return render(
    <TillClientProvider client={client}>
      <I18nProvider>
        <WorkspaceProvider initialId={workspaceId}>
          <MemoryRouter initialEntries={[route]}>
            <Reports />
          </MemoryRouter>
        </WorkspaceProvider>
      </I18nProvider>
    </TillClientProvider>,
  );
}

/** Real content on screen AND nothing still announcing itself busy. See the header note. */
async function settled(container: HTMLElement, anchor: string | RegExp): Promise<void> {
  await screen.findByText(anchor);
  await waitFor(() => {
    expect(container.querySelectorAll('[aria-busy="true"]')).toHaveLength(0);
  });
}

// --- the recordings these assertions are read off ---------------------------------------------------

/** One recorded Saldenbilanz row by account number. Throws rather than asserting against undefined. */
function trialRow(number: string) {
  const row = trialFixture.rows.find((r) => r.account.number === number);
  if (row === undefined) throw new Error(`the recording has no Saldenbilanz row ${number}`);
  return row;
}

function bilanzSection(key: string) {
  const section = balanceFixture.sections.find((s) => s.key === key);
  if (section === undefined) throw new Error(`the recording has no Bilanz section ${key}`);
  return section;
}

function erfolgSection(key: string) {
  const section = incomeFixture.sections.find((s) => s.key === key);
  if (section === undefined) throw new Error(`the recording has no Erfolgsrechnung position ${key}`);
  return section;
}

const BANK = trialRow('1020');
const UMLAUF = bilanzSection('umlaufvermoegen');
const EQUITY = bilanzSection('eigenkapital');
const PERSONAL = erfolgSection('personalaufwand');

beforeEach(() => {
  installMemoryStorage();
  // The engine hands back bytes, not a file, so the surface builds a Blob and hands it to the
  // browser. jsdom has no object-URL implementation, so the seam is stubbed rather than the
  // component being reshaped to suit the test.
  Object.defineProperty(URL, 'createObjectURL', { value: vi.fn(() => 'blob:x'), configurable: true });
  Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the recordings these assertions are read off', () => {
  // If a recording is re-captured against a different seed this fails FIRST and names the drift,
  // instead of every assertion below failing as an unexplained string mismatch.
  it('holds the shapes the four reports branch on', () => {
    expect(BANK.account.name).toBe('Bankkonto');
    expect(trialFixture.totals.openingMinor).toBe(0);
    expect(trialFixture.totals.closingMinor).toBe(0);
    expect(trialFixture.totals.debitMinor).toBe(2611500);
    expect(balanceFixture.aktivenMinor).toBe(balanceFixture.passivenMinor);
    expect(incomeFixture.reingewinnMinor).toBe(540000);
    expect(incomeFixture.sections).toHaveLength(11);
    expect(balanceFixture.sections).toHaveLength(7);
    expect(EQUITY.lines.filter((line) => line.account === null)).toHaveLength(2);
    expect(ledgerFixture.lines.length).toBeGreaterThan(0);
    expect(ledgerStillFixture.lines).toHaveLength(0);
    expect(ledgerStillFixture.openingMinor).not.toBe(0);
    expect(trialMismatchFixture.reconciliation.debitEqualsCredit).toBe(false);
  });
});

// --- R-S1, the shell -------------------------------------------------------------------------------

describe('R-S1, the Auswertungen shell', () => {
  it('offers four tabs, spelling Saldenbilanz and Bilanz out in full', async () => {
    renderReports();
    const tabs = await screen.findAllByRole('tab');
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      'Saldenbilanz',
      'Bilanz',
      'Erfolgsrechnung',
      'Kontoblatt',
    ]);
    // The naming trap: "Bilanz" alone is the balance sheet and "Saldenbilanz" is not a Bilanz at
    // all. They sit in one tab set, so neither may ever be abbreviated to the other.
    expect(tabs[0].textContent).not.toBe('Bilanz');
  });

  it('states the currency once, from the payload, and never as a prefix on a row', async () => {
    const { container } = renderReports();
    await settled(container, 'Alle Beträge in CHF');
    const cells = container.querySelectorAll('.rp-money');
    expect(cells.length).toBeGreaterThan(10);
    expect(screen.getAllByText('Alle Beträge in CHF')).toHaveLength(1);
  });

  it('LOADING: renders a skeleton shaped by the tab, with no figure and no verdict', async () => {
    const transport = watchReads(neverSettles);
    const { container } = renderReports(HAPPY, { transport });
    // Proof the read really went in flight: the skeleton is this surface's FIRST-COMMIT state, so an
    // assertion made without this wait would hold over a surface that asks the engine for nothing.
    await transport.started('trial_balance');

    expect(screen.getByRole('status')).toHaveAttribute('aria-busy', 'true');
    // The canon's data-honesty rule applied literally: an unavailable figure renders as nothing.
    expect(container.querySelectorAll('.rp-money')).toHaveLength(0);
    expect(screen.queryByText('CHF 0.00')).toBeNull();
    expect(screen.queryByText(/Stimmt mit dem Journal/)).toBeNull();
  });

  it('ERROR: shows the banner with a retry and renders no figure at all', async () => {
    const transport = watchReads(fakeTransport({ ...HAPPY, trial_balance: reject('internal', 500) }));
    const { container } = renderReports(HAPPY, { transport });
    await screen.findByText('Die Auswertung konnte nicht geladen werden.');
    expect(container.querySelectorAll('.rp-money')).toHaveLength(0);
    expect(screen.queryByText(/Stimmt mit dem Journal/)).toBeNull();
    // K-35: a failed READ carries the read context (its title never asks to check input).
    expect(screen.getByRole('alert')).toHaveAttribute('data-context', 'read');

    await userEvent.click(screen.getByRole('button', { name: 'Erneut versuchen' }));
    await waitFor(() => {
      expect(transport.asked.filter((a) => a === 'trial_balance').length).toBeGreaterThanOrEqual(2);
    });
  });

  it('needs_chart is its own state, with a route into A01, and the tabs stay live', async () => {
    renderReports({ ...HAPPY, trial_balance: reject('needs_chart') });
    await screen.findByText(/Dein Arbeitsbereich hat noch keinen Kontenplan/);
    expect(screen.getByRole('link', { name: 'Kontenplan öffnen' })).toHaveAttribute('href', '/accounts');
    // Not the transport banner: the answer is the same on all four reports, so switching is free.
    expect(screen.queryByText('Die Auswertung konnte nicht geladen werden.')).toBeNull();
    expect(screen.getAllByRole('tab')).toHaveLength(4);
  });

  it('a denied READ is the padlock, and no control is shown and then rejected', async () => {
    renderReports({ ...HAPPY, trial_balance: reject('permission_denied', 403) });
    await screen.findByText('Dir fehlt die Berechtigung, Auswertungen zu sehen.');
    expect(screen.queryByRole('tab')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Als PDF exportieren' })).toBeNull();
  });

  it('with no workspace it routes to setup rather than rendering a zero statement', async () => {
    renderReports(HAPPY, { workspaceId: null });
    expect(await screen.findByText(/Richte zuerst einen Arbeitsbereich ein/)).toBeInTheDocument();
    expect(screen.queryByText('CHF 0.00')).toBeNull();
  });

  it('R15: an inverted period is refused at the toolbar and no read is issued', async () => {
    const transport = watchReads(fakeTransport(HAPPY));
    renderReports(HAPPY, { transport, route: '/reports?from=2026-03-31&to=2026-01-01' });
    await screen.findByText('Das Enddatum liegt vor dem Startdatum.');
    // The engine's `invalid_period` is unreachable from this surface: it was never asked.
    expect(transport.asked).not.toContain('trial_balance');
  });

  it('R16: a malformed date in the URL names itself inline and falls back to the default period', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-31T10:00:00.000Z'));
    const transport = watchReads(fakeTransport(HAPPY));
    renderReports(HAPPY, { transport, route: '/reports?from=nonsense&to=2026-03-31' });
    vi.useRealTimers();

    await screen.findByText('Das ist kein gültiges Datum. Format: TT.MM.JJJJ.');
    // A hand-edited URL never blanks the screen: the report still renders, over the default window.
    await screen.findByText(BANK.account.name);
  });

  it('R37: the period survives a tab switch, and the Bilanz Stichtag defaults to the period end', async () => {
    const seen: Record<string, unknown>[] = [];
    renderReports({
      ...HAPPY,
      balance_sheet: (input) => {
        seen.push(input);
        return ok(balanceFixture);
      },
    });
    await screen.findByText(BANK.account.name);
    await userEvent.click(screen.getByRole('tab', { name: 'Bilanz' }));
    await waitFor(() => expect(seen.length).toBeGreaterThan(0));
    expect(seen[0].asOf).toBe('2026-03-31');
  });
});

// --- R-S2, the Saldenbilanz ------------------------------------------------------------------------

describe('R-S2, the Saldenbilanz', () => {
  it('renders every recorded row with its full account name, never abbreviated', async () => {
    const { container } = renderReports();
    await settled(container, BANK.account.name);
    for (const row of trialFixture.rows) {
      expect(screen.getByText(row.account.name)).toBeInTheDocument();
    }
  });

  it('renders the engine class headers with a DASH where the bucket carries no opening (F6)', async () => {
    const { container } = renderReports();
    await settled(container, BANK.account.name);
    for (const group of trialFixture.groups) {
      expect(screen.getByRole('button', { name: new RegExp(group.labels.de) })).toBeInTheDocument();
    }
    // A dash beside three real figures is honest; a computed fourth would be the browser doing
    // arithmetic on money.
    expect(screen.getAllByText('Keine Eröffnung').length).toBe(trialFixture.groups.length);
  });

  it('the Total row is 0.00 in both balance columns, and says why rather than looking broken', async () => {
    const { container } = renderReports();
    await settled(container, BANK.account.name);
    const foot = container.querySelector('tfoot');
    expect(foot).not.toBeNull();
    const figures = [...(foot?.querySelectorAll('.rp-money') ?? [])].map((cell) => cell.textContent);
    expect(figures).toEqual(["CHF 0.00", "CHF 26'115.00", "CHF 26'115.00", 'CHF 0.00']);
    expect(within(foot as HTMLElement).getByRole('button', { name: 'Warum hier null steht' })).toBeInTheDocument();
  });

  it('R27: a row drills to that ACCOUNT s Kontoblatt for the same period, not to an entry', async () => {
    const seen: Record<string, unknown>[] = [];
    const { container } = renderReports({
      ...HAPPY,
      general_ledger: (input) => {
        seen.push(input);
        return ok(ledgerFixture);
      },
    });
    await settled(container, BANK.account.name);
    await userEvent.click(
      screen.getByRole('button', { name: `Kontoblatt für ${BANK.account.number} ${BANK.account.name} öffnen` }),
    );
    await waitFor(() => expect(seen.length).toBeGreaterThan(0));
    expect(seen[0].accountId).toBe(BANK.account.id);
    // The period does not change under the operator.
    expect(seen[0].periodStart).toBe('2026-01-01');
    expect(seen[0].periodEnd).toBe('2026-03-31');
  });

  it('R12: an empty Saldenbilanz is a panel with its own copy, not an empty table', async () => {
    const { container } = renderReports({ ...HAPPY, trial_balance: ok(trialEmptyFixture) });
    await settled(container, /Sobald du buchst/);
    expect(container.querySelector('table')).toBeNull();
    expect(screen.getByRole('link', { name: 'Buchung erfassen' })).toHaveAttribute('href', '/journal');
    // The Bilanz's zero-structure copy is a different fact and must not appear here.
    expect(screen.queryByText(/Die Gliederung steht trotzdem/)).toBeNull();
    expect(screen.queryByText(/Keine Daten/)).toBeNull();
  });

  it('a class section collapses and keeps its three subtotals on screen', async () => {
    const { container } = renderReports();
    await settled(container, BANK.account.name);
    const header = screen.getByRole('button', { name: /Aktiven/ });
    expect(header).toHaveAttribute('aria-expanded', 'true');
    await userEvent.click(header);
    expect(header).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText(BANK.account.name)).toBeNull();
    // The collapsed section still states what it holds.
    expect(within(header.closest('tr') as HTMLElement).getAllByText(/^CHF/).length).toBe(3);
  });

  it('has no axe violations once the read has settled', async () => {
    const { container } = renderReports();
    await settled(container, BANK.account.name);
    expect(await axe(container)).toHaveNoViolations();
  });
});

// --- R-S7, the comparison preset -------------------------------------------------------------------

describe('R-S7, the comparison control', () => {
  it('offers four presets and never a pair of date fields', async () => {
    const { container } = renderReports();
    await settled(container, BANK.account.name);
    await userEvent.click(screen.getByLabelText('Vergleich'));
    // Options portal to <body>; read each option's label span (the selected row also holds an
    // aria-hidden check glyph, which the label span excludes).
    expect(screen.getAllByRole('option').map((o) => o.querySelector('.select-option-label')?.textContent)).toEqual([
      'kein',
      'Vorperiode',
      'Vorjahr',
      // G13: the Vorsystem comparative, drawn from the prior-system archive and labelled at the
      // column header; still a preset, never a pair of date fields.
      'Vorsystem (Archiv)',
    ]);
    // F3: `compareTo.periodStart` is discarded by the engine, so no field ever asks for it.
    expect(screen.queryByLabelText(/Vergleich von/)).toBeNull();
  });

  it('sends a computed compareTo and names the actual DATE in the column header', async () => {
    const seen: Record<string, unknown>[] = [];
    const { container } = renderReports({
      ...HAPPY,
      trial_balance: (input) => {
        seen.push(input);
        return ok(input.compareTo === undefined ? trialFixture : trialCompareFixture);
      },
    });
    await settled(container, BANK.account.name);
    await userEvent.click(screen.getByLabelText('Vergleich'));
    await userEvent.click(screen.getAllByRole('option').find((o) => o.getAttribute('data-value') === 'year')!);

    await waitFor(() => expect(seen.length).toBeGreaterThan(1));
    expect(seen[seen.length - 1].compareTo).toEqual({ periodStart: '2025-01-01', periodEnd: '2025-03-31' });
    // The header names the date the ENGINE echoed back, never the preset and never the date the
    // surface asked for: the figure is a cumulative closing balance, and calling the column "Vorjahr"
    // would be exactly the confusion F3 describes.
    const echoed = trialCompareFixture.compareTo.end;
    expect(echoed).toBe('2025-12-31');
    expect(await screen.findByText('Saldo per 31.12.2025')).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Vorjahr' })).toBeNull();
  });
});

// --- R-S3, the Bilanz ------------------------------------------------------------------------------

describe('R-S3, the Bilanz', () => {
  const renderBalance = (canned: Canned = HAPPY) =>
    renderReports(canned, { route: `/reports?report=balance&${PERIOD_QUERY}&asOf=2026-03-31` });

  it('renders all seven statutory sections in the engine s own words', async () => {
    const { container } = renderBalance();
    await settled(container, UMLAUF.labels.de);
    for (const section of balanceFixture.sections) {
      expect(screen.getByText(section.labels.de)).toBeInTheDocument();
    }
    // Both grand totals on one footer row, where the identity they assert is visible at a glance.
    expect(screen.getAllByText("CHF 43'465.00")).toHaveLength(2);
  });

  it('R22: the OR Art. 959a coverage note is on its face, and claims nothing it cannot', async () => {
    const { container } = renderBalance();
    await settled(container, UMLAUF.labels.de);
    expect(
      screen.getByText(
        'Die Abschnitte sind Gruppierungen über deinen Kontenplan, nicht die Positionsnamen von OR Art. 959a.',
      ),
    ).toBeInTheDocument();
    // The banned words, each of which would claim something no check performed.
    for (const word of ['geprüft', 'korrekt', 'verifiziert', 'OR-konform', 'revisionssicher']) {
      expect(container.textContent?.toLowerCase()).not.toContain(word.toLowerCase());
    }
    expect(container.textContent).not.toContain('Mindestgliederung');
  });

  it('R11 and R22: at zero the structure still renders AND the coverage note is still there', async () => {
    const { container } = renderBalance({ ...HAPPY, balance_sheet: ok(balanceEmptyFixture) });
    await settled(container, /Die Gliederung steht trotzdem/);
    for (const section of balanceEmptyFixture.sections) {
      expect(screen.getByText(section.labels.de)).toBeInTheDocument();
    }
    expect(screen.getByText(/Die Abschnitte sind Gruppierungen/)).toBeInTheDocument();
    // The reconciliation still renders in the empty state: 0 equals 0, and an absent line would read
    // as "we did not check", which is a different and worse claim.
    expect(screen.getByText(/Aktiven und Passiven stimmen überein/)).toBeInTheDocument();
    expect(screen.queryByText(/Keine Daten/)).toBeNull();
  });

  it('R29: the two computed equity lines carry their position names and NO affordance', async () => {
    const { container } = renderBalance();
    await settled(container, UMLAUF.labels.de);
    const computed = EQUITY.lines.filter((line) => line.account === null);
    for (const line of computed) {
      const name = (line as { labels: { de: string } }).labels.de;
      expect(screen.getByText(name)).toBeInTheDocument();
      // Never the raw key, and never the "als Minusposten" drafting wording.
      expect(screen.queryByText(line.key)).toBeNull();
    }
    expect(container.textContent).not.toContain('als Minusposten');
    // Nothing on screen suggests a drill that would return an empty or wrong entry list.
    expect(screen.queryByRole('button', { name: /Kontoblatt für ergebnisvortrag/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Kontoblatt für jahresergebnis/ })).toBeNull();
  });

  it('R38: an account line drills to the fiscal year ENDING at the Stichtag', async () => {
    const seen: Record<string, unknown>[] = [];
    const line = UMLAUF.lines[0];
    const { container } = renderBalance({
      ...HAPPY,
      general_ledger: (input) => {
        seen.push(input);
        return ok(ledgerFixture);
      },
    });
    await settled(container, UMLAUF.labels.de);
    await userEvent.click(
      screen.getByRole('button', {
        name: `Kontoblatt für ${line.account?.number ?? ''} ${line.account?.name ?? ''} öffnen`,
      }),
    );
    await waitFor(() => expect(seen.length).toBeGreaterThan(0));
    // Ending at `asOf` is what makes the figure clicked equal the figure landed on.
    expect(seen[0].periodEnd).toBe('2026-03-31');
    expect(seen[0].periodStart).toBe('2026-01-01');
  });

  it('has no axe violations once the read has settled', async () => {
    const { container } = renderBalance();
    await settled(container, UMLAUF.labels.de);
    expect(await axe(container)).toHaveNoViolations();
  });
});

// --- R-S4, the Erfolgsrechnung ---------------------------------------------------------------------

describe('R-S4, the Erfolgsrechnung', () => {
  const renderIncome = (canned: Canned = HAPPY) =>
    renderReports(canned, { route: `/reports?report=income&${PERIOD_QUERY}` });

  it('renders all eleven positions, including the longest statutory heading, unabbreviated', async () => {
    const { container } = renderIncome();
    await settled(container, PERSONAL.labels.de);
    for (const section of incomeFixture.sections) {
      expect(screen.getByText(section.labels.de)).toBeInTheDocument();
    }
    // The A08 UX design calls this heading 129 characters; measured off `sections.ts` it is 104.
    // The count is wrong and the ARGUMENT is not: 104 characters still cannot sit in a fixed label
    // column, which is why this statement is a wrapping list rather than a table.
    const longest = incomeFixture.sections.map((s) => s.labels.de).sort((a, b) => b.length - a.length)[0];
    expect(longest.length).toBe(104);
    expect(longest.startsWith('Bestandesänderungen an unfertigen')).toBe(true);
    expect(container.textContent).toContain(longest);
    expect(container.textContent).not.toContain('…');
  });

  it('R1/INV-4: figures are SIGNED contribution to profit, and the visible column sums to the result', async () => {
    const { container } = renderIncome();
    await settled(container, PERSONAL.labels.de);
    // The engine's `personalaufwand` is negative; a flipped display would render it positive.
    expect(PERSONAL.subtotalMinor).toBeLessThan(0);
    expect(screen.getByText("CHF -6'000.00")).toBeInTheDocument();
    expect(screen.getByText('Jahresgewinn')).toBeInTheDocument();
    expect(screen.getByText("CHF 5'400.00")).toBeInTheDocument();
    // Argument 1 for the convention, asserted rather than argued: the rows add to the total.
    const sum = incomeFixture.sections.reduce((n, s) => n + s.subtotalMinor, 0);
    expect(sum).toBe(incomeFixture.reingewinnMinor);
  });

  it('a loss renders as a negative figure under the word Jahresverlust, never as an absolute value', async () => {
    const loss = {
      ...incomeFixture,
      reingewinnMinor: -540000,
      sections: incomeFixture.sections.map((s) =>
        s.key === 'netto_erloese' ? { ...s, subtotalMinor: 390000, lines: [] } : s,
      ),
    };
    const { container } = renderIncome({ ...HAPPY, income_statement: ok(loss) });
    await settled(container, 'Jahresverlust');
    expect(screen.getByText("CHF -5'400.00")).toBeInTheDocument();
    expect(screen.queryByText('Jahresgewinn')).toBeNull();
    // The word and the sign carry it, so a grayscale printout reads what the screen reads.
    expect(container.querySelector('.rp-result--loss')).not.toBeNull();
  });

  it('a position expands in place and its account lines drill to the SAME period', async () => {
    const seen: Record<string, unknown>[] = [];
    const line = PERSONAL.lines[0];
    const { container } = renderIncome({
      ...HAPPY,
      general_ledger: (input) => {
        seen.push(input);
        return ok(ledgerFixture);
      },
    });
    await settled(container, PERSONAL.labels.de);
    // Exact: the G17 citation glyph beside the heading also carries the position name in ITS
    // accessible name ("Rechtsgrundlage zu Personalaufwand"), and the collapse is the bare label.
    const heading = screen.getByRole('button', { name: new RegExp(`^${PERSONAL.labels.de}$`) });
    expect(heading).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(heading);
    expect(heading).toHaveAttribute('aria-expanded', 'true');

    await userEvent.click(
      screen.getByRole('button', { name: `Kontoblatt für ${line.account.number} ${line.account.name} öffnen` }),
    );
    await waitFor(() => expect(seen.length).toBeGreaterThan(0));
    expect(seen[0].periodStart).toBe('2026-01-01');
    expect(seen[0].periodEnd).toBe('2026-03-31');
  });

  it('R11: at zero every position still renders with its result at 0.00', async () => {
    const { container } = renderIncome({ ...HAPPY, income_statement: ok(incomeEmptyFixture) });
    await settled(container, /Die Gliederung steht trotzdem/);
    expect(screen.getAllByText('CHF 0.00').length).toBeGreaterThanOrEqual(11);
    // Exactly zero keeps the enacted form WHOLE, the way `erfolgsrechnungResultLabel` does: a book
    // that broke even made neither a Gewinn nor a Verlust, so neither single word is available and
    // the `oder` is a statement of fact rather than an unresolved choice.
    expect(screen.getByText('Jahresgewinn oder Jahresverlust')).toBeInTheDocument();
    expect(screen.queryByText('Jahresgewinn')).toBeNull();
  });

  it('has no axe violations once the read has settled', async () => {
    const { container } = renderIncome();
    await settled(container, PERSONAL.labels.de);
    expect(await axe(container)).toHaveNoViolations();
  });
});

// --- R-S5 and R-S6, the Kontoblatt and its picker ---------------------------------------------------

describe('R-S5, the Kontoblatt', () => {
  const LEDGER_ROUTE = `/reports?report=ledger&${PERIOD_QUERY}&account=${ledgerFixture.account.id}`;
  const renderLedger = (canned: Canned = HAPPY) => renderReports(canned, { route: LEDGER_ROUTE });

  it('renders the opening carry, every line with its running balance, and the closing balance', async () => {
    const { container } = renderLedger();
    await settled(container, 'Eröffnungssaldo');
    expect(screen.getByText('Schlusssaldo')).toBeInTheDocument();
    expect(screen.getByText("CHF 20'000.00")).toBeInTheDocument();
    const last = ledgerFixture.lines[ledgerFixture.lines.length - 1];
    // The last line's running balance IS the stated Schlusssaldo, which is R4's acceptance.
    expect(last.runningMinor).toBe(ledgerFixture.closingMinor);
    expect(screen.getAllByText("CHF 17'955.00").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('4 Zeilen')).toBeInTheDocument();
  });

  it('renders `manual` as nothing at all, and would render a close line as Abschluss', async () => {
    const { container } = renderLedger();
    await settled(container, 'Eröffnungssaldo');
    expect(container.textContent).not.toContain('Manuell');
    expect(container.textContent).not.toContain('manual');

    const withClose = {
      ...ledgerFixture,
      lines: [{ ...ledgerFixture.lines[0], source: 'close', description: 'Abschluss 2026' }],
    };
    const second = renderReports({ ...HAPPY, general_ledger: ok(withClose) }, { route: LEDGER_ROUTE });
    await settled(second.container, 'Eröffnungssaldo');
    expect(within(second.container).getAllByText('Abschluss').length).toBeGreaterThanOrEqual(1);
    // The closed-year note fires off the same fact the operator can see on the line.
    expect(within(second.container).getByText(/In dieser Periode liegt eine Abschlussbuchung/)).toBeInTheDocument();
  });

  it('R13: no movement keeps both balance rows and never says the account is empty', async () => {
    const { container } = renderReports(
      { ...HAPPY, general_ledger: ok(ledgerStillFixture) },
      { route: `/reports?report=ledger&${PERIOD_QUERY}&account=${ledgerStillFixture.account.id}` },
    );
    await settled(container, /hat sich auf diesem Konto nichts bewegt/);
    expect(screen.getByText('Eröffnungssaldo')).toBeInTheDocument();
    expect(screen.getByText('Schlusssaldo')).toBeInTheDocument();
    expect(screen.getAllByText("CHF -10'000.00").length).toBe(2);
    expect(screen.queryByText(/Keine Daten/)).toBeNull();
    expect(screen.getByText('0 Zeilen')).toBeInTheDocument();
  });

  it('R28: a line opens A02 s EntryDrawer in place rather than linking to an unfiltered journal', async () => {
    const transport = watchReads(fakeTransport(HAPPY));
    const { container } = renderReports(HAPPY, { transport, route: LEDGER_ROUTE });
    await settled(container, 'Eröffnungssaldo');
    const first = ledgerFixture.lines[0];
    await userEvent.click(
      screen.getByRole('button', { name: new RegExp(first.description ?? '') }),
    );
    await waitFor(() => expect(transport.asked).toContain('get_entry'));
    // Finding F5: `/journal` reads no query parameter, so a link there would be a dead end with
    // extra steps. There is no such link on this surface.
    expect(container.querySelector('a[href="/journal"]')).toBeNull();
  });

  it('R26: the row count is stated and no control implies a pagination the engine lacks', async () => {
    const { container } = renderLedger();
    await settled(container, 'Eröffnungssaldo');
    expect(screen.getByText('4 Zeilen')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Mehr laden|Weitere Zeilen|Nächste Seite/ })).toBeNull();
    expect(container.textContent).not.toContain('Seite 1');
    expect(screen.queryByRole('navigation')).toBeNull();
  });

  it('has no axe violations once the read has settled', async () => {
    const { container } = renderLedger();
    await settled(container, 'Eröffnungssaldo');
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('R-S6, the account picker', () => {
  const PICKER_ROUTE = `/reports?report=ledger&${PERIOD_QUERY}`;

  it('opens by itself when no account is chosen, and the body says what to do', async () => {
    const { container } = renderReports(HAPPY, { route: PICKER_ROUTE });
    await settled(container, /Wähl ein Konto/);
    expect(screen.getByLabelText('Konto suchen')).toBeInTheDocument();
  });

  it('LOADING: renders skeleton rows inside the open picker, never a blank popover', async () => {
    const transport = watchReads(
      (action, input) =>
        action === 'list_accounts' ? neverSettles(action, input) : fakeTransport(HAPPY)(action, input),
    );
    renderReports(HAPPY, { transport, route: PICKER_ROUTE });
    // The picker's own read, proved in flight before the skeleton is claimed to be a load.
    await transport.started('list_accounts');
    const statuses = await screen.findAllByRole('status');
    expect(statuses.some((node) => node.getAttribute('aria-busy') === 'true')).toBe(true);
  });

  it('R41: a failed account list stays INSIDE the picker and leaves the report alone', async () => {
    const { container } = renderReports(
      { ...HAPPY, list_accounts: reject('internal', 500) },
      { route: `${PICKER_ROUTE}&account=${ledgerFixture.account.id}&picker=1` },
    );
    await settled(container, 'Die Konten konnten nicht geladen werden.');
    // The Kontoblatt that loaded fine is untouched.
    expect(screen.getByText('Eröffnungssaldo')).toBeInTheDocument();
    expect(screen.queryByText('Die Auswertung konnte nicht geladen werden.')).toBeNull();
  });

  it('R42: a search that matches nothing has its own copy and its own way out', async () => {
    const { container } = renderReports(HAPPY, { route: PICKER_ROUTE });
    await settled(container, /Wähl ein Konto/);
    await userEvent.type(screen.getByLabelText('Konto suchen'), 'zzzz');
    expect(await screen.findByText('Kein Konto passt zu dieser Suche.')).toBeInTheDocument();
    // Distinct from anything claiming the chart is empty.
    expect(screen.queryByText(/hat noch keinen Kontenplan/)).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Suche löschen' }));
    expect(screen.queryByText('Kein Konto passt zu dieser Suche.')).toBeNull();
  });

  it('picks by seeing the row, and the id never reaches the screen', async () => {
    const seen: Record<string, unknown>[] = [];
    const { container } = renderReports(
      {
        ...HAPPY,
        general_ledger: (input) => {
          seen.push(input);
          return ok(ledgerFixture);
        },
      },
      { route: PICKER_ROUTE },
    );
    await settled(container, /Wähl ein Konto/);
    const target = accountsFixture.accounts.find((a) => a.number === ledgerFixture.account.number);
    await userEvent.click(screen.getByRole('button', { name: new RegExp(`${target?.name ?? ''}$`) }));
    await waitFor(() => expect(seen.length).toBeGreaterThan(0));
    expect(seen[0].accountId).toBe(ledgerFixture.account.id);
    expect(container.textContent).not.toContain(ledgerFixture.account.id);
  });

  it('R17: a stale ?account= names the problem in the picker, not in the error banner', async () => {
    const { container } = renderReports(
      { ...HAPPY, general_ledger: reject('not_found', 404) },
      { route: `${PICKER_ROUTE}&account=acc_gone` },
    );
    await settled(container, /Dieses Konto gibt es in deinem Kontenplan nicht mehr/);
    expect(screen.queryByText('Die Auswertung konnte nicht geladen werden.')).toBeNull();
    expect(screen.getByLabelText('Konto suchen')).toBeInTheDocument();
  });

  it('hides archived accounts behind the shipped toggle rather than inventing a second answer', async () => {
    const archived = {
      accounts: accountsFixture.accounts.map((a) =>
        a.number === '1000' ? { ...a, archived: true } : a,
      ),
    };
    const { container } = renderReports({ ...HAPPY, list_accounts: ok(archived) }, { route: PICKER_ROUTE });
    await settled(container, /Wähl ein Konto/);
    const hidden = accountsFixture.accounts.find((a) => a.number === '1000');
    expect(screen.queryByText(hidden?.name ?? '')).toBeNull();
    await userEvent.click(screen.getByLabelText('Archivierte anzeigen'));
    expect(await screen.findByText(hidden?.name ?? '')).toBeInTheDocument();
    expect(screen.getByText('Archiviert')).toBeInTheDocument();
  });

  it('has no axe violations once the picker has settled', async () => {
    const { container } = renderReports(HAPPY, { route: PICKER_ROUTE });
    await settled(container, /Wähl ein Konto/);
    expect(await axe(container)).toHaveNoViolations();
  });
});

// --- R-S8, the export ------------------------------------------------------------------------------

describe('R-S8, the export', () => {
  it('is one click for PDF, with CSV in the overflow, and states the PDF/A truth beside it', async () => {
    const { container } = renderReports();
    await settled(container, BANK.account.name);
    expect(screen.getByRole('button', { name: 'Als PDF exportieren' })).toBeEnabled();
    expect(screen.getByText('Das PDF ist eine Druckdatei, kein PDF/A.')).toBeInTheDocument();
    // The words the engine's `pdfaProfile: null` forbids.
    expect(container.textContent).not.toContain('archivierungssicher');
    expect(container.textContent).not.toContain('revisionssicher');
  });

  it('forwards the EXACT parameters the screen used, compareTo included (R32)', async () => {
    // A real download really is a navigation, and jsdom has none. The message is the environment
    // saying so, not the surface misbehaving: the assertions below are about the REQUEST.
    allowConsole(/Not implemented: navigation/);
    const seen: Record<string, unknown>[] = [];
    const { container } = renderReports({
      ...HAPPY,
      trial_balance: (input) => ok(input.compareTo === undefined ? trialFixture : trialCompareFixture),
      export_statement: (input) => {
        seen.push(input);
        return ok(exportFixture);
      },
    });
    await settled(container, BANK.account.name);
    await userEvent.click(screen.getByLabelText('Vergleich'));
    await userEvent.click(screen.getAllByRole('option').find((o) => o.getAttribute('data-value') === 'period')!);
    await screen.findByText(/Saldo per/);
    await userEvent.click(screen.getByRole('button', { name: 'Als PDF exportieren' }));

    await waitFor(() => expect(seen.length).toBe(1));
    expect(seen[0].kind).toBe('trial');
    expect(seen[0].format).toBe('pdf');
    expect(seen[0].periodStart).toBe('2026-01-01');
    expect(seen[0].periodEnd).toBe('2026-03-31');
    // The comparison on screen rides into the file: one parameter set, so the two cannot disagree.
    // "Vorperiode" is the window of EQUAL LENGTH immediately before, which for a 90-day Q1 ends the
    // day before it starts and runs back 90 days. Not the calendar prior quarter: the engine reads
    // only `periodEnd` here anyway (F3), and equal length is what the preset promises.
    expect(seen[0].compareTo).toEqual({ periodStart: '2025-10-03', periodEnd: '2025-12-31' });
  });

  it('saves under the ENGINE s filename and never one this surface built', async () => {
    allowConsole(/Not implemented: navigation/);
    const clicks: string[] = [];
    const realCreate = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const node = realCreate(tag);
      if (tag === 'a') {
        node.addEventListener('click', () => clicks.push((node as HTMLAnchorElement).download));
      }
      return node;
    });

    const { container } = renderReports();
    await settled(container, BANK.account.name);
    await userEvent.click(screen.getByRole('button', { name: 'Als PDF exportieren' }));
    await waitFor(() => expect(clicks).toEqual([exportFixture.artifact.filename]));
    expect(clicks[0]).toBe('saldenbilanz-2026-01-01-bis-2026-03-31.csv');
    vi.restoreAllMocks();
  });

  it('R30: on the Kontoblatt with no account it is disabled and the reason is INLINE', async () => {
    const { container } = renderReports(HAPPY, { route: `/reports?report=ledger&${PERIOD_QUERY}` });
    await settled(container, /Wähl ein Konto/);
    expect(screen.getByRole('button', { name: 'Als PDF exportieren' })).toBeDisabled();
    // Beside the control, never a hover-only tooltip (D15/C3).
    expect(
      screen.getByText('Wähl zuerst ein Konto, dann kannst du das Kontoblatt exportieren.'),
    ).toBeInTheDocument();
  });

  it('R31: a failed export renders beside the control with a retry, and starts no download', async () => {
    const clicks: string[] = [];
    const realCreate = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const node = realCreate(tag);
      if (tag === 'a') node.addEventListener('click', () => clicks.push('download'));
      return node;
    });

    const { container } = renderReports({ ...HAPPY, export_statement: reject('internal', 500) });
    await settled(container, BANK.account.name);
    await userEvent.click(screen.getByRole('button', { name: 'Als PDF exportieren' }));
    expect(
      await screen.findByText('Die Datei konnte nicht erstellt werden. Es wurde nichts heruntergeladen.'),
    ).toBeInTheDocument();
    expect(clicks).toEqual([]);
    expect(screen.getAllByRole('button', { name: 'Erneut versuchen' }).length).toBeGreaterThan(0);
    vi.restoreAllMocks();
  });

  it('is NOT blocked when a check fails, because the file states the same verdict', async () => {
    const { container } = renderReports({ ...HAPPY, trial_balance: ok(trialMismatchFixture) });
    await settled(container, /Diese Auswertung stimmt nicht/);
    expect(screen.getByRole('button', { name: 'Als PDF exportieren' })).toBeEnabled();
  });
});

// --- R-S9, the reconciliation ----------------------------------------------------------------------

describe('R-S9, the reconciliation', () => {
  it('R21: the passing state is a comparison that held, quiet, and promises nothing more', async () => {
    const { container } = renderReports();
    await settled(container, BANK.account.name);
    expect(screen.getByText('Stimmt mit dem Journal überein')).toBeInTheDocument();
    // Glyph AND words: never colour-only, never glyph-only.
    expect(container.querySelector('.rp-reconciled-glyph')).not.toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Was die Abstimmung prüft' }));
    expect(
      await screen.findByText(/Es prüft nicht, ob ein Konto im richtigen Abschnitt steht/),
    ).toBeInTheDocument();
  });

  it('R20: a failing check is named individually, with what it means and where to look', async () => {
    const { container } = renderReports({ ...HAPPY, trial_balance: ok(trialMismatchFixture) });
    await settled(container, /Diese Auswertung stimmt nicht/);
    expect(screen.getByText(/Soll und Haben sind nicht gleich/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Journal öffnen' })).toHaveAttribute('href', '/journal');
    // The passing line is REPLACED, not recoloured: one status, one place, one treatment.
    expect(screen.queryByText('Stimmt mit dem Journal überein')).toBeNull();
    // The figures still render: they are the truth about the rows.
    expect(screen.getByText(BANK.account.name)).toBeInTheDocument();
  });

  it('two different Bilanz failures do not report the same thing', async () => {
    const bucketing = {
      ...balanceFixture,
      reconciles: false,
      reconciliation: { aktivenEqualPassiven: false, ledgerNetsToZero: true, everyAccountClassifiedOnce: true },
    };
    const corrupt = {
      ...balanceFixture,
      reconciles: false,
      reconciliation: { aktivenEqualPassiven: true, ledgerNetsToZero: false, everyAccountClassifiedOnce: true },
    };
    const route = `/reports?report=balance&${PERIOD_QUERY}&asOf=2026-03-31`;

    const first = renderReports({ ...HAPPY, balance_sheet: ok(bucketing) }, { route });
    await settled(first.container, /Diese Auswertung stimmt nicht/);
    expect(within(first.container).getByText(/Das ist ein Fehler in der Zuordnung der Konten/)).toBeInTheDocument();

    const second = renderReports({ ...HAPPY, balance_sheet: ok(corrupt) }, { route });
    await settled(second.container, /Diese Auswertung stimmt nicht/);
    expect(within(second.container).getByText(/Das betrifft die Datenbank selbst/)).toBeInTheDocument();
  });
});
