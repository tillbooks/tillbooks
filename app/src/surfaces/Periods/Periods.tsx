/**
 * A03 Periods surface (Studio §6): the period-lock grid with month soft-close / reopen, the door to
 * the guided year-end close, plus the tamper-evident Audit-Log panel (AuditPanel).
 *
 * Lock state is glyph PLUS text (soft vs hard/sealed), never colour alone. A hard, legally sealed lock
 * (a filed VAT return or a year-end close) never offers a reopen/unlock control at all: its row says
 * why in words ("Gesetzlich versiegelt"), rather than showing the control and rejecting it. Every
 * write carries an idempotency key (§H-IDEMPOTENT). Dates render through the shared `formatDate`, a
 * month through `formatMonth` ("Juni 2026", never `2026-06`, K-38).
 *
 * ONE OVERFLOW PER ROW (K-21, D137). "Monat wieder öffnen" and "Periode entsperren" sit in the row's
 * one trailing overflow instead of a 440px column of stacked buttons and notes; an actor who may not
 * act sees the item disabled with the reason in its label. The deep-linked month is the row the
 * view is on (`isRowCurrent`, the selection pill), no longer an inset warn bar (K-24).
 *
 * ONE VISIBLE YEAR-CLOSE DOOR (D152 rule 3, owner's pick "Guided + overflow", 04.10.2026). The year
 * close used to have two doors side by side: a bare "Jahresabschluss durchführen" behind a year
 * picker (disabled until a year was picked) and a link to the guided close. The guided one is the
 * visible door: it opens the open `year_close` run when there is one, else the checklist list with
 * the year-close template preselected (`?start=year_close&year=`). The DIRECT seal survives behind
 * the header's overflow ("Direkt abschliessen …"): the same year picker (this year plus ten back),
 * the same confirm and the same `close_year` call with the same payload as before, and nothing in it
 * is disabled at rest because its confirm appears only once a year is chosen.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import { useClient } from '../../lib/client-context';
import { isErr, type Err, type Result } from '../../lib/client';
import { useWorkspaceId } from '../../app/workspace';
import { useCapabilities, CAP } from '../../lib/capabilities';
import { useT, formatDate, formatMoney } from '../../i18n';
import { useCalendarFormat } from '../../lib/format';
import { EmptyState, NoWorkspaceState, PermissionDenied } from '../../components/states';
import { DataTable, type DataTableColumn } from '../../components/DataTable';
import { OverflowMenu, type OverflowMenuItem } from '../../components/OverflowMenu';
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
import { lastEndedYears, parseRunList, todayIso, YEAR_CLOSE_TEMPLATE_ID } from '../Checklists/model';
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

/** How many ended years the guided start offers (`lastEndedYears(today, 3)` in `Checklists.tsx`). */
const GUIDED_YEARS = 3;

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
 * `ConfirmPeriodDialog` renders the engine's own consequence for it (D156, the one catalogue): the same string
 * the guided year close, the Review lock dialog and the Vorschlag card render. Nothing is authored here,
 * and there is no fallback to a sibling verb any more (the pre-F-08 `lock_period` fallback is gone).
 */
/** Newest period first: the month just closed lands at the top, not below the sealed years. */
function newestFirst(a: PeriodLock, b: PeriodLock): number {
  return a.period < b.period ? 1 : a.period > b.period ? -1 : 0;
}

/** One open `year_close` run: the fiscal year label it closes and its id. */
interface YearRun {
  year: string;
  runId: string;
}

/**
 * What this surface knows about the open `year_close` runs (D152, fail closed, critic R2-F1). The
 * direct seal is offered ONLY on `known` with no run for the picked year: while the read is in
 * flight (`loading`), or refused or unreadable (`unknown`, e.g. a role with manage_periods but no
 * read_books), the dialog says so and offers no confirm. The engine refuses `close_year` over an
 * open run too (`year_close_in_progress`); this is the face of that rule, not its only holder.
 */
type RunsState = { kind: 'loading' } | { kind: 'unknown' } | { kind: 'known'; runs: readonly YearRun[] };

