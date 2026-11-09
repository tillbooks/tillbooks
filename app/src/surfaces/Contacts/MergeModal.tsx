/**
 * MergeModal, C00's survivor picker for a duplicate merge (spec C00 §6, US-C00.4).
 *
 * Two selected rows arrive here. The operator picks which one SURVIVES, sees the field-level diff
 * between them, and confirms. The confirm copy says the merge cannot be undone, because it cannot:
 * `merged_into_id` is one-way, and a wrong merge is repaired by creating a fresh contact rather than
 * by an un-merge. The surviving row is the confirmation; there is no toast.
 *
 * A merge has ZERO financial effect (no posting, posted-document snapshots untouched), so nothing
 * here warns about the books: saying it might touch money would be false and would teach the
 * operator to distrust the warnings that are real.
 */
import { useState } from 'react';

import { useClient } from '../../lib/client-context';
import { isErr } from '../../lib/client';
import { useT } from '../../i18n';
import { Modal } from '../../components/Modal';
import { ErrorBanner } from '../../components/states';
import type { Err } from '../../lib/client';
import { addressOf, idemKey, kindOf, type Contact } from './model';

export interface MergeModalProps {
  /** Exactly the two contacts the operator selected on the list. */
  pair: readonly [Contact, Contact];
  workspaceId: string;
  onClose: () => void;
  onMerged: () => void;
}

export function MergeModal({ pair, workspaceId, onClose, onMerged }: MergeModalProps) {
  const t = useT();
  const client = useClient();
  const [survivorId, setSurvivorId] = useState(pair[0].id);
  const [error, setError] = useState<Err | null>(null);
  const [saving, setSaving] = useState(false);

  const survivor = pair.find((c) => c.id === survivorId) as Contact;
  const source = pair.find((c) => c.id !== survivorId) as Contact;

  async function merge() {
    setSaving(true);
    setError(null);
    const resp = await client.call('contacts_merge', {
      workspaceId,
      sourceId: source.id,
      targetId: survivor.id,
      idempotencyKey: idemKey('merge'),
    });
    setSaving(false);
    if (isErr(resp.body)) {
      setError(resp.body);
      return;
    }
    onMerged();
    onClose();
  }

  const footer = (
    <>
      <button type="button" className="btn btn--secondary" onClick={onClose}>
        {t('contact.cancel')}
      </button>
      <button type="button" className="btn btn--primary" disabled={saving} onClick={() => void merge()}>
        {t('contact.merge.action')}
      </button>
    </>
  );

  return (
    <Modal
      open
      onClose={onClose}
      title={t('contact.action.merge')}
      closeLabel={t('contact.close')}
      footer={footer}
    >
      <div className="ct-merge-body">
        {error !== null && <ErrorBanner error={error} />}

        <fieldset className="ct-fieldset">
            <legend className="ct-field-label">{t('contact.merge.survivor')}</legend>
            {pair.map((c) => (
              <label key={c.id} className="ct-radio">
                <input
                  type="radio"
                  name="ct-survivor"
                  value={c.id}
                  checked={survivorId === c.id}
                  onChange={() => setSurvivorId(c.id)}
                />
                <span>{c.name}</span>
              </label>
            ))}
          </fieldset>

          {/* The field diff: what the survivor keeps, beside what the tombstone held. Rendered as a
              real table so a screen reader announces the pairing rather than two loose columns. */}
          <div className="scroll">
            <table className="ct-diff">
              <caption className="visually-hidden">{t('contact.merge.diffCaption')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('contact.merge.field')}</th>
                  <th scope="col">{t('contact.merge.keeps')}</th>
                  <th scope="col">{t('contact.merge.discards')}</th>
                </tr>
              </thead>
              <tbody>
                {diffRows(survivor, source, t).map((row) => (
                  <tr key={row.label}>
                    <th scope="row">{row.label}</th>
                    <td>{row.keeps}</td>
                    <td className="ct-diff-old">{row.discards}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="ct-confirm-text">
            {t('contact.merge.confirm', { source: source.name, target: survivor.name })}
          </p>
      </div>
    </Modal>
  );
}

/** The comparable facts, as label plus the two values. A blank value renders as a dash, not "null". */
function diffRows(survivor: Contact, source: Contact, t: (k: string, v?: Record<string, string>) => string) {
  const a = addressOf(survivor as unknown as Record<string, unknown>);
  const b = addressOf(source as unknown as Record<string, unknown>);
  const dash = '–';
  const show = (v: string | null | undefined) => (v == null || v === '' ? dash : v);
  return [
    { label: t('contact.name'), keeps: show(survivor.name), discards: show(source.name) },
    {
      label: t('contact.kindLabel'),
      keeps: t(`contact.kind.${kindOf(survivor)}`),
      discards: t(`contact.kind.${kindOf(source)}`),
    },
    { label: t('contact.vatNumber'), keeps: show(survivor.vatNumber), discards: show(source.vatNumber) },
    { label: t('contact.email'), keeps: show(survivor.email), discards: show(source.email) },
    { label: t('contact.city'), keeps: show(a.city), discards: show(b.city) },
  ];
}
