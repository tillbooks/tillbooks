/**
 * H08, Fixed Assets -> Maintenance (`/asset-maintenance`): the append-oriented service log of a fixed
 * asset. An asset picker scopes the log (there is no tabbed AssetDetail host in the shipped Studio, the
 * H05 `AssetLocations` precedent, see the spec Reconciliation note); a dense chronological table shows
 * date, type, title, performer, cost and status, with a running total of completed costs; a right-hand
 * `MaintenanceLogDrawer` creates and edits entries.
 *
 * NON-POSTING: nothing here touches the ledger. The captured cost is descriptive TCO metadata (H09).
 * Cost fields are entered in major units (CHF) and converted to integer Rappen on save. An entry is
 * created `completed`, may be descriptively corrected while recent (`log_locked` past the soft-edit
 * window), and soft-cancelled (never hard-deleted). Status is glyph + label, never colour alone (WCAG
 * 2.2 AA). No new colour token (design-canon).
 *
 * THE PERMISSION GATE HERE IS A CONVENIENCE (the standing Studio rule): `whoami` is the one source, it
 * fails open, and the engine is the real gate. Write controls disable behind `manage_master_data`; a
 * click that slips through still surfaces the engine's own `permission_denied`.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';

import { useClient } from '../../lib/client-context';
import { isErr, type Err } from '../../lib/client';
import { CAP, useCapabilities } from '../../lib/capabilities';
import { useWorkspaceId } from '../../app/workspace';
import { formatMoney, useT } from '../../i18n';
import { EmptyState, ErrorBanner, NoWorkspaceState, PermissionDenied, Skeleton } from '../../components/states';
import { SurfaceHeader } from '../../components/SurfaceHeader';
import { SurfaceHelp } from '../../components/SurfaceHelp';
import { DataTable, type DataTableColumn } from '../../components/DataTable';
import { Modal } from '../../components/Modal';
import { MaintenanceLogDrawer, type MaintenanceDraft, EMPTY_MAINTENANCE_DRAFT } from './MaintenanceLogDrawer';
import './FixedAssets.css';

/** A fresh key per write, so a retry after a transport failure is a retry and not a second write. */
const newKey = () => crypto.randomUUID();

/** The cancel confirm is a consequential question: held as a value so the role travels to the shared
 * Modal as a prop, never as a literal attribute the modal-role guard would read on a component. */
const ALERT_DIALOG = 'alertdialog' as const;

/** The registered maintenance types, mirrored from the engine's §H-ENUM (spec §4). */
export const MAINTENANCE_TYPES = ['corrective', 'preventive', 'inspection', 'calibration', 'upgrade', 'other'] as const;
export type MaintenanceType = (typeof MAINTENANCE_TYPES)[number];

export interface AssetOption {
  id: string;
  number: string;
  name: string;
  status: string;
}

export interface MaintenanceLog {
  id: string;
  assetId: string;
  logDate: string;
  maintenanceType: string;
  title: string;
  description: string | null;
  performedByUserId: string | null;
  externalParty: string | null;
  costRappen: number | null;
  partsCostRappen: number | null;
  labourCostRappen: number | null;
  externalReference: string | null;
  notes: string | null;
  status: string;
  cancelReason: string | null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}
function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function parseAssets(body: unknown): AssetOption[] | null {
  const rows = (body as { assets?: unknown })?.assets;
  if (!Array.isArray(rows)) return null;
  const out: AssetOption[] = [];
  for (const raw of rows) {
    if (raw === null || typeof raw !== 'object') return null;
    const a = raw as Record<string, unknown>;
    if (typeof a.id !== 'string') return null;
    out.push({ id: a.id, number: str(a.number) ?? '', name: str(a.name) ?? '', status: str(a.status) ?? 'draft' });
  }
  return out;
}

function parseLogs(body: unknown): { items: MaintenanceLog[]; totalCostRappen: number } | null {
  const b = body as { items?: unknown; totalCostRappen?: unknown };
  if (!Array.isArray(b?.items)) return null;
  const out: MaintenanceLog[] = [];
  for (const raw of b.items) {
    if (raw === null || typeof raw !== 'object') return null;
    const l = raw as Record<string, unknown>;
    if (typeof l.id !== 'string' || typeof l.assetId !== 'string') return null;
    out.push({
      id: l.id,
      assetId: l.assetId,
      logDate: str(l.logDate) ?? '',
      maintenanceType: str(l.maintenanceType) ?? 'other',
      title: str(l.title) ?? '',
      description: str(l.description),
      performedByUserId: str(l.performedByUserId),
      externalParty: str(l.externalParty),
      costRappen: num(l.costRappen),
      partsCostRappen: num(l.partsCostRappen),
      labourCostRappen: num(l.labourCostRappen),
      externalReference: str(l.externalReference),
      notes: str(l.notes),
      status: str(l.status) ?? 'completed',
      cancelReason: str(l.cancelReason),
    });
  }
  return { items: out, totalCostRappen: num(b.totalCostRappen) ?? 0 };
}

