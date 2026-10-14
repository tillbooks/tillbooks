/**
 * The decision strip under a hub row (F-01, 2026-09-05): the reason the item waits, the ONE
 * consequence sentence of its write (D118 C4, the Vorschlag card's own key), and the exits the
 * owning surface offers, exactly as the engine item declares them in `decisionOptions`.
 *
 * The strip invents nothing. A verb, a label key, an input and a key all arrive on the item; the
 * strip renders the label from the owning catalogue, hides an option whose clearing capability the
 * actor lacks (DESIGN.md: hidden, never shown and then refused), keeps the self-approve ban visible
 * on the drafting actor's own proposal, and hands the act back up to the hub, which makes the one
 * call. "Ablehnen" is destructive and irreversible in the engine, so it confirms IN PLACE with a
 * reason field, never in a modal. The accent budget holds: every decision button is a secondary on
 * every row (K-40, D137); the selected row is marked by its pill tint, never by a solid button.
 *
 * WHO FLAGGED IT IS SAID IN WORDS (DESIGN.md C3, as `Provenance` does): the engine sends the
 * reviewer's kind and display name beside the raw actor id, the strip names the agent seat and the
 * Studio seat in words, a member by the name the read model knows, and an actor the engine cannot
 * place with no name at all. The raw id is compared against `whoami` for "Von dir markiert" and
 * rides only as the tooltip of the reason line; it never reaches the screen as text.
 *
 * WHAT YOU APPROVED IS WHAT RUNS (critic N1). An `agent_action` row carries the figures the engine
 * froze when the agent proposed it (number or draft, counterparty, amount, lines), shown as one quiet
 * line, and `changedSinceProposal` when the record moved since: then the approve exits are hidden,
 * the sentence says why, and rejecting stays possible.
 */
import { useId, useState, type ReactNode } from 'react';

import en from '../../i18n/en.json';
import { useI18n, useT, type Locale } from '../../i18n';
import { figuresLine, type VorschlagFigures } from '../Agent/model';
import { ActionFeedback } from '../../components/ActionFeedback';
import { consequenceForVerb, consequenceSentence } from '../../lib/approval-tiers';
import { useCapabilities } from '../../lib/capabilities';

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

/** The item fields the strip reads; the hub's `Item` satisfies this. */
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
  /** Critic N1, `agent_action` rows: the figures frozen at the proposal. */
  figures?: VorschlagFigures | null;
  /** Critic N1: the record changed since the proposal, so approving would run nothing. */
  changedSinceProposal?: boolean;
}

/** The approve verb a changed Vorschlag may not offer (the engine refuses it `vorschlag_stale`). */
const APPROVE_VERB = 'approve_drafted_action';

/**
 * The verbs the shared catalogue carries a human label for (`agent.verb.*`, all 38 dial-governed
 * verbs, held by `test/attention/verb-labels.test.mjs`). A verb outside the set renders its name
 * with the underscores swapped: not a translation, and honestly not one, but never snake_case.
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

export interface RowDecisionProps {
  item: DecisionItem;
  /**
   * True on the ONE selected row. It marks the strip (`data-selected`) so it reads with its row's
   * pill tint; the buttons themselves are the same secondary on every row (K-40).
   */
  selected: boolean;
  /** In-flight guard: a double press cannot fire twice while the verb runs. */
  busy: boolean;
  onAct: (option: DecisionOption, reason?: string) => void;
  onOpen: (deepLink: { route: string; params: Record<string, string> }) => void;
}

/** The capability prefix of the engine's `consequenceKey` (`agent.consequence.<capability>`). */
const CONSEQUENCE_KEY_PREFIX = 'agent.consequence.';

/**
 * The row's D118 C4 consequence in the active locale (D156: the engine's one catalogue), or null when
 * the engine said the row's write carries none (`consequenceKey: null`). The engine names the dial tier
 * in `consequenceKey`; the verb is the drafted tool on an A35 row (`subtitleParams.tool`), else the
 * first exit whose verb carries a consequence. Resolution is the engine's: the verb's own entry, else
 * the tier's family, so the row reads the sentence the Vorschlag card and a human confirm read.
 */
export function rowConsequence(item: DecisionItem, locale: Locale): string | null {
  const key = item.consequenceKey;
  if (typeof key !== 'string' || !key.startsWith(CONSEQUENCE_KEY_PREFIX)) return null;
  const capability = key.slice(CONSEQUENCE_KEY_PREFIX.length);
  const drafted = item.queueId === 'agent_action' ? item.subtitleParams?.tool : undefined;
  const verb =
    typeof drafted === 'string' && drafted.length > 0
      ? drafted
      : (item.decisionOptions ?? []).map((o) => o.verb).find((v): v is string => v !== null && consequenceForVerb(v) !== null) ?? '';
  return consequenceSentence(verb, locale, capability);
}

