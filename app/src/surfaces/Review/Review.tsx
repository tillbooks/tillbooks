/**
 * A25 US-A25.1/.2/.3, Review (`/review`): the Treuhänder's period-scoped review of the posted books.
 *
 * IA is decision D115 (1a): Review and Export are two nested sibling screens under a Treuhänder rail
 * group, each owning its own period, its own five states, its own help. This screen carries the
 * sticky coverage header (2a): the counts, a meter, and Periode sperren, present only once the period
 * is clean (D152). Per row it offers comment, flag and approve, each writing ONLY `entry_review`
 * metadata: the posted entry is never mutated (§H-AUDIT), and a correction after lock is a next-period
 * reversal (A02), never an edit.
 *
 * THE ROW ACTIONS REST HIDDEN (D152 rule 3, the owner's pick from the cognitive-load audit, after the
 * bank queue). Comment, flag and approve show only on the row that is hovered, holds focus, or is
 * SELECTED. A click (or Enter/Space on the focused row) selects a row; the selection is the user's act,
 * so nothing is selected on load (rule 5). Keyboard: Tab lands on a row, and its actions are the next
 * Tab stops, because a row holding focus shows them (`:focus-within`). Touch and other pointers with
 * no hover: a tap selects the row and the selected row shows its actions; the hover reveal is scoped
 * to `(hover: hover)` so a phone's sticky hover never leaves a second row's actions up. What a row
 * already HAS is data, not an action, so it stays at rest: the comment count glyph beside the
 * description and the status glyph plus word ("markiert") in the Status column. An approved row offers
 * no approve control at all (absent, never a disabled check), and approving never sweeps a flagged
 * entry: "Alle freigeben" keeps its exact semantics and count.
 *
 * THE AMOUNT COLUMN TOUCHES NO ENGINE READ. `review_status` returns the review state but no figure,
 * so the Betrag column is JOINED from `list_journal`'s own `total`/`baseTotal` by entry id (see
 * `amountsByEntryId`): a pure client-side join over a verb that already returns amounts. The figure
 * renders VERBATIM through `formatMoney`; nothing is re-summed in the UI.
 *
 * WHAT THE COMMENT CONTROL DOES, AND WHAT IT HONESTLY CANNOT. It posts a Prüfvermerk (`comment_entry`)
 * and shows the running comment count. The built engine exposes no verb that LISTS the thread text, so
 * the composer is a Modal that writes plus the count, not a rendered history: showing a thread the
 * engine cannot read would be inventing one.
 *
 * D118 B2 consolidation: the list is the shared `DataTable` (frame overflow, sticky header, density
 * and the five states), the page header is `SurfaceHeader`, and the flag/comment composer and the
 * Periode-sperren confirm are the shared `Modal` (the lock as an alertdialog, per the APG). The
 * coverage band stays bespoke: it is a domain coverage line (live counts + meter + the A24-gated
 * lock), not a page header, and `SurfaceHeader` models only title/subtitle/help/actions.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { Link } from 'react-router-dom';

import { useClient } from '../../lib/client-context';
import { isErr } from '../../lib/client';
import { useWorkspaceId } from '../../app/workspace';
import { useT, useI18n, formatMoney, formatDate } from '../../i18n';
import { formatCalendar } from '../../lib/format';
import { Status } from '../../components/Status';
import { SurfaceHelp } from '../../components/SurfaceHelp';
import { SurfaceHeader } from '../../components/SurfaceHeader';
import { DataTable, type DataTableColumn } from '../../components/DataTable';
import { Modal } from '../../components/Modal';
import { EmptyState, ErrorBanner, NoWorkspaceState, PermissionDenied } from '../../components/states';
import { useCan, CAP } from '../../lib/capabilities';
import { COMMIT_TARGET_CLASS, commitAck, prefersReducedMotion, useCommitAck } from '../../lib/motion';
import { PeriodField } from './PeriodField';
import { CoverageBar } from './CoverageBar';
import { LockDialog } from './LockDialog';
import { CheckGlyph, CommentGlyph, FlagGlyph } from './glyphs';
import { LockGlyph } from '../../components/states/glyphs';
import {
  amountsByEntryId,
  currentMonth,
  currentYear,
  parseReviewStatus,
  periodValue,
  type Granularity,
  type ReviewEntry,
  type ReviewStatus,
} from './model';
import './Review.css';

/**
 * A per-act nonce, so each approve, flag, comment and lock is its own event rather than an idempotent
 * replay. A key fixed to the entry or the period (`approve:<ws>:<entry>`, `lock:<ws>:<period>`) made a
 * second act replay the FIRST act's stored success once the state had moved on: approve, flag, approve
 * again left the entry flagged; lock, unlock, lock again wrote no lock and still answered `hard`. A
 * double click is not a second act: the in-flight guards below stop it before a second request.
 */
