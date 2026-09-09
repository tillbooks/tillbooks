/**
 * The EntryDrawer in a workspace whose books are NOT kept in francs.
 *
 * THE DEFECT THIS EXISTS FOR. `formatMoney(minor, currency = 'CHF')` defaults its currency, and six
 * calls in this drawer took the default: the two balance totals, the unbalanced difference, the
 * base half of the FX disclosure, and the two figures in the VAT reconciliation refusal. On the
 * overwhelmingly common Swiss workspace that is invisible, which is exactly how the same default
 * reached a posted EUR invoice and printed `Total MWST CHF 81.00` over a franc VAT of 76.24.
 *
 * A workspace's base currency is a SETTING (`workspace.base_currency`; `CURRENCIES` admits CHF, EUR
 * and USD), so "the books are Swiss" is not a defence and a hardcoded `CHF` here would be the same
 * bug relocated. The drawer composes an entry with no currency of its own, so `postEntry` books it
 * in `baseCurrencyOf(ctx)`, and the honest label for every previewed figure is the workspace base
 * currency the engine reports through `get_company_profile`.
 *
 * Every engine answer below comes from `../../i18n/format-money-currency.fixture.json`, pinned arm
 * by arm to the live engine by `test/format-money/format-money-currency-fixture.test.mjs`. The
 * scenario is a EUR-base workspace holding one posted USD entry, so a mislabel is wrong in both the
 * number and the unit: USD 1'000.00 books EUR 860.00, and the CHF default prints neither.
 *
 * The view-mode case is not the same bug twice. The drawer's `get_company_profile` read was gated on
 * `editable`, so a POSTED foreign entry, the one arm where the FX note renders at all, never asked
 * for the base currency and fell back to the initial CHF. The read is unconditional now.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

import Journal from './index';
import { TillClient, type Transport, type RestResponse } from '../../lib/client';
import { TillClientProvider } from '../../lib/client-context';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider } from '../../app/workspace';
import { watchReads, neverSettles } from '../../test-transport';
import fixture from '../../i18n/format-money-currency.fixture.json';
import listAccountsFixture from '../Accounts/list-accounts.fixture.json';

type Handler = RestResponse | ((input: Record<string, unknown>) => RestResponse | Promise<RestResponse>);
type Handlers = Record<string, Handler>;

const ok = (data: Record<string, unknown>): RestResponse => ({ status: 200, body: { ok: true, ...data } });

/** `get_company_profile` exactly as the engine answers it for the fixture's EUR-base workspace. */
const PROFILE: RestResponse = ok({ profile: fixture.profile });

/**
 * The two rows the drawer's picker offers, taken off the recording of the live `list_accounts`
 * answer rather than typed (`Bank` and `Ertrag` are not names in the shipped KMU chart; 1020 is
 * `Bankkonto` and 3200 is `Erlöse aus Handelswaren`). Only the id is overridden, because these rows
 * have to match the account ids the posted-entry fixture already carries.
 */
function recorded(number: string, id: string) {
  const row = listAccountsFixture.accounts.find((account) => account.number === number);
  if (row === undefined) throw new Error(`the recorded chart has no account ${number}`);
  return { ...row, id };
}

const ACCOUNTS: RestResponse = ok({
  accounts: [
    recorded('1020', fixture.lines[0].account),
    recorded('3200', fixture.lines[1].account),
  ],
});

/** The pickers a create/edit drawer reads, plus the profile read that names the base currency. */
const READS: Handlers = {
  list_accounts: ACCOUNTS,
  vat_codes: ok({ taxCodes: [] }),
  list_cost_centers: ok({ costCenters: [] }),
  get_company_profile: PROFILE,
};

/** The journal row the posted USD entry appears as, so the drawer can be opened from the list. */
const LIST_ROW = {
  id: fixture.entry.id,
  date: fixture.entry.date,
  ref: fixture.entry.ref,
  description: fixture.entry.description,
  status: fixture.entry.status,
  source: fixture.entry.source,
  reversesEntryId: null,
  total: fixture.lines[0].debit,
  currency: fixture.transactionCurrency,
};

function renderJournal(handlers: Handlers) {
  const base: Transport = async (action, input) => {
    const h = handlers[action];
    if (h === undefined) return { status: 404, body: { ok: false, error: 'unknown_action' } };
    return typeof h === 'function' ? h(input) : h;
  };
  const transport = watchReads(base);
  const utils = render(
    <TillClientProvider client={new TillClient(transport)}>
      <I18nProvider initialLocale="en">
        <WorkspaceProvider initialId="ws_test">
          <MemoryRouter>
            <Journal />
          </MemoryRouter>
        </WorkspaceProvider>
      </I18nProvider>
    </TillClientProvider>,
  );
  return { ...utils, transport };
}

