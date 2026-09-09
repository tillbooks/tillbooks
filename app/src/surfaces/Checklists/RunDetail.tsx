/**
 * One checklist run: the whole journey in order with the current position marked, done rows compact,
 * the next open item carrying the single primary action (plan finding 8). The words per item kind
 * (finding 1): a system check is `erfüllt`, an agent verb item `erledigt`, a human attestation
 * `bestätigt am ... durch ...`, a skipped item `nicht zutreffend`, a stale sign-off `Freigabe
 * hinfällig`. Check labels come from i18n; the check key is the tooltip, never on-screen text
 * (finding 9). Item 8 acts through `vat_mark_filed` on `/mwst` and, for an actor without `vat_file`,
 * renders disabled with the padlock reason, never hidden (finding 2). While item 7 (the ePortal
 * attestation) is still open, item 8 is disabled too, with the "Wartet auf" note as its reason: the
 * prerequisite is enforced here, not only advised (non-author critic, 2026-09-09).
 */
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';

import { RunbookItemRow } from '../../components/RunbookItemRow';
import { Tooltip } from '../../components/Tooltip';
import { useT, formatDate } from '../../i18n';
import { AttestDialog, ReasonDialog, SignoffDialog } from './Dialogs';
import { ATTEST_ITEM_ID, EXPORT_ITEM_ID, periodTitle, todayIso, type ItemView, type RunView } from './model';

export interface RunDetailProps {
  run: RunView;
  canManage: boolean;
  canFile: boolean;
  working: boolean;
  /** The refusal code of the last write, keyed by the item it targeted. */
  refusal: { itemId: string | null; code: string; detail: string | null } | null;
  onComplete: (itemId: string, evidence: { kind: string; ref: string } | null) => void;
  onSkip: (itemId: string, reason: string) => void;
  onReopen: (itemId: string) => void;
  onAbandon: (reason: string) => void;
}

type Dialog =
  | { kind: 'attest'; item: ItemView }
  | { kind: 'skip'; item: ItemView }
  | { kind: 'signoff'; item: ItemView }
  | { kind: 'abandon' }
  | null;

