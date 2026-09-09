/**
 * A10, the document lifecycle: the single P7 state machine for quote / order / invoice / credit_note.
 *
 * Quotes (Offerte), orders (Auftrag), invoices (Rechnung) and credit notes (Gutschrift) are one object
 * at different points in its life. They share the numbering series, the guarded transition table, the
 * status trail, and the rule that issuing a financial document posts a ledger entry while cancelling
 * one reverses it, never deletes it (§H-AUDIT). This module owns that machine; A11/A12/A13/A15 ride on
 * it, adding only type-specific behaviour through the poster seam below.
 *
 * A10 knows *when* posting happens and that it must balance; it does NOT know VAT codes or account
 * numbers. The money legs are built by the type's poster (the `onIssue` delegate), which A11 (invoice)
 * and A13 (credit note) register. Here, quote and order have no-op posters (issuing posts nothing) and
 * the invoice/credit_note posters are left UNREGISTERED for A11/A13 to fill: issuing one before its
 * delegate lands is an honest `posting_delegate_unregistered`, never a silent untaxed post.
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { reverseEntry } from '../ledger/reverseEntry.js';
import { statesConversionBasis } from '../ledger/postEntry.js';
import { baseCurrencyOf } from '../fx/rates.js';
import { ROLE_ACCOUNT_NUMBER } from '../payments/accounts.js';
// D78: A14 owns the ONE settlement-status derivation, and the credit-note transitions call it
// rather than restate it. A leaf-safe import: `payment.ts` imports nothing from `sales/`.
import { refreshSettledByCredit } from '../payments/payment.js';
// G00's saved-view seam. A leaf import: the customization module knows nothing about documents.
import { applySavedView } from '../customization/views.js';
// G05: freeze the default template (id + snapshot) at issue, the same moment the number does.
import { freezeRenderedTemplate } from '../customization/documentTemplates.js';
// The LEAF module, never the files barrel: the barrel pulls `node:crypto` in through the upload
// hash, and the posting paths' runtime closure is held browser-pure by `studio-sees-payloads.test.mjs`.
import { deriveStatutoryOnPost } from '../files/postedFloor.js';

// --- The two fixed §H-ENUM value lists this spec owns (spec §4) --------------------------------

/** `document.type` (fixed §H-ENUM): the type governs the poster delegate and the numbering series. */
export const DOCUMENT_TYPES = ['quote', 'order', 'invoice', 'credit_note'] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

/** `document.status` (fixed §H-ENUM): the legal state trail an auditor reads. Not every status is
 *  legal for every type; the per-type guard table below is the restriction. "Überfällig" (overdue) is
 *  NOT here: it is a derived display state (A15/A16), computed at read time, never stored. */
export const DOCUMENT_STATUSES = [
  'draft',
  'issued',
  'sent',
  'accepted',
  'declined',
  'confirmed',
  'partially_paid',
  'settled',
  'converted',
  'cancelled',
  'expired',
  'superseded',
] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

/**
 * `document.origin` (fixed §H-ENUM, G21): a document is either `native` (the ordinary A10 one that
 * posts a balanced ledger entry when it issues) or `migrated` (an open item carried across from an
 * old system at a cutover). A migrated document is created DIRECTLY at `status='issued'` by G21's
 * `importOpenItems`, never through `createDocument` + `transitionDocument`, and it posts NOTHING of
 * its own: its `posted_entry_id` is NULL and its only ledger effect is the aggregate 1100 Debitoren
 * line inside A04's opening entry. `vendor_bill.origin` mirrors it on the AP side.
 *
 * It is a fixed §H-ENUM and never a custom field or a per-workspace value, because it selects whether
 * the poster runs, which is a money-path decision (spec §6b Fixed). Single-sourced HERE and imported
 * by `vendor_bill.ts` and G21's `openItems.ts`, so the AP mirror and the migration writer read one
 * definition rather than restating it.
 */
export const DOCUMENT_ORIGINS = ['native', 'migrated'] as const;
export type Origin = (typeof DOCUMENT_ORIGINS)[number];

/** The §H-ENUM case guard: is `value` a known origin? Used at the migration writer's door. */
export function isOrigin(value: unknown): value is Origin {
  return typeof value === 'string' && (DOCUMENT_ORIGINS as readonly string[]).includes(value);
}

/**
 * The per-type guard table (the P7 graph, spec §4). `assertTransition` rejects any `(from,to)` pair
 * not listed here with P9 `illegal_transition`. This IS Pattern P7: an automation rule may react to a
 * transition or invoke one, but nothing may add a status, a type, or fork the machine. New document
 * KINDS register here as a reviewed foundation extension, never a per-workspace customization.
 *
 * Payment states (`partially_paid`, `settled`) are reached through A14's payment allocation, not a
 * bare `transition_document` call, so they are NOT caller-invokable targets here (A14 extends the
 * table when it lands). `converted` is reached through `convertDocument`, not `transitionDocument`.
 * Since D78 an invoice also reaches `settled` when its payments PLUS issued credit notes cover it
 * exactly (and walks back out when a covering credit is cancelled): still A14's derivation, called
 * from the credit-note transition below, never a caller-invokable edge.
 */
const TRANSITIONS: Record<DocumentType, Partial<Record<DocumentStatus, readonly DocumentStatus[]>>> = {
  quote: {
    draft: ['issued', 'cancelled'],
    issued: ['sent', 'cancelled'],
    sent: ['accepted', 'declined', 'expired', 'superseded', 'cancelled'],
    declined: ['superseded'],
    expired: ['superseded'],
  },
  order: {
    draft: ['issued', 'cancelled'],
    issued: ['sent', 'cancelled'],
    sent: ['confirmed', 'cancelled'],
  },
  invoice: {
    draft: ['issued', 'cancelled'],
    issued: ['sent', 'cancelled'],
    sent: ['cancelled'],
    partially_paid: ['cancelled'],
  },
  credit_note: {
    draft: ['issued', 'cancelled'],
    issued: ['sent', 'cancelled'],
    sent: ['cancelled'],
    partially_paid: ['cancelled'],
  },
};

/**
 * The convert graph: which status a source must be in to convert, and the target types it may become
 * (spec §4). Convert is `convertDocument`, not a `transitionDocument` edge; on success the source is
 * marked the terminal `converted`.
 */
const CONVERSIONS: Partial<Record<DocumentType, { from: DocumentStatus; toTypes: readonly DocumentType[] }>> = {
  quote: { from: 'accepted', toTypes: ['order', 'invoice'] },
  order: { from: 'confirmed', toTypes: ['invoice'] },
};

/** The number-mask prefix per type (D32): R Rechnung, O Offerte, A Auftrag, G Gutschrift. */
const NUMBER_PREFIX: Record<DocumentType, string> = {
  invoice: 'R',
  quote: 'O',
  order: 'A',
  credit_note: 'G',
};

/** D34: `listDocuments` loads all rows up to this documented ceiling, flagging truncation past it. */
export const DOCUMENT_LIST_CEILING = 1000;

// --- The poster delegate seam (P3) -------------------------------------------------------------

/**
 * The single extension point A11 (invoice) and A13 (credit note) fill. `onIssue` builds and posts the
 * type's balanced ledger entry when the document is issued, returning the entry id; a type that posts
 * nothing (quote, order) returns `ok({})`. `onCancel` reverses a posted entry (§H-AUDIT: never a
 * delete). A10 registers no-op posters for quote/order and reversing posters for invoice/credit_note
 * whose `onIssue` is UNREGISTERED until A11/A13 override it.
 */
