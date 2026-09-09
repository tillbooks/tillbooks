/**
 * E02, expense claims (Spesen), US-E02.3-5: the money path. A claim is drafted with lines, submitted,
 * APPROVED (which POSTS its reimbursement liability via A02 `postEntry`), and REIMBURSED (which pays
 * the employee via A14 `recordPayment` and emits the pain.001 as a cloud-tier local artifact).
 *
 * THE MONEY-PATH LAWS, each enforced here and asserted in `test/hr`:
 *
 *  - **Approve posts via A02, append-only and idempotent.** `approveClaim` composes balanced legs
 *    (Dr per-category expense + Dr 1170/1171 Vorsteuer; Cr 2260 Verbindlichkeiten gegenüber Personal
 *    gross, the A17 vendor-bill posting shape with the employee as counterparty but on a DEDICATED
 *    employee-payable account, not 2000 Kreditoren, D95) and hands them to `postEntry`. It NEVER writes a
 *    journal row itself. Re-approving replays the memo (same key) or is refused by the status gate
 *    (any key), so it can never double-post. A wrong approval is corrected by an A02 reversing entry
 *    plus a fresh claim, never a destructive edit: the DB triggers in `schema.ts` freeze a posted
 *    claim and its `posted_entry_id`.
 *  - **Period locks honoured.** Approve pre-checks `ctx.periods.assertOpen(date)` BEFORE the tx and
 *    returns a structured `period_locked`, never a raw DB throw, never a partial post.
 *  - **Reimburse through A14.** `reimburseClaim` delegates to `recordPayment` (outgoing supplier
 *    settlement clearing the employee-payable account via A14's payable-account override, Dr 2260 /
 *    Cr bank, D95), never a hand-rolled payment. It is
 *    idempotent on the claim, so a claim is paid at most once. pain.001 transmission is cloud-tier:
 *    the verb returns `{ transmitted:false, reason:'cloud_tier' }` and a local artifact plan.
 *  - **TX-ATOMICITY.** Every refusal (wrong state, self-approval, locked period, cross-tenant, no
 *    contact, already reimbursed) is a PRE-CHECK before any write, or a throw inside the tx. A
 *    refused approve/reimburse writes zero rows and posts nothing.
 *  - **§H-TENANT** on every read and write; a foreign id gets the same answer as an unknown one.
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { requireString, requireDate, optionalText, optionalId } from '../ledger/inputGuards.js';
import { postEntry } from '../ledger/postEntry.js';
import type { LineInput } from '../ledger/postEntry.js';
import { buildVatLines, computeLineTax } from '../vat/applyVat.js';
import { resolveFxRate, baseCurrencyOf } from '../fx/rates.js';
import { ROLE_ACCOUNT_NUMBER, resolveBankAccount } from '../payments/accounts.js';
import { recordPayment, PAYMENT_INTENTS } from '../payments/payment.js';
import { applySavedView } from '../customization/views.js';
import {
  isExpenseCategory,
  expenseCategoryDef,
  canTransition,
  EXPENSE_CLAIM_SOURCE,
  EXPENSE_CATEGORY_IDS,
} from './enums.js';
import { readClaimRow, readLineRows, readEmployeeRow, claimEcho, holds, ownEmployeeId } from './reads.js';
import type { ClaimRow, LineRow, EmployeeRow } from './reads.js';

/** The receipt threshold (spec §2.3): a line whose base amount exceeds this needs a receipt at submit.
 *  CHF 50.00. A configurable per-workspace `receipt_required_over_rappen` is a documented follow-up;
 *  the code default is the statutory-practice value. */
export const DEFAULT_RECEIPT_REQUIRED_OVER_MINOR = 5000;

/**
 * The employee reimbursement liability lands on a DEDICATED account, not 2000 Kreditoren (D95,
 * 2026-08-05). Approve credits it (the obligation to the employee); reimburse clears it via A14's
 * payable-account override (Dr 2260 / Cr bank). Keeping it off 2000 stops vendor AP aging from
 * commingling employees with suppliers, and gives the employee obligation its own balance-sheet line.
 * 2260 "Verbindlichkeiten gegenüber Personal" is the seeded KMU account (kmuSeed.ts): 2270 is the
 * canonical social-insurance/pension current account, so employee-payable takes the free 2260 slot.
 */
const EMPLOYEE_PAYABLE_ACCOUNT = '2260';
const EXPENSE_ACCOUNT_TYPES: ReadonlySet<string> = new Set(['expense', 'asset']);
/** Accounts a claim line may never book its cost side to: the money, engine-role and payable accounts. */
const RESERVED_EXPENSE_ACCOUNTS: ReadonlySet<string> = new Set([...Object.values(ROLE_ACCOUNT_NUMBER), EMPLOYEE_PAYABLE_ACCOUNT, '1000', '1020']);

