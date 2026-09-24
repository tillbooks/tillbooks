/**
 * E04, Korrespondenz (`/correspondence`): the cross-contact review queue over the local mail index.
 *
 * WHY IT IS A ROUTE OF ITS OWN (spec §6, bar deliberately high): the queue's whole value is being
 * CROSS-contact and CROSS-thread. No existing surface can host "everything I need to answer this
 * morning" without misfiling it: the Kontakte list is per-contact, the drawer is one relationship,
 * the Files tree is files. Everything contact-scoped rides the C00 drawer (the timeline union);
 * the account panel lives HERE because its empty state is the connect affordance (D89: there is
 * no Einstellungen surface).
 *
 * THE HONESTY LINES, stated where they render: connecting asks for NO password because none
 * exists to ask for (TILL reads a file another app already wrote), and a finished draft lands in
 * the mail client's own Drafts folder where the human reviews and sends it: TILL has no send
 * verb. Direction and state are glyph + label, never colour alone (WCAG 2.2 AA); a stale message
 * says so in words.
 *
 * THE PERMISSION GATES HERE ARE A CONVENIENCE AND NOT THE ENFORCEMENT (the standing Studio rule):
 * `whoami` is the one source, it fails open, and the engine is the real gate. Connect and the
 * label control render only with `mail.write`; reading and applying a saved view rides plain
 * `mail.read`.
 */
import { useCallback, useEffect, useId, useState } from 'react';

import { useClient } from '../../lib/client-context';
import { isErr, type Err } from '../../lib/client';
import { CAP, useCapabilities } from '../../lib/capabilities';
import { useWorkspaceId } from '../../app/workspace';
import { useT, formatDate, formatMoney } from '../../i18n';
import { SurfaceHelp } from '../../components/SurfaceHelp';
import { EmptyState, ErrorBanner, NoWorkspaceState, PermissionDenied, Skeleton } from '../../components/states';
import { DataTable, type DataTableColumn } from '../../components/DataTable';
import { Select } from '../../components/Select';
import { SurfaceHeader } from '../../components/SurfaceHeader';
import { ActionFeedback } from '../../components/ActionFeedback';
import { DetailDrawer } from '../../components/DetailDrawer';
import { Status } from '../../components/Status';
import './Correspondence.css';

/** A fresh key per write, so a retry after a transport failure is a retry and not a second write. */
const newKey = () => crypto.randomUUID();

export interface ThreadItem {
  id: string;
  accountId: string;
  subject: string | null;
  contactId: string | null;
  lastMessageAt: string | null;
  lastDirection: string | null;
  messageCount: number;
  draftReady: boolean;
  bucket: string;
}

interface AccountItem {
  id: string;
  adapter: string;
  address: string;
  lastIndexedAt: string | null;
}

interface ThreadMessage {
  id: string;
  subject: string | null;
  fromAddress: string | null;
  direction: string;
  sentAt: string | null;
  body: string | null;
  stale?: boolean;
  error?: string;
}

interface LabelField {
  fieldDefId: string;
  key: string;
  options: string[];
}

/** One E06 draft run, as `draft_list` answers it (body read on demand from the Drafts folder). */
interface DraftRun {
  id: string;
  grounded: boolean;
  status: string;
  modelRef: string | null;
  body: string | null;
  draftGone: boolean;
  modelChanged: boolean;
}

function parseDraftRuns(body: unknown): DraftRun[] {
  const runs = (body as { runs?: unknown })?.runs;
  if (!Array.isArray(runs)) return [];
  return runs
    .filter((r): r is Record<string, unknown> => r !== null && typeof r === 'object')
    .filter((r) => typeof r.id === 'string')
    .map((r) => ({
      id: r.id as string,
      grounded: r.grounded === true,
      status: typeof r.status === 'string' ? r.status : 'failed',
      modelRef: typeof r.modelRef === 'string' ? r.modelRef : null,
      body: typeof r.body === 'string' ? r.body : null,
      draftGone: r.draftGone === true,
      modelChanged: r.modelChanged === true,
    }));
}

/** One verified ledger line for the facts block: A16's own figures, formatted for the viewer. */
interface FactLine {
  key: string;
  text: string;
}

