/**
 * N02 (D183), R1 RECEIPT UNIQUENESS in the Studio: one receipt evidences at most one live booking unless a
 * person confirms a second with a reason (`src/core/files/receiptGuard.ts`).
 *
 *  - `ReceiptHolderNotice`: the warning on a Vorschlag's card, "Dieser Beleg ist bereits gebucht (...)",
 *    from the holders the engine stored on it (`receiptHolders` in `list_drafted_actions`). The approval
 *    is judged against exactly that list.
 *  - `BookAgainDialog` + `useBookAgain`: when a call answers `receipt_already_booked` with an `override`
 *    hint (the setting is `confirm`), the person is asked for the reason, and the SAME call is sent again
 *    with `bookAgain: true` and `overrideReason`. Used by the direct attach paths (Bank, Journal, Files),
 *    the drop page and the approval of a Vorschlag. A refusal under `refuse` carries no hint: it is
 *    shown as a refusal, never as a question.
 *
 * The dialog is an alertdialog (a consequential confirm): it does not close on a scrim click, it stays
 * open with the reason intact when the retry is refused, and its commit is the primary button, never the
 * accent (the accent belongs to the posting click itself).
 */
import { useCallback, useId, useState, type FormEvent, type ReactNode } from 'react';

import { useT } from '../i18n';
import type { Err } from '../lib/client';
import { isBookAgainRefusal, isReplaceRefusal, parseReceiptHolders, type BookAgainConfirmation, type ReceiptHolder } from '../lib/receiptHolders';
import { Modal } from './Modal';
import { firstInvalidOrField } from './useFocusTrap';
import './BookAgain.css';
import { Status } from './Status';
import { refusalText } from './states/refusalText';

/** The Modal's role prop for a consequential confirm (the host element is the Modal's own `div`). */
const ALERT_DIALOG = 'alertdialog' as const;

const HOLDER_KINDS = ['journal_entry', 'vendor_bill', 'expense_claim', 'bank_txn', 'payment', 'document', 'drafted_action'];

function useHolderLabel(): (holder: ReceiptHolder) => string {
  const t = useT();
  return (holder) => t(`files.bookAgain.kind.${HOLDER_KINDS.includes(holder.entityKind) ? holder.entityKind : 'other'}`);
}

/** The card's warning: the receipt is already booked, and where. Nothing when nothing holds it. */
export function ReceiptHolderNotice({ holders, className }: { holders: readonly ReceiptHolder[]; className?: string }) {
  const t = useT();
  const label = useHolderLabel();
  if (holders.length === 0) return null;
  const list = [...new Set(holders.map(label))].join(', ');
  return <Status kind="warn" label={t('files.bookAgain.notice', { list })} {...(className !== undefined ? { className } : {})} />;
}

export interface BookAgainDialogProps {
  open: boolean;
  /** A new version replacing a booked receipt (its own wording), not a second booking. */
  replace?: boolean;
  holders: readonly ReceiptHolder[];
  /** The retried call's refusal, shown under the field; the dialog stays open with the reason intact. */
  error: Err | null;
  busy: boolean;
  onConfirm: (reason: string) => void;
  onCancel: () => void;
}

