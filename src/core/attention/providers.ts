/**
 * G15's provider registry: which module queues meet in the hub, as they actually are today.
 *
 * The design's §5a surveyed ten candidate queues and found that only two were registrable on the
 * day-one engine: a provider needs a REGISTERED read capability, a ROUTED deep link and a TRUE count.
 * A35 then landed the pieces the agent queue needed, and the friction pass (F-01 / F-07, 2026-09-05)
 * added A25's flags, so four queues register today: the Vorschläge, the Abgleich, the Markierungen
 * and the Mahnläufe.
 *
 * Each provider spreads in as ONE registration, so several modules appending at once collide over a
 * line rather than a block (the `fxActions` precedent). A provider's `count` is a real COUNT query,
 * never the length of its `list`: A20's 1000-row ceiling is the finding that makes this load-bearing,
 * and `assertProvidersRegistrable` refuses any provider whose count equals its list length on a
 * fixture larger than the cap.
 *
 * THE ROW CARRIES ITS DECISION (F-01). Every item names the exits the owning surface offers as
 * `decisionOptions`, each an EXISTING registry write with its fixed input and a deterministic
 * per-item idempotency key, plus the reason the item is pending and the D118 C4 consequence sentence
 * of the write. The hub still mints no verb: it calls what the item declares, under that verb's own
 * A24 gate, and nothing else.
 */

import type { WorkspaceContext } from '../context.js';
import { listUnmatchedIncoming } from '../banking/index.js';
import { listDunningRuns } from '../dunning/index.js';
import { listDraftedActions, dialCapabilityForCall, CONSEQUENCE_FOR_ACTION } from '../agent/index.js';
import { AGENT_ACTOR, SERVED_MEMBER_ACTOR_PREFIX } from '../access/actors.js';
import { checklistItemsDueProvider } from '../checklists/attentionProvider.js';
import type { ActorKind, AttentionDecisionOption, AttentionItem, QueueProvider } from './types.js';

/**
 * The routed owning surfaces a provider's deep link may target. Hand-maintained here (the engine
 * cannot import the Studio router, which is TSX), and proved to be a subset of the real app
 * `SURFACES` map by `app/src/surfaces/Attention/Attention.routes.test.tsx`. A provider whose
 * `deepLinkRoute` is not in this set fails registration, which is how the design's row 2.3 dead end
 * (a hub row that opens a Placeholder) is designed out rather than handled.
 */
export const ROUTED_SURFACES: ReadonlySet<string> = new Set(['/reconciliation', '/dunning', '/agent', '/journal', '/checklisten']);

/**
 * The OP3 entity kinds the providers reference, hoisted to consts rather than written inline.
 *
 * A provider is NOT an audit emitter: it composes reads and posts nothing. But an inline kind literal
 * sitting just before the id field has the exact shape `audit-vocabulary.test.ts` scans `src/` for as
 * an `AuditPort.record` call, so an inline literal here would false-positive that scraper into
 * demanding an audit-vocabulary label for a kind nothing audits. Referencing a const keeps the item
 * shape honest and keeps the provider out of the audit scan.
 */
const QR_MATCH_ENTITY_KIND = 'reconciliation_match';
const DUNNING_RUN_ENTITY_KIND = 'dunning_run';
const AGENT_ACTION_ENTITY_KIND = 'agent_action';
const REVIEW_FLAG_ENTITY_KIND = 'journal_entry';

/** Read one Ok field defensively: a shape the provider cannot read is a failed provider (it throws). */
function okOrThrow(res: { ok: boolean } & Record<string, unknown>, queueId: string): Record<string, unknown> {
  if (res.ok !== true) {
    throw new Error(`attention provider '${queueId}' read failed: ${String((res as { error?: unknown }).error)}`);
  }
  return res;
}

/**
 * The D118 C4 sentence for a write, resolved from the engine's dial map and NOTHING else: the Studio
 * key the Vorschlag card already renders (`agent.consequence.<capability>`) and the English sentence
 * `registry.ts` applies onto the action. A verb the map does not govern gets `null` twice: the
 * Studio then renders no sentence rather than inventing one.
 */
