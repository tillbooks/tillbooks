/**
 * D142 + D143, the Übersicht's "Bankeingang" band, in its minimal form (mockup v3, the owner's
 * "reduce to max"): the day's bank work in one full-width row between the attention strip and the tile
 * grid. Not a ninth tile: a tile is a figure, this is a queue with its own doors (A36 §12, A39 §11).
 *
 * LEFT: the caption "Bank", then the HEADLINE: the lines that wait for a person, with its words visible
 * ("2 Buchungen warten auf dich", the door to `/bank?facet=needs`; D150, 01.10.2026: "Bank 2" read as
 * "two fetches worked"), the open total as secondary text ("4 offen", the door to `/bank`), and with
 * nothing waiting "Nichts wartet auf dich · 4 offen", never a bare 0. Then two facets, each an outline
 * icon plus a number and no visible word (owner correction, 29.09.2026): a check mark (sicher
 * vorgeschlagen), a paperclip with a slash (ohne Beleg). Their words live in `aria-label` and `title`.
 * A facet at 0 stays visible, dimmed, and is not a link.
 *
 * RIGHT, per EBICS channel: the bank's short name with an 8 px status dot (or, during the activation,
 * the four C1 pips), and one icon-only refresh button. The colour is the whole visible status: warn
 * while waiting or when the keys need review, success when active, danger on a fault, faint when the
 * automatic fetch is off. The mark is a button whose `aria-label` IS the state in words, so meaning is
 * never colour alone for assistive tech; hovering or focusing it opens a card with the rest: the state,
 * the last and next fetch or check, the four steps during setup, and the one action when one is needed.
 *
 * EVERY FIGURE IS THE ENGINE'S. One read, `dashboard_tile` for `bank_inbox`, brings the counts (the SAME
 * per-line definitions `/bank` filters by) and per channel the facts the lamp words (the fetch, the
 * daily automatic fetch, the D143 activation check, the keystore, the statement gaps of A36 §4.7). The
 * band composes.
 */
import { useCallback, useEffect, useId, useRef, useState, type FocusEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';

import { useClient } from '../../lib/client-context';
import { isErr, type Err } from '../../lib/client';
import { CAP, useCan } from '../../lib/capabilities';
import { useWorkspaceId } from '../../app/workspace';
import { useT, formatDate } from '../../i18n';
import { useSkeletonHold } from '../../components/states/useSkeletonTiming';
import { COMMITTED_ATTR, commitAck } from '../../lib/motion';
import { channelRefusal, numberJumpText, returnCodeText, type NumberJump } from '../BankAccounts/channelWording';
import { gapExplanation, gapRepairHref, gapTitle, parseStatementGaps, type StatementGapDto } from '../Bank/statementGaps';
import { useBankFetch } from '../Bank/useBankFetch';
import { ATTENTION_CHANGED_EVENT, ATTENTION_REFRESH_MS } from '../Attention/attentionSummary';
import './BankBand.css';

type T = (key: string, params?: Record<string, string | number>) => string;

export interface BankBandAccount {
  bankAccountId: string;
  name: string;
  currency: string;
  open: number;
  needs: number;
  sure: number;
  noReceipt: number;
}

export interface BankBandAutoAttempt {
  startedAt: string;
  finishedAt: string;
  ok: boolean;
  code: string;
  retryable: boolean;
  attempt: number;
  detail: Record<string, unknown> | null;
  connectionId?: string;
}

export interface BankBandActivation {
  checking: boolean;
  /** The last HPB the bank answered (critic F9). */
  lastCheckAt: string | null;
  /** The last automatic attempt, whatever came of it. */
  lastAttemptAt?: string | null;
  nextCheckAt: string | null;
  bankReady: boolean;
  lastOutcome: string | null;
}

export interface BankBandChannel {
  connectionId: string;
  state: string;
  lastSyncAt: string | null;
  syncInProgress: boolean;
  keystoreState: string;
  numberJumps: { bankAccountId: string; jump: NumberJump }[];
  /** A36 §4.7 (D150): the durable gaps of the channel's accounts. An older engine sends only the jumps. */
  statementGaps?: unknown;
  autoSync?: {
    mode: string;
    atTime: string;
    nextAt: string | null;
    lastAuto: BankBandAutoAttempt | null;
    /** D142 critic R3-2: false when nobody set the schedule, so only the owner seat was tried. */
    setterKnown?: boolean;
    /** D143 critic LB-1: who set the schedule (none, owner, agent, person); it words `auto_sync_no_actor`. */
    scheduleSetter?: 'none' | 'owner' | 'agent' | 'person';
  } | null;
  /** D143: the bank's short name ("ZKB"), and the daily activation check. */
  bankName?: string | null;
  activation?: BankBandActivation | null;
}

/** The `bank_inbox` tile as the engine answers it (`src/core/dashboards/dashboards.ts`). */
export interface BankBandTile {
  ok: true;
  open: number;
  needs: number;
  sure: number;
  noReceipt: number;
  /** Critic LOW 5: the hub's `bank_lines_waiting` number (needs minus the lines a Vorschlag names). */
  waiting?: number;
  /** The needs lines a pending Vorschlag names (counted by the hub's `agent_action`). */
  vorschlag?: number;
  accounts: BankBandAccount[];
  syncInProgress: boolean;
  channels: BankBandChannel[];
  /** False when this process runs no scheduler (`till serve`): nothing fetches by itself. */
  autoAvailable?: boolean;
}

/** Read the tile defensively: a shape this band cannot read is a failed read, never a guessed zero. */
export function parseBankBand(body: unknown): BankBandTile | null {
  const tile = (body as { tile?: unknown } | null)?.tile as Record<string, unknown> | undefined;
  if (tile === undefined || tile === null || typeof tile !== 'object' || tile.ok !== true) return null;
  const counts = ['open', 'needs', 'sure', 'noReceipt'] as const;
  if (counts.some((k) => typeof tile[k] !== 'number')) return null;
  if (!Array.isArray(tile.accounts) || !Array.isArray(tile.channels)) return null;
  return tile as unknown as BankBandTile;
}

/**
 * Stamp the Commit tint on a figure that changed, RESTARTING it when an earlier tint is still running:
 * the stamp is lifted and a style flush is forced before it is set again (the same reflow
 * `motion.ts` uses to restart the Navigate entrance), because lifting and re-setting an attribute in
 * one task is no change at all to the style engine, and the second change would ride out the first
 * tint's remainder. The timing stays the `--t-motion-tint` token, through `commitAck`.
 */
function retint(el: HTMLElement | null): () => void {
  if (el === null) return () => undefined;
  el.removeAttribute(COMMITTED_ATTR);
  void el.offsetWidth;
  return commitAck(el);
}

const PRE_ACTIVE = new Set(['draft', 'keys_generated', 'ini_sent', 'pending_bank_activation']);
const ZURICH = 'Europe/Zurich';

function zurichDay(instant: string | number): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: ZURICH, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(instant));
}

