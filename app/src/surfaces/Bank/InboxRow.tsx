/**
 * One bank line, decided on its own row (the judge's outcome 2): date, counterparty, what it will be
 * booked to, the VAT, the amount, and the one button its advice names. One row, one
 * baseline, the row height the density token sets (K-20): the pickers are 32px controls inside it.
 *
 * Clicking anywhere on the row selects it (the panel beside or under it shows the reason, the
 * Soll/Haben preview); focusing any control on it does the same, so a keyboard walk
 * down the list keeps the panel with the row being decided.
 *
 * Who acts next is on the row, in words: "Buchen" (you confirm what the engine or you prepared),
 * "Abgleichen" (the money is already on the books, only the link is missing), "Prüfen" (the agent
 * proposed something; you decide), and the certainty glyph and word beside the target say why.
 */
import type { ReactNode } from 'react';

import { useT, formatMoney } from '../../i18n';
import { OverflowMenu, type OverflowMenuItem } from '../../components/OverflowMenu';
import { PickerButton } from '../../components/AccountCombobox';
import { TaxCodeCombobox } from '../../components/TaxCodeCombobox';
import { Tooltip } from '../../components/Tooltip';
import type { BankInboxLine, DraftTarget, LineVorschlag, RowCertainty, RowDraft } from './model';
import { absAmount, isBookable, isCredit, proposalTarget, rowCertainty, shortDate, lineDate } from './model';
import type { Lookups } from './lookups';
import { detailOf, partyOf, targetParts } from './lookups';
import { resolvePick, targetPickerModel, type PickResult } from './pickers';
import { AgentGlyph, CheckGlyph, EditedGlyph, LearnedGlyph, OpenGlyph, SureGlyph } from './glyphs';

export type RowMenuAction = 'split' | 'link' | 'agent' | 'ignore';

export interface OpenRowProps {
  line: BankInboxLine;
  draft: RowDraft | undefined;
  lookups: Lookups;
  selected: boolean;
  /** The line arrived with the import just made: it carries the landing tint once. */
  fresh?: boolean;
  busy: boolean;
  /** Show the currency beside the amount (the list mixes currencies). */
  showCurrency: boolean;
  vorschlag: LineVorschlag | undefined;
  /** The actor may book this target (post, and pay for a settlement). */
  canBook: (target: DraftTarget) => boolean;
  canPost: boolean;
  /** Which of the row's pickers is open, so the account pick can hand over to the VAT pick. */
  openPicker: 'target' | 'vat' | null;
  onOpenPicker: (picker: 'target' | 'vat' | null) => void;
  onSelect: () => void;
  onPick: (result: PickResult) => void;
  onVat: (code: string) => void;
  onBook: () => void;
  onReview: () => void;
  onMenu: (action: RowMenuAction) => void;
  bookRef: (el: HTMLButtonElement | null) => void;
  /** Picked for a bulk action (the leading checkbox), apart from the one row the panel shows. */
  picked: boolean;
  onTogglePick: () => void;
  /** Rendered as a full-width row right under this one (the narrow layout's panel). */
  after?: ReactNode;
}

/** The certainty's glyph and its one word: status is glyph PLUS text. */
export function CertaintyMark({ certainty, withWord = false }: { certainty: RowCertainty; withWord?: boolean }) {
  const t = useT();
  const glyph =
    certainty === 'sure' ? (
      <SureGlyph size={14} />
    ) : certainty === 'learned' ? (
      <LearnedGlyph size={14} />
    ) : certainty === 'check' ? (
      <CheckGlyph size={14} />
    ) : certainty === 'edited' ? (
      <EditedGlyph size={14} />
    ) : certainty === 'agent' ? (
      <AgentGlyph size={14} />
    ) : (
      <OpenGlyph size={14} />
    );
  return (
    <span className="bank-cert" data-certainty={certainty}>
      {glyph}
      {withWord ? <span className="bank-cert__word">{t(`bankInbox.certainty.${certainty}`)}</span> : <span className="visually-hidden">{t(`bankInbox.certainty.${certainty}`)}</span>}
    </span>
  );
}

/** "−89.90": the minus in danger ink (money's semantics), the figure in the text ink, tabular. */
export function SignedAmount({ minor, currency, showCurrency }: { minor: number; currency: string; showCurrency: boolean }) {
  const figure = formatMoney(Math.abs(minor), currency).slice(currency.length + 1);
  return (
    <span className="bank-amount t-money">
      {showCurrency && <span className="bank-amount__currency">{currency}</span>}
      {minor < 0 && (
        <span className="bank-amount__sign" aria-hidden="true">
          {'−'}
        </span>
      )}
      <span className="visually-hidden">{minor < 0 ? '-' : ''}</span>
      {figure}
    </span>
  );
}

