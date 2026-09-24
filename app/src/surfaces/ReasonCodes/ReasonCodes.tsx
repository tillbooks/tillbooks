/**
 * J05, Inventory -> Reason Codes / Korrekturgründe (`/inventory-reason-codes`): the master-data surface
 * over the adjustment reason catalog. The list shows every code (code, name, category, requires-note
 * marker, active state); the drawer creates a new code or edits an existing one, and an active code can
 * be archived (soft: it disappears from adjustment pickers but stays queryable for history).
 *
 * State is shown as glyph + label, never colour alone (WCAG 2.2 AA); no new colour token (design-canon).
 *
 * THE PERMISSION GATE HERE IS A CONVENIENCE (the standing Studio rule): capabilities fail open and the
 * engine is the real gate. Write controls disable behind `manage_master_data`; a click that slips
 * through still surfaces the engine's own `permission_denied`.
 *
 * ## BUILT ON THE SHARED UI PRIMITIVES (D118 B2 / D46 UX pass)
 *
 * The catalog list is the shared `DataTable` (frame overflow, sticky header, density and the five
 * states in one place); an archived row dims through the `rowClassName` hook while its badge still
 * carries the state. The page header and the show-archived toggle are the shared `SurfaceHeader`, and
 * the create/edit form is the shared `DetailDrawer`, which adds the focus trap, Escape and scrim the
 * bespoke panel lacked. The per-surface CSS that duplicated the list table, the header, the drawer
 * chrome and the button set is gone; what remains is genuinely ReasonCodes-specific: the state and
 * category badges, the show-archived toggle and the drawer form fields.
 *
 * No `Provenance` (C3): the reason read model carries no author/timestamp to show. No `ConsequenceLine`
 * (C4): the reason verbs carry no engine consequence sentence to render.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';

import { useClient } from '../../lib/client-context';
import { isErr, type Err } from '../../lib/client';
import { CAP, useCapabilities } from '../../lib/capabilities';
import { useWorkspaceId } from '../../app/workspace';
import { useT } from '../../i18n';
import { EmptyState, ErrorBanner, NoWorkspaceState, PermissionDenied } from '../../components/states';
import { DataTable, type DataTableColumn } from '../../components/DataTable';
import type { OverflowMenuItem } from '../../components/OverflowMenu';
import { Status } from '../../components/Status';
import { Select } from '../../components/Select';
import { SurfaceHeader } from '../../components/SurfaceHeader';
import { DetailDrawer } from '../../components/DetailDrawer';
import { SurfaceHelp } from '../../components/SurfaceHelp';
import './ReasonCodes.css';

/** The §H-ENUM reason categories, mirrored from `src/core/inventory/reason.ts`. */
const CATEGORIES = [
  'shrinkage',
  'damage',
  'found',
  'count_variance',
  'obsolescence',
  'theft',
  'quality',
  'correction',
  'reversal',
  'system',
  'other',
] as const;
type Category = (typeof CATEGORIES)[number];

/** The J05 reason rejection codes with a surface-scoped message. Others fall through to the global map. */
const REASON_ERROR_CODES = new Set(['duplicate_code']);

const newKey = (): string => crypto.randomUUID();

interface Reason {
  id: string;
  code: string;
  name: string;
  description: string | null;
  category: string;
  requiresNote: boolean;
  defaultForStocktake: boolean;
  isActive: boolean;
}

function parseReason(raw: unknown): Reason | null {
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string') return null;
  return {
    id: r.id,
    code: String(r.code ?? ''),
    name: String(r.name ?? ''),
    description: typeof r.description === 'string' ? r.description : null,
    category: String(r.category ?? 'other'),
    requiresNote: r.requiresNote === true,
    defaultForStocktake: r.defaultForStocktake === true,
    isActive: r.isActive !== false,
  };
}

interface Draft {
  id: string | null;
  code: string;
  name: string;
  category: Category;
  requiresNote: boolean;
  defaultForStocktake: boolean;
  description: string;
}
const emptyDraft = (): Draft => ({
  id: null,
  code: '',
  name: '',
  category: 'shrinkage',
  requiresNote: false,
  defaultForStocktake: false,
  description: '',
});