export function RunDetail({ run, canManage, canFile, working, refusal, onComplete, onSkip, onReopen, onAbandon }: RunDetailProps) {
  const t = useT();
  const [dialog, setDialog] = useState<Dialog>(null);
  const today = todayIso();
  const exportItem = run.items.find((i) => i.itemId === EXPORT_ITEM_ID) ?? null;
  const exportedAt = exportItem?.status === 'done' && exportItem.completedAt !== null ? exportItem.completedAt.slice(0, 10) : null;
  const refusalFor = (itemId: string | null): string | null => (refusal !== null && refusal.itemId === itemId ? refusal.code : null);
  const closeDialog = () => setDialog(null);

  const owner = (kind: string): string => t(`checklists.owner.${kind}`);
  const who = (kind: string | null, name: string | null): string =>
    kind === 'member' && name !== null ? name : t(`checklists.actor.${kind ?? 'unknown'}`);
  const itemTitle = (item: ItemView): string => {
    const key = `checklists.item.${item.itemId}`;
    const resolved = t(key);
    return resolved === key ? item.title : resolved;
  };
  const checkLabel = (key: string): string => {
    const k = `checklists.check.${key}`;
    const resolved = t(k);
    return resolved === k ? key : resolved;
  };

  const statusLabel = (item: ItemView): ReactNode => {
    if (item.status === 'skipped') return t('checklists.state.skipped');
    if (item.status === 'done') {
      if (item.evidenceKind === 'check') return t('checklists.state.fulfilled');
      if (item.evidenceKind === 'filed_attestation' && item.signoff !== null) {
        return t('checklists.state.attested', { date: formatDate(item.signoff.evidenceRef), who: who(item.signoff.actorKind, item.signoff.actorName) });
      }
      if (item.evidenceKind === 'signoff' && item.signoff !== null) {
        return t('checklists.state.signed', { date: formatDate(item.signoff.createdAt), who: who(item.signoff.actorKind, item.signoff.actorName) });
      }
      return item.completedAt === null
        ? t('checklists.state.done')
        : t('checklists.state.doneAt', { date: formatDate(item.completedAt), who: who(item.completedByKind, item.completedByName) });
    }
    if (item.stale) return t('checklists.state.stale');
    if (item.evidenceKind === 'check' && item.checkResult?.passed === null) return t('checklists.state.unavailable');
    return t('checklists.state.open');
  };

  const note = (item: ItemView): ReactNode => {
    if (item.status === 'skipped' && item.skipReason !== null) return t('checklists.note.skipped', { reason: item.skipReason });
    if (item.status === 'open' && item.blockedBy !== null) {
      // The note carries an id so a control disabled BY this prerequisite can name it (aria-describedby).
      return <span id={blockedReasonId(item)}>{t('checklists.note.blockedBy', { item: itemTitle(run.items.find((i) => i.itemId === item.blockedBy) ?? item) })}</span>;
    }
    if (item.status === 'open' && item.evidenceKind === 'check' && item.checkResult !== null) {
      if (item.checkResult.passed === null) return t('checklists.note.checkUnavailable', { check: checkLabel(item.checkResult.key) });
      if (item.checkResult.count !== null && item.checkResult.count > 0) return t('checklists.note.checkPending', { check: checkLabel(item.checkResult.key), count: item.checkResult.count });
      return t('checklists.note.checkFailed', { check: checkLabel(item.checkResult.key) });
    }
    if (item.status === 'open' && item.stale) return t('checklists.note.stale');
    if (item.status === 'open' && item.precondition !== null && item.preconditionResult?.passed !== true) {
      return t('checklists.note.preconditionOpen', { check: checkLabel(item.precondition) });
    }
    return null;
  };

  const blockedReasonId = (item: ItemView): string => `${item.runItemId}-blocked`;

  const titleAside = (item: ItemView): ReactNode =>
    item.check === null ? undefined : (
      <Tooltip content={t('checklists.checkKey', { key: item.check })}>
        <span className="chk-check-glyph" tabIndex={0} aria-label={t('checklists.checkKey', { key: item.check })}>
          ⓘ
        </span>
      </Tooltip>
    );

  /** The row's actions: one primary at most, on the next open item; the rest secondary. */
  const actions = (item: ItemView, isNext: boolean): ReactNode => {
    if (run.status === 'abandoned') return null;
    const primary = isNext ? 'btn btn--primary btn--sm' : 'btn btn--secondary btn--sm';
    const out: ReactNode[] = [];
    if (!canManage) {
      if (item.status === 'open' && isNext) out.push(<span key="lock" className="chk-disabled-reason">{t('checklists.needsManage')}</span>);
      if (item.deepLink !== null) out.push(<Link key="open" className="btn btn--secondary btn--sm" to={item.deepLink}>{t('checklists.act.open')}</Link>);
      return out;
    }
    if (item.status === 'open') {
      if (item.evidenceKind === 'check' && item.itemId === 'period_locked') {
        if (canFile && item.blockedBy !== null) {
          // Item 7 is still open: the lock waits on the attestation. Disabled with the note as reason, never hidden.
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
            <button key="compute" type="button" className={primary} disabled={working || item.blockedBy !== null} onClick={() => onComplete(item.itemId, null)}>
              {t('checklists.act.compute')}
            </button>,
          );
        }
      } else if (item.evidenceKind === 'filed_attestation') {
        out.push(
          <button key="attest" type="button" className={primary} disabled={working || item.blockedBy !== null} onClick={() => setDialog({ kind: 'attest', item })}>
            {t('checklists.act.attest')}
          </button>,
        );
      } else {
        const preconditionOpen = item.precondition !== null && item.preconditionResult?.passed !== true;
        const blocked = item.blockedBy !== null || preconditionOpen;
        out.push(
          <button key="sign" type="button" className={primary} disabled={working || blocked} aria-describedby={preconditionOpen ? `${item.runItemId}-reason` : undefined} onClick={() => setDialog({ kind: 'signoff', item })}>
            {item.itemId === 'settlement_booked' ? t('checklists.act.confirmPayment') : t('checklists.act.sign')}
          </button>,
        );
        if (preconditionOpen && item.precondition !== null) {
          out.push(<span key="reason" id={`${item.runItemId}-reason`} className="chk-disabled-reason">{t('checklists.note.preconditionOpen', { check: checkLabel(item.precondition) })}</span>);
        }
      }
      if (item.deepLink !== null && item.evidenceKind !== 'check' && item.itemId !== EXPORT_ITEM_ID && item.itemId !== 'period_locked') {
        out.push(<Link key="open" className="btn btn--secondary btn--sm" to={item.deepLink}>{t('checklists.act.open')}</Link>);
      }
      if (!item.undeletable) {
        out.push(
          <button key="skip" type="button" className="btn btn--secondary btn--sm" disabled={working} onClick={() => setDialog({ kind: 'skip', item })}>
            {t('checklists.act.skip')}
          </button>,
        );
      }
      return out;
    }
    // done or skipped: reopen, except a live check (it flips by itself).
    if (item.evidenceKind !== 'check' || item.status === 'skipped') {
      out.push(
        <button key="reopen" type="button" className="btn btn--secondary btn--sm" disabled={working} onClick={() => onReopen(item.itemId)}>
          {t('checklists.act.reopen')}
        </button>,
      );
    }
    return out;
  };

  return (
    <div className="chk-detail">
      <p className="chk-detail-period">
        {t('checklists.detail.period', { period: periodTitle(run.periodLabel), from: formatDate(run.periodStart), to: formatDate(run.periodEnd) })}
        {' '}
        <span className="chk-detail-status" data-status={run.status}>
          {t(`checklists.runStatus.${run.status}`)}
        </span>
      </p>
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
          return (
            <RunbookItemRow
              key={item.runItemId}
              title={`${item.position}. ${itemTitle(item)}`}
              owner={owner(item.ownerKind)}
              status={item.status}
              statusLabel={statusLabel(item)}
              dueAt={item.dueAt}
              dueLabel={item.dueAt === null ? undefined : t('checklists.due', { date: formatDate(item.dueAt) })}
              overdue={item.status === 'open' && item.dueAt !== null && item.dueAt < today}
              note={
                rowRefusal !== null && dialog === null ? (
                  <span role="alert">{t('checklists.error.refused', { code: rowRefusal })}</span>
                ) : (
                  note(item)
                )
              }
              actions={actions(item, isNext)}
              current={isNext}
              compact={compact}
              titleAside={titleAside(item)}
              dataAttributes={{ 'data-item': item.itemId, 'data-stale': item.stale ? 'true' : undefined }}
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
          exportedAt={exportedAt}
          today={today}
          portalUrl={t('checklists.attest.portalUrl')}
          refusal={refusalFor(ATTEST_ITEM_ID)}
          refusalDetail={refusal?.detail ?? null}
          working={working}
          onAttest={(date) => onComplete(dialog.item.itemId, { kind: 'filed_attestation', ref: date })}
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
          onConfirm={(reason) => onSkip(dialog.item.itemId, reason)}
        />
      )}
      {dialog?.kind === 'signoff' && (
        <SignoffDialog
          open
          onClose={closeDialog}
          title={t('checklists.signoff.title', { item: itemTitle(dialog.item) })}
          consequence={dialog.item.itemId === 'settlement_booked' ? t('checklists.signoff.consequencePayment') : t('checklists.signoff.consequenceReview')}
          needsReference={dialog.item.requiresEvidenceRef}
          refusal={refusalFor(dialog.item.itemId)}
          working={working}
          onConfirm={(reference) => onComplete(dialog.item.itemId, reference === null ? null : { kind: 'signoff', ref: reference })}
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
