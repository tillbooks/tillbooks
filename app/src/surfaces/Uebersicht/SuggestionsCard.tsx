/**
 * D201 pick B (owner, 15.11.2026): the agent's suggestions as a CARD in the Übersicht's grid, placed first
 * and over the whole row by default, moved, hidden and resized like every other item (`overview.tiles`,
 * id `suggestions`). It replaced the "Wartet auf dich" list (`AttentionStrip`, kept behind the setting
 * `overview.waiting_list`).
 *
 * WHAT IT SHOWS. The open Vorschläge (`list_drafted_actions`, status `pending`), one line each, drawn by the
 * ONE Vorschlag row of /agent and Pendenzen (`VorschlagRow`, D197 point 4, imported as it is): the subject,
 * the accounts it books, the date and the signed amount. Freigeben and Ablehnen sit in the row (DESIGN.md
 * "What the agent proposes"), and Ablehnen is one click that asks nothing (D204: nobody types a reason).
 * The head carries the count; at most five rows show, and "Alle ansehen" opens Pendenzen for the rest.
 *
 * D207 (owner, 16.11.2026): the card draws the SAME line as Pendenzen (`VorschlagLine`): a click on a row opens
 * its details below, three icons named with one word each (Freigeben, "Freigeben und künftig automatisch" on a
 * bank booking to accounts, Ablehnen), no overflow menu. The one click approves, then saves the Buchungsregel
 * from the booked line, exactly as Pendenzen does (`../Attention/autoRule.tsx`), and the card says what came of
 * the rule in one line under its head (Rückgängig, or the reason and Erneut versuchen). Account names resolve
 * through the shared chart read, which also knows an account named by its number (`useAccountNames`).
 *
 * D208 (owner, 18.11.2026): the card draws the calm row of Pendenzen (`../Attention/PendenzLine`): one line, the
 * source glyph, the plus of incoming money, a click opens one line to change the booking text, the account and
 * the MWST code, the star keeps it as a Buchungsregel. No frame: the card is its heading on the page ground, no
 * radius, no border, no rule between rows.
 *
 * Rows are acted on where they appear: a decided row leaves at once with the Arrive and leave moment, and
 * the hub, the rail count and this card read again (`announceAttentionChanged`). A refused act claims no
 * outcome: the row stays and says the engine's reason under its subject.
 *
 * STATES. Loading: a skeleton of three rows. Denied: the padlock. Failed: the read error with a retry.
 * Nothing open: one calm line (`overview.suggestions_empty = line`, the default); with `hide` the page
 * drops the card from the grid instead. A workspace switch resets everything (D153).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

import { useClient } from '../../lib/client-context';
import { isErr } from '../../lib/client';
import { useArriveLeave } from '../../lib/motion';
import { useI18n } from '../../i18n';
import { Status } from '../../components/Status';
import { ActionFeedback } from '../../components/ActionFeedback';
import { AgentMarkGlyph, ChevronRightGlyph } from '../../components/icons';
import type { ReactNode } from 'react';
import { ErrorBanner, PermissionDenied, Skeleton, refusalText, useSkeletonHold } from '../../components/states';
import { parseVorschlaege, recordRouteOf, rowFacts, type VorschlagItem } from '../Agent/vorschlagView';
import { accountsPhrase, readbackRows } from '../Agent/vorschlagDetails';
import { PendenzLine, type LineCommit, type OpenLineSpec } from '../Attention/PendenzLine';
import { booksLike, draftLegs, editableLeg, missingBeleg, prefillText, ruleWords, shownSlotOf, slotRuleOf, sourceOf, textRuleOf, useLineContext, type RuleInfo, type ShownSlot } from '../Attention/lineContext';
import { commitOpenLine, lineKeysFor, type LineKeys } from '../Attention/openLineCommit';
import { useAttentionSettings } from '../Attention/useAttentionSettings';
import { useAccountNames } from '../Agent/useAccountNames';
import { ATTENTION_CHANGED_EVENT, announceAttentionChanged } from '../Attention/attentionSummary';
import { RuleConfirm, clearSavedRule, newRuleKey, planAccountsWords, readRuleSlot, repinAfterSlotChange, rulePlanOf, ruleRefusalText, saveRuleFromBooking, useAutoRuleConfirm, type RuleOutcome, type RulePlan } from '../Attention/autoRule';
import type { Err } from '../../lib/client';
import './SuggestionsCard.css';

/** How many suggestions the card lists; "Alle ansehen" opens the rest in Pendenzen. */
export const SUGGESTION_ROWS = 5;

