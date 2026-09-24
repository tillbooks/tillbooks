/**
 * C02, quotes / proposals (Offerte): a thin rider over A10's shared document machine.
 *
 * A quote is an A10 `document` with `type='quote'`. A10 already owns everything that matters here:
 * the numbering series (`O-YYYY-NNNN`), the guarded transition table
 * (`draft -> issued -> sent -> {accepted, declined, expired, superseded, cancelled}`,
 * `declined|expired -> superseded`, `accepted -> converted`), the status trail, and a NO-OP poster
 * so issuing a quote posts NOTHING to the ledger (P3). C02 adds NO state machine and NO posting
 * path: every verb below is a wrapper over `createDocument` / `updateDocument` / `transitionDocument`
 * / `convertDocument`, plus the quote-owned columns on the shared row (spec §4) and the OP4 accept
 * token. `convertQuote` is a 1:1 pass-through to A10's `convertDocument`, which clones the frozen
 * `document_line` rows (the tax trace travels with them) and marks the source `converted`.
 *
 * THE MONEY-PATH DISCIPLINE, stated where it is enforced:
 *  - QUOTE CREATION POSTS NOTHING. `createQuote` calls `createDocument` (a no-op poster) and never
 *    `postEntry` / `recordPayment`. Asserted in `test/sales/quotes-c02.test.mjs`.
 *  - CONVERT IS IDEMPOTENT AND SINGLE-ISSUE. `convertDocument` replays a completed conversion and
 *    structurally refuses a second target from an already-`converted` source, so a double-convert
 *    yields exactly ONE A10 document. C02 adds nothing that could fork that.
 *  - TAX + TOTALS FREEZE. `createQuote` resolves each line's price (D00, once) and tax code (A05
 *    default, once) and snapshots them as literal `unit_price_minor` + `tax_code` on the
 *    `document_line` row. A10 makes a non-draft document immutable (`updateDocument` refuses a patch
 *    on anything but a draft), and `convertDocument` clones those literals byte-for-byte, so a later
 *    price-list or tax-code change can never move an accepted or converted quote's figures.
 *  - §H-TENANT. Every read is scoped to `ctx.workspaceId`; `createDocument`'s `validateReferences`
 *    refuses a foreign contact or item id, and the accept-token lookup is workspace-scoped, so a
 *    cross-tenant token can never resolve.
 */

import { createHash, randomBytes } from 'node:crypto';

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import {
  createDocument,
  updateDocument,
  transitionDocument,
  convertDocument,
  getDocument,
  listDocuments,
} from './document.js';
import type { DocumentLineInput } from './document.js';
import { resolvePrice } from './priceLists.js';
import { logActivity } from './contactActivity.js';
// G00's saved-view seam. A quote saved view is keyed to the `quote` entityKind, so `listQuotes`
// resolves it HERE (against `quote`) rather than letting `listDocuments` resolve a `document` view.
import { applySavedView } from '../customization/views.js';
import { recordDispatch } from '../customization/dispatch.js';

/** The two A10-owned types a quote may convert into (spec §4/§7, single-sourced here). */
export const QUOTE_CONVERT_TARGETS = ['order', 'invoice'] as const;
export type QuoteConvertTarget = (typeof QUOTE_CONVERT_TARGETS)[number];

/**
 * The source statuses from which `reviseQuote` may version a quote (US-C02.5, §7). This mirrors
 * A10's transition table exactly: `TRANSITIONS.quote` only allows `superseded` FROM `sent`,
 * `declined` or `expired`. A `draft` is edited in place (`edit_draft_instead`), and an `accepted`
 * or `converted` quote is the binding record (OR Art. 3 ff.) and is refused. The revise verb
 * pre-checks against this set BEFORE any write, so a rejection writes ZERO rows.
 */
export const REVISABLE_QUOTE_STATES = ['sent', 'declined', 'expired'] as const;

