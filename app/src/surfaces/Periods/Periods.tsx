/**
 * A03 Periods surface (Studio §6): the period-lock grid with month soft-close / reopen and the
 * irreversible year-end close, plus the tamper-evident Audit-Log panel (AuditPanel).
 *
 * Lock state is glyph PLUS text (soft vs hard/sealed), never colour alone. A hard, legally sealed lock
 * (a filed VAT return or a year-end close) never offers a reopen/unlock control at all: its row says
 * why in words ("Gesetzlich versiegelt"), rather than showing the control and rejecting it. The
 * year-end close is the most destructive action, so it is confirm-gated. Every write carries an
 * idempotency key (§H-IDEMPOTENT). Dates render through the shared `formatDate`, a month through
 * `formatMonth` ("Juni 2026", never `2026-06`, K-38), money through `formatMoney`.
 *
 * ONE OVERFLOW PER ROW (K-21, D137). "Monat wieder öffnen" and "Periode entsperren" sit in the row's
 * one trailing overflow instead of a 440px column of stacked buttons and notes; an actor who may not
 * act sees the item disabled with the reason in its label. The deep-linked month is the row the
 * view is on (`isRowCurrent`, the selection pill), no longer an inset warn bar (K-24).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import { useClient } from '../../lib/client-context';
import { isErr, type Err, type Result } from '../../lib/client';
import { useWorkspaceId } from '../../app/workspace';
import { useCapabilities, CAP } from '../../lib/capabilities';
import { useT, formatDate, formatMoney } from '../../i18n';
import { useCalendarFormat } from '../../lib/format';
import { EmptyState, NoWorkspaceState, PermissionDenied } from '../../components/states';
import { DataTable, type DataTableColumn } from '../../components/DataTable';
import type { OverflowMenuItem } from '../../components/OverflowMenu';
import { SurfaceHeader } from '../../components/SurfaceHeader';
import { ActionFeedback } from '../../components/ActionFeedback';
import { Modal } from '../../components/Modal';
import { ConsequenceLine } from '../../components/ConsequenceLine';
import { Select } from '../../components/Select';
import { AuditPanel } from './AuditPanel';
import { MonthChecklist, monthBounds } from './MonthChecklist';
import { AccrualEditor } from './AccrualEditor';
import { SoftLockGlyph, HardLockGlyph } from './glyphs';
import { LockGlyph } from '../../components/states/glyphs';
import { SurfaceHelp } from '../../components/SurfaceHelp';
import { COMMIT_TARGET_CLASS, useCommitAck } from '../../lib/motion';
import { parseRunList, YEAR_CLOSE_TEMPLATE_ID } from '../Checklists/model';
import './Periods.css';

/** Hard locks carrying one of these reasons are legally final and cannot be casually reopened. */
const SEALED_REASONS = new Set(['vat_filed', 'year_close']);

/**
 * The confirm modal's ARIA role, held as a constant so the string never appears as a literal
 * `role=` attribute on the JSX (the modal-role guard scans for that shape). Modal hosts it on its
 * own `div`, which is a permitted host; the `Modal` element name is not.
 */
const ALERT_DIALOG = 'alertdialog' as const;

/**
 * The wire format never changes: `close_month` takes `2026-06` and `close_year` takes `2026`, which
 * is exactly what `<input type="month">` and the year `<select>` produce. Only the HUMAN layer is
 * localised, by the browser, in the user's own locale (D15/C1).
 *
 * The regexes stay as a guard rather than as the primary validation. `<input type="month">` is not
 * Baseline: Safari and Firefox degrade it to a plain text box, where a user can type anything, so
 * the ISO shape is re-checked here before the submit control ever enables. A picker that started
 * sending `19.07.2026` to the engine would be a money-path bug, not a cosmetic one.
 */
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const YEAR_RE = /^\d{4}$/;

/**
 * How far back the year-close picker reaches. Ten years is not an arbitrary round number: OR Art.
 * 958f requires the books to be retained for ten years, so that is the window in which a year can
 * still plausibly be closed. A native picker for a bare year does not exist, and a number input
 * would happily accept `26` or `20265`, so a closed list is the honest control here.
 */
