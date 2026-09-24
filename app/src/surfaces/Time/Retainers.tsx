/**
 * B04, the Mandate tab, mounted on B01's `/time` route (spec §6: no new Studio route, a retainer's
 * drawdown is a TIME decision so it lives with time; the invoice document is A11's, so the draft chip
 * deep-links to the existing `/documents` editor).
 *
 * A file DISJOINT from `Time.tsx` (B01) and `Unbilled.tsx` (B02): B04 owns this component and Time
 * mounts it with one line. It reads `retainer_list` and, per row, `retainer_burndown` for the current
 * period, rendering the burn-down as a glyph+number bar (never colour alone, WCAG 2.2 AA). The
 * create/generate/close/run-due controls are HIDDEN without `retainer.manage` (spec §6: never
 * shown-then-rejected); the whole tab shows a lock state when even `billing.read` is missing.
 */
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { useClient } from '../../lib/client-context';
import { isErr, type Err } from '../../lib/client';
import { CAP, useCapabilities } from '../../lib/capabilities';
import { useWorkspaceId } from '../../app/workspace';
import { useT, formatDate, formatMoney } from '../../i18n';
import { EmptyState, ErrorBanner, PermissionDenied, Skeleton } from '../../components/states';
import { DataTable, type DataTableColumn } from '../../components/DataTable';
import { Select } from '../../components/Select';
import { Status, type StatusKind } from '../../components/Status';
import { formatMinutes } from './model';
import './Retainers.css';

const newKey = () => crypto.randomUUID();

interface Retainer {
  id: string;
  contactId: string;
  projectId: string | null;
  period: 'monthly' | 'quarterly';
  feeRappen: number;
  includedHours: number;
  capRappen: number | null;
  rollover: boolean;
  currency: string;
  startsOn: string;
  status: 'draft' | 'active' | 'ended';
}

interface BurnDown {
  periodKey: string;
  generated: boolean;
  includedMinutes: number;
  carryoverInMinutes: number;
  coverageMinutes: number;
  consumedMinutes: number;
  coveredMinutes: number;
  remainingMinutes: number;
  overCapMinutes: number;
  capRappen: number | null;
}

function parseRetainers(body: unknown): Retainer[] {
  const raw = (body as { retainers?: unknown })?.retainers;
  if (!Array.isArray(raw)) return [];
  return raw.filter((r): r is Retainer => r !== null && typeof r === 'object' && typeof (r as { id?: unknown }).id === 'string');
}

/** The period_key that CONTAINS a month input (`YYYY-MM`), for the retainer's period type. */
function periodKeyFromMonth(period: 'monthly' | 'quarterly', month: string): string {
  if (period === 'monthly') return month;
  const year = month.slice(0, 4);
  const m = Number(month.slice(5, 7));
  return `${year}-Q${Math.floor((m - 1) / 3) + 1}`;
}

/** A retainer's state as the one `Status` word (K-22): a running retainer is under way. */
const RETAINER_STATUS_KIND: Record<string, StatusKind> = { active: 'pending', closed: 'inactive' };

