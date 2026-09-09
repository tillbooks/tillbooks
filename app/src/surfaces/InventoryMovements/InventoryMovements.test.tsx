/**
 * J02, the Inventory -> Movements surface. The suite follows the Studio discipline: a transport
 * answers `whoami` and the base + detail reads, loading is asserted through the rendered history, and
 * copy is read from the message fragment, never typed here.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider } from '../../app/workspace';
import InventoryMovements from './index';
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

const ITEM = { id: 'it_1', name: 'Widget', trackStock: true };
const LOCS = [
  { id: 'loc_a', name: 'Lager A' },
  { id: 'loc_b', name: 'Lager B' },
];
const MOVEMENT = (over: Record<string, unknown> = {}) => ({
  id: 'mv_1',
  movementType: 'receipt',
  qty: 10,
  unitCostMinor: 500,
  effectiveDate: '2026-03-01',
  locationId: 'loc_a',
  lotId: null,
  serialId: null,
  description: null,
  createdBy: 'studio',
  runningBalance: 10,
  ...over,
});

const whoamiWith = (capabilities: string[]): RestResponse =>
  ok({ actor: 'studio', role: null, isMember: true, provisioned: true, memberId: 'm1', userId: 'u1', capabilities });

const baseCanned = (): Canned => ({
  whoami: whoamiWith(['read_master_data', 'manage_master_data']),
  list_items: ok({ items: [ITEM] }),
  stock_on_hand: ok({ locations: LOCS, rows: [], items: [ITEM] }),
  inventory_get_config: ok({ allowNegativeStock: false }),
  inventory_movement_list: ok({ items: [MOVEMENT()], total: 1, limit: 200, offset: 0 }),
  inventory_balance: ok({ qtyOnHand: 10, asOf: null, rows: [] }),
});

function renderSurface(canned: Canned, asked?: Array<{ action: string; input: Record<string, unknown> }>) {
  return render(
    <TillClientProvider client={new TillClient(fakeTransport(canned, asked))}>
      <I18nProvider>
        <WorkspaceProvider initialId="ws_test">
          <MemoryRouter>
            <InventoryMovements />
          </MemoryRouter>
        </WorkspaceProvider>
      </I18nProvider>
    </TillClientProvider>,
  );
}

describe('InventoryMovements, the append-only ledger surface', () => {
  it('renders an item, its on-hand and a movement row with running balance', async () => {
    renderSurface(baseCanned());
    expect(await screen.findByRole('button', { name: 'Widget' })).toBeInTheDocument();
    // The on-hand is the pure SUM the engine returned, shown in the detail header.
    await waitFor(() => expect(screen.getByText('10', { selector: '.im-onhand strong' })).toBeInTheDocument());
    // The receipt row renders with its type badge and signed quantity.
    expect(screen.getByText(de.invMovements.type.receipt)).toBeInTheDocument();
    expect(screen.getByText('+10')).toBeInTheDocument();
  });

  // rt-f2 (K-71). The unit-cost snapshot is minor units (Rappen). The old cell rendered the raw
  // integer (`m.unitCostMinor ?? '-'`), so CHF 36.00 read as "3600", a 100x misread. Through
  // formatMoney it is a real money figure with de-CH grouping. Fails on develop, passes after.
  it('renders the unit-cost snapshot as formatted money, never the raw Rappen integer (rt-f2)', async () => {
    const canned = baseCanned();
    canned.inventory_movement_list = ok({ items: [MOVEMENT({ unitCostMinor: 3600 })], total: 1, limit: 200, offset: 0 });
    renderSurface(canned);
    await screen.findByRole('button', { name: 'Widget' });
    expect(await screen.findByText('CHF 36.00')).toBeInTheDocument();
    // The exact defect: the bare integer must not be on screen as the cost.
    expect(screen.queryByText('3600')).not.toBeInTheDocument();
  });

  it('renders a dash for a movement with no unit-cost snapshot', async () => {
    const canned = baseCanned();
    canned.inventory_movement_list = ok({ items: [MOVEMENT({ unitCostMinor: null })], total: 1, limit: 200, offset: 0 });
    renderSurface(canned);
    await screen.findByRole('button', { name: 'Widget' });
    // A null cost stays a dash, never "CHF 0.00" (absent is not zero).
    await waitFor(() => expect(screen.queryByText('CHF 0.00')).not.toBeInTheDocument());
  });

  it('records a movement through inventory_move and re-reads the ledger', async () => {
    const asked: Array<{ action: string; input: Record<string, unknown> }> = [];
    const canned = baseCanned();
    canned.inventory_move = ok({ movement: MOVEMENT({ id: 'mv_2' }), onHand: 15 });
    renderSurface(canned, asked);

    await screen.findByRole('button', { name: 'Widget' });
    await userEvent.click(screen.getByRole('button', { name: de.invMovements.record }));
    const dialog = await screen.findByRole('dialog', { name: de.invMovements.form.recordTitle });
    expect(dialog).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText(de.invMovements.form.qty), '5');
    await userEvent.click(screen.getByRole('button', { name: de.invMovements.save }));

    await waitFor(() => expect(asked.some((a) => a.action === 'inventory_move')).toBe(true));
    const call = asked.find((a) => a.action === 'inventory_move');
    // receipt applies a positive sign, and the movement carries the required money-path fields.
    expect(call?.input.qty).toBe(5);
    expect(call?.input.movementType).toBe('receipt');
    expect(call?.input.itemId).toBe('it_1');
    expect(typeof call?.input.idempotencyKey).toBe('string');
  });

  it('surfaces insufficient_stock with the surface-scoped message', async () => {
    const canned = baseCanned();
    canned.inventory_move = reject('insufficient_stock', { available: 10, requested: -15 });
    renderSurface(canned);

    await screen.findByRole('button', { name: 'Widget' });
    await userEvent.click(screen.getByRole('button', { name: de.invMovements.record }));
    await screen.findByRole('dialog', { name: de.invMovements.form.recordTitle });
    // Switch to an issue so the negative-sign path is exercised, then submit.
    await userEvent.selectOptions(screen.getByLabelText(de.invMovements.form.type), 'issue');
    await userEvent.type(screen.getByLabelText(de.invMovements.form.qty), '15');
    await userEvent.click(screen.getByRole('button', { name: de.invMovements.save }));

    expect(await screen.findByText(de.invMovements.errors.insufficient_stock)).toBeInTheDocument();
  });

  it('surfaces serial_already_in_stock with the surface-scoped message', async () => {
    // A serial is a unit of one, so the engine refuses a receipt for a serial it already holds. The
    // operator must read WHY and what to do, not the generic fallback.
    const canned = baseCanned();
    canned.inventory_move = reject('serial_already_in_stock', { serialId: 'ser_1', number: 'SN-001', status: 'available', onHand: 1 });
    renderSurface(canned);

    await screen.findByRole('button', { name: 'Widget' });
    await userEvent.click(screen.getByRole('button', { name: de.invMovements.record }));
    await screen.findByRole('dialog', { name: de.invMovements.form.recordTitle });
    await userEvent.type(screen.getByLabelText(de.invMovements.form.qty), '1');
    await userEvent.click(screen.getByRole('button', { name: de.invMovements.save }));

    expect(await screen.findByText(de.invMovements.errors.serial_already_in_stock)).toBeInTheDocument();
  });

  it('shows the permission-denied state when the list read is refused', async () => {
    // The Studio capability gate fails open by design (ALLOW_ALL without a provider), so the real
    // denied path a surface handles is the engine refusing the read. list_items -> permission_denied
    // replaces the whole surface with PermissionDenied, and the write controls never render.
    const canned = baseCanned();
    canned.list_items = reject('permission_denied', {}, 403);
    renderSurface(canned);
    await waitFor(() => expect(screen.queryByRole('button', { name: de.invMovements.record })).not.toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Widget' })).not.toBeInTheDocument();
  });
});
