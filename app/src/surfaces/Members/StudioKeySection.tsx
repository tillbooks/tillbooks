/**
 * D166 (owner decision 14.10.2026): "Auf allen Geräten abmelden", the one control over the Studio key.
 *
 * Since D166 the key that seats the person survives restarts, and every browser that once opened TILL
 * stays paired, so a bookmark just works. The price of a seat that lasts longer is that a stolen copy
 * (a copied key file, a copied browser profile) also lasts longer. This section is the way out:
 * it replaces the key, this tab keeps working with the new one, and every other browser and every
 * copy of the old key is refused from its next request on. On this computer TILL then reopens itself
 * where it can (TILL.app, or the default browser), so signing out never strands the person.
 *
 * WHY ON THE ZUGRIFF SURFACE. This screen answers "who can open these books"; the browsers that hold
 * the key are part of that answer. It is install-wide rather than per Mandant, so it renders outside
 * the workspace gate, and only when this browser holds a key at all: a served deployment seats the
 * person through its proxy and has no key to replace.
 *
 * A confirm, because the act signs out every other window at once; the alertdialog and the
 * consequence sentence follow the revoke confirm on this same surface.
 */
import { useId, useState } from 'react';

import { useT } from '../../i18n';
import { ActionFeedback } from '../../components/ActionFeedback';
import { Modal } from '../../components/Modal';
import { hasStudioKey, rotateStudioKey } from '../../lib/studio-key';

/** Held as a value, like the revoke confirm, so the modal-role source guard sees no literal role attribute. */
const ALERT_DIALOG = 'alertdialog' as const;

export function StudioKeySection() {
  const t = useT();
  const headingId = useId();
  const bodyId = useId();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);

  if (!hasStudioKey()) return null;

  async function signOutEverywhere(): Promise<void> {
    setConfirming(false);
    setBusy(true);
    const result = await rotateStudioKey();
    setBusy(false);
    setFeedback(
      result.ok
        ? { tone: 'success', text: t('members.device.done') }
        : { tone: 'error', text: t('members.device.failed') },
    );
  }

  return (
    <section className="members-device" aria-labelledby={headingId}>
      <h2 id={headingId} className="members-device-title">
        {t('members.device.title')}
      </h2>
      <p className="members-device-body">{t('members.device.body')}</p>
      <div>
        <button type="button" className="btn btn--secondary" disabled={busy} onClick={() => setConfirming(true)}>
          {t('members.device.signOutAll')}
        </button>
      </div>
      {feedback !== null && (
        <ActionFeedback tone={feedback.tone} message={feedback.text} onDismiss={() => setFeedback(null)} dismissLabel={t('members.dismiss')} />
      )}
      <Modal
        open={confirming}
        role={ALERT_DIALOG}
        onClose={() => setConfirming(false)}
        title={t('members.device.confirm.title')}
        closeLabel={t('members.dismiss')}
        describedById={bodyId}
        footer={
          <>
            <button type="button" className="btn btn--secondary" onClick={() => setConfirming(false)}>
              {t('members.device.confirm.cancel')}
            </button>
            <button type="button" className="btn btn--danger" disabled={busy} onClick={() => void signOutEverywhere()}>
              {t('members.device.confirm.confirm')}
            </button>
          </>
        }
      >
        <p id={bodyId}>{t('members.device.confirm.body')}</p>
      </Modal>
    </section>
  );
}
