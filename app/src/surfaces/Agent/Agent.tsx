/**
 * A35, `/agent`: the archive and the evidence, full width, in tabs (design §2b):
 *
 *  - Gespräche (default): sessions newest first (Datum, Client, Schritte, Buchungen, Vorschläge),
 *    each openable to its turns. `-` means no attempt of that kind was made; `0` would mean attempts
 *    were made and none landed: the §3e dash-versus-zero rule, shared with Berechtigungen via ONE
 *    helper. Its empty state (no session ever) deep-links to Verbindung, since connecting a client is
 *    the real next step.
 *  - Vorschläge: every pending drafted action at full width, oldest first (the oldest is the one at
 *    risk of going stale), the SAME card component the dock renders, grouped Geld/System above 20.
 *  - Berechtigungen (was Vertrauen): the ten-row evidence, over a stated window, as the shared
 *    DataTable so the figure columns align cleanly, plus the D103 grant control (owner-gated, absent
 *    without `manage_agent_dial`, never disabled-and-scolding), the strong-default reason, the
 *    stored-vs-effective disagreement rendered when the two differ, and the D-3 suggestion that offers
 *    the grant once and never nags after a decline. Only the rendering changed here, not the trust
 *    semantics: parsing, dial levels and the grant/revoke path are untouched.
 *  - Verbindung: the MCP-first onboarding, sourced from existing reads (`delivery_status`,
 *    `list_agent_sessions`): the runtime mode and endpoint, a copy-paste client config, and the
 *    recently connected clients.
 */
import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import { useT, useI18n, formatDate } from '../../i18n';
import { formatMonth } from '../../lib/format';
import { Status } from '../../components/Status';
import { useClient } from '../../lib/client-context';
import { isErr, type Err } from '../../lib/client';
import { useWorkspaceId } from '../../app/workspace';
import { useCan } from '../../lib/capabilities';
import { EmptyState, ErrorBanner, NoWorkspaceState, Skeleton } from '../../components/states';
import { SurfaceHeader } from '../../components/SurfaceHeader';
import { SurfaceHelp } from '../../components/SurfaceHelp';
import { Tabs, type TabItem } from '../../components/Tabs';
import { DataTable, type DataTableColumn } from '../../components/DataTable';
import { CopyButton } from '../../components/CopyButton';
import { MCP_ENDPOINT } from '../../lib/mcp-transport';
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

type Tab = 'gespraeche' | 'vorschlaege' | 'berechtigungen' | 'verbindung';

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