export interface DocumentPoster {
  /** True if issuing this type posts a ledger entry (invoice, credit_note); false for quote/order. */
  readonly posts: boolean;
  /** Build and post the issue entry. `ok({ postedEntryId })` when it posts, `ok({})` when it does not. */
  onIssue(ctx: WorkspaceContext, doc: DocumentRow): Result;
  /** Reverse the posted entry on cancel (posted documents only). `ok({ reversalEntryId })` or `ok({})`. */
  onCancel(ctx: WorkspaceContext, doc: DocumentRow): Result;
}

const NO_OP_POSTER: DocumentPoster = {
  posts: false,
  onIssue: () => ok({}),
  onCancel: () => ok({}),
};

/** The base poster for the financial types: `onIssue` is A11/A13's to fill; `onCancel` reverses. */
function reversingPoster(): DocumentPoster {
  return {
    posts: true,
    onIssue: (_ctx, doc) => err('posting_delegate_unregistered', { type: doc.type }),
    onCancel: (ctx, doc) => {
      if (doc.posted_entry_id === null) return ok({});
      const reversed = reverseEntry(ctx, {
        entryId: doc.posted_entry_id,
        idempotencyKey: `doc-cancel-${doc.id}`,
      });
      if (!reversed.ok) return reversed;
      return ok({ reversalEntryId: reversed.reversalId });
    },
  };
}

const POSTERS = new Map<DocumentType, DocumentPoster>([
  ['quote', NO_OP_POSTER],
  ['order', NO_OP_POSTER],
  ['invoice', reversingPoster()],
  ['credit_note', reversingPoster()],
]);

/**
 * Register a type's poster. A11 calls `registerDocumentPoster('invoice', ...)` and A13
 * `registerDocumentPoster('credit_note', ...)` to supply the real `onIssue` that builds the posting
 * lines. This is the ONE place a document may gain a posting path (P3: no second path).
 */
export function registerDocumentPoster(type: DocumentType, poster: DocumentPoster): void {
  POSTERS.set(type, poster);
}

function posterFor(type: DocumentType): DocumentPoster {
  return POSTERS.get(type) ?? NO_OP_POSTER;
}

// --- Row shapes --------------------------------------------------------------------------------

export interface DocumentRow {
  id: string;
  workspace_id: string;
  type: DocumentType;
  number: string | null;
  status: DocumentStatus;
  /** G21: `native` or `migrated`. NULL is never stored (the column is `NOT NULL DEFAULT 'native'`);
   *  typed non-null so every reader sees a concrete origin. */
  origin: Origin;
  contact_id: string | null;
  currency: string;
  source_document_id: string | null;
  posted_entry_id: string | null;
  subtotal_minor: number;
  tax_minor: number;
  total_minor: number;
  issue_date: string | null;
  due_date: string | null;
  /** A11's column: who an invoice was emailed to. Null until a REAL transmission (GAP A). */
  sent_to_email: string | null;
  /** A13's column: the invoice a Gutschrift credits. NULL for every other type, and for a
   *  credit-note draft made through the generic verb (which can therefore never post). */
  credited_document_id: string | null;
  notes: string | null;
  created_at: string;
  /**
   * Not a stored column: the reverse of `source_document_id`, computed by `DOCUMENT_SELECT` (GAP B).
   * Optional on the row type because a raw `SELECT *` elsewhere would not carry it.
   */
  target_document_id?: string | null;
  /**
   * Not stored columns either: the base-currency total and the rate the POSTED entry carries,
   * derived by `DOCUMENT_SELECT` (GAP C). Both are null until the document posts, and the rate is
   * additionally null whenever the posting converted nothing. Optional for the same reason
   * `target_document_id` is: a raw `SELECT *` elsewhere would not carry them.
   */
  total_base_minor?: number | null;
  fx_rate?: string | null;
  /**
   * Nor is this one: the VAT the POSTED entry put into the books in the BASE currency, derived by
   * `DOCUMENT_SELECT`. Distinguish its two falsy answers carefully. NULL means the subquery summed
   * nothing at all, which happens both when the document has not posted and when it posted without
   * charging VAT; `mapDocument` separates those two using `posted_entry_id`, because "no VAT was
   * charged" is zero francs and "nothing is booked yet" is unknown.
   */
  base_tax_minor?: number | null;
}

interface DocumentLineRow {
  id: string;
  document_id: string;
  workspace_id: string;
  position: number;
  item_id: string | null;
  description: string | null;
  quantity_milli: number;
  unit_price_minor: number;
  line_total_minor: number;
  tax_code: string | null;
  supply_date: string | null;
  /** A13 §4b.1: the invoice position a derived credit line attributes to. NULL everywhere else. */
  credited_line_position: number | null;
}

export interface DocumentLineInput {
  itemId?: string | null;
  description?: string | null;
  /** Quantity in thousandths (10.5 -> 10500). Defaults to 1000 (one unit). Integer, never a float. */
  quantityMilli?: number;
  unitPriceMinor: number;
  taxCode?: string | null;
  supplyDate?: string | null;
  /**
   * A13 §4b.1, the ATTRIBUTION: which invoice position this credit line derives from. Only
   * `createCreditNote`'s derivation ever sets it (the one writer); `updateDocument` refuses line
   * patches on an FK-carrying credit note outright, so no edit path can null it, and a value forged
   * through the generic `create_document` is inert because that path cannot set the FK the poster
   * requires.
   */
  creditedLinePosition?: number | null;
}

export interface CreateDocumentInput {
  type: string;
  contactId?: string | null;
  lines?: DocumentLineInput[];
  currency?: string;
  dueDate?: string | null;
  notes?: string | null;
  idempotencyKey?: string;
}

export interface UpdateDocumentPatch {
  contactId?: string | null;
  lines?: DocumentLineInput[];
  currency?: string;
  dueDate?: string | null;
  notes?: string | null;
}

// --- Mapping and reads -------------------------------------------------------------------------

/**
 * The ONE projection every document read goes through, so the read model cannot differ between
 * `get_document`, `list_documents`, and the view `convert_document` returns.
 *
 * `target_document_id` is the reverse of `source_document_id` (GAP B): the document this one was
 * converted INTO. A10-G6 ("converted documents are dead ends") needs the link in that direction, and
 * without it the Studio derived it client-side by scanning `list_documents` for converted documents,
 * which inherits the D34 1000-row ceiling and breaks silently past it. One correlated subquery,
 * §H-TENANT scoped on BOTH sides (the target must be in the same workspace as the source), turns
 * that scan into a read. `convertDocument`'s state guard means a source has at most one target;
 * `ORDER BY created_at, rowid LIMIT 1` keeps the answer deterministic regardless.
 */
