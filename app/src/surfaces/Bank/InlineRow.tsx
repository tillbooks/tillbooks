/**
 * D195 (owner, mockup v12 of 12.11.2026): THE ROW IS THE EDITOR, open or not.
 *
 * Every open line is one row: the pick box, the date, the counterparty (its name, the bank's text under it),
 * "Buchen auf" (the account, or the turnover preset, as a quiet control with a small chevron right after its
 * text, and the Buchungstext under it as an editable field), MWST (the shared Select, opening below; fixed
 * words where no code applies), the signed amount, the round check (Buchen, the ONLY Buchen of the line) and
 * Mehr right beside it. The controls are plain at rest and show a faint edge on hover or focus. A click on
 * anything that is not a control (the date, the counterparty, the amount, empty space) opens the line's
 * strip under the row (`InlineStrip`); there is no second form anywhere.
 *
 * What it books and how the check decides (the agent's Vorschlag approved as drafted, or the person's version
 * booked first) is the host's, exactly as on the D177 row (`OpenRow`): this file only lays the row out.
 */
import { useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';

import { COMMIT_TARGET_CLASS } from '../../lib/motion';
import { useT, useI18n, formatMoney } from '../../i18n';
import { OverflowMenu, type OverflowMenuItem } from '../../components/OverflowMenu';
import { PickerButton } from '../../components/AccountCombobox';
import { Select, type SelectGroup } from '../../components/Select';
import { Tooltip } from '../../components/Tooltip';
import { IconButton } from '../../components/IconButton';
import { taxCodeFieldName, taxCodeName } from '../../components/TaxCodeCombobox';
import { StatusWarnGlyph } from '../../components/icons';
import type { BankInboxLine, DraftTarget, LineVorschlag, RowDraft } from './model';
import { absAmount, bookTargetOf, composeVerdictError, isBookable, isCredit, lineDate, needsRuleChoice, proposalTarget, rowCertainty, shortDate } from './model';
import type { Lookups } from './lookups';
import { accountLabel, detailOf, partyOf, plural, targetParts, vatPickerShows } from './lookups';
import { activePreset, inlinePickerModel, resolvePick, ruleChooserModel, type PickResult, type TurnoverPreset } from './pickers';
import { restZeroReason } from './rules';
import { useTargetCompose } from './useBankCompose';
import { needsBookingPreview, previewBookState, useBookingPreview } from './BookingModes';
import { bookStateOf, takesBookingText, vatSummaryOf, type SplitState } from './rowState';
import { duplicateFlagOf } from './statementFacts';
import { SignedAmount, isRowBodyClick, onRowKeyDown, useRowDrop, type RowBehaviour } from './InboxRow';
import './InlineRow.css';

/** The kinds whose natural direction is money in: their codes lead the MWST list on a credit. */
const MONEY_IN_KINDS: ReadonlySet<string> = new Set(['output', 'zero', 'exempt']);

/** A41.8 (`feat/receipt-vat-proposal`): the receipt's VAT verdict on the line, read when the engine sends it. */
export function vatCheckOf(line: BankInboxLine): 'match' | 'differs' | 'unread' | 'none' {
  const raw = (line as BankInboxLine & { vatCheck?: unknown }).vatCheck;
  return raw === 'match' || raw === 'differs' || raw === 'unread' ? raw : 'none';
}

export interface InlineRowProps extends RowBehaviour {
  workspaceId: string;
  line: BankInboxLine;
  draft: RowDraft | undefined;
  lookups: Lookups;
  presets: readonly TurnoverPreset[];
  fresh?: boolean;
  busy: boolean;
  showCurrency: boolean;
  vorschlag: LineVorschlag | undefined;
  canBook: (target: DraftTarget) => boolean;
  canPost: boolean;
  canAttach: boolean;
  consequence: (target: DraftTarget) => string | null;
  /** Which of the row's pickers is open (the account pick hands over to MWST). */
  openPicker: 'target' | 'vat' | null;
  onOpenPicker: (picker: 'target' | 'vat' | null) => void;
  onPick: (result: PickResult) => void;
  onClear: () => void;
  onVat: (code: string) => void;
  /** The Buchungstext as it stands (the engine's default until the person types). */
  text: string;
  onText: (text: string) => void;
  onBook: () => void;
  approveMode?: 'direct' | 'review';
  onReview?: () => void;
  /** Mehr: Ignorieren, Als Regel speichern, Mit Buchung abgleichen, Beleg anhängen, Agent fragen. */
  onIgnore: () => void;
  onSaveRule: (() => void) | null;
  onLink: () => void;
  onAttach: () => void;
  onAgent: () => void;
  bookRef: (el: HTMLButtonElement | null) => void;
  picked: boolean;
  onTogglePick: () => void;
  split?: SplitState | null;
  /** The strip under the row (open) and a split's position rows. */
  after?: ReactNode;
}

export function InlineRow({
  workspaceId,
  line,
  draft,
  lookups,
  presets,
  selected,
  fresh = false,
  justCommitted = false,
  busy,
  showCurrency,
  vorschlag,
  canBook,
  canPost,
  canAttach,
  consequence,
  openPicker,
  onOpenPicker,
  onToggle,
  onDropFiles,
  accountName,
  onPick,
  onClear,
  onVat,
  text,
  onText,
  onBook,
  approveMode = 'direct',
  onReview,
  onIgnore,
  onSaveRule,
  onLink,
  onAttach,
  onAgent,
  bookRef,
  picked,
  onTogglePick,
  split = null,
  after,
}: InlineRowProps) {
  const t = useT();
  const { locale } = useI18n();
  const target = draft?.target ?? null;
  const proposal = proposalTarget(line);
  const certainty = rowCertainty(line, draft);
  const party = partyOf(t, line);
  const detail = detailOf(line);
  const preset = activePreset(presets, target);
  const choosing = needsRuleChoice(line, draft);
  const model = choosing ? ruleChooserModel(t, lookups, line) : inlinePickerModel(t, lookups, line, target, presets, canPost);
  const parts = targetParts(t, lookups, line, target);

  // Buchen's state, exactly the D177 row's: a rule's rest of zero is the engine's refusal, a target only the
  // engine's preview can judge holds the check while the preview is out, a possible duplicate waits.
  const ruleTarget = target?.kind === 'rule' ? target : null;
  const ruleCompose = useTargetCompose(workspaceId, line.bankTxnId, ruleTarget !== null && isBookable(line, ruleTarget) ? bookTargetOf(ruleTarget) : null, { debounceMs: 250 });
  const ruleRefusal = ruleCompose.status === 'answered' ? composeVerdictError(ruleCompose.answer) : ruleCompose.status === 'failed' ? ruleCompose.error : null;
  const restZero = ruleRefusal?.error === 'rest_is_zero';
  const allowed = target === null || canBook(target);
  const ruleBook = bookStateOf(t, line, target, { allowed, restZero: restZero && ruleTarget !== null ? restZeroReason(t, lookups, ruleTarget) : false, split });
  const preview = useBookingPreview(workspaceId, line, target);
  const computedBook = needsBookingPreview(target) ? previewBookState(t, locale, line, preview, ruleBook) : ruleBook;
  const duplicate = duplicateFlagOf(line);
  const book =
    duplicate !== null
      ? { enabled: false, reason: t('bankInbox.duplicate.bookWhy') }
      : choosing && computedBook.reason !== null
        ? { ...computedBook, reason: t('bankInbox.book.why.rule') }
        : computedBook;
  const drop = useRowDrop(onDropFiles);
  const behaviour: RowBehaviour = { selected, onToggle, onDropFiles };
  const amountWords = formatMoney(absAmount(line), line.currency);
  const singleLeg = split === null && target?.kind === 'accounts' && target.legs.length === 1 ? target.legs[0] : undefined;
  const [textDraft, setTextDraft] = useState<string | null>(null);

  // --- Buchen auf -------------------------------------------------------------------------------------
  const picker = (
    <PickerButton
      label={choosing ? t('bankInbox.rules.chooser.label', { party }) : t('bankInbox.row.targetLabel', { party })}
      options={model.options}
      groups={model.groups}
      value={model.value}
      onChange={(id) => {
        const result = resolvePick(lookups, line, id, proposal, vorschlag);
        if (result.kind === 'clear') onClear();
        else onPick(result);
      }}
      searchLabel={t('bankInbox.inline.search')}
      noMatchLabel={t('bankInbox.picker.noMatch')}
      open={openPicker === 'target'}
      onOpenChange={(open) => onOpenPicker(open ? 'target' : null)}
      disabled={busy}
      className={`bank-quiet bank-quiet--target${target === null ? ' bank-quiet--empty' : ''}`}
      width={360}
    >
      {target === null ? (
        <span className="picker-trigger__placeholder">{t(choosing ? 'bankInbox.rules.chooser.placeholder' : 'bankInbox.row.targetPlaceholder')}</span>
      ) : preset !== null ? (
        <span className="picker-trigger__name">{preset.name}</span>
      ) : split !== null ? (
        <span className="picker-trigger__name">{plural(t, 'bankInbox.split.rowLabel', split.positions)}</span>
      ) : (
        <>
          {parts.code !== '' && <span className="picker-trigger__code t-num">{parts.code}</span>}
          <span className="picker-trigger__name">{parts.name}</span>
        </>
      )}
    </PickerButton>
  );
  const shownText = textDraft ?? text;
  const textField = takesBookingText(target) ? (
    <input
      type="text"
      className="bank-quiet-text"
      aria-label={t('bankInbox.inline.textLabel', { party })}
      value={shownText}
      disabled={busy}
      onChange={(e) => setTextDraft(e.target.value)}
      onBlur={() => {
        if (textDraft !== null && textDraft !== text) onText(textDraft);
        setTextDraft(null);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') setTextDraft(null);
      }}
    />
  ) : null;

  // --- MWST ---------------------------------------------------------------------------------------------
  const vatCheck = vatCheckOf(line);
  const fixed = (words: string, reason: string) => (
    <Tooltip content={reason}>
      <span className="bank-vat-fixed" tabIndex={0} data-vat-fixed="">
        {words}
      </span>
    </Tooltip>
  );
  let vatCell: ReactNode = null;
  if (target === null) {
    vatCell = null;
  } else if (preset !== null) {
    vatCell = fixed(t('bankInbox.inline.vatInSettlement'), t('bankInbox.inline.vatInSettlementTip', { name: preset.name }));
  } else if (singleLeg !== undefined && vatPickerShows(lookups, singleLeg)) {
    const date = lineDate(line);
    const inKinds = (kind: string) => MONEY_IN_KINDS.has(kind);
    const fits = lookups.taxCodes.filter((c) => inKinds(c.kind) === isCredit(line));
    const others = lookups.taxCodes.filter((c) => inKinds(c.kind) !== isCredit(line));
    // D195 (owner): the open list and the hover say the full name with its Ziffer; the row says the short one.
    const full = (c: (typeof lookups.taxCodes)[number]) => {
      const name = taxCodeFieldName(t, c, date);
      return c.formLine !== undefined && c.formLine !== '' ? t('bankInbox.inline.vatWithZiffer', { name, ziffer: c.formLine }) : name;
    };
    const opt = (c: (typeof lookups.taxCodes)[number]) => ({ value: c.code, label: full(c) });
    const chosen = lookups.taxCodes.find((c) => c.code === singleLeg.taxCode);
    const shortLabel = chosen === undefined ? t('taxCode.none') : taxCodeName(t, chosen, date);
    const hover = chosen === undefined ? t('taxCode.none') : full(chosen);
    const groups: SelectGroup[] = [
      { label: t(isCredit(line) ? 'bankInbox.row.vatGroupIn' : 'bankInbox.row.vatGroupOut'), options: fits.map(opt) },
      ...(others.length > 0 ? [{ label: t('bankInbox.row.vatGroupOther'), options: others.map(opt) }] : []),
    ];
    vatCell = (
      <Select
        ariaLabel={t('bankInbox.row.vatLabel', { party })}
        value={singleLeg.taxCode}
        options={[{ value: '', label: t('taxCode.none') }]}
        groups={groups}
        onChange={onVat}
        disabled={busy}
        popMinWidth={280}
        displayLabel={shortLabel}
        className={`bank-quiet-select${vatCheck === 'differs' ? ' bank-quiet-select--warn' : ''}`}
      />
    );
    vatCell = <Tooltip content={vatCheck === 'differs' ? `${hover}. ${t('bankInbox.inline.vatDiffers')}` : hover}>{vatCell}</Tooltip>;
  } else if (singleLeg !== undefined) {
    vatCell = fixed(t('bankInbox.inline.vatNone'), t('bankInbox.row.vatNotApplicable', { account: accountLabel(lookups, singleLeg.accountId) || parts.name }));
  } else {
    const summary = vatSummaryOf(t, lookups, target);
    vatCell = summary === null ? null : <span className="bank-vat-fixed">{summary}</span>;
  }

  // --- the check: Buchen, the line's one money commit (A41.5, D184 point 7) -------------------------------
  const match = target?.kind === 'existing_entry';
  const ignoring = target?.kind === 'ignore';
  const sentence = !book.enabled ? book.reason : match ? t('bankInbox.link.consequence') : ignoring ? t('bankInbox.ignore.consequence') : target === null ? null : consequence(target);
  const inert = busy || !book.enabled;
  const approvesVorschlag = vorschlag !== undefined && vorschlag.actionTool === 'book_bank_line' && draft?.source === 'agent';
  const review = approveMode === 'review';
  const said = [review && book.enabled ? t('bankInbox.row.approve.review') : '', sentence ?? ''].filter((x) => x !== '').join('. ');
  const onCheckKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    // A held Enter or Space repeats: the repeat never books (critic F3).
    if (e.repeat && (e.key === 'Enter' || e.key === ' ')) e.preventDefault();
  };
  const check = (
    <span className="bank-row__approve-slot" ref={(el) => bookRef(el?.querySelector('button') ?? null)}>
      <IconButton
        icon="approve"
        name={match ? t('bankInbox.row.match') : ignoring ? t('bankInbox.row.ignoreRule') : approvesVorschlag ? t('bankInbox.row.approve.vorschlag') : t('bankInbox.row.book')}
        context={said !== '' ? said : t('bankInbox.row.approve.context', { party, amount: amountWords })}
        small
        placement="bottom"
        className="bank-row__book bank-row__approve bank-check"
        data-certainty={certainty}
        data-approve-mode={approveMode}
        aria-disabled={inert ? true : undefined}
        aria-busy={busy ? true : undefined}
        onKeyDown={onCheckKey}
        onClick={(e: MouseEvent<HTMLButtonElement>) => {
          e.stopPropagation();
          if (inert) return;
          if (review && onReview !== undefined) onReview();
          else onBook();
        }}
      />
    </span>
  );

  // --- Mehr ---------------------------------------------------------------------------------------------
  const menu: OverflowMenuItem[] = [];
  if (canPost) menu.push({ key: 'ignore', label: t('bankInbox.inline.menu.ignore'), onSelect: onIgnore });
  if (canPost && onSaveRule !== null) menu.push({ key: 'rule', label: t('bankInbox.inline.menu.rule'), onSelect: onSaveRule });
  if (canPost) menu.push({ key: 'link', label: t('bankInbox.inline.menu.link'), onSelect: onLink });
  if (canAttach) menu.push({ key: 'attach', label: t('bankInbox.inline.menu.attach'), onSelect: onAttach });
  menu.push({ key: 'agent', label: t('bankInbox.inline.menu.agent'), onSelect: onAgent });

  return (
    <>
      <tr
        className={`bank-row bank-row--inline${fresh ? ` ${COMMIT_TARGET_CLASS}` : ''}`}
        tabIndex={0}
        aria-current={selected ? 'true' : undefined}
        aria-busy={busy ? true : undefined}
        data-selected={selected ? 'true' : undefined}
        data-just-committed={justCommitted ? '' : undefined}
        data-fresh={fresh ? 'true' : undefined}
        data-drop={drop.over ? 'true' : undefined}
        data-line={line.bankTxnId}
        data-certainty={certainty}
        data-picked={picked ? 'true' : undefined}
        data-splitting={split !== null ? 'true' : undefined}
        data-duplicate={duplicate !== null ? 'true' : undefined}
        onClick={(e) => {
          if (isRowBodyClick(e)) onToggle();
        }}
        onKeyDown={(e) => onRowKeyDown(e, behaviour)}
        {...drop.handlers}
      >
        <td className="bank-cell bank-cell--pick">
          <label className="check-cell">
            <input type="checkbox" checked={picked} onChange={onTogglePick} aria-label={t('bankInbox.pick.row', { party, amount: formatMoney(line.amountMinor, line.currency) })} />
          </label>
        </td>
        <td className="bank-cell bank-cell--date t-num">{shortDate(lineDate(line))}</td>
        <td className="bank-cell bank-cell--party">
          <span className="bank-two">
            <span className="bank-two__a">
              {duplicate !== null && (
                <span className="bank-dup-mark" role="img" aria-label={t('bankInbox.duplicate.mark')} data-duplicate="">
                  <StatusWarnGlyph size={16} />
                </span>
              )}
              <span className="bank-party">{party}</span>
            </span>
            {(detail !== '' || accountName !== undefined) && <span className="bank-two__b">{[detail, accountName ?? ''].filter((x) => x !== '').join(' · ')}</span>}
          </span>
        </td>
        <td className="bank-cell bank-cell--target">
          <span className="bank-two">
            <span className="bank-two__a">{picker}</span>
            {textField}
          </span>
        </td>
        <td className="bank-cell bank-cell--vat">{vatCell}</td>
        <td className="bank-cell bank-cell--amount">
          <SignedAmount minor={line.amountMinor} currency={line.currency} showCurrency={showCurrency} />
        </td>
        <td className="bank-cell bank-cell--book">{check}</td>
        <td className="bank-cell bank-cell--ignore">
          <OverflowMenu quiet portal icon="more" className="bank-row-menu bank-more" label={t('bankInbox.row.more', { party, amount: amountWords })} tooltip={t('bankInbox.inline.moreTip')} items={menu} disabled={busy} />
        </td>
      </tr>
      {after}
    </>
  );
}
