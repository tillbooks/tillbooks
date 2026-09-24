/**
 * G15, Pendenzen (`/attention`): the one screen that answers "what is waiting for a decision from me".
 *
 * It leads with the WORK (the urgency list, at most five rows, the top row selected on arrival and
 * opened by Enter or a click), then a per-area index for navigating, then the events zone. There is
 * no hide, no mute, no snooze anywhere on it.
 *
 * THE ROW CARRIES ITS DECISION (F-01, 2026-09-05; measured J2.1 at S 16 / C 33 / W 14 against an
 * ideal of S 2 / W 1 while every row deep-linked away). Each item arrives from the engine with the
 * exits its owning surface offers (`decisionOptions`: existing write verbs, their fixed input and a
 * per-item idempotency key), the reason it waits and the D118 C4 consequence sentence. The hub makes
 * ONE call per act, exactly as the item declares it, under that verb's own gate, and the row updates
 * in place (`ActionFeedback`, then a re-read); only the hard case deep-links. The hub still mints no
 * verb of its own.
 *
 * The whole first screen comes from ONE `attention_summary` call, whose payload carries both the
 * per-queue counts and the `top[]` rows the list shows (design §6a). `attention_list` is called only
 * when the user drills into a single area. A denied queue is absent, a failed queue is named once with
 * its own retry and no count, `visibleQueues == 0` is the padlock (never "Alles erledigt"), and the
 * celebratory empty state renders only when nothing failed AND at least one queue is readable.
 */
import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';

import { useClient } from '../../lib/client-context';
import { isErr } from '../../lib/client';
import { useWorkspaceId } from '../../app/workspace';
import { useCan } from '../../lib/capabilities';
import { useFeedback } from '../../components/FeedbackProvider';
import { useT, formatMoney } from '../../i18n';
import { SurfaceHelp } from '../../components/SurfaceHelp';
import { SurfaceHeader } from '../../components/SurfaceHeader';
import { EmptyState, ErrorBanner, NoWorkspaceState, Padlock, Skeleton } from '../../components/states';
import { OverflowMenu } from '../../components/OverflowMenu';
import { ActionFeedback, type FeedbackTone } from '../../components/ActionFeedback';
import { Status, type StatusKind } from '../../components/Status';
import { ChevronRightGlyph, StatusNeutralGlyph, StatusPendingGlyph, StatusWarnGlyph } from '../../components/icons';
import { EventsZone } from './EventsZone';
import { RowDecision, parseDecisionOptions, verbLabel, parseActorKind, type ActorKind, type DecisionOption } from './RowDecision';
import { readLastSeen, writeLastSeen, isNew } from './marker';
import './Attention.css';

const newKey = () => crypto.randomUUID();

type Urgency = 'overdue' | 'due' | 'open';

interface Item {
  queueId: string;
  entityKind: string;
  entityId: string;
  titleKey: string;
  titleParams: Record<string, string | number>;
  subtitleKey?: string;
  subtitleParams?: Record<string, string | number>;
  amountMinor?: number;
  currency?: string;
  since: string;
  dueAt?: string;
  urgency: Urgency;
  deepLink: { route: string; params: Record<string, string> };
  collapsedWithQueueId?: string;
  decisionOptions?: DecisionOption[];
  suggestedInvoiceId?: string | null;
  suggestedInvoiceNumber?: string | null;
  reasonCode?: string | null;
  reasonKey?: string | null;
  consequenceKey?: string | null;
  proposedBy?: string;
  proposedByKind?: ActorKind;
}

/** The refusal codes the hub carries its own sentence for; anything else renders the generic one. */
const KNOWN_ACT_ERRORS: ReadonlySet<string> = new Set([
  'period_locked',
  'permission_denied',
  'cannot_self_approve',
  'already_applied',
  'already_paid',
  'currency_mismatch',
  'already_executed',
  'not_found',
]);

interface QueueSummary {
  queueId: string;
  area: string;
  count: number;
  topUrgency: Urgency;
}

interface Summary {
  computedAt: string;
  visibleQueues: number;
  total: number | null;
  incomplete: boolean;
  queues: QueueSummary[];
  top: Item[];
  failed: string[];
}

