/**
 * A38 (D129 leg 2), the MWST-Saldierung: the per-period transfer of a FILED MWST period's balances on
 * 2200 (Umsatzsteuer), 1170 and 1171 (Vorsteuer) to 2201 (MWST-Abrechnungskonto), dated the period end,
 * so that at year end the three tax accounts read zero and 2201 carries exactly what the ESTV is owed
 * (the research §8 step 11 fact; item 8b of the MWST-Periode checklist and the `vat_settled` row of the
 * `year_close` checklist, G22 §10).
 *
 * ## The shape: a PURE READ, then a POSTER that writes exactly what the read showed (design doc §7.7)
 *
 * The figures are wholly derived from the ledger, nothing a human types, so there is no draft row: one
 * function, `settlementModelOf`, computes the model, `vatSettlementPreview` returns it and
 * `vatSettlementPost` posts its lines. The preview IS the posting minus the write, by construction and
 * not by agreement between two code paths (the A22 `computeFxRevaluation` / `postFxRevaluation` shape).
 *
 * ## The lines
 *
 *   effektiv:  Dr 2200 output / Cr 2201 output;  Dr 2201 in1170 / Cr 1170;  Dr 2201 in1171 / Cr 1171
 *   saldo:     Dr 2200 booked / Cr 2201 tax due (the return's flat-rate figure), the difference to 3809
 *              (owner question Q3, D129: the Saldosteuersatz income-reduction account; when the books
 *              carry no 2200 leg, as gross-booked Saldo sales do, this is exactly Dr 3809 / Cr 2201).
 *              NEVER a Vorsteuer leg: Art. 37 MWSTG deducts no input tax under the flat rate, so 1170
 *              and 1171 must read zero. The ledger does not enforce that by construction (it admits a
 *              `VST-M` line or an untagged 1170 debit in a Saldo book), so the settlement enforces it
 *              at the gate: while 1170 or 1171 carry a balance up to the period end (a reversal of an
 *              entry inside it counts wherever it is dated) and no settlement of the period stands,
 *              preview and post refuse `saldo_input_vat_booked {balance}` and the human corrects the
 *              book first. Netting that balance into 2201 would understate what the ESTV is owed by
 *              exactly the Vorsteuer the return never deducted (critic finding, 2026-09-09).
 *
 * A negative movement flips the sides (a quarter of credit notes leaves 2200 in debit) and a zero leg is
 * omitted; a period with no movement on any account is `nothing_to_settle`. Every amount is base minor.
 *
 * ## Why it is admitted into a filed, hard-locked period, and why that cannot move the return
 *
 * The settlement is dated the period end and the period is filed (`vat_filed`), so `postEntry` refuses
 * it under §H-PERIOD as it stands. A38 §4.6 relaxes the lock for `source='vat_settlement'` under three
 * enforced conditions (no VAT trace, only the tax accounts, never into a `year_close` seal), and the A07
 * return and bridge exclude this source and its reversals by name from the 2200 read. So the transfer
 * moves what was declared without touching what was declared. The filing comes FIRST: a settlement of
 * an unfiled period refuses `period_not_filed`, because the transfer moves the declared figures and the
 * declaration is what a human stood behind.
 *
 * Statutory anchor (fetched 2026-09-09 from estv.admin.ch, "Welche Unterlagen für die MWST-Kontrolle
 * sind bereitzustellen?"): the ESTV expects the "Umsatzabstimmung pro Jahr, ausgehend von den Salden
 * der massgebenden Ertrags-Konten ... gegenüber der Ziffer 200 der Abrechnungsformulare (Art. 128
 * Abs. 2 MWSTV)" and the "Vorsteuerabstimmung pro Jahr, verbuchte Vorsteuer gemäss Vorsteuerkonten der
 * Finanzbuchhaltung gegenüber der Deklaration in den Abrechnungsformularen". The `declared` column of
 * the model is that comparison per period, booked beside declared with the difference; the annual
 * reconciliation (`annualReconciliation.ts`) is the year-level one.
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { requireString } from '../ledger/inputGuards.js';
import { postEntry, VAT_SETTLEMENT_SOURCE } from '../ledger/postEntry.js';
import type { LineInput } from '../ledger/postEntry.js';
import { reverseOwnedEntry } from '../ledger/reverseEntry.js';
import {
  computeVatReturn,
  listVatPeriods,
  monthsOfVatPeriod,
  OUTPUT_VAT_ACCOUNT,
  INPUT_VAT_ACCOUNTS,
} from '../vat/abrechnung.js';

/** The MWST-Abrechnungskonto the settled balances transfer to (Kontenrahmen KMU, seeded by A01). */
export const VAT_SETTLEMENT_TARGET_ACCOUNT = '2201';
/** Owner question Q3 (D129): the Saldosteuersatz income-reduction account the flat-rate tax books against. */
export const SALDO_TAX_ACCOUNT = '3809';

