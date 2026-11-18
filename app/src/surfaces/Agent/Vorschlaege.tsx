/**
 * D197 (owner, 12.11.2026), the Vorschläge tab of /agent: LIST AND DETAIL, full width (the owner's pick
 * "B: Liste und Detail", over the audit `docs/critique/vorschlaege-ux-audit-2026-11-12.md`).
 *
 *  - THE LIST TYPE'S TOOLBAR (DESIGN.md "The seven screen types"): a Status control (Offen, Genehmigt,
 *    Abgelehnt, Veraltet: the history `list_drafted_actions` always served by `status` and the Studio never
 *    asked for), Suchen, the facets as removable chips and "+ Filter" (Art, Sicherheit, Richtung, Beleg; a
 *    facet whose count is 0 or equals the total is hidden, DESIGN.md rule 2), the count. While rows are
 *    ticked the selection bar takes the toolbar's place, so nothing below it moves.
 *  - THE LIST on the left: the ONE Vorschlag row Pendenzen shares (`VorschlagRow`), in the engine's order
 *    (oldest first) and never regrouped: the Geld/System headings and their flip at 21 rows are gone. The
 *    tick box sits only on a batchable row (the engine's `batchable`, honouring
 *    `attention.approval_batch_mode`), never pre-ticked. Nothing is selected on arrival (DESIGN.md rule 5).
 *    D201: "Freigeben (n)" and "Ablehnen (n)" are each ONE call of the batch verb (`approve_drafted_actions`,
 *    `reject_drafted_actions`), never a loop, and rejecting asks nothing (D204). Ids that fail stay ticked
 *    with their cause in the row.
 *  - THE DETAIL on the right (`VorschlagDetail`); an empty pane says nothing. At 760 px and below the
 *    detail replaces the list, with a way back.
 *  - A DECISION re-reads the list without reordering it, moves the focus (and the selection) to the next
 *    row, says its outcome in a transient toast that names the row (Rückgängig where the engine has one:
 *    an approved `ignore_bank_line` reopens through `reopen_bank_line`), and tells the rail badge
 *    (`announceAttentionChanged`).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';

import { useI18n } from '../../i18n';
import { useClient } from '../../lib/client-context';
import { isErr, type Err } from '../../lib/client';
import { useWorkspaceId } from '../../app/workspace';
import { useCan, useCapabilities } from '../../lib/capabilities';
import { ErrorBanner, Skeleton, refusalText } from '../../components/states';
import { Status } from '../../components/Status';
import { Segmented } from '../../components/Segmented';
import { FilterBar, type FilterFacet } from '../../components/FilterBar';
import { useBookAgain } from '../../components/BookAgain';
import { announceAttentionChanged } from '../Attention/attentionSummary';
import { BatchConfirm, batchTotalsOf, parseBatchAnswer } from '../Attention/Batch';
import { useDialLevels } from './useDialLevels';
import { useAccountNames } from './useAccountNames';
import { VorschlagRow, VorschlagSelectionBar } from './VorschlagRow';
import { VorschlagDetail } from './VorschlagDetail';
import { RejectControl } from './RejectControl';
import { DecisionToast, type ToastState } from './DecisionToast';
import { VORSCHLAG_STALE } from './model';
import { decidedByOf, parseVorschlaege, rowFacts, searchText, verbWords, type Certainty, type VorschlagItem, type VorschlagStatusKey } from './vorschlagView';
import './Vorschlaege.css';

/** At or below this width the detail replaces the list (the owner's narrow-window rule). */
export const NARROW_QUERY = '(max-width: 760px)';

const STATUSES: readonly VorschlagStatusKey[] = ['pending', 'executed', 'rejected', 'stale'];
const CERTAINTY_ORDER: readonly Certainty[] = ['check', 'open', 'learned', 'sure'];

interface Facets {
  kind: string | null;
  certainty: string | null;
  direction: string | null;
  beleg: string | null;
  decidedBy: string | null;
}

const NO_FACETS: Facets = { kind: null, certainty: null, direction: null, beleg: null, decidedBy: null };

function useNarrow(): boolean {
  const query = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(NARROW_QUERY).matches;
  const [narrow, setNarrow] = useState(query);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
    const mq = window.matchMedia(NARROW_QUERY);
    const on = () => setNarrow(mq.matches);
    on();
    mq.addEventListener?.('change', on);
    return () => mq.removeEventListener?.('change', on);
  }, []);
  return narrow;
}

