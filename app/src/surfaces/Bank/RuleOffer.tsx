/**
 * A41.5 (the owner-approved "Bankzeilen freigeben" artifact v3): the rule-offer banner above the open lines.
 * ONE offer at a time, in one sentence, with one primary action and "Nicht jetzt":
 *
 *  1. a Buchungsregel the rule miner found (N03: a pending `set_bank_standard` Vorschlag drafted by the
 *     miner, carrying its `minedFacts`): "mongo-like: die letzten 6 Mal gleich gebucht. Als Regel speichern,
 *     dann ist es künftig sicher." "Regel speichern" approves that Vorschlag (`approve_drafted_action`, a
 *     person's act; it posts nothing);
 *  2. else a rule that earned its autopilot (N04, `autobook_candidates`: `grantable`, its offer drafted):
 *     "Künftig automatisch buchen, bis CHF 50?" "Automatisch buchen" grants it with the ceiling shown
 *     (`grant_rule_autobook` with `offerFacts`, as the rule card's switch does);
 *  3. else, while the ask-first threshold `rules.autobook_offer_after` is unanswered and a rule reached the
 *     offer stage (`asksThreshold`), the ONE question (A41.7) inline: nothing is offered before the answer.
 *
 * "Nicht jetzt" hides the offer for this visit only (no write: the Vorschlag stays in Pendenzen, where it can
 * be declined for good). Nothing here decides an offer: the miner and N04 drafted them; the banner says them.
 */
import { useState } from 'react';

import { useClient } from '../../lib/client-context';
import { isErr } from '../../lib/client';
import { formatMoney, useT } from '../../i18n';
import { VOCABULARY } from '../../components/icons';
import { AskFirstQuestion } from './AskFirstQuestion';
import type { AutobookCandidate, AutobookCandidatesOk } from './RuleAutopilot';
import { plural } from './lookups';

const RuleGlyph = VOCABULARY.rule.glyph;

/** The miner's seat (`ruleMiner.ts` MINER_ACTOR): only its drafts are rule offers. */
const MINER_ACTOR = 'system';

/** A rule the miner found, as the banner says it. */
export interface MinedOffer {
  actionId: string;
  party: string;
  repeats: number;
}

const rec = (v: unknown): Record<string, unknown> | null => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/** The pending mined rules in a `list_drafted_actions` answer, newest first as the engine lists them. */
export function parseMinedOffers(body: unknown): MinedOffer[] {
  const actions = rec(body)?.actions;
  if (!Array.isArray(actions)) return [];
  const out: MinedOffer[] = [];
  for (const raw of actions as unknown[]) {
    const a = rec(raw);
    if (a === null || a.status !== 'pending' || a.actionTool !== 'set_bank_standard' || a.actor !== MINER_ACTOR) continue;
    const facts = rec(rec(a.payload)?.minedFacts);
    const actionId = typeof a.actionId === 'string' ? a.actionId : null;
    const party = typeof facts?.counterparty === 'string' ? facts.counterparty : '';
    const repeats = typeof facts?.repeats === 'number' && Number.isFinite(facts.repeats) ? facts.repeats : 0;
    if (actionId === null || party === '' || repeats <= 0) continue;
    out.push({ actionId, party, repeats });
  }
  return out;
}

/** The rule an autopilot offer or question is about, or null. */
function autobookOfferOf(read: AutobookCandidatesOk | null): { candidate: AutobookCandidate; asks: boolean } | null {
  if (read === null || read.setting !== 'offer') return null;
  const asking = read.rules.find((c) => c.asksThreshold === true && c.grant === null);
  if (!read.offerAfterAnswered && asking !== undefined) return { candidate: asking, asks: true };
  const offered = read.rules.find((c) => c.grantable && c.offerActionId !== null && c.ceilingPreview !== null);
  return offered === undefined ? null : { candidate: offered, asks: false };
}

export interface RuleOfferProps {
  workspaceId: string;
  mined: readonly MinedOffer[];
  autopilot: AutobookCandidatesOk | null;
  /** The seat may decide Vorschläge (approve the miner's draft) and grant autopilots: a person's act. */
  canDecide: boolean;
  /** After a write: re-read the lines (a new rule makes them sure) and the options. */
  onChanged: () => void;
  onSaid: (tone: 'success' | 'warn', message: string) => void;
}

