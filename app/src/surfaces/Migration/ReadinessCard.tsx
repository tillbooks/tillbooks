/**
 * The go-live readiness card (G09 §7, US-G09.7), rendered on the Datenübernahme surface: the check
 * of whether a plan may go into the real books, read from `migration_readiness`.
 *
 * WHAT THIS CARD IS CAREFUL ABOUT:
 *   - Ready is never plain when a waiver stands: a plan clear of blockers but carrying N recorded
 *     exceptions reads "bereit, mit N Ausnahmen", never a bare ready, so a human judgment is always
 *     visible before go-live (the engine's `readyWithWaivers`).
 *   - Every OPEN item names WHO must move it (du / ein Agent / das System), because that is the
 *     question a stuck migration is really asking; the owner comes from the engine, not a stub.
 *   - The backup precondition (condition 6) is a blocking item until a G04 backup is on record: the
 *     first write into the real books is the one that cannot be undone by rolling a step back.
 *   - A straddled VAT period WARNS, never blocks: the Stichtag falling mid-period is a fact to see, and
 *     both ranges (old system, TILL) are shown, not a refusal.
 *   - A ready plan spends no colour (brand law): only the open items draw ink.
 *   - Nothing is minted: it wires `migration_readiness`, already in the registry.
 */
import { useCallback, useEffect, useState } from 'react';

import { useClient } from '../../lib/client-context';
import { isErr } from '../../lib/client';
import { useT } from '../../i18n';
import { ErrorBanner, Skeleton } from '../../components/states';

interface BlockingItem {
  item: string;
  step?: string;
  state?: string;
  owner: string;
  reason: string;
}
interface WarningItem {
  item: string;
  period?: string;
  oldSystemRange?: { from: string; to: string };
  tillRange?: { from: string; to: string };
  reason: string;
}
interface WaiverItem {
  step: string;
  control: string;
  scope: string;
  reason: string | null;
  owner: string;
}
interface Readiness {
  ready: boolean;
  readyWithWaivers: boolean;
  blocking: BlockingItem[];
  warnings: WarningItem[];
  waivers: WaiverItem[];
  backupOnRecord: boolean;
}

type State = { status: 'loading' } | { status: 'error' } | { status: 'loaded'; readiness: Readiness };

/** The engine returns the owner as its literal German value; map it to a locale key for en/de. */
const OWNER_KEY: Record<string, string> = {
  du: 'you',
  'ein Agent': 'agent',
  'das System': 'system',
};

/** Known blocking/warning item ids get a localised label; a data class falls back to its class label. */
const ITEM_KEY: Record<string, string> = {
  scope_empty: 'scopeEmpty',
  backup_required: 'backupRequired',
  vat_period_straddled: 'vatStraddled',
  // F-09: a plan prepared ahead of its Stichtag; the calendar, not a person, clears it.
  cutover_pending: 'cutoverPending',
};

/**
 * K-25: the engine returns each readiness reason as hard-coded German prose, which read raw in the EN
 * locale. This is the SURFACE reason-code map: the engine's stable prose maps to a locale key the
 * Studio localises, and any prose not in the table falls back to the raw string (never a blank). The
 * keys live in the shared catalogue (migration.readiness.reason.*) so the child panels can reuse them.
 */
const REASON_PROSE_KEY: Record<string, string> = {
  'Es ist noch nichts im Umfang': 'scopeEmpty',
  'Die Prüfung nach der Übernahme weicht vom Probelauf ab': 'diverged',
  'Vor der ersten Übernahme in die echten Bücher braucht es eine Sicherung': 'backupRequired',
  'Der Übernahmestichtag liegt mitten in einer MWST-Periode': 'vatStraddled',
  'Die Exportliste ist noch nicht vollständig': 'extractionIncomplete',
  'Der Zugriff auf das alte System läuft bald ab': 'sourceAccessExpiring',
  'Der Übernahmestichtag ist noch nicht erreicht': 'cutoverPending',
};

/** Engine step states are snake_case; the catalogue keys are camelCase (mirrors Migration.tsx). */
const STEP_STATE_KEY: Record<string, string> = {
  pending: 'pending',
  mapped: 'mapped',
  previewed: 'previewed',
  trial_loaded: 'trialLoaded',
  checked: 'checked',
  committed: 'committed',
  verified: 'verified',
  diverged: 'diverged',
  failed: 'failed',
  rolled_back: 'rolledBack',
  skipped: 'skipped',
};

