/**
 * J00, Inventory -> Warehouses & Locations (`/warehouses`): the master surface where a workspace's
 * warehouses and their nested location tree live, so every stock movement can carry an explicit,
 * hierarchical location and on-hand can be read per location.
 *
 * Master-detail: the left pane lists warehouses (code, name, default badge, active); selecting one
 * loads its location tree on the right, plus its on-hand-by-location breakdown from
 * `inventory_balance_by_location`. Create/edit happen in a right-hand drawer. Status is glyph + label,
 * never colour alone (WCAG 2.2 AA). No new colour token (design-canon).
 *
 * ## BUILT ON THE SHARED UI PRIMITIVES (D118 B2, 2026-08-24)
 *
 * The three tables (the warehouse master list, the location tree, the on-hand-by-location breakdown)
 * are the shared `DataTable` now (frame overflow, sticky header, density and the five states in one
 * place), instead of a bespoke `<ul>` of buttons and two hand-rolled `<table>`s. The page header is
 * the shared `SurfaceHeader`, the two create/edit overlays are the shared `DetailDrawer`, and the
 * archive confirm is the shared `Modal` alertdialog. The per-surface CSS that duplicated all of that
 * is gone; what remains in Warehouses.css is genuinely surface-specific (the master-detail layout, the
 * location/default badges, the mono code cell, the drawer form fields).
 *
 * There is no FilterBar: this surface has no search box, only a show-archived toggle, and the B2 rule
 * is not to invent a search row that never existed. The toggle sits in the header action slot.
 *
 * THE PERMISSION GATE HERE IS A CONVENIENCE (the standing Studio rule): `whoami`/capabilities fail
 * open and the engine is the real gate. Write controls disable behind `manage_master_data`; a click
 * that slips through still surfaces the engine's own `permission_denied`.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';

import { useClient } from '../../lib/client-context';
import { isErr, type Err } from '../../lib/client';
import { CAP, useCapabilities } from '../../lib/capabilities';
import { useWorkspaceId } from '../../app/workspace';
import { useT } from '../../i18n';
import { EmptyState, ErrorBanner, NoWorkspaceState, PermissionDenied, Skeleton } from '../../components/states';
import { SurfaceHelp } from '../../components/SurfaceHelp';
import { SurfaceHeader } from '../../components/SurfaceHeader';
import { DataTable, type DataTableColumn } from '../../components/DataTable';
import { DetailDrawer } from '../../components/DetailDrawer';
import { Modal } from '../../components/Modal';
import './Warehouses.css';

const LOCATION_TYPES = ['zone', 'aisle', 'shelf', 'bin', 'staging', 'other'] as const;
type LocationType = (typeof LOCATION_TYPES)[number];

/** The archive confirm is a consequential dialog. Held as a value so the Modal role travels as a
 *  prop, not a literal attribute on the component (the modal-role source guard). */
const ALERT_DIALOG = 'alertdialog' as const;

/**
 * The J00 rejection codes with a surface-scoped message (`warehouses.errors.<code>`). Kept out of the
 * shared global `errors.*` namespace so a code like `duplicate_code` does not collide with another
 * surface's wording. Any code NOT here (permission_denied, invalid_input, ...) falls through to
 * ErrorBanner's own global mapping.
 */
const J00_ERROR_CODES = new Set([
  'invalid_code',
  'duplicate_code',
  'parent_warehouse_mismatch',
  'location_cycle',
  'location_has_stock',
  'location_in_use',
  'cannot_archive_default',
  'warehouse_archived',
  'location_archived',
  'invalid_location_type',
  'max_depth_exceeded',
]);

const newKey = () => crypto.randomUUID();

export interface Warehouse {
  id: string;
  code: string;
  name: string;
  description: string | null;
  city: string | null;
  isDefault: boolean;
  active: boolean;
}

export interface LocationNode {
  id: string;
  code: string | null;
  name: string;
  locationType: string | null;
  depth: number;
  isDefaultForWarehouse: boolean;
  active: boolean;
  children: LocationNode[];
}

interface BalanceRow {
  itemId: string;
  itemName: string;
  locationId: string;
  locationCode: string | null;
  locationName: string;
  qty: number;
}

