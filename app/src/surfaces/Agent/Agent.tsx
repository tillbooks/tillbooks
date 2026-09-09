/**
 * A35, `/agent`: the archive and the evidence, full width, in three tabs (design §2b):
 *
 *  - Gespräche (default): sessions newest first (Datum, Client, Schritte, Buchungen, Vorschläge),
 *    each openable to its turns. `-` means no attempt of that kind was made; `0` would mean attempts
 *    were made and none landed: the §3e dash-versus-zero rule, shared with Vertrauen via ONE helper.
 *  - Vorschläge: every pending drafted action at full width, oldest first (the oldest is the one at
 *    risk of going stale), the SAME card component the dock renders, grouped Geld/System above 20.
 *  - Vertrauen: the ten-row evidence table over a stated window, the D103 grant control beside its
 *    evidence (owner-gated, absent without `manage_agent_dial`, never disabled-and-scolding), the
 *    strong-default pair with its reason in place, stored-vs-effective both rendered when they
 *    disagree, and the D-3 suggestion that offers the grant act once and never nags after a decline.
 */
import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import { useT, formatDate } from '../../i18n';
import { useClient } from '../../lib/client-context';
import { isErr, type Err } from '../../lib/client';
import { useWorkspaceId } from '../../app/workspace';
import { useCan } from '../../lib/capabilities';
import { EmptyState, ErrorBanner, NoWorkspaceState, Skeleton } from '../../components/states';
import { SurfaceHeader } from '../../components/SurfaceHeader';
import { SurfaceHelp } from '../../components/SurfaceHelp';
import { Tabs, type TabItem } from '../../components/Tabs';
import { DataTable, type DataTableColumn } from '../../components/DataTable';
import { TurnList } from './TurnList';
import { VorschlagCard } from './VorschlagCard';
import {
  GELD_CAPABILITIES,
  QUEUE_GROUP_THRESHOLD,
  SYSTEM_CAPABILITIES,
  countCell,
  dismissSuggestion,
  isSuggestionDismissed,
  parseDrafted,
  parseSessionDetail,
  parseSessions,
  parseTrust,
  type AgentSessionDetail,
  type AgentSessionRow,
  type DraftedAction,
  type TrustRow,
  type TrustSummary,
} from './model';
import './Agent.css';

type Tab = 'gespraeche' | 'vorschlaege' | 'vertrauen';

function dateOf(iso: string): string {
  return iso.length >= 10 ? formatDate(iso.slice(0, 10)) : iso;
}

/* --------------------------------------------------------------------------------- Gespräche */

/** The month `YYYY-MM` this instant falls in, and its inclusive date-only bounds (F10 semantics). */
function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

