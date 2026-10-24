/**
 * The decision a hub row carries (F-01, 2026-09-05), as helpers: the exits the owning surface offers,
 * exactly as the engine item declares them in `decisionOptions`, the reason the item waits, and the ONE
 * consequence sentence of its write (D118 C4, the Vorschlag card's own key).
 *
 * D178 (21.10.2026): the detached decision STRIP under a row is gone. The owner read it as "way too much
 * text": it printed the reason and the full consequence sentence under every row and sat outside the
 * row's own surface. Every item now renders through the one row pattern (`AttentionRow`): the reason and
 * the consequence live behind the row's (i), ONE action is a real button, every other exit sits in the
 * row's ⋯. What stays here is what the strip and the row share: parsing the options, choosing the one
 * action, the reason in words and the consequence in the active locale. Nothing here invents a verb, a
 * label or a key: they all arrive on the item.
 *
 * WHO FLAGGED IT IS SAID IN WORDS (DESIGN.md C3, as `Provenance` does): the engine sends the reviewer's
 * kind and display name beside the raw actor id; the agent seat and the Studio seat are named in words, a
 * member by the name the read model knows, an actor the engine cannot place with no name at all. The raw
 * id is compared against `whoami` for "Von dir markiert" and never reaches the screen as text.
 */
import en from '../../i18n/en.json';
import type { Locale } from '../../i18n';
import type { VorschlagFigures } from '../Agent/model';
import { consequenceForVerb, consequenceSentence } from '../../lib/approval-tiers';

export type DecisionRole = 'primary' | 'secondary' | 'danger' | 'link';

/** Who an actor id is, as the engine resolved it (`ActorKind` in `src/core/attention/types.ts`). */
export type ActorKind = 'agent' | 'studio' | 'member' | 'unknown';

export function parseActorKind(raw: unknown): ActorKind | undefined {
  return raw === 'agent' || raw === 'studio' || raw === 'member' || raw === 'unknown' ? raw : undefined;
}

export interface DecisionOption {
  id: string;
  verb: string | null;
  labelKey: string;
  role: DecisionRole;
  input: Record<string, string | number | boolean>;
  humanConfirm?: boolean;
  reasonField?: boolean;
  /** D150: a reason option that is not a rejection names its own confirm button and placeholder. */
  confirmLabelKey?: string;
  reasonPlaceholderKey?: string;
  capability?: string;
  hintKey?: string;
  deepLink?: { route: string; params: Record<string, string> };
}

/** The item fields the decision reads; the hub's `Item` satisfies this. */
export interface DecisionItem {
  queueId: string;
  titleKey: string;
  titleParams: Record<string, string | number>;
  subtitleParams?: Record<string, string | number>;
  decisionOptions?: DecisionOption[];
  suggestedInvoiceNumber?: string | null;
  reasonKey?: string | null;
  consequenceKey?: string | null;
  proposedBy?: string;
  proposedByKind?: ActorKind;
  /** Critic N1, Vorschlag rows: the figures frozen at the proposal. */
  figures?: VorschlagFigures | null;
  /** Critic N1: the record changed since the proposal, so approving would run nothing. */
  changedSinceProposal?: boolean;
}

/**
 * The verbs the shared catalogue carries a human label for (`agent.verb.*`, all dial-governed verbs, held
 * by `test/attention/verb-labels.test.mjs`). A verb outside the set renders its name with the underscores
 * swapped: not a translation, and honestly not one, but never snake_case.
 */
const LABELLED_VERBS: ReadonlySet<string> = new Set(Object.keys((en as { agent: { verb: Record<string, string> } }).agent.verb));

export function verbLabel(t: (key: string) => string, verb: string): string {
  return LABELLED_VERBS.has(verb) ? t(`agent.verb.${verb}`) : verb.replace(/_/g, ' ');
}

