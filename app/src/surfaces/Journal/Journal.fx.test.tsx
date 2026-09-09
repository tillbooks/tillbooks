/**
 * The journal list's currency context: what a row's total is denominated IN, and what the books hold.
 *
 * THE DEFECT THIS EXISTS FOR. `list_journal`'s `total` is `SUM(debit_minor)`, the TRANSACTION
 * amount, and the read model sent no currency beside it, so this column rendered every figure under
 * a hardcoded `CHF`: a EUR entry appeared as francs it was never worth. The surface carried a
 * written KNOWN GAP instead of a workaround, because the two workarounds available to a client
 * (guess the currency, or fire a `get_entry` per row and convert) are the client inventing money.
 * The engine now sends `currency`, and `baseTotal` / `fxRate` / `baseCurrency` where a conversion
 * really happened, so the gap closes at the read model and the comment is gone.
 *
 * Every entry body comes from `journal-list-fx.fixture.json`, pinned arm by arm to the live
 * `list_journal` by `test/ledger/journal-list-fx-fixture.test.mjs`. Nothing in this file types a
 * response shape by hand: four Studio defects in this repo shipped from a key the engine never sent.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { axe } from 'jest-axe';

import Journal from './index';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { TillClientProvider } from '../../lib/client-context';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider } from '../../app/workspace';
import { neverSettles, watchReads } from '../../test-transport';
import { listedBaseTotal } from './money';
import type { JournalEntry } from './types';
import fx from './journal-list-fx.fixture.json';

type Canned = Record<string, RestResponse>;

const ok = (data: Record<string, unknown> = {}): RestResponse => ({ status: 200, body: { ok: true, ...data } });
const reject = (error: string, status = 422): RestResponse => ({ status, body: { ok: false, error } });

function fakeTransport(canned: Canned): Transport {
  return async (action) => canned[action] ?? { status: 404, body: { ok: false, error: 'unknown_action' } };
}

function tree(client: TillClient, locale: 'en' | 'de-CH' = 'en') {
  return (
    <TillClientProvider client={client}>
      <I18nProvider initialLocale={locale}>
        <WorkspaceProvider initialId="ws_test">
          <MemoryRouter>
            <Journal />
          </MemoryRouter>
        </WorkspaceProvider>
      </I18nProvider>
    </TillClientProvider>
  );
}

function renderList(canned: Canned, locale: 'en' | 'de-CH' = 'en') {
  return render(tree(new TillClient(fakeTransport(canned)), locale));
}

/** Every arm the engine can send, in one list, which is how a real mixed-currency ledger reads. */
const MIXED = (): Canned => ({
  list_journal: ok({
    entries: [
      fx.postedForeign,
      fx.postedBase,
      fx.postedPegged,
      fx.draft,
      fx.emptyDraft,
      fx.postedRounding,
      fx.foreignUnposted,
    ],
  }),
});

const rowFor = (ref: string) => screen.getByRole('row', { name: new RegExp(ref) });