/** The statuses a settlement row moves through (§H-ENUM, the single source). */
export const VAT_SETTLEMENT_STATUSES: readonly string[] = ['posted', 'reversed'];

/**
 * Abort a write transaction with a structured cause. `db.transaction(fn)()` commits unless the callback
 * THROWS, so a plain `return err(...)` from inside the tx would commit (and memoise) a half-done post.
 * Throwing this is the only way to roll the entry and the row back together (the A22 `FxRevalAbort`).
 */
class SettlementAbort {
  constructor(public readonly result: Result) {}
}

function runGuarded(body: () => Result): Result {
  try {
    return body();
  } catch (e) {
    if (e instanceof SettlementAbort) return e.result;
    throw e;
  }
}

export type VatSettlementLineRole = 'output' | 'input_1170' | 'input_1171' | 'saldo_difference';

/** One leg of the settlement entry, in the order it posts. */
export interface VatSettlementLine {
  readonly role: VatSettlementLineRole;
  readonly accountNumber: string;
  readonly accountId: string;
  readonly debitMinor: number;
  readonly creditMinor: number;
}

export interface VatSettlementRow {
  readonly settlementId: string;
  readonly period: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly method: string;
  readonly outputMinor: number;
  readonly inputMinor: number;
  readonly netMinor: number;
  readonly entryId: string;
  readonly reversalEntryId: string | null;
  readonly status: string;
  readonly postedAt: string;
  readonly postedBy: string | null;
  readonly reversedAt: string | null;
  readonly reversedBy: string | null;
}

/**
 * What the preview shows and the post writes: ONE model (design doc §7.7). A `type`, not an
 * `interface`, because a DECLARED payload (`Result<VatSettlementModel>`) must satisfy the open
 * `OkFields` index signature, which only an object type alias does (the `PostEntryOk` shape).
 */
export type VatSettlementModel = {
  readonly period: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly method: string;
  /** Every month of the period carries the `vat_filed` hard lock (A07's own derivation). */
  readonly filed: boolean;
  /** The net credit booked on 2200 over the period (settlement entries excluded). */
  readonly outputMinor: number;
  /** The net debit booked on 1170 + 1171 over the period (settlement entries excluded); always 0 under Saldo. */
  readonly inputMinor: number;
  /** The net credit that lands on 2201: what the ESTV is owed for the period after the transfer. */
  readonly netMinor: number;
  readonly lines: readonly VatSettlementLine[];
  /** A07's return for the same period: Ziffer 399, Ziffer 400 + 405, and their net. */
  readonly declared: { readonly outputMinor: number; readonly inputMinor: number; readonly netMinor: number };
  /** Booked minus declared, per side. Non-zero means the books and the filed form disagree. */
  readonly differences: { readonly outputMinor: number; readonly inputMinor: number; readonly netMinor: number };
  readonly nothingToSettle: boolean;
  /** The posted settlement row for this period, when one stands. */
  readonly settlement: VatSettlementRow | null;
};

interface AccountIdRow {
  id: string;
  number: string;
}

interface MovementRow {
  output_minor: number;
  input_1170_minor: number;
  input_1171_minor: number;
}

interface DbRow {
  id: string;
  period_label: string;
  period_start: string;
  period_end: string;
  method: string;
  output_minor: number;
  input_minor: number;
  net_minor: number;
  entry_id: string;
  reversal_entry_id: string | null;
  status: string;
  idempotency_key: string;
  posted_at: string;
  posted_by: string | null;
  reversed_at: string | null;
  reversed_by: string | null;
}

