/**
 * A38, the shared vocabulary and the ONE line-construction function.
 *
 * `accrualLinesOf` is the single place an Abgrenzung becomes journal lines: the draft's preview,
 * the post and the Storno all call it, so what the editor shows IS what posts (design doc §7.7, the
 * H04 draft-run shape). The enums here are the §H-ENUM source for the kinds, the Art. 960e reason
 * list and the three status machines; the Studio mirrors `ACCRUAL_KINDS` and `PROVISION_REASONS`
 * under the `studio-mirrors-engine-enums` guard.
 *
 * Every amount is an integer of base-currency minor units (Rappen). An accrual is a base-currency
 * posting by construction (spec §4.5, §H-FX): nothing here converts.
 */

import type { WorkspaceContext } from '../context.js';
import type { LineInput } from '../ledger/postEntry.js';

/**
 * The four Abgrenzung kinds of OR Art. 958b, each on its statutory balance-sheet heading: the two
 * ACTIVE kinds sit on 1300 (aktive Rechnungsabgrenzung, OR 959a Abs. 1 Ziff. 1 lit. e), the two
 * PASSIVE kinds on 2300 (passive Rechnungsabgrenzung, OR 959a Abs. 2 Ziff. 1 lit. d).
 */
export const ACCRUAL_KINDS = ['prepaid_expense', 'accrued_income', 'accrued_expense', 'deferred_income'] as const;
export type AccrualKind = (typeof ACCRUAL_KINDS)[number];

/**
 * The Art. 960e OR reason list (Abs. 2 the general duty, Abs. 3 the four admitted extras), with
 * `steuern` for the tax provision the ZStB 27/1 helper drafts and `sonstige` as the escape hatch
 * that must carry a real description. Not extensible per workspace (spec §6b): the statute is the
 * list.
 */
export const PROVISION_REASONS = [
  'garantie',
  'ferien_ueberzeit',
  'prozess',
  'grossreparatur',
  'sanierung',
  'restrukturierung',
  'steuern',
  'sonstige',
] as const;
export type ProvisionReason = (typeof PROVISION_REASONS)[number];

/** The minimum description length `sonstige` demands, so the reason on record is a reason. */
export const SONSTIGE_MIN_DESCRIPTION = 10;

export const ACCRUAL_STATUSES = ['draft', 'posted', 'reversed', 'discarded'] as const;
export type AccrualStatus = (typeof ACCRUAL_STATUSES)[number];

export const PROVISION_STATUSES = ['draft', 'posted', 'released', 'reversed', 'discarded'] as const;
export type ProvisionStatus = (typeof PROVISION_STATUSES)[number];

/** The statutory balance-sheet accounts the accrual kinds resolve to (A01 seed numbers). */
export const ACTIVE_ACCRUAL_ACCOUNT = '1300';
export const PASSIVE_ACCRUAL_ACCOUNT = '2300';

/** The two seeded provision accounts (D129 Q4 added 2330; 2600 is the long-term statutory heading). */
export const SHORT_TERM_PROVISION_ACCOUNT = '2330';
export const LONG_TERM_PROVISION_ACCOUNT = '2600';

/** The seeded direct-tax expense the tax helper charges (D129 Q4). */
export const DIRECT_TAX_ACCOUNT = '8900';

/** The journal sources this module writes. Only this module writes them (P3, the A22 `fx` shape). */
export const ACCRUAL_SOURCE = 'accrual';
export const PROVISION_SOURCE = 'provision';

/** What each kind needs on its contra side, and which balance-sheet account it lands on. */
export interface AccrualKindRule {
  readonly balanceAccountNumber: string;
  /** The account type the contra (P&L) account must have. */
  readonly contraType: 'income' | 'expense';
  /** Whether the BALANCE account is debited (an active Abgrenzung) or credited (a passive one). */
  readonly balanceSide: 'debit' | 'credit';
}

export const ACCRUAL_KIND_RULES: Readonly<Record<AccrualKind, AccrualKindRule>> = {
  // Aufwand vorausbezahlt: the expense was booked this period but belongs to the next.
  prepaid_expense: { balanceAccountNumber: ACTIVE_ACCRUAL_ACCOUNT, contraType: 'expense', balanceSide: 'debit' },
  // Ertrag noch nicht fakturiert: earned this period, invoiced next.
  accrued_income: { balanceAccountNumber: ACTIVE_ACCRUAL_ACCOUNT, contraType: 'income', balanceSide: 'debit' },
  // Aufwand noch nicht fakturiert: consumed this period, billed next.
  accrued_expense: { balanceAccountNumber: PASSIVE_ACCRUAL_ACCOUNT, contraType: 'expense', balanceSide: 'credit' },
  // Ertrag vorausbezahlt erhalten: invoiced this period, earned next.
  deferred_income: { balanceAccountNumber: PASSIVE_ACCRUAL_ACCOUNT, contraType: 'income', balanceSide: 'credit' },
};

export function isAccrualKind(value: unknown): value is AccrualKind {
  return typeof value === 'string' && (ACCRUAL_KINDS as readonly string[]).includes(value);
}

