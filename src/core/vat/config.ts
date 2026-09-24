/**
 * A05 VAT configuration: method (Effektiv/Saldo), timing (Ist/Soll), registration, VAT number, and
 * the ESTV Bewilligung, which since F11 is an approval HISTORY rather than a current-state row.
 *
 * The VAT number is stored in the existing `workspace.mwst_no` column (reused, not a redundant new
 * `vat_number`), shape-validated as `CHE-###.###.### MWST`. A05 stores config only; it computes no
 * amounts and never posts.
 *
 * ## What changed, and why the shape is different from what it replaces
 *
 * `configureVat` used to DELETE every Saldosteuersatz and rewrite the set on every call, and the
 * table it wrote was documented as current config with an explicit note that A07 must not read it as
 * history. Multi-rate Saldo makes that untenable: MWSTV Art. 84 Abs. 3 obliges the filer to book
 * turnover separately per approved rate, and under Saldo no rate is ever stamped on a journal line,
 * so the approval history is the ONLY evidence of what a filed period was computed with.
 *
 * The two branches are now the caller's to choose, and they are the two things that actually happen
 * to a Bewilligung:
 *
 *   - `saldoCorrection: true` rewrites the OPEN approval in place. What the ESTV granted did not
 *     change; what TILL recorded about it was wrong.
 *   - `saldoGrant: { validFrom }` appends a NEW approval and closes the predecessor the day before.
 *     This is MWSTV Art. 84 Abs. 2, the Neuzuteilung: a Tätigkeit was taken up or given up, or the
 *     Umsatzanteile moved far enough that the ESTV reassigned the rates.
 *
 * NEITHER IS GUESSED. A save that would materially change an approval already governing posted
 * turnover, with no branch stated, is refused with `saldo_generation_change_unstated`. Guessing
 * "correction" silently moves a figure the books already hold; guessing "new grant" silently leaves
 * a period filed at a rate the operator believes they replaced. There is no safe default, so there
 * is no default. A workspace with no books yet has no history to protect and is written in place
 * without a branch, which is what keeps ordinary setup a single call.
 *
 * ## The account mapping IS the Art. 84 Abs. 3 separation
 *
 * Turnover is attributed to a Tätigkeit by ERTRAGSKONTO, never by a code stamped on an immutable
 * line. Several Tätigkeiten may share one Saldosteuersatz (MWSTV Art. 86 Abs. 3 and Abs. 4 both say
 * so in as many words), so a Tätigkeit is a row of its own pointing at a rate POSITION, and the
 * position is resolved from the stated rate ONCE, at write time, against a table whose schema
 * forbids the same rate appearing twice in one approval.
 *
 * ## Carrying a mapping into a new approval follows the TÄTIGKEIT
 *
 * A caller that appends a new Bewilligung and omits `saldoActivities` keeps the previous approval's
 * Tätigkeiten, matched by `activityId`, re-pointed at the rate each one now carries. Not by ordinal,
 * which was the previous design's defect (a reorder moved an account to the wrong rate and filed a
 * different payable), and not by rate either: a Tätigkeit whose rate the ESTV changed is still the
 * same Tätigkeit, and its accounts still belong to it.
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { VAT_METHODS, VAT_TIMINGS } from './enums.js';
import { electedFxMethod, taxPeriodOf } from '../fx/method.js';
import { CURRENT_RATE_ERA_FROM, isValidRateDate, vatRatesOn } from './rateEras.js';
import { seedTaxCodes } from './taxCodes.js';
import {
  OPEN_FROM_THE_START,
  closeGenerationsBefore,
  electedDeclarationBasis,
  latestGenerationFrom,
  listDeclarationElections,
  listGenerations,
  openGeneration,
  previousDay,
  recordMethodChange,
  writeDeclarationElection,
  writeGeneration,
  type SaldoActivityRow,
  type SaldoDeclarationBasis,
} from './saldoGenerations.js';

/** MWSTV Art. 87's cap, and the day it stopped binding (AS 2024 485, in force 01.01.2025). */
const SALDO_RATE_CAP_BEFORE_2025 = 2;
const SALDO_RATE_CAP_LIFTED_FROM = '2025-01-01';

const VAT_NUMBER_RE = /^CHE-\d{3}\.\d{3}\.\d{3} MWST$/;
const ISO_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const TAX_PERIOD_RE = /^\d{4}$/;
/** The ESTV Tätigkeitscode is exactly five characters (eCH-0217 `activityIDTurnoverTaxRateType`). */
const ACTIVITY_CODE_RE = /^.{5}$/;

export interface SaldoRateInput {
  rateBp: number;
}

export interface SaldoActivityInput {
  /** The operator's stable handle for this Tätigkeit. Carries its accounts across a later approval. */
  activityId: string;
  name: string;
  /** The Saldosteuersatz the ESTV approved for it, in basis points. Must be one of `saldoRates`. */
  rateBp: number;
  /** The ESTV's five-character Tätigkeitscode, required by eCH-0217 from 01.01.2025. */
  activityCode?: string | null;
  /** The Ertragskonten whose turnover is this Tätigkeit's, by account NUMBER. */
  accounts?: string[];
}

export interface ConfigureVatInput {
  method: string;
  timing: string;
  registered: boolean;
  vatNumber?: string;
  saldoRates?: SaldoRateInput[];
  saldoActivities?: SaldoActivityInput[];
  /** Append a NEW approval from this day, closing the predecessor the day before (Art. 84 Abs. 2). */
  saldoGrant?: { validFrom: string };
  /** Rewrite the OPEN approval in place: what TILL recorded was wrong, not what the ESTV granted. */
  saldoCorrection?: boolean;
  /** Record a dated method change (MWSTG Art. 37 Abs. 4), preserving the method that governed before. */
  methodChange?: { validFrom: string };
  /**
   * The date of the PERIOD the rates are being configured for (`YYYY-MM-DD`, or a full ISO
   * timestamp). Selects the statutory era the Saldosteuersatz ladder and the Normalsatz ceiling are
   * taken from, so configuring a correction return for 2023 validates against the 2023 ladder rather
   * than today's. Omitted means the CURRENT era, which is the pre-existing behaviour.
   */
  asOf?: string;
  idempotencyKey: string;
}

