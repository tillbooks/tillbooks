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
 *
 * IT ASKS ONLY WHAT IT CANNOT INFER (D152, the cognitive-load pass). At rest the Werkbank is the money
 * and one quiet line: the open items stay out of view until a Betrag or a Gegenpartei gives TILL
 * something to rank them by. Then only the SUGGESTIONS show (the engine's tiers, and the chosen
 * Gegenpartei's own items) with their Zuweisen field; every other open item waits behind one
 * disclosure and is picked with one click. Skonto lives in the editor of a row that carries an
 * allocation, never on every row at rest. Two defaults are inferred, and both are VISIBLE before
 * anything posts: the Konto comes from the Bankkonten (`inferBankLedgerAccount`), never from the
 * chart's first cash account, and the ENGINE's own complete prefill (`enginePreAssignment`) is pre-assigned under a
 * "zugewiesen" mark with its own undo. Zahlung buchen is absent, not disabled, while the control that
 * unlocks it sits beside it; the next step is said in its place.
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
import { CheckGlyph } from '../../components/states/glyphs';
import {
  asArray,
  confirmMayPost,
  enginePreAssignment,
  inferBankLedgerAccount,
  type BankAccountLink,
  type BankAccountOption,
  type Candidate,
  type Payment,
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

/** One post as it was shown to the person: the question, the request it sends, and what was pre-assigned. */
interface PostSnapshot {
  question: string;
  verb: 'record_payment' | 'allocate_payment';
  body: Record<string, unknown>;
  preAssignedId: string | null;
}

export interface PaymentAllocatorProps {
  /** `record` mints a new payment; `allocate` spends an existing Guthaben (P13/P46). */
  mode: 'record' | 'allocate';
  paymentId?: string;
  /** Prefill from `/payments/new?amount=...`, the agent-to-human handover (P21) and the entry points. */
  prefill?: {
    amount?: string;
    date?: string;
    reference?: string;
    direction?: string;
    counterpartyId?: string;
    /** The ledger account the payment came through, when the entry point knows it (it wins over the default). */
    bankAccountId?: string;
  };
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
  /**
   * The Konto a PERSON chose (or the entry point named). Empty means "nobody chose": the Konto then
   * falls back to the inferred default below, which is derived on every render rather than written
   * into this state, so a direction change re-derives it and nothing stale is ever posted.
   */
  const [chosenAccountId, setChosenAccountId] = useState(prefill?.bankAccountId ?? '');
  const [counterpartyId, setCounterpartyId] = useState(prefill?.counterpartyId ?? '');

  const [accounts, setAccounts] = useState<BankAccountOption[]>([]);
  const [bankLinks, setBankLinks] = useState<BankAccountLink[]>([]);
  const [baseCurrency, setBaseCurrency] = useState<string | null>(null);
  const [accountsLoading, setAccountsLoading] = useState(true);
  const [contacts, setContacts] = useState<{ id: string; name: string }[]>([]);

  /**
   * The candidates, with the WHOLE question they answer (critic R2-F5): the exact request
   * `suggest_payment_matches` received, as `previewFor` holds the preview's. A list remembered only by
   * its direction once pre-assigned an item for a reference the person had since replaced.
   */
  const [matches, setMatches] = useState<{ data: SuggestMatches; direction: string; askedFor: string } | null>(null);
  /** The suggest request the last settled answer (a list OR a refusal) was for. */
  const [matchesAnsweredFor, setMatchesAnsweredFor] = useState<string | null>(null);
  const [matchesLoading, setMatchesLoading] = useState(false);
  const [matchesError, setMatchesError] = useState<Err | null>(null);
  /** Monotonic read counters: an answer that a newer read overtook is dropped, never rendered. */
  const matchesSeq = useRef(0);
  const previewSeq = useRef(0);
  /** False once the Werkbank unmounted (a close, or a workspace switch remounting it). */
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const [preview, setPreview] = useState<PaymentPreview | null>(null);
  const [previewError, setPreviewError] = useState<Err | null>(null);

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
  /** The disclosure holding every open item that is not a suggestion. Closed until the person opens it. */
  const [showAll, setShowAll] = useState(false);
  /**
   * Pre-assignments the person undid, keyed by the QUESTION that produced them (item, Betrag,
   * Gegenpartei). A changed Betrag or Gegenpartei is a new question and may pre-assign again; the same
   * one never re-applies behind the person's back.
   */
  const [declined, setDeclined] = useState<ReadonlySet<string>>(() => new Set());
  const [confirming, setConfirming] = useState(false);
  /**
   * What the person was asked to confirm (critic F3): the whole post, its key, and the pre-assignment
   * shown at the click. While the dialog is open the derived pre-assignment is FROZEN to this, so a
   * late candidate answer cannot change behind the dialog what the click will post.
   */
  const [confirmSnapshot, setConfirmSnapshot] = useState<PostSnapshot | null>(null);
  /** Said in place of a post the confirm refused because the question changed under it. */
  const [confirmNotice, setConfirmNotice] = useState<string | null>(null);
  /** The preview request the figures on screen answer, so a confirm never posts on another one's plan. */
  const [previewFor, setPreviewFor] = useState<string | null>(null);
  const [discarding, setDiscarding] = useState(false);
  const [posting, setPosting] = useState(false);
  const [postError, setPostError] = useState<Err | null>(null);

  const drawerRef = useRef<HTMLDivElement>(null);

  /**
   * ALLOCATION MODE reads the payment whose Guthaben it spends. Its money side was decided when it was
   * recorded, so it is READ, never typed: the Betrag is the credit still parked (`onAccountMinor`), and
   * direction, date, Konto and Gegenpartei are the payment's own. Without this read the Betrag stayed
   * empty, no preview ever ran, and a parked Guthaben could never be allocated from this Werkbank.
   */
  const [guthaben, setGuthaben] = useState<Payment | null>(null);
  const [guthabenError, setGuthabenError] = useState<Err | null>(null);
  const [guthabenLoading, setGuthabenLoading] = useState(mode === 'allocate');

  const amountMinor = parseAmountToMinor(amount) ?? 0;
  const currency = preview?.currency ?? guthaben?.currency ?? 'CHF';

  // --- the reads -------------------------------------------------------------------------------

  useEffect(() => {
    if (mode !== 'allocate' || paymentId === undefined || workspaceId === null) return;
    let live = true;
    void (async () => {
      setGuthabenLoading(true);
      const response = await client.call('get_payment', { workspaceId, paymentId });
      if (!live) return;
      setGuthabenLoading(false);
      if (isErr(response.body)) {
        setGuthabenError(response.body);
        return;
      }
      const payment = (response.body as { payment?: Payment }).payment;
      if (payment === undefined) {
        setGuthabenError({ ok: false, error: 'not_found', paymentId } as Err);
        return;
      }
      // The engine's own refusals, said before anything is planned rather than after a click.
      if (payment.status !== 'posted') {
        setGuthabenError({ ok: false, error: 'already_reversed', paymentId } as Err);
        return;
      }
      if (payment.onAccountMinor <= 0) {
        setGuthabenError({ ok: false, error: 'nothing_to_allocate', paymentId } as Err);
        return;
      }
      setGuthabenError(null);
      setGuthaben(payment);
      setAmount(minorToInput(payment.onAccountMinor));
      setDirection(payment.direction);
      setDate(payment.date);
      setCounterpartyId(payment.counterparty?.id ?? '');
    })();
    return () => {
      live = false;
    };
  }, [client, workspaceId, mode, paymentId]);

  useEffect(() => {
    if (workspaceId === null) return;
    let live = true;
    void (async () => {
      setAccountsLoading(true);
      // The Bankkonten and the base currency feed the Konto DEFAULT only. Either read failing (a
      // missing capability, a transport error) leaves the picker asking, never falling back to Kasse.
      const [accountsResp, contactsResp, banksResp, profileResp] = await Promise.all([
        client.call('list_accounts', { workspaceId }),
        client.call('list_contacts', { workspaceId }),
        client.call('list_bank_accounts', { workspaceId }),
        client.call('get_company_profile', { workspaceId }),
      ]);
      if (!live) return;
      if (!isErr(accountsResp.body)) {
        // S9 offers bank and cash accounts by NUMBER and NAME, never a raw id. `name` is
        // `list_accounts`' spelling: the payments read model's `label` does not exist on this read.
        // The ORDER is the chart's, and it is NOT a default: 1000 Kassenbestand sorts first, and
        // preselecting it booked bank money on the till whenever nobody read the picker.
        const all = asArray<BankAccountOption>(accountsResp.body.accounts);
        setAccounts(all.filter((a) => /^10[0-2]/.test(a.number)));
      }
      if (!isErr(banksResp.body)) {
        setBankLinks(asArray<BankAccountLink>(banksResp.body.bankAccounts));
      }
      if (!isErr(profileResp.body)) {
        const base = (profileResp.body.profile as { baseCurrency?: unknown } | undefined)?.baseCurrency;
        setBaseCurrency(typeof base === 'string' && base !== '' ? base : null);
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

  /**
   * Whether there is anything to rank the open items BY. At rest (no Betrag, no Gegenpartei) the list
   * is not asked for at all: twenty unranked rows with a field each was the measured load this pass
   * removes. Allocation mode spends an existing payment, so it always asks.
   */
  const asking = mode === 'allocate' || amountMinor > 0 || counterpartyId !== '';

  /** Exactly what `suggest_payment_matches` is asked, and its key: the question a list answers. */
  const matchesRequest = useMemo(
    () =>
      workspaceId === null || !asking
        ? null
        : {
            workspaceId,
            direction,
            ...(amountMinor > 0 ? { amountMinor } : {}),
            ...(reference === '' ? {} : { reference }),
            ...(counterpartyId === '' ? {} : { counterpartyId }),
          },
    [workspaceId, asking, direction, amountMinor, reference, counterpartyId],
  );
  const matchesKey = matchesRequest === null ? null : JSON.stringify(matchesRequest);

  const loadMatches = useCallback(async () => {
    if (workspaceId === null) return;
    const seq = ++matchesSeq.current;
    if (matchesRequest === null || matchesKey === null) {
      setMatches(null);
      setMatchesError(null);
      setMatchesAnsweredFor(null);
      setMatchesLoading(false);
      return;
    }
    setMatchesLoading(true);
    setMatchesError(null);
    const response = await client.call('suggest_payment_matches', matchesRequest);
    // A newer read overtook this one: its answer is about a question nobody is asking any more.
    if (seq !== matchesSeq.current || !mounted.current) return;
    setMatchesAnsweredFor(matchesKey);
    if (isErr(response.body)) {
      setMatchesError(response.body);
      setMatchesLoading(false);
      return;
    }
    setMatches({ data: response.body as unknown as SuggestMatches, direction: matchesRequest.direction, askedFor: matchesKey });
    setMatchesLoading(false);
  }, [client, workspaceId, matchesRequest, matchesKey]);

  useEffect(() => {
    void loadMatches();
  }, [loadMatches]);

  /**
   * The candidate list SHOWN: the last one for this direction, kept on screen while a newer question is
   * out so the rows do not blink on every keystroke. A list asked for the other direction is never used.
   * What may PRE-ASSIGN is stricter: only a list answering the current question (`listIsCurrent`).
   */
  const current: SuggestMatches | null = matches !== null && matches.direction === direction ? matches.data : null;
  const listIsCurrent = matches !== null && matches.askedFor === matchesKey;
  const candidates = useMemo(() => current?.candidates ?? [], [current]);

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
    for (const c of candidates) m.set(c.targetId, c.targetKind);
    return m;
  }, [candidates]);

  /**
   * The pre-assignment (brief B7, corrected by critic F1). It is the ENGINE's prefill, taken only when
   * complete and unambiguous (`enginePreAssignment`): the Studio ranks nothing of its own, so a QR
   * reference naming one invoice can never lose to an amount coincidence on another. The whole Betrag
   * goes in, exactly the string a person would type into its Zuweisen field, so the wire cannot tell
   * the two apart. It is DERIVED, never written into `rows`: a Betrag or Gegenpartei that stops
   * matching takes it away with nothing stale left behind, and a person's own entry on any row (this
   * one included) always wins. It shows as "zugewiesen" with an undo, so it is never silent. While the
   * confirm dialog is open it is frozen to what the person saw at the click (critic F3).
   */
  const engineAnswer = useMemo(
    () =>
      mode === 'record' && asking && listIsCurrent
        ? enginePreAssignment(candidates, amountMinor, counterpartyId)
        : { target: null, tied: [] as Candidate[] },
    [mode, asking, listIsCurrent, candidates, amountMinor, counterpartyId],
  );
  const handAssigned = Object.values(rows).some((input) => (parseAmountToMinor(input.amount) ?? 0) > 0);
  const exactKey = (targetId: string) => `${targetId}|${amountMinor}|${counterpartyId}`;
  const exactTarget = engineAnswer.target;
  const livePreAssignedId: string | null =
    exactTarget !== null &&
    rows[exactTarget.targetId] === undefined &&
    !handAssigned &&
    !declined.has(exactKey(exactTarget.targetId))
      ? exactTarget.targetId
      : null;
  const preAssignedId = confirmSnapshot !== null ? confirmSnapshot.preAssignedId : livePreAssignedId;
  const ambiguousIds = useMemo(() => new Set(engineAnswer.tied.map((c) => c.targetId)), [engineAnswer]);

  /** What the wire sees: the person's rows, plus the visible pre-assignment when there is one. */
  const effectiveRows = useMemo<Record<string, RowInput>>(
    () =>
      preAssignedId === null
        ? rows
        : { ...rows, [preAssignedId]: { ...EMPTY_ROW, amount: minorToInput(amountMinor) } },
    [rows, preAssignedId, amountMinor],
  );

  /** The allocations as the wire takes them, built from what the user typed (and the shown pre-assignment). */
  const allocations = useMemo<AllocationRequest[]>(() => {
    const out: AllocationRequest[] = [];
    for (const [documentId, input] of Object.entries(effectiveRows)) {
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
  }, [effectiveRows, kindByTarget]);

  /**
   * The Konto. A person's choice (or the entry point's) wins; otherwise the default inferred from the
   * Bankkonten, shown in the picker before anything posts; otherwise nothing, and the picker asks.
   * A chosen id the picker does not offer (a stale URL) is not used.
   */
  const inferredAccountId = useMemo(
    () => inferBankLedgerAccount(accounts, bankLinks, direction, baseCurrency),
    [accounts, bankLinks, direction, baseCurrency],
  );
  const bankAccountId =
    mode === 'allocate'
      ? // The account the parked money already landed on. Allocation books nothing, so this is the
        // payment's own Konto, carried only so the preview plans the same payment the engine replans.
        (guthaben?.bankAccount.id ?? '')
      : chosenAccountId !== '' && accounts.some((account) => account.id === chosenAccountId)
        ? chosenAccountId
        : (inferredAccountId ?? '');

  const onAccountMinor = parseAmountToMinor(onAccount);

  /**
   * ONE key per QUESTION, not one per drawer session (§4 rule 6). The question is stated as EXACTLY
   * the fields the matching post sends, per mode, so an edited plan is a new question and a re-clicked
   * unchanged one is still a single payment. See `app/src/lib/idempotency.ts` for the full reasoning.
   */
  const idempotencyKey = useIdempotencyKey(
    mode === 'allocate' && paymentId !== undefined
      ? ['allocate_payment', workspaceId, paymentId, allocations]
      : [
          'record_payment',
          workspaceId,
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

  /**
     * In allocation mode the preview plans the PARKED CREDIT as the payment: the Betrag is
     * `onAccountMinor`, with the payment's own direction, date, currency, Konto and Gegenpartei.
     * `allocate_payment` replans the whole payment with `existingAllocatedMinor = amount - credit`,
     * and `planPayment` uses that figure only to subtract it from the amount, so both plans compute
     * the same rows, the same remainder and the same blockers. The reference is left out because the
     * replan carries none. The legs are NOT shown in this mode: allocating moves no money.
     */
  const previewRequest = useMemo(() => {
    if (workspaceId === null || bankAccountId === '' || amountMinor <= 0) return null;
    const allocating = mode === 'allocate' && guthaben !== null;
    return previewPaymentRequest({
        workspaceId,
        direction,
        date,
        amountMinor,
        bankAccountId,
        counterpartyId: counterpartyId === '' ? null : counterpartyId,
        allocations,
        ...(allocating
          ? {
              currency: guthaben.currency,
              ...(guthaben.counterparty === null ? {} : { counterpartyKind: guthaben.counterparty.kind }),
            }
          : {
              reference: reference === '' ? null : reference,
              ...(onAccountMinor === null ? {} : { onAccountMinor }),
            }),
    });
  }, [
    workspaceId,
    mode,
    guthaben,
    direction,
    date,
    amountMinor,
    bankAccountId,
    counterpartyId,
    reference,
    allocations,
    onAccountMinor,
  ]);
  const previewKey = previewRequest === null ? null : JSON.stringify(previewRequest);

  const runPreview = useCallback(async () => {
    const seq = ++previewSeq.current;
    if (previewRequest === null) {
      setPreview(null);
      setPreviewError(null);
      setPreviewFor(null);
      return;
    }
    const response = await client.call('preview_payment', previewRequest);
    // An answer a newer preview overtook describes figures no longer on screen: dropped, so the confirm
    // can never be enabled on a plan for a Betrag the person has since changed.
    if (seq !== previewSeq.current || !mounted.current) return;
    if (isErr(response.body)) {
      // A REFUSAL of the whole call (needs_fx_rate, needs_bank_account). Distinct from a `blocker`,
      // which arrives on a successful response and still renders a plan. It is still an ANSWER to this
      // request, so it is recorded as one.
      setPreviewError(response.body);
      setPreview(null);
      setPreviewFor(previewKey);
      return;
    }
    setPreviewError(null);
    setPreview(response.body as unknown as PaymentPreview);
    setPreviewFor(previewKey);
  }, [client, previewRequest, previewKey]);

  useEffect(() => {
    void runPreview();
  }, [runPreview]);

  // --- the write -------------------------------------------------------------------------------

  /**
   * The whole post as it would go out now, minus its key: the QUESTION. The confirm compares the one
   * it was shown against this one (critic F3), and a post sends exactly the question it was shown.
   */
  const postQuestion = useMemo(
    () =>
      JSON.stringify(
        mode === 'allocate' && paymentId !== undefined
          ? ['allocate_payment', workspaceId, paymentId, allocations]
          : [
              'record_payment',
              workspaceId,
              direction,
              date,
              amountMinor,
              bankAccountId,
              counterpartyId,
              reference,
              allocations,
              onAccountMinor,
            ],
      ),
    [mode, workspaceId, paymentId, direction, date, amountMinor, bankAccountId, counterpartyId, reference, allocations, onAccountMinor],
  );

  /** Build the request a snapshot names. The intent is the builder's, never a parameter (P9). */
  const snapshotNow = useCallback(
    (): PostSnapshot | null =>
      workspaceId === null
        ? null
        : {
            question: postQuestion,
            preAssignedId,
            verb: mode === 'allocate' ? 'allocate_payment' : 'record_payment',
            body:
              mode === 'allocate' && paymentId !== undefined
                ? allocatePaymentRequest({ workspaceId, paymentId, allocations, idempotencyKey })
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
                  }),
          },
    [
      workspaceId,
      postQuestion,
      preAssignedId,
      mode,
      paymentId,
      allocations,
      idempotencyKey,
      direction,
      date,
      amountMinor,
      bankAccountId,
      counterpartyId,
      reference,
      onAccountMinor,
    ],
  );

  const post = useCallback(async (snapshot: PostSnapshot) => {
    setPosting(true);
    setPostError(null);
    setConfirmNotice(null);

    const response = await client.call(snapshot.verb, snapshot.body);
    // The Werkbank closed or was remounted for another workspace while the write was out. Whatever the
    // answer, it belongs to a screen that no longer exists, so nothing here acts on it.
    if (!mounted.current) return;
    setPosting(false);
    setConfirming(false);
    setConfirmSnapshot(null);

    if (isErr(response.body)) {
      // Every typed value is preserved and focus returns into the workbench, so Escape still closes it
      // (the A06-G4 defect: a rejected post dropped focus to <body>).
      setPostError(response.body);
      drawerRef.current?.focus();
      return;
    }
    const answered = (response.body as { paymentId?: unknown }).paymentId;
    onPosted(typeof answered === 'string' ? answered : paymentId);
  }, [client, paymentId, onPosted]);


  // In allocation mode the Betrag is READ from the payment, so only an allocation is the person's work.
  const dirty = mode === 'allocate' ? allocations.length > 0 : amount !== '' || allocations.length > 0 || reference !== '';

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
  /**
   * THE ONE PREDICATE (critic R2-F5): everything the post depends on has answered the CURRENT question.
   * Two reads feed a post: the preview (its figures, its blockers) and the candidate list (what is
   * pre-assigned, and each row's kind). Each answer is keyed by the exact request it answered, and the
   * post is offered, and the confirm may post, only while BOTH keys equal the current requests. A read
   * in flight, an answer a newer read overtook, an answer for an older question: all of them are simply
   * "not answered for this question", so no case needs its own flag. The button (via `canPost`) and
   * `confirmMayPost` both take this one value.
   */
  const previewAnswered = previewKey !== null && previewFor === previewKey;
  const listAnswered = matchesKey === null || matchesAnsweredFor === matchesKey;
  const everythingAnswered = previewAnswered && listAnswered;
  const holding = previewKey !== null && !everythingAnswered;
  // The held line names what is actually pending, and an ANSWER outranks a wait (critic round 3): a
  // preview not yet answered for this question says so; once it HAS answered, its refusal or blocker is
  // the reason, even while the candidate list is still out; only then does a pending list speak.
  const blockedReason: string | null =
    previewKey !== null && !previewAnswered
      ? t('payment.preview.stale')
      : previewError !== null
        ? paymentErrorMessage(t, previewError, currency)
        : blocker !== null
          ? paymentErrorMessage(t, blockerAsErr(blocker), currency)
          : !listAnswered
            ? t('payment.preview.matching')
            : preview === null
              ? t('payment.empty.preview')
              : null;
  const canPost = everythingAnswered && blockedReason === null && !posting;

  /**
   * The one control that writes. It asks first, unless this operator has said not to (P9). What it
   * asks about is SNAPSHOTTED at the click, so the confirm can never post anything else.
   */
  const submit = useCallback(() => {
    // The same predicate as the button: a click that lands while a read is out posts nothing, whether
    // the confirm is shown or suppressed.
    if (!canPost) return;
    const snapshot = snapshotNow();
    if (snapshot === null) return;
    setConfirmNotice(null);
    if (shouldConfirmPost(workspaceId)) {
      setConfirmSnapshot(snapshot);
      setConfirming(true);
      return;
    }
    void post(snapshot);
  }, [canPost, workspaceId, snapshotNow, post]);

  /**
   * Zahlung buchen is ABSENT, not disabled, while what unlocks it sits beside it (D152 rule 3): a
   * Betrag still to type, a Konto still to choose, a blocker or refusal whose panel already says what
   * to change. The one exception is a re-preview in flight after a postable plan: the control holds,
   * disabled with the stale reason, rather than blinking out on every keystroke. Whether the last
   * SETTLED plan was postable is remembered for exactly that, and for nothing else.
   */
  const lastSettledPostable = useRef(false);
  if (!holding) lastSettledPostable.current = canPost;
  const showPost = posting || canPost || (holding && lastSettledPostable.current);

  /** The next step, said where the confirm would be, when it is a control in this Werkbank. */
  const nextStep: string | null =
    mode !== 'record'
      ? null
      : amountMinor <= 0
        ? // At rest the candidate pane's quiet line already asks for the Betrag; once a Gegenpartei is
          // set that line is gone, so the step is said here instead.
          asking
          ? t('payment.next.amount')
          : null
        : bankAccountId === '' && accounts.length > 0
          ? t('payment.next.account')
          : null;

  // The reason line under the actions. Beside a HELD confirm it says why it is held (a stale preview);
  // in place of an absent one it names the next step. A blocker or refusal is not repeated here: its
  // panel above is the one rendering of that sentence (A14-U3, one reason, once).
  const reasonLine: string | null = showPost ? (canPost ? null : blockedReason) : nextStep;

  /** The statement lines: one per candidate the engine has planned a settlement against. */
  const statementRows: PreviewRow[] = (preview?.rows ?? []).filter(
    (row) => row.paymentAmountMinor > 0 || row.skontoMinor > 0 || row.writeOffMinor > 0,
  );

  const [activeInputId, setActiveInputId] = useState<string | null>(null);
  const inputRefs = useRef<Map<string, HTMLInputElement | null>>(new Map());

  // --- which rows show, and which carry a Zuweisen field ------------------------------------------
  /**
   * A SUGGESTION is a row TILL has a reason to put in front of the person: an engine tier (reference,
   * exact amount and customer, amount within the threshold), a settled item the reference names (shown
   * so "already booked" is the answer rather than a hunt), or an item of the chosen Gegenpartei. A row
   * is EDITABLE (it carries its Zuweisen field) when it is a suggestion, carries an entry, or is the
   * pre-assigned match. Allocation mode keeps every row editable, as it always was.
   */
  const isSuggestion = useCallback(
    (c: Candidate) =>
      c.kind !== null || c.settled || (counterpartyId !== '' && c.contactId === counterpartyId),
    [counterpartyId],
  );
  const isEditable = useCallback(
    (c: Candidate) =>
      mode === 'allocate' || isSuggestion(c) || rows[c.targetId] !== undefined || c.targetId === preAssignedId,
    [mode, isSuggestion, rows, preAssignedId],
  );
  const restCount = candidates.filter((c) => !isEditable(c)).length;
  const visibleCandidates = showAll ? candidates : candidates.filter(isEditable);

  /** Pick a row that was not suggested: it gets its field, filled with what is left to assign. */
  const pick = useCallback(
    (c: Candidate) => {
      // The engine's remainder when there is a plan, else the Betrag itself. A FILL, not a figure on
      // screen: it lands in the field, the engine previews it, and the person can change it.
      const left = preview !== null ? preview.remainderMinor : amountMinor > 0 ? amountMinor : null;
      const fill = left === null ? c.openMinor : Math.min(c.openMinor, left);
      setRows((rowsNow) => ({ ...rowsNow, [c.targetId]: { ...EMPTY_ROW, amount: fill > 0 ? minorToInput(fill) : '' } }));
      setActiveInputId(c.targetId);
      // Focus lands in the new field once it renders, so the person can correct the fill at once.
      window.requestAnimationFrame(() => inputRefs.current.get(c.targetId)?.focus());
    },
    [preview, amountMinor],
  );

  // --- roving across the candidate amount fields (one tab stop, ArrowUp/Down between rows) --------
  const inputTargetIds = useMemo(
    () => visibleCandidates.filter((c) => !c.settled && isEditable(c)).map((c) => c.targetId),
    [visibleCandidates, isEditable],
  );
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
        aria-label={mode === 'allocate' ? t('payment.allocateCredit.label') : t('payment.record')}
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
              aria-busy={mode === 'allocate' && guthabenLoading ? true : undefined}
            />
          </label>
          <label className="pay-field">
            <span>{t('payment.date')}</span>
            <input
              className="field"
              type="date"
              value={date}
              onChange={(event) => setDate(event.target.value)}
              disabled={mode === 'allocate'}
            />
          </label>
          <div className="pay-field">
            <span>{t('payment.bankAccount')}</span>
            {/* S9. Its empty state is a banner-CTA and NOT an empty select, because an empty
                dropdown is a dead end that looks like a working control. */}
            {mode === 'allocate' ? (
              // The payment's own Konto, held: the money already landed there.
              <Select
                value={guthaben?.bankAccount.id ?? ''}
                onChange={() => undefined}
                options={
                  guthaben === null
                    ? []
                    : [{ value: guthaben.bankAccount.id, label: `${guthaben.bankAccount.number} ${guthaben.bankAccount.label}` }]
                }
                ariaLabel={t('payment.bankAccount')}
                disabled
              />
            ) : accountsLoading ? (
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
              // The default (when TILL could infer one) is the selected value, in view before anything
              // posts. Several Bankkonten and no way to tell them apart: nothing is preselected and
              // the placeholder asks.
              <Select
                value={bankAccountId}
                onChange={setChosenAccountId}
                options={accounts.map((account) => ({ value: account.id, label: `${account.number} ${account.name}` }))}
                placeholder={t('payment.bankAccountChoose')}
                ariaLabel={t('payment.bankAccount')}
                required
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
              disabled={mode === 'allocate'}
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
            {current?.reference?.kind === 'qrr' && <small className="pay-hint">{t('payment.reference.qrr')}</small>}
            {current?.reference?.kind === 'scor' && <small className="pay-hint">{t('payment.reference.scor')}</small>}
            {current?.reference?.valid === false && (
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
              {asking && current !== null && (
                // Two numbers, deliberately separate: a ranked list must never read as a filtered one.
                <span className="pay-count">
                  {t('payment.candidatesCount', {
                    n: current.referenceMatchCount,
                    total: current.openItemCount,
                  })}
                </span>
              )}
            </h3>

            {!asking ? (
              // At rest there is nothing to rank by, so no list: the money first, then the matches.
              <p className="pay-dim pay-cand-prompt">{t('payment.prompt.start')}</p>
            ) : matchesLoading && current === null ? (
              <Skeleton rows={3} />
            ) : matchesError !== null ? (
              <PaymentError error={matchesError} currency={currency} onRetry={() => void loadMatches()} />
            ) : current === null || current.candidates.length === 0 ? (
              current !== null && current.openItemCount === 0 ? (
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
              <>
                {ambiguousIds.size > 1 && (
                  // A tie is SHOWN as a tie: nothing is pre-assigned, the tied items are listed first,
                  // and the person picks.
                  <p className="pay-hint pay-cand-note" role="status">
                    {t('payment.ambiguous', { n: ambiguousIds.size })}
                  </p>
                )}
                {visibleCandidates.length === 0 ? (
                  <p className="pay-dim pay-cand-prompt">{t('payment.noSuggestion')}</p>
                ) : (
                  <table className="pay-cand-table">
                    <colgroup>
                      <col />
                      <col className="pay-col-party" />
                      <col className="pay-col-due" />
                      <col className="pay-col-open" />
                      <col className="pay-col-allocate" />
                    </colgroup>
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
                      {visibleCandidates.map((candidate) => (
                        <CandidateRow
                          key={candidate.targetId}
                          candidate={candidate}
                          editable={isEditable(candidate)}
                          settlementTerms={mode === 'record'}
                          preAssigned={candidate.targetId === preAssignedId}
                          onUndoPreAssign={() =>
                            setDeclined((now) => new Set(now).add(exactKey(candidate.targetId)))
                          }
                          onPick={() => pick(candidate)}
                          input={effectiveRows[candidate.targetId] ?? EMPTY_ROW}
                          thresholdMinor={current.writeOffThresholdMinor}
                          previewRow={preview?.rows.find((row) => row.targetId === candidate.targetId) ?? null}
                          onChange={(next) => setRows((rowsNow) => ({ ...rowsNow, [candidate.targetId]: next }))}
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
                {(restCount > 0 || showAll) && (
                  // Every other open item, behind ONE disclosure the person opens (D152 rule 5).
                  <button
                    type="button"
                    className="btn btn--ghost pay-cand-more"
                    aria-expanded={showAll}
                    onClick={() => setShowAll((on) => !on)}
                  >
                    {showAll ? t('payment.showSuggestions') : t('payment.showAll', { n: restCount })}
                  </button>
                )}
              </>
            )}
          </section>

          {/* RIGHT: the decision column (S5). Sticky: the statement, the legs and the Rest never
              scroll away, and the one write control is always in view. */}
          <aside className={`pay-wb-right${holding ? ' pay-wb-right--stale' : ''}`}>
            {guthabenError !== null && <PaymentError error={guthabenError} currency={currency} />}
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

                {/* The posting preview (the legs), only when there is a plan to show, and never in
                    allocation mode: allocating a parked credit books nothing. */}
                {preview !== null && mode !== 'allocate' && (
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

            {postError !== null && (
              <PaymentError
                error={postError}
                currency={currency}
                onRetry={() => {
                  // A retry is the same question again, under the same key: only while it still holds.
                  const snapshot = snapshotNow();
                  if (snapshot !== null && canPost) void post(snapshot);
                }}
              />
            )}

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
              ) : mode === 'record' && remainderMinor !== null && remainderMinor > 0 && counterpartyId !== '' ? (
                // Fills the field. It does not post, and it is not a second write control. P12b: a
                // Guthaben belongs to somebody, so the chip is ABSENT until the Gegenpartei is picked
                // (D152 rule 3: the Gegenpartei beside it is what unlocks it), and the engine's
                // `needs_counterparty` blocker above says so in the meantime.
                <button
                  type="button"
                  className="btn btn--ghost"
                  onClick={() => {
                    setOnAccount(minorToInput(remainderMinor));
                    setShowOnAccount(true);
                  }}
                >
                  {t('payment.onAccount.label')}
                </button>
              ) : null}

              <div className="pay-remainder-actions">
                <button type="button" className="btn btn--secondary" onClick={requestClose}>
                  {t('payment.cancel')}
                </button>
                {showPost && (
                  <button type="button" className="btn btn--primary" onClick={submit} disabled={!canPost}>
                    {t('payment.post')}
                  </button>
                )}
              </div>
            </div>

            {/* A held confirm says why, next to itself (D15/C3); an absent one names the next step. */}
            {reasonLine !== null && (
              <p className="pay-blocked-reason" role="status">
                {reasonLine}
              </p>
            )}
            {confirmNotice !== null && (
              <p className="pay-blocked-reason" role="status">
                {confirmNotice}
              </p>
            )}
          </aside>
        </div>
      </div>

      {confirming && (
        <PostConfirmDialog
          // Allocation moves the part of the credit now assigned (the engine's figure), not the credit.
          amount={formatMoney(mode === 'allocate' ? (preview?.allocatedMinor ?? 0) : amountMinor, currency)}
          verb={mode === 'allocate' ? 'allocate_payment' : 'record_payment'}
          busy={posting}
          onConfirm={(suppress) => {
            // The preference is recorded, and it changes ONLY whether this dialog appears again.
            if (suppress) setConfirmPostSuppressed(workspaceId, true);
            // Critic F3: post the snapshot only while it is STILL the question on screen and its plan
            // is settled and postable. Otherwise nothing posts: the dialog closes, every value stays,
            // and the person is told the Zuteilung moved under them.
            const snapshot = confirmSnapshot;
            if (snapshot === null || !confirmMayPost(snapshot, postQuestion, everythingAnswered, canPost)) {
              setConfirming(false);
              setConfirmSnapshot(null);
              setConfirmNotice(t('payment.confirm.changed'));
              return;
            }
            void post(snapshot);
          }}
          onCancel={() => {
            setConfirming(false);
            setConfirmSnapshot(null);
          }}
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
 * One candidate row (S4), a real table row with `scope="col"` headers above it.
 *
 * The document leads on ONE line: a long label ("R-2026-0019 Mahngebühr Stufe 2") is clipped with an
 * ellipsis and carries its full text as a title, so a row never wraps to four lines. A row NOT
 * suggested and not picked shows no field at all, only a "Zuweisen" pick (it is in view only once the
 * person opened "Alle offenen Posten"). An EDITABLE row carries its Zuweisen field, and its sub-row
 * is that row's editor: the reason word, the pre-assignment mark with its undo, "danach offen", the
 * Skonto disclosure (only once the row carries an allocation) and the Ausbuchung chip. A row that
 * matches NO tier carries no reason word at all: labelling a CHF 540.00 open against a CHF 1'081.00
 * payment "Betrag ähnlich" would make the confidence vocabulary lie (§3.2).
 */
function CandidateRow({
  candidate,
  editable,
  settlementTerms,
  preAssigned,
  onUndoPreAssign,
  onPick,
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
  editable: boolean;
  /**
   * Whether Skonto and Ausbuchung are offered. Not when allocating a parked credit: both carry a
   * ledger effect and `allocate_payment` posts nothing, so the engine refuses them there.
   */
  settlementTerms: boolean;
  preAssigned: boolean;
  onUndoPreAssign: () => void;
  onPick: () => void;
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
  const offerWriteOff = settlementTerms && offered > 0 && offered <= thresholdMinor;

  // Skonto is a settlement term OF an allocation, so its disclosure lives in the editor of a row that
  // carries one (or already holds a Skonto), never on every row at rest.
  const allocated = (parseAmountToMinor(input.amount) ?? 0) > 0;
  const offerSkonto = settlementTerms && (allocated || input.skonto !== '');

  const label = candidate.number ?? (candidate.targetKind === 'vendor_bill' ? t('payment.candidate.vendorBill') : '');

  // The editor sub-row, rendered only when it has something to say or do.
  const hasSubRow =
    candidate.settled ||
    (editable && (candidate.kind !== null || preAssigned || previewRow !== null || offerSkonto || offerWriteOff));

  return (
    <>
      <tr className={candidate.settled ? 'pay-cand-row pay-cand-row--stale' : 'pay-cand-row'}>
        <td className="pay-cand-doc pay-clip" title={label}>
          {/* A vendor bill is not a document, so it does not link into `/documents/:id`, which would
              be a dead route. Its label is the SUPPLIER's own invoice number, and A17 assigns none of
              its own, so a bill with no reference shows what it is instead of an empty link. */}
          {candidate.targetKind === 'vendor_bill' ? (
            <Link to={`/bills?bill=${candidate.targetId}`} className="pay-link">
              {label}
            </Link>
          ) : candidate.targetKind === 'dunning_fee' ? (
            // A booked Mahngebühr is not a routable document (its target is a `dunning_item` row, and
            // `/documents/:id` would be a dead route). Its label already names the invoice it rides
            // plus the escalation level, e.g. "R-2026-0001 Mahngebühr Stufe 1", so it stands as plain
            // text, exactly as A16's own fee rows carry a word-only chip rather than a link.
            <span className="pay-cand-fee">{label}</span>
          ) : (
            <Link to={`/documents/${candidate.targetId}`} className="pay-link">
              {label}
            </Link>
          )}
        </td>
        <td className="pay-cand-party pay-clip" title={candidate.contactName ?? undefined}>
          {candidate.contactName ?? ''}
        </td>
        <td className="pay-dim">
          {candidate.dueDate !== null ? formatDate(candidate.dueDate) : ''}
        </td>
        <td className="pay-num t-money">{formatMoney(candidate.openMinor, candidate.currency)}</td>
        <td className="pay-num pay-cand-amount">
          {candidate.settled ? (
            <span className="pay-dim">{t('payment.settledAlready')}</span>
          ) : editable ? (
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
          ) : (
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              aria-label={t('payment.pick', { number: label })}
              onClick={onPick}
            >
              {t('payment.allocate')}
            </button>
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
                {preAssigned && (
                  // The pre-assignment is never silent: it says so, and it is undone in one click.
                  <span className="pay-cand-preassigned">
                    <span className="pay-cand-preassigned-mark">
                      {t('payment.preAssigned')} <CheckGlyph size={14} />
                    </span>
                    <button
                      type="button"
                      className="btn btn--ghost"
                      aria-label={t('payment.preAssignedUndoLabel', { number: label })}
                      onClick={onUndoPreAssign}
                    >
                      {t('payment.preAssignedUndo')}
                    </button>
                  </span>
                )}

                {previewRow !== null && (
                  <span className="pay-dim pay-after">
                    {t('payment.afterwardsOpen')}{' '}
                    <span className="t-money">{formatMoney(previewRow.resultingOpenMinor, candidate.currency)}</span>
                  </span>
                )}

                {offerSkonto &&
                  (showSkonto || input.skonto !== '' ? (
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
                  ))}

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