function monthBounds(month: string): { from: string; to: string } {
  const [y, m] = month.split('-').map(Number);
  const lastDay = new Date(Date.UTC(y ?? 1970, m ?? 1, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(lastDay).padStart(2, '0')}` };
}

function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1 + delta, 1));
  return d.toISOString().slice(0, 7);
}

function Gespraeche({ initialSessionId }: { initialSessionId: string | null }) {
  const t = useT();
  const client = useClient();
  const workspaceId = useWorkspaceId();
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<Err | undefined>(undefined);
  const [rows, setRows] = useState<AgentSessionRow[]>([]);
  const [anyEver, setAnyEver] = useState(false);
  // §6 / critic F13: paged by MONTH, defaulting to the current one, with the period control on the
  // same screen as the rows it governs.
  const [month, setMonth] = useState(currentMonth());
  const [openSession, setOpenSession] = useState<AgentSessionDetail | null>(null);

  const load = useCallback(async () => {
    if (workspaceId === null) return;
    setState('loading');
    const bounds = monthBounds(month);
    const [paged, probe] = await Promise.all([
      client.call('list_agent_sessions', { workspaceId, from: bounds.from, to: bounds.to }),
      // The existence probe keeps "no sessions at all" (connect a client) distinct from "none in
      // THIS month" (page back), so the empty states cannot lie about each other.
      client.call('list_agent_sessions', { workspaceId }),
    ]);
    if (isErr(paged.body)) {
      setError(paged.body);
      setState('error');
      return;
    }
    setRows(parseSessions(paged.body));
    setAnyEver(!isErr(probe.body) && parseSessions(probe.body).length > 0);
    setState('ready');
  }, [client, month, workspaceId]);

  const openOne = useCallback(
    async (sessionId: string) => {
      if (workspaceId === null) return;
      const res = await client.call('get_agent_session', { workspaceId, sessionId });
      if (!isErr(res.body)) setOpenSession(parseSessionDetail(res.body));
    },
    [client, workspaceId],
  );

  useEffect(() => {
    setOpenSession(null);
    void load();
    // F-08 (J5.4): a provenance line links here as `/agent?session=<id>`, and the conversation opens
    // directly, one click from the posting. The session is read by id, so it opens even when it lies
    // outside the month the list is paged to; the list stays underneath for the way back.
    if (initialSessionId !== null) void openOne(initialSessionId);
  }, [initialSessionId, load, openOne]);

  if (state === 'loading') return <Skeleton rows={5} height={32} />;
  if (state === 'error') return <ErrorBanner error={error} onRetry={() => void load()} />;
  if (!anyEver) {
    return (
      <EmptyState
        title={t('agent.archive.empty.title')}
        hint={t('agent.archive.empty.hint')}
        action={{ label: t('agent.archive.empty.action'), to: '/setup' }}
      />
    );
  }

  const monthControl = (
    <div className="agent-month" role="group" aria-label={t('agent.archive.month')}>
      <button type="button" className="btn btn--ghost btn--sm" aria-label={t('agent.archive.monthPrev')} onClick={() => setMonth((m) => shiftMonth(m, -1))}>
        <span aria-hidden="true">‹</span>
      </button>
      <span className="agent-month-label">{formatDate(`${month}-01`).slice(3)}</span>
      <button type="button" className="btn btn--ghost btn--sm" aria-label={t('agent.archive.monthNext')} onClick={() => setMonth((m) => shiftMonth(m, 1))}>
        <span aria-hidden="true">›</span>
      </button>
    </div>
  );

  if (openSession !== null) {
    return (
      <div className="agent-session-detail">
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => setOpenSession(null)}>
          {t('agent.archive.back')}
        </button>
        <p className="agent-session-meta">
          {openSession.clientLabel ?? t('agent.archive.unknownClient')} · {dateOf(openSession.startedAt)}
          {openSession.open && <> · {t('agent.archive.running')}</>}
        </p>
        <TurnList turns={openSession.turns} />
      </div>
    );
  }
  // The sessions list is the one genuinely tabular view on this surface, so it adopts the shared
  // DataTable (D118 B2): the frame owns the horizontal overflow, the header sticks, density is a
  // token, and a row is the keyboard-activatable open affordance (opening its turns). Every figure
  // renders VERBATIM from the read (`calls`, and `countCell` over `writes`/`drafts`): the surface
  // never sums a column itself. The month-empty case is DataTable's own empty slot, so "none in
  // this month" and "no session ever" (the early return above) stay two distinct sentences.
  const columns: DataTableColumn<AgentSessionRow>[] = [
    { key: 'datum', header: t('agent.archive.col.datum'), render: (row) => dateOf(row.lastAt) },
    { key: 'client', header: t('agent.archive.col.client'), render: (row) => row.clientLabel ?? t('agent.archive.unknownClient') },
    // Schritte counts every call and is never a dash: a session with no calls does not exist.
    { key: 'schritte', header: t('agent.archive.col.schritte'), numeric: true, render: (row) => String(row.calls) },
    { key: 'buchungen', header: t('agent.archive.col.buchungen'), numeric: true, render: (row) => countCell(row.writes, row.writes > 0) },
    { key: 'vorschlaege', header: t('agent.archive.col.vorschlaege'), numeric: true, render: (row) => countCell(row.drafts, row.drafts > 0) },
    {
      key: 'status',
      header: t('agent.archive.col.status'),
      headerHidden: true,
      render: (row) => (row.open ? <span className="agent-running">◔ {t('agent.archive.running')}</span> : null),
    },
  ];

  return (
    <div>
      {monthControl}
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(row) => row.sessionId}
        caption={t('agent.archive.caption')}
        onRowClick={(row) => void openOne(row.sessionId)}
        rowLabel={(row) => `${dateOf(row.lastAt)}, ${row.clientLabel ?? t('agent.archive.unknownClient')}`}
        emptyState={<p className="agent-month-empty">{t('agent.archive.monthEmpty')}</p>}
      />
    </div>
  );
}

/* -------------------------------------------------------------------------------- Vorschläge */

function Vorschlaege() {
  const t = useT();
  const client = useClient();
  const workspaceId = useWorkspaceId();
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<Err | undefined>(undefined);
  const [actions, setActions] = useState<DraftedAction[]>([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (workspaceId === null) return;
    const res = await client.call('list_drafted_actions', { workspaceId });
    if (isErr(res.body)) {
      setError(res.body);
      setState('error');
      return;
    }
    setActions(parseDrafted(res.body));
    setState('ready');
  }, [client, workspaceId]);

  useEffect(() => {
    setState('loading');
    void load();
  }, [load]);

  const decide = useCallback(
    async (
      verb: 'approve_drafted_action' | 'reject_drafted_action',
      actionId: string,
      allowFuture: boolean,
      reason?: string,
    ) => {
      if (workspaceId === null || busy) return;
      setBusy(true);
      await client.call(verb, {
        workspaceId,
        actionId,
        ...(allowFuture ? { allowFuture: true } : {}),
        ...(reason !== undefined ? { reason } : {}),
      });
      setBusy(false);
      void load();
    },
    [busy, client, load, workspaceId],
  );

  if (state === 'loading') return <Skeleton rows={3} height={120} />;
  if (state === 'error') return <ErrorBanner error={error} onRetry={() => void load()} />;
  // The empty state is checked against the SAME list the success state renders (design §3f).
  if (actions.length === 0) {
    return <EmptyState title={t('agent.queue.empty')} hint={t('agent.queue.emptyHint')} />;
  }

  const focusedId = actions[0].actionId; // oldest first: the focused card is the one at risk of going stale.
  const card = (action: DraftedAction) => (
    <VorschlagCard
      key={action.actionId}
      action={action}
      accent={action.actionId === focusedId}
      onApprove={(id, allow) => void decide('approve_drafted_action', id, allow)}
      onReject={(id, reason) => void decide('reject_drafted_action', id, false, reason)}
      busy={busy}
    />
  );

  if (actions.length <= QUEUE_GROUP_THRESHOLD) return <div className="agent-queue">{actions.map(card)}</div>;
  const geld = actions.filter((a) => (GELD_CAPABILITIES as readonly string[]).includes(a.dialCapability ?? ''));
  const system = actions.filter((a) => !(GELD_CAPABILITIES as readonly string[]).includes(a.dialCapability ?? ''));
  return (
    <div className="agent-queue">
      <h2 className="agent-group-head">{t('agent.queue.group.geld')}</h2>
      {geld.map(card)}
      <h2 className="agent-group-head">{t('agent.queue.group.system')}</h2>
      {system.map(card)}
    </div>
  );
}

/* --------------------------------------------------------------------------------- Vertrauen */

function TrustRows({
  rows,
  canDecide,
  busy,
  onSetLevel,
  workspaceId,
}: {
  rows: TrustRow[];
  canDecide: boolean;
  busy: boolean;
  onSetLevel: (capability: string, level: 'ask' | 'auto') => void;
  workspaceId: string;
}) {
  const t = useT();
  const [confirming, setConfirming] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(0); // bump to re-render after a dismissal write.

  return (
    <>
      {rows.map((row) => {
        const attempted = row.proposed > 0 || row.autoExecuted > 0;
        const label = t(`agent.capability.${row.capability}`);
        const disagree = row.stored !== row.effective;
        const levelWord =
          row.strongDefault && row.effective === 'ask'
            ? t('agent.trust.fragtImmer')
            : t(`agent.trust.level.${row.effective}`);
        const suggest =
          canDecide && row.suggestGrant && !isSuggestionDismissed(workspaceId, row.capability) && dismissed >= 0;
        return (
          <tbody key={row.capability} className="agent-trust-rowgroup">
            <tr>
              <th scope="row">{label}</th>
              <td>
                {levelWord}
                {disagree && (
                  <span className="agent-trust-disagree">
                    {' '}
                    {t('agent.trust.storedVsEffective', {
                      stored: t(`agent.trust.level.${row.stored}`),
                      effective: row.strongDefault && row.effective === 'ask' ? t('agent.trust.fragtImmer') : t(`agent.trust.level.${row.effective}`),
                    })}
                  </span>
                )}
                {/* Critic F3: WHO set the level, ON the screen that governs grants. D103 is
                    "attributed, revocable, fail-closed", and the attribution renders where the
                    revocation control sits. */}
                {row.updatedBy !== null && (
                  <span className="agent-trust-grantedby">
                    {' '}
                    {t('agent.trust.grantedBy', {
                      actor: row.updatedBy,
                      date: row.updatedAt !== null ? dateOf(row.updatedAt) : '',
                    })}
                  </span>
                )}
              </td>
              {attempted ? (
                <>
                  <td className="num">{countCell(row.proposed, row.proposed > 0 || row.autoExecuted > 0)}</td>
                  <td className="num">{countCell(row.approved, row.proposed > 0)}</td>
                  <td className="num">{countCell(row.rejected, row.proposed > 0)}</td>
                  <td className="num">{countCell(row.autoExecuted, row.autoExecuted > 0)}</td>
                </>
              ) : (
                // Zero activity is a SENTENCE, never zeroes that look like failures (row 7.2).
                <td colSpan={4} className="agent-trust-nohistory">
                  {t('agent.trust.noHistory')}
                </td>
              )}
              <td>
                {canDecide &&
                  (row.effective === 'auto' ? (
                    <button
                      type="button"
                      className="btn btn--secondary btn--sm"
                      disabled={busy}
                      onClick={() => onSetLevel(row.capability, 'ask')}
                    >
                      {t('agent.trust.revokeAction')}
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="btn btn--secondary btn--sm"
                      disabled={busy}
                      onClick={() => setConfirming(row.capability)}
                    >
                      {t('agent.trust.grantAction')}
                    </button>
                  ))}
              </td>
            </tr>
            {row.strongDefault && row.effective === 'ask' && (
              <tr className="agent-trust-note">
                <td colSpan={7}>{t('agent.trust.strongReason')}</td>
              </tr>
            )}
            {confirming === row.capability && (
              <tr className="agent-trust-confirm">
                <td colSpan={7}>
                  {/* The D103 grant ceremony: explicit, per capability, attributed, revocable. */}
                  <p>{t('agent.trust.grantConfirm', { capability: label })}</p>
                  <div className="vorschlag-confirm-actions">
                    <button
                      type="button"
                      className="btn btn--primary btn--sm"
                      disabled={busy}
                      onClick={() => {
                        setConfirming(null);
                        onSetLevel(row.capability, 'auto');
                      }}
                    >
                      {t('agent.trust.grantYes')}
                    </button>
                    <button type="button" className="btn btn--ghost btn--sm" onClick={() => setConfirming(null)}>
                      {t('agent.trust.grantNo')}
                    </button>
                  </div>
                </td>
              </tr>
            )}
            {suggest && confirming !== row.capability && (
              <tr className="agent-trust-suggest">
                <td colSpan={7}>
                  <p>{t('agent.trust.suggest', { approved: row.approved, proposed: row.proposed })}</p>
                  <div className="vorschlag-confirm-actions">
                    <button
                      type="button"
                      className="btn btn--secondary btn--sm"
                      disabled={busy}
                      onClick={() => setConfirming(row.capability)}
                    >
                      {t('agent.trust.grantAction')}
                    </button>
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      onClick={() => {
                        dismissSuggestion(workspaceId, row.capability);
                        setDismissed((v) => v + 1);
                      }}
                    >
                      {t('agent.trust.suggestDismiss')}
                    </button>
                  </div>
                </td>
              </tr>
            )}
          </tbody>
        );
      })}
    </>
  );
}

function Vertrauen() {
  const t = useT();
  const client = useClient();
  const workspaceId = useWorkspaceId();
  const canDecide = useCan('manage_agent_dial');
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<Err | undefined>(undefined);
  const [trust, setTrust] = useState<TrustSummary | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (workspaceId === null) return;
    const res = await client.call('agent_trust_summary', { workspaceId });
    if (isErr(res.body)) {
      setError(res.body);
      setState('error');
      return;
    }
    setTrust(parseTrust(res.body));
    setState('ready');
  }, [client, workspaceId]);

  useEffect(() => {
    setState('loading');
    void load();
  }, [load]);

  const setLevel = useCallback(
    async (capability: string, level: 'ask' | 'auto') => {
      if (workspaceId === null || busy) return;
      setBusy(true);
      await client.call('set_agent_dial', {
        workspaceId,
        capability,
        level,
        idempotencyKey: `studio-dial-${capability}-${level}-${Date.now()}`,
      });
      setBusy(false);
      void load();
    },
    [busy, client, load, workspaceId],
  );

  if (state === 'loading') return <Skeleton rows={8} height={32} />;
  if (state === 'error' || trust === null) return <ErrorBanner error={error} onRetry={() => void load()} />;

  const byCapability = new Map(trust.rows.map((row) => [row.capability, row]));
  const geld = GELD_CAPABILITIES.map((c) => byCapability.get(c)).filter((r): r is TrustRow => r !== undefined);
  const system = SYSTEM_CAPABILITIES.map((c) => byCapability.get(c)).filter((r): r is TrustRow => r !== undefined);
  const head = (
    <tr>
      <th scope="col">{t('agent.trust.col.was')}</th>
      <th scope="col">{t('agent.trust.col.stufe')}</th>
      <th scope="col" className="num">{t('agent.trust.col.vorgeschlagen')}</th>
      <th scope="col" className="num">{t('agent.trust.col.genehmigt')}</th>
      <th scope="col" className="num">{t('agent.trust.col.abgelehnt')}</th>
      <th scope="col" className="num">{t('agent.trust.col.automatisch')}</th>
      <th scope="col">
        <span className="visually-hidden">{t('agent.trust.col.aktion')}</span>
      </th>
    </tr>
  );

  return (
    <div className="agent-trust">
      {/* Every figure's window, on the same screen as every figure it governs (row 7.3). */}
      <p className="agent-trust-window">
        {t('agent.trust.window', { from: dateOf(trust.window.from), to: dateOf(trust.window.to) })}
      </p>
      <h2 className="agent-group-head">{t('agent.queue.group.geld')}</h2>
      <table className="table agent-trust-table">
        <thead>{head}</thead>
        <TrustRows rows={geld} canDecide={canDecide} busy={busy} onSetLevel={(c, l) => void setLevel(c, l)} workspaceId={workspaceId ?? ''} />
      </table>
      <h2 className="agent-group-head">{t('agent.queue.group.system')}</h2>
      <table className="table agent-trust-table">
        <thead>{head}</thead>
        <TrustRows rows={system} canDecide={canDecide} busy={busy} onSetLevel={(c, l) => void setLevel(c, l)} workspaceId={workspaceId ?? ''} />
      </table>
      {/* Row 10.1: the trace is never offered as a statutory export, and the surface says where that lives. */}
      <p className="agent-trust-statutory">{t('agent.trust.statutoryNote')}</p>
    </div>
  );
}

/* -------------------------------------------------------------------------------------- Agent */

export function Agent() {
  const t = useT();
  const workspaceId = useWorkspaceId();
  const [params] = useSearchParams();
  const sessionParam = params.get('session');
  const initialSessionId = sessionParam !== null && sessionParam.length > 0 ? sessionParam : null;
  const [tab, setTab] = useState<Tab>('gespraeche');

  if (workspaceId === null) return <NoWorkspaceState />;

  // The page header and the tab strip are the shared primitives now (D118 B2): SurfaceHeader carries
  // the one `<h1>` (and the G17 help glyph, since `help.Agent` is authored), and Tabs is the WAI-ARIA
  // tablist with roving tabindex and arrow keys that the hand-rolled strip lacked.
  const tabs: TabItem[] = [
    { id: 'gespraeche', label: t('agent.tab.gespraeche'), panel: <Gespraeche initialSessionId={initialSessionId} /> },
    { id: 'vorschlaege', label: t('agent.tab.vorschlaege'), panel: <Vorschlaege /> },
    { id: 'vertrauen', label: t('agent.tab.vertrauen'), panel: <Vertrauen /> },
  ];

  return (
    <section className="agent-surface" aria-labelledby="agent-title">
      <SurfaceHeader title={t('agent.title')} titleId="agent-title" help={<SurfaceHelp surface="Agent" />} />
      <Tabs tabs={tabs} activeId={tab} onChange={(id) => setTab(id as Tab)} label={t('agent.title')} />
    </section>
  );
}

export default Agent;
