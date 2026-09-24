/**
 * A21/A20, Abgleich (`/reconciliation`): the QR incoming-payment matching queue AND, once a
 * statement is imported, its own camt board below it. ONE SHARED SURFACE, NO NEW SCREEN (A20 spec
 * §6): the two ingestion doors, "Gutschrift erfassen" (A21, manual) and "Kontoauszug importieren"
 * (A20, camt.053/054), sit beside each other in the header; every decision on a row (Übernehmen,
 * Prüfen, Korrigieren for the queue; Zuordnen, Buchen for the camt board) is a secondary control ON
 * the row it commits.
 *
 * THE HUMAN CLICK IS THE P8 CONFIRMATION (the Dunning idiom): every apply and override this surface
 * sends carries `confirmed: true`, because a person at the button has decided. The auto-apply dial
 * is rendered as what it is, a workspace setting that lets an AGENT settle live-`high` scores
 * unattended; this surface never needs it. `confirm_match`/`create_entry_for_txn` carry no such
 * dial (spec §0 note 4: neither verb holds a `confirmed` judgment gate at all), so the camt board's
 * two actions are always a direct call.
 *
 * A CREDIT NEVER SETTLES IN THE CAMT BOARD. `confirm_match` refuses `use_qr_queue` for a
 * credit-classified txn, so the board renders it as "im Abgleich oben entscheiden" instead of an
 * action: A20 mints no second matching machine for credits (spec §0 note 2), and neither does this
 * surface.
 *
 * EVERY FIGURE IS THE ENGINE'S. Confidence, reason, open amounts, the Mahngebühr share, the Rappen
 * delta and the camt board's `reconciled` flag all render from the engine's own read models; nothing
 * is computed here. Confidence and camt state render as glyph PLUS text, never colour alone
 * (DESIGN.md). A24's courtesy gates pre-disable what the role cannot do (`pay`+`post` for
 * apply/override/confirm/create-entry, `pay` alone for import, `manage_settings`+`pay` for the dial)
 * with the reason in a tooltip; the engine's refusal remains the real gate.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import { useClient } from '../../lib/client-context';
import { isErr } from '../../lib/client';
import { useWorkspaceId } from '../../app/workspace';
import { useCan, CAP } from '../../lib/capabilities';
import { useT, formatMoney, formatDate } from '../../i18n';
import { EmptyState, ErrorBanner, NoWorkspaceState, PermissionDenied, Skeleton } from '../../components/states';
import { SurfaceHelp } from '../../components/SurfaceHelp';
import { SurfaceHeader } from '../../components/SurfaceHeader';
import { Modal } from '../../components/Modal';
import { DataTable, type DataTableColumn } from '../../components/DataTable';
import { Select } from '../../components/Select';
import { FileDrop } from '../../components/FileDrop';
import { useFocusTrap } from '../../components/useFocusTrap';
import { useIdempotencyKey } from '../../lib/idempotency';
import { COMMIT_TARGET_CLASS, useCommitAck } from '../../lib/motion';
import { AccountCombobox } from '../../components/AccountCombobox';
import { parseAmountToMinor, minorToInput } from '../Payments/amount';
import type { PaymentPreview, PreviewLeg } from '../Payments/model';
import '../Payments/Payments.css';
import {
  parseQueue,
  parseOpenInvoices,
  parseReconciliationBoard,
  parseOpenVendorBills,
  parseSuggestions,
  parseBankStatements,
  type BankStatementSummaryView,
  type QueueView,
  type QrCreditRowView,
  type OpenInvoiceOption,
  type ReconciliationBoardView,
  type CamtTxnRowView,
  type OpenVendorBillOption,
  type CamtTxnProposalView,
  type CamtMatchSignal,
} from './model';
import './Reconciliation.css';

interface SavedViewOption {
  id: string;
  name: string;
}

interface BankAccountOption {
  id: string;
  name: string;
  currency: string;
  /** A19's ledger link (`account` id). The posting preview asks `preview_payment` against it, so the
   * legs it shows are the SAME planner `confirm_match` books through (A36-U3). Null when unlinked. */
  ledgerAccountId: string | null;
}

/** The confidence glyph: outline shapes, one green go-signal check (`--t-success`) for `high` only. */
function ConfidenceGlyph({ confidence }: { confidence: 'high' | 'medium' | 'none' }) {
  const t = useT();
  const label = t(`qrmatch.confidence.${confidence}`);
  if (confidence === 'high') {
    return (
      <svg className="qr-glyph qr-glyph--high" viewBox="0 0 16 16" width="14" height="14" aria-label={label} role="img">
        <path d="M3 8.5 6.5 12 13 4.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
      </svg>
    );
  }
  if (confidence === 'medium') {
    return (
      <svg className="qr-glyph" viewBox="0 0 16 16" width="14" height="14" aria-label={label} role="img">
        <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path d="M8 5v3.5" stroke="currentColor" strokeWidth="1.5" fill="none" />
        <circle cx="8" cy="11.2" r="0.9" fill="currentColor" />
      </svg>
    );
  }
  return (
    <svg className="qr-glyph" viewBox="0 0 16 16" width="14" height="14" aria-label={label} role="img">
      <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="2.5 2" />
    </svg>
  );
}

/**
 * A36's needs-review signal: a neutral outline glyph (never the accent, never a colour chip) paired
 * with an aria-label, exactly the ConfidenceGlyph/CamtStateGlyph convention (DESIGN.md: glyph PLUS
 * text, never colour alone). It marks a booked debit whose ranked suggestion found nothing at or
 * above the workspace review threshold; it is informational, not a state.
 */
// A36-U5: the needs-review signal is glyph PLUS a visible word, like every other status on the board
// (DESIGN.md: "status is never colour-only, icon plus text, always"). The short word rides beside the
// glyph; the full sentence explaining why (no suggestion reached the threshold) stays as the tooltip.
function NeedsReviewSignal({ label, detail }: { label: string; detail: string }) {
  return (
    <span className="qr-needs-review" title={detail}>
      <svg className="qr-glyph" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
        <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path d="M8 5v4" stroke="currentColor" strokeWidth="1.5" fill="none" />
        <circle cx="8" cy="11.2" r="0.9" fill="currentColor" />
      </svg>
      {label}
    </span>
  );
}

/** The four scoring signals rendered in words, in the order the engine lists them (spec §6). */
const REASON_SIGNALS: readonly CamtMatchSignal[] = ['amount', 'value_date', 'counterparty', 'reference'];
const REASON_KEY: Record<string, string> = {
  amount: 'camt.suggestion.reason.amount',
  value_date: 'camt.suggestion.reason.valueDate',
  counterparty: 'camt.suggestion.reason.counterparty',
  reference: 'camt.suggestion.reason.reference',
};

/** `signals` composed into one translated, comma-joined sentence: "exact amount, value date within window, ...". */
function reasonText(t: (key: string) => string, signals: readonly CamtMatchSignal[]): string {
  return REASON_SIGNALS.filter((s) => signals.includes(s))
    .map((s) => t(REASON_KEY[s] as string))
    .join(', ');
}

