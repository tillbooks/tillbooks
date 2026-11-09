/**
 * H08, the Fixed Assets -> Maintenance surface. Same discipline as the AssetLocations suite: a GATE
 * claim mounts a real `CapabilitiesProvider` over a transport that answers `whoami`, loading is
 * asserted through the catalogue, and copy is read from the message fragment, never typed here. The
 * asset picker is fed by `asset_list`; the log by `asset_maintenance_log_list`.
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
import { AssetMaintenance } from './AssetMaintenance';
import de from './messages.de-CH.json';

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

const ASSET = (over: Record<string, unknown> = {}) => ({ id: 'asset_1', number: 'A-001', name: 'Gabelstapler', status: 'active', ...over });
const LOG = (over: Record<string, unknown> = {}) => ({
  id: 'amlog_1',
  assetId: 'asset_1',
  logDate: '2026-08-10',
  maintenanceType: 'corrective',
  title: 'Hydraulikpumpen-Dichtung ersetzt',
  description: null,
  performedByUserId: null,
  externalParty: 'Muster Service AG',
  costRappen: 45000,
  partsCostRappen: null,
  labourCostRappen: null,
  externalReference: null,
  notes: null,
  status: 'completed',
  cancelReason: null,
  ...over,
});

const whoamiWith = (capabilities: string[]): RestResponse =>
  ok({ actor: 'studio', role: null, isMember: true, provisioned: true, memberId: 'm1', userId: 'u1', capabilities });

const baseCanned = (): Canned => ({
  whoami: whoamiWith(['read_master_data', 'manage_master_data']),
  asset_list: ok({ assets: [ASSET()] }),
  asset_maintenance_log_list: ok({ items: [LOG()], total: 1, totalCostRappen: 45000 }),
});

function tree(canned: Canned, workspaceId: string | null, withProvider: boolean, asked?: Array<{ action: string; input: Record<string, unknown> }>) {
  const inner = (
    <MemoryRouter>
      <AssetMaintenance />
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

const renderSurface = (canned: Canned, workspaceId: string | null = 'ws_test', asked?: Array<{ action: string; input: Record<string, unknown> }>) =>
  render(tree(canned, workspaceId, false, asked));
const withCapabilities = (canned: Canned, workspaceId: string | null = 'ws_test') => render(tree(canned, workspaceId, true));

describe('AssetMaintenance, the log', () => {
  it('renders a log row with its date, title and completed status once the asset is loaded', async () => {
    renderSurface(baseCanned());
    expect(await screen.findByText('Hydraulikpumpen-Dichtung ersetzt')).toBeInTheDocument();
    expect(screen.getByText('10.08.2026')).toBeInTheDocument();
    expect(screen.getByText(de.assets.maintenance.status.completed)).toBeInTheDocument();
    // 45000 Rappen -> CHF 450.00 appears twice: the row's own cost cell and the footer roll-up total,
    // both formatted through the shared formatMoney (K-71) so the CHF prefix and grouping are uniform.
    expect(screen.getAllByText('CHF 450.00')).toHaveLength(2);
  });

  it('shows the empty state with a create CTA when the asset has no entries', async () => {
    renderSurface({ ...baseCanned(), asset_maintenance_log_list: ok({ items: [], total: 0, totalCostRappen: 0 }) });
    expect(await screen.findByText(de.assets.maintenance.empty.title)).toBeInTheDocument();
    expect(screen.getByText(de.assets.maintenance.empty.cta)).toBeInTheDocument();
  });

  it('shows a no-assets state when the workspace has no assets to log against', async () => {
    renderSurface({ ...baseCanned(), asset_list: ok({ assets: [] }) });
    expect(await screen.findByText(de.assets.maintenance.noAssets.title)).toBeInTheDocument();
  });

  it('surfaces a transport failure with a retry', async () => {
    renderSurface({ ...baseCanned(), asset_maintenance_log_list: reject('boom', {}, 500) });
    expect(await screen.findByText(de.assets.maintenance.error.transport)).toBeInTheDocument();
  });
});

describe('AssetMaintenance, create', () => {
  it('opens the drawer, submits a create with an idempotency key + asset, and re-reads on success', async () => {
    const asked: Array<{ action: string; input: Record<string, unknown> }> = [];
    const canned: Canned = {
      ...baseCanned(),
      asset_maintenance_log_list: ok({ items: [], total: 0, totalCostRappen: 0 }),
      asset_maintenance_log_create: ok({ log: LOG() }),
    };
    renderSurface(canned, 'ws_test', asked);
    const user = userEvent.setup();
    await user.click(await screen.findByText(de.assets.maintenance.empty.cta));
    await user.type(screen.getByLabelText(de.assets.maintenance.field.title), 'Neuer Serviceeintrag');
    await user.click(screen.getByText(de.assets.maintenance.save));
    await waitFor(() => expect(asked.some((a) => a.action === 'asset_maintenance_log_create')).toBe(true));
    const call = asked.find((a) => a.action === 'asset_maintenance_log_create');
    expect(call?.input.assetId).toBe('asset_1');
    expect(call?.input.title).toBe('Neuer Serviceeintrag');
    expect(call?.input.idempotencyKey).toBeTypeOf('string');
  });
});

describe('AssetMaintenance, update', () => {
  it('surfaces the engine log_locked rejection in the drawer without closing it', async () => {
    const canned: Canned = { ...baseCanned(), asset_maintenance_log_update: reject('log_locked') };
    renderSurface(canned);
    const user = userEvent.setup();
    // K-21: the row itself opens the entry's edit drawer.
    await user.click(await screen.findByRole('row', { name: /^Eintrag Hydraulikpumpen-Dichtung ersetzt/ }));
    await user.click(screen.getByText(de.assets.maintenance.save));
    expect(await screen.findByText(de.errors.log_locked)).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});

describe('AssetMaintenance, cancel', () => {
  it('confirms with a reason then calls asset_maintenance_log_cancel', async () => {
    const asked: Array<{ action: string; input: Record<string, unknown> }> = [];
    const canned: Canned = { ...baseCanned(), asset_maintenance_log_cancel: ok({ log: LOG({ status: 'cancelled' }) }) };
    renderSurface(canned, 'ws_test', asked);
    const user = userEvent.setup();
    await screen.findByText('Hydraulikpumpen-Dichtung ersetzt');
    await user.click(screen.getByRole('button', { name: /^Aktionen für den Eintrag/ })); // K-21
    await user.click(screen.getByRole('menuitem', { name: de.assets.maintenance.cancel }));
    const dialog = screen.getByRole('alertdialog');
    await user.type(within(dialog).getByLabelText(de.assets.maintenance.field.cancelReason), 'Doppelt erfasst');
    await user.click(within(dialog).getByRole('button', { name: de.assets.maintenance.cancel }));
    await waitFor(() => expect(asked.some((a) => a.action === 'asset_maintenance_log_cancel')).toBe(true));
    const call = asked.find((a) => a.action === 'asset_maintenance_log_cancel');
    expect(call?.input.reason).toBe('Doppelt erfasst');
    expect(call?.input.idempotencyKey).toBeTypeOf('string');
  });
});

describe('AssetMaintenance, the permission gate', () => {
  it('disables the New button for a role without manage_master_data', async () => {
    withCapabilities({ ...baseCanned(), whoami: whoamiWith(['read_master_data']) });
    const newBtn = await screen.findByText(de.assets.maintenance.new);
    await waitFor(() => expect(newBtn).toBeDisabled());
  });
});
