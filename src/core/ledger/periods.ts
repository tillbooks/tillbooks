/**
 * A03, period locks (§H-PERIOD). This spec CREATES and MANAGES the locks; A02 HONOURS them through the
 * `PeriodPort` seam.
 *
 * A soft close is a reversible guardrail (a freelancer stops accidentally editing settled books). A
 * hard lock is a legal seal: a filed MWST period (A07, `reason='vat_filed'`) or a closed fiscal year
 * (`reason='year_close'`) refuses casual reopening (`hard_lock_sealed`). `assertPeriodOpen` resolves a
 * date to its month and its fiscal year and blocks a post into either if locked.
 *
 * Every write here takes an `idempotency_key` (§H-IDEMPOTENT) and is gated by the `manage_periods`
 * capability (pre-RBAC: the permissive stub grants it; A24 formalises owner/Treuhänder only). Unlocking
 * a hard lock additionally needs `unlock_period`.
 */

import type { SqliteStore } from '../store/sqlite-store.js';
import type { WorkspaceContext } from '../context.js';
import type { PeriodPort } from '../ports.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';

/** `period_lock.kind`, single-sourced (§H-ENUM). A third kind would break assertPeriodOpen's semantics. */
export const PERIOD_LOCK_KINDS: ReadonlySet<string> = new Set(['soft', 'hard']);

/**
 * Hard locks carrying one of these reasons are legally final (a filed return, a closed year) and cannot
 * be casually reopened (`hard_lock_sealed`). Single-sourced so A07's filing flow and the year-close
 * agree with `unlockPeriod` on exactly what "sealed" means.
 */
export const SEALED_LOCK_REASONS: ReadonlySet<string> = new Set(['vat_filed', 'year_close']);

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const YEAR_RE = /^\d{4}$/;

export interface PeriodDeps {
  store: SqliteStore;
  workspaceId: string;
}

/**
 * The fiscal year a date belongs to, as a `YYYY` label = the calendar year in which the fiscal year
 * STARTS. With `fiscalYearStart='01-01'` this is just the calendar year; with `'04-01'`, 2027-02 falls
 * in fiscal year 2026 (Apr 2026 .. Mar 2027). `MM-DD` strings compare correctly lexicographically
 * because both are zero-padded.
 */
export function fiscalYearOf(date: string, fiscalYearStart: string): string {
  const year = Number(date.slice(0, 4));
  const monthDay = date.slice(5); // 'MM-DD'
  return String(monthDay >= fiscalYearStart ? year : year - 1);
}

function fiscalYearStartOf(deps: PeriodDeps): string {
  const row = deps.store.db
    .prepare('SELECT fiscal_year_start FROM workspace WHERE id = ?')
    .get(deps.workspaceId) as { fiscal_year_start: string } | undefined;
  return row?.fiscal_year_start ?? '01-01';
}

/**
 * The guard A02 calls before every post (except the year-close's own sealing entry, source='close').
 * A date is blocked if its month OR its fiscal year carries any lock. The more specific (month) lock is
 * reported when both match.
 */
export function assertPeriodOpen(deps: PeriodDeps, date: string): Result {
  const month = date.slice(0, 7); // 'YYYY-MM'
  const fiscalYear = fiscalYearOf(date, fiscalYearStartOf(deps));
  const locks = deps.store.db
    .prepare(
      'SELECT period, kind, reason FROM period_lock WHERE workspace_id = ? AND period IN (?, ?) ORDER BY period DESC',
    )
    .all(deps.workspaceId, month, fiscalYear) as { period: string; kind: string; reason: string | null }[];
  // A year_close HARD seal is the strongest legal seal and must be reported whenever it applies, even
  // when the month carries its OWN lock. It cannot be found by "highest period wins": SQLite BINARY
  // collation makes the year label 'YYYY' sort BELOW the month label 'YYYY-MM' (the year is a prefix of
  // the month), so `ORDER BY period DESC LIMIT 1` returned the MONTH row and hid the seal. postEntry's
  // close-relaxation reads `reason`, so a masked seal let a source='close' entry post INTO an
  // already year-close-sealed year, the one thing that guard's comment swears it never does. Surface the
  // seal explicitly; otherwise report the most specific (highest period, ORDER BY DESC) lock, as before.
  const lock = locks.find((l) => l.kind === 'hard' && l.reason === 'year_close') ?? locks[0];
  if (lock === undefined) return ok();
  // `reason` lets a caller distinguish a year-close seal from a soft/filing lock: the source='close'
  // sealing entry (postEntry) may post over the latter but never into an already year-close-sealed year.
  return err('period_locked', { period: lock.period, kind: lock.kind, reason: lock.reason });
}

/** The real `PeriodPort` (A03). `allPeriodsOpen` (ports.ts) is the Phase-1 stub this replaces. */
export function makePeriodPort(deps: PeriodDeps): PeriodPort {
  return { assertOpen: (date: string) => assertPeriodOpen(deps, date) };
}