export function Vorschlaege() {
  const { t, locale } = useI18n();
  const client = useClient();
  const workspaceId = useWorkspaceId();
  const whoami = useCapabilities().whoami;
  const canDecide = useCan('manage_agent_dial');
  const narrow = useNarrow();

  const [status, setStatus] = useState<VorschlagStatusKey>('pending');
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<Err | undefined>(undefined);
  const [items, setItems] = useState<VorschlagItem[]>([]);
  const [batchMode, setBatchMode] = useState<'tick' | 'single' | 'all_with_confirm'>('tick');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());
  const [search, setSearch] = useState('');
  const [facets, setFacets] = useState<Facets>(NO_FACETS);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<ToastState | null>(null);
  // The rows the open confirm would approve (`all_with_confirm`): every batchable row, or the ticked ones.
  const [confirmRows, setConfirmRows] = useState<readonly VorschlagItem[] | null>(null);
  // A batch's part per row (the judge): a refused row stays, ticked, with its reason under its subject.
  const [rowStatus, setRowStatus] = useState<ReadonlyMap<string, string>>(new Map());
  const toastSeq = useRef(0);
  const { ask: askBookAgain, dialog: bookAgainDialog } = useBookAgain();
  const dial = useDialLevels(true, toast?.id ?? 0);
  const accountNames = useAccountNames(items.length > 0);
  const rowRefs = useRef(new Map<string, HTMLButtonElement | null>());
  const listRef = useRef<HTMLDivElement | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const focusNext = useRef<string | null | 'list'>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null);

  // A decision belongs to the workspace it was made in (§H-TENANT in the DOM): the ref is the workspace on
  // screen NOW; an in-flight call still holds the one it began under.
  const activeWs = useRef(workspaceId);
  activeWs.current = workspaceId;

  const clearToast = useCallback(() => setToast(null), []);
  const say = useCallback((next: Omit<ToastState, 'id'>) => {
    toastSeq.current += 1;
    setToast({ ...next, id: toastSeq.current });
  }, []);

  const load = useCallback(async () => {
    if (workspaceId === null) return;
    const ws = workspaceId;
    const res = await client.call('list_drafted_actions', { workspaceId: ws, status });
    if (activeWs.current !== ws) return;
    if (isErr(res.body)) {
      setError(res.body);
      setState('error');
      return;
    }
    const answer = parseVorschlaege(res.body);
    setItems(answer.items);
    setBatchMode(answer.batchMode);
    setState('ready');
  }, [client, status, workspaceId]);

  // A workspace switch resets the surface (D153): selection, ticks, filters, the toast.
  useEffect(() => {
    setSelectedId(null);
    setTicked(new Set());
    setRowStatus(new Map());
    setSearch('');
    setFacets(NO_FACETS);
    setToast(null);
    setStatus('pending');
  }, [workspaceId]);

  useEffect(() => {
    setState('loading');
    setItems([]);
    setSelectedId(null);
    setTicked(new Set());
    void load();
  }, [load]);

  /** A row the batch may take: pending, the engine's batchable, the person may decide and did not draft it. */
  const tickable = useCallback(
    (item: VorschlagItem) =>
      batchMode !== 'single' && canDecide && item.status === 'pending' && item.batchable && item.changedSinceProposal !== true && (whoami === null || whoami.actor !== item.actor),
    [batchMode, canDecide, whoami],
  );
  const batchApprovable = tickable;

  const factsOf = useCallback((item: VorschlagItem) => rowFacts(t, locale, item, accountNames), [accountNames, locale, t]);

  // Search, then the facets (each facet narrows; the counts of its options are taken over the searched list).
  const searched = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q === '' ? items : items.filter((item) => searchText(t, locale, item, accountNames).includes(q));
  }, [accountNames, items, locale, search, t]);

  const valueOf = useCallback(
    (key: keyof Facets, item: VorschlagItem): string | null => {
      if (key === 'kind') return item.actionTool;
      if (key === 'certainty') return item.certainty;
      if (key === 'direction') return factsOf(item).direction;
      if (key === 'decidedBy') return decidedByOf(item);
      return (item.belege?.length ?? 0) > 0 ? 'with' : 'without';
    },
    [factsOf],
  );

  const visible = useMemo(
    () => searched.filter((item) => (Object.keys(facets) as (keyof Facets)[]).every((key) => facets[key] === null || valueOf(key, item) === facets[key])),
    [facets, searched, valueOf],
  );

  const facetDefs: FilterFacet[] = useMemo(() => {
    const total = searched.length;
    const optionsFor = (key: keyof Facets, label: (value: string) => string, order?: readonly string[]) => {
      const counts = new Map<string, number>();
      for (const item of searched) {
        const v = valueOf(key, item);
        if (v !== null) counts.set(v, (counts.get(v) ?? 0) + 1);
      }
      const values = order !== undefined ? order.filter((v) => counts.has(v)) : [...counts.keys()];
      // DESIGN.md rule 2: an option that would not change the list (0, or every row) is not offered.
      return values
        .filter((v) => facets[key] === v || ((counts.get(v) ?? 0) > 0 && (counts.get(v) ?? 0) < total))
        .map((v) => ({ value: v, label: label(v) }));
    };
    const defs: { key: keyof Facets; label: string; options: { value: string; label: string }[] }[] = [
      { key: 'kind', label: t('agent.vq.facet.kind'), options: optionsFor('kind', (v) => verbWords(t, v)) },
      { key: 'certainty', label: t('agent.vq.facet.certainty'), options: optionsFor('certainty', (v) => t(`agent.vq.certainty.${v}`), CERTAINTY_ORDER) },
      { key: 'direction', label: t('agent.vq.facet.direction'), options: optionsFor('direction', (v) => t(`agent.vq.direction.${v}`), ['in', 'out']) },
      { key: 'beleg', label: t('agent.vq.facet.beleg'), options: optionsFor('beleg', (v) => t(`agent.vq.beleg.${v}`), ['with', 'without']) },
      // D209: who decided, so the owner finds what the agent approved on their word (closed lists only).
      { key: 'decidedBy', label: t('agent.vq.facet.decidedBy'), options: optionsFor('decidedBy', (v) => t(`agent.vq.decidedBy.${v}`), ['ownerWord', 'agent', 'person']) },
    ];
    return defs
      .filter((d) => d.options.length > 0 || facets[d.key] !== null)
      .map((d) => ({
        key: d.key,
        label: d.label,
        // A facet with one option has no group heading in the menu, so its option names the facet itself.
        options: d.options.length === 1 ? d.options.map((o) => ({ ...o, label: `${d.label}: ${o.label}` })) : d.options,
        value: facets[d.key],
        onChange: (value: string | null) => setFacets((current) => ({ ...current, [d.key]: value })),
      }));
  }, [facets, searched, t, valueOf]);

  // A filter that hides the selected row hides its detail too: the pane never shows a row the list does not.
  const selected = visible.find((item) => item.actionId === selectedId) ?? null;
  const tickedItems = visible.filter((item) => ticked.has(item.actionId));

  // The focus after a decision lands on the next row (or the list) once the re-read rendered it.
  useEffect(() => {
    const target = focusNext.current;
    if (target === null) return;
    focusNext.current = null;
    if (target === 'list') listRef.current?.focus();
    else rowRefs.current.get(target)?.focus();
  });

  /** After a decision: the decided row leaves, the selection and the focus go to the next one. */
  const moveOn = useCallback(
    (decidedIds: readonly string[]) => {
      const gone = new Set(decidedIds);
      const index = visible.findIndex((item) => gone.has(item.actionId));
      const rest = visible.filter((item) => !gone.has(item.actionId));
      const next = rest[Math.min(Math.max(index, 0), rest.length - 1)] ?? null;
      if (status === 'pending') setItems((current) => current.filter((item) => !gone.has(item.actionId)));
      setTicked((current) => new Set([...current].filter((id) => !gone.has(id))));
      if (selectedId !== null && gone.has(selectedId)) setSelectedId(next?.actionId ?? null);
      focusNext.current = next?.actionId ?? 'list';
    },
    [selectedId, status, visible],
  );

  const subjectOf = useCallback((item: VorschlagItem) => factsOf(item).subject, [factsOf]);

  /** Rückgängig for an approved line set aside: the line reopens through `reopen_bank_line` (it posts nothing). */
  const undoFor = useCallback(
    (item: VorschlagItem): ToastState['undo'] => {
      if (item.actionTool !== 'ignore_bank_line' || typeof item.payload.bankTxnId !== 'string' || workspaceId === null) return undefined;
      const ws = workspaceId;
      const bankTxnId = item.payload.bankTxnId;
      return {
        label: t('agent.vq.toast.undo'),
        run: () =>
          void (async () => {
            const res = await client.call('reopen_bank_line', { workspaceId: ws, bankTxnId, reason: t('agent.vq.undoReason'), idempotencyKey: crypto.randomUUID() });
            if (activeWs.current !== ws) return;
            if (isErr(res.body)) say({ tone: 'warn', message: refusalText(t, res.body) });
            else say({ tone: 'info', message: t('agent.vq.toast.undone', { subject: subjectOf(item) }) });
            announceAttentionChanged();
            void load();
          })(),
      };
    },
    [client, load, say, subjectOf, t, workspaceId],
  );

  const decide = useCallback(
    async (item: VorschlagItem, verb: 'approve_drafted_action' | 'reject_drafted_action', opts: { allowFuture?: boolean; reason?: string } = {}) => {
      if (workspaceId === null || busy) return;
      const ws = workspaceId;
      setBusy(true);
      const send = (confirmation: Record<string, unknown> = {}) =>
        client.call(verb, {
          workspaceId: ws,
          actionId: item.actionId,
          ...(opts.allowFuture === true ? { allowFuture: true } : {}),
          ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
          ...confirmation,
        });
      const res = await send();
      setBusy(false);
      if (activeWs.current !== ws) return;
      const subject = subjectOf(item);
      const landed = () => {
        say(
          verb === 'approve_drafted_action'
            ? { tone: 'success', message: t('agent.vq.toast.approved', { subject }), undo: undoFor(item) }
            : { tone: 'info', message: t('agent.vq.toast.rejected', { subject }) },
        );
        announceAttentionChanged();
        moveOn([item.actionId]);
        void load();
      };
      if (!isErr(res.body)) {
        landed();
        return;
      }
      if (res.body.error === VORSCHLAG_STALE) {
        say({ tone: 'warn', message: t('agent.vq.toast.stale', { subject }) });
        void load();
        return;
      }
      if (res.body.error === 'holders_changed') {
        say({ tone: 'warn', message: t('agent.card.holdersChanged') });
        void load();
        return;
      }
      const asked =
        verb === 'approve_drafted_action' &&
        askBookAgain(res.body, async (confirmation) => {
          const again = await send({ ...confirmation });
          if (activeWs.current !== ws) return null;
          if (isErr(again.body)) {
            if (again.body.error === 'holders_changed') {
              say({ tone: 'warn', message: t('agent.card.holdersChanged') });
              void load();
              return null;
            }
            return again.body;
          }
          landed();
          return null;
        });
      if (asked) return;
      // A refusal claims no outcome: it says the engine's reason, and the row stays.
      say({ tone: 'warn', message: refusalText(t, res.body) });
    },
    [askBookAgain, busy, client, load, moveOn, say, subjectOf, t, undoFor, workspaceId],
  );

  /**
   * The batch: ONE call of the batch verb for every ticked row (D201), never a loop of single calls. The
   * engine runs each id as its own single act and answers per id: what went through leaves, what failed
   * stays ticked with its cause under its subject.
   */
  const runBatch = useCallback(
    async (rows: readonly VorschlagItem[], verb: 'approve_drafted_actions' | 'reject_drafted_actions') => {
      if (workspaceId === null || busy || rows.length === 0) return;
      const ws = workspaceId;
      const ids = rows.map((row) => row.actionId);
      setBusy(true);
      setConfirmRows(null);
      setRowStatus(new Map());
      const res = await client.call(verb, { workspaceId: ws, ids });
      if (activeWs.current !== ws) return;
      setBusy(false);
      if (isErr(res.body)) {
        // The whole call refused: nothing ran, the ticks stay.
        say({ tone: 'warn', message: refusalText(t, res.body) });
        return;
      }
      const { done, failed } = parseBatchAnswer(res.body, ids);
      const byId = new Map(rows.map((row) => [row.actionId, row]));
      const refused = failed.map((f) => ({ id: f.id, subject: subjectOf(byId.get(f.id) as VorschlagItem), reason: f.refusal.error === VORSCHLAG_STALE ? t('agent.vq.staleRow') : refusalText(t, f.refusal) }));
      setRowStatus(new Map(refused.map((r) => [r.id, r.reason])));
      setTicked(new Set(refused.map((r) => r.id)));
      const word = verb === 'approve_drafted_actions' ? 'approved' : 'rejected';
      say(
        refused.length === 0
          ? { tone: verb === 'approve_drafted_actions' ? 'success' : 'info', message: t(`agent.vq.toast.batch.${word}`, { count: done.length }) }
          : { tone: 'warn', message: t(`agent.vq.toast.batch.${word}Some`, { ok: done.length, refused: refused.length, subject: refused[0]?.subject ?? '', reason: refused[0]?.reason ?? '' }) },
      );
      announceAttentionChanged();
      moveOn(done);
      void load();
    },
    [busy, client, load, moveOn, say, subjectOf, t, workspaceId],
  );

  const onRowKey = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : event.key === 'Home' ? -Infinity : event.key === 'End' ? Infinity : 0;
    if (step === 0) return;
    event.preventDefault();
    const target = step === -Infinity ? 0 : step === Infinity ? visible.length - 1 : Math.min(Math.max(index + step, 0), visible.length - 1);
    const id = visible[target]?.actionId;
    if (id !== undefined) rowRefs.current.get(id)?.focus();
  };

  if (state === 'error') return <ErrorBanner error={error} context="read" onRetry={() => void load()} />;

  const totals = batchTotalsOf(tickedItems.map((item) => ({ amountMinor: item.lineFacts?.amountMinor, currency: item.lineFacts?.currency })));
  const tickedApprovable = tickedItems.filter(batchApprovable);
  const allRows = items.filter(batchApprovable);
  const filtered = search.trim() !== '' || Object.values(facets).some((v) => v !== null);
  const rovingId = visible.some((i) => i.actionId === focusedId) ? focusedId : (visible.find((i) => i.actionId === selectedId)?.actionId ?? visible[0]?.actionId ?? null);
  const showList = !narrow || selected === null;
  const showDetail = selected !== null;

  const toolbar =
    ticked.size > 0 ? (
      <div className="vq-toolbar vq-toolbar--selection" role="group" aria-label={t('agent.vq.selection')}>
        <VorschlagSelectionBar
          count={tickedItems.length}
          totals={totals}
          approveLabel={t('agent.vq.approveAll', { count: tickedApprovable.length })}
          primary
          running={busy}
          onApprove={() => (batchMode === 'all_with_confirm' ? setConfirmRows(tickedApprovable) : void runBatch(tickedApprovable, 'approve_drafted_actions'))}
          {...(tickedApprovable.length === 0 ? { commit: <></> } : {})}
          reject={
            <RejectControl
              triggerLabel={t('agent.vq.rejectAll', { count: tickedItems.length })}
              context={t('agent.vq.rejectContext')}
              busy={busy}
              onReject={() => void runBatch(tickedItems, 'reject_drafted_actions')}
            />
          }
          onClear={() => setTicked(new Set())}
        />
      </div>
    ) : (
      <div className="vq-toolbar">
        <Segmented<VorschlagStatusKey>
          label={t('agent.vq.statusLabel')}
          className="vq-status"
          options={STATUSES.map((s) => ({ value: s, label: t(`agent.vq.tab.${s}`) }))}
          value={status}
          onChange={(next) => {
            setStatus(next);
            setFacets(NO_FACETS);
          }}
        />
        {/* DESIGN.md "Lists": the count stands beside what it counts, never orphaned at the far edge. */}
        <span className="vq-count t-num" aria-label={state === 'ready' ? t('agent.vq.count', { count: visible.length }) : undefined}>
          {state === 'ready' ? visible.length : ''}
        </span>
        <FilterBar
          searchValue={search}
          onSearchChange={setSearch}
          searchLabel={t('agent.vq.search')}
          searchPlaceholder={t('agent.vq.searchPlaceholder')}
          facets={facetDefs}
          onClear={() => {
            setSearch('');
            setFacets(NO_FACETS);
          }}
          clearLabel={t('agent.vq.clearFilters')}
        />
        {batchMode === 'all_with_confirm' && status === 'pending' && allRows.length > 0 && (
          <button type="button" className="btn btn--secondary btn--sm" disabled={busy} onClick={() => setConfirmRows(allRows)}>
            {t('agent.vq.approveAll', { count: allRows.length })}
          </button>
        )}

      </div>
    );

  // The toolbar stays while a status loads, so the Status control never leaves under the pointer.
  const list = (
    <div className="vq-list" ref={listRef} tabIndex={-1} aria-label={t('agent.vq.listLabel')}>
      {state === 'loading' ? (
        <Skeleton rows={6} height={36} />
      ) : visible.length === 0 ? (
        <div className="vq-empty">
          <p>{filtered ? t('agent.vq.filteredEmpty') : status === 'pending' ? t('agent.queue.empty') : t('agent.vq.emptyOther')}</p>
          {filtered && (
            <button
              type="button"
              className="btn btn--secondary btn--sm"
              onClick={() => {
                setSearch('');
                setFacets(NO_FACETS);
              }}
            >
              {t('agent.vq.clearFilters')}
            </button>
          )}
        </div>
      ) : (
        <ul className="vq-rows">
          {visible.map((item, index) => {
            const facts = factsOf(item);
            const box =
              batchMode === 'tick' && tickable(item) ? (
                <label className="vq-check">
                  <input
                    type="checkbox"
                    aria-label={t('agent.vq.tickRow', { subject: facts.subject })}
                    checked={ticked.has(item.actionId)}
                    disabled={busy}
                    onChange={(e) => {
                      const on = e.target.checked;
                      setTicked((current) => {
                        const next = new Set(current);
                        if (on) next.add(item.actionId);
                        else next.delete(item.actionId);
                        return next;
                      });
                    }}
                  />
                </label>
              ) : null;
            return (
              <li key={item.actionId}>
                <VorschlagRow
                  actionId={item.actionId}
                  facts={facts}
                  lead={box}
                  stale={item.changedSinceProposal === true}
                  {...(rowStatus.has(item.actionId) ? { status: <Status kind="warn" label={rowStatus.get(item.actionId) as string} /> } : {})}
                  selected={item.actionId === selectedId}
                  onSelect={() => setSelectedId(item.actionId)}
                  mainRef={(el) => {
                    rowRefs.current.set(item.actionId, el);
                  }}
                  mainTabIndex={item.actionId === rovingId ? 0 : -1}
                  onMainFocus={() => setFocusedId(item.actionId)}
                  onMainKeyDown={(e) => onRowKey(e, index)}
                />
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );

  return (
    <div className={['vq', narrow ? 'vq--narrow' : '', selected !== null ? 'vq--detail' : ''].filter(Boolean).join(' ')}>
      {bookAgainDialog}
      {toolbar}
      <div className="vq-body">
        {showList && list}
        {showDetail && selected !== null && (
          <div className="vq-detail">
            <VorschlagDetail
              key={selected.actionId}
              item={selected}
              dial={dial}
              accountNames={accountNames}
              busy={busy}
              sameFamilyCount={items.filter((i) => i.status === 'pending' && i.dialCapability === selected.dialCapability).length}
              headingRef={headingRef}
              onApprove={(allowFuture) => void decide(selected, 'approve_drafted_action', { allowFuture })}
              onReject={(reason) => void decide(selected, 'reject_drafted_action', reason !== undefined ? { reason } : {})}
              {...(narrow
                ? {
                    onBack: () => {
                      const id = selected.actionId;
                      setSelectedId(null);
                      focusNext.current = id;
                    },
                  }
                : {})}
            />
          </div>
        )}
      </div>
      <BatchConfirm
        open={confirmRows !== null}
        books={(confirmRows ?? []).some((r) => r.actionTool === 'book_bank_line')}
        count={(confirmRows ?? []).length}
        totals={batchTotalsOf((confirmRows ?? []).map((item) => ({ amountMinor: item.lineFacts?.amountMinor, currency: item.lineFacts?.currency })))}
        verbs={[...new Set((confirmRows ?? []).map((r) => r.actionTool))]}
        onConfirm={() => void runBatch(confirmRows ?? [], 'approve_drafted_actions')}
        onClose={() => setConfirmRows(null)}
      />
      <DecisionToast toast={toast} onDone={clearToast} />
    </div>
  );
}
