/**
 * A25 US-A25.1/.2/.3, Review (`/review`): the Treuhänder's period-scoped review of the posted books.
 *
 * IA is decision D115 (1a): Review and Export are two nested sibling screens under a Treuhänder rail
 * group, each owning its own period, its own five states, its own help. This screen carries the
 * sticky coverage header (2a): the counts, a meter, and Periode sperren disabled until the period is
 * clean. Per row it offers comment, flag and approve, each writing ONLY `entry_review` metadata: the
 * posted entry is never mutated (§H-AUDIT), and a correction after lock is a next-period reversal
 * (A02), never an edit.
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
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import { useClient } from '../../lib/client-context';
import { isErr } from '../../lib/client';
import { useWorkspaceId } from '../../app/workspace';
import { useT, formatMoney, formatDate } from '../../i18n';
import { SurfaceHelp } from '../../components/SurfaceHelp';
import { SurfaceHeader } from '../../components/SurfaceHeader';
import { DataTable, type DataTableColumn } from '../../components/DataTable';
import { Modal } from '../../components/Modal';
import { EmptyState, ErrorBanner, NoWorkspaceState, PermissionDenied } from '../../components/states';
import { useCan, CAP } from '../../lib/capabilities';
import { PeriodField } from './PeriodField';
import { CoverageBar } from './CoverageBar';
import { LockDialog } from './LockDialog';
import { CheckGlyph, CommentGlyph, DotGlyph, FlagGlyph } from './glyphs';
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

/** A locale nonce so each comment/flag is its own event rather than an idempotent replay. */
function nonce(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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
  const client = useClient();
  const workspaceId = useWorkspaceId();
  const canReview = useCan(CAP.review);
  const canManagePeriods = useCan(CAP.managePeriods);

  const [granularity, setGranularity] = useState<Granularity>('month');
  const [month, setMonth] = useState(currentMonth());
  const [year, setYear] = useState(currentYear());
  const period = periodValue(granularity, month, year);

  const [status, setStatus] = useState<ReviewStatus | null>(null);
  const [currency, setCurrency] = useState('CHF');
  const [lockKind, setLockKind] = useState<LockKind>(null);
  const locked = lockKind === 'hard';
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [denied, setDenied] = useState(false);

  const [composer, setComposer] = useState<Composer>(null);
  const [draft, setDraft] = useState('');
  const [busyEntry, setBusyEntry] = useState<string | null>(null);

  const [confirming, setConfirming] = useState(false);
  const [locking, setLocking] = useState(false);
  const [lockFailed, setLockFailed] = useState(false);
  const [confirmingAll, setConfirmingAll] = useState(false);
  const [approvingAll, setApprovingAll] = useState(false);
  const [approveAllFailed, setApproveAllFailed] = useState(0);

  const load = useCallback(async () => {
    if (workspaceId === null) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setFailed(false);
    setDenied(false);
    const statusRes = await client.call('review_status', { workspaceId, period });
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
  }, [client, workspaceId, period]);

  useEffect(() => {
    void load();
  }, [load]);

  const approve = useCallback(
    async (entryId: string) => {
      if (workspaceId === null) return;
      setBusyEntry(entryId);
      const { body } = await client.call('approve_entry', {
        workspaceId,
        entryId,
        idempotencyKey: `approve:${workspaceId}:${entryId}`,
      });
      setBusyEntry(null);
      if (!isErr(body)) await load();
    },
    [client, workspaceId, load],
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
      setComposer(null);
      setDraft('');
      await load();
    }
  }, [client, workspaceId, composer, draft, load]);

  const openComposer = useCallback((entryId: string, kind: 'flag' | 'comment') => {
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
    if (workspaceId === null || status === null) return;
    setLocking(true);
    setLockFailed(false);
    const { body } = await client.call('lock_period', {
      workspaceId,
      period,
      kind: 'hard',
      reason: 'treuhaender_review',
      idempotencyKey: `lock:${workspaceId}:${period}`,
    });
    setLocking(false);
    if (isErr(body)) {
      setLockFailed(true);
      return;
    }
    setConfirming(false);
    setLockKind('hard');
  }, [client, workspaceId, status, period]);

  /**
   * "Alle freigeben" (J4.3 ideal step 2): ONE act with ONE confirm for the open, unflagged rest. The
   * engine has no bulk verb and needs none: `approve_entry` is idempotent per entry key, so the act
   * is the same N calls a person would click, issued in order, and a failure stops the run and says
   * how many did not land rather than pretending. Flagged entries are never swept: a flag is a
   * question, and approving over it would answer it silently.
   */
  const approveAll = useCallback(async () => {
    if (workspaceId === null || status === null) return;
    setConfirmingAll(false);
    setApprovingAll(true);
    setApproveAllFailed(0);
    let failed = 0;
    for (const entry of status.entries) {
      if (entry.status !== 'open') continue;
      const { body } = await client.call('approve_entry', {
        workspaceId,
        entryId: entry.entryId,
        idempotencyKey: `approve:${workspaceId}:${entry.entryId}`,
      });
      if (isErr(body)) failed += 1;
    }
    setApprovingAll(false);
    setApproveAllFailed(failed);
    await load();
  }, [client, workspaceId, status, load]);

  const total = status?.total ?? 0;
  const allApproved = useMemo(
    () => status !== null && total > 0 && status.open === 0 && status.flagged === 0,
    [status, total],
  );

  // The list columns for the shared DataTable. Each amount renders VERBATIM from the joined figure
  // (`formatMoney`), never a re-sum. The actions column exists only while the period is open: a
  // locked period is read-only, so it offers no write control at all (never shown-then-refused).
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
        align: 'end',
        render: (entry) => (
          <RowActions
            entry={entry}
            busy={busyEntry === entry.entryId}
            composer={composer}
            onApprove={approve}
            onOpen={openComposer}
          />
        ),
      });
    }
    return cols;
  }, [t, currency, locked, busyEntry, composer, approve, openComposer]);

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
    <section className="rv" aria-labelledby="review-title">
      <SurfaceHeader
        title={t('review.title')}
        titleId="review-title"
        subtitle={t('review.subtitle')}
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
        <div className="rv-locked panel" role="note">
          <LockGlyph className="rv-locked-glyph" size={20} />
          <div>
            <p className="rv-locked-title">{t('review.locked', { period })}</p>
            <p className="rv-locked-body">{t('review.lockedBody')}</p>
            <Link className="btn btn--secondary rv-action" to={`/export?period=${encodeURIComponent(status.period)}`}>
              {t('review.toExport')}
            </Link>
          </div>
        </div>
      )}

      {lockKind === 'soft' && status !== null && !loading && (
        <p className="rv-softclosed" role="note">
          {t('review.softClosed', { period })}
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
          <p className="rv-allclear-text">{t('review.allApproved')}</p>
        </div>
      )}

      {failed ? (
        <ErrorBanner onRetry={() => void load()} />
      ) : (
        <DataTable
          columns={columns}
          rows={status !== null ? status.entries : []}
          rowKey={(entry) => entry.entryId}
          caption={t('review.title')}
          loading={loading}
          rowClassName={(entry) => (entry.status === 'flagged' ? 'rv-row--flagged' : undefined)}
          emptyState={<EmptyState title={t('review.empty')} hint={t('review.emptyHint')} />}
        />
      )}

      {status !== null && (
        <LockDialog
          open={confirming}
          period={period}
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
              <button type="button" className="btn btn--accent rv-action" onClick={() => void approveAll()}>
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
              className="btn btn--accent"
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
            className="rv-textarea"
            rows={3}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
        </div>
      </Modal>
    </section>
  );
}

