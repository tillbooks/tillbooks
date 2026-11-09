/**
 * A01 account management.
 *
 * Accounts are born with the KMU seed and then created, renamed, archived, or deleted. An account
 * that carries postings is never deleted or re-typed (it archives); only an account that never became
 * part of the ledger can be hard-deleted. `number` and `type` are frozen (updateAccount cannot touch
 * them), so the §H-ENUM account-type mapping the whole suite reads stays stable.
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { requireString, optionalText } from '../ledger/inputGuards.js';
import { applySavedView } from '../customization/views.js';
import { ACCOUNT_TYPES, KMU_CORE_SEED, STATEMENT_VOUCHER_SEED_NUMBERS } from './kmuSeed.js';
import { topUpChartOfAccounts } from './topUp.js';
import type { AccountType } from './kmuSeed.js';

interface AccountRow {
  id: string;
  workspace_id: string;
  number: string;
  name: string;
  type: string;
  vat_code_default: string | null;
  cost_center_allowed: number;
  archived: number;
  statement_is_voucher: number | null;
}

/**
 * D142 amendment: the account numbers whose "Beleg = Kontoauszug" is ON by default, checked against the
 * seed at load so the list can never name an account the chart does not ship.
 */
export const STATEMENT_VOUCHER_DEFAULT_NUMBERS: readonly string[] = STATEMENT_VOUCHER_SEED_NUMBERS.filter((n) =>
  KMU_CORE_SEED.some((a) => a.number === n),
);

/**
 * SQL: is the account under alias `a` one whose voucher is the bank statement? An explicit setting on
 * the account wins; NULL falls back to the seed default. The ONE predicate every reader uses.
 */
export function STATEMENT_IS_VOUCHER_SQL(a: string): string {
  const defaults = STATEMENT_VOUCHER_DEFAULT_NUMBERS.map((n) => `'${n.replace(/'/g, "''")}'`).join(', ');
  return `(COALESCE(${a}.statement_is_voucher, CASE WHEN ${a}.number IN (${defaults === '' ? "''" : defaults}) THEN 1 ELSE 0 END) = 1)`;
}

function statementIsVoucher(row: Pick<AccountRow, 'statement_is_voucher' | 'number'>): boolean {
  if (row.statement_is_voucher !== null) return row.statement_is_voucher === 1;
  return STATEMENT_VOUCHER_DEFAULT_NUMBERS.includes(row.number);
}

function mapAccount(row: AccountRow) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    number: row.number,
    name: row.name,
    type: row.type,
    vatCodeDefault: row.vat_code_default,
    costCenterAllowed: row.cost_center_allowed === 1,
    archived: row.archived === 1,
    /** D142 amendment: "Beleg = Kontoauszug", the effective value (the account's own, else the seed default). */
    statementIsVoucher: statementIsVoucher(row),
  };
}

export function seedChartOfAccounts(ctx: WorkspaceContext): Result {
  // The birth seed is the whole-chart case of the top-up the store migration also runs for a
  // workspace born before a seed account existed (`./topUp.ts`): one insert shape, two callers.
  ctx.store.tx(() => {
    topUpChartOfAccounts(ctx.store.db, ctx.workspaceId, ctx.ids);
  });
  const count = ctx.store.db
    .prepare('SELECT COUNT(*) AS c FROM account WHERE workspace_id = ?')
    .get(ctx.workspaceId) as { c: number };
  return ok({ count: count.c });
}

export interface CreateAccountInput {
  number: string;
  name: string;
  type: string;
  vatCodeDefault?: string;
  costCenterAllowed?: boolean;
  idempotencyKey?: string;
}