export function ReadinessCard(props: { workspaceId: string; planId: string }): React.ReactElement {
  const { workspaceId, planId } = props;
  const client = useClient();
  const t = useT();
  const [state, setState] = useState<State>({ status: 'loading' });

  const load = useCallback(async () => {
    setState({ status: 'loading' });
    const res = (await client.call('migration_readiness', { workspaceId, planId })).body;
    if (isErr(res)) {
      setState({ status: 'error' });
      return;
    }
    setState({ status: 'loaded', readiness: res as unknown as Readiness });
  }, [client, workspaceId, planId]);

  useEffect(() => {
    void load();
  }, [load]);

  function itemLabel(item: string): string {
    const known = ITEM_KEY[item];
    if (known !== undefined) return t(`migration.readiness.item.${known}`);
    const classKey = `migration.dataClass.${item}`;
    const hit = t(classKey);
    return hit === classKey ? item : hit;
  }

  function ownerLabel(owner: string): string {
    const key = OWNER_KEY[owner];
    return key === undefined ? owner : t(`migration.actor.${key}`);
  }

  function stepStateLabel(state: string): string {
    const camel = STEP_STATE_KEY[state] ?? state;
    const key = `migration.step.state.${camel}`;
    const hit = t(key);
    return hit === key ? state : hit;
  }

  /**
   * K-25: localise a readiness reason. A known engine prose maps to its locale key; a non-terminal
   * step's reason ("Schritt ist <state>") renders through the state-parametrised key; anything else
   * falls back to the raw engine prose so a new reason is still shown, never blanked.
   */
  function reasonText(reason: string, state?: string): string {
    const known = REASON_PROSE_KEY[reason];
    if (known !== undefined) return t(`migration.readiness.reason.${known}`);
    if (typeof state === 'string' && state !== '') {
      return t('migration.readiness.reason.stepOpen', { state: stepStateLabel(state) });
    }
    return reason;
  }

  if (state.status === 'loading') {
    return (
      <section className="readiness" aria-busy="true" aria-label={t('migration.readiness.title')}>
        <h2>{t('migration.readiness.title')}</h2>
        <Skeleton rows={1} height={48} />
      </section>
    );
  }

  if (state.status === 'error') {
    return (
      <section className="readiness" aria-label={t('migration.readiness.title')}>
        <h2>{t('migration.readiness.title')}</h2>
        <ErrorBanner message={t('migration.readiness.error')} context="read" onRetry={() => void load()} />
      </section>
    );
  }

  const { readiness } = state;

  return (
    <section className="readiness" aria-label={t('migration.readiness.title')}>
      <h2>{t('migration.readiness.title')}</h2>

      {readiness.ready ? (
        <p className="readiness-ready" role="status">
          {readiness.readyWithWaivers
            ? readiness.waivers.length === 1
              ? t('migration.readiness.readyWithOneWaiver')
              : t('migration.readiness.readyWithWaivers', { n: readiness.waivers.length })
            : t('migration.readiness.ready')}
        </p>
      ) : (
        <p className="readiness-blocked">
          {readiness.blocking.length === 1
            ? t('migration.readiness.blockedOne')
            : t('migration.readiness.blocked', { n: readiness.blocking.length })}
        </p>
      )}

      {readiness.blocking.length > 0 && (
        <ul className="readiness-blocking">
          {readiness.blocking.map((b, i) => (
            <li key={`${b.item}-${b.step ?? i}`} className="readiness-item" data-attention="true">
              <span className="readiness-item-label">{itemLabel(b.item)}</span>
              <span className="readiness-item-owner">{t('migration.readiness.owner.prefix', { owner: ownerLabel(b.owner) })}</span>
              {/* K-19: when the engine reason IS the label (scope_empty), the row would read its
                  sentence twice; the reason span only earns its place when it adds something. K-25: the
                  reason is localised at the surface before it is compared and shown. */}
              {reasonText(b.reason, b.state) !== itemLabel(b.item) && (
                <span className="readiness-item-reason">{reasonText(b.reason, b.state)}</span>
              )}
            </li>
          ))}
        </ul>
      )}

      {readiness.warnings.length > 0 && (
        <ul className="readiness-warnings">
          {readiness.warnings.map((w, i) => (
            <li key={`${w.item}-${i}`} className="readiness-warning" role="note">
              <span className="readiness-item-label">{itemLabel(w.item)}</span>
              {w.oldSystemRange !== undefined && w.tillRange !== undefined && (
                <span className="readiness-warning-ranges">
                  {t('migration.readiness.straddle.ranges', {
                    oldFrom: w.oldSystemRange.from,
                    oldTo: w.oldSystemRange.to,
                    tillFrom: w.tillRange.from,
                    tillTo: w.tillRange.to,
                  })}
                </span>
              )}
              {reasonText(w.reason) !== itemLabel(w.item) && <span className="readiness-item-reason">{reasonText(w.reason)}</span>}
            </li>
          ))}
        </ul>
      )}

      {readiness.waivers.length > 0 && (
        <ul className="readiness-waivers">
          {readiness.waivers.map((w, i) => (
            <li key={`${w.control}-${w.scope}-${i}`} className="readiness-waiver">
              {t('migration.readiness.waiver', { control: w.control, scope: w.scope })}
              {w.reason !== null && <span className="readiness-waiver-reason">{w.reason}</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export default ReadinessCard;