function validate(input: ConfigureVatInput): Result | null {
  if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length === 0) {
    return err('invalid_input', { field: 'idempotencyKey' });
  }
  if (!VAT_METHODS.has(input.method)) return err('invalid_vat_method', { method: input.method });
  if (!VAT_TIMINGS.has(input.timing)) return err('invalid_vat_accounting', { timing: input.timing });
  if (input.vatNumber !== undefined && input.vatNumber !== null && !VAT_NUMBER_RE.test(input.vatNumber)) {
    return err('invalid_vat_number', { vatNumber: input.vatNumber, expected: 'CHE-###.###.### MWST' });
  }
  for (const [field, value] of [
    ['saldoGrant.validFrom', input.saldoGrant?.validFrom],
    ['methodChange.validFrom', input.methodChange?.validFrom],
  ] as const) {
    if (value !== undefined && (!ISO_DAY_RE.test(value) || !isValidRateDate(value))) {
      return err('invalid_input', { field, value, expected: 'YYYY-MM-DD' });
    }
  }
  if (input.saldoGrant !== undefined && input.saldoCorrection === true) {
    return err('invalid_input', {
      field: 'saldoCorrection',
      reason: 'a save is either a correction of the open approval or a new one, never both',
    });
  }

  const rates = input.saldoRates ?? [];
  // Saldo rates belong only to the saldo method: reject them under effektiv/none rather than persisting
  // an incoherent config (method=effektiv with saldo rates) every downstream reader must defend against.
  if (rates.length > 0 && input.method !== 'saldo') {
    return err('invalid_saldo_rate', { reason: 'saldo rates require method=saldo', method: input.method });
  }
  // The rates are judged against the era in force FOR THE PERIOD, not against today's. `asOf`
  // defaults to the current era, preserving the behaviour of every caller that does not pass one.
  const asOf = input.asOf ?? CURRENT_RATE_ERA_FROM;
  if (!isValidRateDate(asOf)) {
    return err('invalid_input', { field: 'asOf', asOf: input.asOf, expected: 'YYYY-MM-DD' });
  }
  // `null` means the date precedes the earliest published era. Old rates must stay DECLARABLE
  // INDEFINITELY for correction returns, so an unknown era means the statutory checks CANNOT be
  // enforced and are therefore skipped: it never means "reject".
  const era = vatRatesOn(asOf);

  // N-rate model (MWSTV Art. 86 Abs. 1, in force 1.1.2025 per AS 2024 485): a rate is granted for
  // every business activity above 10% of taxable turnover, and the old "at most two" cap went with the
  // repeal of MWSTV Art. 87. Each rate must be an integer on the ESTV ladder published for the
  // period, and the same rate cannot be listed twice.
  //
  // THE CAP FELL ON A DATE, so it is scoped to one. MWSTV Art. 87 read "Die ESTV bewilligt höchstens
  // zwei Saldosteuersätze" and is "Aufgehoben durch Ziff. I der V vom 21. Aug. 2024, mit Wirkung seit
  // 1. Jan. 2025", which means it BOUND every period before that day. Dropping the cap at every
  // `asOf` accepted three rates for a 2024 approval at config time and only refused them later, at
  // `vat_return`, with `saldo_form_line_missing`.
  //
  // ONLY WHEN THE CALLER STATED A DATE, and that condition is the whole subtlety. `asOf` DEFAULTS to
  // `CURRENT_RATE_ERA_FROM`, which is `2024-01-01` because that is when the current RATE era opened,
  // and that era is still running today. So a defaulted `asOf` does not mean "this approval is for
  // 2024", it means "the caller said nothing", and reading it as a period date would refuse three
  // rates for every ordinary caller configuring a workspace in 2026. The cap therefore binds only an
  // EXPLICIT pre-2025 date, which is the only case where the caller has actually named a period the
  // repeal had not yet reached. A defaulted call keeps being checked where the period is genuinely
  // known, at `vat_return`.
  const statedAsOf = typeof input.asOf === 'string' ? asOf : null;
  if (statedAsOf !== null && statedAsOf < SALDO_RATE_CAP_LIFTED_FROM && rates.length > SALDO_RATE_CAP_BEFORE_2025) {
    return err('invalid_saldo_rate', {
      reason: 'MWSTV Art. 87 allowed at most two Saldosteuersätze for a period before 01.01.2025, and it was repealed only with effect from that day',
      rateCount: rates.length,
      maxRates: SALDO_RATE_CAP_BEFORE_2025,
      asOf,
      capLiftedFrom: SALDO_RATE_CAP_LIFTED_FROM,
    });
  }

  const seen = new Set<number>();
  for (const r of rates) {
    // 0..100% in basis points, the same fat-finger bound `upsertTaxCode` applies. Enforced even when
    // no era is known, because it is arithmetic, not statute.
    if (!Number.isInteger(r.rateBp) || r.rateBp < 0 || r.rateBp > 10000) {
      return err('invalid_saldo_rate', { reason: 'rate must be an integer 0..10000 basis points', rateBp: r.rateBp });
    }
    if (era !== null) {
      // MWSTG Art. 37: a Saldosteuersatz is a reduced flat rate, so it can never exceed the
      // Normalsatz of its own era. Checked before the ladder so the rejection names the real reason.
      if (r.rateBp > era.normalBp) {
        return err('invalid_saldo_rate', {
          reason: 'rate exceeds the Normalsatz in force for the period',
          rateBp: r.rateBp,
          normalRateBp: era.normalBp,
          asOf,
        });
      }
      if (!era.saldoLadderBp.includes(r.rateBp)) {
        return err('invalid_saldo_rate', {
          reason: 'rate not on the ESTV Saldosteuersatz ladder in force for the period',
          rateBp: r.rateBp,
          asOf,
          eraFrom: era.effectiveFrom,
        });
      }
    }
    // The application-layer half of the invariant the schema also enforces with
    // UNIQUE (workspace_id, valid_from, rate_bp). Both halves exist because the failure mode of a
    // duplicate is not an error: it is two Tätigkeiten silently merged onto one rate.
    if (seen.has(r.rateBp)) return err('invalid_saldo_rate', { reason: 'duplicate saldo rate', rateBp: r.rateBp });
    seen.add(r.rateBp);
  }
  if (input.method === 'saldo' && rates.length === 0) {
    return err('invalid_saldo_rate', { reason: 'saldo method needs at least one rate' });
  }

  const activities = input.saldoActivities ?? [];
  if (activities.length > 0 && input.method !== 'saldo') {
    return err('invalid_saldo_activity', {
      reason: 'Saldo Tätigkeiten require method=saldo',
      method: input.method,
    });
  }
  const seenActivity = new Set<string>();
  for (const a of activities) {
    if (typeof a.activityId !== 'string' || a.activityId.length === 0) {
      return err('invalid_saldo_activity', { reason: 'every Tätigkeit needs a stable activityId' });
    }
    if (seenActivity.has(a.activityId)) {
      return err('invalid_saldo_activity', { reason: 'duplicate activityId', activityId: a.activityId });
    }
    seenActivity.add(a.activityId);
    if (typeof a.name !== 'string' || a.name.trim().length === 0) {
      return err('invalid_saldo_activity', { reason: 'every Tätigkeit needs a name', activityId: a.activityId });
    }
    if (!seen.has(a.rateBp)) {
      // MWSTV Art. 88 Abs. 1 taxes a Tätigkeit at the rate APPROVED for it. A Tätigkeit pointing at a
      // rate this Bewilligung does not carry has no approved rate at all, and Abs. 2's next-higher /
      // next-lower rule is the ESTV's call on an unapproved activity, not TILL's to apply silently.
      return err('invalid_saldo_activity', {
        reason: 'the Tätigkeit names a Saldosteuersatz this approval does not carry',
        activityId: a.activityId,
        rateBp: a.rateBp,
        approvedRatesBp: [...seen],
      });
    }
    if (
      a.activityCode !== undefined &&
      a.activityCode !== null &&
      !ACTIVITY_CODE_RE.test(a.activityCode)
    ) {
      return err('invalid_saldo_activity', {
        reason: 'the ESTV Tätigkeitscode is exactly five characters (eCH-0217 v2.0.0 Kap. 5.3.11)',
        activityId: a.activityId,
        activityCode: a.activityCode,
      });
    }
  }
  return null;
}