function consequenceOf(verb: string, payload: Readonly<Record<string, unknown>> = {}): { consequenceKey: string | null; consequence: string | null } {
  // Per CALL, not per name: an input-keyed rule (G22's ePortal attestation) governs one payload of a
  // verb the name-keyed map does not list, and its Vorschlag card must carry that capability's sentence.
  const capability = dialCapabilityForCall(verb, payload);
  const sentence = CONSEQUENCE_FOR_ACTION[verb];
  return {
    consequenceKey: capability === undefined ? null : `agent.consequence.${capability}`,
    consequence: sentence ?? null,
  };
}

/**
 * Who an actor id is, in words (critic F5; DESIGN.md C3: an agent origin is named in words, a
 * machine id never reaches the screen). The two D13 seats are named by their kind; a served member
 * (`member:<user_id>`, and any embedder that bound a `user.actor_id`) resolves to the display name
 * the A24 read model knows, falling back to the email the Members surface shows; anything else is
 * `unknown` and carries no name, so the Studio says "Markiert" rather than printing the id.
 */
function describeActor(ctx: WorkspaceContext, actor: string | null): { kind: ActorKind; name: string | null } {
  if (actor === null || actor === '') return { kind: 'unknown', name: null };
  if (actor === AGENT_ACTOR) return { kind: 'agent', name: null };
  if (actor === 'studio') return { kind: 'studio', name: null };
  const user = ctx.store.db
    .prepare(`SELECT display_name, email, kind FROM user WHERE actor_id = ? LIMIT 1`)
    .get(actor) as { display_name: string | null; email: string | null; kind: string | null } | undefined;
  if (user === undefined) return { kind: 'unknown', name: null };
  if (user.kind === 'agent') return { kind: 'agent', name: null };
  const name = user.display_name ?? user.email;
  // A bound user with neither a name nor an email is a seat, not a person to name; a served member
  // always has at least the email the invite went to.
  if (name === null && !actor.startsWith(SERVED_MEMBER_ACTOR_PREFIX)) return { kind: 'unknown', name: null };
  return { kind: 'member', name };
}

/** A `link` option: opens the owning surface for the case the row cannot settle by itself. */
function openOption(labelKey: string, deepLink: AttentionItem['deepLink']): AttentionDecisionOption {
  return { id: 'open', verb: null, labelKey, role: 'link', input: {}, deepLink };
}

/**
 * A21, the Abgleich queue: every registered incoming credit still `open` (unmatched). A21 already
 * returns a real per-lane count, so this is the cheapest genuine provider. The credit is the pending
 * decision ("which invoice, if any, does this payment settle?").
 *
 * The exits are A21's own, as `/reconciliation` offers them: `apply_qr_match` against the LIVE score's
 * invoice (`full` for a `high` score and for a surplus, `partial` only when the amount is short, so a
 * short credit is never written off from the hub while an over-payment settles the invoice and parks
 * its surplus as Guthaben, the same posting either mode would make), `override_qr_match` with
 * `action: 'dismiss'` ("Keine Kundenzahlung"), and the link into the Abgleich for the hand-picked case
 * (a `none` score, a currency question, an already-settled invoice). The reason code is the score's
 * own (`QR_MATCH_REASONS`), keyed into the Reconciliation catalogue the J8.12 sentences live in.
 */
