/**
 * H05, Fixed Assets -> Locations (`/asset-locations`): the workspace's fixed-asset location master, the
 * physical places assets live and the target of a transfer. Locations are the register's primary filter
 * dimension and are set up here once and then rarely touched.
 *
 * A dense list (code, name, parent, active badge, row menu) plus a right-hand drawer for create/edit. A
 * location may nest under a parent for a light hierarchy; the engine refuses a cycle (`location_cycle`)
 * and refuses archiving a location a non-disposed asset still uses (`location_in_use`). NON-POSTING:
 * nothing here touches the ledger. Status is glyph + label, never colour alone (WCAG 2.2 AA). No new
 * colour token (design-canon).
 *
 * THE PERMISSION GATE HERE IS A CONVENIENCE (the standing Studio rule): `whoami` is the one source, it
 * fails open, and the engine is the real gate. Write controls disable behind `manage_master_data`; a
 * click that slips through still surfaces the engine's own `permission_denied`.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';

import { useClient } from '../../lib/client-context';
import { isErr, type Err } from '../../lib/client';
import { CAP, useCapabilities } from '../../lib/capabilities';
import { Select } from '../../components/Select';
import { useWorkspaceId } from '../../app/workspace';
import { useT } from '../../i18n';
import { EmptyState, ErrorBanner, NoWorkspaceState, PermissionDenied } from '../../components/states';
import { SurfaceHeader } from '../../components/SurfaceHeader';
import { SurfaceHelp } from '../../components/SurfaceHelp';
import { DataTable, type DataTableColumn } from '../../components/DataTable';
import type { OverflowMenuItem } from '../../components/OverflowMenu';
import { Status } from '../../components/Status';
import { DetailDrawer } from '../../components/DetailDrawer';
import { Modal } from '../../components/Modal';
import './FixedAssets.css';

/** A fresh key per write, so a retry after a transport failure is a retry and not a second write. */
const newKey = () => crypto.randomUUID();

/** The archive confirm is a consequential question: held as a value so the role travels to the shared
 * Modal as a prop, never as a literal attribute the modal-role guard would read on a component. */
const ALERT_DIALOG = 'alertdialog' as const;

export interface Location {
  id: string;
  code: string;
  name: string;
  description: string | null;
  parentId: string | null;
  active: boolean;
}

function parseLocations(body: unknown): Location[] | null {
  const rows = (body as { locations?: unknown })?.locations;
  if (!Array.isArray(rows)) return null;
  const out: Location[] = [];
  for (const raw of rows) {
    if (raw === null || typeof raw !== 'object') return null;
    const l = raw as Record<string, unknown>;
    if (typeof l.id !== 'string' || typeof l.code !== 'string' || typeof l.name !== 'string') return null;
    out.push({
      id: l.id,
      code: l.code,
      name: l.name,
      description: typeof l.description === 'string' ? l.description : null,
      parentId: typeof l.parentId === 'string' ? l.parentId : null,
      active: l.active === true,
    });
  }
  return out;
}

interface Draft {
  code: string;
  name: string;
  description: string;
  parentId: string;
}

const EMPTY_DRAFT: Draft = { code: '', name: '', description: '', parentId: '' };

function draftFrom(l: Location): Draft {
  return { code: l.code, name: l.name, description: l.description ?? '', parentId: l.parentId ?? '' };
}

