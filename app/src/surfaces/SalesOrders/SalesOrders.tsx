/**
 * D03, Aufträge (`/sales-orders`): the order -> delivery -> invoice fulfilment bridge.
 *
 * ONE READ SERVES THE LIST (`sales_order_list`), one serves the open order (`sales_order_get`, which
 * carries its lines, delivery notes and invoice links). The lifecycle is a set of actions whose
 * availability follows the order's status, each a thin call to a `sales_order_*` / `delivery_note_*`
 * verb: confirm (snapshots allocation, POSTS NOTHING), create + issue a delivery note (issue mints the
 * D01 stock movement), render the Lieferschein (a local E00 Beleg), and invoice (delegates to A11 as a
 * DRAFT, still no posting here). The Rückstände filter reads `sales_order_backorders`.
 *
 * THE PERMISSION GATE HERE IS A CONVENIENCE, NOT THE ENFORCEMENT (the standing Studio rule): the
 * engine is the real gate. Without the read right the list is a padlock panel, never an empty list.
 *
 * ## BUILT ON THE SHARED UI PRIMITIVES (D118 B2, 2026-08-24)
 *
 * The order list is the shared `DataTable` (frame overflow, sticky header, density and the five
 * states in one place), row-click driving the detail drawer. The page header, the backorder filter
 * toggle and the create action are the shared `SurfaceHeader`. Both overlays (create, detail) are the
 * shared `DetailDrawer`, which adds the focus trap, Escape and the scrim the bespoke `aside` lacked;
 * the lifecycle actions ride its pinned footer, the deliver sub-form its scrolling body. The
 * per-surface CSS that duplicated the list table, the page header and the drawer chrome is gone. Round
 * 2: every state (order, backorder, delivery note) is the shared `Status` word (K-22, no dingbats),
 * the drawer's ordered/delivered/invoiced lines are a `DataTable` too, the inputs are `.field`, and
 * nothing here is a money write, so no button is the tinted `.btn--accent` (K-08). What remains is
 * genuinely D03-specific: the create form and line grid, the delivery-note list and the deliver
 * sub-form.
 *
 * No `FilterBar`: the surface has no text search, and its single backorder toggle rides the header
 * (the C02 Offerten precedent). No `Provenance` (C3): the list read carries no actor or timestamp. No
 * `ConsequenceLine` (C4): no D03 verb carries an engine consequence sentence.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';

import { useClient } from '../../lib/client-context';
import { isErr, type Err } from '../../lib/client';
import { CAP, useCapabilities } from '../../lib/capabilities';
import { useWorkspaceId } from '../../app/workspace';
import { useT } from '../../i18n';
import { EmptyState, ErrorBanner, NoWorkspaceState, PermissionDenied, Skeleton } from '../../components/states';
import { DataTable, type DataTableColumn } from '../../components/DataTable';
import { SurfaceHeader } from '../../components/SurfaceHeader';
import { DetailDrawer } from '../../components/DetailDrawer';
import { Select } from '../../components/Select';
import { SurfaceHelp } from '../../components/SurfaceHelp';
import { Status, type StatusKind } from '../../components/Status';
import { CloseGlyph } from '../../components/icons';
import './SalesOrders.css';

const newKey = () => crypto.randomUUID();

interface OrderRow {
  id: string;
  number: string;
  contactId: string | null;
  status: string;
  currency: string;
}

interface OrderLine {
  id: string;
  itemId: string | null;
  description: string | null;
  qty: number;
  unitPriceMinor: number;
  deliveredQty: number;
  invoicedQty: number;
  backorderQty: number;
  outstandingQty: number;
}

interface DeliveryNote {
  id: string;
  number: string;
  status: string;
  artifactDocumentId: string | null;
}

interface OrderDetail {
  order: OrderRow;
  lines: OrderLine[];
  deliveryNotes: DeliveryNote[];
  invoiceIds: string[];
}

interface LocationOpt {
  id: string;
  name: string;
  archived: boolean;
}

/**
 * The Status kind per order state (K-22): the shared glyph plus the word, never a dingbat and never
 * colour alone (spec §6, WCAG 2.2). Confirmed and partly delivered orders are under way, delivered
 * and invoiced ones done, a cancelled one out of play.
 */
