/**
 * A18, creditor payments (`/creditor-payments`): select open A17 bills, generate a pain.001.001.09
 * credit-transfer file, and mark them paid once the bank confirms.
 *
 * The five states: loading (skeleton rows on the payable list AND the batch bar), empty ("Nichts zu
 * bezahlen", never a bare "No data", with a link back to Bills), error (banner plus retry), success
 * (the validity confirmation and the download, or the paid confirmation), permission-denied (the
 * padlock; the two write actions are pre-disabled with a tooltip, never shown then rejected).
 *
 * ONE BATCH AT A TIME, matching the spec's own GUI narrative (§6): a batch bar, not a batch history
 * browser. `list_payment_batches` exists (for the saved-view seam, §6b) but this surface does not
 * render it yet; that is a follow-up, not a defect the DoD claims covered.
 *
 * D118 modernisation: the payable list is the shared `DataTable` (frame, sticky header, density and
 * `.t-num` money, `rowClassName` for a blocked row), the header is `SurfaceHeader`, and the two
 * inline confirms (the F8 IBAN capture and the mark-paid question) are the shared `Modal`. The
 * mark-paid Modal is an alertdialog: money leaving the workspace is a consequential question a stray
 * scrim click must not answer. Figures still render VERBATIM from the read verbs, no re-summation.
 *
 * D152 rule 5 (a list never opens itself), on the money path: NOTHING is ticked on load. The
 * payment file holds exactly the bills the person ticked, one by one or through the explicit
 * "Fällige auswählen" act on the suggestion line, which only NAMES the bills due by the execution
 * date (the F-03 / J3.4 pre-selection used to tick them, so a person could generate a file holding a
 * payment they never chose). A `?focus=<billId>` deep link marks its row current without ticking it.
 * A workspace switch remounts the run view (keyed by the workspace), so no tick, batch, dialog or
 * idempotency key survives into the next workspace, and a write still in flight completes where it
 * was made and speaks nowhere.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import { useClient } from '../../lib/client-context';
import { isErr, type Err } from '../../lib/client';
import { useWorkspaceId } from '../../app/workspace';
import { useT, useTRich, formatMoney, formatDate } from '../../i18n';
import { SurfaceHelp } from '../../components/SurfaceHelp';
import { SurfaceHeader } from '../../components/SurfaceHeader';
import { DataTable, type DataTableColumn, type DataTableSelection } from '../../components/DataTable';
import { Modal } from '../../components/Modal';
import { Select } from '../../components/Select';
import { Provenance } from '../../components/Provenance';
import { Status, type StatusKind } from '../../components/Status';
import { EmptyState, ErrorBanner, NoWorkspaceState, PermissionDenied, Skeleton } from '../../components/states';
import { Tabs } from '../../components/Tabs';
import { useCan, CAP } from '../../lib/capabilities';
import {
  asArray,
  debtorEligible,
  selectedTotalMinor,
  dueBillIds,
  payableNow,
  defaultDebitAccountId,
  xmlDownloadHref,
  type PayableItem,
  type BatchView,
  type DebtorAccountOption,
} from './model';
import { PaymentPlanning } from './PaymentPlanning';
import './CreditorPayments.css';

// The alertdialog role travels to the shared Modal as a prop, never as a literal attribute on the
// component, so the modal-role guard reads a bare `<Modal>` and the role lands on the div Modal owns.
const ALERT_DIALOG = 'alertdialog' as const;

/** The generate refusals that mean the batch this act created is dead (discarded elsewhere, or gone). */
const STALE_BATCH: ReadonlySet<string> = new Set(['batch_discarded', 'not_found']);

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function newKey(): string {
  return crypto.randomUUID();
}

/** The Status kind for a batch (K-22): the glyph carries the state, the word is translated. */
function batchStatusKind(status: BatchView['status']): StatusKind {
  switch (status) {
    case 'paid':
      return 'success';
    case 'generated':
      return 'pending';
    case 'discarded':
      return 'inactive';
    default:
      return 'neutral';
  }
}

/** A row that cannot join a batch: no creditor profile, an unsupported currency, or already batched. */
function isBlocked(item: PayableItem): boolean {
  return !item.batchable || !item.hasCreditorProfile || item.alreadyBatchedInto !== null;
}

