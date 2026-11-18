/**
 * D208 (owner, 18.11.2026, every pick A): THE ONE Vorschlag row of Pendenzen and of the Übersicht card.
 *
 *  - ONE COMPACT LINE: the counterparty, the booking text (dim), the source glyph with the account (faint),
 *    the date, the amount. No row rule, no dashed line, no lead glyph, no certainty dots: the hover tint only.
 *    The amount: incoming money a small `--t-success` plus before the figure in ink, outgoing a minus in
 *    `--t-danger`, the sign only (DESIGN.md Money, amended by D208).
 *  - THE SOURCE GLYPH before the account: a small filled star when a Buchungsregel books it (its tooltip names
 *    the rule and since when), the agent's mark when the agent proposed it, nothing for TILL's default. Its
 *    words live in the tooltip and the accessible name only (DESIGN.md "Words on demand").
 *  - ROW ACTIONS on hover, focus-within, the selected row and touch (D210: ONE trio, open or closed, never
 *    moving): Ablehnen, the outline star (Freigeben und als Regel speichern, D207's one click), Freigeben (the
 *    check in a ring). While the line is open they act on its values: the check books them, the star books
 *    them and keeps them as the rule.
 *  - ONE HINT, only when something is missing (`attention.row_hints`): a missing Beleg on a line that claims
 *    Vorsteuer, the paperclip in `--t-warn`, no word beside it; a click attaches.
 *  - A CLICK OPENS ONE LINE beneath (`OpenLine`): the booking text, the account and the MWST code without
 *    visible labels, then the Beleg and the payout warning when they apply. D210: no second set of icons; the
 *    account list carries the ways on (Als Umsatz buchen on money in, In Bank öffnen for the rule editor, the
 *    split and the Durchlaufkonto), and only a line without an account list keeps Öffnen as an icon.
 */
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode, type Ref } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { formatDate, formatMoney, useI18n } from '../../i18n';
import { useClient } from '../../lib/client-context';
import { isErr } from '../../lib/client';
import { useWorkspaceId } from '../../app/workspace';
import { useCan, useCapabilities } from '../../lib/capabilities';
import { IconButton } from '../../components/IconButton';
import { Tooltip } from '../../components/Tooltip';
import { Select, type SelectGroup } from '../../components/Select';
import { Status } from '../../components/Status';
import { AgentMarkGlyph, StatusWarnGlyph, VOCABULARY } from '../../components/icons';
import { taxCodeFieldName } from '../../components/TaxCodeCombobox';
import { RejectControl } from '../Agent/RejectControl';
import { useBelegOpen } from '../Agent/VorschlagBelege';
import type { RowFacts, VorschlagItem } from '../Agent/vorschlagView';
import type { ChartAccount, TaxCode } from '../Bank/model';
import { isRevenueNumber, type DraftLeg, type RuleInfo, type Source } from './lineContext';
import './PendenzLine.css';

const StarGlyph = VOCABULARY.rule.glyph;
const WarnClip = VOCABULARY.attach.glyph;

/**
 * A signed amount, D208: "CHF -42.75" with the minus alone in `--t-danger`, "CHF +42.75" with a small plus in
 * `--t-success` for money that came IN on a bank line (`plus`); the figure stays in ink (DESIGN.md Money). An
 * amount that is no bank movement (a posting's total) carries no plus. The sign is text: a screen reader reads it.
 */
export function SignedPlusAmount({ minor, currency, plus = true }: { minor: number; currency: string; plus?: boolean }) {
  const text = formatMoney(minor, currency);
  const at = text.indexOf(' ') + 1;
  const head = text.slice(0, at);
  const digits = minor < 0 ? text.slice(at + 1) : text.slice(at);
  return (
    <span className="pl-amount t-money">
      {head}
      {(minor < 0 || (minor > 0 && plus)) && <span className={minor < 0 ? 'pl-sign pl-sign--out' : 'pl-sign pl-sign--in'}>{minor < 0 ? '-' : '+'}</span>}
      {digits}
    </span>
  );
}

/** The source glyph's words: the rule and since when, or the agent. */
export function sourceWords(t: (key: string, p?: Record<string, string | number>) => string, source: Source): string | null {
  if (source === null) return null;
  if (source.kind === 'agent') return t('attention.line.sourceAgent');
  const since = /^\d{4}-\d{2}-\d{2}/.test(source.rule.setAt) ? formatDate(source.rule.setAt.slice(0, 10)) : '';
  return since === '' ? t('attention.line.sourceRuleNoDate', { name: source.rule.name }) : t('attention.line.sourceRule', { name: source.rule.name, since });
}

