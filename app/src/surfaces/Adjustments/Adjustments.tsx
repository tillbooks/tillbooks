/**
 * J05, Inventory -> Adjustments / Bestandeskorrekturen (`/inventory-adjustments`): the surface over the
 * reason-coded manual adjustment ledger. The list shows every adjustment (date, item, location, signed
 * quantity, reason, note, reverse action). A "New adjustment" drawer posts a single reason-coded change
 * through `inventory_adjust`, which mints ONE J02 movement (movement_type adjustment) and records its
 * reason; a Reverse action posts the linked opposite-sign correction through `inventory_adjust_reverse`.
 *
 * On-hand is never written here: every quantity change is a J02 movement, and this surface only ever
 * calls the J05 verbs (never a stock table). Signed quantity is shown as glyph + sign, never colour
 * alone (WCAG 2.2 AA); no new colour token (design-canon). The reason picker shows only active codes and
 * marks the ones that require a note.
 *
 * ## BUILT ON THE SHARED UI PRIMITIVES (D118 Phase 2, 2026-08-24)
 *
 * The ledger is the shared `DataTable` (frame overflow, sticky header, density and the five states in
 * one place); the signed quantity is a numeric, right-aligned `.t-num` cell and a reversed row dims and
 * strikes through the `rowClassName` hook. The page header and the primary action are the shared
 * `SurfaceHeader`; the create form is the shared `DetailDrawer` (focus trap, Escape, scrim) and the
 * reverse confirm is the shared `Modal`. A `FilterBar` searches the ledger client-side over item,
 * location, reason and note, so a long adjustment history stays findable and a filtered-empty list is
 * never a dead end. The per-surface CSS that duplicated the table, the drawer chrome and the button set
 * is gone; what remains is genuinely Adjustments-specific: the signed-quantity weight, the reversed-row
 * state, the reason badge and the drawer form fields.
 *
 * No `Provenance` (C3): the J05 read model carries no created-by/created-at line to show. No
 * `ConsequenceLine` (C4): the J05 verbs carry no engine consequence sentence to render.
 *
 * THE PERMISSION GATE HERE IS A CONVENIENCE (the standing Studio rule): capabilities fail open and the
 * engine is the real gate. Write controls disable behind `manage_master_data`; a click that slips
 * through still surfaces the engine's own `permission_denied`.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';

import { useClient } from '../../lib/client-context';
import { isErr, type Err } from '../../lib/client';
import { CAP, useCapabilities } from '../../lib/capabilities';
import { useWorkspaceId } from '../../app/workspace';
import { useT } from '../../i18n';
import { SurfaceHelp } from '../../components/SurfaceHelp';
import { EmptyState, ErrorBanner, NoWorkspaceState, PermissionDenied } from '../../components/states';
import { DataTable, type DataTableColumn } from '../../components/DataTable';
import { SurfaceHeader } from '../../components/SurfaceHeader';
import { ActionFeedback } from '../../components/ActionFeedback';
import { DetailDrawer } from '../../components/DetailDrawer';
import { Modal } from '../../components/Modal';
import { FilterBar } from '../../components/FilterBar';
import { Select } from '../../components/Select';
import { Status } from '../../components/Status';
import { formatCalendar } from '../../lib/format';
import './Adjustments.css';

/** The J05 rejection codes with a surface-scoped message. Others fall through to the global mapping. */
const J05_ERROR_CODES = new Set([
  'reason_inactive',
  'no_active_reasons',
  'note_required',
  'insufficient_stock',
  'invalid_qty',
  'period_locked',
  'already_reversed',
]);

const newKey = (): string => crypto.randomUUID();

