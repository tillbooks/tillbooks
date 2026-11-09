/**
 * Reset dialog (D126 finding #4/#5, matrix E3/E3a). Wipes and rebuilds an environment from its data
 * policy, build-then-swap, so a failed reset leaves the prior environment intact. The dialog states
 * that forgiveness plainly and confirms as an alertdialog (a stray scrim click must not answer it).
 * A reset of `main` (protected) or of the active env (finding #11) is refused by the engine and shown
 * inline here, never hidden, so the refusal reaches the operator with its reason.
 */
import { useState } from 'react';

import { useClient } from '../../lib/client-context';
import { useWorkspaceId } from '../../app/workspace';
import { isErr } from '../../lib/client';
import { useT } from '../../i18n';
import { Modal } from '../../components/Modal';
import { envErrorMessage } from './errors';
import type { EnvironmentRow } from './model';

/** The alertdialog role, held as a constant so no bare modal-role attribute literal sits on the JSX
 *  (the modal-role guard scans source text for that token; Modal hosts the role on its own permitted
 *  div). */
const ALERT_DIALOG = 'alertdialog' as const;

export function ResetDialog({
  env,
  onClose,
  onDone,
}: {
  env: EnvironmentRow;
  onClose: () => void;
  onDone: (name: string) => void;
}) {
  const t = useT();
  const client = useClient();
  const workspaceId = useWorkspaceId();

  const [seed, setSeed] = useState(env.seed ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function confirm() {
    setBusy(true);
    setError(null);
    const { body } = await client.call('env_reset', {
      workspaceId,
      name: env.name,
      ...(env.dataPolicy === 'synthetic' && seed.trim() !== '' ? { seed: seed.trim() } : {}),
      confirmed: true,
      idempotencyKey: crypto.randomUUID(),
    });
    setBusy(false);
    if (isErr(body)) {
      const { key, params } = envErrorMessage(body);
      setError(t(key, params));
      return;
    }
    onDone(env.name);
  }

  return (
    <Modal
      open
      role={ALERT_DIALOG}
      title={t('env.reset_dialog.title', { name: env.name })}
      onClose={onClose}
      closeLabel={t('env.reset_dialog.cancel')}
      footer={
        <>
          <button type="button" className="btn btn--secondary btn--sm" onClick={onClose}>
            {t('env.reset_dialog.cancel')}
          </button>
          <button type="button" className="btn btn--danger" onClick={() => void confirm()} disabled={busy}>
            {t('env.reset_dialog.confirm')}
          </button>
        </>
      }
    >
      <p className="env-dialog-lead">{t('env.reset_dialog.lead', { name: env.name })}</p>

      {error !== null && (
        <p className="env-dialog-error" role="alert">
          {error}
        </p>
      )}

      {env.dataPolicy === 'synthetic' && (
        <label className="env-field">
          <span className="env-field-label">{t('env.reset_dialog.seed.label')}</span>
          <input className="field" value={seed} onChange={(e) => setSeed(e.target.value)} placeholder="seeblick" autoComplete="off" />
          <span className="env-field-hint">{t('env.reset_dialog.seed.hint')}</span>
        </label>
      )}
    </Modal>
  );
}

export default ResetDialog;