export function Reconciliation() {
  const t = useT();
  const client = useClient();
  const workspaceId = useWorkspaceId();
  const [params, setParams] = useSearchParams();
  const viewParam = params.get('view');

  const [queue, setQueue] = useState<QueueView | null>(null);
  const [savedViews, setSavedViews] = useState<SavedViewOption[]>([]);
  const [bankAccounts, setBankAccounts] = useState<BankAccountOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [denied, setDenied] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [overrideId, setOverrideId] = useState<string | null>(null);
  // The Commit moment (D122 D-I): the credit an apply just decided lands in its new place (the
  // decided rows) once the queue has refetched.
  const [appliedId, setAppliedId] = useState<string | null>(null);
  useCommitAck(appliedId, queue);

  // A20's camt board: an imported statement's own matched/unmatched/partial lanes, shown below the
  // A21 queue once a statement has been imported this session (?statement=... in the URL, so the
  // board survives a reload).
  const [importOpen, setImportOpen] = useState(false);
  const [statementId, setStatementId] = useState<string | null>(params.get('statement'));
  // F-03 (J3.3): every imported statement with its open-line count, the door to a board. Measured
  // 2026-09-05: the board rendered only from `?statement=<id>`, which only an import in the same
  // session set, so the golden ledger's twenty open lines had no way in from the rail.
  // Null until `list_bank_statements` answers: the list shows a skeleton, never the empty sentence,
  // while the read is in flight (critic F9, the five-states rule).
  const [statements, setStatements] = useState<BankStatementSummaryView[] | null>(null);
  const [board, setBoard] = useState<ReconciliationBoardView | null>(null);
  const [boardLoading, setBoardLoading] = useState(false);
  const [boardFailed, setBoardFailed] = useState(false);
  const [confirmTxnId, setConfirmTxnId] = useState<string | null>(null);
  const [werkbankTxnId, setWerkbankTxnId] = useState<string | null>(null);
  const [createEntryTxnId, setCreateEntryTxnId] = useState<string | null>(null);
  // A36-U3: the open vendor bills, loaded once for the board so the ranked suggestion can NAME its
  // target on the row (not only its reasons), and both the fast confirm dialog and the Werkbank can
  // seed and pre-select without each re-reading. A supplementary read: a failure narrows to no name.
  const [bills, setBills] = useState<OpenVendorBillOption[]>([]);
  // A36: the ranked-suggestion read, keyed by bankTxnId. Never blocks the board (a transport failure
  // or an older engine that does not know `suggest_matches` just renders the row with no proposal).
  const [suggestions, setSuggestions] = useState<Record<string, CamtTxnProposalView>>({});
  // A36: the batch control sum for a blocked `payment_batch` proposal, fetched on demand so the
  // mismatch can be shown side by side with the txn's own amount (`get_payment_batch`, A18).
  const [batchTotals, setBatchTotals] = useState<Record<string, number | null>>({});
  const [batchBusy, setBatchBusy] = useState<string | null>(null);

  const canPay = useCan(CAP.pay);
  const canPost = useCan(CAP.post);
  const canSettings = useCan(CAP.manageSettings);
  const canDecide = canPay && canPost;

  // A36-U3 lookups: a vendor bill by its id (to name a proposal's target and pre-select it), and a
  // bank account's ledger link (to preview the settlement against the account confirm_match will use).
  const billById = useMemo(() => {
    const m = new Map<string, OpenVendorBillOption>();
    for (const b of bills) m.set(b.vendorBillId, b);
    return m;
  }, [bills]);
  const ledgerByBankAccount = useMemo(() => {
    const m = new Map<string, string | null>();
    for (const a of bankAccounts) m.set(a.id, a.ledgerAccountId);
    return m;
  }, [bankAccounts]);
  const rowById = useMemo(() => {
    const m = new Map<string, CamtTxnRowView>();
    if (board !== null) for (const r of [...board.unmatched, ...board.partial, ...board.matched]) m.set(r.bankTxnId, r);
    return m;
  }, [board]);

  // The ledger account behind a movement's bank account (for the posting preview), the bill a
  // suggestion proposed (to pre-select), and the account's display name (for the Werkbank fact strip).
  const ledgerFor = (r: CamtTxnRowView): string | null => (r.bankAccountId === null ? null : ledgerByBankAccount.get(r.bankAccountId) ?? null);
  const proposedBillFor = (bankTxnId: string): string | null => {
    const p = suggestions[bankTxnId]?.proposal;
    return p !== null && p !== undefined && p.kind === 'vendor_bill' && billById.has(p.targetId) ? p.targetId : null;
  };
  const bankAccountNameFor = (r: CamtTxnRowView): string | null =>
    r.bankAccountId === null ? null : bankAccounts.find((a) => a.id === r.bankAccountId)?.name ?? null;

  // The statement list is a supplementary read: a failure (an older engine, a refused read) leaves
  // the list empty and the import door in place, never a dead surface.
  const loadStatements = useCallback(async () => {
    if (workspaceId === null) return;
    const response = await client.call('list_bank_statements', { workspaceId });
    setStatements(isErr(response.body) ? [] : parseBankStatements(response.body));
  }, [client, workspaceId]);

  const loadBoard = useCallback(
    async (id: string) => {
      if (workspaceId === null) return;
      setBoardLoading(true);
      setBoardFailed(false);
      const [response, suggestResponse, billsResponse] = await Promise.all([
        client.call('list_reconciliation', { workspaceId, statementId: id }),
        client.call('suggest_matches', { workspaceId, statementId: id }),
        client.call('list_vendor_bills', { workspaceId }),
        loadStatements(),
      ]);
      setBoardLoading(false);
      if (isErr(response.body)) {
        setBoardFailed(true);
        return;
      }
      const parsed = parseReconciliationBoard(response.body);
      if (parsed === null) {
        setBoardFailed(true);
        return;
      }
      setBoard(parsed);
      // The suggestion read is supplementary (A36): a failure narrows the row to no proposal, never
      // the board itself, exactly as the option reads in `load()` narrow only their own form.
      setSuggestions(isErr(suggestResponse.body) ? {} : parseSuggestions(suggestResponse.body));
      setBills(isErr(billsResponse.body) ? [] : parseOpenVendorBills(billsResponse.body));
    },
    [client, workspaceId, loadStatements],
  );

  // The one place a blocked batch proposal's own control sum is fetched (A18's `get_payment_batch`),
  // so the mismatch note can show the two figures side by side instead of naming only the txn's own
  // amount. Fetched once per batchId; a failure leaves the entry `null` and the row falls back to
  // naming the mismatch without the second figure rather than retrying forever.
  useEffect(() => {
    if (workspaceId === null) return;
    const wanted = new Set<string>();
    for (const s of Object.values(suggestions)) {
      if (s.proposal?.kind === 'payment_batch' && s.proposal.blocked) wanted.add(s.proposal.targetId);
    }
    const missing = [...wanted].filter((id) => !(id in batchTotals));
    if (missing.length === 0) return;
    let cancelled = false;
    void (async () => {
      const results = await Promise.all(
        missing.map(async (batchId) => {
          const response = await client.call('get_payment_batch', { workspaceId, batchId });
          const ctrlSumMinor =
            !isErr(response.body) && typeof response.body['batch'] === 'object' && response.body['batch'] !== null
              ? (response.body['batch'] as Record<string, unknown>)['ctrlSumMinor']
              : null;
          return [batchId, typeof ctrlSumMinor === 'number' ? ctrlSumMinor : null] as const;
        }),
      );
      if (cancelled) return;
      setBatchTotals((prev) => {
        const next = { ...prev };
        for (const [id, total] of results) next[id] = total;
        return next;
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [client, workspaceId, suggestions, batchTotals]);

  useEffect(() => {
    if (statementId !== null) void loadBoard(statementId);
  }, [statementId, loadBoard]);

  const load = useCallback(async () => {
    if (workspaceId === null) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setFailed(false);
    setDenied(false);
    const [queueResp, accountsResp, viewsResp] = await Promise.all([
      client.call('list_unmatched_incoming', {
        workspaceId,
        ...(viewParam === null ? {} : { savedViewId: viewParam }),
      }),
      client.call('list_bank_accounts', { workspaceId }),
      client.call('list_saved_views', { workspaceId, entityKind: 'reconciliation_match' }),
    ]);
    if (isErr(queueResp.body)) {
      if (queueResp.body.error === 'permission_denied' || queueResp.status === 403) {
        setDenied(true);
      } else {
        setFailed(true);
      }
      setLoading(false);
      return;
    }
    const parsed = parseQueue(queueResp.body);
    if (parsed === null) {
      setFailed(true);
      setLoading(false);
      return;
    }
    setQueue(parsed);
    // The option reads are OTHER capabilities' verbs (A19, G00): a failure narrows the form,
    // never the surface.
    if (!isErr(accountsResp.body) && Array.isArray(accountsResp.body['bankAccounts'])) {
      setBankAccounts(
        (accountsResp.body['bankAccounts'] as { id?: unknown; name?: unknown; currency?: unknown; archived?: unknown; ledgerAccountId?: unknown }[])
          .filter((a) => a.archived !== true)
          .map((a) => ({
            id: String(a.id ?? ''),
            name: String(a.name ?? ''),
            currency: String(a.currency ?? 'CHF'),
            ledgerAccountId: typeof a.ledgerAccountId === 'string' ? a.ledgerAccountId : null,
          }))
          .filter((a) => a.id.length > 0),
      );
    }
    if (!isErr(viewsResp.body) && Array.isArray(viewsResp.body['savedViews'])) {
      setSavedViews(
        (viewsResp.body['savedViews'] as { viewId?: unknown; name?: unknown }[])
          .map((v) => ({ id: String(v.viewId ?? ''), name: String(v.name ?? '') }))
          .filter((v) => v.id.length > 0),
      );
    }
    setLoading(false);
  }, [client, workspaceId, viewParam]);

  useEffect(() => {
    void load();
    void loadStatements();
  }, [load, loadStatements]);

  const openStatement = useCallback(
    (id: string) => {
      setStatementId(id);
      const next = new URLSearchParams(params);
      next.set('statement', id);
      setParams(next);
    },
    [params, setParams],
  );

  /** Map a decision rejection to its named, actionable note (P9: never "Something went wrong"). */
  const noteForError = (code: string): string => {
    if (code === 'already_paid') return t('qrmatch.alreadyPaid');
    if (code === 'period_locked') return t('qrmatch.periodLocked');
    if (code === 'currency_mismatch') return t('qrmatch.currencyMismatch');
    if (code === 'needs_bank_account') return t('qrmatch.needsBankAccount');
    if (code === 'permission_denied') return t('qrmatch.deniedNote');
    return t('qrmatch.error.action');
  };

  const apply = async (row: QrCreditRowView, invoiceId: string, mode: 'full' | 'partial', key: string) => {
    if (workspaceId === null) return;
    setBusy(row.creditId);
    setNote(null);
    const response = await client.call('apply_qr_match', {
      workspaceId,
      creditId: row.creditId,
      invoiceId,
      mode,
      // The human at this button is the P8 confirmation.
      confirmed: true,
      idempotencyKey: key,
    });
    setBusy(null);
    if (isErr(response.body)) {
      setNote(noteForError(response.body.error));
      return;
    }

    setOverrideId(null);
    setAppliedId(row.creditId);
    void load();
  };

  const dialKey = useIdempotencyKey([workspaceId, 'dial', queue?.autoApply ?? false]);
  const toggleDial = async () => {
    if (workspaceId === null || queue === null) return;
    setBusy('dial');
    setNote(null);
    const response = await client.call('set_qr_auto_apply', {
      workspaceId,
      autoApply: !queue.autoApply,
      idempotencyKey: dialKey,
    });
    setBusy(null);
    if (isErr(response.body)) {
      setNote(noteForError(response.body.error));
      return;
    }
    void load();
  };

  /**
   * A36's one-click confirm for a payment_batch proposal whose total matches the txn (never offered
   * when `blocked`): A18's `mark_batch_paid`, the same verb the Payments surface's batch history
   * uses, posting one payment per item and settling the batch atomically. `confirmation: true` is
   * this button's own P8 confirmation.
   */
  const confirmBatch = async (row: CamtTxnRowView, batchId: string) => {
    if (workspaceId === null || statementId === null) return;
    setBatchBusy(row.bankTxnId);
    setNote(null);
    const response = await client.call('mark_batch_paid', {
      workspaceId,
      batchId,
      // F2: pass the funding debit so mark_batch_paid LINKS it (bank_txn_link kind payment_batch),
      // marking it matched and closing the double-book (a 2nd confirm_match / create_entry_for_txn).
      bankTxnId: row.bankTxnId,
      confirmation: true,
      valueDate: row.valueDate ?? new Date().toISOString().slice(0, 10),
      idempotencyKey: `a36-confirm-batch-${row.bankTxnId}-${batchId}`,
    });
    setBatchBusy(null);
    if (isErr(response.body)) {
      setNote(t('camt.error.confirm'));
      return;
    }
    void loadBoard(statementId);
  };

  if (workspaceId === null) return <NoWorkspaceState />;

  const openRows = (queue?.items ?? []).filter((i) => i.status === 'open');
  const decidedRows = (queue?.items ?? []).filter((i) => i.status !== 'open');

  return (
    <section className="qr" aria-labelledby="qr-title">
      <SurfaceHeader
        title={t('qrmatch.title')}
        titleId="qr-title"
        subtitle={t('qrmatch.subtitle')}
        help={<SurfaceHelp surface="Reconciliation" />}
        actions={
          <>
            {savedViews.length > 0 && (
              <div className="qr__view">
                {t('qrmatch.savedView')}
                <Select
                  value={viewParam ?? ''}
                  onChange={(value) => {
                    const next = new URLSearchParams(params);
                    if (value === '') next.delete('view');
                    else next.set('view', value);
                    setParams(next);
                  }}
                  options={[
                    { value: '', label: t('qrmatch.savedViewAll') },
                    ...savedViews.map((v) => ({ value: v.id, label: v.name })),
                  ]}
                  ariaLabel={t('qrmatch.savedView')}
                />
              </div>
            )}
            <button
              type="button"
              className="btn btn--secondary"
              onClick={() => setImportOpen((v) => !v)}
              disabled={!canPay}
              aria-describedby={canPay ? undefined : 'qr-import-denied'}
            >
              {t('camt.import')}
            </button>
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => setRecording((r) => !r)}
              disabled={!canPay}
              aria-describedby={canPay ? undefined : 'qr-import-denied'}
            >
              {t('qrmatch.record')}
            </button>
            {/* f2: a disabled button's `title` is neither shown on hover nor announced to AT, so the
                denied reason is rendered as a VISIBLE, described-by note beside the controls it gates. */}
            {!canPay && (
              <p id="qr-import-denied" className="qr__denied-note" role="note">
                {t('qrmatch.denied')}
              </p>
            )}
          </>
        }
      />

      {note !== null && (
        <p className="qr__note" role="status">
          {note}
          {note === t('qrmatch.periodLocked') && <Link className="link-inline" to="/periods">{t('qrmatch.toPeriods')}</Link>}
          {note === t('qrmatch.needsBankAccount') && <Link className="link-inline" to="/bank-accounts">{t('qrmatch.toBankAccounts')}</Link>}
        </p>
      )}

      {recording && workspaceId !== null && (
        <RecordCreditForm
          workspaceId={workspaceId}
          bankAccounts={bankAccounts}
          onDone={() => {
            setRecording(false);
            void load();
          }}
          onNote={setNote}
        />
      )}

      {importOpen && workspaceId !== null && (
        <ImportCamtForm
          workspaceId={workspaceId}
          bankAccounts={bankAccounts}
          onDone={(id) => {
            setImportOpen(false);
            setStatementId(id);
            const next = new URLSearchParams(params);
            next.set('statement', id);
            setParams(next);
            void load();
          }}
          onNote={setNote}
        />
      )}

      {loading ? (
        <Skeleton rows={5} height={40} />
      ) : denied ? (
        <PermissionDenied body={t('qrmatch.deniedRead')} />
      ) : failed || queue === null ? (
        <ErrorBanner onRetry={() => void load()} />
      ) : queue.items.length === 0 ? (
        <EmptyState
          title={t('qrmatch.empty')}
          hint={t('qrmatch.emptyHint')}
          {...(canPay ? { action: { label: t('qrmatch.record'), onClick: () => setRecording(true) } } : {})}
        />
      ) : (
        <>
          <p className="qr__counts">
            {t('qrmatch.counts', {
              open: queue.counts.open,
              review: queue.counts.review,
              unmatched: queue.counts.unmatched,
              applied: queue.counts.applied,
            })}
          </p>
          {/* K-26: the match queue is the shared DataTable (the row tokens, the quiet head, one
              overflow per row). The row's one decision stays visible in its own cell; "Korrigieren"
              sits behind the overflow. */}
          <DataTable<QrCreditRowView>
            columns={queueColumns({
              t,
              busy,
              canDecide,
              writeOffThresholdMinor: queue.writeOffThresholdMinor,
              onOverride: (row) => setOverrideId(row.creditId),
              onApply: apply,
            })}
            rows={[...openRows, ...decidedRows]}
            rowKey={(row) => row.creditId}
            caption={t('qrmatch.title')}
            rowActions={(row) =>
              showsManualMatch(row)
                ? []
                : [
                    {
                      key: 'override',
                      label: t('qrmatch.override'),
                      disabled: !canDecide || busy === row.creditId,
                      onSelect: () => setOverrideId(row.creditId),
                    },
                  ]
            }
            rowActionsLabel={(row) =>
              t('qrmatch.rowActionsFor', { amount: formatMoney(row.amountMinor, row.currency) })
            }
            rowClassName={(row) =>
              [row.status !== 'open' ? 'qr-row--decided' : '', row.creditId === appliedId ? COMMIT_TARGET_CLASS : '']
                .filter(Boolean)
                .join(' ') || undefined
            }
          />
          {/* f2: the per-row decision buttons are disabled without pay+post; their reason is stated
              once here as a visible note the buttons point at via aria-describedby (a disabled
              button's title is not announced), instead of a title repeated on every row. */}
          {!canDecide && (
            <p id="qr-decide-denied" className="qr__denied-note" role="note">
              {t('qrmatch.denied')}
            </p>
          )}
          <label className="qr__dial">
            <input
              type="checkbox"
              checked={queue.autoApply}
              onChange={() => void toggleDial()}
              disabled={!(canSettings && canPay) || busy === 'dial'}
              aria-describedby={canSettings && canPay ? undefined : 'qr-dial-denied'}
            />
            {t('qrmatch.autoApply')}
          </label>
          {!(canSettings && canPay) && (
            <p id="qr-dial-denied" className="qr__denied-note" role="note">
              {t('qrmatch.denied')}
            </p>
          )}
        </>
      )}

      {/* F-03 (J3.3): the door to every statement. Rendered whenever the queue rendered (loaded and
          readable), above the board it opens; the open row is highlighted. */}
      {!loading && !denied && workspaceId !== null && (
        <StatementList
          statements={statements}
          bankAccounts={bankAccounts}
          openId={statementId}
          canImport={canPay}
          onOpen={openStatement}
          onImport={() => setImportOpen(true)}
        />
      )}

      {statementId !== null && workspaceId !== null && (
        <CamtBoard
          board={board}
          loading={boardLoading}
          failed={boardFailed}
          canDecide={canDecide}
          suggestions={suggestions}
          billById={billById}
          batchTotals={batchTotals}
          batchBusy={batchBusy}
          onConfirm={setConfirmTxnId}
          onWerkbank={setWerkbankTxnId}
          onCreateEntry={setCreateEntryTxnId}
          onConfirmBatch={confirmBatch}
          onRetry={() => void loadBoard(statementId)}
          onClose={() => {
            setStatementId(null);
            setBoard(null);
            const next = new URLSearchParams(params);
            next.delete('statement');
            setParams(next);
          }}
        />
      )}

      {confirmTxnId !== null && workspaceId !== null && statementId !== null && rowById.get(confirmTxnId) !== undefined && (
        <ConfirmDebitDialog
          workspaceId={workspaceId}
          row={rowById.get(confirmTxnId) as CamtTxnRowView}
          bills={bills}
          ledgerAccountId={ledgerFor(rowById.get(confirmTxnId) as CamtTxnRowView)}
          proposedBillId={proposedBillFor(confirmTxnId)}
          onClose={() => setConfirmTxnId(null)}
          onDone={() => {
            setConfirmTxnId(null);
            void loadBoard(statementId);
          }}
        />
      )}

      {werkbankTxnId !== null && workspaceId !== null && statementId !== null && rowById.get(werkbankTxnId) !== undefined && (
        <WerkbankDebitDialog
          workspaceId={workspaceId}
          row={rowById.get(werkbankTxnId) as CamtTxnRowView}
          bills={bills}
          ledgerAccountId={ledgerFor(rowById.get(werkbankTxnId) as CamtTxnRowView)}
          proposedBillId={proposedBillFor(werkbankTxnId)}
          bankAccountName={bankAccountNameFor(rowById.get(werkbankTxnId) as CamtTxnRowView)}
          onClose={() => setWerkbankTxnId(null)}
          onDone={() => {
            setWerkbankTxnId(null);
            void loadBoard(statementId);
          }}
        />
      )}

      {createEntryTxnId !== null && workspaceId !== null && statementId !== null && (
        <CreateEntryDialog
          workspaceId={workspaceId}
          bankTxnId={createEntryTxnId}
          row={rowById.get(createEntryTxnId) ?? null}
          ledgerAccountId={rowById.get(createEntryTxnId) === undefined ? null : ledgerFor(rowById.get(createEntryTxnId) as CamtTxnRowView)}
          onClose={() => setCreateEntryTxnId(null)}
          onDone={() => {
            setCreateEntryTxnId(null);
            void loadBoard(statementId);
          }}
        />
      )}

      {overrideId !== null && queue !== null && workspaceId !== null && (
        <OverrideDialog
          workspaceId={workspaceId}
          row={queue.items.find((i) => i.creditId === overrideId) ?? null}
          canDecide={canDecide}
          onClose={() => setOverrideId(null)}
          onApply={apply}
          onNote={setNote}
          onDone={() => {
            setOverrideId(null);
            void load();
          }}
        />
      )}
    </section>
  );
}

type Translate = ReturnType<typeof useT>;

/**
 * f14: an open, unmatched row already offers "Manuell zuordnen", which opens the override dialog. The
 * generic "Korrigieren" opens the SAME dialog with the SAME action, so on such a row it is suppressed,
 * leaving exactly one override control for the open-unmatched case.
 */
function showsManualMatch(row: QrCreditRowView): boolean {
  const matched = row.score.invoiceId !== null && row.score.invoiceNumber !== null;
  return row.status === 'open' && (row.score.confidence === 'none' || !matched);
}

/**
 * The match-queue columns (K-26). Every figure is the engine's, verbatim through `formatMoney` in the
 * credit's own currency; the amount column is `numeric`, so it right-aligns in tabular figures and
 * never wraps (K-18). The last visible column holds the row's ONE decision (`QueueDecision`).
 */
function queueColumns({
  t,
  busy,
  canDecide,
  writeOffThresholdMinor,
  onOverride,
  onApply,
}: {
  t: Translate;
  busy: string | null;
  canDecide: boolean;
  writeOffThresholdMinor: number;
  onOverride: (row: QrCreditRowView) => void;
  onApply: (row: QrCreditRowView, invoiceId: string, mode: 'full' | 'partial', key: string) => Promise<void>;
}): DataTableColumn<QrCreditRowView>[] {
  return [
    { key: 'date', header: t('qrmatch.col.date'), render: (row) => formatDate(row.valueDate) },
    {
      key: 'amount',
      header: t('qrmatch.col.amount'),
      numeric: true,
      render: (row) => formatMoney(row.amountMinor, row.currency),
    },
    {
      key: 'reference',
      header: t('qrmatch.col.reference'),
      rowHeader: true,
      render: (row) => (
        <span className="qr-ref">
          {row.score.referenceDisplay ?? t('qrmatch.noReference')}
          {row.payerName !== null && <span className="qr-payer">{row.payerName}</span>}
        </span>
      ),
    },
    {
      key: 'match',
      header: t('qrmatch.col.match'),
      render: (row) => {
        const score = row.score;
        const matched = score.invoiceId !== null && score.invoiceNumber !== null;
        if (!matched) return <span className="qr-muted">{t('qrmatch.noMatch')}</span>;
        return (
          <span className="qr-ref">
            {score.invoiceNumber}
            {score.contactName !== null && <span className="qr-payer">{score.contactName}</span>}
            {row.status === 'applied' && (score.invoiceOpenMinor ?? 0) > 0 && (
              <span className="qr-payer t-money">
                {t('qrmatch.remainingOpen', {
                  open: formatMoney(score.invoiceOpenMinor ?? 0, score.invoiceCurrency ?? row.currency),
                })}
              </span>
            )}
          </span>
        );
      },
    },
    {
      key: 'state',
      header: t('qrmatch.col.state'),
      render: (row) => {
        const score = row.score;
        const stateText =
          row.status === 'applied'
            ? t('qrmatch.state.applied')
            : row.status === 'dismissed'
              ? t('qrmatch.state.dismissed')
              : t(`qrmatch.confidence.${score.confidence}`);
        const reasonText = score.reason === null ? null : t(`qrmatch.reason.${score.reason}`);
        return (
          <span className="qr-state">
            {row.status === 'open' && <ConfidenceGlyph confidence={score.confidence} />}
            {stateText}
            {row.status === 'open' && reasonText !== null && <span className="qr-payer">{reasonText}</span>}
          </span>
        );
      },
    },
    {
      key: 'decision',
      header: t('qrmatch.col.actions'),
      headerHidden: true,
      render: (row) => (
        <QueueDecision
          row={row}
          busy={busy === row.creditId}
          canDecide={canDecide}
          writeOffThresholdMinor={writeOffThresholdMinor}
          onOverride={() => onOverride(row)}
          onApply={onApply}
        />
      ),
    },
  ];
}

/**
 * The row's one decision, kept visible because it IS the row's work: "Übernehmen" on a sure match,
 * "Prüfen" on a probable one (the review opens as a dialog over the queue instead of a second row
 * pushed into it), the Payments route on a currency mismatch, "Manuell zuordnen" on no match. The
 * idempotency key lives here, with the row, exactly as long as the old row component held it, so a
 * re-click after a lost response is still one write under one key (the review dialog uses the same key).
 */
function QueueDecision({
  row,
  busy,
  canDecide,
  writeOffThresholdMinor,
  onOverride,
  onApply,
}: {
  row: QrCreditRowView;
  busy: boolean;
  canDecide: boolean;
  writeOffThresholdMinor: number;
  onOverride: () => void;
  onApply: (row: QrCreditRowView, invoiceId: string, mode: 'full' | 'partial', key: string) => Promise<void>;
}) {
  const t = useT();
  const applyKey = useIdempotencyKey([row.creditId, 'apply', row.reversedPaymentIds.length]);
  const [reviewOpen, setReviewOpen] = useState(false);
  const score = row.score;
  const matched = score.invoiceId !== null && score.invoiceNumber !== null;
  // The F6 lane split: a currency mismatch names the invoice but no button here can book it, so
  // its one honest action is the Payments surface, where the bank's conversion is typed.
  const currencyDiffers = score.reason === 'currency_differs';
  // What accept-as-full would forgive: the PRINCIPAL shortfall alone, exactly the figure the
  // engine's full mode writes off. NOT -deltaMinor (critic N1): the delta measures against
  // principal + Mahngebühr, and a fee-bearing shortfall would then overstate the loss and hide
  // the button behind a ceiling the engine's own write-off never reaches.
  const lossMinor = score.invoiceOpenMinor !== null ? Math.max(0, score.invoiceOpenMinor - row.amountMinor) : 0;
  const reviewable = row.status === 'open' && score.confidence === 'medium' && matched && !currencyDiffers;
  const describedBy = canDecide ? undefined : 'qr-decide-denied';

  // One decision control per row, in the order the lanes are tested.
  let control: ReactNode = null;
  if (row.status === 'open' && score.confidence === 'high' && matched) {
    control = (
      <button
        type="button"
        className="btn btn--secondary btn--sm"
        disabled={!canDecide || busy}
        aria-describedby={describedBy}
        onClick={() => void onApply(row, score.invoiceId as string, 'full', applyKey)}
      >
        {t('qrmatch.applyFull')}
      </button>
    );
  } else if (reviewable) {
    control = (
      <button
        type="button"
        className="btn btn--secondary btn--sm"
        disabled={!canDecide || busy}
        aria-describedby={describedBy}
        aria-haspopup="dialog"
        onClick={() => setReviewOpen(true)}
      >
        {t('qrmatch.review')}
      </button>
    );
  } else if (row.status === 'open' && currencyDiffers) {
    // The F6 lane: no button on this row can book a cross-currency credit (the engine refuses every
    // one), so the row's action is the surface that can.
    control = (
      <Link className="btn btn--secondary btn--sm" to="/payments">
        {t('qrmatch.toPayments')}
      </Link>
    );
  } else if (showsManualMatch(row)) {
    control = (
      <button
        type="button"
        className="btn btn--secondary btn--sm"
        disabled={!canDecide || busy}
        aria-describedby={describedBy}
        onClick={onOverride}
      >
        {t('qrmatch.matchManually')}
      </button>
    );
  }

  const decide = (mode: 'full' | 'partial') => {
    // The dialog closes on the decision: the outcome (the row moving, or the refusal note at the top
    // of the surface) is then in view rather than behind the scrim.
    setReviewOpen(false);
    void onApply(row, score.invoiceId as string, mode, applyKey);
  };

  return (
    <>
      {control}
      <Modal
        open={reviewOpen && reviewable}
        onClose={() => setReviewOpen(false)}
        title={t('qrmatch.reviewTitle', { invoice: score.invoiceNumber ?? '' })}
        closeLabel={t('qrmatch.close')}
        footer={
          <>
            <button type="button" className="btn btn--ghost" onClick={() => setReviewOpen(false)}>
              {t('qrmatch.reviewCancel')}
            </button>
            {/*
              The F3 copy rule: accepting a shortfall as full payment BOOKS A LOSS, so the button
              names the exact amount it forgives, and it is offered only inside A14's one-click
              threshold: above it the engine refuses, so the dialog points at the deliberate route
              instead of rendering a control that cannot succeed.
            */}
            {lossMinor > 0 && lossMinor <= writeOffThresholdMinor && (
              <button type="button" className="btn btn--secondary" disabled={!canDecide || busy} onClick={() => decide('full')}>
                {t('qrmatch.applyAsFull', { loss: formatMoney(lossMinor, row.currency) })}
              </button>
            )}
            <button type="button" className="btn btn--secondary" disabled={!canDecide || busy} onClick={() => decide('partial')}>
              {t('qrmatch.applyPartial')}
            </button>
          </>
        }
      >
        <div className="qr-review__panel">
          <p>
            {t('qrmatch.reviewDetail', {
              invoice: score.invoiceNumber ?? '',
              open: formatMoney(score.totalDueMinor ?? 0, row.currency),
              delta: formatMoney(score.deltaMinor ?? 0, row.currency),
            })}
          </p>
          {(score.creditedOpenMinor ?? 0) > 0 && (
            <p className="qr-payer t-money">
              {t('qrmatch.creditedShare', { credited: formatMoney(score.creditedOpenMinor ?? 0, row.currency) })}
            </p>
          )}
          {(score.dunningFeeMinor ?? 0) > 0 && (
            <p className="qr-payer t-money">
              {t('qrmatch.feeShare', { fee: formatMoney(score.dunningFeeMinor ?? 0, row.currency) })}
            </p>
          )}
          {lossMinor > writeOffThresholdMinor && (
            <p className="qr-payer">
              {t('qrmatch.lossAboveThreshold', {
                loss: formatMoney(lossMinor, row.currency),
                threshold: formatMoney(writeOffThresholdMinor, row.currency),
              })}{' '}
              <Link className="link-inline" to="/payments">
                {t('qrmatch.toPayments')}
              </Link>
            </p>
          )}
        </div>
      </Modal>
    </>
  );
}

function RecordCreditForm({
  workspaceId,
  bankAccounts,
  onDone,
  onNote,
}: {
  workspaceId: string;
  bankAccounts: BankAccountOption[];
  onDone: () => void;
  onNote: (note: string | null) => void;
}) {
  const t = useT();
  const client = useClient();
  const [bankAccountId, setBankAccountId] = useState('');
  const [amount, setAmount] = useState('');
  const [valueDate, setValueDate] = useState('');
  const [reference, setReference] = useState('');
  const [payerName, setPayerName] = useState('');
  const [saving, setSaving] = useState(false);
  const key = useIdempotencyKey([workspaceId, 'record', bankAccountId, amount, valueDate, reference]);

  const amountMinor = parseAmountToMinor(amount);
  const valid =
    bankAccountId.length > 0 && amountMinor !== null && amountMinor !== undefined && amountMinor > 0 && valueDate.length > 0;

  const submit = async () => {
    if (!valid || amountMinor === null || amountMinor === undefined) return;
    setSaving(true);
    onNote(null);
    const response = await client.call('record_incoming_credit', {
      workspaceId,
      bankAccountId,
      amountMinor,
      valueDate,
      ...(reference.trim().length > 0 ? { reference: reference.trim() } : {}),
      ...(payerName.trim().length > 0 ? { payerName: payerName.trim() } : {}),
      idempotencyKey: key,
    });
    setSaving(false);
    if (isErr(response.body)) {
      onNote(
        response.body.error === 'needs_bank_account' ? t('qrmatch.needsBankAccount') : t('qrmatch.error.record'),
      );
      return;
    }
    onDone();
  };

  return (
    <form
      className="qr-form panel"
      aria-label={t('qrmatch.record')}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="qr-form__field">
        {t('qrmatch.form.account')}
        <Select
          value={bankAccountId}
          onChange={setBankAccountId}
          options={[
            { value: '', label: t('qrmatch.form.accountPick') },
            ...bankAccounts.map((a) => ({ value: a.id, label: a.name })),
          ]}
          ariaLabel={t('qrmatch.form.account')}
        />
      </div>
      <label>
        {t('qrmatch.form.amount')}
        <input className="field" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} required />
      </label>
      <label>
        {t('qrmatch.form.valueDate')}
        <input className="field" type="date" value={valueDate} onChange={(e) => setValueDate(e.target.value)} required />
      </label>
      <label>
        {t('qrmatch.form.reference')}
        <input className="field" value={reference} onChange={(e) => setReference(e.target.value)} />
      </label>
      <label>
        {t('qrmatch.form.payer')}
        <input className="field" value={payerName} onChange={(e) => setPayerName(e.target.value)} />
      </label>
      <button type="submit" className="btn btn--primary" disabled={!valid || saving}>
        {t('qrmatch.form.submit')}
      </button>
    </form>
  );
}

function OverrideDialog({
  workspaceId,
  row,
  canDecide,
  onClose,
  onApply,
  onNote,
  onDone,
}: {
  workspaceId: string;
  row: QrCreditRowView | null;
  canDecide: boolean;
  onClose: () => void;
  onApply: (row: QrCreditRowView, invoiceId: string, mode: 'full' | 'partial', key: string) => Promise<void>;
  onNote: (note: string | null) => void;
  onDone: () => void;
}) {
  const t = useT();
  const client = useClient();
  const [invoices, setInvoices] = useState<OpenInvoiceOption[] | null>(null);
  const [picked, setPicked] = useState('');
  const [saving, setSaving] = useState(false);
  const applyKey = useIdempotencyKey([row?.creditId ?? '', 'override-apply', picked]);
  const overrideKey = useIdempotencyKey([row?.creditId ?? '', 'override', picked]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const response = await client.call('list_open_items', { workspaceId });
      if (cancelled) return;
      setInvoices(isErr(response.body) ? [] : parseOpenInvoices(response.body));
    })();
    return () => {
      cancelled = true;
    };
  }, [client, workspaceId]);

  if (row === null) return null;
  const wasApplied = row.status === 'applied';

  const override = async (input: Record<string, unknown>) => {
    setSaving(true);
    onNote(null);
    const response = await client.call('override_qr_match', {
      workspaceId,
      creditId: row.creditId,
      confirmed: true,
      idempotencyKey: overrideKey,
      ...input,
    });
    setSaving(false);
    if (isErr(response.body)) {
      onNote(
        response.body.error === 'period_locked' ? t('qrmatch.periodLocked') : t('qrmatch.error.action'),
      );
      return;
    }
    onDone();
  };

  return (
    <Modal
      open
      title={t('qrmatch.override')}
      onClose={onClose}
      closeLabel={t('qrmatch.close')}
      footer={
        <>
          {picked !== '' && !wasApplied && (
            <button
              type="button"
              className="btn btn--secondary"
              disabled={!canDecide || saving}
              onClick={() => {
                const target = row;
                void onApply(target, picked, 'partial', applyKey).then(onDone);
              }}
            >
              {t('qrmatch.overrideApply')}
            </button>
          )}
          {picked !== '' && wasApplied && (
            <button
              type="button"
              className="btn btn--secondary"
              disabled={!canDecide || saving}
              onClick={() => void override({ invoiceId: picked })}
            >
              {t('qrmatch.overrideReapply')}
            </button>
          )}
          {(wasApplied || row.invoiceId !== null) && (
            <button
              type="button"
              className="btn btn--secondary"
              disabled={!canDecide || saving}
              onClick={() => void override({ action: 'unmatch' })}
            >
              {t('qrmatch.overrideUnmatch')}
            </button>
          )}
          {row.status !== 'dismissed' && (
            <button
              type="button"
              className="btn btn--secondary"
              disabled={!canDecide || saving}
              onClick={() => void override({ action: 'dismiss' })}
            >
              {t('qrmatch.overrideDismiss')}
            </button>
          )}
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            {t('qrmatch.close')}
          </button>
        </>
      }
    >
      <p className="qr-dialog__credit">
        {formatDate(row.valueDate)} · <span className="t-money">{formatMoney(row.amountMinor, row.currency)}</span>
        {row.score.referenceDisplay !== null && <span className="qr-payer">{row.score.referenceDisplay}</span>}
      </p>
      {wasApplied && (
        <p className="qr-dialog__audit">
          {t('qrmatch.overrideAudit', {
            who: row.decidedBy ?? '',
            when: row.decidedAt === null ? '' : formatDate(row.decidedAt.slice(0, 10)),
          })}
        </p>
      )}
      {invoices === null ? (
        <Skeleton rows={2} height={24} />
      ) : (
        <div className="qr-dialog__pick">
          {t('qrmatch.overridePick')}
          <Select
            value={picked}
            onChange={setPicked}
            options={[
              { value: '', label: t('qrmatch.overridePickNone') },
              ...invoices
                .filter((i) => i.currency === row.currency && i.documentId !== row.invoiceId)
                .map((i) => ({
                  value: i.documentId,
                  label: `${i.number ?? i.documentId} · ${i.customerName ?? ''} · ${formatMoney(i.openMinor, i.currency)}`,
                })),
            ]}
            ariaLabel={t('qrmatch.overridePick')}
          />
        </div>
      )}
    </Modal>
  );
}

