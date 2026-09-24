/**
 * C02, Offerten (`/quotes`): the quote lifecycle over A10's shared document machine.
 *
 * ONE READ SERVES THE LIST. `quotes_list` answers the quotes (newest version only by default, each
 * with its frozen total, validity and derived `expired` flag); the surface groups nothing, it lists.
 * The lifecycle is a drawer of actions whose availability follows the quote's status, each a thin
 * call to a `quotes_*` verb: send (issues the O-number and mints the accept link, POSTS NOTHING),
 * accept / decline, revise (a new version), and convert (delegates to A10, still no posting).
 *
 * SEND IS HONEST ABOUT THE CLOUD TIER. The OSS core produces the local artifact and the accept link
 * and stops; `transmitted:false` surfaces as a copyable link and the "Versand ist Cloud-Funktion"
 * note, never a fake "sent".
 *
 * THE PERMISSION GATES HERE ARE A CONVENIENCE, NOT THE ENFORCEMENT (the standing Studio rule): the
 * engine is the real gate. Without the read right the list is a padlock panel, never an empty list
 * that reads as "no quotes exist".
 *
 * ## BUILT ON THE SHARED UI PRIMITIVES (D118 B2, 2026-08-24)
 *
 * The quote list is the shared `DataTable` (frame overflow, sticky header, density and the five
 * states in one place), row-click driving the detail drawer; the total column is a numeric,
 * right-aligned `.t-num` cell, and the row itself is the opener (K-21, named "Offerte … öffnen").
 * The status is the shared `Status` word (K-22). The page header, the saved-view picker, the show-superseded toggle
 * and the create action are the shared `SurfaceHeader`. Both overlays (create, detail) are the
 * shared `DetailDrawer`, which adds the focus trap, Escape and the scrim the bespoke panel lacked;
 * the lifecycle actions ride its pinned footer. The per-surface CSS that duplicated the list table,
 * the header and the drawer chrome is gone; what remains is genuinely Quotes-specific: the form
 * fields and line grid, the drawer fact grid and the honest cloud-tier note.
 *
 * No `Provenance` (C3): the list read carries no actor or timestamp to source a provenance line. No
 * `ConsequenceLine` (C4): no quote verb carries an engine consequence sentence; the cloud-tier note
 * is the surface's own honest copy, not a dial capability.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';

import { useClient } from '../../lib/client-context';
import { isErr, type Err } from '../../lib/client';
import { CAP, useCapabilities } from '../../lib/capabilities';
import { useWorkspaceId } from '../../app/workspace';
import { useT, formatMoney, formatDate } from '../../i18n';
import { EmptyState, ErrorBanner, NoWorkspaceState, PermissionDenied } from '../../components/states';
import { DataTable, type DataTableColumn } from '../../components/DataTable';
import { SurfaceHeader } from '../../components/SurfaceHeader';
import { DetailDrawer } from '../../components/DetailDrawer';
import { Select } from '../../components/Select';
import { SurfaceHelp } from '../../components/SurfaceHelp';
import { Status, type StatusKind } from '../../components/Status';
import { CloseGlyph } from '../../components/icons';
import './Quotes.css';

/** A fresh key per write, so a retry after a transport failure is a retry and not a second write. */
const newKey = () => crypto.randomUUID();

export interface QuoteView {
  id: string;
  number: string | null;
  contactId: string | null;
  status: string;
  totalMinor: number;
  currency: string;
  validUntil: string | null;
  version: number;
  expired: boolean;
}

/**
 * The Status kind per quote state (K-22): the shared glyph plus the word, never a dingbat and never
 * colour alone (spec §6, WCAG 2.2). An expired quote needs attention; a declined or superseded one is
 * out of play; an accepted or converted one is done.
 */
