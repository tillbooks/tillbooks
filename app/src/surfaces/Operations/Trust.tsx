/**
 * E07, the Vertrauen panel (spec §6, US-E07.1/.2/.4): the offline proof, in the product, one click
 * from the claim. It lands on the Betrieb (Operations) surface, beside the runtime line, sync and
 * hosting, data and backup and the diagnostics block. K-16 (Option A) moved these operational panels
 * off `/setup` onto their own route; the E07 §6 prose was retargeted to match.
 *
 * WHAT RENDERS HERE, and why each line is in the product rather than in a linked PDF:
 *   - AT REST, one line (D152 rule 4, the owner's pick of 03.10.2026): the standing trust INDICATOR
 *     (glyph + label, the three honest states) fed by `egress_status`, its (i), and "Jetzt prüfen",
 *     which runs `egress_self_test` (a REAL generation under the socket probe) and reports passed /
 *     violated / needs-setup HONESTLY; under it, the data-location value;
 *   - IN THE (i) CARD, one hover or focus away and always in the DOM: the SCOPE note first (this is
 *     about TILL, not your Mac: the mail app uses the internet, that is how mail arrives), so the
 *     claim is never oversold; the wifi instruction; the LIMITS list in full, iCloud/backup FIRST, so
 *     a reader comes away trusting us slightly more and the claim slightly less, which is the correct
 *     outcome (US-E07.4); and the one deliberate network event named out loud (the model download).
 *
 * The panel renders itself away with no workspace (the Diagnostics precedent) and shows the padlock
 * without `egress.read`. The engine is the real gate; `whoami` here is a convenience that fails open.
 */
import { useCallback, useEffect, useId, useState } from 'react';

import { useClient } from '../../lib/client-context';
import { isErr } from '../../lib/client';
import { useWorkspaceId } from '../../app/workspace';
import { useT } from '../../i18n';
import { PermissionDenied } from '../../components/states';
import { useCapabilities } from '../../lib/capabilities';
import { EgressIndicator, type EgressIndicatorState } from '../../components/EgressIndicator';
import { Tooltip } from '../../components/Tooltip';
import { InfoGlyph } from '../../components/states/glyphs';
import { useSyncSignal } from './sync-signal';
import { Link } from 'react-router-dom';
import './Trust.css';

interface Offender {
  kind: string;
  host: string;
  target: string;
}

type SelfTestOutcome =
  | { kind: 'passed' }
  | { kind: 'violated'; offenders: Offender[] }
  | { kind: 'needs_setup'; missing: string[] }
  | { kind: 'incomplete' };

const LIMIT_KEYS = ['os', 'machine', 'disk', 'sockets', 'trust_us'] as const;

/**
 * Where each prerequisite of the self-test is set up (F-10, J7.6). The keys are the engine's
 * `needs_setup.missing` vocabulary (`src/core/egress/egress.ts`): a mailbox is connected on the
 * Korrespondenz surface, the voice profile is learned and the local drafting engine installed on
 * the Schreibstil surface, and a thread TILL can answer (an unanswered inbound message) waits on the
 * Korrespondenz surface. Every key the engine can push is here, and `Trust.test.tsx` reads the engine
 * source to hold that true: a key added there without a door here reds the test, not the screen
 * (critic F3, 2026-09-05: `draftable_thread` reached the screen raw on exactly the install that had
 * finished its setup and had an empty inbox).
 */
export const SETUP_DOORS: Readonly<Record<string, string>> = {
  mail_store: '/correspondence',
  voice_profile: '/writing-style',
  local_runtime: '/writing-style',
  draftable_thread: '/correspondence',
};

/** Past this length the location line abbreviates the path; the (i) card always holds it whole. */
const PATH_INLINE_MAX = 40;

/**
 * The location line's value, kept to one line (D152 rule 4): a long path keeps its root and its
 * last two segments, the folder and the file a person recognises, around an ellipsis
 * (`/tmp/…/A1/demo.db`). The full path is never lost: the card states it in its sentence.
 */
export function shortPath(path: string): string {
  if (path.length <= PATH_INLINE_MAX) return path;
  const sep = path.includes('\\') && !path.includes('/') ? '\\' : '/';
  const parts = path.split(sep);
  if (parts.length <= 4) return path;
  const head = parts[0] === '' ? `${sep}${parts[1]}` : parts[0];
  return [head, '\u2026', ...parts.slice(-2)].join(sep);
}

function stateOf(body: unknown): EgressIndicatorState {
  const state = (body as { state?: unknown })?.state;
  return state === 'local' || state === 'violated' ? state : 'unknown';
}

