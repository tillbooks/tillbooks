/**
 * D02, Einkauf (`/purchasing`): PO -> goods receipt -> 3-way match, plus supplier prices.
 *
 * ONE READ SERVES THE LIST (`po_list`), one serves the open order (`po_get`, carrying its lines,
 * receipts and match records). The lifecycle is a set of actions whose availability follows the PO's
 * status, each a thin call to a `po_*` / `receipt_record` verb: send (P8, renders an artifact and stops
 * without transmitting), record a goods receipt (mints the D01 stock movement through stock.move),
 * close-short, cancel and revise. The Offene Mengen tab reads `po_open_lines`; the Lieferantenpreise tab
 * reads/writes `supplier_price_*`. D02 POSTS NOTHING here: the money effect lives on the A17 bill.
 *
 * THE PERMISSION GATE HERE IS A CONVENIENCE, NOT THE ENFORCEMENT (the standing Studio rule): the engine
 * is the real gate. Without the read right the surface is a padlock panel, never an empty list.
 *
 * ## BUILT ON THE SHARED UI PRIMITIVES (D118 B2, 2026-08-24)
 *
 * The page header is the shared `SurfaceHeader` (sticky title, help slot, the New-order action pinned
 * right). Every list is the shared `DataTable`: the purchase orders (row-click opens the detail), the
 * open quantities, the supplier prices and the drawer's own line breakdown, so the frame overflow,
 * sticky header, density and the five states live in one place and the per-surface `<table>` CSS is
 * gone. The create form and the order detail are the shared `DetailDrawer`, which adds the focus trap,
 * Escape and scrim the inline accordion lacked. What stays is genuinely D02-specific: the tab strip
 * (kept bespoke because the Scorecard tab is lazily mounted and does its own heavy reads), the status
 * glyph+label, the create/receipt/price forms and the embedded 3-way-match panel (BillMatchPanel).
 *
 * No `Provenance` (C3): a PoRow carries no created-by/at, so there is no provenance line to render. No
 * `ConsequenceLine` (C4): the D02 verbs carry no engine consequence sentence here.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';

import { useClient } from '../../lib/client-context';
import { isErr, type Err } from '../../lib/client';
import { CAP, useCapabilities } from '../../lib/capabilities';
import { useWorkspaceId } from '../../app/workspace';
import { useT, formatMoney, formatDate } from '../../i18n';
import { EmptyState, ErrorBanner, NoWorkspaceState, PermissionDenied } from '../../components/states';
import { DataTable, type DataTableColumn } from '../../components/DataTable';
import { SurfaceHeader } from '../../components/SurfaceHeader';
import { DetailDrawer } from '../../components/DetailDrawer';
import { SurfaceHelp } from '../../components/SurfaceHelp';
import { SupplierScorecard } from './SupplierScorecard';
import './Purchasing.css';

const newKey = () => crypto.randomUUID();

interface PoRow {
  id: string;
  number: string;
  supplierContactId: string;
  status: string;
  revision: number;
  currency: string;
  totalRappen: number;
  expectedOn: string | null;
}

interface PoLine {
  id: string;
  itemId: string | null;
  description: string | null;
  qty: number;
  unitPriceRappen: number;
  receivedQty: number;
  billedQty: number;
  openQty: number;
}

interface Receipt {
  id: string;
  locationId: string;
  receivedAt: string;
}

interface MatchRow {
  id: string;
  billId: string;
  status: string;
  priceVarianceRappen: number;
}

interface PoDetail {
  po: PoRow;
  lines: PoLine[];
  receipts: Receipt[];
  matches: MatchRow[];
}

interface OpenLine {
  lineId: string;
  poId: string;
  poNumber: string;
  itemId: string | null;
  qty: number;
  receivedQty: number;
  openQty: number;
}

interface ItemOpt {
  id: string;
  name: string;
}

interface LocationOpt {
  id: string;
  name: string;
  archived: boolean;
}

interface PriceRow {
  id: string;
  supplierContactId: string;
  itemId: string;
  supplierSku: string | null;
  priceRappen: number;
  currency: string;
  validFrom: string;
  leadTimeDays: number | null;
}

/** Glyph AND label, never colour alone (spec §6, WCAG 2.2). */
const STATUS_GLYPH: Record<string, string> = {
  draft: '✎',
  sent: '→',
  received: '◆',
  closed: '✓',
  cancelled: '✕',
};

