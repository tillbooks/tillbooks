/**
 * S1, the Documents list (`/documents`): find, filter, and open any Beleg; start a new one.
 *
 * One unified list for all four types (A10's own surface: no separate /invoices route). Type tabs
 * drive a `?type=` filter that is URL-addressable so an agent-cited link lands on the same view. Status
 * is a WORD-ONLY chip (D19/U4), never colour alone; "überfällig" is a derived, dimmer second word
 * (INV-4), never a stored P7 status. Destructive row actions (Löschen a draft, Stornieren a posted
 * document) live one level down in the per-row overflow (D15/C2) behind a confirm.
 *
 * D118 B2: the hand-rolled `<table>` and its five states are the shared DataTable now, and the page
 * header is the shared SurfaceHeader. The type-filter strip stays bespoke: it is a URL-driven filter
 * over ONE shared table, not the primitive Tabs' panel-per-tab model, so adopting Tabs would be the
 * wrong archetype. Money renders VERBATIM from `list_documents`: the transaction total, and the
 * engine's own base-currency total where a posting stamped one. The client sums and rounds nothing.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';

import { useClient } from '../../lib/client-context';
import { isErr, type Err } from '../../lib/client';
import { useWorkspaceId } from '../../app/workspace';
import { useT, formatMoney, formatDate } from '../../i18n';
import { SurfaceHelp } from '../../components/SurfaceHelp';
import { SurfaceHeader } from '../../components/SurfaceHeader';
import { DataTable, type DataTableColumn } from '../../components/DataTable';
import { EmptyState, ErrorBanner, NoWorkspaceState, PermissionDenied } from '../../components/states';
import { OverflowMenu } from '../../components/OverflowMenu';
import { useCan, CAP } from '../../lib/capabilities';
import { ConfirmDialog } from '../Accounts/ConfirmDialog';
import {
  DOCUMENT_TYPES,
  documentActions,
  idemKey,
  postedBaseFigures,
  statusKey,
  typeKey,
  type DocumentAction,
  type DocumentDto,
  type DocumentType,
} from './model';

interface Contact {
  id: string;
  name: string;
}

type TypeFilter = DocumentType | 'all';

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

/** INV-4: overdue is derived at read time (due date passed, not settled/cancelled), never stored. */
function isOverdue(doc: DocumentDto): boolean {
  if (doc.dueDate === null) return false;
  if (doc.status === 'settled' || doc.status === 'cancelled' || doc.status === 'draft') return false;
  return doc.dueDate < new Date().toISOString().slice(0, 10);
}

/** The terminal states that carry no money forward; the row reads a step quieter (a lightness cue,
 *  never colour alone: the status WORD still names the state). Draft is the pre-issue state. */
const VOID_STATES = new Set(['cancelled', 'declined', 'expired', 'superseded']);