export function OpenRow({
  line,
  draft,
  lookups,
  selected,
  fresh = false,
  busy,
  showCurrency,
  vorschlag,
  canBook,
  canPost,
  openPicker,
  onOpenPicker,
  onSelect,
  onPick,
  onVat,
  onBook,
  onReview,
  onMenu,
  bookRef,
  picked,
  onTogglePick,
  after,
}: OpenRowProps) {
  const t = useT();
  const target = draft?.target ?? null;
  const proposal = proposalTarget(line);
  const certainty = rowCertainty(line, draft);
  const party = partyOf(t, line);
  const detail = detailOf(line);
  const model = targetPickerModel(t, lookups, line, target, proposal, vorschlag);
  const parts = targetParts(t, lookups, line, target);
  const bookable = isBookable(line, target);
  const allowed = target === null || canBook(target);
  const singleLeg = target?.kind === 'accounts' && target.legs.length === 1 ? target.legs[0] : undefined;
  const pendingAgent = vorschlag !== undefined;

  const buttonLabel = pendingAgent
    ? t('bankInbox.row.review')
    : target?.kind === 'existing_entry'
      ? t('bankInbox.row.match')
      : t('bankInbox.row.book');

  const menu: OverflowMenuItem[] = [
    { key: 'split', label: t('bankInbox.menu.split'), onSelect: () => onMenu('split'), disabled: !canPost },
    { key: 'link', label: t('bankInbox.menu.link'), onSelect: () => onMenu('link'), disabled: !canPost },
    { key: 'agent', label: t('bankInbox.menu.agent'), onSelect: () => onMenu('agent') },
    { key: 'ignore', label: t('bankInbox.menu.ignore'), onSelect: () => onMenu('ignore'), disabled: !canPost },
  ];

  const vatCell =
    singleLeg !== undefined ? (
      <TaxCodeCombobox
        label={t('bankInbox.row.vatLabel', { party })}
        codes={lookups.taxCodes}
        value={singleLeg.taxCode}
        direction={isCredit(line) ? 'in' : 'out'}
        open={openPicker === 'vat'}
        onOpenChange={(open) => onOpenPicker(open ? 'vat' : null)}
        onChange={onVat}
        className="bank-picker bank-picker--vat"
      />
    ) : target === null ? null : (
      <span className="bank-vat-info">
        {target.kind === 'accounts'
            ? t('bankInbox.vat.perPosition')
            : target.kind === 'existing_entry'
              ? t('bankInbox.vat.fromEntry')
              : target.kind === 'payment_batch'
                ? t('bankInbox.vat.fromBills')
                : isCredit(line)
                  ? t('bankInbox.vat.fromInvoice')
                  : t('bankInbox.vat.fromBill')}
      </span>
    );

  const bookButton = (
    <button
      type="button"
      ref={bookRef}
      className="btn btn--secondary btn--sm bank-row__book"
      disabled={busy || (!pendingAgent && !bookable)}
      aria-disabled={!pendingAgent && !allowed ? true : undefined}
      onClick={(e) => {
        e.stopPropagation();
        if (pendingAgent) {
          onReview();
          return;
        }
        if (!allowed) return;
        onBook();
      }}
    >
      {busy ? t('bankInbox.row.busy') : buttonLabel}
    </button>
  );

  return (
    <>
      <tr
        className="bank-row"
        aria-current={selected ? 'true' : undefined}
        data-selected={selected ? 'true' : undefined}
        data-fresh={fresh ? 'true' : undefined}
        data-line={line.bankTxnId}
        data-certainty={certainty}
        data-picked={picked ? 'true' : undefined}
        onClick={onSelect}
        onFocusCapture={(e) => {
          // Picking rows for a bulk action leaves the panel where it is.
          if (!selected && (e.target as HTMLElement).closest('.bank-cell--pick') === null) onSelect();
        }}
      >
        <td className="bank-cell bank-cell--pick" onClick={(e) => e.stopPropagation()}>
          <label className="check-cell">
            <input
              type="checkbox"
              checked={picked}
              onChange={onTogglePick}
              aria-label={t('bankInbox.pick.row', { party, amount: formatMoney(line.amountMinor, line.currency) })}
            />
          </label>
        </td>
        <td className="bank-cell bank-cell--date t-num">{shortDate(lineDate(line))}</td>
        <td className="bank-cell bank-cell--party">
          <span className="bank-party">{party}</span>
          {detail !== '' && <span className="bank-detail">{detail}</span>}
        </td>
        <td className="bank-cell bank-cell--target">
          <PickerButton
            label={t('bankInbox.row.targetLabel', { party })}
            options={model.options}
            groups={model.groups}
            value={model.value}
            onChange={(id) => onPick(resolvePick(lookups, line, id, proposal, vorschlag))}
            searchLabel={t('bankInbox.picker.search')}
            noMatchLabel={t('bankInbox.picker.noMatch')}
            hint={t('picker.hint')}
            open={openPicker === 'target'}
            onOpenChange={(open) => onOpenPicker(open ? 'target' : null)}
            className="bank-picker bank-picker--target"
            width={440}
          >
            <CertaintyMark certainty={certainty} />
            {target === null ? (
              <span className="picker-trigger__placeholder">{t('bankInbox.row.targetPlaceholder')}</span>
            ) : (
              <>
                {parts.code !== '' && <span className="picker-trigger__code t-num">{parts.code}</span>}
                <span className="picker-trigger__name">{parts.name}</span>
              </>
            )}
          </PickerButton>
        </td>
        <td className="bank-cell bank-cell--vat">{vatCell}</td>
        <td className="bank-cell bank-cell--amount">
          <SignedAmount minor={line.amountMinor} currency={line.currency} showCurrency={showCurrency} />
        </td>
        <td className="bank-cell bank-cell--actions">
          <span className="bank-row__actions">
            {!pendingAgent && !allowed && target !== null ? (
              <Tooltip content={t(target.kind === 'open_item' || target.kind === 'payment_batch' ? 'bankInbox.row.needsPay' : 'bankInbox.row.needsPost')}>
                {bookButton}
              </Tooltip>
            ) : (
              bookButton
            )}
            <OverflowMenu quiet label={t('bankInbox.row.more', { party, amount: formatMoney(absAmount(line), line.currency) })} items={menu} />
          </span>
        </td>
      </tr>
      {after}
    </>
  );
}

