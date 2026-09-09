/**
 * S3's QR payment-part panel and S8's PDF viewer overlay: the two artifacts an issued invoice has and
 * a draft does not.
 *
 * Both read the engine's own output and display it. Neither builds anything: `buildQrBill` produces
 * the Swiss Payments Code and `renderInvoicePdf` produces the artifact, both inside the engine, and
 * the payload the panel shows is byte-for-byte the payload the PDF embeds (pinned by the root drift
 * guard). A client-side reference or amount would be a second source of truth on the money path.
 *
 * The gap this panel used to state on screen is closed: the scannable QR GRAPHIC is drawn. It was
 * left undrawn while no verified encoder existed, because an unscannable or wrong code on an invoice
 * is a money-path defect and a placeholder that merely LOOKS like a QR would have been exactly the
 * data dishonesty this slice refuses everywhere else. There is a verified encoder now, and
 * `test/sales/qr-wiring-decode.test.mjs` decodes the rendered symbol with an independent reader and
 * holds the amount inside it against the posted journal rows.
 *
 * The panel renders the symbol from the payload the engine sent, using the same renderer the PDF
 * draws with, so the code on screen and the code on the artifact are one symbol. Still not claimed:
 * SIX certification, which is a process with SIX and not a property of any file here.
 */
import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import { useClient } from '../../lib/client-context';
import { isErr } from '../../lib/client';
import { useWorkspaceId } from '../../app/workspace';
import { useT, formatDate, formatMoney } from '../../i18n';
import { Skeleton } from '../../components/states';
import { Modal } from '../../components/Modal';
import { CopyButton } from '../../components/CopyButton';
import { HelpHint } from '../../components/HelpHint';
import {
  formatQrReference,
  invoiceErrorKey,
  qrGapWayOut,
  readPdf,
  readQr,
  renderPaymentQr,
  type PdfState,
  type QrState,
} from './invoice';
import type { DocumentDto } from './model';

export interface QrPanelProps {
  doc: DocumentDto;
  /** The normalised QR read, or null while the artifact read is still in flight. */
  qr: QrState | null;
}