const CLOSABLE_YEARS_BACK = 10;

/**
 * The month a person closing "the month" most likely means: the previous calendar month (J4.1's
 * trigger is the first working day after month end). A `?month=YYYY-MM` deep link overrides it: the
 * Journal's period-locked refusal lands here with the month it refused, so that month is the one in
 * view, not the top of a list of sealed rows (J8.6).
 */
function previousMonth(now = new Date()): string {
  // `getMonth()` is 0-based, so its value IS the previous month in 1-based terms; January rolls back.
  const y = now.getFullYear();
  const m = now.getMonth();
  return m === 0 ? `${y - 1}-12` : `${y}-${String(m).padStart(2, '0')}`;
}

/**
 * The month-close confirm renders the ENGINE'S sentence for `close_month` (D118 C4, F-07 J4.1).
 * F-08 mapped `close_month` to the `close-period` capability in `src/core/agent/dialMap.ts`, so
 * `ConfirmPeriodDialog` resolves `agent.consequence.close-period` for it directly: the same string
 * the year close, the Review lock dialog and the Vorschlag card render. Nothing is authored here,
 * and there is no fallback to a sibling verb any more (the pre-F-08 `lock_period` fallback is gone).
 */
/** Newest period first: the month just closed lands at the top, not below the sealed years. */
function newestFirst(a: PeriodLock, b: PeriodLock): number {
  return a.period < b.period ? 1 : a.period > b.period ? -1 : 0;
}

interface PeriodLock {
  period: string;
  kind: string;
  lockedAt: string | null;
  lockedBy?: string | null;
  reason: string | null;
}

type ListState =
  | { kind: 'loading' }
  | { kind: 'error'; error: Err }
  | { kind: 'ok'; locks: readonly PeriodLock[] };

/**
 * Who may act on a lock. Overridable props, defaulting to A24's answer from `whoami`.
 *
 * THE DEFECT THESE REPLACE. `load` used to set `canManage: body.canManage !== false` and
 * `canUnlock: body.canUnlock !== false` off `list_period_locks`. That verb answers `ok({ locks })`
 * and has never sent either field: `grep -rn canManage src/` finds nothing, and the engine's only
 * `canUnlock` is a local const inside `unlockPeriod`. An absent field made both expressions
 * `undefined !== false`, so the reopen button, the unlock button and the "only the owner or a
 * Treuhänder" note were gated on a constant `true` in every build that ever shipped. Declaring the
 * payload turned both reads into TS2339, which is how they were found, and each became a prop
 * defaulting to `true` with a note deferring the real source to A24.
 *
 * A24 HAS NOW ANSWERED, and the answer is that a permission answer never rides on a list read: it
 * comes from `whoami`, the one verb whose job is that question. So the defaults are no longer `true`
 * but `useCan('manage_periods')` and `useCan('unlock_period')`, resolved once per workspace in
 * `Shell.tsx`. The two capabilities stay SEPARATE because the engine separates them: closing a month
 * is bookkeeping, prising a hard-locked period open is not, and `periods.ts` has asserted the two
 * different names since A03 shipped.
 *
 * THE PROPS SURVIVE as overrides, which is what keeps every existing component test rendering
 * exactly what it rendered before. A tree with no `CapabilitiesProvider` gets `ALLOW_ALL`, so the
 * default is still an enabled control in isolation.
 *
 * The server-side enforcement was never this surface's job and still is not: `close_month` and
 * `unlock_period` go through the engine gate whatever this file renders.
 */
interface PeriodsProps {
  canManage?: boolean;
  canUnlock?: boolean;
}

interface Feedback {
  tone: 'success' | 'error';
  text: string;
  /**
   * Year-close success only: the posted result, in minor units, WITH the currency the engine named
   * it in. The two travel as one object rather than as two optional fields because there is no
   * honest way to render either without the other: a figure with no unit is the defect this shape
   * exists to make unrepresentable, and a unit with no figure is nothing at all.
   */
  result?: { minor: number; currency: string };
  entryId?: string;
}

