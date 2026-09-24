/**
 * G20's project layer on the Datenübernahme surface (spec §6). NO new route: when a workspace has an
 * open implementation project, the Migration surface LEADS with it, above the plan(s). The plans nest
 * as the Übernahme phase's content, so a workspace with plans and NO project renders plans exactly as
 * today (plan-only use pays no project tax: this component renders nothing when there is no project,
 * unless it is explicitly asked to offer creation on an empty surface).
 *
 * The states (spec §6): the phase strip (live labelled Stabilisierung), the one next action, the
 * blocked-first task list grouped by phase, the Freigaben (sign-off) cards, the Entscheide log, and
 * the Parallellauf panel. `not_asserted` renders `--t-warn` orange, NEVER green (G11's three-status
 * honesty carried verbatim); a failed figure renders the Rappen difference in danger with both
 * values. Sign-off controls without `commit_migration` are DISABLED (not hidden) with the reason as
 * text. Permission-denied renders the padlock naming `manage_implementation`.
 */
import { useCallback, useEffect, useState } from 'react';

import { useClient } from '../../lib/client-context';
import { isErr } from '../../lib/client';
import { useCapabilities, CAP } from '../../lib/capabilities';
import { useT } from '../../i18n';
import { RunbookItemRow } from '../../components/RunbookItemRow';
import { Select } from '../../components/Select';
import { ErrorBanner, Skeleton } from '../../components/states';

function newKey(): string {
  return crypto.randomUUID();
}

// The phase ladder and its de-CH strip labels (live = Stabilisierung in running text).
const PHASE_STRIP = ['discovery', 'extraction', 'mapping', 'rehearsal', 'cutover', 'parallel_run', 'live', 'closed'] as const;

interface TaskDto {
  taskId: string;
  phase: string;
  title: string;
  ownerKind: string;
  dueDate: string | null;
  prerequisiteTaskId: string | null;
  evidenceKind: string | null;
  evidenceRef: string | null;
  status: string;
  reason: string | null;
  undeletable: boolean;
}
interface SignoffDto {
  signoffId: string;
  kind: string;
  actor: string;
  evidenceRef: string;
  voided: boolean;
  createdAt: string;
}
interface DecisionDto {
  decisionId: string;
  title: string;
  context: string | null;
  decision: string;
  actor: string;
  createdAt: string;
}
interface FigureDto {
  kind: string;
  ref: string;
  declaredRappen: number | null;
  computedRappen: number | null;
  differenceRappen: number | null;
  status: string;
}
interface PeriodDto {
  period: string;
  status: string;
  figures: FigureDto[];
}
interface ProjectDto {
  projectId: string;
  sourceSystem: string;
  cutoverDate: string;
  mwstMethod: string;
  methodChange: boolean;
  status: string;
}
interface ProjectView {
  project: ProjectDto;
  phase: string;
  nextAction: string;
  tasks: TaskDto[];
  decisions: DecisionDto[];
  signoffs: SignoffDto[];
  parallelRun: { periods: PeriodDto[]; overall: string };
  availableRunbookTemplates: Array<{ templateId: string; label: string; description: string; itemCount: number }>;
}

type State =
  | { status: 'loading' }
  | { status: 'denied' }
  | { status: 'error' }
  | { status: 'absent'; templates: Array<{ templateId: string; label: string; description: string; itemCount: number }> }
  | { status: 'loaded'; view: ProjectView };

// The nine fixed sign-off kinds an operator may record from the surface (US-G20.5).
const SIGNOFF_KINDS = [
  'conversionDate', 'mwstMethod', 'mappingApproval', 'tieout', 'contactMerge', 'goNogo', 'rollbackTrigger', 'parallelRunClose', 'sourceCancellation',
] as const;
const KIND_WIRE: Record<string, string> = {
  conversionDate: 'conversion_date', mwstMethod: 'mwst_method', mappingApproval: 'mapping_approval', tieout: 'tieout',
  contactMerge: 'contact_merge', goNogo: 'go_nogo', rollbackTrigger: 'rollback_trigger', parallelRunClose: 'parallel_run_close', sourceCancellation: 'source_cancellation',
};
const KIND_KEY: Record<string, string> = Object.fromEntries(Object.entries(KIND_WIRE).map(([k, v]) => [v, k]));

