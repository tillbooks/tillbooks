/**
 * A03 Audit-Log panel (Studio §6, US-A03.5): the tamper-evident, chronological trail plus its
 * chain-verification status.
 *
 * The chain status is glyph PLUS text (a verified check or a broken cross), never colour alone: it is
 * driven by the very `chainVerified` field `get_audit_log` returns, computed on every read (P5), so it
 * can never go stale. A broken chain renders a banner naming the first bad row (`brokenAtId`), never a
 * silent red badge. Both stay in view whatever the trail below them does.
 *
 * THE TRAIL IS BEHIND A DISCLOSURE (K-25, D137). Perioden used to end in the whole log, 531 rows and
 * 25 screens under the month-end checklist, which nobody had asked for. The trail is now "Verlauf",
 * closed by default: opened, it shows the newest 20 entries, filters by object, action and period,
 * and loads 50 more at a time. Timestamps render through `formatDate`, the actor through
 * `displayName` (K-38): a seat or a person by name, never the raw `user_1`.
 */
import { useCallback, useEffect, useId, useMemo, useState } from 'react';

import { useClient } from '../../lib/client-context';
import { isErr, type Err } from '../../lib/client';
import { useWorkspaceId } from '../../app/workspace';
import { useT, useTStrict, formatDate } from '../../i18n';
import { displayName, type SeatMember } from '../../lib/displayName';
import { EmptyState, NoWorkspaceState } from '../../components/states';
import { DataTable, type DataTableColumn } from '../../components/DataTable';
import { Select } from '../../components/Select';
import { ChevronRightGlyph } from '../../components/icons';
import { ChainVerifiedGlyph, ChainBrokenGlyph } from './glyphs';
import { AUDIT_ACTIONS, AUDIT_ENTITY_KINDS } from './audit-vocabulary';

export interface AuditRow {
  id: string;
  entityKind: string;
  entityId: string;
  action: string;
  actor: string;
  at: string;
}

type PanelState =
  | { kind: 'loading' }
  | { kind: 'error'; error: Err }
  | { kind: 'noWorkspace' }
  | { kind: 'ok'; rows: AuditRow[]; chainVerified: boolean; brokenAtId?: string };

/** How many entries the opened trail shows first, and how many each "Mehr laden" adds (K-25). */
export const AUDIT_FIRST_PAGE = 20;
export const AUDIT_PAGE_STEP = 50;

interface AuditFilters {
  entityKind: string;
  action: string;
  from: string;
  to: string;
}

const NO_FILTERS: AuditFilters = { entityKind: '', action: '', from: '', to: '' };

/** The chain-verification badge: a check + label when verified, a cross + label when broken. */
function ChainBadge({ verified }: { verified: boolean }) {
  const t = useT();
  return (
    <span className={`audit-chain ${verified ? 'audit-chain-ok' : 'audit-chain-broken'}`}>
      {verified ? <ChainVerifiedGlyph /> : <ChainBrokenGlyph />}
      <span className="audit-chain-text">
        {verified ? t('audit.chainVerified') : t('audit.chainBroken')}
      </span>
    </span>
  );
}

/** The roster `displayName` names seats from. A courtesy read: without it a seat still gets a word. */
function useSeatRoster(): readonly SeatMember[] {
  const client = useClient();
  const workspaceId = useWorkspaceId();
  const [members, setMembers] = useState<readonly SeatMember[]>([]);
  useEffect(() => {
    if (workspaceId === null) return undefined;
    let live = true;
    void client.call('list_members', { workspaceId }).then(({ body }) => {
      if (!live || isErr(body)) return;
      const rows = (body as unknown as { members?: readonly SeatMember[] }).members;
      setMembers(Array.isArray(rows) ? rows : []);
    });
    return () => {
      live = false;
    };
  }, [client, workspaceId]);
  return members;
}