const STATUS_KIND: Record<string, StatusKind> = {
  draft: 'neutral',
  confirmed: 'pending',
  partially_delivered: 'pending',
  delivered: 'success',
  invoiced: 'success',
  cancelled: 'inactive',
};

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function parseOrders(body: unknown): OrderRow[] | null {
  if (body === null || typeof body !== 'object') return null;
  const rows = (body as { salesOrders?: unknown }).salesOrders;
  if (!Array.isArray(rows)) return null;
  return rows
    .filter((r): r is Record<string, unknown> => r !== null && typeof r === 'object' && typeof (r as { id?: unknown }).id === 'string')
    .map((r) => ({
      id: r.id as string,
      number: typeof r.number === 'string' ? r.number : '-',
      contactId: typeof r.contactId === 'string' ? r.contactId : null,
      status: typeof r.status === 'string' ? r.status : 'draft',
      currency: typeof r.currency === 'string' ? r.currency : 'CHF',
    }));
}

function parseDetail(body: unknown): OrderDetail | null {
  if (body === null || typeof body !== 'object') return null;
  const so = (body as { salesOrder?: unknown }).salesOrder;
  if (so === null || typeof so !== 'object' || typeof (so as { id?: unknown }).id !== 'string') return null;
  const o = so as Record<string, unknown>;
  return {
    order: {
      id: o.id as string,
      number: typeof o.number === 'string' ? o.number : '-',
      contactId: typeof o.contactId === 'string' ? o.contactId : null,
      status: typeof o.status === 'string' ? o.status : 'draft',
      currency: typeof o.currency === 'string' ? o.currency : 'CHF',
    },
    lines: asArray<Record<string, unknown>>((body as { lines?: unknown }).lines).map((l) => ({
      id: l.id as string,
      itemId: typeof l.itemId === 'string' ? l.itemId : null,
      description: typeof l.description === 'string' ? l.description : null,
      qty: Number(l.qty ?? 0),
      unitPriceMinor: Number(l.unitPriceMinor ?? 0),
      deliveredQty: Number(l.deliveredQty ?? 0),
      invoicedQty: Number(l.invoicedQty ?? 0),
      backorderQty: Number(l.backorderQty ?? 0),
      outstandingQty: Number(l.outstandingQty ?? 0),
    })),
    deliveryNotes: asArray<Record<string, unknown>>((body as { deliveryNotes?: unknown }).deliveryNotes).map((n) => ({
      id: n.id as string,
      number: typeof n.number === 'string' ? n.number : '-',
      status: typeof n.status === 'string' ? n.status : 'draft',
      artifactDocumentId: typeof n.artifactDocumentId === 'string' ? n.artifactDocumentId : null,
    })),
    invoiceIds: asArray<string>((body as { invoiceIds?: unknown }).invoiceIds),
  };
}

function parseContacts(body: unknown): Map<string, string> {
  const out = new Map<string, string>();
  for (const c of asArray<Record<string, unknown>>((body as { contacts?: unknown })?.contacts)) {
    if (typeof c.id === 'string') out.set(c.id, typeof c.name === 'string' ? c.name : c.id);
  }
  return out;
}

interface ItemOpt {
  id: string;
  name: string;
}

function parseItems(body: unknown): ItemOpt[] {
  return asArray<Record<string, unknown>>((body as { items?: unknown })?.items)
    .filter((i) => typeof i.id === 'string')
    .map((i) => ({ id: i.id as string, name: typeof i.name === 'string' ? i.name : (i.id as string) }));
}

