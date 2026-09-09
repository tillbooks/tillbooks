/**
 * The shell environment indicator (D126 surface block 7.4, matrix E6/E6a).
 *
 * `EnvironmentIndicator` is a compact, always-visible badge of the current environment plus a
 * one-click switcher, meant for the rail footer beside the identity chip and trust slot. `main` gets
 * the one warning accent (DESIGN.md: one accent, no multicolor), everything else the neutral badge.
 * `EnvironmentLiveBanner` is the SEPARATE persistent "LIVE" banner shown across the top of the content
 * when the active environment is `main`, the E6a requirement a badge alone does not meet.
 *
 * Both read `env_list` (which carries the active pointer and every row). They DEGRADE silently: on a
 * transport that answers an unrelated shape (a Shell smoke test, a pre-landscape build) or an error,
 * they render nothing rather than a broken badge. The active-env-missing fallback names develop (the
 * engine's own fallback) and flags it.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { useClient } from '../../lib/client-context';
import { useWorkspaceId } from '../../app/workspace';
import { isErr } from '../../lib/client';
import { useT } from '../../i18n';
import { LockGlyph } from '../../components/states/glyphs';
import { type EnvironmentRow, type EnvListOk } from './model';

/** Read the landscape, or null when it is unavailable or the payload is not the env_list shape. */
function useLandscape(): { rows: readonly EnvironmentRow[]; active: string } | null {
  const client = useClient();
  const workspaceId = useWorkspaceId();
  const [data, setData] = useState<{ rows: readonly EnvironmentRow[]; active: string } | null>(null);

  const load = useCallback(async () => {
    if (workspaceId === null) {
      setData(null);
      return;
    }
    const { body } = await client.call('env_list', { workspaceId });
    if (isErr(body)) {
      setData(null);
      return;
    }
    const ok = body as unknown as Partial<EnvListOk>;
    if (!Array.isArray(ok.environments) || typeof ok.active !== 'string') {
      setData(null);
      return;
    }
    setData({ rows: ok.environments, active: ok.active });
  }, [client, workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  return data;
}

function activeRow(data: { rows: readonly EnvironmentRow[]; active: string }): EnvironmentRow | undefined {
  return data.rows.find((r) => r.name === data.active);
}

export function EnvironmentIndicator() {
  const t = useT();
  const client = useClient();
  const workspaceId = useWorkspaceId();
  const data = useLandscape();
  const [busy, setBusy] = useState(false);

  if (data === null) return null;
  const active = activeRow(data);
  const isMain = active?.guardTier === 'protected';
  const missing = active === undefined;

  async function switchTo(name: string) {
    if (name === data!.active) return;
    setBusy(true);
    await client.call('env_switch', { workspaceId, name, confirmed: true, idempotencyKey: crypto.randomUUID() });
    setBusy(false);
    // A full reload is the honest response: switching the active environment changes the DB every
    // surface reads from, so the whole app must re-read, not just this badge.
    if (typeof window !== 'undefined') window.location.reload();
  }

  return (
    <div className="env-indicator">
      <span className={`env-indicator-badge ${isMain ? 'env-indicator-badge--live' : ''}`} aria-label={t('env.indicator.label', { name: data.active })}>
        {isMain && <LockGlyph size={12} />}
        {missing ? 'develop' : data.active}
      </span>
      {active?.readOnly && <span className="env-indicator-readonly">{t('env.indicator.readOnly')}</span>}
      {data.rows.length > 1 && (
        <select
          className="field env-indicator-switch"
          value={data.active}
          disabled={busy}
          onChange={(e) => void switchTo(e.target.value)}
          aria-label={t('env.indicator.switchLabel')}
        >
          {data.rows.map((r) => (
            <option key={r.name} value={r.name}>
              {r.name}
            </option>
          ))}
        </select>
      )}
      <Link className="env-indicator-manage" to="/environments">
        {t('env.indicator.manage')}
      </Link>
      {missing && <span className="env-field-hint env-field-hint--warn">{t('env.indicator.missing')}</span>}
    </div>
  );
}

/** The persistent LIVE banner (E6a): rendered across the top of the content while active env is main. */
export function EnvironmentLiveBanner() {
  const t = useT();
  const data = useLandscape();
  if (data === null) return null;
  const active = activeRow(data);
  if (active === undefined || active.guardTier !== 'protected') return null;
  return (
    <div className="env-live-banner" role="status">
      <LockGlyph size={14} />
      {t('env.indicator.liveBanner')}
    </div>
  );
}

export default EnvironmentIndicator;