function nonce(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** How long the focus return waits for a re-read row, in milliseconds. */
const REFOCUS_LIMIT_MS = 2000;

/**
 * THE DOUBLE-TAP GUARD (critic r2). On touch the first tap selects a row, which makes its actions
 * clickable at once while they are still fading in, so the second tap of a quick double tap landed on
 * Freigeben. A pointer click on an action of a row that a pointer has just revealed is therefore
 * ignored for the reveal (the `--t-motion-pill` token, the same one Review.css fades with) plus this
 * margin. Under `prefers-reduced-motion` the reveal is instant, but a double tap is still a double
 * tap, so the margin alone stays. A keyboard press (a click with `detail` 0) is never held back.
 */
const DOUBLE_TAP_GUARD_MS = 250;

/** A CSS time token as milliseconds ("120ms", "0.12s"); 0 when absent or unreadable. */
function cssTimeMs(value: string): number {
  const match = /^([\d.]+)(ms|s)$/.exec(value.trim());
  if (match === null) return 0;
  const n = Number(match[1]);
  return Number.isFinite(n) ? (match[2] === 's' ? n * 1000 : n) : 0;
}

/** How long a freshly revealed action ignores pointer clicks, in milliseconds. */
export function revealGuardMs(): number {
  const reveal = prefersReducedMotion() ? 0 : cssTimeMs(getComputedStyle(document.documentElement).getPropertyValue('--t-motion-pill'));
  return reveal + DOUBLE_TAP_GUARD_MS;
}

/**
 * The strongest lock `list_period_locks` holds over the loaded period, or null when it is open. A
 * month (`YYYY-MM`) is locked by its own lock OR by a lock on its calendar year (a year seal covers
 * the month within it).
 *
 * THE KIND MATTERS (F-07, J4.3). A `soft` lock is A03's reversible month close: it refuses POSTINGS
 * into the month and nothing else, and the review verbs write review metadata, never a posting
 * (`src/core/review/shared.ts`, the one INSERT-only writer). So a soft-closed month stays reviewable
 * here: the story's order is close, then review, then lock. Only a `hard` lock (the Treuhänder's own
 * `lock_period`, a filed MWST period, a closed year) turns the surface read-only.
 */
type LockKind = 'soft' | 'hard' | null;
function lockKindOf(locks: unknown, periodStr: string): LockKind {
  const record = typeof locks === 'object' && locks !== null ? (locks as Record<string, unknown>) : null;
  const list = record?.locks;
  if (!Array.isArray(list)) return null;
  const isMonth = periodStr.length === 7;
  const yearOf = periodStr.slice(0, 4);
  let kind: LockKind = null;
  for (const raw of list) {
    const lock = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : null;
    const p = lock?.period;
    if (p !== periodStr && !(isMonth && p === yearOf)) continue;
    if (lock?.kind === 'hard') return 'hard';
    kind = 'soft';
  }
  return kind;
}

/** The alertdialog role for the approve-all confirm, held as a value so the modal-role guard reads it on Modal's div. */
const ALERT_DIALOG = 'alertdialog' as const;

type Composer = { entryId: string; kind: 'flag' | 'comment' } | null;

export function Review() {
  const t = useT();
  const { locale } = useI18n();
  const client = useClient();
  const workspaceId = useWorkspaceId();
  const canReview = useCan(CAP.review);
  const canManagePeriods = useCan(CAP.managePeriods);

  const [granularity, setGranularity] = useState<Granularity>('month');
  const [month, setMonth] = useState(currentMonth());
  const [year, setYear] = useState(currentYear());
  const period = periodValue(granularity, month, year);
  // K-38: the period reads as "März 2026" in every sentence; `period` stays the engine's string.
  const periodLabel = formatCalendar(period, locale);

  const [status, setStatus] = useState<ReviewStatus | null>(null);
  const [currency, setCurrency] = useState('CHF');
  const [lockKind, setLockKind] = useState<LockKind>(null);
  const locked = lockKind === 'hard';
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [denied, setDenied] = useState(false);

  const [composer, setComposer] = useState<Composer>(null);
  // The one selected row (its actions show at rest). Never set on load: selecting is the user's act.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [busyEntry, setBusyEntry] = useState<string | null>(null);

  const [confirming, setConfirming] = useState(false);
  const [locking, setLocking] = useState(false);
  const [lockFailed, setLockFailed] = useState(false);
  const [confirmingAll, setConfirmingAll] = useState(false);
  const [approvingAll, setApprovingAll] = useState(false);
  const [approveAllFailed, setApproveAllFailed] = useState(0);

  // The Commit moment (D122 D-I). A row write (approve, flag, comment) lands on the row it was made on
  // once the re-read has drawn it; `seq` makes every act its own acknowledgement, so approving a row
  // that was flagged a moment ago lands again. A lock produces no row: it lands on the locked note it
  // brings up. Neither touches the double-tap guard, which keys on the reveal of a row's ACTIONS.
  const [committed, setCommitted] = useState<{ entryId: string; seq: number } | null>(null);
  const commitSeq = useRef(0);
  const [justLocked, setJustLocked] = useState(false);
  const lockedNoteRef = useRef<HTMLDivElement | null>(null);

  // THE STALE-READ GUARD. The screen's current scope, read after every await: a read (or a write's
  // re-read) that started under another workspace or period never paints over the one on screen.
  // `readSeq` additionally drops an older read of the same scope that lands after a newer one.
  const scopeRef = useRef({ workspaceId, period });
  scopeRef.current = { workspaceId, period };
  const readSeq = useRef(0);
  const isCurrent = useCallback(
    (ws: string | null, p: string) => scopeRef.current.workspaceId === ws && scopeRef.current.period === p,
    [],
  );
  // In-flight guards: one approve per entry and one lock at a time, whatever the clicks in between.
  const approvingRef = useRef(new Set<string>());
  const lockingRef = useRef(false);
  const approvingAllRef = useRef(false);

  const load = useCallback(async () => {
    if (workspaceId === null) {
      setLoading(false);
      return;
    }
    const seq = ++readSeq.current;
    const stale = () => seq !== readSeq.current || !isCurrent(workspaceId, period);
    setLoading(true);
    setFailed(false);
    setDenied(false);
    const statusRes = await client.call('review_status', { workspaceId, period });
    if (stale()) return;
    if (isErr(statusRes.body)) {
      if (statusRes.body.error === 'permission_denied') setDenied(true);
      else setFailed(true);
      setStatus(null);
      setLoading(false);
      return;
    }
    // The amount join, the currency and the lock state ride alongside; none blocks the skeleton, which
    // is the review read. A failure in any of them degrades gracefully (no amount, CHF, unlocked).
    const [journalRes, profileRes, locksRes] = await Promise.all([
      client.call('list_journal', { workspaceId, from: statusRes.body.periodStart as string, to: statusRes.body.periodEnd as string, status: 'posted' }),
      client.call('get_company_profile', { workspaceId }),
      client.call('list_period_locks', { workspaceId }),
    ]);
    if (stale()) return;
    const amounts = isErr(journalRes.body) ? new Map<string, number>() : amountsByEntryId(journalRes.body);
    const parsed = parseReviewStatus(statusRes.body, amounts);
    if (parsed === null) {
      setFailed(true);
      setStatus(null);
      setLoading(false);
      return;
    }
    if (!isErr(profileRes.body)) {
      const base = (profileRes.body as { baseCurrency?: unknown }).baseCurrency;
      if (typeof base === 'string' && base.length > 0) setCurrency(base);
    }
    setLockKind(isErr(locksRes.body) ? null : lockKindOf(locksRes.body, parsed.period));
    setStatus(parsed);
    setLoading(false);
  }, [client, workspaceId, period, isCurrent]);

  // A write's re-read always reads the scope on screen NOW, never the one the write began under.
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    void load();
  }, [load]);

  // A new period or workspace is a new list: a selection, an open composer or a pending confirm never
  // carries over to rows it was not made on.
  useEffect(() => {
    setSelectedId(null);
    setComposer(null);
    setDraft('');
    setConfirming(false);
    setConfirmingAll(false);
    setCommitted(null);
    setJustLocked(false);
  }, [period, workspaceId]);

  useCommitAck(committed === null ? null : `${committed.entryId}#${committed.seq}`, status);
  // The lock's note is the thing that just landed; the stamp lifts with the tint (or on unmount).
  useEffect(() => (justLocked ? commitAck(lockedNoteRef.current) : undefined), [justLocked]);

  /**
   * After a row write re-reads the list, focus goes back to the row it was made on when the re-read
   * dropped it (the approve control is gone on an approved row, and a slow re-read swaps the table for
   * its skeleton), so a keyboard reader carries on from that row rather than from the top of the page.
   */
  const refocusRow = useCallback((entryId: string) => {
    // The re-read's rows commit a frame or more after `load` resolves (and the table may hold its
    // skeleton a moment longer), so this waits for the row, two seconds at most (a time limit, not a
    // frame count, so a slow or throttled frame rate does not cut it short), and gives up the moment
    // focus lands anywhere else: it never takes focus from a control the user has since moved to.
    const until = performance.now() + REFOCUS_LIMIT_MS;
    const attempt = () => {
      const active = document.activeElement;
      const lost =
        active === null ||
        active === document.body ||
        !active.isConnected ||
        (active instanceof HTMLButtonElement && active.disabled);
      if (lost) {
        const row = document
          .querySelector(`[data-rv-entry="${CSS.escape(entryId)}"]`)
          ?.closest<HTMLTableRowElement>('tr');
        if (row !== null && row !== undefined) {
          row.focus();
          return;
        }
      } else if (active.closest('[data-rv-entry]')?.getAttribute('data-rv-entry') !== entryId) {
        // The user has moved on to another control: leave focus where they put it.
        return;
      }
      // Still on this row's own control, or the row is not back yet: look again next frame.
      if (performance.now() < until) requestAnimationFrame(attempt);
    };
    attempt();
  }, []);

  const approve = useCallback(
    async (entryId: string) => {
      if (workspaceId === null || approvingRef.current.has(entryId)) return;
      approvingRef.current.add(entryId);
      setBusyEntry(entryId);
      try {
        const { body } = await client.call('approve_entry', {
          workspaceId,
          entryId,
          idempotencyKey: `approve:${workspaceId}:${entryId}:${nonce()}`,
        });
        setBusyEntry(null);
        if (!isErr(body)) {
          await loadRef.current();
          if (isCurrent(workspaceId, period)) {
            setCommitted({ entryId, seq: ++commitSeq.current });
            refocusRow(entryId);
          }
        }
      } finally {
        approvingRef.current.delete(entryId);
        setBusyEntry((busy) => (busy === entryId ? null : busy));
      }
    },
    [client, workspaceId, period, isCurrent, refocusRow],
  );

  const submitComposer = useCallback(async () => {
    if (workspaceId === null || composer === null || draft.trim() === '') return;
    setBusyEntry(composer.entryId);
    const { body } =
      composer.kind === 'flag'
        ? await client.call('flag_entry', {
            workspaceId,
            entryId: composer.entryId,
            reason: draft.trim(),
            idempotencyKey: `flag:${workspaceId}:${composer.entryId}:${nonce()}`,
          })
        : await client.call('comment_entry', {
            workspaceId,
            entryId: composer.entryId,
            text: draft.trim(),
            idempotencyKey: `comment:${workspaceId}:${composer.entryId}:${nonce()}`,
          });
    setBusyEntry(null);
    if (!isErr(body)) {
      if (!isCurrent(workspaceId, period)) {
        // The screen moved on while the write ran: it landed, but the composer it came from is gone.
        await loadRef.current();
        return;
      }
      setComposer(null);
      setDraft('');
      await loadRef.current();
      if (isCurrent(workspaceId, period)) setCommitted({ entryId: composer.entryId, seq: ++commitSeq.current });
      refocusRow(composer.entryId);
    }
  }, [client, workspaceId, period, composer, draft, isCurrent, refocusRow]);

  const openComposer = useCallback((entryId: string, kind: 'flag' | 'comment') => {
    // Acting on a row selects it, so its actions stay up while the dialog is open and the dialog can
    // hand focus back to the control that opened it.
    setSelectedId(entryId);
    setComposer((current) =>
      current !== null && current.entryId === entryId && current.kind === kind ? null : { entryId, kind },
    );
    setDraft('');
  }, []);

  const closeComposer = useCallback(() => {
    setComposer(null);
    setDraft('');
  }, []);

  const confirmLock = useCallback(async () => {
    if (workspaceId === null || status === null || lockingRef.current) return;
    lockingRef.current = true;
    setLocking(true);
    setLockFailed(false);
    try {
      const { body } = await client.call('lock_period', {
        workspaceId,
        period,
        kind: 'hard',
        reason: 'treuhaender_review',
        idempotencyKey: `lock:${workspaceId}:${period}:${nonce()}`,
      });
      setLocking(false);
      // A lock of another workspace or period never marks the one on screen as locked.
      if (!isCurrent(workspaceId, period)) return;
      if (isErr(body)) {
        setLockFailed(true);
        return;
      }
      setConfirming(false);
      setLockKind('hard');
      setJustLocked(true);
    } finally {
      lockingRef.current = false;
    }
  }, [client, workspaceId, status, period, isCurrent]);

  /**
   * "Alle freigeben" (J4.3 ideal step 2): ONE act with ONE confirm for the open, unflagged rest. The
   * engine has no bulk verb and needs none: `approve_entry` is idempotent per entry key, so the act
   * is the same N calls a person would click, issued in order, and a failure stops the run and says
   * how many did not land rather than pretending. Flagged entries are never swept: a flag is a
   * question, and approving over it would answer it silently.
   */
  const approveAll = useCallback(async () => {
    if (workspaceId === null || status === null || approvingAllRef.current) return;
    approvingAllRef.current = true;
    setConfirmingAll(false);
    setApprovingAll(true);
    setApproveAllFailed(0);
    // One sweep is one act: its own nonce, shared by its N calls (each still keyed per entry).
    const sweep = nonce();
    let failed = 0;
    try {
      for (const entry of status.entries) {
        if (entry.status !== 'open') continue;
        const { body } = await client.call('approve_entry', {
          workspaceId,
          entryId: entry.entryId,
          idempotencyKey: `approve:${workspaceId}:${entry.entryId}:${sweep}`,
        });
        if (isErr(body)) failed += 1;
      }
    } finally {
      approvingAllRef.current = false;
    }
    setApprovingAll(false);
    if (isCurrent(workspaceId, period)) setApproveAllFailed(failed);
    await loadRef.current();
  }, [client, workspaceId, status, period, isCurrent]);

  const total = status?.total ?? 0;
  const allApproved = useMemo(
    () => status !== null && total > 0 && status.open === 0 && status.flagged === 0,
    [status, total],
  );

  // The double-tap guard's state: the row a pointer selection just revealed, and until when.
  const revealGuard = useRef<{ entryId: string; until: number } | null>(null);
  const heldBack = useCallback((entryId: string, event: ReactMouseEvent) => {
    const guard = revealGuard.current;
    return event.detail > 0 && guard !== null && guard.entryId === entryId && performance.now() < guard.until;
  }, []);

  // The list columns for the shared DataTable. Each amount renders VERBATIM from the joined figure
  // (`formatMoney`), never a re-sum. The actions column exists only while the period is open: a
  // locked period is read-only, so it offers no write control at all (never shown-then-refused). Its
  // header is visually hidden (still read by assistive tech): the controls under it rest hidden, so a
  // visible "Aktionen" would label an empty column.
  const columns = useMemo<DataTableColumn<ReviewEntry>[]>(() => {
    const cols: DataTableColumn<ReviewEntry>[] = [
      {
        key: 'date',
        header: t('review.col.date'),
        render: (entry) => <span className="rv-date">{formatDate(entry.date)}</span>,
      },
      {
        key: 'ref',
        header: t('review.col.ref'),
        render: (entry) => <span className="rv-ref">{entry.ref ?? ''}</span>,
      },
      {
        key: 'description',
        header: t('review.col.description'),
        render: (entry) => (
          <span className="rv-desc">
            {entry.description ?? ''}
            {entry.commentCount > 0 && (
              <span className="rv-comment-count">
                <CommentGlyph size={14} aria-hidden="true" />
                {entry.commentCount}
              </span>
            )}
          </span>
        ),
      },
      {
        key: 'amount',
        header: t('review.col.amount'),
        numeric: true,
        render: (entry) =>
          entry.amountMinor === null ? (
            <span className="rv-no-amount" aria-label={t('review.noAmount')}>
              &ndash;
            </span>
          ) : (
            formatMoney(entry.amountMinor, currency)
          ),
      },
      {
        key: 'status',
        header: t('review.col.status'),
        render: (entry) => <StatusTag status={entry.status} />,
      },
    ];
    if (!locked) {
      cols.push({
        key: 'actions',
        header: t('review.col.actions'),
        headerHidden: true,
        align: 'end',
        render: (entry) => (
          <RowActions
            entry={entry}
            busy={busyEntry === entry.entryId}
            onSelect={setSelectedId}
            onApprove={approve}
            onOpen={openComposer}
            heldBack={heldBack}
          />
        ),
      });
    }
    return cols;
  }, [t, currency, locked, busyEntry, approve, openComposer, heldBack]);

  // Selecting a row is how its actions show without a pointer over it. A locked period has no row
  // actions, so its rows are not selectable (nothing would appear). A POINTER selection that reveals
  // the actions (they were not already showing: no hover-capable mouse over the row, no focus inside
  // it at the pointer's down) arms the double-tap guard. A keyboard selection never does.
  const toggleRow = useCallback(
    (entry: ReviewEntry) => {
      const selecting = selectedId !== entry.entryId;
      const press = lastPress.current;
      const byPointer = press !== null && press.entryId === entry.entryId && performance.now() - press.at < 1000;
      revealGuard.current =
        selecting && byPointer && !press.shown
          ? { entryId: entry.entryId, until: performance.now() + revealGuardMs() }
          : null;
      setSelectedId(selecting ? entry.entryId : null);
    },
    [selectedId],
  );

  /**
   * Where a pointer went down, and whether that row's actions were ALREADY showing then (read before
   * the press moves focus onto the row, which would reveal them itself). A mouse on a hover-capable
   * device showed them by hovering; a touch or pen press did not.
   */
  const lastPress = useRef<{ entryId: string; at: number; shown: boolean } | null>(null);
  const notePress = useCallback(
    (event: ReactPointerEvent) => {
      const row = event.target instanceof Element ? event.target.closest('tbody tr') : null;
      const entryId = row?.querySelector('[data-rv-entry]')?.getAttribute('data-rv-entry') ?? null;
      if (row === null || row === undefined || entryId === null) {
        lastPress.current = null;
        return;
      }
      const hoverShows =
        event.pointerType === 'mouse' &&
        (typeof window.matchMedia !== 'function' || window.matchMedia('(hover: hover)').matches);
      const shown = hoverShows || row.matches(':focus-within') || entryId === selectedId;
      lastPress.current = { entryId, at: performance.now(), shown };
    },
    [selectedId],
  );
  const rowLabel = useCallback(
    (entry: ReviewEntry) =>
      t('review.row', {
        date: formatDate(entry.date),
        text: entry.description !== null && entry.description !== '' ? entry.description : (entry.ref ?? ''),
        status: t(`review.status.${entry.status}`),
      }),
    [t],
  );

  if (workspaceId === null) return <NoWorkspaceState />;

  // The review capability gates the whole surface: an actor without it sees the padlock, not the
  // controls (spec §6, D115). Fail-open while whoami loads (useCan), so this only bites a real denial.
  if (!canReview || denied) {
    return (
      <section className="rv" aria-labelledby="review-title">
        <SurfaceHeader
          title={t('review.title')}
          titleId="review-title"
          help={<SurfaceHelp surface="Review" />}
        />
        <PermissionDenied body={t('review.permission')} />
      </section>
    );
  }

  return (
    <section className="rv" aria-labelledby="review-title" onPointerDownCapture={notePress}>
      <SurfaceHeader
        title={t('review.title')}
        titleId="review-title"
        help={<SurfaceHelp surface="Review" />}
        actions={
          <PeriodField
            granularity={granularity}
            month={month}
            year={year}
            onGranularity={setGranularity}
            onMonth={setMonth}
            onYear={setYear}
          />
        }
      />

      {locked && status !== null && (
        <div ref={lockedNoteRef} className="rv-locked panel" role="note">
          <LockGlyph className="rv-locked-glyph" size={20} />
          <div>
            <p className="rv-locked-title">{t('review.locked', { period: periodLabel })}</p>
            <p className="rv-locked-body">{t('review.lockedBody')}</p>
            <Link className="btn btn--secondary rv-action" to={`/export?period=${encodeURIComponent(status.period)}`}>
              {t('review.toExport')}
            </Link>
          </div>
        </div>
      )}

      {lockKind === 'soft' && status !== null && !loading && (
        <p className="rv-softclosed" role="note">
          {t('review.softClosed', { period: periodLabel })}
        </p>
      )}

      {status !== null && !loading && !failed && status.total > 0 && (
        <CoverageBar
          status={status}
          locked={locked}
          canManagePeriods={canManagePeriods}
          approvingAll={approvingAll}
          onApproveAll={() => setConfirmingAll(true)}
          onLock={() => {
            setLockFailed(false);
            setConfirming(true);
          }}
        />
      )}

      {approveAllFailed > 0 && (
        <p className="rv-dialog-error" role="alert">
          {t('review.approveAll.failed', { count: String(approveAllFailed) })}
        </p>
      )}

      {!loading && !failed && status !== null && status.total > 0 && allApproved && !locked && (
        <div className="rv-allclear panel" role="note">
          <CheckGlyph className="rv-allclear-glyph" size={20} />
          {/* "Du kannst die Periode sperren" only for someone who can: without manage_periods the
              bar offers no lock, so the note does not promise one. */}
          <p className="rv-allclear-text">{t(canManagePeriods ? 'review.allApproved' : 'review.allApprovedNoLock')}</p>
        </div>
      )}

      {failed ? (
        <ErrorBanner context="read" onRetry={() => void load()} />
      ) : (
        <DataTable
          columns={columns}
          rows={status !== null ? status.entries : []}
          rowKey={(entry) => entry.entryId}
          caption={t('review.title')}
          loading={loading}
          rowClassName={(entry) =>
            [entry.status === 'flagged' ? 'rv-row--flagged' : '', committed?.entryId === entry.entryId ? COMMIT_TARGET_CLASS : '']
              .filter((c) => c !== '')
              .join(' ') || undefined
          }
          onRowClick={locked ? undefined : toggleRow}
          rowLabel={locked ? undefined : rowLabel}
          isRowCurrent={locked ? undefined : (entry) => entry.entryId === selectedId}
          emptyState={<EmptyState title={t('review.empty')} hint={t('review.emptyHint')} />}
        />
      )}

      {status !== null && (
        <LockDialog
          open={confirming}
          period={periodLabel}
          periodStart={status.periodStart}
          periodEnd={status.periodEnd}
          pending={locking}
          failed={lockFailed}
          onConfirm={() => void confirmLock()}
          onCancel={() => setConfirming(false)}
        />
      )}

      {status !== null && (
        <Modal
          open={confirmingAll}
          role={ALERT_DIALOG}
          onClose={() => setConfirmingAll(false)}
          title={t('review.approveAll.title', { count: String(status.open) })}
          closeLabel={t('review.close')}
          describedById="rv-approve-all-body"
          footer={
            <>
              <button type="button" className="btn btn--secondary rv-action" onClick={() => setConfirmingAll(false)}>
                {t('review.cancel')}
              </button>
              <button type="button" className="btn btn--primary rv-action" onClick={() => void approveAll()}>
                {t('review.approveAll.confirm', { count: String(status.open) })}
              </button>
            </>
          }
        >
          {/* approve_entry is review metadata, not a governed write: the engine carries no dial
              sentence for it, so the shared ConsequenceLine has nothing to render and this
              surface-authored sentence says what the act does and does not do. */}
          <p id="rv-approve-all-body" className="rv-dialog-body">
            {t('review.approveAll.body', { flagged: String(status.flagged) })}
          </p>
        </Modal>
      )}

      <Modal
        open={composer !== null}
        onClose={closeComposer}
        title={composer?.kind === 'flag' ? t('review.flag') : t('review.comment')}
        closeLabel={t('review.close')}
        footer={
          <>
            <button type="button" className="btn btn--secondary" onClick={closeComposer}>
              {t('review.cancel')}
            </button>
            <button
              type="button"
              className="btn btn--primary"
              disabled={busyEntry !== null || draft.trim() === ''}
              onClick={() => void submitComposer()}
            >
              {composer?.kind === 'flag' ? t('review.flagSubmit') : t('review.commentSubmit')}
            </button>
          </>
        }
      >
        <div className="rv-composer">
          <label className="rv-composer-label" htmlFor="rv-composer-field">
            {composer?.kind === 'flag' ? t('review.flagReason') : t('review.commentText')}
          </label>
          <textarea
            id="rv-composer-field"
            className="field"
            rows={3}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
        </div>
      </Modal>
    </section>
  );
}

