/**
 * G15, the attention hub: the shapes of the composition contract.
 *
 * The hub owns NO table (Pattern P5, the F00 posture): a composed answer that can drift from its
 * sources is worse than no answer at all. Everything here is a live read shape, produced per
 * workspace, per actor, never cached.
 *
 * A queue owes the hub a stable id, an owned label, a rail area, a registered read capability, a true
 * COUNT, a page of decision-shaped items, a declared urgency, a dismissal semantics and a deep link;
 * the hub owes back that it will never call a clearing verb, never re-label, never hide an open item,
 * never fabricate a count, never reorder inside a queue, never render one entity twice, never cross a
 * workspace, and never build a second place to look at the same record (design §5c).
 */

import type { WorkspaceContext } from '../context.js';

/**
 * The urgency scale, English identifiers like every other §H-ENUM in the corpus. The de-CH labels
 * (`überfällig` / `fällig` / `offen`) render in the Studio; naming the enum in German would put a
 * real umlaut in a stored key and an ASCII transliteration in the code that reads it, which is how a
 * rendered string and a stored value drift apart.
 *
 * URGENCY IS DECLARED BY THE QUEUE, NEVER DERIVED FROM `since` (design §5b): `since` is when the item
 * entered the queue, and an old queue entry is not an overdue obligation. Only the owning module knows
 * which date matters, so only it may say `overdue`.
 */
export const ATTENTION_URGENCY = ['overdue', 'due', 'open'] as const;
export type AttentionUrgency = (typeof ATTENTION_URGENCY)[number];

/** Higher number = more urgent, so a plain numeric compare ranks the list. */
export const URGENCY_RANK: Readonly<Record<AttentionUrgency, number>> = { overdue: 3, due: 2, open: 1 };

/** `live` re-derives on every read; `stored` is a persisted row. Declared, not guessed (design §5b). */
export type Freshness = 'live' | 'stored';

/**
 * How an item LEAVES its queue, declared by the owning module. The hub never acts on it (§5c
 * guarantee 3); it is carried so a test can assert the hub offers no affordance that contradicts it.
 */
export type Dismissal = 'act_only' | 'module_dismiss' | 'supersede';

/** A deep-link descriptor the hub RESOLVES, never a redirect (OP3, §5c guarantee 7). */
export interface DeepLink {
  readonly route: string;
  readonly params: Readonly<Record<string, string>>;
}

/**
 * How an option renders on the row: ONE primary per row (the accent budget), the rest secondary;
 * `danger` confirms in place with a reason field; `link` is not a write at all, it opens the owning
 * surface for the hard case the row cannot settle by itself.
 */
export type DecisionRole = 'primary' | 'secondary' | 'danger' | 'link';

/**
 * One exit the owning surface offers for an item, carried on the row so the hub can act in place
 * (F-01, 2026-09-05). The verb is an EXISTING registry write; the hub mints none. `input` is the
 * whole fixed input beyond `workspaceId`: the caller spreads it as-is and adds nothing but the
 * human confirmation flag where `humanConfirm` says a person at the button is the P8 confirmation.
 *
 * The idempotency key is DERIVED HERE, per item and per decision, from the row's own identity plus
 * its decision generation (`decidedAt`, the flag event id), so a double click replays the first
 * write and a re-opened row is a new question. It is `attention:`-namespaced, never `kaizen:` or
 * `seed:`, because it is a product key and not a test key.
 */
export interface AttentionDecisionOption {
  /** Stable option id within the item: `apply`, `dismiss`, `approve`, `approve_allow`, `reject`, `resolve`, `open`. */
  readonly id: string;
  /** The existing registry write verb this option calls; `null` for a `link` option. */
  readonly verb: string | null;
  /** i18n key for the button label, in the owning surface's catalogue (never a rendered string). */
  readonly labelKey: string;
  readonly role: DecisionRole;
  /** The fixed input the call sends beyond `workspaceId`. Empty for a `link`. */
  readonly input: Readonly<Record<string, string | number | boolean>>;
  /** True when the verb takes `confirmed: true` from a human at the button (A21's P8 confirmation). */
  readonly humanConfirm?: boolean;
  /** True when the option takes a free-text reason before it runs (the reject confirm, J5.6). */
  readonly reasonField?: boolean;
  /** The A24 capability the CLEARING verb needs; the hub hides the option when the actor lacks it. */
  readonly capability?: string;
  /** i18n key of a one-line hint rendered under the option (the D103 grant hint). */
  readonly hintKey?: string;
  /** For a `link` option: where it opens. */
  readonly deepLink?: DeepLink;
}

