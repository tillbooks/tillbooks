/**
 * E02, Personal (`/personal`): the three HR-lite loops, each a tab: Mitarbeitende, Abwesenheiten,
 * Spesen. It is a route of its own (spec §6) because no existing financial surface may host
 * revDSG-gated personal data, and the access-gating (masked AHV, self-scoped lists, the four-eyes
 * approve CTA) needs a single owned surface.
 *
 * THE PERMISSION GATES HERE ARE A CONVENIENCE, NOT THE ENFORCEMENT (the standing Studio rule):
 * `whoami` is the one source, it fails open, and the engine is the real gate. AHV masking, the
 * self-scoping list filter and the self_approval refusal all live in the engine; this surface only
 * pre-hides the affordances an actor is about to be refused, and renders the engine's own rejection
 * code when a write is refused anyway. Status is always glyph AND label, never colour alone (WCAG 2.2).
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';

import { useClient } from '../../lib/client-context';
import { isErr, type Err } from '../../lib/client';
import { useCan } from '../../lib/capabilities';
import { useWorkspaceId } from '../../app/workspace';
import { useT, formatDate, formatMoney } from '../../i18n';
import { SurfaceHelp } from '../../components/SurfaceHelp';
import { SurfaceHeader } from '../../components/SurfaceHeader';
import { Tabs, type TabItem } from '../../components/Tabs';
import { DataTable, type DataTableColumn } from '../../components/DataTable';
import { EmptyState, ErrorBanner, NoWorkspaceState, PermissionDenied } from '../../components/states';
import { Status, type StatusKind } from '../../components/Status';
import { PayrollHandoff } from './PayrollHandoff';
import { LinkedFiles } from '../Files/LinkedFiles';
import './Hr.css';

const newKey = () => crypto.randomUUID();

type Tab = 'employees' | 'absences' | 'claims' | 'lohn';
const TABS: readonly Tab[] = ['employees', 'absences', 'claims', 'lohn'];

interface Employee {
  id: string;
  firstName: string;
  lastName: string;
  employmentPct: number;
  startsOn: string;
  ahvNr: string | null;
  ahvRestricted: boolean;
}
interface Absence {
  id: string;
  employeeId: string;
  kind: string;
  fromDate: string;
  toDate: string;
  status: string;
}
interface Claim {
  id: string;
  employeeId: string;
  title: string;
  status: string;
  currency: string;
  totalBaseMinor: number | null;
}

function arr(body: unknown, key: string): Record<string, unknown>[] | null {
  if (body === null || typeof body !== 'object') return null;
  const list = (body as Record<string, unknown>)[key];
  return Array.isArray(list) ? (list as Record<string, unknown>[]) : null;
}

/**
 * A claim's state as the one `Status` word (K-22): an icon-set glyph beside the word, never a text
 * glyph. A draft has nothing to act on yet, a submitted claim waits, approved and reimbursed are done,
 * rejected is refused, cancelled is out of play.
 */
const CLAIM_KIND: Record<string, StatusKind> = {
  draft: 'neutral',
  submitted: 'pending',
  approved: 'success',
  reimbursed: 'success',
  rejected: 'danger',
  cancelled: 'inactive',
};

