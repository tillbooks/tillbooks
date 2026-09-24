/**
 * A14's account resolution: every posting account is looked up by NUMBER, never hard-coded into a
 * leg (spec §3, "all account numbers resolve through A01/A05 config").
 *
 * The KMU chart numbers are the Swiss standard (A01's `kmuSeed.ts` owns the labels and the
 * provenance). This module maps a posting ROLE to the number that plays it, so a leg is built from
 * a role and the number is data in one table rather than a literal in five branches.
 *
 * When a role's account does not exist in the workspace, the answer is a structured
 * `needs_account` naming the role AND the number, never a silent substitution. Every role below is
 * in A01's core seed, so a fresh workspace can settle, discount, write off and take a currency
 * difference without adding anything by hand; the rejection exists for a workspace that has
 * ARCHIVED or renumbered one of them, and it says exactly which number to restore. Quietly
 * absorbing a write-off into 3800 Skonti would misstate a receivable loss as a discount granted,
 * and quietly inventing an account would put a number in the chart that the Treuhänder never
 * approved.
 */

import type { WorkspaceContext } from '../context.js';
import { err } from '../result.js';
import type { Result } from '../result.js';

/** The posting roles A14 needs. Each maps to exactly one KMU account number. */
export type AccountRole =
  | 'receivable'
  | 'payable'
  | 'salesSkonto'
  | 'purchaseSkonto'
  | 'outputVat'
  | 'inputVat'
  | 'inputVatInvestment'
  | 'writeOff'
  | 'salesFxRealised'
  | 'purchaseFxRealised';

/**
 * Role to KMU account number. The Skonto roles and the currency-difference roles differ by SIDE,
 * because MWSTG Art. 41 Abs. 1 keys the supplier-side correction on receipt and Abs. 2 keys the
 * customer-side one on payment: they are separate postings on different events, not a mirror. The
 * chart says the same thing structurally, pairing 3800/4900 and 3806/4906 across the
 * Erlösminderungen and the Einkaufspreisminderungen.
 *
 * `buildLegs` picks that side from the SAME predicate it picks `receivable` or `payable` from, so a
 * reduction can never end up on the opposite side of the books from the position it reduces.
 *
 * The VAT roles are chosen differently, and deliberately: NOT from the counterparty but from the
 * TAX CODE the corrected line carries. The code is what says whether the tax was charged or
 * reclaimed, A05 routes a code to its account by exactly that rule, and A02's post-boundary gate
 * recomputes the expected movement from the code and rejects the entry when the two disagree
 * (`vat_trace_unreconciled`). Deriving the VAT account from anything else, including a counterparty
 * label a caller can state freely, produces an entry that cannot post.
 */
export const ROLE_ACCOUNT_NUMBER: Readonly<Record<AccountRole, string>> = {
  receivable: '1100',
  payable: '2000',
  salesSkonto: '3800',
  purchaseSkonto: '4900',
  outputVat: '2200',
  // Vorsteuer, split the way the ESTV MWST-Abrechnung splits it: Ziffer 400 (Material, Waren,
  // Dienstleistungen) and Ziffer 405 (Investitionen). A code's form line picks between them, so a
  // Skonto on an investment purchase corrects the line it was claimed on.
  inputVat: '1170',
  inputVatInvestment: '1171',
  // 3805 Verluste Forderungen, Veränderung Wertberichtigungen. A residual a customer never paid is
  // a LOSS on the receivable, which is a different economic event from a discount granted, so it
  // does not go through 3800.
  writeOff: '3805',
  // The REALISED currency difference on settlement (§H-FX), 3806 and 4906 Kursdifferenzen. A14
  // settles TRADE positions, so the difference is operating and belongs in the same two blocks the
  // Skonti do. Both accounts are bidirectional by convention, so a gain and a loss net in one place
  // under a name that claims neither. 6949 Währungsverluste stays where it belongs: A22 revalues
  // FINANCIAL positions at period end, which is a different event on a different account.
  salesFxRealised: '3806',
  purchaseFxRealised: '4906',
};