export function Trust() {
  const t = useT();
  const client = useClient();
  const workspaceId = useWorkspaceId();
  // M02: the sibling SyncHosting panel raises this when its dial flips, so the publishing line below
  // updates live instead of staying at its mount-time value until a reload.
  const { version: syncVersion } = useSyncSignal();
  // M03 (V2): served mode states the instance posture instead of a local path.
  const { whoami } = useCapabilities();
  const served = (whoami?.identitySource ?? 'local_client') === 'served_subject';

  const [indicator, setIndicator] = useState<EgressIndicatorState>('unknown');
  const [denied, setDenied] = useState(false);
  const [running, setRunning] = useState(false);
  const [outcome, setOutcome] = useState<SelfTestOutcome | null>(null);
  const promptId = useId();
  // M02: a zero-egress product shows egress the moment it exists. This one member-visible read tells
  // the Vertrauen panel whether the ledger stream is published; the line below appears only when it is.
  const [publishing, setPublishing] = useState(false);
  // M03 (V2, S1.1/S5.1): the data-location line. Local mode names the database path off
  // delivery_status.dbPath; a failed read renders an explicit UNKNOWN with retry, never a guessed
  // path (data honesty). Served mode ignores the path and states the instance posture instead.
  const [location, setLocation] = useState<{ kind: 'pending' | 'known' | 'unknown'; path: string | null }>({
    kind: 'pending',
    path: null,
  });

  const loadStatus = useCallback(async () => {
    if (workspaceId === null) return;
    const response = await client.call('egress_status', { workspaceId });
    if (isErr(response.body)) {
      if (response.body.error === 'permission_denied' || response.status === 403) setDenied(true);
      // Any other read failure leaves the indicator at its honest default: unknown, never local.
      return;
    }
    setIndicator(stateOf(response.body));
  }, [client, workspaceId]);

  // M02: fails SILENT to "render nothing" on any error (a member without the posture just sees the
  // panel exactly as it was). It never touches the egress indicator's fixed three states.
  const loadPublishing = useCallback(async () => {
    if (workspaceId === null) return;
    const response = await client.call('get_sync_contract', { workspaceId });
    if (isErr(response.body)) return;
    setPublishing((response.body as { publishing?: boolean }).publishing === true);
  }, [client, workspaceId]);

  const loadLocation = useCallback(async () => {
    const response = await client.call('delivery_status', {});
    if (isErr(response.body)) {
      setLocation({ kind: 'unknown', path: null });
      return;
    }
    const dbPath = (response.body as { dbPath?: unknown }).dbPath;
    setLocation(
      typeof dbPath === 'string' ? { kind: 'known', path: dbPath } : { kind: 'unknown', path: null },
    );
  }, [client]);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  useEffect(() => {
    void loadLocation();
  }, [loadLocation]);

  // Re-read the publishing posture on mount AND whenever the sibling dial flips (syncVersion bumps).
  useEffect(() => {
    void loadPublishing();
  }, [loadPublishing, syncVersion]);

  const runSelfTest = useCallback(async () => {
    if (workspaceId === null) return;
    setRunning(true);
    setOutcome(null);
    const response = await client.call('egress_self_test', { workspaceId });
    setRunning(false);
    if (isErr(response.body)) {
      const body = response.body as { error: string; offenders?: Offender[]; missing?: string[] };
      if (body.error === 'egress_violated') {
        setIndicator('violated');
        setOutcome({ kind: 'violated', offenders: body.offenders ?? [] });
      } else if (body.error === 'needs_setup') {
        setOutcome({ kind: 'needs_setup', missing: body.missing ?? [] });
      } else {
        setOutcome({ kind: 'incomplete' });
      }
      return;
    }
    setIndicator('local');
    setOutcome({ kind: 'passed' });
    void loadStatus();
  }, [client, workspaceId, loadStatus]);

  if (workspaceId === null) return null;
  if (denied) return <PermissionDenied body={t('egress.permissionDenied')} />;

  const indicatorLabel = t(`egress.indicator.${indicator}`);

  return (
    <section className="trust" aria-labelledby="trust-title">
      {/* D152 (rule 4, words on demand): the panel rests as ONE line, its state and its one action.
          Every explanation the panel used to print at rest (the scope note, the full location
          sentence, the wifi instruction, the honest limits, the model download) sits in the (i)
          card beside the state, one hover or one focus away, and stays in the DOM so a screen
          reader reaches it through the trigger's aria-describedby. Nothing was deleted: the
          caveats are the panel's honesty, and US-E07.4 still holds them in the product. */}
      <header className="trust-head">
        <h2 id="trust-title" className="trust-title">
          {t('egress.panel.title')}
        </h2>
        <EgressIndicator state={indicator} label={indicatorLabel} />
        <span className="trust-info">
          <Tooltip placement="bottom" content={<TrustCard served={served} location={location} promptId={promptId} />}>
            <button type="button" className="btn btn--ghost btn--icon trust-info-trigger" aria-label={t('egress.info.label')}>
              <InfoGlyph size={16} />
            </button>
          </Tooltip>
        </span>
        <button
          type="button"
          className="btn btn--secondary trust-run"
          disabled={running}
          aria-describedby={promptId}
          onClick={() => void runSelfTest()}
        >
          {t('egress.action.run')}
        </button>
      </header>

      {/* M03 (V2): the data-location line, reduced to its value. Local mode names the file and keeps
          the two quiet links to where the backup and hosting stories start; the sentence around the
          path sits in the card. Served mode states the instance posture (one sentence) and points
          its second link at the exit box (S5.1). A failed read says UNKNOWN with retry, never a
          guessed path. */}
      <p className="trust-location">
        {served ? (
          <>
            <span>{t('journey.location.served')}</span>{' '}
            <a className="trust-location-link" href="#data-title">
              {t('journey.location.backupLink')}
            </a>{' '}
            <a className="trust-location-link" href="#sync-exit">
              {t('journey.location.exitLink')}
            </a>
          </>
        ) : location.kind === 'unknown' ? (
          <>
            <span>{t('journey.location.unknown')}</span>{' '}
            <button type="button" className="btn btn--ghost" onClick={() => void loadLocation()}>
              {t('journey.location.retry')}
            </button>
          </>
        ) : location.kind === 'known' ? (
          <>
            <span className="trust-location-value">{t('journey.location.short', { path: shortPath(location.path ?? '') })}</span>{' '}
            <a className="trust-location-link" href="#data-title">
              {t('journey.location.backupLink')}
            </a>{' '}
            <a className="trust-location-link" href="#sync-title">
              {t('journey.location.hostingLink')}
            </a>
          </>
        ) : null}
      </p>

      {/* M02: the outward line, only while the ledger stream is published. It says AVAILABLE, never
          connected (no consumer is configured on a local install), so the claim stays true; it is
          plain ink, not a status colour (publishing-by-consent is not a warning) and not the accent. */}
      {publishing && (
        <p className="trust-publishing">
          {/* An arrow out of the box, drawn (K-22: no text dingbat). */}
          <svg className="trust-publishing-glyph" width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
            <path d="M7 17L17 7" />
            <path d="M8 7h9v9" />
          </svg>
          {t('sync.trust.publishing')}
        </p>
      )}

      {outcome?.kind === 'passed' && <p className="trust-passed">{t('egress.setup.passed')}</p>}
      {outcome?.kind === 'needs_setup' && (
        // F-10 (J7.6): the refusal names each missing piece in words and links the surface where it
        // is set up, never the engine's raw keys. An unknown key still renders (the engine may grow
        // a prerequisite before this list does), as a plain line without a door.
        <div className="trust-note" role="status">
          <p className="trust-note-lead">{t('egress.setup.needsIntro')}</p>
          <ul className="trust-setup-list">
            {outcome.missing.map((key) => {
              const door = SETUP_DOORS[key];
              return (
                <li key={key}>
                  {door === undefined ? (
                    key
                  ) : (
                    <Link to={door} className="trust-setup-link link-inline">
                      {t(`egress.setup.missing.${key}`)}
                    </Link>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {outcome?.kind === 'incomplete' && <p className="trust-note">{t('egress.setup.incomplete')}</p>}
      {outcome?.kind === 'violated' && (
        <div className="trust-violated" role="alert">
          <p>{t('egress.indicator.violated')}</p>
          <ul className="trust-offenders">
            {outcome.offenders.map((o, i) => (
              <li key={`${o.target}-${i}`}>
                {o.kind}: {o.host || o.target}
              </li>
            ))}
          </ul>
          <p className="trust-report">{t('egress.violated.report')}</p>
        </div>
      )}

    </section>
  );
}

/**
 * The (i) card's content: everything the panel explains, in reading order. The scope note FIRST (the
 * claim is about TILL, not the Mac: US-E07.2 Boundary), then where the books live, then how to run
 * the proof, then the honest limits IN FULL with iCloud/backup first (US-E07.4: a snapshot test
 * asserts each key), then the one deliberate network event. Spans with list roles rather than a
 * ul/li, because a tooltip is phrasing content (the HelpHint precedent).
 */
function TrustCard({
  served,
  location,
  promptId,
}: {
  served: boolean;
  location: { kind: 'pending' | 'known' | 'unknown'; path: string | null };
  /** The wifi instruction's id: "Jetzt prüfen" names it as its description. */
  promptId: string;
}) {
  const t = useT();
  return (
    <span className="trust-card">
      <span className="trust-card-para trust-scope">{t('egress.scope.note')}</span>
      {!served && location.kind === 'known' && (
        <span className="trust-card-para">{t('journey.location.local', { path: location.path ?? '' })}</span>
      )}
      <span id={promptId} className="trust-card-para">
        {t('egress.setup.prompt')}
      </span>
      <span className="trust-card-title">
        {t('egress.limits.title')}
      </span>
      <span className="trust-limits" role="list" aria-label={t('egress.limits.title')}>
        {LIMIT_KEYS.map((key) => (
          <span key={key} role="listitem" className="trust-limit">
            {t(`egress.limits.${key}`)}
          </span>
        ))}
      </span>
      <span className="trust-card-para trust-model-note">{t('egress.model_download.note')}</span>
    </span>
  );
}