function parseWarehouses(body: unknown): Warehouse[] | null {
  const rows = (body as { warehouses?: unknown })?.warehouses;
  if (!Array.isArray(rows)) return null;
  const out: Warehouse[] = [];
  for (const raw of rows) {
    if (raw === null || typeof raw !== 'object') return null;
    const w = raw as Record<string, unknown>;
    if (typeof w.id !== 'string' || typeof w.code !== 'string' || typeof w.name !== 'string') return null;
    out.push({
      id: w.id,
      code: w.code,
      name: w.name,
      description: typeof w.description === 'string' ? w.description : null,
      city: typeof w.city === 'string' ? w.city : null,
      isDefault: w.isDefault === true,
      active: w.active === true,
    });
  }
  return out;
}

function parseTree(body: unknown): LocationNode[] {
  const roots = (body as { tree?: unknown })?.tree;
  return Array.isArray(roots) ? (roots.filter((n) => n !== null && typeof n === 'object') as LocationNode[]) : [];
}

function parseBalance(body: unknown): BalanceRow[] {
  const rows = (body as { rows?: unknown })?.rows;
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((r): r is Record<string, unknown> => r !== null && typeof r === 'object')
    .map((r) => ({
      itemId: String(r.itemId ?? ''),
      itemName: String(r.itemName ?? ''),
      locationId: String(r.locationId ?? ''),
      locationCode: typeof r.locationCode === 'string' ? r.locationCode : null,
      locationName: String(r.locationName ?? ''),
      qty: typeof r.qty === 'number' ? r.qty : 0,
    }));
}

/** Flatten the tree in display order so a dense indented list renders it with one map. */
function flatten(nodes: LocationNode[], includeArchived: boolean): LocationNode[] {
  const out: LocationNode[] = [];
  const walk = (list: LocationNode[]) => {
    for (const n of list) {
      if (includeArchived || n.active) out.push(n);
      if (Array.isArray(n.children)) walk(n.children);
    }
  };
  walk(nodes);
  return out;
}

interface WarehouseDraft {
  code: string;
  name: string;
  city: string;
  description: string;
}
const EMPTY_WH: WarehouseDraft = { code: '', name: '', city: '', description: '' };

interface LocationDraft {
  code: string;
  name: string;
  locationType: LocationType | '';
  parentId: string;
  description: string;
}
const EMPTY_LOC: LocationDraft = { code: '', name: '', locationType: '', parentId: '', description: '' };

