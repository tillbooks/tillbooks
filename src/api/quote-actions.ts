/**
 * C02's ten verbs, defined here and spread into `ACTIONS` as one line (the `fxActions` /
 * `dealActions` precedent), so several agents appending to the append-only registry at once collide
 * over a line rather than a block.
 *
 * Eight writes are the quote lifecycle (create, update, send, accept, decline, expire-sweep, revise,
 * convert); two reads are the detail and the list. Every verb is a thin adapter over `core/sales`'s
 * quote engine, which itself wraps A10's shared document machine (no new tables, no posting path).
 * REST twins ride the shared registry automatically, as for every other verb.
 *
 * NO verb here holds an `ActionInvoker`: the quote engine reaches A10 directly, never back through
 * the dispatch, so there is no capability to launder. The C01 seam (`deals_to_quote`) reaches
 * `quotes_create` through the dispatch as the CALLING actor, and that gate is A24's, checked live.
 *
 * As with `fx-actions.ts`, the helpers arrive as a parameter rather than an import, so the module
 * graph stays acyclic: `registry.ts` imports this file and this file must not import it back.
 */

import type { ActionDef, ActionInput, ApiDeps, JsonSchema } from './registry.js';
import type { WorkspaceContext } from '../core/context.js';
import type { Result } from '../core/result.js';
import {
  createQuote,
  updateQuote,
  sendQuote,
  acceptQuote,
  declineQuote,
  sweepExpiredQuotes,
  reviseQuote,
  convertQuote,
  getQuote,
  listQuotes,
} from '../core/sales/index.js';

export interface QuoteActionHelpers {
  ctxAction(
    name: string,
    kind: 'read' | 'write',
    summary: string,
    inputSchema: JsonSchema,
    call: (ctx: WorkspaceContext, input: ActionInput, deps: ApiDeps) => Result,
  ): ActionDef;
  ctxSchema(props?: Record<string, unknown>, required?: string[]): JsonSchema;
  STR: { readonly type: 'string' };
  INT: { readonly type: 'integer' };
  BOOL: { readonly type: 'boolean' };
}

/** Widen an `ActionInput` to the engine's own input shape (the same cast `registry.ts` uses). */
function as<T>(input: ActionInput): T {
  return input as unknown as T;
}