function mapRow(r: DbRow): VatSettlementRow {
  return {
    settlementId: r.id,
    period: r.period_label,
    periodStart: r.period_start,
    periodEnd: r.period_end,
    method: r.method,
    outputMinor: r.output_minor,
    inputMinor: r.input_minor,
    netMinor: r.net_minor,
    entryId: r.entry_id,
    reversalEntryId: r.reversal_entry_id,
    status: r.status,
    postedAt: r.posted_at,
    postedBy: r.posted_by,
    reversedAt: r.reversed_at,
    reversedBy: r.reversed_by,
  };
}

const ROW_COLUMNS =
  'id, period_label, period_start, period_end, method, output_minor, input_minor, net_minor, entry_id, reversal_entry_id, status, idempotency_key, posted_at, posted_by, reversed_at, reversed_by';

function postedRowFor(ctx: WorkspaceContext, periodStart: string): DbRow | undefined {
  return ctx.store.db
    .prepare(`SELECT ${ROW_COLUMNS} FROM vat_settlement WHERE workspace_id = ? AND period_start = ? AND status = 'posted'`)
    .get(ctx.workspaceId, periodStart) as DbRow | undefined;
}

function rowById(ctx: WorkspaceContext, settlementId: string): DbRow | undefined {
  return ctx.store.db
    .prepare(`SELECT ${ROW_COLUMNS} FROM vat_settlement WHERE workspace_id = ? AND id = ?`)
    .get(ctx.workspaceId, settlementId) as DbRow | undefined;
}

/**
 * The account ids the settlement names, by Kontenrahmen number. A missing account is `missing_account`
 * naming the number: the chart is A01's and the settlement never invents a row.
 */
function accountsOf(ctx: WorkspaceContext, numbers: readonly string[]): Result<{ ids: Record<string, string> }> {
  const ids: Record<string, string> = {};
  for (const number of numbers) {
    const row = ctx.store.db
      .prepare('SELECT id, number FROM account WHERE workspace_id = ? AND number = ?')
      .get(ctx.workspaceId, number) as AccountIdRow | undefined;
    if (row === undefined) return err('missing_account', { number });
    ids[number] = row.id;
  }
  return ok({ ids });
}

/**
 * The period's movement on the three tax accounts, base minor, over posted entries, EXCLUDING
 * `source='vat_settlement'` entries and their reversals (the same predicate `bookedVatByEntry` in
 * `abrechnung.ts` applies, so what this settles is what the return compared against). Output is the net
 * credit on 2200, input the net debit on each Vorsteuer account: a reversal subtracts by construction.
 */
function movementOf(ctx: WorkspaceContext, periodStart: string, periodEnd: string): MovementRow {
  return ctx.store.db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN a.number = ? THEN l.base_credit_minor - l.base_debit_minor ELSE 0 END), 0) AS output_minor,
              COALESCE(SUM(CASE WHEN a.number = ? THEN l.base_debit_minor - l.base_credit_minor ELSE 0 END), 0) AS input_1170_minor,
              COALESCE(SUM(CASE WHEN a.number = ? THEN l.base_debit_minor - l.base_credit_minor ELSE 0 END), 0) AS input_1171_minor
         FROM journal_line l
         JOIN journal_entry e ON e.id = l.entry_id
         JOIN account a ON a.id = l.account_id
        WHERE e.workspace_id = ? AND e.status = 'posted' AND e.date >= ? AND e.date <= ?
          AND e.source <> ?
          AND NOT (e.source = 'reversal' AND e.reverses_entry_id IN
                   (SELECT id FROM journal_entry WHERE workspace_id = ? AND source = ?))`,
    )
    .get(
      OUTPUT_VAT_ACCOUNT,
      INPUT_VAT_ACCOUNTS[0],
      INPUT_VAT_ACCOUNTS[1],
      ctx.workspaceId,
      periodStart,
      periodEnd,
      VAT_SETTLEMENT_SOURCE,
      ctx.workspaceId,
      VAT_SETTLEMENT_SOURCE,
    ) as MovementRow;
}

/**
 * The balance (net debit, base minor) each Vorsteuer account carries UP TO the period end: every posted
 * line dated `<= periodEnd`, plus every `source='reversal'` line whose reversed entry is dated
 * `<= periodEnd`. The second clause is what lets a filed period be corrected at all: under Saldo a
 * wrongly booked 1170 inside a FILED period can only be undone by a reversal dated in the open period,
 * and a read that stopped at the period end would never see that correction. What the read must NOT
 * see is the book AFTER the period: a workspace that left Saldo on 01.01.2027 (Art. 37 Abs. 4) books
 * legitimate, deductible Vorsteuer from January on, and a whole-book sum refused 2026-H2 on that
 * January balance and told the human to reverse a correct entry (critic finding, 2026-09-10). In a
 * live effektiv book 1170 is never zero, so the last Saldo period would have stayed unsettleable.
 */
function inputVatBalanceOf(ctx: WorkspaceContext, periodEnd: string): Record<string, number> {
  const row = ctx.store.db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN a.number = ? THEN l.base_debit_minor - l.base_credit_minor ELSE 0 END), 0) AS b1170,
              COALESCE(SUM(CASE WHEN a.number = ? THEN l.base_debit_minor - l.base_credit_minor ELSE 0 END), 0) AS b1171
         FROM journal_line l
         JOIN journal_entry e ON e.id = l.entry_id
         JOIN account a ON a.id = l.account_id
        WHERE e.workspace_id = ? AND e.status = 'posted'
          AND (e.date <= ?
               OR (e.source = 'reversal' AND e.reverses_entry_id IN
                   (SELECT id FROM journal_entry WHERE workspace_id = ? AND status = 'posted' AND date <= ?)))`,
    )
    .get(INPUT_VAT_ACCOUNTS[0], INPUT_VAT_ACCOUNTS[1], ctx.workspaceId, periodEnd, ctx.workspaceId, periodEnd) as {
    b1170: number;
    b1171: number;
  };
  return { [INPUT_VAT_ACCOUNTS[0] as string]: row.b1170, [INPUT_VAT_ACCOUNTS[1] as string]: row.b1171 };
}