// The two FX columns are DERIVED from the posted entry on every read, never stored beside it, and
// that is the whole design (§H-FX, GAP C). A converted total written onto `document` would be a
// second source of truth for a number the ledger already owns: any correction, re-post or future
// migration could move one without the other, and a read model that disagrees with the books is
// worse than one that stays silent. Deriving makes the disagreement unrepresentable instead of
// merely unlikely, and it costs one correlated subquery on a `posted_entry_id` that is already
// indexed by `journal_line.entry_id`.
//
// `base_debit_minor` is summed over the WHOLE entry rather than over the debtor account, because
// A10 does not know which account the type's poster used. For every document entry the only debits
// ARE the debtor legs (the poster credits revenue and VAT), so the sum is the receivable in base
// currency, which is exactly the figure `buildInvoicePosting` reads back for its own rejection
// payload. `total_base_minor` is NULL for a draft: nothing is posted, so no rate has been stamped
// and there is no base total to report. Predicting one from today's rate store would be the engine
// promising a price it has not fixed.
//
// The rate is read off the posted rows for the same reason: re-resolving it here would let a rate
// imported after the fact reprice an invoice that is already in the books.
//
// `base_tax_minor` is the third derived column and the one an MWST-Abrechnung is filed on. It sums
// the OUTPUT VAT account's base credits net of its base debits, over the posted entry:
//
//   - the account NUMBER comes from `ROLE_ACCOUNT_NUMBER.outputVat`, the single enumeration point
//     A05's `buildVatLines` and A14's Skonto leg already route by, never a '2200' literal typed
//     here. A05 routes an OUTPUT code to that account and A02's post-boundary gate refuses an entry
//     whose 2200 movement disagrees with the codes, so this is where a sales document's VAT is, as
//     a property the ledger enforces rather than a convention this file hopes holds;
//   - CREDITS NET OF DEBITS, because A10 reverses a cancelled document rather than deleting it
//     (§H-AUDIT) and A13's credit note books the mirror. Summing absolute credits would report a
//     reversed invoice's VAT twice over, with the sign that says "owed" both times;
//   - one rounding, none of it ours. The figure is read, never computed: `applyFx` rounds ONCE on
//     the side TOTAL and allocates the result back over the lines by largest remainder, so
//     `taxMinor * fxRate` is a SECOND opinion about the ledger's rounding. On a real two-rate EUR
//     invoice it is one Rappen out (test/sales/document-base-vat.test.mjs), and a filer who
//     multiplied would put a number on Ziffer 303 that account 2200 cannot reconcile to.
//
// Scoped to the workspace on BOTH sides, like `target_document_id` above: the account must belong to
// the same workspace as the document whose entry names it (§H-TENANT).
const DOCUMENT_SELECT = `SELECT d.*, (
    SELECT SUM(jl.base_credit_minor - jl.base_debit_minor)
      FROM journal_line jl JOIN account a ON a.id = jl.account_id
     WHERE jl.entry_id = d.posted_entry_id
       AND a.workspace_id = d.workspace_id
       AND a.number = '${ROLE_ACCOUNT_NUMBER.outputVat}'
  ) AS base_tax_minor, (
    SELECT t.id FROM document t
     WHERE t.workspace_id = d.workspace_id AND t.source_document_id = d.id
     ORDER BY t.created_at, t.rowid LIMIT 1
  ) AS target_document_id, (
    SELECT SUM(jl.base_debit_minor) FROM journal_line jl WHERE jl.entry_id = d.posted_entry_id
  ) AS total_base_minor, (
    SELECT jl.fx_rate FROM journal_line jl
     WHERE jl.entry_id = d.posted_entry_id AND jl.fx_rate IS NOT NULL LIMIT 1
  ) AS fx_rate
  FROM document d`;

/**
 * GAP C: what the BOOKS hold, beside what was billed.
 *
 * A11 composed exactly these figures at issue and documented them as "said out loud to the caller";
 * `transitionDocument` then read `postedEntryId` off the poster's result and dropped the rest, so
 * they reached nobody. They belong on the read model rather than on that one result: an FX figure is
 * a property of the document every time it is read, not a souvenir of the moment it was issued. Put
 * here, `get_document`, `list_documents` and `issue_invoice` all gain it from one change, and a
 * reload no longer loses it.
 *
 * Present only when the document states a conversion basis. That predicate is A02's
 * `statesConversionBasis`, imported rather than re-derived, because two copies of this rule is
 * precisely how the pegged case desynchronised before (§H-FX, docs/specs/03-fx-foundation.md
 * section 13). In a CHF book a CHF invoice converted nothing: `totalMinor` already IS what the books
 * hold, so restating it as a "base total" beside an identical `baseCurrency` would be noise on the
 * overwhelming majority of documents, and the same mistake as stamping a literal rate of 1 on every
 * franc row. A foreign document states its basis even when the rate is exactly 1.
 *
 * `fxRateAsOf` is deliberately NOT here, though A11's discarded summary carried it. The ledger does
 * not store it: `journal_line` keeps the rate STRING and the base amounts, and no `rate_as_of`
 * column exists on either journal table. Reporting it would mean re-resolving it from the mutable
 * `exchange_rate` store at read time, and a rate imported later (a BAZG feed, a corrected ESTV
 * quote) would then hand back a validity date that never priced this invoice. Every other field
 * here is the ledger's own; that one could only ever be a guess about it.
 */
function mapDocument(row: DocumentRow, baseCurrency: string) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    type: row.type,
    number: row.number,
    status: row.status,
    // G21: exposed quietly so a saved-view "Herkunft" column can show "Übernommen" for a migrated
    // item. There is NO shouting badge: a migrated open item is a normal open item everywhere else.
    origin: row.origin,
    contactId: row.contact_id,
    currency: row.currency,
    sourceDocumentId: row.source_document_id,
    // GAP B: the reverse link, so a converted document is a navigable dead end rather than one the
    // client has to reconstruct by listing everything.
    targetDocumentId: row.target_document_id ?? null,
    postedEntryId: row.posted_entry_id,
    subtotalMinor: row.subtotal_minor,
    taxMinor: row.tax_minor,
    totalMinor: row.total_minor,
    issueDate: row.issue_date,
    dueDate: row.due_date,
    // GAP A: A11 stores WHO an invoice was emailed to and the read model never exposed it, so M16's
    // "Versendet an kunde@example.ch" was unreachable after a reload. It is written ONLY after a
    // real transmission (see sendInvoice), which makes it the durable evidence of one.
    sentToEmail: row.sent_to_email ?? null,
    // A13: the invoice this Gutschrift credits, so the detail can link back and the invoice's
    // detail can list its credits (the `creditedDocumentId` filter below) in one read each.
    creditedDocumentId: row.credited_document_id ?? null,
    notes: row.notes,
    createdAt: row.created_at,
    // GAP C, and the one asymmetry worth naming: `totalBaseMinor` is null on a DRAFT because no rate
    // has been stamped yet, while `baseCurrency` is known from the start. The workspace base currency
    // is locked the moment anything posts (`needs_empty_ledger` in updateWorkspace), so for a posted
    // document it is provably the currency the ledger converted into, not merely today's setting.
    ...(statesConversionBasis({ currency: row.currency, baseCurrency })
      ? {
          totalBaseMinor: row.total_base_minor ?? null,
          fxRate: row.fx_rate ?? null,
          baseCurrency,
          // The figure a Swiss MWST-Abrechnung is filed on. `taxMinor` beside it is the transaction
          // VAT (EUR 121.50); this is the VAT the books actually hold (CHF 114.36), and the two are
          // different numbers on every foreign invoice that is not at parity. Until this landed the
          // franc one existed only in `journal_line.base_credit_minor` and reached no verb, so a
          // person preparing a return either read it out of SQLite or multiplied and hoped.
          //
          // `?? 0` is load-bearing and is NOT the same shortcut as `total_base_minor ?? null` above.
          // A posted entry always has base debits to sum, so that column is null only for a draft.
          // This one is null in TWO different worlds: a draft, and a posted invoice that charged no
          // VAT at all (a pure export under MWSTG Art. 23 books debtor and revenue and writes no
          // 2200 row for the subquery to find). Those are different answers. Nothing is booked yet
          // is unknown; nothing was charged is zero francs. `posted_entry_id` is what tells them
          // apart, and collapsing them would tell a filer that an invoice they issued last quarter
          // has not reached the books.
          baseTaxMinor: row.posted_entry_id === null ? null : (row.base_tax_minor ?? 0),
        }
      : {}),
  };
}

function mapLine(row: DocumentLineRow) {
  return {
    id: row.id,
    position: row.position,
    itemId: row.item_id,
    description: row.description,
    quantityMilli: row.quantity_milli,
    unitPriceMinor: row.unit_price_minor,
    lineTotalMinor: row.line_total_minor,
    taxCode: row.tax_code,
    supplyDate: row.supply_date,
    creditedLinePosition: row.credited_line_position ?? null,
  };
}

function readDocument(ctx: WorkspaceContext, id: string): DocumentRow | undefined {
  return ctx.store.db
    .prepare(`${DOCUMENT_SELECT} WHERE d.workspace_id = ? AND d.id = ?`)
    .get(ctx.workspaceId, id) as DocumentRow | undefined;
}