function Gespraeche({
  initialSessionId,
  onConnect,
}: {
  initialSessionId: string | null;
  onConnect: () => void;
}) {
  const t = useT();
  const { locale } = useI18n();
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

  if (state === 'loading') return <Skeleton rows={5} height={36} />;
  if (state === 'error') return <ErrorBanner error={error} context="read" onRetry={() => void load()} />;
  if (!anyEver) {
    // Connecting an MCP client is the real next step for a workspace with no session yet, not the
    // company profile: the action deep-links to the Verbindung tab on THIS surface (an in-place tab
    // switch), where the copy-paste client config lives.
    return (
      <EmptyState
        title={t('agent.archive.empty.title')}
        hint={t('agent.archive.empty.hint')}
        action={{ label: t('agent.archive.empty.action'), onClick: onConnect }}
      />
    );
  }

  const monthControl = (
    <div className="agent-month" role="group" aria-label={t('agent.archive.month')}>
      <button type="button" className="btn btn--ghost btn--sm" aria-label={t('agent.archive.monthPrev')} onClick={() => setMonth((m) => shiftMonth(m, -1))}>
        <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d="M15 6l-6 6 6 6" /></svg>
      </button>
      {/* K-38: a month is words ("September 2026"), never the 09.2026 slice of a date. */}
      <span className="agent-month-label">{formatMonth(month, locale)}</span>
      <button type="button" className="btn btn--ghost btn--sm" aria-label={t('agent.archive.monthNext')} onClick={() => setMonth((m) => shiftMonth(m, 1))}>
        <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d="M9 6l6 6-6 6" /></svg>
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
      // K-22: the shared Status (a clock glyph plus the word), never the ◔ dingbat.
      render: (row) => (row.open ? <Status kind="pending" label={t('agent.archive.running')} className="agent-running" /> : null),
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

function Vorschlaege({ onConnect }: { onConnect?: () => void }) {
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
  if (state === 'error') return <ErrorBanner error={error} context="read" onRetry={() => void load()} />;
  // The empty state is checked against the SAME list the success state renders (design §3f). K-33:
  // a proposal only ever comes from a connected agent, so the way forward is the connection.
  if (actions.length === 0) {
    return (
      <EmptyState
        title={t('agent.queue.empty')}
        hint={t('agent.queue.emptyHint')}
        action={onConnect !== undefined ? { label: t('agent.archive.empty.action'), onClick: onConnect } : undefined}
      />
    );
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

/* ---------------------------------------------------------------------------- Berechtigungen */

/**
 * The Stufe (level) cell for a Berechtigungen row: the effective level word, plus the muted context
 * that used to live in extra table rows. It stays INSIDE the cell so the evidence a screen reader
 * pairs with the row header (critic F3/CP6) is inside the table:
 *   - the stored-vs-effective disagreement, rendered only when the two differ (row 8.3);
 *   - WHO set the level and when (D103 attribution, critic F3);
 *   - the strong-default reason, when an externally irreversible act asks by default;
 *   - the no-history sentence, so a row nobody has exercised reads as a sentence rather than four
 *     bare dashes (row 7.2). The four figure columns still carry the dash-vs-zero rule via `countCell`.
 */
function StufeCell({ row }: { row: TrustRow }) {
  const t = useT();
  const attempted = row.proposed > 0 || row.autoExecuted > 0;
  const disagree = row.stored !== row.effective;
  const effectiveWord =
    row.strongDefault && row.effective === 'ask'
      ? t('agent.trust.fragtImmer')
      : t(`agent.trust.level.${row.effective}`);
  return (
    <div className="agent-trust-stufe">
      <span>
        {effectiveWord}
        {disagree && (
          <span className="agent-trust-disagree">
            {' '}
            {t('agent.trust.storedVsEffective', {
              stored: t(`agent.trust.level.${row.stored}`),
              effective: effectiveWord,
            })}
          </span>
        )}
        {/* Critic F3: WHO set the level, ON the screen that governs grants. D103 is "attributed,
            revocable, fail-closed", and the attribution renders where the revocation control sits. */}
        {row.updatedBy !== null && (
          <span className="agent-trust-grantedby">
            {' '}
            {t('agent.trust.grantedBy', {
              actor: row.updatedBy,
              date: row.updatedAt !== null ? dateOf(row.updatedAt) : '',
            })}
          </span>
        )}
      </span>
      {row.strongDefault && row.effective === 'ask' && (
        <span className="agent-trust-nohistory">{t('agent.trust.strongReason')}</span>
      )}
      {/* Zero activity is a SENTENCE, never zeroes that look like failures (row 7.2). */}
      {!attempted && <span className="agent-trust-nohistory">{t('agent.trust.noHistory')}</span>}
    </div>
  );
}

interface TrustGroupProps {
  heading: string;
  rows: TrustRow[];
  canDecide: boolean;
  busy: boolean;
  confirming: string | null;
  setConfirming: (capability: string | null) => void;
  onSetLevel: (capability: string, level: 'ask' | 'auto') => void;
  workspaceId: string;
  /** Bumped after a suggestion dismissal so the group re-renders. Read only for that dependency. */
  dismissed: number;
  onDismiss: (capability: string) => void;
}

/**
 * One governed group (Geld or System) as the shared DataTable, so the figure columns align cleanly
 * and right-align their tabular numbers. The D103 ceremonies (the grant-confirm and the D-3
 * suggestion) render directly beneath the table, each naming its capability, because DataTable's flat
 * model has no per-row sub-row: keeping them below the aligned grid is what lets the grid stay clean.
 * The per-row grant/revoke control lives in the action column; `manage_agent_dial` gates every control
 * (absent, never disabled-and-scolding) and no ceremony ever appears without it.
 */
function TrustGroup({
  heading,
  rows,
  canDecide,
  busy,
  confirming,
  setConfirming,
  onSetLevel,
  workspaceId,
  dismissed,
  onDismiss,
}: TrustGroupProps) {
  const t = useT();
  const columns: DataTableColumn<TrustRow>[] = [
    { key: 'was', header: t('agent.trust.col.was'), rowHeader: true, render: (row) => t(`agent.capability.${row.capability}`) },
    { key: 'stufe', header: t('agent.trust.col.stufe'), render: (row) => <StufeCell row={row} /> },
    { key: 'vorgeschlagen', header: t('agent.trust.col.vorgeschlagen'), numeric: true, render: (row) => countCell(row.proposed, row.proposed > 0 || row.autoExecuted > 0) },
    { key: 'genehmigt', header: t('agent.trust.col.genehmigt'), numeric: true, render: (row) => countCell(row.approved, row.proposed > 0) },
    { key: 'abgelehnt', header: t('agent.trust.col.abgelehnt'), numeric: true, render: (row) => countCell(row.rejected, row.proposed > 0) },
    { key: 'automatisch', header: t('agent.trust.col.automatisch'), numeric: true, render: (row) => countCell(row.autoExecuted, row.autoExecuted > 0) },
    {
      key: 'aktion',
      header: t('agent.trust.col.aktion'),
      headerHidden: true,
      render: (row) =>
        !canDecide ? null : row.effective === 'auto' ? (
          <button type="button" className="btn btn--secondary btn--sm" disabled={busy} onClick={() => onSetLevel(row.capability, 'ask')}>
            {t('agent.trust.revokeAction')}
          </button>
        ) : (
          <button type="button" className="btn btn--secondary btn--sm" disabled={busy} onClick={() => setConfirming(row.capability)}>
            {t('agent.trust.grantAction')}
          </button>
        ),
    },
  ];

  return (
    <>
      <h2 className="agent-group-head">{heading}</h2>
      <DataTable columns={columns} rows={rows} rowKey={(row) => row.capability} caption={t('agent.trust.caption', { group: heading })} />
      {rows.map((row) => {
        const isConfirming = confirming === row.capability;
        // D-3: the suggestion offers the grant once and never nags again after a decline, per
        // capability, per workspace. `dismissed` is read only to force a re-render after the write.
        const suggest = canDecide && row.suggestGrant && !isSuggestionDismissed(workspaceId, row.capability) && dismissed >= 0;
        if (!isConfirming && !suggest) return null;
        const label = t(`agent.capability.${row.capability}`);
        return (
          <div key={row.capability} className="agent-trust-ceremony">
            {isConfirming ? (
              <>
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
              </>
            ) : (
              <>
                <p className="agent-trust-ceremony-label">{label}</p>
                <p>{t('agent.trust.suggest', { approved: row.approved, proposed: row.proposed })}</p>
                <div className="vorschlag-confirm-actions">
                  <button type="button" className="btn btn--secondary btn--sm" disabled={busy} onClick={() => setConfirming(row.capability)}>
                    {t('agent.trust.grantAction')}
                  </button>
                  <button type="button" className="btn btn--ghost btn--sm" onClick={() => onDismiss(row.capability)}>
                    {t('agent.trust.suggestDismiss')}
                  </button>
                </div>
              </>
            )}
          </div>
        );
      })}
    </>
  );
}

function Berechtigungen() {
  const t = useT();
  const client = useClient();
  const workspaceId = useWorkspaceId();
  const canDecide = useCan('manage_agent_dial');
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<Err | undefined>(undefined);
  const [trust, setTrust] = useState<TrustSummary | null>(null);
  const [busy, setBusy] = useState(false);
  // The ceremony state lives on the surface (not per group) so a confirm and its evidence share one
  // owner: `confirming` is at most one capability at a time, `dismissed` bumps after a dismissal.
  const [confirming, setConfirming] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(0);

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

  const dismiss = useCallback(
    (capability: string) => {
      dismissSuggestion(workspaceId ?? '', capability);
      setDismissed((v) => v + 1);
    },
    [workspaceId],
  );

  if (state === 'loading') return <Skeleton rows={8} height={32} />;
  if (state === 'error' || trust === null) return <ErrorBanner error={error} context="read" onRetry={() => void load()} />;

  const byCapability = new Map(trust.rows.map((row) => [row.capability, row]));
  const geld = GELD_CAPABILITIES.map((c) => byCapability.get(c)).filter((r): r is TrustRow => r !== undefined);
  const system = SYSTEM_CAPABILITIES.map((c) => byCapability.get(c)).filter((r): r is TrustRow => r !== undefined);
  const groupProps = {
    canDecide,
    busy,
    confirming,
    setConfirming,
    onSetLevel: (c: string, l: 'ask' | 'auto') => void setLevel(c, l),
    workspaceId: workspaceId ?? '',
    dismissed,
    onDismiss: dismiss,
  };

  return (
    <div className="agent-trust">
      {/* Every figure's window, on the same screen as every figure it governs (row 7.3). */}
      <p className="agent-trust-window">
        {t('agent.trust.window', { from: dateOf(trust.window.from), to: dateOf(trust.window.to) })}
      </p>
      <TrustGroup heading={t('agent.queue.group.geld')} rows={geld} {...groupProps} />
      <TrustGroup heading={t('agent.queue.group.system')} rows={system} {...groupProps} />
      {/* Row 10.1: the trace is never offered as a statutory export, and the surface says where that lives. */}
      <p className="agent-trust-statutory">{t('agent.trust.statutoryNote')}</p>
    </div>
  );
}

/* -------------------------------------------------------------------------------- Verbindung */

/** The slice of `delivery_status` this panel needs, parsed defensively. */
interface ConnStatus {
  mode: string;
  host: string | null;
  port: number | null;
}

/**
 * The runtime-mode copy keys, reused from `RuntimeLine`'s catalogue (a plain lookup, not a mirror of
 * the engine enum) so the wording matches the FirstRun runtime line without importing that component.
 * `RuntimeLine` is deliberately NOT mounted here: it reads `status.scheduler.enabled` without guarding
 * a partial body, and this panel is always mounted (Tabs keeps every panel alive), so a `delivery_status`
 * that ever came back without a scheduler would crash the whole surface. The rest of `/agent` never
 * crashes on a shape it cannot read (see `model.ts`), and this line holds to that: `delivery_status`
 * is parsed defensively and an unknown mode falls back to its raw string.
 */
const MODE_KEYS: Record<string, string> = {
  up: 'runtime.mode.up',
  mcp: 'runtime.mode.mcp',
  serve: 'runtime.mode.serve',
  agent_session: 'runtime.mode.agent_session',
};

/**
 * Verbindung, the MCP-first onboarding: how to point an external MCP client (Claude Desktop, Cursor)
 * at this TILL, sourced entirely from EXISTING reads (no new verb).
 *
 *  - the runtime line reads `delivery_status` for the current mode;
 *  - the endpoint line reads `delivery_status` for host/port and shows `http://<host>:<port>/mcp`
 *    when TILL exposes a server, or explains the stdio start (`till mcp`) when it runs over stdio;
 *  - the config block is the copy-paste `mcpServers` entry the user drops into their client. TILL
 *    cannot write the client's config file, and the copy says so: this is the quick setup, not an
 *    auto-write;
 *  - the recent client labels come from `list_agent_sessions`, the read the Gespräche tab uses.
 */
function Verbindung() {
  const t = useT();
  const client = useClient();
  const workspaceId = useWorkspaceId();
  const [status, setStatus] = useState<ConnStatus | null>(null);
  const [clients, setClients] = useState<string[] | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      const res = await client.call('delivery_status');
      if (!live) return;
      if (!isErr(res.body)) {
        const body = res.body as unknown as { mode?: unknown; host?: unknown; port?: unknown };
        setStatus({
          mode: typeof body.mode === 'string' ? body.mode : '',
          host: typeof body.host === 'string' ? body.host : null,
          port: typeof body.port === 'number' ? body.port : null,
        });
      }
    })();
    return () => {
      live = false;
    };
  }, [client]);

  useEffect(() => {
    if (workspaceId === null) return;
    let live = true;
    void (async () => {
      const res = await client.call('list_agent_sessions', { workspaceId });
      if (!live) return;
      if (isErr(res.body)) {
        setClients([]);
        return;
      }
      // Distinct client labels, newest first (the read is already newest-first), a handful at most.
      const seen = new Set<string>();
      const labels: string[] = [];
      for (const row of parseSessions(res.body)) {
        if (row.clientLabel !== null && !seen.has(row.clientLabel)) {
          seen.add(row.clientLabel);
          labels.push(row.clientLabel);
        }
        if (labels.length >= 6) break;
      }
      setClients(labels);
    })();
    return () => {
      live = false;
    };
  }, [client, workspaceId]);

  // The copy-paste stdio entry: a client (Claude Desktop, Cursor) starts TILL with `till mcp`. The
  // exact string is what lands on the clipboard; pretty-printed so it pastes cleanly into a config.
  const stdioConfig = [
    '{',
    '  "mcpServers": {',
    '    "till": {',
    '      "command": "till",',
    '      "args": ["mcp"]',
    '    }',
    '  }',
    '}',
  ].join('\n');
  const httpUrl =
    status !== null && status.host !== null && status.port !== null
      ? `http://${status.host}:${status.port}${MCP_ENDPOINT}`
      : null;

  const modeLabel =
    status === null || status.mode === ''
      ? null
      : MODE_KEYS[status.mode] !== undefined
        ? t(MODE_KEYS[status.mode])
        : status.mode;

  return (
    <div className="agent-connect">
      <p className="agent-connect-intro">{t('agent.connect.intro')}</p>
      {modeLabel !== null && (
        <p className="agent-connect-mode">{t('runtime.mode.label', { mode: modeLabel })}</p>
      )}

      <section className="agent-connect-section">
        <h2 className="agent-group-head">{t('agent.connect.endpoint.heading')}</h2>
        {status === null ? null : httpUrl !== null ? (
          <p className="agent-connect-line">
            {t('agent.connect.endpoint.http')} <code className="agent-connect-url">{httpUrl}</code>
            <CopyButton value={httpUrl} label={t('agent.connect.endpoint.copyUrl')} />
          </p>
        ) : status.mode === 'mcp' ? (
          <p className="agent-connect-line">{t('agent.connect.endpoint.stdio')}</p>
        ) : (
          <p className="agent-connect-line">{t('agent.connect.endpoint.unknown')}</p>
        )}
      </section>

      <section className="agent-connect-section">
        <h2 className="agent-group-head">{t('agent.connect.config.heading')}</h2>
        <p className="agent-connect-hint">{t('agent.connect.config.hint')}</p>
        <div className="agent-connect-config">
          <pre className="agent-connect-code">
            <code>{stdioConfig}</code>
          </pre>
          <CopyButton value={stdioConfig} label={t('agent.connect.config.copy')} />
        </div>
      </section>

      <section className="agent-connect-section">
        <h2 className="agent-group-head">{t('agent.connect.clients.heading')}</h2>
        {clients === null ? null : clients.length > 0 ? (
          <ul className="agent-connect-clients">
            {clients.map((label) => (
              <li key={label}>{label}</li>
            ))}
          </ul>
        ) : (
          <p className="agent-connect-empty">{t('agent.connect.clients.empty')}</p>
        )}
      </section>
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
    {
      id: 'gespraeche',
      label: t('agent.tab.gespraeche'),
      // The empty-state deep-links to Verbindung (connect a client is the real next step): an in-place
      // tab switch, not a route change, so no new routed surface is introduced.
      panel: <Gespraeche initialSessionId={initialSessionId} onConnect={() => setTab('verbindung')} />,
    },
    { id: 'vorschlaege', label: t('agent.tab.vorschlaege'), panel: <Vorschlaege onConnect={() => setTab('verbindung')} /> },
    { id: 'berechtigungen', label: t('agent.tab.berechtigungen'), panel: <Berechtigungen /> },
    { id: 'verbindung', label: t('agent.tab.verbindung'), panel: <Verbindung /> },
  ];

  return (
    <section className="agent-surface" aria-labelledby="agent-title">
      <SurfaceHeader title={t('agent.title')} titleId="agent-title" help={<SurfaceHelp surface="Agent" />} />
      <Tabs tabs={tabs} activeId={tab} onChange={(id) => setTab(id as Tab)} label={t('agent.title')} />
    </section>
  );
}

export default Agent;