const qrMatchProvider: QueueProvider = {
  queueId: 'qr_match',
  labelKey: 'attention.queue.qrMatch',
  area: 'bank',
  readCapability: 'read_sales',
  rank: 10,
  freshness: 'live',
  dismissal: 'module_dismiss',
  deepLinkRoute: '/reconciliation',
  count(ctx: WorkspaceContext): number {
    const row = ctx.store.db
      .prepare(`SELECT COUNT(*) AS n FROM reconciliation_match WHERE workspace_id = ? AND status = 'open'`)
      .get(ctx.workspaceId) as { n: number };
    return row.n;
  },
  list(ctx: WorkspaceContext, opts: { limit: number }): AttentionItem[] {
    const res = okOrThrow(listUnmatchedIncoming(ctx, { status: 'open' }) as never, 'qr_match');
    const items = Array.isArray(res.items) ? (res.items as Record<string, unknown>[]) : [];
    return items.slice(0, opts.limit).map((c) => {
      const payer = typeof c.payerName === 'string' && c.payerName.length > 0 ? c.payerName : '';
      const bank = typeof c.bankAccountName === 'string' ? c.bankAccountName : '';
      const creditId = String(c.creditId);
      const score = (c.score ?? {}) as Record<string, unknown>;
      const confidence = typeof score.confidence === 'string' ? score.confidence : 'none';
      const reason = typeof score.reason === 'string' ? score.reason : null;
      const suggestedInvoiceId = typeof score.invoiceId === 'string' ? score.invoiceId : null;
      const suggestedInvoiceNumber = typeof score.invoiceNumber === 'string' ? score.invoiceNumber : null;
      // The decision generation: a row re-opened by an unmatch carries a new `decidedAt`, so the
      // same hub decision on it is a NEW question under a new key rather than a replay of the old.
      const generation = typeof c.decidedAt === 'string' && c.decidedAt !== '' ? c.decidedAt : 'new';
      const deepLink = { route: '/reconciliation', params: { creditId } };

      const options: AttentionDecisionOption[] = [];
      // A currency question and an already-settled invoice are hand-picked cases: the score names an
      // invoice but the hub must not settle against it. `high` and the amount-delta mediums are safe.
      const applicable =
        suggestedInvoiceId !== null &&
        (confidence === 'high' || (confidence === 'medium' && (reason === 'amount_short' || reason === 'amount_over')));
      if (applicable) {
        // The mode names the write honestly (critic F6): `partial` is a SHORTFALL the person accepts
        // as a part payment; a surplus covers the invoice, so it applies in `full` under the label
        // "Übernehmen", exactly as the high-score path on `/reconciliation` does. The engine books
        // the same rows for a surplus in either mode (the write-off is zero and the excess parks
        // unallocated), so this changes the word the call carries, never the posting.
        const mode = confidence === 'high' || reason === 'amount_over' ? 'full' : 'partial';
        options.push({
          id: 'apply',
          verb: 'apply_qr_match',
          labelKey: reason === 'amount_short' ? 'qrmatch.applyPartial' : 'qrmatch.applyFull',
          role: 'primary',
          input: {
            creditId,
            invoiceId: suggestedInvoiceId,
            mode,
            idempotencyKey: `attention:apply:${ctx.workspaceId}:${creditId}:${suggestedInvoiceId}:${mode}:${generation}`,
          },
          humanConfirm: true,
          capability: 'pay',
        });
      }
      options.push({
        id: 'dismiss',
        verb: 'override_qr_match',
        labelKey: 'qrmatch.overrideDismiss',
        role: applicable ? 'secondary' : 'primary',
        input: {
          creditId,
          action: 'dismiss',
          idempotencyKey: `attention:dismiss:${ctx.workspaceId}:${creditId}:${generation}`,
        },
        humanConfirm: true,
        capability: 'pay',
      });
      options.push(openOption('attention.act.openReconciliation', deepLink));

      const item: AttentionItem = {
        queueId: 'qr_match',
        entityKind: QR_MATCH_ENTITY_KIND,
        entityId: creditId,
        titleKey: 'attention.item.qrMatch.title',
        titleParams: {},
        subtitleKey: 'attention.item.qrMatch.subtitle',
        subtitleParams: { payer, bank },
        ...(typeof c.amountMinor === 'number' ? { amountMinor: c.amountMinor } : {}),
        ...(typeof c.currency === 'string' ? { currency: c.currency } : {}),
        since: String(c.valueDate ?? ''),
        urgency: 'open',
        deepLink,
        decisionOptions: options,
        suggestedInvoiceId,
        suggestedInvoiceNumber,
        reasonCode: reason,
        reasonKey: reason === null ? null : `qrmatch.reason.${reason}`,
        // The sentence describes the write the row can MAKE (D118 C4: the floor of honesty about the
        // write). `apply_qr_match` books a payment; a dismiss books nothing, so a row whose only
        // exit is the dismiss carries no sentence rather than a posting that will not happen.
        ...(applicable ? consequenceOf('apply_qr_match') : { consequenceKey: null, consequence: null }),
      };
      return item;
    });
  },
};

