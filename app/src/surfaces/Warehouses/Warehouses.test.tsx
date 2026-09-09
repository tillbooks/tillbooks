/**
 * J00, the Inventory -> Warehouses & Locations surface. The suite follows the Studio discipline: a
 * GATE claim mounts a real `CapabilitiesProvider` over a transport that answers `whoami`, loading is
 * asserted through the rendered list, and copy is read from the message fragment, never typed here.
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
import Warehouses from './index';
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

const WAREHOUSE = (over: Record<string, unknown> = {}) => ({
  id: 'wh_1',
  code: 'ZH-MAIN',
  name: 'Zürich Main',
  description: null,
  city: 'Zürich',
  isDefault: true,
  active: true,
  ...over,
});

const LOCATION = (over: Record<string, unknown> = {}) => ({
  id: 'loc_1',
  code: 'RECV',
  name: 'Receiving',
  locationType: 'staging',
  depth: 0,
  isDefaultForWarehouse: true,
  active: true,
  children: [],
  ...over,
});

const whoamiWith = (capabilities: string[]): RestResponse =>
  ok({ actor: 'studio', role: null, isMember: true, provisioned: true, memberId: 'm1', userId: 'u1', capabilities });

const baseCanned = (): Canned => ({
  whoami: whoamiWith(['read_master_data', 'manage_master_data']),
  warehouse_list: ok({ warehouses: [WAREHOUSE()] }),
  location_tree: ok({ warehouseId: 'wh_1', tree: [LOCATION()] }),
  inventory_balance_by_location: ok({ rows: [], warehouseTotals: [] }),
});

function tree(canned: Canned, workspaceId: string | null, withProvider: boolean) {
  const inner = (
    <MemoryRouter>
      <Warehouses />
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

describe('Warehouses, the list + detail', () => {
  it('renders a warehouse and its location once loaded', async () => {
    renderSurface(baseCanned());
    // The code appears both in the list and in the selected-warehouse header, so match all.
    expect((await screen.findAllByText('ZH-MAIN')).length).toBeGreaterThan(0);
    // The selected warehouse's location tree renders on the right.
    expect(await screen.findByText('RECV')).toBeInTheDocument();
    expect(screen.getByText(de.warehouses.locations.type.staging)).toBeInTheDocument();
  });

  it('shows the empty state with a create CTA when there are no warehouses', async () => {
    renderSurface({ ...baseCanned(), warehouse_list: ok({ warehouses: [] }) });
    expect(await screen.findByText(de.warehouses.empty.title)).toBeInTheDocument();
    expect(screen.getByText(de.warehouses.empty.cta)).toBeInTheDocument();
    expect(screen.getByText(de.warehouses.empty.ensure)).toBeInTheDocument();
  });

  it('surfaces a transport failure with a retry', async () => {
    renderSurface({ ...baseCanned(), warehouse_list: reject('boom', {}, 500) });
    expect(await screen.findByText(de.warehouses.error.transport)).toBeInTheDocument();
  });
});

describe('Warehouses, create', () => {
  it('opens the drawer, submits a warehouse_create with an idempotency key, and re-reads', async () => {
    const asked: Array<{ action: string; input: Record<string, unknown> }> = [];
    const canned: Canned = {
      ...baseCanned(),
      warehouse_list: ok({ warehouses: [] }),
      warehouse_create: ok({ warehouse: WAREHOUSE() }),
      inventory_ensure_default_location: ok({ warehouse: WAREHOUSE(), location: LOCATION() }),
    };
    render(
      <TillClientProvider client={new TillClient(fakeTransport(canned, asked))}>
        <I18nProvider>
          <WorkspaceProvider initialId="ws_test">
            <MemoryRouter>
              <Warehouses />
            </MemoryRouter>
          </WorkspaceProvider>
        </I18nProvider>
      </TillClientProvider>,
    );
    const user = userEvent.setup();
    await user.click(await screen.findByText(de.warehouses.empty.cta));
    await user.type(screen.getByLabelText(de.warehouses.field.code), 'BE-01');
    await user.type(screen.getByLabelText(de.warehouses.field.name), 'Bern Lager');
    await user.click(screen.getByText(de.warehouses.save));
    await waitFor(() => expect(asked.some((a) => a.action === 'warehouse_create')).toBe(true));
    const call = asked.find((a) => a.action === 'warehouse_create');
    expect(call?.input.code).toBe('BE-01');
    expect(call?.input.idempotencyKey).toBeTypeOf('string');
  });

  it('surfaces the engine rejection in the drawer without closing it', async () => {
    const canned: Canned = {
      ...baseCanned(),
      warehouse_list: ok({ warehouses: [] }),
      warehouse_create: reject('duplicate_code'),
    };
    renderSurface(canned);
    const user = userEvent.setup();
    await user.click(await screen.findByText(de.warehouses.empty.cta));
    await user.type(screen.getByLabelText(de.warehouses.field.code), 'ZH-MAIN');
    await user.type(screen.getByLabelText(de.warehouses.field.name), 'X');
    await user.click(screen.getByText(de.warehouses.save));
    expect(await screen.findByText(de.warehouses.errors.duplicate_code)).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});

describe('Warehouses, archive', () => {
  it('confirms then calls warehouse_archive', async () => {
    const asked: Array<{ action: string; input: Record<string, unknown> }> = [];
    // A NON-default warehouse, so the Archive button shows on the detail pane.
    const canned: Canned = {
      ...baseCanned(),
      warehouse_list: ok({ warehouses: [WAREHOUSE({ isDefault: false })] }),
      warehouse_archive: ok({ warehouse: WAREHOUSE({ active: false }) }),
    };
    render(
      <TillClientProvider client={new TillClient(fakeTransport(canned, asked))}>
        <I18nProvider>
          <WorkspaceProvider initialId="ws_test">
            <MemoryRouter>
              <Warehouses />
            </MemoryRouter>
          </WorkspaceProvider>
        </I18nProvider>
      </TillClientProvider>,
    );
    const user = userEvent.setup();
    await screen.findAllByText('ZH-MAIN');
    // The detail pane's Archive control (there is one; the location default has none).
    await user.click(screen.getAllByText(de.warehouses.archive)[0]);
    const dialog = screen.getByRole('alertdialog');
    await user.click(within(dialog).getByText(de.warehouses.archive));
    await waitFor(() => expect(asked.some((a) => a.action === 'warehouse_archive')).toBe(true));
  });
});

describe('Warehouses, the permission gate', () => {
  it('disables the New warehouse button for a role without manage_master_data', async () => {
    withCapabilities({ ...baseCanned(), whoami: whoamiWith(['read_master_data']) });
    const newBtn = await screen.findByText(de.warehouses.newWarehouse);
    await waitFor(() => expect(newBtn).toBeDisabled());
  });
});
