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
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';

import { useClient } from '../../lib/client-context';
import { isErr, type Err } from '../../lib/client';
import { useWorkspaceId } from '../../app/workspace';
import { useT, formatMoney } from '../../i18n';
import { ErrorBanner, Skeleton } from '../../components/states';
import { DetailDrawer } from '../../components/DetailDrawer';
import { Select } from '../../components/Select';
import { useIdempotencyKey } from '../../lib/idempotency';
import { useCan, CAP } from '../../lib/capabilities';
// D02: the 3-way-match panel, a self-contained D02-owned affordance embedded here for a posted bill.
// A17's detail is not refactored, only given this one mount (spec §6, cross-ref D02 §6).
import { BillMatchPanel } from '../Purchasing/BillMatchPanel';
import { LinkedFiles } from '../Files/LinkedFiles';
import {
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
  /** The bill being viewed, or null to capture a new one. A posted bill is read-only. */
  bill: VendorBill | null;
  onClose: () => void;
  /** Called after any write, so the list re-reads and the row updates with no navigation. */
  /**
   * Called after a successful write with the bill it concerned (the posted bill's id, or the id
   * the engine answered for a capture), so the list lands THAT row with the Commit moment (D122
   * D-I). Nothing when the answer named no bill.
   */
  onSaved: (billId?: string) => void;
}

interface Options {
  vendors: VendorOption[];
  accounts: AccountOption[];
  taxCodes: TaxCodeOption[];
  costCenters: CostCenterOption[];
  projects: ProjectOption[];
}