/**
 * A15, the Mahnlauf queue: every dunning run still `proposed` (awaiting the human's Freigabe). A
 * proposal is a STORED row, and the title names the decision ("Mahnlauf wartet auf Freigabe"), never
 * a fact about the underlying invoices, so composing it stays honest even when the world has overtaken
 * the proposal (design row 11.1): the pending thing is the decision, and A15 can answer that cheaply.
 *
 * The exit is A15's own `issue_dunning_run` (it re-checks every item against the OP-Liste as of
 * today before freezing anything, so issuing from the hub is exactly issuing from `/dunning`), plus
 * the link into the run for a person who wants to read the items first. A15 has no discard verb; a
 * proposal that should not go out is superseded by the next proposal (the queue's declared dismissal).
 */
const dunningRunProvider: QueueProvider = {
  queueId: 'dunning_run',
  labelKey: 'attention.queue.dunningRun',
  area: 'sales',
  readCapability: 'read_sales',
  rank: 20,
  freshness: 'stored',
  dismissal: 'supersede',
  deepLinkRoute: '/dunning',
  count(ctx: WorkspaceContext): number {
    const row = ctx.store.db
      .prepare(`SELECT COUNT(*) AS n FROM dunning_run WHERE workspace_id = ? AND status = 'proposed'`)
      .get(ctx.workspaceId) as { n: number };
    return row.n;
  },
  list(ctx: WorkspaceContext, opts: { limit: number }): AttentionItem[] {
    const res = okOrThrow(listDunningRuns(ctx, { status: 'proposed' }) as never, 'dunning_run');
    const runs = Array.isArray(res.runs) ? (res.runs as Record<string, unknown>[]) : [];
    return runs.slice(0, opts.limit).map((r) => {
      const runId = String(r.runId);
      const deepLink = { route: '/dunning', params: { runId } };
      return {
        queueId: 'dunning_run',
        entityKind: DUNNING_RUN_ENTITY_KIND,
        entityId: runId,
        titleKey: 'attention.item.dunningRun.title',
        titleParams: {},
        subtitleKey: 'attention.item.dunningRun.subtitle',
        subtitleParams: {
          count: typeof r.itemCount === 'number' ? r.itemCount : 0,
          date: String(r.runDate ?? ''),
        },
        since: String(r.runDate ?? ''),
        urgency: 'open',
        deepLink,
        decisionOptions: [
          {
            id: 'issue',
            verb: 'issue_dunning_run',
            labelKey: 'attention.act.issueDunningRun',
            role: 'primary',
            input: { runId, idempotencyKey: `attention:issue:${ctx.workspaceId}:${runId}` },
            humanConfirm: true,
            capability: 'dun',
          },
          openOption('attention.act.openDunning', deepLink),
        ],
        ...consequenceOf('issue_dunning_run'),
      } satisfies AttentionItem;
    });
  },
};

/**
 * A26/A35, the Vorschläge queue: every drafted agent action still `pending` (awaiting a human's
 * Genehmigen). Registrable since A35 landed the pieces the design's §5a exclusion named as missing:
 * the read face (`list_drafted_actions`), the enqueuing path (the dial at the transport seam) and
 * the routed surface (`/agent`). This IS the "A35 publishes the read model, G15 composes it"
 * contract: the pending count lives HERE and in the hub, and the `/agent` rail row deliberately
 * carries no second count (design §6b, `railAttention`).
 *
 * The exits are the Vorschlag card's own three (D103 §2): Genehmigen, Genehmigen und künftig
 * automatisch (the standing grant riding `allowFuture`, owner-gated), and Ablehnen with a reason
 * field. `approve_drafted_action` is idempotent on the draft's stored key and `reject_drafted_action`
 * on the action id, so neither option carries a key of its own. The consequence is the DRAFTED verb's,
 * which is what the approver is really deciding about.
 */