function zurichTime(instant: string): string {
  return new Intl.DateTimeFormat('de-CH', { timeZone: ZURICH, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(instant));
}

/** "heute 07:02", "gestern 07:02", "morgen 07:00", else "am 25.09.2026 um 07:02" (Swiss time). */
export function whenText(t: T, instant: string, now: number = Date.now()): string {
  const day = zurichDay(instant);
  const time = zurichTime(instant);
  const today = zurichDay(now);
  if (day === today) return t('dashboard.bankBand.when.today', { time });
  if (day === zurichDay(now - 86_400_000)) return t('dashboard.bankBand.when.yesterday', { time });
  if (day === zurichDay(now + 86_400_000)) return t('dashboard.bankBand.when.tomorrow', { time });
  return t('dashboard.bankBand.when.date', { date: formatDate(day), time });
}

function plural(t: T, key: string, count: number): string {
  return t(`${key}.${count === 1 ? 'one' : 'other'}`, { count });
}

// --- the lamp: what one channel's mark says ------------------------------------------------------------

/** The four visible tones (the dot's colour); never the only carrier of meaning. */
export type LampTone = 'warn' | 'success' | 'danger' | 'off';
/** One of the four C1 setup steps. */
export type StepState = 'done' | 'now' | 'fault' | 'todo';

export interface LampLink {
  to: string;
  label: string;
  /** The one action of the card (the compare): rendered as a secondary button-link. */
  primary?: boolean;
}

export interface Lamp {
  tone: LampTone;
  /** The state in words: the mark's `aria-label` and the card's heading. */
  label: string;
  /** The card's sentences, in order. */
  lines: string[];
  /** The card's small print: the last and next fetch or check. */
  meta: string[];
  /** The four setup steps while an activation is in progress (null once active). */
  steps: StepState[] | null;
  links: LampLink[];
  jumps: { bankAccountId: string; jump: NumberJump }[];
  /** A36 §4.7 (D150): the open statement gaps, each with its explanation and the repair door. */
  gaps: StatementGapDto[];
}

/** The steps with the current one at `current` (1 to 4); `fault` marks it as the one that is stuck. */
function stepsAt(current: number, fault = false): StepState[] {
  return [1, 2, 3, 4].map((n) => (n < current ? 'done' : n === current ? (fault ? 'fault' : 'now') : 'todo'));
}

export interface LampContext {
  /** This door's own press is running (the channel is one it fetches). */
  busy: boolean;
  /** The refusal this door's last press met, for an active channel. */
  pressError: Err | null;
  /** False under `till serve` (no scheduler). */
  autoAvailable: boolean;
  now?: number;
}

/**
 * THE ONE PLACE a channel's state becomes a colour and words, by the priority a person needs: a running
 * fetch, a refused press, a halted channel, the activation, then an active channel's fetch.
 */
export function lampOf(t: T, channel: BankBandChannel, ctx: LampContext): Lamp {
  const now = ctx.now ?? Date.now();
  const bank = channel.bankName ?? t('dashboard.bankBand.bankFallback');
  const at = channel.autoSync?.atTime ?? '07:00';
  const manage: LampLink = { to: '/bank-accounts', label: t('dashboard.bankBand.fetch.manage') };
  const members: LampLink = { to: '/members', label: t('dashboard.bankBand.fetch.members') };
  const lamp = (tone: LampTone, label: string, rest: Partial<Omit<Lamp, 'tone' | 'label'>> = {}): Lamp => ({
    tone,
    label,
    lines: rest.lines ?? [],
    meta: rest.meta ?? [],
    steps: rest.steps ?? null,
    links: rest.links ?? [],
    jumps: rest.jumps ?? [],
    gaps: rest.gaps ?? [],
  });
  const lockLines = [t('dashboard.bankBand.fetch.keystoreLocked'), t('dashboard.bankBand.fetch.keystoreLockedAction')];

  // Halted channels first: nothing else they could say matters until a person acts.
  if (channel.state === 'bank_keys_changed') {
    return lamp('warn', t('dashboard.bankBand.lamp.keysChanged', { bank }), {
      lines: [t('dashboard.bankBand.fetch.keysChanged')],
      links: [{ to: '/bank-accounts', label: t('dashboard.bankBand.action.compareKeys'), primary: true }],
    });
  }
  if (channel.state === 'blocked') {
    return lamp('danger', t('dashboard.bankBand.lamp.blocked', { bank }), { lines: [t('dashboard.bankBand.fetch.blocked')], links: [manage] });
  }

  // The activation (D143): the four pips, the daily check, and the one human act at its end.
  if (PRE_ACTIVE.has(channel.state)) {
    const a = channel.activation ?? null;
    const lettered = channel.state === 'ini_sent' || channel.state === 'pending_bank_activation';
    const meta: string[] = [];
    if (a?.lastCheckAt) meta.push(t('dashboard.bankBand.card.lastCheck', { when: whenText(t, a.lastCheckAt, now) }));
    if (a?.bankReady === true) {
      return lamp('warn', t('dashboard.bankBand.lamp.ready', { bank }), {
        lines: [t('dashboard.bankBand.card.ready', { bank })],
        meta: a.lastCheckAt ? [t('dashboard.bankBand.card.readySince', { when: whenText(t, a.lastCheckAt, now) })] : [],
        steps: stepsAt(3),
        links: [{ to: '/bank-accounts', label: t('dashboard.bankBand.action.compareKeys'), primary: true }],
      });
    }
    // Critic F2 (D143): the card never says there is nothing to do when that is false. The legs not both
    // confirmed (`ini_sent`, or never sent) is the owner's act: resend them on /bank-accounts. The probe
    // itself never resends a leg.
    const resend: LampLink = { to: '/bank-accounts', label: t('dashboard.bankBand.action.resendLegs'), primary: true };
    const current = lettered ? 2 : 1;
    // Critic F3: the LIVE keystore only, as the active branch does (D142 `staleLock`). A lock the last
    // check met but that is gone now (TILL restarted with the passphrase) is not repeated; the engine
    // makes the connection due again, so the catch-up check runs.
    if (channel.keystoreState === 'locked') {
      return lamp('danger', t('dashboard.bankBand.lamp.checkFault', { bank }), {
        lines: [t('dashboard.bankBand.card.checkLocked', { bank }), t('dashboard.bankBand.fetch.keystoreLockedAction')],
        meta,
        steps: stepsAt(current, true),
      });
    }
    if (a?.lastOutcome === 'auto_sync_no_actor') {
      return lamp('danger', t('dashboard.bankBand.lamp.checkFault', { bank }), {
        lines: [channelRefusal(t, { ok: false, error: 'auto_sync_no_actor', setterKnown: channel.autoSync?.setterKnown, scheduleSetter: channel.autoSync?.scheduleSetter } as Err)],
        meta,
        steps: stepsAt(current, true),
        links: [members],
      });
    }
    // A check that did not reach the bank, or cannot: danger, in words, with when TILL tries again.
    const unreached: Record<string, string> = {
      channel_unreachable: 'dashboard.bankBand.card.checkUnreachable',
      // Critic R3-3: a local worker failure never claims the bank was asked.
      worker_failed: 'dashboard.bankBand.card.checkNotStarted',
      needs_bank_transport: 'dashboard.bankBand.card.checkNoWire',
      keystore_unavailable: 'dashboard.bankBand.card.checkNoKeystore',
    };
    const unreachedKey = a?.lastOutcome ? unreached[a.lastOutcome] : undefined;
    if (unreachedKey !== undefined) {
      const lines = [t(unreachedKey, { bank })];
      // Critic F9: an attempt the bank never saw is a "Versuch", never a "Prüfung".
      if (a?.lastAttemptAt) meta.unshift(t('dashboard.bankBand.card.lastAttempt', { when: whenText(t, a.lastAttemptAt, now) }));
      if (a?.nextCheckAt) lines.push(t('dashboard.bankBand.fetch.retryAt', { when: whenText(t, a.nextCheckAt, now) }));
      return lamp('danger', t('dashboard.bankBand.lamp.checkFault', { bank }), {
        lines,
        meta,
        steps: stepsAt(current, true),
        links: channel.state === 'pending_bank_activation' ? [manage] : [resend],
      });
    }
    if (channel.state !== 'pending_bank_activation') {
      return lamp('warn', t('dashboard.bankBand.lamp.resend', { bank }), {
        lines: [t(lettered ? 'dashboard.bankBand.card.legsUnconfirmed' : 'dashboard.bankBand.card.letterFirst', { bank })],
        meta,
        steps: stepsAt(1),
        links: [resend],
      });
    }
    if (a?.nextCheckAt) meta.push(t('dashboard.bankBand.card.nextCheck', { when: whenText(t, a.nextCheckAt, now) }));
    let line: string;
    if (!ctx.autoAvailable) line = t('dashboard.bankBand.card.waitingServe', { bank });
    else if (a?.checking === true) line = t('dashboard.bankBand.card.waitingChecking', { bank, time: at });
    else line = t('dashboard.bankBand.card.waitingOff', { bank });
    return lamp('warn', t('dashboard.bankBand.lamp.waiting', { bank }), { lines: [line], meta, steps: stepsAt(current), links: [manage] });
  }

  if (channel.state !== 'active') return lamp('off', t('dashboard.bankBand.lamp.inactive', { bank }));

  // An active channel: its fetch.
  const auto = channel.autoSync ?? null;
  const last = auto?.lastAuto ?? null;
  // D150: the durable gaps replace the jump notice; the jumps stay only for an engine that sends no gaps.
  const gaps = parseStatementGaps(channel.statementGaps);
  const jumps = channel.statementGaps === undefined ? channel.numberJumps : [];
  const meta: string[] = [];
  const fetchedLine = (): string => {
    if (channel.lastSyncAt === null) return t('dashboard.bankBand.fetch.never');
    const when = whenText(t, channel.lastSyncAt, now);
    const automatic = last !== null && last.ok && channel.lastSyncAt >= last.startedAt && channel.lastSyncAt <= last.finishedAt;
    return automatic ? t('dashboard.bankBand.fetch.fetchedAuto', { when }) : t('dashboard.bankBand.fetch.fetched', { when });
  };
  if (ctx.busy || channel.syncInProgress) {
    return lamp('success', t('dashboard.bankBand.lamp.running', { bank }), { lines: [t('dashboard.bankBand.fetch.running'), t('dashboard.bankBand.fetch.runningHint')] });
  }
  if (ctx.pressError !== null) {
    return lamp('danger', t('dashboard.bankBand.lamp.fault', { bank }), { lines: [channelRefusal(t, ctx.pressError)], meta: [fetchedLine()], jumps, gaps });
  }
  // Critic F3 (D142): a locked keystore is never retried; the one act that clears it is a restart.
  if (channel.keystoreState === 'locked') {
    return lamp('danger', t('dashboard.bankBand.lamp.fault', { bank }), { lines: lockLines, meta: [fetchedLine()], jumps, gaps });
  }
  // A lock the last automatic run met but that is gone now (TILL was restarted) is not repeated.
  const staleLock = last !== null && last.code === 'keystore_locked';
  if (last !== null && !last.ok && !staleLock && (channel.lastSyncAt === null || last.finishedAt > channel.lastSyncAt)) {
    const refusal = {
      ok: false as const,
      error: last.code,
      ...(typeof last.detail?.kind === 'string' ? { kind: last.detail.kind } : {}),
      // D150: the bank's raw code the attempt kept, so the sentence names it ("Code 090003").
      ...(typeof last.detail?.code === 'string' ? { code: last.detail.code } : {}),
      setterKnown: auto?.setterKnown,
      scheduleSetter: auto?.scheduleSetter,
    } as Err;
    const lines = [channelRefusal(t, refusal)];
    // A bank that did not answer: the wire's own reason, in words.
    if (last.code === 'channel_unreachable') {
      const why = returnCodeText(t, last.detail);
      if (why !== null) lines.push(why);
    }
    const links: LampLink[] = [];
    if (last.retryable && auto?.nextAt) lines.push(t('dashboard.bankBand.fetch.retryAt', { when: whenText(t, auto.nextAt, now) }));
    else if (last.code === 'auto_sync_no_actor') links.push(members);
    else links.push(manage);
    return lamp('danger', t('dashboard.bankBand.lamp.fault', { bank }), { lines, meta: [fetchedLine()], links, jumps, gaps });
  }
  meta.push(fetchedLine());
  const nothingNew = last !== null && last.ok && last.code === 'no_data' && channel.lastSyncAt !== null && channel.lastSyncAt >= last.startedAt;
  if (nothingNew) meta.push(t('dashboard.bankBand.fetch.nothingNew'));
  if (!ctx.autoAvailable) {
    return lamp('off', t('dashboard.bankBand.lamp.serveOnly', { bank }), { lines: [t('dashboard.bankBand.fetch.serveOnly')], meta, jumps, gaps });
  }
  if (auto?.mode === 'off') {
    return lamp('off', t('dashboard.bankBand.lamp.off', { bank }), {
      lines: [t('dashboard.bankBand.fetch.off')],
      meta,
      links: [{ to: '/bank-accounts', label: t('dashboard.bankBand.fetch.offLink') }],
      jumps,
      gaps,
    });
  }
  if (auto?.nextAt) meta.push(t('dashboard.bankBand.fetch.next', { when: whenText(t, auto.nextAt, now) }));
  if (jumps.length > 0 || gaps.length > 0) {
    return lamp('warn', t('dashboard.bankBand.lamp.jump', { bank }), { lines: [t('dashboard.bankBand.card.active', { time: at })], meta, jumps, gaps });
  }
  return lamp('success', t('dashboard.bankBand.lamp.active', { bank }), { lines: [t('dashboard.bankBand.card.active', { time: at })], meta, jumps, gaps });
}

// --- icons (outline, 14 px, currentColor; decorative: the link's label carries the words) --------------

function FacetIcon({ kind }: { kind: 'needs' | 'sure' | 'noReceipt' }) {
  const common = {
    width: 14,
    height: 14,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
    focusable: false,
    className: 'bank-band__facet-icon',
  };
  if (kind === 'needs') {
    return (
      <svg {...common}>
        <circle cx="12" cy="8" r="4" />
        <path d="M4 21c0-4 4-6 8-6s8 2 8 6" />
      </svg>
    );
  }
  if (kind === 'sure') {
    return (
      <svg {...common}>
        <path d="M5 12l5 5L20 7" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <path d="M21 12l-8.5 8.5a5 5 0 0 1-7-7L14 5a3.5 3.5 0 0 1 5 5l-8.5 8.5a2 2 0 0 1-3-3L15 8" />
      <path d="M3 3l18 18" />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M20 11A8 8 0 1 0 17.7 17" />
      <path d="M20 4v7h-7" />
    </svg>
  );
}

// --- the mark and its card --------------------------------------------------------------------------------

const STEP_KEYS = ['letter', 'activate', 'compare', 'daily'] as const;
/** How long the card waits after the pointer left before it closes (critic F4). */
const CLOSE_DELAY_MS = 250;

function BankMark({ lamp, bank, accountName }: { lamp: Lamp; bank: string; accountName: (id: string) => string }) {
  const t = useT();
  const cardId = useId();
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLSpanElement | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  // Escape returns focus to the mark without reopening the card it just closed.
  const returning = useRef(false);
  // Critic F4: the pointer crosses a gap between the mark and its card. Leaving starts a short delay that
  // re-entering (the card included) cancels, so the pointer reaches the action; the CSS bridge covers the
  // gap itself.
  const closeTimer = useRef<number | null>(null);
  const cancelClose = () => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };
  const closeSoon = () => {
    cancelClose();
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null;
      // Focus inside the card keeps it open: a keyboard user is reading it.
      if (wrap.current !== null && wrap.current.contains(document.activeElement)) return;
      setOpen(false);
    }, CLOSE_DELAY_MS);
  };
  useEffect(() => cancelClose, []);
  // WCAG 1.4.13: a card opened by hover is dismissed by Escape wherever focus is.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      cancelClose();
      setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  const onBlur = (event: FocusEvent) => {
    // Focus moving INTO the card (its action) keeps it open: that is how a keyboard reaches the link.
    if (wrap.current !== null && event.relatedTarget instanceof Node && wrap.current.contains(event.relatedTarget)) return;
    setOpen(false);
  };

  let visual: ReactNode;
  if (lamp.steps !== null) {
    visual = (
      <span className="bank-mark__pips" aria-hidden="true">
        {lamp.steps.map((s, i) => (
          <span key={STEP_KEYS[i]} className="bank-mark__pip-group">
            {i > 0 && <span className={`bank-mark__hair${s === 'done' ? ' is-done' : ''}`} />}
            <span className={`bank-mark__pip is-${s}`} />
          </span>
        ))}
      </span>
    );
  } else {
    visual = <span className="bank-mark__dot" aria-hidden="true" />;
  }

  return (
    <span
      ref={wrap}
      className={`bank-mark bank-mark--${lamp.tone}`}
      onMouseEnter={() => {
        cancelClose();
        setOpen(true);
      }}
      onMouseLeave={closeSoon}
      onFocus={() => {
        if (returning.current) {
          returning.current = false;
          return;
        }
        setOpen(true);
      }}
      onBlur={onBlur}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || !open) return;
        setOpen(false);
        if (document.activeElement !== trigger.current) {
          returning.current = true;
          trigger.current?.focus();
        }
      }}
    >
      <button
        ref={trigger}
        type="button"
        className="bank-mark__trigger"
        aria-label={lamp.label}
        aria-expanded={open}
        aria-controls={cardId}
        onClick={() => setOpen(true)}
      >
        {visual}
        <span className="bank-mark__name">{bank}</span>
      </button>
      <div id={cardId} className="bank-mark__card" role="group" aria-label={lamp.label} hidden={!open}>
        <strong className="bank-mark__state">{lamp.label}</strong>
        {lamp.lines.map((line) => (
          <p key={line} className="bank-mark__line">
            {line}
          </p>
        ))}
        {lamp.jumps.map((j) => (
          <p key={`${j.bankAccountId}-${j.jump.statement.year}-${j.jump.statement.number}`} className="bank-mark__line">
            {numberJumpText(t, j.jump)}{' '}
            <Link to={`/bank?account=${encodeURIComponent(j.bankAccountId)}`} className="bank-mark__link">
              {t('dashboard.bankBand.jumpLink', { name: accountName(j.bankAccountId) })}
            </Link>
          </p>
        ))}
        {lamp.gaps.map((g) => (
          <div key={g.gapId} className="bank-mark__gap">
            <p className="bank-mark__line">
              <strong>{`${accountName(g.bankAccountId)}: ${gapTitle(t, g)}`}</strong> {gapExplanation(t, g)}
            </p>
            <Link to={gapRepairHref(g)} className="btn btn--secondary btn--sm bank-mark__action">
              {t('attention.act.closeGap')}
            </Link>
          </div>
        ))}
        {lamp.meta.length > 0 && <p className="bank-mark__meta">{lamp.meta.join(' · ')}</p>}
        {lamp.steps !== null && (
          <ol className="bank-mark__steps" aria-label={t('dashboard.bankBand.steps.label')}>
            {lamp.steps.map((s, i) => (
              <li key={STEP_KEYS[i]} className={`bank-mark__step is-${s}`}>
                <span className="bank-mark__step-mark" aria-hidden="true" />
                <span>{t(`dashboard.bankBand.steps.${STEP_KEYS[i]}`, { bank })}</span>
                <span className="visually-hidden">{`, ${t(`dashboard.bankBand.steps.state.${s}`)}`}</span>
              </li>
            ))}
          </ol>
        )}
        {lamp.links.map((l) => (
          <Link key={l.to + l.label} to={l.to} className={l.primary === true ? 'btn btn--secondary btn--sm bank-mark__action' : 'bank-mark__link'}>
            {l.label}
          </Link>
        ))}
      </div>
    </span>
  );
}

