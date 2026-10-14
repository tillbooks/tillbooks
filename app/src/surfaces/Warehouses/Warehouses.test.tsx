/**
 * J00, the Inventory -> Warehouses & Locations surface. The suite follows the Studio discipline: a
 * GATE claim mounts a real `CapabilitiesProvider` over a transport that answers `whoami`, loading is
 * asserted through the rendered list, and copy is read from the message fragment, never typed here.
 */
import { describe, it, expect } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider, useWorkspace } from '../../app/workspace';
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

function tree(canned: Canned, workspaceId: string | null, withProvider: boolean, path = '/warehouses') {
  const inner = (
    <MemoryRouter initialEntries={[path]}>
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

const renderSurface = (canned: Canned, workspaceId: string | null = 'ws_test', path?: string) =>
  render(tree(canned, workspaceId, false, path));

/** D152 rule 5: a warehouse opens by the person's act. Click its row, as the person would. */
async function openWarehouse(name: RegExp = /ZH-MAIN/) {
  await userEvent.click(await screen.findByRole('row', { name }));
}
const withCapabilities = (canned: Canned, workspaceId: string | null = 'ws_test') => render(tree(canned, workspaceId, true));

describe('Warehouses, the list + detail', () => {
  it('renders a warehouse and its location once loaded', async () => {
    renderSurface(baseCanned());
    await openWarehouse();
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
    await user.click(await screen.findByRole('row', { name: /ZH-MAIN/ }));
    // The detail pane's Archive sits in its overflow (K-21), beside Bearbeiten.
    await user.click(screen.getByRole('button', { name: 'Aktionen für Lager ZH-MAIN' }));
    await user.click(screen.getByRole('menuitem', { name: de.warehouses.archive }));
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

describe('Warehouses, a list never opens itself (D152 rule 5)', () => {
  const two = (): Canned => ({
    ...baseCanned(),
    warehouse_list: ok({ warehouses: [WAREHOUSE(), WAREHOUSE({ id: 'wh_2', code: 'BE-01', name: 'Bern Lager', isDefault: false })] }),
  });

  it('selects nothing on load: no current row, no detail, no location read, the list takes the width', async () => {
    const asked: Array<{ action: string; input: Record<string, unknown> }> = [];
    const { container } = render(
      <TillClientProvider client={new TillClient(fakeTransport(two(), asked))}>
        <I18nProvider>
          <WorkspaceProvider initialId="ws_test">
            <MemoryRouter initialEntries={['/warehouses']}>
              <Warehouses />
            </MemoryRouter>
          </WorkspaceProvider>
        </I18nProvider>
      </TillClientProvider>,
    );
    await screen.findByRole('row', { name: /BE-01/ });
    expect(container.querySelector('[aria-current="true"]')).toBeNull();
    expect(screen.queryByRole('region', { name: de.warehouses.detailLabel })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: de.warehouses.edit })).not.toBeInTheDocument();
    expect(container.querySelector('.wh-split--solo')).not.toBeNull();
    expect(asked.some((a) => a.action === 'location_tree')).toBe(false);
  });

  it('opens the warehouse a deep link names (?focus=)', async () => {
    renderSurface(two(), 'ws_test', '/warehouses?focus=wh_2');
    const row = await screen.findByRole('row', { name: /BE-01/ });
    await waitFor(() => expect(row).toHaveAttribute('aria-current', 'true'));
    expect(await screen.findByRole('region', { name: de.warehouses.detailLabel })).toBeInTheDocument();
    expect(screen.getByRole('row', { name: /ZH-MAIN/ })).not.toHaveAttribute('aria-current');
  });

  it('a click opens the detail with the same actions, a second click closes it, Enter reopens it', async () => {
    renderSurface(two());
    await openWarehouse();
    const row = screen.getByRole('row', { name: /ZH-MAIN/ });
    expect(row).toHaveAttribute('aria-current', 'true');
    expect(await screen.findByRole('button', { name: de.warehouses.edit })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: de.warehouses.locations.new })).toBeInTheDocument();
    expect(await screen.findByText('RECV')).toBeInTheDocument();

    await userEvent.click(row);
    await waitFor(() => expect(screen.queryByRole('region', { name: de.warehouses.detailLabel })).not.toBeInTheDocument());
    row.focus();
    await userEvent.keyboard('{Enter}');
    expect(await screen.findByRole('region', { name: de.warehouses.detailLabel })).toBeInTheDocument();
  });
});

describe('Warehouses, a late detail read never lands under another warehouse (critic F1)', () => {
  it('open A, close it mid-read, open B: A\'s late answer is dropped', async () => {
    let releaseA: (r: RestResponse) => void = () => undefined;
    const slowA = new Promise<RestResponse>((r) => {
      releaseA = r;
    });
    const canned: Canned = {
      ...baseCanned(),
      warehouse_list: ok({ warehouses: [WAREHOUSE(), WAREHOUSE({ id: 'wh_2', code: 'BE-01', name: 'Bern Lager', isDefault: false })] }),
      location_tree: ((input: Record<string, unknown>) =>
        input.warehouseId === 'wh_1' ? slowA : ok({ warehouseId: 'wh_2', tree: [LOCATION({ id: 'loc_b', code: 'BERN-RECV' })] })) as unknown as CannedHandler,
    };
    renderSurface(canned);
    const a = await screen.findByRole('row', { name: /ZH-MAIN/ });
    await userEvent.click(a);
    await userEvent.click(a);
    await userEvent.click(screen.getByRole('row', { name: /BE-01/ }));
    expect(await screen.findByText('BERN-RECV')).toBeInTheDocument();
    await act(async () => {
      releaseA(ok({ warehouseId: 'wh_1', tree: [LOCATION()] }));
      await slowA;
    });
    expect(screen.getByText('BERN-RECV')).toBeInTheDocument();
    expect(screen.queryByText('RECV')).not.toBeInTheDocument();
  });
});

describe('Warehouses, a write in flight across a workspace switch (critic round 3 prep)', () => {
  it('a create answered after the switch neither re-reads the old workspace nor shows its refusal', async () => {
    let switchTo: (id: string) => void = () => undefined;
    function Switcher() {
      const { setWorkspaceId } = useWorkspace();
      switchTo = (id: string) => setWorkspaceId(id);
      return null;
    }
    let answer: (r: RestResponse) => void = () => undefined;
    const pending = new Promise<RestResponse>((r) => {
      answer = r;
    });
    const asked: Array<{ action: string; input: Record<string, unknown> }> = [];
    const canned: Canned = { ...baseCanned(), warehouse_create: (() => pending) as unknown as CannedHandler };
    render(
      <TillClientProvider client={new TillClient(fakeTransport(canned, asked))}>
        <I18nProvider>
          <WorkspaceProvider initialId="ws_a">
            <MemoryRouter initialEntries={['/warehouses']}>
              <Switcher />
              <Warehouses />
            </MemoryRouter>
          </WorkspaceProvider>
        </I18nProvider>
      </TillClientProvider>,
    );
    const user = userEvent.setup();
    await user.click(await screen.findByText(de.warehouses.newWarehouse));
    await user.type(screen.getByLabelText(de.warehouses.field.code), 'BE-01');
    await user.type(screen.getByLabelText(de.warehouses.field.name), 'Bern');
    await user.click(screen.getByText(de.warehouses.save));
    await waitFor(() => expect(asked.some((a) => a.action === 'warehouse_create')).toBe(true));
    expect(asked.find((a) => a.action === 'warehouse_create')?.input.workspaceId).toBe('ws_a');

    act(() => switchTo('ws_b'));
    await waitFor(() => expect(asked.some((a) => a.action === 'warehouse_list' && a.input.workspaceId === 'ws_b')).toBe(true));
    await screen.findByRole('row', { name: /ZH-MAIN/ });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    const before = asked.length;
    await act(async () => {
      answer(reject('duplicate_code'));
      await pending;
    });
    expect(asked.slice(before)).toEqual([]);
    // ws_a's refusal is not told under ws_b, not even in the drawer the person opens next.
    await user.click(screen.getByText(de.warehouses.newWarehouse));
    await screen.findByRole('dialog');
    expect(screen.queryByText(de.warehouses.errors.duplicate_code)).not.toBeInTheDocument();
  });
});