/** Resolve account NUMBERS to ids, refusing an unknown one rather than dropping it. */
function resolveAccounts(
  ctx: WorkspaceContext,
  numbers: string[],
): { ids: string[] } | { unknown: string[] } {
  const ids: string[] = [];
  const unknown: string[] = [];
  for (const number of numbers) {
    const row = ctx.store.db
      .prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?')
      .get(ctx.workspaceId, number) as { id: string } | undefined;
    if (row === undefined) unknown.push(number);
    else ids.push(row.id);
  }
  return unknown.length > 0 ? { unknown } : { ids };
}

/** True when the workspace holds any posted journal entry, which is what makes a history worth protecting. */
function hasPostedEntries(ctx: WorkspaceContext): boolean {
  const row = ctx.store.db
    .prepare("SELECT 1 AS x FROM journal_entry WHERE workspace_id = ? AND status = 'posted' LIMIT 1")
    .get(ctx.workspaceId) as { x: number } | undefined;
  return row !== undefined;
}

/** The months of a period label that carry a filing lock, so a filed approval cannot be rewritten. */
function isFiledOnOrAfter(ctx: WorkspaceContext, from: string): boolean {
  const row = ctx.store.db
    .prepare(
      `SELECT 1 AS x FROM period_lock
        WHERE workspace_id = ? AND kind = 'hard' AND reason = 'vat_filed' AND period >= ? LIMIT 1`,
    )
    .get(ctx.workspaceId, from.slice(0, 7)) as { x: number } | undefined;
  return row !== undefined;
}

/**
 * The first day no filing lock covers, so a refusal hands over a DATE instead of a rule to apply.
 *
 * Null when nothing is filed, which is the ordinary case and the one where the caller is free to
 * pick any day. The month after the latest filed one is safe whatever the cadence: Saldo files
 * semi-annually (MWSTG Art. 35 Abs. 1) and the locks are written per month by `markVatPeriodFiled`,
 * so the latest locked month is the end of the latest filed period.
 */
