/**
 * A15's dunning policy: three levels, each a business convention and not a statutory figure.
 *
 * WHAT THE LAW ACTUALLY FIXES, verified against current sources on 30.07.2026, because every one of
 * these was worth checking rather than assuming:
 *
 *  - Verzugszins: Art. 104 Abs. 1 OR sets 5% p.a. as the DEFAULT, and Abs. 2 lets a contract agree
 *    a HIGHER rate. So `interest_bp` has a floor of 500 and no ceiling here (usury is a court's
 *    question, not a bookkeeping validation), and the figure is display-only: A15 never posts it.
 *  - Mahngebühr: NO statutory basis at all. It is chargeable only when contractually agreed and
 *    reasonable (CHF 20 to 30 per reminder is the commonly defended range), which is why the
 *    default is zero and note-only, and why the whole surface is configuration rather than seed.
 *  - VAT on a booked fee: ESTV practice treats the Mahngebühr as part of the Entgelt of the
 *    UNDERLYING supply (taxable at that supply's rate, exempt when it is exempt), while
 *    Verzugszins is echter Schadenersatz (Art. 18 Abs. 2 lit. i MWSTG) and outside VAT entirely.
 *    Since D69 (owner-decided 31.07.2026) the ENGINE applies that rule itself: the fee's VAT splits
 *    pro rata across the chased invoice's own rate bases through A05's one code path, so there is
 *    NO per-level tax code to configure any more. The first build accepted one, which let a mixed
 *    8.1%/3.8% invoice tax its whole fee at 8.1% and an exempt supply's fee book VAT that was not
 *    owed; `validateLevel` now refuses the field by name so a stale caller learns why.
 *
 * The three rows are replaced in place under an idempotency key held by the STORE's side table,
 * exactly like `aging_bucket_config` and for the same reason: the row remembers only the most
 * recent key, so an out-of-order retry must replay from the side table or it would roll a newer
 * edit back.
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { requireString } from '../ledger/inputGuards.js';

/** Art. 104 Abs. 1 OR: the default interest floor, in basis points. */
export const INTEREST_FLOOR_BP = 500;

/**
 * The default minimum spacing between two escalation letters, in days (K-60). Ten days matches the
 * shipped 10/20/30 threshold rhythm below: a common Swiss office cadence, not a statutory deadline.
 * It is the read-time default too, so a `dunning_config` row written before this column existed, and
 * every level a workspace never explicitly configured, is spaced by 10 days rather than 0.
 */
export const DEFAULT_MIN_INTERVAL_DAYS = 10;

/** The dunning levels (§H-ENUM). Level 3 is terminal: after it comes Betreibung, out of scope. */
export const DUNNING_LEVELS = [1, 2, 3] as const;

/** The run lifecycle (§H-ENUM): its own three-state machine, not a fork of A10's document graph. */
export const DUNNING_RUN_STATUSES = ['proposed', 'issued', 'sent'] as const;
export type DunningRunStatus = (typeof DUNNING_RUN_STATUSES)[number];

export interface DunningLevelConfig {
  level: 1 | 2 | 3;
  /** An item is proposed for this level once it is at least this many days overdue. */
  daysOverdue: number;
  /**
   * The minimum days that must pass AFTER the previous level's letter was issued before this level
   * may be reached (K-60). It is the SPACING gate that the absolute `daysOverdue` threshold alone
   * never provided: an invoice already past every threshold satisfied 1, 2 and 3 at once, so three
   * daily runs booked three fees in three days. Level 1 has no previous issued level and is gated by
   * `daysOverdue` alone; this field governs the step INTO levels 2 and 3. 0 disables the spacing for
   * a level (back-to-back letters), a deliberate opt-out; the default is `DEFAULT_MIN_INTERVAL_DAYS`.
   */
  minIntervalDays: number;
  /**
   * The Mahngebühr in Rappen; 0 means no fee at this level. A POSITIVE fee requires `bookFee`
   * (critic C6): the letter demands exactly what books, so a demanded-but-unbooked fee is not a
   * configuration this engine accepts.
   */
  feeMinor: number;
  /** Book the fee to the ledger at issue. Required true whenever feeMinor > 0. */
  bookFee: boolean;
  /** The fee-income account (by id) a booked fee credits. Required when bookFee is set. */
  feeIncomeAccountId: string | null;
  /** Show the Verzugszins note on the letter. */
  showInterest: boolean;
  /** The interest rate in basis points; >= 500 (Art. 104 OR floor). Display-only, never booked. */
  interestBp: number;
  /** The letter template key (G05's eventual scope; 'standard' is today's fixed layout). */
  templateKey: string;
}