// K-71: format through the shared `formatMoney` so the CHF prefix and de-CH thousands grouping are
// applied once, in one place (the sibling asset surfaces all do the same). A null cost (an entry
// logged without a figure) stays a neutral dash.
function rappenToChf(rappen: number | null): string {
  if (rappen === null) return '-';
  return formatMoney(rappen, 'CHF');
}

function draftFrom(l: MaintenanceLog): MaintenanceDraft {
  return {
    logDate: l.logDate,
    maintenanceType: l.maintenanceType,
    title: l.title,
    description: l.description ?? '',
    externalParty: l.externalParty ?? '',
    costChf: l.costRappen === null ? '' : (l.costRappen / 100).toFixed(2),
    partsChf: l.partsCostRappen === null ? '' : (l.partsCostRappen / 100).toFixed(2),
    labourChf: l.labourCostRappen === null ? '' : (l.labourCostRappen / 100).toFixed(2),
    externalReference: l.externalReference ?? '',
    notes: l.notes ?? '',
  };
}

export function AssetMaintenance() {
  const t = useT();
  const client = useClient();
  const workspaceId = useWorkspaceId();
  const { can } = useCapabilities();

  const [assets, setAssets] = useState<AssetOption[]>([]);
  const [assetId, setAssetId] = useState<string>('');
  const [logs, setLogs] = useState<MaintenanceLog[]>([]);
  const [totalCostRappen, setTotalCostRappen] = useState(0);

  const [typeFilter, setTypeFilter] = useState<string>('');
  const [includeCancelled, setIncludeCancelled] = useState(false);
  const [hasCostOnly, setHasCostOnly] = useState(false);

  const [assetsLoading, setAssetsLoading] = useState(true);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [denied, setDenied] = useState(false);
  const [writeError, setWriteError] = useState<Err | null>(null);
  const [drawer, setDrawer] = useState<'closed' | 'create' | string>('closed');
  const [draft, setDraft] = useState<MaintenanceDraft>(EMPTY_MAINTENANCE_DRAFT);
  const [cancelling, setCancelling] = useState<MaintenanceLog | null>(null);
  const [cancelReason, setCancelReason] = useState('');

  const canWrite = can(CAP.manageMasterData);
  const selectedAsset = useMemo(() => assets.find((a) => a.id === assetId) ?? null, [assets, assetId]);

  const loadAssets = useCallback(async () => {
    if (workspaceId === null) {
      setAssetsLoading(false);
      return;
    }
    setAssetsLoading(true);
    setFailed(false);
    setDenied(false);
    const listed = await client.call('asset_list', { workspaceId, includeArchived: true });
    if (isErr(listed.body)) {
      if (listed.body.error === 'permission_denied' || listed.status === 403) setDenied(true);
      else setFailed(true);
      setAssetsLoading(false);
      return;
    }
    const parsed = parseAssets(listed.body);
    if (parsed === null) {
      setFailed(true);
      setAssetsLoading(false);
      return;
    }
    setAssets(parsed);
    // Preselect the first asset so the log is one click from a fresh landing.
    setAssetId((prev) => (prev !== '' ? prev : parsed[0]?.id ?? ''));
    setAssetsLoading(false);
  }, [client, workspaceId]);

  const loadLogs = useCallback(async () => {
    if (workspaceId === null || assetId === '') {
      setLogs([]);
      setTotalCostRappen(0);
      return;
    }
    setLoading(true);
    setFailed(false);
    const input: Record<string, unknown> = {
      workspaceId,
      assetId,
      status: includeCancelled ? 'any' : 'completed',
    };
    if (typeFilter !== '') input.maintenanceType = typeFilter;
    if (hasCostOnly) input.hasCost = true;
    const listed = await client.call('asset_maintenance_log_list', input);
    if (isErr(listed.body)) {
      setFailed(true);
      setLoading(false);
      return;
    }
    const parsed = parseLogs(listed.body);
    if (parsed === null) {
      setFailed(true);
      setLoading(false);
      return;
    }
    setLogs(parsed.items);
    setTotalCostRappen(parsed.totalCostRappen);
    setLoading(false);
  }, [client, workspaceId, assetId, includeCancelled, typeFilter, hasCostOnly]);

  useEffect(() => {
    void loadAssets();
  }, [loadAssets]);
  useEffect(() => {
    void loadLogs();
  }, [loadLogs]);

  const write = useCallback(
    async (action: string, input: Record<string, unknown>): Promise<boolean> => {
      if (workspaceId === null) return false;
      setWriteError(null);
      const response = await client.call(action, { workspaceId, ...input });
      if (isErr(response.body)) {
        setWriteError(response.body);
        return false;
      }
      await loadLogs();
      return true;
    },
    [client, workspaceId, loadLogs],
  );

  const openCreate = () => {
    setWriteError(null);
    setDraft({ ...EMPTY_MAINTENANCE_DRAFT, logDate: new Date().toISOString().slice(0, 10) });
    setDrawer('create');
  };
  const openEdit = (l: MaintenanceLog) => {
    setWriteError(null);
    setDraft(draftFrom(l));
    setDrawer(l.id);
  };
  const closeDrawer = () => setDrawer('closed');

  /** Convert a CHF major-unit string to integer Rappen, or undefined when the field is blank. */
  const chfToRappen = (raw: string): number | undefined => {
    const trimmed = raw.trim();
    if (trimmed === '') return undefined;
    const n = Number(trimmed);
    if (!Number.isFinite(n)) return undefined;
    return Math.round(n * 100);
  };

  const submit = useCallback(async () => {
    const costRappen = chfToRappen(draft.costChf);
    const partsCostRappen = chfToRappen(draft.partsChf);
    const labourCostRappen = chfToRappen(draft.labourChf);
    const shared: Record<string, unknown> = {
      title: draft.title.trim(),
      description: draft.description.trim() === '' ? undefined : draft.description.trim(),
      externalReference: draft.externalReference.trim() === '' ? undefined : draft.externalReference.trim(),
      notes: draft.notes.trim() === '' ? undefined : draft.notes.trim(),
      ...(costRappen !== undefined ? { costRappen } : {}),
      ...(partsCostRappen !== undefined ? { partsCostRappen } : {}),
      ...(labourCostRappen !== undefined ? { labourCostRappen } : {}),
    };
    let ok = false;
    if (drawer === 'create') {
      ok = await write('asset_maintenance_log_create', {
        assetId,
        logDate: draft.logDate,
        maintenanceType: draft.maintenanceType,
        externalParty: draft.externalParty.trim() === '' ? undefined : draft.externalParty.trim(),
        ...shared,
        idempotencyKey: newKey(),
      });
    } else {
      ok = await write('asset_maintenance_log_update', {
        id: drawer,
        patch: {
          title: shared.title,
          description: draft.description.trim(),
          externalReference: draft.externalReference.trim(),
          notes: draft.notes.trim(),
          ...(costRappen !== undefined ? { costRappen } : {}),
          ...(partsCostRappen !== undefined ? { partsCostRappen } : {}),
          ...(labourCostRappen !== undefined ? { labourCostRappen } : {}),
        },
        idempotencyKey: newKey(),
      });
    }
    if (ok) closeDrawer();
  }, [write, draft, drawer, assetId]);

  const confirmCancel = useCallback(async () => {
    if (cancelling === null) return;
    const ok = await write('asset_maintenance_log_cancel', {
      id: cancelling.id,
      reason: cancelReason.trim(),
      idempotencyKey: newKey(),
    });
    if (ok) {
      setCancelling(null);
      setCancelReason('');
    }
  }, [write, cancelling, cancelReason]);

  const logColumns: DataTableColumn<MaintenanceLog>[] = [
    { key: 'date', header: t('assets.maintenance.col.date'), render: (l) => <span className="fa-code">{l.logDate}</span> },
    {
      key: 'type',
      header: t('assets.maintenance.col.type'),
      render: (l) => <span className="fa-badge">{t(`assets.maintenance.type.${l.maintenanceType}`)}</span>,
    },
    { key: 'title', header: t('assets.maintenance.col.title'), render: (l) => l.title },
    {
      key: 'performedBy',
      header: t('assets.maintenance.col.performedBy'),
      render: (l) => l.externalParty ?? l.performedByUserId ?? '-',
    },
    { key: 'cost', header: t('assets.maintenance.col.cost'), numeric: true, render: (l) => rappenToChf(l.costRappen) },
    {
      key: 'status',
      header: t('assets.maintenance.col.status'),
      render: (l) => (
        <span className={`fa-badge ${l.status === 'completed' ? 'fa-badge-active' : 'fa-badge-archived'}`}>
          {l.status === 'completed'
            ? t('assets.maintenance.status.completed')
            : t('assets.maintenance.status.cancelled')}
        </span>
      ),
    },
    {
      key: 'actions',
      header: t('assets.maintenance.col.actions'),
      headerHidden: true,
      align: 'end',
      render: (l) =>
        l.status === 'completed' ? (
          <div className="fa-row-actions">
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => openEdit(l)} disabled={!canWrite}>
              {t('assets.maintenance.edit')}
            </button>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => {
                setWriteError(null);
                setCancelReason('');
                setCancelling(l);
              }}
              disabled={!canWrite}
            >
              {t('assets.maintenance.cancel')}
            </button>
          </div>
        ) : null,
    },
  ];

  if (workspaceId === null) return <NoWorkspaceState body={t('assets.maintenance.noWorkspace')} />;
  if (denied) return <PermissionDenied title={t('assets.maintenance.title')} />;

  return (
    <div className="fa">
      <SurfaceHeader
        title={t('assets.maintenance.title')}
        help={<SurfaceHelp surface="FixedAssets" />}
        actions={
          <button
            type="button"
            className="btn btn--primary"
            onClick={openCreate}
            disabled={!canWrite || assetId === ''}
          >
            {t('assets.maintenance.new')}
          </button>
        }
      />

      {failed && <ErrorBanner message={t('assets.maintenance.error.transport')} onRetry={() => void loadLogs()} />}

      {assetsLoading ? (
        <Skeleton rows={4} />
      ) : assets.length === 0 ? (
        <EmptyState title={t('assets.maintenance.noAssets.title')} hint={t('assets.maintenance.noAssets.hint')} />
      ) : (
        <>
          <div className="fa-filters">
            <label className="fa-field-inline">
              <span>{t('assets.maintenance.asset')}</span>
              <select value={assetId} onChange={(e) => setAssetId(e.target.value)} aria-label={t('assets.maintenance.asset')}>
                {assets.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.number} {a.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="fa-field-inline">
              <span>{t('assets.maintenance.filter.type')}</span>
              <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} aria-label={t('assets.maintenance.filter.type')}>
                <option value="">{t('assets.maintenance.filter.allTypes')}</option>
                {MAINTENANCE_TYPES.map((ty) => (
                  <option key={ty} value={ty}>
                    {t(`assets.maintenance.type.${ty}`)}
                  </option>
                ))}
              </select>
            </label>
            <label className="fa-toggle">
              <input type="checkbox" checked={hasCostOnly} onChange={(e) => setHasCostOnly(e.target.checked)} />
              {t('assets.maintenance.filter.hasCost')}
            </label>
            <label className="fa-toggle">
              <input type="checkbox" checked={includeCancelled} onChange={(e) => setIncludeCancelled(e.target.checked)} />
              {t('assets.maintenance.filter.includeCancelled')}
            </label>
          </div>

          {selectedAsset !== null && selectedAsset.status === 'archived' && (
            <p className="fa-note">{t('assets.maintenance.archivedNote')}</p>
          )}

          <DataTable
            columns={logColumns}
            rows={logs}
            rowKey={(l) => l.id}
            caption={t('assets.maintenance.title')}
            loading={loading}
            rowClassName={(l) => (l.status === 'cancelled' ? 'fa-row-archived' : undefined)}
            footer={
              logs.length > 0
                ? [
                    { key: 'date', content: t('assets.maintenance.totalCost') },
                    { key: 'cost', content: <span className="fa-total">{rappenToChf(totalCostRappen)}</span> },
                  ]
                : undefined
            }
            emptyState={
              <EmptyState
                title={t('assets.maintenance.empty.title')}
                hint={t('assets.maintenance.empty.hint')}
                action={canWrite ? { label: t('assets.maintenance.empty.cta'), onClick: openCreate } : undefined}
              />
            }
          />
        </>
      )}

      {drawer !== 'closed' && (
        <MaintenanceLogDrawer
          mode={drawer === 'create' ? 'create' : 'edit'}
          draft={draft}
          setDraft={setDraft}
          writeError={writeError}
          canWrite={canWrite}
          onSubmit={() => void submit()}
          onClose={closeDrawer}
        />
      )}

      <Modal
        open={cancelling !== null}
        role={ALERT_DIALOG}
        onClose={() => setCancelling(null)}
        title={t('assets.maintenance.cancel')}
        closeLabel={t('assets.common.close')}
        footer={
          <>
            <button type="button" className="btn btn--ghost" onClick={() => setCancelling(null)}>
              {t('assets.maintenance.back')}
            </button>
            <button
              type="button"
              className="btn btn--danger"
              onClick={() => void confirmCancel()}
              disabled={cancelReason.trim() === ''}
            >
              {t('assets.maintenance.cancel')}
            </button>
          </>
        }
      >
        {cancelling !== null && <p>{t('assets.maintenance.confirmCancel', { title: cancelling.title })}</p>}
        <div className="fa-field">
          <label htmlFor="fa-mnt-cancel-reason">{t('assets.maintenance.field.cancelReason')}</label>
          <input id="fa-mnt-cancel-reason" value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} />
        </div>
        {writeError && <ErrorBanner error={writeError} />}
      </Modal>
    </div>
  );
}

export default AssetMaintenance;