function ImportCamtForm({
  workspaceId,
  bankAccounts,
  onDone,
  onNote,
}: {
  workspaceId: string;
  bankAccounts: BankAccountOption[];
  onDone: (statementId: string) => void;
  onNote: (note: string | null) => void;
}) {
  const t = useT();
  const client = useClient();
  const [bankAccountId, setBankAccountId] = useState('');
  const [fileName, setFileName] = useState('');
  const [xml, setXml] = useState<string | null>(null);
  const [allowDuplicateEntries, setAllowDuplicateEntries] = useState(false);
  const [saving, setSaving] = useState(false);
  const key = useIdempotencyKey([workspaceId, 'import', bankAccountId, fileName, xml?.length ?? 0]);

  const onFile = (file: File | undefined) => {
    if (file === undefined) return;
    setFileName(file.name);
    void file.text().then(setXml);
  };

  const submit = async () => {
    if (bankAccountId.length === 0 || xml === null) return;
    setSaving(true);
    onNote(null);
    const response = await client.call('import_camt', {
      workspaceId,
      bankAccountId,
      xml,
      ...(allowDuplicateEntries ? { allowDuplicateEntries: true } : {}),
      idempotencyKey: key,
    });
    setSaving(false);
    if (isErr(response.body)) {
      const code = response.body.error;
      if (code === 'statement_amended') {
        const rawChanges = response.body.changes;
        const changes = Array.isArray(rawChanges) ? rawChanges.filter((c): c is string => typeof c === 'string') : [];
        onNote(t('camt.error.statementAmended', { changes: changes.length > 0 ? changes.join('; ') : t('camt.error.statementAmendedUnnamed') }));
        return;
      }
      onNote(
        code === 'schema_invalid'
          ? t('camt.error.schemaInvalid')
          : code === 'iban_mismatch'
            ? t('camt.error.ibanMismatch')
            : code === 'needs_bank_account'
              ? t('camt.needsBankAccount')
              : t('camt.error.import'),
      );
      return;
    }
    const body = response.body as { statementId?: unknown; duplicate?: unknown; txnCount?: unknown; skipped?: unknown };
    if (body.duplicate === true) {
      onNote(t('camt.duplicate'));
    } else if (Array.isArray(body.skipped) && body.skipped.length > 0) {
      onNote(t('camt.skipped', { count: body.skipped.length }));
    }
    if (typeof body.statementId === 'string') onDone(body.statementId);
  };

  return (
    <form
      className="qr-form panel"
      aria-label={t('camt.import')}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="qr-form__field">
        {t('camt.form.account')}
        <Select
          value={bankAccountId}
          onChange={setBankAccountId}
          options={[
            { value: '', label: t('qrmatch.form.accountPick') },
            ...bankAccounts.map((a) => ({ value: a.id, label: a.name })),
          ]}
          ariaLabel={t('camt.form.account')}
        />
      </div>
      {/* K-13: the shared FileDrop, never the browser's own "Choose File": the button names the file
          it wants, the picked file is named beside it, and a dropped file of the wrong type is refused
          before it reaches the import. */}
      <div className="qr-form__field">
        {t('camt.form.file')}
        <FileDrop
          accept=".xml,text/xml,application/xml"
          label={t('camt.form.file')}
          prompt={t('camt.form.fileDrop')}
          onFiles={(files) => onFile(files[0])}
          onReject={() => onNote(t('camt.error.schemaInvalid'))}
          hint={fileName.length > 0 ? fileName : undefined}
        />
      </div>
      <label className="qr__dial">
        <input
          type="checkbox"
          checked={allowDuplicateEntries}
          onChange={(e) => setAllowDuplicateEntries(e.target.checked)}
        />
        {t('camt.form.allowDuplicates')}
      </label>
      <button type="submit" className="btn btn--primary" disabled={bankAccountId.length === 0 || xml === null || saving}>
        {t('camt.form.submit')}
      </button>
    </form>
  );
}

