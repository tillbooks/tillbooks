/**
 * C01, Pipeline (`/deals`): the Kanban board over the deal funnel.
 *
 * ONE READ SERVES THE BOARD. `deals_list` answers the pipelines, the selected pipeline's stages in
 * sort order, its deals (each with its round-once `weightedMinor`), the open-deals weighted total
 * and the base currency it is denominated in; the surface only groups cards under stage columns.
 * The weighted pill shows "-" when no open deal exists (data honesty: never a fabricated CHF 0.00
 * that reads as a real total).
 *
 * MOVES ARE A STAGE PICKER, NOT A DRAG. Every card carries a labelled stage select (the keyboard
 * fallback the spec demands is therefore the primary control; a drag layer is polish for the final
 * UX pass, D46). Picking an OPEN stage calls `deals_move`; picking the won/lost stage routes
 * through `deals_mark`, the engine's ONE door to a terminal status, with the lost reason collected
 * first (`lost_reason_required` is a form, not a surprise).
 *
 * THE PERMISSION GATES HERE ARE A CONVENIENCE AND NOT THE ENFORCEMENT (the standing Studio rule):
 * `whoami` is the one source, it fails open, and the engine is the real gate. Without `deals.read`
 * the board is a padlock panel, never an empty board that looks like "no deals exist".
 *
 * ## BUILT ON THE SHARED UI PRIMITIVES (D118 B2, 2026-08-23)
 *
 * The page header is the shared `SurfaceHeader` (title, help, the write actions) and the filter row
 * the shared `FilterBar` (a client-side quick-filter over title and contact, with the pipeline,
 * saved-view and show-closed controls in its slot and one Clear affordance). The per-surface header
 * and controls-row CSS is gone with them.
 *
 * The board itself is NOT a `DataTable` (a Kanban funnel is not a row list), and the deal detail
 * stays a NON-MODAL two-pane side panel, not the shared `DetailDrawer`: the two-pane layout is a
 * deliberate C01 choice (opening a card shows its detail ALONGSIDE the board, never below a
 * horizontally-scrolling column set), while `DetailDrawer` is a modal overlay that would hide the
 * board behind a scrim. The create and settings panels stay inline expanders for the same reason.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { useClient } from '../../lib/client-context';
import { isErr, type Err } from '../../lib/client';
import { CAP, useCapabilities } from '../../lib/capabilities';
import { useWorkspaceId } from '../../app/workspace';
import { useT, formatMoney, formatDate } from '../../i18n';
import { SurfaceHelp } from '../../components/SurfaceHelp';
import { SurfaceHeader } from '../../components/SurfaceHeader';
import { FilterBar } from '../../components/FilterBar';
import { Select } from '../../components/Select';
import { Status, type StatusKind } from '../../components/Status';
import { CloseGlyph } from '../../components/icons';
import { EmptyState, ErrorBanner, NoWorkspaceState, PermissionDenied } from '../../components/states';
import './Deals.css';

/** A fresh key per write, so a retry after a transport failure is a retry and not a second write. */
const newKey = () => crypto.randomUUID();

export interface StageView {
  id: string;
  name: string;
  sort: number;
  probability: number;
  outcome: string | null;
}

export interface DealView {
  id: string;
  contactId: string;
  stageId: string;
  title: string;
  status: string;
  probability: number;
  valueMinor: number;
  currency: string;
  valueBaseMinor: number;
  weightedMinor: number;
  expectedCloseOn: string | null;
  lostReason: string | null;
  quoteId: string | null;
}

interface Board {
  pipelines: { id: string; name: string }[];
  pipelineId: string | null;
  stages: StageView[];
  deals: DealView[];
  weightedTotalMinor: number;
  baseCurrency: string;
}