function readLines(ctx: WorkspaceContext, documentId: string): DocumentLineRow[] {
  return ctx.store.db
    .prepare('SELECT * FROM document_line WHERE document_id = ? ORDER BY position')
    .all(documentId) as DocumentLineRow[];
}

function readHistory(ctx: WorkspaceContext, documentId: string) {
  const rows = ctx.store.db
    .prepare(
      'SELECT from_status, to_status, actor, at FROM document_status_history WHERE document_id = ? ORDER BY at, rowid',
    )
    .all(documentId) as { from_status: string | null; to_status: string; actor: string | null; at: string }[];
  return rows.map((r) => ({ fromStatus: r.from_status, toStatus: r.to_status, actor: r.actor, at: r.at }));
}

/** The full read model: the document, its lines, and its status trail. */
function documentView(ctx: WorkspaceContext, row: DocumentRow) {
  return {
    document: mapDocument(row, baseCurrencyOf(ctx)),
    lines: readLines(ctx, row.id).map(mapLine),
    history: readHistory(ctx, row.id),
  };
}

// --- Helpers -----------------------------------------------------------------------------------

/** `quantity_milli * unit_price_minor / 1000`, rounded half away from zero, in integer Rappen. */
function lineTotal(quantityMilli: number, unitPriceMinor: number): number {
  const scaled = quantityMilli * unitPriceMinor;
  const half = scaled < 0 ? -Math.round(-scaled / 1000) : Math.round(scaled / 1000);
  return half;
}

/**
 * The rejection a negative position earns (m5). Discounts are NOT implemented: there is no discount
 * field on a position, and a negative price is the obvious way an operator reaches for one.
 *
 * It used to be accepted at create and then kill `issueInvoice` with
 * `{"account":"acc_4","reason":"amounts must be non-negative integer Rappen","error":"invalid_line"}`,
 * naming an internal account id the operator has never seen, at the moment they issue rather than
 * the moment they type. Refusing here names the POSITION and the missing capability instead.
 */
function negativeLineRejection(field: 'unitPriceMinor' | 'quantityMilli', position: number, value: number): Result {
  return err('invalid_line', {
    field,
    position,
    value,
    reason:
      'a position cannot be negative: discounts are not implemented yet, so reduce the unit price or remove the position instead',
  });
}

function validateLines(lines: DocumentLineInput[] | undefined): Result | null {
  if (lines === undefined) return null;
  if (!Array.isArray(lines)) return err('invalid_input', { field: 'lines' });
  for (const [index, line] of lines.entries()) {
    const position = index + 1;
    if (!Number.isInteger(line.unitPriceMinor)) {
      return err('invalid_input', { field: 'unitPriceMinor', position });
    }
    if (line.unitPriceMinor < 0) return negativeLineRejection('unitPriceMinor', position, line.unitPriceMinor);
    if (line.quantityMilli !== undefined) {
      if (!Number.isInteger(line.quantityMilli)) {
        return err('invalid_input', { field: 'quantityMilli', position });
      }
      if (line.quantityMilli < 0) return negativeLineRejection('quantityMilli', position, line.quantityMilli);
    }
  }
  return null;
}

/**
 * §H-TENANT: every referenced row (the customer, a line's item) must exist in THIS workspace. The
 * schema's FK is workspace-blind, so without this check workspace A could attach (and issue against)
 * workspace B's contact. A foreign id and a nonexistent id get the SAME structured rejection, so an
 * id can never be probed across tenants, and a bad reference is a stable `invalid_reference` naming
 * the field, never a raw driver throw.
 */
function validateReferences(
  ctx: WorkspaceContext,
  contactId: string | null | undefined,
  lines: DocumentLineInput[] | undefined,
): Result | null {
  if (typeof contactId === 'string') {
    const contact = ctx.store.db
      .prepare('SELECT id FROM contact WHERE workspace_id = ? AND id = ?')
      .get(ctx.workspaceId, contactId);
    if (contact === undefined) return err('invalid_reference', { field: 'contactId', contactId });
  }
  if (Array.isArray(lines)) {
    const itemStmt = ctx.store.db.prepare('SELECT id FROM item WHERE workspace_id = ? AND id = ?');
    for (const [index, line] of lines.entries()) {
      if (typeof line.itemId === 'string') {
        const item = itemStmt.get(ctx.workspaceId, line.itemId);
        if (item === undefined) {
          return err('invalid_reference', { field: 'itemId', itemId: line.itemId, line: index + 1 });
        }
      }
    }
  }
  return null;
}

