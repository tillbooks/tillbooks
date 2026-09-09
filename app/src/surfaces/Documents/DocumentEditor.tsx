/**
 * S2, the DocumentEditor (full-page, U2): compose a draft, see totals and VAT live, and issue it.
 *
 * A full-page route (not a drawer): the editor carries a positions grid, a live VAT summary, and the
 * issue action, which is a page, not an overlay. It reuses the A06 controls unchanged (TaxCodePicker,
 * LineVatReadout, VatSummary) so a document line's tax preview is the SAME `vat_preview` code path the
 * Journal drawer and an agent use (US-A06.7). Ausstellen is disabled with an inline reason when a
 * precondition is unmet (needs_customer, needs_lines; D15/C3), never a silent disable. Saving persists
 * the draft (create then patch); issuing opens S4 and, on confirm, transitions to issued.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';

import { useClient } from '../../lib/client-context';
import { useCan, CAP } from '../../lib/capabilities';
import { isErr, type Err } from '../../lib/client';
import { useWorkspaceId } from '../../app/workspace';
import { useT, formatDate, formatMoney } from '../../i18n';
import { ErrorBanner, Skeleton } from '../../components/states';
import { OverflowMenu } from '../../components/OverflowMenu';
import { ActionFeedback } from '../../components/ActionFeedback';
import { ConfirmDialog } from '../Accounts/ConfirmDialog';
import { TaxCodePicker } from '../Vat/TaxCodePicker';
import { LineVatReadout } from '../Vat/LineVatReadout';
import { VatSummary } from '../Vat/VatSummary';
import type { LineVat, VatCode } from '../Vat/types';
import { summariseVat, contributionOf } from '../Vat/summary';
import '../Vat/Vat.css';
import { useIdempotencyKey } from '../../lib/idempotency';
import { IssueDialog } from './IssueDialog';
import { InvoiceTerms, QrReadinessPanel } from './InvoiceEditor';
import { CurrencyPicker } from './CurrencyPicker';
import type { FxState } from './currency';
import { qrGapLines, qrReadiness, type InvoiceContact } from './invoice';
import {
  DOCUMENT_TYPES,
  idemKey,
  lineTotalMinor,
  parseMilli,
  parseMinor,
  typeKey,
  type DocumentDto,
  type DocumentType,
  type SendOutcome,
} from './model';

interface DraftLine {
  key: string;
  description: string;
  quantity: string;
  unitPrice: string;
  taxCode: string;
  /**
   * F-03 (J3.5): true while `taxCode` is the editor's own default (a blank position, whatever code
   * it carries), false once a person chose it or a saved draft decided it. The default effect below
   * re-codes ONLY a line whose code is still the editor's: a hand-picked "Keine MWST" (`''`) and a
   * loaded draft's code-less line are decisions, and a VAT leg the person removed must never come
   * back without a word (critic F1, 2026-09-05).
   */
  taxDefaulted: boolean;
}

let lineSeq = 0;
function blankLine(taxCode = ''): DraftLine {
  lineSeq += 1;
  return { key: `dl${lineSeq}`, description: '', quantity: '1', unitPrice: '', taxCode, taxDefaulted: true };
}

/**
 * The workspace's own default sale code (F-03, J3.5): the active output code at the highest rate,
 * which is the Normalsatz of the current era. A workspace with no output code (not registered, or
 * not yet configured) has no default, and the picker's own "configure VAT" CTA takes over.
 */
