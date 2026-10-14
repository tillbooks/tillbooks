/**
 * The Vorschlag card: ONE component, rendered in the dock, in the Vorschläge queue and inside G15's
 * hub. Three mounts of one card, never three cards (design §3d).
 *
 * Genehmigen is the only button on its face and carries the accent ONLY when `accent` is true (the
 * newest card in the dock, the focused one in the queue), which is what lets a stack of cards keep
 * the one-accent budget. Ablehnen is destructive and irreversible in the engine, so it lives in the
 * overflow and confirms IN PLACE (never a modal, never a toast). The D103 grant arm ("Genehmigen und
 * künftig automatisch") is owner-gated and states on the strong-default pair why the capability asks
 * by default. There is no edit control, and the card says so: approving replays the stored payload
 * exactly.
 *
 * WHAT YOU APPROVED IS WHAT RUNS (critic N1). A Vorschlag that names a record (`issue_invoice
 * {invoiceId}`) used to show only the id. The engine now freezes the record's key figures at the
 * proposal (number or draft, counterparty, amount with currency, line count) and the card leads with
 * them, so the person sees what is being approved. When the record changed since, the card says so and
 * holds the approve: the engine would refuse it (`vorschlag_stale`) and run nothing.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';

import { useT, formatDate, formatMoney } from '../../i18n';
import { useCan, useCapabilities } from '../../lib/capabilities';
import { OverflowMenu } from '../../components/OverflowMenu';
import { ActionFeedback } from '../../components/ActionFeedback';
import { LABELLED_FIELDS, LABELLED_VERBS, type DraftedAction, type VorschlagFigures } from './model';
import { useConsequence } from '../../lib/approval-tiers';

export interface VorschlagCardProps {
  action: DraftedAction;
  /** True on the ONE card the surface is currently about; every other card renders neutral. */
  accent: boolean;
  onApprove: (actionId: string, allowFuture: boolean) => void;
  /** `reason` is the human's optional sentence (F-08, J5.6): "No, and tell it why". */
  onReject: (actionId: string, reason?: string) => void;
  /** In-flight guard so a double press cannot fire twice while the verb runs. */
  busy?: boolean;
}

/** The strong-default pair (D103): grantable, with the reason named in place. */
const STRONG_DEFAULT = new Set(['vat-file', 'plugin-install']);

/** A journal line as `post_entry` / `reverse_entry` payloads carry it. */
interface PayloadLine {
  account?: unknown;
  debit?: unknown;
  credit?: unknown;
}

function payloadLines(payload: Record<string, unknown>): PayloadLine[] {
  return Array.isArray(payload.lines) ? (payload.lines as PayloadLine[]) : [];
}

/**
 * The one figure the draft moves (critic F4): the sum of the line debits for a posting, the
 * payment amount for the payment verbs. `null` when the payload carries none: a Vorschlag without a
 * derivable figure renders no figure, never a guessed one.
 */
function leadAmountOf(action: DraftedAction): number | null {
  const lines = payloadLines(action.payload);
  if (lines.length > 0) {
    const debits = lines.reduce((sum, l) => sum + (typeof l.debit === 'number' ? l.debit : 0), 0);
    return debits > 0 ? debits : null;
  }
  if (typeof action.payload.amountMinor === 'number') return action.payload.amountMinor;
  return null;
}

/**
 * Critic F6: no raw payload key and no raw Rappen integer above the Details disclosure. A known key
 * renders its de-CH label (`agent.field.*`); an unknown one is humanized from its own name (spaced,
 * capitalized), which is not a translation and is honestly not one, but it is never `snake_case` or
 * `camelCase` on screen. Values: `*Minor`/`*Rappen` keys format as CHF money, ISO dates as
 * `TT.MM.JJJJ`, everything else renders as sent.
 */
function fieldLabel(t: (key: string) => string, labelled: ReadonlySet<string>, key: string): string {
  if (labelled.has(key)) return t(`agent.field.${key}`);
  const spaced = key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function fieldValue(key: string, value: string | number): string {
  if (typeof value === 'number' && (/Minor$/.test(key) || /Rappen$/.test(key))) {
    return formatMoney(value, 'CHF');
  }
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) return formatDate(value);
  return String(value);
}

