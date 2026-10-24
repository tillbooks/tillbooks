import { describe, it, expect, vi } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { axe } from 'jest-axe';

import { useLocation } from 'react-router-dom';
import Journal from './index';
import { EntryDrawer } from './EntryDrawer';
import { TillClient, type Transport, type RestResponse } from '../../lib/client';
import { TillClientProvider } from '../../lib/client-context';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider } from '../../app/workspace';
import { watchReads } from '../../test-transport';
import { cannedOk, recordedOk } from '../../lib/test-support';

type Handler = RestResponse | ((input: Record<string, unknown>) => RestResponse | Promise<RestResponse>);
type Handlers = Record<string, Handler>;

/**
 * The chart the per-line account picker is filled from is a RECORDING of the live `list_accounts`
 * answer (`test/accounts/capture-studio-list-accounts.mjs`), pinned by
 * `test/accounts/studio-list-accounts-fixture.test.mjs`.
 *
 * It used to be three hand-typed rows, and all three names were wrong: `Kasse` for `Kassenbestand`,
 * `Büromaterial` for `Verwaltungs- und Bürokosten`, `Umsatzsteuer` for `Geschuldete MWST auf
 * Erlösen`. A fixture more generous, or merely different, than the engine is what let the Studio
 * render `${account.number} ${account.label}` as "1000 undefined" for a whole release.
 */
import listAccountsFixture from '../Accounts/list-accounts.fixture.json';
import { consequenceSentence } from '../../lib/approval-tiers';

const ACCOUNTS: RestResponse = { status: 200, body: recordedOk(listAccountsFixture) };

/** An account row from the recording, by its number. Throws rather than rendering `undefined`. */
function account(number: string) {
  const row = listAccountsFixture.accounts.find((a) => a.number === number);
  if (row === undefined) throw new Error(`the recorded chart has no account ${number}`);
  return row;
}

/** The three the drawer cases post against: cash, an expense, and the output-VAT account. */
const KASSE = account('1000').id;
const BUERO = account('6500').id;
const UST = account('2200').id;

/**
 * F-03 (J3.7): the account field is a typeable combobox. Picking an account is what a bookkeeper
 * does: type its number, press Enter. `id` is the recorded account id the assertions compare on.
 */
async function pickAccount(field: HTMLElement, id: string) {
  const row = listAccountsFixture.accounts.find((a) => a.id === id);
  if (row === undefined) throw new Error(`the recorded chart has no account ${id}`);
  await userEvent.clear(field);
  await userEvent.type(field, row.number);
  await userEvent.keyboard('{Enter}');
}

/**
 * A1: the MWST control is the typeable `TaxCodeCombobox` (a picker button over a portaled listbox).
 * Open it and pick the option that carries the code; '' picks "Without VAT".
 */
async function pickVat(trigger: HTMLElement, code: string) {
  await userEvent.click(trigger);
  const options = await screen.findAllByRole('option');
  const option =
    code === ''
      ? options.find((o) => (o.textContent ?? '').includes('Without VAT'))
      : options.find((o) => o.querySelector('.combobox__code')?.textContent === code);
  if (option === undefined) throw new Error(`the tax code list offers no ${code || 'Without VAT'}`);
  await userEvent.click(option);
}

/** The codes an open MWST list offers, by their code chip. */
function offeredCodes(): string[] {
  return screen.getAllByRole('option').map((o) => o.querySelector('.combobox__code')?.textContent ?? '').filter((c) => c !== '');
}

/** A1 "Aufteilen": the Buchungssatz becomes the line grid, where every line names itself ("Debit 1"). */
async function openGrid(dialog: HTMLElement) {
  await userEvent.click(await within(dialog).findByRole('button', { name: 'Split' }));
  await within(dialog).findByLabelText('Account 1');
}

/** A1: one Buchungssatz, Soll an Haben, one gross amount. */
async function fillSatz(dialog: HTMLElement, debitId: string, creditId: string, amount: string) {
  await pickAccount(await within(dialog).findByLabelText('Debit'), debitId);
  await pickAccount(within(dialog).getByLabelText('Credit'), creditId);
  await userEvent.type(within(dialog).getByLabelText('Amount'), amount);
}

const TAX_CODES: RestResponse = {
  status: 200,
  body: {
    ok: true,
    taxCodes: [
      { code: 'UST81', kind: 'output', rateBp: 810, formLine: '303', label: 'Umsatzsteuer 8.1%', active: true },
      { code: 'IMPORT', kind: 'import', rateBp: 0, formLine: '400', label: 'Einfuhrsteuer', active: true },
    ],
  },
};

// The composer's lines, captions and verdict are the REAL engine's (D152 amendment): `compose_entry` is
// answered by `composeEngine`, so no stand-in in this suite derives a VAT figure of its own.
import { composeEngine } from '../../../test-support/composeEngine';

const COMPOSE = composeEngine();

const COST_CENTERS: RestResponse = {
  status: 200,
  body: { ok: true, costCenters: [{ id: 'cc_1', code: 'K1', name: 'Vertrieb' }] },
};

/** The picker reads a create/edit drawer always needs. */
const PICKERS: Handlers = {
  list_accounts: ACCOUNTS,
  vat_codes: TAX_CODES,
  list_cost_centers: COST_CENTERS,
  compose_entry: COMPOSE,
};

function renderJournal(handlers: Handlers, opts: { locale?: 'en' | 'de-CH'; initialId?: string | null; path?: string } = {}) {
  const { locale = 'en', initialId = 'ws_test', path = '/journal' } = opts;
  const calls: { action: string; input: Record<string, unknown> }[] = [];
  const base: Transport = async (action, input) => {
    calls.push({ action, input });
    const h = handlers[action];
    // E00: the entry drawer mounts the shared LinkedFiles panel, which reads files_list_linked on
    // open. A test that does not care about attachments should not have to stub it: default an
    // unstubbed read to the empty-list body the engine sends for a record with no files, so the panel
    // renders its empty state and adds no loading/error banner that races the status/alert assertions.
    if (h === undefined && action === 'files_list_linked') return { status: 200, body: { ok: true, files: [] } };
    if (h === undefined) return { status: 404, body: { ok: false, error: 'unknown_action' } };
    return typeof h === 'function' ? h(input) : h;
  };
  // Wrapped so a loading test can await `transport.started(...)`: `calls` records what was asked,
  // but only a wait can tell a read in flight apart from one that never left.
  const transport = watchReads(base);
  const client = new TillClient(transport);
  const utils = render(
    <TillClientProvider client={client}>
      <I18nProvider initialLocale={locale}>
        <WorkspaceProvider initialId={initialId}>
          <MemoryRouter initialEntries={[path]}>
            <Journal />
            <LocationProbe />
          </MemoryRouter>
        </WorkspaceProvider>
      </I18nProvider>
    </TillClientProvider>,
  );
  return { ...utils, calls, transport };
}

/** The router's current search, on screen for the deep-link tests (the param must leave on close). */
function LocationProbe() {
  const location = useLocation();
  return <span data-testid="location-search">{location.search}</span>;
}

/**
 * Render the drawer DIRECTLY, driving `canPost` through the prop that actually gates it.
 *
 * The two suites below used to reach this state by handing `renderJournal` a `list_journal` body
 * with `canPost: false` on it. That response does not exist: `grep -rn canPost src/` finds nothing,
 * the engine has never sent the field, and `Journal.tsx` read it as `body.canPost !== false`, so an
 * absent field meant `undefined !== false` and the gate was open in every build that ever shipped.
 * The fixtures were the only things in the entire system that ever made `canPost` false, which is
 * why they went green over a gate that has never once fired: a hand-written double agreeing with
 * the surface by construction, the exact failure `cannedOk` exists to stop.
 *
 * Overloading `client.call` on the declared action names turned that read into TS2339 and it is
 * gone. What these tests assert is unchanged and still worth asserting: GIVEN the actor lacks the
 * post capability, the drawer pre-disables its write controls. That is a statement about the
 * drawer, so it is made against the drawer's own prop. Where production should get the answer is
 * A24's decision and A24 is unbuilt (`allowAllCapabilities`), so nothing here presumes one.
 */
function renderDrawer(handlers: Handlers, opts: { canPost?: boolean } = {}) {
  const { canPost = true } = opts;
  const transport: Transport = async (action, input) => {
    const h = handlers[action];
    // E00: default the LinkedFiles read to an empty list when unstubbed (see renderJournal above).
    if (h === undefined && action === 'files_list_linked') return { status: 200, body: { ok: true, files: [] } };
    if (h === undefined) return { status: 404, body: { ok: false, error: 'unknown_action' } };
    return typeof h === 'function' ? h(input) : h;
  };
  return render(
    <TillClientProvider client={new TillClient(transport)}>
      <I18nProvider initialLocale="en">
        <WorkspaceProvider initialId="ws_test">
          <MemoryRouter>
            <EntryDrawer mode="create" canPost={canPost} onClose={() => {}} onWritten={() => {}} />
          </MemoryRouter>
        </WorkspaceProvider>
      </I18nProvider>
    </TillClientProvider>,
  );
}

/**
 * A `list_journal` row as the ENGINE sends one.
 *
 * `currency` is not decoration: `total` is the TRANSACTION amount, and the list renders no money for
 * a row that does not say what its number is denominated in. This helper used to omit it, which is
 * how the surface came to render every figure under a hardcoded CHF in the first place. The FX arms
 * are exercised against the engine-pinned fixture in `Journal.fx.test.tsx`.
 */