const agentActionProvider: QueueProvider = {
  queueId: 'agent_action',
  labelKey: 'attention.queue.agentAction',
  area: 'system',
  readCapability: 'read_books',
  rank: 5,
  freshness: 'stored',
  dismissal: 'module_dismiss',
  deepLinkRoute: '/agent',
  count(ctx: WorkspaceContext): number {
    const row = ctx.store.db
      .prepare(`SELECT COUNT(*) AS n FROM agent_action WHERE workspace_id = ? AND status = 'pending'`)
      .get(ctx.workspaceId) as { n: number };
    return row.n;
  },
  list(ctx: WorkspaceContext, opts: { limit: number }): AttentionItem[] {
    const res = okOrThrow(listDraftedActions(ctx, { status: 'pending' }) as never, 'agent_action');
    const actions = Array.isArray(res.actions) ? (res.actions as Record<string, unknown>[]) : [];
    return actions.slice(0, opts.limit).map((a) => {
      const actionId = String(a.actionId);
      const tool = String(a.actionTool ?? '');
      const payload = typeof a.payload === 'object' && a.payload !== null ? (a.payload as Record<string, unknown>) : {};
      const deepLink = { route: '/agent', params: { actionId } };
      const options: AttentionDecisionOption[] = [
        {
          id: 'approve',
          verb: 'approve_drafted_action',
          labelKey: 'agent.card.approve',
          role: 'primary',
          input: { actionId },
          capability: 'manage_agent_dial',
        },
        {
          id: 'approve_allow',
          verb: 'approve_drafted_action',
          labelKey: 'agent.card.approveAllow',
          role: 'secondary',
          input: { actionId, allowFuture: true },
          capability: 'manage_agent_dial',
          hintKey: 'agent.card.grantHint',
        },
        {
          id: 'reject',
          verb: 'reject_drafted_action',
          labelKey: 'agent.card.reject',
          role: 'danger',
          input: { actionId },
          capability: 'manage_agent_dial',
          reasonField: true,
        },
      ];
      return {
        queueId: 'agent_action',
        entityKind: AGENT_ACTION_ENTITY_KIND,
        entityId: actionId,
        titleKey: 'attention.item.agentAction.title',
        titleParams: {},
        subtitleKey: 'attention.item.agentAction.subtitle',
        subtitleParams: { tool },
        since: String(a.createdAt ?? ''),
        urgency: 'open',
        deepLink,
        ...(typeof a.actor === 'string' ? { proposedBy: a.actor } : {}),
        decisionOptions: options,
        ...consequenceOf(tool, payload),
      } satisfies AttentionItem;
    });
  },
};

/**
 * A25, the Markierungen queue (F-07's hub part, J4.4): every posted entry whose LATEST review event
 * is a flag. The flag lives on `/review` and reached nobody outside it; here it reaches the person
 * who must fix the posting. The flag is metadata (the posted rows are untouched), and the correction
 * is a reversal plus a fresh posting on `/journal`, which is where the row's link opens. Resolving
 * the flag is A25's own `approve_entry` (the only event that moves an entry out of `flagged`), keyed
 * per flag event so a flag raised again after an approval is a new question.
 *
 * "For the current member" is answered by the read gate, not by an assignee: A25 flags carry none,
 * and a flag hidden from a colleague who could fix it is the dead end this queue exists to remove.
 * The reviewer is carried as the actor id the event stores; the surface renders it in words.
 */