function nextUnfiledMonthStart(ctx: WorkspaceContext): string | null {
  const row = ctx.store.db
    .prepare(
      `SELECT MAX(period) AS p FROM period_lock
        WHERE workspace_id = ? AND kind = 'hard' AND reason = 'vat_filed'`,
    )
    .get(ctx.workspaceId) as { p: string | null } | undefined;
  const last = row?.p ?? null;
  if (last === null) return null;
  const year = Number(last.slice(0, 4));
  const month = Number(last.slice(5, 7));
  return month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, '0')}-01`;
}

/**
 * The method and timing the workspace row carries right now.
 *
 * Read here rather than imported: `workspace` is not one of the Saldo approval tables that
 * `saldoGenerations.ts` encapsulates, and `getVatConfig` below already reads the same row.
 */
function currentMethodOnRow(ctx: WorkspaceContext): { method: string; timing: string } {
  const ws = ctx.store.db
    .prepare('SELECT vat_method, vat_accounting FROM workspace WHERE id = ?')
    .get(ctx.workspaceId) as { vat_method: string | null; vat_accounting: string | null } | undefined;
  return { method: ws?.vat_method ?? 'none', timing: ws?.vat_accounting ?? 'soll' };
}

/** The latest month carrying a filing lock, or null when nothing has been filed. */
function latestFiledMonth(ctx: WorkspaceContext): string | null {
  const row = ctx.store.db
    .prepare(
      `SELECT MAX(period) AS p FROM period_lock
        WHERE workspace_id = ? AND kind = 'hard' AND reason = 'vat_filed'`,
    )
    .get(ctx.workspaceId) as { p: string | null } | undefined;
  return row?.p ?? null;
}

/** The last DAY of a `YYYY-MM` month, in integer arithmetic (no Date, no timezone). */
function endOfMonth(month: string): string {
  const year = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1] as number;
  return `${month}-${String(days).padStart(2, '0')}`;
}

/** The filed months from a day onward, oldest first, so a refusal can NAME what it collides with. */
function filedMonthsFrom(ctx: WorkspaceContext, from: string): string[] {
  const rows = ctx.store.db
    .prepare(
      `SELECT period FROM period_lock
        WHERE workspace_id = ? AND kind = 'hard' AND reason = 'vat_filed' AND period >= ?
        ORDER BY period`,
    )
    .all(ctx.workspaceId, from.slice(0, 7)) as { period: string }[];
  return rows.map((r) => r.period);
}

/**
 * The months of ONE Steuerperiode that carry a filing lock, oldest first.
 *
 * Scoped to the calendar year rather than reusing `isFiledOnOrAfter`, because the Art. 88 Abs. 6
 * election is keyed to the Steuerperiode (MWSTG Art. 34 Abs. 2) while Saldo files SEMI-ANNUALLY
 * (Art. 35 Abs. 1). Electing for 2026 with 2026-H1 already sent is the ordinary case, not a
 * contrived one, and a filing in some later year says nothing about this one.
 */
function filedMonthsOfTaxPeriod(ctx: WorkspaceContext, taxPeriod: string): string[] {
  const rows = ctx.store.db
    .prepare(
      `SELECT period FROM period_lock
        WHERE workspace_id = ? AND kind = 'hard' AND reason = 'vat_filed' AND period LIKE ?
        ORDER BY period`,
    )
    .all(ctx.workspaceId, `${taxPeriod}-%`) as { period: string }[];
  return rows.map((r) => r.period);
}

/** The shape of an approval that a return reads, as one comparable string. */
function approvalFingerprint(
  rates: readonly { rateBp: number }[],
  activities: readonly { activityId: string; activityCode: string | null; position: number; accountIds: readonly string[] }[],
): string {
  // NAME IS DELIBERATELY ABSENT. It is a label the operator picked, it never reaches a return, a
  // Ziffer or the eCH-0217 wire, and refusing a typo fix on a filed period would be a guard that
  // only teaches people to work around it. Everything else here moves a figure or an identity that
  // was submitted: the rate ladder, which rate each Tätigkeit sits at, the Ertragskonten whose
  // turnover is attributed to it, and the ESTV Tätigkeitscode the file declares it under.
  const r = rates.map((x) => x.rateBp).join(',');
  const a = [...activities]
    .map((x) => `${x.activityId}|${x.activityCode ?? ''}|${x.position}|${[...x.accountIds].sort().join('+')}`)
    .sort()
    .join(';');
  return `${r}#${a}`;
}

/**
 * Would writing this approval in place change what an already-computed return would answer?
 *
 * IT IS NOT A RATE COMPARISON, and it used to be. Under Saldo no rate is ever stamped on a journal
 * line, so a return is `gross turnover per Tätigkeit x the rate approved for that Tätigkeit`, and
 * THE ACCOUNT MAPPING IS THE ART. 84 ABS. 3 SEPARATION. Moving one Ertragskonto between two
 * Tätigkeiten at different rates moves the payable by the whole rate difference on that account's
 * turnover, with the rate ladder untouched. Comparing only rates therefore called that "immaterial"
 * and rewrote a filed period in place.
 */
function approvalWouldChange(
  stored: NonNullable<ReturnType<typeof openGeneration>>,
  rates: SaldoRateInput[],
  activities: readonly { activityId: string; activityCode: string | null; position: number; accountIds: string[] }[],
): boolean {
  const before = approvalFingerprint(
    stored.rates,
    (stored.activities as SaldoActivityRow[]).map((a) => ({
      activityId: a.activityId,
      activityCode: a.activityCode,
      position: a.position,
      accountIds: a.accounts.map((x) => x.accountId),
    })),
  );
  return before !== approvalFingerprint(rates, activities);
}

/**
 * ONE gate over every DATED write `configureVat` performs, run once before anything is written.
 *
 * ## Why it is one gate and not four
 *
 * The filed check used to guard ONE FIELD OF ONE BRANCH: an in-place approval rewrite. Four other
 * routes reached the same filed period and none of them was checked, and the independent critic found
 * all four. They are listed here with what each one did, because the shape of the mistake matters
 * more than any single instance of it: the guard was attached to a FIELD, and the thing that needs
 * guarding is the WRITE.
 *
 *   `method` / `timing` flipped with no dated `methodChange`
 *     `workspace.vat_method` carries the CURRENT method and every past period reads it when no era
 *     row covers that day, so flipping the dropdown reinterprets history. Measured: a filed 2026-H1
 *     at payable 109'111 recomputed to 142'155 under effektiv, CHF 330.44 off a submitted return.
 *     `timing: 'ist'` is the same class and strands the period with `unsupported` instead.
 *     This is not a contrived payload: `VatSettings.tsx` `buildInput()` constructs exactly it and
 *     never sets `methodChange`, so changing the dropdown and pressing Save IS this call.
 *
 *   `methodChange.validFrom` reaching a filed period
 *     Inside it, the period straddles two method eras and refuses forever, with `unlock_period`
 *     declining to help because the filing lock is `hard_lock_sealed`. Dated at its first day the
 *     figure moves silently to 142'155 instead.
 *
 *   `saldoGrant.validFrom` reaching a filed period
 *     Inside it, two approvals govern one period and both the return and the export refuse
 *     permanently. Dated at its first day, one approval still governs and the payable simply moves,
 *     measured at 109'111 becoming 106'727. Identical rates restated mid-period do it too, because a
 *     restatement still plants a boundary.
 *
 * ## Why refusing, and what it costs
 *
 * `markVatPeriodFiled` writes period locks and NOTHING else, so TILL keeps no record of a filed
 * return. The method era and the approval generation are therefore the only evidence of how a filed
 * period was computed, and any write that moves them destroys it. There is nothing to fall back on,
 * so there is no honest way to accept these writes today.
 *
 * AND THE COST IS REAL, which an earlier version of this comment denied. It claimed a mid-period
 * grant "is not a real ESTV act". That is refuted by the source it cited. MWST-Info 12, Stand
 * 01.01.2025, Ziff. 15.6: "wird der massgebende SSS rückwirkend auf den Beginn der laufenden
 * Steuerperiode bewilligt", and Beispiel 14 has the Elektro GmbH see demand spike in MAI 2025 and
 * receive its 3,7 % rate "rückwirkend auf den 1. Januar 2025". The Steuerperiode is the calendar year
 * (MWSTG Art. 34 Abs. 2) while Saldo files HALF-YEARLY (Art. 35 Abs. 1), so a grant dated 01.01.YYYY
 * reaching back over an already-filed H1 is the PUBLISHED case, not an edge one. This gate refuses a
 * lawful ESTV act, deliberately, because the alternative is destroying the only record of what was
 * filed. It is the correct interim answer and not a free one.
 *
 * D52 is the structural answer and it is scheduled: `vat_mark_filed` will persist the lines, the
 * figures and the eCH-0217 bytes actually submitted, and a recomputation that disagrees will lose to
 * the snapshot. Once a filed period can be reproduced from its own record, this gate can soften from
 * a refusal into a warning, and the retroactive grant becomes recordable. It is NOT built here: it is
 * its own capability with its own spec section, migration and critic.
 */
