/**
 * D143's G15 provider, `bank_keys_review`: one item per EBICS connection whose bank is ready for the
 * human key review (`bankReadyForReview`: an activation in progress whose latest HPB answered). It is how
 * the agent (`attention_summary`) and the Übersicht's "Wartet auf dich" strip learn that ZKB switched the
 * access on, and it says the one thing to do: compare the keys with the bank's sheet on `/bank-accounts`.
 *
 * THE ROW CANNOT SETTLE THE ITEM, BY DESIGN. Its only option is the link into the compare: confirming the
 * bank keys is a human act (P8) and `bank_channel_connect` is not a verb the hub may call. The item leaves
 * the queue when the person confirmed (the connection is `active`, no activation in progress).
 *
 * Defined beside the EBICS engine and spread into `ATTENTION_PROVIDERS` as one line (the G22 precedent).
 * The count is the derivation, not a list length: connections are few, so deriving them all is cheap.
 *
 * Its sibling below, `bank_activation`, covers the stretch BEFORE the bank is ready (send INI and HIA,
 * sign and post the INI letter, wait for the bank), so every pre-active connection is named exactly once.
 */

import type { WorkspaceContext } from '../../context.js';
import type { AttentionItem, AttentionUrgency, QueueProvider } from '../../attention/types.js';
import { activationCheckConnections, activationStatus, bankReadyForReview } from './activationCheck.js';
import type { ActivationCheckConnectionRow } from './activationCheck.js';
import { bankShortName } from './banks.js';

/** Hoisted const, so the audit-vocabulary scraper does not read this provider as an audit emitter. */
const EBICS_CONNECTION_ENTITY_KIND = 'ebics_connection';

interface ReadyConnection {
  id: string;
  hostId: string;
  hostUrl: string;
  since: string;
}

function readyConnections(ctx: WorkspaceContext): ReadyConnection[] {
  const out: ReadyConnection[] = [];
  for (const conn of activationCheckConnections(ctx)) {
    if (!bankReadyForReview(ctx, conn)) continue;
    const row = ctx.store.db
      .prepare(
        `SELECT c.host_id, c.host_url,
                (SELECT MAX(o.occurred_at) FROM ebics_order_log o
                  WHERE o.workspace_id = c.workspace_id AND o.connection_id = c.id AND o.order_type = 'HPB' AND o.status = 'ok') AS since
           FROM ebics_connection c WHERE c.workspace_id = ? AND c.id = ?`,
      )
      .get(ctx.workspaceId, conn.id) as { host_id: string; host_url: string; since: string | null } | undefined;
    if (row === undefined) continue;
    out.push({ id: conn.id, hostId: row.host_id, hostUrl: row.host_url, since: row.since ?? '' });
  }
  return out;
}

export const bankKeysReviewProvider: QueueProvider = {
  queueId: 'bank_keys_review',
  labelKey: 'attention.queue.bankKeysReview',
  area: 'bank',
  // Critic F10: the item names an act (compare and confirm the keys, `bank_channel_connect`), so it reaches
  // only someone who holds that act's right, `pay`; a read-only member would land on a page without the button.
  readCapability: 'pay',
  rank: 8,
  freshness: 'live',
  dismissal: 'act_only',
  deepLinkRoute: '/bank-accounts',
  count(ctx: WorkspaceContext): number {
    return readyConnections(ctx).length;
  },
  list(ctx: WorkspaceContext, opts: { limit: number }): AttentionItem[] {
    return readyConnections(ctx)
      .slice(0, opts.limit)
      .map((c) => {
        const deepLink = { route: '/bank-accounts', params: {} };
        return {
          queueId: 'bank_keys_review',
          entityKind: EBICS_CONNECTION_ENTITY_KIND,
          entityId: c.id,
          titleKey: 'attention.item.bankKeysReview.title',
          titleParams: { bank: bankShortName({ hostId: c.hostId, hostUrl: c.hostUrl }) },
          subtitleKey: 'attention.item.bankKeysReview.subtitle',
          subtitleParams: {},
          since: c.since,
          urgency: 'due',
          deepLink,
          decisionOptions: [{ id: 'open', verb: null, labelKey: 'attention.act.compareBankKeys', role: 'link', input: {}, deepLink }],
          reasonCode: 'bank_ready',
          reasonKey: null,
          consequenceKey: null,
          consequence: null,
        } satisfies AttentionItem;
      });
  },
};

// --- the activation BEFORE the bank is ready: `bank_activation` --------------------------------------

