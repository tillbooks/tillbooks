/**
 * One checklist run: the whole journey in order with the current position marked, done rows compact,
 * the next open item carrying the single primary action (plan finding 8), and since leg 2 (D129 Q6,
 * design A) every open row opening INLINE with its body per kind (RowBodies.tsx): a choice with its
 * options and "Antwort speichern", a preview with its table and "Vorschau geprüft", a posting with
 * the domain verb behind the consequence confirm and "Rückgängig" through the owner verb, a
 * validation with its figures, formula and fix link (and "Zur Kenntnis nehmen" on a warn row), the
 * statements sign-off with the A08 totals and the hash it binds, the GV attestation with its date,
 * and the seal row with the consequence sentence identical to the Vorschlag card's and the reason it
 * is disabled while a block stands.
 *
 * The words per item kind (finding 1): a system check is `erfüllt`, an agent verb item `erledigt`, a
 * human attestation `bestätigt am ... durch ...`, a skipped item `nicht zutreffend`, a stale sign-off
 * `Freigabe hinfällig`, an excluded row `entfällt`. Check and probe keys are tooltips, never on-screen
 * text (finding 9). Item 8 of the MWST-Periode acts through `vat_mark_filed` on `/mwst` and, for an
 * actor without `vat_file`, renders disabled with the padlock reason, never hidden (finding 2).
 *
 * NOTHING HERE POSTS. Every domain verb goes out through `onAct` to the surface, which calls it under
 * its own gate; the row flips by derivation on the next read (spec §10.1).
 */
import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';

import { RunbookItemRow } from '../../components/RunbookItemRow';
import { Tooltip } from '../../components/Tooltip';
import { ConsequenceLine } from '../../components/ConsequenceLine';
import { useT, formatDate } from '../../i18n';
import { AttestDialog, ConfirmActDialog, GvDialog, ReasonDialog, SignoffDialog } from './Dialogs';
import { ChoiceBody, PostingBody, PreviewBody, StatementsBody, ValidationBody, settlementRowsOf, useMoney, type SettlementRow } from './RowBodies';
import {
  ATTEST_ITEM_ID,
  BANK_TYPED_ITEM_ID,
  EXPORT_ITEM_ID,
  SEAL_ITEM_ID,
  STATUTORY_ITEMS,
  autostartTemplateOf,
  knownKey,
  periodTitle,
  todayIso,
  type ItemView,
  type RunView,
} from './model';

/** One domain-verb call; `input` may depend on the previous call's body (create, then post). */
export interface ActCall {
  verb: string;
  input: Record<string, unknown> | ((previous: Record<string, unknown> | null) => Record<string, unknown>);
}

export interface Evidence {
  kind: string;
  ref?: string;
  reason?: string;
}

export interface RunDetailProps {
  run: RunView;
  workspaceId: string;
  canManage: boolean;
  canFile: boolean;
  canPost: boolean;
  canPeriods: boolean;
  working: boolean;
  /** The run's base currency, read off the reads that carry it. */
  currency: string;
  /** The refusal code of the last write, keyed by the item it targeted. */
  refusal: { itemId: string | null; code: string; detail: string | null } | null;
  onComplete: (itemId: string, evidence: Evidence | null) => void;
  onSkip: (itemId: string, reason: string) => void;
  onReopen: (itemId: string) => void;
  onAbandon: (reason: string) => void;
  onAct: (itemId: string, calls: ActCall[]) => void;
  onReload: () => void;
}

type Dialog =
  | { kind: 'attest'; item: ItemView }
  | { kind: 'gv'; item: ItemView }
  | { kind: 'skip'; item: ItemView }
  | { kind: 'signoff'; item: ItemView }
  | { kind: 'acknowledge'; item: ItemView }
  | { kind: 'act'; item: ItemView; title: string; body: ReactNode; verb: string; action: string; calls: ActCall[] }
  | { kind: 'abandon' }
  | null;

/** The verbs that need `manage_periods`; every other posting verb needs `post`. */
const PERIOD_VERBS = new Set(['lock_period', 'unlock_period', 'close_month', 'reopen_month', 'close_year']);

/** The pre-filled skip reasons the spec names (items 16 and 12a of the year close, item 6a). */
const SKIP_PREFILL: Record<string, string> = {
  treuhaender_handover: 'checklists.skip.prefill.treuhaender_handover',
  berichtigung_filed: 'checklists.skip.prefill.berichtigung_filed',
  bank_balance_typed: 'checklists.skip.prefill.bank_balance_typed',
  prior_year_comparison: 'checklists.skip.prefill.prior_year_comparison',
};

