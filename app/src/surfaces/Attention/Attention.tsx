/**
 * G15, Pendenzen (`/attention`): the one screen that answers "what is waiting for a decision from me".
 *
 * D178 (21.10.2026), the owner's review: "way too much text and different fonts and layers ... There is
 * no difference between bank account transactions, where it can be approved, and other open points. Bank
 * transactions must be all the way on top ... I have 12 open points but when I click on it, I don't find
 * the 12 points." So the page is now:
 *
 *  - THE WHOLE LIST, IN SECTIONS. One `attention_list { grouping }` read returns every item cut into
 *    sections by area (Bank, Buchhaltung, Verkauf, System; the default) or by kind (Genehmigen, Erledigen,
 *    Hinweise), the person's choice (`usePref('attention.grouping')`, the inline control in the header).
 *    Each section names its count; each row its own; the engine makes them add up to the rail badge. A
 *    section larger than a page ends in "Weitere n anzeigen", read from the cursor.
 *  - ONE ROW PATTERN. Every item is lead, title over one meta line, (i), one button, ⋯ (`AttentionRow`), and
 *    a Vorschlag is the same five slots on the same grid (`VorschlagLine`, compact), its meta in the same
 *    order (amount, booking account, date). The lead holds ONLY a batchable Vorschlag's box, empty on every
 *    other row; the kind is said once, by the section head's glyph (the fresh-eyes judge, N4 H1). No title
 *    is a button: the row's one text button is the way in (N4 M4). Explanations live behind the (i).
 *  - THE BANK VORSCHLÄGE LEAD, WITH THE BATCH (D178 point 5). The batch reaches ONLY the rows the engine
 *    marks `batchable` (a decision on a bank line, critic N4 M1); every other Vorschlag keeps its own
 *    Genehmigen. Per the workspace setting `attention.approval_batch_mode`: `tick` (the box takes the
 *    glyph slot, never pre-ticked), `single`, or `all_with_confirm` (a confirm naming the count and the
 *    money in and out per currency). A batch calls the existing `approve_drafted_action` once per row,
 *    strictly one after the other; the result names what was approved (with its entry) and what was not
 *    and why; the page re-reads once.
 *  - ISSUING A MAHNLAUF IS CONFIRMED FIRST (DESIGN.md D118 C4, the orchestrator's N4 ruling): its row
 *    button opens the governed confirm (the engine's sentence, the run's letters, invoices and fees) and
 *    sends nothing; only the confirm's commit sends `issue_dunning_run`. While a confirm is open the batch
 *    commit goes quiet, so the page never shows two accents.
 *  - A VORSCHLAG THAT CAN NO LONGER BE APPROVED STAYS (the design judge). The engine keeps a stale one on
 *    an open line listed; the row says so in one wording and offers one way on, the line in the bank. The
 *    badge falls only by what was approved.
 *
 * Unchanged from G15: no row is current on arrival (D152 rule 5; the roving tab stop sits on the first
 * row); the act is the item's declared `decisionOptions`, sent exactly as declared, one at a time; a
 * denied queue is absent, a failed queue is named once with its own retry, `visibleQueues == 0` is the
 * padlock; a workspace switch clears everything before the new answer arrives and discards a late one.
 */
import { Fragment, useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { useClient } from '../../lib/client-context';
import { isErr, type RestResponse } from '../../lib/client';
import { useWorkspaceId } from '../../app/workspace';
import { useCan, useCapabilities } from '../../lib/capabilities';
import { usePref } from '../../lib/prefs';
import { useFeedback } from '../../components/FeedbackProvider';
import { useI18n, formatDate, formatMoney } from '../../i18n';
import { consequenceSentence } from '../../lib/approval-tiers';
import { IconButton } from '../../components/IconButton';
import { SurfaceHelp } from '../../components/SurfaceHelp';
import { SurfaceHeader } from '../../components/SurfaceHeader';
import { Segmented } from '../../components/Segmented';
import { Tooltip, TooltipPortalContext } from '../../components/Tooltip';
import { EmptyState, ErrorBanner, NoWorkspaceState, Padlock, Skeleton, refusalText } from '../../components/states';
import { ActionFeedback, type FeedbackTone } from '../../components/ActionFeedback';
import { OverflowMenu, type OverflowMenuItem } from '../../components/OverflowMenu';
import { EventsZone } from './EventsZone';
import { parseDrafted, type DraftedAction } from '../Agent/model';
import { VorschlagLine, type VorschlagStatus } from '../Agent/VorschlagLine';
import { useAccountNames } from '../Agent/useAccountNames';
import { useDialLevels } from '../Agent/useDialLevels';
import { AttentionRow } from './AttentionRow';
import { BatchBar, BatchConfirm, batchTotalsOf } from './Batch';
import { IssueDunningConfirm } from './IssueDunningConfirm';
import { Amount } from './Amount';
import { Mark, sectionMarkOf } from './kindGlyph';
import { verbLabel, type DecisionOption } from './RowDecision';
import { itemTitle, queueName } from './itemText';
import { announceAttentionChanged } from './attentionSummary';
import { readLastSeen, writeLastSeen, isNew } from './marker';
import { appendPage, isVorschlag, parseGrouped, standTime, vorschlagOf, type Grouped, type Grouping, type Item, type Section } from './model';
import './Attention.css';

const newKey = () => crypto.randomUUID();

/** The meta line's separator (the hub's one), non-breaking. */
const SEP = ' · ';

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
  // D150: the statement-gap confirmation's refusals.
  'gap_not_chained',
  'gap_has_waiting_statement',
  'gap_not_found',
  'human_only',
]);

