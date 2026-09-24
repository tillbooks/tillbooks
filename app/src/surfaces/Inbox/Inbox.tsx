/**
 * G06, Posteingang (`/inbox`): the one place "what changed while I was away" is answered.
 *
 * WHY IT IS A ROUTE OF ITS OWN (spec §6, bar deliberately high): notifications are cross-cutting
 * by definition, the same reason E03's Aufgaben route earned one. No existing module can host
 * "everything that happened, across every module" without misfiling it.
 *
 * THREE SECTIONS, one read. `notifications_list` answers every row WITH its status and the live
 * `unreadCount`, and the surface only groups (Ungelesen/Gelesen/Archiv). Every row action (mark
 * read, archive) is a real button in a sensible tab order; the unread marker is a filled dot PLUS
 * the status label, never colour alone (WCAG 2.2 AA). The unread count is text in the heading, the
 * figure G15's rail bell will consume when its utility cluster lands (reconciled §0.6).
 *
 * THE PREFERENCES PANEL LIVES HERE (reconciled §0.5): there is no "Einstellungen" surface (D89),
 * and the panel is the per-user switchboard, not workspace governance. Teammate overrides (the
 * `manage_members` admin path) are deliberately NOT built into this surface: an admin configures a
 * teammate through the verb, and the panel edits only "my notifications", so nothing is shown then
 * rejected. Self-scope is structural in the engine; this surface simply always asks for its own
 * `userId` (the session actor `whoami` reports, with the Studio's own actor as the fallback).
 */
import { useCallback, useEffect, useState } from 'react';

import { useClient } from '../../lib/client-context';
import { isErr, type Err } from '../../lib/client';
import { useCapabilities } from '../../lib/capabilities';
import { useWorkspaceId } from '../../app/workspace';
import { useT, formatDate } from '../../i18n';
import { SurfaceHelp } from '../../components/SurfaceHelp';
import { Status, type StatusKind } from '../../components/Status';
import { Select } from '../../components/Select';
import { EmptyState, ErrorBanner, NoWorkspaceState, PermissionDenied, Skeleton } from '../../components/states';
import './Inbox.css';

/** A fresh key per write, so a retry after a transport failure is a retry and not a second write. */
const newKey = () => crypto.randomUUID();

export interface InboxRowItem {
  id: string;
  event: string;
  summaryI18nKey: string;
  summaryParams: Record<string, unknown>;
  status: string;
  entityKind: string | null;
  entityId: string | null;
  createdAt: string;
  day: string;
}

/** Read the engine's list payload defensively: a shape this surface cannot read is a failed READ. */
function parseItems(body: unknown): { items: InboxRowItem[]; unreadCount: number } | null {
  if (body === null || typeof body !== 'object') return null;
  const items = (body as { items?: unknown }).items;
  const unreadCount = (body as { unreadCount?: unknown }).unreadCount;
  if (!Array.isArray(items) || typeof unreadCount !== 'number') return null;
  const parsed: InboxRowItem[] = [];
  for (const raw of items) {
    if (raw === null || typeof raw !== 'object') return null;
    const n = raw as Record<string, unknown>;
    if (typeof n.id !== 'string' || typeof n.event !== 'string' || typeof n.status !== 'string') return null;
    parsed.push({
      id: n.id,
      event: n.event,
      summaryI18nKey: typeof n.summaryI18nKey === 'string' ? n.summaryI18nKey : '',
      summaryParams:
        n.summaryParams !== null && typeof n.summaryParams === 'object' && !Array.isArray(n.summaryParams)
          ? (n.summaryParams as Record<string, unknown>)
          : {},
      status: n.status,
      entityKind: typeof n.entityKind === 'string' ? n.entityKind : null,
      entityId: typeof n.entityId === 'string' ? n.entityId : null,
      createdAt: typeof n.createdAt === 'string' ? n.createdAt : '',
      day: typeof n.day === 'string' ? n.day : '',
    });
  }
  return { items: parsed, unreadCount };
}

interface PrefRow {
  event: string;
  channel: string;
  enabled: boolean;
  digest: string;
  stored: boolean;
}