function SourceMark({ source }: { source: Source }) {
  const { t } = useI18n();
  const words = sourceWords(t, source);
  if (source === null || words === null) return null;
  return (
    <Tooltip content={words} align="start">
      <span className={source.kind === 'rule' ? 'pl-source pl-source--rule' : 'pl-source pl-source--agent'} data-source={source.kind}>
        {source.kind === 'rule' ? <StarGlyph size={16} fill="currentColor" /> : <AgentMarkGlyph size={16} />}
        <span className="visually-hidden">{words}</span>
      </span>
    </Tooltip>
  );
}

/** What the open line commits. `changed`: the person changed the text, the account or the code. */
export interface LineCommit {
  text: string;
  accountId: string | null;
  taxCode: string | null;
  changed: boolean;
  textChanged: boolean;
  star: boolean;
  /** The comment to the agent, only when the person EDITED it (undefined: left as it is, critic D208 LOW-2). */
  note: string | undefined;
}

/** The open line of a bank booking (the editable leg) or of any other Vorschlag (read only). */
export interface OpenLineSpec {
  /** The booking text as it would be booked now. */
  text: string | null;
  /** The editable leg (a booking of the whole line to one account), or null (the text only, or nothing). */
  leg: DraftLeg | null;
  chart: readonly ChartAccount[];
  taxCodes: readonly TaxCode[];
  /** Money in: the account list leads with income, the payout check runs. */
  incoming: boolean;
  /** The rule this booking comes from (the star adapts it), else null. */
  rule: RuleInfo | null;
  /** The comment of the rule the star keeps (the adapted rule, or a slot rule with the same booking): the bubble starts with it. */
  ruleNote?: string | null;
  /** The other rule standing in the slot the star would fill (it replaces it), by name; null when none. */
  replaces?: string | null;
  /** The star may save a rule here (a bank booking the person may approve). */
  starOffered: boolean;
  /** Where Öffnen leads: the line in Bank; with the star pressed, the rule in Bank's rule editor. */
  lineHref: string | null;
  ruleHref: string | null;
  /** D210: money in, "Als Umsatz buchen" in the account list: Bank's presets for this line, or Umsatz Regeln. */
  turnoverHref?: string | null;
  /** The bank line, for the payout check. */
  bankTxnId: string | null;
  /** The read-only words of a Vorschlag that is not a booking (one line, no labels). */
  readback?: string | null;
  onCommit: (values: LineCommit) => void;
  /** Any edit of the line (critic D208 r2, LOW-B): a confirm asked for earlier values no longer stands. */
  onEdit?: () => void;
}

/** The open line's commit, for the row's own Freigeben and star while the line holds edits. */
interface OpenLineCommitter {
  commit: (star: boolean) => void;
  canStar: boolean;
}

export interface PendenzLineProps {
  action: VorschlagItem;
  facts: RowFacts;
  source: Source;
  /** The missing-Beleg hint (already filtered by `attention.row_hints`). */
  hint?: boolean;
  onAttach?: (file: File) => void;
  /** The batch box, or nothing. */
  box?: ReactNode;
  busy?: boolean;
  offers?: { approve: boolean; reject: boolean };
  onApprove: () => void;
  onReject: () => void;
  /** D207's one click, as the star: approve and save the Buchungsregel. Absent: no star on the row. */
  onStar?: () => void;
  /** The other rule the star's save would replace, by name: the star says so in its name and tooltip. */
  starReplaces?: string | null;
  approveLabel?: string;
  rejectLabel?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The open line; null shows nothing beneath. */
  openLine: OpenLineSpec | null;
  /** Shown first in the open line (the rule confirm of `attention.auto_rule_confirm = always`). */
  detailSlot?: ReactNode;
  /** A refusal, a batch's running word: said under the subject. */
  status?: { tone: 'running' | 'ok' | 'error'; text: string } | null;
  recovery?: { label: string; onClick: () => void } | null;
  staleText?: string;
  rowRef?: Ref<HTMLButtonElement>;
  rowTabIndex?: number;
  current?: boolean;
  onRowFocus?: () => void;
  /**
   * The row's keys. `approve` is the row's own Freigeben: while the open line holds edits it commits THOSE
   * (critic D208, 6: F never approves the original past the person's edits).
   */
  onRowKeyDown?: (event: KeyboardEvent<HTMLButtonElement>, approve: () => void) => void;
}

