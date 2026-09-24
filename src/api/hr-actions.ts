/**
 * E02's fourteen verbs (HR-lite: employees, absences, expense claims), defined here and spread into
 * `ACTIONS` as ONE line (the `purchaseActions` / `salesOrderActions` precedent), so several agents
 * appending to the append-only registry at once collide over a line rather than a block.
 *
 * ELEVEN WRITES AND THREE READS... actually five reads: every write carries `idempotencyKey` because
 * each MINTS or MOVES something (an employee, an absence, a claim, a line, a posting, a payment). The
 * two irreversible/outbound writes, `expense_claim_approve` (posts via A02) and
 * `expense_claim_reimburse` (pays via A14), are P8 draft-gated: without `confirm` they return a
 * preview and stop. As with `purchase-actions.ts`, the helpers arrive as a parameter rather than an
 * import, so the module graph stays acyclic: `registry.ts` imports this file and this file must not
 * import it back.
 */

import type { ActionDef, ActionInput, JsonSchema } from './registry.js';
import type { WorkspaceContext } from '../core/context.js';
import type { Result } from '../core/result.js';
import {
  upsertEmployee,
  getEmployee,
  listEmployees,
  recordAbsence,
  cancelAbsence,
  listAbsences,
  createClaim,
  upsertLine,
  submitClaim,
  approveClaim,
  rejectClaim,
  reimburseClaim,
  listClaims,
  getClaim,
} from '../core/hr/index.js';

export interface HrActionHelpers {
  ctxAction(
    name: string,
    kind: 'read' | 'write',
    summary: string,
    inputSchema: JsonSchema,
    call: (ctx: WorkspaceContext, input: ActionInput) => Result,
  ): ActionDef;
  ctxSchema(props?: Record<string, unknown>, required?: string[]): JsonSchema;
  STR: { readonly type: 'string' };
  INT: { readonly type: 'integer' };
  BOOL: { readonly type: 'boolean' };
}

function as<T>(input: ActionInput): T {
  return input as unknown as T;
}

const OBJ = { type: 'object' } as const;

