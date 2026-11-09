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
import listAccountsFixture from '../Accounts/list-accounts.fixture.json';
import Items from './index';
import { shortTaxCode } from './Items';

/**
 * A canned-response transport: each action maps to a fixed RestResponse or a function of its input.
 * Anything unmapped answers 404, mirroring the real bridge for an unknown action.
 */
/**
 * A canned handler exactly as the transport calls it: the request input in, a RestResponse out.
 *
 * Spies are declared `vi.fn<CannedHandler>(...)` rather than bare `vi.fn(...)`, so that
 * `spy.mock.calls[0][0]` is the request the surface actually sent. Inferred from a zero-argument
 * implementation the calls tuple is empty, and every assertion about what the surface asked for is
 * a compile error the moment anyone type-checks this file.
 */
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

const reject = (error: string, status = 422): RestResponse => ({
  status,
  body: { ok: false, error },
});

/**
 * The chart the revenue picker is filled from is a RECORDING of the live `list_accounts` answer
 * (`test/accounts/capture-studio-list-accounts.mjs`), pinned by
 * `test/accounts/studio-list-accounts-fixture.test.mjs`.
 *
 * It used to be two hand-typed rows named `Dienstleistungsertrag` and `Materialaufwand`, neither of
 * which is an account name in the shipped KMU chart. The picker was filtered correctly and tested
 * against a chart that does not exist.
 */
const SAMPLE_ACCOUNTS = listAccountsFixture.accounts;

/** An account row from the recording, by its number. Throws rather than rendering `undefined`. */
function account(number: string) {
  const row = SAMPLE_ACCOUNTS.find((a) => a.number === number);
  if (row === undefined) throw new Error(`the recorded chart has no account ${number}`);
  return row;
}

/** Only 3xxx income accounts may reach the revenue picker; a 4xxx expense account must not. */
const REVENUE = account('3000');
const EXPENSE = account('4000');

const ACTIVE_ITEMS = [
  {
    id: 'i1',
    name: 'Beratung',
    defaultUnitPriceMinor: 15000,
    currency: 'CHF',
    defaultTaxCode: 'V81',
    revenueAccountId: REVENUE.id,
    unit: 'h',
    archived: false,
  },
  {
    id: 'i2',
    name: 'Workshop',
    defaultUnitPriceMinor: 120000,
    currency: 'CHF',
    unit: 'Stk',
    archived: false,
  },
];

const ARCHIVED_ITEM = {
  id: 'i3',
  name: 'Altprodukt',
  defaultUnitPriceMinor: 5000,
  currency: 'CHF',
  archived: true,
};

const SAMPLE_VAT = [{ code: 'V81', label: '8.1% Normalsatz' }];

function renderItems(canned: Canned, workspaceId: string | null = 'ws_test') {
  const client = new TillClient(fakeTransport(canned));
  return render(
    <TillClientProvider client={client}>
      <I18nProvider>
        <WorkspaceProvider initialId={workspaceId}>
          <MemoryRouter>
            <Items />
          </MemoryRouter>
        </WorkspaceProvider>
      </I18nProvider>
    </TillClientProvider>,
  );
}

const happyCanned = (): Canned => ({
  list_items: (input) =>
    ok({ items: input.includeArchived === true ? [...ACTIVE_ITEMS, ARCHIVED_ITEM] : ACTIVE_ITEMS }),
  list_accounts: ok({ accounts: SAMPLE_ACCOUNTS }),
  vat_codes: ok({ taxCodes: SAMPLE_VAT }),
});

/**
 * Real content on screen AND nothing still announcing itself busy.
 *
 * AXE MUST RUN ON A SETTLED SURFACE. Auditing the first frame audits the skeleton, and a skeleton
 * has no drawer, no form controls and no roles to get wrong: it passes whatever the finished render
 * would have failed. The browser harness's `waitForPaintToSettle`
 * (`.claude/ui-tests/lib/audit-tools.cjs`) drives `document.getAnimations()` through Playwright and
 * cannot run in jsdom, so this is the jsdom-shaped equivalent of the same claim.
 *
 * `findAllByText` rather than `findByText`, unlike the twin in `BankAccounts.test.tsx`: a drawer
 * anchor is a field label, and a label may legitimately repeat elsewhere on the surface. Requiring
 * uniqueness there would fail the probe rather than the code.
 */