/** A line as the quote verbs accept it: A10's line plus the optional item link the resolver reads. */
export interface QuoteLineInput {
  itemId?: string | null;
  description?: string | null;
  quantityMilli?: number;
  unitPriceMinor?: number;
  taxCode?: string | null;
  supplyDate?: string | null;
}

// --- Helpers -----------------------------------------------------------------------------------

/** The bare day (YYYY-MM-DD) of the injected clock. */
function today(ctx: WorkspaceContext): string {
  return ctx.clock.now().slice(0, 10);
}

/** The hash stored for an accept token: the token itself is returned once and never persisted. */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** The C02-owned columns on a quote's `document` row, read alongside A10's own projection. */
interface QuoteColumns {
  valid_until: string | null;
  deal_id: string | null;
  intro: string | null;
  outro: string | null;
  version: number;
  supersedes_id: string | null;
  accepted_by: string | null;
  decline_reason: string | null;
  accept_token_hash: string | null;
}

function readQuoteColumns(ctx: WorkspaceContext, id: string): QuoteColumns | undefined {
  return ctx.store.db
    .prepare(
      `SELECT valid_until, deal_id, intro, outro, version, supersedes_id, accepted_by, decline_reason, accept_token_hash
         FROM document WHERE workspace_id = ? AND id = ? AND type = 'quote'`,
    )
    .get(ctx.workspaceId, id) as QuoteColumns | undefined;
}

/** True if a `sent` quote's binding window has closed (derived on read, never mutating, spec §4). */
function isExpiredOnRead(status: string, validUntil: string | null, day: string): boolean {
  return status === 'sent' && typeof validUntil === 'string' && validUntil < day;
}

/**
 * Attach the quote-owned columns to A10's document view. The derived `expired` flag mirrors the
 * A15/A16 "überfällig is computed at read" rule so a list never shows a past-validity offer as still
 * open, without writing to the row (the sweep does the durable transition).
 */
function quoteViewOf(ctx: WorkspaceContext, id: string): Result {
  const base = getDocument(ctx, { documentId: id });
  if (!base.ok) return base;
  const cols = readQuoteColumns(ctx, id);
  if (cols === undefined) return err('not_found', { quoteId: id });
  const document = (base as unknown as { document: Record<string, unknown> }).document;
  return ok({
    ...(base as unknown as Record<string, unknown>),
    document: {
      ...document,
      validUntil: cols.valid_until,
      dealId: cols.deal_id,
      intro: cols.intro,
      outro: cols.outro,
      version: cols.version,
      supersedesId: cols.supersedes_id,
      acceptedBy: cols.accepted_by,
      declineReason: cols.decline_reason,
      hasAcceptToken: cols.accept_token_hash !== null,
      expired: isExpiredOnRead(String(document.status), cols.valid_until, today(ctx)),
    },
  });
}

/**
 * Resolve each line's price and tax code EXACTLY ONCE and snapshot them as literals (P6/P2). An
 * explicit `unitPriceMinor` wins; otherwise an item line is priced through D00's resolver (contact
 * list -> segment list -> item base) and a free-text line without a price is refused. The tax code
 * is the explicit one, else the item's A05 default, else null (A11 resolves the amount at issue).
 */
function resolveLines(ctx: WorkspaceContext, lines: QuoteLineInput[], contactId: string | null): Result {
  const at = today(ctx);
  const resolved: DocumentLineInput[] = [];
  for (const [index, line] of lines.entries()) {
    const position = index + 1;
    let unitPriceMinor = line.unitPriceMinor;
    let taxCode: string | null | undefined = line.taxCode;

    if (typeof line.itemId === 'string' && line.itemId.length > 0) {
      if (unitPriceMinor === undefined) {
        const priced = resolvePrice(ctx, { itemId: line.itemId, contactId, at });
        if (!priced.ok) return priced;
        unitPriceMinor = (priced as unknown as { priceMinor: number }).priceMinor;
      }
      if (taxCode === undefined) {
        const item = ctx.store.db
          .prepare('SELECT default_tax_code FROM item WHERE workspace_id = ? AND id = ?')
          .get(ctx.workspaceId, line.itemId) as { default_tax_code: string | null } | undefined;
        taxCode = item?.default_tax_code ?? null;
      }
    }

    if (typeof unitPriceMinor !== 'number') {
      return err('invalid_line', {
        position,
        field: 'unitPriceMinor',
        reason: 'a free-text line needs a unit price; an item line is priced from D00',
      });
    }
    const entry: DocumentLineInput = {
      itemId: line.itemId ?? null,
      description: line.description ?? null,
      unitPriceMinor,
      taxCode: taxCode ?? null,
      supplyDate: line.supplyDate ?? null,
    };
    if (line.quantityMilli !== undefined) entry.quantityMilli = line.quantityMilli;
    resolved.push(entry);
  }
  return ok({ lines: resolved });
}

