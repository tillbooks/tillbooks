/**
 * Copy / refresh dialog (D126 surface block 7.3, findings #7 and #12). Copies data one-way from a
 * higher-ranked source into a lower one, sanitized, and REPLACES the target. It leads with a plain
 * sentence of what will happen, then the pickers, and shows the FOUR named phases (snapshot, restore,
 * sanitize, verify) so a synchronous whole-instance copy still has a visible journey even though
 * CopyJob as a resumable entity is cut (section 9).
 *
 * It wires the Phase B verb `env_copy`. ASSUMED INPUT SHAPE (concept sections 6 and 7.3), flagged for
 * integration to reconcile with the branch that builds the engine:
 *   { workspaceId, source, target, scope: 'instance' | `mandate:<id>`,
 *     sanitize: 'raw' | 'pseudonymize' | 'structure_synthetic',
 *     retainSecrets?: boolean (owner-only D-ENV-5 override),
 *     confirmed, idempotencyKey }
 * A call without `confirmed` is expected to return a plan (P8) and change nothing. Because the verb
 * is not on this branch yet, the dialog handles whatever the engine answers (including
 * `phase_b_not_implemented` / `unknown_action`) through the shared error mapper.
 */
import { useId, useMemo, useState } from 'react';

import { useClient } from '../../lib/client-context';
import { useWorkspaceId } from '../../app/workspace';
import { isErr } from '../../lib/client';
import { useT } from '../../i18n';
import { Modal } from '../../components/Modal';
import { envErrorMessage } from './errors';
import { type EnvironmentRow, type Sanitization, isProtected } from './model';

type Scope = 'instance' | 'mandate';
type Phase = 'snapshot' | 'restore' | 'sanitize' | 'verify';
const PHASES: readonly Phase[] = ['snapshot', 'restore', 'sanitize', 'verify'];

