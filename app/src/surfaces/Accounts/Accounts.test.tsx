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
import Accounts from './index';

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
 * The chart these tests render is a RECORDING of the live `list_accounts` answer, captured by
 * `test/accounts/capture-studio-list-accounts.mjs` and pinned by
 * `test/accounts/studio-list-accounts-fixture.test.mjs`.
 *
 * It used to be six hand-typed rows, and every name in them was wrong: `Kasse` for `Kassenbestand`,
 * `Bank` for `Bankkonto`, `Kreditoren` for `Verbindlichkeiten aus Lieferungen und Leistungen`. The
 * suite was green against a chart of accounts no user has ever seen.
 */
import listAccountsFixture from './list-accounts.fixture.json';

const SAMPLE_ACCOUNTS = listAccountsFixture.accounts;

/** An account row from the recording, by its number. Throws rather than rendering `undefined`. */
function account(number: string) {
  const row = SAMPLE_ACCOUNTS.find((a) => a.number === number);
  if (row === undefined) throw new Error(`the recorded chart has no account ${number}`);
  return row;
}

/** 1000 carries the recording's one posted entry; 1020 carries none. */
const IN_USE = account('1000');
const FREE = account('1020');
const EQUITY = account('2979');

const SAMPLE_COST_CENTERS = [
  { id: 'c1', code: 'KST-100', name: 'Projekt Alpha', inUse: true },
  { id: 'c2', code: 'KST-200', name: 'Projekt Beta', inUse: false },
];

const SAMPLE_VAT = [{ code: 'V81', label: '8.1% Normalsatz' }];

function renderAccounts(canned: Canned, workspaceId: string | null = 'ws_test') {
  const client = new TillClient(fakeTransport(canned));
  return render(
    <TillClientProvider client={client}>
      <I18nProvider>
        <WorkspaceProvider initialId={workspaceId}>
          <MemoryRouter>
            <Accounts />
          </MemoryRouter>
        </WorkspaceProvider>
      </I18nProvider>
    </TillClientProvider>,
  );
}

const happyCanned = (): Canned => ({
  list_accounts: ok({ accounts: SAMPLE_ACCOUNTS }),
  list_cost_centers: ok({ costCenters: SAMPLE_COST_CENTERS }),
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

describe('Accounts, five states', () => {
  it('shows a loading skeleton while the list resolves', async () => {
    // A transport that never resolves keeps the surface in its loading state.
    const transport = watchReads(neverSettles);
    const client = new TillClient(transport);
    render(
      <TillClientProvider client={client}>
        <I18nProvider>
          <WorkspaceProvider initialId="ws_test">
            <MemoryRouter>
              <Accounts />
            </MemoryRouter>
          </WorkspaceProvider>
        </I18nProvider>
      </TillClientProvider>,
    );
    // `loading` starts true, so the skeleton is on screen before any effect has fired: asserting it
    // straight after render says nothing about the read. The wait is what makes this a LOADING test
    // rather than a first-commit test, and it fails by name if the surface stops asking at all.
    await transport.started('list_accounts');
    expect(screen.getByRole('status')).toHaveAttribute('aria-busy', 'true');
  });

  it('renders a no-workspace empty state without calling any ctx verb', async () => {
    const listSpy = vi.fn<CannedHandler>(() => ok({ accounts: [] }));
    renderAccounts({ list_accounts: listSpy, list_cost_centers: ok(), vat_codes: ok() }, null);
    expect(await screen.findByText('Kein Arbeitsbereich vorhanden')).toBeInTheDocument();
    // The state is never a dead end: it always offers the way to /setup.
    expect(screen.getByRole('link', { name: 'Arbeitsbereich einrichten' })).toHaveAttribute(
      'href',
      '/setup',
    );
    expect(listSpy).not.toHaveBeenCalled();
  });

  it('separates a no-match search from an empty chart, and offers clear-search', async () => {
    renderAccounts(happyCanned());
    await screen.findByText(IN_USE.name);
    await userEvent.type(screen.getByPlaceholderText('Konten suchen'), 'zzznomatch');

    // It must NOT claim the workspace has no accounts: it has the whole KMU chart, the search is
    // what is hiding them. And the way out is to drop the search, not to create another account.
    expect(await screen.findByText('Kein Konto passt zur Suche.')).toBeInTheDocument();
    expect(screen.queryByText('Noch keine Konten.')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Suche zurücksetzen' }));
    expect(await screen.findByText(IN_USE.name)).toBeInTheDocument();
  });

  it('still shows the create-first empty state when the workspace really has no accounts', async () => {
    renderAccounts({ list_accounts: ok({ accounts: [] }), list_cost_centers: ok(), vat_codes: ok() });
    expect(await screen.findByText('Noch keine Konten.')).toBeInTheDocument();
    // The header action and the empty-state first action, both inviting the same first step.
    expect(screen.getAllByRole('button', { name: 'Neues Konto' })).toHaveLength(2);
  });

  it('renders an error banner when list_accounts rejects', async () => {
    renderAccounts({
      list_accounts: reject('invalid_input'),
      list_cost_centers: ok(),
      vat_codes: ok(),
    });
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });

  it('renders a permission-denied state on permission_denied', async () => {
    renderAccounts({
      list_accounts: reject('permission_denied', 403),
      list_cost_centers: ok(),
      vat_codes: ok(),
    });
    expect(await screen.findByRole('heading', { name: 'Kein Zugriff' })).toBeInTheDocument();
  });

  it('renders the grouped account list on success', async () => {
    renderAccounts(happyCanned());
    expect(await screen.findByRole('heading', { name: 'Aktiven', level: 2 })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Passiven', level: 2 })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Eigenkapital', level: 2 })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Ertrag', level: 2 })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Aufwand', level: 2 })).toBeInTheDocument();
    // The equity block (2979) buckets into Eigenkapital, not Passiven.
    expect(screen.getByText(EQUITY.name)).toBeInTheDocument();
    expect(screen.getByText(IN_USE.name)).toBeInTheDocument();
  });

  it('has no axe violations on the success render', async () => {
    const { container } = renderAccounts(happyCanned());
    await screen.findByRole('heading', { name: 'Aktiven', level: 2 });
    const results = await axe(container, {
      rules: { region: { enabled: false }, 'page-has-heading-one': { enabled: false } },
    });
    expect(results).toHaveNoViolations();
  });
});