/** Set the quote-owned columns on a freshly created/updated `document` row, within the ambient tx. */
function writeQuoteColumns(
  ctx: WorkspaceContext,
  id: string,
  cols: {
    validUntil?: string | null | undefined;
    dealId?: string | null | undefined;
    intro?: string | null | undefined;
    outro?: string | null | undefined;
  },
): void {
  const sets: string[] = [];
  const params: (string | null)[] = [];
  if (cols.validUntil !== undefined) {
    sets.push('valid_until = ?');
    params.push(cols.validUntil);
  }
  if (cols.dealId !== undefined) {
    sets.push('deal_id = ?');
    params.push(cols.dealId);
  }
  if (cols.intro !== undefined) {
    sets.push('intro = ?');
    params.push(cols.intro);
  }
  if (cols.outro !== undefined) {
    sets.push('outro = ?');
    params.push(cols.outro);
  }
  if (sets.length === 0) return;
  ctx.store.db
    .prepare(`UPDATE document SET ${sets.join(', ')} WHERE workspace_id = ? AND id = ?`)
    .run(...params, ctx.workspaceId, id);
}

/** Best-effort OP5 timeline note; a quote with no contact simply logs nothing (never throws). */
function logQuoteActivity(ctx: WorkspaceContext, contactId: string | null, body: string): void {
  if (typeof contactId !== 'string' || contactId.length === 0) return;
  logActivity(ctx, { contactId, kind: 'note', body });
}

function documentIdOf(res: Result): string {
  return (res as unknown as { document: { id: string } }).document.id;
}

/**
 * Carries a structured `err` out of a transaction by THROWING it, so better-sqlite3 rolls the
 * write back instead of committing it.
 */
class TxAbort extends Error {
  constructor(readonly result: Result) {
    super('tx_abort');
  }
}

/**
 * Run a verb body inside a transaction (idempotent when a key is given) with COMMIT-ON-OK
 * semantics. This is the defence against a money-path footgun: `better-sqlite3`'s
 * `db.transaction(fn)` only rolls back when `fn` THROWS. A `run` callback that performs a write and
 * then RETURNS a `{ok:false}` err (the P9 rejection shape) would otherwise COMMIT the partial write
 * while reporting failure, e.g. an orphaned draft left behind by a revise whose supersede transition
 * was refused. Wrapping every `run` so an err THROWS (and is translated back to the same err outside
 * the tx) guarantees the invariant every quote verb depends on: when a verb returns an error, NO
 * rows were written. Applied uniformly to all C02 verbs, not just the one that was caught, because
 * the failure mode is structural, not local. It also stops `rememberIdempotent` from memoising a
 * rejection: the throw rolls back before the idempotency row is inserted, so a retry after the state
 * is fixed can still succeed.
 */
function runTx(ctx: WorkspaceContext, verb: string, idempotencyKey: string | undefined, run: () => Result): Result {
  const guarded = (): Result => {
    const r = run();
    if (!r.ok) throw new TxAbort(r);
    return r;
  };
  try {
    return typeof idempotencyKey === 'string' && idempotencyKey.length > 0
      ? ctx.store.rememberIdempotent(ctx.workspaceId, idempotencyKey, verb, guarded)
      : ctx.store.tx(guarded);
  } catch (e) {
    if (e instanceof TxAbort) return e.result;
    throw e;
  }
}