/**
 * The shipped defaults: 1. Mahnung at 10 days overdue, then 20, then 30. A common Swiss office
 * rhythm and explicitly NOT a legal deadline (Verzug is Art. 102 OR's question); no fee, no
 * interest note, until the workspace decides otherwise.
 */
export const DEFAULT_DUNNING_LEVELS: readonly DunningLevelConfig[] = DUNNING_LEVELS.map((level) => ({
  level,
  daysOverdue: level * 10,
  minIntervalDays: DEFAULT_MIN_INTERVAL_DAYS,
  feeMinor: 0,
  bookFee: false,
  feeIncomeAccountId: null,
  showInterest: false,
  interestBp: INTEREST_FLOOR_BP,
  templateKey: 'standard',
}));

interface ConfigRow {
  level: number;
  days_overdue: number;
  min_interval_days: number;
  fee_minor: number;
  book_fee: number;
  fee_income_account_id: string | null;
  tax_code: string | null;
  show_interest: number;
  interest_bp: number;
  template_key: string;
}

function rowToLevel(row: ConfigRow): DunningLevelConfig {
  return {
    level: row.level as 1 | 2 | 3,
    daysOverdue: row.days_overdue,
    // A row from before this column existed reads NULL here (ALTER TABLE ADD COLUMN backfilled the
    // DEFAULT for every existing row, but a hand-crafted or partial row could still be null): the
    // read-time default keeps the spacing at 10 rather than 0, so an old config never silently loses
    // the gate.
    minIntervalDays: row.min_interval_days ?? DEFAULT_MIN_INTERVAL_DAYS,
    feeMinor: row.fee_minor,
    bookFee: row.book_fee === 1,
    feeIncomeAccountId: row.fee_income_account_id,
    showInterest: row.show_interest === 1,
    interestBp: row.interest_bp,
    templateKey: row.template_key,
  };
}

/** The workspace's levels, or the shipped defaults when it has never configured any. */
export function dunningLevelsOf(ctx: WorkspaceContext): DunningLevelConfig[] {
  const rows = ctx.store.db
    .prepare('SELECT * FROM dunning_config WHERE workspace_id = ? ORDER BY level')
    .all(ctx.workspaceId) as ConfigRow[];
  if (rows.length === 0) return [...DEFAULT_DUNNING_LEVELS];
  // A partial configuration (a hand-edited file, a future shape) falls back per level rather than
  // wholesale: the level that exists is the one the workspace chose.
  return DUNNING_LEVELS.map((level) => {
    const row = rows.find((r) => r.level === level);
    return row === undefined ? { ...DEFAULT_DUNNING_LEVELS[level - 1]! } : rowToLevel(row);
  });
}

export function getDunningConfig(ctx: WorkspaceContext): Result {
  const configured =
    (ctx.store.db
      .prepare('SELECT COUNT(*) AS n FROM dunning_config WHERE workspace_id = ?')
      .get(ctx.workspaceId) as { n: number }).n > 0;
  return ok({
    levels: dunningLevelsOf(ctx),
    configured,
    interestFloorBp: INTEREST_FLOOR_BP,
  });
}

export interface SetDunningConfigInput {
  levels?: unknown;
  idempotencyKey?: string;
}

