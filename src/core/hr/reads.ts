/**
 * E02's row shapes, row readers, and the two things that keep the reads honest: the AHV mask and the
 * self-scoping filter.
 *
 * `holds` is the boolean face of the capability port: the read verbs are permitted broadly (any
 * `hr.read` holder) and then FILTER by what the caller additionally holds, so `assert(...).ok` is
 * read as a fact rather than as a gate. `maskAhv` returns the `756-...` form; the raw number is
 * returned only when the caller passed `includeSensitive` AND holds `hr.sensitive` (`employees.ts`).
 */

import type { WorkspaceContext } from '../context.js';

export function holds(ctx: WorkspaceContext, capability: string): boolean {
  return ctx.capabilities.assert(capability).ok;
}

export interface EmployeeRow {
  id: string;
  workspace_id: string;
  contact_id: string | null;
  actor_ref: string | null;
  first_name: string;
  last_name: string;
  ahv_nr: string | null;
  employment_pct: number;
  starts_on: string;
  ends_on: string | null;
  archived: number;
  idempotency_key: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface AbsenceRow {
  id: string;
  workspace_id: string;
  employee_id: string;
  kind: string;
  from_date: string;
  to_date: string;
  status: string;
  notes: string | null;
  created_at: string;
}

export interface ClaimRow {
  id: string;
  workspace_id: string;
  employee_id: string;
  title: string;
  status: string;
  currency: string;
  total_base_minor: number | null;
  posted_entry_id: string | null;
  reversal_entry_id: string | null;
  payment_id: string | null;
  reject_reason: string | null;
  created_by: string | null;
  created_at: string;
  submitted_at: string | null;
  approved_at: string | null;
  reimbursed_at: string | null;
}

export interface LineRow {
  id: string;
  claim_id: string;
  expense_date: string;
  category: string;
  description: string | null;
  amount_minor: number;
  currency: string;
  amount_base_minor: number;
  fx_rate: string | null;
  tax_code: string | null;
  tax_base_minor: number | null;
  tax_amount_minor: number | null;
  expense_account_id: string | null;
  cost_center_id: string | null;
  receipt_document_id: string | null;
  project_id: string | null;
}

export function readEmployeeRow(ctx: WorkspaceContext, id: unknown): EmployeeRow | undefined {
  if (typeof id !== 'string' || id.length === 0) return undefined;
  return ctx.store.db
    .prepare('SELECT * FROM employee WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, id) as EmployeeRow | undefined;
}

export function readClaimRow(ctx: WorkspaceContext, id: unknown): ClaimRow | undefined {
  if (typeof id !== 'string' || id.length === 0) return undefined;
  return ctx.store.db
    .prepare('SELECT * FROM expense_claim WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, id) as ClaimRow | undefined;
}

export function readLineRows(ctx: WorkspaceContext, claimId: string): LineRow[] {
  return ctx.store.db
    .prepare('SELECT * FROM expense_line WHERE workspace_id = ? AND claim_id = ? ORDER BY created_at, id')
    .all(ctx.workspaceId, claimId) as LineRow[];
}

/** The `756-...` mask. An AHV number is `756.XXXX.XXXX.XX`; the head is not itself the secret. */
export function maskAhv(ahv: string | null): string | null {
  if (ahv === null || ahv.length === 0) return null;
  return '756-...';
}

/**
 * The employee id the caller's own calls belong to, or null. Resolved from `actor_ref` first (the
 * member id an employee is linked to) and from a linked `contact_id` as a fallback, so an actor who
 * IS a contact-linked employee still self-scopes correctly. Null means the caller has no own records,
 * which for a non-`hr.manage` reader is an empty set, never a colleague's row.
 */
export function ownEmployeeId(ctx: WorkspaceContext): string | null {
  const byActor = ctx.store.db
    .prepare('SELECT id FROM employee WHERE workspace_id = ? AND actor_ref = ?')
    .get(ctx.workspaceId, ctx.actor) as { id: string } | undefined;
  if (byActor !== undefined) return byActor.id;
  const byContact = ctx.store.db
    .prepare('SELECT id FROM employee WHERE workspace_id = ? AND contact_id = ?')
    .get(ctx.workspaceId, ctx.actor) as { id: string } | undefined;
  return byContact?.id ?? null;
}

export function employeeEcho(row: EmployeeRow, revealAhv: boolean): Record<string, unknown> {
  return {
    id: row.id,
    contactId: row.contact_id,
    actorRef: row.actor_ref,
    firstName: row.first_name,
    lastName: row.last_name,
    employmentPct: row.employment_pct,
    startsOn: row.starts_on,
    endsOn: row.ends_on,
    archived: row.archived === 1,
    ahvNr: revealAhv ? row.ahv_nr : maskAhv(row.ahv_nr),
    ahvRestricted: !revealAhv && row.ahv_nr !== null && row.ahv_nr.length > 0,
  };
}

export function claimEcho(ctx: WorkspaceContext, row: ClaimRow): Record<string, unknown> {
  const lines = readLineRows(ctx, row.id);
  return {
    id: row.id,
    employeeId: row.employee_id,
    title: row.title,
    status: row.status,
    currency: row.currency,
    totalBaseMinor: row.total_base_minor,
    postedEntryId: row.posted_entry_id,
    reversalEntryId: row.reversal_entry_id,
    paymentId: row.payment_id,
    rejectReason: row.reject_reason,
    submittedAt: row.submitted_at,
    approvedAt: row.approved_at,
    reimbursedAt: row.reimbursed_at,
    lines: lines.map((l) => ({
      id: l.id,
      expenseDate: l.expense_date,
      category: l.category,
      description: l.description,
      amountMinor: l.amount_minor,
      currency: l.currency,
      amountBaseMinor: l.amount_base_minor,
      fxRate: l.fx_rate,
      taxCode: l.tax_code,
      taxBaseMinor: l.tax_base_minor,
      taxAmountMinor: l.tax_amount_minor,
      expenseAccountId: l.expense_account_id,
      costCenterId: l.cost_center_id,
      receiptDocumentId: l.receipt_document_id,
      projectId: l.project_id,
    })),
  };
}