export type SuggestionsLoad =
  | { state: 'loading' }
  | { state: 'error'; denied: boolean }
  | { state: 'ready'; items: VorschlagItem[] };

/**
 * The open suggestions of the workspace on screen, read once and again whenever anything announces an
 * attention change (an act here, in Pendenzen or on /agent). A refresh is quiet: the rows stay until the
 * next answer lands. An answer that started under another workspace is dropped (D153).
 */
export function useSuggestions(workspaceId: string | null): [SuggestionsLoad, () => void] {
  const client = useClient();
  const [load, setLoad] = useState<SuggestionsLoad>({ state: 'loading' });
  const active = useRef(workspaceId);
  active.current = workspaceId;
  const seq = useRef(0);

  const read = useCallback(async () => {
    if (workspaceId === null) return;
    const ws = workspaceId;
    seq.current += 1;
    const mine = seq.current;
    const res = await client.call('list_drafted_actions', { workspaceId: ws, status: 'pending' });
    if (active.current !== ws || seq.current !== mine) return;
    if (isErr(res.body)) {
      setLoad({ state: 'error', denied: res.body.error === 'permission_denied' });
      return;
    }
    setLoad({ state: 'ready', items: parseVorschlaege(res.body).items.filter((item) => item.status === 'pending') });
  }, [client, workspaceId]);

  useEffect(() => {
    setLoad({ state: 'loading' });
    void read();
  }, [read]);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const onChange = () => void read();
    window.addEventListener(ATTENTION_CHANGED_EVENT, onChange);
    return () => window.removeEventListener(ATTENTION_CHANGED_EVENT, onChange);
  }, [read]);

  return [load, useCallback(() => void read(), [read])];
}

type Verb = 'approve_drafted_action' | 'reject_drafted_action';

/** What the card says about the last rule the one click tried to save. */
type RuleNote =
  | { kind: 'saved'; standardId: string }
  | { kind: 'unchanged' | 'replaced' | 'undone' }
  | { kind: 'failed'; plan: RulePlan; refusal: Err; reconfirm?: RulePlan }
  | { kind: 'undoFailed'; refusal: Err };

/** The counterparty a bank booking names, for the rule confirm. */
function counterpartyOf(item: VorschlagItem): string {
  return item.lineFacts?.counterparty ?? (typeof item.payload.text === 'string' ? item.payload.text : '');
}

