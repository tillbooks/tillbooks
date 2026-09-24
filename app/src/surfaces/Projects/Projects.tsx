/**
 * Projects, the B00 master surface (spec §6): the cluster-B entry point.
 *
 * A filterable, nested project list (status glyph+label per row, children indented under their
 * parent) across the full width, and the selected project in a `DetailDrawer` (K-19, D137: the list
 * used to share the page with a 616px detail column and cut its own Budget and Marge columns off):
 * header with the status menu and the ⋯ overflow (Löschen only on a draft, the twin of the draft-only `project_delete`), the
 * client chip, the dates, the Budget vs. Ist panel fed by `project_budget_actual`, and the phase
 * table with the Erledigt control. Renders the five canonical states off the shared F1 primitives.
 *
 * ## BUILT ON THE SHARED UI PRIMITIVES (D118 B2, 2026-08-23)
 *
 * The project list is the shared `DataTable` (frame overflow, sticky header, density and the five
 * states in one place), selection driven by its `onRowClick`; the active row and the child indent
 * ride the `rowClassName` hook rather than bespoke row markup. The page header is the shared
 * `SurfaceHeader` and the search/status row the shared `FilterBar`, and the create/edit overlay is
 * the shared `Modal` (see `ProjectEditor.tsx`). The per-surface CSS that duplicated the list table,
 * the controls row, the header and the editor scrim is gone; what remains is the detail panel, the
 * Budget vs. Ist figures and the phase table, which are genuinely Projects-specific.
 *
 * THE PADLOCK (A24): every write on this surface is `manage_master_data`, so every write
 * affordance is ABSENT for an actor the engine would refuse (the Contacts idiom). `useCan` fails
 * open while `whoami` is unresolved: the engine's `ctxAction` gate is the one that decides.
 *
 * Money renders through the P11 `formatMoney` helper; a row carries integer Rappen, never a float
 * (P2). Dates render through `formatDate` (TT.MM.JJJJ). Status is glyph+label, never colour or
 * glyph alone (WCAG: the glyphs carry `aria-hidden`, the label is the accessible text).
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';

import { useClient } from '../../lib/client-context';
import { isErr } from '../../lib/client';
import { useWorkspaceId } from '../../app/workspace';
import { useT, formatMoney, formatDate } from '../../i18n';
import { EmptyState, ErrorBanner, NoWorkspaceState, PermissionDenied, useSkeletonHold } from '../../components/states';
import { DataTable, type DataTableColumn } from '../../components/DataTable';
import { DetailDrawer } from '../../components/DetailDrawer';
import { Status, type StatusKind } from '../../components/Status';
import { Select } from '../../components/Select';
import { SurfaceHeader } from '../../components/SurfaceHeader';
import { FilterBar } from '../../components/FilterBar';
import { OverflowMenu } from '../../components/OverflowMenu';
import { SurfaceHelp } from '../../components/SurfaceHelp';
import { useCan, CAP } from '../../lib/capabilities';
import { ConfirmDialog } from '../Accounts/ConfirmDialog';
import type { Err } from '../../lib/client';
// B03: the Projekterfolg panel and the Marge column ride the costing read model. The Costing
// directory is a component library (no route); its one consumer is this surface.
import { ProjectProfitability } from '../Costing';
import { ProjectEditor } from './ProjectEditor';
import {
  NEXT_STATUSES,
  PROJECT_STATUSES,
  idemKey,
  nestProjects,
  parseAmountToMinor,
} from './model';
import type { BudgetActual, ContactOption, Phase, Project, ProjectStatus } from './model';

type DrawerState = { mode: 'create' } | { mode: 'edit'; project: Project } | null;

/** One list row: a project and whether it renders indented as a sub-project under its parent. */
type Row = { project: Project; isChild: boolean };

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