interface Reason {
  id: string;
  code: string;
  name: string;
  requiresNote: boolean;
}
interface Named {
  id: string;
  name: string;
}
interface Adjustment {
  id: string;
  batchId: string | null;
  itemName: string;
  locationName: string;
  qtyDelta: number;
  reasonCode: string;
  reasonName: string;
  note: string | null;
  effectiveDate: string;
  reversesAdjustmentId: string | null;
  reversedByAdjustmentId: string | null;
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}
function parseReason(raw: unknown): Reason | null {
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string') return null;
  return { id: r.id, code: str(r.code), name: str(r.name), requiresNote: r.requiresNote === true };
}
function parseNamed(raw: unknown): Named | null {
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string') return null;
  return { id: r.id, name: str(r.name, r.id) };
}
function parseAdjustment(raw: unknown): Adjustment | null {
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string') return null;
  return {
    id: r.id,
    batchId: typeof r.batchId === 'string' ? r.batchId : null,
    itemName: str(r.itemName, str(r.itemId)),
    locationName: str(r.locationName, str(r.locationId)),
    qtyDelta: typeof r.qtyDelta === 'number' ? r.qtyDelta : 0,
    reasonCode: str(r.reasonCode),
    reasonName: str(r.reasonName),
    note: typeof r.note === 'string' ? r.note : null,
    effectiveDate: str(r.effectiveDate),
    reversesAdjustmentId: typeof r.reversesAdjustmentId === 'string' ? r.reversesAdjustmentId : null,
    reversedByAdjustmentId: typeof r.reversedByAdjustmentId === 'string' ? r.reversedByAdjustmentId : null,
  };
}

interface NewDraft {
  itemId: string;
  locationId: string;
  qtyDelta: string;
  reasonCodeId: string;
  note: string;
  unitCostMinor: string;
  effectiveDate: string;
}
const emptyNew = (): NewDraft => ({
  itemId: '',
  locationId: '',
  qtyDelta: '',
  reasonCodeId: '',
  note: '',
  unitCostMinor: '',
  effectiveDate: new Date().toISOString().slice(0, 10),
});

interface ReverseDraft {
  adjustmentId: string;
  reasonCodeId: string;
  note: string;
}