describe('Accounts, Archive-XOR-Delete exclusivity', () => {
  it('offers Archive (not Delete) for an in-use account', async () => {
    renderAccounts(happyCanned());
    const row = (await screen.findByText(IN_USE.name)).closest('li') as HTMLElement;
    // K-21: the account name itself opens the edit drawer.
    // D15/C2: both verbs live behind the per-row overflow, so exclusivity is asserted INSIDE it.
    await userEvent.click(
      within(row).getByRole('button', { name: /Weitere Aktionen für Konto 1000/ }),
    );
    expect(within(row).getByRole('menuitem', { name: 'Archivieren' })).toBeInTheDocument();
    expect(within(row).queryByRole('menuitem', { name: 'Löschen' })).not.toBeInTheDocument();
  });

  it('offers Delete (not Archive) for a never-posted account, gated by a confirm', async () => {
    const deleteSpy = vi.fn<CannedHandler>(() => ok());
    renderAccounts({ ...happyCanned(), delete_account: deleteSpy });
    const row = (await screen.findByText(FREE.name)).closest('li') as HTMLElement;
    await userEvent.click(
      within(row).getByRole('button', { name: /Weitere Aktionen für Konto 1020/ }),
    );
    expect(within(row).queryByRole('menuitem', { name: 'Archivieren' })).not.toBeInTheDocument();
    await userEvent.click(within(row).getByRole('menuitem', { name: 'Löschen' }));

    // Confirm dialog appears; delete has not fired yet.
    const dialog = await screen.findByRole('alertdialog');
    expect(deleteSpy).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Löschen' }));
    await waitFor(() => expect(deleteSpy).toHaveBeenCalledOnce());
    expect(deleteSpy.mock.calls[0][0]).toMatchObject({ workspaceId: 'ws_test', accountId: FREE.id });
  });
});