function refuseWritesReachingFiledPeriods(ctx: WorkspaceContext, input: ConfigureVatInput): Result | null {
  const lastFiled = latestFiledMonth(ctx);
  if (lastFiled === null) return null;
  // The last day the filing locks cover. Locks are written per MONTH by `markVatPeriodFiled`.
  const filedThrough = endOfMonth(lastFiled);
  const firstUnfiledFrom = nextUnfiledMonthStart(ctx);

  if (input.saldoGrant !== undefined && input.saldoGrant.validFrom <= filedThrough) {
    const collides = filedMonthsFrom(ctx, input.saldoGrant.validFrom);
    return err('saldo_grant_filed', {
      validFrom: input.saldoGrant.validFrom,
      filedMonths: collides,
      firstFiledMonth: collides[0],
      firstUnfiledFrom,
      reason:
        'This approval would take effect from a day that a period already filed with the ESTV covers, and TILL keeps no separate record of a filed return, so accepting it would either move a figure that has been submitted or leave that period unable to be computed at all.',
      hint: `Record the approval from the first day NOT yet filed, which \`firstUnfiledFrom\` names (${String(firstUnfiledFrom)}). A retroactive ESTV grant into an already-filed period is a real and published case (MWST-Info 12 Ziff. 15.6 dates such a grant to the start of the Steuerperiode), and TILL cannot re-rate a filed period yet: prepare that Korrekturabrechnung in the ESTV ePortal and record the approval here from the first unfiled day.`,
    });
  }

  if (input.methodChange !== undefined && input.methodChange.validFrom <= filedThrough) {
    return err('vat_method_change_filed', {
      validFrom: input.methodChange.validFrom,
      filedMonths: filedMonthsFrom(ctx, input.methodChange.validFrom),
      firstUnfiledFrom,
      reason:
        'The method change would take effect from a day that a period already filed with the ESTV covers, so the filed period would either be recomputed under a method it was not filed under or straddle two method eras and stop computing at all.',
      hint: `MWSTG Art. 37 Abs. 4 puts a method change at the start of a Steuerperiode. Date it from the first day NOT yet filed, which \`firstUnfiledFrom\` names (${String(firstUnfiledFrom)}).`,
    });
  }

  // The method or timing moving with NO dated change to carry it. `methodChange` is what writes the
  // closed era that keeps the old method alive for the days it governed; without one the workspace
  // row is the only answer and every past period silently adopts the new value.
  const current = currentMethodOnRow(ctx);
  const moved: string[] = [];
  if (input.method !== current.method) moved.push('method');
  if (input.timing !== current.timing) moved.push('timing');
  if (moved.length > 0 && input.methodChange === undefined) {
    return err('vat_method_change_undated', {
      changed: moved,
      from: { method: current.method, timing: current.timing },
      to: { method: input.method, timing: input.timing },
      filedMonths: filedMonthsFrom(ctx, '0001-01-01'),
      firstUnfiledFrom,
      reason:
        'Changing the method or the accounting timing without dating the change rewrites how every past period is computed, including periods already filed with the ESTV, because an undated change leaves no era boundary behind it.',
      hint: `State when the change takes effect with \`methodChange: { validFrom }\`, dated from the first day NOT yet filed, which \`firstUnfiledFrom\` names (${String(firstUnfiledFrom)}). MWSTG Art. 37 Abs. 4 allows the switch only at the start of a Steuerperiode.`,
    });
  }

  return null;
}