export function Documents() {
  const t = useT();
  const client = useClient();
  const workspaceId = useWorkspaceId();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  /**
   * THE PADLOCK (A24, F5 retrofit). Creating, editing and every list-reachable transition of a
   * document gates on `issue` (the engine's rule for `transition_document` reads the target and
   * demands `send` only for `to: 'sent'`, which no LIST affordance offers). Affordances are ABSENT
   * without it; `useCan` fails open while `whoami` is unresolved, because the engine decides.
   */
  const canIssue = useCan(CAP.issue);

  const typeFilter = (params.get('type') as TypeFilter) ?? 'all';

  const [documents, setDocuments] = useState<DocumentDto[]>([]);
  // D34: the engine caps the list at a documented ceiling and flags truncation; that flag must reach
  // the user (a capped list that looks complete is a silent lie).
  const [truncation, setTruncation] = useState<{ total: number; ceiling: number } | null>(null);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Err | null>(null);
  const [denied, setDenied] = useState(false);
  const [rowError, setRowError] = useState<Err | null>(null);
  const [confirm, setConfirm] = useState<{ doc: DocumentDto; action: DocumentAction } | null>(null);

  const load = useCallback(async () => {
    if (workspaceId === null) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    setDenied(false);

    const [docsResp, contactsResp] = await Promise.all([
      client.call('list_documents', {
        workspaceId,
        type: typeFilter === 'all' ? undefined : typeFilter,
      }),
      client.call('list_contacts', { workspaceId, includeArchived: true }),
    ]);

    if (isErr(docsResp.body)) {
      if (docsResp.body.error === 'permission_denied' || docsResp.status === 403) setDenied(true);
      else setError(docsResp.body);
      setLoading(false);
      return;
    }
    const docs = asArray<DocumentDto>(docsResp.body.documents);
    setDocuments(docs);
    const body = docsResp.body as Record<string, unknown>;
    setTruncation(
      body.truncated === true
        ? {
            total: typeof body.total === 'number' ? body.total : docs.length,
            ceiling: typeof body.ceiling === 'number' ? body.ceiling : docs.length,
          }
        : null,
    );
    if (!isErr(contactsResp.body)) setContacts(asArray<Contact>(contactsResp.body.contacts));
    setLoading(false);
  }, [client, workspaceId, typeFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  const contactName = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of contacts) map.set(c.id, c.name);
    return (id: string | null) => (id !== null ? (map.get(id) ?? id) : '');
  }, [contacts]);

  function setType(next: TypeFilter) {
    const p = new URLSearchParams(params);
    if (next === 'all') p.delete('type');
    else p.set('type', next);
    setParams(p);
  }

  async function runConfirm() {
    if (confirm === null || workspaceId === null) return;
    const { doc } = confirm;
    setRowError(null);
    const resp = await client.call('transition_document', {
      workspaceId,
      documentId: doc.id,
      to: 'cancelled',
      idempotencyKey: idemKey('doc-cancel'),
    });
    setConfirm(null);
    if (isErr(resp.body)) setRowError(resp.body);
    else void load();
  }

  const columns = useMemo<DataTableColumn<DocumentDto>[]>(
    () => [
      {
        key: 'number',
        header: t('document.column.number'),
        render: (doc) => (
          <button
            type="button"
            className="documents-open"
            onClick={() => navigate(`/documents/${doc.id}`)}
          >
            {doc.number ?? t('document.draftNumber')}
          </button>
        ),
      },
      { key: 'type', header: t('document.column.type'), render: (doc) => t(typeKey(doc.type)) },
      {
        key: 'customer',
        header: t('document.column.customer'),
        render: (doc) => contactName(doc.contactId),
      },
      {
        key: 'date',
        header: t('document.column.date'),
        render: (doc) => (doc.issueDate !== null ? formatDate(doc.issueDate) : ''),
      },
      {
        key: 'total',
        header: t('document.column.total'),
        numeric: true,
        render: (doc) => <TotalCell doc={doc} />,
      },
      {
        key: 'status',
        header: t('document.column.status'),
        render: (doc) => <StatusCell doc={doc} />,
      },
      {
        key: 'actions',
        header: t('document.action.open'),
        headerHidden: true,
        align: 'end',
        render: (doc) => <RowActions doc={doc} canIssue={canIssue} onCancelAction={(action) => setConfirm({ doc, action })} />,
      },
    ],
    [t, navigate, contactName, canIssue],
  );

  if (workspaceId === null) {
    return (
      <div className="documents">
        <SurfaceHeader title={t('document.title')} help={<SurfaceHelp surface="Documents" />} />
        <NoWorkspaceState body={t('document.noWorkspaceHint')} />
      </div>
    );
  }

  if (denied) {
    return (
      <div className="documents">
        <SurfaceHeader title={t('document.title')} help={<SurfaceHelp surface="Documents" />} />
        <PermissionDenied />
      </div>
    );
  }

  const hasType = typeFilter !== 'all';
  const emptyState = hasType ? (
    <EmptyState
      title={t('document.noMatch')}
      hint={t('document.noMatchHint')}
      action={{ label: t('document.clearFilters'), onClick: () => setType('all') }}
    />
  ) : (
    <EmptyState
      title={t('document.empty')}
      hint={t('document.emptyHint')}
      {...(canIssue
        ? { action: { label: t('document.new'), onClick: () => navigate('/documents/new') } }
        : {})}
    />
  );

  return (
    <div className="documents">
      <SurfaceHeader
        title={t('document.title')}
        help={<SurfaceHelp surface="Documents" />}
        actions={
          canIssue ? (
            <button type="button" className="btn btn--primary" onClick={() => navigate('/documents/new')}>
              {t('document.new')}
            </button>
          ) : undefined
        }
      />

      <div className="documents-tabs" role="tablist" aria-label={t('document.column.type')}>
        <TabButton active={typeFilter === 'all'} label={t('document.type.all')} onClick={() => setType('all')} />
        {DOCUMENT_TYPES.map((type) => (
          <TabButton
            key={type}
            active={typeFilter === type}
            label={t(typeKey(type))}
            onClick={() => setType(type)}
          />
        ))}
      </div>

      {rowError !== null && <ErrorBanner error={rowError} />}

      {truncation !== null && (
        <p className="documents-truncated" role="status">
          {t('document.truncatedNotice', { ceiling: truncation.ceiling, total: truncation.total })}{' '}
          {t('document.truncatedHint')}
        </p>
      )}

      <DataTable
        columns={columns}
        rows={documents}
        rowKey={(doc) => doc.id}
        caption={t('document.title')}
        loading={loading}
        {...(error !== null ? { error } : {})}
        onRetry={() => void load()}
        emptyState={emptyState}
        rowClassName={(doc) =>
          doc.status === 'draft'
            ? 'documents-row--draft'
            : VOID_STATES.has(doc.status)
              ? 'documents-row--void'
              : undefined
        }
      />

      {confirm !== null && (
        <ConfirmDialog
          message={
            confirm.action.kind === 'delete'
              ? t('document.action.deleteDraftConfirm')
              : t('document.action.cancelConfirm')
          }
          confirmLabel={t(confirm.action.labelKey)}
          onConfirm={() => void runConfirm()}
          onCancel={() => setConfirm(null)}
        />
      )}
    </div>
  );
}

