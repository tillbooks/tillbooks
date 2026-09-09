/**
 * J01, Inventory -> Lot & Serial Tracking (`/lot-serial-tracking`): the surface where a workspace sets
 * an item's tracking mode and then manages that item's lots (batches) and serials (units).
 *
 * Item-centric master-detail: pick a stockable item on the left; the right pane shows its tracking
 * mode (with a control to change it, disabled while on-hand is non-zero, the engine is the real gate)
 * and, depending on the mode, its Lots and/or Serials tables with a create drawer and status actions.
 * Status is glyph + label, never colour alone (WCAG 2.2 AA). No new colour token (design-canon).
 *
 * THE PERMISSION GATE HERE IS A CONVENIENCE (the standing Studio rule): `whoami`/capabilities fail
 * open and the engine is the real gate. Write controls disable behind `manage_master_data`; a click
 * that slips through still surfaces the engine's own `permission_denied`.
 *
 * ## BUILT ON THE SHARED UI PRIMITIVES (D118 B2, 2026-08-24)
 *
 * The page header is the shared `SurfaceHeader`. The Lots and Serials detail tables are the shared
 * `DataTable` (frame overflow, sticky header, density and the empty state in one place); the on-hand
 * column is a numeric, right-aligned `.t-num` cell and an archived row dims through the `rowClassName`
 * hook. Both create overlays are the shared `DetailDrawer`, which adds the focus trap, Escape and
 * scrim the bespoke dialog-role panel lacked. The buttons are the shared `.btn` set. The
 * per-surface CSS that duplicated the tables, the drawer chrome, the button set and the page head is
 * gone; what remains is genuinely LotSerial-specific: the master-detail split, the item navigation
 * list, the mode selector, the status badges and the drawer form fields.
 *
 * The left item list stays a bespoke navigation list, not a `DataTable`: it is a single-column
 * pick-one master, not a tabular grid, and `DataTable`'s row-click opens a drawer rather than driving
 * a persistent detail pane. No `FilterBar`: the surface carries no search today and inventing one is
 * out of scope. No `Provenance` (C3): the lot/serial read model carries no actor/timestamp to show.
 * No `ConsequenceLine` (C4): no J01 verb carries a dial-capability consequence sentence.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';

import { useClient } from '../../lib/client-context';
import { isErr, type Err } from '../../lib/client';
import { CAP, useCapabilities } from '../../lib/capabilities';
import { useWorkspaceId } from '../../app/workspace';
import { useT } from '../../i18n';
import { EmptyState, ErrorBanner, NoWorkspaceState, PermissionDenied, Skeleton } from '../../components/states';
import { DataTable, type DataTableColumn } from '../../components/DataTable';
import { SurfaceHeader } from '../../components/SurfaceHeader';
import { DetailDrawer } from '../../components/DetailDrawer';
import { SurfaceHelp } from '../../components/SurfaceHelp';
import './LotSerial.css';

const TRACKING_MODES = ['none', 'lot', 'serial', 'lot_and_serial'] as const;
type TrackingMode = (typeof TRACKING_MODES)[number];
const LOT_STATUSES = ['open', 'held', 'expired', 'closed', 'archived'] as const;
const SERIAL_STATUSES = ['available', 'reserved', 'issued', 'returned', 'scrapped', 'archived'] as const;

/**
 * The J01 rejection codes with a surface-scoped message (`lotSerial.errors.<code>`). Kept out of the
 * shared global `errors.*` namespace so a code does not collide with another surface's wording (the
 * J00 lesson). Any code NOT here falls through to ErrorBanner's own global mapping.
 */
const J01_ERROR_CODES = new Set([
  'tracking_not_applicable',
  'tracking_mode_requires_zero_stock',
  'invalid_tracking_mode',
  'lot_number_taken',
  'serial_number_taken',
  'lot_has_balance',
  'serial_has_balance',
  'lot_reference_required',
  'lot_item_mismatch',
  'invalid_lot_status',
  'invalid_serial_status',
]);

const newKey = () => crypto.randomUUID();

interface Item {
  id: string;
  name: string;
  trackStock: boolean;
  trackingMode: TrackingMode;
}

interface Lot {
  id: string;
  number: string;
  status: string;
  expiryDate: string | null;
  supplierReference: string | null;
  onHand: number;
}

interface Serial {
  id: string;
  number: string;
  status: string;
  lotId: string | null;
}