/**
 * K-22: the entry state is the shared Status: approved is done, flagged needs attention, open is new.
 * `rv-tag` carries no style any more; it stays as the hook the A25 audit and J4 friction flows read.
 */
function StatusTag({ status }: { status: ReviewEntry['status'] }) {
  const t = useT();
  if (status === 'approved') return <Status kind="success" label={t('review.status.approved')} className="rv-tag" />;
  if (status === 'flagged') return <Status kind="warn" label={t('review.status.flagged')} className="rv-tag" />;
  return <Status kind="neutral" label={t('review.status.open')} className="rv-tag" />;
}

interface RowActionsProps {
  entry: ReviewEntry;
  busy: boolean;
  /** Acting on a row selects it (never toggles it off), so its actions stay up while the act runs. */
  onSelect: (entryId: string) => void;
  onApprove: (entryId: string) => void;
  onOpen: (entryId: string, kind: 'flag' | 'comment') => void;
  /** True for a pointer click that lands while the row's actions are still being revealed. */
  heldBack: (entryId: string, event: ReactMouseEvent) => boolean;
}

/**
 * The row's three actions. They rest hidden and show on the hovered, focused or selected row (the
 * rule is in Review.css, keyed off DataTable's own row state), so this renders them on every open
 * row and the stylesheet decides when they are seen. A click inside never reaches the row's own
 * click (which toggles the selection): a click on an action selects the row instead.
 */
