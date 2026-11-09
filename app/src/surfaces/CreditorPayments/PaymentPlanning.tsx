/**
 * A40, Zahlungsplanung: the second tab of `/creditor-payments`.
 *
 * Top to bottom: the question (floor, horizon), the liquidity chart with its table twin, the proposal
 * (Skonto possible, default interest, lowest balance, proof status) and its per-bill table with the
 * reason in words, the draft step into A18 runs (each run can then produce its pain.001 through A18's
 * own verb), and the two inputs the forecast cannot read off the books: Skonto conditions and
 * planned flows.
 *
 * NOTHING HERE COMPUTES MONEY. Every figure is rendered verbatim from `liquidity_forecast` and
 * `liquidity_plan_*`; the only arithmetic is the chart's geometry. The five states: loading (a
 * skeleton the shape of the chart and table), empty (no bank account: a way to add one; no open bill:
 * the forecast still renders and the proposal says there is nothing to schedule), error (banner with
 * the refusal in words, retry), success (the updated state is the confirmation), permission-denied
 * (the padlock; propose and draft disabled without `pay`, the editors without their rights, each with
 * a visible reason).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useClient } from '../../lib/client-context';
import { isErr, type Err } from '../../lib/client';
import { useWorkspaceId } from '../../app/workspace';
import { useT, formatMoney, formatDate } from '../../i18n';
import { DataTable, type DataTableColumn } from '../../components/DataTable';
import { Modal } from '../../components/Modal';
import { Select } from '../../components/Select';
import { Status, type StatusKind } from '../../components/Status';
import { EmptyState, ErrorBanner, PermissionDenied, Skeleton } from '../../components/states';
import { refusalText } from '../../components/states/refusalText';
import { useCan, CAP } from '../../lib/capabilities';
import { LiquidityChart } from './LiquidityChart';
import { asArray, debtorEligible, defaultDebitAccountId, xmlDownloadHref, type DebtorAccountOption } from './model';
import {
  ACCOUNT_UNKNOWN_KINDS,
  PLAN_HORIZONS,
  PLANNED_FLOW_DIRECTIONS,
  PLANNED_FLOW_RECURRENCES,
  bpToPercent,
  excludedReasonKeys,
  minorToInput,
  parseAmountToMinor,
  percentToBp,
  type ConservativeLine,
  type DraftResult,
  type ForecastView,
  type PlanLine,
  type PlanLineReason,
  type PlanView,
  type PlannedFlowView,
  type SkontoTermView,
} from './planning-model';

function newKey(): string {
  return crypto.randomUUID();
}

function reasonKind(reason: PlanLineReason): StatusKind {
  switch (reason) {
    case 'skonto_captured':
      return 'success';
    case 'late_floor':
    case 'deferred_floor':
      return 'warn';
    case 'skonto_forgone_floor':
    case 'skonto_forgone_search_limit':
      return 'pending';
    default:
      return 'neutral';
  }
}

/** The refusal in the tab's own words where it has them, else the shared sentence. */
function useRefusal() {
  const t = useT();
  return useCallback((e: Err) => refusalText(t, e, { own: 'pay.plan.error' }), [t]);
}