/**
 * How Pendenzen words a refusal. A stale Vorschlag has ONE wording everywhere on this page (the design
 * judge): the row, the batch result and a single approval all say the same few words.
 */
const ACT_WORDING = {
  own: 'attention.act.error',
  known: KNOWN_ACT_ERRORS,
  fallback: 'attention.act.error.generic',
  keys: { vorschlag_stale: 'attention.vorschlag.stale' },
} as const;

/** What a line decision books onto, in words, when the engine names no account or rule. */
const TARGET_KIND_KEY: Readonly<Record<string, string>> = {
  ignore: 'attention.vorschlag.target.ignore',
  open_item: 'attention.vorschlag.target.openItem',
  existing_entry: 'attention.vorschlag.target.existingEntry',
  payment_batch: 'attention.vorschlag.target.paymentBatch',
  rule: 'attention.vorschlag.target.rule',
};

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

interface BatchOutcome {
  approved: { title: string; entryId: string | null }[];
  refused: { title: string; message: string }[];
  id: number;
}

export function Attention() {
  const { t, locale } = useI18n();
  const client = useClient();
  const navigate = useNavigate();
  const workspaceId = useWorkspaceId();
  const canCreateTask = useCan('tasks.write');
  const canDecide = useCan('manage_agent_dial');
  const { whoami } = useCapabilities();
  const feedback = useFeedback();
  const [groupingPref, setGrouping] = usePref<string>('attention.grouping');
  const grouping: Grouping = groupingPref === 'by_kind' ? 'by_kind' : 'by_area';

  const [data, setData] = useState<Grouped | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  /** The row the person has focused, or -1 for none: D152 rule 5, nothing is current on arrival. */
  const [selected, setSelected] = useState(-1);
  const [lastSeen, setLastSeen] = useState<string | null>(null);
  // The act in flight (one at a time: a double press on any row cannot fire twice) and its outcome.
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [actFeedback, setActFeedback] = useState<{ tone: FeedbackTone; message: string; id?: number } | null>(null);
  const feedbackSeq = useRef(0);
  const [moreBusy, setMoreBusy] = useState<string | null>(null);
  // D178 point 5: the batch. The ticked bank Vorschläge (by action id), the run, each row's part, the result.
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());
  const [batchRunning, setBatchRunning] = useState(false);
  const [rowStatus, setRowStatus] = useState<ReadonlyMap<string, VorschlagStatus>>(new Map());
  const [batchOutcome, setBatchOutcome] = useState<BatchOutcome | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  // C4: the Mahnlauf whose issue waits on its confirm (the row's button opened it; nothing is sent yet).
  const [issueConfirm, setIssueConfirm] = useState<{ item: Item; option: DecisionOption } | null>(null);
  // The design judge: repeated unassigned payments of one Bankkonto read as one row; opened on request.
  const [openGroups, setOpenGroups] = useState<ReadonlySet<string>>(new Set());
  const batchHeadingRef = useRef<HTMLSpanElement | null>(null);
  const boxRefs = useRef(new Map<string, HTMLInputElement | null>());

  // Discards an in-flight answer whose workspace is no longer active (design story 6.2).
  const activeWs = useRef<string | null>(workspaceId);
  const rowRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const focusCount = useRef(0);

  const load = useCallback(async () => {
    if (workspaceId === null) {
      setLoading(false);
      return;
    }
    const ws = workspaceId;
    setLoading(true);
    setFailed(false);
    // The "neu" tag compares an item's `since` to the marker from the PREVIOUS visit, so read it before
    // this visit overwrites it.
    setLastSeen(readLastSeen(ws));
    const res = await client.call('attention_list', { workspaceId: ws, grouping });
    if (activeWs.current !== ws) return; // a switch overtook this answer: discard it.
    const parsed = isErr(res.body) ? null : parseGrouped(res.body);
    if (parsed === null) {
      setFailed(true);
      setLoading(false);
      return;
    }
    setData(parsed);
    setSelected(-1);
    setLoading(false);
    if (parsed.computedAt !== '') writeLastSeen(ws, parsed.computedAt);
  }, [client, workspaceId, grouping]);

  // A workspace switch clears the previous client's data BEFORE the new arrives (design story 6.1).
  useEffect(() => {
    activeWs.current = workspaceId;
    setData(null);
    setSelected(-1);
    setActFeedback(null);
    setBusyKey(null);
    setTicked(new Set());
    setRowStatus(new Map());
    setBatchOutcome(null);
    setBatchRunning(false);
    setConfirmOpen(false);
    setIssueConfirm(null);
    setOpenGroups(new Set());
  }, [workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  const openLink = useCallback(
    (link: { route: string; params: Record<string, string> }) => {
      const qs = new URLSearchParams(link.params).toString();
      navigate(qs === '' ? link.route : `${link.route}?${qs}`);
    },
    [navigate],
  );

  const loadMore = useCallback(
    async (section: Section) => {
      if (workspaceId === null || section.nextCursor === undefined) return;
      const ws = workspaceId;
      setMoreBusy(section.key);
      const res = await client.call('attention_list', { workspaceId: ws, grouping, section: section.key, cursor: section.nextCursor });
      if (activeWs.current !== ws) return;
      setMoreBusy(null);
      const parsed = isErr(res.body) ? null : parseGrouped(res.body);
      const page = parsed?.sections.find((s) => s.key === section.key);
      if (page === undefined) {
        setActFeedback({ tone: 'error', message: t('attention.error.more') });
        return;
      }
      setData((current) => (current === null ? current : { ...current, sections: appendPage(current.sections, page) }));
    },
    [client, grouping, t, workspaceId],
  );

  /**
   * One act on one row: the option's verb with exactly the input the engine declared, the human
   * confirmation where the verb takes one, and the reason where the person typed one. The list re-reads
   * afterwards (it shrinks by the act, never by hiding); a refusal keeps the row and says why. `send`
   * makes the call when the caller names the verb itself (the Mahnlauf's confirmed issue).
   */
  const act = useCallback(
    async (item: Item, option: DecisionOption, reason?: string, send?: (input: Record<string, unknown>) => Promise<RestResponse>) => {
      if (workspaceId === null || option.verb === null || busyKey !== null || batchRunning) return;
      const ws = workspaceId;
      const rowKey = `${item.queueId}:${item.entityId}`;
      setBusyKey(rowKey);
      setActFeedback(null);
      setBatchOutcome(null);
      const input = {
        workspaceId: ws,
        ...option.input,
        ...(option.humanConfirm ? { confirmed: true } : {}),
        ...(reason !== undefined && reason !== '' ? { reason } : {}),
      };
      const res = send !== undefined ? await send(input) : await client.call(option.verb, input);
      if (activeWs.current !== ws) return;
      setBusyKey(null);
      if (isErr(res.body)) {
        const code = res.body.error;
        setActFeedback({ tone: 'error', message: refusalText(t, res.body, ACT_WORDING) });
        if (['not_found', 'already_applied', 'already_executed', 'gap_not_found', 'vorschlag_stale'].includes(code)) void load();
        return;
      }
      setActFeedback({ tone: 'success', message: t(`attention.act.done.${option.id}`), id: ++feedbackSeq.current });
      // The rail count and the Übersicht list re-read now, not at their next minute.
      announceAttentionChanged();
      await load();
    },
    [batchRunning, busyKey, client, load, t, workspaceId],
  );

  const createTask = useCallback(
    async (item: Item) => {
      if (workspaceId === null) return;
      const ws = workspaceId;
      // The defer (design story 3.1): an E03 task OP3-linked to the item. Nothing visible moves, so the
      // outcome is the only signal: a success is confirmed and a refusal is shown, never swallowed.
      setActFeedback(null);
      const res = await client.call('tasks_create', {
        workspaceId: ws,
        title: itemTitle(t, item),
        ...(item.entityKind !== '' ? { entityKind: item.entityKind, entityId: item.entityId } : {}),
        idempotencyKey: newKey(),
      });
      if (activeWs.current !== ws) return;
      if (isErr(res.body)) {
        setActFeedback({ tone: 'error', message: refusalText(t, res.body, ACT_WORDING) });
        return;
      }
      setActFeedback({ tone: 'success', message: t('attention.act.taskCreated'), id: ++feedbackSeq.current });
    },
    [client, workspaceId, t],
  );

  const copyRef = (item: Item) => {
    try {
      void navigator.clipboard?.writeText(`${item.entityKind}:${item.entityId}`);
    } catch {
      // A clipboard the browser refuses is not an error worth a banner.
    }
  };

  const triageOf = (item: Item): OverflowMenuItem[] => [
    ...(canCreateTask ? [{ key: 'task', label: t('attention.overflow.createTask'), onSelect: () => void createTask(item) }] : []),
    { key: 'copy', label: t('attention.overflow.copyRef'), onSelect: () => copyRef(item) },
  ];

  const allItems = (data?.sections ?? []).flatMap((s) => s.items);

  // D167: the Vorschlag lines read the drafted payloads (Details) and the dial (Freigabe), once per list
  // and only while one is shown. A failed read leaves Details without the payload rows; the decision
  // itself never depends on it, and no figure on this page is read from it (critic N4 M2).
  const agentIds = allItems.filter(isVorschlag).map((i) => i.entityId).join(',');
  // A stale Vorschlag stays listed (the design judge), so its own words are read too: its title is the thing.
  const anyStale = allItems.some((i) => isVorschlag(i) && i.stale);
  const [drafted, setDrafted] = useState<ReadonlyMap<string, DraftedAction>>(new Map());
  useEffect(() => {
    setDrafted(new Map());
    if (agentIds === '' || workspaceId === null) return;
    const ws = workspaceId;
    let live = true;
    void (async () => {
      const statuses = anyStale ? ['pending', 'stale'] : ['pending'];
      const answers = await Promise.all(statuses.map((status) => client.call('list_drafted_actions', { workspaceId: ws, status })));
      if (!live || activeWs.current !== ws) return;
      const rows = answers.flatMap((res) => (isErr(res.body) ? [] : parseDrafted(res.body)));
      setDrafted(new Map(rows.map((a) => [a.actionId, a])));
    })();
    return () => {
      live = false;
    };
  }, [agentIds, anyStale, client, workspaceId]);
  const dial = useDialLevels(agentIds !== '', actFeedback?.id ?? batchOutcome?.id ?? 0);
  const accountNames = useAccountNames(agentIds !== '');

  /**
   * A Vorschlag the batch may approve right now: the ENGINE marked it batchable (a decision on a bank line,
   * unchanged), the person holds the right, and it is not their own. Nothing else is ever ticked.
   */
  const approvable = useCallback(
    (item: Item) =>
      item.batchable &&
      canDecide &&
      item.changedSinceProposal !== true &&
      (item.proposedBy === undefined || whoami === null || item.proposedBy !== whoami.actor) &&
      (item.decisionOptions ?? []).some((o) => o.id === 'approve' && o.verb === 'approve_drafted_action'),
    [canDecide, whoami],
  );
  const mode = data?.approvalBatchMode ?? 'tick';

  // A re-read drops the ticks of rows that left or can no longer be batched.
  useEffect(() => {
    setTicked((current) => {
      const present = new Set(allItems.filter(approvable).map((i) => i.entityId));
      const next = new Set([...current].filter((id) => present.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * A Vorschlag in words, as the line and the batch result say it: the counterparty leads (the fresh-eyes
   * judge, N4 M3: the meta's middle slot is ALWAYS the booking account, so who the money went to moves up
   * here), then the drafted thing's own text.
   */
  const vorschlagTitle = (row: Item): string => {
    const d = drafted.get(row.entityId);
    const text = d !== undefined && typeof d.payload.text === 'string' && d.payload.text !== '' ? d.payload.text : null;
    const counterparty = typeof row.subtitleParams?.counterparty === 'string' ? row.subtitleParams.counterparty : '';
    if (counterparty !== '') return text !== null && text !== counterparty ? t('attention.vorschlag.titleWith', { counterparty, thing: text }) : counterparty;
    return text ?? verbLabel(t, String(row.subtitleParams?.tool ?? '')) ?? itemTitle(t, row);
  };

  /**
   * THE BATCH (D178 point 5): the existing `approve_drafted_action`, once per row, strictly one after the
   * other, each with exactly the input its row declared. A refusal neither stops nor undoes the others. One
   * re-read at the end; the refused rows that are still pending stay ticked with their reason in words.
   */
  const runBatch = useCallback(
    async (rows: Item[]) => {
      if (workspaceId === null || rows.length === 0 || batchRunning || busyKey !== null) return;
      const ws = workspaceId;
      setBatchRunning(true);
      setActFeedback(null);
      setBatchOutcome(null);
      setConfirmOpen(false);
      setRowStatus(new Map(rows.map((r) => [r.entityId, { tone: 'running', text: t('attention.batch.waiting') }])));
      const approved: BatchOutcome['approved'] = [];
      const refused: { id: string; title: string; message: string; rowText?: string }[] = [];
      for (const row of rows) {
        setRowStatus((current) => new Map(current).set(row.entityId, { tone: 'running', text: t('attention.batch.running') }));
        // The batch commits ONE verb, the human-only approval, and names it (the accent guard holds the
        // commit button to it): a row whose approve is anything else is not run.
        const option = (row.decisionOptions ?? []).find((o) => o.id === 'approve' && o.verb === 'approve_drafted_action');
        const title = vorschlagTitle(row);
        if (option === undefined) {
          refused.push({ id: row.entityId, title, message: t('attention.batch.notOffered') });
          continue;
        }
        const res = await client.call('approve_drafted_action', { workspaceId: ws, ...option.input });
        if (activeWs.current !== ws) return;
        if (isErr(res.body)) {
          const message = refusalText(t, res.body, ACT_WORDING);
          // L1: the row says the short words; the result banner says the whole sentence once.
          const rowText = res.body.error === 'vorschlag_stale' ? t('attention.vorschlag.staleShort') : message;
          refused.push({ id: row.entityId, title, message, rowText });
          setRowStatus((current) => new Map(current).set(row.entityId, { tone: 'error', text: rowText }));
        } else {
          const result = (res.body as Record<string, unknown>).result as Record<string, unknown> | undefined;
          approved.push({ title, entryId: typeof result?.entryId === 'string' ? result.entryId : null });
          setRowStatus((current) => new Map(current).set(row.entityId, { tone: 'ok', text: t('attention.batch.ok') }));
        }
      }
      announceAttentionChanged();
      await load();
      if (activeWs.current !== ws) return;
      setBatchRunning(false);
      setBatchOutcome({ approved, refused: refused.map(({ title, message }) => ({ title, message })), id: ++feedbackSeq.current });
      // A refused row stays (a stale one too, the engine keeps it listed): its reason under it, still ticked
      // when it can still be batched.
      setRowStatus(new Map(refused.map((r) => [r.id, { tone: 'error' as const, text: r.rowText ?? r.message }])));
      setTicked(new Set(refused.map((r) => r.id)));
      // Focus: the first refused row's box when it is still there, else the bar's heading.
      requestAnimationFrame(() => {
        const first = refused.map((r) => boxRefs.current.get(r.id)).find((el) => el !== null && el !== undefined);
        if (first !== undefined && first !== null) first.focus();
        else batchHeadingRef.current?.focus();
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [batchRunning, busyKey, client, load, t, workspaceId, drafted],
  );

  /** Roving selection over every row of every section: arrows move, Home/End jump (design story 8.1). */
  const onListKeyDown = (event: ReactKeyboardEvent) => {
    const last = focusCount.current - 1;
    if (last < 0) return;
    const target = event.target as HTMLElement | null;
    if (target !== null && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
    // A row whose one way in is no button (no right to act, a hint instead) has no focus target: skip it.
    const usable = (i: number) => rowRefs.current[i] !== null && rowRefs.current[i] !== undefined;
    const step = (from: number, dir: 1 | -1) => {
      for (let i = from; i >= 0 && i <= last; i += dir) if (usable(i)) return i;
      return selected;
    };
    let next = selected;
    if (event.key === 'ArrowDown') next = step(selected + 1, 1);
    else if (event.key === 'ArrowUp') next = step(Math.max(selected - 1, 0), -1);
    else if (event.key === 'Home') next = step(0, 1);
    else if (event.key === 'End') next = step(last, -1);
    else return;
    event.preventDefault();
    setSelected(next);
    rowRefs.current[next]?.focus();
  };

  const header = (actions?: ReactNode) => (
    <SurfaceHeader title={t('attention.title')} titleId="att-title" help={<SurfaceHelp surface="Attention" />} actions={actions} />
  );

  if (workspaceId === null) return <NoWorkspaceState />;
  if (loading && data === null) {
    return (
      <section className="att" aria-labelledby="att-title">
        {header()}
        <div role="status" aria-busy="true" aria-live="polite" className="att-skeleton">
          <span className="att-sr">{t('attention.loading')}</span>
          {[3, 2].map((rows, i) => (
            <div key={i} className="att-skeleton-section">
              <Skeleton rows={1} />
              <Skeleton rows={rows} />
            </div>
          ))}
        </div>
      </section>
    );
  }
  if (failed || data === null) {
    return (
      <section className="att" aria-labelledby="att-title">
        {header()}
        <ErrorBanner message={t('attention.error.total')} onRetry={() => void load()} />
      </section>
    );
  }

  // The padlock and the empty state are DIFFERENT facts and never render together (design story 1.5).
  if (data.visibleQueues === 0) {
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

  const celebratory = data.failed.length === 0 && (data.total ?? 0) === 0;
  const batchRows = allItems.filter(approvable);
  const batchVerbs = [...new Set(batchRows.map((r) => String(r.subtitleParams?.tool ?? '')).filter((v) => v !== ''))];
  let flatIndex = 0;
  const nextFocus = () => {
    const index = flatIndex;
    flatIndex += 1;
    return index;
  };
  const focusProps = (index: number) => ({
    ref: (el: HTMLButtonElement | null) => {
      rowRefs.current[index] = el;
    },
    tabIndex: index === Math.max(selected, 0) ? 0 : -1,
    current: index === selected,
    onFocus: () => setSelected(index),
  });

  /** A Vorschlag's date as the meta line ends with it: the bank line's booking date, else the proposal's. */
  const vorschlagDate = (item: Item): string | null => {
    const date = String(item.subtitleParams?.date ?? '') || item.since;
    return /^\d{4}-\d{2}-\d{2}/.test(date) ? formatDate(date.slice(0, 10)) : null;
  };

  /**
   * A decision on a bank line carries the line's own facts (critic N4 M2): the meta is the amount, what it
   * books onto, the date. Any other Vorschlag keeps its pinned essentials (D162 point 1) with the date last.
   */
  const hasLineFacts = (item: Item): boolean => typeof item.subtitleParams?.date === 'string' && item.subtitleParams.date !== '';

  /** A Vorschlag's meta in the hub's one order: the amount, what it books onto, the date. */
  const vorschlagMeta = (item: Item): ReactNode => {
    const parts: ReactNode[] = [];
    // The line's own signed amount and currency, as the engine read them off the bank line; never guessed.
    if (item.amountMinor !== undefined && item.currency !== undefined) {
      parts.push(<Amount key="amount" minor={item.amountMinor} currency={item.currency} />);
    }
    const target = String(item.subtitleParams?.target ?? '');
    const kindKey = TARGET_KIND_KEY[String(item.subtitleParams?.targetKind ?? '')];
    const what = target !== '' ? target : kindKey !== undefined ? t(kindKey) : verbLabel(t, String(item.subtitleParams?.tool ?? ''));
    if (what !== '') parts.push(<span key="what" className="att-row-sub">{what}</span>);
    const date = vorschlagDate(item);
    if (date !== null) parts.push(<span key="date">{date}</span>);
    return parts.flatMap((part, i) => (i === 0 ? [part] : [<span key={`sep-${i}`} aria-hidden="true">{SEP}</span>, part]));
  };

  const renderVorschlag = (item: Item, withBoxColumn: boolean) => {
    const index = nextFocus();
    const focus = focusProps(index);
    const options = item.decisionOptions ?? [];
    const option = (id: string) => options.find((o) => o.id === id && o.verb !== null);
    const recovery = options.find((o) => o.id === 'check_in_bank' && o.deepLink !== undefined);
    const rowKey = `${item.queueId}:${item.entityId}`;
    const tickable = mode === 'tick' && approvable(item);
    // N4 H1: the lead holds the box on a batchable line and NOTHING otherwise (no agent mark, no kind glyph).
    const mark =
      withBoxColumn && tickable ? (
        <label className="att-check">
          <input
            type="checkbox"
            className="att-batch-box"
            data-batch-row=""
            ref={(el) => {
              boxRefs.current.set(item.entityId, el);
            }}
            aria-label={t('attention.batch.selectRow', { title: vorschlagTitle(item) })}
            checked={ticked.has(item.entityId)}
            disabled={batchRunning}
            onChange={(e) => {
              const on = e.target.checked;
              setTicked((current) => {
                const next = new Set(current);
                if (on) next.add(item.entityId);
                else next.delete(item.entityId);
                return next;
              });
            }}
          />
        </label>
      ) : null;
    return (
      <li key={rowKey} className="att-item att-item--vorschlag" data-row-count={item.count} aria-busy={busyKey === rowKey ? 'true' : undefined}>
        <VorschlagLine
          compact
          action={vorschlagOf(item, drafted.get(item.entityId))}
          dial={dial}
          accountNames={accountNames}
          busy={busyKey !== null || batchRunning}
          bankLineInMenu
          mark={<span className="att-lead">{mark}</span>}
          titleText={vorschlagTitle(item)}
          meta={hasLineFacts(item) ? vorschlagMeta(item) : undefined}
          metaTail={hasLineFacts(item) ? undefined : (vorschlagDate(item) ?? undefined)}
          recovery={recovery?.deepLink !== undefined ? { label: t(recovery.labelKey), onClick: () => openLink(recovery.deepLink as { route: string; params: Record<string, string> }) } : null}
          staleText={t('attention.vorschlag.staleShort')}
          status={rowStatus.get(item.entityId) ?? null}
          offers={{ approve: option('approve') !== undefined, approveAllow: option('approve_allow') !== undefined, reject: option('reject') !== undefined }}
          extraMenuItems={triageOf(item)}
          onApprove={(_, allowFuture) => {
            const chosen = option(allowFuture ? 'approve_allow' : 'approve');
            if (chosen !== undefined) void act(item, chosen);
          }}
          onReject={(_, reason) => {
            const chosen = option('reject');
            if (chosen !== undefined) void act(item, chosen, reason);
          }}
          titleRef={focus.ref}
          titleTabIndex={focus.tabIndex}
          titleCurrent={focus.current}
          onTitleFocus={focus.onFocus}
        />
      </li>
    );
  };

  const renderRow = (item: Item, member = false) => {
    const index = nextFocus();
    const focus = focusProps(index);
    const rowKey = `${item.queueId}:${item.entityId}`;
    return (
      <li key={rowKey} className={member ? 'att-item att-item--member' : 'att-item'} {...(member ? { 'data-member': '' } : {})}>
        <AttentionRow
          item={item}
          tagged={isNew(item.since, lastSeen)}
          busy={busyKey === rowKey}
          locked={busyKey !== null || batchRunning}
          triage={triageOf(item)}
          onOpen={openLink}
          onAct={(option, reason) => {
            // C4: issuing a Mahnlauf books its fees, so its button only opens the confirm.
            if (option.verb === 'issue_dunning_run') setIssueConfirm({ item, option });
            else void act(item, option, reason);
          }}
          focusRef={focus.ref}
          focusTabIndex={focus.tabIndex}
          focusCurrent={focus.current}
          onFocusIn={focus.onFocus}
        />
      </li>
    );
  };

  /**
   * The design judge: two or more unassigned payments of one Bankkonto read as ONE row, like the bank lines
   * ("4 Zahlungen ohne Zuordnung"), its count the units it stands for. Its button names the job, "Zahlungen
   * zuordnen" (the fresh-eyes judge, N4 M5): it opens the payments right here, each with its own Zuordnen,
   * because they are assigned nowhere else (the provider's own note: no other surface lists hand-typed
   * credits). The (i) and the ⋯ sit where every row has them.
   */
  const renderPaymentsGroup = (members: Item[]) => {
    const bank = String(members[0]?.subtitleParams?.bank ?? '');
    const key = `qr:${bank}`;
    const open = openGroups.has(key);
    const index = nextFocus();
    const focus = focusProps(index);
    const totals = batchTotalsOf(members);
    const count = members.reduce((n, m) => n + m.count, 0);
    const listId = `att-group-${key.replace(/\W+/g, '-')}`;
    return (
      <li key={key} className="att-item att-item--group" data-row-count={count}>
        <div className="att-row" data-queue="qr_match">
          <div className="att-row-line">
            <span className="att-lead" aria-hidden="true" />
            <div className="att-row-text">
              <span className="att-row-title att-row-title--text">{t('attention.group.payments', { count })}</span>
              <span className="att-row-meta">
                {totals.perCurrency.map((c) => (
                  <Fragment key={c.currency}>
                    <Amount minor={c.inMinor - c.outMinor} currency={c.currency} />
                    <span aria-hidden="true">{SEP}</span>
                  </Fragment>
                ))}
                <span className="att-row-sub">{bank}</span>
              </span>
            </div>
            <span className="att-info">
              <IconButton icon="info" small context={t('attention.group.info')} />
            </span>
            <div className="att-row-action">
              <button
                type="button"
                ref={focus.ref}
                tabIndex={focus.tabIndex}
                aria-current={focus.current ? 'true' : undefined}
                onFocus={focus.onFocus}
                className="btn btn--secondary btn--sm"
                aria-expanded={open}
                aria-controls={listId}
                onClick={() =>
                  setOpenGroups((current) => {
                    const next = new Set(current);
                    if (next.has(key)) next.delete(key);
                    else next.add(key);
                    return next;
                  })
                }
              >
                {t(open ? 'attention.group.hide' : 'attention.group.assign')}
              </button>
            </div>
            <OverflowMenu
              quiet
              className="att-row-more"
              label={t('attention.overflow.label', { title: t('attention.group.payments', { count }) })}
              items={canCreateTask ? [{ key: 'task', label: t('attention.overflow.createTask'), onSelect: () => void createGroupTask(t('attention.group.payments', { count })) }] : []}
            />
          </div>
        </div>
        {open && (
          <ul id={listId} className="att-list att-group-list">
            {members.map((m) => renderRow(m, true))}
          </ul>
        )}
      </li>
    );
  };

  /**
   * The batch commit's (i) (N4 H2): the engine's consequence of each approved verb, the very sentence the
   * row's own (i) shows (`vorschlagOf` gives the verb and its stored tier), then what is selected: the count
   * and the signed money per currency ("2 Vorschläge, CHF -377.90"), or that nothing is selected yet.
   */
  const batchInfo = (rows: Item[]): string => {
    const chosen = rows.filter((r) => ticked.has(r.entityId));
    const basis = chosen.length > 0 ? chosen : rows;
    const sentences = [
      ...new Set(
        basis
          .map((r) => {
            const v = vorschlagOf(r, drafted.get(r.entityId));
            return consequenceSentence(v.actionTool, locale, v.dialCapability);
          })
          .filter((x): x is string => x !== null && x !== ''),
      ),
    ];
    let summary: string;
    if (chosen.length === 0) summary = t('attention.batch.info.none');
    else {
      // Critic N4 R2-L1: the money is what the run BOOKS: only rows that post count; a line set aside is not
      // money. A row the engine gave no line facts is named apart, as the confirm names it.
      const sums = new Map<string, number>();
      for (const r of chosen) if (r.posts && r.amountMinor !== undefined && r.currency !== undefined) sums.set(r.currency, (sums.get(r.currency) ?? 0) + r.amountMinor);
      const without = chosen.filter((r) => r.amountMinor === undefined || r.currency === undefined).length;
      const amounts = [...sums.entries()].map(([currency, minor]) => formatMoney(minor, currency)).join(SEP);
      summary =
        amounts === ''
          ? t('attention.batch.info.summaryNoAmount', { count: chosen.length })
          : chosen.length === 1
            ? t('attention.batch.info.summaryOne', { amounts })
            : t('attention.batch.info.summary', { count: chosen.length, amounts });
      if (without > 0) summary = `${summary}. ${t('attention.batch.confirm.withoutAmount', { count: without })}`;
    }
    return [...sentences, summary].join(' ');
  };

  /** A task for the payments group (its ⋯): the group's title, no single record to link. */
  const createGroupTask = async (title: string) => {
    if (workspaceId === null) return;
    const ws = workspaceId;
    setActFeedback(null);
    const res = await client.call('tasks_create', { workspaceId: ws, title, idempotencyKey: newKey() });
    if (activeWs.current !== ws) return;
    if (isErr(res.body)) {
      setActFeedback({ tone: 'error', message: refusalText(t, res.body, ACT_WORDING) });
      return;
    }
    setActFeedback({ tone: 'success', message: t('attention.act.taskCreated'), id: ++feedbackSeq.current });
  };

  /** The rows of a section after its Vorschläge: payments of one Bankkonto grouped, the rest one by one. */
  const renderRest = (rest: Item[]) => {
    const out: ReactNode[] = [];
    let i = 0;
    while (i < rest.length) {
      const item = rest[i] as Item;
      if (item.queueId === 'qr_match' && item.entityKind !== 'attention_remainder') {
        const bank = String(item.subtitleParams?.bank ?? '');
        let j = i;
        while (j < rest.length && rest[j]?.queueId === 'qr_match' && String(rest[j]?.subtitleParams?.bank ?? '') === bank && rest[j]?.entityKind !== 'attention_remainder') j += 1;
        if (j - i >= 2) {
          out.push(renderPaymentsGroup(rest.slice(i, j)));
          i = j;
          continue;
        }
      }
      out.push(renderRow(item));
      i += 1;
    }
    return out;
  };

  const sectionName = (key: string): string => (data.grouping === 'by_kind' ? t(`attention.kind.${key}`) : t(`attention.area.${key}`));
  const stand = data.computedAt !== '' ? t('attention.stand', { time: standTime(data.computedAt) }) : null;

  const page = (
    <section className="att" aria-labelledby="att-title">
      {header(
        <>
          <Segmented<Grouping>
            label={t('attention.grouping.label')}
            className="att-grouping"
            options={[
              { value: 'by_area', label: t('attention.grouping.byArea') },
              { value: 'by_kind', label: t('attention.grouping.byKind') },
            ]}
            value={grouping}
            onChange={(next) => void setGrouping(next)}
          />
          {data.incomplete && <span className="att-incomplete">{t('attention.incomplete')}</span>}
          {/* The "Stand" time is the refresh control's tooltip (the design judge): no line of its own. */}
          <Tooltip content={stand === null ? t('attention.refresh') : `${t('attention.refresh')} · ${stand}`}>
            <button type="button" className="btn btn--ghost btn--icon btn--sm att-refresh" aria-label={t('attention.refresh')} data-stand={stand ?? undefined} onClick={() => void load()}>
              <RefreshGlyph />
            </button>
          </Tooltip>
        </>,
      )}

      {/* A failed provider is named exactly once, with its own retry, and carries no count (story 1.3). */}
      {data.failed.map((queueId) => (
        <div key={queueId} className="att-provider-error" role="status">
          <span>{t('attention.providerFailed', { queue: queueName(t, locale, queueId) })}</span>
          <button type="button" className="btn btn--secondary btn--sm" onClick={() => void load()}>
            {t('attention.retry')}
          </button>
        </div>
      ))}

      {actFeedback !== null && (
        <ActionFeedback
          key={actFeedback.id ?? 0}
          tone={actFeedback.tone}
          message={actFeedback.message}
          landed={actFeedback.tone === 'success'}
          onDismiss={() => setActFeedback(null)}
          dismissLabel={t('attention.act.dismissFeedback')}
        />
      )}
      {batchOutcome !== null && (
        <div data-batch-result="">
          <ActionFeedback
            key={batchOutcome.id}
            tone={batchOutcome.refused.length === 0 ? 'success' : 'warn'}
            message={
              batchOutcome.refused.length === 0
                ? t('attention.batch.doneAll', { count: batchOutcome.approved.length })
                : t('attention.batch.doneSome', { ok: batchOutcome.approved.length, refused: batchOutcome.refused.length })
            }
            detail={
              <ul className="att-batch-result">
                {batchOutcome.approved.map((a, i) => (
                  <li key={`ok-${i}`}>
                    {t('attention.batch.approvedLine', { title: a.title })}
                    {a.entryId !== null && (
                      <>
                        {SEP}
                        <Link className="link-inline" to={`/journal?entryId=${encodeURIComponent(a.entryId)}`}>
                          {t('attention.batch.openEntry')}
                        </Link>
                      </>
                    )}
                  </li>
                ))}
                {batchOutcome.refused.map((r, i) => (
                  <li key={`no-${i}`}>{t('attention.batch.refusedLine', { title: r.title, reason: r.message })}</li>
                ))}
              </ul>
            }
            landed={batchOutcome.refused.length === 0}
            onDismiss={() => setBatchOutcome(null)}
            dismissLabel={t('attention.act.dismissFeedback')}
          />
        </div>
      )}

      {data.sections.length === 0 ? (
        celebratory ? (
          <EmptyState title={t('attention.empty.title')} hint={t('attention.empty.hint')} action={{ label: t('attention.empty.action'), to: '/overview' }} />
        ) : (
          <p className="att-empty-partial">{t('attention.empty.hint')}</p>
        )
      ) : (
        // eslint-disable-next-line jsx-a11y/no-static-element-interactions
        <div className="att-sections" onKeyDown={onListKeyDown}>
          {data.sections.map((section) => {
            const headId = `att-sec-${section.key}`;
            // The Vorschläge lead their section (the engine's order); the batch bar heads them.
            const lead = section.items.filter(isVorschlag);
            const rest = section.items.filter((i) => !isVorschlag(i));
            const sectionBatch = lead.filter(approvable);
            // The design judge: the bar only for two or more batchable rows, kept while a batch runs or reports.
            const showBar = mode !== 'single' && (sectionBatch.length >= 2 || (batchRunning && lead.length > 0) || (batchOutcome !== null && sectionBatch.length > 0));
            const remaining = section.count - section.items.reduce((n, i) => n + i.count, 0);
            // The section's name and count, its h2; with a batch, the head line carries the batch too (N4 M2).
            const heading = (
              <h2 className="att-section-title" id={headId}>
                <span className="att-section-name">{sectionName(section.key)}</span>
                <span className="att-section-count t-num">{section.count}</span>
              </h2>
            );
            const glyph = (
              <span className="att-section-glyph" aria-hidden="true">
                <Mark mark={sectionMarkOf(section.key)} />
              </span>
            );
            return (
              <section key={section.key} className="att-section" data-section={section.key} data-count={section.count} aria-labelledby={headId}>
                {/* The section head keeps its area glyph; the batch has its own "Vorschläge n" sub-head, so the
                    select-all box never reads as selecting the whole section (B5 final judge). */}
                <div className="att-section-head">
                  <span className="att-lead">{glyph}</span>
                  {heading}
                </div>
                {showBar && (
                  <BatchBar
                    mode={mode}
                    rowCount={sectionBatch.length}
                    selectedCount={sectionBatch.filter((r) => ticked.has(r.entityId)).length}
                    running={batchRunning}
                    quiet={issueConfirm !== null}
                    books={sectionBatch.some((r) => ticked.has(r.entityId) && r.posts)}
                    partial={section.nextCursor !== undefined}
                    heading={
                      <span className="att-batch-title" ref={batchHeadingRef} tabIndex={-1}>
                        <span className="att-batch-name">{t('attention.batch.title')}</span>
                        <span className="att-section-count t-num">{sectionBatch.length}</span>
                      </span>
                    }
                    glyph={null}
                    info={batchInfo(sectionBatch)}
                    onToggleAll={(on) =>
                      setTicked((current) => {
                        const next = new Set(current);
                        for (const r of sectionBatch) {
                          if (on) next.add(r.entityId);
                          else next.delete(r.entityId);
                        }
                        return next;
                      })
                    }
                    onApproveSelected={() => void runBatch(sectionBatch.filter((r) => ticked.has(r.entityId)))}
                    onApproveAll={() => setConfirmOpen(true)}
                  />
                )}
                <ul className="att-list">
                  {/* The tickable Vorschläge first, right under their sub-head; then the rest of the section. */}
                  {(showBar ? [...lead.filter(approvable), ...lead.filter((i) => !approvable(i))] : lead).map((item) => renderVorschlag(item, showBar))}
                  {renderRest(rest)}
                </ul>
                {section.nextCursor !== undefined && remaining > 0 && (
                  <button type="button" className="btn btn--secondary btn--sm att-more" disabled={moreBusy !== null} onClick={() => void loadMore(section)}>
                    {t('attention.section.more', { count: remaining })}
                  </button>
                )}
              </section>
            );
          })}
        </div>
      )}

      <IssueDunningConfirm
        runId={issueConfirm === null ? null : String(issueConfirm.option.input.runId ?? issueConfirm.item.entityId)}
        workspaceId={workspaceId}
        busy={busyKey !== null || batchRunning}
        onClose={() => setIssueConfirm(null)}
        onConfirm={() => {
          if (issueConfirm === null) return;
          const { item, option } = issueConfirm;
          setIssueConfirm(null);
          // The one place the issue is sent: confirmed, with the engine's declared input and key.
          void act(item, option, undefined, (input) => client.call('issue_dunning_run', input));
        }}
      />

      <BatchConfirm
        open={confirmOpen}
        books={batchRows.some((r) => r.posts)}
        count={batchRows.length}
        totals={batchTotalsOf(batchRows)}
        verbs={batchVerbs}
        onConfirm={() => void runBatch(batchRows)}
        onClose={() => setConfirmOpen(false)}
      />

      <EventsZone />
    </section>
  );
  focusCount.current = flatIndex;
  // Every (i) and the refresh sit at the right edge: an open bubble goes to the overlay layer and is held
  // inside the viewport (the Bank precedent), so no tooltip ever widens the page on a phone.
  return <TooltipPortalContext.Provider value={true}>{page}</TooltipPortalContext.Provider>;
}

export default Attention;
