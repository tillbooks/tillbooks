/**
 * S3, the DocumentDetail (issued and later, `/documents/:id` once past draft): read an immutable
 * document and take the one legal next step.
 *
 * Header (number, customer, total, WORD status chip), then the status timeline, then the read-only
 * positions, then the VAT summary. The action row shows ONLY legal transitions (D19/M23): the primary
 * forward step as an accent button, the rest (and the destructive Storno) in the overflow. Convert
 * opens the new target with a toast; Storno runs behind a ConfirmDialog (a reversal, never a delete).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';

import { useClient } from '../../lib/client-context';
import { isErr, type Err } from '../../lib/client';
import { useWorkspaceId } from '../../app/workspace';
import { useT, formatDate, formatMoney } from '../../i18n';
import { EmptyState, ErrorBanner, Skeleton } from '../../components/states';
import { SurfaceHeader } from '../../components/SurfaceHeader';
import { ActionFeedback } from '../../components/ActionFeedback';
import { OverflowMenu } from '../../components/OverflowMenu';
import { Provenance, type ProvenanceOrigin } from '../../components/Provenance';
import { Status } from '../../components/Status';
import { useCan, CAP } from '../../lib/capabilities';
import { VatSummary } from '../Vat/VatSummary';
import type { LineVat } from '../Vat/types';
import { summariseVat, contributionOf } from '../Vat/summary';
import '../Vat/Vat.css';
import { ConfirmDialog } from '../Accounts/ConfirmDialog';
import { CreditNoteDialog } from './CreditNoteDialog';
import { DocumentEditor } from './DocumentEditor';
import { PdfViewer, QrPanel, useInvoiceQr } from './InvoiceArtifacts';
import { EbillPanel } from './EbillPanel';
import { SendDialog } from './SendDialog';
import { hasInvoiceArtifacts, invoiceErrorKey } from './invoice';
import { LinkedFiles } from '../Files/LinkedFiles';
import {
  documentActions,
  documentStatusKind,
  idemKey,
  postedBaseFigures,
  statusKey,
  typeKey,
  type DocumentAction,
  type DocumentDto,
  type DocumentLine,
  type HistoryEntry,
  type SendOutcome,
} from './model';

interface Contact {
  id: string;
  name: string;
  email?: string | null;
}

/**
 * True only for a document that genuinely awaits money: a sent or partly paid INVOICE (or credit
 * note). A quote, an order, and every terminal state (converted, cancelled, declined, expired,
 * settled) do not wait for payment and must not claim to (A10-G5, data honesty). No open-amount
 * figure is shown either: A14 owns settlement, and nothing fabricates a number before it exists.
 */
function waitsForPayment(doc: DocumentDto): boolean {
  const financial = doc.type === 'invoice' || doc.type === 'credit_note';
  return financial && (doc.status === 'sent' || doc.status === 'partially_paid');
}

function actorKey(actor: string | null): string {
  if (actor === 'agent') return 'document.detail.actor.agent';
  if (actor === 'system') return 'document.detail.actor.system';
  return 'document.detail.actor.you';
}

/**
 * C3: the creation transition of a document is its earliest status-history row, the `null -> draft`
 * entry `createDocument` stamps with `ctx.actor`. Its actor is who created the document. Returned
 * verbatim off the read model's own `history`, so nothing is fabricated: a document whose trail the
 * read did not carry yields no line at all.
 */
function creationEntry(history: readonly HistoryEntry[]): HistoryEntry | null {
  return history.find((h) => h.fromStatus === null) ?? history[0] ?? null;
}

/** C3 origin from the stored actor. `agent` is named in words; every other seat reads as a hand. */
function documentOrigin(actor: string | null): ProvenanceOrigin {
  return actor === 'agent' ? 'agent' : 'human';
}

/**
 * The route element for `/documents/:id`: a draft edits in place (S2), everything else is the
 * immutable detail (S3). One route, mode follows status (there is no separate edit URL).
 */