/** Insert the lines for a document and return the net subtotal (A10 posts no VAT; A11 fills tax). */
function writeLines(ctx: WorkspaceContext, documentId: string, lines: DocumentLineInput[]): number {
  let subtotal = 0;
  const insert = ctx.store.db.prepare(
    `INSERT INTO document_line
       (id, document_id, workspace_id, position, item_id, description, quantity_milli, unit_price_minor, line_total_minor, tax_code, supply_date, credited_line_position)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  lines.forEach((line, index) => {
    const quantityMilli = line.quantityMilli ?? 1000;
    const total = lineTotal(quantityMilli, line.unitPriceMinor);
    subtotal += total;
    insert.run(
      ctx.ids.next('docline'),
      documentId,
      ctx.workspaceId,
      index + 1,
      line.itemId ?? null,
      line.description ?? null,
      quantityMilli,
      line.unitPriceMinor,
      total,
      line.taxCode ?? null,
      line.supplyDate ?? null,
      line.creditedLinePosition ?? null,
    );
  });
  return subtotal;
}

function recordHistory(
  ctx: WorkspaceContext,
  documentId: string,
  from: DocumentStatus | null,
  to: DocumentStatus,
): void {
  ctx.store.db
    .prepare(
      `INSERT INTO document_status_history (id, document_id, workspace_id, from_status, to_status, actor, at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(ctx.ids.next('dhist'), documentId, ctx.workspaceId, from, to, ctx.actor, ctx.clock.now());
}

/**
 * Consume the next gap-free number for a type/year (D32). Runs inside the issue transaction, so a
 * rolled-back issue leaves the counter untouched: the number is spent only on a committed issue.
 */
function nextNumber(ctx: WorkspaceContext, type: DocumentType, year: string): string {
  const row = ctx.store.db
    .prepare('SELECT next_value FROM document_number_seq WHERE workspace_id = ? AND type = ? AND year = ?')
    .get(ctx.workspaceId, type, year) as { next_value: number } | undefined;
  const value = row?.next_value ?? 1;
  if (row === undefined) {
    ctx.store.db
      .prepare('INSERT INTO document_number_seq (workspace_id, type, year, next_value) VALUES (?, ?, ?, ?)')
      .run(ctx.workspaceId, type, year, value + 1);
  } else {
    ctx.store.db
      .prepare('UPDATE document_number_seq SET next_value = ? WHERE workspace_id = ? AND type = ? AND year = ?')
      .run(value + 1, ctx.workspaceId, type, year);
  }
  return `${NUMBER_PREFIX[type]}-${year}-${String(value).padStart(4, '0')}`;
}

function isDocumentType(value: unknown): value is DocumentType {
  return typeof value === 'string' && (DOCUMENT_TYPES as readonly string[]).includes(value);
}

/** Abort the transition transaction so nothing (number, status, posting) is memoised on a poster no. */
class TransitionAbort {
  constructor(public readonly result: Result) {}
}

// --- Guard: the single per-type transition table (spec §4) -------------------------------------

/**
 * The migrated transition sub-graph (G21, additive). A migrated `invoice`/`credit_note` enters the
 * machine at `issued` (it is written there directly by `createMigratedDocument`, never via a poster)
 * and may occupy ONLY `{issued, sent, partially_paid, settled, cancelled}`. The caller-invokable
 * edges are a STRICT SUBSET of the native table: `sent` (a re-issued reminder copy) and `cancelled`
 * (which posts nothing, because a migrated document's `posted_entry_id` is NULL, so the reversing
 * poster's `onCancel` short-circuits and the opening adjustment is A04's). `partially_paid` and
 * `settled` are reached through A14's allocation exactly as for a native item and are NOT
 * caller-invokable here. It has NO `draft` state and, decisively, NO edge back to `issued`: the ONE
 * edge whose handler runs a poster is `draft -> issued`, and a migrated document can never be in
 * `draft`, so it can never take it. `assertTransition` adds NO status value; it adds an `origin`-aware
 * assertion that a migrated row never takes a posting edge.
 */
const MIGRATED_STATUSES: ReadonlySet<DocumentStatus> = new Set([
  'issued',
  'sent',
  'partially_paid',
  'settled',
  'cancelled',
]);

/**
 * The one guard. Returns `ok()` if `(from -> to)` is a legal transition for `type`, else P9
 * `illegal_transition` naming the allowed targets. This is the single source: every transition,
 * human button or agent verb, passes through here.
 *
 * G21: `origin` defaults to `native`, so every existing caller is unchanged. When `origin` is
 * `migrated` the guard ADDS two restrictions on top of the native table (never a new status): the
 * target must be a migrated-legal status, and the `issued` posting edge is forbidden outright. The
 * second is belt-and-braces (a migrated row is never in `draft`, the only `from` that reaches
 * `issued`), and it BITES: a mutation that tried to route a migrated document back through the poster
 * turns red here.
 */
export function assertTransition(
  from: DocumentStatus,
  to: DocumentStatus,
  type: DocumentType,
  origin: Origin = 'native',
): Result {
  const allowed = TRANSITIONS[type]?.[from] ?? [];
  if (!allowed.includes(to)) return err('illegal_transition', { from, to, type, allowed: [...allowed] });
  if (origin === 'migrated') {
    if (to === 'issued' || !MIGRATED_STATUSES.has(to)) {
      return err('illegal_transition', {
        from,
        to,
        type,
        origin,
        reason: 'migrated_no_posting_edge',
        allowed: allowed.filter((s) => s !== 'issued' && MIGRATED_STATUSES.has(s)),
      });
    }
  }
  return ok();
}

// --- Verbs -------------------------------------------------------------------------------------

export function createDocument(ctx: WorkspaceContext, input: CreateDocumentInput): Result {
  if (!isDocumentType(input.type)) return err('invalid_type', { type: input.type });
  const linesErr = validateLines(input.lines);
  if (linesErr) return linesErr;
  const refErr = validateReferences(ctx, input.contactId, input.lines);
  if (refErr) return refErr;

  const run = (): Result => {
    const id = ctx.ids.next('doc');
    const lines = input.lines ?? [];
    const at = ctx.clock.now();
    ctx.store.db
      .prepare(
        `INSERT INTO document
           (id, workspace_id, type, number, status, contact_id, currency, source_document_id, posted_entry_id,
            subtotal_minor, tax_minor, total_minor, issue_date, due_date, notes, created_at)
         VALUES (?, ?, ?, NULL, 'draft', ?, ?, NULL, NULL, 0, 0, 0, NULL, ?, ?, ?)`,
      )
      .run(
        id,
        ctx.workspaceId,
        input.type,
        input.contactId ?? null,
        // §H-FX. Resolved from `workspace.base_currency`, not written as a literal. A hardcoded 'CHF'
        // here was not merely a wrong label: `issueInvoice` hands THIS value to `resolveFxRate`, so a
        // EUR book issuing a document nobody named a currency for asked for a CHF/EUR rate. That is a
        // `needs_fx_rate` refusal naming a pair the operator never traded, and once somebody records
        // that rate to clear the refusal, a CONVERTED posting in a book already denominated in the
        // invoice's own currency. `mapDocument` shows the same shape without posting anything: it
        // gates its FX block on `statesConversionBasis`, to which a 'CHF' row in a EUR book reads as
        // FOREIGN, so the draft claimed a conversion basis for a conversion that never happened.
        //
        // The column's own `DEFAULT 'CHF'` never applies (this statement always names the column), so
        // this read is the single place an unnamed document currency is decided, and it now agrees
        // with `mapDocument` and `listDocuments`, which have always read `baseCurrencyOf(ctx)`.
        input.currency ?? baseCurrencyOf(ctx),
        input.dueDate ?? null,
        input.notes ?? null,
        at,
      );
    const subtotal = writeLines(ctx, id, lines);
    ctx.store.db
      .prepare('UPDATE document SET subtotal_minor = ?, total_minor = ? WHERE id = ?')
      .run(subtotal, subtotal, id);
    recordHistory(ctx, id, null, 'draft');
    return ok(documentView(ctx, readDocument(ctx, id) as DocumentRow));
  };

  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'create_document', run);
  }
  // The unkeyed path is a transaction too: a failure mid-create (document row in, a line insert
  // rejected) must roll the whole thing back, never commit an orphan document with zero lines.
  return ctx.store.tx(run);
}

export function updateDocument(
  ctx: WorkspaceContext,
  input: { documentId: string; patch: UpdateDocumentPatch; idempotencyKey?: string },
): Result {
  const existing = readDocument(ctx, input.documentId);
  if (existing === undefined) return err('not_found', { documentId: input.documentId });
  // A posted/issued document is immutable (§H-AUDIT): correct it with a reversing entry, never an
  // in-place edit. Only a draft is patchable.
  if (existing.status !== 'draft') {
    return err('illegal_transition', { from: existing.status, to: existing.status, reason: 'document_immutable' });
  }
  const patch = input.patch ?? {};
  // A13 §4b.1, the closure-attribution invariant: a Gutschrift's lines are a pure function of
  // (invoice, selection), derived once by createCreditNote and rewritten by NOTHING. A line patch
  // through this shared verb was exactly how the old build's per-line attribution was nulled and a
  // misdeclared return posted (the round-3 H1 finding), so it refuses here, structurally, for every
  // caller (Studio, MCP, REST, automation) alike. Currency and contact are derived from the invoice
  // too. `notes` and `dueDate` stay patchable: they do not touch the derivation. A credit-note
  // draft with no FK (the generic-verb shape) stays freely editable; it can never post.
  if (existing.type === 'credit_note' && existing.credited_document_id !== null) {
    for (const field of ['lines', 'currency', 'contactId'] as const) {
      if (patch[field] !== undefined) {
        return err('credit_note_lines_derived', {
          documentId: input.documentId,
          field,
          creditedDocumentId: existing.credited_document_id,
          reason:
            'a Gutschrift\'s lines are derived from the invoice it credits; cancel this draft and create a new Gutschrift with the right selection',
        });
      }
    }
  }
  const linesErr = validateLines(patch.lines);
  if (linesErr) return linesErr;
  const refErr = validateReferences(ctx, patch.contactId, patch.lines);
  if (refErr) return refErr;

  const run = (): Result => {
    const sets: string[] = [];
    const params: (string | number | null)[] = [];
    if (patch.contactId !== undefined) {
      sets.push('contact_id = ?');
      params.push(patch.contactId);
    }
    if (patch.currency !== undefined) {
      sets.push('currency = ?');
      params.push(patch.currency);
    }
    if (patch.dueDate !== undefined) {
      sets.push('due_date = ?');
      params.push(patch.dueDate);
    }
    if (patch.notes !== undefined) {
      sets.push('notes = ?');
      params.push(patch.notes);
    }
    if (patch.lines !== undefined) {
      ctx.store.db.prepare('DELETE FROM document_line WHERE document_id = ?').run(input.documentId);
      const subtotal = writeLines(ctx, input.documentId, patch.lines);
      sets.push('subtotal_minor = ?', 'total_minor = ?');
      params.push(subtotal, subtotal);
    }
    if (sets.length > 0) {
      ctx.store.db
        .prepare(`UPDATE document SET ${sets.join(', ')} WHERE workspace_id = ? AND id = ?`)
        .run(...params, ctx.workspaceId, input.documentId);
    }
    return ok(documentView(ctx, readDocument(ctx, input.documentId) as DocumentRow));
  };

  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'update_document', run);
  }
  // The unkeyed path is a transaction too: the patch DELETEs the old lines before writing the new
  // ones, so a failure in between must roll back or the draft is left with no lines and a stale
  // (lying) total.
  return ctx.store.tx(run);
}