function parsePrefs(body: unknown): { preferences: PrefRow[]; knownEvents: string[] } {
  const preferences = (body as { preferences?: unknown })?.preferences;
  const knownEvents = (body as { knownEvents?: unknown })?.knownEvents;
  return {
    preferences: Array.isArray(preferences)
      ? preferences.filter(
          (p): p is PrefRow =>
            p !== null &&
            typeof p === 'object' &&
            typeof (p as PrefRow).event === 'string' &&
            typeof (p as PrefRow).channel === 'string',
        )
      : [],
    knownEvents: Array.isArray(knownEvents) ? knownEvents.filter((e): e is string => typeof e === 'string') : [],
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
    .filter((v): v is { viewId?: string; id?: string; name: string } => v !== null && typeof v === 'object' && typeof (v as { name?: unknown }).name === 'string')
    .map((v) => ({ id: (v.viewId ?? v.id ?? '') as string, name: v.name }))
    .filter((v) => v.id !== '');
}

/**
 * The summary keys this surface owns copy for. A rule may carry any key; an unknown one renders
 * the EVENT id rather than a raw dot-path (honest, and no dev console noise about keys a
 * workspace's own automation invented).
 */
const KNOWN_SUMMARIES = new Set([
  'notifications.summary.task_due',
  'notifications.summary.invoice_issued',
  'notifications.summary.invoice_sent',
  'notifications.summary.deal_stage_changed',
  'notifications.summary.payment_recorded',
]);

/**
 * K-22: the row state is the shared Status, a drawn glyph plus the word. Unread is `neutral` (new,
 * nothing acted on yet) and never the accent; read and archived are out of play.
 */
const STATUS_KIND: Record<string, StatusKind> = { unread: 'neutral', read: 'inactive', archived: 'inactive' };

const SECTIONS = [
  { key: 'unread', status: 'unread' },
  { key: 'read', status: 'read' },
  { key: 'archive', status: 'archived' },
] as const;

const CHANNELS = ['inbox', 'email', 'push'] as const;
const OUTBOUND_CADENCES = ['instant', 'hourly', 'daily', 'weekly'] as const;

interface OverrideDraft {
  event: string;
  channel: string;
  enabled: boolean;
  digest: string;
}

export function Inbox() {
  const t = useT();
  const client = useClient();
  const workspaceId = useWorkspaceId();
  const { whoami } = useCapabilities();
  const userId = whoami?.actor ?? 'studio';

  const [items, setItems] = useState<InboxRowItem[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [views, setViews] = useState<SavedView[]>([]);
  const [viewId, setViewId] = useState('');
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [denied, setDenied] = useState(false);
  const [writeError, setWriteError] = useState<Err | null>(null);

  const [prefsOpen, setPrefsOpen] = useState(false);
  const [prefs, setPrefs] = useState<PrefRow[]>([]);
  const [knownEvents, setKnownEvents] = useState<string[]>([]);
  const [prefsLoading, setPrefsLoading] = useState(false);
  const [prefsFailed, setPrefsFailed] = useState(false);
  const [prefsNotice, setPrefsNotice] = useState(false);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<OverrideDraft>({ event: '', channel: 'inbox', enabled: false, digest: 'instant' });

  const load = useCallback(async () => {
    if (workspaceId === null) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setFailed(false);
    setDenied(false);
    const [listed, savedViews] = await Promise.all([
      client.call('notifications_list', { workspaceId, userId, ...(viewId === '' ? {} : { savedViewId: viewId }) }),
      client.call('list_saved_views', { workspaceId, entityKind: 'inbox_item' }),
    ]);
    if (isErr(listed.body)) {
      if (listed.body.error === 'permission_denied' || listed.body.error === 'forbidden' || listed.status === 403) setDenied(true);
      else setFailed(true);
      setLoading(false);
      return;
    }
    const parsed = parseItems(listed.body);
    if (parsed === null) {
      setFailed(true);
      setLoading(false);
      return;
    }
    setItems(parsed.items);
    setUnreadCount(parsed.unreadCount);
    // The picker degrades honestly: a refused view read leaves the picker empty, the queue intact.
    if (!isErr(savedViews.body)) setViews(parseViews(savedViews.body));
    setLoading(false);
  }, [client, workspaceId, userId, viewId]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadPrefs = useCallback(async () => {
    if (workspaceId === null) return;
    setPrefsLoading(true);
    setPrefsFailed(false);
    const response = await client.call('notifications_list_preferences', { workspaceId, userId });
    if (isErr(response.body)) {
      setPrefsFailed(true);
      setPrefsLoading(false);
      return;
    }
    const parsed = parsePrefs(response.body);
    setPrefs(parsed.preferences);
    setKnownEvents(parsed.knownEvents);
    setPrefsLoading(false);
  }, [client, workspaceId, userId]);

  useEffect(() => {
    if (prefsOpen) void loadPrefs();
  }, [prefsOpen, loadPrefs]);

  /** Run a write, surface the engine's own refusal, and re-read on success. */
  const write = useCallback(
    async (action: string, input: Record<string, unknown>, after: () => Promise<void>): Promise<boolean> => {
      if (workspaceId === null) return false;
      setWriteError(null);
      const response = await client.call(action, { workspaceId, ...input });
      if (isErr(response.body)) {
        setWriteError(response.body);
        return false;
      }
      await after();
      return true;
    },
    [client, workspaceId],
  );

  const markRead = (id: string) => void write('notifications_mark_read', { notificationId: id, idempotencyKey: newKey() }, load);
  const archive = (id: string) => void write('notifications_archive', { notificationId: id, idempotencyKey: newKey() }, load);
  const markAllRead = () => void write('notifications_mark_all_read', { userId, idempotencyKey: newKey() }, load);

  const savePreference = useCallback(
    async (pref: { event?: string; channel: string; enabled: boolean; digest?: string }) => {
      setPrefsNotice(false);
      const done = await write(
        'notifications_set_preference',
        {
          userId,
          channel: pref.channel,
          enabled: pref.enabled,
          ...(pref.event === undefined || pref.event === '' || pref.event === '*' ? {} : { event: pref.event }),
          ...(pref.digest === undefined ? {} : { digest: pref.digest }),
          idempotencyKey: newKey(),
        },
        loadPrefs,
      );
      if (done) setPrefsNotice(true);
      return done;
    },
    [write, userId, loadPrefs],
  );

  const summaryOf = (item: InboxRowItem): string =>
    KNOWN_SUMMARIES.has(item.summaryI18nKey) ? t(item.summaryI18nKey, item.summaryParams as Record<string, string | number>) : item.event;

  const errorMessage = (error: Err): string => {
    const known = ['forbidden', 'notification_not_found', 'invalid_channel', 'inbox_is_always_instant', 'unknown_event'];
    if (known.includes(error.error)) return t(`notifications.error.${error.error}`);
    return t('errors.fallback');
  };

  if (workspaceId === null) return <NoWorkspaceState />;
  if (denied) return <PermissionDenied body={t('notifications.error.permissionDenied.read')} />;

  const section = (key: (typeof SECTIONS)[number]['key'], status: string) => {
    const rows = items.filter((item) => item.status === status);
    return (
      <section key={key} className={`inbox-section inbox-section--${key}`} aria-labelledby={`inbox-h-${key}`}>
        <h2 id={`inbox-h-${key}`} className="inbox-section-title">
          {t(`notifications.section.${key}`)}
          <span className="inbox-count">{rows.length}</span>
        </h2>
        {rows.length === 0 ? (
          // K-33: each section says what is not there, never a bare "Nichts hier."
          <p className="inbox-section-empty">{t(`notifications.section.empty.${key}`)}</p>
        ) : (
          <ul className="inbox-rows">
            {rows.map((item) => (
              <li key={item.id} className={`inbox-row inbox-row--${item.status}`}>
                <div className="inbox-row-main">
                  <Status
                    kind={STATUS_KIND[item.status] ?? 'inactive'}
                    label={t(`notifications.status.${item.status}`)}
                    className="inbox-status"
                  />
                  <span className="inbox-row-summary">{summaryOf(item)}</span>
                  <span className="inbox-meta">
                    <span>{formatDate(item.day)}</span>
                    <span className="inbox-event">{item.event}</span>
                  </span>
                </div>
                {item.status !== 'archived' && (
                  <div className="inbox-row-actions">
                    {item.status === 'unread' && (
                      <button
                        type="button"
                        className="btn btn--secondary btn--sm"
                        aria-label={`${t('notifications.action.markRead')}: ${summaryOf(item)}`}
                        onClick={() => markRead(item.id)}
                      >
                        {t('notifications.action.markRead')}
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn btn--secondary btn--sm"
                      aria-label={`${t('notifications.action.archive')}: ${summaryOf(item)}`}
                      onClick={() => archive(item.id)}
                    >
                      {t('notifications.action.archive')}
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    );
  };

  const prefRow = (channel: (typeof CHANNELS)[number]) => {
    const stored = prefs.find((p) => p.event === '*' && p.channel === channel);
    const enabled = stored?.enabled ?? (channel === 'inbox');
    const digest = stored?.digest ?? 'instant';
    return (
      <div key={channel} className="inbox-pref-row">
        <label className="inbox-pref-toggle">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => void savePreference({ channel, enabled: e.target.checked, digest })}
          />
          <span>{t(`notifications.prefs.channel.${channel}`)}</span>
        </label>
        {channel === 'inbox' ? (
          <span className="inbox-pref-cadence">{t('notifications.prefs.digest.instant')}</span>
        ) : (
          <div className="inbox-pref-cadence">
            <span className="inbox-sr">{t(`notifications.prefs.channel.${channel}`)}</span>
            <Select
              value={digest}
              onChange={(value) => void savePreference({ channel, enabled, digest: value })}
              options={OUTBOUND_CADENCES.map((cadence) => ({ value: cadence, label: t(`notifications.prefs.digest.${cadence}`) }))}
              ariaLabel={t(`notifications.prefs.channel.${channel}`)}
            />
          </div>
        )}
      </div>
    );
  };

  const overrides = prefs.filter((p) => p.event !== '*');

  return (
    <section className="inbox" aria-labelledby="inbox-title">
      <header className="inbox-head">
        <h1 id="inbox-title" className="inbox-title">
          {t('notifications.route.title')}
          <SurfaceHelp surface="Inbox" />
          <span className="inbox-unread">{t('notifications.unread', { count: unreadCount })}</span>
        </h1>
        {views.length > 0 && (
          <div className="inbox-view-picker">
            <span>{t('notifications.view.label')}</span>
            <Select
              value={viewId}
              onChange={setViewId}
              options={[
                { value: '', label: t('notifications.view.all') },
                ...views.map((view) => ({ value: view.id, label: view.name })),
              ]}
              ariaLabel={t('notifications.view.label')}
            />
          </div>
        )}
        {unreadCount > 0 && (
          <button type="button" className="btn btn--secondary" onClick={markAllRead}>
            {t('notifications.action.markAllRead')}
          </button>
        )}
        <button type="button" className="btn btn--secondary" onClick={() => setPrefsOpen(!prefsOpen)}>
          {prefsOpen ? t('notifications.action.closePrefs') : t('notifications.action.openPrefs')}
        </button>
      </header>

      {writeError !== null && <ErrorBanner message={errorMessage(writeError)} />}
      {failed && <ErrorBanner context="read" message={t('notifications.error.transport')} onRetry={() => void load()} />}

      {prefsOpen && (
        <section className="inbox-prefs" aria-labelledby="inbox-prefs-title">
          <h2 id="inbox-prefs-title" className="inbox-section-title">
            {t('notifications.prefs.title')}
          </h2>
          <p className="inbox-prefs-hint">{t('notifications.prefs.hint')}</p>
          {prefsLoading ? (
            <Skeleton rows={3} height={32} labelKey="notifications.loading" />
          ) : prefsFailed ? (
            <ErrorBanner context="read" message={t('notifications.error.transport')} onRetry={() => void loadPrefs()} />
          ) : (
            <>
              {prefsNotice && (
                <p className="inbox-prefs-saved" role="status">
                  {t('notifications.prefs.saved')}
                </p>
              )}
              <h3 className="inbox-prefs-group">{t('notifications.prefs.wildcard')}</h3>
              {CHANNELS.map(prefRow)}
              <p className="inbox-prefs-cloud">{t('notifications.prefs.cloudTier')}</p>
              <h3 className="inbox-prefs-group">{t('notifications.prefs.override.title')}</h3>
              {overrides.length === 0 ? (
                <p className="inbox-section-empty">{t('notifications.prefs.override.none')}</p>
              ) : (
                <ul className="inbox-override-list">
                  {overrides.map((p) => (
                    <li key={`${p.event}:${p.channel}`} className="inbox-pref-row">
                      <span className="inbox-override-event">{p.event}</span>
                      <span>{t(`notifications.prefs.channel.${p.channel}`)}</span>
                      <label className="inbox-pref-toggle">
                        <input
                          type="checkbox"
                          checked={p.enabled}
                          onChange={(e) => void savePreference({ event: p.event, channel: p.channel, enabled: e.target.checked, digest: p.digest })}
                        />
                        <span>{t('notifications.prefs.enabled')}</span>
                      </label>
                      {p.channel !== 'inbox' && (
                        <span className="inbox-pref-cadence">{t(`notifications.prefs.digest.${p.digest}`)}</span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {adding ? (
                <form
                  className="inbox-override-form"
                  aria-label={t('notifications.prefs.override.add')}
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (draft.event === '') return;
                    void savePreference(draft).then((done) => {
                      if (done) setAdding(false);
                    });
                  }}
                >
                  <div className="inbox-pref-cadence">
                    <span>{t('notifications.prefs.override.event')}</span>
                    <Select
                      value={draft.event}
                      onChange={(value) => setDraft({ ...draft, event: value })}
                      options={[
                        { value: '', label: t('notifications.prefs.override.pick') },
                        ...knownEvents.map((event) => ({ value: event, label: event })),
                      ]}
                      ariaLabel={t('notifications.prefs.override.event')}
                    />
                  </div>
                  <div className="inbox-pref-cadence">
                    <span>{t('notifications.prefs.channel.inbox')}</span>
                    <Select
                      value={draft.channel}
                      onChange={(value) => setDraft({ ...draft, channel: value, ...(value === 'inbox' ? { digest: 'instant' } : {}) })}
                      options={CHANNELS.map((channel) => ({ value: channel, label: t(`notifications.prefs.channel.${channel}`) }))}
                      ariaLabel={t('notifications.prefs.channel.inbox')}
                    />
                  </div>
                  <label className="inbox-pref-toggle">
                    <input type="checkbox" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} />
                    <span>{t('notifications.prefs.enabled')}</span>
                  </label>
                  {draft.channel !== 'inbox' && (
                    <div className="inbox-pref-cadence">
                      <span className="inbox-sr">{t('notifications.prefs.override.title')}</span>
                      <Select
                        value={draft.digest}
                        onChange={(value) => setDraft({ ...draft, digest: value })}
                        options={OUTBOUND_CADENCES.map((cadence) => ({ value: cadence, label: t(`notifications.prefs.digest.${cadence}`) }))}
                        ariaLabel={t('notifications.prefs.override.title')}
                      />
                    </div>
                  )}
                  <button type="submit" className="btn btn--primary btn--sm">
                    {t('notifications.prefs.override.save')}
                  </button>
                </form>
              ) : (
                <button type="button" className="btn btn--secondary btn--sm" onClick={() => setAdding(true)}>
                  {t('notifications.prefs.override.add')}
                </button>
              )}
            </>
          )}
        </section>
      )}

      {loading ? (
        <Skeleton rows={4} height={44} labelKey="notifications.loading" />
      ) : failed ? null : items.length === 0 ? (
        // K-33: the title says what is missing, the hint where it comes from. No action: nothing here
        // is created by hand, and the settings sit in the header.
        <EmptyState title={t('notifications.empty')} hint={t('notifications.emptyHint')} />
      ) : (
        SECTIONS.map(({ key, status }) => section(key, status))
      )}
    </section>
  );
}
export default Inbox;