export function DocumentRoute() {
  const client = useClient();
  const workspaceId = useWorkspaceId();
  const { id } = useParams();
  const [status, setStatus] = useState<'loading' | 'draft' | 'other' | 'error'>('loading');
  // A10-D1/G2: the probe used to key on `[client, workspaceId, id]` alone. Issuing a draft that was
  // reached AT its own `/documents/:id` url (a saved draft opened from the list, or a convert target)
  // navigates to the SAME url, so `id` never changed, the effect never re-ran, and the user kept
  // looking at a stale editable form for an already-issued, immutable document. The editor now bumps
  // this token whenever it changes the document's status, which re-probes and swaps S2 for S3.
  const [statusToken, setStatusToken] = useState(0);
  // Set when the editor hosted here issued the document, so the detail that replaces it acks.
  const [justIssued, setJustIssued] = useState(false);
  const [sendOutcome, setSendOutcome] = useState<SendOutcome | null>(null);

  useEffect(() => {
    let live = true;
    async function probe() {
      if (workspaceId === null || id === undefined) {
        if (live) setStatus('error');
        return;
      }
      const { body } = await client.call('get_document', { workspaceId, documentId: id });
      if (!live) return;
      if (isErr(body)) setStatus('error');
      else setStatus((body.document as DocumentDto).status === 'draft' ? 'draft' : 'other');
    }
    void probe();
    return () => {
      live = false;
    };
  }, [client, workspaceId, id, statusToken]);

  if (status === 'loading') {
    return (
      <div className="documents-detail">
        <Skeleton rows={6} height={40} />
      </div>
    );
  }
  // Re-probing on the token alone would leave the editor mounted for one render with stale state, so
  // the swap is keyed too: the detail mounts fresh against the issued document.
  if (status === 'draft') {
    return (
      <DocumentEditor
        key={`draft-${statusToken}`}
        onStatusChanged={(outcome) => {
          setJustIssued(true);
          setSendOutcome(outcome);
          setStatusToken((n) => n + 1);
        }}
      />
    );
  }
  return <DocumentDetail key={`detail-${statusToken}`} justIssued={justIssued} sendOutcome={sendOutcome} />;
}