function postedEntry(over: Record<string, unknown> = {}) {
  return {
    id: 'je_1',
    date: '2026-03-31',
    ref: 'B-100',
    description: 'Büromaterial bar bezahlt',
    status: 'posted',
    source: 'manual',
    reversesEntryId: null,
    total: 5000,
    currency: 'CHF',
    ...over,
  };
}

describe('Journal, five states', () => {
  it('renders the loading skeleton while the journal read is in flight', async () => {
    const { transport } = renderJournal({ list_journal: () => new Promise<RestResponse>(() => {}) });
    // `loading` starts true, so the skeleton is up before any effect fires. Without this wait the
    // test would pass just as happily over a surface that had stopped reading the journal at all.
    await transport.started('list_journal');
    expect(screen.getByRole('status')).toHaveAttribute('aria-busy', 'true');
  });

  it('renders the empty state with the first-entry action', async () => {
    renderJournal({ list_journal: { status: 200, body: { ok: true, entries: [] } } });
    expect(await screen.findByText('No entries yet.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Record your first entry' })).toBeInTheDocument();
  });

  it('renders the no-workspace state, not an empty journal with a CTA that cannot work', async () => {
    const list = vi.fn<() => RestResponse>(() => ({ status: 200, body: { ok: true, entries: [] } }));
    renderJournal({ list_journal: () => list() }, { initialId: null });

    // It used to short-circuit a null workspace into an ok-with-no-entries, which painted "no
    // entries yet" plus a "record your first entry" button whose composer could never post.
    expect(await screen.findByText(/journal belongs to a workspace/i)).toBeInTheDocument();
    expect(screen.queryByText('No entries yet.')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Record your first entry' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New entry' })).not.toBeInTheDocument();

    // The way out is a real link to the surface that fixes it, and no ctx verb was called.
    expect(screen.getByRole('link', { name: 'Set up a workspace' })).toHaveAttribute('href', '/setup');
    expect(list).not.toHaveBeenCalled();
  });

  it('renders the error state from a real engine Err code, with retry', async () => {
    const list = vi.fn<() => RestResponse>(() => ({
      status: 422,
      body: { ok: false, error: 'workspace_not_found' },
    }));
    renderJournal({ list_journal: () => list() });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The selected workspace could not be found.');
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
  });

  it('renders the success list: money via formatMoney, status text, and no edit-posted affordance', async () => {
    const { container } = renderJournal({
      list_journal: { status: 200, body: { ok: true, entries: [postedEntry()] } },
    });
    const table = await screen.findByRole('table');
    const row = within(table).getByRole('row', { name: /B-100/ });
    expect(within(row).getByText('CHF 50.00')).toBeInTheDocument();
    expect(within(row).getByText('31.03.2026')).toBeInTheDocument();
    expect(within(row).getByText('Posted')).toBeInTheDocument();
    // Immutability (US-A02.3): a posted entry never offers an edit or delete affordance in the list.
    expect(within(row).queryByRole('button', { name: /edit/i })).toBeNull();
    expect(within(row).queryByRole('button', { name: /delete/i })).toBeNull();

    const results = await axe(container, {
      rules: { region: { enabled: false }, 'page-has-heading-one': { enabled: false } },
    });
    expect(results).toHaveNoViolations();
  });

  it('renders the permission-denied state on a permission_denied read', async () => {
    renderJournal({ list_journal: { status: 422, body: { ok: false, error: 'permission_denied' } } });
    expect(await screen.findByRole('heading', { name: 'No access' })).toBeInTheDocument();
  });
});

/**
 * The Source ("Quelle") column resolves its label with `t('journal.source.' + entry.source)`, and the
 * read model returns engine-only sources (`purchase`, `credit_note`, and the rest of `VALID_SOURCES`
 * in `src/core/ledger/postEntry.ts`) that the composer never offers. N5 caught two of them rendering
 * as the raw key `journal.source.purchase` / `journal.source.credit_note` in the visible column,
 * because the labels were missing from both locale fragments. These tests assert the TRANSLATED label
 * shows and the raw key never does, in both locales.
 */
describe('Journal, Source column labels engine-only sources', () => {
  it('renders the translated Source label for purchase and credit_note (en), never the raw key', async () => {
    const { container } = renderJournal({
      list_journal: {
        status: 200,
        body: {
          ok: true,
          entries: [
            postedEntry({ id: 'je_p', ref: 'K-1', source: 'purchase' }),
            postedEntry({ id: 'je_c', ref: 'G-1', source: 'credit_note' }),
          ],
        },
      },
    });
    const table = await screen.findByRole('table');

    const purchaseRow = within(table).getByRole('row', { name: /K-1/ });
    expect(within(purchaseRow).getByText('Vendor bill')).toBeInTheDocument();

    const creditRow = within(table).getByRole('row', { name: /G-1/ });
    expect(within(creditRow).getByText('Credit note')).toBeInTheDocument();

    // The defect was a raw dot-path leaking into the cell. It must appear nowhere in the table.
    expect(container.textContent).not.toContain('journal.source.');
  });

  it('renders the translated Source label for purchase and credit_note (de-CH), never the raw key', async () => {
    const { container } = renderJournal(
      {
        list_journal: {
          status: 200,
          body: {
            ok: true,
            entries: [
              postedEntry({ id: 'je_p', ref: 'K-1', source: 'purchase' }),
              postedEntry({ id: 'je_c', ref: 'G-1', source: 'credit_note' }),
            ],
          },
        },
      },
      { locale: 'de-CH' },
    );
    const table = await screen.findByRole('table');

    const purchaseRow = within(table).getByRole('row', { name: /K-1/ });
    expect(within(purchaseRow).getByText('Kreditorenbuchung')).toBeInTheDocument();

    const creditRow = within(table).getByRole('row', { name: /G-1/ });
    expect(within(creditRow).getByText('Gutschrift')).toBeInTheDocument();

    expect(container.textContent).not.toContain('journal.source.');
  });
});

/**
 * The Quelle filter used to offer only the eight sources the composer writes, so the eleven
 * engine-only sources (`purchase`, `dunning`, `credit_note`, camt, stock, landed cost, expense
 * claims and the four asset runs) could be READ in a row but never FILTERED to. The filter list now
 * mirrors the full `VALID_SOURCES` enum. This asserts a formerly-missing source is offered AND that
 * choosing it narrows the read: `list_journal` is re-issued with `source` set to that value.
 */
describe('Journal, Quelle filter reaches engine-only sources', () => {
  it('offers a formerly-missing source (purchase) and filters the list by it', async () => {
    const { calls } = renderJournal({
      list_journal: { status: 200, body: { ok: true, entries: [] } },
      ...PICKERS,
    });

    // Wait for the initial (unfiltered) load before touching the filter.
    await waitFor(() => expect(calls.filter((c) => c.action === 'list_journal').length).toBe(1));
    expect(calls[calls.findIndex((c) => c.action === 'list_journal')].input.source).toBeUndefined();

    // The option is present under its translated label, not the raw key.
    const sourceSelect = screen.getByRole('combobox', { name: 'Source' });
    await userEvent.click(sourceSelect);
    const purchaseOption = screen.getByRole('option', { name: 'Vendor bill' });
    expect(purchaseOption).toBeInTheDocument();
    expect(purchaseOption).toHaveAttribute('data-value', 'purchase');

    await userEvent.click(purchaseOption);

    // K-16: the filter is live, there is no apply button. The chosen filter reaches the engine read
    // as `source: 'purchase'` once the 250ms debounce has passed.
    expect(screen.queryByRole('button', { name: 'Apply filters' })).not.toBeInTheDocument();
    await waitFor(() =>
      expect(calls.filter((c) => c.action === 'list_journal').length).toBeGreaterThanOrEqual(2),
    );
    const lastList = [...calls].reverse().find((c) => c.action === 'list_journal');
    expect(lastList?.input.source).toBe('purchase');
  });
});