function RowActions({ entry, busy, onSelect, onApprove, onOpen, heldBack }: RowActionsProps) {
  const t = useT();
  return (
    <div
      className="rv-rowactions"
      data-rv-entry={entry.entryId}
      onClick={(event) => {
        event.stopPropagation();
        onSelect(entry.entryId);
      }}
    >
      {/* Each opens the composer dialog, so it says so (aria-haspopup) instead of claiming a pressed
          toggle state (K-11 keeps aria-pressed for FilterChips). */}
      <button
        type="button"
        className="rv-rowbtn"
        aria-label={t('review.comment')}
        aria-haspopup="dialog"
        disabled={busy}
        onClick={(event) => {
          if (!heldBack(entry.entryId, event)) onOpen(entry.entryId, 'comment');
        }}
      >
        <CommentGlyph size={16} />
      </button>
      <button
        type="button"
        className="rv-rowbtn"
        aria-label={t('review.flag')}
        aria-haspopup="dialog"
        disabled={busy}
        onClick={(event) => {
          if (!heldBack(entry.entryId, event)) onOpen(entry.entryId, 'flag');
        }}
      >
        <FlagGlyph size={16} />
      </button>
      {/* An approved row has nothing left to approve: the control is absent, never a grey check. Its
          slot stays, so comment and flag sit in the same place on every row. */}
      {entry.status === 'approved' ? (
        <span className="rv-rowbtn-slot" aria-hidden="true" />
      ) : (
        <button
          type="button"
          className="rv-rowbtn rv-rowbtn--approve"
          aria-label={t('review.approve')}
          disabled={busy}
          onClick={(event) => {
            if (!heldBack(entry.entryId, event)) onApprove(entry.entryId);
          }}
        >
          <CheckGlyph size={16} />
        </button>
      )}
    </div>
  );
}

export default Review;