export function DocumentDetail({ justIssued = false, sendOutcome = null }: { justIssued?: boolean; sendOutcome?: SendOutcome | null } = {}) {
  const t = useT();
  const client = useClient();
  const workspaceId = useWorkspaceId();
  const navigate = useNavigate();
  const location = useLocation();
  const { id } = useParams();
  /**
   * THE PADLOCK (A24, F5 retrofit), matching the engine's `transition_document` rule exactly: the
   * TARGET decides, `to: 'sent'` costs `send` and every other step costs `issue`. Actions the actor
   * cannot take are ABSENT, not disabled-then-refused. Fail-open while `whoami` is unresolved.
   */
  const canIssue = useCan(CAP.issue);
  const canSend = useCan(CAP.send);

  const [doc, setDoc] = useState<DocumentDto | null>(null);
  const [lines, setLines] = useState<DocumentLine[]>([]);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [customer, setCustomer] = useState<string>('');
  const [customerEmail, setCustomerEmail] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Err | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [actionErr, setActionErr] = useState<Err | null>(null);
  const [confirm, setConfirm] = useState<DocumentAction | null>(null);
  const [lineVats, setLineVats] = useState<Record<number, LineVat>>({});
  const [busy, setBusy] = useState(false);
  const [showPdf, setShowPdf] = useState(false);
  const [showSend, setShowSend] = useState(false);
  // A13: the Gutschriften referencing this invoice (one read, the creditedDocumentId filter), and
  // the dialog that derives a new one. Loaded only for a posted invoice.
  const [creditNotes, setCreditNotes] = useState<DocumentDto[]>([]);
  const [showCreditNote, setShowCreditNote] = useState(false);
  // The QR rides its own read: a quote never pays for an artifact it cannot have, and a QR gap (a
  // missing IBAN) never fails the whole document read.
  const qr = useInvoiceQr(doc);

  const fromNumber = (location.state as { fromNumber?: string } | null)?.fromNumber;
  // The Commit moment (D122 D-I): arriving from an issue, the banner lands and draws its check.
  const issuedNow = justIssued || (location.state as { justIssued?: boolean } | null)?.justIssued === true;
  // F-03 (J3.5): the send half of "Ausstellen und senden", from the route state or the route wrapper.
  const sendNow: SendOutcome | null = sendOutcome ?? (location.state as { sendOutcome?: SendOutcome | null } | null)?.sendOutcome ?? null;

  const load = useCallback(async () => {
    if (workspaceId === null || id === undefined) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    setNotFound(false);
    const { body } = await client.call('get_document', { workspaceId, documentId: id });
    if (isErr(body)) {
      if (body.error === 'not_found') setNotFound(true);
      else setError(body);
      setLoading(false);
      return;
    }
    const d = body.document as DocumentDto;
    setDoc(d);
    setLines((body.lines as DocumentLine[]) ?? []);
    setHistory((body.history as HistoryEntry[]) ?? []);
    if (d.type === 'invoice' && d.postedEntryId !== null) {
      const cn = await client.call('list_documents', {
        workspaceId,
        type: 'credit_note',
        creditedDocumentId: d.id,
      });
      if (!isErr(cn.body)) setCreditNotes((cn.body.documents as DocumentDto[]) ?? []);
    }
    if (d.contactId !== null) {
      const c = await client.call('get_contact', { workspaceId, contactId: d.contactId });
      if (!isErr(c.body)) {
        const contact = c.body.contact as Contact;
        setCustomer(contact.name);
        // Null, not '': "no email on file" is a distinct state from "an empty one", and M17's dialog
        // must be able to tell them apart to prompt honestly.
        setCustomerEmail(contact.email ?? null);
      }
    }
    setLoading(false);
  }, [client, workspaceId, id]);

  useEffect(() => {
    void load();
  }, [load]);

  // The VAT summary is computed live from the lines' codes (the same vat_preview code path), so an
  // issued document shows its per-rate breakdown even though A10 stores no tax on the document row.
  useEffect(() => {
    if (workspaceId === null || lines.length === 0) return;
    let live = true;
    async function run() {
      const results: Record<number, LineVat> = {};
      await Promise.all(
        lines.map(async (l, i) => {
          const amount = l.lineTotalMinor ?? 0;
          if (l.taxCode === null || l.taxCode === undefined || l.taxCode === '' || amount <= 0) return;
          const { body } = await client.call('vat_preview', {
            workspaceId,
            amountMinor: amount,
            amountIsGross: false,
            taxCode: l.taxCode,
            supplyDate: doc?.issueDate ?? undefined,
          });
          results[i] = body as LineVat;
        }),
      );
      if (live) setLineVats(results);
    }
    void run();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lines]);

  const vatSummary = useMemo(() => {
    const contribs = lines
      .map((_, i) => contributionOf(lineVats[i]))
      .filter((c): c is NonNullable<typeof c> => c !== null);
    return summariseVat(contribs);
  }, [lines, lineVats]);

  async function runTransition(action: DocumentAction) {
    if (workspaceId === null || doc === null) return;
    setBusy(true);
    setActionErr(null);
    const { body } = await client.call('transition_document', {
      workspaceId,
      documentId: doc.id,
      to: action.to,
      idempotencyKey: idemKey('doc-transition'),
    });
    setBusy(false);
    if (isErr(body)) setActionErr(body);
    else void load();
  }

  async function runConvert(action: DocumentAction) {
    if (workspaceId === null || doc === null) return;
    setBusy(true);
    setActionErr(null);
    const { body } = await client.call('convert_document', {
      workspaceId,
      documentId: doc.id,
      toType: action.toType,
      idempotencyKey: idemKey('doc-convert'),
    });
    setBusy(false);
    if (isErr(body)) {
      setActionErr(body);
      return;
    }
    const target = (body.document as DocumentDto).id;
    navigate(`/documents/${target}`, { state: { fromNumber: doc.number } });
  }

  function onAction(action: DocumentAction) {
    if (action.danger === true) setConfirm(action);
    else if (action.kind === 'convert') void runConvert(action);
    // Sending an INVOICE is not a bare status flip: `send_invoice` renders the PDF, attaches it,
    // dispatches through the relay, records the recipient and only then transitions, all as one
    // idempotent unit (D14, M-2). It also needs a recipient, so it opens S7. Every other type's
    // "sent" is a mark, not a transmission, and keeps riding A10's transition.
    else if (action.to === 'sent' && doc !== null && doc.type === 'invoice') setShowSend(true);
    else void runTransition(action);
  }

  function onConfirm() {
    const action = confirm;
    setConfirm(null);
    if (action !== null) void runTransition(action);
  }

  if (loading) {
    return (
      <div className="documents-detail">
        <Skeleton rows={6} height={40} />
      </div>
    );
  }

  if (notFound) {
    return (
      <div className="documents-detail">
        <EmptyState
          title={t('document.detail.notFound')}
          hint={t('document.detail.notFoundHint')}
          action={{ label: t('document.action.back'), to: '/documents' }}
        />
      </div>
    );
  }

  if (error !== null || doc === null) {
    return (
      <div className="documents-detail">
        <ErrorBanner error={error ?? { ok: false, error: 'unexpected_error' }} onRetry={() => void load()} />
      </div>
    );
  }

  const allActions = documentActions(doc);
  // The capability filter mirrors the engine's per-target rule, so the action row can never offer a
  // step whose engine answer would be permission_denied.
  const mayTake = (a: DocumentAction) =>
    a.kind === 'transition' && a.to === 'sent' ? canSend : canIssue;
  const actions = {
    primary: allActions.primary !== null && mayTake(allActions.primary) ? allActions.primary : null,
    overflow: allActions.overflow.filter(mayTake),
  };
  // M11: the base-currency figures, or null. Present only once a posting stamped a rate, so a quote
  // in EUR (which posts nothing) and a franc invoice (which converted nothing) both get null and
  // this panel never renders. Nothing here is derived: see the panel below.
  const fx = postedBaseFigures(doc);

  return (
    <div className="documents-detail">
      {fromNumber !== undefined && (
        <ActionFeedback tone="info" message={t('document.detail.convertedToast', { number: fromNumber })} />
      )}
      {issuedNow && doc.status !== 'draft' && sendNow === null && (
        <ActionFeedback
          tone="success"
          landed
          message={t('document.detail.issuedAck', { number: doc.number ?? t('document.draftNumber') })}
        />
      )}
      {issuedNow && doc.status !== 'draft' && sendNow !== null && sendNow.kind === 'sent' && (
        <ActionFeedback
          tone="success"
          landed
          message={t('document.detail.issuedAndSentAck', { number: doc.number ?? t('document.draftNumber'), email: sendNow.email })}
        />
      )}
      {/* The invoice IS issued; only the send half was refused. The reason is the engine's own, and
          both ways out are offered here (the PDF, the setup), so nothing is a dead end. */}
      {issuedNow && doc.status !== 'draft' && sendNow !== null && sendNow.kind === 'failed' && (
        <ActionFeedback
          tone="warn"
          landed
          message={t('document.detail.issuedNotSentAck', { number: doc.number ?? t('document.draftNumber'), email: sendNow.email })}
          detail={t(invoiceErrorKey(sendNow.error.error) ?? 'document.genericError')}
        >
          <span className="invoice-send-ways-out">
            <button type="button" className="btn btn--secondary btn--sm" onClick={() => setShowPdf(true)}>
              {t('invoice.send.downloadInstead')}
            </button>
            {(sendNow.error.error === 'needs_email_config' || sendNow.error.error === 'needs_email_transport') && (
              <Link className="link-inline" to="/setup">{t('invoice.send.toSetup')}</Link>
            )}
          </span>
        </ActionFeedback>
      )}

      <Link to="/documents" className="documents-back">
        {t('document.action.back')}
      </Link>
      <SurfaceHeader
        title={`${t(typeKey(doc.type))} ${doc.number ?? t('document.draftNumber')}`}
        actions={
          <>
            {/* The PDF exists from issue onward, so the control appears exactly where it is legal
                (M23): never on a draft, where the engine would refuse it anyway. */}
            {hasInvoiceArtifacts(doc) && (
              <button type="button" className="btn btn--secondary" onClick={() => setShowPdf(true)}>
                {t('invoice.pdf.open')}
              </button>
            )}
            {/* A13 (§6): the Gutschrift entry point, on an invoice that has posted and still stands.
                Gated by the same A24 `issue` capability the engine's two credit-note verbs carry: the
                affordance is ABSENT without it (the F5 padlock idiom), never disabled-then-refused. */}
            {canIssue &&
              doc.type === 'invoice' &&
              ['issued', 'sent', 'partially_paid', 'settled'].includes(doc.status) && (
                <button type="button" className="btn btn--secondary" onClick={() => setShowCreditNote(true)}>
                  {t('creditNote.create')}
                </button>
              )}
            {actions.overflow.length > 0 && (
              <OverflowMenu
                label={t('document.rowActions', { name: doc.number ?? t('document.draftNumber') })}
                disabled={busy}
                items={actions.overflow.map((a) => ({
                  key: a.labelKey,
                  label: t(a.labelKey),
                  danger: a.danger,
                  onSelect: () => onAction(a),
                }))}
              />
            )}
            {actions.primary !== null ? (
              // The view's one primary, never the money tint (K-08, D137). Sending, accepting or
              // converting books nothing, and this row never issues: a draft renders the
              // DocumentEditor, whose "Ausstellen" is the posting step, and every step here runs
              // `transition_document` or `convert_document`, neither of which posts an invoice (the
              // C2 money critic, F2 and F6: the accent branch here was unreachable and would have
              // tinted a non-posting verb).
              <button
                type="button"
                className="btn btn--primary"
                disabled={busy}
                onClick={() => onAction(actions.primary as DocumentAction)}
              >
                {t(actions.primary.labelKey)}
              </button>
            ) : (
              // A10-G5: this used to read "wartet auf Zahlung" for EVERY action-less state, so a
              // converted quote and a cancelled document both claimed to await payment. Only a sent or
              // part-paid INVOICE waits for money; a converted document offers its target instead
              // (A10-G6, never a dead end), and the remaining terminal states say nothing, because the
              // status chip beside the total already says it.
              <>
                {waitsForPayment(doc) && <span className="documents-waiting">{t('document.detail.waitingPayment')}</span>}
                {/* A10-G6: the forward link now comes off the document itself (`targetDocumentId`).
                    It used to be reconstructed by listing every document and searching for the one
                    whose source is this one, which is a page-capped scan pretending to be a lookup:
                    past D34's 1000-row ceiling the target simply fell off the page and a converted
                    document became a dead end again, silently. One read, no ceiling. */}
                {doc.status === 'converted' && doc.targetDocumentId !== null && (
                  <Link to={`/documents/${doc.targetDocumentId}`} className="btn btn--secondary">
                    {t('document.detail.target')}
                  </Link>
                )}
              </>
            )}
          </>
        }
      />

      <p className="documents-detail-sub">
        <span>{customer}</span>
        <span aria-hidden="true"> · </span>
        <span className="t-num t-money">{formatMoney(doc.totalMinor, doc.currency)}</span>
        <span aria-hidden="true"> · </span>
        <Status kind={documentStatusKind(doc.status)} label={t(statusKey(doc.status))} />
      </p>

      {/* C3: who created this document and when, from the creation row of the read model's own status
          history. Rendered only when that row exists, so a document with no trail fabricates nothing;
          a legacy row with no actor shows the neutral "unbekannt" form, never a made-up name. */}
      {(() => {
        const created = creationEntry(history);
        return created !== null ? (
          <Provenance
            origin={documentOrigin(created.actor)}
            actor={created.actor}
            timestamp={created.at}
          />
        ) : null;
      })()}

      {/* M11, the side by side: what was billed, what the books hold, and the rate that connects
          them. Every one of the four figures is the ENGINE's own, read off the posted journal rows
          at read time. The client multiplies nothing out: given the transaction total and the rate
          it could compute the base total in one line, and that line is exactly the bug, because the
          rounding it chose would be its own rather than the ledger's and the two would part company
          on some invoice nobody was watching.

          The VAT pair is the same disclosure one level down, and the one a Swiss filer needs most.
          An MWST-Abrechnung is filed in francs (MWSTV Art. 45), so on a EUR invoice the customer is
          charged EUR 121.50 and the return is filed on CHF 114.36. Both are true, they are different
          numbers, and until `baseTaxMinor` reached a read model the franc one lived only in
          `journal_line.base_credit_minor` and reached no screen at all. The multiplication is even
          less safe here than on the total: `applyFx` rounds ONCE on the side total and allocates
          back over the legs by largest remainder, so on the pinned two-rate fixture the books hold
          CHF 19.91 while the product yields CHF 19.92.

          A PURE EXPORT (MWSTG Art. 23) books no output-VAT row at all and therefore reads zero
          francs of VAT. It still shows, as `CHF 0.00`: zero is an answer a filer can act on, and it
          is a different answer from the draft arm, where this whole panel is absent because nothing
          has posted and no figure exists in any currency.

          `fxRateAsOf` is absent on purpose and no validity date appears here. The ledger stores no
          `rate_as_of` column, so any date shown would have to be re-resolved from the mutable rate
          store, and a rate imported afterwards would then hand back a date that never priced this
          invoice. The note below says what IS true instead: this rate is the one the posting used,
          and a later rate does not reach it. */}
      {fx !== null && (
        <section className="documents-detail-fx panel" aria-label={t('invoice.fx.postedTitle')}>
          <h2 className="documents-section-title">{t('invoice.fx.postedTitle')}</h2>
          <dl className="documents-detail-fx-facts">
            <div>
              <dt>{t('invoice.fx.billed')}</dt>
              <dd className="t-num t-money">{formatMoney(doc.totalMinor, doc.currency)}</dd>
            </div>
            <div>
              <dt>{t('invoice.fx.booked')}</dt>
              <dd className="t-num t-money">{formatMoney(fx.totalBaseMinor, fx.baseCurrency)}</dd>
            </div>
            {/* Each figure under the currency it is actually denominated in. The transaction VAT is
                the document's own `taxMinor`, in the document's currency; the franc VAT is the
                engine's `baseTaxMinor`, in the ledger's. Neither wears the other's label, which is
                the defect this pair exists to prevent. */}
            <div>
              <dt>{t('invoice.fx.vatBilled')}</dt>
              <dd className="t-num t-money">{formatMoney(doc.taxMinor, doc.currency)}</dd>
            </div>
            <div>
              <dt>{t('invoice.fx.vatBooked')}</dt>
              <dd className="t-num t-money">{formatMoney(fx.baseTaxMinor, fx.baseCurrency)}</dd>
            </div>
            <div>
              <dt>{t('invoice.fx.rate')}</dt>
              {/* The rate is the engine's canonical string, rendered verbatim. Reformatting it here
                  would be a second opinion about what the books say the rate is. */}
              <dd className="t-num">
                {t('invoice.fx.rateLine', {
                  currency: doc.currency,
                  rate: fx.fxRate,
                  baseCurrency: fx.baseCurrency,
                })}
              </dd>
            </div>
          </dl>
          <p className="documents-detail-fx-note">{t('invoice.fx.postedNote')}</p>
          <p className="documents-detail-fx-note">{t('invoice.fx.vatNote', { baseCurrency: fx.baseCurrency })}</p>
        </section>
      )}

      {actionErr !== null &&
        (actionErr.error === 'period_locked' ? (
          <div className="error-banner panel" role="alert">
            <span aria-hidden="true">! </span>
            <div>
              <p className="error-body">{t('document.periodLocked', { period: String(actionErr.period ?? '') })}</p>
              <Link className="link-inline" to="/periods">{t('document.periodLockedLink')}</Link>
            </div>
          </div>
        ) : (
          <ErrorBanner error={actionErr} message={t('document.genericError')} />
        ))}

      <section className="documents-timeline panel" aria-label={t('document.detail.timeline')}>
        <h2 className="documents-section-title">{t('document.detail.timeline')}</h2>
        <ol className="documents-timeline-list">
          {history.map((h, i) => (
            <li key={i} className="documents-timeline-item">
              <span className="documents-timeline-status">{t(statusKey(h.toStatus))}</span>
              <span className="documents-timeline-meta">
                {formatDate(h.at)} · {t(actorKey(h.actor))}
              </span>
            </li>
          ))}
        </ol>
        {/* M16: the recipient, read off the document rather than remembered from the click. The
            engine writes `sentToEmail` only after a transport ACCEPTED the message, so a non-null
            value is evidence of a real transmission and not an echo of an attempt. It used to live
            in local state and vanish on reload, because the read model did not expose it and
            claiming a recipient it could not see would have been a guess. */}
        {doc.sentToEmail !== null && (
          <p className="documents-timeline-meta" role="status">
            {t('invoice.send.sentTo', { email: doc.sentToEmail })}
          </p>
        )}
        {doc.sourceDocumentId !== null && (
          <Link to={`/documents/${doc.sourceDocumentId}`} className="documents-timeline-link link-inline">
            {t('document.detail.source')}
          </Link>
        )}
        {/* A13: a Gutschrift links to the invoice it credits, one hop, no list scan. */}
        {doc.creditedDocumentId !== null && (
          <Link to={`/documents/${doc.creditedDocumentId}`} className="documents-timeline-link link-inline">
            {t('creditNote.reference')}
          </Link>
        )}
        {doc.postedEntryId !== null && (
          <Link to="/journal" className="documents-timeline-link link-inline">
            {t('document.detail.ledgerEntry')}
          </Link>
        )}
      </section>

      <section className="documents-detail-positions panel" aria-label={t('document.detail.positions')}>
        <h2 className="documents-section-title">{t('document.detail.positions')}</h2>
        <table className="documents-detail-lines">
          <thead>
            <tr>
              <th scope="col">{t('document.editor.description')}</th>
              <th scope="col">{t('document.editor.quantity')}</th>
              <th scope="col">{t('document.editor.unitPrice')}</th>
              <th scope="col" className="documents-amount">
                {t('document.editor.amount')}
              </th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={l.id ?? i}>
                <td>{l.description ?? ''}</td>
                <td className="t-num">{((l.quantityMilli ?? 1000) / 1000).toString()}</td>
                <td className="documents-amount t-num t-money">{formatMoney(l.unitPriceMinor, doc.currency)}</td>
                <td className="documents-amount t-num t-money">{formatMoney(l.lineTotalMinor ?? 0, doc.currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {/* A13: the credits standing against this invoice, so the detail answers "was ist davon schon
          gutgeschrieben?" without a filter safari. Empty renders nothing: an invoice with no credits
          needs no empty state for a concept the operator has not reached for. */}
      {doc.type === 'invoice' && creditNotes.length > 0 && (
        <section className="documents-detail-positions panel" aria-label={t('creditNote.listForInvoice')}>
          <h2 className="documents-section-title">{t('creditNote.listForInvoice')}</h2>
          <ul className="documents-timeline-list">
            {creditNotes.map((cn) => (
              <li key={cn.id} className="documents-timeline-item">
                <Link to={`/documents/${cn.id}`} className="documents-timeline-link link-inline">
                  {cn.number ?? t('document.draftNumber')}
                </Link>
                <span className="documents-timeline-meta">
                  {t(statusKey(cn.status))} · <span className="t-num t-money">{formatMoney(cn.totalMinor, cn.currency)}</span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* A11-G2: the document's OWN currency. Every figure in this panel came out of `vat_preview`
          on a line denominated in it, so the transaction currency is the only true label. The franc
          VAT an MWST return is filed on is a different number and it is NOT missing any more: the
          M11 panel above prints it, off `baseTaxMinor`, derived by the engine from the posted rows.
          It stays out of this panel because `vat_preview` has no franc answer to give, and the only
          way to put one here would be to multiply `fx.fxRate` out, which is the forbidden move. */}
      <VatSummary summary={vatSummary} currency={doc.currency} />

      {hasInvoiceArtifacts(doc) && <QrPanel doc={doc} qr={qr} />}

      {/* A32: the eBill delivery panel, on the same invoice detail the QR/PDF artifacts ride, for an
          issued+ invoice. It owns prepare/transmit/status; posts nothing (P3). */}
      {hasInvoiceArtifacts(doc) && <EbillPanel doc={doc} />}

      {/* E00: the shared Dateien panel, parameterised by the OP3 pair. A quote or an invoice files its
          evidence (the signed order, the delivery proof) against its own record, and this is the ONE
          attachment UI in the product, never a bespoke copy. */}
      {workspaceId !== null && (
        <LinkedFiles workspaceId={workspaceId} entityKind="document" entityId={doc.id} />
      )}

      {showPdf && <PdfViewer doc={doc} onClose={() => setShowPdf(false)} />}

      {showCreditNote && (
        <CreditNoteDialog
          invoice={doc}
          lines={lines}
          alreadyCreditedNetMinor={creditNotes
            .filter((cn) => cn.status !== 'draft' && cn.status !== 'cancelled')
            .reduce((n, cn) => n + cn.subtotalMinor, 0)}
          priorCreditNoteIds={creditNotes
            .filter((cn) => cn.status !== 'draft' && cn.status !== 'cancelled')
            .map((cn) => cn.id)}
          onClose={() => setShowCreditNote(false)}
        />
      )}

      {showSend && (
        <SendDialog
          doc={doc}
          customerEmail={customerEmail}
          onCancel={() => setShowSend(false)}
          onOpenPdf={() => {
            setShowSend(false);
            setShowPdf(true);
          }}
          // The reload is the only thing that has to happen: the recipient, the status and the
          // timeline all come back off the document, so nothing is mirrored into local state where
          // it could disagree with the ledger.
          onSent={() => {
            setShowSend(false);
            void load();
          }}
        />
      )}

      {confirm !== null && (
        <ConfirmDialog
          message={
            confirm.kind === 'delete' ? t('document.action.deleteDraftConfirm') : t('document.action.cancelConfirm')
          }
          confirmLabel={t(confirm.labelKey)}
          onConfirm={onConfirm}
          onCancel={() => setConfirm(null)}
        />
      )}
    </div>
  );
}