// --- Verbs -------------------------------------------------------------------------------------

export interface CreateQuoteInput {
  contactId?: string | null;
  dealId?: string | null;
  currency?: string;
  validUntil?: string | null;
  intro?: string | null;
  outro?: string | null;
  lines?: QuoteLineInput[];
  idempotencyKey?: string;
}

export function createQuote(ctx: WorkspaceContext, input: CreateQuoteInput): Result {
  if (typeof input.validUntil === 'string' && input.validUntil.length > 0 && input.validUntil < today(ctx)) {
    return err('validity_in_past', { validUntil: input.validUntil });
  }
  const resolvedLines = resolveLines(ctx, input.lines ?? [], input.contactId ?? null);
  if (!resolvedLines.ok) return resolvedLines;
  const lines = (resolvedLines as unknown as { lines: DocumentLineInput[] }).lines;

  const run = (): Result => {
    const created = createDocument(ctx, {
      type: 'quote',
      contactId: input.contactId ?? null,
      lines,
      ...(input.currency !== undefined ? { currency: input.currency } : {}),
    });
    if (!created.ok) return created;
    const id = documentIdOf(created);
    writeQuoteColumns(ctx, id, {
      validUntil: input.validUntil ?? null,
      dealId: input.dealId ?? null,
      intro: input.intro ?? null,
      outro: input.outro ?? null,
    });
    return quoteViewOf(ctx, id);
  };

  return runTx(ctx, 'quotes_create', input.idempotencyKey, run);
}

export interface UpdateQuoteInput {
  quoteId: string;
  patch: {
    contactId?: string | null;
    currency?: string;
    intro?: string | null;
    outro?: string | null;
    validUntil?: string | null;
    lines?: QuoteLineInput[];
  };
  idempotencyKey?: string;
}

export function updateQuote(ctx: WorkspaceContext, input: UpdateQuoteInput): Result {
  const cols = readQuoteColumns(ctx, input.quoteId);
  if (cols === undefined) return err('not_found', { quoteId: input.quoteId });
  const patch = input.patch ?? {};
  if (typeof patch.validUntil === 'string' && patch.validUntil.length > 0 && patch.validUntil < today(ctx)) {
    return err('validity_in_past', { validUntil: patch.validUntil });
  }

  // Re-resolve prices/tax on a line change so an edited draft re-snapshots exactly as create does.
  let resolvedLines: DocumentLineInput[] | undefined;
  if (patch.lines !== undefined) {
    const contactId = patch.contactId !== undefined ? patch.contactId : null;
    const res = resolveLines(ctx, patch.lines, contactId ?? null);
    if (!res.ok) return res;
    resolvedLines = (res as unknown as { lines: DocumentLineInput[] }).lines;
  }

  const run = (): Result => {
    // A10 owns the draft-only guard and the lines/currency/contact patch; a non-draft quote is
    // refused there (`document_immutable`), which is the tax/total freeze at work.
    const updated = updateDocument(ctx, {
      documentId: input.quoteId,
      patch: {
        ...(patch.contactId !== undefined ? { contactId: patch.contactId } : {}),
        ...(patch.currency !== undefined ? { currency: patch.currency } : {}),
        ...(resolvedLines !== undefined ? { lines: resolvedLines } : {}),
      },
    });
    if (!updated.ok) return updated;
    writeQuoteColumns(ctx, input.quoteId, {
      validUntil: patch.validUntil,
      intro: patch.intro,
      outro: patch.outro,
    });
    return quoteViewOf(ctx, input.quoteId);
  };

  return runTx(ctx, 'quotes_update', input.idempotencyKey, run);
}

export interface SendQuoteInput {
  quoteId: string;
  idempotencyKey?: string;
}