/** Open a blank compose drawer: the mode where the balance panel and the VAT refusal render. */
async function openCompose(extra: Handlers = {}) {
  const { transport } = renderJournal({
    list_journal: ok({ entries: [] }),
    ...READS,
    ...extra,
  });
  await userEvent.click(await screen.findByRole('button', { name: 'New entry' }));
  return { dialog: await screen.findByRole('dialog'), transport };
}

/** Open the posted USD entry in view mode: the mode where the FX disclosure renders. */
async function openPosted(extra: Handlers = {}) {
  const { transport } = renderJournal({
    list_journal: ok({ entries: [LIST_ROW] }),
    ...READS,
    get_entry: ok({ entry: fixture.entry, lines: fixture.lines }),
    ...extra,
  });
  const table = await screen.findByRole('table');
  await userEvent.click(within(table).getByRole('button', { name: /Open entry B-901/ }));
  return { dialog: await screen.findByRole('dialog'), transport };
}


/** F-03 (J3.7): the account field is a typeable combobox; pick by typing the number, then Enter. */
async function pickAccount(field: HTMLElement, id: string) {
  const row = listAccountsFixture.accounts.find((a) => a.id === id);
  if (row === undefined) throw new Error(`the recorded chart has no account ${id}`);
  await userEvent.clear(field);
  await userEvent.type(field, row.number);
  await userEvent.keyboard('{Enter}');
}
/** Type a balanced pair of amounts into the two composing lines. */
async function typeBalanced(dialog: HTMLElement, amount: string) {
  await pickAccount(await within(dialog).findByLabelText('Account 1'), fixture.lines[0].account);
  await pickAccount(within(dialog).getByLabelText('Account 2'), fixture.lines[1].account);
  await userEvent.type(within(dialog).getByLabelText('Debit 1'), amount);
  await userEvent.type(within(dialog).getByLabelText('Credit 2'), amount);
}