export function configureVat(ctx: WorkspaceContext, input: ConfigureVatInput): Result {
  const invalid = validate(input);
  if (invalid) return invalid;

  return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'configure_vat', () => {
    const rates = input.saldoRates ?? [];
    const stored = openGeneration(ctx);
    const leavingSaldo = input.method !== 'saldo';

    // The DATE guard comes first, because it is about the date alone and needs nothing resolved.
    // Approvals only ever move forward. Back-dating one would either overlap the approval it
    // supersedes or reopen a period that is already filed under the one before it, and the resulting
    // two-generations-govern-one-day state has no correct return.
    if (!leavingSaldo && input.saldoGrant !== undefined) {
      const latest = latestGenerationFrom(ctx);
      if (latest !== null && input.saldoGrant.validFrom <= latest) {
        return err('saldo_grant_out_of_order', {
          validFrom: input.saldoGrant.validFrom,
          latestValidFrom: latest,
          reason:
            'A new ESTV approval starts after the one it supersedes. Record it from a later day, or correct the open approval instead.',
        });
      }

    }

    // ONE GATE OVER EVERY DATED WRITE THIS FUNCTION PERFORMS, run before anything is written.
    const filedRefusal = refuseWritesReachingFiledPeriods(ctx, input);
    if (filedRefusal !== null) return filedRefusal;

    // --- The Tätigkeiten, carried by activityId when the caller does not restate them -------------
    //
    // RESOLVED BEFORE THE BRANCH IS CHOSEN, and that ordering is the fix rather than an accident.
    // Whether an in-place rewrite is allowed depends on whether it changes the approval, and the
    // account mapping is half of what an approval IS (Art. 84 Abs. 3). Deciding first and looking at
    // the attribution afterwards is what let a remap through onto a filed period.
    const rateBpToPosition = new Map<number, number>();
    rates.forEach((r, i) => rateBpToPosition.set(r.rateBp, i + 1));

    let activities: {
      activityId: string;
      name: string;
      activityCode: string | null;
      position: number;
      accountIds: string[];
    }[] = [];

    if (!leavingSaldo) {
      if (input.saldoActivities !== undefined) {
        for (const a of input.saldoActivities) {
          const resolved = resolveAccounts(ctx, a.accounts ?? []);
          if ('unknown' in resolved) {
            return err('unknown_account', {
              activityId: a.activityId,
              accounts: resolved.unknown,
              reason: 'The Tätigkeit names an Ertragskonto this chart does not carry.',
            });
          }
          activities.push({
            activityId: a.activityId,
            name: a.name,
            activityCode: a.activityCode ?? null,
            position: rateBpToPosition.get(a.rateBp) as number,
            accountIds: resolved.ids,
          });
        }
      } else if (stored !== null) {
        // THE CARRY FOLLOWS THE TÄTIGKEIT. Matched by `activityId`, re-pointed at whichever position
        // its rate now occupies. A Tätigkeit whose rate this approval no longer carries is DROPPED
        // rather than re-pointed, and the return then refuses on the unmapped Ertragskonto, which
        // names the real decision the operator has to make.
        //
        // THE REASON ON RECORD USED TO BE WRONG. It said the next-higher / next-lower rule of
        // MWSTV Art. 88 Abs. 2 "is the ESTV's call, not TILL's". Fetched, it is neither optional nor
        // the authority's: "Wurde für eine Tätigkeit der dafür festgelegte Saldosteuersatz nicht
        // bewilligt, so sind die damit erzielten Umsätze wie folgt zu versteuern: a. zum
        // nächsttieferen bewilligten Saldosteuersatz, wenn kein höherer Satz bewilligt ist; b. zum
        // nächsthöheren bewilligten Saldosteuersatz in den übrigen Fällen." It binds the
        // steuerpflichtige Person.
        //
        // Dropping is still right, for a reason that survives the correction. Abs. 2 fires on ONE
        // fact: the ESTV declined the rate this Tätigkeit's activity calls for. What reaches this
        // branch is a different and ambiguous fact: the rate is absent from the approval the caller
        // just stated. That is equally consistent with the operator mistyping the ladder or
        // restating the Bewilligung incompletely, and applying the ladder to a typo would move real
        // turnover onto a neighbouring rate silently. TILL cannot tell the two apart from what it
        // holds, so it declines to guess which premise it is standing on.
        for (const a of stored.activities as SaldoActivityRow[]) {
          const position = rateBpToPosition.get(a.rateBp);
          if (position === undefined) continue;
          activities.push({
            activityId: a.activityId,
            name: a.name,
            activityCode: a.activityCode,
            position,
            accountIds: a.accounts.map((x) => x.accountId),
          });
        }
      }

      // One Ertragskonto belongs to one Tätigkeit. The schema refuses the second row outright, so
      // the check here exists to name WHICH account and WHICH two Tätigkeiten rather than surfacing a
      // constraint failure a caller cannot act on.
      const owner = new Map<string, string>();
      for (const a of activities) {
        for (const accountId of a.accountIds) {
          const already = owner.get(accountId);
          if (already !== undefined && already !== a.activityId) {
            return err('invalid_saldo_activity', {
              reason: 'one Ertragskonto can belong to only one Tätigkeit',
              accountId,
              activityIds: [already, a.activityId],
            });
          }
          owner.set(accountId, a.activityId);
        }
      }
    }

    // --- Which approval is being written, and is the caller allowed to write it without saying? ---
    //
    // ONE PLACE DECIDES, and it looks at the WHOLE approval. There used to be two half-guards: a
    // filed check reachable only when the caller said `saldoCorrection: true`, and a rate-only
    // "materially differs" test on the fall-through. Between them sat the case that cost a filed
    // period: identical rates, a moved Ertragskonto, no branch stated, silently rewritten in place.
    let validFrom: string | null = null;
    if (!leavingSaldo) {
      if (input.saldoGrant !== undefined) {
        validFrom = input.saldoGrant.validFrom;
      } else if (stored === null) {
        // NO OPEN APPROVAL. Either this workspace has never had one, or it LEFT Saldo and is coming
        // back, and those two need different days.
        //
        // Defaulting to `OPEN_FROM_THE_START` in both cases destroyed the approval history, and it
        // did so even when every method change was lawfully dated after the filed period.
        // `writeGeneration` DELETEs the rows at the `valid_from` it is about to write, so re-entering
        // Saldo deleted the ORIGINAL generation that still sat at `0001-01-01` and replaced it with
        // today's rates. Measured: the 620/370 approval vanished, one generation remained, and a
        // filed 2026-H1 recomputed from 109'111 to 129'007. The module header claimed the history
        // could not be lost to a re-save; this was the route.
        const historical = latestGenerationFrom(ctx);
        if (historical === null) {
          validFrom = OPEN_FROM_THE_START;
        } else if (input.methodChange !== undefined && input.methodChange.validFrom > historical) {
          // Re-entry on a dated method change: the new approval starts the day the method did.
          validFrom = input.methodChange.validFrom;
        } else {
          return err('saldo_grant_required_on_reentry', {
            latestValidFrom: historical,
            reason:
              'This workspace has recorded a Saldo approval before and none is open now, so re-entering the Saldo method needs the day the new approval takes effect. Without one it would be written over the closed approval and the record of what earlier periods were filed with would be lost.',
            hint: 'Pass `saldoGrant: { validFrom }` with the day the ESTV approval takes effect, or `methodChange: { validFrom }` dated after the previous approval when the method change itself carries the date.',
          });
        }
      } else {
        // An in-place rewrite of the OPEN approval, whether or not the caller named it one.
        validFrom = stored.validFrom;
        if (approvalWouldChange(stored, rates, activities)) {
          if (isFiledOnOrAfter(ctx, stored.validFrom)) {
            // NO ESCAPE HATCH HERE, deliberately: `saldoCorrection: true` does not unlock this. What
            // TILL recorded may well have been wrong, but the figure built on it has been submitted,
            // and the lawful repair for a submitted figure is a Korrekturabrechnung, not a silent
            // rewrite of the evidence it was computed from.
            // THE HINT CARRIES THE CONSTRAINT, because without it this sentence routed people into
            // the defect above. "A NEW approval from the day it takes effect" is only safe when that
            // day is after every filed month; dated any earlier it is refused by `saldo_grant_filed`,
            // and before that guard existed it silently moved or destroyed the filed period.
            return err('saldo_generation_filed', {
              validFrom: stored.validFrom,
              firstUnfiledFrom: nextUnfiledMonthStart(ctx),
              reason:
                'A period this approval governs is already filed with the ESTV, so rewriting it in place would change a figure that has been submitted.',
              hint: 'Record what the ESTV granted as a NEW approval (`saldoGrant: { validFrom }`) dated from the first day NOT yet filed, which `firstUnfiledFrom` names. A validFrom inside or before a filed period is refused, because it would move a submitted figure or leave that period uncomputable. For periods already sent, file a Korrekturabrechnung.',
            });
          }
          if (input.saldoCorrection !== true && hasPostedEntries(ctx)) {
            // NO DEFAULT, because both defaults are wrong in a way nobody would notice. See the header.
            const ratesDiffer =
              stored.rates.length !== rates.length ||
              stored.rates.some((r, i) => r.rateBp !== rates[i]?.rateBp);
            return err('saldo_generation_change_unstated', {
              storedRatesBp: stored.rates.map((r) => r.rateBp),
              requestedRatesBp: rates.map((r) => r.rateBp),
              // WHICH HALF MOVED. Without this an attribution-only change reports two identical rate
              // arrays and reads as a bug in the refusal rather than as the question it is asking.
              changed: ratesDiffer ? 'rates' : 'activities',
              openSince: stored.validFrom,
              reason: ratesDiffer
                ? 'The approved Saldosteuersätze differ from the ones on record, and this workspace already holds posted turnover the current approval governs.'
                : 'The Tätigkeiten or the Ertragskonten attributed to them differ from the ones on record, and this workspace already holds posted turnover the current approval governs. Under Saldo the attribution IS the rate a turnover is taxed at (MWSTV Art. 84 Abs. 3), so moving an account moves the payable.',
              hint: 'Pass `saldoGrant: { validFrom }` when the ESTV granted a new approval from a given day (the current one then ends the day before), or `saldoCorrection: true` when what TILL recorded was simply wrong.',
            });
          }
        }
      }
    }

    // --- The dated method change (MWSTG Art. 37 Abs. 4) -------------------------------------------
    if (input.methodChange !== undefined) {
      const refusal = recordMethodChange(ctx, { validFrom: input.methodChange.validFrom });
      if (refusal !== null) return refusal;
    }

    const sets = ['vat_method = ?', 'vat_accounting = ?', 'vat_registered = ?'];
    const params: (string | number | null)[] = [input.method, input.timing, input.registered ? 1 : 0];
    if (input.vatNumber !== undefined) {
      sets.push('mwst_no = ?');
      params.push(input.vatNumber ?? null);
    }
    ctx.store.db.prepare(`UPDATE workspace SET ${sets.join(', ')} WHERE id = ?`).run(...params, ctx.workspaceId);

    if (leavingSaldo) {
      // THE APPROVAL HISTORY SURVIVES. Deleting it on the way out was the previous behaviour and it
      // destroyed the only evidence of what every earlier Saldo period was filed with. The open
      // approval is CLOSED at the day the method changed (or, absent a dated change, left open,
      // because nothing dates the departure and an invented date is a claim about the ESTV).
      if (input.methodChange !== undefined) closeGenerationsBefore(ctx, input.methodChange.validFrom);
    } else if (validFrom !== null) {
      if (input.saldoGrant !== undefined) closeGenerationsBefore(ctx, validFrom);
      writeGeneration(ctx, { validFrom, rates, activities });
    }

    // On enabling MWST with no codes yet, seed the default Swiss set (US-A05.5's one-sentence setup).
    if (input.registered) {
      const has = ctx.store.db
        .prepare('SELECT COUNT(*) AS c FROM tax_code WHERE workspace_id = ?')
        .get(ctx.workspaceId) as { c: number };
      if (has.c === 0) seedTaxCodes(ctx);
    }

    return getVatConfig(ctx);
  });
}