export function PendenzLine({
  action,
  facts,
  source,
  hint = false,
  onAttach,
  box,
  busy = false,
  offers = { approve: true, reject: true },
  onApprove,
  onReject,
  onStar,
  starReplaces = null,
  approveLabel,
  rejectLabel,
  open,
  onOpenChange,
  openLine,
  detailSlot,
  status = null,
  recovery = null,
  staleText,
  rowRef,
  rowTabIndex,
  current = false,
  onRowFocus,
  onRowKeyDown,
}: PendenzLineProps) {
  const { t } = useI18n();
  const openId = useId();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const whoami = useCapabilities().whoami;
  const isDraftingActor = whoami?.actor === action.actor;
  const canDecide = useCan('manage_agent_dial') && !isDraftingActor;
  const changed = action.changedSinceProposal === true;
  // The open line's edits: while it holds any, the row's Freigeben (button and F) commits them.
  const [dirty, setDirty] = useState(false);
  const commitRef = useRef<OpenLineCommitter | null>(null);
  const approveRow = () => {
    if (dirty && open && commitRef.current !== null) commitRef.current.commit(false);
    else onApprove();
  };
  // Critic D208 r2 (MEDIUM-A): the row's star with edits in the open line saves THOSE as the rule, through the
  // open line's own commit with the star pressed (one behaviour), never the agent's original.
  // With edits in an open line that offers no star, the row star is disabled, never a silent no-op (critic r3).
  const starBlocked = dirty && open && openLine?.starOffered !== true;
  // D210: the line's own star is gone. While the line is open and offers a rule, the row star IS that star
  // pressed plus the commit (the D208 path through `commitOpenLine`, with its shown-slot pin), edits or not;
  // a closed row, or an open one whose booking offers no line rule, keeps D207's one click (`onStar`).
  const lineStar = open && openLine?.starOffered === true;
  const starShown = onStar !== undefined || lineStar;
  const starRow = () => {
    if (starBlocked) return;
    // Critic r2 LOW-1: an open line that offers a rule never falls back to the agent's original plan.
    if (lineStar) {
      if (commitRef.current?.canStar === true) commitRef.current.commit(true);
      return;
    }
    onStar?.();
  };
  const starName =
    open && openLine?.rule != null
      ? t('attention.line.adaptRule')
      : starReplaces !== null
        ? t('attention.line.approveAndReplace', { name: starReplaces })
        : open && openLine?.replaces != null
          ? t('attention.line.replacesRule', { name: openLine.replaces })
          : t('attention.line.approveAndRule');
  const text = openLine?.text ?? (typeof action.payload.text === 'string' ? action.payload.text : (action.lineFacts?.text ?? null));
  const textShown = text !== null && text !== facts.subject ? text : null;

  let acts: ReactNode = null;
  if (status?.tone === 'running') {
    acts = (
      <span className="pl-hint-word" role="status">
        {status.text}
      </span>
    );
  } else if (status?.tone === 'ok') {
    acts = <Status kind="success" label={status.text} />;
  } else if (canDecide) {
    // D210: one fixed trio in reading order Ablehnen, star, Freigeben; the check is the act, so it sits last.
    acts = (
      <>
        {offers.reject && <RejectControl small context="" busy={busy} {...(rejectLabel !== undefined ? { name: rejectLabel } : {})} onReject={() => onReject()} />}
        {changed && recovery !== null && <IconButton icon="open" small name={recovery.label} context="" onClick={recovery.onClick} />}
        {offers.approve && starShown && !changed && (
          <IconButton
            icon="rule"
            small
            className="pl-star"
            name={starName}
            context={open && openLine?.rule != null ? openLine.rule.name : ''}
            aria-disabled={busy || starBlocked ? true : undefined}
            onClick={() => {
              if (!busy) starRow();
            }}
          />
        )}
        {offers.approve && (
          <IconButton
            icon="approve"
            small
            className={[open ? 'pl-approve pl-commit' : 'pl-approve', changed ? 'pl-approve--disabled' : ''].filter(Boolean).join(' ')}
            name={open && dirty ? t('attention.line.book') : (approveLabel ?? t('attention.line.approve'))}
            context={changed ? t('agent.vq.staleReason') : ''}
            aria-disabled={changed || busy ? true : undefined}
            onClick={() => {
              if (!changed && !busy) approveRow();
            }}
          />
        )}
      </>
    );
  } else if (changed && recovery !== null) {
    acts = <IconButton icon="open" small name={recovery.label} context="" onClick={recovery.onClick} />;
  } else if (isDraftingActor) {
    acts = <span className="pl-hint-word">{t('agent.card.selfHint')}</span>;
  } else {
    acts = (
      <Link className="link-inline pl-hint-word" to="/members">
        {t('agent.card.needs')}
      </Link>
    );
  }

  const stateLine =
    status?.tone === 'error' ? (
      <Status kind="warn" label={status.text} className="pl-state" />
    ) : changed && status === null ? (
      <Status kind="warn" label={staleText ?? t('agent.vq.staleRow')} className="pl-state" />
    ) : null;

  return (
    <article
      className={['pl', open ? 'pl--open' : '', current ? 'pl--current' : ''].filter(Boolean).join(' ')}
      data-action-id={action.actionId}
      data-changed={changed ? 'true' : undefined}
      data-open={open ? 'true' : undefined}
    >
      <div className="pl-line">
        <span className="pl-box">{box}</span>
        <button
          type="button"
          className="pl-main"
          ref={rowRef}
          tabIndex={rowTabIndex}
          aria-current={current ? 'true' : undefined}
          aria-expanded={openLine !== null || detailSlot !== undefined ? open : undefined}
          aria-controls={open ? openId : undefined}
          onClick={() => onOpenChange(!open)}
          onFocus={onRowFocus}
          onKeyDown={onRowKeyDown === undefined ? undefined : (e) => onRowKeyDown(e, approveRow)}
        >
          <span className="pl-text">
            <span className="pl-name">{facts.subject}</span>
            {textShown !== null && <span className="pl-dim">{textShown}</span>}
            {facts.kind !== '' && facts.kind !== facts.subject && (
              <span className="pl-account">
                <SourceMark source={source} />
                <span className="pl-account-text" data-figure="key">
                  {facts.kind}
                </span>
              </span>
            )}
          </span>
          <span className={facts.dateIsProposal === true ? 'pl-date pl-date--proposal t-num' : 'pl-date t-num'}>{facts.date ?? ''}</span>
          <span className="pl-amount-cell">{facts.amountMinor !== null ? <SignedPlusAmount minor={facts.amountMinor} currency={facts.currency} plus={facts.direction === 'in'} /> : null}</span>
        </button>
        <span className="pl-hint-cell">
          {hint && onAttach !== undefined && (
            <>
              <IconButton
                icon="attach"
                small
                className="pl-hint"
                name={t('attention.line.attach')}
                context={t('attention.line.missingBeleg')}
                disabled={busy}
                onClick={() => fileRef.current?.click()}
              />
              <input
                ref={fileRef}
                type="file"
                hidden
                accept="application/pdf,image/*"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  if (file !== undefined) onAttach(file);
                }}
              />
            </>
          )}
          {hint && onAttach === undefined && (
            <Tooltip content={t('attention.line.missingBeleg')}>
              <span className="pl-hint pl-hint--glyph">
                <WarnClip size={16} />
                <span className="visually-hidden">{t('attention.line.missingBeleg')}</span>
              </span>
            </Tooltip>
          )}
        </span>
        <span className="pl-acts">{acts}</span>
      </div>
      {stateLine !== null && <div className="pl-stateline">{stateLine}</div>}
      {open && (openLine !== null || detailSlot !== undefined) && (
        <div id={openId} className="pl-open motion-reveal--under">
          {detailSlot}
          {openLine !== null && <OpenLine action={action} spec={openLine} canDecide={canDecide && !changed} busy={busy} onDirty={setDirty} commitRef={commitRef} />}
        </div>
      )}
    </article>
  );
}

