/**
 * N02 (D183), the drop page (`/drop/:token`): one receipt onto one booking, from a link an agent minted
 * for a chat client that cannot hand TILL a file by path (Claude Desktop).
 *
 * NO RAIL, ONE JOB. The page sits outside the Shell like `/w/:id`: the person arrived from a chat to do
 * exactly one thing, so it names the target ("Beleg für Buchung 0142, Bürobedarf, CHF 84.50"), offers a
 * large drop area with "Datei wählen" (dropping is never the only way, WCAG 2.5.7), and answers in text.
 * The one primary action is the pick itself, so no button here carries the accent besides it.
 *
 * EVERY STATE THE SPEC NAMES: loading, unpaired browser (no Studio session: open TILL or copy the link),
 * ready, uploading, done (thumbnail + "Zur Buchung"), expired, used, unknown, wrong type, duplicate,
 * failed (retry), permission denied. Status is text in an `aria-live` region, never colour alone.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import { useT, formatMoney, formatDate } from '../../i18n';
import { FileDrop } from '../../components/FileDrop';
import { STUDIO_REOPEN_HEADER, STUDIO_REOPEN_PATH } from '../../lib/studio-key';
import { fileToBase64, redeemDrop, resolveDrop, type DropDone, type DropLink, type DropTarget } from './dropApi';
import { useBookAgain } from '../../components/BookAgain';
import { parseReceiptHolders } from '../../lib/receiptHolders';
import type { Err } from '../../lib/client';
import './Drop.css';

/** The holders the page words (`drop.holder.*`). */
const HOLDER_KINDS = ['journal_entry', 'vendor_bill', 'bank_txn', 'expense_claim', 'document', 'payment', 'drafted_action'];

/** The types the engine reads (`SOURCE_PATH_TYPES` in `src/core/files/sourcePath.ts`). */
export const DROP_ACCEPT = '.pdf,.jpg,.jpeg,.png,.heic,.webp,application/pdf,image/jpeg,image/png,image/heic,image/webp';

/** The largest file the engine takes (`MAX_FILE_BYTES`, 25 MiB): refused here before a byte is sent. */
export const DROP_MAX_BYTES = 25 * 1024 * 1024;

type View =
  | { kind: 'loading' }
  | { kind: 'unpaired' }
  | { kind: 'unknown' }
  | { kind: 'expired'; link: DropLink | null }
  | { kind: 'used'; link: DropLink | null }
  | { kind: 'denied' }
  | { kind: 'ready'; link: DropLink; problem: 'wrong_type' | 'too_large' | 'failed' | 'duplicate' | null; detail?: string }
  | { kind: 'uploading'; link: DropLink; filename: string }
  | { kind: 'done'; link: DropLink; done: DropDone; preview: string | null }
  | { kind: 'transport' };

function targetLabel(t: ReturnType<typeof useT>, target: DropTarget): string {
  const parts: string[] = [];
  const kindLabel = t(`drop.kind.${target.kind}`);
  parts.push(target.number !== null ? `${kindLabel} ${target.number}` : kindLabel);
  if (target.text !== null && target.text.length > 0) parts.push(target.text);
  if (target.amountMinor !== null) parts.push(formatMoney(Math.abs(target.amountMinor), target.currency ?? 'CHF'));
  if (target.date !== null) parts.push(formatDate(target.date));
  return parts.join(', ');
}