/**
 * The route element. Keyed by the workspace, so a switch starts the run view from nothing: list
 * surfaces are not remounted by the shell, and a tick, a generated batch or an open confirm from the
 * workspace just left must never be acted on under the new one.
 */
export function CreditorPayments() {
  const workspaceId = useWorkspaceId();
  return <CreditorPaymentsView key={workspaceId ?? ''} />;
}

function CreditorPaymentsView() {
  const t = useT();
  const tRich = useTRich();
  const client = useClient();
  const workspaceId = useWorkspaceId();

  /**
   * THE PADLOCK (A24, F5 idiom). `create_payment_batch`/`generate_pain001` declare `pay` alone at
   * the engine; `mark_batch_paid` declares `['pay','post']` (it reaches `postEntry` via A14).
   * Affordances are absent without the capability; fail-open while `whoami` is unresolved, because
   * the engine decides. Both hooks unconditionally, combined after (the `Payments.tsx` shape).
   */
  const holdsPay = useCan(CAP.pay);
  const holdsPost = useCan(CAP.post);
  const holdsMasterData = useCan(CAP.manageMasterData);
  const canGenerate = holdsPay;
  const canMarkPaid = holdsPay && holdsPost;
  const canSetProfile = holdsMasterData;

  // A40: which tab is showing. The payment run is the default; planning is the second view.
  const [view, setView] = useState<'run' | 'plan'>('run');
  const [items, setItems] = useState<PayableItem[]>([]);
  const [accounts, setAccounts] = useState<DebtorAccountOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Err | null>(null);
  const [denied, setDenied] = useState(false);

  // The bills the person ticked, and only those: nothing is ticked for them (D152 rule 5).
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bankAccountId, setBankAccountId] = useState('');
  const [executionDate, setExecutionDate] = useState(todayIso());
  const accountTouched = useRef(false);
  // A deep link (`?focus=<billId>`) marks its row current; it never ticks it.
  const [params] = useSearchParams();
  const focusId = params.get('focus');
  // The books' own currency, off `list_payable` (A18 answers it beside the items).
  const [baseCurrency, setBaseCurrency] = useState('CHF');

  const [batch, setBatch] = useState<BatchView | null>(null);
  const [download, setDownload] = useState<{ filename: string; base64: string } | null>(null);
  // What happens to the generated file, as `generate_pain001` says it (A36: the EBICS channel is
  // download only, so an EBICS-routed account answers `upload_in_ebanking`; otherwise `no_channel`).
  const [transmitReason, setTransmitReason] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState<Err | null>(null);
  // Critic F2: the "run was discarded" wording belongs to a GENERATE refusal of the act's batch only;
  // a create refused `not_found` (a bill) keeps the shared sentence.
  const [genErrorStale, setGenErrorStale] = useState(false);

  const [markOpen, setMarkOpen] = useState(false);
  const [valueDate, setValueDate] = useState(todayIso());
  const [confirmChecked, setConfirmChecked] = useState(false);
  const [marking, setMarking] = useState(false);
  const [markError, setMarkError] = useState<Err | null>(null);

  // F8: capturing a vendor's IBAN (set_creditor_bank_profile) so the payable flow completes from an
  // empty workspace. Without this surface every row on a fresh workspace is a dead end.
  const [profileFor, setProfileFor] = useState<PayableItem | null>(null);
  const [profileIban, setProfileIban] = useState('');
  const [savingProfile, setSavingProfile] = useState(false);
  const [profileError, setProfileError] = useState<Err | null>(null);

  // The create act in progress (see `handleGenerate`): its question and its key, null when none is.
  const createAct = useRef<{ asked: string; key: string } | null>(null);

  // Every payable read is numbered; only the latest may answer, so a read a retry or a re-read
  // overtook never paints over the newer one.
  const loadSeq = useRef(0);
  const load = useCallback(async () => {
    if (workspaceId === null) {
      setLoading(false);
      return;
    }
    const mine = ++loadSeq.current;
    setLoading(true);
    setError(null);
    setDenied(false);

    const [payableRes, accountsRes] = await Promise.all([
      client.call('list_payable', { workspaceId }),
      client.call('list_bank_accounts', { workspaceId }),
    ]);
    if (mine !== loadSeq.current) return;

    if (isErr(payableRes.body)) {
      if (payableRes.body.error === 'permission_denied' || payableRes.status === 403) setDenied(true);
      else setError(payableRes.body);
      setLoading(false);
      return;
    }
    const loadedItems = asArray<PayableItem>(payableRes.body.items);
    setItems(loadedItems);
    // A re-read only ever NARROWS the person's ticks: a bill that left the list or can no longer join
    // a batch drops out, so the run never carries an id the person cannot see. Nothing is added.
    // ONE EXCEPTION (critic F1): while a create act is outstanding (its answer may have been lost), a
    // bill now "already batched" may sit in THIS act's own landed batch; the same-key retry replays
    // that batch and produces its file, so the tick stays (and stays untickable, see `selection`).
    const actOutstanding = createAct.current !== null;
    setSelected((prev) => {
      const byId = new Map(loadedItems.map((i) => [i.billId, i]));
      const kept = [...prev].filter((id) => {
        const item = byId.get(id);
        if (item === undefined) return false;
        if (payableNow(item)) return true;
        return actOutstanding && item.alreadyBatchedInto !== null && item.batchable && item.hasCreditorProfile;
      });
      return kept.length === prev.size ? prev : new Set(kept);
    });
    const base = typeof payableRes.body.baseCurrency === 'string' ? payableRes.body.baseCurrency : 'CHF';
    setBaseCurrency(base);

    if (!isErr(accountsRes.body)) {
      const opts = asArray<DebtorAccountOption>(accountsRes.body.bankAccounts);
      setAccounts(opts);
    }
    setLoading(false);
  }, [client, workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  const openProfile = useCallback((item: PayableItem) => {
    setProfileFor(item);
    setProfileIban('');
    setProfileError(null);
  }, []);

  const saveProfile = useCallback(async () => {
    if (workspaceId === null || profileFor === null || profileIban.trim() === '') return;
    setSavingProfile(true);
    setProfileError(null);
    const response = await client.call('set_creditor_bank_profile', {
      workspaceId,
      vendorId: profileFor.vendorId,
      iban: profileIban.trim(),
      idempotencyKey: newKey(),
    });
    if (isErr(response.body)) {
      setProfileError(response.body);
      setSavingProfile(false);
      return;
    }
    setSavingProfile(false);
    setProfileFor(null);
    void load();
  }, [client, workspaceId, profileFor, profileIban, load]);

  const toggle = useCallback((billId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(billId)) next.delete(billId);
      else next.add(billId);
      return next;
    });
  }, []);

  const totalMinor = useMemo(() => selectedTotalMinor(items, selected), [items, selected]);
  const selectedCurrency = useMemo(() => {
    const first = items.find((i) => selected.has(i.billId));
    return first?.currency ?? baseCurrency;
  }, [items, selected, baseCurrency]);

  // F-03 (J3.4), now a SUGGESTION: the bills due by the execution date, in one currency, named on a
  // line with their count and sum. Nothing is ticked until the person takes it ("Fällige auswählen").
  const suggestion = useMemo(
    () => dueBillIds(items, executionDate, baseCurrency),
    [items, executionDate, baseCurrency],
  );
  const suggestionCurrency = useMemo(
    () => items.find((i) => i.billId === suggestion[0])?.currency ?? baseCurrency,
    [items, suggestion, baseCurrency],
  );
  const suggestionTotalMinor = useMemo(() => selectedTotalMinor(items, new Set(suggestion)), [items, suggestion]);
  const takeSuggestion = useCallback(() => setSelected(new Set(suggestion)), [suggestion]);

  // A deep-linked row is scrolled into view once the list is on screen (current, never ticked).
  useEffect(() => {
    if (loading || focusId === null) return;
    document.querySelector('.pay-cp tr[aria-current="true"]')?.scrollIntoView?.({ block: 'nearest' });
  }, [loading, focusId]);

  // F-03 (J3.4): the debit account defaults to the bank account in the bills' currency (never the
  // EUR account for CHF bills), and follows the selection's currency until the person picks one.
  useEffect(() => {
    if (accountTouched.current || accounts.length === 0) return;
    setBankAccountId(defaultDebitAccountId(accounts, selectedCurrency));
  }, [accounts, selectedCurrency]);

  /**
   * ONE create key per ACT (the Wave B-2 lesson). An act is "make the run for exactly this question"
   * (account, ticked ids, date). Its key is minted when the person first clicks, reused only to
   * retry that same act (a create whose answer was lost replays instead of writing twice), and
   * retired when the act completes or the question changes. A question edited away and back is a
   * new act, as with the shared `useIdempotencyKey`.
   *
   * THE STALE BATCH. A create that landed is replayed under its key for ever, so if its batch was
   * discarded (or is gone) before the generate succeeded, a same-key retry would hand back that dead
   * batch id and the person would be stuck on `batch_discarded`. When the generate refuses the batch
   * that way, the act re-mints its key and creates a fresh run once, in the same click.
   */
  const createQuestion = JSON.stringify({ bankAccountId, itemIds: [...selected].sort(), executionDate });
  if (createAct.current !== null && createAct.current.asked !== createQuestion) createAct.current = null;

  const handleGenerate = useCallback(async () => {
    if (workspaceId === null || selected.size === 0 || bankAccountId === '') return;
    setGenerating(true);
    setGenError(null);
    setGenErrorStale(false);
    setDownload(null);

    // At most one fresh create per click: the second pass runs only after a stale batch.
    for (let pass = 0; pass < 2; pass += 1) {
      if (createAct.current === null) createAct.current = { asked: createQuestion, key: newKey() };
      const created = await client.call('create_payment_batch', {
        workspaceId,
        bankAccountId,
        itemIds: [...selected],
        executionDate,
        idempotencyKey: createAct.current.key,
      });
      if (isErr(created.body)) {
        setGenError(created.body);
        setGenerating(false);
        return;
      }
      const batchId = created.body.batchId as string;

      const generated = await client.call('generate_pain001', {
        workspaceId,
        batchId,
        idempotencyKey: newKey(),
      });
      if (isErr(generated.body)) {
        const stale = STALE_BATCH.has(generated.body.error);
        if (stale) {
          // The batch this act created is dead: the act's next create must write, not replay it.
          createAct.current = { asked: createQuestion, key: newKey() };
          if (pass === 0) continue;
        }
        setGenError(generated.body);
        setGenErrorStale(stale);
        setGenerating(false);
        return;
      }
      // The act is complete: an identical question asked later is a new act with a new key.
      createAct.current = null;
      setBatch(generated.body.batch as BatchView);
      setDownload({
        filename: generated.body.filename as string,
        base64: generated.body.xmlBase64 as string,
      });
      setTransmitReason(generated.body.reason as string);
      setGenerating(false);
      return;
    }
  }, [client, workspaceId, selected, bankAccountId, executionDate, createQuestion]);

  const openMarkPaid = useCallback(() => {
    setMarkOpen(true);
    setMarkError(null);
    setConfirmChecked(false);
    setValueDate(executionDate);
  }, [executionDate]);

  const confirmMarkPaid = useCallback(async () => {
    if (workspaceId === null || batch === null || !confirmChecked) return;
    setMarking(true);
    setMarkError(null);
    const response = await client.call('mark_batch_paid', {
      workspaceId,
      batchId: batch.id,
      confirmation: true,
      valueDate,
      idempotencyKey: newKey(),
    });
    if (isErr(response.body)) {
      setMarkError(response.body);
      setMarking(false);
      return;
    }
    setBatch(response.body.batch as BatchView);
    setMarkOpen(false);
    setMarking(false);
    setSelected(new Set());
    setDownload(null);
    void load();
  }, [client, workspaceId, batch, valueDate, confirmChecked, load]);

  // The payable list as the shared DataTable. The leading column is the table's own selection column
  // (K-14: a real checkbox in a 32px `.check-cell`, named per row, the selected row wearing the
  // selection pill), and a blocked row (no creditor profile, unsupported currency, or already batched)
  // dims via `rowClassName` and cannot be ticked. No footer total: `list_payable` returns no
  // same-currency batch total and the list may be mixed-currency, so a column sum would be a figure the
  // engine never made.
  const selection: DataTableSelection<PayableItem> = useMemo(
    () => ({
      isSelected: (item) => selected.has(item.billId),
      onToggle: (item) => toggle(item.billId),
      label: (item) => t('pay.selectOne', { vendor: item.vendorName ?? '' }),
      // A blocked row cannot be ticked, but a tick it still carries can always be taken back.
      isDisabled: (item) => isBlocked(item) && !selected.has(item.billId),
      allLabel: t('pay.selectBills'),
    }),
    [t, selected, toggle],
  );

  const columns: DataTableColumn<PayableItem>[] = useMemo(
    () => [
      {
        key: 'vendor',
        header: t('pay.column.vendor'),
        render: (item) => item.vendorName ?? '',
      },
      {
        key: 'due',
        header: t('pay.column.due'),
        render: (item) => (item.dueDate !== null ? formatDate(item.dueDate) : ''),
      },
      {
        key: 'amount',
        header: t('pay.column.amount'),
        numeric: true,
        render: (item) => formatMoney(item.amountMinor, item.currency),
      },
      {
        key: 'reference',
        header: t('pay.column.reference'),
        // The blocked reason in dim ink, or the one fix-it that unblocks the row (F8): capturing the
        // vendor's IBAN is the row's only verb, so it stays in the cell that names what is missing.
        render: (item) =>
          item.alreadyBatchedInto !== null ? (
            <span className="pay-cp-hint">{t('pay.status.alreadyBatched')}</span>
          ) : !item.hasCreditorProfile ? (
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              disabled={!canSetProfile}
              aria-describedby={canSetProfile ? undefined : 'pay-profile-denied'}
              onClick={() => openProfile(item)}
            >
              {t('pay.addCreditorIban')}
            </button>
          ) : !item.batchable ? (
            <span className="pay-cp-hint">{t('pay.unsupportedCurrency')}</span>
          ) : (
            t(`pay.referenceKind.${item.referenceKind}`)
          ),
      },
    ],
    [t, canSetProfile, openProfile],
  );

  if (workspaceId === null) return <NoWorkspaceState />;
  if (denied) return <PermissionDenied body={t('pay.error.permission_denied')} />;

  const eligibleAccounts = accounts.filter(debtorEligible);
  const batchDone = batch !== null && batch.status !== 'draft';

  return (
    <section className="pay-cp" aria-labelledby="pay-cp-title">
      <SurfaceHeader
        title={t('pay.title')}
        titleId="pay-cp-title"
        help={<SurfaceHelp surface="CreditorPayments" />}
      />

      {/* A40: the second tab plans WHEN to pay; the first stays today's payment run, unchanged. */}
      <Tabs
        tabs={[
          { id: 'run', label: t('pay.tabs.run') },
          { id: 'plan', label: t('pay.tabs.plan') },
        ]}
        activeId={view}
        onChange={(id) => setView(id === 'plan' ? 'plan' : 'run')}
        label={t('pay.tabs.label')}
      >
        {view === 'plan' ? (
          <PaymentPlanning />
        ) : (
          <>
          {error !== null && <ErrorBanner error={error} onRetry={() => void load()} />}

          {loading ? (
            <div className="pay-cp-body">
              <div className="pay-cp-bar-skeleton">
                <Skeleton rows={1} height={40} />
              </div>
              <Skeleton rows={4} />
            </div>
          ) : items.length === 0 && error === null ? (
            <EmptyState
              title={t('pay.empty.title')}
              hint={t('pay.empty.hint')}
              action={{ label: t('pay.empty.toBills'), to: '/bills' }}
            />
          ) : (
            <div className="pay-cp-body">
              {batch === null && (
                <>
                  {/* The suggestion line: it names the due bills and offers ONE explicit act to tick
                      them. Shown only while nothing is ticked; once the person is choosing, it goes. */}
                  {selected.size === 0 && suggestion.length > 0 && (
                    <p className="pay-cp-suggest">
                      <span>
                        {t(suggestion.length === 1 ? 'pay.suggest.one' : 'pay.suggest.other', {
                          n: suggestion.length,
                          date: formatDate(executionDate),
                          total: formatMoney(suggestionTotalMinor, suggestionCurrency),
                        })}
                      </span>
                      <button type="button" className="btn btn--ghost btn--sm" onClick={takeSuggestion}>
                        {t('pay.suggest.take')}
                      </button>
                    </p>
                  )}
                  <DataTable
                    columns={columns}
                    rows={items}
                    rowKey={(item) => item.billId}
                    caption={t('pay.title')}
                    selection={selection}
                    isRowCurrent={(item) => item.billId === focusId}
                    rowClassName={(item) => (isBlocked(item) ? 'pay-cp-row--blocked' : undefined)}
                  />
                  {/* f2: the per-row "Add creditor IBAN" buttons are disabled without the master-data
                      capability; the reason is stated once here as a visible note they reference by
                      aria-describedby, rather than a silent title repeated on every row. */}
                  {!canSetProfile && (
                    <p id="pay-profile-denied" className="pay-cp-denied-note" role="note">
                      {t('pay.needsMasterData')}
                    </p>
                  )}

                  <div className="pay-cp-batchbar">
                    <div className="pay-cp-field">
                      <span>{t('pay.debtorAccount')}</span>
                      {/* Critic F4: no account at all, or none in the batch's currency (no silent
                          any-currency default); either way the act waits for a deliberate pick. */}
                      <Select
                        value={bankAccountId}
                        onChange={(value) => {
                          accountTouched.current = true;
                          setBankAccountId(value);
                        }}
                        disabled={eligibleAccounts.length === 0}
                        options={[
                          ...(eligibleAccounts.length === 0
                            ? [{ value: '', label: t('pay.needsBankAccount') }]
                            : bankAccountId === ''
                              ? [{ value: '', label: t('pay.pickAccountInCurrency', { currency: selectedCurrency }) }]
                              : []),
                          ...eligibleAccounts.map((a) => ({ value: a.id, label: a.name })),
                        ]}
                        ariaLabel={t('pay.debtorAccount')}
                      />
                    </div>
                    <label className="pay-cp-field">
                      <span>{t('pay.executionDate')}</span>
                      <input
                        type="date"
                        className="field"
                        value={executionDate}
                        onChange={(e) => setExecutionDate(e.target.value)}
                      />
                    </label>
                    <div className="pay-cp-total">
                      <span>{t('pay.selectedTotal')}</span>
                      <strong className="t-money">{formatMoney(totalMinor, selectedCurrency)}</strong>
                    </div>
                    <button
                      type="button"
                      className="btn btn--primary"
                      disabled={!canGenerate || generating || selected.size === 0 || bankAccountId === ''}
                      aria-describedby={canGenerate ? undefined : 'pay-generate-denied'}
                      onClick={() => void handleGenerate()}
                    >
                      {generating ? t('pay.generating') : t('pay.generate')}
                    </button>
                  </div>
                  {/* f2: a disabled button's title is neither shown on hover nor announced to AT, so the
                      denied reason is a VISIBLE note the button points at via aria-describedby. */}
                  {!canGenerate && (
                    <p id="pay-generate-denied" className="pay-cp-denied-note" role="note">
                      {t('pay.needsCapability')}
                    </p>
                  )}
                  {genError !== null && (
                    <ErrorBanner
                      error={genError}
                      message={
                        genErrorStale
                          ? t('pay.error.batchGone')
                          : genError.error === 'already_batched'
                            ? t('pay.error.alreadyBatched')
                            : undefined
                      }
                    />
                  )}
                </>
              )}

              {batch !== null && (
                <div className="pay-cp-result panel">
                  <div className="pay-cp-result-head">
                    {/* The validity and the batch state are the shared Status word (K-22): a glyph from the
                        set plus the word, never a dingbat, never colour alone. */}
                    <Status kind="success" label={t('pay.valid')} />
                    <Status kind={batchStatusKind(batch.status)} label={t(`pay.status.${batch.status}`)} />
                  </div>
                  <p className="pay-cp-summary">
                    {tRich('pay.summary', {
                      n: batch.items.length,
                      total: (
                        <span className="t-money">
                          {formatMoney(batch.ctrlSumMinor ?? totalMinor, selectedCurrency)}
                        </span>
                      ),
                      date: formatDate(batch.executionDate),
                    })}
                  </p>
                  {/* C3: who created this batch and when, from the batch's own header (`created_by`/
                      `created_at`). Rendered only when the read model carries a timestamp, so nothing is
                      fabricated for a legacy row. */}
                  {batch.createdAt != null && (
                    <Provenance origin="human" actor={batch.createdBy} timestamp={batch.createdAt} />
                  )}

                  {download !== null && batch.status !== 'paid' && (
                    <a
                      className="btn btn--secondary"
                      href={xmlDownloadHref(download.base64)}
                      download={download.filename}
                    >
                      {t('pay.download')}
                    </a>
                  )}

                  {/* A36 (D-A36.11): TILL uploads no payment file. The file is downloaded here and the owner
                      uploads and releases it in the bank's own eBanking; for an account routed over EBICS
                      the note says so, because that channel fetches statements only. There is no transmit
                      control on this surface at all. */}
                  <p className="pay-cp-transmit-note">
                    {transmitReason === 'upload_in_ebanking' ? t('pay.transmitNote.ebanking') : t('pay.transmitNote.manual')}
                  </p>

                  {batchDone && batch.status === 'generated' && (
                    <>
                      <button
                        type="button"
                        className="btn btn--primary"
                        disabled={!canMarkPaid}
                        aria-describedby={canMarkPaid ? undefined : 'pay-markpaid-denied'}
                        onClick={openMarkPaid}
                      >
                        {t('pay.markPaidAction')}
                      </button>
                      {!canMarkPaid && (
                        <p id="pay-markpaid-denied" className="pay-cp-denied-note" role="note">
                          {t('pay.needsCapability')}
                        </p>
                      )}
                    </>
                  )}

                  {batch.status === 'paid' && (
                    <p className="pay-cp-paid">
                      {t('pay.paidOn', { date: formatDate(valueDate) })}
                    </p>
                  )}

                  {batch.status === 'paid' && (
                    <button
                      type="button"
                      className="btn btn--ghost pay-cp-newbatch"
                      onClick={() => {
                        setBatch(null);
                        setDownload(null);
                      }}
                    >
                      {t('pay.newBatch')}
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
          </>
        )}
      </Tabs>

      {/*
        The mark-paid question moves money into the ledger (mark_batch_paid reaches postEntry via
        A14), so it is an alertdialog: a stray scrim click must not answer it, and the write still
        waits on the explicit checkbox, never the button alone. No ConsequenceLine here: mark_batch_paid
        carries no dial capability in the generated manifest, so the shared sentence would be empty.
      */}
      <Modal
        open={markOpen}
        onClose={() => setMarkOpen(false)}
        role={ALERT_DIALOG}
        title={t('pay.markPaid.confirmTitle')}
        closeLabel={t('pay.markPaid.close')}
        footer={
          <>
            <button type="button" className="btn btn--ghost" onClick={() => setMarkOpen(false)}>
              {t('pay.cancel')}
            </button>
            {/* The tinted commit (K-08, D137): this is the money write, it books the payment. */}
            <button
              type="button"
              className="btn btn--accent"
              data-money-commit="mark_batch_paid"
              disabled={!confirmChecked || marking}
              onClick={() => void confirmMarkPaid()}
            >
              {marking ? t('pay.markPaid.confirming') : t('pay.markPaid.confirm')}
            </button>
          </>
        }
      >
        <label className="pay-cp-field">
          <span>{t('pay.valueDate')}</span>
          <input
            type="date"
            className="field"
            value={valueDate}
            onChange={(e) => setValueDate(e.target.value)}
          />
        </label>
        <label className="pay-cp-checkline">
          <input
            type="checkbox"
            checked={confirmChecked}
            onChange={(e) => setConfirmChecked(e.target.checked)}
          />
          <span>{t('pay.markPaid.confirmLabel')}</span>
        </label>
        {markError !== null && <ErrorBanner error={markError} />}
      </Modal>

      {/* F8: capturing a vendor's IBAN so a fresh-workspace row is not a dead end. A plain dialog. */}
      <Modal
        open={profileFor !== null}
        onClose={() => setProfileFor(null)}
        title={t('pay.profile.title', { vendor: profileFor?.vendorName ?? '' })}
        closeLabel={t('pay.profile.close')}
        footer={
          <>
            <button type="button" className="btn btn--ghost" onClick={() => setProfileFor(null)}>
              {t('pay.cancel')}
            </button>
            <button
              type="button"
              className="btn btn--primary"
              disabled={savingProfile || profileIban.trim() === ''}
              onClick={() => void saveProfile()}
            >
              {savingProfile ? t('pay.profile.saving') : t('pay.profile.save')}
            </button>
          </>
        }
      >
        <label className="pay-cp-field">
          <span>{t('pay.profile.ibanLabel')}</span>
          <input
            type="text"
            className="field"
            inputMode="text"
            autoComplete="off"
            spellCheck={false}
            value={profileIban}
            placeholder="CH.. / QR-IBAN"
            onChange={(e) => setProfileIban(e.target.value)}
          />
        </label>
        {profileError !== null && <ErrorBanner error={profileError} />}
      </Modal>

      {view === 'run' && items.length > 0 && (
        <p className="pay-cp-toBills">
          <Link className="link-inline" to="/bills">{t('pay.toBillsLink')}</Link>
        </p>
      )}
    </section>
  );
}
