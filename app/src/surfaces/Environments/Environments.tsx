/**
 * D126 Phase C: the Umgebungen (Environments) surface, the whole landscape from one screen.
 *
 * The environment LIST is the content and leads the surface: create and filter never stack above it
 * (surface block 7.2, canon "no config stacked on content"). `main` is pinned first with a padlock and
 * NO destructive controls (E7); the other two standard tiers follow; named ad-hoc environments group
 * below with a filter that appears only at scale (E5b). Exactly one primary action, "Umgebung
 * erstellen", top-right.
 *
 * Every action is a dialog: create (drawer), refresh/copy, reset, delete, and the per-env detail
 * (finding #9), each mounted from this surface and each refetching the list on success. Capability
 * gating is the A24 convenience layer: `landscape.read` to view (its padlock hides the surface),
 * `landscape.manage` to act (the write controls pre-disable); the engine's `env_*` gates decide.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';

import { useClient } from '../../lib/client-context';
import { isErr } from '../../lib/client';
import { useWorkspaceId } from '../../app/workspace';
import { useCapabilities, CAP } from '../../lib/capabilities';
import { useT, formatDate } from '../../i18n';
import { EmptyState, NoWorkspaceState, PermissionDenied, ErrorBanner } from '../../components/states';
import { envErrorMessage } from './errors';
import { LockGlyph } from '../../components/states/glyphs';
import { DataTable, type DataTableColumn } from '../../components/DataTable';
import { Status } from '../../components/Status';
import { SurfaceHeader } from '../../components/SurfaceHeader';
import { SurfaceHelp } from '../../components/SurfaceHelp';
import { ActionFeedback } from '../../components/ActionFeedback';
import { FilterBar } from '../../components/FilterBar';
import { OverflowMenu } from '../../components/OverflowMenu';
import { Tooltip } from '../../components/Tooltip';
import {
  type EnvironmentRow,
  type EnvListOk,
  isProtected,
  isReadOnlyFace,
  partitionEnvironments,
  formatSize,
} from './model';
import { CreateEnvironmentDrawer } from './CreateEnvironmentDrawer';
import { CopyRefreshDialog } from './CopyRefreshDialog';
import { ResetDialog } from './ResetDialog';
import { DeleteDialog } from './DeleteDialog';
import { EnvironmentDetail } from './EnvironmentDetail';
import './Environments.css';

/** Above this many named environments the filter row appears (E5b: still one screen at 15-20). */
const FILTER_THRESHOLD = 6;

type ListState =
  | { kind: 'loading' }
  | { kind: 'error'; error: import('../../lib/client').Err }
  | { kind: 'ok'; rows: readonly EnvironmentRow[]; active: string };

/** The open dialog, or null. `target` on copy is the env being refreshed. */
type Dialog =
  | { kind: 'create' }
  | { kind: 'copy'; target: string }
  | { kind: 'reset'; env: EnvironmentRow }
  | { kind: 'delete'; env: EnvironmentRow }
  | { kind: 'detail'; name: string }
  | null;

interface Feedback {
  tone: 'success' | 'error';
  text: string;
}

