/**
 * G22 Checklisten at `/checklisten` (spec §6, §10.12): the run list (grouped by template, open first,
 * done and abandoned runs as compact groups) and, with `?run=<id>`, the run detail. Five states on
 * both: loading skeleton rows, empty (naming the period kinds, never the literal Quartal), error with
 * retry, success, and the padlock naming the missing right. Writes run through the shared client:
 * the checklist verbs (`checklist_start`, `checklist_item_complete`, `checklist_item_skip`,
 * `checklist_item_reopen`, `checklist_abandon`) behind `manage_checklists`, and since leg 2 the
 * DOMAIN verbs a posting row calls (post_fx_revaluation, accrual_post, provision_post,
 * vat_settlement_post, lock_period, close_month, close_year and their reversals) under their own
 * gates, one after another, stopping on the first refusal so the row reports what posted and what
 * did not (design row 6.7). The detail re-reads after every write so the live derivation (a check
 * that flipped, a probe that found its artefact, a stale sign-off) is what the screen shows.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';

import { useClient } from '../../lib/client-context';
import { isErr } from '../../lib/client';
import { useCan, CAP } from '../../lib/capabilities';
import { useWorkspaceId } from '../../app/workspace';
import { useT, formatDate } from '../../i18n';
import { EmptyState, ErrorBanner, NoWorkspaceState, PermissionDenied, Skeleton } from '../../components/states';
import { SurfaceHeader } from '../../components/SurfaceHeader';
import { SurfaceHelp } from '../../components/SurfaceHelp';
import { StartDialog } from './Dialogs';
import { RunDetail, type ActCall, type Evidence } from './RunDetail';
import {
  autostartTemplateOf,
  lastEndedMonths,
  lastEndedPeriod,
  lastEndedYears,
  MONTH_CLOSE_TEMPLATE_ID,
  parsePeriods,
  parseRun,
  parseRunList,
  periodTitle,
  todayIso,
  VAT_PERIOD_TEMPLATE_ID,
  YEAR_CLOSE_TEMPLATE_ID,
  type PeriodOption,
  type RunSummary,
  type RunView,
  type TemplateId,
} from './model';
import './Checklists.css';

function newKey(): string {
  return crypto.randomUUID();
}

type ListState =
  | { status: 'loading' }
  | { status: 'denied' }
  | { status: 'error' }
  | { status: 'loaded'; runs: RunSummary[] };

type DetailState =
  | { status: 'loading' }
  | { status: 'denied' }
  | { status: 'error' }
  | { status: 'missing' }
  | { status: 'loaded'; run: RunView };

const DENIED = new Set(['permission_denied', 'forbidden']);

/** The base currency the run's figures are in: read off the first read that names it, `CHF` until one does. */
function currencyOf(run: RunView): string {
  for (const item of run.items) {
    const named = item.previewResult?.payload?.baseCurrency;
    if (typeof named === 'string' && named !== '') return named;
  }
  return 'CHF';
}