export function transitionDocument(
  ctx: WorkspaceContext,
  input: { documentId: string; to: string; idempotencyKey?: string },
): Result {
  // The transition's idempotency identity is (this document, this key), the reverseEntry pattern:
  // folding the target into the key keeps a key reused on a DIFFERENT document from replaying the
  // first document's result while the second silently stays put. JSON-encoding the pair is an
  // injective, delimiter-safe encoding of (target, key).
  const scopedKey =
    typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0
      ? JSON.stringify([input.documentId, input.idempotencyKey])
      : undefined;

  // Replay a completed transition before any state-dependent guard, so retrying a committed issue
  // returns the original document (and its number) instead of an `illegal_transition` on the state it
  // already moved to (§H-IDEMPOTENT).
  if (scopedKey !== undefined) {
    const replayed = ctx.store.recallIdempotent<Result>(ctx.workspaceId, scopedKey, 'transition_document');
    if (replayed !== undefined) return replayed;
  }

  const existing = readDocument(ctx, input.documentId);
  if (existing === undefined) return err('not_found', { documentId: input.documentId });
  const to = input.to as DocumentStatus;
  if (!(DOCUMENT_STATUSES as readonly string[]).includes(to)) {
    return err('illegal_transition', { from: existing.status, to: input.to, type: existing.type, allowed: [] });
  }

  // Guard the transition BEFORE the transaction, so an illegal call is never memoised. Errors here
  // consume no idempotency row, no number, and change no state. G21: the row's own origin is passed
  // in, so a migrated document is held to its sub-graph and can never take a posting edge.
  const guard = assertTransition(existing.status, to, existing.type, existing.origin);
  if (!guard.ok) return guard;

  // A13 (the round-1 F1 finding, HIGH): an invoice that an issued, non-cancelled credit note has
  // relieved refuses cancellation. Without this, four calls on a default workspace reverse one sale
  // TWICE and file a VAT refund never owed, while the credit's own negative open item legitimately
  // explains the wrong 1100 away, so every reconciliation stays green. The order the refusal names
  // always works: cancel the Gutschrift first (its entry reverses, the invoice re-opens), then the
  // invoice. Draft credits never block (they posted nothing, and their own issue refuses
  // `invoice_not_creditable` once the invoice is cancelled). Checked BEFORE the transaction, like
  // the guard above, so the refusal is never memoised against the caller's idempotency key.
  if (to === 'cancelled' && existing.type === 'invoice' && existing.status !== 'draft') {
    const blocking = ctx.store.db
      .prepare(
        `SELECT id, number FROM document
          WHERE workspace_id = ? AND credited_document_id = ? AND status NOT IN ('draft', 'cancelled')
          ORDER BY created_at, rowid`,
      )
      .all(ctx.workspaceId, input.documentId) as { id: string; number: string | null }[];
    if (blocking.length > 0) {
      return err('has_credit_notes', {
        documentId: input.documentId,
        creditNotes: blocking.map((c) => ({ id: c.id, number: c.number })),
        reason: 'cancel the credit notes first; each reversal re-opens the invoice',
      });
    }
  }

  // Issue preconditions (US-A10.1): a document cannot issue without a customer and at least one line.
  if (to === 'issued') {
    if (existing.contact_id === null) return err('needs_customer', { documentId: input.documentId });
    const lineCount = ctx.store.db
      .prepare('SELECT COUNT(*) AS n FROM document_line WHERE document_id = ?')
      .get(input.documentId) as { n: number };
    if (lineCount.n === 0) return err('needs_lines', { documentId: input.documentId });
  }

  const runTransition = (): Result => {
    const doc = readDocument(ctx, input.documentId) as DocumentRow;

    // Cancel: a draft is deleted outright (mutable, excluded from reports); a posted document is
    // reversed (§H-AUDIT), never deleted; a non-posting document (issued quote/order) just marks
    // cancelled. Delete happens before any status write so the row is gone cleanly.
    if (to === 'cancelled') {
      if (doc.status === 'draft') {
        ctx.store.db.prepare('DELETE FROM document_line WHERE document_id = ?').run(doc.id);
        ctx.store.db.prepare('DELETE FROM document_status_history WHERE document_id = ?').run(doc.id);
        ctx.store.db.prepare('DELETE FROM document WHERE workspace_id = ? AND id = ?').run(ctx.workspaceId, doc.id);
        return ok({ deleted: true, documentId: doc.id });
      }
      const cancelled = posterFor(doc.type).onCancel(ctx, doc);
      if (!cancelled.ok) throw new TransitionAbort(cancelled);
      ctx.store.db
        .prepare("UPDATE document SET status = 'cancelled' WHERE workspace_id = ? AND id = ?")
        .run(ctx.workspaceId, doc.id);
      recordHistory(ctx, doc.id, doc.status, 'cancelled');
      // D78: a cancelled credit note stops offsetting its invoice, so the invoice's settlement
      // status is re-derived HERE, after this row's status landed (A14's cover query reads it),
      // inside the same transaction: an invoice that was settled by payment-plus-credit re-opens
      // to partially_paid in the same atomic step that took its relief away.
      if (doc.type === 'credit_note' && doc.credited_document_id !== null) {
        refreshSettledByCredit(ctx, doc.credited_document_id);
      }
      return ok(documentView(ctx, readDocument(ctx, doc.id) as DocumentRow));
    }

    // Issue: consume the gap-free number FIRST, then run the poster delegate with the numbered
    // document, so the posted journal entry's ref/description (and the QR reference) carry the real
    // number instead of the internal doc id. Both stay in the SAME transaction: a poster rejection
    // aborts the whole thing, rolling the counter back too, so a failed issue still consumes no
    // number (gap-free, §H-PERIOD honoured by the poster's own postEntry period check).
    if (to === 'issued') {
      const at = ctx.clock.now();
      const year = at.slice(0, 4);
      const number = nextNumber(ctx, doc.type, year);
      const poster = posterFor(doc.type);
      const issued = poster.onIssue(ctx, { ...doc, number });
      if (!issued.ok) throw new TransitionAbort(issued);
      const postedEntryId = typeof issued.postedEntryId === 'string' ? issued.postedEntryId : null;
      ctx.store.db
        .prepare(
          "UPDATE document SET status = 'issued', number = ?, issue_date = ?, posted_entry_id = ? WHERE workspace_id = ? AND id = ?",
        )
        .run(number, at.slice(0, 10), postedEntryId, ctx.workspaceId, doc.id);
      recordHistory(ctx, doc.id, doc.status, 'issued');
      // G05: freeze the workspace's default template (id + content snapshot) onto the document, in
      // the SAME transaction the number crystallises in, because the two are the same promise: what
      // the customer was mailed is what a later reprint shows. Write-once by construction
      // (`AND rendered_template_id IS NULL` inside), a no-op when the kind has no default, and
      // NEVER run by a render read (conformance rule 4: READ MEANS READ).
      if (doc.type === 'invoice' || doc.type === 'credit_note' || doc.type === 'quote') {
        freezeRenderedTemplate(ctx, { documentKind: doc.type, documentId: doc.id });
      }
      // D63 (E00): a file attached to this draft carried no statutory floor; a document that POSTS
      // (invoice, credit note) becomes evidence in this same transaction, so the floor attaches
      // here, anchored on the issue_date written above. For a quote or an order the hook derives
      // nothing: their poster is the no-op and `posted_entry_id` stays NULL, and an Offerte with a
      // number is still not a Buchungsbeleg (OR 957a Abs. 3).
      deriveStatutoryOnPost(ctx, 'document', doc.id);
      // D78: an ISSUED credit note starts offsetting its invoice, so the invoice's settlement
      // status is re-derived HERE, after this row's status landed (A14's cover query filters on
      // it), inside the same transaction. Payments plus issued credits covering the invoice
      // exactly moves it from partially_paid to the terminal settled; an unpaid invoice is left
      // untouched, because a credit alone never moves the lifecycle column.
      if (doc.type === 'credit_note' && doc.credited_document_id !== null) {
        refreshSettledByCredit(ctx, doc.credited_document_id);
      }
      return ok(documentView(ctx, readDocument(ctx, doc.id) as DocumentRow));
    }

    // Every other legal transition is a plain status advance (send, accept, decline, confirm, ...).
    ctx.store.db
      .prepare('UPDATE document SET status = ? WHERE workspace_id = ? AND id = ?')
      .run(to, ctx.workspaceId, doc.id);
    recordHistory(ctx, doc.id, doc.status, to);
    return ok(documentView(ctx, readDocument(ctx, doc.id) as DocumentRow));
  };

  // The mutation runs in a transaction: a poster rejection throws `TransitionAbort` to roll the whole
  // thing back (no number consumed, no idempotency row written, status unchanged), caught here and
  // returned as the poster's structured error.
  try {
    if (scopedKey !== undefined) {
      return ctx.store.rememberIdempotent(ctx.workspaceId, scopedKey, 'transition_document', runTransition);
    }
    return ctx.store.tx(runTransition);
  } catch (e) {
    if (e instanceof TransitionAbort) return e.result;
    throw e;
  }
}

