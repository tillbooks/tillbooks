/**
 * B02, time -> billing bridge: approved unbilled `time_entry` rows (B01) become A11 invoice DRAFT
 * lines, and the approved-but-unbilled pile is exposed as a WIP read model (P5). Disjoint from B01's
 * `src/core/time/time.ts`: B02 consumes B01's spine, it does not fork it.
 *
 * THE MONEY-PATH DISCIPLINE, stated where it is enforced:
 *  - B02 OPENS NO POSTING PATH (§H-LEDGER, P3). `generateInvoice` delegates to A10 `createDocument`
 *    (type `invoice`, a DRAFT that posts nothing); A11 -> A02 own the only journal entry, at issue.
 *    B02 mints no `postEntry`, stores no total, and computes no VAT amount. It attaches each line the
 *    A05 `tax_code` resolved once (§H-VAT-TRACE); A11 resolves the amount at issue.
 *  - NO DOUBLE-BILLING. The eligibility predicate `status='approved' AND billable=1 AND
 *    invoice_line_id IS NULL` is the single guard (§6b fixed). `generateInvoice` pre-checks every
 *    selected entry against it BEFORE any write, so a selection containing an already-billed entry
 *    writes ZERO rows and returns `already_billed`. On success the entry flips to `billed` with its
 *    `invoice_line_id` set, and the flip plus the idempotency key make a replay a no-op: an entry
 *    billed once can never land on a second invoice.
 *  - THE SINGLE ROUNDING POINT is the time entry (P2). `value_rappen = entryValueMinor(minutes,
 *    rate_minor)` is B01's own round-once helper, imported so preview == time_list == invoice line ==
 *    WIP to the Rappen. Every downstream number is an INTEGER SUM of entry values, never re-rounded.
 *    Each invoice line is emitted with `quantityMilli = 1000` (one unit) and `unitPriceMinor = the
 *    group's summed value`, because A10's `lineTotal` re-rounds `qty x price / 1000`: passing hours x
 *    rate would introduce a SECOND rounding point. qty = 1 makes `lineTotal` return the exact sum; the
 *    hours ride in the line description.
 *  - §H-TENANT. Every read and write scopes to `ctx.workspaceId`; a foreign entry/contact/invoice id
 *    resolves to nothing, so a cross-tenant caller can neither read, bill, nor release another book's
 *    time.
 *
 * THE TX-ATOMICITY DISCIPLINE (the C02/D03 bug this must not reintroduce): `ctx.store.tx` and
 * `rememberIdempotent` roll back ONLY on a throw. A `run` callback that writes and then RETURNS a P9
 * err commits the partial write while reporting failure. So every refusable condition
 * (empty_selection, mixed_contacts, currency_mismatch, already_billed, not_approved, wrong tenant,
 * invoice_not_draft) is pre-checked as a pure READ before any write and returns its err directly; the
 * only in-transaction failure (a `createDocument` rejection) THROWS `BillingAbort` to force the
 * rollback and is translated to an err outside the transaction (the `salesOrderInvoice` pattern).
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { entryValueMinor } from '../time/index.js';
import { resolveTax } from '../vat/index.js';
import { createDocument } from '../sales/document.js';
import type { DocumentLineInput } from '../sales/document.js';

/** The default revenue account time-billing lines credit (A11's `DEFAULT_REVENUE_ACCOUNT`). Its
 *  `vat_code_default` is the tax code B02 attaches to every generated line (P6, one resolve). */
const DEFAULT_REVENUE_ACCOUNT = '3200';

/** How a generated invoice groups its source entries into lines. A per-call organisational choice
 *  (§6b flexible); it never touches the eligibility rule, the rounding, or the delegation. */
export const BILLING_GROUP_BY = ['entry', 'phase', 'project', 'day'] as const;
export type BillingGroupBy = (typeof BILLING_GROUP_BY)[number];

function isGroupBy(value: unknown): value is BillingGroupBy {
  return typeof value === 'string' && (BILLING_GROUP_BY as readonly string[]).includes(value);
}