describe('EntryDrawer, compose and post', () => {
  it('blocks Post until debits equal credits, then posts a balanced manual entry', async () => {
    const posted: Record<string, unknown>[] = [];
    const handlers: Handlers = {
      list_journal: { status: 200, body: { ok: true, entries: [] } },
      ...PICKERS,
      post_entry: (input) => {
        posted.push(input);
        return cannedOk('post_entry', { ok: true, entryId: 'je_new' });
      },
    };
    const { calls } = renderJournal(handlers);

    await userEvent.click(await screen.findByRole('button', { name: 'New entry' }));
    const dialog = await screen.findByRole('dialog');
    await openGrid(dialog);

    // Two lines start empty. Pick accounts, then set only the debit: the entry is unbalanced.
    await pickAccount(await within(dialog).findByLabelText('Account 1'), BUERO);
    await pickAccount(within(dialog).getByLabelText('Account 2'), KASSE);
    // Line 2 has an account and no amount: as the LAST line it balances itself (a dim figure, its
    // placeholder) and Post is open. Typing the debit on line 2 instead takes that away.
    await userEvent.type(within(dialog).getByLabelText('Debit 1'), '50.00');
    expect(within(dialog).getByLabelText('Credit 2')).toHaveAttribute('placeholder', '50.00');
    await userEvent.type(within(dialog).getByLabelText('Debit 2'), '20.00');

    const postBtn = within(dialog).getByRole('button', { name: 'Post' });
    expect(postBtn).toBeDisabled();
    // The footer names the signed difference in words and figures (never colour alone), its money
    // its own tabular span (C2 F4).
    const unbalanced = dialog.querySelector('.journal-balance--off') as HTMLElement;
    expect(unbalanced).toHaveTextContent('Difference CHF 70.00');
    expect(unbalanced.querySelector('.t-money')).toHaveTextContent(/^CHF 70\.00$/);

    // Balance it: credit the other line by the same amount.
    await userEvent.clear(within(dialog).getByLabelText('Debit 2'));
    await userEvent.type(within(dialog).getByLabelText('Credit 2'), '50.00');
    await waitFor(() => expect(postBtn).toBeEnabled());
    expect(dialog.querySelector('.journal-balance--ok')).toHaveTextContent('Balanced');

    await userEvent.click(postBtn);

    await waitFor(() => expect(posted).toHaveLength(1));
    const input = posted[0];
    expect(input.source).toBe('manual');
    expect(typeof input.idempotencyKey).toBe('string');
    expect(input.lines).toEqual([
      { account: BUERO, debit: 5000 },
      { account: KASSE, credit: 5000 },
    ]);
    // The list is refetched after a successful write (initial load + refetch).
    await waitFor(() =>
      expect(calls.filter((c) => c.action === 'list_journal').length).toBeGreaterThanOrEqual(2),
    );
  });

  it('never dresses Post as the solid primary: it is the shared accent control', async () => {
    const handlers: Handlers = { list_journal: { status: 200, body: { ok: true, entries: [] } }, ...PICKERS };
    renderJournal(handlers);

    await userEvent.click(await screen.findByRole('button', { name: 'New entry' }));
    const dialog = await screen.findByRole('dialog');
    const postBtn = within(dialog).getByRole('button', { name: 'Post' });

    // It IS on the shared control system (no surface-local button class survives) ...
    expect(postBtn).toHaveClass('btn');
    // ... and it wears the tinted accent, never the solid fill. A solid accent on the action that
    // writes into an append-only ledger invites the careless click.
    expect(postBtn).toHaveClass('btn--accent');
    expect(postBtn).not.toHaveClass('btn--primary');

    // Save draft sits beside it as the quiet ghost and Cancel as the secondary, so nothing competes.
    expect(within(dialog).getByRole('button', { name: 'Save draft' })).toHaveClass('btn--ghost');
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveClass('btn--secondary');
  });

  it('surfaces an engine unbalanced rejection inline instead of throwing', async () => {
    const handlers: Handlers = {
      list_journal: { status: 200, body: { ok: true, entries: [] } },
      ...PICKERS,
      post_entry: { status: 422, body: { ok: false, error: 'unbalanced', difference: 100 } },
    };
    renderJournal(handlers);
    await userEvent.click(await screen.findByRole('button', { name: 'New entry' }));
    const dialog = await screen.findByRole('dialog');
    // Force the client balance check to pass so the request reaches the engine, which still rejects.
    await fillSatz(dialog, BUERO, KASSE, '10.00');
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Post' })).toBeEnabled());
    await userEvent.click(within(dialog).getByRole('button', { name: 'Post' }));
    expect(await within(dialog).findByText(/does not balance/i)).toBeInTheDocument();
  });

  // F-10 J8.6 residual: a period-lock refusal used to link to /periods and stop there, leaving the
  // person to guess the exit and re-key a discarded draft. It now names the way OUT (change the
  // booking date to the nearest open period) and keeps every composed line.
  it('offers to move the booking date to the nearest open period and keeps the composed lines', async () => {
    const handlers: Handlers = {
      list_journal: { status: 200, body: { ok: true, entries: [] } },
      ...PICKERS,
      post_entry: {
        status: 422,
        body: { ok: false, error: 'period_locked', period: '2026-03', kind: 'soft' },
      },
    };
    renderJournal(handlers);

    await userEvent.click(await screen.findByRole('button', { name: 'New entry' }));
    const dialog = await screen.findByRole('dialog');

    await fillSatz(dialog, BUERO, KASSE, '50.00');
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Post' })).toBeEnabled());
    await userEvent.click(within(dialog).getByRole('button', { name: 'Post' }));

    // The refusal names the way OUT (change the date), not only the /periods link.
    expect(await within(dialog).findByText(/nearest open period/i)).toBeInTheDocument();
    expect(within(dialog).getByRole('link', { name: 'Manage periods' })).toHaveAttribute(
      'href',
      '/periods',
    );
    const changeBtn = within(dialog).getByRole('button', { name: 'Change the booking date' });

    // Taking the way out moves the entry to the first open day (April 1, past the March lock) and
    // RETAINS the composed amounts: the composer is never reset back to a blank draft.
    await userEvent.click(changeBtn);
    expect((within(dialog).getByLabelText('Date') as HTMLInputElement).value).toBe('2026-04-01');
    expect((within(dialog).getByLabelText('Amount') as HTMLInputElement).value).toBe('50.00');
    // The refusal clears once the date is moved, so the drawer no longer shows a dead end.
    expect(within(dialog).queryByText(/nearest open period/i)).not.toBeInTheDocument();
  });
});