function parseThreads(body: unknown): ThreadItem[] | null {
  const items = (body as { items?: unknown })?.items;
  if (!Array.isArray(items)) return null;
  const out: ThreadItem[] = [];
  for (const raw of items) {
    if (raw === null || typeof raw !== 'object') return null;
    const t = raw as Record<string, unknown>;
    if (typeof t.id !== 'string' || typeof t.bucket !== 'string') return null;
    out.push({
      id: t.id,
      accountId: typeof t.accountId === 'string' ? t.accountId : '',
      subject: typeof t.subject === 'string' ? t.subject : null,
      contactId: typeof t.contactId === 'string' ? t.contactId : null,
      lastMessageAt: typeof t.lastMessageAt === 'string' ? t.lastMessageAt : null,
      lastDirection: typeof t.lastDirection === 'string' ? t.lastDirection : null,
      messageCount: typeof t.messageCount === 'number' ? t.messageCount : 0,
      draftReady: t.draftReady === true,
      bucket: t.bucket,
    });
  }
  return out;
}

function parseAccounts(body: unknown): AccountItem[] {
  const accounts = (body as { accounts?: unknown })?.accounts;
  if (!Array.isArray(accounts)) return [];
  return accounts
    .filter((a): a is Record<string, unknown> => a !== null && typeof a === 'object')
    .filter((a) => typeof a.id === 'string' && typeof a.address === 'string')
    .map((a) => ({
      id: a.id as string,
      adapter: typeof a.adapter === 'string' ? a.adapter : '',
      address: a.address as string,
      lastIndexedAt: typeof a.lastIndexedAt === 'string' ? a.lastIndexedAt : null,
    }));
}

interface SavedView {
  id: string;
  name: string;
}

function parseViews(body: unknown): SavedView[] {
  const views = (body as { savedViews?: unknown })?.savedViews;
  if (!Array.isArray(views)) return [];
  return views
    .filter((v): v is { viewId?: string; id?: string; name: string } => v !== null && typeof v === 'object' && typeof (v as { name?: unknown }).name === 'string')
    .map((v) => ({ id: (v.viewId ?? v.id ?? '') as string, name: v.name }))
    .filter((v) => v.id !== '');
}

/** ← eingehend · → ausgehend · ✎ Entwurf: glyph AND label, never colour alone. */
/** The direction of a message as a drawn arrow (K-22: no text arrows); the word beside it carries it. */
function DirectionGlyph({ direction }: { direction: string | null | undefined }) {
  const inbound = direction !== 'outbound';
  return (
    <svg className="mail-direction-glyph" width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {inbound ? <path d="M19 12H5M11 6l-6 6 6 6" /> : <path d="M5 12h14M13 6l6 6-6 6" />}
    </svg>
  );
}

const BUCKETS = ['needs_reply', 'drafted', 'done'] as const;

interface ConnectDraft {
  adapter: string;
  storePath: string;
  address: string;
}

const EMPTY_CONNECT: ConnectDraft = { adapter: 'apple_mail', storePath: '', address: '' };

