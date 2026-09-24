/**
 * S2, the PaymentAllocator: the matching surface, and the only place A14 writes money.
 *
 * THE LAYOUT IS THE WERKBANK (owner decision D113, the D46 UX pass). On a wide viewport the task's
 * two halves sit side by side: the SEARCH space (the open-item candidates) scrolls on the left, and
 * the DECISION (the Zuteilung statement, the posting preview, the running Rest and the one write
 * control) stays fixed on the right, so the remainder never leaves the viewport while the eye works
 * down the candidate list. Below ~1100px the two panes STACK into the order the work happens (money,
 * candidates, statement, bar), so ONE component serves both widths. It opens as a real route
 * (`/payments/new`), reachable and reloadable at a URL, and is identical from all four entry points,
 * so the OP-Liste (A16), the vendor-bill list (A17) and reconciliation (A20a/A21) open THIS surface
 * rather than building an allocation control of their own. One visual answer to one job.
 *
 * EXACTLY ONE CONTROL HERE WRITES TO THE LEDGER. "Als Guthaben parken" is not a second one: it fills
 * the Guthaben field with the remainder and nothing more. Same for "Differenz ausbuchen". They fill
 * fields; the confirm still gates every Rappen.
 *
 * THE ENGINE OWNS EVERY FIGURE. The remainder renders `preview_payment`'s `remainderMinor`, not
 * `amount - sum(inputs)`. The statement lines render the engine's per-row `paymentAmountMinor`,
 * `skontoMinor`/`skontoVatMinor` and `writeOffMinor`. The rows render the engine's `resultingOpenMinor`
 * and `resultingStatus`. The legs are the engine's legs. The GUI holds raw typed input and nothing
 * else (§4 rule 3).
 *
 * NOTHING POSTS ON FIGURES THE ENGINE HAS NOT CONFIRMED (§4 rule 4). While a preview is in flight the
 * previous figures dim and the confirm is held, because showing the last good figures as if they were
 * current is exactly the data dishonesty this product forbids. When the preview is blocked or refused,
 * the confirm is disabled WITH the reason on screen: a disabled control with no visible reason is a
 * logged defect class here (D15/C3).
 *
 * IT IS A REAL MODAL. `aria-modal` is enforced by `useFocusTrap`, not merely asserted: Tab cycles
 * inside the workbench and cannot walk out to the list behind the scrim, which the drawer this
 * replaced could not promise. The candidate amount fields are a single tab stop with ArrowUp/ArrowDown
 * roving between them (the OverflowMenu discipline transplanted to a list), so Tab reaches the decision
 * column in one press rather than after tabbing through every open item.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

import { useClient } from '../../lib/client-context';
import { isErr, type Err } from '../../lib/client';
import { useWorkspaceId } from '../../app/workspace';
import { useT, formatMoney, formatDate } from '../../i18n';
import { EmptyState, Skeleton } from '../../components/states';
import { Select } from '../../components/Select';
import { useFocusTrap } from '../../components/useFocusTrap';
import { CloseGlyph } from '../../components/icons';
import {
  asArray,
  type BankAccountOption,
  type Candidate,
  type PaymentPreview,
  type PreviewRow,
  type SuggestMatches,
} from './model';
import { previewPaymentRequest, recordPaymentRequest, allocatePaymentRequest, type AllocationRequest } from './intent';
import { parseAmountToMinor, minorToInput } from './amount';
import { useIdempotencyKey } from '../../lib/idempotency';
import { shouldConfirmPost, setConfirmPostSuppressed } from './confirm-preference';
import { PaymentError, paymentErrorMessage, blockerAsErr } from './PaymentError';
import { PostConfirmDialog } from './PostConfirmDialog';
import { ConfirmDialog } from './ConfirmDialog';
import './Payments.css';

/** What the user has typed against one candidate row. Raw strings until the engine is asked. */
interface RowInput {
  amount: string;
  skonto: string;
  writeOff: string;
}

const EMPTY_ROW: RowInput = { amount: '', skonto: '', writeOff: '' };

export interface PaymentAllocatorProps {
  /** `record` mints a new payment; `allocate` spends an existing Guthaben (P13/P46). */
  mode: 'record' | 'allocate';
  paymentId?: string;
  /** Prefill from `/payments/new?amount=...`, the agent-to-human handover (P21) and the entry points. */
  prefill?: { amount?: string; date?: string; reference?: string; direction?: string; counterpartyId?: string };
  onClose: () => void;
  /**
   * Called after the write landed, with the payment's id (the engine's `paymentId`), so the list
   * the workbench closes onto can land THAT row with the Commit moment (D122 D-I).
   */
  onPosted: (paymentId?: string) => void;
}