export function convertDocument(
  ctx: WorkspaceContext,
  input: { documentId: string; toType: string; idempotencyKey?: string },
): Result {
  // The conversion's idempotency identity is (this source document, this key), the reverseEntry
  // pattern: folding the source into the key keeps a key reused on a DIFFERENT document from
  // replaying the first conversion's target while the second source silently stays unconverted.
  const scopedKey =
    typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0
      ? JSON.stringify([input.documentId, input.idempotencyKey])
      : undefined;

  // Replay a completed conversion before the state guard, so a retry with the same key returns the
  // original target rather than tripping the already-`converted` structural guard (§H-IDEMPOTENT).
  if (scopedKey !== undefined) {
    const replayed = ctx.store.recallIdempotent<Result>(ctx.workspaceId, scopedKey, 'convert_document');
    if (replayed !== undefined) return replayed;
  }

  const source = readDocument(ctx, input.documentId);
  if (source === undefined) return err('not_found', { documentId: input.documentId });
  if (!isDocumentType(input.toType)) return err('invalid_type', { type: input.toType });

  const rule = CONVERSIONS[source.type];
  if (rule === undefined || !rule.toTypes.includes(input.toType)) {
    return err('illegal_transition', { from: source.type, to: input.toType, reason: 'not_convertible' });
  }
  // The source must be in the convertible state (quote: accepted; order: confirmed). An already
  // `converted` source returns its existing target so a retry (or a double click) lands on the same
  // document, never a duplicate (§H-IDEMPOTENT structural guard, complementing the key replay below).
  if (source.status !== rule.from) {
    if (source.status === 'converted') {
      const target = ctx.store.db
        .prepare(`${DOCUMENT_SELECT} WHERE d.workspace_id = ? AND d.source_document_id = ? AND d.type = ?`)
        .get(ctx.workspaceId, source.id, input.toType) as DocumentRow | undefined;
      if (target !== undefined) return ok(documentView(ctx, target));
    }
    return err('illegal_transition', { from: source.status, to: 'converted', type: source.type, expected: rule.from });
  }

  const run = (): Result => {
    const lines = readLines(ctx, source.id);
    const targetId = ctx.ids.next('doc');
    const at = ctx.clock.now();
    ctx.store.db
      .prepare(
        `INSERT INTO document
           (id, workspace_id, type, number, status, contact_id, currency, source_document_id, posted_entry_id,
            subtotal_minor, tax_minor, total_minor, issue_date, due_date, notes, created_at)
         VALUES (?, ?, ?, NULL, 'draft', ?, ?, ?, NULL, 0, 0, 0, NULL, ?, ?, ?)`,
      )
      .run(
        targetId,
        ctx.workspaceId,
        input.toType,
        source.contact_id,
        source.currency,
        source.id,
        source.due_date,
        source.notes,
        at,
      );
    const cloned: DocumentLineInput[] = lines.map((l) => ({
      itemId: l.item_id,
      description: l.description,
      quantityMilli: l.quantity_milli,
      unitPriceMinor: l.unit_price_minor,
      taxCode: l.tax_code,
      supplyDate: l.supply_date,
    }));
    const subtotal = writeLines(ctx, targetId, cloned);
    ctx.store.db
      .prepare('UPDATE document SET subtotal_minor = ?, total_minor = ? WHERE id = ?')
      .run(subtotal, subtotal, targetId);
    recordHistory(ctx, targetId, null, 'draft');

    // Mark the source terminal: it is no longer editable, and its status chip links forward.
    ctx.store.db
      .prepare("UPDATE document SET status = 'converted' WHERE workspace_id = ? AND id = ?")
      .run(ctx.workspaceId, source.id);
    recordHistory(ctx, source.id, source.status, 'converted');

    return ok({ ...documentView(ctx, readDocument(ctx, targetId) as DocumentRow), sourceDocumentId: source.id });
  };

  if (scopedKey !== undefined) {
    return ctx.store.rememberIdempotent(ctx.workspaceId, scopedKey, 'convert_document', run);
  }
  // The unkeyed path is a transaction too: the target insert, the cloned lines, and the source's
  // terminal flip must land together or not at all (no half-converted pair).
  return ctx.store.tx(run);
}

// --- G21: the migrated open-item writer ---------------------------------------------------------

/** One resolved line of a migrated open item (P6: the tax is a stored VALUE, never recomputed). */
export interface MigratedDocumentLineInput {
  description?: string | null;
  /** The NET amount in integer Rappen (the line total ex-VAT). */
  netMinor: number;
  /** The resolved output VAT for this line, in integer Rappen (0 for a zero/exempt/none line). */
  taxMinor: number;
  /** The G10-mapped tax code, stored as-is (A14's Ist recognition and A07's trace read it). */
  taxCode?: string | null;
  /** The Leistungsdatum that priced the VAT (P6 / §H-VAT-TRACE). */
  supplyDate?: string | null;
}

export interface CreateMigratedDocumentInput {
  /** `invoice` (US-G21.1) or `credit_note`; the AR open item is almost always an invoice. */
  type: DocumentType;
  /** The already-mapped customer (validated by the caller); written to `contact_id`. */
  contactId: string;
  /** The SOURCE system's own document number, stored verbatim. A migrated import consumes NO native
   *  number series (OR 957 ff. gap-free numbering is untouched: `nextNumber` is never called). */
  number: string;
  issueDate: string;
  dueDate?: string | null;
  currency: string;
  lines: MigratedDocumentLineInput[];
  /**
   * G21 / D112 Q2 'live' path: when true the item was ALREADY SETTLED in the old system and is
   * carried live only for the record. It is written directly to the terminal `settled` status, so
   * A16 never counts it as open (it posts nothing AND nets to zero open, never double-recognising
   * revenue). Defaults false: the ordinary case is a genuinely open item written at `issued`.
   */
  settled?: boolean;
}