export function Adjustments() {
  const t = useT();
  const client = useClient();
  const workspaceId = useWorkspaceId();
  const { can } = useCapabilities();
  const canWrite = can(CAP.manageMasterData);

  const [rows, setRows] = useState<Adjustment[]>([]);
  const [reasons, setReasons] = useState<Reason[]>([]);
  const [items, setItems] = useState<Named[]>([]);
  const [locations, setLocations] = useState<Named[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [denied, setDenied] = useState(false);
  const [writeError, setWriteError] = useState<Err | null>(null);
  const [query, setQuery] = useState('');

  const [newDrawer, setNewDrawer] = useState(false);
  const [newDraft, setNewDraft] = useState<NewDraft>(emptyNew);
  const [reverseDraft, setReverseDraft] = useState<ReverseDraft | null>(null);

  const localError = useCallback(
    (e: Err | null): string | undefined =>
      e !== null && J05_ERROR_CODES.has(e.error) ? t(`adjustments.errors.${e.error}`) : undefined,
    [t],
  );

  const load = useCallback(async () => {
    if (workspaceId === null) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setFailed(false);
    setDenied(false);
    const [listRes, reasonRes, itemRes, locRes] = await Promise.all([
      client.call('inventory_adjust_list', { workspaceId, limit: 200 }),
      client.call('inventory_reason_list', { workspaceId, activeOnly: true }),
      client.call('list_items', { workspaceId }),
      client.call('location_list', { workspaceId }),
    ]);
    if (isErr(listRes.body)) {
      if (listRes.body.error === 'permission_denied' || listRes.status === 403) setDenied(true);
      else setFailed(true);
      setLoading(false);
      return;
    }
    const list = (listRes.body as { items?: unknown }).items;
    setRows(Array.isArray(list) ? list.map(parseAdjustment).filter((a): a is Adjustment => a !== null) : []);
    const rsn = isErr(reasonRes.body) ? [] : (reasonRes.body as { reasons?: unknown }).reasons;
    setReasons(Array.isArray(rsn) ? rsn.map(parseReason).filter((r): r is Reason => r !== null) : []);
    const its = isErr(itemRes.body) ? [] : (itemRes.body as { items?: unknown }).items;
    setItems(Array.isArray(its) ? its.map(parseNamed).filter((i): i is Named => i !== null) : []);
    const locs = isErr(locRes.body) ? [] : (locRes.body as { locations?: unknown }).locations;
    setLocations(Array.isArray(locs) ? locs.map(parseNamed).filter((l): l is Named => l !== null) : []);
    setLoading(false);
  }, [client, workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  const selectedReason = useMemo(
    () => reasons.find((r) => r.id === newDraft.reasonCodeId) ?? null,
    [reasons, newDraft.reasonCodeId],
  );

  // Client-side ledger search over the columns a human scans by: item, location, reason and note.
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q === '') return rows;
    return rows.filter((a) =>
      [a.itemName, a.locationName, a.reasonCode, a.reasonName, a.note ?? '']
        .join(' ')
        .toLowerCase()
        .includes(q),
    );
  }, [rows, query]);

  const submitNew = useCallback(async () => {
    if (workspaceId === null) return;
    setWriteError(null);
    const qty = Number.parseInt(newDraft.qtyDelta, 10);
    if (!Number.isInteger(qty) || qty === 0) {
      setWriteError({ error: 'invalid_qty' } as Err);
      return;
    }
    const unitCost = newDraft.unitCostMinor.trim() === '' ? undefined : Number.parseInt(newDraft.unitCostMinor, 10);
    const res = await client.call('inventory_adjust', {
      workspaceId,
      itemId: newDraft.itemId,
      locationId: newDraft.locationId,
      qtyDelta: qty,
      reasonCodeId: newDraft.reasonCodeId,
      note: newDraft.note.trim() === '' ? undefined : newDraft.note.trim(),
      unitCostMinor: unitCost,
      effectiveDate: newDraft.effectiveDate,
      idempotencyKey: newKey(),
    });
    if (isErr(res.body)) {
      setWriteError(res.body);
      return;
    }
    setNewDrawer(false);
    setNewDraft(emptyNew());
    await load();
  }, [client, workspaceId, newDraft, load]);

  const submitReverse = useCallback(async () => {
    if (workspaceId === null || reverseDraft === null) return;
    setWriteError(null);
    const res = await client.call('inventory_adjust_reverse', {
      workspaceId,
      adjustmentId: reverseDraft.adjustmentId,
      reasonCodeId: reverseDraft.reasonCodeId,
      note: reverseDraft.note.trim() === '' ? undefined : reverseDraft.note.trim(),
      idempotencyKey: newKey(),
    });
    if (isErr(res.body)) {
      setWriteError(res.body);
      return;
    }
    setReverseDraft(null);
    await load();
  }, [client, workspaceId, reverseDraft, load]);

  if (workspaceId === null) return <NoWorkspaceState body={t('adjustments.noWorkspace')} />;
  if (denied) return <PermissionDenied title={t('adjustments.title')} />;

  const noReasons = reasons.length === 0;

  // Text left, the signed quantity a numeric right-aligned `.t-num` cell (glyph + sign, never colour
  // alone). A reversed row dims and strikes through the rowClassName hook; the badge still carries the
  // reason code. The actions column hosts the per-row Reverse control.
  const columns: DataTableColumn<Adjustment>[] = [
    { key: 'date', header: t('adjustments.col.date'), render: (a) => formatCalendar(a.effectiveDate) },
    { key: 'item', header: t('adjustments.col.item'), render: (a) => a.itemName },
    { key: 'location', header: t('adjustments.col.location'), render: (a) => a.locationName },
    {
      key: 'qty',
      header: t('adjustments.col.qty'),
      numeric: true,
      render: (a) => <span className="adj-qty">{a.qtyDelta > 0 ? `+${a.qtyDelta}` : a.qtyDelta}</span>,
    },
    {
      key: 'reason',
      header: t('adjustments.col.reason'),
      render: (a) => (
        <>
          <span className="adj-code">{a.reasonCode}</span> {a.reasonName}
        </>
      ),
    },
    { key: 'note', header: t('adjustments.col.note'), render: (a) => <span className="adj-note">{a.note ?? ''}</span> },
    {
      key: 'state',
      header: t('adjustments.col.state'),
      // A reversed adjustment says so as the one Status word (K-22); a live one has nothing to add.
      render: (a) => (a.reversedByAdjustmentId !== null ? <Status kind="inactive" label={t('adjustments.reversed')} /> : null),
    },
  ];

  // K-21: Stornieren, a destructive verb, sits behind the row's overflow, never a button on the row.
  const adjustmentActions = (a: Adjustment) =>
    a.reversedByAdjustmentId !== null
      ? []
      : [
          {
            key: 'reverse',
            label: t('adjustments.reverse'),
            danger: true,
            disabled: noReasons,
            onSelect: () => {
              setWriteError(null);
              setReverseDraft({ adjustmentId: a.id, reasonCodeId: '', note: '' });
            },
          },
        ];

  const headerActions = (
    <button
      type="button"
      className="btn btn--primary"
      disabled={!canWrite || noReasons}
      onClick={() => {
        setWriteError(null);
        setNewDraft(emptyNew());
        setNewDrawer(true);
      }}
    >
      {t('adjustments.new')}
    </button>
  );

  return (
    <div className="adj">
      <SurfaceHeader
        title={t('adjustments.title')}
        help={<SurfaceHelp surface="Adjustments" />}
        actions={headerActions}
      />

      {noReasons && !loading && (
        <ActionFeedback tone="info" message={t('adjustments.noReasonsHint')} />
      )}
      {failed && <ErrorBanner context="read" message={t('adjustments.error.transport')} onRetry={() => void load()} />}
      {writeError && reverseDraft === null && !newDrawer && (
        <ErrorBanner error={writeError} message={localError(writeError)} />
      )}

      {rows.length > 0 && (
        <FilterBar
          searchValue={query}
          onSearchChange={setQuery}
          searchLabel={t('adjustments.search')}
          searchPlaceholder={t('adjustments.searchPlaceholder')}
          onClear={() => setQuery('')}
          clearLabel={t('adjustments.clear')}
        />
      )}

      <DataTable
        columns={columns}
        rows={visible}
        rowKey={(a) => a.id}
        caption={t('adjustments.title')}
        loading={loading}
        skeletonRows={5}
        rowClassName={(a) => (a.reversedByAdjustmentId !== null ? 'adj-row--reversed' : undefined)}
        rowActions={canWrite ? adjustmentActions : undefined}
        rowActionsLabel={(a) => t('adjustments.rowActions', { item: a.itemName })}
        emptyState={
          query.trim() !== '' ? (
            <EmptyState filtered={{ onClear: () => setQuery(''), clearLabel: t('adjustments.clear') }} />
          ) : (
            <EmptyState
              title={t('adjustments.empty.title')}
              hint={t('adjustments.empty.hint')}
              {...(canWrite && !noReasons
                ? {
                    action: {
                      label: t('adjustments.new'),
                      onClick: () => {
                        setWriteError(null);
                        setNewDraft(emptyNew());
                        setNewDrawer(true);
                      },
                    },
                  }
                : {})}
            />
          )
        }
      />

      {newDrawer && (
        <DetailDrawer
          open
          onClose={() => setNewDrawer(false)}
          title={t('adjustments.form.title')}
          closeLabel={t('adjustments.close')}
          footer={
            <>
              <button type="button" className="btn btn--secondary" onClick={() => setNewDrawer(false)}>
                {t('adjustments.close')}
              </button>
              <button type="button" className="btn btn--primary" disabled={!canWrite} onClick={() => void submitNew()}>
                {t('adjustments.post')}
              </button>
            </>
          }
        >
          {writeError && <ErrorBanner error={writeError} message={localError(writeError)} />}
          <div className="adj-field">
            <label htmlFor="adj-item">{t('adjustments.form.item')}</label>
            <Select
              id="adj-item"
              value={newDraft.itemId}
              onChange={(value) => setNewDraft({ ...newDraft, itemId: value })}
              options={[
                { value: '', label: t('adjustments.form.choose') },
                ...items.map((i) => ({ value: i.id, label: i.name })),
              ]}
              ariaLabel={t('adjustments.form.item')}
            />
          </div>
          <div className="adj-field">
            <label htmlFor="adj-loc">{t('adjustments.form.location')}</label>
            <Select
              id="adj-loc"
              value={newDraft.locationId}
              onChange={(value) => setNewDraft({ ...newDraft, locationId: value })}
              options={[
                { value: '', label: t('adjustments.form.choose') },
                ...locations.map((l) => ({ value: l.id, label: l.name })),
              ]}
              ariaLabel={t('adjustments.form.location')}
            />
          </div>
          <div className="adj-field">
            <label htmlFor="adj-qty">{t('adjustments.form.qty')}</label>
            <input
              id="adj-qty"
              className="field"
              type="number"
              value={newDraft.qtyDelta}
              onChange={(e) => setNewDraft({ ...newDraft, qtyDelta: e.target.value })}
            />
            <span className="adj-hint">{t('adjustments.form.qtyHint')}</span>
          </div>
          <div className="adj-field">
            <label htmlFor="adj-reason">{t('adjustments.form.reason')}</label>
            <Select
              id="adj-reason"
              value={newDraft.reasonCodeId}
              onChange={(value) => setNewDraft({ ...newDraft, reasonCodeId: value })}
              options={[
                { value: '', label: t('adjustments.form.choose') },
                ...reasons.map((r) => ({ value: r.id, label: `${r.code} · ${r.name}` })),
              ]}
              ariaLabel={t('adjustments.form.reason')}
            />
            {selectedReason?.requiresNote && <span className="adj-hint">{t('adjustments.form.noteRequiredHint')}</span>}
          </div>
          <div className="adj-field">
            <label htmlFor="adj-note">{t('adjustments.form.note')}</label>
            <input
              id="adj-note"
              className="field"
              value={newDraft.note}
              onChange={(e) => setNewDraft({ ...newDraft, note: e.target.value })}
            />
          </div>
          <div className="adj-field">
            <label htmlFor="adj-cost">{t('adjustments.form.unitCost')}</label>
            <input
              id="adj-cost"
              className="field"
              type="number"
              min="0"
              value={newDraft.unitCostMinor}
              onChange={(e) => setNewDraft({ ...newDraft, unitCostMinor: e.target.value })}
            />
          </div>
          <div className="adj-field">
            <label htmlFor="adj-date">{t('adjustments.form.date')}</label>
            <input
              id="adj-date"
              className="field"
              type="date"
              value={newDraft.effectiveDate}
              onChange={(e) => setNewDraft({ ...newDraft, effectiveDate: e.target.value })}
            />
          </div>
        </DetailDrawer>
      )}

      <Modal
        open={reverseDraft !== null}
        onClose={() => setReverseDraft(null)}
        title={t('adjustments.reverseForm.title')}
        closeLabel={t('adjustments.close')}
        footer={
          <>
            <button type="button" className="btn btn--secondary" onClick={() => setReverseDraft(null)}>
              {t('adjustments.close')}
            </button>
            <button type="button" className="btn btn--primary" disabled={!canWrite} onClick={() => void submitReverse()}>
              {t('adjustments.reverseForm.confirm')}
            </button>
          </>
        }
      >
        {reverseDraft !== null && (
          <>
            {writeError && <ErrorBanner error={writeError} message={localError(writeError)} />}
            <div className="adj-field">
              <label htmlFor="adj-rev-reason">{t('adjustments.reverseForm.reason')}</label>
              <Select
                id="adj-rev-reason"
                value={reverseDraft.reasonCodeId}
                onChange={(value) => setReverseDraft({ ...reverseDraft, reasonCodeId: value })}
                options={[
                  { value: '', label: t('adjustments.form.choose') },
                  ...reasons.map((r) => ({ value: r.id, label: `${r.code} · ${r.name}` })),
                ]}
                ariaLabel={t('adjustments.reverseForm.reason')}
              />
            </div>
            <div className="adj-field">
              <label htmlFor="adj-rev-note">{t('adjustments.reverseForm.note')}</label>
              <input
                id="adj-rev-note"
                className="field"
                value={reverseDraft.note}
                onChange={(e) => setReverseDraft({ ...reverseDraft, note: e.target.value })}
              />
            </div>
          </>
        )}
      </Modal>
    </div>
  );
}