export function BookAgainDialog({ open, replace = false, holders, error, busy, onConfirm, onCancel }: BookAgainDialogProps) {
  const words = replace ? 'files.bookAgain.replace' : 'files.bookAgain';
  const t = useT();
  const label = useHolderLabel();
  const id = useId();
  const [reason, setReason] = useState('');
  const [missing, setMissing] = useState(false);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (reason.trim() === '') {
      setMissing(true);
      return;
    }
    setMissing(false);
    onConfirm(reason.trim());
  };

  return (
    <Modal
      open={open}
      onClose={onCancel}
      role={ALERT_DIALOG}
      title={t(`${words}.title`)}
      closeLabel={t('files.bookAgain.close')}
      describedById={`${id}-lead`}
      initialFocus={firstInvalidOrField}
      footer={
        <>
          <button type="button" className="btn btn--secondary" onClick={onCancel}>
            {t('files.bookAgain.cancel')}
          </button>
          <button type="submit" form={`${id}-form`} className="btn btn--primary" disabled={busy}>
            {busy ? t('files.bookAgain.working') : t(`${words}.confirm`)}
          </button>
        </>
      }
    >
      <form id={`${id}-form`} onSubmit={submit} className="book-again-form">
        <p id={`${id}-lead`}>{t(`${words}.lead`)}</p>
        <ul className="book-again-holders">
          {holders.map((holder, index) => (
            <li key={`${holder.entityKind}:${holder.entityId ?? index}`}>
              {label(holder)}
              {holder.entityId !== null && <span className="book-again-id">{holder.entityId}</span>}
            </li>
          ))}
        </ul>
        <p>{t(`${words}.question`)}</p>
        <label htmlFor={`${id}-reason`}>{t('files.bookAgain.reasonLabel')}</label>
        <textarea
          id={`${id}-reason`}
          className="field"
          rows={2}
          value={reason}
          aria-invalid={missing ? 'true' : undefined}
          aria-describedby={missing ? `${id}-missing` : undefined}
          onChange={(event) => setReason(event.target.value)}
        />
        {missing && (
          <p id={`${id}-missing`} className="book-again-error" role="alert">
            {t('files.bookAgain.error.reason_required')}
          </p>
        )}
        {error !== null && (
          <p className="book-again-error" role="alert">
            {refusalText(t, error, { own: 'files.bookAgain.error' })}
          </p>
        )}
      </form>
    </Modal>
  );
}

/** A retry of the refused call with the person's confirmation: resolves to its refusal, or null. */
export type BookAgainRetry = (confirmation: BookAgainConfirmation) => Promise<Err | null>;

export interface BookAgain {
  /**
   * Offer the confirmation for a refusal. Answers true when the refusal is one a person may answer (the
   * dialog is then open), false otherwise (the caller shows the refusal as it would any other).
   */
  ask: (refusal: Err, retry: BookAgainRetry) => boolean;
  /** Mount once in the surface. */
  dialog: ReactNode;
}

/** The confirm flow around one refused call (see the module note). */
export function useBookAgain(onBooked?: () => void): BookAgain {
  const [pending, setPending] = useState<{ holders: ReceiptHolder[]; replace: boolean; retry: BookAgainRetry; seq: number } | null>(null);
  const [error, setError] = useState<Err | null>(null);
  const [busy, setBusy] = useState(false);

  const ask = useCallback((refusal: Err, retry: BookAgainRetry): boolean => {
    if (!isBookAgainRefusal(refusal)) return false;
    setError(null);
    const replace = isReplaceRefusal(refusal);
    // A replacement names the record whose receipt it replaces first, then any holder of the new bytes.
    const own = replace ? parseReceiptHolders([{ entityKind: refusal.entityKind, entityId: refusal.entityId }]) : [];
    setPending((current) => ({ holders: [...own, ...parseReceiptHolders(refusal.holders)], replace, retry, seq: (current?.seq ?? 0) + 1 }));
    return true;
  }, []);

  const confirm = useCallback(
    async (reason: string) => {
      if (pending === null) return;
      setBusy(true);
      const refused = await pending.retry({ bookAgain: true, overrideReason: reason });
      setBusy(false);
      if (refused === null) {
        setPending(null);
        setError(null);
        onBooked?.();
        return;
      }
      setError(refused);
    },
    [onBooked, pending],
  );

  const dialog = (
    <BookAgainDialog
      key={`book-again-${pending?.seq ?? 0}`}
      open={pending !== null}
      holders={pending?.holders ?? []}
      replace={pending?.replace ?? false}
      error={error}
      busy={busy}
      onConfirm={(reason) => void confirm(reason)}
      onCancel={() => {
        setPending(null);
        setError(null);
      }}
    />
  );
  return { ask, dialog };
}
