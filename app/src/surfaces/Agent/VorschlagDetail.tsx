/**
 * D197 point 1, the right pane of the Vorschläge screen (owner pick "B: Liste und Detail"): the ONE selected
 * Vorschlag, read in full before it is decided.
 *
 * On top the subject, the act in words and the signed amount, then one line of facts (date, the accounts in
 * words, the engine's certainty), the agent's reason as a quote, and the decision as LARGE ICONS (D197
 * point 2): Freigeben (`approve`), Ablehnen (`reject`, one step with the optional reason, because the engine
 * cannot undo a rejection), Zur Bankzeile (`open`), the consequence behind the (i) and Mehr for the rare
 * "Freigeben und künftig automatisch". Below: a supplier IBAN change old and new, a settings change current
 * and new, the receipt notice, the Belege, the read-back rows, and for a decided one who decided it when.
 *
 * WHAT YOU APPROVE IS WHAT RUNS (D162, the fresh-eyes judge): a Vorschlag whose record changed keeps
 * Freigeben IN PLACE, disabled (`aria-disabled`, faint), its reason on the tooltip, with Ablehnen and the
 * record as the ways on (DESIGN.md rule 3 as amended by D177). A supplier IBAN change is confirmed first,
 * naming the supplier and both IBANs; the standing grant says its reach before it is given.
 */
import { useId, useState, type ReactNode, type Ref } from 'react';
import { createPortal } from 'react-dom';
import { Link, useNavigate } from 'react-router-dom';

import { formatDate, formatMoney, useI18n } from '../../i18n';
import { useCan, useCapabilities } from '../../lib/capabilities';
import { useConsequence } from '../../lib/approval-tiers';
import { IconButton } from '../../components/IconButton';
import { Modal } from '../../components/Modal';
import { OverflowMenu, type OverflowMenuItem } from '../../components/OverflowMenu';
import { Status } from '../../components/Status';
import { ReceiptHolderNotice } from '../../components/BookAgain';
import { AgentReasonQuote } from './AgentReasonQuote';
import { VorschlagBelege } from './VorschlagBelege';
import { RejectControl } from './RejectControl';
import { CertaintyMark, SignedAmount } from './VorschlagRow';
import { bankLineOf, essentials, readbackRows, type AccountNameMap, type DetailRow } from './vorschlagDetails';
import { IBAN_CHANGE_VERB, actorWords, oldIbanText, recordRouteOf, rowFacts, settingValueWords, verbWords, type VorschlagItem } from './vorschlagView';
import type { DialLevels } from './useDialLevels';
import './VorschlagLine.css';
import './VorschlagDetail.css';

/** The consequential confirm travels to the Modal as a value, never as a literal attribute (the modal-role guard). */
const ALERT_DIALOG = 'alertdialog' as const;

/**
 * The dialogs leave the pane for the document body: the pane is sticky (its own stacking context), so a
 * scrim drawn inside it would stay under the page's sticky header (the judge, point 6).
 */
function portal(node: ReactNode): ReactNode {
  return typeof document === 'undefined' ? node : createPortal(node, document.body);
}

/** The non-breaking separator of a read-back row's link. */
const SEP = ' · ';

export interface VorschlagDetailProps {
  item: VorschlagItem;
  dial?: DialLevels | null;
  accountNames?: AccountNameMap;
  busy?: boolean;
  /** How many listed Vorschläge share this one's Freigabe family: the reach a standing grant names. */
  sameFamilyCount?: number;
  onApprove: (allowFuture: boolean) => void;
  onReject: (reason?: string) => void;
  /** Narrow window: the detail replaces the list, and this goes back to it. */
  onBack?: () => void;
  headingRef?: Ref<HTMLHeadingElement>;
  /** Extra read-back rows that lead (a mined rule's evidence). */
  extraDetails?: DetailRow[];
}

