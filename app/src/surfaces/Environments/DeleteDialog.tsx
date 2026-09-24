/**
 * Delete dialog (D126 finding #4, matrix E9/E9a/E9b). Removes a named environment's data root and its
 * landscape entry. It confirms as an alertdialog and states plainly that it cannot be undone. The
 * engine refuses `main` always, a standard tier without force (E9a: use reset), and the active env
 * (E9b: switch away first); each refusal is shown inline here with its reason rather than hidden.
 */
import { useState } from 'react';

import { useClient } from '../../lib/client-context';
import { useWorkspaceId } from '../../app/workspace';
import { isErr } from '../../lib/client';
import { useT } from '../../i18n';
import { Modal } from '../../components/Modal';
import { envErrorMessage } from './errors';
import type { EnvironmentRow } from './model';

const ALERT_DIALOG = 'alertdialog' as const;

export function DeleteDialog({
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

  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function confirm() {
    setBusy(true);
    setError(null);
    const { body } = await client.call('env_delete', {
      workspaceId,
      name: env.name,
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
      title={t('env.delete_dialog.title', { name: env.name })}
      onClose={onClose}
      closeLabel={t('env.delete_dialog.cancel')}
      footer={
        <>
          <button type="button" className="btn btn--secondary btn--sm" onClick={onClose}>
            {t('env.delete_dialog.cancel')}
          </button>
          <button type="button" className="btn btn--danger" onClick={() => void confirm()} disabled={busy}>
            {t('env.delete_dialog.confirm')}
          </button>
        </>
      }
    >
      <p className="env-dialog-lead">{t('env.delete_dialog.lead', { name: env.name })}</p>

      {error !== null && (
        <p className="env-dialog-error" role="alert">
          {error}
        </p>
      )}

      <dl className="env-plan">
        <h3 className="env-plan-title">{t('env.delete_dialog.planTitle')}</h3>
        <div className="env-plan-row">
          <dt>{t('env.delete_dialog.dataRoot')}</dt>
          <dd className="env-mono">{env.dbPath}</dd>
        </div>
      </dl>
    </Modal>
  );
}

export default DeleteDialog;