/** A leg on `account` for a SIGNED amount: positive debits it, negative credits it, zero is no leg. */
function leg(
  role: VatSettlementLineRole,
  accountNumber: string,
  accountId: string,
  debitPositiveMinor: number,
): VatSettlementLine | null {
  if (debitPositiveMinor === 0) return null;
  return debitPositiveMinor > 0
    ? { role, accountNumber, accountId, debitMinor: debitPositiveMinor, creditMinor: 0 }
    : { role, accountNumber, accountId, debitMinor: 0, creditMinor: -debitPositiveMinor };
}

/**
 * THE ONE FUNCTION: the settlement model of a period, read from the ledger and A07's return. The preview
 * returns it and the post writes its lines. Pure (Pattern P5): nothing is written.
 */
export function settlementModelOf(ctx: WorkspaceContext, period: string): Result<VatSettlementModel> {
  if (typeof period !== 'string' || monthsOfVatPeriod(period) === null) {
    return err('invalid_period', { period, expected: 'YYYY-Qn or YYYY-Hn' });
  }
  const year = period.slice(0, 4);
  const listed = listVatPeriods(ctx, { year });
  if (!listed.ok) return listed;
  const periods = listed.periods as { label: string; periodStart: string; periodEnd: string; filed: boolean }[];
  const found = periods.find((p) => p.label === period);
  if (found === undefined) {
    // A quarter label on a Saldo year (or a half-year on an effektiv one): the label is well-formed
    // but it is not a period this workspace files, so it is not one it can settle.
    return err('invalid_period', { period, method: listed.method, expected: periods.map((p) => p.label) });
  }
  const method = listed.method as string;

  const ret = computeVatReturn(ctx, { periodStart: found.periodStart, periodEnd: found.periodEnd });
  if (!ret.ok) return ret;
  const declaredOutput = ret.totalTaxDueMinor as number;
  const declaredInput = ret.totalInputTaxMinor as number;
  const declared = { outputMinor: declaredOutput, inputMinor: declaredInput, netMinor: declaredOutput - declaredInput };

  const numbers =
    method === 'saldo'
      ? [OUTPUT_VAT_ACCOUNT, ...INPUT_VAT_ACCOUNTS, VAT_SETTLEMENT_TARGET_ACCOUNT, SALDO_TAX_ACCOUNT]
      : [OUTPUT_VAT_ACCOUNT, ...INPUT_VAT_ACCOUNTS, VAT_SETTLEMENT_TARGET_ACCOUNT];
  const accounts = accountsOf(ctx, numbers);
  if (!accounts.ok) return accounts;
  const id = (number: string): string => accounts.ids[number] as string;

  const moved = movementOf(ctx, found.periodStart, found.periodEnd);
  const outputMinor = moved.output_minor;
  const existing = postedRowFor(ctx, found.periodStart);

  const lines: VatSettlementLine[] = [];
  let target = 0; // the signed credit landing on 2201
  let inputMinor = 0;
  if (method === 'saldo') {
    // The Saldosteuersatz shape (Q3). The flat-rate tax due is what the ESTV is owed and lands on 2201;
    // whatever the books carried on 2200 (the invoiced tax, when sales were booked net) is emptied, and
    // the difference between the two is the Saldo income effect on 3809. With no 2200 movement the
    // entry is the owner's Dr 3809 / Cr 2201 exactly. NO Vorsteuer leg, ever (Art. 37 MWSTG): a balance
    // on 1170 / 1171 up to the period end is a booking error the human corrects first, and while it
    // stands (and no settlement of this period does) the model is refused by name rather than netted
    // into 2201, which would understate the ESTV liability by exactly the Vorsteuer the return never
    // deducted. Read up to the period end, not over the whole book: Vorsteuer booked AFTER the period
    // (a lawful switch to effektiv from the next year) is not this period's error.
    if (existing === undefined) {
      const balance = inputVatBalanceOf(ctx, found.periodEnd);
      const totalMinor = Object.values(balance).reduce((a, b) => a + b, 0);
      if (Object.values(balance).some((b) => b !== 0)) {
        return err('saldo_input_vat_booked', {
          period,
          periodStart: found.periodStart,
          periodEnd: found.periodEnd,
          method,
          balance,
          totalMinor,
          remedy: 'the flat-rate method deducts no input tax; correct the entries on 1170 / 1171 (a reversal in the open period), then settle',
        });
      }
    }
    const taxDue = declaredOutput;
    const out = leg('output', OUTPUT_VAT_ACCOUNT, id(OUTPUT_VAT_ACCOUNT), outputMinor);
    if (out !== null) lines.push(out);
    const diff = leg('saldo_difference', SALDO_TAX_ACCOUNT, id(SALDO_TAX_ACCOUNT), taxDue - outputMinor);
    if (diff !== null) lines.push(diff);
    target = taxDue;
  } else {
    inputMinor = moved.input_1170_minor + moved.input_1171_minor;
    const out = leg('output', OUTPUT_VAT_ACCOUNT, id(OUTPUT_VAT_ACCOUNT), outputMinor);
    if (out !== null) lines.push(out);
    const in1170 = leg('input_1170', INPUT_VAT_ACCOUNTS[0] as string, id(INPUT_VAT_ACCOUNTS[0] as string), -moved.input_1170_minor);
    if (in1170 !== null) lines.push(in1170);
    const in1171 = leg('input_1171', INPUT_VAT_ACCOUNTS[1] as string, id(INPUT_VAT_ACCOUNTS[1] as string), -moved.input_1171_minor);
    if (in1171 !== null) lines.push(in1171);
    target = outputMinor - inputMinor;
  }
  // 2201 takes the balancing leg: a credit when the period owes tax, a debit on a Vorsteuer surplus. It
  // is placed LAST so the entry reads Dr 2200 / Cr 2201 the way the spec writes it; the entry balances
  // in base Rappen by construction (every other leg is one side of exactly this figure).
  const target2201 = leg('output', VAT_SETTLEMENT_TARGET_ACCOUNT, id(VAT_SETTLEMENT_TARGET_ACCOUNT), -target);
  const ordered = target2201 === null ? lines : [...lines, target2201];
  const netMinor = target;

  return ok<VatSettlementModel>({
    period,
    periodStart: found.periodStart,
    periodEnd: found.periodEnd,
    method,
    filed: found.filed,
    outputMinor,
    inputMinor,
    netMinor,
    lines: ordered,
    declared,
    differences: {
      outputMinor: outputMinor - declared.outputMinor,
      inputMinor: inputMinor - declared.inputMinor,
      netMinor: netMinor - declared.netMinor,
    },
    nothingToSettle: ordered.length === 0,
    settlement: existing === undefined ? null : mapRow(existing),
  });
}