export function hrActions(h: HrActionHelpers): readonly ActionDef[] {
  const { ctxAction, ctxSchema, STR, BOOL } = h;

  return [
    ctxAction(
      'hr_employee_upsert',
      'write',
      'Add or edit an employee (Mitarbeitende): first/last name, employment_pct (integer 1-100), starts_on and optional ends_on, an optional linked contact (the counterparty a reimbursement pays), and an optional actor_ref (the member whose calls self-scope to this person). Requires hr.manage. ahv_nr is OPTIONAL and captured only for the external payroll hand-off (revDSG Art. 6 minimisation); writing it additionally requires hr.sensitive, and it is masked on every read that does not hold hr.sensitive. Pass employee.id to edit an existing row.',
      ctxSchema({ employee: OBJ, idempotencyKey: STR }, ['employee', 'idempotencyKey']),
      (ctx, input) => upsertEmployee(ctx, as(input)),
    ),
    ctxAction(
      'hr_employee_get',
      'read',
      'Read one employee. The AHV number is returned only when includeSensitive is true AND the caller holds hr.sensitive; otherwise it is masked (756-...) and ahvRestricted is true.',
      ctxSchema({ employeeId: STR, includeSensitive: BOOL }, ['employeeId']),
      (ctx, input) => getEmployee(ctx, as(input)),
    ),
    ctxAction(
      'hr_employee_list',
      'read',
      'List employees (the roster). AHV numbers are masked unless includeSensitive is true and the caller holds hr.sensitive. includeArchived includes ended/archived people.',
      ctxSchema({ includeSensitive: BOOL, includeArchived: BOOL, savedViewId: STR }),
      (ctx, input) => listEmployees(ctx, as(input)),
    ),
    ctxAction(
      'hr_absence_record',
      'write',
      'Record an absence (ArG Art. 46 record-keeping): kind is vacation|sick|other, plus from_date and to_date (YYYY-MM-DD). Requires hr.manage. An overlapping absence for the same employee is ACCEPTED with overlap:true in the result (a half-day sick during vacation), never merged. Sick leave is health data (revDSG Art. 5 lit. c Ziff. 2).',
      ctxSchema({ employeeId: STR, kind: STR, fromDate: STR, toDate: STR, notes: STR, idempotencyKey: STR }, [
        'employeeId',
        'kind',
        'fromDate',
        'toDate',
        'idempotencyKey',
      ]),
      (ctx, input) => recordAbsence(ctx, as(input)),
    ),
    ctxAction(
      'hr_absence_cancel',
      'write',
      'Cancel an absence by flipping its status to cancelled (append-only spirit: the row stays, it is never deleted). Requires hr.manage.',
      ctxSchema({ absenceId: STR, idempotencyKey: STR }, ['absenceId', 'idempotencyKey']),
      (ctx, input) => cancelAbsence(ctx, as(input)),
    ),
    ctxAction(
      'hr_absence_list',
      'read',
      'List absences, SELF-SCOPED: without hr.manage the caller receives only their own linked employee`s rows, because sick leave is health data (revDSG Art. 5 lit. c Ziff. 2). employeeId, from and to narrow within scope; they can never widen it to a colleague`s records.',
      ctxSchema({ employeeId: STR, from: STR, to: STR, savedViewId: STR }),
      (ctx, input) => listAbsences(ctx, as(input)),
    ),
    ctxAction(
      'expense_claim_create',
      'write',
      'Create a draft expense claim (Spesenabrechnung) for an employee. Requires spesen.submit. Add lines with expense_line_upsert, then submit with expense_claim_submit.',
      ctxSchema({ employeeId: STR, title: STR, currency: STR, idempotencyKey: STR }, ['employeeId', 'title', 'idempotencyKey']),
      (ctx, input) => createClaim(ctx, as(input)),
    ),
    ctxAction(
      'expense_line_upsert',
      'write',
      'Add or edit a claim line (only while the claim is draft). line carries expense_date, category (travel|meals|supplies|it|other), amountMinor (integer Rappen, the receipt total), currency (default CHF), an optional fxRate for a foreign line, an optional taxCode (an input-side Vorsteuer code, or none), an optional receiptDocumentId (an E00 file), and optional costCenterId/projectId/expenseAccountId. The per-line tax_code + base + tax are resolved ONCE by A05 and stored as values (MWSTG Art. 28). Requires spesen.submit. Pass line.lineId to edit.',
      ctxSchema({ claimId: STR, line: OBJ, idempotencyKey: STR }, ['claimId', 'line', 'idempotencyKey']),
      (ctx, input) => upsertLine(ctx, as(input)),
    ),
    ctxAction(
      'expense_claim_submit',
      'write',
      'Submit a draft claim for approval. Refuses empty_claim (no lines) and receipt_required (a line over CHF 50 with no receipt, naming the offending line_ids). Snapshots the base total. Requires spesen.submit. Idempotent on the key.',
      ctxSchema({ claimId: STR, idempotencyKey: STR }, ['claimId', 'idempotencyKey']),
      (ctx, input) => submitClaim(ctx, as(input)),
    ),
    ctxAction(
      'expense_claim_approve',
      'write',
      'Approve a submitted claim: POSTS the reimbursement liability via A02 (Dr per-category expense + Dr 1170/1171 Vorsteuer; Cr 2000 Kreditoren gross, the A17 vendor-bill shape with the employee as counterparty). P8 draft-gated: WITHOUT confirm:true it returns the journal-entry preview and posts NOTHING. Requires spesen.approve AND post. Refuses self_approval (approving your own claim, four-eyes, including an automation firing), period_locked (a locked posting period, pre-checked, no partial post), and invalid_transition (not submitted). Re-approving never double-posts. needs_employee_contact if the employee has no vendor-role contact to settle against.',
      ctxSchema({ claimId: STR, confirm: BOOL, idempotencyKey: STR }, ['claimId', 'idempotencyKey']),
      (ctx, input) => approveClaim(ctx, as(input)),
    ),
    ctxAction(
      'expense_claim_reject',
      'write',
      'Reject a submitted claim with a reason (reason_required if empty). Terminal (submitted -> rejected). An APPROVED (posted) claim is not rejected: it is corrected by an A02 reversing entry plus a fresh claim (invalid_transition otherwise). Requires spesen.approve (approve and reject share the review right).',
      ctxSchema({ claimId: STR, reason: STR, idempotencyKey: STR }, ['claimId', 'reason', 'idempotencyKey']),
      (ctx, input) => rejectClaim(ctx, as(input)),
    ),
    ctxAction(
      'expense_claim_reimburse',
      'write',
      'Reimburse an approved claim: pays the employee via A14 recordPayment (outgoing supplier settlement clearing 2000 Kreditoren, Dr 2000 / Cr bank) and prepares the pain.001 as a LOCAL artifact. P8 draft-gated: WITHOUT confirm:true it returns the payment + artifact plan and pays NOTHING. Transmission of the pain.001 to a bank is cloud-tier: the result carries transmitted:false, reason:cloud_tier. Idempotent: a reimbursed claim is never paid twice. Requires spesen.approve AND pay AND post. bankAccountId names the paying Bankkonto.',
      ctxSchema({ claimId: STR, bankAccountId: STR, confirm: BOOL, idempotencyKey: STR }, ['claimId', 'idempotencyKey']),
      (ctx, input) => reimburseClaim(ctx, as(input)),
    ),
    ctxAction(
      'expense_claim_list',
      'read',
      'List expense claims, SELF-SCOPED: only hr.manage (full cross-employee) or spesen.approve (the submitted-claims approval queue) widens the read beyond the caller`s own claims. status and employeeId narrow within scope.',
      ctxSchema({ status: STR, employeeId: STR, savedViewId: STR }),
      (ctx, input) => listClaims(ctx, as(input)),
    ),
    ctxAction(
      'expense_claim_get',
      'read',
      'Read one claim with its lines, the posted journal entry (once approved) and the payment (once reimbursed). Self-scoped: a bare reader reading a colleague`s claim id gets not_found.',
      ctxSchema({ claimId: STR }, ['claimId']),
      (ctx, input) => getClaim(ctx, as(input)),
    ),
  ];
}
