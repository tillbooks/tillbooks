/**
 * G22 Checklisten at `/checklisten` (spec §6): the run list (grouped by template, open first, done
 * and abandoned runs as compact groups) and, with `?run=<id>`, the run detail. Five states on both:
 * loading skeleton rows, empty (naming the configured period kind, never the literal Quartal), error
 * with retry, success, and the padlock naming the missing right. Writes run through the shared
 * client (`checklist_start`, `checklist_item_complete`, `checklist_item_skip`, `checklist_item_reopen`,
 * `checklist_abandon`), each behind `manage_checklists`; the list re-reads after every write so the
 * live derivation (a check that flipped, a stale sign-off) is what the screen shows.
 */
import { useCallback, useEffect, useState } from 'react';
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
import { RunDetail } from './RunDetail';
import {
  lastEndedPeriod,
  parsePeriods,
  parseRun,
  parseRunList,
  periodTitle,
  todayIso,
  VAT_PERIOD_TEMPLATE_ID,
  type PeriodOption,
  type RunSummary,
  type RunView,
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

export function Checklists() {
  const t = useT();
  const client = useClient();
  const workspaceId = useWorkspaceId();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const runId = searchParams.get('run');
  const canManage = useCan(CAP.manageChecklists);
  const canFile = useCan(CAP.vatFile);

  const [list, setList] = useState<ListState>({ status: 'loading' });
  const [detail, setDetail] = useState<DetailState>({ status: 'loading' });
  const [starting, setStarting] = useState(false);
  const [periods, setPeriods] = useState<PeriodOption[]>([]);
  const [startRefusal, setStartRefusal] = useState<{ code: string; periods: string[] } | null>(null);
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
    setDetail({ status: 'loading' });
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
    else void loadDetail();
  }, [runId, loadList, loadDetail]);

  // --- start ------------------------------------------------------------------------------------
  const openStart = async () => {
    if (workspaceId === null) return;
    setStartRefusal(null);
    const year = todayIso().slice(0, 4);
    const { body } = await client.call('vat_periods', { workspaceId, year });
    if (isErr(body)) {
      setPeriods([]);
      setStartRefusal({ code: body.error, periods: [] });
    } else {
      const parsed = parsePeriods(body) ?? [];
      const prior = await client.call('vat_periods', { workspaceId, year: String(Number(year) - 1) });
      const priorParsed = isErr(prior.body) ? [] : (parsePeriods(prior.body) ?? []);
      setPeriods([...priorParsed, ...parsed]);
    }
    setStarting(true);
  };

  const start = async (period: string) => {
    if (workspaceId === null) return;
    setWorking(true);
    const { body } = await client.call('checklist_start', { workspaceId, templateId: VAT_PERIOD_TEMPLATE_ID, period, idempotencyKey: newKey() });
    setWorking(false);
    if (isErr(body)) {
      const listed = Array.isArray(body.periods) ? (body.periods as unknown[]).filter((p): p is string => typeof p === 'string') : [];
      setStartRefusal({ code: body.error, periods: listed });
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
            canManage={canManage}
            canFile={canFile}
            working={working}
            refusal={refusal}
            onComplete={(itemId, evidence) => void write('checklist_item_complete', itemId, evidence === null ? { itemId } : { itemId, evidence })}
            onSkip={(itemId, reason) => void write('checklist_item_skip', itemId, { itemId, reason })}
            onReopen={(itemId) => void write('checklist_item_reopen', itemId, { itemId })}
            onAbandon={(reason) => void write('checklist_abandon', null, { reason })}
          />
        )}
      </section>
    );
  }

  // --- list -------------------------------------------------------------------------------------
  const open = list.status === 'loaded' ? list.runs.filter((r) => r.status === 'open') : [];
  const done = list.status === 'loaded' ? list.runs.filter((r) => r.status === 'done') : [];
  const abandoned = list.status === 'loaded' ? list.runs.filter((r) => r.status === 'abandoned') : [];
  const defaultPeriod = lastEndedPeriod(periods, todayIso())?.label ?? null;

  const row = (r: RunSummary) => (
    <li key={r.runId} className="chk-run" data-status={r.status}>
      <Link className="chk-run-link" to={`/checklisten?run=${encodeURIComponent(r.runId)}`}>
        <span className="chk-run-title">{t('checklists.run.title', { template: r.templateLabel, period: periodTitle(r.periodLabel) })}</span>
        <span className="chk-run-range">{formatDate(r.periodStart)} {t('checklists.rangeTo')} {formatDate(r.periodEnd)}</span>
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
          hint={t('checklists.empty.hint')}
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
          periods={periods}
          defaultPeriod={defaultPeriod}
          refusal={startRefusal?.code ?? null}
          refusalPeriods={startRefusal?.periods ?? []}
          working={working}
          onStart={(period) => void start(period)}
        />
      )}
      {!starting && startRefusal !== null && startRefusal.code === 'needs_vat_config' && (
        <ErrorBanner message={t('checklists.start.needsConfig')} />
      )}
    </section>
  );
}

export default Checklists;
