/**
 * H01, the Fixed Assets -> Register surface. Follows the AssetCategories discipline: a GATE claim
 * mounts a real `CapabilitiesProvider` over a transport that answers `whoami`, loading is asserted
 * through the catalogue, and copy is read from the message fragment, never typed here.
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
import { AssetRegister } from './AssetRegister';
import de from './messages.de-CH.json';
// The credit-account picker is filled from a RECORDING of the live list_accounts answer, pinned by
// test/accounts/studio-list-accounts-fixture.test.mjs, never hand-typed (the recording discipline).
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

const CAT = { id: 'ac_1', code: 'MACH', name: 'Maschinen' };

const ASSET = (over: Record<string, unknown> = {}) => ({
  id: 'as_1',
  number: 'FA-0001',
  name: 'CNC Fräsmaschine',
  categoryId: 'ac_1',
  status: 'draft',
  acquisitionDate: '2026-03-15',
  acquisitionCostRappen: 12500000,
  residualValueRappen: 1250000,
  usefulLifeMonths: 60,
  depreciationMethod: 'straight_line',
  glAssetAccountId: 'a1',
  glAccumDeprAccountId: 'a2',
  glDeprExpenseAccountId: 'a3',
  serialNumber: null,
  barcode: null,
  manufacturer: null,
  model: null,
  warrantyUntil: null,
  notes: null,
  accumulatedDeprRappen: 0,
  netBookValueRappen: 12500000,
  ...over,
});

const whoamiWith = (capabilities: string[]): RestResponse =>
  ok({ actor: 'studio', role: null, isMember: true, provisioned: true, memberId: 'm1', userId: 'u1', capabilities });

const SAMPLE_ACCOUNTS = listAccountsFixture.accounts;
// A bank (asset) account and a creditor (liability) from the recording, used as credit accounts.
const BANK_ID = SAMPLE_ACCOUNTS.find((a) => a.number === '1020')!.id;
const CREDITOR_ID = SAMPLE_ACCOUNTS.find((a) => a.number === '2000')!.id;

const baseCanned = (): Canned => ({
  whoami: whoamiWith(['read_master_data', 'manage_master_data', 'post', 'read_books']),
  asset_list: ok({ assets: [ASSET()], total: 1 }),
  asset_category_list: ok({ categories: [CAT] }),
  list_accounts: ok({ accounts: SAMPLE_ACCOUNTS }),
});

function tree(canned: Canned, workspaceId: string | null, withProvider: boolean, asked?: Array<{ action: string; input: Record<string, unknown> }>) {
  const inner = (
    <MemoryRouter>
      <AssetRegister />
    </MemoryRouter>
  );
  return (
    <TillClientProvider client={new TillClient(fakeTransport(canned, asked))}>
      <I18nProvider>
        <WorkspaceProvider initialId={workspaceId}>
          {withProvider ? <CapabilitiesProvider>{inner}</CapabilitiesProvider> : inner}
        </WorkspaceProvider>
      </I18nProvider>
    </TillClientProvider>
  );
}

const renderSurface = (canned: Canned, asked?: Array<{ action: string; input: Record<string, unknown> }>) =>
  render(tree(canned, 'ws_test', false, asked));
const withCapabilities = (canned: Canned) => render(tree(canned, 'ws_test', true));

/**
 * Open a migrated <Select> combobox by its accessible name and click the option carrying `value`.
 * The listbox is portaled to <body>, so the option is queried from `screen`, by its data-value.
 */
async function pickOption(
  user: ReturnType<typeof userEvent.setup>,
  comboName: string,
  value: string,
): Promise<void> {
  await user.click(screen.getByRole('combobox', { name: comboName }));
  const option = screen.getAllByRole('option').find((o) => o.getAttribute('data-value') === value);
  if (option === undefined) throw new Error(`no option with value ${value}`);
  await user.click(option);
}

/**
 * A row verb lives behind the row's one overflow (K-21): wait for the row, open its overflow, pick
 * the item by its visible label.
 */