export function PaymentAllocator({ mode, paymentId, prefill, onClose, onPosted }: PaymentAllocatorProps) {
  const t = useT();
  const client = useClient();
  const workspaceId = useWorkspaceId();

  // The money side. Typed, not fetched, so it renders immediately with no loading state of its own.
  const [direction, setDirection] = useState(prefill?.direction ?? 'incoming');
  const [amount, setAmount] = useState(prefill?.amount ?? '');
  const [date, setDate] = useState(prefill?.date ?? new Date().toISOString().slice(0, 10));
  const [reference, setReference] = useState(prefill?.reference ?? '');
  const [bankAccountId, setBankAccountId] = useState('');
  const [counterpartyId, setCounterpartyId] = useState(prefill?.counterpartyId ?? '');

  const [accounts, setAccounts] = useState<BankAccountOption[]>([]);
  const [accountsLoading, setAccountsLoading] = useState(true);
  const [contacts, setContacts] = useState<{ id: string; name: string }[]>([]);

  const [matches, setMatches] = useState<SuggestMatches | null>(null);
  const [matchesLoading, setMatchesLoading] = useState(true);
  const [matchesError, setMatchesError] = useState<Err | null>(null);

  const [preview, setPreview] = useState<PaymentPreview | null>(null);
  const [previewError, setPreviewError] = useState<Err | null>(null);
  const [previewing, setPreviewing] = useState(false);

  const [rows, setRows] = useState<Record<string, RowInput>>({});
  /**
   * The Guthaben field, and whether the chip has revealed it.
   *
   * The chip used to write `onAccount` and NOTHING rendered it, so "Als Guthaben parken" produced no
   * visible change at all: the remainder line was identical before and after, and the only trace was
   * an invisible `onAccountMinor` on the next preview request. The engine derives the credit from
   * amount minus allocations either way, so the stated figure is a cross-check and never a directive,
   * which is why nothing on screen moved. A control that does nothing visible teaches the operator
   * that it is broken. This is that field.
   */
  const [onAccount, setOnAccount] = useState('');
  const [showOnAccount, setShowOnAccount] = useState(false);
  const [showLegs, setShowLegs] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [posting, setPosting] = useState(false);
  const [postError, setPostError] = useState<Err | null>(null);

  const drawerRef = useRef<HTMLDivElement>(null);

  const amountMinor = parseAmountToMinor(amount) ?? 0;
  const currency = preview?.currency ?? 'CHF';

  // --- the reads -------------------------------------------------------------------------------

  useEffect(() => {
    if (workspaceId === null) return;
    let live = true;
    void (async () => {
      setAccountsLoading(true);
      const [accountsResp, contactsResp] = await Promise.all([
        client.call('list_accounts', { workspaceId }),
        client.call('list_contacts', { workspaceId }),
      ]);
      if (!live) return;
      if (!isErr(accountsResp.body)) {
        // S9 offers bank and cash accounts by NUMBER and NAME, never a raw id. `name` is
        // `list_accounts`' spelling: the payments read model's `label` does not exist on this read.
        const all = asArray<BankAccountOption>(accountsResp.body.accounts);
        const banklike = all.filter((a) => /^10[0-2]/.test(a.number));
        setAccounts(banklike);
        if (banklike.length > 0) setBankAccountId((current) => (current === '' ? banklike[0].id : current));
      }
      if (!isErr(contactsResp.body)) {
        setContacts(asArray<{ id: string; name: string }>(contactsResp.body.contacts));
      }
      setAccountsLoading(false);
    })();
    return () => {
      live = false;
    };
  }, [client, workspaceId]);

  const loadMatches = useCallback(async () => {
    if (workspaceId === null) return;
    setMatchesLoading(true);
    setMatchesError(null);
    const response = await client.call('suggest_payment_matches', {
      workspaceId,
      direction,
      ...(amountMinor > 0 ? { amountMinor } : {}),
      ...(reference === '' ? {} : { reference }),
      ...(counterpartyId === '' ? {} : { counterpartyId }),
    });
    if (isErr(response.body)) {
      setMatchesError(response.body);
      setMatchesLoading(false);
      return;
    }
    setMatches(response.body as unknown as SuggestMatches);
    setMatchesLoading(false);
  }, [client, workspaceId, direction, amountMinor, reference, counterpartyId]);

  useEffect(() => {
    void loadMatches();
  }, [loadMatches]);

  /**
   * Which KIND each candidate is, read off the engine's own answer.
   *
   * A17 arrived, so `suggest_payment_matches` returns vendor bills for an outgoing payment alongside
   * documents. The allocations below key on the target id and MUST say which table it belongs to: an
   * id sent without its kind is looked up in `document`, and a bill that plainly exists comes back
   * `not_found`. Derived from the candidate the row was built from, never inferred from the direction
   * (an outgoing payment can refund a credit note, which IS a document).
   */
  const kindByTarget = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of matches?.candidates ?? []) m.set(c.targetId, c.targetKind);
    return m;
  }, [matches]);

  /** The allocations as the wire takes them, built from what the user typed. */
  const allocations = useMemo<AllocationRequest[]>(() => {
    const out: AllocationRequest[] = [];
    for (const [documentId, input] of Object.entries(rows)) {
      const minor = parseAmountToMinor(input.amount);
      if (minor === null || minor <= 0) continue;
      const skonto = parseAmountToMinor(input.skonto);
      const writeOff = parseAmountToMinor(input.writeOff);
      const kind = kindByTarget.get(documentId);
      out.push({
        documentId,
        // A vendor bill or a booked Mahngebühr (K-29) is NOT a document: the engine keys the
        // settlement on `(target_kind, target_id)`, so the kind travels with the id. `documentId`
        // carries the dunning_item id here, and `targetKind: 'dunning_fee'` is what makes the engine
        // read it out of `dunning_item` and settle the FEE receivable, never the invoice principal.
        ...(kind === 'vendor_bill' || kind === 'dunning_fee' ? { targetKind: kind } : {}),
        amountMinor: minor,
        ...(skonto === null || skonto === 0 ? {} : { skontoMinor: skonto }),
        ...(writeOff === null || writeOff === 0 ? {} : { writeOffMinor: writeOff }),
      });
    }
    return out;
  }, [rows, kindByTarget]);

  const onAccountMinor = parseAmountToMinor(onAccount);

  /**
   * ONE key per QUESTION, not one per drawer session (§4 rule 6). The question is stated as EXACTLY
   * the fields the matching post sends, per mode, so an edited plan is a new question and a re-clicked
   * unchanged one is still a single payment. See `app/src/lib/idempotency.ts` for the full reasoning.
   */
  const idempotencyKey = useIdempotencyKey(
    mode === 'allocate' && paymentId !== undefined
      ? ['allocate_payment', paymentId, allocations]
      : [
          'record_payment',
          direction,
          date,
          amountMinor,
          bankAccountId,
          counterpartyId,
          reference,
          allocations,
          onAccountMinor,
        ],
  );

  const runPreview = useCallback(async () => {
    if (workspaceId === null || bankAccountId === '' || amountMinor <= 0) {
      setPreview(null);
      setPreviewError(null);
      return;
    }
    setPreviewing(true);
    const response = await client.call(
      'preview_payment',
      previewPaymentRequest({
        workspaceId,
        direction,
        date,
        amountMinor,
        bankAccountId,
        counterpartyId: counterpartyId === '' ? null : counterpartyId,
        reference: reference === '' ? null : reference,
        allocations,
        ...(onAccountMinor === null ? {} : { onAccountMinor }),
      }),
    );
    if (isErr(response.body)) {
      // A REFUSAL of the whole call (needs_fx_rate, needs_bank_account). Distinct from a `blocker`,
      // which arrives on a successful response and still renders a plan.
      setPreviewError(response.body);
      setPreview(null);
      setPreviewing(false);
      return;
    }
    setPreviewError(null);
    setPreview(response.body as unknown as PaymentPreview);
    setPreviewing(false);
  }, [
    client,
    workspaceId,
    direction,
    date,
    amountMinor,
    bankAccountId,
    counterpartyId,
    reference,
    allocations,
    onAccountMinor,
  ]);

  useEffect(() => {
    void runPreview();
  }, [runPreview]);

  // --- the write -------------------------------------------------------------------------------

  const post = useCallback(async () => {
    if (workspaceId === null) return;
    setPosting(true);
    setPostError(null);

    // The intent is attached by the request builder and is NOT a parameter here. Whether the dialog
    // was shown cannot reach this call (P9).
    const body =
      mode === 'allocate' && paymentId !== undefined
        ? allocatePaymentRequest({
            workspaceId,
            paymentId,
            allocations,
            idempotencyKey,
          })
        : recordPaymentRequest({
            workspaceId,
            direction,
            date,
            amountMinor,
            bankAccountId,
            counterpartyId: counterpartyId === '' ? null : counterpartyId,
            reference: reference === '' ? null : reference,
            allocations,
            ...(onAccountMinor === null ? {} : { onAccountMinor }),
            idempotencyKey,
          });

    const response = await client.call(mode === 'allocate' ? 'allocate_payment' : 'record_payment', body);
    setPosting(false);
    setConfirming(false);

    if (isErr(response.body)) {
      // Every typed value is preserved and focus returns into the workbench, so Escape still closes it
      // (the A06-G4 defect: a rejected post dropped focus to <body>).
      setPostError(response.body);
      drawerRef.current?.focus();
      return;
    }
    const answered = (response.body as { paymentId?: unknown }).paymentId;
    onPosted(typeof answered === 'string' ? answered : paymentId);
  }, [
    client,
    workspaceId,
    mode,
    paymentId,
    allocations,
    direction,
    date,
    amountMinor,
    bankAccountId,
    counterpartyId,
    reference,
    onAccountMinor,
    idempotencyKey,
    onPosted,
  ]);

  /** The one control that writes. It asks first, unless this operator has said not to (P9). */
  const submit = useCallback(() => {
    if (shouldConfirmPost(workspaceId)) {
      setConfirming(true);
      return;
    }
    void post();
  }, [workspaceId, post]);

  const dirty = amount !== '' || allocations.length > 0 || reference !== '';

  const requestClose = useCallback(() => {
    // S8: one question before typed money is thrown away. A clean workbench closes immediately.
    if (dirty) setDiscarding(true);
    else onClose();
  }, [dirty, onClose]);

  // The real focus trap the drawer never had: Tab cycles inside, Escape asks before discarding, and
  // focus returns to the opener on close. Held OPEN (inactive) while a nested dialog owns focus, so
  // the two traps never fight over where Tab lands.
  useFocusTrap(drawerRef, {
    onEscape: requestClose,
    active: !confirming && !discarding,
  });

  const blocker = preview?.error ?? null;
  const remainderMinor = preview?.remainderMinor ?? null;

  /**
   * The confirm is enabled only when the engine has confirmed the figures on screen. Four separate
   * reasons hold it, and each one puts its reason where the user is looking. Both rejection branches
   * go through `paymentErrorMessage`, the SAME path the error panel uses, so the inline reason and the
   * panel are one sentence from one interpolation.
   */
  const blockedReason: string | null = previewing
    ? t('payment.preview.stale')
    : previewError !== null
      ? paymentErrorMessage(t, previewError, currency)
      : blocker !== null
        ? paymentErrorMessage(t, blockerAsErr(blocker), currency)
        : preview === null
          ? t('payment.empty.preview')
          : null;
  const canPost = blockedReason === null && !posting;

  // A14-U3: when the statement pane already states "nothing allocated yet" (preview is null, no
  // refusal in flight), the separate blocked-reason line under the confirm would render the identical
  // sentence inches away. The reason belongs once. So it is suppressed for exactly that case; every
  // other reason (stale, a refusal, a blocker) still shows beside the disabled control.
  const reasonIsEmptyDuplicate = preview === null && previewError === null && !previewing;

  /** The statement lines: one per candidate the engine has planned a settlement against. */
  const statementRows: PreviewRow[] = (preview?.rows ?? []).filter(
    (row) => row.paymentAmountMinor > 0 || row.skontoMinor > 0 || row.writeOffMinor > 0,
  );

  // --- roving across the candidate amount fields (one tab stop, ArrowUp/Down between rows) --------
  const inputTargetIds = useMemo(
    () => (matches?.candidates ?? []).filter((c) => !c.settled).map((c) => c.targetId),
    [matches],
  );
  const [activeInputId, setActiveInputId] = useState<string | null>(null);
  const inputRefs = useRef<Map<string, HTMLInputElement | null>>(new Map());
  const activeInput = activeInputId !== null && inputTargetIds.includes(activeInputId) ? activeInputId : inputTargetIds[0] ?? null;

  const moveInput = useCallback(
    (fromId: string, delta: number) => {
      const index = inputTargetIds.indexOf(fromId);
      if (index === -1) return;
      const nextIndex = index + delta;
      if (nextIndex < 0 || nextIndex >= inputTargetIds.length) return;
      const nextId = inputTargetIds[nextIndex];
      setActiveInputId(nextId);
      inputRefs.current.get(nextId)?.focus();
    },
    [inputTargetIds],
  );

  return (
    <>
      <div className="pay-scrim" role="presentation" onClick={requestClose} />
      <div
        className="pay-wb"
        role="dialog"
        aria-modal="true"
        aria-label={t('payment.record')}
        ref={drawerRef}
        tabIndex={-1}
      >
        <header className="pay-wb-head">
          <h2 className="pay-wb-title">
            {mode === 'allocate' ? t('payment.allocateCredit.label') : t('payment.record')}
          </h2>
          <button
            type="button"
            className="btn btn--ghost btn--icon pay-wb-close"
            onClick={requestClose}
            aria-label={t('payment.close')}
          >
            <CloseGlyph size={18} />
          </button>
        </header>

        {mode === 'allocate' && <p className="pay-warning">{t('payment.allocateCredit.warning')}</p>}

        {/* --- 1. THE MONEY, across the top (P8) --------------------------------------------------- */}
        <div className="pay-money">
          <div className="pay-field">
            <span>{t('payment.column.direction')}</span>
            {/* Incoming and outgoing are ONE surface, not two. A14 already carries both directions
                and A17's vendor bills open this same workbench with direction=outgoing. */}
            <Select
              value={direction}
              onChange={setDirection}
              disabled={mode === 'allocate'}
              options={[
                { value: 'incoming', label: t('payment.direction.incoming') },
                { value: 'outgoing', label: t('payment.direction.outgoing') },
              ]}
              ariaLabel={t('payment.column.direction')}
            />
          </div>
          <label className="pay-field">
            <span>{t('payment.amount')}</span>
            <input className="field"
              inputMode="decimal"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              disabled={mode === 'allocate'}
            />
          </label>
          <label className="pay-field">
            <span>{t('payment.date')}</span>
            <input className="field" type="date" value={date} onChange={(event) => setDate(event.target.value)} />
          </label>
          <div className="pay-field">
            <span>{t('payment.bankAccount')}</span>
            {/* S9. Its empty state is a banner-CTA and NOT an empty select, because an empty
                dropdown is a dead end that looks like a working control. */}
            {accountsLoading ? (
              <select className="field" disabled aria-busy="true">
                <option>{''}</option>
              </select>
            ) : accounts.length === 0 ? (
              <span className="pay-inline-empty">
                {t('payment.error.needs_bank_account')}{' '}
                <Link to="/setup" className="pay-link">
                  {t('payment.errorCta.needs_bank_account')}
                </Link>
              </span>
            ) : (
              <Select
                value={bankAccountId}
                onChange={setBankAccountId}
                options={accounts.map((account) => ({ value: account.id, label: `${account.number} ${account.name}` }))}
                ariaLabel={t('payment.bankAccount')}
              />
            )}
          </div>
          <div className="pay-field">
            <span>{t('payment.counterparty.label')}</span>
            <Select
              value={counterpartyId}
              onChange={setCounterpartyId}
              options={[
                { value: '', label: '' },
                ...contacts.map((contact) => ({ value: contact.id, label: contact.name })),
              ]}
              ariaLabel={t('payment.counterparty.label')}
            />
          </div>
          <label className="pay-field pay-field--wide">
            <span>{t('payment.reference.label')}</span>
            <input className="field"
              value={reference}
              onChange={(event) => setReference(event.target.value)}
              placeholder={t('payment.reference.hint')}
            />
            {/* State which reference kind was recognised, so a user who pasted a SCOR is not left
                wondering whether it was understood. */}
            {matches?.reference?.kind === 'qrr' && <small className="pay-hint">{t('payment.reference.qrr')}</small>}
            {matches?.reference?.kind === 'scor' && <small className="pay-hint">{t('payment.reference.scor')}</small>}
            {matches?.reference?.valid === false && (
              <small className="pay-hint pay-hint--bad">{t('payment.error.reference_check_digit')}</small>
            )}
          </label>
        </div>

        {/* --- THE PANEL: one surface, two panes, a single hairline between (D113) ---------------- */}
        <div className="pay-wb-panel">
          {/* LEFT: the candidates (S4), scrolls independently. */}
          <section className="pay-wb-left" aria-label={t('payment.candidates')}>
            <h3 className="pay-section-title">
              {t('payment.candidates')}
              {matches !== null && (
                // Two numbers, deliberately separate: a ranked list must never read as a filtered one.
                <span className="pay-count">
                  {t('payment.candidatesCount', {
                    n: matches.referenceMatchCount,
                    total: matches.openItemCount,
                  })}
                </span>
              )}
            </h3>

            {matchesLoading ? (
              <Skeleton rows={3} />
            ) : matchesError !== null ? (
              <PaymentError error={matchesError} currency={currency} onRetry={() => void loadMatches()} />
            ) : matches === null || matches.candidates.length === 0 ? (
              matches !== null && matches.openItemCount === 0 ? (
                // Empty state (a): nothing is open at all. The way out is to issue an invoice.
                <EmptyState
                  title={t('payment.empty.noOpenItems')}
                  action={{ label: t('payment.empty.noOpenItemsIssue'), to: '/documents' }}
                />
              ) : (
                // Empty state (b): things are open, but none fits THIS money. A different situation
                // with a different way out, and conflating the two is what makes a bare "No data"
                // panel useless.
                <EmptyState
                  title={t('payment.empty.noMatch')}
                  hint={t('payment.empty.noMatchJournal')}
                  action={{ label: t('payment.empty.noMatchWiden'), onClick: () => setReference('') }}
                />
              )
            ) : (
              <table className="pay-cand-table">
                <thead>
                  <tr>
                    <th scope="col">{t('payment.column.document')}</th>
                    <th scope="col">{t('payment.column.counterparty')}</th>
                    <th scope="col">{t('payment.column.due')}</th>
                    <th scope="col" className="pay-num">
                      {t('payment.openAmount')}
                    </th>
                    <th scope="col" className="pay-num">
                      {t('payment.allocate')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {matches.candidates.map((candidate) => (
                    <CandidateRow
                      key={candidate.targetId}
                      candidate={candidate}
                      input={rows[candidate.targetId] ?? EMPTY_ROW}
                      thresholdMinor={matches.writeOffThresholdMinor}
                      previewRow={preview?.rows.find((row) => row.targetId === candidate.targetId) ?? null}
                      onChange={(next) => setRows((current) => ({ ...current, [candidate.targetId]: next }))}
                      onRefresh={() => void loadMatches()}
                      amountTabIndex={candidate.targetId === activeInput ? 0 : -1}
                      registerAmount={(node) => inputRefs.current.set(candidate.targetId, node)}
                      onAmountFocus={() => setActiveInputId(candidate.targetId)}
                      onAmountKeyDown={(event) => {
                        // ArrowDown / Enter advance to the next row's amount; ArrowUp steps back. The
                        // candidate table is one tab stop, so Tab reaches the decision column at once.
                        if (event.key === 'ArrowDown' || event.key === 'Enter') {
                          event.preventDefault();
                          moveInput(candidate.targetId, 1);
                        } else if (event.key === 'ArrowUp') {
                          event.preventDefault();
                          moveInput(candidate.targetId, -1);
                        }
                      }}
                    />
                  ))}
                </tbody>
              </table>
            )}
          </section>

          {/* RIGHT: the decision column (S5). Sticky: the statement, the legs and the Rest never
              scroll away, and the one write control is always in view. */}
          <aside className={`pay-wb-right${previewing ? ' pay-wb-right--stale' : ''}`}>
            {previewError !== null ? (
              // The refusal, rendered as a recoverable state with its own copy and its way out. A
              // `needs_fx_rate` here is a rate to record, not a payment to refuse (P10).
              <PaymentError error={previewError} currency={currency} onRetry={() => void runPreview()} />
            ) : (
              <>
                {/* A blocker still renders the plan; the refusal above does not. */}
                {blocker !== null && <PaymentError error={blockerAsErr(blocker)} currency={currency} />}

                {/* The Zuteilung statement: one line per settlement term, every figure the engine's. */}
                <div className="pay-statement" aria-label={t('payment.statement.label')}>
                  <h3 className="pay-section-title">{t('payment.statement.label')}</h3>
                  {preview === null ? (
                    <p className="pay-dim">{t('payment.empty.preview')}</p>
                  ) : (
                    <table className="pay-statement-table">
                      <tbody>
                        {statementRows.map((row) => (
                          <StatementLines key={row.targetId} row={row} currency={currency} />
                        ))}
                        {preview.onAccountMinor > 0 && (
                          <tr>
                            <td>{t('payment.statement.credit')}</td>
                            <td className="pay-num t-money">{formatMoney(preview.onAccountMinor, currency)}</td>
                          </tr>
                        )}
                        <tr className={`pay-statement-rest${remainderMinor === 0 ? ' pay-statement-rest--done' : ''}`}>
                          <td>{t('payment.statement.rest')}</td>
                          <td className="pay-num t-money">
                            {formatMoney(remainderMinor ?? 0, currency)}
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  )}
                </div>

                {/* The posting preview (the legs), only when there is a plan to show. */}
                {preview !== null && (
                  <div className="pay-preview">
                    <h3 className="pay-section-title">{t('payment.preview.label')}</h3>
                    <table className="pay-legs">
                      <tbody>
                        {(showLegs ? preview.legs : preview.legs.slice(0, 2)).map((leg, index) => (
                          <tr key={`${leg.accountId}-${index}`}>
                            <td>{`${leg.accountNumber} ${leg.accountLabel}`}</td>
                            <td className="pay-num t-money">
                              {leg.debitMinor > 0 ? `${t('payment.preview.debit')} ${formatMoney(leg.debitMinor, currency)}` : ''}
                            </td>
                            <td className="pay-num t-money">
                              {leg.creditMinor > 0 ? `${t('payment.preview.credit')} ${formatMoney(leg.creditMinor, currency)}` : ''}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>

                    {preview.legs.length > 2 && (
                      <button
                        type="button"
                        className="btn btn--ghost"
                        aria-expanded={showLegs}
                        onClick={() => setShowLegs((on) => !on)}
                      >
                        {t(showLegs ? 'payment.preview.hide' : 'payment.preview.show')}
                      </button>
                    )}

                    {/* Only rendered when they apply: no irrelevant field under soll, none on a CHF payment. */}
                    {preview.istVat !== null && (
                      <p className="pay-preview-line">
                        {t('payment.preview.istVat', {
                          date: formatDate(preview.istVat.recognizedAt),
                          amount: formatMoney(preview.istVat.taxMinor, currency),
                        })}
                      </p>
                    )}
                    {preview.fx !== null && (
                      <>
                        <p className="pay-preview-line">
                          {t('payment.preview.fxRate', {
                            rate: preview.fx.rate,
                            date: formatDate(preview.fx.rateAsOf ?? preview.date),
                          })}
                        </p>
                        <p className="pay-preview-line">
                          {t('payment.preview.fx')}:{' '}
                          <span className="t-money">
                            {formatMoney(preview.fx.realisedDiffMinor, preview.fx.baseCurrency)}
                          </span>
                        </p>
                      </>
                    )}
                  </div>
                )}
              </>
            )}

            {postError !== null && <PaymentError error={postError} currency={currency} onRetry={() => void post()} />}

            {/* The one write control, always in view. It carries the running remainder beside it. */}
            <div className="pay-remainder">
              <span className="pay-remainder-text">
                {remainderMinor === null
                  ? ''
                  : remainderMinor === 0
                    ? t('payment.remainder.done')
                    : remainderMinor > 0
                      ? t('payment.remainder.open', { amount: formatMoney(remainderMinor, currency) })
                      : t('payment.remainder.over', { amount: formatMoney(Math.abs(remainderMinor), currency) })}
              </span>

              {showOnAccount ? (
                // The field stays on screen once revealed, even when the remainder later reaches zero.
                // Unmounting it while it still held a value would put a figure on the wire that nothing
                // on screen accounts for.
                <label className="pay-field pay-field--inline">
                  <span>{t('payment.onAccount.field')}</span>
                  <input className="field"
                    inputMode="decimal"
                    value={onAccount}
                    onChange={(event) => setOnAccount(event.target.value)}
                  />
                </label>
              ) : remainderMinor !== null && remainderMinor > 0 ? (
                <>
                  {/* Fills the field. It does not post, and it is not a second write control. */}
                  <button
                    type="button"
                    className="btn btn--ghost"
                    // P12b: a Guthaben belongs to somebody, so the chip is held until the counterparty
                    // is picked, with the reason beside it rather than behind a rejected post.
                    disabled={counterpartyId === ''}
                    onClick={() => {
                      setOnAccount(minorToInput(remainderMinor));
                      setShowOnAccount(true);
                    }}
                  >
                    {t('payment.onAccount.label')}
                  </button>
                  {counterpartyId === '' && (
                    <small className="pay-hint">{t('payment.error.needs_counterparty')}</small>
                  )}
                </>
              ) : null}

              <div className="pay-remainder-actions">
                <button type="button" className="btn btn--secondary" onClick={requestClose}>
                  {t('payment.cancel')}
                </button>
                <button type="button" className="btn btn--primary" onClick={submit} disabled={!canPost}>
                  {t('payment.post')}
                </button>
              </div>
            </div>

            {/* A disabled confirm ALWAYS says why, inline, next to itself (D15/C3), EXCEPT where the
                statement pane above already states the identical empty condition (A14-U3). */}
            {blockedReason !== null && !reasonIsEmptyDuplicate && (
              <p className="pay-blocked-reason" role="status">
                {blockedReason}
              </p>
            )}
          </aside>
        </div>
      </div>

      {confirming && (
        <PostConfirmDialog
          amount={formatMoney(amountMinor, currency)}
          verb={mode === 'allocate' ? 'allocate_payment' : 'record_payment'}
          busy={posting}
          onConfirm={(suppress) => {
            // The preference is recorded, and it changes ONLY whether this dialog appears again.
            if (suppress) setConfirmPostSuppressed(workspaceId, true);
            void post();
          }}
          onCancel={() => setConfirming(false)}
        />
      )}

      {discarding && (
        <ConfirmDialog
          message={t('payment.confirm.discard')}
          confirmLabel={t('payment.confirm.discardConfirm')}
          cancelLabel={t('payment.confirm.discardKeep')}
          onConfirm={onClose}
          onCancel={() => setDiscarding(false)}
        />
      )}
    </>
  );
}

/**
 * The statement lines for one settled candidate (D113): the cash allocation plain, and the Skonto and
 * Ausbuchung as named settlement terms below it, dim and indented, so a discount is visibly a
 * settlement term and never confused with cash. Every figure is the engine's preview row.
 */
function StatementLines({ row, currency }: { row: PreviewRow; currency: string }) {
  const t = useT();
  return (
    <>
      <tr>
        <td>{row.number}</td>
        <td className="pay-num t-money">{formatMoney(row.paymentAmountMinor, currency)}</td>
      </tr>
      {row.skontoMinor > 0 && (
        <tr className="pay-statement-term">
          <td>{t('payment.statement.skonto')}</td>
          <td className="pay-num t-money">{formatMoney(row.skontoMinor + row.skontoVatMinor, currency)}</td>
        </tr>
      )}
      {row.writeOffMinor > 0 && (
        <tr className="pay-statement-term">
          <td>{t('payment.writeOff.noun')}</td>
          <td className="pay-num t-money">{formatMoney(row.writeOffMinor, currency)}</td>
        </tr>
      )}
    </>
  );
}

/**
 * One candidate row (S4), now a real table row with `scope="col"` headers above it.
 *
 * The document leads, the reason sits under it dim, the amount input sits in the Zuweisen column, and
 * the Skonto / Ausbuchung disclosures live on a sub-row so a dense list stays scannable. A row that
 * matches NO tier carries no reason word at all: labelling a CHF 540.00 open against a CHF 1'081.00
 * payment "Betrag ähnlich" would make the confidence vocabulary lie, and the vocabulary being honest
 * is its whole job (§3.2).
 */
function CandidateRow({
  candidate,
  input,
  thresholdMinor,
  previewRow,
  onChange,
  onRefresh,
  amountTabIndex,
  registerAmount,
  onAmountFocus,
  onAmountKeyDown,
}: {
  candidate: Candidate;
  input: RowInput;
  thresholdMinor: number;
  previewRow: { resultingOpenMinor: number; writeOffOfferedMinor: number } | null;
  onChange: (next: RowInput) => void;
  onRefresh: () => void;
  amountTabIndex: number;
  registerAmount: (node: HTMLInputElement | null) => void;
  onAmountFocus: () => void;
  onAmountKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => void;
}) {
  const t = useT();
  const [showSkonto, setShowSkonto] = useState(false);

  // P4: the one-click offer appears only within the threshold, INCLUSIVE at the boundary. Beyond it
  // the chip is ABSENT rather than disabled, and a larger Ausbuchung stays typeable. Nothing here
  // rounds a booked figure: this is a product setting, not a rounding rule.
  const offered = previewRow?.writeOffOfferedMinor ?? 0;
  const offerWriteOff = offered > 0 && offered <= thresholdMinor;

  // Everything under the main row: the reason word, "danach offen", the Skonto disclosure and the
  // Ausbuchung chip. Rendered as a sub-row only when there is something to say or do.
  const hasSubRow =
    !candidate.settled || candidate.kind !== null || previewRow !== null;

  return (
    <>
      <tr className={candidate.settled ? 'pay-cand-row pay-cand-row--stale' : 'pay-cand-row'}>
        <td className="pay-cand-doc">
          {/* A vendor bill is not a document, so it does not link into `/documents/:id`, which would
              be a dead route. Its label is the SUPPLIER's own invoice number, and A17 assigns none of
              its own, so a bill with no reference shows what it is instead of an empty link. */}
          {candidate.targetKind === 'vendor_bill' ? (
            <Link to={`/bills?bill=${candidate.targetId}`} className="pay-link">
              {candidate.number ?? t('payment.candidate.vendorBill')}
            </Link>
          ) : candidate.targetKind === 'dunning_fee' ? (
            // A booked Mahngebühr is not a routable document (its target is a `dunning_item` row, and
            // `/documents/:id` would be a dead route). Its label already names the invoice it rides
            // plus the escalation level, e.g. "R-2026-0001 Mahngebühr Stufe 1", so it stands as plain
            // text, exactly as A16's own fee rows carry a word-only chip rather than a link.
            <span className="pay-cand-fee">{candidate.number}</span>
          ) : (
            <Link to={`/documents/${candidate.targetId}`} className="pay-link">
              {candidate.number}
            </Link>
          )}
        </td>
        <td className="pay-cand-party">{candidate.contactName ?? ''}</td>
        <td className="pay-dim">
          {candidate.dueDate !== null ? formatDate(candidate.dueDate) : ''}
        </td>
        <td className="pay-num t-money">{formatMoney(candidate.openMinor, candidate.currency)}</td>
        <td className="pay-num pay-cand-amount">
          {candidate.settled ? (
            <span className="pay-dim">{t('payment.settledAlready')}</span>
          ) : (
            <input className="field"
              inputMode="decimal"
              aria-label={t('payment.allocate')}
              value={input.amount}
              ref={registerAmount}
              tabIndex={amountTabIndex}
              onFocus={onAmountFocus}
              onKeyDown={onAmountKeyDown}
              onChange={(event) => onChange({ ...input, amount: event.target.value })}
            />
          )}
        </td>
      </tr>

      {hasSubRow && (
        <tr className={candidate.settled ? 'pay-cand-sub pay-cand-sub--stale' : 'pay-cand-sub'}>
          <td colSpan={5}>
            {/* The reason, in words, and ONLY when the engine gave the row a tier. */}
            {candidate.kind !== null && (
              <span className="pay-cand-reason">
                {t(`payment.match.${candidate.kind}`, {
                  amount: formatMoney(Math.abs(candidate.deltaMinor), candidate.currency),
                })}
              </span>
            )}

            {candidate.settled ? (
              <span className="pay-cand-stale">
                {t('payment.settledAlready')}{' '}
                <button type="button" className="btn btn--ghost" onClick={onRefresh}>
                  {t('payment.refreshCandidates')}
                </button>
              </span>
            ) : (
              <span className="pay-cand-controls">
                {previewRow !== null && (
                  <span className="pay-dim pay-after">
                    {t('payment.afterwardsOpen')}{' '}
                    <span className="t-money">{formatMoney(previewRow.resultingOpenMinor, candidate.currency)}</span>
                  </span>
                )}

                {showSkonto ? (
                  <label className="pay-field pay-field--inline">
                    <span>{t('payment.skonto')}</span>
                    <input className="field"
                      inputMode="decimal"
                      value={input.skonto}
                      onChange={(event) => onChange({ ...input, skonto: event.target.value })}
                    />
                  </label>
                ) : (
                  <button type="button" className="btn btn--ghost" onClick={() => setShowSkonto(true)}>
                    {`+ ${t('payment.skonto')}`}
                  </button>
                )}

                {offerWriteOff && (
                  <button
                    type="button"
                    className="btn btn--ghost"
                    onClick={() => onChange({ ...input, writeOff: minorToInput(offered) })}
                  >
                    {t('payment.writeOff.label')}
                  </button>
                )}
              </span>
            )}
          </td>
        </tr>
      )}
    </>
  );
}