export interface VatSettlementPreviewInput {
  period: string;
}

/** The preview: the model, nothing written. */
export function vatSettlementPreview(ctx: WorkspaceContext, input: VatSettlementPreviewInput): Result {
  return settlementModelOf(ctx, input?.period);
}

export interface VatSettlementPostInput {
  period: string;
  idempotencyKey: string;
}

/**
 * Post the settlement the preview showed, dated the period end, `source='vat_settlement'`, and record
 * the row. §H-IDEMPOTENT on the key (a replay returns the stored result and writes nothing, for as long
 * as the settlement it booked still stands: a key whose settlement was reversed is `already_reversed_key`)
 * AND on rows (a period is settled at most once while its settlement stands: a different key is
 * `already_posted`);
 * §H-PERIOD via the carve-out (a `year_close` seal still refuses); §H-TENANT on every query.
 */
export function vatSettlementPost(ctx: WorkspaceContext, input: VatSettlementPostInput): Result {
  const capable = ctx.capabilities.assert('post');
  if (!capable.ok) return capable;
  const guard = requireString(input?.period, 'period') ?? requireString(input?.idempotencyKey, 'idempotencyKey');
  if (guard) return guard;

  const replayed = ctx.store.recallIdempotent<Result>(ctx.workspaceId, input.idempotencyKey, 'vat_settlement_post');
  if (replayed !== undefined) {
    // A memo names ONE settlement. Once that settlement is reversed, the memo records a post that no
    // longer stands, and replaying it would answer `ok:true` while booking nothing (the only row for
    // the period `reversed`, the ledger empty of the settlement). The key is spent: refuse by name and
    // send the caller to a fresh key, which posts a NEW settlement (critic finding, 2026-09-09).
    if (replayed.ok) {
      const memo = rowById(ctx, replayed.settlementId as string);
      if (memo !== undefined && memo.status !== 'posted') {
        return err('already_reversed_key', {
          period: memo.period_label,
          settlementId: memo.id,
          reversalEntryId: memo.reversal_entry_id,
          idempotencyKey: input.idempotencyKey,
          remedy: 'the key names a settlement that was reversed; post again under a NEW idempotencyKey',
        });
      }
    }
    return replayed;
  }

  const model = settlementModelOf(ctx, input.period);
  if (!model.ok) return model;
  if (!model.filed) {
    // The transfer moves what was declared, so it waits for the declaration (spec §2 story 5.2).
    return err('period_not_filed', { period: model.period, periodStart: model.periodStart, periodEnd: model.periodEnd });
  }
  if (model.settlement !== null) {
    return err('already_posted', {
      period: model.period,
      settlementId: model.settlement.settlementId,
      entryId: model.settlement.entryId,
      postedAt: model.settlement.postedAt,
    });
  }
  if (model.nothingToSettle) {
    return err('nothing_to_settle', { period: model.period, periodStart: model.periodStart, periodEnd: model.periodEnd });
  }

  const lines: LineInput[] = model.lines.map((l) =>
    l.debitMinor > 0 ? { account: l.accountId, debit: l.debitMinor } : { account: l.accountId, credit: l.creditMinor },
  );

  return runGuarded(() =>
    ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'vat_settlement_post', () => {
      const posted = postEntry(ctx, {
        date: model.periodEnd,
        source: VAT_SETTLEMENT_SOURCE,
        // Keyed on the period AND the caller's key: after a reversal a fresh post is a NEW entry, not a
        // replay of the reversed one.
        idempotencyKey: `vatsettle:${model.periodStart}:${input.idempotencyKey}`,
        description: `MWST-Saldierung ${model.period}`,
        lines,
      });
      if (!posted.ok) throw new SettlementAbort(posted);

      const settlementId = ctx.ids.next('vatsettle');
      const at = ctx.clock.now();
      ctx.store.db
        .prepare(
          `INSERT INTO vat_settlement
             (id, workspace_id, period_label, period_start, period_end, method, output_minor, input_minor, net_minor,
              entry_id, reversal_entry_id, status, idempotency_key, posted_by, posted_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'posted', ?, ?, ?)`,
        )
        .run(
          settlementId,
          ctx.workspaceId,
          model.period,
          model.periodStart,
          model.periodEnd,
          model.method,
          model.outputMinor,
          model.inputMinor,
          model.netMinor,
          posted.entryId,
          input.idempotencyKey,
          ctx.actor,
          at,
        );
      ctx.audit.record({ entityKind: 'vat_settlement', entityId: settlementId, action: 'post', actor: ctx.actor, at });

      return ok({
        settlementId,
        period: model.period,
        periodStart: model.periodStart,
        periodEnd: model.periodEnd,
        method: model.method,
        entryId: posted.entryId,
        outputMinor: model.outputMinor,
        inputMinor: model.inputMinor,
        netMinor: model.netMinor,
        lines: model.lines,
        status: 'posted',
        postedAt: at,
      });
    }),
  );
}

