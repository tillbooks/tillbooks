/**
 * A15's read models (Pattern P5): the run history, one run in full, and the shared row-to-view
 * mapping every write verb answers with, so a propose, an issue and a get all describe a run in
 * exactly one shape.
 *
 * Machine surfaces stay locale-neutral (P11): integer Rappen, ISO currency codes, ISO dates. The
 * Studio formats; nothing here does.
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { optionalDate, requireString } from '../ledger/inputGuards.js';
import { applySavedView } from '../customization/views.js';
import { listOpenItems } from '../debtors/index.js';
import type { OpenItem } from '../debtors/index.js';
import { DUNNING_RUN_STATUSES } from './config.js';

// --- THE shared "is this booked fee LIVE" predicate (critic C1/C2 on A14's dunning_fee target) -----

/** One booked, LIVE Mahngebühr, as `liveDunningFeeItemsAsOf` / `readLiveDunningFeeItem` answer it. */
export interface LiveDunningFeeItem {
  id: string;
  documentId: string;
  debtorId: string;
  number: string | null;
  dueDate: string | null;
  level: number;
  feeMinor: number;
}

interface LiveDunningFeeItemRow {
  id: string;
  document_id: string;
  debtor_id: string;
  number: string | null;
  due_date: string | null;
  level: number;
  fee_minor: number;
}

/**
 * The SQL both queries below run, as ONE string, so the singular and the plural read can never
 * diverge in which fee they call live. This is the exact repair the A14 dunning-fee critic named
 * (`docs/critique/a14-fee-critic.md` C1/C2): `readTarget` (A14's settlement planner) used to decide
 * a fee was live from `fee_booked = 1` alone, while A16's `dunningFeesAsOf` also required the RUN
 * issued or sent, the fee ENTRY posted, and no posted reversal of it dated on or before `asOf`.
 * `fee_booked` is A15's own attribution flag (`src/core/dunning/schema.ts`): it is set once at
 * issue and NEVER rewritten by a later `reverse_entry` on the fee, so a reversed fee still read
 * `fee_booked = 1` and the allocator, alone among every reader of this state, believed it. A payment
 * against it then previewed `openMinor: <fee>, resultingStatus: 'settled'` and posted a 1100 credit
 * nothing on the ledger backs.
 *
 * A fee is LIVE when: `fee_booked = 1`, its run reached `issued` or `sent`, its fee entry is posted
 * on or before `asOf`, and no posted reversal of that entry is dated on or before `asOf`. The
 * reversal clause is the same one `receivableDocuments` in `src/core/debtors/openItems.ts` applies
 * to a document's own posted entry: once reversed, the claim is gone, and it is gone from the date
 * the reversal is itself dated, never retroactively.
 */
const LIVE_DUNNING_FEE_ITEM_SELECT = `
  SELECT i.id, i.document_id, i.debtor_id, i.number, i.due_date, i.level, i.fee_minor
    FROM dunning_item i
    JOIN dunning_run r ON r.id = i.run_id AND r.workspace_id = i.workspace_id
    JOIN journal_entry e ON e.id = r.fee_entry_id AND e.workspace_id = r.workspace_id
   WHERE i.workspace_id = ? AND i.fee_booked = 1
     AND r.status IN ('issued', 'sent')
     AND e.status = 'posted' AND e.date <= ?
     AND NOT EXISTS (SELECT 1 FROM journal_entry x
                      WHERE x.workspace_id = r.workspace_id
                        AND x.reverses_entry_id = e.id
                        AND x.status = 'posted' AND x.date <= ?)
`;

function toLiveDunningFeeItem(row: LiveDunningFeeItemRow): LiveDunningFeeItem {
  return {
    id: row.id,
    documentId: row.document_id,
    debtorId: row.debtor_id,
    number: row.number,
    dueDate: row.due_date,
    level: row.level,
    feeMinor: row.fee_minor,
  };
}

/** Every LIVE booked fee in the workspace as of `asOf` (A16's `dunningFeesAsOf` groups these). */
export function liveDunningFeeItemsAsOf(ctx: WorkspaceContext, asOf: string): LiveDunningFeeItem[] {
  const rows = ctx.store.db
    .prepare(LIVE_DUNNING_FEE_ITEM_SELECT)
    .all(ctx.workspaceId, asOf, asOf) as LiveDunningFeeItemRow[];
  return rows.map(toLiveDunningFeeItem);
}

