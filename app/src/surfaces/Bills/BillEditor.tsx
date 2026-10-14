/**
 * The BillEditor drawer: capture a supplier bill, see exactly what it will book, and post it.
 *
 * THIS IS ALSO THE EXPENSE FORM A06 POSTS THROUGH (A17 §Stack-landing), which is why it is one drawer
 * and not two: an "expense" and a "supplier bill" are the same accounting event with the same three
 * questions (what did it cost, what Vorsteuer does it carry, which account does it belong to).
 *
 * EVERY FIGURE ON SCREEN IS THE ENGINE'S. The net / MWST / gross split is `vat_preview`'s answer for
 * exactly the amount and code in the fields, re-asked whenever either changes. Nothing here multiplies
 * a rate: A14 §4 rule 3 ("the GUI holds raw typed input and nothing else") is a money-path rule, and
 * A17 is on the money path. While the preview is in flight the figures DIM rather than showing the
 * last good ones as current, which is the same honesty `PaymentAllocator` holds to.
 *
 * THE PICKERS OFFER ONLY WHAT THE ENGINE WILL ACCEPT, so three of A17's rejections cannot be produced
 * from this surface at all:
 *
 *   - the vendor picker lists contacts with the vendor role, so `needs_vendor {party_role}` is
 *     unreachable (and the empty state says how to create one rather than leaving a dead select);
 *   - the account picker lists expense and asset accounts MINUS the four the engine books itself
 *     (2000 / 1170 / 1171 / 2200), so neither `not_an_expense_or_asset_account` nor `reserved_account`
 *     is reachable;
 *   - the MWST picker lists input-side codes only, so `needs_input_tax_code` is unreachable.
 *
 * That is A19's own "prevent at the control" rule, and it is worth stating because the alternative
 * (offer everything, explain the rejection afterwards) is what makes a form feel like a guessing game.
 *
 * TWO BUTTONS, AND ONLY ONE OF THEM IS THE ACCENT. **Buchen** posts (`record_expense`, one call, one
 * transaction). **Als Entwurf speichern** writes the draft and books nothing (`create_vendor_bill`).
 * The accent is spent on Buchen and on nothing else on this surface, per DESIGN.md's one-accent law.
 *
 * SALDO IS REPORTED, NEVER REFUSED. Under MWSTG Art. 37 the flat rate already imputes input tax, so
 * the expense books GROSS and nothing is separately reclaimed. `vat_preview` says `deductible:false`
 * and the preview panel says so in words, because an operator who expected a Vorsteuer line and does
 * not get one is entitled to know why before they post rather than after they file.
 *
 * ## BUILT ON THE SHARED DetailDrawer (D118 B2)
 *
 * The bespoke `BillDrawer` shell is gone: this is the shared `DetailDrawer`, which brings the focus
 * trap, Escape, the scrim, and the header/body/footer split the hand-rolled panel lacked. The write
 * actions moved from an inline row into the drawer's pinned `footer` (primary last, at the right
 * edge); a void bill has no actions, so its footer is omitted and the header close is the only exit.
 * The form, the posting preview, the A24 courtesy note and the D02 match panel stay in the scrolling
 * body unchanged. No provenance line (C3): the A17 read model names no actor, origin or trace, only
 * `createdAt`/`postedAt`, so there is nothing real to show. No `ConsequenceLine` (C4): every A17
 * write verb (`record_expense`, `post_vendor_bill`, `void_vendor_bill`, `create_vendor_bill`,
 * `attach_receipt`) carries a null `dialCapability`, so there is no engine consequence sentence.
 *
 * ## THE COMPOSER'S D152 RULES, APPLIED TO THE BILL (brand/DESIGN.md "Cognitive load")
 *
 * The order is what the paper bill says, then what TILL infers from it: Lieferant, Rechnungsdatum,
 * Rechnungsnummer, Betrag, Konto, and only then the inferred fields. Nothing new is asked of the engine
 * and no verb, payload key or guard changed: the inferred values are ordinary field values, on screen
 * and editable before the commit, sent exactly as a person who typed them by hand would have sent them.
 *
 *  - MWST COMES FROM THE ACCOUNT. Choosing the Konto sets the code to that account's default when the
 *    workspace offers it as a purchase code (`defaultCodeFor`, the composer's own function), and the
 *    Vorsteuer control appears only on an account that can carry one (`isTaxBearing`, the composer's
 *    predicate: an Erfolgskonto or an asset account 12xx or 14xx to 17xx, Vorräte and Anlagevermögen, owner D152
 *    point 5 as widened on 04.10.2026). "Keine MWST"
 *    stays one pick away and posts exactly what an empty code always posted (no `taxCode` key).
 *  - KOSTENSTELLE AND PROJEKT ONLY WHERE THE ACCOUNT ALLOWS THEM (`costCenterAllowed`, the composer's
 *    rule), behind "+ Kostenstelle" and "+ Projekt". A changed account clears both and resets the code,
 *    exactly as the composer's `withSatzAccount` does: a value chosen for one account never rides
 *    silently onto another, and a control that is not on screen never carries a value. A stored value
 *    is always on screen, so it can be seen before it posts.
 *  - FÄLLIG COMES FROM THE VENDOR'S ZAHLUNGSFRIST, else the workspace default (D163, the Firmenprofil's
 *    Standard-Zahlungsfrist, read from `get_company_profile`), else the bill date: `defaultDueDate`, the
 *    engine's own derivation, mirrored and held to it by a root test. Shown once a vendor is chosen and
 *    editable. Clearing it sends no `dueDate`, which is what a blank field always sent, and the hint
 *    under the empty field names the date the engine will then store.
 *  - The explanations sit behind (i) buttons (the shared Tooltip, `aria-describedby`): the Fälligkeit's
 *    source, why a posted bill is frozen, why Saldo books no Vorsteuer. The split is one line.
 *
 * AN EXISTING BILL IS READ-ONLY, the draft included. No verb edits a draft (`post_vendor_bill` posts
 * the stored row by id), so an editable draft form was a set of controls whose edits Buchen silently
 * ignored. A draft now shows what Buchen will post; correcting it is "Entwurf verwerfen" and a new
 * capture. The posted bill keeps its one live field, the Beleg (`attach_receipt`).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';

import { useClient } from '../../lib/client-context';
import { isErr, type Err } from '../../lib/client';
import { useWorkspaceId } from '../../app/workspace';
import { useT, formatDate, formatMoney } from '../../i18n';
import { ErrorBanner, Skeleton } from '../../components/states';
import { InfoGlyph } from '../../components/states/glyphs';
import { DetailDrawer } from '../../components/DetailDrawer';
import { Select } from '../../components/Select';
import { Tooltip } from '../../components/Tooltip';
import { useIdempotencyKey } from '../../lib/idempotency';
import { useCan, CAP } from '../../lib/capabilities';
// The composer's own D152 rules, imported rather than restated, so the bill and the Buchungssatz can
// never disagree about which account carries MWST or which code an account brings with it.
import { bankLedgerIdsOf, isTaxBearing, markBankLedgers } from '../Journal/composerPayload';
import { defaultCodeFor } from '../Journal/composerModel';
import { PlusGlyph } from '../Journal/glyphs';
// D02: the 3-way-match panel, a self-contained D02-owned affordance embedded here for a posted bill.
// A17's detail is not refactored, only given this one mount (spec §6, cross-ref D02 §6).
import { BillMatchPanel } from '../Purchasing/BillMatchPanel';
import { LinkedFiles } from '../Files/LinkedFiles';
import {
  defaultDueDate,
  dueDateBasis,
  expenseAccounts,
  minorToInput,
  parseAmountToMinor,
  parseVatPreview,
  purchaseTaxCodes,
  todayIso,
  type AccountOption,
  type CostCenterOption,
  type ProjectOption,
  type TaxCodeOption,
  type VatPreview,
  type VendorBill,
  type VendorOption,
} from './model';

export interface BillEditorProps {
  /** The bill being viewed, or null to capture a new one. An existing bill is read-only. */
  bill: VendorBill | null;
  onClose: () => void;
  /**
   * Called after a successful write with the bill it concerned (the posted bill's id, or the id
   * the engine answered for a capture), so the list lands THAT row with the Commit moment (D122
   * D-I). Nothing when the answer named no bill.
   */
  onSaved: (billId?: string) => void;
  /**
   * Open another bill in the drawer: the bill an `idempotency_key_conflict` names, so a person whose
   * capture already landed (its answer lost) reviews THAT bill instead of capturing a second one.
   */
  onOpenBill?: (billId: string) => void;
}