const reviewFlagProvider: QueueProvider = {
  queueId: 'review_flag',
  labelKey: 'attention.queue.reviewFlag',
  area: 'accounting',
  readCapability: 'read_books',
  rank: 15,
  freshness: 'stored',
  dismissal: 'act_only',
  deepLinkRoute: '/journal',
  count(ctx: WorkspaceContext): number {
    const row = ctx.store.db
      .prepare(
        `SELECT COUNT(*) AS n
           FROM journal_entry e
          WHERE e.workspace_id = ? AND e.status = 'posted'
            AND (SELECT r.status FROM entry_review r
                  WHERE r.workspace_id = e.workspace_id AND r.entry_id = e.id
                  ORDER BY r.created_at DESC, r.rowid DESC LIMIT 1) = 'flagged'`,
      )
      .get(ctx.workspaceId) as { n: number };
    return row.n;
  },
  list(ctx: WorkspaceContext, opts: { limit: number }): AttentionItem[] {
    const rows = ctx.store.db
      .prepare(
        `SELECT e.id AS entry_id, e.date, e.ref, e.description,
                r.id AS review_id, r.reviewer, r.comment, r.created_at
           FROM journal_entry e
           JOIN entry_review r ON r.workspace_id = e.workspace_id AND r.entry_id = e.id
          WHERE e.workspace_id = ? AND e.status = 'posted' AND r.status = 'flagged'
            AND r.rowid = (SELECT r2.rowid FROM entry_review r2
                            WHERE r2.workspace_id = e.workspace_id AND r2.entry_id = e.id
                            ORDER BY r2.created_at DESC, r2.rowid DESC LIMIT 1)
          ORDER BY r.created_at DESC, e.id ASC
          LIMIT ?`,
      )
      .all(ctx.workspaceId, opts.limit) as {
      entry_id: string;
      date: string;
      ref: string | null;
      description: string | null;
      review_id: string;
      reviewer: string | null;
      comment: string | null;
      created_at: string;
    }[];
    return rows.map((r) => {
      const deepLink = { route: '/journal', params: { entryId: r.entry_id } };
      // The reviewer in words: the raw actor id rides `proposedBy` for the whoami self-check only,
      // and `reviewer` in the subtitle params is the display NAME (empty for a seat or an unknown).
      const who = describeActor(ctx, r.reviewer);
      return {
        queueId: 'review_flag',
        entityKind: REVIEW_FLAG_ENTITY_KIND,
        entityId: r.entry_id,
        titleKey: 'attention.item.reviewFlag.title',
        titleParams: {},
        subtitleKey: 'attention.item.reviewFlag.subtitle',
        subtitleParams: {
          date: r.date,
          description: r.description ?? r.ref ?? '',
          reviewer: who.name ?? '',
          reason: r.comment ?? '',
        },
        since: r.created_at,
        urgency: 'open',
        deepLink,
        ...(typeof r.reviewer === 'string' ? { proposedBy: r.reviewer } : {}),
        proposedByKind: who.kind,
        proposedByName: who.name,
        decisionOptions: [
          openOption('attention.act.openEntry', deepLink),
          {
            id: 'resolve',
            verb: 'approve_entry',
            labelKey: 'attention.act.resolveFlag',
            role: 'secondary',
            input: {
              entryId: r.entry_id,
              idempotencyKey: `attention:resolve:${ctx.workspaceId}:${r.entry_id}:${r.review_id}`,
            },
            capability: 'review',
          },
        ],
        reasonCode: 'flagged',
        reasonKey: 'attention.item.reviewFlag.reason',
        // `approve_entry` is review metadata, not a dial-governed write: no sentence, none invented.
        ...consequenceOf('approve_entry'),
      } satisfies AttentionItem;
    });
  },
};

/** The live registry, in rank order. Registration is guarded by `assertProvidersRegistrable`. */
export const ATTENTION_PROVIDERS: readonly QueueProvider[] = [
  agentActionProvider,
  qrMatchProvider,
  reviewFlagProvider,
  dunningRunProvider,
  // G22 (D127): open checklist items due within 14 days, overdue after their date. Defined beside the
  // checklist engine (`src/core/checklists/attentionProvider.ts`) and spread in as one line.
  checklistItemsDueProvider,
];