export function createAccount(ctx: WorkspaceContext, input: CreateAccountInput): Result {
  const guard =
    requireString(input.number, 'number') ??
    requireString(input.name, 'name') ??
    optionalText(input.vatCodeDefault, 'vatCodeDefault');
  if (guard) return guard;
  if (!ACCOUNT_TYPES.has(input.type as AccountType)) {
    return err('invalid_type', { type: input.type });
  }

  // Replay a completed create BEFORE the state-dependent duplicate guard (§H-IDEMPOTENT: re-submitting
  // a key returns the ORIGINAL result). Without this the guard fires on the account the first call
  // itself wrote, so a retried request, exactly what an idempotency key exists to make safe, came back
  // as `duplicate_number`. That is the worst possible answer to a retry: the caller cannot tell its own
  // successful write from someone else's collision. Same order postEntry uses.
  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    const replayed = ctx.store.recallIdempotent<Result>(ctx.workspaceId, input.idempotencyKey, 'create_account');
    if (replayed !== undefined) return replayed;
  }

  const existing = ctx.store.db
    .prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?')
    .get(ctx.workspaceId, input.number) as { id: string } | undefined;
  if (existing !== undefined) {
    return err('duplicate_number', { number: input.number });
  }

  const run = (): Result => {
    const id = ctx.ids.next('acc');
    ctx.store.db
      .prepare(
        `INSERT INTO account (id, workspace_id, number, name, type, vat_code_default, cost_center_allowed)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, ctx.workspaceId, input.number, input.name, input.type, input.vatCodeDefault ?? null, input.costCenterAllowed ? 1 : 0);
    return ok({ accountId: id });
  };
  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'create_account', run);
  }
  return run();
}

export function updateAccount(
  ctx: WorkspaceContext,
  input: { accountId: string; name?: string; vatCodeDefault?: string; costCenterAllowed?: boolean; statementIsVoucher?: boolean },
): Result {
  const guard = requireString(input.accountId, 'accountId') ?? optionalText(input.name, 'name');
  if (guard) return guard;

  const row = ctx.store.db
    .prepare('SELECT id FROM account WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, input.accountId) as { id: string } | undefined;
  if (row === undefined) return err('not_found', { accountId: input.accountId });

  const sets: string[] = [];
  const params: (string | number | null)[] = [];
  if (input.name !== undefined) {
    sets.push('name = ?');
    params.push(input.name);
  }
  if (input.vatCodeDefault !== undefined) {
    sets.push('vat_code_default = ?');
    params.push(input.vatCodeDefault);
  }
  if (input.costCenterAllowed !== undefined) {
    sets.push('cost_center_allowed = ?');
    params.push(input.costCenterAllowed ? 1 : 0);
  }
  // D142 amendment: "Beleg = Kontoauszug", set on the account with its own edit right.
  if (input.statementIsVoucher !== undefined) {
    if (typeof input.statementIsVoucher !== 'boolean') return err('invalid_input', { field: 'statementIsVoucher' });
    sets.push('statement_is_voucher = ?');
    params.push(input.statementIsVoucher ? 1 : 0);
  }
  if (sets.length > 0) {
    ctx.store.db.prepare(`UPDATE account SET ${sets.join(', ')} WHERE id = ?`).run(...params, input.accountId);
  }
  return ok();
}

export function archiveAccount(ctx: WorkspaceContext, input: { accountId: string }): Result {
  const guard = requireString(input.accountId, 'accountId');
  if (guard) return guard;
  const result = ctx.store.db
    .prepare('UPDATE account SET archived = 1 WHERE workspace_id = ? AND id = ?')
    .run(ctx.workspaceId, input.accountId);
  if (result.changes === 0) return err('not_found', { accountId: input.accountId });
  return ok();
}

export function unarchiveAccount(ctx: WorkspaceContext, input: { accountId: string }): Result {
  const guard = requireString(input.accountId, 'accountId');
  if (guard) return guard;
  // The inverse of archiveAccount: clear the soft flag. Idempotent (un-archiving an already-active
  // account is a no-op ok, since the row still matches), and an unknown id is a structured not_found.
  const result = ctx.store.db
    .prepare('UPDATE account SET archived = 0 WHERE workspace_id = ? AND id = ?')
    .run(ctx.workspaceId, input.accountId);
  if (result.changes === 0) return err('not_found', { accountId: input.accountId });
  return ok();
}

export function deleteAccount(
  ctx: WorkspaceContext,
  input: { accountId: string; idempotencyKey?: string },
): Result {
  const guard = requireString(input.accountId, 'accountId');
  if (guard) return guard;

  const used = ctx.store.db
    .prepare('SELECT COUNT(*) AS c FROM journal_line WHERE account_id = ?')
    .get(input.accountId) as { c: number };
  if (used.c > 0) return err('account_in_use', { accountId: input.accountId });

  const run = (): Result => {
    ctx.store.db.prepare('DELETE FROM account WHERE workspace_id = ? AND id = ?').run(ctx.workspaceId, input.accountId);
    return ok();
  };
  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'delete_account', run);
  }
  return run();
}

export function listAccounts(
  ctx: WorkspaceContext,
  filter: { search?: string; includeArchived?: boolean; savedViewId?: string } = {},
): Result {
  // The G00 seam, one unconditional call, exactly as `listDocuments` makes it (F5 retrofit: the
  // `account` kind could store views that no verb applied).
  const viewed = applySavedView(ctx, 'account', filter);
  if (!viewed.ok) return viewed;
  filter = viewed.filter;
  const guard = optionalText(filter.search, 'search');
  if (guard) return guard;

  const clauses = ['workspace_id = ?'];
  const params: string[] = [ctx.workspaceId];
  if (!filter.includeArchived) clauses.push('archived = 0');
  if (filter.search !== undefined && filter.search.length > 0) {
    clauses.push('(number LIKE ? OR name LIKE ?)');
    params.push(`%${filter.search}%`, `%${filter.search}%`);
  }
  // `in_use` rides the list read because the GUI decides Archive-XOR-Delete per row from it: an
  // account the journal touches archives, an untouched one deletes. Without it every row fell
  // back to "not in use" and the destructive path was always offered (found by the browser flows,
  // invisible to fixtures that hand-set the flag). EXISTS per row over the journal_line index.
  const rows = ctx.store.db
    .prepare(
      `SELECT account.*, EXISTS(SELECT 1 FROM journal_line WHERE journal_line.account_id = account.id) AS in_use
       FROM account WHERE ${clauses.join(' AND ')} ORDER BY number`,
    )
    .all(...params) as (AccountRow & { in_use: number })[];
  return ok({ accounts: rows.map((row) => ({ ...mapAccount(row), inUse: row.in_use === 1 })) });
}