export function Environments() {
  const t = useT();
  const client = useClient();
  const workspaceId = useWorkspaceId();
  const capabilities = useCapabilities();
  const canRead = capabilities.can(CAP.landscapeRead);
  const canManage = capabilities.can(CAP.landscapeManage);

  const [state, setState] = useState<ListState>({ kind: 'loading' });
  const [dialog, setDialog] = useState<Dialog>(null);
  const [filter, setFilter] = useState('');
  const [feedback, setFeedback] = useState<Feedback | null>(null);

  const load = useCallback(async () => {
    if (workspaceId === null) {
      setState({ kind: 'ok', rows: [], active: '' });
      return;
    }
    setState({ kind: 'loading' });
    const { body } = await client.call('env_list', { workspaceId });
    if (isErr(body)) {
      setState({ kind: 'error', error: body });
      return;
    }
    const ok = body as unknown as EnvListOk;
    setState({ kind: 'ok', rows: ok.environments, active: ok.active });
  }, [client, workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  /** After any successful write: close the dialog, show the feedback, and refetch the landscape. */
  const onDone = useCallback(
    (text: string) => {
      setDialog(null);
      setFeedback({ tone: 'success', text });
      void load();
    },
    [load],
  );

  const rows = state.kind === 'ok' ? state.rows : [];
  const { tiers, named } = useMemo(() => partitionEnvironments(rows), [rows]);
  const activeName = state.kind === 'ok' ? state.active : '';

  // The sources a copy/refresh may pull FROM: every environment ranked strictly ABOVE the target is
  // resolved inside the dialog; here we just hand it the full listing so its pickers stay in sync.
  const allNames = rows.map((r) => r.name);

  const filteredNamed = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (q === '') return named;
    return named.filter((r) => r.name.toLowerCase().includes(q));
  }, [named, filter]);

  const noWorkspace = workspaceId === null;

  // --- the action column, shared by both tables ------------------------------------------------
  const renderActions = useCallback(
    (env: EnvironmentRow) => {
      const open = (
        <button
          type="button"
          className="btn btn--secondary btn--sm"
          onClick={() => setDialog({ kind: 'detail', name: env.name })}
        >
          {t('env.row.open')}
        </button>
      );
      // main (protected): a padlock and NO destructive controls, only the read affordance (E7).
      if (isProtected(env)) {
        return (
          <div className="env-actions">
            {open}
            <Tooltip content={t('env.guard.liveTooltip')}>
              <span className="env-padlock" aria-label={t('env.guard.liveTooltip')}>
                <LockGlyph size={14} />
              </span>
            </Tooltip>
          </div>
        );
      }
      return (
        <div className="env-actions">
          {open}
          <OverflowMenu
            label={t('env.row.moreLabel', { name: env.name })}
            disabled={!canManage}
            items={[
              { key: 'refresh', label: t('env.row.refresh'), onSelect: () => setDialog({ kind: 'copy', target: env.name }) },
              { key: 'reset', label: t('env.row.reset'), onSelect: () => setDialog({ kind: 'reset', env }) },
              { key: 'delete', label: t('env.row.delete'), danger: true, onSelect: () => setDialog({ kind: 'delete', env }) },
            ]}
          />
        </div>
      );
    },
    [t, canManage],
  );

  const columns: DataTableColumn<EnvironmentRow>[] = useMemo(
    () => [
      {
        key: 'name',
        header: t('env.col.name'),
        rowHeader: true,
        render: (env) => (
          <span className="env-name">
            <span className="env-name-text">{env.name}</span>
            {/* K-22 (D137): the shared Status, a glyph plus the word, never a chip and never the
                accent (it was an accent-on-accent-soft chip with no role, B3-18). */}
            {env.name === activeName && <Status kind="success" label={t('env.badge.current')} />}
            {/* D135: reserve the "read only" mark for a genuinely read-only SERVED face. A local
                protected `main` is the real books and stays writable, so it is not marked read-only. */}
            {isReadOnlyFace(env) && env.name !== activeName && (
              <Status kind="inactive" label={t('env.badge.readOnly')} />
            )}
            {!env.exists && <Status kind="warn" label={t('env.badge.missing')} />}
          </span>
        ),
      },
      { key: 'codeChannel', header: t('env.col.codeChannel'), render: (env) => <span className="env-mono">{env.codeChannel}</span> },
      {
        key: 'dataPolicy',
        header: t('env.col.dataPolicy'),
        render: (env) => (
          <span className="env-policy">
            {t(`env.policy.${env.dataPolicy}`)}
            {env.sanitization !== null && (
              <span className="env-sanitize">{t(`env.sanitizeBadge.${env.sanitization}`)}</span>
            )}
          </span>
        ),
      },
      {
        key: 'guard',
        header: t('env.col.guard'),
        render: (env) => (
          <span className={`env-guard ${isProtected(env) ? 'env-guard--protected' : ''}`}>
            {isProtected(env) && <LockGlyph size={12} />}
            {t(`env.guard.${env.guardTier}`)}
          </span>
        ),
      },
      {
        key: 'lastRefresh',
        header: t('env.col.lastRefresh'),
        render: (env) => <span>{env.lastRefreshAt !== null ? formatDate(env.lastRefreshAt) : t('env.never')}</span>,
      },
      {
        key: 'size',
        header: t('env.col.size'),
        numeric: true,
        render: (env) => <span>{formatSize(env.sizeBytes) ?? '-'}</span>,
      },
      {
        key: 'actions',
        header: t('env.col.actions'),
        headerHidden: true,
        render: renderActions,
      },
    ],
    [t, activeName, renderActions],
  );

  // No read right: the surface is hidden behind the shared padlock (the engine gate is the real one).
  if (!canRead) {
    return (
      <section className="environments" aria-labelledby="environments-title">
        <SurfaceHeader title={t('env.title')} titleId="environments-title" help={<SurfaceHelp surface="Environments" />} />
        <PermissionDenied body={t('env.manageDenied')} />
      </section>
    );
  }

  if (noWorkspace) {
    return (
      <section className="environments" aria-labelledby="environments-title">
        <SurfaceHeader title={t('env.title')} titleId="environments-title" help={<SurfaceHelp surface="Environments" />} />
        <NoWorkspaceState body={t('env.noWorkspaceHint')} />
      </section>
    );
  }

  // The empty landscape (only main exists): one card inviting the first test environment (7.2).
  const onlyMain = state.kind === 'ok' && tiers.length <= 1 && named.length === 0 && rows.length <= 1;

  return (
    <section className="environments" aria-labelledby="environments-title">
      <SurfaceHeader
        title={t('env.title')}
        titleId="environments-title"
        subtitle={t('env.subtitle')}
        help={<SurfaceHelp surface="Environments" />}
        actions={
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => setDialog({ kind: 'create' })}
            disabled={!canManage}
            title={canManage ? undefined : t('env.manageDenied')}
          >
            {t('env.create')}
          </button>
        }
      />

      {feedback !== null && (
        <ActionFeedback
          key={feedback.text}
          tone={feedback.tone === 'error' ? 'error' : 'success'}
          landed={feedback.tone === 'success'}
          message={feedback.text}
          onDismiss={() => setFeedback(null)}
          dismissLabel={t('env.feedback.dismiss')}
        />
      )}

      {state.kind === 'error' ? (
        // The landscape file was unreadable (typically an integrity mismatch, which FAILS LOUD by
        // design): a full-surface message with a reload, its wording mapped by the surface rather
        // than the raw code, so no `errors.<code>` gap ever reaches the operator.
        <ErrorBanner
          error={state.error}
          context="read"
          message={t(envErrorMessage(state.error).key, envErrorMessage(state.error).params)}
          onRetry={() => void load()}
        />
      ) : onlyMain ? (
        <EmptyState
          title={t('env.emptyTitle')}
          hint={t('env.emptyHint')}
          action={canManage ? { label: t('env.create'), onClick: () => setDialog({ kind: 'create' }) } : undefined}
        />
      ) : (
        <>
          <section className="env-section" aria-labelledby="env-tiers-title">
            <h2 id="env-tiers-title" className="env-subtitle">
              {t('env.tiers.heading')}
            </h2>
            <DataTable<EnvironmentRow>
              columns={columns}
              rows={state.kind === 'ok' ? [...tiers] : []}
              rowKey={(env) => env.name}
              caption={t('env.tiers.heading')}
              loading={state.kind === 'loading'}
              skeletonRows={3}
              isRowCurrent={(env) => env.name === activeName}
            />
          </section>

          {(named.length > 0 || state.kind === 'loading') && (
            <section className="env-section" aria-labelledby="env-named-title">
              <h2 id="env-named-title" className="env-subtitle">
                {t('env.named.heading')}
              </h2>
              {named.length > FILTER_THRESHOLD && (
                <FilterBar
                  searchValue={filter}
                  onSearchChange={setFilter}
                  searchLabel={t('env.filter.label')}
                  searchPlaceholder={t('env.filter.placeholder')}
                  onClear={() => setFilter('')}
                  clearLabel={t('env.filter.clear')}
                />
              )}
              {named.length > 0 ? (
                <DataTable<EnvironmentRow>
                  columns={columns}
                  rows={[...filteredNamed]}
                  rowKey={(env) => env.name}
                  caption={t('env.named.heading')}
                  isRowCurrent={(env) => env.name === activeName}
                  emptyState={<EmptyState title={t('env.filter.none')} filtered={{ onClear: () => setFilter('') }} />}
                />
              ) : (
                state.kind === 'ok' && <p className="env-named-empty">{t('env.named.empty')}</p>
              )}
            </section>
          )}
        </>
      )}

      {dialog?.kind === 'create' && (
        <CreateEnvironmentDrawer
          existingNames={allNames}
          onClose={() => setDialog(null)}
          onDone={(name) => onDone(t('env.feedback.created', { name }))}
        />
      )}
      {dialog?.kind === 'copy' && (
        <CopyRefreshDialog
          target={dialog.target}
          environments={rows}
          canRetainSecrets={canManage}
          onClose={() => setDialog(null)}
          onDone={(source, target) => onDone(t('env.feedback.copied', { source, target }))}
        />
      )}
      {dialog?.kind === 'reset' && (
        <ResetDialog
          env={dialog.env}
          onClose={() => setDialog(null)}
          onDone={(name) => onDone(t('env.feedback.reset', { name }))}
        />
      )}
      {dialog?.kind === 'delete' && (
        <DeleteDialog
          env={dialog.env}
          onClose={() => setDialog(null)}
          onDone={(name) => onDone(t('env.feedback.deleted', { name }))}
        />
      )}
      {dialog?.kind === 'detail' && (
        <EnvironmentDetail
          name={dialog.name}
          activeName={activeName}
          canManage={canManage}
          onClose={() => setDialog(null)}
          onRefresh={(name) => setDialog({ kind: 'copy', target: name })}
          onSwitched={(name) => onDone(t('env.feedback.switched', { name }))}
        />
      )}
    </section>
  );
}

export default Environments;