function modeHasLot(mode: string): boolean {
  return mode === 'lot' || mode === 'lot_and_serial';
}
function modeHasSerial(mode: string): boolean {
  return mode === 'serial' || mode === 'lot_and_serial';
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
    const mode = typeof r.trackingMode === 'string' ? r.trackingMode : 'none';
    out.push({
      id: r.id,
      name: r.name,
      trackStock: true,
      trackingMode: (TRACKING_MODES.includes(mode as TrackingMode) ? mode : 'none') as TrackingMode,
    });
  }
  return out;
}

function parseLots(body: unknown): Lot[] {
  const rows = (body as { lots?: unknown })?.lots;
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((r): r is Record<string, unknown> => r !== null && typeof r === 'object')
    .map((r) => ({
      id: String(r.id ?? ''),
      number: String(r.number ?? ''),
      status: String(r.status ?? 'open'),
      expiryDate: typeof r.expiryDate === 'string' ? r.expiryDate : null,
      supplierReference: typeof r.supplierReference === 'string' ? r.supplierReference : null,
      onHand: typeof r.onHand === 'number' ? r.onHand : 0,
    }));
}

function parseSerials(body: unknown): Serial[] {
  const rows = (body as { serials?: unknown })?.serials;
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((r): r is Record<string, unknown> => r !== null && typeof r === 'object')
    .map((r) => ({
      id: String(r.id ?? ''),
      number: String(r.number ?? ''),
      status: String(r.status ?? 'available'),
      lotId: typeof r.lotId === 'string' ? r.lotId : null,
    }));
}

interface LotDraft {
  number: string;
  expiryDate: string;
  supplierReference: string;
}
const EMPTY_LOT: LotDraft = { number: '', expiryDate: '', supplierReference: '' };

interface SerialDraft {
  numbers: string;
  lotId: string;
}
const EMPTY_SERIAL: SerialDraft = { numbers: '', lotId: '' };