/** One fee by its `dunning_item` id, live as of `asOf`, or undefined (not found, or not live). */
export function readLiveDunningFeeItem(
  ctx: WorkspaceContext,
  itemId: string,
  asOf: string,
): LiveDunningFeeItem | undefined {
  const row = ctx.store.db
    .prepare(`${LIVE_DUNNING_FEE_ITEM_SELECT} AND i.id = ?`)
    .get(ctx.workspaceId, asOf, asOf, itemId) as LiveDunningFeeItemRow | undefined;
  return row === undefined ? undefined : toLiveDunningFeeItem(row);
}

/**
 * A booked Mahngebühr's human-recognisable label: the invoice it rides plus its escalation level,
 * because the SAME invoice can carry more than one booked fee (a level-1 and a level-2 Mahngebühr
 * are two distinct `dunning_item` rows) and the invoice number alone would not tell them apart.
 * Shared by A14's `readTarget` (what a settlement plan shows), `mapAllocation` (what a posted
 * allocation shows), and A16's orphan-settlement row (critic N6: a reader must be able to tell a
 * written-off Mahngebühr from an ordinary overpayment), so none of the three ever drift into a
 * different label for the same fee.
 */
export function dunningFeeLabel(invoiceNumber: string | null, level: number): string {
  return invoiceNumber === null ? `Mahngebühr Stufe ${level}` : `${invoiceNumber} Mahngebühr Stufe ${level}`;
}

export interface RunRow {
  id: string;
  workspace_id: string;
  run_date: string;
  status: string;
  fee_entry_id: string | null;
  fee_skipped_reason: string | null;
  created_by: string;
  created_at: string;
  issued_at: string | null;
  sent_at: string | null;
}

export interface ItemRow {
  id: string;
  workspace_id: string;
  run_id: string;
  document_id: string;
  debtor_id: string;
  level: number;
  currency: string;
  overdue_minor: number;
  fee_minor: number;
  fee_booked: number;
  principal_minor: number;
  demanded_fee_minor: number;
  days_overdue: number;
  due_date: string | null;
  number: string | null;
  interest_minor: number | null;
  sent_at: string | null;
  send_error: string | null;
}