export function PaymentPlanning() {
  const t = useT();
  const client = useClient();
  const workspaceId = useWorkspaceId();
  const refusal = useRefusal();

  const canPay = useCan(CAP.pay);
  const canSkonto = useCan(CAP.manageMasterData);
  const canFlows = useCan(CAP.manageSettings);

  const [horizon, setHorizon] = useState<number>(90);
  const [floorText, setFloorText] = useState('');
  const [forecast, setForecast] = useState<ForecastView | null>(null);
  const [accounts, setAccounts] = useState<DebtorAccountOption[]>([]);
  const [terms, setTerms] = useState<SkontoTermView[]>([]);
  const [flows, setFlows] = useState<PlannedFlowView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Err | null>(null);
  const [denied, setDenied] = useState(false);

  const [plan, setPlan] = useState<PlanView | null>(null);
  const [proposing, setProposing] = useState(false);
  const [proposeError, setProposeError] = useState<Err | null>(null);

  // The ONE account the plan is solved on and the runs debit (critic M4): the floor is that account's
  // floor, never a pooled balance. Held in a ref for the loaders and in state for the picker.
  const [debitAccount, setDebitAccount] = useState('');
  const accountRef = useRef('');
  const [drafting, setDrafting] = useState(false);
  const [draftError, setDraftError] = useState<Err | null>(null);
  const [downloads, setDownloads] = useState<Record<string, { filename: string; base64: string }>>({});
  const [generatingId, setGeneratingId] = useState<string | null>(null);
  const [generateError, setGenerateError] = useState<Err | null>(null);

  const [skontoFor, setSkontoFor] = useState<PlanLine | null>(null);
  const [skontoScope, setSkontoScope] = useState<'vendor' | 'bill'>('vendor');
  const [skontoRate, setSkontoRate] = useState('');
  const [skontoDays, setSkontoDays] = useState('10');
  const [skontoUntil, setSkontoUntil] = useState('');
  const [savingSkonto, setSavingSkonto] = useState(false);
  const [skontoError, setSkontoError] = useState<Err | null>(null);

  const [flowOpen, setFlowOpen] = useState(false);
  const [flowLabel, setFlowLabel] = useState('');
  const [flowDirection, setFlowDirection] = useState<string>('out');
  const [flowAmount, setFlowAmount] = useState('');
  const [flowFirst, setFlowFirst] = useState('');
  const [flowRecurrence, setFlowRecurrence] = useState<string>('monthly');
  // The account a planned flow moves (critic R2-M2): '' names none, so a forecast on one account
  // counts it there and says so. Opens on the debit account, visibly, and can be changed.
  const [flowAccount, setFlowAccount] = useState('');
  const [savingFlow, setSavingFlow] = useState(false);
  const [flowError, setFlowError] = useState<Err | null>(null);

  const floorMinor = parseAmountToMinor(floorText);
  // A fresh key per press, never one keyed on the question: the answer depends on the BOOKS as well
  // (a Skonto term, a new bill), so a key reused across a change would replay the old proposal, and the
  // "Neu berechnen" after a stale refusal would loop. The engine is idempotent on rows by the inputs
  // hash, so a double press still lands on one proposal.

  const load = useCallback(
    async (planId?: string) => {
      if (workspaceId === null) return;
      setLoading(true);
      setError(null);
      setDenied(false);
      const acc = await client.call('list_bank_accounts', { workspaceId });
      const list = isErr(acc.body) ? [] : asArray<DebtorAccountOption>(acc.body.bankAccounts);
      setAccounts(list);
      const eligible = list.filter(debtorEligible);
      let chosen = accountRef.current;
      if (!eligible.some((a) => a.id === chosen)) {
        chosen = defaultDebitAccountId(eligible, 'CHF') || (eligible[0]?.id ?? '');
        accountRef.current = chosen;
        setDebitAccount(chosen);
      }
      const account = eligible.find((a) => a.id === chosen);
      const [fc, sk, fl] = await Promise.all([
        client.call('liquidity_forecast', {
          workspaceId,
          horizonDays: horizon,
          ...(account !== undefined ? { bankAccountIds: [account.id], ...(account.currency ? { currency: account.currency } : {}) } : {}),
          ...(planId !== undefined ? { planId } : {}),
        }),
        client.call('liquidity_skonto_list', { workspaceId }),
        client.call('liquidity_flow_list', { workspaceId }),
      ]);
      if (isErr(fc.body)) {
        if (fc.body.error === 'permission_denied' || fc.status === 403) setDenied(true);
        else if (fc.body.error !== 'needs_bank_account') setError(fc.body);
        setForecast(null);
      } else {
        setForecast(fc.body as unknown as ForecastView);
      }
      if (!isErr(sk.body)) setTerms(asArray<SkontoTermView>(sk.body.terms));
      if (!isErr(fl.body)) setFlows(asArray<PlannedFlowView>(fl.body.flows));
      setLoading(false);
    },
    [client, workspaceId, horizon],
  );

  useEffect(() => {
    // A new horizon is a new question: the previous proposal no longer answers it.
    setPlan(null);
    void load();
  }, [load]);

  const currency = forecast?.currency ?? 'CHF';

  const propose = useCallback(async (opts: { floorMinor?: number; acceptLatePayments?: boolean } = {}) => {
    const floor = opts.floorMinor ?? floorMinor;
    if (workspaceId === null || floor === null) return;
    setProposing(true);
    setProposeError(null);
    setDraftError(null);
    const res = await client.call('liquidity_plan_propose', {
      workspaceId,
      floorMinor: floor,
      horizonDays: horizon,
      ...(accountRef.current !== '' ? { bankAccountIds: [accountRef.current], currency } : {}),
      ...(opts.acceptLatePayments === true ? { acceptLatePayments: true } : {}),
      idempotencyKey: newKey(),
    });
    setProposing(false);
    if (isErr(res.body)) {
      setProposeError(res.body);
      return;
    }
    const next = res.body.plan as unknown as PlanView;
    setPlan(next);
    void load(next.id);
  }, [client, workspaceId, floorMinor, horizon, currency, load]);

  const draft = useCallback(async () => {
    if (workspaceId === null || plan === null || accountRef.current === '') return;
    setDrafting(true);
    setDraftError(null);
    const res = await client.call('liquidity_plan_draft_batches', {
      workspaceId,
      planId: plan.id,
      bankAccountId: accountRef.current,
      idempotencyKey: newKey(),
    });
    setDrafting(false);
    if (isErr(res.body)) {
      setDraftError(res.body);
      return;
    }
    setPlan(res.body.plan as unknown as PlanView);
  }, [client, workspaceId, plan]);

  const generate = useCallback(
    async (batchId: string) => {
      if (workspaceId === null) return;
      setGeneratingId(batchId);
      setGenerateError(null);
      const res = await client.call('generate_pain001', { workspaceId, batchId, idempotencyKey: newKey() });
      setGeneratingId(null);
      if (isErr(res.body)) {
        setGenerateError(res.body);
        return;
      }
      setDownloads((prev) => ({
        ...prev,
        [batchId]: { filename: res.body.filename as string, base64: res.body.xmlBase64 as string },
      }));
    },
    [client, workspaceId],
  );

  const openSkonto = useCallback((line: PlanLine) => {
    setSkontoFor(line);
    setSkontoScope('vendor');
    setSkontoRate('');
    setSkontoDays('10');
    setSkontoUntil(line.detail.dueDate ?? '');
    setSkontoError(null);
  }, []);

  const saveSkonto = useCallback(async () => {
    if (workspaceId === null || skontoFor === null) return;
    const rateBp = percentToBp(skontoRate);
    if (rateBp === null) return;
    setSavingSkonto(true);
    setSkontoError(null);
    const input =
      skontoScope === 'vendor'
        ? { vendorId: skontoFor.vendorId ?? '', rateBp, days: Number(skontoDays) }
        : { vendorBillId: skontoFor.vendorBillId, rateBp, untilDate: skontoUntil };
    const res = await client.call('liquidity_skonto_set', { workspaceId, ...input, idempotencyKey: newKey() });
    setSavingSkonto(false);
    if (isErr(res.body)) {
      setSkontoError(res.body);
      return;
    }
    setSkontoFor(null);
    // The terms changed the question: the proposal must be recomputed on them.
    setPlan(null);
    void load();
  }, [client, workspaceId, skontoFor, skontoScope, skontoRate, skontoDays, skontoUntil, load]);

  const saveFlow = useCallback(async () => {
    if (workspaceId === null) return;
    const amountMinor = parseAmountToMinor(flowAmount);
    if (amountMinor === null || amountMinor <= 0 || flowLabel.trim() === '' || flowFirst === '') return;
    setSavingFlow(true);
    setFlowError(null);
    const res = await client.call('liquidity_flow_set', {
      workspaceId,
      label: flowLabel.trim(),
      direction: flowDirection,
      amountMinor,
      currency,
      firstDate: flowFirst,
      recurrence: flowRecurrence,
      ...(flowAccount !== '' ? { bankAccountId: flowAccount } : {}),
      idempotencyKey: newKey(),
    });
    setSavingFlow(false);
    if (isErr(res.body)) {
      setFlowError(res.body);
      return;
    }
    setFlowOpen(false);
    setPlan(null);
    void load();
  }, [client, workspaceId, flowLabel, flowDirection, flowAmount, flowFirst, flowRecurrence, flowAccount, currency, load]);

  const retireFlow = useCallback(
    async (f: PlannedFlowView) => {
      if (workspaceId === null) return;
      const res = await client.call('liquidity_flow_set', {
        workspaceId,
        flowId: f.id,
        label: f.label,
        direction: f.direction,
        amountMinor: f.amountMinor,
        currency: f.currency,
        firstDate: f.firstDate,
        recurrence: f.recurrence,
        ...(f.endDate !== null ? { endDate: f.endDate } : {}),
        ...(typeof f.bankAccountId === 'string' ? { bankAccountId: f.bankAccountId } : {}),
        active: false,
        idempotencyKey: newKey(),
      });
      if (isErr(res.body)) {
        setFlowError(res.body);
        return;
      }
      setPlan(null);
      void load();
    },
    [client, workspaceId, load],
  );

  const columns: DataTableColumn<PlanLine>[] = useMemo(
    () => [
      { key: 'vendor', header: t('pay.plan.column.vendor'), render: (l) => l.vendorName ?? l.vendorReference ?? '' },
      {
        key: 'due',
        header: t('pay.plan.column.due'),
        render: (l) => (l.detail.dueDate ? formatDate(l.detail.dueDate) : ''),
      },
      {
        key: 'skonto',
        header: t('pay.plan.column.skonto'),
        render: (l) =>
          l.detail.skontoRateBp && l.detail.skontoRateBp > 0 && l.detail.skontoUntil ? (
            t('pay.plan.skontoUntil', { rate: bpToPercent(l.detail.skontoRateBp), date: formatDate(l.detail.skontoUntil) })
          ) : (
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              disabled={!canSkonto}
              aria-describedby={canSkonto ? undefined : 'pay-plan-skonto-denied'}
              onClick={() => openSkonto(l)}
            >
              {t('pay.plan.addSkonto')}
            </button>
          ),
      },
      {
        key: 'date',
        header: t('pay.plan.column.payDate'),
        render: (l) => (l.payDate !== null ? formatDate(l.payDate) : t('pay.plan.notInHorizon')),
      },
      {
        key: 'amount',
        header: t('pay.plan.column.amount'),
        numeric: true,
        render: (l) => formatMoney(l.action === 'pay' ? l.cashMinor : l.openMinor, currency),
      },
      {
        key: 'reason',
        header: t('pay.plan.column.reason'),
        render: (l) => (
          <Status
            kind={reasonKind(l.reason)}
            label={t(l.reason === 'late_floor' && l.daysLate === 1 ? 'pay.plan.reason.late_floor_one' : `pay.plan.reason.${l.reason}`, {
              skonto: formatMoney(l.skontoMinor, currency),
              interest: formatMoney(l.interestMinor, currency),
              days: l.daysLate,
            })}
          />
        ),
      },
    ],
    [t, currency, canSkonto, openSkonto],
  );

  if (workspaceId === null) return null;
  if (denied) return <PermissionDenied body={t('pay.plan.denied')} />;

  if (loading && forecast === null) {
    return (
      <div className="pay-plan" aria-busy="true">
        <Skeleton rows={1} height={200} />
        <Skeleton rows={4} />
      </div>
    );
  }

  if (forecast === null && error === null) {
    return (
      <EmptyState
        title={t('pay.plan.empty.noBank')}
        hint={t('pay.plan.empty.noBankHint')}
        action={{ label: t('pay.plan.empty.toBankAccounts'), to: '/bank-accounts' }}
      />
    );
  }

  const dayText = (n: number): string => (n === 1 ? t('pay.plan.dayCount.one') : t('pay.plan.dayCount.other', { n }));
  const eligible = accounts.filter((a) => debtorEligible(a));
  const accountName = eligible.find((a) => a.id === debitAccount)?.name ?? '';
  // Any open account in the plan's currency can receive or pay a planned flow (a QR-IBAN one too).
  const flowAccounts = accounts.filter((a) => !a.archived && (a.currency === undefined || a.currency === currency));
  const unknown = forecast?.assumptions?.accountUnknown;
  const unknownKinds = ACCOUNT_UNKNOWN_KINDS.filter((k) => unknown?.kinds.includes(k) === true);
  const draft_: DraftResult | null = plan?.draft ?? null;
  const payLines = plan?.lines.filter((l) => l.action === 'pay').length ?? 0;

  return (
    <div className="pay-plan">
      {error !== null && <ErrorBanner error={error} context="read" onRetry={() => void load(plan?.id)} />}

      <div className="pay-plan-question panel">
        <div className="pay-cp-field">
          <span>{t('pay.debtorAccount')}</span>
          <Select
            value={debitAccount}
            onChange={(v) => {
              accountRef.current = v;
              setDebitAccount(v);
              setPlan(null);
              void load();
            }}
            disabled={eligible.length === 0}
            options={eligible.map((a) => ({ value: a.id, label: a.name }))}
            ariaLabel={t('pay.debtorAccount')}
          />
        </div>
        <label className="pay-cp-field">
          <span>{t('pay.plan.floor', { currency })}</span>
          <input
            type="text"
            className="field"
            inputMode="decimal"
            value={floorText}
            placeholder="20000"
            onChange={(e) => setFloorText(e.target.value)}
          />
        </label>
        <div className="pay-cp-field">
          <span>{t('pay.plan.horizon')}</span>
          <Select
            value={String(horizon)}
            onChange={(v) => setHorizon(Number(v))}
            options={PLAN_HORIZONS.map((h) => ({ value: String(h), label: t('pay.plan.horizonDays', { days: h }) }))}
            ariaLabel={t('pay.plan.horizon')}
          />
        </div>
        <button
          type="button"
          className={plan === null ? 'btn btn--primary' : 'btn btn--secondary'}
          disabled={!canPay || proposing || floorMinor === null}
          aria-describedby={canPay ? undefined : 'pay-plan-pay-denied'}
          onClick={() => void propose()}
        >
          {proposing ? t('pay.plan.proposing') : t('pay.plan.propose')}
        </button>
      </div>
      {!canPay && (
        <p id="pay-plan-pay-denied" className="pay-cp-denied-note" role="note">
          {t('pay.needsCapability')}
        </p>
      )}
      {proposeError !== null && proposeError.error === 'floor_breached_by_schedule' ? (
        // THE OWNER DECISION of 30.09.2026 (critic M8): the plan stops and the person chooses. The
        // suggested floor is the low of the ON-TIME schedule (critic R2-H1), so the lower action can
        // promise on-time payment and the re-proposal keeps it. When even an empty floor overdraws the
        // account the engine suggests none (`suggestedFloorMinor: null`), and the only way on is consent.
        <div className="pay-plan-breach panel" role="alert">
          {typeof proposeError.suggestedFloorMinor === 'number' ? (
            <>
              <p className="pay-plan-breach-text">
                {t('pay.plan.floorBreach.message', {
                  date: formatDate(String(proposeError.date ?? '')),
                  shortfall: formatMoney(Number(proposeError.shortfallMinor ?? 0), currency),
                  suggested: formatMoney(proposeError.suggestedFloorMinor, currency),
                })}
              </p>
              <p className="pay-plan-breach-note">
                {t('pay.plan.floorBreach.lowerPromise', { suggested: formatMoney(proposeError.suggestedFloorMinor, currency) })}
              </p>
            </>
          ) : (
            <p className="pay-plan-breach-text">
              {proposeError.scheduleAloneOverdraws !== null && typeof proposeError.scheduleAloneOverdraws === 'object'
                ? t('pay.plan.floorBreach.overdrawsBySchedule', {
                    date: formatDate(String((proposeError.scheduleAloneOverdraws as { date?: unknown }).date ?? '')),
                    balance: formatMoney(Number((proposeError.scheduleAloneOverdraws as { balanceMinor?: unknown }).balanceMinor ?? 0), currency),
                  })
                : t(proposeError.noLateSearch === 'not_found' ? 'pay.plan.floorBreach.overdrawsNotFound' : 'pay.plan.floorBreach.overdraws', {
                    date: formatDate(String(proposeError.date ?? '')),
                    balance: formatMoney(Number(proposeError.balanceMinor ?? 0), currency),
                  })}
            </p>
          )}
          <div className="pay-plan-breach-actions">
            {typeof proposeError.suggestedFloorMinor === 'number' && (
              <button
                type="button"
                className="btn btn--secondary"
                disabled={!canPay || proposing}
                onClick={() => {
                  const suggested = Number(proposeError.suggestedFloorMinor);
                  setFloorText(minorToInput(suggested));
                  void propose({ floorMinor: suggested });
                }}
              >
                {t('pay.plan.floorBreach.lower', { suggested: formatMoney(proposeError.suggestedFloorMinor, currency) })}
              </button>
            )}
            {/* When the scheduled flows alone overdraw, no payment date helps: no "accept the late payments" offer. */}
            {!(typeof proposeError.scheduleAloneOverdraws === 'object' && proposeError.scheduleAloneOverdraws !== null) && (
              <button
                type="button"
                className="btn btn--ghost"
                disabled={!canPay || proposing}
                onClick={() => void propose({ acceptLatePayments: true })}
              >
                {t('pay.plan.floorBreach.accept')}
              </button>
            )}
          </div>
        </div>
      ) : (
        proposeError !== null && <ErrorBanner error={proposeError} message={refusal(proposeError)} />
      )}

      {forecast !== null && forecast.days !== undefined && (
        <LiquidityChart
          days={forecast.days}
          currency={currency}
          floorMinor={plan?.floorMinor ?? floorMinor}
          lowest={forecast.lowestWithPlan ?? forecast.lowest}
        />
      )}
      {forecast !== null && (forecast.conservative ?? []).length > 0 && plan === null && (
        <ConservativeNotes lines={forecast.conservative ?? []} currency={currency} />
      )}
      {forecast !== null && forecast.excluded.length > 0 && (
        <p className="pay-plan-note">
          {t('pay.plan.excluded', {
            n: forecast.excluded.length,
            reasons: excludedReasonKeys(forecast.excluded)
              .map((k) => t(`pay.plan.excludedReason.${k}`))
              .join(', '),
          })}
        </p>
      )}

      {forecast !== null && (
        // M9: the assumptions that can break the floor in reality, briefly and with their sums.
        <section className="pay-plan-assumptions" aria-labelledby="pay-plan-assumptions-title">
          <h4 id="pay-plan-assumptions-title" className="pay-plan-subtitle">
            {t('pay.plan.assumptions.title')}
          </h4>
          <ul className="pay-plan-assumption-list">
            {(forecast.assumptions?.noHistory?.count ?? 0) > 0 && (
              <li>
                {t('pay.plan.assumptions.noHistory', {
                  n: forecast.assumptions?.noHistory?.count ?? 0,
                  amount: formatMoney(forecast.assumptions?.noHistory?.amountMinor ?? 0, currency),
                })}
              </li>
            )}
            {(forecast.assumptions?.pooledHistory?.count ?? 0) > 0 && (
              <li>
                {t('pay.plan.assumptions.pooled', {
                  n: forecast.assumptions?.pooledHistory?.count ?? 0,
                  amount: formatMoney(forecast.assumptions?.pooledHistory?.amountMinor ?? 0, currency),
                })}
              </li>
            )}
            <li>{t('pay.plan.assumptions.ledger', { account: accountName })}</li>
            {unknown !== undefined && unknown.count > 0 && (
              <li>
                {t('pay.plan.assumptions.accountUnknown', {
                  n: unknown.count,
                  account: accountName,
                  kinds: unknownKinds.map((k) => t(`pay.plan.accountKind.${k}`)).join(', '),
                  in: formatMoney(unknown.inMinor, currency),
                  out: formatMoney(unknown.outMinor, currency),
                })}
              </li>
            )}
            {(forecast.assumptions?.vatPartial?.count ?? 0) > 0 && <li>{t('pay.plan.assumptions.vat')}</li>}
            <li>{t('pay.plan.assumptions.lastDay')}</li>
          </ul>
        </section>
      )}

      {plan !== null && (
        <section className="pay-plan-result panel" aria-labelledby="pay-plan-result-title">
          <h3 id="pay-plan-result-title" className="pay-plan-title">
            {t('pay.plan.resultTitle')}
          </h3>
          <dl className="pay-plan-figures">
            <div>
              <dt>{t('pay.plan.skontoCaptured')}</dt>
              <dd className="t-money">{formatMoney(plan.skontoCapturedMinor, currency)}</dd>
            </div>
            <div>
              <dt>{t('pay.plan.lateInterest')}</dt>
              <dd className="t-money">{formatMoney(plan.lateInterestMinor, currency)}</dd>
            </div>
            <div>
              <dt>{t('pay.plan.lowest')}</dt>
              <dd className="t-money">
                {t('pay.plan.lowestOn', { amount: formatMoney(plan.minBalanceMinor, currency), date: formatDate(plan.minBalanceDate) })}
              </dd>
            </div>
          </dl>
          <p className="pay-plan-note">
            {plan.optimality === 'proven'
              ? t('pay.plan.optimal')
              : t('pay.plan.heuristic', { gap: formatMoney(plan.gapMinor, currency) })}
          </p>
          {plan.optimality === 'heuristic' && (plan.lateGapDays ?? 0) > 0 && (
            // R2-L4: a heuristic plan states its gap on lateness too, never only on worth.
            <p className="pay-plan-note">
              {(plan.lateDaysLowerBound ?? 0) > 0
                ? t('pay.plan.heuristicLate', {
                    days: dayText(plan.daysLateTotal ?? 0),
                    lower: dayText(plan.lateDaysLowerBound ?? 0),
                  })
                : t('pay.plan.heuristicLateUnproven', { days: dayText(plan.daysLateTotal ?? 0) })}
            </p>
          )}
          {(plan.conservative ?? []).length > 0 && <ConservativeNotes lines={plan.conservative ?? []} currency={currency} />}
          {plan.floorBreachedByBase !== null && (
            <p className="pay-plan-warn" role="note">
              <Status
                kind="warn"
                label={t('pay.plan.baseBreach', {
                  amount: formatMoney(plan.floorBreachedByBase.balanceMinor, currency),
                  date: formatDate(plan.floorBreachedByBase.date),
                })}
              />
            </p>
          )}

          {plan.lines.length === 0 ? (
            <p className="pay-plan-note">{t('pay.plan.nothingToSchedule')}</p>
          ) : (
            <DataTable columns={columns} rows={plan.lines} rowKey={(l) => l.vendorBillId} caption={t('pay.plan.resultTitle')} />
          )}
          {!canSkonto && (
            <p id="pay-plan-skonto-denied" className="pay-cp-denied-note" role="note">
              {t('pay.needsMasterData')}
            </p>
          )}

          {plan.status === 'proposed' && payLines > 0 && (
            <div className="pay-cp-batchbar">
              <p className="pay-plan-note">
                {/* "allein" only when it is true (critic R2-M2): nothing of unknown account is counted on it. */}
                {(unknown?.count ?? 0) > 0
                  ? t('pay.plan.debitsAccountShared', { account: accountName })
                  : t('pay.plan.debitsAccount', { account: accountName })}
              </p>
              <button
                type="button"
                className="btn btn--primary"
                disabled={!canPay || drafting || debitAccount === ''}
                aria-describedby={canPay ? undefined : 'pay-plan-pay-denied'}
                onClick={() => void draft()}
              >
                {drafting ? t('pay.plan.drafting') : t('pay.plan.draft')}
              </button>
            </div>
          )}
          {draftError !== null && (
            <div>
              <ErrorBanner error={draftError} message={refusal(draftError)} />
              {draftError.error === 'stale_plan' && (
                <button type="button" className="btn btn--secondary" onClick={() => void propose()}>
                  {t('pay.plan.repropose')}
                </button>
              )}
            </div>
          )}

          {draft_ !== null && (
            <div className="pay-plan-drafts">
              <p className="pay-plan-note">{t('pay.plan.draftedNote')}</p>
              {draft_.batches.length > 0 && (
                <p className="pay-plan-warn" role="note">
                  {t('pay.plan.uploadBy', {
                    date: formatDate([...draft_.batches].map((b) => b.executionDate).sort()[0] as string),
                  })}
                </p>
              )}
              <ul className="pay-plan-list">
                {draft_.batches.map((b) => (
                  <li key={b.batchId}>
                    <span>
                      {t('pay.plan.batchLine', {
                        n: b.itemCount,
                        total: formatMoney(b.totalMinor, currency),
                        date: formatDate(b.executionDate),
                      })}
                    </span>
                    {downloads[b.batchId] !== undefined ? (
                      <a
                        className="btn btn--secondary btn--sm"
                        href={xmlDownloadHref(downloads[b.batchId]!.base64)}
                        download={downloads[b.batchId]!.filename}
                      >
                        {t('pay.download')}
                      </a>
                    ) : (
                      <button
                        type="button"
                        className="btn btn--secondary btn--sm"
                        disabled={!canPay || generatingId !== null}
                        onClick={() => void generate(b.batchId)}
                      >
                        {generatingId === b.batchId ? t('pay.generating') : t('pay.plan.generate')}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
              {draft_.notDrafted.length > 0 && (
                <>
                  <p className="pay-plan-note">{t('pay.plan.notDraftedTitle')}</p>
                  <ul className="pay-plan-list">
                    {draft_.notDrafted.map((n) => {
                      const line = plan.lines.find((l) => l.vendorBillId === n.vendorBillId);
                      return (
                        <li key={n.vendorBillId}>
                          <span>{line?.vendorName ?? n.vendorBillId}</span>
                          <span className="pay-cp-hint">
                            {t(`pay.plan.notDrafted.${n.reason}`, {
                              amount: formatMoney(line?.skontoMinor ?? 0, currency),
                              date: line?.detail.skontoUntil ? formatDate(line.detail.skontoUntil) : '',
                            })}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </>
              )}
              {generateError !== null && <ErrorBanner error={generateError} />}
              <p className="pay-cp-transmit-note">{t('pay.transmitNote.manual')}</p>
            </div>
          )}
        </section>
      )}

      <section className="pay-plan-inputs panel" aria-labelledby="pay-plan-inputs-title">
        <h3 id="pay-plan-inputs-title" className="pay-plan-title">
          {t('pay.plan.inputsTitle')}
        </h3>
        <h4 className="pay-plan-subtitle">{t('pay.plan.skontoTitle')}</h4>
        {terms.length === 0 ? (
          <p className="pay-plan-note">{t('pay.plan.noSkonto')}</p>
        ) : (
          <ul className="pay-plan-list">
            {terms.map((term) => (
              <li key={term.id}>
                <span>{term.name ?? ''}</span>
                <span>
                  {term.rateBp === 0
                    ? t('pay.plan.skontoNone')
                    : term.scope === 'vendor'
                      ? t('pay.plan.skontoVendor', { rate: bpToPercent(term.rateBp), days: term.days ?? 0 })
                      : t('pay.plan.skontoUntil', { rate: bpToPercent(term.rateBp), date: formatDate(term.untilDate ?? '') })}
                </span>
              </li>
            ))}
          </ul>
        )}

        <h4 className="pay-plan-subtitle">{t('pay.plan.flowsTitle')}</h4>
        {flows.length === 0 ? (
          <p className="pay-plan-note">{t('pay.plan.noFlows')}</p>
        ) : (
          <ul className="pay-plan-list">
            {flows.map((f) => (
              <li key={f.id}>
                <span>{f.label}</span>
                <span className="t-money">
                  {formatMoney(f.direction === 'in' ? f.amountMinor : -f.amountMinor, f.currency)}
                </span>
                <span>{t(`pay.plan.recurrence.${f.recurrence}`, { date: formatDate(f.firstDate) })}</span>
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  disabled={!canFlows}
                  aria-label={t('pay.plan.retireFlowNamed', { label: f.label })}
                  onClick={() => void retireFlow(f)}
                >
                  {t('pay.plan.retireFlow')}
                </button>
              </li>
            ))}
          </ul>
        )}
        <button
          type="button"
          className="btn btn--ghost"
          disabled={!canFlows}
          aria-describedby={canFlows ? undefined : 'pay-plan-flows-denied'}
          onClick={() => {
            // A fresh form each time: a second flow never starts from the first one's words and figures.
            setFlowLabel('');
            setFlowAmount('');
            setFlowFirst('');
            setFlowAccount(debitAccount);
            setFlowOpen(true);
            setFlowError(null);
          }}
        >
          {t('pay.plan.addFlow')}
        </button>
        {!canFlows && (
          <p id="pay-plan-flows-denied" className="pay-cp-denied-note" role="note">
            {t('pay.plan.needsSettings')}
          </p>
        )}
        {flowError !== null && !flowOpen && <ErrorBanner error={flowError} message={refusal(flowError)} />}
      </section>

      <Modal
        open={skontoFor !== null}
        onClose={() => setSkontoFor(null)}
        title={t('pay.plan.skontoDialogTitle', { vendor: skontoFor?.vendorName ?? '' })}
        closeLabel={t('pay.profile.close')}
        footer={
          <>
            <button type="button" className="btn btn--ghost" onClick={() => setSkontoFor(null)}>
              {t('pay.cancel')}
            </button>
            <button
              type="button"
              className="btn btn--primary"
              disabled={
                savingSkonto ||
                percentToBp(skontoRate) === null ||
                (skontoScope === 'vendor' ? !/^\d{1,3}$/.test(skontoDays) : skontoUntil === '')
              }
              onClick={() => void saveSkonto()}
            >
              {savingSkonto ? t('pay.profile.saving') : t('pay.profile.save')}
            </button>
          </>
        }
      >
        <div className="pay-cp-field">
          <span>{t('pay.plan.skontoScope')}</span>
          <Select
            value={skontoScope}
            onChange={(v) => setSkontoScope(v === 'bill' ? 'bill' : 'vendor')}
            options={[
              { value: 'vendor', label: t('pay.plan.skontoScopeVendor') },
              { value: 'bill', label: t('pay.plan.skontoScopeBill') },
            ]}
            ariaLabel={t('pay.plan.skontoScope')}
          />
        </div>
        <label className="pay-cp-field">
          <span>{t('pay.plan.skontoRate')}</span>
          <input type="text" className="field" inputMode="decimal" value={skontoRate} placeholder="2" onChange={(e) => setSkontoRate(e.target.value)} />
        </label>
        {skontoScope === 'vendor' ? (
          <label className="pay-cp-field">
            <span>{t('pay.plan.skontoDays')}</span>
            <input type="text" className="field" inputMode="numeric" value={skontoDays} onChange={(e) => setSkontoDays(e.target.value)} />
          </label>
        ) : (
          <label className="pay-cp-field">
            <span>{t('pay.plan.skontoUntilLabel')}</span>
            <input type="date" className="field" value={skontoUntil} onChange={(e) => setSkontoUntil(e.target.value)} />
          </label>
        )}
        {skontoError !== null && <ErrorBanner error={skontoError} message={refusal(skontoError)} />}
      </Modal>

      <Modal
        open={flowOpen}
        onClose={() => setFlowOpen(false)}
        title={t('pay.plan.flowDialogTitle')}
        closeLabel={t('pay.profile.close')}
        footer={
          <>
            <button type="button" className="btn btn--ghost" onClick={() => setFlowOpen(false)}>
              {t('pay.cancel')}
            </button>
            <button
              type="button"
              className="btn btn--primary"
              disabled={savingFlow || flowLabel.trim() === '' || flowFirst === '' || (parseAmountToMinor(flowAmount) ?? 0) <= 0}
              onClick={() => void saveFlow()}
            >
              {savingFlow ? t('pay.profile.saving') : t('pay.profile.save')}
            </button>
          </>
        }
      >
        <label className="pay-cp-field">
          <span>{t('pay.plan.flowLabel')}</span>
          <input type="text" className="field" value={flowLabel} onChange={(e) => setFlowLabel(e.target.value)} />
        </label>
        <div className="pay-cp-field">
          <span>{t('pay.plan.flowDirection')}</span>
          <Select
            value={flowDirection}
            onChange={setFlowDirection}
            options={PLANNED_FLOW_DIRECTIONS.map((d) => ({ value: d, label: t(`pay.plan.direction.${d}`) }))}
            ariaLabel={t('pay.plan.flowDirection')}
          />
        </div>
        <label className="pay-cp-field">
          <span>{t('pay.plan.flowAmount', { currency })}</span>
          <input type="text" className="field" inputMode="decimal" value={flowAmount} onChange={(e) => setFlowAmount(e.target.value)} />
        </label>
        <label className="pay-cp-field">
          <span>{t('pay.plan.flowFirst')}</span>
          <input type="date" className="field" value={flowFirst} onChange={(e) => setFlowFirst(e.target.value)} />
        </label>
        <div className="pay-cp-field">
          <span>{t('pay.plan.flowRecurrence')}</span>
          <Select
            value={flowRecurrence}
            onChange={setFlowRecurrence}
            options={PLANNED_FLOW_RECURRENCES.map((r) => ({ value: r, label: t(`pay.plan.recurrenceName.${r}`) }))}
            ariaLabel={t('pay.plan.flowRecurrence')}
          />
        </div>
        <div className="pay-cp-field">
          <span>{t('pay.plan.flowAccount')}</span>
          <Select
            value={flowAccount}
            onChange={setFlowAccount}
            options={[
              { value: '', label: t('pay.plan.flowAccountNone') },
              ...flowAccounts.map((a) => ({ value: a.id, label: a.name })),
            ]}
            ariaLabel={t('pay.plan.flowAccount')}
          />
        </div>
        {flowError !== null && <ErrorBanner error={flowError} message={refusal(flowError)} />}
      </Modal>
    </div>
  );
}

/**
 * The amounts the forecast debits CONSERVATIVELY (owner decision 01.10.2026, critic R4-M1), each as its
 * own line with its amount, its day and its reason, beside the forecast and beside every proposal.
 */
function ConservativeNotes({ lines, currency }: { lines: readonly ConservativeLine[]; currency: string }) {
  const t = useT();
  return (
    <ul className="pay-plan-assumption-list pay-plan-conservative" role="note" aria-label={t('pay.plan.conservative.title')}>
      {lines.map((l, i) => (
        <li key={`${l.reason}-${l.ref ?? 'none'}-${i}`}>
          <Status
            kind="warn"
            label={
              l.reason === 'vat_return_refused'
                ? t('pay.plan.conservative.vat_return_refused', {
                    period: l.ref ?? '',
                    amount: formatMoney(l.amountMinor, currency),
                    date: formatDate(l.date),
                  })
                : l.reason === 'vat_input_not_settled'
                  ? t('pay.plan.conservative.vat_input_not_settled', {
                      period: l.ref ?? '',
                      amount: formatMoney(l.amountMinor, currency),
                      date: formatDate(l.date),
                    })
                  : t('pay.plan.conservative.vat_unattributed', { amount: formatMoney(l.amountMinor, currency), date: formatDate(l.date) })
            }
          />
        </li>
      ))}
    </ul>
  );
}