interface LockRow {
  period: string;
  kind: string;
  locked_at: string;
  locked_by: string | null;
  reason: string | null;
}

function existingLock(deps: PeriodDeps, period: string): LockRow | undefined {
  return deps.store.db
    .prepare('SELECT period, kind, locked_at, locked_by, reason FROM period_lock WHERE workspace_id = ? AND period = ?')
    .get(deps.workspaceId, period) as LockRow | undefined;
}

function writeLock(ctx: WorkspaceContext, period: string, kind: string, reason: string | null): void {
  ctx.store.db
    .prepare(
      `INSERT INTO period_lock (workspace_id, period, kind, locked_at, locked_by, reason)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(ctx.workspaceId, period, kind, ctx.clock.now(), ctx.actor, reason);
  ctx.audit.record({ entityKind: 'period_lock', entityId: period, action: 'lock', actor: ctx.actor, at: ctx.clock.now() });
}

function clearLock(ctx: WorkspaceContext, period: string): void {
  ctx.store.db.prepare('DELETE FROM period_lock WHERE workspace_id = ? AND period = ?').run(ctx.workspaceId, period);
  ctx.audit.record({ entityKind: 'period_lock', entityId: period, action: 'unlock', actor: ctx.actor, at: ctx.clock.now() });
}

/** Strengthen an existing lock (soft -> hard) in place, e.g. a filing/year seal over a soft-closed month. */
function upgradeLock(ctx: WorkspaceContext, period: string, kind: string, reason: string | null): void {
  ctx.store.db
    .prepare('UPDATE period_lock SET kind = ?, reason = ?, locked_at = ?, locked_by = ? WHERE workspace_id = ? AND period = ?')
    .run(kind, reason, ctx.clock.now(), ctx.actor, ctx.workspaceId, period);
  ctx.audit.record({ entityKind: 'period_lock', entityId: period, action: 'lock', actor: ctx.actor, at: ctx.clock.now() });
}

/** Soft-close a month (`YYYY-MM`). Idempotent: an already-locked month is a no-op success. */
export function softCloseMonth(ctx: WorkspaceContext, input: { period: string; idempotencyKey: string }): Result {
  const capable = ctx.capabilities.assert('manage_periods');
  if (!capable.ok) return capable;
  if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length === 0) {
    return err('invalid_input', { field: 'idempotencyKey' });
  }
  if (!MONTH_RE.test(input.period)) return err('invalid_period', { period: input.period, expected: 'YYYY-MM' });

  return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'close_month', () => {
    if (existingLock(ctx, input.period) === undefined) writeLock(ctx, input.period, 'soft', null);
    return ok({ period: input.period, kind: 'soft' });
  });
}

/** Reopen a soft-closed month. A hard-sealed month refuses (`hard_lock_sealed`). */
export function reopenMonth(ctx: WorkspaceContext, input: { period: string; idempotencyKey: string }): Result {
  const capable = ctx.capabilities.assert('manage_periods');
  if (!capable.ok) return capable;
  if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length === 0) {
    return err('invalid_input', { field: 'idempotencyKey' });
  }
  if (!MONTH_RE.test(input.period)) return err('invalid_period', { period: input.period, expected: 'YYYY-MM' });

  // Replay a completed reopen before the state-dependent seal guard (§H-IDEMPOTENT), so retrying an
  // already-succeeded reopen returns its result even if the month was hard-sealed in the meantime.
  const replayed = ctx.store.recallIdempotent<Result>(ctx.workspaceId, input.idempotencyKey, 'reopen_month');
  if (replayed !== undefined) return replayed;

  const lock = existingLock(ctx, input.period);
  if (lock !== undefined && lock.kind === 'hard') return err('hard_lock_sealed', { period: input.period });

  return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'reopen_month', () => {
    if (existingLock(ctx, input.period) !== undefined) clearLock(ctx, input.period);
    return ok({ period: input.period });
  });
}

/**
 * Lock a period (`YYYY-MM` or `YYYY`), hard or soft. Used by A07 filing. A hard lock over an existing
 * soft lock UPGRADES it (a filed/year seal must actually seal a month the user had soft-closed); a
 * same-or-weaker request over an existing lock is a no-op. Either way the result reports the ACTUAL
 * resulting state (never a claimed `kind` the row does not hold).
 */
export function lockPeriod(
  ctx: WorkspaceContext,
  input: { period: string; kind: string; reason?: string; idempotencyKey: string },
): Result {
  const capable = ctx.capabilities.assert('manage_periods');
  if (!capable.ok) return capable;
  if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length === 0) {
    return err('invalid_input', { field: 'idempotencyKey' });
  }
  if (!MONTH_RE.test(input.period) && !YEAR_RE.test(input.period)) {
    return err('invalid_period', { period: input.period, expected: 'YYYY-MM or YYYY' });
  }
  if (!PERIOD_LOCK_KINDS.has(input.kind)) return err('invalid_kind', { kind: input.kind });

  return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'lock_period', () => {
    const existing = existingLock(ctx, input.period);
    if (existing === undefined) {
      writeLock(ctx, input.period, input.kind, input.reason ?? null);
      return ok({ period: input.period, kind: input.kind, reason: input.reason ?? null });
    }
    if (existing.kind === 'soft' && input.kind === 'hard') {
      upgradeLock(ctx, input.period, 'hard', input.reason ?? null);
      return ok({ period: input.period, kind: 'hard', reason: input.reason ?? null, upgraded: true });
    }
    // Same-or-weaker request over an existing lock: no-op, but report the real current state so a
    // caller can never be told a seal was applied when it was not.
    return ok({ period: input.period, kind: existing.kind, reason: existing.reason });
  });
}

/**
 * Unlock a period. A soft lock clears freely; an unsealed manual hard lock needs the `unlock_period`
 * capability; a filing/year seal refuses (`hard_lock_sealed`). Unlocking a period with no lock is a
 * no-op success.
 */
export function unlockPeriod(ctx: WorkspaceContext, input: { period: string; idempotencyKey: string }): Result {
  const capable = ctx.capabilities.assert('manage_periods');
  if (!capable.ok) return capable;
  if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length === 0) {
    return err('invalid_input', { field: 'idempotencyKey' });
  }

  // Replay a completed unlock before the state-dependent seal/capability guards (§H-IDEMPOTENT): after a
  // successful unlock the lock is gone, so a retry must replay the stored result, not re-evaluate guards.
  const replayed = ctx.store.recallIdempotent<Result>(ctx.workspaceId, input.idempotencyKey, 'unlock_period');
  if (replayed !== undefined) return replayed;

  const lock = existingLock(ctx, input.period);
  if (lock === undefined) {
    return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'unlock_period', () =>
      ok({ period: input.period }),
    );
  }
  if (lock.kind === 'hard') {
    if (lock.reason !== null && SEALED_LOCK_REASONS.has(lock.reason)) {
      return err('hard_lock_sealed', { period: input.period, reason: lock.reason });
    }
    const canUnlock = ctx.capabilities.assert('unlock_period');
    if (!canUnlock.ok) return canUnlock;
  }

  return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'unlock_period', () => {
    clearLock(ctx, input.period);
    return ok({ period: input.period });
  });
}

/** One row of the period-lock read model, as `list_period_locks` sends it. */
export type PeriodLockRow = {
  readonly period: string;
  readonly kind: string;
  readonly lockedAt: string;
  // NULLABLE, because the column is. A lock written by a system path (the year-close, a VAT filing)
  // can carry no actor, and a declaration that promised a `string` here would be the declared-payload
  // mechanism telling the Studio a lie with a straight face.
  readonly lockedBy: string | null;
  readonly reason: string | null;
};

/**
 * What `list_period_locks` sends back: the locks, and NOTHING else.
 *
 * Named and declared because two fields the Studio read off this response have never existed.
 * `Periods.tsx` gated its soft-close control on `body.canManage !== false` and its hard-lock UNLOCK
 * control on `body.canUnlock !== false`, and `grep -rn canManage src/` finds nothing at all: this
 * verb answers `ok({ locks })` and always has. An absent field made both expressions
 * `undefined !== false`, so both gates stood open in every build that ever shipped. The engine's only
 * `canUnlock` is a local `const` inside `unlockPeriod`, three functions up, which is how a name can
 * look answered while nothing answers it.
 *
 * Declaring the payload is what turns that read into TS2339 at the Studio call site. It is the same
 * closure that caught `canPost` on `list_journal` an hour earlier, and the same defect family: "the
 * Studio assumed a shape the engine never sends".
 */
export type ListPeriodLocksOk = {
  readonly locks: readonly PeriodLockRow[];
};

/** All locks for the workspace (read model, P5). */
export function listPeriodLocks(ctx: WorkspaceContext): Result<ListPeriodLocksOk> {
  const rows = ctx.store.db
    .prepare('SELECT period, kind, locked_at, locked_by, reason FROM period_lock WHERE workspace_id = ? ORDER BY period')
    .all(ctx.workspaceId) as LockRow[];
  // The type argument is the pin: with it, this literal is judged against `ListPeriodLocksOk`, so a
  // renamed or dropped field is an error HERE rather than an `undefined` in the grid.
  return ok<ListPeriodLocksOk>({
    locks: rows.map((r) => ({
      period: r.period,
      kind: r.kind,
      lockedAt: r.locked_at,
      lockedBy: r.locked_by,
      reason: r.reason,
    })),
  });
}