export function RowDecision({ item, selected, busy, onAct, onOpen }: RowDecisionProps) {
  const t = useT();
  const { locale } = useI18n();
  const { can, whoami } = useCapabilities();
  const reasonFieldId = useId();
  const [confirming, setConfirming] = useState<DecisionOption | null>(null);
  const [reason, setReason] = useState('');

  const options = item.decisionOptions ?? [];
  // The drafting actor never sees an approve control (the engine's cannot_self_approve still bites
  // underneath); the reason is named in place rather than pointing at a rights page.
  const isOwnProposal = item.queueId === 'agent_action' && whoami !== null && item.proposedBy !== undefined && whoami.actor === item.proposedBy;
  const changed = item.queueId === 'agent_action' && item.changedSinceProposal === true;
  const figures = item.queueId === 'agent_action' && item.figures != null ? figuresLine(t, item.figures) : null;
  const visible = options.filter((o) => {
    if (o.role === 'link') return true;
    if (isOwnProposal) return false;
    if (changed && o.verb === APPROVE_VERB && !o.reasonField) return false;
    return o.capability === undefined || can(o.capability);
  });
  const params = item.subtitleParams ?? {};
  const reasonSentence: string | null =
    item.reasonKey === undefined || item.reasonKey === null
      ? null
      : item.queueId === 'review_flag'
        ? whoami !== null && item.proposedBy === whoami.actor
          ? t('attention.item.reviewFlag.reasonSelf', params)
          : item.proposedByKind === 'agent'
            ? t('attention.item.reviewFlag.reasonByAgent', params)
            : item.proposedByKind === 'studio'
              ? t('attention.item.reviewFlag.reasonByStudio', params)
              : item.proposedByKind === 'member' && typeof params.reviewer === 'string' && params.reviewer !== ''
                ? t(item.reasonKey, params)
                : t('attention.item.reviewFlag.reasonByUnknown', params)
        : t(item.reasonKey, params);
  // The raw actor id is a tooltip at most (an operator debugging a flag may want the engine's key).
  const reasonTitle = item.queueId === 'review_flag' && item.proposedBy !== undefined ? item.proposedBy : undefined;
  const consequence = rowConsequence(item, locale);
  const hint = visible.find((o) => o.hintKey !== undefined)?.hintKey;

  const button = (option: DecisionOption): ReactNode => {
    const label = t(option.labelKey);
    if (option.role === 'link') {
      return (
        <button
          key={option.id}
          type="button"
          className="btn btn--ghost btn--sm"
          data-option={option.id}
          disabled={busy}
          onClick={() => option.deepLink !== undefined && onOpen(option.deepLink)}
        >
          {label}
        </button>
      );
    }
    if (option.reasonField) {
      return (
        <button
          key={option.id}
          type="button"
          className="btn btn--ghost btn--sm"
          data-option={option.id}
          disabled={busy}
          onClick={() => {
            setReason('');
            setConfirming(option);
          }}
        >
          {label}
        </button>
      );
    }
    // K-40 (D137): the decision button is the same secondary on every row. The focused entry is
    // marked by its pill tint alone; a button that turned solid only on the focused row said that
    // something differed between rows when nothing did, and it spent a second primary on the surface.
    return (
      <button
        key={option.id}
        type="button"
        className="btn btn--secondary btn--sm"
        data-option={option.id}
        disabled={busy}
        onClick={() => onAct(option)}
      >
        {label}
      </button>
    );
  };

  return (
    <div className="att-decide" data-queue={item.queueId} data-selected={selected ? '' : undefined}>
      {(reasonSentence !== null || item.suggestedInvoiceNumber) && (
        <p className="att-decide-reason" title={reasonTitle}>
          {reasonSentence}
          {item.suggestedInvoiceNumber ? (
            <span className="att-decide-suggested">
              {reasonSentence !== null ? ' · ' : ''}
              {t('attention.act.suggested', { number: item.suggestedInvoiceNumber })}
            </span>
          ) : null}
        </p>
      )}
      {figures !== null && <p className="att-decide-figures t-money" data-figures="">{figures}</p>}
      {consequence !== null && <p className="att-decide-consequence">{consequence}</p>}
      {changed && <ActionFeedback tone="warn" role="note" message={t('agent.card.changed')} />}
      {isOwnProposal && <p className="att-decide-reason">{t('agent.card.selfHint')}</p>}
      {confirming !== null ? (
        <div className="att-decide-confirm" role="group" aria-label={t(confirming.labelKey)}>
          <label className="att-decide-reason-label" htmlFor={reasonFieldId}>
            {t('attention.act.reasonLabel')}
          </label>
          <input
            id={reasonFieldId}
            className="field att-decide-reason-field"
            type="text"
            value={reason}
            placeholder={t(confirming.reasonPlaceholderKey ?? 'attention.act.reasonPlaceholder')}
            disabled={busy}
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                const option = confirming;
                setConfirming(null);
                onAct(option, reason.trim());
              } else if (e.key === 'Escape') {
                setConfirming(null);
              }
            }}
          />
          <div className="att-decide-actions">
            <button
              type="button"
              className={confirming.role === 'danger' ? 'btn btn--danger btn--sm' : 'btn btn--secondary btn--sm'}
              disabled={busy || (confirming.confirmLabelKey !== undefined && reason.trim() === '')}
              onClick={() => {
                const option = confirming;
                setConfirming(null);
                onAct(option, reason.trim());
              }}
            >
              {t(confirming.confirmLabelKey ?? 'attention.act.rejectConfirm')}
            </button>
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => setConfirming(null)}>
              {t('attention.act.rejectKeep')}
            </button>
          </div>
        </div>
      ) : (
        visible.length > 0 && (
          <div className="att-decide-actions" role="group" aria-label={t(item.titleKey, item.titleParams)}>
            {visible.map(button)}
            {busy && <span className="att-decide-busy">{t('attention.act.busy')}</span>}
          </div>
        )
      )}
      {hint !== undefined && confirming === null && <p className="att-decide-hint">{t(hint)}</p>}
    </div>
  );
}
