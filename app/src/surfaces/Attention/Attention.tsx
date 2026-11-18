/**
 * G15, Pendenzen (`/attention`): the one screen that answers "what is waiting for a decision from me".
 *
 * D201 point 4 (owner, 15.11.2026, pick A; the owner called the sectioned page "ultra high cognitive load"):
 *
 *  - ONE LIST WITH FILTERS. One `attention_list` read; its sections are flattened into one list in the
 *    engine's order (the Vorschläge first). Above it one filter row: a live search, chips for the kind
 *    (Vorschläge, Erledigen, Hinweise, each with its count), and the area and the sender (Agent or TILL) as
 *    facets. Filtering is client-side over the list already read; a filter that would not change the list
 *    is not offered (DESIGN.md rule 2). The kinds, area and sender a person last used persist as their
 *    preference `attention.filters` (default: everything); the search does not.
 *  - ONE LINE PER ROW: the kind's glyph, the title, the amount, the account, the date, and the act in the row
 *    (Freigeben and Ablehnen on a Vorschlag, the one action on any other row). The reason, the receipts and
 *    the detail open IN PLACE from the chevron at the row's end.
 *  - MULTI-SELECT AND ONE STICKY BAR. A Vorschlag the person may decide has a box (never pre-ticked, D152 rule
 *    5); the head box ticks every visible one. While anything is ticked, the bar at the bottom offers
 *    "Freigeben (n)" and "Ablehnen (n)", each ONE call of the batch verb (`approve_drafted_actions`,
 *    `reject_drafted_actions`), never a loop of single calls. Rows that went through leave (fade and
 *    collapse); ids that failed stay ticked with their cause in the row. Rejecting asks nothing (D204).
 *  - ISSUING A MAHNLAUF IS CONFIRMED FIRST (DESIGN.md D118 C4): its row button opens the governed confirm and
 *    sends nothing; only the confirm's commit sends `issue_dunning_run`.
 *  - A VORSCHLAG THAT CAN NO LONGER BE APPROVED STAYS: the row says so in one wording and offers one way on,
 *    the line in the bank.
 *
 * D207 (owner, 16.11.2026, picks A A A):
 *
 *  - THREE SECTIONS one below the other: Bankbuchungen (the agent's decisions on one bank line: book, set aside,
 *    match), Weitere Vorschläge (every other Vorschlag), Zu erledigen (everything that is not a Vorschlag),
 *    each with its glyph and count. The filters act across all three, and a filter narrows the WHOLE page:
 *    while one is set the Ereignisse zone below steps away, because an event has no kind, area or sender to
 *    match (the owner's "the Bank filter keeps everything" was that zone staying under a Bank filter).
 *  - A ROW CLICK OPENS ITS DETAILS BELOW (`VorschlagLine`); three icons, one word each; no overflow menu.
 *  - "FREIGEBEN UND KÜNFTIG AUTOMATISCH" on a bank booking to accounts: approve, then save the Buchungsregel
 *    from the booked line (`autoRule.tsx`), one click (`attention.auto_rule_confirm`, default `never`).
 *
 * Unchanged from G15: no row is current on arrival (the roving tab stop sits on the first row); the act is the
 * item's declared `decisionOptions`, sent exactly as declared; a denied queue is absent, a failed queue is named
 * once with its own retry, `visibleQueues == 0` is the padlock; a workspace switch clears everything before the
 * new answer arrives and discards a late one.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';

import { useClient } from '../../lib/client-context';
import { useBookAgain } from '../../components/BookAgain';
import { isErr, type RestResponse } from '../../lib/client';
import { useWorkspaceId } from '../../app/workspace';
import { useCan, useCapabilities } from '../../lib/capabilities';
import { useArriveLeave } from '../../lib/motion';
import { usePref, type PrefValue } from '../../lib/prefs';
import { useFeedback } from '../../components/FeedbackProvider';
import { useI18n, formatDate, formatMoney } from '../../i18n';
import { consequenceSentence } from '../../lib/approval-tiers';
import { IconButton } from '../../components/IconButton';
import { SurfaceHelp } from '../../components/SurfaceHelp';
import { SurfaceHeader } from '../../components/SurfaceHeader';
import { FilterBar, type FilterFacet } from '../../components/FilterBar';
import { FilterChips } from '../../components/FilterChips';
import { TooltipPortalContext } from '../../components/Tooltip';
import { EmptyState, ErrorBanner, NoWorkspaceState, Padlock, Skeleton, refusalText } from '../../components/states';
import { ActionFeedback, type FeedbackTone } from '../../components/ActionFeedback';
import { EventsZone } from './EventsZone';
import { businessDate, parseVorschlaege, type VorschlagItem } from '../Agent/vorschlagView';
import type { VorschlagStatus } from '../Agent/VorschlagLine';
import { recordRouteOf, rowFacts, type RowFacts } from '../Agent/vorschlagView';
import { useAccountNames } from '../Agent/useAccountNames';
import { accountsPhrase, readbackRows } from '../Agent/vorschlagDetails';
import { PendenzLine, type LineCommit, type OpenLineSpec } from './PendenzLine';
import { booksLike, draftLegs, editableLeg, missingBeleg, prefillText, ruleWords, shownSlotOf, slotRuleOf, sourceOf, textRuleOf, useLineContext, type RuleInfo, type ShownSlot } from './lineContext';
import { commitOpenLine, lineKeysFor, type LineKeys } from './openLineCommit';
import { useAttentionSettings } from './useAttentionSettings';
import { useAttachReceipt } from '../Bank/useAttachReceipt';
import { RuleConfirm, clearSavedRule, newRuleKey, planAccountsWords, readRuleSlot, repinAfterSlotChange, rulePlanOf, ruleRefusalText, saveRuleFromBooking, useAutoRuleConfirm, type PendingRule, type RuleOutcome, type RulePlan } from './autoRule';
import { AttentionRow } from './AttentionRow';
import { BatchConfirm, SelectionDock, batchTotalsOf, parseBatchAnswer } from './Batch';
import { IssueDunningConfirm } from './IssueDunningConfirm';
import { AutobookDigestLines, parseWaiting, type WaitingLine } from './AutobookDigestLines';
import { Amount } from './Amount';
import { verbLabel, type DecisionOption } from './RowDecision';
import { itemSubtitle, itemTitle, queueName } from './itemText';
import { announceAttentionChanged } from './attentionSummary';
import { appendPage, isVorschlag, parseGrouped, standTime, vorschlagOf, type Grouped, type Item, type RuleProposal } from './model';
import './Attention.css';

/** The meta line's separator (the hub's one), non-breaking. */
const SEP = ' · ';

/** Rows per section in one read: the whole list in practice, so the filters see every row. */
const PAGE_LIMIT = 200;

type Actor = 'agent' | 'till';

/** The filters a person last used (`attention.filters`); `null` is "all". D208: the chips pick a section. */
interface Filters {
  sections: SectionKey[];
  area: string | null;
  actor: Actor | null;
}

const NO_FILTERS: Filters = { sections: [], area: null, actor: null };
const SECTION_KEYS = ['bank', 'other', 'todo'] as const;

/** The stored preference, read defensively: anything this build cannot read is "all". */
function readFilters(raw: PrefValue | undefined): Filters {
  if (raw === null || raw === undefined || typeof raw !== 'object' || Array.isArray(raw)) return NO_FILTERS;
  const r = raw as Record<string, unknown>;
  const sections = Array.isArray(r.sections) ? SECTION_KEYS.filter((k) => (r.sections as unknown[]).includes(k)) : [];
  const area = typeof r.area === 'string' && r.area !== 'all' && r.area !== '' ? r.area : null;
  const actor = r.actor === 'agent' || r.actor === 'till' ? r.actor : null;
  return { sections, area, actor };
}

function filtersPref(f: Filters): PrefValue {
  return { sections: [...f.sections], area: f.area ?? 'all', actor: f.actor ?? 'all' };
}

/** The refusal codes the hub carries its own sentence for; anything else renders the generic one. */
const KNOWN_ACT_ERRORS: ReadonlySet<string> = new Set([
  'receipt_already_booked',
  'holders_changed',
  'period_locked',
  'permission_denied',
  'cannot_self_approve',
  'already_applied',
  'already_paid',
  'currency_mismatch',
  'already_executed',
  'already_resolved',
  'not_batchable',
  'not_found',
  'gap_not_chained',
  'gap_has_waiting_statement',
  'gap_not_found',
  'human_only',
]);

/** How Pendenzen words a refusal. A stale Vorschlag has ONE wording everywhere on this page. */
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

/** Who a row comes from: a Vorschlag an agent drafted is the agent's; everything else (TILL's offers too) is TILL's. */
function actorOf(item: Item): Actor {
  return isVorschlag(item) && item.proposedBy !== undefined && item.proposedBy !== 'system' ? 'agent' : 'till';
}

const keyOf = (item: Item) => `${item.queueId}:${item.entityId}`;

/** D207: the agent's decisions on ONE bank line (book it, set it aside, match it): the Bankbuchungen section. */
const BANK_LINE_TOOLS: ReadonlySet<string> = new Set(['book_bank_line', 'ignore_bank_line', 'confirm_match', 'create_entry_for_txn']);

