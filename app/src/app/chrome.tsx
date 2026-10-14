/**
 * G16, the shell's chrome slots and their reserved providers.
 *
 * THE SLOT CONTRACT (design §6b): a named slot has a fixed position and a height budget; **absence
 * renders nothing** (no placeholder, no "coming soon"); no slot may delay the rail's first paint; and
 * each slot occupant sits behind an error boundary that degrades ONLY that slot. Reserved providers
 * (`AgentPendingProvider`, `NotificationsProvider`) default to "no data", so until A35 / G06 wire a
 * real reader the slot is silent, which is the honest state and not a gap.
 */
import { Component, createContext, useContext, type ReactNode } from 'react';

import { useT } from '../i18n';
import { useFeedback } from '../components/FeedbackProvider';
import { useAttentionSummary } from '../surfaces/Attention/attentionSummary';

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
    // A real accessible name, never the `title` attribute (DESIGN.md, Interaction: real tooltips).
    <span className="rail-badge" role="img" aria-label={t('shell.agent.pending', { count: shown })}>
      {shown}
    </span>
  );
}

/* ------------------------------------------------------------- the G15 attention count (railAttention) */

/**
 * G15's rail count, filling the reserved `railAttention` slot (design §3b). It reads the one
 * `attention_summary` for the active workspace and renders the total as TEXT plus a neutral glyph,
 * spending ZERO accent. It shows a count or nothing (F-05, K-02 D137): NOTHING while loading and
 * nothing for a true zero (a placeholder glyph beside the label read as a broken figure), a muted
 * WARNING glyph on failure (which CLEARS any previous number rather than leaving a stale one), and
 * the number otherwise (`99+` past the cap). When `visibleQueues == 0` the total is
 * null and the row renders label-only, because hiding it would leave the padlock unreachable (story
 * 4.5); the row still opens the hub. On a workspace switch the count clears BEFORE the new one arrives
 * and an in-flight answer for a no-longer-active workspace is discarded (stories 6.1, 6.2).
 *
 * LIVE since 30.09.2026: the count is the shared store's (`useAttentionSummary`), the SAME read the
 * Übersicht list renders, refreshed every minute while the tab is visible, on focus, and right after an
 * act on the hub. A refresh is quiet (the number stays until the next one lands).
 */
export type AttentionBadgeState = { kind: 'none' } | { kind: 'error' } | { kind: 'count'; shown: string };

/** What the rail shows for the waiting work: a count, the failure glyph, or nothing. */
export function useAttentionBadge(): AttentionBadgeState {
  const state = useAttentionSummary();
  // K-02 (D137): while the count is on its way the badge renders NOTHING. The muted pip it used to
  // show read as a stray dot beside "Pendenzen" for the first second of every load; the badge now
  // shows a count or is absent (the F-05 rule), and the row does not reflow because the badge sits
  // at the row's end, outside the label's measure.
  if (state.status === 'error') return { kind: 'error' };
  if (state.status !== 'ok') return { kind: 'none' };
  // ok: total === null is the denied case (label only). Zero renders NOTHING (F-05, friction ledger
  // Phase 2): the badge shows a count or is absent, never a placeholder glyph. The dash it used to
  // render on an empty queue read as a broken figure beside a strip that said nothing waits.
  const total = state.data.total;
  if (total === null || total === 0) return { kind: 'none' };
  return { kind: 'count', shown: total > 99 ? '99+' : String(total) };
}

/** The words of a badge state, for an accessible name: the count is never colour or position alone. */
export function attentionBadgeName(t: (key: string, params?: Record<string, string | number>) => string, badge: AttentionBadgeState): string | null {
  if (badge.kind === 'error') return t('attention.rail.error');
  if (badge.kind === 'count') return t('attention.rail.count', { count: badge.shown });
  return null;
}

export function AttentionBadge() {
  const t = useT();
  const badge = useAttentionBadge();
  if (badge.kind === 'none') return null;
  if (badge.kind === 'error') {
    return (
      <span className="rail-badge rail-badge--warn" role="img" aria-label={t('attention.rail.error')}>
        <span aria-hidden="true">!</span>
      </span>
    );
  }
  return (
    <span className="rail-badge rail-badge--attention" role="img" aria-label={t('attention.rail.count', { count: badge.shown })}>
      {badge.shown}
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

/* The E07 trust indicator is no longer a slot of its own: since K-01 (D137) the egress state is the
   dot of the environment pill (`RailStatusMenu`), with its words in the pill's accessible name and in
   the pill's menu, so the footer stays one row. */
