/**
 * A13, credit notes (Gutschrift): the credit-note-scoped half of the A10 document lifecycle.
 *
 * REBUILT under D74 (spec §4b). A10 owns the state machine, the gap-free numbering and the
 * transition/idempotency machinery; A13 plugs into A10's poster seam
 * (`registerDocumentPoster('credit_note', ...)`, done in `index.ts`) and adds:
 *
 *  - `createCreditNote`: derive a credit-note DRAFT from an issued invoice, full or partial. THE
 *    DERIVATION IS THE ONLY WRITER OF CREDIT-NOTE LINES (§4b.1): every derived line pins its
 *    Leistungsdatum to the original's (rate-era law) and carries `credited_line_position` (the
 *    attribution the per-class closure rests on). `updateDocument` refuses line patches on an
 *    FK-carrying credit note, so the attribution cannot be edited away; the poster below refuses
 *    honestly should any other path ever produce an unattributed line.
 *  - `buildCreditNotePosting` (the A10 `onIssue` delegate, P3): the ONE place a credit note posts.
 *    The shapes it may emit are the CLOSED inventory of spec §4b.2 (S1 full mirror, S2/S3
 *    non-exhausting partials with canonical VAT, S4 the exhausting per-class closure, S5 the
 *    Klassenausgleich pair, S6 the FX released-base statement, S7 the cancel reversal). Nothing
 *    else posts, ever; a change of shape is a spec change first (D74).
 *  - `renderCreditNotePdf`: the Gutschrift artifact. No QR-bill payment part, deliberately: a
 *    credit note collects nothing, and the refund payout is A14/A18's business.
 *
 * WHY THE POSTING DOES NOT SET `journal_entry.reverses_entry_id`. That column means "the faithful
 * mirror of that entry" and every reversal-aware read treats it so: A16 drops a receivable the
 * moment a posted entry in range reverses its posting, and A10's cancel path books the true Storno
 * through it. A PARTIAL credit note is not a faithful mirror, and stamping the column would make
 * A16 erase the WHOLE invoice over a ten-percent credit. The invoice-to-credit link is the A13-owned
 * `document.credited_document_id`; the ledger link is the pair of entries themselves.
 *
 * There is no `get_credit_note` / `list_credit_notes` MCP tool (D14 parity with A11): read/list/PDF
 * ride A10's `get_document` (`include: ['pdf']`) and `list_documents(type:'credit_note')`, which
 * gained the `creditedDocumentId` filter for "the credit notes of invoice X".
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { postEntry, statesConversionBasis } from '../ledger/postEntry.js';
import { requireString, optionalText } from '../ledger/inputGuards.js';
import { reverseEntry } from '../ledger/reverseEntry.js';
import { baseCurrencyOf } from '../fx/rates.js';
import { parseRate, convertMinor, RATE_ONE } from '../fx/rateMath.js';
import { ROLE_ACCOUNT_NUMBER } from '../payments/accounts.js';
import { computeLineTax } from '../vat/applyVat.js';
import { apportionNet } from './apportion.js';
import { createDocument, transitionDocument, getDocument } from './document.js';
import type { DocumentRow, DocumentPoster, DocumentLineInput } from './document.js';
// G05: the template seam (layout-only footer lines; see the A11 note on `resolveRenderTemplate`).
import { resolveRenderTemplate } from '../customization/documentTemplates.js';
import {
  accountByNumber,
  revenueAccountFor,
  verifyPostedEntryIsOurs,
  pdfEscape,
  buildMinimalPdf,
} from './invoice.js';

/** The statuses of a referencing credit note that do NOT consume creditable amount. */
const CREDIT_COUNTING_EXCLUDED = ['draft', 'cancelled'] as const;

interface DocumentLineRow {
  id: string;
  document_id: string;
  position: number;
  item_id: string | null;
  description: string | null;
  quantity_milli: number;
  unit_price_minor: number;
  line_total_minor: number;
  tax_code: string | null;
  supply_date: string | null;
  credited_line_position: number | null;
}