/**
 * One thing waiting for a decision. The smallest shape that supports every story in the design's §1.
 * The title names a pending DECISION ("Mahnlauf wartet auf Freigabe"), never a fact about the record
 * a stored row cannot keep true (design §5b).
 *
 * The fields from `decisionOptions` down are the F-01 additions (2026-09-05): every one is optional
 * and additive, so a consumer that reads only the day-one shape is unchanged.
 */
export interface AttentionItem {
  readonly queueId: string;
  /** OP3-registered kind + id: the collapse key (§5c guarantee 11) and the deep-link target. */
  readonly entityKind: string;
  readonly entityId: string;
  /** i18n key + params in the OWNING surface's catalogue (never a rendered string, mirrors P11). */
  readonly titleKey: string;
  readonly titleParams: Readonly<Record<string, string | number>>;
  readonly subtitleKey?: string;
  readonly subtitleParams?: Readonly<Record<string, string | number>>;
  /** Integer Rappen, rendered right-aligned tabular. Absent when the item carries no amount. */
  readonly amountMinor?: number;
  readonly currency?: string;
  /** ISO. Drives the "neu" tag and the tie-break order. Nothing else. */
  readonly since: string;
  /** ISO. The date the urgency refers to, when there is one. */
  readonly dueAt?: string;
  readonly urgency: AttentionUrgency;
  readonly deepLink: DeepLink;
  /**
   * Set when a lower-ranked queue produced the SAME `entityKind`+`entityId` and was collapsed into
   * this row (§5c guarantee 11). The Studio names it in the subtitle; each queue's own count is
   * unaffected. Absent on a row with no collision.
   */
  readonly collapsedWithQueueId?: string;
  /** The exits the owning surface offers for this item, in render order. Absent when it offers none on the hub. */
  readonly decisionOptions?: readonly AttentionDecisionOption[];
  /** The match the owning module proposes, where it has one (`null` when it has none; absent when the queue has no notion of one). */
  readonly suggestedInvoiceId?: string | null;
  readonly suggestedInvoiceNumber?: string | null;
  /** The owning module's machine reason for the item's state (A21's `QrMatchReason`), plus its key in the owning catalogue. */
  readonly reasonCode?: string | null;
  readonly reasonKey?: string | null;
  /** The D118 C4 consequence of the row's write: the dial-capability key the Studio resolves (`agent.consequence.<cap>`) and the engine's own English sentence. `null` when the verb carries none. */
  readonly consequenceKey?: string | null;
  readonly consequence?: string | null;
  /** The actor who created the pending thing (a draft's proposer, a flag's reviewer), so the surface can keep the self-approve ban visible. A raw actor id: compared against `whoami.actor`, never rendered. */
  readonly proposedBy?: string;
  /**
   * WHO `proposedBy` is, in a form the Studio can put into words (DESIGN.md: an agent origin is named
   * in words, a machine id never reaches the screen): the agent seat, the local Studio seat, a member
   * (then `proposedByName` carries the display name the read model knows), or an actor the engine
   * cannot place. Resolved by the engine so no surface has to parse an actor string.
   */
  readonly proposedByKind?: ActorKind;
  readonly proposedByName?: string | null;
}

/** How an actor id is named on screen: the words for a seat, or a member's display name. */
export type ActorKind = 'agent' | 'studio' | 'member' | 'unknown';

/**
 * A provider: one owning module's registration of one pending state. A build-time constant, identical
 * in every workspace; the data it produces is per workspace, per actor, live.
 */
export interface QueueProvider {
  readonly queueId: string;
  /** i18n key for the queue label, in the owning surface's catalogue. */
  readonly labelKey: string;
  /** A known area key (`bank`, `sales`, ...): one taxonomy for rail, palette and hub. */
  readonly area: string;
  /** A REGISTERED A24 capability. A provider whose capability does not resolve fails registration. */
  readonly readCapability: string;
  /** The cross-queue tie-break rank; LOWER wins the same-entity collapse. */
  readonly rank: number;
  readonly freshness: Freshness;
  readonly dismissal: Dismissal;
  /** The owning surface route this item opens; MUST be in `ROUTED_SURFACES` or registration fails. */
  readonly deepLinkRoute: string;
  /** A true COUNT query over the pending rows: never a list length, never truncated, never cached. */
  count(ctx: WorkspaceContext): number;
  /** A page of items in the queue's own order. The hub ranks across queues, never within one. */
  list(ctx: WorkspaceContext, opts: { limit: number }): AttentionItem[];
}

/** One queue's summary line, as `attention_summary` returns it. */
export interface AttentionQueueSummary {
  readonly queueId: string;
  readonly area: string;
  readonly count: number;
  readonly topUrgency: AttentionUrgency;
}

/** The default list cap: 5 rows in the urgency list, and the fixture size the registry guard exceeds. */
export const ATTENTION_LIST_CAP = 5;
