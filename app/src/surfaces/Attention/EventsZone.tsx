/**
 * The events zone (design §3e, D-1 option A): G06's newest events, kept visibly SEPARATE from work.
 *
 * An event and an open item are different species (design §4): an event LEAVES when you have seen it
 * (G06's `unread -> read -> archived`), an open item leaves only when the decision is made in the
 * module that owns it. So the zone has its own controls (mark read, archive), its own empty state
 * evaluated against its OWN predicate, and its own tab stop. It never borrows the work list's empty
 * state and the work list never borrows its archive control.
 *
 * "Alle anzeigen" swaps the compact zone for G06's full `Inbox` view INSIDE the hub, which is D-1's
 * "a zone plus a full view inside /attention": G06 keeps its model, verbs and sections; it lost only
 * its own `/inbox` route.
 */
import { useCallback, useEffect, useState } from 'react';

import { useClient } from '../../lib/client-context';
import { isErr } from '../../lib/client';
import { useWorkspaceId } from '../../app/workspace';
import { useCapabilities } from '../../lib/capabilities';
import { useT, formatDate } from '../../i18n';
import { Inbox } from '../Inbox';

const newKey = () => crypto.randomUUID();

/** The events the compact zone shows before "Alle anzeigen": the newest five, any status. */
const EVENTS_ZONE_CAP = 5;

interface EventRow {
  id: string;
  event: string;
  summaryI18nKey: string;
  summaryParams: Record<string, string | number>;
  status: string;
  day: string;
}

/** ● Ungelesen · ○ Gelesen · ▤ Archiviert: glyph AND label, never colour alone (the Inbox convention). */
const STATUS_GLYPH: Record<string, string> = { unread: '●', read: '○', archived: '▤' };

const KNOWN_SUMMARIES = new Set([
  'notifications.summary.task_due',
  'notifications.summary.invoice_issued',
  'notifications.summary.invoice_sent',
  'notifications.summary.deal_stage_changed',
  'notifications.summary.payment_recorded',
]);

function parseEvents(body: unknown): EventRow[] | null {
  if (body === null || typeof body !== 'object') return null;
  const items = (body as { items?: unknown }).items;
  if (!Array.isArray(items)) return null;
  const rows: EventRow[] = [];
  for (const raw of items) {
    if (raw === null || typeof raw !== 'object') continue;
    const n = raw as Record<string, unknown>;
    if (typeof n.id !== 'string' || typeof n.event !== 'string' || typeof n.status !== 'string') continue;
    rows.push({
      id: n.id,
      event: n.event,
      summaryI18nKey: typeof n.summaryI18nKey === 'string' ? n.summaryI18nKey : '',
      summaryParams:
        n.summaryParams !== null && typeof n.summaryParams === 'object' && !Array.isArray(n.summaryParams)
          ? (n.summaryParams as Record<string, string | number>)
          : {},
      status: n.status,
      day: typeof n.day === 'string' ? n.day : '',
    });
  }
  return rows;
}

export function EventsZone() {
  const t = useT();
  const client = useClient();
  const workspaceId = useWorkspaceId();
  const { whoami } = useCapabilities();
  const userId = whoami?.actor ?? 'studio';

  const [rows, setRows] = useState<EventRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const load = useCallback(async () => {
    if (workspaceId === null) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setFailed(false);
    const res = await client.call('notifications_list', { workspaceId, userId });
    if (isErr(res.body)) {
      setFailed(true);
      setLoading(false);
      return;
    }
    const parsed = parseEvents(res.body);
    if (parsed === null) {
      setFailed(true);
      setLoading(false);
      return;
    }
    setRows(parsed.slice(0, EVENTS_ZONE_CAP));
    setLoading(false);
  }, [client, workspaceId, userId]);

  useEffect(() => {
    // Clear on a workspace switch before the new answer arrives (design §6a, no stale rows).
    setRows([]);
    void load();
  }, [load]);

  const archive = async (id: string) => {
    if (workspaceId === null) return;
    await client.call('notifications_archive', { workspaceId, notificationId: id, idempotencyKey: newKey() });
    await load();
  };

  const summaryOf = (row: EventRow): string =>
    KNOWN_SUMMARIES.has(row.summaryI18nKey) ? t(row.summaryI18nKey, row.summaryParams) : row.event;

  if (expanded) {
    return (
      <section className="att-events" aria-labelledby="att-events-title">
        <div className="att-events-head">
          <h2 id="att-events-title" className="att-section-title">
            {t('attention.events.title')}
          </h2>
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => setExpanded(false)}>
            {t('attention.events.collapse')}
          </button>
        </div>
        {/* The full G06 view, unchanged, mounted inside the hub (D-1 A). */}
        <Inbox />
      </section>
    );
  }

  return (
    <section className="att-events" aria-labelledby="att-events-title">
      <div className="att-events-head">
        <h2 id="att-events-title" className="att-section-title">
          {t('attention.events.title')}
        </h2>
        {rows.length > 0 && (
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => setExpanded(true)}>
            {t('attention.events.showAll')}
          </button>
        )}
      </div>
      {loading ? (
        <p className="att-events-empty" role="status">
          {t('attention.events.loading')}
        </p>
      ) : failed ? (
        <p className="att-events-error" role="status">
          {t('attention.events.error')}{' '}
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => void load()}>
            {t('attention.retry')}
          </button>
        </p>
      ) : rows.length === 0 ? (
        <p className="att-events-empty">{t('attention.events.empty')}</p>
      ) : (
        <ul className="att-events-list">
          {rows.map((row) => (
            <li key={row.id} className="att-events-row">
              <span className={`att-events-status att-events-status--${row.status}`}>
                <span aria-hidden="true">{STATUS_GLYPH[row.status] ?? '○'}</span>{' '}
                {t(`notifications.status.${row.status}`)}
              </span>
              <span className="att-events-summary">{summaryOf(row)}</span>
              <span className="att-events-meta">{formatDate(row.day)}</span>
              {row.status !== 'archived' && (
                <button
                  type="button"
                  className="btn btn--secondary btn--sm"
                  aria-label={`${t('notifications.action.archive')}: ${summaryOf(row)}`}
                  onClick={() => void archive(row.id)}
                >
                  {t('notifications.action.archive')}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
