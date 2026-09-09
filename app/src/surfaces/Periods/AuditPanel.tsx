/**
 * A03 Audit-Log panel (Studio §6, US-A03.5): the tamper-evident, chronological trail plus its
 * chain-verification status.
 *
 * The chain status is glyph PLUS text (a verified check or a broken cross), never colour alone: it is
 * driven by the very `chainVerified` field `get_audit_log` returns, computed on every read (P5), so it
 * can never go stale. A broken chain renders a banner naming the first bad row (`brokenAtId`), never a
 * silent red badge. The panel filters by object kind; timestamps render through `formatDate`.
 */
import { useCallback, useEffect, useState } from 'react';

import { useClient } from '../../lib/client-context';
import { isErr, type Err } from '../../lib/client';
import { useWorkspaceId } from '../../app/workspace';
import { useT, useTStrict, formatDate } from '../../i18n';
import { EmptyState, NoWorkspaceState } from '../../components/states';
import { DataTable, type DataTableColumn } from '../../components/DataTable';
import { ChainVerifiedGlyph, ChainBrokenGlyph } from './glyphs';
import { AUDIT_ENTITY_KINDS } from './audit-vocabulary';

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

export function AuditPanel() {
  const t = useT();
  // Kind and action come off the wire, so they resolve strictly: an untranslated value throws in dev
  // rather than rendering `audit.action.create` at a user.
  const tStrict = useTStrict();
  const client = useClient();
  const workspaceId = useWorkspaceId();

  const [state, setState] = useState<PanelState>({ kind: 'loading' });
  const [entityKind, setEntityKind] = useState('');

  const load = useCallback(
    async (kindFilter: string) => {
      if (workspaceId === null) {
        setState({ kind: 'noWorkspace' });
        return;
      }
      setState({ kind: 'loading' });
      const input: Record<string, unknown> = { workspaceId };
      if (kindFilter !== '') input.entityKind = kindFilter;
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
    void load(entityKind);
  }, [load, entityKind]);

  const refetch = useCallback(() => void load(entityKind), [load, entityKind]);

  // The trail columns. Every value is read VERBATIM off `get_audit_log`: the timestamp through the
  // shared `formatDate`, the kind and action through the strict catalogue (an untranslated value
  // throws in dev rather than leaking a dot-path key), the actor as the engine named it. Text left,
  // no numeric column, so no `footer` total.
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
    { key: 'actor', header: t('audit.col.actor'), render: (row) => row.actor },
  ];

  return (
    <section className="audit-panel panel" aria-labelledby="audit-title">
      <div className="audit-head">
        <h2 id="audit-title" className="audit-title">
          {t('audit.title')}
        </h2>
        {state.kind === 'ok' && <ChainBadge verified={state.chainVerified} />}
      </div>

      <div className="audit-controls">
        <label className="period-field">
          {t('audit.filterEntity')}
          <select value={entityKind} onChange={(e) => setEntityKind(e.target.value)}>
            <option value="">{t('audit.filterAll')}</option>
            {AUDIT_ENTITY_KINDS.map((k) => (
              <option key={k} value={k}>
                {tStrict(`audit.entityKind.${k}`)}
              </option>
            ))}
          </select>
        </label>
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
          happened yet", which is a different and untrue claim, and offered no way out. It is branched
          out here because DataTable's own empty state IS "nothing has happened yet". */}
      {state.kind === 'noWorkspace' ? (
        <NoWorkspaceState body={t('period.noWorkspaceHint')} />
      ) : (
        <DataTable<AuditRow>
          columns={auditColumns}
          rows={state.kind === 'ok' ? state.rows : []}
          rowKey={(row) => row.id}
          caption={t('audit.title')}
          loading={state.kind === 'loading'}
          error={state.kind === 'error' ? state.error : undefined}
          onRetry={refetch}
          skeletonRows={4}
          emptyState={<EmptyState title={t('audit.empty')} hint={t('audit.emptyHint')} />}
        />
      )}
    </section>
  );
}

export default AuditPanel;
