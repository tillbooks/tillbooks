/**
 * B02, the Unverrechnet panel and the WIP card, mounted on B01's `/time` route (spec §6: no new
 * Studio route, billing selection is a TIME decision so it lives with time; the invoice document is
 * A11's, so the CTA hands off to the existing `/documents` editor).
 *
 * A file DISJOINT from `Time.tsx` (B01's surface): B02 owns this component and mounts it with one
 * line in Time. It reads `billing_unbilled_preview` (grouped contact -> project -> phase, every value
 * round-once from the engine, P1: the panel renders exactly the numbers the tool returns) and
 * `billing_wip_report`. The Rechnungsentwurf-erstellen CTA is HIDDEN without `billing.generate` (spec
 * §6: never shown-then-rejected); the whole panel shows a lock state when even `billing.read` is
 * missing. One invoice, one debtor: the CTA enables only when the selection is a single contact.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { useClient } from '../../lib/client-context';
import { isErr, type Err } from '../../lib/client';
import { CAP, useCapabilities } from '../../lib/capabilities';
import { useWorkspaceId } from '../../app/workspace';
import { useT, formatDate, formatMoney } from '../../i18n';
import { EmptyState, ErrorBanner, PermissionDenied, Skeleton } from '../../components/states';
import { Status } from '../../components/Status';
import { DataTable, type DataTableColumn } from '../../components/DataTable';
import { formatMinutes } from './model';
import './Unbilled.css';

const newKey = () => crypto.randomUUID();

interface PreviewEntry {
  id: string;
  startedAt: string;
  minutes: number;
  notes: string | null;
  valueRappen: number;
}
interface PreviewPhase {
  phaseId: string | null;
  subtotalRappen: number;
  entries: PreviewEntry[];
}
interface PreviewProject {
  projectId: string;
  subtotalRappen: number;
  phases: PreviewPhase[];
}
interface PreviewContact {
  contactId: string | null;
  currency: string | null;
  subtotalRappen: number;
  projects: PreviewProject[];
}
interface WipRow {
  projectId: string;
  contactId: string | null;
  currency: string | null;
  wipRappen: number;
  minutes: number;
  oldestEntryDate: string | null;
  oldestEntryAgeDays: number | null;
}

function parseGroups(body: unknown): { groups: PreviewContact[]; totalRappen: number } | null {
  const raw = body as { groups?: unknown; totalRappen?: unknown };
  if (!Array.isArray(raw?.groups) || typeof raw?.totalRappen !== 'number') return null;
  return { groups: raw.groups as PreviewContact[], totalRappen: raw.totalRappen };
}
function parseWip(body: unknown): { rows: WipRow[]; totalRappen: number } | null {
  const raw = body as { rows?: unknown; totalRappen?: unknown };
  if (!Array.isArray(raw?.rows) || typeof raw?.totalRappen !== 'number') return null;
  return { rows: raw.rows as WipRow[], totalRappen: raw.totalRappen };
}

interface LabelMaps {
  project: (id: string) => string;
  contact: (id: string | null) => string;
}

export function Unbilled() {
  const t = useT();
  const client = useClient();
  const workspaceId = useWorkspaceId();
  const navigate = useNavigate();
  const { can } = useCapabilities();

  const canRead = can(CAP.billingRead);
  const canGenerate = can(CAP.billingGenerate);

  const [projectNames, setProjectNames] = useState<Map<string, string>>(new Map());
  const [contactNames, setContactNames] = useState<Map<string, string>>(new Map());
  const labels: LabelMaps = useMemo(
    () => ({
      project: (id: string) => projectNames.get(id) ?? id,
      contact: (id: string | null) => (id === null ? t('billing.noContact') : contactNames.get(id) ?? id),
    }),
    [projectNames, contactNames, t],
  );

  const [groups, setGroups] = useState<PreviewContact[]>([]);
  const [totalRappen, setTotalRappen] = useState(0);
  const [wip, setWip] = useState<WipRow[]>([]);
  const [wipTotal, setWipTotal] = useState(0);
  const [wipCurrency, setWipCurrency] = useState('CHF');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [entryContact, setEntryContact] = useState<Map<string, string | null>>(new Map());
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [denied, setDenied] = useState(false);
  const [writeError, setWriteError] = useState<Err | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (workspaceId === null || !canRead) {
      setLoading(false);
      if (!canRead) setDenied(true);
      return;
    }
    setLoading(true);
    setFailed(false);
    setDenied(false);
    const [preview, wipRes, projectList, contactList] = await Promise.all([
      client.call('billing_unbilled_preview', { workspaceId }),
      client.call('billing_wip_report', { workspaceId }),
      client.call('project_list', { workspaceId }),
      client.call('list_contacts', { workspaceId }),
    ]);
    if (!isErr(projectList.body)) {
      const raw = (projectList.body as { projects?: unknown }).projects;
      if (Array.isArray(raw)) {
        setProjectNames(
          new Map(
            raw
              .filter((p): p is { id: string; code?: string; name?: string } => p !== null && typeof p === 'object' && typeof (p as { id?: unknown }).id === 'string')
              .map((p) => [p.id, `${p.code ?? ''} ${p.name ?? ''}`.trim()]),
          ),
        );
      }
    }
    if (!isErr(contactList.body)) {
      const raw = (contactList.body as { contacts?: unknown }).contacts;
      if (Array.isArray(raw)) {
        setContactNames(
          new Map(
            raw
              .filter((c): c is { id: string; name?: string } => c !== null && typeof c === 'object' && typeof (c as { id?: unknown }).id === 'string')
              .map((c) => [c.id, c.name ?? c.id]),
          ),
        );
      }
    }
    if (isErr(preview.body)) {
      if (preview.body.error === 'permission_denied' || preview.status === 403) setDenied(true);
      else setFailed(true);
      setLoading(false);
      return;
    }
    const parsed = parseGroups(preview.body);
    if (parsed === null) {
      setFailed(true);
      setLoading(false);
      return;
    }
    setGroups(parsed.groups);
    setTotalRappen(parsed.totalRappen);
    const contactByEntry = new Map<string, string | null>();
    for (const c of parsed.groups) {
      for (const p of c.projects) {
        for (const ph of p.phases) {
          for (const e of ph.entries) contactByEntry.set(e.id, c.contactId);
        }
      }
    }
    setEntryContact(contactByEntry);
    setSelected((prev) => new Set([...prev].filter((id) => contactByEntry.has(id))));
    if (!isErr(wipRes.body)) {
      const w = parseWip(wipRes.body);
      if (w !== null) {
        setWip(w.rows);
        setWipTotal(w.totalRappen);
        setWipCurrency(w.rows.find((r) => r.currency !== null)?.currency ?? 'CHF');
      }
    }
    setLoading(false);
  }, [client, workspaceId, canRead]);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = useCallback((entryId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(entryId)) next.delete(entryId);
      else next.add(entryId);
      return next;
    });
  }, []);

  // One invoice, one debtor: the CTA is enabled only when every selected entry shares one contact.
  const selectionContacts = useMemo(() => {
    const set = new Set<string | null>();
    for (const id of selected) set.add(entryContact.get(id) ?? null);
    return set;
  }, [selected, entryContact]);
  const mixedSelection = selectionContacts.size > 1;
  const activeContact = selectionContacts.size === 1 ? [...selectionContacts][0] : null;

  const selectedTotal = useMemo(() => {
    let sum = 0;
    for (const c of groups) {
      for (const p of c.projects) {
        for (const ph of p.phases) {
          for (const e of ph.entries) if (selected.has(e.id)) sum += e.valueRappen;
        }
      }
    }
    return sum;
  }, [groups, selected]);

  const generate = useCallback(async () => {
    if (workspaceId === null || activeContact === null || selected.size === 0) return;
    setWriteError(null);
    setBusy(true);
    const response = await client.call('billing_generate_invoice', {
      workspaceId,
      contactId: activeContact,
      timeEntryIds: [...selected],
      idempotencyKey: newKey(),
    });
    setBusy(false);
    if (isErr(response.body)) {
      setWriteError(response.body);
      await load();
      return;
    }
    const invoiceId = (response.body as { invoiceId?: string }).invoiceId;
    setSelected(new Set());
    if (typeof invoiceId === 'string') navigate(`/documents/${invoiceId}`);
    else await load();
  }, [client, workspaceId, activeContact, selected, navigate, load]);

  const errorMessage = (error: Err): string => {
    const known = ['mixed_contacts', 'already_billed', 'currency_mismatch', 'invoice_not_draft', 'empty_selection'];
    if (known.includes(error.error)) return t(`billing.error.${error.error}`);
    return t('billing.error.transport');
  };

  // The WIP report is a flat table, so it is the shared DataTable now (D118 B2): value and duration
  // right-align tabular, the oldest-entry column left-aligns. The grouped Unverrechnet PILE above is a
  // contact -> project -> phase tree with colspanned group headers and a select column, which the flat
  // DataTable row model cannot express, so it stays a bespoke table (styled in Unbilled.css).
  const wipColumns: DataTableColumn<WipRow>[] = [
    { key: 'project', header: t('billing.col.project'), render: (r) => labels.project(r.projectId) },
    {
      key: 'value',
      header: t('billing.col.value'),
      numeric: true,
      render: (r) => formatMoney(r.wipRappen, r.currency ?? wipCurrency),
    },
    {
      key: 'duration',
      header: t('billing.col.duration'),
      numeric: true,
      render: (r) => formatMinutes(r.minutes),
    },
    {
      key: 'oldest',
      header: t('billing.wip.oldest'),
      render: (r) =>
        r.oldestEntryDate === null
          ? '–'
          : `${formatDate(r.oldestEntryDate)} (${r.oldestEntryAgeDays ?? 0} ${t('billing.wip.days')})`,
    },
  ];

  if (!canRead || denied) {
    return (
      <section className="time-billing" aria-labelledby="billing-title">
        <h2 id="billing-title" className="time-rates-title">
          {t('billing.section.title')}
        </h2>
        <PermissionDenied body={t('billing.error.permissionDenied')} />
      </section>
    );
  }

  return (
    <section className="time-billing" aria-labelledby="billing-title">
      <h2 id="billing-title" className="time-rates-title">
        {t('billing.section.title')}
      </h2>

      {writeError !== null && <ErrorBanner message={errorMessage(writeError)} />}
      {failed && <ErrorBanner context="read" message={t('billing.error.transport')} onRetry={() => void load()} />}

      {loading ? (
        <div role="status" aria-busy="true" aria-live="polite">
          <span className="visually-hidden">{t('billing.loading')}</span>
          <Skeleton rows={3} height={36} />
        </div>
      ) : groups.length === 0 ? (
        <EmptyState title={t('billing.empty.unbilled')} hint={t('billing.empty.hint')} />
      ) : (
        <>
          <table className="time-billing-tree">
            <thead>
              <tr>
                <th scope="col">
                  <span className="visually-hidden">{t('billing.col.select')}</span>
                </th>
                <th scope="col">{t('billing.col.item')}</th>
                <th scope="col" className="time-num">
                  {t('billing.col.duration')}
                </th>
                <th scope="col" className="time-num">
                  {t('billing.col.value')}
                </th>
              </tr>
            </thead>
            <tbody>
              {groups.map((c) => (
                <ContactBlock key={c.contactId ?? 'none'} contact={c} labels={labels} selected={selected} onToggle={toggle} t={t} />
              ))}
            </tbody>
          </table>

          <div className="time-billing-footer" role="status">
            <span>
              {t('billing.total')}: <b className="t-money">{formatMoney(totalRappen, groups[0]?.currency ?? 'CHF')}</b>
            </span>
            {selected.size > 0 && (
              <span>
                {t('billing.selected')}: <b className="t-money">{formatMoney(selectedTotal, groups.find((g) => g.contactId === activeContact)?.currency ?? 'CHF')}</b>
              </span>
            )}
            {canGenerate && (
              <button
                type="button"
                className="btn btn--secondary btn--sm"
                disabled={selected.size === 0 || mixedSelection || busy}
                onClick={() => void generate()}
              >
                {t('billing.action.generate_draft')}
              </button>
            )}
          </div>
          {mixedSelection && (
            <p className="time-hint" role="note">
              <Status kind="warn" label={t('billing.error.mixed_contacts')} />
            </p>
          )}
        </>
      )}

      <div className="time-billing-wip" aria-labelledby="billing-wip-title">
        <h3 id="billing-wip-title" className="time-billing-wip-title">
          {t('billing.wip.title')}
        </h3>
        {loading ? (
          <Skeleton rows={1} height={36} />
        ) : wip.length === 0 ? (
          <p className="time-rates-empty">{t('billing.wip.empty')}</p>
        ) : (
          <div className="time-billing-wip-card" role="group" aria-label={t('billing.wip.title')}>
            <div className="time-billing-wip-value t-money">{formatMoney(wipTotal, wipCurrency)}</div>
            <DataTable columns={wipColumns} rows={wip} rowKey={(r) => r.projectId} caption={t('billing.wip.tableCaption')} />
          </div>
        )}
      </div>
    </section>
  );
}

function ContactBlock({
  contact,
  labels,
  selected,
  onToggle,
  t,
}: {
  contact: PreviewContact;
  labels: LabelMaps;
  selected: Set<string>;
  onToggle: (id: string) => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  return (
    <>
      <tr className="time-billing-contact">
        <td colSpan={3}>
          <b>{labels.contact(contact.contactId)}</b>
        </td>
        <td className="time-num" data-money="">
          <b>{formatMoney(contact.subtotalRappen, contact.currency ?? 'CHF')}</b>
        </td>
      </tr>
      {contact.projects.map((p) =>
        p.phases.map((ph) =>
          ph.entries.map((e) => (
            <tr key={e.id}>
              <td>
                {/* K-14: the box sits in a 32px check cell, the dense-band target, and stays native. */}
                <label className="check-cell">
                  <input
                    type="checkbox"
                    checked={selected.has(e.id)}
                    onChange={() => onToggle(e.id)}
                    aria-label={t('billing.col.selectEntry', { project: labels.project(p.projectId) })}
                  />
                </label>
              </td>
              <td>
                {labels.project(p.projectId)}
                {e.notes !== null && <span className="time-notes"> · {e.notes}</span>}
              </td>
              <td className="time-num">{formatMinutes(e.minutes)}</td>
              <td className="time-num" data-money="">{formatMoney(e.valueRappen, contact.currency ?? 'CHF')}</td>
            </tr>
          )),
        ),
      )}
    </>
  );
}

export default Unbilled;