/**
 * The owner's act while the bank has not activated the access yet (the lifecycle
 * `draft -> keys_generated -> ini_sent -> pending_bank_activation`, `enums.ts`), one item per connection.
 * Mutually exclusive with `bank_keys_review` by construction: a connection whose bank is ready for the
 * review (`bankReadyForReview`) is that queue's item and never this one, so the hub never names one
 * connection twice and the same-entity collapse never has to choose.
 *
 * WHAT THE ITEM SAYS, per state (A36 §3 steps 3 and 4):
 *  - `draft` / `keys_generated`: the keys exist but INI and HIA never reached the bank (no bank wire when
 *    the connection was made). The person sends them on `/bank-accounts`, then signs and posts the INI
 *    letter. Urgency `due`.
 *  - `ini_sent`: the bank has not confirmed both legs. The person resends (TILL sends only what is
 *    missing); the letter still goes by post. Urgency `due`.
 *  - `pending_bank_activation`: both legs landed; what remains is the signed INI letter and then the
 *    bank's own switch. Nothing records whether the letter is already in the post, so the item stays
 *    until the bank answers, as `open` (the lowest urgency), and its subtitle carries the live state: when
 *    TILL last reached the bank (`activationStatus.lastCheckAt`, an HPB the bank answered, never a mere
 *    attempt). That subtitle is how the Übersicht's list shows the EBICS status in words.
 *
 * THE ROW CANNOT SETTLE THE ITEM, BY DESIGN (the `bank_keys_review` reasoning): sending the legs is
 * `bank_channel_connect`, a human act on `/bank-accounts`, and the letter is paper. The only option is the
 * link, and the item leaves the queue when the state moves on (`act_only`). The capability is `pay` for the
 * same reason as the review queue (critic F10): the act is `bank_channel_connect`'s.
 */

/** The states this queue speaks for, in lifecycle order (a subset of `EBICS_CONNECTION_STATE`). */
export const BANK_ACTIVATION_STATES = ['draft', 'keys_generated', 'ini_sent', 'pending_bank_activation'] as const;

/** The step an item asks for: its `reasonCode`, one per lifecycle stretch. */
export type BankActivationStep = 'send_legs' | 'resend_legs' | 'sign_letter';

/** The step a state asks for. Exported so a test pins the mapping per lifecycle state. */
export function bankActivationStep(state: string): BankActivationStep {
  if (state === 'pending_bank_activation') return 'sign_letter';
  if (state === 'ini_sent') return 'resend_legs';
  return 'send_legs';
}

/** The catalogue segment of each step's title and subtitle keys. */
const STEP_KEY: Readonly<Record<BankActivationStep, string>> = {
  send_legs: 'sendLegs',
  resend_legs: 'resendLegs',
  sign_letter: 'signLetter',
};

interface ActivatingConnection {
  row: ActivationCheckConnectionRow;
  hostId: string;
  hostUrl: string;
  createdAt: string;
}

function activatingConnections(ctx: WorkspaceContext): ActivatingConnection[] {
  const rows = ctx.store.db
    .prepare(
      `SELECT id, state, auto_sync_mode, auto_sync_at, auto_sync_actor, host_id, host_url, created_at
         FROM ebics_connection
        WHERE workspace_id = ? AND state IN ('draft', 'keys_generated', 'ini_sent', 'pending_bank_activation')
        ORDER BY created_at, rowid`,
    )
    .all(ctx.workspaceId) as (ActivationCheckConnectionRow & { host_id: string; host_url: string; created_at: string })[];
  return rows
    .filter((r) => !bankReadyForReview(ctx, r))
    .map((r) => ({
      row: { id: r.id, state: r.state, auto_sync_mode: r.auto_sync_mode, auto_sync_at: r.auto_sync_at, auto_sync_actor: r.auto_sync_actor },
      hostId: r.host_id,
      hostUrl: r.host_url,
      createdAt: r.created_at,
    }));
}

export const bankActivationProvider: QueueProvider = {
  queueId: 'bank_activation',
  labelKey: 'attention.queue.bankActivation',
  area: 'bank',
  readCapability: 'pay',
  // Just after the review (8): the review is the one step that switches the feed on today.
  rank: 9,
  freshness: 'live',
  dismissal: 'act_only',
  deepLinkRoute: '/bank-accounts',
  count(ctx: WorkspaceContext): number {
    return activatingConnections(ctx).length;
  },
  list(ctx: WorkspaceContext, opts: { limit: number }): AttentionItem[] {
    const now = ctx.clock.now();
    return activatingConnections(ctx)
      .slice(0, opts.limit)
      .map((c) => {
        const deepLink = { route: '/bank-accounts', params: {} };
        const step = bankActivationStep(c.row.state);
        const key = STEP_KEY[step];
        const bank = bankShortName({ hostId: c.hostId, hostUrl: c.hostUrl });
        const urgency: AttentionUrgency = step === 'sign_letter' ? 'open' : 'due';
        // The live state rides the letter step only: while the legs are unsent there is nothing to wait for.
        const lastCheckAt = step === 'sign_letter' ? activationStatus(ctx, c.row, now).lastCheckAt : null;
        const subtitleKey =
          step !== 'sign_letter'
            ? `attention.item.bankActivation.${key}.subtitle`
            : lastCheckAt === null
              ? 'attention.item.bankActivation.signLetter.subtitleNoCheck'
              : 'attention.item.bankActivation.signLetter.subtitle';
        const subtitleParams: Record<string, string> = lastCheckAt === null ? { bank } : { bank, lastCheckAt };
        return {
          queueId: 'bank_activation',
          entityKind: EBICS_CONNECTION_ENTITY_KIND,
          entityId: c.row.id,
          titleKey: `attention.item.bankActivation.${key}.title`,
          titleParams: { bank },
          subtitleKey,
          subtitleParams,
          since: c.createdAt,
          urgency,
          deepLink,
          decisionOptions: [{ id: 'open', verb: null, labelKey: 'attention.act.openBankAccounts', role: 'link', input: {}, deepLink }],
          reasonCode: step,
          reasonKey: null,
          consequenceKey: null,
          consequence: null,
        } satisfies AttentionItem;
      });
  },
};