/** One run row, §H-TENANT scoped, or undefined. */
export function readRun(ctx: WorkspaceContext, runId: string): RunRow | undefined {
  return ctx.store.db
    .prepare('SELECT * FROM dunning_run WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, runId) as RunRow | undefined;
}

// --- The settlement re-validation, shared by the SEND path and the MANUAL/DOWNLOAD read path ------
//
// K-31/K-32. A letter that names an invoice which changed since the run was issued must NEVER be
// mailed as issued: it asserts, under that invoice's own number and QRR reference, a demand that is
// no longer true. Two facts made the old guard toothless:
//   - it lived ONLY on `sendDunningRun`, which returns `needs_email_config` before it is reached
//     when no relay is wired, and no relay is wired in the MIT core: the guard was dead code and the
//     Studio's manual PDF download (the only working send path) named settled invoices unwarned;
//   - it fired only on a FULLY settled invoice, so a partial payment since issue sailed through, and
//     it labelled paid, cancelled and credited invoices alike 'settled_since_issue', overstating a
//     partial payment or a cancellation as a settlement.
//
// This function is the ONE source of truth for both. It reads A16's OWN `listOpenItems` derivation
// (never a fork; the propose/issue path reads the same one) and names the cause distinctly. D73 is
// untouched throughout: nothing here rewrites the frozen `dunning_item` rows or the letter; a changed
// letter loses its TRANSPORT (or is marked for the operator's eyes), never its record.

/** The distinct cause an issued letter's named invoice changed since issue (K-31 f2). */
export type DunningItemChange = 'paid' | 'partially_paid' | 'cancelled' | 'credited';

/**
 * The invoice's OWN open amount on an A16 row: what the row carries minus the booked Mahngebühren
 * riding it, minus its linked credit notes' open offsets. This mirrors `run.ts`'s `principalOf`
 * exactly (the escalation and chaseable-amount base, D68); the two must never diverge.
 */
function principalOf(item: OpenItem): number {
  return item.openMinor - item.dunningFeeMinor - item.creditedOpenMinor;
}

/** True when the document's own posted entry has a posted reversal dated on or before asOf (A10
 *  cancellation, §H-AUDIT: never a delete), or a migrated document carries status='cancelled'. This
 *  is the same reversal clause `receivableDocuments` (A16) applies to drop a cancelled invoice. */
function documentCancelledAsOf(ctx: WorkspaceContext, documentId: string, asOf: string): boolean {
  const row = ctx.store.db
    .prepare(
      `SELECT CASE
                WHEN d.origin = 'migrated' THEN (CASE WHEN d.status = 'cancelled' THEN 1 ELSE 0 END)
                WHEN d.posted_entry_id IS NOT NULL AND EXISTS (
                       SELECT 1 FROM journal_entry r
                        WHERE r.workspace_id = d.workspace_id
                          AND r.reverses_entry_id = d.posted_entry_id
                          AND r.status = 'posted' AND r.date <= ?)
                THEN 1 ELSE 0 END AS cancelled
         FROM document d
        WHERE d.workspace_id = ? AND d.id = ?`,
    )
    .get(asOf, ctx.workspaceId, documentId) as { cancelled: number } | undefined;
  return row !== undefined && row.cancelled === 1;
}

/** The face amount of payment allocations against a document, in force as of asOf (a reversed
 *  payment drops out from its reversal's date). Used only for a document that has left the open-item
 *  set entirely (a full payment), where its row can no longer report its own `paidMinor`. */
function documentPaidFaceAsOf(ctx: WorkspaceContext, documentId: string, asOf: string): number {
  const row = ctx.store.db
    .prepare(
      `SELECT COALESCE(SUM(a.amount_minor + a.skonto_minor + a.skonto_vat_minor + a.writeoff_minor), 0) AS face
         FROM payment_allocation a
         JOIN payment p ON p.id = a.payment_id AND p.workspace_id = ?
        WHERE a.workspace_id = ? AND a.target_kind = 'document' AND a.target_id = ?
          AND p.date <= ?
          AND (p.reversal_entry_id IS NULL
               OR (SELECT e.date FROM journal_entry e WHERE e.id = p.reversal_entry_id) > ?)`,
    )
    .get(ctx.workspaceId, ctx.workspaceId, documentId, asOf, asOf) as { face: number };
  return row.face;
}

/**
 * Classify one named invoice against its issue-time snapshot, as of asOf, or null when it is
 * unchanged (still fully demandable, so the letter is honest to send).
 *
 * The issued principal is the frozen `principal_minor`; a row issued before that column existed
 * reads the ALTER default 0, so it falls back to `overdue_minor` (the S2 fallback the renderer uses).
 */
function classifyItemChange(
  ctx: WorkspaceContext,
  item: Pick<ItemRow, 'document_id' | 'principal_minor' | 'overdue_minor'>,
  openByDoc: ReadonlyMap<string, OpenItem>,
  asOf: string,
): DunningItemChange | null {
  const issuedPrincipal = item.principal_minor > 0 ? item.principal_minor : item.overdue_minor;
  // Cancelled is decided FIRST: a cancelled invoice has left the receivable set, so it would
  // otherwise read like a full payment below.
  if (documentCancelledAsOf(ctx, item.document_id, asOf)) return 'cancelled';

  const current = openByDoc.get(item.document_id);
  const currentPrincipal = current === undefined ? 0 : principalOf(current);
  // No reduction since issue: nothing changed that would make the frozen demand a lie.
  if (issuedPrincipal - currentPrincipal <= 0) return null;

  // A present row reports its own payment and credit state; a row that left the set entirely (a full
  // payment nets openMinor to zero) is read from the allocation ledger. A fully credited invoice
  // keeps its row (openMinor unchanged; the credit rides a separate row), so it is always present.
  const paid = current === undefined ? documentPaidFaceAsOf(ctx, item.document_id, asOf) : current.paidMinor;
  const credited = current === undefined ? 0 : current.creditedOpenMinor;
  if (credited > 0 && paid <= 0) return 'credited';
  if (paid > 0) return currentPrincipal <= 0 ? 'paid' : 'partially_paid';
  if (credited > 0) return 'credited';
  // Reduced to nothing with no payment and no credit and no detected reversal: the claim is gone by
  // some other cancellation route. Named as cancelled rather than a settlement it never took.
  return 'cancelled';
}

/**
 * Every invoice named on an ISSUED (or sent) run that changed since issue, keyed by document id.
 * Empty for a proposed run (nothing is frozen yet) and for a run whose every item is unchanged.
 * The one call both the send path and the read model make, so they can never disagree on which
 * letters are safe to mail.
 */
export function dunningRunChangesSinceIssue(
  ctx: WorkspaceContext,
  run: RunRow,
  asOf: string,
): Map<string, DunningItemChange> {
  const changes = new Map<string, DunningItemChange>();
  if (run.status !== 'issued' && run.status !== 'sent') return changes;

  const items = ctx.store.db
    .prepare('SELECT document_id, principal_minor, overdue_minor FROM dunning_item WHERE workspace_id = ? AND run_id = ?')
    .all(ctx.workspaceId, run.id) as Pick<ItemRow, 'document_id' | 'principal_minor' | 'overdue_minor'>[];
  if (items.length === 0) return changes;

  const open = listOpenItems(ctx, { asOf });
  const openByDoc = new Map<string, OpenItem>();
  if (open.ok) {
    for (const it of open.items as OpenItem[]) {
      if (it.kind === 'document' && it.documentId !== null && !openByDoc.has(it.documentId)) {
        openByDoc.set(it.documentId, it);
      }
    }
  }

  for (const item of items) {
    const change = classifyItemChange(ctx, item, openByDoc, asOf);
    if (change !== null) changes.set(item.document_id, change);
  }
  return changes;
}

interface ItemView {
  /** The `dunning_item` row's own id: the A14 `dunningItemId` allocation target once the fee books. */
  id: string;
  documentId: string;
  debtorId: string;
  debtorName: string | null;
  number: string | null;
  level: number;
  currency: string;
  overdueMinor: number;
  feeMinor: number;
  /** True when the fee is on the ledger. May flip AFTER issue (the C8 recovery); the demand never does. */
  feeBooked: boolean;
  /** The invoice's own open amount at issue, net of earlier fees: the Art. 104 interest base. */
  principalMinor: number;
  /** D73's frozen demand: the fee THIS letter asks for, snapshotted at issue and never rewritten. */
  demandedFeeMinor: number;
  interestMinor: number | null;
  daysOverdue: number;
  dueDate: string | null;
  sentAt: string | null;
  sendError: string | null;
  /**
   * K-31 f1/f2: the distinct cause this named invoice changed since the run was ISSUED, or null when
   * it is unchanged (or the run is still proposed). Computed as of today from A16's live derivation,
   * so the Studio warns the operator BEFORE they manually mail or download a letter that names a
   * paid, partially paid, cancelled or credited invoice. Never rewrites the frozen figures (D73).
   */
  changeSinceIssue: DunningItemChange | null;
}

/** The full view of one run: its items, grouped per debtor the way the letters group. */
export function runView(ctx: WorkspaceContext, run: RunRow): Record<string, unknown> {
  // K-31: the settlement re-validation reaches the READ model (the manual/download path), not only
  // the never-present relay send. Computed once per run view, as of today.
  const changes = dunningRunChangesSinceIssue(ctx, run, ctx.clock.now().slice(0, 10));
  const items = ctx.store.db
    .prepare(
      `SELECT i.*, c.name AS debtor_name
         FROM dunning_item i
         LEFT JOIN contact c ON c.id = i.debtor_id AND c.workspace_id = i.workspace_id
        WHERE i.workspace_id = ? AND i.run_id = ?
        ORDER BY i.debtor_id, i.due_date, i.number`,
    )
    .all(ctx.workspaceId, run.id) as (ItemRow & { debtor_name: string | null })[];

  const views: ItemView[] = items.map((i) => ({
    id: i.id,
    documentId: i.document_id,
    debtorId: i.debtor_id,
    debtorName: i.debtor_name,
    number: i.number,
    level: i.level,
    currency: i.currency,
    overdueMinor: i.overdue_minor,
    feeMinor: i.fee_minor,
    feeBooked: i.fee_booked === 1,
    principalMinor: i.principal_minor,
    demandedFeeMinor: i.demanded_fee_minor,
    interestMinor: i.interest_minor,
    daysOverdue: i.days_overdue,
    dueDate: i.due_date,
    sentAt: i.sent_at,
    sendError: i.send_error,
    changeSinceIssue: changes.get(i.document_id) ?? null,
  }));

  const debtors = new Map<string, { debtorId: string; debtorName: string | null; items: ItemView[] }>();
  for (const v of views) {
    const group = debtors.get(v.debtorId) ?? { debtorId: v.debtorId, debtorName: v.debtorName, items: [] };
    group.items.push(v);
    debtors.set(v.debtorId, group);
  }

  return {
    runId: run.id,
    runDate: run.run_date,
    status: run.status,
    feeEntryId: run.fee_entry_id,
    feeSkippedReason: run.fee_skipped_reason,
    createdBy: run.created_by,
    createdAt: run.created_at,
    issuedAt: run.issued_at,
    sentAt: run.sent_at,
    items: views,
    debtors: [...debtors.values()].map((g) => ({
      debtorId: g.debtorId,
      debtorName: g.debtorName,
      itemCount: g.items.length,
      maxLevel: Math.max(...g.items.map((i) => i.level)),
      // A per-currency sum, never a cross-currency one: francs and euros do not add (P11). The fee
      // in this total is the FROZEN demand (D73): what the letter asks for, which a later recovery
      // never rewrites. On a proposed run the demand is not frozen yet, so the PLANNED fee stands
      // in (it is what issue will freeze, barring a period lock).
      totalsByCurrency: g.items.reduce<Record<string, number>>((acc, i) => {
        const fee = run.status === 'proposed' ? i.feeMinor : i.demandedFeeMinor;
        acc[i.currency] = (acc[i.currency] ?? 0) + i.overdueMinor + fee;
        return acc;
      }, {}),
      sent: g.items.every((i) => i.sentAt !== null),
      sendError: g.items.find((i) => i.sendError !== null)?.sendError ?? null,
      // K-31 f1: the per-debtor warning the Studio reads BEFORE offering a manual mail or download.
      // A letter is held whole (K-32/D73) when ANY invoice it names changed since issue; the reason
      // is the first changed invoice's distinct cause, and every changed invoice is listed.
      changedSinceIssue: g.items.some((i) => i.changeSinceIssue !== null),
      changeReason: g.items.find((i) => i.changeSinceIssue !== null)?.changeSinceIssue ?? null,
      changedDocumentIds: g.items.filter((i) => i.changeSinceIssue !== null).map((i) => i.documentId),
    })),
  };
}

export interface ListDunningRunsInput {
  status?: string;
  from?: string;
  to?: string;
  savedViewId?: string;
}

/** The run-history ceiling, mirroring A17's posture: load all, flag truncation. */
export const DUNNING_RUN_LIST_CEILING = 500;

export function listDunningRuns(ctx: WorkspaceContext, input: ListDunningRunsInput = {}): Result {
  const guard = optionalDate(input.from, 'from') ?? optionalDate(input.to, 'to');
  if (guard) return guard;
  if (input.status !== undefined && !(DUNNING_RUN_STATUSES as readonly string[]).includes(input.status)) {
    return err('invalid_input', { field: 'status', allowed: [...DUNNING_RUN_STATUSES] });
  }

  // G00's saved-view seam: the same one-line resolution every other list verb uses.
  const viewed = applySavedView(ctx, 'dunning_run', input);
  if (!viewed.ok) return viewed;
  const filter = viewed.filter;

  const clauses = ['r.workspace_id = ?'];
  const params: string[] = [ctx.workspaceId];
  if (filter.status !== undefined) {
    clauses.push('r.status = ?');
    params.push(filter.status);
  }
  if (filter.from !== undefined) {
    clauses.push('r.run_date >= ?');
    params.push(filter.from);
  }
  if (filter.to !== undefined) {
    clauses.push('r.run_date <= ?');
    params.push(filter.to);
  }

  const rows = ctx.store.db
    .prepare(
      `SELECT r.*,
              (SELECT COUNT(*) FROM dunning_item i
                WHERE i.workspace_id = r.workspace_id AND i.run_id = r.id) AS item_count,
              (SELECT COUNT(DISTINCT i.debtor_id) FROM dunning_item i
                WHERE i.workspace_id = r.workspace_id AND i.run_id = r.id) AS debtor_count,
              (SELECT COALESCE(MAX(i.level), 0) FROM dunning_item i
                WHERE i.workspace_id = r.workspace_id AND i.run_id = r.id) AS max_level
         FROM dunning_run r
        WHERE ${clauses.join(' AND ')}
        ORDER BY r.run_date DESC
        LIMIT ?`,
    )
    .all(...params, DUNNING_RUN_LIST_CEILING + 1) as (RunRow & {
    item_count: number;
    debtor_count: number;
    max_level: number;
  })[];
  const truncated = rows.length > DUNNING_RUN_LIST_CEILING;

  return ok({
    runs: rows.slice(0, DUNNING_RUN_LIST_CEILING).map((r) => ({
      runId: r.id,
      runDate: r.run_date,
      status: r.status,
      itemCount: r.item_count,
      debtorCount: r.debtor_count,
      maxLevel: r.max_level,
      feeEntryId: r.fee_entry_id,
      feeSkippedReason: r.fee_skipped_reason,
      issuedAt: r.issued_at,
      sentAt: r.sent_at,
    })),
    truncated,
  });
}

export interface GetDunningRunInput {
  runId?: string;
}

export function getDunningRun(ctx: WorkspaceContext, input: GetDunningRunInput): Result {
  const guard = requireString(input.runId, 'runId');
  if (guard) return guard;
  const run = readRun(ctx, input.runId as string);
  if (run === undefined) return err('not_found', { runId: input.runId });
  return ok(runView(ctx, run));
}