export function Correspondence() {
  const t = useT();
  const client = useClient();
  const workspaceId = useWorkspaceId();
  const { can } = useCapabilities();

  const [threads, setThreads] = useState<ThreadItem[]>([]);
  const [accounts, setAccounts] = useState<AccountItem[]>([]);
  const [views, setViews] = useState<SavedView[]>([]);
  const [viewId, setViewId] = useState('');
  const [labelField, setLabelField] = useState<LabelField | null>(null);
  const [labels, setLabels] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [denied, setDenied] = useState(false);
  const [writeError, setWriteError] = useState<Err | null>(null);
  const [connecting, setConnecting] = useState(false);
  const storePathId = useId();
  const [connect, setConnect] = useState<ConnectDraft>(EMPTY_CONNECT);
  const [openThreadId, setOpenThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ThreadMessage[]>([]);
  const [notice, setNotice] = useState<string | null>(null);

  const canWrite = can(CAP.mailWrite);

  const load = useCallback(async () => {
    if (workspaceId === null) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setFailed(false);
    setDenied(false);
    const [listed, accountList, savedViews, fields] = await Promise.all([
      client.call('mail_threads_list', { workspaceId, ...(viewId === '' ? {} : { savedViewId: viewId }) }),
      client.call('mail_accounts_list', { workspaceId }),
      client.call('list_saved_views', { workspaceId, entityKind: 'mail_thread' }),
      client.call('list_field_defs', { workspaceId, entityKind: 'mail_thread' }),
    ]);
    if (isErr(listed.body)) {
      if (listed.body.error === 'permission_denied' || listed.status === 403) setDenied(true);
      else setFailed(true);
      setLoading(false);
      return;
    }
    const parsed = parseThreads(listed.body);
    if (parsed === null) {
      setFailed(true);
      setLoading(false);
      return;
    }
    setThreads(parsed);
    if (!isErr(accountList.body)) setAccounts(parseAccounts(accountList.body));
    // The picker and the label control both degrade honestly: a refused read leaves the queue intact.
    if (!isErr(savedViews.body)) setViews(parseViews(savedViews.body));
    if (!isErr(fields.body)) {
      const defs = (fields.body as unknown as { fieldDefs?: { fieldDefId: string; key: string; type: string; options: string[] | null }[] }).fieldDefs;
      const select = Array.isArray(defs) ? defs.find((d) => d.type === 'select' && Array.isArray(d.options)) : undefined;
      setLabelField(select === undefined ? null : { fieldDefId: select.fieldDefId, key: select.key, options: select.options ?? [] });
      if (select !== undefined && parsed.length > 0) {
        const values = await Promise.all(
          parsed.map((thread) => client.call('list_field_values', { workspaceId, entityKind: 'mail_thread', entityId: thread.id })),
        );
        const next: Record<string, string> = {};
        values.forEach((res, i) => {
          if (isErr(res.body)) return;
          const rows = (res.body as unknown as { values?: { key: string; value: unknown }[] }).values ?? [];
          const hit = rows.find((row) => row.key === select.key);
          const thread = parsed[i];
          if (hit !== undefined && typeof hit.value === 'string' && thread !== undefined) next[thread.id] = hit.value;
        });
        setLabels(next);
      }
    }
    setLoading(false);
  }, [client, workspaceId, viewId]);

  useEffect(() => {
    void load();
  }, [load]);

  const write = useCallback(
    async (action: string, input: Record<string, unknown>): Promise<Record<string, unknown> | null> => {
      if (workspaceId === null) return null;
      setWriteError(null);
      const response = await client.call(action, { workspaceId, ...input });
      if (isErr(response.body)) {
        setWriteError(response.body);
        return null;
      }
      await load();
      return response.body as unknown as Record<string, unknown>;
    },
    [client, workspaceId, load],
  );

  const submitConnect = useCallback(async () => {
    const body = await write('mail_connect', {
      adapter: connect.adapter,
      storePath: connect.storePath.trim(),
      address: connect.address.trim(),
      idempotencyKey: newKey(),
    });
    if (body !== null) {
      setConnecting(false);
      setConnect(EMPTY_CONNECT);
      // The first reindex rides the connect (spec US-E04.1: "the first reindex is queued").
      const accountId = body.accountId;
      if (typeof accountId === 'string') await write('mail_reindex', { accountId, idempotencyKey: newKey() });
    }
  }, [write, connect]);

  const reindexAll = useCallback(async () => {
    for (const account of accounts) {
      await write('mail_reindex', { accountId: account.id, idempotencyKey: newKey() });
    }
  }, [write, accounts]);

  const openThread = useCallback(
    async (threadId: string) => {
      if (workspaceId === null) return;
      if (openThreadId === threadId) {
        setOpenThreadId(null);
        setMessages([]);
        return;
      }
      const response = await client.call('mail_thread_get', { workspaceId, threadId });
      if (isErr(response.body)) {
        setWriteError(response.body);
        return;
      }
      const got = (response.body as unknown as { messages?: ThreadMessage[] }).messages ?? [];
      setOpenThreadId(threadId);
      setMessages(got);
    },
    [client, workspaceId, openThreadId],
  );

  const setLabel = useCallback(
    async (threadId: string, value: string) => {
      if (labelField === null) return;
      const body = await write('set_field_value', {
        entityKind: 'mail_thread',
        entityId: threadId,
        fieldKey: labelField.key,
        value: value === '' ? null : value,
        idempotencyKey: newKey(),
      });
      if (body !== null) setNotice(null);
    },
    [write, labelField],
  );

  const errorMessage = (error: Err): string => {
    const known = ['needs_mailstore', 'unknown_mail_adapter', 'drafts_not_writable', 'message_moved'];
    if (known.includes(error.error)) return t(`mail.error.${error.error}`);
    if (error.error === 'permission_denied') return t('mail.error.permissionDenied.write');
    return t('errors.fallback');
  };

  if (workspaceId === null) return <NoWorkspaceState />;
  if (denied) return <PermissionDenied body={t('mail.error.permissionDenied.read')} />;

  const connectPanel = (
    <form
      className="mail-connect"
      aria-label={t('mail.action.connect')}
      onSubmit={(e) => {
        e.preventDefault();
        void submitConnect();
      }}
    >
      <p className="mail-connect-note">{t('mail.connect.no_password')}</p>
      <p className="mail-connect-note">{t('mail.connect.supported')}</p>
      <div className="mail-connect-fields">
        <div className="mail-field">
          <span>{t('mail.connect.adapter')}</span>
          <Select
            value={connect.adapter}
            onChange={(val) => setConnect({ ...connect, adapter: val })}
            options={[
              { value: 'apple_mail', label: t('mail.connect.adapter_apple_mail') },
              { value: 'thunderbird', label: t('mail.connect.adapter_thunderbird') },
            ]}
            ariaLabel={t('mail.connect.adapter')}
          />
        </div>
        <label className="mail-field">
          <span>{t('mail.connect.storePath')}</span>
          <input className="field" id={storePathId} type="text" value={connect.storePath} onChange={(e) => setConnect({ ...connect, storePath: e.target.value })} required />
        </label>
        <label className="mail-field">
          <span>{t('mail.connect.address')}</span>
          <input className="field" type="email" value={connect.address} onChange={(e) => setConnect({ ...connect, address: e.target.value })} required />
        </label>
      </div>
      <div className="mail-connect-actions">
        <button type="submit" className="btn btn--primary btn--sm">
          {t('mail.action.connect')}
        </button>
        {connecting && (
          <button type="button" className="btn btn--secondary btn--sm" onClick={() => setConnecting(false)}>
            {t('mail.action.discard')}
          </button>
        )}
      </div>
    </form>
  );

  // The list columns for the shared DataTable (D118 B2), one set for all three bucket tables. The
  // subject stays a button so opening the reading drawer is a named affordance (the Files idiom),
  // and the draft badge folds into the subject cell (glyph AND label, never colour alone). The label
  // control is a column only when a select field def exists AND the viewer may write it.
  const columns: DataTableColumn<ThreadItem>[] = [
    {
      key: 'direction',
      header: t('mail.column.direction'),
      render: (thread) => (
        <span className="mail-direction">
          <DirectionGlyph direction={thread.lastDirection} />
          {t(`mail.direction.${thread.lastDirection ?? 'inbound'}`)}
        </span>
      ),
    },
    {
      key: 'subject',
      header: t('mail.column.subject'),
      render: (thread) => (
        // K-21/K-12: the row itself opens the thread (onRowClick below); the subject reads in ink 500.
        <span className="mail-subject-cell">
          <span className="mail-row-subject">{thread.subject ?? t('mail.thread.noSubject')}</span>
          {thread.draftReady && <Status kind="pending" label={t('mail.draft.badge')} className="mail-draft-status" />}
        </span>
      ),
    },
    {
      key: 'messages',
      header: t('mail.column.messages'),
      numeric: true,
      align: 'start',
      render: (thread) => thread.messageCount,
    },
    {
      key: 'last',
      header: t('mail.column.last'),
      render: (thread) =>
        thread.lastMessageAt === null ? (
          <span className="mail-muted">&ndash;</span>
        ) : (
          formatDate(thread.lastMessageAt.slice(0, 10))
        ),
    },
    ...(labelField !== null && canWrite
      ? [
          {
            key: 'label',
            header: t('mail.field.label'),
            render: (thread: ThreadItem) => (
              // A click on the label control is the control's, never the row's open (onRowClick).
              <div className="mail-label-control" onClick={(event) => event.stopPropagation()}>
                <Select
                  ariaLabel={t('mail.field.label')}
                  value={labels[thread.id] ?? ''}
                  onChange={(val) => void setLabel(thread.id, val)}
                  options={[
                    { value: '', label: t('mail.field.none') },
                    ...labelField.options.map((option) => ({ value: option, label: option })),
                  ]}
                />
              </div>
            ),
          } satisfies DataTableColumn<ThreadItem>,
        ]
      : []),
  ];

  const section = (bucket: (typeof BUCKETS)[number]) => {
    const rows = threads.filter((thread) => thread.bucket === bucket);
    return (
      <section key={bucket} className="mail-section" aria-labelledby={`mail-h-${bucket}`}>
        <h2 id={`mail-h-${bucket}`} className="mail-section-title">
          {t(`mail.bucket.${bucket}`)}
          <span className="mail-count">{rows.length}</span>
        </h2>
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(thread) => thread.id}
          onRowClick={(thread) => void openThread(thread.id)}
          rowLabel={(thread) => `${t('mail.action.open')}: ${thread.subject ?? t('mail.thread.noSubject')}`}
          caption={t(`mail.bucket.${bucket}`)}
          emptyState={<p className="mail-section-empty">{t('mail.section.empty')}</p>}
        />
      </section>
    );
  };

  // The thread whose reading drawer is open, resolved from the current queue so a drawer whose thread
  // left the list (a new saved view, a reindex) has nothing to render.
  const openRow = openThreadId === null ? null : (threads.find((thread) => thread.id === openThreadId) ?? null);

  return (
    <section className="mail" aria-labelledby="mail-title">
      <SurfaceHeader
        title={t('mail.route.title')}
        titleId="mail-title"
        help={<SurfaceHelp surface="Correspondence" />}
        actions={
          <>
            {views.length > 0 && (
              <div className="mail-view-picker">
                <span>{t('mail.view.label')}</span>
                <Select
                  value={viewId}
                  onChange={(val) => setViewId(val)}
                  options={[
                    { value: '', label: t('mail.view.all') },
                    ...views.map((view) => ({ value: view.id, label: view.name })),
                  ]}
                  ariaLabel={t('mail.view.label')}
                />
              </div>
            )}
            {accounts.length > 0 && (
              <button type="button" className="btn btn--primary" onClick={() => void reindexAll()}>
                {t('mail.action.reindex')}
              </button>
            )}
            {accounts.length > 0 && canWrite && !connecting && (
              <button type="button" className="btn btn--secondary" onClick={() => setConnecting(true)}>
                {t('mail.action.connect')}
              </button>
            )}
          </>
        }
      />

      {accounts.length > 0 && (
        <p className="mail-account-line">
          <span className="mail-account-title">{t('mail.account.title')}:</span>{' '}
          {accounts.map((account) => (
            <span key={account.id} className="mail-account">
              {t('mail.account.connected', { address: account.address })}{' '}
              {account.lastIndexedAt === null
                ? t('mail.account.never')
                : t('mail.account.lastIndexed', { at: formatDate(account.lastIndexedAt.slice(0, 10)) })}
            </span>
          ))}
        </p>
      )}

      {notice !== null && <ActionFeedback tone="info" message={notice} />}
      {writeError !== null && <ErrorBanner message={errorMessage(writeError)} />}
      {failed && <ErrorBanner message={t('mail.error.transport')} context="read" onRetry={() => void load()} />}

      {connecting && canWrite && connectPanel}

      {loading ? (
        <Skeleton rows={4} height={36} labelKey="mail.loading" />
      ) : failed ? null : threads.length === 0 && accounts.length === 0 ? (
        // The honest empty state IS the connect affordance (US-E04.1): named clients, no password,
        // and nothing resembling a provider sign-in. Hidden without mail.write.
        <div className="mail-empty">
          {/* K-33: the title names what is missing and the hint says when threads appear. The one
              action IS the connect form directly beneath (US-E04.1), so the state carries no second
              button with the same words. */}
          <EmptyState title={t('mail.empty')} hint={t('mail.emptyConnectHint')} />
          {canWrite && connectPanel}
        </div>
      ) : threads.length === 0 ? (
        <EmptyState
          title={t('mail.empty')}
          hint={t('mail.emptyIndexHint')}
          action={{ label: t('mail.action.reindex'), onClick: () => void reindexAll() }}
        />
      ) : (
        BUCKETS.map((bucket) => section(bucket))
      )}

      {/* The thread reading view in the shared DetailDrawer (D118 B2): the primitive owns the focus
          trap, the scrim and Escape, and returns focus to the subject that opened it. Keyed on the
          thread so the draft pane cannot outlive the thread it was opened for. */}
      {openRow !== null && (
        <DetailDrawer
          key={openRow.id}
          open
          onClose={() => {
            setOpenThreadId(null);
            setMessages([]);
          }}
          title={openRow.subject ?? t('mail.thread.noSubject')}
          closeLabel={t('mail.action.close')}
        >
          <div className="mail-reading">
            {openRow.bucket === 'drafted' && <p className="mail-drafted-note">{t('mail.draft.in_drafts')}</p>}
            {messages.map((message) => (
              <article key={message.id} className="mail-message">
                <header className="mail-message-head">
                  <span className="mail-direction">
                    <DirectionGlyph direction={message.direction} />
                    {t(`mail.direction.${message.direction}`)}
                  </span>
                  <span>{message.fromAddress ?? ''}</span>
                  {message.sentAt !== null && <span>{formatDate(message.sentAt.slice(0, 10))}</span>}
                </header>
                {message.error === 'message_moved' ? (
                  <p className="mail-message-issue">{t('mail.error.message_moved')}</p>
                ) : (
                  <>
                    {message.stale === true && (
                      <p className="mail-message-issue">
                        <Status kind="warn" label={t('mail.msg.stale')} />
                      </p>
                    )}
                    <pre className="mail-message-body">{message.body ?? ''}</pre>
                  </>
                )}
              </article>
            ))}
            {/* E06: the draft pane, beside the thread it answers (no new route). */}
            <DraftPane workspaceId={workspaceId} thread={openRow} />
          </div>
        </DetailDrawer>
      )}
    </section>
  );
}
/**
 * E06's draft pane, on the existing Korrespondenz route beside the thread it answers (spec §6: no
 * new route, no new screen). Five states: skeleton while loading, "Noch kein Entwurf." with the
 * generate CTA, specific inline errors (never a stack trace), the draft with its grounding
 * statement (glyph + label, never colour alone) and its live facts block, and the padlock posture
 * (generate/regenerate hidden without `draft.write`, the facts block hidden without `read_sales`,
 * never shown-then-rejected). The review note states the P8-by-construction fact: the human reads
 * and sends in their own mail app, and TILL never sends.
 */