async function rowVerb(user: ReturnType<typeof userEvent.setup>, label: string): Promise<void> {
  await user.click(await screen.findByRole('button', { name: /^Aktionen für Anlage/ }));
  await user.click(screen.getByRole('menuitem', { name: label }));
}

describe('AssetRegister, the list', () => {
  it('renders an asset row with its number, name and status once loaded', async () => {
    renderSurface(baseCanned());
    expect(await screen.findByText('FA-0001')).toBeInTheDocument();
    expect(screen.getByText('CNC Fräsmaschine')).toBeInTheDocument();
    // the status is the shared Status word in the row (K-22); the same label is also a filter option
    const row = screen.getByText('FA-0001').closest('tr') as HTMLElement;
    expect(within(row).getByText(de.assets.status.draft)).toBeInTheDocument();
    // the acquisition date is the house format, never the ISO value (K-38)
    expect(within(row).getByText('15.03.2026')).toBeInTheDocument();
    // cost rendered in CHF major units (cost and NBV both read 125000.00 for a fresh asset)
    expect(screen.getAllByText("CHF 125'000.00").length).toBe(2);
  });

  it('shows the empty state with a create CTA when there are assets-none but a category exists', async () => {
    renderSurface({ ...baseCanned(), asset_list: ok({ assets: [], total: 0 }) });
    expect(await screen.findByText(de.assets.register.empty.title)).toBeInTheDocument();
    expect(screen.getByText(de.assets.register.empty.cta)).toBeInTheDocument();
  });

  it('shows the no-categories empty state when no category exists yet', async () => {
    renderSurface({
      ...baseCanned(),
      asset_list: ok({ assets: [], total: 0 }),
      asset_category_list: ok({ categories: [] }),
    });
    expect(await screen.findByText(de.assets.register.empty.noCatTitle)).toBeInTheDocument();
    // the New button is disabled without a category
    expect(screen.getByText(de.assets.register.new)).toBeDisabled();
  });

  it('surfaces a transport failure with a retry', async () => {
    renderSurface({ ...baseCanned(), asset_list: reject('boom', {}, 500) });
    expect(await screen.findByText(de.assets.register.error.transport)).toBeInTheDocument();
  });
});

describe('AssetRegister, create', () => {
  it('resolves category defaults on pick, submits a create with cost converted to Rappen', async () => {
    const asked: Array<{ action: string; input: Record<string, unknown> }> = [];
    const canned: Canned = {
      ...baseCanned(),
      asset_list: ok({ assets: [], total: 0 }),
      asset_category_resolve_defaults: ok({
        defaults: { depreciationMethod: 'straight_line', usefulLifeMonths: 60, residualValuePct: 1000 },
      }),
      asset_create: ok({ asset: ASSET() }),
    };
    renderSurface(canned, asked);
    const user = userEvent.setup();
    await user.click(await screen.findByText(de.assets.register.empty.cta));
    await pickOption(user, de.assets.register.field.category, 'ac_1');
    await waitFor(() => expect(asked.some((a) => a.action === 'asset_category_resolve_defaults')).toBe(true));
    await user.type(screen.getByLabelText(de.assets.register.field.name), 'CNC');
    // the date input is a native date field
    const dateInput = screen.getByLabelText(de.assets.register.field.acquired);
    await user.type(dateInput, '2026-03-15');
    await user.type(screen.getByLabelText(de.assets.register.field.cost), '125000');
    await user.click(screen.getByText(de.assets.register.save));
    await waitFor(() => expect(asked.some((a) => a.action === 'asset_create')).toBe(true));
    const call = asked.find((a) => a.action === 'asset_create');
    expect(call?.input.categoryId).toBe('ac_1');
    expect(call?.input.acquisitionCostRappen).toBe(12500000);
    expect(call?.input.idempotencyKey).toBeTypeOf('string');
  });

  it('surfaces the engine rejection in the drawer without closing it', async () => {
    const canned: Canned = {
      ...baseCanned(),
      asset_list: ok({ assets: [], total: 0 }),
      asset_category_resolve_defaults: ok({ defaults: { depreciationMethod: 'straight_line', usefulLifeMonths: 60 } }),
      asset_create: reject('duplicate_number'),
    };
    renderSurface(canned);
    const user = userEvent.setup();
    await user.click(await screen.findByText(de.assets.register.empty.cta));
    await pickOption(user, de.assets.register.field.category, 'ac_1');
    await user.type(screen.getByLabelText(de.assets.register.field.name), 'CNC');
    await user.type(screen.getByLabelText(de.assets.register.field.acquired), '2026-03-15');
    await user.type(screen.getByLabelText(de.assets.register.field.cost), '100');
    await user.click(screen.getByText(de.assets.register.save));
    expect(await screen.findByText(de.errors.duplicate_number)).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});

describe('AssetRegister, the financial-field lock', () => {
  it('disables the financial inputs and shows the lock note when editing an active asset', async () => {
    renderSurface({ ...baseCanned(), asset_list: ok({ assets: [ASSET({ status: 'active' })], total: 1 }) });
    const user = userEvent.setup();
    await rowVerb(user, de.assets.register.edit);
    expect(screen.getByText(de.assets.register.form.locked)).toBeInTheDocument();
    expect(screen.getByLabelText(de.assets.register.field.cost)).toBeDisabled();
    expect(screen.getByLabelText(de.assets.register.field.method)).toBeDisabled();
    // a descriptive field stays editable
    expect(screen.getByLabelText(de.assets.register.field.name)).not.toBeDisabled();
  });
});

describe('AssetRegister, archive', () => {
  it('confirms then calls asset_archive for a draft asset', async () => {
    const asked: Array<{ action: string; input: Record<string, unknown> }> = [];
    const canned: Canned = { ...baseCanned(), asset_archive: ok({ asset: ASSET({ status: 'archived' }) }) };
    renderSurface(canned, asked);
    const user = userEvent.setup();
    await screen.findByText('FA-0001');
    await rowVerb(user, de.assets.register.archive);
    const dialog = screen.getByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: de.assets.register.archive }));
    await waitFor(() => expect(asked.some((a) => a.action === 'asset_archive')).toBe(true));
  });
});