/** One eligible time entry, joined to its project's client. Only the columns billing reads. */
interface BillableRow {
  id: string;
  project_id: string;
  phase_id: string | null;
  started_at: string;
  minutes: number | null;
  billable: number;
  notes: string | null;
  status: string;
  rate_minor: number;
  rate_currency: string;
  invoice_line_id: string | null;
  project_contact_id: string | null;
}

/** Abort the transaction so a partial write rolls back and nothing is memoised (the A10 pattern). */
class BillingAbort {
  constructor(public readonly result: Result) {}
}

/** The bare day from the injected clock (never the wall clock). */
function today(ctx: WorkspaceContext): string {
  return ctx.clock.now().slice(0, 10);
}

/**
 * THE ELIGIBILITY QUERY, the one place the predicate lives (§6b fixed). Every eligible entry is
 * `approved`, `billable`, and not yet on an invoice line, in THIS tenant, joined to its project so
 * the client (contact) is known for grouping and the single-debtor check. Optional filters narrow
 * by contact, project, and a `through` cut on `started_at`. `unbilledPreview`, `generateInvoice`'s
 * validation and `wipReport` all read through here, so no second definition can drift.
 */
function eligibleEntries(
  ctx: WorkspaceContext,
  filter: { contactId?: string; projectId?: string; through?: string; ids?: readonly string[] },
): BillableRow[] {
  const clauses = [
    'te.workspace_id = ?',
    "te.status = 'approved'",
    'te.billable = 1',
    'te.invoice_line_id IS NULL',
  ];
  const params: (string | number)[] = [ctx.workspaceId];
  if (filter.contactId !== undefined) {
    clauses.push('p.contact_id = ?');
    params.push(filter.contactId);
  }
  if (filter.projectId !== undefined) {
    clauses.push('te.project_id = ?');
    params.push(filter.projectId);
  }
  if (filter.through !== undefined) {
    // A `through_date` cuts on `started_at` (spec §2 boundary): an entry started strictly before the
    // day after `through` is included, so the whole `through` day counts.
    clauses.push('te.started_at < ?');
    params.push(`${filter.through}T23:59:59.999Z`);
  }
  if (filter.ids !== undefined) {
    if (filter.ids.length === 0) return [];
    clauses.push(`te.id IN (${filter.ids.map(() => '?').join(', ')})`);
    params.push(...filter.ids);
  }
  return ctx.store.db
    .prepare(
      `SELECT te.id, te.project_id, te.phase_id, te.started_at, te.minutes, te.billable, te.notes,
              te.status, te.rate_minor, te.rate_currency, te.invoice_line_id,
              p.contact_id AS project_contact_id
         FROM time_entry te
         JOIN project p ON p.id = te.project_id AND p.workspace_id = te.workspace_id
        WHERE ${clauses.join(' AND ')}
        ORDER BY p.contact_id, te.project_id, te.phase_id, te.started_at, te.id`,
    )
    .all(...params) as BillableRow[];
}

/** One entry's derived value in Rappen (round-once, P2), or 0 for a still-running (null-minutes)
 *  row, which an approved entry never is. Identical to B01's `time_list` figure by construction. */
function valueOf(row: BillableRow): number {
  return row.minutes === null ? 0 : entryValueMinor(row.minutes, row.rate_minor);
}

// --- US-B02.1: the unbilled preview ------------------------------------------------------------

export interface UnbilledPreviewInput {
  contactId?: string;
  projectId?: string;
  throughDate?: string;
  groupBy?: string;
}

/**
 * US-B02.1: the approved-unbilled pile, grouped contact -> project -> phase, each entry valued
 * round-once and every subtotal an integer sum (no re-rounding). A pure read (P1); the panel renders
 * exactly these numbers. An empty pile is `{ groups: [], totalRappen: 0 }`, a healthy state.
 */