function DraftPane({ workspaceId, thread }: { workspaceId: string; thread: ThreadItem }) {
  const t = useT();
  const client = useClient();
  const { can } = useCapabilities();
  const canDraft = can(CAP.draftWrite);
  const canSeeBooks = can(CAP.readSales);

  const [loading, setLoading] = useState(true);
  const [runs, setRuns] = useState<DraftRun[]>([]);
  const [facts, setFacts] = useState<FactLine[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadFacts = useCallback(async () => {
    if (thread.contactId === null || !canSeeBooks) {
      setFacts([]);
      return;
    }
    const resp = await client.call('customer_balance', { workspaceId, customerId: thread.contactId });
    if (isErr(resp.body)) {
      setFacts([]);
      return;
    }
    const body = resp.body as unknown as {
      items?: { kind: string; number: string | null; openMinor: number; currency: string; dueDate: string | null }[];
      baseTotalOpenMinor?: number;
      baseCurrency?: string;
    };
    const lines: FactLine[] = [];
    for (const item of (body.items ?? []).filter((i) => i.kind === 'document').slice(0, 6)) {
      lines.push({
        key: `oi-${item.number ?? item.dueDate ?? lines.length}`,
        text: `${t('draft.fact.invoice', { number: item.number ?? '' })}: ${formatMoney(item.openMinor, item.currency)}${
          item.dueDate === null ? '' : ` · ${t('draft.fact.due', { date: formatDate(item.dueDate) })}`
        }`,
      });
    }
    if ((body.items ?? []).length > 0) {
      lines.push({
        key: 'total',
        text: `${t('draft.fact.total')}: ${formatMoney(body.baseTotalOpenMinor ?? 0, body.baseCurrency ?? 'CHF')}`,
      });
    }
    setFacts(lines);
  }, [client, workspaceId, thread.contactId, canSeeBooks, t]);

  const load = useCallback(async () => {
    setLoading(true);
    const listed = await client.call('draft_list', { workspaceId, threadId: thread.id });
    if (!isErr(listed.body)) setRuns(parseDraftRuns(listed.body));
    await loadFacts();
    setLoading(false);
  }, [client, workspaceId, thread.id, loadFacts]);

  useEffect(() => {
    void load();
  }, [load]);

  const draftErrorMessage = (err: Err): string => {
    const known = [
      'nothing_to_reply_to',
      'needs_voice_profile',
      'needs_local_runtime',
      'needs_mailstore',
      'source_changed',
      'draft_gone',
      'generation_failed',
    ];
    if (known.includes(err.error)) return t(`draft.error.${err.error}`);
    if (err.error === 'permission_denied') return t('draft.error.forbidden');
    return t('errors.fallback');
  };

  const generate = useCallback(async () => {
    setBusy(true);
    setError(null);
    const resp = await client.call('draft_generate', { workspaceId, threadId: thread.id, idempotencyKey: newKey() });
    setBusy(false);
    if (isErr(resp.body)) {
      setError(draftErrorMessage(resp.body));
      return;
    }
    await load();
  }, [client, workspaceId, thread.id, load]);

  const regenerate = useCallback(
    async (draftRunId: string, hint?: string) => {
      setBusy(true);
      setError(null);
      const resp = await client.call('draft_regenerate', {
        workspaceId,
        draftRunId,
        ...(hint === undefined ? {} : { hint }),
        idempotencyKey: newKey(),
      });
      setBusy(false);
      if (isErr(resp.body)) {
        setError(draftErrorMessage(resp.body));
        return;
      }
      await load();
    },
    [client, workspaceId, load],
  );

  const latest = runs[0];

  if (loading) {
    return (
      <section className="mail-draft-pane" aria-label={t('draft.pane.title')} role="status" aria-busy="true">
        <h3 className="mail-draft-title">{t('draft.pane.title')}</h3>
        <Skeleton rows={3} />
      </section>
    );
  }

  return (
    <section className="mail-draft-pane" aria-label={t('draft.pane.title')}>
      <h3 className="mail-draft-title">{t('draft.pane.title')}</h3>
      {error !== null && <p className="mail-draft-error" role="alert">{error}</p>}

      {latest === undefined || latest.body === null ? (
        <>
          <p className="mail-draft-empty">
            {latest !== undefined && latest.draftGone ? t('draft.error.draft_gone') : t('draft.empty')}
          </p>
          {canDraft && (
            <button type="button" className="btn btn--primary btn--sm" disabled={busy} onClick={() => void generate()}>
              {busy ? t('draft.generating') : t('draft.action.generate')}
            </button>
          )}
        </>
      ) : (
        <>
          <pre className="mail-draft-body">{latest.body}</pre>
          {/* US-E06.3 permission posture: without `read_sales` the grounding statement AND the
              facts block never render, whatever the flag says: a viewer who may not see the books
              may not read a money statement off a draft pane either. */}
          {canSeeBooks && (
            <p className="mail-draft-grounding">
              <Status kind={latest.grounded ? 'success' : 'neutral'} label={latest.grounded ? t('draft.grounded.on') : t('draft.grounded.off')} />
              {latest.modelChanged && <span className="mail-draft-model-note"> · {t('draft.model.changed')}</span>}
            </p>
          )}
          {latest.grounded && canSeeBooks && (
            <div className="mail-draft-facts">
              <h4 className="mail-draft-facts-title">{t('draft.grounded.facts')}</h4>
              {facts.length === 0 ? (
                <p className="mail-draft-facts-empty">{t('draft.grounded.no_history')}</p>
              ) : (
                <ul>
                  {facts.map((fact) => (
                    <li key={fact.key} className="t-num">
                      {fact.text}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {canDraft && (
            <div className="mail-draft-actions">
              <button type="button" className="btn btn--secondary btn--sm" disabled={busy} onClick={() => void regenerate(latest.id)}>
                {busy ? t('draft.generating') : t('draft.action.regenerate')}
              </button>
              <button type="button" className="btn btn--ghost btn--sm" disabled={busy} onClick={() => void regenerate(latest.id, t('draft.hint.shorter'))}>
                {t('draft.hint.shorter')}
              </button>
              <button type="button" className="btn btn--ghost btn--sm" disabled={busy} onClick={() => void regenerate(latest.id, t('draft.hint.formal'))}>
                {t('draft.hint.formal')}
              </button>
            </div>
          )}
        </>
      )}
      <p className="mail-draft-review-note">{t('draft.review.note')}</p>
    </section>
  );
}

export default Correspondence;