describe('AssetRegister, H02 acquisition', () => {
  it('posts a primary acquisition: cost converted to Rappen, credit account, idempotencyKey', async () => {
    const asked: Array<{ action: string; input: Record<string, unknown> }> = [];
    const canned: Canned = { ...baseCanned(), asset_acquire: ok({ asset: ASSET({ status: 'active' }), transaction: { id: 't1' }, journalEntry: { id: 'e1' } }) };
    renderSurface(canned, asked);
    const user = userEvent.setup();
    await rowVerb(user, de.assets.acquisition.record);
    // the drawer renders the two-line preview and a credit picker sourced from list_accounts
    expect(screen.getByLabelText(de.assets.acquisition.creditAccount)).toBeInTheDocument();
    await pickOption(user, de.assets.acquisition.creditAccount, BANK_ID);
    await user.click(screen.getByText(de.assets.acquisition.post));
    await waitFor(() => expect(asked.some((a) => a.action === 'asset_acquire')).toBe(true));
    const call = asked.find((a) => a.action === 'asset_acquire');
    expect(call?.input.assetId).toBe('as_1');
    expect(call?.input.creditAccountId).toBe(BANK_ID);
    expect(call?.input.acquisitionCostRappen).toBe(12500000);
    expect(call?.input.idempotencyKey).toBeTypeOf('string');
  });

  it('surfaces a period_locked rejection in the acquisition drawer without closing it', async () => {
    const asked: Array<{ action: string; input: Record<string, unknown> }> = [];
    const canned: Canned = { ...baseCanned(), asset_acquire: reject('period_locked') };
    renderSurface(canned, asked);
    const user = userEvent.setup();
    await rowVerb(user, de.assets.acquisition.record);
    await pickOption(user, de.assets.acquisition.creditAccount, BANK_ID);
    await user.click(screen.getByText(de.assets.acquisition.post));
    await waitFor(() => expect(asked.some((a) => a.action === 'asset_acquire')).toBe(true));
    // The engine rejection is surfaced and the drawer stays open (no silent close on a locked period).
    await waitFor(() => expect(document.querySelector('.error-banner')).not.toBeNull());
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('an active asset offers Add capitalisation and posts asset_add_capitalisation', async () => {
    const asked: Array<{ action: string; input: Record<string, unknown> }> = [];
    const canned: Canned = {
      ...baseCanned(),
      asset_list: ok({ assets: [ASSET({ status: 'active' })], total: 1 }),
      asset_add_capitalisation: ok({ asset: ASSET({ status: 'active' }), transaction: { id: 't2' }, journalEntry: { id: 'e2' } }),
    };
    renderSurface(canned, asked);
    const user = userEvent.setup();
    await rowVerb(user, de.assets.acquisition.addCapitalisation);
    await user.type(screen.getByLabelText(de.assets.acquisition.amount), '1500');
    await pickOption(user, de.assets.acquisition.creditAccount, CREDITOR_ID);
    await user.click(screen.getByText(de.assets.acquisition.post));
    await waitFor(() => expect(asked.some((a) => a.action === 'asset_add_capitalisation')).toBe(true));
    const call = asked.find((a) => a.action === 'asset_add_capitalisation');
    expect(call?.input.amountRappen).toBe(150000);
    expect(call?.input.creditAccountId).toBe(CREDITOR_ID);
  });

  it('the Transactions view renders the running-balance ledger from the recorded payload', async () => {
    const canned: Canned = {
      ...baseCanned(),
      asset_ledger_get: ok({
        asset: { id: 'a1', number: 'FA-0001', name: 'CNC', status: 'active' },
        events: [
          {
            id: 't1',
            type: 'acquisition',
            date: '2026-03-15',
            deltaCostRappen: 12500000,
            deltaAccumDeprRappen: 0,
            journalEntryId: 'e1',
            description: null,
            costAfterRappen: 12500000,
            accumulatedDeprAfterRappen: 0,
            netBookValueAfterRappen: 12500000,
          },
        ],
        total: 1,
      }),
    };
    renderSurface(canned);
    const user = userEvent.setup();
    await rowVerb(user, de.assets.acquisition.transactions);
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText(de.assets.acquisition.txnType.acquisition)).toBeInTheDocument();
    // The running net book value after the acquisition is CHF 125000.00.
    expect(within(dialog).getAllByText("CHF 125'000.00").length).toBeGreaterThan(0);
    // The journal link is surfaced (US-H07.1).
    expect(within(dialog).getByText('e1')).toBeInTheDocument();
  });

  it('the credit-account picker offers only asset/liability/equity accounts, never income', async () => {
    renderSurface(baseCanned());
    const user = userEvent.setup();
    await rowVerb(user, de.assets.acquisition.record);
    // Options are portaled, so open the picker and read its listbox by aria-label.
    await user.click(screen.getByRole('combobox', { name: de.assets.acquisition.creditAccount }));
    const picker = screen.getByRole('listbox', { name: de.assets.acquisition.creditAccount });
    // 2000 (liability) present, 3000 (income) filtered out
    expect(within(picker).getByText(/2000/)).toBeInTheDocument();
    expect(within(picker).queryByText(/3000/)).toBeNull();
  });
});

describe('AssetRegister, the permission gate', () => {
  it('disables the New button for a role without manage_master_data', async () => {
    withCapabilities({ ...baseCanned(), whoami: whoamiWith(['read_master_data']) });
    const newBtn = await screen.findByText(de.assets.register.new);
    await waitFor(() => expect(newBtn).toBeDisabled());
  });
});

describe('AssetRegister, H05 transfer', () => {
  const LOC = { id: 'aloc_1', code: 'PLANT-B', name: 'Werk B', active: true };
  const transferCanned = (): Canned => ({
    ...baseCanned(),
    asset_location_list: ok({ locations: [LOC] }),
    asset_transfer_history: ok({ transfers: [], total: 0 }),
    asset_transfer: ok({
      transactions: [{ id: 'atrf_1' }],
      assets: [{ id: 'as_1' }],
      summary: { transferred: 1, failed: 0 },
    }),
  });

  it('opens the transfer drawer and submits a non-posting transfer with a location and reason', async () => {
    const asked: Array<{ action: string; input: Record<string, unknown> }> = [];
    renderSurface(transferCanned(), asked);
    const user = userEvent.setup();
    await rowVerb(user, de.assets.transfer.action);
    await pickOption(user, de.assets.transfer.toLocation, LOC.id);
    await user.type(screen.getByLabelText(de.assets.transfer.reason), 'Kapazitätsverlagerung');
    await user.click(screen.getByText(de.assets.transfer.confirm));
    await waitFor(() => expect(asked.some((a) => a.action === 'asset_transfer')).toBe(true));
    const call = asked.find((a) => a.action === 'asset_transfer');
    expect(call?.input.assetIds).toEqual(['as_1']);
    expect(call?.input.toLocationId).toBe(LOC.id);
    expect(call?.input.reason).toBe('Kapazitätsverlagerung');
    expect(call?.input.idempotencyKey).toBeTypeOf('string');
  });

  it('keeps Confirm disabled until a new location or responsible is chosen (nothing_to_transfer guard)', async () => {
    renderSurface(transferCanned());
    const user = userEvent.setup();
    await rowVerb(user, de.assets.transfer.action);
    expect(screen.getByText(de.assets.transfer.confirm)).toBeDisabled();
    await pickOption(user, de.assets.transfer.toLocation, LOC.id);
    await waitFor(() => expect(screen.getByText(de.assets.transfer.confirm)).not.toBeDisabled());
  });

  it('renders the transfer history timeline from asset_transfer_history', async () => {
    const canned = {
      ...transferCanned(),
      asset_transfer_history: ok({
        transfers: [
          { id: 'h1', date: '2026-07-15', fromLocationId: null, toLocationId: LOC.id, fromResponsibleUserId: null, toResponsibleUserId: 'user_42', description: 'Umzug' },
        ],
        total: 1,
      }),
    };
    renderSurface(canned);
    const user = userEvent.setup();
    await rowVerb(user, de.assets.transfer.action);
    expect(await screen.findByText('15.07.2026')).toBeInTheDocument();
    expect(screen.getByText('Umzug')).toBeInTheDocument();
    // The "to" location renders as its code + name, resolved from the location list.
    expect(screen.getAllByText(/PLANT-B/).length).toBeGreaterThan(0);
  });
});

describe('AssetRegister, H06 disposal', () => {
  const GL_INCOME_ID = SAMPLE_ACCOUNTS.find((a) => a.number === '3600')!.id;
  const disposalCanned = (over: Record<string, unknown> = {}): Canned => ({
    ...baseCanned(),
    asset_list: ok({ assets: [ASSET({ status: 'active', accumulatedDeprRappen: 200000, netBookValueRappen: 12300000 })], total: 1 }),
    asset_disposal_preview: ok({
      preview: {
        asset_id: 'as_1',
        disposal_date: '2026-07-15',
        acquisition_cost_rappen: 12500000,
        accumulated_depr_rappen: 200000,
        net_book_value_rappen: 12300000,
        proceeds_rappen: 900000,
        gain_loss_rappen: -11400000,
        journal_lines: [
          { account_id: 'a2', account_number: '1510', account_name: 'Betriebseinrichtungen', debit_rappen: 200000, credit_rappen: 0, side: 'debit' },
          { account_id: 'acc_2', account_number: '1020', account_name: 'Bankkonto', debit_rappen: 900000, credit_rappen: 0, side: 'debit' },
          { account_id: GL_INCOME_ID, account_number: '3600', account_name: 'Erlöse', debit_rappen: 11400000, credit_rappen: 0, side: 'debit' },
          { account_id: 'a1', account_number: '1500', account_name: 'Maschinen', debit_rappen: 0, credit_rappen: 12500000, side: 'credit' },
        ],
        resulting_status: 'disposed',
      },
    }),
    asset_dispose: ok({ asset: ASSET({ status: 'disposed' }), transaction: { id: 'dt1' }, journalEntry: { id: 'de1' }, gainLossRappen: -11400000 }),
    ...over,
  });

  it('an active asset offers Dispose, previews the journal, and posts asset_dispose with proceeds converted', async () => {
    const asked: Array<{ action: string; input: Record<string, unknown> }> = [];
    renderSurface(disposalCanned(), asked);
    const user = userEvent.setup();
    await rowVerb(user, de.assets.disposal.action);
    // Fill the proceeds first, which reveals the proceeds-account picker.
    await user.type(screen.getByLabelText(de.assets.disposal.proceeds), '9000');
    await pickOption(user, de.assets.disposal.proceedsAccount, BANK_ID);
    await pickOption(user, de.assets.disposal.gainLossAccount, GL_INCOME_ID);
    // The live preview (asset_disposal_preview) renders the journal + a book loss.
    await waitFor(() => expect(asked.some((a) => a.action === 'asset_disposal_preview')).toBe(true));
    expect(await screen.findByText(de.assets.disposal.journalPreview)).toBeInTheDocument();
    expect(screen.getByText(de.assets.disposal.loss)).toBeInTheDocument();

    await user.click(screen.getByText(de.assets.disposal.post));
    await waitFor(() => expect(asked.some((a) => a.action === 'asset_dispose')).toBe(true));
    const call = asked.find((a) => a.action === 'asset_dispose');
    expect(call?.input.assetId).toBe('as_1');
    expect(call?.input.proceedsRappen).toBe(900000);
    expect(call?.input.proceedsAccountId).toBe(BANK_ID);
    expect(call?.input.gainLossAccountId).toBe(GL_INCOME_ID);
    expect(call?.input.idempotencyKey).toBeTypeOf('string');
  });

  it('the proceeds picker offers only money-side accounts and the gain/loss picker only income/expense', async () => {
    renderSurface(disposalCanned());
    const user = userEvent.setup();
    await rowVerb(user, de.assets.disposal.action);
    // The gain/loss picker: income 3600 present, asset 1000 filtered out. Options are portaled, so
    // the listbox is opened and read by its own aria-label.
    await user.click(screen.getByRole('combobox', { name: de.assets.disposal.gainLossAccount }));
    const gl = screen.getByRole('listbox', { name: de.assets.disposal.gainLossAccount });
    expect(within(gl).getByText(/3600/)).toBeInTheDocument();
    expect(within(gl).queryByText(/1000 Kassenbestand/)).toBeNull();
    // Close the listbox by re-clicking the trigger (Escape would bubble to the drawer's focus trap).
    await user.click(screen.getByRole('combobox', { name: de.assets.disposal.gainLossAccount }));
    // Reveal the proceeds picker, then assert it offers a bank (1020) but not income (3600).
    await user.type(screen.getByLabelText(de.assets.disposal.proceeds), '5000');
    await user.click(screen.getByRole('combobox', { name: de.assets.disposal.proceedsAccount }));
    const proceeds = screen.getByRole('listbox', { name: de.assets.disposal.proceedsAccount });
    expect(within(proceeds).getByText(/1020/)).toBeInTheDocument();
    expect(within(proceeds).queryByText(/3600/)).toBeNull();
  });

  it('a draft asset offers no Dispose action (only an acquired asset can be disposed)', async () => {
    renderSurface({ ...baseCanned(), asset_list: ok({ assets: [ASSET({ status: 'draft' })], total: 1 }) });
    await screen.findByText('FA-0001');
    expect(screen.queryByText(de.assets.disposal.action)).toBeNull();
  });

  it('surfaces a period_locked rejection in the dispose drawer without closing it', async () => {
    const asked: Array<{ action: string; input: Record<string, unknown> }> = [];
    renderSurface(disposalCanned({ asset_dispose: reject('period_locked') }), asked);
    const user = userEvent.setup();
    await rowVerb(user, de.assets.disposal.action);
    // A scrap (zero proceeds) needs no proceeds account, so the gain/loss account alone is enough.
    await pickOption(user, de.assets.disposal.gainLossAccount, GL_INCOME_ID);
    await user.click(screen.getByText(de.assets.disposal.post));
    await waitFor(() => expect(asked.some((a) => a.action === 'asset_dispose')).toBe(true));
    await waitFor(() => expect(document.querySelector('.error-banner')).not.toBeNull());
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});