export function Hr() {
  const t = useT();
  const client = useClient();
  const workspaceId = useWorkspaceId();
  const canManage = useCan('hr.manage');
  const canSubmit = useCan('spesen.submit');
  const canApprove = useCan('spesen.approve');

  const [tab, setTab] = useState<Tab>('employees');
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [absences, setAbsences] = useState<Absence[]>([]);
  const [claims, setClaims] = useState<Claim[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [denied, setDenied] = useState(false);
  const [writeError, setWriteError] = useState<Err | null>(null);
  const [addEmp, setAddEmp] = useState({ firstName: '', lastName: '', employmentPct: '100', startsOn: '' });
  const [creatingEmp, setCreatingEmp] = useState(false);
  // The claim whose Dateien panel is open. Clicking a claim's title toggles its E00 attachments
  // (the scanned receipt behind the reimbursement) open below the list; no per-claim drawer exists.
  const [openClaimId, setOpenClaimId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (workspaceId === null) {
      setLoading(false);
      return;
    }
    // The Lohn tab (A34) owns its own data (PayrollHandoff self-loads), so Hr fetches nothing for it.
    if (tab === 'lohn') { setLoading(false); setFailed(false); setDenied(false); return; }
    setLoading(true);
    setFailed(false);
    setDenied(false);
    const verb = tab === 'employees' ? 'hr_employee_list' : tab === 'absences' ? 'hr_absence_list' : 'expense_claim_list';
    const res = await client.call(verb, { workspaceId });
    if (isErr(res.body)) {
      if (res.body.error === 'permission_denied' || res.status === 403) setDenied(true);
      else setFailed(true);
      setLoading(false);
      return;
    }
    if (tab === 'employees') {
      const rows = arr(res.body, 'employees');
      if (rows === null) { setFailed(true); setLoading(false); return; }
      setEmployees(rows.map((r) => ({
        id: String(r.id), firstName: String(r.firstName ?? ''), lastName: String(r.lastName ?? ''),
        employmentPct: Number(r.employmentPct ?? 0), startsOn: String(r.startsOn ?? ''),
        ahvNr: typeof r.ahvNr === 'string' ? r.ahvNr : null, ahvRestricted: r.ahvRestricted === true,
      })));
    } else if (tab === 'absences') {
      const rows = arr(res.body, 'absences');
      if (rows === null) { setFailed(true); setLoading(false); return; }
      setAbsences(rows.map((r) => ({
        id: String(r.id), employeeId: String(r.employeeId ?? ''), kind: String(r.kind ?? 'other'),
        fromDate: String(r.fromDate ?? ''), toDate: String(r.toDate ?? ''), status: String(r.status ?? 'recorded'),
      })));
    } else {
      const rows = arr(res.body, 'claims');
      if (rows === null) { setFailed(true); setLoading(false); return; }
      setClaims(rows.map((r) => ({
        id: String(r.id), employeeId: String(r.employeeId ?? ''), title: String(r.title ?? ''),
        status: String(r.status ?? 'draft'), currency: String(r.currency ?? 'CHF'),
        totalBaseMinor: typeof r.totalBaseMinor === 'number' ? r.totalBaseMinor : null,
      })));
    }
    setLoading(false);
  }, [client, workspaceId, tab]);

  useEffect(() => { void load(); }, [load]);

  const write = useCallback(async (action: string, input: Record<string, unknown>): Promise<boolean> => {
    if (workspaceId === null) return false;
    setWriteError(null);
    const res = await client.call(action, { workspaceId, ...input });
    if (isErr(res.body)) { setWriteError(res.body); return false; }
    await load();
    return true;
  }, [client, workspaceId, load]);

  const createEmployee = useCallback(async () => {
    const ok = await write('hr_employee_upsert', {
      employee: { firstName: addEmp.firstName, lastName: addEmp.lastName, employmentPct: Number(addEmp.employmentPct), startsOn: addEmp.startsOn },
      idempotencyKey: newKey(),
    });
    if (ok) { setCreatingEmp(false); setAddEmp({ firstName: '', lastName: '', employmentPct: '100', startsOn: '' }); }
  }, [write, addEmp]);

  const employeeColumns: DataTableColumn<Employee>[] = [
    { key: 'name', header: t('hr.employee.name'), render: (e) => `${e.lastName}, ${e.firstName}` },
    { key: 'pct', header: t('hr.employee.pct'), numeric: true, render: (e) => `${e.employmentPct} %` },
    {
      key: 'ahv',
      header: t('hr.employee.ahv'),
      render: (e) =>
        e.ahvRestricted
          ? <Status kind="inactive" label={t('hr.employee.ahv_restricted')} />
          : (e.ahvNr ?? ''),
    },
    { key: 'startsOn', header: t('hr.employee.startsOn'), render: (e) => (e.startsOn === '' ? '' : formatDate(e.startsOn)) },
  ];

  const absenceColumns: DataTableColumn<Absence>[] = [
    {
      key: 'kind',
      header: t('hr.absence.col.kind'),
      // A kind of absence is a category, not a state: the word alone, no text glyph.
      render: (a) => t(`hr.absence.kind.${a.kind}`),
    },
    { key: 'range', header: t('hr.absence.col.period'), render: (a) => `${formatDate(a.fromDate)} – ${formatDate(a.toDate)}` },
    {
      key: 'status',
      header: t('hr.claim.status'),
      render: (a) => (a.status === 'cancelled' ? <Status kind="inactive" label={t('hr.absence.cancelled')} /> : ''),
    },
  ];

  const claimColumns: DataTableColumn<Claim>[] = [
    {
      key: 'title',
      header: t('hr.claim.title'),
      // The row opens the claim's Dateien below the list (K-21): the title is the leading cell.
      render: (c) => c.title,
    },
    {
      key: 'status',
      header: t('hr.claim.status'),
      render: (c) => <Status kind={CLAIM_KIND[c.status] ?? 'neutral'} label={t(`spesen.status.${c.status}`)} />,
    },
    { key: 'total', header: t('hr.claim.total'), numeric: true, render: (c) => (c.totalBaseMinor === null ? '' : formatMoney(c.totalBaseMinor, c.currency)) },
  ];

  // K-21: a claim's decisions sit behind its row's one overflow, Ablehnen last and marked destructive.
  const claimActions = (c: Claim) => [
    ...(c.status === 'submitted'
      ? [
          { key: 'approve', label: t('spesen.action.approve'), onSelect: () => void write('expense_claim_approve', { claimId: c.id, confirm: true, idempotencyKey: newKey() }) },
          { key: 'reject', label: t('spesen.action.reject'), danger: true, onSelect: () => void write('expense_claim_reject', { claimId: c.id, reason: t('spesen.reject.default'), idempotencyKey: newKey() }) },
        ]
      : []),
    ...(c.status === 'approved'
      ? [{ key: 'reimburse', label: t('spesen.action.reimburse'), onSelect: () => void write('expense_claim_reimburse', { claimId: c.id, confirm: true, idempotencyKey: newKey() }) }]
      : []),
  ];

  // The three data tabs share one loading/denied/failed pipeline keyed on the active tab (only the
  // active tab fetches), so denied/failed short-circuit the whole panel and DataTable owns loading
  // and empty. Non-active panels stay mounted-but-hidden, so their body is never seen.
  function renderPanel(id: Tab): ReactNode {
    if (id === 'lohn') {
      // Lazy: PayrollHandoff self-loads on mount, so it mounts only while the Lohn tab is active.
      return tab === 'lohn' ? <PayrollHandoff /> : null;
    }
    if (denied) return <PermissionDenied title={t('hr.denied.title')} body={t('hr.denied.body')} />;
    if (failed) return <ErrorBanner context="read" message={t('hr.error.load')} onRetry={() => void load()} />;
    if (id === 'employees') {
      return (
        <div className="hr-panel">
          {/* K-08: the add action lives in the page header at its natural width; its inline form
              opens here, the header button standing down while it is open. */}
          {canManage && creatingEmp && (
            <form className="hr-form" onSubmit={(e) => { e.preventDefault(); void createEmployee(); }}>
              <input className="field" aria-label={t('hr.employee.firstName')} placeholder={t('hr.employee.firstName')} value={addEmp.firstName} onChange={(e) => setAddEmp({ ...addEmp, firstName: e.target.value })} />
              <input className="field" aria-label={t('hr.employee.lastName')} placeholder={t('hr.employee.lastName')} value={addEmp.lastName} onChange={(e) => setAddEmp({ ...addEmp, lastName: e.target.value })} />
              <input className="field" aria-label={t('hr.employee.pct')} type="number" min={1} max={100} value={addEmp.employmentPct} onChange={(e) => setAddEmp({ ...addEmp, employmentPct: e.target.value })} />
              <input className="field" aria-label={t('hr.employee.startsOn')} type="date" value={addEmp.startsOn} onChange={(e) => setAddEmp({ ...addEmp, startsOn: e.target.value })} />
              <button type="submit" className="btn btn--primary">{t('hr.action.save')}</button>
              <button type="button" className="btn btn--ghost" onClick={() => setCreatingEmp(false)}>{t('hr.action.cancel')}</button>
            </form>
          )}
          <DataTable
            columns={employeeColumns}
            rows={employees}
            rowKey={(e) => e.id}
            loading={loading}
            caption={t('hr.tab.employees')}
            emptyState={
              <EmptyState
                title={t('hr.empty.employees')}
                {...(canManage ? { action: { label: t('hr.action.add'), onClick: () => setCreatingEmp(true) } } : {})}
              />
            }
          />
        </div>
      );
    }
    if (id === 'absences') {
      return (
        <div className="hr-panel">
          <DataTable
            columns={absenceColumns}
            rows={absences}
            rowKey={(a) => a.id}
            loading={loading}
            caption={t('hr.tab.absences')}
            rowClassName={(a) => (a.status === 'cancelled' ? 'hr-cancelled' : undefined)}
            emptyState={<EmptyState title={t('hr.empty.absences')} />}
          />
        </div>
      );
    }
    return (
      <div className="hr-panel">
        <DataTable
          columns={claimColumns}
          rows={claims}
          rowKey={(c) => c.id}
          loading={loading}
          caption={t('hr.tab.claims')}
          emptyState={<EmptyState title={t('hr.empty.claims')} />}
          onRowClick={(c) => setOpenClaimId((prev) => (prev === c.id ? null : c.id))}
          rowLabel={(c) => c.title}
          isRowCurrent={(c) => c.id === openClaimId}
          rowActions={canApprove ? claimActions : undefined}
          rowActionsLabel={(c) => t('spesen.rowActions', { title: c.title })}
        />
        {!canSubmit && !canApprove && <p className="hr-hint">{t('hr.claim.readonly')}</p>}
        {/* E00: the shared Dateien panel for the open claim, parameterised by the OP3 pair. The scanned
            receipt a Spesenantrag reimburses is filed here, in the ONE attachment UI, never a copy. */}
        {openClaimId !== null && workspaceId !== null && claims.some((c) => c.id === openClaimId) && (
          <LinkedFiles workspaceId={workspaceId} entityKind="expense_claim" entityId={openClaimId} />
        )}
      </div>
    );
  }

  if (workspaceId === null) return <NoWorkspaceState body={t('hr.noWorkspace')} />;

  const tabs: TabItem[] = TABS.map((id) => ({ id, label: t(`hr.tab.${id}`), panel: renderPanel(id) }));

  return (
    <section className="hr" aria-labelledby="hr-title">
      <SurfaceHeader
        title={t('hr.route.title')}
        titleId="hr-title"
        help={<SurfaceHelp surface="Hr" />}
        actions={
          tab === 'employees' && canManage && !creatingEmp ? (
            <button type="button" className="btn btn--primary" onClick={() => setCreatingEmp(true)}>
              {t('hr.action.add')}
            </button>
          ) : undefined
        }
      />

      {writeError !== null && <ErrorBanner error={writeError} message={t(`hr.error.${writeError.error}`)} />}

      <Tabs tabs={tabs} activeId={tab} onChange={(id) => setTab(id as Tab)} label={t('hr.route.title')} />
    </section>
  );
}

export default Hr;