export function unbilledPreview(ctx: WorkspaceContext, input: UnbilledPreviewInput = {}): Result {
  if (input.groupBy !== undefined && !isGroupBy(input.groupBy)) {
    return err('invalid_input', { field: 'groupBy', known: BILLING_GROUP_BY });
  }
  const rows = eligibleEntries(ctx, {
    ...(input.contactId !== undefined ? { contactId: input.contactId } : {}),
    ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
    ...(input.throughDate !== undefined ? { through: input.throughDate } : {}),
  });

  interface PhaseGroup { phaseId: string | null; entries: { id: string; startedAt: string; minutes: number; notes: string | null; valueRappen: number }[]; subtotalRappen: number }
  interface ProjectGroup { projectId: string; phases: Map<string, PhaseGroup>; subtotalRappen: number }
  interface ContactGroup { contactId: string | null; projects: Map<string, ProjectGroup>; subtotalRappen: number; currency: string | null }

  const contacts = new Map<string, ContactGroup>();
  let totalRappen = 0;

  for (const row of rows) {
    const value = valueOf(row);
    totalRappen += value;
    const cKey = row.project_contact_id ?? '__nogroup__';
    let c = contacts.get(cKey);
    if (c === undefined) {
      c = { contactId: row.project_contact_id, projects: new Map(), subtotalRappen: 0, currency: row.rate_currency };
      contacts.set(cKey, c);
    }
    c.subtotalRappen += value;
    let p = c.projects.get(row.project_id);
    if (p === undefined) {
      p = { projectId: row.project_id, phases: new Map(), subtotalRappen: 0 };
      c.projects.set(row.project_id, p);
    }
    p.subtotalRappen += value;
    const phKey = row.phase_id ?? '__nogroup__';
    let ph = p.phases.get(phKey);
    if (ph === undefined) {
      ph = { phaseId: row.phase_id, entries: [], subtotalRappen: 0 };
      p.phases.set(phKey, ph);
    }
    ph.subtotalRappen += value;
    ph.entries.push({ id: row.id, startedAt: row.started_at, minutes: row.minutes as number, notes: row.notes, valueRappen: value });
  }

  const groups = [...contacts.values()].map((c) => ({
    contactId: c.contactId,
    currency: c.currency,
    subtotalRappen: c.subtotalRappen,
    projects: [...c.projects.values()].map((p) => ({
      projectId: p.projectId,
      subtotalRappen: p.subtotalRappen,
      phases: [...p.phases.values()].map((ph) => ({
        phaseId: ph.phaseId,
        subtotalRappen: ph.subtotalRappen,
        entries: ph.entries,
      })),
    })),
  }));

  return ok({ groups, totalRappen, entryCount: rows.length });
}

// --- US-B02.2: generate a draft invoice --------------------------------------------------------

export interface GenerateInvoiceInput {
  contactId?: string;
  timeEntryIds?: unknown;
  groupBy?: string;
  throughDate?: string;
  actor?: string;
  idempotencyKey?: string;
}

/** The revenue account's default tax code, the one code every time-billing line carries (P6, one
 *  resolve). NULL when no default is set: a non-registered freelancer's line bears no VAT, honestly. */
function billingTaxCode(ctx: WorkspaceContext): string | null {
  const row = ctx.store.db
    .prepare("SELECT vat_code_default FROM account WHERE workspace_id = ? AND number = ?")
    .get(ctx.workspaceId, DEFAULT_REVENUE_ACCOUNT) as { vat_code_default: string | null } | undefined;
  return row?.vat_code_default ?? null;
}

