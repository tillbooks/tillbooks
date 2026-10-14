/**
 * S2, the DocumentEditor (full-page, U2): compose a draft, see totals and VAT live, and issue it.
 *
 * A full-page route (not a drawer): the editor carries a positions grid, a live VAT summary, and the
 * issue action, which is a page, not an overlay. It reuses the A06 controls unchanged (TaxCodePicker,
 * LineVatReadout, VatSummary) so a document line's tax preview is the SAME `vat_preview` code path the
 * Journal drawer and an agent use (US-A06.7). D152 (cognitive load): Ausstellen appears once a
 * customer is chosen, never as a grey button beside the Kunde control that unlocks it (rule 3); a
 * precondition still unmet at that point (no positions, a position without an amount, no rate) is
 * named in one line at the moment of the press, before anything is saved. The VAT summary and the
 * QR readiness appear once there is a customer and an amount (rule 2), an untouched due date is
 * stated as what the issue derives from the customer's terms (rule 1, never stored as a guess), and
 * explanations sit behind an (i) (rule 4). Saving
 * persists the draft (create then patch); issuing opens S4 and, on confirm, transitions to issued.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';

import { useClient } from '../../lib/client-context';
import { useCan, CAP } from '../../lib/capabilities';
import { isErr, type Err } from '../../lib/client';
import { useWorkspaceId } from '../../app/workspace';
import { useT, formatDate, formatMoney } from '../../i18n';
import { ErrorBanner, Skeleton } from '../../components/states';
import { OverflowMenu } from '../../components/OverflowMenu';
import { Select } from '../../components/Select';
import { CloseGlyph } from '../../components/icons';
import { ActionFeedback } from '../../components/ActionFeedback';
import { ConfirmDialog } from '../Accounts/ConfirmDialog';
import { TaxCodePicker } from '../Vat/TaxCodePicker';
import { LineVatReadout } from '../Vat/LineVatReadout';
import { VatSummary } from '../Vat/VatSummary';
import type { LineVat, VatCode } from '../Vat/types';
import { summariseVat, contributionOf } from '../Vat/summary';
import '../Vat/Vat.css';
import { IssueDialog } from './IssueDialog';
import { InvoiceTerms, QrReadinessPanel } from './InvoiceEditor';
import { CurrencyPicker } from './CurrencyPicker';
import type { FxState } from './currency';
import { dueDateDerivation, qrGapLines, qrReadiness, type ContactAddress, type CreditorView, type InvoiceContact } from './invoice';
import { initialQrFixValues, type QrFixCall, type QrFixNeeds } from './QrCompletion';
import {
  DOCUMENT_TYPES,
  idemKey,
  lineTotalMinor,
  parseMilli,
  parseMinor,
  typeKey,
  effectiveSupplyDate,
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
  /**
   * The line's OWN Leistungsdatum, exactly as stored on the line, or null for a line that follows the
   * document's Datum ("Datum unless stated", D164). A line date is a statement by where it is stored
   * (an agent or MCP caller, a derived Gutschrift's pin, a date the old editor stamped, which cannot be
   * told apart and is therefore shown as stated too); the editor never writes the Datum into a line.
   * The line's priced date is `supplyDateOf`, nowhere else.
   */
  supplyDate: string | null;
}