describe('AccountDrawer', () => {
  it('creates an account and calls create_account', async () => {
    const createSpy = vi.fn<CannedHandler>(() => ok({ accountId: 'new1' }));
    renderAccounts({ ...happyCanned(), create_account: createSpy });
    await screen.findByText(IN_USE.name);

    await userEvent.click(screen.getByRole('button', { name: 'Neues Konto' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Nummer'), '3400');
    await userEvent.type(within(dialog).getByLabelText('Bezeichnung'), 'Beratungsertrag');
    await userEvent.click(within(dialog).getByRole('combobox', { name: 'Typ' }));
    await userEvent.click(screen.getByRole('option', { name: 'Ertrag' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Speichern' }));

    await waitFor(() => expect(createSpy).toHaveBeenCalledOnce());
    expect(createSpy.mock.calls[0][0]).toMatchObject({
      workspaceId: 'ws_test',
      number: '3400',
      name: 'Beratungsertrag',
      type: 'income',
    });
  });

  it('surfaces duplicate_number inline on the number field', async () => {
    renderAccounts({ ...happyCanned(), create_account: reject('duplicate_number') });
    await screen.findByText(IN_USE.name);

    await userEvent.click(screen.getByRole('button', { name: 'Neues Konto' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Nummer'), '1000');
    await userEvent.type(within(dialog).getByLabelText('Bezeichnung'), 'Duplikat');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Speichern' }));

    expect(await within(dialog).findByText('Diese Kontonummer ist bereits vergeben.')).toBeInTheDocument();
  });

  it('freezes number and type in edit mode and calls update_account', async () => {
    const updateSpy = vi.fn<CannedHandler>(() => ok());
    renderAccounts({
      ...happyCanned(),
      update_account: updateSpy,
      account_set_tax_default: ok(),
    });
    const row = (await screen.findByText(IN_USE.name)).closest('li') as HTMLElement;
    // K-21: the account name itself opens the edit drawer.
    await userEvent.click(within(row).getByRole('button', { name: /bearbeiten$/ }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText('Nummer')).toBeDisabled();
    expect(within(dialog).getByLabelText('Typ')).toBeDisabled();

    const name = within(dialog).getByLabelText('Bezeichnung');
    await userEvent.clear(name);
    await userEvent.type(name, 'Kasse CHF');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Speichern' }));

    await waitFor(() => expect(updateSpy).toHaveBeenCalledOnce());
    expect(updateSpy.mock.calls[0][0]).toMatchObject({ accountId: IN_USE.id, name: 'Kasse CHF' });
  });

  /**
   * THE SURFACE'S ONLY OTHER axe BLOCK RUNS WITH THIS DRAWER CLOSED, so the drawer element has
   * never once entered the accessibility tree an audit reads. That is why the defect below survived
   * a green suite: not because the audit was wrong, because it was never pointed at the markup.
   */
  it('has no axe violations on a SETTLED open drawer', async () => {
    const { container } = renderAccounts(happyCanned());
    await settled(container, IN_USE.name);

    await userEvent.click(screen.getByRole('button', { name: 'Neues Konto' }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    await settled(container, 'Bezeichnung');

    const results = await axe(container, {
      rules: { region: { enabled: false }, 'page-has-heading-one': { enabled: false } },
    });
    expect(results).toHaveNoViolations();
  });
});

describe('CostCenterSection', () => {
  it('renders cost centres with exclusive Archive-XOR-Delete and creates one', async () => {
    const createSpy = vi.fn<CannedHandler>(() => ok({ costCenterId: 'c3' }));
    renderAccounts({ ...happyCanned(), create_cost_center: createSpy });
    await screen.findByText(IN_USE.name);

    const section = screen.getByRole('region', { name: 'Kostenstellen' });
    // In-use cost centre offers Archive; unused one offers Delete.
    const inUseRow = within(section).getByText('Projekt Alpha').closest('li') as HTMLElement;
    await userEvent.click(
      within(inUseRow).getByRole('button', { name: /Weitere Aktionen für Kostenstelle/ }),
    );
    expect(within(inUseRow).getByRole('menuitem', { name: 'Archivieren' })).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    const freeRow = within(section).getByText('Projekt Beta').closest('li') as HTMLElement;
    await userEvent.click(
      within(freeRow).getByRole('button', { name: /Weitere Aktionen für Kostenstelle/ }),
    );
    expect(within(freeRow).getByRole('menuitem', { name: 'Löschen' })).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');

    await userEvent.click(within(section).getByRole('button', { name: 'Neue Kostenstelle' }));
    await userEvent.type(within(section).getByLabelText('Code'), 'KST-300');
    await userEvent.type(within(section).getByLabelText('Bezeichnung'), 'Projekt Gamma');
    await userEvent.click(within(section).getByRole('button', { name: 'Speichern' }));

    await waitFor(() => expect(createSpy).toHaveBeenCalledOnce());
    expect(createSpy.mock.calls[0][0]).toMatchObject({ code: 'KST-300', name: 'Projekt Gamma' });
  });
});