describe('Journal list, currency context', () => {
  it('LOADING: shows the skeleton only once the journal read is genuinely in flight', async () => {
    const transport = watchReads(neverSettles);
    render(tree(new TillClient(transport)));
    // `loading` is the INITIAL state, so the skeleton is on screen before any effect fires: without
    // waiting for the read this could not tell a load in flight from a load that never started.
    await transport.started('list_journal');
    expect(screen.getByRole('status')).toHaveAttribute('aria-busy', 'true');
    expect(screen.queryByText(/CHF|EUR|USD/)).not.toBeInTheDocument();
  });

  it('EMPTY: an empty journal shows no figures and no stray currency labels', async () => {
    renderList({ list_journal: ok({ entries: [] }) });
    expect(await screen.findByText('No entries yet.')).toBeInTheDocument();
    expect(screen.queryByText(/CHF|EUR|USD/)).not.toBeInTheDocument();
  });

  it('ERROR: a failed list read shows the banner and no figures', async () => {
    renderList({ list_journal: reject('invalid_input') });
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.queryByText(/EUR/)).not.toBeInTheDocument();
  });

  it('DENIED: a refused list shows the permission state, never a row', async () => {
    renderList({ list_journal: reject('permission_denied', 403) });
    expect(await screen.findByRole('heading', { name: 'No access' })).toBeInTheDocument();
    expect(screen.queryByText(/1'621\.50/)).not.toBeInTheDocument();
  });

  it('SUCCESS: every row names the currency its own total is in, never a hardcoded CHF', async () => {
    renderList(MIXED());
    await screen.findByText('B-101');
    // The defect, precisely: this row used to read "CHF 1'621.50" for EUR 1'621.50.
    expect(within(rowFor('B-101')).getByText("EUR 1'621.50")).toBeInTheDocument();
    expect(within(rowFor('B-101')).queryByText("CHF 1'621.50")).not.toBeInTheDocument();
    expect(within(rowFor('B-102')).getByText("CHF 1'500.00")).toBeInTheDocument();
    expect(within(rowFor('B-103')).getByText('USD 70.00')).toBeInTheDocument();
  });

  it('adds the base-currency total on a posted foreign row, as the ENGINE sends it', async () => {
    renderList(MIXED());
    await screen.findByText('B-101');
    const row = rowFor('B-101');
    // Read off the pinned fixture rather than typed as a literal: this figure is the sum of the
    // posted rows' base debits, and if the engine stops sending it the drift guard fails first.
    expect(fx.postedForeign.baseTotal).toBe(152616);
    expect(within(row).getByText("CHF 1'526.16")).toBeInTheDocument();
    // Both readings of the same money live in the one amount cell, so the two are read together.
    const amountCell = within(row).getByText("EUR 1'621.50").closest('td') as HTMLElement;
    expect(within(amountCell).getByText("CHF 1'526.16")).toBeInTheDocument();
  });

  it('NEVER multiplies the rate out: the printed francs are the ledger figure, not total x rate', async () => {
    renderList(MIXED());
    await screen.findByText('B-106');
    const row = rowFor('B-106');
    // GBP 1.00 at 1.005. The ledger converts in exact scaled integers, rounds half away from zero,
    // and posts CHF 1.01; `100 * 1.005` in binary floating point is 100.49999999999999 and rounds
    // DOWN to CHF 1.00. This row is in the fixture for exactly this reason: on the EUR row at 0.9412
    // the shortcut and the ledger agree, so a client that computed the figure itself would print the
    // right number there and this assertion would prove nothing. Here it prints the wrong one.
    expect(fx.postedRounding.baseTotal).toBe(101);
    expect(Math.round(fx.postedRounding.total * Number(fx.postedRounding.fxRate))).toBe(100);
    expect(within(row).getByText('CHF 1.01')).toBeInTheDocument();
    expect(within(row).queryByText('CHF 1.00')).not.toBeInTheDocument();
    expect(within(row).getByText('GBP 1.00')).toBeInTheDocument();
    // And the rate stays a STRING all the way through: parsing it to a number here is the first
    // step of doing the arithmetic the client must not do.
    expect(typeof listedBaseTotal(fx.postedRounding)?.fxRate).toBe('string');
  });

  it('adds nothing to a FOREIGN row with nothing posted, whose figures arrive as two nulls', async () => {
    renderList(MIXED());
    await screen.findByText('B-107');
    const row = rowFor('B-107');
    // The arm that breaks an "all three keys or none" guard: `baseCurrency` is a string while
    // `baseTotal` and `fxRate` are both null. Keyed on the currency alone this row would print
    // "EUR 0.00", a figure the books have never held. `listedBaseTotal` checks all three at RUNTIME.
    expect(fx.foreignUnposted.baseCurrency).toBe('EUR');
    expect(fx.foreignUnposted.baseTotal).toBeNull();
    expect(listedBaseTotal(fx.foreignUnposted)).toBeNull();
    expect(within(row).getByText('CHF 42.00')).toBeInTheDocument();
    expect(within(row).queryByText(/EUR/)).not.toBeInTheDocument();
    expect(within(row).queryByText('In the books')).not.toBeInTheDocument();
  });

  it('adds nothing to a base-currency row, which would be the same number twice', async () => {
    renderList(MIXED());
    await screen.findByText('B-102');
    // The engine sends no FX group at all here, and restating CHF 1'500.00 as a CHF base total
    // beside itself is noise on the overwhelming majority of entries.
    expect(within(rowFor('B-102')).getAllByText("CHF 1'500.00").length).toBe(1);
    // The absence IS the assertion, and it is the one arm TypeScript objects to on its own:
    // `listedBaseTotal` takes a weak type (all three keys optional), and an argument sharing no
    // property with a weak type is TS2559. Naming the row as the `JournalEntry` it is answers that
    // without a cast, and buys the check the file's header asks for: the recording now has to
    // satisfy the read model the Studio declares, arm 1 of `JournalEntryFx` included.
    const postedBase: JournalEntry = fx.postedBase;
    expect(listedBaseTotal(postedBase)).toBeNull();
  });

  it('still shows the base total at parity, where the two figures coincide', async () => {
    renderList(MIXED());
    await screen.findByText('B-103');
    const row = rowFor('B-103');
    // The rate is 1, so the numbers match. Going quiet here would make a pegged foreign entry
    // indistinguishable from a franc one, which is the disclosure §H-FX exists to prevent.
    expect(fx.postedPegged.fxRate).toBe('1');
    expect(within(row).getByText('USD 70.00')).toBeInTheDocument();
    expect(within(row).getByText('CHF 70.00')).toBeInTheDocument();
  });

  it('labels a DRAFT total too: the label is unconditional, only the conversion is not', async () => {
    renderList(MIXED());
    await screen.findByText('B-104');
    const row = rowFor('B-104');
    expect(within(row).getByText('CHF 42.00')).toBeInTheDocument();
    expect(within(row).getAllByText(/CHF/).length).toBe(1);
  });

  it('renders NO money at all for an entry with no lines, rather than a denominated zero', async () => {
    renderList(MIXED());
    await screen.findByText('B-105');
    const row = rowFor('B-105');
    // The engine reports `currency: null` because a currency is a property of the ROWS and there are
    // none. "CHF 0.00" here would be the client making exactly the guess this change removed.
    expect(fx.emptyDraft.currency).toBeNull();
    expect(within(row).queryByText(/CHF|EUR|USD/)).not.toBeInTheDocument();
    expect(within(row).queryByText('0.00')).not.toBeInTheDocument();
  });

  it('reads the second figure out to a screen reader as a booked amount, not a bare number', async () => {
    const { container } = renderList(MIXED());
    await screen.findByText('B-101');
    expect(within(rowFor('B-101')).getByText('In the books')).toBeInTheDocument();
    const results = await axe(container, {
      rules: { region: { enabled: false }, 'page-has-heading-one': { enabled: false } },
    });
    expect(results).toHaveNoViolations();
  });

  it('says it in de-CH with a REAL umlaut, never Buechern and never a sharp s', async () => {
    renderList(MIXED(), 'de-CH');
    await screen.findByText('B-101');
    const row = rowFor('B-101');
    const text = row.textContent ?? '';
    // The label reuses the drawer's own wording ("... ergibt {base} in den Büchern") rather than
    // "Gebucht", which is already this row's posted STATUS word: a screen reader would otherwise
    // hear the same word twice in one row meaning two different things.
    expect(within(row).getByText('In den Büchern')).toBeInTheDocument();
    expect(text).toContain('Büchern');
    // Targeted, not a blanket /ue|oe|ae/ scan: "Manuell" legitimately carries a `ue` that is not a
    // substituted umlaut, so a blanket regex would fail on correct copy and teach nothing.
    expect(text).not.toMatch(/Buechern|Buecher/);
    expect(text).not.toContain('ß');
    expect(within(row).getByText("EUR 1'621.50")).toBeInTheDocument();
  });
});