const STATUS_KIND: Record<string, StatusKind> = {
  draft: 'neutral',
  issued: 'pending',
  sent: 'pending',
  accepted: 'success',
  converted: 'success',
  declined: 'inactive',
  superseded: 'inactive',
  expired: 'warn',
};

function parseQuotes(body: unknown): QuoteView[] | null {
  if (body === null || typeof body !== 'object') return null;
  const docs = (body as { documents?: unknown }).documents;
  if (!Array.isArray(docs)) return null;
  return docs
    .filter((d): d is Record<string, unknown> => d !== null && typeof d === 'object' && typeof (d as { id?: unknown }).id === 'string')
    .map((d) => ({
      id: d.id as string,
      number: typeof d.number === 'string' ? d.number : null,
      contactId: typeof d.contactId === 'string' ? d.contactId : null,
      status: typeof d.status === 'string' ? d.status : 'draft',
      totalMinor: typeof d.totalMinor === 'number' ? d.totalMinor : 0,
      currency: typeof d.currency === 'string' ? d.currency : 'CHF',
      validUntil: typeof d.validUntil === 'string' ? d.validUntil : null,
      version: typeof d.version === 'number' ? d.version : 1,
      expired: d.expired === true,
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
    .filter((v): v is { viewId?: string; name: string } => v !== null && typeof v === 'object' && typeof (v as { name?: unknown }).name === 'string')
    .map((v) => ({ id: (v.viewId ?? '') as string, name: v.name }))
    .filter((v) => v.id !== '');
}

function parseContacts(body: unknown): Map<string, string> {
  const contacts = (body as { contacts?: unknown })?.contacts;
  const out = new Map<string, string>();
  if (!Array.isArray(contacts)) return out;
  for (const c of contacts) {
    if (c !== null && typeof c === 'object' && typeof (c as { id?: unknown }).id === 'string') {
      const row = c as { id: string; name?: unknown };
      out.set(row.id, typeof row.name === 'string' ? row.name : row.id);
    }
  }
  return out;
}

/** Francs text to integer Rappen; null when it is not a readable amount. */
function toMinor(value: string): number | null {
  const parsed = Number.parseFloat(value.replace(/'/g, '').replace(',', '.'));
  if (Number.isNaN(parsed) || parsed < 0) return null;
  return Math.round(parsed * 100);
}

interface LineDraft {
  description: string;
  price: string;
}

interface QuoteDraft {
  contactId: string;
  validUntil: string;
  lines: LineDraft[];
}

const EMPTY_DRAFT: QuoteDraft = { contactId: '', validUntil: '', lines: [{ description: '', price: '' }] };

export function Quotes() {
  const t = useT();
  const client = useClient();
  const workspaceId = useWorkspaceId();
  const { can } = useCapabilities();

  const [quotes, setQuotes] = useState<QuoteView[]>([]);
  const [contacts, setContacts] = useState<Map<string, string>>(new Map());
  const [views, setViews] = useState<SavedView[]>([]);
  const [viewId, setViewId] = useState('');
  const [showSuperseded, setShowSuperseded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [denied, setDenied] = useState(false);
  const [writeError, setWriteError] = useState<Err | null>(null);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<QuoteDraft>(EMPTY_DRAFT);
  const [openId, setOpenId] = useState<string | null>(null);
  const [decliningId, setDecliningId] = useState<string | null>(null);
  const [declineReason, setDeclineReason] = useState('');
  /** The accept link is scoped to the quote that produced it, so opening another quote's drawer
      never shows a stale link that belongs to a different quote. */
  const [acceptLink, setAcceptLink] = useState<{ quoteId: string; url: string } | null>(null);

  const canWrite = can(CAP.issue);
  const canSend = can(CAP.send);

  const load = useCallback(async () => {
    if (workspaceId === null) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setFailed(false);
    setDenied(false);
    const [listed, savedViews, contactList] = await Promise.all([
      client.call('quotes_list', {
        workspaceId,
        ...(viewId === '' ? {} : { savedViewId: viewId }),
        ...(showSuperseded ? { includeSuperseded: true } : {}),
      }),
      client.call('list_saved_views', { workspaceId, entityKind: 'quote' }),
      client.call('list_contacts', { workspaceId }),
    ]);
    if (isErr(listed.body)) {
      if (listed.body.error === 'permission_denied' || listed.status === 403) setDenied(true);
      else setFailed(true);
      setLoading(false);
      return;
    }
    const parsed = parseQuotes(listed.body);
    if (parsed === null) {
      setFailed(true);
      setLoading(false);
      return;
    }
    setQuotes(parsed);
    if (!isErr(savedViews.body)) setViews(parseViews(savedViews.body));
    if (!isErr(contactList.body)) setContacts(parseContacts(contactList.body));
    setLoading(false);
  }, [client, workspaceId, viewId, showSuperseded]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Run a write, surface the engine's own refusal, and re-read on success. */
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

  const create = useCallback(async () => {
    const lines = draft.lines
      .filter((l) => l.description.trim() !== '' || l.price.trim() !== '')
      .map((l) => ({ description: l.description, unitPriceMinor: toMinor(l.price) ?? -1 }));
    const body = await write('quotes_create', {
      contactId: draft.contactId,
      ...(draft.validUntil === '' ? {} : { validUntil: draft.validUntil }),
      lines,
      idempotencyKey: newKey(),
    });
    if (body !== null) {
      setCreating(false);
      setDraft(EMPTY_DRAFT);
    }
  }, [write, draft]);

  const send = useCallback(
    async (quoteId: string) => {
      const body = await write('quotes_send', { quoteId, idempotencyKey: newKey() });
      if (body !== null && typeof body.acceptUrl === 'string') setAcceptLink({ quoteId, url: body.acceptUrl });
    },
    [write],
  );

  const doDecline = useCallback(
    async (quoteId: string) => {
      const body = await write('quotes_decline', {
        quoteId,
        ...(declineReason.trim() === '' ? {} : { declineReason: declineReason.trim() }),
        idempotencyKey: newKey(),
      });
      if (body !== null) {
        setDecliningId(null);
        setDeclineReason('');
      }
    },
    [write, declineReason],
  );

  /** Open a quote's drawer. Switching quotes drops the previous quote's accept link and write error
      so a stale link or refusal never bleeds into a different quote's context. */
  const openQuote = useCallback((quoteId: string) => {
    setOpenId((current) => {
      if (current === quoteId) return current;
      setAcceptLink(null);
      setWriteError(null);
      setDecliningId(null);
      setDeclineReason('');
      return quoteId;
    });
  }, []);

  /** Close the drawer. DetailDrawer's focus trap returns focus to the row that opened it. */
  const closeDrawer = useCallback(() => {
    setOpenId(null);
    setDecliningId(null);
    setDeclineReason('');
    setAcceptLink(null);
  }, []);

  const openCreate = useCallback(() => {
    setWriteError(null);
    setDraft(EMPTY_DRAFT);
    setCreating(true);
  }, []);

  const errorMessage = (error: Err): string => {
    const known = [
      'validity_in_past',
      'no_lines',
      'quote_expired',
      'edit_draft_instead',
      'invalid_token',
      'illegal_transition',
      'invalid_reference',
    ];
    if (known.includes(error.error)) return t(`quotes.error.${error.error}`);
    if (error.error === 'permission_denied') return t('quotes.error.permissionDenied.write');
    return t('errors.fallback');
  };

  if (workspaceId === null) return <NoWorkspaceState />;
  if (denied) return <PermissionDenied body={t('quotes.error.permissionDenied.read')} />;

  const selected = openId === null ? undefined : quotes.find((q) => q.id === openId);
  const statusLabel = (q: QuoteView) => (q.expired ? t('quotes.status.expired') : t(`quotes.status.${q.status}`));
  const statusKind = (q: QuoteView): StatusKind => (q.expired ? 'warn' : STATUS_KIND[q.status] ?? 'neutral');
  const statusChip = (q: QuoteView) => <Status kind={statusKind(q)} label={statusLabel(q)} />;
  // A contact the list did not return reads as such, never as its raw id (K-38).
  const contactName = (id: string | null) => (id === null ? '-' : contacts.get(id) ?? t('quotes.unknownContact'));

  // The list columns: text left, the total a numeric right-aligned `.t-num` cell (shared DataTable).
  const columns: DataTableColumn<QuoteView>[] = [
    {
      key: 'number',
      header: t('quotes.field.number'),
      render: (q) => (
        <>
          {q.number ?? '-'}
          {q.version > 1 && <span className="quotes-version"> v{q.version}</span>}
        </>
      ),
    },
    { key: 'contact', header: t('quotes.field.contact'), render: (q) => contactName(q.contactId) },
    { key: 'valid', header: t('quotes.field.valid_until'), render: (q) => (q.validUntil === null ? '-' : formatDate(q.validUntil)) },
    { key: 'total', header: t('quotes.field.total'), numeric: true, render: (q) => formatMoney(q.totalMinor, q.currency) },
    { key: 'status', header: t('quotes.field.status'), render: (q) => statusChip(q) },
  ];

  // The saved-view picker, the show-superseded toggle and the create action ride the SurfaceHeader.
  const headerActions = (
    <>
      {views.length > 0 && (
        <div className="quotes-picker">
          <span>{t('quotes.savedView')}</span>
          <Select
            value={viewId}
            onChange={setViewId}
            options={[
              { value: '', label: t('quotes.view.all') },
              ...views.map((view) => ({ value: view.id, label: view.name })),
            ]}
            ariaLabel={t('quotes.savedView')}
          />
        </div>
      )}
      <label className="quotes-toggle">
        <input type="checkbox" checked={showSuperseded} onChange={(e) => setShowSuperseded(e.target.checked)} />
        <span>{t('quotes.filter.showSuperseded')}</span>
      </label>
      {canWrite && (
        <button type="button" className="btn btn--primary" onClick={openCreate}>
          {t('quotes.action.create')}
        </button>
      )}
    </>
  );

  // The detail drawer's pinned action row, assembled per status. Empty (a terminal record with no
  // write right) leaves the foot off; the header close control still closes the drawer.
  const detailActions: ReactNode[] = [];
  if (selected !== undefined && canWrite) {
    if (selected.status === 'draft' && canSend) {
      detailActions.push(
        <button key="send" type="button" className="btn btn--primary" onClick={() => void send(selected.id)}>
          {t('quotes.action.send')}
        </button>,
      );
    }
    if (selected.status === 'sent' && !selected.expired) {
      detailActions.push(
        <button
          key="accept"
          type="button"
          className="btn btn--primary"
          onClick={() => void write('quotes_accept', { quoteId: selected.id, actor: 'Studio', idempotencyKey: newKey() })}
        >
          {t('quotes.action.mark_accepted')}
        </button>,
      );
    }
    if (selected.status === 'sent') {
      detailActions.push(
        <button key="decline" type="button" className="btn btn--secondary" onClick={() => setDecliningId(selected.id)}>
          {t('quotes.action.decline')}
        </button>,
      );
    }
    if (['sent', 'declined', 'expired'].includes(selected.status)) {
      detailActions.push(
        <button
          key="revise"
          type="button"
          className="btn btn--secondary"
          onClick={() => void write('quotes_revise', { quoteId: selected.id, idempotencyKey: newKey() })}
        >
          {t('quotes.action.revise')}
        </button>,
      );
    }
    if (selected.status === 'accepted') {
      detailActions.push(
        <button
          key="convert-order"
          type="button"
          className="btn btn--secondary"
          onClick={() => void write('quotes_convert', { quoteId: selected.id, to: 'order', idempotencyKey: newKey() })}
        >
          {t('quotes.action.convert_order')}
        </button>,
        <button
          key="convert-invoice"
          type="button"
          className="btn btn--primary"
          onClick={() => void write('quotes_convert', { quoteId: selected.id, to: 'invoice', idempotencyKey: newKey() })}
        >
          {t('quotes.action.convert_invoice')}
        </button>,
        // D03 reserved cross-touch: raise a fulfilment sales order (order -> delivery -> invoice)
        // from the accepted quote via `sales_order_from_quote`. Distinct from `quotes_convert to
        // order` (an A10 order document); this seeds the D03 Aufträge surface. One affordance only.
        <button
          key="sales-order"
          type="button"
          className="btn btn--secondary"
          onClick={() => void write('sales_order_from_quote', { quoteId: selected.id, idempotencyKey: newKey() })}
        >
          {t('quotes.action.to_sales_order')}
        </button>,
      );
    }
  }

  return (
    <section className="quotes" aria-labelledby="quotes-title">
      <SurfaceHeader
        title={t('quotes.route.title')}
        titleId="quotes-title"
        help={<SurfaceHelp surface="Quotes" />}
        actions={headerActions}
      />

      {failed && <ErrorBanner message={t('quotes.error.transport')} onRetry={() => void load()} />}

      {!failed && (
        <DataTable
          columns={columns}
          rows={quotes}
          rowKey={(q) => q.id}
          caption={t('quotes.route.title')}
          loading={loading}
          skeletonRows={4}
          onRowClick={(q) => openQuote(q.id)}
          rowLabel={(q) => (q.number === null ? t('quotes.rowOpenDraft') : t('quotes.rowOpen', { row: q.number }))}
          emptyState={
            <EmptyState
              title={t('quotes.empty')}
              hint={t('quotes.empty_hint')}
              action={canWrite ? { label: t('quotes.action.create'), onClick: openCreate } : undefined}
            />
          }
        />
      )}

      {creating && canWrite && (
        <DetailDrawer
          open
          onClose={() => setCreating(false)}
          title={t('quotes.action.create')}
          closeLabel={t('quotes.drawer.close')}
          footer={
            <>
              <button type="button" className="btn btn--secondary" onClick={() => setCreating(false)}>
                {t('quotes.editor.discard')}
              </button>
              <button type="submit" form="quotes-create-form" className="btn btn--primary">
                {t('quotes.editor.save')}
              </button>
            </>
          }
        >
          {writeError !== null && <ErrorBanner message={errorMessage(writeError)} />}
          <form
            id="quotes-create-form"
            className="quotes-editor"
            aria-label={t('quotes.action.create')}
            onSubmit={(e) => {
              e.preventDefault();
              void create();
            }}
          >
            <div className="quotes-field">
              <span>{t('quotes.field.contact')}</span>
              <Select
                value={draft.contactId}
                onChange={(value) => setDraft({ ...draft, contactId: value })}
                options={[
                  { value: '', label: t('quotes.field.contactPick') },
                  ...[...contacts.entries()].map(([id, name]) => ({ value: id, label: name })),
                ]}
                ariaLabel={t('quotes.field.contact')}
              />
            </div>
            <label className="quotes-field">
              <span>{t('quotes.field.valid_until')}</span>
              <input
                type="date"
                className="field"
                value={draft.validUntil}
                onChange={(e) => setDraft({ ...draft, validUntil: e.target.value })}
              />
            </label>
            <fieldset className="quotes-lines">
              <legend>{t('quotes.field.lineDesc')}</legend>
              {draft.lines.map((line, index) => (
                <div key={index} className="quotes-line-row">
                  <input
                    type="text"
                    className="field quotes-line-desc"
                    aria-label={t('quotes.field.lineDesc')}
                    value={line.description}
                    placeholder={t('quotes.field.lineDesc')}
                    onChange={(e) => {
                      const lines = draft.lines.slice();
                      lines[index] = { ...lines[index], description: e.target.value };
                      setDraft({ ...draft, lines });
                    }}
                  />
                  <input
                    type="text"
                    inputMode="decimal"
                    className="field quotes-line-price t-num"
                    aria-label={t('quotes.field.linePrice')}
                    value={line.price}
                    placeholder="1'500.00"
                    onChange={(e) => {
                      const lines = draft.lines.slice();
                      lines[index] = { ...lines[index], price: e.target.value };
                      setDraft({ ...draft, lines });
                    }}
                  />
                  {draft.lines.length > 1 && (
                    <button
                      type="button"
                      className="btn btn--ghost btn--icon btn--sm"
                      aria-label={t('quotes.action.removeLine')}
                      onClick={() => setDraft({ ...draft, lines: draft.lines.filter((_, i) => i !== index) })}
                    >
                      <CloseGlyph aria-hidden="true" />
                    </button>
                  )}
                </div>
              ))}
              <button
                type="button"
                className="btn btn--secondary btn--sm"
                onClick={() => setDraft({ ...draft, lines: [...draft.lines, { description: '', price: '' }] })}
              >
                {t('quotes.action.addLine')}
              </button>
            </fieldset>
          </form>
        </DetailDrawer>
      )}

      {selected !== undefined && (
        <DetailDrawer
          open
          onClose={closeDrawer}
          title={selected.number ?? t('quotes.status.draft')}
          closeLabel={t('quotes.drawer.close')}
          headerExtra={statusChip(selected)}
          footer={detailActions.length > 0 ? <>{detailActions}</> : undefined}
        >
          {writeError !== null && <ErrorBanner message={errorMessage(writeError)} />}

          <dl className="quotes-drawer-facts">
            <dt>{t('quotes.field.contact')}</dt>
            <dd>{contactName(selected.contactId)}</dd>
            <dt>{t('quotes.field.total')}</dt>
            <dd>
              <span className="t-money">{formatMoney(selected.totalMinor, selected.currency)}</span>
            </dd>
            <dt>{t('quotes.field.status')}</dt>
            <dd>{statusChip(selected)}</dd>
            {selected.validUntil !== null && (
              <>
                <dt>{t('quotes.field.valid_until')}</dt>
                <dd>{formatDate(selected.validUntil)}</dd>
              </>
            )}
          </dl>

          {acceptLink !== null && acceptLink.quoteId === selected.id && (
            <div className="quotes-cloud-note" role="note">
              <p>{t('quotes.send.cloud_note')}</p>
              <input
                type="text"
                className="field quotes-cloud-link"
                readOnly
                value={acceptLink.url}
                aria-label={t('quotes.send.copyLink')}
                onFocus={(e) => e.target.select()}
              />
            </div>
          )}

          {decliningId === selected.id && (
            <form
              className="quotes-decline-form"
              aria-label={t('quotes.action.decline')}
              onSubmit={(e) => {
                e.preventDefault();
                void doDecline(selected.id);
              }}
            >
              <label className="quotes-field">
                <span>{t('quotes.decline.reason')}</span>
                <input
                  type="text"
                  className="field"
                  value={declineReason}
                  onChange={(e) => setDeclineReason(e.target.value)}
                />
              </label>
              {/* The drawer's footer holds the view's one primary; this inline confirm is secondary. */}
              <div className="quotes-form-actions">
                <button type="submit" className="btn btn--secondary btn--sm">
                  {t('quotes.action.decline')}
                </button>
                <button type="button" className="btn btn--ghost btn--sm" onClick={() => setDecliningId(null)}>
                  {t('quotes.editor.discard')}
                </button>
              </div>
            </form>
          )}
        </DetailDrawer>
      )}
    </section>
  );
}
export default Quotes;