/** The open year runs off a `checklist_list` answer, oldest year first; null for an unreadable answer. */
function yearRunsOf(body: unknown): YearRun[] | null {
  if (isErr(body as Result)) return null;
  const parsed = parseRunList(body);
  if (parsed === null) return null;
  return parsed
    .map((r) => ({ year: r.periodLabel, runId: r.runId }))
    .sort((a, b) => (a.year < b.year ? -1 : a.year > b.year ? 1 : 0));
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

/**
 * ONE WORKSPACE PER MOUNT (critic F2/F3 on cl-periods). Every piece of this surface's state belongs to
 * one workspace: the open year_close runs behind the door, the year result in the banner, the direct
 * seal's open dialog and picked year, the committed row, the accrual drawer. Keying the surface on the
 * workspace remounts it on a switch, so nothing of A survives into B, and a read or a write still in
 * flight for A lands on an unmounted instance, which the `live` guard below then drops.
 */
export function Periods(props: PeriodsProps = {}) {
  const workspaceId = useWorkspaceId();
  return <PeriodsSurface key={workspaceId ?? ''} {...props} />;
}

function PeriodsSurface(props: PeriodsProps) {
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
  /** The open `year_close` runs (see `RunsState`); the year-close door opens the oldest of them. */
  const [runs, setRuns] = useState<RunsState>({ kind: 'loading' });
  const yearRuns: readonly YearRun[] = runs.kind === 'known' ? runs.runs : [];
  /** The direct seal behind the header overflow: open, and the year picked in it ('' = none yet). */
  const [directOpen, setDirectOpen] = useState(false);
  const [yearInput, setYearInput] = useState('');
  // A month close is a period lock on the money path exactly as a year close is: it changes what
  // can be posted and it is awkward to undo. It gets the same confirm gate, not a bare submit.
  const [confirmMonth, setConfirmMonth] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [busy, setBusy] = useState(false);
  // The Commit moment (D122 D-I): the period a write just locked (or reopened) lands in the grid
  // once the list has refetched; the banner above carries the words and draws its check.
  const [committedPeriod, setCommittedPeriod] = useState<string | null>(null);
  useCommitAck(committedPeriod, state);

  // Stale-read guards. `live` is false once this instance unmounted (a workspace switch remounts the
  // surface), and `loadToken` names the newest load, so an older read that answers late never paints
  // over a newer one. Every await below checks both before it touches state.
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const loadToken = useRef(0);

  const load = useCallback(async () => {
    const token = ++loadToken.current;
    const current = () => live.current && token === loadToken.current;
    // The runs are re-read with the locks; until they answer they are `loading`, never a run an
    // earlier read reported and never "none".
    setRuns({ kind: 'loading' });
    if (workspaceId === null) {
      setState({ kind: 'ok', locks: [] });
      setRuns({ kind: 'known', runs: [] });
      return;
    }
    setState({ kind: 'loading' });
    // Both reads leave together and each lands on its own: a refused lock read must not leave the
    // runs `loading` forever, and a refused runs read must not hide the locks.
    const locksRead = client.call('list_period_locks', { workspaceId });
    // G22 leg 2 (D129, spec §10.12): the open year_close runs, so the one year-close door lands in
    // the run already under way rather than on the checklist list. Years close in order, so the
    // OLDEST open run is the one to finish first. A refused or unreadable answer is `unknown`.
    const runsRead = client.call('checklist_list', { workspaceId, templateId: YEAR_CLOSE_TEMPLATE_ID, status: 'open' });
    const { body } = await locksRead;
    if (!current()) return;
    if (isErr(body)) {
      setState({ kind: 'error', error: body });
    } else {
      // No cast and no `?? []`. `locks` is a REQUIRED field of the declared payload, so the fallback
      // was for a response the engine cannot send, and the engine's row type is assignable to this
      // surface's `PeriodLock` as it stands: `PeriodLock` is the wider of the two about `lockedAt` and
      // `lockedBy`, which is the safe direction.
      setState({ kind: 'ok', locks: [...body.locks].sort(newestFirst) });
    }
    const answered = await runsRead;
    if (!current()) return;
    const known = yearRunsOf(answered.body);
    setRuns(known === null ? { kind: 'unknown' } : { kind: 'known', runs: known });
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
        // Critic R6-1: the close read its own entries and balances back and refused to seal.
        case 'year_close_unverified':
          return t('period.err.yearUnverified');
        default:
          return t('period.err.generic');
      }
    },
    [t, cal],
  );

  /**
   * Run one write, then either surface a success feedback and refetch, or an error feedback. `onErr`
   * may take a refusal over (answer true) when the surface has a better place for it than the banner.
   */
  const runWrite = useCallback(
    async (
      action: string,
      input: Record<string, unknown>,
      onOk: (body: Extract<Result, { ok: true }>) => Feedback,
      onErr?: (body: Err) => boolean,
    ) => {
      if (workspaceId === null) return;
      setBusy(true);
      const { body } = await client.call(action, { workspaceId, ...input });
      // The workspace changed while the write was in flight: this instance is gone, and nothing it
      // learned (a banner, a refetch of the old workspace's locks) may reach the new one.
      if (!live.current) return;
      setBusy(false);
      if (isErr(body)) {
        if (onErr?.(body) === true) return;
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

  /**
   * The direct seal, failing closed (D152, critic R2-F1). At confirm time the open runs are READ
   * AGAIN: an unreadable answer turns the dialog to `unknown` and sends nothing, a run for the year
   * turns it to the hand-off and sends nothing. Only a fresh, readable "no run for this year" sends
   * `close_year`, with the 60429dd5 payload. Should the engine still answer `year_close_in_progress`
   * (a run started in between), the dialog stays open on the hand-off to the run it names.
   */
  const closeYear = useCallback(
    async (year: string) => {
      if (workspaceId === null) return;
      setBusy(true);
      const recheck = await client.call('checklist_list', { workspaceId, templateId: YEAR_CLOSE_TEMPLATE_ID, status: 'open' });
      if (!live.current) return;
      setBusy(false);
      const fresh = yearRunsOf(recheck.body);
      if (fresh === null) {
        setRuns({ kind: 'unknown' });
        return;
      }
      setRuns({ kind: 'known', runs: fresh });
      if (fresh.some((r) => r.year === year)) return;
      const closeDialog = () => {
        setDirectOpen(false);
        setYearInput('');
      };
      const onErr = (body: Err): boolean => {
        if (body.error === 'year_close_in_progress' && typeof body.yearRunId === 'string') {
          const named: YearRun = { year, runId: body.yearRunId };
          setRuns((r) => ({ kind: 'known', runs: [...(r.kind === 'known' ? r.runs.filter((x) => x.year !== year) : []), named] }));
          return true;
        }
        closeDialog();
        return false;
      };
      void runWrite('close_year', { year, idempotencyKey: newIdempotencyKey() }, (body) => {
        closeDialog();
        return {
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
        };
      }, onErr);
    },
    [client, workspaceId, runWrite, t],
  );

  const monthValid = MONTH_RE.test(monthInput);
  const yearValid = YEAR_RE.test(yearInput);
  /**
   * G22 §10.12 (critic F1 and R2-F1 on cl-periods): a year whose guided year_close run is OPEN is never
   * sealed from here. As at 60429dd5 the picked year's run replaces the seal with the hand-off to that
   * run, and the confirm appears only once the runs are KNOWN (`canSeal`); the engine refuses the
   * same call (`year_close_in_progress`) whatever this renders.
   */
  const yearRun = yearValid ? yearRuns.find((r) => r.year === yearInput) : undefined;
  const canSeal = yearValid && runs.kind === 'known' && yearRun === undefined;
  const noWorkspace = workspaceId === null;
  const monthLocked =
    state.kind === 'ok' && state.locks.some((l) => l.period === monthInput || l.period === monthInput.slice(0, 4));

  // A year that has not happened cannot be closed, so the list ends at the current one.
  const closableYears = useMemo(() => {
    const thisYear = new Date().getFullYear();
    return Array.from({ length: CLOSABLE_YEARS_BACK + 1 }, (_, i) => String(thisYear - i));
  }, []);

  /**
   * The year the guided start is handed when no run is open: the newest ENDED year the guided start
   * offers that is not sealed yet (a sealed year would only be refused `year_already_closed`). Null
   * when all of them are sealed or the locks are not read yet: the dialog then picks its own default.
   */
  const guidedYear = useMemo(() => {
    if (state.kind !== 'ok') return null;
    const sealed = new Set(state.locks.filter((l) => l.kind === 'hard' && l.reason === 'year_close').map((l) => l.period));
    return lastEndedYears(todayIso(), GUIDED_YEARS).map((y) => y.label).find((y) => !sealed.has(y)) ?? null;
  }, [state]);
  const guidedStart = `/checklisten?start=${YEAR_CLOSE_TEMPLATE_ID}${guidedYear === null ? '' : `&year=${guidedYear}`}`;

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
        // The direct seal, behind the header's overflow (owner, 04.10.2026): the guided close is the
        // visible door, and this is the way past it. Hidden, never shown-then-refused, for an actor
        // who may not manage periods (A24); the engine gates `close_year` whatever this renders.
        actions={
          canManage ? (
            <OverflowMenu
              label={t('period.moreActions')}
              items={[{ key: 'direct-close', label: t('period.directClose'), onSelect: () => setDirectOpen(true) }]}
            />
          ) : undefined
        }
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
          {/* The year close's result in ONE line: the figure in the unit the engine named, and the
              closing entry it posted. */}
          {(feedback.result !== undefined || feedback.entryId !== undefined) && (
            <p className="action-feedback__detail" data-testid="period-year-result">
              {feedback.result !== undefined && (
                <>
                  {t('period.yearResult')}:{' '}
                  <span className="t-money">{formatMoney(feedback.result.minor, feedback.result.currency)}</span>
                </>
              )}
              {feedback.result !== undefined && feedback.entryId !== undefined && ' · '}
              {feedback.entryId !== undefined && (
                <>
                  {t('period.carryTo2979')} ({t('period.viewCarryEntry')}: {feedback.entryId})
                </>
              )}
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

        {/* The one visible year-close door (D152 rule 3): the guided close, which ends in the seal. It
            lands in the open run when there is one (its year in the label), else on the checklist
            list with the year-close Start dialog open on the year to close. */}
        <Link
          className="btn btn--secondary period-year-close"
          to={yearRuns[0] !== undefined ? `/checklisten?run=${encodeURIComponent(yearRuns[0].runId)}` : guidedStart}
          data-testid="period-year-close"
        >
          {yearRuns[0] !== undefined ? t('period.yearCloseFor', { year: yearRuns[0].year }) : t('period.yearClose')}
        </Link>
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

      {/* The direct seal (header overflow). The picker comes first; the confirm, its message and the
          engine's consequence sentence appear only once a year is chosen, so nothing here sits
          disabled at rest. */}
      {directOpen && (
        <Modal
          open
          role={ALERT_DIALOG}
          title={canSeal ? t('period.confirmYearTitle', { year: yearInput }) : t('period.directClose')}
          onClose={() => {
            setDirectOpen(false);
            setYearInput('');
          }}
          closeLabel={t('period.closeDialog')}
          footer={
            <>
              <button
                type="button"
                className="btn btn--secondary btn--sm"
                onClick={() => {
                  setDirectOpen(false);
                  setYearInput('');
                }}
              >
                {t('period.cancel')}
              </button>
              {yearRun !== undefined ? (
                <Link className="btn btn--secondary" to={`/checklisten?run=${encodeURIComponent(yearRun.runId)}`} data-testid="period-open-year-close">
                  {t('period.openYearClose')}
                </Link>
              ) : yearValid && runs.kind === 'unknown' ? (
                <Link className="btn btn--secondary" to="/checklisten" data-testid="period-runs-unknown-link">
                  {t('period.runsUnknownLink')}
                </Link>
              ) : (
                canSeal && (
                  <button type="button" className="btn btn--danger" disabled={busy} onClick={() => void closeYear(yearInput)}>
                    {t('period.confirm')}
                  </button>
                )
              )}
            </>
          }
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
          {yearRun !== undefined ? (
            <p className="period-confirm-message">{t('period.yearCloseRunNote', { year: yearInput })}</p>
          ) : yearValid && runs.kind === 'loading' ? (
            <p className="period-confirm-message" role="status" data-testid="period-runs-checking">
              {t('period.runsChecking')}
            </p>
          ) : yearValid && runs.kind === 'unknown' ? (
            <p className="period-confirm-message" data-testid="period-runs-unknown">
              {t('period.runsUnknown')}
            </p>
          ) : (
            canSeal && (
              <>
                <p className="period-confirm-message">{t('period.confirmYear')}</p>
                <ConsequenceLine verb="close_year" />
              </>
            )
          )}
        </Modal>
      )}

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

    </section>
  );
}

/**
 * The confirm gate for a period-lock write (Tier-3 forgiveness), on the shared `Modal` primitive.
 *
 * The month close comes through here as an ALERT dialog (the direct year seal is the same kind of
 * alert dialog, with its year picker in front): a period lock is a consequential, awkward-to-undo
 * write on the money path, so a stray scrim click must not answer it, which is exactly the alertdialog
 * contract Modal enforces (no dismiss-on-scrim, focus trapped, Escape and the close control both cancel).
 * The consequence is the ENGINE'S sentence (D118 C4): the shared `ConsequenceLine` renders
 * engine's consequence (D156, the one catalogue) for the verb given, the identical string the Review surface's
 * lock dialog and the Vorschlag card show, so one consequence has one sentence across the Studio
 * (F-07, J4.1). The message above it carries only what the soft close adds (when it can be
 * reopened); it never restates the consequence in its own words.
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