/** The confidence-style glyph, applied to the camt board's own matched/unmatched/partial states. */
function CamtStateGlyph({ status }: { status: 'matched' | 'unmatched' | 'partial' }) {
  const t = useT();
  const label = t(`camt.state.${status}`);
  if (status === 'matched') {
    return (
      <svg className="qr-glyph qr-glyph--high" viewBox="0 0 16 16" width="14" height="14" aria-label={label} role="img">
        <path d="M3 8.5 6.5 12 13 4.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
      </svg>
    );
  }
  if (status === 'partial') {
    return (
      <svg className="qr-glyph" viewBox="0 0 16 16" width="14" height="14" aria-label={label} role="img">
        <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path d="M8 5v3.5" stroke="currentColor" strokeWidth="1.5" fill="none" />
        <circle cx="8" cy="11.2" r="0.9" fill="currentColor" />
      </svg>
    );
  }
  return (
    <svg className="qr-glyph" viewBox="0 0 16 16" width="14" height="14" aria-label={label} role="img">
      <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="2.5 2" />
    </svg>
  );
}

/** The camt board's state cell: the glyph-plus-text status, the A36 named proposal, its reasons and
 *  the batch note. Rendered as the `state` column of the shared DataTable (the row markup is the
 *  primitive's; only this cell's content is the surface's). */