/** The line description for a group, human-facing, carrying the hours the qty=1 line cannot show. */
function describeGroup(groupBy: BillingGroupBy, key: { projectId: string; phaseId: string | null; day: string | null }, minutes: number): string {
  const hours = (minutes / 60).toLocaleString('de-CH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const base =
    groupBy === 'day' && key.day !== null
      ? `Arbeitszeit ${key.day}`
      : groupBy === 'phase' && key.phaseId !== null
        ? 'Arbeitszeit (Phase)'
        : 'Arbeitszeit';
  return `${base}: ${hours} Std.`;
}

/** The grouping key a `groupBy` collapses entries onto. */
function groupKeyOf(groupBy: BillingGroupBy, row: BillableRow): string {
  switch (groupBy) {
    case 'entry':
      return `e:${row.id}`;
    case 'phase':
      return `ph:${row.phase_id ?? ''}`;
    case 'day':
      return `d:${row.started_at.slice(0, 10)}`;
    case 'project':
    default:
      return `p:${row.project_id}`;
  }
}

/**
 * US-B02.2: turn a selection of approved billable unbilled entries into an A11 invoice DRAFT and flip
 * the entries `approved -> billed` in the SAME transaction. Delegates to A10 `createDocument` (P3): no
 * journal entry, no total, no VAT amount minted here. Idempotent on `idempotencyKey` (a replay returns
 * the first invoice and flips nothing twice). Every refusal is pre-checked before any write (TX-atomic).
 */
export function generateInvoice(ctx: WorkspaceContext, input: GenerateInvoiceInput): Result {
  // Replay a completed generation before any state guard, so a retry returns the FIRST invoice rather
  // than an `already_billed` on the entries it itself billed (§H-IDEMPOTENT).
  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    const replay = ctx.store.recallIdempotent<Result>(ctx.workspaceId, input.idempotencyKey, 'billing_generate_invoice');
    if (replay !== undefined) return replay;
  }

  if (typeof input.contactId !== 'string' || input.contactId.length === 0) {
    return err('invalid_input', { field: 'contactId' });
  }
  const groupBy: BillingGroupBy = isGroupBy(input.groupBy) ? input.groupBy : 'project';
  if (input.groupBy !== undefined && !isGroupBy(input.groupBy)) {
    return err('invalid_input', { field: 'groupBy', known: BILLING_GROUP_BY });
  }
  if (!Array.isArray(input.timeEntryIds) || input.timeEntryIds.some((e) => typeof e !== 'string' || e.length === 0)) {
    return err('invalid_input', { field: 'timeEntryIds' });
  }
  const ids = [...new Set(input.timeEntryIds as string[])];
  // Empty selection is a structured refusal, never a zero-line invoice (spec §2 empty).
  if (ids.length === 0) return err('empty_selection');

  const contactId = input.contactId;
  // §H-TENANT: the debtor must be THIS tenant's contact. A foreign or missing id gets the same
  // structured refusal, so an id can never be probed across tenants.
  const contact = ctx.store.db
    .prepare('SELECT id FROM contact WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, contactId) as { id: string } | undefined;
  if (contact === undefined) return err('invalid_reference', { field: 'contactId', contactId });

  // Read the selected rows through the tenant-scoped eligibility query. A row missing here is either
  // not this tenant's, not approved, not billable, or already billed: distinguish those below by
  // re-reading the raw row, so the caller gets the SPECIFIC refusal (the whole point of no silent
  // partial billing, US-B02.3).
  const eligible = eligibleEntries(ctx, { ids });
  const eligibleById = new Map(eligible.map((r) => [r.id, r]));
  const alreadyBilled: string[] = [];
  const notFound: string[] = [];
  const notEligible: string[] = [];
  for (const id of ids) {
    if (eligibleById.has(id)) continue;
    const raw = ctx.store.db
      .prepare('SELECT status, billable, invoice_line_id FROM time_entry WHERE workspace_id = ? AND id = ?')
      .get(ctx.workspaceId, id) as { status: string; billable: number; invoice_line_id: string | null } | undefined;
    if (raw === undefined) notFound.push(id);
    else if (raw.status === 'billed' || raw.invoice_line_id !== null) alreadyBilled.push(id);
    else notEligible.push(id);
  }
  // Strict, no silent partial invoice (US-B02.3): the whole call fails on the first blocking class.
  if (alreadyBilled.length > 0) return err('already_billed', { entryIds: alreadyBilled });
  if (notFound.length > 0) return err('entry_not_found', { entryIds: notFound });
  if (notEligible.length > 0) return err('not_billable', { entryIds: notEligible });

  const rows = ids.map((id) => eligibleById.get(id) as BillableRow);

  // ONE invoice, ONE debtor: every selected entry's project must belong to the named contact.
  const mixed = rows.filter((r) => r.project_contact_id !== contactId).map((r) => r.id);
  if (mixed.length > 0) return err('mixed_contacts', { entryIds: mixed, contactId });

  // ONE currency: B02 never silently converts a rate. The invoice bills in the entries' common rate
  // currency; any entry priced in another currency is refused (§H-FX: A11 stores the CHF conversion).
  const currencies = [...new Set(rows.map((r) => r.rate_currency))];
  if (currencies.length > 1) {
    return err('currency_mismatch', { entryIds: rows.map((r) => r.id), currencies });
  }
  const currency = currencies[0] as string;

  // Resolve the tax code ONCE (P6, §H-VAT-TRACE). A non-null code is validated through A05 so a
  // misconfigured default is a pre-write refusal, never a surprise at issue; the code travels on the
  // line and A11 resolves the amount at issue (its tested `buildInvoicePosting` path).
  const supplyDate = input.throughDate ?? today(ctx);
  const taxCode = billingTaxCode(ctx);
  if (taxCode !== null) {
    const resolved = resolveTax(ctx, { taxCode, supplyDate });
    if (!resolved.ok) return resolved;
  }

  // Build the line groups, each an INTEGER SUM of entry values (no re-rounding, P2). Insertion order
  // is stable so the created invoice lines pair back to their groups by index.
  interface LineGroup { key: string; projectId: string; phaseId: string | null; day: string | null; entryIds: string[]; valueRappen: number; minutes: number }
  const groupMap = new Map<string, LineGroup>();
  const order: string[] = [];
  let totalRappen = 0;
  for (const row of rows) {
    const value = valueOf(row);
    totalRappen += value;
    const key = groupKeyOf(groupBy, row);
    let g = groupMap.get(key);
    if (g === undefined) {
      g = { key, projectId: row.project_id, phaseId: row.phase_id, day: row.started_at.slice(0, 10), entryIds: [], valueRappen: 0, minutes: 0 };
      groupMap.set(key, g);
      order.push(key);
    }
    g.entryIds.push(row.id);
    g.valueRappen += value;
    g.minutes += row.minutes ?? 0;
  }
  const lineGroups = order.map((k) => groupMap.get(k) as LineGroup);

  const run = (): Result => {
    const lines: DocumentLineInput[] = lineGroups.map((g) => ({
      description: describeGroup(groupBy, g, g.minutes),
      // qty = 1 unit; the summed value is the unit price, so A10's `lineTotal` returns the exact
      // integer sum and never re-rounds (the single-rounding-point law made concrete).
      quantityMilli: 1000,
      unitPriceMinor: g.valueRappen,
      taxCode,
    }));
    const created = createDocument(ctx, {
      type: 'invoice',
      contactId,
      currency,
      lines,
      notes: 'Zeitabrechnung',
    });
    if (!created.ok) throw new BillingAbort(created);
    const invoice = created as unknown as { document: { id: string }; lines: { id: string }[] };
    const invoiceId = invoice.document.id;
    const now = ctx.clock.now();
    const flip = ctx.store.db.prepare(
      "UPDATE time_entry SET status = 'billed', invoice_line_id = ?, updated_at = ? WHERE workspace_id = ? AND id = ?",
    );
    const lineIds: string[] = [];
    const billedEntryIds: string[] = [];
    lineGroups.forEach((g, index) => {
      const lineId = invoice.lines[index]?.id;
      if (lineId === undefined) throw new BillingAbort(err('invoice_line_missing', { position: index + 1 }));
      lineIds.push(lineId);
      for (const entryId of g.entryIds) {
        flip.run(lineId, now, ctx.workspaceId, entryId);
        billedEntryIds.push(entryId);
      }
    });
    return ok({ invoiceId, lineIds, billedEntryIds, totalRappen, currency });
  };

  try {
    if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
      return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'billing_generate_invoice', run);
    }
    return ctx.store.tx(run);
  } catch (e) {
    if (e instanceof BillingAbort) return e.result;
    throw e;
  }
}

