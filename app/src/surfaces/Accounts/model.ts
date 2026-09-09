/**
 * Shared shapes and pure helpers for the Accounts surface (A01, chart of accounts).
 *
 * These mirror the engine's read models (camelCase per the Module 1 interface decision, G00). The
 * browser never imports engine code, so the shapes are re-declared here and kept deliberately
 * tolerant: an unknown extra field is ignored, a missing optional falls back to a safe default.
 */

/** The account-type enum, the single source A02/A08 read (spec A01 §3, §H-ENUM). */
export type AccountType = 'asset' | 'liability' | 'equity' | 'income' | 'expense';

/** The five leading-digit groups the list is bucketed into (spec A01 §6). */
export type AccountGroup = 'aktiven' | 'passiven' | 'eigenkapital' | 'ertrag' | 'aufwand';

/** Fixed render order for the groups, top of the balance sheet down through the P&L. */
export const GROUP_ORDER: readonly AccountGroup[] = [
  'aktiven',
  'passiven',
  'eigenkapital',
  'ertrag',
  'aufwand',
];

/** The type each leading-digit group expects, used only for the non-blocking mismatch warning. */
export const GROUP_EXPECTED_TYPE: Record<AccountGroup, AccountType> = {
  aktiven: 'asset',
  passiven: 'liability',
  eigenkapital: 'equity',
  ertrag: 'income',
  aufwand: 'expense',
};

export const ACCOUNT_TYPES: readonly AccountType[] = [
  'asset',
  'liability',
  'equity',
  'income',
  'expense',
];

export interface Account {
  id: string;
  number: string;
  name: string;
  type: AccountType;
  vatCodeDefault?: string | null;
  costCenterAllowed?: boolean;
  archived?: boolean;
  /** Whether the account carries postings. Drives Archive (true) vs. Delete (false). */
  inUse?: boolean;
}

export interface CostCenter {
  id: string;
  code: string;
  name: string;
  archived?: boolean;
  inUse?: boolean;
}

export interface VatCode {
  code: string;
  label: string;
}

/**
 * Bucket an account by its leading digit (spec A01 §3):
 * 1xxx Aktiven, 2xxx Passiven except 28xx/29xx Eigenkapital, 3xxx Ertrag, 4xxx-8xxx Aufwand.
 */
export function groupOf(number: string): AccountGroup {
  const n = number.trim();
  const first = n[0] ?? '';
  if (first === '1') return 'aktiven';
  if (first === '2') {
    const two = n.slice(0, 2);
    return two === '28' || two === '29' ? 'eigenkapital' : 'passiven';
  }
  if (first === '3') return 'ertrag';
  return 'aufwand';
}

/**
 * True when a row carries postings/lines, so the operator gets Archive, not Delete.
 *
 * `inUse` is the ONLY source: `list_accounts` and `list_cost_centers` both derive it per row with an
 * EXISTS over `journal_line`. This used to fall back to `postingsCount` and `linesCount`, two keys
 * no engine verb has ever sent. Speculative fallbacks are the same defect family as the `label` the
 * payment allocator read off an account row: a shape the Studio invented and the engine never had.
 * A row that arrives without `inUse` is treated as free, which is the conservative reading only
 * because Delete is itself gated by a confirm.
 */
export function isInUse(row: { inUse?: boolean }): boolean {
  return row.inUse === true;
}

/** Case-insensitive match of a query against an account's number or name. */
export function matchesSearch(account: Account, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === '') return true;
  return (
    account.number.toLowerCase().includes(q) || account.name.toLowerCase().includes(q)
  );
}

/** A short, stable idempotency key for agent-safe writes (P8). */
export function idemKey(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