/** Abort a write transaction with a structured cause, so nothing is memoised on a rejection. */
class ClaimAbort {
  constructor(public readonly result: Result) {}
}
function runGuarded(body: () => Result): Result {
  try {
    return body();
  } catch (e) {
    if (e instanceof ClaimAbort) return e.result;
    throw e;
  }
}

function isPositiveMinor(v: unknown): v is number {
  return Number.isSafeInteger(v) && (v as number) > 0;
}

interface AccountRow {
  id: string;
  number: string;
  type: string;
  archived: number;
}
function readAccountByNumber(ctx: WorkspaceContext, number: string): AccountRow | undefined {
  return ctx.store.db
    .prepare('SELECT id, number, type, archived FROM account WHERE workspace_id = ? AND number = ?')
    .get(ctx.workspaceId, number) as AccountRow | undefined;
}
function readAccountById(ctx: WorkspaceContext, id: string): AccountRow | undefined {
  return ctx.store.db
    .prepare('SELECT id, number, type, archived FROM account WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, id) as AccountRow | undefined;
}

function employeeRow(ctx: WorkspaceContext, employeeId: string): EmployeeRow | undefined {
  return readEmployeeRow(ctx, employeeId);
}

// --- create ---------------------------------------------------------------------------------------

export interface ClaimCreateInput {
  employeeId: string;
  title: string;
  currency?: string;
  idempotencyKey: string;
}

export function createClaim(ctx: WorkspaceContext, input: ClaimCreateInput): Result {
  const capable = ctx.capabilities.assert('spesen.submit');
  if (!capable.ok) return capable;
  const guard =
    requireString(input.employeeId, 'employeeId') ??
    requireString(input.title, 'title') ??
    requireString(input.idempotencyKey, 'idempotencyKey');
  if (guard) return guard;
  if (employeeRow(ctx, input.employeeId) === undefined) return err('not_found', { employeeId: input.employeeId });

  const scopedKey = JSON.stringify(['expense_claim_create', input.idempotencyKey]);
  const replayed = ctx.store.recallIdempotent<Result>(ctx.workspaceId, scopedKey, 'expense_claim_create');
  if (replayed !== undefined) return replayed;
  const holder = ctx.store.db
    .prepare('SELECT id FROM expense_claim WHERE workspace_id = ? AND idempotency_key = ?')
    .get(ctx.workspaceId, input.idempotencyKey) as { id: string } | undefined;
  if (holder !== undefined) return err('idempotency_key_conflict', { idempotencyKey: input.idempotencyKey, claimId: holder.id });

  return ctx.store.rememberIdempotent(ctx.workspaceId, scopedKey, 'expense_claim_create', () => {
    const id = ctx.ids.next('clm');
    const now = ctx.clock.now();
    const currency = input.currency ?? baseCurrencyOf(ctx);
    ctx.store.db
      .prepare(
        `INSERT INTO expense_claim (id, workspace_id, employee_id, title, status, currency, idempotency_key, created_by, created_at)
         VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?)`,
      )
      .run(id, ctx.workspaceId, input.employeeId, input.title, currency, input.idempotencyKey, ctx.actor, now);
    ctx.audit.record({ entityKind: 'expense_claim', entityId: id, action: 'create', actor: ctx.actor, at: now });
    return ok({ claimId: id, claim: claimEcho(ctx, readClaimRow(ctx, id) as ClaimRow) });
  });
}

// --- line upsert ----------------------------------------------------------------------------------

export interface ClaimLineInput {
  lineId?: string;
  expenseDate: string;
  category: string;
  description?: string;
  amountMinor: number;
  currency?: string;
  fxRate?: string;
  amountBaseMinor?: number;
  taxCode?: string | null;
  expenseAccountId?: string;
  costCenterId?: string;
  receiptDocumentId?: string;
  projectId?: string;
}
export interface LineUpsertInput {
  claimId: string;
  line: ClaimLineInput;
  idempotencyKey: string;
}

/** The tax kinds a business EXPENSE may carry (the A17 side guard): an input, Bezugsteuer or import
 *  code, or none. An output / zero-rated / exempt code describes TURNOVER and is refused. */
const EXPENSE_TAX_KINDS: ReadonlySet<string> = new Set(['input', 'import', 'reverse_charge', 'none']);

function convertMinorOnce(amountMinor: number, rate: string): number {
  // A once-rounded conversion (P2), integer arithmetic. `rate` is base per unit of txn currency.
  const [whole, frac = ''] = rate.split('.');
  const scale = frac.length;
  const scaled = BigInt(whole + frac) ; // rate * 10^scale
  const num = BigInt(amountMinor) * scaled;
  const denom = 10n ** BigInt(scale);
  const half = denom / 2n;
  const q = (num + half) / denom;
  return Number(q);
}

export function upsertLine(ctx: WorkspaceContext, input: LineUpsertInput): Result {
  const capable = ctx.capabilities.assert('spesen.submit');
  if (!capable.ok) return capable;
  const guard =
    requireString(input.claimId, 'claimId') ??
    requireString(input.idempotencyKey, 'idempotencyKey') ??
    requireDate(input.line?.expenseDate, 'expenseDate') ??
    optionalText(input.line?.description, 'description') ??
    optionalId(input.line?.expenseAccountId, 'expenseAccountId') ??
    optionalId(input.line?.costCenterId, 'costCenterId') ??
    optionalId(input.line?.receiptDocumentId, 'receiptDocumentId') ??
    optionalId(input.line?.projectId, 'projectId');
  if (guard) return guard;
  const line = input.line;
  if (!isExpenseCategory(line.category)) return err('invalid_category', { field: 'category', allowed: [...EXPENSE_CATEGORY_IDS] });
  if (!isPositiveMinor(line.amountMinor)) return err('invalid_input', { field: 'amountMinor' });

  const claim = readClaimRow(ctx, input.claimId);
  if (claim === undefined) return err('not_found', { claimId: input.claimId });
  if (claim.status !== 'draft') return err('invalid_transition', { claimId: claim.id, status: claim.status, reason: 'lines are editable only in draft' });

  const base = baseCurrencyOf(ctx);
  const currency = line.currency ?? base;
  if (typeof currency !== 'string') return err('invalid_input', { field: 'currency' });

  // §H-FX: a base-currency line converts nothing; a foreign line converts ONCE at the given or
  // resolved rate and stores the trio (txn amount, base amount, rate).
  let amountBase: number;
  let fxRate: string | null = null;
  if (currency === base) {
    amountBase = line.amountMinor;
  } else {
    const resolution = resolveFxRate(ctx, {
      currency,
      date: line.expenseDate,
      ...(line.fxRate !== undefined ? { explicitRate: line.fxRate } : {}),
    });
    if (!resolution.ok) return resolution;
    fxRate = resolution.resolved.rate;
    amountBase = line.amountBaseMinor ?? convertMinorOnce(line.amountMinor, fxRate);
  }

  // The tax code (§H-VAT-TRACE): resolved ONCE by A05 through the SAME `computeLineTax` that
  // `buildVatLines` will use at post, so the stored trace and the posted figures cannot drift. Only
  // an input-side code is admitted on an expense (an output/exempt code describes turnover).
  let taxCode: string | null = line.taxCode ?? null;
  let taxBase: number | null = null;
  let taxAmount: number | null = null;
  if (taxCode !== null && taxCode !== 'none') {
    const computed = computeLineTax(ctx, { amountMinor: amountBase, amountIsGross: true, taxCode, supplyDate: line.expenseDate });
    if (!computed.ok) return computed;
    if (!EXPENSE_TAX_KINDS.has(computed.kind as string)) {
      return err('needs_input_tax_code', { field: 'taxCode', taxCode, kind: computed.kind });
    }
    taxBase = computed.netMinor as number;
    taxAmount = computed.taxMinor as number;
  } else {
    taxCode = null;
  }

  // The expense account: an explicit one, else the category default number. Validated for type and
  // that it is not a reserved role/money account.
  const explicitAcc = line.expenseAccountId !== undefined ? readAccountById(ctx, line.expenseAccountId) : undefined;
  if (line.expenseAccountId !== undefined && (explicitAcc === undefined || explicitAcc.archived === 1)) {
    return err('needs_account', { field: 'expenseAccountId', reason: explicitAcc === undefined ? 'unknown' : 'archived' });
  }
  const catDef = expenseCategoryDef(line.category);
  const acc = explicitAcc ?? (catDef !== undefined ? readAccountByNumber(ctx, catDef.accountNumber) : undefined);
  if (acc === undefined || acc.archived === 1) {
    return err('needs_account', { field: 'category', reason: 'missing', number: catDef?.accountNumber });
  }
  if (!EXPENSE_ACCOUNT_TYPES.has(acc.type)) {
    return err('needs_account', { field: 'expenseAccountId', reason: 'not_an_expense_or_asset_account', accountNumber: acc.number });
  }
  if (RESERVED_EXPENSE_ACCOUNTS.has(acc.number)) {
    return err('needs_account', { field: 'expenseAccountId', reason: 'reserved_account', accountNumber: acc.number });
  }
  if (line.costCenterId !== undefined) {
    const cc = ctx.store.db
      .prepare('SELECT id, archived FROM cost_center WHERE workspace_id = ? AND id = ?')
      .get(ctx.workspaceId, line.costCenterId) as { id: string; archived: number } | undefined;
    if (cc === undefined || cc.archived === 1) return err('invalid_reference', { field: 'costCenterId' });
  }
  if (line.receiptDocumentId !== undefined) {
    const doc = ctx.store.db
      .prepare('SELECT id FROM stored_file WHERE workspace_id = ? AND id = ?')
      .get(ctx.workspaceId, line.receiptDocumentId) as { id: string } | undefined;
    if (doc === undefined) return err('invalid_reference', { field: 'receiptDocumentId' });
  }

  const scopedKey = JSON.stringify(['expense_line_upsert', input.claimId, input.idempotencyKey]);
  const replayed = ctx.store.recallIdempotent<Result>(ctx.workspaceId, scopedKey, 'expense_line_upsert');
  if (replayed !== undefined) return replayed;

  const existing = line.lineId !== undefined
    ? (ctx.store.db.prepare('SELECT * FROM expense_line WHERE workspace_id = ? AND id = ? AND claim_id = ?').get(ctx.workspaceId, line.lineId, claim.id) as LineRow | undefined)
    : undefined;
  if (line.lineId !== undefined && existing === undefined) return err('not_found', { lineId: line.lineId });

  return ctx.store.rememberIdempotent(ctx.workspaceId, scopedKey, 'expense_line_upsert', () => {
    const now = ctx.clock.now();
    if (existing === undefined) {
      const id = ctx.ids.next('eln');
      ctx.store.db
        .prepare(
          `INSERT INTO expense_line
             (id, workspace_id, claim_id, expense_date, category, description, amount_minor, currency,
              amount_base_minor, fx_rate, tax_code, tax_base_minor, tax_amount_minor, expense_account_id,
              cost_center_id, receipt_document_id, project_id, idempotency_key, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, ctx.workspaceId, claim.id, line.expenseDate, line.category, line.description ?? null, line.amountMinor, currency, amountBase, fxRate, taxCode, taxBase, taxAmount, acc.id, line.costCenterId ?? null, line.receiptDocumentId ?? null, line.projectId ?? null, input.idempotencyKey, now, now);
      return ok({ lineId: id, claim: claimEcho(ctx, claim) });
    }
    ctx.store.db
      .prepare(
        `UPDATE expense_line SET expense_date = ?, category = ?, description = ?, amount_minor = ?, currency = ?,
             amount_base_minor = ?, fx_rate = ?, tax_code = ?, tax_base_minor = ?, tax_amount_minor = ?,
             expense_account_id = ?, cost_center_id = ?, receipt_document_id = ?, project_id = ?, updated_at = ?
          WHERE workspace_id = ? AND id = ?`,
      )
      .run(line.expenseDate, line.category, line.description ?? null, line.amountMinor, currency, amountBase, fxRate, taxCode, taxBase, taxAmount, acc.id, line.costCenterId ?? null, line.receiptDocumentId ?? null, line.projectId ?? null, now, ctx.workspaceId, existing.id);
    return ok({ lineId: existing.id, claim: claimEcho(ctx, claim) });
  });
}

// --- submit ---------------------------------------------------------------------------------------

export interface ClaimSubmitInput {
  claimId: string;
  idempotencyKey: string;
}

export function submitClaim(ctx: WorkspaceContext, input: ClaimSubmitInput): Result {
  const capable = ctx.capabilities.assert('spesen.submit');
  if (!capable.ok) return capable;
  const guard = requireString(input.claimId, 'claimId') ?? requireString(input.idempotencyKey, 'idempotencyKey');
  if (guard) return guard;

  const scopedKey = JSON.stringify(['expense_claim_submit', input.claimId, input.idempotencyKey]);
  const replayed = ctx.store.recallIdempotent<Result>(ctx.workspaceId, scopedKey, 'expense_claim_submit');
  if (replayed !== undefined) return replayed;

  const claim = readClaimRow(ctx, input.claimId);
  if (claim === undefined) return err('not_found', { claimId: input.claimId });
  if (claim.status !== 'draft') return err('invalid_transition', { claimId: claim.id, status: claim.status });

  const lines = readLineRows(ctx, claim.id);
  if (lines.length === 0) return err('empty_claim', { claimId: claim.id });

  const missing = lines.filter((l) => l.amount_base_minor > DEFAULT_RECEIPT_REQUIRED_OVER_MINOR && l.receipt_document_id === null).map((l) => l.id);
  if (missing.length > 0) return err('receipt_required', { claimId: claim.id, lineIds: missing, thresholdMinor: DEFAULT_RECEIPT_REQUIRED_OVER_MINOR });

  const totalBase = lines.reduce((n, l) => n + l.amount_base_minor, 0);

  return ctx.store.rememberIdempotent(ctx.workspaceId, scopedKey, 'expense_claim_submit', () => {
    const now = ctx.clock.now();
    ctx.store.db
      .prepare("UPDATE expense_claim SET status = 'submitted', total_base_minor = ?, submitted_at = ? WHERE workspace_id = ? AND id = ? AND status = 'draft'")
      .run(totalBase, now, ctx.workspaceId, claim.id);
    ctx.audit.record({ entityKind: 'expense_claim', entityId: claim.id, action: 'submit', actor: ctx.actor, at: now });
    return ok({ claimId: claim.id, claim: claimEcho(ctx, readClaimRow(ctx, claim.id) as ClaimRow) });
  });
}

// --- the shared posting-leg builder (approve preview + post read the SAME function) ---------------

interface PostingPlan {
  lines: LineInput[];
  totalBaseMinor: number;
  payableAccountId: string;
}

function buildPostingPlan(ctx: WorkspaceContext, lines: LineRow[]): PostingPlan | Result {
  const payable = readAccountByNumber(ctx, EMPLOYEE_PAYABLE_ACCOUNT);
  if (payable === undefined || payable.archived === 1) {
    return err('needs_account', { role: 'employee_payable', number: EMPLOYEE_PAYABLE_ACCOUNT, reason: payable === undefined ? 'missing' : 'archived' });
  }
  const legs: LineInput[] = [];
  for (const l of lines) {
    if (l.expense_account_id === null) return err('needs_account', { field: 'expenseAccountId', lineId: l.id, reason: 'missing' });
    let vatLines: LineInput[];
    try {
      vatLines = buildVatLines(ctx, {
        counterAccount: payable.id,
        revenueOrExpenseAccount: l.expense_account_id,
        amountMinor: l.amount_base_minor,
        amountIsGross: true,
        taxCode: l.tax_code,
        direction: 'input',
        supplyDate: l.expense_date,
        ...(l.cost_center_id !== null ? { costCenterId: l.cost_center_id } : {}),
      }) as unknown as LineInput[];
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (message.startsWith('missing_vat_account:')) {
        return err('needs_account', { role: 'vatAccount', number: message.split(': ')[1] ?? null, reason: 'missing' });
      }
      return err('vat_build_failed', { reason: message, lineId: l.id });
    }
    legs.push(...vatLines);
  }
  const totalBaseMinor = lines.reduce((n, l) => n + l.amount_base_minor, 0);
  return { lines: legs, totalBaseMinor, payableAccountId: payable.id };
}

/** Read the posted entry back and refuse anything that is not the posting we planned (§H-AUDIT). */
function verifyPosting(ctx: WorkspaceContext, entryId: string, expected: { date: string; payableAccountId: string; totalBaseMinor: number }): Record<string, unknown> | null {
  const entry = ctx.store.db
    .prepare('SELECT status, date, source FROM journal_entry WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, entryId) as { status: string; date: string; source: string } | undefined;
  if (entry === undefined) return { reason: 'entry_absent' };
  if (entry.status !== 'posted') return { reason: 'entry_not_posted', status: entry.status };
  if (entry.source !== EXPENSE_CLAIM_SOURCE) return { reason: 'wrong_source', source: entry.source };
  if (entry.date !== expected.date) return { reason: 'wrong_date', date: entry.date };
  const credited = ctx.store.db
    .prepare('SELECT COALESCE(SUM(base_credit_minor - base_debit_minor), 0) AS net FROM journal_line WHERE entry_id = ? AND account_id = ?')
    .get(entryId, expected.payableAccountId) as { net: number };
  if (credited.net !== expected.totalBaseMinor) return { reason: 'payable_mismatch', credited: credited.net, expected: expected.totalBaseMinor };
  const totals = ctx.store.db
    .prepare('SELECT COALESCE(SUM(base_debit_minor),0) AS d, COALESCE(SUM(base_credit_minor),0) AS c FROM journal_line WHERE entry_id = ?')
    .get(entryId) as { d: number; c: number };
  if (totals.d !== totals.c) return { reason: 'unbalanced', debitMinor: totals.d, creditMinor: totals.c };
  return null;
}

// --- approve (posts via A02) ----------------------------------------------------------------------

export interface ClaimApproveInput {
  claimId: string;
  confirm?: boolean;
  idempotencyKey: string;
}

/** Would approving this claim be a self-approval? True when the actor IS the claimant. */
function isSelfApproval(ctx: WorkspaceContext, claim: ClaimRow, employee: EmployeeRow): boolean {
  return (
    claim.created_by === ctx.actor ||
    (employee.actor_ref !== null && employee.actor_ref === ctx.actor) ||
    (employee.contact_id !== null && employee.contact_id === ctx.actor)
  );
}

export function approveClaim(ctx: WorkspaceContext, input: ClaimApproveInput): Result {
  const capable = ctx.capabilities.assert('spesen.approve');
  if (!capable.ok) return capable;
  const guard = requireString(input.claimId, 'claimId') ?? requireString(input.idempotencyKey, 'idempotencyKey');
  if (guard) return guard;

  const scopedKey = JSON.stringify(['expense_claim_approve', input.claimId, input.idempotencyKey]);
  const replayed = ctx.store.recallIdempotent<Result>(ctx.workspaceId, scopedKey, 'expense_claim_approve');
  if (replayed !== undefined) return replayed;

  const claim = readClaimRow(ctx, input.claimId);
  if (claim === undefined) return err('not_found', { claimId: input.claimId });
  if (claim.status !== 'submitted' || !canTransition('submitted', 'approved')) {
    return err('invalid_transition', { claimId: claim.id, status: claim.status });
  }
  const employee = employeeRow(ctx, claim.employee_id);
  if (employee === undefined) return err('not_found', { employeeId: claim.employee_id });

  // Four-eyes: refused BEFORE any write, and it binds an automation firing exactly as a human call,
  // because the firing runs as its rule author (`ctx.actor`).
  if (isSelfApproval(ctx, claim, employee)) return err('self_approval', { claimId: claim.id });

  // The employee must have a vendor/both contact, because the reimbursement clears the employee-payable
  // account against that counterparty (A14). Refused here so a claim is never approved that cannot be paid.
  const contactErr = requireEmployeeContact(ctx, employee);
  if (contactErr) return contactErr;

  const lines = readLineRows(ctx, claim.id);
  if (lines.length === 0) return err('empty_claim', { claimId: claim.id });
  const plan = buildPostingPlan(ctx, lines);
  if ('ok' in plan) return plan;

  const date = ctx.clock.now().slice(0, 10);

  // §H-PERIOD: pre-checked BEFORE the tx, so a locked period is a structured refusal with the claim
  // untouched, never a raw DB throw and never a partial post.
  const periodOpen = ctx.periods.assertOpen(date);
  if (!periodOpen.ok) return periodOpen;

  const preview = {
    claimId: claim.id,
    date,
    totalBaseMinor: plan.totalBaseMinor,
    lines: plan.lines,
  };
  // P8 draft-gate: without an explicit confirm the preview is returned and NOTHING is written.
  if (input.confirm !== true) return ok({ preview, confirmed: false });

  return runGuarded(() =>
    ctx.store.rememberIdempotent(ctx.workspaceId, scopedKey, 'expense_claim_approve', () => {
      const postingKey = `expense-claim-post-${claim.id}-${ctx.ids.next('eck')}`;
      const posted = postEntry(ctx, {
        date,
        source: EXPENSE_CLAIM_SOURCE,
        description: `Spesen ${claim.title}`,
        idempotencyKey: postingKey,
        lines: plan.lines,
      });
      if (!posted.ok) throw new ClaimAbort(posted);
      const entryId = posted.entryId;
      const mismatch = verifyPosting(ctx, entryId, { date, payableAccountId: plan.payableAccountId, totalBaseMinor: plan.totalBaseMinor });
      if (mismatch !== null) throw new ClaimAbort(err('posting_verification_failed', { claimId: claim.id, entryId, mismatch }));

      const now = ctx.clock.now();
      ctx.store.db
        .prepare("UPDATE expense_claim SET status = 'approved', posted_entry_id = ?, approved_at = ? WHERE workspace_id = ? AND id = ? AND status = 'submitted'")
        .run(entryId, now, ctx.workspaceId, claim.id);
      ctx.audit.record({ entityKind: 'expense_claim', entityId: claim.id, action: 'approve', actor: ctx.actor, at: now });
      return ok({ claimId: claim.id, postedEntryId: entryId, confirmed: true, claim: claimEcho(ctx, readClaimRow(ctx, claim.id) as ClaimRow) });
    }),
  );
}

/** The employee's contact must exist and carry the vendor (or both) role for the A14 settlement. */
function requireEmployeeContact(ctx: WorkspaceContext, employee: EmployeeRow): Result | null {
  if (employee.contact_id === null) {
    return err('needs_employee_contact', { employeeId: employee.id, hint: 'link a contact to the employee (vendor role) so the reimbursement can settle against the employee-payable account' });
  }
  const contact = ctx.store.db
    .prepare('SELECT party_role, archived, merged_into_id FROM contact WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, employee.contact_id) as { party_role: string; archived: number; merged_into_id: string | null } | undefined;
  if (contact === undefined) return err('needs_employee_contact', { employeeId: employee.id, reason: 'unknown' });
  if (contact.merged_into_id !== null) return err('needs_employee_contact', { employeeId: employee.id, reason: 'merged' });
  if (contact.archived === 1) return err('needs_employee_contact', { employeeId: employee.id, reason: 'archived' });
  if (contact.party_role !== 'vendor' && contact.party_role !== 'both') {
    return err('needs_employee_contact', { employeeId: employee.id, reason: 'party_role', partyRole: contact.party_role, hint: 'give the contact the vendor role (contacts_tag)' });
  }
  return null;
}

// --- reject ---------------------------------------------------------------------------------------

export interface ClaimRejectInput {
  claimId: string;
  reason: string;
  idempotencyKey: string;
}

export function rejectClaim(ctx: WorkspaceContext, input: ClaimRejectInput): Result {
  const capable = ctx.capabilities.assert('spesen.approve');
  if (!capable.ok) return capable;
  const guard = requireString(input.claimId, 'claimId') ?? requireString(input.idempotencyKey, 'idempotencyKey');
  if (guard) return guard;
  if (typeof input.reason !== 'string' || input.reason.trim().length === 0) return err('reason_required', { field: 'reason' });

  const scopedKey = JSON.stringify(['expense_claim_reject', input.claimId, input.idempotencyKey]);
  const replayed = ctx.store.recallIdempotent<Result>(ctx.workspaceId, scopedKey, 'expense_claim_reject');
  if (replayed !== undefined) return replayed;

  const claim = readClaimRow(ctx, input.claimId);
  if (claim === undefined) return err('not_found', { claimId: input.claimId });
  // A reject touches only a SUBMITTED claim. An approved (posted) claim is corrected by an A02
  // reversing entry plus a fresh claim, never by a destructive status flip: refused here.
  if (claim.status !== 'submitted') return err('invalid_transition', { claimId: claim.id, status: claim.status });

  return ctx.store.rememberIdempotent(ctx.workspaceId, scopedKey, 'expense_claim_reject', () => {
    const now = ctx.clock.now();
    ctx.store.db
      .prepare("UPDATE expense_claim SET status = 'rejected', reject_reason = ? WHERE workspace_id = ? AND id = ? AND status = 'submitted'")
      .run(input.reason, ctx.workspaceId, claim.id);
    ctx.audit.record({ entityKind: 'expense_claim', entityId: claim.id, action: 'reject', actor: ctx.actor, at: now });
    return ok({ claimId: claim.id, claim: claimEcho(ctx, readClaimRow(ctx, claim.id) as ClaimRow) });
  });
}

// --- reimburse (pays via A14) ---------------------------------------------------------------------

export interface ClaimReimburseInput {
  claimId: string;
  bankAccountId?: string;
  confirm?: boolean;
  idempotencyKey: string;
}

export function reimburseClaim(ctx: WorkspaceContext, input: ClaimReimburseInput): Result {
  const capable = ctx.capabilities.assert('spesen.approve');
  if (!capable.ok) return capable;
  const guard = requireString(input.claimId, 'claimId') ?? requireString(input.idempotencyKey, 'idempotencyKey');
  if (guard) return guard;

  const scopedKey = JSON.stringify(['expense_claim_reimburse', input.claimId, input.idempotencyKey]);
  const replayed = ctx.store.recallIdempotent<Result>(ctx.workspaceId, scopedKey, 'expense_claim_reimburse');
  if (replayed !== undefined) return replayed;

  const claim = readClaimRow(ctx, input.claimId);
  if (claim === undefined) return err('not_found', { claimId: input.claimId });
  // Idempotent on the claim: a reimbursed claim replays its stored payment, never pays twice.
  if (claim.status === 'reimbursed') {
    return ok({ claimId: claim.id, paymentId: claim.payment_id, transmitted: false, reason: 'cloud_tier', alreadyReimbursed: true });
  }
  if (claim.status !== 'approved' || !canTransition('approved', 'reimbursed')) {
    return err('invalid_transition', { claimId: claim.id, status: claim.status });
  }
  const employee = employeeRow(ctx, claim.employee_id);
  if (employee === undefined) return err('not_found', { employeeId: claim.employee_id });
  const contactErr = requireEmployeeContact(ctx, employee);
  if (contactErr) return contactErr;

  if (typeof input.bankAccountId !== 'string' || input.bankAccountId.length === 0) {
    return err('needs_bank_account', { field: 'bankAccountId' });
  }
  // The paying account is a ledger ASSET account (1020 Bankkonto), resolved the A14 way BEFORE the tx
  // so an unusable one is a structured refusal with nothing written.
  const bank = resolveBankAccount(ctx, input.bankAccountId);
  if ('ok' in bank) return bank;

  // The liability A14 must CLEAR is the same one approve credited: the employee-payable account, not
  // 2000 Kreditoren (D95). Resolved BEFORE the tx so a missing/archived account is a structured
  // refusal with nothing written, and passed to A14 as its payable-account override so approve and
  // reimburse settle the SAME account and the employee obligation nets to zero on 2260, never on 2000.
  const employeePayable = readAccountByNumber(ctx, EMPLOYEE_PAYABLE_ACCOUNT);
  if (employeePayable === undefined || employeePayable.archived === 1) {
    return err('needs_account', { role: 'employee_payable', number: EMPLOYEE_PAYABLE_ACCOUNT, reason: employeePayable === undefined ? 'missing' : 'archived' });
  }

  const totalBase = claim.total_base_minor ?? 0;
  if (!isPositiveMinor(totalBase)) return err('invalid_input', { field: 'total_base_minor', reason: 'nothing to reimburse' });

  const date = ctx.clock.now().slice(0, 10);
  const periodOpen = ctx.periods.assertOpen(date);
  if (!periodOpen.ok) return periodOpen;

  // The pain.001 remittance as an OP4 LOCAL ARTIFACT plan. Transmission to a bank is cloud-tier and
  // owner-gated; the OSS core stops here and never emits a bank-transmittable file.
  const artifact = {
    kind: 'pain001_reimbursement',
    claimId: claim.id,
    employeeId: employee.id,
    creditorContactId: employee.contact_id,
    amountMinor: totalBase,
    currency: claim.currency,
  };

  // P8 draft-gate: without confirm, return the payment plan + artifact plan and STOP.
  if (input.confirm !== true) {
    return ok({ preview: { claimId: claim.id, date, amountMinor: totalBase, bankAccountId: input.bankAccountId }, artifact, transmitted: false, reason: 'cloud_tier', confirmed: false });
  }

  return runGuarded(() =>
    ctx.store.rememberIdempotent(ctx.workspaceId, scopedKey, 'expense_claim_reimburse', () => {
      const paymentKey = `expense-claim-reimburse-${claim.id}-${ctx.ids.next('erk')}`;
      const paid = recordPayment(ctx, {
        direction: 'outgoing',
        date,
        amountMinor: totalBase,
        bankAccountId: input.bankAccountId as string,
        counterpartyKind: 'supplier',
        counterpartyId: employee.contact_id as string,
        payableAccountId: employeePayable.id,
        intent: PAYMENT_INTENTS.record,
        idempotencyKey: paymentKey,
      });
      if (!paid.ok) throw new ClaimAbort(paid);
      const paymentId = (paid as unknown as { paymentId?: string }).paymentId ?? null;
      const now = ctx.clock.now();
      ctx.store.db
        .prepare("UPDATE expense_claim SET status = 'reimbursed', payment_id = ?, reimbursed_at = ? WHERE workspace_id = ? AND id = ? AND status = 'approved'")
        .run(paymentId, now, ctx.workspaceId, claim.id);
      ctx.audit.record({ entityKind: 'expense_claim', entityId: claim.id, action: 'reimburse', actor: ctx.actor, at: now });
      return ok({ claimId: claim.id, paymentId, artifact, transmitted: false, reason: 'cloud_tier', confirmed: true, claim: claimEcho(ctx, readClaimRow(ctx, claim.id) as ClaimRow) });
    }),
  );
}

// --- reads ----------------------------------------------------------------------------------------

export interface ClaimListInput {
  status?: string;
  employeeId?: string;
  savedViewId?: string;
}

export function listClaims(ctx: WorkspaceContext, input: ClaimListInput): Result {
  // The G00 saved-view seam merges a stored `expense_claim` view's filters under the explicit ones;
  // the self-scoping filter is applied AFTER, so a view can only ever NARROW to the caller's own
  // claims, never widen (spec §5).
  const viewed = applySavedView(ctx, 'expense_claim', {
    ...(input.status !== undefined ? { status: input.status } : {}),
    ...(input.employeeId !== undefined ? { employeeId: input.employeeId } : {}),
    ...(input.savedViewId !== undefined ? { savedViewId: input.savedViewId } : {}),
  });
  if (!viewed.ok) return viewed;
  const merged = viewed.filter as { status?: string; employeeId?: string };

  const full = holds(ctx, 'hr.manage');
  const approver = holds(ctx, 'spesen.approve');
  let scopedEmployee: string | null | undefined;
  const wide = full || approver;
  if (wide) {
    scopedEmployee = merged.employeeId ?? undefined;
  } else {
    const own = ownEmployeeId(ctx);
    if (own === null) return ok({ claims: [], selfScoped: true });
    if (merged.employeeId !== undefined && merged.employeeId !== own) return ok({ claims: [], selfScoped: true });
    scopedEmployee = own;
  }

  const clauses: string[] = ['workspace_id = ?'];
  const params: unknown[] = [ctx.workspaceId];
  if (scopedEmployee !== undefined) {
    clauses.push('employee_id = ?');
    params.push(scopedEmployee);
  }
  if (typeof merged.status === 'string') {
    clauses.push('status = ?');
    params.push(merged.status);
  }
  const rows = ctx.store.db
    .prepare(`SELECT * FROM expense_claim WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC, id`)
    .all(...params) as ClaimRow[];
  return ok({ claims: rows.map((r) => claimEcho(ctx, r)), selfScoped: !wide });
}

export interface ClaimGetInput {
  claimId: string;
}

export function getClaim(ctx: WorkspaceContext, input: ClaimGetInput): Result {
  const guard = requireString(input.claimId, 'claimId');
  if (guard) return guard;
  const claim = readClaimRow(ctx, input.claimId);
  if (claim === undefined) return err('not_found', { claimId: input.claimId });
  // Self-scope a bare reader to their own claim (spec §3): a non-widened caller reading a
  // colleague's claim id gets `not_found`, never the row.
  if (!holds(ctx, 'hr.manage') && !holds(ctx, 'spesen.approve')) {
    const own = ownEmployeeId(ctx);
    if (own === null || claim.employee_id !== own) return err('not_found', { claimId: input.claimId });
  }
  return ok({ claim: claimEcho(ctx, claim) });
}