/** S3's payment part: the reference in its statutory display form, the amount, and the way out on a gap. */
export function QrPanel({ doc, qr }: QrPanelProps) {
  const t = useT();
  const payloadId = useId();
  const [showPayload, setShowPayload] = useState(false);

  // The accessible name is translated here because the engine has no locale. A payment instrument
  // with no accessible name is unusable to a screen-reader user: they would hear nothing at all
  // where a sighted user sees the thing that gets the invoice paid.
  const graphicLabel = t('invoice.qr.graphicLabel');
  const payload = qr !== null && qr.kind === 'available' ? qr.bill.swissQrPayload : null;

  /*
   * Encoding the symbol is by far the most expensive thing this panel does: a QR encode followed by
   * roughly 45 KB of SVG text. It ran in the component body, so it ran again on every re-render the
   * bill had nothing to do with (the disclosure below toggling, any parent state change): seven
   * encodes for one bill in the test that now pins this, three of them for opening and closing the
   * raw-payload disclosure.
   *
   * The two arguments below are the ONLY things `renderPaymentQr` reads, and both are strings, so
   * the memo is keyed by VALUE and there is no way for it to hand back a symbol built from an
   * earlier bill: change either and the key changes with it. That property is the point. A stale QR
   * is worse than a slow one, because it is a payment instruction for the wrong amount.
   *
   * Note what is deliberately NOT in the dependency list. `qr.bill` is an object and `t` is a
   * function, and both can be fresh on a render that changed no payment data (a re-read returning
   * identical data; a provider that stopped memoising `t`). Keying on either would either rebuild
   * for nothing, quietly undoing this, or tie the correctness of a payment instrument to a
   * referential-identity detail somewhere else in the tree.
   *
   * The hook sits ABOVE the state branches below because hook order cannot be conditional. `payload`
   * is null in exactly the branches that return before the symbol is ever needed.
   */
  const graphic = useMemo(
    () => (payload === null ? null : renderPaymentQr(payload, graphicLabel)),
    [payload, graphicLabel],
  );

  if (qr === null) {
    return (
      <section className="invoice-qr-panel panel" aria-label={t('invoice.qr.title')}>
        <h2 className="documents-section-title">{t('invoice.qr.title')}</h2>
        <Skeleton rows={3} height={24} />
      </section>
    );
  }

  if (qr.kind === 'unavailable') {
    const key = invoiceErrorKey(qr.reason);
    // The gaps that a human fixes get the link that fixes them: a missing payment part must never be
    // a dead end, and the round trip back regenerates the QR with no extra step (M9). The mapping is
    // shared with S7's send refusal, so the panel and the dialog can never name different cures for
    // the same cause, and a missing creditor ADDRESS no longer offers "IBAN hinterlegen".
    const wayOut = qrGapWayOut(qr.reason);
    return (
      <section className="invoice-qr-panel panel" aria-label={t('invoice.qr.title')}>
        <h2 className="documents-section-title">{t('invoice.qr.unavailable')}</h2>
        <p className="invoice-qr-unavailable">
          {key === null ? t('document.genericError') : t(key, { currency: doc.currency, date: '' })}
        </p>
        {wayOut !== null && (
          <p className="invoice-qr-unavailable">
            <Link to={wayOut.to}>{t(wayOut.labelKey)}</Link>
          </p>
        )}
      </section>
    );
  }

  const bill = qr.bill;
  return (
    <section className="invoice-qr-panel panel" aria-label={t('invoice.qr.title')}>
      <h2 className="documents-section-title">{t('invoice.qr.title')}</h2>
      <div className="invoice-qr-body">
        {/* The null arm is unreachable here (this branch IS `qr.kind === 'available'`, so the memo
            had a payload), and it renders the undrawable message rather than nothing, because a
            payment part that silently disappears is the one outcome this panel must never produce. */}
        {graphic !== null && graphic.kind === 'drawn' ? (
          <div className="invoice-qr-code">
            {/*
              The SVG comes from the engine's own renderer, which emits nothing but `<rect>` elements
              plus the accessible name it XML-escapes itself. The payload never reaches the markup:
              it is encoded into modules, not interpolated into a string. So there is no untrusted
              markup here to sanitise, and the alternative (re-implementing the rect walk in JSX)
              would be a second renderer to keep in step with the one the PDF uses.
            */}
            <div className="invoice-qr-svg" dangerouslySetInnerHTML={{ __html: graphic.svg }} />
            {graphic.tooDense && (
              <p className="invoice-qr-note">{t('invoice.qr.graphicDense')}</p>
            )}
          </div>
        ) : (
          <div className="invoice-qr-code" role="note">
            {t('invoice.qr.graphicUndrawable')}
          </div>
        )}
        <dl className="invoice-qr-facts">
          <dt>
            {t('invoice.qr.reference')}
            {/* A11-G16: `QRR` and `SCOR` are wire vocabulary printed at a person who has never met
                either word. Which one an invoice carries is decided by the creditor's IBAN kind and
                is not a choice anyone makes here, so the honest affordance is an explanation on
                demand rather than a control. */}
            <HelpHint
              label={t('invoice.qr.referenceHelpLabel')}
              title={t(`invoice.qr.referenceHelp.${bill.referenceType === 'QRR' ? 'qrr' : 'scor'}.title`)}
              body={t(`invoice.qr.referenceHelp.${bill.referenceType === 'QRR' ? 'qrr' : 'scor'}.body`)}
            />
          </dt>
          <dd>
            <span className="t-num">
              {bill.referenceType} {formatQrReference(bill.reference, bill.referenceType)}
            </span>
            {/* This is the one string on the panel a human RETYPES, into e-banking, digit by digit,
                where a slip misroutes a payment. Copying the unformatted reference is what a bank
                field wants; the spaces above are for reading. */}
            <CopyButton value={bill.reference} />
          </dd>
          <dt>{t('invoice.qr.amount')}</dt>
          <dd>{formatMoney(doc.totalMinor, doc.currency)}</dd>
          {doc.dueDate !== null && (
            <>
              <dt>{t('invoice.terms.dueDate')}</dt>
              <dd>{formatDate(doc.dueDate)}</dd>
            </>
          )}
          {/* A11-G16: this used to be a `<dt>` reading "SIX Implementation Guidelines 2.3" over an
              EMPTY `<dd>`: a jargon string standing in the label column with nothing it labelled.
              It is a fact about the bill like the others, so it is stated as one. */}
          <dt>{t('invoice.qr.guideline')}</dt>
          <dd>{t('invoice.qr.igVersion', { version: bill.igVersion })}</dd>
        </dl>
      </div>

      <div>
        <button
          type="button"
          className="btn btn--secondary btn--sm"
          aria-expanded={showPayload}
          aria-controls={payloadId}
          onClick={() => setShowPayload((v) => !v)}
        >
          {/* A11-G12: the label used to read "anzeigen" while the payload was already on screen, so
              the control described the state it was in rather than the one it moves to. */}
          {t(showPayload ? 'invoice.qr.hidePayload' : 'invoice.qr.showPayload')}
        </button>
        {showPayload && (
          <pre id={payloadId} className="invoice-qr-payload" aria-label={t('invoice.qr.payloadLabel')}>
            {bill.swissQrPayload}
          </pre>
        )}
      </div>
    </section>
  );
}

export interface PdfViewerProps {
  doc: DocumentDto;
  onClose: () => void;
}