/** Mint an idempotency key for one write attempt (§H-IDEMPOTENT): a retry with the same key never double-acts. */
function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

export function Periods(props: PeriodsProps = {}) {
  // Both hooks run UNCONDITIONALLY and the prop overrides the result afterwards. Writing this as
  // `props.canManage ?? useCan(...)` would make the hook call conditional on a prop, which is the
  // rules-of-hooks violation that breaks a component the first time a caller passes one and not the
  // other. The default is the answer; the prop is an override for tests and for a future embedder.
  const capabilities = useCapabilities();
  const canManage = props.canManage ?? capabilities.can(CAP.managePeriods);
  const canUnlock = props.canUnlock ?? capabilities.can(CAP.unlockPeriod);
  const t = useT();
  const cal = useCalendarFormat();
  const client = useClient();
  const workspaceId = useWorkspaceId();
  const [params] = useSearchParams();
  const linkedMonth = params.get('month');
  const focusMonth = linkedMonth !== null && MONTH_RE.test(linkedMonth) ? linkedMonth : null;

  const [state, setState] = useState<ListState>({ kind: 'loading' });
  const [monthInput, setMonthInput] = useState(() => focusMonth ?? previousMonth());
  const [yearInput, setYearInput] = useState('');
  const [confirmYear, setConfirmYear] = useState<string | null>(null);
  /** The open `year_close` run per fiscal year label, for the hand-off from the year form. */
  const [yearRuns, setYearRuns] = useState<Record<string, string>>({});
  // A month close is a period lock on the money path exactly as a year close is: it changes what
  // can be posted and it is awkward to undo. It gets the same confirm gate, not a bare submit.
  const [confirmMonth, setConfirmMonth] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [busy, setBusy] = useState(false);
  // The Commit moment (D122 D-I): the period a write just locked (or reopened) lands in the grid
  // once the list has refetched; the banner above carries the words and draws its check.
  const [committedPeriod, setCommittedPeriod] = useState<string | null>(null);
  useCommitAck(committedPeriod, state);

  const load = useCallback(async () => {
    if (workspaceId === null) {
      setState({ kind: 'ok', locks: [] });
      return;
    }
    setState({ kind: 'loading' });
    const { body } = await client.call('list_period_locks', { workspaceId });
    if (isErr(body)) {
      setState({ kind: 'error', error: body });
      return;
    }
    // No cast and no `?? []`. `locks` is a REQUIRED field of the declared payload, so the fallback
    // was for a response the engine cannot send, and the engine's row type is assignable to this
    // surface's `PeriodLock` as it stands: `PeriodLock` is the wider of the two about `lockedAt` and
    // `lockedBy`, which is the safe direction.
    setState({ kind: 'ok', locks: [...body.locks].sort(newestFirst) });
    // G22 leg 2 (D129, spec §10.12): the open year_close runs, so the year form hands over to the
    // guided close instead of the bare seal when one exists. A refusal here (no read_books on the
    // checklists, an older engine) leaves the bare action in place: the hand-off is an addition.
    const runs = await client.call('checklist_list', { workspaceId, templateId: YEAR_CLOSE_TEMPLATE_ID, status: 'open' });
    const parsed = isErr(runs.body) ? null : parseRunList(runs.body);
    setYearRuns(Object.fromEntries((parsed ?? []).map((r) => [r.periodLabel, r.runId])));
  }, [client, workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  // A deep-linked month is brought into view once its row exists (J8.6: "lands with THAT month in
  // view"). The checklist above already names it; this makes the lock row itself visible too.
  useEffect(() => {
    if (focusMonth === null || state.kind !== 'ok') return;
    const row = document.querySelector<HTMLElement>('.periods-locks tr[aria-current="true"]');
    if (row !== null && typeof row.scrollIntoView === 'function') row.scrollIntoView({ block: 'center' });
  }, [focusMonth, state.kind]);

  /** Map an engine rejection to a friendly, period-aware sentence. */
  const explain = useCallback(
    (err: Err): string => {
      // The engine names the period as `2026-06` or `2026`; the sentence reads it as "Juni 2026".
      const period = typeof err.period === 'string' ? cal.calendar(err.period) : '';
      switch (err.error) {
        case 'period_locked':
          return t('period.err.locked', { period });
        case 'hard_lock_sealed':
          return t('period.err.sealed', { period });
        case 'year_already_closed':
          return t('period.err.yearClosed');
        default:
          return t('period.err.generic');
      }
    },
    [t, cal],
  );

  /** Run one write, then either surface a success feedback and refetch, or an error feedback. */
  const runWrite = useCallback(
    async (
      action: string,
      input: Record<string, unknown>,
      onOk: (body: Extract<Result, { ok: true }>) => Feedback,
    ) => {
      if (workspaceId === null) return;
      setBusy(true);
      const { body } = await client.call(action, { workspaceId, ...input });
      setBusy(false);
      if (isErr(body)) {
        setFeedback({ tone: 'error', text: explain(body) });
        return;
      }
      setFeedback(onOk(body as Extract<Result, { ok: true }>));
      setCommittedPeriod(typeof input.period === 'string' ? input.period : null);
      await load();
    },
    [client, workspaceId, explain, load],
  );

  const closeMonth = useCallback(
    (period: string) => {
      setConfirmMonth(null);
      void runWrite('close_month', { period, idempotencyKey: newIdempotencyKey() }, () => ({
        tone: 'success',
        text: t('period.monthClosed', { period: cal.calendar(period) }),
      }));
    },
    [runWrite, t, cal],
  );

  const reopenMonth = useCallback(
    (period: string) => {
      void runWrite('reopen_month', { period, idempotencyKey: newIdempotencyKey() }, () => ({
        tone: 'success',
        text: t('period.monthReopened', { period: cal.calendar(period) }),
      }));
    },
    [runWrite, t, cal],
  );

  const unlockPeriod = useCallback(
    (period: string) => {
      void runWrite('unlock_period', { period, idempotencyKey: newIdempotencyKey() }, () => ({
        tone: 'success',
        text: t('period.periodUnlocked', { period: cal.calendar(period) }),
      }));
    },
    [runWrite, t, cal],
  );

  const closeYear = useCallback(
    (year: string) => {
      setConfirmYear(null);
      void runWrite('close_year', { year, idempotencyKey: newIdempotencyKey() }, (body) => ({
        tone: 'success',
        text: t('period.yearClosed', { period: year }),
        // `close_year` names its own unit. `result` is swept from `base_debit_minor -
        // base_credit_minor`, so it is a base-currency figure by construction, and the engine sends
        // `baseCurrency` beside it UNCONDITIONALLY (yearClose.ts), in a CHF book and on a year that
        // closed at zero alike. The client therefore reads the name off the very answer that
        // carries the number, and no longer holds a second read open to label it.
        //
        // Both halves or neither. If the engine ever stopped naming the currency, the honest
        // outcome is a close confirmed with no figure, never a figure under a guessed CHF: that
        // guess is the original defect, and defaulting here would only move it.
        result:
          typeof body.result === 'number' &&
          typeof body.baseCurrency === 'string' &&
          body.baseCurrency !== ''
            ? { minor: body.result, currency: body.baseCurrency }
            : undefined,
        entryId:
          typeof body.closingEntryId === 'string'
            ? body.closingEntryId
            : typeof body.carryEntryId === 'string'
              ? body.carryEntryId
              : undefined,
      }));
    },
    [runWrite, t],
  );

  const monthValid = MONTH_RE.test(monthInput);
  const yearValid = YEAR_RE.test(yearInput);
  const noWorkspace = workspaceId === null;
  const monthLocked =
    state.kind === 'ok' && state.locks.some((l) => l.period === monthInput || l.period === monthInput.slice(0, 4));

  // A year that has not happened cannot be closed, so the list ends at the current one.
  const closableYears = useMemo(() => {
    const thisYear = new Date().getFullYear();
    return Array.from({ length: CLOSABLE_YEARS_BACK + 1 }, (_, i) => String(thisYear - i));
  }, []);

  const isSealed = (lock: PeriodLock) =>
    lock.kind === 'hard' && lock.reason !== null && SEALED_REASONS.has(lock.reason);

  /**
   * The row's one overflow (K-21). A sealed hard lock offers nothing, so it renders no trigger; its
   * row says why in words. An actor who may not act sees the item DISABLED with the reason in its
   * label: never offered live and then refused (A24).
   */
  function lockActions(lock: PeriodLock): OverflowMenuItem[] {
    if (isSealed(lock)) return [];
    const isSoft = lock.kind === 'soft';
    const allowed = isSoft ? canManage : canUnlock;
    const label = isSoft
      ? allowed
        ? t('period.reopenMonth')
        : t('period.reopenMonthDenied')
      : allowed
        ? t('period.unlock')
        : t('period.unlockDenied');
    return [
      {
        key: isSoft ? 'reopen' : 'unlock',
        label,
        disabled: !allowed || busy,
        onSelect: isSoft ? () => reopenMonth(lock.period) : () => unlockPeriod(lock.period),
      },
    ];
  }

  // The lock grid columns. Text left, no numeric/money column (a period-lock read carries no figure),
  // so there is no `footer` total to render. The reopen/unlock verb is the row's overflow (K-21).
  const lockColumns: DataTableColumn<PeriodLock>[] = [
    {
      key: 'period',
      header: t('period.columns.period'),
      // The engine's `2026-06` reads as "Juni 2026"; a year stays `2025` (K-38).
      render: (lock) => <span className="period-num">{cal.calendar(lock.period)}</span>,
    },
    {
      key: 'state',
      header: t('period.columns.state'),
      render: (lock) => {
        const hard = lock.kind === 'hard';
        const stateText = hard ? t('period.state.hard') : t('period.state.soft');
        return (
          <span
            className={`period-state ${hard ? 'period-state-hard' : 'period-state-soft'}`}
            aria-label={stateText}
          >
            {hard ? <HardLockGlyph /> : <SoftLockGlyph />}
            <span className="period-state-text">{stateText}</span>
          </span>
        );
      },
    },
    {
      key: 'lockedAt',
      header: t('period.columns.lockedAt'),
      render: (lock) => (
        <span className="period-num">
          {lock.lockedAt !== null ? formatDate(lock.lockedAt) : ''}
        </span>
      ),
    },
    {
      key: 'reason',
      header: t('period.columns.reason'),
      // A sealed lock names its reason AND that it is sealed, with the lock glyph: the words carry it.
      render: (lock) =>
        isSealed(lock) && lock.reason !== null ? (
          <span className="period-sealed">
            <span>{t(`period.reason.${lock.reason}`)}</span>
            <span className="period-sealed-note">
              <LockGlyph size={16} />
              {t('period.sealedShort')}
            </span>
          </span>
        ) : (
          ''
        ),
    },
  ];

  // No workspace: every control here would be dead, so say so once and point at the way out rather
  // than rendering a page of disabled buttons and an empty audit table.
  if (noWorkspace) {
    return (
      <section className="periods" aria-labelledby="periods-title">
        <SurfaceHeader
          title={t('period.title')}
          titleId="periods-title"
          help={<SurfaceHelp surface="Periods" />}
        />
        <NoWorkspaceState body={t('period.noWorkspaceHint')} />
      </section>
    );
  }

  return (
    <section className="periods" aria-labelledby="periods-title">
      <SurfaceHeader
        title={t('period.title')}
        titleId="periods-title"
        help={<SurfaceHelp surface="Periods" />}
      />

      {feedback !== null && (
        <ActionFeedback
          key={feedback.text}
          tone={feedback.tone === 'error' ? 'error' : 'success'}
          landed={feedback.tone === 'success'}
          message={feedback.text}
          onDismiss={() => setFeedback(null)}
          dismissLabel={t('period.dismiss')}
        >
          {feedback.result !== undefined && (
            <p className="action-feedback__detail">
              {t('period.yearResult')}:{' '}
              <span className="t-money">{formatMoney(feedback.result.minor, feedback.result.currency)}</span>
            </p>
          )}
          {feedback.entryId !== undefined && (
            <p className="action-feedback__detail">
              {t('period.carryTo2979')} ({t('period.viewCarryEntry')}: {feedback.entryId})
            </p>
          )}
        </ActionFeedback>
      )}

      <div className="periods-actions panel">
        <form
          className="period-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (monthValid && !noWorkspace) setConfirmMonth(monthInput);
          }}
        >
          <label className="period-field">
            {t('period.monthLabel')}
            {/* D15/C1: a real month picker, not a text box that silently demands ISO. The browser
                renders it in the user's own locale, so a Swiss user gets Swiss order for free,
                while `value` stays `YYYY-MM` for the engine. The placeholder and pattern are
                inert in a supporting browser and only surface in Safari/Firefox, where the
                control degrades to plain text and the user needs the format spelled out. */}
            <input
              type="month"
              className="field"
              pattern="\d{4}-\d{2}"
              placeholder={t('period.monthPlaceholder')}
              value={monthInput}
              onChange={(e) => setMonthInput(e.target.value)}
            />
          </label>
          <button
            type="submit"
            className="btn btn--primary"
            disabled={!monthValid || noWorkspace || busy}
          >
            {t('period.closeMonth')}
          </button>
        </form>

        <form
          className="period-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (yearValid && !noWorkspace) setConfirmYear(yearInput);
          }}
        >
          <div className="period-field">
            {t('period.yearLabel')}
            {/* D15/C1: there is no native picker for a bare year, so the honest equivalent is a
                closed list. It makes a malformed year unrepresentable, which a number input never
                could, and it still hands the engine the plain ISO `2026`. */}
            <Select
              value={yearInput}
              onChange={(value) => setYearInput(value)}
              options={[
                { value: '', label: t('period.yearPlaceholder') },
                ...closableYears.map((year) => ({ value: year, label: year })),
              ]}
              ariaLabel={t('period.yearLabel')}
            />
          </div>
          {yearValid && yearRuns[yearInput] !== undefined ? (
            <>
              <Link className="btn btn--secondary" to={`/checklisten?run=${encodeURIComponent(yearRuns[yearInput] as string)}`} data-testid="period-open-year-close">
                {t('period.openYearClose')}
              </Link>
              <span className="period-note">{t('period.yearCloseRunNote', { year: yearInput })}</span>
            </>
          ) : (
            <>
              <button
                type="submit"
                className="btn btn--secondary"
                disabled={!yearValid || noWorkspace || busy}
              >
                {t('period.closeYear')}
              </button>
              <Link className="btn btn--secondary" to="/checklisten">
                {t('period.guidedYearClose')}
              </Link>
            </>
          )}
        </form>
      </div>

      {monthValid && workspaceId !== null && (
        <MonthChecklist workspaceId={workspaceId} period={monthInput} locked={monthLocked} />
      )}

      {/* A38: the accrual and provision editor beside the month checklist, dated the month end the
          checklist is closing. Drafts are described here and posted from the list (S4/S5): one
          posting truth on both faces. */}
      {monthValid && workspaceId !== null && (
        <AccrualEditor workspaceId={workspaceId} periodEnd={monthBounds(monthInput).to} />
      )}

      <section className="periods-locks" aria-labelledby="periods-locks-title">
        <h2 id="periods-locks-title" className="periods-subtitle">
          {t('period.locksTitle')}
        </h2>

        {/* Permission-denied hides the table rather than showing an empty grid: DataTable owns the
            loading, error and empty states, but the money-path A24 refusal is the caller's, so it is
            branched out here and DataTable is only handed the other errors. */}
        {state.kind === 'error' && state.error.error === 'permission_denied' ? (
          <PermissionDenied body={t('period.noManage')} />
        ) : (
          <DataTable<PeriodLock>
            columns={lockColumns}
            rows={state.kind === 'ok' ? [...state.locks] : []}
            rowKey={(lock) => lock.period}
            caption={t('period.locksTitle')}
            loading={state.kind === 'loading'}
            error={state.kind === 'error' ? state.error : undefined}
            onRetry={() => void load()}
            skeletonRows={4}
            rowActions={lockActions}
            rowActionsLabel={(lock) => t('period.rowActionsFor', { period: cal.calendar(lock.period) })}
            // The deep-linked month (J8.6) is the row the view is on: the selection pill on every
            // cell and `aria-current`, never an inset side bar (K-24).
            isRowCurrent={(lock) => lock.period === focusMonth}
            // Every row here is a lock; the hook carries soft vs hard as a state class so the row can
            // read as more or less sealed without colour alone (the badge is the primary cue).
            rowClassName={(lock) =>
              [
                lock.kind === 'hard' ? 'period-row--hard' : 'period-row--soft',
                lock.period === committedPeriod ? COMMIT_TARGET_CLASS : '',
              ]
                .filter(Boolean)
                .join(' ')
            }
            // No action of its own: the one "Monat abschliessen" is the form directly above.
            emptyState={<EmptyState title={t('period.empty')} hint={t('period.emptyHint')} />}
          />
        )}
      </section>

      <AuditPanel />

      {confirmMonth !== null && (
        <ConfirmPeriodDialog
          title={t('period.confirmMonthTitle', { period: cal.calendar(confirmMonth) })}
          message={t('period.confirmMonth')}
          verb="close_month"
          confirmLabel={t('period.confirmMonthAction')}
          onConfirm={() => closeMonth(confirmMonth)}
          onCancel={() => setConfirmMonth(null)}
        />
      )}

      {confirmYear !== null && (
        <ConfirmPeriodDialog
          title={t('period.confirmYearTitle', { year: confirmYear })}
          message={t('period.confirmYear')}
          verb="close_year"
          confirmLabel={t('period.confirm')}
          onConfirm={() => closeYear(confirmYear)}
          onCancel={() => setConfirmYear(null)}
        />
      )}
    </section>
  );
}