export function sendQuote(ctx: WorkspaceContext, input: SendQuoteInput): Result {
  const run = (): Result => {
    const cols = readQuoteColumns(ctx, input.quoteId);
    if (cols === undefined) return err('not_found', { quoteId: input.quoteId });
    const before = getDocument(ctx, { documentId: input.quoteId });
    if (!before.ok) return before;
    const status = String((before as unknown as { document: { status: string; contactId: string | null } }).document.status);
    const contactId = (before as unknown as { document: { contactId: string | null } }).document.contactId;
    // P8 draft-gate: send is the outbound moment, only a draft may take it. A non-draft is A10's
    // `illegal_transition` shape, surfaced consistently.
    if (status !== 'draft') {
      return err('illegal_transition', { from: status, to: 'sent', type: 'quote', reason: 'send_requires_draft' });
    }
    // A quote with no lines cannot be sent (US-C02.2). A10 would reject the issue with `needs_lines`;
    // name it in C02's own vocabulary before the two-hop starts.
    const lineCount = ctx.store.db
      .prepare('SELECT COUNT(*) AS n FROM document_line WHERE document_id = ?')
      .get(input.quoteId) as { n: number };
    if (lineCount.n === 0) return err('no_lines', { quoteId: input.quoteId });

    // (a) issue: assigns the gap-free O-number; the no-op poster posts nothing.
    const issued = transitionDocument(ctx, { documentId: input.quoteId, to: 'issued' });
    if (!issued.ok) return issued;

    // (c) mint the single-use accept token; only the hash is stored on the row (OP4, revDSG).
    const token = randomBytes(32).toString('hex');
    ctx.store.db
      .prepare("UPDATE document SET accept_token_hash = ? WHERE workspace_id = ? AND id = ? AND type = 'quote'")
      .run(hashToken(token), ctx.workspaceId, input.quoteId);

    // (d) sent.
    const sent = transitionDocument(ctx, { documentId: input.quoteId, to: 'sent' });
    if (!sent.ok) return sent;

    // (e) OP5 log (best-effort).
    logQuoteActivity(ctx, contactId, 'Offerte versendet (Artefakt erstellt).');

    // (e2) G05 §10: one `dispatches` row IN THE SAME WRITE as the issued->sent transition. C02's
    // designed OSS-core completion is `channel:'artifact_only'`, `outcome:'artifact_created'`: not
    // `sent` (TILL transmitted nothing) and not `degraded` (producing the artifact IS this path's
    // success). No recipient and empty resolved text, honestly: nothing textual left the
    // workspace, and the operator's manual send after download is invisible to this log by design.
    recordDispatch(ctx, {
      documentKind: 'quote',
      documentId: input.quoteId,
      contactId,
      channel: 'artifact_only',
      locale: 'de-CH',
      subjectResolved: '',
      bodyResolved: '',
      defaulted: true,
      outcome: 'artifact_created',
    });

    // OP4: the OSS core produces the local artifact + the accept link and stops. Sending is the
    // cloud tier; G05's dispatch delegate is not built (W10), so we degrade gracefully rather than
    // crash: a structured, honest `transmitted:false`.
    const view = quoteViewOf(ctx, input.quoteId);
    if (!view.ok) return view;
    return ok({
      ...(view as unknown as Record<string, unknown>),
      transmitted: false,
      reason: 'cloud_tier',
      dispatch: 'needs_dispatch_module',
      acceptToken: token,
      acceptUrl: `/quotes/accept?token=${token}`,
    });
  };

  return runTx(ctx, 'quotes_send', input.idempotencyKey, run);
}

export interface AcceptQuoteInput {
  quoteId?: string;
  token?: string;
  actor?: string;
  acceptedBy?: string;
  idempotencyKey?: string;
}

