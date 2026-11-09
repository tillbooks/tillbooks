// Test support for E02 (HR-lite: employees, absences, expense claims).
//
// Borrows A14's world through the A17 fixture: the real ledger ports (audit + period guard) and the
// shipped KMU chart, so a claim's reimbursement posting reconciles against the dedicated
// employee-payable account 2260 (D95, off 2000 Kreditoren), and a locked period is a real lock.

import { createContact } from '../../dist/core/sales/index.js';
import { makeContext } from '../../dist/core/context.js';
import { ok, err } from '../../dist/core/result.js';
import { setup as purchaseSetup } from '../purchase/support.mjs';
import {
  upsertEmployee,
  createClaim,
  upsertLine,
  submitClaim,
} from '../../dist/core/hr/index.js';

export { secondWorkspace } from '../payments/support.mjs';

export function setup(opts = {}) {
  return purchaseSetup(opts);
}

/** A vendor contact the reimbursement can settle against (employee-payable 2260 counterparty). */
export function addVendorContact(ctx, name = 'Alex Muster', key = 'emp-contact') {
  const c = createContact(ctx, { partyRole: 'vendor', name, idempotencyKey: key });
  if (!c.ok) throw new Error(`contact failed: ${c.error}`);
  return c.contact.id;
}

/**
 * An employee with, by default, a vendor contact (so a claim can be approved and reimbursed) and an
 * `actorRef` so the self-approval and self-scoping paths have an identity to resolve.
 */
export function addEmployee(ctx, overrides = {}, key = 'emp') {
  const contactId = overrides.contactId === null ? null : overrides.contactId ?? addVendorContact(ctx, overrides.name ?? 'Alex Muster', `${key}-contact`);
  const res = upsertEmployee(ctx, {
    employee: {
      firstName: overrides.firstName ?? 'Alex',
      lastName: overrides.lastName ?? 'Muster',
      employmentPct: overrides.employmentPct ?? 80,
      startsOn: overrides.startsOn ?? '2026-01-01',
      ...(contactId !== null ? { contactId } : {}),
      ...(overrides.actorRef !== undefined ? { actorRef: overrides.actorRef } : {}),
      ...(overrides.ahvNr !== undefined ? { ahvNr: overrides.ahvNr } : {}),
    },
    idempotencyKey: overrides.idempotencyKey ?? `${key}-up`,
  });
  if (!res.ok) throw new Error(`employee failed: ${res.error} ${JSON.stringify(res)}`);
  return { employeeId: res.employeeId, contactId };
}

/**
 * A submitted claim with one CHF line on the given expense category (default travel, no VAT).
 *
 * The claim is drafted and submitted by a DISTINCT actor (`claimant`), not the approver `ctx` uses,
 * so four-eyes holds: the approver in a test is `ctx`'s own actor, never the one who submitted.
 */
export function submittedClaim(ctx, employeeId, opts = {}, key = 'clm') {
  const claimant = opts.claimantCtx ?? makeContext(ctx.store, { workspaceId: ctx.workspaceId, actor: opts.claimant ?? 'claimant', clock: ctx.clock, ids: ctx.ids });
  const created = createClaim(claimant, { employeeId, title: opts.title ?? 'Reise Zürich', idempotencyKey: `${key}-create` });
  if (!created.ok) throw new Error(`create failed: ${created.error}`);
  const claimId = created.claimId;
  const lineRes = upsertLine(claimant, {
    claimId,
    line: {
      expenseDate: opts.expenseDate ?? '2026-06-15',
      category: opts.category ?? 'travel',
      amountMinor: opts.amountMinor ?? 4000,
      ...(opts.taxCode !== undefined ? { taxCode: opts.taxCode } : {}),
      ...(opts.receiptDocumentId !== undefined ? { receiptDocumentId: opts.receiptDocumentId } : {}),
    },
    idempotencyKey: `${key}-line`,
  });
  if (!lineRes.ok) throw new Error(`line failed: ${lineRes.error} ${JSON.stringify(lineRes)}`);
  if (opts.noSubmit) return { claimId };
  const sub = submitClaim(claimant, { claimId, idempotencyKey: `${key}-submit` });
  if (!sub.ok) throw new Error(`submit failed: ${sub.error} ${JSON.stringify(sub)}`);
  return { claimId };
}

/** A ctx for `actor` that grants exactly `grants` (a set of capability ids). Real periods optional. */
export function capCtx(t, actor, grants, opts = {}) {
  const set = new Set(grants);
  return makeContext(t.store, {
    workspaceId: t.workspaceId,
    actor,
    clock: opts.clock ?? t.clock,
    ids: t.ids,
    capabilities: { assert: (c) => (set.has(c) ? ok() : err('permission_denied', { capability: c })) },
  });
}

/** The posted net (credits minus debits) on a given account number, the long way round. */
export function accountBalance(store, workspaceId, number) {
  const row = store.db
    .prepare(
      `SELECT COALESCE(SUM(l.base_credit_minor - l.base_debit_minor), 0) AS net
         FROM journal_line l JOIN account a ON a.id = l.account_id JOIN journal_entry e ON e.id = l.entry_id
        WHERE a.workspace_id = ? AND a.number = ? AND e.status = 'posted'`,
    )
    .get(workspaceId, number);
  return row.net;
}

/**
 * The posted net on the DEDICATED employee-payable account 2260 (D95): the liability E02 credits on
 * approve and clears on reimburse. This is the account the money-path invariants track, not 2000.
 */
export function payablesBalance(store, workspaceId) {
  return accountBalance(store, workspaceId, '2260');
}

/** The posted net on 2000 Kreditoren (vendor AP). E02 must NEVER touch it: it stays zero. */
export function vendorApBalance(store, workspaceId) {
  return accountBalance(store, workspaceId, '2000');
}

/** Row counts across every table an E02 money-path write can touch, so idempotency is asserted on ROWS. */
export function counts(store, workspaceId) {
  const one = (sql, ...p) => store.db.prepare(sql).get(...p).n;
  return {
    claims: one('SELECT COUNT(*) AS n FROM expense_claim WHERE workspace_id = ?', workspaceId),
    lines: one('SELECT COUNT(*) AS n FROM expense_line WHERE workspace_id = ?', workspaceId),
    entries: one('SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ?', workspaceId),
    journalLines: one('SELECT COUNT(*) AS n FROM journal_line l JOIN journal_entry e ON e.id = l.entry_id WHERE e.workspace_id = ?', workspaceId),
    payments: one('SELECT COUNT(*) AS n FROM payment WHERE workspace_id = ?', workspaceId),
    audits: one('SELECT COUNT(*) AS n FROM audit_log WHERE workspace_id = ?', workspaceId),
  };
}

export function claimRow(store, workspaceId, id) {
  return store.db.prepare('SELECT * FROM expense_claim WHERE workspace_id = ? AND id = ?').get(workspaceId, id);
}