/**
 * S8: show the artifact and let it be downloaded. The bytes are fetched on OPEN, not on every detail
 * view, because rendering a PDF for a document nobody asked to see is work nobody asked for.
 */
export function PdfViewer({ doc, onClose }: PdfViewerProps) {
  const t = useT();
  const client = useClient();
  const workspaceId = useWorkspaceId();
  const [state, setState] = useState<PdfState | null>(null);

  const load = useCallback(async () => {
    if (workspaceId === null) return;
    setState(null);
    const { body } = await client.call('get_document', {
      workspaceId,
      documentId: doc.id,
      include: ['pdf'],
    });
    if (isErr(body)) {
      setState({ kind: 'unavailable', reason: body.error });
      return;
    }
    setState(readPdf((body as Record<string, unknown>).pdf));
  }, [client, workspaceId, doc.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const fileName = `Rechnung-${doc.number ?? doc.id}.pdf`;
  const href = state?.kind === 'available' ? `data:application/pdf;base64,${state.pdf.base64}` : null;

  return (
    <Modal
      open
      onClose={onClose}
      title={`${t('invoice.pdf.title')} ${doc.number ?? ''}`.trim()}
      closeLabel={t('invoice.pdf.close')}
      footer={
        <>
          <button type="button" className="btn btn--secondary" onClick={onClose}>
            {t('invoice.pdf.close')}
          </button>
          {href !== null && (
            <a className="btn btn--accent" href={href} download={fileName}>
              {t('invoice.pdf.download')}
            </a>
          )}
        </>
      }
    >
      <div className="invoice-pdf">
        {state?.kind === 'available' && (
          <p className="invoice-pdf-meta">
            {t('invoice.pdf.size', { kb: Math.max(1, Math.round(state.pdf.byteLength / 1024)) })}
            {' · '}
            {state.pdf.hasQrBill ? t('invoice.pdf.withQr') : t('invoice.pdf.withoutQr')}
          </p>
        )}

        {/* Skeleton already carries role=status + aria-busy; a second wrapper would announce twice. */}
        {state === null && (
          <div>
            <Skeleton rows={5} height={40} />
            <p className="invoice-pdf-meta">{t('invoice.pdf.loading')}</p>
          </div>
        )}

        {state?.kind === 'unavailable' && (
          <div className="error-banner panel" role="alert">
            <span aria-hidden="true">! </span>
            <div>
              <p className="error-body">
                {t('invoice.pdf.error')}{' '}
                {invoiceErrorKey(state.reason) !== null && t(invoiceErrorKey(state.reason) as string, { currency: doc.currency, date: '' })}
              </p>
              <button type="button" className="btn btn--secondary btn--sm" onClick={() => void load()}>
                {t('invoice.pdf.retry')}
              </button>
            </div>
          </div>
        )}

        {href !== null && (
          <>
            <iframe className="invoice-pdf-frame" src={href} title={t('invoice.pdf.preview')} />
            {/*
              A11-G6: the frame has no state of its own, and cannot be given one honestly. Whether a
              browser renders an embedded PDF is decided by the browser (headless Chromium ships no
              viewer and draws a blank rectangle), the iframe fires `load` either way, and nothing on
              this side can tell a rendered page from an empty one. Claiming a preview that is not
              there would be the data dishonesty this slice refuses everywhere else, and a spinner
              that never resolves would be worse.

              So the frame says what it is and names the certain path beside it. This is the last look
              at the artifact before it goes to a client: "I see nothing" must not read as "the
              invoice is empty".
            */}
            <p className="invoice-pdf-meta">{t('invoice.pdf.previewHint')}</p>
          </>
        )}
      </div>
    </Modal>
  );
}

/**
 * Read an issued invoice's QR payload. Separate from the detail's own read so a quote never pays for
 * an artifact it cannot have, and so a QR gap (a missing IBAN) never fails the whole document read.
 */
export function useInvoiceQr(doc: DocumentDto | null): QrState | null {
  const client = useClient();
  const workspaceId = useWorkspaceId();
  const [qr, setQr] = useState<QrState | null>(null);

  const eligible = doc !== null && doc.type === 'invoice' && doc.status !== 'draft' && doc.number !== null;
  const documentId = doc?.id ?? null;

  useEffect(() => {
    if (!eligible || workspaceId === null || documentId === null) {
      setQr(null);
      return;
    }
    let live = true;
    setQr(null);
    async function run() {
      const { body } = await client.call('get_document', { workspaceId, documentId, include: ['qr'] });
      if (!live) return;
      if (isErr(body)) {
        setQr({ kind: 'unavailable', reason: body.error });
        return;
      }
      setQr(readQr((body as Record<string, unknown>).qr));
    }
    void run();
    return () => {
      live = false;
    };
  }, [client, workspaceId, documentId, eligible]);

  return eligible ? qr : null;
}