type Tab = 'orders' | 'open' | 'prices' | 'scorecard';

interface LineDraft {
  itemId: string;
  qty: string;
  price: string;
}

const EMPTY_LINE: LineDraft = { itemId: '', qty: '1', price: '' };

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

export function Purchasing() {
  const t = useT();
  const client = useClient();
  const workspaceId = useWorkspaceId();
  const { can } = useCapabilities();

  const [tab, setTab] = useState<Tab>('orders');
  const [pos, setPos] = useState<PoRow[]>([]);
  const [contacts, setContacts] = useState<Map<string, string>>(new Map());
  const [items, setItems] = useState<ItemOpt[]>([]);
  const [locations, setLocations] = useState<LocationOpt[]>([]);
  const [openLines, setOpenLines] = useState<OpenLine[]>([]);
  const [prices, setPrices] = useState<PriceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [denied, setDenied] = useState(false);
  const [writeError, setWriteError] = useState<Err | null>(null);

  const [creating, setCreating] = useState(false);
  const [supplierId, setSupplierId] = useState('');
  const [lines, setLines] = useState<LineDraft[]>([{ ...EMPTY_LINE }]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<PoDetail | null>(null);
  const [receiptLocation, setReceiptLocation] = useState('');
  const [receiptQty, setReceiptQty] = useState<Record<string, string>>({});

  const canWrite = can(CAP.manageMasterData);

  const load = useCallback(async () => {
    if (workspaceId === null) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setFailed(false);
    setDenied(false);
    const [listed, contactList, itemList, onHand, open, priceList] = await Promise.all([
      client.call('po_list', { workspaceId }),
      client.call('list_contacts', { workspaceId }),
      client.call('list_items', { workspaceId }),
      client.call('stock_on_hand', { workspaceId }),
      client.call('po_open_lines', { workspaceId }),
      client.call('supplier_price_list', { workspaceId }),
    ]);
    if (isErr(listed.body)) {
      if (listed.body.error === 'permission_denied' || listed.status === 403) setDenied(true);
      else setFailed(true);
      setLoading(false);
      return;
    }
    setPos(asArray<PoRow>((listed.body as { pos?: unknown }).pos));
    if (!isErr(contactList.body)) {
      const cs = asArray<{ id: string; name: string }>((contactList.body as { contacts?: unknown }).contacts);
      setContacts(new Map(cs.map((c) => [c.id, c.name])));
    }
    if (!isErr(itemList.body)) setItems(asArray<ItemOpt>((itemList.body as { items?: unknown }).items));
    if (!isErr(onHand.body)) setLocations(asArray<LocationOpt>((onHand.body as { locations?: unknown }).locations));
    if (!isErr(open.body)) setOpenLines(asArray<OpenLine>((open.body as { lines?: unknown }).lines));
    if (!isErr(priceList.body)) setPrices(asArray<PriceRow>((priceList.body as { prices?: unknown }).prices));
    setLoading(false);
  }, [client, workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadDetail = useCallback(
    async (id: string) => {
      if (workspaceId === null) return;
      const res = await client.call('po_get', { workspaceId, poId: id });
      if (!isErr(res.body)) setDetail(res.body as unknown as PoDetail);
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
      .filter((l) => l.itemId !== '')
      .map((l) => {
        const qty = Number.parseInt(l.qty, 10);
        const priceRappen = l.price === '' ? undefined : Math.round(Number.parseFloat(l.price) * 100);
        return {
          itemId: l.itemId,
          qty: Number.isInteger(qty) && qty > 0 ? qty : 1,
          ...(priceRappen !== undefined && Number.isFinite(priceRappen) ? { unitPriceRappen: priceRappen } : {}),
        };
      });
    const body = await write('po_upsert', {
      ...(supplierId === '' ? {} : { supplierContactId: supplierId }),
      lines: built,
      idempotencyKey: newKey(),
    });
    if (body !== null) {
      setCreating(false);
      setSupplierId('');
      setLines([{ ...EMPTY_LINE }]);
      if (typeof (body as { poId?: unknown }).poId === 'string') setOpenId((body as { poId: string }).poId);
    }
  }, [write, lines, supplierId]);

  const recordReceipt = useCallback(
    async (po: PoDetail) => {
      if (receiptLocation === '') return;
      const receiptLines = po.lines
        .map((l) => ({ poLineId: l.id, qty: Number.parseInt(receiptQty[l.id] ?? '', 10) }))
        .filter((r) => Number.isInteger(r.qty) && r.qty > 0);
      if (receiptLines.length === 0) return;
      const done = await write('receipt_record', { poId: po.po.id, locationId: receiptLocation, lines: receiptLines, actor: 'Studio', idempotencyKey: newKey() });
      if (done !== null) setReceiptQty({});
    },
    [write, receiptLocation, receiptQty],
  );

  const errorMessage = (error: Err): string => {
    const known = ['no_lines', 'over_receipt', 'variance_exceeded', 'has_receipts', 'nothing_received', 'qty_below_received', 'already_matched', 'invalid_transition', 'invalid_reference', 'invalid_qty'];
    if (known.includes(error.error)) return t(`po.error.${error.error}`);
    if (error.error === 'permission_denied') return t('po.error.permissionDenied.write');
    return t('errors.fallback');
  };

  if (workspaceId === null) return <NoWorkspaceState />;
  if (denied) return <PermissionDenied body={t('po.error.permissionDenied.read')} />;

  const statusLabel = (s: string) => t(`po.status.${s}`);
  const statusGlyph = (s: string) => STATUS_GLYPH[s] ?? '○';
  const activeLocations = locations.filter((l) => !l.archived);
  const itemName = (id: string | null) => (id === null ? '' : items.find((i) => i.id === id)?.name ?? id);

  /** Status as glyph AND label, the one place both are assembled for the list and the drawer. */
  const statusTag = (s: string): ReactNode => (
    <span className="po-status">
      <span aria-hidden="true">{statusGlyph(s)}</span> {statusLabel(s)}
    </span>
  );

  const drawerOpen = creating || openId !== null;

  const openColumns: DataTableColumn<OpenLine>[] = [
    { key: 'number', header: t('po.field.number'), render: (l) => l.poNumber },
    { key: 'item', header: t('po.field.item'), render: (l) => itemName(l.itemId) },
    { key: 'ordered', header: t('po.field.ordered'), numeric: true, render: (l) => l.qty },
    { key: 'received', header: t('po.field.received'), numeric: true, render: (l) => l.receivedQty },
    { key: 'open', header: t('po.field.open'), numeric: true, render: (l) => l.openQty },
  ];

  const poColumns: DataTableColumn<PoRow>[] = [
    { key: 'number', header: t('po.field.number'), render: (po) => <span className="po-code">{po.number}</span> },
    { key: 'supplier', header: t('po.field.supplier'), render: (po) => contacts.get(po.supplierContactId) ?? po.supplierContactId },
    { key: 'status', header: t('po.field.status'), render: (po) => statusTag(po.status) },
    { key: 'total', header: t('po.field.price'), numeric: true, render: (po) => formatMoney(po.totalRappen, po.currency) },
  ];

  const headerActions =
    canWrite && tab === 'orders' ? (
      <button
        type="button"
        className="btn btn--primary"
        onClick={() => {
          setWriteError(null);
          setSupplierId('');
          setLines([{ ...EMPTY_LINE }]);
          setCreating(true);
        }}
      >
        {t('po.action.new')}
      </button>
    ) : undefined;

  return (
    <section className="po" aria-labelledby="po-title">
      <SurfaceHeader title={t('po.title')} titleId="po-title" help={<SurfaceHelp surface="Purchasing" />} actions={headerActions} />

      <nav className="po-tabs" aria-label={t('po.title')}>
        {(['orders', 'open', 'prices', 'scorecard'] as Tab[]).map((tabId) => (
          <button
            key={tabId}
            type="button"
            className={tab === tabId ? 'po-tab po-tab--active' : 'po-tab'}
            aria-current={tab === tabId ? 'page' : undefined}
            onClick={() => setTab(tabId)}
          >
            {t(`po.tab.${tabId}`)}
          </button>
        ))}
      </nav>

      {!drawerOpen && writeError !== null && <ErrorBanner message={errorMessage(writeError)} />}
      {failed && <ErrorBanner message={t('po.error.transport')} onRetry={() => void load()} />}

      {tab === 'orders' ? (
        <DataTable
          columns={poColumns}
          rows={pos}
          rowKey={(po) => po.id}
          caption={t('po.list.caption')}
          loading={loading}
          onRowClick={(po) => setOpenId(po.id)}
          rowLabel={(po) => po.number}
          emptyState={<EmptyState title={t('po.empty')} />}
        />
      ) : tab === 'open' ? (
        <DataTable
          columns={openColumns}
          rows={openLines}
          rowKey={(l) => l.lineId}
          caption={t('po.open.caption')}
          loading={loading}
          emptyState={<EmptyState title={t('po.emptyOpen')} />}
        />
      ) : tab === 'prices' ? (
        <SupplierPrices prices={prices} contacts={contacts} items={items} t={t} canWrite={canWrite} itemName={itemName} write={write} loading={loading} />
      ) : (
        <SupplierScorecard contacts={contacts} />
      )}

      {creating && canWrite && (
        <DetailDrawer
          open
          onClose={() => setCreating(false)}
          title={t('po.action.new')}
          closeLabel={t('po.action.back')}
          footer={
            <>
              <button type="button" className="btn btn--secondary" onClick={() => setCreating(false)}>
                {t('po.action.discard')}
              </button>
              <button type="button" className="btn btn--primary" onClick={() => void create()}>
                {t('po.action.save')}
              </button>
            </>
          }
        >
          {writeError !== null && <ErrorBanner message={errorMessage(writeError)} />}
          <form
            className="po-form"
            aria-label={t('po.action.new')}
            onSubmit={(e) => {
              e.preventDefault();
              void create();
            }}
          >
            <label className="po-field">
              <span>{t('po.field.supplier')}</span>
              <select value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
                <option value="">{t('po.field.supplierPick')}</option>
                {[...contacts.entries()].map(([id, name]) => (
                  <option key={id} value={id}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            <fieldset className="po-lines">
              <legend>{t('po.field.lines')}</legend>
              {lines.map((line, index) => (
                <div key={index} className="po-line-row">
                  <select
                    aria-label={t('po.field.item')}
                    value={line.itemId}
                    onChange={(e) => {
                      const next = lines.slice();
                      next[index] = { ...next[index], itemId: e.target.value };
                      setLines(next);
                    }}
                  >
                    <option value="">{t('po.field.item')}</option>
                    {items.map((i) => (
                      <option key={i.id} value={i.id}>
                        {i.name}
                      </option>
                    ))}
                  </select>
                  <input
                    type="number"
                    min="1"
                    aria-label={t('po.field.qty')}
                    value={line.qty}
                    onChange={(e) => {
                      const next = lines.slice();
                      next[index] = { ...next[index], qty: e.target.value };
                      setLines(next);
                    }}
                  />
                  <input
                    type="text"
                    inputMode="decimal"
                    aria-label={t('po.field.price')}
                    placeholder="90.00"
                    value={line.price}
                    onChange={(e) => {
                      const next = lines.slice();
                      next[index] = { ...next[index], price: e.target.value };
                      setLines(next);
                    }}
                  />
                  {lines.length > 1 && (
                    <button type="button" className="btn btn--ghost btn--sm" aria-label={t('po.action.removeLine')} onClick={() => setLines(lines.filter((_, i) => i !== index))}>
                      ✕
                    </button>
                  )}
                </div>
              ))}
              <button type="button" className="btn btn--secondary btn--sm" onClick={() => setLines([...lines, { ...EMPTY_LINE }])}>
                {t('po.action.addLine')}
              </button>
            </fieldset>
          </form>
        </DetailDrawer>
      )}

      {openId !== null && detail !== null && detail.po.id === openId && (
        <PoDetailDrawer
          detail={detail}
          t={t}
          canWrite={canWrite}
          itemName={itemName}
          statusTag={statusTag}
          activeLocations={activeLocations}
          receiptLocation={receiptLocation}
          setReceiptLocation={setReceiptLocation}
          receiptQty={receiptQty}
          setReceiptQty={setReceiptQty}
          writeError={writeError}
          errorMessage={errorMessage}
          onClose={() => setOpenId(null)}
          onSend={() => void write('po_send', { poId: detail.po.id, actor: 'Studio', idempotencyKey: newKey() })}
          onCloseShort={() => void write('po_close_short', { poId: detail.po.id, actor: 'Studio', idempotencyKey: newKey() })}
          onCancel={() => void write('po_cancel', { poId: detail.po.id, actor: 'Studio', idempotencyKey: newKey() })}
          onRevise={() => void write('po_revise', { poId: detail.po.id, actor: 'Studio', idempotencyKey: newKey() })}
          onReceipt={() => void recordReceipt(detail)}
        />
      )}
    </section>
  );
}

interface DetailProps {
  detail: PoDetail;
  t: ReturnType<typeof useT>;
  canWrite: boolean;
  itemName: (id: string | null) => string;
  statusTag: (s: string) => ReactNode;
  activeLocations: LocationOpt[];
  receiptLocation: string;
  setReceiptLocation: (v: string) => void;
  receiptQty: Record<string, string>;
  setReceiptQty: (v: Record<string, string>) => void;
  writeError: Err | null;
  errorMessage: (error: Err) => string;
  onClose: () => void;
  onSend: () => void;
  onCloseShort: () => void;
  onCancel: () => void;
  onRevise: () => void;
  onReceipt: () => void;
}

function PoDetailDrawer(props: DetailProps) {
  const { detail, t, canWrite, itemName, statusTag } = props;
  const status = detail.po.status;

  const lineColumns: DataTableColumn<PoLine>[] = [
    { key: 'item', header: t('po.field.item'), render: (l) => l.description ?? itemName(l.itemId) },
    { key: 'ordered', header: t('po.field.ordered'), numeric: true, render: (l) => l.qty },
    { key: 'received', header: t('po.field.received'), numeric: true, render: (l) => l.receivedQty },
    { key: 'billed', header: t('po.field.billed'), numeric: true, render: (l) => l.billedQty },
    { key: 'open', header: t('po.field.open'), numeric: true, render: (l) => l.openQty },
  ];

  const actions: ReactNode[] = [];
  if (canWrite && status === 'draft') {
    actions.push(
      <button key="send" type="button" className="btn btn--primary btn--sm" onClick={props.onSend}>
        {t('po.action.send')}
      </button>,
    );
  }
  if (canWrite && status === 'sent') {
    actions.push(
      <button key="closeShort" type="button" className="btn btn--secondary btn--sm" onClick={props.onCloseShort}>
        {t('po.action.closeShort')}
      </button>,
      <button key="revise" type="button" className="btn btn--secondary btn--sm" onClick={props.onRevise}>
        {t('po.action.revise')}
      </button>,
    );
  }
  if (canWrite && (status === 'draft' || status === 'sent')) {
    actions.push(
      <button key="cancel" type="button" className="btn btn--danger btn--sm" onClick={props.onCancel}>
        {t('po.action.cancel')}
      </button>,
    );
  }

  return (
    <DetailDrawer
      open
      onClose={props.onClose}
      title={detail.po.number}
      closeLabel={t('po.action.back')}
      headerExtra={
        <span className="po-detail-status">
          {statusTag(status)}
          {detail.po.revision > 1 && <span className="po-badge">{t('po.field.revision', { n: detail.po.revision })}</span>}
          {status === 'sent' && detail.po.expectedOn !== null && (
            <span className="po-expected">
              {t('po.field.expectedOn')}: {formatDate(detail.po.expectedOn)}
            </span>
          )}
        </span>
      }
      footer={actions.length > 0 ? <>{actions}</> : undefined}
    >
      {props.writeError !== null && <ErrorBanner message={props.errorMessage(props.writeError)} />}

      <DataTable columns={lineColumns} rows={detail.lines} rowKey={(l) => l.id} caption={t('po.lines.caption')} />

      {status === 'sent' && canWrite && (
        <form
          className="po-receipt"
          aria-label={t('po.action.receipt')}
          onSubmit={(e) => {
            e.preventDefault();
            props.onReceipt();
          }}
        >
          <label className="po-field">
            <span>{t('po.field.location')}</span>
            <select value={props.receiptLocation} onChange={(e) => props.setReceiptLocation(e.target.value)}>
              <option value="">{t('po.field.locationPick')}</option>
              {props.activeLocations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </label>
          {detail.lines
            .filter((l) => l.openQty > 0)
            .map((l) => (
              <label key={l.id} className="po-field">
                <span>
                  {l.description ?? itemName(l.itemId)} ({t('po.field.open')}: {l.openQty})
                </span>
                <input
                  type="number"
                  min="0"
                  max={l.openQty}
                  aria-label={t('po.field.receiveQty')}
                  value={props.receiptQty[l.id] ?? ''}
                  onChange={(e) => props.setReceiptQty({ ...props.receiptQty, [l.id]: e.target.value })}
                />
              </label>
            ))}
          <button type="submit" className="btn btn--primary btn--sm">
            {t('po.action.receipt')}
          </button>
        </form>
      )}

      {detail.receipts.length > 0 && (
        <div className="po-receipts">
          <h3>{t('po.receipts.title')}</h3>
          <ul>
            {detail.receipts.map((r) => (
              <li key={r.id}>{formatDate(r.receivedAt)}</li>
            ))}
          </ul>
        </div>
      )}

      {detail.matches.length > 0 && (
        <div className="po-matches">
          <h3>{t('po.matches.title')}</h3>
          <ul>
            {detail.matches.map((m) => (
              <li key={m.id}>
                <span aria-hidden="true">{m.status === 'variance' ? '⚠' : '✓'}</span> {t(`po.status.${status}`)} {formatMoney(m.priceVarianceRappen, detail.po.currency)}
              </li>
            ))}
          </ul>
        </div>
      )}
    </DetailDrawer>
  );
}

interface PricesProps {
  prices: PriceRow[];
  contacts: Map<string, string>;
  items: ItemOpt[];
  t: ReturnType<typeof useT>;
  canWrite: boolean;
  itemName: (id: string | null) => string;
  write: (action: string, input: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
  loading: boolean;
}

function SupplierPrices(props: PricesProps) {
  const { prices, contacts, items, t, canWrite, itemName, write, loading } = props;
  const [supplierId, setSupplierId] = useState('');
  const [itemId, setItemId] = useState('');
  const [price, setPrice] = useState('');
  const [validFrom, setValidFrom] = useState('');
  const [leadTime, setLeadTime] = useState('');

  const add = async () => {
    if (supplierId === '' || itemId === '' || price === '' || validFrom === '') return;
    const priceRappen = Math.round(Number.parseFloat(price) * 100);
    const leadTimeDays = leadTime === '' ? undefined : Number.parseInt(leadTime, 10);
    const done = await write('supplier_price_upsert', {
      supplierContactId: supplierId,
      itemId,
      priceRappen,
      currency: 'CHF',
      validFrom,
      ...(leadTimeDays !== undefined && Number.isInteger(leadTimeDays) ? { leadTimeDays } : {}),
      idempotencyKey: newKey(),
    });
    if (done !== null) {
      setPrice('');
      setValidFrom('');
      setLeadTime('');
    }
  };

  const columns: DataTableColumn<PriceRow>[] = [
    { key: 'supplier', header: t('po.field.supplier'), render: (p) => contacts.get(p.supplierContactId) ?? p.supplierContactId },
    { key: 'item', header: t('po.field.item'), render: (p) => itemName(p.itemId) },
    { key: 'price', header: t('po.field.price'), numeric: true, render: (p) => formatMoney(p.priceRappen, p.currency) },
    { key: 'validFrom', header: t('po.field.validFrom'), render: (p) => formatDate(p.validFrom) },
    { key: 'leadTime', header: t('po.field.leadTime'), numeric: true, render: (p) => p.leadTimeDays ?? '' },
  ];

  return (
    <>
      {canWrite && (
        <form
          className="po-editor"
          aria-label={t('po.action.addPrice')}
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <select aria-label={t('po.field.supplier')} value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
            <option value="">{t('po.field.supplierPick')}</option>
            {[...contacts.entries()].map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
          <select aria-label={t('po.field.item')} value={itemId} onChange={(e) => setItemId(e.target.value)}>
            <option value="">{t('po.field.item')}</option>
            {items.map((i) => (
              <option key={i.id} value={i.id}>
                {i.name}
              </option>
            ))}
          </select>
          <input type="text" inputMode="decimal" aria-label={t('po.field.price')} placeholder="90.00" value={price} onChange={(e) => setPrice(e.target.value)} />
          <input type="date" aria-label={t('po.field.validFrom')} value={validFrom} onChange={(e) => setValidFrom(e.target.value)} />
          <input type="number" min="0" aria-label={t('po.field.leadTime')} value={leadTime} onChange={(e) => setLeadTime(e.target.value)} />
          <button type="submit" className="btn btn--primary btn--sm">
            {t('po.action.addPrice')}
          </button>
        </form>
      )}
      <DataTable columns={columns} rows={prices} rowKey={(p) => p.id} caption={t('po.prices.caption')} loading={loading} emptyState={<EmptyState title={t('po.emptyPrices')} />} />
    </>
  );
}

export default Purchasing;
