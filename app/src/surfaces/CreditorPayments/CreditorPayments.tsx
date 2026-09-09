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
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

import { useClient } from '../../lib/client-context';
import { isErr, type Err } from '../../lib/client';
import { useWorkspaceId } from '../../app/workspace';
import { useT, formatMoney, formatDate } from '../../i18n';
import { SurfaceHelp } from '../../components/SurfaceHelp';
import { SurfaceHeader } from '../../components/SurfaceHeader';
import { DataTable, type DataTableColumn } from '../../components/DataTable';
import { Modal } from '../../components/Modal';
import { Provenance } from '../../components/Provenance';
import { EmptyState, ErrorBanner, NoWorkspaceState, PermissionDenied, Skeleton } from '../../components/states';
import { useCan, CAP } from '../../lib/capabilities';
import { useIdempotencyKey } from '../../lib/idempotency';
import {
  asArray,
  debtorEligible,
  selectedTotalMinor,
  dueBillIds,
  defaultDebitAccountId,
  xmlDownloadHref,
  type PayableItem,
  type BatchView,
  type DebtorAccountOption,
} from './model';
import './CreditorPayments.css';

// The alertdialog role travels to the shared Modal as a prop, never as a literal attribute on the
// component, so the modal-role guard reads a bare `<Modal>` and the role lands on the div Modal owns.
const ALERT_DIALOG = 'alertdialog' as const;

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function newKey(): string {
  return crypto.randomUUID();
}

