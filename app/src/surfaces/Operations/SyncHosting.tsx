/**
 * M02 Sync & hosting panel (spec §6, §6b): the publish dial and the delivery/egress posture, on the
 * Betrieb (Operations) surface, between RuntimeLine and DataBackup so its exit box is a one-scroll
 * hop to Data & Backup. It renders itself away with no workspace, exactly as Trust and DataBackup do.
 * K-16 (Option A) moved this panel here off `/setup`; the spec §6 prose was retargeted to match.
 *
 * THIS PANEL CARRIES OUTWARD CLAIMS, so every sentence it renders is scoped to what the LOCAL build
 * can prove (design brief §3). Two facts shape it:
 *   1. The core persists NO consumer cursor, so the only honest consumer readout on this install is
 *      "unknown" (the ◌ posture), never a green "in sync" it cannot prove. A lag number would need a
 *      consumer-presented cursor that nothing in this build supplies.
 *   2. `get_sync_contract` is the panel's ONE read: it is visible to any member, so a plain member
 *      still sees their own dial. `sync_stream_status` is `sync.read`-gated and would deny them, and
 *      with no cursor returns lag:null anyway, so it adds nothing and the panel never calls it.
 *
 * The dial is a real switch, never a "Turn on" primary button: enabling must not look like the
 * rewarded path (spec §6, no dark pattern toward enabling). The accent appears only as the switch's
 * focus ring; ON and OFF are visually symmetric.
 */
import { useCallback, useEffect, useId, useState } from 'react';

import { useClient } from '../../lib/client-context';
import { isErr, type Err } from '../../lib/client';
import { useWorkspaceId } from '../../app/workspace';
import { useT } from '../../i18n';
import { useCapabilities } from '../../lib/capabilities';
import { ErrorBanner, PermissionDenied, Skeleton } from '../../components/states';
import { LockGlyph } from '../../components/states/glyphs';
import { HelpHint } from '../../components/HelpHint';
import { useSyncSignal } from './sync-signal';
import { HostingJourney, ExitChecklist } from './HostingJourney';
import './SyncHosting.css';

/** Exactly the `get_sync_contract` fields the panel consumes (see `src/core/sync/stream.ts`). */
interface Contract {
  contractVersion: string;
  publishing: boolean;
  epoch: string | null;
  headSeq: number;
}

type Load =
  | { kind: 'loading' }
  | { kind: 'ready'; contract: Contract }
  | { kind: 'denied' }
  | { kind: 'error'; error: Err };

/**
 * The consumer status line: a sibling of the E07 `EgressIndicator` (glyph + label, role="status"),
 * NOT the indicator itself. E07's glyphs are fixed by contract (§6b, so a plugin cannot restyle the
 * indicator into a lie), and its ● "local, no connection" would be a lie if reused to mean "consumer
 * caught up", so the sync readout gets its own family member. This build renders only the ◌ (unknown)
 * line; the ● lag line has its home here for when a consumer-presented cursor ever reaches the Studio.
 */
function ConsumerStatus({ glyph, label, tone }: { glyph: string; label: string; tone: 'unknown' | 'ok' }) {
  return (
    <span className={`sync-status sync-status--${tone}`} role="status" aria-label={label}>
      <span className="sync-status-glyph" aria-hidden="true">
        {glyph}
      </span>
      <span className="sync-status-label">{label}</span>
    </span>
  );
}