interface LevelInput {
  level?: unknown;
  daysOverdue?: unknown;
  minIntervalDays?: unknown;
  feeMinor?: unknown;
  bookFee?: unknown;
  feeIncomeAccountId?: unknown;
  taxCode?: unknown;
  showInterest?: unknown;
  interestBp?: unknown;
  templateKey?: unknown;
}

/** Validate one level entry, or the reason it is invalid. Returns the normalised config. */
function validateLevel(ctx: WorkspaceContext, raw: LevelInput): DunningLevelConfig | Result {
  const level = raw.level;
  if (level !== 1 && level !== 2 && level !== 3) {
    return err('invalid_input', { field: 'level', allowed: [...DUNNING_LEVELS] });
  }
  const days = raw.daysOverdue;
  if (!Number.isSafeInteger(days) || (days as number) < 1) {
    return err('invalid_input', { field: 'daysOverdue', expected: 'a positive whole day count' });
  }
  // K-60: the per-level minimum spacing. Absent means the default (10); 0 is a deliberate opt-out
  // (back-to-back letters), so the floor is 0, not 1. A negative or fractional value is a mistake.
  const minIntervalDays = raw.minIntervalDays ?? DEFAULT_MIN_INTERVAL_DAYS;
  if (!Number.isSafeInteger(minIntervalDays) || (minIntervalDays as number) < 0) {
    return err('invalid_input', { field: 'minIntervalDays', expected: 'a non-negative whole day count' });
  }
  const fee = raw.feeMinor ?? 0;
  if (!Number.isSafeInteger(fee) || (fee as number) < 0) {
    return err('invalid_input', { field: 'feeMinor', expected: 'a non-negative Rappen count' });
  }
  const interestBp = raw.interestBp ?? INTEREST_FLOOR_BP;
  if (!Number.isSafeInteger(interestBp) || (interestBp as number) < INTEREST_FLOOR_BP) {
    // Art. 104 Abs. 1 OR: 5% is the statutory default; only a HIGHER contractual rate is legal.
    return err('interest_below_statutory_floor', { field: 'interestBp', floorBp: INTEREST_FLOOR_BP });
  }
  // D69: the fee's VAT follows the CHASED INVOICE's own rate bases, resolved by the engine at
  // issue. A per-level code would let a mixed or exempt supply's fee book the wrong VAT, so the
  // field is refused by name rather than silently ignored: a caller who sends one is working from
  // the pre-D69 contract and must learn that, not have their input quietly dropped.
  if (raw.taxCode !== undefined && raw.taxCode !== null) {
    return err('invalid_input', {
      field: 'taxCode',
      reason: 'd69_fee_vat_follows_the_invoice',
    });
  }
  const bookFee = raw.bookFee === true;
  // Critic C6, the contract in one sentence: THE LETTER DEMANDS EXACTLY WHAT BOOKS. A positive fee
  // that does not book would either be demanded by the QR part with no receivable behind it (the
  // customer overpays into an unexplained Guthaben) or shown-but-not-demanded (a letter that
  // states a figure it does not mean). Neither is a configuration this engine accepts.
  if ((fee as number) > 0 && !bookFee) {
    return err('invalid_input', {
      field: 'bookFee',
      reason: 'a_demanded_fee_must_book',
    });
  }
  const accountId = typeof raw.feeIncomeAccountId === 'string' && raw.feeIncomeAccountId.length > 0
    ? raw.feeIncomeAccountId
    : null;
  if (bookFee) {
    if ((fee as number) <= 0) {
      return err('invalid_input', { field: 'bookFee', reason: 'a booked fee needs a positive feeMinor' });
    }
    if (accountId === null) {
      return err('needs_fee_income_account', { level });
    }
    const account = ctx.store.db
      .prepare('SELECT type FROM account WHERE workspace_id = ? AND id = ?')
      .get(ctx.workspaceId, accountId) as { type: string } | undefined;
    if (account === undefined) return err('account_not_found', { accountId });
    if (account.type !== 'income') {
      // The fee is income for the creditor (A01's §H-ENUM spells the type 'income'); crediting an
      // asset or expense account would misstate the Erfolgsrechnung on every run.
      return err('invalid_input', { field: 'feeIncomeAccountId', expected: 'an income account' });
    }
  }
  return {
    level,
    daysOverdue: days as number,
    minIntervalDays: minIntervalDays as number,
    feeMinor: fee as number,
    bookFee,
    feeIncomeAccountId: accountId,
    showInterest: raw.showInterest === true,
    interestBp: interestBp as number,
    templateKey: typeof raw.templateKey === 'string' && raw.templateKey.length > 0 ? raw.templateKey : 'standard',
  };
}