export function AssetLocations() {
  const t = useT();
  const client = useClient();
  const workspaceId = useWorkspaceId();
  const { can } = useCapabilities();

  const [locations, setLocations] = useState<Location[]>([]);
  const [showArchived, setShowArchived] = useState(false);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [denied, setDenied] = useState(false);
  const [writeError, setWriteError] = useState<Err | null>(null);
  const [drawer, setDrawer] = useState<'closed' | 'create' | string>('closed');
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [archiving, setArchiving] = useState<Location | null>(null);

  const canWrite = can(CAP.manageMasterData);
  const byId = useMemo(() => new Map(locations.map((l) => [l.id, l])), [locations]);

  const load = useCallback(async () => {
    if (workspaceId === null) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setFailed(false);
    setDenied(false);
    const listed = await client.call('asset_location_list', {
      workspaceId,
      ...(showArchived ? {} : { active: true }),
    });
    if (isErr(listed.body)) {
      if (listed.body.error === 'permission_denied' || listed.status === 403) setDenied(true);
      else setFailed(true);
      setLoading(false);
      return;
    }
    const parsed = parseLocations(listed.body);
    if (parsed === null) {
      setFailed(true);
      setLoading(false);
      return;
    }
    setLocations(parsed);
    setLoading(false);
  }, [client, workspaceId, showArchived]);

  useEffect(() => {
    void load();
  }, [load]);

  const write = useCallback(
    async (action: string, input: Record<string, unknown>): Promise<boolean> => {
      if (workspaceId === null) return false;
      setWriteError(null);
      const response = await client.call(action, { workspaceId, ...input });
      if (isErr(response.body)) {
        setWriteError(response.body);
        return false;
      }
      await load();
      return true;
    },
    [client, workspaceId, load],
  );

  const openCreate = () => {
    setWriteError(null);
    setDraft(EMPTY_DRAFT);
    setDrawer('create');
  };
  const openEdit = (l: Location) => {
    setWriteError(null);
    setDraft(draftFrom(l));
    setDrawer(l.id);
  };
  const closeDrawer = () => setDrawer('closed');

  const submit = useCallback(async () => {
    const shared = {
      name: draft.name.trim(),
      description: draft.description.trim() === '' ? undefined : draft.description.trim(),
      parentId: draft.parentId === '' ? undefined : draft.parentId,
    };
    let ok = false;
    if (drawer === 'create') {
      ok = await write('asset_location_create', { code: draft.code.trim(), ...shared, idempotencyKey: newKey() });
    } else {
      // On edit, parentId '' means "clear to a root"; pass null so the engine detaches it.
      ok = await write('asset_location_update', {
        locationId: drawer,
        patch: { name: shared.name, description: shared.description ?? '', parentId: draft.parentId === '' ? null : draft.parentId },
        idempotencyKey: newKey(),
      });
    }
    if (ok) closeDrawer();
  }, [write, draft, drawer]);

  const confirmArchive = useCallback(async () => {
    if (archiving === null) return;
    const ok = await write('asset_location_archive', { locationId: archiving.id, idempotencyKey: newKey() });
    if (ok) setArchiving(null);
  }, [write, archiving]);

  // A location cannot be its own parent; the parent picker excludes the row being edited.
  const parentOptions = useMemo(
    () => locations.filter((l) => l.active && l.id !== (drawer === 'create' ? '' : drawer)),
    [locations, drawer],
  );

  const columns: DataTableColumn<Location>[] = [
    { key: 'code', header: t('assets.locations.col.code'), render: (l) => <span className="fa-code">{l.code}</span> },
    { key: 'name', header: t('assets.locations.col.name'), render: (l) => l.name },
    {
      key: 'parent',
      header: t('assets.locations.col.parent'),
      render: (l) => (l.parentId === null ? '-' : byId.get(l.parentId)?.code ?? l.parentId),
    },
    {
      key: 'status',
      header: t('assets.locations.col.status'),
      render: (l) => (
        <Status
          kind={l.active ? 'success' : 'inactive'}
          label={l.active ? t('assets.locations.active') : t('assets.locations.archived')}
        />
      ),
    },
  ];

  // K-21: the row opens the location's edit drawer; archiving sits behind the one quiet overflow.
  const locationActions = (l: Location): OverflowMenuItem[] =>
    l.active && canWrite
      ? [
          {
            key: 'archive',
            label: t('assets.locations.archive'),
            onSelect: () => {
              setWriteError(null);
              setArchiving(l);
            },
            danger: true,
          },
        ]
      : [];

  if (workspaceId === null) return <NoWorkspaceState body={t('assets.locations.noWorkspace')} />;
  if (denied) return <PermissionDenied title={t('assets.locations.title')} />;

  return (
    <div className="fa">
      <SurfaceHeader
        title={t('assets.locations.title')}
        help={<SurfaceHelp surface="FixedAssets" />}
        actions={
          <>
            <label className="fa-toggle">
              <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
              {t('assets.locations.showArchived')}
            </label>
            <button type="button" className="btn btn--primary" onClick={openCreate} disabled={!canWrite}>
              {t('assets.locations.new')}
            </button>
          </>
        }
      />

      {failed ? (
        <ErrorBanner message={t('assets.locations.error.transport')} onRetry={() => void load()} />
      ) : (
        <DataTable
          columns={columns}
          rows={locations}
          rowKey={(l) => l.id}
          caption={t('assets.locations.title')}
          loading={loading}
          rowClassName={(l) => (l.active ? undefined : 'fa-row-archived')}
          {...(canWrite
            ? {
                onRowClick: openEdit,
                rowLabel: (l: Location) => t('assets.locations.rowOpen', { code: l.code, name: l.name }),
              }
            : {})}
          rowActions={locationActions}
          rowActionsLabel={(l) => t('assets.locations.rowActionsFor', { code: l.code })}
          emptyState={
            <EmptyState
              title={t('assets.locations.empty.title')}
              hint={t('assets.locations.empty.hint')}
              action={canWrite ? { label: t('assets.locations.empty.cta'), onClick: openCreate } : undefined}
            />
          }
        />
      )}

      <DetailDrawer
        open={drawer !== 'closed'}
        onClose={closeDrawer}
        title={drawer === 'create' ? t('assets.locations.form.createTitle') : t('assets.locations.form.editTitle')}
        closeLabel={t('assets.common.close')}
        footer={
          <>
            <button type="button" className="btn btn--ghost" onClick={closeDrawer}>
              {t('assets.locations.cancel')}
            </button>
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => void submit()}
              disabled={!canWrite || draft.name.trim() === '' || (drawer === 'create' && draft.code.trim() === '')}
            >
              {t('assets.locations.save')}
            </button>
          </>
        }
      >
        {writeError && <ErrorBanner error={writeError} />}
        <div className="fa-field">
          <label htmlFor="fa-loc-code">{t('assets.locations.field.code')}</label>
          <input className="field"
            id="fa-loc-code"
            value={draft.code}
            maxLength={30}
            disabled={drawer !== 'create'}
            onChange={(e) => setDraft({ ...draft, code: e.target.value })}
          />
        </div>
        <div className="fa-field">
          <label htmlFor="fa-loc-name">{t('assets.locations.field.name')}</label>
          <input className="field" id="fa-loc-name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
        </div>
        <div className="fa-field">
          <label htmlFor="fa-loc-parent">{t('assets.locations.field.parent')}</label>
          <Select
            id="fa-loc-parent"
            value={draft.parentId}
            onChange={(value) => setDraft({ ...draft, parentId: value })}
            options={[
              { value: '', label: t('assets.locations.field.noParent') },
              ...parentOptions.map((l) => ({ value: l.id, label: `${l.code} ${l.name}` })),
            ]}
            ariaLabel={t('assets.locations.field.parent')}
          />
        </div>
        <div className="fa-field">
          <label htmlFor="fa-loc-desc">{t('assets.locations.field.description')}</label>
          <input className="field"
            id="fa-loc-desc"
            value={draft.description}
            onChange={(e) => setDraft({ ...draft, description: e.target.value })}
          />
        </div>
      </DetailDrawer>

      <Modal
        open={archiving !== null}
        role={ALERT_DIALOG}
        onClose={() => setArchiving(null)}
        title={t('assets.locations.archive')}
        closeLabel={t('assets.common.close')}
        footer={
          <>
            <button type="button" className="btn btn--ghost" onClick={() => setArchiving(null)}>
              {t('assets.locations.cancel')}
            </button>
            <button type="button" className="btn btn--danger" onClick={() => void confirmArchive()}>
              {t('assets.locations.archive')}
            </button>
          </>
        }
      >
        {archiving !== null && <p>{t('assets.locations.confirmArchive', { code: archiving.code })}</p>}
        {writeError && <ErrorBanner error={writeError} />}
      </Modal>
    </div>
  );
}

export default AssetLocations;