function TabButton({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      className={`documents-tab${active ? ' documents-tab--active' : ''}`}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

/**
 * The total cell: the document's own transaction total, and beside it the engine's own base-currency
 * total where a posting stamped one. Both figures come straight off `list_documents`; the client sums
 * and rounds nothing (see the long note that stood on this cell before the DataTable move).
 */
function TotalCell({ doc }: { doc: DocumentDto }) {
  const t = useT();
  const baseTotal = postedBaseFigures(doc);
  return (
    <>
      {formatMoney(doc.totalMinor, doc.currency)}
      {baseTotal !== null && (
        <span className="documents-base-total">
          <span className="visually-hidden">{t('invoice.fx.booked')} </span>
          {formatMoney(baseTotal.totalBaseMinor, baseTotal.baseCurrency)}
        </span>
      )}
    </>
  );
}

function StatusCell({ doc }: { doc: DocumentDto }) {
  const t = useT();
  const overdue = isOverdue(doc);
  return (
    <>
      <span className="documents-status">{t(statusKey(doc.status))}</span>
      {overdue && <span className="documents-overdue">{t('document.overdue')}</span>}
    </>
  );
}

interface RowActionsProps {
  doc: DocumentDto;
  /** A24 `issue` (F5): the destructive row overflow is a document write and is absent without it. */
  canIssue: boolean;
  onCancelAction: (action: DocumentAction) => void;
}

function RowActions({ doc, canIssue, onCancelAction }: RowActionsProps) {
  const t = useT();
  // Only the destructive row action (delete a draft / storno a posted document) belongs in the list
  // overflow (M25); the forward steps live on the document's own detail surface.
  const danger = documentActions(doc).overflow.find((a) => a.danger === true);
  if (!canIssue || danger === undefined) return null;
  return (
    <OverflowMenu
      label={t('document.rowActions', { name: doc.number ?? t('document.draftNumber') })}
      items={[{ key: 'danger', label: t(danger.labelKey), onSelect: () => onCancelAction(danger), danger: true }]}
    />
  );
}