/** ! überfällig · ◔ fällig · ○ offen: glyph AND text, so a grayscale printout reads the same. */
/**
 * Urgency as the shared Status vocabulary (K-22, D137): the glyph's SHAPE carries it (an exclamation,
 * a clock, an empty circle), never a text dingbat and never colour alone. Only `überfällig` takes the
 * warn tint, as before.
 */
const URGENCY_KIND: Record<Urgency, StatusKind> = { overdue: 'warn', due: 'pending', open: 'neutral' };
const URGENCY_GLYPH = { overdue: StatusWarnGlyph, due: StatusPendingGlyph, open: StatusNeutralGlyph } as const;

/** The refresh control's glyph: a circular arrow, 16px on the one stroke width (K-37). */
function RefreshGlyph() {
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M20 11a8 8 0 1 0-2.3 5.7" />
      <path d="M20 4v7h-7" />
    </svg>
  );
}

function parseItem(raw: unknown): Item | null {
  if (raw === null || typeof raw !== 'object') return null;
  const n = raw as Record<string, unknown>;
  const link = n.deepLink as { route?: unknown; params?: unknown } | undefined;
  if (typeof n.queueId !== 'string' || typeof n.entityId !== 'string' || typeof n.titleKey !== 'string') return null;
  if (link === undefined || typeof link.route !== 'string') return null;
  const urgency = n.urgency === 'overdue' || n.urgency === 'due' ? n.urgency : 'open';
  return {
    queueId: n.queueId,
    entityKind: typeof n.entityKind === 'string' ? n.entityKind : '',
    entityId: n.entityId,
    titleKey: n.titleKey,
    titleParams: (n.titleParams ?? {}) as Record<string, string | number>,
    subtitleKey: typeof n.subtitleKey === 'string' ? n.subtitleKey : undefined,
    subtitleParams: (n.subtitleParams ?? {}) as Record<string, string | number>,
    amountMinor: typeof n.amountMinor === 'number' ? n.amountMinor : undefined,
    currency: typeof n.currency === 'string' ? n.currency : undefined,
    since: typeof n.since === 'string' ? n.since : '',
    dueAt: typeof n.dueAt === 'string' ? n.dueAt : undefined,
    urgency,
    deepLink: {
      route: link.route,
      params:
        link.params !== null && typeof link.params === 'object'
          ? (link.params as Record<string, string>)
          : {},
    },
    collapsedWithQueueId: typeof n.collapsedWithQueueId === 'string' ? n.collapsedWithQueueId : undefined,
    decisionOptions: parseDecisionOptions(n.decisionOptions),
    suggestedInvoiceId: typeof n.suggestedInvoiceId === 'string' ? n.suggestedInvoiceId : null,
    suggestedInvoiceNumber: typeof n.suggestedInvoiceNumber === 'string' ? n.suggestedInvoiceNumber : null,
    reasonCode: typeof n.reasonCode === 'string' ? n.reasonCode : null,
    reasonKey: typeof n.reasonKey === 'string' ? n.reasonKey : null,
    consequenceKey: typeof n.consequenceKey === 'string' ? n.consequenceKey : null,
    proposedBy: typeof n.proposedBy === 'string' ? n.proposedBy : undefined,
    proposedByKind: parseActorKind(n.proposedByKind),
  };
}