export function Drop() {
  const t = useT();
  const { token = '' } = useParams<{ token: string }>();
  const [view, setView] = useState<View>({ kind: 'loading' });
  const [copied, setCopied] = useState(false);
  const { ask: askBookAgain, dialog: bookAgainDialog } = useBookAgain();
  const previewUrl = useRef<string | null>(null);

  const load = useCallback(async () => {
    setView({ kind: 'loading' });
    const answer = await resolveDrop(token);
    if (answer.kind === 'unpaired') return setView({ kind: 'unpaired' });
    if (answer.kind === 'transport') return setView({ kind: 'transport' });
    if (answer.kind === 'refused') {
      if (answer.error === 'drop_link_unknown') return setView({ kind: 'unknown' });
      if (answer.error === 'permission_denied') return setView({ kind: 'denied' });
      return setView({ kind: 'transport' });
    }
    const link = answer.value;
    if (link.state === 'expired') return setView({ kind: 'expired', link });
    if (link.state === 'used') return setView({ kind: 'used', link });
    setView({ kind: 'ready', link, problem: null });
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(
    () => () => {
      if (previewUrl.current !== null) URL.revokeObjectURL(previewUrl.current);
    },
    [],
  );

  const upload = useCallback(
    async (link: DropLink, file: File) => {
      if (file.size > DROP_MAX_BYTES) return setView({ kind: 'ready', link, problem: 'too_large' });
      setView({ kind: 'uploading', link, filename: file.name });
      let base64: string;
      try {
        base64 = await fileToBase64(file);
      } catch {
        return setView({ kind: 'ready', link, problem: 'failed' });
      }
      const answer = await redeemDrop(token, base64, file.name);
      const finish = (done: DropDone) => {
        let preview: string | null = null;
        if (done.mime.startsWith('image/') && done.mime !== 'image/heic' && typeof URL.createObjectURL === 'function') {
          preview = URL.createObjectURL(file);
          previewUrl.current = preview;
        }
        setView({ kind: 'done', link, done, preview });
      };
      if (answer.kind === 'ok') return finish(answer.value);
      if (answer.kind === 'unpaired') return setView({ kind: 'unpaired' });
      if (answer.kind === 'transport') return setView({ kind: 'ready', link, problem: 'failed' });
      switch (answer.error) {
        case 'unsupported_type':
          return setView({ kind: 'ready', link, problem: 'wrong_type' });
        case 'file_too_large':
        case 'request_body_too_large':
          return setView({ kind: 'ready', link, problem: 'too_large' });
        case 'receipt_already_booked': {
          // N02 R1: the receipt is already booked elsewhere. Under `confirm` the person gives the reason
          // and the same drop is sent again with it; under `refuse` it is said and nothing is attached.
          const refusal = answer.body as unknown as Err;
          const asked = askBookAgain(refusal, async (confirmation) => {
            const again = await redeemDrop(token, base64, file.name, confirmation);
            if (again.kind === 'ok') {
              finish(again.value);
              return null;
            }
            return again.kind === 'refused' ? (again.body as unknown as Err) : { ok: false, error: 'transport' };
          });
          if (asked) return setView({ kind: 'ready', link, problem: null });
          const kind = parseReceiptHolders(refusal.holders)[0]?.entityKind;
          return setView({ kind: 'ready', link, problem: 'duplicate', detail: kind !== undefined && HOLDER_KINDS.includes(kind) ? t(`drop.holder.${kind}`) : undefined });
        }
        case 'drop_link_used':
          return setView({ kind: 'used', link });
        case 'drop_link_expired':
          return setView({ kind: 'expired', link });
        case 'permission_denied':
          return setView({ kind: 'denied' });
        default:
          return setView({ kind: 'ready', link, problem: 'failed' });
      }
    },
    [askBookAgain, t, token],
  );

  const reopen = useCallback(async () => {
    try {
      await fetch(STUDIO_REOPEN_PATH, { method: 'POST', headers: { [STUDIO_REOPEN_HEADER]: '1' } });
    } catch {
      // The notice below already says what to do by hand.
    }
  }, []);

  const copyLink = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }, []);

  const heading = useMemo(() => {
    if (view.kind === 'ready' || view.kind === 'uploading' || view.kind === 'done') return targetLabel(t, view.link.target);
    return t('drop.title');
  }, [t, view]);

  return (
    <main className="drop" aria-labelledby="drop-title">
      {bookAgainDialog}
      <p className="drop-eyebrow">{t('drop.eyebrow')}</p>
      <h1 id="drop-title" className="drop-title">
        {heading}
      </h1>
      <div className="drop-body" aria-live="polite">
        {view.kind === 'loading' ? <p className="drop-lead">{t('drop.loading')}</p> : null}

        {view.kind === 'unpaired' ? (
          <section className="drop-panel" data-state="unpaired">
            <h2 className="drop-h2">{t('drop.unpaired.title')}</h2>
            <p className="drop-lead">{t('drop.unpaired.body')}</p>
            <div className="drop-actions">
              <button type="button" className="btn btn--secondary" onClick={() => void reopen()}>
                {t('drop.unpaired.open')}
              </button>
              <button type="button" className="btn btn--ghost" onClick={() => void copyLink()}>
                {copied ? t('drop.unpaired.copied') : t('drop.unpaired.copy')}
              </button>
            </div>
          </section>
        ) : null}

        {view.kind === 'unknown' ? (
          <section className="drop-panel" data-state="unknown">
            <h2 className="drop-h2">{t('drop.unknown.title')}</h2>
            <p className="drop-lead">{t('drop.fresh')}</p>
          </section>
        ) : null}

        {view.kind === 'expired' || view.kind === 'used' ? (
          <section className="drop-panel" data-state={view.kind}>
            <h2 className="drop-h2">{t(view.kind === 'expired' ? 'drop.expired.title' : 'drop.used.title')}</h2>
            <p className="drop-lead">{t(view.kind === 'expired' ? 'drop.fresh' : 'drop.used.body')}</p>
            {view.link !== null ? (
              <Link className="btn btn--secondary" to={view.link.target.route}>
                {t(view.link.target.kind === 'drafted_action' ? 'drop.done.toProposals' : 'drop.done.toTarget')}
              </Link>
            ) : null}
          </section>
        ) : null}

        {view.kind === 'denied' ? (
          <section className="drop-panel" data-state="denied">
            <h2 className="drop-h2">{t('drop.denied.title')}</h2>
            <p className="drop-lead">{t('drop.denied.body')}</p>
          </section>
        ) : null}

        {view.kind === 'transport' ? (
          <section className="drop-panel" data-state="transport">
            <h2 className="drop-h2">{t('drop.transport.title')}</h2>
            <p className="drop-lead">{t('drop.transport.body')}</p>
            <button type="button" className="btn btn--secondary" onClick={() => void load()}>
              {t('drop.retry')}
            </button>
          </section>
        ) : null}

        {view.kind === 'ready' ? (
          <section className="drop-panel" data-state="ready">
            <p className="drop-lead">
              {t(view.link.target.kind === 'drafted_action' ? 'drop.ready.leadProposal' : 'drop.ready.lead')}
            </p>
            {view.problem !== null ? (
              <p className="drop-problem" role="alert">
                {view.problem === 'duplicate'
                  ? view.detail === undefined
                    ? t('drop.problem.duplicate')
                    : t('drop.problem.duplicateAt', { holder: view.detail })
                  : t(`drop.problem.${view.problem}`)}
              </p>
            ) : null}
            <FileDrop
              className="drop-zone"
              accept={DROP_ACCEPT}
              prompt={t('drop.ready.prompt')}
              hint={t('drop.ready.hint')}
              onFiles={(files) => {
                const file = files[0];
                if (file !== undefined) void upload(view.link, file);
              }}
              onReject={() => setView({ kind: 'ready', link: view.link, problem: 'wrong_type' })}
            />
          </section>
        ) : null}

        {view.kind === 'uploading' ? (
          <section className="drop-panel" data-state="uploading">
            <p className="drop-lead">{t('drop.uploading', { name: view.filename })}</p>
            <progress className="drop-progress" aria-label={t('drop.uploadingLabel')} />
          </section>
        ) : null}

        {view.kind === 'done' ? (
          <section className="drop-panel" data-state="done">
            <h2 className="drop-h2">
              {view.done.pending ? t('drop.done.titleProposal') : t('drop.done.title', { target: targetLabel(t, view.done.target) })}
            </h2>
            {view.preview !== null ? <img className="drop-thumb" src={view.preview} alt={view.done.filename} /> : <p className="drop-file">{view.done.filename}</p>}
            {view.done.pending ? <p className="drop-lead">{t('drop.done.pending')}</p> : null}
            {view.done.duplicate ? <p className="drop-lead">{t('drop.done.duplicate')}</p> : null}
            <Link className="btn btn--secondary" to={view.done.target.route}>
              {t(view.done.pending ? 'drop.done.toProposals' : 'drop.done.toTarget')}
            </Link>
          </section>
        ) : null}
      </div>
    </main>
  );
}
