/**
 * J01, the Inventory -> Lot & Serial Tracking surface. The suite follows the Studio discipline: a
 * transport answers `whoami` and the list/detail reads, loading is asserted through the rendered list,
 * and copy is read from the message fragment, never typed here.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider } from '../../app/workspace';
import LotSerial from './index';
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

const ITEM = (over: Record<string, unknown> = {}) => ({
  id: 'it_lot',
  name: 'Impfstoff-Charge',
  trackStock: true,
  trackingMode: 'lot',
  ...over,
});

const LOT = (over: Record<string, unknown> = {}) => ({
  id: 'lot_1',
  number: 'L-2026-001',
  status: 'open',
  expiryDate: '2027-01-01',
  supplierReference: null,
  onHand: 0,
  ...over,
});

const whoamiWith = (capabilities: string[]): RestResponse =>
  ok({ actor: 'studio', role: null, isMember: true, provisioned: true, memberId: 'm1', userId: 'u1', capabilities });

const baseCanned = (): Canned => ({
  whoami: whoamiWith(['read_master_data', 'manage_master_data']),
  list_items: ok({ items: [ITEM()] }),
  lot_list: ok({ lots: [LOT()] }),
  serial_list: ok({ serials: [] }),
});

function renderSurface(canned: Canned, asked?: Array<{ action: string; input: Record<string, unknown> }>) {
  return render(
    <TillClientProvider client={new TillClient(fakeTransport(canned, asked))}>
      <I18nProvider>
        <WorkspaceProvider initialId="ws_test">
          <MemoryRouter>
            <LotSerial />
          </MemoryRouter>
        </WorkspaceProvider>
      </I18nProvider>
    </TillClientProvider>,
  );
}

describe('LotSerial, the item + lots/serials detail', () => {
  it('renders a tracked item and its lot once loaded', async () => {
    renderSurface(baseCanned());
    expect((await screen.findAllByText('Impfstoff-Charge')).length).toBeGreaterThan(0);
    expect(await screen.findByText('L-2026-001')).toBeInTheDocument();
    // The lots section title renders both as the visible <h3> subhead and as the shared DataTable's
    // visually-hidden <caption>, so it legitimately appears more than once (as the item name does).
    expect(screen.getAllByText(de.lotSerial.lots.title).length).toBeGreaterThan(0);
  });

  it('shows the empty state when there are no stockable items', async () => {
    renderSurface({ ...baseCanned(), list_items: ok({ items: [] }) });
    expect(await screen.findByText(de.lotSerial.empty.title)).toBeInTheDocument();
  });

  it('surfaces a transport failure with a retry', async () => {
    renderSurface({ ...baseCanned(), list_items: reject('boom', {}, 500) });
    expect(await screen.findByText(de.lotSerial.error.transport)).toBeInTheDocument();
  });
});

describe('LotSerial, writes', () => {
  it('creates a lot with an idempotency key and re-reads', async () => {
    const asked: Array<{ action: string; input: Record<string, unknown> }> = [];
    renderSurface({ ...baseCanned(), lot_list: ok({ lots: [] }), lot_create: ok({ lot: LOT() }) }, asked);
    const user = userEvent.setup();
    await user.click(await screen.findByText(de.lotSerial.lots.new));
    await user.type(screen.getByLabelText(de.lotSerial.lots.field.number), 'L-2026-009');
    await user.click(screen.getByText(de.lotSerial.save));
    await waitFor(() => expect(asked.some((a) => a.action === 'lot_create')).toBe(true));
    const call = asked.find((a) => a.action === 'lot_create');
    expect(call?.input.number).toBe('L-2026-009');
    expect(call?.input.itemId).toBe('it_lot');
    expect(call?.input.idempotencyKey).toBeTypeOf('string');
  });

  it('changes an item tracking mode through item_set_tracking_mode', async () => {
    const asked: Array<{ action: string; input: Record<string, unknown> }> = [];
    renderSurface({ ...baseCanned(), item_set_tracking_mode: ok({ item: { id: 'it_lot', trackingMode: 'lot_and_serial' } }) }, asked);
    const user = userEvent.setup();
    const select = await screen.findByRole('combobox', { name: de.lotSerial.modeLabel });
    await user.click(select);
    await user.click(screen.getByRole('option', { name: de.lotSerial.mode.lot_and_serial }));
    await waitFor(() => expect(asked.some((a) => a.action === 'item_set_tracking_mode')).toBe(true));
    const call = asked.find((a) => a.action === 'item_set_tracking_mode');
    expect(call?.input.mode).toBe('lot_and_serial');
    expect(call?.input.itemId).toBe('it_lot');
  });

  it('creates several serials all-or-nothing through serial_create_bulk', async () => {
    const asked: Array<{ action: string; input: Record<string, unknown> }> = [];
    renderSurface(
      {
        ...baseCanned(),
        list_items: ok({ items: [ITEM({ id: 'it_ser', name: 'Serien-Artikel', trackingMode: 'serial' })] }),
        lot_list: ok({ lots: [] }),
        serial_list: ok({ serials: [] }),
        serial_create_bulk: ok({ serials: [] }),
      },
      asked,
    );
    const user = userEvent.setup();
    await user.click(await screen.findByText(de.lotSerial.serials.new));
    await user.type(screen.getByLabelText(de.lotSerial.serials.field.numbers), 'SN-1\nSN-2\nSN-3');
    await user.click(screen.getByText(de.lotSerial.save));
    await waitFor(() => expect(asked.some((a) => a.action === 'serial_create_bulk')).toBe(true));
    const call = asked.find((a) => a.action === 'serial_create_bulk');
    expect(call?.input.numbers).toEqual(['SN-1', 'SN-2', 'SN-3']);
    expect(call?.input.itemId).toBe('it_ser');
  });

  it('surfaces the engine rejection in the lot drawer with a surface-scoped message', async () => {
    renderSurface({ ...baseCanned(), lot_list: ok({ lots: [] }), lot_create: reject('lot_number_taken') });
    const user = userEvent.setup();
    await user.click(await screen.findByText(de.lotSerial.lots.new));
    await user.type(screen.getByLabelText(de.lotSerial.lots.field.number), 'L-DUP');
    await user.click(screen.getByText(de.lotSerial.save));
    expect(await screen.findByText(de.lotSerial.errors.lot_number_taken)).toBeInTheDocument();
  });
});