function toMinor(value: string): number | null {
  const parsed = Number.parseFloat(value.replace(/'/g, '').replace(',', '.'));
  if (Number.isNaN(parsed) || parsed < 0) return null;
  return Math.round(parsed * 100);
}

interface LineDraft {
  itemId: string;
  description: string;
  qty: string;
  price: string;
}

const EMPTY_LINE: LineDraft = { itemId: '', description: '', qty: '1', price: '' };

export function SalesOrders() {
  const t = useT();
  const client = useClient();
  const workspaceId = useWorkspaceId();
  const { can } = useCapabilities();

  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [contacts, setContacts] = useState<Map<string, string>>(new Map());
  const [items, setItems] = useState<ItemOpt[]>([]);
  const [locations, setLocations] = useState<LocationOpt[]>([]);
  const [backorderIds, setBackorderIds] = useState<Set<string>>(new Set());
  const [onlyBackorders, setOnlyBackorders] = useState(false);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [denied, setDenied] = useState(false);
  const [writeError, setWriteError] = useState<Err | null>(null);
  const [creating, setCreating] = useState(false);
  const [contactId, setContactId] = useState('');
  const [lines, setLines] = useState<LineDraft[]>([{ ...EMPTY_LINE }]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<OrderDetail | null>(null);
  const [deliverLocation, setDeliverLocation] = useState('');

  const canWrite = can(CAP.issue);

  const load = useCallback(async () => {
    if (workspaceId === null) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setFailed(false);
    setDenied(false);
    const [listed, contactList, itemList, onHand, backorders] = await Promise.all([
      client.call('sales_order_list', { workspaceId }),
      client.call('list_contacts', { workspaceId }),
      client.call('list_items', { workspaceId }),
      client.call('stock_on_hand', { workspaceId }),
      client.call('sales_order_backorders', { workspaceId }),
    ]);
    if (isErr(listed.body)) {
      if (listed.body.error === 'permission_denied' || listed.status === 403) setDenied(true);
      else setFailed(true);
      setLoading(false);
      return;
    }
    const parsed = parseOrders(listed.body);
    if (parsed === null) {
      setFailed(true);
      setLoading(false);
      return;
    }
    setOrders(parsed);
    if (!isErr(contactList.body)) setContacts(parseContacts(contactList.body));
    if (!isErr(itemList.body)) setItems(parseItems(itemList.body));
    if (!isErr(onHand.body)) setLocations(asArray<LocationOpt>((onHand.body as { locations?: unknown }).locations));
    if (!isErr(backorders.body)) {
      const bs = asArray<Record<string, unknown>>((backorders.body as { backorders?: unknown }).backorders);
      setBackorderIds(new Set(bs.map((b) => b.salesOrderId as string)));
    }
    setLoading(false);
  }, [client, workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadDetail = useCallback(
    async (id: string) => {
      if (workspaceId === null) return;
      const res = await client.call('sales_order_get', { workspaceId, salesOrderId: id });
      if (!isErr(res.body)) setDetail(parseDetail(res.body));
    },
    [client, workspaceId],
  );

  useEffect(() => {
    if (openId !== null) void loadDetail(openId);
    else setDetail(null);
  }, [openId, loadDetail]);

  const write = useCallback(
    async (action: string, input: Record<string, unknown>): Promise<Record<string, unknown> | null> => {
      if (workspaceId === null) return null;
      setWriteError(null);
      const response = await client.call(action, { workspaceId, ...input });
      if (isErr(response.body)) {
        setWriteError(response.body);
        return null;
      }
      await load();
      if (openId !== null) await loadDetail(openId);
      return response.body as unknown as Record<string, unknown>;
    },
    [client, workspaceId, load, loadDetail, openId],
  );

  const create = useCallback(async () => {
    const built = lines
      .filter((l) => l.itemId !== '' || l.description.trim() !== '')
      .map((l) => {
        const qtyUnits = Number.parseInt(l.qty, 10);
        const quantityMilli = Number.isInteger(qtyUnits) && qtyUnits > 0 ? qtyUnits * 1000 : 1000;
        return l.itemId !== ''
          ? { itemId: l.itemId, quantityMilli }
          : { description: l.description, quantityMilli, unitPriceMinor: toMinor(l.price) ?? -1 };
      });
    const body = await write('sales_order_create', {
      ...(contactId === '' ? {} : { contactId }),
      lines: built,
      idempotencyKey: newKey(),
    });
    if (body !== null) {
      setCreating(false);
      setContactId('');
      setLines([{ ...EMPTY_LINE }]);
    }
  }, [write, lines, contactId]);

  const deliver = useCallback(
    async (orderId: string) => {
      if (deliverLocation === '') return;
      const created = await write('delivery_note_create', { salesOrderId: orderId, locationId: deliverLocation, idempotencyKey: newKey() });
      if (created !== null && typeof (created as { deliveryNote?: { id?: unknown } }).deliveryNote?.id === 'string') {
        await write('delivery_note_issue', { deliveryNoteId: (created as { deliveryNote: { id: string } }).deliveryNote.id, actor: 'Studio', idempotencyKey: newKey() });
      }
    },
    [write, deliverLocation],
  );

  /** Open an order's drawer. Switching orders drops the previous order's deliver-location choice and
      any write refusal so a stale value never bleeds into a different order's context. */
  const openOrder = useCallback((orderId: string) => {
    setOpenId((current) => {
      if (current === orderId) return current;
      setDeliverLocation('');
      setWriteError(null);
      return orderId;
    });
  }, []);

  /** Close the drawer. DetailDrawer's focus trap returns focus to the row that opened it. */
  const closeDrawer = useCallback(() => {
    setOpenId(null);
    setDeliverLocation('');
  }, []);

  const openCreate = useCallback(() => {
    setWriteError(null);
    setContactId('');
    setLines([{ ...EMPTY_LINE }]);
    setCreating(true);
  }, []);

  const errorMessage = (error: Err): string => {
    const known = ['no_lines', 'over_delivery', 'insufficient_stock', 'has_deliveries', 'nothing_to_invoice', 'invalid_transition', 'not_issued', 'invalid_reference', 'unknown_item', 'invalid_qty'];
    if (known.includes(error.error)) return t(`so.error.${error.error}`);
    if (error.error === 'permission_denied') return t('so.error.permissionDenied.write');
    return t('errors.fallback');
  };

  if (workspaceId === null) return <NoWorkspaceState />;
  if (denied) return <PermissionDenied body={t('so.error.permissionDenied.read')} />;

  const visible = onlyBackorders ? orders.filter((o) => backorderIds.has(o.id)) : orders;
  const statusLabel = (s: string) => t(`so.status.${s}`);
  const statusChip = (s: string) => <Status kind={STATUS_KIND[s] ?? 'neutral'} label={statusLabel(s)} />;
  // A contact or an item the side reads did not return reads as such, never as its raw id (K-38).
  const contactName = (id: string | null) => (id === null ? '-' : contacts.get(id) ?? t('so.unknownContact'));
  const lineName = (l: OrderLine) =>
    l.description ?? (l.itemId === null ? '-' : items.find((i) => i.id === l.itemId)?.name ?? t('so.unknownItem'));
  const activeLocations = locations.filter((l) => !l.archived);
  const selectedRow = openId === null ? undefined : orders.find((o) => o.id === openId);

  // The list columns: text left, the status the shared Status word followed by the backorder state,
  // itself a warn Status word (waiting on stock is an attention state, never the accent).
  const columns: DataTableColumn<OrderRow>[] = [
    { key: 'number', header: t('so.field.number'), render: (o) => o.number },
    { key: 'contact', header: t('so.field.contact'), render: (o) => contactName(o.contactId) },
    {
      key: 'status',
      header: t('so.field.status'),
      render: (o) => (
        <span className="so-status">
          {statusChip(o.status)}
          {backorderIds.has(o.id) && <Status kind="warn" label={t('so.badge.backorder')} />}
        </span>
      ),
    },
  ];

  // The drawer's line table: the item left, the three quantities numeric and tabular. Quantities are
  // the engine's milli-units shown as units, exactly as before; no money is shown here.
  const lineColumns: DataTableColumn<OrderLine>[] = [
    {
      key: 'item',
      header: t('so.field.item'),
      render: (l) => (
        <span className="so-status">
          {lineName(l)}
          {l.backorderQty > 0 && <Status kind="warn" label={t('so.badge.backorder')} />}
        </span>
      ),
    },
    { key: 'ordered', header: t('so.field.ordered'), numeric: true, render: (l) => (l.qty / 1000).toString() },
    { key: 'delivered', header: t('so.field.delivered'), numeric: true, render: (l) => (l.deliveredQty / 1000).toString() },
    { key: 'invoiced', header: t('so.field.invoiced'), numeric: true, render: (l) => (l.invoicedQty / 1000).toString() },
  ];

  // The backorder filter toggle and the create action ride the SurfaceHeader actions slot.
  const headerActions = (
    <>
      <label className="so-toggle">
        <input type="checkbox" checked={onlyBackorders} onChange={(e) => setOnlyBackorders(e.target.checked)} />
        <span>{t('so.filter.backorders')}</span>
      </label>
      {canWrite && (
        <button type="button" className="btn btn--primary" onClick={openCreate}>
          {t('so.action.new')}
        </button>
      )}
    </>
  );

  // The detail drawer's pinned action row, assembled per status. Deliver lives in the body with its
  // location select; here sit the pure lifecycle buttons. One primary per view (K-08), across body and
  // foot (see the deliver button below). None of these is a money write (the invoice is a draft), so
  // none is the tinted `.btn--accent`.
  const detailActions: ReactNode[] = [];
  if (detail !== null && canWrite) {
    if (detail.order.status === 'draft') {
      detailActions.push(
        <button key="confirm" type="button" className="btn btn--primary" onClick={() => void write('sales_order_confirm', { salesOrderId: detail.order.id, idempotencyKey: newKey() })}>
          {t('so.action.confirm')}
        </button>,
      );
    }
    if (detail.order.status === 'partially_delivered' || detail.order.status === 'delivered') {
      detailActions.push(
        <button key="invoice" type="button" className="btn btn--primary" onClick={() => void write('sales_order_invoice', { salesOrderId: detail.order.id, actor: 'Studio', idempotencyKey: newKey() })}>
          {t('so.action.invoice')}
        </button>,
      );
    }
    if (detail.order.status === 'draft' || detail.order.status === 'confirmed') {
      detailActions.push(
        <button key="cancel" type="button" className="btn btn--secondary" onClick={() => void write('sales_order_cancel', { salesOrderId: detail.order.id, idempotencyKey: newKey() })}>
          {t('so.action.cancel')}
        </button>,
      );
    }
  }

  return (
    <section className="so" aria-labelledby="so-title">
      <SurfaceHeader
        title={t('so.tab.title')}
        titleId="so-title"
        help={<SurfaceHelp surface="SalesOrders" />}
        actions={headerActions}
      />

      {failed && <ErrorBanner message={t('so.error.transport')} onRetry={() => void load()} />}

      {!failed && (
        <DataTable
          columns={columns}
          rows={visible}
          rowKey={(o) => o.id}
          caption={t('so.tab.title')}
          loading={loading}
          skeletonRows={4}
          onRowClick={(o) => openOrder(o.id)}
          rowLabel={(o) => t('so.rowOpen', { row: o.number })}
          emptyState={
            onlyBackorders ? (
              // The filter hides every order: say so and offer the way back, never create (K-33).
              <EmptyState
                title={t('so.emptyBackorders')}
                hint={t('so.emptyBackordersHint')}
                filtered={{ onClear: () => setOnlyBackorders(false), clearLabel: t('so.filter.clear') }}
              />
            ) : (
              <EmptyState
                title={t('so.empty')}
                hint={t('so.emptyHint')}
                action={canWrite ? { label: t('so.action.new'), onClick: openCreate } : undefined}
              />
            )
          }
        />
      )}

      {creating && canWrite && (
        <DetailDrawer
          open
          onClose={() => setCreating(false)}
          title={t('so.action.new')}
          closeLabel={t('so.drawer.close')}
          footer={
            <>
              <button type="button" className="btn btn--secondary" onClick={() => setCreating(false)}>
                {t('so.editor.discard')}
              </button>
              <button type="submit" form="so-create-form" className="btn btn--primary">
                {t('so.editor.save')}
              </button>
            </>
          }
        >
          {writeError !== null && <ErrorBanner message={errorMessage(writeError)} />}
          <form
            id="so-create-form"
            className="so-editor"
            aria-label={t('so.action.new')}
            onSubmit={(e) => {
              e.preventDefault();
              void create();
            }}
          >
            <div className="so-field">
              <span>{t('so.field.contact')}</span>
              <Select
                value={contactId}
                onChange={setContactId}
                options={[
                  { value: '', label: t('so.field.contactPick') },
                  ...[...contacts.entries()].map(([id, name]) => ({ value: id, label: name })),
                ]}
                ariaLabel={t('so.field.contact')}
              />
            </div>
            <fieldset className="so-lines">
              <legend>{t('so.field.lines')}</legend>
              {lines.map((line, index) => (
                <div key={index} className="so-line-row">
                  <Select
                    ariaLabel={t('so.field.item')}
                    value={line.itemId}
                    onChange={(value) => {
                      const next = lines.slice();
                      next[index] = { ...next[index], itemId: value };
                      setLines(next);
                    }}
                    options={[
                      { value: '', label: t('so.field.freeText') },
                      ...items.map((i) => ({ value: i.id, label: i.name })),
                    ]}
                  />
                  {line.itemId === '' && (
                    <input
                      type="text"
                      className="field so-line-desc"
                      aria-label={t('so.field.lineDesc')}
                      placeholder={t('so.field.lineDesc')}
                      value={line.description}
                      onChange={(e) => {
                        const next = lines.slice();
                        next[index] = { ...next[index], description: e.target.value };
                        setLines(next);
                      }}
                    />
                  )}
                  <input
                    type="number"
                    min="1"
                    className="field so-line-qty t-num"
                    aria-label={t('so.field.qty')}
                    value={line.qty}
                    onChange={(e) => {
                      const next = lines.slice();
                      next[index] = { ...next[index], qty: e.target.value };
                      setLines(next);
                    }}
                  />
                  {line.itemId === '' && (
                    <input
                      type="text"
                      inputMode="decimal"
                      className="field so-line-price t-num"
                      aria-label={t('so.field.price')}
                      placeholder="1'500.00"
                      value={line.price}
                      onChange={(e) => {
                        const next = lines.slice();
                        next[index] = { ...next[index], price: e.target.value };
                        setLines(next);
                      }}
                    />
                  )}
                  {lines.length > 1 && (
                    <button
                      type="button"
                      className="btn btn--ghost btn--icon btn--sm"
                      aria-label={t('so.action.removeLine')}
                      onClick={() => setLines(lines.filter((_, i) => i !== index))}
                    >
                      <CloseGlyph aria-hidden="true" />
                    </button>
                  )}
                </div>
              ))}
              <button type="button" className="btn btn--secondary btn--sm" onClick={() => setLines([...lines, { ...EMPTY_LINE }])}>
                {t('so.action.addLine')}
              </button>
            </fieldset>
          </form>
        </DetailDrawer>
      )}

      {selectedRow !== undefined && (
        <DetailDrawer
          open
          onClose={closeDrawer}
          title={selectedRow.number}
          closeLabel={t('so.drawer.close')}
          headerExtra={statusChip((detail ?? { order: selectedRow }).order.status)}
          footer={detailActions.length > 0 ? <>{detailActions}</> : undefined}
        >
          {writeError !== null && <ErrorBanner message={errorMessage(writeError)} />}

          {detail === null ? (
            <Skeleton rows={4} />
          ) : (
            <>
              <DataTable
                columns={lineColumns}
                rows={detail.lines}
                rowKey={(l) => l.id}
                caption={t('so.field.lines')}
              />

              {detail.deliveryNotes.length > 0 && (
                <div className="so-notes">
                  <h3>{t('so.notes.title')}</h3>
                  <ul>
                    {detail.deliveryNotes.map((n) => (
                      <li key={n.id}>
                        <span className="so-note-number">{n.number}</span>
                        <Status kind={n.status === 'issued' ? 'success' : 'neutral'} label={t(`dn.status.${n.status === 'issued' ? 'issued' : 'draft'}`)} />
                        {canWrite && n.status === 'issued' && (
                          <button
                            type="button"
                            className="btn btn--secondary btn--sm"
                            onClick={() => void write('delivery_note_render', { deliveryNoteId: n.id, idempotencyKey: newKey() })}
                          >
                            {t('dn.action.render')}
                          </button>
                        )}
                        {n.artifactDocumentId !== null && <span className="so-dim">{t('dn.filed')}</span>}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {canWrite && (detail.order.status === 'confirmed' || detail.order.status === 'partially_delivered') && (
                <div className="so-deliver">
                  <div className="so-field">
                    <span>{t('so.field.location')}</span>
                    <Select
                      value={deliverLocation}
                      onChange={setDeliverLocation}
                      options={[
                        { value: '', label: t('so.field.locationPick') },
                        ...activeLocations.map((l) => ({ value: l.id, label: l.name })),
                      ]}
                      ariaLabel={t('so.field.location')}
                    />
                  </div>
                  {/* When an order is partially delivered, invoicing already spends the drawer's one
                      primary, so this go action drops to secondary (K-08, D137: one primary per view,
                      and the tinted accent is only the commit of a money write, which a delivery is
                      not). */}
                  <button
                    type="button"
                    className={detail.order.status === 'partially_delivered' ? 'btn btn--secondary' : 'btn btn--primary'}
                    disabled={deliverLocation === ''}
                    onClick={() => void deliver(detail.order.id)}
                  >
                    {t('so.action.deliver')}
                  </button>
                </div>
              )}

              {detail.invoiceIds.length > 0 && (
                <p className="so-invoiced" role="note">
                  {t('so.invoiceLinked')} {detail.invoiceIds.length}
                </p>
              )}
            </>
          )}
        </DetailDrawer>
      )}
    </section>
  );
}
export default SalesOrders;