export function AuditPanel() {
  const t = useT();
  // Kind and action come off the wire, so they resolve strictly: an untranslated value throws in dev
  // rather than rendering `audit.action.create` at a user.
  const tStrict = useTStrict();
  const client = useClient();
  const workspaceId = useWorkspaceId();
  const members = useSeatRoster();
  const bodyId = useId();

  const [state, setState] = useState<PanelState>({ kind: 'loading' });
  const [filters, setFilters] = useState<AuditFilters>(NO_FILTERS);
  const [open, setOpen] = useState(false);
  const [shown, setShown] = useState(AUDIT_FIRST_PAGE);

  // Object and period narrow the READ (the engine filters them); the action narrows what is shown.
  const load = useCallback(
    async (entityKind: string, from: string, to: string) => {
      if (workspaceId === null) {
        setState({ kind: 'noWorkspace' });
        return;
      }
      setState({ kind: 'loading' });
      const input: Record<string, unknown> = { workspaceId };
      if (entityKind !== '') input.entityKind = entityKind;
      if (from !== '') input.from = from;
      if (to !== '') input.to = to;
      const { body } = await client.call('get_audit_log', input);
      if (isErr(body)) {
        setState({ kind: 'error', error: body });
        return;
      }
      setState({
        kind: 'ok',
        rows: (body.rows as AuditRow[]) ?? [],
        chainVerified: body.chainVerified !== false,
        brokenAtId: body.brokenAtId as string | undefined,
      });
    },
    [client, workspaceId],
  );

  useEffect(() => {
    void load(filters.entityKind, filters.from, filters.to);
  }, [load, filters.entityKind, filters.from, filters.to]);

  const refetch = useCallback(
    () => void load(filters.entityKind, filters.from, filters.to),
    [load, filters.entityKind, filters.from, filters.to],
  );

  const setFilter = (patch: Partial<AuditFilters>) => {
    setFilters((current) => ({ ...current, ...patch }));
    setShown(AUDIT_FIRST_PAGE);
  };

  // Newest first: the chain is stored oldest first, and the person opening "Verlauf" wants the latest
  // change on top. The order of the READ, and so the chain it verifies, is untouched.
  const matching = useMemo(() => {
    if (state.kind !== 'ok') return [];
    const rows = filters.action === '' ? state.rows : state.rows.filter((r) => r.action === filters.action);
    return [...rows].reverse();
  }, [state, filters.action]);
  const visible = matching.slice(0, shown);
  const filterActive = filters.entityKind !== '' || filters.action !== '' || filters.from !== '' || filters.to !== '';

  // The trail columns. Every value is read VERBATIM off `get_audit_log`: the timestamp through the
  // shared `formatDate`, the kind and action through the strict catalogue, the actor as a name
  // (K-38). Text left, no numeric column, so no `footer` total.
  const auditColumns: DataTableColumn<AuditRow>[] = [
    {
      key: 'at',
      header: t('audit.col.at'),
      render: (row) => <span className="audit-num">{formatDate(row.at)}</span>,
    },
    {
      key: 'entity',
      header: t('audit.col.entity'),
      render: (row) => tStrict(`audit.entityKind.${row.entityKind}`),
    },
    {
      key: 'action',
      header: t('audit.col.action'),
      render: (row) => tStrict(`audit.action.${row.action}`),
    },
    { key: 'actor', header: t('audit.col.actor'), render: (row) => displayName(row.actor, members, t).label },
  ];

  return (
    <section className="audit-panel panel" aria-labelledby="audit-title">
      <div className="audit-head">
        <h2 id="audit-title" className="audit-title">
          {t('audit.title')}
        </h2>
        {state.kind === 'ok' && <ChainBadge verified={state.chainVerified} />}
        {/* The read is announced while it runs, whether or not the trail is open. */}
        {state.kind === 'loading' && (
          <span role="status" aria-busy="true" className="visually-hidden">
            {t('audit.loading')}
          </span>
        )}
      </div>

      {state.kind === 'ok' && !state.chainVerified && (
        <div className="audit-broken-banner" role="alert">
          <ChainBrokenGlyph size={20} />
          <p className="audit-broken-text">
            {state.brokenAtId !== undefined
              ? t('audit.chainBrokenDetail', { id: state.brokenAtId })
              : t('audit.chainBrokenStructural')}
          </p>
        </div>
      )}

      {/* A null workspace is not an empty log. Reporting it as `ok` with no rows said "nothing has
          happened yet", which is a different and untrue claim, and offered no way out. */}
      {state.kind === 'noWorkspace' ? (
        <NoWorkspaceState body={t('period.noWorkspaceHint')} />
      ) : (
        <>
          <button
            type="button"
            className="audit-toggle"
            aria-expanded={open}
            aria-controls={bodyId}
            onClick={() => setOpen((value) => !value)}
          >
            <ChevronRightGlyph className="audit-toggle-chevron" size={16} data-open={open ? '' : undefined} />
            <span className="audit-toggle-label">{t('audit.history')}</span>
            {state.kind === 'ok' && (
              <span className="audit-toggle-count t-num">{state.rows.length}</span>
            )}
          </button>

          {open && (
            <div id={bodyId} className="audit-body">
              <div className="audit-controls" role="search" aria-label={t('audit.filters')}>
                <div className="period-field">
                  {t('audit.filterEntity')}
                  <Select
                    value={filters.entityKind}
                    onChange={(value) => setFilter({ entityKind: value })}
                    options={[
                      { value: '', label: t('audit.filterAll') },
                      ...AUDIT_ENTITY_KINDS.map((k) => ({ value: k, label: tStrict(`audit.entityKind.${k}`) })),
                    ]}
                    ariaLabel={t('audit.filterEntity')}
                  />
                </div>
                <div className="period-field">
                  {t('audit.filterAction')}
                  <Select
                    value={filters.action}
                    onChange={(value) => setFilter({ action: value })}
                    options={[
                      { value: '', label: t('audit.filterAll') },
                      ...AUDIT_ACTIONS.map((a) => ({ value: a, label: tStrict(`audit.action.${a}`) })),
                    ]}
                    ariaLabel={t('audit.filterAction')}
                  />
                </div>
                <label className="period-field">
                  {t('audit.filterFrom')}
                  <input
                    className="field"
                    type="date"
                    value={filters.from}
                    onChange={(e) => setFilter({ from: e.target.value })}
                  />
                </label>
                <label className="period-field">
                  {t('audit.filterTo')}
                  <input
                    className="field"
                    type="date"
                    value={filters.to}
                    onChange={(e) => setFilter({ to: e.target.value })}
                  />
                </label>
              </div>

              <DataTable<AuditRow>
                columns={auditColumns}
                rows={visible}
                rowKey={(row) => row.id}
                caption={t('audit.title')}
                loading={state.kind === 'loading'}
                error={state.kind === 'error' ? state.error : undefined}
                onRetry={refetch}
                skeletonRows={4}
                emptyState={
                  filterActive ? (
                    <EmptyState
                      title={t('audit.emptyFiltered')}
                      hint={t('audit.emptyFilteredHint')}
                      filtered={{ onClear: () => setFilter(NO_FILTERS) }}
                    />
                  ) : (
                    <EmptyState title={t('audit.empty')} hint={t('audit.emptyHint')} />
                  )
                }
              />

              {state.kind === 'ok' && matching.length > visible.length && (
                <div className="audit-more">
                  <span className="audit-more-count">
                    {t('audit.shownOf', { shown: visible.length, total: matching.length })}
                  </span>
                  <button
                    type="button"
                    className="btn btn--secondary btn--sm"
                    onClick={() => setShown((count) => count + AUDIT_PAGE_STEP)}
                  >
                    {t('audit.loadMore')}
                  </button>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}

export default AuditPanel;
