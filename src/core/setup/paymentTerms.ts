/**
 * D163 (owner pick, 04.10.2026: "Workspace default terms"): THE ONE due-date derivation.
 *
 * A document's Fälligkeit is, in this order:
 *
 *  1. the due date the document names explicitly;
 *  2. otherwise the document date plus the COUNTERPARTY's own Zahlungsfrist (`contact.payment_terms_days`);
 *  3. otherwise the document date plus the WORKSPACE default (`workspace.default_payment_terms_days`,
 *     set in the Firmenprofil);
 *  4. otherwise the document date itself (0 days), which is what every document fell due on before
 *     the workspace default existed.
 *
 * `null` and `0` are different facts at steps 2 and 3. A contact whose terms are `null` has none of
 * its own and takes the workspace default; a contact whose terms are `0` is due IMMEDIATELY and does
 * not. The contact column held 0 for both until generation 10 (`core/store/migrations.ts`), because
 * `createContact` stored 0 whenever no terms were given.
 *
 * Both money halves derive through here and nowhere else: a sales invoice when it is issued without a
 * stored due date (`transitionDocument`, the issue path), and a vendor bill recorded without one
 * (A17's `prepareBill`). A due date is never written by a reader: once a document carries one, it
 * keeps it (an issued or posted document's due date is not re-derived when the terms change later).
 *
 * The Studio mirrors `deriveDueDate` in `app/src/surfaces/Bills/model.ts` (`defaultDueDate`), held to
 * this function day for day by `test/purchase/studio-bills-defaults.test.mjs`.
 *
 * §H-TENANT: both reads are fenced by `workspace_id`.
 */

import type { WorkspaceContext } from '../context.js';

/**
 * The longest Zahlungsfrist accepted, in days, for the workspace default AND for a contact's own terms
 * (critic M1). Anything longer is a typo, not a term: an unbounded contact term once threw a RangeError
 * out of the issue path, and a slightly smaller one stored the due date '+010240-04' on an immutable
 * issued invoice.
 */
export const PAYMENT_TERMS_MAX_DAYS = 365;

/** The Zahlungsfrist a NEW workspace starts with (owner pick, 07.10.2026: "Preset 30 days for new"). */
export const NEW_WORKSPACE_PAYMENT_TERMS_DAYS = 30;

const DAY_MS = 86_400_000;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A Zahlungsfrist the settings may store: a whole number of days from 0 to 365. */
export function isPaymentTermsDays(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= PAYMENT_TERMS_MAX_DAYS;
}

/** The workspace default's validator: the one range, under the name the setting's callers use. */
export const isWorkspaceTermsDays = isPaymentTermsDays;

/**
 * A Zahlungsfrist a document can be counted with, or null. A STORED value outside 0 to 365 (a row
 * written before the bound existed) is "no usable terms" and falls through to the next rule, so the
 * derivation never throws and never produces a date that is not a calendar day.
 */
function usableDays(value: number | null | undefined): number | null {
  return isPaymentTermsDays(value) ? value : null;
}

export interface DueDateInput {
  /** The due date the document names, if any. Blank counts as none. */
  dueDate?: string | null | undefined;
  /** The date the terms count from: the invoice's issue date, the bill's bill date (ISO `YYYY-MM-DD`). */
  documentDate: string;
  /** The counterparty's own terms: null means "none of its own", 0 means "due immediately". */
  contactTermsDays?: number | null | undefined;
  /** The workspace default terms, or null when none is set. */
  workspaceDefaultDays?: number | null | undefined;
}

/** Which rule a derived due date came from, for a caller that wants to say so. */
export type DueDateSource = 'explicit' | 'contact' | 'workspace' | 'document_date';

/**
 * The pure derivation: explicit, else document date + (contact terms ?? workspace default ?? 0).
 * UTC calendar days, so a month end and 29 February land on the same day for every caller.
 */
export function deriveDueDate(input: DueDateInput): { dueDate: string; source: DueDateSource; days: number } {
  if (typeof input.dueDate === 'string' && input.dueDate.length > 0) {
    return { dueDate: input.dueDate, source: 'explicit', days: 0 };
  }
  const contact = usableDays(input.contactTermsDays);
  const workspace = usableDays(input.workspaceDefaultDays);
  const days = contact ?? workspace ?? 0;
  const source: DueDateSource = contact !== null ? 'contact' : workspace !== null ? 'workspace' : 'document_date';
  const at = Date.parse(`${input.documentDate}T00:00:00.000Z`);
  if (days === 0 || Number.isNaN(at)) return { dueDate: input.documentDate, source, days };
  const due = new Date(at + days * DAY_MS);
  // Belt and braces: with the bound above this cannot fail, but a due date that is not a valid ISO
  // calendar day must never reach an immutable row, and nothing here may throw.
  if (Number.isNaN(due.getTime())) return { dueDate: input.documentDate, source, days };
  const iso = due.toISOString().slice(0, 10);
  return ISO_DAY.test(iso) ? { dueDate: iso, source, days } : { dueDate: input.documentDate, source, days };
}

/** The workspace's default Zahlungsfrist in days, or null when none is set. */
export function workspaceDefaultTermsDays(ctx: WorkspaceContext): number | null {
  const row = ctx.store.db
    .prepare('SELECT default_payment_terms_days AS days FROM workspace WHERE id = ?')
    .get(ctx.workspaceId) as { days: number | null } | undefined;
  return usableDays(row?.days ?? null);
}

/** A contact's own Zahlungsfrist in days, or null when it has none (or is not in this tenant). */
export function contactTermsDays(ctx: WorkspaceContext, contactId: string | null): number | null {
  if (contactId === null) return null;
  const row = ctx.store.db
    .prepare('SELECT payment_terms_days AS days FROM contact WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, contactId) as { days: number | null } | undefined;
  return usableDays(row?.days ?? null);
}

/** The due date a document of `contactId` dated `documentDate` gets, with the stored terms read here. */
export function dueDateFor(
  ctx: WorkspaceContext,
  input: { contactId: string | null; documentDate: string; dueDate?: string | null | undefined },
): string {
  return deriveDueDate({
    dueDate: input.dueDate,
    documentDate: input.documentDate,
    contactTermsDays: contactTermsDays(ctx, input.contactId),
    workspaceDefaultDays: workspaceDefaultTermsDays(ctx),
  }).dueDate;
}
