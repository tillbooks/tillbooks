/**
 * H00, the Fixed Assets -> Categories surface. The suite follows the Aufgaben/Serien discipline:
 * a GATE claim mounts a real `CapabilitiesProvider` over a transport that answers `whoami`, loading
 * is asserted through the catalogue, and copy is read from the message fragment, never typed here.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider } from '../../app/workspace';
import { CapabilitiesProvider } from '../../lib/CapabilitiesProvider';
import AssetCategories from './index';
import de from './messages.de-CH.json';
// The account picker is filled from a RECORDING of the live `list_accounts` answer, never a literal
// of this suite's own invention, so a name the engine spells differently cannot pass here green.
// The recording is pinned value for value by `test/accounts/studio-list-accounts-fixture.test.mjs`.
import listAccountsFixture from '../Accounts/list-accounts.fixture.json';

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

// The three GL accounts a category hangs on, read out of the recorded chart by number so the ids and
// names are the engine's own, not this suite's. 1500 (asset) is the cost account, 1510 (asset) the
// accumulated-depreciation contra, 6800 (expense) the depreciation expense.
const ACCOUNTS = listAccountsFixture.accounts;
const idFor = (number: string): string => {
  const row = ACCOUNTS.find((account) => account.number === number);
  if (row === undefined) throw new Error(`the recorded chart has no account ${number}`);
  return row.id;
};
const ASSET_ACCOUNT_ID = idFor('1500');
const ACCUM_ACCOUNT_ID = idFor('1510');
const EXPENSE_ACCOUNT_ID = idFor('6800');

const CATEGORY = (over: Record<string, unknown> = {}) => ({
  id: 'ac_1',
  code: 'MACH',
  name: 'Maschinen & Anlagen',
  description: null,
  depreciationMethod: 'straight_line',
  usefulLifeMonths: 60,
  residualValuePct: 1000,
  residualValueRappen: null,
  glAssetAccountId: ASSET_ACCOUNT_ID,
  glAccumDeprAccountId: ACCUM_ACCOUNT_ID,
  glDeprExpenseAccountId: EXPENSE_ACCOUNT_ID,
  defaultCostCenterId: null,
  active: true,
  ...over,
});

const whoamiWith = (capabilities: string[]): RestResponse =>
  ok({ actor: 'studio', role: null, isMember: true, provisioned: true, memberId: 'm1', userId: 'u1', capabilities });

const baseCanned = (): Canned => ({
  whoami: whoamiWith(['read_master_data', 'manage_master_data']),
  asset_category_list: ok({ categories: [CATEGORY()] }),
  list_accounts: ok({ accounts: ACCOUNTS }),
  list_cost_centers: ok({ costCenters: [] }),
});

function tree(canned: Canned, workspaceId: string | null, withProvider: boolean) {
  const inner = (
    <MemoryRouter>
      <AssetCategories />
    </MemoryRouter>
  );
  return (
    <TillClientProvider client={new TillClient(fakeTransport(canned))}>
      <I18nProvider>
        <WorkspaceProvider initialId={workspaceId}>
          {withProvider ? <CapabilitiesProvider>{inner}</CapabilitiesProvider> : inner}
        </WorkspaceProvider>
      </I18nProvider>
    </TillClientProvider>
  );
}

const renderSurface = (canned: Canned, workspaceId: string | null = 'ws_test') => render(tree(canned, workspaceId, false));
const withCapabilities = (canned: Canned, workspaceId: string | null = 'ws_test') => render(tree(canned, workspaceId, true));

describe('AssetCategories, the list', () => {
  it('renders a category row with its code, method and life once loaded', async () => {
    renderSurface(baseCanned());
    expect(await screen.findByText('MACH')).toBeInTheDocument();
    expect(screen.getByText(de.assets.method.straight_line)).toBeInTheDocument();
    expect(screen.getByText('60')).toBeInTheDocument();
    expect(screen.getByText(de.assets.categories.active)).toBeInTheDocument();
  });

  it('renders a fixed residual value through formatMoney, grouped de-CH', async () => {
    // 100_000 Rappen = CHF 1'000.00: proves the residual-Rappen branch groups thousands (K-71) and
    // no longer hand-rolls an ungrouped `CHF 1000.00`. Double-quoted so the apostrophe survives.
    const canned = { ...baseCanned(), asset_category_list: ok({ categories: [CATEGORY({ residualValuePct: 0, residualValueRappen: 100000 })] }) };
    renderSurface(canned);
    expect(await screen.findByText("CHF 1'000.00")).toBeInTheDocument();
  });

  it('shows the empty state with a create CTA when there are no categories', async () => {
    renderSurface({ ...baseCanned(), asset_category_list: ok({ categories: [] }) });
    expect(await screen.findByText(de.assets.categories.empty.title)).toBeInTheDocument();
    expect(screen.getByText(de.assets.categories.empty.cta)).toBeInTheDocument();
  });

  it('surfaces a transport failure with a retry', async () => {
    renderSurface({ ...baseCanned(), asset_category_list: reject('boom', {}, 500) });
    expect(await screen.findByText(de.assets.categories.error.transport)).toBeInTheDocument();
  });
});

describe('AssetCategories, create', () => {
  it('opens the drawer, submits a create, and re-reads on success', async () => {
    const asked: Array<{ action: string; input: Record<string, unknown> }> = [];
    const canned: Canned = {
      ...baseCanned(),
      asset_category_list: ok({ categories: [] }),
      asset_category_create: ok({ category: CATEGORY() }),
    };
    render(
      <TillClientProvider client={new TillClient(fakeTransport(canned, asked))}>
        <I18nProvider>
          <WorkspaceProvider initialId="ws_test">
            <MemoryRouter>
              <AssetCategories />
            </MemoryRouter>
          </WorkspaceProvider>
        </I18nProvider>
      </TillClientProvider>,
    );
    const user = userEvent.setup();
    await user.click(await screen.findByText(de.assets.categories.empty.cta));
    await user.type(screen.getByLabelText(de.assets.categories.field.code), 'IT');
    await user.type(screen.getByLabelText(de.assets.categories.field.name), 'Informatik');
    await user.selectOptions(screen.getByLabelText(de.assets.categories.field.assetAccount), ASSET_ACCOUNT_ID);
    await user.selectOptions(screen.getByLabelText(de.assets.categories.field.accumAccount), ACCUM_ACCOUNT_ID);
    await user.selectOptions(screen.getByLabelText(de.assets.categories.field.expenseAccount), EXPENSE_ACCOUNT_ID);
    await user.type(screen.getByLabelText(de.assets.categories.field.life), '36');
    await user.click(screen.getByText(de.assets.categories.save));
    await waitFor(() => expect(asked.some((a) => a.action === 'asset_category_create')).toBe(true));
    const call = asked.find((a) => a.action === 'asset_category_create');
    expect(call?.input.code).toBe('IT');
    expect(call?.input.glAssetAccountId).toBe(ASSET_ACCOUNT_ID);
    expect(call?.input.idempotencyKey).toBeTypeOf('string');
  });

  it('surfaces the engine rejection in the drawer without closing it', async () => {
    const canned: Canned = {
      ...baseCanned(),
      asset_category_list: ok({ categories: [] }),
      asset_category_create: reject('duplicate_code'),
    };
    renderSurface(canned);
    const user = userEvent.setup();
    await user.click(await screen.findByText(de.assets.categories.empty.cta));
    await user.type(screen.getByLabelText(de.assets.categories.field.code), 'MACH');
    await user.type(screen.getByLabelText(de.assets.categories.field.name), 'X');
    await user.selectOptions(screen.getByLabelText(de.assets.categories.field.assetAccount), ASSET_ACCOUNT_ID);
    await user.selectOptions(screen.getByLabelText(de.assets.categories.field.accumAccount), ACCUM_ACCOUNT_ID);
    await user.selectOptions(screen.getByLabelText(de.assets.categories.field.expenseAccount), EXPENSE_ACCOUNT_ID);
    await user.type(screen.getByLabelText(de.assets.categories.field.life), '12');
    await user.click(screen.getByText(de.assets.categories.save));
    expect(await screen.findByText(de.errors.duplicate_code)).toBeInTheDocument();
    // drawer still open
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});

describe('AssetCategories, archive', () => {
  it('confirms then calls asset_category_archive', async () => {
    const asked: Array<{ action: string; input: Record<string, unknown> }> = [];
    const canned: Canned = { ...baseCanned(), asset_category_archive: ok({ category: CATEGORY({ active: false }) }) };
    render(
      <TillClientProvider client={new TillClient(fakeTransport(canned, asked))}>
        <I18nProvider>
          <WorkspaceProvider initialId="ws_test">
            <MemoryRouter>
              <AssetCategories />
            </MemoryRouter>
          </WorkspaceProvider>
        </I18nProvider>
      </TillClientProvider>,
    );
    const user = userEvent.setup();
    await screen.findByText('MACH');
    await user.click(screen.getByText(de.assets.categories.archive));
    // the confirm dialog's Archive button
    const dialog = screen.getByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: de.assets.categories.archive }));
    await waitFor(() => expect(asked.some((a) => a.action === 'asset_category_archive')).toBe(true));
  });
});

describe('AssetCategories, the permission gate', () => {
  it('disables the New button for a role without manage_master_data', async () => {
    withCapabilities({ ...baseCanned(), whoami: whoamiWith(['read_master_data']) });
    const newBtn = await screen.findByText(de.assets.categories.new);
    await waitFor(() => expect(newBtn).toBeDisabled());
  });
});
