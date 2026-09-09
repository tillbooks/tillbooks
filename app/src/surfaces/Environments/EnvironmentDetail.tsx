/**
 * Environment-detail drawer (D126 finding #9). The third face of an environment behind a row click:
 * its data freshness, guard tier, runtime, code-channel drift and data root, plus a "verify
 * sanitization" affordance (finding #14) that reopens the copy dialog, and a switch action that makes
 * this the active environment for the local face. GUI-reachable, not agent-only.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';

import { useClient } from '../../lib/client-context';
import { useWorkspaceId } from '../../app/workspace';
import { isErr } from '../../lib/client';
import { useT, formatDate } from '../../i18n';
import { DetailDrawer } from '../../components/DetailDrawer';
import { Skeleton } from '../../components/states';
import { LockGlyph } from '../../components/states/glyphs';
import { envErrorMessage } from './errors';
import { type EnvStatusOk, type EnvironmentRow, isProtected, formatSize } from './model';

type State =
  | { kind: 'loading' }
  | { kind: 'error'; text: string }
  | { kind: 'ok'; status: EnvStatusOk };

export function EnvironmentDetail({
  name,
  activeName,
  canManage,
  onClose,
  onRefresh,
  onSwitched,
}: {
  name: string;
  activeName: string;
  canManage: boolean;
  onClose: () => void;
  onRefresh: (name: string) => void;
  onSwitched: (name: string) => void;
}) {
  const t = useT();
  const client = useClient();
  const workspaceId = useWorkspaceId();
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setState({ kind: 'loading' });
    const { body } = await client.call('env_status', { workspaceId, name });
    if (isErr(body)) {
      const { key, params } = envErrorMessage(body);
      setState({ kind: 'error', text: t(key, params) });
      return;
    }
    setState({ kind: 'ok', status: body as unknown as EnvStatusOk });
  }, [client, workspaceId, name, t]);

  useEffect(() => {
    void load();
  }, [load]);

  async function switchTo() {
    setBusy(true);
    const { body } = await client.call('env_switch', {
      workspaceId,
      name,
      confirmed: true,
      idempotencyKey: crypto.randomUUID(),
    });
    setBusy(false);
    if (!isErr(body)) onSwitched(name);
  }

  const env: EnvironmentRow | null = state.kind === 'ok' ? state.status.environment : null;
  const isActive = name === activeName;

  function row(label: string, value: ReactNode) {
    return (
      <div className="env-plan-row">
        <dt>{label}</dt>
        <dd>{value}</dd>
      </div>
    );
  }

  return (
    <DetailDrawer
      open
      title={t('env.detail.title', { name })}
      closeLabel={t('env.detail.close')}
      onClose={onClose}
      headerExtra={env !== null && isProtected(env) ? <LockGlyph size={14} /> : undefined}
      footer={
        env !== null && (
          <>
            {!isActive && (
              <button type="button" className="btn btn--secondary btn--sm" onClick={() => void switchTo()} disabled={busy}>
                {t('env.detail.switch')}
              </button>
            )}
            {!isProtected(env) && canManage && (
              <button type="button" className="btn btn--primary btn--sm" onClick={() => onRefresh(name)}>
                {t('env.detail.verifyAction')}
              </button>
            )}
          </>
        )
      }
    >
      {state.kind === 'loading' && <Skeleton rows={6} />}

      {state.kind === 'error' && (
        <p className="env-dialog-error" role="alert">
          {state.text}
        </p>
      )}

      {state.kind === 'ok' && env !== null && (
        <>
          {env.readOnly && <p className="env-readonly-note">{t('env.detail.readOnlyNote')}</p>}
          <dl className="env-plan">
            {row(t('env.detail.codeChannel'), <span className="env-mono">{env.codeChannel}</span>)}
            {row(
              t('env.detail.drift.label'),
              state.status.codeChannelDrift === 'drifted'
                ? t('env.detail.drift.drifted', { built: state.status.builtCodeChannel ?? '' })
                : t(`env.detail.drift.${state.status.codeChannelDrift}`),
            )}
            {row(t('env.detail.dataPolicy'), t(`env.policyLong.${env.dataPolicy}`))}
            {env.sanitization !== null && row(t('env.detail.sanitization'), t(`env.sanitizeBadge.${env.sanitization}`))}
            {env.sourceEnv !== null && row(t('env.detail.source'), env.sourceEnv)}
            {env.seed !== null && row(t('env.detail.seed'), env.seed)}
            {row(t('env.detail.guard'), t(`env.guard.${env.guardTier}`))}
            {row(t('env.detail.runtime'), t(`env.runtime.${env.runtimeTarget}`))}
            {row(t('env.detail.tierRank'), String(env.tierRank))}
            {row(t('env.detail.created'), formatDate(env.createdAt))}
            {row(t('env.detail.lastRefresh'), env.lastRefreshAt !== null ? formatDate(env.lastRefreshAt) : t('env.never'))}
            {row(t('env.detail.size'), formatSize(env.sizeBytes) ?? '-')}
            {row(t('env.detail.dbPath'), <span className="env-mono">{env.dbPath}</span>)}
          </dl>

          {!isProtected(env) && (
            <section className="env-verify">
              <h3 className="env-plan-title">{t('env.detail.verifyTitle')}</h3>
              <p className="env-field-hint">{t('env.detail.verifyHint')}</p>
            </section>
          )}
        </>
      )}
    </DetailDrawer>
  );
}

export default EnvironmentDetail;