export function Retainers() {
  const t = useT();
  const client = useClient();
  const workspaceId = useWorkspaceId();
  const navigate = useNavigate();
  const { can } = useCapabilities();

  const canRead = can(CAP.billingRead);
  const canManage = can(CAP.retainerManage);

  const [retainers, setRetainers] = useState<Retainer[]>([]);
  const [burn, setBurn] = useState<Map<string, BurnDown>>(new Map());
  const [contactNames, setContactNames] = useState<Map<string, string>>(new Map());
  const [contacts, setContacts] = useState<{ id: string; name: string }[]>([]);
  const [projects, setProjects] = useState<{ id: string; label: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [denied, setDenied] = useState(false);
  const [writeError, setWriteError] = useState<Err | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState({ contactId: '', projectId: '', period: 'monthly', fee: '', includedHours: '', cap: '', rollover: false, startsOn: '' });
  const [genFor, setGenFor] = useState<string | null>(null);
  const [genMonth, setGenMonth] = useState('');

  const load = useCallback(async () => {
    if (workspaceId === null || !canRead) {
      setLoading(false);
      if (!canRead) setDenied(true);
      return;
    }
    setLoading(true);
    setFailed(false);
    setDenied(false);
    const [listed, contactList, projectList] = await Promise.all([
      client.call('retainer_list', { workspaceId }),
      client.call('list_contacts', { workspaceId }),
      client.call('project_list', { workspaceId }),
    ]);
    if (!isErr(contactList.body)) {
      const raw = (contactList.body as { contacts?: unknown }).contacts;
      if (Array.isArray(raw)) {
        const parsed = raw
          .filter((c): c is { id: string; name?: string } => c !== null && typeof c === 'object' && typeof (c as { id?: unknown }).id === 'string')
          .map((c) => ({ id: c.id, name: c.name ?? c.id }));
        setContacts(parsed);
        setContactNames(new Map(parsed.map((c) => [c.id, c.name])));
      }
    }
    if (!isErr(projectList.body)) {
      const raw = (projectList.body as { projects?: unknown }).projects;
      if (Array.isArray(raw)) {
        setProjects(
          raw
            .filter((p): p is { id: string; code?: string; name?: string } => p !== null && typeof p === 'object' && typeof (p as { id?: unknown }).id === 'string')
            .map((p) => ({ id: p.id, label: `${p.code ?? ''} ${p.name ?? ''}`.trim() })),
        );
      }
    }
    if (isErr(listed.body)) {
      if (listed.body.error === 'permission_denied' || listed.status === 403) setDenied(true);
      else setFailed(true);
      setLoading(false);
      return;
    }
    const parsed = parseRetainers(listed.body);
    setRetainers(parsed);
    // The burn-down read model per row, current period (P5, live).
    const burndowns = await Promise.all(parsed.map((r) => client.call('retainer_burndown', { workspaceId, retainerId: r.id })));
    const map = new Map<string, BurnDown>();
    burndowns.forEach((res, i) => {
      const row = parsed[i];
      if (row !== undefined && !isErr(res.body)) map.set(row.id, res.body as unknown as BurnDown);
    });
    setBurn(map);
    setLoading(false);
  }, [client, workspaceId, canRead]);

  useEffect(() => {
    void load();
  }, [load]);

  const write = useCallback(
    async (action: string, input: Record<string, unknown>): Promise<Record<string, unknown> | null> => {
      if (workspaceId === null) return null;
      setWriteError(null);
      setBusy(true);
      const response = await client.call(action, { workspaceId, ...input });
      setBusy(false);
      if (isErr(response.body)) {
        setWriteError(response.body);
        return null;
      }
      await load();
      return response.body as unknown as Record<string, unknown>;
    },
    [client, workspaceId, load],
  );

  const contactLabel = useCallback((id: string) => contactNames.get(id) ?? id, [contactNames]);

  const createRetainer = useCallback(async () => {
    setWarning(null);
    const fee = Math.round(Number(draft.fee) * 100);
    const cap = draft.cap === '' ? undefined : Math.round(Number(draft.cap) * 100);
    const body = await write('retainer_create', {
      contactId: draft.contactId,
      ...(draft.projectId === '' ? {} : { projectId: draft.projectId }),
      period: draft.period,
      feeRappen: Number.isFinite(fee) ? fee : draft.fee,
      includedHours: draft.includedHours === '' ? 0 : Math.trunc(Number(draft.includedHours)),
      ...(cap === undefined ? {} : { capRappen: cap }),
      rollover: draft.rollover,
      startsOn: draft.startsOn,
      idempotencyKey: newKey(),
    });
    if (body !== null) {
      if (body.warning === 'cap_below_included') setWarning(t('retainer.warning.cap_below_included'));
      setCreating(false);
      setDraft({ contactId: '', projectId: '', period: 'monthly', fee: '', includedHours: '', cap: '', rollover: false, startsOn: '' });
    }
  }, [write, draft, t]);

  const generate = useCallback(
    async (retainer: Retainer) => {
      if (genMonth === '') return;
      const body = await write('retainer_generate_invoice', {
        retainerId: retainer.id,
        periodKey: periodKeyFromMonth(retainer.period, genMonth),
        idempotencyKey: newKey(),
      });
      if (body !== null) {
        setGenFor(null);
        setGenMonth('');
        const invoiceId = (body as { invoiceId?: string }).invoiceId;
        if (typeof invoiceId === 'string') navigate(`/documents/${invoiceId}`);
      }
    },
    [write, genMonth, navigate],
  );

  const errorMessage = (error: Err): string => {
    const known = [
      'invalid_fee',
      'invalid_hours',
      'period_not_closed',
      'period_pending',
      'retainer_not_found',
      'retainer_not_active',
      'invalid_period_key',
      'currency_mismatch',
      'retainer_has_draws',
      'retainer_ended',
    ];
    if (known.includes(error.error)) return t(`retainer.error.${error.error}`);
    if (error.error === 'permission_denied') return t('retainer.error.permissionDenied');
    return t('retainer.error.transport');
  };

  // The retainer list is the shared DataTable now (D118 B2). The fee is numeric (right-aligned,
  // tabular); the burn-down stays a glyph+number bar (never colour alone); the actions column hosts
  // the Generieren/Beenden controls, the inline generate form and the "seit" date.
  const retainerColumns: DataTableColumn<Retainer>[] = [
    { key: 'contact', header: t('retainer.col.contact'), render: (r) => contactLabel(r.contactId) },
    {
      key: 'period',
      header: t('retainer.col.period'),
      render: (r) => t(`retainer.field.period.${r.period}`),
    },
    {
      key: 'fee',
      header: t('retainer.col.fee'),
      numeric: true,
      render: (r) => formatMoney(r.feeRappen, r.currency),
    },
    {
      key: 'burndown',
      header: t('retainer.col.burndown'),
      render: (r) => {
        const b = burn.get(r.id);
        if (b === undefined) return '–';
        const pct = b.coverageMinutes > 0 ? Math.min(100, Math.round((b.coveredMinutes / b.coverageMinutes) * 100)) : 0;
        return (
          <div className="retainer-burn" role="group" aria-label={t('retainer.col.burndown')}>
            <div className="retainer-burn-bar" aria-hidden="true">
              <span className="retainer-burn-fill" style={{ transform: `scaleX(${pct / 100})` }} />
            </div>
            <span className="retainer-burn-label">
              {formatMinutes(b.coveredMinutes)} / {formatMinutes(b.coverageMinutes)}
              {b.carryoverInMinutes > 0 && ` (${t('retainer.burndown.carryover')} ${formatMinutes(b.carryoverInMinutes)})`}
              {b.overCapMinutes > 0 && (
                <>
                  {' '}
                  <Status
                    className="retainer-overcap"
                    kind="warn"
                    label={`${t('retainer.burndown.overcap')} ${formatMinutes(b.overCapMinutes)}`}
                  />
                </>
              )}
            </span>
          </div>
        );
      },
    },
    {
      key: 'status',
      header: t('retainer.col.status'),
      render: (r) => (
        <Status kind={RETAINER_STATUS_KIND[r.status] ?? 'neutral'} label={t(`retainer.status.${r.status}`)} />
      ),
    },
    { key: 'since', header: t('retainer.col.since'), render: (r) => formatDate(r.startsOn) },
  ];

  // K-21: Generieren and Beenden sit behind the row's one overflow; Beenden, which ends the retainer,
  // comes last and is marked destructive.
  const retainerActions = (r: Retainer) =>
    r.status === 'active'
      ? [
          { key: 'generate', label: t('retainer.action.generate'), onSelect: () => { setGenFor(r.id); setGenMonth(''); } },
          {
            key: 'close',
            label: t('retainer.action.close'),
            danger: true,
            disabled: busy,
            onSelect: () => void write('retainer_close', { retainerId: r.id, idempotencyKey: newKey() }),
          },
        ]
      : [];
  const generating = genFor === null ? undefined : retainers.find((r) => r.id === genFor);

  if (!canRead || denied) {
    return (
      <section className="retainer" aria-labelledby="retainer-title">
        <h2 id="retainer-title" className="time-rates-title">
          {t('retainer.tab.title')}
        </h2>
        <PermissionDenied body={t('retainer.error.permissionDenied')} />
      </section>
    );
  }

  return (
    <section className="retainer" aria-labelledby="retainer-title">
      <div className="retainer-head">
        <h2 id="retainer-title" className="time-rates-title">
          {t('retainer.tab.title')}
        </h2>
        {canManage && retainers.length > 0 && (
          <div className="retainer-head-actions">
            <button
              type="button"
              className="btn btn--secondary btn--sm"
              disabled={busy}
              onClick={() => void write('retainer_run_due', {})}
            >
              {t('retainer.action.runDue')}
            </button>
            <button type="button" className="btn btn--secondary btn--sm" onClick={() => setCreating(!creating)}>
              {t('retainer.action.create')}
            </button>
          </div>
        )}
      </div>

      {writeError !== null && <ErrorBanner message={errorMessage(writeError)} />}
      {warning !== null && (
        <p className="retainer-warn" role="note">
          <Status kind="warn" label={warning} />
        </p>
      )}
      {failed && <ErrorBanner context="read" message={t('retainer.error.transport')} onRetry={() => void load()} />}

      {canManage && creating && (
        <form
          className="time-editor retainer-form"
          aria-label={t('retainer.action.create')}
          onSubmit={(e) => {
            e.preventDefault();
            void createRetainer();
          }}
        >
          <div className="time-field">
            <span>{t('retainer.field.contact')}</span>
            <Select
              value={draft.contactId}
              onChange={(val) => setDraft({ ...draft, contactId: val })}
              options={[
                { value: '', label: t('retainer.field.contactPlaceholder') },
                ...contacts.map((c) => ({ value: c.id, label: c.name })),
              ]}
              ariaLabel={t('retainer.field.contact')}
            />
          </div>
          <div className="time-field">
            <span>{t('retainer.field.project')}</span>
            <Select
              value={draft.projectId}
              onChange={(val) => setDraft({ ...draft, projectId: val })}
              options={[
                { value: '', label: t('retainer.field.projectAll') },
                ...projects.map((p) => ({ value: p.id, label: p.label })),
              ]}
              ariaLabel={t('retainer.field.project')}
            />
          </div>
          <div className="time-field">
            <span>{t('retainer.field.periodLabel')}</span>
            <Select
              value={draft.period}
              onChange={(val) => setDraft({ ...draft, period: val })}
              options={[
                { value: 'monthly', label: t('retainer.field.period.monthly') },
                { value: 'quarterly', label: t('retainer.field.period.quarterly') },
              ]}
              ariaLabel={t('retainer.field.periodLabel')}
            />
          </div>
          <label className="time-field">
            <span>{t('retainer.field.fee')}</span>
            <input className="field" type="number" min="0.05" step="0.05" value={draft.fee} onChange={(e) => setDraft({ ...draft, fee: e.target.value })} required />
          </label>
          <label className="time-field">
            <span>{t('retainer.field.included')}</span>
            <input className="field" type="number" min="0" value={draft.includedHours} onChange={(e) => setDraft({ ...draft, includedHours: e.target.value })} />
          </label>
          <label className="time-field">
            <span>{t('retainer.field.cap')}</span>
            <input className="field" type="number" min="0.05" step="0.05" value={draft.cap} onChange={(e) => setDraft({ ...draft, cap: e.target.value })} />
          </label>
          <label className="time-field">
            <span>{t('retainer.field.startsOn')}</span>
            <input className="field" type="date" value={draft.startsOn} onChange={(e) => setDraft({ ...draft, startsOn: e.target.value })} required />
          </label>
          <label className="time-field time-field--check">
            <input type="checkbox" checked={draft.rollover} onChange={(e) => setDraft({ ...draft, rollover: e.target.checked })} />
            <span>{t('retainer.field.rollover')}</span>
          </label>
          <div className="time-editor-actions">
            <button type="submit" className="btn btn--secondary btn--sm" disabled={busy}>
              {t('retainer.action.create')}
            </button>
            <button type="button" className="btn btn--secondary btn--sm" onClick={() => setCreating(false)}>
              {t('retainer.action.cancel')}
            </button>
          </div>
        </form>
      )}

      {loading ? (
        <div role="status" aria-busy="true" aria-live="polite">
          <span className="visually-hidden">{t('retainer.loading')}</span>
          <Skeleton rows={3} height={36} />
        </div>
      ) : retainers.length === 0 ? (
        <EmptyState
          title={t('retainer.emptyTitle')}
          hint={t('retainer.emptyHint')}
          {...(canManage ? { action: { label: t('retainer.action.create'), onClick: () => setCreating(true) } } : {})}
        />
      ) : (
        <>
          <DataTable
            columns={retainerColumns}
            rows={retainers}
            rowKey={(r) => r.id}
            caption={t('retainer.tableCaption')}
            rowActions={canManage ? retainerActions : undefined}
            rowActionsLabel={(r) => t('retainer.rowActions', { contact: contactLabel(r.contactId) })}
            isRowCurrent={(r) => r.id === genFor}
          />
          {/* The period a retainer bills for, asked under the table (K-21), not inside a cell. */}
          {generating !== undefined && (
            <form
              className="time-editor"
              aria-label={t('retainer.action.generate')}
              onSubmit={(e) => {
                e.preventDefault();
                void generate(generating);
              }}
            >
              <label className="time-field">
                <span>{t('retainer.field.genPeriod')}</span>
                <input className="field" type="month" value={genMonth} onChange={(e) => setGenMonth(e.target.value)} required />
              </label>
              <div className="time-editor-actions">
                <button type="submit" className="btn btn--secondary btn--sm" disabled={busy || genMonth === ''}>
                  {t('retainer.action.generate')}
                </button>
                <button type="button" className="btn btn--ghost btn--sm" onClick={() => setGenFor(null)}>
                  {t('retainer.action.cancel')}
                </button>
              </div>
            </form>
          )}
        </>
      )}
    </section>
  );
}

export default Retainers;