// --- decided rows ---------------------------------------------------------------------------------

export interface DecidedRowProps {
  line: BankInboxLine;
  lookups: Lookups;
  selected: boolean;
  showCurrency: boolean;
  /** What the line was booked to, in words (resolved by the surface, possibly lazily). */
  summary: string;
  /** The row's one action: Stornieren, Abgleich lösen, Wieder zu buchen. */
  actionLabel: string;
  actionDisabled: boolean;
  onAction: () => void;
  onSelect: () => void;
  after?: ReactNode;
}

export function DecidedRow({ line, selected, showCurrency, summary, actionLabel, actionDisabled, onAction, onSelect, after }: DecidedRowProps) {
  const t = useT();
  const party = partyOf(t, line);
  const detail = detailOf(line);
  return (
    <>
      <tr
        className="bank-row bank-row--decided"
        aria-current={selected ? 'true' : undefined}
        data-selected={selected ? 'true' : undefined}
        data-line={line.bankTxnId}
        data-state={line.state}
        onClick={onSelect}
        onFocusCapture={() => {
          if (!selected) onSelect();
        }}
      >
        <td className="bank-cell bank-cell--date t-num">{shortDate(lineDate(line))}</td>
        <td className="bank-cell bank-cell--party">
          <span className="bank-party">{party}</span>
          {detail !== '' && <span className="bank-detail">{detail}</span>}
        </td>
        <td className="bank-cell bank-cell--summary" colSpan={2}>
          <span className="bank-state" data-state={line.state}>
            <span className="bank-state__word">{t(`bankInbox.state.${line.state}`)}</span>
            <span className="bank-state__summary">{summary}</span>
          </span>
        </td>
        <td className="bank-cell bank-cell--amount">
          <SignedAmount minor={line.amountMinor} currency={line.currency} showCurrency={showCurrency} />
        </td>
        <td className="bank-cell bank-cell--actions">
          <span className="bank-row__actions">
            <button
              type="button"
              className="btn btn--secondary btn--sm bank-row__book"
              disabled={actionDisabled}
              onClick={(e) => {
                e.stopPropagation();
                onAction();
              }}
            >
              {actionLabel}
            </button>
          </span>
        </td>
      </tr>
      {after}
    </>
  );
}