/**
 * The account list for the open line: income first for money in, expenses first for money out. The account
 * the booking names now is always in it (critic D208 LOW-4), even one the list otherwise leaves out, so the
 * trigger never shows blank while a value is booked.
 */
function accountGroups(t: (key: string) => string, chart: readonly ChartAccount[], incoming: boolean, current: string | null): SelectGroup[] {
  const usable = chart.filter((a) => !['1170', '1171', '2200', '2201', '1100', '2000'].includes(a.number) || a.id === current || a.number === current);
  const first = usable.filter((a) => (incoming ? a.number.startsWith('3') : /^[4-8]/.test(a.number)));
  const rest = usable.filter((a) => !first.includes(a));
  const opt = (a: ChartAccount) => ({ value: a.id, label: `${a.number} ${a.name}` });
  const unknown = current !== null && !chart.some((a) => a.id === current || a.number === current);
  return [
    ...(unknown ? [{ label: t('attention.line.accountsOther'), options: [{ value: current, label: current }] }] : []),
    ...(first.length > 0 ? [{ label: t(incoming ? 'attention.line.accountsIn' : 'attention.line.accountsOut'), options: first.map(opt) }] : []),
    ...(rest.length > 0 ? [{ label: t('attention.line.accountsOther'), options: rest.map(opt) }] : []),
  ];
}