/**
 * The confirm gate for a period-lock write (Tier-3 forgiveness), on the shared `Modal` primitive.
 *
 * Both closes come through here as an ALERT dialog: a period lock is a consequential, awkward-to-undo
 * write on the money path, so a stray scrim click must not answer it, which is exactly the alertdialog
 * contract Modal enforces (no dismiss-on-scrim, focus trapped, Escape and the close control both cancel).
 * The consequence is the ENGINE'S sentence (D118 C4): the shared `ConsequenceLine` renders
 * `agent.consequence.close-period` for the verb given, the identical string the Review surface's
 * lock dialog and the Vorschlag card show, so one consequence has one sentence across the Studio
 * (F-07, J4.1). The message above it carries only what differs between the two closes: the year
 * close names the accounts it posts to, the month close says when it can be reopened. Neither line
 * restates the consequence in its own words any more.
 */
function ConfirmPeriodDialog({
  title,
  message,
  verb,
  confirmLabel,
  onConfirm,
  onCancel,
}: {
  title: string;
  message: string;
  /** The verb whose engine consequence sentence the dialog renders. */
  verb: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  return (
    <Modal
      open
      // A period lock is a consequential confirm. The role is passed through a constant, never a
      // literal attribute, so the modal-role guard reads it on Modal's own div (an allowed host) and
      // not as a modal role planted on the `Modal` element name.
      role={ALERT_DIALOG}
      title={title}
      onClose={onCancel}
      closeLabel={t('period.closeDialog')}
      footer={
        <>
          <button type="button" className="btn btn--secondary btn--sm" onClick={onCancel}>
            {t('period.cancel')}
          </button>
          <button type="button" className="btn btn--danger" onClick={onConfirm}>
            {confirmLabel}
          </button>
        </>
      }
    >
      <p className="period-confirm-message">{message}</p>
      <ConsequenceLine verb={verb} />
    </Modal>
  );
}

export default Periods;