export function parseDecisionOptions(raw: unknown): DecisionOption[] {
  if (!Array.isArray(raw)) return [];
  const out: DecisionOption[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') continue;
    const o = entry as Record<string, unknown>;
    if (typeof o.id !== 'string' || typeof o.labelKey !== 'string') continue;
    const role: DecisionRole = o.role === 'primary' || o.role === 'danger' || o.role === 'link' ? o.role : 'secondary';
    const link = o.deepLink as { route?: unknown; params?: unknown } | undefined;
    out.push({
      id: o.id,
      verb: typeof o.verb === 'string' ? o.verb : null,
      labelKey: o.labelKey,
      role,
      input: o.input !== null && typeof o.input === 'object' ? (o.input as Record<string, string | number | boolean>) : {},
      humanConfirm: o.humanConfirm === true,
      reasonField: o.reasonField === true,
      ...(typeof o.confirmLabelKey === 'string' ? { confirmLabelKey: o.confirmLabelKey } : {}),
      ...(typeof o.reasonPlaceholderKey === 'string' ? { reasonPlaceholderKey: o.reasonPlaceholderKey } : {}),
      capability: typeof o.capability === 'string' ? o.capability : undefined,
      hintKey: typeof o.hintKey === 'string' ? o.hintKey : undefined,
      deepLink:
        link !== undefined && typeof link.route === 'string'
          ? { route: link.route, params: link.params !== null && typeof link.params === 'object' ? (link.params as Record<string, string>) : {} }
          : undefined,
    });
  }
  return out;
}

/**
 * The options a person may use: a link always (it only opens a page), a write only when the actor holds
 * its clearing capability (DESIGN.md: hidden, never shown and then refused).
 */
export function visibleOptions(options: readonly DecisionOption[], can: (capability: string) => boolean): DecisionOption[] {
  return options.filter((o) => o.role === 'link' || o.capability === undefined || can(o.capability));
}

/**
 * The ONE action a row shows as a button (D178): the engine's primary when the person may use it, else
 * the first link (open the owning surface), else the first other exit. Everything else goes to the ⋯.
 */
export function pickAction(visible: readonly DecisionOption[]): DecisionOption | null {
  return visible.find((o) => o.role === 'primary') ?? visible.find((o) => o.role === 'link') ?? visible[0] ?? null;
}

/** The capability prefix of the engine's `consequenceKey` (`agent.consequence.<capability>`). */
const CONSEQUENCE_KEY_PREFIX = 'agent.consequence.';

/**
 * The row's D118 C4 consequence in the active locale (D156: the engine's one catalogue), or null when the
 * engine said the row's write carries none (`consequenceKey: null`). The engine names the dial tier in
 * `consequenceKey`; the verb is the drafted tool on a Vorschlag row (`subtitleParams.tool`), else the
 * first exit whose verb carries a consequence.
 */
export function rowConsequence(item: DecisionItem, locale: Locale): string | null {
  const key = item.consequenceKey;
  if (typeof key !== 'string' || !key.startsWith(CONSEQUENCE_KEY_PREFIX)) return null;
  const capability = key.slice(CONSEQUENCE_KEY_PREFIX.length);
  const drafted = item.queueId === 'agent_action' || item.queueId === 'agent_action_bank' ? item.subtitleParams?.tool : undefined;
  const verb =
    typeof drafted === 'string' && drafted.length > 0
      ? drafted
      : (item.decisionOptions ?? []).map((o) => o.verb).find((v): v is string => v !== null && consequenceForVerb(v) !== null) ?? '';
  return consequenceSentence(verb, locale, capability);
}

/** Why the item waits, in words (the owning catalogue's sentence), or null when the engine named none. */
export function reasonSentence(
  t: (key: string, params?: Record<string, string | number>) => string,
  item: DecisionItem,
  viewerActor: string | null,
): string | null {
  if (item.reasonKey === undefined || item.reasonKey === null) return null;
  const params = item.subtitleParams ?? {};
  if (item.queueId !== 'review_flag') return t(item.reasonKey, params);
  if (viewerActor !== null && item.proposedBy === viewerActor) return t('attention.item.reviewFlag.reasonSelf', params);
  if (item.proposedByKind === 'agent') return t('attention.item.reviewFlag.reasonByAgent', params);
  if (item.proposedByKind === 'studio') return t('attention.item.reviewFlag.reasonByStudio', params);
  if (item.proposedByKind === 'member' && typeof params.reviewer === 'string' && params.reviewer !== '') return t(item.reasonKey, params);
  return t('attention.item.reviewFlag.reasonByUnknown', params);
}
