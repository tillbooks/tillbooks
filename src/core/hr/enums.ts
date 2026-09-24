/**
 * E02's single-source enums (§H-ENUM, Pattern P10): absence kinds and status, the claim state
 * machine and its transitions, and the expense-category map.
 *
 * Each set is declared ONCE here and every code path reads it, so a new absence kind or a new claim
 * transition is one edit with a case+test guard behind it (P10). A02 owns the JOURNAL's status
 * machine and A10 owns the DOCUMENT lifecycle; this file owns E02's own claim lifecycle, which is
 * NOT a document (it posts through A02 but is not an A10 document type), so it carries its own small
 * machine rather than forking A10's.
 */

/** The absence kinds (US-E02.2). Health data (`sick`) is governed by revDSG Art. 5 lit. c Ziff. 2. */
export const ABSENCE_KINDS = ['vacation', 'sick', 'other'] as const;
export type AbsenceKind = (typeof ABSENCE_KINDS)[number];
export function isAbsenceKind(v: unknown): v is AbsenceKind {
  return typeof v === 'string' && (ABSENCE_KINDS as readonly string[]).includes(v);
}

/** An absence is recorded, or cancelled. Cancelled is a status flip (append-only), never a delete. */
export const ABSENCE_STATUSES = ['recorded', 'cancelled'] as const;
export type AbsenceStatus = (typeof ABSENCE_STATUSES)[number];

/**
 * The expense-claim lifecycle. `draft -> submitted -> approved -> reimbursed`, with `submitted ->
 * rejected` and `draft -> cancelled` as the two terminal side exits.
 *
 * `approved` is the state a claim is in once its reimbursement liability has POSTED via A02 but the
 * employee has not yet been paid; `reimbursed` is set once A14 has recorded the outgoing payment.
 * `rejected` and `cancelled` are terminal. `reimbursed` is terminal for every FORWARD verb, but it is
 * NOT sealed against the system: reversing the reimbursement PAYMENT (A14 reverse_payment) reopens the
 * 2260 liability and walks the claim back `reimbursed -> approved` (the state that reopened liability
 * matches), the one exception the `expense_claim_terminal_is_one_way` trigger and D95 admit. No verb
 * leaves `reimbursed`; only the payment reversal does, so `CLAIM_TRANSITIONS` below stays clean.
 */
export const CLAIM_STATUSES = ['draft', 'submitted', 'approved', 'reimbursed', 'rejected', 'cancelled'] as const;
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];

/** The terminal states no FORWARD verb can leave (mirrored by a DB trigger in `schema.ts`). The one
 *  system exception is `reimbursed -> approved` on a payment reversal (D95); see CLAIM_STATUSES above. */
export const TERMINAL_CLAIM_STATUSES: ReadonlySet<ClaimStatus> = new Set<ClaimStatus>([
  'reimbursed',
  'rejected',
  'cancelled',
]);

/** The allowed transitions, single-sourced so a verb cannot invent one A10-style. */
const CLAIM_TRANSITIONS: Readonly<Record<ClaimStatus, readonly ClaimStatus[]>> = {
  draft: ['submitted', 'cancelled'],
  submitted: ['approved', 'rejected'],
  approved: ['reimbursed'],
  reimbursed: [],
  rejected: [],
  cancelled: [],
};

export function canTransition(from: ClaimStatus, to: ClaimStatus): boolean {
  return (CLAIM_TRANSITIONS[from] ?? []).includes(to);
}

/**
 * The expense-category map (§H-ENUM value set): each category resolves to a default expense account
 * NUMBER and an optional default input-VAT `tax_code`. The MAPPING is workspace-configurable (spec
 * §6b, OP10 "configurable enums that are not legal states"); the category value SET is fixed. The
 * account numbers are the shipped KMU seed (`src/core/accounts/kmuSeed.ts`), so a claim approves out
 * of the box; a workspace that renamed its chart resolves a different account explicitly per line.
 *
 * `defaultTaxCode` is null on every category on purpose: input VAT on an expense is only reclaimable
 * when a valid Swiss VAT receipt (MWSTG Art. 26) backs the line, which the operator asserts by
 * naming an input code per line. Defaulting a code onto every line would claim Vorsteuer the receipt
 * may not support, so the safe default is "no VAT" and the operator opts in.
 */
export interface ExpenseCategoryDef {
  readonly category: string;
  readonly accountNumber: string;
  readonly defaultTaxCode: string | null;
}

export const EXPENSE_CATEGORIES: readonly ExpenseCategoryDef[] = [
  { category: 'travel', accountNumber: '6200', defaultTaxCode: null },
  { category: 'meals', accountNumber: '6700', defaultTaxCode: null },
  { category: 'supplies', accountNumber: '6500', defaultTaxCode: null },
  { category: 'it', accountNumber: '6570', defaultTaxCode: null },
  { category: 'other', accountNumber: '6700', defaultTaxCode: null },
];

const CATEGORY_BY_ID: ReadonlyMap<string, ExpenseCategoryDef> = new Map(
  EXPENSE_CATEGORIES.map((c) => [c.category, c]),
);

export const EXPENSE_CATEGORY_IDS: readonly string[] = EXPENSE_CATEGORIES.map((c) => c.category);

export function isExpenseCategory(v: unknown): v is string {
  return typeof v === 'string' && CATEGORY_BY_ID.has(v);
}

export function expenseCategoryDef(category: unknown): ExpenseCategoryDef | undefined {
  return typeof category === 'string' ? CATEGORY_BY_ID.get(category) : undefined;
}

/** `journal_entry.source` for an approved claim's posting: its own source, deliberately NOT in
 *  `POST_ENTRY_SOURCES` (the agent-facing allow-list on `post_entry`), so P3 is structural: a caller
 *  cannot mint an entry claiming to be an expense-claim posting without a claim behind it. */
export const EXPENSE_CLAIM_SOURCE = 'expense_claim';