export function LotSerial() {
  const t = useT();
  const client = useClient();
  const workspaceId = useWorkspaceId();
  const { can } = useCapabilities();
  const canWrite = can(CAP.manageMasterData);

  const [items, setItems] = useState<Item[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [lots, setLots] = useState<Lot[]>([]);
  const [serials, setSerials] = useState<Serial[]>([]);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [denied, setDenied] = useState(false);
  const [writeError, setWriteError] = useState<Err | null>(null);

  const [lotDrawer, setLotDrawer] = useState(false);
  const [lotDraft, setLotDraft] = useState<LotDraft>(EMPTY_LOT);
  const [serialDrawer, setSerialDrawer] = useState(false);
  const [serialDraft, setSerialDraft] = useState<SerialDraft>(EMPTY_SERIAL);

  const selected = useMemo(() => items.find((i) => i.id === selectedId) ?? null, [items, selectedId]);

  const localError = useCallback(
    (e: Err | null): string | undefined =>
      e !== null && J01_ERROR_CODES.has(e.error) ? t(`lotSerial.errors.${e.error}`) : undefined,
    [t],
  );

  const loadItems = useCallback(async () => {
    if (workspaceId === null) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setFailed(false);
    setDenied(false);
    const listed = await client.call('list_items', { workspaceId });
    if (isErr(listed.body)) {
      if (listed.body.error === 'permission_denied' || listed.status === 403) setDenied(true);
      else setFailed(true);
      setLoading(false);
      return;
    }
    const parsed = parseItems(listed.body);
    setItems(parsed);
    setSelectedId((prev) => (prev !== null && parsed.some((i) => i.id === prev) ? prev : (parsed[0]?.id ?? null)));
    setLoading(false);
  }, [client, workspaceId]);

  const loadDetail = useCallback(
    async (item: Item) => {
      if (workspaceId === null) return;
      setDetailLoading(true);
      const calls: Promise<unknown>[] = [];
      if (modeHasLot(item.trackingMode)) {
        calls.push(
          client.call('lot_list', { workspaceId, itemId: item.id, includeArchived: true }).then((r) => {
            setLots(isErr(r.body) ? [] : parseLots(r.body));
          }),
        );
      } else {
        setLots([]);
      }
      if (modeHasSerial(item.trackingMode)) {
        calls.push(
          client.call('serial_list', { workspaceId, itemId: item.id, includeArchived: true }).then((r) => {
            setSerials(isErr(r.body) ? [] : parseSerials(r.body));
          }),
        );
      } else {
        setSerials([]);
      }
      await Promise.all(calls);
      setDetailLoading(false);
    },
    [client, workspaceId],
  );

  useEffect(() => {
    void loadItems();
  }, [loadItems]);

  useEffect(() => {
    if (selected !== null) void loadDetail(selected);
    else {
      setLots([]);
      setSerials([]);
    }
  }, [selected, loadDetail]);

  const write = useCallback(
    async (action: string, input: Record<string, unknown>): Promise<boolean> => {
      if (workspaceId === null) return false;
      setWriteError(null);
      const response = await client.call(action, { workspaceId, ...input });
      if (isErr(response.body)) {
        setWriteError(response.body);
        return false;
      }
      await loadItems();
      if (selected !== null) await loadDetail(selected);
      return true;
    },
    [client, workspaceId, loadItems, loadDetail, selected],
  );

  const setMode = useCallback(
    async (mode: TrackingMode) => {
      if (selected === null) return;
      await write('item_set_tracking_mode', { itemId: selected.id, mode, idempotencyKey: newKey() });
    },
    [write, selected],
  );

  const submitLot = useCallback(async () => {
    if (selected === null) return;
    const ok = await write('lot_create', {
      itemId: selected.id,
      number: lotDraft.number.trim(),
      expiryDate: lotDraft.expiryDate.trim() === '' ? undefined : lotDraft.expiryDate.trim(),
      supplierReference: lotDraft.supplierReference.trim() === '' ? undefined : lotDraft.supplierReference.trim(),
      idempotencyKey: newKey(),
    });
    if (ok) {
      setLotDrawer(false);
      setLotDraft(EMPTY_LOT);
    }
  }, [write, selected, lotDraft]);

  const submitSerial = useCallback(async () => {
    if (selected === null) return;
    const numbers = serialDraft.numbers
      .split(/[\n,]/)
      .map((n) => n.trim())
      .filter((n) => n.length > 0);
    if (numbers.length === 0) return;
    const lotId = serialDraft.lotId === '' ? undefined : serialDraft.lotId;
    const ok =
      numbers.length === 1
        ? await write('serial_create', { itemId: selected.id, number: numbers[0], lotId, idempotencyKey: newKey() })
        : await write('serial_create_bulk', { itemId: selected.id, numbers, lotId, idempotencyKey: newKey() });
    if (ok) {
      setSerialDrawer(false);
      setSerialDraft(EMPTY_SERIAL);
    }
  }, [write, selected, serialDraft]);

  if (workspaceId === null) return <NoWorkspaceState body={t('lotSerial.noWorkspace')} />;
  if (denied) return <PermissionDenied title={t('lotSerial.title')} />;

  const activeLots = lots.filter((l) => l.status !== 'archived');

  // The Lots detail table: text left, on-hand a numeric right-aligned `.t-num` cell, an actions column
  // whose header is read-only to assistive tech. An archived lot dims down the whole row via the shared
  // DataTable rowClassName hook. The status badge is glyph + label, never colour alone.
  const lotColumns: DataTableColumn<Lot>[] = [
    { key: 'number', header: t('lotSerial.lots.col.number'), render: (l) => <span className="ls-code">{l.number}</span> },
    {
      key: 'status',
      header: t('lotSerial.lots.col.status'),
      render: (l) => <span className="ls-badge">{t(`lotSerial.lotStatus.${l.status}`)}</span>,
    },
    { key: 'expiry', header: t('lotSerial.lots.col.expiry'), render: (l) => l.expiryDate ?? '-' },
    { key: 'onHand', header: t('lotSerial.lots.col.onHand'), numeric: true, render: (l) => l.onHand },
    {
      key: 'actions',
      header: t('lotSerial.col.actions'),
      headerHidden: true,
      render: (l) =>
        l.status === 'archived' ? null : (
          <div className="ls-row-actions">
            <select
              aria-label={t('lotSerial.lots.setStatus')}
              value=""
              disabled={!canWrite}
              onChange={(e) => {
                if (e.target.value !== '') {
                  void write('lot_set_status', { lotId: l.id, status: e.target.value, idempotencyKey: newKey() });
                }
              }}
            >
              <option value="">{t('lotSerial.lots.setStatus')}</option>
              {LOT_STATUSES.filter((s) => s !== 'archived' && s !== l.status).map((s) => (
                <option key={s} value={s}>
                  {t(`lotSerial.lotStatus.${s}`)}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => void write('lot_archive', { lotId: l.id, idempotencyKey: newKey() })}
              disabled={!canWrite}
            >
              {t('lotSerial.archive')}
            </button>
          </div>
        ),
    },
  ];

  // The Serials detail table: number, status badge, then the same read-only-header actions column.
  const serialColumns: DataTableColumn<Serial>[] = [
    { key: 'number', header: t('lotSerial.serials.col.number'), render: (s) => <span className="ls-code">{s.number}</span> },
    {
      key: 'status',
      header: t('lotSerial.serials.col.status'),
      render: (s) => <span className="ls-badge">{t(`lotSerial.serialStatus.${s.status}`)}</span>,
    },
    {
      key: 'actions',
      header: t('lotSerial.col.actions'),
      headerHidden: true,
      render: (s) =>
        s.status === 'archived' ? null : (
          <div className="ls-row-actions">
            <select
              aria-label={t('lotSerial.serials.setStatus')}
              value=""
              disabled={!canWrite}
              onChange={(e) => {
                if (e.target.value !== '') {
                  void write('serial_set_status', { serialId: s.id, status: e.target.value, idempotencyKey: newKey() });
                }
              }}
            >
              <option value="">{t('lotSerial.serials.setStatus')}</option>
              {SERIAL_STATUSES.filter((st) => st !== 'archived' && st !== s.status).map((st) => (
                <option key={st} value={st}>
                  {t(`lotSerial.serialStatus.${st}`)}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => void write('serial_archive', { serialId: s.id, idempotencyKey: newKey() })}
              disabled={!canWrite}
            >
              {t('lotSerial.archive')}
            </button>
          </div>
        ),
    },
  ];

  return (
    <div className="ls">
      <SurfaceHeader title={t('lotSerial.title')} help={<SurfaceHelp surface="LotSerial" />} />

      {failed && <ErrorBanner message={t('lotSerial.error.transport')} onRetry={() => void loadItems()} />}

      {loading ? (
        <Skeleton rows={4} />
      ) : items.length === 0 ? (
        <EmptyState title={t('lotSerial.empty.title')} hint={t('lotSerial.empty.hint')} />
      ) : (
        <div className="ls-split">
          <section className="ls-pane" aria-label={t('lotSerial.listLabel')}>
            <ul className="ls-list">
              {items.map((i) => (
                <li key={i.id}>
                  <button
                    type="button"
                    className={`ls-list-item ${i.id === selectedId ? 'ls-list-item-selected' : ''}`}
                    onClick={() => setSelectedId(i.id)}
                    aria-pressed={i.id === selectedId}
                  >
                    <span className="ls-item-name">{i.name}</span>
                    <span className="ls-badge">{t(`lotSerial.mode.${i.trackingMode}`)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>

          <section className="ls-pane ls-detail" aria-label={t('lotSerial.detailLabel')}>
            {selected === null ? (
              <p className="ls-muted">{t('lotSerial.selectHint')}</p>
            ) : (
              <>
                <div className="ls-mode">
                  <h2 className="ls-detail-title">{selected.name}</h2>
                  <label className="ls-field-inline" htmlFor="ls-mode-select">
                    <span>{t('lotSerial.modeLabel')}</span>
                    <select
                      id="ls-mode-select"
                      value={selected.trackingMode}
                      disabled={!canWrite}
                      onChange={(e) => void setMode(e.target.value as TrackingMode)}
                    >
                      {TRACKING_MODES.map((m) => (
                        <option key={m} value={m}>
                          {t(`lotSerial.mode.${m}`)}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                {writeError && !lotDrawer && !serialDrawer && (
                  <ErrorBanner error={writeError} message={localError(writeError)} />
                )}

                {selected.trackingMode === 'none' ? (
                  <p className="ls-muted">{t('lotSerial.notTracked')}</p>
                ) : detailLoading ? (
                  <Skeleton rows={3} />
                ) : (
                  <>
                    {modeHasLot(selected.trackingMode) && (
                      <section className="ls-section">
                        <div className="ls-subhead">
                          <h3 className="ls-h3">{t('lotSerial.lots.title')}</h3>
                          <button
                            type="button"
                            className="btn btn--primary"
                            onClick={() => {
                              setWriteError(null);
                              setLotDraft(EMPTY_LOT);
                              setLotDrawer(true);
                            }}
                            disabled={!canWrite}
                          >
                            {t('lotSerial.lots.new')}
                          </button>
                        </div>
                        <DataTable
                          columns={lotColumns}
                          rows={lots}
                          rowKey={(l) => l.id}
                          caption={t('lotSerial.lots.title')}
                          rowClassName={(l) => (l.status === 'archived' ? 'ls-archived' : undefined)}
                          emptyState={<p className="ls-muted">{t('lotSerial.lots.empty')}</p>}
                        />
                      </section>
                    )}

                    {modeHasSerial(selected.trackingMode) && (
                      <section className="ls-section">
                        <div className="ls-subhead">
                          <h3 className="ls-h3">{t('lotSerial.serials.title')}</h3>
                          <button
                            type="button"
                            className="btn btn--primary"
                            onClick={() => {
                              setWriteError(null);
                              setSerialDraft(EMPTY_SERIAL);
                              setSerialDrawer(true);
                            }}
                            disabled={!canWrite}
                          >
                            {t('lotSerial.serials.new')}
                          </button>
                        </div>
                        <DataTable
                          columns={serialColumns}
                          rows={serials}
                          rowKey={(s) => s.id}
                          caption={t('lotSerial.serials.title')}
                          rowClassName={(s) => (s.status === 'archived' ? 'ls-archived' : undefined)}
                          emptyState={<p className="ls-muted">{t('lotSerial.serials.empty')}</p>}
                        />
                      </section>
                    )}
                  </>
                )}
              </>
            )}
          </section>
        </div>
      )}

      {lotDrawer && selected !== null && (
        <DetailDrawer
          open
          onClose={() => setLotDrawer(false)}
          title={t('lotSerial.lots.form.title')}
          closeLabel={t('lotSerial.cancel')}
          footer={
            <>
              <button type="button" className="btn btn--secondary" onClick={() => setLotDrawer(false)}>
                {t('lotSerial.cancel')}
              </button>
              <button type="button" className="btn btn--primary" onClick={() => void submitLot()} disabled={!canWrite}>
                {t('lotSerial.save')}
              </button>
            </>
          }
        >
          {writeError && <ErrorBanner error={writeError} message={localError(writeError)} />}
          <div className="ls-field">
            <label htmlFor="lot-number">{t('lotSerial.lots.field.number')}</label>
            <input id="lot-number" maxLength={60} value={lotDraft.number} onChange={(e) => setLotDraft({ ...lotDraft, number: e.target.value })} />
          </div>
          <div className="ls-field">
            <label htmlFor="lot-expiry">{t('lotSerial.lots.field.expiry')}</label>
            <input id="lot-expiry" type="date" value={lotDraft.expiryDate} onChange={(e) => setLotDraft({ ...lotDraft, expiryDate: e.target.value })} />
          </div>
          <div className="ls-field">
            <label htmlFor="lot-supplier">{t('lotSerial.lots.field.supplier')}</label>
            <input id="lot-supplier" value={lotDraft.supplierReference} onChange={(e) => setLotDraft({ ...lotDraft, supplierReference: e.target.value })} />
          </div>
        </DetailDrawer>
      )}

      {serialDrawer && selected !== null && (
        <DetailDrawer
          open
          onClose={() => setSerialDrawer(false)}
          title={t('lotSerial.serials.form.title')}
          closeLabel={t('lotSerial.cancel')}
          footer={
            <>
              <button type="button" className="btn btn--secondary" onClick={() => setSerialDrawer(false)}>
                {t('lotSerial.cancel')}
              </button>
              <button type="button" className="btn btn--primary" onClick={() => void submitSerial()} disabled={!canWrite}>
                {t('lotSerial.save')}
              </button>
            </>
          }
        >
          {writeError && <ErrorBanner error={writeError} message={localError(writeError)} />}
          <div className="ls-field">
            <label htmlFor="serial-numbers">{t('lotSerial.serials.field.numbers')}</label>
            <textarea
              id="serial-numbers"
              rows={4}
              value={serialDraft.numbers}
              onChange={(e) => setSerialDraft({ ...serialDraft, numbers: e.target.value })}
            />
            <p className="ls-hint">{t('lotSerial.serials.field.numbersHint')}</p>
          </div>
          {selected.trackingMode === 'lot_and_serial' && (
            <div className="ls-field">
              <label htmlFor="serial-lot">{t('lotSerial.serials.field.lot')}</label>
              <select id="serial-lot" value={serialDraft.lotId} onChange={(e) => setSerialDraft({ ...serialDraft, lotId: e.target.value })}>
                <option value="">{t('lotSerial.serials.field.noLot')}</option>
                {activeLots.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.number}
                  </option>
                ))}
              </select>
            </div>
          )}
        </DetailDrawer>
      )}
    </div>
  );
}
