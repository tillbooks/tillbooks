/**
 * Create-environment drawer (D126 finding #4, surface inventory 7.1). Names a new environment and its
 * data policy, then follows the engine's P8 shape: the first submit gets the PLAN (`env_create`
 * unconfirmed, changes nothing) and shows exactly what would be created; the confirm executes it with
 * an idempotency key. `policy=copy` is Phase B, so it is shown, disabled, and points at the Refresh
 * action on an existing environment (finding #8: a copy never silently resolves to a raw default).
 */
import { useId, useState } from 'react';

import { useClient } from '../../lib/client-context';
import { useWorkspaceId } from '../../app/workspace';
import { isErr } from '../../lib/client';
import { useT } from '../../i18n';
import { DetailDrawer } from '../../components/DetailDrawer';
import { envErrorMessage } from './errors';
import type { DataPolicy } from './model';

interface CreatePlan {
  name: string;
  policy: string;
  codeChannel: string;
  dbPath: string;
  seed: string | null;
}

export function CreateEnvironmentDrawer({
  existingNames,
  onClose,
  onDone,
}: {
  existingNames: readonly string[];
  onClose: () => void;
  onDone: (name: string) => void;
}) {
  const t = useT();
  const client = useClient();
  const workspaceId = useWorkspaceId();
  const nameId = useId();

  const [name, setName] = useState('');
  const [policy, setPolicy] = useState<DataPolicy>('synthetic');
  const [seed, setSeed] = useState('');
  const [codeChannel, setCodeChannel] = useState('');
  const [runtime, setRuntime] = useState<'local' | 'served'>('local');
  const [plan, setPlan] = useState<CreatePlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const trimmed = name.trim();
  const collision = existingNames.includes(trimmed);
  const nameValid = trimmed.length > 0 && !/[\\/]/.test(trimmed) && trimmed !== '.' && trimmed !== '..';
  const canSubmit = nameValid && !collision && policy !== 'copy' && !busy && workspaceId !== null;

  function baseInput() {
    return {
      workspaceId,
      name: trimmed,
      policy,
      ...(policy === 'synthetic' && seed.trim() !== '' ? { seed: seed.trim() } : {}),
      ...(codeChannel.trim() !== '' ? { codeChannel: codeChannel.trim() } : {}),
      runtimeTarget: runtime,
    };
  }

  async function stage() {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    const { body } = await client.call('env_create', baseInput());
    setBusy(false);
    if (isErr(body)) {
      const { key, params } = envErrorMessage(body);
      setError(t(key, params));
      return;
    }
    const p = (body as unknown as { plan?: CreatePlan }).plan;
    if (p !== undefined) setPlan(p);
  }

  async function confirm() {
    setBusy(true);
    setError(null);
    const { body } = await client.call('env_create', {
      ...baseInput(),
      confirmed: true,
      idempotencyKey: crypto.randomUUID(),
    });
    setBusy(false);
    if (isErr(body)) {
      const { key, params } = envErrorMessage(body);
      setError(t(key, params));
      setPlan(null);
      return;
    }
    onDone(trimmed);
  }

  return (
    <DetailDrawer
      open
      title={t('env.create_dialog.title')}
      closeLabel={t('env.create_dialog.cancel')}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn--secondary btn--sm" onClick={onClose}>
            {t('env.create_dialog.cancel')}
          </button>
          {plan === null ? (
            <button type="button" className="btn btn--primary" onClick={() => void stage()} disabled={!canSubmit}>
              {t('env.create_dialog.submit')}
            </button>
          ) : (
            <button type="button" className="btn btn--primary" onClick={() => void confirm()} disabled={busy}>
              {t('env.create_dialog.confirm')}
            </button>
          )}
        </>
      }
    >
      <p className="env-dialog-lead">{t('env.create_dialog.lead')}</p>

      {error !== null && (
        <p className="env-dialog-error" role="alert">
          {error}
        </p>
      )}

      {plan === null ? (
        <div className="env-form">
          <label className="env-field" htmlFor={nameId}>
            <span className="env-field-label">{t('env.create_dialog.name.label')}</span>
            <input
              id={nameId}
              className="field"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('env.create_dialog.name.placeholder')}
              autoComplete="off"
            />
            <span className="env-field-hint">{t('env.create_dialog.name.hint')}</span>
            {collision && <span className="env-field-hint env-field-hint--warn">{t('env.error.environment_exists', { name: trimmed })}</span>}
          </label>

          <fieldset className="env-field">
            <legend className="env-field-label">{t('env.create_dialog.policy.label')}</legend>
            <label className="env-radio">
              <input type="radio" name="policy" checked={policy === 'synthetic'} onChange={() => setPolicy('synthetic')} />
              {t('env.create_dialog.policy.synthetic')}
            </label>
            <label className="env-radio">
              <input type="radio" name="policy" checked={policy === 'live'} onChange={() => setPolicy('live')} />
              {t('env.create_dialog.policy.live')}
            </label>
            <label className="env-radio env-radio--disabled">
              <input type="radio" name="policy" checked={policy === 'copy'} onChange={() => setPolicy('copy')} />
              {t('env.create_dialog.policy.copy')}
            </label>
            {policy === 'copy' && <p className="env-field-hint env-field-hint--warn">{t('env.create_dialog.policy.copyNote')}</p>}
          </fieldset>

          {policy === 'synthetic' && (
            <label className="env-field">
              <span className="env-field-label">{t('env.create_dialog.seed.label')}</span>
              <input className="field" value={seed} onChange={(e) => setSeed(e.target.value)} placeholder="seeblick" autoComplete="off" />
              <span className="env-field-hint">{t('env.create_dialog.seed.hint')}</span>
            </label>
          )}

          <label className="env-field">
            <span className="env-field-label">{t('env.create_dialog.codeChannel.label')}</span>
            <input className="field" value={codeChannel} onChange={(e) => setCodeChannel(e.target.value)} placeholder={trimmed || 'develop'} autoComplete="off" />
            <span className="env-field-hint">{t('env.create_dialog.codeChannel.hint')}</span>
          </label>

          <fieldset className="env-field">
            <legend className="env-field-label">{t('env.create_dialog.runtime.label')}</legend>
            <label className="env-radio">
              <input type="radio" name="runtime" checked={runtime === 'local'} onChange={() => setRuntime('local')} />
              {t('env.create_dialog.runtime.local')}
            </label>
            <label className="env-radio">
              <input type="radio" name="runtime" checked={runtime === 'served'} onChange={() => setRuntime('served')} />
              {t('env.create_dialog.runtime.served')}
            </label>
          </fieldset>
        </div>
      ) : (
        <dl className="env-plan">
          <h3 className="env-plan-title">{t('env.create_dialog.planTitle')}</h3>
          <div className="env-plan-row">
            <dt>{t('env.create_dialog.plan.name')}</dt>
            <dd>{plan.name}</dd>
          </div>
          <div className="env-plan-row">
            <dt>{t('env.create_dialog.plan.policy')}</dt>
            <dd>{t(`env.policy.${plan.policy}`)}</dd>
          </div>
          {plan.seed !== null && (
            <div className="env-plan-row">
              <dt>{t('env.create_dialog.plan.seed')}</dt>
              <dd>{plan.seed}</dd>
            </div>
          )}
          <div className="env-plan-row">
            <dt>{t('env.create_dialog.plan.codeChannel')}</dt>
            <dd>{plan.codeChannel}</dd>
          </div>
          <div className="env-plan-row">
            <dt>{t('env.create_dialog.plan.dbPath')}</dt>
            <dd className="env-mono">{plan.dbPath}</dd>
          </div>
        </dl>
      )}
    </DetailDrawer>
  );
}

export default CreateEnvironmentDrawer;
