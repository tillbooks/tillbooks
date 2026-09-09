/**
 * The A35 dock (D90 D-2): a 380px right viewport onto what the agent is doing NOW, beside the work
 * it is doing it to. PUSH, never overlay (it is a flex sibling of `<main>`); collapsed by default
 * and remembered per workspace; below the 960px main floor the open dock takes the content area and
 * offers the route instead (CSS). The D102 sentence in brand/DESIGN.md is this component's law: a
 * viewport onto work in progress, never a place where work is done: no tables, no filters, no
 * settings here.
 *
 * With ZERO sessions ever, the dock emits NO DOM at all: no toggle, no "coming soon" (G16 guarantee
 * 2, design row 1.4). Without `read_books` it is hidden rather than padlocked (a padlock in a 380px
 * slot on every screen is a permanent scold). On a workspace switch every rendered turn, card and
 * pending confirm is discarded before the new client's data arrives (§H-TENANT as a UI property).
 *
 * The composer renders at the foot ONLY when E05 reports a registered runtime (D90 D-1, row 14.2):
 * the no-runtime state renders no input anywhere, with one line naming where conversation happens
 * today. Submitting calls `agent_ask`, whose executed verb is always a read.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

import { useT } from '../../i18n';
import { useClient } from '../../lib/client-context';
import { isErr } from '../../lib/client';
import { useWorkspaceId } from '../../app/workspace';
import { useCan } from '../../lib/capabilities';
import { useKeyboard } from '../../app/keyboard';
import { useIdempotencyKey } from '../../lib/idempotency';
import { TurnList } from './TurnList';
import { VorschlagCard } from './VorschlagCard';
import {
  parseDrafted,
  parseSessionDetail,
  parseSessions,
  readDockOpen,
  writeDockOpen,
  type AgentSessionDetail,
  type DraftedAction,
} from './model';
import './Agent.css';

/** How often the open dock refreshes its live view. Quiet, local, and only while open. */
const POLL_MS = 10_000;