/** The frozen figures as read-back rows (critic N1): only the ones the engine could derive. */
function FigureRows({ figures }: { figures: VorschlagFigures }) {
  const t = useT();
  const currency = figures.currency ?? 'CHF';
  return (
    <>
      {figures.amountMinor !== null && (
        <div className="vorschlag-readback-row vorschlag-amount" key="__figure-amount" data-figure="amount">
          <dt>{figures.amountBasis === 'net' ? t('agent.card.figure.net') : t('agent.field.amount')}</dt>
          <dd className="vorschlag-amount-figure t-money">{formatMoney(figures.amountMinor, currency)}</dd>
        </div>
      )}
      {figures.taxMinor !== null && figures.grossMinor !== null && (
        <>
          <div className="vorschlag-readback-row" key="__figure-vat" data-figure="vat">
            <dt>{t('agent.card.figure.vat')}</dt>
            <dd className="t-money">{formatMoney(figures.taxMinor, currency)}</dd>
          </div>
          <div className="vorschlag-readback-row" key="__figure-gross" data-figure="gross">
            <dt>{t('agent.card.figure.gross')}</dt>
            <dd className="t-money">{formatMoney(figures.grossMinor, currency)}</dd>
          </div>
        </>
      )}
      {(figures.number !== null || figures.numberPending) && (
        <div className="vorschlag-readback-row" key="__figure-number" data-figure="number">
          <dt>{t('agent.card.figure.number')}</dt>
          <dd>{figures.number ?? t('agent.card.figure.draft')}</dd>
        </div>
      )}
      {figures.counterparty !== null && (
        <div className="vorschlag-readback-row" key="__figure-counterparty" data-figure="counterparty">
          <dt>{t('agent.card.figure.counterparty')}</dt>
          <dd>{figures.counterparty}</dd>
        </div>
      )}
      {figures.recipient !== null && (
        <div className="vorschlag-readback-row" key="__figure-recipient" data-figure="recipient">
          <dt>{t('agent.card.figure.recipient')}</dt>
          <dd>{figures.recipient}</dd>
        </div>
      )}
      {figures.lineCount !== null && (
        <div className="vorschlag-readback-row" key="__figure-lines" data-figure="lines">
          <dt>{t('agent.card.figure.lines')}</dt>
          <dd>{figures.lineCount}</dd>
        </div>
      )}
    </>
  );
}