function readDocRow(ctx: WorkspaceContext, id: string): DocumentRow | undefined {
  return ctx.store.db
    .prepare('SELECT * FROM document WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, id) as DocumentRow | undefined;
}

function readLines(ctx: WorkspaceContext, documentId: string): DocumentLineRow[] {
  return ctx.store.db
    // §H-TENANT on EVERY query (the round-1 F5 rule): the id is already workspace-resolved, and the
    // clause is carried anyway, because the house rule is not "where it is exploitable".
    .prepare('SELECT * FROM document_line WHERE workspace_id = ? AND document_id = ? ORDER BY position')
    .all(ctx.workspaceId, documentId) as DocumentLineRow[];
}

/**
 * Is this invoice one a credit note may reference? A posted, non-cancelled invoice in THIS
 * workspace. A foreign id and a nonexistent id earn the SAME rejection (§H-TENANT: ids are never
 * probeable across tenants), and the rejection names what is wrong rather than throwing.
 */
function creditableInvoice(
  ctx: WorkspaceContext,
  invoiceId: string,
): { invoice: DocumentRow } | { refusal: Result } {
  const invoice = readDocRow(ctx, invoiceId);
  if (invoice === undefined) return { refusal: err('not_found', { fromInvoiceId: invoiceId }) };
  if (invoice.type !== 'invoice') {
    return { refusal: err('invoice_not_creditable', { fromInvoiceId: invoiceId, reason: 'not_an_invoice' }) };
  }
  if (invoice.posted_entry_id === null || invoice.status === 'draft') {
    return {
      refusal: err('invoice_not_creditable', {
        fromInvoiceId: invoiceId,
        status: invoice.status,
        reason: 'invoice_not_posted',
      }),
    };
  }
  if (invoice.status === 'cancelled') {
    return {
      refusal: err('invoice_not_creditable', {
        fromInvoiceId: invoiceId,
        status: invoice.status,
        reason: 'invoice_cancelled',
      }),
    };
  }
  return { invoice };
}

/**
 * The Leistungsdatum a credit line carries: the original line's own, else the invoice's issue date.
 *
 * ALWAYS set on a derived line, and load-bearing twice over: A06 prices the reversal at this date's
 * rate era (a 2023 supply credited in 2027 reverses at 7.7% on the legacy Ziffer, inside the
 * CURRENT period's return, the statutory correction shape), and a pinned date sidesteps A11's
 * `needs_supply_date` era-ambiguity refusal by construction.
 */
function pinnedSupplyDate(line: DocumentLineRow, invoice: DocumentRow): string | null {
  return line.supply_date ?? invoice.issue_date ?? null;
}

function cloneLine(line: DocumentLineRow, invoice: DocumentRow, quantityMilli?: number): DocumentLineInput {
  return {
    itemId: line.item_id,
    description: line.description,
    quantityMilli: quantityMilli ?? line.quantity_milli,
    unitPriceMinor: line.unit_price_minor,
    taxCode: line.tax_code,
    supplyDate: pinnedSupplyDate(line, invoice),
    // §4b.1, the attribution: which invoice position this credit line derives from. The one writer.
    creditedLinePosition: line.position,
  };
}

/**
 * The net each invoice position has already had credited against it by OTHER issued, non-cancelled
 * credit notes, keyed by the invoice position their lines attribute to.
 */
function creditedNetByPosition(ctx: WorkspaceContext, invoiceId: string, excludeId: string): Map<number, number> {
  const rows = ctx.store.db
    .prepare(
      `SELECT dl.credited_line_position AS position, SUM(dl.line_total_minor) AS net
         FROM document_line dl
         JOIN document d ON d.id = dl.document_id AND d.workspace_id = dl.workspace_id
        WHERE dl.workspace_id = ? AND d.credited_document_id = ? AND d.id <> ?
          AND d.status NOT IN (${CREDIT_COUNTING_EXCLUDED.map(() => '?').join(', ')})
          AND dl.credited_line_position IS NOT NULL
        GROUP BY dl.credited_line_position`,
    )
    .all(ctx.workspaceId, invoiceId, excludeId, ...CREDIT_COUNTING_EXCLUDED) as {
    position: number;
    net: number;
  }[];
  return new Map(rows.map((r) => [r.position, r.net]));
}

// The apportionment arithmetic moved to `apportion.ts` (a dependency-free leaf) so the Studio's
// D78 gross readout can import THE SAME largest-remainder split without dragging the engine into
// the browser bundle. Re-exported here so the barrel and every existing import are unchanged.
export { apportionNet } from './apportion.js';

export interface CreateCreditNoteInput {
  fromInvoiceId: string;
  /** 'full' (the default) derives every line; 'partial' takes `lines` or `amountMinor`. */
  mode?: string;
  /** Partial by position: a subset of the invoice's positions, quantity at most the original. */
  lines?: { position: number; quantityMilli?: number }[];
  /** Partial by amount: a NET amount in Rappen, apportioned over the REMAINING per-line nets. */
  amountMinor?: number;
  /** Free-text reason (Rückgabe, Kulanz, Korrektur); lands in `document.notes`. */
  reason?: string;
  idempotencyKey?: string;
}

/** Abort the create transaction so a nested rejection is returned, never memoised as the key's result. */
class CreateAbort {
  constructor(public readonly result: Result) {}
}

/**
 * Derive a credit-note DRAFT from an issued invoice. Always a draft: issuing (which posts) is a
 * separate, P8-gated act. Idempotent on `idempotencyKey` (§H-IDEMPOTENT): a retry returns the
 * original draft, never a duplicate; a refusal is never memoised.
 */
export function createCreditNote(ctx: WorkspaceContext, input: CreateCreditNoteInput): Result {
  const guard =
    requireString(input.fromInvoiceId, 'fromInvoiceId') ??
    requireString(input.idempotencyKey, 'idempotencyKey') ??
    optionalText(input.reason, 'reason');
  if (guard) return guard;

  const mode = input.mode ?? 'full';
  if (mode !== 'full' && mode !== 'partial') {
    return err('invalid_input', { field: 'mode', allowed: ['full', 'partial'] });
  }

  const resolved = creditableInvoice(ctx, input.fromInvoiceId);
  if ('refusal' in resolved) return resolved.refusal;
  const invoice = resolved.invoice;
  const invoiceLines = readLines(ctx, invoice.id);
  if (invoiceLines.length === 0) return err('needs_lines', { fromInvoiceId: invoice.id });

  let derived: DocumentLineInput[];
  if (mode === 'full') {
    if (input.lines !== undefined || input.amountMinor !== undefined) {
      return err('invalid_input', { field: 'mode', reason: 'full mode derives every line; pass mode partial to select' });
    }
    derived = invoiceLines.map((l) => cloneLine(l, invoice));
  } else if (input.lines !== undefined) {
    if (input.amountMinor !== undefined) {
      return err('invalid_input', { field: 'amountMinor', reason: 'pass lines OR amountMinor, not both' });
    }
    if (!Array.isArray(input.lines) || input.lines.length === 0) {
      return err('invalid_input', { field: 'lines' });
    }
    const byPosition = new Map(invoiceLines.map((l) => [l.position, l]));
    const seen = new Set<number>();
    derived = [];
    for (const [index, sel] of input.lines.entries()) {
      if (sel === null || typeof sel !== 'object' || !Number.isInteger(sel.position)) {
        return err('invalid_input', { field: `lines[${index}].position` });
      }
      const original = byPosition.get(sel.position);
      if (original === undefined) {
        return err('invalid_input', {
          field: `lines[${index}].position`,
          position: sel.position,
          reason: 'no such position on the invoice',
        });
      }
      if (seen.has(sel.position)) {
        return err('invalid_input', { field: `lines[${index}].position`, position: sel.position, reason: 'duplicate_position' });
      }
      seen.add(sel.position);
      const quantity = sel.quantityMilli ?? original.quantity_milli;
      if (!Number.isInteger(quantity) || quantity <= 0) {
        return err('invalid_input', { field: `lines[${index}].quantityMilli`, position: sel.position });
      }
      if (quantity > original.quantity_milli) {
        return err('invalid_input', {
          field: `lines[${index}].quantityMilli`,
          position: sel.position,
          max: original.quantity_milli,
          reason: 'cannot credit more than the invoiced quantity',
        });
      }
      derived.push(cloneLine(original, invoice, quantity));
    }
  } else if (input.amountMinor !== undefined) {
    if (!Number.isInteger(input.amountMinor) || input.amountMinor <= 0) {
      return err('invalid_input', { field: 'amountMinor' });
    }
    // The apportionment runs over each line's REMAINING net (§4b.2 S3): pro rata over the ORIGINAL
    // nets it would re-credit slices other credits already took, the per-line mix would drift from
    // the invoice's, and the rate classes' NETS would stop closing even when the total does. Over
    // the remainders, the amount that exhausts the invoice consumes exactly every line's remainder.
    const credited = creditedNetByPosition(ctx, invoice.id, 'none');
    const nets = invoiceLines.map((l) => Math.max(0, l.line_total_minor - (credited.get(l.position) ?? 0)));
    const remainingNet = nets.reduce((n, v) => n + v, 0);
    if (input.amountMinor > remainingNet) {
      return err('invalid_input', {
        field: 'amountMinor',
        remainingNetMinor: remainingNet,
        reason: 'exceeds the net still creditable on the invoice',
      });
    }
    const shares = apportionNet(input.amountMinor, nets);
    derived = [];
    invoiceLines.forEach((l, i) => {
      const share = shares[i] as number;
      if (share === 0) return;
      // One unit at the apportioned net: the share is a money amount, not a quantity, so restating
      // it as quantity x unit price would invent a quantity nobody chose.
      derived.push({
        itemId: l.item_id,
        description: l.description,
        quantityMilli: 1000,
        unitPriceMinor: share,
        taxCode: l.tax_code,
        supplyDate: pinnedSupplyDate(l, invoice),
        creditedLinePosition: l.position,
      });
    });
    if (derived.length === 0) return err('invalid_input', { field: 'amountMinor', reason: 'nothing to credit' });
  } else {
    return err('invalid_input', { field: 'mode', reason: 'partial mode needs lines or amountMinor' });
  }

  const key = input.idempotencyKey as string;
  const run = (): Result => {
    const created = createDocument(ctx, {
      type: 'credit_note',
      contactId: invoice.contact_id,
      currency: invoice.currency,
      lines: derived,
      notes: input.reason ?? null,
    });
    if (!created.ok) throw new CreateAbort(created);
    const documentId = (created.document as { id: string }).id;
    // The FK is what makes this a Gutschrift rather than a free-standing negative document: the
    // poster refuses to post without it, the over-credit guards read it, A16 nets by it, and from
    // this moment §4b.1 freezes the lines (updateDocument refuses to rewrite them).
    ctx.store.db
      .prepare('UPDATE document SET credited_document_id = ? WHERE workspace_id = ? AND id = ?')
      .run(invoice.id, ctx.workspaceId, documentId);
    return getDocument(ctx, { documentId });
  };

  try {
    return ctx.store.rememberIdempotent(ctx.workspaceId, key, 'create_credit_note', run);
  } catch (e) {
    if (e instanceof CreateAbort) return e.result;
    throw e;
  }
}

/**
 * Issue a credit note: A10's `transitionDocument(..., 'issued')` runs the guard + gap-free
 * numbering and invokes A13's registered poster atomically. A thin wrapper (D14 parity with
 * `issue_invoice`): `transition_document` on the same draft reaches the identical delegate.
 */
export function issueCreditNote(
  ctx: WorkspaceContext,
  input: { creditNoteId: string; idempotencyKey?: string },
): Result {
  const guard =
    requireString(input.creditNoteId, 'creditNoteId') ?? requireString(input.idempotencyKey, 'idempotencyKey');
  if (guard) return guard;
  const row = readDocRow(ctx, input.creditNoteId);
  if (row === undefined) return err('not_found', { creditNoteId: input.creditNoteId });
  if (row.type !== 'credit_note') return err('not_a_credit_note', { creditNoteId: input.creditNoteId, type: row.type });
  return transitionDocument(ctx, {
    documentId: input.creditNoteId,
    to: 'issued',
    idempotencyKey: input.idempotencyKey as string,
  });
}

/**
 * What OTHER issued, non-cancelled credit notes have already taken from an invoice: their persisted
 * net/VAT/gross (which is what their entries booked), and their posted entry ids (the §4b.3 base
 * telescoping and the per-class closure both read the booked rows, never re-derive).
 */
function priorCredits(
  ctx: WorkspaceContext,
  invoiceId: string,
  excludeId: string,
): { netMinor: number; taxMinor: number; grossMinor: number; entryIds: string[] } {
  const rows = ctx.store.db
    .prepare(
      `SELECT subtotal_minor, tax_minor, total_minor, posted_entry_id FROM document
        WHERE workspace_id = ? AND credited_document_id = ? AND id <> ?
          AND status NOT IN (${CREDIT_COUNTING_EXCLUDED.map(() => '?').join(', ')})`,
    )
    .all(ctx.workspaceId, invoiceId, excludeId, ...CREDIT_COUNTING_EXCLUDED) as {
    subtotal_minor: number;
    tax_minor: number;
    total_minor: number;
    posted_entry_id: string | null;
  }[];
  return {
    netMinor: rows.reduce((n, r) => n + r.subtotal_minor, 0),
    taxMinor: rows.reduce((n, r) => n + r.tax_minor, 0),
    grossMinor: rows.reduce((n, r) => n + r.total_minor, 0),
    entryIds: rows.map((r) => r.posted_entry_id).filter((id): id is string => id !== null),
  };
}

/** Signed net movements per account (debit minus credit) over a set of posted entries. */
function accountMovements(
  ctx: WorkspaceContext,
  entryIds: readonly string[],
): Map<string, { txn: number; base: number }> {
  const out = new Map<string, { txn: number; base: number }>();
  if (entryIds.length === 0) return out;
  const rows = ctx.store.db
    .prepare(
      // §H-TENANT through the entry join (the round-2 G4 rule): `journal_line` carries no
      // workspace column of its own, so the entry is what scopes it, on EVERY query.
      `SELECT l.account_id AS account_id, SUM(l.debit_minor - l.credit_minor) AS txn,
              SUM(l.base_debit_minor - l.base_credit_minor) AS base
         FROM journal_line l
         JOIN journal_entry e ON e.id = l.entry_id AND e.workspace_id = ?
        WHERE l.entry_id IN (${entryIds.map(() => '?').join(', ')})
        GROUP BY l.account_id`,
    )
    .all(ctx.workspaceId, ...entryIds) as { account_id: string; txn: number; base: number }[];
  for (const r of rows) out.set(r.account_id, { txn: r.txn, base: r.base });
  return out;
}

/**
 * A RATE CLASS: the (Ziffer, rate) bucket a traced line declares on (§4b.2 S4). The D67/D71
 * arithmetic runs per class, never entry-wide: a residual born of 2.6% rounding must never land on
 * an 8.1% line, or the return declares two individually impossible Ziffern whose sum is right, the
 * exact pathology `abrechnung.ts` names as fatal and ESTV cross-foots.
 */
interface RateClassInfo {
  /** Σ of the stamped `tax_amount_minor` (signed: invoice rows positive, credit rows negative). */
  stampedTaxMinor: number;
  /** A representative (taxCode, supplyDate, revenue account) for synthesizing S5 legs. */
  taxCode: string;
  supplyDate: string;
  revenueAccountId: string;
}

/**
 * The per-rate-class VAT a set of posted entries actually stamped, resolved through the SAME P6
 * contract that priced the lines (`computeLineTax` on the row's own code and Leistungsdatum, entry
 * date as the fallback, exactly A07's rule), so the classes here and the classes the return renders
 * cannot disagree.
 */
function classVatOf(ctx: WorkspaceContext, entryIds: readonly string[]): Map<string, RateClassInfo> {
  const out = new Map<string, RateClassInfo>();
  if (entryIds.length === 0) return out;
  const rows = ctx.store.db
    .prepare(
      `SELECT l.account_id AS account_id, l.tax_code AS tax_code, l.supply_date AS supply_date,
              l.tax_amount_minor AS tax_amount_minor, e.date AS entry_date
         FROM journal_line l
         JOIN journal_entry e ON e.id = l.entry_id AND e.workspace_id = ?
        WHERE l.entry_id IN (${entryIds.map(() => '?').join(', ')}) AND l.tax_code IS NOT NULL
        ORDER BY e.date, l.rowid`,
    )
    .all(ctx.workspaceId, ...entryIds) as {
    account_id: string;
    tax_code: string;
    supply_date: string | null;
    tax_amount_minor: number | null;
    entry_date: string;
  }[];
  for (const row of rows) {
    const supplyDate = row.supply_date ?? row.entry_date;
    const resolved = computeLineTax(ctx, {
      amountMinor: 0,
      amountIsGross: false,
      taxCode: row.tax_code,
      supplyDate,
    });
    if (!resolved.ok) continue; // an archived historical code still resolves; a broken one cannot bucket
    const rateBp = resolved.rateBp as number;
    if (rateBp <= 0) continue; // zero-rated and exempt classes carry no VAT to close
    const key = `${String(resolved.formLine ?? '')}|${rateBp}`;
    const existing = out.get(key);
    if (existing === undefined) {
      out.set(key, {
        stampedTaxMinor: row.tax_amount_minor ?? 0,
        taxCode: row.tax_code,
        supplyDate,
        revenueAccountId: row.account_id,
      });
    } else {
      existing.stampedTaxMinor += row.tax_amount_minor ?? 0;
    }
  }
  return out;
}

/** One journal line as A02 takes it, plus the S6 stated base (§4b.3). */
interface PostingLine {
  account: string;
  debit?: number;
  credit?: number;
  taxCode?: string;
  taxBase?: number;
  taxAmount?: number;
  supplyDate?: string;
  baseAmountMinor?: number;
}

/** One derived credit position: the mirror of one invoice line, with its VAT still adjustable. */
interface DerivedPosting {
  revenueAccount: string;
  netMinor: number;
  /** What this line's own arithmetic computes (A06 canonical). */
  canonTaxMinor: number;
  /** What this line will book, after the S4 per-class adjustment. */
  taxMinor: number;
  /** The rate class (`formLine|rateBp`) this line declares on, or null for the 0%-and-no-VAT kinds. */
  classKey: string | null;
  taxCode: string | null;
  taxBaseMinor: number | null;
  supplyDate: string | null;
}

/** `round(base * part / total)`, half away from zero, exact and SIGN-CORRECT over BigInt. */
function shareSigned(base: number, part: number, total: number): number {
  if (total === 0 || part === 0 || base === 0) return 0;
  const n = BigInt(base) * BigInt(part);
  const d = BigInt(total);
  const negative = n < 0n !== d < 0n;
  const na = n < 0n ? -n : n;
  const da = d < 0n ? -d : d;
  const q = (na + da / 2n) / da;
  return Number(negative ? -q : q);
}

/**
 * The A10 `onIssue` poster delegate for `credit_note` (Pattern P3): build the balanced mirror entry
 * and post it through A02 `postEntry`. Runs INSIDE the transition A10 opened, so numbering and
 * posting commit or roll back together; a structured rejection aborts the whole transition (no
 * number consumed, §H-PERIOD honoured by postEntry itself, filed-period safety structural: the
 * entry is dated at issue and only at issue).
 */
export function buildCreditNotePosting(ctx: WorkspaceContext, doc: DocumentRow): Result {
  const creditedId = doc.credited_document_id ?? null;
  if (creditedId === null) return err('needs_reference_invoice', { documentId: doc.id });
  const resolved = creditableInvoice(ctx, creditedId);
  if ('refusal' in resolved) {
    // The FK named an invoice that no longer qualifies: same family of refusal, reported against
    // THIS document so the operator knows which draft is stuck.
    return { ...resolved.refusal, documentId: doc.id } as Result;
  }
  const invoice = resolved.invoice;
  if (doc.currency !== invoice.currency) {
    return err('currency_mismatch', {
      documentId: doc.id,
      documentCurrency: doc.currency,
      invoiceCurrency: invoice.currency,
      reason: 'a credit note is denominated in the currency of the invoice it credits',
    });
  }

  const lines = readLines(ctx, doc.id);
  if (lines.length === 0) return err('needs_lines', { documentId: doc.id });

  // §4b.1, the enforced premise: EVERY line of an FK-carrying credit note is attributed to a real
  // invoice position, or the closure refuses honestly. No shipped path produces an unattributed
  // line (the derivation attributes, and the edit path is closed); this refusal is what keeps that
  // true against any future path, which is exactly how H1 became possible last time.
  const invoiceLineRows = readLines(ctx, invoice.id);
  const invoiceByPos = new Map(invoiceLineRows.map((l) => [l.position, l]));
  for (const line of lines) {
    if (line.credited_line_position === null || !invoiceByPos.has(line.credited_line_position)) {
      return err('unattributed_lines', {
        documentId: doc.id,
        fromInvoiceId: invoice.id,
        position: line.position,
        reason:
          'every line of a Gutschrift must attribute to an invoice position; cancel this draft and create a new Gutschrift from the invoice',
      });
    }
  }

  const debtor = accountByNumber(ctx, ROLE_ACCOUNT_NUMBER.receivable);
  if (debtor === undefined) return err('missing_account', { account: ROLE_ACCOUNT_NUMBER.receivable });

  const entryDate = ctx.clock.now().slice(0, 10);
  const workspaceBase = baseCurrencyOf(ctx);
  const foreign = statesConversionBasis({ currency: doc.currency, baseCurrency: workspaceBase });

  // §H-FX: the rate is the one the INVOICE posted at, read off its own posted rows, never today's
  // store, so a later-imported rate cannot reprice a correction of a posting it never priced. The
  // rate is the honest per-row conversion basis; the base AMOUNTS are stated separately (S6).
  let fxRate: string | null = null;
  let rateScaled = RATE_ONE;
  if (foreign) {
    const stored = ctx.store.db
      .prepare('SELECT fx_rate FROM journal_line WHERE entry_id = ? AND fx_rate IS NOT NULL LIMIT 1')
      .get(invoice.posted_entry_id) as { fx_rate: string } | undefined;
    const parsed = stored === undefined ? null : parseRate(stored.fx_rate);
    if (stored === undefined || parsed === null) {
      // A posted foreign invoice always stamps its rate; reaching this means the referenced entry
      // is not one this engine posted. Refuse rather than resolve a fresh rate that breaks the pair.
      return err('needs_fx_rate', {
        documentId: doc.id,
        currency: doc.currency,
        reason: 'the referenced invoice posting carries no stored rate to reuse',
      });
    }
    fxRate = stored.fx_rate;
    rateScaled = parsed;
  }

  // --- Derive the positions and their canonical VAT (A06, P6) -----------------------------------
  const derived: DerivedPosting[] = [];
  for (const line of lines) {
    const revenue = revenueAccountFor(ctx, line);
    if (revenue === undefined) return err('missing_account', { account: '3200' });
    const netMinor = line.line_total_minor;
    const computed = computeLineTax(ctx, {
      amountMinor: netMinor,
      amountIsGross: false,
      taxCode: line.tax_code,
      supplyDate: line.supply_date ?? null,
    });
    if (!computed.ok) {
      return err('vat_build_failed', { line: line.position, reason: computed.error });
    }
    const kind = computed.kind as string;
    // ALL FOUR output-side kinds are creditable (the round-2 G1 law): `output` (taxed turnover),
    // `none` (no code), `zero` (EXPORT0, Art. 23) and `exempt` (AUSGENOMMEN, Art. 21). The 0% kinds
    // carry no VAT but their BASE must still flow: the trace rides the mirrored revenue leg, A02
    // stamps it negative, and A07 nets the credited base off Ziffer 220/230 in the credit's period.
    // What the guard refuses is the INPUT-side kinds (`input`, `reverse_charge`, `import`): a
    // sales-side posting must never book those, and an invoice line can only reach one if its code
    // was redefined since the invoice posted.
    if (kind !== 'none' && kind !== 'output' && kind !== 'zero' && kind !== 'exempt') {
      return err('vat_build_failed', { line: line.position, reason: `invalid_kind:${kind}` });
    }
    const trace = computed.trace as { taxCode: string | null; taxBaseMinor: number | null };
    const rateBp = computed.rateBp as number;
    const canonTax = kind === 'output' ? (computed.taxMinor as number) : 0;
    derived.push({
      revenueAccount: revenue,
      netMinor,
      canonTaxMinor: canonTax,
      taxMinor: canonTax,
      classKey: kind === 'output' && rateBp > 0 ? `${String(computed.formLine ?? '')}|${rateBp}` : null,
      taxCode: trace.taxCode,
      taxBaseMinor: trace.taxBaseMinor,
      supplyDate: line.supply_date ?? null,
    });
  }

  const subtotalMinor = derived.reduce((n, d) => n + d.netMinor, 0);

  // --- S4: the VAT this credit books closes against the INVOICE's, PER RATE CLASS (D67, D71) -----
  //
  // The invoice's per-class VAT is the statutory figure; a partial credit's own per-line rounding
  // is not. Non-exhausting credits book CANONICAL per-line VAT (S2/S3: no clamp, no adjustment).
  // The credit that EXHAUSTS the invoice's remaining net books, for EVERY rate class the pair has
  // touched, exactly that class's remaining VAT, with no per-line envelope, so unit-by-unit
  // crediting always closes and no Ziffer is left declaring a base and a tax that argue with each
  // other. A class residual lands on the class's largest line while that line's VAT stays
  // non-negative; otherwise it posts as the S5 Klassenausgleich pair below.
  const prior = priorCredits(ctx, invoice.id, doc.id);
  const remainingNet = invoice.subtotal_minor - prior.netMinor;
  const exhausting = subtotalMinor === remainingNet;

  /** S5 adjustments that cannot ride an existing line. */
  const classAdjustments: {
    diffMinor: number;
    taxCode: string;
    supplyDate: string;
    revenueAccountId: string;
  }[] = [];

  if (exhausting) {
    const invClasses = classVatOf(ctx, [invoice.posted_entry_id as string]);
    const priorClasses = classVatOf(ctx, prior.entryIds);
    const classKeys = new Set<string>([
      ...invClasses.keys(),
      ...priorClasses.keys(),
      ...derived.filter((d) => d.classKey !== null).map((d) => d.classKey as string),
    ]);
    for (const key of classKeys) {
      // remaining = the invoice's stamped class VAT minus what the priors credited. Prior credit
      // stamps are negative, so the subtraction is an addition of the stamped sums.
      const remainingClassTax =
        (invClasses.get(key)?.stampedTaxMinor ?? 0) + (priorClasses.get(key)?.stampedTaxMinor ?? 0);
      const classLines = derived.filter((d) => d.classKey === key);
      const canonSum = classLines.reduce((n, d) => n + d.canonTaxMinor, 0);
      const diff = remainingClassTax - canonSum;
      if (diff === 0) continue;
      const largest = classLines.sort((a, b) => b.canonTaxMinor - a.canonTaxMinor)[0];
      if (largest !== undefined && largest.canonTaxMinor + diff >= 0) {
        largest.taxMinor = largest.canonTaxMinor + diff;
        continue;
      }
      const info =
        largest !== undefined
          ? {
              taxCode: largest.taxCode as string,
              supplyDate: largest.supplyDate ?? entryDate,
              revenueAccountId: largest.revenueAccount,
            }
          : (invClasses.get(key) ?? priorClasses.get(key));
      if (info === undefined) continue; // a class with no source rows cannot exist; defensive
      classAdjustments.push({
        diffMinor: diff,
        taxCode: info.taxCode,
        supplyDate: info.supplyDate,
        revenueAccountId: info.revenueAccountId,
      });
    }
  }

  const taxMinor =
    derived.reduce((n, d) => n + d.taxMinor, 0) + classAdjustments.reduce((n, s) => n + s.diffMinor, 0);
  const grossTotal = subtotalMinor + taxMinor;

  // The over-credit guard (US-A13.2), uniform across modes and across repeated partial credits: the
  // sum of every issued, non-cancelled credit against this invoice never exceeds its gross. The
  // exhausting credit books exactly the remaining gross by construction, so it passes with equality.
  const remaining = invoice.total_minor - prior.grossMinor;
  if (grossTotal > remaining) {
    return err('over_credit', {
      documentId: doc.id,
      fromInvoiceId: invoice.id,
      requestedMinor: grossTotal,
      remainingCreditableMinor: remaining,
      invoiceTotalMinor: invoice.total_minor,
      currency: doc.currency,
    });
  }

  // The PER-LINE half of the same guard (§4b.1): no invoice position is ever credited past its own
  // net. With every line capped at its remainder, a credit whose total net equals the remaining net
  // has necessarily consumed exactly every position's remainder, so each rate class's NET closes
  // exactly when its VAT does. The refusal carries BOTH the line remainder AND the invoice-level
  // remainder (the round-3 H3 repair: a surface that renders only `remainingCreditableMinor` must
  // never print CHF 0.00 against a refusal that was about one line).
  {
    const creditedByPos = creditedNetByPosition(ctx, invoice.id, doc.id);
    const thisByPos = new Map<number, number>();
    for (const line of lines) {
      const position = line.credited_line_position as number;
      thisByPos.set(position, (thisByPos.get(position) ?? 0) + line.line_total_minor);
    }
    for (const [position, thisNet] of thisByPos) {
      const remainingLineNet =
        (invoiceByPos.get(position)?.line_total_minor ?? 0) - (creditedByPos.get(position) ?? 0);
      if (thisNet > remainingLineNet) {
        return err('over_credit', {
          documentId: doc.id,
          fromInvoiceId: invoice.id,
          position,
          requestedMinor: thisNet,
          remainingLineNetMinor: remainingLineNet,
          remainingCreditableMinor: remaining,
          currency: doc.currency,
          reason: 'line_over_credit',
        });
      }
    }
  }

  // --- The mirrored legs: debit revenue net (with trace), debit 2200 VAT, credit 1100 gross ------
  const outputVat = accountByNumber(ctx, ROLE_ACCOUNT_NUMBER.outputVat);
  if (outputVat === undefined && (taxMinor !== 0 || classAdjustments.length > 0)) {
    return err('missing_account', { account: ROLE_ACCOUNT_NUMBER.outputVat });
  }
  const journalLines: PostingLine[] = [];
  for (const d of derived) {
    const revenueLeg: PostingLine = { account: d.revenueAccount, debit: d.netMinor };
    if (d.taxCode !== null) {
      revenueLeg.taxCode = d.taxCode;
      if (d.taxBaseMinor !== null) revenueLeg.taxBase = d.taxBaseMinor;
      // The stated trace: A02's gate accepts it verbatim for this source (D71) and stamps it with
      // the line side's sign, still reconciling the entry's booked 2200 movement against the sum.
      revenueLeg.taxAmount = d.taxMinor;
      if (d.supplyDate !== null) revenueLeg.supplyDate = d.supplyDate;
    }
    journalLines.push(revenueLeg);
    if (d.taxMinor !== 0) {
      journalLines.push({ account: outputVat as string, debit: d.taxMinor });
    }
    journalLines.push({ account: debtor, credit: d.netMinor + d.taxMinor });
  }

  // S5, the Klassenausgleich pair. For a residual r the pair still owes the customer (r > 0) the
  // trace rides the DEBIT half, stamping -r; for a clawback of VAT the priors over-refunded (r < 0)
  // it rides the CREDIT half, stamping +|r|, because A02 couples the stamped sign to the line side.
  // The two halves cancel on the revenue account AND in the stamped base (+1/-1), so the class
  // declares a PURE TAX correction with zero base movement, which per D75 is a current-period
  // Entgeltsminderung and is rendered as stored. The debtor leg carries the same amount on the
  // matching side, so the customer's balance moves by precisely the corrected VAT. Named honestly:
  // ONE Rappen of base, an UNBOUNDED class residual of tax.
  for (const s of classAdjustments) {
    const magnitude = Math.abs(s.diffMinor);
    if (magnitude === 0) continue;
    if (s.diffMinor > 0) {
      journalLines.push({
        account: s.revenueAccountId,
        debit: 1,
        taxCode: s.taxCode,
        taxBase: 1,
        taxAmount: magnitude,
        supplyDate: s.supplyDate,
      });
      journalLines.push({
        account: s.revenueAccountId,
        credit: 1,
        taxCode: s.taxCode,
        taxBase: 1,
        taxAmount: 0,
        supplyDate: s.supplyDate,
      });
      journalLines.push({ account: outputVat as string, debit: magnitude });
      journalLines.push({ account: debtor, credit: magnitude });
    } else {
      journalLines.push({
        account: s.revenueAccountId,
        debit: 1,
        taxCode: s.taxCode,
        taxBase: 1,
        taxAmount: 0,
        supplyDate: s.supplyDate,
      });
      journalLines.push({
        account: s.revenueAccountId,
        credit: 1,
        taxCode: s.taxCode,
        taxBase: 1,
        taxAmount: magnitude,
        supplyDate: s.supplyDate,
      });
      journalLines.push({ account: outputVat as string, credit: magnitude });
      journalLines.push({ account: debtor, debit: magnitude });
    }
  }

  // --- S6 (§4b.3): the SIGNED released-base telescoping statement --------------------------------
  //
  // The invoice converted ONCE, on its side totals; a partial credit that re-converts its own
  // once-rounded amounts strands Rappen no document owns (round-1 F2), and a sign-blind cumulative
  // share breaks on a clawback (round-3 H2). So, per account: the ideal cumulative RELEASED base
  // after this credit is the A16 share rounding of (invoice booked base x cumulative released
  // transaction / invoice booked transaction), all SIGNED; the statement is that ideal figure minus
  // what the prior credits ACTUALLY posted (plugs included), so the scheme self-heals, and the
  // exhausting credit (whose cumulative release equals the invoice's own movement exactly, by the
  // per-line closure above) states booked-minus-released EXACTLY. The entry-level rounding plug
  // lands on the 1100 leg, never on a Ziffer-bearing revenue leg: 1100's mid-sequence base has no
  // filed consequence and its end state is exact by the telescoping.
  if (foreign) {
    const invMoves = accountMovements(ctx, [invoice.posted_entry_id as string]);
    const prevMoves = accountMovements(ctx, prior.entryIds);

    // This entry's signed net movement per account.
    const thisNetByAccount = new Map<string, number>();
    for (const l of journalLines) {
      const signedTxn = (l.debit ?? 0) - (l.credit ?? 0);
      thisNetByAccount.set(l.account, (thisNetByAccount.get(l.account) ?? 0) + signedTxn);
    }

    // The target signed BASE movement of this entry, per account.
    const targetBaseByAccount = new Map<string, number>();
    for (const [account, thisTxnNet] of thisNetByAccount) {
      const inv = invMoves.get(account);
      const prev = prevMoves.get(account) ?? { txn: 0, base: 0 };
      let targetBase: number;
      if (inv === undefined || inv.txn === 0) {
        // Not on the invoice's entry (a revenue account re-pointed since): no booked base to
        // share, so this slice converts at the stored rate, sign carried through.
        const magnitude = convertMinor(Math.abs(thisTxnNet), rateScaled);
        targetBase = thisTxnNet < 0 ? -magnitude : magnitude;
      } else {
        // cumulative released transaction, measured WITH the invoice's own sign: credits move
        // opposite the invoice, so releasing is the negation of the credits' cumulative movement.
        const cumReleasedTxn = -(prev.txn + thisTxnNet);
        const idealReleasedBase = shareSigned(inv.base, cumReleasedTxn, inv.txn);
        const alreadyReleasedBase = -prev.base;
        targetBase = -(idealReleasedBase - alreadyReleasedBase);
      }
      targetBaseByAccount.set(account, targetBase);
    }

    // Distribute each account's target over its legs. `baseAmountMinor` is a per-leg magnitude on
    // the leg's own side, so an account with legs on BOTH sides (the S5 pair, a clawback's flipped
    // 2200) gives its smaller side the converted magnitudes and derives the larger side.
    for (const [account, targetBase] of targetBaseByAccount) {
      const debitLegs = journalLines.filter((l) => l.account === account && l.debit !== undefined);
      const creditLegs = journalLines.filter((l) => l.account === account && l.credit !== undefined);
      const debitTxn = debitLegs.reduce((n, l) => n + (l.debit ?? 0), 0);
      const creditTxn = creditLegs.reduce((n, l) => n + (l.credit ?? 0), 0);
      let debitBaseTotal: number;
      let creditBaseTotal: number;
      if (creditLegs.length === 0) {
        debitBaseTotal = Math.max(0, targetBase);
        creditBaseTotal = 0;
      } else if (debitLegs.length === 0) {
        creditBaseTotal = Math.max(0, -targetBase);
        debitBaseTotal = 0;
      } else if (debitTxn <= creditTxn) {
        debitBaseTotal = convertMinor(debitTxn, rateScaled);
        creditBaseTotal = Math.max(0, debitBaseTotal - targetBase);
      } else {
        creditBaseTotal = convertMinor(creditTxn, rateScaled);
        debitBaseTotal = Math.max(0, creditBaseTotal + targetBase);
      }
      const spread = (legs: PostingLine[], total: number): void => {
        if (legs.length === 0) return;
        const weights = legs.map((l) => l.debit ?? l.credit ?? 0);
        const parts = apportionNet(total, weights);
        legs.forEach((l, i) => {
          l.baseAmountMinor = parts[i] as number;
        });
      };
      spread(debitLegs, debitBaseTotal);
      spread(creditLegs, creditBaseTotal);
    }

    // The entry-level plug (§4b.3): the per-account roundings can leave the sides a Rappen apart.
    // It lands on the LARGEST 1100 leg; at exhaustion it is provably zero (the invoice and every
    // prior entry each balanced in base, so the exact remainders balance too).
    const sumSide = (side: 'debit' | 'credit'): number =>
      journalLines.reduce((n, l) => n + (l[side] !== undefined ? (l.baseAmountMinor ?? 0) : 0), 0);
    let imbalance = sumSide('debit') - sumSide('credit');
    if (imbalance !== 0) {
      const debtorLegs = journalLines
        .filter((l) => l.account === debtor)
        .sort((a, b) => (b.baseAmountMinor ?? 0) - (a.baseAmountMinor ?? 0));
      for (const leg of debtorLegs) {
        if (imbalance === 0) break;
        // Adding to a CREDIT leg absorbs a positive imbalance; adding to a DEBIT leg a negative.
        const direction = leg.credit !== undefined ? 1 : -1;
        const current = leg.baseAmountMinor ?? 0;
        const next = Math.max(0, current + direction * imbalance);
        imbalance -= direction * (next - current);
        leg.baseAmountMinor = next;
      }
      if (imbalance !== 0) {
        // Nothing left to absorb it (a degenerate entry no ordinary flow reaches): refuse rather
        // than post an unbalanced statement for A02 to reject with a less specific message.
        return err('vat_residue_unexpressible', {
          documentId: doc.id,
          fromInvoiceId: invoice.id,
          residualBaseMinor: imbalance,
          reason: 'the base-currency statement cannot be balanced across this credit note\'s legs',
        });
      }
    }
  }

  // Persist the VAT total and the GROSS total on the credit note (positive figures: the sign lives
  // in the posting and the read models). Inside the issue transaction A10 opened, so a failed post
  // rolls it back with everything else.
  ctx.store.db
    .prepare('UPDATE document SET subtotal_minor = ?, tax_minor = ?, total_minor = ? WHERE workspace_id = ? AND id = ?')
    .run(subtotalMinor, taxMinor, grossTotal, ctx.workspaceId, doc.id);

  // Minted, not derived (the A11 posting-key rule): a derivable key is a squattable key.
  const postingKey = `credit-note-post-${doc.id}-${ctx.ids.next('cnpk')}`;

  const posted = postEntry(ctx, {
    date: entryDate,
    source: 'credit_note',
    ...(doc.number !== null ? { ref: doc.number } : {}),
    description: `Gutschrift ${doc.number ?? doc.id} zu Rechnung ${invoice.number ?? invoice.id}`,
    idempotencyKey: postingKey,
    lines: journalLines,
    ...(foreign ? { currency: doc.currency, fxRate: fxRate as string } : {}),
  });
  if (!posted.ok) return posted;

  // The A11 identity check, same mechanism: provenance, period and the FULL line multiset across
  // all four money dimensions. A mismatch aborts the whole transition.
  const mismatch = verifyPostedEntryIsOurs(ctx, posted.entryId, {
    source: 'credit_note',
    date: entryDate,
    ref: doc.number,
    currency: doc.currency,
    fxRate: foreign ? fxRate : null,
    rateScaled,
    lines: journalLines,
    ...(foreign ? { statedBases: journalLines.map((l) => l.baseAmountMinor ?? 0) } : {}),
  });
  if (mismatch !== null) {
    return err('posting_key_conflict', {
      documentId: doc.id,
      entryId: posted.entryId,
      expectedCreditedMinor: grossTotal,
      mismatch,
      reason: 'the entry under this credit-note posting key is not this credit note: refusing to issue against it',
    });
  }

  return ok({
    postedEntryId: posted.entryId,
    creditedDocumentId: invoice.id,
    ...(foreign
      ? { currency: doc.currency, fxRate: fxRate as string, totalMinor: grossTotal, baseCurrency: workspaceBase }
      : {}),
  });
}

/**
 * The registered credit-note poster (S7 on cancel). `onIssue` posts the mirror entry; `onCancel`
 * reverses the credit note's OWN posted entry via A02 (§H-AUDIT: the true Storno, reinstating the
 * receivables balance and giving back exactly the stated base slice), never deletes. Registered
 * into A10's seam by `index.ts`.
 */
export const creditNotePoster: DocumentPoster = {
  posts: true,
  onIssue: (ctx, doc) => buildCreditNotePosting(ctx, doc),
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

/**
 * Render the credit note as a minimal single-page PDF: number, credited invoice, amount. No QR-bill
 * and no payment part, deliberately (a Gutschrift collects nothing; the refund payout is A14/A18's).
 * A draft has no artifact: number and totals crystallise at issue, exactly the A11 rule.
 */
export function renderCreditNotePdf(
  ctx: WorkspaceContext,
  creditNoteId: string,
  opts?: { templateId?: string },
): Result {
  const view = getDocument(ctx, { documentId: creditNoteId });
  if (!view.ok) return view;
  const document = view.document as {
    type: string;
    number: string | null;
    status: string;
    currency: string;
    totalMinor: number;
    creditedDocumentId: string | null;
    contactId: string | null;
  };
  if (document.type !== 'credit_note') return err('not_a_credit_note', { documentId: creditNoteId });
  if (document.status === 'draft' || document.number === null) {
    return err('not_available', {
      documentId: creditNoteId,
      status: document.status,
      reason: 'draft_has_no_credit_note_pdf',
    });
  }

  const invoiceNumber =
    document.creditedDocumentId === null
      ? null
      : ((
          ctx.store.db
            .prepare('SELECT number FROM document WHERE workspace_id = ? AND id = ?')
            .get(ctx.workspaceId, document.creditedDocumentId) as { number: string | null } | undefined
        )?.number ?? null);

  const amount = (document.totalMinor / 100).toFixed(2);
  const bodyLines = [
    `Gutschrift ${document.number}`,
    ...(invoiceNumber !== null ? [`Zu Rechnung ${invoiceNumber}`] : []),
    `Betrag: ${document.currency} ${amount}`,
  ];
  // G05: the template seam, the A11 shape exactly. Footer lines only, resolved from the snapshot
  // frozen at issue (or the preview override); a Gutschrift has no QR payload to protect, but the
  // money figures above arrive computed and this block renders none of them.
  const tpl = resolveRenderTemplate(ctx, {
    documentKind: 'credit_note',
    table: 'document',
    rowId: creditNoteId,
    ...(opts?.templateId !== undefined ? { templateId: opts.templateId } : {}),
    contactId: document.contactId,
  });
  const footerOps = tpl.footerLines
    .map((line, i) => `BT /F1 9 Tf 60 ${240 - i * 14} Td (${pdfEscape(line)}) Tj ET`)
    .join('\n');

  const text = bodyLines
    .map((line, i) => `BT /F1 12 Tf 60 ${760 - i * 20} Td (${pdfEscape(line)}) Tj ET`)
    .join('\n');
  const pdf = buildMinimalPdf(footerOps.length === 0 ? text : `${text}\n${footerOps}`, null);
  const pdfBase64 = Buffer.from(pdf, 'latin1').toString('base64');
  return ok({
    pdf: {
      base64: pdfBase64,
      byteLength: Buffer.byteLength(pdf, 'latin1'),
      hasQrBill: false,
      qrUnavailable: { code: 'credit_note_has_no_payment_part', detail: 'a Gutschrift collects nothing' },
      qrGraphic: null,
      pdfaProfile: null,
      // G05: the template that shaped the layout (frozen at issue, or the preview override).
      templateApplied: tpl.templateId,
      templateLocale: tpl.locale,
    },
  });
}