/**
 * Replace the dunning policy: all three levels in one write, so the thresholds can be validated
 * AGAINST EACH OTHER (a level-2 threshold below level-1's would make level 2 unreachable and read
 * as "dunning is broken" rather than as the configuration mistake it is).
 */
export function setDunningConfig(ctx: WorkspaceContext, input: SetDunningConfigInput): Result {
  const guard = requireString(input.idempotencyKey, 'idempotencyKey');
  if (guard) return guard;
  const key = input.idempotencyKey as string;

  const replayed = ctx.store.recallIdempotent<Result>(ctx.workspaceId, key, 'set_dunning_config');
  if (replayed !== undefined) return replayed;

  if (!Array.isArray(input.levels) || input.levels.length !== DUNNING_LEVELS.length) {
    return err('invalid_input', { field: 'levels', expected: 'all three levels in one write' });
  }
  const parsed: DunningLevelConfig[] = [];
  for (const raw of input.levels as LevelInput[]) {
    const outcome = validateLevel(ctx, raw);
    if ('ok' in outcome) return outcome;
    parsed.push(outcome);
  }
  const byLevel = new Map(parsed.map((l) => [l.level, l]));
  if (byLevel.size !== DUNNING_LEVELS.length) {
    return err('invalid_input', { field: 'levels', expected: 'exactly one entry per level 1, 2, 3' });
  }
  const l1 = byLevel.get(1)!;
  const l2 = byLevel.get(2)!;
  const l3 = byLevel.get(3)!;
  if (!(l1.daysOverdue < l2.daysOverdue && l2.daysOverdue < l3.daysOverdue)) {
    return err('invalid_input', { field: 'daysOverdue', expected: 'strictly increasing across levels' });
  }

  return ctx.store.rememberIdempotent(ctx.workspaceId, key, 'set_dunning_config', () => {
    const now = ctx.clock.now();
    // `tax_code` is written as NULL always: the column survives for old rows, the CONTRACT is D69's
    // (the fee's VAT follows the invoice) and nothing reads it any more.
    const upsert = ctx.store.db.prepare(
      `INSERT INTO dunning_config
         (workspace_id, level, days_overdue, min_interval_days, fee_minor, book_fee,
          fee_income_account_id, tax_code, show_interest, interest_bp, template_key, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)
       ON CONFLICT(workspace_id, level) DO UPDATE SET
         days_overdue          = excluded.days_overdue,
         min_interval_days     = excluded.min_interval_days,
         fee_minor             = excluded.fee_minor,
         book_fee              = excluded.book_fee,
         fee_income_account_id = excluded.fee_income_account_id,
         tax_code              = NULL,
         show_interest         = excluded.show_interest,
         interest_bp           = excluded.interest_bp,
         template_key          = excluded.template_key,
         updated_at            = excluded.updated_at`,
    );
    for (const l of parsed) {
      upsert.run(
        ctx.workspaceId,
        l.level,
        l.daysOverdue,
        l.minIntervalDays,
        l.feeMinor,
        l.bookFee ? 1 : 0,
        l.feeIncomeAccountId,
        l.showInterest ? 1 : 0,
        l.interestBp,
        l.templateKey,
        now,
      );
    }
    return ok({ levels: dunningLevelsOf(ctx) });
  });
}