/** The quote verbs, in append order. */
export function quoteActions(h: QuoteActionHelpers): readonly ActionDef[] {
  const { ctxAction, ctxSchema, STR, INT, BOOL } = h;

  // A quote line: like A10's document line, but `unitPriceMinor` is OPTIONAL because an item line is
  // priced once through D00's resolver and snapshotted (a free-text line still needs a price).
  const QUOTE_LINES = {
    type: 'array',
    items: {
      type: 'object',
      properties: {
        itemId: STR,
        description: STR,
        quantityMilli: INT,
        unitPriceMinor: INT,
        taxCode: STR,
        supplyDate: STR,
      },
    },
  } as const;

  const QUOTE_PATCH = {
    type: 'object',
    properties: { contactId: STR, currency: STR, intro: STR, outro: STR, validUntil: STR, lines: QUOTE_LINES },
  } as const;

  return [
    ctxAction(
      'quotes_create',
      'write',
      'Lege eine Offerte an: a priced offer on a C00 contact. Each line resolves its price once through D00 (contact list, segment list, item base) and its tax code once through the item A05 default, then snapshots both as literals on the shared document_line row (the freeze). Rides A10 createDocument (type quote), always a draft, and POSTS NOTHING (quote has a no-op poster). valid_until is the OR Art. 3 binding window and must be today or later; deal_id links a C01-seeded quote. Foreign contact/item ids are refused (invalid_reference, H-TENANT).',
      ctxSchema(
        {
          contactId: STR,
          dealId: STR,
          currency: STR,
          validUntil: STR,
          intro: STR,
          outro: STR,
          lines: QUOTE_LINES,
          idempotencyKey: STR,
        },
        [],
      ),
      (ctx, input) => createQuote(ctx, as(input)),
    ),
    ctxAction(
      'quotes_update',
      'write',
      'Bearbeite eine Offerte im Entwurf: retitle the contact, re-price lines (re-resolved and re-snapshotted exactly as create), or set validUntil/intro/outro. Draft-only: A10 refuses a patch on an issued or later quote (document_immutable), which is the tax/total freeze at work. A validity in the past is refused (validity_in_past).',
      ctxSchema({ quoteId: STR, patch: QUOTE_PATCH, idempotencyKey: STR }, ['quoteId', 'patch']),
      (ctx, input) => updateQuote(ctx, as(input)),
    ),
    ctxAction(
      'quotes_send',
      'write',
      'Versende eine Offerte (P8 outbound, draft-gated): one atomic write issuing the gap-free O-number (no ledger posting), minting the single-use e-accept token (only its hash is stored), and moving the quote to sent. Returns the local artifact plus transmitted:false / reason:cloud_tier: the OSS core produces the PDF and the accept link and stops; email/portal delivery is the cloud tier (needs_dispatch_module). The G05 send log records one artifact_created row (list_dispatches). A quote with no lines is refused (no_lines); a non-draft quote is refused (illegal_transition). Idempotent: a replay returns the original token and number, never a second of either.',
      ctxSchema({ quoteId: STR, idempotencyKey: STR }, ['quoteId']),
      (ctx, input) => sendQuote(ctx, as(input)),
    ),
    ctxAction(
      'quotes_accept',
      'write',
      'Nimm eine Offerte an: either by the single-use token (the cloud accept host, the one write reachable without an authenticated actor, scoped to exactly one quote by its H-TENANT token-hash lookup) or by quoteId + actor (the human "Als angenommen markieren"). Refuses acceptance after valid_until (quote_expired, OR Art. 3), stamps accepted_by, invalidates the token (single-use), and moves the quote to accepted. Posts nothing; conversion is a separate step.',
      ctxSchema({ quoteId: STR, token: STR, actor: STR, acceptedBy: STR, idempotencyKey: STR }, []),
      (ctx, input) => acceptQuote(ctx, as(input)),
    ),
    ctxAction(
      'quotes_decline',
      'write',
      'Lehne eine Offerte ab (by quoteId or token): moves the quote to declined, persists an optional decline_reason, invalidates the token, and logs the timeline note (OP5). A declined quote can only be superseded by a revision.',
      ctxSchema({ quoteId: STR, token: STR, declineReason: STR, idempotencyKey: STR }, []),
      (ctx, input) => declineQuote(ctx, as(input)),
    ),
    ctxAction(
      'quotes_expire_sweep',
      'write',
      'Verfallene Offerten kehren aus der offenen Liste: for every sent quote past its valid_until, transition it to expired so lists and forecasting never count a dead offer. Agent-scheduled; the Studio list triggers the same verb lazily. Returns { expired: N }. A no-op when nothing is past validity.',
      ctxSchema({ idempotencyKey: STR }, []),
      (ctx, input) => sweepExpiredQuotes(ctx, as(input)),
    ),
    ctxAction(
      'quotes_revise',
      'write',
      'Revidiere eine gesendete/abgelehnte/abgelaufene Offerte: clones the FROZEN lines byte-for-byte into a new draft (version n+1, supersedes_id at the old row) and retires the old version as superseded, invalidating its token. A draft is edited in place, not versioned (edit_draft_instead); an accepted or converted quote is the binding record and is refused (illegal_transition).',
      ctxSchema({ quoteId: STR, idempotencyKey: STR }, ['quoteId']),
      (ctx, input) => reviseQuote(ctx, as(input)),
    ),
    ctxAction(
      'quotes_convert',
      'write',
      'Wandle eine angenommene Offerte um in einen Auftrag (order) oder direkt in eine Rechnung (invoice): a DIRECT 1:1 pass-through to A10 convertDocument, which clones the frozen document_line rows (the VAT trace travels with them) and marks the source converted. C02 posts nothing; revenue is recognised only when A11 later issues the invoice. Idempotent and single-issue: converting an already-converted quote returns the existing target, never a second document. A non-accepted quote is refused (illegal_transition).',
      ctxSchema({ quoteId: STR, to: STR, idempotencyKey: STR }, ['quoteId', 'to']),
      (ctx, input) => convertQuote(ctx, as(input)),
    ),
    ctxAction(
      'quotes_get',
      'read',
      'Lies eine Offerte mit Positionen, Statusverlauf und den C02-Feldern (validUntil, version, dealId, intro/outro, acceptedBy, declineReason). A sent quote past its validity is flagged expired on read (derived, never mutating; the sweep does the durable transition).',
      ctxSchema({ quoteId: STR }, ['quoteId']),
      (ctx, input) => getQuote(ctx, as(input)),
    ),
    ctxAction(
      'quotes_list',
      'read',
      'Liste die Offerten (P5): filter by status or contact. Only the newest version of a chain shows by default (a superseded quote is hidden unless includeSuperseded); each row carries validUntil, version and a derived expired flag. savedViewId applies a saved view (G00): its stored filters merge underneath any filter named explicitly here.',
      ctxSchema({ status: STR, contactId: STR, includeSuperseded: BOOL, savedViewId: STR }, []),
      (ctx, input) => listQuotes(ctx, as(input)),
    ),
  ];
}