async function settled(container: HTMLElement, anchor: string): Promise<void> {
  await screen.findAllByText(anchor);
  await waitFor(() => {
    expect(container.querySelectorAll('[aria-busy="true"]')).toHaveLength(0);
  });
}

describe('Items, five states', () => {
  it('shows a loading skeleton while the list resolves', async () => {
    const transport = watchReads(neverSettles);
    const client = new TillClient(transport);
    render(
      <TillClientProvider client={client}>
        <I18nProvider>
          <WorkspaceProvider initialId="ws_test">
            <MemoryRouter>
              <Items />
            </MemoryRouter>
          </WorkspaceProvider>
        </I18nProvider>
      </TillClientProvider>,
    );
    // The skeleton is the surface's first commit, so it proves nothing on its own: wait for the read
    // to be genuinely in flight before calling this a loading state.
    await transport.started('list_items');
    expect(screen.getByRole('status')).toHaveAttribute('aria-busy', 'true');
  });

  it('renders a no-workspace empty state without calling any ctx verb', async () => {
    const listSpy = vi.fn<CannedHandler>(() => ok({ items: [] }));
    renderItems({ list_items: listSpy, list_accounts: ok(), vat_codes: ok() }, null);
    expect(await screen.findByText('Kein Arbeitsbereich vorhanden')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Arbeitsbereich einrichten' })).toHaveAttribute(
      'href',
      '/setup',
    );
    expect(listSpy).not.toHaveBeenCalled();
  });

  it('renders the "no items yet" empty state with a primary CTA', async () => {
    renderItems({ list_items: ok({ items: [] }), list_accounts: ok(), vat_codes: ok() });
    expect(await screen.findByText('Noch keine Artikel.')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Neuer Artikel' }).length).toBeGreaterThan(0);
  });

  it('renders an empty state when a search matches nothing', async () => {
    renderItems(happyCanned());
    await screen.findByText('Beratung');
    await userEvent.type(screen.getByPlaceholderText('Artikel suchen'), 'zzznomatch');
    expect(await screen.findByText('Kein Artikel passt zur Suche.')).toBeInTheDocument();
  });

  it('renders an error banner when list_items rejects', async () => {
    renderItems({ list_items: reject('invalid_input'), list_accounts: ok(), vat_codes: ok() });
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });

  it('renders a permission-denied state on permission_denied', async () => {
    renderItems({ list_items: reject('permission_denied', 403), list_accounts: ok(), vat_codes: ok() });
    expect(await screen.findByRole('heading', { name: 'Kein Zugriff' })).toBeInTheDocument();
  });

  it('renders the item list and formats the price via formatMoney', async () => {
    renderItems(happyCanned());
    expect(await screen.findByText('Beratung')).toBeInTheDocument();
    expect(screen.getByText('Workshop')).toBeInTheDocument();
    // Price renders through the shared money helper, not a raw minor-unit integer.
    expect(screen.getByText('CHF 150.00')).toBeInTheDocument();
    expect(screen.getByText("CHF 1'200.00")).toBeInTheDocument();
    // The archived row is excluded until the operator opts in.
    expect(screen.queryByText('Altprodukt')).not.toBeInTheDocument();
  });

  it('surfaces archived rows, muted, when "show archived" is toggled', async () => {
    renderItems(happyCanned());
    await screen.findByText('Beratung');
    await userEvent.click(screen.getByLabelText('Archivierte anzeigen'));
    // The catalog is the shared DataTable now (D118 B2), so a row is a <tr>. The archived row reads
    // muted: its name steps down to the faint ink (`item-name--muted`), and it carries the tag.
    const nameEl = await screen.findByText('Altprodukt');
    const row = nameEl.closest('tr') as HTMLElement;
    expect(nameEl).toHaveClass('item-name--muted');
    expect(within(row).getByText('Archiviert')).toBeInTheDocument();
  });

  it('has no axe violations on the success render', async () => {
    const { container } = renderItems(happyCanned());
    await screen.findByText('Beratung');
    const results = await axe(container, {
      rules: { region: { enabled: false }, 'page-has-heading-one': { enabled: false } },
    });
    expect(results).toHaveNoViolations();
  });
});

describe('Items, the tax column (K-19)', () => {
  it('shows the short rate in the cell and the full code name in a real tooltip', async () => {
    renderItems(happyCanned());
    const row = await screen.findByRole('row', { name: 'Beratung' });
    const cell = within(row).getByText('8.1%');
    // The long name no longer sits in the cell (it wrapped to three lines and set the row height).
    expect(within(row).queryByText('8.1% Normalsatz', { selector: '.item-tax' })).toBeNull();
    const tip = document.getElementById(cell.getAttribute('aria-describedby') ?? '');
    expect(tip).toHaveAttribute('role', 'tooltip');
    expect(tip).toHaveTextContent('8.1% Normalsatz');
  });

  it('reads the rate off the engine basis points first, then the label, then the code', () => {
    expect(shortTaxCode({ code: 'UN81', label: 'Umsatzsteuer (Normalsatz)', rateBp: 810 }, 'UN81')).toBe('8.1%');
    expect(shortTaxCode({ code: 'UN0', label: 'Befreit', rateBp: 0 }, 'UN0')).toBe('0%');
    expect(shortTaxCode({ code: 'V26', label: 'Reduziert 2.6 %' }, 'V26')).toBe('2.6%');
    expect(shortTaxCode(undefined, 'XX')).toBe('XX');
  });
});

describe('ItemEditor', () => {
  it('creates an item and calls create_item with an integer-Rappen price', async () => {
    const createSpy = vi.fn<CannedHandler>(() => ok({ itemId: 'new1' }));
    renderItems({ ...happyCanned(), create_item: createSpy });
    await screen.findByText('Beratung');

    await userEvent.click(screen.getByRole('button', { name: 'Neuer Artikel' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Bezeichnung'), 'Fotografie');
    await userEvent.type(within(dialog).getByLabelText('Verkaufspreis'), '150.50');
    // D00: unit is the ITEM_UNITS enum, so it is a select. 'hour' renders as 'Stunde'.
    await userEvent.click(within(dialog).getByRole('combobox', { name: 'Einheit' }));
    await userEvent.click(screen.getByRole('option', { name: 'Stunde' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Speichern' }));

    await waitFor(() => expect(createSpy).toHaveBeenCalledOnce());
    expect(createSpy.mock.calls[0][0]).toMatchObject({
      workspaceId: 'ws_test',
      name: 'Fotografie',
      defaultUnitPriceMinor: 15050,
      unit: 'hour',
    });
  });

  it('lists only income accounts in the revenue-account picker', async () => {
    renderItems(happyCanned());
    await screen.findByText('Beratung');
    await userEvent.click(screen.getByRole('button', { name: 'Neuer Artikel' }));
    const dialog = await screen.findByRole('dialog');
    // The migrated <Select> paints its list only once open, portaled to <body>: open it, then read
    // the options from the named listbox.
    await userEvent.click(within(dialog).getByRole('combobox', { name: 'Ertragskonto' }));
    const options = within(screen.getByRole('listbox', { name: 'Ertragskonto' })).getAllByRole('option');
    // Corpus first: an empty picker would satisfy the absence assertion below on its own.
    expect(options.length).toBeGreaterThan(1);
    const named = options.map((option) => option.textContent ?? '');
    expect(named.some((text) => text.includes(REVENUE.name))).toBe(true);
    expect(named.some((text) => text.includes(EXPENSE.name))).toBe(false);
    // And no expense account at all reached it, not merely the one this test names.
    const offered = SAMPLE_ACCOUNTS.filter((a) => named.some((text) => text.includes(a.name)));
    expect(offered.every((a) => a.type === 'income')).toBe(true);
  });

  it('edits an item and calls update_item with a patch', async () => {
    const updateSpy = vi.fn<CannedHandler>(() => ok());
    renderItems({ ...happyCanned(), update_item: updateSpy });
    // K-21: the row itself opens the editor.
    await userEvent.click(await screen.findByRole('row', { name: 'Beratung' }));

    const dialog = await screen.findByRole('dialog');
    const name = within(dialog).getByLabelText('Bezeichnung');
    expect(name).toHaveValue('Beratung');
    await userEvent.clear(name);
    await userEvent.type(name, 'Beratung Senior');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Speichern' }));

    await waitFor(() => expect(updateSpy).toHaveBeenCalledOnce());
    expect(updateSpy.mock.calls[0][0]).toMatchObject({
      workspaceId: 'ws_test',
      itemId: 'i1',
      patch: { name: 'Beratung Senior' },
    });
  });

  it('surfaces invalid_revenue_account inline on the revenue field', async () => {
    renderItems({ ...happyCanned(), create_item: reject('invalid_revenue_account') });
    await screen.findByText('Beratung');
    await userEvent.click(screen.getByRole('button', { name: 'Neuer Artikel' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Bezeichnung'), 'Kaputt');
    await userEvent.type(within(dialog).getByLabelText('Verkaufspreis'), '10');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Speichern' }));
    expect(
      await within(dialog).findByText('Das Ertragskonto muss ein Ertragskonto (3xxx) sein.'),
    ).toBeInTheDocument();
  });

  it('surfaces unknown_tax_code inline on the VAT field', async () => {
    renderItems({ ...happyCanned(), create_item: reject('unknown_tax_code') });
    await screen.findByText('Beratung');
    await userEvent.click(screen.getByRole('button', { name: 'Neuer Artikel' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Bezeichnung'), 'Kaputt');
    await userEvent.type(within(dialog).getByLabelText('Verkaufspreis'), '10');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Speichern' }));
    expect(await within(dialog).findByText('Dieser MWST-Code ist unbekannt.')).toBeInTheDocument();
  });

  it('blocks a save with a blank name and never calls create_item', async () => {
    const createSpy = vi.fn<CannedHandler>(() => ok());
    renderItems({ ...happyCanned(), create_item: createSpy });
    await screen.findByText('Beratung');
    await userEvent.click(screen.getByRole('button', { name: 'Neuer Artikel' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Verkaufspreis'), '10');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Speichern' }));
    expect(createSpy).not.toHaveBeenCalled();
    expect(within(dialog).getByText('Bitte gib eine Bezeichnung ein.')).toBeInTheDocument();
  });

  /**
   * THE SURFACE'S ONLY OTHER axe BLOCK RUNS WITH THIS DRAWER CLOSED, so the drawer element has
   * never once entered the accessibility tree an audit reads. That is why the defect below survived
   * a green suite: not because the audit was wrong, because it was never pointed at the markup.
   */
  it('has no axe violations on a SETTLED open drawer', async () => {
    const { container } = renderItems(happyCanned());
    await settled(container, 'Beratung');

    await userEvent.click(screen.getByRole('button', { name: 'Neuer Artikel' }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    await settled(container, 'Verkaufspreis');

    const results = await axe(container, {
      rules: { region: { enabled: false }, 'page-has-heading-one': { enabled: false } },
    });
    expect(results).toHaveNoViolations();
  });
});

describe('Items, archive', () => {
  it('archives a row via archive_item', async () => {
    const archiveSpy = vi.fn<CannedHandler>(() => ok());
    renderItems({ ...happyCanned(), archive_item: archiveSpy });
    const row = (await screen.findByText('Beratung')).closest('tr') as HTMLElement;
    // D15/C2: Archive now lives one level down, behind the per-row overflow menu.
    await userEvent.click(
      within(row).getByRole('button', { name: 'Weitere Aktionen für Artikel Beratung' }),
    );
    await userEvent.click(within(row).getByRole('menuitem', { name: 'Archivieren' }));
    await waitFor(() => expect(archiveSpy).toHaveBeenCalledOnce());
    expect(archiveSpy.mock.calls[0][0]).toMatchObject({ workspaceId: 'ws_test', itemId: 'i1' });
  });
});