export function isProvisionReason(value: unknown): value is ProvisionReason {
  return typeof value === 'string' && (PROVISION_REASONS as readonly string[]).includes(value);
}

/** The columns `accrualLinesOf` reads: a row shape, so the draft and the post feed it the same thing. */
export interface AccrualLineSource {
  readonly kind: AccrualKind;
  readonly amountMinor: number;
  readonly balanceAccountId: string;
  readonly contraAccountId: string;
  readonly costCenterId: string | null;
}

/**
 * THE ONE FUNCTION. The two `postEntry` lines an accrual is, debit-first. The cost centre rides the
 * P&L line only: a balance-sheet account never carries one (A01 `cost_center_allowed`).
 */
export function accrualLinesOf(row: AccrualLineSource): LineInput[] {
  const rule = ACCRUAL_KIND_RULES[row.kind];
  const contra: LineInput =
    rule.balanceSide === 'debit'
      ? { account: row.contraAccountId, credit: row.amountMinor }
      : { account: row.contraAccountId, debit: row.amountMinor };
  if (row.costCenterId !== null) contra.costCenter = row.costCenterId;
  const balance: LineInput =
    rule.balanceSide === 'debit'
      ? { account: row.balanceAccountId, debit: row.amountMinor }
      : { account: row.balanceAccountId, credit: row.amountMinor };
  return rule.balanceSide === 'debit' ? [balance, contra] : [contra, balance];
}

/** The faithful mirror of a line set: debits and credits swapped, everything else carried. */
export function mirrorLinesOf(lines: readonly LineInput[]): LineInput[] {
  return lines.map((l) => {
    const m: LineInput = { account: l.account };
    if (l.debit !== undefined && l.debit > 0) m.credit = l.debit;
    if (l.credit !== undefined && l.credit > 0) m.debit = l.credit;
    if (l.costCenter !== undefined) m.costCenter = l.costCenter;
    return m;
  });
}

/** The formation lines of a provision: Dr expense / Cr provision (OR 960e Abs. 2). */
export function provisionLinesOf(row: { amountMinor: number; provisionAccountId: string; expenseAccountId: string }): LineInput[] {
  return [
    { account: row.expenseAccountId, debit: row.amountMinor },
    { account: row.provisionAccountId, credit: row.amountMinor },
  ];
}

/** The release lines: Dr provision / Cr target (the original expense, or an income account). */
export function releaseLinesOf(row: { amountMinor: number; provisionAccountId: string; targetAccountId: string }): LineInput[] {
  return [
    { account: row.provisionAccountId, debit: row.amountMinor },
    { account: row.targetAccountId, credit: row.amountMinor },
  ];
}

/** The calendar day after `date` (`YYYY-MM-DD`): the reversal date of an accrual. */
export function firstDayAfter(date: string): string {
  const next = new Date(`${date}T00:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}

/** A positive safe integer: the only shape a minor-unit amount may take (P2). */
export function isPositiveMinor(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/** One account row, the columns the accrual verbs read. §H-TENANT: always looked up by workspace. */
export interface AccountRef {
  readonly id: string;
  readonly number: string;
  readonly name: string;
  readonly type: string;
  readonly archived: number;
}

/**
 * Resolve an account by ID or by NUMBER inside the workspace (the spec's "number or id"): a human
 * names `6500`, an agent may hold the id. Returns undefined for either miss.
 */
export function findAccount(ctx: WorkspaceContext, ref: string): AccountRef | undefined {
  return ctx.store.db
    .prepare('SELECT id, number, name, type, archived FROM account WHERE workspace_id = ? AND (id = ? OR number = ?) LIMIT 1')
    .get(ctx.workspaceId, ref, ref) as AccountRef | undefined;
}

export function accountByNumber(ctx: WorkspaceContext, number: string): AccountRef | undefined {
  return ctx.store.db
    .prepare('SELECT id, number, name, type, archived FROM account WHERE workspace_id = ? AND number = ?')
    .get(ctx.workspaceId, number) as AccountRef | undefined;
}

export function accountById(ctx: WorkspaceContext, id: string): AccountRef | undefined {
  return ctx.store.db
    .prepare('SELECT id, number, name, type, archived FROM account WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, id) as AccountRef | undefined;
}

/** A line as the API renders it: the account named, both sides stated, the date it posts on. */
export interface LineView {
  readonly accountId: string;
  readonly accountNumber: string;
  readonly accountName: string;
  readonly debitMinor: number;
  readonly creditMinor: number;
  readonly date: string;
}

/** Decorate `postEntry` lines with their account number and name for the preview and the reads. */
export function describeLines(ctx: WorkspaceContext, lines: readonly LineInput[], date: string): LineView[] {
  return lines.map((l) => {
    const acc = accountById(ctx, l.account);
    return {
      accountId: l.account,
      accountNumber: acc?.number ?? '',
      accountName: acc?.name ?? '',
      debitMinor: l.debit ?? 0,
      creditMinor: l.credit ?? 0,
      date,
    };
  });
}