export function SyncHosting() {
  const t = useT();
  const client = useClient();
  const workspaceId = useWorkspaceId();
  const canManage = useCapabilities().can('manage_sync');
  const { notifyChange } = useSyncSignal();

  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<Err | null>(null);
  const hintId = useId();

  const refresh = useCallback(async () => {
    if (workspaceId === null) return;
    setLoad({ kind: 'loading' });
    // The panel's ONE read (design §0): member-visible, so a plain member sees their own dial.
    const resp = await client.call('get_sync_contract', { workspaceId });
    if (isErr(resp.body)) {
      setLoad(
        resp.body.error === 'permission_denied' || resp.status === 403
          ? { kind: 'denied' }
          : { kind: 'error', error: resp.body },
      );
      return;
    }
    setLoad({ kind: 'ready', contract: resp.body as unknown as Contract });
  }, [client, workspaceId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // A dial flip re-reads the contract and re-renders (design §4): no toast, no optimistic guess about
  // a posture the engine owns. The idempotency key is per click (the DataBackup `g04-` precedent).
  const flip = useCallback(
    async (next: boolean) => {
      if (workspaceId === null) return;
      setBusy(true);
      setActionError(null);
      const action = next ? 'sync_publish_enable' : 'sync_publish_disable';
      const resp = await client.call(action, { workspaceId, idempotencyKey: `m02-${Date.now()}` });
      setBusy(false);
      if (isErr(resp.body)) {
        setActionError(resp.body);
        return;
      }
      void refresh();
      // A sibling panel (E07 Trust) renders a line off the SAME contract: raise the signal so it
      // re-reads live, rather than showing the pre-flip state until a reload (design §4).
      notifyChange();
    },
    [client, workspaceId, refresh, notifyChange],
  );

  if (workspaceId === null) return null;

  // (a) The read itself refused (non-member / 403): the full A24 padlock panel, as DataBackup does.
  if (load.kind === 'denied') {
    return (
      <section className="sync-panel">
        <PermissionDenied title={t('sync.title')} body={t('sync.denied.body')} />
      </section>
    );
  }

  const publishing = load.kind === 'ready' && load.contract.publishing;

  // The exit box and the managed-tier note are STANDING copy: the degraded/local truth must be
  // present in every non-loading state, never only when something fails (design §3, rows 6 and 7).
  const standingBlocks = (
    <>
      <div className="sync-exit" id="sync-exit">
        <h3 className="sync-exit-title">{t('sync.exit.title')}</h3>
        <p className="sync-exit-body">{t('sync.exit.body')}</p>
        {/* Fronts G04 in place: no backup/export control is re-implemented here, the anchor to Data &
            Backup's existing heading is the whole affordance. */}
        <a className="sync-exit-link link-inline" href="#data-title">
          {t('sync.exit.link')}
        </a>
        {/* M03 (S6.1): the exit guarantee's mechanics as the SAME checklist component the move
            journey uses: one design language, same step vocabulary, position marker included. */}
        <ExitChecklist />
      </div>
      <p className="sync-tier-note">{t('sync.tier.note')}</p>
    </>
  );

  return (
    <section className="sync-panel" aria-labelledby="sync-title">
      <header className="sync-head">
        <h2 id="sync-title" className="diag-subtitle">
          {t('sync.title')}
        </h2>
        {/* The dial renders only on a known posture: never a switch whose state is unknown (design §4). */}
        {load.kind === 'ready' && (
          <div className="sync-dial-wrap">
            <button
              type="button"
              role="switch"
              aria-checked={publishing}
              aria-label={t('sync.dial.label')}
              className="sync-dial"
              disabled={!canManage || busy}
              {...(!canManage ? { 'aria-disabled': true, 'aria-describedby': hintId } : {})}
              onClick={() => void flip(!publishing)}
            >
              <span className="sync-dial-track" aria-hidden="true">
                <span className="sync-dial-thumb" />
              </span>
              <span className="sync-dial-state">{publishing ? t('sync.dial.on') : t('sync.dial.off')}</span>
            </button>
            {/* A non-owner sees the switch DISABLED with a padlock and the reason, never enabled-then-
                rejected (design §2, A24 courtesy gate; the engine is the real gate). */}
            {!canManage && (
              <span className="sync-dial-lock" id={hintId}>
                <LockGlyph className="sync-lock-glyph" size={14} />
                {t('sync.dial.denied')}
              </span>
            )}
          </div>
        )}
      </header>

      {/* M03 (V3): the Hosting journey: the D106 model, the three rungs, and the directional move
          checklist driven by the Move record. Renders above the built dial, per the spec wireframe. */}
      <HostingJourney workspaceId={workspaceId} />

      {load.kind === 'loading' && <Skeleton rows={3} />}

      {load.kind === 'error' && <ErrorBanner error={load.error} context="read" onRetry={() => void refresh()} />}

      {load.kind === 'ready' && (
        <>
          {actionError !== null && <ErrorBanner error={actionError} />}

          {/* The claims-honesty anchor: OFF says no stream is published; ON says the stream is
              AVAILABLE to authorised readers and explicitly NOT that anything is connected. */}
          <p className="sync-posture diag-prose">
            {publishing ? t('sync.state.on.body') : t('sync.state.off.body')}
          </p>

          {publishing && (
            <>
              <dl className="sync-values">
                <div className="sync-row">
                  <dt className="sync-label">{t('sync.contract.version')}</dt>
                  <dd className="sync-value">{load.contract.contractVersion}</dd>
                </div>
                <div className="sync-row">
                  <dt className="sync-label">{t('sync.stream.head')}</dt>
                  <dd className="sync-value sync-num">{load.contract.headSeq}</dd>
                </div>
                <div className="sync-row">
                  <dt className="sync-label">
                    {t('sync.epoch.label')}
                    <HelpHint
                      label={t('sync.epoch.help_label')}
                      title={t('sync.epoch.label')}
                      body={t('sync.epoch.reset_hint')}
                    />
                  </dt>
                  <dd className="sync-value">{load.contract.epoch ?? ''}</dd>
                </div>
              </dl>

              <div className="sync-consumer">
                <h3 className="sync-consumer-title">{t('sync.consumer.title')}</h3>
                {/* The only provable state on this install: the core owns no consumer cursor, so
                    "unknown" (◌) is the honest readout, never a green line without a presented cursor. */}
                <ConsumerStatus glyph="◌" label={t('sync.consumer.none')} tone="unknown" />
              </div>
            </>
          )}
        </>
      )}

      {load.kind !== 'loading' && standingBlocks}
    </section>
  );
}