describe('EntryDrawer, reverse and drafts', () => {
  /** A posted entry, its drawer read, and a recording `reverse_entry`. */
  function reverseHandlers(reversed: Record<string, unknown>[]): Handlers {
    return {
      list_journal: { status: 200, body: { ok: true, entries: [postedEntry()] } },
      ...PICKERS,
      get_entry: {
        status: 200,
        body: {
          ok: true,
          entry: postedEntry(),
          lines: [
            { id: 'l1', account: BUERO, debit: 5000, credit: null },
            { id: 'l2', account: KASSE, debit: null, credit: 5000 },
          ],
        },
      },
      reverse_entry: (input) => {
        reversed.push(input);
        return { status: 200, body: { ok: true, reversalId: 'je_rev' } };
      },
    };
  }

  it('shows only Reverse on a posted entry (no edit path) and reverses it through the confirm', async () => {
    const reversed: Record<string, unknown>[] = [];
    renderJournal(reverseHandlers(reversed));
    const table = await screen.findByRole('table');
    await userEvent.click(within(table).getByRole('row', { name: /Open entry B-100/ }));
    const dialog = await screen.findByRole('dialog');

    // A posted entry is immutable: no editable fields, no Post/Save draft/Delete, only Reverse.
    expect(within(dialog).queryAllByRole('textbox')).toHaveLength(0);
    expect(within(dialog).queryByRole('button', { name: 'Post' })).toBeNull();
    expect(within(dialog).queryByRole('button', { name: 'Save draft' })).toBeNull();
    expect(within(dialog).queryByRole('button', { name: 'Delete' })).toBeNull();
    // A view-only dialog closes; there is nothing in it to "cancel". (Two Close controls: the
    // header's x and the footer button.)
    expect(within(dialog).queryByRole('button', { name: 'Cancel' })).toBeNull();
    expect(within(dialog).getAllByRole('button', { name: 'Close' })).toHaveLength(2);
    // The posted line amounts render through formatMoney (a debit line and a credit line).
    expect(await within(dialog).findAllByText('CHF 50.00')).toHaveLength(2);

    await userEvent.click(within(dialog).getByRole('button', { name: 'Reverse' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Post reversal' }));
    await waitFor(() => expect(reversed).toHaveLength(1));
    expect(reversed[0].entryId).toBe('je_1');
    expect(typeof reversed[0].idempotencyKey).toBe('string');
  });

  it.each([
    ['reopen_bank_line', { bankTxnId: 'bt_9' }, 'This entry belongs to a bank line: take the line back under Bank.', 'Show the bank line', '/bank?tab=booked&line=bt_9'],
    ['reverse_payment', {}, 'This entry belongs to a payment: reverse the payment under Payments.', 'Go to payments', '/payments'],
  ])('A39 C11: an entry %s owns is refused with that owner named and where to undo it', async (verb, facts, sentence, linkName, href) => {
    const handlers = reverseHandlers([]);
    handlers.reverse_entry = { status: 422, body: { ok: false, error: 'owned_by', verb, entryId: 'je_1', ...facts } };
    renderJournal(handlers);
    const table = await screen.findByRole('table');
    await userEvent.click(within(table).getByRole('row', { name: /Open entry B-100/ }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Reverse' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Post reversal' }));
    expect(await within(dialog).findByText(sentence)).toBeInTheDocument();
    expect(within(dialog).getByRole('link', { name: linkName })).toHaveAttribute('href', href);
  });

  it.each([
    ['reopen_bank_line', {}, 'This entry came from a bank line and is already reversed. Decide the line under Bank.', 'Go to Bank', '/bank'],
    ['vat_settlement_reverse', {}, 'This entry belongs to a VAT settlement: reverse the settlement under VAT.', 'Go to VAT', '/mwst'],
    ['accrual_reverse', {}, 'This entry belongs to an accrual: reverse the accrual under Periods.', 'Go to periods', '/periods'],
    ['provision_reverse', {}, 'This entry belongs to a provision: reverse the provision under Periods.', 'Go to periods', '/periods'],
    ['provision_release_reverse', {}, 'This entry releases a provision: take the release back under Periods.', 'Go to periods', '/periods'],
    ['fx_revaluation_reverse', {}, 'This entry belongs to a currency revaluation: reverse the revaluation under Foreign currency.', 'Go to foreign currency', '/fx'],
    ['landed_cost_reverse', {}, 'This entry belongs to a landed-cost voucher: reverse the voucher under Landed costs.', 'Go to landed costs', '/landed-costs'],
    ['expense_claim_reverse', {}, 'This entry belongs to an expense claim: reverse the claim under HR.', 'Go to HR', '/personal'],
    ['dunning_fee_reverse', {}, 'This entry holds a reminder run\'s fees: reverse the fees on the run under Dunning.', 'Go to dunning', '/dunning'],
    ['asset_transaction_reverse', {}, "This entry belongs to an asset in the register: reverse it from the asset's ledger in the Asset register.", 'Go to the asset register', '/assets'],
    ['wage_journal_reverse', {}, 'This entry is a wage journal from your payroll: reverse it on the Payroll tab under HR.', 'Go to HR', '/personal'],
  ])('A39 lean critic L4: an entry %s owns is refused with that owner named and where to undo it', async (verb, facts, sentence, linkName, href) => {
    const handlers = reverseHandlers([]);
    handlers.reverse_entry = { status: 422, body: { ok: false, error: 'owned_by', verb, entryId: 'je_1', ...facts } };
    renderJournal(handlers);
    const table = await screen.findByRole('table');
    await userEvent.click(within(table).getByRole('row', { name: /Open entry B-100/ }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Reverse' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Post reversal' }));
    expect(await within(dialog).findByText(sentence)).toBeInTheDocument();
    expect(within(dialog).getByRole('link', { name: linkName })).toHaveAttribute('href', href);
  });

  it('never posts a reversal on the bare click: the confirm gate stands between', async () => {
    const reversed: Record<string, unknown>[] = [];
    renderJournal(reverseHandlers(reversed));
    const table = await screen.findByRole('table');
    await userEvent.click(within(table).getByRole('row', { name: /Open entry B-100/ }));
    const dialog = await screen.findByRole('dialog');

    // The trigger must not wear the primary fill: a solid accent on an irreversible action invites
    // the careless click this gate exists to prevent.
    const trigger = within(dialog).getByRole('button', { name: 'Reverse' });
    expect(trigger).toHaveClass('btn--danger');
    expect(trigger).not.toHaveClass('btn--primary');

    await userEvent.click(trigger);

    // Clicking Reverse opens the confirm and writes NOTHING.
    const confirm = await screen.findByRole('alertdialog');
    expect(reversed).toHaveLength(0);

    // The copy teaches what a reversal is: an added mirror entry, with the original left standing.
    expect(confirm).toHaveTextContent(/A correction is always an additional entry/);
    expect(confirm).toHaveTextContent(/original entry stays in the journal unchanged/);
    // It is a correction, never a deletion, and the copy must never suggest otherwise.
    expect(confirm.textContent ?? '').not.toMatch(/delete|remove/i);

    // Backing out leaves the books untouched.
    await userEvent.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(reversed).toHaveLength(0);

    // Only the confirm's own action posts the mirror entry.
    await userEvent.click(within(dialog).getByRole('button', { name: 'Reverse' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Post reversal' }));
    await waitFor(() => expect(reversed).toHaveLength(1));
  });

  it('marks a Storno row and its original distinguishably, each cross-linked to the other', async () => {
    const original = postedEntry();
    const reversal = postedEntry({
      id: 'je_rev',
      ref: 'B-101',
      source: 'reversal',
      reversesEntryId: 'je_1',
    });
    renderJournal({
      list_journal: { status: 200, body: { ok: true, entries: [reversal, original] } },
    });
    const table = await screen.findByRole('table');
    const reversalRow = within(table).getByRole('row', { name: /B-101/ });
    const originalRow = within(table).getByRole('row', { name: /B-100/ });

    // Each half of the pair is badged AND links to the other, so neither reads as a lone posting.
    // The badge spells the word out next to its glyph: colour is never the only carrier.
    const stornoBadge = within(reversalRow).getByRole('button', {
      name: 'Open reversed entry B-100',
    });
    expect(stornoBadge).toHaveTextContent('Reversal');
    const reversedBadge = within(originalRow).getByRole('button', { name: 'Open reversal B-101' });
    expect(reversedBadge).toHaveTextContent('Reversed');

    // The two rows are not interchangeable: only the correcting row carries the Storno badge.
    expect(within(originalRow).queryByRole('button', { name: /Open reversed entry/ })).toBeNull();
    expect(within(reversalRow).queryByRole('button', { name: /Open reversal / })).toBeNull();
  });

  it('edits a draft and deletes it through the overflow menu', async () => {
    const deleted: Record<string, unknown>[] = [];
    const draft = postedEntry({ id: 'je_d', ref: 'D-1', status: 'draft', total: null });
    const handlers: Handlers = {
      list_journal: { status: 200, body: { ok: true, entries: [draft] } },
      ...PICKERS,
      get_entry: {
        status: 200,
        body: {
          ok: true,
          entry: draft,
          lines: [{ id: 'l1', account: BUERO, debit: 2500, credit: null }],
        },
      },
      delete_draft: (input) => {
        deleted.push(input);
        return { status: 200, body: { ok: true } };
      },
    };
    renderJournal(handlers);
    const table = await screen.findByRole('table');
    const row = within(table).getByRole('row', { name: /D-1/ });
    expect(within(row).getByText('Draft')).toBeInTheDocument();
    await userEvent.click(row);
    const dialog = await screen.findByRole('dialog');

    // A draft is editable: it offers Save draft and a deliberate second-click Delete behind overflow.
    expect(await within(dialog).findByRole('button', { name: 'Save draft' })).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'More actions' }));
    await userEvent.click(await within(dialog).findByRole('menuitem', { name: 'Delete' }));
    // Deleting a draft is irreversible, so it goes through a confirm before delete_draft is called.
    const deleteConfirm = await screen.findByRole('alertdialog', { name: 'Delete this draft?' });
    expect(deleted).toHaveLength(0);
    await userEvent.click(within(deleteConfirm).getByRole('button', { name: 'Delete draft' }));
    await waitFor(() => expect(deleted).toHaveLength(1));
    expect(deleted[0].entryId).toBe('je_d');
  });
});

describe('EntryDrawer, permission-denied write controls', () => {
  it('pre-disables Post and Save draft when the actor lacks the post capability', async () => {
    renderDrawer({ list_journal: { status: 200, body: { ok: true, entries: [] } }, ...PICKERS }, { canPost: false });
    const dialog = await screen.findByRole('dialog');
    // MEASURED 2026-07-26, and it predates this change: only the banner below actually guards the
    // capability. Re-running this case with `canPost: true` fails on the banner alone, because a
    // blank create drawer has nothing to post (unbalanced, fewer than two lines), so both button
    // assertions hold whatever the capability says. They are not wrong, they are just not evidence.
    // Making them evidence means composing a balanced two-line entry first and asserting the gate
    // still bites, which is a rewrite of this case rather than a re-pointing of it.
    //
    // The drawer paints its dialog chrome on the first commit and keeps a Skeleton body until the
    // picker reads land, so the FIRST query into the body must await that commit: a synchronous
    // getBy here sampled the skeleton under CPU starvation (the CI node-20 job) and threw.
    expect(await within(dialog).findByRole('button', { name: 'Post' })).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: 'Save draft' })).toBeDisabled();
    expect(within(dialog).getByText('Requires the bookkeeper role.')).toBeInTheDocument();
  });
});

describe('Journal, de-CH copy', () => {
  it('renders the Swiss German title and status with real umlauts', async () => {
    renderJournal(
      { list_journal: { status: 200, body: { ok: true, entries: [postedEntry()] } } },
      { locale: 'de-CH' },
    );
    expect(await screen.findByRole('heading', { name: 'Journal', level: 1 })).toBeInTheDocument();
    const table = await screen.findByRole('table');
    expect(within(table).getByText('Gebucht')).toBeInTheDocument();
  });
});