type BandState = { status: 'loading' } | { status: 'error' } | { status: 'hidden' } | { status: 'ok'; tile: BankBandTile };

export function BankBand() {
  const t = useT();
  const client = useClient();
  const workspaceId = useWorkspaceId();
  const canPay = useCan(CAP.pay);
  const [state, setState] = useState<BandState>({ status: 'loading' });
  const [ack, setAck] = useState<string | null>(null);
  const bankFetch = useBankFetch(workspaceId);
  const live = useRef(true);

  const load = useCallback(
    async (quiet = false) => {
      if (workspaceId === null) return;
      if (!quiet) setState({ status: 'loading' });
      const today = new Date().toISOString().slice(0, 10);
      const res = await client.call('dashboard_tile', { workspaceId, tile: 'bank_inbox', from: today, to: today });
      if (!live.current) return;
      if (isErr(res.body)) {
        // A role that may not see the bank lines is told nothing here: the page's omission note covers it.
        setState(res.body.error === 'permission_denied' ? { status: 'hidden' } : { status: 'error' });
        return;
      }
      const tile = parseBankBand(res.body);
      setState(tile === null ? { status: 'error' } : { status: 'ok', tile });
    },
    [client, workspaceId],
  );

  useEffect(() => {
    live.current = true;
    void load();
    return () => {
      live.current = false;
    };
  }, [load]);

  // LIVE (30.09.2026): the channel's state changes while the page is open (the daily activation check,
  // the bank switching the access on, the 07:00 fetch, a send on /bank-accounts in another tab), so the
  // band re-reads QUIETLY on the attention cadence: every minute while the tab is visible, on focus, and
  // when the waiting work is announced as changed. The lamp never drops to a skeleton for it.
  useEffect(() => {
    if (workspaceId === null) return undefined;
    const quiet = (): void => {
      if (document.visibilityState !== 'hidden') void load(true);
    };
    const timer = window.setInterval(quiet, ATTENTION_REFRESH_MS);
    window.addEventListener('focus', quiet);
    window.addEventListener(ATTENTION_CHANGED_EVENT, quiet);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', quiet);
      window.removeEventListener(ATTENTION_CHANGED_EVENT, quiet);
    };
  }, [load, workspaceId]);

  // A fetch another caller runs (the 07:00 run, the /bank button) is followed until it ends.
  const running = state.status === 'ok' && state.tile.syncInProgress && !bankFetch.busy;
  useEffect(() => {
    if (!running) return undefined;
    const timer = window.setTimeout(() => void load(true), 5_000);
    return () => window.clearTimeout(timer);
  }, [running, state, load]);

  const showSkeleton = useSkeletonHold(state.status === 'loading');

  // A figure the quiet re-read changed takes the Commit moment's tint (D122 D-I), so the eye finds the
  // number that moved. Tint only: the figure neither rolls nor lands (BankBand.css), and nothing about
  // its box changes, so the band never shifts. The first read, and a read after a workspace switch,
  // tint nothing: a figure the person never saw before has not changed.
  const figureTile = state.status === 'ok' ? state.tile : null;
  const waitingFigure = figureTile === null ? null : typeof figureTile.waiting === 'number' ? figureTile.waiting : figureTile.needs;
  const openFigure = figureTile === null ? null : figureTile.open;
  const countRef = useRef<HTMLSpanElement | null>(null);
  const openRef = useRef<HTMLAnchorElement | null>(null);
  // One effect per figure, so a change to one never cancels the other's running tint.
  const shownWaiting = useRef<number | null>(null);
  const shownOpen = useRef<number | null>(null);
  useEffect(() => {
    const before = shownWaiting.current;
    shownWaiting.current = waitingFigure;
    return before !== null && waitingFigure !== null ? retint(countRef.current) : undefined;
  }, [waitingFigure]);
  useEffect(() => {
    const before = shownOpen.current;
    shownOpen.current = openFigure;
    return before !== null && openFigure !== null ? retint(openRef.current) : undefined;
  }, [openFigure]);

  if (workspaceId === null || state.status === 'hidden') return null;
  if (state.status === 'loading') {
    if (!showSkeleton) return <div className="bank-band bank-band--pending" aria-hidden="true" />;
    return (
      <section className="bank-band bank-band--pending" aria-busy="true">
        <span className="visually-hidden">{t('dashboard.bankBand.loading')}</span>
        <span className="skeleton bank-band__skeleton-count" aria-hidden="true" />
        <span className="bank-band__skeleton-facets" aria-hidden="true">
          <span className="skeleton" />
          <span className="skeleton" />
          <span className="skeleton" />
        </span>
      </section>
    );
  }
  if (state.status === 'error') {
    return (
      <div className="bank-band bank-band--muted" role="status">
        {t('dashboard.bankBand.error')}{' '}
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => void load()}>
          {t('dashboard.bankBand.retry')}
        </button>
      </div>
    );
  }

  const tile = state.tile;
  if (tile.accounts.length === 0) {
    return (
      <section className="bank-band bank-band--empty" aria-labelledby="bank-band-title">
        <h2 id="bank-band-title" className="bank-band__empty-title">
          {t('dashboard.bankBand.empty.title')}
        </h2>
        <p className="bank-band__hint">{t('dashboard.bankBand.empty.hint')}</p>
        <Link className="btn btn--secondary btn--sm" to="/bank-accounts">
          {t('dashboard.bankBand.empty.action')}
        </Link>
      </section>
    );
  }

  const channels = tile.channels;
  // Critic LOW 5: one number with the hub. An older engine sends no `waiting`: then `needs` it is.
  const waiting = typeof tile.waiting === 'number' ? tile.waiting : tile.needs;
  const vorschlag = typeof tile.vorschlag === 'number' ? tile.vorschlag : 0;
  const activeIds = channels.filter((c) => c.state === 'active').map((c) => c.connectionId);
  const accountName = (id: string) => tile.accounts.find((a) => a.bankAccountId === id)?.name ?? '';
  const pressBusy = bankFetch.busy || tile.syncInProgress;

  const press = async () => {
    setAck(null);
    const summary = await bankFetch.run(activeIds);
    if (summary !== null && summary.error === null) {
      setAck(
        summary.imported === 0 && summary.waiting === 0
          ? t('bankInbox.header.fetchedNothing')
          : t('bankInbox.header.fetched', { imported: summary.imported, waiting: summary.waiting }),
      );
    }
    void load(true);
  };

  const facets = [
    { key: 'sure' as const, count: tile.sure, to: '/bank?facet=sure' },
    { key: 'noReceipt' as const, count: tile.noReceipt, to: '/bank?tab=booked&facet=noreceipt' },
  ];
  const announce = bankFetch.error !== null ? channelRefusal(t, bankFetch.error) : !bankFetch.busy ? ack : null;

  return (
    <section className="bank-band" aria-labelledby="bank-band-title">
      <div className="bank-band__left">
        <h2 id="bank-band-title" className="bank-band__caption">
          {t('dashboard.bankBand.caption')}
        </h2>
        {/* D150: the headline is what waits for a person, in visible words; the open total is secondary. */}
        {waiting > 0 ? (
          <Link to="/bank?facet=needs" className="bank-band__headline" aria-label={plural(t, 'dashboard.bankBand.waiting', waiting)}>
            <span ref={countRef} className="bank-band__count" aria-hidden="true">
              {waiting}
            </span>
            {' '}
            <span className="bank-band__headline-label" aria-hidden="true">
              {plural(t, 'dashboard.bankBand.waitingLabel', waiting)}
            </span>
          </Link>
        ) : (
          <span className="bank-band__headline is-calm">{t('dashboard.bankBand.nothingWaiting')}</span>
        )}
        {vorschlag > 0 && (
          <Link to="/agent" className="bank-band__open">
            {waiting > 0 ? '' : <span aria-hidden="true">· </span>}
            {t('dashboard.bankBand.withVorschlag', { count: vorschlag })}
          </Link>
        )}
        {tile.open > 0 ? (
          <Link ref={openRef} to="/bank" className="bank-band__open" aria-label={plural(t, 'dashboard.bankBand.count', tile.open)} title={t('dashboard.bankBand.countTitle')}>
            {waiting > 0 || vorschlag > 0 ? '' : <span aria-hidden="true">· </span>}
            {t('dashboard.bankBand.openShort', { count: tile.open })}
          </Link>
        ) : null}
        <ul className="bank-band__facets" aria-label={t('dashboard.bankBand.facetsLabel')}>
          {facets.map((f) => {
            const label = plural(t, `dashboard.bankBand.facet.${f.key}`, f.count);
            const title = t(`dashboard.bankBand.facetTitle.${f.key}`);
            return (
              <li key={f.key}>
                {f.count > 0 ? (
                  <Link to={f.to} className="bank-band__facet" aria-label={label} title={title}>
                    <FacetIcon kind={f.key} />
                    <span aria-hidden="true">{f.count}</span>
                  </Link>
                ) : (
                  <span className="bank-band__facet is-zero" title={title}>
                    <FacetIcon kind={f.key} />
                    <span aria-hidden="true">{f.count}</span>
                    <span className="visually-hidden">{label}</span>
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      </div>

      {channels.length > 0 && (
        <div className="bank-band__right">
          {channels.map((c) => {
            const lamp = lampOf(t, c, {
              busy: bankFetch.busy && activeIds.includes(c.connectionId),
              pressError: c.state === 'active' ? bankFetch.error : null,
              autoAvailable: tile.autoAvailable !== false,
            });
            return <BankMark key={c.connectionId} lamp={lamp} bank={c.bankName ?? t('dashboard.bankBand.bankFallback')} accountName={accountName} />;
          })}
          {activeIds.length > 0 && (
            <button
              type="button"
              className="btn btn--secondary btn--sm bank-band__refresh"
              aria-label={pressBusy ? t('dashboard.bankBand.fetch.buttonBusy') : t('dashboard.bankBand.fetch.button')}
              title={pressBusy ? t('dashboard.bankBand.fetch.buttonBusy') : t('dashboard.bankBand.fetch.button')}
              aria-busy={pressBusy}
              disabled={!canPay || pressBusy}
              {...(!canPay ? { 'aria-describedby': 'bank-band-denied' } : {})}
              onClick={() => void press()}
            >
              <RefreshIcon />
            </button>
          )}
          {activeIds.length > 0 && !canPay && (
            <span id="bank-band-denied" className="visually-hidden">
              {t('dashboard.bankBand.fetch.denied')}
            </span>
          )}
          <span className="visually-hidden" role="status">
            {announce ?? ''}
          </span>
        </div>
      )}
    </section>
  );
}
