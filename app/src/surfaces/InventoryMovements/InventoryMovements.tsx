/**
 * J02, Inventory -> Movements (`/inventory-movements`): the surface over the append-only movement
 * ledger. Pick a stockable item on the left; the right pane shows its on-hand (a pure SUM, never a
 * stored figure), the negative-stock policy toggle, and the chronological movement history with a
 * server-computed running balance, type badge, signed quantity, unit-cost snapshot, location,
 * lot/serial and actor. Two drawers write through the one ledger path: Record a movement, and Transfer
 * between locations. No local quantity mutation: after a write the history and balance are re-read.
 *
 * Type badge is glyph + label, never colour alone (WCAG 2.2 AA); no new colour token (design-canon).
 *
 * THE PERMISSION GATE HERE IS A CONVENIENCE (the standing Studio rule): capabilities fail open and the
 * engine is the real gate. Write controls disable behind `manage_master_data`; a click that slips
 * through still surfaces the engine's own `permission_denied`.
 *
 * ## BUILT ON THE SHARED UI PRIMITIVES (D118 B2, 2026-08-24)
 *
 * The page header and the two write actions (Record, Transfer) are the shared `SurfaceHeader`, so the
 * primary action sits top-right where the eye expects and the title stops being copy-pasted across the
 * loading/empty branches. The movement history is the shared `DataTable` (frame overflow, sticky
 * header, density and the five states in one place): the quantity, running balance and unit-cost
 * columns are numeric `.t-num` cells, the signed quantity keeps its neutral/dim sign class. Both
 * overlays (Record, Transfer) are the shared `DetailDrawer`, which adds the focus trap, Escape and
 * scrim the bespoke `.im-drawer` panel lacked; the drawer forms adopt the shared `.field` control
 * class, so the one global density toggle reaches them. The per-surface CSS that duplicated the list
 * table, the button set, the drawer chrome and the field inputs is gone; what remains is genuinely
 * this surface's: the master-detail split, the item picker, the on-hand header, the policy toggle and
 * the glyph+label type badge.
 *
 * No `Provenance` (C3): there is no per-movement detail view, and the actor already rides a table
 * column. No `ConsequenceLine` (C4): `inventory_move` / `inventory_transfer` carry no engine
 * consequence sentence, and the Studio never invents one (design law).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';

import { useClient } from '../../lib/client-context';
import { isErr, type Err } from '../../lib/client';
import { CAP, useCapabilities } from '../../lib/capabilities';
import { useWorkspaceId } from '../../app/workspace';
import { formatMoney, useT } from '../../i18n';
import { EmptyState, ErrorBanner, NoWorkspaceState, PermissionDenied, Skeleton } from '../../components/states';
import { DataTable, type DataTableColumn } from '../../components/DataTable';
import { SurfaceHeader } from '../../components/SurfaceHeader';
import { DetailDrawer } from '../../components/DetailDrawer';
import { SurfaceHelp } from '../../components/SurfaceHelp';
import './InventoryMovements.css';

// The friendly single-leg movement types the Record drawer offers. `transfer_in` / `transfer_out` are
// only produced by the Transfer drawer, so they are not selectable here.
const RECORD_TYPES = ['receipt', 'issue', 'opening', 'adjustment', 'return', 'scrap'] as const;
type RecordType = (typeof RECORD_TYPES)[number];
// The full §H-ENUM, for rendering a badge on any row (including transfer legs and legacy rows).
const ALL_TYPES = ['opening', 'receipt', 'issue', 'transfer_out', 'transfer_in', 'adjustment', 'return', 'scrap'] as const;
const POSITIVE: ReadonlySet<string> = new Set(['receipt', 'opening']);
const NEGATIVE: ReadonlySet<string> = new Set(['issue', 'scrap']);

/** The J02 rejection codes with a surface-scoped message. Others fall through to the global mapping. */
const J02_ERROR_CODES = new Set([
  'insufficient_stock',
  'invalid_qty',
  'invalid_movement_type',
  'lot_required',
  'serial_required',
  'item_not_stockable',
  'lot_item_mismatch',
  'serial_item_mismatch',
  // A serial is a unit of one: the engine refuses an inbound for a serial it already holds, and the
  // operator needs to read WHY rather than the generic fallback.
  'serial_already_in_stock',
]);