interface WsVatRow {
  vat_method: string | null;
  vat_accounting: string | null;
  vat_registered: number;
  mwst_no: string | null;
}

export function getVatConfig(ctx: WorkspaceContext): Result {
  const row = ctx.store.db
    .prepare('SELECT vat_method, vat_accounting, vat_registered, mwst_no FROM workspace WHERE id = ?')
    .get(ctx.workspaceId) as WsVatRow | undefined;
  if (row === undefined) return err('not_found', { workspaceId: ctx.workspaceId });

  // The approval in force TODAY, which is what a settings screen is asking about. A period's approval
  // is a different question and `vat_return` answers it from the period's own dates.
  const today = ctx.clock.now().slice(0, 10);
  const current = openGeneration(ctx);

  // §H-FX: the MWSTV Art. 45 conversion basis is MWST configuration too, so it is REPORTED where the
  // rest of the MWST configuration is read. It is not WRITTEN here, deliberately: the election is
  // per-Steuerperiode and locks once that period holds a posted foreign-currency entry, while this
  // verb replaces the current config wholesale on every call. Folding a period-locked value into a
  // wholesale replace would either drop it whenever a caller omitted it or make `configure_vat`
  // itself refusable with `fx_method_locked`. `set_fx_method` owns the write; this is the read.
  const period = taxPeriodOf(today);
  const fx = electedFxMethod(ctx, `${period}-12-31`);

  return ok({
    config: {
      method: row.vat_method,
      timing: row.vat_accounting,
      registered: row.vat_registered === 1,
      vatNumber: row.mwst_no,
      saldoRates: (current?.rates ?? []).map((r) => ({
        position: r.position,
        rateBp: r.rateBp,
        formLine: r.formLine,
      })),
      // D44 R1: the mapping comes back on the config read, because two thirds of the settings surface
      // had no data at all without it and a screen that cannot show what it saved cannot be verified.
      saldoActivities: current?.activities ?? [],
      saldoValidFrom: current?.validFrom ?? null,
      saldoDeclarationBasis: electedDeclarationBasis(ctx, period),
      saldoDeclarationTaxPeriod: period,
      fxMethod: fx?.method ?? null,
      fxMethodTaxPeriod: period,
      fxMethodElectedFor: fx?.electedFor ?? null,
    },
  });
}