export function VorschlagCard({ action, accent, onApprove, onReject, busy = false }: VorschlagCardProps) {
  const t = useT();
  // The self-approve ban, VISIBLE at the surface: the drafting actor never sees an approve control
  // (the engine's cannot_self_approve still bites underneath; this is the design's row 2.3 half).
  // The TWO hidden states carry TWO different reasons (critic F15): lacking the capability points at
  // /members; being the drafting actor is not a rights problem and gets its own sentence.
  const whoami = useCapabilities().whoami;
  const isDraftingActor = whoami?.actor === action.actor;
  const canDecide = useCan('manage_agent_dial') && !isDraftingActor;
  // Critic N1: the record changed after the proposal, so the engine would refuse the approval and run
  // nothing. The approve is held and the card says why; rejecting stays possible.
  const changed = action.changedSinceProposal === true;
  const figures = action.figures ?? null;
  const [confirmingReject, setConfirmingReject] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [showDetails, setShowDetails] = useState(false);

  const capability = action.dialCapability ?? '';
  const verbLabel = LABELLED_VERBS.has(action.actionTool)
    ? t(`agent.verb.${action.actionTool}`)
    : action.actionTool.replace(/_/g, ' ');
  // D156: the engine's one consequence for the drafted verb (its own entry, else the family of the tier
  // the seam stored), the identical sentence a human confirm of the same verb and the MCP description show.
  const consequence = useConsequence(action.actionTool, capability);
  const date = action.createdAt.length >= 10 ? formatDate(action.createdAt.slice(0, 10)) : action.createdAt;
  // Critic F4: the money the approver is deciding about is the card's LEAD figure, never buried in
  // raw JSON. `null` when the payload carries no derivable figure: an absent figure is honest, an
  // invented one is not.
  // The frozen figures, when the engine has them, are the lead: they are what the approval is pinned to.
  const leadAmountMinor = figures !== null && figures.amountMinor !== null ? null : leadAmountOf(action);

  return (
    <article className="vorschlag-card panel" data-action-id={action.actionId} data-accent={accent ? 'true' : 'false'}>
      <header className="vorschlag-head">
        <span className="vorschlag-kicker">{t('agent.card.title')}</span>
        <OverflowMenu
          label={t('agent.card.details')}
          items={[
            {
              key: 'details',
              label: t('agent.card.details'),
              onSelect: () => setShowDetails((v) => !v),
            },
            ...(canDecide && !changed
              ? [
                  {
                    key: 'approve-allow',
                    label: t('agent.card.approveAllow'),
                    onSelect: () => onApprove(action.actionId, true),
                    disabled: busy,
                  },
                ]
              : []),
            {
              key: 'reject',
              label: t('agent.card.reject'),
              onSelect: () => setConfirmingReject(true),
              danger: true,
              disabled: busy || !canDecide,
            },
          ]}
        />
      </header>

      <p className="vorschlag-title">{verbLabel}</p>
      {consequence !== null && <p className="vorschlag-consequence">{consequence}</p>}

      <dl className="vorschlag-readback">
        {/* N1: what is being approved, as the agent proposed it, leads the read-back. */}
        {figures !== null && <FigureRows figures={figures} />}
        {/* F4: the money this draft moves LEADS the read-back, formatted, right-aligned tabular. */}
        {leadAmountMinor !== null && (
          <div className="vorschlag-readback-row vorschlag-amount" key="__amount">
            <dt>{t('agent.field.amount')}</dt>
            <dd className="vorschlag-amount-figure t-money">{formatMoney(leadAmountMinor, 'CHF')}</dd>
          </div>
        )}
        {/* F4: a posting's LINES are the effect being approved: account, side, formatted amount. */}
        {payloadLines(action.payload)
          .slice(0, 7)
          .map((line, index) => (
            <div className="vorschlag-readback-row" key={`line-${index}`}>
              <dt>{String(line.account ?? '')}</dt>
              <dd className="t-money">
                {typeof line.debit === 'number'
                  ? `${t('agent.field.soll')} ${formatMoney(line.debit, 'CHF')}`
                  : typeof line.credit === 'number'
                    ? `${t('agent.field.haben')} ${formatMoney(line.credit, 'CHF')}`
                    : ''}
              </dd>
            </div>
          ))}
        {Object.entries(action.payload)
          .filter((pair): pair is [string, string | number] => {
            const [key, value] = pair;
            // R-F2: when `amountMinor` IS the lead figure above, the generic row would render the
            // same Betrag twice under the same label; the lead is the one that stays.
            if (key === 'amountMinor' && leadAmountMinor !== null) return false;
            return key !== 'workspaceId' && key !== 'idempotencyKey' && (typeof value === 'string' || typeof value === 'number');
          })
          .slice(0, 7)
          .map(([key, value]) => {
            // A contact id renders as the contact's NAME the engine resolved (critic phase0-installable
            // r2: a vendor IBAN draft named its vendor by id), with the id kept as the tooltip.
            const name = action.payloadLabels?.[key];
            return (
              <div className="vorschlag-readback-row" key={key}>
                <dt>{fieldLabel(t, LABELLED_FIELDS, key)}</dt>
                <dd title={name !== undefined ? String(value) : undefined}>{name ?? fieldValue(key, value)}</dd>
              </div>
            );
          })}
      </dl>

      <p className="vorschlag-provenance">
        {t('agent.card.provenance', { actor: action.actor, date })}
        {' · '}
        {t('agent.card.level', {
          level: STRONG_DEFAULT.has(capability) ? t('agent.trust.fragtImmer') : t('agent.trust.level.ask'),
        })}
      </p>
      {STRONG_DEFAULT.has(capability) && <p className="vorschlag-strong">{t('agent.trust.strongReason')}</p>}

      {showDetails && (
        <div className="vorschlag-details">
          <code>{action.actionTool}</code>
          <pre>{JSON.stringify(action.payload, null, 2)}</pre>
        </div>
      )}

      {changed && <ActionFeedback tone="warn" role="note" message={t('agent.card.changed')} />}

      {confirmingReject ? (
        <div className="vorschlag-confirm" role="group" aria-label={t('agent.card.reject')}>
          <p>{t('agent.card.rejectConfirm')}</p>
          {/* "No, and tell it why" (J5.6): optional, one line, read by the next session in the trace. */}
          <label className="vorschlag-reason">
            <span className="vorschlag-reason-label">{t('agent.card.rejectReasonLabel')}</span>
            <textarea
              className="field"
              rows={2}
              maxLength={500}
              value={rejectReason}
              disabled={busy}
              placeholder={t('agent.card.rejectReasonHint')}
              onChange={(event) => setRejectReason(event.target.value)}
            />
          </label>
          <div className="vorschlag-confirm-actions">
            <button
              type="button"
              className="btn btn--danger btn--sm"
              disabled={busy}
              onClick={() => {
                setConfirmingReject(false);
                const reason = rejectReason.trim();
                onReject(action.actionId, reason.length > 0 ? reason : undefined);
              }}
            >
              {t('agent.card.rejectYes')}
            </button>
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => setConfirmingReject(false)}>
              {t('agent.card.rejectNo')}
            </button>
          </div>
        </div>
      ) : canDecide && changed ? null : canDecide ? (
        <button
          type="button"
          className={accent ? 'btn btn--primary vorschlag-approve' : 'btn btn--secondary vorschlag-approve'}
          disabled={busy}
          onClick={() => onApprove(action.actionId, false)}
        >
          {t('agent.card.approve')}
        </button>
      ) : isDraftingActor ? (
        // F15: the drafting actor's hidden approve is the SELF-APPROVE ban, not a rights gap, and
        // pointing them at /members for it would be a false reason.
        <p className="vorschlag-needs">{t('agent.card.selfHint')}</p>
      ) : (
        <p className="vorschlag-needs">
          {t('agent.card.needs')} <Link className="link-inline" to="/members">{t('agent.card.needsHint')}</Link>
        </p>
      )}
    </article>
  );
}
