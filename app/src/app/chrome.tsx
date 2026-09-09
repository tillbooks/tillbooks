/**
 * G16, the shell's chrome slots and their reserved providers.
 *
 * THE SLOT CONTRACT (design §6b): a named slot has a fixed position and a height budget; **absence
 * renders nothing** (no placeholder, no "coming soon"); no slot may delay the rail's first paint; and
 * each slot occupant sits behind an error boundary that degrades ONLY that slot. Reserved providers
 * (`AgentPendingProvider`, `NotificationsProvider`) default to "no data", so until A35 / G06 wire a
 * real reader the slot is silent, which is the honest state and not a gap.
 */
import { Component, createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

import { useT } from '../i18n';
import { useFeedback } from '../components/FeedbackProvider';
import { EgressIndicator } from '../components/EgressIndicator';
import { useClient } from '../lib/client-context';
import { isErr } from '../lib/client';
import { useWorkspaceId } from './workspace';

/* ------------------------------------------------------------------ the per-slot error boundary */

/** The compact, reportable fallback a broken slot degrades to (design §3f). */
function SlotError({ slot }: { slot: string }) {
  const t = useT();
  const feedback = useFeedback();
  return (
    <div className="slot-error" role="status">
      <span className="slot-error-text">{t('shell.slotError')}</span>
      {feedback !== null && (
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={() => feedback.open({ kind: 'bug', subject: slot })}
        >
          {t('crash.action.report')}
        </button>
      )}
    </div>
  );
}

/**
 * Keep one broken fragment from taking the shell down with it (design §3f), mirroring the router's
 * own per-route `RouteCrash`. A thrown slot renders `SlotError`; every other slot and the rail keep
 * working.
 */
export class SlotBoundary extends Component<{ slot: string; children: ReactNode }, { failed: boolean }> {
  constructor(props: { slot: string; children: ReactNode }) {
    super(props);
    this.state = { failed: false };
  }
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  render() {
    if (this.state.failed) return <SlotError slot={this.props.slot} />;
    return this.props.children;
  }
}

/* --------------------------------------------------------------- the agent pending-approval count */

/**
 * A35's pending-approvals count. `null` means "no provider or unknown", and an unknown count renders
 * ABSENT, never `0` (data honesty, design story 11.3). Reserved here; A35 supplies the real reader.
 */
const AgentPendingContext = createContext<number | null>(null);

export function AgentPendingProvider({ count, children }: { count: number | null; children: ReactNode }) {
  return <AgentPendingContext.Provider value={count}>{children}</AgentPendingContext.Provider>;
}

export function useAgentPending(): number | null {
  return useContext(AgentPendingContext);
}

/** The count badge on the `/agent` rail entry. Renders nothing at zero or when unknown. */
export function AgentBadge() {
  const t = useT();
  const count = useAgentPending();
  if (count === null || count <= 0) return null;
  const shown = count > 99 ? '99+' : String(count);
  return (
    <span className="rail-badge" title={t('shell.agent.pending', { count: shown })}>
      {shown}
    </span>
  );
}

/* ------------------------------------------------------------- the G15 attention count (railAttention) */

/**
 * G15's rail count, filling the reserved `railAttention` slot (design §3b). It reads the one
 * `attention_summary` for the active workspace and renders the total as TEXT plus a neutral glyph,
 * spending ZERO accent. Four distinguishable states, so a glance can tell "all clear" from "not
 * loaded" (design story 4.2): a muted PIP while loading (no reflow when the number lands), a `-` for a
 * TRUE zero, a muted WARNING glyph on failure (which CLEARS any previous number rather than leaving a
 * stale one), and the number otherwise (`99+` past the cap). When `visibleQueues == 0` the total is
 * null and the row renders label-only, because hiding it would leave the padlock unreachable (story
 * 4.5); the row still opens the hub. On a workspace switch the count clears BEFORE the new one arrives
 * and an in-flight answer for a no-longer-active workspace is discarded (stories 6.1, 6.2).
 */
type AttentionCount = { status: 'loading' | 'error'; total: null } | { status: 'ok'; total: number | null };

export function AttentionBadge() {
  const t = useT();
  const client = useClient();
  const workspaceId = useWorkspaceId();
  const [state, setState] = useState<AttentionCount>({ status: 'loading', total: null });
  const active = useRef<string | null>(workspaceId);

  useEffect(() => {
    active.current = workspaceId;
    if (workspaceId === null) {
      setState({ status: 'ok', total: null });
      return;
    }
    // Clear the previous client's number before the new one arrives (never a stale count).
    setState({ status: 'loading', total: null });
    let cancelled = false;
    void (async () => {
      const res = await client.call('attention_summary', { workspaceId, topLimit: 1 });
      if (cancelled || active.current !== workspaceId) return; // a switch overtook it: discard.
      if (isErr(res.body)) {
        setState({ status: 'error', total: null });
        return;
      }
      const total = (res.body as { total?: unknown }).total;
      setState({ status: 'ok', total: typeof total === 'number' ? total : null });
    })();
    return () => {
      cancelled = true;
    };
  }, [client, workspaceId]);

  if (state.status === 'loading') {
    // A muted pip of the number's own width: visibly "not yet", and no reflow when the number lands.
    // `role="img"` so the `aria-label` is a permitted attribute (a bare span may not carry one).
    return (
      <span className="rail-badge rail-badge--pip" role="img" aria-label={t('attention.rail.loading')}>
        <span aria-hidden="true">·</span>
      </span>
    );
  }
  if (state.status === 'error') {
    return (
      <span className="rail-badge rail-badge--warn" role="img" aria-label={t('attention.rail.error')}>
        <span aria-hidden="true">!</span>
      </span>
    );
  }
  // ok: total === null is the denied case (label only). Zero renders NOTHING (F-05, friction ledger
  // Phase 2): the badge shows a count or is absent, never a placeholder glyph. The dash it used to
  // render on an empty queue read as a broken figure beside a strip that said nothing waits.
  if (state.total === null || state.total === 0) return null;
  const shown = state.total > 99 ? '99+' : String(state.total);
  return (
    <span className="rail-badge rail-badge--attention" role="img" aria-label={t('attention.rail.count', { count: shown })}>
      {shown}
    </span>
  );
}

/* ---------------------------------------------------------------------------- the G06 bell (slot) */

/** A reserved notifications reader. `null` (the default) renders no bell at all (G06 not wired). */
const NotificationsContext = createContext<{ unread: number } | null>(null);

export function NotificationsProvider({
  value,
  children,
}: {
  value: { unread: number } | null;
  children: ReactNode;
}) {
  return <NotificationsContext.Provider value={value}>{children}</NotificationsContext.Provider>;
}

/** The G06 bell in the rail footer utility cluster. Silent (renders `null`) until G06 provides a reader. */
export function NotificationBell() {
  const provider = useContext(NotificationsContext);
  if (provider === null) return null; // no occupant: the slot emits no DOM.
  const { unread } = provider;
  return (
    <span className="rail-bell" aria-label={String(unread)}>
      <span aria-hidden="true">◔</span>
      {unread > 0 && <span className="rail-badge">{unread > 99 ? '99+' : unread}</span>}
    </span>
  );
}

/* ----------------------------------------------------------------- the E07 trust indicator (slot) */

/**
 * The E07 trust indicator in the rail footer. The shell wires no live `egress_status` reader (that is
 * E07's), so the resting HONEST state is `local` ("Lokal, keine Verbindung"), the same component the
 * Setup Vertrauen panel uses. It spends zero accent and carries glyph plus text, never colour alone.
 */
export function TrustSlot() {
  const t = useT();
  return <EgressIndicator state="local" label={t('egress.indicator.local')} iconOnly />;
}