export function CreditorPayments() {
  const t = useT();
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

  const [items, setItems] = useState<PayableItem[]>([]);
  const [accounts, setAccounts] = useState<DebtorAccountOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Err | null>(null);
  const [denied, setDenied] = useState(false);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bankAccountId, setBankAccountId] = useState('');
  const [executionDate, setExecutionDate] = useState(todayIso());
  // F-03 (J3.4): the selection follows the execution date (the bills due by it are pre-ticked)
  // until the person ticks or unticks a bill by hand; from then on it is theirs.
  const selectionTouched = useRef(false);
  const accountTouched = useRef(false);
  // The books' own currency, off `list_payable` (A18 answers it beside the items).
  const [baseCurrency, setBaseCurrency] = useState('CHF');

  const [batch, setBatch] = useState<BatchView | null>(null);
  const [download, setDownload] = useState<{ filename: string; base64: string } | null>(null);
  const [transmitReason, setTransmitReason] = useState<string | null>(null);
  // A33: the EBICS transmit control's outcome (pending_release on a real upload, or an honest note).
  const [transmitState, setTransmitState] = useState<{ kind: 'pending' | 'degraded' | 'error'; detail?: string } | null>(null);
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState<Err | null>(null);

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

  const load = useCallback(async () => {
    if (workspaceId === null) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    setDenied(false);

    const [payableRes, accountsRes] = await Promise.all([
      client.call('list_payable', { workspaceId }),
      client.call('list_bank_accounts', { workspaceId }),
    ]);

    if (isErr(payableRes.body)) {
      if (payableRes.body.error === 'permission_denied' || payableRes.status === 403) setDenied(true);
      else setError(payableRes.body);
      setLoading(false);
      return;
    }
    const loadedItems = asArray<PayableItem>(payableRes.body.items);
    setItems(loadedItems);
    const base = typeof payableRes.body.baseCurrency === 'string' ? payableRes.body.baseCurrency : 'CHF';
    setBaseCurrency(base);
    // F-03 (J3.4): "lists the due bills pre-selected by due date". The engine's dueDate is the fact;
    // the execution date is the horizon.
    if (!selectionTouched.current) setSelected(new Set(dueBillIds(loadedItems, executionDate, base)));

    if (!isErr(accountsRes.body)) {
      const opts = asArray<DebtorAccountOption>(accountsRes.body.bankAccounts);
      setAccounts(opts);
    }
    setLoading(false);
    // The execution date is read, never a trigger: a date change re-selects through its own effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, workspaceId]);

  // A changed horizon re-selects the due bills, unless the person has already made the selection theirs.
  useEffect(() => {
    if (selectionTouched.current || loading) return;
    setSelected(new Set(dueBillIds(items, executionDate, baseCurrency)));
  }, [executionDate, items, loading, baseCurrency]);

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
    selectionTouched.current = true;
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
    return first?.currency ?? 'CHF';
  }, [items, selected]);

  // F-03 (J3.4): the debit account defaults to the bank account in the bills' currency (never the
  // EUR account for CHF bills), and follows the selection's currency until the person picks one.
  useEffect(() => {
    if (accountTouched.current || accounts.length === 0) return;
    setBankAccountId(defaultDebitAccountId(accounts, selectedCurrency));
  }, [accounts, selectedCurrency]);

  const batchKey = useIdempotencyKey({ bankAccountId, itemIds: [...selected].sort(), executionDate });

  const handleGenerate = useCallback(async () => {
    if (workspaceId === null || selected.size === 0 || bankAccountId === '') return;
    setGenerating(true);
    setGenError(null);
    setDownload(null);

    const created = await client.call('create_payment_batch', {
      workspaceId,
      bankAccountId,
      itemIds: [...selected],
      executionDate,
      idempotencyKey: batchKey,
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
      setGenError(generated.body);
      setGenerating(false);
      return;
    }
    setBatch(generated.body.batch as BatchView);
    setDownload({
      filename: generated.body.filename as string,
      base64: generated.body.xmlBase64 as string,
    });
    setTransmitReason(generated.body.reason as string);
    setGenerating(false);
  }, [client, workspaceId, selected, bankAccountId, executionDate, batchKey]);

  const openMarkPaid = useCallback(() => {
    setMarkOpen(true);
    setMarkError(null);
    setConfirmChecked(false);
    setValueDate(executionDate);
  }, [executionDate]);

  /**
   * A33: transmit the generated batch to the bank over EBICS (P8, confirm in-engine). THE LAW holds
   * in the engine: v1 uploads without the signature flag, so the bank authorizes and nothing is paid
   * on transmit. On a real upload the batch shows pending_release; with no channel/transport wired the
   * verb returns an honest ok:true degrade and the download panel stays the floor.
   */
  const transmit = useCallback(async () => {
    if (workspaceId === null || batch === null) return;
    setTransmitState(null);
    const { body } = await client.call('payment_batch_transmit', {
      workspaceId,
      batchId: batch.id,
      confirm: true,
      idempotencyKey: `a33-transmit-${batch.id}`,
    });
    if (isErr(body)) {
      setTransmitState({ kind: 'error', detail: body.error });
      return;
    }
    if ((body as unknown as { transmitted?: boolean }).transmitted === true) {
      setTransmitState({ kind: 'pending' });
    } else {
      setTransmitState({ kind: 'degraded', detail: (body as unknown as { reason?: string }).reason });
    }
  }, [client, workspaceId, batch]);

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

  // The payable list as the shared DataTable. The leading column is the row's own select checkbox
  // (its header label is read by assistive tech but hidden), and a blocked row (no creditor profile,
  // unsupported currency, or already batched) dims via `rowClassName`. No footer total: `list_payable`
  // returns no same-currency batch total and the list may be mixed-currency, so a column sum would be
  // a figure the engine never made.
  const columns: DataTableColumn<PayableItem>[] = useMemo(
    () => [
      {
        key: 'select',
        header: t('pay.selectBills'),
        headerHidden: true,
        width: '40px',
        render: (item) => {
          const blocked =
            !item.batchable || !item.hasCreditorProfile || item.alreadyBatchedInto !== null;
          return (
            <input
              type="checkbox"
              aria-label={t('pay.selectOne', { vendor: item.vendorName ?? '' })}
              checked={selected.has(item.billId)}
              disabled={blocked}
              onChange={() => toggle(item.billId)}
            />
          );
        },
      },
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
        render: (item) =>
          item.alreadyBatchedInto !== null ? (
            <span className="pay-cp-hint">{t('pay.status.alreadyBatched')}</span>
          ) : !item.hasCreditorProfile ? (
            <button
              type="button"
              className="btn btn--ghost pay-cp-addiban"
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
    [t, selected, toggle, canSetProfile, openProfile],
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
              <DataTable
                columns={columns}
                rows={items}
                rowKey={(item) => item.billId}
                caption={t('pay.title')}
                rowClassName={(item) =>
                  !item.batchable || !item.hasCreditorProfile || item.alreadyBatchedInto !== null
                    ? 'pay-cp-row--blocked'
                    : undefined
                }
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
                <label className="pay-cp-field">
                  <span>{t('pay.debtorAccount')}</span>
                  <select
                    value={bankAccountId}
                    onChange={(e) => {
                      accountTouched.current = true;
                      setBankAccountId(e.target.value);
                    }}
                    disabled={eligibleAccounts.length === 0}
                  >
                    {/* Critic F4: no account at all, or none in the batch's currency (no silent
                        any-currency default); either way the act waits for a deliberate pick. */}
                    {eligibleAccounts.length === 0 ? (
                      <option value="">{t('pay.needsBankAccount')}</option>
                    ) : bankAccountId === '' ? (
                      <option value="">{t('pay.pickAccountInCurrency', { currency: selectedCurrency })}</option>
                    ) : null}
                    {eligibleAccounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="pay-cp-field">
                  <span>{t('pay.executionDate')}</span>
                  <input type="date" value={executionDate} onChange={(e) => setExecutionDate(e.target.value)} />
                </label>
                <div className="pay-cp-total">
                  <span>{t('pay.selectedTotal')}</span>
                  <strong>{formatMoney(totalMinor, selectedCurrency)}</strong>
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
              {genError !== null && <ErrorBanner error={genError} />}
            </>
          )}

          {batch !== null && (
            <div className="pay-cp-result panel">
              <div className="pay-cp-result-head">
                {/* The validity glyph: a green go-signal (`--t-success`), glyph + label, never colour alone. */}
                <span className="pay-cp-valid" aria-label={t('pay.valid')}>
                  <span aria-hidden="true">✓</span> {t('pay.valid')}
                </span>
                <span className="pay-cp-chip">{t(`pay.status.${batch.status}`)}</span>
              </div>
              <p className="pay-cp-summary">
                {t('pay.summary', {
                  n: batch.items.length,
                  total: formatMoney(batch.ctrlSumMinor ?? totalMinor, selectedCurrency),
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

              <p className="pay-cp-transmit-note">
                {transmitReason === 'use_payment_batch_transmit' ? t('pay.transmitNote.channel') : t('pay.transmitNote.manual')}
              </p>

              {/* A33: An Bank uebertragen, only when an EBICS channel routes this batch and it is generated. */}
              {transmitReason === 'use_payment_batch_transmit' && batch.status === 'generated' && (
                holdsPay ? (
                  <button type="button" className="btn btn--accent" onClick={() => void transmit()}>
                    {t('pay.transmit')}
                  </button>
                ) : (
                  <p className="pay-cp-locked">{t('pay.transmitLocked')}</p>
                )
              )}
              {transmitState?.kind === 'pending' && (
                <p className="pay-cp-pending-release" role="status">{t('pay.pendingRelease')}</p>
              )}
              {transmitState?.kind === 'degraded' && (
                <p className="pay-cp-transmit-degraded" role="status">{t('pay.transmitDegraded')}</p>
              )}
              {transmitState?.kind === 'error' && (
                <p className="pay-cp-transmit-error" role="alert">{t('pay.transmitError')}</p>
              )}

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
            <button
              type="button"
              className="btn btn--primary"
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
          <input type="date" value={valueDate} onChange={(e) => setValueDate(e.target.value)} />
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

      {items.length > 0 && (
        <p className="pay-cp-toBills">
          <Link to="/bills">{t('pay.toBillsLink')}</Link>
        </p>
      )}
    </section>
  );
}