describe('EntryDrawer, A06 VAT (S9/S10/S11)', () => {
  it('previews a line VAT live and stamps the frozen trace on the posted line (one code path)', async () => {
    const posted: Record<string, unknown>[] = [];
    const previews: Record<string, unknown>[] = [];
    const handlers: Handlers = {
      list_journal: { status: 200, body: { ok: true, entries: [] } },
      ...PICKERS,
      compose_entry: (input) => {
        previews.push(input);
        return COMPOSE(input);
      },
      post_entry: (input) => {
        posted.push(input);
        return cannedOk('post_entry', { ok: true, entryId: 'je_vat' });
      },
    };
    renderJournal(handlers);
    await userEvent.click(await screen.findByRole('button', { name: 'New entry' }));
    const dialog = await screen.findByRole('dialog');
    await openGrid(dialog);

    // The MANUAL path: a full double entry the accountant types, debtor 1081.00 / revenue net 1000.00
    // (UST81) / output VAT 81.00 on 2200. A line on a VAT account turns the derivation off for the
    // whole entry, so the trace rides the line as typed (its net) and nothing is added.
    await pickAccount(await within(dialog).findByLabelText('Account 1'), BUERO);
    await userEvent.type(within(dialog).getByLabelText('Credit 1'), '1000.00');
    await pickAccount(within(dialog).getByLabelText('Account 2'), KASSE);
    await userEvent.type(within(dialog).getByLabelText('Debit 2'), '1081.00');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Line' }));
    await pickAccount(within(dialog).getByLabelText('Account 3'), UST);
    await userEvent.type(within(dialog).getByLabelText('Credit 3'), '81.00');
    expect(within(dialog).getByText('VAT line typed by hand: TILL adds no VAT')).toBeInTheDocument();
    await pickVat(within(dialog).getByRole('button', { name: /^VAT 1(,|$)/ }), 'UST81');

    // The readout is the engine's own caption (the same figures an agent would get from compose_entry).
    expect(await within(dialog).findByText(/VAT CHF 81\.00/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Gross CHF 1'081\.00/)).toBeInTheDocument();
    // The request carried the line as booked (net, as typed) with its code, and no figure of the Studio's.
    await waitFor(() => expect(previews.length).toBeGreaterThanOrEqual(1));
    expect((previews.at(-1)?.lines as Record<string, unknown>[])[0]).toEqual({ account: BUERO, credit: 100000, taxCode: 'UST81', supplyDate: previews.at(-1)?.date });

    const postBtn = within(dialog).getByRole('button', { name: 'Post' });
    await waitFor(() => expect(postBtn).toBeEnabled());
    await userEvent.click(postBtn);

    await waitFor(() => expect(posted).toHaveLength(1));
    // The revenue line carries the frozen trace (taxCode + base + tax) AND its Leistungsdatum (F2:
    // the same supply date the preview was asked with, which is the entry date until the drawer
    // grows a separate supply-date field); the other lines do not.
    expect(posted[0].lines).toEqual([
      {
        account: BUERO,
        credit: 100000,
        taxCode: 'UST81',
        taxBase: 100000,
        taxAmount: 8100,
        supplyDate: posted[0].date,
      },
      { account: KASSE, debit: 108100 },
      { account: UST, credit: 8100 },
    ]);
    // F2 agreement: the last request and the posted line named the SAME Leistungsdatum.
    expect((previews.at(-1)?.lines as Record<string, unknown>[])[0]).toMatchObject({ supplyDate: posted[0].date });
  });

  it('B3: holds Post while a VAT preview is in flight, so a stale figure can never be posted', async () => {
    // LOADING-PROOF-EXEMPT: The affordance is not the default here: Post is asserted ENABLED first,
    // so the disable that follows can only come from a preview that really went in flight.
    const posted: Record<string, unknown>[] = [];
    let pending: (() => void)[] = [];
    const handlers: Handlers = {
      list_journal: { status: 200, body: { ok: true, entries: [] } },
      ...PICKERS,
      // Only a request carrying a code is held: the untagged entry before it is answered at once.
      compose_entry: (input) =>
        JSON.stringify(input.lines).includes('taxCode')
          ? new Promise<RestResponse>((resolve) => {
              pending.push(() => resolve(COMPOSE(input)));
            })
          : COMPOSE(input),
      post_entry: (input) => {
        posted.push(input);
        return cannedOk('post_entry', { ok: true, entryId: 'je_vat' });
      },
    };
    renderJournal(handlers);
    await userEvent.click(await screen.findByRole('button', { name: 'New entry' }));
    const dialog = await screen.findByRole('dialog');

    // A balanced, untagged entry first, on the manual path (a 2200 line): Post is available.
    await openGrid(dialog);
    await pickAccount(await within(dialog).findByLabelText('Account 1'), BUERO);
    await userEvent.type(within(dialog).getByLabelText('Credit 1'), '1000.00');
    await pickAccount(within(dialog).getByLabelText('Account 2'), KASSE);
    await userEvent.type(within(dialog).getByLabelText('Debit 2'), '1081.00');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Line' }));
    await pickAccount(within(dialog).getByLabelText('Account 3'), UST);
    await userEvent.type(within(dialog).getByLabelText('Credit 3'), '81.00');
    const postBtn = within(dialog).getByRole('button', { name: 'Post' });
    await waitFor(() => expect(postBtn).toBeEnabled());

    // Tag the revenue line: the preview goes in flight and Post must HOLD until it settles (the
    // stale-trace race: an eager click here used to post a trace from the previous state).
    await pickVat(within(dialog).getByRole('button', { name: /^VAT 1(,|$)/ }), 'UST81');
    await waitFor(() => expect(postBtn).toBeDisabled());
    expect(posted).toHaveLength(0);

    // Settle the answer: Post re-enables and the posted line carries the settled figures. (The request is
    // debounced, so wait for it to be in flight before settling it.)
    await waitFor(() => expect(pending.length).toBeGreaterThan(0));
    const flush = pending;
    pending = [];
    flush.forEach((resolve) => resolve());
    await waitFor(() => expect(postBtn).toBeEnabled());
    await userEvent.click(postBtn);
    await waitFor(() => expect(posted).toHaveLength(1));
    expect((posted[0].lines as Record<string, unknown>[])[0]).toMatchObject({
      account: BUERO,
      taxCode: 'UST81',
      taxBase: 100000,
      taxAmount: 8100,
    });
  });

  it('M5: a VAT-account line offers only import codes, never an output tag on 2200', async () => {
    renderJournal({ list_journal: { status: 200, body: { ok: true, entries: [] } }, ...PICKERS });
    await userEvent.click(await screen.findByRole('button', { name: 'New entry' }));
    const dialog = await screen.findByRole('dialog');
    await openGrid(dialog);

    // A 2200 line: the manual path, where the VAT-account line offers the import code only.
    await pickAccount(await within(dialog).findByLabelText('Account 1'), UST);
    await userEvent.click(within(dialog).getByRole('button', { name: /^VAT 1(,|$)/ }));
    await screen.findAllByRole('option');
    expect(offeredCodes()).not.toContain('UST81');
    expect(offeredCodes()).toContain('IMPORT');
    await userEvent.keyboard('{Escape}');
    // An ordinary line keeps the full list.
    await pickAccount(within(dialog).getByLabelText('Account 2'), BUERO);
    await userEvent.click(within(dialog).getByRole('button', { name: /^VAT 2(,|$)/ }));
    await screen.findAllByRole('option');
    expect(offeredCodes()).toContain('UST81');
  });

  it('M5: a tag stranded on a VAT account (a loaded draft) is flagged, shows no figure, and blocks Post', async () => {
    // Changing a line's account resets its code to the new account's default, so a stranded tag can no
    // longer be typed into being; it arrives on an old draft. The draft opens in the grid on the manual
    // path (a 2200 line) and the flag holds Post.
    const draft = postedEntry({ id: 'je_st', ref: 'S-1', status: 'draft', total: null });
    renderJournal({
      list_journal: { status: 200, body: { ok: true, entries: [draft] } },
      ...PICKERS,
      get_entry: {
        status: 200,
        body: {
          ok: true,
          entry: draft,
          lines: [
            { id: 'l1', account: UST, debit: null, credit: 100000, taxCode: 'UST81' },
            { id: 'l2', account: KASSE, debit: 100000, credit: null },
          ],
        },
      },
    });
    const table = await screen.findByRole('table');
    await userEvent.click(within(table).getByRole('row', { name: /Open entry S-1/ }));
    const dialog = await screen.findByRole('dialog');
    expect(
      await within(dialog).findByText('Tag the revenue or expense line, not the VAT account itself.'),
    ).toBeInTheDocument();
    expect(within(dialog).queryByText(/VAT CHF/)).not.toBeInTheDocument();
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Post' })).toBeDisabled());
  });

  it('surfaces a vat_trace_unreconciled rejection with the expected and booked figures, inline', async () => {
    const handlers: Handlers = {
      list_journal: { status: 200, body: { ok: true, entries: [] } },
      ...PICKERS,
      post_entry: {
        status: 422,
        body: { ok: false, error: 'vat_trace_unreconciled', account: '2200', expectedMinor: 8100, bookedMinor: 8105 },
      },
    };
    renderJournal(handlers);
    await userEvent.click(await screen.findByRole('button', { name: 'New entry' }));
    const dialog = await screen.findByRole('dialog');
    await fillSatz(dialog, BUERO, KASSE, '10.00');
    const postBtn = within(dialog).getByRole('button', { name: 'Post' });
    await waitFor(() => expect(postBtn).toBeEnabled());
    await userEvent.click(postBtn);

    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent(/CHF 81\.00/);
    expect(alert).toHaveTextContent(/CHF 81\.05/);
  });

  it('an entry with no code says nothing about VAT: no caption, no summary, no "no VAT" line', async () => {
    renderJournal({ list_journal: { status: 200, body: { ok: true, entries: [] } }, ...PICKERS });
    await userEvent.click(await screen.findByRole('button', { name: 'New entry' }));
    const dialog = await screen.findByRole('dialog');
    // First query into the skeleton-gated body: awaited, for the reason the pre-disable test states.
    await fillSatz(dialog, BUERO, KASSE, '10.00');
    // The MWST control is there (an expense account), empty because 6500 carries no default.
    expect(within(dialog).getByRole('button', { name: /^VAT(,|$)/ })).toHaveTextContent('Without VAT');
    expect(dialog.querySelector('.journal-caption')).toBeNull();
    expect(within(dialog).queryByText('No VAT on this document')).not.toBeInTheDocument();
  });

  it('renders the needs-config banner-CTA when the workspace has no tax codes (P9)', async () => {
    const handlers: Handlers = {
      list_journal: { status: 200, body: { ok: true, entries: [] } },
      list_accounts: ACCOUNTS,
      vat_codes: { status: 200, body: { ok: true, taxCodes: [] } },
      list_cost_centers: COST_CENTERS,
    };
    renderJournal(handlers);
    await userEvent.click(await screen.findByRole('button', { name: 'New entry' }));
    const dialog = await screen.findByRole('dialog');
    // Where the MWST control would stand (an expense account), the banner-CTA stands instead (P9).
    await pickAccount(await within(dialog).findByLabelText('Debit'), BUERO);
    const ctas = await within(dialog).findAllByRole('link', { name: 'Set up VAT' });
    expect(ctas[0]).toHaveAttribute('href', '/vat');
    expect(within(dialog).queryByRole('button', { name: /^VAT(,|$)/ })).not.toBeInTheDocument();
  });

  it('renders the tax control read-only for a persona without the post scope', async () => {
    renderDrawer({ list_journal: { status: 200, body: { ok: true, entries: [] } }, ...PICKERS }, { canPost: false });
    const dialog = await screen.findByRole('dialog');
    // Anchor on the loaded body first: over the skeleton the negative below would pass vacuously,
    // asserting nothing about the read-only treatment it exists to pin.
    await within(dialog).findByText('Requires the bookkeeper role.');
    await pickAccount(within(dialog).getByLabelText('Debit'), BUERO);
    // No editable picker for the tax code; the control is read-only text under the same name.
    expect(within(dialog).queryByRole('button', { name: /^VAT(,|$)/ })).not.toBeInTheDocument();
    expect(within(dialog).getByLabelText('VAT')).toHaveClass('vat-code-readonly');
  });

  it('C3/M35: an archived code on a draft flags inline, suppresses the figure readout, and blocks Post', async () => {
    // A draft saved when UST38 was active, reopened after UST38 was archived (it is absent from the
    // active `vat_codes` list): the line still carries the code, but it is no longer valid to post.
    const draft = postedEntry({ id: 'je_ar', ref: 'A-9', status: 'draft', total: null });
    const handlers: Handlers = {
      list_journal: { status: 200, body: { ok: true, entries: [draft] } },
      ...PICKERS,
      get_entry: {
        status: 200,
        body: {
          ok: true,
          entry: draft,
          lines: [
            { id: 'l1', account: BUERO, debit: 100000, credit: null, taxCode: 'UST38' },
            { id: 'l2', account: KASSE, debit: null, credit: 100000 },
          ],
        },
      },
    };
    renderJournal(handlers);
    const table = await screen.findByRole('table');
    await userEvent.click(within(table).getByRole('row', { name: /Open entry A-9/ }));
    const dialog = await screen.findByRole('dialog');

    // The picker flags the archived code inline (announced, not colour-only).
    expect(await within(dialog).findByText('Code archived, choose another.')).toBeInTheDocument();
    // The figure readout is suppressed on the flagged line: no mixed "live figures next to a flag".
    expect(within(dialog).queryByText(/VAT CHF/)).not.toBeInTheDocument();
    // The entry balances, but Post stays disabled because a line carries an invalid code.
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Post' })).toBeDisabled());
  });

  it('G4: a rejected post keeps focus inside the drawer so Escape still closes it', async () => {
    const handlers: Handlers = {
      list_journal: { status: 200, body: { ok: true, entries: [] } },
      ...PICKERS,
      post_entry: {
        status: 422,
        body: { ok: false, error: 'vat_trace_unreconciled', account: '2200', expectedMinor: 8100, bookedMinor: 8105 },
      },
    };
    renderJournal(handlers);
    await userEvent.click(await screen.findByRole('button', { name: 'New entry' }));
    const dialog = await screen.findByRole('dialog');
    await fillSatz(dialog, BUERO, KASSE, '10.00');
    const postBtn = within(dialog).getByRole('button', { name: 'Post' });
    await waitFor(() => expect(postBtn).toBeEnabled());
    await userEvent.click(postBtn);

    // The rejection surfaces inline, and focus is pulled back onto the drawer (never left on <body>).
    await within(dialog).findByRole('alert');
    await waitFor(() => expect(document.activeElement).not.toBe(document.body));
    expect(dialog.contains(document.activeElement)).toBe(true);

    // Escape still reaches the drawer (its handler lives on the dialog, which now holds focus). The
    // composer holds typed lines, so it asks before throwing them away (K-29); discarding closes it.
    await userEvent.keyboard('{Escape}');
    const discard = await screen.findByRole('alertdialog', { name: 'Discard your input?' });
    await userEvent.click(within(discard).getByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('K-29: Escape in the open account list closes only the list, never the composer', async () => {
    renderJournal({ list_journal: { status: 200, body: { ok: true, entries: [] } }, ...PICKERS });
    await userEvent.click(await screen.findByRole('button', { name: 'New entry' }));
    const dialog = await screen.findByRole('dialog');
    const account = await within(dialog).findByLabelText('Debit');
    await userEvent.click(account);
    await userEvent.type(account, '10');
    expect(account).toHaveAttribute('aria-expanded', 'true');

    await userEvent.keyboard('{Escape}');
    // The list is gone and the composer is still there, with nothing asked.
    expect(account).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('K-29: a composer holding input asks before Escape throws it away, and keeps it on "Keep editing"', async () => {
    renderJournal({ list_journal: { status: 200, body: { ok: true, entries: [] } }, ...PICKERS });
    await userEvent.click(await screen.findByRole('button', { name: 'New entry' }));
    const dialog = await screen.findByRole('dialog');
    await pickAccount(await within(dialog).findByLabelText('Debit'), BUERO);
    await userEvent.type(within(dialog).getByLabelText('Amount'), '42.00');

    await userEvent.keyboard('{Escape}');
    const discard = await screen.findByRole('alertdialog', { name: 'Discard your input?' });
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    await userEvent.click(within(discard).getByRole('button', { name: 'Keep editing' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    // Every typed value survived the question.
    expect(within(screen.getByRole('dialog')).getByLabelText('Amount')).toHaveValue('42.00');
  });

  it('K-29: a composer with nothing typed closes on Escape without asking', async () => {
    renderJournal({ list_journal: { status: 200, body: { ok: true, entries: [] } }, ...PICKERS });
    await userEvent.click(await screen.findByRole('button', { name: 'New entry' }));
    await screen.findByRole('dialog');
    await within(screen.getByRole('dialog')).findByLabelText('Debit');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('A1: the composer is the wide drawer, Datum and Text first, one Buchungssatz on the shared controls', async () => {
    renderJournal({ list_journal: { status: 200, body: { ok: true, entries: [] } }, ...PICKERS });
    await userEvent.click(await screen.findByRole('button', { name: 'New entry' }));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByLabelText('Debit');
    expect(dialog).toHaveAttribute('data-width', 'wide');
    for (const name of ['Date', 'Description', 'Debit', 'Credit', 'Amount']) {
      expect(within(dialog).getByLabelText(name)).toHaveClass('field');
    }
    // No line grid and no visible Referenz until asked for; no "So wird gebucht" table, no totals.
    expect(within(dialog).queryByLabelText('Account 1')).toBeNull();
    expect(within(dialog).queryByLabelText('Reference')).toBeNull();
    expect(within(dialog).queryByRole('table')).toBeNull();
    expect(dialog.querySelector('dl')).toBeNull();
    // The money commit is the tinted accent; the C4 sentence is the tooltip of the (i) right of it.
    expect(within(dialog).getByRole('button', { name: 'Post' })).toHaveClass('btn--accent');
    expect(dialog.querySelector('.drawer-foot .consequence-tip[data-verb="post_entry"]')).not.toBeNull();
    expect(dialog.querySelector('.drawer-foot p.consequence-line')).toBeNull();
  });
});

/**
 * §H-FX in the entry drawer, all five states.
 *
 * The defect these pin: a journal line carries `debit`/`credit` in its own transaction `currency`,
 * `baseDebit`/`baseCredit` in the books' currency, and the `fxRate` between them. The drawer read
 * every amount with a hardcoded CHF, so a EUR entry rendered a EUR figure under a CHF label: the
 * wrong number and the wrong unit at once, on the money path.
 */
describe('EntryDrawer, foreign currency (H-FX), five states', () => {
  /** A EUR 50.00 entry booked at 0.9450, so the books hold CHF 47.25. Engine-shaped rows. */
  const FX_LINES = [
    {
      id: 'l1',
      entryId: 'je_1',
      account: BUERO,
      debit: 5000,
      credit: null,
      currency: 'EUR',
      baseDebit: 4725,
      baseCredit: 0,
      fxRate: '0.9450',
      taxCode: null,
      taxBase: null,
      taxAmount: null,
    },
    {
      id: 'l2',
      entryId: 'je_1',
      account: KASSE,
      debit: null,
      credit: 5000,
      currency: 'EUR',
      baseDebit: 0,
      baseCredit: 4725,
      fxRate: '0.9450',
      taxCode: null,
      taxBase: null,
      taxAmount: null,
    },
  ];

  /** The same entry in the base currency: no rate at all, which is how the engine stamps CHF. */
  const CHF_LINES = FX_LINES.map((l) => ({
    ...l,
    currency: 'CHF',
    fxRate: null,
    baseDebit: l.debit ?? 0,
    baseCredit: l.credit ?? 0,
  }));

  function drawerHandlers(getEntry: Handler): Handlers {
    return {
      list_journal: { status: 200, body: { ok: true, entries: [postedEntry()] } },
      ...PICKERS,
      get_entry: getEntry,
    };
  }

  async function openDrawer(handlers: Handlers, locale: 'en' | 'de-CH' = 'en') {
    const { transport } = renderJournal(handlers, { locale });
    const table = await screen.findByRole('table');
    const open = locale === 'de-CH' ? /Buchung B-100 öffnen/ : /Open entry B-100/;
    await userEvent.click(within(table).getByRole('row', { name: open }));
    // The transport comes back too, so the LOADING test can prove `get_entry` is really in flight
    // rather than asserting over a drawer that has not asked for the entry yet.
    return { dialog: await screen.findByRole('dialog'), transport };
  }

  it('POPULATED: renders each amount in its OWN currency and discloses the rate and the base total', async () => {
    const { dialog } = await openDrawer(
      drawerHandlers({ status: 200, body: { ok: true, entry: postedEntry(), lines: FX_LINES } }),
    );
    // The transaction amounts, in EUR. The old render put "CHF 50.00" here.
    expect(await within(dialog).findAllByText('EUR 50.00')).toHaveLength(2);
    expect(within(dialog).queryByText('CHF 50.00')).toBeNull();
    // And the books, disclosed once: what it became, and at which rate.
    expect(
      within(dialog).getByText('Foreign currency: EUR 50.00 at rate 0.9450 is CHF 47.25 in the books.'),
    ).toBeInTheDocument();
  });

  it('POPULATED: says nothing about FX on a base-currency entry, where a rate of 1 is not FX', async () => {
    const { dialog } = await openDrawer(
      drawerHandlers({ status: 200, body: { ok: true, entry: postedEntry(), lines: CHF_LINES } }),
    );
    expect(await within(dialog).findAllByText('CHF 50.00')).toHaveLength(2);
    expect(within(dialog).queryByText(/Foreign currency/)).toBeNull();
  });

  it('POPULATED: renders the disclosure in de-CH with real umlauts and the du register', async () => {
    const { dialog } = await openDrawer(
      drawerHandlers({ status: 200, body: { ok: true, entry: postedEntry(), lines: FX_LINES } }),
      'de-CH',
    );
    expect(
      await within(dialog).findByText('Fremdwährung: EUR 50.00 zum Kurs 0.9450 ergibt CHF 47.25 in den Büchern.'),
    ).toBeInTheDocument();
  });

  it('POPULATED: names a mixed-currency entry as a problem rather than averaging it away', async () => {
    const mixed = [FX_LINES[0], { ...FX_LINES[1], currency: 'USD', fxRate: '0.8800' }];
    const { dialog } = await openDrawer(
      drawerHandlers({ status: 200, body: { ok: true, entry: postedEntry(), lines: mixed } }),
    );
    expect(await within(dialog).findByText(/more than one currency or rate/)).toBeInTheDocument();
  });

  it('EMPTY: an entry with no lines claims no currency at all', async () => {
    const { dialog } = await openDrawer(
      drawerHandlers({ status: 200, body: { ok: true, entry: postedEntry({ total: 0 }), lines: [] } }),
    );
    await within(dialog).findAllByRole('button', { name: 'Close' });
    expect(within(dialog).queryByText(/Foreign currency/)).toBeNull();
    expect(within(dialog).queryByText(/at rate/)).toBeNull();
  });

  it('LOADING: shows the skeleton and no half-read FX claim while get_entry is in flight', async () => {
    let release: (r: RestResponse) => void = () => {};
    const { dialog, transport } = await openDrawer(
      drawerHandlers(
        () =>
          new Promise<RestResponse>((resolve) => {
            release = resolve;
          }),
      ),
    );
    // The drawer's own `loading` starts true, so it can be on screen a beat before it asks for the
    // entry. Silence about FX BEFORE the read starts is not the claim this test is named after, and
    // this is also what makes `release` below the live resolver rather than the no-op it starts as.
    await transport.started('get_entry');
    // The skeleton the title promises, asserted rather than assumed. The shared LinkedFiles panel
    // renders its own polite "Loading files" status while files_list_linked settles, so scope to the
    // drawer's own skeleton region rather than assuming a single status on screen.
    const loadingStatuses = within(dialog).getAllByRole('status');
    const drawerSkeleton = loadingStatuses.find((node) => node.querySelector('.skeleton'));
    expect(drawerSkeleton).toBeDefined();
    expect(drawerSkeleton).toHaveAttribute('aria-busy', 'true');
    expect(within(dialog).queryByText(/Foreign currency/)).toBeNull();
    expect(within(dialog).queryByText(/EUR/)).toBeNull();
    release({ status: 200, body: { ok: true, entry: postedEntry(), lines: FX_LINES } });
    expect(await within(dialog).findByText(/Foreign currency/)).toBeInTheDocument();
    // The skeleton is a state the drawer passes THROUGH: it has to end, not just start. Scope to the
    // drawer's own skeleton region: the LinkedFiles panel may still be settling its "Loading files"
    // status, which is not what this test is named after. It has to END, so wait for the end rather
    // than asserting it in the same tick as the release: under a loaded box the skeleton clears a
    // render later than the FX text appears, and a same-tick check failed the push gate (23.09.2026).
    await waitFor(() =>
      expect(within(dialog).queryAllByRole('status').find((node) => node.querySelector('.skeleton'))).toBeUndefined(),
    );
  });

  it('ERROR: a failed entry read shows the engine error and invents no currency', async () => {
    const { dialog } = await openDrawer(
      drawerHandlers({ status: 422, body: { ok: false, error: 'not_found' } }),
    );
    expect(await within(dialog).findByRole('alert')).toBeInTheDocument();
    expect(within(dialog).queryByText(/Foreign currency/)).toBeNull();
    expect(within(dialog).queryByText(/EUR/)).toBeNull();
  });

  it('DENIED: a permission_denied entry read shows the refusal and no FX figures', async () => {
    const { dialog } = await openDrawer(
      drawerHandlers({ status: 403, body: { ok: false, error: 'permission_denied' } }),
    );
    expect(await within(dialog).findByRole('alert')).toBeInTheDocument();
    expect(within(dialog).queryByText(/Foreign currency/)).toBeNull();
  });
});

describe('EntryDrawer, C3 provenance and C4 consequence (D118)', () => {
  it('C3: a viewed posted entry shows the quiet provenance line from the read model, actor and date', async () => {
    // The read model carries WHO and WHEN on the header (get_entry -> mapEntry: source, createdBy,
    // createdAt). The line renders those verbatim; nothing is fabricated.
    const withActor = postedEntry({ createdBy: 'Mara Keller', createdAt: '2026-03-31T09:12:00Z' });
    renderJournal({
      list_journal: { status: 200, body: { ok: true, entries: [withActor] } },
      ...PICKERS,
      get_entry: {
        status: 200,
        body: {
          ok: true,
          entry: withActor,
          lines: [{ id: 'l1', account: BUERO, debit: 5000, credit: null }],
        },
      },
    });
    const table = await screen.findByRole('table');
    await userEvent.click(within(table).getByRole('row', { name: /Open entry B-100/ }));
    const dialog = await screen.findByRole('dialog');
    // The seat and the humanized act, from the header the engine sent, at the point of judgement.
    expect(await within(dialog).findByText(/Recorded by Mara Keller/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Recorded by Mara Keller/)).toHaveTextContent('31.03.2026');
  });

  it('C3 / F-08 (J5.4): an agent-authored entry links into its A35 session, named in words with no raw label', async () => {
    // The read model says the entry came from the agent; the trace read (by entityRef) names the session.
    const byAgent = postedEntry({ source: 'agent', createdBy: 'agent', createdAt: '2026-09-02T09:12:00Z' });
    const traceReads: Record<string, unknown>[] = [];
    renderJournal({
      list_journal: { status: 200, body: { ok: true, entries: [byAgent] } },
      ...PICKERS,
      get_entry: {
        status: 200,
        body: { ok: true, entry: byAgent, lines: [{ id: 'l1', account: BUERO, debit: 5000, credit: null }] },
      },
      list_agent_sessions: (input) => {
        traceReads.push(input);
        return { status: 200, body: { ok: true, sessions: [{ sessionId: 's_42', clientLabel: 'Claude Desktop', startedAt: '2026-09-02T09:00:00Z', lastAt: '2026-09-02T09:12:00Z', open: false, calls: 3, writes: 1, drafts: 0 }] } };
      },
    });
    const table = await screen.findByRole('table');
    await userEvent.click(within(table).getByRole('row', { name: /Open entry B-100/ }));
    const dialog = await screen.findByRole('dialog');
    // ONE click from the posting to the conversation: the link targets the session by id.
    const link = await within(dialog).findByRole('link', { name: 'View trace' });
    expect(link).toHaveAttribute('href', '/agent?session=s_42');
    expect(traceReads[0]).toMatchObject({ workspaceId: 'ws_test', entityRef: 'je_1' });
    // The agent is named in words, and the raw source label is NOT repeated after it in brackets.
    const line = within(dialog).getByText(/Recorded by the agent/);
    expect(line.textContent).not.toMatch(/\(Agent\)/);
    expect(line.textContent).toContain('02.09.2026');
  });

  it('C3: a human posting has no trace and no link, and the Studio seat is named in words', async () => {
    const byStudio = postedEntry({ createdBy: 'studio', createdAt: '2026-03-31T09:12:00Z' });
    renderJournal({
      list_journal: { status: 200, body: { ok: true, entries: [byStudio] } },
      ...PICKERS,
      get_entry: {
        status: 200,
        body: { ok: true, entry: byStudio, lines: [{ id: 'l1', account: BUERO, debit: 5000, credit: null }] },
      },
      list_agent_sessions: { status: 200, body: { ok: true, sessions: [] } },
    });
    const table = await screen.findByRole('table');
    await userEvent.click(within(table).getByRole('row', { name: /Open entry B-100/ }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText(/Recorded in the Studio/)).toBeInTheDocument();
    expect(within(dialog).queryByText(/Recorded by studio/)).toBeNull();
    expect(within(dialog).queryByRole('link', { name: 'View trace' })).toBeNull();
  });

  it('C3: a blank create drawer, which has no posted header, shows no provenance line', async () => {
    renderJournal({ list_journal: { status: 200, body: { ok: true, entries: [] } }, ...PICKERS });
    await userEvent.click(await screen.findByRole('button', { name: 'New entry' }));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByLabelText('Debit');
    // A composed entry never reached the engine, so there is no actor or time to show: no line.
    expect(within(dialog).queryByText(/Recorded by/)).toBeNull();
  });

  it('C4: the reverse confirm shows the shared consequence sentence for reverse_entry', async () => {
    const reversed: Record<string, unknown>[] = [];
    renderJournal({
      list_journal: { status: 200, body: { ok: true, entries: [postedEntry()] } },
      ...PICKERS,
      get_entry: {
        status: 200,
        body: {
          ok: true,
          entry: postedEntry(),
          lines: [{ id: 'l1', account: BUERO, debit: 5000, credit: null }],
        },
      },
      reverse_entry: (input) => {
        reversed.push(input);
        return { status: 200, body: { ok: true, reversalId: 'je_rev' } };
      },
    });
    const table = await screen.findByRole('table');
    await userEvent.click(within(table).getByRole('row', { name: /Open entry B-100/ }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Reverse' }));
    const confirm = await screen.findByRole('alertdialog');
    // The SAME string an approver reads when clearing an agent's drafted reversal (D156: the engine's one catalogue).
    expect(within(confirm).getByText(consequenceSentence('reverse_entry', 'en') as string)).toBeInTheDocument();
  });
});

describe('Journal, /journal?entry=<id> opens that entry (bank "Buchung öffnen", Payments)', () => {
  it('reads THAT id, opens it read-only, and drops the param on close', async () => {
    const { calls } = renderJournal(
      {
        list_journal: { status: 200, body: { ok: true, entries: [postedEntry()] } },
        ...PICKERS,
        get_entry: {
          status: 200,
          body: { ok: true, entry: postedEntry({ id: 'je_5', ref: 'B-5' }), lines: [
            { id: 'l1', account: BUERO, debit: 5000, credit: null },
            { id: 'l2', account: KASSE, debit: null, credit: 5000 },
          ] },
        },
      },
      { path: '/journal?entry=je_5' },
    );
    const dialog = await screen.findByRole('dialog', { name: 'View entry' });
    expect(await within(dialog).findByRole('button', { name: 'Reverse' })).toBeInTheDocument();
    // Read to learn its status, then by the drawer: THAT id each time, and nothing else.
    expect(new Set(calls.filter((c) => c.action === 'get_entry').map((c) => c.input.entryId))).toEqual(new Set(['je_5']));
    expect(screen.getByTestId('location-search')).toHaveTextContent('?entry=je_5');
    await userEvent.click(within(dialog).getAllByRole('button', { name: 'Close' })[1] as HTMLElement);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByTestId('location-search')).toHaveTextContent(/^$/);
  });

  it('an id the book does not hold opens nothing else: a not-found banner and a way out', async () => {
    const { calls } = renderJournal(
      {
        list_journal: { status: 200, body: { ok: true, entries: [postedEntry()] } },
        ...PICKERS,
        get_entry: { status: 404, body: { ok: false, error: 'not_found', entryId: 'je_nope' } },
      },
      { path: '/journal?entry=je_nope' },
    );
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('This entry does not exist in this workspace. Close it and pick an entry in the journal.')).toBeInTheDocument();
    expect(within(dialog).queryByRole('table')).toBeNull();
    expect(new Set(calls.filter((c) => c.action === 'get_entry').map((c) => c.input.entryId))).toEqual(new Set(['je_nope']));
    await userEvent.click(within(dialog).getAllByRole('button', { name: 'Close' })[1] as HTMLElement);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByTestId('location-search')).toHaveTextContent(/^$/);
  });

  it('a DRAFT opens the way a row click opens it: in the editable composer, never read-only with Reverse', async () => {
    renderJournal(
      {
        list_journal: { status: 200, body: { ok: true, entries: [postedEntry()] } },
        ...PICKERS,
        get_entry: {
          status: 200,
          body: { ok: true, entry: postedEntry({ id: 'je_d', ref: 'D-1', status: 'draft', total: null }), lines: [
            { id: 'l1', account: BUERO, debit: 5000, credit: null },
            { id: 'l2', account: KASSE, debit: null, credit: 5000 },
          ] },
        },
      },
      { path: '/journal?entry=je_d' },
    );
    const dialog = await screen.findByRole('dialog', { name: 'Edit draft' });
    expect(await within(dialog).findByRole('button', { name: 'Post' })).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Reverse' })).toBeNull();
    expect(screen.queryByRole('dialog', { name: 'View entry' })).toBeNull();
    expect(screen.getByTestId('location-search')).toHaveTextContent('?entry=je_d');
  });
});

describe('D176: `?vorlage=` opens the composer with that Vorlage', () => {
  it('the bank row\'s next step lands here: the composer opens with the Vorlage and the date, and the params leave the address', async () => {
    const vorlage = {
      id: 'br_v',
      scope: 'manual',
      outcome: 'legs',
      label: 'Quartalsabgrenzung',
      legs: [
        { accountId: BUERO, taxCode: null, side: 'debit', amount: { kind: 'ask', label: 'Betrag' }, accountNumber: '', accountName: '' },
        { accountId: KASSE, taxCode: null, side: 'credit', amount: { kind: 'rest' }, accountNumber: '', accountName: '' },
      ],
      accountId: KASSE,
    };
    renderJournal(
      {
        list_journal: { status: 200, body: { ok: true, entries: [postedEntry()] } },
        ...PICKERS,
        list_bank_standards: { status: 200, body: { ok: true, standards: [vorlage] } },
      },
      { path: '/journal?vorlage=br_v&date=2026-10-14' },
    );
    const dialog = await screen.findByRole('dialog', { name: 'New entry' });
    expect(await within(dialog).findByRole('textbox', { name: 'Betrag' })).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Date')).toHaveValue('2026-10-14');
    await waitFor(() => expect(screen.getByTestId('location-search')).toHaveTextContent(/^$/));
  });
});

/**
 * D178 point 2 (A02 §4b): the Belegnummer the engine assigned at posting, on the list, in the filter and in
 * the drawer title. The rows are the engine's own shape (`number` is a field of `list_journal` and
 * `get_entry`), null on a draft; the surface renders it and never derives one.
 */
describe('Journal, the Belegnummer (D178 point 2)', () => {
  it('shows the number in a tabular, no-wrap column; a draft cell is empty', async () => {
    renderJournal({
      list_journal: {
        status: 200,
        body: {
          ok: true,
          entries: [
            postedEntry({ number: '2026-0118' }),
            postedEntry({ id: 'je_2', ref: 'B-101', status: 'draft', number: null }),
          ],
        },
      },
    });
    const table = await screen.findByRole('table');
    expect(within(table).getByRole('columnheader', { name: 'Voucher no.' })).toBeInTheDocument();
    const posted = within(table).getByRole('row', { name: /B-100/ });
    const cell = within(posted).getByText('2026-0118');
    // The shared numeric column: tabular figures, end-aligned, never wraps (K-18).
    expect(cell.closest('td')).toHaveClass('t-num');
    const draft = within(table).getByRole('row', { name: /B-101/ });
    expect(within(draft).queryByText(/2026-/)).toBeNull();
  });

  it('filters by number: the typed value reaches list_journal as number, trimmed, and clears with the rest', async () => {
    const { calls } = renderJournal({ list_journal: { status: 200, body: { ok: true, entries: [] } } });
    await waitFor(() => expect(calls.filter((c) => c.action === 'list_journal').length).toBe(1));
    await userEvent.type(screen.getByRole('textbox', { name: 'Voucher no.' }), ' 118 ');
    await waitFor(() => expect([...calls].reverse().find((c) => c.action === 'list_journal')?.input.number).toBe('118'));
    // A filtered miss reads as "no match", with the way back.
    expect(await screen.findByText('No entries match these filters.')).toBeInTheDocument();
    await userEvent.click(screen.getAllByRole('button', { name: 'Clear filters' })[0]);
    await waitFor(() => expect([...calls].reverse().find((c) => c.action === 'list_journal')?.input.number).toBeUndefined());
  });

  it('titles a posted entry drawer with its number, so the dialog is named by the record', async () => {
    renderJournal({
      list_journal: { status: 200, body: { ok: true, entries: [postedEntry({ number: '118' })] } },
      ...PICKERS,
      get_entry: {
        status: 200,
        body: {
          ok: true,
          entry: postedEntry({ number: '118' }),
          lines: [
            { id: 'l1', account: BUERO, debit: 5000, credit: null },
            { id: 'l2', account: KASSE, debit: null, credit: 5000 },
          ],
        },
      },
    });
    const table = await screen.findByRole('table');
    await userEvent.click(within(table).getByRole('row', { name: /Open entry B-100/ }));
    expect(await screen.findByRole('dialog', { name: 'Voucher no. 118' })).toBeInTheDocument();
  });

  it('keeps the plain title on a posted entry without a number (posted while numbering was off)', async () => {
    renderJournal({
      list_journal: { status: 200, body: { ok: true, entries: [postedEntry({ number: null })] } },
      ...PICKERS,
      get_entry: {
        status: 200,
        body: {
          ok: true,
          entry: postedEntry({ number: null }),
          lines: [
            { id: 'l1', account: BUERO, debit: 5000, credit: null },
            { id: 'l2', account: KASSE, debit: null, credit: 5000 },
          ],
        },
      },
    });
    const table = await screen.findByRole('table');
    await userEvent.click(within(table).getByRole('row', { name: /Open entry B-100/ }));
    expect(await screen.findByRole('dialog', { name: 'View entry' })).toBeInTheDocument();
  });

  it('de-CH: the column and the filter say Beleg-Nr.', async () => {
    renderJournal(
      { list_journal: { status: 200, body: { ok: true, entries: [postedEntry({ number: '7' })] } } },
      { locale: 'de-CH' },
    );
    const table = await screen.findByRole('table');
    expect(within(table).getByRole('columnheader', { name: 'Beleg-Nr.' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Beleg-Nr.' })).toBeInTheDocument();
  });
});