// --- US-B02.3: release billed time back to the pile --------------------------------------------

export interface ReleaseLinesInput {
  invoiceId?: string;
  lineIds?: unknown;
  actor?: string;
  idempotencyKey?: string;
}

/**
 * US-B02.3: revert `billed -> approved` and clear `invoice_line_id` for the entries backing a
 * cancelled draft invoice's lines. Called by A11's cancel hook and directly. Refuses a finalised
 * (non-draft) invoice with `invoice_not_draft` (corrections there are A11's credit-note path).
 * Releasing already-released lines is a no-op (idempotent). Every refusal is pre-checked (TX-atomic).
 */
export function releaseLines(ctx: WorkspaceContext, input: ReleaseLinesInput): Result {
  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    const replay = ctx.store.recallIdempotent<Result>(ctx.workspaceId, input.idempotencyKey, 'billing_release_time');
    if (replay !== undefined) return replay;
  }

  const hasInvoice = typeof input.invoiceId === 'string' && input.invoiceId.length > 0;
  const hasLines = Array.isArray(input.lineIds) && input.lineIds.length > 0;
  if (hasInvoice === hasLines) {
    // Exactly one of the two selectors, never both and never neither (spec §5 `invoice_id | line_ids`).
    return err('invalid_input', { field: 'invoiceId|lineIds' });
  }

  // Resolve the target invoice line ids and the invoice they belong to, tenant-scoped. Both paths end
  // at a set of `document_line` ids whose backing entries we release.
  let invoiceId: string;
  let lineIdSet: string[];
  if (hasInvoice) {
    invoiceId = input.invoiceId as string;
    const doc = ctx.store.db
      .prepare('SELECT id, type, status FROM document WHERE workspace_id = ? AND id = ?')
      .get(ctx.workspaceId, invoiceId) as { id: string; type: string; status: string } | undefined;
    if (doc === undefined) return err('not_found', { invoiceId });
    if (doc.type !== 'invoice') return err('not_an_invoice', { invoiceId, type: doc.type });
    // A finalised invoice never releases (spec §2 boundary): only a draft can, since only a draft's
    // cancel returns the time to the pile. Pre-checked before any write.
    if (doc.status !== 'draft') return err('invoice_not_draft', { invoiceId, status: doc.status });
    lineIdSet = (
      ctx.store.db
        .prepare('SELECT id FROM document_line WHERE workspace_id = ? AND document_id = ?')
        .all(ctx.workspaceId, invoiceId) as { id: string }[]
    ).map((r) => r.id);
  } else {
    const lineIds = [...new Set(input.lineIds as string[])];
    if (lineIds.some((l) => typeof l !== 'string' || l.length === 0)) return err('invalid_input', { field: 'lineIds' });
    // The lines must all belong to ONE draft invoice in this tenant (release is per document).
    const docs = ctx.store.db
      .prepare(
        `SELECT DISTINCT d.id, d.type, d.status
           FROM document_line dl JOIN document d ON d.id = dl.document_id AND d.workspace_id = dl.workspace_id
          WHERE dl.workspace_id = ? AND dl.id IN (${lineIds.map(() => '?').join(', ')})`,
      )
      .all(ctx.workspaceId, ...lineIds) as { id: string; type: string; status: string }[];
    if (docs.length === 0) return err('not_found', { lineIds });
    if (docs.length > 1) return err('mixed_invoices', { invoiceIds: docs.map((d) => d.id) });
    const doc = docs[0] as { id: string; type: string; status: string };
    if (doc.type !== 'invoice') return err('not_an_invoice', { invoiceId: doc.id, type: doc.type });
    if (doc.status !== 'draft') return err('invoice_not_draft', { invoiceId: doc.id, status: doc.status });
    invoiceId = doc.id;
    lineIdSet = lineIds;
  }

  // The entries currently billed onto those lines. An empty set is the idempotent no-op (already
  // released, or a draft with no time-backed lines): a clean ok, never an error.
  const targets =
    lineIdSet.length === 0
      ? []
      : (ctx.store.db
          .prepare(
            `SELECT id FROM time_entry
              WHERE workspace_id = ? AND status = 'billed' AND invoice_line_id IN (${lineIdSet.map(() => '?').join(', ')})`,
          )
          .all(ctx.workspaceId, ...lineIdSet) as { id: string }[]).map((r) => r.id);

  const run = (): Result => {
    const now = ctx.clock.now();
    const revert = ctx.store.db.prepare(
      "UPDATE time_entry SET status = 'approved', invoice_line_id = NULL, updated_at = ? WHERE workspace_id = ? AND id = ?",
    );
    for (const id of targets) revert.run(now, ctx.workspaceId, id);
    return ok({ invoiceId, releasedEntryIds: targets, releasedCount: targets.length });
  };

  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'billing_release_time', run);
  }
  return ctx.store.tx(run);
}