let lineSeq = 0;
function blankLine(taxCode = ''): DraftLine {
  lineSeq += 1;
  return { key: `dl${lineSeq}`, description: '', quantity: '1', unitPrice: '', taxCode, taxDefaulted: true, supplyDate: null };
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

/**
 * The editor, keyed by the workspace. Surfaces do not remount on a workspace switch, and a draft is
 * one workspace's draft: its customer list, tax codes, IBAN, typed lines and inferred due date all
 * belong to the books it was opened in. Keying the body by `workspaceId` drops every one of them on
 * a switch, and the body's own `alive` guard keeps a write answered after the switch from navigating
 * or reporting in the new workspace.
 */
export function DocumentEditor(props: DocumentEditorProps = {}) {
  const workspaceId = useWorkspaceId();
  return <DocumentEditorBody key={workspaceId ?? ''} {...props} />;
}

function DocumentEditorBody({ onStatusChanged, forcedType }: DocumentEditorProps) {
  const t = useT();
  const client = useClient();
  const workspaceId = useWorkspaceId();
  // False once this body unmounts (a workspace switch, a route change). An answer that arrives after
  // that belongs to an editor nobody is looking at: it must not navigate or call the parent.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
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
  // D164: the Datum IS the document-level Leistungsdatum (`document.supplyDate`). True once the
  // person set it, or when the loaded document carries one. Untouched, it is today, the date the
  // engine will issue (and price every undated line) at, and nothing is written.
  const [dateStated, setDateStated] = useState(false);
  // F2 (critic round 4): the one line said when an untouched Datum moved to a new day under an open
  // editor, so the figures were priced again before any confirm.
  const [dayNote, setDayNote] = useState<string | null>(null);
  const [dueDate, setDueDate] = useState('');
  // True once the due date is a decision: typed or cleared by the person, or stored on a loaded draft
  // (the editor never stores a guess, so a stored date was set by someone). Until then the field is
  // empty, nothing is sent, and the hint says what the engine derives at issue (F3).
  const [dueDateTouched, setDueDateTouched] = useState(false);
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
  // P0.4e: the workspace's own creditor name and address, from the same profile read, so the issue
  // dialog knows whether the QR-bill would be refused `needs_creditor_address` and can ask for it.
  // Null until the read answers: an unknown creditor is never reported as a gap.
  const [creditor, setCreditor] = useState<CreditorView | null>(null);
  const [companyName, setCompanyName] = useState<string | null>(null);
  // The workspace default Zahlungsfrist from the Firmenprofil: a number, null when none is set, and
  // undefined while unread or after a failed read, so the hint never states a default it does not know.
  const [workspaceTermsDays, setWorkspaceTermsDays] = useState<number | null | undefined>(undefined);
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
  // True after a press on Ausstellen that a visible precondition refused: the reason line shows until
  // the precondition clears (then the next press acts) or the person presses again.
  const [issueAttempted, setIssueAttempted] = useState(false);
  // Each line's `vat_preview` answer WITH the inputs it answered (code, net, date), so the editor can
  // tell a current answer from one a keystroke has already overtaken.
  const [lineVats, setLineVats] = useState<Record<string, { sig: string; vat: LineVat }>>({});
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
  // Critic F7, narrowed by the wave B-2 lesson: one key per ACT. A retry of the SAME name after a
  // failed or lost answer replays the same create_contact instead of minting a second "Bergblick
  // AG"; a changed name is a new act. Once a create has answered, the act is over: a later create of
  // the same name (the first one archived meanwhile) is a new act with a new key, never a replay of
  // the stored contact. `useIdempotencyKey` keyed on the name would replay it.
  const customerAct = useRef<{ name: string; key: string } | null>(null);
  const [creatingCustomer, setCreatingCustomer] = useState(false);
  const [customerNote, setCustomerNote] = useState<string | null>(null);

  async function createCustomer() {
    const name = newCustomerName.trim();
    if (workspaceId === null || name === '' || creatingCustomer) return;
    setCreatingCustomer(true);
    setCustomerNote(null);
    if (customerAct.current === null || customerAct.current.name !== name) {
      customerAct.current = { name, key: idemKey('contact-create') };
    }
    const { body } = await client.call('create_contact', {
      workspaceId,
      partyRole: 'customer',
      name,
      idempotencyKey: customerAct.current.key,
    });
    setCreatingCustomer(false);
    if (isErr(body)) {
      setCustomerNote(t('document.editor.customerCreateFailed'));
      return;
    }
    customerAct.current = null;
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
      // A default read for another workspace is never this one's (the surface may not remount).
      setWorkspaceTermsDays(undefined);
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
            setWorkspaceTermsDays(undefined);
            return;
          }
          const profile = body.profile as
            | {
                creditorIban?: string | null;
                baseCurrency?: string | null;
                creditorName?: string | null;
                creditorAddress?: unknown;
                name?: string | null;
                defaultPaymentTermsDays?: number | null;
              }
            | undefined;
          const stored = profile?.creditorIban ?? null;
          setIban(stored !== null && stored.trim() !== '' ? stored : null);
          setCreditor({ name: profile?.creditorName ?? null, address: profile?.creditorAddress ?? null });
          setCompanyName(profile?.name ?? null);
          // The workspace default Zahlungsfrist, the rule's second step (`dueDateDerivation`).
          setWorkspaceTermsDays(typeof profile?.defaultPaymentTermsDays === 'number' ? profile.defaultPaymentTermsDays : null);
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
          (async () => {
            const { body } = await client.call('get_document', { workspaceId, documentId: id });
            if (!live) return;
            if (isErr(body)) {
              setLoadErr(body);
              return;
            }
            const doc = body.document as DocumentDto;
            const docLines =
              (body.lines as {
                description: string | null;
                quantityMilli: number;
                unitPriceMinor: number;
                taxCode: string | null;
                supplyDate?: string | null;
              }[]) ?? [];
            // D164: the Datum is the document's own Leistungsdatum, when somebody stated one.
            const documentDate = typeof doc.supplyDate === 'string' && doc.supplyDate !== '' ? doc.supplyDate.slice(0, 10) : null;
            if (documentDate !== null) {
              setDate(documentDate);
              setDateStated(true);
            }
            setType(doc.type);
            setContactId(doc.contactId ?? '');
            setCreditedDocumentId(doc.creditedDocumentId ?? null);
            setCurrency(doc.currency);
            setDueDate(doc.dueDate ?? '');
            // A stored due date is a decided one; a draft saved without one leaves it to the issue.
            setDueDateTouched(doc.dueDate !== null && doc.dueDate !== undefined && doc.dueDate !== '');
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
                    // Every stored line date is a statement by where it is stored (D164).
                    supplyDate: typeof l.supplyDate === 'string' && l.supplyDate !== '' ? l.supplyDate.slice(0, 10) : null,
                  };
                }),
              );
            }
          })(),
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
  // not refetch. Same code path as the agent and the Journal readout (US-A06.7), and the same one the
  // posting runs: `issue_invoice` expands each position through `buildVatLines`, which prices it with
  // `computeLineTax`, the function behind `vat_preview`, on the same net and the same supply date this
  // editor sends with each line. The summary is the sum of those per-line answers, never a second
  // computation.
  /**
   * The date a line is priced at: `effectiveSupplyDate`, the engine's own rule, with the document date
   * the person stated (or none) and today's Datum as the issue date the engine would stamp now.
   */
  const supplyDateOf = useCallback(
    (l: DraftLine) => effectiveSupplyDate(l, { supplyDate: dateStated ? date : null }, date) ?? date,
    [date, dateStated],
  );
  const lineSig = useCallback((l: DraftLine) => `${l.taxCode}:${lineNet(l)}:${supplyDateOf(l)}`, [lineNet, supplyDateOf]);
  const vatSignature = lines.map((l) => `${l.key}:${lineSig(l)}`).join('|');
  // F2 (critic): a preview whose answer was lost is asked again when the person presses Ausstellen,
  // without having to edit the line. The press bumps this token; the effect re-asks every line.
  const [vatRetry, setVatRetry] = useState(0);
  useEffect(() => {
    if (workspaceId === null) return;
    let live = true;
    async function run() {
      const results: Record<string, { sig: string; vat: LineVat }> = {};
      await Promise.all(
        lines.map(async (l) => {
          if (l.taxCode === '') return;
          const amountMinor = lineNet(l);
          if (amountMinor <= 0) return;
          // F3 (critic round 5): an emptied Datum gives a line without its own date no date to be
          // priced at. Asking anyway earns `invalid_date`, which the line readout can only word as a
          // code problem; the press names the missing Datum instead (`reasonNoDate`).
          if (supplyDateOf(l) === '') return;
          const sig = lineSig(l);
          const { body } = await client.call('vat_preview', {
            workspaceId,
            amountMinor,
            amountIsGross: false,
            taxCode: l.taxCode,
            supplyDate: supplyDateOf(l),
          });
          results[l.key] = { sig, vat: body as LineVat };
        }),
      );
      if (live) setLineVats(results);
    }
    void run();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vatSignature, vatRetry]);

  /** The line's answer, only while it answers the line as it stands now (code, net, date). */
  const currentAnswer = (l: DraftLine): LineVat | undefined => {
    if (l.taxCode === '' || lineNet(l) <= 0) return undefined;
    const answer = lineVats[l.key];
    return answer !== undefined && answer.sig === lineSig(l) ? answer.vat : undefined;
  };

  // F4 (critic): the summary counts CURRENT answers only. A line switched to "Keine MWST", or given a
  // new amount, no longer carries the tax its old answer named while another line's preview is out.
  const vatSummary = useMemo(() => {
    const contribs = lines
      .map((l) => contributionOf(currentAnswer(l)))
      .filter((c): c is NonNullable<typeof c> => c !== null);
    return summariseVat(contribs);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lines, lineVats, date]);

  // The summary speaks only once every taxed line with an amount has its CURRENT answer, and every
  // answer is a figure. Before this, a line carrying UST81 whose preview had not answered yet (or had
  // no amount, or had failed) contributed nothing, and the summary said "Keine MWST auf diesem Beleg"
  // about a taxed document. A line with no code (Keine MWST, chosen) is settled by definition.
  const vatSettled = lines.every((l) => {
    if (l.taxCode === '' || lineNet(l) <= 0) return true;
    return currentAnswer(l)?.ok === true;
  });
  /** The engine's error on a line's current answer, or null when it is a figure or not there yet. */
  const answerError = (l: DraftLine): string | null => {
    const answer = currentAnswer(l);
    if (answer === undefined || answer.ok === true) return null;
    const error = (answer as { error?: unknown }).error;
    return typeof error === 'string' ? error : 'unknown';
  };
  // Critic R2-2: a member who may issue but may not read VAT (D50) gets `permission_denied` from
  // vat_preview. That is no preview AVAILABLE, not a refusal of the line: the engine computes the tax
  // at issue as always. Such an editor states no tax, no Total and no posting figure anywhere.
  const vatHidden = lines.some((l) => answerError(l) === 'permission_denied');
  // A current answer that is a refusal from the engine (an unknown code, a date before the earliest
  // rate era) will not settle by asking again; a lost answer (`transport_error`) will.
  const vatRefusedLine = lines.findIndex((l) => {
    const error = answerError(l);
    return error !== null && error !== 'transport_error' && error !== 'permission_denied';
  });
  // Every taxed line either has its figure or has none to have (denied): nothing is still out.
  const vatResolved = lines.every((l) => {
    if (l.taxCode === '' || lineNet(l) <= 0) return true;
    const answer = currentAnswer(l);
    return answer !== undefined && (answer.ok === true || answerError(l) === 'permission_denied');
  });
  /** The figures may be stated (summary, Total, confirm): every tax is the engine's current answer. */
  const figuresKnown = vatSettled && !vatHidden;

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
  // D152 rule 2: the VAT summary and the QR readiness speak about a customer and an amount, so they
  // appear once both exist. Before that, the QR panel warned about the address of nobody.
  const hasAmount = subtotalMinor > 0;
  const showFigures = hasCustomer && hasAmount;
  // F3 (critic, owner's choice of workspace default terms): the due date of an untouched field is
  // derived by the ENGINE at issue, from the issue date it stamps and the customer's terms (or the
  // workspace default). The editor never stores a guess: it sends a due date only when the person
  // set one, and says what the issue will derive as a hint, counted from the issue date.
  /** The due date on the wire: the person's own, or none (develop sent none for an untouched field). */
  const dueOnWire = dueDateTouched && dueDate !== '' ? dueDate : null;
  const customerEmail = typeof selectedContact?.email === 'string' && selectedContact.email.trim() !== '' ? selectedContact.email.trim() : null;

  // P0.4e: ONE readiness for the panel and the issue dialog, the creditor's own address included. The
  // dialog asks for a gap only while a payment part is possible at all (CHF/EUR, not the v2.4 CHF-only
  // case): typing an address cannot give an unsupported currency a QR-bill.
  const readiness = qrReadiness({ contact: selectedContact, iban, currency, issueDate: date, creditor });
  const qrPossible = readiness.consequence.kind === 'qr' || readiness.consequence.kind === 'no_iban';
  const qrFixNeeds: QrFixNeeds = {
    iban: qrPossible && readiness.consequence.kind === 'no_iban',
    creditorAddress: qrPossible && readiness.missingCreditorAddress,
    customer:
      qrPossible && selectedContact !== undefined && readiness.missingCustomerAddress.length > 0
        ? { contactId: selectedContact.id, name: selectedContact.name }
        : null,
  };

  /**
   * Run the completion form's calls through the verbs that own the data (A00's creditor profile,
   * A09's contact), in order, stopping at the first refusal. Each success is mirrored into this
   * editor's own state, so the readiness panel and a second confirm see the fixed values at once.
   */
  async function saveQrFix(calls: QrFixCall[]): Promise<Err | null> {
    if (workspaceId === null) return null;
    for (const call of calls) {
      if (call.action === 'set_creditor_profile') {
        const { body } = await client.call('set_creditor_profile', { workspaceId, ...call.input });
        if (isErr(body)) return body;
        const input = call.input as { iban?: unknown; creditorName?: unknown; address?: unknown };
        if (typeof input.iban === 'string') setIban(input.iban);
        if (input.address !== undefined) {
          setCreditor((prev) => ({
            name: typeof input.creditorName === 'string' ? input.creditorName : (prev?.name ?? null),
            address: input.address,
          }));
        }
      } else {
        const { body } = await client.call('update_contact', { workspaceId, ...call.input });
        if (isErr(body)) return body;
        const input = call.input as { contactId: string; patch: { address: ContactAddress } };
        setContacts((prev) => prev.map((c) => (c.id === input.contactId ? { ...c, address: input.patch.address } : c)));
      }
    }
    return null;
  }

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
      // D164: a line carries ONLY its own stated date. The Datum travels as the document's
      // `supplyDate`, never copied into a line.
      if (l.supplyDate !== null) out.supplyDate = l.supplyDate;
      return out;
    });
  }

  /**
   * The act of creating THIS draft (wave B-2 lesson: one key per act). The key is minted at the
   * first save and reused only while that act is unanswered: a lost answer (`transport_error`) may
   * have created the draft, and the retry under the same key replays it instead of creating a second
   * one. A definite answer ends the act: on success the draft exists and every later save is an
   * update; on a refusal the engine has memoised that refusal under the key, so the next save is a
   * new act with a new key. `sig` is the content the act first sent, see the follow-up below.
   */
  const createAct = useRef<{ key: string; sig: string } | null>(null);
  // F1 (critic): true from the first create attempt until the engine gives a definite answer. While
  // it is open the Typ control is locked: the retry replays whatever type the first attempt stored,
  // and no later patch can change a type.
  const [createPending, setCreatePending] = useState(false);
  // F1: the one line said when the engine's stored type differs from the editor's (a replay).
  const [typeNote, setTypeNote] = useState<string | null>(null);

  /** Persist the draft: create the first time, patch thereafter. Returns the doc id, or null on error. */
  const persist = useCallback(async (): Promise<string | null> => {
    if (workspaceId === null) return null;
    setWriteErr(null);
    if (docId === null) {
      const content = {
        type,
        contactId: contactId === '' ? undefined : contactId,
        currency,
        // D164: the Datum as the document-level Leistungsdatum, only when the person stated it.
        ...(dateStated && date !== '' ? { supplyDate: date } : {}),
        ...(dueOnWire === null ? {} : { dueDate: dueOnWire }),
        notes,
        lines: buildLinePayload(),
      };
      const sig = JSON.stringify(content);
      if (createAct.current === null) createAct.current = { key: idemKey('doc-create'), sig };
      const act = createAct.current;
      setCreatePending(true);
      const { body } = await client.call('create_document', { workspaceId, ...content, idempotencyKey: act.key });
      if (isErr(body)) {
        if (body.error !== 'transport_error') {
          createAct.current = null;
          setCreatePending(false);
        }
        if (body.error === 'permission_denied') setDenied(true);
        else setWriteErr(body);
        return null;
      }
      createAct.current = null;
      setCreatePending(false);
      const stored = body.document as DocumentDto;
      const newId = stored.id;
      setDocId(newId);
      // F1: a replay hands back the draft the FIRST attempt stored, type included, and a type is
      // never patchable. The engine's type is the truth: the editor adopts it and says so, and this
      // act stops here, so nothing is issued under a type the document does not have.
      const adopted = typeof stored.type === 'string' && stored.type !== type ? (stored.type as DocumentType) : null;
      if (adopted !== null) {
        setType(adopted);
        setTypeNote(t('document.editor.typeAdopted', { type: t(typeKey(adopted)) }));
      }
      // The retry of a lost create replays whatever the FIRST attempt stored. If the person changed
      // the draft in between, that stored draft is the older content, so the screen's content is
      // written over it at once. Otherwise "saved" would describe a draft the engine does not hold.
      if (act.sig !== sig) {
        const { body: patched } = await client.call('update_document', {
          workspaceId,
          documentId: newId,
          patch: {
            contactId: contactId === '' ? null : contactId,
            currency,
            supplyDate: dateStated && date !== '' ? date : null,
            dueDate: dueOnWire,
            notes,
            lines: content.lines,
          },
          idempotencyKey: idemKey('doc-update'),
        });
        if (isErr(patched)) {
          if (patched.error === 'permission_denied') setDenied(true);
          else setWriteErr(patched);
          return null;
        }
      }
      setDirty(false);
      if (adopted !== null) return null;
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
        ? { dueDate: dueOnWire, notes }
        : {
            contactId: contactId === '' ? null : contactId,
            currency,
            // D164: the stated Datum, or null when it is today's untouched default.
            supplyDate: dateStated && date !== '' ? date : null,
            dueDate: dueOnWire,
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
  }, [client, workspaceId, docId, type, contactId, currency, dueOnWire, notes, lines, date, dateStated]);

  async function onSaveDraft() {
    setBusy(true);
    await persist();
    setBusy(false);
  }

  async function onIssueClick() {
    // F2 (critic round 4): an untouched Datum is "today", the date the engine stamps at issue. If the
    // day moved under an open editor (31.12. at night, Ausstellen the next morning), the figures on
    // screen were priced at yesterday. Move the Datum to today, let the previews answer for it, and
    // say so in one line: no confirm opens with figures priced at a day the engine will not use.
    const today = todayIso();
    if (!dateStated && date !== today) {
      setDate(today);
      setDayNote(t('document.editor.dayMoved', { date: formatDate(today) }));
      setIssueAttempted(false);
      return;
    }
    setDayNote(null);
    // D152 rule 3: a refusal the editor can already see is said in one line at the press, and
    // nothing is saved or opened. The engine still owns every one of these refusals.
    if (issueReason !== null) {
      setIssueAttempted(true);
      // F2: a lost preview is asked again by this press; the refusal line stands until it settles.
      if (!vatResolved) setVatRetry((n) => n + 1);
      return;
    }
    setIssueAttempted(false);
    setTypeNote(null);
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
    // Issued in the workspace it was pressed in. If the person switched meanwhile, this editor is
    // gone: navigating now would open that document's id inside the other workspace's books.
    if (!alive.current) return;
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
    if (!alive.current) return;
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

  // The preconditions that refuse issuing once a customer is chosen, in the order an operator meets
  // them. A position without an amount refuses an INVOICE (the engine answers `invalid_line`: a
  // zero line cannot post), so it is named here by its number instead of after the save. The FX
  // ones are last because they only exist once a foreign currency is chosen, and they only gate a
  // POSTING type: a quote in EUR needs no rate, since issuing one moves no money (M12).
  const zeroLine = isInvoice ? lines.findIndex((l) => filledLines.includes(l) && lineNet(l) <= 0) : -1;
  // F3 (critic round 4): a line with no date of its own, on a document whose Datum nobody stated, is
  // priced at the issue date; for a workspace code whose stored rate belongs to another era (a UST77
  // kept for old supplies) the engine refuses that (`needs_supply_date`), because only a person can
  // say which era the supply belongs to. The same comparison the engine makes (the code's stored rate
  // against the rate the issue date's era gives it, which is the preview's answer) names the position
  // here, before the confirm, instead of behind it.
  const historicLine = lines.findIndex((l) => {
    if (l.supplyDate !== null || dateStated || l.taxCode === '' || lineNet(l) <= 0) return false;
    const answer = currentAnswer(l);
    const code = taxCodes.find((c) => c.code === l.taxCode);
    return answer !== undefined && answer.ok === true && code !== undefined && answer.rateBp !== code.rateBp;
  });
  // F2 (critic): no confirm may state a figure the engine will not post, so a POSTING type (R2-3: a
  // quote or an order posts nothing and states no figure) issues only once every taxed line's tax is
  // the engine's current answer, or, for a member without read_vat, known to be unavailable (R2-2).
  // F3 (critic round 5): an emptied Datum leaves every line without its own date undated, so nothing
  // can be priced or confirmed; the press says so in one line.
  const noDate = date === '' && lines.some((l) => l.supplyDate === null && lineNet(l) > 0);
  const issueReason = !hasLines
    ? t('document.editor.reasonNoLines')
    : noDate
      ? t('document.editor.reasonNoDate')
    : zeroLine >= 0
      ? t('document.editor.reasonZeroLine', { number: zeroLine + 1 })
      : posts && vatRefusedLine >= 0
        ? t('document.editor.reasonVatRefused', { number: vatRefusedLine + 1 })
      : posts && !vatResolved
        ? t('document.editor.reasonVatPending')
      : posts && historicLine >= 0
        ? t('document.editor.reasonNeedsSupplyDate', { number: historicLine + 1, code: lines[historicLine]?.taxCode ?? '' })
      : posts && fx.kind === 'needs_rate'
        ? t('document.editor.reasonNeedsFxRate', { currency: fx.currency, date: formatDate(fx.date) })
        : posts && fx.kind === 'method_not_elected'
          ? t('document.editor.reasonFxMethod', { currency: fx.currency, taxPeriod: fx.taxPeriod })
          : null;
  // Once the refused precondition clears, the press is spent: a later, different gap is said at the
  // next press, not the moment it appears. (State adjusted during render, React's derived-state way.)
  if (issueAttempted && issueReason === null) setIssueAttempted(false);
  const shownIssueReason = issueAttempted ? issueReason : null;

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
          {/* D152 rule 3: no Ausstellen before a customer. The Kunde control that unlocks it sits right
              below, and a grey button with a sentence beside its own unlocker is load, not help. */}
          {hasCustomer && (
            <span className="documents-issue-wrap">
              {/* The tinted `.btn--accent` only where issuing POSTS (an invoice or a credit note,
                  K-08, D137). Issuing a quote or an order books nothing, so it is the editor's one
                  primary. */}
              <button
                type="button"
                className={posts ? 'btn btn--accent' : 'btn btn--primary'}
                data-money-commit={posts ? 'issue_invoice issue_credit_note' : undefined}
                disabled={busy || denied}
                aria-describedby={shownIssueReason !== null ? 'documents-issue-reason' : undefined}
                onClick={() => void onIssueClick()}
              >
                {t('document.action.issue')}
              </button>
              {shownIssueReason !== null && (
                <span id="documents-issue-reason" className="documents-issue-reason" role="alert">
                  {shownIssueReason}
                </span>
              )}
            </span>
          )}
        </div>
      </div>

      {denied && (
        <p className="documents-denied" role="alert">
          {t('document.denied')}
        </p>
      )}
      {writeErr !== null && <ErrorBanner error={writeErr} message={t('document.genericError')} />}
      {typeNote !== null && (
        <p className="documents-type-note" role="alert">
          {typeNote}
        </p>
      )}
      {dayNote !== null && (
        <p className="documents-type-note" role="alert">
          {dayNote}
        </p>
      )}

      <div className="documents-editor-meta">
        {forcedType === undefined && (
          <div className="documents-field">
            {/* A10-G10: the visible label reads the column word, matching the accessible name. */}
            <span>{t('document.column.type')}</span>
            <Select
              value={type}
              onChange={(value) => {
                setType(value as DocumentType);
                setDirty(true);
              }}
              options={DOCUMENT_TYPES.map((tp) => ({ value: tp, label: t(typeKey(tp)) }))}
              ariaLabel={t('document.column.type')}
              disabled={docId !== null || createPending}
            />
          </div>
        )}
        <div className="documents-field documents-customer">
          <span>{t('document.editor.customer')}</span>
          {contacts.length === 0 && !canCreateContact ? (
            <span className="documents-no-contacts">
              {t('document.editor.noContacts')} <Link className="link-inline" to="/contacts">{t('document.editor.toContacts')}</Link>
            </span>
          ) : (
            <>
              {contacts.length > 0 && (
                <Select
                  value={contactId}
                  onChange={(value) => {
                    setContactId(value);
                    setDirty(true);
                  }}
                  options={[
                    { value: '', label: t('document.editor.pickCustomer') },
                    ...contacts.map((c) => ({ value: c.id, label: c.name })),
                  ]}
                  ariaLabel={t('document.editor.customer')}
                  disabled={derived}
                />
              )}
              {/* F-03 (J1.1 step 5): the customer created inline, the draft untouched. With no contact
                  at all the form is open at once (there is nothing to pick); otherwise one quiet
                  toggle reveals it. */}
              {canCreateContact && !derived && (contacts.length === 0 || newCustomerOpen ? (
                <span className="documents-new-customer">
                  {contacts.length === 0 && <span className="documents-no-contacts">{t('document.editor.noContactsInline')}</span>}
                  <input className="field"
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
          <input className="field"
            type="date"
            value={date}
            onChange={(e) => {
              setDate(e.target.value);
              setDateStated(true);
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
                <td>
                  {l.description}
                  {/* A derived Gutschrift's dates are pinned by createCreditNote: shown, never editable. */}
                  {l.supplyDate !== null && (
                    <span className="documents-line-supply">{t('document.editor.lineSupplyDate', { date: formatDate(l.supplyDate) })}</span>
                  )}
                </td>
                <td className="t-num">{l.quantity}</td>
                <td className="documents-amount t-num t-money">{formatMoney(parseMinor(l.unitPrice), currency)}</td>
                <td className="documents-amount t-num t-money">{formatMoney(lineNet(l), currency)}</td>
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
                <input className="field"
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
                  className="field documents-qty"
                  aria-label={`${t('document.editor.quantity')} ${i + 1}`}
                  value={l.quantity}
                  onChange={(e) => updateLine(l.key, { quantity: e.target.value })}
                />
              </td>
              <td>
                <input
                  type="text"
                  inputMode="decimal"
                  className="field documents-price"
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
                {/* Only the line's CURRENT answer, and never a lost or a denied one: those are not
                    statements about the code, which is all this readout can word an error as. */}
                <LineVatReadout
                  vat={answerError(l) === 'transport_error' || answerError(l) === 'permission_denied' ? undefined : currentAnswer(l)}
                  currency={currency}
                />
                {l.supplyDate !== null && (
                  <span className="documents-line-supply">
                    {t('document.editor.lineSupplyDate', { date: formatDate(l.supplyDate) })}{' '}
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm documents-line-supply-reset"
                      aria-label={t('document.editor.lineSupplyReset', { number: i + 1 })}
                      onClick={() => updateLine(l.key, { supplyDate: null })}
                    >
                      {t('document.editor.lineSupplyResetShort')}
                    </button>
                  </span>
                )}
              </td>
              <td className="documents-amount t-num t-money">{formatMoney(lineNet(l), currency)}</td>
              <td>
                {lines.length > 1 && (
                  <button
                    type="button"
                    className="btn btn--ghost btn--icon"
                    aria-label={t('document.editor.removeLine', { number: i + 1 })}
                    onClick={() => setLines((prev) => prev.filter((x) => x.key !== l.key))}
                  >
                    <CloseGlyph size={14} />
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

      {/* F6 (critic): the figures get their own (visually hidden) h2, so the summary's h3 is not a
          heading level skipped under the page's h1. */}
      <div className="documents-editor-figures">
      <h2 className="visually-hidden">{t('document.editor.figures')}</h2>
      {showFigures && figuresKnown && <VatSummary summary={vatSummary} currency={currency} />}

      <dl className="documents-editor-totals">
        <div>
          <dt>{t('document.editor.subtotal')}</dt>
          <dd className="t-num t-money">{formatMoney(subtotalMinor, currency)}</dd>
        </div>
        {/* F2 (critic): the Total includes the engine's tax, so it is stated only once every taxed
            line's tax is a current answer; until then it says it is being worked out. R2-2: for a
            member who may not read VAT there is no Total here at all; the engine states it at issue. */}
        {!vatHidden && (
          <div>
            <dt>{t('document.editor.total')}</dt>
            <dd className="t-num t-money">
              {vatSettled ? formatMoney(totalMinor, currency) : <span className="documents-total-pending">{t('document.editor.totalPending')}</span>}
            </dd>
          </div>
        )}
      </dl>
      </div>

      {isInvoice && (
        <>
          <InvoiceTerms
            dueDate={dueDateTouched ? dueDate : ''}
            onDueDateChange={(iso) => {
              setDueDate(iso);
              setDueDateTouched(true);
              setDirty(true);
            }}
            derivedFrom={dueDateTouched ? null : dueDateDerivation(selectedContact, workspaceTermsDays)}
            disabled={denied}
          />
          {/* Readiness only, never a QR: the reference is seeded from the invoice number, which a
              draft does not have yet, so anything drawn here would change at issue. */}
          {showFigures && (
            <QrReadinessPanel contact={selectedContact} iban={iban} currency={currency} issueDate={date} creditor={creditor} />
          )}
        </>
      )}

      <label className="documents-field documents-field--wide">
        <span>{t('document.editor.notes')}</span>
        <input className="field"
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
          /* R2-2: without read_vat the confirm states no amount; the engine computes it at issue. */
          figuresKnown={figuresKnown}
          /* F3: a due date the person set before the date the engine stamps at issue is said here,
             on the last screen, because the invoice is overdue from the moment it exists. */
          notices={
            isInvoice && dueOnWire !== null && dueOnWire < todayIso()
              ? [t('invoice.issue.dueBeforeIssue', { due: formatDate(dueOnWire) })]
              : []
          }
          taxMinor={vatSummary.totalTaxMinor}
          currency={currency}
          /* A11-G11: what this invoice loses, said where the decision is made rather than only in a
             panel below the fold. Derived from the same `qrReadiness` the panel renders. */
          qrGaps={isInvoice ? qrGapLines(readiness) : []}
          /* P0.4e: ask for the missing creditor address, IBAN and customer address right here. The
             starting values are what is already stored, so only the gaps need typing. */
          qrFix={
            isInvoice
              ? {
                  needs: qrFixNeeds,
                  initial: initialQrFixValues({ creditor, companyName, customerAddress: selectedContact?.address }),
                  onSave: saveQrFix,
                }
              : undefined
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