function parseSummary(body: unknown): Summary | null {
  if (body === null || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  if (typeof b.visibleQueues !== 'number') return null;
  const queues = Array.isArray(b.queues)
    ? (b.queues as Record<string, unknown>[])
        .filter((q) => typeof q.queueId === 'string' && typeof q.count === 'number')
        .map((q) => ({
          queueId: q.queueId as string,
          area: typeof q.area === 'string' ? q.area : '',
          count: q.count as number,
          topUrgency: (q.topUrgency === 'overdue' || q.topUrgency === 'due' ? q.topUrgency : 'open') as Urgency,
        }))
    : [];
  const top = Array.isArray(b.top) ? (b.top.map(parseItem).filter((i): i is Item => i !== null)) : [];
  return {
    computedAt: typeof b.computedAt === 'string' ? b.computedAt : '',
    visibleQueues: b.visibleQueues,
    total: typeof b.total === 'number' ? b.total : null,
    incomplete: b.incomplete === true,
    queues,
    top,
    failed: Array.isArray(b.failed) ? (b.failed.filter((f): f is string => typeof f === 'string')) : [],
  };
}

/** "Stand" line: the date and the HH:MM the answer was computed, so a stale glance is visibly stale. */
function standTime(iso: string): string {
  if (iso.length < 16) return iso;
  return iso.slice(11, 16);
}

export function Attention() {
  const t = useT();
  const client = useClient();
  const navigate = useNavigate();
  const workspaceId = useWorkspaceId();
  const canCreateTask = useCan('tasks.write');
  const feedback = useFeedback();

  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [selected, setSelected] = useState(0);
  const [openArea, setOpenArea] = useState<string | null>(null);
  const [areaItems, setAreaItems] = useState<Item[] | null>(null);
  const [lastSeen, setLastSeen] = useState<string | null>(null);
  // The act in flight (one at a time: a double press on any row cannot fire twice) and its outcome.
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [actFeedback, setActFeedback] = useState<{ tone: FeedbackTone; message: string } | null>(null);

  // Discards an in-flight answer whose workspace is no longer active (design story 6.2).
  const activeWs = useRef<string | null>(workspaceId);
  const rowRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const load = useCallback(async () => {
    if (workspaceId === null) {
      setLoading(false);
      return;
    }
    const ws = workspaceId;
    setLoading(true);
    setFailed(false);
    // The "neu" tag compares an item's `since` to the marker from the PREVIOUS visit, so read it
    // before this visit overwrites it.
    setLastSeen(readLastSeen(ws));
    const res = await client.call('attention_summary', { workspaceId: ws, topLimit: 5 });
    if (activeWs.current !== ws) return; // a switch overtook this answer: discard it.
    if (isErr(res.body)) {
      setFailed(true);
      setLoading(false);
      return;
    }
    const parsed = parseSummary(res.body);
    if (parsed === null) {
      setFailed(true);
      setLoading(false);
      return;
    }
    setSummary(parsed);
    setSelected(0);
    setLoading(false);
    if (parsed.computedAt !== '') writeLastSeen(ws, parsed.computedAt);
  }, [client, workspaceId]);

  // A workspace switch clears the previous client's data BEFORE the new arrives (design story 6.1).
  useEffect(() => {
    activeWs.current = workspaceId;
    setSummary(null);
    setAreaItems(null);
    setOpenArea(null);
    setSelected(0);
    void load();
  }, [workspaceId, load]);

  const openArea_ = useCallback(
    async (area: string) => {
      if (workspaceId === null) return;
      setOpenArea(area);
      setSelected(0);
      setAreaItems(null);
      const res = await client.call('attention_list', { workspaceId, area, limit: 5 });
      if (activeWs.current !== workspaceId) return;
      if (isErr(res.body)) {
        setAreaItems([]);
        return;
      }
      const b = res.body as unknown as { items?: unknown };
      const items = Array.isArray(b.items) ? b.items.map(parseItem).filter((i): i is Item => i !== null) : [];
      setAreaItems(items);
    },
    [client, workspaceId],
  );

  const backToAllAreas = () => {
    setOpenArea(null);
    setAreaItems(null);
    setSelected(0);
  };

  const openItem = useCallback(
    (item: Item) => {
      const qs = new URLSearchParams(item.deepLink.params).toString();
      navigate(qs === '' ? item.deepLink.route : `${item.deepLink.route}?${qs}`);
    },
    [navigate],
  );

  /**
   * One act on one row: the option's verb with exactly the input the engine declared, the human
   * confirmation where the verb takes one, and the reason where the person typed one. The row
   * re-reads afterwards (the list shrinks by the act, never by hiding); a refusal keeps the row and
   * says why in the person's words.
   */
  const act = useCallback(
    async (item: Item, option: DecisionOption, reason?: string) => {
      if (workspaceId === null || option.verb === null || busyKey !== null) return;
      const ws = workspaceId;
      const rowKey = `${item.queueId}:${item.entityId}`;
      setBusyKey(rowKey);
      setActFeedback(null);
      const res = await client.call(option.verb, {
        workspaceId: ws,
        ...option.input,
        ...(option.humanConfirm ? { confirmed: true } : {}),
        ...(reason !== undefined && reason !== '' ? { reason } : {}),
      });
      if (activeWs.current !== ws) return;
      setBusyKey(null);
      if (isErr(res.body)) {
        const code = res.body.error;
        setActFeedback({
          tone: 'error',
          message: KNOWN_ACT_ERRORS.has(code) ? t(`attention.act.error.${code}`) : t('attention.act.error.generic'),
        });
        if (code === 'not_found' || code === 'already_applied' || code === 'already_executed') void load();
        return;
      }
      setActFeedback({ tone: 'success', message: t(`attention.act.done.${option.id}`) });
      await load();
      if (openArea !== null) await openArea_(openArea);
    },
    [busyKey, client, load, openArea, openArea_, t, workspaceId],
  );

  const createTask = useCallback(
    async (item: Item) => {
      if (workspaceId === null) return;
      const ws = workspaceId;
      // The defer (design story 3.1): mint an E03 task OP3-linked to the item. The hub row does NOT
      // disappear and no hub count changes; the task carries the intention. Because nothing visible
      // moves, the OUTCOME is the only signal there is: a success is confirmed on the banner and a
      // refusal (e.g. permission_denied) is surfaced there, never swallowed. Mirrors `act`.
      setActFeedback(null);
      const res = await client.call('tasks_create', {
        workspaceId: ws,
        title: t(item.titleKey, item.titleParams),
        ...(item.entityKind !== '' ? { entityKind: item.entityKind, entityId: item.entityId } : {}),
        idempotencyKey: newKey(),
      });
      if (activeWs.current !== ws) return;
      if (isErr(res.body)) {
        const code = res.body.error;
        setActFeedback({
          tone: 'error',
          message: KNOWN_ACT_ERRORS.has(code) ? t(`attention.act.error.${code}`) : t('attention.act.error.generic'),
        });
        return;
      }
      setActFeedback({ tone: 'success', message: t('attention.act.taskCreated') });
    },
    [client, workspaceId, t],
  );

  const copyRef = (item: Item) => {
    const ref = `${item.entityKind}:${item.entityId}`;
    try {
      void navigator.clipboard?.writeText(ref);
    } catch {
      // A clipboard the browser refuses is not an error worth a banner; the reference is on screen.
    }
  };

  const shownItems = openArea === null ? (summary?.top ?? []) : (areaItems ?? []);

  /** Roving selection over the item list: arrows move, Enter opens, Home/End jump (design story 8.1). */
  const onListKeyDown = (event: ReactKeyboardEvent) => {
    if (shownItems.length === 0) return;
    // The reason field under a row owns its own Home/End/arrows.
    const target = event.target as HTMLElement | null;
    if (target !== null && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
    let next = selected;
    if (event.key === 'ArrowDown') next = Math.min(selected + 1, shownItems.length - 1);
    else if (event.key === 'ArrowUp') next = Math.max(selected - 1, 0);
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = shownItems.length - 1;
    else return;
    event.preventDefault();
    setSelected(next);
    rowRefs.current[next]?.focus();
  };

  // The page header is the shared SurfaceHeader (D118 B2): the title, the inline help, and an actions
  // slot pinned right. It is rendered once here and reused by every early return below rather than
  // copy-pasted into each of them, so the title stops being repeated across the states.
  const header = (actions?: ReactNode) => (
    <SurfaceHeader title={t('attention.title')} titleId="att-title" help={<SurfaceHelp surface="Attention" />} actions={actions} />
  );

  if (workspaceId === null) return <NoWorkspaceState />;
  if (loading && summary === null) {
    return (
      <section className="att" aria-labelledby="att-title">
        {header()}
        <div role="status" aria-busy="true" aria-live="polite">
          <span className="att-sr">{t('attention.loading')}</span>
          <Skeleton rows={5} />
        </div>
      </section>
    );
  }
  if (failed || summary === null) {
    return (
      <section className="att" aria-labelledby="att-title">
        {header()}
        <ErrorBanner message={t('attention.error.total')} onRetry={() => void load()} />
      </section>
    );
  }

  // The padlock and the empty state are DIFFERENT facts and never render together (design story 1.5):
  // no read capability at all is the padlock; everything readable and nothing pending is the empty state.
  if (summary.visibleQueues === 0) {
    return (
      <section className="att" aria-labelledby="att-title">
        {header()}
        <Padlock
          title={t('attention.padlock.title')}
          body={t('attention.padlock.body')}
          {...(feedback !== null
            ? { action: { label: t('attention.padlock.ask'), onClick: () => feedback.open({ kind: 'idea', subject: 'attention' }) } }
            : {})}
        />
      </section>
    );
  }

  const singleQueue = summary.queues.length === 1;
  const listHeading =
    openArea !== null
      ? t(`attention.area.${openArea}`)
      : singleQueue
        ? t(`attention.queueLabel.${summary.queues[0].queueId}`)
        : t('attention.subtitle.work');
  const celebratory = summary.failed.length === 0 && (summary.total ?? 0) === 0;

  return (
    <section className="att" aria-labelledby="att-title">
      {header(
        <>
          {summary.computedAt !== '' && (
            <span className="att-stand">
              {t('attention.stand', { time: standTime(summary.computedAt) })}
              {summary.incomplete && <span className="att-incomplete"> · {t('attention.incomplete')}</span>}
            </span>
          )}
          {/* K-40: a 32px icon button with the SVG arrow and its name, never a text glyph. */}
          <button
            type="button"
            className="btn btn--ghost btn--icon btn--sm att-refresh"
            aria-label={t('attention.refresh')}
            onClick={() => void load()}
          >
            <RefreshGlyph />
          </button>
        </>,
      )}

      {/* A failed provider is named exactly once, with its own retry, and carries no count (story 1.3). */}
      {summary.failed.map((queueId) => (
        <div key={queueId} className="att-provider-error" role="status">
          <span>{t('attention.providerFailed', { queue: t(`attention.queueLabel.${queueId}`) })}</span>
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => void load()}>
            {t('attention.retry')}
          </button>
        </div>
      ))}

      <section className="att-work" aria-labelledby="att-work-title">
        <div className="att-work-head">
          <h2 id="att-work-title" className="att-section-title">
            {listHeading}
          </h2>
          {openArea !== null && (
            <button type="button" className="btn btn--secondary btn--sm" onClick={backToAllAreas}>
              {t('attention.allAreas')}
            </button>
          )}
          {openArea === null && summary.total !== null && summary.total > 0 && (
            <span className="att-total" aria-hidden="true">
              {summary.total > 99 ? '99+' : summary.total}
            </span>
          )}
        </div>

        {actFeedback !== null && (
          <ActionFeedback
            tone={actFeedback.tone}
            message={actFeedback.message}
            onDismiss={() => setActFeedback(null)}
            dismissLabel={t('attention.act.dismissFeedback')}
          />
        )}

        {shownItems.length === 0 ? (
          openArea !== null ? (
            <div className="att-area-empty">
              <p>{t('attention.singleAreaEmpty', { area: t(`attention.area.${openArea}`) })}</p>
              <button type="button" className="btn btn--secondary btn--sm" onClick={backToAllAreas}>
                {t('attention.allAreas')}
              </button>
            </div>
          ) : celebratory ? (
            <EmptyState
              title={t('attention.empty.title')}
              hint={t('attention.empty.hint')}
              action={{ label: t('attention.empty.action'), to: '/overview' }}
            />
          ) : (
            <p className="att-area-empty">{t('attention.empty.hint')}</p>
          )
        ) : (
          // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
          <ul className="att-list" onKeyDown={onListKeyDown}>
            {shownItems.map((item, index) => {
              const tagged = isNew(item.since, lastSeen);
              const overflowItems = [
                ...(canCreateTask
                  ? [{ key: 'task', label: t('attention.overflow.createTask'), onSelect: () => void createTask(item) }]
                  : []),
                { key: 'copy', label: t('attention.overflow.copyRef'), onSelect: () => copyRef(item) },
              ];
              const rowKey = `${item.queueId}:${item.entityId}`;
              const subtitle =
                item.queueId === 'agent_action'
                  ? verbLabel(t, String(item.subtitleParams?.tool ?? ''))
                  : item.subtitleKey !== undefined
                    ? t(item.subtitleKey, item.subtitleParams ?? {})
                    : null;
              return (
                <li key={rowKey} className="att-row" aria-busy={busyKey === rowKey ? 'true' : undefined}>
                  <div className="att-row-line">
                  <button
                    type="button"
                    ref={(el) => {
                      rowRefs.current[index] = el;
                    }}
                    className={`att-row-open att-row-open--${item.urgency}`}
                    tabIndex={index === selected ? 0 : -1}
                    aria-current={index === selected ? 'true' : undefined}
                    onFocus={() => setSelected(index)}
                    onClick={() => openItem(item)}
                  >
                    <Status
                      kind={URGENCY_KIND[item.urgency]}
                      label={t(`attention.urgency.${item.urgency}`)}
                      className={`att-urgency att-urgency--${item.urgency}`}
                    />
                    <span className="att-row-main">
                      <span className="att-row-title">
                        {t(item.titleKey, item.titleParams)}
                        {tagged && <span className="att-new">{t('attention.new')}</span>}
                      </span>
                      {subtitle !== null && (
                        <span className="att-row-subtitle">
                          {subtitle}
                          {item.collapsedWithQueueId !== undefined && (
                            <span className="att-collapsed">
                              {' · '}
                              {t('attention.collapsedWith', { queue: t(`attention.queueLabel.${item.collapsedWithQueueId}`) })}
                            </span>
                          )}
                        </span>
                      )}
                    </span>
                    {item.amountMinor !== undefined && item.currency !== undefined && (
                      // K-40: the figure in Inter with tabular figures (`.t-money`), the one face the
                      // Studio sets money in, never monospace. Display only: the string is unchanged.
                      <span className="att-amount t-money">{formatMoney(item.amountMinor, item.currency)}</span>
                    )}
                  </button>
                  <div className="att-row-overflow">
                    <OverflowMenu label={t('attention.overflow.label', { title: t(item.titleKey, item.titleParams) })} items={overflowItems} />
                  </div>
                  </div>
                  {(item.decisionOptions?.length ?? 0) > 0 && (
                    <RowDecision
                      item={item}
                      selected={index === selected}
                      busy={busyKey === rowKey}
                      onAct={(option, reason) => void act(item, option, reason)}
                      onOpen={(link) => {
                        const qs = new URLSearchParams(link.params).toString();
                        navigate(qs === '' ? link.route : `${link.route}?${qs}`);
                      }}
                    />
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* The area index NAVIGATES; it renders only at two or more visible areas (design story 1.6). */}
      {summary.queues.length >= 2 && (
        <section className="att-index" aria-labelledby="att-index-title">
          <h2 id="att-index-title" className="att-section-title">
            {t('attention.areaIndex.title')}
          </h2>
          <ul className="att-index-list">
            {summary.queues.map((q) => {
              const Glyph = URGENCY_GLYPH[q.topUrgency];
              return (
                <li key={q.queueId}>
                  <button
                    type="button"
                    className="att-index-row"
                    aria-current={openArea === q.area ? 'true' : undefined}
                    onClick={() => void openArea_(q.area)}
                  >
                    <span className="att-index-label">{t(`attention.area.${q.area}`)}</span>
                    <span className={`att-index-urgency att-index-urgency--${q.topUrgency}`} aria-hidden="true">
                      <Glyph size={14} />
                    </span>
                    <span className="att-index-count t-num">{q.count}</span>
                    <ChevronRightGlyph className="att-index-chevron" size={16} aria-hidden="true" />
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <EventsZone />
    </section>
  );
}

export default Attention;
