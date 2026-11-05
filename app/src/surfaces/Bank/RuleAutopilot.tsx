/**
 * N04 (D183), a Buchungsregel's autopilot on its rule card: the chip ("Automatisch", "Pausiert: <Grund>",
 * "Gestoppt" while `rules.autobook` is off) and, in the editor, the switch "Künftig automatisch". The switch
 * is enabled only when the engine says the rule may be granted now (or when it is on, to switch it off);
 * otherwise the reason is on hover. Granting is a person's act (the engine refuses a governed seat), and
 * the ceiling it fixes is shown beside it. Reads `autobook_candidates`; writes `grant_rule_autobook` and
 * `revoke_rule_autobook`.
 */

import { useState } from 'react';

import { useClient } from '../../lib/client-context';
import { isErr } from '../../lib/client';
import { formatMoney, useT } from '../../i18n';
import type { AutobookCandidate, AutobookCandidatesOk } from '../../../../src/core/banking/autobook';

export type { AutobookCandidate, AutobookCandidatesOk };

/** The chip of a rule's grant state, or null when it has none worth showing. */
export function RuleAutopilotChip({ candidate }: { candidate: AutobookCandidate | undefined }) {
  const t = useT();
  const grant = candidate?.grant ?? null;
  if (grant === null) return null;
  if (grant.state === 'active') return <span className="bank-rules__auto" data-state="active">{t('autobook.chip.active')}</span>;
  if (grant.state === 'stopped') return <span className="bank-rules__auto" data-state="stopped">{t('autobook.chip.stopped')}</span>;
  if (grant.state === 'suspended') {
    return (
      <span className="bank-rules__auto" data-state="suspended">
        {t('autobook.chip.paused', { reason: t(`autobook.suspended.${grant.suspendedReason ?? 'reopened'}`) })}
      </span>
    );
  }
  return null;
}

export interface RuleAutopilotSwitchProps {
  workspaceId: string;
  candidate: AutobookCandidate | undefined;
  offerAfter: number;
  onChanged: () => void;
}

/** The switch "Künftig automatisch" in the rule editor. */
export function RuleAutopilotSwitch({ workspaceId, candidate, offerAfter, onChanged }: RuleAutopilotSwitchProps) {
  const t = useT();
  const client = useClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (candidate === undefined) return null;
  const on = candidate.grant !== null && candidate.grant.state === 'active';
  const hint = on
    ? null
    : !candidate.eligible
      ? t(`autobook.ineligible.${candidate.ineligibleReason ?? 'rule_invalid'}`)
      : !candidate.grantable
        ? candidate.cleanUses < offerAfter
          ? t('autobook.switch.notEarned', { uses: candidate.cleanUses, needed: offerAfter })
          : t('autobook.switch.notNow')
        : null;
  const enabled = on || candidate.grantable;
  const flip = async () => {
    setBusy(true);
    setError(null);
    const verb = on ? 'revoke_rule_autobook' : 'grant_rule_autobook';
    // Critic N04 F2: a grant carries the ceiling the switch showed; the engine refuses offer_stale when it moved.
    const preview = candidate.ceilingPreview;
    const shown =
      !on && preview !== null
        ? { offerFacts: { standardId: candidate.standardId, counterparty: candidate.counterparty, label: candidate.label, cleanUses: candidate.cleanUses, ceilingMinor: preview.amountMinor, currency: preview.currency } }
        : {};
    const { body } = await client.call(verb, { workspaceId, standardId: candidate.standardId, ...shown, idempotencyKey: crypto.randomUUID() });
    setBusy(false);
    if (isErr(body)) {
      setError(t('autobook.switch.failed'));
      return;
    }
    onChanged();
  };
  const ceiling = on && candidate.grant !== null ? { amountMinor: candidate.grant.ceilingMinor, currency: candidate.grant.currency } : candidate.ceilingPreview;
  return (
    <div className="bank-rules__autoswitch" title={hint ?? undefined}>
      <label className="bank-rules__autoswitch-label">
        <input type="checkbox" role="switch" checked={on} disabled={!enabled || busy} aria-describedby={`autobook-hint-${candidate.standardId}`} onChange={() => void flip()} />
        {t('autobook.switch.label')}
      </label>
      <p id={`autobook-hint-${candidate.standardId}`} className="bank-rules__autoswitch-hint">
        {hint ?? (ceiling !== null ? t('autobook.switch.ceiling', { ceiling: formatMoney(ceiling.amountMinor, ceiling.currency), currency: ceiling.currency }) : '')}
      </p>
      {error !== null && (
        <p className="bank-rules__autoswitch-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** Read the candidates once per sheet read; null while loading or when the read is refused. */
export async function readCandidates(client: ReturnType<typeof useClient>, workspaceId: string): Promise<AutobookCandidatesOk | null> {
  const { body } = await client.call('autobook_candidates', { workspaceId });
  if (isErr(body)) return null;
  return body as unknown as AutobookCandidatesOk;
}
