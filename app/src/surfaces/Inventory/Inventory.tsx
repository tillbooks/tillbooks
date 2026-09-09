/**
 * Inventory (Lager), the D01 surface (spec §6): the item x location on-hand grid with low-stock
 * badges, a Bewegung erfassen dialog (the human face of `stock_move`), a Bewertung panel that previews
 * and posts the period-end valuation (the A02 entry shown before confirm, P8), and an Inventur panel
 * for the OR 958c Abs. 2 stocktake (open, count, review the diff, commit).
 *
 * THE PADLOCK (A24): Bewegung erfassen and the Inventur commit are `manage_master_data`; Bewertung
 * ausführen is `post` (the one ledger-reaching act). Each affordance is ABSENT for an actor the engine
 * would refuse (the Contacts idiom); `useCan` fails open while `whoami` is unresolved, and the
 * engine's own gate is the one that decides. Money renders through P11 `formatMoney` (integer Rappen,
 * P2); the low-stock badge is glyph+label, never colour alone (WCAG 2.2 AA).
 *
 * D118 B2 primitives: the page header is the shared `SurfaceHeader`, every table (the on-hand grid,
 * the valuation per-item breakdown and the Inventur count sheet) is the shared `DataTable` (frame
 * overflow, sticky header, density and tabular figures), and the movement dialog is the shared
 * `Modal` (its own focus trap, Escape and focus return). The per-surface table and dialog CSS those
 * primitives now own is deleted; only the genuinely stock-specific styling (the low-stock badge, the
 * panels, the count field, the toast) stays.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';

import { useClient } from '../../lib/client-context';
import { isErr } from '../../lib/client';
import { useWorkspaceId } from '../../app/workspace';
import { useT, formatMoney, formatDate } from '../../i18n';
import { SurfaceHelp } from '../../components/SurfaceHelp';
import { SurfaceHeader } from '../../components/SurfaceHeader';
import { DataTable, type DataTableColumn } from '../../components/DataTable';
import { Modal } from '../../components/Modal';
import { ConsequenceLine } from '../../components/ConsequenceLine';
import { EmptyState, ErrorBanner, NoWorkspaceState, PermissionDenied, Skeleton } from '../../components/states';
import { useCan, CAP } from '../../lib/capabilities';
import type { Err } from '../../lib/client';

// The alertdialog role travels to the shared Modal as a prop, never as a literal attribute on the
// component, so the modal-role guard reads a bare `<Modal>` and the role lands on the div Modal owns.
const ALERT_DIALOG = 'alertdialog' as const;

interface LocationOpt {
  id: string;
  name: string;
  type: string | null;
  archived: boolean;
}
interface OnHandRow {
  itemId: string;
  itemName: string;
  locationId: string;
  locationName: string;
  onHand: number;
}
interface ItemOpt {
  id: string;
  name: string;
}
interface LowRow {
  itemId: string;
  itemName: string;
  onHand: number;
  reorderPoint: number;
}
interface ValuationItem {
  itemId: string;
  itemName: string;
  qty: number;
  unitCostMinor: number;
  valueMinor: number;
  lowerOfCostOrMarket: boolean;
}

type ValuationMethod = 'fifo' | 'weighted_avg';
const REASONS = ['receipt', 'issue', 'adjust', 'transfer', 'return'] as const;
type Reason = (typeof REASONS)[number];

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}
function idemKey(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function Inventory() {
  const t = useT();
  const client = useClient();
  const workspaceId = useWorkspaceId();
  const canMove = useCan(CAP.manageMasterData);
  const canPost = useCan(CAP.post);

  const [rows, setRows] = useState<OnHandRow[]>([]);
  const [locations, setLocations] = useState<LocationOpt[]>([]);
  const [items, setItems] = useState<ItemOpt[]>([]);
  const [low, setLow] = useState<LowRow[]>([]);
  const [baseCurrency, setBaseCurrency] = useState('CHF');

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Err | null>(null);
  const [denied, setDenied] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const [moveOpen, setMoveOpen] = useState(false);
  const [method, setMethod] = useState<ValuationMethod>('weighted_avg');
  const [asOf, setAsOf] = useState('');
  const [valuation, setValuation] = useState<{ totalValueMinor: number; perItem: ValuationItem[]; unpostedDeltaMinor: number; methodChanged: boolean } | null>(null);

  const lowIds = useMemo(() => new Set(low.map((l) => l.itemId)), [low]);

  const load = useCallback(async () => {
    if (workspaceId === null) return;
    setLoading(true);
    setError(null);
    setDenied(false);
    const [onHand, lowResp, profile] = await Promise.all([
      client.call('stock_on_hand', { workspaceId }),
      client.call('stock_low_stock', { workspaceId }),
      client.call('get_company_profile', { workspaceId }),
    ]);
    if (isErr(onHand.body)) {
      if (onHand.body.error === 'permission_denied' || onHand.status === 403) setDenied(true);
      else setError(onHand.body);
      setLoading(false);
      return;
    }
    setRows(asArray<OnHandRow>(onHand.body.rows));
    setLocations(asArray<LocationOpt>(onHand.body.locations));
    setItems(asArray<ItemOpt>(onHand.body.items));
    if (!isErr(lowResp.body)) setLow(asArray<LowRow>(lowResp.body.items));
    if (!isErr(profile.body)) setBaseCurrency((profile.body.baseCurrency as string) ?? 'CHF');
    setLoading(false);
  }, [client, workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  const previewValuation = useCallback(async () => {
    if (workspaceId === null || asOf === '') return;
    const resp = await client.call('stock_valuation_report', { workspaceId, method, asOf });
    if (isErr(resp.body)) {
      setToast(t(`stock.error.${resp.body.error}`));
      return;
    }
    setValuation({
      totalValueMinor: resp.body.totalValueMinor as number,
      perItem: asArray<ValuationItem>(resp.body.perItem),
      unpostedDeltaMinor: resp.body.unpostedDeltaMinor as number,
      methodChanged: resp.body.methodChanged as boolean,
    });
  }, [client, workspaceId, method, asOf, t]);

  const runValuation = useCallback(async () => {
    if (workspaceId === null || asOf === '') return;
    const resp = await client.call('stock_run_valuation', { workspaceId, method, asOf, idempotencyKey: idemKey('val') });
    if (isErr(resp.body)) {
      setToast(t(`stock.error.${resp.body.error}`));
      return;
    }
    setToast(t('stock.valuation.posted'));
    setValuation(null);
    await load();
  }, [client, workspaceId, method, asOf, t, load]);

  // The on-hand grid columns: text left, quantity a right-aligned tabular cell, and a trailing badge
  // column (its header hidden) that carries the glyph+label low-stock signal, never colour alone.
  const gridColumns: DataTableColumn<OnHandRow>[] = [
    { key: 'item', header: t('stock.movement.item'), render: (r) => r.itemName },
    { key: 'location', header: t('stock.movement.location'), render: (r) => r.locationName },
    { key: 'qty', header: t('stock.movement.qty'), numeric: true, render: (r) => r.onHand },
    {
      key: 'badge',
      header: t('stock.badge.low'),
      headerHidden: true,
      render: (r) =>
        lowIds.has(r.itemId) ? (
          <span className="inventory__badge" aria-label={t('stock.badge.low')}>
            <span aria-hidden="true">⚠</span> {t('stock.badge.low')}
          </span>
        ) : null,
    },
  ];

  const valuationColumns: DataTableColumn<ValuationItem>[] = [
    { key: 'item', header: t('stock.movement.item'), render: (v) => v.itemName },
    { key: 'qty', header: t('stock.movement.qty'), numeric: true, render: (v) => v.qty },
    { key: 'unitCost', header: t('stock.movement.unit_cost'), numeric: true, render: (v) => formatMoney(v.unitCostMinor, baseCurrency) },
    { key: 'value', header: t('stock.valuation.value'), numeric: true, render: (v) => formatMoney(v.valueMinor, baseCurrency) },
  ];

  if (workspaceId === null) return <NoWorkspaceState />;
  if (denied) return <PermissionDenied />;
  if (loading) return <Skeleton rows={6} />;
  if (error) return <ErrorBanner error={error} onRetry={() => void load()} />;

  return (
    <div className="inventory">
      <SurfaceHeader
        title={t('stock.route.title')}
        help={<SurfaceHelp surface="Inventory" />}
        actions={
          canMove ? (
            <button type="button" className="btn btn--primary" onClick={() => setMoveOpen(true)}>
              {t('stock.action.record_movement')}
            </button>
          ) : undefined
        }
      />

      {toast !== null && (
        <div className="inventory__toast" role="status">
          <span>{toast}</span>
          <button
            type="button"
            className="btn btn--ghost btn--sm inventory__toast-close"
            onClick={() => setToast(null)}
            aria-label={t('stock.toast.dismiss')}
          >
            <span aria-hidden="true">×</span>
          </button>
        </div>
      )}

      {items.length === 0 ? (
        <EmptyState title={t('stock.empty')} action={{ to: '/items', label: t('stock.empty_cta') }} />
      ) : (
        <DataTable
          columns={gridColumns}
          rows={rows}
          rowKey={(r) => `${r.itemId}:${r.locationId}`}
          caption={t('stock.route.title')}
        />
      )}

      <section className="inventory__panel" aria-label={t('stock.action.run_valuation')}>
        <h2>{t('stock.action.run_valuation')}</h2>
        <div className="inventory__row">
          <label>
            {t('stock.method.label')}
            <select value={method} onChange={(e) => setMethod(e.target.value as ValuationMethod)}>
              <option value="fifo">{t('stock.method.fifo')}</option>
              <option value="weighted_avg">{t('stock.method.weighted_avg')}</option>
            </select>
          </label>
          <label>
            {t('stock.valuation.as_of')}
            <input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
          </label>
          <button type="button" className="btn btn--secondary" onClick={() => void previewValuation()} disabled={asOf === ''}>
            {t('stock.valuation.preview')}
          </button>
          {canPost && (
            <button type="button" className="btn btn--accent" onClick={() => void runValuation()} disabled={asOf === ''}>
              {t('stock.action.run_valuation')}
            </button>
          )}
        </div>
        {valuation !== null && (
          <div className="inventory__valuation">
            {valuation.methodChanged && <p className="inventory__warn">{t('stock.valuation.stetigkeit')}</p>}
            <p>
              {t('stock.valuation.total')}: <strong>{formatMoney(valuation.totalValueMinor, baseCurrency)}</strong>
              {' · '}
              {t('stock.valuation.unposted_delta')}: {formatMoney(valuation.unpostedDeltaMinor, baseCurrency)}
            </p>
            <DataTable
              columns={valuationColumns}
              rows={valuation.perItem}
              rowKey={(v) => v.itemId}
              caption={t('stock.action.run_valuation')}
              emptyState={<EmptyState title={t('stock.empty')} />}
            />
          </div>
        )}
      </section>

      <InventurPanel baseCurrency={baseCurrency} onChanged={() => void load()} setToast={setToast} />

      {moveOpen && (
        <MovementDialog
          items={items}
          locations={locations.filter((l) => !l.archived)}
          onClose={() => setMoveOpen(false)}
          onSaved={async () => {
            setMoveOpen(false);
            setToast(t('stock.movement.saved'));
            await load();
          }}
          onError={(e) => setToast(t(`stock.error.${e}`))}
        />
      )}
    </div>
  );
}

function MovementDialog({
  items,
  locations,
  onClose,
  onSaved,
  onError,
}: {
  items: ItemOpt[];
  locations: LocationOpt[];
  onClose: () => void;
  onSaved: () => Promise<void>;
  onError: (error: string) => void;
}) {
  const t = useT();
  const client = useClient();
  const workspaceId = useWorkspaceId();
  const [itemId, setItemId] = useState(items[0]?.id ?? '');
  const [locationId, setLocationId] = useState(locations[0]?.id ?? '');
  const [qty, setQty] = useState('');
  const [reason, setReason] = useState<Reason>('receipt');
  const [unitCost, setUnitCost] = useState('');
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (workspaceId === null) return;
    const qtyNum = Number.parseInt(qty, 10);
    if (!Number.isInteger(qtyNum) || qtyNum === 0) {
      onError('invalid_qty');
      return;
    }
    setSaving(true);
    const input: Record<string, unknown> = { workspaceId, itemId, locationId, qty: qtyNum, reason, idempotencyKey: idemKey('mv') };
    if (unitCost !== '') input.unitCostMinor = Math.round(Number.parseFloat(unitCost) * 100);
    const resp = await client.call('stock_move', input);
    setSaving(false);
    if (isErr(resp.body)) {
      onError(resp.body.error as string);
      return;
    }
    await onSaved();
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={t('stock.action.record_movement')}
      closeLabel={t('stock.toast.dismiss')}
      footer={
        <>
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            {t('stock.dialog.cancel')}
          </button>
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => void save()}
            disabled={saving || locationId === '' || itemId === ''}
          >
            {t('stock.dialog.save')}
          </button>
        </>
      }
    >
      <div className="inventory__form">
        <label>
          {t('stock.movement.item')}
          <select value={itemId} onChange={(e) => setItemId(e.target.value)}>
            {items.map((i) => (
              <option key={i.id} value={i.id}>
                {i.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t('stock.movement.location')}
          <select value={locationId} onChange={(e) => setLocationId(e.target.value)}>
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t('stock.movement.reason_label')}
          <select value={reason} onChange={(e) => setReason(e.target.value as Reason)}>
            {REASONS.map((r) => (
              <option key={r} value={r}>
                {t(`stock.reason.${r}`)}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t('stock.movement.qty')}
          <input inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value)} />
        </label>
        <label>
          {t('stock.movement.unit_cost')}
          <input inputMode="decimal" value={unitCost} onChange={(e) => setUnitCost(e.target.value)} />
        </label>
      </div>
    </Modal>
  );
}

interface StocktakeLine {
  lineId: string;
  itemId: string;
  itemName: string;
  locationId: string;
  locationName: string;
  bookQty: number;
  countedQty: number | null;
  diffQty: number | null;
}

function InventurPanel({ baseCurrency, onChanged, setToast }: { baseCurrency: string; onChanged: () => void; setToast: (m: string) => void }) {
  const t = useT();
  const client = useClient();
  const workspaceId = useWorkspaceId();
  const canCommit = useCan(CAP.manageMasterData);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [lines, setLines] = useState<StocktakeLine[]>([]);
  const [frozenAt, setFrozenAt] = useState('');
  // The synchronous human confirm the statutory tier requires (DESIGN C4): committing files the
  // Inventar (OR 958c) and posts permanent inventory movements, so the write waits on this dialog.
  const [confirmCommit, setConfirmCommit] = useState(false);
  void baseCurrency;

  const refresh = useCallback(
    async (id: string) => {
      if (workspaceId === null) return;
      const resp = await client.call('stock_stocktake_report', { workspaceId, sessionId: id });
      if (!isErr(resp.body)) setLines(asArray<StocktakeLine>(resp.body.lines));
    },
    [client, workspaceId],
  );

  const open = async () => {
    if (workspaceId === null || frozenAt === '') return;
    const resp = await client.call('stock_stocktake_open', { workspaceId, frozenAt, idempotencyKey: idemKey('st') });
    if (isErr(resp.body)) {
      setToast(t(`stock.error.${resp.body.error}`));
      return;
    }
    const id = (resp.body.session as { id: string }).id;
    setSessionId(id);
    await refresh(id);
  };

  const count = async (line: StocktakeLine, value: string) => {
    if (workspaceId === null || sessionId === null) return;
    const n = Number.parseInt(value, 10);
    if (!Number.isInteger(n) || n < 0) return;
    const resp = await client.call('stock_stocktake_count', { workspaceId, sessionId, itemId: line.itemId, locationId: line.locationId, countedQty: n });
    if (!isErr(resp.body)) await refresh(sessionId);
  };

  const commit = async () => {
    if (workspaceId === null || sessionId === null) return;
    setConfirmCommit(false);
    const resp = await client.call('stock_stocktake_commit', { workspaceId, sessionId, idempotencyKey: idemKey('stc') });
    if (isErr(resp.body)) {
      setToast(t(`stock.error.${resp.body.error}`));
      return;
    }
    setToast(t('stock.stocktake.committed'));
    setSessionId(null);
    setLines([]);
    onChanged();
  };

  const stocktakeColumns: DataTableColumn<StocktakeLine>[] = [
    { key: 'item', header: t('stock.movement.item'), render: (l) => l.itemName },
    { key: 'location', header: t('stock.movement.location'), render: (l) => l.locationName },
    { key: 'bookQty', header: t('stock.stocktake.book_qty'), numeric: true, render: (l) => l.bookQty },
    {
      key: 'countedQty',
      header: t('stock.stocktake.counted_qty'),
      numeric: true,
      render: (l) => (
        <input
          inputMode="numeric"
          className="inventory__count"
          defaultValue={l.countedQty ?? ''}
          onBlur={(e) => void count(l, e.target.value)}
        />
      ),
    },
    { key: 'diff', header: t('stock.stocktake.diff'), numeric: true, render: (l) => l.diffQty ?? '–' },
  ];

  return (
    <section className="inventory__panel" aria-label={t('stock.stocktake.title')}>
      <h2>{t('stock.stocktake.title')}</h2>
      {sessionId === null ? (
        <div className="inventory__row">
          <label>
            {t('stock.valuation.as_of')}
            <input type="date" value={frozenAt} onChange={(e) => setFrozenAt(e.target.value)} />
          </label>
          <button type="button" className="btn btn--secondary" onClick={() => void open()} disabled={frozenAt === ''}>
            {t('stock.stocktake.open')}
          </button>
        </div>
      ) : (
        <>
          <p className="inventory__frozen">{t('stock.stocktake.frozen_at')}: {formatDate(frozenAt)}</p>
          <DataTable
            columns={stocktakeColumns}
            rows={lines}
            rowKey={(l) => l.lineId}
            caption={t('stock.stocktake.title')}
            emptyState={<EmptyState title={t('stock.stocktake.empty')} />}
          />
          {canCommit && lines.length > 0 && (
            <button type="button" className="btn btn--accent" onClick={() => setConfirmCommit(true)}>
              {t('stock.stocktake.commit')}
            </button>
          )}
        </>
      )}

      <Modal
        open={confirmCommit}
        onClose={() => setConfirmCommit(false)}
        role={ALERT_DIALOG}
        title={t('stock.stocktake.confirmTitle')}
        closeLabel={t('stock.dialog.cancel')}
        describedById="inventur-confirm-body"
        footer={
          <>
            <button type="button" className="btn btn--secondary" onClick={() => setConfirmCommit(false)}>
              {t('stock.dialog.cancel')}
            </button>
            <button type="button" className="btn btn--accent" onClick={() => void commit()}>
              {t('stock.stocktake.commit')}
            </button>
          </>
        }
      >
        <div id="inventur-confirm-body">
          <p>{t('stock.stocktake.confirmConsequence', { n: lines.filter((l) => l.diffQty !== null && l.diffQty !== 0).length })}</p>
          {/* C4 seam: renders nothing while stock_stocktake_commit carries a null dialCapability, and
              lights up automatically if the engine ever adds a consequence sentence. The variance
              summary above is the operative consequence today. */}
          <ConsequenceLine verb="stock_stocktake_commit" />
        </div>
      </Modal>
    </section>
  );
}