export function RuleOffer({ workspaceId, mined, autopilot, canDecide, onChanged, onSaid }: RuleOfferProps) {
  const t = useT();
  const client = useClient();
  const [later, setLater] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  if (!canDecide) return null;

  const minedOffer = mined.find((m) => !later.has(m.actionId));
  const auto = minedOffer === undefined ? autobookOfferOf(autopilot) : null;
  const autoKey = auto === null ? null : `auto:${auto.candidate.standardId}`;
  if (minedOffer === undefined && (auto === null || (autoKey !== null && later.has(autoKey)))) return null;

  const notNow = (key: string) => setLater((s) => new Set([...s, key]));

  if (minedOffer !== undefined) {
    const save = async () => {
      setBusy(true);
      const { body } = await client.call('approve_drafted_action', { workspaceId, actionId: minedOffer.actionId });
      setBusy(false);
      if (isErr(body)) {
        onSaid('warn', t('bankInbox.ruleOffer.failed'));
        return;
      }
      onSaid('success', t('bankInbox.ruleOffer.saved', { party: minedOffer.party }));
      onChanged();
    };
    return (
      <section className="bank-offer" aria-label={t('bankInbox.ruleOffer.label')} data-offer="mined">
        <RuleGlyph size={16} />
        <p className="bank-offer__text">{plural(t, 'bankInbox.ruleOffer.mined', minedOffer.repeats, { party: minedOffer.party })}</p>
        <span className="bank-offer__actions">
          <button type="button" className="btn btn--secondary btn--sm" disabled={busy} onClick={() => void save()}>
            {t('bankInbox.ruleOffer.save')}
          </button>
          <button type="button" className="btn btn--ghost btn--sm" disabled={busy} onClick={() => notNow(minedOffer.actionId)}>
            {t('bankInbox.ruleOffer.later')}
          </button>
        </span>
      </section>
    );
  }

  if (auto === null || autoKey === null) return null;
  const c = auto.candidate;
  const rule = c.label ?? c.counterparty;
  if (auto.asks) {
    return (
      <section className="bank-offer" aria-label={t('bankInbox.ruleOffer.label')} data-offer="ask">
        <RuleGlyph size={16} />
        <AskFirstQuestion
          workspaceId={workspaceId}
          settingKey="rules.autobook_offer_after"
          question={t('bankInbox.ruleOffer.ask', { rule })}
          choices={[3, 5, 10].map((n) => ({ value: n, label: String(n) }))}
          preselect={autopilot?.offerAfter ?? 5}
          saveLabel={t('autobook.ask.save')}
          failedLabel={t('autobook.switch.failed')}
          onAnswered={() => onChanged()}
        />
        <span className="bank-offer__actions">
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => notNow(autoKey)}>
            {t('bankInbox.ruleOffer.later')}
          </button>
        </span>
      </section>
    );
  }
  const preview = c.ceilingPreview;
  if (preview === null) return null;
  const grant = async () => {
    setBusy(true);
    // Critic N04 F2: a grant carries the ceiling the offer showed; the engine refuses offer_stale when it moved.
    const offerFacts = { standardId: c.standardId, counterparty: c.counterparty, label: c.label, cleanUses: c.cleanUses, ceilingMinor: preview.amountMinor, currency: preview.currency };
    const { body } = await client.call('grant_rule_autobook', { workspaceId, standardId: c.standardId, offerFacts, idempotencyKey: crypto.randomUUID() });
    setBusy(false);
    if (isErr(body)) {
      onSaid('warn', t('bankInbox.ruleOffer.grantFailed'));
      return;
    }
    onSaid('success', t('bankInbox.ruleOffer.granted', { rule }));
    onChanged();
  };
  return (
    <section className="bank-offer" aria-label={t('bankInbox.ruleOffer.label')} data-offer="autobook">
      <RuleGlyph size={16} />
      <p className="bank-offer__text">{plural(t, 'bankInbox.ruleOffer.autobook', c.cleanUses, { rule, ceiling: formatMoney(preview.amountMinor, preview.currency) })}</p>
      <span className="bank-offer__actions">
        <button type="button" className="btn btn--secondary btn--sm" disabled={busy} onClick={() => void grant()}>
          {t('bankInbox.ruleOffer.grant')}
        </button>
        <button type="button" className="btn btn--ghost btn--sm" disabled={busy} onClick={() => notNow(autoKey)}>
          {t('bankInbox.ruleOffer.later')}
        </button>
      </span>
    </section>
  );
}