/** The ONE line beneath an open row (D208 point 4). */
function OpenLine({
  action,
  spec,
  canDecide,
  busy,
  onDirty,
  commitRef,
}: {
  action: VorschlagItem;
  spec: OpenLineSpec;
  canDecide: boolean;
  busy: boolean;
  onDirty: (dirty: boolean) => void;
  commitRef: { current: OpenLineCommitter | null };
}) {
  const { t } = useI18n();
  const client = useClient();
  const workspaceId = useWorkspaceId();
  const navigate = useNavigate();
  const beleg = useBelegOpen(action.actionId);
  const leg = spec.leg;
  const [text, setText] = useState(spec.text ?? '');
  const [accountId, setAccountId] = useState<string | null>(leg?.accountId ?? null);
  const [taxCode, setTaxCode] = useState<string | null>(leg?.taxCode ?? null);
  const [payout, setPayout] = useState(false);

  // D208 point 10: a payout line (a processor's payout to the clearing account) is checked once, on open.
  useEffect(() => {
    if (!spec.incoming || spec.bankTxnId === null || workspaceId === null) return undefined;
    let live = true;
    void (async () => {
      try {
        const res = await client.call('settlement_payout_for_bank_line', { workspaceId, bankTxnId: spec.bankTxnId });
        if (!live || isErr(res.body)) return;
        const matches = (res.body as { matches?: unknown }).matches;
        setPayout(Array.isArray(matches) && matches.length > 0);
      } catch {
        // No feed, no warning: the warning only ever adds a fact.
      }
    })();
    return () => {
      live = false;
    };
  }, [client, spec.bankTxnId, spec.incoming, workspaceId]);

  const account = spec.chart.find((a) => a.id === accountId || a.number === accountId);
  const textChanged = spec.text !== null && text.trim() !== spec.text.trim() && text.trim() !== '';
  const legChanged = leg !== null && (accountId !== leg.accountId || (taxCode ?? null) !== (leg.taxCode ?? null));
  const changed = textChanged || legChanged;
  const payoutWarn = payout && isRevenueNumber(account?.number);
  const belege = action.belege ?? [];
  // D210: the ways on live in the account list; a line without one keeps Öffnen as its only icon.
  const turnoverHref = spec.turnoverHref ?? null;
  const ACT_TURNOVER = 'act:turnover';
  const ACT_BANK = 'act:bank';
  // Critic r1 LOW: a door never drops edits silently, so the doors leave the list while the line holds edits.
  const wayGroups: SelectGroup[] = changed ? [] : [
    {
      label: t('attention.line.waysGroup'),
      options: [
        ...(turnoverHref !== null ? [{ value: ACT_TURNOVER, label: t('attention.line.toTurnover') }] : []),
        ...(spec.lineHref !== null ? [{ value: ACT_BANK, label: t('attention.line.inBank') }] : []),
      ],
    },
  ].filter((g) => g.options.length > 0);

  // The drafted code is always in the list (critic D208 LOW-4), even one the book's list does not hold.
  const taxOptions = spec.taxCodes.map((c) => ({ value: c.code, label: taxCodeFieldName(t, c) }));
  if (taxCode !== null && !spec.taxCodes.some((c) => c.code === taxCode)) taxOptions.unshift({ value: taxCode, label: taxCode });
  const taxGroups: SelectGroup[] = [{ label: t('attention.line.vatCodes'), options: taxOptions }];
  // An emptied text books the old one, so the field shows it again (critic D208 LOW-3).
  const restoreText = () => {
    if (text.trim() === '' && spec.text !== null) setText(spec.text);
  };
  const commit = (rowStar = false) => {
    restoreText();
    spec.onCommit({
      text: text.trim() === '' ? (spec.text ?? '').trim() : text.trim(),
      accountId,
      taxCode,
      changed,
      textChanged,
      star: rowStar,
      // D210: the rule's comment is edited in Bank's rule editor (In Bank öffnen); here it stays as it is.
      note: undefined,
    });
  };
  const dirty = changed;
  useEffect(() => {
    onDirty(dirty);
  }, [dirty, onDirty]);
  useEffect(() => () => onDirty(false), [onDirty]);
  useEffect(() => {
    commitRef.current = canDecide && !busy ? { commit, canStar: spec.starOffered } : null;
  });

  return (
    <div className="pl-edit" role="group" aria-label={t('attention.line.openLabel')}>
      <div className="pl-edit-line">
        {spec.readback !== undefined && spec.readback !== null ? (
          <span className="pl-readback">{spec.readback}</span>
        ) : (
          <>
            {spec.text !== null && (
              <Tooltip content={t('attention.line.text')}>
                <input
                  className="field pl-field pl-field--text"
                  type="text"
                  value={text}
                  maxLength={200}
                  aria-label={t('attention.line.text')}
                  disabled={!canDecide || busy}
                  onChange={(e) => {
                    setText(e.target.value);
                    spec.onEdit?.();
                  }}
                  onBlur={restoreText}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && canDecide && !busy) {
                      e.preventDefault();
                      commit();
                    }
                  }}
                />
              </Tooltip>
            )}
            {leg !== null && (
              <>
                <Tooltip content={t('attention.line.account')}>
                  <span className="pl-field pl-field--account">
                    <Select
                      ariaLabel={t('attention.line.account')}
                      value={account?.id ?? accountId ?? ''}
                      groups={[...accountGroups(t, spec.chart, spec.incoming, accountId), ...wayGroups]}
                      placeholder={t('attention.line.account')}
                      displayLabel={account !== undefined ? `${account.number} ${account.name}` : undefined}
                      popMinWidth={280}
                      disabled={!canDecide || busy}
                      onChange={(v) => {
                        // D210: the two ways on are doors, never an account.
                        if (v === ACT_TURNOVER && turnoverHref !== null) {
                          navigate(turnoverHref);
                          return;
                        }
                        if (v === ACT_BANK && spec.lineHref !== null) {
                          navigate(spec.lineHref);
                          return;
                        }
                        setAccountId(v);
                        spec.onEdit?.();
                        // D152 rule 1: the account's own default code, visible and changeable.
                        const next = spec.chart.find((a) => a.id === v);
                        if (next !== undefined && next.vatCodeDefault !== null) setTaxCode(next.vatCodeDefault);
                      }}
                    />
                  </span>
                </Tooltip>
                <Tooltip content={t('attention.line.vat')}>
                  <span className="pl-field pl-field--vat">
                    <Select
                      ariaLabel={t('attention.line.vat')}
                      value={taxCode ?? ''}
                      options={[{ value: '', label: t('taxCode.none') }]}
                      groups={taxGroups}
                      popMinWidth={260}
                      disabled={!canDecide || busy}
                      onChange={(v) => {
                        setTaxCode(v === '' ? null : v);
                        spec.onEdit?.();
                      }}
                    />
                  </span>
                </Tooltip>
              </>
            )}
          </>
        )}
        <span className="pl-edit-acts">
          {belege.length > 0 && (
            <IconButton icon="attach" small name={t('attention.line.beleg')} context={belege[0]?.filename ?? ''} onClick={() => void beleg.open(belege[0] as (typeof belege)[number])} />
          )}
          {payoutWarn && (
            <Tooltip content={t('attention.line.payoutWarn')}>
              <span className="pl-warn" role="img" aria-label={t('attention.line.payoutWarn')}>
                <StatusWarnGlyph size={16} />
              </span>
            </Tooltip>
          )}
          {/* Also while the account list cannot open (no right to decide, critic r1 LOW): the way into Bank stays. */}
          {(leg === null || !canDecide) && spec.lineHref !== null && (
            <IconButton icon="open" small context={t('attention.line.openLine')} onClick={() => navigate(spec.lineHref as string)} />
          )}
        </span>
      </div>
    </div>
  );
}