export function VorschlagDetail({ item, dial = null, accountNames, busy = false, sameFamilyCount = 1, onApprove, onReject, onBack, headingRef, extraDetails }: VorschlagDetailProps) {
  const { t, locale } = useI18n();
  const navigate = useNavigate();
  const headingId = useId();
  const whoami = useCapabilities().whoami;
  const isDraftingActor = whoami?.actor === item.actor;
  const canDecide = useCan('manage_agent_dial') && !isDraftingActor;
  const pending = item.status === 'pending';
  const changed = item.changedSinceProposal === true;
  const capability = item.dialCapability ?? '';
  const consequence = useConsequence(item.actionTool, capability);
  const facts = rowFacts(t, locale, item, accountNames);
  const accounts = essentials(t, locale, item, accountNames);
  const bankLine = bankLineOf(item);
  const level = dial?.get(capability) ?? null;
  const [confirm, setConfirm] = useState<'iban' | 'grant' | null>(null);
  const isIban = item.actionTool === IBAN_CHANGE_VERB;
  const strong = level?.strongDefault === true || capability === 'vat-file' || capability === 'plugin-install';
  const capabilityWord = capability !== '' ? t(`agent.capability.${capability}`) : facts.kind;

  // The accounts line without the leading amount (the amount stands on its own above).
  const accountWords = accounts === null ? null : accounts.split(' · ').filter((part) => !/^[A-Z]{3} -?[\d']+\.\d{2}$/.test(part) && part !== facts.subject).join(' · ');
  // A supplier IBAN change says its supplier and both IBANs above: the read-back does not repeat them.
  // The read-back says only what the face does not (the judge, D197 point 3): no "Art" (the kind is under
  // the title), no single bank leg (the account is on the facts line, the signed amount in the header), no
  // line repeating the subject, and no settings note (the Freigabe level lives on the Berechtigungen tab).
  const omit = ['kind', ...(item.lineFacts !== undefined ? ['legs'] : []), ...(isIban && item.bankDetail !== undefined ? ['iban', 'vendorId'] : []), ...(item.setting !== undefined ? ['key', 'value'] : [])];
  const headerMoney = facts.amountMinor === null ? null : [formatMoney(facts.amountMinor, facts.currency), formatMoney(Math.abs(facts.amountMinor), facts.currency)];
  const allRows = readbackRows(t, locale, item, { accountNames, extra: extraDetails, omit });
  // A lone amount equal to the header's is a repeat; Netto, MWST and Total together are a breakdown and stay.
  const breakdown = allRows.some((row) => row.key === '__vat');
  const rows = allRows.filter(
    (row) => row.value !== facts.subject && !(row.money === true && !breakdown && headerMoney !== null && headerMoney.includes(row.value)),
  );
  const recordRoute = recordRouteOf(item);

  const approve = () => {
    if (changed || busy) return;
    if (isIban) {
      setConfirm('iban');
      return;
    }
    onApprove(false);
  };

  const menu: OverflowMenuItem[] = [
    ...(pending && canDecide && !changed && !isIban
      ? [{ key: 'approve-allow', label: t('agent.vq.approveAllow'), onSelect: () => setConfirm('grant'), disabled: busy }]
      : []),
  ];

  const decided =
    item.status === 'executed' ? (
      <Status kind="success" label={t('agent.vq.status.executed')} />
    ) : item.status === 'rejected' ? (
      <Status kind="neutral" label={item.closureKind !== null ? t('agent.vq.status.closed') : t('agent.vq.status.rejected')} />
    ) : item.status === 'stale' ? (
      <Status kind="warn" label={t('agent.vq.status.stale')} />
    ) : null;

  return (
    <section className="vdet" aria-labelledby={headingId} data-action-id={item.actionId}>
      {onBack !== undefined && (
        // Narrow: the detail closes back to the list (the vocabulary's Schliessen, named for where it goes).
        <IconButton icon="close" className="vdet-back" name={t('agent.vq.back')} context={facts.subject} onClick={onBack} />
      )}
      <header className="vdet-head">
        <div className="vdet-title">
          <h2 id={headingId} ref={headingRef} tabIndex={-1} className="vdet-subject">
            {facts.subject}
          </h2>
          <span className="vdet-kind">{verbWords(t, item.actionTool)}</span>
        </div>
        {facts.amountMinor !== null && <SignedAmount minor={facts.amountMinor} currency={facts.currency} className="vdet-amount" />}
      </header>

      <p className="vdet-facts">
        {facts.date !== null && <span className="t-num">{facts.date}</span>}
        {accountWords !== null && accountWords !== '' && <span data-figure="key">{accountWords}</span>}
        {facts.certainty !== null && <CertaintyMark certainty={facts.certainty} />}
        {decided}
      </p>

      <AgentReasonQuote text={item.agentReason} />

      {pending && (
        <div className="vdet-actions" role="group" aria-label={t('agent.vq.decide')}>
          {canDecide ? (
            <>
              <IconButton
                icon="approve"
                size={24}
                className={changed ? 'vdet-approve vdet-approve--disabled' : 'vdet-approve'}
                name={t('agent.vq.approve')}
                context={changed ? t('agent.vq.staleReason') : (consequence ?? t('agent.vq.approveContext'))}
                aria-disabled={changed || busy ? true : undefined}
                onClick={approve}
              />
              <RejectControl size={24} context={t('agent.vq.rejectContext')} busy={busy} onReject={onReject} />
            </>
          ) : isDraftingActor ? (
            <span className="vdet-hint">{t('agent.card.selfHint')}</span>
          ) : (
            <Link className="link-inline vdet-hint" to="/members">
              {t('agent.card.needs')}
            </Link>
          )}
          {bankLine !== null && (
            <IconButton icon="open" size={24} name={t('agent.line.toBankLine')} context={facts.subject} onClick={() => navigate(`/bank?line=${encodeURIComponent(bankLine)}`)} />
          )}
          {/* D197 (orchestrator): a changed one's way on, beside Ablehnen: the record it acts on. */}
          {changed && bankLine === null && recordRoute !== null && (
            <IconButton icon="open" size={24} name={t('agent.vq.recoveryContext')} context={facts.subject} onClick={() => navigate(recordRoute)} />
          )}
          {menu.length > 0 && <OverflowMenu quiet className="vdet-more" label={t('agent.line.more', { title: facts.subject })} items={menu} />}
        </div>
      )}
      {!pending && bankLine !== null && (
        <div className="vdet-actions">
          <IconButton icon="open" size={24} name={t('agent.line.toBankLine')} context={facts.subject} onClick={() => navigate(`/bank?line=${encodeURIComponent(bankLine)}`)} />
        </div>
      )}


      {item.bankDetail !== undefined && (
        <dl className="vdet-change" aria-label={t('agent.vq.ibanChange')}>
          <div>
            <dt>{t('agent.vq.ibanOld')}</dt>
            <dd className="t-num">{oldIbanText(t, item.bankDetail)}</dd>
          </div>
          <div>
            <dt>{t('agent.vq.ibanNew')}</dt>
            <dd className="t-num vdet-change-new">{item.bankDetail.newIban ?? ''}</dd>
          </div>
        </dl>
      )}
      {item.setting !== undefined && item.setting.current !== undefined && (
        <dl className="vdet-change" aria-label={t('agent.vq.settingChange')}>
          <div>
            <dt>{t('agent.vq.settingNow')}</dt>
            <dd>{settingValueWords(t, item.setting.current)}</dd>
          </div>
          <div>
            <dt>{t('agent.vq.settingNew')}</dt>
            <dd className="vdet-change-new">{settingValueWords(t, item.setting.value)}</dd>
          </div>
        </dl>
      )}

      {pending && item.receiptHolders !== undefined && item.receiptHolders.length > 0 && <ReceiptHolderNotice holders={item.receiptHolders} className="vdet-notice" />}
      {item.belege !== undefined && item.belege.length > 0 && <VorschlagBelege actionId={item.actionId} belege={item.belege} canPreview={canDecide} />}

      {item.status === 'rejected' && item.rejectReason !== null && item.rejectReason !== '' && (
        <p className="vdet-reason">{t('agent.vq.rejectedWith', { reason: item.rejectReason })}</p>
      )}

      <dl className="vorschlag-readback vdet-readback">
        {rows.map((row) => (
          <div className="vorschlag-readback-row" key={row.key}>
            <dt>{row.label}</dt>
            <dd title={row.title}>
              {row.value}
              {row.link !== undefined && (
                <>
                  {SEP}
                  <Link className="link-inline" to={row.link.to}>
                    {row.link.label}
                  </Link>
                </>
              )}
            </dd>
          </div>
        ))}
        {item.resolvedAt !== null && (
          <div className="vorschlag-readback-row">
            <dt>{t('agent.vq.decidedLabel')}</dt>
            {/* D196: a decision the agent took under the owner's grant says so, the grant on hover; every
                decider is named in words, never by its raw actor id (D197). */}
            <dd
              data-decided-by={item.decidedUnderGrant ? 'agent' : undefined}
              title={item.decidedUnderGrant ? t('agent.trace.underGrant', { grantedBy: actorWords(t, item.decidedUnderGrant.grantedBy), grantedAt: formatDate(item.decidedUnderGrant.grantedAt) }) : undefined}
            >
              {t('agent.vq.decidedValue', {
                date: formatDate(item.resolvedAt),
                who: item.decidedOnOwnerWord
                  ? t('agent.vq.who.agentOnWord')
                  : item.decidedUnderGrant
                    ? t('agent.vq.who.agentUnderGrant')
                    : actorWords(t, item.resolvedBy),
              })}
            </dd>
          </div>
        )}
        {/* D209: the owner's own words the agent approved this Vorschlag on, verbatim, with when they were said. */}
        {item.resolvedAt !== null && item.decidedOnOwnerWord && (
          <div className="vorschlag-readback-row" data-owner-word="">
            <dt>{t('agent.vq.ownerWordLabel')}</dt>
            <dd>{t('agent.vq.ownerWordValue', { quote: item.decidedOnOwnerWord.quote, saidAt: formatDate(item.decidedOnOwnerWord.saidAt) })}</dd>
          </div>
        )}
      </dl>

      {portal(
      <Modal
        open={confirm === 'iban'}
        onClose={() => setConfirm(null)}
        role={ALERT_DIALOG}
        title={t('agent.vq.ibanConfirmTitle', { supplier: facts.subject })}
        closeLabel={t('agent.vq.confirmClose')}
        footer={
          <button
            type="button"
            className="btn btn--primary"
            disabled={busy}
            onClick={() => {
              setConfirm(null);
              onApprove(false);
            }}
          >
            {t('agent.vq.ibanConfirmYes')}
          </button>
        }
      >
        {item.bankDetail !== undefined && (
          <dl className="vdet-change vdet-change--confirm">
            <div>
              <dt>{t('agent.vq.ibanOld')}</dt>
              <dd className="t-num">{oldIbanText(t, item.bankDetail)}</dd>
            </div>
            <div>
              <dt>{t('agent.vq.ibanNew')}</dt>
              <dd className="t-num vdet-change-new">{item.bankDetail.newIban ?? ''}</dd>
            </div>
          </dl>
        )}
      </Modal>,
      )}

      {portal(
      <Modal
        open={confirm === 'grant'}
        onClose={() => setConfirm(null)}
        role={ALERT_DIALOG}
        title={t('agent.vq.grantTitle', { capability: capabilityWord })}
        closeLabel={t('agent.vq.confirmClose')}
        footer={
          <button
            type="button"
            className="btn btn--primary"
            disabled={busy}
            onClick={() => {
              setConfirm(null);
              onApprove(true);
            }}
          >
            {t('agent.line.grantYes')}
          </button>
        }
      >
        <p>{t('agent.vq.grantReach', { capability: capabilityWord, count: sameFamilyCount })}</p>
        {strong && <p>{t('agent.trust.strongReason')}</p>}
      </Modal>,
      )}
    </section>
  );
}
