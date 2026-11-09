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
import { useCallback, useEffect, useId, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useInRouterContext } from 'react-router-dom';

import { formatDate, formatMoney, useT } from '../i18n';
import { isErr, type Err } from '../lib/client';
import { useOptionalClient } from '../lib/client-context';
import { useOptionalWorkspaceId } from '../app/workspace';
import {
  isBookAgainRefusal,
  isReceiptAssignedRefusal,
  isReplaceRefusal,
  parseAssignmentHolders,
  parseReceiptHolders,
  type AssignmentHolder,
  type BookAgainConfirmation,
  type ReceiptHolder,
} from '../lib/receiptHolders';
import { Modal } from './Modal';
import { firstInvalidOrField } from './useFocusTrap';
import './BookAgain.css';
import { Status } from './Status';
import { refusalText } from './states/refusalText';

/** The Modal's role prop for a consequential confirm (the host element is the Modal's own `div`). */
const ALERT_DIALOG = 'alertdialog' as const;

// A41.3 re-cut v3: `beleg_assignment`, a receipt an active assignment holds on a bank line.
// A41.3 r4 C1: `receipt_held`, the one marker a seat without the receipt read right gets for an assignment hold.
const HOLDER_KINDS = ['journal_entry', 'vendor_bill', 'expense_claim', 'bank_txn', 'payment', 'document', 'drafted_action', 'beleg_assignment', 'receipt_held'];
/** The holds by a bank line's receipt assignment (named or redacted): assigned, not booked. */
const ASSIGNMENT_KINDS: ReadonlySet<string> = new Set(['beleg_assignment', 'receipt_held']);

function useHolderLabel(): (holder: ReceiptHolder) => string {
  const t = useT();
  return (holder) => t(`files.bookAgain.kind.${HOLDER_KINDS.includes(holder.entityKind) ? holder.entityKind : 'other'}`);
}

/**
 * The card's warning: the receipt is already booked, and where. Nothing when nothing holds it. A41.3 v3: a hold
 * by a bank line's ASSIGNMENT (`beleg_assignment` with its `bankTxnId`) names that line and offers "Lösen"
 * (`release_beleg`, a person's act) right on the card; approving the Vorschlag stays the person's next click.
 */
export function ReceiptHolderNotice({ holders, className, onReleased }: { holders: readonly ReceiptHolder[]; className?: string; onReleased?: () => void }) {
  const t = useT();
  const label = useHolderLabel();
  if (holders.length === 0) return null;
  // An ASSIGNED receipt is not booked yet: the assignment kinds bypass "bereits gebucht" and say what they are.
  const booked = holders.filter((h) => !ASSIGNMENT_KINDS.has(h.entityKind));
  const assigned = holders.some((h) => ASSIGNMENT_KINDS.has(h.entityKind));
  const list = [...new Set(booked.map(label))].join(', ');
  const lines = holders.filter((h) => h.entityKind === 'beleg_assignment' && h.bankTxnId !== undefined);
  return (
    <>
      {booked.length > 0 && <Status kind="warn" label={t('files.bookAgain.notice', { list })} {...(className !== undefined ? { className } : {})} />}
      {assigned && <Status kind="warn" label={t('files.bookAgain.assignedNotice')} {...(className !== undefined ? { className } : {})} />}
      {lines.length > 0 && (
        <ul className="book-again-holders">
          {lines.map((h) => (
            <CardHolderLine key={h.bankTxnId} holder={{ bankTxnId: h.bankTxnId as string, assignmentId: h.entityId, source: h.source ?? null }} {...(onReleased !== undefined ? { onReleased } : {})} />
          ))}
        </ul>
      )}
    </>
  );
}