/** The three sections of D207, in their order. */
type SectionKey = 'bank' | 'other' | 'todo';

/** Which section a row sits in: a bank-line decision, any other Vorschlag, or work and notes. */
function sectionOf(item: Item, tool: string): SectionKey {
  if (!isVorschlag(item)) return 'todo';
  return item.queueId === 'agent_action_bank' && BANK_LINE_TOOLS.has(tool) ? 'bank' : 'other';
}

/**
 * How long a row takes to leave (D204, Arrive and leave): the motion token, read off the root so the CSS and
 * the wait are one number; nothing under reduced motion or the `off` level.
 */
function leaveMs(): number {
  if (typeof window === 'undefined' || typeof document === 'undefined') return 0;
  if (typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return 0;
  const root = document.documentElement;
  if (root.dataset.motion === 'off') return 0;
  const raw = getComputedStyle(root).getPropertyValue('--t-motion-reveal').trim();
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n)) return 0;
  return raw.endsWith('ms') ? n : raw.endsWith('s') ? n * 1000 : 0;
}

const wait = (ms: number) => (ms <= 0 ? Promise.resolve() : new Promise<void>((resolve) => setTimeout(resolve, ms)));

export function Attention() {
  const { t, locale } = useI18n();
  const client = useClient();
  const navigate = useNavigate();
  const workspaceId = useWorkspaceId();
  const canDecide = useCan('manage_agent_dial');
  const { whoami } = useCapabilities();
  const feedback = useFeedback();
  const [filtersRaw, setFiltersRaw] = usePref<PrefValue>('attention.filters');
  const filters = useMemo(() => readFilters(filtersRaw), [filtersRaw]);
  const setFilters = useCallback((next: Filters) => void setFiltersRaw(filtersPref(next)), [setFiltersRaw]);
  const [search, setSearch] = useState('');

  const [data, setData] = useState<Grouped | null>(null);
  // A41.3: the autopilot lines waiting for their receipt now (the waitingForBeleg of autobook_digest).
  const [waiting, setWaiting] = useState<readonly WaitingLine[]>([]);
  const newestDigestDay = useMemo(() => {
    const days = (data?.sections ?? []).flatMap((sec) => sec.items.map((i) => i.autobookDigest?.day ?? '')).filter((d) => d !== '');
    return days.length === 0 ? null : days.reduce((a, b) => (a > b ? a : b));
  }, [data]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  /** The row the person has focused, or -1 for none: D152 rule 5, nothing is current on arrival. */
  const [selected, setSelected] = useState(-1);
  // The act in flight (one at a time: a double press on any row cannot fire twice) and its outcome.
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [actFeedback, setActFeedback] = useState<{ tone: FeedbackTone; message: string; id?: number } | null>(null);
  const { ask: askBookAgain, dialog: bookAgainDialog } = useBookAgain();
  const feedbackSeq = useRef(0);
  const [moreBusy, setMoreBusy] = useState(false);
  // The multi-select: the ticked Vorschläge (by action id), a run in flight, each row's part, the confirm.
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());
  const [batchRunning, setBatchRunning] = useState(false);
  const [rowStatus, setRowStatus] = useState<ReadonlyMap<string, VorschlagStatus>>(new Map());
  const [confirmOpen, setConfirmOpen] = useState(false);
  // Rows on their way out (D204 Arrive and leave): drawn fading until the re-read drops them.
  const [leaving, setLeaving] = useState<ReadonlySet<string>>(new Set());
  // C4: the Mahnlauf whose issue waits on its confirm (the row's button opened it; nothing is sent yet).
  const [issueConfirm, setIssueConfirm] = useState<{ item: Item; option: DecisionOption } | null>(null);
  // Repeated unassigned payments of one Bankkonto read as one row; opened on request.
  const [openGroups, setOpenGroups] = useState<ReadonlySet<string>>(new Set());
  // D207: the Vorschläge whose details are open (a click on the row), and the ones showing their rule confirm.
  const [openRows, setOpenRows] = useState<ReadonlySet<string>>(new Set());
  // The rule each asking row confirms, with its slot as read before anything was booked (critic D207 F3).
  const [ruleAsk, setRuleAsk] = useState<ReadonlyMap<string, RulePlan>>(new Map());
  // Critic D208 (MEDIUM-1): an open line whose star met a rule it was not shown: asked by name, then committed again.
  // `slot` null: the D210 ask of `attention.auto_rule_confirm = always` before the open row's star, under the shown slot.
  const [lineAsk, setLineAsk] = useState<ReadonlyMap<string, { v: LineCommit; slot: { id: string; name: string } | null; replaces: string | null }>>(new Map());
  // D207: a rule that did not save after its booking landed, said in place with its retry.
  const [pendingRules, setPendingRules] = useState<readonly PendingRule[]>([]);
  const [ruleBusy, setRuleBusy] = useState(false);
  // The rule the last one-click saved, so Rückgängig can remove exactly it.
  const [undoRule, setUndoRule] = useState<string | null>(null);
  // D208 point 10: the bank line the last approval booked, so its confirmation can offer Rückgängig.
  const [undoLine, setUndoLine] = useState<string | null>(null);
  const autoRuleConfirm = useAutoRuleConfirm(workspaceId);
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
    const res = await client.call('attention_list', { workspaceId: ws, grouping: 'by_kind', limit: PAGE_LIMIT });
    if (activeWs.current !== ws) return; // a switch overtook this answer: discard it.
    const parsed = isErr(res.body) ? null : parseGrouped(res.body);
    if (parsed === null) {
      setFailed(true);
      setLoading(false);
      return;
    }
    setData(parsed);
    setLeaving(new Set());
    setSelected(-1);
    setLoading(false);
    const digest = await client.call('autobook_digest', { workspaceId: ws });
    if (activeWs.current === ws) setWaiting(isErr(digest.body) ? [] : parseWaiting(digest.body));
  }, [client, workspaceId]);

  // A workspace switch clears the previous client's data BEFORE the new arrives (design story 6.1).
  useEffect(() => {
    activeWs.current = workspaceId;
    setData(null);
    setSelected(-1);
    setActFeedback(null);
    setBusyKey(null);
    setTicked(new Set());
    setRowStatus(new Map());
    setBatchRunning(false);
    setConfirmOpen(false);
    setIssueConfirm(null);
    setOpenGroups(new Set());
    setOpenRows(new Set());
    setRuleAsk(new Map());
    setPendingRules([]);
    setUndoRule(null);
    setUndoLine(null);
    // Critic D207 F4: a rule save of the previous workspace never locks the new one's icons.
    setRuleBusy(false);
    setLeaving(new Set());
    setSearch('');
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

  /** The next page of every section that has more rows, appended in place. */
  const loadMore = useCallback(async () => {
    if (workspaceId === null || data === null) return;
    const ws = workspaceId;
    const open = data.sections.filter((s) => s.nextCursor !== undefined);
    if (open.length === 0) return;
    setMoreBusy(true);
    const pages = await Promise.all(
      open.map((s) => client.call('attention_list', { workspaceId: ws, grouping: 'by_kind', limit: PAGE_LIMIT, section: s.key, cursor: s.nextCursor })),
    );
    if (activeWs.current !== ws) return;
    setMoreBusy(false);
    let sections = data.sections;
    let missed = false;
    pages.forEach((res, i) => {
      const parsed = isErr(res.body) ? null : parseGrouped(res.body);
      const page = parsed?.sections.find((s) => s.key === open[i]?.key);
      if (page === undefined) missed = true;
      else sections = appendPage(sections, page);
    });
    if (missed) setActFeedback({ tone: 'error', message: t('attention.error.more') });
    setData((current) => (current === null ? current : { ...current, sections }));
  }, [client, data, t, workspaceId]);

  /**
   * One verb call. The approval is named here by its own name: it is the act the batch commit replays
   * (the accent guard holds the commit to the approval this surface calls).
   */
  const send = useCallback(
    (verb: string, body: Record<string, unknown>) => (verb === 'approve_drafted_action' ? client.call('approve_drafted_action', body) : client.call(verb, body)),
    [client],
  );

  /**
   * One act on one row: the option's verb with exactly the input the engine declared and the human
   * confirmation where the verb takes one. A decided Vorschlag leaves (fade and collapse), then the list
   * re-reads; a refusal keeps the row and says why. `sendOverride` makes the call when the caller names the
   * verb itself (the Mahnlauf's confirmed issue).
   */
  const act = useCallback(
    async (
      item: Item,
      option: DecisionOption,
      reason?: string,
      sendOverride?: (input: Record<string, unknown>) => Promise<RestResponse>,
      onLanded?: () => Promise<void>,
    ) => {
      if (workspaceId === null || option.verb === null || busyKey !== null || batchRunning) return;
      const ws = workspaceId;
      const rowKey = keyOf(item);
      setBusyKey(rowKey);
      setActFeedback(null);
      const input = {
        workspaceId: ws,
        ...option.input,
        ...(option.humanConfirm ? { confirmed: true } : {}),
        ...(reason !== undefined && reason !== '' ? { reason } : {}),
      };
      const verb = option.verb;
      const call = (body: Record<string, unknown>) => (sendOverride !== undefined ? sendOverride(body) : send(verb, body));
      const res = await call(input);
      if (activeWs.current !== ws) return;
      setBusyKey(null);
      const landed = async () => {
        setActFeedback({ tone: 'success', message: t(`attention.act.done.${option.id}`), id: ++feedbackSeq.current });
        setUndoRule(null);
        setUndoLine(null);
        announceAttentionChanged();
        if (isVorschlag(item)) {
          setLeaving(new Set([rowKey]));
          setTicked((current) => new Set([...current].filter((id) => id !== item.entityId)));
          await wait(leaveMs());
          if (activeWs.current !== ws) return;
        }
        // D207: the booking landed; only now is the Buchungsregel saved from it.
        if (onLanded !== undefined) await onLanded();
        if (activeWs.current !== ws) return;
        await load();
      };
      if (isErr(res.body)) {
        const code = res.body.error;
        // N02 R1: approving would book a receipt a second time: the person confirms, and the same approval
        // is sent again with it.
        const asked =
          verb === 'approve_drafted_action' &&
          askBookAgain(res.body, async (confirmation) => {
            const again = await call({ ...input, ...confirmation });
            if (activeWs.current !== ws) return null;
            if (isErr(again.body)) {
              if (again.body.error !== 'holders_changed') return again.body;
              setActFeedback({ tone: 'error', message: refusalText(t, again.body, ACT_WORDING) });
              void load();
            } else void landed();
            return null;
          });
        if (asked) return;
        setActFeedback({ tone: 'error', message: refusalText(t, res.body, ACT_WORDING) });
        if (['not_found', 'already_applied', 'already_executed', 'gap_not_found', 'vorschlag_stale', 'holders_changed', 'offer_stale'].includes(code)) void load();
        return;
      }
      await landed();
    },
    [askBookAgain, batchRunning, busyKey, load, send, t, workspaceId],
  );

  const allItems = useMemo(() => (data?.sections ?? []).flatMap((s) => s.items), [data]);

  // D167: the Vorschlag lines read the drafted payloads (Details) and the dial, once per list.
  const agentIds = allItems.filter(isVorschlag).map((i) => i.entityId).join(',');
  const anyStale = allItems.some((i) => isVorschlag(i) && i.stale);
  const [drafted, setDrafted] = useState<ReadonlyMap<string, VorschlagItem>>(new Map());
  useEffect(() => {
    setDrafted(new Map());
    if (agentIds === '' || workspaceId === null) return;
    const ws = workspaceId;
    let live = true;
    void (async () => {
      const statuses = anyStale ? ['pending', 'stale'] : ['pending'];
      const answers = await Promise.all(statuses.map((status) => client.call('list_drafted_actions', { workspaceId: ws, status })));
      if (!live || activeWs.current !== ws) return;
      const rows = answers.flatMap((res) => (isErr(res.body) ? [] : parseVorschlaege(res.body).items));
      setDrafted(new Map(rows.map((a) => [a.actionId, a])));
    })();
    return () => {
      live = false;
    };
  }, [agentIds, anyStale, client, workspaceId]);
  const accountNames = useAccountNames(agentIds !== '');
  // D208: the open bank lines, the rules, the chart and the codes the calm rows read, once for the list.
  const lineCtx = useLineContext(agentIds !== '', workspaceId, `${agentIds}|${data?.computedAt ?? ''}`);
  const rowSettings = useAttentionSettings(workspaceId);
  const attachReceipt = useAttachReceipt(workspaceId);
  // ONE key per click of the open line's commit, kept for that click's retry (DESIGN.md D153).
  const lineKeys = useRef(new Map<string, LineKeys>());
  // D208 point 10 (`attention.undo_seconds`): Rückgängig stays in the confirmation for that long, then goes.
  useEffect(() => {
    if (undoLine === null && undoRule === null) return undefined;
    const timer = setTimeout(() => {
      setUndoLine(null);
      setUndoRule(null);
    }, rowSettings.undoSeconds * 1000);
    return () => clearTimeout(timer);
  }, [undoLine, undoRule, rowSettings.undoSeconds]);

  const mode = data?.approvalBatchMode ?? 'tick';
  const own = useCallback((item: Item) => item.proposedBy !== undefined && whoami !== null && item.proposedBy === whoami.actor, [whoami]);

  /** A Vorschlag the batch may approve: the ENGINE marked it batchable, the person may, it is not theirs, unchanged. */
  const batchApprovable = useCallback(
    (item: Item) =>
      mode !== 'single' &&
      isVorschlag(item) &&
      item.batchable &&
      canDecide &&
      item.changedSinceProposal !== true &&
      !item.stale &&
      !own(item) &&
      (item.decisionOptions ?? []).some((o) => o.id === 'approve' && o.verb === 'approve_drafted_action'),
    [canDecide, mode, own],
  );
  /** A Vorschlag the person may reject (every Vorschlag but their own, while the engine offers the reject). */
  const rejectable = useCallback(
    (item: Item) => isVorschlag(item) && canDecide && !item.stale && !own(item) && (item.decisionOptions ?? []).some((o) => o.id === 'reject' && o.verb === 'reject_drafted_action'),
    [canDecide, own],
  );
  // D202: a settings Vorschlag is decided one at a time in its row (one click each), never through the box.
  const selectable = useCallback((item: Item) => item.settingChange === undefined && (batchApprovable(item) || rejectable(item)), [batchApprovable, rejectable]);

  /** A Vorschlag in words, as the line says it: the counterparty leads, then the drafted thing's own text. */
  const vorschlagTitle = (row: Item): string => {
    if (row.settingChange !== undefined) {
      const c = row.settingChange;
      const loc = locale === 'en' ? 'en' : 'de-CH';
      const title =
        c.from[loc] === ''
          ? t('attention.settingChange.titleTo', { setting: c.label[loc], to: c.to[loc] })
          : t('attention.settingChange.title', { setting: c.label[loc], from: c.from[loc], to: c.to[loc] });
      return c.widensAgent ? `${title}. ${t('attention.settingChange.widens')}` : title;
    }
    if (row.ruleProposal !== undefined) return t('attention.ruleProposed.title', { counterparty: row.ruleProposal.counterparty, repeats: row.ruleProposal.repeats });
    if (row.autobookOffer !== undefined) return t('attention.autobookOffer.title', { counterparty: row.autobookOffer.label ?? row.autobookOffer.counterparty, count: row.autobookOffer.cleanUses });
    const d = drafted.get(row.entityId);
    const text = d !== undefined && typeof d.payload.text === 'string' && d.payload.text !== '' ? d.payload.text : null;
    const counterparty = typeof row.subtitleParams?.counterparty === 'string' ? row.subtitleParams.counterparty : '';
    if (counterparty !== '') return text !== null && text !== counterparty ? t('attention.vorschlag.titleWith', { counterparty, thing: text }) : counterparty;
    const line = d?.lineFacts ?? null;
    return text ?? line?.counterparty ?? line?.text ?? verbLabel(t, String(row.subtitleParams?.tool ?? '')) ?? itemTitle(t, row);
  };

  /** What the live search reads of a row: its title, its facts and its amount, lower case. */
  const searchTextOf = (item: Item): string => {
    const parts = [isVorschlag(item) ? vorschlagTitle(item) : itemTitle(t, item), itemSubtitle(t, item) ?? '', String(item.subtitleParams?.target ?? '')];
    if (item.amountMinor !== undefined && item.currency !== undefined) parts.push(formatMoney(item.amountMinor, item.currency));
    return parts.join(' ').toLowerCase();
  };

  // THE FILTERS. Each narrows; a facet's counts are taken over the rows the OTHER filters leave.
  const query = search.trim().toLowerCase();
  const toolOf = (item: Item): string => String(item.subtitleParams?.tool ?? '') || (drafted.get(item.entityId)?.actionTool ?? '');
  // D208: the chips Alle / Bank / Vorschläge / Erledigen pick the section.
  const matches = (item: Item, skip: 'kind' | 'area' | 'actor' | null) =>
    (skip === 'kind' || filters.sections.length === 0 || filters.sections.includes(sectionOf(item, toolOf(item)))) &&
    (skip === 'area' || filters.area === null || item.area === filters.area) &&
    (skip === 'actor' || filters.actor === null || actorOf(item) === filters.actor) &&
    (query === '' || searchTextOf(item).includes(query));
  const visible = allItems.filter((i) => matches(i, null));
  // D204 Arrive and leave: rows a filter or a decision adds or removes glide; the neighbours follow.
  // D207: the three sections, each its own list, so Arrive and leave plays inside each.
  const bySection = (key: SectionKey) => visible.filter((i) => sectionOf(i, toolOf(i)) === key);
  const bankRows = bySection('bank');
  const otherRows = bySection('other');
  const todoRows = bySection('todo');
  const bankListRef = useRef<HTMLUListElement>(null);
  const otherListRef = useRef<HTMLUListElement>(null);
  const todoListRef = useRef<HTMLUListElement>(null);
  useArriveLeave(bankListRef, [...pendingRules.map((r) => `rule:${r.bankTxnId}`), ...bankRows.map(keyOf)]);
  useArriveLeave(otherListRef, otherRows.map(keyOf));
  useArriveLeave(todoListRef, todoRows.map(keyOf));
  const filtered = query !== '' || filters.sections.length > 0 || filters.area !== null || filters.actor !== null;
  const clearFilters = () => {
    setSearch('');
    setFilters(NO_FILTERS);
  };

  const forSections = allItems.filter((i) => matches(i, 'kind'));
  const sectionCounts = new Map<SectionKey, number>(
    SECTION_KEYS.map((k) => [k, forSections.filter((i) => sectionOf(i, toolOf(i)) === k).reduce((n, i) => n + i.count, 0)]),
  );
  // DESIGN.md rule 2: a chip only where it changes the list (some rows of that section, not all); a chosen one stays.
  const sectionsShown = SECTION_KEYS.filter((k) => filters.sections.includes(k) || ((sectionCounts.get(k) ?? 0) > 0 && forSections.some((i) => sectionOf(i, toolOf(i)) !== k)));
  const allCount = forSections.reduce((n, i) => n + i.count, 0);

  const facetOptions = (key: 'area' | 'actor', values: readonly string[], label: (v: string) => string) => {
    const base = allItems.filter((i) => matches(i, key));
    const valueOf = (i: Item) => (key === 'area' ? i.area : actorOf(i));
    return values
      .filter((v) => filters[key] === v || (base.some((i) => valueOf(i) === v) && base.some((i) => valueOf(i) !== v)))
      .map((v) => ({ value: v, label: label(v) }));
  };
  const areas = [...new Set(allItems.map((i) => i.area).filter((a) => a !== ''))];
  const facets: FilterFacet[] = [
    { key: 'area', label: t('attention.filter.area'), options: facetOptions('area', areas, (v) => t(`attention.area.${v}`)), value: filters.area, onChange: (v: string | null) => setFilters({ ...filters, area: v }) },
    {
      key: 'actor',
      label: t('attention.filter.actorLabel'),
      options: facetOptions('actor', ['agent', 'till'], (v) => t(`attention.filter.actors.${v}`)),
      value: filters.actor,
      onChange: (v: string | null) => setFilters({ ...filters, actor: v === 'agent' || v === 'till' ? v : null }),
    },
  ]
    .filter((f) => f.options.length > 0 || f.value !== null)
    .map((f) => ({ ...f, options: f.options.length === 1 ? f.options.map((o) => ({ ...o, label: `${f.label}: ${o.label}` })) : f.options }));

  // THE SELECTION acts on visible rows only: a tick the filters hide, or a row that left, drops out.
  const visibleSelectable = visible.filter(selectable);
  const visibleIds = visibleSelectable.map((i) => i.entityId).join(',');
  useEffect(() => {
    const present = new Set(visibleIds === '' ? [] : visibleIds.split(','));
    setTicked((current) => {
      const next = new Set([...current].filter((id) => present.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [visibleIds]);
  const tickedRows = visibleSelectable.filter((i) => ticked.has(i.entityId));
  const toApprove = tickedRows.filter(batchApprovable);
  const toReject = tickedRows.filter(rejectable);

  /** The one press of the bar: ONE batch call, then the outcomes per id. */
  const runBatch = useCallback(
    async (rows: readonly Item[], verb: 'approve_drafted_actions' | 'reject_drafted_actions') => {
      if (workspaceId === null || rows.length === 0 || batchRunning || busyKey !== null) return;
      const ws = workspaceId;
      const ids = rows.map((r) => r.entityId);
      setBatchRunning(true);
      setActFeedback(null);
      setConfirmOpen(false);
      const runningText = t(verb === 'approve_drafted_actions' ? 'attention.batch.running' : 'attention.batch.rejecting');
      setRowStatus(new Map(ids.map((id) => [id, { tone: 'running' as const, text: runningText }])));
      const res = await client.call(verb, { workspaceId: ws, ids });
      if (activeWs.current !== ws) return;
      if (isErr(res.body)) {
        // The whole call refused (a setting, a missing right): nothing ran, the selection stays.
        setBatchRunning(false);
        setRowStatus(new Map());
        setActFeedback({ tone: 'error', message: refusalText(t, res.body, ACT_WORDING) });
        return;
      }
      const { done, failed: refused } = parseBatchAnswer(res.body, ids);
      const causes = new Map(
        refused.map((f) => [f.id, { tone: 'error' as const, text: f.refusal.error === 'vorschlag_stale' ? t('attention.vorschlag.staleShort') : refusalText(t, f.refusal, ACT_WORDING) }]),
      );
      setRowStatus(causes);
      setTicked(new Set(refused.map((f) => f.id)));
      const doneSet = new Set(done);
      setLeaving(new Set(rows.filter((r) => doneSet.has(r.entityId)).map(keyOf)));
      const word = verb === 'approve_drafted_actions' ? 'done' : 'rejected';
      setActFeedback({
        tone: refused.length === 0 ? 'success' : 'warn',
        message: refused.length === 0 ? t(`attention.batch.${word}All`, { count: done.length }) : t(`attention.batch.${word}Some`, { ok: done.length, refused: refused.length }),
        id: ++feedbackSeq.current,
      });
      if (done.length > 0) {
        announceAttentionChanged();
        await wait(leaveMs());
        if (activeWs.current !== ws) return;
        await load();
        if (activeWs.current !== ws) return;
      }
      setBatchRunning(false);
      // Focus: the first refused row's box when it is still there.
      requestAnimationFrame(() => {
        const first = refused.map((r) => boxRefs.current.get(r.id)).find((el) => el !== null && el !== undefined);
        first?.focus();
      });
    },
    [batchRunning, busyKey, client, load, t, workspaceId],
  );

  /** Roving selection over every row: arrows move, Home/End jump (design story 8.1). */
  const onListKeyDown = (event: ReactKeyboardEvent) => {
    const last = focusCount.current - 1;
    if (last < 0) return;
    const target = event.target as HTMLElement | null;
    if (target !== null && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
    // Critic D208 (5): a control that used the key (the open line's Selects) keeps it; the rows do not move.
    if (event.defaultPrevented || (target !== null && target.closest('.pl-open, [role="combobox"]') !== null)) return;
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

  const header = (actions?: ReactNode, count?: number) => (
    <SurfaceHeader title={t('attention.title')} titleId="att-title" count={count} help={<SurfaceHelp surface="Attention" />} actions={actions} />
  );

  if (workspaceId === null) return <NoWorkspaceState />;
  if (loading && data === null) {
    return (
      <section className="att" aria-labelledby="att-title">
        {header()}
        <div role="status" aria-busy="true" aria-live="polite" className="att-skeleton">
          <span className="att-sr">{t('attention.loading')}</span>
          <Skeleton rows={1} />
          <Skeleton rows={6} />
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

  /** D208: no lead glyph on a row; the empty box slot keeps every title on one edge with the Vorschlag rows. */
  const plainLead = (_item: Item) => <span className="att-lead-box" />;

  /** A Vorschlag's date as the line ends with it: the bank line's booking date, else the proposal's. */
  const vorschlagDate = (item: Item): string | null => {
    const date = String(item.subtitleParams?.date ?? '') || item.since;
    return /^\d{4}-\d{2}-\d{2}/.test(date) ? formatDate(date.slice(0, 10)) : null;
  };

  /** The row's subject where Pendenzen knows better than the drafted read; else the shared row's own. */
  const rowTitleOf = (item: Item): string | undefined => {
    if (item.ruleProposal !== undefined || item.autobookOffer !== undefined || item.settingChange !== undefined) return vorschlagTitle(item);
    if (typeof item.subtitleParams?.counterparty === 'string' && item.subtitleParams.counterparty !== '') return vorschlagTitle(item);
    return drafted.has(item.entityId) ? undefined : vorschlagTitle(item);
  };

  const hasLineFacts = (item: Item): boolean => typeof item.subtitleParams?.date === 'string' && item.subtitleParams.date !== '';

  /** D197: the row's facts in the ONE shared row: the signed amount, what it books onto, the date. */
  const vorschlagFacts = (item: Item): Partial<RowFacts> => {
    const facts: Partial<RowFacts> = {};
    const d0 = drafted.get(item.entityId);
    if (d0 === undefined || businessDate(d0) === null) {
      const lineDate = typeof item.subtitleParams?.date === 'string' && /^\d{4}-\d{2}-\d{2}/.test(item.subtitleParams.date) ? item.subtitleParams.date : null;
      if (lineDate !== null) {
        facts.date = formatDate(lineDate.slice(0, 10));
        facts.dateIsProposal = false;
      } else if (d0 === undefined) {
        const date = vorschlagDate(item);
        if (date !== null) {
          facts.date = date;
          facts.dateIsProposal = true;
        }
      }
    }
    if (item.amountMinor !== undefined && item.currency !== undefined) {
      facts.amountMinor = item.amountMinor;
      facts.currency = item.currency;
    }
    facts.certainty = d0?.certainty ?? null;
    const r = item.ruleProposal;
    if (r !== undefined) {
      facts.kind = t('attention.ruleProposed.backtest', { date: formatDate(r.since), hits: r.hits, identical: r.identical });
      return facts;
    }
    const o = item.autobookOffer;
    if (o !== undefined) {
      facts.kind = t('attention.autobookOffer.meta', { ceiling: formatMoney(o.ceilingMinor, o.currency), currency: o.currency });
      return facts;
    }
    if (hasLineFacts(item)) {
      const target = String(item.subtitleParams?.target ?? '');
      const kindKey = item.subtitleParams?.targetKind === 'ignore' ? undefined : TARGET_KIND_KEY[String(item.subtitleParams?.targetKind ?? '')];
      const what = target !== '' ? target : kindKey !== undefined ? t(kindKey) : verbLabel(t, String(item.subtitleParams?.tool ?? ''));
      if (what !== '') facts.kind = what;
    } else if (item.scheduledByAgent === true) {
      facts.kind = t('attention.vorschlag.scheduledByAgent');
    }
    return facts;
  };

  /** N03 (D183): a mined Buchungsregel's line: its words, and Details lead with the bookings it was found in. */
  const ruleLineProps = (r: RuleProposal) => ({
    approveLabel: t('attention.ruleProposed.create'),
    rejectLabel: t('attention.ruleProposed.dismiss'),
    extraDetails: r.evidence.map((e, i) => ({
      key: `__evidence${i}`,
      label: t('attention.ruleProposed.evidence'),
      value: t('attention.ruleProposed.evidenceValue', { date: formatDate(e.date.slice(0, 10)), amount: formatMoney(Math.abs(e.amountMinor), e.currency) }),
    })),
  });

  const itemClass = (item: Item, extra = '') => ['att-item', extra, leaving.has(keyOf(item)) ? 'att-item--leaving' : ''].filter(Boolean).join(' ');

  /**
   * D207: what saving the rule came to, said once. Saved: "Gebucht. Regel gespeichert." with Rückgängig. The
   * same rule already there, or a rule replaced: said so, without Rückgängig (it would remove a rule this click
   * did not make, or not bring the old one back). Refused: the row's place in Bankbuchungen keeps it with retry.
   */
  const sayRule = (outcome: RuleOutcome, line: RulePlan) => {
    if (outcome.kind === 'failed') {
      const { refusal: _old, reconfirm: _again, ...plan } = line as PendingRule;
      setPendingRules((current) => [...current.filter((r) => r.bankTxnId !== line.bankTxnId), { ...plan, refusal: outcome.refusal }]);
      setActFeedback(null);
      setUndoRule(null);
      return;
    }
    setPendingRules((current) => current.filter((r) => r.bankTxnId !== line.bankTxnId));
    setUndoRule(outcome.kind === 'saved' ? outcome.standardId : null);
    setActFeedback({ tone: 'success', message: t(outcome.kind === 'saved' ? 'attention.autoRule.done' : `attention.autoRule.${outcome.kind}`), id: ++feedbackSeq.current });
  };

  /** D207, one click: the approval exactly as Freigeben sends it, and once it landed, the rule from the booking. */
  const automate = (item: Item, approve: DecisionOption, plan: RulePlan) => {
    const ws = workspaceId;
    void act(item, approve, undefined, undefined, async () => {
      setRuleBusy(true);
      const outcome = await saveRuleFromBooking(client, ws, plan);
      if (activeWs.current !== ws) return;
      setRuleBusy(false);
      sayRule(outcome, plan);
    });
  };

  const dropLineAsk = (id: string) =>
    setLineAsk((current) => {
      if (!current.has(id)) return current;
      const next = new Map(current);
      next.delete(id);
      return next;
    });

  const askRule = (id: string, plan: RulePlan | null) =>
    setRuleAsk((current) => {
      const next = new Map(current);
      if (plan === null) next.delete(id);
      else next.set(id, plan);
      return next;
    });

  /**
   * The third icon: read the slot first (critic D207 F3). A rule standing there is always confirmed by name;
   * otherwise the setting decides (failing closed, F2). A slot that cannot be read books nothing.
   */
  const startAutomate = async (item: Item, approve: DecisionOption, plan: RulePlan) => {
    if (ruleBusy || busyKey !== null || batchRunning) return;
    const ws = workspaceId;
    setRuleBusy(true);
    const slot = await readRuleSlot(client, ws, plan.bankTxnId, t);
    if (activeWs.current !== ws) return;
    setRuleBusy(false);
    if (!slot.ok) {
      setActFeedback({ tone: 'error', message: t('attention.autoRule.slotUnread'), id: ++feedbackSeq.current });
      return;
    }
    const pinned: RulePlan = { ...plan, expectSlotStandardId: slot.existing?.id ?? null, replaces: slot.existing?.name ?? null, idempotencyKey: newRuleKey(plan.bankTxnId) };
    if (autoRuleConfirm !== 'never' || slot.existing !== null) {
      setOpenRows((current) => toggleIn(current, item.entityId, true));
      askRule(item.entityId, pinned);
    } else automate(item, approve, pinned);
  };

  /** The retry of a rule that did not save: the booking stands, only the rule is tried again. */
  const retryRule = async (rule: PendingRule) => {
    if (ruleBusy) return;
    const ws = workspaceId;
    setRuleBusy(true);
    if (rule.refusal.error === 'rule_slot_changed') {
      // The same pin would refuse forever: read the slot again and let the person confirm what stands there now.
      const again = await repinAfterSlotChange(client, ws, rule, t);
      if (activeWs.current !== ws) return;
      setRuleBusy(false);
      if (again === null) {
        setActFeedback({ tone: 'error', message: t('attention.autoRule.slotUnread'), id: ++feedbackSeq.current });
        return;
      }
      setPendingRules((current) => current.map((r) => (r.bankTxnId === rule.bankTxnId ? { ...r, reconfirm: again } : r)));
      return;
    }
    // The same approved legs, never a re-read of the booking (critic D207 F1).
    const outcome = await saveRuleFromBooking(client, ws, rule);
    if (activeWs.current !== ws) return;
    setRuleBusy(false);
    sayRule(outcome, rule);
  };

  /** The confirm of a re-pinned rule: the save runs again under the new pin. */
  const confirmRepinned = async (plan: RulePlan) => {
    if (ruleBusy) return;
    const ws = workspaceId;
    setRuleBusy(true);
    const outcome = await saveRuleFromBooking(client, ws, plan);
    if (activeWs.current !== ws) return;
    setRuleBusy(false);
    sayRule(outcome, plan);
  };

  /** Rückgängig: the rule this click saved goes; the booking stays (it follows the normal reversal rules). */
  const undoSavedRule = async () => {
    if (undoRule === null || ruleBusy) return;
    const ws = workspaceId;
    const standardId = undoRule;
    setRuleBusy(true);
    const refusal = await clearSavedRule(client, ws, standardId);
    if (activeWs.current !== ws) return;
    setRuleBusy(false);
    setUndoRule(null);
    setActFeedback(
      refusal === null
        ? { tone: 'info', message: t('attention.autoRule.undone'), id: ++feedbackSeq.current }
        : { tone: 'error', message: t('attention.autoRule.undoFailed', { reason: ruleRefusalText(t, refusal) }), id: ++feedbackSeq.current },
    );
  };

  const toggleIn = (set: ReadonlySet<string>, key: string, on: boolean): ReadonlySet<string> => {
    const next = new Set(set);
    if (on) next.add(key);
    else next.delete(key);
    return next;
  };

  /** D208 point 10: Rückgängig of a booking the last approval made: the line is reopened (a reversal). */
  const undoBookedLine = async () => {
    if (undoLine === null || workspaceId === null || busyKey !== null) return;
    const ws = workspaceId;
    const bankTxnId = undoLine;
    setBusyKey(`undo:${bankTxnId}`);
    const res = await client.call('reopen_bank_line', { workspaceId: ws, bankTxnId, idempotencyKey: `d208-undo:${bankTxnId}:${crypto.randomUUID()}` });
    if (activeWs.current !== ws) return;
    setBusyKey(null);
    setUndoLine(null);
    setActFeedback(
      isErr(res.body)
        ? { tone: 'error', message: refusalText(t, res.body, ACT_WORDING), id: ++feedbackSeq.current }
        : { tone: 'info', message: t('attention.line.undone'), id: ++feedbackSeq.current },
    );
    announceAttentionChanged();
    await load();
  };

  /**
   * D208 point 4: the open line's commit. Nothing changed and no star: the row's own Freigeben (its refusals and
   * its book-again confirm stay). Otherwise `commitOpenLine`: the booking with the person's values, then the rule.
   */
  const commitLine = async (item: Item, action: VorschlagItem, v: LineCommit, rule: RuleInfo | null, shown: ShownSlot | { known: true; id: string | null }) => {
    if (workspaceId === null || busyKey !== null || batchRunning) return;
    const approve = (item.decisionOptions ?? []).find((o) => o.id === 'approve' && o.verb !== null);
    const bankTxnId = typeof action.payload.bankTxnId === 'string' ? action.payload.bankTxnId : null;
    const books = action.actionTool === 'book_bank_line' && bankTxnId !== null;
    if (!v.changed && !v.star) {
      if (approve !== undefined)
        void act(item, approve, undefined, undefined, async () => {
          if (books) setUndoLine(bankTxnId);
        });
      return;
    }
    const ws = workspaceId;
    const rowKey = keyOf(item);
    setBusyKey(rowKey);
    setActFeedback(null);
    const pin = !shown.known ? null : 'id' in shown ? shown.id : (shown.rule?.id ?? null);
    const keys = lineKeysFor(lineKeys.current, item.entityId, bankTxnId, v, pin, newRuleKey);
    const out = await commitOpenLine(client, ws, action, v, rule, shown, keys, t);
    if (activeWs.current !== ws) return;
    setBusyKey(null);
    if (out.kind === 'reconfirm') {
      setLineAsk((current) => new Map(current).set(item.entityId, { v, slot: out.slot, replaces: out.slot.name }));
      return;
    }
    if (out.kind === 'refused') {
      setActFeedback({ tone: 'error', message: out.refusal.error === 'slot_unread' ? t('attention.autoRule.slotUnread') : refusalText(t, out.refusal, ACT_WORDING), id: ++feedbackSeq.current });
      if (['not_found', 'already_executed', 'already_resolved', 'vorschlag_stale', 'line_not_open'].includes(out.refusal.error)) void load();
      return;
    }
    lineKeys.current.delete(item.entityId);
    const r = out.rule;
    const message =
      r === null
        ? t(v.changed ? 'attention.line.done.booked' : 'attention.act.done.approve')
        : r.kind === 'failed'
          ? t('attention.autoRule.failed', { reason: ruleRefusalText(t, r.refusal) })
          : r.kind === 'saved'
            ? t('attention.autoRule.done')
            : r.kind === 'noted'
              ? t('attention.line.done.noted')
              : t(`attention.autoRule.${r.kind}`);
    setActFeedback({ tone: r?.kind === 'failed' ? 'warn' : 'success', message, id: ++feedbackSeq.current });
    // The rule this click saved goes with Rückgängig (D207); otherwise the booking is reopened.
    setUndoRule(r?.kind === 'saved' ? r.standardId : null);
    setUndoLine(r?.kind === 'saved' || !out.booked ? null : out.bankTxnId);
    announceAttentionChanged();
    setLeaving(new Set([rowKey]));
    await wait(leaveMs());
    if (activeWs.current !== ws) return;
    await load();
  };

  /** The row's attach: the file is filed and assigned on THAT line (`assign_beleg_file`), then the hint goes. */
  const attachTo = async (bankTxnId: string, file: File) => {
    const ws = workspaceId;
    const outcome = await attachReceipt.attachAssign(bankTxnId, file);
    if (activeWs.current !== ws) return;
    setActFeedback(
      outcome.refusal !== null
        ? { tone: 'error', message: refusalText(t, outcome.refusal, ACT_WORDING), id: ++feedbackSeq.current }
        : { tone: 'success', message: t('attention.line.attached'), id: ++feedbackSeq.current },
    );
    lineCtx.reload();
  };

  const renderVorschlag = (item: Item, section: SectionKey) => {
    const index = nextFocus();
    const focus = focusProps(index);
    const options = item.decisionOptions ?? [];
    const option = (id: string) => options.find((o) => o.id === id && o.verb !== null);
    const recovery = options.find((o) => o.id === 'check_in_bank' && o.deepLink !== undefined);
    const rowKey = keyOf(item);
    const d = drafted.get(item.entityId);
    const action: VorschlagItem = {
      batchable: false,
      certainty: null,
      evidenceReasons: [],
      resolvedAt: null,
      resolvedBy: null,
      closureKind: null,
      ...(d ?? {}),
      ...vorschlagOf(item, d),
    };
    const approve = option('approve');
    const reject = option('reject');
    // D207: the one-click star only on a bank booking to accounts the person may approve.
    const counterparty = (typeof item.subtitleParams?.counterparty === 'string' && item.subtitleParams.counterparty !== '' ? item.subtitleParams.counterparty : null) ?? d?.lineFacts?.counterparty ?? vorschlagTitle(item);
    const plan = approve === undefined ? null : rulePlanOf(action, counterparty);
    const canAutomate = plan !== null;
    // D208: the row leads with the counterparty alone; the booking text follows it, dim.
    const lineDecision = BANK_LINE_TOOLS.has(toolOf(item)) && item.ruleProposal === undefined && item.autobookOffer === undefined;
    const titled = lineDecision && typeof item.subtitleParams?.counterparty === 'string' && item.subtitleParams.counterparty !== '' ? item.subtitleParams.counterparty : rowTitleOf(item);
    const facts: RowFacts = { ...rowFacts(t, locale, action, accountNames, titled), ...vorschlagFacts(item), certainty: null };
    const source = sourceOf(action, lineCtx);
    const bankTxnId = typeof action.payload.bankTxnId === 'string' ? action.payload.bankTxnId : null;
    const bookingDraft = action.actionTool === 'book_bank_line' && bankTxnId !== null;
    const hint = rowSettings.rowHints === 'missing' && missingBeleg(action, lineCtx);
    const leg = bookingDraft ? editableLeg(action) : null;
    // A text rule that proposed the line is the one the star adapts (critic D208, 6): a rule without text would stay shadowed.
    const rule = source?.kind === 'rule' ? source.rule : bookingDraft ? textRuleOf(action, lineCtx) : null;
    const slotRule = bookingDraft && rule === null ? slotRuleOf(action, lineCtx) : null;
    const shown = shownSlotOf(action, lineCtx);
    const draft = draftLegs(action);
    const keptSlot = rule === null && shown.known && shown.rule !== null && draft !== null && booksLike(shown.rule, draft) ? shown.rule : null;
    const extra = item.ruleProposal !== undefined ? ruleLineProps(item.ruleProposal).extraDetails : [];
    const openLine: OpenLineSpec =
      bookingDraft && bankTxnId !== null
        ? {
            text: prefillText(action),
            leg,
            chart: lineCtx.chart,
            taxCodes: lineCtx.taxCodes,
            incoming: (action.lineFacts?.amountMinor ?? item.amountMinor ?? 0) > 0,
            rule,
            ruleNote: rule?.note ?? keptSlot?.note ?? null,
            replaces: slotRule === null ? null : ruleWords(t, slotRule),
            starOffered: leg !== null && approve !== undefined,
            lineHref: `/bank?line=${encodeURIComponent(bankTxnId)}`,
            ruleHref: `/bank?${new URLSearchParams({ line: bankTxnId, rule: 'save' }).toString()}`,
            // D210: money in offers "Als Umsatz buchen": Bank's turnover presets for this line; Umsatz Regeln
            // only when the read KNOWS there is no template (still loading or refused: the line in Bank).
            turnoverHref:
              (action.lineFacts?.amountMinor ?? item.amountMinor ?? 0) > 0
                ? lineCtx.turnoverTemplates === false
                  ? '/umsatz?tab=regeln'
                  : `/bank?line=${encodeURIComponent(bankTxnId)}`
                : null,
            bankTxnId,
            onEdit: () => dropLineAsk(item.entityId),
            onCommit: (v) => {
              // D210 (critic r1 MEDIUM-2): the star is one click on the open row, so `attention.auto_rule_confirm`
              // asks first here too, failing closed as D207's one click does (anything but `never` asks).
              if (v.star && autoRuleConfirm !== 'never') {
                // Critic r2 LOW-2: the confirm names the rule the star changes: the adapted one, else the slot's.
                const named = rule ?? slotRule;
                setLineAsk((current) => new Map(current).set(item.entityId, { v, slot: null, replaces: named === null ? null : ruleWords(t, named) }));
                return;
              }
              setLineAsk((current) => {
                const next = new Map(current);
                next.delete(item.entityId);
                return next;
              });
              void commitLine(item, action, v, rule, shown);
            },
          }
        : {
            text: null,
            leg: null,
            chart: [],
            taxCodes: [],
            incoming: false,
            rule: null,
            starOffered: false,
            lineHref: item.ruleProposal !== undefined ? `/bank?${new URLSearchParams({ line: item.ruleProposal.bankTxnId, rule: 'save' }).toString()}` : recordRouteOf(action),
            ruleHref: null,
            bankTxnId: null,
            readback: [...extra.map((r) => r.value), ...readbackRows(t, locale, action, { accountNames, omit: ['text'] }).filter((r) => r.key !== '__proposed').map((r) => r.value)]
              .filter((x): x is string => typeof x === 'string' && x !== '')
              .join(' · '),
            onCommit: (v) => void commitLine(item, action, v, null, { known: false }),
          };
    const box = selectable(item) ? (
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
    ) : null;
    const asking = ruleAsk.get(item.entityId) ?? null;
    const lineAsking = lineAsk.get(item.entityId) ?? null;
    const locked = busyKey !== null || batchRunning || ruleBusy;
    const approveNow = () => {
      if (approve !== undefined)
        void act(item, approve, undefined, undefined, async () => {
          if (bookingDraft) setUndoLine(bankTxnId);
        });
    };
    return (
      <li key={rowKey} data-arrive-key={rowKey} data-row-section={section} className={itemClass(item, 'att-item--vorschlag')} data-row-count={item.count} aria-busy={busyKey === rowKey ? 'true' : undefined}>
        <PendenzLine
          action={action}
          facts={facts}
          source={source}
          hint={hint}
          {...(bankTxnId !== null && attachReceipt.canAttach ? { onAttach: (file: File) => void attachTo(bankTxnId, file) } : {})}
          box={box}
          busy={locked}
          offers={{ approve: approve !== undefined, reject: reject !== undefined }}
          onApprove={approveNow}
          onReject={() => {
            // D204: rejecting is one click and asks nothing.
            if (reject !== undefined) void act(item, reject);
          }}
          {...(canAutomate
            ? {
                onStar: () => {
                  if (approve !== undefined && plan !== null) void startAutomate(item, approve, plan);
                },
                starReplaces: slotRule === null ? null : ruleWords(t, slotRule),
              }
            : {})}
          {...(item.ruleProposal !== undefined ? { approveLabel: t('attention.ruleProposed.create'), rejectLabel: t('attention.ruleProposed.dismiss') } : {})}
          {...(item.autobookOffer !== undefined ? { approveLabel: t('attention.autobookOffer.grant'), rejectLabel: t('attention.autobookOffer.dismiss') } : {})}
          open={openRows.has(item.entityId)}
          onOpenChange={(on) => {
            setOpenRows((current) => toggleIn(current, item.entityId, on));
            if (!on) askRule(item.entityId, null);
            if (!on) dropLineAsk(item.entityId);
          }}
          openLine={openLine}
          {...(lineAsking !== null
            ? {
                detailSlot: (
                  <RuleConfirm
                    counterparty={counterparty}
                    accounts={[lineAsking.v.accountId === null ? '' : (accountNames.get(lineAsking.v.accountId) ?? ''), lineAsking.v.taxCode ?? ''].filter((x) => x !== '').join(' ')}
                    replaces={lineAsking.replaces}
                    busy={locked}
                    onConfirm={() => {
                      dropLineAsk(item.entityId);
                      void commitLine(item, action, lineAsking.v, rule, lineAsking.slot === null ? shown : { known: true, id: lineAsking.slot.id });
                    }}
                    onCancel={() => dropLineAsk(item.entityId)}
                  />
                ),
              }
            : {})}
          {...(lineAsking === null && asking !== null && canAutomate
            ? {
                detailSlot: (
                  <RuleConfirm
                    counterparty={counterparty}
                    accounts={accountsPhrase(t, action, accountNames, false) ?? ''}
                    replaces={asking.replaces}
                    busy={locked}
                    onConfirm={() => {
                      askRule(item.entityId, null);
                      if (approve !== undefined) automate(item, approve, asking);
                    }}
                    onCancel={() => askRule(item.entityId, null)}
                  />
                ),
              }
            : {})}
          status={rowStatus.get(item.entityId) ?? null}
          recovery={recovery?.deepLink !== undefined ? { label: t(recovery.labelKey), onClick: () => openLink(recovery.deepLink as { route: string; params: Record<string, string> }) } : null}
          staleText={t('attention.vorschlag.staleShort')}
          rowRef={focus.ref}
          rowTabIndex={focus.tabIndex}
          current={focus.current}
          onRowFocus={focus.onFocus}
          onRowKeyDown={(e, approveRow) => {
            // D208 point 10 (`attention.keys`): F freigeben, R ablehnen on the row in focus; the help says so.
            if (!rowSettings.keys || e.altKey || e.ctrlKey || e.metaKey || locked || !canDecide || own(item)) return;
            const key = e.key.toLowerCase();
            if (key === 'f' && approve !== undefined && item.changedSinceProposal !== true) {
              e.preventDefault();
              approveRow();
            } else if (key === 'r' && reject !== undefined) {
              e.preventDefault();
              void act(item, reject);
            }
          }}
        />
      </li>
    );
  };

  /** D207: a rule that did not save after its booking landed, in the Bankbuchungen section, with its retry. */
  const renderPendingRule = (rule: PendingRule) => (
    <li key={`rule:${rule.bankTxnId}`} data-arrive-key={`rule:${rule.bankTxnId}`} className="att-item att-item--rule" data-rule-retry={rule.bankTxnId}>
      <div className="att-row-line">
        <span className="att-lead" aria-hidden="true">
          <span className="att-lead-box" />
        </span>
        <div className="att-row-text" role="status">
          <span className="att-row-title att-row-title--text">{rule.counterparty}</span>
          <span className="att-row-meta">
            <span className="att-row-sub">{t('attention.autoRule.failed', { reason: ruleRefusalText(t, rule.refusal) })}</span>
          </span>
        </div>
        <div className="att-row-action">
          {rule.reconfirm === undefined && (
            <button type="button" className="btn btn--secondary btn--sm" disabled={ruleBusy} onClick={() => void retryRule(rule)}>
              {t('attention.autoRule.retry')}
            </button>
          )}
        </div>
      </div>
      {rule.reconfirm !== undefined && (
        <div className="vorschlag-line-details">
          <RuleConfirm
            counterparty={rule.counterparty}
            accounts={planAccountsWords(t, rule.reconfirm, accountNames)}
            replaces={rule.reconfirm.replaces}
            busy={ruleBusy}
            onConfirm={() => void confirmRepinned(rule.reconfirm as RulePlan)}
            onCancel={() => setPendingRules((current) => current.map((r) => (r.bankTxnId === rule.bankTxnId ? { ...r, reconfirm: undefined } : r)))}
          />
        </div>
      )}
    </li>
  );

  const renderRow = (item: Item, member = false) => {
    const index = nextFocus();
    const focus = focusProps(index);
    const rowKey = keyOf(item);
    return (
      <li key={rowKey} data-arrive-key={rowKey} className={itemClass(item, member ? 'att-item--member' : '')} {...(member ? { 'data-member': '' } : {})}>
        <AttentionRow
          item={item}
          lead={plainLead(item)}
          // D208 point 7: a missing statement is imported from the section heading's one Importieren glyph.
          hideLink={item.queueId === 'bank_statement_gap'}
          busy={busyKey === rowKey}
          locked={busyKey !== null || batchRunning}
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
        {item.autobookDigest !== undefined ? (
          <AutobookDigestLines
            digest={item.autobookDigest}
            busy={busyKey !== null || batchRunning}
            onAct={(option) => void act(item, option)}
            {...(item.autobookDigest.day === newestDigestDay ? { waiting } : {})}
          />
        ) : null}
      </li>
    );
  };

  /** Two or more unassigned payments of one Bankkonto read as ONE row ("4 Zahlungen ohne Zuordnung"). */
  const renderPaymentsGroup = (members: Item[]) => {
    const bank = String(members[0]?.subtitleParams?.bank ?? '');
    const key = `qr:${bank}`;
    const open = openGroups.has(key);
    const index = nextFocus();
    const focus = focusProps(index);
    const totals = batchTotalsOf(members);
    const count = members.reduce((n, m) => n + m.count, 0);
    const listId = `att-group-${key.replace(/\W+/g, '-')}`;
    const title = t('attention.group.payments', { count });
    return (
      <li key={key} data-arrive-key={key} className="att-item att-item--group" data-row-count={count}>
        <div className="att-row" data-queue="qr_match">
          <div className="att-row-line">
            <span className="att-lead" aria-hidden="true">
              {members[0] !== undefined ? plainLead(members[0]) : null}
            </span>
            <div className="att-row-text">
              <span className="att-row-title att-row-title--text">{title}</span>
              <span className="att-row-meta">
                {totals.perCurrency.map((c) => (
                  <span key={c.currency}>
                    <Amount minor={c.inMinor - c.outMinor} currency={c.currency} />
                    <span aria-hidden="true">{SEP}</span>
                  </span>
                ))}
                <span className="att-row-sub">{bank}</span>
              </span>
            </div>
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
            <span className="att-disclose-cell">
              <IconButton icon="info" small context={t('attention.group.info')} />
            </span>
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

  /** The visible rows: Vorschläge as Vorschlag lines, payments of one Bankkonto grouped, the rest one by one. */
  const renderRows = (rows: Item[], section: SectionKey) => {
    const out: ReactNode[] = [];
    let i = 0;
    while (i < rows.length) {
      const item = rows[i] as Item;
      if (isVorschlag(item)) {
        out.push(renderVorschlag(item, section));
        i += 1;
        continue;
      }
      if (item.queueId === 'qr_match' && item.entityKind !== 'attention_remainder') {
        const bank = String(item.subtitleParams?.bank ?? '');
        let j = i;
        while (j < rows.length && rows[j]?.queueId === 'qr_match' && String(rows[j]?.subtitleParams?.bank ?? '') === bank && rows[j]?.entityKind !== 'attention_remainder') j += 1;
        if (j - i >= 2) {
          out.push(renderPaymentsGroup(rows.slice(i, j)));
          i = j;
          continue;
        }
      }
      out.push(renderRow(item));
      i += 1;
    }
    return out;
  };

  /** What Freigeben does: the engine's consequence of each approved verb, then the selection's money. */
  const approveInfo = (rows: readonly Item[]): string => {
    const sentences = [
      ...new Set(
        rows
          .map((r) => {
            const v = vorschlagOf(r, drafted.get(r.entityId));
            return consequenceSentence(v.actionTool, locale, v.dialCapability);
          })
          .filter((x): x is string => x !== null && x !== ''),
      ),
    ];
    if (rows.length === 0) return sentences.join(' ');
    // Critic N4 R2-L1: the money is what the run BOOKS: only rows that post count; a line set aside is not
    // money. A row the engine gave no line facts is named apart.
    const sums = new Map<string, number>();
    for (const r of rows) if (r.posts && r.amountMinor !== undefined && r.currency !== undefined) sums.set(r.currency, (sums.get(r.currency) ?? 0) + r.amountMinor);
    const without = rows.filter((r) => r.amountMinor === undefined || r.currency === undefined).length;
    const amounts = [...sums.entries()].map(([currency, minor]) => formatMoney(minor, currency)).join(SEP);
    let summary =
      amounts === ''
        ? t('attention.batch.info.summaryNoAmount', { count: rows.length })
        : rows.length === 1
          ? t('attention.batch.info.summaryOne', { amounts })
          : t('attention.batch.info.summary', { count: rows.length, amounts });
    if (without > 0) summary = `${summary}. ${t('attention.batch.confirm.withoutAmount', { count: without })}`;
    return [...sentences, summary].join(' ');
  };

  const stand = data.computedAt !== '' ? t('attention.stand', { time: standTime(data.computedAt) }) : null;
  const remaining = data.sections.reduce((n, s) => (s.nextCursor === undefined ? n : n + s.count - s.items.reduce((m, i) => m + i.count, 0)), 0);
  const approveTotals = batchTotalsOf(toApprove);

  const page = (
    <section className="att" aria-labelledby="att-title">
      {header(
        <>
          {data.incomplete && <span className="att-incomplete">{t('attention.incomplete')}</span>}
          {/* The "Stand" time is the refresh control's tooltip: no line of its own. */}
          <IconButton icon="refresh" context={stand ?? t('attention.refresh')} name={t('attention.refresh')} className="att-refresh" small data-stand={stand ?? undefined} onClick={() => void load()} />
        </>,
        data.total ?? allItems.reduce((n, i) => n + i.count, 0),
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

      {bookAgainDialog}
      {actFeedback !== null && (
        <ActionFeedback
          key={actFeedback.id ?? 0}
          tone={actFeedback.tone}
          message={actFeedback.message}
          landed={actFeedback.tone === 'success'}
          onDismiss={() => {
            setActFeedback(null);
            setUndoRule(null);
            setUndoLine(null);
          }}
          dismissLabel={t('attention.act.dismissFeedback')}
        >
          {undoRule !== null && rowSettings.undoSeconds > 0 && (
            <button type="button" className="btn btn--ghost btn--sm att-rule-undo" disabled={ruleBusy} onClick={() => void undoSavedRule()}>
              {t('attention.autoRule.undo')}
            </button>
          )}
          {undoRule === null && undoLine !== null && rowSettings.undoSeconds > 0 && (
            <button type="button" className="btn btn--ghost btn--sm att-line-undo" disabled={busyKey !== null} onClick={() => void undoBookedLine()}>
              {t('attention.autoRule.undo')}
            </button>
          )}
        </ActionFeedback>
      )}

      {allItems.length === 0 && pendingRules.length === 0 ? (
        celebratory ? (
          <EmptyState title={t('attention.empty.title')} hint={t('attention.empty.hint')} action={{ label: t('attention.empty.action'), to: '/overview' }} />
        ) : (
          <p className="att-empty-partial">{t('attention.empty.hint')}</p>
        )
      ) : (
        <>
          <div className="att-filters">
            <FilterBar
              searchValue={search}
              onSearchChange={setSearch}
              searchLabel={t('attention.filter.search')}
              searchPlaceholder={t('attention.filter.searchPlaceholder')}
              facets={facets}
              active={filtered}
              onClear={clearFilters}
              clearLabel={t('attention.filter.clear')}
            >
              {sectionsShown.length > 0 ? (
                <FilterChips<SectionKey | 'all'>
                  label={t('attention.filter.kindLabel')}
                  chips={[
                    { value: 'all' as const, label: t('attention.filter.sections.all'), count: allCount },
                    ...sectionsShown.map((k) => ({ value: k, label: t(`attention.filter.sections.${k}`), count: sectionCounts.get(k) ?? 0 })),
                  ]}
                  selected={filters.sections.length === 0 ? ['all'] : filters.sections}
                  onChange={(next) => {
                    // Alle clears the choice; a section chip shows that section alone.
                    const added = next.find((v) => v === 'all' ? filters.sections.length > 0 : !filters.sections.includes(v));
                    const sections = added === undefined || added === 'all' ? [] : [added];
                    setFilters({ ...filters, sections: next.length === 0 ? [] : sections });
                  }}
                />
              ) : undefined}
            </FilterBar>
          </div>

          {visible.length === 0 && pendingRules.length === 0 ? (
            <EmptyState title={t('attention.filter.empty')} filtered={{ onClear: clearFilters, clearLabel: t('attention.filter.clear') }} />
          ) : (
            // eslint-disable-next-line jsx-a11y/no-static-element-interactions
            <div className="att-sections" onKeyDown={onListKeyDown}>
              {(['bank', 'other', 'todo'] as const).map((key) => {
                const rows = key === 'bank' ? bankRows : key === 'other' ? otherRows : todoRows;
                const extra = key === 'bank' ? pendingRules : [];
                if (rows.length === 0 && extra.length === 0) return null;
                const count = rows.reduce((n, i) => n + i.count, 0);
                const ref = key === 'bank' ? bankListRef : key === 'other' ? otherListRef : todoListRef;
                const headId = `att-section-${key}`;
                // D208: select-all sits in the section's own heading, never on a row of its own.
                const pickable = rows.filter(selectable);
                const allTicked = pickable.length > 0 && pickable.every((i) => ticked.has(i.entityId));
                const someTicked = !allTicked && pickable.some((i) => ticked.has(i.entityId));
                // D208 point 7: ONE Importieren in the Zu erledigen heading, in place of a button per gap.
                const gaps = key === 'todo' ? rows.filter((i) => i.queueId === 'bank_statement_gap') : [];
                const importLink = gaps.find((i) => i.deepLink.route !== '')?.deepLink;
                return (
                  <section key={key} className="att-section" data-section={key} aria-labelledby={headId}>
                    <div className="att-section-head">
                      <span className="att-lead-box">
                        {pickable.length > 0 && (
                          <input
                            type="checkbox"
                            className="att-batch-box"
                            aria-label={t(filtered || remaining > 0 ? 'attention.batch.selectSectionShown' : 'attention.batch.selectSection', { section: t(`attention.section.${key}`) })}
                            checked={allTicked}
                            ref={(el) => {
                              if (el !== null) el.indeterminate = someTicked;
                            }}
                            disabled={batchRunning}
                            onChange={(e) => {
                              const on = e.target.checked;
                              setTicked((current) => {
                                const next = new Set(current);
                                for (const i of pickable) {
                                  if (on) next.add(i.entityId);
                                  else next.delete(i.entityId);
                                }
                                return next;
                              });
                            }}
                          />
                        )}
                      </span>
                      <h2 className="att-section-title" id={headId}>
                        {t(`attention.section.${key}`)}
                        <span className="att-section-count t-num" aria-label={t('attention.section.count', { count })}>
                          {count}
                        </span>
                      </h2>
                      {importLink !== undefined && (
                        <span className="att-section-tools">
                          <IconButton
                            icon="import"
                            small
                            context={t('attention.section.importContext', { count: gaps.reduce((n, i) => n + i.count, 0) })}
                            onClick={() => openLink(importLink)}
                          />
                        </span>
                      )}
                    </div>
                    <ul ref={ref} className="att-list" aria-labelledby={headId}>
                      {extra.map(renderPendingRule)}
                      {renderRows(rows, key)}
                    </ul>
                  </section>
                );
              })}
              {remaining > 0 && (
                <button type="button" className="btn btn--secondary btn--sm att-more" disabled={moreBusy} onClick={() => void loadMore()}>
                  {t('attention.section.more', { count: remaining })}
                </button>
              )}
            </div>
          )}
        </>
      )}

      <SelectionDock
        count={tickedRows.length}
        approveCount={toApprove.length}
        rejectCount={toReject.length}
        // The money said beside the commits is what Freigeben would book (critic N4 R2-L1), never a set-aside.
        totals={batchTotalsOf(toApprove.filter((r) => r.posts))}
        books={toApprove.some((r) => r.posts)}
        quiet={issueConfirm !== null || confirmOpen}
        running={batchRunning}
        info={approveInfo(toApprove)}
        onApprove={() => {
          if (mode === 'all_with_confirm') setConfirmOpen(true);
          else void runBatch(toApprove, 'approve_drafted_actions');
        }}
        onReject={() => void runBatch(toReject, 'reject_drafted_actions')}
        onClear={() => {
          setTicked(new Set());
          setRowStatus(new Map());
        }}
      />

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
        books={toApprove.some((r) => r.posts)}
        count={toApprove.length}
        totals={approveTotals}
        verbs={[...new Set(toApprove.map((r) => String(r.subtitleParams?.tool ?? '')).filter((v) => v !== ''))]}
        onConfirm={() => void runBatch(toApprove, 'approve_drafted_actions')}
        onClose={() => setConfirmOpen(false)}
      />

      {/* D207: a filter narrows the WHOLE page; an event has no kind, area or sender, so it steps away. */}
      {!filtered && <EventsZone />}
    </section>
  );
  focusCount.current = flatIndex;
  // Every tooltip at the right edge goes to the overlay layer, so no tooltip ever widens the page on a phone.
  return <TooltipPortalContext.Provider value={true}>{page}</TooltipPortalContext.Provider>;
}

export default Attention;
