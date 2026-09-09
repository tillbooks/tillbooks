/**
 * Projects, the B00 master surface (spec §6): the cluster-B entry point.
 *
 * Left-to-right: a filterable, nested project list (status glyph+label per row, children indented
 * under their parent) and a detail panel for the selected project: header with the status menu and
 * the ⋯ overflow (Löschen only on a draft, the twin of the draft-only `project_delete`), the
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
import { EmptyState, ErrorBanner, NoWorkspaceState, PermissionDenied, Skeleton } from '../../components/states';
import { DataTable, type DataTableColumn } from '../../components/DataTable';
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
  STATUS_GLYPHS,
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

  if (loading) {
    return (
      <div className="projects">
        {header()}
        <Skeleton rows={6} height={40} />
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
        <ErrorBanner error={error} onRetry={() => void load()} />
      </div>
    );
  }

  const hasProjects = projects.length > 0;

  const createButton = canManage ? (
    <button type="button" className="btn btn--primary" onClick={() => setDrawer({ mode: 'create' })}>
      {t('project.action.create')}
    </button>
  ) : undefined;

  // The filtered-empty state offers a way back rather than a dead end (DESIGN.md: every state says
  // what to do next). DataTable renders it when the filter hides every row.
  const emptyState = (
    <EmptyState
      title={t('project.emptySearch')}
      action={{
        label: t('project.clearSearch'),
        onClick: () => {
          setSearch('');
          setStatusFilter('');
        },
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
      render: ({ project }) => <StatusChip status={project.status} />,
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
    {
      key: 'actions',
      header: t('project.col.actions'),
      headerHidden: true,
      align: 'end',
      render: ({ project }) => {
        if (!canManage) return null;
        const actions = [
          { key: 'edit', label: t('project.action.edit'), onSelect: () => setDrawer({ mode: 'edit', project }) },
          // Destructive LAST and `danger`, only ever offered on a draft: the twin of the draft-only verb.
          ...(project.status === 'draft'
            ? [{ key: 'delete', label: t('project.action.delete'), onSelect: () => setPendingDelete(project), danger: true }]
            : []),
        ];
        // The overflow lives inside a clickable row, so its own click/keyboard must not also select
        // the row underneath it (and an Enter on the trigger must reach the trigger, not be swallowed
        // by the row's activation handler).
        return (
          <span
            className="projects-actions-cell"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          >
            <OverflowMenu label={t('project.list.rowActions', { name: project.name })} items={actions} />
          </span>
        );
      },
    },
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
        <div className="projects-layout">
          <div className="projects-list-pane">
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
              <label className="projects-status-filter">
                <span className="visually-hidden">{t('project.list.statusFilter')}</span>
                <select
                  className="field"
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value as '' | ProjectStatus)}
                >
                  <option value="">{t('project.list.allStatuses')}</option>
                  {PROJECT_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {t(`project.status.${s}`)}
                    </option>
                  ))}
                </select>
              </label>
            </FilterBar>

            <DataTable
              columns={columns}
              rows={rows}
              rowKey={({ project }) => project.id}
              caption={t('project.list.aria')}
              emptyState={emptyState}
              onRowClick={({ project }) => setSelectedId(project.id)}
              rowLabel={({ project }) => `${project.code} ${project.name}`}
              rowClassName={({ project, isChild }) =>
                [isChild ? 'projects-row--child' : undefined, project.id === selectedId ? 'projects-row--active' : undefined]
                  .filter(Boolean)
                  .join(' ') || undefined
              }
            />
          </div>

          {selected !== null ? (
            <ProjectDetail
              key={selected.id}
              workspaceId={workspaceId}
              project={selected}
              contactName={contactName.get(selected.contactId)}
              canManage={canManage}
              canCosting={canCosting}
              onStatus={(status) => void setStatus(selected, status)}
              onEdit={() => setDrawer({ mode: 'edit', project: selected })}
              onDelete={() => setPendingDelete(selected)}
              onChanged={() => void load()}
            />
          ) : (
            // The success state's unselected sub-state: a prompt to pick a row, never a blank
            // second column (DESIGN.md: every state says what to do next).
            <p className="projects-detail-placeholder panel">{t('project.detail.pickPrompt')}</p>
          )}
        </div>
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

/** The glyph+label status chip. The glyph is decorative; the label carries the meaning. */
function StatusChip({ status }: { status: ProjectStatus }) {
  const t = useT();
  return (
    <span className={`projects-status projects-status--${status}`}>
      <span aria-hidden="true">{STATUS_GLYPHS[status]}</span> {t(`project.status.${status}`)}
    </span>
  );
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

  return (
    <section className="projects-detail panel" aria-label={project.name}>
      <div className="projects-detail-head">
        <div>
          <h2 className="projects-detail-title">{project.name}</h2>
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
          <StatusChip status={project.status} />
          {canManage &&
            NEXT_STATUSES[project.status].map((to) => (
              <button key={to} type="button" className="btn btn--secondary btn--sm" onClick={() => onStatus(to)}>
                {t(statusActionKey(project.status, to))}
              </button>
            ))}
          {canManage && (
            <OverflowMenu
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
            <div className="projects-budget-bar-fill" style={{ width: `${pct}%` }} />
          </div>
          <dl className="projects-budget-figures">
            <div>
              <dt>{t('project.budget.budget')}</dt>
              <dd className="projects-num">{formatMoney(standing.budgetMinor, standing.currency)}</dd>
            </div>
            <div>
              <dt>{t('project.budget.actual')}</dt>
              <dd className="projects-num">{formatMoney(standing.actualCostMinor, standing.currency)}</dd>
            </div>
            <div>
              <dt>{t('project.budget.remaining')}</dt>
              <dd className="projects-num">{formatMoney(standing.remainingMinor, standing.currency)}</dd>
            </div>
            <div>
              <dt>{t('project.budget.hours')}</dt>
              <dd className="projects-num">
                {standing.actualHours} / {standing.budgetHours}
              </dd>
            </div>
          </dl>
          {standing.overBudget && (
            <p className="projects-over" role="status">
              <span aria-hidden="true">⚠ </span>
              {t('project.budget.over')}
            </p>
          )}
        </div>
      )}

      {warning !== null && (
        <p className="projects-warning" role="status">
          <span aria-hidden="true">⚠ </span>
          {warning}
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
                  <td className="projects-num">
                    {phase.budgetMinor > 0 ? formatMoney(phase.budgetMinor, project.currency) : ''}
                  </td>
                  <td>{phase.milestoneOn !== null ? formatDate(phase.milestoneOn) : ''}</td>
                  <td>
                    {phase.doneAt !== null ? (
                      <span className="projects-phase-done">
                        <span aria-hidden="true">✓ </span>
                        {t('project.phase.doneOn', { date: formatDate(phase.doneAt) })}
                      </span>
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
              <input type="text" value={phaseName} onChange={(e) => setPhaseName(e.target.value)} required />
            </label>
            <label className="projects-field">
              <span>{t('project.phase.budget')}</span>
              <input type="text" inputMode="decimal" value={phaseBudget} onChange={(e) => setPhaseBudget(e.target.value)} />
            </label>
            <label className="projects-field">
              <span>{t('project.phase.milestone')}</span>
              <input type="date" value={phaseMilestone} onChange={(e) => setPhaseMilestone(e.target.value)} />
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
    </section>
  );
}