/**
 * D44 R1: the Bewilligungsverlauf, read-only.
 *
 * The Studio's hard teaching problem on this surface is that changing a rate today does not rewrite
 * last quarter, and the honest way to teach it is to SHOW the approvals with the days each governed.
 * A reassurance that past periods are unaffected only asks to be believed; a list with an end date on
 * every superseded approval is a fact the operator can check against their own filings.
 */
export function listSaldoGenerations(ctx: WorkspaceContext): Result {
  return ok({
    generations: listGenerations(ctx).map((g) => ({
      validFrom: g.validFrom,
      validTo: g.validTo,
      createdAt: g.createdAt,
      rates: g.rates,
      activities: g.activities,
    })),
    elections: listDeclarationElections(ctx),
  });
}

export interface SetSaldoDeclarationBasisInput {
  taxPeriod: string;
  basis: string;
  idempotencyKey: string;
}

/**
 * MWSTV Art. 88 Abs. 6: declare the whole taxable turnover at the highest approved Saldosteuersatz.
 *
 *   "Die steuerpflichtige Person kann den gesamten Umsatz aus steuerbaren Leistungen freiwillig zum
 *    höchsten bewilligten Saldosteuersatz abrechnen."
 *
 * IT IS AN ELECTION, so the engine never applies it on its own. A refusal may NAME it as the lawful
 * way out of a third approved rate the ESTV form has no Ziffer for, and this verb is what a person
 * uses to take it. That distinction is the whole reason it is a verb: an engine that quietly filed
 * everything at the highest rate would be raising a person's tax bill on their behalf.
 *
 * Stored per Steuerperiode (the calendar year, MWSTG Art. 34 Abs. 2) and shaped like the shipped FX
 * conversion-basis election. Storing it on the Bewilligung was offered and declined (D44 R2): a
 * withdrawal is lawful at the next Steuerperiode and would plant an approval boundary inside the
 * period, refusing a whole quarter for a change that moved no money.
 */
export function setSaldoDeclarationBasis(ctx: WorkspaceContext, input: SetSaldoDeclarationBasisInput): Result {
  if (typeof input?.idempotencyKey !== 'string' || input.idempotencyKey.length === 0) {
    return err('invalid_input', { field: 'idempotencyKey' });
  }
  if (typeof input.taxPeriod !== 'string' || !TAX_PERIOD_RE.test(input.taxPeriod)) {
    return err('invalid_input', { field: 'taxPeriod', expected: 'YYYY' });
  }
  if (input.basis !== 'per_activity' && input.basis !== 'highest_rate') {
    return err('invalid_input', {
      field: 'basis',
      basis: input.basis,
      expected: 'per_activity or highest_rate',
    });
  }
  const basis = input.basis as SaldoDeclarationBasis;

  return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'set_saldo_declaration_basis', () => {
    const method = ctx.store.db
      .prepare('SELECT vat_method FROM workspace WHERE id = ?')
      .get(ctx.workspaceId) as { vat_method: string | null } | undefined;
    if (method?.vat_method !== 'saldo') {
      return err('invalid_vat_method', {
        method: method?.vat_method ?? 'none',
        reason: 'MWSTV Art. 88 Abs. 6 is a Saldosteuersatz simplification and has no meaning under the effektive Methode.',
      });
    }
    const previous = electedDeclarationBasis(ctx, input.taxPeriod);

    // THE ELECTION MOVES THE PAYABLE, so it is a filed-period write like any other. Abs. 6 declares
    // the WHOLE taxable turnover at the HIGHEST approved Saldosteuersatz, so electing it after a
    // half-year has been sent re-taxes turnover the ESTV already has at a different rate, and
    // withdrawing it does the same in reverse. Measured on the café fixture before this guard
    // existed: 2026-H1 filed at CHF 1'091.11 became CHF 1'176.24 from one accepted call.
    //
    // The comparison is against the EFFECTIVE basis, not the stored one. An unelected Steuerperiode
    // computes on `per_activity` (Art. 88 Abs. 1, the default), so writing `per_activity` onto a
    // filed year that never elected anything changes no figure and must not be refused: a guard that
    // refuses a no-op teaches people to route around it.
    const effectivePrevious = previous ?? 'per_activity';
    if (effectivePrevious !== basis) {
      const filed = filedMonthsOfTaxPeriod(ctx, input.taxPeriod);
      if (filed.length > 0) {
        return err('saldo_declaration_basis_filed', {
          taxPeriod: input.taxPeriod,
          basis,
          currentBasis: effectivePrevious,
          filedMonths: filed,
          reason:
            'A period inside this Steuerperiode is already filed with the ESTV, and the MWSTV Art. 88 Abs. 6 election changes the rate the whole taxable turnover is declared at, so taking or withdrawing it now would move a figure that has been submitted.',
          hint: 'The election governs a whole Steuerperiode (MWSTG Art. 34 Abs. 2) while Saldo files semi-annually (Art. 35 Abs. 1). Elect it for the NEXT Steuerperiode, or file a Korrekturabrechnung for the periods already sent.',
        });
      }
    }

    writeDeclarationElection(ctx, { taxPeriod: input.taxPeriod, basis });

    // The row is UPSERTed one per Steuerperiode, so the audit chain is the ONLY evidence that a
    // withdrawn year was ever elected. `elect` is the same action `fx_method_election` uses, and for
    // the same reason: this chooses a RULE that governs a whole Steuerperiode, it does not record an
    // amount.
    ctx.audit.record({
      entityKind: 'saldo_declaration_election',
      entityId: `${ctx.workspaceId}:${input.taxPeriod}`,
      action: 'elect',
      actor: ctx.actor,
      at: ctx.clock.now(),
    });

    return ok({
      taxPeriod: input.taxPeriod,
      basis,
      supersededBasis: previous,
      article: 'MWSTV Art. 88 Abs. 6',
    });
  });
}

/** The day a superseded approval would newly end, for a save-time preview. Exported for the Studio. */
export function newLastDayOfPredecessor(validFrom: string): string {
  return previousDay(validFrom);
}