export function Checklists() {
  const t = useT();
  const client = useClient();
  const workspaceId = useWorkspaceId();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const runId = searchParams.get('run');
  const canManage = useCan(CAP.manageChecklists);
  const canFile = useCan(CAP.vatFile);
  const canPost = useCan(CAP.post);
  const canPeriods = useCan(CAP.managePeriods);

  const [list, setList] = useState<ListState>({ status: 'loading' });
  const [detail, setDetail] = useState<DetailState>({ status: 'loading' });
  const [starting, setStarting] = useState(false);
  const [vatPeriods, setVatPeriods] = useState<PeriodOption[]>([]);
  const [startRefusal, setStartRefusal] = useState<{ code: string; periods: string[]; runId: string | null } | null>(null);
  const [working, setWorking] = useState(false);
  const [refusal, setRefusal] = useState<{ itemId: string | null; code: string; detail: string | null } | null>(null);

  const loadList = useCallback(async () => {
    if (workspaceId === null) return;
    setList({ status: 'loading' });
    const { body } = await client.call('checklist_list', { workspaceId });
    if (isErr(body)) {
      setList({ status: DENIED.has(body.error) ? 'denied' : 'error' });
      return;
    }
    const runs = parseRunList(body);
    setList(runs === null ? { status: 'error' } : { status: 'loaded', runs });
  }, [client, workspaceId]);

  const loadDetail = useCallback(async () => {
    if (workspaceId === null || runId === null) return;
    setDetail((prev) => (prev.status === 'loaded' ? prev : { status: 'loading' }));
    const { body } = await client.call('checklist_get', { workspaceId, runId });
    if (isErr(body)) {
      setDetail({ status: DENIED.has(body.error) ? 'denied' : body.error === 'not_found' ? 'missing' : 'error' });
      return;
    }
    const run = parseRun(body);
    setDetail(run === null ? { status: 'error' } : { status: 'loaded', run });
  }, [client, workspaceId, runId]);

  useEffect(() => {
    if (runId === null) void loadList();
    else {
      setDetail({ status: 'loading' });
      void loadDetail();
    }
  }, [runId, loadList, loadDetail]);

  // --- start ------------------------------------------------------------------------------------
  const today = todayIso();
  const periodsFor = useCallback(
    (templateId: TemplateId): PeriodOption[] => {
      if (templateId === VAT_PERIOD_TEMPLATE_ID) return vatPeriods.filter((p) => p.periodEnd < today);
      if (templateId === MONTH_CLOSE_TEMPLATE_ID) return lastEndedMonths(today, 6);
      return lastEndedYears(today, 3);
    },
    [vatPeriods, today],
  );
  const defaultPeriodFor = useCallback(
    (templateId: TemplateId): string | null => (templateId === VAT_PERIOD_TEMPLATE_ID ? (lastEndedPeriod(vatPeriods, today)?.label ?? null) : (periodsFor(templateId)[0]?.label ?? null)),
    [vatPeriods, today, periodsFor],
  );

  const openStart = async () => {
    if (workspaceId === null) return;
    setStartRefusal(null);
    const year = today.slice(0, 4);
    const { body } = await client.call('vat_periods', { workspaceId, year });
    if (isErr(body)) {
      // No A05 yet: the MWST-Periode has no periods to offer, the close templates still do.
      setVatPeriods([]);
    } else {
      const parsed = parsePeriods(body) ?? [];
      const prior = await client.call('vat_periods', { workspaceId, year: String(Number(year) - 1) });
      const priorParsed = isErr(prior.body) ? [] : (parsePeriods(prior.body) ?? []);
      setVatPeriods([...priorParsed, ...parsed]);
    }
    setStarting(true);
  };

  const start = async (templateId: TemplateId, period: string) => {
    if (workspaceId === null) return;
    setWorking(true);
    const { body } = await client.call('checklist_start', { workspaceId, templateId, period, idempotencyKey: newKey() });
    setWorking(false);
    if (isErr(body)) {
      const listed = Array.isArray(body.periods) ? (body.periods as unknown[]).filter((p): p is string => typeof p === 'string') : [];
      setStartRefusal({ code: body.error, periods: listed, runId: typeof body.yearRunId === 'string' ? body.yearRunId : null });
      return;
    }
    setStarting(false);
    const started = parseRun(body);
    if (started !== null) navigate(`/checklisten?run=${encodeURIComponent(started.runId)}`);
    else void loadList();
  };

  // --- the item writes --------------------------------------------------------------------------
  const write = async (verb: 'checklist_item_complete' | 'checklist_item_skip' | 'checklist_item_reopen' | 'checklist_abandon', itemId: string | null, input: Record<string, unknown>) => {
    if (workspaceId === null || runId === null) return;
    setWorking(true);
    setRefusal(null);
    const { body } = await client.call(verb, { workspaceId, runId, ...input, idempotencyKey: newKey() });
    setWorking(false);
    if (isErr(body)) {
      const detailValue = typeof body.exportedAt === 'string' ? body.exportedAt : typeof body.attestedOn === 'string' ? body.attestedOn : null;
      setRefusal({ itemId, code: body.error, detail: detailValue });
      return;
    }
    await loadDetail();
  };

  /**
   * The domain verbs of a posting row, one after another under their own gates. A refusal stops the
   * sequence and lands on the row with its code; what posted before it stays posted (a reversing
   * entry is the only way back), and the re-read shows the row's real state.
   */
  const act = async (itemId: string, calls: ActCall[]) => {
    if (workspaceId === null || runId === null) return;
    setWorking(true);
    setRefusal(null);
    let previous: Record<string, unknown> | null = null;
    for (const call of calls) {
      const input = typeof call.input === 'function' ? call.input(previous) : call.input;
      const { body } = await client.call(call.verb, { workspaceId, ...input, idempotencyKey: newKey() });
      if (isErr(body)) {
        setWorking(false);
        setRefusal({ itemId, code: body.error, detail: typeof body.period === 'string' ? body.period : null });
        await loadDetail();
        return;
      }
      previous = body as Record<string, unknown>;
    }
    setWorking(false);
    await loadDetail();
  };

  const currency = useMemo(() => (detail.status === 'loaded' ? currencyOf(detail.run) : 'CHF'), [detail]);

  if (workspaceId === null) return <NoWorkspaceState />;

  const header = (
    <SurfaceHeader
      title={t('checklists.title')}
      titleId="checklists-title"
      help={<SurfaceHelp surface="Checklists" />}
      actions={
        runId === null && canManage && list.status === 'loaded' ? (
          <button type="button" className="btn btn--primary" onClick={() => void openStart()}>
            {t('checklists.start.action')}
          </button>
        ) : runId !== null ? (
          <Link className="btn btn--secondary" to="/checklisten">
            {t('checklists.backToList')}
          </Link>
        ) : undefined
      }
    />
  );

  // --- detail -----------------------------------------------------------------------------------
  if (runId !== null) {
    return (
      <section className="checklists" aria-labelledby="checklists-title">
        {header}
        {detail.status === 'loading' && (
          <Skeleton rows={6} labelKey="checklists.loading" />
        )}
        {detail.status === 'denied' && <PermissionDenied body={t('checklists.denied.read')} />}
        {detail.status === 'error' && <ErrorBanner message={t('checklists.error.transport')} onRetry={() => void loadDetail()} />}
        {detail.status === 'missing' && (
          <EmptyState title={t('checklists.missing.title')} hint={t('checklists.missing.hint')} action={{ label: t('checklists.backToList'), to: '/checklisten' }} />
        )}
        {detail.status === 'loaded' && (
          <RunDetail
            run={detail.run}
            workspaceId={workspaceId}
            canManage={canManage}
            canFile={canFile}
            canPost={canPost}
            canPeriods={canPeriods}
            working={working}
            currency={currency}
            refusal={refusal}
            onComplete={(itemId, evidence: Evidence | null) => void write('checklist_item_complete', itemId, evidence === null ? { itemId } : { itemId, evidence })}
            onSkip={(itemId, reason) => void write('checklist_item_skip', itemId, { itemId, reason })}
            onReopen={(itemId) => void write('checklist_item_reopen', itemId, { itemId })}
            onAbandon={(reason) => void write('checklist_abandon', null, { reason })}
            onAct={(itemId, calls) => void act(itemId, calls)}
            onReload={() => void loadDetail()}
          />
        )}
      </section>
    );
  }

  // --- list -------------------------------------------------------------------------------------
  const open = list.status === 'loaded' ? list.runs.filter((r) => r.status === 'open') : [];
  const done = list.status === 'loaded' ? list.runs.filter((r) => r.status === 'done') : [];
  const abandoned = list.status === 'loaded' ? list.runs.filter((r) => r.status === 'abandoned') : [];

  const row = (r: RunSummary) => (
    <li key={r.runId} className="chk-run" data-status={r.status} data-template={r.templateId}>
      <Link className="chk-run-link" to={`/checklisten?run=${encodeURIComponent(r.runId)}`}>
        <span className="chk-run-title">{t('checklists.run.title', { template: r.templateLabel, period: periodTitle(r.periodLabel) })}</span>
        <span className="chk-run-range">{formatDate(r.periodStart)} {t('checklists.rangeTo')} {formatDate(r.periodEnd)}</span>
        {autostartTemplateOf(r.createdBy) !== null && <span className="chk-run-auto">{t('checklists.run.auto')}</span>}
        <span className="chk-run-status">{t(`checklists.runStatus.${r.status}`)}</span>
        {r.status === 'open' && (
          <span className="chk-run-progress">{t('checklists.run.progress', { done: r.doneCount + r.skippedCount, total: r.itemCount })}</span>
        )}
      </Link>
    </li>
  );

  return (
    <section className="checklists" aria-labelledby="checklists-title">
      {header}
      {list.status === 'loading' && (
        <Skeleton rows={4} labelKey="checklists.loading" />
      )}
      {list.status === 'denied' && <PermissionDenied body={t('checklists.denied.read')} />}
      {list.status === 'error' && <ErrorBanner message={t('checklists.error.transport')} onRetry={() => void loadList()} />}
      {list.status === 'loaded' && list.runs.length === 0 && (
        <EmptyState
          title={t('checklists.empty.title')}
          hint={t('checklists.empty.hint', { year: String(Number(today.slice(0, 4)) - 1) })}
          {...(canManage ? { action: { label: t('checklists.start.action'), onClick: () => void openStart() } } : {})}
        />
      )}
      {list.status === 'loaded' && list.runs.length > 0 && (
        <div className="chk-groups">
          <h2 className="chk-group-title">{t('checklists.group.open', { count: open.length })}</h2>
          {open.length === 0 ? <p className="chk-group-empty">{t('checklists.group.openEmpty')}</p> : <ul className="chk-runs">{open.map(row)}</ul>}
          {done.length > 0 && (
            <details className="chk-group">
              <summary className="chk-group-title">{t('checklists.group.done', { count: done.length })}</summary>
              <ul className="chk-runs">{done.map(row)}</ul>
            </details>
          )}
          {abandoned.length > 0 && (
            <details className="chk-group">
              <summary className="chk-group-title">{t('checklists.group.abandoned', { count: abandoned.length })}</summary>
              <ul className="chk-runs">{abandoned.map(row)}</ul>
            </details>
          )}
        </div>
      )}
      {starting && (
        <StartDialog
          open
          onClose={() => setStarting(false)}
          periodsFor={periodsFor}
          defaultPeriodFor={defaultPeriodFor}
          refusal={startRefusal?.code ?? null}
          refusalPeriods={startRefusal?.periods ?? []}
          refusalRunId={startRefusal?.runId ?? null}
          working={working}
          onStart={(templateId, period) => void start(templateId, period)}
        />
      )}
      {!starting && startRefusal !== null && startRefusal.code === 'needs_vat_config' && (
        <ErrorBanner message={t('checklists.start.needsConfig')} />
      )}
    </section>
  );
}

export { YEAR_CLOSE_TEMPLATE_ID };
export default Checklists;