export function acceptQuote(ctx: WorkspaceContext, input: AcceptQuoteInput): Result {
  const run = (): Result => {
    // Resolve the quote either by its single-use token (the cloud accept host) or by id (the human
    // "Als angenommen markieren" path). The token lookup is §H-TENANT scoped, so a token minted in
    // another workspace can never resolve here.
    let quoteId = input.quoteId;
    if (typeof input.token === 'string' && input.token.length > 0) {
      const row = ctx.store.db
        .prepare("SELECT id FROM document WHERE workspace_id = ? AND type = 'quote' AND accept_token_hash = ?")
        .get(ctx.workspaceId, hashToken(input.token)) as { id: string } | undefined;
      if (row === undefined) return err('invalid_token', {});
      quoteId = row.id;
    }
    if (typeof quoteId !== 'string' || quoteId.length === 0) {
      return err('invalid_input', { field: 'quoteId', reason: 'quotes_accept needs a quoteId or a token' });
    }

    const cols = readQuoteColumns(ctx, quoteId);
    if (cols === undefined) return err('not_found', { quoteId });
    const before = getDocument(ctx, { documentId: quoteId });
    if (!before.ok) return before;
    const doc = (before as unknown as { document: { status: string; contactId: string | null } }).document;

    // OR Art. 3: acceptance after the binding window has closed is refused.
    if (typeof cols.valid_until === 'string' && cols.valid_until.length > 0 && cols.valid_until < today(ctx)) {
      return err('quote_expired', { quoteId, validUntil: cols.valid_until });
    }

    const accepted = transitionDocument(ctx, { documentId: quoteId, to: 'accepted' });
    if (!accepted.ok) return accepted;

    // Stamp who accepted and invalidate the token (single-use). The WHEN lives in A10's status trail.
    const acceptedBy = input.acceptedBy ?? input.actor ?? ctx.actor ?? null;
    ctx.store.db
      .prepare("UPDATE document SET accepted_by = ?, accept_token_hash = NULL WHERE workspace_id = ? AND id = ?")
      .run(acceptedBy, ctx.workspaceId, quoteId);

    logQuoteActivity(ctx, doc.contactId, 'Offerte angenommen.');
    return quoteViewOf(ctx, quoteId);
  };

  return runTx(ctx, 'quotes_accept', input.idempotencyKey, run);
}

export interface DeclineQuoteInput {
  quoteId?: string;
  token?: string;
  declineReason?: string;
  idempotencyKey?: string;
}

export function declineQuote(ctx: WorkspaceContext, input: DeclineQuoteInput): Result {
  const run = (): Result => {
    let quoteId = input.quoteId;
    if (typeof input.token === 'string' && input.token.length > 0) {
      const row = ctx.store.db
        .prepare("SELECT id FROM document WHERE workspace_id = ? AND type = 'quote' AND accept_token_hash = ?")
        .get(ctx.workspaceId, hashToken(input.token)) as { id: string } | undefined;
      if (row === undefined) return err('invalid_token', {});
      quoteId = row.id;
    }
    if (typeof quoteId !== 'string' || quoteId.length === 0) {
      return err('invalid_input', { field: 'quoteId', reason: 'quotes_decline needs a quoteId or a token' });
    }
    const cols = readQuoteColumns(ctx, quoteId);
    if (cols === undefined) return err('not_found', { quoteId });
    const before = getDocument(ctx, { documentId: quoteId });
    if (!before.ok) return before;
    const contactId = (before as unknown as { document: { contactId: string | null } }).document.contactId;

    const declined = transitionDocument(ctx, { documentId: quoteId, to: 'declined' });
    if (!declined.ok) return declined;
    ctx.store.db
      .prepare("UPDATE document SET decline_reason = ?, accept_token_hash = NULL WHERE workspace_id = ? AND id = ?")
      .run(input.declineReason ?? null, ctx.workspaceId, quoteId);
    logQuoteActivity(ctx, contactId, 'Offerte abgelehnt.');
    return quoteViewOf(ctx, quoteId);
  };

  return runTx(ctx, 'quotes_decline', input.idempotencyKey, run);
}

export interface SweepExpiredInput {
  idempotencyKey?: string;
}

