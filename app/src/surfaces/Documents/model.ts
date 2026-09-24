/**
 * Shared shapes and pure helpers for the Documents surface (A10, the document lifecycle).
 *
 * These mirror the engine read model (camelCase) and re-declare the P7 status/type enums and the
 * per-type transition table so the GUI shows only LEGAL actions (D19/M23: hide the nonsensical,
 * disable the precondition-blocked). The browser never imports engine code, so the machine is mirrored
 * here; a stored value the machine does not know is still rendered verbatim. Money is integer Rappen.
 */

import type { Err } from '../../lib/client';
import type { StatusKind } from '../../components/Status';

export type DocumentType = 'quote' | 'order' | 'invoice' | 'credit_note';
export type DocumentStatus =
  | 'draft'
  | 'issued'
  | 'sent'
  | 'accepted'
  | 'declined'
  | 'confirmed'
  | 'partially_paid'
  | 'settled'
  | 'converted'
  | 'cancelled'
  | 'expired'
  | 'superseded';

/** The type tabs on S1, in display order. */
export const DOCUMENT_TYPES: readonly DocumentType[] = ['quote', 'order', 'invoice', 'credit_note'];

export interface DocumentLine {
  id?: string;
  /** The engine's 1-based line position: the key credit-note attribution speaks in (§4b.1). */
  position?: number;
  itemId?: string | null;
  description?: string | null;
  quantityMilli?: number;
  unitPriceMinor: number;
  lineTotalMinor?: number;
  taxCode?: string | null;
  supplyDate?: string | null;
  /** A13 §4b.1: the invoice position a derived credit line attributes to; null elsewhere. The
   *  Studio never writes it: the derivation is the one writer, and the editor's credit-note mode
   *  renders lines read-only precisely so no save can touch it. */
  creditedLinePosition?: number | null;
}

/**
 * §H-FX: what the BOOKS hold, beside what was billed, exactly as the engine reports it.
 *
 * Three shapes, and all three are real. The engine gates the whole group on A02's
 * `statesConversionBasis` (`src/core/sales/document.ts`, `mapDocument`), which asks only whether the
 * document's currency differs from the workspace base currency. So:
 *
 *  1. A document already in the base currency states no basis at all: none of the four keys are
 *     sent. Restating a franc total as a franc "base total" is noise on the overwhelming majority of
 *     documents, and the engine declines to do it.
 *  2. A foreign document that has not posted yet knows the currency the books will convert INTO, but
 *     no rate has been stamped, so `baseCurrency` arrives while every figure is null. This is
 *     the arm the brief for this work predicted would not exist, and the live engine sends it: a
 *     type saying "all of them or none" would be a lie about a draft EUR invoice.
 *  3. A posted foreign document carries all four, including at a rate of exactly 1, because parity
 *     is a stated basis and not the absence of one.
 *
 * THE FOURTH ARM, which is a distinction of value inside shape 3 rather than a fourth shape. A
 * foreign invoice that posted but charged no VAT at all (a pure export under MWSTG Art. 23, echt
 * befreit) writes no output-VAT row for the engine's subquery to find, so `baseTaxMinor` is ZERO
 * FRANCS on an invoice that really posted. Null on that field means nothing has posted, and
 * `postedEntryId` is what separates the two. Collapsing them would tell a filer that an invoice they
 * issued last quarter has not reached the books, which is why the type keeps zero inside the number
 * arm rather than reaching for a nullable there.
 *
 * The union makes the pairing structural rather than conventional: `totalBaseMinor`, `fxRate` and
 * `baseTaxMinor` are all figures the POSTING stamped or the posted rows yield, so there is no arm in
 * which one exists without the others, and no arm in which any exists without the currency that
 * denominates it. `postedBaseFigures` below is the runtime half of the same guarantee, because the
 * wire is JSON and the type is only a promise.
 *
 * `fxRateAsOf` is not here, deliberately: no `rate_as_of` column exists on either journal table, so
 * the engine cannot report which rate priced the invoice without re-resolving it from a mutable
 * store. The client must not display a validity date, and must not infer one.
 */
export type DocumentFx =
  | { baseCurrency?: undefined; totalBaseMinor?: undefined; fxRate?: undefined; baseTaxMinor?: undefined }
  | { baseCurrency: string; totalBaseMinor: null; fxRate: null; baseTaxMinor: null }
  | { baseCurrency: string; totalBaseMinor: number; fxRate: string; baseTaxMinor: number };

/** The figures a POSTED foreign-currency document carries, once all four are proven present. */
export interface PostedBaseFigures {
  /** The base-currency total, in integer minor units, summed from the posted rows by the engine. */
  totalBaseMinor: number;
  /** The rate the posted rows carry, as the engine's own canonical string. Never re-parsed here. */
  fxRate: string;
  /** The currency the books hold, so the base figure is denominated and never a bare number. */
  baseCurrency: string;
  /**
   * The VAT in the base currency: the figure a Swiss MWST-Abrechnung is actually filed on (MWSTV
   * Art. 45). The engine derives it at read time by summing the output-VAT account's base credits
   * net of its base debits on the posted entry, so it is the ledger's own allocation.
   *
   * It is NOT `taxMinor * fxRate` and must never be computed that way here. `applyFx` rounds ONCE on
   * the side total and allocates back by largest remainder, so a per-figure product is the client
   * inventing a second rounding: on the pinned two-rate fixture the books hold CHF 19.91 and the
   * product yields CHF 19.92.
   */
  baseTaxMinor: number;
}