export function ReasonCodes() {
  const t = useT();
  const client = useClient();
  const workspaceId = useWorkspaceId();
  const { can } = useCapabilities();
  const canWrite = can(CAP.manageMasterData);

  const [reasons, setReasons] = useState<Reason[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [denied, setDenied] = useState(false);
  const [showArchived, setShowArchived] = useState(false);

  const [drawer, setDrawer] = useState(false);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [writeError, setWriteError] = useState<Err | null>(null);

  const localError = useCallback(
    (e: Err | null): string | undefined =>
      e !== null && REASON_ERROR_CODES.has(e.error) ? t(`reasonCodes.errors.${e.error}`) : undefined,
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
    const res = await client.call('inventory_reason_list', { workspaceId, activeOnly: !showArchived });
    if (isErr(res.body)) {
      if (res.body.error === 'permission_denied' || res.status === 403) setDenied(true);
      else setFailed(true);
      setLoading(false);
      return;
    }
    const rows = (res.body as { reasons?: unknown }).reasons;
    setReasons(Array.isArray(rows) ? rows.map(parseReason).filter((r): r is Reason => r !== null) : []);
    setLoading(false);
  }, [client, workspaceId, showArchived]);

  useEffect(() => {
    void load();
  }, [load]);

  const openCreate = useCallback(() => {
    setWriteError(null);
    setDraft(emptyDraft());
    setDrawer(true);
  }, []);

  const openEdit = useCallback((r: Reason) => {
    setWriteError(null);
    setDraft({
      id: r.id,
      code: r.code,
      name: r.name,
      category: (CATEGORIES as readonly string[]).includes(r.category) ? (r.category as Category) : 'other',
      requiresNote: r.requiresNote,
      defaultForStocktake: r.defaultForStocktake,
      description: r.description ?? '',
    });
    setDrawer(true);
  }, []);

  const submit = useCallback(async () => {
    if (workspaceId === null) return;
    setWriteError(null);
    const description = draft.description.trim() === '' ? undefined : draft.description.trim();
    const res =
      draft.id === null
        ? await client.call('inventory_reason_create', {
            workspaceId,
            code: draft.code.trim(),
            name: draft.name.trim(),
            category: draft.category,
            requiresNote: draft.requiresNote,
            defaultForStocktake: draft.defaultForStocktake,
            description,
            idempotencyKey: newKey(),
          })
        : await client.call('inventory_reason_update', {
            workspaceId,
            id: draft.id,
            name: draft.name.trim(),
            description: description ?? null,
            requiresNote: draft.requiresNote,
            defaultForStocktake: draft.defaultForStocktake,
            idempotencyKey: newKey(),
          });
    if (isErr(res.body)) {
      setWriteError(res.body);
      return;
    }
    setDrawer(false);
    await load();
  }, [client, workspaceId, draft, load]);

  const archive = useCallback(
    async (r: Reason) => {
      if (workspaceId === null) return;
      setWriteError(null);
      const res = await client.call('inventory_reason_archive', { workspaceId, id: r.id, idempotencyKey: newKey() });
      if (isErr(res.body)) {
        setWriteError(res.body);
        return;
      }
      await load();
    },
    [client, workspaceId, load],
  );

  if (workspaceId === null) return <NoWorkspaceState body={t('reasonCodes.noWorkspace')} />;
  if (denied) return <PermissionDenied title={t('reasonCodes.title')} />;

  // The show-archived toggle rides the SurfaceHeader actions beside the primary create action; there
  // is no search row and inventing one is out of scope (D118 B2), so no FilterBar here.
  const headerActions = (
    <>
      <label className="rc-check">
        <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
        <span>{t('reasonCodes.showArchived')}</span>
      </label>
      <button type="button" className="btn btn--primary" disabled={!canWrite} onClick={openCreate}>
        {t('reasonCodes.new')}
      </button>
    </>
  );

  // The list columns: text left, the category as plain text, the state as the shared Status (K-22).
  // An archived row dims via the rowClassName hook; its Status word still carries the state, so colour
  // is never the only signal. The row opens the editor; Archivieren sits behind the row overflow (K-21).
  const columns: DataTableColumn<Reason>[] = [
    { key: 'code', header: t('reasonCodes.col.code'), render: (r) => <span className="rc-code">{r.code}</span> },
    { key: 'name', header: t('reasonCodes.col.name'), render: (r) => r.name },
    {
      key: 'category',
      header: t('reasonCodes.col.category'),
      render: (r) => t(`reasonCodes.category.${r.category}`),
    },
    { key: 'note', header: t('reasonCodes.col.note'), render: (r) => (r.requiresNote ? t('reasonCodes.noteRequiredMark') : '') },
    {
      key: 'state',
      header: t('reasonCodes.col.state'),
      render: (r) => (
        <Status
          kind={r.isActive ? 'success' : 'inactive'}
          label={t(r.isActive ? 'reasonCodes.state.active' : 'reasonCodes.state.archived')}
        />
      ),
    },
  ];

  // K-21: the row's other verbs behind ONE overflow; archiving is the last item and reads as danger.
  const rowActions = (r: Reason): OverflowMenuItem[] =>
    canWrite
      ? [
          { key: 'edit', label: t('reasonCodes.edit'), onSelect: () => openEdit(r) },
          ...(r.isActive
            ? [{ key: 'archive', label: t('reasonCodes.archive'), danger: true, onSelect: () => void archive(r) }]
            : []),
        ]
      : [];

  const drawerFooter: ReactNode = (
    <>
      <button type="button" className="btn btn--secondary" onClick={() => setDrawer(false)}>
        {t('reasonCodes.close')}
      </button>
      <button type="button" className="btn btn--primary" disabled={!canWrite} onClick={() => void submit()}>
        {t('reasonCodes.save')}
      </button>
    </>
  );

  return (
    <div className="rc">
      <SurfaceHeader title={t('reasonCodes.title')} help={<SurfaceHelp surface="ReasonCodes" />} actions={headerActions} />

      {failed && <ErrorBanner context="read" message={t('reasonCodes.error.transport')} onRetry={() => void load()} />}
      {writeError && !drawer && <ErrorBanner error={writeError} message={localError(writeError)} />}

      <DataTable
        columns={columns}
        rows={reasons}
        rowKey={(r) => r.id}
        caption={t('reasonCodes.list.caption')}
        loading={loading}
        skeletonRows={4}
        rowClassName={(r) => (r.isActive ? undefined : 'rc-row--archived')}
        onRowClick={canWrite ? openEdit : undefined}
        rowLabel={(r) => `${t('reasonCodes.edit')}: ${r.code}`}
        rowActions={rowActions}
        rowActionsLabel={(r) => t('reasonCodes.rowActions', { code: r.code })}
        emptyState={
          <EmptyState
            title={t('reasonCodes.empty.title')}
            hint={t('reasonCodes.empty.hint')}
            action={canWrite ? { label: t('reasonCodes.empty.cta'), onClick: openCreate } : undefined}
          />
        }
      />

      {drawer && (
        <DetailDrawer
          open
          onClose={() => setDrawer(false)}
          title={draft.id === null ? t('reasonCodes.form.titleNew') : t('reasonCodes.form.titleEdit')}
          closeLabel={t('reasonCodes.close')}
          footer={drawerFooter}
        >
          {writeError && <ErrorBanner error={writeError} message={localError(writeError)} />}
          <div className="rc-field">
            <label htmlFor="rc-code">{t('reasonCodes.form.code')}</label>
            <input
              className="field"
              id="rc-code"
              value={draft.code}
              disabled={draft.id !== null}
              onChange={(e) => setDraft({ ...draft, code: e.target.value })}
            />
          </div>
          <div className="rc-field">
            <label htmlFor="rc-name">{t('reasonCodes.form.name')}</label>
            <input className="field" id="rc-name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </div>
          <div className="rc-field">
            <label htmlFor="rc-category">{t('reasonCodes.form.category')}</label>
            <Select
              id="rc-category"
              value={draft.category}
              disabled={draft.id !== null}
              onChange={(value) => setDraft({ ...draft, category: value as Category })}
              options={CATEGORIES.map((c) => ({ value: c, label: t(`reasonCodes.category.${c}`) }))}
              ariaLabel={t('reasonCodes.form.category')}
            />
          </div>
          <label className="rc-check">
            <input type="checkbox" checked={draft.requiresNote} onChange={(e) => setDraft({ ...draft, requiresNote: e.target.checked })} />
            <span>{t('reasonCodes.form.requiresNote')}</span>
          </label>
          <label className="rc-check">
            <input
              type="checkbox"
              checked={draft.defaultForStocktake}
              onChange={(e) => setDraft({ ...draft, defaultForStocktake: e.target.checked })}
            />
            <span>{t('reasonCodes.form.defaultForStocktake')}</span>
          </label>
          <div className="rc-field">
            <label htmlFor="rc-desc">{t('reasonCodes.form.description')}</label>
            <input className="field" id="rc-desc" value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
          </div>
        </DetailDrawer>
      )}
    </div>
  );
}