export function sweepExpiredQuotes(ctx: WorkspaceContext, input: SweepExpiredInput): Result {
  const run = (): Result => {
    const day = today(ctx);
    const rows = ctx.store.db
      .prepare(
        "SELECT id FROM document WHERE workspace_id = ? AND type = 'quote' AND status = 'sent' AND valid_until IS NOT NULL AND valid_until < ?",
      )
      .all(ctx.workspaceId, day) as { id: string }[];
    let expired = 0;
    for (const row of rows) {
      const res = transitionDocument(ctx, { documentId: row.id, to: 'expired' });
      if (res.ok) expired += 1;
    }
    return ok({ expired });
  };

  return runTx(ctx, 'quotes_expire_sweep', input.idempotencyKey, run);
}

export interface ReviseQuoteInput {
  quoteId: string;
  idempotencyKey?: string;
}

export function reviseQuote(ctx: WorkspaceContext, input: ReviseQuoteInput): Result {
  const run = (): Result => {
    const cols = readQuoteColumns(ctx, input.quoteId);
    if (cols === undefined) return err('not_found', { quoteId: input.quoteId });
    const before = getDocument(ctx, { documentId: input.quoteId });
    if (!before.ok) return before;
    interface ClonableLine {
      itemId: string | null;
      description: string | null;
      quantityMilli: number;
      unitPriceMinor: number;
      taxCode: string | null;
      supplyDate: string | null;
    }
    const sourceView = before as unknown as {
      document: { status: string; contactId: string | null; currency: string };
      lines: ClonableLine[];
    };
    const source = sourceView.document;
    const sourceLines = sourceView.lines;

    // A draft is edited in place, never versioned (US-C02.5 error case).
    if (source.status === 'draft') return err('edit_draft_instead', { quoteId: input.quoteId });

    // STATE GUARD BEFORE ANY WRITE (US-C02.5 boundary). Only a `sent|declined|expired` quote is
    // revisable; A10's transition table allows `superseded` from exactly those. An `accepted` or
    // `converted` quote is the binding record (OR Art. 3 ff.) and is refused, as is `issued`,
    // `cancelled` or an already-`superseded` version. This check runs BEFORE the createDocument
    // clone below, so a rejection leaves ZERO rows behind: without it the clone was written, the
    // supersede transition then returned its err from inside the tx, and `better-sqlite3` COMMITTED
    // the orphan draft while the verb reported failure. `runTx` is the belt to this braces: even a
    // state that slipped past here would roll the write back by throwing on the returned err.
    if (!(REVISABLE_QUOTE_STATES as readonly string[]).includes(source.status)) {
      return err('illegal_transition', {
        from: source.status,
        to: 'superseded',
        type: 'quote',
        quoteId: input.quoteId,
        revisable: [...REVISABLE_QUOTE_STATES],
      });
    }

    // Clone the FROZEN lines (byte-for-byte, no re-resolution) into a fresh draft. The tax trace of
    // the retired version is preserved on the new draft exactly as A10's own convert clone does.
    const cloned: DocumentLineInput[] = sourceLines.map((l) => ({
      itemId: l.itemId,
      description: l.description,
      quantityMilli: l.quantityMilli,
      unitPriceMinor: l.unitPriceMinor,
      taxCode: l.taxCode,
      supplyDate: l.supplyDate,
    }));
    const created = createDocument(ctx, { type: 'quote', contactId: source.contactId, lines: cloned, currency: source.currency });
    if (!created.ok) return created;
    const newId = documentIdOf(created);
    ctx.store.db
      .prepare(
        "UPDATE document SET version = ?, supersedes_id = ?, valid_until = ?, deal_id = ?, intro = ?, outro = ? WHERE workspace_id = ? AND id = ?",
      )
      .run(cols.version + 1, input.quoteId, cols.valid_until, cols.deal_id, cols.intro, cols.outro, ctx.workspaceId, newId);

    // Retire the old version: A10 allows `sent|declined|expired -> superseded`; an accepted or
    // converted quote is the binding record and is refused there (`illegal_transition`).
    const superseded = transitionDocument(ctx, { documentId: input.quoteId, to: 'superseded' });
    if (!superseded.ok) return superseded;
    ctx.store.db
      .prepare("UPDATE document SET accept_token_hash = NULL WHERE workspace_id = ? AND id = ?")
      .run(ctx.workspaceId, input.quoteId);

    const view = quoteViewOf(ctx, newId);
    if (!view.ok) return view;
    return ok({ ...(view as unknown as Record<string, unknown>), supersededId: input.quoteId });
  };

  return runTx(ctx, 'quotes_revise', input.idempotencyKey, run);
}