interface Options {
  vendors: VendorOption[];
  /**
   * D163: the workspace default Zahlungsfrist (`get_company_profile.defaultPaymentTermsDays`), or null
   * when none is set. A vendor with no terms of its own falls due after it, in the engine and here.
   */
  workspaceTermsDays: number | null;
  accounts: AccountOption[];
  taxCodes: TaxCodeOption[];
  costCenters: CostCenterOption[];
  projects: ProjectOption[];
}

/** A whole, non-negative day count, or null: the only shape a Zahlungsfrist can take. */
function termsOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** An (i) beside a value: the sentence that explains it, on hover and focus, named by `aria-describedby`. */
function InfoTip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Tooltip content={<span className="bill-explain">{children}</span>}>
      <button type="button" className="btn btn--ghost btn--icon btn--sm bill-info" aria-label={label}>
        <InfoGlyph size={16} />
      </button>
    </Tooltip>
  );
}

export function BillEditor({ bill, onClose, onSaved, onOpenBill }: BillEditorProps) {
  const t = useT();
  const client = useClient();
  const workspaceId = useWorkspaceId();

  /**
   * A24, and the same courtesy `EntryDrawer` extends: every A17 write gates on `post` (the draft
   * included, because an actor who can draft has already decided what will be booked), so the write
   * controls below are PRE-disabled with the reason in words rather than shown and then rejected.
   * `useCan` fails open while `whoami` is unresolved: the engine's `ctxAction` gate is the one that
   * decides, and it does not consult this line.
   */
  const canPost = useCan(CAP.post);

  // No verb edits an existing bill: a draft posts by id, a posted bill is append-only. See the header.
  const readOnly = bill !== null;

  const [vendorId, setVendorId] = useState(bill?.vendorId ?? '');
  const [billDate, setBillDate] = useState(bill?.billDate ?? todayIso());
  /**
   * The Fälligkeit the person (or the stored bill) set, or null while it follows the vendor's
   * Zahlungsfrist. An empty string is a cleared field and sends no `dueDate`, as a blank field always did.
   */
  const [dueOverride, setDueOverride] = useState<string | null>(bill === null ? null : (bill.dueDate ?? ''));
  const [vendorReference, setVendorReference] = useState(bill?.vendorReference ?? '');
  const [amount, setAmount] = useState(
    bill === null ? '' : minorToInput(bill.amountIsGross ? bill.grossMinor : bill.netMinor),
  );
  const [amountIsGross, setAmountIsGross] = useState(bill?.amountIsGross ?? true);
  const [taxCode, setTaxCode] = useState(bill?.taxCode ?? '');
  const [expenseAccountId, setExpenseAccountId] = useState(bill?.expenseAccountId ?? '');
  const [costCenterId, setCostCenterId] = useState(bill?.costCenterId ?? '');
  const [projectId, setProjectId] = useState(bill?.projectId ?? '');
  const [receiptRef, setReceiptRef] = useState(bill?.receiptRef ?? '');
  // "+ Kostenstelle", "+ Projekt" and "+ Beleg" were pressed: the control shows, empty.
  const [costCenterOpen, setCostCenterOpen] = useState(false);
  const [projectOpen, setProjectOpen] = useState(false);
  const [receiptOpen, setReceiptOpen] = useState(false);
  // The control a "+" just opened takes the focus, so the keyboard lands where the button was.
  const [focusId, setFocusId] = useState<string | null>(null);
  useEffect(() => {
    if (focusId === null) return;
    document.getElementById(focusId)?.focus();
    setFocusId(null);
  }, [focusId]);

  const [options, setOptions] = useState<Options | null>(null);
  const [optionsError, setOptionsError] = useState<Err | null>(null);
  const [preview, setPreview] = useState<VatPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<Err | null>(null);
  /**
   * The bill this capture already created, when the engine says so: a key conflict names it, or a success
   * answered for a capture whose earlier attempt (with other fields) may have landed. The drawer then says
   * "Diese Rechnung ist schon erfasst." and offers to open THAT bill instead of closing or capturing again.
   */
  const [captured, setCaptured] = useState<string | null>(null);
  /** The field sets of capture attempts whose outcome is unknown (the answer was lost): they may have landed. */
  const uncertainCaptures = useRef<Set<string>>(new Set());

  /**
   * False once the drawer is gone. The list remounts the drawer on a workspace switch (it is keyed by
   * the workspace), so an answer that arrives after that speaks nowhere: it neither closes the new
   * workspace's drawer nor re-reads its list.
   */
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const amountMinor = parseAmountToMinor(amount);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (workspaceId === null) return;
      const [contacts, accounts, codes, centers, projects, banks, profile] = await Promise.all([
        client.call('list_contacts', { workspaceId }),
        client.call('list_accounts', { workspaceId }),
        client.call('vat_codes', { workspaceId }),
        client.call('list_cost_centers', { workspaceId }),
        client.call('project_list', { workspaceId }),
        // Each Bankkonto's own ledger account never offers MWST (critic L2). Not a required read: a failed
        // one marks none, and the capture still works.
        client.call('list_bank_accounts', { workspaceId }),
        // D163: the workspace default Zahlungsfrist. A REQUIRED read: without it the Fälligkeit shown
        // (and the date the hint promises for an empty field) could differ from what the engine stores.
        client.call('get_company_profile', { workspaceId }),
      ]);
      if (cancelled) return;
      for (const response of [contacts, accounts, codes, centers, projects, profile]) {
        if (isErr(response.body)) {
          setOptionsError(response.body);
          return;
        }
      }
      const rawContacts = (contacts.body as { contacts?: unknown }).contacts;
      const rawAccounts = (accounts.body as { accounts?: unknown }).accounts;
      const rawCodes = (codes.body as { taxCodes?: unknown }).taxCodes;
      const rawCenters = (centers.body as { costCenters?: unknown }).costCenters;
      const rawProjects = (projects.body as { projects?: unknown }).projects;
      const rawProfile = (profile.body as { profile?: { defaultPaymentTermsDays?: unknown } }).profile;
      setOptions({
        workspaceTermsDays: termsOf(rawProfile?.defaultPaymentTermsDays),
        // The VENDOR role, and `both` with it: a party can be a customer and a supplier, and A17
        // accepts either. A customer-only contact is filtered out here rather than refused later.
        vendors: (Array.isArray(rawContacts) ? rawContacts : [])
          .map((c) => c as { id?: unknown; name?: unknown; partyRole?: unknown; paymentTermsDays?: unknown })
          .filter((c) => c.partyRole === 'vendor' || c.partyRole === 'both')
          .map((c) => ({ id: String(c.id ?? ''), name: String(c.name ?? ''), paymentTermsDays: termsOf(c.paymentTermsDays) }))
          .filter((c) => c.id !== ''),
        accounts: markBankLedgers(expenseAccounts(
          (Array.isArray(rawAccounts) ? rawAccounts : [])
            .map(
              (a) =>
                a as {
                  id?: unknown;
                  number?: unknown;
                  name?: unknown;
                  type?: unknown;
                  vatCodeDefault?: unknown;
                  costCenterAllowed?: unknown;
                },
            )
            .map((a) => ({
              id: String(a.id ?? ''),
              number: String(a.number ?? ''),
              name: String(a.name ?? ''),
              type: String(a.type ?? ''),
              vatCodeDefault: typeof a.vatCodeDefault === 'string' && a.vatCodeDefault !== '' ? a.vatCodeDefault : null,
              costCenterAllowed: a.costCenterAllowed === true,
            }))
            .filter((a) => a.id !== ''),
        ), isErr(banks.body) ? new Set<string>() : bankLedgerIdsOf(banks.body)),
        taxCodes: purchaseTaxCodes(
          (Array.isArray(rawCodes) ? rawCodes : [])
            .map((c) => c as { code?: unknown; kind?: unknown; label?: unknown })
            .map((c) => ({
              code: String(c.code ?? ''),
              kind: String(c.kind ?? ''),
              label: String(c.label ?? c.code ?? ''),
            }))
            .filter((c) => c.code !== ''),
        ),
        // Optional on the bill and optional in the workspace: a workspace with no cost centres gets
        // no picker at all rather than a dead select with one empty choice.
        costCenters: (Array.isArray(rawCenters) ? rawCenters : [])
          .map((c) => c as { id?: unknown; code?: unknown; name?: unknown })
          .map((c) => ({ id: String(c.id ?? ''), code: String(c.code ?? ''), name: String(c.name ?? '') }))
          .filter((c) => c.id !== ''),
        // The B03 cost dimension, the cost-centre rule exactly: optional on the bill and optional
        // in the workspace, so no projects means no picker rather than a dead select.
        projects: (Array.isArray(rawProjects) ? rawProjects : [])
          .map((p) => p as { id?: unknown; code?: unknown; name?: unknown })
          .map((p) => ({ id: String(p.id ?? ''), code: String(p.code ?? ''), name: String(p.name ?? '') }))
          .filter((p) => p.id !== ''),
      });
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [client, workspaceId]);

  /**
   * The live split, asked of the ENGINE.
   *
   * `vat_preview` is a read verb with no side effect, so it is safe to fire on every change, and it is
   * the same `computeLineTax` `record_expense` will run: the figure on screen before the click is the
   * figure in the books after it, by construction rather than by agreement. Only the NEWEST question's
   * answer is shown: an older answer that arrives late (a slower read for the amount typed before) is
   * dropped, so the line never shows the split of a figure that is no longer in the field.
   *
   * PRICED AT THE LEISTUNGSDATUM THE ENGINE WILL USE (critic M1): `post_vendor_bill` prices a stored bill at
   * `supply_date ?? bill_date`, so an existing bill asks at its own stored supply date (an agent's draft may
   * carry one across a rate change); a new capture sends none, so the engine prices it at the bill date.
   */
  const supplyDate = bill?.supplyDate ?? billDate;
  const previewSeq = useRef(0);
  const loadPreview = useCallback(async () => {
    const seq = ++previewSeq.current;
    if (workspaceId === null || amountMinor === null || amountMinor <= 0) {
      setPreview(null);
      setPreviewing(false);
      return;
    }
    setPreviewing(true);
    const response = await client.call('vat_preview', {
      workspaceId,
      amountMinor,
      amountIsGross,
      ...(taxCode === '' ? {} : { taxCode }),
      supplyDate,
    });
    if (!alive.current || seq !== previewSeq.current) return;
    setPreview(isErr(response.body) ? null : parseVatPreview(response.body));
    setPreviewing(false);
  }, [client, workspaceId, amountMinor, amountIsGross, taxCode, supplyDate]);

  useEffect(() => {
    void loadPreview();
  }, [loadPreview]);

  const vendor = options?.vendors.find((v) => v.id === vendorId);
  const account = options?.accounts.find((a) => a.id === expenseAccountId);
  // The vendor's Zahlungsfrist, else the workspace default (D163), else none: the engine's own
  // derivation either way (`defaultDueDate`).
  const vendorTerms = vendor?.paymentTermsDays ?? null;
  const workspaceTerms = options?.workspaceTermsDays ?? null;
  const dueBasis = dueDateBasis(vendorTerms, workspaceTerms);
  const derivedDue = vendorId === '' ? '' : defaultDueDate(billDate, vendorTerms, workspaceTerms);
  const dueDate = dueOverride ?? derivedDue;
  // A cleared Fällig sends no `dueDate`, and the engine then stores its own default (critic L1): that date
  // is said under the empty field, so what is shown is what is stored. `defaultDueDate` is the one mirror.
  const blankDueHint =
    bill === null && vendorId !== '' && dueDate === '' && derivedDue !== ''
      ? derivedDue === billDate
        ? t('bills.due.blankBillDate', { date: formatDate(derivedDue) })
        : dueBasis.source === 'workspace'
          ? t('bills.due.blankFromDefault', { date: formatDate(derivedDue) })
          : t('bills.due.blankFromTerms', { date: formatDate(derivedDue) })
      : null;
  // The (i) beside Fällig: which rule the date comes from, in one sentence.
  const dueSourceText =
    dueBasis.source === 'contact'
      ? dueBasis.days > 0
        ? t('bills.due.fromTerms', { days: dueBasis.days })
        : t('bills.due.immediate')
      : dueBasis.source === 'workspace'
        ? dueBasis.days > 0
          ? t('bills.due.fromDefault', { days: dueBasis.days })
          : t('bills.due.defaultImmediate')
        : t('bills.due.noTerms');

  const fields = useMemo(
    () => ({
      vendorId,
      billDate,
      ...(dueDate === '' ? {} : { dueDate }),
      ...(vendorReference === '' ? {} : { vendorReference }),
      amountMinor: amountMinor ?? 0,
      amountIsGross,
      ...(taxCode === '' ? {} : { taxCode }),
      expenseAccountId,
      ...(costCenterId === '' ? {} : { costCenterId }),
      ...(projectId === '' ? {} : { projectId }),
      ...(receiptRef === '' ? {} : { receiptRef }),
    }),
    [vendorId, billDate, dueDate, vendorReference, amountMinor, amountIsGross, taxCode, expenseAccountId, costCenterId, projectId, receiptRef],
  );

  /**
   * ONE key per DRAWER for the one act of capturing this paper bill (critic H1, round 2 L-b), shared by "Als
   * Entwurf speichern" and "Buchen" and kept for every save, retry and edit until a definite success closes
   * the drawer. It is NOT re-derived from the fields: a lost save followed by an edit would otherwise mint a
   * fresh key, and the next Buchen would book the same invoice a second time.
   *
   *  - Under the same key, a write by the OTHER verb meets the engine's holder check and is refused
   *    `idempotency_key_conflict`, naming the bill: the drawer says so and opens that bill for review.
   *  - A write by the SAME verb after a lost answer is replayed by the engine (`rememberIdempotent`), with
   *    the FIRST attempt's figures. When the fields changed since an attempt whose answer was lost, that
   *    success is therefore not trusted to describe what is on screen: the drawer says the bill exists and
   *    opens it, rather than closing on a figure the person edited away (`uncertainCaptures`).
   *  - A definite refusal stores nothing (`createVendorBill` and `recordExpense` refuse before their memo, or
   *    roll the memo back with the transaction), so the same key stays valid for the corrected retry.
   *
   * The drawer remounts per workspace and per opening (it is keyed by both), so no key outlives its act.
   */
  const [captureKey] = useState(() => crypto.randomUUID());
  const postKey = useIdempotencyKey(['post', bill?.id ?? null]);
  const voidKey = useIdempotencyKey(['void', bill?.id ?? null]);
  const receiptKey = useIdempotencyKey(['receipt', bill?.id ?? null, receiptRef]);

  const complete = vendorId !== '' && expenseAccountId !== '' && amountMinor !== null && amountMinor > 0;

  /**
   * The Konto changed: the code becomes the new account's default (or none), and the cost centre and
   * the project are cleared and closed. The composer's `withSatzAccount` rule, on the bill's one account.
   */
  const chooseAccount = useCallback(
    (id: string) => {
      if (options === null || id === expenseAccountId) return;
      setExpenseAccountId(id);
      setTaxCode(defaultCodeFor(options.accounts.find((a) => a.id === id), options.taxCodes));
      setCostCenterId('');
      setProjectId('');
      setCostCenterOpen(false);
      setProjectOpen(false);
    },
    [options, expenseAccountId],
  );

  const write = useCallback(
    async (action: 'create_vendor_bill' | 'record_expense' | 'post_vendor_bill' | 'void_vendor_bill' | 'attach_receipt', input: Record<string, unknown>) => {
      if (workspaceId === null) return;
      setSaving(true);
      setFailure(null);
      setCaptured(null);
      const capture = action === 'create_vendor_bill' || action === 'record_expense';
      const { idempotencyKey: _key, ...sentFields } = input;
      const sent = JSON.stringify(sentFields);
      const response = await client.call(action, { workspaceId, ...input });
      // The drawer is gone (closed, or remounted for another workspace): the answer speaks nowhere.
      if (!alive.current) return;
      setSaving(false);
      if (isErr(response.body)) {
        const refusal = response.body;
        if (capture && refusal.error === 'idempotency_key_conflict' && typeof refusal.vendorBillId === 'string') {
          setCaptured(refusal.vendorBillId);
          return;
        }
        // An answer that never came (or one this drawer does not know) may hide a write that landed.
        if (capture && !DEFINITE_REFUSALS.has(refusal.error)) uncertainCaptures.current.add(sent);
        // EVERY TYPED VALUE SURVIVES A REJECTION, deliberately: the write may have landed and lost its
        // response, so the operator has to be able to read what they sent, correct it and click again.
        setFailure(refusal);
        return;
      }
      const answered = response.body as { vendorBillId?: unknown; bill?: { id?: unknown } };
      const ackId =
        typeof input.vendorBillId === 'string'
          ? input.vendorBillId
          : typeof answered.vendorBillId === 'string'
            ? answered.vendorBillId
            : typeof answered.bill?.id === 'string'
              ? answered.bill.id
              : undefined;
      // A success under a key whose earlier attempt carried OTHER fields and lost its answer may be the
      // engine replaying that earlier write: say the bill exists and open it, never close on it.
      if (capture && ackId !== undefined && [...uncertainCaptures.current].some((other) => other !== sent)) {
        onSaved(ackId);
        setCaptured(ackId);
        return;
      }
      onSaved(ackId);
      onClose();
    },
    [client, workspaceId, onSaved, onClose],
  );

  const title = bill === null ? t('bills.editor.newTitle') : t('bills.editor.title', { ref: bill.vendorReference ?? bill.id });

  if (optionsError !== null) {
    return (
      <DetailDrawer open onClose={onClose} title={title} closeLabel={t('bills.close')}>
        <ErrorBanner error={optionsError} message={t('bills.error.options')} />
      </DetailDrawer>
    );
  }

  if (options === null) {
    return (
      <DetailDrawer open onClose={onClose} title={title} closeLabel={t('bills.close')}>
        <Skeleton rows={6} />
      </DetailDrawer>
    );
  }

  const noVendors = options.vendors.length === 0;
  const noAccounts = options.accounts.length === 0;

  // D152 rule 2: a control appears only where it can apply, and nothing hidden carries a value.
  const showTax = isTaxBearing(account) || taxCode !== '';
  const allowsDimensions = account?.costCenterAllowed === true;
  const showCostCenter = costCenterId !== '' || (allowsDimensions && costCenterOpen && options.costCenters.length > 0);
  const offerCostCenter = !readOnly && !showCostCenter && allowsDimensions && options.costCenters.length > 0;
  const showProject = projectId !== '' || (allowsDimensions && projectOpen && options.projects.length > 0);
  const offerProject = !readOnly && !showProject && allowsDimensions && options.projects.length > 0;
  const showDue = vendorId !== '' || dueDate !== '';
  // The Beleg is the one live field of a POSTED bill (`attach_receipt`); elsewhere it waits behind "+ Beleg".
  const receiptLive = bill === null || bill.status === 'posted';
  const showReceipt = receiptRef !== '' || receiptOpen || (bill !== null && bill.status === 'posted');
  const offerReceipt = bill === null && !showReceipt;

  // The pinned action row, assembled per lifecycle state. A void bill has no actions, so its footer
  // is omitted entirely and the drawer's own close control (the header) is the only way out. The
  // primary action sits LAST so it lands at the right edge (drawer-foot is flex-end, design law).
  const footer: ReactNode =
    bill === null ? (
      <>
        <button
          type="button"
          className="btn btn--ghost"
          disabled={!complete || saving || !canPost}
          title={!canPost ? t('bills.requiresBookkeeper') : undefined}
          onClick={() => void write('create_vendor_bill', { ...fields, idempotencyKey: captureKey })}
        >
          {t('bills.saveDraft')}
        </button>
        <button
          type="button"
          className="btn btn--primary"
          disabled={!complete || saving || !canPost}
          title={!canPost ? t('bills.requiresBookkeeper') : undefined}
          onClick={() => void write('record_expense', { ...fields, idempotencyKey: captureKey })}
        >
          {t('bills.post')}
        </button>
      </>
    ) : bill.status === 'draft' ? (
      <>
        <button
          type="button"
          className="btn btn--ghost"
          disabled={saving || !canPost}
          title={!canPost ? t('bills.requiresBookkeeper') : undefined}
          onClick={() => void write('void_vendor_bill', { vendorBillId: bill.id, idempotencyKey: voidKey })}
        >
          {t('bills.discard')}
        </button>
        <button
          type="button"
          className="btn btn--primary"
          disabled={saving || !canPost}
          title={!canPost ? t('bills.requiresBookkeeper') : undefined}
          onClick={() => void write('post_vendor_bill', { vendorBillId: bill.id, idempotencyKey: postKey })}
        >
          {t('bills.post')}
        </button>
      </>
    ) : bill.status === 'posted' ? (
      <>
        <button
          type="button"
          className="btn btn--ghost"
          disabled={saving || receiptRef === (bill.receiptRef ?? '') || !canPost}
          title={!canPost ? t('bills.requiresBookkeeper') : undefined}
          onClick={() =>
            void write('attach_receipt', { vendorBillId: bill.id, receiptRef, idempotencyKey: receiptKey })
          }
        >
          {t('bills.saveReceipt')}
        </button>
        <button
          type="button"
          className="btn btn--ghost"
          disabled={saving || !canPost}
          title={!canPost ? t('bills.requiresBookkeeper') : undefined}
          onClick={() => void write('void_vendor_bill', { vendorBillId: bill.id, idempotencyKey: voidKey })}
        >
          {t('bills.void')}
        </button>
      </>
    ) : undefined;

  // A stored value the pickers no longer offer (an archived centre, a retired code) still shows, by id.
  const withStored = (list: { value: string; label: string }[], stored: string) =>
    stored !== '' && !list.some((o) => o.value === stored) ? [...list, { value: stored, label: stored }] : list;

  return (
    <DetailDrawer open onClose={onClose} title={title} closeLabel={t('bills.close')} footer={footer}>
      {captured !== null && (
        // The capture already landed: say so in one sentence and open THAT bill, worded neutrally because
        // it may be a draft or a posted bill (critic L-a). Never auto-post it by id: its stored fields may
        // differ from what is on screen, so the person reviews it first.
        <div className="bill-conflict" role="alert">
          <p>{t('bills.error.alreadyCaptured')}</p>
          {onOpenBill !== undefined && (
            <button type="button" className="btn btn--secondary btn--sm" onClick={() => onOpenBill(captured)}>
              {t('bills.conflict.open')}
            </button>
          )}
        </div>
      )}
      {failure !== null && <ErrorBanner error={failure} message={billErrorMessage(t, failure)} />}

      {readOnly && bill !== null && (
        <p className="bill-frozen" role="status">
          <span>{t(`bills.frozen.${bill.status}`)}</span>
          {bill.status === 'posted' && <InfoTip label={t('bills.frozen.info')}>{t('bills.frozen.postedWhy')}</InfoTip>}
        </p>
      )}

      {noVendors && !readOnly && (
        <p className="bill-cta">
          {t('bills.needsVendor.body')}{' '}
          <Link className="link-inline" to="/contacts">{t('bills.needsVendor.action')}</Link>
        </p>
      )}

      <div className="bill-form">
        <div className="bill-field">
          <span>{t('bills.vendor')}</span>
          <Select
            value={vendorId}
            disabled={readOnly || noVendors}
            onChange={setVendorId}
            options={withStored(
              [{ value: '', label: t('bills.chooseVendor') }, ...options.vendors.map((v) => ({ value: v.id, label: v.name }))],
              vendorId,
            )}
            ariaLabel={t('bills.vendor')}
          />
        </div>

        <div className="bill-pair">
          <label className="bill-field" htmlFor="bill-date">
            <span>{t('bills.billDate')}</span>
            <input
              id="bill-date"
              className="field"
              type="date"
              value={billDate}
              disabled={readOnly}
              onChange={(event) => setBillDate(event.target.value)}
            />
          </label>

          <label className="bill-field" htmlFor="bill-reference">
            <span>{t('bills.vendorReference')}</span>
            <input
              id="bill-reference"
              className="field"
              value={vendorReference}
              disabled={readOnly}
              onChange={(event) => setVendorReference(event.target.value)}
            />
          </label>
        </div>

        <div className="bill-pair">
          <label className="bill-field" htmlFor="bill-amount">
            <span>{t('bills.amount')}</span>
            <input
              id="bill-amount"
              className="field t-num"
              inputMode="decimal"
              value={amount}
              disabled={readOnly}
              onChange={(event) => setAmount(event.target.value)}
            />
          </label>

          {/*
            THE NET/GROSS TOGGLE RE-ASKS THE ENGINE, it does not recompute. A06 preserves the ENTERED
            amount verbatim and derives the other two from it, so which one was typed changes the
            rounding: flipping this is a different question, not a different presentation of one answer.
          */}
          <fieldset className="bill-toggle" disabled={readOnly}>
            <legend className="visually-hidden">{t('bills.amountIs')}</legend>
            <label htmlFor="bill-is-gross">
              <input
                id="bill-is-gross"
                type="radio"
                name="bill-amount-is"
                checked={amountIsGross}
                onChange={() => setAmountIsGross(true)}
              />
              {t('bills.gross')}
            </label>
            <label htmlFor="bill-is-net">
              <input
                id="bill-is-net"
                type="radio"
                name="bill-amount-is"
                checked={!amountIsGross}
                onChange={() => setAmountIsGross(false)}
              />
              {t('bills.net')}
            </label>
          </fieldset>
        </div>

        <div className="bill-field">
          <span>{t('bills.expenseAccount')}</span>
          <Select
            value={expenseAccountId}
            disabled={readOnly || noAccounts}
            onChange={chooseAccount}
            options={withStored(
              [
                { value: '', label: t('bills.chooseAccount') },
                ...options.accounts.map((a) => ({ value: a.id, label: `${a.number} ${a.name}` })),
              ],
              expenseAccountId,
            )}
            ariaLabel={t('bills.expenseAccount')}
          />
        </div>

        {(showTax || showDue) && (
          <div className="bill-pair">
            {showTax && (
              <div className="bill-field">
                <span>{t('bills.vatCode')}</span>
                <Select
                  value={taxCode}
                  disabled={readOnly}
                  onChange={setTaxCode}
                  options={withStored(
                    [{ value: '', label: t('bills.noVat') }, ...options.taxCodes.map((c) => ({ value: c.code, label: c.label }))],
                    taxCode,
                  )}
                  ariaLabel={t('bills.vatCode')}
                />
              </div>
            )}

            {showDue && (
              <div className="bill-field">
                <span className="bill-label">
                  <label htmlFor="bill-due">{t('bills.dueDate')}</label>
                  {bill === null && vendorId !== '' && (
                    <InfoTip label={t('bills.due.info')}>{dueSourceText}</InfoTip>
                  )}
                </span>
                <input
                  id="bill-due"
                  className="field"
                  type="date"
                  value={dueDate}
                  disabled={readOnly}
                  aria-describedby={blankDueHint !== null ? 'bill-due-blank' : undefined}
                  onChange={(event) => setDueOverride(event.target.value)}
                />
                {blankDueHint !== null && (
                  <span id="bill-due-blank" className="bill-hint">
                    {blankDueHint}
                  </span>
                )}
              </div>
            )}
          </div>
        )}

        {showCostCenter && (
          <div className="bill-field">
            <span>{t('bills.costCenter')}</span>
            <Select
              id="bill-cost-center"
              value={costCenterId}
              disabled={readOnly}
              onChange={setCostCenterId}
              options={withStored(
                [
                  { value: '', label: t('bills.noCostCenter') },
                  ...options.costCenters.map((c) => ({ value: c.id, label: `${c.code} ${c.name}` })),
                ],
                costCenterId,
              )}
              ariaLabel={t('bills.costCenter')}
            />
          </div>
        )}

        {showProject && (
          <div className="bill-field">
            <span>{t('bills.project')}</span>
            <Select
              id="bill-project"
              value={projectId}
              disabled={readOnly}
              onChange={setProjectId}
              options={withStored(
                [
                  { value: '', label: t('bills.noProject') },
                  ...options.projects.map((p) => ({ value: p.id, label: `${p.code} ${p.name}` })),
                ],
                projectId,
              )}
              ariaLabel={t('bills.project')}
            />
          </div>
        )}

        {showReceipt && (
          <label className="bill-field" htmlFor="bill-receipt">
            <span>{t('bills.receipt')}</span>
            <input
              id="bill-receipt"
              className="field"
              value={receiptRef}
              disabled={!receiptLive}
              onChange={(event) => setReceiptRef(event.target.value)}
            />
          </label>
        )}

        {(offerCostCenter || offerProject || offerReceipt) && (
          <div className="bill-adds">
            {offerCostCenter && (
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => {
                  setCostCenterOpen(true);
                  setFocusId('bill-cost-center');
                }}>
                <PlusGlyph size={16} />
                {t('bills.addCostCenter')}
              </button>
            )}
            {offerProject && (
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => {
                  setProjectOpen(true);
                  setFocusId('bill-project');
                }}>
                <PlusGlyph size={16} />
                {t('bills.addProject')}
              </button>
            )}
            {offerReceipt && (
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => {
                  setReceiptOpen(true);
                  setFocusId('bill-receipt');
                }}>
                <PlusGlyph size={16} />
                {t('bills.addReceipt')}
              </button>
            )}
          </div>
        )}
      </div>

      {/*
        THE POSTING SPLIT, IN ONE LINE (D152 rule 4). Present figures only: while a preview is in flight
        the line dims rather than presenting the previous answer as current, and with no answer at all it
        renders nothing instead of `CHF 0.00`.
      */}
      <p className={previewing ? 'bill-split bill-split--pending' : 'bill-split'} aria-live="polite">
        {preview !== null && (
          <>
            <span>
              {t('bills.net')} <span className="t-money">{formatMoney(preview.netMinor, 'CHF')}</span>
            </span>
            <span aria-hidden="true"> · </span>
            <span>
              {t('bills.vat')} <span className="t-money">{formatMoney(preview.taxMinor, 'CHF')}</span>
            </span>
            {preview.taxMinor !== 0 && !preview.deductible && (
              <InfoTip label={t('bills.preview.saldoInfo')}>{t('bills.preview.saldo')}</InfoTip>
            )}
            <span aria-hidden="true"> · </span>
            <span>
              {t('bills.gross')} <span className="t-money">{formatMoney(preview.grossMinor, 'CHF')}</span>
            </span>
          </>
        )}
      </p>

      {/* A24 (spec §6): the write controls are pre-disabled with the reason in words for an actor
          lacking `post`, never shown enabled and then rejected on submit. */}
      {!canPost && (
        <p className="bill-requires" role="status">
          <span aria-hidden="true">! </span>
          {t('bills.requiresBookkeeper')}
        </p>
      )}

      {bill !== null && bill.status === 'posted' && bill.vendorId !== null && bill.vendorId !== undefined && (
        <BillMatchPanel billId={bill.id} vendorId={bill.vendorId} />
      )}

      {/* E00: the shared Dateien panel, for a bill that already exists (a draft being captured has no
          id to attach a scanned invoice against yet). The ONE attachment UI, parameterised by the OP3
          pair, never a bespoke copy in this drawer. */}
      {bill !== null && workspaceId !== null && (
        <LinkedFiles workspaceId={workspaceId} entityKind="vendor_bill" entityId={bill.id} />
      )}
    </DetailDrawer>
  );
}