export function AgentDock() {
  const t = useT();
  const client = useClient();
  const workspaceId = useWorkspaceId();
  const canRead = useCan('read_books');
  // C1 (D118): the palette's "Frag den Agenten" lane asks the dock to open onto the answer it just
  // posted. The provider carries the request as a monotonic counter; the dock acts once per increment.
  const { agentDockRequest } = useKeyboard();
  const handledRequest = useRef(agentDockRequest);

  const [hasSessions, setHasSessions] = useState(false);
  const [open, setOpen] = useState(false);
  const [session, setSession] = useState<AgentSessionDetail | null>(null);
  const [pending, setPending] = useState<DraftedAction[]>([]);
  const [runtimeReady, setRuntimeReady] = useState(false);
  const [composerText, setComposerText] = useState('');
  const [busy, setBusy] = useState(false);
  const activeWorkspace = useRef<string | null>(workspaceId);
  // One key per QUESTION (the shared idempotency law): an unchanged question re-sent after a lost
  // response is one write; an edited question is a new one.
  const askKey = useIdempotencyKey([workspaceId, composerText.trim()]);

  const refresh = useCallback(async () => {
    if (workspaceId === null) return;
    const ws = workspaceId;
    const sessions = await client.call('list_agent_sessions', { workspaceId: ws });
    if (activeWorkspace.current !== ws) return; // a switch overtook the answer: discard it.
    if (isErr(sessions.body)) return;
    const rows = parseSessions(sessions.body);
    setHasSessions(rows.length > 0);
    if (rows.length === 0) {
      setSession(null);
      setPending([]);
      return;
    }
    const newest = rows[0];
    const [detail, queue, runtime] = await Promise.all([
      client.call('get_agent_session', { workspaceId: ws, sessionId: newest.sessionId }),
      client.call('list_drafted_actions', { workspaceId: ws }),
      client.call('runtime_status', { workspaceId: ws }),
    ]);
    if (activeWorkspace.current !== ws) return;
    if (!isErr(detail.body)) setSession(parseSessionDetail(detail.body));
    if (!isErr(queue.body)) setPending(parseDrafted(queue.body));
    setRuntimeReady(!isErr(runtime.body) && (runtime.body as { registered?: unknown }).registered === true);
  }, [client, workspaceId]);

  // Re-scope on a workspace switch: discard everything BEFORE the new client's data arrives.
  useEffect(() => {
    activeWorkspace.current = workspaceId;
    setSession(null);
    setPending([]);
    setHasSessions(false);
    setBusy(false);
    setComposerText('');
    setOpen(workspaceId !== null && readDockOpen(workspaceId));
    if (workspaceId !== null && canRead) void refresh();
  }, [workspaceId, canRead, refresh]);

  // The live view: poll only while open.
  useEffect(() => {
    if (!open || workspaceId === null || !canRead) return;
    const timer = window.setInterval(() => void refresh(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [open, workspaceId, canRead, refresh]);

  // C1: the palette asked to open the dock onto a fresh answer. Open it, remember the choice, and
  // refresh so the new turn is shown. Guarded so it never fires on mount or on a stale counter, and
  // never without a workspace or the read right (the dock stays silent where it would emit no DOM).
  useEffect(() => {
    if (agentDockRequest === handledRequest.current) return;
    handledRequest.current = agentDockRequest;
    if (workspaceId === null || !canRead) return;
    setOpen(true);
    writeDockOpen(workspaceId, true);
    void refresh();
  }, [agentDockRequest, workspaceId, canRead, refresh]);

  const toggle = useCallback(() => {
    if (workspaceId === null) return;
    setOpen((v) => {
      writeDockOpen(workspaceId, !v);
      return !v;
    });
  }, [workspaceId]);

  const approve = useCallback(
    async (actionId: string, allowFuture: boolean) => {
      if (workspaceId === null || busy) return;
      setBusy(true);
      await client.call('approve_drafted_action', { workspaceId, actionId, ...(allowFuture ? { allowFuture: true } : {}) });
      setBusy(false);
      void refresh();
    },
    [busy, client, refresh, workspaceId],
  );

  const reject = useCallback(
    async (actionId: string, reason?: string) => {
      if (workspaceId === null || busy) return;
      setBusy(true);
      await client.call('reject_drafted_action', { workspaceId, actionId, ...(reason !== undefined ? { reason } : {}) });
      setBusy(false);
      void refresh();
    },
    [busy, client, refresh, workspaceId],
  );

  const ask = useCallback(async () => {
    const text = composerText.trim();
    if (workspaceId === null || text.length === 0 || busy) return;
    setBusy(true);
    await client.call('agent_ask', { workspaceId, text, idempotencyKey: askKey });
    setBusy(false);
    setComposerText('');
    void refresh();
  }, [askKey, busy, client, composerText, refresh, workspaceId]);

  // Row 1.4 / guarantee 2: with no workspace, no read right, or no session ever, the dock emits no DOM.
  if (workspaceId === null || !canRead || !hasSessions) return null;

  if (!open) {
    return (
      <button type="button" className="agent-dock-toggle" onClick={toggle} aria-expanded={false}>
        <span className="agent-dock-toggle-label">{t('agent.dock.toggle')}</span>
        {pending.length > 0 && <span className="rail-badge">{pending.length > 99 ? '99+' : pending.length}</span>}
      </button>
    );
  }

  const startTime = session !== null && session.startedAt.length >= 16 ? session.startedAt.slice(11, 16) : '';
  const newestPendingId = pending.length > 0 ? pending[pending.length - 1].actionId : null;

  return (
    <aside className="agent-dock" aria-label={t('agent.title')}>
      <header className="agent-dock-head">
        <div>
          <p className="agent-dock-session">{t('agent.dock.session')}</p>
          <p className="agent-dock-client">
            {session?.clientLabel ?? t('agent.archive.unknownClient')}
            {' · '}
            {t('agent.dock.since', { time: startTime })}
            {session?.open === true && <> · {t('agent.dock.running')}</>}
          </p>
        </div>
        <div className="agent-dock-head-actions">
          <Link className="btn btn--ghost btn--sm" to="/agent">
            {t('agent.dock.openArchive')}
          </Link>
          <button type="button" className="btn btn--ghost btn--sm" onClick={toggle} aria-expanded>
            {t('agent.dock.close')}
          </button>
        </div>
      </header>

      {/* Below the 960px main floor CSS hides <main> and this row is the way to the full page. */}
      <p className="agent-dock-narrow">
        {t('agent.dock.narrowHint')} <Link to="/agent">{t('agent.dock.openArchive')}</Link>
      </p>

      <div className="agent-dock-body">
        {session === null || session.turns.length === 0 ? (
          <p className="agent-dock-empty">{t('agent.dock.empty')}</p>
        ) : (
          <TurnList turns={session.turns} />
        )}
        {pending.map((action) => (
          <VorschlagCard
            key={action.actionId}
            action={action}
            accent={action.actionId === newestPendingId}
            onApprove={(id, allow) => void approve(id, allow)}
            onReject={(id, reason) => void reject(id, reason)}
            busy={busy}
          />
        ))}
      </div>

      <footer className="agent-dock-foot">
        {runtimeReady ? (
          <form
            className="agent-composer"
            onSubmit={(event) => {
              event.preventDefault();
              void ask();
            }}
          >
            <input
              type="text"
              className="agent-composer-input"
              value={composerText}
              placeholder={t('agent.dock.composerPlaceholder')}
              aria-label={t('agent.dock.composerPlaceholder')}
              onChange={(event) => setComposerText(event.target.value)}
            />
            <button type="submit" className="btn btn--secondary btn--sm" disabled={busy || composerText.trim().length === 0}>
              {t('agent.dock.composerSend')}
            </button>
          </form>
        ) : (
          // Row 14.2: no configured runtime, NO text input anywhere, one line naming where
          // conversation happens today.
          <p className="agent-dock-noruntime">{t('agent.dock.noRuntime')}</p>
        )}
      </footer>
    </aside>
  );
}