export function CopyRefreshDialog({
  target,
  environments,
  canRetainSecrets,
  onClose,
  onDone,
}: {
  target: string;
  environments: readonly EnvironmentRow[];
  /** Owner-only: the D-ENV-5 secret-retaining override is offered only when the actor may manage. */
  canRetainSecrets: boolean;
  onClose: () => void;
  onDone: (source: string, target: string) => void;
}) {
  const t = useT();
  const client = useClient();
  const workspaceId = useWorkspaceId();
  const mandateId = useId();
  const confirmNameId = useId();

  const targetEnv = environments.find((e) => e.name === target);
  // Only a strictly higher-ranked, non-protected-as-target source is a legal copy source (finding
  // #10, the down-only invariant). main is the canonical source and ranks highest.
  const sources = useMemo(
    () => environments.filter((e) => targetEnv !== undefined && e.tierRank > targetEnv.tierRank),
    [environments, targetEnv],
  );

  const [source, setSource] = useState(sources[0]?.name ?? '');
  const [scope, setScope] = useState<Scope>('instance');
  const [mandate, setMandate] = useState('');
  const [sanitize, setSanitize] = useState<Sanitization>('pseudonymize');
  const [showOverride, setShowOverride] = useState(false);
  const [retainSecrets, setRetainSecrets] = useState(false);
  const [confirmName, setConfirmName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ workspaces: number; masked: number } | null>(null);

  const targetIsMain = targetEnv !== undefined && isProtected(targetEnv);
  const rawNeedsName = sanitize === 'raw';
  const rawConfirmed = !rawNeedsName || confirmName.trim() === target;
  const mandateOk = scope !== 'mandate' || mandate.trim() !== '';
  const canSubmit =
    source !== '' && !targetIsMain && rawConfirmed && mandateOk && !busy && workspaceId !== null && done === null;

  function scopeValue(): string {
    return scope === 'mandate' ? `mandate:${mandate.trim()}` : 'instance';
  }

  async function run() {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    const { body } = await client.call('env_copy', {
      workspaceId,
      source,
      target,
      scope: scopeValue(),
      sanitize,
      ...(retainSecrets ? { retainSecrets: true } : {}),
      confirmed: true,
      idempotencyKey: crypto.randomUUID(),
    });
    setBusy(false);
    if (isErr(body)) {
      const { key, params } = envErrorMessage(body);
      setError(t(key, params));
      return;
    }
    const ok = body as unknown as { summary?: { workspacesCopied?: number; piiCellsMasked?: number } };
    setDone({
      workspaces: ok.summary?.workspacesCopied ?? 0,
      masked: ok.summary?.piiCellsMasked ?? 0,
    });
  }

  /** The state of one phase in the strip: done once the copy succeeded, running while it is in flight,
   *  pending before. A single synchronous call cannot report per-phase progress, so the strip shows
   *  the journey and its overall state honestly rather than faking intermediate steps. */
  function phaseState(): 'pending' | 'running' | 'done' {
    if (done !== null) return 'done';
    if (busy) return 'running';
    return 'pending';
  }

  const leadSentence = t('env.copy_dialog.lead', {
    source: source || t('env.copy_dialog.source.label'),
    target,
    sanitizeSentence: t(`env.copy_dialog.sanitizeSentence.${sanitize}`),
  });

  return (
    <Modal
      open
      title={t('env.copy_dialog.title')}
      onClose={onClose}
      closeLabel={t('env.copy_dialog.cancel')}
      footer={
        done !== null ? (
          <button type="button" className="btn btn--primary" onClick={() => onDone(source, target)}>
            {t('env.detail.close')}
          </button>
        ) : (
          <>
            <button type="button" className="btn btn--secondary btn--sm" onClick={onClose}>
              {t('env.copy_dialog.cancel')}
            </button>
            <button type="button" className="btn btn--danger" onClick={() => void run()} disabled={!canSubmit}>
              {busy ? t('env.copy_dialog.running') : t('env.copy_dialog.submit')}
            </button>
          </>
        )
      }
    >
      <p className="env-dialog-lead">{leadSentence}</p>
      <p className="env-dialog-oneway">{t('env.copy_dialog.oneWay', { target })}</p>

      {error !== null && (
        <p className="env-dialog-error" role="alert">
          {error}
        </p>
      )}

      {targetIsMain && (
        <p className="env-dialog-error" role="alert">
          {t('env.error.target_is_main')}
        </p>
      )}

      {done === null && !targetIsMain && (
        <div className="env-form">
          <label className="env-field">
            <span className="env-field-label">{t('env.copy_dialog.source.label')}</span>
            <select className="field" value={source} onChange={(e) => setSource(e.target.value)}>
              {sources.map((s) => (
                <option key={s.name} value={s.name}>
                  {s.name}
                </option>
              ))}
            </select>
            <span className="env-field-hint">{t('env.copy_dialog.source.hint')}</span>
          </label>

          <div className="env-field">
            <span className="env-field-label">{t('env.copy_dialog.target.label')}</span>
            <p className="env-target-fixed env-mono">{target}</p>
          </div>

          <fieldset className="env-field">
            <legend className="env-field-label">{t('env.copy_dialog.scope.label')}</legend>
            <label className="env-radio">
              <input type="radio" name="scope" checked={scope === 'instance'} onChange={() => setScope('instance')} />
              {t('env.copy_dialog.scope.instance')}
            </label>
            <label className="env-radio">
              <input type="radio" name="scope" checked={scope === 'mandate'} onChange={() => setScope('mandate')} />
              {t('env.copy_dialog.scope.mandate')}
            </label>
            {scope === 'mandate' && (
              <label className="env-field" htmlFor={mandateId}>
                <span className="env-field-label">{t('env.copy_dialog.scope.mandateLabel')}</span>
                <input
                  id={mandateId}
                  className="field"
                  value={mandate}
                  onChange={(e) => setMandate(e.target.value)}
                  placeholder={t('env.copy_dialog.scope.mandatePlaceholder')}
                  autoComplete="off"
                />
              </label>
            )}
          </fieldset>

          <fieldset className="env-field">
            <legend className="env-field-label">{t('env.copy_dialog.sanitize.label')}</legend>
            <label className="env-radio">
              <input type="radio" name="sanitize" checked={sanitize === 'pseudonymize'} onChange={() => setSanitize('pseudonymize')} />
              {t('env.copy_dialog.sanitize.pseudonymize')}
            </label>
            <label className="env-radio">
              <input type="radio" name="sanitize" checked={sanitize === 'structure_synthetic'} onChange={() => setSanitize('structure_synthetic')} />
              {t('env.copy_dialog.sanitize.structure_synthetic')}
            </label>
            <label className="env-radio">
              <input type="radio" name="sanitize" checked={sanitize === 'raw'} onChange={() => setSanitize('raw')} />
              {t('env.copy_dialog.sanitize.raw')}
            </label>
          </fieldset>

          {(rawNeedsName || canRetainSecrets) && (
            <details className="env-disclosure" open={showOverride} onToggle={(e) => setShowOverride((e.target as HTMLDetailsElement).open)}>
              <summary>{t('env.copy_dialog.override.summary')}</summary>
              {rawNeedsName && (
                <label className="env-field" htmlFor={confirmNameId}>
                  <span className="env-field-hint env-field-hint--warn">{t('env.copy_dialog.override.rawWarning')}</span>
                  <span className="env-field-label">{t('env.copy_dialog.override.confirmName')}</span>
                  <input
                    id={confirmNameId}
                    className="field"
                    value={confirmName}
                    onChange={(e) => setConfirmName(e.target.value)}
                    placeholder={t('env.copy_dialog.override.confirmNamePlaceholder', { name: target })}
                    autoComplete="off"
                  />
                </label>
              )}
              {canRetainSecrets && (
                <label className="env-checkbox">
                  <input type="checkbox" checked={retainSecrets} onChange={(e) => setRetainSecrets(e.target.checked)} />
                  <span>
                    {t('env.copy_dialog.override.retainSecrets')}
                    <span className="env-field-hint env-field-hint--warn">{t('env.copy_dialog.override.retainSecretsWarning')}</span>
                  </span>
                </label>
              )}
            </details>
          )}
        </div>
      )}

      {/* The four-phase journey (finding #12), visible whether the copy is pending, running or done. */}
      <ol className="env-phases" aria-label={t('env.copy_dialog.phases.label')} aria-busy={busy}>
        {PHASES.map((phase) => {
          const s = phaseState();
          return (
            <li key={phase} className={`env-phase env-phase--${s}`}>
              <span className="env-phase-dot" aria-hidden="true" />
              <span className="env-phase-name">{t(`env.copy_dialog.phases.${phase}`)}</span>
              <span className="env-phase-state">{t(`env.copy_dialog.phases.${s}`)}</span>
            </li>
          );
        })}
      </ol>

      {done !== null && (
        <p className="env-dialog-summary" role="status">
          {t('env.copy_dialog.summary', { workspaces: String(done.workspaces), masked: String(done.masked) })}
        </p>
      )}
    </Modal>
  );
}

export default CopyRefreshDialog;