export interface VatSettlementReverseInput {
  settlementId: string;
  idempotencyKey: string;
}

/**
 * Reverse a posted settlement: the OWNED `reverseEntry` of its entry (the raw `reverse_entry` tool is
 * refused `owned_by {verb: 'vat_settlement_reverse'}` on a settlement target), dated the period end so
 * the four accounts net to zero INSIDE the settled period, admitted over the filing lock by the same
 * carve-out (A38 §4.6). The row moves to `reversed` and keeps its history; a later post for the period
 * creates a new row.
 */
export function vatSettlementReverse(ctx: WorkspaceContext, input: VatSettlementReverseInput): Result {
  const capable = ctx.capabilities.assert('post');
  if (!capable.ok) return capable;
  const guard = requireString(input?.settlementId, 'settlementId') ?? requireString(input?.idempotencyKey, 'idempotencyKey');
  if (guard) return guard;

  const replayed = ctx.store.recallIdempotent<Result>(ctx.workspaceId, input.idempotencyKey, 'vat_settlement_reverse');
  if (replayed !== undefined) return replayed;

  const row = rowById(ctx, input.settlementId);
  if (row === undefined) return err('not_found', { settlementId: input.settlementId });
  if (row.status === 'reversed') {
    return err('already_reversed', { settlementId: row.id, reversalEntryId: row.reversal_entry_id });
  }

  return runGuarded(() =>
    ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'vat_settlement_reverse', () => {
      // The OWNED reversal: the raw `reverse_entry` tool refuses a settlement target `owned_by` this
      // verb, because only this transaction moves the row beside the mirror.
      const reversed = reverseOwnedEntry(
        ctx,
        {
          entryId: row.entry_id,
          date: row.period_end,
          description: `Storno MWST-Saldierung ${row.period_label}`,
          idempotencyKey: `vatsettle-rev:${row.id}:${input.idempotencyKey}`,
        },
        'vat_settlement_reverse',
      );
      if (!reversed.ok) throw new SettlementAbort(reversed);

      const at = ctx.clock.now();
      ctx.store.db
        .prepare(
          "UPDATE vat_settlement SET status = 'reversed', reversal_entry_id = ?, reversed_at = ?, reversed_by = ? WHERE workspace_id = ? AND id = ?",
        )
        .run(reversed.reversalId, at, ctx.actor, ctx.workspaceId, row.id);
      ctx.audit.record({ entityKind: 'vat_settlement', entityId: row.id, action: 'reverse', actor: ctx.actor, at });

      return ok({
        settlementId: row.id,
        period: row.period_label,
        entryId: row.entry_id,
        reversalEntryId: reversed.reversalId,
        status: 'reversed',
        reversedAt: at,
      });
    }),
  );
}

export interface VatSettlementListInput {
  /** `YYYY`; every year when absent. */
  year?: string;
}

/** The settlements on record, newest period first, both statuses. A pure read. */
export function vatSettlementList(ctx: WorkspaceContext, input: VatSettlementListInput = {}): Result {
  const year = input?.year;
  if (year !== undefined && !/^\d{4}$/.test(year)) return err('invalid_input', { field: 'year', expected: 'YYYY' });
  const rows = (
    year === undefined
      ? ctx.store.db
          .prepare(`SELECT ${ROW_COLUMNS} FROM vat_settlement WHERE workspace_id = ? ORDER BY period_start DESC, posted_at DESC`)
          .all(ctx.workspaceId)
      : ctx.store.db
          .prepare(
            `SELECT ${ROW_COLUMNS} FROM vat_settlement WHERE workspace_id = ? AND period_start >= ? AND period_start <= ? ORDER BY period_start DESC, posted_at DESC`,
          )
          .all(ctx.workspaceId, `${year}-01-01`, `${year}-12-31`)
  ) as DbRow[];
  return ok({ year: year ?? null, settlements: rows.map(mapRow) });
}