function CamtStateCell({
  row,
  suggestion,
  billById,
  batchTotal,
}: {
  row: CamtTxnRowView;
  suggestion: CamtTxnProposalView | undefined;
  /** The open bills, so a `vendor_bill` proposal can NAME its target on the row (A36-U3). */
  billById: Map<string, OpenVendorBillOption>;
  /** The blocked batch's own control sum, once fetched (`undefined` = not yet asked, `null` = failed). */
  batchTotal: number | null | undefined;
}) {
  const t = useT();
  const proposal = row.status === 'unmatched' ? (suggestion?.proposal ?? null) : null;
  const needsReview = row.status === 'unmatched' && (suggestion?.needsReview ?? false);
  const isBatch = proposal?.kind === 'payment_batch';
  // A36-U3: the proposed vendor bill, so the row names WHAT is proposed (its supplier, reference and
  // open amount), not only the reasons WHY. Null when the proposal is not a bill we hold, or is a batch.
  const proposedBill = proposal?.kind === 'vendor_bill' ? (billById.get(proposal.targetId) ?? null) : null;
  return (
    <>
      <span className="qr-state">
        <CamtStateGlyph status={row.status} />
        {t(`camt.state.${row.status}`)}
        {needsReview && <NeedsReviewSignal label={t('camt.needsReviewShort')} detail={t('camt.needsReview')} />}
      </span>
      {proposedBill !== null && (
        <span className="qr-payer camt-suggestion-target">{t('camt.suggestion.target', { name: vendorBillLabel(proposedBill) })}</span>
      )}
      {proposal !== null && !isBatch && proposal.signals.length > 0 && (
        <span className="qr-payer">{reasonText(t, proposal.signals)}</span>
      )}
      {/* F-03 (J3.3): a line with no candidate SAYS so (a fee, interest, a transfer) and names the act,
          instead of a blank cell the person has to interpret. */}
      {row.status === 'unmatched' && row.classification !== 'incoming_credit' && suggestion !== undefined && proposal === null && (
        <span className="qr-payer camt-suggestion-none">{t('camt.suggestion.none')}</span>
      )}
      {isBatch && (
        <span className="qr-payer camt-suggestion-batch">
          {t('camt.suggestion.batch')}
          {proposal?.blocked === true && (
            <>
              {' · '}
              {t('camt.suggestion.batchMismatch')}
              {' ('}
              <span className="t-money">{formatMoney(row.amountMinor, row.currency)}</span>
              {' / '}
              {typeof batchTotal === 'number' ? (
                <span className="t-money">{formatMoney(batchTotal, row.currency)}</span>
              ) : (
                '…'
              )}
              {')'}
            </>
          )}
        </span>
      )}
    </>
  );
}