function draftsOf(item: ItemView, run: RunView, key: 'accruals' | 'provisions'): Array<{ id: string; amountMinor: number }> {
  const paired = item.previewOf === null ? null : run.items.find((i) => i.itemId === item.previewOf) ?? null;
  const rows = paired?.previewResult?.payload?.[key];
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((r): r is Record<string, unknown> => typeof r === 'object' && r !== null && r.status === 'draft' && typeof r.id === 'string')
    .map((r) => ({ id: r.id as string, amountMinor: typeof r.amountMinor === 'number' ? r.amountMinor : 0 }));
}

function idsOf(item: ItemView, key: string): string[] {
  const raw = item.probeResult?.detail[key];
  return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [];
}

export function RunDetail({ run, workspaceId, canManage, canFile, canPost, canPeriods, working, currency, refusal, onComplete, onSkip, onReopen, onAbandon, onAct, onReload }: RunDetailProps) {
  const t = useT();
  const money = useMoney(currency);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(run.nextItemId === null ? [] : [run.nextItemId]));
  useEffect(() => {
    // The journey moves: the new next item opens by itself; what a person opened stays open.
    if (run.nextItemId !== null) setExpanded((prev) => (prev.has(run.nextItemId as string) ? prev : new Set([...prev, run.nextItemId as string])));
  }, [run.nextItemId]);
  const today = todayIso();
  const exportItem = run.items.find((i) => i.itemId === EXPORT_ITEM_ID) ?? null;
  const exportedAt = exportItem?.status === 'done' && exportItem.completedAt !== null ? exportItem.completedAt.slice(0, 10) : null;
  const statementsItem = run.items.find((i) => i.signoffKind === 'statements_signoff') ?? null;
  const signedAt = statementsItem?.signoff?.createdAt.slice(0, 10) ?? null;
  const refusalFor = (itemId: string | null): string | null => (refusal !== null && refusal.itemId === itemId ? refusal.code : null);
  const closeDialog = () => setDialog(null);
  const toggle = (itemId: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(itemId)) next.delete(itemId);
      else next.add(itemId);
      return next;
    });

  const owner = (kind: string): string => t(`checklists.owner.${kind}`);
  const who = (kind: string | null, name: string | null): string => (kind === 'member' && name !== null ? name : t(`checklists.actor.${kind ?? 'unknown'}`));
  const resolved = (key: string, fallback: string): string => (knownKey(key) ? t(key) : fallback);
  const itemTitle = (item: ItemView): string => resolved(`checklists.item.${item.itemId}`, item.title);
  const checkLabel = (key: string): string => resolved(`checklists.check.${key}`, key);
  const verbLabel = (verb: string): string => resolved(`agent.verb.${verb}`, resolved(`checklists.verb.${verb}`, verb.replace(/_/g, ' ')));
  const sealSentence = t('agent.consequenceVerb.close_year');
  const autostart = autostartTemplateOf(run.createdBy);

  const statusLabel = (item: ItemView): ReactNode => {
    if (item.status === 'excluded') return t('checklists.state.excluded');
    if (item.status === 'skipped') return t('checklists.state.skipped');
    if (item.status === 'done') {
      if (item.evidenceKind === 'check') return t('checklists.state.fulfilled');
      if (item.evidenceKind === 'validation') return item.signoff !== null ? t('checklists.state.acknowledged', { date: formatDate(item.signoff.createdAt), who: who(item.signoff.actorKind, item.signoff.actorName) }) : t('checklists.state.passed');
      if (item.evidenceKind === 'posting') return item.probeResult?.detail.nothingToSettle === true ? t('checklists.state.nothingToSettle') : t('checklists.state.posted');
      if (item.evidenceKind === 'choice') return item.choice?.source === 'derived' ? t('checklists.state.derived') : t('checklists.state.answered');
      if ((item.evidenceKind === 'filed_attestation' || item.signoffKind === 'gv_attestation') && item.signoff !== null) {
        return t('checklists.state.attested', { date: formatDate(item.signoff.evidenceRef.slice(0, 10)), who: who(item.signoff.actorKind, item.signoff.actorName) });
      }
      if (item.evidenceKind === 'signoff' && item.signoff !== null) {
        return t('checklists.state.signed', { date: formatDate(item.signoff.createdAt), who: who(item.signoff.actorKind, item.signoff.actorName) });
      }
      return item.completedAt === null ? t('checklists.state.done') : t('checklists.state.doneAt', { date: formatDate(item.completedAt), who: who(item.completedByKind, item.completedByName) });
    }
    if (item.stale) return t('checklists.state.stale');
    if (item.evidenceKind === 'check' && item.checkResult?.passed === null) return t('checklists.state.unavailable');
    if (item.evidenceKind === 'validation' && item.severity === 'warn' && item.validationResult?.result === 'fail') return t('checklists.state.warn');
    return t('checklists.state.open');
  };

  const blockedReasonId = (item: ItemView): string => `${item.runItemId}-blocked`;

  const note = (item: ItemView): ReactNode => {
    if (item.status === 'excluded' && item.excludedBy !== null) {
      const governing = run.items.find((i) => i.itemId === item.excludedBy?.itemId);
      return t('checklists.note.excludedBy', { item: governing === undefined ? item.excludedBy.itemId : itemTitle(governing) });
    }
    if (item.status === 'excluded') return t('checklists.note.excludedEmpty');
    if (item.status === 'skipped' && item.skipReason !== null) return t('checklists.note.skipped', { reason: item.skipReason });
    if (item.status === 'open' && item.blockedBy !== null) {
      return <span id={blockedReasonId(item)}>{t('checklists.note.blockedBy', { item: itemTitle(run.items.find((i) => i.itemId === item.blockedBy) ?? item) })}</span>;
    }
    if (item.status === 'open' && item.evidenceKind === 'check' && item.checkResult !== null) {
      if (item.checkResult.passed === null) return t('checklists.note.checkUnavailable', { check: checkLabel(item.checkResult.key) });
      if (item.checkResult.count !== null && item.checkResult.count > 0) return t('checklists.note.checkPending', { check: checkLabel(item.checkResult.key), count: item.checkResult.count });
      return t('checklists.note.checkFailed', { check: checkLabel(item.checkResult.key) });
    }
    if (item.status === 'open' && item.stale) return item.signoffKind === 'statements_signoff' ? t('checklists.note.staleStatements') : t('checklists.note.stale');
    if (item.status === 'open' && item.precondition !== null && item.preconditionResult?.passed !== true) {
      return t('checklists.note.preconditionOpen', { check: checkLabel(item.precondition) });
    }
    if (item.status === 'done' && item.evidenceKind === 'posting' && item.probeResult !== null && item.probeResult.entryIds.length > 0) {
      return t('checklists.note.entries', { entries: item.probeResult.entryIds.join(', ') });
    }
    return null;
  };

  const titleAside = (item: ItemView): ReactNode => {
    const key = item.check ?? item.probe ?? item.validation;
    if (key === null) return undefined;
    return (
      <Tooltip content={t('checklists.checkKey', { key })}>
        <span className="chk-check-glyph" tabIndex={0} aria-label={t('checklists.checkKey', { key })}>
          ⓘ
        </span>
      </Tooltip>
    );
  };

  const dueLabel = (item: ItemView): string | undefined => {
    if (item.dueAt === null) return undefined;
    return STATUTORY_ITEMS.has(item.itemId) ? t('checklists.dueStatutory', { date: formatDate(item.dueAt) }) : t('checklists.due', { date: formatDate(item.dueAt) });
  };

  /** Open the consequence confirm for a domain verb, then hand the calls to the surface. */
  const confirmAct = (item: ItemView, verb: string, calls: ActCall[], body: ReactNode) => {
    setDialog({ kind: 'act', item, title: verbLabel(verb), body, verb, action: verbLabel(verb), calls });
  };

  const needsRight = (verb: string): string | null => {
    if (PERIOD_VERBS.has(verb)) return canPeriods ? null : t('checklists.needsPeriods');
    return canPost ? null : t('checklists.needsPost');
  };

  /** The primary control of a posting row and its reversal, per verb (design S5). */
  const postingControls = (item: ItemView, isNext: boolean): { primary: ReactNode; reversal: ReactNode; perPeriod?: (row: SettlementRow) => ReactNode } => {
    const verb = item.verb ?? '';
    const primaryClass = isNext ? 'btn btn--primary btn--sm' : 'btn btn--secondary btn--sm';
    const disabledReason = needsRight(verb);
    const blocked = item.blockedBy !== null;
    const posted = item.probeResult?.found === true;
    const gate = (label: string, onClick: () => void, key: string, primary = true): ReactNode => (
      <span key={key} className="chk-act">
        <button type="button" className={primary ? primaryClass : 'btn btn--secondary btn--sm'} disabled={working || blocked || disabledReason !== null} aria-describedby={blocked ? blockedReasonId(item) : disabledReason !== null ? `${item.runItemId}-right` : undefined} onClick={onClick}>
          {label}
        </button>
        {disabledReason !== null && (
          <span id={`${item.runItemId}-right`} className="chk-disabled-reason">
            {disabledReason}
          </span>
        )}
      </span>
    );
    const reverseButton = (label: string, calls: ActCall[], body: ReactNode): ReactNode =>
      canManage && item.reverseVerb !== null ? (
        <button key="reverse" type="button" className="btn btn--secondary btn--sm" disabled={working || needsRight(item.reverseVerb) !== null} onClick={() => confirmAct(item, item.reverseVerb as string, calls, body)}>
          {label}
        </button>
      ) : null;
    const value = item.verbInputValue ?? run.periodLabel;
    switch (verb) {
      case 'post_fx_revaluation': {
        const runId = typeof item.probeResult?.detail.runId === 'string' ? (item.probeResult.detail.runId as string) : null;
        return {
          primary: posted ? null : gate(verbLabel(verb), () => confirmAct(item, verb, [{ verb, input: { periodEnd: value } }], t('checklists.confirm.fx', { date: formatDate(value) })), 'fx'),
          reversal: posted && runId !== null ? reverseButton(t('checklists.act.undo'), [{ verb: 'fx_revaluation_reverse', input: { runId } }], t('checklists.confirm.undo')) : null,
        };
      }
      case 'asset_depreciation_run_post':
        return {
          primary: posted || item.deepLink === null ? null : (
            <Link key="dep" className={primaryClass} to={item.deepLink}>
              {t('checklists.act.openDepreciation')}
            </Link>
          ),
          reversal: posted && item.deepLink !== null ? (
            <Link key="dep-undo" className="btn btn--secondary btn--sm" to={item.deepLink}>
              {t('checklists.act.undoOnSurface')}
            </Link>
          ) : null,
        };
      case 'accrual_post': {
        const drafts = draftsOf(item, run, 'accruals');
        const total = drafts.reduce((s, d) => s + d.amountMinor, 0);
        const postedIds = idsOf(item, 'postedIds');
        return {
          primary: posted || drafts.length === 0 ? null : gate(t('checklists.act.postAccruals', { count: drafts.length }), () => confirmAct(item, verb, drafts.map((d) => ({ verb, input: { accrualId: d.id } })), t('checklists.confirm.batch', { count: drafts.length, total: money(total) })), 'acc'),
          reversal: posted && postedIds.length > 0 ? reverseButton(t('checklists.act.undo'), postedIds.map((id) => ({ verb: 'accrual_reverse', input: { accrualId: id } })), t('checklists.confirm.undoCount', { count: postedIds.length })) : null,
        };
      }
      case 'provision_post': {
        const postedIds = idsOf(item, 'postedIds');
        if (item.itemId === 'tax_provision_posted') {
          const paired = run.items.find((i) => i.itemId === item.previewOf);
          const draft = paired?.previewResult?.payload?.proposedDraft;
          const proposed = typeof draft === 'object' && draft !== null ? (draft as Record<string, unknown>) : null;
          const amount = proposed !== null && typeof proposed.amountMinor === 'number' ? proposed.amountMinor : null;
          return {
            primary: posted || proposed === null ? null : gate(t('checklists.act.postTaxProvision'), () => confirmAct(item, verb, [{ verb: 'provision_create', input: { ...proposed } }, { verb, input: (prev) => ({ provisionId: (prev?.provision as { id?: unknown } | undefined)?.id ?? '' }) }], t('checklists.confirm.taxProvision', { total: money(amount) })), 'tax'),
            reversal: posted && postedIds.length > 0 ? reverseButton(t('checklists.act.undo'), postedIds.map((id) => ({ verb: 'provision_reverse', input: { provisionId: id } })), t('checklists.confirm.undoCount', { count: postedIds.length })) : null,
          };
        }
        const drafts = draftsOf(item, run, 'provisions');
        const total = drafts.reduce((s, d) => s + d.amountMinor, 0);
        return {
          primary: posted || drafts.length === 0 ? null : gate(t('checklists.act.postProvisions', { count: drafts.length }), () => confirmAct(item, verb, drafts.map((d) => ({ verb, input: { provisionId: d.id } })), t('checklists.confirm.batch', { count: drafts.length, total: money(total) })), 'prov'),
          reversal: posted && postedIds.length > 0 ? reverseButton(t('checklists.act.undo'), postedIds.map((id) => ({ verb: 'provision_reverse', input: { provisionId: id } })), t('checklists.confirm.undoCount', { count: postedIds.length })) : null,
        };
      }
      case 'vat_settlement_post': {
        const rows = settlementRowsOf(item);
        if (rows.length === 0) {
          const settlementId = typeof item.probeResult?.detail.settlementId === 'string' ? (item.probeResult.detail.settlementId as string) : null;
          return {
            primary: posted ? null : gate(verbLabel(verb), () => confirmAct(item, verb, [{ verb, input: { period: value } }], t('checklists.confirm.settle', { period: periodTitle(value) })), 'vat'),
            reversal: posted && settlementId !== null ? reverseButton(t('checklists.act.undo'), [{ verb: 'vat_settlement_reverse', input: { settlementId } }], t('checklists.confirm.undo')) : null,
          };
        }
        const unsettled = rows.filter((r) => r.filed && !r.settled);
        return {
          primary: unsettled.length === 0 ? null : gate(t('checklists.act.settleAll', { count: unsettled.length }), () => confirmAct(item, verb, unsettled.map((r) => ({ verb, input: { period: r.label } })), t('checklists.confirm.settleAll', { periods: unsettled.map((r) => periodTitle(r.label)).join(', ') })), 'vat-all'),
          reversal: null,
          perPeriod: (row) =>
            row.filed && !row.settled ? (
              <button type="button" className="btn btn--secondary btn--sm" disabled={working || disabledReason !== null} onClick={() => confirmAct(item, verb, [{ verb, input: { period: row.label } }], t('checklists.confirm.settle', { period: periodTitle(row.label) }))}>
                {t('checklists.act.settle')}
              </button>
            ) : row.settled && row.settlementId !== null && canManage ? (
              <button type="button" className="btn btn--secondary btn--sm" disabled={working || disabledReason !== null} onClick={() => confirmAct(item, 'vat_settlement_reverse', [{ verb: 'vat_settlement_reverse', input: { settlementId: row.settlementId as string } }], t('checklists.confirm.undo'))}>
                {t('checklists.act.undo')}
              </button>
            ) : null,
        };
      }
      case 'lock_period':
        return {
          primary: posted ? null : gate(t('checklists.act.softLock'), () => confirmAct(item, verb, [{ verb, input: { period: value, kind: 'soft' } }], t('checklists.confirm.softLock', { period: value })), 'lock'),
          reversal: posted ? reverseButton(t('checklists.act.unlock'), [{ verb: 'unlock_period', input: { period: value } }], t('checklists.confirm.unlock')) : null,
        };
      case 'close_month':
        return {
          primary: posted ? null : gate(verbLabel(verb), () => confirmAct(item, verb, [{ verb, input: { period: value } }], t('checklists.confirm.closeMonth', { period: periodTitle(value) })), 'cm'),
          reversal: posted ? reverseButton(verbLabel('reopen_month'), [{ verb: 'reopen_month', input: { period: value } }], t('checklists.confirm.reopenMonth')) : null,
        };
      case 'close_year':
        return {
          primary: posted ? null : gate(t('checklists.act.seal'), () => confirmAct(item, verb, [{ verb, input: { year: value } }], t('checklists.confirm.seal', { year: value })), 'seal'),
          reversal: null,
        };
      default:
        return { primary: null, reversal: null };
    }
  };

  /** The row's expanded body per kind; null for a kind with nothing to open (a check). */
  const body = (item: ItemView, isNext: boolean, controls: { primary: ReactNode; perPeriod?: (row: SettlementRow) => ReactNode } | null): ReactNode => {
    const disabled = working || !canManage;
    switch (item.evidenceKind) {
      case 'choice':
        return <ChoiceBody item={item} disabled={disabled} onAnswer={(optionId) => onComplete(item.itemId, { kind: 'choice', ref: optionId })} />;
      case 'preview':
        return <PreviewBody item={item} run={run} currency={currency} disabled={disabled || item.blockedBy !== null} onSeen={() => onComplete(item.itemId, null)} />;
      case 'posting':
        return <PostingBody item={item} run={run} currency={currency} primary={controls?.primary ?? null} perPeriod={controls?.perPeriod} consequence={item.itemId === SEAL_ITEM_ID ? sealSentence : undefined} />;
      case 'validation': {
        const warnOpen = item.severity === 'warn' && item.validationResult?.result === 'fail' && item.status === 'open';
        return (
          <ValidationBody
            item={item}
            currency={currency}
            onRecheck={onReload}
            acknowledge={
              warnOpen && canManage ? (
                <button type="button" className={isNext ? 'btn btn--primary btn--sm' : 'btn btn--secondary btn--sm'} disabled={working} onClick={() => setDialog({ kind: 'acknowledge', item })}>
                  {t('checklists.act.acknowledge')}
                </button>
              ) : null
            }
          />
        );
      }
      case 'signoff':
        if (item.signoffKind === 'statements_signoff') {
          return (
            <StatementsBody
              item={item}
              run={run}
              workspaceId={workspaceId}
              sign={
                canManage ? (
                  <button type="button" className={isNext ? 'btn btn--primary btn--sm' : 'btn btn--secondary btn--sm'} disabled={working || item.blockedBy !== null} aria-describedby={item.blockedBy !== null ? blockedReasonId(item) : undefined} onClick={() => setDialog({ kind: 'signoff', item })}>
                    {t('checklists.act.release')}
                  </button>
                ) : null
              }
            />
          );
        }
        return null;
      default:
        return null;
    }
  };

  /** The row's actions: one primary at most, on the next open item; the rest secondary. */
  const actions = (item: ItemView, isNext: boolean, controls: { primary: ReactNode; reversal: ReactNode } | null): ReactNode => {
    if (run.status === 'abandoned') return null;
    const primary = isNext ? 'btn btn--primary btn--sm' : 'btn btn--secondary btn--sm';
    const out: ReactNode[] = [];
    if (!canManage) {
      if (item.status === 'open' && isNext) out.push(<span key="lock" className="chk-disabled-reason">{t('checklists.needsManage')}</span>);
      if (item.deepLink !== null) out.push(<Link key="open" className="btn btn--secondary btn--sm" to={item.deepLink}>{t('checklists.act.open')}</Link>);
      return out;
    }
    if (item.status === 'excluded') return out;
    if (item.status === 'open') {
      const hasBody = ['choice', 'preview', 'posting', 'validation'].includes(item.evidenceKind) || item.signoffKind === 'statements_signoff';
      if (item.evidenceKind === 'check' && item.itemId === 'period_locked') {
        if (canFile && item.blockedBy !== null) {
          out.push(<button key="mark" type="button" className={primary} disabled aria-describedby={blockedReasonId(item)}>{t('checklists.act.markFiled')}</button>);
        } else if (canFile) {
          out.push(<Link key="mark" className={primary} to="/mwst">{t('checklists.act.markFiled')}</Link>);
        } else {
          out.push(<button key="mark" type="button" className={primary} disabled aria-describedby={`${item.runItemId}-reason`}>{t('checklists.act.markFiled')}</button>);
          out.push(<span key="reason" id={`${item.runItemId}-reason`} className="chk-disabled-reason">{t('checklists.needsFile')}</span>);
        }
      } else if (item.evidenceKind === 'check') {
        if (item.deepLink !== null) out.push(<Link key="open" className={primary} to={item.deepLink}>{t('checklists.act.resolve')}</Link>);
      } else if (item.evidenceKind === 'verb_result') {
        if (item.itemId === EXPORT_ITEM_ID) {
          out.push(<Link key="export" className={primary} to="/mwst">{t('checklists.act.export')}</Link>);
        } else {
          out.push(
            <button key="compute" type="button" className={primary} disabled={working || item.blockedBy !== null} aria-describedby={item.blockedBy !== null ? blockedReasonId(item) : undefined} onClick={() => onComplete(item.itemId, null)}>
              {item.verb === 'vat_return' ? t('checklists.act.compute') : t('checklists.act.run', { verb: verbLabel(item.verb ?? '') })}
            </button>,
          );
        }
      } else if (item.evidenceKind === 'filed_attestation') {
        out.push(
          <button key="attest" type="button" className={primary} disabled={working || item.blockedBy !== null} aria-describedby={item.blockedBy !== null ? blockedReasonId(item) : undefined} onClick={() => setDialog({ kind: 'attest', item })}>
            {t('checklists.act.attest')}
          </button>,
        );
      } else if (item.signoffKind === 'gv_attestation') {
        out.push(
          <button key="gv" type="button" className={primary} disabled={working || item.blockedBy !== null} aria-describedby={item.blockedBy !== null ? blockedReasonId(item) : undefined} onClick={() => setDialog({ kind: 'gv', item })}>
            {t('checklists.act.gv')}
          </button>,
        );
      } else if (item.evidenceKind === 'signoff' && item.signoffKind !== 'statements_signoff') {
        const preconditionOpen = item.precondition !== null && item.preconditionResult?.passed !== true;
        const blocked = item.blockedBy !== null || preconditionOpen;
        out.push(
          <button key="sign" type="button" className={primary} disabled={working || blocked} aria-describedby={preconditionOpen ? `${item.runItemId}-reason` : item.blockedBy !== null ? blockedReasonId(item) : undefined} onClick={() => setDialog({ kind: 'signoff', item })}>
            {item.itemId === 'settlement_booked' ? t('checklists.act.confirmPayment') : item.itemId === BANK_TYPED_ITEM_ID ? t('checklists.act.typeBalance') : t('checklists.act.sign')}
          </button>,
        );
        if (preconditionOpen && item.precondition !== null) {
          out.push(<span key="reason" id={`${item.runItemId}-reason`} className="chk-disabled-reason">{t('checklists.note.preconditionOpen', { check: checkLabel(item.precondition) })}</span>);
        }
      }
      if (hasBody && !isNext) {
        out.push(
          <button key="toggle" type="button" className="btn btn--secondary btn--sm" aria-expanded={expanded.has(item.itemId)} onClick={() => toggle(item.itemId)}>
            {expanded.has(item.itemId) ? t('checklists.act.collapse') : t('checklists.act.details')}
          </button>,
        );
      }
      if (item.deepLink !== null && item.evidenceKind !== 'check' && item.itemId !== EXPORT_ITEM_ID && item.itemId !== 'period_locked' && item.evidenceKind !== 'posting') {
        out.push(<Link key="open" className="btn btn--secondary btn--sm" to={item.deepLink}>{t('checklists.act.open')}</Link>);
      }
      if (!item.undeletable && item.evidenceKind !== 'check' && item.evidenceKind !== 'choice') {
        out.push(
          <button key="skip" type="button" className="btn btn--secondary btn--sm" disabled={working} onClick={() => setDialog({ kind: 'skip', item })}>
            {t('checklists.act.skip')}
          </button>,
        );
      }
      return out;
    }
    // done or skipped: reopen, except a live check or a posting (they flip by their probe; a posting offers its undo).
    if (item.evidenceKind === 'posting' && item.status === 'done') {
      if (controls?.reversal) out.push(controls.reversal);
      return out;
    }
    if (item.evidenceKind !== 'check' || item.status === 'skipped') {
      out.push(
        <button key="reopen" type="button" className="btn btn--secondary btn--sm" disabled={working} onClick={() => onReopen(item.itemId)}>
          {t('checklists.act.reopen')}
        </button>,
      );
    }
    return out;
  };

  const blockers = run.items.filter((i) => i.status === 'open' && i.evidenceKind === 'validation' && i.severity === 'block').length;
  const hints = run.items.filter((i) => i.status === 'open' && i.evidenceKind === 'validation' && i.severity === 'warn').length;

  return (
    <div className="chk-detail">
      <p className="chk-detail-period">
        {t('checklists.detail.period', { period: periodTitle(run.periodLabel), from: formatDate(run.periodStart), to: formatDate(run.periodEnd) })}
        {' '}
        <span className="chk-detail-status" data-status={run.status}>
          {t(`checklists.runStatus.${run.status}`)}
        </span>
        {run.status === 'open' && (
          <span className="chk-detail-counts">
            {' '}
            {t('checklists.detail.counts', { blockers, hints })}
          </span>
        )}
      </p>
      {autostart !== null && (
        <p className="chk-detail-provenance" data-testid="chk-provenance">
          {t('checklists.detail.autostarted', { rule: t(`checklists.template.${autostart}`), date: run.createdAt === null ? '' : formatDate(run.createdAt.slice(0, 10)) })} <Link to="/automations">{t('checklists.detail.automations')}</Link>
        </p>
      )}
      {run.status === 'abandoned' && run.abandonReason !== null && (
        <p className="chk-detail-abandoned" role="note">
          {t('checklists.detail.abandoned', { reason: run.abandonReason })}
        </p>
      )}
      {run.status === 'done' && <p className="chk-detail-done" role="note">{t('checklists.detail.done')}</p>}
      {refusal !== null && refusal.itemId === null && (
        <p className="chk-dialog-error" role="alert">
          {t('checklists.error.refused', { code: refusal.code })}
        </p>
      )}
      <ol className="chk-journey" aria-label={t('checklists.detail.journey')}>
        {run.items.map((item) => {
          const isNext = item.itemId === run.nextItemId;
          const compact = item.status !== 'open';
          const rowRefusal = refusalFor(item.itemId);
          const controls = item.evidenceKind === 'posting' ? postingControls(item, isNext) : null;
          const open = item.status === 'open' && run.status !== 'abandoned' && (isNext || expanded.has(item.itemId));
          const rowBody = open && canManage ? body(item, isNext, controls) : null;
          return (
            <RunbookItemRow
              key={item.runItemId}
              title={`${item.position}. ${itemTitle(item)}`}
              owner={owner(item.ownerKind)}
              status={item.status}
              statusLabel={statusLabel(item)}
              dueAt={item.dueAt}
              dueLabel={dueLabel(item)}
              overdue={item.status === 'open' && item.dueAt !== null && item.dueAt < today}
              note={
                <>
                  {rowRefusal !== null && dialog === null ? (
                    <span role="alert">{t('checklists.error.refused', { code: rowRefusal })}</span>
                  ) : (
                    note(item)
                  )}
                  {rowBody}
                </>
              }
              actions={actions(item, isNext, controls)}
              current={isNext}
              compact={compact}
              titleAside={titleAside(item)}
              dataAttributes={{ 'data-item': item.itemId, 'data-kind': item.evidenceKind, 'data-stale': item.stale ? 'true' : undefined, 'data-expanded': open ? 'true' : undefined }}
            />
          );
        })}
      </ol>
      {canManage && run.status === 'open' && (
        <div className="chk-detail-footer">
          <button type="button" className="btn btn--secondary btn--sm" onClick={() => setDialog({ kind: 'abandon' })}>
            {t('checklists.act.abandon')}
          </button>
        </div>
      )}

      {dialog?.kind === 'attest' && (
        <AttestDialog
          open
          onClose={closeDialog}
          exportedAt={dialog.item.itemId === ATTEST_ITEM_ID ? exportedAt : null}
          today={today}
          portalUrl={t('checklists.attest.portalUrl')}
          refusal={refusalFor(dialog.item.itemId)}
          refusalDetail={refusal?.detail ?? null}
          working={working}
          onAttest={(date) => onComplete(dialog.item.itemId, { kind: 'filed_attestation', ref: date })}
        />
      )}
      {dialog?.kind === 'gv' && (
        <GvDialog
          open
          onClose={closeDialog}
          today={today}
          signedAt={signedAt}
          refusal={refusalFor(dialog.item.itemId)}
          working={working}
          onAttest={(date, reason) => onComplete(dialog.item.itemId, reason === null ? { kind: 'gv_attestation', ref: date } : { kind: 'gv_attestation', ref: date, reason })}
        />
      )}
      {dialog?.kind === 'skip' && (
        <ReasonDialog
          open
          onClose={closeDialog}
          title={t('checklists.skip.title', { item: itemTitle(dialog.item) })}
          label={t('checklists.skip.reason')}
          consequence={t('checklists.skip.consequence')}
          action={t('checklists.skip.action')}
          workingLabel={t('checklists.skip.working')}
          refusal={refusalFor(dialog.item.itemId)}
          working={working}
          initialReason={SKIP_PREFILL[dialog.item.itemId] === undefined ? '' : t(SKIP_PREFILL[dialog.item.itemId] as string)}
          onConfirm={(reason) => onSkip(dialog.item.itemId, reason)}
        />
      )}
      {dialog?.kind === 'acknowledge' && (
        <ReasonDialog
          open
          onClose={closeDialog}
          title={t('checklists.acknowledge.title', { item: itemTitle(dialog.item) })}
          label={t('checklists.acknowledge.reason')}
          consequence={t('checklists.acknowledge.consequence')}
          action={t('checklists.act.acknowledge')}
          workingLabel={t('checklists.acknowledge.working')}
          refusal={refusalFor(dialog.item.itemId)}
          working={working}
          initialReason={dialog.item.itemId === 'umsatzabstimmung' ? t('checklists.acknowledge.prefillReviewed') : ''}
          lead={<p>{dialog.item.validationResult?.explanation ?? ''}</p>}
          onConfirm={(reason) => onComplete(dialog.item.itemId, { kind: 'signoff', ref: reason })}
        />
      )}
      {dialog?.kind === 'signoff' && dialog.item.signoffKind === 'statements_signoff' && (
        <SignoffDialog
          open
          onClose={closeDialog}
          title={t('checklists.release.title', { period: run.periodLabel })}
          consequence={t('checklists.release.consequence')}
          needsReference={false}
          refusal={refusalFor(dialog.item.itemId)}
          working={working}
          onConfirm={() => onComplete(dialog.item.itemId, { kind: 'statements_signoff' })}
        />
      )}
      {dialog?.kind === 'signoff' && dialog.item.signoffKind !== 'statements_signoff' && (
        <SignoffDialog
          open
          onClose={closeDialog}
          title={t('checklists.signoff.title', { item: itemTitle(dialog.item) })}
          consequence={dialog.item.itemId === 'settlement_booked' ? t('checklists.signoff.consequencePayment') : dialog.item.itemId === BANK_TYPED_ITEM_ID ? t('checklists.signoff.consequenceBalance') : t('checklists.signoff.consequenceReview')}
          needsReference={dialog.item.requiresEvidenceRef}
          referenceLabel={dialog.item.itemId === BANK_TYPED_ITEM_ID ? t('checklists.signoff.balanceLabel', { currency }) : undefined}
          referenceHint={dialog.item.itemId === BANK_TYPED_ITEM_ID ? t('checklists.signoff.balanceHint') : undefined}
          refusal={refusalFor(dialog.item.itemId)}
          working={working}
          onConfirm={(reference) => onComplete(dialog.item.itemId, reference === null ? null : { kind: 'signoff', ref: reference })}
        />
      )}
      {dialog?.kind === 'act' && (
        <ConfirmActDialog
          open
          onClose={closeDialog}
          title={dialog.title}
          body={dialog.body}
          consequence={dialog.verb === 'close_year' ? <p className="chk-consequence chk-consequence--seal">{sealSentence}</p> : <ConsequenceLine verb={dialog.verb} />}
          action={dialog.action}
          refusal={refusalFor(dialog.item.itemId)}
          working={working}
          onConfirm={() => {
            const calls = dialog.calls;
            const itemId = dialog.item.itemId;
            setDialog(null);
            onAct(itemId, calls);
          }}
        />
      )}
      {dialog?.kind === 'abandon' && (
        <ReasonDialog
          open
          onClose={closeDialog}
          title={t('checklists.abandon.title', { period: periodTitle(run.periodLabel) })}
          label={t('checklists.abandon.reason')}
          consequence={t('checklists.abandon.consequence')}
          action={t('checklists.abandon.action')}
          workingLabel={t('checklists.abandon.working')}
          refusal={refusalFor(null)}
          working={working}
          danger
          onConfirm={onAbandon}
        />
      )}
    </div>
  );
}