// --- US-B02.4: the WIP report ------------------------------------------------------------------

export interface WipReportInput {
  asOf?: string;
  projectId?: string;
  contactId?: string;
}

/**
 * US-B02.4: approved-but-unbilled value as of a date, per project (and its client), purely (P5, no
 * cached state). `wip_rappen = Sum(round-once(minutes x rate / 60))` over the SAME eligibility the
 * preview and generation read, so WIP minus invoiced nets to zero to the Rappen. Informational only:
 * B02 never posts the OR 960c angefangene Arbeiten entry (P3); a Treuhänder posts it manually from
 * these numbers. `as_of` cuts on `started_at`; earlier than every entry returns zero.
 *
 * RECONCILED (spec §2's "OR billed after as_of"): B01 stores no `billed_at`, so a point-in-time
 * reconstruction of what WAS unbilled on a past date is not derivable. WIP is therefore the CURRENTLY
 * unbilled approved value with `started_at <= as_of`, which is the honest read the schema supports.
 */
export function wipReport(ctx: WorkspaceContext, input: WipReportInput = {}): Result {
  const asOf = typeof input.asOf === 'string' && input.asOf.length >= 10 ? input.asOf.slice(0, 10) : today(ctx);
  const rows = eligibleEntries(ctx, {
    through: asOf,
    ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
    ...(input.contactId !== undefined ? { contactId: input.contactId } : {}),
  });

  interface WipRow { projectId: string; contactId: string | null; wipRappen: number; minutes: number; entryCount: number; oldestStartedAt: string | null; currency: string | null }
  const byProject = new Map<string, WipRow>();
  let totalRappen = 0;
  for (const row of rows) {
    const value = valueOf(row);
    totalRappen += value;
    let w = byProject.get(row.project_id);
    if (w === undefined) {
      w = { projectId: row.project_id, contactId: row.project_contact_id, wipRappen: 0, minutes: 0, entryCount: 0, oldestStartedAt: null, currency: row.rate_currency };
      byProject.set(row.project_id, w);
    }
    w.wipRappen += value;
    w.minutes += row.minutes ?? 0;
    w.entryCount += 1;
    if (w.oldestStartedAt === null || row.started_at < w.oldestStartedAt) w.oldestStartedAt = row.started_at;
  }

  const asOfMs = Date.parse(`${asOf}T00:00:00Z`);
  const wipRows = [...byProject.values()].map((w) => {
    const oldestDay = w.oldestStartedAt === null ? null : w.oldestStartedAt.slice(0, 10);
    const oldestAgeDays =
      oldestDay === null ? null : Math.max(0, Math.round((asOfMs - Date.parse(`${oldestDay}T00:00:00Z`)) / 86400000));
    return {
      projectId: w.projectId,
      contactId: w.contactId,
      currency: w.currency,
      wipRappen: w.wipRappen,
      minutes: w.minutes,
      entryCount: w.entryCount,
      oldestEntryDate: oldestDay,
      oldestEntryAgeDays: oldestAgeDays,
    };
  });

  return ok({ rows: wipRows, totalRappen, asOf });
}