function StatusTag({ status }: { status: ReviewEntry['status'] }) {
  const t = useT();
  if (status === 'approved') {
    return (
      <span className="rv-tag rv-tag--approved">
        <CheckGlyph size={16} aria-hidden="true" />
        {t('review.status.approved')}
      </span>
    );
  }
  if (status === 'flagged') {
    return (
      <span className="rv-tag">
        <FlagGlyph size={16} aria-hidden="true" />
        {t('review.status.flagged')}
      </span>
    );
  }
  return (
    <span className="rv-tag">
      <DotGlyph size={16} aria-hidden="true" />
      {t('review.status.open')}
    </span>
  );
}

interface RowActionsProps {
  entry: ReviewEntry;
  busy: boolean;
  composer: Composer;
  onApprove: (entryId: string) => void;
  onOpen: (entryId: string, kind: 'flag' | 'comment') => void;
}

function RowActions({ entry, busy, composer, onApprove, onOpen }: RowActionsProps) {
  const t = useT();
  const commentOn = composer !== null && composer.entryId === entry.entryId && composer.kind === 'comment';
  const flagOn = composer !== null && composer.entryId === entry.entryId && composer.kind === 'flag';
  return (
    <div className="rv-rowactions">
      <button
        type="button"
        className={`rv-rowbtn ${commentOn ? 'rv-rowbtn--on' : ''}`}
        aria-label={t('review.comment')}
        aria-pressed={commentOn}
        disabled={busy}
        onClick={() => onOpen(entry.entryId, 'comment')}
      >
        <CommentGlyph size={16} />
      </button>
      <button
        type="button"
        className={`rv-rowbtn ${flagOn ? 'rv-rowbtn--on' : ''}`}
        aria-label={t('review.flag')}
        aria-pressed={flagOn}
        disabled={busy}
        onClick={() => onOpen(entry.entryId, 'flag')}
      >
        <FlagGlyph size={16} />
      </button>
      <button
        type="button"
        className="rv-rowbtn rv-rowbtn--approve"
        aria-label={t('review.approve')}
        disabled={busy || entry.status === 'approved'}
        onClick={() => onApprove(entry.entryId)}
      >
        <CheckGlyph size={16} />
      </button>
    </div>
  );
}

export default Review;