/**
 * The base-currency figures the LEDGER posted, or null when there are none to show.
 *
 * The guard checks all four at RUNTIME rather than trusting the cast that produced the `DocumentDto`,
 * because every one of these objects entered the app as `body.document as DocumentDto` over an HTTP
 * boundary. Narrowing off `postedEntryId` instead would be the client deciding for itself which
 * documents have base figures, which is one inference away from computing them.
 *
 * All four or none, in one branch, because the engine sends them under one gate. A group that
 * arrived three-of-four is an engine this client does not understand, and rendering three quarters
 * of a disclosure is worse than rendering none: the reader cannot see which quarter is missing.
 */
export function postedBaseFigures(doc: DocumentDto): PostedBaseFigures | null {
  const { totalBaseMinor, fxRate, baseCurrency, baseTaxMinor } = doc;
  if (typeof totalBaseMinor !== 'number') return null;
  if (typeof fxRate !== 'string' || fxRate === '') return null;
  if (typeof baseCurrency !== 'string' || baseCurrency === '') return null;
  // `typeof`, not a truthiness check: a pure export posts a franc VAT of exactly 0, and 0 is falsy.
  // Losing the arm here would hide the disclosure on every zero-rated export in the books.
  if (typeof baseTaxMinor !== 'number') return null;
  return { totalBaseMinor, fxRate, baseCurrency, baseTaxMinor };
}

export type DocumentDto = DocumentCore & DocumentFx;

interface DocumentCore {
  id: string;
  type: DocumentType;
  number: string | null;
  status: DocumentStatus;
  contactId: string | null;
  currency: string;
  sourceDocumentId: string | null;
  /**
   * The document this one was converted INTO, or null. The reverse of `sourceDocumentId`, and the
   * engine's own answer to A10-G6: S3 used to derive it by listing every document and looking for
   * the one whose source is this one, which inherits the D34 1000-row page ceiling and would have
   * gone quietly wrong on the 1001st document, showing a dead end instead of a link.
   */
  targetDocumentId: string | null;
  postedEntryId: string | null;
  subtotalMinor: number;
  taxMinor: number;
  totalMinor: number;
  issueDate: string | null;
  dueDate: string | null;
  /**
   * The address this invoice was really emailed to, or null. Written ONLY after a transmission the
   * relay accepted, which makes it evidence rather than decoration: a non-null value means the mail
   * left the building, and it survives a reload, so S3 can still name the recipient tomorrow.
   */
  sentToEmail: string | null;
  /** A13: the invoice this Gutschrift credits, or null on every other type (and on a credit-note
   *  draft made through the generic verb, which the engine will refuse to issue). */
  creditedDocumentId: string | null;
  notes: string | null;
  createdAt: string;
}

export interface HistoryEntry {
  fromStatus: string | null;
  toStatus: string;
  actor: string | null;
  at: string;
}

/** The i18n key segment for a type: `credit_note` -> `creditNote`. */
export function typeKey(type: string): string {
  return type === 'credit_note' ? 'document.type.creditNote' : `document.type.${type}`;
}

/** The i18n key segment for a status: `partially_paid` -> `partiallyPaid`. */
export function statusKey(status: string): string {
  const camel = status.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());
  return `document.status.${camel}`;
}

/**
 * The shared Status vocabulary for a document's lifecycle word (K-22): one glyph system and one weight
 * for the list column and the detail head, where "Akzeptiert" used to be bold and "Entwurf" dim with
 * no glyph at all.
 */
export function documentStatusKind(status: string, overdue = false): StatusKind {
  if (overdue) return 'warn';
  switch (status) {
    case 'accepted':
    case 'confirmed':
    case 'settled':
    case 'converted':
      return 'success';
    case 'issued':
    case 'sent':
    case 'partially_paid':
      return 'pending';
    case 'declined':
      return 'danger';
    case 'cancelled':
    case 'expired':
    case 'superseded':
      return 'inactive';
    default:
      return 'neutral';
  }
}

/**
 * The per-type legal transitions (a mirror of the engine's guard table, spec §4). Used only to decide
 * which action controls to render; the engine remains the authority and re-checks every call.
 */