const newKey = (): string => crypto.randomUUID();

interface Item {
  id: string;
  name: string;
}
interface Loc {
  id: string;
  name: string;
}
interface Movement {
  id: string;
  movementType: string;
  qty: number;
  unitCostMinor: number | null;
  effectiveDate: string;
  locationId: string;
  lotId: string | null;
  serialId: string | null;
  description: string | null;
  createdBy: string | null;
  runningBalance?: number;
}

function parseItems(body: unknown): Item[] {
  const rows = (body as { items?: unknown })?.items;
  if (!Array.isArray(rows)) return [];
  const out: Item[] = [];
  for (const raw of rows) {
    if (raw === null || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    if (typeof r.id !== 'string' || typeof r.name !== 'string') continue;
    if (r.trackStock !== true) continue;
    out.push({ id: r.id, name: r.name });
  }
  return out;
}

function parseLocations(body: unknown): Loc[] {
  const rows = (body as { locations?: unknown })?.locations;
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((r): r is Record<string, unknown> => r !== null && typeof r === 'object')
    .map((r) => ({ id: String(r.id ?? ''), name: String(r.name ?? '') }))
    .filter((l) => l.id !== '');
}

function parseMovements(body: unknown): Movement[] {
  const rows = (body as { items?: unknown })?.items;
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((r): r is Record<string, unknown> => r !== null && typeof r === 'object')
    .map((r) => ({
      id: String(r.id ?? ''),
      movementType: String(r.movementType ?? 'adjustment'),
      qty: typeof r.qty === 'number' ? r.qty : 0,
      unitCostMinor: typeof r.unitCostMinor === 'number' ? r.unitCostMinor : null,
      effectiveDate: String(r.effectiveDate ?? ''),
      locationId: String(r.locationId ?? ''),
      lotId: typeof r.lotId === 'string' ? r.lotId : null,
      serialId: typeof r.serialId === 'string' ? r.serialId : null,
      description: typeof r.description === 'string' ? r.description : null,
      createdBy: typeof r.createdBy === 'string' ? r.createdBy : null,
      runningBalance: typeof r.runningBalance === 'number' ? r.runningBalance : undefined,
    }));
}

interface MoveDraft {
  locationId: string;
  movementType: RecordType;
  qty: string;
  unitCostMinor: string;
  effectiveDate: string;
  lotId: string;
  serialId: string;
  description: string;
}
const emptyMove = (): MoveDraft => ({
  locationId: '',
  movementType: 'receipt',
  qty: '',
  unitCostMinor: '',
  effectiveDate: new Date().toISOString().slice(0, 10),
  lotId: '',
  serialId: '',
  description: '',
});

interface TransferDraft {
  fromLocationId: string;
  toLocationId: string;
  qty: string;
  effectiveDate: string;
  description: string;
}
const emptyTransfer = (): TransferDraft => ({
  fromLocationId: '',
  toLocationId: '',
  qty: '',
  effectiveDate: new Date().toISOString().slice(0, 10),
  description: '',
});

/** Apply the sign the movement type implies (adjustment/return keep the caller's typed sign). */
function signedQty(type: RecordType, n: number): number {
  if (POSITIVE.has(type)) return Math.abs(n);
  if (NEGATIVE.has(type)) return -Math.abs(n);
  return n;
}

export function InventoryMovements() {
  const t = useT();
  const client = useClient();
  const workspaceId = useWorkspaceId();
  const { can } = useCapabilities();
  const canWrite = can(CAP.manageMasterData);

  const [items, setItems] = useState<Item[]>([]);
  const [locations, setLocations] = useState<Loc[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [movements, setMovements] = useState<Movement[]>([]);
  const [onHand, setOnHand] = useState<number>(0);
  const [allowNegative, setAllowNegative] = useState<boolean>(false);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [denied, setDenied] = useState(false);
  const [writeError, setWriteError] = useState<Err | null>(null);

  const [moveDrawer, setMoveDrawer] = useState(false);
  const [moveDraft, setMoveDraft] = useState<MoveDraft>(emptyMove);
  const [transferDrawer, setTransferDrawer] = useState(false);
  const [transferDraft, setTransferDraft] = useState<TransferDraft>(emptyTransfer);

  const selected = useMemo(() => items.find((i) => i.id === selectedId) ?? null, [items, selectedId]);
  const locName = useCallback((id: string) => locations.find((l) => l.id === id)?.name ?? id, [locations]);

  const localError = useCallback(
    (e: Err | null): string | undefined =>
      e !== null && J02_ERROR_CODES.has(e.error) ? t(`invMovements.errors.${e.error}`) : undefined,
    [t],
  );

  const loadBase = useCallback(async () => {
    if (workspaceId === null) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setFailed(false);
    setDenied(false);
    const [itemsRes, stockRes, cfgRes] = await Promise.all([
      client.call('list_items', { workspaceId }),
      client.call('stock_on_hand', { workspaceId }),
      client.call('inventory_get_config', { workspaceId }),
    ]);
    if (isErr(itemsRes.body)) {
      if (itemsRes.body.error === 'permission_denied' || itemsRes.status === 403) setDenied(true);
      else setFailed(true);
      setLoading(false);
      return;
    }
    const parsed = parseItems(itemsRes.body);
    setItems(parsed);
    setLocations(isErr(stockRes.body) ? [] : parseLocations(stockRes.body));
    setAllowNegative(!isErr(cfgRes.body) && (cfgRes.body as { allowNegativeStock?: boolean }).allowNegativeStock === true);
    setSelectedId((prev) => (prev !== null && parsed.some((i) => i.id === prev) ? prev : (parsed[0]?.id ?? null)));
    setLoading(false);
  }, [client, workspaceId]);

  const loadDetail = useCallback(
    async (item: Item) => {
      if (workspaceId === null) return;
      setDetailLoading(true);
      const [listRes, balRes] = await Promise.all([
        client.call('inventory_movement_list', { workspaceId, itemId: item.id, limit: 200 }),
        client.call('inventory_balance', { workspaceId, itemId: item.id }),
      ]);
      setMovements(isErr(listRes.body) ? [] : parseMovements(listRes.body));
      setOnHand(isErr(balRes.body) ? 0 : ((balRes.body as { qtyOnHand?: number }).qtyOnHand ?? 0));
      setDetailLoading(false);
    },
    [client, workspaceId],
  );

  useEffect(() => {
    void loadBase();
  }, [loadBase]);

  useEffect(() => {
    if (selected !== null) void loadDetail(selected);
    else {
      setMovements([]);
      setOnHand(0);
    }
  }, [selected, loadDetail]);

  const refresh = useCallback(async () => {
    await loadBase();
    if (selected !== null) await loadDetail(selected);
  }, [loadBase, loadDetail, selected]);

  const submitMove = useCallback(async () => {
    if (selected === null || workspaceId === null) return;
    setWriteError(null);
    const n = Number.parseInt(moveDraft.qty, 10);
    if (!Number.isInteger(n) || n === 0) {
      setWriteError({ error: 'invalid_qty' } as Err);
      return;
    }
    const cost = moveDraft.unitCostMinor.trim();
    const response = await client.call('inventory_move', {
      workspaceId,
      itemId: selected.id,
      locationId: moveDraft.locationId,
      qty: signedQty(moveDraft.movementType, n),
      movementType: moveDraft.movementType,
      unitCostMinor: cost === '' ? undefined : Number.parseInt(cost, 10),
      effectiveDate: moveDraft.effectiveDate,
      lotId: moveDraft.lotId.trim() === '' ? undefined : moveDraft.lotId.trim(),
      serialId: moveDraft.serialId.trim() === '' ? undefined : moveDraft.serialId.trim(),
      description: moveDraft.description.trim() === '' ? undefined : moveDraft.description.trim(),
      idempotencyKey: newKey(),
    });
    if (isErr(response.body)) {
      setWriteError(response.body);
      return;
    }
    setMoveDrawer(false);
    setMoveDraft(emptyMove());
    await refresh();
  }, [client, workspaceId, selected, moveDraft, refresh]);

  const submitTransfer = useCallback(async () => {
    if (selected === null || workspaceId === null) return;
    setWriteError(null);
    const n = Number.parseInt(transferDraft.qty, 10);
    if (!Number.isInteger(n) || n <= 0) {
      setWriteError({ error: 'invalid_qty' } as Err);
      return;
    }
    const response = await client.call('inventory_transfer', {
      workspaceId,
      itemId: selected.id,
      fromLocationId: transferDraft.fromLocationId,
      toLocationId: transferDraft.toLocationId,
      qty: n,
      effectiveDate: transferDraft.effectiveDate,
      description: transferDraft.description.trim() === '' ? undefined : transferDraft.description.trim(),
      idempotencyKey: newKey(),
    });
    if (isErr(response.body)) {
      setWriteError(response.body);
      return;
    }
    setTransferDrawer(false);
    setTransferDraft(emptyTransfer());
    await refresh();
  }, [client, workspaceId, selected, transferDraft, refresh]);

  const toggleNegative = useCallback(async () => {
    if (workspaceId === null) return;
    setWriteError(null);
    const next = !allowNegative;
    const response = await client.call('inventory_set_config', { workspaceId, allowNegativeStock: next, idempotencyKey: newKey() });
    if (isErr(response.body)) {
      setWriteError(response.body);
      return;
    }
    setAllowNegative(next);
  }, [client, workspaceId, allowNegative]);

  if (workspaceId === null) return <NoWorkspaceState body={t('invMovements.noWorkspace')} />;
  if (denied) return <PermissionDenied title={t('invMovements.title')} />;

  // The history columns: text left, the quantity/balance/cost numeric and right-aligned via `.t-num`.
  // The signed quantity keeps its neutral/dim sign class (a quantity ledger, not a money page: the
  // sign carries the meaning, so the minus stays a fact rather than a red alarm).
  const columns: DataTableColumn<Movement>[] = [
    { key: 'date', header: t('invMovements.col.date'), render: (m) => m.effectiveDate },
    {
      key: 'type',
      header: t('invMovements.col.type'),
      render: (m) => <span className="im-badge">{t(`invMovements.type.${m.movementType}`)}</span>,
    },
    {
      key: 'qty',
      header: t('invMovements.col.qty'),
      numeric: true,
      render: (m) => <span className={m.qty < 0 ? 'im-neg' : 'im-pos'}>{m.qty > 0 ? `+${m.qty}` : m.qty}</span>,
    },
    { key: 'running', header: t('invMovements.col.running'), numeric: true, render: (m) => m.runningBalance ?? '-' },
    // The unit-cost snapshot is minor units (Rappen) in the workspace base currency; the movement row
    // carries no currency of its own, so it formats as CHF through the shared formatter (K-71). Before
    // this it rendered the raw integer (3600 for CHF 36.00, a 100x misread) under a plain "Stückkosten".
    { key: 'unitCost', header: t('invMovements.col.unitCost'), numeric: true, render: (m) => (m.unitCostMinor === null ? '-' : formatMoney(m.unitCostMinor, 'CHF')) },
    { key: 'location', header: t('invMovements.col.location'), render: (m) => locName(m.locationId) },
    { key: 'actor', header: t('invMovements.col.actor'), render: (m) => m.createdBy ?? '-' },
  ];

  // The two write actions ride the SurfaceHeader actions slot (primary top-right). Both act on the
  // selected item, so they disable until an item and the locations they need are present, and behind
  // the A24 capability padlock. The engine is still the real gate.
  const headerActions = (
    <>
      <button
        type="button"
        className="btn btn--ghost"
        disabled={!canWrite || selected === null || locations.length < 2}
        onClick={() => {
          setWriteError(null);
          setTransferDraft({ ...emptyTransfer(), fromLocationId: locations[0]?.id ?? '', toLocationId: locations[1]?.id ?? '' });
          setTransferDrawer(true);
        }}
      >
        {t('invMovements.transfer')}
      </button>
      <button
        type="button"
        className="btn btn--primary"
        disabled={!canWrite || selected === null || locations.length === 0}
        onClick={() => {
          setWriteError(null);
          setMoveDraft({ ...emptyMove(), locationId: locations[0]?.id ?? '' });
          setMoveDrawer(true);
        }}
      >
        {t('invMovements.record')}
      </button>
    </>
  );

  return (
    <div className="im">
      <SurfaceHeader title={t('invMovements.title')} help={<SurfaceHelp surface="InventoryMovements" />} actions={headerActions} />

      {failed && <ErrorBanner message={t('invMovements.error.transport')} onRetry={() => void loadBase()} />}

      {loading ? (
        <Skeleton rows={4} />
      ) : items.length === 0 ? (
        <EmptyState title={t('invMovements.empty.title')} hint={t('invMovements.empty.hint')} />
      ) : (
        <div className="im-split">
          <section className="im-pane" aria-label={t('invMovements.listLabel')}>
            <ul className="im-list">
              {items.map((i) => (
                <li key={i.id}>
                  <button
                    type="button"
                    className={`im-list-item ${i.id === selectedId ? 'im-list-item-selected' : ''}`}
                    onClick={() => setSelectedId(i.id)}
                    aria-pressed={i.id === selectedId}
                  >
                    {i.name}
                  </button>
                </li>
              ))}
            </ul>
          </section>

          <section className="im-pane im-detail" aria-label={t('invMovements.detailLabel')}>
            {selected === null ? (
              <p className="im-muted">{t('invMovements.selectHint')}</p>
            ) : (
              <>
                <div className="im-detail-head">
                  <h2 className="im-detail-title">{selected.name}</h2>
                  <p className="im-onhand">
                    {t('invMovements.onHand')}: <strong>{onHand}</strong>
                  </p>
                </div>

                <label className="im-policy">
                  <input type="checkbox" checked={allowNegative} disabled={!canWrite} onChange={() => void toggleNegative()} />
                  <span>{t('invMovements.allowNegative')}</span>
                </label>

                {writeError && !moveDrawer && !transferDrawer && <ErrorBanner error={writeError} message={localError(writeError)} />}

                <DataTable
                  columns={columns}
                  rows={movements}
                  rowKey={(m) => m.id}
                  caption={t('invMovements.detailLabel')}
                  loading={detailLoading}
                  skeletonRows={3}
                  emptyState={<EmptyState title={t('invMovements.noMovements')} />}
                />
              </>
            )}
          </section>
        </div>
      )}

      {moveDrawer && selected !== null && (
        <DetailDrawer
          open
          onClose={() => setMoveDrawer(false)}
          title={t('invMovements.form.recordTitle')}
          closeLabel={t('invMovements.cancel')}
          footer={
            <>
              <button type="button" className="btn btn--secondary" onClick={() => setMoveDrawer(false)}>
                {t('invMovements.cancel')}
              </button>
              <button type="button" className="btn btn--primary" onClick={() => void submitMove()} disabled={!canWrite}>
                {t('invMovements.save')}
              </button>
            </>
          }
        >
          {writeError && <ErrorBanner error={writeError} message={localError(writeError)} />}
          <div className="im-field">
            <label htmlFor="im-type">{t('invMovements.form.type')}</label>
            <select id="im-type" className="field" value={moveDraft.movementType} onChange={(e) => setMoveDraft({ ...moveDraft, movementType: e.target.value as RecordType })}>
              {RECORD_TYPES.map((ty) => (
                <option key={ty} value={ty}>
                  {t(`invMovements.type.${ty}`)}
                </option>
              ))}
            </select>
          </div>
          <div className="im-field">
            <label htmlFor="im-loc">{t('invMovements.form.location')}</label>
            <select id="im-loc" className="field" value={moveDraft.locationId} onChange={(e) => setMoveDraft({ ...moveDraft, locationId: e.target.value })}>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </div>
          <div className="im-field">
            <label htmlFor="im-qty">{t('invMovements.form.qty')}</label>
            <input id="im-qty" className="field" type="number" value={moveDraft.qty} onChange={(e) => setMoveDraft({ ...moveDraft, qty: e.target.value })} />
            <p className="im-hint">{t('invMovements.form.qtyHint')}</p>
          </div>
          <div className="im-field">
            <label htmlFor="im-cost">{t('invMovements.form.unitCost')}</label>
            <input id="im-cost" className="field" type="number" min="0" value={moveDraft.unitCostMinor} onChange={(e) => setMoveDraft({ ...moveDraft, unitCostMinor: e.target.value })} />
          </div>
          <div className="im-field">
            <label htmlFor="im-date">{t('invMovements.form.date')}</label>
            <input id="im-date" className="field" type="date" value={moveDraft.effectiveDate} onChange={(e) => setMoveDraft({ ...moveDraft, effectiveDate: e.target.value })} />
          </div>
          <div className="im-field">
            <label htmlFor="im-lot">{t('invMovements.form.lot')}</label>
            <input id="im-lot" className="field" value={moveDraft.lotId} onChange={(e) => setMoveDraft({ ...moveDraft, lotId: e.target.value })} placeholder={t('invMovements.form.optional')} />
          </div>
          <div className="im-field">
            <label htmlFor="im-serial">{t('invMovements.form.serial')}</label>
            <input id="im-serial" className="field" value={moveDraft.serialId} onChange={(e) => setMoveDraft({ ...moveDraft, serialId: e.target.value })} placeholder={t('invMovements.form.optional')} />
          </div>
          <div className="im-field">
            <label htmlFor="im-desc">{t('invMovements.form.description')}</label>
            <input id="im-desc" className="field" value={moveDraft.description} onChange={(e) => setMoveDraft({ ...moveDraft, description: e.target.value })} />
          </div>
        </DetailDrawer>
      )}

      {transferDrawer && selected !== null && (
        <DetailDrawer
          open
          onClose={() => setTransferDrawer(false)}
          title={t('invMovements.form.transferTitle')}
          closeLabel={t('invMovements.cancel')}
          footer={
            <>
              <button type="button" className="btn btn--secondary" onClick={() => setTransferDrawer(false)}>
                {t('invMovements.cancel')}
              </button>
              <button type="button" className="btn btn--primary" onClick={() => void submitTransfer()} disabled={!canWrite}>
                {t('invMovements.save')}
              </button>
            </>
          }
        >
          {writeError && <ErrorBanner error={writeError} message={localError(writeError)} />}
          <div className="im-field">
            <label htmlFor="im-from">{t('invMovements.form.from')}</label>
            <select id="im-from" className="field" value={transferDraft.fromLocationId} onChange={(e) => setTransferDraft({ ...transferDraft, fromLocationId: e.target.value })}>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </div>
          <div className="im-field">
            <label htmlFor="im-to">{t('invMovements.form.to')}</label>
            <select id="im-to" className="field" value={transferDraft.toLocationId} onChange={(e) => setTransferDraft({ ...transferDraft, toLocationId: e.target.value })}>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </div>
          <div className="im-field">
            <label htmlFor="im-tqty">{t('invMovements.form.qty')}</label>
            <input id="im-tqty" className="field" type="number" min="1" value={transferDraft.qty} onChange={(e) => setTransferDraft({ ...transferDraft, qty: e.target.value })} />
          </div>
          <div className="im-field">
            <label htmlFor="im-tdate">{t('invMovements.form.date')}</label>
            <input id="im-tdate" className="field" type="date" value={transferDraft.effectiveDate} onChange={(e) => setTransferDraft({ ...transferDraft, effectiveDate: e.target.value })} />
          </div>
          <div className="im-field">
            <label htmlFor="im-tdesc">{t('invMovements.form.description')}</label>
            <input id="im-tdesc" className="field" value={transferDraft.description} onChange={(e) => setTransferDraft({ ...transferDraft, description: e.target.value })} />
          </div>
        </DetailDrawer>
      )}
    </div>
  );
}

export { ALL_TYPES };