export interface ConvertQuoteInput {
  quoteId: string;
  to: string;
  idempotencyKey?: string;
}

export function convertQuote(ctx: WorkspaceContext, input: ConvertQuoteInput): Result {
  if (!(QUOTE_CONVERT_TARGETS as readonly string[]).includes(input.to)) {
    return err('invalid_type', { to: input.to, allowed: [...QUOTE_CONVERT_TARGETS] });
  }
  // A DIRECT 1:1 pass-through: A10's convertDocument owns the accepted-state guard, the byte-equal
  // line clone (the tax trace travels with it), the source `accepted -> converted` flip, the
  // single-issue structural guard and §H-IDEMPOTENT replay. C02 adds NOTHING and posts NOTHING.
  return convertDocument(ctx, {
    documentId: input.quoteId,
    toType: input.to,
    ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}),
  });
}

export function getQuote(ctx: WorkspaceContext, input: { quoteId: string }): Result {
  const cols = readQuoteColumns(ctx, input.quoteId);
  if (cols === undefined) return err('not_found', { quoteId: input.quoteId });
  return quoteViewOf(ctx, input.quoteId);
}

export interface ListQuotesInput {
  status?: string;
  contactId?: string;
  includeSuperseded?: boolean;
  savedViewId?: string;
}

export function listQuotes(ctx: WorkspaceContext, input: ListQuotesInput): Result {
  // Resolve a `quote` saved view here (G00): its stored filters merge UNDERNEATH any filter named
  // explicitly. `listDocuments` is then called without a savedViewId, so it never re-resolves a
  // `document` view over the same id.
  const viewed = applySavedView(ctx, 'quote', {
    ...(input.status !== undefined ? { status: input.status } : {}),
    ...(input.contactId !== undefined ? { contactId: input.contactId } : {}),
    ...(input.includeSuperseded !== undefined ? { includeSuperseded: input.includeSuperseded } : {}),
    ...(input.savedViewId !== undefined ? { savedViewId: input.savedViewId } : {}),
  });
  if (!viewed.ok) return viewed;
  const f = viewed.filter as ListQuotesInput;
  const listed = listDocuments(ctx, {
    type: 'quote',
    ...(f.status !== undefined ? { status: f.status } : {}),
    ...(f.contactId !== undefined ? { contactId: f.contactId } : {}),
  });
  if (!listed.ok) return listed;
  const includeSuperseded = f.includeSuperseded === true;
  const day = today(ctx);
  const documents = (listed as unknown as { documents: { id: string; status: string }[] }).documents;
  // Version-chain collapse (US-C02.5): only the newest version shows by default. A superseded quote
  // is exactly the retired one, so filtering the terminal `superseded` status IS the collapse.
  const visible = includeSuperseded ? documents : documents.filter((d) => d.status !== 'superseded');
  const enriched = visible.map((d) => {
    const cols = readQuoteColumns(ctx, d.id);
    return {
      ...d,
      validUntil: cols?.valid_until ?? null,
      version: cols?.version ?? 1,
      dealId: cols?.deal_id ?? null,
      expired: isExpiredOnRead(d.status, cols?.valid_until ?? null, day),
    };
  });
  return ok({
    ...(listed as unknown as Record<string, unknown>),
    documents: enriched,
    total: enriched.length,
  });
}
