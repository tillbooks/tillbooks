/**
 * The A38 editor's pure model: the two engine enums it mirrors, the amount parser, and the LIVE
 * preview of the lines a draft will carry.
 *
 * `ACCRUAL_KINDS` and `PROVISION_REASONS` mirror `src/core/accruals/lines.ts` under the
 * `studio-mirrors-engine-enums` guard: the Studio offers no kind the engine would refuse and hides
 * none it would accept. The kind RULES (which balance-sheet account a kind lands on, and which side)
 * are mirrored too, for one reason only: the drawer renders the lines AS YOU TYPE, before a draft
 * exists, and OR 958b fixes the four kinds and their statutory headings (1300 / 2300), so the rule
 * is not a policy that can drift. The moment the draft is saved the list renders the ENGINE's own
 * lines (`accrual_create` answers them from `accrualLinesOf`), so the preview is a convenience and
 * the engine stays the truth.
 *
 * Money is integer minor units on the wire (P11); the parser turns the francs a person types into
 * Rappen exactly, never through a float multiplication.
 */

/** The four OR 958b kinds, in the engine's order. */
export const ACCRUAL_KINDS = ['prepaid_expense', 'accrued_income', 'accrued_expense', 'deferred_income'] as const;
export type AccrualKind = (typeof ACCRUAL_KINDS)[number];

/** The OR 960e reason list, in the engine's order. */
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

/** Which P&L type the contra account must have, and where the balance account sits, per kind. */
export const ACCRUAL_KIND_RULES: Readonly<Record<AccrualKind, { balanceNumber: '1300' | '2300'; contraType: 'income' | 'expense'; balanceSide: 'debit' | 'credit' }>> = {
  prepaid_expense: { balanceNumber: '1300', contraType: 'expense', balanceSide: 'debit' },
  accrued_income: { balanceNumber: '1300', contraType: 'income', balanceSide: 'debit' },
  accrued_expense: { balanceNumber: '2300', contraType: 'expense', balanceSide: 'credit' },
  deferred_income: { balanceNumber: '2300', contraType: 'income', balanceSide: 'credit' },
};

/** One account as `list_accounts` sends it (the keys the editor reads). */
export interface PickerAccount {
  id: string;
  number: string;
  name: string;
  type: string;
  archived: boolean;
}

/** One preview line: what the drawer renders under the form. */
export interface PreviewLine {
  accountNumber: string;
  accountName: string;
  debitMinor: number;
  creditMinor: number;
  date: string;
}

/**
 * Francs typed by a person, to integer Rappen. Accepts `1800`, `1800.50`, `1'800.50`, `1 800,50`;
 * refuses more than two decimals, a sign, or anything else, with `null`. Exact by construction: the
 * integer and the fraction are parsed separately and combined as integers.
 */