export function Warehouses() {
  const t = useT();
  const client = useClient();
  const workspaceId = useWorkspaceId();
  const { can } = useCapabilities();

  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tree, setTree] = useState<LocationNode[]>([]);
  const [balance, setBalance] = useState<BalanceRow[]>([]);
  const [showArchived, setShowArchived] = useState(false);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [denied, setDenied] = useState(false);
  const [writeError, setWriteError] = useState<Err | null>(null);

  const [whDrawer, setWhDrawer] = useState<'closed' | 'create' | string>('closed');
  const [whDraft, setWhDraft] = useState<WarehouseDraft>(EMPTY_WH);
  const [locDrawer, setLocDrawer] = useState<'closed' | 'create' | string>('closed');
  const [locDraft, setLocDraft] = useState<LocationDraft>(EMPTY_LOC);
  const [confirm, setConfirm] = useState<{ kind: 'warehouse' | 'location'; id: string; label: string } | null>(null);

  const canWrite = can(CAP.manageMasterData);
  // Resolve a J00 rejection to its surface-scoped message, or undefined to let ErrorBanner map it.
  const localError = useCallback(
    (e: Err | null): string | undefined =>
      e !== null && J00_ERROR_CODES.has(e.error) ? t(`warehouses.errors.${e.error}`) : undefined,
    [t],
  );
  const selected = useMemo(() => warehouses.find((w) => w.id === selectedId) ?? null, [warehouses, selectedId]);
  const flatLocations = useMemo(() => flatten(tree, showArchived), [tree, showArchived]);
  const activeLocations = useMemo(() => flatten(tree, false), [tree]);

  const loadWarehouses = useCallback(async () => {
    if (workspaceId === null) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setFailed(false);
    setDenied(false);
    const listed = await client.call('warehouse_list', {
      workspaceId,
      ...(showArchived ? {} : { active: true }),
    });
    if (isErr(listed.body)) {
      if (listed.body.error === 'permission_denied' || listed.status === 403) setDenied(true);
      else setFailed(true);
      setLoading(false);
      return;
    }
    const parsed = parseWarehouses(listed.body);
    if (parsed === null) {
      setFailed(true);
      setLoading(false);
      return;
    }
    setWarehouses(parsed);
    setSelectedId((prev) => (prev !== null && parsed.some((w) => w.id === prev) ? prev : (parsed[0]?.id ?? null)));
    setLoading(false);
  }, [client, workspaceId, showArchived]);

  const loadDetail = useCallback(
    async (warehouseId: string) => {
      if (workspaceId === null) return;
      setDetailLoading(true);
      const [treeRes, balRes] = await Promise.all([
        client.call('location_tree', { workspaceId, warehouseId }),
        client.call('inventory_balance_by_location', { workspaceId, warehouseId }),
      ]);
      setTree(isErr(treeRes.body) ? [] : parseTree(treeRes.body));
      setBalance(isErr(balRes.body) ? [] : parseBalance(balRes.body));
      setDetailLoading(false);
    },
    [client, workspaceId],
  );

  useEffect(() => {
    void loadWarehouses();
  }, [loadWarehouses]);

  useEffect(() => {
    if (selectedId !== null) void loadDetail(selectedId);
    else {
      setTree([]);
      setBalance([]);
    }
  }, [selectedId, loadDetail]);

  const write = useCallback(
    async (action: string, input: Record<string, unknown>): Promise<boolean> => {
      if (workspaceId === null) return false;
      setWriteError(null);
      const response = await client.call(action, { workspaceId, ...input });
      if (isErr(response.body)) {
        setWriteError(response.body);
        return false;
      }
      await loadWarehouses();
      if (selectedId !== null) await loadDetail(selectedId);
      return true;
    },
    [client, workspaceId, loadWarehouses, loadDetail, selectedId],
  );

  const ensureDefault = useCallback(async () => {
    await write('inventory_ensure_default_location', {});
  }, [write]);

  // --- warehouse drawer ---
  const openWhCreate = () => {
    setWriteError(null);
    setWhDraft(EMPTY_WH);
    setWhDrawer('create');
  };
  const openWhEdit = (w: Warehouse) => {
    setWriteError(null);
    setWhDraft({ code: w.code, name: w.name, city: w.city ?? '', description: w.description ?? '' });
    setWhDrawer(w.id);
  };
  const submitWh = useCallback(async () => {
    const shared = {
      name: whDraft.name.trim(),
      city: whDraft.city.trim() === '' ? undefined : whDraft.city.trim(),
      description: whDraft.description.trim() === '' ? undefined : whDraft.description.trim(),
    };
    let ok = false;
    if (whDrawer === 'create') {
      ok = await write('warehouse_create', { code: whDraft.code.trim(), ...shared, idempotencyKey: newKey() });
    } else {
      ok = await write('warehouse_update', { warehouseId: whDrawer, patch: shared, idempotencyKey: newKey() });
    }
    if (ok) setWhDrawer('closed');
  }, [write, whDraft, whDrawer]);

  // --- location drawer ---
  const openLocCreate = () => {
    setWriteError(null);
    setLocDraft(EMPTY_LOC);
    setLocDrawer('create');
  };
  const openLocEdit = (n: LocationNode) => {
    setWriteError(null);
    setLocDraft({
      code: n.code ?? '',
      name: n.name,
      locationType: (LOCATION_TYPES.includes(n.locationType as LocationType) ? n.locationType : '') as LocationType | '',
      parentId: '',
      description: '',
    });
    setLocDrawer(n.id);
  };
  const submitLoc = useCallback(async () => {
    if (selected === null) return;
    const locationType = locDraft.locationType === '' ? undefined : locDraft.locationType;
    let ok = false;
    if (locDrawer === 'create') {
      ok = await write('location_create', {
        warehouseId: selected.id,
        code: locDraft.code.trim(),
        name: locDraft.name.trim(),
        parentId: locDraft.parentId === '' ? undefined : locDraft.parentId,
        locationType,
        description: locDraft.description.trim() === '' ? undefined : locDraft.description.trim(),
        idempotencyKey: newKey(),
      });
    } else {
      ok = await write('location_update', {
        locationId: locDrawer,
        patch: {
          name: locDraft.name.trim(),
          locationType,
          description: locDraft.description.trim() === '' ? undefined : locDraft.description.trim(),
        },
        idempotencyKey: newKey(),
      });
    }
    if (ok) setLocDrawer('closed');
  }, [write, locDraft, locDrawer, selected]);

  const doConfirm = useCallback(async () => {
    if (confirm === null) return;
    const ok =
      confirm.kind === 'warehouse'
        ? await write('warehouse_archive', { warehouseId: confirm.id, idempotencyKey: newKey() })
        : await write('location_archive', { locationId: confirm.id, idempotencyKey: newKey() });
    if (ok) setConfirm(null);
  }, [write, confirm]);

  if (workspaceId === null) return <NoWorkspaceState body={t('warehouses.noWorkspace')} />;
  if (denied) return <PermissionDenied title={t('warehouses.title')} />;

  const warehouseColumns: DataTableColumn<Warehouse>[] = [
    {
      key: 'code',
      header: t('warehouses.field.code'),
      render: (w) => <span className="wh-code">{w.code}</span>,
    },
    {
      key: 'name',
      header: t('warehouses.field.name'),
      render: (w) => (
        <span className="wh-name-cell">
          <span className="wh-name">{w.name}</span>
          {w.isDefault && <span className="wh-badge wh-badge-default">{t('warehouses.default')}</span>}
          {!w.active && <span className="wh-badge wh-badge-archived">{t('warehouses.archived')}</span>}
        </span>
      ),
    },
  ];

  const locationColumns: DataTableColumn<LocationNode>[] = [
    {
      key: 'code',
      header: t('warehouses.locations.col.code'),
      // Depth is the tree's indentation, added on top of the cell's own left padding.
      render: (n) => (
        <span className="wh-code" style={{ paddingLeft: `${n.depth * 1.25}rem` }}>
          {n.code}
          {n.isDefaultForWarehouse && <span className="wh-badge wh-badge-default">{t('warehouses.default')}</span>}
        </span>
      ),
    },
    { key: 'name', header: t('warehouses.locations.col.name'), render: (n) => n.name },
    {
      key: 'type',
      header: t('warehouses.locations.col.type'),
      render: (n) => (n.locationType === null ? '-' : t(`warehouses.locations.type.${n.locationType}`)),
    },
    {
      key: 'actions',
      header: t('warehouses.locations.col.actions'),
      headerHidden: true,
      align: 'end',
      render: (n) => (
        <span className="wh-row-actions">
          {!n.isDefaultForWarehouse && n.active && (
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => void write('location_set_default', { locationId: n.id, idempotencyKey: newKey() })}
              disabled={!canWrite}
            >
              {t('warehouses.makeDefault')}
            </button>
          )}
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => openLocEdit(n)} disabled={!canWrite}>
            {t('warehouses.edit')}
          </button>
          {n.active && (
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => {
                setWriteError(null);
                setConfirm({ kind: 'location', id: n.id, label: n.code ?? n.name });
              }}
              disabled={!canWrite}
            >
              {t('warehouses.archive')}
            </button>
          )}
        </span>
      ),
    },
  ];

  const balanceColumns: DataTableColumn<BalanceRow>[] = [
    { key: 'item', header: t('warehouses.balance.col.item'), render: (r) => r.itemName },
    { key: 'location', header: t('warehouses.balance.col.location'), render: (r) => r.locationCode ?? r.locationName },
    { key: 'qty', header: t('warehouses.balance.col.qty'), numeric: true, render: (r) => r.qty },
  ];

  const headerActions = (
    <>
      <label className="wh-toggle">
        <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
        {t('warehouses.showArchived')}
      </label>
      <button type="button" className="btn btn--primary" onClick={openWhCreate} disabled={!canWrite}>
        {t('warehouses.newWarehouse')}
      </button>
    </>
  );

  return (
    <div className="wh">
      <SurfaceHeader
        title={t('warehouses.title')}
        help={<SurfaceHelp surface="Warehouses" />}
        actions={headerActions}
      />

      {failed && <ErrorBanner message={t('warehouses.error.transport')} onRetry={() => void loadWarehouses()} />}

      {loading ? (
        <Skeleton rows={4} />
      ) : warehouses.length === 0 ? (
        <div className="wh-empty">
          <EmptyState
            title={t('warehouses.empty.title')}
            hint={t('warehouses.empty.hint')}
            action={canWrite ? { label: t('warehouses.empty.cta'), onClick: openWhCreate } : undefined}
          />
          {canWrite && (
            <button type="button" className="btn btn--ghost" onClick={() => void ensureDefault()}>
              {t('warehouses.empty.ensure')}
            </button>
          )}
        </div>
      ) : (
        <div className="wh-split">
          <section className="wh-pane" aria-label={t('warehouses.listLabel')}>
            <DataTable
              columns={warehouseColumns}
              rows={warehouses}
              rowKey={(w) => w.id}
              caption={t('warehouses.listLabel')}
              onRowClick={(w) => setSelectedId(w.id)}
              rowLabel={(w) => `${w.code} ${w.name}`}
              rowClassName={(w) =>
                [w.id === selectedId ? 'wh-row--selected' : '', w.active ? '' : 'wh-archived']
                  .filter(Boolean)
                  .join(' ') || undefined
              }
            />
          </section>

          <section className="wh-pane wh-detail" aria-label={t('warehouses.detailLabel')}>
            {selected === null ? (
              <p className="wh-muted">{t('warehouses.selectHint')}</p>
            ) : (
              <>
                <div className="wh-detail-head">
                  <div>
                    <h2 className="wh-detail-title">
                      {selected.code} <span className="wh-muted">{selected.name}</span>
                    </h2>
                  </div>
                  <div className="wh-detail-actions">
                    {!selected.isDefault && selected.active && (
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm"
                        onClick={() => void write('warehouse_set_default', { warehouseId: selected.id, idempotencyKey: newKey() })}
                        disabled={!canWrite}
                      >
                        {t('warehouses.makeDefault')}
                      </button>
                    )}
                    <button type="button" className="btn btn--ghost btn--sm" onClick={() => openWhEdit(selected)} disabled={!canWrite}>
                      {t('warehouses.edit')}
                    </button>
                    {selected.active && (
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm"
                        onClick={() => {
                          setWriteError(null);
                          setConfirm({ kind: 'warehouse', id: selected.id, label: selected.code });
                        }}
                        disabled={!canWrite}
                      >
                        {t('warehouses.archive')}
                      </button>
                    )}
                  </div>
                </div>

                <div className="wh-subhead">
                  <h3 className="wh-h3">{t('warehouses.locations.title')}</h3>
                  <button type="button" className="btn btn--primary" onClick={openLocCreate} disabled={!canWrite || !selected.active}>
                    {t('warehouses.locations.new')}
                  </button>
                </div>

                <DataTable
                  columns={locationColumns}
                  rows={flatLocations}
                  rowKey={(n) => n.id}
                  caption={t('warehouses.locations.title')}
                  loading={detailLoading}
                  skeletonRows={3}
                  emptyState={<p className="wh-muted">{t('warehouses.locations.empty')}</p>}
                  rowClassName={(n) => (n.active ? undefined : 'wh-archived')}
                />

                <h3 className="wh-h3 wh-onhand-head">{t('warehouses.balance.title')}</h3>
                <DataTable
                  columns={balanceColumns}
                  rows={balance}
                  rowKey={(r) => `${r.itemId}-${r.locationId}`}
                  caption={t('warehouses.balance.title')}
                  emptyState={<p className="wh-muted">{t('warehouses.balance.empty')}</p>}
                />
              </>
            )}
          </section>
        </div>
      )}

      {whDrawer !== 'closed' && (
        <DetailDrawer
          open
          onClose={() => setWhDrawer('closed')}
          title={whDrawer === 'create' ? t('warehouses.form.createTitle') : t('warehouses.form.editTitle')}
          closeLabel={t('warehouses.cancel')}
          footer={
            <>
              <button type="button" className="btn btn--secondary" onClick={() => setWhDrawer('closed')}>
                {t('warehouses.cancel')}
              </button>
              <button type="button" className="btn btn--primary" onClick={() => void submitWh()} disabled={!canWrite}>
                {t('warehouses.save')}
              </button>
            </>
          }
        >
          {writeError && <ErrorBanner error={writeError} message={localError(writeError)} />}
          <div className="wh-field">
            <label htmlFor="wh-code">{t('warehouses.field.code')}</label>
            <input
              id="wh-code"
              className="field"
              value={whDraft.code}
              maxLength={20}
              disabled={whDrawer !== 'create'}
              onChange={(e) => setWhDraft({ ...whDraft, code: e.target.value })}
            />
          </div>
          <div className="wh-field">
            <label htmlFor="wh-name">{t('warehouses.field.name')}</label>
            <input id="wh-name" className="field" value={whDraft.name} onChange={(e) => setWhDraft({ ...whDraft, name: e.target.value })} />
          </div>
          <div className="wh-field">
            <label htmlFor="wh-city">{t('warehouses.field.city')}</label>
            <input id="wh-city" className="field" value={whDraft.city} onChange={(e) => setWhDraft({ ...whDraft, city: e.target.value })} />
          </div>
          <div className="wh-field">
            <label htmlFor="wh-desc">{t('warehouses.field.description')}</label>
            <input id="wh-desc" className="field" value={whDraft.description} onChange={(e) => setWhDraft({ ...whDraft, description: e.target.value })} />
          </div>
        </DetailDrawer>
      )}

      {locDrawer !== 'closed' && selected !== null && (
        <DetailDrawer
          open
          onClose={() => setLocDrawer('closed')}
          title={locDrawer === 'create' ? t('warehouses.locations.form.createTitle') : t('warehouses.locations.form.editTitle')}
          closeLabel={t('warehouses.cancel')}
          footer={
            <>
              <button type="button" className="btn btn--secondary" onClick={() => setLocDrawer('closed')}>
                {t('warehouses.cancel')}
              </button>
              <button type="button" className="btn btn--primary" onClick={() => void submitLoc()} disabled={!canWrite}>
                {t('warehouses.save')}
              </button>
            </>
          }
        >
          {writeError && <ErrorBanner error={writeError} message={localError(writeError)} />}
          <div className="wh-field">
            <label htmlFor="loc-code">{t('warehouses.locations.field.code')}</label>
            <input
              id="loc-code"
              className="field"
              value={locDraft.code}
              maxLength={30}
              disabled={locDrawer !== 'create'}
              onChange={(e) => setLocDraft({ ...locDraft, code: e.target.value })}
            />
          </div>
          <div className="wh-field">
            <label htmlFor="loc-name">{t('warehouses.locations.field.name')}</label>
            <input id="loc-name" className="field" value={locDraft.name} onChange={(e) => setLocDraft({ ...locDraft, name: e.target.value })} />
          </div>
          <div className="wh-field">
            <label htmlFor="loc-type">{t('warehouses.locations.field.type')}</label>
            <select
              id="loc-type"
              className="field"
              value={locDraft.locationType}
              onChange={(e) => setLocDraft({ ...locDraft, locationType: e.target.value as LocationType | '' })}
            >
              <option value="">{t('warehouses.locations.field.noType')}</option>
              {LOCATION_TYPES.map((ty) => (
                <option key={ty} value={ty}>
                  {t(`warehouses.locations.type.${ty}`)}
                </option>
              ))}
            </select>
          </div>
          {locDrawer === 'create' && (
            <div className="wh-field">
              <label htmlFor="loc-parent">{t('warehouses.locations.field.parent')}</label>
              <select id="loc-parent" className="field" value={locDraft.parentId} onChange={(e) => setLocDraft({ ...locDraft, parentId: e.target.value })}>
                <option value="">{t('warehouses.locations.field.rootParent')}</option>
                {activeLocations.map((n) => (
                  <option key={n.id} value={n.id}>
                    {' '.repeat(n.depth * 2)}
                    {n.code ?? n.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="wh-field">
            <label htmlFor="loc-desc">{t('warehouses.locations.field.description')}</label>
            <input id="loc-desc" className="field" value={locDraft.description} onChange={(e) => setLocDraft({ ...locDraft, description: e.target.value })} />
          </div>
        </DetailDrawer>
      )}

      {confirm !== null && (
        <Modal
          open
          // A consequential confirm is an alertdialog (Modal hosts the role on its own div; the role
          // travels as a prop rather than a literal attribute on this component, per the modal-role
          // guard). It does not dismiss on a stray scrim click.
          role={ALERT_DIALOG}
          onClose={() => setConfirm(null)}
          title={t('warehouses.confirmTitle')}
          closeLabel={t('warehouses.cancel')}
          describedById="wh-confirm-msg"
          footer={
            <>
              <button type="button" className="btn btn--secondary" onClick={() => setConfirm(null)}>
                {t('warehouses.cancel')}
              </button>
              <button type="button" className="btn btn--danger" onClick={() => void doConfirm()}>
                {t('warehouses.archive')}
              </button>
            </>
          }
        >
          <p id="wh-confirm-msg">
            {confirm.kind === 'warehouse'
              ? t('warehouses.confirmArchiveWarehouse', { code: confirm.label })
              : t('warehouses.confirmArchiveLocation', { code: confirm.label })}
          </p>
          {writeError && <ErrorBanner error={writeError} message={localError(writeError)} />}
        </Modal>
      )}
    </div>
  );
}