export function SuggestionsCard({
  load,
  reload,
  workspaceId,
  tools,
}: {
  load: SuggestionsLoad;
  reload: () => void;
  workspaceId: string;
  /** D208 point 2: the card's own tools (Ausblenden, Grösse ändern, Mehr), square in its heading, shown on hover. */
  tools?: ReactNode;
}) {
  const { t, locale } = useI18n();
  const client = useClient();
  // D207: the chart is read as soon as the card is on the page, whatever the list holds, so a line never
  // waits on it (an empty-then-filled list read it late and said "Konto" meanwhile).
  const accountNames = useAccountNames(true);
  const autoRuleConfirm = useAutoRuleConfirm(workspaceId);
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  // The rule each asking row confirms, its slot read before anything was booked (critic D207 F3).
  const [asking, setAsking] = useState<ReadonlyMap<string, RulePlan>>(new Map());
  // Critic D208 (MEDIUM-1): an open line whose star met a rule it was not shown: asked by name, then committed again.
  // `slot` null: the D210 ask of `attention.auto_rule_confirm` before the open row's star, under the shown slot.
  const [lineAsk, setLineAsk] = useState<ReadonlyMap<string, { v: LineCommit; slot: { id: string; name: string } | null; replaces: string | null }>>(new Map());
  const dropLineAsk = (id: string) =>
    setLineAsk((cur) => {
      if (!cur.has(id)) return cur;
      const next = new Map(cur);
      next.delete(id);
      return next;
    });
  const [ruleNote, setRuleNote] = useState<RuleNote | null>(null);
  // Decided here and not yet gone from a fresh read: off the card at once.
  const [gone, setGone] = useState<ReadonlySet<string>>(new Set());
  const [refusals, setRefusals] = useState<ReadonlyMap<string, string>>(new Map());
  const active = useRef(workspaceId);
  active.current = workspaceId;
  const listRef = useRef<HTMLUListElement | null>(null);
  const settings = useAttentionSettings(workspaceId);
  const readyIds = load.state === 'ready' ? load.items.map((i) => i.actionId).join(',') : '';
  const lineCtx = useLineContext(readyIds !== '', workspaceId, readyIds);
  // D208 point 10: the bank line the last approval booked (Rückgängig reopens it), for attention.undo_seconds.
  const [undoLine, setUndoLine] = useState<string | null>(null);
  const [lineNote, setLineNote] = useState<{ tone: 'success' | 'error' | 'info' | 'warn'; message: string } | null>(null);
  const lineKeys = useRef(new Map<string, LineKeys>());
  useEffect(() => {
    if (undoLine === null) return undefined;
    const timer = setTimeout(() => setUndoLine(null), settings.undoSeconds * 1000);
    return () => clearTimeout(timer);
  }, [undoLine, settings.undoSeconds]);

  // A workspace switch resets the card (D153).
  useEffect(() => {
    setBusy(null);
    setGone(new Set());
    setRefusals(new Map());
    setOpen(new Set());
    setAsking(new Map());
    setRuleNote(null);
    setUndoLine(null);
    setLineNote(null);
  }, [workspaceId]);

  const items = load.state === 'ready' ? load.items.filter((item) => !gone.has(item.actionId)) : [];
  const shown = items.slice(0, SUGGESTION_ROWS);
  useArriveLeave(listRef, shown.map((item) => item.actionId));
  const showSkeleton = useSkeletonHold(load.state === 'loading');

  /** One decision; `withRule` is the D207 one click: the rule is saved only once the booking landed. */
  const decide = useCallback(
    async (item: VorschlagItem, verb: Verb, plan: RulePlan | null = null) => {
      if (busy !== null) return;
      const ws = workspaceId;
      setBusy(item.actionId);
      if (verb === 'approve_drafted_action') setRuleNote(null);
      const res = await client.call(verb, { workspaceId: ws, actionId: item.actionId });
      if (active.current !== ws) return;
      if (isErr(res.body)) {
        setBusy(null);
        const reason = refusalText(t, res.body);
        setRefusals((m) => new Map(m).set(item.actionId, reason));
        if (res.body.error === 'vorschlag_stale') reload();
        return;
      }
      if (plan !== null) {
        const outcome: RuleOutcome = await saveRuleFromBooking(client, ws, plan);
        if (active.current !== ws) return;
        setRuleNote(outcome.kind === 'failed' ? { kind: 'failed', plan, refusal: outcome.refusal } : outcome);
      }
      setBusy(null);
      setRefusals((m) => {
        const next = new Map(m);
        next.delete(item.actionId);
        return next;
      });
      setGone((s) => new Set(s).add(item.actionId));
      if (verb === 'approve_drafted_action' && plan === null && item.actionTool === 'book_bank_line' && typeof item.payload.bankTxnId === 'string') {
        setUndoLine(item.payload.bankTxnId);
        setLineNote({ tone: 'success', message: t('attention.act.done.approve') });
      }
      announceAttentionChanged();
    },
    [busy, client, reload, t, workspaceId],
  );

  /** D208 point 4: the open line's commit (unchanged and no star: the plain Freigeben). */
  const commitLine = async (item: VorschlagItem, v: LineCommit, rule: RuleInfo | null, shown: ShownSlot | { known: true; id: string | null }) => {
    if (busy !== null) return;
    if (!v.changed && !v.star) {
      void decide(item, 'approve_drafted_action');
      return;
    }
    const ws = workspaceId;
    setBusy(item.actionId);
    setRuleNote(null);
    const bankTxnId = typeof item.payload.bankTxnId === 'string' ? item.payload.bankTxnId : null;
    const pin = !shown.known ? null : 'id' in shown ? shown.id : (shown.rule?.id ?? null);
    const keys = lineKeysFor(lineKeys.current, item.actionId, bankTxnId, v, pin, newRuleKey);
    const out = await commitOpenLine(client, ws, item, v, rule, shown, keys, t);
    if (active.current !== ws) return;
    setBusy(null);
    if (out.kind === 'reconfirm') {
      setLineAsk((cur) => new Map(cur).set(item.actionId, { v, slot: out.slot, replaces: out.slot.name }));
      return;
    }
    if (out.kind === 'refused') {
      setRefusals((m) => new Map(m).set(item.actionId, out.refusal.error === 'slot_unread' ? t('attention.autoRule.slotUnread') : refusalText(t, out.refusal)));
      if (out.refusal.error === 'vorschlag_stale') reload();
      return;
    }
    lineKeys.current.delete(item.actionId);
    const r = out.rule;
    if (r !== null && r.kind === 'saved') setRuleNote({ kind: 'saved', standardId: r.standardId });
    else {
      setLineNote({
        tone: r?.kind === 'failed' ? 'warn' : 'success',
        message:
          r === null
            ? t(v.changed ? 'attention.line.done.booked' : 'attention.act.done.approve')
            : r.kind === 'failed'
              ? t('attention.autoRule.failed', { reason: ruleRefusalText(t, r.refusal) })
              : r.kind === 'noted'
                ? t('attention.line.done.noted')
                : t(`attention.autoRule.${r.kind}`),
      });
      if (out.booked) setUndoLine(out.bankTxnId);
    }
    setGone((g) => new Set(g).add(item.actionId));
    announceAttentionChanged();
  };

  /** Rückgängig of the booking: the line is reopened (a reversal, never an edit). */
  const undoBooked = async () => {
    if (undoLine === null || busy !== null) return;
    const ws = workspaceId;
    const bankTxnId = undoLine;
    setBusy(bankTxnId);
    const res = await client.call('reopen_bank_line', { workspaceId: ws, bankTxnId, idempotencyKey: `d208-undo:${bankTxnId}:${crypto.randomUUID()}` });
    if (active.current !== ws) return;
    setBusy(null);
    setUndoLine(null);
    setLineNote(isErr(res.body) ? { tone: 'error', message: refusalText(t, res.body) } : { tone: 'info', message: t('attention.line.undone') });
    announceAttentionChanged();
  };

  /** The retry of a rule that did not save: the booking stands, only the rule is tried again. */
  const retryRule = async (plan: RulePlan, refusal: Err | null = null) => {
    if (busy !== null) return;
    const ws = workspaceId;
    setBusy(plan.bankTxnId);
    if (refusal !== null && refusal.error === 'rule_slot_changed') {
      // The same pin would refuse forever: read the slot again; the person confirms what stands there now.
      const again = await repinAfterSlotChange(client, ws, plan, t);
      if (active.current !== ws) return;
      setBusy(null);
      setRuleNote(again === null ? { kind: 'failed', plan, refusal: { ok: false, error: 'slot_unread' } } : { kind: 'failed', plan, refusal, reconfirm: again });
      return;
    }
    // The same approved legs, never a re-read of the booking (critic D207 F1).
    const outcome = await saveRuleFromBooking(client, ws, plan);
    if (active.current !== ws) return;
    setBusy(null);
    setRuleNote(outcome.kind === 'failed' ? { kind: 'failed', plan, refusal: outcome.refusal } : outcome);
  };

  /** Rückgängig: the rule this click saved goes; the booking stays. */
  const undoRule = async (standardId: string) => {
    if (busy !== null) return;
    const ws = workspaceId;
    setBusy(standardId);
    const refusal = await clearSavedRule(client, ws, standardId);
    if (active.current !== ws) return;
    setBusy(null);
    setRuleNote(refusal === null ? { kind: 'undone' } : { kind: 'undoFailed', refusal });
  };

  const ask = (id: string, plan: RulePlan | null) =>
    setAsking((cur) => {
      const next = new Map(cur);
      if (plan === null) next.delete(id);
      else next.set(id, plan);
      return next;
    });

  /** The third icon: the slot first; a rule standing there is always confirmed by name (F3), else the setting (F2). */
  const startAutomate = async (item: VorschlagItem, plan: RulePlan) => {
    if (busy !== null) return;
    const ws = workspaceId;
    setBusy(item.actionId);
    const slot = await readRuleSlot(client, ws, plan.bankTxnId, t);
    if (active.current !== ws) return;
    setBusy(null);
    if (!slot.ok) {
      setRefusals((m) => new Map(m).set(item.actionId, t('attention.autoRule.slotUnread')));
      return;
    }
    const pinned: RulePlan = { ...plan, expectSlotStandardId: slot.existing?.id ?? null, replaces: slot.existing?.name ?? null, idempotencyKey: newRuleKey(plan.bankTxnId) };
    if (autoRuleConfirm !== 'never' || slot.existing !== null) {
      setOpen((cur) => toggle(cur, item.actionId, true));
      ask(item.actionId, pinned);
    } else void decide(item, 'approve_drafted_action', pinned);
  };

  const toggle = (set: ReadonlySet<string>, id: string, on: boolean): ReadonlySet<string> => {
    const next = new Set(set);
    if (on) next.add(id);
    else next.delete(id);
    return next;
  };

  const ruleLine = (() => {
    if (ruleNote === null) return null;
    const dismiss = { onDismiss: () => setRuleNote(null), dismissLabel: t('attention.act.dismissFeedback') };
    switch (ruleNote.kind) {
      case 'saved':
        return (
          <ActionFeedback tone="success" message={t('attention.autoRule.done')} {...dismiss}>
            {settings.undoSeconds > 0 && (
              <button type="button" className="btn btn--ghost btn--sm" disabled={busy !== null} onClick={() => void undoRule(ruleNote.standardId)}>
                {t('attention.autoRule.undo')}
              </button>
            )}
          </ActionFeedback>
        );
      case 'failed':
        return (
          <ActionFeedback tone="warn" message={t('attention.autoRule.failed', { reason: ruleRefusalText(t, ruleNote.refusal) })} {...dismiss}>
            {ruleNote.reconfirm === undefined ? (
              <button type="button" className="btn btn--ghost btn--sm" disabled={busy !== null} onClick={() => void retryRule(ruleNote.plan, ruleNote.refusal)}>
                {t('attention.autoRule.retry')}
              </button>
            ) : (
              <RuleConfirm
                counterparty={ruleNote.plan.counterparty}
                accounts={planAccountsWords(t, ruleNote.reconfirm, accountNames)}
                replaces={ruleNote.reconfirm.replaces}
                busy={busy !== null}
                onConfirm={() => void retryRule(ruleNote.reconfirm as RulePlan)}
                onCancel={() => setRuleNote({ kind: 'failed', plan: ruleNote.plan, refusal: ruleNote.refusal })}
              />
            )}
          </ActionFeedback>
        );
      case 'undoFailed':
        return <ActionFeedback tone="error" message={t('attention.autoRule.undoFailed', { reason: ruleRefusalText(t, ruleNote.refusal) })} {...dismiss} />;
      default:
        return <ActionFeedback tone={ruleNote.kind === 'undone' ? 'info' : 'success'} message={t(`attention.autoRule.${ruleNote.kind}`)} {...dismiss} />;
    }
  })();

  const lineLine =
    lineNote === null ? null : (
      <ActionFeedback tone={lineNote.tone} message={lineNote.message} onDismiss={() => {
        setLineNote(null);
        setUndoLine(null);
      }} dismissLabel={t('attention.act.dismissFeedback')}>
        {undoLine !== null && settings.undoSeconds > 0 && (
          <button type="button" className="btn btn--ghost btn--sm" disabled={busy !== null} onClick={() => void undoBooked()}>
            {t('attention.autoRule.undo')}
          </button>
        )}
      </ActionFeedback>
    );

  const count = load.state === 'ready' ? items.length : null;
  let body;
  if (load.state === 'loading') {
    body = showSkeleton ? <Skeleton rows={3} height={32} /> : <div className="uebersicht-widget__pending" aria-busy="true" />;
  } else if (load.state === 'error') {
    body = load.denied ? <PermissionDenied body={t('dashboard.suggestions.denied')} /> : <ErrorBanner context="read" message={t('dashboard.suggestions.error')} onRetry={reload} />;
  } else if (items.length === 0) {
    body = <Status kind="success" label={t('dashboard.suggestions.none')} className="uebersicht-sugg__none" />;
  } else {
    body = (
      <ul className="uebersicht-sugg__list" ref={listRef} aria-label={t('dashboard.suggestions.title')}>
        {shown.map((item) => {
          const plan = rulePlanOf(item, counterpartyOf(item));
          const canAutomate = plan !== null;
          const pinned = asking.get(item.actionId) ?? null;
          const refusal = refusals.get(item.actionId) ?? null;
          const facts = { ...rowFacts(t, locale, item, accountNames), certainty: null };
          const source = sourceOf(item, lineCtx);
          const bankTxnId = typeof item.payload.bankTxnId === 'string' ? item.payload.bankTxnId : null;
          const booking = item.actionTool === 'book_bank_line' && bankTxnId !== null;
          const leg = booking ? editableLeg(item) : null;
          // A text rule that proposed the line is the one the star adapts (critic D208, 6).
          const rule = source?.kind === 'rule' ? source.rule : booking ? textRuleOf(item, lineCtx) : null;
          const slotRule = booking && rule === null ? slotRuleOf(item, lineCtx) : null;
          const shownSlot = shownSlotOf(item, lineCtx);
          const draft = draftLegs(item);
          const keptSlot = rule === null && shownSlot.known && shownSlot.rule !== null && draft !== null && booksLike(shownSlot.rule, draft) ? shownSlot.rule : null;
          const lineAsking = lineAsk.get(item.actionId) ?? null;
          const openLine: OpenLineSpec =
            booking && bankTxnId !== null
              ? {
                  text: prefillText(item),
                  leg,
                  chart: lineCtx.chart,
                  taxCodes: lineCtx.taxCodes,
                  incoming: (item.lineFacts?.amountMinor ?? 0) > 0,
                  rule,
                  ruleNote: rule?.note ?? keptSlot?.note ?? null,
                  replaces: slotRule === null ? null : ruleWords(t, slotRule),
                  starOffered: leg !== null,
                  lineHref: `/bank?line=${encodeURIComponent(bankTxnId)}`,
                  ruleHref: `/bank?${new URLSearchParams({ line: bankTxnId, rule: 'save' }).toString()}`,
                  bankTxnId,
                  onEdit: () => dropLineAsk(item.actionId),
                  onCommit: (v) => {
                    // D210 (critic r1 MEDIUM-2, mirrored from Pendenzen): the open row's star is one click, so
                    // `attention.auto_rule_confirm` asks first, failing closed (anything but `never` asks).
                    if (v.star && autoRuleConfirm !== 'never') {
                      const named = rule ?? slotRule;
                      setLineAsk((cur) => new Map(cur).set(item.actionId, { v, slot: null, replaces: named === null ? null : ruleWords(t, named) }));
                      return;
                    }
                    dropLineAsk(item.actionId);
                    void commitLine(item, v, rule, shownSlot);
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
                  lineHref: recordRouteOf(item),
                  ruleHref: null,
                  bankTxnId: null,
                  readback: readbackRows(t, locale, item, { accountNames, omit: ['text'] })
                    .filter((r) => r.key !== '__proposed')
                    .map((r) => r.value)
                    .filter((x): x is string => typeof x === 'string' && x !== '')
                    .join(' · '),
                  onCommit: (v) => void commitLine(item, v, null, { known: false }),
                };
          return (
            <li key={item.actionId} className="uebersicht-sugg__row" data-arrive-key={item.actionId}>
              <PendenzLine
                action={item}
                facts={facts}
                source={source}
                hint={settings.rowHints === 'missing' && missingBeleg(item, lineCtx)}
                busy={busy !== null}
                status={refusal !== null ? { tone: 'error', text: refusal } : null}
                open={open.has(item.actionId)}
                onOpenChange={(on) => {
                  setOpen((cur) => toggle(cur, item.actionId, on));
                  if (!on) ask(item.actionId, null);
                  if (!on) dropLineAsk(item.actionId);
                }}
                openLine={openLine}
                {...(lineAsking !== null
                  ? {
                      detailSlot: (
                        <RuleConfirm
                          counterparty={counterpartyOf(item)}
                          accounts={[lineAsking.v.accountId === null ? '' : (accountNames.get(lineAsking.v.accountId) ?? ''), lineAsking.v.taxCode ?? ''].filter((x) => x !== '').join(' ')}
                          replaces={lineAsking.replaces}
                          busy={busy !== null}
                          onConfirm={() => {
                            dropLineAsk(item.actionId);
                            void commitLine(item, lineAsking.v, rule, lineAsking.slot === null ? shownSlot : { known: true, id: lineAsking.slot.id });
                          }}
                          onCancel={() => dropLineAsk(item.actionId)}
                        />
                      ),
                    }
                  : {})}
                onApprove={() => void decide(item, 'approve_drafted_action')}
                onReject={() => void decide(item, 'reject_drafted_action')}
                {...(canAutomate
                  ? {
                      onStar: () => {
                        if (plan !== null) void startAutomate(item, plan);
                      },
                      starReplaces: slotRule === null ? null : ruleWords(t, slotRule),
                    }
                  : {})}
                {...(lineAsking === null && canAutomate && pinned !== null
                  ? {
                      detailSlot: (
                        <RuleConfirm
                          counterparty={counterpartyOf(item)}
                          accounts={accountsPhrase(t, item, accountNames, false) ?? ''}
                          replaces={pinned.replaces}
                          busy={busy !== null}
                          onConfirm={() => {
                            ask(item.actionId, null);
                            void decide(item, 'approve_drafted_action', pinned);
                          }}
                          onCancel={() => ask(item.actionId, null)}
                        />
                      ),
                    }
                  : {})}
              />
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <section className="uebersicht-widget uebersicht-sugg" aria-labelledby="uebersicht-sugg-title">
      <header className="uebersicht-widget__head">
        <span className="uebersicht-widget__titlebar">
          <AgentMarkGlyph size={16} className="uebersicht-sugg__mark" aria-hidden="true" />
          <h2 id="uebersicht-sugg-title" className="uebersicht-widget__title">
            {t('dashboard.suggestions.title')}
          </h2>
          {count !== null && count > 0 ? (
            <span className="uebersicht-sugg__count t-num" aria-label={t('dashboard.suggestions.count', { count })}>
              {count}
            </span>
          ) : null}
        </span>
        <span className="uebersicht-widget__aside">
          {tools !== undefined && <span className="uebersicht-sugg__tools">{tools}</span>}
          {count !== null && count > 0 ? (
            <Link to="/attention" className="uebersicht-sugg__all">
              {count > SUGGESTION_ROWS ? t('dashboard.suggestions.allCount', { count }) : t('dashboard.suggestions.all')}
              <ChevronRightGlyph size={16} />
            </Link>
          ) : null}
        </span>
      </header>
      {ruleLine}
      {lineLine}
      {body}
    </section>
  );
}