describe('EntryDrawer, the base currency is a setting and not a synonym for CHF', () => {
  it('LOADING: a VIEW drawer asks for the base currency too, not only an editable one', async () => {
    // The read used to sit behind `if (editable)`, so this arm never issued it and the FX note below
    // was labelled from the initial CHF. Hanging THIS action while every other read answers is what
    // separates "the drawer asks late" from "the drawer never asks in this mode".
    const { dialog, transport } = await openPosted({
      get_company_profile: (input) => neverSettles('get_company_profile', input),
    });
    await transport.started('get_company_profile');
    expect(within(dialog).getByRole('status')).toHaveAttribute('aria-busy', 'true');
    expect(transport.asked).toContain('get_entry');
  });

  it('COMPOSE: the balance totals carry the workspace base currency, never a defaulted CHF', async () => {
    const { dialog } = await openCompose();
    await typeBalanced(dialog, '1000.00');

    // EUR 1'000.00 twice: the debit total and the credit total. The defect printed CHF for both, on
    // a figure that will post into books kept in euros.
    await waitFor(() => expect(within(dialog).getAllByText("EUR 1'000.00")).toHaveLength(2));
    expect(within(dialog).queryByText("CHF 1'000.00")).toBeNull();
    expect(fixture.baseCurrency).toBe('EUR');
  });

  it('COMPOSE: the unbalanced difference is denominated too, in the same base currency', async () => {
    const { dialog } = await openCompose();
    await pickAccount(await within(dialog).findByLabelText('Account 1'), fixture.lines[0].account);
    await pickAccount(within(dialog).getByLabelText('Account 2'), fixture.lines[1].account);
    await userEvent.type(within(dialog).getByLabelText('Debit 1'), '1000.00');
    await userEvent.type(within(dialog).getByLabelText('Credit 2'), '860.00');

    // A bare "140.00" would be a number with no unit; "CHF 140.00" is a unit this book never uses.
    expect(await within(dialog).findByText('Debits and credits differ by EUR 140.00.')).toBeInTheDocument();
    expect(within(dialog).queryByText(/differ by CHF/)).toBeNull();
  });

  it('COMPOSE: the VAT reconciliation refusal names both figures in the base currency', async () => {
    const { dialog } = await openCompose({
      post_entry: {
        status: 422,
        body: { ok: false, error: 'vat_trace_unreconciled', expectedMinor: 8100, bookedMinor: 7624 },
      },
    });
    await typeBalanced(dialog, '1000.00');
    await userEvent.click(await within(dialog).findByRole('button', { name: 'Post' }));

    // These two are the ORIGINAL defect's own numbers, 81.00 against 76.24, in the panel that
    // reports them. The drawer posts with no currency, so the engine books in the base currency and
    // both figures are euros here.
    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent('add up to EUR 81.00');
    expect(alert).toHaveTextContent('VAT accounts book EUR 76.24');
    expect(alert.textContent ?? '').not.toMatch(/CHF/);
  });

  it('VIEW: the FX disclosure books a USD entry into EUR, and says EUR', async () => {
    const { dialog } = await openPosted();

    // The transaction amounts stay in the currency the lines carry.
    expect(await within(dialog).findAllByText("USD 1'000.00")).toHaveLength(2);
    // And the base half of the note is denominated by the LINE that carries the figure, not by a
    // second read. `get_entry` sends `baseCurrency` beside `baseDebit` now (the fixture pins it).
    expect(
      within(dialog).getByText("Foreign currency: USD 1'000.00 at rate 0.86 is EUR 860.00 in the books."),
    ).toBeInTheDocument();
    expect(within(dialog).queryByText(/CHF 860\.00/)).toBeNull();
    expect(fixture.lines[0].baseDebit).toBe(86000);
    expect(fixture.lines[0].baseCurrency).toBe('EUR');
  });

  it('VIEW: the FX note is labelled by the LINE that carries the figure, not by the profile read', async () => {
    // The discriminating case: the profile answers the OLD wrong label while the entry's own lines
    // say EUR. Both sources agree in reality (the engine locks `workspace.base_currency` the moment
    // anything posts), so only a disagreement can show which one the drawer actually reads. The
    // response that carries the number is the one that gets to name its unit.
    const { dialog } = await openPosted({
      get_company_profile: ok({ profile: { ...fixture.profile, baseCurrency: 'CHF' } }),
    });
    expect(
      await within(dialog).findByText("Foreign currency: USD 1'000.00 at rate 0.86 is EUR 860.00 in the books."),
    ).toBeInTheDocument();
    expect(within(dialog).queryByText(/CHF 860\.00/)).toBeNull();
  });

  it('VIEW: a line with no baseCurrency of its own still falls back to the profile, never to CHF', async () => {
    // The engine sends the field unconditionally, so this arm is for a response that predates it or
    // a client-composed row. The fallback is the profile, which is the workspace base currency, and
    // a hardcoded CHF here would be the original defect surviving in the one branch no engine
    // fixture reaches.
    const stripped = fixture.lines.map(({ baseCurrency: _drop, ...rest }) => rest);
    const { dialog } = await openPosted({ get_entry: ok({ entry: fixture.entry, lines: stripped }) });
    expect(
      await within(dialog).findByText("Foreign currency: USD 1'000.00 at rate 0.86 is EUR 860.00 in the books."),
    ).toBeInTheDocument();
    expect(within(dialog).queryByText(/CHF 860\.00/)).toBeNull();
  });

  it('VIEW: a line with no currency of its own falls back to the BASE currency, not to CHF', async () => {
    // `journal_line.currency` is `TEXT NOT NULL` with no default, so the engine cannot send this;
    // the TYPE allows it (`currency?: string | null`) for a client-composed row that has never been
    // near the engine. Such a row would post in `baseCurrencyOf(ctx)`, so that is what it is worth,
    // and a hardcoded CHF fallback here would be the whole defect surviving in the one branch no
    // engine fixture can reach.
    const stripped = fixture.lines.map((l) => ({ ...l, currency: null }));
    const { dialog } = await openPosted({ get_entry: ok({ entry: fixture.entry, lines: stripped }) });
    expect(await within(dialog).findAllByText("EUR 1'000.00")).toHaveLength(2);
    expect(within(dialog).queryByText("CHF 1'000.00")).toBeNull();
  });

  it('VIEW: nothing in the whole drawer claims francs for a book kept in euros', async () => {
    const { dialog } = await openPosted();
    await within(dialog).findAllByText("USD 1'000.00");
    // The broad sweep the per-figure assertions above cannot make: not one CHF anywhere on screen.
    expect(dialog.textContent ?? '').not.toMatch(/CHF/);
  });

  it('falls back to CHF only when the profile read fails, never over an answer the engine gave', async () => {
    // A failed profile read leaves the initial value rather than blanking every label: a drawer that
    // cannot name its currency is worse than one naming the common one, and the engine still owns
    // the posting either way. The point is that the fallback is a FALLBACK, not the source of truth.
    const { dialog } = await openCompose({
      get_company_profile: { status: 500, body: { ok: false, error: 'internal' } },
    });
    await typeBalanced(dialog, '1000.00');
    await waitFor(() => expect(within(dialog).getAllByText("CHF 1'000.00")).toHaveLength(2));
  });
});