const TRANSITIONS: Record<DocumentType, Partial<Record<DocumentStatus, DocumentStatus[]>>> = {
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

const CONVERSIONS: Partial<Record<DocumentType, { from: DocumentStatus; toTypes: DocumentType[] }>> = {
  quote: { from: 'accepted', toTypes: ['order', 'invoice'] },
  order: { from: 'confirmed', toTypes: ['invoice'] },
};

/** An action the surface may offer: a status transition, a conversion, or a draft delete. */
export interface DocumentAction {
  kind: 'transition' | 'convert' | 'delete';
  /** For a transition/delete: the target status. */
  to?: DocumentStatus;
  /** For a convert: the target type. */
  toType?: DocumentType;
  labelKey: string;
  /** Danger styling + confirm gate (storno, delete). */
  danger?: boolean;
}

const TRANSITION_LABEL: Partial<Record<DocumentStatus, string>> = {
  issued: 'document.action.issue',
  sent: 'document.action.send',
  accepted: 'document.action.accept',
  declined: 'document.action.decline',
  confirmed: 'document.action.confirm',
  expired: 'document.action.expire',
  superseded: 'document.action.supersede',
};

/** True once a document has posted a ledger entry, so cancel is a Storno (reversal), never a delete. */
export function isPosted(doc: DocumentDto): boolean {
  return doc.postedEntryId !== null;
}

/**
 * The legal actions for a document, split into a single primary (the forward step) and the rest
 * (secondary + destructive, destructive last). Terminal states return no actions. This is the D15/C3
 * one-rule surface: only legal actions appear at all; the caller disables the ones whose preconditions
 * are unmet (needs_lines, needs_customer) with an inline reason.
 */
export function documentActions(doc: DocumentDto): { primary: DocumentAction | null; overflow: DocumentAction[] } {
  const legal = TRANSITIONS[doc.type]?.[doc.status] ?? [];
  const overflow: DocumentAction[] = [];
  let primary: DocumentAction | null = null;

  // Cancel is a delete for a draft, a Storno for a posted/issued document; it always lives last in
  // the overflow, never as a primary (a destructive-shaped action needs a deliberate act, M25).
  const canCancel = legal.includes('cancelled');

  // Forward transitions (everything except cancel), in table order, become candidate actions.
  const forward = legal.filter((to) => to !== 'cancelled');
  for (const to of forward) {
    const action: DocumentAction = { kind: 'transition', to, labelKey: TRANSITION_LABEL[to] ?? statusKey(to) };
    // The first forward transition is the primary; the rest (e.g. decline, expire) go to the overflow.
    if (primary === null) primary = action;
    else overflow.push(action);
  }

  // Conversions: from the accepted/confirmed state, converting is the natural forward step, so it
  // takes precedence as the primary and the plain forward (if any) steps aside.
  const conv = CONVERSIONS[doc.type];
  if (conv !== undefined && doc.status === conv.from) {
    const convActions = conv.toTypes.map<DocumentAction>((toType) => ({
      kind: 'convert',
      toType,
      labelKey: toType === 'order' ? 'document.action.convertToOrder' : 'document.action.convertToInvoice',
    }));
    // Prefer converting to an invoice as the primary (the billing goal); others to the overflow.
    const preferred = convActions.find((a) => a.toType === 'invoice') ?? convActions[0];
    if (primary !== null) overflow.unshift(primary);
    primary = preferred ?? null;
    for (const a of convActions) if (a !== preferred) overflow.push(a);
  }

  if (canCancel) {
    overflow.push(
      doc.status === 'draft'
        ? { kind: 'delete', to: 'cancelled', labelKey: 'document.action.delete', danger: true }
        : { kind: 'transition', to: 'cancelled', labelKey: 'document.action.cancel', danger: true },
    );
  }

  return { primary, overflow };
}

/** A short, stable idempotency key for agent-safe writes (§H-IDEMPOTENT). */
/**
 * F-03 (J3.5): what the send half of "Ausstellen und senden" came back with, carried from the
 * editor to the detail that acknowledges the act. `failed` keeps the engine's structured refusal so
 * the detail can name the reason and its ways out (the PDF, the setup).
 */
export type SendOutcome = { kind: 'sent'; email: string } | { kind: 'failed'; email: string; error: Err };

export function idemKey(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Parse a decimal string ("150", "150.50", "1'234.55") into integer Rappen, exactly (never a binary
 * float). A blank or malformed field is 0, so an incomplete draft line simply contributes nothing.
 */
export function parseMinor(raw: string): number {
  const cleaned = raw.trim().replace(/[\s']/g, '');
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(cleaned);
  if (match === null) return 0;
  return Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
}

/** Parse a quantity ("10", "10.5", "0.25") into integer thousandths. Blank defaults to one unit. */
export function parseMilli(raw: string): number {
  const cleaned = raw.trim().replace(/[\s']/g, '');
  if (cleaned === '') return 1000;
  const match = /^(\d+)(?:\.(\d{1,3}))?$/.exec(cleaned);
  if (match === null) return 0;
  return Number(match[1]) * 1000 + Number((match[2] ?? '').padEnd(3, '0'));
}

/** A line net total in Rappen, half away from zero, matching the engine's lineTotal. */
export function lineTotalMinor(quantityMilli: number, unitPriceMinor: number): number {
  const scaled = quantityMilli * unitPriceMinor;
  return scaled < 0 ? -Math.round(-scaled / 1000) : Math.round(scaled / 1000);
}