/** The camt board's actions cell: Zuordnen / Aufteilen / Buchen and the one-click batch confirm, or
 *  the "decide above" pointer for an incoming credit. The row's write verbs are unchanged; only the
 *  hosting `<td>` is now the DataTable primitive's. */
function CamtActionsCell({
  row,
  canDecide,
  suggestion,
  batchBusy,
  onConfirm,
  onConfirmBatch,
}: {
  row: CamtTxnRowView;
  canDecide: boolean;
  suggestion: CamtTxnProposalView | undefined;
  batchBusy: boolean;
  onConfirm: (bankTxnId: string) => void;
  onConfirmBatch: (row: CamtTxnRowView, batchId: string) => void;
}) {
  const t = useT();
  const proposal = row.status === 'unmatched' ? (suggestion?.proposal ?? null) : null;
  const isBatch = proposal?.kind === 'payment_batch';
  return (
    <div className="qr-actions">
      {row.classification === 'incoming_credit' && row.status !== 'matched' && (
        <span className="qr-muted">{t('camt.seeQueue')}</span>
      )}
      {row.classification !== 'incoming_credit' && row.status === 'unmatched' && (
        <>
          {isBatch && proposal !== null && (
            <button
              type="button"
              className="btn btn--secondary btn--sm"
              disabled={!canDecide || proposal.blocked === true || batchBusy}
              // f2: the permission-denied reason moves to a visible, described-by note (a disabled
              // button's title is not announced). The batch-mismatch hint is not a permission denial,
              // so it stays as the title on the still-mismatched-but-permitted case.
              title={canDecide && proposal.blocked === true ? t('camt.suggestion.batchMismatch') : undefined}
              aria-describedby={canDecide ? undefined : 'camt-decide-denied'}
              onClick={() => onConfirmBatch(row, proposal.targetId)}
            >
              {t('camt.suggestion.confirmBatch')}
            </button>
          )}
          {/* K-21: the row's visible decision ("Zuordnen", beside the one-click batch confirm on a
              batch row, so the manual route never disappears when the batch cannot fire). "Aufteilen"
              (the Werkbank) and "Buchen" (a contra entry) sit in the row's overflow. */}
          <button
            type="button"
            className="btn btn--secondary btn--sm"
            disabled={!canDecide}
            aria-describedby={canDecide ? undefined : 'camt-decide-denied'}
            onClick={() => onConfirm(row.bankTxnId)}
          >
            {t('camt.confirm')}
          </button>
        </>
      )}
    </div>
  );
}

function CamtBoard({
  board,
  loading,
  failed,
  canDecide,
  suggestions,
  billById,
  batchTotals,
  batchBusy,
  onConfirm,
  onWerkbank,
  onCreateEntry,
  onConfirmBatch,
  onClose,
  onRetry,
}: {
  board: ReconciliationBoardView | null;
  loading: boolean;
  failed: boolean;
  canDecide: boolean;
  suggestions: Record<string, CamtTxnProposalView>;
  billById: Map<string, OpenVendorBillOption>;
  batchTotals: Record<string, number | null>;
  batchBusy: string | null;
  onConfirm: (bankTxnId: string) => void;
  onWerkbank: (bankTxnId: string) => void;
  onCreateEntry: (bankTxnId: string) => void;
  onConfirmBatch: (row: CamtTxnRowView, batchId: string) => void;
  onClose: () => void;
  onRetry: () => void;
}) {
  const t = useT();
  const rows = board === null ? [] : [...board.unmatched, ...board.partial, ...board.matched];
  // The camt board's own columns over the shared DataTable: the primitive owns the frame, sticky
  // header, density and the five states; these render fns own only the cell content. Every figure is
  // the row's own (`amountMinor` verbatim through the shared money formatter), nothing summed here.
  const columns: DataTableColumn<CamtTxnRowView>[] = [
    {
      key: 'date',
      header: t('qrmatch.col.date'),
      render: (row) => (row.valueDate === null ? '' : formatDate(row.valueDate)),
    },
    {
      key: 'amount',
      header: t('qrmatch.col.amount'),
      numeric: true,
      render: (row) => (
        <>
          {row.creditDebit === 'CRDT' ? '+' : '-'}
          {formatMoney(row.amountMinor, row.currency)}
        </>
      ),
    },
    {
      key: 'entryRef',
      header: t('camt.col.entryRef'),
      render: (row) => (
        <span className="qr-ref">
          {row.entryRef ?? t('camt.noEntryRef')}
          {row.payerName !== null && <span className="qr-payer">{row.payerName}</span>}
        </span>
      ),
    },
    {
      key: 'state',
      header: t('qrmatch.col.state'),
      render: (row) => {
        const suggestion = suggestions[row.bankTxnId];
        const batchId = suggestion?.proposal?.kind === 'payment_batch' ? suggestion.proposal.targetId : undefined;
        return (
          <CamtStateCell
            row={row}
            suggestion={suggestion}
            billById={billById}
            batchTotal={batchId === undefined ? undefined : batchTotals[batchId]}
          />
        );
      },
    },
    {
      key: 'actions',
      header: t('qrmatch.col.actions'),
      headerHidden: true,
      align: 'end',
      render: (row) => (
        <CamtActionsCell
          row={row}
          canDecide={canDecide}
          suggestion={suggestions[row.bankTxnId]}
          batchBusy={batchBusy === row.bankTxnId}
          onConfirm={onConfirm}
          onConfirmBatch={onConfirmBatch}
        />
      ),
    },
  ];
  return (
    <section className="qr-board panel" aria-labelledby="camt-board-title">
      <header className="qr__head">
        <div>
          <h2 id="camt-board-title">{t('camt.board.title')}</h2>
          {board !== null && board.reconciled !== null && (
            <p className="qr__subtitle">
              <span className="qr-state">
                <CamtStateGlyph status={board.reconciled ? 'matched' : 'unmatched'} />
                {board.reconciled ? t('camt.board.reconciled') : t('camt.board.notReconciled')}
              </span>
            </p>
          )}
        </div>
        <button type="button" className="btn btn--ghost" onClick={onClose}>
          {t('camt.board.close')}
        </button>
      </header>
      {/* f2: the board's per-row decision buttons are disabled without pay+post; the reason is a
          visible note the buttons reference by aria-describedby, not a title they cannot announce. */}
      {!canDecide && (
        <p id="camt-decide-denied" className="qr__denied-note" role="note">
          {t('camt.denied')}
        </p>
      )}
      {loading ? (
        <Skeleton rows={3} height={36} />
      ) : failed ? (
        <ErrorBanner onRetry={onRetry} />
      ) : rows.length === 0 ? (
        <EmptyState title={t('camt.board.empty')} hint={t('camt.board.emptyHint')} />
      ) : (
        <DataTable<CamtTxnRowView>
          caption={t('camt.board.title')}
          columns={columns}
          rows={rows}
          rowKey={(row) => row.bankTxnId}
          rowClassName={(row) => `camt-row--${row.status}`}
          // K-21: every verb besides the row's visible decision, behind its one overflow.
          rowActions={(row) => {
            if (row.classification === 'incoming_credit' || row.status !== 'unmatched') return [];
            return [
              // A36-U3 (D114 hybrid): the manual / split path into the Werkbank two-pane, for a debit
              // that settles several bills or none the suggestion proposed.
              { key: 'split', label: t('camt.dialog.split'), disabled: !canDecide, onSelect: () => onWerkbank(row.bankTxnId) },
              { key: 'entry', label: t('camt.createEntry'), disabled: !canDecide, onSelect: () => onCreateEntry(row.bankTxnId) },
            ];
          }}
          rowActionsLabel={(row) => t('camt.rowActionsFor', { amount: formatMoney(row.amountMinor, row.currency) })}
        />
      )}
    </section>
  );
}

/** One debit-settlement allocation as `confirm_match` and `preview_payment` both take it. */
interface DebitAllocation {
  vendorBillId: string;
  amountMinor: number;
}

/** The picker's one-line identity for a bill: its supplier reference, the supplier, the open amount. */
function vendorBillLabel(b: OpenVendorBillOption): string {
  return `${b.vendorReference ?? b.vendorBillId} · ${b.vendorName ?? ''} · ${formatMoney(b.openMinor, b.currency)}`;
}

/**
 * The posting preview for a debit settlement, sourced from `preview_payment` (A36-U3, §4 rule 3: the
 * engine owns every figure). `confirm_match` books an OUTGOING payment for the full bank fact against
 * the named bills, so the preview asks for exactly that (same direction, amount, date and ledger
 * account) and the legs it shows ARE the legs `confirm_match` will post. A missing ledger link, or an
 * empty allocation, resolves to no preview rather than a wrong one.
 */