/** Read the engine's board payload defensively: a shape this surface cannot read is a failed READ. */
function parseBoard(body: unknown): Board | null {
  if (body === null || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  if (!Array.isArray(b.stages) || !Array.isArray(b.deals) || !Array.isArray(b.pipelines)) return null;
  if (typeof b.baseCurrency !== 'string' || typeof b.weightedTotalMinor !== 'number') return null;
  const pipeline = b.pipeline as { id?: unknown } | null;
  return {
    pipelines: (b.pipelines as { id: string; name: string }[]).filter(
      (p) => typeof p?.id === 'string' && typeof p?.name === 'string',
    ),
    pipelineId: pipeline !== null && typeof pipeline === 'object' && typeof pipeline.id === 'string' ? pipeline.id : null,
    stages: (b.stages as StageView[]).filter((s) => typeof s?.id === 'string'),
    deals: (b.deals as DealView[]).filter((d) => typeof d?.id === 'string'),
    weightedTotalMinor: b.weightedTotalMinor,
    baseCurrency: b.baseCurrency,
  };
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

/**
 * The Status kind per deal status (K-22): the shared glyph plus the word, never a dingbat and never
 * colour alone. An open deal is under way, a won one good, a lost one out of play.
 */
function dealStatusKind(status: string): StatusKind {
  if (status === 'won') return 'success';
  if (status === 'lost') return 'inactive';
  if (status === 'open') return 'pending';
  return 'neutral';
}

/** The single OP5 kind enum C00 owns; mirrored labels live in the catalogue. */
const ACTIVITY_KINDS = ['note', 'call', 'email', 'meeting', 'task'] as const;

interface DealDraft {
  contactId: string;
  title: string;
  value: string;
  currency: string;
  expectedCloseOn: string;
}

const EMPTY_DRAFT: DealDraft = { contactId: '', title: '', value: '', currency: '', expectedCloseOn: '' };

interface ActivityDraft {
  kind: string;
  body: string;
  reminderAt: string;
}

const EMPTY_ACTIVITY: ActivityDraft = { kind: 'note', body: '', reminderAt: '' };

export function Deals() {
  const t = useT();
  const client = useClient();
  const workspaceId = useWorkspaceId();
  const { can } = useCapabilities();

  const [board, setBoard] = useState<Board | null>(null);
  const [contacts, setContacts] = useState<Map<string, string>>(new Map());
  const [views, setViews] = useState<SavedView[]>([]);
  const [viewId, setViewId] = useState('');
  const [pipelineId, setPipelineId] = useState('');
  const [showClosed, setShowClosed] = useState(false);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [denied, setDenied] = useState(false);
  const [writeError, setWriteError] = useState<Err | null>(null);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<DealDraft>(EMPTY_DRAFT);
  const [openId, setOpenId] = useState<string | null>(null);
  const [activity, setActivity] = useState<ActivityDraft>(EMPTY_ACTIVITY);
  const [lostFor, setLostFor] = useState<string | null>(null);
  const [lostReason, setLostReason] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [newStage, setNewStage] = useState({ name: '', probability: '50' });
  const [viewName, setViewName] = useState('');

  const canWrite = can(CAP.dealsWrite);

  const load = useCallback(async () => {
    if (workspaceId === null) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setFailed(false);
    setDenied(false);
    const [listed, savedViews, contactList] = await Promise.all([
      client.call('deals_list', {
        workspaceId,
        ...(viewId === '' ? {} : { savedViewId: viewId }),
        ...(pipelineId === '' ? {} : { pipelineId }),
        ...(showClosed ? { includeClosed: true } : {}),
      }),
      client.call('list_saved_views', { workspaceId, entityKind: 'deal' }),
      client.call('list_contacts', { workspaceId }),
    ]);
    if (isErr(listed.body)) {
      if (listed.body.error === 'permission_denied' || listed.status === 403) setDenied(true);
      else setFailed(true);
      setLoading(false);
      return;
    }
    const parsed = parseBoard(listed.body);
    if (parsed === null) {
      setFailed(true);
      setLoading(false);
      return;
    }
    setBoard(parsed);
    // The pickers degrade honestly: a refused side read leaves them empty, the board intact.
    if (!isErr(savedViews.body)) setViews(parseViews(savedViews.body));
    if (!isErr(contactList.body)) setContacts(parseContacts(contactList.body));
    setLoading(false);
  }, [client, workspaceId, viewId, pipelineId, showClosed]);

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
    const valueMinor = toMinor(draft.value);
    const body = await write('deals_create', {
      contactId: draft.contactId,
      title: draft.title,
      valueMinor: valueMinor ?? -1,
      ...(draft.currency.trim() === '' ? {} : { currency: draft.currency.trim().toUpperCase() }),
      ...(draft.expectedCloseOn === '' ? {} : { expectedCloseOn: draft.expectedCloseOn }),
      idempotencyKey: newKey(),
    });
    if (body !== null) {
      setCreating(false);
      setDraft(EMPTY_DRAFT);
    }
  }, [write, draft]);

  /** A stage pick: an open stage moves, the won stage marks, the lost stage asks for the reason. */
  const pickStage = useCallback(
    async (deal: DealView, stageId: string) => {
      const stage = board?.stages.find((s) => s.id === stageId);
      if (stage === undefined) return;
      if (stage.outcome === 'won') {
        await write('deals_mark', { dealId: deal.id, status: 'won', idempotencyKey: newKey() });
      } else if (stage.outcome === 'lost') {
        setLostFor(deal.id);
        setLostReason('');
      } else {
        await write('deals_move', { dealId: deal.id, stageId, idempotencyKey: newKey() });
      }
    },
    [board, write],
  );

  const markLost = useCallback(
    async (dealId: string) => {
      const body = await write('deals_mark', { dealId, status: 'lost', lostReason, idempotencyKey: newKey() });
      if (body !== null) {
        setLostFor(null);
        setLostReason('');
      }
    },
    [write, lostReason],
  );

  const logActivity = useCallback(
    async (dealId: string) => {
      const reminder = activity.reminderAt === '' ? undefined : new Date(activity.reminderAt).toISOString();
      const body = await write('deals_log_activity', {
        dealId,
        kind: activity.kind,
        body: activity.body,
        ...(reminder === undefined ? {} : { reminderAt: reminder }),
        idempotencyKey: newKey(),
      });
      if (body !== null) setActivity(EMPTY_ACTIVITY);
    },
    [write, activity],
  );

  const saveView = useCallback(async () => {
    const body = await write('create_saved_view', {
      entityKind: 'deal',
      name: viewName,
      layout: 'board',
      filters: {
        ...(pipelineId === '' ? {} : { pipelineId }),
        ...(showClosed ? { includeClosed: true } : {}),
      },
      idempotencyKey: newKey(),
    });
    if (body !== null) setViewName('');
  }, [write, viewName, pipelineId, showClosed]);

  const errorMessage = (error: Err): string => {
    const known = [
      'contact_not_found',
      'stage_not_in_pipeline',
      'lost_reason_required',
      'terminal_stage_use_mark',
      'deal_closed',
      'needs_fx_rate',
      'reminder_in_past',
      'invalid_activity_kind',
      'needs_quotes_module',
      'pipeline_has_no_open_stage',
    ];
    if (known.includes(error.error)) return t(`deals.error.${error.error}`);
    if (error.error === 'permission_denied') return t('deals.error.permissionDenied.write');
    return t('errors.fallback');
  };

  if (workspaceId === null) return <NoWorkspaceState />;
  if (denied) return <PermissionDenied body={t('deals.error.permissionDenied.read')} />;

  const openDeals = board?.deals.filter((d) => d.status === 'open') ?? [];
  const selected = openId === null ? undefined : board?.deals.find((d) => d.id === openId);

  /** A contact's name for the screen; a contact the list did not return reads as such, never as its id (K-38). */
  const contactName = (contactId: string): string => contacts.get(contactId) ?? t('deals.unknownContact');

  const card = (deal: DealView) => {
    const live = deal.status === 'open';
    return (
      <li key={deal.id} className="deals-card">
        <button type="button" className="deals-card-main" onClick={() => setOpenId(openId === deal.id ? null : deal.id)}>
          <span className="deals-card-title">{deal.title}</span>
          <span className="deals-card-contact">{contactName(deal.contactId)}</span>
          <span className="deals-card-meta">
            <span className="t-money">{formatMoney(deal.valueMinor, deal.currency)}</span>
            <span className="t-num">{deal.probability}%</span>
            {deal.status !== 'open' && (
              <Status kind={dealStatusKind(deal.status)} label={t(`deals.status.${deal.status}`)} />
            )}
          </span>
        </button>
        {live && canWrite && (
          <div className="deals-move">
            <span>{t('deals.action.move')}</span>
            <Select
              value={deal.stageId}
              onChange={(value) => void pickStage(deal, value)}
              options={(board?.stages ?? []).map((stage) => ({ value: stage.id, label: stage.name }))}
              ariaLabel={t('deals.action.move')}
            />
          </div>
        )}
        {lostFor === deal.id && (
          <form
            className="deals-lost-form"
            aria-label={t('deals.lost.label', { title: deal.title })}
            onSubmit={(e) => {
              e.preventDefault();
              void markLost(deal.id);
            }}
          >
            <label className="deals-field">
              <span>{t('deals.lost.reason')}</span>
              <input className="field" type="text" value={lostReason} onChange={(e) => setLostReason(e.target.value)} required />
            </label>
            <div className="deals-form-actions">
              <button type="submit" className="btn btn--secondary btn--sm">
                {t('deals.action.markLost')}
              </button>
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => setLostFor(null)}>
                {t('deals.editor.discard')}
              </button>
            </div>
          </form>
        )}
      </li>
    );
  };

  /** The FilterBar quick-filter: a client-side find over the already-loaded board, title or contact. */
  const dealMatches = (deal: DealView): boolean => {
    const q = search.trim().toLowerCase();
    if (q === '') return true;
    return deal.title.toLowerCase().includes(q) || contactName(deal.contactId).toLowerCase().includes(q);
  };

  const column = (stage: StageView) => {
    const cards = (board?.deals ?? []).filter((deal) => deal.stageId === stage.id && dealMatches(deal));
    return (
      <section key={stage.id} className="deals-column" aria-labelledby={`deals-col-${stage.id}`}>
        <h2 id={`deals-col-${stage.id}`} className="deals-column-title">
          {stage.name}
          <span className="deals-count t-num">{cards.length}</span>
        </h2>
        {cards.length === 0 ? (
          <p className="deals-column-empty">{t('deals.emptyColumn')}</p>
        ) : (
          <ul className="deals-cards">{cards.map(card)}</ul>
        )}
      </section>
    );
  };

  const filtersActive = search.trim() !== '' || pipelineId !== '' || viewId !== '' || showClosed;
  const clearFilters = () => {
    setSearch('');
    setPipelineId('');
    setViewId('');
    setShowClosed(false);
  };

  return (
    <section className="deals" aria-labelledby="deals-title">
      <SurfaceHeader
        title={t('deals.route.title')}
        titleId="deals-title"
        help={<SurfaceHelp surface="Deals" />}
        actions={
          canWrite ? (
            <>
              <button type="button" className="btn btn--secondary" aria-label={t('deals.settings.open')} onClick={() => setSettingsOpen(!settingsOpen)}>
                {t('deals.settings.open')}
              </button>
              <button type="button" className="btn btn--primary" onClick={() => setCreating(!creating)}>
                {t('deals.action.create')}
              </button>
            </>
          ) : undefined
        }
      />

      <span className="deals-pill" aria-label={t('deals.weighted.label')}>
        {t('deals.weighted.label')}:{' '}
        <strong className="t-money">
          {openDeals.length === 0 || board === null ? '-' : formatMoney(board.weightedTotalMinor, board.baseCurrency)}
        </strong>
      </span>

      <FilterBar
        searchValue={search}
        onSearchChange={setSearch}
        searchLabel={t('deals.search')}
        searchPlaceholder={t('deals.search')}
        onClear={clearFilters}
        clearLabel={t('deals.filter.clear')}
        active={filtersActive}
      >
        {(board?.pipelines.length ?? 0) > 1 && (
          <div className="deals-picker">
            <span>{t('deals.pipeline.label')}</span>
            <Select
              value={pipelineId}
              onChange={setPipelineId}
              options={[
                { value: '', label: t('deals.pipeline.first') },
                ...(board?.pipelines ?? []).map((p) => ({ value: p.id, label: p.name })),
              ]}
              ariaLabel={t('deals.pipeline.label')}
            />
          </div>
        )}
        {views.length > 0 && (
          <div className="deals-picker">
            <span>{t('deals.view.label')}</span>
            <Select
              value={viewId}
              onChange={setViewId}
              options={[
                { value: '', label: t('deals.view.all') },
                ...views.map((view) => ({ value: view.id, label: view.name })),
              ]}
              ariaLabel={t('deals.view.label')}
            />
          </div>
        )}
        <label className="deals-toggle">
          <input type="checkbox" checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} />
          <span>{t('deals.filter.showClosed')}</span>
        </label>
      </FilterBar>

      {writeError !== null && <ErrorBanner message={errorMessage(writeError)} />}
      {failed && <ErrorBanner message={t('deals.error.transport')} onRetry={() => void load()} />}

      {creating && canWrite && (
        <form
          className="deals-editor"
          aria-label={t('deals.action.create')}
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <div className="deals-field">
            <span>{t('deals.field.contact')}</span>
            <Select
              value={draft.contactId}
              onChange={(value) => setDraft({ ...draft, contactId: value })}
              options={[
                { value: '', label: t('deals.field.contactPick') },
                ...[...contacts.entries()].map(([id, name]) => ({ value: id, label: name })),
              ]}
              ariaLabel={t('deals.field.contact')}
            />
          </div>
          <label className="deals-field">
            <span>{t('deals.field.title')}</span>
            <input className="field" type="text" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} required />
          </label>
          <label className="deals-field">
            <span>{t('deals.field.value')}</span>
            <input
              className="field"
              type="text"
              inputMode="decimal"
              value={draft.value}
              placeholder="25'000.00"
              onChange={(e) => setDraft({ ...draft, value: e.target.value })}
              required
            />
          </label>
          <label className="deals-field">
            <span>{t('deals.field.currency')}</span>
            <input
              className="field"
              type="text"
              value={draft.currency}
              maxLength={3}
              placeholder="CHF"
              onChange={(e) => setDraft({ ...draft, currency: e.target.value })}
            />
          </label>
          <label className="deals-field">
            <span>{t('deals.field.expectedClose')}</span>
            <input className="field" type="date" value={draft.expectedCloseOn} onChange={(e) => setDraft({ ...draft, expectedCloseOn: e.target.value })} />
          </label>
          {/* The surface's one primary is "Deal anlegen" in the header (K-08): this save is secondary. */}
          <div className="deals-form-actions">
            <button type="submit" className="btn btn--secondary btn--sm">
              {t('deals.editor.save')}
            </button>
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => setCreating(false)}>
              {t('deals.editor.discard')}
            </button>
          </div>
        </form>
      )}

      {settingsOpen && canWrite && board !== null && (
        <section className="deals-settings" aria-labelledby="deals-settings-title">
          <h2 id="deals-settings-title">{t('deals.settings.title')}</h2>
          <ul className="deals-settings-stages">
            {board.stages.map((stage) => (
              <li key={stage.id}>
                <span className="deals-settings-stage-name">{stage.name}</span>
                <span className="deals-settings-stage-meta t-num">
                  {stage.probability}%{stage.outcome !== null && ` · ${t(`deals.status.${stage.outcome === 'won' ? 'won' : 'lost'}`)}`}
                </span>
              </li>
            ))}
          </ul>
          <form
            className="deals-settings-add"
            aria-label={t('deals.settings.addStage')}
            onSubmit={(e) => {
              e.preventDefault();
              void (async () => {
                const body = await write('pipeline_stages_upsert', {
                  pipelineId: board.pipelineId,
                  name: newStage.name,
                  probability: Number.parseInt(newStage.probability, 10),
                  idempotencyKey: newKey(),
                });
                if (body !== null) setNewStage({ name: '', probability: '50' });
              })();
            }}
          >
            <label className="deals-field">
              <span>{t('deals.settings.stageName')}</span>
              <input className="field" type="text" value={newStage.name} onChange={(e) => setNewStage({ ...newStage, name: e.target.value })} required />
            </label>
            <label className="deals-field">
              <span>{t('deals.field.probability')}</span>
              <input
                className="field"
                type="number"
                min={0}
                max={100}
                value={newStage.probability}
                onChange={(e) => setNewStage({ ...newStage, probability: e.target.value })}
              />
            </label>
            <button type="submit" className="btn btn--secondary btn--sm">
              {t('deals.settings.addStage')}
            </button>
          </form>
          <form
            className="deals-settings-view"
            aria-label={t('deals.customization.save_view')}
            onSubmit={(e) => {
              e.preventDefault();
              void saveView();
            }}
          >
            <label className="deals-field">
              <span>{t('deals.customization.viewName')}</span>
              <input className="field" type="text" value={viewName} onChange={(e) => setViewName(e.target.value)} required />
            </label>
            <button type="submit" className="btn btn--secondary btn--sm">
              {t('deals.customization.save_view')}
            </button>
          </form>
        </section>
      )}

      <div className="deals-workspace">
        <div className="deals-main">
          {loading ? (
            <div className="deals-board-skeleton" role="status" aria-busy="true" aria-live="polite">
              <span className="deals-sr">{t('deals.loading')}</span>
              {[0, 1, 2].map((skeletonColumn) => (
                <div key={skeletonColumn} className="deals-skeleton-column" aria-hidden="true">
                  <span className="skeleton deals-skeleton-title" />
                  <span className="skeleton deals-skeleton-card" />
                  <span className="skeleton deals-skeleton-card" />
                </div>
              ))}
            </div>
          ) : failed ? null : board === null || board.deals.length === 0 ? (
            <EmptyState
              title={t('deals.empty')}
              hint={t('deals.emptyHint')}
              {...(canWrite ? { action: { label: t('deals.action.create'), onClick: () => setCreating(true) } } : {})}
            />
          ) : (
            <div className="deals-board">{board.stages.map(column)}</div>
          )}
        </div>

        {selected !== undefined && (
          <section className="deals-drawer" aria-labelledby="deals-drawer-title">
          <header className="deals-drawer-head">
            <h2 id="deals-drawer-title">{selected.title}</h2>
            <button type="button" className="btn btn--ghost btn--icon btn--sm" aria-label={t('deals.drawer.close')} onClick={() => setOpenId(null)}>
              <CloseGlyph aria-hidden="true" />
            </button>
          </header>
          <dl className="deals-drawer-facts">
            <dt>{t('deals.field.contact')}</dt>
            <dd>{contactName(selected.contactId)}</dd>
            <dt>{t('deals.field.value')}</dt>
            <dd>
              <span className="t-money">{formatMoney(selected.valueMinor, selected.currency)}</span>
              {board !== null && selected.currency !== board.baseCurrency && (
                <span className="deals-base">
                  {' ('}
                  <span className="t-money">{formatMoney(selected.valueBaseMinor, board.baseCurrency)}</span>
                  {')'}
                </span>
              )}
            </dd>
            <dt>{t('deals.field.weighted')}</dt>
            <dd>
              {board === null ? '-' : <span className="t-money">{formatMoney(selected.weightedMinor, board.baseCurrency)}</span>}
            </dd>
            <dt>{t('deals.field.status')}</dt>
            <dd>
              <Status kind={dealStatusKind(selected.status)} label={t(`deals.status.${selected.status}`)} />
              {selected.lostReason !== null && <span className="deals-lost-reason"> ({selected.lostReason})</span>}
            </dd>
            {selected.expectedCloseOn !== null && (
              <>
                <dt>{t('deals.field.expectedClose')}</dt>
                <dd>{formatDate(selected.expectedCloseOn)}</dd>
              </>
            )}
            {selected.quoteId !== null && (
              <>
                <dt>{t('deals.field.quote')}</dt>
                {/* The quote's id is a machine value (K-38): the fact is that one exists, and the way
                    there is the Offerten list. */}
                <dd>
                  <Link className="link-inline" to="/quotes">
                    {t('deals.field.quoteLinked')}
                  </Link>
                </dd>
              </>
            )}
          </dl>
          {canWrite && (
            <div className="deals-drawer-actions">
              {selected.status === 'open' && (
                <button
                  type="button"
                  className="btn btn--secondary btn--sm"
                  onClick={() => void write('deals_mark', { dealId: selected.id, status: 'won', idempotencyKey: newKey() })}
                >
                  {t('deals.action.markWon')}
                </button>
              )}
              {selected.status === 'open' && (
                <button type="button" className="btn btn--secondary btn--sm" onClick={() => setLostFor(selected.id)}>
                  {t('deals.action.markLost')}
                </button>
              )}
              {selected.status !== 'open' && (
                <button
                  type="button"
                  className="btn btn--secondary btn--sm"
                  onClick={() => void write('deals_mark', { dealId: selected.id, status: 'open', idempotencyKey: newKey() })}
                >
                  {t('deals.action.reopen')}
                </button>
              )}
              {selected.quoteId === null && (
                <button
                  type="button"
                  className="btn btn--secondary btn--sm"
                  onClick={() => void write('deals_to_quote', { dealId: selected.id, idempotencyKey: newKey() })}
                >
                  {t('deals.action.to_quote')}
                </button>
              )}
            </div>
          )}
          {lostFor === selected.id && (
            <form
              className="deals-lost-form"
              aria-label={t('deals.lost.label', { title: selected.title })}
              onSubmit={(e) => {
                e.preventDefault();
                void markLost(selected.id);
              }}
            >
              <label className="deals-field">
                <span>{t('deals.lost.reason')}</span>
                <input className="field" type="text" value={lostReason} onChange={(e) => setLostReason(e.target.value)} required />
              </label>
              <div className="deals-form-actions">
                <button type="submit" className="btn btn--secondary btn--sm">
                  {t('deals.action.markLost')}
                </button>
                <button type="button" className="btn btn--ghost btn--sm" onClick={() => setLostFor(null)}>
                  {t('deals.editor.discard')}
                </button>
              </div>
            </form>
          )}
          {canWrite && (
            <form
              className="deals-activity"
              aria-label={t('deals.activity.label')}
              onSubmit={(e) => {
                e.preventDefault();
                void logActivity(selected.id);
              }}
            >
              <h3>{t('deals.activity.label')}</h3>
              <div className="deals-field">
                <span>{t('deals.activity.kind')}</span>
                <Select
                  value={activity.kind}
                  onChange={(value) => setActivity({ ...activity, kind: value })}
                  options={ACTIVITY_KINDS.map((kind) => ({ value: kind, label: t(`deals.activity.kinds.${kind}`) }))}
                  ariaLabel={t('deals.activity.kind')}
                />
              </div>
              <label className="deals-field">
                <span>{t('deals.activity.body')}</span>
                <textarea className="field" value={activity.body} onChange={(e) => setActivity({ ...activity, body: e.target.value })} required rows={2} />
              </label>
              <label className="deals-field">
                <span>{t('deals.activity.reminder')}</span>
                <input
                  className="field"
                  type="datetime-local"
                  value={activity.reminderAt}
                  onChange={(e) => setActivity({ ...activity, reminderAt: e.target.value })}
                />
              </label>
              <button type="submit" className="btn btn--secondary btn--sm">
                {t('deals.activity.log')}
              </button>
            </form>
          )}
        </section>
        )}
      </div>
    </section>
  );
}
export default Deals;