export function ImplementationProject({
  workspaceId,
  offerCreateWhenAbsent = false,
  onChanged,
}: {
  workspaceId: string;
  offerCreateWhenAbsent?: boolean;
  onChanged?: () => void;
}): React.ReactElement | null {
  const client = useClient();
  const caps = useCapabilities();
  const t = useT();
  const [state, setState] = useState<State>({ status: 'loading' });

  const canManage = caps.can(CAP.manageImplementation);
  const canSign = caps.can(CAP.commitMigration);

  const load = useCallback(async () => {
    setState({ status: 'loading' });
    const listed = (await client.call('implementation_project_list', { workspaceId })).body;
    if (isErr(listed)) {
      setState({ status: listed.error === 'permission_denied' || listed.error === 'forbidden' ? 'denied' : 'error' });
      return;
    }
    const projects = (listed.projects ?? []) as Array<{ projectId: string; phase: string }>;
    const open = projects.find((p) => p.phase !== 'closed');
    if (open === undefined) {
      // No open project: render nothing unless asked to offer creation (the empty surface).
      if (!offerCreateWhenAbsent) {
        setState({ status: 'absent', templates: [] });
        return;
      }
      setState({ status: 'absent', templates: [] });
      return;
    }
    const full = (await client.call('implementation_project_get', { workspaceId, projectId: open.projectId })).body;
    if (isErr(full)) {
      setState({ status: full.error === 'permission_denied' || full.error === 'forbidden' ? 'denied' : 'error' });
      return;
    }
    setState({ status: 'loaded', view: full as unknown as ProjectView });
  }, [client, workspaceId, offerCreateWhenAbsent]);

  useEffect(() => {
    void load();
  }, [load]);

  const refresh = async (): Promise<void> => {
    await load();
    onChanged?.();
  };

  async function completeTask(task: TaskDto): Promise<void> {
    await client.call('implementation_task_set', { workspaceId, projectId: viewOf().project.projectId, taskId: task.taskId, fields: { status: 'done' }, idempotencyKey: newKey() });
    await refresh();
  }
  async function recordSignoff(wireKind: string): Promise<void> {
    await client.call('implementation_signoff_record', { workspaceId, projectId: viewOf().project.projectId, kind: wireKind, evidenceRef: `freigabe-${wireKind}`, idempotencyKey: newKey() });
    await refresh();
  }
  async function runCheck(period: string): Promise<void> {
    await client.call('implementation_parallel_check', { workspaceId, projectId: viewOf().project.projectId, period, idempotencyKey: newKey() });
    await refresh();
  }
  function viewOf(): ProjectView {
    if (state.status !== 'loaded') throw new Error('no project');
    return state.view;
  }

  if (state.status === 'loading') {
    return (
      <section className="impl-project" aria-busy="true">
        <Skeleton rows={1} height={64} />
      </section>
    );
  }
  if (state.status === 'denied') {
    return (
      <section className="impl-project impl-denied" role="note">
        <h2>{t('implProject.title')}</h2>
        <p>{t('implProject.denied')}</p>
      </section>
    );
  }
  if (state.status === 'error') {
    return (
      <section className="impl-project">
        <ErrorBanner message={t('implProject.error')} context="read" onRetry={() => void load()} />
      </section>
    );
  }
  if (state.status === 'absent') {
    if (!offerCreateWhenAbsent) return null;
    return (
      <section className="impl-project impl-empty">
        <h2>{t('implProject.title')}</h2>
        <p>{t('implProject.empty')}</p>
        <CreateProjectForm workspaceId={workspaceId} disabled={!canManage} onCreated={() => void refresh()} />
        <p className="impl-continue-without">{t('implProject.continueWithout')}</p>
      </section>
    );
  }

  const { view } = state;
  const currentIdx = PHASE_STRIP.indexOf(view.phase as (typeof PHASE_STRIP)[number]);

  // Blocked-first, grouped by phase.
  const byPhase = new Map<string, TaskDto[]>();
  for (const task of view.tasks) {
    const list = byPhase.get(task.phase) ?? [];
    list.push(task);
    byPhase.set(task.phase, list);
  }

  return (
    <section className="impl-project" aria-label={t('implProject.title')}>
      <h2>{t('implProject.title')}</h2>

      <ol className="impl-phase-strip" aria-label={t('implProject.title')}>
        {PHASE_STRIP.map((phase, i) => (
          <li key={phase} className={i === currentIdx ? 'is-current' : undefined} aria-current={i === currentIdx ? 'step' : undefined}>
            {phase === 'live' ? t('implProject.phase.liveLabel') : t(`implProject.phase.${KIND_KEY_PHASE(phase)}`)}
          </li>
        ))}
      </ol>

      {view.nextAction !== '' && <p className="impl-next">{t('implProject.next')}: {view.nextAction}</p>}

      {/* Tasks, blocked-first, grouped by phase. */}
      {view.tasks.length === 0 ? (
        <RunbookPicker
          workspaceId={workspaceId}
          projectId={view.project.projectId}
          templates={view.availableRunbookTemplates}
          disabled={!canManage}
          onInstantiated={() => void refresh()}
        />
      ) : (
        <div className="impl-tasks">
          {PHASE_STRIP.map((phase) => {
            const tasks = (byPhase.get(phase) ?? []).sort((a, b) => (a.status === 'blocked' ? -1 : 0) - (b.status === 'blocked' ? -1 : 0));
            if (tasks.length === 0) return null;
            return (
              <div key={phase} className="impl-phase-group">
                <h3>{phase === 'live' ? t('implProject.phase.liveLabel') : t(`implProject.phase.${KIND_KEY_PHASE(phase)}`)}</h3>
                <ul>
                  {tasks.map((task) => (
                    // The shared runbook row (G22, D127): one design language for G20 tasks and G22 items.
                    <RunbookItemRow
                      key={task.taskId}
                      title={task.title}
                      owner={t(`implProject.owner.${task.ownerKind}`)}
                      status={task.status}
                      statusLabel={task.status === 'not_applicable' ? t('implProject.task.notApplicable') : undefined}
                      dueAt={task.dueDate}
                      note={task.status === 'blocked' && task.prerequisiteTaskId !== null ? t('implProject.task.blockedBy', { item: task.prerequisiteTaskId }) : undefined}
                      actions={
                        task.status === 'open' && canManage ? (
                          <button className="btn btn--secondary" type="button" onClick={() => void completeTask(task)}>{t('implProject.task.done')}</button>
                        ) : undefined
                      }
                      dataAttributes={{ 'data-attention': task.status === 'blocked' ? 'true' : undefined }}
                    />
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      )}

      {/* Freigaben (sign-off) cards: each pending kind actionable; disabled without commit_migration. */}
      <div className="impl-signoffs" aria-label={t('implProject.signoff.title')}>
        <h3>{t('implProject.signoff.title')}</h3>
        {view.signoffs.filter((s) => !s.voided).length > 0 && (
          <ul className="impl-signoff-recorded">
            {view.signoffs.map((s) => (
              <li key={s.signoffId} data-voided={s.voided ? 'true' : undefined}>
                {t(`implProject.signoff.kind.${KIND_KEY[s.kind] ?? s.kind}`)}
                {s.voided && <span className="impl-signoff-voided">{t('implProject.signoff.voided')}</span>}
              </li>
            ))}
          </ul>
        )}
        <ul className="impl-signoff-pending">
          {SIGNOFF_KINDS.map((camel) => {
            const wire = KIND_WIRE[camel];
            const recorded = view.signoffs.some((s) => s.kind === wire && !s.voided);
            if (recorded) return null;
            return (
              <li key={camel} className="impl-signoff-card">
                <span>{t(`implProject.signoff.kind.${camel}`)}</span>
                {canSign ? (
                  <button className="btn btn--secondary" type="button" onClick={() => void recordSignoff(wire)}>{t('implProject.signoff.record')}</button>
                ) : (
                  <span className="impl-disabled-reason">{t('implProject.signoff.needsCommit')}</span>
                )}
              </li>
            );
          })}
        </ul>
      </div>

      {/* Entscheide (decision) log. */}
      <div className="impl-decisions" aria-label={t('implProject.decision.title')}>
        <h3>{t('implProject.decision.title')}</h3>
        <ul>
          {view.decisions.map((d) => (
            <li key={d.decisionId}><strong>{d.title}</strong>: {d.decision}</li>
          ))}
        </ul>
      </div>

      {/* Parallellauf panel. */}
      <div className="impl-parallel" aria-label={t('implProject.parallel.title')}>
        <h3>{t('implProject.parallel.title')}</h3>
        {view.parallelRun.periods.length === 0 ? (
          <p className="impl-parallel-empty">{t('implProject.parallel.empty')}</p>
        ) : (
          view.parallelRun.periods.map((p) => (
            <div key={p.period} className="impl-parallel-period" data-status={p.status}>
              <h4>{p.period} <span data-status={p.status}>{p.status === 'not_asserted' ? t('implProject.parallel.notAsserted') : t(`implProject.parallel.status.${p.status}`)}</span></h4>
              <ul>
                {p.figures.map((f) => (
                  <li key={`${f.kind}-${f.ref}`} className="impl-figure" data-status={f.status}>
                    <span>{f.kind} {f.ref}</span>
                    {f.status === 'failed' && (
                      <span className="impl-figure-diff impl-danger">
                        {t('implProject.parallel.difference', { amount: String(f.differenceRappen) })} ({f.declaredRappen} / {f.computedRappen})
                      </span>
                    )}
                    {f.status === 'not_asserted' && <span className="impl-warn">{t('implProject.parallel.notAsserted')}</span>}
                  </li>
                ))}
              </ul>
              {canManage && <button className="btn btn--secondary" type="button" onClick={() => void runCheck(p.period)}>{t('implProject.parallel.recheck')}</button>}
            </div>
          ))
        )}
      </div>
    </section>
  );
}

/** discovery -> phase.discovery, parallel_run -> phase.parallelRun (the i18n key casing). */
function KIND_KEY_PHASE(phase: string): string {
  if (phase === 'parallel_run') return 'parallelRun';
  return phase;
}

function CreateProjectForm({ workspaceId, disabled, onCreated }: { workspaceId: string; disabled: boolean; onCreated: () => void }): React.ReactElement {
  const client = useClient();
  const t = useT();
  const [sourceSystem, setSourceSystem] = useState('bexio');
  const [cutoverDate, setCutoverDate] = useState('');
  const [mwstMethod, setMwstMethod] = useState('effektiv');
  const [error, setError] = useState<string | null>(null);

  async function create(): Promise<void> {
    setError(null);
    const res = (await client.call('implementation_project_create', { workspaceId, sourceSystem, cutoverDate, mwstMethod, idempotencyKey: newKey() })).body;
    if (isErr(res)) {
      setError(res.error);
      return;
    }
    onCreated();
  }

  return (
    <div className="impl-create">
      <label>{t('implProject.createField.sourceSystem')}<input className="field" value={sourceSystem} onChange={(e) => setSourceSystem(e.target.value)} /></label>
      <label>{t('implProject.createField.cutoverDate')}<input className="field" type="date" value={cutoverDate} onChange={(e) => setCutoverDate(e.target.value)} /></label>
      <label>{t('implProject.createField.mwstMethod')}
        <Select
          value={mwstMethod}
          onChange={(val) => setMwstMethod(val)}
          options={[
            { value: 'effektiv', label: 'effektiv' },
            { value: 'saldo', label: 'saldo' },
          ]}
          ariaLabel={t('implProject.createField.mwstMethod')}
        />
      </label>
      <button className="btn btn--secondary" type="button" disabled={disabled} onClick={() => void create()}>{t('implProject.create')}</button>
      {disabled && <span className="impl-disabled-reason">{t('implProject.needsManage')}</span>}
      {error !== null && <span className="impl-error" role="alert">{t('implProject.createFailed')}</span>}
    </div>
  );
}

function RunbookPicker({
  workspaceId, projectId, templates, disabled, onInstantiated,
}: {
  workspaceId: string;
  projectId: string;
  templates: Array<{ templateId: string; label: string; description: string; itemCount: number }>;
  disabled: boolean;
  onInstantiated: () => void;
}): React.ReactElement {
  const client = useClient();
  const t = useT();
  async function instantiate(templateId: string): Promise<void> {
    await client.call('implementation_runbook_instantiate', { workspaceId, projectId, templateId, idempotencyKey: newKey() });
    onInstantiated();
  }
  return (
    <div className="impl-runbook-picker">
      <h3>{t('implProject.runbook.title')}</h3>
      <ul>
        {templates.map((tpl) => (
          <li key={tpl.templateId}>
            <strong>{tpl.label}</strong>
            <p>{tpl.description}</p>
            <button className="btn btn--secondary" type="button" disabled={disabled} onClick={() => void instantiate(tpl.templateId)}>{t('implProject.runbook.instantiate')}</button>
          </li>
        ))}
      </ul>
    </div>
  );
}