/**
 * Write a migrated open item DIRECTLY at `status='issued'`, `origin='migrated'`, `posted_entry_id`
 * NULL, posting NOTHING (US-G21.1). This is the structural heart of G21: the A10 poster seam is
 * BYPASSED, not invoked with a no-op. This function holds no reference to `postEntry` or any poster,
 * never reaches the `onIssue` delegate, and never builds a balanced entry. The document's only ledger
 * effect is the aggregate 1100 line A04 already posted; this row carries the open-item DETAIL for
 * aging, dunning and settlement.
 *
 * The header totals mirror a native issued invoice exactly (B-1): `subtotal_minor` is Σ net,
 * `tax_minor` is Σ the resolved output VAT, `total_minor` is the gross. That is what makes the row
 * indistinguishable to A16 (which reconciles on `total_minor`) and to A14 (which reads `tax_minor`
 * for the Ist split off stored values). NO number series is consumed: the source number is written
 * as-is.
 *
 * It runs inside a transaction the CALLER opened (G21's `importOpenItems` owns the idempotency key
 * and the tenancy/mapping guards), so it validates shape only and does the write.
 */
export function createMigratedDocument(ctx: WorkspaceContext, input: CreateMigratedDocumentInput): Result {
  if (input.type !== 'invoice' && input.type !== 'credit_note') {
    return err('invalid_type', { type: input.type, reason: 'a migrated open item is an invoice or a credit note' });
  }
  if (!Array.isArray(input.lines) || input.lines.length === 0) {
    return err('invalid_input', { field: 'lines', reason: 'a migrated open item has at least one line' });
  }
  let subtotal = 0;
  let tax = 0;
  for (const [index, line] of input.lines.entries()) {
    if (!Number.isSafeInteger(line.netMinor) || line.netMinor < 0) {
      return err('invalid_line', { field: 'netMinor', position: index + 1, reason: 'integer Rappen, not negative' });
    }
    if (!Number.isSafeInteger(line.taxMinor) || line.taxMinor < 0) {
      return err('invalid_line', { field: 'taxMinor', position: index + 1, reason: 'integer Rappen, not negative' });
    }
    subtotal += line.netMinor;
    tax += line.taxMinor;
  }
  const total = subtotal + tax;

  const id = ctx.ids.next('doc');
  const at = ctx.clock.now();
  const status: DocumentStatus = input.settled === true ? 'settled' : 'issued';
  ctx.store.db
    .prepare(
      `INSERT INTO document
         (id, workspace_id, type, number, status, origin, contact_id, currency, source_document_id,
          posted_entry_id, subtotal_minor, tax_minor, total_minor, issue_date, due_date, notes, created_at)
       VALUES (?, ?, ?, ?, ?, 'migrated', ?, ?, NULL, NULL, ?, ?, ?, ?, ?, NULL, ?)`,
    )
    .run(
      id,
      ctx.workspaceId,
      input.type,
      input.number,
      status,
      input.contactId,
      input.currency,
      subtotal,
      tax,
      total,
      input.issueDate,
      input.dueDate ?? null,
      at,
    );

  const insertLine = ctx.store.db.prepare(
    `INSERT INTO document_line
       (id, document_id, workspace_id, position, item_id, description, quantity_milli, unit_price_minor, line_total_minor, tax_code, supply_date, credited_line_position)
     VALUES (?, ?, ?, ?, NULL, ?, 1000, ?, ?, ?, ?, NULL)`,
  );
  input.lines.forEach((line, index) => {
    insertLine.run(
      ctx.ids.next('docline'),
      id,
      ctx.workspaceId,
      index + 1,
      line.description ?? null,
      line.netMinor,
      line.netMinor,
      line.taxCode ?? null,
      line.supplyDate ?? null,
    );
  });

  // The status trail records the row's whole life for an auditor (§4): a migrated item is BORN at
  // its status (there was never a draft), so the single history row is null -> that status.
  recordHistory(ctx, id, null, status);

  return ok({ ...documentView(ctx, readDocument(ctx, id) as DocumentRow), documentId: id });
}

export function getDocument(ctx: WorkspaceContext, input: { documentId: string }): Result {
  const row = readDocument(ctx, input.documentId);
  if (row === undefined) return err('not_found', { documentId: input.documentId });
  return ok(documentView(ctx, row));
}

export function listDocuments(
  ctx: WorkspaceContext,
  filter: {
    type?: string;
    status?: string;
    contactId?: string;
    /** A13: "the credit notes of invoice X" as one read (the `document_credited` partial index). */
    creditedDocumentId?: string;
    from?: string;
    to?: string;
    savedViewId?: string;
  } = {},
): Result {
  // G00 HAS LANDED, so this parameter works instead of refusing. It used to return `unsupported` with
  // reason `saved_views_not_built`, which was the honest answer while there was nothing to resolve.
  //
  // The seam is ONE unconditional call. `applySavedView` returns the filter untouched when no view is
  // named, merges the view's filters underneath the caller's explicit ones when there is, and this
  // function keeps no branch of its own.
  const viewed = applySavedView(ctx, 'document', filter);
  if (!viewed.ok) return viewed;
  filter = viewed.filter;
  // Every clause is qualified with the `d` alias DOCUMENT_SELECT introduces, so the correlated
  // target subquery inside it can never be shadowed by an unqualified column name.
  const clauses = ['d.workspace_id = ?'];
  const params: string[] = [ctx.workspaceId];
  if (filter.type !== undefined) {
    clauses.push('d.type = ?');
    params.push(filter.type);
  }
  if (filter.status !== undefined) {
    clauses.push('d.status = ?');
    params.push(filter.status);
  }
  if (filter.contactId !== undefined) {
    clauses.push('d.contact_id = ?');
    params.push(filter.contactId);
  }
  if (filter.creditedDocumentId !== undefined) {
    clauses.push('d.credited_document_id = ?');
    params.push(filter.creditedDocumentId);
  }
  // Range filters read the issue date (the document's dated event); a draft has none, so a date
  // filter naturally excludes drafts, which is the auditor's expectation.
  if (filter.from !== undefined) {
    clauses.push('d.issue_date >= ?');
    params.push(filter.from);
  }
  if (filter.to !== undefined) {
    clauses.push('d.issue_date <= ?');
    params.push(filter.to);
  }
  // D34: load all up to the documented ceiling, fetching one extra to detect (and flag) truncation
  // rather than silently dropping rows.
  const rows = ctx.store.db
    .prepare(
      `${DOCUMENT_SELECT} WHERE ${clauses.join(' AND ')} ORDER BY d.created_at DESC, d.rowid DESC LIMIT ?`,
    )
    .all(...params, DOCUMENT_LIST_CEILING + 1) as DocumentRow[];
  const truncated = rows.length > DOCUMENT_LIST_CEILING;
  // Resolved once for the page rather than per row: the base currency is a workspace fact, and
  // `.map(mapDocument)` would otherwise pass the array index in as the second argument.
  const listBase = baseCurrencyOf(ctx);
  const documents = (truncated ? rows.slice(0, DOCUMENT_LIST_CEILING) : rows).map((r) =>
    mapDocument(r, listBase),
  );
  // The true row count under the same filters, so a truncated client can say "the first 1000 of N"
  // instead of guessing. Cheap (a COUNT over the same indexed WHERE) and only diverges from
  // documents.length when the ceiling bit.
  const total = truncated
    ? (
        ctx.store.db
          .prepare(`SELECT COUNT(*) AS n FROM document d WHERE ${clauses.join(' AND ')}`)
          .get(...params) as { n: number }
      ).n
    : documents.length;
  return ok({ documents, truncated, total, ceiling: DOCUMENT_LIST_CEILING });
}
