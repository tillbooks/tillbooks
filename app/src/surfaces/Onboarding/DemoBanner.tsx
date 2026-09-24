/**
 * G03's demo banner, a call site of the D89 WorkspaceModeBanner treatment (one shared answer to
 * "these are not your real books", G12's Testmandant strip being the other): a neutral elevated
 * strip, `role="status"` announced once, ONE primary action, and the destructive discard behind an
 * overflow disclosure with an explicit confirm step, never a peer button.
 *
 * Rendered by the Shell above every surface while the CURRENT workspace's kind is `demo`, keyed
 * off the same `get_onboarding_progress` read the Onboarding surface uses (the `workspaceKind`
 * rides along exactly so no second verb exists for this). Anything short of a definite `demo`
 * answer renders NOTHING: a banner wrongly claiming real books were a demo would be worse than no
 * banner.
 *
 * The discard is engine-fenced (`kind='demo'` + `manage_settings`, asserted in
 * `core/onboarding/demo.ts`); the disabled-with-reason state here is the honest mirror, never the
 * enforcement.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { useClient } from '../../lib/client-context';
import { isErr } from '../../lib/client';
import { useCapabilities, CAP } from '../../lib/capabilities';
import { useWorkspace } from '../../app/workspace';
import { useT } from '../../i18n';
import { LockGlyph } from '../../components/states/glyphs';

function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

export function DemoBanner(): React.ReactElement | null {
  const client = useClient();
  const caps = useCapabilities();
  const { workspaceId, setWorkspaceId } = useWorkspace();
  const navigate = useNavigate();
  const t = useT();

  const [kind, setKind] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setKind(null);
    setConfirming(false);
    setError(null);
    if (workspaceId === null) return;
    const res = (await client.call('get_onboarding_progress', { workspaceId })).body;
    if (isErr(res)) return;
    setKind((res.workspaceKind as string) ?? null);
  }, [client, workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (workspaceId === null || kind !== 'demo') return null;

  async function discard(): Promise<void> {
    setBusy(true);
    setError(null);
    const res = (await client.call('discard_demo_workspace', {
      workspaceId: workspaceId as string,
      confirmed: true,
      idempotencyKey: newIdempotencyKey(),
    })).body;
    setBusy(false);
    if (isErr(res)) {
      setError(res.error);
      return;
    }
    setWorkspaceId(null);
    navigate('/onboarding');
  }

  const mayDiscard = caps.can(CAP.manageSettings);

  return (
    <div className="workspace-mode-banner demo-banner" role="status">
      {/* K-22: an SVG from the icon language (a flag), never a text dingbat. */}
      <svg className="workspace-mode-glyph" width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
        <path d="M5 21V4" />
        <path d="M5 4h11l-2 4 2 4H5" />
      </svg>
      <span className="workspace-mode-text">
        <strong>{t('demo.banner.title')}</strong>
      </span>

      {/* The ONE primary action: leave the demo for real books. Discard stays in the overflow. */}
      <Link className="btn btn--primary" to="/onboarding">
        {t('demo.banner.startReal')}
      </Link>

      <details className="demo-banner-overflow">
        <summary>{t('demo.banner.more')}</summary>
        {!confirming ? (
          <>
            <button
              type="button"
              className="btn btn--danger"
              disabled={busy || !mayDiscard}
              onClick={() => setConfirming(true)}
            >
              {!mayDiscard && <LockGlyph size={16} />}
              {t('demo.banner.discard')}
            </button>
            {/* The missing right is named in visible text with the lock glyph, never a `title`
                tooltip and never colour alone (DESIGN.md accessibility). */}
            {!mayDiscard && (
              <span className="demo-banner-denied">
                <LockGlyph size={14} />
                {t('demo.banner.needsManageSettings')}
              </span>
            )}
          </>
        ) : (
          <span className="demo-banner-confirm">
            <span>{t('demo.banner.confirmDiscard')}</span>
            <button type="button" className="btn btn--danger" disabled={busy} onClick={() => void discard()}>
              {t('demo.banner.discard')}
            </button>
            <button type="button" className="btn btn--ghost" disabled={busy} onClick={() => setConfirming(false)}>
              {t('demo.banner.keep')}
            </button>
          </span>
        )}
      </details>

      {error !== null && (
        <p className="demo-banner-error" role="alert">
          {error === 'not_a_demo_workspace' ? t('demo.err.notADemo') : t('demo.err.generic')}
        </p>
      )}
    </div>
  );
}

export default DemoBanner;