/** One assignment hold on a card: the line in words, its link, and "Lösen" while it holds the receipt. */
function CardHolderLine({ holder, onReleased }: { holder: AssignmentHolder; onReleased?: () => void }) {
  const t = useT();
  const client = useOptionalClient();
  const workspaceId = useOptionalWorkspaceId();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<Err | null>(null);
  const release = async () => {
    if (client === null || workspaceId === null) return;
    setBusy(true);
    setError(null);
    const { body } = await client.call('release_beleg', { workspaceId, bankTxnId: holder.bankTxnId, idempotencyKey: crypto.randomUUID() });
    setBusy(false);
    if (isErr(body)) {
      setError(body);
      return;
    }
    setDone(true);
    onReleased?.();
  };
  return (
    <>
      <HolderLine holder={holder} />
      {done ? (
        <li role="status">{t('files.bookAgain.assigned.released')}</li>
      ) : client !== null && workspaceId !== null ? (
        <li>
          <button type="button" className="btn btn--secondary btn--sm" disabled={busy} onClick={() => void release()}>
            {busy ? t('files.bookAgain.working') : t('files.bookAgain.assigned.release')}
          </button>
          {error !== null && (
            <span className="book-again-error" role="alert">
              {refusalText(t, error, { own: 'files.bookAgain.error' })}
            </span>
          )}
        </li>
      ) : null}
    </>
  );
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

/**
 * A41.3 re-cut v3: the receipt is ASSIGNED to a bank line (`receipt_assigned`, under `belege.assigned_move =
 * refuse`). The dialog names each line that holds it (its date, counterparty and amount, read once), offers ONE
 * click "Lösen" (`release_beleg` on each, a person's act), and only then "Nochmals" sends the refused act again.
 * Nothing is retried on its own.
 */
function HolderLine({ holder }: { holder: AssignmentHolder }) {
  const t = useT();
  const client = useOptionalClient();
  const workspaceId = useOptionalWorkspaceId();
  const inRouter = useInRouterContext();
  const [words, setWords] = useState<string | null>(null);
  useEffect(() => {
    if (workspaceId === null || client === null) return undefined;
    let live = true;
    void client.call('list_bank_inbox', { workspaceId, bankTxnId: holder.bankTxnId, status: 'all', limit: 1 }).then(({ body }) => {
      if (!live || isErr(body)) return;
      const line = ((body as unknown as { lines?: unknown[] }).lines ?? [])[0] as
        | { bookingDate?: unknown; amountMinor?: unknown; currency?: unknown; counterparty?: { name?: unknown } }
        | undefined;
      if (line === undefined) return;
      const date = typeof line.bookingDate === 'string' ? formatDate(line.bookingDate.slice(0, 10)) : '';
      const party = typeof line.counterparty?.name === 'string' ? line.counterparty.name : '';
      const amount = typeof line.amountMinor === 'number' && typeof line.currency === 'string' ? formatMoney(line.amountMinor, line.currency) : '';
      setWords(t('files.bookAgain.assigned.line', { date, party, amount }));
    });
    return () => {
      live = false;
    };
  }, [client, workspaceId, holder.bankTxnId, t]);
  const href = `/bank?line=${encodeURIComponent(holder.bankTxnId)}`;
  const by = holder.source === 'person' ? t('files.bookAgain.assigned.byPerson') : holder.source === 'engine_unique' ? t('files.bookAgain.assigned.byTill') : '';
  return (
    <li>
      <span>{words ?? t('files.bookAgain.assigned.lineUnknown')}</span>
      {by !== '' && <span className="book-again-id">{by}</span>}{' '}
      {inRouter ? <Link to={href}>{t('files.bookAgain.assigned.open')}</Link> : <a href={href}>{t('files.bookAgain.assigned.open')}</a>}
    </li>
  );
}

export interface AssignedDialogProps {
  open: boolean;
  /** The host can call the engine (a provider and a workspace); else only the line's link is offered. */
  canRelease?: boolean;
  holders: readonly AssignmentHolder[];
  /** Released on every holder: "Nochmals" is offered. */
  released: boolean;
  error: Err | null;
  busy: boolean;
  onRelease: () => void;
  onAgain: () => void;
  onCancel: () => void;
}

export function AssignedDialog({ open, canRelease = true, holders, released, error, busy, onRelease, onAgain, onCancel }: AssignedDialogProps) {
  const t = useT();
  const id = useId();
  // A41.3 r4 C1: a redacted refusal names no line (the seat may not read receipts): said, never released here.
  const releasable = canRelease && holders.length > 0;
  return (
    <Modal
      open={open}
      onClose={onCancel}
      role={ALERT_DIALOG}
      title={t('files.bookAgain.assigned.title')}
      closeLabel={t('files.bookAgain.close')}
      describedById={`${id}-lead`}
      footer={
        <>
          <button type="button" className="btn btn--secondary" onClick={onCancel}>
            {t('files.bookAgain.cancel')}
          </button>
          {released ? (
            <button type="button" className="btn btn--primary" disabled={busy} onClick={onAgain}>
              {busy ? t('files.bookAgain.working') : t('files.bookAgain.assigned.again')}
            </button>
          ) : !releasable ? null : (
            <button type="button" className="btn btn--primary" disabled={busy} onClick={onRelease}>
              {busy ? t('files.bookAgain.working') : t('files.bookAgain.assigned.release')}
            </button>
          )}
        </>
      }
    >
      <div className="book-again-form">
        <p id={`${id}-lead`}>{t('files.bookAgain.assigned.lead')}</p>
        <ul className="book-again-holders">
          {holders.length === 0 ? (
            <li>{t('files.bookAgain.kind.receipt_held')}</li>
          ) : (
            holders.map((h) => <HolderLine key={h.bankTxnId} holder={h} />)
          )}
        </ul>
        <p role="status">
          {released ? t('files.bookAgain.assigned.released') : holders.length === 0 ? t('files.bookAgain.assigned.hiddenHint') : t('files.bookAgain.assigned.question')}
        </p>
        {error !== null && (
          <p className="book-again-error" role="alert">
            {refusalText(t, error, { own: 'files.bookAgain.error' })}
          </p>
        )}
      </div>
    </Modal>
  );
}

/**
 * A retry of the refused call: with the person's confirmation after a reason, or with none after "Lösen" (the
 * same call again). Resolves to its refusal, or null.
 */
export type BookAgainRetry = (confirmation?: BookAgainConfirmation) => Promise<Err | null>;

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
  const client = useOptionalClient();
  const workspaceId = useOptionalWorkspaceId();
  const [pending, setPending] = useState<{ holders: ReceiptHolder[]; replace: boolean; retry: BookAgainRetry; seq: number } | null>(null);
  // A41.3 re-cut v3: a receipt assigned to a bank line (`receipt_assigned`): Lösen, then the act again.
  const [assigned, setAssigned] = useState<{ holders: AssignmentHolder[]; retry: BookAgainRetry; released: boolean; seq: number } | null>(null);
  const [error, setError] = useState<Err | null>(null);
  const [busy, setBusy] = useState(false);

  const ask = useCallback((refusal: Err, retry: BookAgainRetry): boolean => {
    if (isReceiptAssignedRefusal(refusal)) {
      setError(null);
      setAssigned((current) => ({ holders: parseAssignmentHolders(refusal.holders), retry, released: false, seq: (current?.seq ?? 0) + 1 }));
      return true;
    }
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

  /** "Lösen": the person releases the receipt on every line that holds it (`release_beleg`). */
  const release = useCallback(async () => {
    if (assigned === null || workspaceId === null || client === null) return;
    setBusy(true);
    setError(null);
    for (const h of assigned.holders) {
      const { body } = await client.call('release_beleg', { workspaceId, bankTxnId: h.bankTxnId, idempotencyKey: crypto.randomUUID() });
      if (isErr(body)) {
        setBusy(false);
        setError(body);
        return;
      }
    }
    setBusy(false);
    setAssigned((a) => (a === null ? a : { ...a, released: true }));
  }, [assigned, client, workspaceId]);

  /** "Nochmals": the refused act once more, on the person's click; a reason-refusal then asks for its reason. */
  const again = useCallback(async () => {
    if (assigned === null) return;
    setBusy(true);
    const refused = await assigned.retry();
    setBusy(false);
    if (refused === null) {
      setAssigned(null);
      setError(null);
      onBooked?.();
      return;
    }
    if (isBookAgainRefusal(refused) || isReceiptAssignedRefusal(refused)) {
      const retry = assigned.retry;
      setAssigned(null);
      ask(refused, retry);
      return;
    }
    setError(refused);
  }, [assigned, ask, onBooked]);

  const dialog = (
    <>
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
      <AssignedDialog
        key={`assigned-${assigned?.seq ?? 0}`}
        canRelease={client !== null && workspaceId !== null}
        open={assigned !== null}
        holders={assigned?.holders ?? []}
        released={assigned?.released ?? false}
        error={assigned !== null ? error : null}
        busy={busy}
        onRelease={() => void release()}
        onAgain={() => void again()}
        onCancel={() => {
          setAssigned(null);
          setError(null);
        }}
      />
    </>
  );
  return { ask, dialog };
}