/**
 * The VAT account a correction belongs on, from the TAX CODE and nothing else.
 *
 * This is A05's own routing rule (`applyVat`: output tax to 2200, deductible input tax to 1170, or
 * to 1171 when the code reports on ESTV Ziffer 405), restated here so A14's Skonto leg and A02's
 * post-boundary gate cannot drift apart. The gate recomputes the expected movement from the code on
 * the traced line, so a correction booked anywhere else is refused as `vat_trace_unreconciled`.
 *
 * Null means "A14 does not model a Skonto on this code". Bezugsteuer books a PAIRED output and
 * input leg, Einfuhrsteuer books an assessed one, and a non-deductible input code folds the tax
 * into the cost instead of splitting it out. Correcting any of those through a single leg would
 * misreport the Abrechnung, so the caller is refused rather than guessed at.
 */
export function vatRoleFor(kind: string, formLine: string | null, deductible: boolean): AccountRole | null {
  if (kind === 'output') return 'outputVat';
  if (kind === 'input' && deductible) return formLine === '405' ? 'inputVatInvestment' : 'inputVat';
  return null;
}

export interface ResolvedAccount {
  id: string;
  number: string;
  label: string;
}

interface AccountRow {
  id: string;
  number: string;
  name: string;
  archived: number;
}

function readByNumber(ctx: WorkspaceContext, number: string): AccountRow | undefined {
  return ctx.store.db
    .prepare('SELECT id, number, name, archived FROM account WHERE workspace_id = ? AND number = ?')
    .get(ctx.workspaceId, number) as AccountRow | undefined;
}

/** Resolve one role, or `err('needs_account', { role, number })`. §H-TENANT on the lookup. */
export function resolveRole(ctx: WorkspaceContext, role: AccountRole): ResolvedAccount | Result {
  const number = ROLE_ACCOUNT_NUMBER[role];
  const row = readByNumber(ctx, number);
  if (row === undefined || row.archived === 1) {
    return err('needs_account', { role, number, reason: row === undefined ? 'missing' : 'archived' });
  }
  return { id: row.id, number: row.number, label: row.name };
}

/** True when a resolution came back as a rejection rather than an account. */
export function isRejection(value: ResolvedAccount | Result): value is Result {
  return 'ok' in value;
}

/**
 * Accounts the cash leg may never land on (A17-R5), by NUMBER, because the type check below cannot
 * draw this line: 1100 Debitoren is an `asset` row exactly as 1020 Bankkonto is, and a payment
 * whose "bank" leg lands on 1100 corrupts A16's reconciliation the same way a bill booked there
 * does (A17-C3's own reasoning, applied to this resolver). The set is the role map (every number a
 * settlement plan books as a CONSEQUENCE: the counter accounts, the VAT accounts, the Skonto,
 * write-off and FX corrections) plus the two claims accounts from C3's block, 1109 Wertberichtigung
 * and 1176 Verrechnungssteuer-Guthaben. The two MONEY accounts of that block, 1000 Kasse and 1020
 * Bankkonto, are deliberately absent: they are exactly what this resolver exists to resolve.
 */
const RESERVED_CASH_ACCOUNTS: ReadonlySet<string> = new Set([
  ...Object.values(ROLE_ACCOUNT_NUMBER),
  '1109',
  '1176',
]);

/**
 * Resolve the account the money moved on. `needs_bank_account` is a P9 scope-degradation, and it is
 * deliberately the SAME code whether no account was named, the named one does not exist in this
 * workspace, or it is archived: an id must never be probeable across tenants, and the caller's
 * next action ("give me a usable account") is identical in all three cases.
 */
export function resolveBankAccount(
  ctx: WorkspaceContext,
  bankAccountId: unknown,
): ResolvedAccount | Result {
  if (typeof bankAccountId !== 'string' || bankAccountId.length === 0) {
    return err('needs_bank_account', { reason: 'missing' });
  }
  const row = ctx.store.db
    .prepare('SELECT id, number, name, archived, type FROM account WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, bankAccountId) as (AccountRow & { type: string }) | undefined;
  if (row === undefined || row.archived === 1) {
    return err('needs_bank_account', { reason: 'unusable' });
  }
  // Money moves on an asset account (1000 Kasse, 1020 Bankkonto). Booking a payment's cash leg
  // against a revenue or expense account is not a payment, it is a journal entry, and A02 owns it.
  if (row.type !== 'asset') {
    return err('needs_bank_account', { reason: 'not_an_asset_account', accountNumber: row.number });
  }
  if (RESERVED_CASH_ACCOUNTS.has(row.number)) {
    return err('needs_bank_account', { reason: 'reserved_account', accountNumber: row.number });
  }
  return { id: row.id, number: row.number, label: row.name };
}