export function BillEditor({ bill, onClose, onSaved }: BillEditorProps) {
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

  const readOnly = bill !== null && bill.status !== 'draft';

  const [vendorId, setVendorId] = useState(bill?.vendorId ?? '');
  const [billDate, setBillDate] = useState(bill?.billDate ?? todayIso());
  const [dueDate, setDueDate] = useState(bill?.dueDate ?? '');
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

  const [options, setOptions] = useState<Options | null>(null);
  const [optionsError, setOptionsError] = useState<Err | null>(null);
  const [preview, setPreview] = useState<VatPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<Err | null>(null);

  const amountMinor = parseAmountToMinor(amount);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (workspaceId === null) return;
      const [contacts, accounts, codes, centers, projects] = await Promise.all([
        client.call('list_contacts', { workspaceId }),
        client.call('list_accounts', { workspaceId }),
        client.call('vat_codes', { workspaceId }),
        client.call('list_cost_centers', { workspaceId }),
        client.call('project_list', { workspaceId }),
      ]);
      if (cancelled) return;
      for (const response of [contacts, accounts, codes, centers, projects]) {
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
      setOptions({
        // The VENDOR role, and `both` with it: a party can be a customer and a supplier, and A17
        // accepts either. A customer-only contact is filtered out here rather than refused later.
        vendors: (Array.isArray(rawContacts) ? rawContacts : [])
          .map((c) => c as { id?: unknown; name?: unknown; partyRole?: unknown })
          .filter((c) => c.partyRole === 'vendor' || c.partyRole === 'both')
          .map((c) => ({ id: String(c.id ?? ''), name: String(c.name ?? '') }))
          .filter((c) => c.id !== ''),
        accounts: expenseAccounts(
          (Array.isArray(rawAccounts) ? rawAccounts : [])
            .map((a) => a as { id?: unknown; number?: unknown; name?: unknown; type?: unknown })
            .map((a) => ({
              id: String(a.id ?? ''),
              number: String(a.number ?? ''),
              name: String(a.name ?? ''),
              type: String(a.type ?? ''),
            }))
            .filter((a) => a.id !== ''),
        ),
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
   * figure in the books after it, by construction rather than by agreement.
   */
  const loadPreview = useCallback(async () => {
    if (workspaceId === null || amountMinor === null || amountMinor <= 0) {
      setPreview(null);
      return;
    }
    setPreviewing(true);
    const response = await client.call('vat_preview', {
      workspaceId,
      amountMinor,
      amountIsGross,
      ...(taxCode === '' ? {} : { taxCode }),
      supplyDate: billDate,
    });
    if (isErr(response.body)) {
      setPreview(null);
      setPreviewing(false);
      return;
    }
    setPreview(parseVatPreview(response.body));
    setPreviewing(false);
  }, [client, workspaceId, amountMinor, amountIsGross, taxCode, billDate]);

  useEffect(() => {
    void loadPreview();
  }, [loadPreview]);

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

  // ONE key per QUESTION (see `lib/idempotency.ts`): the key changes when, and only when, the write
  // would be a different write. A key minted at mount over an editable form replays the FIRST figure.
  const captureKey = useIdempotencyKey(['capture', fields]);
  const postKey = useIdempotencyKey(['post', bill?.id ?? null]);
  const voidKey = useIdempotencyKey(['void', bill?.id ?? null]);
  const receiptKey = useIdempotencyKey(['receipt', bill?.id ?? null, receiptRef]);

  const complete = vendorId !== '' && expenseAccountId !== '' && amountMinor !== null && amountMinor > 0;

  const write = useCallback(
    async (action: 'create_vendor_bill' | 'record_expense' | 'post_vendor_bill' | 'void_vendor_bill' | 'attach_receipt', input: Record<string, unknown>) => {
      if (workspaceId === null) return;
      setSaving(true);
      setFailure(null);
      const response = await client.call(action, { workspaceId, ...input });
      setSaving(false);
      if (isErr(response.body)) {
        // EVERY TYPED VALUE SURVIVES A REJECTION, deliberately: the write may have landed and lost its
        // response, so the operator has to be able to read what they sent, correct it and click again.
        setFailure(response.body);
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

  return (
    <DetailDrawer open onClose={onClose} title={title} closeLabel={t('bills.close')} footer={footer}>
      {failure !== null && <ErrorBanner error={failure} message={billErrorMessage(t, failure)} />}

      {readOnly && bill !== null && (
        <p className="bill-frozen" role="status">
          {t(`bills.frozen.${bill.status}`)}
        </p>
      )}

      {noVendors && (
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
            options={[
              { value: '', label: t('bills.chooseVendor') },
              ...options.vendors.map((v) => ({ value: v.id, label: v.name })),
            ]}
            ariaLabel={t('bills.vendor')}
          />
        </div>

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

        <label className="bill-field" htmlFor="bill-due">
          <span>{t('bills.dueDate')}</span>
          <input
            id="bill-due"
            className="field"
            type="date"
            value={dueDate}
            disabled={readOnly}
            onChange={(event) => setDueDate(event.target.value)}
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

        <label className="bill-field" htmlFor="bill-amount">
          <span>{amountIsGross ? t('bills.gross') : t('bills.net')}</span>
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
          <legend>{t('bills.amountIs')}</legend>
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

        <div className="bill-field">
          <span>{t('bills.vatCode')}</span>
          <Select
            value={taxCode}
            disabled={readOnly}
            onChange={setTaxCode}
            options={[
              { value: '', label: t('bills.noVat') },
              ...options.taxCodes.map((c) => ({ value: c.code, label: c.label })),
            ]}
            ariaLabel={t('bills.vatCode')}
          />
        </div>

        <div className="bill-field">
          <span>{t('bills.expenseAccount')}</span>
          <Select
            value={expenseAccountId}
            disabled={readOnly || noAccounts}
            onChange={setExpenseAccountId}
            options={[
              { value: '', label: t('bills.chooseAccount') },
              ...options.accounts.map((a) => ({ value: a.id, label: `${a.number} ${a.name}` })),
            ]}
            ariaLabel={t('bills.expenseAccount')}
          />
        </div>

        {options.costCenters.length > 0 && (
          <div className="bill-field">
            <span>{t('bills.costCenter')}</span>
            <Select
              value={costCenterId}
              disabled={readOnly}
              onChange={setCostCenterId}
              options={[
                { value: '', label: t('bills.noCostCenter') },
                ...options.costCenters.map((c) => ({ value: c.id, label: `${c.code} ${c.name}` })),
              ]}
              ariaLabel={t('bills.costCenter')}
            />
          </div>
        )}

        {options.projects.length > 0 && (
          <div className="bill-field">
            <span>{t('bills.project')}</span>
            <Select
              value={projectId}
              disabled={readOnly}
              onChange={setProjectId}
              options={[
                { value: '', label: t('bills.noProject') },
                ...options.projects.map((p) => ({ value: p.id, label: `${p.code} ${p.name}` })),
              ]}
              ariaLabel={t('bills.project')}
            />
          </div>
        )}

        <label className="bill-field" htmlFor="bill-receipt">
          <span>{t('bills.receipt')}</span>
          <input
            id="bill-receipt"
            className="field"
            value={receiptRef}
            onChange={(event) => setReceiptRef(event.target.value)}
          />
        </label>
      </div>

      {/*
        THE POSTING PREVIEW. Present figures only: while a preview is in flight the panel dims rather
        than presenting the previous answer as current, and with no answer at all it renders nothing
        instead of `CHF 0.00`.
      */}
      <section className={previewing ? 'bill-preview bill-preview--pending' : 'bill-preview'} aria-live="polite">
        <h3>{t('bills.preview.title')}</h3>
        {preview === null ? (
          <p className="bill-dim">{t('bills.preview.none')}</p>
        ) : (
          <dl className="bill-split">
            <div>
              <dt>{t('bills.net')}</dt>
              <dd className="bill-num t-money">{formatMoney(preview.netMinor, 'CHF')}</dd>
            </div>
            <div>
              <dt>{t('bills.vat')}</dt>
              <dd className="bill-num t-money">{formatMoney(preview.taxMinor, 'CHF')}</dd>
            </div>
            <div>
              <dt>{t('bills.gross')}</dt>
              <dd className="bill-num t-money">{formatMoney(preview.grossMinor, 'CHF')}</dd>
            </div>
          </dl>
        )}
        {preview !== null && preview.taxMinor !== 0 && !preview.deductible && (
          <p className="bill-note">{t('bills.preview.saldo')}</p>
        )}
      </section>

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
 * One sentence per rejection this drawer can still receive, naming the field and the fix.
 *
 * The three the pickers make unreachable are absent on purpose, and so is any generic fallback that
 * would print an engine code at a person: an unrecognised rejection falls through to the shared banner
 * message, which says what happened without pretending to know why.
 */
export function billErrorMessage(t: (key: string, vars?: Record<string, string | number>) => string, error: Err): string {
  const reason = typeof error.reason === 'string' ? error.reason : '';
  switch (error.error) {
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