function usePostingPreview(
  workspaceId: string,
  row: CamtTxnRowView,
  ledgerAccountId: string | null,
  allocations: DebitAllocation[],
): { preview: PaymentPreview | null; loading: boolean } {
  const client = useClient();
  const [preview, setPreview] = useState<PaymentPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const allocRef = useRef(allocations);
  allocRef.current = allocations;
  const key = JSON.stringify(allocations);
  useEffect(() => {
    if (ledgerAccountId === null || allocRef.current.length === 0) {
      setPreview(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void (async () => {
      const response = await client.call('preview_payment', {
        workspaceId,
        direction: 'outgoing',
        date: row.valueDate ?? new Date().toISOString().slice(0, 10),
        amountMinor: row.amountMinor,
        bankAccountId: ledgerAccountId,
        allocations: allocRef.current.map((a) => ({ vendorBillId: a.vendorBillId, amountMinor: a.amountMinor })),
      });
      if (cancelled) return;
      setPreview(isErr(response.body) ? null : (response.body as unknown as PaymentPreview));
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [client, workspaceId, row.valueDate, row.amountMinor, ledgerAccountId, key]);
  return { preview, loading };
}

/** The legs, the total and the named target the settlement will post, shown BEFORE anything books
 *  (A36-U3: nothing posts blind). Money in `--t-text`, tabular-nums; Soll/Haben as words. */
function PostingPreview({
  preview,
  loading,
  ledgerAccountId,
  targetLabel,
}: {
  preview: PaymentPreview | null;
  loading: boolean;
  ledgerAccountId: string | null;
  targetLabel: string | null;
}) {
  const t = useT();
  if (ledgerAccountId === null) {
    return <p className="qr__note">{t('camt.preview.unavailable')}</p>;
  }
  if (loading && preview === null) {
    return (
      <p className="qr-dim" role="status">
        {t('camt.preview.loading')}
      </p>
    );
  }
  if (preview === null) return null;
  const currency = preview.currency;
  const total = preview.legs.reduce((sum, leg) => sum + leg.debitMinor, 0);
  return (
    <div className="camt-preview" aria-label={t('camt.preview.title')}>
      <h3 className="camt-preview-title">{t('camt.preview.title')}</h3>
      {targetLabel !== null && (
        <p className="camt-preview-target">
          {t('camt.preview.target')}: {targetLabel}
        </p>
      )}
      <table className="camt-preview-legs">
        <tbody>
          {preview.legs.map((leg: PreviewLeg, index: number) => (
            <tr key={`${leg.accountId}-${index}`}>
              <td>{`${leg.accountNumber} ${leg.accountLabel}`}</td>
              <td className="qr-num t-money">{leg.debitMinor > 0 ? `${t('camt.preview.soll')} ${formatMoney(leg.debitMinor, currency)}` : ''}</td>
              <td className="qr-num t-money">{leg.creditMinor > 0 ? `${t('camt.preview.haben')} ${formatMoney(leg.creditMinor, currency)}` : ''}</td>
            </tr>
          ))}
          <tr className="camt-preview-total">
            <td>{t('camt.preview.total')}</td>
            <td className="qr-num t-money">{formatMoney(total, currency)}</td>
            <td />
          </tr>
        </tbody>
      </table>
    </div>
  );
}

/**
 * The FAST confirm path (D114 hybrid): a high-confidence suggested match keeps its one-dialog confirm,
 * but nothing posts blind any more. The proposed bill is pre-selected, the resulting posting is
 * previewed (legs + total + the named target), and Zuordnen books it through `confirm_match`, the ONE
 * verb that links the bank statement line to the posted payment (the `bank_txn_link` row). The manual
 * free-text entry link stays as the second option. Ambiguous or split allocations go to the Werkbank.
 */
function ConfirmDebitDialog({
  workspaceId,
  row,
  bills,
  ledgerAccountId,
  proposedBillId,
  onClose,
  onDone,
}: {
  workspaceId: string;
  row: CamtTxnRowView;
  bills: OpenVendorBillOption[];
  ledgerAccountId: string | null;
  proposedBillId: string | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const t = useT();
  const client = useClient();
  const bankTxnId = row.bankTxnId;
  const [pickedId, setPickedId] = useState(proposedBillId !== null && bills.some((b) => b.vendorBillId === proposedBillId) ? proposedBillId : '');
  const [entryId, setEntryId] = useState('');
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const billKey = useIdempotencyKey([bankTxnId, 'confirm-bill', pickedId]);
  const entryKey = useIdempotencyKey([bankTxnId, 'confirm-entry', entryId]);

  // The full bank fact settles the one picked bill (`confirm_match`'s own single-bill contract), so
  // the preview asks for exactly that allocation.
  const allocations = useMemo<DebitAllocation[]>(
    () => (pickedId === '' ? [] : [{ vendorBillId: pickedId, amountMinor: row.amountMinor }]),
    [pickedId, row.amountMinor],
  );
  const { preview, loading } = usePostingPreview(workspaceId, row, ledgerAccountId, allocations);
  const pickedBill = bills.find((b) => b.vendorBillId === pickedId) ?? null;

  const confirmBill = async () => {
    if (pickedId.length === 0) return;
    setSaving(true);
    setNote(null);
    const response = await client.call('confirm_match', {
      workspaceId,
      bankTxnId,
      vendorBillId: pickedId,
      idempotencyKey: billKey,
    });
    setSaving(false);
    if (isErr(response.body)) {
      setNote(response.body.error === 'wrong_direction' ? t('camt.error.wrongDirection') : t('camt.error.confirm'));
      return;
    }
    onDone();
  };

  const confirmEntry = async () => {
    if (entryId.trim().length === 0) return;
    setSaving(true);
    setNote(null);
    const response = await client.call('confirm_match', {
      workspaceId,
      bankTxnId,
      entryId: entryId.trim(),
      idempotencyKey: entryKey,
    });
    setSaving(false);
    if (isErr(response.body)) {
      setNote(t('camt.error.confirm'));
      return;
    }
    onDone();
  };

  return (
    <Modal
      open
      title={t('camt.confirm')}
      onClose={onClose}
      closeLabel={t('qrmatch.close')}
      footer={
        <>
          <button type="button" className="btn btn--secondary" disabled={pickedId.length === 0 || saving} onClick={() => void confirmBill()}>
            {t('camt.dialog.confirmBill')}
          </button>
          <button
            type="button"
            className="btn btn--secondary"
            disabled={entryId.trim().length === 0 || saving}
            onClick={() => void confirmEntry()}
          >
            {t('camt.dialog.confirmEntry')}
          </button>
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            {t('qrmatch.close')}
          </button>
        </>
      }
    >
      {note !== null && (
        <p className="qr__note" role="status">
          {note}
        </p>
      )}
      <div className="qr-dialog__pick">
        {t('camt.dialog.pickBill')}
        <Select
          value={pickedId}
          onChange={setPickedId}
          options={[
            { value: '', label: t('qrmatch.overridePickNone') },
            ...bills.map((b) => ({ value: b.vendorBillId, label: vendorBillLabel(b) })),
          ]}
          ariaLabel={t('camt.dialog.pickBill')}
        />
      </div>

      {/* A36-U3: the resulting posting, previewed before Zuordnen books it. */}
      {pickedBill !== null && (
        <PostingPreview
          preview={preview}
          loading={loading}
          ledgerAccountId={ledgerAccountId}
          targetLabel={vendorBillLabel(pickedBill)}
        />
      )}

      <label className="qr-dialog__pick">
        {t('camt.dialog.pickEntry')}
        <input className="field" value={entryId} onChange={(e) => setEntryId(e.target.value)} placeholder={t('camt.dialog.entryIdPlaceholder')} />
      </label>
    </Modal>
  );
}

/**
 * The HARD path (D114 hybrid): manual or ambiguous debit allocations use the A14 Werkbank two-pane
 * (`.pay-wb`), pre-seeded with the bank fact and the candidate. It is rendered INLINE on
 * `/reconciliation`, NOT as a route to `/payments/new`: the money-path linkage that marks the bank
 * statement line matched (the `bank_txn_link` row) is written ONLY by `confirm_match`, and
 * `/payments/new` books through `record_payment`, which writes no such link. So the two-pane Buchen
 * calls `confirm_match` with `allocations[]` (its multi-bill split contract), and the line ends up
 * matched by exactly the same mechanism the fast path uses. No engine change; existing verbs only.
 */
function WerkbankDebitDialog({
  workspaceId,
  row,
  bills,
  ledgerAccountId,
  proposedBillId,
  bankAccountName,
  onClose,
  onDone,
}: {
  workspaceId: string;
  row: CamtTxnRowView;
  bills: OpenVendorBillOption[];
  ledgerAccountId: string | null;
  proposedBillId: string | null;
  bankAccountName: string | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const t = useT();
  const client = useClient();
  const bankTxnId = row.bankTxnId;
  const dialogRef = useRef<HTMLDivElement>(null);

  // The typed allocation per bill. The proposed bill is pre-seeded to whatever it can absorb of the
  // bank fact (its open amount, capped at the movement), so the common one-bill case is one click.
  const [amounts, setAmounts] = useState<Record<string, string>>(() => {
    const seed: Record<string, string> = {};
    const proposed = proposedBillId === null ? null : bills.find((b) => b.vendorBillId === proposedBillId) ?? null;
    if (proposed !== null) seed[proposed.vendorBillId] = minorToInput(Math.min(proposed.openMinor, row.amountMinor));
    return seed;
  });
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const allocations = useMemo<DebitAllocation[]>(() => {
    const out: DebitAllocation[] = [];
    for (const b of bills) {
      const minor = parseAmountToMinor(amounts[b.vendorBillId] ?? '');
      if (minor !== null && minor > 0) out.push({ vendorBillId: b.vendorBillId, amountMinor: minor });
    }
    return out;
  }, [amounts, bills]);

  const { preview, loading } = usePostingPreview(workspaceId, row, ledgerAccountId, allocations);
  const idempotencyKey = useIdempotencyKey([bankTxnId, 'werkbank', allocations]);
  useFocusTrap(dialogRef, { onEscape: onClose });

  // The remainder is the engine's when it can preview; when the account has no ledger link the
  // preview is unavailable, so the running remainder falls back to the plain allocation arithmetic
  // (a UI gate only: the booked figures still come from `confirm_match`). Buchen needs a zero
  // remainder, so the whole movement is accounted for and nothing lands on account without an owner.
  const allocatedMinor = allocations.reduce((sum, a) => sum + a.amountMinor, 0);
  const remainderMinor = preview !== null ? preview.remainderMinor : row.amountMinor - allocatedMinor;
  const blocked = preview?.error ?? null;
  const canBook = allocations.length > 0 && remainderMinor === 0 && blocked === null && !saving;

  const book = async () => {
    if (!canBook) return;
    setSaving(true);
    setNote(null);
    const response = await client.call('confirm_match', {
      workspaceId,
      bankTxnId,
      allocations: allocations.map((a) => ({ vendorBillId: a.vendorBillId, amountMinor: a.amountMinor })),
      idempotencyKey,
    });
    setSaving(false);
    if (isErr(response.body)) {
      setNote(response.body.error === 'wrong_direction' ? t('camt.error.wrongDirection') : t('camt.error.confirm'));
      dialogRef.current?.focus();
      return;
    }
    onDone();
  };

  const currency = preview?.currency ?? row.currency;

  return (
    <>
      <div className="pay-scrim" role="presentation" onClick={onClose} />
      <div className="pay-wb" role="dialog" aria-modal="true" aria-label={t('camt.werkbank.title')} ref={dialogRef} tabIndex={-1}>
        <header className="pay-wb-head">
          <h2 className="pay-wb-title">{t('camt.werkbank.title')}</h2>
          <button type="button" className="pay-wb-close" onClick={onClose} aria-label={t('qrmatch.close')}>
            ×
          </button>
        </header>

        {/* The bank fact, across the top: the movement being settled, read-only (it IS the statement). */}
        <div className="pay-money">
          <div className="pay-field">
            <span>{t('camt.werkbank.bankFact')}</span>
            <span className="camt-werkbank-fact qr-num">
              <span className="t-money">-{formatMoney(row.amountMinor, row.currency)}</span>
              {bankAccountName !== null && <span className="qr-dim"> · {bankAccountName}</span>}
              {row.valueDate !== null && <span className="qr-dim"> · {formatDate(row.valueDate)}</span>}
            </span>
          </div>
        </div>

        <div className="pay-wb-panel">
          <section className="pay-wb-left" aria-label={t('camt.werkbank.candidates')}>
            <h3 className="pay-section-title">{t('camt.werkbank.candidates')}</h3>
            {bills.length === 0 ? (
              <EmptyState title={t('camt.werkbank.empty')} />
            ) : (
              <table className="pay-cand-table">
                <thead>
                  <tr>
                    <th scope="col">{t('camt.dialog.pickBill')}</th>
                    <th scope="col" className="qr-num">
                      {t('payment.openAmount')}
                    </th>
                    <th scope="col" className="qr-num">
                      {t('camt.werkbank.allocate')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {bills.map((b) => (
                    <tr key={b.vendorBillId} className="pay-cand-row">
                      <td className="pay-cand-doc">
                        <Link to={`/bills?bill=${b.vendorBillId}`} className="pay-link">
                          {b.vendorReference ?? b.vendorBillId}
                        </Link>
                        <span className="qr-dim"> {b.vendorName ?? ''}</span>
                      </td>
                      <td className="qr-num t-money">{formatMoney(b.openMinor, b.currency)}</td>
                      <td className="qr-num pay-cand-amount">
                        <input className="field"
                          inputMode="decimal"
                          aria-label={`${t('camt.werkbank.allocate')} ${b.vendorReference ?? b.vendorBillId}`}
                          value={amounts[b.vendorBillId] ?? ''}
                          onChange={(e) => setAmounts((prev) => ({ ...prev, [b.vendorBillId]: e.target.value }))}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <aside className={`pay-wb-right${loading ? ' pay-wb-right--stale' : ''}`}>
            {note !== null && (
              <p className="qr__note" role="status">
                {note}
              </p>
            )}
            <PostingPreview preview={preview} loading={loading} ledgerAccountId={ledgerAccountId} targetLabel={null} />

            <div className="pay-remainder">
              <span className="pay-remainder-text">
                {remainderMinor === 0
                  ? t('camt.werkbank.restDone')
                  : remainderMinor > 0
                    ? t('camt.werkbank.restOpen', { amount: formatMoney(remainderMinor, currency) })
                    : t('camt.werkbank.over', { amount: formatMoney(Math.abs(remainderMinor), currency) })}
              </span>
              <div className="pay-remainder-actions">
                <button type="button" className="btn btn--secondary" onClick={onClose}>
                  {t('qrmatch.close')}
                </button>
                <button type="button" className="btn btn--primary" onClick={() => void book()} disabled={!canBook}>
                  {t('camt.werkbank.book')}
                </button>
              </div>
            </div>
          </aside>
        </div>
      </div>
    </>
  );
}

interface AccountOption {
  id: string;
  number: string;
  name: string;
}

function CreateEntryDialog({
  workspaceId,
  bankTxnId,
  row,
  ledgerAccountId,
  onClose,
  onDone,
}: {
  workspaceId: string;
  bankTxnId: string;
  /** The statement line being booked, for the posting preview (F-03, J3.3). Null when unknown. */
  row: CamtTxnRowView | null;
  /** The ledger account behind the line's bank account, the bank leg of the preview. */
  ledgerAccountId: string | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const t = useT();
  const client = useClient();
  const [accounts, setAccounts] = useState<AccountOption[] | null>(null);
  const [contraAccountId, setContraAccountId] = useState('');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const key = useIdempotencyKey([bankTxnId, 'create-entry', contraAccountId]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const response = await client.call('list_accounts', { workspaceId });
      if (cancelled) return;
      if (isErr(response.body) || !Array.isArray(response.body['accounts'])) {
        setAccounts([]);
        return;
      }
      const rows = (response.body['accounts'] as { id?: unknown; number?: unknown; name?: unknown; archived?: unknown }[])
        .filter((a) => a.archived !== true)
        .map((a) => ({ id: String(a.id ?? ''), number: String(a.number ?? ''), name: String(a.name ?? '') }))
        .filter((a) => a.id.length > 0);
      setAccounts(rows);
    })();
    return () => {
      cancelled = true;
    };
  }, [client, workspaceId]);

  const submit = async () => {
    if (contraAccountId.length === 0) return;
    setSaving(true);
    setNote(null);
    const response = await client.call('create_entry_for_txn', {
      workspaceId,
      bankTxnId,
      contraAccountId,
      ...(description.trim().length > 0 ? { description: description.trim() } : {}),
      idempotencyKey: key,
    });
    setSaving(false);
    if (isErr(response.body)) {
      setNote(response.body.error === 'currency_mismatch' ? t('camt.error.currencyMismatch') : t('camt.error.createEntry'));
      return;
    }
    onDone();
  };

  return (
    <Modal
      open
      title={t('camt.createEntry')}
      onClose={onClose}
      closeLabel={t('qrmatch.close')}
      footer={
        <>
          <button type="button" className="btn btn--secondary" disabled={contraAccountId.length === 0 || saving} onClick={() => void submit()}>
            {t('camt.dialog.book')}
          </button>
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            {t('qrmatch.close')}
          </button>
        </>
      }
    >
      {note !== null && (
        <p className="qr__note" role="status">
          {note}
        </p>
      )}
      {accounts === null ? (
        <Skeleton rows={2} height={24} />
      ) : (
        <label className="qr-dialog__pick" htmlFor="camt-contra">
          {t('camt.dialog.pickContra')}
          {/* F-03 (J3.7 / J3.3): typeable by number ("6900", Enter), one act instead of a two-click select. */}
          <AccountCombobox
            id="camt-contra"
            ariaLabel={t('camt.dialog.pickContra')}
            accounts={accounts}
            value={contraAccountId}
            onChange={setContraAccountId}
            placeholder={t('camt.dialog.contraPlaceholder')}
            noMatchLabel={t('camt.dialog.noAccountMatch')}
          />
        </label>
      )}
      <label className="qr-dialog__pick">
        {t('camt.dialog.description')}
        <input className="field" value={description} onChange={(e) => setDescription(e.target.value)} />
      </label>
      {/* F-03 (J3.3): the Buchungsvorschau the story asks for. Two legs, the line's own amount, the
          bank leg on the account's ledger link and the contra leg on the chosen account; a debit
          credits the bank, a credit debits it. Nothing is computed: the figure is the row's. */}
      {row !== null && contraAccountId !== '' && accounts !== null && (
        <CreateEntryPreview row={row} ledgerAccountId={ledgerAccountId} contraAccountId={contraAccountId} accounts={accounts} />
      )}
    </Modal>
  );
}

/**
 * F-03 (J3.3): the posting preview for a fee-style booking. The legs mirror `create_entry_for_txn`:
 * a DBIT line credits the bank account and debits the contra account; a CRDT line the reverse.
 */
function CreateEntryPreview({
  row,
  ledgerAccountId,
  contraAccountId,
  accounts,
}: {
  row: CamtTxnRowView;
  ledgerAccountId: string | null;
  contraAccountId: string;
  accounts: readonly AccountOption[];
}) {
  const t = useT();
  const label = (id: string | null): string => {
    if (id === null) return t('camt.preview.bankUnlinked');
    const a = accounts.find((x) => x.id === id);
    return a === undefined ? id : `${a.number} ${a.name}`;
  };
  const bank = label(ledgerAccountId);
  const contra = label(contraAccountId);
  const amount = formatMoney(row.amountMinor, row.currency);
  const debitLeg = row.creditDebit === 'DBIT' ? contra : bank;
  const creditLeg = row.creditDebit === 'DBIT' ? bank : contra;
  return (
    <div className="camt-preview" aria-label={t('camt.preview.title')}>
      <h3 className="camt-preview-title">{t('camt.preview.title')}</h3>
      <table className="camt-preview-legs">
        <tbody>
          <tr>
            <td>{debitLeg}</td>
            <td className="qr-num t-money">{`${t('camt.preview.soll')} ${amount}`}</td>
            <td className="qr-num" />
          </tr>
          <tr>
            <td>{creditLeg}</td>
            <td className="qr-num" />
            <td className="qr-num t-money">{`${t('camt.preview.haben')} ${amount}`}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

/**
 * F-03 (J3.3): the imported statements, each with its open-line count, opening the board below.
 * A row is the door; the empty state names the import as the first act.
 */
function StatementList({
  statements,
  bankAccounts,
  openId,
  canImport,
  onOpen,
  onImport,
}: {
  /** Null while the read is in flight (a skeleton), else every imported statement. */
  statements: readonly BankStatementSummaryView[] | null;
  bankAccounts: readonly BankAccountOption[];
  openId: string | null;
  canImport: boolean;
  onOpen: (statementId: string) => void;
  onImport: () => void;
}) {
  const t = useT();
  const accountName = (id: string): string => bankAccounts.find((a) => a.id === id)?.name ?? id;
  const columns: DataTableColumn<BankStatementSummaryView>[] = [
    {
      key: 'period',
      header: t('camt.statements.col.period'),
      render: (s) =>
        s.fromDate !== null && s.toDate !== null
          ? `${formatDate(s.fromDate)} bis ${formatDate(s.toDate)}`.replace(' bis ', ` ${t('camt.statements.until')} `)
          : s.toDate !== null
            ? formatDate(s.toDate)
            : formatDate(s.importedAt.slice(0, 10)),
    },
    {
      key: 'account',
      header: t('camt.statements.col.account'),
      render: (s) => (
        <>
          {accountName(s.bankAccountId)}
          <span className="qr-payer">{s.bankStatementId}</span>
        </>
      ),
    },
    {
      key: 'lines',
      header: t('camt.statements.col.lines'),
      numeric: true,
      render: (s) => s.txnCount,
    },
    {
      key: 'open',
      header: t('camt.statements.col.open'),
      render: (s) => (
        <span className="qr-state">
          <CamtStateGlyph status={s.openCount === 0 ? 'matched' : 'unmatched'} />
          {s.openCount === 0 ? t('camt.statements.allMatched') : t('camt.statements.openCount', { n: s.openCount })}
        </span>
      ),
    },
    {
      key: 'actions',
      header: t('camt.statements.open'),
      headerHidden: true,
      align: 'end',
      render: (s) => (
        <button
          type="button"
          className="btn btn--secondary btn--sm"
          aria-label={t('camt.statements.openNamed', { id: s.bankStatementId })}
          onClick={(e) => {
            e.stopPropagation();
            onOpen(s.statementId);
          }}
        >
          {t('camt.statements.open')}
        </button>
      ),
    },
  ];
  return (
    <section className="qr-board panel" aria-labelledby="camt-statements-title">
      <header className="qr__head">
        <h2 id="camt-statements-title">{t('camt.statements.title')}</h2>
      </header>
      {statements === null ? (
        <Skeleton rows={2} height={40} />
      ) : statements.length === 0 ? (
        <EmptyState
          title={t('camt.statements.empty')}
          hint={t('camt.statements.emptyHint')}
          {...(canImport ? { action: { label: t('camt.import'), onClick: onImport } } : {})}
        />
      ) : (
        <DataTable<BankStatementSummaryView>
          caption={t('camt.statements.title')}
          columns={columns}
          rows={[...statements]}
          rowKey={(s) => s.statementId}
          onRowClick={(s) => onOpen(s.statementId)}
          rowLabel={(s) => `${s.bankStatementId}, ${t('camt.statements.openCount', { n: s.openCount })}`}
          isRowCurrent={(s) => s.statementId === openId}
        />
      )}
    </section>
  );
}

export default Reconciliation;