export function Projects() {
  const t = useT();
  const client = useClient();
  const workspaceId = useWorkspaceId();
  const canManage = useCan(CAP.manageMasterData);
  // B03: the profitability layer gates on its own read (the revDSG pay-data gate); without it the
  // Marge column and the Projekterfolg panel are HIDDEN, never shown-then-rejected.
  const canCosting = useCan(CAP.costingRead);

  const [projects, setProjects] = useState<Project[]>([]);
  const [contacts, setContacts] = useState<ContactOption[]>([]);
  const [baseCurrency, setBaseCurrency] = useState('CHF');
  const [margins, setMargins] = useState<Map<string, number>>(new Map());

  const [loading, setLoading] = useState(true);
  // K-34: the table's own skeleton, never before 200ms and never for less than 300ms once shown.
  const showSkeleton = useSkeletonHold(loading);
  const [error, setError] = useState<Err | null>(null);
  const [denied, setDenied] = useState(false);

  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'' | ProjectStatus>('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [drawer, setDrawer] = useState<DrawerState>(null);
  const [pendingDelete, setPendingDelete] = useState<Project | null>(null);
  const [rowError, setRowError] = useState<Err | null>(null);

  const load = useCallback(async () => {
    if (workspaceId === null) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    setDenied(false);

    const [projectsResp, contactsResp, profileResp, plListResp] = await Promise.all([
      client.call('project_list', { workspaceId }),
      client.call('list_contacts', { workspaceId }),
      client.call('get_company_profile', { workspaceId }),
      // B03: the Marge column. A denial or an absent verb simply leaves the column off; the list
      // itself never depends on the costing layer.
      client.call('costing_pl_list', { workspaceId }),
    ]);

    if (isErr(projectsResp.body)) {
      if (projectsResp.body.error === 'permission_denied' || projectsResp.status === 403) setDenied(true);
      else setError(projectsResp.body);
      setLoading(false);
      return;
    }
    setProjects(asArray<Project>(projectsResp.body.projects));
    setContacts(
      isErr(contactsResp.body)
        ? []
        : asArray<{ id: string; name: string }>(contactsResp.body.contacts).map((c) => ({ id: c.id, name: c.name })),
    );
    if (!isErr(profileResp.body)) {
      const profile = profileResp.body.profile as { baseCurrency?: string | null } | undefined;
      if (profile?.baseCurrency != null && profile.baseCurrency !== '') setBaseCurrency(profile.baseCurrency);
    }
    if (!isErr(plListResp.body)) {
      const rows = asArray<{ projectId: string; marginMinor?: number }>(plListResp.body.projects);
      setMargins(new Map(rows.filter((r) => r.marginMinor !== undefined).map((r) => [r.projectId, r.marginMinor as number])));
    } else {
      setMargins(new Map());
    }
    setLoading(false);
  }, [client, workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  const contactName = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of contacts) map.set(c.id, c.name);
    return map;
  }, [contacts]);

  const rows = useMemo<Row[]>(() => {
    const q = search.trim().toLowerCase();
    const filtered = projects
      .filter((p) => statusFilter === '' || p.status === statusFilter)
      .filter((p) => q === '' || p.name.toLowerCase().includes(q) || p.code.toLowerCase().includes(q));
    return nestProjects(filtered);
  }, [projects, search, statusFilter]);

  const selected = useMemo(() => projects.find((p) => p.id === selectedId) ?? null, [projects, selectedId]);

  async function setStatus(project: Project, status: ProjectStatus) {
    setRowError(null);
    const resp = await client.call('project_set_status', {
      workspaceId,
      projectId: project.id,
      status,
      idempotencyKey: idemKey('status'),
    });
    if (isErr(resp.body)) setRowError(resp.body);
    else void load();
  }

  async function removeProject(project: Project) {
    setRowError(null);
    setPendingDelete(null);
    const resp = await client.call('project_delete', {
      workspaceId,
      projectId: project.id,
      idempotencyKey: idemKey('del'),
    });
    if (isErr(resp.body)) {
      setRowError(resp.body);
      return;
    }
    if (selectedId === project.id) setSelectedId(null);
    void load();
  }

  // The header is the one block every state shares, so it is rendered once here and reused by the
  // early returns below rather than copy-pasted into each of them (SurfaceHeader, D118 B2).
  const header = (actions?: ReactNode) => (
    <SurfaceHeader
      title={t('project.route.title')}
      help={<SurfaceHelp surface="Projects" />}
      actions={actions}
    />
  );

  if (workspaceId === null) {
    return (
      <div className="projects">
        {header()}
        <NoWorkspaceState body={t('project.noWorkspaceHint')} />
      </div>
    );
  }

  if (showSkeleton) {
    return (
      <div className="projects">
        {header()}
        <DataTable columns={[]} rows={[]} rowKey={() => ''} loading skeletonRows={6} />
      </div>
    );
  }

  if (denied) {
    return (
      <div className="projects">
        {header()}
        <PermissionDenied />
      </div>
    );
  }

  if (error !== null) {
    return (
      <div className="projects">
        {header()}
        <ErrorBanner error={error} onRetry={() => void load()} context="read" />
      </div>
    );
  }

  const hasProjects = projects.length > 0;

  const createButton = canManage ? (
    <button type="button" className="btn btn--primary" onClick={() => setDrawer({ mode: 'create' })}>
      {t('project.action.create')}
    </button>
  ) : undefined;

  // The filtered-empty state offers the way back, never a create (K-33). DataTable renders it when
  // the filter hides every row.
  const emptyState = (
    <EmptyState
      title={t('project.emptySearch')}
      filtered={{
        onClear: () => {
          setSearch('');
          setStatusFilter('');
        },
        clearLabel: t('project.clearSearch'),
      }}
    />
  );

  const columns: DataTableColumn<Row>[] = [
    {
      key: 'code',
      header: t('project.col.code'),
      render: ({ project }) => <span className="projects-code">{project.code}</span>,
    },
    {
      key: 'name',
      header: t('project.col.name'),
      render: ({ project, isChild }) => (
        <span className={`projects-name${isChild ? ' projects-name--child' : ''}`}>{project.name}</span>
      ),
    },
    {
      key: 'contact',
      header: t('project.col.client'),
      render: ({ project }) => {
        const name = contactName.get(project.contactId);
        return name !== undefined ? <span className="projects-contact">{name}</span> : null;
      },
    },
    {
      key: 'status',
      header: t('project.col.status'),
      render: ({ project }) => <ProjectStatusWord status={project.status} />,
    },
    {
      key: 'budget',
      header: t('project.col.budget'),
      numeric: true,
      render: ({ project }) =>
        project.budgetMinor > 0 ? formatMoney(project.budgetMinor, project.currency) : null,
    },
    // B03: the computed Marge column, present only while the costing read is held.
    ...(canCosting
      ? [
          {
            key: 'margin',
            header: t('costing.list.margin'),
            numeric: true,
            render: ({ project }: Row) => {
              const marginMinor = margins.get(project.id);
              return marginMinor !== undefined ? (
                <span className="projects-margin">{formatMoney(marginMinor, baseCurrency)}</span>
              ) : null;
            },
          } satisfies DataTableColumn<Row>,
        ]
      : []),
  ];

  // K-21: the row opens the project; every other verb sits behind ONE overflow. Destructive LAST and
  // `danger`, only ever offered on a draft: the twin of the draft-only verb.
  const projectActions = (project: Project) => [
    { key: 'edit', label: t('project.action.edit'), onSelect: () => setDrawer({ mode: 'edit', project }) },
    ...(project.status === 'draft'
      ? [{ key: 'delete', label: t('project.action.delete'), onSelect: () => setPendingDelete(project), danger: true }]
      : []),
  ];

  return (
    <div className="projects">
      {header(createButton)}

      {rowError !== null && <ErrorBanner error={rowError} />}

      {!hasProjects ? (
        <EmptyState
          title={t('project.empty')}
          hint={t('project.emptyHint')}
          {...(canManage ? { action: { label: t('project.action.create'), onClick: () => setDrawer({ mode: 'create' }) } } : {})}
        />
      ) : (
        <>
            <FilterBar
              searchValue={search}
              onSearchChange={setSearch}
              searchLabel={t('project.list.searchLabel')}
              searchPlaceholder={t('project.list.search')}
              onClear={() => {
                setSearch('');
                setStatusFilter('');
              }}
              clearLabel={t('project.clearSearch')}
              active={search.trim() !== '' || statusFilter !== ''}
            >
              <div className="projects-status-filter">
                <span className="visually-hidden">{t('project.list.statusFilter')}</span>
                <Select
                  value={statusFilter}
                  onChange={(val) => setStatusFilter(val as '' | ProjectStatus)}
                  options={[
                    { value: '', label: t('project.list.allStatuses') },
                    ...PROJECT_STATUSES.map((s) => ({ value: s, label: t(`project.status.${s}`) })),
                  ]}
                  ariaLabel={t('project.list.statusFilter')}
                />
              </div>
            </FilterBar>

            <DataTable
              columns={columns}
              rows={rows}
              rowKey={({ project }) => project.id}
              caption={t('project.list.aria')}
              emptyState={emptyState}
              onRowClick={({ project }) => setSelectedId(project.id)}
              rowLabel={({ project }) => `${project.code} ${project.name}`}
              isRowCurrent={({ project }) => project.id === selectedId}
              rowActions={canManage ? ({ project }) => projectActions(project) : undefined}
              rowActionsLabel={({ project }) => t('project.list.rowActions', { name: project.name })}
              rowClassName={({ isChild }) => (isChild ? 'projects-row--child' : undefined)}
            />
        </>
      )}

      {/* K-19: the project opens in the wide drawer, so the list keeps the whole width. The editor
          and the delete confirm open over it; the drawer stands down while they are up. */}
      {selected !== null && (
        <DetailDrawer
          open
          width="wide"
          onClose={() => setSelectedId(null)}
          title={selected.name}
          closeLabel={t('project.detail.close')}
          headerExtra={<ProjectStatusWord status={selected.status} />}
          trapActive={drawer === null && pendingDelete === null}
        >
          <ProjectDetail
            key={selected.id}
            workspaceId={workspaceId}
            project={selected}
            contactName={contactName.get(selected.contactId)}
            canManage={canManage}
            canCosting={canCosting}
            onStatus={(status) => void setStatus(selected, status)}
            onEdit={() => setDrawer({ mode: 'edit', project: selected })}
            // The shared confirm (Accounts' ConfirmDialog) has no overlay layer of its own, so it would
            // open under this drawer's scrim: the drawer steps aside for it, and a delete ends the
            // project's drawer anyway.
            onDelete={() => {
              setSelectedId(null);
              setPendingDelete(selected);
            }}
            onChanged={() => void load()}
          />
        </DetailDrawer>
      )}

      {drawer !== null && (
        <ProjectEditor
          workspaceId={workspaceId}
          mode={drawer.mode}
          project={drawer.mode === 'edit' ? drawer.project : undefined}
          contacts={contacts}
          parentOptions={projects.filter((p) => drawer.mode !== 'edit' || p.id !== drawer.project.id)}
          baseCurrency={baseCurrency}
          onClose={() => setDrawer(null)}
          onSaved={() => void load()}
        />
      )}

      {pendingDelete !== null && (
        <ConfirmDialog
          message={t('project.confirm.delete')}
          confirmLabel={t('project.confirm.deleteConfirm')}
          cancelLabel={t('project.confirm.cancel')}
          onConfirm={() => void removeProject(pendingDelete)}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </div>
  );
}

/**
 * A project's state as the one `Status` word (K-22): a draft has nothing to act on yet, an active
 * project is under way, one on hold is out of play for now, and a closed one is done.
 */
const PROJECT_STATUS_KIND: Record<ProjectStatus, StatusKind> = {
  draft: 'neutral',
  active: 'pending',
  on_hold: 'inactive',
  closed: 'success',
};

function ProjectStatusWord({ status }: { status: ProjectStatus }) {
  const t = useT();
  return <Status kind={PROJECT_STATUS_KIND[status]} label={t(`project.status.${status}`)} />;
}

interface ProjectDetailProps {
  workspaceId: string;
  project: Project;
  contactName: string | undefined;
  canManage: boolean;
  /** B03: whether the profitability layer renders at all (hidden without `costing.read`). */
  canCosting: boolean;
  onStatus: (status: ProjectStatus) => void;
  onEdit: () => void;
  onDelete: () => void;
  onChanged: () => void;
}

/** The action word per target status, from the CURRENT status (resume vs activate, close vs reopen). */
function statusActionKey(from: ProjectStatus, to: ProjectStatus): string {
  if (to === 'active') return from === 'on_hold' ? 'project.action.resume' : from === 'closed' ? 'project.action.reopen' : 'project.action.activate';
  if (to === 'on_hold') return 'project.action.hold';
  return 'project.action.close';
}

function ProjectDetail({
  workspaceId,
  project,
  contactName,
  canManage,
  canCosting,
  onStatus,
  onEdit,
  onDelete,
  onChanged,
}: ProjectDetailProps) {
  const t = useT();
  const client = useClient();

  const [phases, setPhases] = useState<Phase[]>([]);
  const [standing, setStanding] = useState<BudgetActual | null>(null);
  const [phaseError, setPhaseError] = useState<Err | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [phaseName, setPhaseName] = useState('');
  const [phaseBudget, setPhaseBudget] = useState('');
  const [phaseMilestone, setPhaseMilestone] = useState('');

  const loadDetail = useCallback(async () => {
    const [getResp, baResp] = await Promise.all([
      client.call('project_get', { workspaceId, projectId: project.id }),
      client.call('project_budget_actual', { workspaceId, projectId: project.id }),
    ]);
    if (!isErr(getResp.body)) {
      const p = getResp.body.project as Project & { phases?: Phase[] };
      setPhases(asArray<Phase>(p.phases));
    }
    setStanding(isErr(baResp.body) ? null : (baResp.body as unknown as BudgetActual));
  }, [client, workspaceId, project.id]);

  useEffect(() => {
    void loadDetail();
  }, [loadDetail]);

  async function addPhase() {
    setPhaseError(null);
    setWarning(null);
    const budgetMinor = phaseBudget.trim() === '' ? 0 : parseAmountToMinor(phaseBudget);
    if (budgetMinor === null) {
      setPhaseError({ ok: false, error: 'invalid_input' } as unknown as Err);
      return;
    }
    const resp = await client.call('project_phase_add', {
      workspaceId,
      projectId: project.id,
      name: phaseName.trim(),
      budgetMinor,
      sort: phases.length + 1,
      ...(phaseMilestone !== '' ? { milestoneOn: phaseMilestone } : {}),
      idempotencyKey: idemKey('phase'),
    });
    if (isErr(resp.body)) {
      setPhaseError(resp.body);
      return;
    }
    const warnings = asArray<string>(resp.body.warnings);
    if (warnings.includes('phase_budgets_exceed_project')) setWarning(t('project.warning.phase_budgets'));
    setAdding(false);
    setPhaseName('');
    setPhaseBudget('');
    setPhaseMilestone('');
    void loadDetail();
    onChanged();
  }

  async function markDone(phase: Phase) {
    setPhaseError(null);
    const resp = await client.call('project_phase_done', {
      workspaceId,
      phaseId: phase.id,
      idempotencyKey: idemKey('done'),
    });
    if (isErr(resp.body)) setPhaseError(resp.body);
    else {
      void loadDetail();
      onChanged();
    }
  }

  const pct =
    standing !== null && standing.budgetMinor > 0
      ? Math.min(100, Math.round((standing.actualCostMinor / standing.budgetMinor) * 100))
      : 0;

  // The drawer carries the title and the status word; this is the body under them.
  return (
    <div className="projects-detail">
      <div className="projects-detail-head">
        <div>
          <p className="projects-detail-meta">
            <span>{project.code}</span>
            {contactName !== undefined && <span> · {contactName}</span>}
            {project.startsOn !== null && (
              <span>
                {' '}
                · {formatDate(project.startsOn)}
                {project.endsOn !== null ? ` – ${formatDate(project.endsOn)}` : ''}
              </span>
            )}
          </p>
        </div>
        <div className="projects-detail-actions">
          {canManage &&
            NEXT_STATUSES[project.status].map((to) => (
              <button key={to} type="button" className="btn btn--secondary btn--sm" onClick={() => onStatus(to)}>
                {t(statusActionKey(project.status, to))}
              </button>
            ))}
          {canManage && (
            <OverflowMenu
              quiet
              label={t('project.list.rowActions', { name: project.name })}
              items={[
                { key: 'edit', label: t('project.action.edit'), onSelect: onEdit },
                ...(project.status === 'draft'
                  ? [{ key: 'delete', label: t('project.action.delete'), onSelect: onDelete, danger: true }]
                  : []),
              ]}
            />
          )}
        </div>
      </div>

      {!canManage && <p className="projects-readonly">{t('project.readonly')}</p>}

      {standing !== null && (
        <div className="projects-budget-panel">
          <h3>{t('project.budget.title')}</h3>
          <div
            className="projects-budget-bar"
            role="img"
            aria-label={t('project.budget.barLabel', { pct })}
          >
            <div className="projects-budget-bar-fill" style={{ transform: `scaleX(${pct / 100})` }} />
          </div>
          <dl className="projects-budget-figures">
            <div>
              <dt>{t('project.budget.budget')}</dt>
              <dd className="projects-num t-money">{formatMoney(standing.budgetMinor, standing.currency)}</dd>
            </div>
            <div>
              <dt>{t('project.budget.actual')}</dt>
              <dd className="projects-num t-money">{formatMoney(standing.actualCostMinor, standing.currency)}</dd>
            </div>
            <div>
              <dt>{t('project.budget.remaining')}</dt>
              <dd className="projects-num t-money">{formatMoney(standing.remainingMinor, standing.currency)}</dd>
            </div>
            <div>
              <dt>{t('project.budget.hours')}</dt>
              <dd className="projects-num t-num">
                {standing.actualHours} / {standing.budgetHours}
              </dd>
            </div>
          </dl>
          {standing.overBudget && (
            <p className="projects-over" role="status">
              <Status kind="warn" label={t('project.budget.over')} />
            </p>
          )}
        </div>
      )}

      {warning !== null && (
        <p className="projects-warning" role="status">
          <Status kind="warn" label={warning} />
        </p>
      )}
      {phaseError !== null && <ErrorBanner error={phaseError} />}

      <div className="projects-phases">
        <div className="projects-phases-head">
          <h3>{t('project.phase.title')}</h3>
          {canManage && project.status !== 'closed' && !adding && (
            <button type="button" className="btn btn--secondary btn--sm" onClick={() => setAdding(true)}>
              {t('project.phase.add')}
            </button>
          )}
        </div>

        {phases.length === 0 && !adding ? (
          <p className="projects-phases-empty">{t('project.phase.empty')}</p>
        ) : (
          <table className="projects-phase-table">
            <thead>
              <tr>
                <th scope="col">{t('project.phase.name')}</th>
                <th scope="col" className="projects-num">
                  {t('project.phase.budget')}
                </th>
                <th scope="col">{t('project.phase.milestone')}</th>
                <th scope="col">
                  <span className="visually-hidden">{t('project.phase.done')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {phases.map((phase) => (
                <tr key={phase.id}>
                  <td>{phase.name}</td>
                  <td className="projects-num t-money">
                    {phase.budgetMinor > 0 ? formatMoney(phase.budgetMinor, project.currency) : ''}
                  </td>
                  <td>{phase.milestoneOn !== null ? formatDate(phase.milestoneOn) : ''}</td>
                  <td>
                    {phase.doneAt !== null ? (
                      <Status kind="success" label={t('project.phase.doneOn', { date: formatDate(phase.doneAt) })} />
                    ) : (
                      canManage &&
                      project.status !== 'closed' && (
                        <button
                          type="button"
                          className="btn btn--secondary btn--sm"
                          aria-label={t('project.phase.markDone', { name: phase.name })}
                          onClick={() => void markDone(phase)}
                        >
                          {t('project.phase.done')}
                        </button>
                      )
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {adding && (
          <form
            className="projects-phase-form"
            onSubmit={(e) => {
              e.preventDefault();
              void addPhase();
            }}
          >
            <label className="projects-field">
              <span>{t('project.phase.name')}</span>
              <input className="field" type="text" value={phaseName} onChange={(e) => setPhaseName(e.target.value)} required />
            </label>
            <label className="projects-field">
              <span>{t('project.phase.budget')}</span>
              <input className="field" type="text" inputMode="decimal" value={phaseBudget} onChange={(e) => setPhaseBudget(e.target.value)} />
            </label>
            <label className="projects-field">
              <span>{t('project.phase.milestone')}</span>
              <input className="field" type="date" value={phaseMilestone} onChange={(e) => setPhaseMilestone(e.target.value)} />
            </label>
            <div className="projects-phase-form-actions">
              <button type="button" className="btn btn--secondary btn--sm" onClick={() => setAdding(false)}>
                {t('project.phase.cancel')}
              </button>
              <button type="submit" className="btn btn--primary btn--sm">
                {t('project.phase.save')}
              </button>
            </div>
          </form>
        )}
      </div>

      {/* B03: the Projekterfolg layer, its own A24 gate (US-B03.6), the rest of the page intact.
          Closed projects stay reportable (US-B03.5): no status condition here on purpose. */}
      {canCosting && <ProjectProfitability workspaceId={workspaceId} projectId={project.id} />}
    </div>
  );
}