export function parseAmountToMinor(text: string): number | null {
  const cleaned = text.replace(/['’\s]/g, '').replace(',', '.');
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(cleaned);
  if (m === null) return null;
  const whole = Number(m[1]);
  const frac = m[2] === undefined ? 0 : Number(m[2].padEnd(2, '0'));
  const minor = whole * 100 + frac;
  return Number.isSafeInteger(minor) && minor > 0 ? minor : null;
}

/** The calendar day after an ISO date, the reversal date of an accrual. */
export function dayAfter(isoDate: string): string {
  const next = new Date(`${isoDate}T00:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}

/** The accrual's two lines and their two reversal lines, from the kind rule, for the live preview. */
export function previewAccrualLines(
  kind: AccrualKind,
  amountMinor: number,
  contra: PickerAccount | null,
  balance: PickerAccount | null,
  periodEnd: string,
): { lines: PreviewLine[]; reversalLines: PreviewLine[] } {
  const rule = ACCRUAL_KIND_RULES[kind];
  const balanceLine: PreviewLine = {
    accountNumber: balance?.number ?? rule.balanceNumber,
    accountName: balance?.name ?? '',
    debitMinor: rule.balanceSide === 'debit' ? amountMinor : 0,
    creditMinor: rule.balanceSide === 'credit' ? amountMinor : 0,
    date: periodEnd,
  };
  const contraLine: PreviewLine = {
    accountNumber: contra?.number ?? '',
    accountName: contra?.name ?? '',
    debitMinor: rule.balanceSide === 'credit' ? amountMinor : 0,
    creditMinor: rule.balanceSide === 'debit' ? amountMinor : 0,
    date: periodEnd,
  };
  const lines = rule.balanceSide === 'debit' ? [balanceLine, contraLine] : [contraLine, balanceLine];
  const reversalDate = dayAfter(periodEnd);
  const reversalLines = lines.map((l) => ({ ...l, debitMinor: l.creditMinor, creditMinor: l.debitMinor, date: reversalDate }));
  return { lines, reversalLines };
}

/** The provision's formation lines: Dr expense / Cr provision. */
export function previewProvisionLines(
  amountMinor: number,
  provisionAccount: PickerAccount | null,
  expenseAccount: PickerAccount | null,
  periodEnd: string,
): PreviewLine[] {
  return [
    { accountNumber: expenseAccount?.number ?? '', accountName: expenseAccount?.name ?? '', debitMinor: amountMinor, creditMinor: 0, date: periodEnd },
    { accountNumber: provisionAccount?.number ?? '', accountName: provisionAccount?.name ?? '', debitMinor: 0, creditMinor: amountMinor, date: periodEnd },
  ];
}

/** A provision account: 2330, 2600, or any liability the workspace numbers 23xx / 26xx. */
export function isProvisionAccount(a: PickerAccount): boolean {
  return a.type === 'liability' && (a.number.startsWith('23') || a.number.startsWith('26'));
}

/** Parse the `list_accounts` payload defensively into picker rows, archived ones dropped. */
export function pickerAccountsOf(body: unknown): PickerAccount[] {
  const rows = (body as { accounts?: unknown }).accounts;
  if (!Array.isArray(rows)) return [];
  return rows
    .filter(
      (a): a is PickerAccount =>
        typeof a === 'object' &&
        a !== null &&
        typeof (a as PickerAccount).id === 'string' &&
        typeof (a as PickerAccount).number === 'string' &&
        typeof (a as PickerAccount).name === 'string' &&
        typeof (a as PickerAccount).type === 'string',
    )
    .filter((a) => a.archived !== true)
    .sort((a, b) => (a.number < b.number ? -1 : a.number > b.number ? 1 : 0));
}

/** One accrual row as `accrual_list` / `accrual_create` send it (the fields the list renders). */
export interface AccrualRow {
  id: string;
  kind: AccrualKind;
  periodEnd: string;
  reversalDate: string;
  amountMinor: number;
  contraAccountNumber: string;
  contraAccountName: string;
  balanceAccountNumber: string;
  description: string;
  status: 'draft' | 'posted' | 'reversed' | 'discarded';
  entryId: string | null;
  reversalEntryId: string | null;
  stornoEntryId: string | null;
}

/** One provision row as `provision_list` sends it. */
export interface ProvisionRow {
  id: string;
  reason: ProvisionReason;
  periodEnd: string;
  amountMinor: number;
  provisionAccountNumber: string;
  expenseAccountNumber: string;
  expenseAccountName: string;
  description: string;
  status: 'draft' | 'posted' | 'released' | 'reversed' | 'discarded';
  entryId: string | null;
  openBalanceMinor: number;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

export function accrualRowsOf(body: unknown): AccrualRow[] {
  const rows = (body as { accruals?: unknown }).accruals;
  if (!Array.isArray(rows)) return [];
  return rows.filter((r): r is AccrualRow => isRecord(r) && typeof r.id === 'string' && typeof r.status === 'string' && typeof r.amountMinor === 'number');
}

export function provisionRowsOf(body: unknown): ProvisionRow[] {
  const rows = (body as { provisions?: unknown }).provisions;
  if (!Array.isArray(rows)) return [];
  return rows.filter((r): r is ProvisionRow => isRecord(r) && typeof r.id === 'string' && typeof r.status === 'string' && typeof r.amountMinor === 'number');
}
