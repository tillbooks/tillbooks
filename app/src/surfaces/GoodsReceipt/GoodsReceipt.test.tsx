/**
 * I02, the Einkauf -> Wareneingänge surface. The suite follows the Studio discipline: a transport
 * answers `whoami` and the list + detail reads, loading is asserted through the rendered document,
 * and copy is read from the message fragment, never typed here.
 *
 * The cases that matter for a money-path surface are the ones where the UI could LIE about the
 * engine: that Post stays disabled while the pure preview reports an issue, that the engine's own
 * rejection is what the operator reads, that a posted receipt offers no edit, and that every write
 * carries an idempotency key.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider } from '../../app/workspace';
import GoodsReceipt from './index';
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

const ROW = (over: Record<string, unknown> = {}) => ({
  id: 'gr_1',
  number: 'GR-2026-0001',
  status: 'draft',
  poId: 'po_1',
  poNumber: 'PO-2026-0001',
  supplierName: 'Lieferant GmbH',
  receivedAt: '2026-03-04',
  lineCount: 1,
  valueRappen: 40000,
  overReceiptQty: 0,
  ...over,
});

const LINE = (over: Record<string, unknown> = {}) => ({
  id: 'grl_1',
  poLineId: 'pol_1',
  description: 'Rohstoff',
  qty: 4,
  unitCostRappen: 10000,
  inspectionStatus: 'none',
  movementId: null,
  reversalMovementId: null,
  rejectReason: null,
  overReceiptQty: 0,
  ...over,
});

const DETAIL = (over: Record<string, unknown> = {}, lines = [LINE()]) => ({
  goodsReceipt: {
    id: 'gr_1',
    number: 'GR-2026-0001',
    status: 'draft',
    poId: 'po_1',
    receivedAt: '2026-03-04',
    note: null,
    hasOverReceipt: false,
    lines,
    events: [{ id: 'ev_1', eventType: 'created', reason: null, actor: 'studio', createdAt: '2026-03-04T08:00:00.000Z' }],
    ...over,
  },
});

const PREVIEW = (over: Record<string, unknown> = {}) => ({
  valueRappen: 40000,
  postable: true,
  issues: [],
  lines: [
    {
      lineId: 'grl_1',
      ordered: 6,
      alreadyReceived: 0,
      open: 6,
      proposed: 4,
      resultingReceived: 4,
      movesStock: true,
      overReceipt: false,
      overReceiptQty: 0,
      issues: [],
    },
  ],
  ...over,
});

const whoamiWith = (capabilities: string[]): RestResponse =>
  ok({ actor: 'studio', role: null, isMember: true, provisioned: true, memberId: 'm1', userId: 'u1', capabilities });

const baseCanned = (): Canned => ({
  whoami: whoamiWith(['read_master_data', 'manage_master_data']),
  goods_receipt_list: ok({ goodsReceipts: [ROW()] }),
  goods_receipt_get: ok(DETAIL()),
  goods_receipt_preview: ok(PREVIEW()),
  po_list: ok({ pos: [{ id: 'po_1', number: 'PO-2026-0001', status: 'sent' }] }),
  po_get: ok({ lines: [{ id: 'pol_1', itemId: 'it_1', description: 'Rohstoff', openQty: 6 }] }),
  list_items: ok({ items: [{ id: 'it_1', name: 'Rohstoff', trackStock: true }] }),
  lot_list: ok({ lots: [] }),
  serial_list: ok({ serials: [] }),
});

function renderSurface(canned: Canned, asked?: Array<{ action: string; input: Record<string, unknown> }>) {
  return render(
    <TillClientProvider client={new TillClient(fakeTransport(canned, asked))}>
      <I18nProvider>
        <WorkspaceProvider initialId="ws_test">
          <MemoryRouter>
            <GoodsReceipt />
          </MemoryRouter>
        </WorkspaceProvider>
      </I18nProvider>
    </TillClientProvider>,
  );
}

describe('GoodsReceipt, the receipt document surface', () => {
  it('renders a receipt with its status badge, its line and the receipt value', async () => {
    renderSurface(baseCanned());
    expect(await screen.findByRole('row', { name: /GR-2026-0001/ })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('Rohstoff')).toBeInTheDocument());
    // Status is glyph AND label, never colour alone.
    expect(screen.getAllByText(new RegExp(de.goodsReceipt.status.draft)).length).toBeGreaterThan(0);
    // Money is rendered from integer Rappen, never a float on the wire.
    expect(screen.getByText('CHF 400.00')).toBeInTheDocument();
    // The fixed-date rule is stated rather than implied by a missing field.
    expect(screen.getAllByText(de.goodsReceipt.dateIsFixed).length).toBeGreaterThan(0);
    // K-38: the day reads TT.MM.JJJJ in the list, the detail and the trail, never the ISO form.
    expect(screen.getAllByText(/04\.03\.2026/).length).toBeGreaterThan(0);
    expect(screen.queryAllByText(/2026-03-04/)).toHaveLength(0);
    // K-22: the status is the shared Status word, an icon-set glyph beside it, no text dingbat.
    const status = screen.getAllByText(de.goodsReceipt.status.draft)[0]?.closest('.status-word');
    expect(status?.querySelector('svg')).not.toBeNull();
  });

  it('posts through goods_receipt_post with an idempotency key and no date parameter', async () => {
    const asked: Array<{ action: string; input: Record<string, unknown> }> = [];
    const canned = baseCanned();
    canned.goods_receipt_post = ok(DETAIL({ status: 'posted' }));
    renderSurface(canned, asked);

    await screen.findByRole('row', { name: /GR-2026-0001/ });
    const post = await screen.findByRole('button', { name: de.goodsReceipt.post });
    await waitFor(() => expect(post).not.toBeDisabled());
    await userEvent.click(post);

    await waitFor(() => expect(asked.some((a) => a.action === 'goods_receipt_post')).toBe(true));
    const call = asked.find((a) => a.action === 'goods_receipt_post');
    expect(call?.input.grId).toBe('gr_1');
    expect(typeof call?.input.idempotencyKey).toBe('string');
    // The engine takes no date on post: the surface must not invent one.
    expect(call?.input.receivedAt).toBeUndefined();
    expect(call?.input.effectiveDate).toBeUndefined();
  });

  it('keeps Post disabled while the pure preview reports an issue, and names that issue on the line', async () => {
    const canned = baseCanned();
    canned.goods_receipt_preview = ok(
      PREVIEW({
        postable: false,
        lines: [
          {
            lineId: 'grl_1',
            ordered: 6,
            alreadyReceived: 0,
            open: 6,
            proposed: 9,
            resultingReceived: 9,
            movesStock: true,
            overReceipt: true,
            overReceiptQty: 3,
            issues: ['qty_exceeds_open'],
          },
        ],
      }),
    );
    renderSurface(canned);

    await screen.findByRole('row', { name: /GR-2026-0001/ });
    await waitFor(() => expect(screen.getByRole('button', { name: de.goodsReceipt.post })).toBeDisabled());
    expect(await screen.findByText(de.goodsReceipt.errors.qty_exceeds_open)).toBeInTheDocument();
  });

  it('surfaces the engine own rejection rather than a generic failure', async () => {
    const canned = baseCanned();
    canned.goods_receipt_post = reject('period_locked', { period: '2026', kind: 'hard', reason: 'year_close' });
    renderSurface(canned);

    await screen.findByRole('row', { name: /GR-2026-0001/ });
    const post = await screen.findByRole('button', { name: de.goodsReceipt.post });
    await waitFor(() => expect(post).not.toBeDisabled());
    await userEvent.click(post);

    expect(await screen.findByText(de.goodsReceipt.errors.period_locked)).toBeInTheDocument();
  });

  it('offers no edit on a POSTED receipt, only the reversal, and refuses to send one without a reason', async () => {
    const canned = baseCanned();
    canned.goods_receipt_list = ok({ goodsReceipts: [ROW({ status: 'posted' })] });
    canned.goods_receipt_get = ok(DETAIL({ status: 'posted' }, [LINE({ movementId: 'stockmv_1' })]));
    renderSurface(canned);

    await screen.findByRole('row', { name: /GR-2026-0001/ });
    await waitFor(() => expect(screen.queryByRole('button', { name: de.goodsReceipt.post })).not.toBeInTheDocument());
    expect(screen.queryByRole('button', { name: de.goodsReceipt.addLine })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: de.goodsReceipt.cancel })).not.toBeInTheDocument();
    // The movement the line minted is visible, which is what makes the receipt auditable from here.
    expect(screen.getByText('stockmv_1')).toBeInTheDocument();
    // Reverse stays disabled until a reason is typed: a compensating movement without a stated
    // reason is exactly the audit gap §H-AUDIT exists to close.
    expect(screen.getByRole('button', { name: de.goodsReceipt.reverse })).toBeDisabled();
    await userEvent.type(screen.getByLabelText(de.goodsReceipt.form.reverseReason), 'Fehllieferung');
    expect(screen.getByRole('button', { name: de.goodsReceipt.reverse })).not.toBeDisabled();
  });

  it('shows held lines with an accept and a reject, and sends the reject reason', async () => {
    const asked: Array<{ action: string; input: Record<string, unknown> }> = [];
    const canned = baseCanned();
    canned.goods_receipt_list = ok({ goodsReceipts: [ROW({ status: 'posted' })] });
    canned.goods_receipt_get = ok(DETAIL({ status: 'posted' }, [LINE({ inspectionStatus: 'pending' })]));
    canned.goods_receipt_reject_lines = ok(DETAIL({ status: 'posted' }, [LINE({ inspectionStatus: 'rejected' })]));
    renderSurface(canned, asked);

    await screen.findByRole('row', { name: /GR-2026-0001/ });
    expect(await screen.findByText(de.goodsReceipt.holdTitle)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: de.goodsReceipt.reject })).toBeDisabled();

    await userEvent.type(screen.getByLabelText(de.goodsReceipt.form.rejectReason), 'Transportschaden');
    await userEvent.click(screen.getByRole('button', { name: de.goodsReceipt.reject }));

    await waitFor(() => expect(asked.some((a) => a.action === 'goods_receipt_reject_lines')).toBe(true));
    const call = asked.find((a) => a.action === 'goods_receipt_reject_lines');
    expect(call?.input.reason).toBe('Transportschaden');
    expect(call?.input.lineIds).toEqual(['grl_1']);
  });

  it('adds a line against the order open quantity, and can hold it for inspection', async () => {
    const asked: Array<{ action: string; input: Record<string, unknown> }> = [];
    const canned = baseCanned();
    canned.goods_receipt_upsert_lines = ok(DETAIL());
    renderSurface(canned, asked);

    await screen.findByRole('row', { name: /GR-2026-0001/ });
    await userEvent.click(await screen.findByRole('button', { name: de.goodsReceipt.addLine }));
    await screen.findByRole('dialog', { name: de.goodsReceipt.form.lineTitle });

    await userEvent.click(screen.getByLabelText(de.goodsReceipt.form.hold));
    await userEvent.click(screen.getByRole('button', { name: de.goodsReceipt.save }));

    await waitFor(() => expect(asked.some((a) => a.action === 'goods_receipt_upsert_lines')).toBe(true));
    const call = asked.find((a) => a.action === 'goods_receipt_upsert_lines');
    const ops = call?.input.ops as Array<Record<string, unknown>>;
    expect(ops[0]?.op).toBe('add');
    expect(ops[0]?.poLineId).toBe('pol_1');
    expect(ops[0]?.qty).toBe(6);
    expect(ops[0]?.inspectionStatus).toBe('pending');
  });

  it('shows an accepted over-delivery as an exception on the row, the line and in words', async () => {
    // The owner posture: an over-delivery POSTS and is recorded. The surface must say so, or an
    // operator reads a silently inflated quantity and has no idea a discrepancy was accepted.
    const canned = baseCanned();
    canned.goods_receipt_list = ok({ goodsReceipts: [ROW({ status: 'posted', overReceiptQty: 4 })] });
    canned.goods_receipt_get = ok(
      DETAIL({ status: 'posted', hasOverReceipt: true }, [LINE({ qty: 10, movementId: 'stockmv_1', overReceiptQty: 4 })]),
    );
    renderSurface(canned);

    await screen.findByRole('row', { name: /GR-2026-0001/ });
    // On the list row, where a buyer scans.
    expect(await screen.findByText(new RegExp(`${de.goodsReceipt.overReceipt.badge}.*4`))).toBeInTheDocument();
    // On the line, with the quantity interpolated. Awaited: the detail read lands after the list
    // row, so a synchronous get races the fetch under a loaded box.
    expect(await screen.findByText(new RegExp(de.goodsReceipt.overReceipt.line.replace('{qty}', '4')))).toBeInTheDocument();
    // And the reason it was accepted rather than blocked.
    expect(await screen.findByText(de.goodsReceipt.overReceiptHint)).toBeInTheDocument();
  });

  it('offers a lot picker for a lot-tracked item and sends the chosen lot', async () => {
    // The surface used to ship "choose a lot for the line" as an error message while offering no way
    // to choose one, so a lot-tracked item could not be received through Studio at all.
    const asked: Array<{ action: string; input: Record<string, unknown> }> = [];
    const canned = baseCanned();
    canned.lot_list = ok({ lots: [{ id: 'lot_1', number: 'CH-2026-01' }] });
    canned.goods_receipt_upsert_lines = ok(DETAIL());
    renderSurface(canned, asked);

    await screen.findByRole('row', { name: /GR-2026-0001/ });
    await userEvent.click(await screen.findByRole('button', { name: de.goodsReceipt.addLine }));
    await screen.findByRole('dialog', { name: de.goodsReceipt.form.lineTitle });

    const picker = await screen.findByLabelText(de.goodsReceipt.form.lot);
    await userEvent.click(picker);
    await userEvent.click(await screen.findByRole('option', { name: 'CH-2026-01' }));
    await userEvent.click(screen.getByRole('button', { name: de.goodsReceipt.save }));

    await waitFor(() => expect(asked.some((a) => a.action === 'goods_receipt_upsert_lines')).toBe(true));
    const ops = asked.find((a) => a.action === 'goods_receipt_upsert_lines')?.input.ops as Array<Record<string, unknown>>;
    expect(ops[0]?.lotId).toBe('lot_1');
    // The lookup is scoped to the order line's own item, never the whole catalogue.
    expect(asked.find((a) => a.action === 'lot_list')?.input.itemId).toBe('it_1');
  });

  it('offers the NEW-lot field on the first delivery, when the item has no lots yet', async () => {
    // The dead end this replaces: a fresh lot-tracked item has no lots, so hiding the fields left
    // the operator reading "pick a lot" with no way to pick one. A goods receipt is the normal
    // moment a purchased lot comes into existence, so the create field is what has to be there.
    const asked: Array<{ action: string; input: Record<string, unknown> }> = [];
    const canned = baseCanned();
    canned.lot_create = ok({ lot: { id: 'lot_new', number: 'CH-2026-09' } });
    canned.goods_receipt_upsert_lines = ok(DETAIL());
    renderSurface(canned, asked);

    await screen.findByRole('row', { name: /GR-2026-0001/ });
    await userEvent.click(await screen.findByRole('button', { name: de.goodsReceipt.addLine }));
    await screen.findByRole('dialog', { name: de.goodsReceipt.form.lineTitle });

    // No lots exist, so there is no picker, but the create field is offered anyway.
    expect(screen.queryByLabelText(de.goodsReceipt.form.lot)).not.toBeInTheDocument();
    await userEvent.type(await screen.findByLabelText(de.goodsReceipt.form.newLot), 'CH-2026-09');
    await userEvent.click(screen.getByRole('button', { name: de.goodsReceipt.save }));

    await waitFor(() => expect(asked.some((a) => a.action === 'lot_create')).toBe(true));
    const created = asked.find((a) => a.action === 'lot_create');
    expect(created?.input.itemId).toBe('it_1');
    expect(created?.input.number).toBe('CH-2026-09');
    // And the minted lot is what the line then carries.
    const ops = asked.find((a) => a.action === 'goods_receipt_upsert_lines')?.input.ops as Array<Record<string, unknown>>;
    expect(ops[0]?.lotId).toBe('lot_new');
  });

  it('offers a serial by LOCATION, never by status: on-hand units are hidden and a never-received one is not', async () => {
    // `serial_list` is the source, NOT `inventory_available_serials`: that verb returns serials
    // already ON HAND, which are exactly the ones a receipt must not take again.
    const asked: Array<{ action: string; input: Record<string, unknown> }> = [];
    const canned = baseCanned();
    canned.serial_list = ok({
      serials: [
        // Every shape the owning capabilities call "on hand", and each was reachable:
        { id: 'ser_in', number: 'SN-IN-STOCK', status: 'available', currentLocationId: 'loc_1' },
        // J01 treats `reserved` as still notionally in stock (its own archive guard says so).
        { id: 'ser_res', number: 'SN-RESERVED', status: 'reserved', currentLocationId: 'loc_1' },
        // A CUSTOMER RETURN: J02 parks the unit back at a location and leaves the status `returned`,
        // so a status-only filter offers a serial that is physically on the shelf.
        { id: 'ser_back_in', number: 'SN-RETURNED-TO-STOCK', status: 'returned', currentLocationId: 'loc_1' },
        // Returned TO THE VENDOR: not on hand, so genuinely receivable again.
        { id: 'ser_gone', number: 'SN-SENT-BACK', status: 'returned', currentLocationId: null },
        // NEVER RECEIVED. This is the default state of every serial J01 mints (serial_create and
        // serial_create_bulk both write `available` with a null location), so it is the ordinary
        // case, not an edge one: a unit pre-registered from a supplier ASN. Keying the filter on
        // status hid exactly this, and then there was no control to pick it with and retyping the
        // number returned serial_number_taken.
        { id: 'ser_fresh', number: 'SN-FRESH', status: 'available', currentLocationId: null },
      ],
    });
    renderSurface(canned, asked);

    await screen.findByRole('row', { name: /GR-2026-0001/ });
    await userEvent.click(await screen.findByRole('button', { name: de.goodsReceipt.addLine }));
    await screen.findByRole('dialog', { name: de.goodsReceipt.form.lineTitle });

    const picker = await screen.findByLabelText(de.goodsReceipt.form.serial);
    await userEvent.click(picker);
    expect(screen.queryByRole('option', { name: 'SN-IN-STOCK' })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'SN-RESERVED' })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'SN-RETURNED-TO-STOCK' })).not.toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'SN-SENT-BACK' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'SN-FRESH' })).toBeInTheDocument();
    // And the outbound allocation query is never consulted at all.
    expect(asked.some((a) => a.action === 'inventory_available_serials')).toBe(false);
  });

  it('offers no lot or serial fields on a line whose item carries no stock', async () => {
    const canned = baseCanned();
    canned.list_items = ok({ items: [{ id: 'it_1', name: 'Beratung', trackStock: false }] });
    renderSurface(canned);
    await screen.findByRole('row', { name: /GR-2026-0001/ });
    await userEvent.click(await screen.findByRole('button', { name: de.goodsReceipt.addLine }));
    await screen.findByRole('dialog', { name: de.goodsReceipt.form.lineTitle });
    expect(screen.queryByLabelText(de.goodsReceipt.form.newLot)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(de.goodsReceipt.form.newSerial)).not.toBeInTheDocument();
  });

  it('shows WHY Post is unavailable when the reason belongs to the document, not to a line', async () => {
    // A sealed period greys Post out with every line clean. Without this the operator saw a disabled
    // button and nothing at all explaining it, which defeats the point of the preview contract.
    const canned = baseCanned();
    canned.goods_receipt_preview = ok(PREVIEW({ postable: false, issues: ['period_locked'] }));
    renderSurface(canned);

    await screen.findByRole('row', { name: /GR-2026-0001/ });
    await waitFor(() => expect(screen.getByRole('button', { name: de.goodsReceipt.post })).toBeDisabled());
    expect(await screen.findByText(new RegExp(de.goodsReceipt.errors.period_locked))).toBeInTheDocument();
  });

  it('keeps a minted lot reachable when the line add then fails', async () => {
    // The orphan-lot dead end: the lot is written, the add fails, the dropdown is never re-read, and
    // retyping the same number gives lot_number_taken telling the operator to pick it from a list
    // that does not contain it.
    const asked: Array<{ action: string; input: Record<string, unknown> }> = [];
    const canned = baseCanned();
    canned.lot_create = ok({ lot: { id: 'lot_new', number: 'CH-2026-09' } });
    canned.goods_receipt_upsert_lines = reject('qty_exceeds_open', { open: 6 });
    // Once minted, the lot is what `lot_list` returns on the re-read.
    let lotCalls = 0;
    canned.lot_list = () => {
      lotCalls += 1;
      return lotCalls === 1 ? ok({ lots: [] }) : ok({ lots: [{ id: 'lot_new', number: 'CH-2026-09' }] });
    };
    renderSurface(canned, asked);

    await screen.findByRole('row', { name: /GR-2026-0001/ });
    await userEvent.click(await screen.findByRole('button', { name: de.goodsReceipt.addLine }));
    await screen.findByRole('dialog', { name: de.goodsReceipt.form.lineTitle });
    await userEvent.type(await screen.findByLabelText(de.goodsReceipt.form.newLot), 'CH-2026-09');
    await userEvent.click(screen.getByRole('button', { name: de.goodsReceipt.save }));

    // The add was refused and the operator can see why.
    expect(await screen.findByText(de.goodsReceipt.errors.qty_exceeds_open)).toBeInTheDocument();
    // The lot that WAS minted is now in the picker, so the retry is not a dead end.
    const picker = await screen.findByLabelText(de.goodsReceipt.form.lot);
    await userEvent.click(picker);
    expect(screen.getByRole('option', { name: 'CH-2026-09' })).toBeInTheDocument();
    expect(asked.filter((a) => a.action === 'lot_create')).toHaveLength(1);
  });

  it('keeps a minted SERIAL reachable when the line add then fails', async () => {
    // The mirror of the lot case, and it only works because the filter keys on location: a freshly
    // minted serial is `available` with a null location, so a status-based filter would have hidden
    // the very row this re-read exists to expose, and the comment promising it was reachable would
    // have been false.
    const asked: Array<{ action: string; input: Record<string, unknown> }> = [];
    const canned = baseCanned();
    canned.serial_create = ok({ serial: { id: 'ser_new', number: 'SN-NEW' } });
    canned.goods_receipt_upsert_lines = reject('qty_exceeds_open', { open: 6 });
    let serialCalls = 0;
    canned.serial_list = () => {
      serialCalls += 1;
      return serialCalls === 1
        ? ok({ serials: [] })
        : ok({ serials: [{ id: 'ser_new', number: 'SN-NEW', status: 'available', currentLocationId: null }] });
    };
    renderSurface(canned, asked);

    await screen.findByRole('row', { name: /GR-2026-0001/ });
    await userEvent.click(await screen.findByRole('button', { name: de.goodsReceipt.addLine }));
    await screen.findByRole('dialog', { name: de.goodsReceipt.form.lineTitle });
    await userEvent.type(await screen.findByLabelText(de.goodsReceipt.form.newSerial), 'SN-NEW');
    await userEvent.click(screen.getByRole('button', { name: de.goodsReceipt.save }));

    expect(await screen.findByText(de.goodsReceipt.errors.qty_exceeds_open)).toBeInTheDocument();
    const picker = await screen.findByLabelText(de.goodsReceipt.form.serial);
    await userEvent.click(picker);
    expect(screen.getByRole('option', { name: 'SN-NEW' })).toBeInTheDocument();
    expect(asked.filter((a) => a.action === 'serial_create')).toHaveLength(1);
  });

  it('shows the permission-denied state when the list read is refused', async () => {
    // The Studio capability gate fails open by design, so the real denied path a surface handles is
    // the engine refusing the read.
    const canned = baseCanned();
    canned.goods_receipt_list = reject('permission_denied', {}, 403);
    renderSurface(canned);
    await waitFor(() => expect(screen.queryByRole('button', { name: de.goodsReceipt.new })).not.toBeInTheDocument());
    expect(screen.queryByRole('row', { name: /GR-2026-0001/ })).not.toBeInTheDocument();
  });

  it('shows the empty state when nothing has been received yet', async () => {
    const canned = baseCanned();
    canned.goods_receipt_list = ok({ goodsReceipts: [] });
    renderSurface(canned);
    expect(await screen.findByText(de.goodsReceipt.empty.title)).toBeInTheDocument();
  });
});