export function workspaceDefaultTaxCode(codes: readonly VatCode[]): string {
  let best: VatCode | null = null;
  for (const c of codes) {
    if (!c.active || c.kind !== 'output') continue;
    if (best === null || c.rateBp > best.rateBp) best = c;
  }
  return best?.code ?? '';
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export interface DocumentEditorProps {
  /**
   * Called after this editor changes the document's status (issue, delete). The parent route re-probes
   * and swaps the editor for the immutable detail. Without it, issuing a draft reached at its own url
   * leaves a stale form on screen for an already-posted document (A10-D1/G2).
   */
  onStatusChanged?: (sendOutcome: SendOutcome | null) => void;
  /**
   * Pin the document type, ignoring `?type=` and hiding the type control. `InvoiceEditor` uses it, so
   * an invoice-scoped entry point cannot silently become a quote through a stale url.
   */
  forcedType?: DocumentType;
}

export function DocumentEditor({ onStatusChanged, forcedType }: DocumentEditorProps = {}) {
  const t = useT();
  const client = useClient();
  const workspaceId = useWorkspaceId();
  const navigate = useNavigate();
  const location = useLocation();
  const { id } = useParams();
  const [params] = useSearchParams();

  const initialType = forcedType ?? (params.get('type') as DocumentType) ?? 'invoice';
  // A10-G7: convert navigates with the origin's number in route state, but a convert TARGET is a
  // draft, so it mounts this editor, not the detail where the toast used to live. It never rendered.
  const fromNumber = (location.state as { fromNumber?: string } | null)?.fromNumber;

  const [docId, setDocId] = useState<string | null>(id ?? null);
  const [type, setType] = useState<DocumentType>(initialType);
  const [contactId, setContactId] = useState('');
  const [currency, setCurrency] = useState('CHF');
  const [date, setDate] = useState(todayIso());
  const [dueDate, setDueDate] = useState('');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<DraftLine[]>(() => [blankLine()]);
  // A13 §4b.1: the invoice this credit-note draft credits. When set, the lines are DERIVED and this
  // editor runs in its constrained mode: positions read-only, only notes/dueDate patchable, and the
  // engine refuses a line patch anyway (`credit_note_lines_derived`), so the mode mirrors the law
  // rather than inventing one.
  const [creditedDocumentId, setCreditedDocumentId] = useState<string | null>(null);

  // A10-G9: the build shipped explicit save with neither autosave nor a guard, so editing a saved
  // draft and navigating away dropped the edit silently. Every field change marks the draft dirty; a
  // successful write clears it; leaving while dirty asks first. Nothing is discarded behind your back.
  const [dirty, setDirty] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);

  const [contacts, setContacts] = useState<InvoiceContact[]>([]);
  // The workspace's own IBAN, read once, for QR READINESS only (M9). The Studio never builds a QR
  // payload: `buildQrBill` is the engine's, and this value only decides whether the editor can
  // honestly say the QR-bill will work, and with which reference type. It is the IBAN STRING rather
  // than a boolean because the v2.4 cutover turns on the IBAN's KIND: a QR-IBAN carries CHF only
  // from 14.11.2026, a plain one still yields a SCOR bill in EUR.
  const [iban, setIban] = useState<string | null>(null);
  // The currency the books are kept in, from the same profile read. The engine owns this; the client
  // never assumes CHF, because a workspace's base currency is a setting and not a constant.
  const [baseCurrency, setBaseCurrency] = useState('CHF');
  // What the engine says about the rate that would price this invoice. `needs_fx_rate` pre-disables
  // Ausstellen with the reason inline (D15/C3, M12) instead of letting the operator find out by
  // pressing it: the refusal is real either way, and the engine still owns it.
  const [fx, setFx] = useState<FxState>({ kind: 'base', baseCurrency: 'CHF' });
  const [taxCodes, setTaxCodes] = useState<VatCode[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState<Err | null>(null);
  const [writeErr, setWriteErr] = useState<Err | null>(null);
  const [busy, setBusy] = useState(false);
  const [denied, setDenied] = useState(false);
  const [showIssue, setShowIssue] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [issueErr, setIssueErr] = useState<Err | null>(null);
  const [lineVats, setLineVats] = useState<Record<string, LineVat>>({});
  // F-03 (J3.5): the tax code a position gets when nobody chose one: the customer's usual code
  // (the code on their newest issued invoice), else the workspace default. An invoice never goes
  // out with "Keine MWST" by omission; a code the person picked by hand is never overwritten.
  const [defaultTaxCode, setDefaultTaxCode] = useState('');
  // F-03 (J3.5): "Ausstellen und senden" is one act when the customer has an address. Default on.
  const [sendAfterIssue, setSendAfterIssue] = useState(true);
  // F-03 (J1.1 step 5): the customer typed inline. Measured 2026-09-05: `/documents/new` with no
  // contact sent the person to /contacts and dropped the draft (4 screens, 6 clicks). The contact is
  // created here, with the customer role, and the draft never leaves the screen. Gated by the same
  // A24 right `create_contact` carries: without it the affordance is absent, never refused.
  const canCreateContact = useCan(CAP.manageMasterData);
  const [newCustomerOpen, setNewCustomerOpen] = useState(false);
  const [newCustomerName, setNewCustomerName] = useState('');
  // Critic F7: one key per QUESTION (the name), not per call. A retry after a lost response replays
  // the same create_contact instead of minting a second "Bergblick AG"; a changed name is a new key.
  const customerCreateKey = useIdempotencyKey([workspaceId, 'contact-create', newCustomerName.trim()]);
  const [creatingCustomer, setCreatingCustomer] = useState(false);
  const [customerNote, setCustomerNote] = useState<string | null>(null);

  async function createCustomer() {
    const name = newCustomerName.trim();
    if (workspaceId === null || name === '' || creatingCustomer) return;
    setCreatingCustomer(true);
    setCustomerNote(null);
    const { body } = await client.call('create_contact', {
      workspaceId,
      partyRole: 'customer',
      name,
      idempotencyKey: customerCreateKey,
    });
    setCreatingCustomer(false);
    if (isErr(body)) {
      setCustomerNote(t('document.editor.customerCreateFailed'));
      return;
    }
    const created = (body as { contact?: { id?: string; name?: string; email?: string | null } }).contact;
    if (created === undefined || typeof created.id !== 'string') {
      setCustomerNote(t('document.editor.customerCreateFailed'));
      return;
    }
    const id = created.id;
    setContacts((prev) => [...prev, { id, name: created.name ?? name, email: created.email ?? null }]);
    setContactId(id);
    setDirty(true);
    setNewCustomerOpen(false);
    setNewCustomerName('');
    setCustomerNote(t('document.editor.customerCreated', { name: created.name ?? name }));
  }

  // Load pickers and (when editing) the draft, once on open.
  useEffect(() => {
    let live = true;
    async function load() {
      if (workspaceId === null) {
        if (live) setLoading(false);
        return;
      }
      const reads: Promise<void>[] = [
        client.call('list_contacts', { workspaceId }).then(({ body }) => {
          if (live && !isErr(body)) setContacts((body.contacts as InvoiceContact[]) ?? []);
        }),
        client.call('vat_codes', { workspaceId }).then(({ body }) => {
          if (live && !isErr(body)) setTaxCodes((body.taxCodes as VatCode[]) ?? []);
        }),
        // The profile answers `{ok, profile: {...}}`: the wrapper, not the profile itself. Reading
        // `body.creditorIban` here would be the third member of the assumed-shape bug family again.
        client.call('get_company_profile', { workspaceId }).then(({ body }) => {
          if (!live) return;
          if (isErr(body)) {
            setIban(null);
            return;
          }
          const profile = body.profile as { creditorIban?: string | null; baseCurrency?: string | null } | undefined;
          const stored = profile?.creditorIban ?? null;
          setIban(stored !== null && stored.trim() !== '' ? stored : null);
          const base = profile?.baseCurrency ?? null;
          if (base !== null && base !== '') {
            setBaseCurrency(base);
            // A NEW draft starts in the currency the books are kept in: the common case does the
            // common thing, and it is not a user edit, so it does not mark the draft dirty. An
            // existing draft keeps the currency it was saved with, which the `get_document` read
            // below sets.
            if (id === undefined) setCurrency(base);
          }
        }),
      ];
      if (id !== undefined) {
        reads.push(
          client.call('get_document', { workspaceId, documentId: id }).then(({ body }) => {
            if (!live) return;
            if (isErr(body)) {
              setLoadErr(body);
              return;
            }
            const doc = body.document as DocumentDto;
            const docLines = (body.lines as { description: string | null; quantityMilli: number; unitPriceMinor: number; taxCode: string | null }[]) ?? [];
            setType(doc.type);
            setContactId(doc.contactId ?? '');
            setCreditedDocumentId(doc.creditedDocumentId ?? null);
            setCurrency(doc.currency);
            setDueDate(doc.dueDate ?? '');
            setNotes(doc.notes ?? '');
            if (docLines.length > 0) {
              setLines(
                docLines.map((l) => {
                  lineSeq += 1;
                  return {
                    key: `dl${lineSeq}`,
                    description: l.description ?? '',
                    quantity: String((l.quantityMilli ?? 1000) / 1000),
                    unitPrice: l.unitPriceMinor > 0 ? (l.unitPriceMinor / 100).toFixed(2) : '',
                    taxCode: l.taxCode ?? '',
                    // A saved draft is a decided draft: its code-less line stays "Keine MWST".
                    taxDefaulted: false,
                  };
                }),
              );
            }
          }),
        );
      }
      await Promise.all(reads);
      if (live) setLoading(false);
    }
    void load();
    return () => {
      live = false;
    };
    // Load-on-open only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const needsVatConfig = !loading && loadErr === null && taxCodes.length === 0;

  // The customer's usual code: the first tax code on the newest non-draft invoice for the contact.
  const usualTaxCodeFor = useCallback(
    async (contact: string): Promise<string> => {
      const listed = await client.call('list_documents', { workspaceId, contactId: contact, type: 'invoice' });
      if (isErr(listed.body)) return '';
      const docs = ((listed.body as { documents?: { id: string; status: string }[] }).documents ?? []).filter(
        (d) => d.status !== 'draft' && d.status !== 'cancelled',
      );
      const newest = docs[0];
      if (newest === undefined) return '';
      const detail = await client.call('get_document', { workspaceId, documentId: newest.id });
      if (isErr(detail.body)) return '';
      const docLines = (detail.body as { lines?: { taxCode: string | null }[] }).lines ?? [];
      return docLines.find((l) => typeof l.taxCode === 'string' && l.taxCode !== '')?.taxCode ?? '';
    },
    [client, workspaceId],
  );

  // Resolve the default whenever the customer or the code list changes. A derived credit note owns
  // no editable lines, so it never defaults anything.
  const derivedDoc = type === 'credit_note' && creditedDocumentId !== null;
  useEffect(() => {
    if (workspaceId === null || loading || derivedDoc || taxCodes.length === 0) return;
    let live = true;
    void (async () => {
      let code = contactId === '' ? '' : await usualTaxCodeFor(contactId);
      if (code !== '' && !taxCodes.some((c) => c.code === code && c.active)) code = '';
      if (code === '') code = workspaceDefaultTaxCode(taxCodes);
      if (live) setDefaultTaxCode(code);
    })();
    return () => {
      live = false;
    };
  }, [workspaceId, loading, derivedDoc, taxCodes, contactId, usualTaxCodeFor]);

  // Apply the default to every position that still carries only the editor's own default. A code the
  // person chose by hand ("Keine MWST" included) and a loaded draft's line (`taxDefaulted` false) are
  // never overwritten: the condition is the flag alone, never "the code is empty".
  useEffect(() => {
    if (defaultTaxCode === '') return;
    setLines((prev) => prev.map((l) => (l.taxDefaulted ? { ...l, taxCode: defaultTaxCode, taxDefaulted: true } : l)));
  }, [defaultTaxCode]);

  const lineNet = useCallback(
    (l: DraftLine) => lineTotalMinor(parseMilli(l.quantity), parseMinor(l.unitPrice)),
    [],
  );

  // Live per-line VAT via `vat_preview`, keyed on a compact signature so an irrelevant keystroke does
  // not refetch. Same code path as the agent and the Journal readout (US-A06.7).
  const vatSignature =
    lines.map((l) => `${l.key}:${l.taxCode}:${lineNet(l)}`).join('|') + `#${date}`;
  useEffect(() => {
    if (workspaceId === null) return;
    let live = true;
    async function run() {
      const results: Record<string, LineVat> = {};
      await Promise.all(
        lines.map(async (l) => {
          if (l.taxCode === '') return;
          const amountMinor = lineNet(l);
          if (amountMinor <= 0) return;
          const { body } = await client.call('vat_preview', {
            workspaceId,
            amountMinor,
            amountIsGross: false,
            taxCode: l.taxCode,
            supplyDate: date,
          });
          results[l.key] = body as LineVat;
        }),
      );
      if (live) setLineVats(results);
    }
    void run();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vatSignature]);

  const vatSummary = useMemo(() => {
    const contribs = lines
      .map((l) => contributionOf(lineVats[l.key]))
      .filter((c): c is NonNullable<typeof c> => c !== null);
    return summariseVat(contribs);
  }, [lines, lineVats]);

  const subtotalMinor = lines.reduce((sum, l) => sum + lineNet(l), 0);
  const totalMinor = subtotalMinor + vatSummary.totalTaxMinor;

  const filledLines = lines.filter((l) => parseMinor(l.unitPrice) > 0 || l.description.trim() !== '');
  const hasCustomer = contactId !== '';
  const hasLines = filledLines.length > 0;
  const posts = type === 'invoice' || type === 'credit_note';
  const isInvoice = type === 'invoice';
  /** §4b.1: an FK-carrying Gutschrift draft. Its lines are a derivation, not an edit surface. */
  const derived = type === 'credit_note' && creditedDocumentId !== null;
  const selectedContact = contacts.find((c) => c.id === contactId);
  const customerEmail = typeof selectedContact?.email === 'string' && selectedContact.email.trim() !== '' ? selectedContact.email.trim() : null;

  function updateLine(key: string, patch: Partial<DraftLine>) {
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));
    setDirty(true);
  }

  function buildLinePayload() {
    return filledLines.map((l) => {
      const out: Record<string, unknown> = {
        description: l.description,
        quantityMilli: parseMilli(l.quantity),
        unitPriceMinor: parseMinor(l.unitPrice),
      };
      if (l.taxCode !== '') out.taxCode = l.taxCode;
      out.supplyDate = date;
      return out;
    });
  }

  /** Persist the draft: create the first time, patch thereafter. Returns the doc id, or null on error. */
  const persist = useCallback(async (): Promise<string | null> => {
    if (workspaceId === null) return null;
    setWriteErr(null);
    if (docId === null) {
      const { body } = await client.call('create_document', {
        workspaceId,
        type,
        contactId: contactId === '' ? undefined : contactId,
        currency,
        ...(dueDate === '' ? {} : { dueDate }),
        notes,
        lines: buildLinePayload(),
        idempotencyKey: idemKey('doc-create'),
      });
      if (isErr(body)) {
        if (body.error === 'permission_denied') setDenied(true);
        else setWriteErr(body);
        return null;
      }
      const newId = (body.document as DocumentDto).id;
      setDocId(newId);
      setDirty(false);
      // Deliberately does NOT navigate: the issue flow persists then opens S4 in place, so a
      // route change here would unmount the editor and lose the dialog. The draft becomes
      // addressable from the list; issuing navigates to the detail on success.
      return newId;
    }
    const { body } = await client.call('update_document', {
      workspaceId,
      documentId: docId,
      // §4b.1: a derived Gutschrift patches only what the derivation does not own. Sending lines,
      // currency or contact would earn the engine's `credit_note_lines_derived` refusal; not
      // sending them is the honest client of the same law.
      patch: derived
        ? { dueDate: dueDate === '' ? null : dueDate, notes }
        : {
            contactId: contactId === '' ? null : contactId,
            currency,
            dueDate: dueDate === '' ? null : dueDate,
            notes,
            lines: buildLinePayload(),
          },
      idempotencyKey: idemKey('doc-update'),
    });
    if (isErr(body)) {
      if (body.error === 'permission_denied') setDenied(true);
      else setWriteErr(body);
      return null;
    }
    setDirty(false);
    return docId;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, workspaceId, docId, type, contactId, currency, dueDate, notes, lines, date]);

  async function onSaveDraft() {
    setBusy(true);
    await persist();
    setBusy(false);
  }

  async function onIssueClick() {
    setBusy(true);
    const persistedId = await persist();
    setBusy(false);
    if (persistedId !== null) {
      setIssueErr(null);
      setShowIssue(true);
    }
  }

  /**
   * S4's confirm. An INVOICE issues through A11's `issue_invoice`, the verb that composes the guard,
   * the gap-free number, the QR reference and the balanced posting in one transaction (D14: the only
   * invoice-named write verbs are issue and send). Every other type rides A10's generic transition,
   * which posts nothing. The GUI never posts, numbers, or computes VAT itself.
   */
  async function confirmIssue() {
    if (workspaceId === null || docId === null) return;
    setBusy(true);
    setIssueErr(null);
    const { body } =
      type === 'invoice'
        ? await client.call('issue_invoice', {
            workspaceId,
            invoiceId: docId,
            idempotencyKey: idemKey('invoice-issue'),
          })
        : type === 'credit_note'
        ? await client.call('issue_credit_note', {
            workspaceId,
            creditNoteId: docId,
            idempotencyKey: idemKey('credit-note-issue'),
          })
        : await client.call('transition_document', {
            workspaceId,
            documentId: docId,
            to: 'issued',
            idempotencyKey: idemKey('doc-issue'),
          });
    if (isErr(body)) {
      setBusy(false);
      setIssueErr(body);
      return;
    }
    // F-03 (J3.5): the second half of the one act. The engine resolves the contact's address (no
    // typed email), `confirmed` is the person's press on "Ausstellen und senden", and a refusal
    // (no relay, no transport) leaves the invoice ISSUED and is reported on the detail with its
    // ways out, never as a lost invoice.
    let sendOutcome: SendOutcome | null = null;
    if (type === 'invoice' && sendAfterIssue && customerEmail !== null) {
      const sent = await client.call('send_invoice', {
        workspaceId,
        invoiceId: docId,
        confirmed: true,
        idempotencyKey: idemKey('invoice-send'),
      });
      sendOutcome = isErr(sent.body) ? { kind: 'failed', email: customerEmail, error: sent.body } : { kind: 'sent', email: customerEmail };
    }
    setBusy(false);
    setShowIssue(false);
    setDirty(false);
    // A10-D1/G2: from `/documents/new` the pathname changes and the route remounts on its own. From
    // `/documents/:id` it does NOT, so the parent is told the status moved and re-probes; the stale
    // editor is replaced by the immutable detail instead of lingering over a posted document.
    // The Commit moment (D122 D-I): the detail this lands on acknowledges the issue (a banner that
    // lands with its drawn check). From `/documents/new` the flag rides router state; from
    // `/documents/:id` the route wrapper carries it across the re-probe.
    if (onStatusChanged !== undefined) onStatusChanged(sendOutcome);
    else navigate(`/documents/${docId}`, { state: { justIssued: true, sendOutcome } });
  }

  async function onDelete() {
    if (workspaceId === null || docId === null) return;
    setConfirmDelete(false);
    setBusy(true);
    const { body } = await client.call('transition_document', {
      workspaceId,
      documentId: docId,
      to: 'cancelled',
      idempotencyKey: idemKey('doc-delete'),
    });
    setBusy(false);
    if (isErr(body)) setWriteErr(body);
    else {
      setDirty(false);
      navigate('/documents');
    }
  }

  /** The back link, guarded: an unsaved edit asks before it is dropped (A10-G9). */
  function onBack(event: { preventDefault: () => void }) {
    if (!dirty) return;
    event.preventDefault();
    setConfirmLeave(true);
  }

  if (workspaceId === null) {
    return (
      <div className="documents-editor">
        <p>{t('document.noWorkspaceHint')}</p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="documents-editor">
        <Skeleton rows={5} height={40} />
      </div>
    );
  }

  if (loadErr !== null) {
    return (
      <div className="documents-editor">
        <ErrorBanner error={loadErr} onRetry={() => navigate(0)} />
      </div>
    );
  }

  // The preconditions that block issuing, in the order an operator meets them. The FX ones are last
  // because they only exist once a foreign currency is chosen, and they only gate a POSTING type: a
  // quote in EUR needs no rate, since issuing one moves no money (M12 names the invoice case).
  const issueReason = !hasCustomer
    ? t('document.editor.reasonNoCustomer')
    : !hasLines
      ? t('document.editor.reasonNoLines')
      : posts && fx.kind === 'needs_rate'
        ? t('document.editor.reasonNeedsFxRate', { currency: fx.currency, date: formatDate(fx.date) })
        : posts && fx.kind === 'method_not_elected'
          ? t('document.editor.reasonFxMethod', { currency: fx.currency, taxPeriod: fx.taxPeriod })
          : null;

  return (
    <div className="documents-editor">
      {fromNumber !== undefined && (
        <ActionFeedback tone="info" message={t('document.detail.convertedToast', { number: fromNumber })} />
      )}

      <div className="documents-editor-head">
        <Link to="/documents" className="documents-back" onClick={onBack}>
          {t('document.action.back')}
        </Link>
        <h1 className="documents-editor-title">
          {t(typeKey(type))} {t('document.status.draft')}
        </h1>
        <div className="documents-editor-actions">
          {dirty && (
            <span className="documents-dirty" role="status">
              {t('document.dirty.indicator')}
            </span>
          )}
          {docId !== null && (
            <OverflowMenu
              label={t('document.rowActions', { name: t('document.status.draft') })}
              disabled={busy}
              items={[{ key: 'delete', label: t('document.action.delete'), onSelect: () => setConfirmDelete(true), danger: true }]}
            />
          )}
          <button type="button" className="btn btn--secondary" disabled={busy || denied} onClick={() => void onSaveDraft()}>
            {t('document.editor.saveDraft')}
          </button>
          <span className="documents-issue-wrap">
            <button
              type="button"
              className="btn btn--accent"
              disabled={busy || denied || issueReason !== null}
              onClick={() => void onIssueClick()}
            >
              {t('document.action.issue')}
            </button>
            {issueReason !== null && (
              <span className="documents-issue-reason" role="note">
                {issueReason}
              </span>
            )}
          </span>
        </div>
      </div>

      {denied && (
        <p className="documents-denied" role="alert">
          {t('document.denied')}
        </p>
      )}
      {writeErr !== null && <ErrorBanner error={writeErr} message={t('document.genericError')} />}

      <div className="documents-editor-meta">
        {forcedType === undefined && (
          <label className="documents-field">
            {/* A10-G10: the visible label reads the column word, matching the accessible name. */}
            <span>{t('document.column.type')}</span>
            <select
              value={type}
              onChange={(e) => {
                setType(e.target.value as DocumentType);
                setDirty(true);
              }}
              aria-label={t('document.column.type')}
              disabled={docId !== null}
            >
              {DOCUMENT_TYPES.map((tp) => (
                <option key={tp} value={tp}>
                  {t(typeKey(tp))}
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="documents-field documents-customer">
          <span>{t('document.editor.customer')}</span>
          {contacts.length === 0 && !canCreateContact ? (
            <span className="documents-no-contacts">
              {t('document.editor.noContacts')} <Link to="/contacts">{t('document.editor.toContacts')}</Link>
            </span>
          ) : (
            <>
              {contacts.length > 0 && (
                <select
                  value={contactId}
                  onChange={(e) => {
                    setContactId(e.target.value);
                    setDirty(true);
                  }}
                  aria-label={t('document.editor.customer')}
                  disabled={derived}
                >
                  <option value="">{t('document.editor.pickCustomer')}</option>
                  {contacts.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              )}
              {/* F-03 (J1.1 step 5): the customer created inline, the draft untouched. With no contact
                  at all the form is open at once (there is nothing to pick); otherwise one quiet
                  toggle reveals it. */}
              {canCreateContact && !derived && (contacts.length === 0 || newCustomerOpen ? (
                <span className="documents-new-customer">
                  {contacts.length === 0 && <span className="documents-no-contacts">{t('document.editor.noContactsInline')}</span>}
                  <input
                    type="text"
                    aria-label={t('document.editor.newCustomerName')}
                    placeholder={t('document.editor.newCustomerName')}
                    value={newCustomerName}
                    disabled={creatingCustomer}
                    onChange={(e) => setNewCustomerName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        void createCustomer();
                      }
                    }}
                  />
                  <button
                    type="button"
                    className="btn btn--secondary btn--sm"
                    disabled={creatingCustomer || newCustomerName.trim() === ''}
                    onClick={() => void createCustomer()}
                  >
                    {t('document.editor.createCustomer')}
                  </button>
                  {contacts.length > 0 && (
                    <button type="button" className="btn btn--ghost btn--sm" onClick={() => setNewCustomerOpen(false)}>
                      {t('document.editor.newCustomerCancel')}
                    </button>
                  )}
                </span>
              ) : (
                <button type="button" className="btn btn--ghost btn--sm" onClick={() => setNewCustomerOpen(true)}>
                  {t('document.editor.newCustomer')}
                </button>
              ))}
              {customerNote !== null && (
                <span className="documents-no-contacts" role="status">
                  {customerNote}
                </span>
              )}
            </>
          )}
        </div>
        <label className="documents-field">
          <span>{t('document.editor.date')}</span>
          <input
            type="date"
            value={date}
            onChange={(e) => {
              setDate(e.target.value);
              setDirty(true);
            }}
            aria-label={t('document.editor.date')}
          />
        </label>
        {/* M11-M13: the currency, and what it costs. The picker owns the QR consequence and the
            rate readout; the editor only owns what the choice means for issuing. */}
        <CurrencyPicker
          value={currency}
          onChange={(next) => {
            setCurrency(next);
            setDirty(true);
          }}
          baseCurrency={baseCurrency}
          iban={iban}
          issueDate={date}
          posts={posts}
          isInvoice={isInvoice}
          readOnly={denied || derived}
          onFxStateChange={setFx}
        />
      </div>

      {derived && (
        <p className="documents-derived-note" role="note">
          {t('creditNote.linesDerived')} {t('creditNote.changeSelectionHint')}
        </p>
      )}

      {derived ? (
        /* §4b.1: the derived positions render READ-ONLY, exactly the detail's table. There is no
           input on any line, so no save can rewrite the attribution the per-class closure rests on;
           changing the selection means deleting this draft and deriving a new one from the invoice. */
        <table className="documents-detail-lines">
          <caption className="visually-hidden">{t('document.detail.positions')}</caption>
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
            {lines.map((l) => (
              <tr key={l.key}>
                <td>{l.description}</td>
                <td className="t-num">{l.quantity}</td>
                <td className="documents-amount t-num">{formatMoney(parseMinor(l.unitPrice), currency)}</td>
                <td className="documents-amount t-num">{formatMoney(lineNet(l), currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
      <table className="documents-editor-lines">
        <caption className="visually-hidden">{t('document.detail.positions')}</caption>
        <thead>
          <tr>
            <th scope="col">{t('document.editor.description')}</th>
            <th scope="col">{t('document.editor.quantity')}</th>
            <th scope="col">{t('document.editor.unitPrice')}</th>
            <th scope="col">{t('document.editor.vat')}</th>
            <th scope="col" className="documents-amount">
              {t('document.editor.amount')}
            </th>
            <th scope="col">
              <span className="visually-hidden">{t('document.editor.addLine')}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l, i) => (
            <tr key={l.key}>
              <td>
                <input
                  type="text"
                  aria-label={`${t('document.editor.description')} ${i + 1}`}
                  placeholder={t('document.editor.descriptionPlaceholder')}
                  value={l.description}
                  onChange={(e) => updateLine(l.key, { description: e.target.value })}
                />
              </td>
              <td>
                <input
                  type="text"
                  inputMode="decimal"
                  className="documents-qty"
                  aria-label={`${t('document.editor.quantity')} ${i + 1}`}
                  value={l.quantity}
                  onChange={(e) => updateLine(l.key, { quantity: e.target.value })}
                />
              </td>
              <td>
                <input
                  type="text"
                  inputMode="decimal"
                  className="documents-price"
                  aria-label={`${t('document.editor.unitPrice')} ${i + 1}`}
                  value={l.unitPrice}
                  onChange={(e) => updateLine(l.key, { unitPrice: e.target.value })}
                />
              </td>
              <td>
                <TaxCodePicker
                  id={`doc-vat-${l.key}`}
                  ariaLabel={`${t('document.editor.vat')} ${i + 1}`}
                  codes={taxCodes}
                  value={l.taxCode}
                  onChange={(code) => updateLine(l.key, { taxCode: code, taxDefaulted: false })}
                  disabled={loading}
                  needsConfig={needsVatConfig}
                  invalidCode={l.taxCode !== '' && !taxCodes.some((c) => c.code === l.taxCode)}
                />
                {/* A11-G2: the draft's currency, the same one the row's amount beside it uses. A
                    draft has posted nothing, so no rate exists and the transaction currency is the
                    only figure there is to state. */}
                <LineVatReadout vat={lineVats[l.key]} currency={currency} />
              </td>
              <td className="documents-amount t-num">{formatMoney(lineNet(l), currency)}</td>
              <td>
                {lines.length > 1 && (
                  <button
                    type="button"
                    className="documents-line-remove"
                    aria-label={t('document.editor.removeLine', { number: i + 1 })}
                    onClick={() => setLines((prev) => prev.filter((x) => x.key !== l.key))}
                  >
                    <span aria-hidden="true">x</span>
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      )}

      {!derived && (
        <button type="button" className="btn btn--secondary btn--sm" onClick={() => setLines((prev) => [...prev, blankLine(defaultTaxCode)])}>
          {t('document.editor.addLine')}
        </button>
      )}

      <VatSummary summary={vatSummary} currency={currency} />

      <dl className="documents-editor-totals">
        <div>
          <dt>{t('document.editor.subtotal')}</dt>
          <dd className="t-num">{formatMoney(subtotalMinor, currency)}</dd>
        </div>
        <div>
          <dt>{t('document.editor.total')}</dt>
          <dd className="t-num">{formatMoney(totalMinor, currency)}</dd>
        </div>
      </dl>

      {isInvoice && (
        <>
          <InvoiceTerms
            issueDate={date}
            dueDate={dueDate}
            onDueDateChange={(iso) => {
              setDueDate(iso);
              setDirty(true);
            }}
            contact={selectedContact}
            disabled={denied}
          />
          {/* Readiness only, never a QR: the reference is seeded from the invoice number, which a
              draft does not have yet, so anything drawn here would change at issue. */}
          <QrReadinessPanel contact={selectedContact} iban={iban} currency={currency} issueDate={date} />
        </>
      )}

      <label className="documents-field documents-field--wide">
        <span>{t('document.editor.notes')}</span>
        <input
          type="text"
          value={notes}
          placeholder={t('document.editor.notesPlaceholder')}
          onChange={(e) => {
            setNotes(e.target.value);
            setDirty(true);
          }}
          aria-label={t('document.editor.notes')}
        />
      </label>

      {showIssue && (
        <IssueDialog
          posts={posts}
          isInvoice={type === 'invoice'}
          isCreditNote={type === 'credit_note'}
          totalMinor={totalMinor}
          taxMinor={vatSummary.totalTaxMinor}
          currency={currency}
          /* A11-G11: what this invoice loses, said where the decision is made rather than only in a
             panel below the fold. Derived from the same `qrReadiness` the panel renders. */
          qrGaps={
            isInvoice
              ? qrGapLines(qrReadiness({ contact: selectedContact, iban, currency, issueDate: date }))
              : []
          }
          sendTo={isInvoice ? customerEmail : null}
          sendChecked={sendAfterIssue}
          onSendChange={setSendAfterIssue}
          busy={busy}
          error={issueErr}
          onConfirm={() => void confirmIssue()}
          onCancel={() => setShowIssue(false)}
        />
      )}

      {confirmDelete && (
        <ConfirmDialog
          message={t('document.action.deleteDraftConfirm')}
          confirmLabel={t('document.action.delete')}
          onConfirm={() => void onDelete()}
          onCancel={() => setConfirmDelete(false)}
        />
      )}

      {confirmLeave && (
        <ConfirmDialog
          message={t('document.dirty.confirm')}
          confirmLabel={t('document.dirty.discard')}
          cancelLabel={t('document.dirty.keep')}
          onConfirm={() => {
            setConfirmLeave(false);
            setDirty(false);
            navigate('/documents');
          }}
          onCancel={() => setConfirmLeave(false)}
        />
      )}
    </div>
  );
}