/**
 * The engine's refusals that are DEFINITE: the write was checked and nothing was stored. Any other failure
 * (a lost answer, `transport_error`, a code this drawer does not know) may hide a write that landed.
 */
const DEFINITE_REFUSALS: ReadonlySet<string> = new Set([
  'needs_vendor',
  'needs_account',
  'needs_input_tax_code',
  'period_locked',
  'already_settled',
  'already_posted',
  'already_void',
  'needs_fx_rate',
  'permission_denied',
  'invalid_input',
  'invalid_reference',
  'not_found',
  'idempotency_key_conflict',
]);

/**
 * One sentence per rejection this drawer can still receive, naming the field and the fix.
 *
 * The three the pickers make unreachable are absent on purpose, and so is any generic fallback that
 * would print an engine code at a person: an unrecognised rejection falls through to the shared banner
 * message, which says what happened without pretending to know why.
 */
export function billErrorMessage(t: (key: string, vars?: Record<string, string | number>) => string, error: Err): string {
  const reason = typeof error.reason === 'string' ? error.reason : '';
  switch (error.error) {
    // The capture key already holds a bill (a draft or a posted one): said neutrally.
    case 'idempotency_key_conflict':
      return t('bills.error.alreadyCaptured');
    case 'needs_vendor':
      return reason === 'party_role' ? t('bills.error.vendorRole') : t('bills.error.needsVendor');
    case 'needs_account':
      return t('bills.error.needsAccount');
    case 'needs_input_tax_code':
      return t('bills.error.needsInputTaxCode');
    case 'period_locked':
      return t('bills.error.periodLocked');
    case 'already_settled':
      return t('bills.error.alreadySettled');
    case 'already_posted':
      return t('bills.error.alreadyPosted');
    case 'already_void':
      return t('bills.error.alreadyVoid');
    case 'needs_fx_rate':
      return t('bills.error.needsFxRate');
    case 'permission_denied':
      return t('bills.error.permissionDenied.write');
    default:
      return t('bills.error.transport');
  }
}
